import test from "node:test";
import assert from "node:assert/strict";
import { locationCode, parseLocationCode, rackCode, mainStorageCode, MAIN_STORAGE } from "../api/inventory.js";

test("shelf labels round-trip rack and precise position, including punctuation and Hebrew", () => {
  const expected = { rack: "Rack:01 / בדיקה", u: 4, position: "Left: front / A" };
  assert.deepEqual(parseLocationCode(locationCode(expected.rack, expected.u, expected.position)), expected);
});

test("whole rack and main storage labels never default to shelf 1", () => {
  assert.deepEqual(parseLocationCode(rackCode("Rack-07")), { rack: "Rack-07", u: 0, position: "" });
  assert.deepEqual(parseLocationCode(rackCode("Rack: / בדיקה")), { rack: "Rack: / בדיקה", u: 0, position: "" });
  assert.deepEqual(parseLocationCode(mainStorageCode), { rack: MAIN_STORAGE, u: 0, position: "" });
});

test("malformed rack and storage labels are rejected before equipment lookup", () => {
  for (const code of ["RACK:", "RACK:x:1", "RACK:%GG", "RACK:%00", "RACK:Storage-Main", "STORE:OTHER", "STORE:MAIN:1", "LOC:Storage-Main:1:"]) assert.throws(() => parseLocationCode(code));
});

test("normal equipment barcode is not interpreted as a location", () => {
  for (const code of ["00000123", "MT2604603M8U", "ci-123"]) assert.equal(parseLocationCode(code), null);
});

test("invalid shelf labels never become saved locations", () => {
  for (const code of ["LOC:x:0:", "LOC:x:43:", "LOC:x:1.5:", "LOC:x:abc:", "LOC::1:", "LOC:x:1", "LOC:%GG:1:"]) {
    assert.throws(() => parseLocationCode(code));
  }
});
