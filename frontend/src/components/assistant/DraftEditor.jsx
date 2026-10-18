import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccounts } from "../../accounts.jsx";
import { errorText, formatAsOf, normalizeDraft, PRIORITIES, priorityLabel, saveWorkItem } from "../../api/assistant.js";

// Editable work-item draft from an assistant recommendation. Three clearly labelled states:
// "הצעה" (as the assistant proposed it) -> "טיוטה" (edited here, not stored) -> "נשמרה" (after the server's 201).
// Saving always goes through a final confirmation that shows exactly what will be stored; nothing is saved
// automatically. onSaved(item) is called once, when the user closes the dialog after a successful save;
// onCancel() when it is closed without saving.

// Same caps as the work-item API (SEC-AI-14); over-long text is cut here so the confirmation shows what is stored.
export const LIMITS = { title: 200, description: 4000, rationale: 2000, step: 500, steps: 20, refs: 20, refId: 120, refLabel: 200 };
export const KIND_LABELS = {
  server: "שרת", pdu: "PDU", kvm: "KVM", rack: "ארון", item: "פריט", incident: "תקלה", maintenance: "תחזוקה", work_item: "משימה",
};
export const PRIORITY_STYLES = {
  high: "border-rose-800 bg-rose-950/40 text-rose-300",
  medium: "border-amber-800 bg-amber-950/30 text-amber-300",
  low: "border-zinc-700 bg-zinc-900 text-zinc-300",
};
export const WORK_ITEMS_CHANGED_EVENT = "dcim-assistant-work-items-changed";
const FORBIDDEN_TEXT = "נדרשת הרשאת Operator כדי לשמור";

const STATES = {
  suggestion: { label: "הצעה", note: "הצעה מהעוזר. עדיין לא נשמרה; אפשר לערוך כל שדה לפני השמירה.", cls: "border-zinc-600 bg-zinc-900 text-zinc-200" },
  draft: { label: "טיוטה", note: "טיוטה שנערכה כאן. עדיין לא נשמרה.", cls: "border-amber-700 bg-amber-950/30 text-amber-300" },
  saved: { label: "נשמרה", note: "המשימה נשמרה במערכת ותופיע ברשימת המשימות של הצוות.", cls: "border-nv-400 bg-nv-400/10 text-nv-300" },
};

const FIELD = "w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-nv-400/60 disabled:opacity-60";
const LABEL = "block text-xs text-zinc-400 mb-1";
const SMALL_BUTTON = "w-7 h-7 shrink-0 inline-flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent";
const PRIMARY = "text-sm px-3.5 py-1.5 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium disabled:opacity-50";
const SECONDARY = "text-sm px-3 py-1.5 rounded hover:bg-zinc-800 text-zinc-300 disabled:opacity-40";

// Characters the work-item API rejects (C0/C1 control characters except tab, newline and carriage return, and
// bidi embedding/override/isolate marks, which could make a team-visible item read differently from what it
// says). They are removed here so a save never fails on them; single-line fields also fold tabs and newlines.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const clean = text => String(text ?? "").replace(CONTROL, "");
const oneLine = text => clean(text).replace(/\s+/g, " ").trim();

let stepSeq = 0;
const newStep = (text = "") => ({ key: `step-${++stepSeq}`, text });

function formFromDraft(draft) {
  const d = normalizeDraft(draft);
  return {
    title: oneLine(d.title).slice(0, LIMITS.title),
    description: clean(d.description).slice(0, LIMITS.description),
    priority: d.priority,
    rationale: clean(d.rationale).slice(0, LIMITS.rationale),
    steps: d.steps.slice(0, LIMITS.steps).map(s => newStep(oneLine(s).slice(0, LIMITS.step))),
    // Read-only: refs whose id the API would reject are left out rather than altered.
    entity_refs: d.entity_refs
      .map(r => ({ kind: r.kind, id: oneLine(r.id), label: oneLine(r.label).slice(0, LIMITS.refLabel) }))
      .filter(r => KIND_LABELS[r.kind] && r.id && r.id.length <= LIMITS.refId)
      .slice(0, LIMITS.refs),
  };
}

// Exactly what POST /api/assistant/work-items receives as `draft`: the same cleaning the server applies (control
// characters removed, title and steps on one line, text trimmed, empty steps dropped), so the confirmation step
// shows what will be stored.
export function draftPayload(form) {
  return {
    title: oneLine(form.title),
    description: clean(form.description).trim(),
    entity_refs: form.entity_refs.map(r => ({ kind: r.kind, id: r.id, label: r.label })),
    priority: PRIORITIES.includes(form.priority) ? form.priority : "medium",
    rationale: clean(form.rationale).trim(),
    steps: form.steps.map(s => oneLine(s.text)).filter(Boolean),
  };
}

export function PriorityBadge({ priority }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] ${PRIORITY_STYLES[priority] || PRIORITY_STYLES.low}`}>
      עדיפות {priorityLabel(priority)}
    </span>
  );
}

// Equipment named by the assistant or a saved item: plain text only, never links (SEC-AI-7).
export function EntityChips({ refs }) {
  if (!refs?.length) return <p className="text-xs text-zinc-500">אין ציוד מקושר.</p>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="ציוד קשור">
      {refs.map((ref, i) => (
        <li key={`${ref.kind}:${ref.id}:${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-800 bg-zinc-900 text-xs">
          <span className="text-zinc-500">{KIND_LABELS[ref.kind] || ref.kind}</span>
          <bdi className="font-mono text-zinc-200">{ref.label || ref.id}</bdi>
        </li>
      ))}
    </ul>
  );
}

function Summary({ payload }) {
  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="text-xs text-zinc-500">כותרת</dt>
        <dd dir="auto" className="text-zinc-100 font-medium break-words">{payload.title}</dd>
      </div>
      <div>
        <dt className="text-xs text-zinc-500">עדיפות</dt>
        <dd className="mt-0.5"><PriorityBadge priority={payload.priority} /></dd>
      </div>
      <div>
        <dt className="text-xs text-zinc-500">תיאור</dt>
        <dd dir="auto" className="text-zinc-300 whitespace-pre-wrap break-words">{payload.description || <span className="text-zinc-500">(ללא תיאור)</span>}</dd>
      </div>
      <div>
        <dt className="text-xs text-zinc-500">שלבים מוצעים</dt>
        <dd>
          {payload.steps.length ? (
            <ol className="list-decimal pr-5 space-y-0.5 text-zinc-300">
              {payload.steps.map((s, i) => <li key={i} dir="auto" className="break-words">{s}</li>)}
            </ol>
          ) : <span className="text-zinc-500">(ללא שלבים)</span>}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-zinc-500 mb-1">ציוד קשור</dt>
        <dd><EntityChips refs={payload.entity_refs} /></dd>
      </div>
      <div>
        <dt className="text-xs text-zinc-500">נימוק</dt>
        <dd dir="auto" className="text-zinc-300 whitespace-pre-wrap break-words">{payload.rationale || <span className="text-zinc-500">(ללא נימוק)</span>}</dd>
      </div>
    </dl>
  );
}

export default function DraftEditor({ draft, conversationId, onSaved, onCancel }) {
  const { canOperate } = useAccounts();
  const [form, setForm] = useState(() => formFromDraft(draft));
  const [initialJson] = useState(() => JSON.stringify(draftPayload(form)));
  const [phase, setPhase] = useState("edit");          // edit | confirm | saved
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saved, setSaved] = useState(null);
  const [focusTarget, setFocusTarget] = useState(null); // {key, part} for the steps editor
  const panelRef = useRef(null);
  const titleRef = useRef(null);
  const confirmHeadingRef = useRef(null);
  const closeSavedRef = useRef(null);
  const keepEditingRef = useRef(null);
  const addStepRef = useRef(null);
  const stepRefs = useRef({});
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const keyHandler = useRef(null);
  // Read during the first render, before any effect moves focus into the dialog.
  const openerRef = useRef(typeof document !== "undefined" ? document.activeElement : null);
  const baseId = useId();
  const ids = {
    heading: `${baseId}-heading`, state: `${baseId}-state`, title: `${baseId}-title`, description: `${baseId}-description`,
    priority: `${baseId}-priority`, rationale: `${baseId}-rationale`, titleError: `${baseId}-title-error`, error: `${baseId}-error`,
  };

  const payload = draftPayload(form);
  const dirty = JSON.stringify(payload) !== initialJson;
  const state = phase === "saved" ? STATES.saved : dirty ? STATES.draft : STATES.suggestion;

  function update(field, value) {
    setForm(f => ({ ...f, [field]: value }));
    if (field === "title" && value.trim()) setFieldError("");
  }

  // ---- steps -----------------------------------------------------------------------------------------------
  function setStepText(key, text) {
    setForm(f => ({ ...f, steps: f.steps.map(s => (s.key === key ? { ...s, text } : s)) }));
  }
  function addStep(afterIndex) {
    if (form.steps.length >= LIMITS.steps) return;
    const step = newStep();
    setForm(f => {
      const steps = [...f.steps];
      steps.splice(afterIndex === undefined ? steps.length : afterIndex + 1, 0, step);
      return { ...f, steps };
    });
    setFocusTarget({ key: step.key, part: "input" });
  }
  function moveStep(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= form.steps.length) return;
    const key = form.steps[index].key;
    setForm(f => {
      const steps = [...f.steps];
      const [moved] = steps.splice(index, 1);
      steps.splice(to, 0, moved);
      return { ...f, steps };
    });
    const edge = to === 0 || to === form.steps.length - 1;
    setFocusTarget({ key, part: edge ? "input" : delta < 0 ? "up" : "down" });
  }
  function removeStep(index) {
    const next = form.steps[index + 1] || form.steps[index - 1];
    setForm(f => ({ ...f, steps: f.steps.filter((_, i) => i !== index) }));
    setFocusTarget(next ? { key: next.key, part: "input" } : { key: "add", part: "add" });
  }

  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.part === "add") addStepRef.current?.focus();
    else stepRefs.current[`${focusTarget.key}:${focusTarget.part}`]?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  // ---- phases ----------------------------------------------------------------------------------------------
  function toConfirm(e) {
    e?.preventDefault();
    if (busyRef.current || !canOperate) return;
    if (!payload.title) {
      setFieldError("יש למלא כותרת למשימה.");
      titleRef.current?.focus();
      return;
    }
    setError("");
    setConfirmDiscard(false);
    setPhase("confirm");
  }

  function backToEdit() {
    if (busyRef.current) return;
    setError("");
    setPhase("edit");
  }

  async function save() {
    if (busyRef.current || phase !== "confirm") return;
    const body = draftPayload(form);
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const item = await saveWorkItem(body, conversationId || undefined);
      if (!mounted.current) return;
      setSaved(item && typeof item === "object" ? item : { ...body, status: "saved" });
      setConfirmDiscard(false);
      setPhase("saved");
      try { window.dispatchEvent(new CustomEvent(WORK_ITEMS_CHANGED_EVENT, { detail: { id: item?.id ?? null } })); } catch { /* no listeners */ }
    } catch (err) {
      if (!mounted.current) return;
      setError(err?.status === 403 ? FORBIDDEN_TEXT : errorText(err));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function requestClose() {
    if (busyRef.current) return;
    if (phase === "saved") { onSaved?.(saved); return; }
    if (dirty && !confirmDiscard) { setConfirmDiscard(true); return; }
    onCancel?.();
  }

  // Focus follows the step of the flow.
  useEffect(() => {
    if (phase === "edit") titleRef.current?.focus();
    else if (phase === "confirm") confirmHeadingRef.current?.focus();
    else if (phase === "saved") closeSavedRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
  }, [confirmDiscard]);

  // Capture phase on the document: Escape and Tab are handled here before the assistant panel or page-level
  // Escape handlers see them, also when a click on plain text has moved focus to <body>.
  keyHandler.current = e => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (busyRef.current) return;
      if (confirmDiscard) { setConfirmDiscard(false); return; }
      if (phase === "confirm") { backToEdit(); return; }
      requestClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll("button, input, textarea, select, [href], [tabindex]:not([tabindex='-1'])")]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!panelRef.current.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  useEffect(() => {
    mounted.current = true;
    const opener = openerRef.current;
    const listener = e => keyHandler.current(e);
    document.addEventListener("keydown", listener, true);
    return () => {
      mounted.current = false;
      document.removeEventListener("keydown", listener, true);
      if (opener instanceof HTMLElement && opener !== document.body && document.contains(opener)) opener.focus();
    };
  }, []);

  const stepRef = (key, part) => el => { if (el) stepRefs.current[`${key}:${part}`] = el; else delete stepRefs.current[`${key}:${part}`]; };

  const dialog = (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) requestClose(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={ids.heading} aria-describedby={ids.state} dir="rtl" lang="he"
        className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-lg max-h-[calc(100vh-24px)] flex flex-col text-right">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center gap-2">
          <h2 id={ids.heading} className="font-medium text-zinc-100">טיוטת עבודה</h2>
          <span className={`text-[11px] px-1.5 py-0.5 rounded border ${state.cls}`}>{state.label}</span>
          <button type="button" onClick={requestClose} disabled={busy} aria-label="סגור"
            className="mr-auto text-zinc-400 hover:text-zinc-100 w-7 h-7 rounded hover:bg-zinc-800 disabled:opacity-40">✕</button>
        </div>
        <p id={ids.state} role="status" className="px-5 pt-3 text-xs text-zinc-400">{state.note}</p>

        {phase === "saved" ? (
          <>
            <div className="p-5 space-y-3 text-sm overflow-y-auto">
              <div dir="auto" className="font-medium text-zinc-100 break-words">{saved?.title || payload.title}</div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <PriorityBadge priority={saved?.priority || payload.priority} />
                {saved?.created_by && <span>נוצרה על ידי <bdi className="text-zinc-300">{saved.created_by}</bdi></span>}
                {saved?.created_at && <span>{formatAsOf(saved.created_at)}</span>}
              </div>
            </div>
            <div className="px-5 py-3 border-t border-zinc-800 flex justify-start gap-2">
              <button type="button" ref={closeSavedRef} onClick={requestClose} className={PRIMARY}>סגור</button>
            </div>
          </>
        ) : phase === "confirm" ? (
          <>
            <div className="p-5 space-y-4 overflow-y-auto">
              <h3 ref={confirmHeadingRef} tabIndex={-1} className="text-base font-medium text-zinc-100 focus:outline-none">לשמור משימה חדשה?</h3>
              <p className="text-xs text-zinc-400">זה בדיוק מה שיישמר. המשימה תהיה גלויה לכל הצוות. העוזר אינו מפעיל ציוד ואינו משנה תשתיות.</p>
              <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3"><Summary payload={payload} /></div>
              {error && <p id={ids.error} role="alert" className="text-sm text-rose-300">{error}</p>}
            </div>
            {confirmDiscard && <DiscardBar keepRef={keepEditingRef} onKeep={() => setConfirmDiscard(false)} onDiscard={() => onCancel?.()} />}
            <div className="px-5 py-3 border-t border-zinc-800 flex justify-start gap-2">
              <button type="button" onClick={save} disabled={busy} aria-describedby={error ? ids.error : undefined} className={PRIMARY}>
                {busy ? "שומר…" : "שמור משימה"}
              </button>
              <button type="button" onClick={backToEdit} disabled={busy} className={SECONDARY}>חזור לעריכה</button>
            </div>
          </>
        ) : (
          <form onSubmit={toConfirm} noValidate className="flex flex-col min-h-0">
            <div className="p-5 space-y-4 overflow-y-auto">
              {!canOperate && (
                <p role="note" className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-300">
                  {FORBIDDEN_TEXT}. אפשר לערוך את הטיוטה ולהעביר אותה למי שמורשה לשמור.
                </p>
              )}
              <div>
                <label htmlFor={ids.title} className={LABEL}>כותרת <span className="text-rose-400" aria-hidden="true">*</span></label>
                <input id={ids.title} ref={titleRef} value={form.title} onChange={e => update("title", e.target.value)} required
                  maxLength={LIMITS.title} dir="auto" aria-invalid={fieldError ? "true" : undefined}
                  aria-describedby={fieldError ? ids.titleError : undefined} className={FIELD} />
                {fieldError && <p id={ids.titleError} role="alert" className="mt-1 text-xs text-rose-300">{fieldError}</p>}
              </div>
              <div>
                <label htmlFor={ids.priority} className={LABEL}>עדיפות</label>
                <select id={ids.priority} value={form.priority} onChange={e => update("priority", e.target.value)} className={FIELD}>
                  {PRIORITIES.map(p => <option key={p} value={p}>{priorityLabel(p)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={ids.description} className={LABEL}>תיאור</label>
                <textarea id={ids.description} value={form.description} onChange={e => update("description", e.target.value)}
                  rows={4} maxLength={LIMITS.description} dir="auto" className={`${FIELD} resize-y`} />
              </div>
              <fieldset>
                <legend className={LABEL}>שלבים מוצעים</legend>
                {form.steps.length > 0 && (
                  <ol className="space-y-1.5 mb-2">
                    {form.steps.map((step, i) => (
                      <li key={step.key} className="flex items-center gap-1">
                        <span className="w-5 shrink-0 text-xs font-mono text-zinc-500 text-center" aria-hidden="true">{i + 1}.</span>
                        <input ref={stepRef(step.key, "input")} value={step.text} onChange={e => setStepText(step.key, e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addStep(i); } }}
                          aria-label={`שלב ${i + 1}`} maxLength={LIMITS.step} dir="auto" className={`${FIELD} py-1.5`} />
                        <button type="button" ref={stepRef(step.key, "up")} onClick={() => moveStep(i, -1)} disabled={i === 0}
                          aria-label={`העבר את שלב ${i + 1} למעלה`} title="למעלה" className={SMALL_BUTTON}>↑</button>
                        <button type="button" ref={stepRef(step.key, "down")} onClick={() => moveStep(i, 1)} disabled={i === form.steps.length - 1}
                          aria-label={`העבר את שלב ${i + 1} למטה`} title="למטה" className={SMALL_BUTTON}>↓</button>
                        <button type="button" onClick={() => removeStep(i)} aria-label={`מחק את שלב ${i + 1}`} title="מחק"
                          className={`${SMALL_BUTTON} hover:text-rose-300`}>✕</button>
                      </li>
                    ))}
                  </ol>
                )}
                <button type="button" ref={addStepRef} onClick={() => addStep()} disabled={form.steps.length >= LIMITS.steps}
                  className="text-xs px-2.5 py-1 rounded border border-zinc-800 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
                  + הוסף שלב
                </button>
                {form.steps.length >= LIMITS.steps && <span className="mr-2 text-xs text-zinc-500">עד {LIMITS.steps} שלבים.</span>}
              </fieldset>
              <div>
                <div className={LABEL}>ציוד קשור (מנתוני המערכת, לא ניתן לעריכה)</div>
                <EntityChips refs={form.entity_refs} />
              </div>
              <div>
                <label htmlFor={ids.rationale} className={LABEL}>נימוק</label>
                <textarea id={ids.rationale} value={form.rationale} onChange={e => update("rationale", e.target.value)}
                  rows={3} maxLength={LIMITS.rationale} dir="auto" className={`${FIELD} resize-y`} />
              </div>
            </div>
            {confirmDiscard && <DiscardBar keepRef={keepEditingRef} onKeep={() => setConfirmDiscard(false)} onDiscard={() => onCancel?.()} />}
            <div className="px-5 py-3 border-t border-zinc-800 flex justify-start gap-2">
              <button type="submit" disabled={!canOperate} className={PRIMARY}>המשך לשמירה…</button>
              <button type="button" onClick={requestClose} className={SECONDARY}>ביטול</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

function DiscardBar({ keepRef, onKeep, onDiscard }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="mx-5 mb-3 rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-300 flex flex-wrap items-center gap-2">
      <span id={id} className="flex-1 min-w-[10rem]">לסגור בלי לשמור? השינויים בטיוטה יאבדו.</span>
      <button type="button" ref={keepRef} onClick={onKeep} className="px-2.5 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800">המשך לערוך</button>
      <button type="button" onClick={onDiscard} className="px-2.5 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white">סגור בלי לשמור</button>
    </div>
  );
}
