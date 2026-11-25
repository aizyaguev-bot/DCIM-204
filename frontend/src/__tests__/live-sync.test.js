import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLiveReload } from "../api/liveReload.js";
import {
  unitFloor, unitsOnFloor, serversOnFloor, swapMoves, firstFreeFloor,
  placeText, unitNames, isFreeOutletLabel, rackPdus, freeOutlets, floorOutlet, moveServerBody,
  labelChangeText, unitsConflict, uncheckedText, takesOverText,
} from "../components/racks/serverMove.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// ── createLiveReload: one reload at a time, nothing during a save, one more reload for whatever arrived meanwhile ──

test("live reload: a change reloads once with its domains", async () => {
  const runs = [];
  const live = createLiveReload(async domains => { runs.push(domains); });
  live.trigger(["layout"]);
  await tick(); await tick();
  assert.deepEqual(runs, [["layout"]]);
});

test("live reload: changes during a reload are coalesced into exactly one more reload", async () => {
  const runs = [];
  const gate = deferred();
  const live = createLiveReload(async domains => { runs.push(domains); if (runs.length === 1) await gate.promise; });
  live.trigger(["layout"]);
  await tick();
  live.trigger(["owners"]); live.trigger(["inventory"]); live.trigger(["owners"]);
  assert.equal(runs.length, 1, "nothing starts while a reload runs");
  gate.resolve();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].sort(), ["inventory", "owners"]);
});

test("live reload: nothing reloads while a save of the view runs; one reload follows it", async () => {
  const runs = [];
  const live = createLiveReload(async domains => { runs.push(domains); });
  const save = deferred();
  const saving = live.during(() => save.promise);
  live.trigger(["layout"]); live.trigger(["inventory"]);
  await tick();
  assert.equal(runs.length, 0, "held while the save runs");
  assert.equal(live.pending(), true);
  save.resolve("saved");
  assert.equal(await saving, "saved");
  await tick(); await tick();
  assert.deepEqual(runs.map(d => d.sort()), [["inventory", "layout"]]);
});

test("live reload: a failed save or reload never stops later reloads", async () => {
  let n = 0;
  const live = createLiveReload(async () => { n++; if (n === 1) throw new Error("offline"); });
  await assert.rejects(live.during(async () => { throw new Error("refused"); }), /refused/);
  live.trigger(["layout"]);
  await tick(); await tick();
  live.trigger(["layout"]);
  await tick(); await tick();
  assert.equal(n, 2);
});

test("live reload: isBlocked holds a change until flush", async () => {
  let blocked = true;
  const runs = [];
  const live = createLiveReload(async d => { runs.push(d); }, { isBlocked: () => blocked });
  live.trigger(["inventory"]);
  await tick();
  assert.equal(runs.length, 0);
  blocked = false;
  live.flush();
  await tick(); await tick();
  assert.deepEqual(runs, [["inventory"]]);
});

// ── serverMove.js: which units move, swap pairs, the documents written ──

const floor = (rack, u) => Number.isInteger(u) && u >= 1 && u <= (rack === "Storage shelf" ? 16 : 4);
// Rack-01: OPT11 floor 1 (saved), OPT12 floor 2 (auto), OPT13 floor 3 (auto); Rack-02: OPT21 floor 1, OPT22 floor 4.
const placements = {
  opt11: { rack: "Rack-01", u: 1, auto: false },
  opt12: { rack: "Rack-01", u: 2, auto: true },
  opt13: { rack: "Rack-01", u: 3, auto: true },
  opt21: { rack: "Rack-02", u: 1, auto: false },
  opt22: { rack: "Rack-02", u: 4, auto: false },
};
const items = {
  "Rack-01": [
    { id: "sw1", name: "Switch 01", u: 2, serial_number: "SN1", barcode: "B1", shelf_position: "left", tracking_history: [{ at: "x" }] },
    { id: "nic1", name: "NIC 1", u: 2 },
    { id: "lvl", name: "Rack-level PDU", u: 0 },
    { id: "f3", name: "Patch 3", u: "3" },
  ],
  "Rack-02": [{ id: "sw2", name: "Switch 02", u: 1 }],
};

test("unitFloor and unitsOnFloor read a unit's floor like the rack card (old string U, rack level never a floor)", () => {
  assert.equal(unitFloor({ u: 3 }), 3);
  assert.equal(unitFloor({ u: "3" }), 3);
  assert.equal(unitFloor({ u: 99 }), 0);
  assert.equal(unitFloor({ u: "x" }), 0);
  assert.equal(unitFloor({}), 0);
  assert.deepEqual(unitsOnFloor(items, "Rack-01", 2).map(i => i.id), ["sw1", "nic1"]);
  assert.deepEqual(unitsOnFloor(items, "Rack-01", 3).map(i => i.id), ["f3"]);
  assert.deepEqual(unitsOnFloor(items, "Rack-01", 0), [], "the rack level is no floor");
  assert.deepEqual(unitsOnFloor(items, "Rack-09", 1), []);
  assert.deepEqual(serversOnFloor(placements, "Rack-01", 2), ["opt12"]);
});

test("swapMoves: each server takes the other's place; none without a place", () => {
  assert.deepEqual(swapMoves("opt12", "opt21", placements), [
    { id: "opt12", toRack: "Rack-02", toU: 1 }, { id: "opt21", toRack: "Rack-01", toU: 2 },
  ]);
  assert.equal(swapMoves("opt12", "opt12", placements), null);
  assert.equal(swapMoves("opt12", "nope", placements), null);
  assert.equal(swapMoves("opt12", "opt99", { ...placements, opt99: { rack: "Rack-01", u: null } }), null);
});

// unitsMovingWith, applyUnitMoves, moveWithUnits and portsAfterMove were removed with Racks' own move dialog (one-place
// WP-5): the server window's MoveDialog sends units_follow and the server moves the units (backend/tests/test_devices.py).

test("unitsConflict: only the server's 'units changed' 409 is worth sending again", () => {
  assert.equal(unitsConflict({ status: 409, detail: "The units on these floors were changed in another session. Nothing was moved; check the move and confirm again." }), true);
  assert.equal(unitsConflict({ status: 409, detail: "Changed since the preview. Preview again." }), false);
  assert.equal(unitsConflict({ status: 422, detail: "The units on these floors were changed in another session." }), false);
  assert.equal(unitsConflict(null), false);
});

// ── the PDU outlet and KVM port belong to the floor (the owner's correction, 2026-11-10) ──

const pdus = [
  { id: "pdu1", kind: "pdu", name: "PDU 01", rack: "Rack-01", port_count: 6, labels: { 1: "OPT11", 2: "OPT12", 3: "KVM Power", 4: "empty", 5: "Outlet 5" } },
  { id: "pdu9", kind: "pdu", name: "PDU 09", rack: "Rack-09", notes: "shared:Rack-01, x", port_count: 2, labels: { 1: "spare", 2: "OPT91" } },
  { id: "pdu2", kind: "pdu", name: "PDU 02", rack: "Rack-02", port_count: 2, labels: { 1: "empty", 2: "empty" } },
  { id: "rack1", kind: "rack", name: "Rack 01", rack: "Rack-01", labels: {} },
];

test("free outlets: blank, default or placeholder labels on the rack's own and shared PDUs; KVM Power is never free", () => {
  assert.deepEqual(rackPdus(pdus, "Rack-01").map(p => p.id), ["pdu1", "pdu9"]);
  for (const label of ["", "Outlet 5", "port 2", "empty", "Spare", "free", "n/a", "--"]) assert.equal(isFreeOutletLabel(label), true, label);
  for (const label of ["KVM Power", "PDU", "OPT11", "Optn45 (PSU1)"]) assert.equal(isFreeOutletLabel(label), false, label);
  assert.deepEqual(freeOutlets(pdus, "Rack-01").map(o => `${o.pduId}:${o.outlet}:${o.label}`), ["pdu1:4:empty", "pdu1:5:Outlet 5", "pdu1:6:", "pdu9:1:spare"]);
  // the server's own list of empty ports wins: an outlet that names a server on the device itself is not free
  const empty = [{ device_id: "pdu1", port: "4" }, { device_id: "pdu1", port: "6" }];
  assert.deepEqual(freeOutlets(pdus, "Rack-01", empty).map(o => `${o.pduId}:${o.outlet}`), ["pdu1:4", "pdu1:6"]);
  assert.deepEqual(freeOutlets(pdus, "Rack-07"), []);
});

test("floorOutlet: the outlet labelled free for that floor when the PDU says so, else null (the dialog asks)", () => {
  const free01 = freeOutlets(pdus, "Rack-01");
  assert.equal(floorOutlet(free01, 4)?.outlet, 4, "an 'empty' outlet with the floor's number");
  assert.equal(floorOutlet(free01, 2), null, "two outlets are labelled free (pdu1 4 'empty', pdu9 1 'spare'), none with number 2");
  const only = free01.filter(o => o.pduId === "pdu9");
  assert.equal(floorOutlet(only, 3), null, "the only outlet labelled free, but number 1: says nothing about floor 3 (QA 2026-11-10)");
  assert.deepEqual(floorOutlet(only, 1), only[0], "the same outlet for floor 1");
  assert.equal(floorOutlet(free01.filter(o => o.label === "" || /^Outlet/.test(o.label)), 1), null, "default names say nothing about a floor");
  assert.equal(floorOutlet(freeOutlets(pdus, "Rack-02"), 2)?.outlet, 2);
  assert.equal(floorOutlet([...freeOutlets(pdus, "Rack-02"), { pduId: "pdu8", pduName: "PDU 08", outlet: 2, label: "empty" }], 2), null,
    "two PDUs label outlet 2 free: which one feeds the floor is not known");
  // QA's case: PDU 02 {1: Spare, 2: OPT22, 3: OPT23, 4: OPT24}: only floor 1 gets outlet 1 without asking.
  const spare = [{ pduId: "pdu2", pduName: "PDU 02", outlet: 1, label: "Spare" }];
  assert.deepEqual([1, 2, 3, 4].map(floor => floorOutlet(spare, floor)?.outlet ?? null), [1, null, null, null]);
});

test("uncheckedText and takesOverText", () => {
  assert.equal(uncheckedText([{ device_id: "kvm1", device_name: "KVM 01", kind: "kvm", ports: ["2", "3", "4"] }]), "KVM 01 ports 2, 3 and 4");
  assert.equal(uncheckedText([{ device_id: "pdu5", kind: "pdu", ports: ["7"] }, { device_name: "KVM 02", kind: "kvm", ports: ["1", "2"] }]),
    "pdu5 outlet 7; KVM 02 ports 1 and 2");
  assert.equal(uncheckedText(null), "");
  assert.equal(takesOverText([{ kind: "pdu" }, { kind: "kvm" }]), "PDU outlet and KVM port");
  assert.equal(takesOverText([{ kind: "pdu" }, { kind: "pdu" }]), "PDU outlet", "no KVM port change: the dialog never claims one");
  assert.equal(takesOverText([{ kind: "kvm" }]), "KVM port");
  assert.equal(takesOverText([]), "");
});

test("moveServerBody: a swap names the other server; a move names the ports, rack and floor", () => {
  assert.deepEqual(moveServerBody({ name: "OPT13", swapWith: "OPT11" }), { server: "OPT13", target_server: "OPT11", swap: true });
  const ports = [{ device_id: "pdu1", port: 3 }, { device_id: "kvm1", port: "3" }];
  assert.deepEqual(moveServerBody({ name: "OPT13", rack: "Storage shelf", floor: 9, ports }), {
    server: "OPT13", target_ports: [{ device_id: "pdu1", port: "3" }, { device_id: "kvm1", port: "3" }], target_rack: "Storage shelf", target_slot: 9, swap: false });
});

test("labelChangeText says which outlet or port gets which server", () => {
  assert.equal(labelChangeText({ device_name: "PDU 01", kind: "pdu", port: "1", before: "OPT11", after: "OPT13" }), "PDU 01 outlet 1: OPT11 → OPT13");
  assert.equal(labelChangeText({ device_name: "KVM 01", kind: "kvm", port: "3", before: null, after: "OPT11" }), "KVM 01 port 3: — → OPT11");
});

test("firstFreeFloor and placeText", () => {
  assert.equal(firstFreeFloor(placements, "Rack-01", 4), 4);
  assert.equal(firstFreeFloor(placements, "Rack-01", 4, ["opt12"]), 2);
  assert.equal(firstFreeFloor(placements, "Rack-01", 3), null);
  assert.equal(firstFreeFloor(placements, "Rack-09", 4), 1);
  assert.equal(placeText("Rack-02", 3), "Rack-02 · floor 3");
  assert.equal(placeText("Rack-02", 0), "Rack-02 · rack level");
  assert.equal(placeText(null, null), "no rack");
});

// ── wiring: the feed starts once in App and the lab display; every view listens; the twin gets each change ──

test("App and the lab display start the change feed; App forwards every change to the 3D twin iframe", () => {
  const app = read("../App.jsx");
  const display = read("../pages/LabDisplay.jsx");
  assert.match(app, /startChangeFeed\(\)/);
  assert.match(display, /startChangeFeed\(\)/);
  assert.match(app, /postMessage\(\{ type: TWIN_DATA_CHANGED_MESSAGE, domains \}, location\.origin\)/);
});

test("Racks moves go through the server window's move dialog: one move-server step with units_follow", () => {
  const view = read("../pages/DcimView.jsx");
  const dialog = read("../server/MoveDialog.jsx");
  // A drag opens the server's window on its move dialog (a swap with the server dropped on, or a move to the rack).
  assert.match(view, /openServer\(key, other \? \{ sec: "move", swapWith: other\.name \} : \{ sec: "move", moveTo: toRack \? \{ rack: toRack \} : null \}\)/);
  assert.doesNotMatch(view, /api\.moveServer|moveWithUnits|rack_items|ServerMoveDialog/, "Racks itself never writes a move");
  assert.doesNotMatch(view, /saveRackLayout|reverseUnitMoves|cleanLayoutKeys/, "no second request that could leave a move half done");
  assert.doesNotMatch(view, /CrossRackMoveModal|onRackOverrideChange|applyServerMoves/, "no move writes the layout alone any more");
  assert.match(dialog, /api\.moveServer\(sent\)/, "the dialog applies the previewed body with its plan revision");
  assert.match(read("../server/moveModel.js"), /units_follow: !!unitsFollow/, "the units go along unless the box is cleared");
});

test("every view that shows servers, racks, units or owners reloads on its domains", () => {
  const listens = {
    "../App.jsx": ["devices", "power", "inventory"],
    "../pages/DcimView.jsx": ["layout", "inventory", "owners", "removed"],
    "../pages/MonitoringView.jsx": ["monitoring", "layout"],
    "../pages/ScanView.jsx": ["inventory"],
    "../pages/LocationsView.jsx": ["layout", "devices"],
    "../pages/ConnectionsView.jsx": ["devices", "owners", "monitoring"],
    "../pages/LabDisplay.jsx": ["layout", "devices"],
    "../engineers.jsx": ["owners"],
    "../removedServers.jsx": ["removed"],
  };
  for (const [file, domains] of Object.entries(listens)) {
    const source = read(file);
    assert.match(source, /use(DataChanged|LiveReload)\(/, `${file} listens to the change feed`);
    for (const domain of domains) assert.ok(source.includes(`"${domain}"`), `${file} listens to ${domain}`);
  }
  assert.doesNotMatch(read("../pages/LabDisplay.jsx"), /OVERRIDES_EVERY/, "rack overrides are read every cycle");
});

// ── the Racks page's reloads: an older, slower layout answer never replaces a newer one (layoutSeq / layoutShown) ──
// reloadLayouts (DcimView.jsx) is run as written, with its refs, setters and fetch stubbed, so answers can arrive in
// any order.
function racksReloads() {
  const view = read("../pages/DcimView.jsx");
  const head = "const reloadLayouts = useCallback(";
  const start = view.indexOf(head), end = view.indexOf("},[]);", start);
  assert.ok(start > 0 && end > start, "reloadLayouts is found in DcimView.jsx");
  const source = view.slice(start + head.length, end + 1);
  const state = { rackOrder: {}, rackSlots: {}, switchAssignments: {}, rackOverrides: {}, optOwners: {}, loadErrors: {}, customItems: {}, chillers: null };
  const setter = name => value => { state[name] = typeof value === "function" ? value(state[name]) : value; };
  const ref = current => ({ current });
  const calls = [];
  const env = {
    editingRef: ref(false), holdItemsRef: ref(false), itemsSeq: ref(0), holdCoolingRef: ref(false), coolingMissed: ref(false),
    coolingSeq: ref(0), ownersSeq: ref(0), layoutSeq: ref(0), layoutShown: ref(0),
    selectedCustomIdRef: ref(null), customItemsRef: ref({}), customDraftRef: ref(null),
    document: { hidden: false },
    fetch: path => { const d = deferred(); calls.push({ path, d }); return d.promise; },
    loadRackItems: () => Promise.resolve({}),
    setCustomPanel: setter("customPanel"), setCustomItems: setter("customItems"), setLoadErrors: setter("loadErrors"),
    setChillers: setter("chillers"), setChillersLoaded: () => {}, setOptOwners: setter("optOwners"), setOwnersLoaded: () => {},
    setRackOrder: setter("rackOrder"), setRackSlots: setter("rackSlots"), setSwitchAssignments: setter("switchAssignments"),
    setRackOverrides: setter("rackOverrides"),
  };
  const reload = new Function(...Object.keys(env), `return ${source};`)(...Object.values(env));
  // Starts a reload and returns its answer(data): data maps a path to its JSON (a path left out fails with HTTP 503).
  function start_(...args) {
    const from = calls.length;
    const done = reload(...args);
    const mine = calls.slice(from);
    return {
      paths: mine.map(c => c.path),
      async answer(data) {
        for (const c of mine) c.d.resolve(c.path in data ? { ok: true, json: async () => data[c.path] } : { ok: false, status: 503 });
        await done;
      },
    };
  }
  return { state, env, start: start_ };
}
const LIVE_LAYOUT = new Set(["layout"]);
const layoutAt = slot => ({ "/api/rack-positions": {}, "/api/rack-slots": { "Rack-01": { opt11: slot } },
  "/api/switch-assignments": {}, "/api/rack-overrides": {} });

test("Racks reloads: a slower periodic reload never puts back an older place over a newer live reload", async () => {
  const { state, start } = racksReloads();
  const periodic = start();                                  // the interval's reload, still on its way
  const live = start(false, false, LIVE_LAYOUT);             // a move saved elsewhere: the change feed's reload
  await live.answer(layoutAt(7));
  assert.deepEqual(state.rackSlots, { "Rack-01": { opt11: 7 } });
  await periodic.answer({ ...layoutAt(3), "/api/opt-owners": {}, "/api/chillers": { units: [], connections: [] } });
  assert.deepEqual(state.rackSlots, { "Rack-01": { opt11: 7 } }, "the older answer is dropped");
  // In order, the newer answer wins as before.
  const first = start(false, false, LIVE_LAYOUT), second = start(false, false, LIVE_LAYOUT);
  await first.answer(layoutAt(4));
  assert.deepEqual(state.rackSlots, { "Rack-01": { opt11: 4 } });
  await second.answer(layoutAt(5));
  assert.deepEqual(state.rackSlots, { "Rack-01": { opt11: 5 } });
  assert.deepEqual(state.loadErrors, {});
});

test("Racks reloads: an answer that is not used does not stop an older one; Edit mode keeps live layout and owners", async () => {
  const { state, env, start } = racksReloads();
  // A later reload whose every layout store failed shows nothing, so the earlier answer still counts.
  const live = start(false, false, LIVE_LAYOUT), failed = start(false, false, LIVE_LAYOUT);
  await failed.answer({});
  assert.equal(state.loadErrors.layout, "HTTP 503");
  await live.answer(layoutAt(6));
  assert.deepEqual(state.rackSlots, { "Rack-01": { opt11: 6 } });
  // A periodic reload overtaken by Edit mode is not used, and does not stop the live reload started before it.
  const liveBefore = start(false, false, LIVE_LAYOUT), periodic = start();
  env.editingRef.current = true;
  await periodic.answer({ ...layoutAt(1), "/api/opt-owners": {} });
  assert.deepEqual(state.rackSlots, { "Rack-01": { opt11: 6 } });
  await liveBefore.answer(layoutAt(8));
  assert.deepEqual(state.rackSlots, { "Rack-01": { opt11: 8 } }, "live reloads apply the layout in Edit mode");
  // In Edit mode the interval's reload leaves the layout alone but still reads the owners (ownersSeq).
  const editing = start();
  assert.ok(!editing.paths.includes("/api/rack-slots") && editing.paths.includes("/api/opt-owners"));
  await editing.answer({ "/api/opt-owners": { opt11: "eng-1" }, "/api/chillers": { units: [], connections: [] } });
  assert.deepEqual(state.optOwners, { opt11: "eng-1" });
  const view = read("../pages/DcimView.jsx");
  assert.match(view, /function _reloadPositions\(\) \{\n\s+return reloadLayouts\(false, true, new Set\(\["layout"\]\)\);/,
    "a label change or rename reads the layout through the same guarded reload");
});
