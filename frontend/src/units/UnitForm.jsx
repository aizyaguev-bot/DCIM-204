// The unit window's form and read-only details (one-place spec v2 §W.4): copies of DcimView's EditEquipmentPanel (the
// fields, the serial-number switch rule, the duplicate serial / MAC refusal at its field) and ReadOnlyAsset, for a
// window. The form saves only the fields edited here, with an explicit Save: PUT /api/rack-items with If-Match = the
// ETag of the list the window shows, so a change saved elsewhere since is refused (409) and nothing is overwritten.
// Fields not edited follow the saved unit live (draft and base).
import { useRef, useState } from "react";
import { UNIT_DETAILS, detailText, unitDetailChanges } from "../api/inventory.js";
import { GENERIC_UNIT_NAME, isGenericUnit, serialUnitType, unitTypeLabel } from "../api/scanParse.js";
import { STORAGE_SHELVES, rackHasFloors } from "../components/racks/floors.js";
import { formatTime } from "../window/format.js";
import { restoreEntry } from "./deletedList.js";
import { ownerFromText } from "../unitOwner.js";
import { UNIT_TYPES, editUnit, unitPlace, unitTypeText, daysSince } from "./unitModel.js";
import "./units.css";

// A U slot an operator may enter for equipment: a whole number from 0 (whole rack) to 42 (DcimView parseUSlot).
export const U_SLOT_ERROR = "U slot must be a whole number from 0 to 42.";
export function parseUSlot(text) {
  const value = String(text ?? "").trim();
  return /^\d{1,2}$/.test(value) && Number(value) <= 42 ? Number(value) : null;
}

// A storage rack's place choices: the whole unit (0) or a shelf 1-STORAGE_SHELVES; a saved value outside them (old data)
// is offered as its own choice, so opening the form never changes it (DcimView storageShelfOptions).
export function storageShelfOptions(current = "0") {
  const options = [{ value: "0", label: "Whole storage unit (no shelf)" }];
  for (let u = 1; u <= STORAGE_SHELVES; u++) options.push({ value: String(u), label: `Shelf ${u}` });
  const value = String(current ?? "0");
  if (!options.some(o => o.value === value)) options.push({ value, label: `${/^\d+$/.test(value) ? `Shelf ${value}` : `"${value}"`} · saved, not one of shelves 1–${STORAGE_SHELVES}` });
  return options;
}

// The server's refusal of a serial number or MAC address that already names another unit (inventory_store.py).
const DUPLICATE_IDENTITY = /already belongs to another item\.$/;

// PUT /api/rack-items with If-Match. Resolves to { data, etag }; a refusal throws Error with status, and duplicate
// (a serial number, barcode or MAC address another unit has) or stale (another session saved the list since).
export async function putRackItems(doc, etag) {
  const response = await fetch("/api/rack-items", {
    method: "PUT", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
    body: JSON.stringify(doc),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body.detail === "string" ? body.detail
      : Array.isArray(body.detail) ? body.detail.map(e => e?.msg).filter(Boolean).join("; ") : "";
    const error = new Error(detail || `The equipment list was not saved (HTTP ${response.status}).`);
    error.status = response.status;
    error.duplicate = response.status === 409 && DUPLICATE_IDENTITY.test(detail);
    error.stale = (response.status === 409 && !error.duplicate) || response.status === 428;
    throw error;
  }
  return { data: body, etag: response.headers.get("ETag") };
}

export const STALE_TEXT = "Equipment changed in another session, so nothing was saved. The window shows the saved values now with your edits kept; check them and save again.";

// The unit field a duplicate refusal is about: "mac", "barcode" (the barcode was typed here and the serial number was
// not) or "serial_number" (a barcode / serial clash).
const duplicateField = (error, changes = {}) => (!error?.duplicate ? "" : /MAC address/.test(error.message) ? "mac"
  : "barcode" in changes && !("serial_number" in changes) ? "barcode" : "serial_number");

// The editable unit (Operator). props: item and rack (the saved unit, latest), data (the window's lab data: rackItems
// and its ETag), act (the window's actions), busyRef (the window waits for a running save before it closes).
export function UnitForm({ item, rack, data, act, busyRef, dirtyRef }) {
  // Only the fields edited here are in the draft; every other field shows the saved unit as it is now.
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  const [error, setError] = useState("");
  // A serial number or MAC address that already names another unit: the server's reason, shown at that field.
  const [taken, setTaken] = useState(null);
  const baseRef = useRef(null);   // the saved unit when the first field was edited (to say it changed since)
  const edit = (field, value) => {
    if (!Object.keys(draft).length) baseRef.current = JSON.stringify(item);
    setSaved(false); setUnchanged(false); setError("");
    setDraft(d => ({ ...d, [field]: value }));
  };

  const name = draft.name ?? (item.name || "");
  const type = draft.type ?? (item.type || "other");
  const u = draft.u ?? String(item.u ?? 0);
  const notes = draft.notes ?? (item.notes || "");
  // A linked barcode never changes (the backend keeps it); a unit with none can be given one here. The shelf position is
  // free text. Both are saved only when edited here.
  const linked = !!String(item.barcode || "").trim();
  const barcode = draft.barcode ?? (item.barcode || "");
  const position = draft.shelf_position ?? (item.shelf_position || "");
  const details = Object.fromEntries(UNIT_DETAILS.map(([field]) => [field, draft[field] ?? detailText(item, field)]));
  const storage = !rackHasFloors(rack);
  const slot = parseUSlot(u);
  const uChanged = u.trim() !== String(item.u ?? 0);
  const uError = uChanged && slot === null ? U_SLOT_ERROR : "";
  // The lab owner's rule, as a scan applies it (serialUnitType): a serial number entered for a generic unit that has
  // none yet marks it as a switch, unless its part number or model names another product. A type chosen here never
  // changes.
  const autoSwitch = !("type" in draft) && isGenericUnit(item) && !detailText(item, "serial_number").trim() && details.serial_number.trim() !== ""
    && serialUnitType({ part_number: details.part_number, model: details.model, code: [details.serial_number, item.barcode].filter(Boolean).join(" ") }) === "switch";
  const shownType = autoSwitch ? "switch" : type;
  const shownName = autoSwitch && !("name" in draft) && String(item.name || "").trim().toLowerCase() === GENERIC_UNIT_NAME.toLowerCase() ? unitTypeLabel("switch") : name;
  const changes = {};
  if (shownName.trim() && shownName.trim() !== item.name) changes.name = shownName.trim();
  if (shownType !== (item.type || "other")) changes.type = shownType;
  if (uChanged && slot !== null && slot !== (item.u ?? 0)) changes.u = slot;
  if (notes.trim() !== (item.notes || "")) changes.notes = notes.trim();
  if (!linked && "barcode" in draft && barcode.trim() && barcode.trim() !== (item.barcode || "")) changes.barcode = barcode.trim();
  if ("shelf_position" in draft && position.trim() !== (item.shelf_position || "")) changes.shelf_position = position.trim();
  const { changes: detailChanges, errors: detailErrors } = unitDetailChanges(item, details);
  Object.assign(changes, detailChanges);
  if (taken && details[taken.field] === taken.value) detailErrors[taken.field] = detailErrors[taken.field] || taken.message;
  const barcodeError = taken?.field === "barcode" && barcode === taken.value ? taken.message : "";
  const detailError = Object.keys(detailErrors).length > 0 || !!barcodeError;
  const dirty = Object.keys(changes).length > 0;
  if (dirtyRef) dirtyRef.current = dirty;   // the window asks before "Open <server>" drops these edits
  const changedSince = dirty && baseRef.current != null && baseRef.current !== JSON.stringify(item);
  const ready = data.rackItems != null && !!data.etags?.rackItems;

  async function submit(e) {
    e?.preventDefault();
    if (busy || uError || detailError || !shownName.trim()) return;
    if (!dirty) { setUnchanged(true); return; }
    if (!ready) { setError("The equipment list is still loading. Try again in a moment."); return; }
    setBusy(true); if (busyRef) busyRef.current = true;
    setUnchanged(false); setError("");
    try {
      await act.during(() => putRackItems(editUnit(data.rackItems, item.id, changes), data.etags.rackItems));
      await act.reload(["inventory"]);
      setDraft({}); baseRef.current = null; setTaken(null); setSaved(true);
      act.toast(`Saved ${changes.name || item.name}.`);
    } catch (err) {
      const field = duplicateField(err, changes);
      if (field) {
        setTaken({ field, value: field === "barcode" ? barcode : details[field], message: err.message });
        requestAnimationFrame(() => document.querySelector(`[data-window="unit"] [data-detail="${field}"]`)?.focus());
      } else if (err.stale) {
        setError(STALE_TEXT);
        await act.reload(["inventory"]);
      } else setError(err.message || String(err));
    } finally {
      setBusy(false); if (busyRef) busyRef.current = false;
    }
  }

  const fieldError = id => `unit-form-${id}-error`;
  return <form className="unit-form" onSubmit={submit} noValidate data-unit-form="">
    {changedSince && <p role="status" className="unit-form-note">This unit was changed in another session. The fields you did not edit show the saved values; check yours and save.</p>}
    <div className="racks-field">
      <label htmlFor="unit-form-name">Name</label>
      <input id="unit-form-name" dir="auto" value={shownName} maxLength={120} disabled={busy} autoComplete="off"
        onChange={e => edit("name", e.target.value)}/>
    </div>
    <div className="racks-field">
      <label htmlFor="unit-form-type">Type</label>
      <select id="unit-form-type" value={shownType} disabled={busy} onChange={e => edit("type", e.target.value)}
        aria-describedby={autoSwitch ? "unit-form-type-hint" : undefined}>
        {UNIT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {autoSwitch && <p id="unit-form-type-hint" className="racks-field-hint">Marked as a switch: a unit with a serial number and no other product is most likely a switch. Choose another type if it is not.</p>}
    </div>
    {storage ? <div className="racks-field">
      <label htmlFor="unit-form-u">Shelf</label>
      <select id="unit-form-u" value={u} disabled={busy} onChange={e => edit("u", e.target.value)}>
        {storageShelfOptions(u).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div> : <div className="racks-field">
      <label htmlFor="unit-form-u">U slot (0 = whole rack; floors 1–4)</label>
      <input id="unit-form-u" type="number" min="0" max="42" step="1" value={u} disabled={busy} onChange={e => edit("u", e.target.value)}
        aria-invalid={uError ? true : undefined} aria-describedby={uError ? fieldError("u") : undefined}/>
      {uError && <p id={fieldError("u")} role="alert" className="racks-field-error">{uError}</p>}
    </div>}
    {UNIT_DETAILS.map(([field, label]) => <div className="racks-field" key={field}>
      <label htmlFor={`unit-form-${field}`}>{label}</label>
      <input id={`unit-form-${field}`} value={details[field]} disabled={busy} spellCheck={false} autoComplete="off" data-detail={field} dir="auto"
        placeholder={field === "mac" ? "00:1A:2B:3C:4D:5E" : "Not recorded"}
        aria-invalid={detailErrors[field] ? true : undefined} aria-describedby={detailErrors[field] ? fieldError(field) : undefined}
        onChange={e => edit(field, e.target.value)}/>
      {detailErrors[field] && <p id={fieldError(field)} role="alert" className="racks-field-error">{detailErrors[field]}</p>}
    </div>)}
    <div className="racks-field unit-form-wide">
      <label htmlFor="unit-form-notes">Notes</label>
      <textarea id="unit-form-notes" className="unit-form-textarea" rows={2} dir="auto" value={notes} disabled={busy} onChange={e => edit("notes", e.target.value)}/>
    </div>
    <div className="racks-field">
      <label htmlFor="unit-form-barcode">Barcode</label>
      {linked ? <input id="unit-form-barcode" className="racks-mono" value={item.barcode} readOnly dir="auto" aria-describedby="unit-form-barcode-hint" data-barcode-linked=""/>
        : <input id="unit-form-barcode" value={barcode} maxLength={120} disabled={busy} spellCheck={false} autoComplete="off" data-detail="barcode" dir="auto"
          placeholder="Not linked" aria-invalid={barcodeError ? true : undefined} aria-describedby={barcodeError ? fieldError("barcode") : undefined}
          onChange={e => edit("barcode", e.target.value)}/>}
      {linked && <p id="unit-form-barcode-hint" className="racks-field-hint">Linked. A linked barcode does not change.</p>}
      {barcodeError && <p id={fieldError("barcode")} role="alert" className="racks-field-error">{barcodeError}</p>}
    </div>
    <div className="racks-field">
      <label htmlFor="unit-form-position">Shelf position</label>
      <input id="unit-form-position" value={position} maxLength={120} disabled={busy} autoComplete="off" dir="auto" placeholder="Not recorded"
        onChange={e => edit("shelf_position", e.target.value)}/>
    </div>
    {error && <p role="alert" dir="auto" className="unit-form-error unit-form-wide" data-unit-error="">{error}</p>}
    <div className="unit-form-actions unit-form-wide">
      <button type="submit" className="lab-window-btn" data-tone="accent" data-action="save-unit" disabled={busy || !shownName.trim() || !!uError || detailError}>
        {busy ? "Saving…" : "Save"}</button>
      {dirty && !busy && <button type="button" className="lab-window-btn" onClick={() => { setDraft({}); baseRef.current = null; setTaken(null); setError(""); }}>Reset</button>}
      {saved && !dirty && <span role="status" className="lab-window-muted">Saved</span>}
      {unchanged && !dirty && <span role="status" className="lab-window-muted">No changes to save.</span>}
    </div>
  </form>;
}

// What a unit or cooling window shows once its item is gone (v2 §W.1). deleted: [found, refresh, read] of
// useDeletedEntry, which the window calls itself so its title names the deleted item. While the Deleted list is read:
// a short wait. In it: "Deleted <when> by <who>" with Restore (per role: canRestore). Not in it: `fallback` and a search
// over `choices` ([{ id, name, place, text }]: the items of that kind now), whose hit opens with onOpen(id).
export function DeletedNotice({ deleted, canRestore, act, fallback, noun, choices = [], onOpen }) {
  const [found, refresh, read] = deleted;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  if (!found && !read) return <p role="status" className="lab-window-muted">Looking for it…</p>;
  if (!found) {
    const words = q.trim().toLowerCase();
    const hits = words ? choices.filter(c => `${c.name || ""} ${c.id} ${c.text || ""}`.toLowerCase().includes(words)).slice(0, 8) : [];
    return <div>
      <p role="status" dir="auto">{fallback}</p>
      <label className="lab-window-muted block mt-3" htmlFor="gone-window-find">Find a {noun}</label>
      <input id="gone-window-find" className="lab-window-search mt-1" value={q} dir="auto" onChange={e => setQ(e.target.value)}
        placeholder="Name, serial number or id" autoComplete="off" spellCheck={false}/>
      {hits.length > 0 && <ul className="lab-window-results">{hits.map(c => <li key={c.id}>
        <button type="button" className="lab-window-link" onClick={() => onOpen(String(c.id))}><bdi>{c.name || c.id}</bdi></button>
        {c.place ? <span className="lab-window-muted" dir="auto"> · {c.place}</span> : null}
      </li>)}</ul>}
      {words && !hits.length && <p className="lab-window-muted mt-2">No {noun} matches.</p>}
    </div>;
  }
  const when = formatTime(found.batch.at);
  const name = found.entry.name || found.entry.id;
  async function restore() {
    setBusy(true); setError("");
    try {
      const result = await act.during(() => restoreEntry(found));
      if (!result.done) { setError(result.blockers.join(" ")); refresh(); return; }
      await act.reload();
      act.toast(`${name} is back.`);
    } catch (e) {
      setError(e.message || String(e));
      refresh();
    } finally { setBusy(false); }
  }
  return <div className="lab-window-banner" role="status" data-deleted-banner="">
    Deleted{when ? ` ${when}` : ""}{found.batch.by ? ` by ${found.batch.by}` : ""}.
    {canRestore && <button type="button" className="lab-window-btn ml-2" data-action="restore-deleted" disabled={busy} onClick={restore}>{busy ? "Restoring…" : "Restore"}</button>}
    {error && <p role="alert" dir="auto" className="unit-form-error">{error}</p>}
  </div>;
}

// The read-only details (Viewers; DcimView ReadOnlyAsset). owner / server: the unit's owner by the lab owner's rule.
export function UnitDetails({ item, rack, owner, server }) {
  const seen = daysSince(item.last_seen_at);
  const rows = [
    ["Type", unitTypeText(item.type)],
    ["Place", unitPlace(item, rack)],
    ["Serial number", item.serial_number], ["Part number", item.part_number], ["Model", item.model], ["MAC address", item.mac],
    ["Barcode", item.barcode], ["Position", item.shelf_position],
    ["Owner", server ? <span data-owner-from={server.name}>{owner || "No owner"}<span className="block lab-window-muted">{ownerFromText(server, !rackHasFloors(rack))}</span></span> : owner || "Owner not set"],
    ["Last seen", item.last_seen_at ? `${formatTime(item.last_seen_at).replace(/^on /, "")}${seen != null ? ` (${seen} ${seen === 1 ? "day" : "days"} ago)` : ""}` : null],
    ["Notes", item.notes],
  ].filter(([, value]) => value != null && value !== "");
  return <dl className="lab-window-dl" data-unit-details="">
    {rows.map(([key, value]) => <div key={key} className="unit-form-pair"><dt>{key}</dt><dd dir="auto">{value}</dd></div>)}
  </dl>;
}
