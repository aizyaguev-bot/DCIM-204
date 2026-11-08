import test from "node:test";
import assert from "node:assert/strict";
import { parseUnitBarcode, typeForPart, productForPart, serialUnitType, isGenericUnit, UNIT_CODE_MAX } from "../api/scanParse.js";

test("a plain NVIDIA / Mellanox serial is the unit's code and serial", () => {
  const unit = parseUnitBarcode("  mt2604603m8u\r\n");
  assert.equal(unit.code, "MT2604603M8U");
  assert.equal(unit.serial, "MT2604603M8U");
  assert.equal(unit.type, "switch", "a serial number alone is most likely a switch (the lab owner's rule)");
  assert.equal(unit.name, "Switch", "the name is the product (here only its type), never the serial");
});

test("a serial number marks a unit as a switch unless the label names another product", () => {
  const cases = [
    ["SN: MT2629X00QA1", "switch", "Switch"],
    ["SN: S-9; PN: UNKNOWN-PN", "switch", "UNKNOWN-PN"],
    ["SN: S-9; Model: BlueField-3", "other", "BlueField-3"],
    ["SN: S-9; Model: ConnectX-7 adapter", "other", "ConnectX-7 adapter"],
    ["SN: S-9; PN: MBF2H516A-CEEOT", "other", "BlueField DPU"],
    ["SN: S-9; PN: MCX75310AAS-NEAT", "other", "ConnectX-7 NIC"],
    ["SN: S-9; PN: MCP1600-C003", "cable", "DAC cable"],
    ["(01)07290108410123(21)MT2614X01234", "switch", "Switch"],
    ["00:1a:2b:3c:4d:5e", "other", "Unit"],
  ];
  for (const [raw, type, name] of cases) {
    const unit = parseUnitBarcode(raw);
    assert.deepEqual([unit.type, unit.name], [type, name], raw);
  }
});

test("any other single code is kept as it is (the existing fixture codes still match) and is the unit's serial number", () => {
  for (const code of ["TEST-001", "SN123", "00000123", "Rack switch 7", "TESTSN12345"]) {
    const unit = parseUnitBarcode(code);
    assert.equal(unit.code, code);
    assert.equal(unit.raw, code);
    assert.equal(unit.serial, code);
    assert.equal(unit.serial_from_code, true);
    assert.equal(unit.mac, "");
    assert.equal(unit.name, "Switch");
    assert.equal(unit.type, "switch");
  }
  assert.equal(parseUnitBarcode("MT2604603M8U").serial_from_code, false, "a label's own serial is not a code taken as one");
});

test("GS1 with brackets: serial (21) is the code, part number (240) gives type and name", () => {
  const unit = parseUnitBarcode("(01)07290108410123(21)MT2614X01234(240)MQM8790-HS2F");
  assert.equal(unit.code, "MT2614X01234");
  assert.equal(unit.serial, "MT2614X01234");
  assert.equal(unit.part_number, "MQM8790-HS2F");
  assert.equal(unit.gtin, "07290108410123");
  assert.equal(unit.type, "switch");
  assert.equal(unit.name, "Quantum QM8700 switch");
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
  assert.equal(a.name, "Raritan PX4-5874", "the model is the name");
  const b = parseUnitBarcode("PN:MCX623106AN-CDAT SN:MT2251X09876");
  assert.equal(b.part_number, "MCX623106AN-CDAT");
  assert.equal(b.serial, "MT2251X09876");
  assert.equal(b.type, "other");
  assert.equal(b.name, "ConnectX-6 NIC");
  const c = parseUnitBarcode("sn=ABC-1;pn=DKX4-101");
  assert.equal(c.type, "kvm");
  assert.equal(c.code, "ABC-1");
  assert.equal(c.name, "DKX4-101", "an unknown part number is its own name");
});

test("the name is the product: model, the product of a known part number, the part number, else the type", () => {
  const nic = parseUnitBarcode("SN: MT2245X01234; PN: MCX75310AAS-NEAT");
  assert.deepEqual([nic.name, nic.serial, nic.part_number, nic.code, nic.serial_from_code], ["ConnectX-7 NIC", "MT2245X01234", "MCX75310AAS-NEAT", "MT2245X01234", false]);
  assert.equal(parseUnitBarcode("SN: S-1; PN: MSN2100-CB2F").name, "MSN2100-CB2F");
  assert.equal(parseUnitBarcode("SN: S-1; PN: MCX75310AAS-NEAT; Model: CX7 card").name, "CX7 card", "a model on the label wins");
  assert.equal(parseUnitBarcode("(21)S-2(240)MCP1600-C003").name, "DAC cable");
  assert.equal(parseUnitBarcode("SN: S-3; Model: QM9700").name, "QM9700");
  for (const raw of ["MT2604603M8U", "(21)S-4(240)MQM8790-HS2F", "SN: MT2245X01234; PN: MCX75310AAS-NEAT", "PLAIN-1"]) {
    const unit = parseUnitBarcode(raw);
    assert.ok(!unit.name.includes(unit.serial), `${raw}: the name never carries the serial`);
  }
});

test("known NVIDIA / Mellanox part-number prefixes name their product; anything else names none", () => {
  const cases = {
    "MCX75310AAS-NEAT": "ConnectX-7 NIC", "MCX623106AN-CDAT": "ConnectX-6 NIC", "MCX516A-CCAT": "ConnectX-5 NIC",
    "MBF2H332A-AEEOT": "BlueField DPU", "MQM9700-NS2F": "Quantum-2 QM9700 switch", "MQM8790-HS2F": "Quantum QM8700 switch",
    "MSN2700-CS2F": "Spectrum SN2700 switch", "MSN3700-VS2F": "Spectrum-2 SN3700 switch", "MSN4600-VS2FC": "Spectrum-3 SN4000 switch",
    "MCP1650-H001E30": "DAC cable", "MFS1S00-H010E": "Optical cable/transceiver", "mma1t00-hs": "Optical cable/transceiver",
    "MSN2100-CB2F": "", "MCX4121A-ACAT": "", "PX4-5874": "", "": "",
  };
  for (const [part, product] of Object.entries(cases)) assert.equal(productForPart(part), product, part);
});

test("a MAC address alone identifies the unit", () => {
  const unit = parseUnitBarcode("b8cef6a1b2c3");
  assert.equal(unit.mac, "B8:CE:F6:A1:B2:C3");
  assert.equal(unit.code, "B8:CE:F6:A1:B2:C3");
  assert.equal(unit.raw, "b8cef6a1b2c3");
  assert.equal(unit.serial, "", "a MAC is not a serial number");
  assert.equal(unit.serial_from_code, false);
  assert.equal(parseUnitBarcode("b8ce.f6a1.b2c3").mac, "B8:CE:F6:A1:B2:C3", "every form the server reads as a MAC");
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
  assert.equal(unit.name, "ב".repeat(100));
  assert.ok(Array.from(parseUnitBarcode(`SN: S-1; PN: ${"P".repeat(200)}`).name).length <= 160);
  assert.equal(Array.from(parseUnitBarcode(`Model: ${"ב".repeat(150)}\nSN: MT2604603M8U`).model).length, 120);
});

test("the serial-number-means-switch rule does not catch servers, boards or other vendors' units", () => {
  const typeOf = raw => parseUnitBarcode(raw).type;
  // a model or description that names a server or compute node
  for (const raw of ["SN: X1; Model: DGX H100", "SN: X1; Model: HGX B200", "SN: X1; Model: PowerEdge R760 server", "SN: X1; Model: ProLiant DL380",
    "SN: X1; Model: Compute tray", "SN: X1; Description: GPU node 3", "(21)X1(240)DGX-A100"]) assert.equal(typeOf(raw), "other", raw);
  // an NVIDIA board / GPU OPN, as a part number, in the model, or scanned on its own
  for (const raw of ["SN: X1; PN: 900-9X766-003N-SQ0", "SN: X1; Model: 699-2G133-0200-100", "900-9X766-003N-SQ0"]) assert.equal(typeOf(raw), "other", raw);
  // another vendor's unit is a switch only when its label says so
  assert.equal(typeOf("SN: X1; Model: Cisco Nexus 9300"), "other");
  assert.equal(typeOf("SN: X1; Model: Arista 7050"), "other");
  assert.equal(typeOf("SN: X1; Model: Cisco Nexus 9300 switch"), "switch");
  assert.equal(parseUnitBarcode("SN: X1; Model: DGX H100").name, "DGX H100", "the name is still the product");
  assert.equal(parseUnitBarcode("SN: X1; Description: GPU node 3").name, "GPU node 3", "a description names the product when there is no model");
  // still a switch: a serial alone, an NVIDIA switch model or part number, a serial that only looks like a word
  for (const raw of ["MT2629X00QA1", "TESTSN12345", "SN: X1; Model: SN2700", "SN: X1; PN: MQM9700-NS2F", "SN: NODE-12", "SN: X1; Model: Spectrum-4 SN5600"]) assert.equal(typeOf(raw), "switch", raw);
  // the shared rule itself
  assert.equal(serialUnitType({}), "switch");
  assert.equal(serialUnitType({ model: "DGX Station" }), "other");
  assert.equal(serialUnitType({ part_number: "MCP1600-C003" }), "cable", "a known part type keeps its type");
  assert.equal(serialUnitType({ part_number: "MCX75310AAS-NEAT" }), "other");
  assert.equal(serialUnitType({ code: "900-9X766-003N-SQ0" }), "other");
});

test("a generic unit: type other, named Unit or after its own code", () => {
  assert.equal(isGenericUnit({ type: "other", name: "Unit" }), true);
  assert.equal(isGenericUnit({ name: "unit" }), true, "no type is other");
  assert.equal(isGenericUnit({ type: "other", name: "MT2629X00QA2", barcode: "mt2629x00qa2" }), true, "named after its barcode");
  assert.equal(isGenericUnit({ id: "ci-9", type: "other", name: "ci-9" }), true, "named after its id");
  assert.equal(isGenericUnit({ type: "other", name: "UPS box" }), false, "a name that says what it is");
  assert.equal(isGenericUnit({ type: "switch", name: "Unit" }), false, "identified as something else");
  assert.equal(isGenericUnit({ type: "computer", name: "Unit" }), false);
});
