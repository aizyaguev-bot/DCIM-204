import test from "node:test";
import assert from "node:assert/strict";
import { detectColumns, detectDelimiter, headerKey, parseDetails, requestItems, serialsText, splitRows } from "../api/serialDetails.js";

test("column names are recognised in any common spelling, Hebrew included", () => {
  assert.deepEqual(detectColumns(["SN", "P/N", "Description", "Type"]), { serial: 0, part_number: 1, name: 2, type: 3 });
  assert.deepEqual(detectColumns(["Serial Number", "Part Number", "Product Name"]), { serial: 0, part_number: 1, name: 2 });
  assert.deepEqual(detectColumns(["serial_number", "PN", "Model"]), { serial: 0, part_number: 1, model: 2 });
  assert.deepEqual(detectColumns(["S/N", "OPN", "Product"]), { serial: 0, part_number: 1, name: 2 });
  assert.deepEqual(detectColumns(["מספר סידורי", 'מק"ט', "תיאור"]), { serial: 0, part_number: 1, name: 2 });
  assert.deepEqual(detectColumns(["Serial #", "Part No.", "Name", "Model", "Product Type"]), { serial: 0, part_number: 1, name: 2, model: 3, type: 4 });
  // Looser headers: "Unit serial (SN)" and "Item part number" are found by what they contain.
  assert.deepEqual(detectColumns(["Unit serial (SN)", "Item part number", "Long description"]), { serial: 0, part_number: 1, name: 2 });
  assert.equal(headerKey(' Serial-Number '), "serialnumber");
  assert.equal(headerKey('מק"ט'), "מקט");
});

test("tab, comma and semicolon tables split with CSV quoting", () => {
  assert.equal(detectDelimiter("SN\tP/N\nA\tB"), "\t");
  assert.equal(detectDelimiter("SN;P/N;Name\nA;B;C"), ";");
  assert.equal(detectDelimiter("﻿SN,P/N\nA,B"), ",");
  assert.deepEqual(splitRows('SN,Name\r\nMT1,"Switch, 1U ""QM9700"""\r\n\r\nMT2,"two\nlines"\n', ","),
    [["SN", "Name"], ["MT1", 'Switch, 1U "QM9700"'], ["MT2", "two\nlines"]]);
});

test("rows pasted from Excel or a web table become import rows", () => {
  const pasted = "SN\tP/N\tDescription\n MT2614X00001 \tMSN2700-CS2F\tSpectrum   SN2700 switch\nMT2614X00002\tMQM9700-NS2F\tQuantum-2 QM9700\n";
  const parsed = parseDetails(pasted);
  assert.equal(parsed.error, "");
  assert.deepEqual(parsed.rows, [
    { line: 2, serial: "MT2614X00001", part_number: "MSN2700-CS2F", model: "", type: "", name: "Spectrum SN2700 switch" },
    { line: 3, serial: "MT2614X00002", part_number: "MQM9700-NS2F", model: "", type: "", name: "Quantum-2 QM9700" },
  ]);
  assert.deepEqual(parsed.columns, { serial: 0, part_number: 1, name: 2 });
});

test("a title line above the header row is skipped, and a Model column alone is also the name", () => {
  const parsed = parseDetails("SN analysis results\nSerial Number,Model,PN\nMT1,QM9700,MQM9700-NS2F\n");
  assert.equal(parsed.error, "");
  assert.deepEqual(parsed.rows, [{ line: 3, serial: "MT1", part_number: "MQM9700-NS2F", model: "QM9700", type: "", name: "QM9700" }]);
});

test("the DCIM export reads back: its formula guard apostrophe is removed", () => {
  const exported = "﻿serial,barcode,name,type,part_number,model,rack,u,position,place,lookup_as\r\n'-CABLE-9,,Cable,cable,'+PN,,Rack-01,1,,Rack-01 · U1,switch\r\n";
  const parsed = parseDetails(exported);
  assert.equal(parsed.error, "");
  assert.equal(parsed.rows[0].serial, "-CABLE-9");
  assert.equal(parsed.rows[0].part_number, "+PN");
  assert.equal(parsed.rows[0].type, "cable");
});

test("rows without a serial or without details, and conflicting repeats, are left out with a reason", () => {
  const parsed = parseDetails([
    "SN,P/N,Name",
    ",MSN2700,Spectrum",            // line 2: no serial
    "MT1,,",                        // line 3: no details
    "MT2,P2,Two",                   // line 4
    "mt2,P2,Two",                   // line 5: identical repeat, counted once
    "MT3,P3,Three",                 // line 6
    "MT3,P4,Three",                 // line 7: same serial, other details
    "MT4," + "P".repeat(121) + ",x", // line 8: part number too long
  ].join("\n"));
  assert.equal(parsed.error, "");
  assert.deepEqual(parsed.rows.map(r => r.serial), ["MT2"]);
  assert.deepEqual(parsed.problems.map(p => p.line), [2, 3, 6, 7, 8]);
  assert.match(parsed.problems[2].reason, /more than once with different details/);
});

test("a table without a serial or a details column explains what it needs", () => {
  assert.match(parseDetails("").error, /Paste rows/);
  assert.match(parseDetails("Name,P/N\nA,B").error, /No serial number column/);
  assert.match(parseDetails("SN,Location\nA,B").error, /No details column/);
  assert.match(parseDetails("SN,P/N\nA,\n").error, /No row has both/);
});

test("request items: rows without a type are switches when marked so, names are cut to 160 characters", () => {
  const rows = parseDetails(`SN\tName\tType\nMT1\t${"N".repeat(200)}\t\nMT2\tCable thing\tCable\n`).rows;
  assert.equal(rows[0].name.length, 160);
  assert.deepEqual(requestItems(rows, { source: "webpe SN analysis" }), [
    { serial: "MT1", name: "N".repeat(160), type: "switch", source: "webpe SN analysis" },
    { serial: "MT2", name: "Cable thing", type: "Cable", source: "webpe SN analysis" },
  ]);
  assert.deepEqual(requestItems(rows, { markSwitch: false }).map(item => item.type), [undefined, "Cable"]);
});

test("serials text has one code per line, a barcode when there is no serial", () => {
  assert.equal(serialsText([{ serial: "MT1", barcode: "B1" }, { serial: "", barcode: "000777" }, { serial: "", barcode: "" }]), "MT1\n000777");
});
