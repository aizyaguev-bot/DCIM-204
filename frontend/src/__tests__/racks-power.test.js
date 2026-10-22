import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BLOCK, serverPowerGroup, planServerPower, sameTargets, powerErrorText, actionBlock } from "../components/racks/serverPower.js";

const pdu = (id, rack, labels = {}, extra = {}) => ({ id, kind: "pdu", name: `PDU ${id.slice(3)}`, rack, labels, ...extra });
const status = (outlets, reachable = true) => ({ reachable, outlets: outlets.map(([number, label, state]) => ({ number, label, state, watts: 10 })) });

function world() {
  const devices = [
    pdu("pdu1", "Rack-01", { 1: "OPT11", 2: "OPT12" }),
    pdu("pdu2", "Rack-02", { 3: "OPT99 (PSU2)" }),
    pdu("pdu4", "Rack-04"),
    { id: "kvm1", kind: "kvm", name: "KVM", labels: { 1: "OPT11" } },
  ];
  const pduStatuses = {
    pdu1: status([[1, "OPT11", "on"], [2, "OPT12", "on"], [3, "OPT99 (PSU1)", "on"], [4, "OPT14", "on"]]),
    pdu2: status([[3, "OPT99 (PSU2)", "off"], [4, "empty", "on"]]),
    pdu4: status([[1, "OPT41", "off"]]),
  };
  return { devices, pduStatuses, maintenance: null };
}

test("PSU1 and PSU2 are one server; one label on two PDUs gives two feeds", () => {
  const g = serverPowerGroup("OPT99 (PSU1)", world());
  assert.equal(g.key, "opt99");
  assert.deepEqual(g.feeds.map(f => [f.id, f.label, f.state]), [["pdu1:3", "OPT99 (PSU1)", "on"], ["pdu2:3", "OPT99 (PSU2)", "off"]]);
  assert.equal(g.state, "partial");
  const w = world();
  w.devices[2].labels = { 2: "OPT12" };
  w.pduStatuses.pdu4 = status([[2, "OPT12", "off"]]);
  assert.deepEqual(serverPowerGroup("OPT12", w).feeds.map(f => f.id), ["pdu1:2", "pdu4:2"]);
});

test("a saved label is a feed unless the reachable PDU reports that outlet; non-server labels are not feeds", () => {
  const w = world();
  w.devices[0].labels = { 1: "OLD-NAME" };   // the live outlet 1 says OPT11: the old saved label is ignored
  assert.equal(serverPowerGroup("OLD-NAME", w), null);
  assert.equal(serverPowerGroup("empty", w), null);
  assert.equal(serverPowerGroup("Outlet 4", w), null);
  w.pduStatuses.pdu2 = { reachable: false, outlets: [] };
  const g = serverPowerGroup("OPT99", w);
  assert.deepEqual(g.feeds.map(f => [f.id, f.state]), [["pdu1:3", "on"], ["pdu2:3", "unknown"]]);
  assert.equal(g.feeds[1].blocked.on, BLOCK.offline);
});

test("every block reason", () => {
  const w = world();
  w.devices[0].enabled = false;
  assert.equal(serverPowerGroup("OPT11", w).feeds[0].blocked.off, BLOCK.disabled);
  const w2 = world();
  delete w2.pduStatuses.pdu1;
  w2.devices[0].labels = { 1: "OPT11" };
  assert.equal(serverPowerGroup("OPT11", w2).feeds[0].blocked.on, BLOCK.noStatus);
  w2.pduStatuses.pdu1 = { requestFailed: true, outlets: [] };
  assert.equal(serverPowerGroup("OPT11", w2).feeds[0].blocked.on, BLOCK.noStatus);
  w2.pduStatuses.pdu1 = { reachable: false, outlets: [] };
  assert.equal(serverPowerGroup("OPT11", w2).feeds[0].blocked.cycle, BLOCK.offline);
  const w3 = world();
  w3.pduStatuses.pdu1.outlets[0].state = "unknown";
  assert.deepEqual(serverPowerGroup("OPT11", w3).feeds[0].blocked, { on: BLOCK.unknown, off: BLOCK.unknown, cycle: BLOCK.unknown });
  // maintenance: On and Cycle blocked, Off allowed
  const w4 = world();
  w4.maintenance = { pdus: { pdu1: { since: "now" } } };
  const m = serverPowerGroup("OPT11", w4).feeds[0];
  assert.equal(m.inMaintenance, true);
  assert.deepEqual(m.blocked, { on: BLOCK.maintenance, off: null, cycle: BLOCK.maintenance });
  // protected: Off and Cycle blocked, On allowed; an invalid setting blocks Off everywhere
  const w5 = world();
  w5.maintenance = { pdus: {}, protection: "ok", protected: { pdu1: [4] } };
  assert.deepEqual(serverPowerGroup("OPT14", w5).feeds[0].blocked, { on: null, off: BLOCK.protected, cycle: BLOCK.protected });
  assert.equal(serverPowerGroup("OPT11", w5).feeds[0].blocked.off, null);
  w5.maintenance.protection = "invalid";
  assert.equal(serverPowerGroup("OPT11", w5).feeds[0].blocked.off, BLOCK.protectionInvalid);
  assert.equal(serverPowerGroup("OPT11", w5).feeds[0].blocked.on, null);
});

test("plans: skipped feeds, no partial execution, cycle on one feed", () => {
  const w = world();
  const g = serverPowerGroup("OPT99", w);
  const off = planServerPower(g, "off", "server");
  assert.deepEqual(off.targets.map(f => f.id), ["pdu1:3"]);
  assert.deepEqual(off.skipped.map(s => [s.feed.id, s.reason]), [["pdu2:3", "already off"]]);
  assert.equal(off.disabledReason, null);
  assert.deepEqual(planServerPower(g, "off", "feed", "pdu2:3").disabledReason, "OPT99 (PSU2) is already off");
  assert.equal(planServerPower(g, "cycle", "server").disabledReason, "Cycle works on one feed");
  assert.deepEqual(planServerPower(g, "cycle", "feed", "pdu1:3").targets.map(f => f.id), ["pdu1:3"]);
  // a blocked target refuses the whole server request
  w.maintenance = { pdus: { pdu2: {} } };
  const blocked = planServerPower(serverPowerGroup("OPT99", w), "on", "server");
  assert.equal(blocked.disabledReason, `PDU 2 outlet 3: ${BLOCK.maintenance}`);
  assert.equal(actionBlock(serverPowerGroup("OPT11", world()), "on"), "OPT11 is already on");
  assert.equal(planServerPower(null, "on").disabledReason, "This server has no PDU outlet");
});

test("sameTargets notices a changed mapping", () => {
  const g = serverPowerGroup("OPT99", world());
  const a = planServerPower(g, "off", "server");
  assert.equal(sameTargets(a, planServerPower(serverPowerGroup("OPT99", world()), "off", "server")), true);
  const w = world();
  w.pduStatuses.pdu2.outlets[0].state = "on";
  assert.equal(sameTargets(a, planServerPower(serverPowerGroup("OPT99", w), "off", "server")), false);
});

test("powerErrorText", () => {
  assert.equal(powerErrorText({ status: 401, message: "401: x" }), "Your session ended. Sign in again and retry.");
  for (const status of [403, 409, 502]) assert.equal(powerErrorText({ status, detail: "Because", message: "x" }), "Because");
  assert.equal(powerErrorText(new TypeError("Failed to fetch")), "Lab Manager did not answer. Check the connection and try again.");
  assert.equal(powerErrorText(new Error("Viewer account: read only")), "Viewer account: read only");
});

test("the non-server label rule is the same text as DcimView's", () => {
  const dcim = readFileSync(new URL("../pages/DcimView.jsx", import.meta.url), "utf8");
  const power = readFileSync(new URL("../components/racks/serverPower.js", import.meta.url), "utf8");
  const rule = src => /const NON_SERVER_LABEL = (\/.*\/i);/.exec(src)[1];
  assert.equal(rule(power), rule(dcim));
  assert.match(dcim, /\/\^\(outlet\\s\*\\d\+\|port\\s\*\\d\+\|\\s\*\)\$\/i/);
  assert.match(power, /\/\^\(outlet\\s\*\\d\+\|port\\s\*\\d\+\|\\s\*\)\$\/i/);
});
