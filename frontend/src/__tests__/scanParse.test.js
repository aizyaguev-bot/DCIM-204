import test from "node:test";
import assert from "node:assert/strict";
import { parseUnitBarcode, typeForPart, UNIT_CODE_MAX } from "../api/scanParse.js";

test("a plain NVIDIA / Mellanox serial is the unit's code and serial", () => {
  const unit = parseUnitBarcode("  mt2604603m8u\r\n");
  assert.equal(unit.code, "MT2604603M8U");
  assert.equal(unit.serial, "MT2604603M8U");
  assert.equal(unit.type, "other");
  assert.equal(unit.name, "MT2604603M8U");
});

test("any other single code is kept as it is (the existing fixture codes still match)", () => {
  for (const code of ["TEST-001", "SN123", "00000123", "Rack switch 7"]) {
    const unit = parseUnitBarcode(code);
    assert.equal(unit.code, code);
    assert.equal(unit.raw, code);
  }
});

test("GS1 with brackets: serial (21) is the code, part number (240) gives type and name", () => {
  const unit = parseUnitBarcode("(01)07290108410123(21)MT2614X01234(240)MQM8790-HS2F");
  assert.equal(unit.code, "MT2614X01234");
  assert.equal(unit.serial, "MT2614X01234");
  assert.equal(unit.part_number, "MQM8790-HS2F");
  assert.equal(unit.gtin, "07290108410123");
  assert.equal(unit.type, "switch");
  assert.equal(unit.name, "MQM8790-HS2F MT2614X01234");
  assert.equal(unit.raw, "(01)07290108410123(21)MT2614X01234(240)MQM8790-HS2F");
});

test("raw GS1 with FNC1 separators and a symbology prefix, in each form a scanner may send", () => {
  for (const raw of ["]C1010729010841012321MT2614X01234\x1d240MCP1600-C003", "]d2010729010841012321MT2614X01234<GS>240MCP1600-C003", "010729010841012321MT2614X01234^]240MCP1600-C003"]) {
    const unit = parseUnitBarcode(raw);
    assert.equal(unit.serial, "MT2614X01234", raw);
    assert.equal(unit.part_number, "MCP1600-C003", raw);
    assert.equal(unit.type, "cable", raw);
    assert.equal(unit.code, "MT2614X01234");
    assert.doesNotMatch(unit.raw, /[\x00-\x1f]/, "never stored with control characters");
  }
});

test("QR key: value labels on lines or one line", () => {
  const a = parseUnitBarcode("Model: Raritan PX4-5874\nS/N: PX4A123456\nMAC: 00-0d-5d-1a-2b-3c");
  assert.equal(a.serial, "PX4A123456");
  assert.equal(a.model, "Raritan PX4-5874");
  assert.equal(a.mac, "00:0D:5D:1A:2B:3C");
  assert.equal(a.type, "pdu");
  assert.equal(a.code, "PX4A123456");
  assert.equal(a.name, "Raritan PX4-5874 PX4A123456");
  const b = parseUnitBarcode("PN:MCX623106AN-CDAT SN:MT2251X09876");
  assert.equal(b.part_number, "MCX623106AN-CDAT");
  assert.equal(b.serial, "MT2251X09876");
  assert.equal(b.type, "other");
  assert.equal(b.name, "MCX623106AN-CDAT MT2251X09876");
  const c = parseUnitBarcode("sn=ABC-1;pn=DKX4-101");
  assert.equal(c.type, "kvm");
  assert.equal(c.code, "ABC-1");
});

test("a MAC address alone identifies the unit", () => {
  const unit = parseUnitBarcode("b8cef6a1b2c3");
  assert.equal(unit.mac, "B8:CE:F6:A1:B2:C3");
  assert.equal(unit.code, "B8:CE:F6:A1:B2:C3");
  assert.equal(unit.raw, "b8cef6a1b2c3");
});

test("part numbers map to unit types", () => {
  assert.equal(typeForPart("MQM8700-HS2F"), "switch");
  assert.equal(typeForPart("MSN2700-CS2F"), "switch");
  assert.equal(typeForPart("MCP1650-H001E30"), "cable");
  assert.equal(typeForPart("MFS1S00-H010E"), "cable");
  assert.equal(typeForPart("PX4-5874"), "pdu");
  assert.equal(typeForPart("DKX4-101"), "kvm");
  assert.equal(typeForPart("MCX75310AAS-NEAT"), "other");
  assert.equal(typeForPart("XYZ-1"), "");
});

test("a code that names only the product (part number, model, GTIN) is refused: it would match the wrong unit", () => {
  for (const raw of ["MQM8790-HS2F", "(01)07290108410123", "Model: Raritan PX4-5874", "PN: MCP1600-C003"]) {
    assert.throws(() => parseUnitBarcode(raw), /only names the product.*serial number barcode/, raw);
  }
});

test("location labels, empty scans and over-long codes are refused with a sentence", () => {
  for (const raw of ["LOC:Rack-01:2:", "rack:Rack-01", "STORE:MAIN"]) assert.throws(() => parseUnitBarcode(raw), /location label/);
  for (const raw of ["", "   ", "\r\n", "]C1"]) assert.throws(() => parseUnitBarcode(raw), /Scan a barcode first/);
  assert.throws(() => parseUnitBarcode("A".repeat(UNIT_CODE_MAX + 1)), /too long/);
  assert.equal(parseUnitBarcode("A".repeat(UNIT_CODE_MAX)).code.length, UNIT_CODE_MAX);
});

test("names stay within 160 characters and keep Hebrew text", () => {
  const unit = parseUnitBarcode(`Model: ${"ב".repeat(100)}\nSN: ${"7".repeat(100)}`);
  assert.equal(Array.from(unit.model).length, 100);
  assert.equal(Array.from(unit.name).length, 160);
  assert.ok(unit.name.startsWith("ב"));
  assert.equal(Array.from(parseUnitBarcode(`Model: ${"ב".repeat(150)}\nSN: MT2604603M8U`).model).length, 120);
});
