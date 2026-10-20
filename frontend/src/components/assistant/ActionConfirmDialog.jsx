import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  actionErrorInfo, actionTone, clientWarnings, confirmState, countdownLabel, executeProposal, impactSentence, isWide,
  normalizeProposal, passwordLabelHe, remainingSeconds, verbLabel, formatCountdown, NOTHING_DONE,
} from "../../api/assistantActions.js";
import { Bidi } from "./AnswerView.jsx";
import ActionImpact from "./ActionImpact.jsx";

// Final confirmation of one proposal: the server's impact, the typed phrase (rack/lab/batch), and the user's own
// password. Mirrors MaintenanceDialog: the password input is uncontrolled, cleared before the request and on every
// error or close, and never kept in React state. Keyboard follows DraftEditor: a capture-phase document listener
// handles Escape and the Tab trap, so the assistant panel underneath never sees them. The destructive button is
// never focused by default and stays aria-disabled (still focusable) until everything is filled in.
//
// props: proposal (normalized), passwordMode ("account" | "shared" | ...), blockedText ("" or why actions cannot run),
//   onClose(), onExecuted(proposal) after a 2xx, onRefresh() -> Promise<proposal | null> (re-reads the proposal and
//   updates the card; resolves null when it could not be read).

const FOCUSABLE = "button, input, textarea, select, [href], [tabindex]:not([tabindex='-1'])";
const TERMINAL = ["expired", "not_found", "drift", "not_pending", "disabled", "password_mode", "forbidden", "protected", "protected_unset"];

export default function ActionConfirmDialog({ proposal, passwordMode, blockedText = "", onClose, onExecuted, onRefresh }) {
  const baseId = useId();
  const ids = { heading: `${baseId}-h`, summary: `${baseId}-s`, error: `${baseId}-e`, hint: `${baseId}-hint`, phrase: `${baseId}-ph`, password: `${baseId}-pw`, live: `${baseId}-live` };
  const [phraseValue, setPhraseValue] = useState("");
  const [passwordFilled, setPasswordFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);            // actionErrorInfo(...) plus {unknown: bool}
  const [terminal, setTerminal] = useState(false);     // the proposal can no longer be confirmed from here
  const [throttleUntil, setThrottleUntil] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef(null);
  const phraseRef = useRef(null);
  const passwordRef = useRef(null);
  const closeRef = useRef(null);
  const actionRef = useRef(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const warned = useRef(false);
  const keyHandler = useRef(null);

  const wide = isWide(proposal);
  const tone = actionTone(proposal);
  const remaining = remainingSeconds(proposal, now);
  const expired = remaining !== null && remaining <= 0;
  const countdown = countdownLabel(remaining);
  const throttleLeft = Math.max(0, Math.ceil((throttleUntil - now) / 1000));
  const state = confirmState(proposal, { phraseValue, passwordFilled });
  const blocked = !!blockedText || terminal || expired || throttleLeft > 0 || !!error?.unknown || !proposal.can_execute;
  const ready = state.ready && !blocked;
  const warnings = [...proposal.impact.warnings_he.map(text => ({ text, server: true })), ...clientWarnings(proposal).map(text => ({ text }))];

  function clearPassword() {
    if (passwordRef.current) passwordRef.current.value = "";
    setPasswordFilled(false);
  }

  function close() {
    if (busyRef.current) return;
    clearPassword();
    onClose?.();
  }

  // One tick per second for the countdown and the throttle wait.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (remaining !== null && remaining <= 30 && remaining > 0 && !warned.current) {
      warned.current = true;
      setAnnounce("ההצעה תפוג בעוד 30 שניות");
    }
    if (expired && !terminal && !busyRef.current) {
      setTerminal(true);
      setError({ ...actionErrorInfo({ status: 410, code: "expired" }, { proposal }), unknown: false });
    }
  }, [remaining, expired]);

  // Capture phase on the document: Escape and Tab are handled before the panel or the page see them.
  keyHandler.current = e => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();   // inert while the request is in flight
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!panelRef.current.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  useEffect(() => {
    mounted.current = true;
    const listener = e => keyHandler.current(e);
    document.addEventListener("keydown", listener, true);
    // Initial focus: the phrase, else the password; never the action button.
    const first = blockedText || !proposal.can_execute ? closeRef.current : proposal.phrase ? phraseRef.current : passwordRef.current;
    requestAnimationFrame(() => (first || closeRef.current)?.focus());
    return () => {
      mounted.current = false;
      document.removeEventListener("keydown", listener, true);
      if (passwordRef.current) passwordRef.current.value = "";
    };
  }, []);

  function focusFirstMissing() {
    if (state.missing[0] === "phrase") phraseRef.current?.focus();
    else if (state.missing[0] === "password") passwordRef.current?.focus();
  }

  // For rack/lab/batch only the button may start the action: Enter in a field does nothing.
  function onFieldKey(e) {
    if (e.key === "Enter" && wide) e.preventDefault();
  }

  async function check() {
    if (checking) return;
    setChecking(true);
    try {
      const fresh = await onRefresh?.();
      if (!mounted.current) return;
      if (fresh && fresh.status !== "pending") { onClose?.(); return; }
      if (fresh) setError({ text: `ההצעה עדיין ממתינה לאישור בשרת — ${NOTHING_DONE} אפשר לאשר שוב.`, details: [], code: "pending", unknown: false });
      else setError({ text: "לא ידוע אם הפעולה התחילה. אל תאשר שוב — לחץ \"בדוק מצב\".", details: [], code: "unknown", unknown: true });
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  async function submit(e) {
    e?.preventDefault();
    // An aria-disabled submit button does not stop implicit submission, so every guard lives here.
    if (busyRef.current) return;
    if (!ready) { focusFirstMissing(); return; }
    const password = passwordRef.current?.value || "";
    clearPassword();
    if (!password) { passwordRef.current?.focus(); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await executeProposal(proposal.id, { password, phrase: proposal.phrase ? phraseValue : undefined });
      const next = normalizeProposal(res);
      busyRef.current = false;
      if (next) onExecuted?.(next);
      else await onRefresh?.();
      if (mounted.current) onClose?.();
      return;
    } catch (err) {
      busyRef.current = false;
      if (!mounted.current) return;
      const info = actionErrorInfo(err, { proposal, phase: "execute" });
      if (info.code === "not_pending") {
        // Already confirmed elsewhere (or a lost response of our own): show the real status in the card.
        await onRefresh?.();
        if (mounted.current) onClose?.();
        return;
      }
      setError({ ...info, unknown: info.outcomeUnknown });
      if (info.code === "throttled") setThrottleUntil(Date.now() + (info.retryAfter || 300) * 1000);
      if (TERMINAL.includes(info.code)) { setTerminal(true); onRefresh?.(); }
      if (info.code === "password") requestAnimationFrame(() => passwordRef.current?.focus());
      else if (info.code === "phrase") requestAnimationFrame(() => phraseRef.current?.focus());
      if (info.outcomeUnknown) check();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const headerTone = tone === "safe" ? "border-t-4 border-nv-400 bg-zinc-900" : wide ? "border-t-4 border-rose-600 bg-rose-950/60" : "border-t-4 border-amber-600 bg-amber-950/30";
  const titleTone = tone === "safe" ? "text-nv-300" : wide ? "text-rose-200" : "text-amber-200";
  const actionClass = !ready || busy
    ? "bg-zinc-800 text-zinc-400 cursor-not-allowed"
    : tone === "safe" ? "bg-nv-400 text-zinc-950 hover:bg-nv-300" : "bg-rose-700 text-white hover:bg-rose-600";
  const hintShown = !ready && !busy && !blocked && !!state.hint;
  const describedBy = error ? ids.error : hintShown ? ids.hint : undefined;

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 max-[580px]:items-stretch max-[580px]:p-0"
      onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby={ids.heading} aria-describedby={ids.summary} dir="rtl" lang="he"
        className="flex max-h-[calc(100dvh-24px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-200 text-right max-[580px]:h-[100dvh] max-[580px]:max-h-none max-[580px]:rounded-none max-[580px]:border-0">
        <header className={`flex items-start gap-2 border-b border-zinc-800 px-4 py-3 ${headerTone}`}>
          <h2 id={ids.heading} className={`min-w-0 flex-1 text-sm font-bold ${titleTone}`}>
            {wide && tone !== "safe" && <span aria-hidden="true">⚠ </span>}אישור: <Bidi text={proposal.title_he} />
          </h2>
          {countdown && (
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${countdown.tone === "ok" ? "border-zinc-700 text-zinc-300" : "border-amber-700 text-amber-200"}`}>
              {countdown.text}
            </span>
          )}
          <button ref={closeRef} type="button" onClick={close} disabled={busy} aria-label="סגור בלי לבצע"
            className="h-7 w-7 shrink-0 rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40">✕</button>
        </header>

        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
            <p id={ids.summary} className="text-zinc-100">{impactSentence(proposal)}</p>
            <ActionImpact proposal={proposal} />

            {warnings.length > 0 && (
              <ul className="space-y-1 rounded border border-amber-800/70 bg-amber-950/20 p-2 text-xs">
                {warnings.map((w, i) => <li key={i} className={w.server ? "text-amber-200" : "text-zinc-300"}><Bidi text={w.text} /></li>)}
              </ul>
            )}
            {proposal.background && <p className="text-xs text-zinc-400">הפעולה רצה ברקע, PDU אחרי PDU. אי אפשר לעצור באמצע; בסיום אפשר להחזיר חשמל לאותם שקעים.</p>}

            {blockedText && <p role="alert" className="rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">{blockedText}</p>}

            {proposal.phrase && (
              <div className="space-y-1.5">
                <label htmlFor={ids.phrase} className="block text-xs text-zinc-300">כדי לאשר, הקלד בדיוק:</label>
                <div dir="ltr" className="select-all rounded border border-dashed border-zinc-500 bg-zinc-950 px-3 py-1.5 text-center font-mono text-base font-bold tracking-wide text-zinc-50">
                  <bdi>{proposal.phrase}</bdi>
                </div>
                <input id={ids.phrase} ref={phraseRef} value={phraseValue} onChange={e => setPhraseValue(e.target.value)} onKeyDown={onFieldKey}
                  dir="ltr" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} maxLength={100}
                  disabled={busy} aria-invalid={error?.code === "phrase" ? "true" : undefined}
                  aria-describedby={error?.code === "phrase" ? ids.error : undefined}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-base text-zinc-100 focus:border-nv-400/60 focus:outline-none disabled:opacity-60" />
                <p aria-live="polite" className="min-h-4 text-xs text-emerald-300">{phraseValue && !state.missing.includes("phrase") ? "הצירוף תואם" : ""}</p>
              </div>
            )}

            {proposal.needs_password && (
              <div className="space-y-1">
                <label htmlFor={ids.password} className="block text-xs text-zinc-300">{passwordLabelHe(passwordMode)}</label>
                <input id={ids.password} ref={passwordRef} type="password" name="action-password" autoComplete="current-password" maxLength={256}
                  onInput={e => setPasswordFilled(!!e.currentTarget.value)} onKeyDown={onFieldKey} disabled={busy}
                  aria-invalid={error?.code === "password" ? "true" : undefined}
                  aria-describedby={error?.code === "password" ? ids.error : undefined}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-nv-400/60 focus:outline-none disabled:opacity-60" />
              </div>
            )}

            {error && (
              <div id={ids.error} role="alert" className="space-y-1 rounded border border-rose-900 bg-rose-950/30 p-2 text-xs text-rose-200">
                <p>{error.code === "throttled" && throttleLeft > 0
                  ? `יותר מדי ניסיונות סיסמה שגויים. אפשר לנסות שוב בעוד ${formatCountdown(throttleLeft)}. ${NOTHING_DONE}`
                  : error.text}</p>
                {error.details?.length > 0 && <ul className="list-disc ps-5 text-rose-100/90">{error.details.map((d, i) => <li key={i}><Bidi text={d} /></li>)}</ul>}
                {error.unknown && (
                  <button type="button" onClick={check} disabled={checking}
                    className="rounded border border-zinc-600 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-100 hover:bg-zinc-800 disabled:opacity-50">
                    {checking ? "בודק…" : "בדוק מצב"}
                  </button>
                )}
              </div>
            )}
            <p id={ids.live} role="status" className="sr-only">{announce}</p>
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-950 p-3">
            <button type="button" onClick={close} disabled={busy}
              className="min-h-10 rounded px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">סגור בלי לבצע</button>
            <button ref={actionRef} type="submit" aria-disabled={!ready || busy ? "true" : undefined} aria-describedby={describedBy}
              className={`min-h-10 rounded px-3.5 py-1.5 text-sm font-semibold ${actionClass}`}>
              {busy ? "מבצע…" : <Bidi text={verbLabel(proposal)} />}
            </button>
            {hintShown && <p id={ids.hint} className="w-full text-xs text-zinc-400"><Bidi text={state.hint} /></p>}
          </footer>
        </form>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
