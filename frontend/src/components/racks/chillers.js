// Cooling units (chillers.json): pure helpers for the Racks page. A unit is { id, name, rack, u } plus any extra
// fields another client saved; rack null = not in any rack, u null = in the rack but not on a floor (rack level).
// A rack has floors 1-RACK_FLOORS (floors.js); Main storage has numbered shelves. A saved u above the rack's floors
// (old data, e.g. 17) is kept as it is and drawn under the rack card's "Other" line, never moved without a choice.
// Cooling units are never deleted here: there is no delete helper, and assertKeepsUnits refuses an edit that drops one.
import { RACK_FLOORS, rackHasFloors, validFloor } from "./floors.js";

export const COOLING_DELETE_ERROR = "Cooling units cannot be deleted. Move the unit to another rack or leave it unassigned instead.";

const isObject = value => value != null && typeof value === "object" && !Array.isArray(value);

// A numbered place (U) a unit can be saved on: a whole number from 1 to 42 (a string, 0 or 99 is not one). In a rack
// only floors 1-RACK_FLOORS are offered (validPlace); a higher U is old data, shown as it is.
export const MAX_SHELF = 42;
export function validShelf(u) {
  return Number.isInteger(u) && u >= 1 && u <= MAX_SHELF;
}

// A place the cooling dialog offers in that rack: a floor (1-RACK_FLOORS), or a shelf 1-42 in Main storage.
export function validPlace(u, rack) {
  return rackHasFloors(rack) ? validFloor(u) : validShelf(u);
}

// "floor" in a rack, "shelf" in Main storage.
export const placeWord = rack => (rackHasFloors(rack) ? "floor" : "shelf");

export function normalizeChillers(doc) {
  const base = isObject(doc) ? doc : {};
  return {
    ...base,
    units: Array.isArray(base.units) ? [...base.units] : [],
    connections: Array.isArray(base.connections) ? base.connections : [],
  };
}

// byRack: every known rack gets { placed: { [u]: Unit[] }, unplaced: Unit[] }; units whose rack is missing or not
// one of rackNames are listed in unassigned with the reason.
export function groupChillers(units, rackNames) {
  const byRack = {};
  const known = new Set(rackNames || []);
  for (const rack of known) byRack[rack] = { placed: {}, unplaced: [] };
  const unassigned = [];
  for (const unit of units || []) {
    if (!isObject(unit)) continue;
    const rack = unit.rack ?? null;
    if (rack === null || rack === "") { unassigned.push({ unit, reason: "no-rack" }); continue; }
    if (!known.has(rack)) { unassigned.push({ unit, reason: "rack-not-found" }); continue; }
    const group = byRack[rack];
    if (validShelf(unit.u)) (group.placed[unit.u] ||= []).push(unit);
    else group.unplaced.push(unit);
  }
  return { byRack, unassigned };
}

// Changes only the unit with that id (name, rack, u); everything else in the document is kept as it is.
export function updateChiller(doc, id, changes) {
  const base = normalizeChillers(doc);
  const at = base.units.findIndex(unit => isObject(unit) && unit.id === id);
  if (at < 0) return doc;
  const next = { ...base.units[at] };
  if ("name" in changes) next.name = changes.name;
  if ("rack" in changes) next.rack = changes.rack === "" || changes.rack === undefined ? null : changes.rack;
  if ("u" in changes) next.u = changes.u === "" || changes.u === undefined ? null : changes.u;
  if (next.rack == null) { next.rack = null; next.u = null; }
  const units = [...base.units];
  units[at] = next;
  return { ...base, units };
}

export function placeChiller(doc, id, rack, u) {
  return updateChiller(doc, id, { rack, u });
}

// The id is made by the caller (newChillerId) before the save, so a retried save cannot add the unit twice.
export function addChiller(doc, unit) {
  const base = normalizeChillers(doc);
  if (!unit?.id || base.units.some(existing => isObject(existing) && existing.id === unit.id)) return doc;
  const rack = unit.rack === "" || unit.rack === undefined ? null : unit.rack;
  return { ...base, units: [...base.units, { id: unit.id, name: unit.name, rack, u: rack === null ? null : unit.u ?? null }] };
}

export function newChillerId() {
  return `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

export function assertKeepsUnits(before, after) {
  const kept = new Set((normalizeChillers(after).units).filter(isObject).map(unit => unit.id));
  for (const unit of normalizeChillers(before).units) {
    if (isObject(unit) && unit.id != null && !kept.has(unit.id)) throw new Error(COOLING_DELETE_ERROR);
  }
}

export const shelfLabel = u => `U${String(u).padStart(2, "0")}`;

// A cooling unit's numbered place as the rack card numbers it: "Floor 2" (floors 1-RACK_FLOORS), "U17" above them
// (the card's "Other" line), "Shelf 7" in Main storage.
export function floorLabel(u, rack) {
  if (!rackHasFloors(rack)) return `Shelf ${u}`;
  return validFloor(u) ? `Floor ${u}` : `U${u}`;
}

export function describePlace(unit) {
  const rack = unit?.rack ?? null;
  if (rack === null || rack === "") return "No rack";
  return validShelf(unit.u) ? `${rack} · ${floorLabel(unit.u, rack)}` : `${rack} · not on a ${placeWord(rack)}`;
}

// The floor part of a unit's place, as the dialog shows it: "Floor 3", "Not on a floor", "U17 (not one of floors
// 1-4)" or "Invalid floor "x"" (Main storage: "Shelf 7", "Not on a shelf", …).
export function describeFloor(unit) {
  const rack = unit?.rack ?? null, word = placeWord(rack);
  if (validPlace(unit?.u, rack)) return floorLabel(unit.u, rack);
  if (validShelf(unit?.u)) return `${floorLabel(unit.u, rack)} (not one of floors 1–${RACK_FLOORS})`;
  if (unit?.u == null || unit?.u === "") return `Not on a ${word}`;
  return `Invalid ${word} "${String(unit.u)}"`;
}

// One cooling change, kept so it can be undone: before/after are { name, rack, u }.
export function coolingChange(unit, after) {
  const before = { name: unit.name, rack: unit.rack ?? null, u: validShelf(unit.u) ? unit.u : unit.u ?? null };
  const next = { name: after.name ?? before.name, rack: after.rack ?? null, u: after.rack == null ? null : after.u ?? null };
  return { unitId: unit.id, name: next.name, before, after: next };
}

// Undo of one change: refused (nothing changed) when the unit was changed again since, by anyone.
export function undoCoolingChange(doc, change) {
  const unit = normalizeChillers(doc).units.find(x => isObject(x) && x.id === change.unitId);
  if (!unit || (unit.rack ?? null) !== change.after.rack || (unit.u ?? null) !== change.after.u || unit.name !== change.after.name) {
    throw new Error(`${change.name} was changed in another session after your change; nothing was undone.`);
  }
  return updateChiller(doc, change.unitId, change.before);
}

// Two cooling documents are the same when they hold the same data (key order does not matter).
export function sameDocument(a, b) {
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
    : JSON.stringify(value ?? null);
  return canonical(normalizeChillers(a)) === canonical(normalizeChillers(b));
}

// What changed between two lists of unit places ({ id, name, rack, u }, as the history lists them), unit by unit:
// { id, name, from, to, renamedFrom } where from/to are describePlace texts (from null = added, to null = left out).
export function placeChanges(before, after) {
  const byId = list => new Map((list || []).filter(p => isObject(p) && p.id != null).map(p => [p.id, p]));
  const a = byId(before), b = byId(after);
  const shelf = p => (validShelf(p.u) ? p.u : null);
  const out = [];
  for (const [id, p] of a) {
    const q = b.get(id);
    if (!q) { out.push({ id, name: p.name || id, from: describePlace(p), to: null, renamedFrom: null }); continue; }
    const renamed = (p.name || "") !== (q.name || "");
    if (renamed || (p.rack ?? null) !== (q.rack ?? null) || shelf(p) !== shelf(q)) {
      out.push({ id, name: q.name || id, from: describePlace(p), to: describePlace(q), renamedFrom: renamed ? (p.name || id) : null });
    }
  }
  for (const [id, q] of b) if (!a.has(id)) out.push({ id, name: q.name || id, from: null, to: describePlace(q), renamedFrom: null });
  return out;
}
