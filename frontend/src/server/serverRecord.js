// One server as its window shows it, built from the data the window provider holds. Pure (no React, no DOM), so
// node --test imports it; useServerRecord.js memoises it for a window.
//
// data (every field may be missing or null while it loads):
//   locations      GET /api/devices/locations   { servers: [row], empty_ports, racks }. A row: { key, name, rack, slot,
//                  kept_position, pdu: [port], kvm: [port] } plus, from WP-B, dcim_ids, drawn: {rack, u, auto} | null and
//                  removed: bool. Without the WP-B fields they are derived (see below).
//   devices, pduStatuses, kvmStatuses, maintenance   App's own data
//   rackItems      GET /api/rack-items  { rack: [item] }
//   owners         GET /api/opt-owners  { key: owner }
//   switches       GET /api/switch-assignments  { dcim id: { switch, port } }
//   monitoring     GET /api/monitoring  { targets: [{ id, server_key, ... }] }
//   removed        GET /api/removed-servers  { servers: [{ key, name, ports, active, ... }], hidden, log? }
import { serverIdentity } from "../api/locations.js";
import { placeWord, validFloor } from "../components/racks/floors.js";
import { serverPowerGroup } from "../components/racks/serverPower.js";
import { productName } from "../shelfLabels.js";
import { windowKey } from "./serverKey.js";
import { ownerOf, switchOf } from "./ownerKey.js";

const asArray = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? "" : String(value));

// A unit's floor as Racks draws it (components/racks/serverMove.js unitFloor): a whole number 0-42, else 0.
function unitFloor(item) {
  const n = typeof item?.u === "string" && item.u.trim() ? Number(item.u) : item?.u;
  return Number.isInteger(n) && n >= 0 && n <= 42 ? n : 0;
}

// The DCIM ids of a /locations row (backend devices._dcim_ids): each port label trimmed and lower-cased, in port order;
// a server with no port: its name lower-cased.
export function dcimIdsOf(row) {
  if (Array.isArray(row?.dcim_ids) && row.dcim_ids.length) return [...new Set(row.dcim_ids.map(String))];
  const ids = [];
  for (const port of [...asArray(row?.pdu), ...asArray(row?.kvm)]) {
    const id = text(port?.label).trim().toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.length ? ids : [text(row?.name).trim().toLowerCase()].filter(Boolean);
}

// Where Racks draws the server: WP-B's drawn field when the backend sends it (null: not drawn), else, for an older
// backend, its rack and saved U when a PDU outlet names it (Racks draws servers from PDU outlets only).
export function drawnOf(row) {
  if (!row) return null;
  if (row.drawn !== undefined) {
    const d = row.drawn;
    return d && d.rack ? { rack: String(d.rack), u: Number.isInteger(d.u) ? d.u : null, auto: !!d.auto } : null;
  }
  if (!asArray(row.pdu).length || !row.rack) return null;
  return { rack: String(row.rack), u: Number.isInteger(row.slot) ? row.slot : null, auto: !Number.isInteger(row.slot) };
}

// The /locations row of a window key (the row's key, or the identity of its name).
export function locationRow(locations, key) {
  return asArray(locations?.servers).find(row => row && (row.key === key || windowKey(row.name) === key)) || null;
}

function pduPorts(ports, { devices, pduStatuses }) {
  return asArray(ports).map(p => {
    const outlet = asArray(pduStatuses?.[p.device_id]?.outlets).find(o => String(o.number) === String(p.port));
    const device = asArray(devices).find(d => d.id === p.device_id);
    return { device_id: text(p.device_id), device_name: text(p.device_name || device?.name || p.device_id), port: text(p.port),
      label: text(p.label), state: outlet?.state || "unknown", watts: Number.isFinite(outlet?.watts) ? outlet.watts : null,
      pduIp: device?.ip || "" };
  });
}

function kvmPorts(ports, { devices, kvmStatuses }) {
  return asArray(ports).map(p => {
    const port = asArray(kvmStatuses?.[p.device_id]?.ports).find(x => String(x.number) === String(p.port));
    const device = asArray(devices).find(d => d.id === p.device_id);
    return { device_id: text(p.device_id), device_name: text(p.device_name || device?.name || p.device_id), port: text(p.port),
      label: text(p.label), inUse: !!port?.in_use };
  });
}

// key: a window key (windowKey(label)). Returns the record described in frontend/src/window/CONTRACT.md.
export function buildRecord(key, data = {}) {
  const loaded = data.locations != null;
  const row = locationRow(data.locations, key);
  const removedRecord = asArray(data.removed?.servers).find(r => r && r.key === key) || null;
  // WP-B's /locations flag (removed: the server is hidden now) counts too, so the window is read-only before the
  // removal list (GET /api/removed-servers, loaded on its own) arrives.
  const removed = removedRecord ? { record: removedRecord, active: removedRecord.active !== false }
    : row?.removed === true ? { record: { key, name: text(row.name || key) }, active: true } : null;
  const monitor = asArray(data.monitoring?.targets).find(t => t && t.server_key === key) || null;
  // A removed server whose labels are gone has no /locations row: its ports are the ones it had when it was removed.
  const recordPorts = kind => asArray(removedRecord?.ports).filter(p => p?.kind === kind);
  const name = text(row?.name || removedRecord?.name || monitor?.name || key);
  const base = row || { key, name, rack: removedRecord?.position?.rack ?? null, slot: removedRecord?.position?.slot ?? null,
    kept_position: null, pdu: recordPorts("pdu"), kvm: recordPorts("kvm") };
  const record = {
    key,
    name,
    dcim_ids: dcimIdsOf(base),
    removed,
    drawn: row ? drawnOf(row) : null,
    rack: base.rack ?? null,
    slot: Number.isInteger(base.slot) ? base.slot : null,
    kept_position: base.kept_position ?? null,
    pdu: pduPorts(base.pdu, data),
    kvm: kvmPorts(base.kvm, data),
    monitor,
    loading: !loaded,
    missing: loaded && !row && !removedRecord,
  };
  record.owner = ownerOf(record, data.owners);
  record.switch = switchOf(record, data.switches);
  const drawn = record.drawn;
  const onFloor = drawn && validFloor(drawn.u, drawn.rack);
  record.units = onFloor ? asArray(data.rackItems?.[drawn.rack]).filter(item => item && unitFloor(item) === drawn.u) : [];
  record.floorShared = onFloor ? asArray(data.locations?.servers)
    .filter(other => other && (other.key || windowKey(other.name)) !== key)
    .filter(other => { const d = drawnOf(other); return d && d.rack === drawn.rack && d.u === drawn.u; })
    .map(other => text(other.name)) : [];
  record.project = record.units.length ? productName(record.units[0]) : "";
  record.powerGroup = serverPowerGroup(name, { devices: data.devices, pduStatuses: data.pduStatuses, maintenance: data.maintenance });
  return record;
}

// "Rack-01 · floor 3", "Storage-Main · shelf 3", "Rack-01 · U 7, above the floors", "Not on a rack".
export function placeText(record) {
  const d = record?.drawn;
  if (d?.rack) {
    if (d.u == null) return `${d.rack} · no floor`;
    if (validFloor(d.u, d.rack)) return `${d.rack} · ${placeWord(d.rack)} ${d.u}`;
    return d.u === 0 ? `${d.rack} · rack level` : `${d.rack} · U ${d.u}, above the floors`;
  }
  return record?.rack ? `${record.rack} · not drawn` : "Not on a rack";
}

// The light list for pickers and search: [{ key, name, rack, removed }], removed servers only for Admins.
export function serverList(locations, { hidden = null, admin = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(locations?.servers)) {
    const key = row?.key || serverIdentity(row?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const removed = row.removed === true || !!hidden?.has?.(key);
    if (removed && !admin) continue;
    out.push({ key, name: text(row.name || key), rack: drawnOf(row)?.rack || row.rack || null, removed });
  }
  return out;
}
