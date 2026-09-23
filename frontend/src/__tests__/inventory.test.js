import test from "node:test";
import assert from "node:assert/strict";
import { locationCode, parseLocationCode } from "../api/inventory.js";

test("shelf labels round-trip rack and precise position, including punctuation and Hebrew", () => {
  const expected = { rack: "Rack:01 / בדיקה", u: 4, position: "Left: front / A" };
  assert.deepEqual(parseLocationCode(locationCode(expected.rack, expected.u, expected.position)), expected);
});

test("normal equipment barcode is not interpreted as a location", () => {
  for (const code of ["00000123", "MT2604603M8U", "ci-123"]) assert.equal(parseLocationCode(code), null);
});

test("invalid shelf labels never become saved locations", () => {
  for (const code of ["LOC:x:0:", "LOC:x:43:", "LOC:x:1.5:", "LOC:x:abc:", "LOC::1:", "LOC:x:1", "LOC:%GG:1:"]) {
    assert.throws(() => parseLocationCode(code));
  }
});
