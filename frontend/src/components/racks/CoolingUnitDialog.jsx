import { useMemo, useRef, useState } from "react";
import useDialogFocus from "./useDialogFocus.js";
import { validShelf, describeShelf } from "./chillers.js";

// View, edit or add one cooling unit. Units are never deleted: "Take off shelf" keeps the rack, "No rack" keeps the
// unit unassigned. onSave({ name, rack, u }) and onTakeOffShelf() throw Error(message) for this dialog to show.
export default function CoolingUnitDialog({ mode, unit, rackNames, shelfOptionsFor, canOperate, onSave, onTakeOffShelf, onClose }) {
  const editing = mode === "edit" || mode === "create";
  const initialRack = unit?.rack ?? "";
  const initialShelf = validShelf(unit?.u) ? String(unit.u) : "";
  const [name, setName] = useState(unit?.name ?? "");
  const [rack, setRack] = useState(initialRack);
  const [shelf, setShelf] = useState(initialShelf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const rackRef = useRef(null);
  const closeRef = useRef(null);
  const errorRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: editing ? rackRef : closeRef, busyRef, onEscape: onClose });

  const knownRack = !initialRack || rackNames.includes(initialRack);
  const options = useMemo(() => (rack ? shelfOptionsFor(rack) : [{ value: "", label: "Not on a shelf (rack level)" }]), [rack, shelfOptionsFor]);
  const trimmed = name.trim();
  const changed = mode === "create" ? true : trimmed !== (unit?.name ?? "") || rack !== initialRack || shelf !== initialShelf;
  const titleId = "cooling-dialog-title";

  async function run(action) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (e) {
      busyRef.current = false; setBusy(false);
      setError(e?.message || "The cooling assignment was not saved.");
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    busyRef.current = false;
  }

  function save(e) {
    e?.preventDefault();
    if (!trimmed || trimmed.length > 40) { setNameError("Enter a name (1–40 characters)."); return; }
    setNameError("");
    if (!changed) return;
    run(() => onSave({ name: trimmed, rack: rack || null, u: rack && shelf ? Number(shelf) : null }));
  }

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="racks-dialog" data-dialog="cooling">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">{mode === "create" ? "Add cooling unit" : <>Cooling unit <bdi>{unit.name}</bdi></>}</h2>
      {!editing ? <>
        <dl className="racks-dl">
          <div><dt>Name</dt><dd dir="auto">{unit.name}</dd></div>
          <div><dt>Rack</dt><dd dir="auto">{unit.rack ? <>{unit.rack}{!knownRack && " (not found)"}</> : "No rack"}</dd></div>
          <div><dt>Shelf</dt><dd>{describeShelf(unit)}</dd></div>
          <div><dt>Id</dt><dd className="racks-mono">{unit.id}</dd></div>
        </dl>
        <p className="racks-dialog-note">{canOperate ? "Turn on Edit to move this unit." : "Viewer · read only"}</p>
        <div className="racks-dialog-actions"><button ref={closeRef} type="button" className="racks-btn" onClick={onClose}>Close</button></div>
      </> : <form onSubmit={save} noValidate>
        <div className="racks-field">
          <label htmlFor="cooling-name">Name</label>
          <input id="cooling-name" dir="auto" value={name} maxLength={60} disabled={busy} autoComplete="off"
            aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? "cooling-name-error" : undefined}
            onChange={e => { setName(e.target.value); setNameError(""); }}/>
          {nameError && <p id="cooling-name-error" role="alert" className="racks-field-error">{nameError}</p>}
        </div>
        <div className="racks-field">
          <label htmlFor="cooling-rack">Rack</label>
          <select id="cooling-rack" ref={rackRef} value={rack} disabled={busy}
            onChange={e => { setRack(e.target.value); setShelf(""); }}>
            {rackNames.map(r => <option key={r} value={r}>{r}</option>)}
            {!knownRack && <option value={initialRack}>{initialRack} (not found)</option>}
            <option value="">No rack (unassigned)</option>
          </select>
        </div>
        <div className="racks-field">
          <label htmlFor="cooling-shelf">Shelf</label>
          <select id="cooling-shelf" value={rack ? shelf : ""} disabled={busy || !rack} onChange={e => setShelf(e.target.value)}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {unit && !validShelf(unit.u) && unit.u != null && unit.u !== "" && <p className="racks-field-hint">Saved shelf is invalid ("{String(unit.u)}"); choose a shelf or leave it off the shelves.</p>}
        </div>
        {error && <p ref={errorRef} tabIndex={-1} role="alert" dir="auto" className="racks-dialog-error">{error}</p>}
        <div className="racks-dialog-actions racks-dialog-actions-primary-first">
          <button type="submit" className="racks-btn racks-btn-primary" disabled={busy || !changed}>{busy ? "Saving…" : mode === "create" ? "Add" : "Save"}</button>
          {mode === "edit" && validShelf(unit?.u) && <button type="button" className="racks-btn" disabled={busy}
            aria-describedby="cooling-offshelf-hint" onClick={() => run(onTakeOffShelf)}>Take off shelf</button>}
          <button type="button" className="racks-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
        {mode === "edit" && validShelf(unit?.u) && <p id="cooling-offshelf-hint" className="racks-field-hint">Take off shelf keeps it in <bdi>{unit.rack}</bdi>, not on a shelf.</p>}
      </form>}
    </section>
  </div>;
}
