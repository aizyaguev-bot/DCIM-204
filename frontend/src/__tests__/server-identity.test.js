// node --test src/__tests__/server-identity.test.js
// The server window's identity package and the unit / cooling windows (one-place spec v1 WP-2, v2 WP-2): rename, the
// owner written under every key with a guarded Undo, the switch fields, units on a floor and their owner, Restore, and
// the unit model the unit window edits with.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkRename, deletedEntry, existingServer, floorNotes, ownerChangedSince, ownerUndoPlan, partialOwnerText, perKeyText, renameFrom,
  renameResult, sameSwitch, scanTarget, switchText, switchValue, writeEveryKey } from "../server/serverIdentity.js";
import { addUnit, daysSince, editUnit, findUnit, floorServer, historyRows, moveUnit, placeChoices, rackChoices, unitOwner, unitPlace, unitTypeText,
  unitU } from "../units/unitModel.js";
import { buildRecord } from "../server/serverRecord.js";
import { ownerWriteKeys } from "../server/ownerKey.js";
import { setStorageRacks } from "../components/racks/floors.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// The fixture's two-PSU server (tests/browser/preview-server.py DCIM_FIXTURE_ONE_PLACE=1): OPT53 on Rack-05 floor 3.
const locations = { servers: [
  { key: "opt51", name: "OPT51", rack: "Rack-05", slot: 1, pdu: [{ device_id: "pdu5", device_name: "PDU 05", port: "1", label: "OPT51" }], kvm: [],
    dcim_ids: ["opt51"], drawn: { rack: "Rack-05", u: 1, auto: false }, removed: false },
  { key: "opt53", name: "OPT53", rack: "Rack-05", slot: 3,
    pdu: [{ device_id: "pdu5", device_name: "PDU 05", port: "3", label: "OPT53 (PSU1)" }, { device_id: "pdu5", device_name: "PDU 05", port: "4", label: "OPT53 (PSU2)" }],
    kvm: [], dcim_ids: ["opt53 (psu1)", "opt53 (psu2)"], drawn: { rack: "Rack-05", u: 3, auto: false }, removed: false },
  { key: "opt61", name: "OPT61", rack: "Rack-06", slot: 1, pdu: [{ device_id: "pdu6", port: "1", label: "OPT61" }], kvm: [], dcim_ids: ["opt61"], drawn: { rack: "Rack-06", u: 1, auto: false } },
  { key: "opt62", name: "OPT62", rack: "Rack-06", slot: 1, pdu: [{ device_id: "pdu6", port: "2", label: "OPT62" }], kvm: [], dcim_ids: ["opt62"], drawn: { rack: "Rack-06", u: 1, auto: false } },
  { key: "opt74", name: "OPT74", rack: "Rack-07", slot: 4, pdu: [{ device_id: "pdu7", port: "4", label: "OPT74" }], kvm: [], dcim_ids: ["opt74"], drawn: null, removed: true },
  { key: "opt90", name: "OPT90", rack: "Rack-02", slot: null, pdu: [], kvm: [{ device_id: "kvm2", device_name: "KVM 02", port: "2", label: "OPT90" }], dcim_ids: ["opt90"], drawn: null },
  { key: "opt96", name: "OPT96", rack: null, slot: null, pdu: [], kvm: [], dcim_ids: ["opt96"], drawn: null },
  { key: "opt77", name: "OPT77", rack: "Rack-07", slot: 7, pdu: [{ device_id: "pdu7", port: "7", label: "OPT77" }], kvm: [], dcim_ids: ["opt77"], drawn: { rack: "Rack-07", u: 7, auto: false } },
], racks: ["Rack-05", "Rack-06", "Rack-07", "Rack-09"] };
const rackItems = {
  "Rack-05": [{ id: "u-tray53", name: "Tray 53", type: "other", u: 3, serial_number: "TRAY-053" }, { id: "u-top", name: "Top cable", type: "cable", u: 0 }],
  "Rack-06": [{ id: "u-shared", name: "Shared tray", type: "other", u: 1 }, { id: "u-free", name: "Free tray", type: "other", u: 4 }],
  "Storage-Main": [{ id: "u-box", name: "Box", type: "other", u: 2 }],
  "Rack-09": [],
};
const owners = { "opt53 (psu1)": "Alice Feed", "opt53 (psu2)": "Bob Feed", opt61: "Eden Levi", "item:u-free": "Liran Cohen", "item:u-tray53": "Own owner" };
const data = { locations, rackItems, owners, switches: { "opt53 (psu1)": { switch: "SW-05", port: "3" }, "opt53 (psu2)": { switch: "SW-05", port: "4" } },
  chillers: { units: [{ id: "ch5", name: "Cooling", rack: "Rack-05", u: 2 }] }, devices: [{ id: "pdu5", kind: "pdu", rack: "Rack-05" }, { id: "pdu8", kind: "pdu", rack: "Rack-08" }] };

test("rename: the name renamed from has no feed suffix; the new name must be a new server name", () => {
  const opt53 = buildRecord("opt53", data);
  assert.equal(renameFrom(opt53), "OPT53");
  assert.equal(renameFrom({ name: "OPTN45 (PSU1)" }), "OPTN45");
  assert.deepEqual(checkRename(opt53, "  OPT53X "), { name: "OPT53X", key: "opt53x" });
  assert.match(checkRename(opt53, "").error, /Type the new name/);
  assert.match(checkRename(opt53, "Outlet 3").error, /is not a server name/);
  assert.match(checkRename(opt53, "KVM Power").error, /is not a server name/);
  assert.match(checkRename(opt53, "OptXXX").error, /is not a server name/, "the OptXXX placeholder is not a server");
  assert.match(checkRename(opt53, "opt53 (psu9)").error, /same server/);
  assert.match(checkRename(opt53, "X".repeat(201)).error, /at most 200/);
});

test("rename: a name that already exists offers Swap with that server (backend _RENAME_EXISTS)", () => {
  const exists = Object.assign(new Error("409: …"), { status: 409, detail: "OPT13 already exists — open it and use Swap with or Move." });
  assert.deepEqual(existingServer(exists, "opt13"), { key: "opt13", name: "OPT13" });
  assert.deepEqual(existingServer(Object.assign(new Error(), { status: 409, detail: "OPTN45 (PSU1) already exists" }), "x"), { key: "optn45", name: "OPTN45 (PSU1)" });
  assert.equal(existingServer(Object.assign(new Error(), { status: 409, detail: "Changed since the preview. Preview again." }), "opt13"), null);
  assert.equal(existingServer(Object.assign(new Error(), { status: 400, detail: "x already exists" }), "opt13"), null);
  const result = renameResult({ changes: [{ device_id: "pdu1", device_name: "PDU 01", kind: "pdu", port: "1", before: "OPT12", after: "OPT12X" },
    { device_id: "kvm1", device_name: "KVM 01", kind: "kvm", port: "2", before: "OPT12", after: "OPT12X" }],
    monitor: { before: "OPT12", after: "OPT12X" }, owner: { name: "Dana" }, layout: [{ before: "opt12", after: "opt12x" }, { before: null, after: "opt13" }] }, "OPT12", "OPT12X");
  assert.equal(result.title, "Renamed OPT12 to OPT12X.");
  assert.deepEqual(result.lines, ["PDU 01 outlet 1: OPT12 → OPT12X", "KVM 01 port 2: OPT12 → OPT12X", "Ping monitor: OPT12 → OPT12X", "Owner Dana kept", "1 rack layout entry renamed"]);
});

test("owner: every key is written in order, the first failure stops it and says which keys were saved", async () => {
  const opt53 = buildRecord("opt53", data);
  const keys = ownerWriteKeys(opt53);
  assert.deepEqual(keys, ["opt53", "opt53 (psu1)", "opt53 (psu2)"]);
  const calls = [];
  assert.deepEqual(await writeEveryKey(keys, async key => { calls.push(key); }), { saved: keys, failed: null });
  assert.deepEqual(calls, keys);
  const result = await writeEveryKey(keys, async key => { if (key === "opt53 (psu1)") throw new Error("Choose an active engineer from the list"); });
  assert.deepEqual(result.saved, ["opt53"]);
  assert.equal(result.failed.key, "opt53 (psu1)");
  assert.equal(partialOwnerText(result, keys), "Saved for opt53; not saved for opt53 (psu1), opt53 (psu2): Choose an active engineer from the list");
  const none = await writeEveryKey(keys, async () => { throw new Error("Request failed (403)"); });
  assert.equal(partialOwnerText(none, keys), "Not saved: Request failed (403)");
  assert.equal(perKeyText(opt53, opt53.owner.perKey), "OPT53 (PSU1) → Alice Feed, OPT53 (PSU2) → Bob Feed", "each key named by its port label");
  assert.equal(opt53.owner.disagree, true);
});

test("owner Undo: puts back each key's owner; refused for a legacy owner; guarded against a change made elsewhere", () => {
  const engineers = [{ id: "e1", name: "Eden Levi", active: true }, { id: "e2", name: "Old Name", active: false }];
  assert.deepEqual(ownerUndoPlan(["opt12", "item:x"], { opt12: "Eden Levi" }, engineers),
    { ok: true, writes: [{ key: "opt12", engineer_id: "e1" }, { key: "item:x", engineer_id: null }] });
  const legacy = ownerUndoPlan(["opt53", "opt53 (psu1)"], { "opt53 (psu1)": "Alice Feed" }, engineers);
  assert.equal(legacy.ok, false);
  assert.match(legacy.why, /Alice Feed is not in the engineer list/);
  assert.equal(ownerUndoPlan(["k"], { k: "Old Name" }, engineers).ok, false, "an inactive engineer cannot be chosen again");
  // The guard: only keys still holding what this window wrote may be reverted.
  assert.deepEqual(ownerChangedSince(["a", "b"], "Eden Levi", { a: "Eden Levi", b: "Eden Levi" }), []);
  assert.deepEqual(ownerChangedSince(["a", "b"], "Eden Levi", { a: "Eden Levi", b: "Liran Cohen" }), ["b"]);
  assert.deepEqual(ownerChangedSince(["a"], "", {}), [], "a cleared owner is still cleared");
  assert.deepEqual(ownerChangedSince(["a"], "", { a: "Someone" }), ["a"]);
});

test("switch: trimmed fields, empty clears, limits, and the text shown", () => {
  assert.deepEqual(switchValue({ switch: " SW-05 ", port: " 7 " }), { switch: "SW-05", port: "7" });
  assert.equal(switchValue({ switch: " ", port: "" }), null);
  assert.throws(() => switchValue({ switch: "x".repeat(121), port: "" }), /at most 120/);
  assert.equal(sameSwitch({ switch: "SW", port: "1" }, { switch: "SW ", port: "1" }), true);
  assert.equal(sameSwitch(null, { switch: "", port: "" }), true);
  assert.equal(switchText({ switch: "SW-05", port: "3" }), "SW-05 · port 3");
  assert.equal(switchText(null), "None");
  const opt53 = buildRecord("opt53", data);
  assert.equal(opt53.switch.disagree, true);
  assert.equal(perKeyText(opt53, opt53.switch.perKey, switchText), "OPT53 (PSU1) → SW-05 · port 3, OPT53 (PSU2) → SW-05 · port 4");
});

test("units on this floor: Scan barcode only on a floor; the reason otherwise; the shared-floor and cooling notes", () => {
  const opt53 = buildRecord("opt53", data);
  assert.deepEqual(opt53.units.map(u => u.id), ["u-tray53"]);
  assert.deepEqual(scanTarget(opt53), { target: { rack: "Rack-05", u: 3, position: "", label: "OPT53" } });
  assert.match(scanTarget(buildRecord("opt96", data)).why, /OPT96 is not drawn on a rack/);
  assert.match(scanTarget(buildRecord("opt90", data)).why, /only on a KVM port/);
  assert.match(scanTarget(buildRecord("opt77", data)).why, /at U 7, above the floors in Rack-07/);
  assert.deepEqual(floorNotes(opt53, data), ["Cooling units and rack-level units never move with a server."]);
  assert.deepEqual(floorNotes(buildRecord("opt61", data), data), ["Shares floor 1 with OPT62. These units stay when one server moves."]);
  assert.deepEqual(floorNotes(buildRecord("opt96", data), data), []);
});

test("restore: a server in the Deleted list is restored from its batch; one removed before it by the old route", () => {
  const deleted = { batches: [
    { id: "b1", at: "2026-11-20T10:00:00Z", entries: [{ kind: "server", id: "opt74", name: "OPT74", restored_at: "2026-11-21T10:00:00Z" }] },
    { id: "b2", at: "2026-11-22T10:00:00Z", entries: [{ kind: "unit", id: "opt74" }, { kind: "server", id: "opt74", name: "OPT74" }] },
  ] };
  assert.deepEqual(deletedEntry(deleted, "opt74"), { batch: deleted.batches[1], entry: deleted.batches[1].entries[1] });
  assert.equal(deletedEntry(deleted, "opt12"), null);
  assert.equal(deletedEntry(null, "opt74"), null);
  assert.deepEqual(deletedEntry(deleted, "opt74", "unit"), { batch: deleted.batches[1], entry: deleted.batches[1].entries[0] }, "a unit or cooling window looks up its own kind");
});

test("unit model: find, place, owner by the lab owner's rule (the server's on its floor, read-only; else its own)", () => {
  setStorageRacks(["Storage-Main"]);
  assert.equal(findUnit(rackItems, "u-tray53").rack, "Rack-05");
  assert.equal(findUnit(rackItems, "nope"), null);
  assert.equal(unitPlace(rackItems["Rack-05"][0], "Rack-05"), "Rack-05 · floor 3");
  assert.equal(unitPlace(rackItems["Rack-05"][1], "Rack-05"), "Rack-05 · rack level");
  assert.equal(unitPlace(rackItems["Storage-Main"][0], "Storage-Main"), "Storage-Main · shelf 2");
  assert.equal(unitPlace({ u: 0 }, "Storage-Main"), "Storage-Main");
  assert.equal(unitPlace({ u: 9 }, "Rack-05"), "Rack-05 · U 9");
  assert.equal(unitU({ u: "3" }), 3);
  assert.equal(unitU({ u: "x" }), 0);
  // On OPT53's floor: OPT53's owner (its first feed's, as Racks shows it), not the unit's own saved owner.
  const tray = unitOwner(rackItems["Rack-05"][0], "Rack-05", data);
  assert.equal(tray.owner, "Alice Feed");
  assert.deepEqual(tray.server, { key: "opt53", name: "OPT53", dcim_ids: ["opt53 (psu1)", "opt53 (psu2)"] });
  // A shared floor: the first server Racks draws there.
  assert.equal(unitOwner(rackItems["Rack-06"][0], "Rack-06", data).server.key, "opt61");
  assert.equal(unitOwner(rackItems["Rack-06"][0], "Rack-06", data).owner, "Eden Levi");
  // ... in the Racks order (rack_positions, then name), as Racks and the 3D twin pick it, not the /locations row order.
  const reordered = { ...data, owners: { ...owners, opt62: "Roy Mendelson" }, rackOrder: { "Rack-06": ["opt62", "opt61"] } };
  assert.deepEqual(unitOwner(rackItems["Rack-06"][0], "Rack-06", reordered), { owner: "Roy Mendelson", server: { key: "opt62", name: "OPT62", dcim_ids: ["opt62"] } });
  assert.equal(floorServer(locations, "Rack-06", 1, null, { "Rack-06": ["opt99", "opt61"] }).key, "opt61", "a listed server before an unlisted one");
  assert.equal(floorServer({ servers: [locations.servers[3], locations.servers[2]] }, "Rack-06", 1, null, {}).key, "opt61", "unlisted: by name");
  assert.equal(floorServer(locations, "Rack-06", 1, new Set(["opt61"]), { "Rack-06": ["opt61", "opt62"] }).key, "opt62", "a hidden server is skipped");
  // No server on its floor, the rack level, Main storage: its own owner.
  assert.deepEqual(unitOwner(rackItems["Rack-06"][1], "Rack-06", data), { owner: "Liran Cohen", server: null });
  assert.deepEqual(unitOwner(rackItems["Rack-05"][1], "Rack-05", data), { owner: "", server: null });
  // A removed server is drawn nowhere and gives no owner.
  assert.equal(floorServer({ servers: [{ ...locations.servers[0], removed: true }] }, "Rack-05", 1), null);
  assert.equal(floorServer(locations, "Rack-05", 1, new Set(["opt51"])), null);
  assert.equal(unitTypeText("patchpanel"), "Patch Panel");
  assert.equal(unitTypeText("weird"), "Other");
});

test("unit model: edit, move (another rack clears the shelf position; Storage-Main), add, choices, history", () => {
  setStorageRacks(["Storage-Main"]);
  const edited = editUnit(rackItems, "u-tray53", { serial_number: "SN-1" });
  assert.equal(edited["Rack-05"][0].serial_number, "SN-1");
  assert.equal(rackItems["Rack-05"][0].serial_number, "TRAY-053", "the input is not changed");
  assert.throws(() => editUnit(rackItems, "gone", {}), /no longer in the equipment list/);
  const moved = moveUnit({ ...rackItems, "Rack-05": [{ ...rackItems["Rack-05"][0], shelf_position: "left" }, rackItems["Rack-05"][1]] }, "u-tray53", "Storage-Main", 0);
  assert.equal(findUnit(moved, "u-tray53").rack, "Storage-Main");
  assert.equal(findUnit(moved, "u-tray53").item.u, 0);
  assert.equal(findUnit(moved, "u-tray53").item.shelf_position, "");
  assert.equal(moved["Rack-05"].length, 1);
  const sameRack = moveUnit(rackItems, "u-tray53", "Rack-05", 2);
  assert.equal(findUnit(sameRack, "u-tray53").item.u, 2);
  assert.equal(sameRack["Rack-05"].length, 2);
  const added = addUnit(rackItems, "Rack-09", { id: "n", name: "New", u: 1 });
  assert.deepEqual(added["Rack-09"], [{ id: "n", name: "New", u: 1 }]);
  assert.throws(() => addUnit(rackItems, " ", {}), /Choose a rack/);
  assert.deepEqual(rackChoices(data).slice(0, 2), ["Storage-Main", "Rack-05"]);
  assert.ok(rackChoices(data).includes("Rack-08") && rackChoices(data).includes("Rack-09"), "device racks and empty unit lists count");
  assert.deepEqual(placeChoices("Rack-05").map(p => p.value), ["1", "2", "3", "4", "0"]);
  assert.equal(placeChoices("Storage-Main").length, 17);
  assert.equal(placeChoices("Storage-Main").at(-1).label, "Whole storage (no shelf)");
  assert.equal(daysSince("2026-01-01T00:00:00Z", Date.parse("2026-01-31T12:00:00Z")), 30);
  assert.equal(daysSince(null), null);
  assert.deepEqual(historyRows({ tracking_history: [{ at: "t1", action: "scanned", to: "Rack-04 · floor 3" }, { at: "t2", action: "moved", from: "A", to: "B", note: "QA" }] }),
    [{ at: "t2", text: "Moved from A to B · QA" }, { at: "t1", text: "Scanned to Rack-04 · floor 3" }]);
});

test("window files write owners per key only, and the unit window saves with If-Match", () => {
  for (const file of ["../server/sections/OwnerNetworkBlock.jsx", "../units/UnitWindow.jsx"]) {
    const source = read(file);
    assert.match(source, /accountRequest\(`\/opt-owners\/\$\{encodeURIComponent\(/, `${file} writes one key`);
    assert.doesNotMatch(source, /["'`]\/opt-owners["'`]\s*,\s*["']PUT["']/, `${file} never writes the unkeyed owner map`);
  }
  assert.match(read("../units/UnitForm.jsx"), /"If-Match": etag/);
  assert.match(read("../server/sections/OwnerNetworkBlock.jsx"), /"If-Match": data\.etags\.switches/);
  // Remove / Delete goes through the one DeleteDialog: the shell's Delete… (ServerWindow deleteTarget), never a route of its own.
  assert.doesNotMatch(read("../server/RemoveAction.jsx"), /\/api\/removed-servers["'`]\s*,\s*\{\s*name/);
  assert.match(read("../server/ServerWindow.jsx"), /deleteTarget=\{\{ kind: "server", id: key \}\} deleteRole="admin"/);
  assert.match(read("../units/UnitWindow.jsx"), /deleteTarget=\{\{ kind: "unit", id: String\(item\.id\) \}\} deleteRole="operator"/);
  assert.match(read("../units/CoolingWindow.jsx"), /deleteTarget=\{\{ kind: "cooling", id: String\(unit\.id\) \}\} deleteRole="admin"/);
});

test("CoolingUnitDialog: embedded is the only change; the dialog keeps its overlay, focus trap and buttons", () => {
  const source = read("../components/racks/CoolingUnitDialog.jsx");
  assert.match(source, /export default function CoolingUnitDialog\(\{ embedded = false, \.\.\.props \}\)/);
  assert.match(source, /const useFocus = embedded \? noFocus : useDialogFocus;/);
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\} tabIndex=\{-1\} className="racks-dialog" data-dialog="cooling"/);
  assert.match(source, /if \(embedded\) return <div ref=\{panelRef\} className="cooling-embedded"/);
});
