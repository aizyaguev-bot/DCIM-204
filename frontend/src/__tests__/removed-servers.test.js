import test from "node:test";
import assert from "node:assert/strict";
import {
  describeRemoval, hiddenSet, isRemovedServer, removeServer, restoreServer, withoutRemoved, withoutRemovedMonitoring,
  withoutRemovedTargets,
} from "../api/removedServers.js";
import { attentionItems, buildServers } from "../labDisplay.js";

const hidden = hiddenSet({ hidden: ["optn45", "web-1"] });

test("hiddenSet reads the hidden keys and fails open on anything malformed", () => {
  assert.deepEqual([...hidden], ["optn45", "web-1"]);
  assert.equal(hiddenSet(null).size, 0);
  assert.equal(hiddenSet({ hidden: "optn45" }).size, 0);
  assert.deepEqual([...hiddenSet({ hidden: ["OPTN7", 3, "", null] })], ["optn7"]);
  assert.deepEqual([...hiddenSet({ hidden: ["optn7"], hidden_names: "x" })], ["optn7"]);
});

test("hidden_names match a name the backend casefolds and the page only lower-cases", () => {
  // Backend key "strasse" (casefold of "Straße"); serverIdentity("Straße") is "straße".
  const set = hiddenSet({ hidden: ["strasse"], hidden_names: ["straße"] });
  for (const name of ["Straße", "STRAßE", "straße"]) assert.equal(isRemovedServer(name, set), true, name);
  for (const name of ["Strassen", "straß", "OPTN45"]) assert.equal(isRemovedServer(name, set), false, name);
  assert.equal(isRemovedServer("Straße", hiddenSet({ hidden: ["strasse"] })), false);   // fails open without them
});

test("a removed server is matched by its exact identity, every feed included, never by prefix", () => {
  for (const name of ["OPTN45", "optn45", "OPTN45 (PSU1)", " Optn45 (psu2) ", "web-1", "WEB-1"]) assert.equal(isRemovedServer(name, hidden), true, name);
  for (const name of ["OPTN4", "OPTN450", "OPTN46", "OPTN45-B", "web-10", "Outlet 45", "", null]) assert.equal(isRemovedServer(name, hidden), false, String(name));
  assert.equal(isRemovedServer("OPTN45", new Set()), false);
  assert.equal(isRemovedServer("OPTN45", undefined), false);
});

test("withoutRemoved filters lists and returns the same array when nothing is hidden", () => {
  const servers = [{ name: "OPTN44" }, { name: "OPTN45 (PSU1)" }, { name: "optn450" }, { name: "web-1" }];
  assert.deepEqual(withoutRemoved(servers, hidden).map(s => s.name), ["OPTN44", "optn450"]);
  assert.equal(withoutRemoved(servers, new Set()), servers);
  assert.equal(withoutRemoved([{ name: "OPTN44" }], hidden).length, 1);
  const same = [{ name: "OPTN44" }];
  assert.equal(withoutRemoved(same, hidden), same);
  assert.deepEqual(withoutRemoved(null, hidden), []);
  assert.deepEqual(withoutRemoved([{ key: "optn45" }, { key: "optn44" }], hidden, s => s.key), [{ key: "optn44" }]);
});

test("the lab display's server list without removed servers (the Racks page uses the same rule)", () => {
  const pdus = [{ id: "p1", name: "PDU-1", rack: "Rack-01", labels: { 1: "OPTN44", 2: "OPTN45 (PSU1)", 3: "Outlet 3" } },
    { id: "p2", name: "PDU-2", rack: "Rack-02", labels: { 1: "OPTN45 (PSU2)", 2: "OPTN46" } }];
  assert.deepEqual(withoutRemoved(buildServers(pdus, {}, {}), hidden).map(s => s.name), ["OPTN44", "OPTN46"]);
});

test("monitor targets are filtered by their server_key, else by their inventory name", () => {
  const targets = [
    { id: "a", name: "Renamed in monitor", server_key: "optn45", inventory_name: "OPTN45" },
    { id: "b", name: "OPTN44", server_key: "optn44" },
    { id: "c", name: "web-1", inventory_name: "web-1" },
    { id: "d", name: "manual host", server_key: null, inventory_name: "manual host" },
  ];
  assert.deepEqual(withoutRemovedTargets(targets, hidden).map(t => t.id), ["b", "d"]);
  const monitoring = { service: "running", targets };
  const filtered = withoutRemovedMonitoring(monitoring, hidden);
  assert.equal(filtered.service, "running");
  assert.deepEqual(filtered.targets.map(t => t.id), ["b", "d"]);
  assert.equal(withoutRemovedMonitoring(monitoring, new Set()), monitoring);
  assert.equal(withoutRemovedMonitoring(null, hidden), null);
});

test("describeRemoval lists what is cleaned and what stays", () => {
  const plan = {
    name: "OPTN45",
    layout: [
      { file: "rack_overrides.json", rack: "Rack-01", id: "optn45 (psu1)" },
      { file: "rack_positions.json", rack: "Rack-01", id: "optn45 (psu1)" },
      { file: "rack_slots.json", rack: "Rack-01", id: "optn45 (psu1)", slot: 2 },
      { file: "switch_assignments.json", rack: null, id: "optn45 (psu1)" },
    ],
    owner: { keys: ["optn45"], name: "Roy" },
    monitor: { id: "t45", name: "OPTN45", host: "optn45", enabled: true },
    pins: [{ rack: "Rack-01", id: "optn4", slot: 3 }],
    ports: [{ device_id: "pdu-a", device_name: "PDU-A", kind: "pdu", port: "2" }, { device_id: "kvm-a", device_name: "KVM-A", kind: "kvm", port: "2" }],
    units_kept: [{ id: "u1", name: "Switch under test" }],
  };
  assert.deepEqual(describeRemoval(plan), {
    cleaned: ["Its rack assignment (Rack-01)", "Its rack shelf (U) position (Rack-01 U2)", "Its rack order entry (Rack-01)",
      "Its switch port", "Its owner (Roy)", "Its ping monitor is paused (optn45); its history is kept"],
    kept: ["1 other server keeps its shelf position", "The PDU/KVM labels stay as they are: PDU-A outlet 2, KVM-A port 2",
      "Equipment on its shelf stays in the rack: Switch under test"],
  });
  assert.deepEqual(describeRemoval(null), { cleaned: [], kept: [] });
  assert.deepEqual(describeRemoval({ monitor: { enabled: false } }).cleaned, ["Its ping monitor stays paused; its history is kept"]);
});

test("remove and restore send the ETag the page holds as If-Match (no fresh read); the key goes in the body", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "GET") return new Response(JSON.stringify({ servers: [], hidden: [] }), { status: 200, headers: { ETag: '"rev-1"' } });
    if (url.endsWith("/restore")) return new Response(JSON.stringify({ detail: "This server is not in the removed list any more. Reload the list." }), { status: 404 });
    return new Response(JSON.stringify({ ok: true, removed: { key: "optn45", name: "OPTN45" } }), { status: 200 });
  };
  try {
    const result = await removeServer("OPTN45 (PSU1)", { reason: "gone", planRevision: "plan-1", etag: '"shown-1"' });
    assert.equal(result.removed.key, "optn45");
    assert.deepEqual(calls[0], { url: "/api/removed-servers", method: "POST", headers: { "Content-Type": "application/json", "If-Match": '"shown-1"' },
      body: { name: "OPTN45 (PSU1)", reason: "gone", plan_revision: "plan-1" } });
    await assert.rejects(restoreServer("optn44/45", '"shown-2"'), e => e.status === 404 && /not in the removed list/.test(e.message));
    assert.deepEqual(calls[1], { url: "/api/removed-servers/restore", method: "POST", headers: { "Content-Type": "application/json", "If-Match": '"shown-2"' },
      body: { key: "optn44/45" } });
    await removeServer("OPTN45", {});   // no ETag held: no If-Match (the server answers 428), never a fresh read
    assert.equal(calls.length, 3);
    assert.equal(calls[2].headers["If-Match"], undefined);
    assert.ok(!calls.some(c => c.method === "GET"));
  } finally {
    globalThis.fetch = original;
  }
});

test("the lab display does not count removed servers behind an unreachable PDU", () => {
  const devices = [{ id: "p1", kind: "pdu", name: "PDU-1", rack: "Rack-01", labels: { 1: "OPTN44", 2: "OPTN45 (PSU1)" } }];
  const pduStatuses = { p1: { reachable: false, error: "timeout" } };
  const detail = removedHidden => attentionItems({ devices, pduStatuses, removedHidden }).find(i => i.key === "pdu:p1")?.detail || "";
  assert.match(detail(null), /No reading from 2 servers/);
  assert.match(detail(hidden), /No reading from 1 server$/);
});
