import test from "node:test";
import assert from "node:assert/strict";
import {
  getConfig, createProposal, getProposal, listProposals, executeProposal, cancelProposal, cleanRequest,
  normalizeProposal, normalizeImpact, mergeProposal, upsertProposal, remainingSeconds, formatCountdown, countdownLabel,
  displayStatus, riskOf, roleChipText, statusLabel, excludedGroups, keptCount, groupTargets, groupByServer,
  impactSentence, verbLabel, actionTone, clientWarnings, passwordLabelHe, configBlockText, phraseMatches, confirmState,
  errorCode, actionErrorInfo, actionErrorText, consoleTarget, proposalConsoles, NOTHING_DONE, ACCOUNTS_ONLY_TEXT,
  EXECUTE_TIMEOUT_MS, insertAfterId, proposalRefs, RISK_LABELS,
  DATA_KINDS, DATA_CONFIRM_LABEL, DATA_DRIFT_TEXT, EMPTY_LABEL, NO_POSITION, isDataKind, cleanTargetPorts, changeRows, positionRows,
  spotText, portWord, unplacedText, dataChangeCount, changesText, dataWarnings, dataResultView, dataChangeFinished, generationGuard,
  movedPositions, unplacedLines,
} from "../api/assistantActions.js";

const realFetch = globalThis.fetch;
const ID = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";

function stubFetch(t, replies) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined, init });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
    if (reply.throws) throw reply.throws;
    const body = reply.text ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers || {} });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

function raw(overrides = {}) {
  return {
    id: ID, kind: "lab_shutdown", scope: "lab", title_he: "כיבוי חשמל לכל המעבדה", status: "pending",
    created_at: "2026-10-20T09:00:00+00:00", expires_at: "2026-10-20T09:05:00+00:00", created_by: "admin",
    required_role: "Admin", needs_password: true, phrase: "LAB OFF", background: true, expires_in_s: 240,
    request: { kind: "lab_shutdown", server: null, pdu: null, outlet: null, rack: null, restore_of: null, then_console: false },
    impact: {
      targets: [
        { pdu_id: "pdu2", pdu_name: "PDU 02", rack: "Rack-10", outlet: 3, label: "OPT12 PSU1", server: "OPT12", state: "on" },
        { pdu_id: "pdu1", pdu_name: "PDU 01", rack: "Rack-2", outlet: 7, label: "OPT11 PSU2", server: "OPT11", state: "on" },
        { pdu_id: "pdu1", pdu_name: "PDU 01", rack: "Rack-2", outlet: 1, label: "OPT11 PSU1", server: "OPT11", state: "on" },
      ],
      excluded: [
        { pdu_id: "pdu1", pdu_name: "PDU 01", rack: "Rack-2", outlet: 4, label: "Core switch", reason: "protected" },
        { pdu_id: "pdu7", pdu_name: "PDU 07", rack: "Rack-7", outlet: null, label: "", reason: "unreachable" },
        { pdu_id: "pdu1", pdu_name: "PDU 01", rack: "Rack-2", outlet: 9, label: "", reason: "already_off" },
      ],
      pdus: ["pdu1", "pdu2"], servers: ["OPT11", "OPT12"], consoles: [], warnings_he: ["אזהרה מהשרת"],
      counts: { outlets: 3, pdus: 2, servers: 2, excluded: 3 },
    },
    progress: { done: 0, total: 0 }, result: null, restore_of: null, can_restore: false, can_execute: true,
    ...overrides,
  };
}

test("requests use the contract paths, methods and bodies", async t => {
  const calls = stubFetch(t, [
    { body: { enabled: true, password_mode: "account" } },
    { status: 201, body: raw() },
    { body: raw() },
    { body: { items: [] } },
    { status: 202, body: raw({ status: "executing" }) },
    { body: raw({ status: "cancelled" }) },
    { body: { items: [] } },
  ]);
  await getConfig();
  await createProposal({ kind: "server_cycle", server: " OPT11 ", outlet: null, then_console: true, reason: "x", evil: 1 });
  await getProposal(ID);
  await listProposals(20);
  await executeProposal(ID, { password: "pw", phrase: "LAB OFF" });
  await cancelProposal(ID);
  await listProposals(500);
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
    "GET /api/assistant/actions/config", "POST /api/assistant/actions/proposals", `GET /api/assistant/actions/proposals/${ID}`,
    "GET /api/assistant/actions/proposals?limit=20", `POST /api/assistant/actions/proposals/${ID}/execute`,
    `POST /api/assistant/actions/proposals/${ID}/cancel`, "GET /api/assistant/actions/proposals?limit=20",
  ]);
  assert.deepEqual(calls[1].body, { kind: "server_cycle", server: "OPT11", then_console: true });
  assert.deepEqual(calls[4].body, { password: "pw", phrase: "LAB OFF" });
  assert.deepEqual(calls[5].body, {});
  assert.equal(calls[1].headers["Content-Type"], "application/json");
  assert.equal(calls[5].headers["Content-Type"], "application/json");
  assert.deepEqual(calls[0].headers, {});
  assert.equal(calls[0].init.cache, "no-store");
});

test("execute sends only the password (and the phrase when given); bad ids never reach the network", async t => {
  const calls = stubFetch(t, [{ body: raw({ status: "succeeded" }) }]);
  await executeProposal(ID, { password: "pw", phrase: undefined, targets: ["x"] });
  assert.deepEqual(calls[0].body, { password: "pw" });
  for (const bad of ["../x", "ABCDEF0123456789abcdef0123456789", "", null, `${ID}/cancel`]) {
    await assert.rejects(() => getProposal(bad), e => e.code === "not_found");
    await assert.rejects(() => executeProposal(bad, { password: "pw" }), e => e.code === "not_found");
  }
  assert.equal(calls.length, 1);
  assert.ok(EXECUTE_TIMEOUT_MS >= 120_000);
});

test("cleanRequest keeps only ProposalRequest fields with values", () => {
  assert.deepEqual(cleanRequest({ kind: "batch_restore", restore_of: ID, server: "", outlet: "3", then_console: "yes", reason: "r" }),
    { kind: "batch_restore", restore_of: ID });
  assert.deepEqual(cleanRequest({ kind: "outlet_off", pdu: "pdu1", outlet: 4 }), { kind: "outlet_off", pdu: "pdu1", outlet: 4 });
  assert.deepEqual(cleanRequest(null), {});
});

test("HTTP errors carry status, code, Hebrew details and Retry-After; the raw body is not kept", async t => {
  stubFetch(t, [
    { status: 409, body: { detail: "The situation changed; review the action again", code: "drift", details: ["התווית השתנתה", 5] } },
    { status: 429, body: { detail: "Too many attempts. Try again in five minutes.", code: "throttled", details: [] }, headers: { "Retry-After": "300" } },
    { status: 403, text: "<html>password=hunter2</html>" },
    { throws: new TypeError("Failed to fetch") },
  ]);
  await assert.rejects(() => executeProposal(ID, { password: "pw" }), e => {
    assert.equal(e.status, 409); assert.equal(e.code, "drift"); assert.deepEqual(e.details, ["התווית השתנתה"]);
    return true;
  });
  await assert.rejects(() => executeProposal(ID, { password: "pw" }), e => e.status === 429 && e.retryAfter === 300 && e.code === "throttled");
  await assert.rejects(() => getProposal(ID), e => e.status === 403 && !String(e.message).includes("hunter2") && e.detail === undefined);
  await assert.rejects(() => getProposal(ID), e => e.code === "network" && e.status === undefined);
});

test("normalizeProposal keeps the public fields, drops junk and computes the expiry from expires_in_s", () => {
  const p = normalizeProposal(raw({ extra: "<script>", impact: { ...raw().impact, pins: { secret: 1 } } }), 1_000_000);
  assert.equal(p.id, ID);
  assert.equal(p.sw, "maintenance_off");
  assert.equal(p.phrase, "LAB OFF");
  assert.equal(p.ends_at, 1_000_000 + 240_000);
  assert.equal(p.ttl_s, 300);
  assert.equal(p.extra, undefined);
  assert.equal(p.impact.pins, undefined);
  assert.equal(p.impact.targets.length, 3);
  assert.deepEqual(p.request, { kind: "lab_shutdown", then_console: false });
  // idempotent: a proposal handed back by another module keeps its receive time
  const again = normalizeProposal(p, 9_999_999);
  assert.equal(again.ends_at, p.ends_at);
  assert.deepEqual(again, p);
  assert.equal(normalizeProposal({ id: "nope" }), null);
  assert.equal(normalizeProposal(null), null);
  assert.equal(normalizeProposal(raw({ status: "weird" })).status, "unknown");
});

test("normalizeImpact fills counts from the lists and drops entries without a PDU", () => {
  const i = normalizeImpact({ targets: [{ pdu_id: "p", outlet: 2 }, { outlet: 3 }, { pdu_id: "p", outlet: "x" }], excluded: [{ pdu_id: "q", reason: "disabled" }] });
  assert.equal(i.targets.length, 1);
  assert.equal(i.targets[0].pdu_name, "p");
  assert.deepEqual(i.counts, { outlets: 1, pdus: 0, servers: 0, excluded: 1 });
  assert.equal(i.excluded[0].outlet, null);
});

test("mergeProposal ignores stale responses", () => {
  const pending = normalizeProposal(raw(), 1);
  const executing = normalizeProposal(raw({ status: "executing", progress: { done: 3, total: 9 } }), 2);
  const older = normalizeProposal(raw({ status: "executing", progress: { done: 1, total: 9 } }), 3);
  const done = normalizeProposal(raw({ status: "succeeded", progress: { done: 9, total: 9 } }), 4);
  assert.equal(mergeProposal(pending, executing), executing);
  assert.equal(mergeProposal(executing, pending), executing);
  assert.equal(mergeProposal(executing, older), executing);
  assert.equal(mergeProposal(executing, done), done);
  assert.equal(mergeProposal(done, executing), done);
  assert.equal(mergeProposal(null, done), done);
  const list = upsertProposal([pending], executing);
  assert.equal(list[0], executing);
  assert.equal(upsertProposal(list, older), list);
  assert.equal(upsertProposal(list, normalizeProposal(raw({ id: ID2 }))).length, 2);
});

test("countdown: m:ss, amber in the last minute, expired at zero", () => {
  const p = normalizeProposal(raw({ expires_in_s: 252 }), 0);
  assert.equal(remainingSeconds(p, 0), 252);
  assert.equal(remainingSeconds(p, 251_500), 1);
  assert.equal(remainingSeconds(p, 300_000), 0);
  assert.equal(formatCountdown(252), "4:12");
  assert.equal(formatCountdown(5), "0:05");
  assert.deepEqual(countdownLabel(252), { text: "בתוקף עוד 4:12", tone: "ok" });
  assert.deepEqual(countdownLabel(42), { text: "פג בעוד 0:42", tone: "soon" });
  assert.deepEqual(countdownLabel(0), { text: "פג תוקף", tone: "expired" });
  assert.equal(countdownLabel(null), null);
  assert.equal(displayStatus(p, 100_000), "pending");
  assert.equal(displayStatus(p, 300_000), "expired");
  assert.equal(displayStatus(normalizeProposal(raw({ status: "succeeded", expires_in_s: 0 }), 0), 10), "succeeded");
});

test("risk, role chip and status labels", () => {
  assert.equal(riskOf(normalizeProposal(raw())), "critical");
  assert.equal(riskOf(normalizeProposal(raw({ kind: "rack_shutdown", scope: "rack", phrase: "Rack-03 OFF" }))), "high");
  assert.equal(riskOf(normalizeProposal(raw({ kind: "server_cycle", scope: "server", phrase: null }))), "medium");
  assert.equal(riskOf(normalizeProposal(raw({ kind: "open_console", scope: "server", phrase: null }))), "info");
  assert.equal(riskOf(normalizeProposal(raw({ kind: "batch_restore", scope: "batch", phrase: "LAB ON" }))), "critical");
  assert.equal(riskOf(normalizeProposal(raw({ kind: "batch_restore", scope: "batch", phrase: "Rack-03 ON" }))), "batch");
  assert.equal(roleChipText(normalizeProposal(raw())), "Admin + סיסמה + צירוף אישור");
  assert.equal(roleChipText(normalizeProposal(raw({ kind: "server_off", scope: "server", phrase: null, required_role: "Operator" }))), "Operator + סיסמה");
  assert.equal(roleChipText(normalizeProposal(raw({ kind: "open_console", needs_password: false, phrase: null, required_role: "Operator" }))), "Operator (ללא סיסמה)");
  assert.equal(statusLabel("partial"), "בוצע חלקית");
  assert.equal(statusLabel("whatever"), "מצב לא ידוע");
});

test("grouping: targets by rack and PDU in natural order, excluded by reason, servers", () => {
  const p = normalizeProposal(raw());
  const groups = groupTargets(p.impact.targets);
  assert.deepEqual(groups.map(g => g.rack), ["Rack-2", "Rack-10"]);
  assert.deepEqual(groups[0].pdus[0].outlets.map(o => o.outlet), [1, 7]);
  const ex = excludedGroups(p.impact.excluded);
  assert.deepEqual(ex.map(g => g.reason), ["unreachable", "protected", "already_off"]);
  assert.equal(ex[0].short, "PDU לא זמין");
  assert.equal(keptCount(p.impact.excluded), 2);
  assert.deepEqual(groupByServer(p.impact.targets).map(s => [s.server, s.outlets.length]), [["OPT11", 2], ["OPT12", 1]]);
});

test("impact sentence, verb label, tone and client warnings come from the server impact", () => {
  const lab = normalizeProposal(raw());
  assert.equal(impactSentence(lab), "הפעולה תעביר 2 PDU לתחזוקה ותכבה בהם 3 שקעים (2 שרתים). 2 רכיבים לא ייכללו (מוגנים, בתחזוקה או לא זמינים).");
  assert.equal(verbLabel(lab), "כבה את כל המעבדה");
  assert.equal(actionTone(lab), "danger");
  const cycle = normalizeProposal(raw({
    kind: "server_cycle", scope: "server", phrase: null, required_role: "Operator",
    request: { kind: "server_cycle", server: "OPT11", then_console: true },
    impact: { ...raw().impact, excluded: [], targets: raw().impact.targets.slice(1), servers: ["OPT11"], counts: { outlets: 2, pdus: 1, servers: 1, excluded: 0 } },
  }));
  assert.equal(impactSentence(cycle), "הפעולה תנתק ותחזיר את החשמל ל־2 שקעים ב־PDU אחד (שרת אחד).");
  assert.equal(verbLabel(cycle), "אתחל את OPT11");
  const warnings = clientWarnings(cycle);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /לשרת OPT11 יש 2 שקעי חשמל/);
  assert.match(warnings[1], /OPT11 PSU2, OPT11 PSU1/);
  const on = normalizeProposal(raw({ kind: "server_on", scope: "server", phrase: null, request: { kind: "server_on", server: "OPT11" } }));
  assert.equal(actionTone(on), "safe");
  assert.equal(verbLabel(on), "הדלק את OPT11");
  const restore = normalizeProposal(raw({ kind: "batch_restore", scope: "batch", phrase: "LAB ON", request: { kind: "batch_restore", restore_of: ID2 } }));
  assert.equal(verbLabel(restore), "החזר חשמל ל־3 שקעים");
  assert.equal(actionTone(restore), "safe");
  const outlet = normalizeProposal(raw({ kind: "outlet_off", scope: "outlet", phrase: null, request: { kind: "outlet_off", pdu: "pdu1", outlet: 7 } }));
  assert.equal(verbLabel(outlet), "כבה את שקע 7 ב-PDU 02");
  assert.equal(impactSentence(normalizeProposal(raw({ kind: "open_console" }))), "פתיחת קונסול KVM בלבד. החשמל לא ישתנה.");
});

test("password label and config gate (actions need accounts mode)", () => {
  assert.equal(passwordLabelHe("account"), "הסיסמה של החשבון שלך");
  assert.equal(passwordLabelHe("shared"), "סיסמת Lab Manager");
  assert.equal(configBlockText({ enabled: true, password_mode: "account" }), "");
  assert.equal(configBlockText({ enabled: true, password_mode: "shared" }), ACCOUNTS_ONLY_TEXT);
  assert.match(configBlockText({ enabled: false, password_mode: "account" }), /כבוי/);
  assert.equal(configBlockText(undefined), "");
  assert.match(ACCOUNTS_ONLY_TEXT, /^פעולות זמינות רק במצב חשבונות/);
});

test("phrase check is exact and case-sensitive after trim; readiness lists what is missing", () => {
  assert.equal(phraseMatches("  LAB OFF ", "LAB OFF"), true);
  assert.equal(phraseMatches("lab off", "LAB OFF"), false);
  assert.equal(phraseMatches("LAB  OFF", "LAB OFF"), false);
  assert.equal(phraseMatches("", "LAB OFF"), false);
  assert.equal(phraseMatches("anything", null), true);
  const lab = normalizeProposal(raw());
  assert.deepEqual(confirmState(lab, {}), { ready: false, missing: ["phrase", "password"], hint: "כדי לבצע: הקלד את הצירוף LAB OFF והזן סיסמה." });
  assert.deepEqual(confirmState(lab, { phraseValue: "LAB OFF" }).missing, ["password"]);
  assert.equal(confirmState(lab, { phraseValue: "LAB OFF", passwordFilled: true }).ready, true);
  const server = normalizeProposal(raw({ kind: "server_off", phrase: null }));
  assert.equal(confirmState(server, { passwordFilled: true }).ready, true);
  assert.equal(confirmState(server, {}).hint, "כדי לבצע: הזן סיסמה.");
});

test("error codes map to Hebrew; refusals say nothing ran, lost responses never do", () => {
  const lab = normalizeProposal(raw());
  const e = (status, code, extra = {}) => Object.assign(new Error("x"), { status, code, ...extra });
  assert.equal(errorCode(e(403, "password")), "password");
  assert.equal(errorCode(e(403, undefined, { detail: "Password is incorrect" })), "password");
  assert.equal(errorCode(e(400, "invalid", { detail: "Password is required" })), "password_required");
  assert.equal(errorCode(e(429, undefined)), "throttled");
  assert.equal(errorCode(e(401, undefined)), "unauthenticated");
  assert.equal(errorCode(e(502, undefined)), "server");
  assert.equal(errorCode({ code: "network" }), "network");
  assert.equal(errorCode({ code: "timeout" }), "timeout");

  assert.equal(actionErrorText(e(403, "password"), { proposal: lab }), `הסיסמה שגויה. ${NOTHING_DONE}`);
  assert.equal(actionErrorText(e(403, "phrase"), { proposal: lab }), `הצירוף לא תואם. יש להקליד בדיוק: LAB OFF. ${NOTHING_DONE}`);
  assert.equal(actionErrorText(e(403, "forbidden"), { proposal: lab }), `הפעולה הזו דורשת הרשאת Admin. ${NOTHING_DONE}`);
  assert.match(actionErrorText(e(410, "expired"), { proposal: lab }), /^ההצעה פגה לפני האישור \(תוקף של 5 דקות\)/);
  const throttled = actionErrorInfo(e(429, "throttled", { retryAfter: 125 }), { proposal: lab });
  assert.equal(throttled.text, `יותר מדי ניסיונות סיסמה שגויים. אפשר לנסות שוב בעוד 2:05. ${NOTHING_DONE}`);
  assert.equal(throttled.retryAfter, 125);
  const drift = actionErrorInfo(e(409, "drift", { details: ["PDU 01: התוויות השתנו"] }), { proposal: lab });
  assert.deepEqual(drift.details, ["PDU 01: התוויות השתנו"]);
  assert.ok(drift.text.includes(NOTHING_DONE));
  for (const code of ["password_mode", "disabled", "protected", "protected_unset", "not_resolved", "ambiguous", "no_targets", "invalid", "busy", "not_found"]) {
    assert.ok(actionErrorText(e(409, code), { proposal: lab, phase: "execute" }).includes(NOTHING_DONE), code);
  }
  for (const err of [{ code: "network" }, { code: "timeout" }, e(500, undefined), e(503, "whatever")]) {
    const info = actionErrorInfo(err, { proposal: lab, phase: "execute" });
    assert.equal(info.outcomeUnknown, true, JSON.stringify(err));
    assert.ok(!info.text.includes(NOTHING_DONE), info.text);
  }
  assert.equal(actionErrorInfo({ code: "network" }, { phase: "create" }).outcomeUnknown, false);
  assert.match(actionErrorText(e(409, "busy"), { phase: "create" }), /הצעות פתוחות/);
  assert.match(actionErrorText(e(409, "not_pending"), { proposal: lab }), /כבר טופלה/);
});

test("console buttons accept only autologin URLs of a known KVM matching the entry", () => {
  const devices = [{ id: "kvm1", kind: "kvm" }, { id: "pdu1", kind: "pdu" }, { id: "kvm 2", kind: "kvm" }];
  const entry = { kvm_id: "kvm1", kvm_name: "KVM 01", port: 1, console_url: "/api/kvms/kvm1/autologin?port=1" };
  assert.deepEqual(consoleTarget(entry, devices), { deviceId: "kvm1", port: 1 });
  assert.deepEqual(consoleTarget({ kvm_id: "kvm 2", port: 3, console_url: "/api/kvms/kvm%202/autologin?port=3" }, devices), { deviceId: "kvm 2", port: 3 });
  assert.equal(consoleTarget({ ...entry, console_url: "https://evil.example/api/kvms/kvm1/autologin?port=1" }, devices), null);
  assert.equal(consoleTarget({ ...entry, console_url: "/api/kvms/pdu1/autologin?port=1", kvm_id: "pdu1" }, devices), null);
  assert.equal(consoleTarget({ ...entry, kvm_id: "kvm9" }, devices), null);
  assert.equal(consoleTarget({ ...entry, port: 2 }, devices), null);
  assert.equal(consoleTarget({ ...entry, console_url: "/api/kvms/kvm1/autologin?port=0" }, devices), null);
  assert.equal(consoleTarget(entry, []), null);
  assert.equal(consoleTarget(null, devices), null);
  const open = normalizeProposal(raw({ kind: "open_console", status: "ready", impact: { consoles: [entry] } }));
  assert.equal(proposalConsoles(open).length, 1);
  assert.equal(proposalConsoles(normalizeProposal(raw())).length, 0);
});

test("new cards go right after their source; stored messages may carry proposals or ids", () => {
  assert.deepEqual(insertAfterId(["a", "b", "c"], "a", "n"), ["a", "n", "b", "c"]);
  assert.deepEqual(insertAfterId(["a", "n", "b"], "b", "n"), ["a", "b", "n"]);
  assert.deepEqual(insertAfterId(["a"], "zz", "n"), ["a", "n"]);
  assert.deepEqual(insertAfterId(undefined, "a", "n"), ["n"]);
  const refs = proposalRefs([raw(), ID2, ID, "../evil", 5, { id: "bad" }]);
  assert.deepEqual(refs.ids, [ID, ID2]);
  assert.equal(refs.proposals.length, 1);
  assert.deepEqual(proposalRefs(null), { ids: [], proposals: [] });
});

test("result passes the abort reason and not-included outlets through unchanged", () => {
  const p = normalizeProposal(raw({
    status: "partial",
    result: { targets: [], consoles: [], summary_he: "בוצע חלקית", aborted: { pdu_id: "pdu7", reason: "unreachable" },
      pdus: [{ pdu_id: "pdu1", pdu_name: "PDU 01", ok: true, switched: [1, 2], failed: [], not_included: [5] }, { pdu_id: "pdu2", ok: false }] },
  }));
  assert.deepEqual(p.result.aborted, { pdu_id: "pdu7", reason: "unreachable" });
  assert.deepEqual(p.result.pdus[0].not_included, [5]);
  assert.equal("not_included" in p.result.pdus[1], false);
  assert.deepEqual(normalizeProposal(p), p);
});

// ---------------------------------------------------------------------------------------------------------------
// Location changes (ACT-13): server_swap / server_move / server_clear
// ---------------------------------------------------------------------------------------------------------------
function swapRaw(overrides = {}) {
  return raw({
    kind: "server_swap", scope: "server", title_he: "החלפת מיקום בין optn45 ל-optn44", required_role: "Operator",
    needs_password: false, phrase: null, background: false,
    request: { kind: "server_swap", server: "optn45", target_server: "optn44", target_ports: null, target_rack: null, target_slot: null,
      pdu: null, outlet: null, rack: null, restore_of: null, then_console: false },
    impact: {
      targets: [], excluded: [], pdus: [], servers: ["optn45", "optn44"], consoles: [], warnings_he: [],
      changes: [
        { device_id: "kvm2", device_name: "KVM-2", kind: "kvm", port: "12", before: "optn45", after: "optn44" },
        { device_id: "pdu5", device_name: "PDU-05", kind: "pdu", port: "7", before: "optn44", after: "optn45" },
        { device_id: "pdu5", device_name: "PDU-05", kind: "pdu", port: 10, before: "OPTN44 (PSU2)", after: "optn45 (PSU2)" },
        { device_id: "", device_name: "", kind: "pdu", port: "3", before: "x", after: "y" },
      ],
      positions: [{ server: "optn45", before: { rack: "Rack-05", slot: 3 }, after: { rack: "Rack-02", slot: 7 } },
        { server: "optn44", before: { rack: "Rack-02", slot: 7 }, after: { rack: "Rack-05", slot: 3 } }],
      unplaced: [],
      counts: { outlets: 0, pdus: 0, servers: 2, excluded: 0 },
    },
    ...overrides,
  });
}

test("data kinds: normalization keeps the before -> after list and the request targets (idempotent)", () => {
  const p = normalizeProposal(swapRaw(), 5);
  assert.equal(p.sw, "data");
  assert.equal(isDataKind(p), true);
  assert.equal(isDataKind("server_clear"), true);
  assert.equal(isDataKind(normalizeProposal(raw())), false);
  assert.deepEqual(DATA_KINDS, ["server_swap", "server_move", "server_clear"]);
  assert.equal(p.needs_password, false);
  assert.equal(p.impact.changes.length, 3, "an entry without a device is dropped");
  assert.deepEqual(p.impact.changes[2], { device_id: "pdu5", device_name: "PDU-05", kind: "pdu", port: "10", before: "OPTN44 (PSU2)", after: "optn45 (PSU2)" });
  assert.deepEqual(p.impact.positions[0], { server: "optn45", before: { rack: "Rack-05", slot: 3 }, after: { rack: "Rack-02", slot: 7 } });
  assert.deepEqual(p.request, { kind: "server_swap", server: "optn45", target_server: "optn44", then_console: false });
  assert.deepEqual(normalizeProposal(p), p);
  const move = normalizeProposal(swapRaw({ kind: "server_move", request: { kind: "server_move", server: "optn45",
    target_ports: [{ device: "PDU-05", port: 7 }, { device: "KVM-2", port: "12" }, { device: "", port: "1" }, { device: "x", port: "0" }, "junk"],
    target_rack: "Rack-02", target_slot: 7 } }));
  assert.deepEqual(move.request.target_ports, [{ device: "PDU-05", port: "7" }, { device: "KVM-2", port: "12" }]);
  assert.equal(move.request.target_slot, 7);
  // Missing or junk impact lists become empty lists; a position without a server is dropped.
  const bare = normalizeImpact({ changes: "x", positions: [{ before: { rack: "R" } }, { server: "a", before: { slot: 0 }, after: null }], unplaced: [1, "", "optn44"] });
  assert.deepEqual(bare.changes, []);
  assert.deepEqual(bare.positions, [{ server: "a", before: null, after: null }]);
  assert.deepEqual(bare.unplaced, ["1", "optn44"]);
  const done = normalizeProposal(swapRaw({ status: "succeeded", result: { changes: swapRaw().impact.changes.slice(0, 1), positions: [], unplaced: ["optn44"], summary_he: "בוצע" } }));
  assert.equal(done.result.changes.length, 1);
  assert.deepEqual(done.result.unplaced, ["optn44"]);
  assert.equal("changes" in normalizeProposal(raw({ status: "succeeded", result: { targets: [], pdus: [] } })).result, false);
});

test("data kinds: execute sends exactly {} (no password key); proposing again keeps the targets", async t => {
  const calls = stubFetch(t, [
    { body: swapRaw({ status: "succeeded" }) },
    { body: raw({ status: "succeeded" }) },
    { status: 201, body: swapRaw() },
  ]);
  await executeProposal(ID, {});
  await executeProposal(ID);
  await createProposal(normalizeProposal(swapRaw({ kind: "server_move", request: { kind: "server_move", server: "optn45",
    target_ports: [{ device: "PDU-05", port: "7" }], target_rack: " Rack-02 ", target_slot: 7, target_server: null } })).request);
  assert.deepEqual(calls[0].body, {});
  assert.equal(calls[0].init.body, "{}");
  assert.deepEqual(calls[1].body, {});
  assert.deepEqual(calls[2].body, { kind: "server_move", server: "optn45", target_ports: [{ device: "PDU-05", port: "7" }], target_rack: "Rack-02", target_slot: 7 });
  assert.deepEqual(cleanRequest({ kind: "server_swap", server: "a", target_server: "b", target_slot: "3", target_ports: [] }),
    { kind: "server_swap", server: "a", target_server: "b" });
  assert.equal(cleanTargetPorts(Array.from({ length: 12 }, (_, i) => ({ device: "PDU-05", port: i + 1 }))).length, 8);
});

test("data kinds: rows read 'PDU-05 · שקע 7: optn44 → optn45' and 'optn45: Rack-05 U3 → Rack-02 U7'", () => {
  const p = normalizeProposal(swapRaw());
  const rows = changeRows(p.impact.changes);
  assert.deepEqual(rows.map(r => r.text), [
    "KVM-2 · פורט 12: optn45 → optn44",
    "PDU-05 · שקע 7: optn44 → optn45",
    "PDU-05 · שקע 10: OPTN44 (PSU2) → optn45 (PSU2)",
  ]);
  assert.equal(changeRows([{ device_name: "PDU-05", kind: "pdu", port: "7", before: "optn12", after: "" }])[0].after, EMPTY_LABEL);
  assert.equal(portWord("KVM"), "פורט");
  assert.equal(portWord("pdu"), "שקע");
  assert.deepEqual(positionRows(p.impact.positions).map(r => r.text), ["optn45: Rack-05 U3 → Rack-02 U7", "optn44: Rack-02 U7 → Rack-05 U3"]);
  assert.equal(spotText(null), NO_POSITION);
  assert.equal(spotText({ rack: "", slot: 4 }), "U4");
  assert.equal(spotText({ rack: "Rack-02", slot: null }), "Rack-02");
  assert.equal(unplacedText("optn44"), "optn44 יישאר בלי מיקום");
  assert.equal(unplacedText("optn44", true), "optn44 נשאר בלי מיקום");
  assert.equal(dataChangeCount(p.impact.changes, p.impact.positions), 5);
  assert.equal(changesText(1), "שינוי אחד");
  assert.equal(changesText(5), "5 שינויים");
});

test("data kinds: risk, role chip, verb, tone, sentence and readiness without a password", () => {
  const p = normalizeProposal(swapRaw());
  assert.equal(riskOf(p), "data");
  assert.equal(RISK_LABELS[riskOf(p)], "שינוי נתונים (ללא חשמל)");
  assert.equal(roleChipText(p), "Operator (ללא סיסמה)");
  assert.equal(verbLabel(p), DATA_CONFIRM_LABEL);
  assert.equal(DATA_CONFIRM_LABEL, "אשר שינוי");
  assert.equal(actionTone(p), "data");
  assert.deepEqual(clientWarnings(p), []);
  assert.equal(impactSentence(p), "הפעולה תשנה 3 תוויות ב-PDU וב-KVM ו־2 מיקומים בארון. החשמל לא ישתנה.");
  const clear = normalizeProposal(swapRaw({ kind: "server_clear", impact: { ...swapRaw().impact, positions: [], changes: swapRaw().impact.changes.slice(1, 2) } }));
  assert.equal(impactSentence(clear), "תווית אחת תחזור לשם ברירת המחדל (Outlet N / Port N). המיקום בארון לא ישתנה. החשמל לא ישתנה.");
  assert.deepEqual(confirmState(p, {}), { ready: true, missing: [], hint: "" });
  const empty = normalizeProposal(swapRaw({ impact: { ...swapRaw().impact, changes: [], positions: [] } }));
  assert.equal(confirmState(empty, {}).ready, false);
  assert.deepEqual(confirmState(empty, {}).missing, ["changes"]);
});

test("data kinds: unplaced warnings are not repeated; drift and no_targets have their own Hebrew text", () => {
  const p = normalizeProposal(swapRaw({ kind: "server_move", impact: { ...swapRaw().impact, unplaced: ["optn44"],
    warnings_he: ["optn44 יישאר בלי מיקום", "התווית של PDU-05 שונתה ידנית"] } }));
  assert.deepEqual(dataWarnings(p), ["התווית של PDU-05 שונתה ידנית"]);
  const e = (status, code, extra = {}) => Object.assign(new Error("x"), { status, code, ...extra });
  const drift = actionErrorInfo(e(409, "drift", { details: [DATA_DRIFT_TEXT, "PDU-05 · שקע 7"] }), { proposal: p });
  assert.equal(drift.text, `המיקומים השתנו מאז ההצעה. ${NOTHING_DONE} אפשר להציע שוב ולקבל רשימה מעודכנת.`);
  assert.deepEqual(drift.details, ["PDU-05 · שקע 7"]);
  assert.match(actionErrorText(e(409, "no_targets"), { proposal: p }), /^אין מה לשנות/);
  // Proposing again: the planner's English refusal is the only explanation, shown as a detail (create phase only).
  const occupied = actionErrorInfo(e(409, "invalid", { detail: "Port 7 is used by optn46; choose it as target_server to swap" }), { proposal: p, phase: "create" });
  assert.deepEqual(occupied.details, ["Port 7 is used by optn46; choose it as target_server to swap"]);
  assert.deepEqual(actionErrorInfo(e(409, "invalid", { detail: "x" }), { proposal: p, phase: "execute" }).details, []);
  assert.deepEqual(actionErrorInfo(e(409, "invalid", { detail: "x" }), { proposal: normalizeProposal(raw()), phase: "create" }).details, []);
});

test("data kinds: the result says 'בוצע: N שינויים' with the applied list, or why nothing changed", () => {
  const changes = swapRaw().impact.changes.slice(0, 3);
  const done = dataResultView(swapRaw({ status: "succeeded", result: { changes, positions: swapRaw().impact.positions, unplaced: [], summary_he: "השינויים הוחלו." } }));
  assert.equal(done.text, "בוצע: 5 שינויים");
  assert.equal(done.tone, "ok");
  assert.equal(done.alert, false);
  assert.deepEqual(done.lines, ["השינויים הוחלו."]);
  assert.equal(done.applied.count, 5);
  assert.equal(changeRows(done.applied.changes)[1].text, "PDU-05 · שקע 7: optn44 → optn45");
  // An older server without a list in the result: the proposal's own list is what was applied.
  assert.equal(dataResultView(swapRaw({ status: "succeeded", result: { summary_he: "" } })).text, "בוצע: 5 שינויים");
  const refused = dataResultView(swapRaw({ status: "refused", result: { summary_he: "המצב השתנה; יש לבקש הצעה חדשה." } }));
  assert.match(refused.text, /^המיקומים השתנו מאז ההצעה/);
  assert.deepEqual(refused.lines, []);
  assert.equal(refused.applied, null);
  assert.equal(dataResultView(swapRaw({ status: "failed", result: null })).alert, true);
  assert.equal(dataResultView(swapRaw({ status: "partial", result: { changes: changes.slice(0, 1) } })).text, "בוצע חלקית: 3 שינויים");
  assert.equal(dataResultView(swapRaw({ status: "executing" })).tone, "running");
  assert.equal(dataResultView(swapRaw({ status: "pending" })), null);
  assert.equal(dataResultView(raw({ status: "succeeded" })), null, "power kinds keep ACT-9's result view");
});

test("data kinds follow ACT-12's planner output: unchanged positions, null labels, its own unplaced and refused texts", () => {
  // The planner lists every involved server, also one whose position stays; cleared labels are null.
  const p = normalizeProposal(swapRaw({ kind: "server_move", impact: { ...swapRaw().impact,
    changes: [{ device_id: "pdu5", device_name: "PDU-05", kind: "pdu", port: 8, before: "optn45 (PSU2)", after: null }],
    positions: [{ server: "optn45", before: { rack: "Rack-05", slot: 3 }, after: { rack: "Rack-02", slot: 7 } },
      { server: "optn46", before: { rack: "Rack-02", slot: 9 }, after: { rack: "Rack-02", slot: 9 } },
      { server: "optn44", before: { rack: "Rack-02", slot: 7 }, after: { rack: null, slot: null } }],
    unplaced: ["optn44"],
    warnings_he: ["optn44 יישאר בלי מיקום: בלי שקעי PDU, בלי יציאות KVM ובלי מקום בארון."] } }));
  assert.deepEqual(movedPositions(p.impact.positions).map(x => x.server), ["optn45", "optn44"]);
  assert.deepEqual(positionRows(p.impact.positions).map(r => r.text), ["optn45: Rack-05 U3 → Rack-02 U7", "optn44: Rack-02 U7 → בלי מיקום"]);
  assert.equal(dataChangeCount(p.impact.changes, p.impact.positions), 3);
  assert.equal(changeRows(p.impact.changes)[0].text, "PDU-05 · שקע 8: optn45 (PSU2) → (ריק)");
  assert.equal(impactSentence(p), "הפעולה תשנה תווית אחת ב-PDU וב-KVM ו־2 מיקומים בארון. החשמל לא ישתנה.");
  assert.deepEqual(unplacedLines(p.impact.unplaced, p.impact.warnings_he),
    [{ name: "optn44", text: "optn44 יישאר בלי מיקום: בלי שקעי PDU, בלי יציאות KVM ובלי מקום בארון." }]);
  assert.deepEqual(unplacedLines(["optn44"], [], true), [{ name: "optn44", text: "optn44 נשאר בלי מיקום" }]);
  assert.deepEqual(dataWarnings(p), []);
  // Only unchanged positions and no label: nothing to confirm.
  const still = normalizeProposal(swapRaw({ impact: { ...swapRaw().impact, changes: [], positions: [p.impact.positions[1]] } }));
  assert.equal(confirmState(still, {}).ready, false);
  // runner refused summary starts with the same headline: not repeated as a line.
  const refused = dataResultView(swapRaw({ status: "refused",
    result: { changes: [], positions: [], unplaced: [], summary_he: "המיקומים השתנו מאז ההצעה, ולכן לא בוצע שום שינוי. יש לבקש הצעה חדשה." } }));
  assert.deepEqual(refused.lines, []);
  const failed = dataResultView(swapRaw({ status: "failed",
    result: { changes: [], positions: [], unplaced: [], summary_he: "השינוי לא נשמר ולא בוצע שום שינוי. אפשר לנסות שוב." } }));
  assert.equal(failed.text, "השינוי לא נשמר ולא בוצע שום שינוי. אפשר לנסות שוב.");
  const done = dataResultView(swapRaw({ status: "succeeded", result: { changes: p.impact.changes, positions: p.impact.positions, unplaced: ["optn44"],
    summary_he: "השינוי נשמר: 1 שינויי תוויות ו-2 שינויי מיקום בארון. נשארו בלי מיקום: optn44. לא בוצע שום שינוי חשמל." } }));
  assert.equal(done.text, "בוצע: 3 שינויים");
  assert.equal(done.lines.length, 1);
});

test("data kinds: the device tables reload once when a watched change finished", () => {
  assert.equal(dataChangeFinished("pending", "succeeded"), true);
  assert.equal(dataChangeFinished("executing", "failed"), true);
  assert.equal(dataChangeFinished("pending", "refused"), false, "drift: nothing changed");
  assert.equal(dataChangeFinished("pending", "cancelled"), false);
  assert.equal(dataChangeFinished("succeeded", "succeeded"), false, "a card mounted on a finished proposal does not reload");
  assert.equal(dataChangeFinished(undefined, "succeeded"), false);
});

test("generationGuard: an answer that arrives after a sign-out or user change is dropped", async () => {
  let epoch = 4;
  const published = [];
  const publish = (p, e) => { if (e === epoch) published.push(p); };   // AssistantPanel.onActionExecuted's rule
  async function execute(answer) {
    const session = generationGuard(() => epoch);
    const res = await answer;
    if (!session.isCurrent()) return "dropped";
    publish(res, session.epoch);
    return "published";
  }
  assert.equal(await execute(Promise.resolve("first")), "published");
  let release;
  const late = execute(new Promise(resolve => { release = resolve; }));
  epoch += 1;                                   // resetActions(): sign-out / another user
  release("late");
  assert.equal(await late, "dropped");
  assert.deepEqual(published, ["first"]);
  const g = generationGuard(() => epoch);
  assert.equal(g.epoch, 5);
  assert.equal(g.isCurrent(), true);
  const none = generationGuard(undefined);       // a card outside the panel: nothing to compare
  assert.equal(none.epoch, undefined);
  assert.equal(none.isCurrent(), true);
});
