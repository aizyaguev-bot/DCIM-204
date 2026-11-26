import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROUPS, applyOrRepreview, confirmRule, confirmed, defaultOptions, groupPlan, initialSelection, optionsFor,
  restoredText, targetKey, undoText } from "../lab/deletePlan.js";
import { applyDelete, listDeleted, previewDelete, purgeDeleted, restoreDeleted, undoDelete } from "../api/labDelete.js";
import { patchDevice } from "../api/devices.js";

// The one delete dialog's rules (v2 spec §D.2): grouping, option defaults, the confirm rules (button / name / count),
// evidence rows unticked in a bulk preview, and the 409 re-preview. Plus the request helpers of api/labDelete.js and
// api/devices.js.

const item = (kind, id, name, evidence = []) => ({ kind, id, name, evidence, info: [] });
const PLAN = {
  plan_revision: '"r1"',
  items: [item("device", "pdu8", "PDU-Rack-08")],
  consequences: {
    servers_deleted: [{ key: "opt81", text: "OPT81 (only on PDU-Rack-08)" }],
    twin_deleted: [{ key: "ITEM-0040", text: "PDU-Rack-08 (ITEM-0040): 3D record of PDU-Rack-08" }],
    alerts_closed: [{ key: "device-api:pdu8", title: "PDU-Rack-08: PDU API availability", text: "PDU-Rack-08: PDU API availability: alert closed" }],
    notes: [],
  },
  blockers: [],
  screens: ["Racks", "Manage", "3D twin"],
};

test("the plan is grouped in the dialog's order; empty groups are left out", () => {
  const shown = groupPlan(PLAN);
  assert.deepEqual(shown.also.map(g => g.key), ["servers_deleted", "alerts_closed", "twin_deleted"]);
  assert.deepEqual(shown.also.find(g => g.key === "twin_deleted").rows, ["PDU-Rack-08 (ITEM-0040): 3D record of PDU-Rack-08"]);
  assert.deepEqual(shown.also.find(g => g.key === "alerts_closed").rows, ["PDU-Rack-08: PDU API availability: alert closed"]);
  assert.deepEqual(shown.screens, ["Racks", "Manage", "3D twin"]);
  assert.deepEqual(groupPlan({ ...PLAN, blockers: [{ text: "PDU 04 is in maintenance mode; restore it first." }] }).blockers,
    ["PDU 04 is in maintenance mode; restore it first."]);
  assert.deepEqual(groupPlan(null), { items: [], also: [], blockers: [], screens: [] });
  // every backend consequence group has a title
  const backend = readFileSync(new URL("../../../backend/app/lab_trash.py", import.meta.url), "utf8");
  const listed = /CONSEQUENCES = \(([^)]*)\)/s.exec(backend)[1].match(/"([a-z_]+)"/g).map(s => s.slice(1, -1));
  assert.deepEqual(GROUPS.map(([key]) => key).sort(), [...listed].sort());
});

test("option defaults follow the spec table and only the options of the targets' kinds", () => {
  assert.deepEqual(defaultOptions([{ kind: "device", id: "pdu8" }]), { orphan_servers: true, twin_records: true });
  assert.deepEqual(defaultOptions([{ kind: "server", id: "opt11" }]), { twin_records: true, keep_labels: false, floor_units: false });
  assert.deepEqual(defaultOptions([{ kind: "rack", id: "Rack-07" }]),
    { orphan_servers: true, twin_records: true, rack_units: "storage", twin_frame: true });
  assert.deepEqual(defaultOptions([{ kind: "unit", id: "u1" }]), { twin_records: true, unit_server: true });
  assert.deepEqual(defaultOptions([{ kind: "twin", id: "STORAGE-01" }]), { twin_contents: true });
  assert.deepEqual(defaultOptions([{ kind: "server", id: "opt11" }], { keep_labels: true }).keep_labels, true);
});

test("option labels carry the preview's counts; unit_server is for Admins only", () => {
  const targets = [{ kind: "device", id: "pdu8" }];
  const labels = optionsFor(targets, PLAN, { admin: true }).map(o => o.label);
  assert.deepEqual(labels, ["Delete the 1 server that is only on these devices (servers that still answer are kept)",
    "Delete their 3D records (1)"]);
  const unitPlan = { ...PLAN, items: [item("unit", "u-pc300", "OPT300")],
    consequences: { servers_deleted: [{ key: "opt300", name: "OPT300", text: "OPT300 (it is only pinged; unit OPT300)" }] } };
  const unit = [{ kind: "unit", id: "u-pc300" }];
  assert.ok(optionsFor(unit, unitPlan, { admin: true }).some(o => o.name === "unit_server" && /OPT300/.test(o.label)));
  assert.ok(!optionsFor(unit, unitPlan, { admin: false }).some(o => o.name === "unit_server"));
  const rack = optionsFor([{ kind: "rack", id: "Rack-07" }], { consequences: { twin_deleted: [{ key: "SETUP-007", text: "x" }] } }, {});
  assert.deepEqual(rack.find(o => o.name === "rack_units").choices, [["storage", "Move to Storage-Main"], ["delete", "Delete them"]]);
  assert.equal(rack.find(o => o.name === "twin_frame").label, "Also delete its 3D frame (SETUP-007)");
});

test("confirm: a button naming the one item, its name when it shows signs of life, the count for several", () => {
  assert.deepEqual(confirmRule([item("device", "pdu8", "PDU-Rack-08")]),
    { mode: "button", expected: "", label: "Delete PDU-Rack-08", prompt: "" });
  const named = confirmRule([item("device", "pdu3", "PDU 03", ["Answers now"])]);
  assert.equal(named.mode, "name");
  assert.equal(named.prompt, "Type PDU 03 to delete it");
  assert.equal(confirmed(named, "pdu 0"), false);
  assert.equal(confirmed(named, " pdu 03 "), true);
  const count = confirmRule([item("unit", "a", "A"), item("unit", "b", "B"), item("unit", "c", "C")]);
  assert.deepEqual([count.mode, count.prompt, count.label], ["count", "Type 3 to delete 3 items", "Delete 3 items"]);
  assert.equal(confirmed(count, "2"), false);
  assert.equal(confirmed(count, "3"), true);
  assert.equal(confirmed(confirmRule([item("device", "pdu8", "PDU-Rack-08")]), ""), true);
});

test("a bulk preview starts with the rows that show signs of life unticked; one item is always ticked", () => {
  const rows = [item("device", "pdu3", "PDU 03", ["Answers now"]), item("device", "pdu8", "PDU-Rack-08"), item("unit", "u1", "Tray")];
  assert.deepEqual([...initialSelection(rows)], ["device:pdu8", "unit:u1"]);
  assert.deepEqual([...initialSelection([rows[0]])], ["device:pdu3"]);
  assert.equal(targetKey({ kind: "server", id: "opt11" }), "server:opt11");
});

test("a 409 runs the preview again with the same targets and options; other errors only say why", async () => {
  const calls = [];
  const changed = Object.assign(new Error("The lab changed since the preview. Nothing was changed; preview again."), { status: 409 });
  const api = {
    applyDelete: async (...args) => { calls.push(["apply", ...args]); throw changed; },
    previewDelete: async (...args) => { calls.push(["preview", ...args]); return { ...PLAN, plan_revision: '"r2"' }; },
  };
  const targets = [{ kind: "device", id: "pdu8" }];
  const out = await applyOrRepreview(api, { targets, options: { orphan_servers: false }, plan: PLAN, reason: "Gone" });
  assert.equal(out.plan.plan_revision, '"r2"');
  assert.match(out.error, /preview below is up to date/);
  assert.deepEqual(calls, [["apply", targets, { orphan_servers: false }, '"r1"', "Gone"], ["preview", targets, { orphan_servers: false }]]);
  const forbidden = { applyDelete: async () => { throw Object.assign(new Error("Only an Admin can delete"), { status: 403 }); },
    previewDelete: async () => assert.fail("no preview for a 403") };
  assert.deepEqual(await applyOrRepreview(forbidden, { targets, options: {}, plan: PLAN }), { error: "Only an Admin can delete" });
  const ok = { applyDelete: async () => ({ batch: { id: "b1", entries: [{ name: "PDU-Rack-08" }] } }) };
  assert.equal((await applyOrRepreview(ok, { targets, options: {}, plan: PLAN })).result.batch.id, "b1");
});

test("the toast names one item or counts several", () => {
  assert.equal(undoText({ batch: { entries: [{ kind: "device", id: "pdu8", name: "PDU-Rack-08" }] } }), "Deleted PDU-Rack-08");
  assert.equal(undoText({ batch: { entries: [{ name: "A" }, { name: "B" }, { name: "C" }] } }), "Deleted 3 items");
});

test("the Undo toast says when a server that was removed before the delete stays removed", () => {
  const server = (id, name) => ({ kind: "server", id, name });
  const back = { items: [server("opt11", "OPT11")], consequences: { servers_restored: [{ key: "opt11", text: "OPT11" }] } };
  assert.equal(restoredText(back), "Restored OPT11");
  const kept = { items: [server("opt74", "OPT74")], consequences: { servers_restored: [], notes: [{ key: "removed:opt74" }] } };
  assert.equal(restoredText(kept), "Restored OPT74; it stays removed from the lab, as before");
  const mixed = { items: [server("opt11", "OPT11"), server("opt74", "OPT74"), { kind: "device", id: "pdu8", name: "PDU-Rack-08" }],
    consequences: { servers_restored: [{ key: "opt11" }] } };
  assert.equal(restoredText(mixed), "Restored 3 items; OPT74 stays removed from the lab, as before");
  assert.equal(restoredText({ items: [{ kind: "device", id: "pdu8", name: "PDU-Rack-08" }], consequences: {} }), "Restored PDU-Rack-08");
});

// ── request helpers ──
function fakeFetch(answers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body, etag] = answers.shift();
    return { ok: status < 400, status, json: async () => body, headers: { get: name => (name === "ETag" ? etag ?? null : null) } };
  };
  return calls;
}

test("labDelete.js sends the dry run, the apply with its revision, and restores with If-Match", async () => {
  const calls = fakeFetch([[200, PLAN], [200, { ok: true }], [200, { batches: [] }, '"e1"'], [200, { ok: true }], [200, { ok: true }]]);
  await previewDelete([{ kind: "dev", id: "pdu8" }, null], { twin_records: false });
  await applyDelete([{ kind: "device", id: "pdu8" }], {}, '"r1"', "Gone");
  assert.deepEqual((await listDeleted()).etag, '"e1"');
  await restoreDeleted("b1", [{ kind: "device", id: "pdu8" }], { planRevision: '"p1"', etag: '"e1"' });
  await purgeDeleted("b/1");
  assert.deepEqual(calls.map(c => [c.method, c.url]), [["POST", "/api/lab/delete"], ["POST", "/api/lab/delete"],
    ["GET", "/api/lab/deleted"], ["POST", "/api/lab/restore"], ["DELETE", "/api/lab/deleted/b%2F1"]]);
  assert.deepEqual(calls[0].body, { targets: [{ kind: "dev", id: "pdu8" }], options: { twin_records: false }, dry_run: true });
  assert.deepEqual(calls[1].body, { targets: [{ kind: "device", id: "pdu8" }], options: {}, plan_revision: '"r1"', reason: "Gone" });
  assert.deepEqual(calls[3].body, { batch: "b1", entries: [{ kind: "device", id: "pdu8" }], plan_revision: '"p1"' });
  assert.equal(calls[3].headers["If-Match"], '"e1"');
});

test("Undo restores the batch when nothing blocks it, and only previews when something does", async () => {
  let calls = fakeFetch([[200, { plan_revision: '"p"', blockers: [], items: [{ name: "PDU-Rack-08" }] }], [200, { batches: [] }, '"e"'],
    [200, { ok: true, items: [{ name: "PDU-Rack-08" }] }]]);
  assert.equal((await undoDelete("b1")).restored, true);
  assert.deepEqual(calls.map(c => c.body?.dry_run ?? c.method), [true, "GET", "POST"]);
  calls = fakeFetch([[200, { plan_revision: '"p"', blockers: [{ text: "A device with id pdu8 is in the lab again" }] }]]);
  const blocked = await undoDelete("b1");
  assert.equal(blocked.restored, false);
  assert.equal(calls.length, 1);
});

test("errors carry the server's text and status", async () => {
  fakeFetch([[409, { detail: "PDU 04 is in maintenance mode; restore it first." }]]);
  await assert.rejects(previewDelete([{ kind: "device", id: "pdu4" }]), e => e.status === 409 && /maintenance/.test(e.message));
});

test("devices.js previews and applies a PATCH", async () => {
  const calls = fakeFetch([[200, { dry_run: true, plan_revision: '"x"' }], [200, { ok: true }]]);
  await patchDevice("pdu 1", { rack: "Rack-05" }, { dryRun: true });
  await patchDevice("pdu 1", { rack: "Rack-05", confirm_name: "PDU 01" }, { planRevision: '"x"' });
  assert.deepEqual(calls.map(c => [c.method, c.url]), [["PATCH", "/api/devices/pdu%201?dry_run=true"], ["PATCH", "/api/devices/pdu%201"]]);
  assert.deepEqual(calls[1].body, { rack: "Rack-05", confirm_name: "PDU 01", plan_revision: '"x"' });
});
