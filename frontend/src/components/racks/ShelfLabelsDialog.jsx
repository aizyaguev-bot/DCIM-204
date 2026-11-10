import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useDialogFocus from "./useDialogFocus.js";
import { LABEL_NONE, labelLines, labelsText, labelWhere, withEdits } from "../../shelfLabels.js";

// Shelf labels: the three-line labels (project, owner, server) of one floor, of one rack, or of every rack (with a rack
// choice), each one editable for this printout only (nothing is saved), with Copy and Print. Print prints only the
// label sheet (index.css @media print hides everything else while this dialog is open). Every role can use it.
// groups: [{ rack, labels }] for every rack (shelfLabels.buildShelfLabels per rack), recomputed by the page as its data
// changes; scope: { rack, u } (u: one floor; rack null: every rack, with the rack choice); onClose().

const FIELDS = [["project", "Project", "project:"], ["owner", "Owner", "owner:"], ["server", "Server", ""]];

// Copies text to the clipboard: the Clipboard API where the page may use it (https, localhost), else a hidden textarea
// in the dialog and the copy command (the lab site is plain http). true when it worked.
async function copyText(text, host) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* falls back below */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  (host || document.body).appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  return ok;
}

export default function ShelfLabelsDialog({ groups, scope, onClose }) {
  const panelRef = useRef(null);
  const copyRef = useRef(null);
  const closeRef = useRef(null);
  const [rackChoice, setRackChoice] = useState(scope?.rack || "");
  const [edits, setEdits] = useState({});
  const [status, setStatus] = useState(null);   // { kind: "ok" | "error", text }
  // While the dialog is open, printing prints only its label sheet.
  useEffect(() => {
    document.body.classList.add("shelf-labels-open");
    return () => document.body.classList.remove("shelf-labels-open");
  }, []);

  const floor = scope?.u != null && scope?.rack ? scope : null;
  const chooser = !scope?.rack;
  const rack = floor ? scope.rack : rackChoice;
  const group = rack ? (groups || []).find(g => g.rack === rack) : null;
  const storage = !!group?.storage;
  const labels = useMemo(() => {
    const list = rack ? group?.labels || [] : (groups || []).flatMap(g => g.labels);
    return floor ? list.filter(l => l.u === floor.u) : list;
  }, [groups, group, rack, floor]);
  const shown = useMemo(() => labels.map(l => withEdits(l, edits)), [labels, edits]);
  const edited = labels.some(l => edits[l.key]);   // edits of labels in view (a label gone from the data drops out)
  useEffect(() => { setStatus(null); }, [rack]);
  // Focus starts on Copy (on Close when there is nothing to copy).
  const startRef = useRef(null);
  if (!startRef.current) startRef.current = labels.length ? copyRef : closeRef;
  useDialogFocus(panelRef, { initialRef: startRef.current, onEscape: onClose });

  const title = floor ? `Shelf label · ${labelWhere(floor.rack, floor.u, storage)}` : rack ? `Shelf labels · ${rack}` : "Shelf labels";
  const many = !floor || shown.length > 1;
  const titleId = "shelf-labels-title", noteId = "shelf-labels-note";
  const emptyText = floor ? `Nothing on ${storage ? "shelf" : "floor"} ${floor.u} to label: it has no server and no unit.`
    : rack ? `No server or unit is on the ${storage ? "shelves" : "floors"} of ${rack}.` : "No server or unit is on any floor or shelf.";

  function edit(key, field, value) {
    setStatus(null);
    setEdits(prev => {
      const base = labels.find(l => l.key === key);
      const own = { ...(prev[key] || {}), [field]: value };
      // An emptied field prints "—" like the original; it is no edit.
      if (base && (own[field] === base[field] || (!own[field].trim() && base[field] === LABEL_NONE))) delete own[field];
      const next = { ...prev };
      if (Object.keys(own).length) next[key] = own; else delete next[key];
      return next;
    });
  }

  async function copy() {
    if (!shown.length) return;
    const ok = await copyText(labelsText(shown), panelRef.current);
    copyRef.current?.focus();
    setStatus(ok ? { kind: "ok", text: shown.length === 1 ? "Copied the label (3 lines)." : `Copied ${shown.length} labels.` }
      : { kind: "error", text: "The browser did not allow copying. Select the text in the fields and copy it with Ctrl+C." });
  }

  function print() {
    if (!shown.length) return;
    setStatus(null);
    window.print();
  }

  const dialog = <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 shelf-labels-overlay"
    onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={noteId} tabIndex={-1}
      className="racks-dialog racks-dialog-wide shelf-labels-dialog" data-dialog="shelf-labels">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">{title}</h2>
      <p id={noteId} className="racks-dialog-note">Line 1 the product on the {storage ? "shelf" : "floor"}, line 2 the server's owner, line 3 the server.
        Edits here change only this printout; nothing is saved.</p>
      {chooser && <div className="racks-field">
        <label htmlFor="shelf-labels-rack">Racks</label>
        <select id="shelf-labels-rack" value={rackChoice} onChange={e => setRackChoice(e.target.value)}>
          <option value="">All racks</option>
          {(groups || []).map(g => <option key={g.rack} value={g.rack}>{g.rack} ({g.labels.length})</option>)}
        </select>
      </div>}
      {many && shown.length > 0 && <p className="shelf-labels-count" data-count={shown.length}>{shown.length} {shown.length === 1 ? "label" : "labels"}</p>}
      {shown.length ? <ul className="shelf-labels-list" aria-label="Labels" data-single={shown.length === 1 ? "" : undefined}>
        {shown.map(label => {
          const server = labels.find(l => l.key === label.key)?.server;
          const name = server && server !== LABEL_NONE ? `${label.where} · ${server}` : label.where;
          return <li key={label.key} className="shelf-label-edit" role="group" aria-label={name} data-label-rack={label.rack} data-label-u={label.u}>
            {many && <p className="shelf-label-where" dir="auto">{label.where}</p>}
            {FIELDS.map(([field, word, key]) => <label key={field} className="shelf-label-line" data-field={field}>
              {key && <span className="shelf-label-key" aria-hidden="true">{key}</span>}
              <input value={label[field] === LABEL_NONE ? "" : label[field]} placeholder={LABEL_NONE} dir="auto" aria-label={word} spellCheck={false} autoComplete="off"
                className={field === "server" ? "shelf-label-server" : undefined} onChange={e => edit(label.key, field, e.target.value)}/>
            </label>)}
          </li>;
        })}
      </ul> : <p className="racks-muted shelf-labels-empty" role="status">{emptyText}</p>}
      <p className="shelf-labels-status" role="status">{status?.kind === "ok" ? status.text : ""}</p>
      {status?.kind === "error" && <p className="racks-dialog-error" role="alert">{status.text}</p>}
      <div className="racks-dialog-actions">
        {edited && <button type="button" className="racks-btn" onClick={() => { setEdits({}); setStatus(null); copyRef.current?.focus(); }}>Undo edits</button>}
        <button ref={closeRef} type="button" className="racks-btn" onClick={onClose}>Close</button>
        <button ref={copyRef} type="button" className="racks-btn" data-action="copy" disabled={!shown.length} onClick={copy}>{many ? "Copy all" : "Copy"}</button>
        <button type="button" className="racks-btn racks-btn-primary" data-action="print" disabled={!shown.length} onClick={print}>{many ? "Print all" : "Print"}</button>
      </div>
    </section>
  </div>;

  // The sheet that prints: one bordered label per box, the server name larger and bold, in a grid.
  const sheet = <div className="shelf-print-sheet" aria-hidden="true">
    {shown.map(label => {
      const [project, owner, server] = labelLines(label);
      return <div key={label.key} className="shelf-print-label">
        <div className="shelf-print-line" dir="auto">{project}</div>
        <div className="shelf-print-line" dir="auto">{owner}</div>
        <div className="shelf-print-server" dir="auto">{server}</div>
      </div>;
    })}
  </div>;

  return <>{createPortal(dialog, document.body)}{createPortal(sheet, document.body)}</>;
}
