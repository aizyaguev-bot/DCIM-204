// Lab display (?tab=display): the read-only wall TV screen at the lab entrance. Pure helpers only (no DOM, no React),
// so node:test covers them (src/__tests__/lab-display.test.js). The page itself is pages/LabDisplay.jsx.
import { deviceState } from "./api/client.js";
import { rackSummary, serverVisualState } from "./components/racks/rackView.js";
import { MAIN_STORAGE } from "./api/inventory.js";

export const REFRESH_MS = 15_000;        // one data cycle, like the rest of the site
export const STALE_MS = 60_000;          // older data than this shows the stale badge
export const ROTATE_MS = 10_000;         // long lists and the rack grid turn a page this often
export const REQUEST_TIMEOUT_MS = 12_000; // a request that hangs longer counts as failed; the next cycle retries
export const OVERRIDES_EVERY = 4;        // rack overrides (servers moved between racks) change rarely: every 4th cycle
export const TICKER_MAX = 12;            // recent changes kept (never an unbounded list)
export const INCIDENT_LIMIT = 8;
// Same thresholds as the Dashboard stats bar (components/StatsBar.jsx).
export const TEMP_WARN_C = 24;
export const TEMP_ALARM_C = 35;
export const HUMIDITY_WARN = 70;
// The Racks page's per-PDU rating assumption (DcimView ratedAmps) and its load bands.
export const RATED_AMPS = 16;
export const LOAD_WARN_PCT = 60;
export const LOAD_ALARM_PCT = 80;
// Row heights in em of the display's base size; the page sets them inline and fits lists with the same numbers.
export const ROW_EM = { attention: 3.7, load: 2.75, inUse: 2.4, ticker: 2.6 };
export const RACK_CARD_EM = { minW: 14, minH: 7.6, maxH: 11, gap: 0.8 };
export const LIST_GAP_EM = 0.45;
export const LOAD_COL_EM = 26;   // Power by PDU: a second column once the panel is this wide (per column)
export const TICKER_ITEM_EM = 31;   // recent changes: one entry per this much strip width

// The same text as DcimView.jsx NON_SERVER_LABEL / isDefaultOutletLabel (lab-display.test.js keeps them equal).
const NON_SERVER_LABEL = /^(empty|kvm[\s_-]*power|pdu|spare|free|n\/a|-+)$/i;
const DEFAULT_OUTLET_LABEL = /^(outlet\s*\d+|port\s*\d+|\s*)$/i;
export function isServerLabel(label) {
  return !!label && !DEFAULT_OUTLET_LABEL.test(String(label).trim()) && !NON_SERVER_LABEL.test(String(label).trim());
}

export const naturalCompare = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "en", { numeric: true, sensitivity: "base" });
const finite = value => typeof value === "number" && Number.isFinite(value);
const asArray = value => (Array.isArray(value) ? value : []);
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// Servers as the Racks page lists them (DcimView `servers`): every PDU outlet whose label names a server. A reachable
// PDU's live outlets win over saved labels; a moved server (rack overrides) belongs to its new rack.
export function buildServers(pdus, pduStatuses = {}, rackOverrides = {}) {
  const map = new Map();
  const overrides = asObject(rackOverrides);
  for (const pdu of pdus || []) {
    const status = pduStatuses[pdu.id];
    const live = status?.reachable ? asArray(status.outlets) : [];
    const liveByN = new Map(live.map(o => [String(o.number), o]));
    const rackOf = key => (typeof overrides[key] === "string" && overrides[key]) || pdu.rack || "—";
    for (const [num, label] of Object.entries(asObject(pdu.labels))) {
      if (liveByN.has(num) || !isServerLabel(label)) continue;
      const key = String(label).trim().toLowerCase();
      if (map.has(key)) continue;
      map.set(key, { id: key, name: String(label).trim(), rack: rackOf(key), pduId: pdu.id, pduName: pdu.name, outlet: parseInt(num, 10), state: "unknown", watts: null });
    }
    for (const o of live) {
      if (!isServerLabel(o.label)) continue;
      const key = String(o.label).trim().toLowerCase();
      if (map.has(key)) { const e = map.get(key); e.state = o.state; e.watts = o.watts ?? null; continue; }
      map.set(key, { id: key, name: String(o.label).trim(), rack: rackOf(key), pduId: pdu.id, pduName: pdu.name, outlet: o.number, state: o.state, watts: o.watts ?? null });
    }
  }
  return [...map.values()].sort((a, b) => naturalCompare(a.name, b.name));
}

// One PDU's draw and estimated load, the Racks page rules: measured inlet current when every inlet reports it, else
// a complete wattage over the inlet voltage (208 V when unknown); load is that current over the 16 A rating.
export function pduLoad(pdu, status) {
  const reachable = status?.reachable === true;
  const watts = reachable && finite(status.total_watts) ? status.total_watts : null;
  const complete = reachable && status.watts_complete === true;
  const voltage = reachable && finite(status.inlet_voltage) && status.inlet_voltage > 0 ? status.inlet_voltage : 208;
  const readings = reachable ? asArray(status.inlet_readings) : [];
  const measured = readings.length > 0 && readings.every(i => finite(i?.current));
  const amps = measured ? readings.reduce((sum, i) => sum + i.current, 0) : complete && watts != null ? watts / voltage : null;
  const pct = amps == null ? null : (amps / RATED_AMPS) * 100;
  const state = status === undefined || status === null ? "loading" : deviceState(status);
  const level = state === "offline" || state === "unavailable" ? "alarm" : pct == null ? "idle" : pct >= LOAD_ALARM_PCT ? "alarm" : pct >= LOAD_WARN_PCT ? "warn" : "ok";
  return { id: pdu.id, name: pdu.name, rack: pdu.rack || "", state, reachable, watts, amps, pct, estimated: !measured, level };
}

// Rack cards: one per rack named by a PDU or a rack device, in natural order (Rack-2 before Rack-10).
export function buildRacks(devices, pduStatuses = {}, servers = [], maintenance = null) {
  const rackDevices = (devices || []).filter(d => (d.kind === "pdu" || d.kind === "rack") && d.rack);
  const names = [...new Set(rackDevices.map(d => d.rack))].sort(naturalCompare);
  return names.map(rack => {
    const own = rackDevices.filter(d => d.rack === rack);
    const shared = rackDevices.filter(d => d.kind === "pdu" && d.rack !== rack && String(d.notes || "").split(",").map(s => s.trim()).includes(`shared:${rack}`));
    const pduData = [...own, ...shared].filter(d => d.kind === "pdu").map(d => ({ id: d.id, name: d.name }));
    const rackType = rack === MAIN_STORAGE || own[0]?.model === "Storage" ? "storage" : "compute";   // DcimView rackStats rule
    const loads = pduData.map(p => pduLoad(p, pduStatuses[p.id]));
    const watts = loads.some(l => l.watts != null) ? loads.reduce((sum, l) => sum + (l.watts ?? 0), 0) : null;
    const wattsComplete = pduData.length > 0 && pduData.every(p => pduStatuses[p.id]?.reachable === true && pduStatuses[p.id]?.watts_complete === true);
    const rackServers = servers.filter(s => s.rack === rack);
    const summary = rackSummary({ rackType, pduData, servers: rackServers, wattsComplete }, { pduStatuses, maintenance });
    const level = summary.status === "offline" ? "alarm"
      : summary.maintenancePdus.length ? "maint"
      : summary.status === "unavailable" || summary.noReading > 0 ? "warn"
      : summary.status === "online" ? "ok" : "idle";
    return { rack, storage: rackType === "storage", status: summary.status, statusText: summary.statusText, level,
      total: summary.total, on: summary.on, off: summary.off, noReading: summary.noReading,
      watts, wattsComplete, maintenancePdus: summary.maintenancePdus };
  });
}

// PDU temperature, humidity and leak sensors (reachable PDUs only) with the Dashboard thresholds.
export function environment(pdus, pduStatuses = {}) {
  const sensors = [];
  for (const pdu of pdus || []) {
    const s = pduStatuses[pdu.id];
    if (!s?.reachable) continue;
    const temperature = finite(s.temperature) ? s.temperature : null;
    const humidity = finite(s.humidity) ? s.humidity : null;
    const leak = typeof s.leak_detected === "boolean" ? s.leak_detected : null;
    if (temperature == null && humidity == null && leak == null) continue;
    sensors.push({ id: pdu.id, name: pdu.name, rack: pdu.rack || "", temperature, humidity, leak });
  }
  const temps = sensors.map(s => s.temperature).filter(finite);
  const hums = sensors.map(s => s.humidity).filter(finite);
  const leaks = sensors.filter(s => s.leak != null);
  const tempMax = temps.length ? Math.max(...temps) : null;
  const humMax = hums.length ? Math.max(...hums) : null;
  const leak = leaks.some(s => s.leak === true);
  const tempLevel = tempMax == null ? "idle" : tempMax > TEMP_ALARM_C ? "alarm" : tempMax > TEMP_WARN_C ? "warn" : "ok";
  const humLevel = humMax == null ? "idle" : humMax > HUMIDITY_WARN ? "warn" : "ok";
  const leakLevel = !leaks.length ? "idle" : leak ? "alarm" : "ok";
  const order = ["alarm", "warn", "ok", "idle"];
  const level = [tempLevel, humLevel, leakLevel].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return { sensors, hasSensors: sensors.length > 0, tempMin: temps.length ? Math.min(...temps) : null, tempMax,
    humMin: hums.length ? Math.min(...hums) : null, humMax, leak, leakSensors: leaks.length, tempLevel, humLevel, leakLevel, level };
}

// The headline numbers. Servers without an on/off reading (PDU unreachable, outlet unknown, first read pending) count
// as "no reading", so ON + OFF + no reading is every server.
export function kpis({ devices = [], pduStatuses = {}, kvmStatuses = {}, servers = [], maintenance = null }) {
  const pdus = devices.filter(d => d.kind === "pdu");
  const kvms = devices.filter(d => d.kind === "kvm");
  let on = 0, off = 0;
  for (const server of servers) {
    const visual = serverVisualState(server, pduStatuses[server.pduId], null);
    if (visual.state === "on") on++;
    else if (visual.state === "off") off++;
  }
  const loads = pdus.map(p => pduLoad(p, pduStatuses[p.id]));
  const known = loads.filter(l => l.watts != null);
  const watts = known.length ? known.reduce((sum, l) => sum + l.watts, 0) : null;
  const complete = pdus.length > 0 && pdus.every(p => pduStatuses[p.id]?.reachable === true && pduStatuses[p.id]?.watts_complete === true);
  return {
    servers: { on, off, noReading: servers.length - on - off, total: servers.length },
    pdus: { reachable: pdus.filter(p => pduStatuses[p.id]?.reachable === true).length, total: pdus.length,
      read: pdus.filter(p => pduStatuses[p.id] != null).length,
      maintenance: pdus.filter(p => maintenance?.pdus?.[String(p.id)]).length },
    kvms: { reachable: kvms.filter(k => kvmStatuses[k.id]?.reachable === true).length, total: kvms.length,
      read: kvms.filter(k => kvmStatuses[k.id] != null).length },
    power: { watts, complete, known: known.length },
    loads: loads.sort((a, b) => naturalCompare(a.name, b.name)),
  };
}

// Open email alerts: the newest message per subject title is an "[DCIM alert]" (a later "[DCIM recovered]" closes it).
export function openAlerts(recent) {
  const seen = new Set();
  const open = [];
  const rows = asArray(recent).filter(r => r && typeof r.subject === "string")
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  for (const row of rows) {
    const match = /^\[DCIM (alert|recovered)\]\s*(.*)$/i.exec(row.subject.trim());
    if (!match) continue;
    const title = match[2].trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    if (match[1].toLowerCase() === "alert") open.push({ id: row.id || title, title, at: Date.parse(row.created_at) || null });
  }
  return open;
}

const SEVERITY = { alarm: 0, warn: 1, info: 2 };
const KIND_ORDER = ["leak", "temperature", "alert", "pdu", "ping", "kvm", "humidity", "monitor", "maintenance"];

// Everything that needs a look, most severe first: unreachable devices, servers that stopped answering ping, open
// alerts, sensors past a threshold, maintenance in progress. Each entry: {key, severity, kind, title, detail}.
export function attentionItems({ devices = [], pduStatuses = {}, kvmStatuses = {}, maintenance = null, monitoring = null, env = null, now = Date.now() }) {
  const items = [];
  const add = (key, severity, kind, title, detail = "") => items.push({ key, severity, kind, title, detail });
  const servers = buildServers(devices.filter(d => d.kind === "pdu"), pduStatuses);
  for (const d of devices) {
    if (d.kind !== "pdu" && d.kind !== "kvm") continue;
    const status = d.kind === "pdu" ? pduStatuses[d.id] : kvmStatuses[d.id];
    const state = status == null ? "loading" : deviceState(status);
    const where = d.rack ? `${d.rack} · ` : "";
    if (d.kind === "pdu") {
      const count = servers.filter(s => s.pduId === d.id).length;
      const impact = count ? `${count} ${count === 1 ? "server has" : "servers have"} no power reading` : "No power reading";
      if (state === "offline") add(`pdu:${d.id}`, "alarm", "pdu", `${d.name} unreachable`, `${where}${impact}`);
      else if (state === "unavailable") add(`pdu:${d.id}`, "warn", "pdu", `${d.name}: status not available`, `${where}${impact}`);
      else if (state === "error") add(`pdu:${d.id}`, "warn", "pdu", `${d.name} reports an error`, `${where}Readings may be incomplete`);
    } else {
      if (state === "offline") add(`kvm:${d.id}`, "warn", "kvm", `${d.name} unreachable`, `${where}Remote consoles are unavailable`);
      else if (state === "unavailable") add(`kvm:${d.id}`, "warn", "kvm", `${d.name}: status not available`, `${where}Console state unknown`);
      else if (state === "error") add(`kvm:${d.id}`, "warn", "kvm", `${d.name} reports an error`, `${where}Remote consoles may not open`);
    }
  }
  const pduNames = new Map(devices.filter(d => d.kind === "pdu").map(d => [String(d.id), d]));
  for (const [id, state] of Object.entries(asObject(maintenance?.pdus))) {
    const pdu = pduNames.get(String(id));
    const since = finite(state?.started_at) ? ` since ${clockTime(state.started_at * 1000)}` : "";
    const who = state?.started_by ? ` by ${state.started_by}` : "";
    const why = state?.reason ? ` · ${String(state.reason).slice(0, 80)}` : "";
    add(`maint:${id}`, "info", "maintenance", `${pdu?.name || id} in maintenance`, `${pdu?.rack ? `${pdu.rack} · ` : ""}Outlets switched off${since}${who}${why}`);
  }
  if (monitoring) {
    for (const t of asArray(monitoring.targets)) {
      if (!t || t.enabled === false) continue;
      const where = t.rack ? `${t.rack} · ` : "";
      const lastUp = t.last_up_at ? `last answered ${relativeAge(now - Date.parse(t.last_up_at))}` : "no reply yet";
      if (t.status === "down") add(`ping:${t.id}`, "alarm", "ping", `${t.name} not answering ping`, `${where}${lastUp}`);
      else if (t.status === "stale" && t.last_result === "down") add(`ping:${t.id}`, "warn", "ping", `${t.name}: last ping failed`, `${where}Check overdue · ${lastUp}`);
      else if (t.status === "error") add(`ping:${t.id}`, "warn", "ping", `${t.name}: ping probe error`, `${where}The check itself failed`);
    }
    if (monitoring.service === "error" || monitoring.service === "overdue") {
      add("monitor:service", "warn", "monitor", "Ping Monitor checks are overdue", monitoring.service === "error" ? "The last monitoring run failed" : "No check ran on schedule");
    }
    for (const alert of openAlerts(monitoring.email_alerts?.recent)) {
      add(`alert:${alert.id}`, "alarm", "alert", alert.title, alert.at ? `Alert sent ${relativeAge(now - alert.at)}` : "Alert sent");
    }
  }
  if (env?.hasSensors) {
    for (const s of env.sensors) {
      const where = s.rack ? `${s.rack} · ${s.name}` : s.name;
      if (s.leak === true) add(`leak:${s.id}`, "alarm", "leak", "Water leak detected", where);
      if (s.temperature != null && s.temperature > TEMP_ALARM_C) add(`temp:${s.id}`, "alarm", "temperature", `Temperature ${formatNumber(s.temperature, 1)} °C`, `${where} · above ${TEMP_ALARM_C} °C`);
      else if (s.temperature != null && s.temperature > TEMP_WARN_C) add(`temp:${s.id}`, "warn", "temperature", `Temperature ${formatNumber(s.temperature, 1)} °C`, `${where} · above ${TEMP_WARN_C} °C`);
      if (s.humidity != null && s.humidity > HUMIDITY_WARN) add(`hum:${s.id}`, "warn", "humidity", `Humidity ${formatNumber(s.humidity, 0)} %`, `${where} · above ${HUMIDITY_WARN} %`);
    }
  }
  return items.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || naturalCompare(a.title, b.title));
}

// KVM ports with an open console from this site ("IN USE"): who is working now, by server.
export function consolesInUse(devices = [], kvmStatuses = {}) {
  const rows = [];
  for (const kvm of devices) {
    if (kvm.kind !== "kvm") continue;
    for (const port of asArray(kvmStatuses[kvm.id]?.ports)) {
      if (!port?.in_use) continue;
      const label = String(port.label || "").trim();
      rows.push({ key: `${kvm.id}:${port.number}`, server: label && !/^port\s*\d+$/i.test(label) ? label : `Port ${port.number}`, kvm: kvm.name, port: port.number, rack: kvm.rack || "" });
    }
  }
  return rows.sort((a, b) => naturalCompare(a.server, b.server) || naturalCompare(a.kvm, b.kvm));
}

const MAINT_TEXT = { shutdown: "maintenance started", restore: "maintenance ended" };
const INCIDENT_END = { recovered: "answering ping again", paused: "ping check paused", address_changed: "ping address changed" };

// Recent changes, newest first and at most TICKER_MAX: maintenance shutdowns / restores and ping incidents.
export function recentChanges({ devices = [], maintenance = null, incidents = null }) {
  const names = new Map(devices.map(d => [String(d.id), d.name]));
  const rows = [];
  for (const entry of asArray(maintenance?.log)) {
    const text = MAINT_TEXT[entry?.action];
    if (!text || !finite(entry.at)) continue;
    const who = entry.by ? ` · ${entry.by}` : "";
    rows.push({ key: `m:${entry.at}:${entry.device_id}:${entry.action}`, at: entry.at * 1000, kind: entry.action === "shutdown" ? "warn" : "ok",
      text: `${names.get(String(entry.device_id)) || entry.device_id} ${text}${who}` });
  }
  for (const incident of asArray(incidents)) {
    if (!incident?.id) continue;
    const started = Date.parse(incident.first_failed_at);
    const ended = Date.parse(incident.ended_at);
    if (Number.isFinite(ended)) {
      rows.push({ key: `i:${incident.id}:end`, at: ended, kind: incident.end_reason === "recovered" ? "ok" : "info",
        text: `${incident.name} ${INCIDENT_END[incident.end_reason] || "ping incident closed"}` });
    }
    if (Number.isFinite(started)) rows.push({ key: `i:${incident.id}:start`, at: started, kind: "alarm", text: `${incident.name} stopped answering ping` });
  }
  return rows.sort((a, b) => b.at - a.at || naturalCompare(a.key, b.key)).slice(0, TICKER_MAX);
}

// ── layout: what fits without scrolling ──

// Rack grid: the column/row arrangement that gives the biggest cards for `count` items in width x height (px); when
// they cannot all fit at the minimum size, the most that fit is one page and the rest rotate.
export function gridLayout(count, width, height, { minW, minH, maxH = Infinity, gap = 0 }) {
  if (!(width > 0) || !(height > 0) || !(minW > 0) || !(minH > 0)) return { cols: 1, rows: 1, perPage: 1, cellH: Math.max(0, height || 0) };
  const maxCols = Math.max(1, Math.floor((width + gap) / (minW + gap)));
  const maxRows = Math.max(1, Math.floor((height + gap) / (minH + gap)));
  const capacity = maxCols * maxRows;
  const n = Math.max(1, Math.min(count, capacity));
  let best = null;
  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(n / cols);
    if (rows > maxRows) continue;
    const w = (width - gap * (cols - 1)) / cols;
    const h = Math.min(maxH, (height - gap * (rows - 1)) / rows);
    const score = Math.min(w / minW, h / minH);
    if (!best || score > best.score + 1e-9) best = { cols, rows, score };
  }
  const { cols, rows } = count > capacity ? { cols: maxCols, rows: maxRows } : best;
  const cellH = Math.floor(Math.min(maxH, (height - gap * (rows - 1)) / rows));
  return { cols, rows, perPage: count > capacity ? capacity : Math.max(n, 1), cellH };
}

// How many fixed-height rows fit in `height` px.
export function rowsThatFit(height, rowH, gap = 0) {
  if (!(height > 0) || !(rowH > 0)) return 1;
  return Math.max(1, Math.floor((height + gap) / (rowH + gap)));
}

// The page of `items` shown at rotation step `tick`.
export function pageOf(items, perPage, tick = 0) {
  const list = asArray(items);
  const size = Math.max(1, Math.floor(perPage) || 1);
  const pages = Math.max(1, Math.ceil(list.length / size));
  const page = ((Math.floor(tick) % pages) + pages) % pages;
  return { items: list.slice(page * size, page * size + size), page, pages };
}

// ── text ──

export function relativeAge(ms) {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function formatNumber(value, digits = 0) {
  return finite(value) ? value.toFixed(digits) : "—";
}

export function formatKw(watts) {
  if (!finite(watts)) return "—";
  return watts >= 10_000 ? (watts / 1000).toFixed(1) : (watts / 1000).toFixed(2);
}

export function formatRange(min, max, digits = 0) {
  if (!finite(min) || !finite(max)) return "—";
  return min.toFixed(digits) === max.toFixed(digits) ? max.toFixed(digits) : `${min.toFixed(digits)}–${max.toFixed(digits)}`;
}

const pad = n => String(n).padStart(2, "0");
export function clockTime(ms, seconds = false) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ""}`;
}

// A change's time: "14:32" today, "24 Oct 14:32" before.
export function changeTime(ms, now = Date.now()) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return new Date(now).toDateString() === d.toDateString() ? clockTime(ms)
    : `${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })} ${clockTime(ms)}`;
}

export function longDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// The connection line under the clock. lastSuccess: ms of the last complete data cycle (0 = none yet).
export function connectionState({ state, lastSuccess, now }) {
  const age = lastSuccess ? now - lastSuccess : Infinity;
  const stale = lastSuccess > 0 && age > STALE_MS;
  if (state === "signed-out") return { level: "alarm", text: "Signed out", stale };
  if (state === "connecting" && !lastSuccess) return { level: "idle", text: "Connecting…", stale: false };
  if (state === "online") return { level: stale ? "warn" : "ok", text: "Live", stale };
  return { level: stale ? "alarm" : "warn", text: stale ? "Connection lost" : "Reconnecting…", stale };
}

// Keeps the statuses of devices that still exist (a removed device's reading never piles up).
export function pruneStatuses(statuses, ids) {
  const keep = new Set([...ids].map(String));
  const out = {};
  for (const [id, value] of Object.entries(asObject(statuses))) if (keep.has(String(id))) out[id] = value;
  return out;
}
