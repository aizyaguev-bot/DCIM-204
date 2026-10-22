import test from "node:test";
import assert from "node:assert/strict";
import { serverVisualState, rackSummary, withCoolingRows, compactRows, buildSearchIndex, searchIndex, matchesFilter, shelfOptions }
  from "../components/racks/rackView.js";

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

test("shelfOptions: 43 choices, rack level first, names on each shelf, +N", () => {
  const rows = [row(1, ["OPT41"]), row(2, ["OPT42", "Switch 04", "Patch", "KVM"]), row(3), row(0, ["Rack PDU"], "custom")];
  const options = shelfOptions(rows, 42, { 3: [{ name: "Cooling" }] });
  assert.equal(options.length, 43);
  assert.deepEqual(options[0], { value: "", label: "Not on a shelf (rack level)" });
  assert.deepEqual(options[1], { value: "1", label: "U01 · OPT41" });
  assert.equal(options[2].label, "U02 · OPT42, Switch 04 +2");
  assert.equal(options[3].label, "U03 · Cooling");
  assert.equal(options[42].label, "U42 · empty");
});
