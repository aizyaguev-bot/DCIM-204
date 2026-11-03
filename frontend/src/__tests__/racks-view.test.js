import test from "node:test";
import assert from "node:assert/strict";
import { serverVisualState, rackSummary, withCoolingRows, compactRows, buildSearchIndex, searchIndex, matchesFilter, floorOptions,
  rackFloors, RACK_FLOORS, STORAGE_SHELVES, floorsFor, FLOOR_UNIT_SLOTS, SHELF_SLOTS, slotOverflow, splitSlots, moreText, serverFacts } from "../components/racks/rackView.js";
import { setStorageRacks, storageRackNames, isStorageRack, rackHasFloors, validFloor, placeWord, placesWord } from "../components/racks/floors.js";
import { describeFloor, validPlace } from "../components/racks/chillers.js";
import { floorText, placeText } from "../api/unitScan.js";

const server = (name, state = "on", pduId = "pdu4") => ({ id: name.toLowerCase(), name, state, pduId, pduName: `PDU ${pduId.slice(3)}`, outlet: 1, watts: 100 });
const row = (u, names = [], kind = "server") => ({ u, items: names.map(name => ({ kind, data: { id: name.toLowerCase(), name } })), auto: false });

test("serverVisualState precedence: loading, unreachable, on/off, unknown; maintenance is its own flag", () => {
  assert.equal(serverVisualState(server("OPT41"), undefined).state, "loading");
  assert.equal(serverVisualState(server("OPT41"), undefined).word, "Reading…");
  const failed = serverVisualState(server("OPT41"), { requestFailed: true });
  assert.deepEqual([failed.state, failed.word, failed.title], ["unreachable", "No reading", "No reading from PDU 4"]);
  assert.equal(serverVisualState(server("OPT41"), { reachable: false }).state, "unreachable");
  assert.equal(serverVisualState(server("OPT41", "on"), { reachable: true }).word, "ON");
  assert.equal(serverVisualState(server("OPT41", "off"), { reachable: true }).word, "OFF");
  const unknown = serverVisualState(server("OPT41", "unknown"), { reachable: true });
  assert.deepEqual([unknown.state, unknown.word, unknown.title], ["unknown", "Unknown", "PDU 4 did not report this outlet"]);
  assert.equal(serverVisualState(server("OPT41", "off"), { reachable: true }, { since: 1 }).maintenance, true);
  assert.equal(serverVisualState(server("OPT41", "off"), { reachable: false }, { since: 1 }).maintenance, true);
  assert.equal(serverVisualState(server("OPT41", "off"), { reachable: true }, null).maintenance, false);
});

test("rackSummary: status for every case, counts, partial, cooling", () => {
  const rack = (extra = {}) => ({ rack: "Rack-04", rackType: "compute", wattsComplete: true,
    pduData: [{ id: "pdu4", name: "PDU 4" }], servers: [server("OPT41"), server("OPT42", "off"), server("OPT43", "unknown")], ...extra });
  const ok = { pdu4: { reachable: true } };
  assert.equal(rackSummary(rack({ rackType: "storage" }), { pduStatuses: ok }).status, "storage");
  assert.equal(rackSummary(rack({ pduData: [] }), { pduStatuses: ok }).statusText, "No PDU");
  assert.equal(rackSummary(rack(), { pduStatuses: {} }).statusText, "Loading…");
  assert.equal(rackSummary(rack(), { pduStatuses: { pdu4: { reachable: false } } }).status, "offline");
  assert.equal(rackSummary(rack(), { pduStatuses: { pdu4: { requestFailed: true } } }).statusText, "No reading");
  const s = rackSummary(rack(), { pduStatuses: ok, maintenance: { pdus: { pdu4: {} } }, cooling: { placed: {}, unplaced: [{ id: "x" }] } });
  assert.deepEqual([s.status, s.total, s.on, s.off, s.noReading, s.partial, s.coolingUnplaced], ["online", 3, 1, 1, 1, false, 1]);
  assert.deepEqual(s.maintenancePdus, ["PDU 4"]);
  assert.equal(rackSummary(rack({ wattsComplete: false }), { pduStatuses: ok }).partial, true);
  // loading servers are not counted as off or no reading
  const loading = rackSummary(rack(), { pduStatuses: {} });
  assert.deepEqual([loading.on, loading.off, loading.noReading], [0, 0, 0]);
});

test("withCoolingRows adds shelves up to the highest cooling unit, before the rack-level row", () => {
  const rows = [...[1, 2, 3, 4, 5, 6, 7, 8].map(u => row(u, u < 3 ? [`OPT${u}`] : [])), row(0, ["Patch"], "custom")];
  const out = withCoolingRows(rows, [10, 3]);
  assert.deepEqual(out.map(r => r.u), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0]);
  assert.equal(out[0], rows[0], "existing rows are kept as they are");
  assert.equal(withCoolingRows(rows, [3]), rows);
  assert.equal(withCoolingRows(rows, []), rows);
  // sparse (Main storage): only the missing cooling shelf is added in order
  const sparse = [row(1, ["A"]), row(3, ["B"]), row(0, ["S"], "custom")];
  assert.deepEqual(withCoolingRows(sparse, [2, 5]).map(r => r.u), [1, 2, 3, 5, 0]);
});

test("compactRows: empty runs fold, single empty rows stay, cooling shelves are never empty", () => {
  const rows = [row(1, ["OPT1"]), row(2, ["OPT2"]), row(3, []), row(4, ["OPT4"]), row(5), row(6), row(7), row(8)];
  const view = compactRows(rows, {});
  assert.deepEqual(view.map(x => x.kind === "gap" ? `${x.from}-${x.to}:${x.reason}` : x.row.u), [1, 2, 3, 4, "5-8:empty"]);
  assert.deepEqual(compactRows(rows, { showEmpty: true }).map(x => x.kind), Array(8).fill("row"));
  const cooled = compactRows(rows, { coolingUs: new Set([6]) });
  assert.deepEqual(cooled.map(x => x.kind === "gap" ? `${x.from}-${x.to}` : x.row.u), [1, 2, 3, 4, 5, 6, "7-8"]);
  // Edit mode: every shelf, even with a search active
  assert.deepEqual(compactRows(rows, { editMode: true, keep: () => false }).map(x => x.kind), Array(8).fill("row"));
});

test("floorsFor: 4 floors in a rack, 16 shelves in Main storage; rackFloors draws that many", () => {
  assert.deepEqual([floorsFor("Rack-01"), floorsFor(null), floorsFor("Storage-Main"), STORAGE_SHELVES], [4, 4, 16, 16]);
  const rows = [row(3, ["OPT3", "NIC"]), row(16, ["Spare"]), row(17), row(20, ["Old"]), row(0, ["Box"], "custom")];
  const { floors, other, level } = rackFloors(rows, new Set(), floorsFor("Storage-Main"));
  assert.deepEqual(floors.map(r => r.u), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual(floors.filter(r => r.items.length).map(r => r.u), [3, 16]);
  assert.deepEqual(other.map(r => r.u), [20], "old data above shelf 16 is kept; an empty U17 is dropped");
  assert.deepEqual(level.map(r => r.u), [0]);
});

test("rackFloors: always floors 1-4, other shelves only when they hold something, rack level last", () => {
  assert.equal(RACK_FLOORS, 4);
  const rows = [row(1, ["OPT1"]), row(2, ["OPT2"]), row(3), row(4), row(5), row(6), row(7, ["OPT7"]), row(8), row(0, ["PDU"], "custom")];
  const { floors, other, level } = rackFloors(rows, new Set([6]));
  assert.deepEqual(floors.map(r => r.u), [1, 2, 3, 4]);
  assert.deepEqual(floors.map(r => r.items.length), [1, 1, 0, 0]);
  assert.deepEqual(other.map(r => r.u), [6, 7], "U6 holds a cooling unit, U7 an OPT; empty U5 and U8 are dropped");
  assert.deepEqual(level.map(r => r.u), [0]);
  // a rack with nothing at all still has its four (empty) floors
  const empty = rackFloors([]);
  assert.deepEqual(empty.floors.map(r => [r.u, r.items.length]), [[1, 0], [2, 0], [3, 0], [4, 0]]);
  assert.deepEqual([empty.other.length, empty.level.length], [0, 0]);
  // empty floors are rows (one "Free" slot each), never folded
  assert.deepEqual(compactRows(rackFloors([row(1, ["A"])]).floors, { showEmpty: true }).map(x => x.kind), ["row", "row", "row", "row"]);
});

test("compactRows: a search folds hidden rows with their empty neighbours; row 0 stays; sparse storage rows pass", () => {
  const rows = [row(1, ["OPT41"]), row(2, ["OPT42"]), row(3, ["OPT43"]), row(4, []), row(5, ["OPT45"]), row(6), row(7), row(0, ["Rack PDU"], "custom")];
  const keep = r => r.items.some(i => i.data.name === "OPT43");
  const view = compactRows(rows, { keep });
  assert.deepEqual(view.map(x => x.kind === "gap" ? `${x.from}-${x.to}:${x.reason}` : x.row.u), ["1-2:filtered", 3, "4-7:filtered", 0]);
  const storage = [row(1, ["A"]), row(3, ["B"]), row(0, ["S"], "custom")];
  assert.deepEqual(compactRows(storage, {}).map(x => x.row.u), [1, 3, 0]);
});

test("search covers owner, switch, serial, cooling and Hebrew; case and spaces do not matter", () => {
  const rackStats = [
    { rack: "Rack-01", servers: [server("OPT11"), server("OPT12")] },
    { rack: "Rack-04", servers: [server("OPT41"), server("OPT43")] },
  ];
  const index = buildSearchIndex({
    rackStats, optOwners: { opt11: "Fixture owner" }, switchAssignments: { opt43: { switch: "Switch 04", port: 12 } },
    customItems: { "Rack-04": [{ id: "ci-4", name: "Switch 04", serial_number: "TEST-004", u: 2 }] },
    coolingUnits: [{ id: "ch-free", name: "צ׳ילר נייד", rack: null, u: null }, { id: "ch4", name: "Cooling", rack: "Rack-04", u: 3 }],
    uMaps: { "Rack-04": { opt41: 1, opt43: 3 } },
  });
  assert.deepEqual([...searchIndex(index, "fixture   OWNER").keys], ["s:opt11"]);
  const sw = searchIndex(index, "switch 04");
  assert.deepEqual(sw.ordered.map(e => e.key), ["e:ci-4", "s:opt43"]);
  assert.deepEqual([...sw.racks], [["Rack-04", 2]]);
  assert.deepEqual([...searchIndex(index, "test-004").keys], ["e:ci-4"]);
  assert.deepEqual([...searchIndex(index, "  צ׳ילר ").keys], ["c:ch-free"]);
  assert.deepEqual([...searchIndex(index, "cooling").keys], ["c:ch4"]);
  const opt = searchIndex(index, "opt");
  assert.deepEqual([...opt.racks.keys()], ["Rack-01", "Rack-04"]);
  assert.equal(opt.total, 4);
  assert.deepEqual(searchIndex(index, "   "), { query: "", total: 0, keys: new Set(), racks: new Map(), ordered: [] });
});

test("matchesFilter: one case per filter; loading matches only All", () => {
  const v = (state, maintenance = false) => ({ state, maintenance });
  assert.equal(matchesFilter(v("off"), "off"), true);
  assert.equal(matchesFilter(v("on"), "off"), false);
  assert.equal(matchesFilter(v("unknown"), "no-reading"), true);
  assert.equal(matchesFilter(v("unreachable"), "no-reading"), true);
  assert.equal(matchesFilter(v("on", true), "maintenance"), true);
  assert.equal(matchesFilter(v("on"), "maintenance"), false);
  assert.equal(matchesFilter(v("loading", true), "maintenance"), false);
  assert.equal(matchesFilter(v("loading"), "all"), true);
});

test("floorOptions: the rack's floors 1-RACK_FLOORS only, rack level first, names on each floor, +N", () => {
  const rows = [row(1, ["OPT41"]), row(2, ["OPT42", "Switch 04", "Patch", "KVM"]), row(3), row(7, ["OPT47"]), row(0, ["Rack PDU"], "custom")];
  const options = floorOptions(rows, { 3: [{ name: "Cooling" }], 17: [{ name: "Old" }] }, "Rack-04");
  assert.equal(options.length, RACK_FLOORS + 1);
  assert.deepEqual(options.map(o => o.value), ["", ...Array.from({ length: RACK_FLOORS }, (_, i) => String(i + 1))]);
  assert.deepEqual(options[0], { value: "", label: "Not on a floor (rack level)" });
  assert.deepEqual(options[1], { value: "1", label: "Floor 1 · OPT41" });
  assert.equal(options[2].label, "Floor 2 · OPT42, Switch 04 +2");
  assert.equal(options[3].label, "Floor 3 · Cooling");
  assert.equal(options[4].label, "Floor 4 · empty");
  // Main storage has shelves 1-16, not floors
  const storage = floorOptions(rows, {}, "Storage-Main");
  assert.equal(storage.length, STORAGE_SHELVES + 1);
  assert.deepEqual(storage[0], { value: "", label: "Not on a shelf (rack level)" });
  assert.equal(storage[7].label, "Shelf 7 · OPT47");
  assert.equal(storage[16].label, "Shelf 16 · empty");
});

// ─── floor template (v2.47) ──────────────────────────────────────────────────────────────────────────────────────────
test("slotOverflow / splitSlots: up to the slots shown; more than that, the last slot is the +N chip", () => {
  assert.deepEqual([0, 1, 2].map(n => slotOverflow(n, 2)), [{ shown: 0, more: 0 }, { shown: 1, more: 0 }, { shown: 2, more: 0 }]);
  assert.deepEqual(slotOverflow(3, 2), { shown: 1, more: 2 }, "3 units in 2 slots: 1 drawn, +2 units");
  assert.deepEqual(slotOverflow(7, 3), { shown: 2, more: 5 });
  assert.deepEqual(slotOverflow(5, 1), { shown: 0, more: 5 }, "a single slot is the +N chip itself");
  assert.deepEqual([slotOverflow(-1, 2), slotOverflow("x", 2), slotOverflow(2, 0)], [{ shown: 0, more: 0 }, { shown: 0, more: 0 }, { shown: 0, more: 2 }]);
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(splitSlots(list, 2), { shown: ["a"], rest: ["b", "c", "d"], more: 3 });
  assert.deepEqual(splitSlots(list, 4), { shown: list, rest: [], more: 0 });
  assert.deepEqual(splitSlots(null, 2), { shown: [], rest: [], more: 0 });
  // every slot is drawn: shown + the +N chip + empty placeholders = the slot count, on every floor and shelf
  for (const slots of [FLOOR_UNIT_SLOTS.card, FLOOR_UNIT_SLOTS.detail, SHELF_SLOTS.card, SHELF_SLOTS.detail]) {
    for (let n = 0; n <= 9; n++) {
      const { shown, more } = slotOverflow(n, slots);
      const free = slots - shown - (more ? 1 : 0);
      assert.ok(free >= 0 && shown + (more ? 1 : 0) + free === slots, `${n} items in ${slots} slots`);
      assert.equal(shown + more, n, "nothing is lost behind +N");
    }
  }
});

test("moreText: +N chips name what they hold", () => {
  assert.deepEqual([moreText(1, "server"), moreText(2, "server"), moreText(1, "unit"), moreText(3, "unit"), moreText(4)],
    ["+1 server", "+2 servers", "+1 unit", "+3 units", "+4 more"]);
});

test("serverFacts: the second line of a server, in order, only what is known", () => {
  const visual = { state: "unreachable", title: "No reading from PDU 07" };
  const facts = serverFacts({ visual, owner: "Hardware team", kvm: { kvmName: "KVM 01", port: 3 }, sw: { switch: "SW-1", port: 12 },
    feeds: [{ pduName: "PDU 01", outlet: 3, state: "on" }, { pduName: "PDU 02", outlet: 3, state: "off" }] });
  assert.deepEqual(facts.map(f => f.key), ["reading", "owner", "kvm", "switch", "feeds"]);
  assert.deepEqual(facts.map(f => f.text), ["No reading from PDU 07", "Hardware team", "KVM 01 · port 3", "SW-1:12", "PDU 01 · 3, PDU 02 · 3"]);
  assert.equal(facts[4].title, "PDU 01 outlet 3 (on), PDU 02 outlet 3 (off)");
  assert.deepEqual(serverFacts({ visual: { state: "on", title: "Outlet 1 is on" } }), [], "an ON server with nothing else known has no facts");
  assert.deepEqual(serverFacts().map(f => f.key), []);
  assert.deepEqual(serverFacts({ sw: { switch: "SW-2" } }).map(f => f.text), ["SW-2"]);
});

test("storage typing: every rack whose type is Storage has 16 shelves, by type and not by name", () => {
  const stats = [{ rack: "Rack-01", rackType: "compute" }, { rack: "Storage shelf", rackType: "storage" }, { rack: "Storage-Main", rackType: "compute" }, { rack: "Cold room", rackType: "storage" }];
  assert.deepEqual(storageRackNames(stats), ["Storage shelf", "Storage-Main", "Cold room"], "Main storage always; the others by their type");
  try {
    setStorageRacks(storageRackNames(stats));
    assert.deepEqual(["Rack-01", "Storage shelf", "Cold room", "Storage-Main", null].map(floorsFor), [4, 16, 16, 16, 4]);
    assert.deepEqual(["Rack-01", "Storage shelf"].map(isStorageRack), [false, true]);
    assert.deepEqual([placeWord("Storage shelf"), placesWord("Storage shelf"), placeWord("Rack-01")], ["shelf", "shelves", "floor"]);
    assert.deepEqual([1, 4, 5, 16, 17].map(u => validFloor(u, "Storage shelf")), [true, true, true, true, false]);
    assert.deepEqual([4, 5].map(u => validPlace(u, "Storage shelf")), [true, true], "the cooling dialog offers shelves 1-16 there");
    const options = floorOptions([], {}, "Storage shelf");
    assert.equal(options.length, 17, "cooling dialog: not on a shelf + shelves 1-16");
    assert.match(options[0].label, /Not on a shelf/);
    assert.match(options[16].label, /^Shelf 16 · empty$/);
    assert.equal(describeFloor({ rack: "Storage shelf", u: 12 }), "Shelf 12");
    assert.deepEqual([floorText(7, "Storage shelf"), floorText(0, "Storage shelf"), placeText({ rack: "Storage shelf", u: 7 }, "OPT1")],
      ["shelf 7", "whole storage", "Storage shelf · shelf 7"], "the scan dialog names its shelves");
    // A rack whose type changed back to compute has floors again; Main storage always has shelves.
    setStorageRacks(storageRackNames([{ rack: "Storage shelf", rackType: "compute" }]));
    assert.deepEqual([floorsFor("Storage shelf"), rackHasFloors("Storage shelf"), floorsFor("Storage-Main")], [4, true, 16]);
  } finally { setStorageRacks([]); }
});
