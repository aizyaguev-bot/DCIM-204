// The Manage page's pure helpers (pages/ManageView.jsx; v1 WP-6 server table and v2 §M). Free of DOM and React, so
// node --test imports them (__tests__/servers-list.test.js).
//
//   connectionRacks, filterConnections, connectionsLoader   copied from pages/ConnectionsView.jsx (Admin › Connections,
//                                                           which this page replaces), same behaviour
//   serverTableRow(record, { operate })                     one row of the Servers table (Type = Servers)
//   filterServerTable(rows, { state }), sortServerTable(rows, key, dir)
//   typeChoice(param) / TYPE_CHOICES                        the Type select and its URL value (type=pdu,kvm)
//   showParam(value)                                        the URL's show= as a PROBLEMS id (v1 aliases included)
//   outletCountCandidates(devices, pduStatuses)             "Set outlet counts from the PDUs" (Admin)
//   csvText(columns, rows)                                  the CSV of the rows shown
//   entryState(entry), batchRestorable(batch), legacyRemoved(removed, batches), entryRole(kind)   the Deleted view
import { TWIN_ENABLED } from "../twinLinks.js";

// ── copied from ConnectionsView.jsx (unchanged) ──

export function connectionRacks(servers = []) {
  return [...new Set(servers.flatMap(server => [server.rack, ...(server.pdu || []).map(link => link.rack)]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function filterConnections(servers = [], { search = "", rack = "all", connection = "all" } = {}) {
  const query = search.trim().toLowerCase();
  return servers.filter(server => {
    const pdus = server.pdu || [];
    const kvms = server.kvm || [];
    if (rack !== "all" && server.rack !== rack && !pdus.some(link => link.rack === rack)) return false;
    if (connection === "missing-kvm" && kvms.length !== 0) return false;
    if (connection === "missing-pdu" && pdus.length !== 0) return false;
    if (connection === "single-feed" && pdus.length !== 1) return false;
    if (!query) return true;
    const fields = [server.key, server.name, server.server_ip, server.rack, server.owner, server.ping_status];
    if (server.slot != null && server.slot !== "") fields.push(server.slot, `U${server.slot}`);
    for (const link of [...pdus, ...kvms]) {
      fields.push(link.device_name, link.device_ip, link.rack, link.port, `#${link.port}`, link.label, link.state);
    }
    return fields.some(value => value != null && String(value).toLowerCase().includes(query));
  });
}

// One load cycle: load(false) is a visible load, load(true) a background refresh skipped while the browser tab is hidden
// or another load runs. A 403 stops the cycle; after stop() no late response is reported. load(true, { queue: true })
// that meets a running load runs once more right after it.
export function connectionsLoader(fetchConnections, { onStart, onData, onError, onDenied, onDone, isHidden = () => false } = {}) {
  let stopped = false;
  let denied = false;
  let pending = false;
  let queued = false;
  async function load(background = false, { queue = false } = {}) {
    if (pending && queue && !stopped && !denied) queued = true;
    if (stopped || denied || pending || (background && isHidden())) return false;
    pending = true;
    if (!background) onStart?.();
    try {
      const result = await fetchConnections();
      if (!stopped) onData?.(result);
    } catch (e) {
      if (!stopped && e?.status === 403) { denied = true; onDenied?.(e); }
      else if (!stopped) onError?.(e, background);
    } finally {
      pending = false;
      if (!stopped && !background) onDone?.();
      if (queued && !stopped) { queued = false; load(true); }
    }
    return true;
  }
  return { load, stop() { stopped = true; } };
}

// ── the Servers table (v1 §3: State, W, U, Outlet, PDU, PDU IP, Switch, Owner, SSH, KVM, Ping, Server IP) ──

const asArray = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? "" : String(value).trim());
const unique = list => [...new Set(list.filter(Boolean))];

// record: server/serverRecord.js buildRecord(key, data). operate: the viewer may see addresses (Operator+).
export function serverTableRow(record, { operate = false } = {}) {
  const pdu = asArray(record?.pdu);
  const kvm = asArray(record?.kvm);
  const on = pdu.some(p => p.state === "on");
  const state = on ? "on" : pdu.length && pdu.every(p => p.state === "off") ? "off" : "unknown";
  const known = pdu.map(p => p.watts).filter(w => Number.isFinite(w));
  const sw = record?.switch?.value;
  const monitor = record?.monitor || null;
  return {
    key: record?.key, name: text(record?.name) || record?.key,
    rack: record?.drawn?.rack || record?.rack || null,
    u: Number.isInteger(record?.drawn?.u) ? record.drawn.u : null,
    state,
    watts: known.length ? known.reduce((a, b) => a + b, 0) : null,
    outlet: pdu.length ? Number(pdu[0].port) || pdu[0].port : null,
    outlets: pdu.map(p => p.port).join(", "),
    pduName: unique(pdu.map(p => p.device_name)).join(", "),
    pduIp: unique(pdu.map(p => p.pduIp)).join(", "),
    switch: sw ? `${text(sw.switch)}${text(sw.port) ? `·${text(sw.port)}` : ""}` : "",
    owner: text(record?.owner?.value),
    kvm: kvm.map(p => `${p.device_name} · ${p.port}`).join(", "),
    ping: monitor ? (monitor.enabled === false && monitor.status !== "paused" ? "off" : text(monitor.status) || "unknown") : "",
    serverIp: operate ? text(monitor?.host) : "",
  };
}

export const SERVER_STATES = ["on", "off", "unknown"];

export function filterServerTable(rows, { state = "all" } = {}) {
  return asArray(rows).filter(row => state === "all" || row.state === state);
}

// Sort by a column: numbers numerically (empty last), text in natural order; dir 1 or -1; the name breaks ties.
export function sortServerTable(rows, key = "rack", dir = 1) {
  const blank = v => v == null || v === "";
  return [...asArray(rows)].sort((a, b) => {
    const av = a[key], bv = b[key];
    let c;
    if (blank(av) || blank(bv)) c = blank(av) && blank(bv) ? 0 : blank(av) ? 1 : -1;
    else if (typeof av === "number" && typeof bv === "number") c = dir * (av - bv);
    else c = dir * String(av).localeCompare(String(bv), undefined, { numeric: true });
    return c || String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
  });
}

// ── filters in the URL ──

// The Type select: [label, URL value]. Any other list shows as "Custom".
export const TYPE_CHOICES = [["All", ""], ["Servers", "server"], ["PDUs & KVMs", "pdu,kvm"], ["PDUs", "pdu"], ["KVMs", "kvm"],
  ["Units", "unit"], ["Cooling", "cooling"], ["Racks", "rack"], ...(TWIN_ENABLED ? [["3D only", "other"]] : [])];
const KNOWN_TYPES = new Set(["server", "pdu", "kvm", "unit", "cooling", "rack", "other"]);

// type= (a comma list) -> { value (normalised list), types: [type], label }.
export function typeChoice(param) {
  const types = unique(String(param || "").split(",").map(t => t.trim().toLowerCase()).filter(t => KNOWN_TYPES.has(t)));
  const value = types.join(",");
  const known = TYPE_CHOICES.find(([, v]) => v === value);
  return { value, types, label: known ? known[0] : "Custom" };
}

const SHOW_ALIASES = { unplaced: "no-location", removed: "deleted", all: null, "": null };
// show= -> a PROBLEMS id, or null (All). v1's unplaced and removed are aliases.
export function showParam(value, problems) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v in SHOW_ALIASES) return SHOW_ALIASES[v];
  return asArray(problems).includes(v) ? v : null;
}

// ── Set outlet counts from the PDUs (Admin) ──

// PDUs with no outlet count whose status lists outlets: [{ id, name, count }].
export function outletCountCandidates(devices, pduStatuses) {
  return asArray(devices).filter(d => d && d.kind === "pdu" && !(Number(d.port_count) > 0)).map(d => {
    const status = pduStatuses?.[d.id];
    const count = status && status.reachable !== false && !status.requestFailed ? asArray(status.outlets).length : 0;
    return { id: String(d.id), name: text(d.name) || String(d.id), count };
  }).filter(c => c.count > 0);
}

// ── CSV ──

const cell = value => {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};
// columns: [[header, row => value]]. Spreadsheet formulas are defused (a leading =, +, - or @ is quoted).
export function csvText(columns, rows) {
  const lines = [columns.map(([h]) => cell(h)).join(",")];
  for (const row of asArray(rows)) lines.push(columns.map(([, get]) => cell(get(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

// ── the Deleted view (§M.6) ──

const ADMIN_KINDS = new Set(["server", "device", "dev", "rack", "cooling"]);
// The role a restore (or delete) of this kind needs: servers, PDUs, KVMs, racks and cooling units are Admin; units and
// 3D records Operator.
export const entryRole = kind => (ADMIN_KINDS.has(kind) ? "admin" : "operator");
export const mayRestore = (kind, can) => (entryRole(kind) === "admin" ? !!can?.admin : !!(can?.operate || can?.admin));

const whenText = value => {
  if (value == null || value === "") return "";
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : String(value);
};
export { whenText };

// "Restorable", "Restored <when>", "Not restorable: <why>".
export function entryState(entry) {
  if (entry?.restored_at) return `Restored ${whenText(entry.restored_at)}`;
  if (entry?.restorable === false) return `Not restorable${entry.why_not ? `: ${entry.why_not}` : ""}`;
  return "Restorable";
}

// The entries of a batch Restore batch would bring back (restorable and not restored yet).
export const openEntries = batch => asArray(batch?.entries).filter(e => !e?.restored_at && e?.restorable !== false);

// Servers removed before the Deleted list existed (GET /api/removed-servers records) that no open batch entry covers.
export function legacyRemoved(removed, batches) {
  const covered = new Set();
  for (const batch of asArray(batches)) {
    for (const e of asArray(batch?.entries)) if (e?.kind === "server" && !e.restored_at) covered.add(String(e.id).toLowerCase());
  }
  return asArray(removed?.servers).filter(s => s && s.key && !covered.has(String(s.key).toLowerCase()));
}

export const KIND_TEXT = { server: "Server", device: "PDU / KVM", dev: "PDU / KVM", rack: "Rack", unit: "Unit", cooling: "Cooling unit", twin: "3D record" };
