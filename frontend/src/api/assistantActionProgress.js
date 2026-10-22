// Assistant actions (v2.40.0): progress, results and history helpers, and the one shared progress poller.
// Pure module: no DOM, no React, no fetch of its own, so node --test can import it. The poller receives its
// fetch function by injection (ActionProgress.jsx configures it with getProposal from api/assistantActions.js).
// Every proposal is the server's public JSON (backend/app/assistant/actions/contracts.py). The raw server objects
// are kept as they are; these helpers only read them, defensively, for display.

// ---------------------------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------------------------
export const ACTION_STATUSES = ["pending", "executing", "succeeded", "partial", "failed", "cancelled", "expired", "refused",
  "interrupted", "ready"];
export const FINAL_STATUSES = ["succeeded", "partial", "failed", "cancelled", "expired", "refused", "interrupted", "ready"];

export function isFinalStatus(status) {
  return FINAL_STATUSES.includes(status);
}

const STATUS_INFO = {
  pending: { label: "ממתינה לאישור", tone: "info" },
  executing: { label: "בביצוע…", tone: "running" },
  succeeded: { label: "בוצע", tone: "ok" },
  partial: { label: "בוצע חלקית", tone: "warn" },
  failed: { label: "נכשל", tone: "error" },
  cancelled: { label: "בוטלה", tone: "muted" },
  expired: { label: "פג תוקף", tone: "muted" },
  refused: { label: "נדחתה — המצב השתנה", tone: "warn" },
  interrupted: { label: "נקטעה", tone: "warn" },
  ready: { label: "קונסול זמין", tone: "info" },
};

// Chip classes per tone. Colour is never the only signal: every chip also carries its Hebrew label.
export const TONE_CLASSES = {
  running: "border-nv-400/60 bg-nv-400/10 text-nv-300",
  ok: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
  warn: "border-amber-700 bg-amber-950/40 text-amber-200",
  error: "border-rose-800 bg-rose-950/40 text-rose-300",
  muted: "border-zinc-700 bg-zinc-900 text-zinc-400",
  info: "border-sky-800 bg-sky-950/30 text-sky-300",
};
// Text colour for a line in the same tone.
export const TONE_TEXT = {
  running: "text-nv-300", ok: "text-emerald-300", warn: "text-amber-200", error: "text-rose-300", muted: "text-zinc-400",
  info: "text-zinc-300",
};

export function statusLabel(status) {
  return STATUS_INFO[status]?.label || "מצב לא ידוע";
}

export function statusTone(status) {
  return STATUS_INFO[status]?.tone || "muted";
}

export function statusChip(status) {
  const tone = statusTone(status);
  return { label: statusLabel(status), tone, className: TONE_CLASSES[tone] };
}

// ---------------------------------------------------------------------------------------------------------------
// Safe readers (the UI never trusts the shape)
// ---------------------------------------------------------------------------------------------------------------
const str = v => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const objList = v => (Array.isArray(v) ? v.filter(x => obj(x)) : []);
const count = v => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const intList = v => (Array.isArray(v) ? v.filter(n => Number.isInteger(n) && n >= 0) : []);
const hasHebrew = text => typeof text === "string" && /[֐-׿]/.test(text);
const timeOf = iso => { const ms = Date.parse(typeof iso === "string" ? iso : ""); return Number.isFinite(ms) ? ms : 0; };

export function proposalId(p) {
  return str(obj(p)?.id);
}

export function proposalStatus(p) {
  const s = obj(p)?.status;
  return ACTION_STATUSES.includes(s) ? s : "unknown";
}

export function proposalTitle(p) {
  const o = obj(p) || {};
  return str(o.title_he) || str(o.title) || "פעולה מהעוזר";
}

// kind -> switch, as in contracts.KIND_SPECS.
const KIND_SWITCH = {
  server_off: "off", outlet_off: "off", server_on: "on", outlet_on: "on", server_cycle: "cycle", outlet_cycle: "cycle",
  pdu_shutdown: "maintenance_off", rack_shutdown: "maintenance_off", lab_shutdown: "maintenance_off",
  pdu_restore: "maintenance_on", batch_restore: "maintenance_on", open_console: "none",
};

export function kindSwitch(kind) {
  return KIND_SWITCH[kind] || "none";
}

const isPduKind = kind => ["maintenance_off", "maintenance_on"].includes(kindSwitch(kind));

// Progress is counted in PDUs for maintenance kinds (rack/lab/batch/pdu) and in outlets otherwise (runner.py).
export function progressUnit(kind) {
  return isPduKind(kind) ? "PDU" : "שקעים";
}

function impactOf(p) {
  const i = obj(obj(p)?.impact) || {};
  return { targets: objList(i.targets), excluded: objList(i.excluded), pdus: Array.isArray(i.pdus) ? i.pdus.map(str).filter(Boolean) : [],
    servers: Array.isArray(i.servers) ? i.servers.map(str).filter(Boolean) : [] };
}

function resultOf(p) {
  const r = obj(obj(p)?.result);
  if (!r) return null;
  return { raw: r, targets: objList(r.targets), pdus: objList(r.pdus), consoles: objList(r.consoles), summary: str(r.summary_he) };
}

// {name, rack} for a PDU id from everything the proposal says about it.
function pduInfo(p, pduId) {
  const impact = impactOf(p);
  const result = resultOf(p);
  const hit = [...impact.targets, ...impact.excluded, ...(result?.pdus || [])].find(x => str(x.pdu_id) === pduId && str(x.pdu_name));
  const rack = [...impact.targets, ...impact.excluded].find(x => str(x.pdu_id) === pduId && str(x.rack));
  return { name: hit ? str(hit.pdu_name) : pduId, rack: rack ? str(rack.rack) : "" };
}

function serverName(p) {
  const impact = impactOf(p);
  if (impact.servers.length === 1) return impact.servers[0];
  const req = str(obj(obj(p)?.request)?.server);
  return impact.servers.length === 0 ? req : "";
}

// ---------------------------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------------------------
export function progressInfo(p) {
  const pr = obj(obj(p)?.progress) || {};
  const total = count(pr.total);
  const done = total ? Math.min(count(pr.done), total) : 0;
  const unit = progressUnit(obj(p)?.kind);
  return { done, total, unit, percent: total ? Math.round((done * 100) / total) : 0,
    text: total ? `${done} מתוך ${total} ${unit}` : "", short: total ? `${done}/${total} ${unit}` : "" };
}

const VERB_RUNNING = { maintenance_off: "מכבה חשמל", maintenance_on: "מחזיר חשמל", off: "מכבה חשמל", on: "מדליק חשמל", cycle: "מבצע ריסט" };

// "מכבה חשמל: 4 מתוך 9 PDU" while executing.
export function executingLine(p) {
  const { text } = progressInfo(p);
  const verb = VERB_RUNNING[kindSwitch(obj(p)?.kind)] || "מבצע את הפעולה";
  return text ? `${verb}: ${text}` : `${verb}…`;
}

export function executingNote(p) {
  const kind = obj(p)?.kind;
  if (kind === "rack_shutdown" || kind === "lab_shutdown") return "אי אפשר לעצור באמצע. בסיום אפשר להחזיר חשמל.";
  if (kindSwitch(kind) === "cycle") return "אי אפשר לעצור באמצע. החשמל יוחזר אוטומטית בסוף הריסט.";
  return "אי אפשר לעצור באמצע.";
}

// The PDU being processed now (maintenance kinds run their PDUs one by one in impact.pdus order); null otherwise.
export function currentPdu(p) {
  if (proposalStatus(p) !== "executing" || !isPduKind(obj(p)?.kind)) return null;
  const ids = impactOf(p).pdus;
  const { done, total } = progressInfo(p);
  if (!total || total !== ids.length || done >= ids.length) return null;
  return { id: ids[done], ...pduInfo(p, ids[done]) };
}

// ---------------------------------------------------------------------------------------------------------------
// Results: one row per PDU (maintenance kinds) or per outlet (server/outlet kinds). Rows that were NOT switched
// (failed, stayed off, unverified, not handled, left on) come first, then the successful ones.
// row: {key, type: "pdu"|"target", pduName, rack, outlet, who, state, tone, mark, text, detail, notes: [str]}
// ---------------------------------------------------------------------------------------------------------------
// left = switched as planned, but outlets that were not in the proposal stayed on (D3).
const ROW_RANK = { failed: 0, off: 0, unknown: 1, skipped: 2, left: 3, current: 4, processed: 4, pending: 5, ok: 6 };
const ROW_TONE = { failed: "error", off: "error", unknown: "warn", skipped: "warn", left: "warn", current: "running", processed: "info", pending: "muted", ok: "ok" };
const ROW_MARK = { failed: "✕", off: "✕", unknown: "?", skipped: "–", left: "!", current: "…", processed: "•", pending: "", ok: "✓" };

function row(base, state, text, extra = {}) {
  return { notes: [], detail: "", outlet: null, who: "", ...base, ...extra, state, text, tone: ROW_TONE[state], mark: ROW_MARK[state] };
}

const outletList = nums => nums.join(", ");

function pduRows(p, status) {
  const sw = kindSwitch(obj(p)?.kind);
  const off = sw === "maintenance_off";
  const ids = impactOf(p).pdus;
  const result = resultOf(p);
  const { done } = progressInfo(p);
  if (status === "executing") {
    if (ids.length < 2) return [];
    return ids.map((id, i) => {
      const info = pduInfo(p, id);
      const base = { key: `pdu:${id}`, type: "pdu", pduName: info.name, rack: info.rack };
      return i < done ? row(base, "processed", "טופל") : i === done ? row(base, "current", "בביצוע…") : row(base, "pending", "ממתין");
    });
  }
  const rows = [];
  const seen = new Set();
  for (const r of result?.pdus || []) {
    const id = str(r.pdu_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const info = pduInfo(p, id);
    const switched = intList(r.switched);
    const failed = intList(r.failed);
    const notIncluded = intList(r.not_included);
    const base = { key: `pdu:${id}`, type: "pdu", pduName: str(r.pdu_name) || info.name, rack: info.rack, detail: str(r.error) };
    const notes = [];
    if (failed.length) notes.push(`${off ? "שקעים שלא כובו" : "שקעים שלא הודלקו"}: ${outletList(failed)}`);
    if (notIncluded.length) notes.push(`דלקו ולא הוצגו בהצעה, ולכן נשארו דולקים: ${outletList(notIncluded)}`);
    if (r.ok === true) {
      const text = off
        ? (switched.length ? `${switched.length}/${switched.length + failed.length} כובו ואומתו` : "לא היו שקעים דולקים לכיבוי")
        : (switched.length ? `${switched.length} הודלקו ואומתו` : "הוחזר מתחזוקה");
      rows.push(row(base, notIncluded.length ? "left" : "ok", text, { notes }));
    } else {
      if (switched.length) notes.unshift(`${off ? "כובו" : "הודלקו"}: ${outletList(switched)}`);
      rows.push(row(base, "failed", "נכשל", { notes }));
    }
  }
  // PDUs in the plan with no result after the job ended: never reached (abort) or unknown (restart mid-job).
  if (["succeeded", "partial", "failed", "interrupted"].includes(status)) {
    ids.forEach((id, i) => {
      if (seen.has(id)) return;
      const info = pduInfo(p, id);
      const base = { key: `pdu:${id}`, type: "pdu", pduName: info.name, rack: info.rack };
      rows.push(status === "interrupted" && i <= done && !(result?.pdus || []).length
        ? row(base, "unknown", "מצב לא ידוע — בדוק בעמוד ה-PDU")
        : row(base, "skipped", "לא טופל"));
    });
  }
  return rows;
}

function targetRows(p, status) {
  if (status === "executing") return [];
  const sw = kindSwitch(obj(p)?.kind);
  const impact = impactOf(p);
  const result = resultOf(p);
  const lookup = (pduId, outlet) => impact.targets.find(t => str(t.pdu_id) === pduId && t.outlet === outlet) || {};
  const rows = [];
  const seen = new Set();
  for (const r of result?.targets || []) {
    const pduId = str(r.pdu_id);
    const outlet = Number.isInteger(r.outlet) ? r.outlet : null;
    const key = `target:${pduId}:${outlet}`;
    if (!pduId || outlet === null || seen.has(key)) continue;
    seen.add(key);
    const t = lookup(pduId, outlet);
    const base = { key, type: "target", pduName: str(t.pdu_name) || pduInfo(p, pduId).name, rack: str(t.rack), outlet,
      who: str(t.server) || str(t.label), detail: str(r.error) };
    const after = str(r.state_after);
    if (r.ok === true) {
      rows.push(row(base, "ok", sw === "off" ? "כבוי ואומת" : sw === "on" ? "דולק ואומת" : sw === "cycle" ? "אותחל ואומת" : "אומת"));
    } else if (sw === "cycle" && after === "off") {
      rows.push(row(base, "off", "נשאר כבוי"));
    } else if (after === "unknown" || !after) {
      rows.push(row(base, "unknown", "לא אומת — ייתכן שהמצב השתנה"));
    } else {
      rows.push(row(base, "failed", after === "on" ? "נכשל — כרגע דולק" : after === "off" ? "נכשל — כרגע כבוי" : "נכשל"));
    }
  }
  if (["succeeded", "partial", "failed", "interrupted"].includes(status)) {
    for (const t of impact.targets) {
      const key = `target:${str(t.pdu_id)}:${t.outlet}`;
      if (seen.has(key) || !Number.isInteger(t.outlet)) continue;
      seen.add(key);
      rows.push(row({ key, type: "target", pduName: str(t.pdu_name), rack: str(t.rack), outlet: t.outlet, who: str(t.server) || str(t.label) },
        "unknown", status === "interrupted" ? "מצב לא ידוע — בדוק בעמוד ה-PDU" : "לא אומת — ייתכן שהמצב השתנה"));
    }
  }
  return rows;
}

export function resultRows(p) {
  const status = proposalStatus(p);
  if (!["executing", "succeeded", "partial", "failed", "interrupted"].includes(status)) return [];
  const rows = isPduKind(obj(p)?.kind) ? pduRows(p, status) : kindSwitch(obj(p)?.kind) === "none" ? [] : targetRows(p, status);
  if (status === "executing") return rows;
  return rows.map((r, i) => [r, i]).sort((a, b) => ROW_RANK[a[0].state] - ROW_RANK[b[0].state] || a[1] - b[1]).map(([r]) => r);
}

// ---------------------------------------------------------------------------------------------------------------
// Summary line for a finished action, and explanations for statuses where nothing (or not everything) ran.
// {text, tone, alert, lines: [str]}; lines are extra sentences (abort reason, outlets left on, server notes).
// ---------------------------------------------------------------------------------------------------------------
const AFTER_ABORT = "ה-PDU שאחריו לא טופלו.";
// [text with the PDU name, text without it]
const ABORT_TEXT = {
  unreachable: [`{pdu} לא היה זמין, ולכן הפעולה נעצרה. ${AFTER_ABORT}`, `אחד ה-PDU לא היה זמין, ולכן הפעולה נעצרה. ${AFTER_ABORT}`],
  disabled: [`ביצוע פעולות מהעוזר כובה בהגדרות השרת באמצע הריצה, ולכן הפעולה נעצרה. ${AFTER_ABORT}`],
  drift: [`המצב של {pdu} השתנה באמצע הריצה, ולכן הפעולה נעצרה. ${AFTER_ABORT}`, `המצב של אחד ה-PDU השתנה באמצע הריצה, ולכן הפעולה נעצרה. ${AFTER_ABORT}`],
  maintenance: [`{pdu} הוכנס לתחזוקה על ידי מישהו אחר באמצע הריצה, ולכן הפעולה נעצרה. ${AFTER_ABORT}`,
    `אחד ה-PDU הוכנס לתחזוקה על ידי מישהו אחר באמצע הריצה, ולכן הפעולה נעצרה. ${AFTER_ABORT}`],
};
const ABORT_DEFAULT = [`הפעולה נעצרה באמצע, ב-{pdu}. ${AFTER_ABORT}`, `הפעולה נעצרה באמצע. ${AFTER_ABORT}`];

// Hebrew reason when the job stopped early (D7). Reads result.aborted ({reason, pdu_id?, pdu_name?} or a reason
// string) or result.abort_reason. null when the job was not aborted.
export function abortText(p) {
  const r = obj(obj(p)?.result);
  if (!r) return null;
  const a = r.aborted ?? r.abort_reason;
  if (!a) return null;
  const info = obj(a) || {};
  if (hasHebrew(str(info.text_he))) return str(info.text_he);
  const reason = typeof a === "string" ? a : str(info.reason) || str(info.code);
  const pduId = str(info.pdu_id);
  const pdu = str(info.pdu_name) || (pduId ? pduInfo(p, pduId).name : "");
  const [withName, withoutName = withName] = ABORT_TEXT[reason] || ABORT_DEFAULT;
  return pdu ? withName.replace("{pdu}", pdu) : withoutName;
}

// Outlets that were on at execution but not shown in the proposal, left on (D3).
export function notIncludedCount(p) {
  const r = resultOf(p);
  if (!r) return 0;
  const fromPdus = r.pdus.reduce((n, x) => n + intList(x.not_included).length, 0);
  const list = Array.isArray(r.raw.not_included) ? r.raw.not_included.length : 0;
  return fromPdus + list;
}

function pduSummary(p, status) {
  const off = kindSwitch(obj(p)?.kind) === "maintenance_off";
  const result = resultOf(p);
  const pdus = result?.pdus || [];
  const planned = impactOf(p).pdus.length;
  const total = Math.max(planned, progressInfo(p).total, pdus.length);
  const ok = pdus.filter(x => x.ok === true).length;
  const failedN = pdus.filter(x => x.ok !== true).length;
  const skippedN = Math.max(0, total - pdus.length);
  const outlets = pdus.reduce((n, x) => n + intList(x.switched).length, 0);
  const anySwitched = outlets > 0;
  const tail = !skippedN ? "" : skippedN === 1 ? " PDU אחד לא טופל ונשאר כפי שהיה." : ` ${skippedN} לא טופלו ונשארו כפי שהיו.`;
  const failedPart = still => (!failedN ? "" : failedN === 1 ? ` PDU אחד נכשל, וייתכן שהציוד שלו עדיין ${still}.`
    : ` ${failedN} נכשלו, וייתכן שהציוד שלהם עדיין ${still}.`);
  if (status === "succeeded") {
    if (off) return { text: outlets ? `החשמל כובה ב־${ok} מתוך ${total} PDU (${outlets} שקעים). כל השקעים אומתו ככבויים.`
      : `${ok} מתוך ${total} PDU הוכנסו לתחזוקה. לא היו שקעים דולקים לכיבוי.`, tone: "ok", alert: false };
    return { text: outlets ? `החשמל הוחזר ב־${ok} מתוך ${total} PDU (${outlets} שקעים הודלקו ואומתו).`
      : `${ok} מתוך ${total} PDU הוחזרו מתחזוקה.`, tone: "ok", alert: false };
  }
  if (status === "partial") {
    return off
      ? { text: `בוצע חלקית: ${ok} מתוך ${total} PDU כובו.${failedPart("דולק")}${tail}`, tone: "warn", alert: true }
      : { text: `בוצע חלקית: החשמל הוחזר ב־${ok} מתוך ${total} PDU.${failedPart("כבוי")}${tail}`, tone: "warn", alert: true };
  }
  // failed
  if (ok) return { text: `הפעולה נכשלה באמצע: ${ok} מתוך ${total} PDU ${off ? "כובו" : "הוחזרו"} לפני התקלה. בדוק את השאר בעמוד ה-PDU.`, tone: "error", alert: true };
  if (off) {
    return anySwitched || pdus.length === 0 && progressInfo(p).done > 0
      ? { text: "הפעולה נכשלה. מצב חלק מהשקעים לא ידוע — בדוק בעמוד ה-PDU.", tone: "error", alert: true }
      : { text: "הפעולה נכשלה. לא כובה אף שקע.", tone: "error", alert: true };
  }
  return { text: "החזרת החשמל נכשלה. ייתכן שהציוד עדיין כבוי — בדוק בעמוד ה-PDU.", tone: "error", alert: true };
}

function targetSummary(p, status) {
  const sw = kindSwitch(obj(p)?.kind);
  const rows = targetRows(p, status);
  const total = Math.max(rows.length, progressInfo(p).total);
  const ok = rows.filter(r => r.state === "ok").length;
  const stayedOff = rows.filter(r => r.state === "off");
  const unknown = rows.filter(r => r.state === "unknown").length;
  const failedN = rows.length - ok - unknown;
  const server = serverName(p);
  if (sw === "cycle" && stayedOff.length) {
    const list = stayedOff.map(r => `${r.pduName} · ${r.outlet}`).join(", ");
    return { text: `החשמל לא הוחזר ל־${server || "השקעים"}! שקעים כבויים: ${list}. הדלק אותם מעמוד ה-PDU.`, tone: "error", alert: true };
  }
  const past = sw === "off" ? "כובו" : sw === "on" ? "הודלקו" : "אותחלו";
  if (status === "succeeded") {
    if (sw === "cycle") return { text: server ? `${server} אותחל: החשמל נותק והוחזר בכל השקעים שלו (${total}).`
      : `הריסט הושלם: החשמל נותק והוחזר ב־${total} שקעים ואומת.`, tone: "ok", alert: false };
    const what = sw === "off" ? "כובה" : "הודלק";
    return { text: `החשמל ${what} ואומת ב־${total} ${total === 1 ? "שקע" : "שקעים"}${server ? ` של ${server}` : ""}.`, tone: "ok", alert: false };
  }
  if (status === "partial") {
    const parts = [`בוצע חלקית: ${ok} מתוך ${total} שקעים ${past} ואומתו.`];
    if (failedN) parts.push(failedN === 1 ? "שקע אחד נכשל." : `${failedN} נכשלו.`);
    if (unknown) parts.push(`${unknown === 1 ? "מצב שקע אחד" : `מצב ${unknown} שקעים`} לא אומת — בדוק בעמוד ה-PDU.`);
    return { text: parts.join(" "), tone: "warn", alert: true };
  }
  if (unknown || ok) return { text: "הפעולה נכשלה. מצב חלק מהשקעים לא ידוע — בדוק בעמוד ה-PDU.", tone: "error", alert: true };
  return { text: sw === "off" ? "הפעולה נכשלה. לא כובה אף שקע." : sw === "on" ? "הפעולה נכשלה. לא הודלק אף שקע."
    : "הריסט נכשל. בדוק את מצב השקעים בעמוד ה-PDU.", tone: "error", alert: true };
}

export const STATUS_EXPLANATIONS = {
  refused: "המצב במעבדה השתנה מאז שההצעה נוצרה, ולכן הפעולה לא בוצעה. בקש מהעוזר הצעה מעודכנת.",
  expired: "ההצעה פגה ולא בוצעה.",
  cancelled: "ההצעה בוטלה. לא בוצעה שום פעולה.",
  interrupted: "השרת הופעל מחדש באמצע הביצוע, ולכן הפעולה נקטעה.",
};

// The final line for a proposal (null while pending/executing/ready).
export function summarizeResult(p) {
  const status = proposalStatus(p);
  const kind = obj(p)?.kind;
  const result = resultOf(p);
  const lines = [];
  const abort = abortText(p);
  if (abort) lines.push(abort);
  const left = notIncludedCount(p);
  if (left) lines.push(left === 1 ? "שקע אחד שדלק ולא הוצג בהצעה נשאר דולק." : `${left} שקעים שדלקו ולא הוצגו בהצעה נשארו דולקים.`);
  if (status === "refused" || status === "expired" || status === "cancelled") {
    if (status === "refused") {
      if (hasHebrew(result?.summary) && result.summary !== STATUS_EXPLANATIONS.refused) lines.push(result.summary);
      for (const d of Array.isArray(result?.raw.details) ? result.raw.details : []) if (hasHebrew(d)) lines.push(d);
    }
    return { text: STATUS_EXPLANATIONS[status], tone: status === "refused" ? "warn" : "muted", alert: false, lines };
  }
  if (status === "interrupted") {
    const { done, total, unit } = progressInfo(p);
    let text = STATUS_EXPLANATIONS.interrupted;
    if (total) text += ` הושלמו ${done} מתוך ${total} ${unit} לפני ההפסקה.`;
    if (obj(p)?.can_restore === true) text += " ה-PDU שכבר כובו נשארו בתחזוקה, ואפשר להחזיר להם חשמל.";
    else if (kindSwitch(kind) === "maintenance_off") text += " PDU שכבר כובו נשארו בתחזוקה — בדוק אותם בעמוד ה-PDU.";
    else text += " מצב השקעים לא ידוע — בדוק בעמוד ה-PDU.";
    return { text, tone: "warn", alert: true, lines };
  }
  if (status === "unknown") return { text: "מצב הפעולה לא ידוע כאן. בדוק את המצב בעמוד ה-PDU.", tone: "muted", alert: false, lines };
  if (!["succeeded", "partial", "failed"].includes(status)) return null;
  const sw = kindSwitch(kind);
  let base;
  if (sw === "none") base = { text: "הפעולה הושלמה.", tone: "ok", alert: false };
  else if (!result || (!result.pdus.length && !result.targets.length && !impactOf(p).pdus.length && !impactOf(p).targets.length)) {
    base = hasHebrew(result?.summary) ? { text: result.summary, tone: statusTone(status), alert: status !== "succeeded" }
      : { text: status === "succeeded" ? "הפעולה הושלמה." : "הפעולה לא הושלמה. בדוק את המצב בעמוד ה-PDU.", tone: statusTone(status), alert: status !== "succeeded" };
  } else base = isPduKind(kind) ? pduSummary(p, status) : targetSummary(p, status);
  if (abort && base.tone === "ok") base = { ...base, tone: "warn", alert: true };
  return { ...base, lines };
}

// ---------------------------------------------------------------------------------------------------------------
// Console entries in a finished result (reset then open KVM). A button is offered only for a final status, a URL
// of the exact form /api/kvms/{id}/autologin?port=N, a matching kvm_id and a KVM that the site knows (SEC-ACT-18).
// ---------------------------------------------------------------------------------------------------------------
export function parseConsoleTarget(url) {
  if (typeof url !== "string") return null;
  const m = /^\/api\/kvms\/([^/?#]+)\/autologin\?port=(\d{1,3})$/.exec(url);
  if (!m) return null;
  let deviceId;
  try { deviceId = decodeURIComponent(m[1]); } catch { return null; }
  const port = Number(m[2]);
  return deviceId && port >= 1 ? { deviceId, port } : null;
}

// {buttons: [{key, entry, deviceId, port, kvmName, label, inUse}], invalid: n, unknown: n}. `entry` is the server's
// console object as it is, for onOpenConsole(entry). Without a `devices` list no KVM is known, so no button.
export function consoleTargets(p, devices) {
  const result = resultOf(p);
  if (!isFinalStatus(proposalStatus(p)) || !result) return { buttons: [], invalid: 0, unknown: 0 };
  const known = new Set((Array.isArray(devices) ? devices : []).filter(d => obj(d) && d.kind === "kvm").map(d => str(d.id)).filter(Boolean));
  const buttons = [];
  let invalid = 0;
  let unknown = 0;
  for (const c of result.consoles) {
    const t = parseConsoleTarget(c.console_url);
    const kvmId = str(c.kvm_id);
    if (!t || (kvmId && kvmId !== t.deviceId) || (c.port !== undefined && c.port !== null && c.port !== t.port)) { invalid += 1; continue; }
    if (!known.has(t.deviceId)) { unknown += 1; continue; }
    const key = `${t.deviceId}:${t.port}`;
    if (buttons.some(b => b.key === key)) continue;
    buttons.push({ key, entry: c, deviceId: t.deviceId, port: t.port, kvmName: str(c.kvm_name) || "KVM", label: str(c.label), inUse: c.in_use === true });
  }
  return { buttons, invalid, unknown };
}

export const CONSOLE_NOTES = {
  popup: "הקונסול נפתח בלשונית חדשה.",
  inline: "הדפדפן חסם חלון חדש, ולכן הקונסול נפתח בתוך האתר.",
  denied: "פתיחת KVM דורשת הרשאת Operator.",
};
export const CONSOLE_INVALID_NOTE = "כתובת הקונסול שהתקבלה אינה תקינה. פתח את ה-KVM מעמוד Consoles.";
export const CONSOLE_UNKNOWN_NOTE = "ה-KVM של השרת לא נמצא ברשימת הציוד באתר. פתח אותו מעמוד Consoles.";
export const CONSOLE_AFTER_CYCLE_NOTE = "השרת עולה מחדש; ייתכן שהמסך יהיה שחור עד כדקה.";

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------
// The server's `code` wherever the API client put it (ACT-8's client), else the transport code.
export function errorCodeOf(err) {
  for (const v of [err?.apiCode, err?.serverCode, err?.data?.code, err?.body?.code, err?.code]) if (typeof v === "string" && v) return v;
  return "";
}

const isTransport = code => ["network", "timeout", "aborted", "bad_response"].includes(code);

// What a failed poll means: "retry" (keep polling with backoff) or a reason to stop.
export function classifyPollError(err) {
  const status = Number(err?.status) || 0;
  const code = errorCodeOf(err);
  if (status === 401) return "session";
  if (code === "disabled" || code === "actions_disabled") return "disabled";
  if (status === 403) return "forbidden";
  if (status === 404 || code === "not_found") return "gone";
  return "retry";
}

// Loading the "recent actions" list.
export function historyErrorText(err) {
  const status = Number(err?.status) || 0;
  const code = errorCodeOf(err);
  if (code === "disabled" || code === "actions_disabled") return "ביצוע פעולות מהעוזר כבוי בהגדרות השרת.";
  if (status === 403) return "דרושה הרשאת Operator כדי לראות פעולות.";
  if (status === 401) return "ההתחברות לאתר פגה. התחבר מחדש.";
  if (isTransport(code) || !status) return "אין חיבור לשרת. בדוק את החיבור ונסה שוב.";
  if (hasHebrew(err?.message)) return err.message;
  if (status === 429) return "יותר מדי בקשות. נסה שוב בעוד מעט.";
  if (status >= 500) return "השרת נכשל בטעינת הפעולות. נסה שוב בעוד מעט.";
  return `טעינת הפעולות נכשלה (HTTP ${status}).`;
}

// True when retrying the list can help (not a permission or feature-flag refusal).
export function historyRetryable(err) {
  const status = Number(err?.status) || 0;
  const code = errorCodeOf(err);
  return !(status === 401 || status === 403 || code === "disabled" || code === "actions_disabled");
}

// Creating the batch_restore proposal (onRestore). Nothing runs until that new proposal is confirmed.
export function restoreErrorText(err) {
  if (hasHebrew(err?.message)) return err.message;
  const status = Number(err?.status) || 0;
  const code = errorCodeOf(err);
  if (code === "disabled" || code === "actions_disabled") return "ביצוע פעולות מהעוזר כבוי בהגדרות השרת.";
  if (code === "password_mode") return "החזרת חשמל לארון או למעבדה זמינה רק כשחשבונות המשתמש פעילים.";
  if (code === "forbidden" || status === 403) return "החזרת חשמל לארון או למעבדה דורשת הרשאת Admin.";
  if (code === "not_found" || status === 404) return "הפעולה המקורית לא נמצאה בשרת.";
  if (code === "busy") return "יש כבר הצעה פתוחה או פעולה שרצה כרגע. סיים או בטל אותה ונסה שוב.";
  if (code === "no_targets") return "אין PDU שממתינים להחזרת חשמל מהפעולה הזו.";
  if (status === 401) return "ההתחברות לאתר פגה. התחבר מחדש.";
  if (status === 429) return "יותר מדי בקשות. נסה שוב בעוד מעט.";
  if (status === 409) return "המצב השתנה. רענן את הפעולות ונסה שוב.";
  if (isTransport(code) || !status) return "החיבור לשרת נקטע. בדוק ב\"פעולות אחרונות\" אם נוצרה הצעת החזרה, ונסה שוב.";
  if (status >= 500) return "השרת נכשל ביצירת הצעת ההחזרה. נסה שוב.";
  return `יצירת הצעת ההחזרה נכשלה (HTTP ${status}).`;
}

export const RESTORE_BUTTON = "החזר חשמל לאותם שקעים…";
export const RESTORE_HELP = "יודלקו בהדרגה רק השקעים שכובו בפעולה הזו. PDU שהיו בתחזוקה לפני כן לא ייגעו.";
export const RESTORE_CREATED = "נוצרה הצעה להחזרת חשמל. בדוק ואשר אותה בכרטיס החדש.";

// ---------------------------------------------------------------------------------------------------------------
// Polling rules
// ---------------------------------------------------------------------------------------------------------------
export const POLL_INTERVAL_MS = 2000;          // a visible progress view
export const POLL_HIDDEN_INTERVAL_MS = 5000;   // nobody is looking (panel closed): keep going, slower
export const POLL_BACKOFF_MS = [2000, 4000, 8000, 15000];
export const POLL_MAX_MS = 15 * 60_000;
export const OFFLINE_ALERT_MS = 60_000;

// Milliseconds until the next poll, or null to stop (not executing any more, or polled for maxMs already).
export function nextPollDelay({ status, startedAt, now = Date.now(), failures = 0, visible = true, maxMs = POLL_MAX_MS } = {}) {
  if (status !== "executing") return null;
  if (Number.isFinite(startedAt) && now - startedAt >= maxMs) return null;
  if (failures > 0) return POLL_BACKOFF_MS[Math.min(failures, POLL_BACKOFF_MS.length) - 1];
  return visible ? POLL_INTERVAL_MS : POLL_HIDDEN_INTERVAL_MS;
}

// Why polling is not running: "final", "idle" (pending), "timeout", or null (it should run).
export function pollStopReason({ status, startedAt, now = Date.now(), maxMs = POLL_MAX_MS } = {}) {
  if (isFinalStatus(status)) return "final";
  if (status !== "executing") return "idle";
  if (Number.isFinite(startedAt) && now - startedAt >= maxMs) return "timeout";
  return null;
}

const RANK = s => (s === "pending" ? 0 : s === "executing" ? 1 : isFinalStatus(s) ? 2 : -1);
const progressDone = p => count(obj(obj(p)?.progress)?.done);

// May `incoming` (a copy from the parent, a list or a chat answer) replace `current`? Never go back in the
// lifecycle (pending -> executing -> final) and never move progress backwards: such a copy is older.
export function acceptUpdate(current, incoming) {
  if (!obj(incoming) || !proposalId(incoming)) return false;
  if (!obj(current)) return true;
  if (proposalId(current) !== proposalId(incoming)) return false;
  const a = RANK(current.status);
  const b = RANK(incoming.status);
  if (b < 0) return false;
  if (b < a) return false;
  if (a === 1 && b === 1 && progressDone(incoming) < progressDone(current)) return false;
  return true;
}

// A poll answer is the server's latest word (one request at a time, in order). It may move back from executing
// to pending (a busy refusal puts the proposal back), but never from a final status to a running one.
export function acceptPolled(current, incoming) {
  if (!obj(incoming) || !proposalId(incoming)) return false;
  if (!obj(current)) return true;
  if (proposalId(current) !== proposalId(incoming)) return false;
  if (RANK(incoming.status) < 0) return false;
  return !(isFinalStatus(current.status) && !isFinalStatus(incoming.status));
}

export function sameProposal(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// What a view shows from a proposal. A copy with the same signature (e.g. the parent's normalized copy of what the
// poller handed it) does not replace the poller's raw server copy, which may carry more (abort reason, not_included).
export function proposalSignature(p) {
  const o = obj(p) || {};
  const r = obj(o.result);
  const pr = obj(o.progress) || {};
  return JSON.stringify([proposalId(o), o.status ?? null, count(pr.done), count(pr.total), o.can_restore === true, o.can_execute === true,
    str(o.restore_of), r ? [objList(r.targets).length, objList(r.pdus).length, objList(r.consoles).length, !!(r.aborted ?? r.abort_reason)] : null]);
}

const OFFLINE_SHORT = "החיבור לשרת נקטע. הפעולה ממשיכה לרוץ בשרת; מתחבר מחדש…";
const OFFLINE_LONG = "אין חיבור כבר דקה. מצב הפעולה לא ידוע כאן — בדוק בעמוד ה-PDU.";
const STOP_NOTICES = {
  timeout: { text: "הפעולה עדיין רצה בשרת אחרי 15 דקות, והעדכון האוטומטי נעצר. לחץ \"בדוק מצב\" כדי לרענן.", tone: "warn", action: "check" },
  gone: { text: "ההצעה כבר לא קיימת בשרת. מצב הפעולה לא ידוע כאן — בדוק בעמוד ה-PDU.", tone: "warn", action: null },
  forbidden: { text: "דרושה הרשאת Operator כדי לראות את מצב הפעולה.", tone: "warn", action: null },
  disabled: { text: "ביצוע פעולות מהעוזר כבוי בהגדרות השרת, ולכן מצב הפעולה לא מתעדכן כאן.", tone: "warn", action: null },
  session: { text: "ההתחברות לאתר פגה. התחבר מחדש כדי לראות את מצב הפעולה.", tone: "warn", action: null },
  stopped: { text: "העדכון האוטומטי נעצר. לחץ \"בדוק מצב\" כדי לרענן.", tone: "warn", action: "check" },
};

// A notice about the poller itself (not about the action): {text, tone, alert, action: "retry"|"check"|null} | null.
export function pollNotice(state, now = Date.now()) {
  if (!state || state.stopReason === "final") return null;
  if (state.stopReason && STOP_NOTICES[state.stopReason]) return { ...STOP_NOTICES[state.stopReason], alert: false };
  if (state.failures > 0) {
    const long = Number.isFinite(state.offlineSince) && now - state.offlineSince >= OFFLINE_ALERT_MS;
    return long ? { text: OFFLINE_LONG, tone: "error", alert: true, action: "retry" } : { text: OFFLINE_SHORT, tone: "warn", alert: false, action: null };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The shared poller. One timer per executing proposal, shared by every view of it, alive while the assistant panel
// is closed (slower), stopped on a final status, on 401/403/404, after maxMs, or by stopAll() (sign-out).
//   watch(proposal, listener, {visible = true}) -> unwatch   listener(state) now and on every change
//   update(proposal) -> bool        feed a newer copy (e.g. the 202 answer of execute); older copies are ignored
//   refresh(id)                     poll now ("נסה עכשיו" / "בדוק מצב"); restarts a stopped, non-final poller
//   onAny(listener) -> off          every state change of every proposal (panel badge, actions map)
//   get(id) -> state | null         state = {id, proposal, polling, stopReason, failures, offlineSince, startedAt}
//   stopAll(reason = "stopped")     configure({fetchProposal})          reset() (tests)
// ---------------------------------------------------------------------------------------------------------------
export function createActionPoller(options = {}) {
  let fetchProposal = typeof options.fetchProposal === "function" ? options.fetchProposal : null;
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || (t => clearTimeout(t));
  const now = options.now || (() => Date.now());
  const maxMs = options.maxMs ?? POLL_MAX_MS;
  const maxEntries = options.maxEntries ?? 100;
  const entries = new Map();
  const anyListeners = new Set();

  const safeCall = (fn, value) => { try { fn(value); } catch (e) { setTimeout(() => { throw e; }, 0); } };

  function snapshot(e) {
    return { id: e.id, proposal: e.proposal, polling: e.timer !== null || e.inFlight, stopReason: e.stopReason,
      failures: e.failures, offlineSince: e.offlineSince, startedAt: e.startedAt };
  }

  function emit(e) {
    const s = snapshot(e);
    for (const l of [...e.listeners]) safeCall(l.fn, s);
    for (const fn of [...anyListeners]) safeCall(fn, s);
  }

  function ensure(id) {
    let e = entries.get(id);
    if (!e) {
      e = { id, proposal: null, listeners: new Set(), timer: null, inFlight: false, gen: 0, stopReason: null,
        failures: 0, offlineSince: null, startedAt: null };
      entries.set(id, e);
      prune(id);
    }
    return e;
  }

  // Forget the oldest idle entries beyond maxEntries (never `keep`, never one that is watched or polling).
  function prune(keep) {
    if (entries.size <= maxEntries) return;
    for (const [id, e] of entries) {
      if (entries.size <= maxEntries) break;
      if (id !== keep && !e.listeners.size && e.timer === null && !e.inFlight) entries.delete(id);
    }
  }

  function clear(e) {
    if (e.timer !== null) { clearTimer(e.timer); e.timer = null; }
  }

  const visible = e => [...e.listeners].some(l => l.visible);

  function schedule(e) {
    clear(e);
    if (e.inFlight || e.stopReason) return;
    const status = e.proposal?.status;
    if (status !== "executing") {
      if (isFinalStatus(status)) e.stopReason = "final";
      e.startedAt = null;
      return;
    }
    if (e.startedAt === null) e.startedAt = now();
    const delay = nextPollDelay({ status, startedAt: e.startedAt, now: now(), failures: e.failures, visible: visible(e), maxMs });
    if (delay === null) { e.stopReason = "timeout"; return; }
    e.timer = setTimer(() => { e.timer = null; poll(e); }, delay);
  }

  async function poll(e) {
    if (!fetchProposal || e.inFlight || e.stopReason || entries.get(e.id) !== e) return;
    const gen = e.gen;
    e.inFlight = true;
    let fresh;
    let error = null;
    try { fresh = await fetchProposal(e.id); } catch (err) { error = err || new Error("poll failed"); }
    e.inFlight = false;
    if (gen !== e.gen || entries.get(e.id) !== e) return;   // stopped or forgotten while the request ran
    if (error) {
      const kind = classifyPollError(error);
      if (kind === "retry") {
        e.failures += 1;
        if (e.offlineSince === null) e.offlineSince = now();
      } else {
        e.stopReason = kind;
      }
    } else {
      e.failures = 0;
      e.offlineSince = null;
      if (acceptPolled(e.proposal, fresh) && !sameProposal(e.proposal, fresh)) e.proposal = fresh;
    }
    schedule(e);
    emit(e);
  }

  function update(proposal) {
    const id = proposalId(proposal);
    if (!id) return false;
    const e = ensure(id);
    if (!acceptUpdate(e.proposal, proposal)) return false;
    if (e.proposal && proposalSignature(e.proposal) === proposalSignature(proposal)) return false;
    e.proposal = proposal;   // acceptUpdate never lets a final status go back, so "final" stays final
    schedule(e);
    emit(e);
    return true;
  }

  function watch(proposal, fn, { visible: shown = true } = {}) {
    const id = proposalId(proposal);
    if (!id || typeof fn !== "function") return () => {};
    const e = ensure(id);
    const listener = { fn, visible: shown };
    e.listeners.add(listener);
    // Someone is looking again: a poller stopped for a non-final reason gets another chance.
    if (e.stopReason && e.stopReason !== "final") { e.stopReason = null; e.failures = 0; e.offlineSince = null; e.startedAt = null; }
    if (!update(proposal)) {   // update() already told every listener, this one included
      schedule(e);
      safeCall(fn, snapshot(e));
    }
    return () => {
      if (!e.listeners.delete(listener)) return;
      if (entries.get(id) === e && e.timer !== null) schedule(e);   // switch to the slower interval
      prune();
    };
  }

  function refresh(id) {
    const e = entries.get(String(id));
    if (!e || isFinalStatus(e.proposal?.status) || e.inFlight) return;
    if (e.stopReason) { e.stopReason = null; e.startedAt = null; }
    if (e.proposal?.status !== "executing") return;
    clear(e);
    if (e.startedAt === null) e.startedAt = now();
    poll(e);
    emit(e);
  }

  function stopAll(reason = "stopped") {
    for (const e of entries.values()) {
      clear(e);
      e.gen += 1;
      e.inFlight = false;
      if (e.proposal?.status === "executing") { e.stopReason = reason; emit(e); }
    }
  }

  return {
    configure({ fetchProposal: f } = {}) { if (typeof f === "function") fetchProposal = f; },
    watch,
    update,
    refresh,
    stopAll,
    get(id) { const e = entries.get(String(id)); return e ? snapshot(e) : null; },
    onAny(fn) { if (typeof fn !== "function") return () => {}; anyListeners.add(fn); return () => anyListeners.delete(fn); },
    reset() { for (const e of entries.values()) { clear(e); e.gen += 1; } entries.clear(); anyListeners.clear(); },
  };
}

// The app-wide instance. ActionProgress.jsx configures its fetch function; AssistantPanel may subscribe with onAny.
export const actionPoller = createActionPoller();

// ---------------------------------------------------------------------------------------------------------------
// Recent actions list
// ---------------------------------------------------------------------------------------------------------------
export const HISTORY_LIMIT = 20;

// GET /proposals answers {items: [...]}; a bare list is accepted too. Newest first, unique ids, raw objects kept.
export function normalizeHistory(raw, limit = HISTORY_LIMIT) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.proposals) ? raw.proposals : [];
  const seen = new Set();
  return list
    .filter(x => { const id = proposalId(x); if (!id || seen.has(id)) return false; seen.add(id); return true; })
    .map((x, i) => [x, i])
    .sort((a, b) => timeOf(b[0].created_at) - timeOf(a[0].created_at) || a[1] - b[1])
    .map(([x]) => x)
    .slice(0, limit);
}

// The newer of two copies of the same proposal (keeps `current` when `incoming` is older).
export function pickNewer(current, incoming) {
  return acceptUpdate(current, incoming) && !sameProposal(current, incoming) ? incoming : current || incoming;
}

// Fresh list items, each replaced by a newer copy the poller already holds (a list read before a poll answer).
export function mergeHistory(fresh, newerCopy = () => null) {
  return fresh.map(item => {
    const cached = newerCopy(proposalId(item));
    return cached && !acceptUpdate(cached, item) ? cached : item;
  });
}

// Display data for one row: {id, title, status, chip, by, createdAt, progress ("9/9 PDU"), running}.
export function historyRow(p) {
  const status = proposalStatus(p);
  const prog = progressInfo(p);
  return { id: proposalId(p), title: proposalTitle(p), status, chip: statusChip(status), by: str(obj(p)?.created_by) || "לא ידוע",
    createdAt: str(obj(p)?.created_at) || null, running: status === "executing",
    progress: ["executing", "succeeded", "partial", "failed", "interrupted"].includes(status) ? prog.short : "" };
}

export const HISTORY_TEXT = {
  heading: "פעולות אחרונות",
  refresh: "רענון",
  loading: "טוען פעולות…",
  empty: "עדיין לא בוצעו פעולות מהעוזר.",
  retry: "נסה שוב",
  pending: "ההצעה ממתינה לאישור. אפשר לאשר או לבטל אותה בכרטיס שבשיחה.",
  ready: "הצעה לפתיחת KVM, ללא שינוי בחשמל. פותחים אותה מהכרטיס שבשיחה.",
};
