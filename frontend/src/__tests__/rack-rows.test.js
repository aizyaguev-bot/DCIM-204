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
const buildRackRows = new Function("MAIN_STORAGE", `${fnSource}; return buildRackRows;`)(MAIN_STORAGE);

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
  const dcimRegex = /const NON_SERVER_LABEL = (\/.+\/[a-z]*);/.exec(fnSource)?.[1];
  assert.ok(twinRegex && dcimRegex);
  assert.equal(dcimRegex, twinRegex);
  // and the Twin applies it before assigning U slots (see computeModel's server list)
  assert.match(twin, /NON_SERVER_LABEL\.test\(label\.trim\(\)\)/);
});
