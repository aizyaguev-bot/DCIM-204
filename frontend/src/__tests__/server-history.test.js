import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ELSEWHERE_NOTE, buildTimeline, checkStrip, defaultMonitorHost, incidentEnd, incidentEntry, pausesMonitor, placeOf,
  removalEntries, sessionEntry, toMs, unitMoveEntries,
} from "../server/serverHistory.js";

// The server window's power, header tools and Activity (one-place spec v1 WP-3): the timeline is pure; the components
// are checked by their source (the browser suite server-window-ops.cjs drives them).
const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = source => source.replace(/^\s*\/\/.*$/gm, "");   // without its line comments
const fmt = ms => new Date(ms).toISOString().slice(0, 16);
const H = 3600 * 1000;
const T0 = Date.parse("2026-11-20T10:00:00Z");
const iso = ms => new Date(ms).toISOString();

test("toMs reads epoch seconds, epoch milliseconds and ISO strings; anything else is null", () => {
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMs(1_700_000_000_123), 1_700_000_000_123);
  assert.equal(toMs("2026-11-20T10:00:00Z"), T0);
  assert.equal(toMs("2026-11-20T10:00:00+00:00"), T0);
  for (const bad of [null, undefined, "", "soon", NaN, Infinity, true, {}]) assert.equal(toMs(bad), null, String(bad));
});

test("an incident says how it ended and never claims a recovery that was not observed", () => {
  const recovered = { id: 1, first_failed_at: iso(T0), last_failed_at: iso(T0 + H), ended_at: iso(T0 + 2 * H), end_reason: "recovered", failed_checks: 3 };
  const e = incidentEntry(recovered, fmt);
  assert.equal(e.kind, "incident");
  assert.equal(e.at, T0);
  assert.equal(e.title, "Did not answer ping");
  assert.equal(e.tone, "ok");
  assert.equal(e.detail, `3 failed checks · last failed ${fmt(T0 + H)} · Reply received ${fmt(T0 + 2 * H)}`);

  const open = incidentEntry({ id: 2, first_failed_at: iso(T0), last_failed_at: iso(T0), ended_at: null, end_reason: "", failed_checks: 1 }, fmt);
  assert.equal(open.title, "Not answering ping");
  assert.equal(open.tone, "bad");
  assert.equal(open.detail, "1 failed check · No recovery observed");

  const paused = incidentEntry({ id: 3, first_failed_at: iso(T0), ended_at: iso(T0 + H), end_reason: "address_changed", failed_checks: 2 }, fmt);
  assert.equal(paused.tone, "off", "closed without a reply is not green");
  assert.match(paused.detail, /Closed: address changed/);
  assert.doesNotMatch(paused.detail, /Reply received|recovered/i);
  assert.equal(incidentEnd({ ended_at: iso(T0), end_reason: "paused" }), "Closed: paused");
  assert.equal(incidentEnd({ ended_at: null }), "No recovery observed");
});

test("the removal log shows only this server's entries, and only to Admins", () => {
  const log = [
    { at: 100, action: "removed", key: "opt74", name: "OPT74", by: "admin", reason: "First removal" },
    { at: 200, action: "restored", key: "opt74", name: "OPT74", by: "admin", reason: "" },
    { at: 300, action: "removed", key: "opt98", name: "OPT98", by: "admin", reason: "Other server" },
    null, "junk",
  ];
  const entries = removalEntries(log, "opt74");
  assert.deepEqual(entries.map(e => [e.at, e.title, e.detail]), [
    [100_000, "Removed from the lab", "by admin — First removal"],
    [200_000, "Restored to the lab", "by admin"],
  ]);
  assert.deepEqual(removalEntries(log, "OPT74").length, 2, "the key is compared without case");
  assert.deepEqual(removalEntries(log, "opt74", { admin: false }), [], "an Operator or Viewer sees no removal log");
  assert.deepEqual(removalEntries(undefined, "opt74"), []);
  assert.deepEqual(removalEntries(log, ""), []);
});

test("only the 'moved' tracking entries of the floor's units are listed", () => {
  const units = [
    { id: "u1", name: "Tray 53", tracking_history: [
      { at: iso(T0), action: "scanned", from: null, to: "Rack-05 · floor 3" },
      { at: iso(T0 + H), action: "moved", from: "Rack-05 · floor 2", to: "Rack-05 · floor 3", note: "Moved with OPT53" },
    ] },
    { id: "u2", name: "", tracking_history: [{ at: iso(T0 + 2 * H), action: "moved", from: "", to: "Rack-05 · floor 3" }] },
    { id: "u3", name: "No history" },
  ];
  assert.deepEqual(unitMoveEntries(units).map(e => [e.at, e.title, e.detail]), [
    [T0 + H, "Tray 53 moved", "Rack-05 · floor 2 → Rack-05 · floor 3 · Moved with OPT53"],
    [T0 + 2 * H, "u2 moved", "? → Rack-05 · floor 3"],
  ]);
  assert.deepEqual(unitMoveEntries(null), []);
});

test("a unit's move as the backend records it ({ rack, u, position }) reads as places, never as [object Object]", () => {
  // inventory_store.record(item, "moved", location(old_rack, old), location(rack, item), note): a server move with
  // units_follow writes this.
  const units = [{ id: "tray-53", name: "Tray 53", tracking_history: [
    { at: iso(T0), action: "moved", from: { rack: "Rack-05", u: 3, position: "" }, to: { rack: "Rack-05", u: 1, position: "" },
      note: "Moved with its server in DCIM or 3D Twin" },
    { at: iso(T0 + H), action: "moved", from: { rack: "Rack-05", u: 1, position: "left" }, to: { rack: "Rack-06", u: 0, position: "" }, note: "" },
  ] }];
  assert.deepEqual(unitMoveEntries(units).map(e => e.detail), [
    "Rack-05 · floor 3 → Rack-05 · floor 1 · Moved with its server in DCIM or 3D Twin",
    "Rack-05 · floor 1 · left → Rack-06 · rack level",
  ]);
  for (const e of unitMoveEntries(units)) assert.doesNotMatch(e.detail, /object/i);
  assert.equal(placeOf({ rack: "Rack-02", u: 7, position: "" }), "Rack-02 · U 7", "above the floors");
  assert.equal(placeOf({ rack: "Rack-02", u: "2" }), "Rack-02 · floor 2");
  assert.equal(placeOf({ rack: "Rack-02", u: null }), "Rack-02");
  assert.equal(placeOf("Rack-04 · floor 3"), "Rack-04 · floor 3", "older entries are text");
  assert.equal(placeOf(null), "");
  assert.equal(placeOf({}), "");
});

test("the timeline is newest first, with this session's Last change on top", () => {
  const timeline = buildTimeline({
    key: "opt11",
    incidents: [
      { id: "a", first_failed_at: iso(T0 - 3 * 24 * H), ended_at: iso(T0 - 3 * 24 * H + H), end_reason: "recovered", failed_checks: 3 },
      { id: "b", first_failed_at: iso(T0 - 2 * H), ended_at: iso(T0 - H), end_reason: "recovered", failed_checks: 2 },
    ],
    removedLog: [{ at: (T0 - 24 * H) / 1000, action: "restored", key: "opt11", by: "admin" }],
    admin: true,
    units: [{ id: "u", name: "NIC", tracking_history: [{ at: iso(T0 - 5 * H), action: "moved", from: "A", to: "B" }] }],
    lastChange: { title: "Swapped with OPT13.", lines: ["PDU 01 · outlet 1: OPT11 → OPT13", ""] },
    format: fmt,
  });
  assert.deepEqual(timeline.map(e => e.kind), ["change", "incident", "unit", "removal", "incident"]);
  assert.equal(timeline[0].title, "This session: Swapped with OPT13.");
  assert.equal(timeline[0].detail, "PDU 01 · outlet 1: OPT11 → OPT13");
  assert.equal(timeline[0].at, null);
  assert.deepEqual(buildTimeline({ key: "opt11" }), [], "nothing recorded: an empty list");
  assert.equal(buildTimeline({ key: "opt11", removedLog: [{ at: 1, action: "removed", key: "opt11" }], admin: false }).length, 0);
  assert.equal(sessionEntry(null), null);
  assert.equal(sessionEntry({}).title, "This session: Saved.");
  assert.match(ELSEWHERE_NOTE, /not recorded yet/);
});

test("the check strip holds the newest 60 checks, oldest first", () => {
  const history = Array.from({ length: 75 }, (_, i) => ({ id: 75 - i }));   // the API answers newest first
  const strip = checkStrip(history);
  assert.equal(strip.length, 60);
  assert.equal(strip[0].id, 16);
  assert.equal(strip.at(-1).id, 75);
  assert.deepEqual(checkStrip(null), []);
  assert.deepEqual(checkStrip(history, 3).map(r => r.id), [73, 74, 75]);
});

test("Monitor this server offers the server's name as its address; unticking a monitored server asks first", () => {
  assert.equal(defaultMonitorHost({ key: "opt90" }), "opt90");
  assert.equal(defaultMonitorHost({ key: "lab router" }), "", "no address that is not a DNS name");
  assert.equal(defaultMonitorHost(null), "");
  assert.equal(pausesMonitor({ enabled: true }, { enabled: false }), true);
  assert.equal(pausesMonitor({ enabled: false }, { enabled: false }), false, "already paused: nothing to ask");
  assert.equal(pausesMonitor({ enabled: true }, { enabled: true }), false);
});

test("power always asks through the provider's PowerConfirmDialog, never window.confirm, and only Operators get it", () => {
  const action = code(read("../server/PowerAction.jsx"));
  const block = code(read("../server/sections/PowerBlock.jsx"));
  for (const [name, source] of [["PowerAction", action], ["PowerBlock", block]]) {
    assert.match(source, /act\.power\??\.request\??\.?\(/, `${name} asks through act.power.request`);
    assert.doesNotMatch(source, /window\.confirm|\bconfirm\(|outletPower|\/outlets\//, `${name} never switches an outlet itself`);
    assert.doesNotMatch(source, /confirm_power/, `${name} does not skip the question when confirm_power is off`);
  }
  assert.match(block, /can\?\.operate && <span className="srv-feed-actions">/, "per-feed buttons for Operators only");
  assert.match(action, /scope: "feed"|"feed"/);
  const hook = read("../server/useServerPower.js");
  assert.match(hook, /Every request asks first through PowerConfirmDialog/);
  assert.doesNotMatch(code(hook), /confirm_power/);
});

test("the header tools: Console through App's openKvmConsole (it marks IN USE and asks when in use), SSH read fresh", () => {
  const tools = read("../server/HeaderTools.jsx");
  assert.match(tools, /act\.openConsole\(port\)/);
  assert.match(tools, /sshStatusStore\.refresh\(\{ force: true \}\)/);
  assert.match(tools, /const ports = operate \? record\.kvm/, "Console only for Operators, and only with a KVM port");
  assert.match(tools, /act\.showIn3d\(\)/);
  const app = read("../App.jsx");
  assert.match(app, /function openKvmConsole\(deviceId, portNumber\)[\s\S]*?port\?\.in_use && !window\.confirm\(/, "App asks when the port is IN USE");
  assert.match(app, /\/autologin\?port=/);
  assert.match(app, /mark-in-use/);
  assert.match(read("../server/ServerWindow.jsx"), /openConsole: kvmPort => base\.app\.openConsole\(kvmPort\.device_id, Number\(kvmPort\.port\)\)/);
});

test("Ping Monitor: a server's monitor opens its window on Activity; other monitors keep the side panel", () => {
  const view = read("../pages/MonitoringView.jsx");
  assert.match(view, /if \(target\?\.server_key\) \{ openServer\(target\.server_key, \{ sec: "activity" \}\); return; \}/);
  assert.match(view, /<ServerHistory key=\{selected\.id\}/, "the side panel stays for monitors with no server key");
  assert.match(view, /MonitorDetails/);
  assert.match(view, /TargetSettings/);
  assert.match(view, /isPlaceholderMonitor/, "the released placeholder filter stays");
  assert.match(view, /useLiveReload\(\["monitoring", "layout"/);
  assert.doesNotMatch(view, /function TargetSettings|async function request\(/, "extracted, not copied");
  const settings = read("../components/monitoring/TargetSettings.jsx");
  assert.match(settings, /Stop monitoring/);
  assert.match(settings, /pausesMonitor\(current/);
  assert.match(settings, /revision: current\.revision/);
  assert.doesNotMatch(settings, /[֐-׿]/, "English UI text");
  const activity = read("../server/sections/ActivitySection.jsx");
  assert.match(activity, /monitorRequest\("\/targets", "POST"/, "Monitor this server");
  assert.match(activity, /can\?\.operate \? <TargetSettings/);
  assert.match(activity, /admin: !!can\?\.admin/, "the removal log for Admins only");
});
