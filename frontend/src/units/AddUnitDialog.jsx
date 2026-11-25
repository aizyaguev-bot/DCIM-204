// Add unit… (one-place spec v2 §M.4, Operator): a new rack item on a rack's floor or shelf, its rack level, or
// Storage-Main, with the unit form's fields. It reads the equipment list fresh and saves it with If-Match (a list saved
// elsewhere meanwhile is read again once, so nothing is overwritten); a serial number or MAC address another unit has
// is refused at its field. Manage › + Add › Unit… and the server window's "Units on this floor" open it.
// Props: { rack?: string, u?: number, onClose(), onAdded(unit) }   z-[60], data-dialog="add-unit"
import { useRef, useState } from "react";
import { UNIT_DETAILS, unitDetailChanges } from "../api/inventory.js";
import { loadLayout } from "../api/layout.js";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { rackHasFloors } from "../components/racks/floors.js";
import { useLabData } from "../window/labWindowContext.js";
import { putRackItems } from "./UnitForm.jsx";
import { UNIT_TYPES, addUnit, newUnitId, placeChoices, rackChoices, unitPlace } from "./unitModel.js";
import "./units.css";

const ATTEMPTS = 2;

export default function AddUnitDialog({ rack = null, u = null, onClose, onAdded }) {
  const { data, act } = useLabData("all");
  const racks = rackChoices(data);
  if (rack && !racks.includes(rack)) racks.push(rack);
  const [toRack, setToRack] = useState(rack || racks[0]);
  const [place, setPlace] = useState(Number.isInteger(u) ? String(u) : rackHasFloors(rack || racks[0]) ? "1" : "0");
  const [name, setName] = useState("");
  const [type, setType] = useState("other");
  const [notes, setNotes] = useState("");
  const [details, setDetails] = useState(() => Object.fromEntries(UNIT_DETAILS.map(([field]) => [field, ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [taken, setTaken] = useState(null);
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const nameRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: nameRef, busyRef, onEscape: onClose });
  const places = placeChoices(toRack);
  const shownPlace = places.some(p => p.value === place) ? place : "0";
  const { changes: filled, errors } = unitDetailChanges({}, details);
  if (taken && details[taken.field] === taken.value) errors[taken.field] = errors[taken.field] || taken.message;
  const invalid = Object.keys(errors).length > 0;
  const where = unitPlace({ u: Number(shownPlace) }, toRack);

  async function add(e) {
    e?.preventDefault();
    if (busyRef.current) return;
    if (!name.trim()) { setError("Type a name for the unit."); nameRef.current?.focus(); return; }
    if (invalid) return;
    busyRef.current = true; setBusy(true); setError("");
    const unit = { id: newUnitId(), name: name.trim(), type, u: Number(shownPlace), ...(notes.trim() ? { notes: notes.trim() } : {}), ...filled };
    try {
      await act.during(async () => {
        for (let attempt = 1; ; attempt++) {
          const { data: doc, etag } = await loadLayout("/api/rack-items");
          try { await putRackItems(addUnit(doc, toRack, unit), etag); return; }
          catch (err) { if (!err.stale || attempt >= ATTEMPTS) throw err; }
        }
      });
      await act.reload(["inventory"]);
      act.toast(`Added ${unit.name} to ${where}.`);
      onAdded?.(unit);
    } catch (err) {
      busyRef.current = false; setBusy(false);
      if (err.duplicate) {
        const field = /MAC address/.test(err.message) ? "mac" : "serial_number";
        setTaken({ field, value: details[field], message: err.message });
      } else setError(err.message || String(err));
    }
  }

  const titleId = "add-unit-title";
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="racks-dialog racks-dialog-wide" data-dialog="add-unit">
      <h2 id={titleId} className="racks-dialog-title">Add unit</h2>
      <form onSubmit={add} noValidate className="unit-form">
        <div className="racks-field">
          <label htmlFor="add-unit-name">Name</label>
          <input id="add-unit-name" ref={nameRef} dir="auto" value={name} maxLength={120} disabled={busy} autoComplete="off" placeholder="e.g. SW-Lab-01"
            onChange={e => { setName(e.target.value); setError(""); }}/>
        </div>
        <div className="racks-field">
          <label htmlFor="add-unit-type">Type</label>
          <select id="add-unit-type" value={type} disabled={busy} onChange={e => setType(e.target.value)}>
            {UNIT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="racks-field">
          <label htmlFor="add-unit-rack">Rack</label>
          <select id="add-unit-rack" value={toRack} disabled={busy} onChange={e => { setToRack(e.target.value); setPlace(rackHasFloors(e.target.value) ? "1" : "0"); }}>
            {racks.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="racks-field">
          <label htmlFor="add-unit-place">{rackHasFloors(toRack) ? "Floor" : "Shelf"}</label>
          <select id="add-unit-place" value={shownPlace} disabled={busy} onChange={e => setPlace(e.target.value)}>
            {places.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        {UNIT_DETAILS.map(([field, label]) => <div className="racks-field" key={field}>
          <label htmlFor={`add-unit-${field}`}>{label} (optional)</label>
          <input id={`add-unit-${field}`} value={details[field]} disabled={busy} spellCheck={false} autoComplete="off" dir="auto"
            placeholder={field === "mac" ? "00:1A:2B:3C:4D:5E" : ""}
            aria-invalid={errors[field] ? true : undefined} aria-describedby={errors[field] ? `add-unit-${field}-error` : undefined}
            onChange={e => { const value = e.target.value; setDetails(d => ({ ...d, [field]: value })); }}/>
          {errors[field] && <p id={`add-unit-${field}-error`} role="alert" className="racks-field-error">{errors[field]}</p>}
        </div>)}
        <div className="racks-field unit-form-wide">
          <label htmlFor="add-unit-notes">Notes (optional)</label>
          <input id="add-unit-notes" dir="auto" value={notes} maxLength={500} disabled={busy} autoComplete="off" onChange={e => setNotes(e.target.value)}/>
        </div>
        {error && <p role="alert" dir="auto" className="racks-dialog-error unit-form-wide">{error}</p>}
        <div className="racks-dialog-actions unit-form-wide">
          <button type="button" className="racks-btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="racks-btn racks-btn-primary" data-action="confirm-add-unit" disabled={busy || invalid}>{busy ? "Adding…" : `Add to ${where}`}</button>
        </div>
      </form>
    </section>
  </div>;
}
