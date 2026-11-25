// The Manage index: one row per thing in the lab (servers, PDUs, KVMs, units, cooling units, racks and 3D-only
// records), each opening its own window. Pure (no React, no DOM), so the Manage page, the header search and the tests
// share it. WP-0 built the server rows; WP-M adds the other kinds through the same row shape.
//
// data: the window provider's data (see frontend/src/window/CONTRACT.md): locations, devices, pduStatuses, kvmStatuses,
// maintenance, rackItems, owners, switches, monitoring, removed, hidden, chillers, twin ({ data, etag } or the document).
// role: "viewer" | "operator" | "admin" (or { operate, admin }).
//
// A row: { uid, kind, type, id, name, rack, place, connection, state, owner, address, badges, problems: Set,
//   twinIds, searchText, open: target, deleteTarget, deleteRole, bulkBlockedWhy }
//   uid           "server:<key>", "dev:<id>", "unit:<id>", "cooling:<id>", "rack:<name>", "twin:<id>"
//   kind / type   the window kind (server, dev, unit, cooling, rack, twin) / the Type select value (TYPES)
//   open          the window target the row opens ({ kind, id })
//   deleteTarget  { kind, id } for POST /api/lab/delete (kind server, device, rack, unit, cooling or twin), or null
//   deleteRole    "operator" | "admin"
//   bulkBlockedWhy  why this role may not select the row ("" when it may)
// WP-M adds: typeText (the Type column), reason (a 3D-only record's), free ({ pdu|kvm: [port] } of a device),
//   stateTone ("ok" | "warn" | "bad" | "off" | "unknown").
import { buildRecord, drawnOf, placeText } from "../server/serverRecord.js";
import { serverIdentity } from "../api/locations.js";
import { placeWord, validFloor } from "../components/racks/floors.js";
import { unitOwner, unitPlace, unitTypeText, NOT_SEEN_DAYS } from "../units/unitModel.js";
import { classifyTwin } from "./twinRecords.js";

export const TYPES = ["server", "pdu", "kvm", "unit", "cooling", "rack", "other"];
export const PROBLEMS = ["unreachable", "maybe-gone", "deleted", "no-location", "single-feed", "missing-kvm", "missing-pdu", "free-ports", "not-in-lm"];
export const ADMIN_ONLY = "Admin only";
export const OPERATOR_ONLY = "Operator or Admin only";
export const TWIN_DEVICE_BLOCK = "Delete it from its window — 3D PDU and KVM records are never bulk-selected";
// 3D records the delete refuses (v2 §D.3: zones, walls, doors, benches and single shelves).
const NOT_DELETABLE = new Set(["zone", "wall", "door", "bench", "shelf"]);

const DAY_MS = 24 * 3600 * 1000;
const asArray = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? "" : String(value).trim());
const roleOf = role => {
  if (role && typeof role === "object") return role.admin ? "admin" : role.operate ? "operator" : "viewer";
  const r = String(role || "viewer").toLowerCase();
  return ["viewer", "operator", "admin"].includes(r) ? r : "viewer";
};
const twinDoc = twin => (twin && typeof twin === "object" && twin.data && typeof twin.data === "object" ? twin.data : twin);
const blockFor = (who, deleteRole) => (deleteRole === "admin" ? (who === "admin" ? "" : ADMIN_ONLY) : who === "viewer" ? OPERATOR_ONLY : "");
const search = parts => parts.filter(p => p != null && p !== "").join(" ").toLowerCase();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const msOf = value => {
  if (value == null || value === "") return NaN;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  return Date.parse(value);
};

// The racks Manage lists: every rack named by a device's rack or an equipment-list (rack_items) key.
export function rackNames(data) {
  const rackItems = data?.rackItems && typeof data.rackItems === "object" ? data.rackItems : {};
  const names = new Set([...asArray(data?.devices).map(d => d?.rack).filter(Boolean).map(String), ...Object.keys(rackItems)]);
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// The live side of the 3D link rule (twinRecords.js classifyTwin).
export function liveForTwin(data) {
  const devices = asArray(data?.devices);
  const rackItems = data?.rackItems && typeof data.rackItems === "object" ? data.rackItems : {};
  return {
    servers: asArray(data?.locations?.servers).map(s => ({ key: s?.key || serverIdentity(s?.name), name: s?.name })),
    devices: devices.map(d => ({ id: d.id, kind: d.kind, name: d.name })),
    rackItems,
    chillers: asArray(data?.chillers?.units || data?.chillers?.data?.units),
    racks: rackNames(data),
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

// A unit not seen for NOT_SEEN_DAYS (30) days: its last_seen_at is older. Unknown: not stale.
const staleDays = (item, now) => {
  const ms = msOf(item?.last_seen_at);
  if (!Number.isFinite(ms)) return null;
  const days = Math.floor((now - ms) / DAY_MS);
  return days > NOT_SEEN_DAYS ? days : null;
};

// The device status the cards show (api/client.js deviceState), copied so this module stays free of fetch code.
export function deviceReach(status) {
  if (!status) return "unknown";
  if (status.requestFailed) return "unavailable";
  if (status.reachable === false) return "offline";
  if (status.reachable && status.error) return "error";
  return status.reachable ? "online" : "unknown";
}

function serverRows(data, who, linksTo, now) {
  const rows = [];
  const units = unitIdentity(data?.rackItems);
  const seen = new Set();
  for (const row of asArray(data?.locations?.servers)) {
    const key = row?.key || serverIdentity(row?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const record = buildRecord(key, data);
    const removed = row.removed === true || !!record.removed?.active || !!data?.hidden?.has?.(key) || !!data?.removed?.hidden?.includes?.(key);
    const unit = units.get(key) || null;
    const monitor = record.monitor;
    // Monitor only: a ping monitor and nothing else (no PDU outlet, no KVM port, no rack).
    const monitorOnly = !!monitor && !unit && !record.pdu.length && !record.kvm.length && !row.rack && !row.kept_position?.rack && row.kept_position?.slot == null;
    const lastUp = msOf(monitor?.last_up_at);
    const upRecently = monitor?.status === "up" || (Number.isFinite(lastUp) && now - lastUp < 7 * DAY_MS);
    const drawing = record.pdu.some(p => p.state === "on" && (p.watts ?? 0) > 5);
    const problems = new Set();
    if (removed) problems.add("deleted");
    if (!unit && !record.drawn && !record.rack) problems.add("no-location");
    if (record.pdu.length === 1) problems.add("single-feed");
    if (!record.kvm.length) problems.add("missing-kvm");
    if (!record.pdu.length) problems.add("missing-pdu");
    if (monitor?.enabled && ["down", "stale"].includes(monitor.status)) problems.add("unreachable");
    if (monitorOnly) problems.add("not-in-lm");
    if (unit ? !upRecently && !drawing && staleDays(unit, now) !== null : monitorOnly || (!drawing && !upRecently)) problems.add("maybe-gone");
    const badges = [];
    if (removed) badges.push("Deleted");
    if (unit) badges.push("Unit");
    else if (monitorOnly) badges.push("Monitor only");
    const twinIds = linksTo.get(`server:${key}`) || [];
    if (twinIds.length) badges.push("In 3D");
    const on = record.pdu.filter(p => p.state === "on").length;
    const state = removed ? "Deleted" : on ? "On" : record.pdu.length && record.pdu.every(p => p.state === "off") ? "Off"
      : monitor?.status === "up" ? "Online" : monitor && ["down", "stale"].includes(monitor.status) ? "Unreachable" : "—";
    const stateTone = { Deleted: "off", On: "ok", Off: "off", Online: "ok", Unreachable: "bad" }[state] || "unknown";
    const address = who !== "viewer" ? monitor?.host || "" : "";
    const connection = [record.pdu.map(p => `${p.device_name}·${p.port}`).join(", "), record.kvm.map(p => `${p.device_name}·${p.port}`).join(", ")]
      .filter(Boolean).join(" / ");
    const place = unit ? unitPlace(unit, unit.rack) : record.drawn || record.rack ? placeText(record) : "No location";
    const owner = record.owner.value;
    const sw = record.switch.value ? `${record.switch.value.switch}${record.switch.value.port ? `:${record.switch.value.port}` : ""}` : "";
    const target = unit ? { kind: "unit", id: String(unit.id) } : { kind: "server", id: key };
    const deleteRole = unit ? "operator" : "admin";
    rows.push({
      uid: `server:${key}`, kind: "server", type: "server", id: key, name: record.name, typeText: unit ? "Server (unit)" : "Server",
      rack: record.drawn?.rack || record.rack || unit?.rack || null, place, connection, state, stateTone, owner, address,
      badges: badges.slice(0, 2), problems, twinIds,
      searchText: search([record.name, key, owner, sw, record.drawn?.rack || record.rack || unit?.rack, ...twinIds, address, unit?.serial_number,
        unit?.barcode, unit?.model, ...record.pdu.map(p => p.device_name), ...record.kvm.map(p => p.device_name)]),
      open: target,
      deleteTarget: target,
      deleteRole,
      bulkBlockedWhy: blockFor(who, deleteRole),
    });
  }
  return rows;
}

const DEFAULT_LABEL = /^(outlet|port)\s*\d+$/i;

function deviceRows(data, who, linksTo) {
  const rows = [];
  const free = { pdu: new Map(), kvm: new Map() };
  for (const kind of ["pdu", "kvm"]) {
    for (const port of asArray(data?.locations?.empty_ports?.[kind])) {
      const id = String(port?.device_id ?? "");
      if (!id) continue;
      if (!free[kind].has(id)) free[kind].set(id, []);
      free[kind].get(id).push(String(port.port));
    }
  }
  for (const d of asArray(data?.devices)) {
    if (!d || (d.kind !== "pdu" && d.kind !== "kvm")) continue;
    const id = String(d.id);
    const status = (d.kind === "pdu" ? data?.pduStatuses : data?.kvmStatuses)?.[id] || null;
    const reach = deviceReach(status);
    const maintenance = d.kind === "pdu" && !!data?.maintenance?.pdus?.[id] && data.maintenance.pdus[id]?.active !== false;
    const count = Number(d.port_count) || 0;
    const labels = d.labels && typeof d.labels === "object" ? Object.values(d.labels).map(text).filter(l => l && !DEFAULT_LABEL.test(l)) : [];
    const freePorts = free[d.kind].get(id) || [];
    let connection;
    if (d.kind === "pdu") {
      connection = `${plural(count, "outlet")} · ${labels.length} named`;
    } else {
      const inUse = asArray(status?.ports).filter(p => p?.in_use).length;
      connection = `${plural(count, "port")} · ${inUse} in use`;
    }
    const problems = new Set();
    if (reach === "offline" || reach === "error") { problems.add("unreachable"); problems.add("maybe-gone"); }
    if (!d.rack) problems.add("no-location");
    if (freePorts.length) problems.add("free-ports");
    const twinIds = linksTo.get(`dev:${id}`) || [];
    const badges = [];
    if (d.enabled === false) badges.push("Disabled");
    if (maintenance) badges.push("Maintenance");
    if (twinIds.length) badges.push("In 3D");
    const state = reach === "online" ? "Online" : reach === "offline" ? "Unreachable" : reach === "error" ? "Sign-in error"
      : reach === "unavailable" ? "No status" : "—";
    const stateTone = { online: "ok", offline: "bad", error: "warn" }[reach] || "unknown";
    const noun = d.kind === "pdu" ? "PDU" : "KVM";
    rows.push({
      uid: `dev:${id}`, kind: "dev", type: d.kind, id, name: text(d.name) || id, typeText: noun,
      rack: d.rack || null, place: d.rack || "No location", connection, state, stateTone, owner: "", address: text(d.ip),
      badges: badges.slice(0, 2), problems, twinIds, free: { [d.kind]: freePorts },
      searchText: search([d.name, id, noun, d.rack, d.ip, d.model, d.notes, ...twinIds, ...labels]),
      open: { kind: "dev", id },
      deleteTarget: { kind: "device", id },
      deleteRole: "admin",
      bulkBlockedWhy: blockFor(who, "admin"),
    });
  }
  return rows;
}

function unitRows(data, who, linksTo, skip, now) {
  const rows = [];
  for (const [rack, list] of Object.entries(data?.rackItems && typeof data.rackItems === "object" ? data.rackItems : {})) {
    for (const item of asArray(list)) {
      if (!item || item.id == null || skip.has(String(item.id))) continue;
      const id = String(item.id);
      const { owner, server } = unitOwner(item, rack, { locations: data?.locations, owners: data?.owners, hidden: data?.hidden });
      const stale = staleDays(item, now);
      const problems = new Set();
      if (stale !== null) problems.add("maybe-gone");
      const twinIds = linksTo.get(`unit:${id}`) || [];
      const badges = [];
      if (stale !== null) badges.push(`Not seen ${stale} days`);
      if (twinIds.length) badges.push("In 3D");
      rows.push({
        uid: `unit:${id}`, kind: "unit", type: "unit", id, name: text(item.name) || id, typeText: `Unit · ${unitTypeText(item.type)}`,
        rack, place: unitPlace(item, rack), connection: server ? `on ${server.name}'s floor` : "", state: "—", stateTone: "unknown",
        owner: owner || "", address: "", badges: badges.slice(0, 2), problems, twinIds,
        searchText: search([item.name, id, rack, owner, item.serial_number, item.barcode, item.model, item.mac_address, item.notes, unitTypeText(item.type), ...twinIds]),
        open: { kind: "unit", id },
        deleteTarget: { kind: "unit", id },
        deleteRole: "operator",
        bulkBlockedWhy: blockFor(who, "operator"),
      });
    }
  }
  return rows;
}

function coolingRows(data, who, linksTo) {
  const rows = [];
  for (const unit of asArray(data?.chillers?.units || data?.chillers?.data?.units)) {
    if (!unit || unit.id == null) continue;
    const id = String(unit.id);
    const u = Number(unit.u);
    const place = !unit.rack ? "No location" : validFloor(u, unit.rack) ? `${unit.rack} · ${placeWord(unit.rack)} ${u}` : String(unit.rack);
    const problems = new Set();
    if (!unit.rack) problems.add("no-location");
    const twinIds = linksTo.get(`cooling:${id}`) || [];
    rows.push({
      uid: `cooling:${id}`, kind: "cooling", type: "cooling", id, name: text(unit.name) || "Cooling unit", typeText: "Cooling",
      rack: unit.rack || null, place, connection: text(unit.model), state: "—", stateTone: "unknown", owner: "", address: "",
      badges: twinIds.length ? ["In 3D"] : [], problems, twinIds,
      searchText: search([unit.name, id, "cooling", unit.rack, unit.model, unit.serial_number, unit.notes, ...twinIds]),
      open: { kind: "cooling", id },
      deleteTarget: { kind: "cooling", id },
      deleteRole: "admin",
      bulkBlockedWhy: blockFor(who, "admin"),
    });
  }
  return rows;
}

function rackRows(data, who, linksTo) {
  const devices = asArray(data?.devices);
  const servers = new Map();
  for (const row of asArray(data?.locations?.servers)) {
    if (!row || row.removed === true) continue;
    const rack = drawnOf(row)?.rack || row.rack;
    if (rack) servers.set(rack, (servers.get(rack) || 0) + 1);
  }
  return rackNames(data).map(rack => {
    const onRack = devices.filter(d => d?.rack === rack);
    const typeDevice = onRack.find(d => d.kind === "rack");
    const units = asArray(data?.rackItems?.[rack]).length;
    const named = onRack.filter(d => d.kind === "pdu" || d.kind === "kvm").map(d => text(d.name) || d.id);
    const twinIds = linksTo.get(`rack:${rack}`) || [];
    const n = servers.get(rack) || 0;
    return {
      uid: `rack:${rack}`, kind: "rack", type: "rack", id: rack, name: rack, typeText: typeDevice?.model ? `Rack · ${typeDevice.model}` : "Rack",
      rack, place: rack, connection: [named.join(", "), n ? plural(n, "server") : "", units ? plural(units, "unit") : ""].filter(Boolean).join(" · "),
      state: "—", stateTone: "unknown", owner: "", address: "", badges: twinIds.length ? ["In 3D"] : [], problems: new Set(), twinIds,
      searchText: search([rack, "rack", typeDevice?.model, ...named, ...twinIds]),
      open: { kind: "rack", id: rack },
      deleteTarget: { kind: "rack", id: rack },
      deleteRole: "admin",
      bulkBlockedWhy: blockFor(who, "admin"),
    };
  });
}

const TWIN_TYPE_TEXT = { opt: "server", pdu: "PDU", kvm: "KVM", chiller: "cooling", setup: "rack frame", storage: "storage",
  "spare-chassis": "spare chassis" };
const twinTypeText = type => TWIN_TYPE_TEXT[type] || (String(type).startsWith("equip-") ? `unit (${String(type).slice(6)})` : String(type || "record"));

// "3D: Rack-07 shelf 2", "3D: STORAGE-02", "3D: Rack L2 — left row", "3D".
function twinPlace(twin, record) {
  const setups = asArray(twin?.setups);
  const setup = record.setup ? setups.find(s => s?.id === record.setup) : null;
  const rackName = setup ? text(setup.dcimRack) || text(setup.name) || setup.id : "";
  if (record.shelf) {
    const shelf = asArray(twin?.shelves).find(s => s?.id === record.shelf);
    const where = rackName || (shelf?.setup ? shelf.setup : "");
    return `3D: ${[where, shelf?.level != null ? `shelf ${shelf.level}` : record.shelf].filter(Boolean).join(" ")}`;
  }
  if (rackName) return `3D: ${rackName}`;
  if (record.storage) return `3D: ${record.storage}`;
  return "3D";
}

function twinRows(twin, only, who) {
  const byId = new Map();
  for (const list of [twin?.items, twin?.storage, twin?.setups]) for (const r of asArray(list)) if (r?.id != null) byId.set(String(r.id), r);
  return only.map(entry => {
    const id = String(entry.id);
    const record = byId.get(id) || {};
    const setup = record.setup ? asArray(twin?.setups).find(s => s?.id === record.setup) : null;
    const rack = text(setup?.dcimRack) || null;
    const device = entry.type === "pdu" || entry.type === "kvm";
    const deletable = !NOT_DELETABLE.has(entry.type);
    return {
      uid: `twin:${id}`, kind: "twin", type: "other", id, name: entry.name || id, typeText: `3D only · ${twinTypeText(entry.type)}`,
      twinType: entry.type, reason: entry.reason,
      rack, place: entry.type === "setup" ? "3D" : twinPlace(twin, record), connection: entry.reason, state: "3D only", stateTone: "unknown",
      owner: "", address: "", badges: ["3D only"], problems: new Set(["maybe-gone", "not-in-lm"]), twinIds: [id],
      searchText: search([entry.name, id, twinTypeText(entry.type), entry.reason, rack, record.notes, record.dcim?.deviceId, record.dcim?.optKey]),
      open: { kind: "twin", id },
      deleteTarget: deletable ? { kind: "twin", id } : null,
      deleteRole: "operator",
      bulkBlockedWhy: !deletable ? "Not deletable" : who === "viewer" ? OPERATOR_ONLY : device ? TWIN_DEVICE_BLOCK : "",
    };
  });
}

// -> { rows, counts: { total, types: {type: n}, problems: {problem: n} }, mismatch: { unlinked, total } }.
// Deleted rows (removed servers) are counted under problems.deleted only.
export function buildLabIndex(data = {}, role = "viewer", { now = Date.now(), twin: withTwin = true } = {}) {
  const who = roleOf(role);
  // withTwin false (the 3D twin is switched off, twinLinks.js TWIN_ENABLED): no 3D-only rows and no "In 3D" badges.
  const twin = withTwin ? twinDoc(data?.twin) : null;
  const { linked, only } = twin ? classifyTwin(twin, liveForTwin(data)) : { linked: new Map(), only: [] };
  const linksTo = new Map();
  for (const [twinId, uid] of linked) linksTo.set(uid, [...(linksTo.get(uid) || []), twinId]);
  const servers = serverRows(data, who, linksTo, now);
  // A computer / server unit that a server row already stands for ("Unit" badge) is not listed twice.
  const asServer = new Set(servers.filter(r => r.open.kind === "unit").map(r => r.open.id));
  const rows = [
    ...servers,
    ...deviceRows(data, who, linksTo),
    ...unitRows(data, who, linksTo, asServer, now),
    ...coolingRows(data, who, linksTo),
    ...rackRows(data, who, linksTo),
    ...(twin ? twinRows(twin, only, who) : []),
  ];
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

// The mismatch banner shows when more than half of the 3D PDU / KVM records are not linked to Lab Manager devices.
export const mismatchShown = mismatch => !!mismatch && mismatch.total > 0 && mismatch.unlinked * 2 > mismatch.total;
export const mismatchText = mismatch =>
  `lab-data.json PDU/KVM ids do not match Lab Manager (${mismatch.unlinked} of ${mismatch.total}) — these 3D records are listed as 3D only; check before deleting`;

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
