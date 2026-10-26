import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isServerLabel, buildServers, pduLoad, buildRacks, environment, kpis, openAlerts, attentionItems, consolesInUse,
  recentChanges, gridLayout, rowsThatFit, pageOf, relativeAge, formatKw, formatRange, connectionState, pruneStatuses,
  changeTime, STALE_MS, TICKER_MAX, RATED_AMPS,
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
  assert.deepEqual([r1.on, r1.off, r1.total, r1.watts, r1.level], [1, 1, 2, 500, "ok"]);
  assert.deepEqual([r2.status, r2.level, r2.noReading, r2.watts], ["offline", "alarm", 2, null]);
  assert.deepEqual([r10.level, r10.maintenancePdus], ["maint", ["PDU 10"]]);
  assert.deepEqual([store.storage, store.level, store.total], [true, "idle", 0]);
  // A rack whose PDU has not answered yet is not an alarm.
  assert.equal(buildRacks([pdu(4)], {}, buildServers([pdu(4)], {}), null)[0].level, "idle");
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
  assert.deepEqual(items.map(i => [i.severity, i.kind]), [
    ["alarm", "leak"], ["alarm", "temperature"], ["alarm", "alert"], ["alarm", "pdu"], ["alarm", "ping"],
    ["warn", "pdu"], ["warn", "ping"], ["warn", "kvm"], ["warn", "humidity"], ["warn", "monitor"], ["info", "maintenance"],
  ]);
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  assert.equal(byKey["pdu:pdu2"].title, "PDU 02 unreachable");
  assert.equal(byKey["pdu:pdu2"].detail, "Rack-02 · 2 servers have no power reading");
  assert.equal(byKey["ping:t1"].detail, "Rack-02 · last answered 30 min ago");
  assert.match(byKey["maint:pdu1"].detail, /by admin · Rewiring$/);
  assert.equal(byKey["alert:e1"].detail, "Alert sent 10 min ago");
  assert.equal(items.some(i => i.key === "ping:t3" || i.key === "ping:t4"), false);
  // Nothing wrong: an empty list (the page shows "All clear").
  assert.deepEqual(attentionItems({ devices: [pdu(1)], pduStatuses: { pdu1: online(1) }, now }), []);
  // Before the first reading nothing is reported as broken.
  assert.deepEqual(attentionItems({ devices: [pdu(1), kvm], now }), []);
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
  const now = Date.parse("2026-10-26T12:00:00");
  assert.equal(changeTime(Date.parse("2026-10-26T09:05:00"), now), "09:05");
  assert.match(changeTime(Date.parse("2026-10-24T09:05:00"), now), /^24 Oct 09:05$/);
  assert.deepEqual(connectionState({ state: "connecting", lastSuccess: 0, now }), { level: "idle", text: "Connecting…", stale: false });
  assert.deepEqual(connectionState({ state: "online", lastSuccess: now - 5000, now }), { level: "ok", text: "Live", stale: false });
  assert.deepEqual(connectionState({ state: "offline", lastSuccess: now - 20_000, now }), { level: "warn", text: "Reconnecting…", stale: false });
  assert.deepEqual(connectionState({ state: "offline", lastSuccess: now - STALE_MS - 1, now }), { level: "alarm", text: "Connection lost", stale: true });
  assert.equal(connectionState({ state: "signed-out", lastSuccess: now, now }).text, "Signed out");
  assert.deepEqual(pruneStatuses({ a: 1, b: 2 }, new Set(["b"])), { b: 2 });
});

// WCAG AA (4.5:1) for every display text colour on the display's backgrounds and on its tinted chips.
test("display colour tokens keep 4.5:1 contrast", () => {
  const css = read("../index.css");
  const block = /\.lab-display \{([^}]*)\}/.exec(css)[1];
  const tokens = Object.fromEntries([...block.matchAll(/--ld-([a-z]+): (#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
  const tint = Number(/--ld-tint: (\d+)%/.exec(block)[1]) / 100;
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
  for (const fg of ["text", "muted", "ok", "warn", "alarm", "maint", "idle"]) {
    for (const bg of ["bg", "panel", "card"]) assert.ok(ratio(rgb(tokens[fg]), rgb(tokens[bg])) >= 4.5, `${fg} on ${bg}`);
  }
  for (const fg of ["ok", "warn", "alarm", "maint", "idle"]) {
    for (const bg of ["panel", "card"]) assert.ok(ratio(rgb(tokens[fg]), mix(rgb(tokens[fg]), rgb(tokens[bg]), tint)) >= 4.5, `${fg} chip on ${bg}`);
    // attention rows: the title (white) and the detail (muted) on the row's 7 % tint
    assert.ok(ratio(rgb(tokens.muted), mix(rgb(tokens[fg]), rgb(tokens.panel), 0.07)) >= 4.5, `muted on ${fg} row`);
  }
  assert.ok(ratio([0, 0, 0], rgb(tokens.warn)) >= 4.5, "stale badge");
});

test("App routes ?tab=display to the display alone; the header links to it for every role", () => {
  const app = read("../App.jsx");
  assert.match(app, /get\("tab"\) === "display"/);
  assert.match(app, /return display \? <LabDisplay \/> : <LabManagerApp \/>;/);
  const header = read("../components/Header.jsx");
  assert.match(header, /<a className="display-link" href="\/\?tab=display" target="_blank" rel="noopener"/);
  assert.match(header, />Lab display \(TV\)</);
  const page = read("../pages/LabDisplay.jsx");
  // Read-only: no buttons, no forms, no writes.
  assert.doesNotMatch(page, /<button|<form|<input|method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(page, /WhatsNew|AssistantPanel|confirm\(|alert\(/);
});
