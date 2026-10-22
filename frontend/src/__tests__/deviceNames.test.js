import test from "node:test";
import assert from "node:assert/strict";
import { getDeviceNames, getNameSyncStatus, pushDeviceNames } from "../api/deviceNames.js";
import {
  applyResults, badgeInfo, classifyPort, confirmList, deviceNamesForMode, failedResultPorts, hasPending, nameSyncErrorText,
  nameText, normalizeCompare, normalizeResults, normalizeStatus, portNoun, pushBody, resultHeadline, resultText, saveNotice,
  syncSummary, writablePorts, writeBlock, writeButtonText, MODE_TEXT, NAMES_CHANGED, NOTICE_TONE, noticeDuration,
  NOTICE_MS, NOTICE_WARN_MS,
} from "../deviceNames.js";

const realFetch = globalThis.fetch;
function stubFetch(t, reply = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const status = reply.status ?? 200;
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

const compareSample = {
  device_id: "pdu-a", kind: "pdu", mode: "auto", supported: true, reason: "", reachable: true, error: "",
  ports: [
    { port: "10", site: "optn50", device: "optn50", write: "optn50", state: "in_sync", sync: null },
    { port: "2", site: "Outlet 2", device: "old", write: "", state: "differs", sync: null },
    { port: "5", site: "optn45", device: "optn44", write: "optn45", state: "differs", sync: { status: "failed", reason: "x" } },
    { port: "7", site: "optn47", device: null, write: "optn47", state: "unknown", sync: null },
  ],
};

test("classifyPort keeps the server's state and classifies a row without one", () => {
  assert.equal(classifyPort({ state: "differs", write: "a", device: "a" }), "differs");
  assert.equal(classifyPort({ write: null, device: "a" }), "not_writable");
  assert.equal(classifyPort({ write: "a", device: null }), "unknown");
  assert.equal(classifyPort({ write: "a", device: "a" }), "in_sync");
  assert.equal(classifyPort({ write: "", device: "Outlet 3" }), "differs");
  assert.equal(classifyPort({ state: "bogus", write: "", device: "" }), "in_sync");
  assert.equal(classifyPort(null), "not_writable");
});

test("normalizeCompare sorts ports numerically and tolerates missing fields", () => {
  const c = normalizeCompare(compareSample);
  assert.deepEqual(c.ports.map(p => p.port), ["2", "5", "7", "10"]);
  assert.equal(c.kind, "pdu");
  assert.equal(c.mode, "auto");
  assert.equal(c.supported, true);
  assert.equal(c.reachable, true);
  assert.equal(c.ports[1].sync.status, "failed");
  const empty = normalizeCompare({ ports: [{ port: 3 }, null, { port: "" }] });
  assert.deepEqual(empty.ports, [{ port: "3", site: "", device: null, write: null, sync: null, state: "not_writable" }]);
  assert.equal(empty.supported, false, "supported must be an explicit true");
  assert.equal(empty.reachable, false, "reachable must be an explicit true (NS-SEC S6)");
  assert.equal(normalizeCompare({ reachable: "yes" }).reachable, false);
  assert.equal(empty.mode, null);
  assert.equal(normalizeCompare(undefined).ports.length, 0);
});

test("only differing ports with a value to write are selectable, and only when a write is allowed", () => {
  const c = normalizeCompare(compareSample);
  assert.deepEqual(writablePorts(c).map(p => p.port), ["2", "5"]);
  assert.deepEqual(writablePorts({ ...c, mode: "off" }), []);
  assert.deepEqual(writablePorts({ ...c, supported: false }), []);
  assert.deepEqual(writablePorts({ ...c, reachable: false }), []);
  assert.deepEqual(writablePorts(c, { enabled: false }), []);
  assert.deepEqual(writablePorts(null), []);
  assert.deepEqual(writablePorts({ ...c, mode: "manual" }).map(p => p.port), ["2", "5"]);
});

test("writeBlock explains why nothing can be written", () => {
  const c = normalizeCompare(compareSample);
  assert.equal(writeBlock(c), "");
  assert.equal(writeBlock({ ...c, mode: "off" }), MODE_TEXT.off);
  assert.equal(writeBlock({ ...c, supported: false, reason: "Port names cannot be written to this KVM yet" }), "Port names cannot be written to this KVM yet");
  assert.equal(writeBlock({ ...c, supported: false, reason: "" }), "Port names cannot be written to this device.");
  assert.match(writeBlock(c, { enabled: false }), /disabled/);
  assert.equal(writeBlock({ ...c, reachable: false }), "");
  assert.equal(writeBlock(null), "");
});

test("the confirm list names every selected port: old -> new, empty = device default", () => {
  const c = normalizeCompare(compareSample);
  const list = confirmList(c.ports, new Set(["5", "2"]), "pdu");
  assert.deepEqual(list.map(l => l.text), ["Outlet 2: old → device default", "Outlet 5: optn44 → optn45"]);
  assert.deepEqual(confirmList(c.ports, ["7"], "kvm").map(l => l.text), ["Port 7: unknown → optn47"]);
  assert.deepEqual(confirmList(c.ports, [], "pdu"), []);
  assert.deepEqual(confirmList(undefined, ["1"], "pdu"), []);
  assert.equal(portNoun("pdu"), "Outlet");
  assert.equal(portNoun("kvm"), "Port");
  assert.equal(nameText(""), "device default");
  assert.equal(nameText(null), "unknown");
  assert.equal(nameText("op\u0000tn\n45\u007f"), "optn45", "device names are shown as plain text without control characters");
  assert.equal(nameText("<b>x</b>"), "<b>x</b>", "markup stays literal text (React escapes it)");
  assert.equal(writeButtonText(1), "Write 1 name to device");
  assert.equal(writeButtonText(3), "Write 3 names to device");
});

test("a push body is an explicit port list plus the value the compare showed; never empty", () => {
  const c = normalizeCompare({ ...compareSample, ports: [...compareSample.ports, { port: "9", site: "", device: "devonly", write: null, state: "not_writable" }] });
  assert.deepEqual(pushBody(c, ["5", "2", "5"]), { ports: ["2", "5"], expected: { 2: "", 5: "optn45" } });
  assert.equal(pushBody(c, ["9"]), null, "a port without a saved site label is never sent");
  assert.deepEqual(pushBody(c, ["9", "5"]), { ports: ["5"], expected: { 5: "optn45" } });
  assert.equal(pushBody(c, []), null);
  assert.equal(pushBody(null, ["5"]), null);
  assert.deepEqual(writablePorts(c).map(p => p.port), ["2", "5"], "not_writable ports get no checkbox");
  assert.equal(NAMES_CHANGED, "Names changed — review again.");
});

test("status rows: unknown statuses are dropped; pending and the summary are counted", () => {
  const data = {
    mode: "manual",
    devices: {
      "pdu-a": {
        "1": { status: "synced", desired: "optn1", reason: "", updated_at: "t", synced_at: "t" },
        "3": { status: "failed", desired: "optn3", reason: "Device unreachable — retry later", updated_at: "t", synced_at: null },
        "12": { status: "failed", desired: "optn12", reason: "Device refused the name (code 1)" },
        "4": { status: "pending", desired: "optn4" },
        "5": { status: "weird" },
      },
      "pdu-b": { "1": { status: "synced" } },
    },
  };
  const s = normalizeStatus(data, "pdu-a");
  assert.equal(s.mode, "manual");
  assert.deepEqual(Object.keys(s.ports).sort(), ["1", "12", "3", "4"]);
  assert.equal(hasPending(s.ports), true);
  assert.equal(hasPending({ 1: { status: "synced" } }), false);
  const sum = syncSummary(s.ports);
  assert.equal(sum.text, "Names on device: 1 synced, 1 pending, 2 failed");
  assert.deepEqual(sum.failedPorts, ["3", "12"]);
  assert.equal(syncSummary({}).text, "");
  assert.deepEqual(normalizeStatus({}, "x"), { mode: null, ports: {} });
  assert.deepEqual(normalizeStatus(null, "x"), { mode: null, ports: {} });
});

test("badges exist only for a status row and carry the reason", () => {
  assert.equal(badgeInfo(undefined), null);
  assert.equal(badgeInfo({ status: "other" }), null);
  assert.equal(badgeInfo({ status: "synced" }).symbol, "✓");
  assert.equal(badgeInfo({ status: "pending" }).symbol, "⟳");
  const failed = badgeInfo({ status: "failed", reason: "Device unreachable — retry later" });
  assert.equal(failed.symbol, "!");
  assert.equal(failed.text, "Name on device: failed — Device unreachable — retry later");
  assert.equal(badgeInfo({ status: "skipped", reason: "Device name sync is off" }).text, "Name on device: not written — Device name sync is off");
});

test("the save notice follows the response's device_names, or the mode when the response lacks it", () => {
  assert.equal(saveNotice("queued").text, "Sent to device");
  assert.equal(saveNotice("manual").text, "Not sent: manual mode");
  assert.equal(saveNotice("off").text, "Not sent: device name sync is off");
  assert.equal(saveNotice(undefined), null);
  assert.equal(deviceNamesForMode("auto"), "queued");
  assert.equal(deviceNamesForMode("manual"), "manual");
  assert.equal(deviceNamesForMode("off"), "off");
  assert.equal(deviceNamesForMode(null), null);
});

test("not_sent shows the server's reason as a warning and is never 'Sent to device'", () => {
  const refused = saveNotice("not_sent", "Name has characters the device cannot store");
  assert.deepEqual(refused, { text: "Not sent to device: Name has characters the device cannot store", tone: "warn" });
  assert.deepEqual(saveNotice("not_sent", "Port names cannot be written to this KVM yet"),
    { text: "Not sent to device: Port names cannot be written to this KVM yet", tone: "warn" });
  assert.deepEqual(saveNotice("not_sent"), { text: "Not sent to device", tone: "warn" });
  assert.deepEqual(saveNotice("not_sent", "  \n "), { text: "Not sent to device", tone: "warn" });
  assert.equal(saveNotice("not_sent", "bad\u0000reason\n").text, "Not sent to device: badreason", "control characters are dropped");
  for (const reason of [undefined, "", "Name is too long for this device (max 64)"]) {
    assert.notEqual(saveNotice("not_sent", reason).text, "Sent to device");
  }
  // A manual answer with a reason (a save too large to push automatically) shows that reason; without one, the mode.
  assert.deepEqual(saveNotice("manual", "Too many ports changed at once; write them from the device page"),
    { text: "Not sent to device: Too many ports changed at once; write them from the device page", tone: "warn" });
  assert.deepEqual(saveNotice("manual", ""), { text: "Not sent: manual mode", tone: "muted" });
  // "queued" stays "Sent to device" even if a reason were present.
  assert.deepEqual(saveNotice("queued", "ignored"), { text: "Sent to device", tone: "ok" });
  assert.equal(NOTICE_TONE.warn, "text-amber-300");
  assert.equal(noticeDuration(refused), NOTICE_WARN_MS);
  assert.equal(noticeDuration(saveNotice("queued")), NOTICE_MS);
});

test("push results: sorted, unknown status = failed, per-port text, retry list and compare update", () => {
  const r = normalizeResults({ ok: false, results: [
    { port: "5", status: "synced", device: "optn45", reason: "" },
    { port: "2", status: "failed", device: null, reason: "Device unreachable — retry later" },
    { port: "9", status: "???" },
  ] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.results.map(x => [x.port, x.status]), [["2", "failed"], ["5", "synced"], ["9", "failed"]]);
  assert.equal(r.results[2].reason, "No result was reported");
  assert.deepEqual(failedResultPorts(r.results), ["2", "9"]);
  assert.equal(resultHeadline(r.results), "1 written, 2 failed.");
  assert.equal(resultHeadline([]), "Nothing was written: no port needed a change.");
  assert.equal(resultText(r.results[1], "pdu"), "Outlet 5: written (optn45)");
  assert.equal(resultText(r.results[0], "kvm"), "Port 2: failed — Device unreachable — retry later");
  assert.equal(resultText({ port: "1", status: "synced", device: "" }, "pdu"), "Outlet 1: written (device default)");

  const c = normalizeCompare(compareSample);
  const after = applyResults(c, r.results);
  assert.equal(after.ports.find(p => p.port === "5").state, "in_sync");
  assert.equal(after.ports.find(p => p.port === "5").device, "optn45");
  assert.equal(after.ports.find(p => p.port === "2").state, "differs");
  assert.equal(applyResults(c, []), c);
  assert.equal(applyResults(null, r.results), null);
  const mismatch = applyResults(c, [{ port: "5", status: "synced", device: "optn4" }]);
  assert.equal(mismatch.ports.find(p => p.port === "5").state, "differs");
});

test("request errors become fixed texts; a server detail wins", () => {
  assert.equal(nameSyncErrorText({ status: 409, detail: "Device name sync is off" }), "Device name sync is off");
  assert.equal(nameSyncErrorText({ status: 409 }), MODE_TEXT.off);
  assert.match(nameSyncErrorText({ status: 403 }), /Operator role/);
  assert.match(nameSyncErrorText({ status: 404, detail: "Not Found" }), /not available/);
  assert.equal(nameSyncErrorText({ status: 404, detail: "Device not found" }), "Device not found");
  assert.match(nameSyncErrorText({ status: 422 }), /Compare again/);
  assert.match(nameSyncErrorText({ status: 401 }), /Sign in/);
  assert.equal(nameSyncErrorText({ status: 500 }), "Request failed (500). Try again.");
  assert.match(nameSyncErrorText(new TypeError("Failed to fetch")), /Could not reach Lab Manager/);
});

test("API: status query repeats device_id, compare and push hit the agreed paths", async t => {
  const calls = stubFetch(t, { body: { mode: "auto", devices: {} } });
  await getNameSyncStatus(["pdu a", "kvm-1"]);
  await getNameSyncStatus("pdu-a");
  await getNameSyncStatus();
  await getDeviceNames("pdu/a");
  await pushDeviceNames("pdu-a", { ports: [5, "7"], expected: { 5: "optn45", 7: "" } });
  assert.equal(calls[0].url, "/api/devices/name-sync/status?device_id=pdu%20a&device_id=kvm-1");
  assert.equal(calls[1].url, "/api/devices/name-sync/status?device_id=pdu-a");
  assert.equal(calls[2].url, "/api/devices/name-sync/status");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[3].url, "/api/devices/pdu%2Fa/device-names");
  assert.equal(calls[4].url, "/api/devices/pdu-a/device-names/push");
  assert.equal(calls[4].init.method, "POST");
  assert.deepEqual(calls[4].body, { ports: ["5", "7"], expected: { 5: "optn45", 7: "" } });
  assert.equal(calls[4].init.headers["Content-Type"], "application/json");
  assert.equal(calls.length, 5);
});

test("API never sends a push without an explicit port list and expected values", async t => {
  const calls = stubFetch(t, { body: { ok: true, results: [] } });
  await assert.rejects(pushDeviceNames("pdu-a"));
  await assert.rejects(pushDeviceNames("pdu-a", { ports: [], expected: {} }));
  await assert.rejects(pushDeviceNames("pdu-a", { ports: ["1"] }));
  await assert.rejects(pushDeviceNames("pdu-a", ["1"]));
  assert.equal(calls.length, 0);
});

test("API errors carry status and detail but never the raw body", async t => {
  stubFetch(t, { status: 409, body: { detail: "Device name sync is off" } });
  await assert.rejects(pushDeviceNames("pdu-a", { ports: ["1"], expected: { 1: "x" } }), e => e.status === 409 && e.detail === "Device name sync is off" && e.message === "Request failed (409)");
  globalThis.fetch = async () => new Response("<html>secret-ish proxy page</html>", { status: 502 });
  await assert.rejects(getDeviceNames("pdu-a"), e => e.status === 502 && e.detail === undefined && !e.message.includes("html"));
});

test("API passes an abort signal through so a stale compare can be dropped", async t => {
  const calls = stubFetch(t, { body: {} });
  const controller = new AbortController();
  await getDeviceNames("kvm-1", { signal: controller.signal });
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(calls[0].init.cache, "no-store");
});
