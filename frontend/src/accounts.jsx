import { createContext, useContext, useEffect, useRef, useState } from "react";
import nvidiaLogo from "./assets/nvidia-logo.svg";

const defaultPreferences = { start_page: "dashboard", refresh_seconds: 15, confirm_power: true, compact_racks: false };
const legacy = { mode: "legacy", user: null, canOperate: true, canAdmin: true, preferences: defaultPreferences };
const AccountContext = createContext(legacy);
export const useAccounts = () => useContext(AccountContext);
const transport = window.__dcimAccountTransport ||= { fetch: window.fetch.bind(window), csrf: null, mode: "legacy" };
window.fetch = async function(input, init) {
  const url = new URL(input instanceof Request ? input.url : input, location.href);
  const localApi = url.origin === location.origin && url.pathname.startsWith("/api/");
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (localApi && transport.csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}));
    headers.set("X-DCIM-CSRF", transport.csrf);
    init = { ...init, headers };
  }
  const sentWith = transport.csrf;
  const response = await transport.fetch(input, init);
  if (localApi && transport.mode === "accounts" && !url.pathname.startsWith("/api/auth/")) {
    // Only a 401 for the session still in use ends it: a request sent before this tab signed in again says nothing.
    if (response.status === 401 && sentWith === transport.csrf) window.dispatchEvent(new Event("dcim-session-expired"));
    // Another tab may have signed in as someone else (the cookie is shared) or rotated the CSRF token: re-read who is signed in.
    else if (response.status === 403) window.dispatchEvent(new Event("dcim-session-check"));
  }
  return response;
};

// Tabs of this browser share one session cookie. A sign-in, sign-out or password change here tells the others to re-read it.
const sessionChannel = (() => { try { return typeof BroadcastChannel === "function" ? new BroadcastChannel("dcim-session") : null; } catch { return null; } })();
export function announceSessionChange(type = "change") {
  try { sessionChannel?.postMessage({ type }); } catch { /* channel unavailable: focus and 403 rechecks still apply */ }
}

export async function accountRequest(path, method = "GET", body) {
  const response = await fetch(`/api${path}`, { method, cache: "no-store", headers: body ? {"Content-Type":"application/json"} : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map(e => e?.msg).filter(Boolean).join("; ") : "";
    const error = new Error(detail || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const AUTH_FIELDS = ["mode", "registration_enabled", "setup_required", "csrf_token"];
const sameAuth = (a, b) => !!a && !!b && AUTH_FIELDS.every(key => a[key] === b[key]) && JSON.stringify(a.user ?? null) === JSON.stringify(b.user ?? null);

// One session event -> the next {auth, ended, notice}. `ended` keeps the user whose page stays mounted (inert, under the
// sign-in overlay) after the session ended without a sign-out in this tab. The same state object comes back when
// nothing visible changed, so a recheck that finds the same session re-renders nothing.
function nextSession(state, event) {
  const shown = state.auth?.user || state.ended?.user || null;
  switch (event.type) {
    case "status": {
      const mode = event.data.mode || "accounts";
      const user = mode === "accounts" ? event.data.user || null : null;
      const auth = { ...state.auth, ...event.data, mode, user };
      let { ended, notice } = state;
      if (!user) {
        // A sign-out in another tab is often noticed first through a 401 on this page; its message then names the reason.
        const why = event.reason === "signed-out-elsewhere" ? event.reason : state.ended?.reason || "ended";
        if (shown && mode === "accounts") ended = state.ended?.reason === why ? state.ended : { user: shown, reason: why };
      } else {
        ended = null;
        if (shown && shown.id !== user.id) notice = `Signed in as ${user.name} (${user.role}) from another tab or window. This page now uses that account.`;
        else if (shown && shown.role !== user.role) notice = `Your role is now ${user.role}.`;
      }
      return sameAuth(auth, state.auth) && ended === state.ended && notice === state.notice ? state : { auth, ended, notice };
    }
    case "signed-in":   // this tab signed in, registered or changed its password
      return { auth: { ...state.auth, mode: "accounts", user: event.data.user, csrf_token: event.data.csrf_token }, ended: null, notice: "" };
    case "signed-out":  // a deliberate sign-out here: no message, and the page is not kept
      return { auth: { ...state.auth, user: null, csrf_token: null }, ended: null, notice: "" };
    case "expired": {   // a 401 here, or a sign-out in another tab (same cookie, so the same session)
      const why = event.reason || "ended";
      if (state.auth?.user) return { auth: { ...state.auth, user: null, csrf_token: null }, ended: { user: state.auth.user, reason: why }, notice: "" };
      return state.ended && event.reason && state.ended.reason !== why ? { ...state, ended: { ...state.ended, reason: why } } : state;
    }
    case "user":
      return state.auth?.user ? { ...state, auth: { ...state.auth, user: event.user } } : state;
    case "dismiss":
      return state.notice ? { ...state, notice: "" } : state;
    default:
      return state;
  }
}

export function AccountsProvider({ children }) {
  const [session, setSession] = useState({ auth: null, ended: null, notice: "" });
  const [error, setError] = useState("");
  const pending = useRef(null);
  const epoch = useRef(0);   // bumped when this tab signs in or out or its session ends; status answers requested before are stale
  const { auth, ended, notice } = session;
  const update = event => setSession(state => nextSession(state, event));
  function local(event, announce) {
    epoch.current += 1;
    transport.mode = "accounts";
    transport.csrf = event.data?.csrf_token || null;
    update(event);
    announceSessionChange(announce);
  }
  const accept = (data, announce = "login") => local({ type: "signed-in", data }, announce);
  function refresh(reason = "check") {
    // One status request at a time. A check asked for while one is in flight may follow a change that request
    // predates (another tab just signed in), so it runs once more afterwards: a burst of 403s, focus events and
    // messages costs at most two requests, and the last answer is never older than the last reason to ask.
    const current = pending.current;
    if (current?.epoch === epoch.current) {
      if (reason !== "check" || !current.queued) current.queued = reason;   // "signed out in another tab" wins over a plain check
      current.again ||= current.promise.then(() => refresh(current.queued));
      return current.again;
    }
    const started = epoch.current;
    const promise = (async () => {
      try {
        const response = await fetch("/api/auth/status", {cache:"no-store"});
        let data;
        // An older VM can serve the new design before account support is installed.
        if (response.status === 404 || (response.ok && !response.headers.get("content-type")?.includes("application/json"))) data = {mode:"legacy", user:null};
        else {
          if (!response.ok) throw new Error("Could not check sign-in status. Retry when the backend is available.");
          data = await response.json();
          if (!["legacy", "accounts"].includes(data.mode)) throw new Error("Unexpected sign-in response from the backend.");
        }
        if (started !== epoch.current) return;
        transport.mode = data.mode;
        transport.csrf = data.csrf_token || null;
        update({ type: "status", data, reason });
        setError("");
      } catch (e) { if (started === epoch.current) setError(e.message); }
    })().finally(() => { if (pending.current?.promise === promise) pending.current = null; });
    pending.current = { epoch: started, promise };
    return promise;
  }
  async function logout() {
    try { await accountRequest("/auth/logout", "POST"); }
    catch (e) { if (e.status !== 401) throw e; }   // the session had already ended on the server: signed out all the same
    local({ type: "signed-out" }, "logout");
  }
  useEffect(() => {
    refresh("load");
    // A status answer requested before the session ended would bring the page back for a moment: ignore it.
    const end = reason => { epoch.current += 1; transport.csrf = null; update({ type: "expired", reason }); };
    const expired = event => { if (!event.detail?.fromAccounts) end(); };
    const check = () => { if (transport.mode === "accounts") refresh(); };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    const message = event => {
      if (transport.mode !== "accounts") return;
      // Tabs share the session cookie, so a sign-out in another tab has already ended this tab's session: say so at
      // once, then re-read the status in case that tab signed in again meanwhile.
      if (event.data?.type === "logout") { end("signed-out-elsewhere"); refresh("signed-out-elsewhere"); }
      else refresh();
    };
    window.addEventListener("dcim-session-expired", expired);
    window.addEventListener("dcim-session-check", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", visible);
    sessionChannel?.addEventListener("message", message);
    return () => {
      window.removeEventListener("dcim-session-expired", expired);
      window.removeEventListener("dcim-session-check", check);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", visible);
      sessionChannel?.removeEventListener("message", message);
    };
  }, []);
  // However the end was noticed, the page's own listeners (assistant, voice) stop as they do on a 401.
  useEffect(() => { if (ended) window.dispatchEvent(new CustomEvent("dcim-session-expired", { detail: { fromAccounts: true } })); }, [ended]);
  if (!auth) return <div className="auth-screen"><div className="auth-panel"><strong className="text-xl">DCIM</strong><p>{error || "Connecting to Lab Manager…"}</p>{error && <button className="account-primary" onClick={() => refresh("load")}>Retry</button>}</div></div>;
  const accounts = auth.mode === "accounts";
  const user = accounts ? auth.user || null : null;
  // While the session-ended overlay is up, the page underneath keeps the account it was built for.
  const shown = user || ended?.user || null;
  const value = {
    ...auth, user: shown, accept, refresh,
    preferences: {...defaultPreferences, ...shown?.preferences},
    canOperate: !accounts || ["Operator","Admin"].includes(shown?.role),
    canAdmin: !accounts || shown?.role === "Admin",
    updateUser: user => update({ type: "user", user }),
    logout,
  };
  if (user?.must_change_password) return <AccountContext.Provider value={value}><AccountSettings forcePassword /></AccountContext.Provider>;
  // A fixed slot: the same user signing in again keeps the page and its unsaved input; another user gets a fresh page.
  const slot = accounts ? shown?.id : "legacy";
  const covered = accounts && !user;
  // The account notice sits in the page flow above the app, so it never covers the header. It stays until dismissed:
  // a banner that vanished on a timer would shift the page under the pointer. The live region is always present so
  // screen readers announce the text when it appears.
  const showNotice = !!notice && !covered;
  return <AccountContext.Provider value={value}>
    <div role="status" className={showNotice ? "mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-nv-500/60 bg-nv-500/10 p-3 text-sm text-zinc-100" : "sr-only"}>
      {showNotice && <><span className="flex-1 min-w-0">{notice}</span><button type="button" className="account-secondary" aria-label="Dismiss account notice" onClick={() => update({ type: "dismiss" })}>Dismiss</button></>}
    </div>
    {slot && <div key={slot} style={{display:"contents"}} inert={covered ? "" : undefined} aria-hidden={covered ? "true" : undefined}>{children}</div>}
    {covered && <SignIn key={ended ? "ended" : "sign-in"} ended={ended} />}
  </AccountContext.Provider>;
}

const ENDED_TEXT = {
  ended: "Your session ended: it expired or an administrator changed your account. Sign in again to continue.",
  "signed-out-elsewhere": "You signed out in another tab. Sign in again to continue.",
};

function SignIn({ ended = null }) {
  const {accept,registration_enabled,setup_required} = useAccounts();
  const [signup,setSignup] = useState(false);
  const [form,setForm] = useState(() => ({name:"",username:ended?.user?.username || "",password:"",confirm:""}));
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const overlay = useRef(null);
  // The page's portals (assistant launcher, dialogs) live directly in <body>, outside the inert slot: cover them too.
  useEffect(() => {
    const own = overlay.current;
    if (!own) return;
    const marked = new Set();
    const cover = node => {
      if (node.nodeType !== 1 || node.contains(own) || node.hasAttribute("inert") || ["SCRIPT","STYLE","LINK"].includes(node.tagName)) return;
      node.setAttribute("inert", ""); marked.add(node);
    };
    [...document.body.children].forEach(cover);
    const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(cover)));
    observer.observe(document.body, {childList:true});
    return () => { observer.disconnect(); marked.forEach(node => node.removeAttribute("inert")); };
  }, []);
  const change = e => setForm({...form,[e.target.name]:e.target.value});
  async function submit(e) {
    e.preventDefault();setError("");
    if (signup && form.password !== form.confirm) return setError("Passwords do not match.");
    setBusy(true);
    try { const {confirm,name,...login} = form; accept(await accountRequest(signup ? "/auth/register" : "/auth/login","POST",signup ? {...login,name} : login)); }
    catch(e){setError(e.message);setForm(f=>({...f,password:"",confirm:""}));}
    finally{setBusy(false);}
  }
  const panel = <div className="auth-panel">
    <div><img src={nvidiaLogo} alt="NVIDIA" width="120" height="24" className="mb-3"/><h1 id="sign-in-title" className="text-xl font-bold text-white">Lab Manager</h1><p className="text-xs text-zinc-500 mt-1">Lab 204 · Yokneam · internal use only</p></div>
    {ended && <p role="alert" className="text-sm text-amber-300">{ENDED_TEXT[ended.reason] || ENDED_TEXT.ended} Unsaved input on this page is kept if you sign in as the same user.</p>}
    {setup_required ? <p role="alert">User accounts need initialization. A lab administrator must configure the initial admin on the VM.</p> : <>
    {registration_enabled && <div className="auth-tabs" role="tablist"><button role="tab" aria-selected={!signup} onClick={()=>{setSignup(false);setError("");}}>Sign in</button><button role="tab" aria-selected={signup} onClick={()=>{setSignup(true);setError("");}}>Create account</button></div>}
    <form onSubmit={submit} className="account-fields">
      {signup && <label>Full name<input name="name" value={form.name} onChange={change} autoComplete="name" required maxLength={120}/></label>}
      <label>Username<input name="username" value={form.username} onChange={change} autoComplete="username" required maxLength={32} autoFocus={!ended?.user}/></label>
      <label>Password<input name="password" type="password" value={form.password} onChange={change} autoComplete={signup?"new-password":"current-password"} required minLength={signup?8:1} maxLength={256} autoFocus={!!ended?.user}/></label>
      {signup && <label>Confirm password<input name="confirm" type="password" value={form.confirm} onChange={change} autoComplete="new-password" required minLength={8} maxLength={256}/></label>}
      {error && <p role="alert" className="account-error">{error}</p>}
      <button className="account-primary" disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
      <p className="text-xs text-zinc-600">{signup ? "New accounts start as Viewer. An admin can change your role." : "Forgot your password? Ask a lab admin to reset it in Admin → Users."}</p>
    </form></>}
  </div>;
  if (!ended) return <div className="auth-screen">{panel}</div>;
  // Opaque and above everything: the page underneath is inert until someone signs in.
  return <div ref={overlay} className="auth-screen fixed inset-0 z-[1000] overflow-y-auto bg-zinc-950" role="dialog" aria-modal="true" aria-labelledby="sign-in-title">{panel}</div>;
}

export function UserMenu({onAccount,onUsers}) {
  const {mode,user,canAdmin,logout} = useAccounts();
  const [open,setOpen] = useState(false);
  const [error,setError] = useState("");
  useEffect(()=>{const close=e=>{if(e.key==="Escape")setOpen(false);};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[]);
  if(mode!=="accounts" || !user) return null;
  const go = fn => {setOpen(false);fn();};
  return <div className="account-menu-anchor">
    <button className="account-menu-toggle" onClick={()=>setOpen(!open)} aria-haspopup="menu" aria-expanded={open}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/></svg>{user.name} <span>{user.role}</span></button>
    {open && <><div className="fixed inset-0 z-30" onClick={()=>setOpen(false)}/><div role="menu" className="account-menu">
      <div className="px-3 py-2 border-b border-zinc-800"><strong className="block text-white">{user.name}</strong><span className="text-xs text-zinc-500">{user.username} · {user.role}</span></div>
      <button role="menuitem" onClick={()=>go(onAccount)}>Account settings</button>
      {canAdmin && <button role="menuitem" onClick={()=>go(onUsers)}>Manage users</button>}
      <button role="menuitem" className="text-rose-300" onClick={()=>logout().catch(e=>setError(e.message))}>Sign out</button>
      {error && <p role="alert" className="account-error p-2">{error}</p>}
    </div></>}
  </div>;
}

function Card({title,hint,children}) { return <section className="account-card"><header><h2>{title}</h2><p>{hint}</p></header><div className="account-fields">{children}</div></section>; }
function Result({error,message}) { return error ? <p className="account-error" role="alert">{error}</p> : message ? <p className="text-sm text-nv-300" role="status">{message}</p> : null; }

export function AccountSettings({forcePassword=false}) {
  const {user,preferences,updateUser,accept,logout} = useAccounts();
  const [profile,setProfile] = useState({name:user?.name || "",email:user?.email || ""});
  const [prefs,setPrefs] = useState({...preferences});
  const [password,setPassword] = useState({current_password:"",new_password:"",confirm:""});
  const [result,setResult] = useState({});
  const [busy,setBusy] = useState("");
  if(!user) return <p className="p-6 text-zinc-400">User accounts are not enabled on this VM yet.</p>;
  async function save(section,fn) {
    setBusy(section);setResult({});
    try {await fn();setResult({[section]:{message:"Saved."}});}
    catch(e){setResult({[section]:{error:e.message}});}
    finally{setBusy("");}
  }
  return <main className="account-page">
    <div className="mb-5"><h1 className="text-2xl font-bold text-white">{forcePassword?"Change your temporary password":"Account settings"}</h1><p className="text-sm text-zinc-400 mt-2">{forcePassword?"Choose a new password before using Lab Manager.":"Your profile, password and preferences."}</p></div>
    <div className="account-grid">
      {!forcePassword && <Card title="Profile" hint="Your name and contact details."><form className="account-fields" onSubmit={e=>{e.preventDefault();save("profile",async()=>updateUser(await accountRequest("/me","PUT",profile)));}}>
        <label>Full name<input value={profile.name} onChange={e=>setProfile({...profile,name:e.target.value})} required maxLength={120}/></label>
        <label>Email<input type="email" value={profile.email} onChange={e=>setProfile({...profile,email:e.target.value})} maxLength={254} placeholder="name@nvidia.com"/></label>
        <div className="grid grid-cols-2 gap-3"><label>Username<input value={user.username} readOnly/></label><label>Role<input value={user.role} readOnly/></label></div>
        <Result {...result.profile}/><button className="account-primary" disabled={!!busy}>Save profile</button>
      </form></Card>}
      <Card title="Password" hint="At least 8 characters. Other sessions will be signed out."><form className="account-fields" onSubmit={e=>{e.preventDefault();save("password",async()=>{
        if(password.new_password!==password.confirm) throw new Error("New passwords do not match.");
        const {confirm,...body}=password;accept(await accountRequest("/me/password","PUT",body),"password");setPassword({current_password:"",new_password:"",confirm:""});
      });}}>
        <label>Current password<input type="password" autoComplete="current-password" value={password.current_password} onChange={e=>setPassword({...password,current_password:e.target.value})} required maxLength={256}/></label>
        <label>New password<input type="password" autoComplete="new-password" value={password.new_password} onChange={e=>setPassword({...password,new_password:e.target.value})} required minLength={8} maxLength={256}/></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" value={password.confirm} onChange={e=>setPassword({...password,confirm:e.target.value})} required minLength={8} maxLength={256}/></label>
        <Result {...result.password}/><button className="account-primary" disabled={!!busy}>Change password</button>
      </form></Card>
      {!forcePassword && <Card title="Preferences" hint="Saved to your account across browsers."><form className="account-fields" onSubmit={e=>{e.preventDefault();save("prefs",async()=>updateUser(await accountRequest("/me/preferences","PUT",prefs)));}}>
        <label>Start page<select aria-label="Start page" value={prefs.start_page} onChange={e=>setPrefs({...prefs,start_page:e.target.value})}>{[["dashboard","Dashboard"],["racks","Racks"],["inventory","Inventory"],["power","Power"],["consoles","Consoles"],["monitoring","Ping Monitor"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <label>Auto-refresh<select aria-label="Auto-refresh" value={prefs.refresh_seconds} onChange={e=>setPrefs({...prefs,refresh_seconds:Number(e.target.value)})}>{[5,15,30,60].map(n=><option key={n} value={n}>{n} seconds</option>)}</select></label>
        <label className="account-check"><input type="checkbox" checked={prefs.confirm_power} onChange={e=>setPrefs({...prefs,confirm_power:e.target.checked})}/>Ask before Power off and Power cycle</label>
        <label className="account-check"><input type="checkbox" checked={prefs.compact_racks} onChange={e=>setPrefs({...prefs,compact_racks:e.target.checked})}/>Compact rack cards (hide empty shelves 05–08)</label>
        <Result {...result.prefs}/><button className="account-primary" disabled={!!busy}>Save preferences</button>
      </form></Card>}
      <Card title="Session" hint={`${user.username} · ${user.role}`}><p className="text-sm text-zinc-500">Member since {new Date(user.created_at*1000).toLocaleDateString()}</p><button className="account-secondary" onClick={()=>save("session",logout)} disabled={!!busy}>Sign out</button><Result {...result.session}/></Card>
    </div>
  </main>;
}

export function UsersView() {
  const {user,canAdmin} = useAccounts();
  const [users,setUsers] = useState(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [adding,setAdding] = useState(false);
  const [temporary,setTemporary] = useState(null);
  const [form,setForm] = useState({name:"",username:"",role:"Viewer",password:""});
  async function refresh(){setUsers(await accountRequest("/users"));}
  useEffect(()=>{if(canAdmin)refresh().catch(e=>setError(e.message));},[canAdmin]);
  if(!canAdmin) return <p role="alert" className="p-6">Only administrators can manage users.</p>;
  async function action(fn){setBusy(true);setError("");try{await fn();await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
  // Each change ends the user's sessions, so a stray arrow key or click never applies it. On Cancel the controlled
  // select stays on the saved role.
  function changeRole(u,role){
    if(role===u.role || !confirm(`Change ${u.username} from ${u.role} to ${role}? Their sessions will end.`)) return;
    action(()=>accountRequest(`/users/${u.id}`,"PATCH",{role}));
  }
  function toggleEnabled(u){
    const question = u.enabled ? `Disable ${u.username}? Their sessions will end and they cannot sign in until an administrator enables the account again.`
      : `Enable ${u.username}? They can sign in again with their current password.`;
    if(confirm(question)) action(()=>accountRequest(`/users/${u.id}`,"PATCH",{enabled:!u.enabled}));
  }
  const formatTime = ts => ts ? new Date(ts*1000).toLocaleString() : "Never";
  return <main className="account-page max-w-none">
    <div className="flex flex-wrap justify-between items-end gap-4 mb-5"><div><h1 className="text-2xl font-bold text-white">Users</h1><p className="text-sm text-zinc-400 mt-2">Admin manages users and devices · Operator controls power and edits racks · Viewer can view.</p></div><button className="account-primary" onClick={()=>setAdding(true)}>Add user</button></div>
    <div className="user-kpis">{[["Users",users?.length],["Admins",users?.filter(u=>u.role==="Admin").length],["Operators",users?.filter(u=>u.role==="Operator").length],["Disabled",users?.filter(u=>!u.enabled).length]].map(([label,count])=><div key={label}><span>{label}</span><strong>{count??"—"}</strong></div>)}</div>
    {error && !adding && <p className="account-error my-3" role="alert">{error}</p>}
    <div className="user-table-wrap"><table className="user-table"><thead><tr>{["Name","Username","Role","Status","Created","Last sign-in","Actions"].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>
      {users?.map(u=><tr key={u.id} className={!u.enabled?"opacity-60":""}><td className="font-semibold text-white">{u.name} {u.id===user.id&&<span className="text-zinc-500 font-normal">(you)</span>}</td><td className="font-mono">{u.username}</td>
        <td><select aria-label={`Role for ${u.username}`} value={u.role} disabled={busy||u.id===user.id} onChange={e=>changeRole(u,e.target.value)}>{["Admin","Operator","Viewer"].map(r=><option key={r}>{r}</option>)}</select></td>
        <td className={u.enabled?"text-nv-300":"text-zinc-500"}>{u.enabled?"Active":"Disabled"}</td><td>{formatTime(u.created_at)}</td><td>{formatTime(u.last_login_at)}</td>
        <td><div className="flex gap-2"><button className="account-secondary" disabled={busy||u.id===user.id} onClick={()=>{if(confirm(`Reset the password for ${u.username}? Their sessions will end.`))action(async()=>setTemporary({username:u.username,...await accountRequest(`/users/${u.id}/reset-password`,"POST")}));}}>Reset password</button>
          <button className="account-secondary" disabled={busy||u.id===user.id} onClick={()=>toggleEnabled(u)}>{u.enabled?"Disable":"Enable"}</button>
          <button className="account-secondary text-rose-300" disabled={busy||u.id===user.id} onClick={()=>{if(confirm(`Remove ${u.username}?`))action(()=>accountRequest(`/users/${u.id}`,"DELETE"));}}>Remove</button></div></td>
      </tr>)}
    </tbody></table>{users===null && !error && <p className="p-4 text-zinc-500">Loading users…</p>}</div>
    {adding && <div className="account-modal"><form role="dialog" aria-modal="true" aria-label="Add user" className="auth-panel account-fields" onSubmit={e=>{e.preventDefault();action(async()=>{await accountRequest("/users","POST",form);setForm({name:"",username:"",role:"Viewer",password:""});setAdding(false);});}}>
      <h2 className="text-xl font-bold text-white">Add user</h2>
      <label>Full name<input required maxLength={120} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} autoFocus/></label>
      <label>Username<input required minLength={3} maxLength={32} value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label>
      <label>Role<select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>{["Viewer","Operator","Admin"].map(r=><option key={r}>{r}</option>)}</select></label>
      <label>Temporary password<input required type="password" autoComplete="new-password" minLength={8} maxLength={256} value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label>
      <p className="text-xs text-zinc-500">The user must change this password at first sign-in.</p><Result error={error}/><button className="account-primary" disabled={busy}>Create user</button><button type="button" className="account-secondary" disabled={busy} onClick={()=>{setAdding(false);setError("");setForm({name:"",username:"",role:"Viewer",password:""});}}>Cancel</button>
    </form></div>}
    {temporary && <div className="account-modal"><div role="dialog" aria-modal="true" aria-label="Temporary password" className="auth-panel"><h2 className="text-lg font-bold">Temporary password for {temporary.username}</h2><p className="text-sm text-zinc-400">Shown only here. Share it privately; the user must change it at sign-in.</p><code className="break-all p-3 bg-zinc-950 border border-zinc-800 rounded">{temporary.temporary_password}</code><button className="account-primary" onClick={()=>setTemporary(null)}>Done</button></div></div>}
  </main>;
}
