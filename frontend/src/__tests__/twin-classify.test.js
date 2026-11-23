import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyTwin, classifyTwinJson } from "../lab/twinRecords.js";

// The 3D link rule (v2 §M.5) has three copies: frontend/src/lab/twinRecords.js (here), lab-twin/classify.js (WP-7 adds
// it to this test) and backend/app/lab_trash.py (backend/tests/test_twin_classify.py). One hand-written fixture pins
// them all.
const fixture = JSON.parse(readFileSync(new URL("../../../backend/tests/fixtures/twin_classify.json", import.meta.url), "utf8"));
const byId = list => Object.fromEntries(list.map(o => [o.id, o.reason]));

test("the shared fixture has a case for every rule", () => {
  const names = fixture.cases.map(c => c.name).join("\n");
  for (const rule of [/device id/, /unique normalized name/, /same name/, /optKey/, /equipment/, /hidden/, /chiller/, /other item types/, /setups/, /storage/]) {
    assert.match(names, rule);
  }
});

for (const c of fixture.cases) {
  test(`frontend classifyTwin: ${c.name}`, () => {
    const got = classifyTwinJson(c.twin, c.live);
    assert.deepEqual(got.linked, c.expected.linked, "linked records");
    assert.deepEqual(byId(got.only), byId(c.expected.only), "3D-only records and their reasons");
    assert.equal(got.only.length, c.expected.only.length, "each record listed once");
  });
}

test("classifyTwin returns a Map and lists each record's type", () => {
  const { linked, only } = classifyTwin({ items: [{ id: "I1", type: "cart", name: "Cart" }], storage: [{ id: "S1", name: "Cabinet" }], setups: [{ id: "U1" }] }, {});
  assert.ok(linked instanceof Map);
  assert.deepEqual(only.map(o => [o.id, o.type]), [["I1", "cart"], ["S1", "storage"], ["U1", "setup"]]);
  assert.deepEqual(classifyTwin(null, null).only, [], "no 3D data: nothing to list");
});

test("the fixture's unchanged lab-data.json is the ids-mismatch case (no JSON PDU or KVM links to pdu1-7 / kvm1 by id)", () => {
  const twin = JSON.parse(readFileSync(new URL("../../../lab-twin/lab-data.json", import.meta.url), "utf8"));
  const devices = [...Array.from({ length: 7 }, (_, i) => ({ id: `pdu${i + 1}`, kind: "pdu", name: `PDU 0${i + 1}` })),
    { id: "pdu8", kind: "pdu", name: "PDU-Rack-08" }, { id: "kvm1", kind: "kvm", name: "KVM 01" }, { id: "kvm2", kind: "kvm", name: "KVM 02" }];
  const { linked, only } = classifyTwin(twin, { devices, racks: ["Rack-01", "Rack-02", "Rack-03", "Rack-04", "Rack-05", "Rack-06", "Rack-07"] });
  assert.equal(linked.get("ITEM-0040"), "dev:pdu8", "PDU-Rack-08 links by its unique name");
  const reasons = byId(only);
  assert.equal(reasons["ITEM-0033"], "No PDU with id pdu-rack01 or name PDU-Rack-01 in Lab Manager");
  assert.equal(reasons["ITEM-0043"], "No KVM with id kvm-unit3 or name KVM-Unit-3 in Lab Manager");
  assert.equal(reasons["ITEM-0041"], "No KVM with id kvm-unit1 or name KVM-Unit-1 in Lab Manager");
  assert.equal(reasons["ITEM-0044"], "3D only");
  assert.equal(linked.get("SETUP-007"), "rack:Rack-07");
});
