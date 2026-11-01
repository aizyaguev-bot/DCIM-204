import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isServerLabel, buildServers, pduLoad, buildRacks, environment, kpis, openAlerts, attentionItems, consolesInUse,
  recentChanges, gridLayout, rowsThatFit, pageOf, relativeAge, formatKw, formatRange, connectionState, pruneStatuses,
  changeTime, clockTime, longDate, rackGrid, RACK_CARD_EM, ROW_EM, LIST_GAP_EM, fillRows, pinnedPage, labStatus, sourceAfter, maintenanceEntries, outletRuns, partsText, STALE_MS, TICKER_MAX, RATED_AMPS,
} from "../labDisplay.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const pdu = (n, extra = {}) => ({ id: `pdu${n}`, name: `PDU ${String(n).padStart(2, "0")}`, kind: "pdu", rack: `Rack-${String(n).padStart(2, "0")}`,
  labels: { 1: `OPT${n}1`, 2: `OPT${n}2`, 3: "Outlet 3", 4: "KVM Power" }, ...extra });
const online = (n, states = ["on", "on", "on", "on"], extra = {}) => ({ device_id: `pdu${n}`, reachable: true, inlet_voltage: 230, total_watts: 460, watts_complete: true,
  outlets: states.map((state, i) => ({ number: i + 1, label: [`OPT${n}1`, `OPT${n}2`, "Outlet 3", "KVM Power"][i], state, watts: 100 })),
  inlet_readings: [{ number: 1, current: 2 }], ...extra });
const offline = n => ({ device_id: `pdu${n}`, reachable: false, outlets: [], error: "timeout" });
const kvm = { id: "kvm1", name: "KVM 01", kind: "kvm", rack: "Rack-01", labels: { 1: "OPT11" } };

test("server labels match the Racks page rules (DcimView and serverPower keep the same text)", () => {
  const dcim = read("../pages/DcimView.jsx");
  const own = read("../labDisplay.js");
  const pattern = /const NON_SERVER_LABEL = (\/.*\/i);/;
  assert.equal(pattern.exec(own)[1], pattern.exec(dcim)[1]);
  assert.match(dcim, /\/\^\(outlet\\s\*\\d\+\|port\\s\*\\d\+\|\\s\*\)\$\/i/);
  assert.match(own, /\/\^\(outlet\\s\*\\d\+\|port\\s\*\\d\+\|\\s\*\)\$\/i/);
  for (const label of ["Outlet 3", "port 2", "", "  ", "KVM Power", "spare", "EMPTY", "n/a", "---"]) assert.equal(isServerLabel(label), false, label);
  for (const label of ["OPT11", "OPT5 (PSU1)", "build-server"]) assert.equal(isServerLabel(label), true, label);
});

test("buildServers: live outlets win over saved labels, overrides move a server to another rack", () => {
  const servers = buildServers([pdu(1), pdu(2)], { pdu1: online(1, ["on", "off", "on", "on"]), pdu2: offline(2) }, { opt12: "Rack-09" });
  assert.deepEqual(servers.map(s => [s.name, s.rack, s.state]), [
    ["OPT11", "Rack-01", "on"], ["OPT12", "Rack-09", "off"], ["OPT21", "Rack-02", "unknown"], ["OPT22", "Rack-02", "unknown"],
  ]);
  // An unreachable PDU still lists its saved servers (no reading), a reachable one only what it reports.
  const moved = buildServers([pdu(1)], { pdu1: { ...online(1), outlets: [{ number: 1, label: "OPT99", state: "on" }] } });
  assert.deepEqual(moved.map(s => s.name), ["OPT12", "OPT99"]);
});

test("pduLoad: measured current over the 16 A rating, an estimate from complete watts, unreachable is an alarm", () => {
  const measured = pduLoad(pdu(1), online(1, undefined, { inlet_readings: [{ number: 1, current: 8 }] }));
  assert.equal(measured.amps, 8);
  assert.equal(measured.pct, 8 / RATED_AMPS * 100);
  assert.equal(measured.level, "ok");
  assert.equal(measured.estimated, false);
  const estimated = pduLoad(pdu(1), online(1, undefined, { inlet_readings: [], total_watts: 2944, inlet_voltage: 230 }));
  assert.equal(estimated.amps, 12.8);
  assert.equal(estimated.level, "alarm");   // 80 %
  assert.equal(pduLoad(pdu(1), online(1, undefined, { inlet_readings: [], total_watts: 2300 })).level, "warn");
  assert.equal(pduLoad(pdu(1), online(1, undefined, { inlet_readings: [], watts_complete: false })).pct, null);
  const down = pduLoad(pdu(2), offline(2));
  assert.deepEqual([down.state, down.level, down.watts, down.pct], ["offline", "alarm", null, null]);
  assert.equal(pduLoad(pdu(3), undefined).state, "loading");
  assert.equal(pduLoad(pdu(3), { device_id: "pdu3", requestFailed: true, outlets: [] }).state, "unavailable");
});

test("buildRacks: natural order, server counts, power, maintenance and storage", () => {
  const devices = [pdu(10), pdu(2), pdu(1), { id: "store", kind: "rack", model: "Storage", rack: "Storage shelf", name: "Storage" },
    { id: "pdu1b", kind: "pdu", name: "PDU 01B", rack: "Rack-01", labels: {} }];
  const statuses = { pdu1: online(1, ["on", "off", "on", "on"]), pdu2: offline(2), pdu10: online(10), pdu1b: online(1, [], { outlets: [], total_watts: 40 }) };
  const servers = buildServers(devices.filter(d => d.kind === "pdu"), statuses);
  const racks = buildRacks(devices, statuses, servers, { pdus: { pdu10: { started_at: 1 } } });
  assert.deepEqual(racks.map(r => r.rack), ["Rack-01", "Rack-02", "Rack-10", "Storage shelf"]);
  const [r1, r2, r10, store] = racks;
  assert.deepEqual([r1.on, r1.off, r1.total, r1.watts, r1.level, r1.reason], [1, 1, 2, 500, "ok", "Online"]);
  assert.deepEqual([r2.status, r2.level, r2.reason, r2.watts], ["offline", "alarm", "Unreachable", null]);
  assert.deepEqual([r10.level, r10.reason, r10.maintenancePdus], ["maint", "Maintenance", ["PDU 10"]]);
  assert.deepEqual([store.storage, store.level, store.total], [true, "idle", 0]);
  // A rack whose PDU has not answered yet is not an alarm, and its servers have no reading (not "0 on").
  const waiting = buildRacks([pdu(4)], {}, buildServers([pdu(4)], {}), null)[0];
  assert.deepEqual([waiting.level, waiting.on, waiting.noReading, waiting.total], ["idle", 0, 2, 2]);
});

test("buildRacks: an unreachable PDU means no reading for every server, never zero servers on", () => {
  const devices = [pdu(7)];
  const statuses = { pdu7: offline(7) };
  const [rack] = buildRacks(devices, statuses, buildServers(devices, statuses), null);
  assert.deepEqual([rack.on, rack.off, rack.noReading, rack.total], [0, 0, 2, 2]);
  assert.equal(rack.noReading, rack.total);
  // One server without a reading on a reachable PDU: a partial count, a warning.
  const partial = { pdu7: online(7, ["on", "unknown", "on", "on"]) };
  const [some] = buildRacks(devices, partial, buildServers(devices, partial), null);
  assert.deepEqual([some.on, some.noReading, some.total, some.level, some.reason], [1, 1, 2, "warn", "Partial reading"]);
});

// The "bad day": a leak and 37.2 °C on PDU 02, servers down in Rack-04, PDU 05 slow, PDU 07 unreachable.
test("buildRacks: sensors and Ping Monitor raise the rack card, the top reason is named", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const devices = [pdu(1), pdu(2), pdu(3), pdu(4), pdu(7), kvm];
  const pduStatuses = { pdu1: online(1), pdu2: online(2, undefined, { temperature: 37.2, humidity: 52, leak_detected: true }),
    pdu3: online(3, undefined, { temperature: 26 }), pdu4: online(4), pdu7: offline(7) };
  const env = environment(devices.filter(d => d.kind === "pdu"), pduStatuses);
  const monitoring = { service: "ok", targets: [
    { id: "t41", name: "OPT41", rack: "Rack-04", status: "down", enabled: true },
    { id: "t42", name: "OPT42", rack: "Rack-04", status: "down", enabled: true },
    { id: "t31", name: "OPT31", rack: "Rack-03", status: "stale", last_result: "down", enabled: true },
  ], email_alerts: { recent: [] } };
  const attention = attentionItems({ devices, pduStatuses, kvmStatuses: { kvm1: { reachable: true, ports: [] } }, monitoring, env, now });
  const servers = buildServers(devices.filter(d => d.kind === "pdu"), pduStatuses);
  const racks = Object.fromEntries(buildRacks(devices, pduStatuses, servers, null, { sensors: env.sensors, attention }).map(r => [r.rack, r]));
  assert.deepEqual([racks["Rack-02"].level, racks["Rack-02"].reason], ["alarm", "Water leak"]);
  assert.ok(racks["Rack-02"].issues.includes("37 °C"));
  assert.deepEqual([racks["Rack-04"].level, racks["Rack-04"].reason], ["alarm", "2 not answering ping"]);
  assert.deepEqual([racks["Rack-03"].level, racks["Rack-03"].reason], ["warn", "26 °C"]);
  assert.deepEqual([racks["Rack-07"].level, racks["Rack-07"].reason], ["alarm", "Unreachable"]);
  assert.deepEqual([racks["Rack-01"].level, racks["Rack-01"].reason], ["ok", "Online"]);
  // Servers a maintenance switched off stop answering ping: the rack shows the maintenance, not an alarm.
  const maint = buildRacks(devices, pduStatuses, servers, { pdus: { pdu4: { started_at: 1 } } }, { sensors: env.sensors, attention });
  const r4 = maint.find(r => r.rack === "Rack-04");
  assert.deepEqual([r4.level, r4.reason], ["maint", "Maintenance"]);
  // A leak beats maintenance.
  const leakMaint = buildRacks(devices, pduStatuses, servers, { pdus: { pdu2: { started_at: 1 } } }, { sensors: env.sensors, attention });
  assert.deepEqual(["alarm", "Water leak"], [leakMaint.find(r => r.rack === "Rack-02").level, leakMaint.find(r => r.rack === "Rack-02").reason]);
});

test("environment and kpis: thresholds, reachable counts, total power", () => {
  const devices = [pdu(1), pdu(2), pdu(3), kvm];
  const statuses = {
    pdu1: online(1, undefined, { temperature: 23.5, humidity: 45, leak_detected: false }),
    pdu2: online(2, ["off", "on", "on", "on"], { temperature: 26, humidity: 71, total_watts: 300, watts_complete: false }),
    pdu3: offline(3),
  };
  const env = environment(devices.filter(d => d.kind === "pdu"), statuses);
  assert.deepEqual([env.tempMin, env.tempMax, env.humMin, env.humMax, env.leak], [23.5, 26, 45, 71, false]);
  assert.deepEqual([env.tempLevel, env.humLevel, env.leakLevel, env.level], ["warn", "warn", "ok", "warn"]);
  assert.equal(environment([pdu(1)], { pdu1: online(1, undefined, { temperature: 36 }) }).tempLevel, "alarm");
  assert.equal(environment([pdu(1)], { pdu1: online(1, undefined, { leak_detected: true }) }).level, "alarm");
  assert.equal(environment([pdu(1)], { pdu1: online(1) }).hasSensors, false);
  const servers = buildServers(devices.filter(d => d.kind === "pdu"), statuses);
  const k = kpis({ devices, pduStatuses: statuses, kvmStatuses: { kvm1: { reachable: true, ports: [] } }, servers, maintenance: { pdus: { pdu1: {} } } });
  assert.deepEqual(k.servers, { on: 3, off: 1, noReading: 2, total: 6 });
  assert.deepEqual([k.pdus.reachable, k.pdus.total, k.pdus.read, k.pdus.maintenance], [2, 3, 3, 1]);
  assert.deepEqual([k.kvms.reachable, k.kvms.total], [1, 1]);
  assert.deepEqual(k.power, { watts: 760, complete: false, known: 2 });
  // Power by PDU: problems first (the unreachable PDU 03 is never on a later page), then by name.
  assert.deepEqual(k.loads.map(l => [l.name, l.level]), [["PDU 03", "alarm"], ["PDU 01", "ok"], ["PDU 02", "ok"]]);
});

test("PDU load near its rating: an Attention item and the rack card's state (the display has no per-PDU panel)", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const amps = current => ({ inlet_readings: [{ number: 1, current }] });
  const devices = [pdu(1), pdu(2), pdu(3), pdu(4)];
  // 16 A rating: 10.4 A = 65 % (warning), 13.6 A = 85 % (alarm), 2 A = 12.5 % (nothing), unreachable (its own item).
  const pduStatuses = { pdu1: online(1, undefined, amps(10.4)), pdu2: online(2, undefined, amps(13.6)), pdu3: online(3), pdu4: offline(4) };
  const items = attentionItems({ devices, pduStatuses, now });
  assert.deepEqual(items.map(i => [i.key, i.severity, i.title, i.detail]), [
    ["pdu:pdu4", "alarm", "PDU 04 unreachable", "Rack-04 · No reading from 2 servers"],
    ["load:pdu2", "alarm", "PDU 02 load 85 %", "Rack-02 · 13.6 A of 16 A"],
    ["load:pdu1", "warn", "PDU 01 load 65 %", "Rack-01 · 10.4 A of 16 A"],
  ]);
  // Estimated from watts when no inlet current is reported.
  const estimated = attentionItems({ devices: [pdu(1)], pduStatuses: { pdu1: online(1, undefined, { inlet_readings: [], total_watts: 2700, inlet_voltage: 230 }) }, now });
  assert.deepEqual(estimated.map(i => [i.title, i.detail]), [["PDU 01 load 73 %", "Rack-01 · 11.7 A of 16 A (estimated)"]]);
  const servers = buildServers(devices, pduStatuses);
  const racks = Object.fromEntries(buildRacks(devices, pduStatuses, servers, null, { attention: items }).map(r => [r.rack, r]));
  assert.deepEqual([racks["Rack-01"].level, racks["Rack-01"].reason], ["warn", "Load 65 %"]);
  assert.deepEqual([racks["Rack-02"].level, racks["Rack-02"].reason], ["alarm", "Load 85 %"]);
  assert.deepEqual([racks["Rack-03"].level, racks["Rack-03"].reason], ["ok", "Online"]);
  assert.deepEqual([racks["Rack-04"].level, racks["Rack-04"].reason], ["alarm", "Unreachable"]);
});

test("openAlerts: the newest message per subject decides; a recovery closes the alert", () => {
  const recent = [
    { id: "a", subject: "[DCIM alert] OPT71 is not answering ping", created_at: "2026-10-26T10:00:00+00:00" },
    { id: "b", subject: "[DCIM recovered] OPT71 is not answering ping", created_at: "2026-10-26T10:05:00+00:00" },
    { id: "c", subject: "[DCIM alert] PDU 03 inlet current above 15 A", created_at: "2026-10-26T09:00:00+00:00" },
    { id: "d", subject: "Unrelated", created_at: "2026-10-26T11:00:00+00:00" },
  ];
  assert.deepEqual(openAlerts(recent).map(a => a.title), ["PDU 03 inlet current above 15 A"]);
  assert.deepEqual(openAlerts(null), []);
});

test("attentionItems: most severe first, with every source", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const devices = [pdu(1), pdu(2), pdu(3), kvm];
  const pduStatuses = { pdu1: online(1, undefined, { temperature: 36, humidity: 75, leak_detected: true }), pdu2: offline(2), pdu3: { device_id: "pdu3", requestFailed: true, outlets: [] } };
  const env = environment(devices.filter(d => d.kind === "pdu"), pduStatuses);
  const items = attentionItems({
    devices, pduStatuses, kvmStatuses: { kvm1: { reachable: false, ports: [] } }, env, now,
    maintenance: { pdus: { pdu1: { started_at: now / 1000 - 600, started_by: "admin", reason: "Rewiring" } } },
    monitoring: { service: "overdue", targets: [
      { id: "t1", name: "OPT21", rack: "Rack-02", status: "down", enabled: true, last_up_at: "2026-10-26T11:30:00Z" },
      { id: "t2", name: "OPT22", status: "stale", last_result: "down", enabled: true },
      { id: "t3", name: "OPT23", status: "down", enabled: false },
      { id: "t4", name: "OPT24", status: "up", enabled: true },
    ], email_alerts: { recent: [{ id: "e1", subject: "[DCIM alert] PDU 02 is unreachable", created_at: "2026-10-26T11:50:00Z" }] } },
  });
  // Maintenance is not an Attention item: it has its own band (maintenanceEntries), always in view.
  assert.deepEqual(items.map(i => [i.severity, i.kind]), [
    ["alarm", "leak"], ["alarm", "temperature"], ["alarm", "alert"], ["alarm", "pdu"], ["alarm", "ping"],
    ["warn", "pdu"], ["warn", "ping"], ["warn", "kvm"], ["warn", "humidity"], ["warn", "monitor"],
  ]);
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  assert.equal(byKey["pdu:pdu2"].title, "PDU 02 unreachable");
  assert.equal(byKey["pdu:pdu2"].detail, "Rack-02 · No reading from 2 servers");
  assert.equal(byKey["pdu:pdu2"].rack, "Rack-02");
  assert.equal(byKey["ping:t1"].detail, "Rack-02 · last answered 30 min ago");
  assert.equal(byKey["alert:e1"].detail, "Alert sent 10 min ago");
  assert.equal(items.some(i => i.kind === "maintenance"), false);
  assert.equal(items.some(i => i.key === "ping:t3" || i.key === "ping:t4"), false);
  // Nothing wrong: an empty list (the page shows "All clear").
  assert.deepEqual(attentionItems({ devices: [pdu(1)], pduStatuses: { pdu1: online(1) }, now }), []);
  // Before the first reading nothing is reported as broken.
  assert.deepEqual(attentionItems({ devices: [pdu(1), kvm], now }), []);
  // Ping Monitor data not read for over STALE_MS: no ping or alert item from the old copy, one warning instead.
  const unknown = attentionItems({ devices, pduStatuses, kvmStatuses: { kvm1: { reachable: true, ports: [] } }, env, now,
    monitoring: { service: "ok", targets: [{ id: "t1", name: "OPT21", status: "down", enabled: true }], email_alerts: { recent: [] } },
    monitoringUnknownSince: Date.parse("2026-10-26T11:58:00") });
  assert.equal(unknown.some(i => i.kind === "ping" || i.kind === "alert"), false);
  const warning = unknown.find(i => i.key === "monitor:data");
  assert.equal(warning.severity, "warn");
  assert.equal(warning.title, "Ping Monitor data not available since 11:58");
});

// Hebrew names and reasons stay separate parts in their logical order; the page puts each user part in <bdi dir="auto">.
test("user text stays in separate parts, in logical order", () => {
  const now = Date.parse("2026-10-26T12:00:00");
  const devices = [{ ...pdu(3), name: "PDU 03", rack: "Rack-03" }];
  const reason = "החלפת ספק כוח בשרת 4";
  const who = "אסף יעקב";
  const [entry] = maintenanceEntries({ devices, maintenance: { pdus: { pdu3: { started_at: Date.parse("2026-10-26T11:38:00") / 1000, started_by: who, reason, outlets_off: [1, 2, 3, 5] } } } });
  assert.deepEqual(entry.parts, [
    { text: "Rack-03", user: true }, { text: " · " }, { text: "PDU 03", user: true }, { text: " · " },
    { text: "outlets 1–3, 5 off since 11:38" }, { text: " · " }, { text: who, user: true }, { text: " · " }, { text: reason, user: true },
  ]);
  assert.equal(entry.text, `Rack-03 · PDU 03 · outlets 1–3, 5 off since 11:38 · ${who} · ${reason}`);
  assert.equal(partsText(entry.parts), entry.text);
  // The band shows the reason in a box of its own (cut at its own end): head = where, when and who; reason = why.
  assert.deepEqual([partsText(entry.head), entry.reason], [`Rack-03 · PDU 03 · outlets 1–3, 5 off since 11:38 · ${who}`, reason]);
  const [plain] = maintenanceEntries({ devices, maintenance: { pdus: { pdu3: { outlets_off: [1] } } } });
  assert.deepEqual([partsText(plain.head), plain.reason], ["Rack-03 · PDU 03 · outlet 1 off", ""]);
  // An alert title and a ping target name are user parts too; the English around them is not.
  const items = attentionItems({ devices, pduStatuses: { pdu3: online(3) }, now, monitoring: { service: "ok",
    targets: [{ id: "h", name: "שרת-בדיקה", rack: "מעבדה", status: "down", enabled: true }],
    email_alerts: { recent: [{ id: "a", subject: "[DCIM alert] טמפרטורה גבוהה ב-Rack-02 (PDU 02)", created_at: "2026-10-26T09:50:00Z" }] } } });
  const ping = items.find(i => i.kind === "ping");
  assert.deepEqual(ping.titleParts, [{ text: "שרת-בדיקה", user: true }, { text: " not answering ping" }]);
  assert.deepEqual(ping.parts.slice(0, 2), [{ text: "מעבדה", user: true }, { text: " · " }]);
  assert.deepEqual(items.find(i => i.kind === "alert").titleParts, [{ text: "טמפרטורה גבוהה ב-Rack-02 (PDU 02)", user: true }]);
  const [change] = recentChanges({ devices, maintenance: { log: [{ at: 1000, device_id: "pdu3", action: "shutdown", by: who }] } });
  assert.deepEqual(change.parts, [{ text: "PDU 03", user: true }, { text: " maintenance started" }, { text: " · " }, { text: who, user: true }]);
  assert.equal(outletRuns([4, 1, 2, 2, 9, 10, 11]), "1, 2, 4, 9–11");
  assert.deepEqual(maintenanceEntries({ devices, maintenance: null }), []);
});

test("pinnedPage: alarms stay on every page, the rest rotate below them", () => {
  const item = (severity, n) => ({ key: `${severity}${n}`, severity });
  const list = [item("alarm", 1), item("alarm", 2), item("warn", 1), item("warn", 2), item("warn", 3), item("warn", 4), item("info", 1)];
  const keys = page => page.items.map(i => i.key);
  const p0 = pinnedPage(list, 4, 0), p1 = pinnedPage(list, 4, 1), p2 = pinnedPage(list, 4, 2);
  assert.deepEqual(keys(p0), ["alarm1", "alarm2", "warn1", "warn2"]);
  assert.deepEqual(keys(p1), ["alarm1", "alarm2", "warn3", "warn4"]);
  // The last page is full too: it wraps round to the first of the rest.
  assert.deepEqual(keys(p2), ["alarm1", "alarm2", "info1", "warn1"]);
  assert.deepEqual([p0.pages, p0.more, p0.moreAlarms], [3, 3, 0]);
  // More alarms than rows: they turn pages among themselves and the last row counts the rest.
  const alarms = Array.from({ length: 6 }, (_, i) => item("alarm", i));
  const over = pinnedPage([...alarms, item("warn", 9)], 4, 0);
  assert.deepEqual([over.items.length, over.moreAlarms, over.more, over.pages], [3, 3, 4, 2]);
  assert.deepEqual(pinnedPage(alarms.slice(0, 4), 4, 3).items.length, 4);
  assert.deepEqual(pinnedPage([...alarms.slice(0, 4), item("warn", 1)], 4, 0), { items: alarms.slice(0, 4), moreAlarms: 0, more: 1, page: 0, pages: 1 });
  assert.deepEqual(pinnedPage(list.slice(0, 2), 4, 9), { items: list.slice(0, 2), moreAlarms: 0, more: 0, page: 0, pages: 1 });
  assert.deepEqual(labStatus([]), { level: "ok", text: "ALL NORMAL", alarms: 0, warnings: 0 });
  assert.equal(labStatus([item("warn", 1)]).text, "1 WARNING");
  assert.equal(labStatus(list).text, "2 ALARMS");
});

test("sourceAfter: a failing source keeps its copy for STALE_MS, then is unknown", () => {
  const t0 = 1_000_000;
  let source = sourceAfter(undefined, { ok: true, value: { pdus: {} } }, t0);
  assert.deepEqual([source.state, source.lastOk], ["ok", t0]);
  source = sourceAfter(source, { ok: false, status: 500 }, t0 + 30_000);
  assert.deepEqual([source.state, source.value], ["ok", { pdus: {} }]);
  source = sourceAfter(source, { ok: false, status: 500 }, t0 + STALE_MS + 1);
  assert.deepEqual([source.state, source.value, source.since], ["unknown", null, t0]);
  source = sourceAfter(source, { ok: true, value: { pdus: { a: {} } } }, t0 + STALE_MS + 15_000);
  assert.equal(source.state, "ok");
  assert.equal(sourceAfter(source, { ok: false, status: 404 }, t0 + STALE_MS + 30_000).state, "absent");
  // Never read: unknown since the first try once STALE_MS has passed.
  const first = sourceAfter(undefined, { ok: false, status: 500 }, t0);
  assert.equal(first.state, "unknown");
  assert.equal(first.since, t0);
});

test("consolesInUse and recentChanges are bounded and sorted", () => {
  const rows = consolesInUse([kvm, pdu(1)], { kvm1: { reachable: true, ports: [
    { number: 2, label: "OPT12", in_use: true }, { number: 3, label: "Port 3", in_use: true }, { number: 1, label: "OPT11", in_use: false },
  ] } });
  assert.deepEqual(rows.map(r => [r.server, r.port]), [["OPT12", 2], ["Port 3", 3]]);
  const log = Array.from({ length: 30 }, (_, i) => ({ at: 1_000_000 + i, device_id: "pdu1", action: i % 3 === 2 ? "denied" : i % 2 ? "restore" : "shutdown", by: "admin" }));
  const incidents = [{ id: "x", name: "OPT71", first_failed_at: "2026-10-26T10:00:00Z", ended_at: "2026-10-26T10:10:00Z", end_reason: "recovered" }];
  const changes = recentChanges({ devices: [pdu(1)], maintenance: { log }, incidents });
  assert.equal(changes.length, TICKER_MAX);
  assert.ok(changes.every((c, i) => i === 0 || changes[i - 1].at >= c.at));
  assert.deepEqual(changes.slice(0, 2).map(c => c.text), ["OPT71 answering ping again", "OPT71 stopped answering ping"]);
  assert.ok(changes.every(c => !/denied/.test(c.text)));
  assert.match(changes[2].text, /^PDU 01 maintenance (started|ended) · admin$/);
});

test("layout helpers: the rack grid and lists fit without scrolling and rotate", () => {
  const opts = { minW: 200, minH: 120, maxH: 180, gap: 10 };
  const nine = gridLayout(9, 1100, 700, opts);
  assert.deepEqual([nine.cols, nine.rows, nine.perPage], [3, 3, 9]);
  assert.ok(nine.cellH * nine.rows + opts.gap * (nine.rows - 1) <= 700);
  const many = gridLayout(60, 1100, 700, opts);
  assert.deepEqual([many.cols, many.rows, many.perPage], [5, 5, 25]);
  assert.ok(many.cellH >= opts.minH && many.cellH * many.rows + opts.gap * (many.rows - 1) <= 700);
  assert.deepEqual(gridLayout(3, 0, 0, opts).perPage, 1);
  // The Racks panel body on a 24-inch monitor at 1920 x 1080 with the maintenance band (and the same in em at
  // 1536 x 864, measured by tests/browser/lab-display.cjs): nine normal cards fit, three across, so the fixture's 8 racks
  // are one page; more racks than that: compact cards, twelve on a page, so 30 racks take three pages.
  for (const [em, panel] of [[16, [934, 509]], [12.8, [747, 405]]]) {
    for (const count of [8, 9]) {
      const normal = rackGrid(count, ...panel, em);
      assert.deepEqual([normal.compact, normal.cols, normal.perPage, normal.gapEm], [false, 3, count, RACK_CARD_EM.gap], JSON.stringify(normal));
      assert.ok(normal.cellH >= RACK_CARD_EM.minH * em - 1, JSON.stringify(normal));
    }
    const thirty = rackGrid(30, ...panel, em);
    assert.equal(thirty.compact, true);
    assert.ok(Math.ceil(30 / thirty.perPage) <= 3, JSON.stringify(thirty));
  }
  // With the role warning or the NOT LIVE banner too, the 8 racks still fit one page, as compact cards.
  const short = rackGrid(8, 934, 444, 16);
  assert.deepEqual([short.compact, short.perPage], [true, 8]);
  // Attention: rows of ROW_EM.attention; a full page shares the panel height (at most 1.4 x), a short list does not.
  const full = fillRows(509, ROW_EM.attention * 16, LIST_GAP_EM * 16, 7);
  assert.equal(full.rows, 5);
  assert.ok(Math.abs(full.rows * full.rowH + (full.rows - 1) * LIST_GAP_EM * 16 - 509) < 1, JSON.stringify(full));
  assert.deepEqual(fillRows(509, ROW_EM.attention * 16, LIST_GAP_EM * 16, 2), { rows: 5, rowH: ROW_EM.attention * 16 });
  assert.equal(fillRows(300, 100, 0, 9, 1.4).rowH, 100);
  assert.equal(fillRows(390, 100, 0, 9, 1.4).rowH, 130);
  assert.equal(fillRows(250, 100, 0, 9, 1.2).rowH, 120);
  assert.equal(rowsThatFit(300, 50, 10), 5);
  assert.equal(rowsThatFit(0, 50, 10), 1);
  const list = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(pageOf(list, 3, 0), { items: [0, 1, 2], page: 0, pages: 3 });
  assert.deepEqual(pageOf(list, 3, 4), { items: [3, 4, 5], page: 1, pages: 3 });
  assert.deepEqual(pageOf(list, 3, 2).items, [6]);
  assert.deepEqual(pageOf([], 3, 5), { items: [], page: 0, pages: 1 });
});

test("text helpers and connection state", () => {
  assert.equal(relativeAge(2000), "just now");
  assert.equal(relativeAge(42_000), "42 s ago");
  assert.equal(relativeAge(5 * 60_000), "5 min ago");
  assert.equal(relativeAge(3 * 3_600_000), "3 h ago");
  assert.equal(formatKw(3960), "3.96");
  assert.equal(formatKw(12_345), "12.3");
  assert.equal(formatKw(null), "—");
  assert.equal(formatRange(22, 22.04, 1), "22.0");
  assert.equal(formatRange(22, 25, 0), "22–25");
  // Lab time (Asia/Jerusalem) whatever the device's time zone: UTC+2 after 25 Oct 2026, UTC+3 before.
  const now = Date.parse("2026-10-26T10:00:00Z");
  assert.equal(changeTime(Date.parse("2026-10-26T07:05:00Z"), now), "09:05");
  assert.match(changeTime(Date.parse("2026-10-24T06:05:00Z"), now), /^24 Oct 09:05$/);
  assert.equal(changeTime(Date.parse("2026-10-25T22:30:00Z"), now), "00:30", "a lab day, not a UTC day");
  assert.equal(clockTime(Date.parse("2026-07-01T21:15:09Z"), true), "00:15:09");
  assert.equal(longDate(Date.parse("2026-10-26T23:30:00Z")), "Tuesday, 27 October 2026");
  assert.equal(clockTime(NaN), "—");
  assert.deepEqual(connectionState({ state: "connecting", lastSuccess: 0, now }), { level: "idle", text: "Connecting…", stale: false });
  assert.deepEqual(connectionState({ state: "offline", lastSuccess: 0, now }), { level: "idle", text: "Connecting…", stale: false });
  assert.deepEqual(connectionState({ state: "online", lastSuccess: now - 5000, now }), { level: "ok", text: "Live", stale: false });
  assert.deepEqual(connectionState({ state: "offline", lastSuccess: now - 20_000, now }), { level: "warn", text: "Reconnecting…", stale: false });
  assert.deepEqual(connectionState({ state: "offline", lastSuccess: now - STALE_MS - 1, now }), { level: "alarm", text: "Connection lost", stale: true });
  assert.equal(connectionState({ state: "signed-out", lastSuccess: now, now }).text, "Signed out");
  assert.deepEqual(connectionState({ state: "online", lastSuccess: now - 5000, now, partial: true }), { level: "warn", text: "Live · partial", stale: false });
  assert.deepEqual(pruneStatuses({ a: 1, b: 2 }, new Set(["b"])), { b: 2 });
});

const displayTokens = () => {
  const block = /\.lab-display \{([^}]*)\}/.exec(read("../index.css"))[1];
  return Object.fromEntries([...block.matchAll(/--ld-([a-z]+): (#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
};
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const linear = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

// WCAG AA (4.5:1) for every display text colour on the display's backgrounds, and for the solid status fills.
test("display colour tokens keep 4.5:1 contrast", () => {
  const tokens = displayTokens();
  const lum = c => { const [r, g, b] = c.map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
  const black = [0, 0, 0];
  for (const fg of ["text", "muted", "ok", "warn", "alarm", "maint", "idle"]) {
    for (const bg of ["bg", "panel", "card"]) assert.ok(ratio(rgb(tokens[fg]), rgb(tokens[bg])) >= 4.5, `${fg} on ${bg}`);
  }
  // Solid fills carry black text (alarm tiles, cards and rows, chips, the NOT LIVE banner, the maintenance label).
  for (const fill of ["ok", "warn", "alarm", "maint"]) assert.ok(ratio(black, rgb(tokens[fill])) >= 4.5, `black on ${fill}`);
  // Warning rows: the title (white) and the detail (muted) on the row's 7 % tint.
  for (const fg of ["text", "muted"]) assert.ok(ratio(rgb(tokens[fg]), mix(rgb(tokens.warn), rgb(tokens.panel), 0.07)) >= 4.5, `${fg} on a warning row`);
});

// Machado, Oliveira & Fernandes (2009) full-severity matrices, applied in linear RGB; CIE76 ΔE in CIELAB (D65).
test("ok, warning and alarm stay apart for deuteranopia and protanopia (ΔE76 ≥ 20)", () => {
  const tokens = displayTokens();
  const MATRIX = {
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  };
  const clamp = v => Math.min(1, Math.max(0, v));
  const simulate = (hex, m) => { const c = rgb(hex).map(linear); return m.map(row => clamp(row[0] * c[0] + row[1] * c[1] + row[2] * c[2])); };
  const lab = ([r, g, b]) => {
    const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
  for (const [kind, m] of Object.entries(MATRIX)) {
    for (const [a, b] of [["ok", "warn"], ["ok", "alarm"], ["warn", "alarm"]]) {
      const d = deltaE(simulate(tokens[a], m), simulate(tokens[b], m));
      assert.ok(d >= 20, `${kind}: ${a} vs ${b} ΔE ${d.toFixed(1)}`);
    }
  }
  // The old green / orange pair would fail: the check really measures what colour-blind viewers see.
  assert.ok(deltaE(simulate("#9fe040", MATRIX.deutan), simulate("#ffb52e", MATRIX.deutan)) < 20);
});

test("App routes ?tab=display to the display alone; the header links to it for every role", () => {
  const app = read("../App.jsx");
  assert.match(app, /get\("tab"\) === "display"/);
  assert.match(app, /return display \? <LabDisplay \/> : <LabManagerApp \/>;/);
  const header = read("../components/Header.jsx");
  assert.match(header, /<a className="display-link" href="\/\?tab=display" target="_blank" rel="noopener"/);
  assert.match(header, />Lab display \(TV\)</);
  assert.match(header, /sign in as Viewer/);
  const page = read("../pages/LabDisplay.jsx");
  // Read-only: no buttons, no forms, no writes.
  assert.doesNotMatch(page, /<button|<form|<input|method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(page, /WhatsNew|AssistantPanel|confirm\(|alert\(/);
});
