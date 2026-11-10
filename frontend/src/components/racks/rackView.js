// Racks page view model: row states, rack summaries, compacted shelves, search and filters. Pure (no DOM, no React).
import { deviceState } from "../../api/client.js";
import { validShelf, floorLabel } from "./chillers.js";
import { RACK_FLOORS, STORAGE_SHELVES, rackHasFloors, floorsFor } from "./floors.js";
import { ownerOfUnit } from "../../unitOwner.js";

export { RACK_FLOORS, STORAGE_SHELVES, floorsFor };

export const maintenanceFor = (maintenance, pduId) => maintenance?.pdus?.[String(pduId)] || null;

// One server row's visual state. pduStatus is pduStatuses[server.pduId] (undefined until the first reading).
export function serverVisualState(server, pduStatus, maint) {
  const maintenance = !!maint;
  const pduName = server?.pduName || "the PDU";
  if (pduStatus === undefined || pduStatus === null) {
    return { state: "loading", maintenance, word: "Reading…", title: "Waiting for the first PDU reading" };
  }
  const reach = deviceState(pduStatus);
  if (reach === "offline" || reach === "unavailable") {
    return { state: "unreachable", maintenance, word: "No reading", title: `No reading from ${pduName}` };
  }
  if (server.state === "on") return { state: "on", maintenance, word: "ON", title: `Outlet ${server.outlet} of ${pduName} is on` };
  if (server.state === "off") return { state: "off", maintenance, word: "OFF", title: `Outlet ${server.outlet} of ${pduName} is off` };
  return { state: "unknown", maintenance, word: "Unknown", title: `${pduName} did not report this outlet` };
}

const STATUS_TEXT = { online: "Online", offline: "Offline", unavailable: "No reading", loading: "Loading…", "no-pdu": "No PDU", storage: "Storage" };

export function rackSummary(rackStat, { pduStatuses = {}, maintenance = null, cooling } = {}) {
  const pdus = rackStat.pduData || [];
  let status;
  if (rackStat.rackType === "storage") status = "storage";
  else if (!pdus.length) status = "no-pdu";
  else if (pdus.some(p => pduStatuses[p.id] === undefined)) status = "loading";
  else if (pdus.some(p => deviceState(pduStatuses[p.id]) === "offline")) status = "offline";
  else if (pdus.some(p => deviceState(pduStatuses[p.id]) === "unavailable")) status = "unavailable";
  else status = "online";
  let on = 0, off = 0, noReading = 0;
  for (const server of rackStat.servers || []) {
    const visual = serverVisualState(server, pduStatuses[server.pduId], null);
    if (visual.state === "on") on++;
    else if (visual.state === "off") off++;
    else if (visual.state === "unknown" || visual.state === "unreachable") noReading++;
  }
  const names = new Map(pdus.map(p => [String(p.id), p.name]));
  const maintenancePdus = [...names.keys()].filter(id => maintenanceFor(maintenance, id)).map(id => names.get(id));
  return {
    status, statusText: STATUS_TEXT[status], maintenancePdus,
    total: (rackStat.servers || []).length, on, off, noReading,
    partial: status === "online" && rackStat.wattsComplete === false,
    coolingUnplaced: cooling?.unplaced?.length || 0,
  };
}

// The rack's rows with empty shelves added up to the highest shelf a cooling unit sits on (a unit at U10 in an
// 8-shelf rack adds shelves 9 and 10). Rows are never removed or reordered; the rack-level row (u 0) stays last.
export function withCoolingRows(rows, coolingUs) {
  const wanted = [...new Set((coolingUs || []).filter(validShelf))];
  const shelves = rows.filter(r => r.u > 0);
  const present = new Set(shelves.map(r => r.u));
  const missing = wanted.filter(u => !present.has(u));
  if (!missing.length) return rows;
  const top = shelves.length ? Math.max(...shelves.map(r => r.u)) : 0;
  const dense = shelves.every((r, i) => r.u === i + 1);
  const extra = new Set();
  if (dense) { for (let u = top + 1; u <= Math.max(...missing); u++) extra.add(u); }
  missing.forEach(u => extra.add(u));
  const added = [...extra].filter(u => !present.has(u)).map(u => ({ u, items: [], auto: false }));
  const merged = [...shelves, ...added].sort((a, b) => a.u - b.u);
  return [...merged, ...rows.filter(r => !(r.u > 0))];
}

// The shelves a rack card draws: always floors 1-count (an empty floor stays a row), then "other": a shelf above the
// last floor that holds something (old or hand-edited data; shown so nothing is hidden), then the rack level (u 0).
// Empty shelves above the floors are dropped. coolingUs: the shelves that hold a cooling unit. count: floorsFor(rack),
// 4 floors in a rack, 16 shelves in Main storage.
export function rackFloors(rows, coolingUs = new Set(), count = RACK_FLOORS) {
  const byU = new Map((rows || []).map(r => [r.u, r]));
  const floors = [];
  for (let u = 1; u <= count; u++) floors.push(byU.get(u) || { u, items: [], auto: false });
  const other = (rows || []).filter(r => r.u > count && (r.items.length || coolingUs.has(r.u)));
  const level = (rows || []).filter(r => !(r.u > 0));
  return { floors, other, level };
}

// Rows for display. Edit mode: every shelf (each one is a drop target). View: a run of two or more empty shelves is
// one "empty" gap (unless showEmpty); with a search or filter (keep), rows it hides fold into "filtered" gaps together
// with their empty neighbours. A shelf with a cooling unit is never empty; the rack-level row (u 0) is always a row.
export function compactRows(rows, { editMode = false, showEmpty = false, coolingUs = new Set(), keep = null } = {}) {
  if (editMode) return rows.map(row => ({ kind: "row", row }));
  const empty = row => row.u > 0 && !row.items.length && !coolingUs.has(row.u);
  const hidden = row => !!keep && row.u > 0 && !empty(row) && keep(row) === false;
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const filtered = run.some(hidden);
    if (filtered || (run.length >= 2 && !showEmpty)) {
      out.push({ kind: "gap", from: run[0].u, to: run[run.length - 1].u, reason: filtered ? "filtered" : "empty" });
    } else {
      run.forEach(row => out.push({ kind: "row", row }));
    }
    run = [];
  };
  for (const row of rows) {
    if (row.u > 0 && (empty(row) || hidden(row))) {
      run.push(row);   // empty and hidden rows fold together; a single empty row next to nothing hidden stays a row
      continue;
    }
    flush();
    out.push({ kind: "row", row });
  }
  flush();
  return out;
}

const normalize = text => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// One entry per server, equipment item and cooling unit; text is what search looks in. optOwners: the owner map as the
// page shows it (unitOwner.js withUnitOwners), so a unit is found by the owner of the server on its floor.
export function buildSearchIndex({ rackStats = [], optOwners = {}, switchAssignments = {}, customItems = {}, coolingUnits = [], uMaps = {} }) {
  const index = [];
  for (const rs of rackStats) {
    for (const s of rs.servers || []) {
      const sw = switchAssignments[s.id];
      index.push({ key: `s:${s.id}`, kind: "server", rack: rs.rack, u: uMaps[rs.rack]?.[s.id] ?? null,
        text: normalize([s.name, optOwners[s.id], sw?.switch, sw?.switch && sw?.port != null ? `${sw.switch}:${sw.port}` : "", rs.rack].filter(Boolean).join(" ")) });
    }
    for (const item of customItems[rs.rack] || []) {
      index.push({ key: `e:${item.id}`, kind: "equipment", rack: rs.rack, u: Number.isInteger(item.u) ? item.u : null,
        text: normalize([item.name, item.serial_number, item.barcode, ownerOfUnit(optOwners, item.id), rs.rack].filter(Boolean).join(" ")) });
    }
  }
  for (const unit of coolingUnits || []) {
    if (!unit || typeof unit !== "object") continue;
    index.push({ key: `c:${unit.id}`, kind: "cooling", rack: unit.rack ?? null, u: validShelf(unit.u) ? unit.u : null,
      text: normalize([unit.name, unit.rack].filter(Boolean).join(" ")) });
  }
  return index;
}

export function searchIndex(index, query) {
  const q = normalize(query);
  if (!q) return { query: "", total: 0, keys: new Set(), racks: new Map(), ordered: [] };
  const rackOrder = new Map();
  index.forEach(e => { if (e.rack != null && !rackOrder.has(e.rack)) rackOrder.set(e.rack, rackOrder.size); });
  const hits = index.filter(e => e.text.includes(q));
  const racks = new Map();
  hits.forEach(e => { if (e.rack != null && rackOrder.has(e.rack)) racks.set(e.rack, (racks.get(e.rack) || 0) + 1); });
  const pos = e => (e.rack != null && rackOrder.has(e.rack) ? rackOrder.get(e.rack) : Number.MAX_SAFE_INTEGER);
  const ordered = [...hits].sort((a, b) => pos(a) - pos(b) || (a.u ?? 99) - (b.u ?? 99) || a.key.localeCompare(b.key));
  return { query: q, total: hits.length, keys: new Set(hits.map(e => e.key)), racks: new Map([...racks].sort((a, b) => rackOrder.get(a[0]) - rackOrder.get(b[0]))), ordered };
}

export function matchesFilter(visual, filter) {
  if (!filter || filter === "all") return true;
  if (!visual || visual.state === "loading") return false;
  if (filter === "off") return visual.state === "off";
  if (filter === "no-reading") return visual.state === "unknown" || visual.state === "unreachable";
  if (filter === "maintenance") return visual.maintenance;
  return true;
}

// Place choices for the cooling dialog in that rack: "not on a floor" first, then the rack's floors 1-RACK_FLOORS as
// its card numbers them ("Floor 2 · OPT42, Switch 04 +2"); Main storage: its shelves 1-STORAGE_SHELVES ("Shelf 7 · …").
export function floorOptions(rows, coolingPlaced = {}, rack = null) {
  const floors = rackHasFloors(rack);
  const max = floorsFor(rack);
  const names = new Map();
  for (const row of rows || []) {
    if (!(row.u > 0)) continue;
    names.set(row.u, row.items.map(i => i.data?.name).filter(Boolean));
  }
  const options = [{ value: "", label: `Not on a ${floors ? "floor" : "shelf"} (rack level)` }];
  for (let u = 1; u <= max; u++) {
    const list = [...(names.get(u) || []), ...((coolingPlaced[u] || []).map(c => c.name).filter(Boolean))];
    const shown = list.slice(0, 2).join(", ") + (list.length > 2 ? ` +${list.length - 2}` : "");
    options.push({ value: String(u), label: `${floorLabel(u, rack)} · ${shown || "empty"}` });
  }
  return options;
}

// ── floor template (v2.47) ──
// Every floor of a compute rack is one box of the same size: floor number | server zone, and under it one unit slot
// (FLOOR_UNIT_SLOTS: a fixed box with the unit's labelled fields: name, P/N, S/N, model, MAC); a storage shelf is one
// slot too (SHELF_SLOTS, a server or a unit). The lab keeps one unit per floor and per shelf, so the slot is drawn when
// empty too. When more items are on a floor than it has slots, the slot still shows a unit and a small "+N" chip at the
// end of its first line opens the rest, so a full floor is never taller than an empty one. card: the overview's rack
// cards (and phones); detail: the larger rack detail.
export const FLOOR_UNIT_SLOTS = { card: 1, detail: 1 };
export const SHELF_SLOTS = { card: 1, detail: 1 };

// How many of count items a template with that many slots shows (every slot holds one), and how many the "+N" chip on
// the last slot holds.
export function slotOverflow(count, slots) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const s = Math.max(1, Math.floor(Number(slots) || 1));
  if (n <= s) return { shown: n, more: 0 };
  return { shown: s, more: n - s };
}

// Splits a list for a template: the items drawn in its slots, and the rest (behind the "+N" chip).
export function splitSlots(list, slots) {
  const items = Array.isArray(list) ? list : [];
  const { shown, more } = slotOverflow(items.length, slots);
  return { shown: items.slice(0, shown), rest: items.slice(shown), more };
}

// "+1 server", "+2 servers", "+1 unit", "+3 units", "+3 more": what a "+N" chip holds (its tooltip and accessible name;
// the unit and shelf chips show only "+N").
export const moreText = (n, noun = "more") => (noun === "server" || noun === "unit" ? `+${n} ${noun}${n === 1 ? "" : "s"}` : `+${n} ${noun}`);

// The second line of a server on its floor: what the app knows about it besides name, state and watts, in this order: a
// missing reading (why), owner, KVM console port, switch port and PDU feeds. Each is { key, text, title }; nothing for
// what is not known. (The SSH host, known to Operators from the SSH status, is drawn after the KVM port by the page.)
export function serverFacts({ visual = null, owner = "", kvm = null, sw = null, feeds = [] } = {}) {
  const out = [];
  if (visual && (visual.state === "unreachable" || visual.state === "unknown") && visual.title) out.push({ key: "reading", text: visual.title, title: visual.title });
  if (owner) out.push({ key: "owner", text: String(owner), title: `Owner: ${owner}` });
  if (kvm?.kvmName) out.push({ key: "kvm", text: `${kvm.kvmName} · port ${kvm.port}`, title: `KVM console: ${kvm.kvmName}, port ${kvm.port}` });
  if (sw?.switch) out.push({ key: "switch", text: `${sw.switch}${sw.port ? `:${sw.port}` : ""}`, title: `Switch ${sw.switch}${sw.port ? ` · port ${sw.port}` : ""}` });
  const list = (feeds || []).filter(f => f && f.pduName);
  if (list.length) out.push({ key: "feeds", text: list.map(f => `${f.pduName} · ${f.outlet}`).join(", "),
    title: list.map(f => `${f.pduName} outlet ${f.outlet}${f.state === "on" || f.state === "off" ? ` (${f.state})` : ""}`).join(", ") });
  return out;
}

// A value cut in the middle when it is too long for its place: the head (ends in "…") and the tail that always stays
// (the last keep characters), so "MCX75310AAS-NEAT-1" and "...-2", or "Spare adapter 1" and "... 2", stay apart. Short
// values are not split (tail ""). Counts characters, not UTF-16 units.
export function midSplit(value, keep = 5) {
  const chars = Array.from(String(value ?? ""));
  const k = Math.max(1, Math.floor(Number(keep) || 1));
  if (chars.length <= k + 3) return { head: chars.join(""), tail: "" };
  return { head: chars.slice(0, -k).join(""), tail: chars.slice(-k).join("") };
}
