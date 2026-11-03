import test from "node:test";
import assert from "node:assert/strict";
import { parseUnitBarcode } from "../api/scanParse.js";
import { placeScannedUnit, undoScannedUnit, canUndo, placeText, floorText, scanDetails } from "../api/unitScan.js";

// A small stand-in for backend/app/routers/inventory.py and PUT /api/rack-items: revisions (If-Match), exact
// case-insensitive matches on id / serial / barcode / MAC, the 409 for a code that already belongs to another unit, and
// POST /api/inventory/{id}/details (only_missing never overwrites a stored value).
function fakeServer(t, initial) {
  const realFetch = globalThis.fetch, realWindow = globalThis.window;
  const state = { data: structuredClone(initial), version: 1, requests: [], before: null };
  const etag = () => `"v${state.version}"`;
  const ids = item => [item.id, item.serial_number, item.barcode, item.mac].filter(Boolean).map(v => String(v).toLowerCase());
  const DETAILS = ["serial_number", "part_number", "model", "mac"];
  const detailsOf = body => Object.fromEntries(DETAILS.map(f => [f, f === "serial_number" ? body.serial ?? body.serial_number : body[f]]).filter(([, v]) => v));
  const all = () => Object.entries(state.data).flatMap(([rack, list]) => list.map(item => ({ ...item, rack })));
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ETag: etag() } });
  globalThis.window = { alert: () => { throw new Error("no alert expected"); } };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const path = new URL(url, "http://x").pathname, query = new URL(url, "http://x").searchParams;
    const body = options.body ? JSON.parse(options.body) : null;
    state.requests.push(`${method} ${path}${query.get("code") ? `?${query.get("code")}` : ""}`);
    await state.before?.(method, path);
    if (method !== "GET" && options.headers?.["If-Match"] !== etag()) return reply({ detail: "Equipment changed in another session. Refresh, review its location, and try again." }, 409);
    if (path === "/api/inventory" && method === "GET") {
      const key = (query.get("code") || "").toLowerCase();
      return reply({ items: all(), matches: key ? all().filter(i => ids(i).includes(key)) : [], racks: [...Object.keys(state.data), "Storage-Main"] });
    }
    if (path === "/api/inventory" && method === "POST") {
      if (all().some(i => ids(i).includes(body.code.toLowerCase()))) return reply({ detail: "This barcode or serial number already belongs to another item." }, 409);
      const item = { id: `ci-new${state.version}`, name: body.name, type: body.type, barcode: body.code, u: body.u, shelf_position: body.position, notes: "", ...detailsOf(body),
        tracking_history: [{ action: "registered", from: null, to: { rack: body.rack, u: body.u, position: body.position } }] };
      (state.data[body.rack] ||= []).push(item); state.version++;
      return reply({ ...item, rack: body.rack }, 201);
    }
    const move = /^\/api\/inventory\/([^/]+)\/location$/.exec(path);
    if (move && method === "POST") {
      const id = decodeURIComponent(move[1]);
      const rack = Object.keys(state.data).find(r => state.data[r].some(i => i.id === id));
      const item = state.data[rack].find(i => i.id === id);
      state.data[rack] = state.data[rack].filter(i => i !== item);
      Object.assign(item, { u: body.u, shelf_position: body.position });
      item.tracking_history = [...(item.tracking_history || []), { action: "moved" }];
      (state.data[body.rack] ||= []).push(item); state.version++;
      return reply({ ...item, rack: body.rack });
    }
    const details = /^\/api\/inventory\/([^/]+)\/details$/.exec(path);
    if (details && method === "POST") {
      const id = decodeURIComponent(details[1]);
      const rack = Object.keys(state.data).find(r => state.data[r].some(i => i.id === id));
      const item = state.data[rack].find(i => i.id === id);
      const wanted = Object.entries(detailsOf(body)).filter(([f]) => !body.only_missing || !item[f]);
      if (wanted.some(([, v]) => all().some(i => i.id !== id && ids(i).includes(String(v).toLowerCase())))) return reply({ detail: "This MAC address already belongs to another item." }, 409);
      if (wanted.length) {
        Object.assign(item, Object.fromEntries(wanted));
        item.tracking_history = [...(item.tracking_history || []), { action: "details updated" }];
        state.version++;
      }
      return reply({ ...item, rack });
    }
    if (path === "/api/rack-items" && method === "GET") return reply(state.data);
    if (path === "/api/rack-items" && method === "PUT") { state.data = body; state.version++; return reply(state.data); }
    return reply({ detail: "not found" }, 404);
  };
  t.after(() => { globalThis.fetch = realFetch; globalThis.window = realWindow; });
  return state;
}

const shelf2 = { rack: "Rack-01", u: 2, position: "" };
const count = (state, code) => Object.values(state.data).flat().filter(i => [i.barcode, i.serial_number].includes(code)).length;

test("a new barcode adds one unit on the floor; scanning it again changes nothing and never adds a second row", async t => {
  const state = fakeServer(t, { "Rack-01": [], "Rack-02": [] });
  const unit = parseUnitBarcode("(21)MT2614X01234(240)MQM8790-HS2F");
  const first = await placeScannedUnit(unit, shelf2);
  assert.equal(first.action, "created");
  assert.equal(first.item.name, "MQM8790-HS2F MT2614X01234");
  assert.equal(first.item.type, "switch");
  assert.equal(first.item.barcode, "MT2614X01234");
  assert.equal(first.item.u, 2);
  assert.ok(canUndo(first));
  const again = await placeScannedUnit(unit, shelf2);
  assert.equal(again.action, "confirmed");
  assert.equal(canUndo(again), false);
  assert.equal(count(state, "MT2614X01234"), 1);
  assert.equal(state.requests.filter(r => r.startsWith("POST")).length, 1, "the repeated scan writes nothing");
});

test("a unit that already has the code (as barcode or serial) is moved to the floor, and Undo moves it back", async t => {
  const state = fakeServer(t, { "Rack-01": [], "Rack-05": [{ id: "ci-5", name: "Switch 05", type: "switch", serial_number: "TEST-005", u: 3, shelf_position: "L" }] });
  const result = await placeScannedUnit(parseUnitBarcode("test-005"), shelf2);
  assert.equal(result.action, "moved");
  assert.deepEqual(result.before, { rack: "Rack-05", u: 3, position: "L" });
  assert.equal(state.data["Rack-01"][0].id, "ci-5");
  assert.equal(count(state, "TEST-005"), 1);
  assert.equal(await undoScannedUnit(result), null);
  assert.equal(state.data["Rack-05"][0].u, 3);
  assert.equal(state.data["Rack-05"][0].shelf_position, "L");
});

test("Undo removes a unit the scan added, unless it changed since", async t => {
  const state = fakeServer(t, { "Rack-01": [] });
  const result = await placeScannedUnit(parseUnitBarcode("NEW-1"), shelf2);
  const saved = await undoScannedUnit(result);
  assert.deepEqual(saved, { "Rack-01": [] });
  assert.equal(count(state, "NEW-1"), 0);
  await assert.rejects(undoScannedUnit(result), /already removed/);

  const moved = await placeScannedUnit(parseUnitBarcode("NEW-2"), shelf2);
  await placeScannedUnit(parseUnitBarcode("NEW-2"), { rack: "Rack-01", u: 3, position: "" });
  await assert.rejects(undoScannedUnit(moved), /changed after the scan/);
  assert.equal(count(state, "NEW-2"), 1, "a unit moved after the scan is kept");
});

test("Undo of a move does nothing when the unit was moved again meanwhile", async t => {
  const state = fakeServer(t, { "Rack-01": [], "Rack-03": [{ id: "ci-3", name: "Switch 03", barcode: "TEST-003", u: 1, shelf_position: "" }] });
  const result = await placeScannedUnit(parseUnitBarcode("TEST-003"), shelf2);
  await placeScannedUnit(parseUnitBarcode("TEST-003"), { rack: "Rack-01", u: 4, position: "" });
  await assert.rejects(undoScannedUnit(result), /changed after the scan/);
  assert.equal(state.data["Rack-01"][0].u, 4);
});

test("a code that matches two units changes nothing and lists both", async t => {
  const state = fakeServer(t, { "Rack-01": [{ id: "a", name: "A", serial_number: "DUP-1", u: 1 }], "Rack-02": [{ id: "b", name: "B", barcode: "dup-1", u: 2 }] });
  const error = await placeScannedUnit(parseUnitBarcode("DUP-1"), shelf2).then(() => null, e => e);
  assert.match(error.message, /matches 2 units, so nothing was changed/);
  assert.deepEqual(error.matches.map(m => m.id).sort(), ["a", "b"]);
  assert.equal(state.requests.filter(r => r.startsWith("POST")).length, 0);
});

test("another session's write in between: the stale revision is retried once and still adds no second unit", async t => {
  const state = fakeServer(t, { "Rack-01": [] });
  let raced = false;
  state.before = async (method, path) => {
    // Just before this page registers the code, another scanner registers the same code.
    if (!raced && method === "POST" && path === "/api/inventory") {
      raced = true;
      state.data["Rack-01"].push({ id: "ci-other", name: "Other session", barcode: "RACE-1", u: 1, tracking_history: [] });
      state.version++;
    }
  };
  const result = await placeScannedUnit(parseUnitBarcode("RACE-1"), shelf2);
  assert.equal(result.action, "moved");
  assert.equal(result.item.id, "ci-other");
  assert.equal(count(state, "RACE-1"), 1);
});

test("an unknown rack is refused before anything is written", async t => {
  const state = fakeServer(t, { "Rack-01": [] });
  await assert.rejects(placeScannedUnit(parseUnitBarcode("X-1"), { rack: "Rack-99", u: 1 }), /not in the inventory/);
  assert.equal(state.requests.filter(r => r.startsWith("POST")).length, 0);
});

test("place text names the server and its floor", () => {
  assert.equal(placeText({ rack: "Rack-01", u: 2 }, "OPT12"), "OPT12 · floor 2");
  assert.equal(placeText({ rack: "Rack-01", u: 0 }), "Rack-01 · rack level");
  assert.equal(placeText({ rack: "Rack-01", u: 7 }), "Rack-01 · U7");
  assert.equal(placeText({ rack: "Storage-Main", u: 0 }, "x"), "Main storage");
  assert.equal(placeText({ rack: "Storage-Main", u: 7 }, "x"), "Main storage · shelf 7");
  assert.equal(floorText(4), "floor 4");
  assert.equal(floorText(7, "Storage-Main"), "shelf 7");
  assert.equal(floorText(0, "Storage-Main"), "whole storage");
  assert.equal(floorText(7, "Rack-01"), "U7");
});

const LABEL = "SN: MT2614X09999; PN: MQM8790-HS2F; Model: QM8790; MAC: b8-ce-f6-00-11-22";
const stored = (state, id) => Object.entries(state.data).flatMap(([rack, list]) => list.map(i => ({ ...i, rack }))).find(i => i.id === id);

test("the scanned serial, part number, model and MAC are sent as the unit's own fields", () => {
  assert.deepEqual(scanDetails(parseUnitBarcode(LABEL)),
    { serial_number: "MT2614X09999", part_number: "MQM8790-HS2F", model: "QM8790", mac: "B8:CE:F6:00:11:22" });
  assert.deepEqual(scanDetails(parseUnitBarcode("(21)MT2614X01234(240)MQM8790-HS2F")), { serial_number: "MT2614X01234", part_number: "MQM8790-HS2F" });
  assert.deepEqual(scanDetails(parseUnitBarcode("PLAIN-CODE")), {});
  // A MAC the server would refuse is left out, so it can never fail the scan.
  assert.deepEqual(scanDetails({ serial: "S1", mac: "not a mac" }), { serial_number: "S1" });
});

test("a new unit is created with all four fields in one request", async t => {
  const state = fakeServer(t, { "Rack-01": [] });
  const result = await placeScannedUnit(parseUnitBarcode(LABEL), shelf2);
  assert.equal(result.action, "created");
  assert.deepEqual(state.requests.filter(r => r.startsWith("POST")), ["POST /api/inventory"]);
  const item = stored(state, result.item.id);
  assert.deepEqual([item.barcode, item.serial_number, item.part_number, item.model, item.mac],
    ["MT2614X09999", "MT2614X09999", "MQM8790-HS2F", "QM8790", "B8:CE:F6:00:11:22"]);
  assert.deepEqual(result.filled, {});
  // Undo removes it while the fields are as the scan saved them.
  await undoScannedUnit(result);
  assert.equal(stored(state, result.item.id), undefined);
});

test("Undo keeps a new unit whose fields were edited after the scan", async t => {
  const state = fakeServer(t, { "Rack-01": [] });
  const result = await placeScannedUnit(parseUnitBarcode(LABEL), shelf2);
  state.data["Rack-01"][0].model = "Edited";
  state.version++;
  await assert.rejects(undoScannedUnit(result), /changed after the scan/);
  assert.equal(stored(state, result.item.id).model, "Edited");
});

test("a known unit found by its MAC is moved and gets only the fields it lacks; Undo restores exactly the previous record", async t => {
  const original = { id: "ci-7", name: "Switch 07", type: "switch", serial_number: "OLD-SERIAL", mac: "B8:CE:F6:00:11:22", u: 3, shelf_position: "L", notes: "keep" };
  const state = fakeServer(t, { "Rack-01": [], "Rack-07": [structuredClone(original)] });
  const result = await placeScannedUnit(parseUnitBarcode("MAC: b8:ce:f6:00:11:22; Model: QM8790; PN: MQM8790-HS2F"), shelf2);
  assert.equal(result.action, "moved");
  assert.equal(result.item.id, "ci-7");
  assert.deepEqual(result.filled, { part_number: "MQM8790-HS2F", model: "QM8790" });
  const item = stored(state, "ci-7");
  assert.deepEqual([item.rack, item.u, item.serial_number, item.mac, item.part_number, item.model],
    ["Rack-01", 2, "OLD-SERIAL", "B8:CE:F6:00:11:22", "MQM8790-HS2F", "QM8790"]);
  assert.equal(state.requests.filter(r => r.startsWith("POST")).at(-1), "POST /api/inventory/ci-7/details");
  assert.ok(canUndo(result));

  const saved = await undoScannedUnit(result);
  assert.ok(saved, "Undo saves the restored list in one request");
  const back = stored(state, "ci-7");
  delete back.tracking_history;
  assert.deepEqual(back, { ...original, rack: "Rack-07" });
  assert.equal(state.requests.filter(r => r === "PUT /api/rack-items").length, 1);
});

test("a stored serial is never overwritten by a different scanned one", async t => {
  const state = fakeServer(t, { "Rack-01": [{ id: "ci-1", name: "Switch 01", barcode: "TAG-1", serial_number: "OLD", u: 1 }] });
  // The unit is found by its barcode; the label's other serial is not written over the stored one.
  const result = await placeScannedUnit({ ...parseUnitBarcode("TAG-1"), serial: "NEW", model: "QM8790" }, shelf2);
  assert.equal(result.action, "moved");
  assert.deepEqual(result.filled, { model: "QM8790" });
  assert.equal(stored(state, "ci-1").serial_number, "OLD");
});

test("a repeat scan of a unit already on the floor only fills missing fields, and its Undo clears just those", async t => {
  const state = fakeServer(t, { "Rack-01": [{ id: "ci-1", name: "Switch 01", serial_number: "MT2614X09999", u: 2, shelf_position: "" }] });
  const result = await placeScannedUnit(parseUnitBarcode(LABEL), shelf2);
  assert.equal(result.action, "confirmed");
  assert.deepEqual(Object.keys(result.filled).sort(), ["mac", "model", "part_number"]);
  assert.ok(canUndo(result));
  const again = await placeScannedUnit(parseUnitBarcode(LABEL), shelf2);
  assert.equal(again.action, "confirmed");
  assert.deepEqual(again.filled, {});
  assert.equal(canUndo(again), false, "nothing changed, nothing to undo");
  assert.equal(state.requests.filter(r => r.startsWith("POST")).length, 1, "a unit that has every field gets no write");
  await undoScannedUnit(result);
  const item = stored(state, "ci-1");
  assert.deepEqual([item.rack, item.u, item.serial_number, item.part_number, item.model, item.mac], ["Rack-01", 2, "MT2614X09999", undefined, undefined, undefined]);
});

test("Undo of a fill does nothing when a filled field was edited meanwhile", async t => {
  const state = fakeServer(t, { "Rack-01": [], "Rack-02": [{ id: "ci-2", name: "Switch 02", serial_number: "MT2614X09999", u: 1 }] });
  const result = await placeScannedUnit(parseUnitBarcode(LABEL), shelf2);
  state.data["Rack-01"][0].model = "Changed";
  state.version++;
  await assert.rejects(undoScannedUnit(result), /changed after the scan/);
  assert.equal(stored(state, "ci-2").rack, "Rack-01");
  assert.equal(stored(state, "ci-2").model, "Changed");
});

test("a fill the server refuses keeps the move and reports why", async t => {
  const state = fakeServer(t, { "Rack-01": [], "Rack-02": [{ id: "ci-2", name: "Switch 02", serial_number: "MT2614X09999", u: 1 }],
    "Rack-03": [{ id: "ci-3", name: "Other", barcode: "OTHER", u: 1 }] });
  // Another session gives that MAC to ci-3 just before the fill is saved.
  state.before = async (method, path) => { if (path.endsWith("/details")) state.data["Rack-03"][0].mac = "B8:CE:F6:00:11:22"; };
  const result = await placeScannedUnit(parseUnitBarcode(LABEL), shelf2);
  assert.equal(result.action, "moved");
  assert.deepEqual(result.filled, {});
  assert.match(result.fillError, /MAC address already belongs/);
  assert.deepEqual([stored(state, "ci-2").rack, stored(state, "ci-2").mac], ["Rack-01", undefined]);
  assert.ok(canUndo(result));
  await undoScannedUnit(result);
  assert.equal(stored(state, "ci-2").rack, "Rack-02");
});
