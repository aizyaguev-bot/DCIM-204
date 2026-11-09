// node --test src/__tests__/shelf-labels.test.js
// Shelf labels (shelfLabels.js): one three-line label per server on each floor / storage shelf.
import test from "node:test";
import assert from "node:assert/strict";
import { buildShelfLabels, labelText, labelsText, labelLines, productName, labelWhere, withEdits, LABEL_NONE } from "../shelfLabels.js";

const server = (id, name) => ({ kind: "server", data: { id, name } });
const unit = (id, fields) => ({ kind: "custom", data: { id, ...fields } });
const rack = (name, rows, storage = false) => ({ rack: name, storage, rows });

test("the owner's example: project, owner, server name", () => {
  const labels = buildShelfLabels([rack("Rack-01", [{ u: 2, items: [server("s146", "OPTN146"), unit("i1", { name: "Portia tray" })] }])],
    { s146: "Ariel Vinograd" });
  assert.equal(labels.length, 1);
  assert.equal(labelText(labels[0]), "project: Portia tray\nowner: Ariel Vinograd\nOPTN146");
  assert.equal(labels[0].where, "Rack-01 · Floor 2");
  assert.equal(labels[0].u, 2);
  assert.equal(labels[0].rack, "Rack-01");
});

test("an empty floor gets no label; the rack level and floors above 4 never do", () => {
  const labels = buildShelfLabels([rack("Rack-01", [
    { u: 1, items: [] },
    { u: 0, items: [server("s0", "OPT0"), unit("i0", { name: "Rack PDU" })] },
    { u: 5, items: [server("s5", "OPT5")] },
  ])]);
  assert.deepEqual(labels, []);
});

test("a unit without a server: its name, its owner, and — for the server", () => {
  const [label, ...rest] = buildShelfLabels([rack("Rack-02", [{ u: 3, items: [unit("i3", { name: "Switch A" })] }])], { "item:i3": "Dana" });
  assert.equal(rest.length, 0);
  assert.deepEqual(labelLines(label), ["project: Switch A", "owner: Dana", LABEL_NONE]);
  const [noOwner] = buildShelfLabels([rack("Rack-02", [{ u: 3, items: [unit("i3", { name: "Switch A" })] }])]);
  assert.equal(labelText(noOwner), `project: Switch A\nowner: ${LABEL_NONE}\n${LABEL_NONE}`);
});

test("two servers on one floor: one label each, same project, own owners, slot order", () => {
  const labels = buildShelfLabels([rack("Rack-03", [{ u: 1, items: [server("a", "OPT10"), server("b", "OPT11"), unit("u1", { name: "Tray X" }), unit("u2", { name: "Tray Y" })] }])],
    { a: "Owner A" });
  assert.deepEqual(labels.map(labelLines), [
    ["project: Tray X", "owner: Owner A", "OPT10"],
    ["project: Tray X", `owner: ${LABEL_NONE}`, "OPT11"],
  ]);
  assert.notEqual(labels[0].key, labels[1].key);
  assert.equal(labelsText(labels), "project: Tray X\nowner: Owner A\nOPT10\n\nproject: Tray X\nowner: —\nOPT11");
});

test("a server with no unit and no owner", () => {
  const [label] = buildShelfLabels([rack("Rack-04", [{ u: 4, items: [server("x", "OPT40")] }])]);
  assert.equal(labelText(label), "project: —\nowner: —\nOPT40");
});

test("storage shelves: Shelf N, shelves 1-16 only", () => {
  const labels = buildShelfLabels([rack("Storage-Main", [
    { u: 3, items: [server("s", "OPT72"), unit("i", { name: "Spare PSU" })] },
    { u: 16, items: [unit("j", { name: "Cable box" })] },
    { u: 17, items: [server("t", "OPT99")] },
  ], true)], { s: "Owner S" });
  assert.deepEqual(labels.map(l => [l.where, labelText(l)]), [
    ["Storage-Main · Shelf 3", "project: Spare PSU\nowner: Owner S\nOPT72"],
    ["Storage-Main · Shelf 16", "project: Cable box\nowner: —\n—"],
  ]);
  assert.equal(labelWhere("Storage-Main", 3, true), "Storage-Main · Shelf 3");
});

test("the product name falls back to the model, then the part number", () => {
  assert.equal(productName({ name: "  ", model: "SN4600", part_number: "MSN4600" }), "SN4600");
  assert.equal(productName({ name: "", part_number: "MQM8790-HS2F" }), "MQM8790-HS2F");
  assert.equal(productName({}), "");
  const labels = buildShelfLabels([rack("Rack-05", [
    { u: 1, items: [server("a", "OPT1"), unit("u1", { name: "", model: "SN4600" })] },
    { u: 2, items: [server("b", "OPT2"), unit("u2", { part_number: "MQM8790-HS2F" })] },
    { u: 3, items: [server("c", "OPT3"), unit("u3", {})] },
    { u: 4, items: [server("d", "OPT4"), unit("u4", {}), unit("u5", { name: "Second unit" })] },
  ])]);
  assert.deepEqual(labels.map(l => l.project), ["SN4600", "MQM8790-HS2F", LABEL_NONE, "Second unit"]);
});

test("a Hebrew owner name is kept exactly", () => {
  const [label] = buildShelfLabels([rack("Rack-06", [{ u: 2, items: [server("h", "OPT77"), unit("t", { name: "Portia tray" })] }])], { h: "אריאל וינוגרד" });
  assert.equal(label.owner, "אריאל וינוגרד");
  assert.equal(labelText(label), "project: Portia tray\nowner: אריאל וינוגרד\nOPT77");
});

test("labels follow rack order, then floor order; edits change only the printout copy", () => {
  const labels = buildShelfLabels([
    rack("Rack-B", [{ u: 2, items: [server("b2", "OPT-B2")] }, { u: 1, items: [server("b1", "OPT-B1")] }]),
    rack("Rack-A", [{ u: 1, items: [server("a1", "OPT-A1")] }]),
  ]);
  assert.deepEqual(labels.map(l => l.server), ["OPT-B1", "OPT-B2", "OPT-A1"]);
  const edited = withEdits(labels[0], { [labels[0].key]: { project: "Custom", owner: "" } });
  assert.equal(labelText(edited), "project: Custom\nowner: —\nOPT-B1");
  assert.equal(labels[0].project, LABEL_NONE, "the built label is not changed");
  assert.equal(withEdits(labels[1], {}), labels[1]);
  assert.equal(labelsText([]), "");
  assert.deepEqual(buildShelfLabels(null), []);
});
