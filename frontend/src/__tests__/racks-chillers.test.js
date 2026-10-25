import test from "node:test";
import assert from "node:assert/strict";
import * as mod from "../components/racks/chillers.js";
const { normalizeChillers, groupChillers, updateChiller, placeChiller, addChiller, newChillerId, assertKeepsUnits,
  describePlace, describeShelf, coolingChange, undoCoolingChange, COOLING_DELETE_ERROR } = mod;

const RACKS = ["Rack-01", "Rack-04"];
const doc = () => ({
  units: [
    { id: "ch4", name: "Cooling", rack: "Rack-04", u: 3, serial: "keep-me" },
    { id: "ch4b", name: "Chiller-2", rack: "Rack-04", u: 3 },
    { id: "ch4c", name: "Chiller-3", rack: "Rack-04", u: null },
    { id: "ch-free", name: "צ׳ילר נייד", rack: null, u: null },
    { id: "ch-lost", name: "Chiller-9", rack: "Rack-99", u: 2 },
  ],
  connections: [{ from: "ch4", to: "Rack-04" }],
  version: 7,
});

test("normalizeChillers tolerates missing and broken documents and never drops a unit", () => {
  assert.deepEqual(normalizeChillers(null), { units: [], connections: [] });
  assert.deepEqual(normalizeChillers({ units: "x" }), { units: [], connections: [] });
  const d = doc();
  const n = normalizeChillers(d);
  assert.equal(n.units.length, 5);
  assert.equal(n.version, 7);
  assert.notEqual(n.units, d.units, "a copy, so an edit never changes the original");
});

test("groupChillers: two units on one shelf, unplaced, no rack, rack not found", () => {
  const g = groupChillers(doc().units, RACKS);
  assert.deepEqual(g.byRack["Rack-04"].placed[3].map(u => u.id), ["ch4", "ch4b"]);
  assert.deepEqual(g.byRack["Rack-04"].unplaced.map(u => u.id), ["ch4c"]);
  assert.deepEqual(g.byRack["Rack-01"], { placed: {}, unplaced: [] });
  assert.deepEqual(g.unassigned.map(x => [x.unit.id, x.reason]), [["ch-free", "no-rack"], ["ch-lost", "rack-not-found"]]);
});

test("groupChillers: undefined is null, and only a whole shelf 1-42 is placed", () => {
  const units = [
    { id: "a", name: "A", rack: "Rack-01" },
    { id: "b", name: "B", rack: "Rack-01", u: "3" },
    { id: "c", name: "C", rack: "Rack-01", u: 0 },
    { id: "d", name: "D", rack: "Rack-01", u: 99 },
    { id: "e", name: "E", rack: "Rack-01", u: 42 },
    { id: "f", name: "F" },
  ];
  const g = groupChillers(units, RACKS);
  assert.deepEqual(g.byRack["Rack-01"].unplaced.map(u => u.id), ["a", "b", "c", "d"]);
  assert.deepEqual(Object.keys(g.byRack["Rack-01"].placed), ["42"]);
  assert.deepEqual(g.unassigned.map(x => [x.unit.id, x.reason]), [["f", "no-rack"]]);
});

test("updateChiller and placeChiller change only that unit and keep everything else", () => {
  const d = doc();
  const moved = placeChiller(d, "ch4c", "Rack-01", 2);
  assert.deepEqual(moved.units.find(u => u.id === "ch4c"), { id: "ch4c", name: "Chiller-3", rack: "Rack-01", u: 2 });
  assert.deepEqual(moved.units.filter(u => u.id !== "ch4c"), d.units.filter(u => u.id !== "ch4c"));
  assert.deepEqual(moved.connections, d.connections);
  assert.equal(moved.version, 7);
  // an extra field on the unit itself is kept
  assert.equal(updateChiller(d, "ch4", { name: "Front" }).units[0].serial, "keep-me");
  // an unknown id leaves the document as it is
  assert.equal(updateChiller(d, "nope", { rack: "Rack-01" }), d);
  // no rack forces no shelf
  assert.deepEqual(updateChiller(d, "ch4", { rack: null }).units[0], { id: "ch4", name: "Cooling", rack: null, u: null, serial: "keep-me" });
  assert.deepEqual(updateChiller(d, "ch4", { rack: "", u: 5 }).units[0].u, null);
  // taking a unit off its shelf keeps the rack
  assert.deepEqual(updateChiller(d, "ch4", { u: null }).units[0].rack, "Rack-04");
});

test("addChiller uses the id made outside; a duplicate id changes nothing", () => {
  const id = newChillerId();
  assert.match(id, /^ch-[0-9a-z]+-[0-9a-z]{4}$/);
  const d = doc();
  const added = addChiller(d, { id, name: "Chiller-4", rack: "Rack-01", u: null });
  assert.equal(added.units.length, 6);
  assert.deepEqual(added.units[5], { id, name: "Chiller-4", rack: "Rack-01", u: null });
  assert.equal(addChiller(added, { id, name: "again", rack: null }), added, "a retried add is a no-op");
  assert.deepEqual(addChiller(d, { id: "x", name: "X", rack: null, u: 4 }).units[5], { id: "x", name: "X", rack: null, u: null });
});

test("assertKeepsUnits refuses an edit that drops a unit, with the exact text", () => {
  const d = doc();
  assert.doesNotThrow(() => assertKeepsUnits(d, placeChiller(d, "ch4", null, null)));
  assert.throws(() => assertKeepsUnits(d, { ...d, units: d.units.slice(1) }), { message: COOLING_DELETE_ERROR });
  assert.equal(COOLING_DELETE_ERROR, "Cooling units cannot be deleted. Move the unit to another rack or leave it unassigned instead.");
});

test("there is no delete helper", () => {
  for (const name of ["removeChiller", "deleteChiller", "dropChiller"]) assert.equal(typeof mod[name], "undefined", name);
});

test("describePlace and describeShelf", () => {
  assert.equal(describePlace({ rack: "Rack-04", u: 3 }), "Rack-04 · U03");
  assert.equal(describePlace({ rack: "Rack-04", u: null }), "Rack-04 · not on a shelf");
  assert.equal(describePlace({ rack: "Rack-04", u: "3" }), "Rack-04 · not on a shelf");
  assert.equal(describePlace({ rack: null, u: 3 }), "No rack");
  assert.equal(describePlace({}), "No rack");
  assert.equal(describeShelf({ u: 12 }), "U12");
  assert.equal(describeShelf({ u: null }), "Not on a shelf");
  assert.equal(describeShelf({ u: "x" }), 'Invalid shelf "x"');
});

test("an undo restores the unit, and is refused when it was changed again since", () => {
  const d = doc();
  const unit = d.units.find(u => u.id === "ch4c");
  const change = coolingChange(unit, { rack: "Rack-05", u: 2 });
  assert.deepEqual(change, { unitId: "ch4c", name: "Chiller-3", before: { name: "Chiller-3", rack: "Rack-04", u: null }, after: { name: "Chiller-3", rack: "Rack-05", u: 2 } });
  const moved = placeChiller(d, "ch4c", "Rack-05", 2);
  const back = undoCoolingChange(moved, change);
  assert.deepEqual(back.units.find(u => u.id === "ch4c"), unit);
  const changedAgain = placeChiller(moved, "ch4c", "Rack-01", 7);
  assert.throws(() => undoCoolingChange(changedAgain, change), /changed in another session after your change; nothing was undone/);
  assert.equal(coolingChange(unit, { rack: null, u: 5 }).after.u, null);
});

test("sameDocument ignores key order and missing empty lists", () => {
  assert.equal(mod.sameDocument({ units: [{ id: "a", rack: "R", u: 1 }] }, { connections: [], units: [{ u: 1, rack: "R", id: "a" }] }), true);
  assert.equal(mod.sameDocument({ units: [{ id: "a", rack: "R", u: 1 }] }, { units: [{ id: "a", rack: "R", u: 2 }] }), false);
  assert.equal(mod.sameDocument(doc(), structuredClone(doc())), true);
});

test("placeChanges lists moves, renames, additions and units left out, for the change history", () => {
  const before = [{ id: "c3", name: "Chiller-3", rack: "Rack-04", u: 5 }, { id: "c1", name: "Cooling", rack: "Rack-01", u: 2 },
    { id: "c9", name: "Old", rack: null, u: null }, { id: "c7", name: "Same", rack: "Rack-02", u: 1 }];
  const after = [{ id: "c3", name: "Chiller-3", rack: "Rack-04", u: null }, { id: "c1", name: "Cooling-A", rack: "Rack-01", u: 2 },
    { id: "c7", name: "Same", rack: "Rack-02", u: 1 }, { id: "cn", name: "New", rack: "Rack-05", u: 9 }];
  assert.deepEqual(mod.placeChanges(before, after), [
    { id: "c3", name: "Chiller-3", from: "Rack-04 · U05", to: "Rack-04 · not on a shelf", renamedFrom: null },
    { id: "c1", name: "Cooling-A", from: "Rack-01 · U02", to: "Rack-01 · U02", renamedFrom: "Cooling" },
    { id: "c9", name: "Old", from: "No rack", to: null, renamedFrom: null },
    { id: "cn", name: "New", from: null, to: "Rack-05 · U09", renamedFrom: null },
  ]);
  assert.deepEqual(mod.placeChanges(before, before), []);
  assert.deepEqual(mod.placeChanges(null, undefined), []);
});
