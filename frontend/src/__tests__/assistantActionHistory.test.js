import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_STATUSES, FINAL_STATUSES, isFinalStatus, statusLabel, statusTone, statusChip, TONE_CLASSES, kindSwitch, progressUnit,
  progressInfo, executingLine, executingNote, currentPdu, resultRows, summarizeResult, abortText, notIncludedCount,
  parseConsoleTarget, consoleTargets, CONSOLE_NOTES, errorCodeOf, classifyPollError, historyErrorText, historyRetryable,
  restoreErrorText, nextPollDelay, pollStopReason, acceptUpdate, acceptPolled, sameProposal, proposalSignature, pollNotice, createActionPoller,
  actionPoller, normalizeHistory, mergeHistory, pickNewer, historyRow, POLL_INTERVAL_MS, POLL_HIDDEN_INTERVAL_MS,
  POLL_BACKOFF_MS, POLL_MAX_MS, OFFLINE_ALERT_MS, STATUS_EXPLANATIONS,
} from "../api/assistantActionProgress.js";

// --- fixtures: public proposal JSON as store.to_public returns it ------------------------------------------------
const ID = "a".repeat(32);
const LAB_PDUS = ["p1", "p2", "p3"];
const labTargets = [
  { pdu_id: "p1", pdu_name: "PDU 01", rack: "Rack-01", outlet: 1, label: "OPT11 PSU1", server: "OPT11", state: "on" },
  { pdu_id: "p2", pdu_name: "PDU 02", rack: "Rack-02", outlet: 4, label: "OPT12", server: "OPT12", state: "on" },
  { pdu_id: "p3", pdu_name: "PDU 03", rack: "Rack-03", outlet: 2, label: "OPT13", server: "OPT13", state: "on" },
];

function lab(over = {}) {
  return {
    id: ID, kind: "lab_shutdown", scope: "lab", title_he: "כיבוי חשמל לכל המעבדה", status: "executing",
    created_at: "2026-10-20T10:00:00+00:00", expires_at: "2026-10-20T10:05:00+00:00", created_by: "admin1",
    required_role: "Admin", needs_password: true, phrase: "LAB OFF", background: true, request: { kind: "lab_shutdown" },
    impact: { targets: labTargets, excluded: [], pdus: LAB_PDUS, servers: ["OPT11", "OPT12", "OPT13"], consoles: [], warnings_he: [],
      counts: { outlets: 3, pdus: 3, servers: 3, excluded: 0 } },
    progress: { done: 1, total: 3 }, result: null, restore_of: null, can_restore: false, can_execute: false,
    ...over,
  };
}

const pduResult = (id, name, ok, switched = [], failed = [], error = "", extra = {}) => ({ pdu_id: id, pdu_name: name, ok, switched, failed, error, ...extra });

function cycle(over = {}) {
  return {
    id: "b".repeat(32), kind: "server_cycle", scope: "server", title_he: "ריסט חשמל לשרת OPT11", status: "succeeded",
    created_at: "2026-10-20T11:00:00+00:00", created_by: "op1", request: { kind: "server_cycle", server: "OPT11", then_console: true },
    impact: { targets: [
      { pdu_id: "p1", pdu_name: "PDU 01", rack: "Rack-01", outlet: 1, label: "OPT11 PSU1", server: "OPT11", state: "on" },
      { pdu_id: "p2", pdu_name: "PDU 02", rack: "Rack-01", outlet: 7, label: "OPT11 PSU2", server: "OPT11", state: "on" },
    ], excluded: [], pdus: ["p1", "p2"], servers: ["OPT11"], consoles: [] },
    progress: { done: 2, total: 2 },
    result: { targets: [
      { pdu_id: "p1", outlet: 1, ok: true, state_after: "on", error: "" },
      { pdu_id: "p2", outlet: 7, ok: true, state_after: "on", error: "" },
    ], pdus: [], consoles: [{ kvm_id: "kvm1", kvm_name: "KVM 01", port: 3, label: "OPT11", console_url: "/api/kvms/kvm1/autologin?port=3" }],
    summary_he: "הפעולה הושלמה בהצלחה." },
    can_restore: false,
    ...over,
  };
}

// --- statuses ------------------------------------------------------------------------------------------------------
test("every contract status has a Hebrew label and a tone; unknown statuses are safe", () => {
  for (const s of ACTION_STATUSES) {
    assert.match(statusLabel(s), /[֐-׿]/, s);
    assert.ok(TONE_CLASSES[statusTone(s)], s);
  }
  assert.equal(statusLabel("succeeded"), "בוצע");
  assert.equal(statusLabel("partial"), "בוצע חלקית");
  assert.equal(statusLabel("failed"), "נכשל");
  assert.equal(statusLabel("refused"), "נדחתה — המצב השתנה");
  assert.equal(statusLabel("interrupted"), "נקטעה");
  assert.equal(statusLabel("expired"), "פג תוקף");
  assert.equal(statusTone("executing"), "running");
  assert.equal(statusTone("failed"), "error");
  assert.equal(statusTone("partial"), "warn");
  assert.equal(statusTone("succeeded"), "ok");
  assert.equal(statusLabel("weird"), "מצב לא ידוע");
  assert.equal(statusTone(undefined), "muted");
  assert.deepEqual(statusChip("failed"), { label: "נכשל", tone: "error", className: TONE_CLASSES.error });
  assert.ok(FINAL_STATUSES.every(isFinalStatus));
  assert.equal(isFinalStatus("executing"), false);
  assert.equal(isFinalStatus("pending"), false);
});

test("kinds map to their switch and progress unit", () => {
  assert.equal(kindSwitch("lab_shutdown"), "maintenance_off");
  assert.equal(kindSwitch("batch_restore"), "maintenance_on");
  assert.equal(kindSwitch("server_cycle"), "cycle");
  assert.equal(kindSwitch("nope"), "none");
  assert.equal(progressUnit("rack_shutdown"), "PDU");
  assert.equal(progressUnit("server_off"), "שקעים");
});

// --- progress ------------------------------------------------------------------------------------------------------
test("progress text, live line, note and the current PDU while executing", () => {
  const p = lab();
  assert.deepEqual(progressInfo(p), { done: 1, total: 3, unit: "PDU", percent: 33, text: "1 מתוך 3 PDU", short: "1/3 PDU" });
  assert.equal(executingLine(p), "מכבה חשמל: 1 מתוך 3 PDU");
  assert.equal(executingNote(p), "אי אפשר לעצור באמצע. בסיום אפשר להחזיר חשמל.");
  assert.deepEqual(currentPdu(p), { id: "p2", name: "PDU 02", rack: "Rack-02" });
  assert.equal(executingLine(lab({ progress: { done: 0, total: 0 } })), "מכבה חשמל…");
  assert.equal(executingLine(lab({ kind: "batch_restore", progress: { done: 2, total: 3 } })), "מחזיר חשמל: 2 מתוך 3 PDU");
  assert.equal(executingNote(cycle()), "אי אפשר לעצור באמצע. החשמל יוחזר אוטומטית בסוף הריסט.");
  // Bad numbers never produce NaN or done > total.
  assert.deepEqual(progressInfo(lab({ progress: { done: 9, total: 3 } })).done, 3);
  assert.deepEqual(progressInfo(lab({ progress: { done: "x", total: -1 } })), { done: 0, total: 0, unit: "PDU", percent: 0, text: "", short: "" });
  assert.equal(currentPdu(lab({ status: "succeeded" })), null);
  assert.equal(currentPdu(cycle({ status: "executing" })), null);
});

test("executing rows mark processed, current and waiting PDUs in plan order", () => {
  const rows = resultRows(lab());
  assert.deepEqual(rows.map(r => [r.pduName, r.state, r.text]), [
    ["PDU 01", "processed", "טופל"], ["PDU 02", "current", "בביצוע…"], ["PDU 03", "pending", "ממתין"],
  ]);
  assert.equal(rows[1].rack, "Rack-02");
});

// --- results and summaries -----------------------------------------------------------------------------------------
test("lab off succeeded: every PDU verified, summary counts PDUs and outlets", () => {
  const p = lab({ status: "succeeded", progress: { done: 3, total: 3 }, can_restore: true, result: {
    targets: [], consoles: [], summary_he: "x",
    pdus: [pduResult("p1", "PDU 01", true, [1, 2]), pduResult("p2", "PDU 02", true, [4]), pduResult("p3", "PDU 03", true, [2])] } });
  const s = summarizeResult(p);
  assert.equal(s.text, "החשמל כובה ב־3 מתוך 3 PDU (4 שקעים). כל השקעים אומתו ככבויים.");
  assert.equal(s.tone, "ok");
  assert.equal(s.alert, false);
  assert.deepEqual(resultRows(p).map(r => r.text), ["2/2 כובו ואומתו", "1/1 כובו ואומתו", "1/1 כובו ואומתו"]);
});

test("partial lab off lists the PDUs that were NOT switched first, with failed outlets and the error", () => {
  const p = lab({ status: "partial", progress: { done: 3, total: 3 }, result: { targets: [], consoles: [], pdus: [
    pduResult("p1", "PDU 01", true, [1]),
    pduResult("p2", "PDU 02", false, [3], [4, 5], "Device is unreachable"),
    pduResult("p3", "PDU 03", true, [2]),
  ] } });
  const s = summarizeResult(p);
  assert.equal(s.text, "בוצע חלקית: 2 מתוך 3 PDU כובו. PDU אחד נכשל, וייתכן שהציוד שלו עדיין דולק.");
  assert.equal(s.alert, true);
  const rows = resultRows(p);
  assert.deepEqual(rows.map(r => [r.pduName, r.state]), [["PDU 02", "failed"], ["PDU 01", "ok"], ["PDU 03", "ok"]]);
  assert.equal(rows[0].text, "נכשל");
  assert.equal(rows[0].detail, "Device is unreachable");
  assert.deepEqual(rows[0].notes, ["כובו: 3", "שקעים שלא כובו: 4, 5"]);
  assert.equal(rows[0].mark, "✕");
});

test("an aborted job explains why in Hebrew and lists the untouched PDUs before the done ones", () => {
  const p = lab({ status: "partial", progress: { done: 2, total: 3 }, result: { targets: [], consoles: [],
    pdus: [pduResult("p1", "PDU 01", true, [1]), pduResult("p2", "PDU 02", false, [], [], "Device is unreachable")],
    aborted: { reason: "unreachable", pdu_id: "p2" } } });
  assert.equal(abortText(p), "PDU 02 לא היה זמין, ולכן הפעולה נעצרה. ה-PDU שאחריו לא טופלו.");
  const s = summarizeResult(p);
  assert.match(s.text, /^בוצע חלקית: 1 מתוך 3 PDU כובו\. PDU אחד נכשל, וייתכן שהציוד שלו עדיין דולק\./);
  assert.match(s.text, / PDU אחד לא טופל ונשאר כפי שהיה\.$/);
  assert.deepEqual(s.lines, [abortText(p)]);
  assert.deepEqual(resultRows(p).map(r => [r.pduName, r.state, r.text]),
    [["PDU 02", "failed", "נכשל"], ["PDU 03", "skipped", "לא טופל"], ["PDU 01", "ok", "1/1 כובו ואומתו"]]);
  assert.equal(abortText(lab({ result: { aborted: "disabled" } })), "ביצוע פעולות מהעוזר כובה בהגדרות השרת באמצע הריצה, ולכן הפעולה נעצרה. ה-PDU שאחריו לא טופלו.");
  assert.equal(abortText(lab({ result: { abort_reason: "unreachable" } })), "אחד ה-PDU לא היה זמין, ולכן הפעולה נעצרה. ה-PDU שאחריו לא טופלו.");
  assert.equal(abortText(lab({ result: { aborted: { reason: "something_new" } } })), "הפעולה נעצרה באמצע. ה-PDU שאחריו לא טופלו.");
  assert.equal(abortText(lab({ result: { aborted: { reason: "maintenance", pdu_name: "PDU 03" } } })),
    "PDU 03 הוכנס לתחזוקה על ידי מישהו אחר באמצע הריצה, ולכן הפעולה נעצרה. ה-PDU שאחריו לא טופלו.");
  assert.equal(abortText(lab({ result: { aborted: { reason: "unreachable", text_he: "נעצר: ה-PDU לא ענה" } } })), "נעצר: ה-PDU לא ענה");
  assert.equal(abortText(lab({ result: { targets: [] } })), null);
  // A single PDU left on gets a singular sentence.
  const one = lab({ status: "succeeded", progress: { done: 3, total: 3 }, result: { targets: [], consoles: [], pdus: [
    pduResult("p1", "PDU 01", true, [1], [], "", { not_included: [7] }), pduResult("p2", "PDU 02", true, [4]), pduResult("p3", "PDU 03", true, [2])] } });
  assert.deepEqual(summarizeResult(one).lines, ["שקע אחד שדלק ולא הוצג בהצעה נשאר דולק."]);
});

test("outlets left on because they were not in the proposal are reported, never hidden", () => {
  const p = lab({ status: "succeeded", progress: { done: 3, total: 3 }, result: { targets: [], consoles: [], pdus: [
    pduResult("p1", "PDU 01", true, [1], [], "", { not_included: [7, 9] }), pduResult("p2", "PDU 02", true, [4]), pduResult("p3", "PDU 03", true, [2]),
  ] } });
  assert.equal(notIncludedCount(p), 2);
  assert.deepEqual(summarizeResult(p).lines, ["2 שקעים שדלקו ולא הוצגו בהצעה נשארו דולקים."]);
  const rows = resultRows(p);
  // The PDU with outlets left on sorts before the plain successful ones.
  assert.deepEqual(rows.map(r => [r.pduName, r.state]), [["PDU 01", "left"], ["PDU 02", "ok"], ["PDU 03", "ok"]]);
  assert.equal(rows[0].text, "1/1 כובו ואומתו");
  assert.deepEqual(rows[0].notes, ["דלקו ולא הוצגו בהצעה, ולכן נשארו דולקים: 7, 9"]);
});

test("failed lab off never claims nothing was switched when some outlets were", () => {
  const none = lab({ status: "failed", progress: { done: 3, total: 3 }, result: { targets: [], consoles: [], pdus: LAB_PDUS.map(id => pduResult(id, id, false, [], [1], "Login failed")) } });
  assert.equal(summarizeResult(none).text, "הפעולה נכשלה. לא כובה אף שקע.");
  const some = lab({ status: "failed", progress: { done: 1, total: 3 }, result: { targets: [], consoles: [], pdus: [pduResult("p1", "PDU 01", false, [1], [2])] } });
  assert.equal(summarizeResult(some).text, "הפעולה נכשלה. מצב חלק מהשקעים לא ידוע — בדוק בעמוד ה-PDU.");
  const midway = lab({ status: "failed", progress: { done: 2, total: 3 }, result: { targets: [], consoles: [], pdus: [pduResult("p1", "PDU 01", true, [1]), pduResult("p2", "PDU 02", false, [], [], "Action execution failed")] } });
  assert.equal(summarizeResult(midway).text, "הפעולה נכשלה באמצע: 1 מתוך 3 PDU כובו לפני התקלה. בדוק את השאר בעמוד ה-PDU.");
});

test("batch restore summaries say power came back, partial ones warn the equipment may still be off", () => {
  const ok = lab({ kind: "batch_restore", status: "succeeded", progress: { done: 2, total: 2 }, impact: { ...lab().impact, pdus: ["p1", "p2"] },
    result: { targets: [], consoles: [], pdus: [pduResult("p1", "PDU 01", true, [1, 2]), pduResult("p2", "PDU 02", true, [4])] } });
  assert.equal(summarizeResult(ok).text, "החשמל הוחזר ב־2 מתוך 2 PDU (3 שקעים הודלקו ואומתו).");
  assert.deepEqual(resultRows(ok).map(r => r.text), ["2 הודלקו ואומתו", "1 הודלקו ואומתו"]);
  const part = { ...ok, status: "partial", result: { ...ok.result, pdus: [pduResult("p1", "PDU 01", true, [1]), pduResult("p2", "PDU 02", false, [], [4], "Timeout")] } };
  assert.equal(summarizeResult(part).text, "בוצע חלקית: החשמל הוחזר ב־1 מתוך 2 PDU. PDU אחד נכשל, וייתכן שהציוד שלו עדיין כבוי.");
  assert.deepEqual(resultRows(part)[0].notes, ["שקעים שלא הודלקו: 4"]);
});

test("server cycle: success names the server, a feed left off is an alert listing PDU and outlet", () => {
  assert.equal(summarizeResult(cycle()).text, "OPT11 אותחל: החשמל נותק והוחזר בכל השקעים שלו (2).");
  assert.deepEqual(resultRows(cycle()).map(r => [r.pduName, r.outlet, r.who, r.text]),
    [["PDU 01", 1, "OPT11", "אותחל ואומת"], ["PDU 02", 7, "OPT11", "אותחל ואומת"]]);
  const left = cycle({ status: "partial", result: { ...cycle().result, consoles: [], targets: [
    { pdu_id: "p1", outlet: 1, ok: true, state_after: "on", error: "" },
    { pdu_id: "p2", outlet: 7, ok: false, state_after: "off", error: "Outlet did not switch on" },
  ] } });
  const s = summarizeResult(left);
  assert.equal(s.text, "החשמל לא הוחזר ל־OPT11! שקעים כבויים: PDU 02 · 7. הדלק אותם מעמוד ה-PDU.");
  assert.equal(s.tone, "error");
  assert.equal(s.alert, true);
  const rows = resultRows(left);
  assert.deepEqual(rows.map(r => [r.pduName, r.state, r.text]), [["PDU 02", "off", "נשאר כבוי"], ["PDU 01", "ok", "אותחל ואומת"]]);
  assert.equal(rows[0].detail, "Outlet did not switch on");
});

test("server off: unverified outlets are not reported as switched", () => {
  const p = cycle({ kind: "server_off", status: "partial", result: { pdus: [], consoles: [], targets: [
    { pdu_id: "p1", outlet: 1, ok: true, state_after: "off", error: "" },
    { pdu_id: "p2", outlet: 7, ok: false, state_after: "unknown", error: "Outlet state could not be verified" },
  ] } });
  assert.equal(summarizeResult(p).text, "בוצע חלקית: 1 מתוך 2 שקעים כובו ואומתו. מצב שקע אחד לא אומת — בדוק בעמוד ה-PDU.");
  assert.deepEqual(resultRows(p).map(r => [r.state, r.mark, r.text]), [["unknown", "?", "לא אומת — ייתכן שהמצב השתנה"], ["ok", "✓", "כבוי ואומת"]]);
  const all = cycle({ kind: "server_off", result: { pdus: [], consoles: [], targets: [
    { pdu_id: "p1", outlet: 1, ok: true, state_after: "off" }, { pdu_id: "p2", outlet: 7, ok: true, state_after: "off" }] } });
  assert.equal(summarizeResult(all).text, "החשמל כובה ואומת ב־2 שקעים של OPT11.");
  const missing = cycle({ kind: "server_on", status: "failed", result: { pdus: [], consoles: [], targets: [] } });
  assert.equal(summarizeResult(missing).text, "הפעולה נכשלה. מצב חלק מהשקעים לא ידוע — בדוק בעמוד ה-PDU.");
});

test("refused, expired, cancelled and interrupted are explained in Hebrew", () => {
  const refused = summarizeResult(lab({ status: "refused", result: { summary_he: "לא ניתן היה לאמת את ההשפעה מחדש." } }));
  assert.equal(refused.text, STATUS_EXPLANATIONS.refused);
  assert.deepEqual(refused.lines, ["לא ניתן היה לאמת את ההשפעה מחדש."]);
  assert.equal(summarizeResult(lab({ status: "expired" })).text, "ההצעה פגה ולא בוצעה.");
  assert.equal(summarizeResult(lab({ status: "cancelled" })).text, "ההצעה בוטלה. לא בוצעה שום פעולה.");
  const intr = summarizeResult(lab({ status: "interrupted", can_restore: true, progress: { done: 2, total: 3 },
    result: { targets: [], pdus: [], consoles: [], summary_he: "x" } }));
  assert.equal(intr.text, "השרת הופעל מחדש באמצע הביצוע, ולכן הפעולה נקטעה. הושלמו 2 מתוך 3 PDU לפני ההפסקה. ה-PDU שכבר כובו נשארו בתחזוקה, ואפשר להחזיר להם חשמל.");
  assert.equal(intr.alert, true);
  // Rows for an interrupted lab job: PDUs that may have run are unknown, later ones were never reached.
  assert.deepEqual(resultRows(lab({ status: "interrupted", progress: { done: 1, total: 3 }, result: { targets: [], pdus: [], consoles: [] } }))
    .map(r => [r.pduName, r.state]), [["PDU 01", "unknown"], ["PDU 02", "unknown"], ["PDU 03", "skipped"]]);
  const cyc = summarizeResult(cycle({ status: "interrupted", result: null }));
  assert.match(cyc.text, /מצב השקעים לא ידוע — בדוק בעמוד ה-PDU\.$/);
  assert.equal(summarizeResult(lab({ status: "executing" })), null);
  assert.equal(summarizeResult(lab({ status: "pending" })), null);
});

// --- consoles ------------------------------------------------------------------------------------------------------
test("console buttons need a final status, the exact URL form, a matching kvm id and a known KVM", () => {
  const devices = [{ id: "kvm1", kind: "kvm", name: "KVM 01" }, { id: "pdu9", kind: "pdu" }];
  assert.deepEqual(parseConsoleTarget("/api/kvms/kvm1/autologin?port=3"), { deviceId: "kvm1", port: 3 });
  for (const bad of ["https://evil.example/api/kvms/kvm1/autologin?port=3", "/api/kvms/kvm1/autologin?port=3&x=1", "/api/kvms//autologin?port=1",
    "/api/kvms/kvm1/autologin?port=0", "javascript:alert(1)", null, "/api/kvms/%E0%A4%A/autologin?port=1"]) {
    assert.equal(parseConsoleTarget(bad), null, String(bad));
  }
  const entry = cycle().result.consoles[0];
  assert.deepEqual(consoleTargets(cycle(), devices),
    { buttons: [{ key: "kvm1:3", entry, deviceId: "kvm1", port: 3, kvmName: "KVM 01", label: "OPT11", inUse: false }], invalid: 0, unknown: 0 });
  const one = cycle();
  assert.equal(consoleTargets(one, devices).buttons[0].entry, one.result.consoles[0]);   // the server's object, for onOpenConsole(entry)
  assert.deepEqual(consoleTargets(cycle(), []), { buttons: [], invalid: 0, unknown: 1 });          // unknown KVM
  assert.deepEqual(consoleTargets(cycle(), undefined), { buttons: [], invalid: 0, unknown: 1 });   // no device list: no button
  assert.deepEqual(consoleTargets(cycle(), [{ id: "kvm1", kind: "pdu" }]).buttons, []);            // not a KVM
  assert.deepEqual(consoleTargets(cycle({ status: "executing" }), devices), { buttons: [], invalid: 0, unknown: 0 });
  const spoofed = cycle({ result: { ...cycle().result, consoles: [{ kvm_id: "kvm2", kvm_name: "KVM 02", port: 3, console_url: "/api/kvms/kvm1/autologin?port=3" }] } });
  assert.deepEqual(consoleTargets(spoofed, devices), { buttons: [], invalid: 1, unknown: 0 });
  const wrongPort = cycle({ result: { ...cycle().result, consoles: [{ kvm_id: "kvm1", port: 4, console_url: "/api/kvms/kvm1/autologin?port=3" }] } });
  assert.equal(consoleTargets(wrongPort, devices).invalid, 1);
  assert.equal(CONSOLE_NOTES.inline, "הדפדפן חסם חלון חדש, ולכן הקונסול נפתח בתוך האתר.");
});

// --- errors --------------------------------------------------------------------------------------------------------
test("poll errors: retry on network/5xx, stop on session, permission, flag and missing proposal", () => {
  assert.equal(classifyPollError({ code: "network" }), "retry");
  assert.equal(classifyPollError({ code: "timeout" }), "retry");
  assert.equal(classifyPollError({ status: 502 }), "retry");
  assert.equal(classifyPollError({ status: 429 }), "retry");
  assert.equal(classifyPollError({ status: 401 }), "session");
  assert.equal(classifyPollError({ status: 403, code: "forbidden" }), "forbidden");
  assert.equal(classifyPollError({ status: 403, apiCode: "disabled", code: "x" }), "disabled");
  assert.equal(classifyPollError({ status: 403, data: { code: "disabled" } }), "disabled");
  assert.equal(classifyPollError({ status: 404 }), "gone");
  assert.equal(classifyPollError(undefined), "retry");
  assert.equal(errorCodeOf({ serverCode: "busy", code: "network" }), "busy");
});

test("history and restore error texts are Hebrew and specific", () => {
  assert.equal(historyErrorText({ status: 403 }), "דרושה הרשאת Operator כדי לראות פעולות.");
  assert.equal(historyErrorText({ status: 403, code: "disabled" }), "ביצוע פעולות מהעוזר כבוי בהגדרות השרת.");
  assert.equal(historyErrorText({ code: "network" }), "אין חיבור לשרת. בדוק את החיבור ונסה שוב.");
  assert.equal(historyErrorText({ status: 500 }), "השרת נכשל בטעינת הפעולות. נסה שוב בעוד מעט.");
  assert.equal(historyErrorText({ status: 418, message: "418: teapot" }), "טעינת הפעולות נכשלה (HTTP 418).");
  assert.equal(historyRetryable({ status: 403 }), false);
  assert.equal(historyRetryable({ status: 503 }), true);
  assert.equal(restoreErrorText({ message: "יש כבר הצעה פתוחה" }), "יש כבר הצעה פתוחה");
  assert.equal(restoreErrorText({ status: 409, code: "busy" }), "יש כבר הצעה פתוחה או פעולה שרצה כרגע. סיים או בטל אותה ונסה שוב.");
  assert.equal(restoreErrorText({ status: 403, code: "forbidden" }), "החזרת חשמל לארון או למעבדה דורשת הרשאת Admin.");
  assert.equal(restoreErrorText({ status: 403, code: "password_mode" }), "החזרת חשמל לארון או למעבדה זמינה רק כשחשבונות המשתמש פעילים.");
  assert.match(restoreErrorText({ code: "network" }), /^החיבור לשרת נקטע/);
  assert.equal(restoreErrorText({ status: 400, message: "400: Invalid" }), "יצירת הצעת ההחזרה נכשלה (HTTP 400).");
});

// --- polling rules -------------------------------------------------------------------------------------------------
test("poll delay: 2 s visible, 5 s hidden, backoff on failures, none when not executing or after 15 minutes", () => {
  const base = { status: "executing", startedAt: 0, now: 1000 };
  assert.equal(nextPollDelay({ ...base }), POLL_INTERVAL_MS);
  assert.equal(POLL_INTERVAL_MS, 2000);
  assert.equal(nextPollDelay({ ...base, visible: false }), POLL_HIDDEN_INTERVAL_MS);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(failures => nextPollDelay({ ...base, failures })), [2000, 4000, 8000, 15000, 15000, 15000]);
  assert.deepEqual(POLL_BACKOFF_MS, [2000, 4000, 8000, 15000]);
  for (const status of ["pending", "succeeded", "partial", "failed", "refused", "interrupted", "expired", "cancelled", "ready", undefined]) {
    assert.equal(nextPollDelay({ ...base, status }), null, String(status));
  }
  assert.equal(nextPollDelay({ ...base, now: POLL_MAX_MS - 1 }), 2000);
  assert.equal(nextPollDelay({ ...base, now: POLL_MAX_MS }), null);
  assert.equal(POLL_MAX_MS, 15 * 60 * 1000);
  assert.equal(pollStopReason({ status: "failed" }), "final");
  assert.equal(pollStopReason({ status: "pending" }), "idle");
  assert.equal(pollStopReason({ status: "executing", startedAt: 0, now: POLL_MAX_MS }), "timeout");
  assert.equal(pollStopReason({ status: "executing", startedAt: 0, now: 5 }), null);
});

test("stale copies never replace newer state", () => {
  const exec1 = lab({ progress: { done: 1, total: 3 } });
  const exec2 = lab({ progress: { done: 2, total: 3 } });
  const done = lab({ status: "succeeded", progress: { done: 3, total: 3 } });
  const pending = lab({ status: "pending", progress: { done: 0, total: 0 } });
  assert.equal(acceptUpdate(null, exec1), true);
  assert.equal(acceptUpdate(pending, exec1), true);
  assert.equal(acceptUpdate(exec1, exec2), true);
  assert.equal(acceptUpdate(exec2, exec1), false);          // progress never goes back
  assert.equal(acceptUpdate(exec2, done), true);
  assert.equal(acceptUpdate(done, exec2), false);           // final never goes back to running
  assert.equal(acceptUpdate(done, pending), false);
  assert.equal(acceptUpdate(exec1, pending), false);
  assert.equal(acceptUpdate(exec1, { ...exec2, id: "c".repeat(32) }), false);
  assert.equal(acceptUpdate(exec1, { ...exec2, status: "bogus" }), false);
  assert.equal(acceptUpdate(exec1, null), false);
  assert.equal(acceptUpdate(exec1, { status: "executing" }), false);
  // A poll answer may move executing back to pending (busy refusal), but never final back to running.
  assert.equal(acceptPolled(exec2, pending), true);
  assert.equal(acceptPolled(exec2, exec1), true);
  assert.equal(acceptPolled(done, exec2), false);
  assert.equal(sameProposal(exec1, lab({ progress: { done: 1, total: 3 } })), true);
  assert.equal(sameProposal(exec1, exec2), false);
});

test("poll notices: short reconnect note, an alert after a minute offline, stop reasons", () => {
  assert.equal(pollNotice(null), null);
  assert.equal(pollNotice({ stopReason: "final", failures: 0 }), null);
  assert.equal(pollNotice({ stopReason: null, failures: 0 }), null);
  const short = pollNotice({ stopReason: null, failures: 2, offlineSince: 0 }, 10_000);
  assert.equal(short.text, "החיבור לשרת נקטע. הפעולה ממשיכה לרוץ בשרת; מתחבר מחדש…");
  assert.equal(short.alert, false);
  const long = pollNotice({ stopReason: null, failures: 6, offlineSince: 0 }, OFFLINE_ALERT_MS);
  assert.equal(long.text, "אין חיבור כבר דקה. מצב הפעולה לא ידוע כאן — בדוק בעמוד ה-PDU.");
  assert.equal(long.alert, true);
  assert.equal(long.action, "retry");
  assert.equal(pollNotice({ stopReason: "timeout" }).action, "check");
  assert.equal(pollNotice({ stopReason: "gone" }).text, "ההצעה כבר לא קיימת בשרת. מצב הפעולה לא ידוע כאן — בדוק בעמוד ה-PDU.");
  assert.match(pollNotice({ stopReason: "session" }).text, /^ההתחברות לאתר פגה/);
});

// --- the shared poller with a fake clock --------------------------------------------------------------------------
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: time + ms, ms }); return id; },
    clearTimer: id => { timers.delete(id); },
    pending: () => [...timers.values()].map(t => t.ms),
    // Runs the earliest timer (advancing the clock to it), then lets the poll's promise settle.
    async tick() {
      const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!id) return false;
      timers.delete(id);
      time = t.at;
      t.fn();
      await new Promise(r => setImmediate(r));
      return true;
    },
    advance(ms) { time += ms; },
  };
}

function setup(replies) {
  const clock = fakeClock();
  const calls = [];
  const poller = createActionPoller({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetchProposal: async id => {
      calls.push(id);
      const r = replies.shift();
      if (!r) throw Object.assign(new Error("no reply"), { code: "network" });
      if (r.error) throw r.error;
      return r;
    },
  });
  return { clock, calls, poller };
}

test("poller: polls every 2 s while executing, hands each newer copy to the view, stops on a final status", async () => {
  const final = lab({ status: "partial", progress: { done: 3, total: 3 }, result: { targets: [], pdus: [], consoles: [] } });
  const { clock, calls, poller } = setup([lab({ progress: { done: 2, total: 3 } }), final]);
  const seen = [];
  const any = [];
  poller.onAny(s => any.push(s.proposal.status));
  const off = poller.watch(lab(), s => seen.push(s));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].proposal.progress.done, 1);
  assert.equal(seen[0].polling, true);
  assert.deepEqual(clock.pending(), [2000]);
  await clock.tick();
  assert.deepEqual(calls, [ID]);
  assert.equal(seen.at(-1).proposal.progress.done, 2);
  assert.deepEqual(clock.pending(), [2000]);
  await clock.tick();
  assert.equal(seen.at(-1).proposal.status, "partial");
  assert.equal(seen.at(-1).stopReason, "final");
  assert.equal(seen.at(-1).polling, false);
  assert.deepEqual(clock.pending(), []);
  assert.equal(await clock.tick(), false);
  assert.ok(any.includes("partial"));
  off();
});

test("poller: no polling for pending; starts when a newer executing copy arrives (execute 202)", async () => {
  const { clock, poller } = setup([lab({ status: "succeeded", progress: { done: 3, total: 3 } })]);
  poller.watch(lab({ status: "pending", progress: { done: 0, total: 0 } }), () => {});
  assert.deepEqual(clock.pending(), []);
  assert.equal(poller.update(lab({ progress: { done: 0, total: 3 } })), true);
  assert.deepEqual(clock.pending(), [2000]);
  await clock.tick();
  assert.equal(poller.get(ID).proposal.status, "succeeded");
  // A stale pending copy from the chat answer cannot bring the card back.
  assert.equal(poller.update(lab({ status: "pending" })), false);
  assert.equal(poller.get(ID).proposal.status, "succeeded");
  // The same content again is not an update (no render loop with a parent that copies objects).
  assert.equal(poller.update(JSON.parse(JSON.stringify(poller.get(ID).proposal))), false);
});

test("poller: a slimmer copy of the same state (the parent's normalized copy) keeps the raw server copy", async () => {
  const raw = lab({ status: "partial", progress: { done: 2, total: 3 }, result: { targets: [], consoles: [],
    pdus: [pduResult("p1", "PDU 01", true, [1]), pduResult("p2", "PDU 02", false)], aborted: { reason: "unreachable", pdu_id: "p2" } } });
  const { clock, poller } = setup([raw]);
  poller.watch(lab(), () => {});
  await clock.tick();
  assert.equal(poller.get(ID).proposal, raw);
  const slim = { ...raw, _received_at: 5, result: { targets: [], consoles: [], pdus: raw.result.pdus, summary_he: "" } };
  assert.equal(proposalSignature(slim) === proposalSignature(raw), false);   // the abort flag is part of the signature
  const sameView = { ...raw, _received_at: 5, sw: "maintenance_off" };
  assert.equal(proposalSignature(sameView), proposalSignature(raw));
  assert.equal(poller.update(sameView), false);
  assert.equal(poller.get(ID).proposal, raw);
  // A real change (restore created and finished: can_restore false) is taken.
  assert.equal(poller.update({ ...raw, can_restore: true }), true);
});

test("poller: keeps going slower with no visible view (panel closed) and a new view sees the cached state", async () => {
  const { clock, poller } = setup([lab({ progress: { done: 2, total: 3 } }), lab({ status: "succeeded", progress: { done: 3, total: 3 } })]);
  const off = poller.watch(lab(), () => {});
  assert.deepEqual(clock.pending(), [2000]);
  off();
  assert.deepEqual(clock.pending(), [5000]);
  await clock.tick();
  assert.equal(poller.get(ID).proposal.progress.done, 2);
  assert.deepEqual(clock.pending(), [5000]);
  await clock.tick();
  assert.equal(poller.get(ID).proposal.status, "succeeded");
  // Reopening the panel with the old executing copy shows the final state, without a request.
  let state;
  poller.watch(lab(), s => { state = s; });
  assert.equal(state.proposal.status, "succeeded");
  assert.deepEqual(clock.pending(), []);
});

test("poller: network loss backs off 2/4/8/15 s, flags a minute offline, recovers on the next answer", async () => {
  const net = () => ({ error: Object.assign(new Error("x"), { code: "network" }) });
  const { clock, poller } = setup([net(), net(), net(), net(), net(), net(), lab({ progress: { done: 3, total: 3 }, status: "succeeded" })]);
  let state;
  poller.watch(lab(), s => { state = s; });
  const delays = [];
  for (let i = 0; i < 6; i += 1) {
    delays.push(clock.pending()[0]);
    await clock.tick();
  }
  assert.deepEqual(delays, [2000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(state.failures, 6);
  assert.equal(state.offlineSince, 2000);
  // 2 + 4 + 8 + 15 + 15 = 44 s after the first failure: still the short note; from 60 s the alert (the view re-renders then).
  assert.equal(clock.now() - state.offlineSince, 44_000);
  assert.equal(pollNotice(state, clock.now()).alert, false);
  assert.equal(pollNotice(state, state.offlineSince + OFFLINE_ALERT_MS).alert, true);
  await clock.tick();
  assert.equal(state.failures, 0);
  assert.equal(state.offlineSince, null);
  assert.equal(state.proposal.status, "succeeded");
});

test("poller: stops on 404/403/401 without retrying, and after 15 minutes; refresh polls again", async () => {
  const { clock, poller, calls } = setup([{ error: Object.assign(new Error("x"), { status: 404 }) }]);
  let state;
  poller.watch(lab(), s => { state = s; });
  await clock.tick();
  assert.equal(state.stopReason, "gone");
  assert.deepEqual(clock.pending(), []);
  assert.equal(calls.length, 1);

  const t = setup(Array.from({ length: 500 }, () => lab({ progress: { done: 1, total: 3 } })));
  let st;
  t.poller.watch(lab(), s => { st = s; });
  let n = 0;
  while (await t.clock.tick()) n += 1;
  assert.equal(st.stopReason, "timeout");
  assert.ok(n >= 440 && n <= 451, `polled ${n} times`);
  assert.ok(t.clock.now() <= POLL_MAX_MS + 2000);
  assert.equal(pollNotice(st).action, "check");
  t.poller.refresh(ID);                  // "בדוק מצב"
  assert.equal(st.polling, true);
  await new Promise(r => setImmediate(r));
  assert.equal(st.stopReason, null);
  assert.deepEqual(t.clock.pending(), [2000]);
});

test("poller: an answer that arrives after stopAll (sign-out) or for a forgotten view is ignored", async () => {
  let release;
  const clock = fakeClock();
  const poller = createActionPoller({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetchProposal: () => new Promise(r => { release = r; }) });
  let state;
  poller.watch(lab(), s => { state = s; });
  await clock.tick();                    // request in flight
  poller.stopAll("session");
  assert.equal(state.stopReason, "session");
  release(lab({ status: "succeeded", progress: { done: 3, total: 3 } }));
  await new Promise(r => setImmediate(r));
  assert.equal(state.proposal.status, "executing");
  assert.deepEqual(clock.pending(), []);
  // Signing in again remounts the view: polling resumes.
  poller.watch(lab(), s => { state = s; });
  assert.equal(state.stopReason, null);
  assert.deepEqual(clock.pending(), [2000]);
});

test("poller: one request at a time per proposal, shared by every view", async () => {
  const { clock, poller, calls } = setup([lab({ progress: { done: 2, total: 3 } })]);
  const a = [];
  const b = [];
  poller.watch(lab(), s => a.push(s.proposal.progress.done));
  poller.watch(lab(), s => b.push(s.proposal.progress.done));
  assert.deepEqual(clock.pending(), [2000]);
  await clock.tick();
  assert.equal(calls.length, 1);
  assert.equal(a.at(-1), 2);
  assert.equal(b.at(-1), 2);
});

test("the app-wide poller exists and has no fetch until configured", () => {
  assert.equal(typeof actionPoller.watch, "function");
  assert.equal(typeof actionPoller.onAny, "function");
  assert.equal(typeof actionPoller.configure, "function");
});

// --- history -------------------------------------------------------------------------------------------------------
test("history: accepts {items} or a list, newest first, unique ids, at most 20, raw objects kept", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `id${i}`, status: "succeeded", created_at: `2026-10-20T10:${String(i).padStart(2, "0")}:00Z`, extra: { keep: i } }));
  const list = normalizeHistory({ items: [...items, items[3], null, "x", { status: "failed" }] });
  assert.equal(list.length, 20);
  assert.equal(list[0].id, "id24");
  assert.equal(list[0], items[24]);   // the same server object
  assert.equal(new Set(list.map(x => x.id)).size, 20);
  assert.deepEqual(normalizeHistory([items[1], items[2]]).map(x => x.id), ["id2", "id1"]);
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory({ detail: "x" }), []);
});

test("history: a list read before a poll answer never overwrites the newer copy", () => {
  const newer = lab({ status: "succeeded", progress: { done: 3, total: 3 } });
  const older = lab();
  const other = cycle();
  const merged = mergeHistory([older, other], id => (id === ID ? newer : null));
  assert.equal(merged[0], newer);
  assert.equal(merged[1], other);
  assert.equal(pickNewer(newer, older), newer);
  assert.equal(pickNewer(older, newer), newer);
  assert.equal(pickNewer(null, older), older);
});

test("history row: title, chip, who, time and short progress", () => {
  assert.deepEqual(historyRow(lab({ status: "succeeded", progress: { done: 3, total: 3 } })), {
    id: ID, title: "כיבוי חשמל לכל המעבדה", status: "succeeded", chip: statusChip("succeeded"), by: "admin1",
    createdAt: "2026-10-20T10:00:00+00:00", running: false, progress: "3/3 PDU",
  });
  const running = historyRow(lab());
  assert.equal(running.running, true);
  assert.equal(running.progress, "1/3 PDU");
  assert.equal(historyRow(lab({ status: "pending" })).progress, "");
  assert.equal(historyRow(lab({ status: "refused" })).progress, "");    // nothing ran: no "1/3" next to it
  assert.equal(historyRow(lab({ status: "interrupted" })).progress, "1/3 PDU");
  assert.equal(historyRow({ id: "x" }).title, "פעולה מהעוזר");
  assert.equal(historyRow({ id: "x" }).by, "לא ידוע");
  assert.equal(historyRow({ id: "x" }).status, "unknown");
});
