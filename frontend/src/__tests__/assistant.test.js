import test from "node:test";
import assert from "node:assert/strict";
import {
  getStatus, sendMessage, listConversations, getConversation, resetConversation, listWorkItems, saveWorkItem, updateWorkItem,
  parseRetryAfter, errorText, isRetryable, rateLimitText, formatAge, formatAsOf, sourceStatusLabel, priorityLabel, entityLink,
  normalizeAnswer, normalizeSources, normalizeMessages, normalizeConversations, draftFromRecommendation, cleanContext,
  mergeContext, contextKey, contextLabel, charCountText, bidiSegments, knownRacks, safeId, CHAT_TIMEOUT_MS,
} from "../api/assistant.js";

const realFetch = globalThis.fetch;

// Each queued reply answers the next request in order; every request is recorded.
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

// A fetch that never answers until its signal aborts, like a slow model call.
function hangingFetch(t) {
  const calls = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    calls.push({ url, init });
    init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

test("requests use the contract paths, methods and bodies", async t => {
  const calls = stubFetch(t, [
    { body: { enabled: true, mode: "demo" } },
    { body: { conversation_id: "c1", answer: {} } },
    { body: [] },
    { body: { messages: [] } },
    { status: 204 },
    { body: [] },
    { status: 201, body: { id: "w1" } },
    { body: { id: "w1", status: "done" } },
  ]);
  await getStatus();
  await sendMessage({ conversationId: "c1", message: "מה נפל?", context: { tab: "power", rack: null, detail: { kind: "pdu", id: "pdu-1" } } });
  await listConversations();
  await getConversation("a/b");
  assert.equal(await resetConversation("c1"), null);
  await listWorkItems();
  const draft = { title: "t", description: "d", entity_refs: [], priority: "high", rationale: "r", steps: ["s"] };
  await saveWorkItem(draft, "c1");
  await updateWorkItem("w1", { status: "done" });
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
    "GET /api/assistant/status", "POST /api/assistant/chat", "GET /api/assistant/conversations",
    "GET /api/assistant/conversations/a%2Fb", "DELETE /api/assistant/conversations/c1", "GET /api/assistant/work-items",
    "POST /api/assistant/work-items", "PATCH /api/assistant/work-items/w1",
  ]);
  assert.deepEqual(calls[1].body, { message: "מה נפל?", conversation_id: "c1", context: { tab: "power", detail: { kind: "pdu", id: "pdu-1" } } });
  assert.equal(calls[1].headers["Content-Type"], "application/json");
  assert.deepEqual(calls[0].headers, {});
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[4].headers["Content-Type"], "application/json");
  assert.deepEqual(calls[6].body, { draft, confirm: true, conversation_id: "c1" });
  assert.deepEqual(calls[7].body, { status: "done" });
});

test("a first question has no conversation id and drops an empty context", async t => {
  const calls = stubFetch(t, [{ body: {} }]);
  await sendMessage({ message: "שלום", context: { tab: "nope", detail: { kind: "evil", id: "x" } } });
  assert.deepEqual(calls[0].body, { message: "שלום" });
});

test("errors carry status, detail and Retry-After seconds", async t => {
  stubFetch(t, [
    { status: 429, body: { detail: "Too many questions" }, headers: { "Retry-After": "17" } },
    { status: 403, body: { detail: "Your role does not allow this action." } },
    { status: 422, body: { detail: [{ msg: "message too long" }, { msg: "bad context" }] } },
    { status: 502, text: "Bad gateway" },
    { status: 503, body: { detail: "העוזר אינו זמין כרגע (מודל השפה לא הגיב)." } },
  ]);
  await assert.rejects(sendMessage({ message: "x" }), e => e.status === 429 && e.retryAfter === 17 && errorText(e) === "יותר מדי שאלות, נסה שוב בעוד 17 שניות");
  await assert.rejects(saveWorkItem({}, null), e => e.status === 403 && e.detail === "Your role does not allow this action."
    && errorText(e).includes("Operator") && !errorText(e).includes("role does not"));
  await assert.rejects(getStatus(), e => e.status === 422 && e.detail === "message too long; bad context");
  await assert.rejects(listWorkItems(), e => e.status === 502 && e.detail === undefined && errorText(e) === "השרת לא הגיב כראוי. נסה שוב בעוד מעט.");
  await assert.rejects(getStatus(), e => e.status === 503 && errorText(e) === "העוזר אינו זמין כרגע (מודל השפה לא הגיב).");
});

test("Retry-After accepts seconds, HTTP dates and a body field", async t => {
  const now = Date.parse("2026-10-18T10:00:00Z");
  assert.equal(parseRetryAfter("5"), 5);
  assert.equal(parseRetryAfter("2.2"), 3);
  assert.equal(parseRetryAfter("0"), 1);
  assert.equal(parseRetryAfter("Sun, 18 Oct 2026 10:00:30 GMT", now), 30);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  stubFetch(t, [{ status: 429, body: { detail: { message: "slow down", retry_after: 42 } } }]);
  await assert.rejects(sendMessage({ message: "x" }), e => e.retryAfter === 42 && e.detail === "slow down");
  assert.equal(rateLimitText(undefined), "יותר מדי שאלות, נסה שוב בעוד דקה");
});

test("the chat request times out after 100 seconds, not before", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  hangingFetch(t);
  let settled = null;
  const pending = sendMessage({ message: "שאלה ארוכה" }).then(() => { settled = "resolved"; }, e => { settled = e; });
  assert.equal(CHAT_TIMEOUT_MS, 100_000);
  t.mock.timers.tick(99_999);
  await new Promise(r => setImmediate(r));
  assert.equal(settled, null);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(settled.code, "timeout");
  assert.equal(errorText(settled), "התשובה לקחה יותר מדי זמן. נסה שוב, או שאל שאלה ממוקדת יותר.");
  assert.equal(isRetryable(settled), true);
});

test("a short custom timeout and the caller's Stop are told apart", async t => {
  hangingFetch(t);
  await assert.rejects(getStatus({ timeoutMs: 15 }), e => e.code === "timeout");
  const controller = new AbortController();
  const pending = sendMessage({ message: "x" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, e => e.code === "aborted" && e.name === "AbortError" && errorText(e) === "השאלה בוטלה.");
  const already = new AbortController();
  already.abort();
  await assert.rejects(sendMessage({ message: "x" }, { signal: already.signal }), e => e.code === "aborted");
});

test("a network failure and a non-JSON success get their own Hebrew text", async t => {
  stubFetch(t, [{ throws: new TypeError("Failed to fetch") }, { text: "<html>spa</html>" }]);
  await assert.rejects(getStatus(), e => e.code === "network" && errorText(e) === "אין חיבור לשרת. בדוק את החיבור ונסה שוב.");
  await assert.rejects(getStatus(), e => e.code === "bad_response" && errorText(e).includes("לא צפויה"));
});

test("errorText maps every status to Hebrew and keeps Hebrew server details", () => {
  assert.equal(errorText({ status: 504 }), "התשובה לקחה יותר מדי זמן. נסה שוב, או שאל שאלה ממוקדת יותר.");
  assert.equal(errorText({ status: 503, detail: "Service Unavailable" }), "העוזר אינו זמין כרגע. נסה שוב בעוד מעט.");
  assert.equal(errorText({ status: 400, detail: "ההודעה ארוכה מדי (מקסימום 2000 תווים)." }), "ההודעה ארוכה מדי (מקסימום 2000 תווים).");
  assert.equal(errorText({ status: 429, retryAfter: 9, detail: "אחר" }), "יותר מדי שאלות, נסה שוב בעוד 9 שניות");
  assert.match(errorText({ status: 403 }), /Viewer/);
  assert.match(errorText({ status: 404 }), /לא נמצאה/);
  assert.equal(errorText({ status: 418 }), "הבקשה נכשלה (HTTP 418).");
  assert.equal(errorText(new Error("boom")), "הבקשה נכשלה. בדוק את החיבור ונסה שוב.");
  assert.equal(errorText(null), "");
  assert.equal(isRetryable({ status: 400 }), false);
  assert.equal(isRetryable({ status: 429 }), true);
});

test("formatAge speaks Hebrew relative time and admits unknown ages", () => {
  assert.equal(formatAge(0), "לפני פחות מדקה");
  assert.equal(formatAge(59.9), "לפני פחות מדקה");
  assert.equal(formatAge(60), "לפני דקה");
  assert.equal(formatAge(180), "לפני 3 דק׳");
  assert.equal(formatAge(3600), "לפני שעה");
  assert.equal(formatAge(7200), "לפני שעתיים");
  assert.equal(formatAge(5 * 3600), "לפני 5 שע׳");
  assert.equal(formatAge(86400), "לפני יום");
  assert.equal(formatAge(2 * 86400), "לפני יומיים");
  assert.equal(formatAge(9 * 86400), "לפני 9 ימים");
  assert.equal(formatAge(-5), "לפני פחות מדקה");
  assert.equal(formatAge(null), "זמן עדכון לא ידוע");
  assert.equal(formatAge(undefined), "זמן עדכון לא ידוע");
  assert.equal(formatAge("abc"), "זמן עדכון לא ידוע");
  assert.equal(formatAsOf(null), "—");
  assert.equal(formatAsOf("not a date"), "—");
  assert.match(formatAsOf("2026-10-18T07:05:00+00:00"), /10:05/);   // Asia/Jerusalem is UTC+3 in October
});

test("labels for source status and priority", () => {
  assert.deepEqual(["ok", "stale", "missing", "unavailable", "disabled"].map(sourceStatusLabel), ["עדכני", "ישן", "חסר", "לא זמין", "כבוי"]);
  assert.equal(sourceStatusLabel("weird"), "לא ידוע");
  assert.deepEqual(["high", "medium", "low"].map(priorityLabel), ["גבוהה", "בינונית", "נמוכה"]);
  assert.equal(priorityLabel(undefined), "לא צוינה");
  assert.equal(charCountText(12, 2000), "12/2000");
});

test("entityLink links only to loaded PDU/KVM ids and known racks (SEC-AI-7)", () => {
  const devices = [{ id: "7", kind: "pdu", name: "PDU-Rack-01", rack: "Rack-01" }, { id: 9, kind: "kvm", name: "KVM-Unit1", rack: "Rack-02" }];
  assert.deepEqual(entityLink({ kind: "pdu", id: "7", label: "PDU-Rack-01" }, devices), { tab: "power", detail: { kind: "pdu", id: "7" } });
  assert.deepEqual(entityLink({ kind: "kvm", id: "9", label: "x" }, devices), { tab: "consoles", detail: { kind: "kvm", id: 9 } });
  assert.deepEqual(entityLink({ kind: "rack", id: "Rack-01", label: "Rack-01" }, devices), { tab: "racks", rack: "Rack-01" });
  assert.deepEqual(entityLink({ kind: "rack", id: "Rack-09" }, devices, ["Rack-09"]), { tab: "racks", rack: "Rack-09" });
  // unknown ids, a name instead of the id, the wrong kind and no device list -> no link
  assert.equal(entityLink({ kind: "pdu", id: "404", label: "gone" }, devices), null);
  assert.equal(entityLink({ kind: "pdu", id: "PDU-Rack-01", label: "PDU-Rack-01" }, devices), null);
  assert.equal(entityLink({ kind: "kvm", id: "7" }, devices), null);
  assert.equal(entityLink({ kind: "pdu", id: "7" }), null);
  assert.equal(entityLink({ kind: "rack", id: "Rack-77" }, devices), null);
  // unsafe ids -> no link
  assert.equal(entityLink({ kind: "pdu", id: "javascript:alert(1)" }, [...devices, { id: "javascript:alert(1)", kind: "pdu" }]), null);
  assert.equal(entityLink({ kind: "rack", id: "javascript:alert(1)" }, devices, ["javascript:alert(1)"]), null);
  assert.equal(entityLink({ kind: "rack", id: "Rack-01\nRack-02" }, devices, ["Rack-01\nRack-02"]), null);
  assert.equal(entityLink({ kind: "rack", id: "Rack-01\n" }, devices), null);
  assert.equal(entityLink({ kind: "rack", id: "" }, devices), null);
  assert.equal(entityLink({ kind: "rack", id: "x".repeat(65) }, devices, ["x".repeat(65)]), null);
  // kinds without a record page -> plain text
  for (const kind of ["server", "item", "incident", "maintenance", "work_item", "javascript:alert(1)"]) assert.equal(entityLink({ kind, id: "7" }, devices), null);
  assert.equal(entityLink(null, devices), null);
  assert.deepEqual(knownRacks([...devices, { rack: "Bad\nRack" }, { rack: null }, { rack: "Rack-01" }]), ["Rack-01", "Rack-02"]);
  assert.equal(safeId("opt207"), "opt207");
  assert.equal(safeId(7), "7");
  assert.equal(safeId(" opt207"), null);
  assert.equal(safeId("a<b"), null);
});

test("normalizeAnswer tolerates missing arrays, wrong types and a bare string", () => {
  const empty = normalizeAnswer(undefined);
  assert.deepEqual(empty, { summary: "", facts: [], hypotheses: [], recommendations: [], checks: [], missing_data: [], entity_refs: [], work_item_drafts: [] });
  assert.equal(normalizeAnswer("רק טקסט").summary, "רק טקסט");
  const a = normalizeAnswer({
    summary: "סיכום",
    facts: [{ text: "OPT207 לא עונה לפינג", source_ids: ["ping:opt207"] }, { text: "" }, "junk", null, { text: "בלי מקור" }],
    hypotheses: [{ text: "השקע כבוי", support: "שקע 4 במצב off", verify: "בדוק את השקע" }],
    recommendations: [{ title: "בדיקת שקע", priority: "urgent", missing_info: null, entity_refs: [{ kind: "pdu", id: "7" }, { id: "x" }] }],
    checks: ["לבדוק פינג", 5, "", null],
    missing_data: "אין נתוני UPS",
    entity_refs: [{ kind: "server", id: "opt207", label: "OPT207" }],
    work_item_drafts: [{ title: "טיוטה", steps: "צעד" }, { description: "no title" }],
    extra_field: "ignored",
  });
  assert.equal(a.facts.length, 2);
  assert.deepEqual(a.facts[1], { text: "בלי מקור", source_ids: [] });
  assert.deepEqual(a.hypotheses[0].support, ["שקע 4 במצב off"]);
  assert.deepEqual(a.hypotheses[0].source_ids, []);
  assert.equal(a.recommendations[0].priority, "medium");
  assert.deepEqual(a.recommendations[0].missing_info, []);
  assert.deepEqual(a.recommendations[0].entity_refs, [{ kind: "pdu", id: "7", label: "7" }]);
  assert.deepEqual(a.checks, ["לבדוק פינג", "5"]);
  assert.deepEqual(a.missing_data, ["אין נתוני UPS"]);
  assert.deepEqual(a.work_item_drafts, [{ title: "טיוטה", description: "", entity_refs: [], priority: "medium", rationale: "", steps: ["צעד"] }]);
  assert.equal("extra_field" in a, false);
});

test("sources, stored messages and the conversation list are normalised", () => {
  const sources = normalizeSources([
    { id: "ping:opt207", name: "Ping monitor", ref: "opt207", as_of: "2026-10-18T07:00:00+00:00", age_s: 120, status: "stale", note: "overdue" },
    { name: "Alerts", status: "bogus", age_s: "12" },
    "junk",
  ]);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].status, "stale");
  assert.equal(sources[1].id, "source-2");
  assert.equal(sources[1].status, "unknown");
  assert.equal(sources[1].age_s, null);
  assert.deepEqual(normalizeSources(undefined), []);

  const messages = normalizeMessages({ messages: [
    { id: "1", role: "user", text: "מה נפל?", created_at: "2026-10-18T07:00:00Z" },
    { id: "2", role: "assistant", text: "סיכום", answer: { summary: "סיכום" }, sources: [{ id: "s" }], mode: "demo" },
    { id: "3", role: "system", text: "hidden" },
    { id: "4", role: "assistant", text: "legacy text only" },
  ] });
  assert.deepEqual(messages.map(m => m.role), ["user", "assistant", "assistant"]);
  assert.equal(messages[0].answer, undefined);
  assert.equal(messages[1].mode, "demo");
  assert.equal(messages[1].sources[0].id, "s");
  assert.equal(messages[2].answer.summary, "legacy text only");
  assert.equal(messages[2].mode, null);
  assert.deepEqual(normalizeMessages(null), []);

  assert.deepEqual(normalizeConversations([{ id: "c1", title: "", updated_at: "2026-10-18T07:00:00Z", message_count: 4 }, { title: "no id" }]),
    [{ id: "c1", title: "שיחה ללא כותרת", updated_at: "2026-10-18T07:00:00Z", message_count: 4 }]);
});

test("a recommendation becomes an editable draft, preferring the answer's own draft", () => {
  const rec = { title: "החלפת שקע", problem: "השקע כבוי", evidence: "שקע 4 off", priority: "high", next_step: "להדליק את השקע",
    missing_info: ["אין יומן שינויים"], entity_refs: [{ kind: "pdu", id: "7", label: "PDU-1" }] };
  const built = draftFromRecommendation(rec, []);
  assert.equal(built.title, "החלפת שקע");
  assert.equal(built.priority, "high");
  assert.deepEqual(built.steps, ["להדליק את השקע"]);
  assert.match(built.description, /השקע כבוי/);
  assert.match(built.description, /אין יומן שינויים/);
  assert.equal(built.rationale, "שקע 4 off");
  assert.deepEqual(built.entity_refs, [{ kind: "pdu", id: "7", label: "PDU-1" }]);
  const own = draftFromRecommendation(rec, [{ title: "החלפת שקע", description: "מהשרת", steps: ["א", "ב"], priority: "low" }]);
  assert.equal(own.description, "מהשרת");
  assert.deepEqual(own.steps, ["א", "ב"]);
  assert.equal(own.priority, "low");
});

test("context is cleaned, limited to known racks, merged with a page selection and labelled (SEC-AI-6)", () => {
  const racks = ["Rack-01", "Rack-02"];
  assert.equal(cleanContext(null), null);
  assert.deepEqual(cleanContext({ tab: "racks", rack: "Rack-01", detail: null }, { racks }), { tab: "racks", rack: "Rack-01" });
  assert.deepEqual(cleanContext({ tab: "racks", rack: "Rack-99" }, { racks }), { tab: "racks" });
  assert.deepEqual(cleanContext({ tab: "racks", rack: "Rack-01\n" }, { racks: ["Rack-01\n"] }), { tab: "racks" });
  assert.deepEqual(cleanContext({ detail: { kind: "rack", id: "Rack-99" } }, { racks }), null);
  assert.deepEqual(cleanContext({ tab: "power", detail: { kind: "pdu", id: 7 } }), { tab: "power", detail: { kind: "pdu", id: "7" } });
  assert.equal(cleanContext({ detail: { kind: "pdu", id: "x".repeat(65) } }), null);
  assert.equal(cleanContext({ rack: "Rack\u0000-01" }), null);
  assert.equal(cleanContext({ tab: "evil", detail: { kind: "server", id: "<img src=x>" } }), null);
  assert.deepEqual(mergeContext({ tab: "racks", rack: "Rack-01" }, { kind: "server", id: "opt207" }, { racks }),
    { tab: "racks", rack: "Rack-01", detail: { kind: "server", id: "opt207" } });
  assert.deepEqual(mergeContext({ tab: "racks" }, { detail: { kind: "item", id: "ci-1" }, rack: "Rack-02" }, { racks }),
    { tab: "racks", rack: "Rack-02", detail: { kind: "item", id: "ci-1" } });
  assert.deepEqual(mergeContext({ tab: "racks", rack: "Rack-01" }, { rack: "Unknown" }, { racks }), { tab: "racks", rack: "Rack-01" });
  assert.deepEqual(mergeContext({ tab: "monitoring" }, null), { tab: "monitoring" });
  assert.equal(contextKey({ tab: "power", detail: { kind: "pdu", id: "7" } }), contextKey({ tab: "power", detail: { kind: "pdu", id: 7 } }));
  assert.notEqual(contextKey({ tab: "power" }), contextKey({ tab: "consoles" }));
  const devices = [{ id: "7", kind: "pdu", name: "PDU Rack-01" }];
  assert.deepEqual(contextLabel({ tab: "power", detail: { kind: "pdu", id: "7" } }, devices), { prefix: "PDU", name: "PDU Rack-01" });
  assert.deepEqual(contextLabel({ tab: "inventory", detail: { kind: "server", id: "opt207" } }), { prefix: "שרת", name: "opt207" });
  assert.deepEqual(contextLabel({ tab: "racks", rack: "Rack-01" }), { prefix: "ארון", name: "Rack-01" });
  assert.deepEqual(contextLabel({ tab: "monitoring" }), { prefix: "עמוד", name: "ניטור" });
  assert.equal(contextLabel({ tab: "dashboard" }), null);
});

test("requests resolve globalThis.fetch at call time and stay relative to /api/assistant (SEC-AI-18)", async t => {
  const seen = [];
  const first = async url => { seen.push(["first", url]); return new Response("{}", { status: 200 }); };
  const second = async url => { seen.push(["second", url]); return new Response("{}", { status: 200 }); };
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = first;
  await getStatus();
  globalThis.fetch = second;   // e.g. the accounts wrapper installed after this module was imported
  await listConversations();
  assert.deepEqual(seen, [["first", "/api/assistant/status"], ["second", "/api/assistant/conversations"]]);
});

test("bidiSegments isolates ids, IPs and names inside Hebrew text", () => {
  assert.deepEqual(bidiSegments("השרת OPT207 בארון Rack-01, כתובת 10.7.30.5 לא עונה 3 פעמים."), [
    { text: "השרת ", ltr: false }, { text: "OPT207", ltr: true }, { text: " בארון ", ltr: false }, { text: "Rack-01", ltr: true },
    { text: ", כתובת ", ltr: false }, { text: "10.7.30.5", ltr: true }, { text: " לא עונה 3 פעמים.", ltr: false },
  ]);
  assert.deepEqual(bidiSegments("שלום"), [{ text: "שלום", ltr: false }]);
  assert.deepEqual(bidiSegments(""), []);
  assert.deepEqual(bidiSegments(null), []);
  assert.equal(bidiSegments("PDU ping_targets:opt207 x").map(s => s.text).join(""), "PDU ping_targets:opt207 x");
  // English phrases stay one run (word order is kept in RTL), settings names are not split at "_" or "="
  assert.deepEqual(bidiSegments("פירוט: Device observation is unreachable.").filter(s => s.ltr).map(s => s.text), ["Device observation is unreachable"]);
  assert.deepEqual(bidiSegments("מודל השפה כבוי (ASSISTANT_LLM_ENABLED=false).").filter(s => s.ltr).map(s => s.text), ["ASSISTANT_LLM_ENABLED=false"]);
  assert.deepEqual(bidiSegments("השרתים OPT71, OPT72 בארון").filter(s => s.ltr).map(s => s.text), ["OPT71, OPT72"]);
  assert.deepEqual(bidiSegments("PDU 07: בדוק את KVM 01").filter(s => s.ltr).map(s => s.text), ["PDU 07", "KVM 01"]);
  assert.deepEqual(bidiSegments("נצפה ב־2026-10-18 11:59 לפני 3 דקות").filter(s => s.ltr), []);
});
