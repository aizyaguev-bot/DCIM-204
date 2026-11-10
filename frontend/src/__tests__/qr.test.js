import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { qrSvgPath, QR_QUIET_ZONE } from "../qr.js";
import { labelCode, MAIN_STORAGE } from "../api/inventory.js";

const labels = [
  { rack: "Rack-01", u: 4, position: "" },
  { rack: "Rack:01 / בדיקה", u: 42, position: "Left: front / A" },
  { rack: "Rack-07", u: 0, position: "" },
  { rack: MAIN_STORAGE, u: 0, position: "" },
];

// Re-rasterise the SVG path: every "M x y h n v1 h-n z" paints n modules of row y.
function drawn(qr) {
  const grid = Array.from({ length: qr.size }, () => new Array(qr.size).fill(0));
  const runs = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let consumed = 0, match;
  while ((match = runs.exec(qr.path))) {
    consumed += match[0].length;
    const [x, y, length, back] = match.slice(1).map(Number);
    assert.equal(length, back);
    for (let i = 0; i < length; i++) {
      assert.equal(grid[y][x + i], 0, "runs never overlap");
      grid[y][x + i] = 1;
    }
  }
  assert.equal(consumed, qr.path.length, "the path holds drawing commands only, never label text");
  return grid;
}

// ISO 18004 format information, read from the copy beside the top-left finder (column 8).
function errorCorrectionBits(grid, modules, margin) {
  const at = (row, col) => grid[row + margin][col + margin];
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    const row = i < 6 ? i : i < 8 ? i + 1 : modules - 15 + i;
    bits |= at(row, 8) << i;
  }
  return ((bits ^ 0b101010000010010) >> 13) & 0b11;
}

test("label QR codes draw exactly the encoded symbol for the label value", () => {
  for (const label of labels) {
    const code = labelCode(label);
    const qr = qrSvgPath(code);
    const expected = QRCode.create(code, { errorCorrectionLevel: "M" }).modules;
    assert.equal(qr.modules, expected.size);
    assert.equal(qr.size, expected.size + 2 * QR_QUIET_ZONE);
    const grid = drawn(qr);
    for (let y = 0; y < expected.size; y++) for (let x = 0; x < expected.size; x++) {
      assert.equal(grid[y + QR_QUIET_ZONE][x + QR_QUIET_ZONE], expected.data[y * expected.size + x] ? 1 : 0);
    }
  }
});

test("label QR codes keep a four-module white quiet zone, finder patterns and medium error correction", () => {
  for (const label of labels) {
    const qr = qrSvgPath(labelCode(label));
    const grid = drawn(qr);
    const m = QR_QUIET_ZONE;
    assert.equal(m, 4);
    for (let i = 0; i < qr.size; i++) for (let j = 0; j < m; j++) {
      for (const [y, x] of [[j, i], [qr.size - 1 - j, i], [i, j], [i, qr.size - 1 - j]]) assert.equal(grid[y][x], 0, "quiet zone stays white");
    }
    for (const [oy, ox] of [[0, 0], [0, qr.modules - 7], [qr.modules - 7, 0]]) {
      for (let i = 0; i < 7; i++) {
        for (const [y, x] of [[0, i], [6, i], [i, 0], [i, 6]]) assert.equal(grid[m + oy + y][m + ox + x], 1, "finder ring is dark");
      }
    }
    assert.equal(errorCorrectionBits(grid, qr.modules, m), 0b00, "format information says error correction M");
  }
});

test("label values are short printable ASCII, so a QR or barcode scanner types the same text", () => {
  for (const label of labels) {
    const code = labelCode(label);
    assert.match(code, /^[\x21-\x7e]+$/);
    assert.ok(qrSvgPath(code).version <= 5, `${code} stays a small, easily scanned symbol`);
  }
});
