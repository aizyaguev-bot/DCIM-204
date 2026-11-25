// Add server (server/AddServerDialog.jsx, one-place WP-5): the rack, its free floors, the free PDU outlets and KVM ports
// it offers, the name check and the rack_slots pin (server/addServerModel.js). Pure; node --test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addFloors, addKvmPorts, addOutlets, addRacks, dcimId, defaultFloor, defaultKvm, defaultOutlet, labelsWith, nameProblem,
  outletText, withPin, withoutPin } from "../server/addServerModel.js";

const read = rel => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pdu5 = { id: "pdu5", name: "PDU 05", kind: "pdu", rack: "Rack-05", port_count: 4, labels: { 1: "OPT51", 2: "Spare", 3: "OPT53 (PSU1)", 4: "OPT53 (PSU2)" }, labels_revision: "r5" };
const pdu6 = { id: "pdu6", name: "PDU 06", kind: "pdu", rack: "Rack-06", port_count: 6, labels: { 1: "OPT61", 2: "KVM Power", 3: "OptXXX", 4: "empty", 5: "" } };
const pdu8 = { id: "pdu8", name: "PDU-Rack-08", kind: "pdu", rack: "Rack-08", port_count: 0, labels: {} };
const kvm5 = { id: "kvm5", name: "KVM 05", kind: "kvm", rack: "Rack-05", port_count: 4, labels: { 1: "OPT51", 2: "Spare", 3: "Port 3" } };
const rackRow = { id: "r5", name: "Compute-Rack-05", kind: "rack", rack: "Rack-05", model: "Compute" };
const devices = [pdu5, pdu6, pdu8, kvm5, rackRow];
const row = (name, rack, u, extra = {}) => ({ key: name.toLowerCase(), name, rack, slot: u, pdu: [{ device_id: "pdu5", port: "1", label: name }], kvm: [],
  drawn: { rack, u, auto: false }, ...extra });
const locations = { servers: [row("OPT51", "Rack-05", 1), row("OPT53", "Rack-05", 3), row("OPT74", "Rack-07", 4, { removed: true }),
  { key: "opt90", name: "OPT90", rack: "Rack-02", slot: null, pdu: [], kvm: [{ device_id: "kvm2", port: "2", label: "OPT90" }], drawn: null }],
  empty_ports: { pdu: [{ device_id: "pdu5", port: "2" }, { device_id: "pdu6", port: "3" }, { device_id: "pdu6", port: "4" }, { device_id: "pdu6", port: "5" }, { device_id: "pdu6", port: "6" }],
    kvm: [{ device_id: "kvm5", port: "2" }, { device_id: "kvm5", port: "3" }, { device_id: "kvm5", port: "4" }] } };

test("addRacks: every rack with a PDU, in natural order; the rack it was opened from too", () => {
  assert.deepEqual(addRacks(devices), ["Rack-05", "Rack-06", "Rack-08"]);
  assert.deepEqual(addRacks(devices, "Storage-Main"), ["Rack-05", "Rack-06", "Rack-08", "Storage-Main"]);
});

test("addOutlets: free outlets only (never a server, KVM Power or PDU), blank / default / empty / spare first", () => {
  const five = addOutlets(devices, {}, "Rack-05", locations.empty_ports.pdu);
  assert.deepEqual(five.map(o => [o.value, o.label, o.rank]), [["pdu5:2", "Spare", 0]]);
  assert.equal(outletText(five[0]), "PDU 05 · outlet 2 · Spare");
  const six = addOutlets(devices, {}, "Rack-06", locations.empty_ports.pdu);
  assert.deepEqual(six.map(o => [o.outlet, o.label, o.rank]), [[4, "empty", 0], [5, "", 0], [6, "", 0], [3, "OptXXX", 1]]);
  // A reachable PDU's live name wins over the saved label: a server named only on the PDU itself is not free.
  const live = { pdu6: { reachable: true, outlets: [{ number: 5, label: "OPT65" }, { number: 6, label: "Outlet 6" }] } };
  assert.deepEqual(addOutlets(devices, live, "Rack-06").map(o => o.outlet), [4, 6, 3]);
  // The backend's empty-port list (it knows names the PDU reported earlier): an outlet it leaves out is not offered.
  assert.deepEqual(addOutlets(devices, {}, "Rack-06", [{ device_id: "pdu6", port: "6" }]).map(o => o.outlet), [6]);
  // No outlet count and no reading: nothing to offer.
  assert.deepEqual(addOutlets(devices, {}, "Rack-08", []), []);
  assert.deepEqual(addOutlets(devices, {}, "Rack-09"), []);
});

test("defaultOutlet: the empty / spare outlet with the floor's number, else the first free one", () => {
  const six = addOutlets(devices, {}, "Rack-06", locations.empty_ports.pdu);
  assert.equal(defaultOutlet(six, 4), "pdu6:4");
  assert.equal(defaultOutlet(six, 2), "pdu6:4", "no placeholder with that number: the first free one");
  assert.equal(defaultOutlet([], 1), "");
});

test("addKvmPorts / defaultKvm: the rack's free KVM ports; the spare one with the floor's number is preselected", () => {
  const ports = addKvmPorts(devices, "Rack-05", locations.empty_ports.kvm);
  assert.deepEqual(ports.map(p => [p.value, p.label]), [["kvm5:2", "Spare"], ["kvm5:3", "Port 3"], ["kvm5:4", ""]]);
  assert.equal(defaultKvm(ports, 2), "kvm5:2");
  assert.equal(defaultKvm(ports, 4), "", "no KVM port unless the KVM says which one serves the floor");
});

test("addFloors / defaultFloor: the rack's floors with the servers on them; a free one is chosen", () => {
  const floors = addFloors(locations, new Set(), "Rack-05");
  assert.deepEqual(floors.map(f => f.label), ["Floor 1 · OPT51", "Floor 2 · free", "Floor 3 · OPT53", "Floor 4 · free"]);
  assert.equal(defaultFloor(floors), 2);
  assert.equal(defaultFloor(floors, 4), 4, "the floor asked for, when free");
  assert.equal(defaultFloor(floors, 3), 2, "a taken floor is never chosen");
  assert.equal(defaultFloor(addFloors(locations, new Set(), "Rack-07")), 1, "a removed server takes no floor");
  assert.equal(defaultFloor(floors.map(f => ({ ...f, taken: ["X"] }))), null);
  assert.deepEqual(addFloors(locations, null, ""), []);
});

test("nameProblem: a server name that is new; a placeholder, an existing or a removed server is refused", () => {
  assert.equal(nameProblem("OPT52", locations), null);
  assert.equal(nameProblem("  opt52 (psu1) ", locations), null);
  assert.match(nameProblem("", locations).text, /Type the server's name/);
  assert.match(nameProblem("Spare", locations).text, /is not a server name/);
  assert.match(nameProblem("Outlet 3", locations).text, /is not a server name/);
  assert.match(nameProblem("OptXXX", locations).text, /is not a server name/);
  assert.deepEqual(nameProblem("opt51", locations), { key: "opt51", name: "OPT51", text: "OPT51 already exists (Rack-05 · floor 1). Open it to change its place or ports." });
  assert.equal(nameProblem("OPT53 (PSU2)", locations).key, "opt53", "a feed name is its server");
  assert.match(nameProblem("OPT90", locations).text, /^OPT90 already exists \(Rack-02\)/, "a KVM-only server exists too");
  assert.deepEqual(nameProblem("OPT74", locations), { key: "opt74", removed: true, name: "OPT74", text: "OPT74 was removed from the lab. Restore it, or choose another name." });
  assert.equal(nameProblem("OPT98", locations, { servers: [{ key: "opt98", name: "OPT98", active: true }] }).removed, true, "removed, with no row any more");
  assert.equal(nameProblem("OPT98", locations, { servers: [{ key: "opt98", name: "OPT98", active: false }] }), null, "restored long ago");
});

test("withPin / withoutPin: the new server's floor in rack_slots, and taken back only while it is the one written", () => {
  const doc = { "Rack-05": { opt51: 1 }, "Rack-06": { opt61: 1 } };
  const pinned = withPin(doc, "Rack-05", dcimId(" OPT52 "), 2);
  assert.deepEqual(pinned, { "Rack-05": { opt51: 1, opt52: 2 }, "Rack-06": { opt61: 1 } });
  assert.deepEqual(doc["Rack-05"], { opt51: 1 }, "the input is not changed");
  assert.deepEqual(withPin({}, "Rack-09", "opt91", 1), { "Rack-09": { opt91: 1 } });
  assert.throws(() => withPin({ "Rack-05": [1] }, "Rack-05", "opt52", 2), /cannot be read/);
  assert.deepEqual(withoutPin(pinned, "Rack-05", "opt52", 2), doc);
  assert.deepEqual(withoutPin({ "Rack-05": { opt52: 3 } }, "Rack-05", "opt52", 2), { "Rack-05": { opt52: 3 } }, "moved meanwhile: kept");
});

test("labelsWith: the device's saved labels with the new name on that port (Racks' old + OPT write)", () => {
  assert.deepEqual(labelsWith(pdu5, 2, " OPT52 "), { 1: "OPT51", 2: "OPT52", 3: "OPT53 (PSU1)", 4: "OPT53 (PSU2)" });
  assert.deepEqual(labelsWith({}, "3", "OPT13"), { 3: "OPT13" });
});

test("the dialog: the floor is pinned first, the label is the same PATCH as before, a refusal takes the pin back", () => {
  const dialog = read("../server/AddServerDialog.jsx");
  const pin = dialog.indexOf('saveLayout("/api/rack-slots", doc => withPin('), label = dialog.indexOf("act.app.saveLabels(pdu.id, labelsWith(");
  assert.ok(pin > 0 && label > pin, "pin, then the outlet label");
  assert.match(dialog, /if \(pinned\) await saveLayout\("\/api\/rack-slots", doc => withoutPin\(/);
  assert.match(dialog, /act\.openServer\(key\)/, "then the new server's window opens");
  assert.match(dialog, /data-dialog="add-server"/);
  const racks = read("../pages/DcimView.jsx");
  assert.match(racks, /addServer: canOperate \? openAddServer : null/, "Operator and up");
  assert.match(read("../components/racks/RacksToolbar.jsx"), /data-action="add-server"/);
  assert.doesNotMatch(racks, /function AddOptModal|function AddRackModal/);
});
