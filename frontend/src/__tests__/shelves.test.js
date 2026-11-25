import test from "node:test";
import assert from "node:assert/strict";
import { addServer, addServerBody, conflictBannerText, conflictOf, conflictPowerReason, findSeat, freeShelfCandidates, hasShelfMap,
  isFreePortLabel, loadShelves, normalizePlace, placeConflicts, placePowerBlock, placeText, portKey, portPlace, previewAddServer,
  previewShelfPorts, saveShelfPorts, seatLetter, seatPortsText, serverSeat, shelfError, shelfPortChanges, shelfTag, shelvesAvailable,
  unavailableShelves, withPlaceConflict, UNAVAILABLE_TEXT } from "../api/shelves.js";

// v3 shelves (C:/t/one-place-spec-v3-shelf-ports.md, window/CONTRACT.md §11): the pure helpers and the request helpers of
// api/shelves.js. The UI word is the rack's (floors.js placeWord) until the WP-8 sweep, so texts match floor or shelf.
const W = "(?:floor|shelf)";
const WS = "(?:floors|shelves)";
const re = source => new RegExp(`^${source}$`);

test("seatLetter: 1 -> A … 26 -> Z, 27 -> AA; anything else is no seat", () => {
  assert.deepEqual([1, 2, 3, 26, 27, 28, 52, 53].map(seatLetter), ["A", "B", "C", "Z", "AA", "AB", "AZ", "BA"]);
  assert.equal(seatLetter("2"), "B", "decimal text counts");
  for (const bad of [0, -1, 1.5, "", " ", "x", null, undefined, NaN, {}, true]) assert.equal(seatLetter(bad), "", `${String(bad)} is no seat`);
});

test("normalizePlace and portKey: the API's place, cleaned", () => {
  assert.deepEqual(normalizePlace({ rack: " Rack-05 ", shelf: "3" }), { rack: "Rack-05", shelf: 3, seat: 1 });
  assert.deepEqual(normalizePlace({ rack: "Rack-06", shelf: 1, seat: 2, feed: 0, source: "shelf" }), { rack: "Rack-06", shelf: 1, seat: 2, feed: 0, source: "shelf" });
  assert.deepEqual(normalizePlace({ rack: "Rack-05", shelf: 3, source: "conflict", places: [{ rack: "Rack-05", shelf: 3 }, { rack: "Rack-05", shelf: 4, seat: 1 }, null] }),
    { rack: "Rack-05", shelf: 3, seat: 1, source: "conflict", places: [{ rack: "Rack-05", shelf: 3, seat: 1 }, { rack: "Rack-05", shelf: 4, seat: 1 }] });
  assert.equal(normalizePlace({ rack: "Rack-05", shelf: 3, source: "guess" }).source, undefined, "only shelf and conflict are sources");
  for (const bad of [null, undefined, "Rack-05", { rack: "", shelf: 1 }, { rack: "R", shelf: 0 }, { rack: "R", shelf: 1.5 }, { rack: "R" }]) {
    assert.equal(normalizePlace(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(["3", "03", 3, " 12 ", "A1"].map(portKey), ["3", "3", "3", "12", "A1"]);
});

test("placeText: rack · word shelf, the seat letter only on a shared shelf", () => {
  assert.match(placeText({ rack: "Rack-05", shelf: 3 }), re(`Rack-05 · ${W} 3`));
  assert.match(placeText({ rack: "Rack-05", shelf: 3, seat: 1, source: "shelf" }), re(`Rack-05 · ${W} 3`));
  assert.match(placeText({ rack: "Rack-06", shelf: 1, seat: 2 }), re(`Rack-06 · ${W} 1 · B`));
  assert.match(placeText({ rack: "Rack-06", shelf: 1, seat: 1 }, { seats: 2 }), re(`Rack-06 · ${W} 1 · A`), "seat A of a shared shelf");
  assert.equal(placeText({ rack: "Storage-Main", shelf: 12 }), "Storage-Main · shelf 12", "a storage rack has shelves");
  assert.equal(placeText(null), "");
  assert.equal(placeText({ rack: "Rack-05" }), "");
});

test("shelfTag: R05·S3; a rack without digits keeps its name; a second seat gets its letter", () => {
  assert.equal(shelfTag({ rack: "Rack-05", shelf: 3 }), "R05·S3");
  assert.equal(shelfTag({ rack: "Rack-5", shelf: 3 }), "R5·S3");
  assert.equal(shelfTag({ rack: "Lab2-Rack-07", shelf: 1 }), "R07·S1", "the rack's last number");
  assert.equal(shelfTag({ rack: "Storage-Main", shelf: 12 }), "Storage-Main·S12");
  assert.equal(shelfTag({ rack: "Rack-06", shelf: 1, seat: 2 }), "R06·S1·B");
  assert.equal(shelfTag({ rack: "Rack-06", shelf: 1, seat: 1 }), "R06·S1");
  assert.equal(shelfTag(null), "");
});

test("portPlace: device.places of GET /api/devices, by the port's decimal key", () => {
  const pdu = { id: "pdu5", kind: "pdu", places: { 3: { rack: "Rack-05", shelf: 3, seat: 1, feed: 1 }, 4: { rack: "Rack-05", shelf: 3, feed: 2 },
    7: { rack: "", shelf: 2 } } };
  assert.deepEqual(portPlace(pdu, 3), { rack: "Rack-05", shelf: 3, seat: 1, feed: 1 });
  assert.deepEqual(portPlace(pdu, "03"), { rack: "Rack-05", shelf: 3, seat: 1, feed: 1 });
  assert.deepEqual(portPlace(pdu, "4"), { rack: "Rack-05", shelf: 3, seat: 1, feed: 2 }, "seat defaults to 1");
  assert.equal(portPlace(pdu, 2), null, "not a shelf port");
  assert.equal(portPlace(pdu, 7), null, "a broken entry is no place");
  assert.deepEqual(portPlace({ id: "kvm2", kind: "kvm", places: { 1: { rack: "Rack-02", shelf: 1, seat: 1 } } }, 1), { rack: "Rack-02", shelf: 1, seat: 1, feed: null });
  assert.equal(portPlace({ id: "pdu1", kind: "pdu" }, 1), null, "an older backend has no places");
  assert.equal(portPlace(null, 1), null);
});

test("isFreePortLabel: blank, default names and placeholders; never a server, KVM Power or PDU", () => {
  for (const free of ["", "  ", "Outlet 2", "port 3", "Spare", "EMPTY", "free", "n/a", "-", "---"]) assert.equal(isFreePortLabel(free), true, free);
  for (const used of ["OPT12", "KVM Power", "kvm_power", "PDU", "Spare 2", "OptXXX"]) assert.equal(isFreePortLabel(used), false, used);
});

// A GET /api/shelves body like the fixture's after the seed (§11), trimmed.
const shelves = {
  revision: "r1", seeded: { at: 1, finished_at: 2 }, seed_report: { mapped_ports: 29 },
  racks: [
    { rack: "Rack-05", storage: false, shelf_count: 4, shelves: [
      { shelf: 1, seats: [{ seat: 1, status: "used", mapped: true, server: { key: "opt51", name: "OPT51" }, kvm_only: false, stale_names: [],
        pdu: [{ device_id: "pdu5", device_name: "PDU 05", port: "1", feed: 1, label: "OPT51" }], kvm: null }] },
      { shelf: 2, seats: [{ seat: 1, status: "no-ports", mapped: false, server: null, kvm_only: false, stale_names: [], pdu: [], kvm: null }] },
      { shelf: 3, seats: [{ seat: 1, status: "used", mapped: true, server: { key: "opt53", name: "OPT53 (PSU1)" }, kvm_only: false, stale_names: [],
        pdu: [{ device_id: "pdu5", device_name: "PDU 05", port: "4", feed: 2, label: "OPT53 (PSU2)" }, { device_id: "pdu5", device_name: "PDU 05", port: "3", feed: 1, label: "OPT53 (PSU1)" }],
        kvm: { device_id: "kvm2", device_name: "KVM 02", port: "3", label: "OPT53" } }] },
      { shelf: 4, seats: [{ seat: 1, status: "no-ports", mapped: false, server: null, pdu: [], kvm: null }] }] },
    { rack: "Rack-06", storage: false, shelf_count: 4, shelves: [
      { shelf: 1, seats: [
        { seat: 1, status: "used", mapped: true, server: { key: "opt61", name: "OPT61" }, pdu: [{ device_id: "pdu6", device_name: "PDU 06", port: "1", feed: 1 }], kvm: null },
        { seat: 2, status: "used", mapped: true, server: { key: "opt62", name: "OPT62" }, pdu: [{ device_id: "pdu6", device_name: "PDU 06", port: "2", feed: 1 }], kvm: null }] },
      { shelf: 4, seats: [{ seat: 1, status: "used", mapped: false, server: { key: "opt64", name: "OPT64" }, pdu: [], kvm: null }] }] },
    { rack: "Rack-01", storage: false, shelf_count: 4, shelves: [
      { shelf: 2, seats: [{ seat: 1, status: "empty", mapped: true, server: null, stale_names: ["OPT12"],
        pdu: [{ device_id: "pdu1", device_name: "PDU 01", port: "2", feed: 1, label: "Outlet 2" }], kvm: { device_id: "kvm1", device_name: "KVM 01", port: "2", label: "Port 2" } }] }] },
  ],
  unmapped: { pdu: [], kvm: [] }, off_shelf: [{ key: "opt90", name: "OPT90", reason: "kvm-only" }], problems: [],
};

test("hasShelfMap: only a document with at least one assigned outlet or port is a map (decision 3)", () => {
  assert.equal(hasShelfMap(shelves), true);
  assert.equal(hasShelfMap(null), false);
  assert.equal(hasShelfMap(unavailableShelves()), false);
  assert.equal(hasShelfMap({ racks: [] }), false);
  assert.equal(hasShelfMap({ racks: [{ rack: "Rack-08", shelves: [{ shelf: 1, seats: [{ seat: 1, status: "no-ports", pdu: [], kvm: null }] }] }] }), false);
  assert.equal(hasShelfMap({ racks: [{ rack: "Rack-02", shelves: [{ shelf: 2, seats: [{ seat: 1, pdu: [], kvm: { device_id: "kvm2", port: "2" } }] }] }] }), true, "a KVM-only seat");
  assert.equal(shelvesAvailable({ servers: [], shelves_revision: "r1" }), true);
  assert.equal(shelvesAvailable({ servers: [], shelves_revision: null }), true, "an empty map still names its revision");
  assert.equal(shelvesAvailable({ servers: [] }), false, "an older backend");
  assert.equal(shelvesAvailable(null), false);
});

test("findSeat, serverSeat and seatPortsText read the document", () => {
  assert.equal(findSeat(shelves, { rack: "Rack-05", shelf: 3 }).server.key, "opt53");
  assert.equal(findSeat(shelves, { rack: "rack-05", shelf: "3" }).server.key, "opt53", "the rack ignoring case, the shelf as text");
  assert.equal(findSeat(shelves, { rack: "Rack-06", shelf: 1, seat: 2 }).server.key, "opt62");
  assert.equal(findSeat(shelves, { rack: "Rack-06", shelf: 1, seat: 3 }), null);
  assert.equal(findSeat(null, { rack: "Rack-05", shelf: 3 }), null);
  assert.deepEqual(serverSeat(shelves, "opt62"), { rack: "Rack-06", shelf: 1, seat: 2, seats: 2, status: "used", mapped: true, kvm_only: false });
  assert.equal(serverSeat(shelves, "opt64").mapped, false, "a legacy server drawn on a shelf with no assigned outlet");
  assert.equal(serverSeat(shelves, "opt99"), null);
  assert.equal(serverSeat(unavailableShelves(), "opt51"), null);
  assert.equal(seatPortsText(findSeat(shelves, { rack: "Rack-05", shelf: 3 })), "PDU 05 · outlets 3 and 4 · KVM 02 · port 3", "feed order");
  assert.equal(seatPortsText(findSeat(shelves, { rack: "Rack-01", shelf: 2 })), "PDU 01 · outlet 2 · KVM 01 · port 2");
  assert.equal(seatPortsText(findSeat(shelves, { rack: "Rack-05", shelf: 2 })), "");
  assert.equal(seatPortsText({ pdu: [{ device_name: "PDU 05", port: "3", feed: 1 }, { device_name: "PDU 06", port: "3", feed: 2 }] }), "PDU 05 · outlet 3 · PDU 06 · outlet 3");
});

test("freeShelfCandidates: free unmapped outlets of the rack's own and shared PDUs, every free KVM port (the rack's first)", () => {
  const devices = [
    { id: "pdu5", kind: "pdu", name: "PDU 05", rack: "Rack-05" },
    { id: "pdu6", kind: "pdu", name: "PDU 06", rack: "Rack-06", notes: "spare feed, shared:Rack-05" },
    { id: "pdu7", kind: "pdu", name: "PDU 07", rack: "Rack-07", notes: "shared:Rack-050" },
    { id: "pdu1", kind: "pdu", name: "PDU 01", rack: "Rack-01" },
    { id: "kvm2", kind: "kvm", name: "KVM 02", rack: "Rack-02" },
    { id: "kvm5", kind: "kvm", name: "KVM 05", rack: "Rack-05" },
  ];
  const doc = { ...shelves, unmapped: {
    pdu: [
      { device_id: "pdu5", device_name: "PDU 05", rack: "Rack-05", port: "2", label: "Spare", free: true },
      { device_id: "pdu5", device_name: "PDU 05", rack: "Rack-05", port: "10", label: "", free: true },
      { device_id: "pdu5", device_name: "PDU 05", rack: "Rack-05", port: "6", label: "Outlet 6", free: true },
      { device_id: "pdu5", device_name: "PDU 05", rack: "Rack-05", port: "8", label: "OPT58", free: false },
      { device_id: "pdu5", device_name: "PDU 05", rack: "Rack-05", port: "9", label: "KVM Power", free: false },
      { device_id: "pdu6", device_name: "PDU 06", rack: "Rack-06", port: "2", label: "spare", free: true },
      { device_id: "pdu7", device_name: "PDU 07", rack: "Rack-07", port: "2", label: "Spare", free: true },
      { device_id: "pdu1", device_name: "PDU 01", rack: "Rack-01", port: "2", label: "Spare", free: true },
    ],
    kvm: [
      { device_id: "kvm2", device_name: "KVM 02", rack: "Rack-02", port: "3", label: "Port 3", free: true },
      { device_id: "kvm2", device_name: "KVM 02", rack: "Rack-02", port: "5", label: "OPT90", free: false },
      { device_id: "kvm5", device_name: "KVM 05", rack: "Rack-05", port: "2", label: "Spare", free: true },
    ] } };
  // A reachable PDU whose live name for outlet 6 names a server never offers it.
  const pduStatuses = { pdu5: { reachable: true, outlets: [{ number: 6, label: "OPT56", state: "on" }, { number: 2, label: "Spare", state: "off" }] } };
  const two = freeShelfCandidates({ devices, pduStatuses, shelves: doc, rack: "Rack-05", shelf: 2 });
  assert.deepEqual(two.pdu.map(c => c.value), ["pdu5:2", "pdu5:10", "pdu6:2"], "own PDUs first (outlet order), then shared; never another rack's");
  assert.deepEqual(two.pdu.map(c => c.text), ["PDU 05 · outlet 2 · Spare", "PDU 05 · outlet 10", "PDU 06 · outlet 2 · spare"]);
  assert.deepEqual(two.pdu.map(c => c.own), [true, true, false]);
  assert.deepEqual(two.pdu[0], { value: "pdu5:2", kind: "pdu", device_id: "pdu5", device_name: "PDU 05", rack: "Rack-05", port: "2", label: "Spare", own: true,
    text: "PDU 05 · outlet 2 · Spare" });
  assert.deepEqual(two.kvm.map(c => c.value), ["kvm5:2", "kvm2:3"], "every KVM (real KVMs serve several racks), the rack's own first");
  assert.deepEqual(two.kvm.map(c => c.text), ["KVM 05 · port 2 · Spare", "KVM 02 · port 3"]);
  assert.equal(two.suggested.pdu, null, "two placeholder outlets numbered 2 (PDU 05 and the shared PDU 06): none is pre-selected");
  assert.equal(two.suggested.kvm.value, "kvm5:2", "the rack's own KVM port 2, labelled Spare");

  const one = freeShelfCandidates({ devices: devices.filter(d => d.id !== "pdu6"), pduStatuses, shelves: doc, rack: "Rack-05", shelf: 2 });
  assert.equal(one.suggested.pdu.text, "PDU 05 · outlet 2 · Spare", "exactly one placeholder outlet with the shelf's number (§7.1)");
  const ten = freeShelfCandidates({ devices, pduStatuses, shelves: doc, rack: "Rack-05", shelf: 10 });
  assert.equal(ten.suggested.pdu, null, "a blank label is no placeholder: nothing is pre-selected");
  const three = freeShelfCandidates({ devices, pduStatuses, shelves: doc, rack: "Rack-05", shelf: 3 });
  assert.deepEqual([three.suggested.pdu, three.suggested.kvm], [null, null], "KVM 02 port 3 is another rack's and has a default name");
  const noRack = freeShelfCandidates({ devices, shelves: doc });
  assert.deepEqual([noRack.pdu.length, noRack.kvm.length, noRack.suggested.pdu, noRack.suggested.kvm], [0, 2, null, null]);
  const empty = freeShelfCandidates();
  assert.deepEqual(empty, { pdu: [], kvm: [], suggested: { pdu: null, kvm: null } });
});

test("freeShelfCandidates without the document (no shelf backend): the devices' own unassigned ports", () => {
  const devices = [
    { id: "pdu5", kind: "pdu", name: "PDU 05", rack: "Rack-05", port_count: 4, labels: { 1: "OPT51", 2: "Spare", 3: "OPT53 (PSU1)", 4: "" },
      places: { 1: { rack: "Rack-05", shelf: 1 }, 3: { rack: "Rack-05", shelf: 3 } } },
    { id: "kvm5", kind: "kvm", name: "KVM 05", rack: "Rack-05", port_count: 2, labels: { 1: "OPT51", 2: "Spare" } },
  ];
  for (const doc of [null, unavailableShelves(), { racks: [] }]) {
    const c = freeShelfCandidates({ devices, pduStatuses: {}, shelves: doc, rack: "Rack-05", shelf: 2 });
    assert.deepEqual(c.pdu.map(x => x.value), ["pdu5:2", "pdu5:4"], "outlet 1 is mapped, outlet 3 names a server");
    assert.deepEqual(c.kvm.map(x => x.value), ["kvm5:2"]);
    assert.equal(c.suggested.pdu.value, "pdu5:2");
    assert.equal(c.suggested.kvm.value, "kvm5:2");
  }
  const live = freeShelfCandidates({ devices, pduStatuses: { pdu5: { reachable: true, outlets: [{ number: 2, label: "OPT52" }] } }, rack: "Rack-05", shelf: 2 });
  assert.deepEqual(live.pdu.map(x => x.value), ["pdu5:4"], "the live name of a reachable PDU wins");
});

// A /locations body with v3 places: OPT53 is on two seats (a conflict), OPT51 on one.
const locations = { shelves_revision: "r1", servers: [
  { key: "opt51", name: "OPT51", place: { rack: "Rack-05", shelf: 1, seat: 1, source: "shelf" } },
  { key: "opt53", name: "OPT53 (PSU1)", place: { rack: "Rack-05", shelf: 3, seat: 1, source: "conflict",
    places: [{ rack: "Rack-05", shelf: 3, seat: 1 }, { rack: "Rack-05", shelf: 4, seat: 1 }] } },
  { key: "opt11", name: "OPT11", place: null },
] };

test("placeConflicts: from /locations rows (source conflict) and from GET /api/shelves split problems", () => {
  const map = placeConflicts(locations, null);
  assert.deepEqual([...map.keys()], ["opt53"]);
  assert.deepEqual(map.get("opt53"), { key: "opt53", name: "OPT53 (PSU1)", places: [{ rack: "Rack-05", shelf: 3, seat: 1 }, { rack: "Rack-05", shelf: 4, seat: 1 }] });
  const doc = { ...shelves, problems: [
    { code: "split", key: "opt71", text: "OPT71 is on Rack-07 · shelf 1.", places: [{ rack: "Rack-07", shelf: 1 }, { rack: "Rack-07", shelf: 2 }] },
    { code: "split:opt72", text: "…", place: { rack: "Rack-07", shelf: 2 } },
    { code: "split", key: "opt53", places: [] },
    { code: "crowded:Rack-01:1:1", text: "…" },
  ] };
  const both = placeConflicts(locations, doc);
  assert.deepEqual([...both.keys()], ["opt53", "opt71", "opt72"], "the row wins for a server in both");
  assert.equal(both.get("opt53").places.length, 2);
  assert.deepEqual(both.get("opt72").places, [{ rack: "Rack-07", shelf: 2, seat: 1 }]);
  assert.equal(placeConflicts(null, null).size, 0);
  assert.equal(placeConflicts({ servers: [{ key: "opt11", name: "OPT11" }] }, unavailableShelves()).size, 0, "no shelf backend: no conflict");
  assert.equal(conflictOf(both, "opt71").key, "opt71");
  assert.equal(conflictOf(both, "opt11"), null);
  assert.deepEqual(conflictOf(new Set(["opt9"]), "opt9"), { key: "opt9", name: "opt9", places: [] });
  assert.equal(conflictOf({ opt9: { key: "opt9", places: [] } }, "opt9").key, "opt9");
  assert.equal(conflictOf(null, "opt9"), null);
});

test("conflict texts (§8.3) and the whole-server power block (§7.11)", () => {
  const conflict = placeConflicts(locations, null).get("opt53");
  assert.match(conflictPowerReason(conflict), re(`Its outlets are on two ${WS}; switch single outlets from the PDU window\\.`));
  assert.match(conflictBannerText("OPT53", conflict),
    re(`OPT53's name is on outlets of two ${WS} \\(Rack-05 · ${W} 3 and Rack-05 · ${W} 4\\)\\. Whole-server power is off until this is fixed: open the PDU and assign or clear the outlet\\.`));
  const three = { places: [{ rack: "Rack-05", shelf: 1 }, { rack: "Rack-05", shelf: 2 }, { rack: "Rack-05", shelf: 3 }, { rack: "Rack-05", shelf: 3 }] };
  assert.match(conflictBannerText("OPT9", three), new RegExp(`of three ${WS} \\(Rack-05 · ${W} 1, Rack-05 · ${W} 2 and Rack-05 · ${W} 3\\)`));
  assert.match(conflictPowerReason({ places: [] }), /two/, "places unknown: two");
  assert.equal(placePowerBlock(conflict, "server"), conflictPowerReason(conflict));
  assert.equal(placePowerBlock(conflict), conflictPowerReason(conflict), "whole server by default");
  assert.equal(placePowerBlock(conflict, "feed"), null, "a single outlet stays switchable");
  assert.equal(placePowerBlock(null, "server"), null);
  const group = { key: "opt53", name: "OPT53", state: "on", feeds: [{ id: "pdu5:3" }] };
  assert.equal(withPlaceConflict(group, null), group, "no conflict: the same group");
  assert.equal(withPlaceConflict(null, conflict), null);
  const blocked = withPlaceConflict(group, conflict);
  assert.deepEqual([blocked.key, blocked.feeds, blocked.placeConflict, blocked.wholeServerBlocked], [group.key, group.feeds, conflict, conflictPowerReason(conflict)]);
  assert.equal("placeConflict" in group, false, "the input is not changed");
});

test("addServerBody and shelfPortChanges: the request bodies of §6.1", () => {
  assert.deepEqual(addServerBody({ name: " OPT55 ", rack: "Rack-05", shelf: "2" }), { name: "OPT55", rack: "Rack-05", shelf: 2 });
  assert.deepEqual(addServerBody({ name: "OPT55", rack: "Rack-05", shelf: 2, seat: 2, ownerId: 7, reuseDeleted: true,
    assign: { pdu: [{ value: "pdu5:2", device_id: "pdu5", port: "2" }, "pdu6:03", null, "bad"], kvm: "kvm2:3" } }),
  { name: "OPT55", rack: "Rack-05", shelf: 2, seat: 2, owner_id: 7, reuse_deleted: true,
    assign: { pdu: [{ device_id: "pdu5", port: "2" }, { device_id: "pdu6", port: "3" }], kvm: { device_id: "kvm2", port: "3" } } });
  assert.deepEqual(addServerBody({ name: "X", rack: "R", shelf: 1, owner_id: "", assign: { pdu: [] } }), { name: "X", rack: "R", shelf: 1, assign: { pdu: [], kvm: null } });
  assert.deepEqual(addServerBody(), { name: "", rack: "", shelf: null });
  assert.deepEqual(shelfPortChanges([
    { device_id: "pdu5", port: 7, place: { rack: "Rack-05", shelf: "2" } },
    { device_id: "pdu5", port: "4", place: { rack: "Rack-05", shelf: 3, seat: 1, feed: 2 } },
    { device_id: "kvm2", port: "3", place: null },
    { device_id: "pdu5", port: "" },
  ]), [
    { device_id: "pdu5", port: "7", place: { rack: "Rack-05", shelf: 2, seat: 1 } },
    { device_id: "pdu5", port: "4", place: { rack: "Rack-05", shelf: 3, seat: 1, feed: 2 } },
    { device_id: "kvm2", port: "3", place: null },
  ]);
});

// ── the requests, with fetch stubbed (nothing leaves the process) ──
function stubFetch(answer) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null, cache: init.cache });
    const { status = 200, body = {}, type = "application/json", etag = null, raw = null } = typeof answer === "function" ? answer(calls.at(-1)) : answer;
    const headers = new Map([["content-type", type], ...(etag ? [["etag", etag]] : [])]);
    return { ok: status >= 200 && status < 300, status, headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
      json: async () => (raw != null ? JSON.parse(raw) : body) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("loadShelves: the document with its ETag; a backend without /api/shelves is unavailable, not an error", async () => {
  let f = stubFetch({ body: { revision: "abc", racks: [{ rack: "Rack-01", shelves: [] }], problems: null }, etag: "\"abc\"" });
  try {
    const doc = await loadShelves();
    assert.deepEqual([f.calls[0].url, f.calls[0].method, f.calls[0].cache], ["/api/shelves", "GET", "no-store"]);
    assert.deepEqual([doc.revision, doc.etag, doc.racks.length, doc.problems, doc.unmapped, doc.off_shelf, doc.seeded, doc.unavailable],
      ["abc", "\"abc\"", 1, [], { pdu: [], kvm: [] }, [], null, undefined]);
  } finally { f.restore(); }
  f = stubFetch({ status: 404, body: { detail: "Not found" } });
  try { assert.deepEqual(await loadShelves(), unavailableShelves()); } finally { f.restore(); }
  f = stubFetch({ status: 200, type: "text/html", raw: "1" });
  try { assert.equal((await loadShelves()).unavailable, true, "an older server's page"); } finally { f.restore(); }
  f = stubFetch({ status: 500, body: { detail: "boom" } });
  try { await assert.rejects(loadShelves(), e => e.status === 500 && e.message === "boom"); } finally { f.restore(); }
});

test("add-server and wiring requests: dry run first, then the plan revision; refusals keep the server's code and text", async () => {
  const f = stubFetch(call => (call.url.endsWith("/add-server") && call.body?.name === "OPT74"
    ? { status: 409, body: { detail: { code: "deleted", text: "OPT74 was deleted on 24 Nov. Restore it, or choose another name.", key: "opt74", batch: "b1" } } }
    : { body: { plan_revision: "p1", ok: true } }));
  try {
    assert.deepEqual(await previewAddServer({ name: "OPT55", rack: "Rack-05", shelf: 2 }), { plan_revision: "p1", ok: true });
    await addServer({ name: "OPT55", rack: "Rack-05", shelf: 2 }, "p1");
    assert.deepEqual(f.calls.map(c => [c.method, c.url]), [["POST", "/api/shelves/add-server"], ["POST", "/api/shelves/add-server"]]);
    assert.deepEqual(f.calls[0].body, { name: "OPT55", rack: "Rack-05", shelf: 2, dry_run: true });
    assert.deepEqual(f.calls[1].body, { name: "OPT55", rack: "Rack-05", shelf: 2, dry_run: false, plan_revision: "p1" });
    await assert.rejects(previewAddServer({ name: "OPT74", rack: "Rack-07", shelf: 4 }), e => e.status === 409 && e.code === "deleted"
      && e.message.startsWith("OPT74 was deleted") && e.detail === e.message && e.info.batch === "b1");
    await previewShelfPorts([{ device_id: "pdu5", port: 7, place: { rack: "Rack-05", shelf: 2 } }], "r1");
    await saveShelfPorts([{ device_id: "pdu5", port: 7, place: null }], "r1", "p2");
    assert.deepEqual(f.calls.slice(-2).map(c => [c.method, c.url, c.body]), [
      ["PUT", "/api/shelves/ports", { revision: "r1", dry_run: true, changes: [{ device_id: "pdu5", port: "7", place: { rack: "Rack-05", shelf: 2, seat: 1 } }] }],
      ["PUT", "/api/shelves/ports", { revision: "r1", dry_run: false, plan_revision: "p2", changes: [{ device_id: "pdu5", port: "7", place: null }] }],
    ]);
  } finally { f.restore(); }
  const missing = stubFetch({ status: 404, body: { detail: "Not Found" } });
  try {
    await assert.rejects(addServer({ name: "OPT55", rack: "Rack-05", shelf: 2 }, "p1"), e => e.status === 404 && e.unavailable === true && e.message === UNAVAILABLE_TEXT);
  } finally { missing.restore(); }
});

test("shelfError: text, list and object details", () => {
  assert.equal(shelfError(409, { detail: "The shelf map changed in another session; review and save again." }).detail,
    "The shelf map changed in another session; review and save again.");
  assert.equal(shelfError(422, { detail: [{ msg: "a" }, { msg: "b" }] }).message, "a; b");
  const taken = shelfError(409, { detail: { code: "taken", message: "Shelf 3 has OPT53." } });
  assert.deepEqual([taken.code, taken.message, taken.unavailable], ["taken", "Shelf 3 has OPT53.", undefined]);
  assert.equal(shelfError(403, null).message, "Request failed (HTTP 403)");
  assert.equal(shelfError(404, { detail: { code: "unknown_rack", text: "No rack named X." } }).unavailable, undefined, "a real 404 answer is not 'unavailable'");
});
