import { useEffect, useId, useRef, useState } from "react";
import { clearServer, normalizeClearResult, previewClear } from "../api/locations.js";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { useLabWindow } from "../window/labWindowContext.js";
import { moveDataKey, moveError, moveSummary, resultLines, whereText } from "./moveModel.js";
import "./place.css";

// More › Clear location… (v1 §1.7): the server's dry run of POST /api/devices/clear-server lists every PDU outlet and
// KVM port that gets its default name back; Apply sends that plan's revision in ONE request (no per-port writes). Its
// saved rack place is kept, so a later move or Choose ports puts it back. Other servers keep their floors: when
// freeing an automatic U would shift them, their U numbers are pinned (the plan's "pins"). A change elsewhere
// meanwhile is refused (409) and previewed again.
export default function ClearLocationDialog({ record, act, close }) {
  const { data } = useLabWindow();
  const panelRef = useRef(null);
  const busyRef = useRef(false);
  const id = useId();
  const [plan, setPlan] = useState({ key: "", result: null, error: "" });
  const [again, setAgain] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(panelRef, { busyRef, onEscape: close });
  const dataKey = moveDataKey(data.locations, data.etags?.rackItems, data.devices);
  const planKey = `${record.name}|${dataKey}|${again}`;

  useEffect(() => {
    let alive = true;
    previewClear(record.name)
      .then(raw => { if (alive) setPlan({ key: planKey, result: { raw, ...normalizeClearResult(raw) }, error: "" }); })
      .catch(e => { if (alive) setPlan({ key: planKey, result: null, error: moveError(e) }); });
    return () => { alive = false; };
  }, [planKey]);
  const current = plan.key === planKey ? plan : { result: null, error: "" };
  const planned = current.result;

  async function confirm() {
    if (busyRef.current || !planned?.planRevision) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await act.during(() => clearServer(record.name, planned.planRevision));
      busyRef.current = false;
      const title = moveSummary("clear", record);
      act.showResult({ title, lines: resultLines(result) });
      act.toast(title);
      act.reload?.();
      close();
    } catch (e) {
      busyRef.current = false; setBusy(false);
      setError(moveError(e));
      setAgain(n => n + 1);
    }
  }

  const titleId = `${id}-title`, bodyId = `${id}-body`;
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) close(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}
      className="racks-dialog racks-dialog-wide place-dialog" data-dialog="clear-location">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">Clear the location of <bdi>{record.name}</bdi></h2>
      <div id={bodyId}>
        <p className="racks-dialog-note">Every PDU outlet and KVM port that names it gets its default name back. It is no longer drawn on Racks; its saved rack place is kept for a later move.</p>
        <div className="move-preview" data-clear-preview="" aria-live="polite">
          {!planned && !current.error && <p className="racks-muted" role="status">Checking what changes…</p>}
          {current.error && <p className="racks-dialog-error" role="alert" dir="auto">{current.error}</p>}
          {planned && <>
            <p className="racks-dialog-subtitle">Port labels</p>
            {planned.changes.length
              ? <ul className="move-preview-list" data-list="labels">{planned.changes.map(c => <li key={`${c.device_id}:${c.port}`} dir="auto">{c.where}: {c.before} → {c.after}</li>)}</ul>
              : <p className="racks-muted" data-list="labels">No port label changes.</p>}
            <p className="racks-dialog-subtitle">Place</p>
            <p className="racks-muted" data-list="kept">Kept: {planned.kept}.</p>
            {planned.pins.length > 0 && <>
              <p className="racks-dialog-subtitle">Other servers keep their floors</p>
              <ul className="move-preview-list" data-list="pins">{planned.pins.map(p => <li key={`${p.rack}:${p.id}`} dir="auto">{p.id}: pinned to {whereText({ rack: p.rack, slot: p.slot })}</li>)}</ul>
            </>}
            <p className="racks-muted">To put it back later, open it and use Move to… or Choose ports….</p>
          </>}
        </div>
        {error && <p role="alert" dir="auto" className="racks-dialog-error" data-move-error="">{error}</p>}
      </div>
      <div className="racks-dialog-actions">
        <button type="button" className="racks-btn" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="racks-btn racks-btn-primary" data-action="confirm-clear" disabled={busy || !planned?.planRevision || !planned.changes.length} onClick={confirm}>
          {busy ? "Clearing…" : "Clear location"}
        </button>
      </div>
    </section>
  </div>;
}
