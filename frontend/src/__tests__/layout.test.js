import test from "node:test";
import assert from "node:assert/strict";
import { loadLayout, saveLayout } from "../api/layout.js";

const realFetch = globalThis.fetch;

// Each queued reply answers the next request in order; every request is recorded.
function stubFetch(t, replies) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${options.method || "GET"} ${url}`);
    const body = reply.text ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(body, { status: reply.status ?? 200, headers: reply.etag ? { ETag: reply.etag } : {} });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

const addSlot = doc => ({ ...doc, "Rack-01": { ...(doc["Rack-01"] || {}), opt12: 9 } });

test("a layout save re-reads the store, applies only this edit and sends If-Match", async t => {
  const calls = stubFetch(t, [
    { body: { "Rack-01": { opt11: 5 }, "Rack-02": { opt21: 1 } }, etag: '"r1"' },
    { body: { ok: true }, etag: '"r2"' },
  ]);
  const saved = await saveLayout("/api/rack-slots", addSlot);
  assert.deepEqual(saved, { "Rack-01": { opt11: 5, opt12: 9 }, "Rack-02": { opt21: 1 } });
  assert.deepEqual(calls.map(c => c.method), ["GET", "PUT"]);
  assert.equal(calls[1].headers["If-Match"], '"r1"');
  assert.deepEqual(calls[1].body, saved);
});

test("a 409 repeats the whole cycle once on the fresh document", async t => {
  const calls = stubFetch(t, [
    { body: { "Rack-01": { opt11: 5 } }, etag: '"r1"' },
    { status: 409, body: { detail: "This layout was changed in another session. Reload and try again." } },
    { body: { "Rack-01": { opt11: 5, opt13: 2 } }, etag: '"r2"' },
    { body: { ok: true } },
  ]);
  const saved = await saveLayout("/api/rack-slots", addSlot);
  assert.deepEqual(saved, { "Rack-01": { opt11: 5, opt13: 2, opt12: 9 } });
  assert.deepEqual(calls.map(c => c.method), ["GET", "PUT", "GET", "PUT"]);
  assert.equal(calls[3].headers["If-Match"], '"r2"');
});

test("a second 409 fails with the server detail", async t => {
  const conflict = { status: 409, body: { detail: "This layout was changed in another session. Reload and try again." } };
  const calls = stubFetch(t, [{ body: {}, etag: '"r1"' }, conflict, { body: {}, etag: '"r2"' }, conflict]);
  await assert.rejects(saveLayout("/api/rack-slots", addSlot), e => e.status === 409 && e.message === conflict.body.detail);
  assert.equal(calls.filter(c => c.method === "PUT").length, 2);
});

test("any other failure shows the server detail and is not retried", async t => {
  const calls = stubFetch(t, [{ body: {}, etag: '"r1"' }, { status: 403, body: { detail: "CSRF check failed" } }]);
  await assert.rejects(saveLayout("/api/rack-slots", addSlot), e => e.status === 403 && e.message === "CSRF check failed");
  assert.equal(calls.length, 2);
});

test("a failure without a JSON detail still names the status", async t => {
  stubFetch(t, [{ body: {} }, { status: 503, text: "Service Unavailable" }]);
  await assert.rejects(saveLayout("/api/chillers", doc => doc), e => e.status === 503 && /503/.test(e.message));
});

test("without an ETag the PUT is sent without If-Match", async t => {
  const calls = stubFetch(t, [{ body: { "Rack-01": ["opt11"] } }, { body: { ok: true } }]);
  await saveLayout("/api/rack-positions", doc => ({ ...doc, "Rack-01": ["opt12", "opt11"] }));
  assert.equal("If-Match" in calls[1].headers, false);
  assert.deepEqual(calls[1].body, { "Rack-01": ["opt12", "opt11"] });
});

test("a failed read never writes", async t => {
  const calls = stubFetch(t, [{ status: 401, text: "Unauthorized" }]);
  await assert.rejects(saveLayout("/api/rack-overrides", doc => doc), e => e.status === 401);
  assert.deepEqual(calls.map(c => c.method), ["GET"]);
});

test("loading a store returns its document and revision", async t => {
  stubFetch(t, [{ body: { units: [], connections: [] }, etag: '"c1"' }]);
  assert.deepEqual(await loadLayout("/api/chillers"), { data: { units: [], connections: [] }, etag: '"c1"' });
});
