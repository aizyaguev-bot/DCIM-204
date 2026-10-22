// Cooling units (chillers.json): pure helpers for the Racks page. A unit is { id, name, rack, u } plus any extra
// fields another client saved; rack null = not in any rack, u null = in the rack but not on a shelf.
// Cooling units are never deleted here: there is no delete helper, and assertKeepsUnits refuses an edit that drops one.

export const COOLING_DELETE_ERROR = "Cooling units cannot be deleted. Move the unit to another rack or leave it unassigned instead.";

const isObject = value => value != null && typeof value === "object" && !Array.isArray(value);

// A shelf a unit can sit on: a whole number from 1 to 42 (a string, 0 or 99 is not a shelf).
export function validShelf(u) {
  return Number.isInteger(u) && u >= 1 && u <= 42;
}

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

export function describePlace(unit) {
  const rack = unit?.rack ?? null;
  if (rack === null || rack === "") return "No rack";
  return validShelf(unit.u) ? `${rack} · ${shelfLabel(unit.u)}` : `${rack} · not on a shelf`;
}

// The shelf part of a unit's place, as the dialog shows it: "U03", "Not on a shelf" or "Invalid shelf "x"".
export function describeShelf(unit) {
  if (validShelf(unit?.u)) return shelfLabel(unit.u);
  if (unit?.u == null || unit?.u === "") return "Not on a shelf";
  return `Invalid shelf "${String(unit.u)}"`;
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
