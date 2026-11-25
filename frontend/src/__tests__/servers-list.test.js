// The Manage page's pure helpers (api/serversList.js): v1's server table (Type = Servers), the filters in the URL, the
// "Set outlet counts" candidates, the CSV and the Deleted view.
import { TWIN_ENABLED } from "../twinLinks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { KIND_TEXT, TYPE_CHOICES, connectionRacks, connectionsLoader, csvText, entryRole, entryState, filterConnections, filterServerTable,
  legacyRemoved, mayRestore, openEntries, outletCountCandidates, serverTableRow, showParam, sortServerTable, typeChoice } from "../api/serversList.js";
import { PROBLEMS } from "../lab/labIndex.js";

const record = {
  key: "opt53", name: "OPT53", rack: "Rack-05", drawn: { rack: "Rack-05", u: 3, auto: false },
  pdu: [{ device_id: "pdu5", device_name: "PDU 05", port: "3", state: "on", watts: 90, pduIp: "192.0.2.5" },
    { device_id: "pdu5", device_name: "PDU 05", port: "4", state: "off", watts: null, pduIp: "192.0.2.5" }],
  kvm: [{ device_id: "kvm2", device_name: "KVM 02", port: "5" }],
  owner: { value: "Alice" }, switch: { value: { switch: "SW-05", port: "3" } },
  monitor: { status: "up", enabled: true, host: "opt53.lab" },
};

test("the server table row: state, watts, U, outlets, PDU, switch, owner, KVM, ping; Server IP for Operators only", () => {
  const row = serverTableRow(record, { operate: true });
  assert.deepEqual(row, { key: "opt53", name: "OPT53", rack: "Rack-05", u: 3, state: "on", watts: 90, outlet: 3, outlets: "3, 4",
    pduName: "PDU 05", pduIp: "192.0.2.5", switch: "SW-05·3", owner: "Alice", kvm: "KVM 02 · 5", ping: "up", serverIp: "opt53.lab" });
  assert.equal(serverTableRow(record).serverIp, "", "a Viewer does not get the server address");
  const off = serverTableRow({ ...record, pdu: record.pdu.map(p => ({ ...p, state: "off" })) });
  assert.equal(off.state, "off");
  const bare = serverTableRow({ key: "opt90", name: "OPT90", rack: "Rack-02", drawn: null, pdu: [], kvm: [], owner: { value: "" }, switch: { value: null }, monitor: null });
  assert.deepEqual([bare.state, bare.watts, bare.u, bare.outlet, bare.pduName, bare.ping, bare.rack], ["unknown", null, null, null, "", "", "Rack-02"]);
  assert.equal(serverTableRow({ ...record, monitor: { status: "paused", enabled: false } }).ping, "paused");
  assert.equal(serverTableRow({ ...record, monitor: { status: "up", enabled: false } }).ping, "off");
});

test("state filter and column sort (numbers numerically, blanks last, the name breaks ties)", () => {
  const rows = [
    { name: "OPT10", rack: "Rack-10", state: "on", watts: 50 },
    { name: "OPT2", rack: "Rack-2", state: "off", watts: null },
    { name: "OPT1", rack: "Rack-2", state: "on", watts: 120 },
  ];
  assert.deepEqual(filterServerTable(rows, { state: "on" }).map(r => r.name), ["OPT10", "OPT1"]);
  assert.equal(filterServerTable(rows).length, 3);
  assert.deepEqual(sortServerTable(rows, "watts", 1).map(r => r.name), ["OPT10", "OPT1", "OPT2"]);
  assert.deepEqual(sortServerTable(rows, "watts", -1).map(r => r.name), ["OPT1", "OPT10", "OPT2"], "blanks stay last");
  assert.deepEqual(sortServerTable(rows, "rack", 1).map(r => r.name), ["OPT1", "OPT2", "OPT10"], "natural order; the name breaks the tie");
  assert.deepEqual(rows.map(r => r.name), ["OPT10", "OPT2", "OPT1"], "the input is not changed");
});

test("the Type select and show= in the URL", () => {
  // "3D only" is offered only while the 3D twin is switched on (twinLinks.js TWIN_ENABLED).
  assert.deepEqual(TYPE_CHOICES.map(([l]) => l), ["All", "Servers", "PDUs & KVMs", "PDUs", "KVMs", "Units", "Cooling", "Racks", ...(TWIN_ENABLED ? ["3D only"] : [])]);
  assert.deepEqual(typeChoice(""), { value: "", types: [], label: "All" });
  assert.deepEqual(typeChoice("pdu,kvm"), { value: "pdu,kvm", types: ["pdu", "kvm"], label: "PDUs & KVMs" });
  if (TWIN_ENABLED) assert.deepEqual(typeChoice("other"), { value: "other", types: ["other"], label: "3D only" });
  assert.equal(typeChoice("unit,rack").label, "Custom");
  assert.equal(typeChoice("Server, nonsense").value, "server", "unknown types are dropped");
  assert.equal(showParam("unplaced", PROBLEMS), "no-location", "v1's unplaced");
  assert.equal(showParam("removed", PROBLEMS), "deleted", "v1's removed");
  assert.equal(showParam("all", PROBLEMS), null);
  assert.equal(showParam("maybe-gone", PROBLEMS), "maybe-gone");
  assert.equal(showParam("nonsense", PROBLEMS), null);
  assert.equal(showParam(null, PROBLEMS), null);
});

test("Set outlet counts: PDUs with no count whose status lists outlets", () => {
  const devices = [{ id: "pdu1", kind: "pdu", name: "PDU 01", port_count: 24 }, { id: "pdu8", kind: "pdu", name: "PDU-Rack-08", port_count: 0 },
    { id: "pdu9", kind: "pdu", name: "PDU 09", port_count: 0 }, { id: "pdu10", kind: "pdu", name: "PDU 10" }, { id: "kvm1", kind: "kvm", port_count: 0 }];
  const statuses = { pdu8: { reachable: true, outlets: [{}, {}, {}] }, pdu9: { reachable: false, outlets: [{}] }, pdu10: { requestFailed: true, outlets: [{}] } };
  assert.deepEqual(outletCountCandidates(devices, statuses), [{ id: "pdu8", name: "PDU-Rack-08", count: 3 }]);
  assert.deepEqual(outletCountCandidates(null, null), []);
});

test("CSV: quoted where needed, formulas defused, CRLF lines", () => {
  const text = csvText([["Name", r => r.name], ["Note", r => r.note]], [{ name: "OPT1", note: "a, b" }, { name: "=SUM(A1)", note: "say \"hi\"" }, { name: null, note: "" }]);
  assert.equal(text, "Name,Note\r\nOPT1,\"a, b\"\r\n\"'=SUM(A1)\",\"say \"\"hi\"\"\"\r\n,\r\n");
});

test("the Deleted view: entry states, what Restore batch brings back, who may restore", () => {
  assert.equal(entryState({ restorable: true }), "Restorable");
  assert.equal(entryState({ restorable: false, why_not: "PDU 01 outlet 1 is taken" }), "Not restorable: PDU 01 outlet 1 is taken");
  assert.match(entryState({ restored_at: "2026-11-24T10:00:00Z" }), /^Restored /);
  const batch = { id: "b1", entries: [{ kind: "twin", id: "ITEM-0044", restorable: true }, { kind: "unit", id: "u1", restored_at: "2026-11-24T10:00:00Z" },
    { kind: "device", id: "pdu8", restorable: false }] };
  assert.deepEqual(openEntries(batch).map(e => e.id), ["ITEM-0044"]);
  assert.deepEqual(["server", "device", "dev", "rack", "cooling", "unit", "twin"].map(entryRole), ["admin", "admin", "admin", "admin", "admin", "operator", "operator"]);
  assert.equal(mayRestore("unit", { operate: true, admin: false }), true);
  assert.equal(mayRestore("device", { operate: true, admin: false }), false);
  assert.equal(mayRestore("device", { operate: true, admin: true }), true);
  assert.equal(mayRestore("twin", { operate: false, admin: false }), false);
  assert.equal(KIND_TEXT.twin, "3D record");
});

test("servers removed before this release show unless an open batch entry covers them", () => {
  const removed = { servers: [{ key: "opt74", name: "OPT74" }, { key: "opt98", name: "OPT98" }, { key: "opt12", name: "OPT12" }] };
  const batches = [{ id: "b1", entries: [{ kind: "server", id: "opt12" }] }, { id: "b2", entries: [{ kind: "server", id: "opt98", restored_at: "2026-11-24T10:00:00Z" }] }];
  assert.deepEqual(legacyRemoved(removed, batches).map(s => s.key), ["opt74", "opt98"]);
  assert.deepEqual(legacyRemoved(null, null), []);
});

test("the Connections helpers moved here unchanged", async () => {
  const servers = [
    { key: "opt1", name: "OPT1", rack: "Rack-1", pdu: [{ device_name: "PDU 01", port: 1, rack: "Rack-1" }], kvm: [] },
    { key: "opt2", name: "OPT2", rack: "Rack-2", pdu: [{ device_name: "PDU 02", port: 1, rack: "Rack-2" }, { device_name: "PDU 02", port: 2, rack: "Rack-2" }],
      kvm: [{ device_name: "KVM 01", port: 3 }] },
    { key: "opt3", name: "OPT3", rack: null, pdu: [], kvm: [] },
  ];
  assert.deepEqual(connectionRacks(servers), ["Rack-1", "Rack-2"]);
  assert.deepEqual(filterConnections(servers, { connection: "missing-kvm" }).map(s => s.key), ["opt1", "opt3"]);
  assert.deepEqual(filterConnections(servers, { connection: "missing-pdu" }).map(s => s.key), ["opt3"]);
  assert.deepEqual(filterConnections(servers, { connection: "single-feed" }).map(s => s.key), ["opt1"]);
  assert.deepEqual(filterConnections(servers, { search: "#3" }).map(s => s.key), ["opt2"]);
  const seen = [];
  const loader = connectionsLoader(async () => "data", { onData: d => seen.push(d), onDenied: () => seen.push("denied") });
  await loader.load(false);
  loader.stop();
  await loader.load(false);
  assert.deepEqual(seen, ["data"], "nothing is reported after stop()");
  const denied = connectionsLoader(async () => { const e = new Error("no"); e.status = 403; throw e; }, { onDenied: () => seen.push("denied") });
  await denied.load(false);
  assert.equal(await denied.load(false), false, "a 403 stops the cycle");
  assert.deepEqual(seen, ["data", "denied"]);
});
