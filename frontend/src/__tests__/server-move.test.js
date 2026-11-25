// The server window's place dialogs (WP-1): the pure move model (server/moveModel.js) and the wiring of
// PlaceActions, MoveDialog, PortsMoveDialog and ClearLocationDialog, read as source text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  defaultFloor, feedDefaults, firstFreeFloor, floorKvmPort, floorPorts, freeKvmPorts, kvmDefault, matchServers, moveBody,
  moveDataKey, moveError, moveRacks, moveServers, moveSummary, movedPlaces, occupants, ownPorts, pickable, rackKvms,
  resultLines, serverPlaceText, switchChanges, switchLine, switchText, undoBody, whereText,
} from "../server/moveModel.js";
import { freeOutlets } from "../components/racks/serverMove.js";
import { setStorageRacks } from "../components/racks/floors.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// The one-place fixture, as GET /api/devices/locations answers it (a part of it).
const pdu = (id, n, label) => ({ device_id: id, device_name: `PDU 0${id.slice(3)}`, port: String(n), label });
const kvmPort = (id, n, label) => ({ device_id: id, device_name: `KVM 0${id.slice(3)}`, port: String(n), label });
const LOCATIONS = {
  servers: [
    { key: "opt11", name: "OPT11", rack: "Rack-01", slot: null, pdu: [pdu("pdu1", 1, "OPT11")], kvm: [kvmPort("kvm1", 1, "OPT11")],
      dcim_ids: ["opt11"], drawn: { rack: "Rack-01", u: 1, auto: true }, removed: false },
    { key: "opt13", name: "OPT13", rack: "Rack-01", slot: null, pdu: [pdu("pdu1", 3, "OPT13")], kvm: [],
      dcim_ids: ["opt13"], drawn: { rack: "Rack-01", u: 3, auto: true }, removed: false },
    { key: "opt51", name: "OPT51", rack: "Rack-05", slot: 1, pdu: [pdu("pdu5", 1, "OPT51")], kvm: [],
      dcim_ids: ["opt51"], drawn: { rack: "Rack-05", u: 1, auto: false }, removed: false },
    { key: "opt53", name: "OPT53", rack: "Rack-05", slot: 3, pdu: [pdu("pdu5", 3, "OPT53 (PSU1)"), pdu("pdu5", 4, "OPT53 (PSU2)")], kvm: [],
      dcim_ids: ["opt53 (psu1)", "opt53 (psu2)"], drawn: { rack: "Rack-05", u: 3, auto: false }, removed: false },
    { key: "opt61", name: "OPT61", rack: "Rack-06", slot: 1, pdu: [pdu("pdu6", 1, "OPT61")], kvm: [], dcim_ids: ["opt61"], drawn: { rack: "Rack-06", u: 1, auto: false }, removed: false },
    { key: "opt62", name: "OPT62", rack: "Rack-06", slot: 1, pdu: [pdu("pdu6", 2, "OPT62")], kvm: [], dcim_ids: ["opt62"], drawn: { rack: "Rack-06", u: 1, auto: false }, removed: false },
    { key: "opt74", name: "OPT74", rack: "Rack-07", slot: null, pdu: [pdu("pdu7", 4, "OPT74")], kvm: [], dcim_ids: ["opt74"], drawn: null, removed: true },
    { key: "opt90", name: "OPT90", rack: "Rack-02", slot: null, pdu: [], kvm: [kvmPort("kvm2", 2, "OPT90")], dcim_ids: ["opt90"], drawn: null, removed: false },
    { key: "opt96", name: "OPT96", rack: null, slot: null, pdu: [], kvm: [], dcim_ids: ["opt96"], drawn: null, removed: false },
  ],
  empty_ports: { pdu: [{ device_id: "pdu5", device_name: "PDU 05", port: "2" }], kvm: [{ device_id: "kvm2", device_name: "KVM 02", port: "3" }, { device_id: "kvm2", device_name: "KVM 02", port: "4" }] },
  racks: ["Rack-01", "Rack-02", "Rack-05", "Rack-06", "Rack-07", "Rack-10", "Storage-Main"],
};
const DEVICES = [
  { id: "pdu1", kind: "pdu", name: "PDU 01", rack: "Rack-01", port_count: 4, labels: { 1: "OPT11", 2: "OPT12", 3: "OPT13", 4: "OPT14" }, labels_revision: "a1" },
  { id: "pdu5", kind: "pdu", name: "PDU 05", rack: "Rack-05", port_count: 4, labels: { 1: "OPT51", 2: "Spare", 3: "OPT53 (PSU1)", 4: "OPT53 (PSU2)" }, labels_revision: "a5" },
  { id: "kvm2", kind: "kvm", name: "KVM 02", rack: "Rack-02", port_count: 4, labels: { 1: "OPT21", 2: "OPT90", 3: "Spare" }, labels_revision: "k2" },
  { id: "kvm9", kind: "kvm", name: "KVM 09", rack: "Rack-09", notes: "shared:Rack-02", port_count: 2, labels: {}, labels_revision: "k9" },
];
const servers = moveServers(LOCATIONS);
const row = key => servers.find(s => s.key === key);
// A window record (serverRecord.buildRecord) has the same port fields the model reads.
const record = key => ({ ...row(key), pdu: row(key).pdu, kvm: row(key).kvm });

test("servers and floors come from /locations alone: drawn floors, removed servers never offered", () => {
  assert.deepEqual(servers.map(s => s.key), ["opt11", "opt13", "opt51", "opt53", "opt61", "opt62", "opt74", "opt90", "opt96"]);
  assert.equal(row("opt74").removed, true);
  assert.equal(moveServers(LOCATIONS, new Set(["opt13"])).find(s => s.key === "opt13").removed, true, "a hidden key counts as removed");
  assert.deepEqual(pickable(servers, "opt11").map(s => s.key).includes("opt74"), false);
  assert.deepEqual(occupants(servers, "Rack-06", 1), [{ key: "opt61", name: "OPT61" }, { key: "opt62", name: "OPT62" }], "a shared floor");
  assert.deepEqual(occupants(servers, "Rack-01", 3, "opt11"), [{ key: "opt13", name: "OPT13" }]);
  assert.deepEqual(occupants(servers, "Rack-07", null), [], "a removed server is never drawn");
  assert.equal(firstFreeFloor(servers, "Rack-05", "opt11"), 2);
  assert.equal(firstFreeFloor(servers, "Rack-01", "opt11"), 1, "its own floor counts as free for itself");
  assert.equal(defaultFloor(servers, "Rack-05", record("opt11")), 2, "Move to… starts on the first free floor");
  assert.equal(defaultFloor(servers, "Rack-01", record("opt11")), 2, "never its own floor");
  const full = [1, 2, 3, 4].map(u => ({ key: `opt9${u}`, name: `OPT9${u}`, drawn: { rack: "Rack-09", u, auto: false }, removed: false }));
  assert.equal(defaultFloor(full, "Rack-09", full[0]), 2, "every other floor taken: the first other one (a swap, previewed first)");
  assert.equal(defaultFloor(servers, "Rack-06", record("opt61")), 2, "the floor it shares is not free");
  assert.deepEqual(moveRacks(LOCATIONS), ["Rack-01", "Rack-02", "Rack-05", "Rack-06", "Rack-07", "Rack-10", "Storage-Main"]);
});

test("places read as floors and shelves", () => {
  setStorageRacks(["Storage shelf"]);
  assert.equal(whereText({ rack: "Rack-05", slot: 2 }), "Rack-05 · floor 2");
  assert.equal(whereText({ rack: "Storage-Main", slot: 9 }), "Storage-Main · shelf 9");
  assert.equal(whereText({ rack: "Rack-01", slot: 7 }), "Rack-01 · U 7");
  assert.equal(whereText({ rack: "Rack-02", slot: null }), "Rack-02");
  assert.equal(whereText(null), "not on a rack");
  assert.equal(serverPlaceText(row("opt11")), "Rack-01 · floor 1");
  assert.equal(serverPlaceText(row("opt90")), "Rack-02 · not drawn");
  assert.equal(serverPlaceText(row("opt96")), "not on a rack");
});

test("the Swap with picker: exact name first, then names that start with it; never itself or a removed server", () => {
  assert.deepEqual(matchServers(servers, "OPT13", "opt11").map(s => s.name), ["OPT13"]);
  assert.deepEqual(matchServers(servers, "opt1", "opt11").map(s => s.name), ["OPT13"], "not itself");
  assert.deepEqual(matchServers(servers, "OPT7", "opt11"), [], "OPT74 was removed: it is in no picker");
  assert.deepEqual(matchServers(servers, "6", "opt11").map(s => s.name), ["OPT61", "OPT62", "OPT96"]);
  assert.deepEqual(matchServers(servers, "opt5", null).map(s => s.name), ["OPT51", "OPT53"]);
  assert.equal(matchServers(servers, "", "opt11", 3).length, 3);
});

test("an empty floor: the Spare outlet with the floor's number is preselected, an unlabelled floor keeps its outlet", () => {
  const pdus = DEVICES.filter(d => d.kind === "pdu");
  const free = freeOutlets(pdus, "Rack-05", LOCATIONS.empty_ports.pdu);
  assert.deepEqual(free.map(o => `${o.pduId}:${o.outlet}:${o.label}`), ["pdu5:2:Spare"]);
  assert.deepEqual(feedDefaults(record("opt11"), free, 2), ["pdu5:2"], "Spare on outlet 2 feeds floor 2");
  assert.deepEqual(feedDefaults(record("opt11"), free, 4), ["keep"], "floor 4 has no outlet of its own: keep");
  assert.deepEqual(feedDefaults(record("opt53"), free, 4), ["keep", "keep"], "two feeds, both kept by default");
  assert.deepEqual(feedDefaults(record("opt53"), free, 2), ["pdu5:2", "keep"], "only feed 1 takes the floor's outlet; feed 2 is never dropped");
  assert.deepEqual(feedDefaults(record("opt90"), free, 4), ["none"], "a KVM-only server: no PDU outlet unless chosen");
  assert.deepEqual(feedDefaults(record("opt90"), free, 2), ["pdu5:2"]);
});

test("an empty floor: the KVM port is a choice (keep, a free port of the rack's KVMs, none)", () => {
  assert.deepEqual(rackKvms(DEVICES, "Rack-02").map(k => k.id), ["kvm2", "kvm9"], "its own KVM and one shared with it");
  const free = freeKvmPorts(DEVICES, "Rack-02", LOCATIONS.empty_ports.kvm);
  assert.deepEqual(free.map(p => `${p.kvmId}:${p.port}:${p.label}`), ["kvm2:3:Spare", "kvm2:4:"], "kvm9 ports are not empty on /locations");
  assert.deepEqual(floorKvmPort(free, 3), free[0], "the one placeholder port with the floor's number");
  assert.equal(floorKvmPort(free, 4), null, "an unlabelled port is a guess");
  assert.equal(kvmDefault(record("opt11"), free, 4), "keep");
  assert.equal(kvmDefault(record("opt11"), free, 3), "kvm2:3");
  assert.equal(kvmDefault(record("opt51"), [], 4), "none");
});

test("the ports after a move onto an empty floor; none at all, or one outlet twice, is refused before any request", () => {
  assert.deepEqual(floorPorts(record("opt11"), ["pdu5:2"], "keep"), { ports: [{ device_id: "pdu5", port: "2" }, { device_id: "kvm1", port: "1" }], error: "", noPdu: false });
  assert.deepEqual(floorPorts(record("opt53"), ["keep", "drop"], "none").ports, [{ device_id: "pdu5", port: "3" }]);
  const kvmOnly = floorPorts(record("opt90"), ["none"], "keep");
  assert.equal(kvmOnly.noPdu, true, "no PDU outlet: Racks will not draw it");
  assert.deepEqual(kvmOnly.ports, [{ device_id: "kvm2", port: "2" }]);
  assert.match(floorPorts(record("opt96"), ["none"], "none").error, /at least one/);
  assert.match(floorPorts(record("opt53"), ["pdu5:2", "pdu5:2"], "none").error, /twice/);
});

test("move-server bodies: swap, take over, move and pin, each with units_follow", () => {
  assert.deepEqual(moveBody({ mode: "swap", record: record("opt11"), other: "OPT13" }), { server: "OPT11", target_server: "OPT13", swap: true, units_follow: true });
  assert.deepEqual(moveBody({ mode: "takeover", record: record("opt96"), other: "OPT13", unitsFollow: false }), { server: "OPT96", target_server: "OPT13", swap: false, units_follow: false });
  assert.equal(moveBody({ mode: "swap", record: record("opt11") }), null, "no server picked yet");
  assert.deepEqual(moveBody({ mode: "move", record: record("opt11"), rack: "Rack-05", u: 2, ports: [{ device_id: "pdu5", port: 2 }] }),
    { server: "OPT11", target_ports: [{ device_id: "pdu5", port: "2" }], target_rack: "Rack-05", target_slot: 2, swap: false, units_follow: true });
  assert.equal(moveBody({ mode: "move", record: record("opt11"), rack: "Rack-05", u: 2, ports: [] }), null);
  assert.deepEqual(moveBody({ mode: "pin", record: record("opt11") }),
    { server: "OPT11", target_ports: ownPorts(record("opt11")), target_rack: "Rack-01", target_slot: 1, swap: false, units_follow: true }, "its own ports, rack and floor");
  assert.equal(moveBody({ mode: "pin", record: record("opt90") }), null, "a server that is not drawn has no floor to pin");
});

test("Undo: a swap is the same swap; a move goes back to its ports and floor; a take-over and a pin have none", () => {
  const swap = moveBody({ mode: "swap", record: record("opt11"), other: "OPT13" });
  assert.deepEqual(undoBody("swap", record("opt11"), swap), swap);
  const move = moveBody({ mode: "move", record: record("opt11"), rack: "Rack-05", u: 2, ports: [{ device_id: "pdu5", port: "2" }, { device_id: "kvm1", port: "1" }] });
  assert.deepEqual(undoBody("move", record("opt11"), move), { server: "OPT11", target_ports: [{ device_id: "pdu1", port: "1" }, { device_id: "kvm1", port: "1" }],
    target_rack: "Rack-01", target_slot: 1, swap: false, units_follow: true });
  assert.deepEqual(undoBody("move", record("opt90"), move), { server: "OPT90", target_ports: [{ device_id: "kvm2", port: "2" }], target_rack: "Rack-02", swap: false, units_follow: true },
    "a server that was not drawn goes back to its rack");
  assert.equal(undoBody("move", record("opt96"), move), null, "it had no port to go back to");
  assert.equal(undoBody("takeover", record("opt11"), swap), null);
  assert.equal(undoBody("pin", record("opt11"), swap), null);
});

test("a preview is tied to the lab data: /locations, the rack-items ETag and every PDU/KVM labels_revision", () => {
  const key = moveDataKey(LOCATIONS, "etag-1", DEVICES);
  assert.equal(moveDataKey(structuredClone(LOCATIONS), "etag-1", structuredClone(DEVICES)), key, "the same data, the same key");
  assert.notEqual(moveDataKey(LOCATIONS, "etag-2", DEVICES), key, "a unit saved elsewhere");
  assert.notEqual(moveDataKey(LOCATIONS, "etag-1", DEVICES.map(d => (d.id === "kvm2" ? { ...d, labels_revision: "k3" } : d))), key, "a KVM label saved elsewhere");
  const moved = structuredClone(LOCATIONS);
  moved.servers[0].drawn.u = 4;
  assert.notEqual(moveDataKey(moved, "etag-1", DEVICES), key, "a server moved elsewhere");
});

test("the preview and the Last change panel: labels, places, unplaced, units and switch ports", () => {
  const plan = {
    changes: [{ device_id: "pdu1", device_name: "PDU 01", kind: "pdu", port: "1", before: "OPT11", after: "OPT13" },
      { device_id: "kvm1", device_name: "KVM 01", kind: "kvm", port: "1", before: "OPT11", after: "OPT13" }],
    positions: [{ server: "OPT11", before: { rack: "Rack-01", slot: 1 }, after: { rack: "Rack-01", slot: 3 } },
      { server: "OPT13", before: { rack: "Rack-01", slot: 3 }, after: { rack: "Rack-01", slot: 3 } }],
    unplaced: ["OPT23"],
    units: [{ server: "OPT12", from: { rack: "Rack-01", slot: 2 }, to: { rack: "Rack-01", slot: 4 }, units: [{ id: "ci-1", name: "Switch 01" }] }],
    switch: [{ server: "OPT11", before: { switch: "SW-01", port: "1" }, after: null }, { server: "OPT13", before: null, after: null }],
  };
  assert.deepEqual(movedPlaces(plan).map(p => p.server), ["OPT11"], "a place that does not change is not listed");
  assert.deepEqual(switchChanges(plan).map(switchLine), ["OPT11: SW-01 port 1 → none"]);
  assert.equal(switchText({ switch: "SW-05", port: "" }), "SW-05");
  assert.deepEqual(resultLines(plan), [
    "PDU 01 outlet 1: OPT11 → OPT13", "KVM 01 port 1: OPT11 → OPT13", "OPT11: Rack-01 · floor 1 → Rack-01 · floor 3",
    "OPT23 becomes unplaced", "Moved: Switch 01 with OPT12: Rack-01 · floor 2 → Rack-01 · floor 4", "Switch OPT11: SW-01 port 1 → none",
  ]);
  assert.equal(moveSummary("swap", { name: "OPT11" }, "OPT13"), "OPT11 and OPT13 swapped places.");
  assert.equal(moveSummary("move", { name: "OPT11" }, null, { rack: "Rack-05", slot: 2 }), "OPT11 moved to Rack-05 · floor 2.");
  assert.equal(moveSummary("pin", { name: "OPT41" }, null, { rack: "Rack-04", slot: 1 }), "OPT41 is pinned to Rack-04 · floor 1.");
  assert.match(moveSummary("takeover", { name: "OPT96" }, "OPT63"), /OPT63 is unplaced now/);
});

test("a refused save says so in one line", () => {
  assert.match(moveError({ status: 409, detail: "Changed since the preview. Preview again." }), /changed in another session meanwhile, so nothing was saved/);
  assert.equal(moveError({ status: 409, detail: "OPT74 was removed from the lab. Restore it first." }), "OPT74 was removed from the lab. Restore it first.");
  assert.match(moveError({ status: 403 }), /Operator or Admin/);
  assert.match(moveError({}), /connection/);
});

// ── the wiring ──

test("PlaceActions: Swap with… and Move to… in the bar; Pin (auto only), Take over, Choose ports, Clear location in More", () => {
  const source = read("../server/PlaceActions.jsx");
  assert.match(source, /export default \{ Bar, more, Dialogs, dialogTypes: \["move", "ports", "clear"\] \}/);
  assert.match(source, />Swap with…</);
  assert.match(source, />Move to…</);
  for (const label of ["Take over a place…", "Choose ports…", "Clear location…"]) assert.ok(source.includes(`"${label}"`), label);
  assert.match(source, /d\?\.auto && validFloor\(d\.u, d\.rack\)/, "Pin only for an auto-placed server on a floor");
  // The order of More (CONTRACT.md 5.3): Pin, Take over, Choose ports, Clear location.
  const order = ["\"pin\"", "\"take-over\"", "\"choose-ports\"", "\"clear-location\""].map(id => source.indexOf(`id: ${id}`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every(i => i > 0));
});

test("the dialogs: their own focus, above the window, named for tests; every save is a previewed move-server or clear-server", () => {
  const dialogs = { "../server/MoveDialog.jsx": "server-move", "../server/PortsMoveDialog.jsx": "ports-move", "../server/ClearLocationDialog.jsx": "clear-location" };
  for (const [file, name] of Object.entries(dialogs)) {
    const source = read(file);
    assert.match(source, /useDialogFocus\(panelRef/, `${file} uses useDialogFocus`);
    assert.match(source, /z-\[60\]/, `${file} sits above the window (z-[60])`);
    assert.ok(source.includes(`data-dialog="${name}"`), `${file} is data-dialog="${name}"`);
    assert.match(source, /act\.during\(/, `${file} saves inside act.during`);
    assert.doesNotMatch(source, /pokeChanges|setDirectLabel|direct-label|saveLayout\(|rack_items:/, `${file} writes nothing else`);
  }
  const move = read("../server/MoveDialog.jsx");
  assert.match(move, /api\.moveServer\(\{ \.\.\.JSON\.parse\(bodyKey\), dry_run: true \}\)/, "the preview is the server's dry run");
  assert.match(move, /dry_run: false, plan_revision: planned\.plan_revision/, "Apply sends the preview's plan revision");
  assert.match(move, /Move the units on this floor with the server/);
  assert.match(move, /Moves with it/);
  assert.match(move, /Which PDU outlet feeds/);
  assert.match(move, /Which KVM port serves/);
  assert.match(move, /Without a PDU outlet/);
  assert.match(move, /Drop this feed/);
  assert.match(move, /check it under Consoles or Power and fix the label there/);
  assert.match(move, /\$\{bodyKey\}\|\$\{dataKey\}\|\$\{again\}/, "a newer data key or a refused save previews again");
  assert.match(move, /Take over — \$\{victim\} loses its outlet and port/);
  assert.match(move, /No server moves\./, "a pin says what it does: no server moves (move-server pins the rack's auto-placed servers too)");
  assert.match(move, /feeds && validFeed\(feeds\[i\], i\) \? feeds\[i\] : d/, "a chosen outlet taken elsewhere falls back to the floor's default");
  assert.match(move, /data-stale-choice/);
  const clear = read("../server/ClearLocationDialog.jsx");
  assert.match(clear, /previewClear\(record\.name\)/);
  assert.match(clear, /clearServer\(record\.name, planned\.planRevision\)/, "one clear-server request with the plan revision");
  assert.match(clear, /It is no longer drawn on Racks; its saved rack place is kept for a later move\./);
  const ports = read("../server/PortsMoveDialog.jsx");
  assert.match(ports, /buildMoveRequest\(server, draft, true, \{ maxSlot: 999 \}\)/, "Choose ports takes a U up to 999");
  assert.match(ports, /act\.openMove\(\{ mode: "swap", swapWith: slotOwner\.name \}\)/, "a taken slot is offered as a swap");
});

test("Racks has no move dialog of its own any more (WP-5): a drag opens the server window's MoveDialog", () => {
  assert.doesNotMatch(read("../pages/DcimView.jsx"), /ServerMoveDialog|api\.moveServer/);
  assert.match(read("../pages/DcimView.jsx"), /sec: "move"/);
  assert.doesNotMatch(read("../server/MoveDialog.jsx"), /ServerMoveDialog/);
});
