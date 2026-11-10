// node --test src/__tests__/gap-data.test.js
// Regression tests for data behaviour the other suites leave untested: API client edge cases, inventory
// labels and saves, Locations helpers, layout stores, changelog parsing and power readings.
// Every request goes to a fake fetch; nothing here reaches a device, the VM or the site.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api, deviceState, errorMessage, STATE_TEXT, STATE_DOT } from "../api/client.js";
import {
  loadInventory, updateInventory, loadRackItems, saveRackItems, parseLocationCode, locationCode, rackCode, labelCode,
  MAIN_STORAGE, mainStorageCode,
} from "../api/inventory.js";
import {
  normalizeLocations, formatLocation, buildMoveRequest, describeChange, normalizeMoveResult, moveErrorText,
  clearPorts, clearFailureText, labelEditState, takenPorts,
} from "../api/locations.js";
import { loadLayout, saveLayout } from "../api/layout.js";
import { splitSections, sectionHeading, releaseNotesSince, versionOf } from "../api/changelog.js";
import { sumKnown, reading } from "../power.js";

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;

// Each queued reply answers the next request in order; every request is recorded.
function serve(t, replies) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body, cache: init.cache });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
    const body = reply.status === 204 ? null : reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(body, { status: reply.status ?? 200, headers: reply.etag ? { ETag: reply.etag } : {} });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

// saveRackItems reports through window.alert (older equipment dialogs do not render errors themselves).
function alerts(t) {
  const shown = [];
  globalThis.window = { alert: message => shown.push(message) };
  t.after(() => { globalThis.window = realWindow; });
  return shown;
}

const rejection = promise => promise.then(() => null, error => error);

// Strict expected failure (like pytest xfail(strict=True) / vitest it.fails): passes while the bug is present and
// fails as soon as it is fixed, so the marker has to be removed then.
function xfail(name, reason, fn) {
  test(`${name} [xfail: ${reason}]`, async t => {
    await assert.rejects(async () => fn(t), assert.AssertionError, `XPASS (bug fixed?): ${reason}. Remove the xfail marker.`);
  });
}

// ---- api/client.js ----

test("client: a 204 reply resolves to null without reading a body; a create sends its JSON body", async t => {
  const calls = serve(t, [{ status: 204 }, { status: 201, body: { id: "d1", name: "PDU-01" } }]);
  assert.equal(await api.deleteDevice("d1"), null);
  assert.deepEqual(await api.createDevice({ name: "PDU-01", kind: "pdu" }), { id: "d1", name: "PDU-01" });
  assert.deepEqual(calls[0], { url: "/api/devices/d1", method: "DELETE", headers: {}, body: undefined, cache: undefined });
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(calls[1].headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[1].body), { name: "PDU-01", kind: "pdu" });
});

test("client: maintenance calls escape the PDU id and send only the fields each action takes", async t => {
  const calls = serve(t, [{ body: {} }, { body: {} }, { body: {} }, { body: {} }, { body: {} }]);
  await api.maintenanceShutdown("pdu 1/a?b", "s3cret", "Rewiring rack 2");
  await api.maintenanceRestore("pdu 1/a?b", "s3cret");
  await api.outletPower("pdu1", 7, "cycle");
  await api.renameOpt("OPT1", "OPT2");
  await api.getViewerUrl("kvm1", 12);
  assert.deepEqual(calls.map(c => [c.method, c.url, c.body === undefined ? undefined : JSON.parse(c.body)]), [
    ["POST", "/api/pdus/pdu%201%2Fa%3Fb/maintenance/shutdown", { password: "s3cret", reason: "Rewiring rack 2" }],
    ["POST", "/api/pdus/pdu%201%2Fa%3Fb/maintenance/restore", { password: "s3cret" }],
    ["POST", "/api/pdus/pdu1/outlets/7/power", { action: "cycle" }],
    ["POST", "/api/devices/rename-opt", { old_name: "OPT1", new_name: "OPT2" }],
    ["GET", "/api/kvms/kvm1/ports/12/viewer", undefined],
  ]);
  assert.ok(calls.every(c => !c.url.includes("s3cret")), "the maintenance password never travels in the URL");
});

test("client: error details without readable text fall back to the status line; empty messages are dropped", async t => {
  serve(t, [
    { status: 422, body: { detail: [{ loc: ["body", "name"], type: "missing" }] } },
    { status: 422, body: { detail: [null, { msg: "Port keys must be numbers" }, { msg: "" }] } },
    { status: 500, body: { detail: { code: "E1" } } },
    { status: 404, body: { detail: "" } },
  ]);
  let e = await rejection(api.getDevices());
  assert.equal(e.detail, undefined);
  assert.match(errorMessage(e), /^422: /);
  e = await rejection(api.getDevices());
  assert.equal(errorMessage(e), "Port keys must be numbers");
  e = await rejection(api.getDevices());
  assert.equal(e.status, 500);
  assert.equal(e.detail, undefined);
  assert.equal(errorMessage(e), '500: {"detail":{"code":"E1"}}');
  e = await rejection(api.getDevices());
  assert.equal(errorMessage(e), '404: {"detail":""}');
});

test("client: every device state has a label and a StatusDot colour; a failed request outranks stale reachability", () => {
  const statuses = [undefined, null, {}, { requestFailed: true, reachable: true }, { reachable: false, error: "timeout" },
    { reachable: true, error: "auth" }, { reachable: true, error: "" }, { reachable: true }];
  assert.deepEqual(statuses.map(deviceState), ["unknown", "unknown", "unknown", "unavailable", "offline", "error", "online", "online"]);
  const dot = readFileSync(new URL("../components/StatusDot.jsx", import.meta.url), "utf8");
  const colours = new Set([.../const map = \{([^}]*)\}/.exec(dot)[1].matchAll(/(\w+):\s*"/g)].map(m => m[1]));
  for (const state of ["online", "offline", "error", "unavailable", "unknown"]) {
    assert.equal(typeof STATE_TEXT[state], "string", `${state} has text`);
    assert.ok(colours.has(STATE_DOT[state]), `${state} -> ${STATE_DOT[state]} is a StatusDot colour`);
  }
  // A failed status request is grey, never the red of an offline alert.
  assert.notEqual(STATE_DOT.unavailable, STATE_DOT.offline);
});

// ---- api/inventory.js: labels ----

test("inventory: lower-case label prefixes and zero-padded shelves scan like the printed form", () => {
  assert.deepEqual(parseLocationCode("loc:Rack-01:7:Left"), { rack: "Rack-01", u: 7, position: "Left" });
  assert.deepEqual(parseLocationCode("rack:Rack-07"), { rack: "Rack-07", u: 0, position: "" });
  assert.deepEqual(parseLocationCode("store:main"), { rack: MAIN_STORAGE, u: 0, position: "" });
  assert.deepEqual(parseLocationCode("LOC:Rack-01:07:"), { rack: "Rack-01", u: 7, position: "" });
});

test("inventory: labels accept the backend's longest rack (120) and position (80), refuse one more, and say why", () => {
  const rack120 = "R".repeat(120), position80 = "P".repeat(80);
  assert.deepEqual(parseLocationCode(locationCode(rack120, 42, position80)), { rack: rack120, u: 42, position: position80 });
  assert.deepEqual(parseLocationCode(rackCode(rack120)), { rack: rack120, u: 0, position: "" });
  assert.throws(() => parseLocationCode(locationCode(`${rack120}R`, 1, "")), /Invalid shelf label/);
  assert.throws(() => parseLocationCode(locationCode("Rack-01", 1, `${position80}P`)), /Invalid shelf label/);
  assert.throws(() => parseLocationCode(rackCode(`${rack120}R`)), /Invalid rack label/);
  assert.throws(() => parseLocationCode("LOC:%20%20:3:"), /Invalid shelf label/);
  assert.throws(() => parseLocationCode("RACK:%20%20"), /Invalid rack label/);
  assert.throws(() => parseLocationCode("LOC:Rack-01:3"), /incomplete/);
  assert.throws(() => parseLocationCode("store:other"), /Unknown storage label/);
});

test("inventory: a whole-rack label drops any shelf position and separators in names are escaped", () => {
  assert.equal(labelCode({ rack: "Rack 1/2", u: 0, position: "front" }), "RACK:Rack%201%2F2");
  assert.equal(labelCode({ rack: MAIN_STORAGE, u: 5, position: "x" }), mainStorageCode);
  assert.equal(locationCode("100%:A", 3), "LOC:100%25%3AA:3:");
  assert.deepEqual(parseLocationCode("LOC:100%25%3AA:3:"), { rack: "100%:A", u: 3, position: "" });
});

// ---- api/inventory.js: requests ----

test("inventory: a lookup escapes the scanned code, bypasses the cache and returns the ETag as the revision", async t => {
  const calls = serve(t, [{ body: { items: [], matches: [] }, etag: '"i1"' }, { body: { items: [] }, etag: '"i2"' }, { body: {}, etag: '"i3"' }]);
  assert.deepEqual(await loadInventory("A&B #1?"), { data: { items: [], matches: [] }, revision: '"i1"' });
  await loadInventory();
  await loadInventory(null);
  assert.deepEqual(calls.map(c => [c.url, c.cache]), [
    ["/api/inventory?code=A%26B%20%231%3F", "no-store"], ["/api/inventory", "no-store"], ["/api/inventory", "no-store"],
  ]);
});

test("inventory: a save without a loaded revision is refused before any request; with one it sends If-Match", async t => {
  const calls = serve(t, [{ status: 201, body: { id: "ci-1", name: "Switch" }, etag: '"i2"' }]);
  await assert.rejects(updateInventory("", { code: "X" }, null), /Load the inventory before saving/);
  await assert.rejects(updateInventory("", { code: "X" }, ""), /Load the inventory before saving/);
  assert.equal(calls.length, 0);
  const destination = { rack: "Rack-01", u: 3, position: "" };
  assert.deepEqual(await updateInventory("/ci-1/location", destination, '"i1"'), { data: { id: "ci-1", name: "Switch" }, revision: '"i2"' });
  assert.equal(calls[0].url, "/api/inventory/ci-1/location");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].headers, { "Content-Type": "application/json", "If-Match": '"i1"' });
  assert.deepEqual(JSON.parse(calls[0].body), destination);
});

test("inventory: a rejected request shows the server's text, or the status when the reply is not JSON", async t => {
  const detail = "Equipment changed in another session. Refresh, review its location, and try again.";
  serve(t, [{ status: 409, body: { detail } }, { status: 502, text: "<html>Bad gateway</html>" }]);
  await assert.rejects(updateInventory("", {}, '"r1"'), e => e.status === 409 && e.message === detail);
  await assert.rejects(loadInventory("x"), e => e.status === 502 && e.message === "Request failed (502). Check the fields and try again.");
});

test(
  "inventory: a 422 validation reason from the server reaches the Scan page",
  async t => {
    serve(t, [{ status: 422, body: { detail: [{ type: "value_error", loc: ["body", "code"], msg: "Value error, Scan one barcode without control characters", input: "01\u001d123" }] } }]);
    const error = await rejection(updateInventory("", { code: "01\u001d123", name: "01\u001d123", type: "other", rack: "Rack-01", u: 1, position: "" }, '"r1"'));
    assert.equal(error?.status, 422);
    assert.match(error.message, /control characters/);
  },
);

// ---- api/inventory.js: equipment saves (DCIM / Twin editors) ----

test("inventory: equipment edits based on a list that was not loaded here are refused without a request", async t => {
  const shown = alerts(t);
  const calls = serve(t, [{ body: { "Rack-01": [] }, etag: '"v1"' }]);
  const loaded = await loadRackItems();
  // A structurally equal copy has no known revision either: only the loaded object carries one.
  for (const previous of [{ "Rack-01": [] }, structuredClone(loaded)]) {
    const error = await rejection(saveRackItems({ "Rack-01": [{ id: "ci-1" }] }, previous));
    assert.match(error?.message, /Reload DCIM before editing equipment/);
    assert.equal(error.reloaded, undefined);
  }
  assert.equal(shown.length, 2);
  assert.deepEqual(calls.map(c => c.method), ["GET"]);
});

test("inventory: a 428 also reloads the list; when the reload fails the server's reason stays and nothing is offered", async t => {
  const shown = alerts(t);
  const fresh = { "Rack-01": [{ id: "ci-1", u: 2 }] };
  const conflict = "Equipment changed in another session. Refresh, review its location, and try again.";
  const calls = serve(t, [
    { body: { "Rack-01": [] }, etag: '"v1"' },
    { status: 428, body: { detail: "Reload the equipment inventory before saving." } },
    { body: fresh, etag: '"v2"' },
    { status: 409, body: { detail: conflict } },
    { status: 503, text: "maintenance" },
  ]);
  const first = await rejection(saveRackItems({ "Rack-01": [{ id: "ci-9" }] }, await loadRackItems()));
  assert.equal(first.status, 428);
  assert.deepEqual(first.reloaded, fresh);
  assert.match(first.message, /reloaded/);
  const second = await rejection(saveRackItems(fresh, first.reloaded));
  assert.equal(second.status, 409);
  assert.equal(second.reloaded, null);
  assert.equal(second.message, conflict);
  assert.deepEqual(shown, [first.message, conflict]);
  assert.deepEqual(calls.map(c => `${c.method} ${c.headers["If-Match"] ?? ""}`.trim()), ["GET", 'PUT "v1"', "GET", 'PUT "v2"', "GET"]);
});

test("inventory: each accepted equipment save hands its revision to the next edit; a 403 is shown without reloading", async t => {
  const shown = alerts(t);
  const calls = serve(t, [
    { body: { R: [] }, etag: '"v1"' },
    { body: { R: [{ id: "a" }] }, etag: '"v2"' },
    { body: { R: [{ id: "a" }, { id: "b" }] }, etag: '"v3"' },
    { status: 403, body: { detail: "CSRF check failed" } },
  ]);
  const v1 = await loadRackItems();
  const v2 = await saveRackItems({ R: [{ id: "a" }] }, v1);
  assert.deepEqual(v2, { R: [{ id: "a" }] });
  const v3 = await saveRackItems({ R: [{ id: "a" }, { id: "b" }] }, v2);
  const denied = await rejection(saveRackItems({ R: [] }, v3));
  assert.equal(denied.status, 403);
  assert.equal(denied.message, "CSRF check failed");
  assert.equal("reloaded" in denied, false);
  assert.deepEqual(shown, ["CSRF check failed"]);
  assert.deepEqual(calls.map(c => `${c.method} ${c.headers["If-Match"] ?? ""}`.trim()), ["GET", 'PUT "v1"', 'PUT "v2"', 'PUT "v3"']);
});

// ---- api/locations.js ----

test("locations: partial server rows get a key, a numeric slot, text ports and no invented labels", () => {
  const loc = normalizeLocations({
    servers: [null, { rack: "R1" },
      { key: "opt5", slot: "12", rack: "", pdu: "bad", kvm: [{ device_id: "k1", port: 3, label: null }] },
      { name: "Jetson", slot: "" }],
    empty_ports: { pdu: [{ device_id: "pa", device_name: "PDU-A", port: "A1" }, { device_id: "pa", device_name: "PDU-A", port: "10" }, { device_id: "pa", device_name: "PDU-A", port: 9 }] },
    racks: [1, "R2"],
  });
  assert.deepEqual(loc.servers, [
    { key: "opt5", name: "opt5", rack: null, slot: 12, pdu: [], kvm: [{ device_id: "k1", device_name: "k1", port: "3" }], kept: null, keptKnown: false },
    { key: "jetson", name: "Jetson", rack: null, slot: null, pdu: [], kvm: [], kept: null, keptKnown: false },
  ]);
  assert.deepEqual(loc.empty_ports.pdu.map(p => p.port), ["9", "10", "A1"]);
  assert.deepEqual(loc.empty_ports.kvm, []);
  assert.deepEqual(loc.racks, ["1", "R2"]);
});

test("locations: change and position text fall back gracefully when the server omits names or sends odd types", () => {
  assert.equal(formatLocation({ rack: null, slot: 5 }), "No rack · U5");
  assert.equal(formatLocation(undefined), "Unplaced");
  assert.deepEqual(describeChange({ device_id: "pa", kind: "pdu", port: 3 }), { where: "pa outlet 3", before: "(empty)", after: "(empty)" });
  assert.deepEqual(describeChange(undefined), { where: "Device port ?", before: "(empty)", after: "(empty)" });
  const result = normalizeMoveResult({ dry_run: 1, plan_revision: 42, changes: "x", positions: [{ before: { rack: "R1", slot: 3 } }], unplaced: [7] });
  assert.deepEqual(result, { dryRun: true, changes: [], positions: [{ server: "", before: "R1 · U3", after: "Unplaced" }], unplaced: ["7"], planRevision: null });
});

test("locations: the move form trims rack and slot, accepts U99, refuses U100 and catches a port chosen twice", () => {
  const server = { key: "opt1", rack: "R2" };
  const pdu = [{ device_id: "pa", port: 7 }];
  assert.deepEqual(buildMoveRequest(server, { pdu, rack: "  R3 ", slot: " 99 " }, false).body, {
    server: "opt1", target_server: null, target_ports: [{ device_id: "pa", port: "7" }], target_rack: "R3", target_slot: 99, swap: true, dry_run: false,
  });
  assert.match(buildMoveRequest(server, { pdu, slot: "100" }, true).error, /1 to 99/);
  assert.match(buildMoveRequest(server, { pdu, slot: "-1" }, true).error, /1 to 99/);
  const rackOnly = buildMoveRequest(server, { pdu, rack: "R4" }, true).body;
  assert.equal(rackOnly.target_rack, "R4");
  assert.equal(rackOnly.target_slot, null);
  assert.match(buildMoveRequest(server, undefined, true).error, /at least one/);
  assert.match(buildMoveRequest(server, { pdu: [{ device_id: "pa", port: 7 }, { device_id: "pa", port: "7" }] }, true).error, /twice/);
});

test("locations: clearing continues past failures and names each failed port with a readable reason", async () => {
  const ports = [
    { device_id: "pa", device_name: "PDU-A", kind: "pdu", port: "5" },
    { device_id: "k1", device_name: "KVM-1", kind: "kvm", port: "2", label: "OPT9" },
    { device_id: "pb", device_name: "PDU-B", kind: "pdu", port: "6", label: "OPT9 (PSU2)" },
  ];
  const calls = [];
  const { cleared, failed } = await clearPorts(ports, async (...args) => {
    calls.push(args);
    if (args[0] === "k1") throw new TypeError("Failed to fetch");
    if (args[0] === "pb") throw Object.assign(new Error("423"), { status: 423 });
  });
  // A port without a shown label is sent with expected "" (not undefined), so the server still checks it.
  assert.deepEqual(calls, [["pa", "5", "", ""], ["k1", "2", "", "OPT9"], ["pb", "6", "", "OPT9 (PSU2)"]]);
  assert.deepEqual(cleared.map(p => p.device_id), ["pa"]);
  assert.equal(clearFailureText(failed),
    "KVM-1 port 2: The request failed. Check the connection and try again.; PDU-B outlet 6: Labels are being saved elsewhere. Try again in a moment.");
  assert.match(moveErrorText({ status: 401 }), /Sign in again/);
  assert.equal(moveErrorText({ status: 418 }), "The request failed (HTTP 418).");
});

test("locations: the label form skips port rows without a number; a chosen port nobody lists is 'another server'", () => {
  const { draft } = labelEditState({ 1: null, 3: "OPT3" }, [{ number: 0, label: null }, { label: "orphan" }, null, { number: 4 }]);
  assert.deepEqual(draft, { 0: "", 1: "", 3: "OPT3", 4: "" });
  const loc = normalizeLocations({
    servers: [{ key: "opt1", name: "OPT1", kvm: [{ device_id: "k1", device_name: "KVM-1", port: "1" }] }],
    empty_ports: { kvm: [{ device_id: "k1", device_name: "KVM-1", port: "2" }] },
  });
  const chosen = ["1", "2", "3"].map(port => ({ device_id: "k1", device_name: "KVM-1", port }));
  assert.deepEqual(takenPorts(chosen, loc, { key: "opt2", name: "OPT2", kvm: [] }, "kvm"), { "k1:1": "OPT1", "k1:3": "another server" });
});

// ---- api/layout.js ----

test("layout: a refused read keeps the server's detail; an edit that throws never writes", async t => {
  const calls = serve(t, [{ status: 403, body: { detail: "Sign in to change the layout" } }, { body: { R1: [] }, etag: '"l1"' }]);
  await assert.rejects(loadLayout("/api/rack-positions"), e => e.status === 403 && e.detail === "Sign in to change the layout" && e.message === e.detail);
  await assert.rejects(saveLayout("/api/rack-positions", () => { throw new Error("Rack R9 does not exist"); }), /Rack R9/);
  assert.deepEqual(calls.map(c => c.method), ["GET", "GET"]);
});

test("layout: after a conflict the retry's own failure is reported with its status, never as raw objects", async t => {
  const calls = serve(t, [
    { body: {}, etag: '"a"' }, { status: 409, body: { detail: "changed" } },
    { body: {}, etag: '"b"' }, { status: 422, body: { detail: [{ msg: "Input should be a valid dictionary" }] } },
  ]);
  const error = await rejection(saveLayout("/api/chillers", doc => doc));
  assert.equal(error.status, 422);
  assert.match(error.message, /HTTP 422/);
  assert.doesNotMatch(error.message, /object Object/);
  assert.deepEqual(calls.map(c => `${c.method} ${c.headers["If-Match"] ?? ""}`.trim()), ["GET", 'PUT "a"', "GET", 'PUT "b"']);
});

// ---- api/changelog.js ----

test("changelog: text before the first heading is not a section; sub-headings and trailing spaces are handled", () => {
  const text = "# Title\nintro line\n## v1.2.0 — 2026-01-02  \n### Fixed\n- a\n---\n## Unreleased\n";
  assert.deepEqual(splitSections(text), [{ title: "v1.2.0 — 2026-01-02", body: "### Fixed\n- a" }, { title: "Unreleased", body: "" }]);
  assert.deepEqual(splitSections(""), []);
  assert.deepEqual(splitSections(undefined), []);
  assert.deepEqual(sectionHeading("Unreleased"), { label: "Unreleased", detail: "", unreleased: true });
  assert.deepEqual(sectionHeading("unreleased – hotfix"), { label: "Unreleased", detail: "hotfix", unreleased: true });
  assert.equal(sectionHeading("UnreleasedX").unreleased, false);
  assert.equal(versionOf("v12 — big release"), "v12");
});

test("changelog: What's new shows at most six sections by default, and only the newest for an unlisted version", () => {
  const log = Array.from({ length: 9 }, (_, i) => `## v1.${9 - i}.0\n- change ${9 - i}`).join("\n");
  assert.deepEqual(releaseNotesSince(log, "v1.1.0", "v1.9.0").map(s => versionOf(s.title)), ["v1.9.0", "v1.8.0", "v1.7.0", "v1.6.0", "v1.5.0", "v1.4.0"]);
  assert.deepEqual(releaseNotesSince(log, null, "v2.0.0").map(s => versionOf(s.title)), ["v1.9.0"]);
});

// ---- power.js ----

test("power: totals skip missing readings but keep a real zero; unknown readings show a dash", () => {
  assert.equal(sumKnown([]), null);
  assert.equal(sumKnown([null, undefined, NaN, Infinity]), null);
  assert.equal(sumKnown([0, null]), 0);
  assert.equal(sumKnown([120.5, null, 79.5, undefined]), 200);
  assert.equal(reading(null, 0, " W"), "—");
  assert.equal(reading(NaN, 1, " A"), "—");
  assert.equal(reading(0, 0, " W"), "0 W");
  assert.equal(reading(12.345, 1, " A"), "12.3 A");
  assert.equal(reading(1499.6), "1500");
});
