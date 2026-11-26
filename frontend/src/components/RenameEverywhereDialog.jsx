import { useCallback, useEffect, useRef, useState } from "react";
import useDialogFocus from "./racks/useDialogFocus.js";
import { errorMessage } from "../api/client";
import { describeRename, serverName } from "../api/renameEverywhere.js";

function Changes({ title, lines }) {
  if (!lines.length) return null;
  return <div className="mt-3">
    <div className="text-xs uppercase tracking-wider text-zinc-500">{title}</div>
    <ul className="mt-1 space-y-0.5 text-sm">
      {lines.map(l => <li key={l.key} dir="auto"><bdi>{l.where}</bdi>: <bdi className="text-zinc-400">{l.before}</bdi> → <bdi className="text-zinc-100">{l.after}</bdi></li>)}
    </ul>
  </div>;
}

// "Rename OPTN45 to OPTN46?" Lists what the dry run would change. Rename everywhere is the default; Only this port
// keeps today's single-port save; Cancel and Escape save nothing. onChoose("everywhere" | "only" | null).
export default function RenameEverywhereDialog({ group, preview, error, portWord = "port", onChoose }) {
  const panelRef = useRef(null);
  const primaryRef = useRef(null);
  const onlyRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: preview ? primaryRef : onlyRef, onEscape: () => onChoose(null) });
  const from = serverName(group.old_name), to = serverName(group.new_name);
  const d = describeRename(preview);
  const titleId = "rename-everywhere-title";
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    onMouseDown={e => { if (e.target === e.currentTarget) onChoose(null); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className="racks-dialog racks-dialog-wide" data-dialog="rename-everywhere">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">Rename <bdi>{from}</bdi> to <bdi>{to}</bdi>?</h2>
      {preview ? <>
        <p dir="auto" className="mt-2 text-sm text-zinc-300">
          Everything that belongs to <bdi>{from}</bdi> changes together, so its feeds, KVM port and rack position stay in sync:
        </p>
        <Changes title="PDU outlets" lines={d.pdu} />
        <Changes title="KVM ports" lines={d.kvm} />
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-zinc-500">Rack position</dt>
          <dd data-rename="position">{d.position ? <><bdi>{d.position}</bdi> (kept{d.layoutCount ? `; ${d.layoutCount} rack layout ${d.layoutCount === 1 ? "entry" : "entries"} renamed` : ""}{d.pinCount ? `; ${d.pinCount} automatic U ${d.pinCount === 1 ? "number is" : "numbers are"} saved so no server moves` : ""})</> : "Not placed in a rack"}</dd>
          <dt className="text-zinc-500">Ping monitor</dt>
          <dd data-rename="monitor">{d.monitor ? <><bdi>{d.monitor.before}</bdi> → <bdi>{d.monitor.after}</bdi></> : "None"}</dd>
          <dt className="text-zinc-500">Owner</dt>
          <dd data-rename="owner">{d.owner ? <><bdi>{d.owner}</bdi> (kept)</> : "None"}</dd>
        </dl>
        <p dir="auto" className="mt-3 text-xs text-zinc-400">
          Only this {portWord}: just this {portWord} changes; the other ports and the rack position keep <bdi>{from}</bdi>.
        </p>
      </> : <p role="alert" dir="auto" className="mt-2 text-sm text-rose-300">
        The rename could not be previewed: {errorMessage(error)}. You can still change only this {portWord}.
      </p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="racks-btn" data-choice="cancel" onClick={() => onChoose(null)}>Cancel</button>
        <button type="button" ref={onlyRef} className="racks-btn" data-choice="only" onClick={() => onChoose("only")}>Only this {portWord}</button>
        {preview && <button type="button" ref={primaryRef} className="racks-btn racks-btn-primary" data-choice="everywhere"
          onClick={() => onChoose("everywhere")}>Rename everywhere</button>}
      </div>
    </section>
  </div>;
}

// ask({ group, preview, error }) opens the dialog and resolves to the choice; `dialog` is the element to render.
// A dialog still open when the page goes away resolves to null (nothing is saved).
export function useRenameEverywhere(portWord) {
  const [request, setRequest] = useState(null);
  const pending = useRef(null);
  const ask = useCallback(req => new Promise(resolve => {
    pending.current?.(null);
    pending.current = resolve;
    setRequest(req);
  }), []);
  useEffect(() => () => { pending.current?.(null); pending.current = null; }, []);
  const choose = useCallback(choice => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(choice);
  }, []);
  const dialog = request ? <RenameEverywhereDialog {...request} portWord={portWord} onChoose={choose} /> : null;
  return { ask, dialog };
}
