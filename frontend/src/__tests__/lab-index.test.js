// The Manage index (lab/labIndex.js; one-place spec v2 §M.1-M.5): one row per thing in the lab, every kind with the same
// row shape, the problems behind the filter chips, who may select a row, and the ids-mismatch banner.
import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ONLY, OPERATOR_ONLY, PROBLEMS, TWIN_DEVICE_BLOCK, buildLabIndex, deviceReach, filterRows, liveForTwin, mismatchShown,
  mismatchText, rackNames } from "../lab/labIndex.js";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const daysAgo = n => new Date(NOW - n * 86400000).toISOString();

const data = {
  locations: { servers: [
    { key: "opt11", name: "OPT11", rack: "Rack-01", slot: null, kept_position: null, dcim_ids: ["opt11"], drawn: { rack: "Rack-01", u: 1, auto: true },
      pdu: [{ device_id: "pdu1", device_name: "PDU 01", port: "1", label: "OPT11" }], kvm: [{ device_id: "kvm1", device_name: "KVM 01", port: "1", label: "OPT11" }] },
    { key: "opt300", name: "OPT300", rack: null, slot: null, kept_position: null, pdu: [], kvm: [], drawn: null },
    { key: "optn85", name: "optn85", rack: null, slot: null, kept_position: null, pdu: [], kvm: [], drawn: null },
    { key: "opt96", name: "opt96", rack: null, slot: null, kept_position: null, pdu: [], kvm: [], drawn: null },
    { key: "opt74", name: "OPT74", rack: "Rack-01", slot: null, kept_position: null, drawn: null, removed: true,
      pdu: [{ device_id: "pdu1", device_name: "PDU 01", port: "4", label: "OPT74" }], kvm: [] },
  ], empty_ports: { pdu: [{ device_id: "pdu1", device_name: "PDU 01", port: "2" }, { device_id: "pdu1", device_name: "PDU 01", port: "3" }], kvm: [] }, racks: [] },
  devices: [
    { id: "pdu1", kind: "pdu", name: "PDU 01", ip: "192.0.2.1", rack: "Rack-01", port_count: 4, labels: { 1: "OPT11", 2: "Outlet 2", 3: "", 4: "OPT74" } },
    { id: "kvm1", kind: "kvm", name: "KVM 01", ip: "192.0.2.20", rack: "Rack-01", port_count: 4, labels: { 1: "OPT11" } },
    { id: "pdu8", kind: "pdu", name: "PDU-Rack-08", ip: "192.0.2.8", rack: "Rack-08", port_count: 0, labels: {} },
    { id: "rack6", kind: "rack", name: "Compute-Rack-06", ip: "0.0.0.0", rack: "Rack-06", model: "Compute" },
  ],
  pduStatuses: { pdu1: { reachable: true, outlets: [{ number: 1, state: "on", watts: 100 }, { number: 4, state: "on", watts: 50 }] }, pdu8: { reachable: false, outlets: [] } },
  kvmStatuses: { kvm1: { reachable: true, ports: [{ number: 1, in_use: true }] } },
  maintenance: { pdus: {} },
  rackItems: {
    "Rack-01": [{ id: "ci-1", name: "Switch 01", type: "switch", u: 1, serial_number: "SN-SW-01" }],
    "Rack-03": [{ id: "u-pc300", name: "OPT300", type: "computer", u: 2 }],
    "Rack-04": [{ id: "u-old", name: "Old NIC", type: "other", u: 3, last_seen_at: daysAgo(40) }],
    "Storage-Main": [],
  },
  owners: { opt11: "Ada" },
  switches: {},
  monitoring: { targets: [
    { id: "t11", server_key: "opt11", status: "up", host: "opt11.lab", enabled: true },
    { id: "t300", server_key: "opt300", status: "up", host: "opt300.lab", enabled: true },
    { id: "tn85", server_key: "optn85", status: "down", host: "optn85.lab", enabled: true, last_up_at: null },
  ] },
  chillers: { units: [{ id: "ch1", name: "Cooling", rack: "Rack-01", u: 3 }, { id: "ch9", name: "Spare cooler", rack: null }], connections: [] },
  removed: { servers: [], hidden: ["opt74"] },
  hidden: new Set(["opt74"]),
  twin: { data: {
    setups: [{ id: "SETUP-001", name: "Rack L1", dcimRack: "Rack-01" }, { id: "SETUP-009", name: "Old frame", dcimRack: "" }],
    shelves: [{ id: "SHELF-01", setup: "SETUP-001", level: 1 }, { id: "SHELF-02", setup: "SETUP-001", level: 2 }],
    storage: [{ id: "STORAGE-01", name: "Grey cabinet" }],
    items: [
      { id: "ITEM-0001", type: "chiller", name: "Chiller L1", setup: "SETUP-001" },
      { id: "ITEM-0033", type: "pdu", name: "PDU-Rack-01", setup: "SETUP-001", dcim: { deviceId: "pdu-rack01" } },
      { id: "ITEM-0040", type: "pdu", name: "PDU-Rack-08", dcim: { deviceId: "pdu-rack08" } },
      { id: "ITEM-0043", type: "kvm", name: "KVM-Unit-3", dcim: { deviceId: "kvm-unit3" } },
      { id: "ITEM-0044", type: "cart", name: "Blue cart" },
      { id: "ITEM-0049", type: "opt", name: "Opt207", setup: "SETUP-001", shelf: "SHELF-02", dcim: { optKey: "opt207" } },
      { id: "ITEM-0050", type: "opt", name: "optn85", setup: "SETUP-001", shelf: "SHELF-01", dcim: { optKey: "optn85" } },
      { id: "ITEM-0078", type: "equip-switch", name: "Switch 01", setup: "SETUP-001", shelf: "SHELF-01" },
      { id: "ITEM-0090", type: "zone", name: "Zone A" },
    ],
  }, etag: "\"x\"" },
};

const index = (role = "admin") => buildLabIndex(data, role, { now: NOW });
const byUid = rows => new Map(rows.map(r => [r.uid, r]));

test("one row per thing, every kind, with the shared shape", () => {
  const { rows } = index();
  const uids = rows.map(r => r.uid);
  assert.equal(new Set(uids).size, uids.length, "uids are unique");
  for (const uid of ["server:opt11", "server:opt300", "server:optn85", "dev:pdu1", "dev:kvm1", "dev:pdu8", "unit:ci-1", "unit:u-old",
    "cooling:ch1", "cooling:ch9", "rack:Rack-01", "rack:Rack-03", "rack:Rack-06", "rack:Rack-08", "rack:Storage-Main",
    "twin:ITEM-0033", "twin:ITEM-0043", "twin:ITEM-0044", "twin:ITEM-0049", "twin:STORAGE-01", "twin:SETUP-009"]) assert.ok(uids.includes(uid), uid);
  for (const uid of ["unit:u-pc300", "dev:rack6", "twin:ITEM-0040", "twin:ITEM-0050", "twin:ITEM-0078", "twin:ITEM-0001", "twin:SETUP-001"]) {
    assert.ok(!uids.includes(uid), `${uid} is not a row of its own`);
  }
  const keys = ["uid", "kind", "type", "id", "name", "rack", "place", "connection", "state", "owner", "address", "badges", "problems", "twinIds",
    "searchText", "open", "deleteTarget", "deleteRole", "bulkBlockedWhy"];
  for (const row of rows) {
    for (const k of keys) assert.ok(k in row, `${row.uid} has ${k}`);
    assert.ok(row.problems instanceof Set);
    assert.ok(row.badges.length <= 2, `${row.uid}: at most two badges`);
    assert.ok(["server", "pdu", "kvm", "unit", "cooling", "rack", "other"].includes(row.type));
  }
});

test("each row opens its window and deletes as its kind", () => {
  const rows = byUid(index().rows);
  const expect = {
    "server:opt11": [{ kind: "server", id: "opt11" }, { kind: "server", id: "opt11" }, "admin"],
    "server:opt300": [{ kind: "unit", id: "u-pc300" }, { kind: "unit", id: "u-pc300" }, "operator"],
    "dev:pdu1": [{ kind: "dev", id: "pdu1" }, { kind: "device", id: "pdu1" }, "admin"],
    "unit:ci-1": [{ kind: "unit", id: "ci-1" }, { kind: "unit", id: "ci-1" }, "operator"],
    "cooling:ch1": [{ kind: "cooling", id: "ch1" }, { kind: "cooling", id: "ch1" }, "admin"],
    "rack:Rack-01": [{ kind: "rack", id: "Rack-01" }, { kind: "rack", id: "Rack-01" }, "admin"],
    "twin:ITEM-0044": [{ kind: "twin", id: "ITEM-0044" }, { kind: "twin", id: "ITEM-0044" }, "operator"],
  };
  for (const [uid, [open, del, role]] of Object.entries(expect)) {
    const row = rows.get(uid);
    assert.deepEqual([row.open, row.deleteTarget, row.deleteRole], [open, del, role], uid);
  }
});

test("linked 3D records are badges, unlinked ones rows of their own with the reason", () => {
  const rows = byUid(index().rows);
  assert.ok(rows.get("dev:pdu8").badges.includes("In 3D"), "PDU-Rack-08 is linked by its name");
  assert.deepEqual(rows.get("dev:pdu8").twinIds, ["ITEM-0040"]);
  assert.ok(rows.get("server:optn85").badges.includes("In 3D"));
  assert.ok(rows.get("unit:ci-1").badges.includes("In 3D"));
  assert.ok(rows.get("rack:Rack-01").badges.includes("In 3D"));
  assert.ok(rows.get("cooling:ch1").badges.includes("In 3D"), "the first cooling unit takes the chiller of its rack's setup");
  const kvm = rows.get("twin:ITEM-0043");
  assert.equal(kvm.connection, "No KVM with id kvm-unit3 or name KVM-Unit-3 in Lab Manager");
  assert.deepEqual([kvm.type, kvm.state, kvm.badges], ["other", "3D only", ["3D only"]]);
  assert.equal(rows.get("twin:ITEM-0049").place, "3D: Rack-01 shelf 2");
  assert.equal(rows.get("twin:ITEM-0049").rack, "Rack-01", "a 3D record on a mapped frame counts for that rack");
  assert.equal(rows.get("twin:SETUP-009").connection, "Not mapped to a Lab Manager rack");
});

test("problems behind the chips and the More filters", () => {
  const rows = byUid(index().rows);
  const has = (uid, p) => rows.get(uid).problems.has(p);
  assert.ok(has("dev:pdu8", "unreachable") && has("dev:pdu8", "maybe-gone"), "an unreachable PDU needs a look and may be gone");
  assert.ok(has("server:optn85", "unreachable"), "a server whose enabled monitor is down");
  assert.ok(!has("server:opt11", "unreachable") && !has("server:opt11", "maybe-gone"), "OPT11 answers and draws power");
  assert.ok(has("unit:u-old", "maybe-gone"), "a unit not seen for 40 days");
  assert.deepEqual(rows.get("unit:u-old").badges, ["Not seen 40 days"]);
  assert.ok(!has("unit:ci-1", "maybe-gone"), "a unit never scanned is not stale");
  assert.ok(has("twin:ITEM-0044", "maybe-gone") && has("twin:ITEM-0044", "not-in-lm"), "3D-only rows");
  assert.ok(has("server:optn85", "not-in-lm") && rows.get("server:optn85").badges[0] === "Monitor only");
  assert.ok(!has("server:opt300", "not-in-lm"), "a pinged computer unit is in Lab Manager (badge Unit)");
  assert.equal(rows.get("server:opt300").badges[0], "Unit");
  assert.equal(rows.get("server:opt300").place, "Rack-03 · floor 2", "its place is the unit's");
  assert.ok(!has("server:opt96", "not-in-lm") && has("server:opt96", "no-location"), "no monitor: not 'Monitor only', but unplaced");
  assert.ok(has("dev:pdu1", "free-ports"));
  assert.deepEqual(rows.get("dev:pdu1").free, { pdu: ["2", "3"] });
  assert.ok(has("cooling:ch9", "no-location"));
  assert.ok(has("server:opt74", "deleted"), "a removed server is a deleted row");
});

test("counts: every chip and filter count is the length of its filtered list; deleted rows only under Deleted", () => {
  const { rows, counts } = index();
  assert.equal(counts.total, filterRows(rows).length);
  for (const p of PROBLEMS) assert.equal(counts.problems[p], filterRows(rows, { problem: p }).length, p);
  assert.deepEqual(filterRows(rows, { problem: "deleted" }).map(r => r.uid), ["server:opt74"]);
  assert.ok(!filterRows(rows).some(r => r.uid === "server:opt74"));
  for (const type of ["server", "pdu", "kvm", "unit", "cooling", "rack", "other"]) assert.equal(counts.types[type], filterRows(rows, { types: [type] }).length, type);
});

test("connection texts and states", () => {
  const rows = byUid(index().rows);
  assert.equal(rows.get("dev:pdu1").connection, "4 outlets · 2 named", "default and blank outlet names are not counted");
  assert.equal(rows.get("dev:kvm1").connection, "4 ports · 1 in use");
  assert.deepEqual([rows.get("dev:pdu1").state, rows.get("dev:pdu8").state], ["Online", "Unreachable"]);
  assert.equal(rows.get("unit:ci-1").connection, "on OPT11's floor");
  assert.equal(rows.get("unit:ci-1").owner, "Ada", "a unit takes the owner of the server on its floor");
  assert.match(rows.get("rack:Rack-01").connection, /PDU 01, KVM 01 · 1 server · 1 unit/);
  assert.equal(rows.get("rack:Rack-06").typeText, "Rack · Compute");
  assert.equal(rows.get("server:opt11").state, "On");
});

test("who may select a row (bulk) and what the others are told", () => {
  const admin = byUid(index("admin").rows), operator = byUid(index("operator").rows), viewer = byUid(index({ operate: false, admin: false }).rows);
  assert.equal(admin.get("server:opt11").bulkBlockedWhy, "");
  assert.equal(operator.get("server:opt11").bulkBlockedWhy, ADMIN_ONLY);
  assert.equal(operator.get("dev:pdu1").bulkBlockedWhy, ADMIN_ONLY);
  assert.equal(operator.get("unit:ci-1").bulkBlockedWhy, "", "Operators delete units");
  assert.equal(operator.get("twin:ITEM-0044").bulkBlockedWhy, "", "and 3D-only records");
  assert.equal(admin.get("twin:ITEM-0033").bulkBlockedWhy, TWIN_DEVICE_BLOCK, "3D PDU / KVM records are never bulk-selected");
  assert.equal(admin.get("twin:ITEM-0043").bulkBlockedWhy, TWIN_DEVICE_BLOCK);
  assert.equal(viewer.get("unit:ci-1").bulkBlockedWhy, OPERATOR_ONLY);
  assert.equal(admin.get("twin:ITEM-0090").deleteTarget, null, "a zone cannot be deleted");
  assert.equal(admin.get("twin:ITEM-0090").bulkBlockedWhy, "Not deletable");
  assert.equal(viewer.get("server:opt11").address, "", "Viewers do not see server addresses");
  assert.equal(operator.get("server:opt11").address, "opt11.lab");
  assert.equal(viewer.get("dev:pdu1").address, "192.0.2.1", "device addresses are shown to everyone (as Dashboard)");
});

test("filters: types, rack, search over SN and 3D ids", () => {
  const { rows } = index();
  assert.deepEqual(filterRows(rows, { types: ["pdu", "kvm"] }).map(r => r.uid).sort(), ["dev:kvm1", "dev:pdu1", "dev:pdu8"]);
  assert.deepEqual(filterRows(rows, { q: "sn-sw-01" }).map(r => r.uid), ["unit:ci-1"]);
  assert.ok(filterRows(rows, { q: "item-0040" }).some(r => r.uid === "dev:pdu8"), "a linked 3D id finds its Lab Manager row");
  assert.ok(filterRows(rows, { rack: "Rack-08" }).every(r => r.rack === "Rack-08"));
  assert.deepEqual(filterRows(rows, { rack: "Rack-08", types: ["pdu"] }).map(r => r.uid), ["dev:pdu8"]);
});

test("the ids-mismatch banner: more than half of the 3D PDUs / KVMs are not linked", () => {
  const { mismatch } = index();
  assert.deepEqual(mismatch, { unlinked: 2, total: 3 });
  assert.equal(mismatchShown(mismatch), true);
  assert.equal(mismatchShown({ unlinked: 1, total: 2 }), false, "half is not more than half");
  assert.equal(mismatchText({ unlinked: 10, total: 11 }),
    "lab-data.json PDU/KVM ids do not match Lab Manager (10 of 11) — these 3D records are listed as 3D only; check before deleting");
});

test("racks are named by devices and the equipment list; device states follow the cards", () => {
  assert.deepEqual(rackNames(data), ["Rack-01", "Rack-03", "Rack-04", "Rack-06", "Rack-08", "Storage-Main"]);
  assert.deepEqual(liveForTwin(data).racks, rackNames(data));
  assert.equal(deviceReach(null), "unknown");
  assert.equal(deviceReach({ requestFailed: true }), "unavailable");
  assert.equal(deviceReach({ reachable: false }), "offline");
  assert.equal(deviceReach({ reachable: true, error: "401" }), "error");
  assert.equal(deviceReach({ reachable: true }), "online");
});

test("an empty or loading lab builds an empty index", () => {
  const empty = buildLabIndex({}, "viewer");
  assert.deepEqual([empty.rows, empty.counts.total, empty.mismatch], [[], 0, { unlinked: 0, total: 0 }]);
});
