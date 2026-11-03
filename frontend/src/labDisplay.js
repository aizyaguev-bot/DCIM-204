// Lab display (?tab=display): the read-only wall TV screen at the lab entrance. Pure helpers only (no DOM, no React),
// so node:test covers them (src/__tests__/lab-display.test.js). The page itself is pages/LabDisplay.jsx.
import { deviceState } from "./api/client.js";
import { rackSummary, serverVisualState } from "./components/racks/rackView.js";
import { MAIN_STORAGE } from "./api/inventory.js";

export const REFRESH_MS = 15_000;        // one data cycle, like the rest of the site
export const STALE_MS = 60_000;          // older data than this: the page is "NOT LIVE" (banner, greyed panels)
export const STALE_ALARM_MS = 5 * 60_000; // not live for this long: the banner turns from warning to alarm
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
// Row heights in em of the display's base size (16 px at 1920 x 1080); the page sets them inline and fits lists with
// the same numbers. Sized for a 24-inch monitor read from 2-3 m (index.css): nine rack cards (three across) and five
// Attention rows at 1920 x 1080 with the maintenance band shown (the rows then share the panel height).
export const ROW_EM = { attention: 5.8, strip: 2.6 };
export const RACK_CARD_EM = { minW: 17, minH: 10, maxH: 12.5, gap: 0.7 };
// More racks than fit at that size: compact cards (name and on / total, state), twelve on a page at 1920 x 1080.
export const RACK_CARD_COMPACT_EM = { minW: 16, minH: 6.2, maxH: 8.5, gap: 0.6 };
// The lab's own time zone: a TV stick or mini-PC set to UTC still shows lab time.
export const LAB_TZ = "Asia/Jerusalem";
export const LIST_GAP_EM = 0.45;
// The two one-line strips along the bottom: one entry per this much strip width (em).
export const STRIP_ITEM_EM = { inUse: 24, changes: 40 };

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

// Sentences as parts: {text} is the page's own English, {text, user: true} is text people typed (rack, device and
// server names, who, why). The page shows each user part in its own <bdi dir="auto">, so a Hebrew name or reason
// keeps its place in the English sentence instead of swapping with its neighbours.
const own = text => ({ text: String(text) });
const typed = text => ({ text: String(text), user: true });
export const partsText = parts => asArray(parts).map(p => p?.text ?? "").join("");
const rackPrefix = rack => (rack ? [typed(rack), own(" · ")] : []);

// One server fed by more than one outlet with the same label (a server's two PSUs on two PDUs, or two outlets of one
// PDU): it is on when any feed is on, off when a feed is off and none is on, and unknown only when no feed reports on
// or off; its watts add up over the feeds that report them (null when none does). The PDU and outlet it names are
// those of the first feed whose state is the server's state (the first feed when unknown), so "Outlet 3 of PDU 05 is
// on" is always true and an unreachable first PDU never hides a live second one. Name and rack: the first feed's.
// DcimView's `servers` uses the same rule.
const FEED_FIELDS = ["pduId", "pduName", "pduIp", "outlet"];
export function mergeServerFeeds(feeds) {
  const list = asArray(feeds).filter(Boolean);
  if (!list.length) return null;
  const state = list.some(f => f.state === "on") ? "on" : list.some(f => f.state === "off") ? "off" : list[0].state ?? "unknown";
  const shown = list.find(f => f.state === state) || list[0];
  const watts = list.filter(f => finite(f.watts));
  const merged = { ...list[0], state, watts: watts.length ? watts.reduce((sum, f) => sum + f.watts, 0) : null };
  for (const field of FEED_FIELDS) if (field in shown) merged[field] = shown[field];
  return merged;
}

// Servers as the Racks page lists them (DcimView `servers`): every PDU outlet whose label names a server. A reachable
// PDU's live outlets win over saved labels; a moved server (rack overrides) belongs to its new rack; a server on more
// than one outlet is one server (mergeServerFeeds).
export function buildServers(pdus, pduStatuses = {}, rackOverrides = {}) {
  const feeds = new Map();
  const add = (key, feed) => { const list = feeds.get(key); if (list) list.push(feed); else feeds.set(key, [feed]); };
  const overrides = asObject(rackOverrides);
  for (const pdu of pdus || []) {
    const status = pduStatuses[pdu.id];
    const live = status?.reachable ? asArray(status.outlets) : [];
    const liveByN = new Map(live.map(o => [String(o.number), o]));
    const rackOf = key => (typeof overrides[key] === "string" && overrides[key]) || pdu.rack || "—";
    for (const [num, label] of Object.entries(asObject(pdu.labels))) {
      if (liveByN.has(num) || !isServerLabel(label)) continue;
      const key = String(label).trim().toLowerCase();
      add(key, { id: key, name: String(label).trim(), rack: rackOf(key), pduId: pdu.id, pduName: pdu.name, outlet: parseInt(num, 10), state: "unknown", watts: null });
    }
    for (const o of live) {
      if (!isServerLabel(o.label)) continue;
      const key = String(o.label).trim().toLowerCase();
      add(key, { id: key, name: String(o.label).trim(), rack: rackOf(key), pduId: pdu.id, pduName: pdu.name, outlet: o.number, state: o.state, watts: o.watts ?? null });
    }
  }
  return [...feeds.values()].map(mergeServerFeeds).sort((a, b) => naturalCompare(a.name, b.name));
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

// Rack cards: one per rack named by a PDU or a rack device, in natural order (Rack-2 before Rack-10). A rack's level
// is the worst of its power state and what its sensors and Ping Monitor report; `reason` names the top one ("Water
// leak", "37 °C", "2 not answering ping", "Unreachable", "Maintenance", "Online"). `noReading` counts every server
// without an on/off reading (PDU unreachable, outlet unknown or first reading pending), so on + off + noReading = total.
const RANK = { alarm: 4, maint: 3, warn: 2, ok: 1, idle: 0 };
export function buildRacks(devices, pduStatuses = {}, servers = [], maintenance = null, { sensors = [], attention = [] } = {}) {
  const rackDevices = (devices || []).filter(d => (d.kind === "pdu" || d.kind === "rack") && d.rack);
  const names = [...new Set(rackDevices.map(d => d.rack))].sort(naturalCompare);
  return names.map(rack => {
    const ownDevices = rackDevices.filter(d => d.rack === rack);
    const shared = rackDevices.filter(d => d.kind === "pdu" && d.rack !== rack && String(d.notes || "").split(",").map(s => s.trim()).includes(`shared:${rack}`));
    const pduData = [...ownDevices, ...shared].filter(d => d.kind === "pdu").map(d => ({ id: d.id, name: d.name }));
    const rackType = rack === MAIN_STORAGE || ownDevices[0]?.model === "Storage" ? "storage" : "compute";   // DcimView rackStats rule
    const loads = pduData.map(p => pduLoad(p, pduStatuses[p.id]));
    const watts = loads.some(l => l.watts != null) ? loads.reduce((sum, l) => sum + (l.watts ?? 0), 0) : null;
    const wattsComplete = pduData.length > 0 && pduData.every(p => pduStatuses[p.id]?.reachable === true && pduStatuses[p.id]?.watts_complete === true);
    const rackServers = servers.filter(s => s.rack === rack);
    const summary = rackSummary({ rackType, pduData, servers: rackServers, wattsComplete }, { pduStatuses, maintenance });
    const noReading = summary.total - summary.on - summary.off;
    const inMaintenance = summary.maintenancePdus.length > 0;
    const base = summary.status === "online" ? { level: "ok", reason: "Online" }
      : summary.status === "loading" ? { level: "idle", reason: "Reading…" }
      : summary.status === "no-pdu" ? { level: "idle", reason: "No PDU" }
      : summary.status === "storage" ? { level: "idle", reason: "" }
      : { level: "idle", reason: summary.statusText };
    // Each issue: its level, its place among issues of the same level (lower first) and the words on the card.
    const issues = [];
    if (summary.status === "offline") issues.push({ level: "alarm", order: 3, reason: "Unreachable" });
    else if (summary.status === "unavailable") issues.push({ level: "warn", order: 3, reason: "No reading" });
    else if (summary.status === "online" && noReading > 0) issues.push({ level: "warn", order: 3, reason: "Partial reading" });
    if (inMaintenance) issues.push({ level: "maint", order: -1, reason: "Maintenance" });
    // A PDU of this rack drawing near its rating (the display has no per-PDU panel: the card and Attention say it).
    const peak = loads.reduce((max, l) => (l.pct != null && l.pct > (max?.pct ?? -1) ? l : max), null);
    if (peak && peak.pct >= LOAD_WARN_PCT) issues.push({ level: peak.pct >= LOAD_ALARM_PCT ? "alarm" : "warn", order: 2, reason: `Load ${formatNumber(peak.pct, 0)} %` });
    for (const s of asArray(sensors)) {
      if (s?.rack !== rack) continue;
      if (s.leak === true) issues.push({ level: "alarm", order: 0, reason: "Water leak" });
      if (finite(s.temperature) && s.temperature > TEMP_ALARM_C) issues.push({ level: "alarm", order: 1, reason: `${formatNumber(s.temperature, 0)} °C` });
      else if (finite(s.temperature) && s.temperature > TEMP_WARN_C) issues.push({ level: "warn", order: 1, reason: `${formatNumber(s.temperature, 0)} °C` });
      if (finite(s.humidity) && s.humidity > HUMIDITY_WARN) issues.push({ level: "warn", order: 6, reason: `Humidity ${formatNumber(s.humidity, 0)} %` });
    }
    const mine = asArray(attention).filter(i => i?.rack === rack);
    const pingDown = mine.filter(i => i.kind === "ping" && i.severity === "alarm").length;
    const pingLate = mine.filter(i => i.kind === "ping" && i.severity !== "alarm").length;
    // Servers a maintenance switched off stop answering ping: expected while the rack is in maintenance.
    if (pingDown) issues.push({ level: inMaintenance ? "maint" : "alarm", order: 4, reason: `${pingDown} not answering ping` });
    if (pingLate) issues.push({ level: inMaintenance ? "maint" : "warn", order: 5, reason: `${pingLate} ping ${pingLate === 1 ? "check" : "checks"} failed` });
    if (mine.some(i => i.kind === "kvm")) issues.push({ level: "warn", order: 7, reason: "KVM unreachable" });
    // A PDU that answers with an error (the unreachable / no reading states are counted above).
    if (summary.status === "online" && mine.some(i => i.kind === "pdu")) issues.push({ level: "warn", order: 3, reason: "PDU error" });
    issues.sort((a, b) => RANK[b.level] - RANK[a.level] || a.order - b.order);
    const top = issues[0] && RANK[issues[0].level] >= RANK[base.level] ? issues[0] : base;
    return { rack, storage: rackType === "storage", status: summary.status, statusText: summary.statusText,
      level: top.level, reason: top.reason, issues: issues.map(i => i.reason),
      total: summary.total, on: summary.on, off: summary.off, noReading,
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

const LOAD_ORDER = { alarm: 0, warn: 1 };

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
    // Problems first (an unreachable PDU is never on a later page), then by name.
    loads: loads.sort((a, b) => (LOAD_ORDER[a.level] ?? 2) - (LOAD_ORDER[b.level] ?? 2) || naturalCompare(a.name, b.name)),
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
const KIND_ORDER = ["leak", "temperature", "alert", "pdu", "load", "ping", "kvm", "humidity", "monitor"];

// Everything that needs a look, most severe first: unreachable devices, servers that stopped answering ping, open
// alerts, sensors past a threshold. Maintenance has its own band (maintenanceEntries). Each entry: {key, severity,
// kind, rack, titleParts, parts} plus title / detail as plain text. monitoringUnknownSince (ms): Ping Monitor data
// could not be read since then, so its ping and alert items are left out and one warning says so.
export function attentionItems({ devices = [], pduStatuses = {}, kvmStatuses = {}, monitoring = null, env = null, now = Date.now(), monitoringUnknownSince = null }) {
  const items = [];
  const add = (key, severity, kind, rack, titleParts, parts = []) =>
    items.push({ key, severity, kind, rack: rack || "", titleParts, parts, title: partsText(titleParts), detail: partsText(parts) });
  const servers = buildServers(devices.filter(d => d.kind === "pdu"), pduStatuses);
  for (const d of devices) {
    if (d.kind !== "pdu" && d.kind !== "kvm") continue;
    const status = d.kind === "pdu" ? pduStatuses[d.id] : kvmStatuses[d.id];
    const state = status == null ? "loading" : deviceState(status);
    const where = rackPrefix(d.rack);
    const name = typed(d.name);
    if (d.kind === "pdu") {
      const count = servers.filter(s => s.pduId === d.id).length;
      const impact = own(count ? `No reading from ${count} ${count === 1 ? "server" : "servers"}` : "No power reading");
      if (state === "offline") add(`pdu:${d.id}`, "alarm", "pdu", d.rack, [name, own(" unreachable")], [...where, impact]);
      else if (state === "unavailable") add(`pdu:${d.id}`, "warn", "pdu", d.rack, [name, own(": status not available")], [...where, impact]);
      else if (state === "error") add(`pdu:${d.id}`, "warn", "pdu", d.rack, [name, own(" reports an error")], [...where, own("Readings may be incomplete")]);
      // Load near the PDU's rating (Racks page bands): warning from LOAD_WARN_PCT, alarm from LOAD_ALARM_PCT.
      const load = status == null ? null : pduLoad(d, status);
      if (load?.pct != null && load.pct >= LOAD_WARN_PCT) {
        add(`load:${d.id}`, load.pct >= LOAD_ALARM_PCT ? "alarm" : "warn", "load", d.rack, [name, own(` load ${formatNumber(load.pct, 0)} %`)],
          [...where, own(`${formatNumber(load.amps, 1)} A of ${RATED_AMPS} A${load.estimated ? " (estimated)" : ""}`)]);
      }
    } else {
      if (state === "offline") add(`kvm:${d.id}`, "warn", "kvm", d.rack, [name, own(" unreachable")], [...where, own("Remote consoles are unavailable")]);
      else if (state === "unavailable") add(`kvm:${d.id}`, "warn", "kvm", d.rack, [name, own(": status not available")], [...where, own("Console state unknown")]);
      else if (state === "error") add(`kvm:${d.id}`, "warn", "kvm", d.rack, [name, own(" reports an error")], [...where, own("Remote consoles may not open")]);
    }
  }
  if (monitoringUnknownSince != null) {
    add("monitor:data", "warn", "monitor", "", [own(`Ping Monitor data not available since ${clockTime(monitoringUnknownSince)}`)],
      [own("Ping and alert items are left out until it answers again")]);
  } else if (monitoring) {
    for (const t of asArray(monitoring.targets)) {
      if (!t || t.enabled === false) continue;
      const where = rackPrefix(t.rack);
      const lastUp = own(t.last_up_at ? `last answered ${relativeAge(now - Date.parse(t.last_up_at))}` : "no reply yet");
      if (t.status === "down") add(`ping:${t.id}`, "alarm", "ping", t.rack, [typed(t.name), own(" not answering ping")], [...where, lastUp]);
      else if (t.status === "stale" && t.last_result === "down") add(`ping:${t.id}`, "warn", "ping", t.rack, [typed(t.name), own(": last ping failed")], [...where, own("Check overdue · "), lastUp]);
      else if (t.status === "error") add(`ping:${t.id}`, "warn", "ping", t.rack, [typed(t.name), own(": ping probe error")], [...where, own("The check itself failed")]);
    }
    if (monitoring.service === "error" || monitoring.service === "overdue") {
      add("monitor:service", "warn", "monitor", "", [own("Ping Monitor checks are overdue")], [own(monitoring.service === "error" ? "The last monitoring run failed" : "No check ran on schedule")]);
    }
    for (const alert of openAlerts(monitoring.email_alerts?.recent)) {
      add(`alert:${alert.id}`, "alarm", "alert", "", [typed(alert.title)], [own(alert.at ? `Alert sent ${relativeAge(now - alert.at)}` : "Alert sent")]);
    }
  }
  if (env?.hasSensors) {
    for (const s of env.sensors) {
      const where = s.rack ? [typed(s.rack), own(" · "), typed(s.name)] : [typed(s.name)];
      if (s.leak === true) add(`leak:${s.id}`, "alarm", "leak", s.rack, [own("Water leak detected")], where);
      if (s.temperature != null && s.temperature > TEMP_ALARM_C) add(`temp:${s.id}`, "alarm", "temperature", s.rack, [own(`Temperature ${formatNumber(s.temperature, 1)} °C`)], [...where, own(` · above ${TEMP_ALARM_C} °C`)]);
      else if (s.temperature != null && s.temperature > TEMP_WARN_C) add(`temp:${s.id}`, "warn", "temperature", s.rack, [own(`Temperature ${formatNumber(s.temperature, 1)} °C`)], [...where, own(` · above ${TEMP_WARN_C} °C`)]);
      if (s.humidity != null && s.humidity > HUMIDITY_WARN) add(`hum:${s.id}`, "warn", "humidity", s.rack, [own(`Humidity ${formatNumber(s.humidity, 0)} %`)], [...where, own(` · above ${HUMIDITY_WARN} %`)]);
    }
  }
  return items.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || naturalCompare(a.title, b.title));
}

// Outlet numbers as short runs: [1, 2, 3, 5] -> "1–3, 5".
export function outletRuns(numbers) {
  const sorted = [...new Set(asArray(numbers).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : b === a + 1 ? `${a}, ${b}` : `${a}–${b}`)).join(", ");
}

// Maintenance in progress, one entry per PDU: "Rack-03 · PDU 03 · outlets 1, 2 off since 11:34 · admin · reason".
export function maintenanceEntries({ devices = [], maintenance = null }) {
  const pdus = new Map(devices.filter(d => d.kind === "pdu").map(d => [String(d.id), d]));
  const rows = [];
  for (const [id, state] of Object.entries(asObject(maintenance?.pdus))) {
    const pdu = pdus.get(String(id));
    const outlets = outletRuns(state?.outlets_off);
    const count = asArray(state?.outlets_off).length;
    const since = finite(state?.started_at) ? ` since ${clockTime(state.started_at * 1000)}` : "";
    const parts = [...rackPrefix(pdu?.rack), typed(pdu?.name || id), own(" · "),
      own(`${outlets ? `${count === 1 ? "outlet" : "outlets"} ${outlets}` : "outlets"} off${since}`)];
    const failed = asArray(state?.failed).length;
    if (failed) parts.push(own(` · ${failed} did not switch off`));
    if (state?.started_by) parts.push(own(" · "), typed(state.started_by));
    // head: where, when and who; reason: why, shown apart so a long one is cut at its own end (also in Hebrew).
    const head = [...parts];
    const reason = state?.reason ? String(state.reason).slice(0, 120) : "";
    if (reason) parts.push(own(" · "), typed(reason));
    rows.push({ key: `maint:${id}`, rack: pdu?.rack || "", name: pdu?.name || String(id), parts, head, reason, text: partsText(parts) });
  }
  return rows.sort((a, b) => naturalCompare(a.rack, b.rack) || naturalCompare(a.name, b.name));
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
    const parts = [typed(names.get(String(entry.device_id)) || entry.device_id), own(` ${text}`), ...(entry.by ? [own(" · "), typed(entry.by)] : [])];
    rows.push({ key: `m:${entry.at}:${entry.device_id}:${entry.action}`, at: entry.at * 1000, kind: entry.action === "shutdown" ? "warn" : "ok",
      parts, text: partsText(parts) });
  }
  for (const incident of asArray(incidents)) {
    if (!incident?.id) continue;
    const started = Date.parse(incident.first_failed_at);
    const ended = Date.parse(incident.ended_at);
    if (Number.isFinite(ended)) {
      const parts = [typed(incident.name), own(` ${INCIDENT_END[incident.end_reason] || "ping incident closed"}`)];
      rows.push({ key: `i:${incident.id}:end`, at: ended, kind: incident.end_reason === "recovered" ? "ok" : "info", parts, text: partsText(parts) });
    }
    if (Number.isFinite(started)) {
      const parts = [typed(incident.name), own(" stopped answering ping")];
      rows.push({ key: `i:${incident.id}:start`, at: started, kind: "alarm", parts, text: partsText(parts) });
    }
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

// The rack grid at the normal card size, or compact cards when the racks would need more than one page of normal ones.
export function rackGrid(count, width, height, em) {
  const scaled = size => ({ minW: size.minW * em, minH: size.minH * em, maxH: size.maxH * em, gap: size.gap * em });
  const normal = gridLayout(count, width, height, scaled(RACK_CARD_EM));
  if (count <= normal.perPage) return { ...normal, compact: false, gapEm: RACK_CARD_EM.gap };
  return { ...gridLayout(count, width, height, scaled(RACK_CARD_COMPACT_EM)), compact: true, gapEm: RACK_CARD_COMPACT_EM.gap };
}

// How many fixed-height rows fit in `height` px.
export function rowsThatFit(height, rowH, gap = 0) {
  if (!(height > 0) || !(rowH > 0)) return 1;
  return Math.max(1, Math.floor((height + gap) / (rowH + gap)));
}

// A list that fills its box: how many rows of rowH px fit and, when the page is full (count >= rows), the row height
// that shares the whole box among them (at most maxScale x rowH), so a full list ends at the bottom of its panel.
export function fillRows(height, rowH, gap = 0, count = Infinity, maxScale = 1.4) {
  const rows = rowsThatFit(height, rowH, gap);
  if (!(height > 0) || !(rowH > 0) || count < rows) return { rows, rowH };
  return { rows, rowH: Math.max(rowH, Math.floor(Math.min(rowH * maxScale, (height - gap * (rows - 1)) / rows) * 10) / 10) };
}

// The page of `items` shown at rotation step `tick`.
export function pageOf(items, perPage, tick = 0) {
  const list = asArray(items);
  const size = Math.max(1, Math.floor(perPage) || 1);
  const pages = Math.max(1, Math.ceil(list.length / size));
  const page = ((Math.floor(tick) % pages) + pages) % pages;
  return { items: list.slice(page * size, page * size + size), page, pages };
}

// Attention paging: alarms are pinned to the first rows of every page and only the other items rotate below them;
// every page is full (the last one wraps round to the first items).
// When there are more alarms than rows, the alarms turn pages among themselves and the last row counts the alarms
// not shown (moreAlarms). `more`: items not on this page.
export function pinnedPage(items, rows, tick = 0) {
  const list = asArray(items);
  const size = Math.max(1, Math.floor(rows) || 1);
  if (list.length <= size) return { items: list, moreAlarms: 0, more: 0, page: 0, pages: 1 };
  const alarms = list.filter(i => i?.severity === "alarm");
  const rest = list.filter(i => i?.severity !== "alarm");
  if (alarms.length > size) {
    // Every page is full: a window of size - 1 alarms that wraps around the list, so no page shows fewer alarms.
    const per = Math.max(1, size - 1);
    const pages = Math.ceil(alarms.length / per);
    const page = ((Math.floor(tick) % pages) + pages) % pages;
    const shown = Array.from({ length: per }, (_, i) => alarms[(page * per + i) % alarms.length]);
    return { items: shown, moreAlarms: alarms.length - shown.length, more: list.length - shown.length, page, pages };
  }
  if (alarms.length === size) return { items: alarms, moreAlarms: 0, more: rest.length, page: 0, pages: 1 };
  // Every page is full: the last one wraps round to the start of the rest, so the panel never ends half empty.
  const per = size - alarms.length;
  const pages = Math.ceil(rest.length / per);
  const page = ((Math.floor(tick) % pages) + pages) % pages;
  const shown = Array.from({ length: per }, (_, i) => rest[(page * per + i) % rest.length]);
  return { items: [...alarms, ...shown], moreAlarms: 0, more: rest.length - shown.length, page, pages };
}

// The lab in one word for the top bar: ALL NORMAL, N WARNINGS or N ALARMS.
export function labStatus(items) {
  const alarms = asArray(items).filter(i => i?.severity === "alarm").length;
  const warnings = asArray(items).filter(i => i?.severity === "warn").length;
  if (alarms) return { level: "alarm", text: `${alarms} ${alarms === 1 ? "ALARM" : "ALARMS"}`, alarms, warnings };
  if (warnings) return { level: "warn", text: `${warnings} ${warnings === 1 ? "WARNING" : "WARNINGS"}`, alarms, warnings };
  return { level: "ok", text: "ALL NORMAL", alarms, warnings };
}

// A data source (maintenance, monitoring, incidents, rack overrides) after one read. A success keeps its value; a
// source the server does not offer (404) or allow (403) is "absent"; a failure keeps the last good copy until
// `limit` ms after the last success, then the source is "unknown" (value null) since that success (or the first try).
export function sourceAfter(previous, result, now, limit = STALE_MS) {
  const first = previous?.firstTry ?? now;
  if (result.ok) return { state: "ok", value: result.value, lastOk: now, since: null, firstTry: first };
  if (result.status === 404 || result.status === 403) return { state: "absent", value: null, lastOk: previous?.lastOk ?? 0, since: null, firstTry: first };
  const lastOk = previous?.lastOk ?? 0;
  if (lastOk && now - lastOk <= limit) return { ...previous, firstTry: first };
  return { state: "unknown", value: null, lastOk, since: lastOk || first, firstTry: first };
}

// One request with a time limit: `request(signal)` gets an AbortSignal for its fetch, which is aborted after `ms` (the
// promise then fails with "The request timed out") or as soon as `stop` aborts (the page went away). The fetch itself
// ends, so a server that hangs never keeps the browser's few connections per site busy across cycles. The promise
// settles after `ms` even when the request ignores its signal.
export function withTimeout(request, { ms = REQUEST_TIMEOUT_MS, stop = null } = {}) {
  const controller = new AbortController();
  let timer = null, onStop = null;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new Error("The request timed out")); controller.abort(); }, ms);
    onStop = () => { reject(stop.reason ?? new Error("The request was stopped")); controller.abort(); };
    if (stop?.aborted) onStop();
    else stop?.addEventListener?.("abort", onStop, { once: true });
  });
  let pending;
  try { pending = Promise.resolve(request(controller.signal)); } catch (error) { pending = Promise.reject(error); }
  // The loser of the race may reject later (an aborted fetch): never an unhandled rejection.
  pending.catch(() => {});
  return Promise.race([pending, limit]).finally(() => {
    clearTimeout(timer);
    stop?.removeEventListener?.("abort", onStop);
  });
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

// Date and time parts in lab time (LAB_TZ), whatever the device's own time zone is.
const LAB_FORMAT = new Intl.DateTimeFormat("en-GB", { timeZone: LAB_TZ, hourCycle: "h23", year: "numeric", month: "short",
  day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const LAB_LONG_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: LAB_TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
export function labTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(LAB_FORMAT.formatToParts(d).map(p => [p.type, p.value]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

export function clockTime(ms, seconds = false) {
  const t = labTime(ms);
  if (!t) return "—";
  return `${t.hour}:${t.minute}${seconds ? `:${t.second}` : ""}`;
}

// A change's time: "14:32" today, "24 Oct 14:32" before (lab days).
export function changeTime(ms, now = Date.now()) {
  const t = labTime(ms), today = labTime(now);
  if (!t) return "—";
  return today && t.year === today.year && t.month === today.month && t.day === today.day ? clockTime(ms)
    : `${t.day} ${t.month} ${clockTime(ms)}`;
}

export function longDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return LAB_LONG_DATE.format(d);
}

// The connection line under the clock. lastSuccess: ms of the last complete data cycle (0 = none yet); partial: a
// source (maintenance, Ping Monitor, …) has not answered for longer than STALE_MS.
export function connectionState({ state, lastSuccess, now, partial = false }) {
  const age = lastSuccess ? now - lastSuccess : Infinity;
  const stale = lastSuccess > 0 && age > STALE_MS;
  if (state === "signed-out") return { level: "alarm", text: "Signed out", stale };
  // Never "Reconnecting…" before there was a connection: until the first good cycle it is "Connecting…".
  if (!lastSuccess) return { level: "idle", text: "Connecting…", stale: false };
  if (state === "online" && !stale && partial) return { level: "warn", text: "Live · partial", stale };
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
