import test from "node:test";
import assert from "node:assert/strict";
import { labelChanges, labelEditState, labelPatchBody } from "../api/locations.js";
import { LATEST_NOT_LOADED, latestDevice, rebaseLabelDraft, rebaseNote } from "../api/labelDraft.js";

const outlets = [1, 2, 3, 4].map(n => ({ number: n, label: `OPT1${n}`, state: "on" }));
const saved = { 1: "OPT11", 2: "OPT12", 3: "OPT13", 4: "OPT14" };

function openDraft(typed) {
  const { draft, original, base } = labelEditState(saved, outlets);
  return { draft: { ...draft, ...typed }, original, base };
}

test("a 409 rebase keeps our typed ports and takes the other session's change on another port", () => {
  const mine = openDraft({ 1: "MY-NEW-SERVER-1", 2: "MY-OTHER-SERVER-1" });
  const latest = { ...saved, 4: "ADMIN-CHANGED-4" };
  const r = rebaseLabelDraft(mine.draft, mine.original, latest, outlets);
  assert.deepEqual(r.kept, ["1", "2"]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.draft["1"], "MY-NEW-SERVER-1");
  assert.equal(r.draft["2"], "MY-OTHER-SERVER-1");
  assert.equal(r.draft["4"], "ADMIN-CHANGED-4", "the editor shows the admin's value");
  assert.deepEqual(r.base, latest);
  assert.deepEqual(labelChanges(r.draft, r.original), ["1", "2"]);
  // The next PATCH carries all three changes: ours on 1 and 2, theirs on 4, and leaves 3 as saved.
  assert.deepEqual(labelPatchBody(r.base, r.draft, r.original),
    { 1: "MY-NEW-SERVER-1", 2: "MY-OTHER-SERVER-1", 3: "OPT13", 4: "ADMIN-CHANGED-4" });
});

test("the same port changed on both sides is a conflict; the draft keeps our text", () => {
  const mine = openDraft({ 1: "MY-NEW-SERVER-1", 3: "MINE-3" });
  const r = rebaseLabelDraft(mine.draft, mine.original, { ...saved, 3: "THEIRS-3" }, outlets);
  assert.deepEqual(r.conflicts, [{ port: "3", theirs: "THEIRS-3" }]);
  assert.deepEqual(r.kept, ["1"]);
  assert.equal(r.draft["3"], "MINE-3");
  assert.equal(r.original["3"], "THEIRS-3");
  assert.equal(labelPatchBody(r.base, r.draft, r.original)["3"], "MINE-3");
  const note = rebaseNote(r, "outlet");
  assert.match(note, /outlet 1 are kept/);
  assert.match(note, /Outlet 3 was also changed to "THEIRS-3"; your text is kept and Save will replace it/);
  assert.doesNotMatch(note, /reload/i);
});

test("a port both sides changed to the same text is already saved", () => {
  const mine = openDraft({ 2: "SAME" });
  const r = rebaseLabelDraft(mine.draft, mine.original, { ...saved, 2: " SAME " }, outlets);
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(labelChanges(r.draft, r.original), []);
});

test("a cleared port stays cleared and a port the other session cleared is a conflict", () => {
  const mine = openDraft({ 2: "", 4: "MINE-4" });
  const r = rebaseLabelDraft(mine.draft, mine.original, { ...saved, 4: "Outlet 4" }, outlets);
  assert.deepEqual(r.kept, ["2"]);
  assert.deepEqual(r.conflicts, [{ port: "4", theirs: "Outlet 4" }]);
  assert.equal(labelPatchBody(r.base, r.draft, r.original)["2"], "");
});

test("KVM ports without a saved label come from the live list", () => {
  const ports = [1, 2, 3].map(n => ({ number: n, label: `OPT1${n}` }));
  const start = labelEditState({ 1: "OPT11" }, ports);
  const draft = { ...start.draft, 2: "MY-PORT-2" };
  const r = rebaseLabelDraft(draft, start.original, { 1: "OPT11", 3: "ADMIN-3" }, ports);
  assert.deepEqual(r.kept, ["2"]);
  assert.equal(r.draft["3"], "ADMIN-3");
  assert.deepEqual(labelPatchBody(r.base, r.draft, r.original), { 1: "OPT11", 2: "MY-PORT-2", 3: "ADMIN-3" });
  assert.match(rebaseNote(r, "port"), /Your changes to port 2 are kept/);
});

test("latestDevice prefers the error's fresh copy, then a reloaded device with a newer revision", () => {
  const fresh = { id: "pdu1", labels: { 1: "A" }, labels_revision: "r2" };
  assert.equal(latestDevice({ status: 409, latest: fresh }, { labels_revision: "r1" }, "r1"), fresh);
  assert.equal(latestDevice({ status: 409 }, fresh, "r1"), fresh);
  assert.equal(latestDevice({ status: 409 }, { labels: {}, labels_revision: "r1" }, "r1"), undefined);
  assert.equal(latestDevice({ status: 409 }, undefined, "r1"), undefined);
  assert.doesNotMatch(LATEST_NOT_LOADED, /reload/i);
  assert.match(LATEST_NOT_LOADED, /Your changes are kept; click Save to try again/);
});
