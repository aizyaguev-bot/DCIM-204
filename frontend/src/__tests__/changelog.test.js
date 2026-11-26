import test from "node:test";
import assert from "node:assert/strict";
import { releaseNotesSince, sectionHeading, splitSections, versionOf } from "../api/changelog.js";

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

// Same shape as CHANGELOG.md: Unreleased sections between releases, v3.x listed below v2.37, CRLF endings.
const REAL = [
  "# Lab Manager — Changelog", "", "---", "",
  "## Unreleased — Remote PXE install", "- Remote install tab", "  continued on a second line", "",
  "## v2.37.1 — 2026-10-14 — KVM console fix", "- Console opens again", "",
  "## v2.37.0 - 2026-10-13 - PDU maintenance mode", "### Added", "- Maintenance column", "",
  "## Unreleased — Unknown power readings and VM operations tools", "- Unknown readings", "",
  "## Unreleased — KVM console launch recovery", "- Launch recovery", "",
  "## v3.1.1 — 2026-10-01", "- Older 3.x", "",
  "## v3.0.0 — 2026-09-30", "- Oldest 3.x", "",
  "## v2.36.0 — 2026-10-05", "- Before maintenance", "",
].join("\r\n");
const labels = sections => sections.map(s => sectionHeading(s.title).label);

test("the Changelog tab gets one card per section, Unreleased ones included, in file order", () => {
  const cards = splitSections(REAL).map(s => sectionHeading(s.title));
  assert.deepEqual(cards.map(c => c.label), ["Unreleased", "v2.37.1", "v2.37.0", "Unreleased", "Unreleased", "v3.1.1", "v3.0.0", "v2.36.0"]);
  assert.deepEqual(cards.map(c => c.unreleased), [true, false, false, true, true, false, false, false]);
  assert.equal(cards[0].detail, "Remote PXE install");
  assert.equal(cards[1].detail, "2026-10-14 — KVM console fix");
  assert.equal(cards[2].detail, "2026-10-13 - PDU maintenance mode");
  assert.deepEqual(sectionHeading("Notes"), { label: "Notes", detail: "", unreleased: false });
});

test("sections keep only their own body, without CR characters or other headings", () => {
  const sections = splitSections(REAL);
  assert.equal(sections[2].body, "### Added\n- Maintenance column");
  assert.equal(sections[0].body, "- Remote install tab\n  continued on a second line");
  assert.ok(sections.every(s => !/^## /m.test(s.body) && !s.body.includes("\r")));
});

test("What's new on the real ordering", () => {
  assert.deepEqual(labels(releaseNotesSince(REAL, "v2.37.0", "v2.37.1")), ["Unreleased", "v2.37.1"]);
  assert.deepEqual(labels(releaseNotesSince(REAL, null, "v2.37.1")), ["Unreleased", "v2.37.1"]);
  assert.deepEqual(labels(releaseNotesSince(REAL, "v2.36.0", "v2.37.1")), ["Unreleased", "v2.37.1", "v2.37.0", "Unreleased", "Unreleased", "v3.1.1"]);
  // The local preview runs a non-numeric version: only the notes above the first release are new.
  assert.deepEqual(labels(releaseNotesSince(REAL, null, "LOCAL PREVIEW - TEST DATA")), ["Unreleased"]);
});

test("a heading without the v prefix is not read as a release", () => {
  assert.equal(versionOf("2.30.0 — 2026-08-01"), null);
  assert.deepEqual(sectionHeading("2.30.0 — 2026-08-01"), { label: "2.30.0 — 2026-08-01", detail: "", unreleased: false });
});
