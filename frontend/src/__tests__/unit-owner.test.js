// node --test src/__tests__/unit-owner.test.js
// A unit's owner (unitOwner.js): the owner of the server on its floor, else its own saved owner.
import test from "node:test";
import assert from "node:assert/strict";
import { floorServer, unitOwner, rowsUnitOwners, unitOwners, withUnitOwners, ownerOfUnit, ownerFromText, itemOwnerKey } from "../unitOwner.js";
import { buildShelfLabels } from "../shelfLabels.js";
import { buildSearchIndex, searchIndex } from "../components/racks/rackView.js";

const server = (id, name) => ({ kind: "server", data: { id, name } });
const unit = (id, fields = {}) => ({ kind: "custom", data: { id, name: id, ...fields } });

test("a unit on a floor with a server takes the server's owner, not its own", () => {
  const rows = [{ u: 2, items: [server("opt12", "OPT12"), unit("tray")] }];
  const shown = rowsUnitOwners(rows, { opt12: "Ariel Vinograd", "item:tray": "Dana" });
  assert.equal(shown.tray.owner, "Ariel Vinograd");
  assert.equal(shown.tray.server.name, "OPT12");
});

test("several servers on one floor: the first in slot order", () => {
  const row = { u: 1, items: [server("b", "OPT20"), server("a", "OPT10"), unit("tray")] };
  assert.equal(floorServer(row).id, "b");
  assert.equal(rowsUnitOwners([row], { a: "Owner A", b: "Owner B" }).tray.owner, "Owner B");
});

test("the server has no owner: the unit has none either (its own saved owner does not count there)", () => {
  const shown = rowsUnitOwners([{ u: 3, items: [server("s", "OPT3"), unit("tray")] }], { "item:tray": "Dana" });
  assert.deepEqual([shown.tray.owner, shown.tray.server.id], ["", "s"]);
});

test("no server on the floor, the rack level or a storage shelf without a server: the unit's own owner, else none", () => {
  const rows = [
    { u: 1, items: [unit("alone")] },
    { u: 2, items: [unit("nobody")] },
    { u: 0, items: [server("s0", "OPT0"), unit("whole")] },
  ];
  const shown = rowsUnitOwners(rows, { s0: "Server owner", "item:alone": "Dana", "item:whole": "Rack owner" });
  assert.deepEqual(shown.alone, { owner: "Dana", server: null });
  assert.deepEqual(shown.nobody, { owner: "", server: null });
  assert.deepEqual(shown.whole, { owner: "Rack owner", server: null }, "u 0 is no floor");
  assert.equal(floorServer({ u: 0, items: [server("s0", "OPT0")] }), null);
  assert.equal(floorServer(null), null);
  const storage = unitOwners([{ rack: "Storage-Main", rows: [{ u: 7, items: [unit("box")] }, { u: 3, items: [server("s72", "OPT72"), unit("nic")] }] }],
    { s72: "Hardware team", "item:box": "Eden Levi", "item:nic": "Someone" });
  assert.equal(storage.box.owner, "Eden Levi");
  assert.equal(storage.nic.owner, "Hardware team", "a storage shelf with a server: the server's owner");
});

test("the shown owner follows a move and a change of the server's owner", () => {
  const owners = { opt11: "Owner 1", opt12: "Owner 2", "item:tray": "Own" };
  const at = u => unitOwners([{ rack: "Rack-01", rows: [
    { u: 1, items: [server("opt11", "OPT11"), ...(u === 1 ? [unit("tray")] : [])] },
    { u: 2, items: [server("opt12", "OPT12"), ...(u === 2 ? [unit("tray")] : [])] },
    { u: 4, items: u === 4 ? [unit("tray")] : [] },
  ] }], owners).tray.owner;
  assert.deepEqual([at(1), at(2), at(4)], ["Owner 1", "Owner 2", "Own"]);
  const rows = [{ u: 1, items: [server("opt11", "OPT11"), unit("tray")] }];
  assert.equal(unitOwners([{ rack: "Rack-01", rows }], { ...owners, opt11: "New owner" }).tray.owner, "New owner");
});

test("withUnitOwners: units by the rule, servers and unlisted units unchanged, the saved map untouched", () => {
  const saved = { opt12: "Ariel", "item:tray": "Dana", "item:gone": "Kept", "item:none": "Old" };
  const before = JSON.stringify(saved);
  const shown = withUnitOwners(saved, { tray: { owner: "Ariel", server: { id: "opt12" } }, none: { owner: "", server: { id: "x" } }, solo: { owner: "", server: null } });
  assert.deepEqual(shown, { opt12: "Ariel", "item:tray": "Ariel", "item:gone": "Kept" });
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(withUnitOwners(null, null), {});
  assert.equal(ownerOfUnit(shown, "tray"), "Ariel");
  assert.equal(ownerOfUnit(shown, "none"), "");
  assert.equal(ownerOfUnit(undefined, "tray"), "");
  assert.equal(itemOwnerKey("ci-1"), "item:ci-1");
  assert.deepEqual(unitOwner("x", null, undefined), { owner: "", server: null });
});

test("ownerFromText names the server and its floor or shelf", () => {
  assert.equal(ownerFromText({ name: "OPT12" }), "From OPT12, the server on this floor.");
  assert.equal(ownerFromText({ name: " OPT72 " }, true), "From OPT72, the server on this shelf.");
  assert.equal(ownerFromText(null), "");
});

test("search by the server's owner finds the unit on its floor; the unit's own old owner no longer does", () => {
  const rackStats = [{ rack: "Rack-01", servers: [{ id: "opt12", name: "OPT12" }] }];
  const customItems = { "Rack-01": [{ id: "tray", name: "Portia tray", u: 2 }] };
  const saved = { opt12: "Ariel Vinograd", "item:tray": "Dana" };
  const rows = [{ u: 2, items: [server("opt12", "OPT12"), unit("tray", { name: "Portia tray" })] }];
  const optOwners = withUnitOwners(saved, unitOwners([{ rack: "Rack-01", rows }], saved));
  const index = buildSearchIndex({ rackStats, optOwners, customItems, uMaps: { "Rack-01": { opt12: 2 } } });
  assert.deepEqual([...searchIndex(index, "ariel").keys].sort(), ["e:tray", "s:opt12"]);
  assert.deepEqual([...searchIndex(index, "dana").keys], []);
});

test("shelf labels: a unit-only floor keeps its own owner, a server floor shows the server's owner", () => {
  const rows = [{ u: 1, items: [unit("alone", { name: "Box" })] }, { u: 2, items: [server("opt12", "OPT12"), unit("tray", { name: "Tray" })] }];
  const saved = { opt12: "Ariel", "item:alone": "Dana", "item:tray": "Old" };
  const owners = withUnitOwners(saved, unitOwners([{ rack: "Rack-01", rows }], saved));
  const labels = buildShelfLabels([{ rack: "Rack-01", storage: false, rows }], owners);
  assert.deepEqual(labels.map(l => [l.u, l.owner, l.server]), [[1, "Dana", "—"], [2, "Ariel", "OPT12"]]);
  assert.deepEqual(buildShelfLabels([{ rack: "Rack-01", storage: false, rows }], saved).map(l => l.owner), ["Dana", "Ariel"], "the saved map gives the same labels");
});
