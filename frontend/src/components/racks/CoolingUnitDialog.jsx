import { useMemo, useRef, useState } from "react";
import useDialogFocus from "./useDialogFocus.js";
import { validShelf, validPlace, placeWord, describeFloor } from "./chillers.js";
import { RACK_FLOORS } from "./floors.js";

// View, edit or add one cooling unit. Units are never deleted: "Take off floor" keeps the rack, "No rack" keeps the
// unit unassigned. onSave({ name, rack, u }) and onTakeOffShelf() throw Error(message) for this dialog to show.
// onRequestEdit (view mode, Operator and up): "Move…" / "Place…" turns Edit on and reopens this unit to be edited.
// floorOptionsFor(rack): the rack's floors 1-RACK_FLOORS (Main storage: its shelves) as { value, label }.
// A unit saved on a U the rack does not offer (old data, e.g. 17) keeps that U unless a floor is chosen: its rack
// offers it as its own choice, selected, with a hint; nothing is moved by a rename.
export default function CoolingUnitDialog({ mode, unit, rackNames, floorOptionsFor, canOperate, onRequestEdit = null, onSave, onTakeOffShelf, onClose }) {
  const editing = mode === "edit" || mode === "create";
  const initialRack = unit?.rack ?? "";
  const savedOff = !!initialRack && validShelf(unit?.u) && !validPlace(unit.u, initialRack);   // e.g. U17 in a rack
  const savedBad = unit?.u != null && unit?.u !== "" && !validPlace(unit.u, initialRack);
  const initialShelf = validShelf(unit?.u) && (savedOff || validPlace(unit.u, initialRack)) ? String(unit.u) : "";
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
  const moveRef = useRef(null);
  const errorRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: editing ? rackRef : onRequestEdit ? moveRef : closeRef, busyRef, onEscape: onClose });

  const knownRack = !initialRack || rackNames.includes(initialRack);
  const word = placeWord(rack || initialRack);
  const options = useMemo(() => {
    if (!rack) return [{ value: "", label: "Not on a floor (rack level)" }];
    const list = floorOptionsFor(rack);
    return savedOff && rack === initialRack ? [...list, { value: String(unit.u), label: `U${unit.u} · saved, not one of floors 1–${RACK_FLOORS}` }] : list;
  }, [rack, floorOptionsFor, savedOff, initialRack, unit]);
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
          <div><dt>{placeWord(unit.rack) === "floor" ? "Floor" : "Shelf"}</dt><dd>{describeFloor(unit)}</dd></div>
          <div><dt>Id</dt><dd className="racks-mono">{unit.id}</dd></div>
        </dl>
        <p className="racks-dialog-note">{onRequestEdit ? "This turns on Edit mode, where changes save immediately." : canOperate ? "Turn on Edit to move this unit." : "Viewer · read only"}</p>
        <div className="racks-dialog-actions racks-dialog-actions-primary-first">
          {onRequestEdit && <button ref={moveRef} type="button" className="racks-btn racks-btn-primary" onClick={onRequestEdit}>
            {unit.rack && validShelf(unit.u) && knownRack ? "Move…" : "Place…"}</button>}
          <button ref={closeRef} type="button" className="racks-btn" onClick={onClose}>Close</button>
        </div>
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
          <label htmlFor="cooling-floor">{word === "floor" ? "Floor" : "Shelf"}</label>
          <select id="cooling-floor" value={rack ? shelf : ""} disabled={busy || !rack} onChange={e => setShelf(e.target.value)}
            aria-describedby={savedBad ? "cooling-floor-hint" : undefined}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {unit && savedBad && <p id="cooling-floor-hint" className="racks-field-hint">Saved {placeWord(initialRack)} is invalid ({String(unit.u)}); choose a {word} or leave it off the {word === "floor" ? "floors" : "shelves"}.{savedOff ? " Until you do, it stays where it is." : ""}</p>}
        </div>
        {error && <p ref={errorRef} tabIndex={-1} role="alert" dir="auto" className="racks-dialog-error">{error}</p>}
        <div className="racks-dialog-actions racks-dialog-actions-primary-first">
          <button type="submit" className="racks-btn racks-btn-primary" disabled={busy || !changed}>{busy ? "Saving…" : mode === "create" ? "Add" : "Save"}</button>
          {mode === "edit" && validShelf(unit?.u) && <button type="button" className="racks-btn" disabled={busy}
            aria-describedby="cooling-offshelf-hint" onClick={() => run(onTakeOffShelf)}>Take off {placeWord(unit.rack)}</button>}
          <button type="button" className="racks-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
        {mode === "edit" && validShelf(unit?.u) && <p id="cooling-offshelf-hint" className="racks-field-hint">Take off {placeWord(unit.rack)} keeps it in <bdi>{unit.rack}</bdi>, not on a {placeWord(unit.rack)}.</p>}
      </form>}
    </section>
  </div>;
}
