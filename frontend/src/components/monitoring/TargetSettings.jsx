// The settings of one ping monitor (Operator): display name, automatic name sync, address and "Monitor this server",
// saved with an explicit Save against the monitor's revision. Extracted from pages/MonitoringView.jsx; the server
// window's Activity block and Ping Monitor's side panel both use it.
//
// base = the server version being edited, draft = what the user typed. New data (a poll, the change feed) never
// replaces a draft: a clean form follows the server, a dirty one keeps the typed values until saved or discarded, and
// says so when someone else saved meanwhile (or when the save meets the server's 409).
// Unticking "Monitor this server" asks first: pausing closes an open incident (backend monitoring.edit_target).
//
// Props: target (GET /api/monitoring target), onSaved() reloads the target list (awaited), during(fn) runs the save
// (the window passes act.during, so live reloads wait for it).
import { useEffect, useRef, useState } from "react";
import { monitorRequest } from "./MonitorDetails.jsx";
import { pausesMonitor } from "../../server/serverHistory.js";

const input = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:border-nv-400";
const button = "rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40";

const settingsOf = t => ({ name: t.name, syncName: t.name_synced !== false, host: t.host, enabled: t.enabled });
const sameSettings = (a, b) => a.name === b.name && a.syncName === b.syncName && a.host === b.host && a.enabled === b.enabled;
const runDirect = fn => fn();

export default function TargetSettings({ target, onSaved, during = runDirect }) {
  const [base, setBase] = useState(target);
  const [draft, setDraft] = useState(() => settingsOf(target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rejected, setRejected] = useState(false);
  const [askPause, setAskPause] = useState(false);
  const hostRef = useRef(null);
  const saveRef = useRef(null);
  const loadRef = useRef(null);
  const keepRef = useRef(null);
  const enabledRef = useRef(null);
  const pendingFocus = useRef(null);
  const dirty = !sameSettings(draft, settingsOf(base));
  // A poll that started before the last save must not move a clean form back to older values.
  const live = target.revision >= base.revision ? target : base;
  const current = dirty ? base : live;
  const value = dirty ? draft : settingsOf(live);
  // While a save is running, a poll may already carry the revision this save wrote: that is not someone else's change.
  const conflict = !busy && dirty && (rejected || target.revision > base.revision);
  const synced = value.syncName && target.source === "inventory";

  // Disabled controls and removed buttons drop focus to BODY; put it back once the form settles.
  useEffect(() => {
    if (!pendingFocus.current || busy) return;
    const next = typeof pendingFocus.current === "function" ? pendingFocus.current() : pendingFocus.current;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (next?.isConnected && !next.disabled && (!active || active === document.body || active === enabledRef.current)) next.focus();
  });

  function edit(patch) {
    // A new edit starts from the values on screen; a notice about the last save of a clean form no longer applies.
    if (!dirty) { setBase(live); setRejected(false); setError(""); }
    setDraft({ ...value, ...patch });
  }
  function toggleEnabled(checked) {
    if (!checked && pausesMonitor(current, { enabled: false })) {
      setAskPause(true);
      pendingFocus.current = () => keepRef.current;
      return;
    }
    setAskPause(false);
    edit({ enabled: checked });
  }
  function confirmPause() {
    setAskPause(false);
    edit({ enabled: false });
    pendingFocus.current = () => saveRef.current;
  }
  function keepMonitoring() {
    setAskPause(false);
    pendingFocus.current = () => enabledRef.current;
  }
  function loadCurrent() {
    setBase(target); setDraft(settingsOf(target)); setRejected(false); setError(""); setAskPause(false);
    pendingFocus.current = hostRef.current;
  }
  function keepMine() {
    setBase(target); setRejected(false); setError("");
    pendingFocus.current = () => saveRef.current;
  }
  async function save(event) {
    event.preventDefault();
    if (busy || conflict || askPause) return;
    const sent = value;
    pendingFocus.current = document.activeElement;
    setBusy(true); setError("");
    await during(async () => {
      let saved;
      try {
        saved = await monitorRequest(`/targets/${encodeURIComponent(target.id)}`, "PUT", { host: sent.host, enabled: sent.enabled, name: sent.name, sync_name: sent.syncName, revision: current.revision });
      } catch (e) {
        if (e.status === 409) {
          // Load the server's current values for the conflict notice; the draft stays as typed.
          try { await onSaved(); } catch { /* the notice still offers both choices */ }
          setRejected(true);
          if (!dirty) setError("Someone else changed this server. The form now shows the current values.");
          pendingFocus.current = () => loadRef.current || saveRef.current;
        } else setError(e.message);
        setBusy(false);
        return;
      }
      const next = { ...current, ...saved, name: saved.name_synced && target.source === "inventory" ? current.inventory_name : saved.name, inventory_name: current.inventory_name };
      setBase(next); setDraft(settingsOf(next)); setRejected(false);
      try { await onSaved(); }
      catch (e) { setError(`Saved. The server list could not refresh: ${e.message}`); }
      finally { setBusy(false); }
    });
  }
  return <form onSubmit={save} className="space-y-3 border-b border-zinc-800 pb-5 mb-5" data-monitor-settings={target.id}>
    <label className="block text-xs text-zinc-400">Display name
      <input aria-label="Display name" className={`${input} mt-2`} value={synced ? target.inventory_name : value.name} onChange={e => edit({ name: e.target.value })} readOnly={synced} required maxLength={160} disabled={busy}/>
    </label>
    {target.source === "inventory" && <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={value.syncName} onChange={e => edit({ syncName: e.target.checked, name: current.name })} disabled={busy}/>Use the inventory name</label>}
    <p className="text-xs text-zinc-500">The display name does not change the check address or the PDU and KVM links.</p>
    <label className="block text-xs text-zinc-400">IP address or DNS hostname
      <input ref={hostRef} aria-label={`Address for ${target.name}`} className={`${input} mt-2`} value={value.host} onChange={e => edit({ host: e.target.value })} maxLength={253} placeholder="e.g. opt133 or 10.7.30.25" disabled={busy} />
    </label>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm text-zinc-300"><input ref={enabledRef} type="checkbox" checked={value.enabled && !askPause} onChange={e => toggleEnabled(e.target.checked)} disabled={busy} />Monitor this server</label>
      <button ref={saveRef} className={button} disabled={busy || conflict || askPause}>{busy ? "Saving…" : "Save settings"}</button>
    </div>
    {askPause && <div role="group" aria-label="Stop monitoring?" className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 space-y-2" data-confirm-pause="">
      <p className="text-sm text-amber-300">Stop monitoring {target.name}? An open incident is closed (not marked as recovered) and no alerts are sent until you tick it again. Save settings to apply.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={confirmPause}>Stop monitoring</button>
        <button ref={keepRef} type="button" className={button} onClick={keepMonitoring}>Keep monitoring</button>
      </div>
    </div>}
    {conflict && <div role="alert" className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 space-y-2">
      <p className="text-sm text-amber-300">Someone else changed this server while you were editing. Your changes are not saved yet.</p>
      <p className="text-xs text-zinc-300 break-words">Current server values: {target.name} · <span className="font-mono">{target.host || "no address"}</span> · {target.enabled ? "monitored" : "paused"}</p>
      <div className="flex flex-wrap gap-2">
        <button ref={loadRef} type="button" className={button} onClick={loadCurrent}>Load current values</button>
        <button type="button" className={button} onClick={keepMine}>Keep my changes</button>
      </div>
    </div>}
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
  </form>;
}
