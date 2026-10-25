// node --test src/__tests__/gap-views.test.js
// Regression tests for pure helpers that pages and components already export but no runnable test covered:
// DcimView (rack rows, outlet-label classification), ConnectionsView (rack options, filters), the PDU maintenance
// column and dialog, What's New text, and the assistant work-item helpers.
// The helpers live in .jsx modules, so (like rack-rows.test.js and connections.test.js) their plain-JS source is
// sliced out and evaluated without React, a JSX loader or a bundler. Nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAIN_STORAGE } from "../api/inventory.js";
import { normalizeDraft, PRIORITIES } from "../api/assistant.js";

// Evaluate the source between two markers of a product file and return its exported helpers by name.
function loadHelpers(file, from, to, deps = {}) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${JSON.stringify(from)} … ${JSON.stringify(to)} found in ${file}`);
  const body = source.slice(start, end);
  const names = [...body.matchAll(/^export (?:const|function) (\w+)/gm)].map(m => m[1]);
  assert.ok(names.length, `exported helpers found in ${file}`);
  const code = body.replace(/^export (?=const |function )/gm, "");
  return new Function(...Object.keys(deps), `"use strict";\n${code}\nreturn { ${names.join(", ")} };`)(...Object.values(deps));
}

// Strict expected failure: the test passes while the bug is present and fails once the product code is fixed,
// so the marker cannot silently outlive the bug.
function knownBug(name, reason, fn) {
  test(`${name} [xfail] ${reason}`, () => {
    let failed = false;
    try { fn(); } catch (error) { if (!(error instanceof assert.AssertionError)) throw error; failed = true; }
    assert.ok(failed, `Expected failure passed: the bug looks fixed, turn this back into a normal test (${reason})`);
  });
}

const { isDefaultOutletLabel, buildRackRows } =
  loadHelpers("../pages/DcimView.jsx", "export function isDefaultOutletLabel(", "// ─── primitives", { MAIN_STORAGE });
const { connectionRacks, filterConnections } =
  loadHelpers("../pages/ConnectionsView.jsx", "export function connectionRacks(", "\nfunction ConnectionList");
const { formatMaintenanceTime, maintenanceStateFor } =
  loadHelpers("../components/MaintenanceColumn.jsx", "export function formatMaintenanceTime(", "export default function");
const { isNamedOutlet, passwordLabel } =
  loadHelpers("../components/MaintenanceDialog.jsx", "export const isNamedOutlet", "// The password is read");
const { plain } = loadHelpers("../components/WhatsNew.jsx", "export function plain(", "export function SectionBody(");
const { draftPayload } = loadHelpers("../components/assistant/DraftEditor.jsx", "export const LIMITS",
  "export function PriorityBadge(", { normalizeDraft, PRIORITIES });
const { normalizeItems } = loadHelpers("../components/assistant/WorkItemsList.jsx", "const STATUS = {",
  "export default function WorkItemsList(", { normalizeDraft });

// ─── DcimView.buildRackRows ─────────────────────────────────────────────────────────────────────────────────
const srv = (id, name = id.toUpperCase()) => ({ id, name });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const used = rows => rows.filter(r => r.items.length).map(r => [r.u, r.items.map(i => i.data.name)]);

test("a rack is at least 8 U tall and keeps 2 free U above its highest occupied shelf", () => {
  const empty = buildRackRows([], "Rack-01", {}, {}, {});
  assert.deepEqual(empty.rows.map(r => r.u), range(1, 8));
  assert.ok(empty.rows.every(r => Array.isArray(r.items) && r.items.length === 0));

  const seven = ["a", "b", "c", "d", "e", "f", "g"].map(id => srv(id));
  assert.deepEqual(buildRackRows(seven, "Rack-01", {}, {}, {}).rows.map(r => r.u), range(1, 9));

  const high = buildRackRows([srv("a")], "Rack-01", {}, { "Rack-01": { a: 20 } }, {});
  assert.deepEqual(high.rows.map(r => r.u), range(1, 22));
  assert.deepEqual(used(high.rows), [[20, ["A"]]]);
});

test("rack equipment sits on its recorded U, beside a server on the same U, and can extend the rack", () => {
  const custom = { "Rack-01": [{ id: "sw1", name: "Switch", type: "switch", u: 2 }, { id: "pp", name: "Patch", type: "patchpanel", u: "12" }] };
  const { rows } = buildRackRows([srv("opt1"), srv("opt2")], "Rack-01", {}, {}, custom);
  assert.deepEqual(rows.map(r => r.u), range(1, 14));
  assert.deepEqual(rows[1].items.map(i => [i.kind, i.data.name]), [["server", "OPT2"], ["custom", "Switch"]]);
  assert.deepEqual(rows[11].items.map(i => [i.kind, i.data.id]), [["custom", "pp"]]);
  assert.deepEqual(used(rows), [[1, ["OPT1"]], [2, ["OPT2", "Switch"]], [12, ["Patch"]]]);
});

test("equipment without a usable U is listed once, in a whole-rack row after the numbered shelves", () => {
  const items = [{ id: "a", name: "A", u: "" }, { id: "b", name: "B", u: null }, { id: "c", name: "C" },
    { id: "d", name: "D", u: "abc" }, { id: "e", name: "E", u: 0 }, { id: "f", name: "F", u: 3 }];
  const { rows } = buildRackRows([], "Rack-02", {}, {}, { "Rack-02": items });
  assert.deepEqual(rows.map(r => r.u), [...range(1, 8), 0]);
  assert.deepEqual(rows.at(-1).items.map(i => i.data.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(rows[2].items.map(i => i.data.id), ["f"]);
  assert.equal(rows.filter(r => r.u === 0).length, 1);
});

test("main storage has no U shelves: its equipment is one whole-unit row and an empty store has no rows", () => {
  const stored = [{ id: "x", name: "Spare PSU", u: 0 }, { id: "y", name: "Cables", u: 0 }];
  const { rows } = buildRackRows([], MAIN_STORAGE, {}, {}, { [MAIN_STORAGE]: stored });
  assert.deepEqual(rows, [{ u: 0, items: [{ kind: "custom", data: stored[0] }, { kind: "custom", data: stored[1] }], auto: false }]);
  assert.deepEqual(buildRackRows([], MAIN_STORAGE, {}, {}, {}).rows, []);
  // Same equipment in a normal rack still gets the 8 numbered shelves.
  assert.equal(buildRackRows([], "Rack-01", {}, {}, { "Rack-01": stored }).rows.length, 9);
});

test("auto-placed servers fill the free U around explicit rack_slots, lowest first", () => {
  const servers = ["a", "b", "c", "d", "e"].map(id => srv(id));
  const { uMap, rows } = buildRackRows(servers, "Rack-01", {}, { "Rack-01": { b: 1, d: 3 } }, {});
  assert.deepEqual(uMap, { a: 2, b: 1, c: 4, d: 3, e: 5 });
  assert.deepEqual(used(rows), [[1, ["B"]], [2, ["A"]], [3, ["D"]], [4, ["C"]], [5, ["E"]]]);
});

test("two servers saved on the same U share that row instead of one being hidden, and auto-fill skips it", () => {
  const servers = [srv("a"), srv("b"), srv("c")];
  const { uMap, rows } = buildRackRows(servers, "Rack-01", {}, { "Rack-01": { a: 1, b: 1 } }, {});
  assert.deepEqual(uMap, { a: 1, b: 1, c: 2 });
  assert.deepEqual(used(rows), [[1, ["A", "B"]], [2, ["C"]]]);
});

test("rack_slots values stored as JSON strings behave like numbers", () => {
  const { uMap, rows } = buildRackRows([srv("a"), srv("b")], "Rack-01", {}, { "Rack-01": { a: "1", b: "3" } }, {});
  assert.deepEqual(uMap, { a: 1, b: 3 });
  assert.equal(typeof uMap.a, "number");
  assert.deepEqual(used(rows), [[1, ["A"]], [3, ["B"]]]);
  // A string slot still blocks that U for auto-placed servers.
  const mixed = buildRackRows([srv("a"), srv("b")], "Rack-01", {}, { "Rack-01": { b: "1" } }, {});
  assert.deepEqual(mixed.uMap, { a: 2, b: 1 });
});

test("only the rack's own saved order counts: listed servers first, unlisted after, stale ids ignored", () => {
  const servers = [srv("a"), srv("b"), srv("c"), srv("d")];
  const order = { "Rack-01": ["gone", "d", "b", "also-gone"], "Rack-02": ["a", "c"] };
  const slots = { "Rack-02": { c: 1 } };
  const { sorted, uMap } = buildRackRows(servers, "Rack-01", order, slots, {});
  assert.deepEqual(sorted.map(s => s.id), ["d", "b", "a", "c"]);
  assert.deepEqual(uMap, { d: 1, b: 2, a: 3, c: 4 });
});

test("servers without a saved order are placed alphabetically regardless of letter case", () => {
  const servers = [srv("g", "gamma"), srv("b", "Beta"), srv("a", "alpha"), srv("d", "Delta")];
  const { sorted, uMap } = buildRackRows(servers, "Rack-01", {}, {}, {});
  assert.deepEqual(sorted.map(s => s.name), ["alpha", "Beta", "Delta", "gamma"]);
  assert.deepEqual(uMap, { a: 1, b: 2, d: 3, g: 4 });
});

test("building rows never reorders or edits the caller's servers, order or slot data", () => {
  const servers = [srv("c"), srv("empty", "empty"), srv("a"), srv("b")];
  const order = { "Rack-01": ["b"] }, slots = { "Rack-01": { a: 5 } }, custom = { "Rack-01": [{ id: "x", u: 2 }] };
  const before = structuredClone({ servers, order, slots, custom });
  const result = buildRackRows(servers, "Rack-01", order, slots, custom);
  assert.deepEqual({ servers, order, slots, custom }, before);
  assert.notEqual(result.sorted, servers);
});

test("non-server labels are matched as whole words after trimming, never as part of a server name", () => {
  const skipped = ["Kvm-Power", "KVM  power", "  EMPTY  ", "N/A", "---", "Pdu", "free"];
  const kept = ["pdu2", "empty1", "free-opt", "n/a box", "-opt-", "kvm power 2", "spares"];
  const servers = [...skipped, ...kept].map((name, i) => srv(`s${i}`, name));
  const { sorted } = buildRackRows(servers, "Rack-01", {}, {}, {});
  assert.deepEqual(sorted.map(s => s.name).sort(), [...kept].sort());
  assert.equal(Object.keys(buildRackRows(servers, "Rack-01", {}, {}, {}).uMap).length, kept.length);
});

test("one malformed rack_slots value must not hide the other servers of the rack",
  () => {
    const { rows } = buildRackRows([srv("opt1"), srv("opt2"), srv("opt3")], "Rack-01", {}, { "Rack-01": { opt2: "U3" } }, {});
    // Whatever a fix does with the bad slot, the rack keeps its numbered shelves and the valid servers on them.
    const shown = rows.filter(r => r.u >= 1).flatMap(r => r.items.map(i => i.data.name));
    assert.ok(rows.length >= 8, `rack rendered ${rows.length} rows`);
    assert.deepEqual(["OPT1", "OPT3"].filter(name => shown.includes(name)), ["OPT1", "OPT3"]);
  });

test("a server whose saved U is not a whole number is listed at rack level; uMap keeps the saved value for the Twin", () => {
  for (const bad of ["U3", 2.5, -1]) {
    const { rows, uMap } = buildRackRows([srv("opt1"), srv("opt2"), srv("opt3")], "Rack-01", {}, { "Rack-01": { opt2: bad } }, {});
    assert.deepEqual(used(rows), [[1, ["OPT1"]], [2, ["OPT3"]], [0, ["OPT2"]]], JSON.stringify(bad));
    assert.deepEqual(rows.map(r => r.u), [...range(1, 8), 0]);
    assert.ok(Object.is(uMap.opt2, Number(bad)), JSON.stringify(bad));
  }
});

// ─── DcimView.isDefaultOutletLabel ──────────────────────────────────────────────────────────────────────────
test("default outlet/port labels are recognised with or without spaces and padding; real names are not", () => {
  for (const label of [undefined, "Outlet12", "  port 7 ", "PORT\t3", "outlet   4", "\n"]) {
    assert.equal(isDefaultOutletLabel(label), true, JSON.stringify(label));
  }
  for (const label of ["Outlet 1A", "Outlets 1", "Port", "Outlet", "Opt 1", "port 7 spare", "1"]) {
    assert.equal(isDefaultOutletLabel(label), false, JSON.stringify(label));
  }
});

// ─── ConnectionsView ────────────────────────────────────────────────────────────────────────────────────────
const conn = (key, rack, pdu = [], kvm = [], extra = {}) => ({ key, name: key.toUpperCase(), rack, pdu, kvm, ...extra });
const keys = rows => rows.map(row => row.key);

test("rack options sort naturally and ignore letter case, like the backend's natural_key", () => {
  const servers = [conn("a", "rack-10"), conn("b", "Rack-2"), conn("c", "rack-1-10"), conn("d", "", [{ rack: "rack-1-9" }]),
    conn("e", null, [{ rack: null }, { rack: "Rack-2" }]), { key: "f", name: "F" }];
  assert.deepEqual(connectionRacks(servers), ["rack-1-9", "rack-1-10", "Rack-2", "rack-10"]);
});

test("an unknown coverage filter value keeps every server instead of hiding them", () => {
  const servers = [conn("a", "R1", [{ rack: "R1" }]), conn("b", "R1", [], [{ port: 1 }])];
  assert.deepEqual(keys(filterConnections(servers, { connection: "bogus" })), ["a", "b"]);
  assert.deepEqual(keys(filterConnections(servers, {})), ["a", "b"]);
});

test("the rack filter is an exact match on the server rack or one of its PDU outlets' racks", () => {
  const servers = [conn("a", "Rack-1"), conn("b", "Rack-10"), conn("c", "rack-1"), conn("d", "Rack-1A"),
    conn("e", "", [{ rack: "Rack-1" }]), conn("f", "", [], [{ rack: "Rack-1", port: 3 }])];
  assert.deepEqual(keys(filterConnections(servers, { rack: "Rack-1" })), ["a", "e"]);
});

test("search finds outlet power state, ping status and non-numeric port names", () => {
  const servers = [
    conn("a", "R1", [{ device_name: "PDU-A", port: 3, state: "off" }], [], { ping_status: "up" }),
    conn("b", "R1", [{ device_name: "PDU-B", port: 4, state: "on" }], [{ device_name: "KVM-1", port: "A1" }], { ping_status: "down" }),
  ];
  assert.deepEqual(keys(filterConnections(servers, { search: "off" })), ["a"]);
  assert.deepEqual(keys(filterConnections(servers, { search: "DOWN" })), ["b"]);
  assert.deepEqual(keys(filterConnections(servers, { search: "#a1" })), ["b"]);
  assert.deepEqual(keys(filterConnections(servers, { search: "#3" })), ["a"]);
});

// ─── PDU maintenance column and dialog ──────────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, "0");

// formatMaintenanceTime uses the runtime's default locale. The literal HH:MM checks below hold for locales that write a
// 24-hour time as ASCII digits with ':' (en, he, de, ...); on others (fi-FI '13.07', ar '١٣:٠٧') they are skipped.
const colonLocale = new Date(2000, 0, 1, 13, 7).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) === "13:07";

test("maintenance times: missing is a dash, today is 24-hour HH:MM (midnight 00:05), older entries add the date", t => {
  assert.equal(formatMaintenanceTime(null), "—");
  assert.equal(formatMaintenanceTime(undefined), "—");
  if (!colonLocale) { t.skip(`default locale ${Intl.DateTimeFormat().resolvedOptions().locale} does not write HH:MM`); return; }
  const midnight = new Date(); midnight.setHours(0, 5, 0, 0);
  assert.equal(formatMaintenanceTime(midnight.getTime() / 1000), "00:05");
  const afternoon = new Date(); afternoon.setHours(13, 7, 0, 0);
  assert.equal(formatMaintenanceTime(afternoon.getTime() / 1000), "13:07");
  const old = new Date(); old.setDate(old.getDate() - 3); old.setHours(23, 59, 0, 0);   // never "today", whatever the clock says
  assert.equal(formatMaintenanceTime(old.getTime() / 1000), `${old.toLocaleDateString()} 23:59`);
  // epoch 0 is a real (1970) timestamp, not "missing"
  const epoch = new Date(0);
  assert.equal(formatMaintenanceTime(0), `${epoch.toLocaleDateString()} ${pad(epoch.getHours())}:${pad(epoch.getMinutes())}`);
});

test("maintenance state is looked up by PDU id as a string key and is null when absent", () => {
  const state = { active: true, outlets_off: [1, 2] };
  const maintenance = { pdus: { 7: state, "12": { active: false } } };
  assert.equal(maintenanceStateFor(maintenance, 7), state);
  assert.equal(maintenanceStateFor(maintenance, "7"), state);
  assert.deepEqual(maintenanceStateFor(maintenance, 12), { active: false });
  assert.equal(maintenanceStateFor(maintenance, 8), null);
  assert.equal(maintenanceStateFor({}, 7), null);
  assert.equal(maintenanceStateFor(null, 7), null);
  assert.equal(maintenanceStateFor(undefined, 7), null);
});

test("the dialog lists only labelled outlets; Raritan 'Outlet N' defaults and restore placeholders are unlabelled", () => {
  for (const outlet of [{ number: 3, label: "OPT71" }, { number: 4, label: "KVM Power" }, { number: 5, label: "Outlet 5 (spare)" }, { number: 6, label: "Outlet 6b" }]) {
    assert.equal(isNamedOutlet(outlet), true, outlet.label);
  }
  for (const outlet of [{ number: 7, label: "Outlet 7" }, { number: 8, label: "" }, { number: 9 }, null, undefined]) {
    assert.equal(isNamedOutlet(outlet), false, JSON.stringify(outlet));
  }
});

test("the password prompt names the account password only in account mode", () => {
  assert.equal(passwordLabel("account"), "Your account password");
  for (const mode of ["shared", "unavailable", undefined, null, "Account"]) {
    assert.equal(passwordLabel(mode), "Lab Manager password", String(mode));
  }
});

// ─── What's New ─────────────────────────────────────────────────────────────────────────────────────────────
test("release notes drop bold and code markers but keep every other character", () => {
  assert.equal(plain("**DCIM:** run `npm test` before **v2.39**"), "DCIM: run npm test before v2.39");
  assert.equal(plain("snake_case #12 *one* a*b ~x~"), "snake_case #12 *one* a*b ~x~");
  assert.equal(plain("כרטיס **ארון** `Rack-01`"), "כרטיס ארון Rack-01");
});

// ─── Assistant work-item helpers ────────────────────────────────────────────────────────────────────────────
test("a work-item draft payload is cleaned exactly as the API stores it", () => {
  const form = {
    title: "  Replace\tPSU \n on OPT71‮ ",
    description: "  line one\r\n\tline two\u0007\u000b  ",
    priority: "urgent",
    rationale: "⁦because⁩ fan failed ",
    steps: [{ key: "s1", text: " power off \n OPT71 " }, { key: "s2", text: " \t " }, { key: "s3", text: "swap\u0000 PSU" }],
    entity_refs: [{ kind: "server", id: "opt71", label: "OPT71", extra: "dropped" }],
  };
  assert.deepEqual(draftPayload(form), {
    title: "Replace PSU on OPT71",
    description: "line one\r\n\tline two",
    entity_refs: [{ kind: "server", id: "opt71", label: "OPT71" }],
    priority: "medium",
    rationale: "because fan failed",
    steps: ["power off OPT71", "swap PSU"],
  });
});

test("a work-item draft keeps valid priorities and turns missing text into empty strings", () => {
  for (const priority of ["high", "medium", "low"]) {
    const payload = draftPayload({ title: null, description: undefined, priority, rationale: null, steps: [], entity_refs: [] });
    assert.deepEqual(payload, { title: "", description: "", entity_refs: [], priority, rationale: "", steps: [] });
  }
});

test("work items load from any list shape and drop entries without an id", () => {
  const raw = [
    { id: 7, title: "Swap PSU", status: "done", priority: "high", created_at: "2026-10-01T08:00:00Z", updated_at: 5, created_by: "ada", updated_by: 3 },
    null, "text", ["array"], { title: "no id" }, { id: "", title: "blank id" },
    { id: "w2", title: "Check KVM", status: "archived", priority: "bogus" },
    { id: 0, title: "zero id" },
  ];
  const items = normalizeItems(raw);
  assert.deepEqual(items.map(i => i.id), ["7", "w2", "0"]);
  assert.deepEqual([items[0].status, items[0].priority, items[0].created_at, items[0].updated_at, items[0].created_by, items[0].updated_by],
    ["done", "high", "2026-10-01T08:00:00Z", null, "ada", ""]);
  assert.deepEqual([items[1].status, items[1].priority, items[1].created_at], ["saved", "medium", null]);
  assert.deepEqual(normalizeItems({ items: raw }), items);
  assert.deepEqual(normalizeItems({ work_items: raw }), items);
  for (const empty of [null, undefined, {}, { items: "x" }, "list"]) assert.deepEqual(normalizeItems(empty), [], String(empty));
});
