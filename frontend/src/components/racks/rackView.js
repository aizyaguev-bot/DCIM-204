// Racks page view model: row states, rack summaries, compacted shelves, search and filters. Pure (no DOM, no React).
import { deviceState } from "../../api/client.js";
import { validShelf, shelfLabel } from "./chillers.js";

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

// A rack has four floors (1 at the top … 4 at the bottom, like the 3D Twin's SHELF 1 (TOP) … SHELF 4 (BOTTOM)).
export const RACK_FLOORS = 4;

// The shelves a rack card draws: always floors 1-4 (an empty floor stays a row), then "other": a shelf above floor 4
// that holds something (old or hand-edited data; shown so nothing is hidden), then the rack level (u 0). Empty shelves
// above floor 4 are dropped. coolingUs: the shelves that hold a cooling unit.
export function rackFloors(rows, coolingUs = new Set()) {
  const byU = new Map((rows || []).map(r => [r.u, r]));
  const floors = [];
  for (let u = 1; u <= RACK_FLOORS; u++) floors.push(byU.get(u) || { u, items: [], auto: false });
  const other = (rows || []).filter(r => r.u > RACK_FLOORS && (r.items.length || coolingUs.has(r.u)));
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

// One entry per server, equipment item and cooling unit; text is what search looks in.
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
        text: normalize([item.name, item.serial_number, item.barcode, optOwners[`item:${item.id}`], rs.rack].filter(Boolean).join(" ")) });
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

// Shelf choices for the cooling dialog: "not on a shelf" first, then U01-U42 with up to two names on each.
export function shelfOptions(rows, max = 42, coolingPlaced = {}) {
  const names = new Map();
  for (const row of rows || []) {
    if (!(row.u > 0)) continue;
    names.set(row.u, row.items.map(i => i.data?.name).filter(Boolean));
  }
  const options = [{ value: "", label: "Not on a shelf (rack level)" }];
  for (let u = 1; u <= max; u++) {
    const list = [...(names.get(u) || []), ...((coolingPlaced[u] || []).map(c => c.name).filter(Boolean))];
    const shown = list.slice(0, 2).join(", ") + (list.length > 2 ? ` +${list.length - 2}` : "");
    options.push({ value: String(u), label: `${shelfLabel(u)} · ${shown || "empty"}` });
  }
  return options;
}
