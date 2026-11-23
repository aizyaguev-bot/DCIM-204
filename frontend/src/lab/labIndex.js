// The Manage index: one row per thing in the lab (servers, PDUs, KVMs, units, cooling units, racks and 3D-only
// records), each opening its own window. Pure (no React, no DOM), so the Manage page, the header search and the tests
// share it. WP-0 builds the server rows; WP-M adds the other kinds through the same row shape.
//
// data: the window provider's data (see frontend/src/window/CONTRACT.md): locations, devices, pduStatuses, kvmStatuses,
// maintenance, rackItems, owners, switches, monitoring, removed, chillers, twin ({ data, etag } or the document).
// role: "viewer" | "operator" | "admin" (or { operate, admin }).
//
// A row: { uid, kind, type, id, name, rack, place, connection, state, owner, address, badges, problems: Set,
//   twinIds, searchText, open: target, deleteTarget, deleteRole, bulkBlockedWhy }
//   uid           "server:<key>", "dev:<id>", "unit:<id>", "cooling:<id>", "rack:<name>", "twin:<id>"
//   kind / type   the window kind (server, dev, unit, cooling, rack, twin) / the Type select value (TYPES)
//   open          the window target the row opens ({ kind, id })
//   deleteTarget  { kind, id } for POST /api/lab/delete, or null; deleteRole "operator" | "admin"
//   bulkBlockedWhy  why this role may not select the row ("" when it may)
import { buildRecord, placeText } from "../server/serverRecord.js";
import { serverIdentity } from "../api/locations.js";
import { classifyTwin } from "./twinRecords.js";

export const TYPES = ["server", "pdu", "kvm", "unit", "cooling", "rack", "other"];
export const PROBLEMS = ["unreachable", "maybe-gone", "deleted", "no-location", "single-feed", "missing-kvm", "missing-pdu", "free-ports", "not-in-lm"];
export const ADMIN_ONLY = "Admin only";

const DAY_MS = 24 * 3600 * 1000;
const asArray = value => (Array.isArray(value) ? value : []);
const roleOf = role => {
  if (role && typeof role === "object") return role.admin ? "admin" : role.operate ? "operator" : "viewer";
  const r = String(role || "viewer").toLowerCase();
  return ["viewer", "operator", "admin"].includes(r) ? r : "viewer";
};
const twinDoc = twin => (twin && typeof twin === "object" && twin.data && typeof twin.data === "object" ? twin.data : twin);

// The live side of the 3D link rule (twinRecords.js classifyTwin).
export function liveForTwin(data) {
  const devices = asArray(data?.devices);
  const rackItems = data?.rackItems && typeof data.rackItems === "object" ? data.rackItems : {};
  const racks = new Set([...devices.map(d => d?.rack).filter(Boolean), ...Object.keys(rackItems)]);
  return {
    servers: asArray(data?.locations?.servers).map(s => ({ key: s?.key || serverIdentity(s?.name), name: s?.name })),
    devices: devices.map(d => ({ id: d.id, kind: d.kind, name: d.name })),
    rackItems,
    chillers: asArray(data?.chillers?.units || data?.chillers?.data?.units),
    racks: [...racks],
  };
}

const unitIdentity = items => {
  const out = new Map();
  for (const [rack, list] of Object.entries(items && typeof items === "object" ? items : {})) {
    for (const item of asArray(list)) {
      if (!item || !["computer", "server"].includes(item.type)) continue;
      const key = serverIdentity(item.name);
      if (key && !out.has(key)) out.set(key, { ...item, rack });
    }
  }
  return out;
};

function serverRows(data, role, linksTo) {
  const rows = [];
  const now = Date.now();
  const units = unitIdentity(data?.rackItems);
  const seen = new Set();
  for (const row of asArray(data?.locations?.servers)) {
    const key = row?.key || serverIdentity(row?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const record = buildRecord(key, data);
    const removed = row.removed === true || !!record.removed?.active || !!data?.removed?.hidden?.includes?.(key);
    const unit = units.get(key) || null;
    const monitorOnly = !record.pdu.length && !record.kvm.length && !row.rack && !row.kept_position?.rack && row.kept_position?.slot == null;
    const monitor = record.monitor;
    const upRecently = monitor?.last_up_at && now - Date.parse(monitor.last_up_at) < 7 * DAY_MS;
    const drawing = record.pdu.some(p => p.state === "on" && (p.watts ?? 0) > 5);
    const problems = new Set();
    if (removed) problems.add("deleted");
    if (!record.drawn && !record.rack) problems.add("no-location");
    if (record.pdu.length === 1) problems.add("single-feed");
    if (!record.kvm.length) problems.add("missing-kvm");
    if (!record.pdu.length) problems.add("missing-pdu");
    if (monitor?.enabled && ["down", "stale"].includes(monitor.status)) problems.add("unreachable");
    if (monitorOnly) problems.add("not-in-lm");
    if (monitorOnly || (!drawing && !upRecently)) problems.add("maybe-gone");
    const badges = [];
    if (removed) badges.push("Deleted");
    if (unit) badges.push("Unit");
    else if (monitorOnly) badges.push("Monitor only");
    const twinIds = linksTo.get(`server:${key}`) || [];
    if (twinIds.length) badges.push("In 3D");
    const on = record.pdu.filter(p => p.state === "on").length;
    const state = removed ? "Deleted" : on ? "On" : record.pdu.length && record.pdu.every(p => p.state === "off") ? "Off"
      : monitor?.status === "up" ? "Online" : monitor && ["down", "stale"].includes(monitor.status) ? "Unreachable" : "—";
    const address = role !== "viewer" ? monitor?.host || "" : "";
    const connection = [record.pdu.map(p => `${p.device_name}·${p.port}`).join(", "), record.kvm.map(p => `${p.device_name}·${p.port}`).join(", ")]
      .filter(Boolean).join(" / ");
    const place = record.drawn || record.rack ? placeText(record) : "No location";
    const owner = record.owner.value;
    const sw = record.switch.value ? `${record.switch.value.switch}${record.switch.value.port ? `:${record.switch.value.port}` : ""}` : "";
    const target = unit ? { kind: "unit", id: String(unit.id) } : { kind: "server", id: key };
    rows.push({
      uid: `server:${key}`, kind: "server", type: "server", id: key, name: record.name,
      rack: record.drawn?.rack || record.rack || null, place, connection, state, owner, address,
      badges: badges.slice(0, 2), problems, twinIds,
      searchText: [record.name, owner, sw, record.drawn?.rack || record.rack, ...twinIds, address, unit?.serial_number, unit?.barcode]
        .filter(Boolean).join(" ").toLowerCase(),
      open: target,
      deleteTarget: target,
      deleteRole: unit ? "operator" : "admin",
      bulkBlockedWhy: unit ? (role === "viewer" ? "Operator or Admin only" : "") : role === "admin" ? "" : ADMIN_ONLY,
    });
  }
  return rows;
}

// -> { rows, counts: { total, types: {type: n}, problems: {problem: n} }, mismatch: { unlinked, total } }.
export function buildLabIndex(data = {}, role = "viewer") {
  const who = roleOf(role);
  const twin = twinDoc(data?.twin);
  const { linked } = twin ? classifyTwin(twin, liveForTwin(data)) : { linked: new Map() };
  const linksTo = new Map();
  for (const [twinId, uid] of linked) linksTo.set(uid, [...(linksTo.get(uid) || []), twinId]);
  const rows = serverRows(data, who, linksTo);
  const counts = { total: 0, types: Object.fromEntries(TYPES.map(t => [t, 0])), problems: Object.fromEntries(PROBLEMS.map(p => [p, 0])) };
  for (const row of rows) {
    if (row.problems.has("deleted")) { counts.problems.deleted++; continue; }
    counts.total++;
    counts.types[row.type] = (counts.types[row.type] || 0) + 1;
    for (const problem of row.problems) counts.problems[problem] = (counts.problems[problem] || 0) + 1;
  }
  const records = asArray(twin?.items).filter(i => i?.type === "pdu" || i?.type === "kvm");
  const mismatch = { unlinked: records.filter(i => !linked.has(i.id)).length, total: records.length };
  return { rows, counts, mismatch };
}

// The rows a Manage view shows: types (array; empty = all), one problem (a PROBLEMS id; "deleted" shows only deleted
// rows, every other view hides them), q (search text) and rack.
export function filterRows(rows, { types = [], problem = null, q = "", rack = null } = {}) {
  const wanted = new Set(asArray(types));
  const words = String(q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return asArray(rows).filter(row => {
    if (problem === "deleted" ? !row.problems.has("deleted") : row.problems.has("deleted")) return false;
    if (problem && problem !== "deleted" && !row.problems.has(problem)) return false;
    if (wanted.size && !wanted.has(row.type)) return false;
    if (rack && row.rack !== rack) return false;
    return words.every(word => row.searchText.includes(word) || String(row.name).toLowerCase().includes(word));
  });
}
