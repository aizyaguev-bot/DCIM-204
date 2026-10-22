// Lab assistant API (/api/assistant) and pure helpers used by the assistant panel.
// Helpers stay free of DOM/React so node --test can import this module.
// Requests go through the global fetch wrapper (accounts.jsx), which adds X-DCIM-CSRF to writes.

const BASE = "/api/assistant";
export const CHAT_TIMEOUT_MS = 100_000;   // the server's own budget is 90 s
export const REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_CHARS = 2000;
export const CONTEXT_ID_MAX = 64;

// "Retry-After" is either seconds or an HTTP date; returns whole seconds (>= 1) or undefined.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : undefined;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(1, Math.ceil(Number(text)));
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - now) / 1000)) : undefined;
}

function detailText(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map(e => (typeof e === "string" ? e : e?.msg)).filter(Boolean).join("; ") || undefined;
  if (detail && typeof detail === "object" && typeof detail.message === "string") return detail.message;
  return undefined;
}

function failure(message, props) {
  return Object.assign(new Error(message), props);
}

// One request with a timeout. The caller's signal (Stop button) and the timer both abort the fetch;
// the thrown Error tells them apart with .code = "aborted" | "timeout" | "network" | "bad_response".
async function req(method, path, body, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw failure("The request was cancelled.", { code: "aborted", name: "AbortError" });
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  try {
    let res;
    try {
      // Looked up at call time so the accounts wrapper (CSRF header, session expiry) always applies.
      res = await globalThis.fetch(`${BASE}${path}`, {
        method,
        cache: "no-store",
        signal: controller.signal,
        // Writes always declare JSON: in shared-password mode the router accepts only JSON writes.
        headers: method !== "GET" ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (timedOut) throw failure("The assistant did not answer in time.", { code: "timeout" });
      if (signal?.aborted || e?.name === "AbortError") throw failure("The request was cancelled.", { code: "aborted", name: "AbortError" });
      throw failure("The server could not be reached.", { code: "network" });
    }
    if (!res.ok) {
      let text = "";
      try { text = await res.text(); } catch {}
      const err = failure(`${res.status}: ${text.slice(0, 300)}`, { status: res.status });
      let data;
      try { data = JSON.parse(text); } catch {}
      err.detail = detailText(data?.detail);
      err.retryAfter = parseRetryAfter(res.headers?.get?.("Retry-After"))
        ?? parseRetryAfter(data?.retry_after ?? data?.detail?.retry_after);
      throw err;
    }
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      if (timedOut) throw failure("The assistant did not answer in time.", { code: "timeout" });
      if (signal?.aborted) throw failure("The request was cancelled.", { code: "aborted", name: "AbortError" });
      throw failure("Unexpected response from the server.", { code: "bad_response", status: res.status });
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

const enc = id => encodeURIComponent(String(id));

export function getStatus(options) {
  return req("GET", "/status", undefined, options);
}

export function sendMessage({ conversationId, message, context } = {}, { signal, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
  const body = { message: String(message ?? "") };
  if (conversationId) body.conversation_id = String(conversationId);
  const ctx = cleanContext(context);
  if (ctx) body.context = ctx;
  return req("POST", "/chat", body, { signal, timeoutMs });
}

export function listConversations(options) {
  return req("GET", "/conversations", undefined, options);
}

export function getConversation(id, options) {
  return req("GET", `/conversations/${enc(id)}`, undefined, options);
}

export function resetConversation(id, options) {
  return req("DELETE", `/conversations/${enc(id)}`, undefined, options);
}

export function listWorkItems(options) {
  return req("GET", "/work-items", undefined, options);
}

// Saving needs the user's explicit confirmation in the UI; the request always carries confirm: true.
export function saveWorkItem(draft, conversationId, options) {
  const body = { draft, confirm: true };
  if (conversationId) body.conversation_id = String(conversationId);
  return req("POST", "/work-items", body, options);
}

export function updateWorkItem(id, patch, options) {
  return req("PATCH", `/work-items/${enc(id)}`, patch || {}, options);
}

export const assistantApi = { getStatus, sendMessage, listConversations, getConversation, resetConversation, listWorkItems, saveWorkItem, updateWorkItem };

// ---------------------------------------------------------------------------------------------------------------
// Context sent with a question: only short ids and names; the server re-reads and authorizes everything.
// Ids follow the server's rule (SEC-AI-6): a letter or digit, then letters, digits, space . _ : / - (max 64).
// A rack is sent only when it is a known rack (a rack of a device the page already loaded).
// ---------------------------------------------------------------------------------------------------------------
export const DETAIL_KINDS = ["pdu", "kvm", "server", "item", "rack"];
const TABS = ["dashboard", "racks", "inventory", "power", "consoles", "pxe", "scan", "monitoring", "twin", "admin", "changelog", "account"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}$/;

// The id as a string when it is safe to send or link to; null otherwise (never repaired or trimmed).
export function safeId(value) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return null;
  const text = String(value);
  return SAFE_ID.test(text) ? text : null;
}

// Racks the site already knows: the rack field of the loaded device records.
export function knownRacks(devices) {
  return [...new Set((Array.isArray(devices) ? devices : []).map(d => d?.rack).filter(r => typeof r === "string" && safeId(r)))];
}

// Returns {tab?, rack?, detail?: {kind, id}} or null when nothing usable is left.
// With options.racks (array) a rack, and a detail of kind "rack", must be one of them.
export function cleanContext(context, options = {}) {
  if (!context || typeof context !== "object") return null;
  const racks = Array.isArray(options.racks) ? options.racks : null;
  const rackOk = r => r && (!racks || racks.includes(r));
  const out = {};
  if (TABS.includes(context.tab)) out.tab = context.tab;
  const rack = safeId(context.rack);
  if (rackOk(rack)) out.rack = rack;
  const d = context.detail;
  if (d && typeof d === "object" && DETAIL_KINDS.includes(d.kind)) {
    const id = safeId(d.id);
    if (id && (d.kind !== "rack" || rackOk(id))) out.detail = { kind: d.kind, id };
  }
  return Object.keys(out).length ? out : null;
}

// Merges a page's own selection (the optional "dcim-assistant-context" window event) over App's context.
// The event detail may be {kind, id} or {detail: {kind, id}, rack?}.
export function mergeContext(appContext, extra, options = {}) {
  const base = cleanContext(appContext, options) || {};
  if (!extra || typeof extra !== "object") return Object.keys(base).length ? base : null;
  const detail = extra.detail && typeof extra.detail === "object" ? extra.detail : extra;
  const rack = safeId(extra.rack) && cleanContext({ rack: extra.rack }, options) ? extra.rack : base.rack;
  return cleanContext({ ...base, rack, detail: DETAIL_KINDS.includes(detail.kind) ? detail : base.detail }, options);
}

export function contextKey(context) {
  const c = cleanContext(context);
  return c ? JSON.stringify([c.tab || "", c.rack || "", c.detail?.kind || "", c.detail?.id || ""]) : "";
}

const TAB_LABELS = {
  dashboard: "לוח הבקרה", racks: "ארונות", inventory: "מלאי", power: "חשמל", consoles: "קונסולות", pxe: "התקנה מרחוק",
  scan: "סריקה", monitoring: "ניטור", twin: "תאום תלת־ממדי", admin: "ניהול", changelog: "יומן שינויים", account: "חשבון",
};
const KIND_LABELS = { pdu: "PDU", kvm: "KVM", server: "שרת", item: "פריט", rack: "ארון" };

// Text for the context chip: {prefix, name} so the UI can isolate the LTR name in <bdi>. null = no chip.
export function contextLabel(context, devices = []) {
  const c = cleanContext(context);
  if (!c) return null;
  if (c.detail) {
    const device = ["pdu", "kvm"].includes(c.detail.kind) ? (devices || []).find(d => String(d?.id) === c.detail.id) : null;
    return { prefix: KIND_LABELS[c.detail.kind], name: typeof device?.name === "string" && device.name ? device.name : c.detail.id };
  }
  if (c.rack) return { prefix: "ארון", name: c.rack };
  if (c.tab && c.tab !== "dashboard") return { prefix: "עמוד", name: TAB_LABELS[c.tab] || c.tab };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Links from an answer's entity refs to site records (SEC-AI-7). A navigation intent is returned only for
//  - a PDU/KVM whose exact id is a loaded device of that kind -> {tab, detail: {kind, id}} (the device's own id)
//  - a rack that is a known rack                               -> {tab: "racks", rack}
// Everything else (servers, items, incidents, unknown or unsafe ids) is null and is shown as plain text.
// The result is an in-app navigation only: never a URL, href or window.open.
// ---------------------------------------------------------------------------------------------------------------
export function entityLink(ref, devices, racks) {
  if (!ref || typeof ref !== "object") return null;
  const id = safeId(ref.id);
  if (!id) return null;
  const list = Array.isArray(devices) ? devices : [];
  if (ref.kind === "pdu" || ref.kind === "kvm") {
    const device = list.find(d => d && d.kind === ref.kind && String(d.id) === id);
    return device ? { tab: ref.kind === "pdu" ? "power" : "consoles", detail: { kind: ref.kind, id: device.id } } : null;
  }
  if (ref.kind === "rack") {
    const known = Array.isArray(racks) ? racks : knownRacks(list);
    return known.includes(id) ? { tab: "racks", rack: id } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Answer normalisation: the UI never trusts the shape; missing arrays become [], wrong types are dropped.
// ---------------------------------------------------------------------------------------------------------------
const str = v => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const strList = v => (Array.isArray(v) ? v.map(str).filter(s => s.trim()) : typeof v === "string" && v.trim() ? [v] : []);
const objList = v => (Array.isArray(v) ? v.filter(x => x && typeof x === "object" && !Array.isArray(x)) : []);
export const PRIORITIES = ["high", "medium", "low"];
const priority = v => (PRIORITIES.includes(v) ? v : "medium");

function refList(v) {
  return objList(v).map(r => ({ kind: str(r.kind), id: str(r.id), label: str(r.label) || str(r.id) })).filter(r => r.kind && r.id);
}

export function normalizeDraft(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  return {
    title: str(d.title), description: str(d.description), entity_refs: refList(d.entity_refs),
    priority: priority(d.priority), rationale: str(d.rationale), steps: strList(d.steps),
  };
}

export function normalizeAnswer(raw) {
  if (typeof raw === "string") raw = { summary: raw };
  const a = raw && typeof raw === "object" ? raw : {};
  return {
    summary: str(a.summary),
    facts: objList(a.facts).map(f => ({ text: str(f.text), source_ids: strList(f.source_ids) })).filter(f => f.text),
    hypotheses: objList(a.hypotheses).map(h => ({
      text: str(h.text), support: strList(h.support), verify: str(h.verify), source_ids: strList(h.source_ids),
    })).filter(h => h.text),
    recommendations: objList(a.recommendations).map(r => ({
      title: str(r.title), problem: str(r.problem), evidence: str(r.evidence), priority: priority(r.priority),
      next_step: str(r.next_step), missing_info: strList(r.missing_info), source_ids: strList(r.source_ids),
      entity_refs: refList(r.entity_refs),
    })).filter(r => r.title || r.problem),
    checks: strList(a.checks),
    missing_data: strList(a.missing_data),
    entity_refs: refList(a.entity_refs),
    work_item_drafts: objList(a.work_item_drafts).map(normalizeDraft).filter(d => d.title),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Answer mode (D1). The server can switch between demo and LLM at any time (a key added, the daily cap reset or
// reached), so the panel never trusts an old /status: it reloads it when an answer's mode differs from it, and when
// the panel opens with a /status older than STATUS_MAX_AGE_MS. Every answer also carries its own mode badge.
// ---------------------------------------------------------------------------------------------------------------
export const STATUS_MAX_AGE_MS = 60_000;
export const ANSWER_MODES = ["llm", "demo"];
export const LLM_ANSWER_BADGE = "נענה על ידי מודל שפה (Claude) · הנתונים נשלחו ל-Anthropic";
export const DEMO_ANSWER_BADGE = "מצב הדגמה — ללא מודל שפה";

// True when /status was never loaded successfully or was loaded maxAgeMs or more ago.
export function statusIsStale(loadedAt, now = Date.now(), maxAgeMs = STATUS_MAX_AGE_MS) {
  return !Number.isFinite(loadedAt) || now - loadedAt >= maxAgeMs;
}

// True when an answer's mode shows that the mode in /status (or the lack of one) is out of date.
export function modeChanged(status, answerMode) {
  return ANSWER_MODES.includes(answerMode) && status?.mode !== answerMode;
}

// The panel's single reload rule. After an answer: reload when its mode differs from /status.
// When the panel opens: reload when /status failed before, or when a loaded one is stale.
// (The very first load, with nothing loaded and no error yet, is started by the panel itself.)
export function shouldReloadStatus({ status, statusError, loadedAt, now = Date.now(), answerMode, opened = false } = {}) {
  if (answerMode !== undefined) return modeChanged(status, answerMode);
  if (!opened) return false;
  if (statusError) return true;
  return status !== undefined && status !== null && statusIsStale(loadedAt, now);
}

// Per-answer badge: which engine answered and, for the LLM, that the question and lab data left the site.
// {tone: "llm" | "demo", text, reason} or null for an answer without a known mode.
export function answerModeBadge(mode, demoReason) {
  if (mode === "llm") return { tone: "llm", text: LLM_ANSWER_BADGE, reason: "" };
  if (mode === "demo") return { tone: "demo", text: DEMO_ANSWER_BADGE, reason: typeof demoReason === "string" ? demoReason.trim() : "" };
  return null;
}

export const SOURCE_STATUS_LABELS ={ ok: "עדכני", stale: "ישן", missing: "חסר", unavailable: "לא זמין", disabled: "כבוי" };

export function sourceStatusLabel(status) {
  return SOURCE_STATUS_LABELS[status] || "לא ידוע";
}

export function normalizeSources(raw) {
  return objList(raw).map((s, i) => {
    const age = typeof s.age_s === "number" && Number.isFinite(s.age_s) ? s.age_s : null;
    return {
      id: str(s.id) || `source-${i + 1}`, name: str(s.name) || str(s.id) || "מקור", ref: str(s.ref),
      as_of: str(s.as_of) || null, age_s: age,
      status: Object.prototype.hasOwnProperty.call(SOURCE_STATUS_LABELS, s.status) ? s.status : "unknown",
      note: str(s.note),
    };
  });
}

// Messages of a stored conversation (GET /conversations/{id}); accepts {messages: [...]} or a bare list.
export function normalizeMessages(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [];
  return objList(list).filter(m => m.role === "user" || m.role === "assistant").map((m, i) => ({
    id: str(m.id) || `m-${i}`,
    role: m.role,
    text: str(m.text),
    created_at: str(m.created_at) || null,
    ...(m.role === "assistant" ? {
      answer: normalizeAnswer(m.answer ?? m.text),
      sources: normalizeSources(m.sources),
      mode: m.mode === "llm" || m.mode === "demo" ? m.mode : null,
    } : {}),
  }));
}

export function normalizeConversations(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : [];
  return objList(list).map(c => ({
    id: str(c.id), title: str(c.title) || "שיחה ללא כותרת", updated_at: str(c.updated_at) || null,
    message_count: Number.isFinite(c.message_count) ? c.message_count : null,
  })).filter(c => c.id);
}

// The recommendation's own draft when the answer has one with the same title, else one built from the card.
export function draftFromRecommendation(rec, drafts = []) {
  const r = rec && typeof rec === "object" ? rec : {};
  const title = str(r.title).trim();
  const match = objList(drafts).find(d => title && str(d.title).trim() === title);
  if (match) return normalizeDraft(match);
  const description = [str(r.problem), r.evidence ? `נתונים תומכים: ${str(r.evidence)}` : ""].filter(Boolean).join("\n\n");
  const missing = strList(r.missing_info);
  return normalizeDraft({
    title: title || str(r.problem).slice(0, 80),
    description: missing.length ? `${description}\n\nמידע חסר: ${missing.join("; ")}` : description,
    entity_refs: r.entity_refs, priority: r.priority, rationale: str(r.evidence),
    steps: str(r.next_step) ? [str(r.next_step)] : [],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Text formatters (Hebrew, shown inside the RTL panel).
// ---------------------------------------------------------------------------------------------------------------
export function formatAge(seconds) {
  if (seconds === null || seconds === undefined || seconds === "" || !Number.isFinite(Number(seconds))) return "זמן עדכון לא ידוע";
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 60) return "לפני פחות מדקה";
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "לפני דקה" : `לפני ${m} דק׳`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "לפני שעה" : h === 2 ? "לפני שעתיים" : `לפני ${h} שע׳`;
  const d = Math.floor(h / 24);
  return d === 1 ? "לפני יום" : d === 2 ? "לפני יומיים" : `לפני ${d} ימים`;
}

// Lab-local time for an ISO timestamp; "—" when missing or invalid.
export function formatAsOf(iso, timeZone = "Asia/Jerusalem") {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleString("he-IL", { timeZone, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

export const PRIORITY_LABELS = { high: "גבוהה", medium: "בינונית", low: "נמוכה" };

export function priorityLabel(p) {
  return PRIORITY_LABELS[p] || "לא צוינה";
}

export function rateLimitText(seconds) {
  const n = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Math.ceil(Number(seconds)) : null;
  return n ? `יותר מדי שאלות, נסה שוב בעוד ${n} שניות` : "יותר מדי שאלות, נסה שוב בעוד דקה";
}

const hasHebrew = text => typeof text === "string" && /[֐-׿]/.test(text);

const FALLBACK_ERRORS = {
  400: "הבקשה נדחתה. בדוק את הטקסט ונסה שוב.",
  401: "ההתחברות פגה. התחבר שוב.",
  403: "אין לחשבון שלך הרשאה לפעולה הזו. שאלות לעוזר דורשות הרשאת Viewer, ושמירת משימות דורשת הרשאת Operator.",
  404: "הרשומה לא נמצאה. ייתכן שנמחקה או שאינה שייכת לחשבון שלך.",
  409: "הנתונים השתנו בינתיים. רענן ונסה שוב.",
  413: "הבקשה גדולה מדי. קצר את ההודעה ונסה שוב.",
  422: "הבקשה נדחתה. בדוק את הערכים ונסה שוב.",
  500: "אירעה שגיאה בשרת. נסה שוב בעוד מעט.",
  502: "השרת לא הגיב כראוי. נסה שוב בעוד מעט.",
  503: "העוזר אינו זמין כרגע. נסה שוב בעוד מעט.",
  504: "התשובה לקחה יותר מדי זמן. נסה שוב, או שאל שאלה ממוקדת יותר.",
};

// Hebrew text for any error thrown by the helpers above. The server's own detail is used only when it is Hebrew
// (the assistant router answers in Hebrew; generic middleware answers in English and gets a Hebrew fallback).
export function errorText(err) {
  if (!err) return "";
  if (err.code === "aborted") return "השאלה בוטלה.";
  if (err.code === "timeout") return FALLBACK_ERRORS[504];
  if (err.code === "network") return "אין חיבור לשרת. בדוק את החיבור ונסה שוב.";
  if (err.code === "bad_response") return "התקבלה תשובה לא צפויה מהשרת. נסה שוב.";
  if (err.status === 429) return rateLimitText(err.retryAfter);
  if (hasHebrew(err.detail)) return err.detail;
  if (err.status && FALLBACK_ERRORS[err.status]) return FALLBACK_ERRORS[err.status];
  if (err.status) return `הבקשה נכשלה (HTTP ${err.status}).`;
  return "הבקשה נכשלה. בדוק את החיבור ונסה שוב.";
}

// Errors worth a "retry" button (the same question may succeed later).
export function isRetryable(err) {
  if (!err) return false;
  if (["timeout", "network", "bad_response", "aborted"].includes(err.code)) return true;
  return [429, 500, 502, 503, 504].includes(err.status);
}

export function charCountText(length, max = DEFAULT_MAX_CHARS) {
  return `${Number(length) || 0}/${max}`;
}

// Splits Hebrew text into plain parts and Latin runs (ids, IPs, names like "Rack-01", "opt207", "10.0.0.5", and
// English phrases such as "Device is unreachable") so the UI can isolate each run in <bdi> and RTL punctuation does
// not jump around it. Consecutive Latin words separated by spaces or commas stay one run, as the browser's own
// bidi algorithm would keep them; plain numbers and dates are left to the browser.
const LTR_WORD = "[A-Za-z0-9](?:[A-Za-z0-9._:/=+#%@\\-]*[A-Za-z0-9])?";
const LTR_RUN = new RegExp(`${LTR_WORD}(?:(?:[ \\t]+|[ \\t]*[,;][ \\t]*)${LTR_WORD})*`, "g");
export function bidiSegments(text) {
  const s = str(text);
  const out = [];
  let pos = 0;
  for (const m of s.matchAll(LTR_RUN)) {
    const token = m[0];
    if (!/[A-Za-z]/.test(token) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(token)) continue;   // plain numbers stay inline
    if (m.index > pos) out.push({ text: s.slice(pos, m.index), ltr: false });
    out.push({ text: token, ltr: true });
    pos = m.index + token.length;
  }
  if (pos < s.length) out.push({ text: s.slice(pos), ltr: false });
  return out;
}
