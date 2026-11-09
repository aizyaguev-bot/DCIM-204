import test from "node:test";
import assert from "node:assert/strict";
import { clockText, FILL_NOTE, LAUNCHER, webpeStatusText, willFill } from "../api/webpeStatus.js";

const now = new Date(2026, 10, 9, 10, 6);
const clock = iso => clockText(iso, now);
const local = (h, m, day = 9) => new Date(2026, 10, day, h, m).toISOString();

test("clock text is the time today, with the date for another day", () => {
  assert.equal(clock(local(10, 5)), "10:05");
  assert.equal(clock(local(9, 12, 8)), "Nov 8, 09:12");
  assert.equal(clock(""), "");
  assert.equal(clock("not a time"), "");
});

test("an active lookup shows its last check and today's count", () => {
  const status = { active: true, last_check: local(10, 5), seen_at: local(10, 5), looked_up_today: 3, pending: 0, last_error: null };
  assert.deepEqual(webpeStatusText(status, { now }), { state: "active", text: "webpe auto lookup: Active · last check 10:05 · 3 looked up today" });
  assert.equal(webpeStatusText({ ...status, pending: 2, looked_up_today: 0 }, { now }).text, "webpe auto lookup: Active · last check 10:05 · 0 looked up today · 2 waiting");
  assert.deepEqual(webpeStatusText({ ...status, last_error: "webpe answered 500" }, { now }),
    { state: "problem", text: "webpe auto lookup: Active · last check 10:05 · 3 looked up today — problem: webpe answered 500" });
});

test("a signed-out laptop and a stopped lookup say what to do", () => {
  assert.deepEqual(webpeStatusText({ active: true, last_check: local(10, 5), last_error: "webpe sign-in needed: sign in to webpe in the lab Edge window" }, { now }),
    { state: "signin", text: "webpe sign-in needed on the lab laptop" });
  assert.deepEqual(webpeStatusText({ active: false, seen_at: local(9, 12), last_check: local(9, 12) }, { now }),
    { state: "stopped", text: `webpe auto lookup: Not running (last seen 09:12) — start ${LAUNCHER} on the lab laptop` });
  assert.equal(webpeStatusText({ active: false, seen_at: null }, { now }).text, `webpe auto lookup: Not running — start ${LAUNCHER} on the lab laptop`);
  // A stopped tool's last sign-in problem is old news: it is reported as not running.
  assert.equal(webpeStatusText({ active: false, seen_at: local(9, 12), last_error: "webpe sign-in needed" }, { now }).state, "stopped");
  assert.equal(webpeStatusText(null), null);
});

test("the scan dialog promises a fill only for a serial without a P/N while the lookup runs", () => {
  const active = { active: true, last_error: null };
  assert.equal(willFill({ serial_number: "MT1", part_number: "" }, active), true);
  assert.equal(willFill({ barcode: "000777" }, active), true);
  assert.equal(willFill({ serial_number: "MT1", part_number: "P1" }, active), false);
  assert.equal(willFill({ serial_number: "" }, active), false);
  assert.equal(willFill({ serial_number: "MT1" }, { active: false }), false);
  assert.equal(willFill({ serial_number: "MT1" }, { active: true, last_error: "webpe sign-in needed" }), false);
  assert.equal(willFill({ serial_number: "MT1" }, null), false);
  assert.equal(FILL_NOTE, "P/N and name will be filled from webpe within a minute");
});
