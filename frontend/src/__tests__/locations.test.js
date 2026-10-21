import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../api/client.js";
import {
  serverIdentity, normalizeLocations, filterServers, portOptions, groupByDevice, buildMoveRequest, formatLocation,
  normalizeMoveResult, moveResultIsEmpty, moveErrorText, labelMoveHints, portKey,
  syncClearPlan, locationClearPlan, clearPorts, clearFailureText, clearAsResult, applyBody,
  feedSuffix, labelEditState, labelChanges, labelPatchBody, defaultPortLabel, parsePortInUse, takenPorts,
} from "../api/locations.js";

const realFetch = globalThis.fetch;
function stubFetch(t, reply) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const status = reply.status ?? 200;
    return new Response(JSON.stringify(reply.body ?? {}), { status });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

const sample = {
  servers: [
    { key: "optn44", name: "optn44", rack: "R2", slot: 10,
      pdu: [{ device_id: "pa", device_name: "PDU-A", port: "5", label: "optn44 (PSU1)" }, { device_id: "pb", device_name: "PDU-B", port: 5, label: "optn44 (PSU2)" }],
      kvm: [{ device_id: "k1", device_name: "KVM-1", port: "12", label: "optn44" }] },
    { key: "optn45", name: "OPTN45", rack: null, slot: null, pdu: [{ device_id: "pa", device_name: "PDU-A", port: "7", label: "OPTN45" }], kvm: [] },
  ],
  empty_ports: { pdu: [{ device_id: "pb", device_name: "PDU-B", port: 9 }, { device_id: "pa", device_name: "PDU-A", port: "10" }, { device_id: "pa", device_name: "PDU-A", port: "2" }], kvm: [{ device_id: "k1", device_name: "KVM-1", port: "3" }] },
  racks: ["R1", "R2"],
};

test("server identity matches the backend: OPT suffixes collapse, placeholders are not servers", () => {
  assert.equal(serverIdentity("OPTN45 (PSU2)"), "optn45");
  assert.equal(serverIdentity(" optn45 "), "optn45");
  assert.equal(serverIdentity("OPT7(a)"), "opt7");
  assert.equal(serverIdentity("Jetson Board"), "jetson board");
  assert.equal(serverIdentity("Outlet 3"), null);
  assert.equal(serverIdentity("port 12"), null);
  assert.equal(serverIdentity(""), null);
  assert.equal(serverIdentity(undefined), null);
});

test("locations normalize ports to strings, sort empty ports and survive partial responses", () => {
  const loc = normalizeLocations(sample);
  assert.equal(loc.servers.length, 2);
  assert.equal(loc.servers[0].pdu[1].port, "5");
  assert.equal(loc.servers[1].slot, null);
  assert.deepEqual(loc.empty_ports.pdu.map(portKey), ["pa:2", "pa:10", "pb:9"]);
  assert.deepEqual(loc.racks, ["R1", "R2"]);
  assert.deepEqual(normalizeLocations(null), { servers: [], empty_ports: { pdu: [], kvm: [] }, racks: [] });
  assert.deepEqual(normalizeLocations({ servers: [{ name: "OPTN9 (PSU1)" }] }).servers[0], { key: "optn9", name: "OPTN9 (PSU1)", rack: null, slot: null, pdu: [], kvm: [] });
});

test("search matches server, rack, slot and port device; rack filter supports unplaced", () => {
  const { servers } = normalizeLocations(sample);
  assert.deepEqual(filterServers(servers, "optn45").map(s => s.key), ["optn45"]);
  assert.deepEqual(filterServers(servers, "kvm-1").map(s => s.key), ["optn44"]);
  assert.deepEqual(filterServers(servers, "u10").map(s => s.key), ["optn44"]);
  assert.deepEqual(filterServers(servers, "pdu-a").map(s => s.key), ["optn44", "optn45"]);
  assert.deepEqual(filterServers(servers, "", "R2").map(s => s.key), ["optn44"]);
  assert.deepEqual(filterServers(servers, "", "unplaced").map(s => s.key), ["optn45"]);
  assert.equal(filterServers(servers, "nothing-like-this").length, 0);
});

test("port options offer the server's own ports (marked current) plus empty ones, grouped per device", () => {
  const loc = normalizeLocations(sample);
  const options = portOptions(loc, loc.servers[0], "pdu");
  assert.deepEqual(options.map(portKey), ["pa:2", "pa:5", "pa:10", "pb:5", "pb:9"]);
  assert.equal(options.find(o => portKey(o) === "pa:5").current, true);
  assert.equal(options.find(o => portKey(o) === "pa:2").current, undefined);
  assert.deepEqual(groupByDevice(options).map(g => [g.device_name, g.ports.length]), [["PDU-A", 3], ["PDU-B", 2]]);
});

test("move body: target server with swap on by default", () => {
  const server = normalizeLocations(sample).servers[1];
  assert.deepEqual(buildMoveRequest(server, { mode: "server", target: "optn44" }, true).body, {
    server: "optn45", target_server: "optn44", target_ports: null, target_rack: null, target_slot: null, swap: true, dry_run: true,
  });
  assert.equal(buildMoveRequest(server, { mode: "server", target: "optn44", swap: false }, false).body.swap, false);
  assert.equal(buildMoveRequest(server, { mode: "server", target: "optn44", swap: false }, false).body.dry_run, false);
  assert.match(buildMoveRequest(server, { mode: "server", target: "" }, true).error, /Choose the server/);
  assert.match(buildMoveRequest(server, { mode: "server", target: "optn45" }, true).error, /different server/);
  assert.match(buildMoveRequest(null, { mode: "server", target: "x" }, true).error, /Choose a server/);
});

test("move body: target ports with optional rack and slot, validated before any request", () => {
  const loc = normalizeLocations(sample);
  const server = loc.servers[0];
  const pdu = [loc.empty_ports.pdu[0]], kvm = [loc.empty_ports.kvm[0]];
  assert.deepEqual(buildMoveRequest(server, { mode: "ports", pdu, kvm, rack: "", slot: "" }, true).body, {
    server: "optn44", target_server: null, target_rack: null, target_slot: null, swap: true, dry_run: true,
    target_ports: [{ device_id: "pa", port: "2" }, { device_id: "k1", port: "3" }],
  });
  const placed = buildMoveRequest(server, { mode: "ports", pdu, kvm: [], rack: "R1", slot: "14", swap: false }, false).body;
  assert.equal(placed.target_rack, "R1");
  assert.equal(placed.target_slot, 14);
  assert.equal(placed.swap, false);
  // A slot alone keeps the server's current rack; an unplaced server must choose one.
  assert.equal(buildMoveRequest(server, { mode: "ports", pdu, slot: "3" }, true).body.target_rack, "R2");
  assert.match(buildMoveRequest(loc.servers[1], { mode: "ports", pdu, slot: "3" }, true).error, /rack/);
  assert.match(buildMoveRequest(server, { mode: "ports", pdu: [], kvm: [] }, true).error, /at least one/);
  assert.match(buildMoveRequest(server, { mode: "ports", pdu: [pdu[0], pdu[0]] }, true).error, /twice/);
  assert.match(buildMoveRequest(server, { mode: "ports", pdu, slot: "1.5" }, true).error, /whole number/);
  assert.match(buildMoveRequest(server, { mode: "ports", pdu, slot: "0" }, true).error, /whole number/);
});

test("move results list before -> after per port and per position, and flag unplaced servers", () => {
  const result = normalizeMoveResult({
    ok: true, dry_run: true,
    changes: [
      { device_id: "pa", device_name: "PDU-A", kind: "pdu", port: "5", before: "optn44 (PSU1)", after: "optn45 (PSU1)" },
      { device_id: "k1", device_name: "KVM-1", kind: "kvm", port: "12", before: "", after: "optn45" },
    ],
    positions: [{ server: "optn45", before: { rack: null, slot: null }, after: { rack: "R2", slot: 10 } }],
    unplaced: ["optn44"],
  });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.changes.map(c => [c.where, c.before, c.after]), [
    ["PDU-A outlet 5", "optn44 (PSU1)", "optn45 (PSU1)"],
    ["KVM-1 port 12", "(empty)", "optn45"],
  ]);
  assert.deepEqual(result.positions, [{ server: "optn45", before: "Unplaced", after: "R2 · U10" }]);
  assert.deepEqual(result.unplaced, ["optn44"]);
  assert.equal(moveResultIsEmpty(result), false);
  assert.equal(moveResultIsEmpty(normalizeMoveResult({ ok: true })), true);
  assert.equal(formatLocation({ rack: "R1", slot: null }), "R1");
});

test("move errors prefer the server's detail and explain common statuses", () => {
  assert.equal(moveErrorText({ status: 409, detail: "Port PDU-A 7 is used by optn45; choose it as target_server to swap" }), "Port PDU-A 7 is used by optn45; choose it as target_server to swap");
  assert.match(moveErrorText({ status: 403 }), /Operator/);
  assert.match(moveErrorText({ status: 404 }), /no longer exists/);
  assert.match(moveErrorText({ status: 500 }), /HTTP 500/);
  assert.match(moveErrorText(new TypeError("Failed to fetch")), /Check the connection/);
});

test("label editor hint: a new name already on other ports looks like a move; unchanged and new names do not", () => {
  const devices = [
    { id: "pa", kind: "pdu", name: "PDU-A", labels: { "5": "optn44 (PSU1)", "7": "OPTN45" } },
    { id: "pb", kind: "pdu", name: "PDU-B", labels: { "5": "optn44 (PSU2)" } },
    { id: "k1", kind: "kvm", name: "KVM-1", labels: { "12": "optn44" } },
    { id: "r1", kind: "rack", name: "Rack", labels: { "1": "optn45" } },
  ];
  const original = { 5: "optn44 (PSU1)", 6: "", 7: "OPTN45" };
  // optn44's PSU1 outlet relabelled optn45: optn45 already lives on outlet 7.
  let hints = labelMoveHints(devices[0], { ...original, 5: "optn45 (PSU1)" }, original, devices);
  assert.deepEqual(Object.keys(hints), ["5"]);
  assert.deepEqual(hints["5"], { name: "optn45 (PSU1)", where: ["PDU-A outlet 7"] });
  // A name on other PDUs (same kind only: its KVM port is not a conflict); rack items are not ports.
  hints = labelMoveHints(devices[0], { ...original, 6: "OPTN44" }, original, devices);
  assert.deepEqual(hints["6"].where, ["PDU-A outlet 5", "PDU-B outlet 5"]);
  // Unchanged labels, suffix-only edits, brand-new names and placeholders give no hint.
  assert.deepEqual(labelMoveHints(devices[0], original, original, devices), {});
  assert.deepEqual(labelMoveHints(devices[0], { ...original, 5: "OPTN44 (PSU-1)" }, original, devices), {});
  assert.deepEqual(labelMoveHints(devices[0], { ...original, 6: "optn99" }, original, devices), {});
  assert.deepEqual(labelMoveHints(devices[0], { ...original, 6: "Outlet 6" }, original, devices), {});
  // Optional device list (still loading) only checks this device's own ports.
  assert.deepEqual(labelMoveHints(devices[0], { ...original, 6: "optn45" }, original, undefined)["6"].where, ["PDU-A outlet 7"]);
});

test("API helpers call the locations endpoints with the exact body", async t => {
  const calls = stubFetch(t, { body: { servers: [], empty_ports: { pdu: [], kvm: [] }, racks: [] } });
  await api.getLocations();
  const body = { server: "optn45", target_server: "optn44", target_ports: null, target_rack: null, target_slot: null, swap: true, dry_run: true };
  await api.moveServer(body);
  assert.deepEqual(calls, [
    { url: "/api/devices/locations", method: "GET", body: undefined },
    { url: "/api/devices/move-server", method: "POST", body },
  ]);
});

test("a rejected move keeps the status and server detail for the dialog", async t => {
  stubFetch(t, { status: 409, body: { detail: "Port KVM-1 3 is used by optn46; choose it as target_server to swap" } });
  await assert.rejects(api.moveServer({ server: "optn45" }), e => e.status === 409 && /optn46/.test(e.detail));
});

test("sync map Clear names the outlet and its linked KVM port; an empty outlet has nothing to clear", () => {
  const row = { pdu_id: "p5", pdu_name: "PDU-05", outlet_number: 7, label: "optn45", kvm: { device_id: "k2", device_name: "KVM-2", port: "12" } };
  const plan = syncClearPlan(row);
  assert.equal(plan.message, "Clear optn45 from PDU-05 outlet 7 and KVM-2 port 12?");
  assert.deepEqual(plan.ports.map(p => [p.device_id, p.port]), [["p5", "7"], ["k2", "12"]]);
  assert.equal(syncClearPlan({ ...row, kvm: null }).message, "Clear optn45 from PDU-05 outlet 7?");
  assert.equal(syncClearPlan({ ...row, label: "" }), null);
  assert.equal(syncClearPlan({ ...row, label: "Outlet 7" }), null);
});

test("Clear location lists every port and keeps the rack position", () => {
  const server = normalizeLocations(sample).servers[0];
  const plan = locationClearPlan(server);
  assert.deepEqual(plan.ports.map(p => `${p.kind}:${p.device_id}:${p.port}`), ["pdu:pa:5", "pdu:pb:5", "kvm:k1:12"]);
  assert.equal(plan.message, "Clear optn44 from all 3 ports?\n\n• PDU-A outlet 5 (optn44 (PSU1))\n• PDU-B outlet 5 (optn44 (PSU2))\n• KVM-1 port 12\n\nIts rack position (R2 · U10) is kept.");
  assert.match(locationClearPlan(normalizeLocations(sample).servers[1]).message, /It has no rack position\.$/);
  // A server listed only from its rack slot or monitor has no ports: nothing to clear.
  assert.equal(locationClearPlan({ name: "x", pdu: [], kvm: [] }), null);
});

test("clearPorts sends an empty label per port, continues after a failure and reports it", async () => {
  const server = normalizeLocations(sample).servers[0];
  const calls = [];
  const setLabel = async (id, port, label) => {
    calls.push([id, port, label]);
    if (id === "pb") throw Object.assign(new Error("409"), { status: 409, detail: "Labels changed" });
  };
  const { cleared, failed } = await clearPorts(locationClearPlan(server).ports, setLabel);
  assert.deepEqual(calls, [["pa", "5", ""], ["pb", "5", ""], ["k1", "12", ""]]);
  assert.deepEqual(cleared.map(p => p.device_id), ["pa", "k1"]);
  assert.equal(clearFailureText(failed), "PDU-B outlet 5: Labels changed");
  const result = clearAsResult(cleared);
  // The server stores the default name for a cleared numbered port, so that is what the list shows.
  assert.deepEqual(result.changes.map(c => [c.where, c.before, c.after]), [["PDU-A outlet 5", "optn44 (PSU1)", "Outlet 5"], ["KVM-1 port 12", "optn44", "Port 12"]]);
});

test("Apply sends the preview's plan token; a result without one sends none", () => {
  const preview = { ...normalizeMoveResult({ dry_run: true, plan_revision: '"abc"', changes: [] }), body: { server: "optn45", target_server: "optn44", dry_run: true } };
  assert.equal(preview.planRevision, '"abc"');
  assert.deepEqual(applyBody(preview), { server: "optn45", target_server: "optn44", dry_run: false, plan_revision: '"abc"' });
  const old = { ...normalizeMoveResult({ dry_run: true }), body: { server: "optn45", dry_run: true } };
  assert.equal(old.planRevision, null);
  assert.deepEqual(applyBody(old), { server: "optn45", dry_run: false });
});

test("Clear sends the label each port showed, the KVM port's own label included", async () => {
  const row = { pdu_id: "p5", pdu_name: "PDU-05", outlet_number: 7, label: "optn45 (PSU1)",
                kvm: { device_id: "k2", device_name: "KVM-2", port: "12", label: "OPTN45" } };
  const calls = [];
  await clearPorts(syncClearPlan(row).ports, async (...args) => { calls.push(args); });
  assert.deepEqual(calls, [["p5", "7", "", "optn45 (PSU1)"], ["k2", "12", "", "OPTN45"]]);
  const old = syncClearPlan({ ...row, kvm: { device_id: "k2", device_name: "KVM-2", port: "12" } });
  assert.equal(old.ports[1].label, "optn45 (PSU1)");
});

test("setDirectLabel adds expected only when given", async t => {
  const calls = stubFetch(t, { body: { ok: true } });
  await api.setDirectLabel("p5", 7, "", "optn45");
  await api.setDirectLabel("p5", 7, "x");
  assert.deepEqual(calls.map(c => c.body), [
    { device_id: "p5", port: "7", label: "", expected: "optn45" },
    { device_id: "p5", port: "7", label: "x" },
  ]);
});

test("move hint skips another feed of the same server and its first KVM port, but not a same-feed or same-kind move", () => {
  const devices = [
    { id: "pa", kind: "pdu", name: "PDU-A", labels: { "5": "OPT44 (PSU1)" } },
    { id: "pb", kind: "pdu", name: "PDU-B", labels: { "5": "" } },
    { id: "k1", kind: "kvm", name: "KVM-1", labels: { "2": "OPT44" } },
    { id: "k2", kind: "kvm", name: "KVM-2", labels: {} },
  ];
  assert.equal(feedSuffix("OPT44 ( PSU2 )"), "(psu2)");
  assert.equal(feedSuffix("OPT44"), "");
  assert.equal(feedSuffix("web-1 (a)"), "");
  const pb = devices[1];
  assert.deepEqual(labelMoveHints(pb, { 5: "OPT44 (PSU2)" }, { 5: "" }, devices), {});
  assert.deepEqual(labelMoveHints(pb, { 5: "opt44 (psu1)" }, { 5: "" }, devices)["5"].where, ["PDU-A outlet 5"]);
  assert.deepEqual(labelMoveHints(pb, { 5: "OPT44" }, { 5: "" }, devices)["5"].where, ["PDU-A outlet 5"]);
  // KVM: the server has no other KVM port -> linking it is not a move; another KVM port with it is.
  assert.deepEqual(labelMoveHints(devices[3], { 1: "OPT44" }, { 1: "" }, devices.slice(0, 2)), {});
  assert.deepEqual(labelMoveHints(devices[3], { 1: "OPT44" }, { 1: "" }, devices)["1"].where, ["KVM-1 port 2"]);
  // Two feeds typed on the same PDU at once are not a move either.
  assert.deepEqual(labelMoveHints(pb, { 5: "OPT9 (PSU1)", 6: "OPT9 (PSU2)" }, { 5: "", 6: "" }, devices), {});
});

test("label editor draft keeps every saved label even before the port list loads", () => {
  const saved = { "1": "optn41", "2": "optn42 (PSU1)", "A1": "legacy" };
  // Status not loaded: the form still holds the saved labels, and an untouched save sends them all back.
  let { draft, original, base } = labelEditState(saved, []);
  assert.deepEqual(draft, saved);
  assert.deepEqual(labelChanges(draft, original), []);
  assert.deepEqual(labelPatchBody(base, draft, original), saved);
  // Loaded: live-only ports join the form; untouched live names ("Outlet 3", a hardware name) are never saved.
  ({ draft, original, base } = labelEditState(saved, [{ number: 1, label: "live-1" }, { number: 3, label: "Outlet 3" }, { number: 4, label: "hw-name" }]));
  assert.equal(draft["1"], "optn41");
  assert.equal(draft["3"], "Outlet 3");
  assert.deepEqual(labelPatchBody(base, draft, original), saved);
  // Edits: a new name, a cleared label ("" -> server stores the default) and a whitespace-only change.
  const edited = { ...draft, "3": " optn43 ", "1": "", "2": "optn42 (PSU1)  " };
  assert.deepEqual(labelChanges(edited, original).sort(), ["1", "3"]);
  assert.deepEqual(labelPatchBody(base, edited, original), { "1": "", "2": "optn42 (PSU1)", "3": "optn43", "A1": "legacy" });
  // The map a stale empty draft would have sent is impossible: nothing saved is dropped.
  assert.deepEqual(labelPatchBody(base, {}, {}), saved);
  assert.deepEqual(labelEditState(undefined, undefined), { draft: {}, original: {}, base: {} });
});

test("cleared ports show the default name the server stores", () => {
  assert.equal(defaultPortLabel("pdu", "4"), "Outlet 4");
  assert.equal(defaultPortLabel("kvm", 12), "Port 12");
  assert.equal(defaultPortLabel("pdu", "A1"), "");
});

test("taken ports are marked from the 409 detail and from the refreshed list", () => {
  assert.deepEqual(parsePortInUse("Port 7 on PDU-A is used by optn46; choose it as target_server to swap"), { port: "7", device_name: "PDU-A", owner: "optn46" });
  assert.deepEqual(parsePortInUse("Port 3 on PDU 01 is used by web.1 (a). Choose web.1 (a) as the target to swap."), { port: "3", device_name: "PDU 01", owner: "web.1 (a)" });
  assert.equal(parsePortInUse("U3 in Rack-01 is used by X. Allow the swap to exchange positions with X, or choose another slot."), null);
  assert.equal(parsePortInUse("U10 in R2 is used by optn45; choose another slot"), null);
  assert.equal(parsePortInUse(undefined), null);
  const loc = normalizeLocations(sample);
  const server = loc.servers[1];   // OPTN45, owns pa:7
  const chosen = [{ device_id: "pa", device_name: "PDU-A", port: "7" }, { device_id: "pa", device_name: "PDU-A", port: "2" }, { device_id: "pa", device_name: "PDU-A", port: "5" }];
  // pa:5 belongs to optn44 in the fresh list; pa:2 is free; pa:7 is the mover's own.
  assert.deepEqual(takenPorts(chosen, loc, server, "pdu"), { "pa:5": "optn44" });
  // The 409 names a port the list still shows as free (stale list): it is marked too, "07" matching "7".
  assert.deepEqual(takenPorts(chosen, loc, server, "pdu", { port: "02", device_name: "PDU-A", owner: "optn99" }), { "pa:2": "optn99", "pa:5": "optn44" });
  assert.deepEqual(takenPorts([], loc, server, "kvm"), {});
});
