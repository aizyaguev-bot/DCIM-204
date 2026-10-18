import test from "node:test";
import assert from "node:assert/strict";
import { locationCode, parseLocationCode, rackCode, mainStorageCode, MAIN_STORAGE, loadRackItems, saveRackItems } from "../api/inventory.js";

test("shelf labels round-trip rack and precise position, including punctuation and Hebrew", () => {
  const expected = { rack: "Rack:01 / בדיקה", u: 4, position: "Left: front / A" };
  assert.deepEqual(parseLocationCode(locationCode(expected.rack, expected.u, expected.position)), expected);
});

test("whole rack and main storage labels never default to shelf 1", () => {
  assert.deepEqual(parseLocationCode(rackCode("Rack-07")), { rack: "Rack-07", u: 0, position: "" });
  assert.deepEqual(parseLocationCode(rackCode("Rack: / בדיקה")), { rack: "Rack: / בדיקה", u: 0, position: "" });
  assert.deepEqual(parseLocationCode(mainStorageCode), { rack: MAIN_STORAGE, u: 0, position: "" });
});

test("malformed rack and storage labels are rejected before equipment lookup", () => {
  for (const code of ["RACK:", "RACK:x:1", "RACK:%GG", "RACK:%00", "RACK:Storage-Main", "STORE:OTHER", "STORE:MAIN:1", "LOC:Storage-Main:1:"]) assert.throws(() => parseLocationCode(code));
});

test("normal equipment barcode is not interpreted as a location", () => {
  for (const code of ["00000123", "MT2604603M8U", "ci-123"]) assert.equal(parseLocationCode(code), null);
});

test("invalid shelf labels never become saved locations", () => {
  for (const code of ["LOC:x:0:", "LOC:x:43:", "LOC:x:1.5:", "LOC:x:abc:", "LOC::1:", "LOC:x:1", "LOC:%GG:1:"]) {
    assert.throws(() => parseLocationCode(code));
  }
});

test("an equipment save rejected as stale reloads the list, explains it, and the next save uses the new revision", async t => {
  const realFetch = globalThis.fetch, realWindow = globalThis.window;
  const alerts = [], requests = [];
  const fresh = { "Rack-01": [{ id: "ci-1", name: "Switch 01", u: 2 }, { id: "ci-2", name: "Added elsewhere", u: 3 }] };
  const replies = [
    { body: { "Rack-01": [{ id: "ci-1", name: "Switch 01", u: 2 }] }, etag: '"v1"' },
    { status: 409, body: { detail: "Equipment changed in another session. Refresh, review its location, and try again." } },
    { body: fresh, etag: '"v2"' },
    { body: fresh, etag: '"v3"' },
  ];
  globalThis.window = { alert: message => alerts.push(message) };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ method: options.method || "GET", ifMatch: options.headers?.["If-Match"] });
    const reply = replies.shift();
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.etag ? { ETag: reply.etag } : {} });
  };
  t.after(() => { globalThis.fetch = realFetch; globalThis.window = realWindow; });

  const loaded = await loadRackItems();
  const error = await saveRackItems({ "Rack-01": [] }, loaded).then(() => null, e => e);
  assert.equal(error?.status, 409);
  assert.deepEqual(error.reloaded, fresh);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /reloaded/i);

  await saveRackItems(fresh, error.reloaded);
  assert.deepEqual(requests.map(r => `${r.method} ${r.ifMatch ?? ""}`.trim()), ["GET", 'PUT "v1"', "GET", 'PUT "v2"']);
});
