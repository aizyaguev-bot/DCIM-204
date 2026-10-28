// node --test src/__tests__/rack-rows.test.js
// DcimView.buildRackRows: non-computer outlet labels never take a U slot, exactly like the 3D Twin.
// buildRackRows lives in a JSX module, so its (plain JS) source is evaluated here without React or a bundler.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAIN_STORAGE } from "../api/inventory.js";

const dcimSource = readFileSync(new URL("../pages/DcimView.jsx", import.meta.url), "utf8");
const start = dcimSource.indexOf("export function buildRackRows(");
const end = dcimSource.indexOf("return { rows, uMap, sorted };", start);
assert.ok(start >= 0 && end > start, "buildRackRows found in DcimView.jsx");
const fnSource = dcimSource.slice(start, dcimSource.indexOf("\n}", end) + 2).replace(/^export /, "");   // up to the closing brace
// The module-level label filter, evaluated from its source text like buildRackRows itself.
const dcimRegex = /const NON_SERVER_LABEL = (\/.+\/[a-z]*);/.exec(dcimSource)?.[1];
assert.ok(dcimRegex, "NON_SERVER_LABEL found in DcimView.jsx");
const NON_SERVER_LABEL = new Function(`return ${dcimRegex};`)();
const buildRackRows = new Function("MAIN_STORAGE", "NON_SERVER_LABEL", `${fnSource}; return buildRackRows;`)(MAIN_STORAGE, NON_SERVER_LABEL);

// isDefaultOutletLabel and isServerLabel: the two small exported helpers, evaluated the same way.
function extract(name) {
  const at = dcimSource.indexOf(`export function ${name}(`);
  assert.ok(at >= 0, `${name} found in DcimView.jsx`);
  return dcimSource.slice(at, dcimSource.indexOf("\n}", at) + 2).replace(/^export /, "");
}
const isServerLabel = new Function("NON_SERVER_LABEL", `${extract("isDefaultOutletLabel")}\n${extract("isServerLabel")}; return isServerLabel;`)(NON_SERVER_LABEL);

const server = (id, name = id.toUpperCase()) => ({ id, name });
const used = rows => rows.filter(r => r.items.length).map(r => [r.u, r.items.map(i => i.data.name)]);

test("an 'empty' label sorted before four computers does not push the fourth to U5", () => {
  const servers = [server("empty", "empty"), server("opt71"), server("opt72"), server("opt73"), server("opt74")];
  const { uMap, sorted, rows } = buildRackRows(servers, "Rack-07", {}, {}, {});
  assert.deepEqual(sorted.map(s => s.id), ["opt71", "opt72", "opt73", "opt74"]);
  assert.deepEqual(uMap, { opt71: 1, opt72: 2, opt73: 3, opt74: 4 });
  assert.deepEqual(used(rows), [[1, ["OPT71"]], [2, ["OPT72"]], [3, ["OPT73"]], [4, ["OPT74"]]]);
});

test("KVM power, PDU and placeholder labels are skipped in any position; real names stay", () => {
  const servers = [server("kvm power", "KVM Power"), server("opt1"), server("pdu", "PDU"), server("dash", "--"),
    server("na", "n/a"), server("free", " Free "), server("spare", "SPARE"), server("kvm_power", "kvm_power"), server("opt2"),
    server("empty-box", "empty box")];
  const { uMap } = buildRackRows(servers, "Rack-01", {}, {}, {});
  assert.deepEqual(uMap, { "empty-box": 1, opt1: 2, opt2: 3 });
});

test("explicit rack_slots and rack order still decide the U of real servers", () => {
  const servers = [server("empty", "empty"), server("opt1"), server("opt2"), server("opt3")];
  const { uMap } = buildRackRows(servers, "Rack-01", { "Rack-01": ["opt3", "empty", "opt1", "opt2"] }, { "Rack-01": { opt2: 1 } }, {});
  assert.deepEqual(uMap, { opt2: 1, opt3: 2, opt1: 3 });
});

test("the 3D Twin filters exactly the same labels", () => {
  const twin = readFileSync(new URL("../../../lab-twin/app.js", import.meta.url), "utf8");
  const twinRegex = /const NON_SERVER_LABEL = (\/.+\/[a-z]*);/.exec(twin)?.[1];
  assert.ok(twinRegex && dcimRegex);
  assert.equal(dcimRegex, twinRegex);
  // one module-level copy in DcimView, used by buildRackRows and by isServerLabel
  assert.equal(dcimSource.match(/const NON_SERVER_LABEL = /g).length, 1);
  assert.match(fnSource, /NON_SERVER_LABEL\.test\(/);
  // and the Twin applies it before assigning U slots (see computeModel's server list)
  assert.match(twin, /NON_SERVER_LABEL\.test\(label\.trim\(\)\)/);
});

test("isServerLabel: real names are servers; default outlet names and non-computer labels are not", () => {
  for (const label of ["OPT64", "opt11", " Opt106 ", "empty box", "KVM-01 host", "PDU2-node"]) assert.equal(isServerLabel(label), true, label);
  for (const label of ["", "   ", "Outlet 3", "port 12", "empty", " Empty ", "KVM Power", "kvm_power", "kvm-power", "PDU", "spare",
    "FREE", "n/a", "-", "---"]) assert.equal(isServerLabel(label), false, JSON.stringify(label));
});

test("the DCIM server list (and so every OPT count, the rack meta and the KPI bar) uses isServerLabel", () => {
  const at = dcimSource.indexOf("const servers = useMemo(");
  assert.ok(at >= 0);
  const memo = dcimSource.slice(at, dcimSource.indexOf("},[pdus,pduStatuses,rackOverrides]);", at));
  assert.equal(memo.match(/if\(!isServerLabel\(/g)?.length, 2, "stored and live labels are both filtered");
  assert.doesNotMatch(memo, /isDefaultOutletLabel/);
});

test("Storage-Main draws its occupied shelves in order, then the whole-unit equipment; no empty shelves", () => {
  const servers = [server("opt63"), server("opt72")];
  const { rows } = buildRackRows(servers, MAIN_STORAGE, {}, { [MAIN_STORAGE]: { opt72: 3 } },
    { [MAIN_STORAGE]: [{ id: "ci-spare", name: "Spare", type: "switch", u: 0 }] });
  assert.deepEqual(used(rows), [[1, ["OPT63"]], [3, ["OPT72"]], [0, ["Spare"]]]);
  assert.equal(rows.length, 3);
  // a storage unit holding only equipment, or nothing, draws no shelf rows
  assert.deepEqual(buildRackRows([], MAIN_STORAGE, {}, {}, { [MAIN_STORAGE]: [{ id: "a", name: "A", u: 0 }] }).rows.map(r => r.u), [0]);
  assert.deepEqual(buildRackRows([], MAIN_STORAGE, {}, {}, {}).rows, []);
});

test("equipment with a U outside 0-42 or not a whole number is listed on row 0 and does not stretch the rack", () => {
  const custom = { "Rack-02": [-1, 99, 1.5, "abc", null, true].map((u, i) => ({ id: `ci-${i}`, name: `E${i}`, u })) };
  const { rows, sorted } = buildRackRows([], "Rack-02", {}, {}, custom);
  assert.equal(sorted.length, 0);
  assert.ok(rows.length <= 9, `rows: ${rows.length}`);
  assert.deepEqual(used(rows), [[0, ["E0", "E1", "E2", "E3", "E4", "E5"]]]);
  // valid U values keep their shelf, including the edges and an old numeric string
  const ok = buildRackRows([], "Rack-02", {}, {}, { "Rack-02": [{ id: "a", name: "A", u: 0 }, { id: "b", name: "B", u: 42 }, { id: "c", name: "C", u: "7" }] });
  assert.deepEqual(used(ok.rows), [[7, ["C"]], [42, ["B"]], [0, ["A"]]]);
  assert.equal(ok.rows.length, 45);
});

test("rows mark auto-placed OPTs (no saved U) so they do not look like a saved U", () => {
  const servers = [server("opt11"), server("opt12"), server("opt13")];
  const { rows } = buildRackRows(servers, "Rack-01", {}, { "Rack-01": { opt13: 5 } },
    { "Rack-01": [{ id: "sw", name: "Switch", u: 2 }, { id: "pp", name: "Patch", u: 6 }] });
  const flag = Object.fromEntries(rows.filter(r => r.items.length).map(r => [r.u, r.auto]));
  assert.deepEqual(flag, { 1: true, 2: true, 5: false, 6: false });
  assert.ok(rows.filter(r => !r.items.length).every(r => r.auto === false));
});

test("auto-U parity vector shared with the backend mirror (C7)", () => {
  const rack01 = ["opt11", "opt12", "opt13", "opt14"].map(id => server(id));
  assert.deepEqual(buildRackRows(rack01, "Rack-01", {}, { "Rack-01": { opt13: 7 } }, {}).uMap, { opt11: 1, opt12: 2, opt14: 3, opt13: 7 });
  const rack05 = ["opt51", "opt52", "opt53", "opt54"].map(id => server(id));
  assert.deepEqual(buildRackRows(rack05, "Rack-05", {}, {}, {}).uMap, { opt51: 1, opt52: 2, opt53: 3, opt54: 4 });
  // equipment does not block an OPT's shelf
  assert.deepEqual(buildRackRows(rack05, "Rack-05", {}, {}, { "Rack-05": [{ id: "sw", name: "SW", u: 1 }] }).uMap,
    { opt51: 1, opt52: 2, opt53: 3, opt54: 4 });
});

test("the equipment U field accepts only a whole number from 0 to 42", () => {
  const parseUSlot = new Function(`${extract("parseUSlot")}; return parseUSlot;`)();
  for (const [text, u] of [["0", 0], ["7", 7], [" 7 ", 7], ["07", 7], ["42", 42]]) assert.equal(parseUSlot(text), u, text);
  for (const text of ["", " ", "-1", "43", "99", "1.5", "1e1", "abc", "007", null, undefined]) assert.equal(parseUSlot(text), null, String(text));
  assert.match(dcimSource, /U_SLOT_ERROR = "U slot must be a whole number from 0 to 42\."/);   // the server's own wording (C8)
});

test("the open rack can be owned by the App (C3): RacksView is controlled with onSelectRack, local otherwise", () => {
  assert.match(dcimSource, /export default function DcimView\(\{[^)]*\brack, onRackChange\}\)/);
  assert.match(dcimSource, /<RacksView selectedRack=\{rack\} onSelectRack=\{onRackChange\}/);
  const at = dcimSource.indexOf("function RacksView(");
  const body = dcimSource.slice(at, dcimSource.indexOf("\n}\n", at));
  assert.match(body, /const selectedRack\s+= onSelectRack \? \(rackProp \|\| null\) : localRack;/);
  assert.match(body, /const setSelectedRack = onSelectRack \|\| setLocalRack;/);
  // without the App, ?rack= is still read once, as before
  assert.match(body, /useState\(\(\) => onSelectRack \? null : new URLSearchParams\(location\.search\)\.get\("rack"\)\)/);
  // saving a rack from the grid does not push a needless history entry
  assert.match(body, /if \(selectedRack\) setSelectedRack\(null\);/);
  assert.doesNotMatch(body, /onRefresh\?\.\(\); setSelectedRack\(null\)/);
});
