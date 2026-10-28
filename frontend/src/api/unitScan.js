// One-step "scan a unit onto a server's floor": look the scanned code up, then move the unit that already has it, or
// register a new one there. The server refuses a second unit with the same barcode or serial (409), so a repeated or
// concurrent scan can never add a second row; that 409 (or a stale revision) is retried once, and the retry finds the
// unit and moves or confirms it. Undo is guarded: it only reverts what this scan did, never a later change.
import { MAIN_STORAGE, loadInventory, updateInventory, loadRackItems, saveRackItems } from "./inventory.js";
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
    if (samePlace(before, target)) return { action: "confirmed", item, before, after: target };
    const saved = await updateInventory(`/${encodeURIComponent(item.id)}/location`, target, revision);
    return { action: "moved", item: saved.data, before, after: target };
  }
  const saved = await updateInventory("", { code: parsed.code, name: parsed.name, type: parsed.type, ...target }, revision);
  return { action: "created", item: saved.data, before: null, after: target };
}

// target: { rack, u, position }. Resolves to { action: "created" | "moved" | "confirmed", item, before, after }.
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

export function canUndo(result) {
  return result?.action === "created" || (result?.action === "moved" && Number.isInteger(result.before?.u) && !!result.before.rack);
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
      && (item.barcode || "") === (result.item.barcode || "");
    if (!untouched) throw failure(CHANGED);
    return saveRackItems({ ...items, [rack]: items[rack].filter(i => i.id !== id) }, items, { alert: false });
  }
  const { data, revision } = await loadInventory(id);
  const current = data.matches.find(m => m.id === id);
  if (!current) throw failure("The unit no longer exists. Nothing was undone.");
  if (!samePlace(placeOf(current), result.after)) throw failure(CHANGED);
  await updateInventory(`/${encodeURIComponent(id)}/location`, result.before, revision);
  return null;
}
