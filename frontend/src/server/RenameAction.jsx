// Rename… (one-place spec v1 §1.6, WP-2): in the action bar (Operator). The dialog asks for the new name, previews
// POST /api/devices/rename-opt (dry_run: every PDU outlet and KVM port of the server, its rack layout, ping monitor
// and owner; the same describeRename lines as RenameEverywhereDialog) and applies it with the preview's plan_revision.
// A name that is already a server (409 "… already exists") offers "Swap with <name>" (act.openMove({ mode: "swap",
// swapWith })). After the rename the window reloads the lab data and moves to the new key (act.rekey) in the same
// render, so it never shows "No longer in the lab list". Export shape: window/CONTRACT.md.
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api/client.js";
import { describeRename } from "../api/renameEverywhere.js";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { useLabWindow } from "../window/labWindowContext.js";
import { checkRename, existingServer, renameFrom, renameResult } from "./serverIdentity.js";

function Bar({ record, act }) {
  return <button type="button" className="lab-window-btn" data-action="rename" onClick={() => act.openDialog("rename", { key: record.key })}>Rename…</button>;
}

function more() {
  return [];
}

function Lines({ title, lines }) {
  if (!lines.length) return null;
  return <>
    <h3 className="racks-dialog-subtitle">{title}</h3>
    <ul className="remove-server-list">
      {lines.map(l => <li key={l.key} dir="auto"><bdi>{l.where}</bdi>: <bdi>{l.before}</bdi> → <bdi>{l.after}</bdi></li>)}
    </ul>
  </>;
}

// The preview of a rename (the dry run's plan): ports, rack layout, monitor and owner.
function Preview({ plan }) {
  const d = describeRename(plan);
  return <div data-rename-preview="">
    <Lines title="PDU outlets" lines={d.pdu}/>
    <Lines title="KVM ports" lines={d.kvm}/>
    <dl className="racks-dl">
      <div><dt>Rack layout</dt><dd data-rename="position">{d.position ? <><bdi>{d.position}</bdi> (kept{d.layoutCount ? `; ${d.layoutCount} rack layout ${d.layoutCount === 1 ? "entry" : "entries"} renamed` : ""}{d.pinCount ? `; ${d.pinCount} automatic U ${d.pinCount === 1 ? "number is" : "numbers are"} saved so no server moves` : ""})</> : "Not placed in a rack"}</dd></div>
      <div><dt>Ping monitor</dt><dd data-rename="monitor">{d.monitor ? <><bdi>{d.monitor.before}</bdi> → <bdi>{d.monitor.after}</bdi></> : "None"}</dd></div>
      <div><dt>Owner</dt><dd data-rename="owner">{d.owner ? <><bdi>{d.owner}</bdi> (kept)</> : "None"}</dd></div>
    </dl>
  </div>;
}

function RenameDialog({ record, act, close }) {
  const lab = useLabWindow();
  const from = renameFrom(record);
  const [name, setName] = useState(from);
  const [plan, setPlan] = useState(null);        // the preview of planFor
  const [planFor, setPlanFor] = useState("");
  const [error, setError] = useState("");
  const [exists, setExists] = useState(null);    // { key, name } of the server that already has the name
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const applyRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: inputRef, busyRef, onEscape: close });
  useEffect(() => { inputRef.current?.select(); }, []);
  const current = plan && planFor === name.trim() ? plan : null;
  useEffect(() => { if (current) applyRef.current?.focus(); }, [current]);

  // note: a message to show with the fresh preview (a refused apply).
  async function preview(e, note = "") {
    e?.preventDefault?.();
    if (busyRef.current) return;
    const checked = checkRename(record, name);
    setPlan(null); setExists(null);
    if (checked.error) { setError(checked.error); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      const answer = await api.renameOpt(from, checked.name, { dryRun: true });
      setPlan(answer); setPlanFor(checked.name);
      if (note) setError(note);
    } catch (err) {
      const other = existingServer(err, checked.name);
      setExists(other);
      setError(other ? `${other.name} already exists. Swap the two servers instead, or choose another name.` : errorMessage(err));
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function apply() {
    if (busyRef.current || !current) return;
    const checked = checkRename(record, planFor);
    if (checked.error) { setError(checked.error); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      // The live reload waits until the window has moved to the new key. The window reads /locations alone, then
      // moves to the new key: both land in one render, so it never shows "No longer in the lab list" in between.
      await act.during(async () => {
        await api.renameOpt(from, checked.name, { planRevision: current.plan_revision });
        await lab.reload(["devices"]);
        lab.act.showResult(checked.key, renameResult(current, from, checked.name));
        act.toast(`Renamed ${from} to ${checked.name}.`);
        close();
        act.rekey(checked.key);
      });
    } catch (err) {
      busyRef.current = false; setBusy(false);
      if (err?.status === 409 && !/already exists/.test(String(err.detail || ""))) {
        // The labels, layout, monitor or owner changed since the preview (plan_revision): preview again.
        preview(null, `${errorMessage(err)} The preview below is up to date now.`);
        return;
      }
      const other = existingServer(err, checked.name);
      setExists(other);
      setError(other ? `${other.name} already exists now. Swap the two servers instead, or choose another name.` : errorMessage(err));
      return;
    }
    busyRef.current = false;
    lab.reload();   // owners, switch ports and the monitor under the new name
  }

  const titleId = "server-rename-title";
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) close(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="racks-dialog racks-dialog-wide" data-dialog="rename">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">Rename <bdi>{from}</bdi></h2>
      <p className="racks-dialog-note">Every PDU outlet and KVM port of <bdi>{from}</bdi> changes together (each feed keeps its suffix), with its rack place, ping monitor and owner.</p>
      <form className="racks-field" onSubmit={preview}>
        <label htmlFor="server-rename-name">New name</label>
        <div className="scan-unit-row">
          <input ref={inputRef} id="server-rename-name" dir="auto" value={name} maxLength={200} autoComplete="off" spellCheck={false} disabled={busy}
            aria-invalid={error && !current ? true : undefined} aria-describedby={error ? "server-rename-error" : undefined}
            onChange={e => { setName(e.target.value); setError(""); setExists(null); }}/>
          <button type="submit" className="racks-btn" data-action="preview-rename" disabled={busy || !name.trim()}>Preview</button>
        </div>
      </form>
      {busy && !current && <p className="racks-muted mt-2" role="status">Checking what changes…</p>}
      {current && <>
        <h3 className="racks-dialog-subtitle">Rename <bdi>{from}</bdi> to <bdi>{planFor}</bdi></h3>
        <Preview plan={current}/>
      </>}
      {error && <p id="server-rename-error" role="alert" dir="auto" className="racks-dialog-error">{error}</p>}
      <div className="racks-dialog-actions">
        <button type="button" className="racks-btn" disabled={busy} onClick={close}>Cancel</button>
        {exists && <button type="button" className="racks-btn racks-btn-primary" data-action="swap-with"
          onClick={() => act.openMove({ mode: "swap", swapWith: exists.key })}>Swap with <bdi>{exists.name}</bdi></button>}
        {current && <button ref={applyRef} type="button" className="racks-btn racks-btn-primary" data-action="apply-rename" disabled={busy} onClick={apply}>
          {busy ? "Renaming…" : `Rename to ${planFor}`}</button>}
      </div>
    </section>
  </div>;
}

function Dialogs({ dialog, record, can, act, close }) {
  if (dialog?.type !== "rename" || !can.operate) return null;
  return <RenameDialog record={record} act={act} close={close}/>;
}

export default { Bar, more, Dialogs, dialogTypes: ["rename"] };
