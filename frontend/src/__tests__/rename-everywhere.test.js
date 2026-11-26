import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../api/client.js";
import {
  afterRename, chooseRenames, describeRename, editorChanges, knownIdentities, previewSkipReason, renameCandidates,
  saveWithRenames, serverName,
} from "../api/renameEverywhere.js";

const devices = [
  { id: "pdu-a", kind: "pdu", labels: { 1: "OPTN44", 2: "OPTN45 (PSU1)", 3: "Outlet 3" } },
  { id: "pdu-b", kind: "pdu", labels: { 2: "OPTN45 (PSU2)" } },
  { id: "kvm-a", kind: "kvm", labels: { 2: "OPTN45" } },
  { id: "rack", kind: "rack", labels: { 1: "OPTN99" } },
];
const PREVIEW = {
  ok: true, dry_run: true, old_name: "OPTN45 (PSU1)", new_name: "OPTN46 (PSU1)", plan_revision: '"abc"',
  changes: [
    { device_id: "pdu-a", device_name: "PDU-A", kind: "pdu", port: "2", before: "OPTN45 (PSU1)", after: "OPTN46 (PSU1)" },
    { device_id: "pdu-b", device_name: "PDU-B", kind: "pdu", port: "2", before: "OPTN45 (PSU2)", after: "OPTN46 (PSU2)" },
    { device_id: "kvm-a", device_name: "KVM-A", kind: "kvm", port: "2", before: "OPTN45", after: "OPTN46" },
  ],
  layout: [{ file: "rack_slots.json", rack: "Rack-01", before: "optn45 (psu1)", after: "optn46 (psu1)", slot: 7 }],
  position: { rack: "Rack-01", slot: 7 },
  monitor: { before: "OPTN45", after: "OPTN46", host: "optn45" },
  owner: { name: "Roy", before: "OPTN45", after: "OPTN46" },
};
const httpError = (status, detail) => Object.assign(new Error(`${status}: ${detail}`), { status, detail });

test("rename everywhere: only a server renamed to a NEW server name is a candidate", () => {
  const known = knownIdentities(devices);
  assert.deepEqual([...known].sort(), ["optn44", "optn45"]);   // a rack's labels are not ports
  const changes = [
    { port: "2", before: "OPTN45 (PSU1)", after: "OPTN46 (PSU1)" },  // new name: asked
    { port: "1", before: "OPTN44", after: "optn45 (PSU3)" },          // an existing server: single port
    { port: "3", before: "Outlet 3", after: "OPTN70" },               // was empty: single port
    { port: "4", before: "OPTN50", after: "" },                       // cleared: single port
    { port: "5", before: "OPTN51 (PSU1)", after: "OPTN51 (A)" },      // same server: single port
  ];
  assert.deepEqual(renameCandidates(changes, known), [{ old_name: "OPTN45 (PSU1)", new_name: "OPTN46 (PSU1)", ports: ["2"] }]);
  // Both feeds of one server renamed the same way are one question; two different new names are not asked.
  assert.deepEqual(renameCandidates([
    { port: "1", before: "OPTN45 (PSU1)", after: "OPTN46 (PSU1)" },
    { port: "2", before: "OPTN45 (PSU2)", after: "OPTN46 (PSU2)" },
  ], known), [{ old_name: "OPTN45 (PSU1)", new_name: "OPTN46 (PSU1)", ports: ["1", "2"] }]);
  assert.deepEqual(renameCandidates([
    { port: "1", before: "OPTN45 (PSU1)", after: "OPTN46 (PSU1)" },
    { port: "2", before: "OPTN45 (PSU2)", after: "OPTN47 (PSU2)" },
  ], known), []);
  // Live labels count as existing servers too.
  assert.deepEqual(renameCandidates(changes.slice(0, 1), knownIdentities(devices, ["optn46"])), []);
});

test("rename everywhere: editor changes come from the draft and the labels shown when editing began", () => {
  const original = { 1: "OPTN44", 2: "OPTN45 (PSU1)", 3: "Outlet 3" };
  const draft = { 1: "OPTN44", 2: " OPTN46 (PSU1) ", 3: "Outlet 3" };
  assert.deepEqual(editorChanges(draft, original), [{ port: "2", before: "OPTN45 (PSU1)", after: " OPTN46 (PSU1) " }]);
  assert.equal(serverName("OPTN45 (PSU1)"), "OPTN45");
  assert.equal(serverName(" web-1 "), "web-1");
});

test("rename everywhere: an existing name or default name refused by the preview is not asked; Cancel stops", async () => {
  assert.equal(previewSkipReason(httpError(409, "OPTN46 already exists — use Locations to swap or move")), "exists");
  assert.equal(previewSkipReason(httpError(400, '"Outlet 5" is not a server name (a default port name or placeholder).')), "not-server");
  assert.equal(previewSkipReason(httpError(409, "This server name already has an owner. Choose a different name.")), null);
  const group = { old_name: "OPTN45", new_name: "OPTN46", ports: ["2"] };
  const asked = [];
  const ask = choice => req => { asked.push(req); return Promise.resolve(choice); };
  assert.deepEqual(await chooseRenames([group], () => Promise.reject(httpError(409, "OPTN46 already exists — use Locations")), ask("everywhere")), []);
  assert.equal(asked.length, 0);
  assert.equal(await chooseRenames([group], () => Promise.resolve(PREVIEW), ask(null)), null);
  assert.deepEqual(await chooseRenames([group], () => Promise.resolve(PREVIEW), ask("only")), []);
  assert.deepEqual(await chooseRenames([group], () => Promise.resolve(PREVIEW), ask("everywhere")), [{ group, preview: PREVIEW }]);
  // A failed preview is still asked (with the error), but can only change this port.
  const failure = httpError(503, "unavailable");
  assert.deepEqual(await chooseRenames([group], () => Promise.reject(failure), ask("everywhere")), []);
  assert.equal(asked.at(-1).error, failure);
  assert.equal(asked.at(-1).preview, null);
});

test("rename everywhere: the rename runs with the preview token, then the rest of the editor is saved on top", async () => {
  const base = { 1: "OPTN44", 2: "OPTN45 (PSU1)" };
  const original = { 1: "OPTN44", 2: "OPTN45 (PSU1)", 3: "Outlet 3" };
  const draft = { 1: "OPTN44", 2: "OPTN46 (PSU1)", 3: "web-9" };
  const state = { base, original, revision: '"r1"' };
  const calls = [];
  const rename = async (o, n, opts) => { calls.push(["rename", o, n, opts]); return { ok: true, labels_revisions: { "pdu-a": '"r2"' }, device_names: "queued" }; };
  const save = async (body, revision) => { calls.push(["save", body, revision]); return { ok: true, device_names: "off" }; };
  const group = { old_name: "OPTN45 (PSU1)", new_name: "OPTN46 (PSU1)", ports: ["2"] };
  const result = await saveWithRenames("pdu-a", draft, state, [{ group, preview: PREVIEW }], rename, save);
  assert.deepEqual(calls, [
    ["rename", "OPTN45 (PSU1)", "OPTN46 (PSU1)", { planRevision: '"abc"' }],
    ["save", { 1: "OPTN44", 2: "OPTN46 (PSU1)", 3: "web-9" }, '"r2"'],
  ]);
  assert.equal(result.remaining, 1);
  assert.deepEqual(state, { base: { 1: "OPTN44", 2: "OPTN46 (PSU1)" }, original: { ...original, 2: "OPTN46 (PSU1)" }, revision: '"r2"' });
  assert.deepEqual(afterRename("kvm-a", PREVIEW, {}, {}), { base: { 2: "OPTN46" }, original: { 2: "OPTN46" } });
});

test("rename everywhere: a refused rename is marked so the editor does not treat it as a labels conflict", async () => {
  const state = { base: {}, original: { 2: "OPTN45" }, revision: '"r1"' };
  const refusal = httpError(409, "Changed since the preview. Preview again.");
  let saved = false;
  await assert.rejects(saveWithRenames("kvm-a", { 2: "OPTN46" }, state,
    [{ group: { old_name: "OPTN45", new_name: "OPTN46" }, preview: PREVIEW }],
    async () => { throw refusal; }, async () => { saved = true; }), e => e === refusal && e.step === "rename");
  assert.equal(saved, false);
  assert.deepEqual(state, { base: {}, original: { 2: "OPTN45" }, revision: '"r1"' });
});

test("rename everywhere: the dialog lists both feeds, the KVM port, rack/U, monitor and owner", () => {
  const d = describeRename(PREVIEW);
  assert.deepEqual(d.pdu.map(l => `${l.where}: ${l.before} -> ${l.after}`), [
    "PDU-A outlet 2: OPTN45 (PSU1) -> OPTN46 (PSU1)", "PDU-B outlet 2: OPTN45 (PSU2) -> OPTN46 (PSU2)"]);
  assert.deepEqual(d.kvm.map(l => l.where), ["KVM-A port 2"]);
  assert.equal(d.position, "Rack-01, U7");
  assert.equal(d.layoutCount, 1);
  assert.equal(d.pinCount, 0);
  assert.equal(describeRename({ changes: [], layout: [{ file: "rack_slots.json", rack: "R", before: null, after: "x", slot: 2 }] }).pinCount, 1);
  assert.deepEqual(d.monitor, { before: "OPTN45", after: "OPTN46" });
  assert.equal(d.owner, "Roy");
  assert.deepEqual(describeRename({ changes: [] }), { pdu: [], kvm: [], position: null, layoutCount: 0, pinCount: 0, monitor: null, owner: null });
});

test("client: renameOpt sends dry_run and plan_revision only when given", async t => {
  const bodies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { bodies.push([url, JSON.parse(init.body)]); return new Response("{}", { status: 200 }); };
  t.after(() => { globalThis.fetch = real; });
  await api.renameOpt("OPT1", "OPT2");
  await api.renameOpt("OPT1", "OPT2", { dryRun: true });
  await api.renameOpt("OPT1", "OPT2", { planRevision: '"x"' });
  assert.deepEqual(bodies, [
    ["/api/devices/rename-opt", { old_name: "OPT1", new_name: "OPT2" }],
    ["/api/devices/rename-opt", { old_name: "OPT1", new_name: "OPT2", dry_run: true }],
    ["/api/devices/rename-opt", { old_name: "OPT1", new_name: "OPT2", plan_revision: '"x"' }],
  ]);
});
