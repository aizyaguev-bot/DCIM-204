// Assistant actions API (/api/assistant/actions) and pure helpers for the proposal card and its confirm dialog.
// Helpers stay free of DOM/React so node --test can import this module. Requests go through the global fetch
// wrapper (accounts.jsx), which adds X-DCIM-CSRF to writes, exactly like api/assistant.js.
//
// The card is built only from the server's public proposal JSON (actions/contracts.py): model text never describes
// what will switch. Error bodies are {detail, code, details}; `code` is mapped to Hebrew here.

import { parseRetryAfter } from "./assistant.js";
import { parseConsoleUrl } from "./pxe.js";

const BASE = "/api/assistant/actions";
export const REQUEST_TIMEOUT_MS = 20_000;
// An inline server/outlet cycle waits ASSISTANT_ACTION_CYCLE_OFF_SECONDS (<= 60 s) and re-reads every feed.
export const EXECUTE_TIMEOUT_MS = 150_000;
export const PROPOSAL_ID = /^[0-9a-f]{32}$/;

export const STATUSES = ["pending", "executing", "succeeded", "partial", "failed", "cancelled", "expired", "refused",
  "interrupted", "ready"];
export const FINAL_STATUSES = ["succeeded", "partial", "failed", "cancelled", "expired", "refused", "interrupted", "ready"];

// Mirror of KIND_SPECS (scope, switch, phrase) for display only; the server decides everything.
export const KINDS = {
  server_off: { scope: "server", sw: "off" },
  server_on: { scope: "server", sw: "on" },
  server_cycle: { scope: "server", sw: "cycle" },
  outlet_off: { scope: "outlet", sw: "off" },
  outlet_on: { scope: "outlet", sw: "on" },
  outlet_cycle: { scope: "outlet", sw: "cycle" },
  pdu_shutdown: { scope: "pdu", sw: "maintenance_off" },
  pdu_restore: { scope: "pdu", sw: "maintenance_on" },
  rack_shutdown: { scope: "rack", sw: "maintenance_off" },
  lab_shutdown: { scope: "lab", sw: "maintenance_off" },
  batch_restore: { scope: "batch", sw: "maintenance_on" },
  open_console: { scope: "server", sw: "none" },
  // Location changes (contracts.DATA_KINDS): PDU/KVM port labels and rack positions change, never power.
  server_swap: { scope: "server", sw: "data" },
  server_move: { scope: "server", sw: "data" },
  server_clear: { scope: "server", sw: "data" },
};
export const DATA_KINDS = ["server_swap", "server_move", "server_clear"];
const SCOPES = ["outlet", "server", "pdu", "rack", "lab", "batch"];
const ROLES = ["Viewer", "Operator", "Admin"];
const REQUEST_KEYS = ["kind", "server", "pdu", "outlet", "rack", "restore_of", "then_console",
  "target_server", "target_ports", "target_rack", "target_slot"];
const MAX_TARGET_PORTS = 8;

// A location change (server_swap / server_move / server_clear): a proposal, a raw public JSON or a kind string.
export function isDataKind(proposalOrKind) {
  const kind = typeof proposalOrKind === "string" ? proposalOrKind : proposalOrKind?.kind;
  return DATA_KINDS.includes(kind);
}

// ProposalRequest.target_ports: [{device, port}] with a device id/name and a port number as text (<= 8 entries).
export function cleanTargetPorts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const device = typeof item.device === "string" ? item.device.trim() : "";
    const port = Number.isInteger(item.port) ? String(item.port) : typeof item.port === "string" ? item.port.trim() : "";
    if (!device || device.length > 100 || !/^\d{1,4}$/.test(port) || Number(port) < 1) continue;
    out.push({ device, port });
    if (out.length >= MAX_TARGET_PORTS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------
function failure(message, props) {
  return Object.assign(new Error(message), props);
}

// Transport failures get .code "aborted" | "timeout" | "network" | "bad_response" and no .status.
// HTTP failures get .status, .code (the server's ActionError code, if any), .detail, .details and .retryAfter.
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
      res = await globalThis.fetch(`${BASE}${path}`, {
        method,
        cache: "no-store",
        signal: controller.signal,
        // Writes always declare JSON: the assistant write guard answers 415 otherwise.
        headers: method !== "GET" ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (timedOut) throw failure("The server did not answer in time.", { code: "timeout" });
      if (signal?.aborted || e?.name === "AbortError") throw failure("The request was cancelled.", { code: "aborted", name: "AbortError" });
      throw failure("The server could not be reached.", { code: "network" });
    }
    if (!res.ok) {
      let text = "";
      try { text = await res.text(); } catch { /* body lost */ }
      let data;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      const detail = typeof data?.detail === "string" ? data.detail
        : typeof data?.detail?.detail === "string" ? data.detail.detail : undefined;
      const code = typeof data?.code === "string" ? data.code : typeof data?.detail?.code === "string" ? data.detail.code : undefined;
      const rawDetails = Array.isArray(data?.details) ? data.details : Array.isArray(data?.detail?.details) ? data.detail.details : [];
      // Never keep the raw body: an unexpected proxy page could echo request data.
      throw failure(`HTTP ${res.status}`, {
        status: res.status, code, detail,
        details: rawDetails.filter(d => typeof d === "string" && d.trim()).slice(0, 20),
        retryAfter: parseRetryAfter(res.headers?.get?.("Retry-After")),
      });
    }
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      if (timedOut) throw failure("The server did not answer in time.", { code: "timeout" });
      if (signal?.aborted) throw failure("The request was cancelled.", { code: "aborted", name: "AbortError" });
      throw failure("Unexpected response from the server.", { code: "bad_response", status: res.status });
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

// Ids are path segments: anything but 32 hex characters never reaches the server.
function idPath(id) {
  const text = typeof id === "string" ? id : "";
  if (!PROPOSAL_ID.test(text)) throw failure("Invalid proposal id.", { status: 404, code: "not_found" });
  return text;
}

// Only the ProposalRequest fields, with empty values dropped (the server validates everything again).
export function cleanRequest(request) {
  const r = request && typeof request === "object" ? request : {};
  const out = {};
  for (const key of REQUEST_KEYS) {
    const v = r[key];
    if (key === "then_console") { if (v === true) out[key] = true; continue; }
    if (key === "outlet" || key === "target_slot") { if (Number.isInteger(v)) out[key] = v; continue; }
    if (key === "target_ports") { const ports = cleanTargetPorts(v); if (ports.length) out[key] = ports; continue; }
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

export function getConfig(options) {
  return req("GET", "/config", undefined, options);
}

export function createProposal(request, options) {
  return req("POST", "/proposals", cleanRequest(request), options);
}

export async function getProposal(id, options) {
  return req("GET", `/proposals/${idPath(id)}`, undefined, options);
}

export function listProposals(limit = 20, options) {
  const n = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
  return req("GET", `/proposals?limit=${n}`, undefined, options);
}

// The body is exactly {password?, phrase?}: targets and parameters come only from the stored proposal. Kinds
// without a password (location changes) send `{}`; the server still checks role, owner, CSRF and drift.
export async function executeProposal(id, { password, phrase } = {}, { signal, timeoutMs = EXECUTE_TIMEOUT_MS } = {}) {
  const body = {};
  if (typeof password === "string") body.password = password;
  if (typeof phrase === "string") body.phrase = phrase;
  return req("POST", `/proposals/${idPath(id)}/execute`, body, { signal, timeoutMs });
}

export async function cancelProposal(id, options) {
  return req("POST", `/proposals/${idPath(id)}/cancel`, {}, options);
}

export const assistantActionsApi = { getConfig, createProposal, getProposal, listProposals, executeProposal, cancelProposal };

// ---------------------------------------------------------------------------------------------------------------
// Normalisation: the UI never trusts the shape. Field names stay those of the public JSON, so normalizing an
// already normalized proposal changes nothing (other modules may hand one back).
// ---------------------------------------------------------------------------------------------------------------
const str = v => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const strList = v => (Array.isArray(v) ? v.map(str).filter(s => s.trim()) : []);
const objList = v => (Array.isArray(v) ? v.filter(x => x && typeof x === "object" && !Array.isArray(x)) : []);
const int = v => (Number.isInteger(v) ? v : typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : null);
const count = (v, fallback) => (Number.isInteger(v) && v >= 0 ? v : fallback);

function normalizeConsole(c) {
  return { kvm_id: str(c.kvm_id), kvm_name: str(c.kvm_name), port: int(c.port), label: str(c.label), console_url: str(c.console_url) };
}

// Location changes (move-server dry run): [{device_id, device_name, kind, port, before, after}]. Labels are text only.
function normalizeChanges(list) {
  return objList(list).map(c => ({
    device_id: str(c.device_id), device_name: str(c.device_name) || str(c.device_id), kind: str(c.kind),
    port: str(c.port).trim(), before: str(c.before), after: str(c.after),
  })).filter(c => c.device_name && c.port);
}

function normalizeSpot(spot) {
  if (!spot || typeof spot !== "object" || Array.isArray(spot)) return null;
  const rack = str(spot.rack).trim();
  const n = int(spot.slot);
  const slot = n !== null && n >= 1 ? n : null;
  return rack || slot !== null ? { rack, slot } : null;
}

// [{server, before: {rack, slot} | null, after: {rack, slot} | null}]; null = no position.
function normalizePositions(list) {
  return objList(list).map(p => ({ server: str(p.server), before: normalizeSpot(p.before), after: normalizeSpot(p.after) }))
    .filter(p => p.server.trim());
}

export function normalizeImpact(raw) {
  const i = raw && typeof raw === "object" ? raw : {};
  const targets = objList(i.targets).map(t => ({
    pdu_id: str(t.pdu_id), pdu_name: str(t.pdu_name) || str(t.pdu_id), rack: str(t.rack), outlet: int(t.outlet),
    label: str(t.label), server: str(t.server), state: str(t.state) || "unknown",
  })).filter(t => t.pdu_id && t.outlet !== null);
  const excluded = objList(i.excluded).map(e => ({
    pdu_id: str(e.pdu_id), pdu_name: str(e.pdu_name) || str(e.pdu_id), rack: str(e.rack), outlet: int(e.outlet),
    label: str(e.label), reason: str(e.reason) || "unknown_state",
  })).filter(e => e.pdu_id);
  const pdus = strList(i.pdus);
  const servers = strList(i.servers);
  const c = i.counts && typeof i.counts === "object" ? i.counts : {};
  return {
    targets, excluded, pdus, servers,
    consoles: objList(i.consoles).map(normalizeConsole),
    warnings_he: strList(i.warnings_he),
    changes: normalizeChanges(i.changes),
    positions: normalizePositions(i.positions),
    unplaced: strList(i.unplaced),
    counts: {
      outlets: count(c.outlets, targets.length), pdus: count(c.pdus, pdus.length),
      servers: count(c.servers, servers.length), excluded: count(c.excluded, excluded.length),
    },
  };
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    targets: objList(raw.targets).map(t => ({
      pdu_id: str(t.pdu_id), outlet: int(t.outlet), ok: t.ok === true, state_after: str(t.state_after) || "unknown", error: str(t.error),
    })),
    pdus: objList(raw.pdus).map(p => ({
      pdu_id: str(p.pdu_id), pdu_name: str(p.pdu_name) || str(p.pdu_id), ok: p.ok === true,
      switched: Array.isArray(p.switched) ? p.switched.filter(Number.isInteger) : [],
      failed: Array.isArray(p.failed) ? p.failed.filter(Number.isInteger) : [], error: str(p.error),
      // D3: outlets on now that the proposal did not show; left on and reported (passed through for ActionProgress).
      ...(p.not_included !== undefined ? { not_included: p.not_included } : {}),
    })),
    consoles: objList(raw.consoles).map(normalizeConsole),
    summary_he: str(raw.summary_he),
    // D7: why a batch stopped early (passed through unchanged for ActionProgress).
    ...(raw.aborted !== undefined ? { aborted: raw.aborted } : {}),
    // Location changes: what was applied (only when the server sent it).
    ...(Array.isArray(raw.changes) ? { changes: normalizeChanges(raw.changes) } : {}),
    ...(Array.isArray(raw.positions) ? { positions: normalizePositions(raw.positions) } : {}),
    ...(Array.isArray(raw.unplaced) ? { unplaced: strList(raw.unplaced) } : {}),
  };
}

// Returns null for anything without a valid id. `now` is the time the JSON was received: the countdown uses the
// server's relative expires_in_s from that moment, so a wrong browser clock does not matter.
export function normalizeProposal(raw, now = Date.now()) {
  const p = raw && typeof raw === "object" ? raw : null;
  if (!p || !PROPOSAL_ID.test(str(p.id))) return null;
  const kind = str(p.kind);
  const spec = KINDS[kind] || { scope: "server", sw: "none" };
  const receivedAt = Number.isFinite(p._received_at) ? p._received_at : now;
  const expiresIn = typeof p.expires_in_s === "number" && Number.isFinite(p.expires_in_s) ? Math.max(0, p.expires_in_s) : null;
  const expiresAtMs = Date.parse(str(p.expires_at));
  const createdAtMs = Date.parse(str(p.created_at));
  const progress = p.progress && typeof p.progress === "object"
    ? { done: count(p.progress.done, 0), total: count(p.progress.total, 0) } : null;
  const request = {};
  if (p.request && typeof p.request === "object") {
    for (const key of REQUEST_KEYS) {
      const v = p.request[key];
      if (v === undefined || v === null) continue;
      if (key === "target_ports") { const ports = cleanTargetPorts(v); if (ports.length) request[key] = ports; continue; }
      request[key] = v;
    }
  }
  return {
    id: p.id, kind, scope: SCOPES.includes(p.scope) ? p.scope : spec.scope, sw: spec.sw,
    title_he: str(p.title_he), status: STATUSES.includes(p.status) ? p.status : "unknown",
    created_at: str(p.created_at) || null, expires_at: str(p.expires_at) || null, created_by: str(p.created_by),
    required_role: ROLES.includes(p.required_role) ? p.required_role : (spec.scope === "rack" || spec.scope === "lab" || spec.scope === "batch" ? "Admin" : "Operator"),
    needs_password: p.needs_password !== false,
    phrase: typeof p.phrase === "string" && p.phrase.trim() ? p.phrase : null,
    background: p.background === true,
    request,
    impact: normalizeImpact(p.impact),
    progress,
    result: normalizeResult(p.result),
    restore_of: PROPOSAL_ID.test(str(p.restore_of)) ? p.restore_of : null,
    can_restore: p.can_restore === true,
    can_execute: p.can_execute === true,
    expires_in_s: expiresIn,
    ttl_s: Number.isFinite(expiresAtMs) && Number.isFinite(createdAtMs) && expiresAtMs > createdAtMs ? Math.round((expiresAtMs - createdAtMs) / 1000) : null,
    _received_at: receivedAt,
    ends_at: expiresIn !== null ? receivedAt + expiresIn * 1000 : Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

const RANK = status => (status === "pending" ? 0 : status === "executing" ? 1 : FINAL_STATUSES.includes(status) ? 2 : -1);

// A response that started before a newer one may arrive last: never step back from a final status to a running
// one, or from executing to pending, and never let progress go backwards within one status.
export function mergeProposal(prev, next) {
  if (!next) return prev || null;
  if (!prev || prev.id !== next.id) return next;
  const a = RANK(prev.status), b = RANK(next.status);
  if (b < a) return prev;
  if (a === 2 && b === 2 && prev.status !== next.status) {
    // Two different final statuses: the later response wins only if it was received later.
    return (next._received_at ?? 0) >= (prev._received_at ?? 0) ? next : prev;
  }
  if (prev.status === "executing" && next.status === "executing" && (next.progress?.done ?? 0) < (prev.progress?.done ?? 0)) return prev;
  return next;
}

// Replace by id inside a list (keeps order; unknown ids are appended).
export function upsertProposal(list, proposal) {
  const items = Array.isArray(list) ? list : [];
  if (!proposal) return items;
  const at = items.findIndex(p => p?.id === proposal.id);
  if (at < 0) return [...items, proposal];
  const merged = mergeProposal(items[at], proposal);
  if (merged === items[at]) return items;
  const copy = items.slice();
  copy[at] = merged;
  return copy;
}

// A new card (restore, proposal again) goes right after the card it came from; an id is never listed twice.
export function insertAfterId(ids, sourceId, newId) {
  const list = (Array.isArray(ids) ? ids : []).filter(id => id !== newId);
  const at = list.indexOf(sourceId);
  if (at < 0) return [...list, newId];
  list.splice(at + 1, 0, newId);
  return list;
}

// The proposals a stored message refers to: public objects and/or bare ids (`action_proposals`, if the server keeps
// them with the conversation). Returns {ids, proposals} with ids in order and without duplicates.
export function proposalRefs(raw, now = Date.now()) {
  const ids = [], proposals = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 20) : []) {
    const p = typeof item === "string" ? null : normalizeProposal(item, now);
    const id = p ? p.id : typeof item === "string" && PROPOSAL_ID.test(item) ? item : null;
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (p) proposals.push(p);
  }
  return { ids, proposals };
}

// ---------------------------------------------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------------------------------------------
export function remainingSeconds(proposal, now = Date.now()) {
  if (!proposal || !Number.isFinite(proposal.ends_at)) return null;
  return Math.max(0, Math.ceil((proposal.ends_at - now) / 1000));
}

// "4:12", "0:05"; hours never occur (TTL <= 1 hour) but are folded into minutes.
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// {text, tone: "ok" | "soon" | "expired"} or null when the expiry is unknown.
export function countdownLabel(remaining) {
  if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return null;
  if (remaining <= 0) return { text: "פג תוקף", tone: "expired" };
  if (remaining <= 60) return { text: `פג בעוד ${formatCountdown(remaining)}`, tone: "soon" };
  return { text: `בתוקף עוד ${formatCountdown(remaining)}`, tone: "ok" };
}

// The status the card shows: a pending proposal whose time ran out is expired even before the server says so.
export function displayStatus(proposal, now = Date.now()) {
  if (!proposal) return "unknown";
  if (proposal.status === "pending") {
    const left = remainingSeconds(proposal, now);
    if (left !== null && left <= 0) return "expired";
  }
  return proposal.status;
}

export function isFinal(status) {
  return FINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------------------------------------------
// Labels (Hebrew)
// ---------------------------------------------------------------------------------------------------------------
export function plural(n, one, many) {
  return n === 1 ? one : `${n} ${many}`;
}
export const outletsText = n => plural(n, "שקע אחד", "שקעים");
export const pdusText = n => (n === 1 ? "PDU אחד" : `${n} PDU`);
export const serversText = n => plural(n, "שרת אחד", "שרתים");

export const RISK_LABELS = {
  info: "ללא שינוי בחשמל",
  medium: "סיכון בינוני",
  high: "סיכון גבוה — ארון שלם",
  batch: "סיכון גבוה — כמה PDU",
  critical: "סיכון קריטי — כל המעבדה",
  data: "שינוי נתונים (ללא חשמל)",
};

// info | data | medium | high | batch | critical. rack/lab (and their restore) are the red, wide-scope cards.
export function riskOf(proposal) {
  if (!proposal) return "medium";
  if (proposal.sw === "none") return "info";
  if (proposal.sw === "data" || isDataKind(proposal)) return "data";
  if (proposal.scope === "lab") return "critical";
  if (proposal.scope === "rack") return "high";
  if (proposal.scope === "batch") return /^LAB\b/.test(proposal.phrase || "") ? "critical" : "batch";
  return "medium";
}

export function isWide(proposal) {
  return ["rack", "lab", "batch"].includes(proposal?.scope);
}

export function roleChipText(proposal) {
  if (!proposal) return "";
  if (proposal.sw === "none" || !proposal.needs_password) return `${proposal.required_role} (ללא סיסמה)`;
  return proposal.phrase ? `${proposal.required_role} + סיסמה + צירוף אישור` : `${proposal.required_role} + סיסמה`;
}

export const STATUS_LABELS = {
  pending: "", executing: "בביצוע…", succeeded: "בוצע", partial: "בוצע חלקית", failed: "נכשל", expired: "פג תוקף",
  cancelled: "בוטלה", refused: "נדחתה — המצב השתנה", interrupted: "נקטעה", ready: "קונסול זמין", not_found: "לא זמינה",
  unknown: "מצב לא ידוע",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? STATUS_LABELS.unknown;
}

// The one-line text for states the card itself explains (ActionProgress explains executing and finished runs).
export const STATUS_LINES = {
  expired: "ההצעה פגה ולא בוצעה.",
  cancelled: "ההצעה בוטלה. לא בוצעה שום פעולה.",
  refused: "המצב במעבדה השתנה מאז שההצעה נוצרה, ולכן הפעולה לא בוצעה.",
  not_found: "ההצעה כבר לא קיימת בשרת.",
};

export const EXCLUDE_REASONS = {
  protected: { short: "מוגנים", row: "מוגן — מזין ציוד תשתית ולא ייגע", tone: "amber" },
  maintenance: { short: "בתחזוקה", row: "ה-PDU כבר בתחזוקה (לא ייגע)", tone: "amber" },
  disabled: { short: "PDU מושבת", row: "ה-PDU מושבת במערכת", tone: "amber" },
  unreachable: { short: "PDU לא זמין", row: "ה-PDU לא זמין — לא ייכלל. ייתכן שהשקעים שלו דולקים.", tone: "amber" },
  unknown_state: { short: "מצב לא ידוע", row: "מצב לא ידוע — ייתכן שהשקע דולק ולא ייכבה.", tone: "amber" },
  not_in_batch: { short: "לא בפעולה הזו", row: "לא כובה בפעולה המקורית (לא ייגע)", tone: "zinc" },
  already_off: { short: "כבר כבויים", row: "כבר כבוי", tone: "zinc" },
  already_on: { short: "כבר דולקים", row: "כבר דולק", tone: "zinc" },
};
const REASON_ORDER = ["unreachable", "unknown_state", "protected", "maintenance", "disabled", "not_in_batch", "already_off", "already_on"];

export function excludeReason(reason) {
  return EXCLUDE_REASONS[reason] || { short: "לא ייכלל", row: "לא ייכלל", tone: "amber" };
}

// [{reason, short, row, tone, items, count}] in a fixed order: the ones that may leave power on come first.
export function excludedGroups(excluded) {
  const groups = new Map();
  for (const e of Array.isArray(excluded) ? excluded : []) {
    if (!groups.has(e.reason)) groups.set(e.reason, []);
    groups.get(e.reason).push(e);
  }
  const rank = r => { const i = REASON_ORDER.indexOf(r); return i < 0 ? REASON_ORDER.length : i; };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([reason, items]) => ({ reason, ...excludeReason(reason), items, count: items.length }));
}

// Entries left as they are that are not simply "already in the requested state".
export function keptCount(excluded) {
  return (Array.isArray(excluded) ? excluded : []).filter(e => e.reason !== "already_off" && e.reason !== "already_on").length;
}

const natural = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });

// [{rack, pdus: [{pdu_id, pdu_name, rack, outlets: [target]}]}], racks and PDUs in natural order, outlets by number.
export function groupTargets(targets) {
  const racks = new Map();
  for (const t of Array.isArray(targets) ? targets : []) {
    const rack = t.rack || "";
    if (!racks.has(rack)) racks.set(rack, new Map());
    const pdus = racks.get(rack);
    if (!pdus.has(t.pdu_id)) pdus.set(t.pdu_id, { pdu_id: t.pdu_id, pdu_name: t.pdu_name || t.pdu_id, rack, outlets: [] });
    pdus.get(t.pdu_id).outlets.push(t);
  }
  return [...racks.entries()].sort((a, b) => natural(a[0], b[0])).map(([rack, pdus]) => ({
    rack,
    pdus: [...pdus.values()].sort((a, b) => natural(a.pdu_name, b.pdu_name))
      .map(p => ({ ...p, outlets: p.outlets.slice().sort((a, b) => a.outlet - b.outlet) })),
  }));
}

// [{server, outlets: [target]}] for the server names in the impact; outlets with no server name are left out.
export function groupByServer(targets) {
  const servers = new Map();
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!t.server) continue;
    if (!servers.has(t.server)) servers.set(t.server, []);
    servers.get(t.server).push(t);
  }
  return [...servers.entries()].sort((a, b) => natural(a[0], b[0])).map(([server, outlets]) => ({ server, outlets }));
}

const SWITCH_VERB = { off: "תכבה", on: "תדליק", cycle: "תנתק ותחזיר את החשמל ל־", maintenance_off: "תכבה", maintenance_on: "תדליק" };

// One sentence that says exactly what the server computed, e.g.
// "הפעולה תכבה 84 שקעים ב־9 PDU (12 שרתים). 12 שקעים יישארו כמו שהם."
export function impactSentence(proposal) {
  if (!proposal) return "";
  const { counts, excluded } = proposal.impact;
  if (proposal.sw === "none") return "פתיחת קונסול KVM בלבד. החשמל לא ישתנה.";
  if (isDataKind(proposal)) return dataImpactSentence(proposal);
  const outlets = outletsText(counts.outlets), pdus = pdusText(counts.pdus);
  const servers = counts.servers > 0 ? ` (${serversText(counts.servers)})` : "";
  let text;
  if (counts.outlets === 0) text = "הפעולה לא תשנה אף שקע.";
  else if (proposal.sw === "cycle") text = `הפעולה ${SWITCH_VERB.cycle}${outlets} ב־${pdus}${servers}.`;
  else if (proposal.sw === "maintenance_off") text = `הפעולה תעביר ${pdus} לתחזוקה ותכבה בהם ${outlets}${servers}.`;
  else if (proposal.sw === "maintenance_on") text = `הפעולה תחזיר ${pdus} מתחזוקה ותדליק בהם ${outlets}${servers}.`;
  else text = `הפעולה ${SWITCH_VERB[proposal.sw] || "תשנה"} ${outlets} ב־${pdus}${servers}.`;
  const kept = keptCount(excluded);
  if (kept > 0) {
    const keptText = kept === 1 ? "רכיב אחד לא ייכלל" : `${kept} רכיבים לא ייכללו`;
    text += ` ${keptText} (מוגנים, בתחזוקה או לא זמינים).`;
  }
  return text;
}

// Label of the dialog's action button: the verb and the object, never a bare "אשר".
export function verbLabel(proposal) {
  if (!proposal) return "בצע";
  if (isDataKind(proposal)) return DATA_CONFIRM_LABEL;
  const r = proposal.request || {};
  const server = str(r.server) || proposal.impact.servers[0] || "";
  const pdu = proposal.impact.targets[0]?.pdu_name || str(r.pdu);
  const outlet = Number.isInteger(r.outlet) ? r.outlet : proposal.impact.targets[0]?.outlet;
  switch (proposal.kind) {
    case "lab_shutdown": return "כבה את כל המעבדה";
    case "rack_shutdown": return `כבה את ארון ${str(r.rack)}`.trim();
    case "server_off": return `כבה את ${server}`.trim();
    case "server_on": return `הדלק את ${server}`.trim();
    case "server_cycle": return `אתחל את ${server}`.trim();
    case "outlet_off": return `כבה את שקע ${outlet ?? ""} ב-${pdu}`;
    case "outlet_on": return `הדלק את שקע ${outlet ?? ""} ב-${pdu}`;
    case "outlet_cycle": return `אתחל את שקע ${outlet ?? ""} ב-${pdu}`;
    case "pdu_shutdown": return `השבת את ${pdu} לתחזוקה`;
    case "pdu_restore": return `החזר את ${pdu} מתחזוקה`;
    case "batch_restore": {
      const n = proposal.impact.counts.outlets;
      return n > 0 ? `החזר חשמל ל־${outletsText(n)}` : "החזר חשמל";
    }
    default: return "בצע";
  }
}

// "danger" (rose) for anything that removes power, "safe" (nv) for power back on, "data" (sky) for location changes.
export function actionTone(proposal) {
  if (proposal?.sw === "data" || isDataKind(proposal)) return "data";
  return ["on", "maintenance_on"].includes(proposal?.sw) ? "safe" : "danger";
}

// Warnings the client adds from the server's own impact (never from model text).
export function clientWarnings(proposal) {
  if (!proposal || proposal.sw === "none" || isDataKind(proposal)) return [];
  const out = [];
  if (proposal.scope === "server") {
    for (const { server, outlets } of groupByServer(proposal.impact.targets)) {
      if (outlets.length > 1 && ["off", "cycle"].includes(proposal.sw)) {
        out.push(`לשרת ${server} יש ${outlets.length} שקעי חשמל (ספקי כוח); ${proposal.sw === "cycle" ? "כולם ינותקו ויוחזרו יחד" : "כולם ייכבו יחד"}.`);
      }
    }
    const labels = [...new Set(proposal.impact.targets.map(t => t.label).filter(Boolean))].slice(0, 3);
    if (labels.length) out.push(`השיוך בין שרת לשקע מבוסס על תוויות. ודא שהתווית ${labels.join(", ")} נכונה.`);
  }
  return out;
}

export function passwordLabelHe(mode) {
  return mode === "shared" ? "סיסמת Lab Manager" : "הסיסמה של החשבון שלך";
}

export const ACCOUNTS_ONLY_TEXT = "פעולות זמינות רק במצב חשבונות: ביצוע פעולות מהעוזר דורש שכל משתמש יתחבר עם חשבון וסיסמה משלו.";
export const DISABLED_TEXT = "ביצוע פעולות מהעוזר כבוי בהגדרות השרת.";

// Why this browser cannot run actions at all, from GET /config; "" when it can (or config is not loaded yet).
export function configBlockText(config) {
  if (!config || typeof config !== "object") return "";
  if (config.enabled === false) return DISABLED_TEXT;
  if (typeof config.password_mode === "string" && config.password_mode !== "account") return ACCOUNTS_ONLY_TEXT;
  return "";
}

// ---------------------------------------------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------------------------------------------
// The server compares NFC + strip() of the typed text with the stored phrase, exactly and case-sensitively.
export function phraseMatches(value, phrase) {
  if (typeof phrase !== "string" || !phrase) return true;
  return typeof value === "string" && value.normalize("NFC").trim() === phrase.normalize("NFC");
}

// {ready, missing: ["phrase" | "password"], hint}
// A location change can be confirmed only when the server's before -> after list is on screen ("changes").
export function confirmState(proposal, { phraseValue = "", passwordFilled = false } = {}) {
  const missing = [];
  if (isDataKind(proposal) && !dataChangeCount(proposal?.impact?.changes, proposal?.impact?.positions)) {
    return { ready: false, missing: ["changes"], hint: "אין רשימת שינויים מהשרת, ולכן אי אפשר לאשר. בקש הצעה חדשה." };
  }
  if (proposal?.phrase && !phraseMatches(phraseValue, proposal.phrase)) missing.push("phrase");
  if (proposal?.needs_password !== false && !passwordFilled) missing.push("password");
  let hint = "";
  if (missing.length === 2) hint = `כדי לבצע: הקלד את הצירוף ${proposal.phrase} והזן סיסמה.`;
  else if (missing[0] === "phrase") hint = `כדי לבצע: הקלד את הצירוף ${proposal.phrase}.`;
  else if (missing[0] === "password") hint = "כדי לבצע: הזן סיסמה.";
  return { ready: missing.length === 0, missing, hint };
}

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------
export const NOTHING_DONE = "שום פעולה לא בוצעה.";

// The server's code, or one derived from the status and the fixed English texts (older routes, middleware).
export function errorCode(err) {
  if (!err) return "";
  if (!err.status) return ["aborted", "timeout", "network", "bad_response"].includes(err.code) ? err.code : "network";
  if (err.status === 401) return "unauthenticated";
  if (err.status === 429) return "throttled";
  const detail = typeof err.detail === "string" ? err.detail : "";
  if (err.code === "invalid" || (!err.code && err.status === 400)) {
    if (/password is required/i.test(detail)) return "password_required";
    if (/password is too long/i.test(detail)) return "password_too_long";
  }
  if (typeof err.code === "string" && err.code) return err.code;
  if (err.status === 403 && /password is incorrect/i.test(detail)) return "password";
  if (err.status === 403 && /admin role|role does not allow|requires the/i.test(detail)) return "forbidden";
  if (err.status === 403 && /disabled/i.test(detail)) return "disabled";
  if (err.status === 403 && /csrf|origin/i.test(detail)) return "csrf";
  if (err.status === 404) return "not_found";
  if (err.status === 410) return "expired";
  if (err.status >= 500) return "server";
  return `http_${err.status}`;
}

function minutesText(seconds) {
  return formatCountdown(seconds);
}

// {text, details: [Hebrew], code, outcomeUnknown, retryAfter}
// phase: "execute" | "create" | "cancel" | "load". Every refusal that happens before anything ran says so;
// a lost or failed execute response never does (the action may already be running).
export function actionErrorInfo(err, { proposal = null, phase = "execute" } = {}) {
  const code = errorCode(err);
  let details = Array.isArray(err?.details) ? err.details.filter(d => typeof d === "string" && d.trim()) : [];
  const phrase = proposal?.phrase || "";
  const role = proposal?.required_role || "Operator";
  const data = isDataKind(proposal);
  // A location change proposed again can be refused by the planner (a port now used by another server, an occupied
  // slot): its fixed, secret-free English reason is the only useful explanation, so it is shown as a detail.
  if (data && phase === "create" && !details.length && typeof err?.detail === "string" && err.detail.trim() && err.status && err.status < 500) {
    details = [err.detail.trim().slice(0, 300)];
  }
  const out = (text, extra = {}) => ({ text, details, code, outcomeUnknown: false, retryAfter: undefined, ...extra });
  const unknownExecute = phase === "execute";
  if (data && code === "drift") {
    // check_drift's own reason ("המיקומים השתנו מאז ההצעה") is the headline; it is not repeated as a detail.
    details = details.filter(d => d.trim() !== DATA_DRIFT_TEXT);
    return out(`${DATA_DRIFT_TEXT}. ${NOTHING_DONE} אפשר להציע שוב ולקבל רשימה מעודכנת.`);
  }
  if (data && code === "no_targets") return out(`אין מה לשנות: התוויות והמיקומים כבר כמו שביקשת. ${NOTHING_DONE}`);
  switch (code) {
    case "aborted": return out("הבקשה בוטלה.", { outcomeUnknown: unknownExecute });
    case "network":
    case "timeout":
    case "bad_response":
      if (unknownExecute) return out("החיבור לשרת נקטע לפני שהתקבלה תשובה. ייתכן שהפעולה כבר התחילה — בודק את המצב…", { outcomeUnknown: true });
      return out(code === "timeout" ? "השרת לא ענה בזמן. נסה שוב בעוד מעט." : "אין חיבור לשרת. בדוק את החיבור ונסה שוב.");
    case "server":
      if (unknownExecute) return out("השרת נכשל בעיבוד הבקשה. לא ידוע אם הפעולה התחילה — לחץ \"בדוק מצב\".", { outcomeUnknown: true });
      return out("אירעה שגיאה בשרת. נסה שוב בעוד מעט.");
    case "unauthenticated": return out(`ההתחברות לאתר פגה. התחבר מחדש — ${NOTHING_DONE}`);
    case "csrf": return out(`הבקשה נדחתה מסיבות אבטחה (ייתכן שההתחברות פגה). רענן את הדף והתחבר מחדש. ${NOTHING_DONE}`);
    case "password": return out(`הסיסמה שגויה. ${NOTHING_DONE}`);
    case "password_required": return out(`יש להזין סיסמה. ${NOTHING_DONE}`);
    case "password_too_long": return out(`הסיסמה ארוכה מדי. ${NOTHING_DONE}`);
    case "forbidden": return out(`הפעולה הזו דורשת הרשאת ${role}. ${NOTHING_DONE}`);
    case "phrase": return out(`הצירוף לא תואם. יש להקליד בדיוק: ${phrase || "את הצירוף שמוצג"}. ${NOTHING_DONE}`);
    case "password_mode": return out(`${ACCOUNTS_ONLY_TEXT} ${NOTHING_DONE}`);
    case "disabled": return out(`${DISABLED_TEXT} ${NOTHING_DONE}`);
    case "throttled": {
      const wait = Number.isFinite(err?.retryAfter) && err.retryAfter > 0 ? err.retryAfter : 300;
      return out(`יותר מדי ניסיונות סיסמה שגויים. אפשר לנסות שוב בעוד ${minutesText(wait)}. ${NOTHING_DONE}`, { retryAfter: wait });
    }
    case "not_found":
      return phase === "load" ? out(STATUS_LINES.not_found)
        : out(`ההצעה לא נמצאה בשרת (ייתכן שהשרת הופעל מחדש). ${NOTHING_DONE} בקש מהעוזר הצעה חדשה.`);
    case "expired": {
      const ttl = proposal?.ttl_s ? ` (תוקף של ${Math.round(proposal.ttl_s / 60) || 1} דקות)` : "";
      return out(`ההצעה פגה לפני האישור${ttl}. ${NOTHING_DONE}`);
    }
    case "not_pending": return out("ההצעה כבר טופלה (בוצעה, בוטלה או פגה). לא נשלחה פעולה נוספת. המצב העדכני מוצג בכרטיס.");
    case "drift": return out(`ההשפעה השתנתה מאז שההצעה נוצרה, ולכן הפעולה לא בוצעה. ${NOTHING_DONE} אפשר לבקש הצעה מעודכנת.`);
    case "busy":
      return phase === "create"
        ? out(`יש כבר הצעות פתוחות או פעולה רחבה שרצה כרגע. בטל הצעה קודמת או המתן שהפעולה תסתיים. ${NOTHING_DONE}`)
        : out(`פעולת חשמל אחרת רצה כרגע. ${NOTHING_DONE} נסה שוב כשהיא תסתיים.`);
    case "protected": return out(`השקע מוגן (מזין ציוד תשתית), ולכן העוזר לא יפעיל עליו פעולה. ${NOTHING_DONE}`);
    case "protected_unset": return out(`כיבוי ארון או מעבדה חסום עד שמנהל המעבדה יגדיר את השקעים המוגנים (POWER_PROTECTED_OUTLETS). ${NOTHING_DONE}`);
    case "not_resolved": return out(`לא נמצא ציוד שמתאים לבקשה. ${NOTHING_DONE}`);
    case "ambiguous": return out(`השם מתאים ליותר מרכיב אחד, ולכן לא נבחר אף אחד. ${NOTHING_DONE}`);
    case "no_targets": return out(`אין שקעים שהפעולה הזו תשנה (כולם כבר במצב המבוקש, מוגנים או לא זמינים). ${NOTHING_DONE}`);
    case "invalid": return out(`הבקשה נדחתה כלא תקינה. ${NOTHING_DONE}`);
    default:
      if (unknownExecute && (err?.status ?? 0) >= 500) return out("השרת נכשל בעיבוד הבקשה. לא ידוע אם הפעולה התחילה — לחץ \"בדוק מצב\".", { outcomeUnknown: true });
      return out(`הבקשה נכשלה${err?.status ? ` (HTTP ${err.status})` : ""}. ${phase === "execute" ? NOTHING_DONE : "נסה שוב."}`);
  }
}

export function actionErrorText(err, options) {
  return actionErrorInfo(err, options).text;
}

// ---------------------------------------------------------------------------------------------------------------
// Session generation: a response may only be published by the session (sign-in, user) that sent the request.
// getGeneration is the panel's action epoch (bumped on sign-out, another user, unmount). Capture it when a request
// starts; when the answer arrives, drop it if isCurrent() is false, else hand `epoch` on with the proposal.
// ---------------------------------------------------------------------------------------------------------------
export function generationGuard(getGeneration) {
  if (typeof getGeneration !== "function") return { epoch: undefined, isCurrent: () => true };
  const epoch = getGeneration();
  return { epoch, isCurrent: () => getGeneration() === epoch };
}

// ---------------------------------------------------------------------------------------------------------------
// KVM consoles (SEC-ACT-18): only "/api/kvms/{id}/autologin?port=N" for a KVM the site knows, matching the entry.
// ---------------------------------------------------------------------------------------------------------------
export function consoleTarget(entry, devices) {
  const target = parseConsoleUrl(entry?.console_url);
  if (!target || !Number.isInteger(target.port) || target.port < 1) return null;
  if (entry.kvm_id && entry.kvm_id !== target.deviceId) return null;
  if (Number.isInteger(entry.port) && entry.port !== target.port) return null;
  const known = (Array.isArray(devices) ? devices : []).some(d => d && d.kind === "kvm" && String(d.id) === target.deviceId);
  return known ? target : null;
}

export const CONSOLE_NOTES = {
  popup: "הקונסול נפתח בלשונית חדשה.",
  inline: "הדפדפן חסם חלון חדש, ולכן הקונסול נפתח בתוך האתר.",
  denied: "פתיחת KVM דורשת הרשאת Operator.",
  invalid: "כתובת הקונסול שהתקבלה אינה תקינה. פתח את ה-KVM מעמוד Consoles.",
};
export const AFTER_CYCLE_NOTE = "השרת עולה מחדש; ייתכן שהמסך יהיה שחור עד כדקה.";

// Consoles the card itself offers: the entries of an open_console proposal. Consoles of a finished run are shown by
// ActionProgress (ACT-9), which calls the same onOpenConsole handler.
export function proposalConsoles(proposal) {
  if (!proposal || proposal.kind !== "open_console") return [];
  return proposal.impact.consoles;
}

// ---------------------------------------------------------------------------------------------------------------
// Location changes (server_swap / server_move / server_clear): no power, no password, one confirmation click.
// The card and the dialog show the server's move-server dry run (impact.changes / positions / unplaced) as a
// before -> after list; every name and label is text (rendered in <bdi>), never markup.
// ---------------------------------------------------------------------------------------------------------------
export const DATA_CONFIRM_LABEL = "אשר שינוי";
export const DATA_DRIFT_TEXT = "המיקומים השתנו מאז ההצעה";
export const DATA_CHANGED_EVENT = "dcim-assistant-data-changed";
export const EMPTY_LABEL = "(ריק)";
export const NO_POSITION = "בלי מיקום";
// router._admit's generic text for a refused proposal; the data headline already says it.
const GENERIC_REFUSED = ["המצב השתנה; יש לבקש הצעה חדשה."];
const hasHebrewText = text => typeof text === "string" && /[֐-׿]/.test(text);

export const changesText = n => (n === 1 ? "שינוי אחד" : `${n} שינויים`);

export function portWord(kind) {
  const k = typeof kind === "string" ? kind.toLowerCase() : "";
  return k === "kvm" ? "פורט" : k === "pdu" ? "שקע" : "יציאה";
}

const labelOrEmpty = v => (typeof v === "string" && v.trim() ? v.trim() : EMPTY_LABEL);

// "Rack-05 U3", "U7" without a rack, or "בלי מיקום".
export function spotText(spot) {
  if (!spot || typeof spot !== "object") return NO_POSITION;
  const parts = [];
  if (typeof spot.rack === "string" && spot.rack.trim()) parts.push(spot.rack.trim());
  if (Number.isInteger(spot.slot) && spot.slot >= 1) parts.push(`U${spot.slot}`);
  return parts.length ? parts.join(" ") : NO_POSITION;
}

// Port label changes by device (natural order) and port number:
// [{key, device, word, port, before, after, text}], text = "PDU-05 · שקע 7: optn44 → optn45".
export function changeRows(changes) {
  return (Array.isArray(changes) ? changes : [])
    .filter(c => c && typeof c === "object")
    .map((c, i) => {
      const device = str(c.device_name) || str(c.device_id);
      const port = str(c.port).trim();
      const word = portWord(c.kind);
      const before = labelOrEmpty(c.before), after = labelOrEmpty(c.after);
      return { key: `${str(c.device_id) || device}:${port}:${i}`, device, word, port, before, after,
        text: `${device} · ${word} ${port}: ${before} → ${after}` };
    })
    .filter(r => r.device && r.port)
    .sort((a, b) => natural(a.device, b.device) || natural(a.port, b.port));
}

// The planner lists every server involved, also those whose rack position stays the same: only real moves count.
export function movedPositions(positions) {
  return (Array.isArray(positions) ? positions : [])
    .filter(p => p && typeof p === "object" && str(p.server).trim() && spotText(p.before) !== spotText(p.after));
}

// Rack positions that change: [{key, server, before, after, text}], text = "optn45: Rack-05 U3 → Rack-02 U7".
export function positionRows(positions) {
  return movedPositions(positions).map((p, i) => {
    const server = str(p.server).trim();
    const before = spotText(p.before), after = spotText(p.after);
    return { key: `${server}:${i}`, server, before, after, text: `${server}: ${before} → ${after}` };
  });
}

// "optn44 יישאר בלי מיקום" before it runs, "optn44 נשאר בלי מיקום" after.
export function unplacedSuffix(past = false) {
  return `${past ? "נשאר" : "יישאר"} ${NO_POSITION}`;
}
export function unplacedText(name, past = false) {
  return `${name} ${unplacedSuffix(past)}`;
}

// Label changes plus rack positions that really move.
export function dataChangeCount(changes, positions) {
  return (Array.isArray(changes) ? changes.length : 0) + movedPositions(positions).length;
}

const unplacedWarning = (warnings, name) =>
  (Array.isArray(warnings) ? warnings : []).find(w => typeof w === "string" && w.includes(name) && w.includes(NO_POSITION));

// The amber line for each server left without a location: the server's own warning when it has one
// ("optn44 יישאר בלי מיקום: בלי שקעי PDU, …"), else "optn44 יישאר בלי מיקום". [{name, text}]
export function unplacedLines(unplaced, warnings = [], past = false) {
  return (Array.isArray(unplaced) ? unplaced : []).filter(n => typeof n === "string" && n.trim())
    .map(name => ({ name, text: (!past && unplacedWarning(warnings, name)) || unplacedText(name, past) }));
}

// Server warnings, minus those that only repeat an unplaced server (the impact list shows those itself, in amber).
export function dataWarnings(proposal) {
  const impact = proposal?.impact;
  if (!impact) return [];
  const unplaced = Array.isArray(impact.unplaced) ? impact.unplaced : [];
  return (Array.isArray(impact.warnings_he) ? impact.warnings_he : [])
    .filter(w => !unplaced.some(name => w.includes(name) && w.includes(NO_POSITION)));
}

// The dialog's one-line summary for a location change.
function dataImpactSentence(proposal) {
  const { changes, positions } = proposal.impact;
  const labels = changes.length, spots = movedPositions(positions).length;
  const labelsText = labels === 1 ? "תווית אחת" : `${labels} תוויות`;
  let text;
  if (!labels && !spots) text = "אין שינויים להחיל.";
  else if (proposal.kind === "server_clear") {
    text = `${labels === 1 ? "תווית אחת תחזור" : `${labels} תוויות יחזרו`} לשם ברירת המחדל (Outlet N / Port N). המיקום בארון לא ישתנה.`;
  } else {
    const spotsText = spots === 1 ? "מיקום אחד בארון" : `${spots} מיקומים בארון`;
    text = `הפעולה תשנה ${labels ? `${labelsText} ב-PDU וב-KVM` : ""}${labels && spots ? " ו־" : ""}${spots ? spotsText : ""}.`;
  }
  return `${text} החשמל לא ישתנה.`;
}

// What ActionProgress shows for a location change (raw or normalized proposal):
// {text, tone, alert, lines, applied: {changes, positions, unplaced, count} | null}; null while pending/ready.
export function dataResultView(proposal) {
  const p = normalizeProposal(proposal);
  if (!p || !isDataKind(p)) return null;
  const r = p.result;
  const summary = hasHebrewText(r?.summary_he) ? r.summary_he.trim() : "";
  const view = (text, tone, extra = {}) => ({ text, tone, alert: false, lines: [], applied: null, ...extra });
  switch (p.status) {
    case "executing": return view("מחיל את השינויים…", "running");
    case "succeeded":
    case "partial": {
      // An older server may not echo the list: the proposal's own (re-checked) list is what was applied.
      const changes = r?.changes ?? p.impact.changes;
      const positions = r?.positions ?? p.impact.positions;
      const unplaced = r?.unplaced ?? p.impact.unplaced;
      const n = dataChangeCount(changes, positions);
      const text = p.status === "succeeded" ? (n ? `בוצע: ${changesText(n)}` : "בוצע. לא היה מה לשנות.") : `בוצע חלקית: ${changesText(n)}`;
      return view(text, p.status === "succeeded" ? "ok" : "warn", {
        alert: p.status === "partial",
        lines: summary && summary !== text ? [summary] : [],
        applied: { changes, positions, unplaced, count: n },
      });
    }
    case "failed": return view(summary || "השינוי נכשל. בדוק את המיקומים לפני שתנסה שוב.", "error", { alert: true });
    case "refused": {
      // The headline already says the locations changed; only a different server reason is added.
      const lines = summary && !GENERIC_REFUSED.includes(summary) && !summary.startsWith(DATA_DRIFT_TEXT) ? [summary] : [];
      return view(`${DATA_DRIFT_TEXT}, ולכן שום דבר לא שונה. אפשר להציע שוב ולקבל רשימה מעודכנת.`, "warn", { lines });
    }
    case "interrupted": return view("השרת הופעל מחדש באמצע השינוי. בדוק את המיקומים לפני שתנסה שוב.", "warn", { alert: true });
    case "expired": return view("ההצעה פגה ולא בוצעה.", "muted");
    case "cancelled": return view("ההצעה בוטלה. לא בוצע שום שינוי.", "muted");
    default: return null;
  }
}

// A location change this browser watched has finished (pending/executing -> a final status that may have written):
// the device tables reload once.
export function dataChangeFinished(prevStatus, nextStatus) {
  return ["pending", "executing"].includes(prevStatus) && ["succeeded", "partial", "failed"].includes(nextStatus);
}
