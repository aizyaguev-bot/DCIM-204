// One-step "scan a unit onto a server's floor": look the scanned code up, then move the unit that already has it, or
// register a new one there. The server refuses a second unit with the same barcode or serial (409), so a repeated or
// concurrent scan can never add a second row; that 409 (or a stale revision) is retried once, and the retry finds the
// unit and moves or confirms it. Undo is guarded: it only reverts what this scan did, never a later change.
// The serial number, part number, model and MAC the barcode carries are saved as the unit's own fields: on a new unit
// all of them, on a known unit only those it does not have yet (a stored value is never overwritten).
import { MAIN_STORAGE, loadInventory, updateInventory, loadRackItems, saveRackItems, UNIT_DETAIL_FIELDS, UNIT_DETAIL_LIMITS, normalizeMac, detailText } from "./inventory.js";
import { RACK_FLOORS } from "../components/racks/rackView.js";

export function placeOf(item) {
  return { rack: item.rack, u: item.u, position: item.shelf_position || "" };
}

export function samePlace(a, b) {
  return !!a && !!b && a.rack === b.rack && a.u === b.u && (a.position || "") === (b.position || "");
}

// "floor 2", "rack level", "U7"; Main storage is one place.
export function floorText(u) {
  if (!Number.isInteger(u) || u === 0) return "rack level";
  return u <= RACK_FLOORS ? `floor ${u}` : `U${u}`;
}

export function placeText(place, label = "") {
  if (!place?.rack) return "no rack";
  if (place.rack === MAIN_STORAGE) return "Main storage";
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
  const wanted = Object.fromEntries(Object.entries(scanDetails(parsed)).filter(([field]) => missing(item, field)));
  if (!Object.keys(wanted).length) return { item, filled: {} };
  try {
    const saved = await updateInventory(`/${encodeURIComponent(item.id)}/details`, { ...wanted, only_missing: true }, revision);
    const filled = Object.fromEntries(UNIT_DETAIL_FIELDS.filter(f => missing(item, f) && !missing(saved.data, f)).map(f => [f, saved.data[f]]));
    return { item: saved.data, filled };
  } catch (error) {
    return { item, filled: {}, fillError: error?.message || "The unit's details could not be saved." };
  }
}

async function lookUp(parsed) {
  const keys = [...new Map([parsed.code, parsed.raw, parsed.serial, parsed.mac].filter(Boolean).map(k => [k.toLowerCase(), k])).values()];
  const found = new Map();
  let snapshot = null;
  for (const key of keys) {
    snapshot = await loadInventory(key);
    for (const match of snapshot.data.matches) found.set(match.id, match);
  }
  return { matches: [...found.values()], revision: snapshot.revision, racks: snapshot.data.racks || [] };
}

async function placeOnce(parsed, target) {
  const { matches, revision, racks } = await lookUp(parsed);
  if (!racks.includes(target.rack)) throw failure("This rack is not in the inventory. Add it in DCIM first.");
  if (matches.length > 1) {
    throw failure(`This barcode matches ${matches.length} units, so nothing was changed. Open each unit and fix its barcode or serial number.`, { matches, ambiguous: true });
  }
  if (matches.length === 1) {
    const item = matches[0];
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
    if (error.status !== 409 || error.ambiguous) throw error;
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

const CHANGED = "The unit changed after the scan, so the scan was not undone. Open the unit to edit it.";

// Resolves to the saved equipment list when it removed a created unit (DCIM keeps it as its new revision), else null.
export async function undoScannedUnit(result) {
  if (!canUndo(result)) throw failure("This scan cannot be undone.");
  const id = result.item.id;
  if (result.action === "created") {
    const items = await loadRackItems();
    const rack = Object.keys(items).find(r => items[r].some(i => i.id === id));
    if (!rack) throw failure("The unit was already removed. Nothing was undone.");
    const item = items[rack].find(i => i.id === id);
    const history = item.tracking_history || [];
    const untouched = samePlace(placeOf({ ...item, rack }), result.after) && history.length === 1 && history[0].action === "registered"
      && (item.barcode || "") === (result.item.barcode || "") && UNIT_DETAIL_FIELDS.every(f => detailText(item, f) === detailText(result.item, f));
    if (!untouched) throw failure(CHANGED);
    return saveRackItems({ ...items, [rack]: items[rack].filter(i => i.id !== id) }, items, { alert: false });
  }
  const filled = filledFields(result);
  if (filled.length) {
    // One save puts the unit back where it was and removes exactly the fields this scan added, or changes nothing.
    const items = await loadRackItems();
    const rack = Object.keys(items).find(r => items[r].some(i => i.id === id));
    if (!rack) throw failure("The unit no longer exists. Nothing was undone.");
    const item = items[rack].find(i => i.id === id);
    if (!samePlace(placeOf({ ...item, rack }), result.after) || filled.some(f => item[f] !== result.filled[f])) throw failure(CHANGED);
    const restored = { ...item, u: result.before.u, shelf_position: result.before.position || "" };
    for (const field of filled) delete restored[field];
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
  if (!samePlace(placeOf(current), result.after)) throw failure(CHANGED);
  await updateInventory(`/${encodeURIComponent(id)}/location`, result.before, revision);
  return null;
}
