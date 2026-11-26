import test from "node:test";
import assert from "node:assert/strict";
import { api, deviceState, errorMessage, STATE_TEXT } from "../api/client.js";

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response; };
  return calls;
}
const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test("labels PATCH sends If-Match only with the device's labels_revision", async () => {
  const calls = stubFetch(ok({ ok: true }));
  await api.updateLabels("pdu1", { 1: "OPT11" }, '"abc"');
  await api.updateLabels("pdu1", { 1: "OPT11" });
  await api.updateLabels("pdu1", { 1: "OPT11" }, undefined);
  await api.getDevices();
  assert.equal(calls[0].url, "/api/devices/pdu1/labels");
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[0].init.body, JSON.stringify({ 1: "OPT11" }));
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json", "If-Match": '"abc"' });
  assert.deepEqual(calls[1].init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(calls[2].init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(calls[3].init.headers, {});
});

test("the display's reads take an optional AbortSignal; other callers send exactly what they sent before", async () => {
  const calls = stubFetch(ok([]));
  const controller = new AbortController();
  await api.getDevices({ signal: controller.signal });
  await api.getPduStatus("pdu1", { signal: controller.signal });
  await api.getKvmStatus("kvm1", { signal: controller.signal });
  await api.maintenanceList({ signal: controller.signal });
  await api.getDevices();
  await api.getPduStatus("pdu1");
  assert.deepEqual(calls.map(c => c.url), ["/api/devices/", "/api/pdus/pdu1/status", "/api/kvms/kvm1/status", "/api/pdus/maintenance", "/api/devices/", "/api/pdus/pdu1/status"]);
  for (const call of calls.slice(0, 4)) assert.equal(call.init.signal, controller.signal);
  for (const call of calls.slice(4)) {
    assert.equal("signal" in call.init, false);
    assert.deepEqual(call.init, { method: "GET", headers: {}, body: undefined });
  }
});

test("a stale revision's 409 carries the status and the server detail", async () => {
  const detail = "Port labels on this device were changed in another session. Reload and try again.";
  stubFetch({ ok: false, status: 409, text: async () => JSON.stringify({ detail }) });
  await assert.rejects(api.updateLabels("pdu1", {}, '"old"'), e => e.status === 409 && e.detail === detail && errorMessage(e) === detail);
});

test("validation errors are joined into one readable detail", async () => {
  stubFetch({ ok: false, status: 422, text: async () => JSON.stringify({ detail: [{ msg: "Label values must be text" }, { msg: "Port keys must be numbers" }] }) });
  await assert.rejects(api.updateLabels("pdu1", { 1: 5 }), e => errorMessage(e) === "Label values must be text; Port keys must be numbers");
});

test("errors without a JSON detail fall back to the message", async () => {
  stubFetch({ ok: false, status: 502, text: async () => "Bad gateway" });
  await assert.rejects(api.getDevices(), e => e.status === 502 && e.detail === undefined && errorMessage(e) === "502: Bad gateway");
  assert.equal(errorMessage({ detail: "d", message: "500: {}" }), "d");
  assert.equal(errorMessage(new Error("m")), "m");
});

test("device state separates a failed request, offline and reachable-with-error", () => {
  assert.equal(deviceState(undefined), "unknown");
  assert.equal(deviceState({ device_id: "pdu1", requestFailed: true, outlets: [], error: "Simulated failure" }), "unavailable");
  assert.equal(deviceState({ reachable: false, error: "Fixture: PDU unavailable" }), "offline");
  assert.equal(deviceState({ reachable: true, ports: [], error: "Device API authentication failed" }), "error");
  assert.equal(deviceState({ reachable: true, ports: [{ number: 1 }], error: null }), "online");
  assert.equal(STATE_TEXT[deviceState({ requestFailed: true })], "Status unavailable");
  assert.notEqual(STATE_TEXT[deviceState({ reachable: true, error: "x" })], "Online");
});
