import test from "node:test";
import assert from "node:assert/strict";
import { parseUnitBarcode } from "../api/scanParse.js";
import { placeScannedUnit, undoScannedUnit, canUndo, placeText, floorText } from "../api/unitScan.js";

// A small stand-in for backend/app/routers/inventory.py and PUT /api/rack-items: revisions (If-Match), exact
// case-insensitive matches on id / serial / barcode, and the 409 for a code that already belongs to another unit.
function fakeServer(t, initial) {
  const realFetch = globalThis.fetch, realWindow = globalThis.window;
  const state = { data: structuredClone(initial), version: 1, requests: [], before: null };
  const etag = () => `"v${state.version}"`;
  const ids = item => [item.id, item.serial_number, item.barcode].filter(Boolean).map(v => String(v).toLowerCase());
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
      const item = { id: `ci-new${state.version}`, name: body.name, type: body.type, barcode: body.code, u: body.u, shelf_position: body.position, notes: "",
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
  assert.equal(floorText(4), "floor 4");
});
