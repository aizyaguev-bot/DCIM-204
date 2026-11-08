// One-step "scan a unit onto a server's floor": look the scanned code up, then move the unit that already has it, or
// register a new one there. The server refuses a second unit with the same barcode or serial (409), so a repeated or
// concurrent scan can never add a second row; that 409 (or a stale revision) is retried once, and the retry finds the
// unit and moves or confirms it. Undo is guarded: it only reverts what this scan did, and only while the unit's whole
// record is still exactly what the scan saved; any later change (by anyone) is kept and Undo says so.
// The serial number, part number, model and MAC the barcode carries are saved as the unit's own fields: on a new unit
// all of them, on a known unit only those it does not have yet (a stored value is never overwritten). A label whose
// serial number or MAC address contradicts the unit it found is refused, like a code that matches two units.
import { MAIN_STORAGE, loadInventory, updateInventory, loadRackItems, saveRackItems, UNIT_DETAIL_FIELDS, UNIT_DETAIL_LIMITS, normalizeMac, detailText } from "./inventory.js";
import { floorsFor, rackHasFloors } from "../components/racks/floors.js";
import { GENERIC_UNIT_NAME, isGenericUnit, serialUnitType, unitTypeLabel } from "./scanParse.js";

export function placeOf(item) {
  return { rack: item.rack, u: item.u, position: item.shelf_position || "" };
}

export function samePlace(a, b) {
  return !!a && !!b && a.rack === b.rack && a.u === b.u && (a.position || "") === (b.position || "");
}

// "floor 2", "rack level", "U7" in a rack (no rack given: a rack); "shelf 7" or "whole storage" in Main storage.
export function floorText(u, rack = null) {
  if (!rackHasFloors(rack)) return Number.isInteger(u) && u > 0 ? `shelf ${u}` : "whole storage";
  if (!Number.isInteger(u) || u === 0) return "rack level";
  return u <= floorsFor(rack) ? `floor ${u}` : `U${u}`;
}

// "OPT12 · floor 2", "Rack-01 · rack level"; Main storage: "Main storage · shelf 7", or "Main storage" (the whole unit).
export function placeText(place, label = "") {
  if (!place?.rack) return "no rack";
  if (place.rack === MAIN_STORAGE) return Number.isInteger(place.u) && place.u > 0 ? `Main storage · ${floorText(place.u, place.rack)}` : "Main storage";
  return `${label || place.rack} · ${floorText(place.u)}`;
}

function failure(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// The unit fields a parsed barcode carries, by stored name: { serial_number, part_number, model, mac }, only the
// non-empty ones. A MAC the server would refuse (not six hex pairs) and an over-long value are left out, so they can
// never make the scan itself fail.
export function scanDetails(parsed) {
  const values = { serial_number: parsed?.serial, part_number: parsed?.part_number, model: parsed?.model, mac: normalizeMac(parsed?.mac || "") };
  return Object.fromEntries(Object.entries(values)
    .map(([field, value]) => [field, String(value || "").trim()])
    .filter(([field, value]) => value && Array.from(value).length <= UNIT_DETAIL_LIMITS[field]));
}

const missing = (item, field) => !detailText(item, field).trim();

// A known unit: fill only the fields it does not have yet (the server checks again with only_missing). Resolves to
// { item, filled: { field: value }, fillError? }; a refused fill never undoes the move, it is reported instead.
async function fillMissing(item, parsed, revision) {
  const wanted = Object.fromEntries(Object.entries(scanDetails(claimsFor(item, parsed))).filter(([field]) => missing(item, field)));
  if (!Object.keys(wanted).length) return { item, filled: {} };
  try {
    const saved = await updateInventory(`/${encodeURIComponent(item.id)}/details`, { ...wanted, only_missing: true }, revision);
    const filled = Object.fromEntries(UNIT_DETAIL_FIELDS.filter(f => missing(item, f) && !missing(saved.data, f)).map(f => [f, saved.data[f]]));
    return { ...await markAsSwitch(item, saved.data, filled), filled };
  } catch (error) {
    return { item, filled: {}, fillError: error?.message || "The unit's details could not be saved." };
  }
}

// The scan just gave a generic unit (a legacy barcode-only unit: type other, named "Unit" or after its code) its serial
// number: by the lab owner's rule (serialUnitType, as for a new unit) it is marked as a switch, and "Unit" is renamed
// "Switch". One guarded save of the equipment list (If-Match); when the unit changed meanwhile, or the save is refused,
// the unit is left as the scan saved it. retyped: its type and name before, for Undo.
async function markAsSwitch(before, after, filled) {
  if (!filled.serial_number || !isGenericUnit(before) || serialUnitType({ part_number: after.part_number, model: after.model }) !== "switch") return { item: after };
  try {
    const items = await loadRackItems();
    const rack = Object.keys(items).find(r => items[r].some(i => i.id === after.id));
    const current = rack && items[rack].find(i => i.id === after.id);
    if (!current || !isGenericUnit({ ...current, serial_number: "" }) || current.serial_number !== filled.serial_number) return { item: after };
    const renamed = String(current.name || "").trim().toLowerCase() === GENERIC_UNIT_NAME.toLowerCase();
    const next = { ...current, type: "switch", ...(renamed ? { name: unitTypeLabel("switch") } : {}) };
    const saved = await saveRackItems({ ...items, [rack]: items[rack].map(i => (i.id === current.id ? next : i)) }, items, { alert: false, alertDuplicates: false });
    const stored = saved?.[rack]?.find(i => i.id === current.id);
    return stored ? { item: { ...stored, rack }, retyped: { type: current.type || "other", name: current.name } } : { item: after };
  } catch {
    return { item: after };
  }
}

export const LOOKUP_ATTEMPTS = 3;

// Each key (code, raw text, serial, MAC) is one GET. The matches are only combined when every GET answered from the same
// inventory revision, and that revision is the one the following save sends as If-Match; if another session wrote in
// between, the whole lookup is done again (at most LOOKUP_ATTEMPTS times).
async function lookUp(parsed) {
  const keys = [...new Map([parsed.code, parsed.raw, parsed.serial, parsed.mac].filter(Boolean).map(k => [k.toLowerCase(), k])).values()];
  for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt++) {
    const found = new Map();
    const revisions = new Set();
    let snapshot = null;
    for (const key of keys) {
      snapshot = await loadInventory(key);
      revisions.add(snapshot.revision);
      if (revisions.size > 1) break;
      for (const match of snapshot.data.matches) found.set(match.id, match);
    }
    if (revisions.size === 1) return { matches: [...found.values()], revision: snapshot.revision, racks: snapshot.data.racks || [] };
  }
  throw failure("The inventory kept changing in another session while this code was looked up, so nothing was changed. Scan the unit again.");
}

// The server's identity rule: a value that reads as a MAC address is that MAC in any spelling, anything else ignores case.
const identityOf = value => { const text = String(value || "").trim(); return normalizeMac(text) || text.toLowerCase(); };
const sameText = (a, b) => identityOf(a) === identityOf(b);

// What the scan says about the unit it found. A plain code is taken as the unit's serial number (parseUnitBarcode
// serial_from_code), but when the unit was found by that code as its barcode or its id, the code is that barcode or id:
// it is a serial only for a unit that has no serial yet and was found by its barcode (it is filled in then); a unit that
// already has another serial keeps it without a conflict, and an id is never taken as a serial.
export function claimsFor(item, parsed) {
  if (!parsed?.serial_from_code || !sameText(parsed.serial, parsed.code)) return parsed;
  const byId = sameText(parsed.code, item?.id), byBarcode = sameText(parsed.code, detailText(item, "barcode"));
  const stored = detailText(item, "serial_number").trim();
  if (byId || (byBarcode && stored && !sameText(stored, parsed.serial))) return { ...parsed, serial: "", serial_from_code: false };
  return parsed;
}

// The label's serial number or MAC address against the unit it found: a value on both that differs means the label
// belongs to another unit (or the record is wrong). Returns a refusal Error, or null.
export function identityConflict(item, scanned) {
  const parsed = claimsFor(item, scanned);
  const name = item.name || item.id;
  const serial = String(parsed?.serial || "").trim(), stored = detailText(item, "serial_number").trim();
  if (serial && stored && !sameText(serial, stored)) {
    return failure(`This label's serial number (${serial}) does not match ${name}'s (${stored}). Nothing was changed. Check the label, or correct the unit's serial number first.`, { matches: [item], conflict: "serial_number" });
  }
  const mac = normalizeMac(parsed?.mac || ""), storedMac = detailText(item, "mac").trim();
  if (mac && storedMac && mac !== (normalizeMac(storedMac) || storedMac.toUpperCase())) {
    return failure(`This label's MAC address (${mac}) does not match ${name}'s (${storedMac}). Nothing was changed. Check the label, or correct the unit's MAC address first.`, { matches: [item], conflict: "mac" });
  }
  return null;
}

async function placeOnce(parsed, target) {
  const { matches, revision, racks } = await lookUp(parsed);
  if (!racks.includes(target.rack)) throw failure("This rack is not in the inventory. Add it in DCIM first.");
  if (matches.length > 1) {
    throw failure(`This barcode matches ${matches.length} units, so nothing was changed. Open each unit and fix its barcode or serial number.`, { matches, ambiguous: true });
  }
  if (matches.length === 1) {
    const item = matches[0];
    const conflict = identityConflict(item, parsed);
    if (conflict) throw conflict;
    const before = placeOf(item);
    if (samePlace(before, target)) return { action: "confirmed", before, after: target, ...await fillMissing(item, parsed, revision) };
    const saved = await updateInventory(`/${encodeURIComponent(item.id)}/location`, target, revision);
    return { action: "moved", before, after: target, ...await fillMissing(saved.data, parsed, saved.revision) };
  }
  const saved = await updateInventory("", { code: parsed.code, name: parsed.name, type: parsed.type, ...scanDetails(parsed), ...target }, revision);
  return { action: "created", item: saved.data, before: null, after: target, filled: {} };
}

// target: { rack, u, position }. Resolves to { action: "created" | "moved" | "confirmed", item, before, after, filled,
// fillError? }; filled: the fields this scan added to a known unit ({} for a new unit, which got them on create).
export async function placeScannedUnit(parsed, target) {
  const place = { rack: target.rack, u: target.u, position: target.position || "" };
  try {
    return await placeOnce(parsed, place);
  } catch (error) {
    // Another session wrote first (stale revision), or registered this code a moment ago: look again, once.
    if (error.status !== 409 || error.ambiguous || error.conflict) throw error;
    return placeOnce(parsed, place);
  }
}

export function filledFields(result) {
  return Object.keys(result?.filled || {});
}

export function canUndo(result) {
  return result?.action === "created" || (result?.action === "moved" && Number.isInteger(result.before?.u) && !!result.before.rack)
    || (result?.action === "confirmed" && filledFields(result).length > 0);
}

const CHANGED = "Someone else changed the unit after the scan, so the scan was not undone and the unit was left as it is. Open the unit to review it.";

// A record as JSON with its keys in a fixed order, without "rack" (the list it is in, compared as its place).
function recordText(record) {
  const order = value => (Array.isArray(value) ? value.map(order)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])])) : value);
  const { rack: _rack, ...rest } = record || {};
  return JSON.stringify(order(rest));
}

// True while the unit is exactly what this scan saved: the same place and every field (name, type, notes, barcode,
// serial number, part number, model, MAC, history ...) unchanged.
export function untouchedSinceScan(current, rack, result) {
  return !!current && samePlace(placeOf({ ...current, rack }), result.after) && recordText(current) === recordText(result.item);
}

function findIn(items, id) {
  const rack = Object.keys(items).find(r => items[r].some(i => i.id === id));
  return rack ? { rack, item: items[rack].find(i => i.id === id) } : null;
}

// Resolves to the saved equipment list when it removed a created unit (DCIM keeps it as its new revision), else null.
export async function undoScannedUnit(result) {
  if (!canUndo(result)) throw failure("This scan cannot be undone.");
  const id = result.item.id;
  if (result.action === "created") {
    const items = await loadRackItems();
    const found = findIn(items, id);
    if (!found) throw failure("The unit was already removed. Nothing was undone.");
    const { rack, item } = found;
    const history = item.tracking_history || [];
    const untouched = untouchedSinceScan(item, rack, result) && history.length === 1 && history[0].action === "registered";
    if (!untouched) throw failure(CHANGED);
    return saveRackItems({ ...items, [rack]: items[rack].filter(i => i.id !== id) }, items, { alert: false });
  }
  const filled = filledFields(result);
  if (filled.length) {
    // One save puts the unit back where it was and removes exactly the fields this scan added, or changes nothing.
    const items = await loadRackItems();
    const found = findIn(items, id);
    if (!found) throw failure("The unit no longer exists. Nothing was undone.");
    const { rack, item } = found;
    if (!untouchedSinceScan(item, rack, result) || filled.some(f => item[f] !== result.filled[f])) throw failure(CHANGED);
    const restored = { ...item, u: result.before.u, shelf_position: result.before.position || "" };
    for (const field of filled) delete restored[field];
    if (result.retyped) Object.assign(restored, result.retyped);   // marked as a switch by the scan: back to what it was
    const next = { ...items };
    if (rack === result.before.rack) next[rack] = items[rack].map(i => (i.id === id ? restored : i));
    else {
      next[rack] = items[rack].filter(i => i.id !== id);
      next[result.before.rack] = [...(items[result.before.rack] || []), restored];
    }
    return saveRackItems(next, items, { alert: false });
  }
  const { data, revision } = await loadInventory(id);
  const current = data.matches.find(m => m.id === id);
  if (!current) throw failure("The unit no longer exists. Nothing was undone.");
  if (!untouchedSinceScan(current, current.rack, result)) throw failure(CHANGED);
  await updateInventory(`/${encodeURIComponent(id)}/location`, result.before, revision);
  return null;
}
