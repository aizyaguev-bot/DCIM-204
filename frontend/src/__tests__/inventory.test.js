import test from "node:test";
import assert from "node:assert/strict";
import { locationCode, parseLocationCode, rackCode, mainStorageCode, MAIN_STORAGE, labelCode, loadRackItems, saveRackItems,
  normalizeMac, unitDetailChanges, detailText, UNIT_DETAILS, UNIT_DETAIL_FIELDS } from "../api/inventory.js";

test("every printed label value (shared by its barcode and QR code) scans back to the same location", () => {
  const shelf = { rack: "Rack:01 / בדיקה", u: 4, position: "Left: front / A" };
  assert.equal(labelCode(shelf), locationCode(shelf.rack, shelf.u, shelf.position));
  assert.equal(labelCode({ rack: "Rack-07", u: 0, position: "" }), rackCode("Rack-07"));
  assert.equal(labelCode({ rack: MAIN_STORAGE, u: 0, position: "" }), mainStorageCode);
  for (const label of [shelf, { rack: "Rack-01", u: 1, position: "" }, { rack: "Rack-01", u: 42, position: "" }, { rack: "Rack-07", u: 0, position: "" }, { rack: MAIN_STORAGE, u: 0, position: "" }]) {
    assert.deepEqual(parseLocationCode(labelCode(label)), label);
    // A scanner may end its keystrokes with Enter or Tab; the Scan page trims before parsing.
    assert.deepEqual(parseLocationCode(`${labelCode(label)}\r\n`.trim()), label);
  }
});

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

test("a MAC address is stored in one form whatever separators were typed", () => {
  for (const mac of ["b8:ce:f6:00:11:22", " B8-CE-F6-00-11-22 ", "b8cef6001122", "b8ce.f600.1122"]) assert.equal(normalizeMac(mac), "B8:CE:F6:00:11:22");
  for (const bad of ["b8:ce:f6:00:11", "b8:ce-f6:00:11:22", "zz:ce:f6:00:11:22", "", null, 5]) assert.equal(normalizeMac(bad), "");
  assert.deepEqual(UNIT_DETAILS.map(([, label]) => label), ["Serial number", "Part number", "Model", "MAC address"]);
});

test("the equipment panel saves only the detail fields that were edited, cleaned, and refuses a bad MAC", () => {
  const item = { id: "ci-1", serial_number: "MT1", model: " legacy ", mac: "aa-bb-cc-dd-ee-ff" };
  const unchanged = Object.fromEntries(UNIT_DETAIL_FIELDS.map(f => [f, detailText(item, f)]));
  assert.deepEqual(unitDetailChanges(item, unchanged), { changes: {}, errors: {} }, "untouched legacy values are not rewritten");
  assert.deepEqual(unitDetailChanges(item, { ...unchanged, part_number: "  MQM8790-HS2F ", mac: "b8cef6001122" }).changes,
    { part_number: "MQM8790-HS2F", mac: "B8:CE:F6:00:11:22" });
  assert.deepEqual(unitDetailChanges(item, { ...unchanged, serial_number: "", model: "   " }).changes, { serial_number: "", model: "" }, "blank clears a field");
  assert.deepEqual(unitDetailChanges(item, { ...unchanged, serial_number: "MT1 " }).changes, {}, "only whitespace added");
  const bad = unitDetailChanges(item, { ...unchanged, mac: "12:34", model: "M".repeat(121) });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["mac", "model"]);
  assert.match(bad.errors.mac, /six pairs of hex digits/);
  assert.deepEqual(bad.changes, {});
});

test("an equipment save sends the edited detail fields with the rest of the record", async t => {
  const realFetch = globalThis.fetch, realWindow = globalThis.window;
  const sent = [];
  const list = { "Rack-01": [{ id: "ci-1", name: "Switch 01", u: 2, serial_number: "MT1" }] };
  globalThis.window = { alert: () => {} };
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === "PUT") sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify(options.method === "PUT" ? JSON.parse(options.body) : list), { headers: { ETag: '"v1"' } });
  };
  t.after(() => { globalThis.fetch = realFetch; globalThis.window = realWindow; });
  const loaded = await loadRackItems();
  const { changes } = unitDetailChanges(loaded["Rack-01"][0], { serial_number: "MT1", part_number: "P-1", model: "M-1", mac: "001a2b3c4d5e" });
  await saveRackItems({ "Rack-01": [{ ...loaded["Rack-01"][0], ...changes }] }, loaded);
  assert.deepEqual(sent[0]["Rack-01"][0], { id: "ci-1", name: "Switch 01", u: 2, serial_number: "MT1", part_number: "P-1", model: "M-1", mac: "00:1A:2B:3C:4D:5E" });
});
