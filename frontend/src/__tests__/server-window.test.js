import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { NON_SERVER_LABEL, isServerLabel, windowKey } from "../server/serverKey.js";
import { ownerOf, ownerReadKeys, ownerWriteKeys, switchOf, withSwitch } from "../server/ownerKey.js";
import { buildRecord, dcimIdsOf, drawnOf, placeText, serverList } from "../server/serverRecord.js";
import { parseWindow, windowSearch } from "../window/windowUrl.js";
import { buildLabIndex, filterRows, PROBLEMS, TYPES } from "../lab/labIndex.js";
import { storageRacksFromDevices } from "../components/racks/floors.js";

// The server window's foundation (v1 WP-0 / v2 WP-0): keys, owners and switch across feeds, the record, the URL and
// the roles every action needs.
const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("windowKey: placeholders and default port names open nothing; every feed of a server is one window", () => {
  for (const label of ["KVM Power", "kvm_power", "Empty", "spare", "PDU", "--", "N/A", "free", "Outlet 3", "Port 3", "", "  ", null, undefined]) {
    assert.equal(windowKey(label), null, `${JSON.stringify(label)} is not a server`);
    assert.equal(isServerLabel(label), false);
  }
  assert.equal(windowKey("OPTN45 (PSU2)"), "optn45");
  assert.equal(windowKey("OPTN45 (PSU1)"), "optn45");
  assert.equal(windowKey("  OPT11 "), "opt11");
  assert.equal(windowKey("Spare 2"), "spare 2", "a name that only starts with a placeholder word is a server name");
  assert.equal(windowKey("Lab printer"), "lab printer");
});

test("NON_SERVER_LABEL is byte for byte the regex of DcimView, the backend and the 3D twin", () => {
  const text = NON_SERVER_LABEL.source;
  assert.match(read("../pages/DcimView.jsx"), new RegExp(`const NON_SERVER_LABEL = /${text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}/i;`));
  const py = read("../../../backend/app/ping_monitor.py").match(/_NON_SERVER_LABEL = re\.compile\(r"([^"]+)", re\.I\)/)?.[1];
  assert.equal(py, text);
  const twin = read("../../../lab-twin/app.js").match(/const NON_SERVER_LABEL = \/(.+)\/i;/)?.[1];
  assert.equal(twin, text);
  assert.equal(NON_SERVER_LABEL.flags, "i");
});

test("ownerKey: read every key, show one owner, say when feeds disagree, write every key", () => {
  const record = { key: "opt53", dcim_ids: ["opt53 (psu1)", "opt53 (psu2)", "opt53 (psu1)"] };
  assert.deepEqual(ownerReadKeys(record), ["opt53", "opt53 (psu1)", "opt53 (psu2)"]);
  assert.deepEqual(ownerWriteKeys(record), ["opt53", "opt53 (psu1)", "opt53 (psu2)"]);
  assert.deepEqual(ownerOf(record, { "opt53 (psu1)": "Alice", "opt53 (psu2)": "Bob" }),
    { value: "Alice", perKey: { "opt53 (psu1)": "Alice", "opt53 (psu2)": "Bob" }, disagree: true });
  assert.deepEqual(ownerOf(record, { opt53: "Carol", "opt53 (psu2)": "Carol" }), { value: "Carol", perKey: { opt53: "Carol", "opt53 (psu2)": "Carol" }, disagree: false });
  assert.deepEqual(ownerOf(record, { opt53: " ", other: "X" }), { value: "", perKey: {}, disagree: false });
  assert.deepEqual(ownerOf({ key: "opt11", dcim_ids: ["opt11"] }, null), { value: "", perKey: {}, disagree: false });
});

test("switch: read from the DCIM ids, written under every one of them", () => {
  const record = { key: "opt53", dcim_ids: ["opt53 (psu1)", "opt53 (psu2)"] };
  const doc = { "opt53 (psu1)": { switch: "SW-1", port: "7" }, "opt53 (psu2)": { switch: "SW-2", port: "7" }, keep: { switch: "X" } };
  assert.deepEqual(switchOf(record, doc).disagree, true);
  assert.deepEqual(switchOf(record, doc).value, { switch: "SW-1", port: "7" });
  const next = withSwitch(doc, record, { switch: "SW-9", port: 3 });
  assert.deepEqual([next["opt53 (psu1)"], next["opt53 (psu2)"], next.keep], [{ switch: "SW-9", port: "3" }, { switch: "SW-9", port: "3" }, { switch: "X" }]);
  assert.equal(doc["opt53 (psu1)"].switch, "SW-1", "the input is not changed");
  const cleared = withSwitch(doc, record, { switch: "", port: "" });
  assert.equal("opt53 (psu1)" in cleared, false);
  assert.deepEqual(switchOf({ key: "opt9", dcim_ids: [] }, { opt9: { switch: "S" } }).value, { switch: "S", port: "" }, "no DCIM id: the identity key");
});

// A /locations body like the fixture's (DCIM_FIXTURE_ONE_PLACE=1), with WP-B's fields on some rows and not on others.
const data = {
  locations: { servers: [
    { key: "opt11", name: "OPT11", rack: "Rack-01", slot: null, kept_position: { rack: null, slot: null },
      pdu: [{ device_id: "pdu1", device_name: "PDU 01", port: "1", label: "OPT11" }], kvm: [{ device_id: "kvm1", device_name: "KVM 01", port: "1", label: "OPT11" }],
      dcim_ids: ["opt11"], drawn: { rack: "Rack-01", u: 1, auto: true }, removed: false },
    { key: "opt12", name: "OPT12", rack: "Rack-01", slot: null, kept_position: null,
      pdu: [{ device_id: "pdu1", device_name: "PDU 01", port: "2", label: "OPT12" }], kvm: [], drawn: { rack: "Rack-01", u: 1, auto: false } },
    { key: "opt53", name: "OPT53 (PSU1)", rack: "Rack-05", slot: 3, kept_position: { rack: "Rack-05", slot: 3 },
      pdu: [{ device_id: "pdu5", device_name: "PDU 05", port: "3", label: "OPT53 (PSU1)" }, { device_id: "pdu5", device_name: "PDU 05", port: "4", label: "OPT53 (PSU2)" }], kvm: [] },
    { key: "opt90", name: "OPT90", rack: "Rack-02", slot: null, kept_position: { rack: null, slot: null }, pdu: [],
      kvm: [{ device_id: "kvm2", device_name: "KVM 02", port: "2", label: "OPT90" }], drawn: null },
    { key: "opt96", name: "opt96", rack: null, slot: null, kept_position: { rack: null, slot: null }, pdu: [], kvm: [], drawn: null },
    { key: "optn85", name: "optn85", rack: null, slot: null, kept_position: { rack: null, slot: null }, pdu: [], kvm: [], drawn: null },
  ], empty_ports: { pdu: [], kvm: [] }, racks: [] },
  devices: [{ id: "pdu1", kind: "pdu", name: "PDU 01", ip: "192.0.2.1", rack: "Rack-01", labels: { 1: "OPT11", 2: "OPT12" } },
    { id: "pdu5", kind: "pdu", name: "PDU 05", ip: "192.0.2.5", rack: "Rack-05", labels: { 3: "OPT53 (PSU1)", 4: "OPT53 (PSU2)" } }],
  pduStatuses: { pdu1: { reachable: true, outlets: [{ number: 1, label: "OPT11", state: "on", watts: 100 }, { number: 2, label: "OPT12", state: "off", watts: 0 }] },
    pdu5: { reachable: true, outlets: [{ number: 3, label: "OPT53 (PSU1)", state: "on", watts: 90 }, { number: 4, label: "OPT53 (PSU2)", state: "on", watts: 95 }] } },
  kvmStatuses: { kvm1: { ports: [{ number: 1, label: "OPT11", in_use: true }] } },
  maintenance: { pdus: {} },
  rackItems: { "Rack-01": [{ id: "ci-1", name: "Switch 01", type: "switch", u: 1 }, { id: "ci-9", name: "Rack level", u: 0 }],
    "Rack-05": [{ id: "u-5", name: "", model: "Tray X", u: 3 }] },
  owners: { opt11: "Fixture owner", "opt53 (psu1)": "Alice", "opt53 (psu2)": "Bob" },
  switches: { opt11: { switch: "SW-01", port: "1" } },
  monitoring: { targets: [{ id: "t11", server_key: "opt11", status: "up", host: "opt11", enabled: true, last_up_at: new Date().toISOString() },
    { id: "tn85", server_key: "optn85", status: "down", host: "optn85", enabled: true, last_up_at: null }] },
  removed: { servers: [{ key: "opt98", name: "OPT98", removed_at: 1700000000, active: true, position: { rack: "Rack-06", slot: 4 },
    ports: [{ device_id: "pdu6", device_name: "PDU 06", kind: "pdu", port: "4", label: "OPT98" }] }], hidden: ["opt98"] },
};

test("buildRecord: a drawn server with its ports, owner, switch, monitor, floor units and the server sharing the floor", () => {
  const r = buildRecord("opt11", data);
  assert.equal(r.name, "OPT11");
  assert.deepEqual(r.dcim_ids, ["opt11"]);
  assert.deepEqual(r.drawn, { rack: "Rack-01", u: 1, auto: true });
  assert.deepEqual(r.pdu, [{ device_id: "pdu1", device_name: "PDU 01", port: "1", label: "OPT11", state: "on", watts: 100, pduIp: "192.0.2.1" }]);
  assert.deepEqual(r.kvm, [{ device_id: "kvm1", device_name: "KVM 01", port: "1", label: "OPT11", inUse: true }]);
  assert.equal(r.owner.value, "Fixture owner");
  assert.deepEqual(r.switch.value, { switch: "SW-01", port: "1" });
  assert.equal(r.monitor.id, "t11");
  assert.deepEqual(r.units.map(u => u.id), ["ci-1"], "the rack level (u 0) is no floor");
  assert.deepEqual(r.floorShared, ["OPT12"]);
  assert.equal(r.project, "Switch 01");
  assert.equal(r.powerGroup.state, "on");
  assert.deepEqual([r.removed, r.missing, r.loading], [null, false, false]);
  assert.equal(placeText(r), "Rack-01 · floor 1");
});

test("buildRecord: a two-PSU server without WP-B's fields (an older backend): ids and place are derived", () => {
  const r = buildRecord("opt53", data);
  assert.deepEqual(r.dcim_ids, ["opt53 (psu1)", "opt53 (psu2)"]);
  assert.deepEqual(r.drawn, { rack: "Rack-05", u: 3, auto: false });
  assert.equal(r.pdu.length, 2);
  assert.deepEqual(r.owner, { value: "Alice", perKey: { "opt53 (psu1)": "Alice", "opt53 (psu2)": "Bob" }, disagree: true });
  assert.equal(r.powerGroup.feeds.length, 2, "one power group with both feeds");
  assert.equal(r.project, "Tray X", "a unit with no name: its model");
  assert.deepEqual(dcimIdsOf({ name: "OPT7", pdu: [], kvm: [] }), ["opt7"]);
  assert.equal(drawnOf({ rack: "Rack-01", slot: null, pdu: [], kvm: [{}] }), null, "no PDU outlet: not drawn");
});

test("buildRecord: KVM-only, unplaced and monitor-only servers open too", () => {
  const kvmOnly = buildRecord("opt90", data);
  assert.deepEqual([kvmOnly.drawn, kvmOnly.rack, kvmOnly.pdu.length, kvmOnly.kvm.length, kvmOnly.units.length], [null, "Rack-02", 0, 1, 0]);
  assert.equal(placeText(kvmOnly), "Rack-02 · not drawn");
  const unplaced = buildRecord("opt96", data);
  assert.deepEqual([unplaced.drawn, unplaced.rack, unplaced.missing], [null, null, false]);
  assert.equal(placeText(unplaced), "Not on a rack");
  const monitorOnly = buildRecord("optn85", data);
  assert.equal(monitorOnly.monitor.status, "down");
  assert.equal(monitorOnly.powerGroup, null);
});

test("buildRecord: a removed server whose labels are gone is built from its removal record (read-only)", () => {
  const r = buildRecord("opt98", data);
  assert.equal(r.name, "OPT98");
  assert.equal(r.removed.active, true);
  assert.equal(r.missing, false);
  assert.equal(r.rack, "Rack-06");
  assert.deepEqual(r.pdu.map(p => [p.device_id, p.port, p.label]), [["pdu6", "4", "OPT98"]]);
  assert.equal(r.drawn, null, "not drawn anywhere");
  const gone = buildRecord("opt77", data);
  assert.deepEqual([gone.missing, gone.name], [true, "opt77"]);
  assert.equal(buildRecord("opt11", { ...data, locations: null }).loading, true, "no list yet: loading, never missing");
  assert.equal(buildRecord("opt11", { ...data, locations: null }).missing, false);
});

test("buildRecord: WP-B's removed flag makes a removed server read-only before the removal list arrives", () => {
  const row = { key: "opt74", name: "OPT74", rack: "Rack-07", slot: null, kept_position: null, dcim_ids: ["opt74"], drawn: null, removed: true,
    pdu: [{ device_id: "pdu7", device_name: "PDU 07", port: "4", label: "OPT74" }], kvm: [] };
  const locations = { ...data.locations, servers: [...data.locations.servers, row] };
  const early = buildRecord("opt74", { ...data, locations, removed: null });
  assert.deepEqual([early.removed, early.missing, early.loading], [{ record: { key: "opt74", name: "OPT74" }, active: true }, false, false]);
  const later = buildRecord("opt74", { ...data, locations, removed: { servers: [{ key: "opt74", name: "OPT74", removed_at: 1700000000, active: true }] } });
  assert.equal(later.removed.record.removed_at, 1700000000, "the removal record wins once it has loaded");
  assert.equal(buildRecord("opt11", { ...data, removed: null }).removed, null, "removed: false (or no flag) is not removed");
});

test("the server list for pickers leaves removed servers out unless the viewer is an Admin", () => {
  const withRemoved = { servers: [...data.locations.servers, { key: "opt44", name: "OPT44", rack: "Rack-04", pdu: [], kvm: [], removed: true }] };
  assert.equal(serverList(withRemoved).some(s => s.key === "opt44"), false);
  assert.equal(serverList(withRemoved, { admin: true }).find(s => s.key === "opt44").removed, true);
  assert.equal(serverList(data.locations, { hidden: new Set(["opt12"]) }).some(s => s.key === "opt12"), false);
});

test("server rows of the Manage index: badges, problems and who may select them", () => {
  const items = { ...data.rackItems, "Rack-03": [{ id: "u-pc300", type: "computer", name: "OPT300", u: 2 }] };
  const locations = { ...data.locations, servers: [...data.locations.servers, { key: "opt300", name: "opt300", rack: null, pdu: [], kvm: [], kept_position: null }] };
  const { rows, counts } = buildLabIndex({ ...data, rackItems: items, locations }, "operator");
  const row = key => rows.find(r => r.id === key);
  assert.deepEqual(TYPES, ["server", "pdu", "kvm", "unit", "cooling", "rack", "other"]);
  assert.equal(PROBLEMS.length, 9);
  assert.deepEqual(row("optn85").badges, ["Monitor only"]);
  assert.ok(row("optn85").problems.has("not-in-lm") && row("optn85").problems.has("maybe-gone") && row("optn85").problems.has("unreachable"));
  assert.deepEqual(row("opt300").badges, ["Unit"]);
  assert.deepEqual(row("opt300").open, { kind: "unit", id: "u-pc300" }, "a pinged computer unit opens the unit window");
  assert.equal(row("opt300").bulkBlockedWhy, "", "an Operator may delete a unit");
  assert.equal(row("opt11").bulkBlockedWhy, "Admin only");
  assert.ok(row("opt53").problems.has("missing-kvm") && !row("opt53").problems.has("single-feed"));
  assert.ok(row("opt12").problems.has("single-feed"));
  assert.ok(row("opt96").problems.has("no-location"));
  assert.equal(row("opt11").address, "opt11", "Operators see the server address");
  assert.equal(buildLabIndex(data, "viewer").rows.find(r => r.id === "opt11").address, "", "Viewers do not");
  assert.equal(counts.types.server, rows.length);
  assert.deepEqual(filterRows(rows, { problem: "no-location" }).map(r => r.id).sort(), ["opt300", "opt96", "optn85"]);
  assert.deepEqual(filterRows(rows, { q: "fixture owner" }).map(r => r.id), ["opt11"]);
  assert.deepEqual(filterRows(rows, { rack: "Rack-05" }).map(r => r.id), ["opt53"]);
});

test("storage racks come from the device list too (Main storage and racks whose first device is Storage)", () => {
  assert.deepEqual(storageRacksFromDevices([{ kind: "rack", rack: "Storage shelf", model: "Storage" }, { kind: "pdu", rack: "Rack-01", model: "PX4" },
    { kind: "rack", rack: "Rack-01", model: "Storage" }, { kind: "kvm", rack: "Rack-02", model: "Storage" }]), ["Storage-Main", "Storage shelf"]);
});

test("URL rules: srv= opens a server window over any tab; v1's alias and the window components keep their names", () => {
  assert.deepEqual(parseWindow("?tab=dashboard&srv=opt11"), { kind: "server", id: "opt11" });
  assert.equal(windowSearch("?tab=inventory", { kind: "server", id: "opt12x" }), "?tab=inventory&srv=opt12x");
  const context = read("../window/labWindowContext.js");
  assert.match(context, /export const useServerWindow = useLabWindow;/);
  const provider = read("../window/LabWindowProvider.jsx");
  assert.match(provider, /export \{ useLabData, useLabWindow, useServerWindow \};/);
  // Opening pushes a history entry with the page's own state; closing goes back when this page pushed it.
  assert.match(provider, /window\.history\.pushState\(\{ \.\.\.state, labWindow: token \}, "", href\)/);
  assert.match(provider, /if \(token && pushed\.current\.has\(token\)\) \{ window\.history\.back\(\); return; \}/);
  assert.match(provider, /window\.addEventListener\("popstate", sync\)/);
  assert.match(provider, /server: ServerWindow, dev: DeviceWindow, rack: RackWindow, unit: UnitWindow, cooling: CoolingWindow, twin: TwinItemWindow/);
  const shell = read("../window/WindowShell.jsx");
  assert.match(shell, /role="dialog" aria-modal="true"/);
  assert.match(shell, /data-window=\{kind\}/);
  assert.match(shell, /Viewer · read only/);
  assert.match(read("../window/window.css"), /z-index: 55/);
  assert.match(read("../components/InlineKvmConsole.jsx"), /fixed inset-0 z-\[65\]/);
  assert.match(read("../components/KvmViewerModal.jsx"), /fixed inset-0 z-\[65\]/);
});

// ── roles: every action the windows offer, read from the backend's reviewed route table ──
const routeRoles = (() => {
  const source = read("../../../backend/tests/test_gap_accounts.py");
  const roles = {};
  for (const m of source.matchAll(/"((?:GET|PUT|POST|PATCH|DELETE) \/api\/[^"]+)": "(Viewer|Operator|Admin)"/g)) roles[m[1]] = m[2];
  return roles;
})();

test("role map: window actions are Operator, removing and restoring are Admin, the unkeyed owner map is Admin", () => {
  const operator = ["POST /api/devices/move-server", "POST /api/devices/rename-opt", "PATCH /api/devices/direct-label",
    "PUT /api/opt-owners/{asset_key:path}", "PUT /api/switch-assignments", "POST /api/pdus/{device_id}/outlets/{outlet_number}/power",
    "POST /api/monitoring/targets", "PUT /api/monitoring/targets/{target_id}", "POST /api/inventory"];
  for (const route of operator) assert.equal(routeRoles[route], "Operator", route);
  for (const route of ["POST /api/removed-servers", "POST /api/removed-servers/restore", "PUT /api/opt-owners"]) assert.equal(routeRoles[route], "Admin", route);
  for (const route of ["GET /api/devices/locations", "GET /api/rack-items", "GET /api/opt-owners", "GET /api/switch-assignments", "GET /api/monitoring",
    "GET /api/chillers", "GET /api/twin-data", "GET /api/removed-servers"]) assert.equal(routeRoles[route], "Viewer", `${route}: every role can open a window`);
});

test("no window file writes the unkeyed owner map (PUT /api/opt-owners is Admin and replaces every owner)", () => {
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = new URL(`${name}`, dir);
      if (statSync(path).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.(js|jsx)$/.test(name)) files.push(path);
    }
  };
  for (const dir of ["../server/", "../window/", "../devices/", "../units/", "../lab/"]) walk(new URL(dir, import.meta.url));
  assert.ok(files.length >= 20, "the window files are found");
  // Every way this code base writes a whole document: fetch(path, { method: "PUT" }), req("PUT", path),
  // accountRequest(path, "PUT", body) and saveLayout(path, edit) (api/layout.js, a PUT with If-Match).
  const wholeMap = [
    /["'`](?:\/api)?\/opt-owners["'`]\s*,\s*\{[^}]*method:\s*["']PUT/,
    /req\(\s*["']PUT["']\s*,\s*["'`](?:\/api)?\/opt-owners["'`]/,
    /["'`](?:\/api)?\/opt-owners["'`]\s*,\s*["']PUT["']/,
    /saveLayout\(\s*["'`](?:\/api)?\/opt-owners["'`]/,
  ];
  for (const sample of ['fetch("/api/opt-owners", { method: "PUT", body })', 'req("PUT", "/api/opt-owners", map)',
    'accountRequest("/opt-owners", "PUT", map)', 'saveLayout("/api/opt-owners", doc => doc)']) {
    assert.ok(wholeMap.some(re => re.test(sample)), `the check catches ${sample}`);
  }
  for (const keyed of ['accountRequest(`/opt-owners/${encodeURIComponent(key)}`, "PUT", body)', 'loadLayout("/api/opt-owners")']) {
    assert.ok(!wholeMap.some(re => re.test(keyed)), `a keyed write or a read is allowed: ${keyed}`);
  }
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const re of wholeMap) assert.doesNotMatch(text, re, `${file.pathname} PUTs the whole owner map`);
  }
});
