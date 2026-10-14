import test from "node:test";
import assert from "node:assert/strict";
import { releaseNotesSince, splitSections, versionOf } from "../api/changelog.js";

const LOG = `# Lab Manager — Changelog

---

## Unreleased — PDU maintenance
- Maintenance column

---

## v2.37.0 — 2026-10-13 — KVM fixes
- In-use marker kept

---

## v2.36.0 — 2026-10-01
- Older change

## v2.35.0 — 2026-09-20
- Oldest change
`;

test("sections are split on level-2 headings without separators", () => {
  const sections = splitSections(LOG);
  assert.deepEqual(sections.map(s => s.title), ["Unreleased — PDU maintenance", "v2.37.0 — 2026-10-13 — KVM fixes", "v2.36.0 — 2026-10-01", "v2.35.0 — 2026-09-20"]);
  assert.equal(sections[0].body, "- Maintenance column");
  assert.equal(versionOf(sections[1].title), "v2.37.0");
  assert.equal(versionOf(sections[0].title), null);
});

test("nothing is shown when this browser already saw the running version", () => {
  assert.deepEqual(releaseNotesSince(LOG, "v2.37.0", "v2.37.0"), []);
  assert.deepEqual(releaseNotesSince(LOG, null, null), []);
});

test("an update shows every section newer than the last seen version", () => {
  assert.deepEqual(releaseNotesSince(LOG, "v2.35.0", "v2.37.0").map(s => versionOf(s.title)), [null, "v2.37.0", "v2.36.0"]);
  assert.deepEqual(releaseNotesSince(LOG, "v2.36.0", "v2.37.0").map(s => versionOf(s.title)), [null, "v2.37.0"]);
});

test("first visit or an unknown last version shows only the newest release", () => {
  assert.deepEqual(releaseNotesSince(LOG, null, "v2.37.0").map(s => versionOf(s.title)), [null, "v2.37.0"]);
  assert.deepEqual(releaseNotesSince(LOG, "v1.0.0", "v2.37.0").map(s => versionOf(s.title)), [null, "v2.37.0"]);
});

test("the number of sections shown is capped", () => {
  assert.equal(releaseNotesSince(LOG, "v2.35.0", "v2.37.0", 2).length, 2);
});
