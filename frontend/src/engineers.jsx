import {createContext, useContext, useEffect, useState} from "react";
import {accountRequest, useAccounts} from "./accounts";

const Directory = createContext(null);
export const useEngineers = () => useContext(Directory);

export function EngineersProvider({children}) {
  const [engineers,setEngineers] = useState(null);
  const [error,setError] = useState("");
  const [revision,setRevision] = useState(0);
  async function refresh() {
    try {setEngineers(await accountRequest("/engineers"));setError("");setRevision(v=>v+1);}
    catch(e){setError(e.message);throw e;}
  }
  useEffect(()=>{refresh().catch(()=>{});},[]);
  return <Directory.Provider value={{engineers,error,refresh,revision}}>{children}</Directory.Provider>;
}

export function OwnerSelect({owner="",onChange,label="Owner",disabled=false}) {
  const {engineers,error,refresh} = useEngineers();
  const [busy,setBusy] = useState(false);
  const [saveError,setSaveError] = useState("");
  const [saved,setSaved] = useState(false);
  const current = engineers?.find(e=>e.name===owner);
  async function choose(e) {
    const id=e.target.value || null;
    setBusy(true);setSaveError("");setSaved(false);
    try {await onChange(id);setSaved(true);}
    catch(e){setSaveError(e.message);}
    finally{setBusy(false);}
  }
  return <div className="min-w-0">
    <select aria-label={label} value={current?.id || (owner?"__current__":"")} onChange={choose} disabled={disabled||busy||!engineers||!!error}
      className="w-full min-w-0 bg-zinc-900 border border-zinc-700 px-2 py-2 text-sm focus:outline-none focus:border-nv-400 disabled:opacity-50">
      <option value="">ללא Owner</option>
      {owner&&!current&&<option value="__current__" disabled>{owner} · בעלים קיים</option>}
      {engineers?.filter(e=>e.active||e.id===current?.id).map(e=><option key={e.id} value={e.id} disabled={!e.active}>{e.name}{e.active?"":" · לא פעיל"}</option>)}
    </select>
    {error&&<p role="alert" className="text-xs text-rose-300 mt-1">הרשימה לא נטענה. <button type="button" className="underline" onClick={()=>refresh().catch(()=>{})}>נסה שוב</button></p>}
    {saveError&&<p role="alert" className="text-xs text-rose-300 mt-1">{saveError}</p>}
    {busy&&<span className="text-xs text-zinc-400">שומר…</span>}
    {saved&&!busy&&<span role="status" className="text-xs text-nv-300">נשמר</span>}
  </div>;
}

export function EngineersView() {
  const {canAdmin} = useAccounts();
  const {engineers,error:loadError,refresh} = useEngineers();
  const [name,setName] = useState("");
  const [editing,setEditing] = useState(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [query,setQuery] = useState("");
  async function action(fn) {
    setBusy(true);setError("");
    try {await fn();await refresh();}
    catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  if(!canAdmin) return <p role="alert">ניהול מהנדסים זמין למנהל בלבד.</p>;
  return <main className="account-page max-w-none" dir="rtl" lang="he">
    <div className="mb-5"><h1 className="text-2xl font-bold text-white">מהנדסים</h1><p className="text-sm text-zinc-400 mt-2">בחר מהרשימה בשדה Owner בציוד. מהנדס לא חייב להיות משתמש באתר.</p></div>
    <form className="flex flex-wrap gap-3 items-end mb-5" onSubmit={e=>{e.preventDefault();action(async()=>{await accountRequest(editing?`/engineers/${editing.id}`:"/engineers",editing?"PUT":"POST",{name,active:editing?.active??true});setName("");setEditing(null);});}}>
      <label className="account-fields flex-1 min-w-48">שם המהנדס<input required maxLength={120} value={name} onChange={e=>setName(e.target.value)} disabled={busy} autoComplete="off"/></label>
      <button className="account-primary" disabled={busy}>{editing?"שמור שם":"הוסף מהנדס"}</button>
      {editing&&<button type="button" className="account-secondary" disabled={busy} onClick={()=>{setEditing(null);setName("");}}>ביטול</button>}
    </form>
    {(error||loadError)&&<p role="alert" className="account-error mb-3">{error||loadError} <button onClick={()=>refresh().catch(()=>{})}>נסה שוב</button></p>}
    <input aria-label="חיפוש מהנדס" placeholder="חיפוש מהנדס…" value={query} onChange={e=>setQuery(e.target.value)} className="w-full sm:w-72 bg-zinc-900 border border-zinc-700 px-3 py-2 mb-4"/>
    <div className="user-table-wrap"><table className="user-table"><thead><tr><th>שם</th><th>סטטוס</th><th>פעולות</th></tr></thead><tbody>
      {engineers?.filter(p=>p.name.toLowerCase().includes(query.toLowerCase())).map(p=><tr key={p.id}><td dir="auto" className="font-semibold text-white">{p.name}</td><td>{p.active?"פעיל":"לא פעיל"}</td><td><div className="flex flex-wrap gap-2">
        <button className="account-secondary" disabled={busy} onClick={()=>{setEditing(p);setName(p.name);}}>ערוך</button>
        <button className="account-secondary" disabled={busy} onClick={()=>action(()=>accountRequest(`/engineers/${p.id}`,"PUT",{name:p.name,active:!p.active}))}>{p.active?"הפוך ללא פעיל":"הפעל"}</button>
      </div></td></tr>)}
    </tbody></table>{!engineers&&!loadError&&<p className="p-4">טוען רשימה…</p>}</div>
    <p className="text-xs text-zinc-500 mt-3">השבתת מהנדס שומרת את הבעלות הקיימת ומסירה אותו מבחירות חדשות.</p>
  </main>;
}
