// The unit window's model (one-place spec v2 §W.4): finding a rack item, its place, its owner by the lab owner's rule,
// and the equipment-list edits its form, Move and Add unit make. Pure (no React, no DOM), so node --test imports it
// (__tests__/server-identity.test.js); units/UnitWindow.jsx, UnitForm.jsx, AddUnitDialog.jsx and the server window's
// Units section use it.
import { MAIN_STORAGE } from "../api/inventory.js";
import { floorsFor, placeWord, rackHasFloors, validFloor } from "../components/racks/floors.js";
import { itemOwnerKey } from "../unitOwner.js";
import { drawnOf } from "../server/serverRecord.js";
import { ownerOf } from "../server/ownerKey.js";
import { windowKey } from "../server/serverKey.js";

const asArray = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? "" : String(value).trim());

// The unit types (DcimView ITEM_TYPES, in its order): [value, label].
export const UNIT_TYPES = [["switch", "Switch"], ["computer", "Computer"], ["patchpanel", "Patch Panel"], ["cable", "Cable Mgmt"],
  ["pdu", "PDU"], ["kvm", "KVM"], ["ups", "UPS"], ["blank", "Blank Panel"], ["other", "Other"]];
export const unitTypeText = type => (UNIT_TYPES.find(([value]) => value === type) || UNIT_TYPES[UNIT_TYPES.length - 1])[1];

// { item, rack } of a rack item id in GET /api/rack-items ({ rack: [item] }), or null.
export function findUnit(rackItems, id) {
  for (const [rack, list] of Object.entries(rackItems && typeof rackItems === "object" ? rackItems : {})) {
    const item = asArray(list).find(u => u && String(u.id) === String(id));
    if (item) return { item, rack };
  }
  return null;
}

// A unit's floor as Racks draws it (serverMove.js unitFloor): a whole number 0-42, else 0 (the rack level).
export function unitU(item) {
  const n = typeof item?.u === "string" && item.u.trim() ? Number(item.u) : item?.u;
  return Number.isInteger(n) && n >= 0 && n <= 42 ? n : 0;
}

// "Rack-01 · floor 3", "Storage-Main · shelf 3", "Storage-Main", "Rack-01 · rack level", "Rack-01 · U 7".
export function unitPlace(item, rack) {
  const u = unitU(item);
  if (validFloor(u, rack)) return `${rack} · ${placeWord(rack)} ${u}`;
  if (u === 0) return rackHasFloors(rack) ? `${rack} · rack level` : rack;
  return `${rack} · U ${u}`;
}

// The server whose owner a unit on (rack, u) takes (unitOwner.js rule): the first server Racks draws on that floor or
// shelf (u 1 and up), never a removed one. Several servers on one floor: the first in the Racks order (buildRackRows,
// and the 3D twin): a server listed in rack_positions[rack] (`order`, GET /api/rack-positions) by its first listed DCIM
// id, before every unlisted one; the unlisted ones by name. /locations rows: { key, name, dcim_ids, drawn }. Returns
// { key, name, dcim_ids } or null.
export function floorServer(locations, rack, u, hidden = null, order = null) {
  if (!rack || !(Number.isInteger(u) && u >= 1)) return null;
  const listed = asArray(order?.[rack]);
  const rank = ids => ids.reduce((best, id) => { const i = listed.indexOf(id); return i !== -1 && i < best ? i : best; }, Infinity);
  let first = null;
  for (const row of asArray(locations?.servers)) {
    if (!row || row.removed === true) continue;
    const key = row.key || windowKey(row.name);
    if (!key || hidden?.has?.(key)) continue;
    const drawn = drawnOf(row);
    if (drawn && drawn.rack === rack && drawn.u === u) {
      const ids = asArray(row.dcim_ids).length ? row.dcim_ids.map(String) : [text(row.name).toLowerCase()].filter(Boolean);
      const next = { key, name: text(row.name) || key, dcim_ids: ids, rank: rank(ids) };
      if (!first || (next.rank !== first.rank ? next.rank < first.rank : next.name.localeCompare(first.name) < 0)) first = next;
    }
  }
  return first ? { key: first.key, name: first.name, dcim_ids: first.dcim_ids } : null;
}

// A unit's owner by the lab owner's rule: { owner, server }. server: the server on its floor it takes the owner from
// (then the owner is read-only in the unit's window); null: its own saved owner ("item:<id>"). rackOrder: the Racks
// order (useRackOrder) that picks the server on a shared floor.
export function unitOwner(item, rack, { locations, owners, hidden, rackOrder } = {}) {
  const server = floorServer(locations, rack, unitU(item), hidden, rackOrder);
  if (server) return { owner: ownerOf(server, owners).value, server };
  return { owner: text(owners?.[itemOwnerKey(item?.id)]), server: null };
}

// Whole days since an ISO time (or epoch seconds / ms); null when unknown.
export function daysSince(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 86400000)) : null;
}
export const NOT_SEEN_DAYS = 30;

// Every rack a unit can be on or moved to: the /locations racks, the equipment list's racks, every device's rack and
// Main storage; sorted, Main storage first.
export function rackChoices({ locations, rackItems, devices } = {}) {
  const names = new Set([MAIN_STORAGE]);
  for (const rack of asArray(locations?.racks)) if (text(rack)) names.add(String(rack));
  for (const rack of Object.keys(rackItems && typeof rackItems === "object" ? rackItems : {})) if (text(rack)) names.add(rack);
  for (const d of asArray(devices)) if (d && text(d.rack)) names.add(String(d.rack));
  const rest = [...names].filter(r => r !== MAIN_STORAGE).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [MAIN_STORAGE, ...rest];
}

// The places of a rack a unit can go to: [{ value, label }] — its floors (or a storage rack's shelves), then the rack
// level (a storage rack: the whole storage, no shelf), value "0".
export function placeChoices(rack) {
  const word = placeWord(rack);
  const out = [];
  for (let u = 1; u <= floorsFor(rack); u++) out.push({ value: String(u), label: `${word === "floor" ? "Floor" : "Shelf"} ${u}` });
  out.push({ value: "0", label: rackHasFloors(rack) ? "Rack level (no floor)" : "Whole storage (no shelf)" });
  return out;
}

// ── equipment-list edits (each returns a new document; the input is not changed) ──

// The unit with these fields changed, where it is.
export function editUnit(doc, id, changes) {
  const found = findUnit(doc, id);
  if (!found) throw new Error("This unit is no longer in the equipment list. It may have been deleted in another session.");
  return { ...doc, [found.rack]: doc[found.rack].map(item => (item && String(item.id) === String(id) ? { ...item, ...changes } : item)) };
}

// The unit moved to another rack (appended there) or another floor of its rack; its shelf position is cleared when the
// rack changes. u: a whole number 0-42.
export function moveUnit(doc, id, rack, u) {
  const found = findUnit(doc, id);
  if (!found) throw new Error("This unit is no longer in the equipment list. It may have been deleted in another session.");
  const place = Number.isInteger(u) && u >= 0 && u <= 42 ? u : 0;
  if (found.rack === rack) return editUnit(doc, id, { u: place });
  const moved = { ...found.item, u: place, shelf_position: "" };
  return { ...doc, [found.rack]: doc[found.rack].filter(item => !(item && String(item.id) === String(id))), [rack]: [...asArray(doc[rack]), moved] };
}

// A new unit appended to a rack.
export function addUnit(doc, rack, unit) {
  if (!text(rack)) throw new Error("Choose a rack.");
  return { ...(doc && typeof doc === "object" ? doc : {}), [rack]: [...asArray(doc?.[rack]), unit] };
}

export function newUnitId() {
  return `ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// The unit's history (tracking_history), newest first: [{ at, text }].
export function historyRows(item) {
  return asArray(item?.tracking_history).filter(h => h && typeof h === "object").map(h => {
    const what = text(h.action) || "changed";
    const move = h.from || h.to ? ` ${h.from ? `from ${h.from} ` : ""}${h.to ? `to ${h.to}` : ""}`.trimEnd() : "";
    return { at: h.at || null, text: `${what[0].toUpperCase()}${what.slice(1)}${move}${text(h.note) ? ` · ${text(h.note)}` : ""}` };
  }).reverse();
}
