import { useEffect, useId, useRef, useState } from "react";
import {
  CONSOLE_NOTES, STATUS_LINES, actionErrorInfo, cancelProposal, clientWarnings, configBlockText,
  countdownLabel, displayStatus, getProposal, normalizeProposal, outletsText, proposalConsoles, remainingSeconds, riskOf, RISK_LABELS,
  roleChipText, statusLabel,
} from "../../api/assistantActions.js";
import { formatAsOf } from "../../api/assistant.js";
import { Bidi } from "./AnswerView.jsx";
import ActionImpact from "./ActionImpact.jsx";
import ActionConfirmDialog from "./ActionConfirmDialog.jsx";
import ConsoleButton from "./ConsoleButton.jsx";
// ActionProgress (ACT-9) renders the live line, progress, per-PDU results, the restore button and the post-run
// console buttons for every status except pending/ready; the card does not repeat any of them.
import ActionProgress from "./ActionProgress.jsx";

// One proposal as the server stored it: risk, role, countdown, the exact impact, and the actions allowed for this user.
// Everything shown comes from the public proposal JSON (never from model text). Requests here are only reads,
// "cancel" and creating a new proposal; executing happens only in ActionConfirmDialog after the password.
//
// props: proposal (normalized), devices, config (GET /config or null), canOperate, canAdmin,
//   onUpdate(proposal), onExecuted(proposal), onRestore(proposal) -> Promise, onRepropose(proposal) -> Promise,
//   onOpenConsole(entry) -> "popup" | "inline" | "denied" | "invalid"   (synchronous)

const CARD_TONE = {
  info: "border-zinc-700",
  medium: "border-amber-700/70 border-s-4",
  high: "border-rose-800 border-s-4",
  batch: "border-rose-800 border-s-4",
  critical: "border-rose-600 border-s-4 bg-rose-950/30",
};
const RISK_TONE = {
  info: "border-zinc-600 text-zinc-300",
  medium: "border-amber-700 bg-amber-950/40 text-amber-200",
  high: "border-rose-800 bg-rose-950/50 text-rose-200",
  batch: "border-rose-800 bg-rose-950/50 text-rose-200",
  critical: "border-rose-600 bg-rose-900/50 font-semibold text-rose-100",
};
const STATUS_TONE = {
  executing: "border-nv-400/60 text-nv-300", succeeded: "border-emerald-700 text-emerald-300", ready: "border-emerald-700 text-emerald-300",
  partial: "border-amber-700 text-amber-200", refused: "border-amber-700 text-amber-200", interrupted: "border-amber-700 text-amber-200",
  failed: "border-rose-800 text-rose-300", expired: "border-zinc-600 text-zinc-300", cancelled: "border-zinc-600 text-zinc-300",
  not_found: "border-zinc-600 text-zinc-300", unknown: "border-zinc-600 text-zinc-300",
};
const BUTTON = "min-h-10 rounded border px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50";

function useTick(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function clock(ms) {
  if (!Number.isFinite(ms)) return "";
  try { return new Date(ms).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return ""; }
}

function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="space-y-1 rounded border border-rose-900 bg-rose-950/30 p-2 text-xs text-rose-200">
      <p>{error.text}</p>
      {error.details?.length > 0 && <ul className="list-disc ps-5">{error.details.map((d, i) => <li key={i}><Bidi text={d} /></li>)}</ul>}
    </div>
  );
}

export default function ActionProposalCard({
  proposal, devices, config, canOperate = false, canAdmin = false,
  onUpdate, onExecuted, onRestore, onRepropose, onOpenConsole,
}) {
  const baseId = useId();
  const titleId = `${baseId}-title`, summaryId = `${baseId}-summary`;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState("");               // "cancel" | "repropose"
  const [error, setError] = useState(null);
  const [missing, setMissing] = useState(false);       // 404: the server no longer has it
  const [consoleNote, setConsoleNote] = useState("");
  const titleRef = useRef(null);
  const executeRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const now = useTick(proposal?.status === "pending");
  if (!proposal) return null;
  const status = missing ? "not_found" : displayStatus(proposal, now);
  const risk = riskOf(proposal);
  const remaining = remainingSeconds(proposal, now);
  const countdown = status === "pending" ? countdownLabel(remaining) : null;
  const blockedText = configBlockText(config);
  const pending = status === "pending";
  const isConsole = proposal.kind === "open_console";
  // Client-side reminders (labels, several feeds) matter only before the confirmation.
  const warnings = [...proposal.impact.warnings_he.map(text => ({ text, server: true })),
    ...(proposal.status === "pending" ? clientWarnings(proposal) : []).map(text => ({ text }))];
  const showProgress = !missing && proposal.status !== "pending" && proposal.status !== "ready";
  const asOf = formatAsOf(proposal.created_at);

  // Why this user has no "בצע…" on a pending proposal.
  let roleNote = "";
  if (pending && !isConsole && !proposal.can_execute) {
    if (proposal.required_role === "Admin" && !canAdmin) roleNote = "דרושה הרשאת Admin";
    else if (!canOperate) roleNote = "דרושה הרשאת Operator";
    else roleNote = "רק מי שביקש את ההצעה יכול לאשר אותה.";
  }

  async function refresh() {
    try {
      const fresh = normalizeProposal(await getProposal(proposal.id));
      if (fresh) { setMissing(false); onUpdate?.(fresh); }
      return fresh;
    } catch (err) {
      if (err?.status === 404 && mounted.current) setMissing(true);
      return null;
    }
  }

  async function run(kind, fn) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (!mounted.current) return;
      const info = actionErrorInfo(err, { proposal, phase: kind === "cancel" ? "cancel" : "create" });
      setError(info);
      if (info.code === "not_found" && kind === "cancel") setMissing(true);
      if (["not_pending", "expired"].includes(info.code)) refresh();
    } finally {
      if (mounted.current) setBusy("");
    }
  }

  const cancel = () => run("cancel", async () => {
    const next = normalizeProposal(await cancelProposal(proposal.id));
    if (next) onUpdate?.(next);
  });
  const repropose = () => run("repropose", () => onRepropose?.(proposal));

  function openDialog() {
    if (!proposal.can_execute || blockedText) return;
    setError(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    // Back to "בצע…" when it is still there, else to the card title.
    requestAnimationFrame(() => {
      const target = executeRef.current && document.contains(executeRef.current) && !executeRef.current.disabled ? executeRef.current : titleRef.current;
      target?.focus();
    });
  }

  // Synchronous: called inside the button's click handler, so the popup is allowed.
  const openConsole = entry => (onOpenConsole ? onOpenConsole(entry) : "invalid");
  // ActionProgress's post-run buttons: the card shows what happened under the results.
  function openConsoleFromProgress(entry) {
    const outcome = openConsole(entry);
    setConsoleNote(CONSOLE_NOTES[outcome] || "");
    return outcome;
  }

  // States only the card knows about: gone from the server, or expired here before the server marked it.
  let cardLine = "";
  if (missing) cardLine = STATUS_LINES.not_found;
  else if (proposal.status === "pending" && status === "expired") cardLine = STATUS_LINES.expired;

  const cardClass = `space-y-2 rounded border bg-zinc-950 p-3 ${CARD_TONE[risk] || CARD_TONE.medium}`;
  const canRepropose = canOperate && !!proposal.request?.kind && (status === "expired" || status === "refused");

  return (
    <section aria-labelledby={titleId} aria-describedby={summaryId} dir="rtl" lang="he" className={cardClass} data-proposal-id={proposal.id}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded border px-1.5 py-0.5 text-[11px] ${RISK_TONE[risk]}`}>{RISK_LABELS[risk]}</span>
        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300">{roleChipText(proposal)}</span>
        {dialogOpen && <span className="rounded border border-amber-700 px-1.5 py-0.5 text-[11px] text-amber-200">ממתין לאישור</span>}
        {!dialogOpen && statusLabel(status) && (
          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATUS_TONE[status] || STATUS_TONE.unknown} ${status === "executing" ? "motion-safe:animate-pulse" : ""}`}>
            {statusLabel(status)}
          </span>
        )}
        {countdown && (
          <span className={`ms-auto text-[11px] ${countdown.tone === "ok" ? "text-zinc-400" : "font-semibold text-amber-300"}`}>
            <span aria-hidden="true">{countdown.text}</span>
            <span className="sr-only">בתוקף עד {clock(proposal.ends_at)}</span>
          </span>
        )}
      </div>

      <h5 id={titleId} ref={titleRef} tabIndex={-1} className="text-sm font-semibold text-zinc-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-nv-300">
        {risk === "critical" && <span aria-hidden="true">⚠ </span>}<Bidi text={proposal.title_he || "פעולה מוצעת"} />
      </h5>

      {showProgress && (
        <ActionProgress proposal={proposal} devices={devices} onUpdate={onUpdate} onRestore={onRestore} onOpenConsole={openConsoleFromProgress} showSummary />
      )}

      {pending || isConsole || missing ? <ActionImpact proposal={proposal} compact /> : (
        <details className="rounded border border-zinc-800 px-2 py-1">
          <summary className="cursor-pointer text-xs text-zinc-300">מה ההצעה כללה ({outletsText(proposal.impact.counts.outlets)})</summary>
          <div className="mt-2"><ActionImpact proposal={proposal} compact /></div>
        </details>
      )}

      {warnings.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {warnings.map((w, i) => <li key={i} className={w.server ? "text-amber-200" : "text-zinc-400"}><Bidi text={w.text} /></li>)}
        </ul>
      )}
      {asOf !== "—" && pending && !isConsole && (
        <p className="text-[11px] text-zinc-400">ההשפעה חושבה בשרת לפי מצב ה-PDU ב־<bdi className="font-mono">{asOf}</bdi>. היא תיבדק שוב רגע לפני הביצוע.</p>
      )}

      <p id={summaryId} role="status" className="text-xs text-zinc-300">{cardLine}</p>

      {isConsole && (proposal.status === "ready" || proposal.status === "pending") && (
        !canOperate ? <p className="text-xs text-zinc-400">דרושה הרשאת Operator לפתיחת KVM.</p>
        : proposalConsoles(proposal).length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {proposalConsoles(proposal).map((c, i) => <ConsoleButton key={`${c.kvm_id}:${c.port}:${i}`} entry={c} onOpenConsole={openConsole} canOperate={canOperate} />)}
          </div>
        ) : <p className="text-xs text-amber-200">לא נמצא חיבור KVM לשרת הזה.</p>
      )}

      {pending && !isConsole && blockedText && <p className="text-xs text-amber-200">{blockedText}</p>}
      {roleNote && <p className="text-xs text-zinc-400">{roleNote}</p>}

      {pending && !isConsole && proposal.can_execute && !blockedText && (
        <div className="flex flex-wrap gap-2">
          <button ref={executeRef} type="button" onClick={openDialog} disabled={dialogOpen || !!busy} aria-haspopup="dialog"
            aria-label={`בצע: ${proposal.title_he || "פעולה מוצעת"}`}
            className={`${BUTTON} ${risk === "critical" || risk === "high" || risk === "batch" ? "border-rose-700 bg-rose-950/60 text-rose-100 hover:bg-rose-900/60" : "border-zinc-600 bg-zinc-900 text-zinc-100 hover:border-zinc-400 hover:bg-zinc-800"}`}>
            בצע…
          </button>
          <button type="button" onClick={cancel} disabled={dialogOpen || !!busy}
            className={`${BUTTON} border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800`}>
            {busy === "cancel" ? "מבטל…" : "בטל הצעה"}
          </button>
        </div>
      )}

      {canRepropose && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={repropose} disabled={!!busy} className={`${BUTTON} border-zinc-600 bg-zinc-900 text-zinc-100 hover:bg-zinc-800`}>
            {busy === "repropose" ? "מכין הצעה…" : status === "refused" ? "הצע שוב" : "בקש הצעה מעודכנת"}
          </button>
          <span className="text-[11px] text-zinc-400">השרת יחשב את ההשפעה מחדש; שום דבר לא יבוצע בלי אישור.</span>
        </div>
      )}

      {consoleNote && showProgress && <p role="status" className="text-xs text-zinc-300">{consoleNote}</p>}
      <ErrorBox error={error} />

      {dialogOpen && (
        <ActionConfirmDialog proposal={proposal} passwordMode={config?.password_mode} blockedText={blockedText}
          onClose={closeDialog} onRefresh={refresh}
          onExecuted={next => { onExecuted ? onExecuted(next) : onUpdate?.(next); }} />
      )}
    </section>
  );
}
