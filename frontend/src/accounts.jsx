import { createContext, useContext, useEffect, useState } from "react";

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
  const response = await transport.fetch(input, init);
  if (localApi && response.status === 401 && transport.mode === "accounts" && !url.pathname.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event("dcim-session-expired"));
  }
  return response;
};

export async function accountRequest(path, method = "GET", body) {
  const response = await fetch(`/api${path}`, { method, cache: "no-store", headers: body ? {"Content-Type":"application/json"} : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.detail?.map(e => e.msg).join("; ") || `Request failed (${response.status})`);
  return data;
}

export function AccountsProvider({ children }) {
  const [auth, setAuth] = useState(null);
  const [error, setError] = useState("");
  function accept(data) {
    transport.mode = data.mode || "accounts";
    transport.csrf = data.csrf_token || null;
    setAuth(old => ({...old, ...data, mode: data.mode || "accounts"}));
    setError("");
  }
  async function refresh() {
    try {
      const response = await fetch("/api/auth/status", {cache:"no-store"});
      // An older VM can serve the new design before account support is installed.
      if (response.status === 404 || (response.ok && !response.headers.get("content-type")?.includes("application/json"))) return accept({mode:"legacy",user:null});
      if (!response.ok) throw new Error("Could not check sign-in status. Retry when the backend is available.");
      const data = await response.json();
      if (!["legacy", "accounts"].includes(data.mode)) throw new Error("Unexpected sign-in response from the backend.");
      accept(data);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => {
    refresh();
    const expired = () => { transport.csrf = null; setAuth(old => ({...old, user:null})); };
    window.addEventListener("dcim-session-expired", expired);
    return () => window.removeEventListener("dcim-session-expired", expired);
  }, []);
  const user = auth?.user;
  const value = {
    ...auth, user, accept, refresh,
    preferences: {...defaultPreferences, ...user?.preferences},
    canOperate: auth?.mode === "legacy" || ["Operator","Admin"].includes(user?.role),
    canAdmin: auth?.mode === "legacy" || user?.role === "Admin",
    updateUser: user => setAuth(old => ({...old,user})),
    logout: async () => { await accountRequest("/auth/logout", "POST"); accept({...auth,user:null,csrf_token:null}); },
  };
  if (!auth) return <div className="auth-screen"><div className="auth-panel"><strong className="text-xl">DCIM</strong><p>{error || "Connecting to Lab Manager…"}</p>{error && <button className="account-primary" onClick={refresh}>Retry</button>}</div></div>;
  return <AccountContext.Provider value={value}>{auth.mode === "accounts" && !user ? <SignIn /> : user?.must_change_password ? <AccountSettings forcePassword /> : children}</AccountContext.Provider>;
}

function SignIn() {
  const {accept,registration_enabled,setup_required} = useAccounts();
  const [signup,setSignup] = useState(false);
  const [form,setForm] = useState({name:"",username:"",password:"",confirm:""});
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const change = e => setForm({...form,[e.target.name]:e.target.value});
  async function submit(e) {
    e.preventDefault();setError("");
    if (signup && form.password !== form.confirm) return setError("Passwords do not match.");
    setBusy(true);
    try { const {confirm,name,...login} = form; accept(await accountRequest(signup ? "/auth/register" : "/auth/login","POST",signup ? {...login,name} : login)); }
    catch(e){setError(e.message);setForm(f=>({...f,password:"",confirm:""}));}
    finally{setBusy(false);}
  }
  return <div className="auth-screen"><div className="auth-panel">
    <div><img src="/nvidia-logo.svg" alt="NVIDIA" width="120" height="24" className="mb-3"/><h1 className="text-xl font-bold text-white">Lab Manager</h1><p className="text-xs text-zinc-500 mt-1">Lab 204 · Yokneam · internal use only</p></div>
    {setup_required ? <p role="alert">User accounts need initialization. A lab administrator must configure the initial admin on the VM.</p> : <>
    {registration_enabled && <div className="auth-tabs" role="tablist"><button role="tab" aria-selected={!signup} onClick={()=>{setSignup(false);setError("");}}>Sign in</button><button role="tab" aria-selected={signup} onClick={()=>{setSignup(true);setError("");}}>Create account</button></div>}
    <form onSubmit={submit} className="account-fields">
      {signup && <label>Full name<input name="name" value={form.name} onChange={change} autoComplete="name" required maxLength={120}/></label>}
      <label>Username<input name="username" value={form.username} onChange={change} autoComplete="username" required maxLength={32} autoFocus/></label>
      <label>Password<input name="password" type="password" value={form.password} onChange={change} autoComplete={signup?"new-password":"current-password"} required minLength={signup?8:1} maxLength={256}/></label>
      {signup && <label>Confirm password<input name="confirm" type="password" value={form.confirm} onChange={change} autoComplete="new-password" required minLength={8} maxLength={256}/></label>}
      {error && <p role="alert" className="account-error">{error}</p>}
      <button className="account-primary" disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
      <p className="text-xs text-zinc-600">{signup ? "New accounts start as Viewer. An admin can change your role." : "Forgot your password? Ask a lab admin to reset it in Admin → Users."}</p>
    </form></>}
  </div></div>;
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
        const {confirm,...body}=password;accept(await accountRequest("/me/password","PUT",body));setPassword({current_password:"",new_password:"",confirm:""});
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
  const formatTime = ts => ts ? new Date(ts*1000).toLocaleString() : "Never";
  return <main className="account-page max-w-none">
    <div className="flex flex-wrap justify-between items-end gap-4 mb-5"><div><h1 className="text-2xl font-bold text-white">Users</h1><p className="text-sm text-zinc-400 mt-2">Admin manages users and devices · Operator controls power and edits racks · Viewer can view.</p></div><button className="account-primary" onClick={()=>setAdding(true)}>Add user</button></div>
    <div className="user-kpis">{[["Users",users?.length],["Admins",users?.filter(u=>u.role==="Admin").length],["Operators",users?.filter(u=>u.role==="Operator").length],["Disabled",users?.filter(u=>!u.enabled).length]].map(([label,count])=><div key={label}><span>{label}</span><strong>{count??"—"}</strong></div>)}</div>
    {error && <p className="account-error my-3" role="alert">{error}</p>}
    <div className="user-table-wrap"><table className="user-table"><thead><tr>{["Name","Username","Role","Status","Created","Last sign-in","Actions"].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>
      {users?.map(u=><tr key={u.id} className={!u.enabled?"opacity-60":""}><td className="font-semibold text-white">{u.name} {u.id===user.id&&<span className="text-zinc-500 font-normal">(you)</span>}</td><td className="font-mono">{u.username}</td>
        <td><select aria-label={`Role for ${u.username}`} value={u.role} disabled={busy||u.id===user.id} onChange={e=>action(()=>accountRequest(`/users/${u.id}`,"PATCH",{role:e.target.value}))}>{["Admin","Operator","Viewer"].map(r=><option key={r}>{r}</option>)}</select></td>
        <td className={u.enabled?"text-nv-300":"text-zinc-500"}>{u.enabled?"Active":"Disabled"}</td><td>{formatTime(u.created_at)}</td><td>{formatTime(u.last_login_at)}</td>
        <td><div className="flex gap-2"><button className="account-secondary" disabled={busy||u.id===user.id} onClick={()=>{if(confirm(`Reset the password for ${u.username}? Their sessions will end.`))action(async()=>setTemporary({username:u.username,...await accountRequest(`/users/${u.id}/reset-password`,"POST")}));}}>Reset password</button>
          <button className="account-secondary" disabled={busy||u.id===user.id} onClick={()=>action(()=>accountRequest(`/users/${u.id}`,"PATCH",{enabled:!u.enabled}))}>{u.enabled?"Disable":"Enable"}</button>
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
