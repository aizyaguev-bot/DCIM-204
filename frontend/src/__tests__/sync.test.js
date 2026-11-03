import test from "node:test";
import assert from "node:assert/strict";
import { syncClearPlan } from "../api/locations.js";
import {
  syncKvmIndex, syncKvmPorts, syncKvmUnavailable, syncPduUnavailable, syncPduRows, syncPduSummary,
  syncKvmChanged, syncKvmConflict, syncSaveWrites, runSyncWrites, syncSaveFailureText,
} from "../api/sync.js";

const kvm = { id: "kvm1", name: "KVM 01", kind: "kvm", port_count: 4, labels: { 1: "OPT11", 4: "OPT14" } };
const pdu = { id: "pdu1", name: "PDU 01", kind: "pdu", port_count: 4, labels: { 1: "OPT11", 2: "OPT12", 4: "OPT14" } };
const live = labels => ({ device_id: "kvm1", reachable: true, ports: labels.map((label, i) => ({ number: i + 1, label })) });
// The PDU row for outlet 4, linked to KVM 01 port 4 the way the page builds it.
const row = (overrides = {}) => ({
  pdu_id: "pdu1", pdu_name: "PDU 01", outlet_number: 4, label: "OPT14", assigned: true,
  kvm: { device_id: "kvm1", device_name: "KVM 01", port: "4", label: "OPT14" }, ...overrides,
});
const draft = overrides => ({ label: "OPT14", kvmDeviceId: "kvm1", kvmPort: "4", ...overrides });

test("syncKvmConflict: linking a port another server uses names the port and that server", () => {
  const message = syncKvmConflict(row(), draft({ kvmPort: "2" }), "KVM 01", "OPT12");
  assert.match(message, /KVM 01 port 2/);
  assert.match(message, /OPT12/);
  assert.match(message, /OPT14/);
});

test("syncKvmConflict: free, unknown, own or same-server ports ask nothing", () => {
  assert.equal(syncKvmConflict(row(), draft({ kvmPort: "2" }), "KVM 01", "Port 2"), null);
  assert.equal(syncKvmConflict(row(), draft({ kvmPort: "2" }), "KVM 01", ""), null);
  assert.equal(syncKvmConflict(row(), draft({ kvmPort: "2" }), "KVM 01", undefined), null, "typed by hand");
  const opt21 = row({ label: "OPT21", outlet_number: 1, kvm: null });
  assert.equal(syncKvmConflict(opt21, draft({ label: "OPT21", kvmPort: "3" }), "KVM 01", "OPT21 (KVM)"), null);
  assert.equal(syncKvmConflict(row(), draft(), "KVM 01", "OPT14"), null, "the row's own port");
  assert.equal(syncKvmConflict(row(), draft({ kvmDeviceId: "" }), "KVM 01", "OPT12"), null, "no KVM chosen");
  assert.equal(syncKvmConflict(row(), draft({ kvmPort: "" }), "KVM 01", "OPT12"), null, "no port chosen");
});

test("syncKvmIndex: saved labels keep the links while the KVM status is unavailable", () => {
  for (const status of [undefined, { device_id: "kvm1", reachable: false, ports: [] },
    { device_id: "kvm1", requestFailed: true, ports: [], error: "HTTP 502" }]) {
    const index = syncKvmIndex([kvm], { kvm1: status });
    assert.deepEqual(index.opt11, { device_id: "kvm1", device_name: "KVM 01", port: "1", label: "OPT11" });
    assert.equal(index.opt14.port, "4");
    assert.equal(index.opt12, undefined, "a port with nothing saved has no link to show");
  }
});

test("syncKvmIndex: ports are merged per port; the polled status wins for the ports it lists", () => {
  // The server applies saved labels to every status it returns, and the device list is not polled, so for a port the
  // status lists the polled label is the fresher one. A saved label fills ports the status does not list.
  const index = syncKvmIndex([{ ...kvm, port_count: 5, labels: { 3: "Port 3", 5: "OPT15" } }], { kvm1: live(["OPT11", "OPT12", "OPT99"]) });
  assert.deepEqual(Object.keys(index).sort(), ["opt11", "opt12", "opt15", "opt99"]);
  assert.equal(index.opt99.port, "3");
  assert.equal(index.opt15.port, "5");
  // While the status is unavailable a saved "Port 3" is what the port holds: no stale link to OPT99.
  const down = syncKvmIndex([{ ...kvm, labels: { 3: "Port 3" } }], { kvm1: { reachable: false, ports: [] } });
  assert.deepEqual(down, {});
});

test("syncKvmPorts: unavailable KVMs list 1..port_count with their saved labels", () => {
  assert.deepEqual(syncKvmPorts(kvm, { reachable: false, ports: [] }),
    [{ number: "1", label: "OPT11" }, { number: "2", label: "" }, { number: "3", label: "" }, { number: "4", label: "OPT14" }]);
  assert.deepEqual(syncKvmPorts({ id: "k", port_count: 0, labels: {} }, undefined), []);
  assert.deepEqual(syncKvmPorts(kvm, live(["A", "B"])).map(p => p.label), ["A", "B", "OPT14"]);
});

test("syncClearPlan on an index row clears the outlet and the linked KVM port", () => {
  const index = syncKvmIndex([kvm], { kvm1: { reachable: false, ports: [] } });
  const [, , , outlet4] = syncPduRows(pdu, { reachable: false, outlets: [] }, index);
  const plan = syncClearPlan(outlet4);
  assert.match(plan.message, /and KVM 01 port 4\?$/);
  assert.deepEqual(plan.ports.map(p => [p.device_id, p.port, p.label]), [["pdu1", "4", "OPT14"], ["kvm1", "4", "OPT14"]]);
});

test("syncPduRows: an unreachable PDU lists its saved labels, not a placeholder", () => {
  const rows = syncPduRows(pdu, { device_id: "pdu1", reachable: false, outlets: [], error: "Timeout" }, {});
  assert.deepEqual(rows.map(r => [r.outlet_number, r.label, r.assigned, r.noStatus]),
    [[1, "OPT11", true, false], [2, "OPT12", true, false], [3, "", false, false], [4, "OPT14", true, false]]);
  // Saved keys beyond port_count are listed too.
  assert.deepEqual(syncPduRows({ ...pdu, port_count: 1, labels: { 7: "OPT17" } }, { requestFailed: true, outlets: [] }).map(r => r.outlet_number), [1, 7]);
  // Placeholders: not loaded yet, and unreachable with nothing saved.
  assert.deepEqual(syncPduRows(pdu, undefined).map(r => [r.noStatus, r.pending]), [[true, true]]);
  assert.deepEqual(syncPduRows({ ...pdu, port_count: 0, labels: {} }, { reachable: false, outlets: [] }).map(r => [r.noStatus, r.pending]), [[true, false]]);
  // Live outlets are used as they are.
  const liveRows = syncPduRows(pdu, { reachable: true, outlets: [{ number: 1, label: "OPT11", state: "on", watts: 90 }] }, { opt11: { device_id: "kvm1" } });
  assert.deepEqual(liveRows.map(r => [r.outlet_number, r.outlet_state, r.outlet_watts, r.kvm?.device_id]), [[1, "on", 90, "kvm1"]]);
});

test("syncPduSummary and the unavailable lists show the device state instead of 0 on", () => {
  assert.equal(syncPduSummary({ reachable: false, outlets: [], error: "Timeout" }), "Offline · Timeout");
  assert.equal(syncPduSummary({ requestFailed: true, outlets: [], error: "HTTP 502" }), "Status unavailable · HTTP 502");
  assert.equal(syncPduSummary({ reachable: true, total_watts: 210.4, outlets: [{ state: "on" }, { state: "off" }] }), "1 on · 210W");
  assert.equal(syncPduSummary({ reachable: true, error: "Partial read", total_watts: 10, watts_complete: false, outlets: [{ state: "on" }] }), "1 on · 10W (partial) · Partial read");
  assert.equal(syncPduSummary(undefined), "? on · —");
  const pdus = [pdu, { ...pdu, id: "pdu2" }, { ...pdu, id: "pdu3" }];
  assert.deepEqual(syncPduUnavailable(pdus, { pdu1: { reachable: false, outlets: [] }, pdu2: { reachable: true, outlets: [{}] } }).map(p => p.id), ["pdu1"]);
  assert.deepEqual(syncKvmUnavailable([kvm, { ...kvm, id: "kvm2" }], { kvm1: { requestFailed: true, ports: [] } }).map(k => k.id), ["kvm1"]);
  assert.deepEqual(syncKvmUnavailable([kvm], { kvm1: live(["OPT11"]) }), []);
});

test("syncSaveWrites: every write carries the label shown when editing began", () => {
  // Rename only: the PDU outlet and the linked KVM port.
  assert.deepEqual(syncSaveWrites(row(), draft({ label: "OPT40" }), "KVM 01", "OPT14").map(w => [w.device_id, w.port, w.label, w.expected]),
    [["pdu1", "4", "OPT40", "OPT14"], ["kvm1", "4", "OPT40", "OPT14"]]);
  // Move to another KVM port: clear the old one, write the new one with the listed label as expected.
  assert.deepEqual(syncSaveWrites(row(), draft({ kvmPort: "2" }), "KVM 01", "OPT12").map(w => [w.device_id, w.port, w.label, w.expected, w.where]),
    [["kvm1", "4", "", "OPT14", "KVM 01 port 4"], ["kvm1", "2", "OPT14", "OPT12", "KVM 01 port 2"]]);
  // A port typed by hand has no shown label: the write is sent without expected.
  assert.equal(syncSaveWrites(row({ kvm: null }), draft({ kvmPort: "9" }), "KVM 01", undefined)[0].expected, undefined);
  // An empty outlet ("Outlet 3") expects its default name; a KVM port without a saved label expects the outlet's.
  const empty = row({ outlet_number: 3, label: "Outlet 3", assigned: false, kvm: null });
  assert.deepEqual(syncSaveWrites(empty, draft({ label: "OPT13", kvmDeviceId: "", kvmPort: "" }), "", undefined).map(w => [w.port, w.label, w.expected]),
    [["3", "OPT13", "Outlet 3"]]);
  assert.equal(syncSaveWrites(row({ kvm: { device_id: "kvm1", device_name: "KVM 01", port: "4" } }), draft({ label: "X" }), "KVM 01")[1].expected, "OPT14");
  // Nothing changed: nothing written. The KVM name falls back to the id.
  assert.deepEqual(syncSaveWrites(row(), draft(), "KVM 01", "OPT14"), []);
  assert.equal(syncSaveWrites(row({ kvm: null }), draft({ kvmDeviceId: "kvm9", kvmPort: "1" }), undefined, "")[0].where, "kvm9 port 1");
  assert.equal(syncKvmChanged(row(), draft({ kvmPort: 4 })), false, "a typed number matches the listed port");
});

test("runSyncWrites stops at the first failure and the message names what was saved", async () => {
  const calls = [];
  const failure = Object.assign(new Error("500: boom"), { status: 500, detail: "KVM write failed" });
  const setLabel = async (...args) => { calls.push(args); if (args[0] === "kvm1" && args[1] === "2") throw failure; };
  const writes = syncSaveWrites(row(), draft({ label: "OPT40", kvmPort: "2" }), "KVM 01", "Port 2");
  const { done, failed } = await runSyncWrites(writes, setLabel);
  assert.deepEqual(calls, [["pdu1", "4", "OPT40", "OPT14"], ["kvm1", "4", "", "OPT14"], ["kvm1", "2", "OPT40", "Port 2"]]);
  assert.equal(done.length, 2);
  assert.equal(syncSaveFailureText(done, failed),
    "PDU 01 outlet 4 was updated and KVM 01 port 4 was cleared, but KVM 01 port 2 could not be updated: KVM write failed.");
  assert.equal(syncSaveFailureText([], failed), "Save failed: KVM write failed");
  const conflict = Object.assign(new Error("409"), { status: 409, detail: "This port changed in another session. Reload and try again." });
  assert.equal(syncSaveFailureText([writes[0]], { ...writes[1], error: conflict }),
    "PDU 01 outlet 4 was updated, but KVM 01 port 4 could not be updated: This port changed in another session. Reload and try again.");
  assert.deepEqual(await runSyncWrites(writes.slice(0, 1), async () => {}), { done: writes.slice(0, 1), failed: null });
});
