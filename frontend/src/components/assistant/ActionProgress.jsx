import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useAccounts } from "../../accounts.jsx";
import { bidiSegments } from "../../api/assistant.js";
import { actionErrorInfo, getProposal, normalizeProposal } from "../../api/assistantActions.js";
import {
  acceptUpdate, actionPoller, proposalSignature, CONSOLE_AFTER_CYCLE_NOTE, CONSOLE_INVALID_NOTE, CONSOLE_UNKNOWN_NOTE, consoleTargets, currentPdu, executingLine,
  executingNote, isFinalStatus, kindSwitch, OFFLINE_ALERT_MS, pollNotice, progressInfo, proposalId, proposalStatus, RESTORE_BUTTON,
  RESTORE_CREATED, RESTORE_HELP, restoreErrorText, resultRows, summarizeResult, TONE_TEXT,
} from "../../api/assistantActionProgress.js";

// Progress and outcome of one assistant action (ACT-9): the live line, a progress bar, per-PDU / per-outlet results
// (what was NOT switched first), the Hebrew summary, the restore button and the post-run "פתח KVM" buttons.
// Renders nothing for pending and ready proposals (the card owns those). Polling goes through the shared
// actionPoller: one request at a time per proposal, every 2 s while shown, every 5 s while the panel is closed,
// backoff on network errors, stopped on a final status, on 401/403/404 and after 15 minutes.
//
// props: proposal (public JSON, raw or normalized), onUpdate(normalizedProposal), onRestore(proposal) -> Promise
//   (creates the batch_restore proposal; the parent shows it as a new card), onOpenConsole(entry) (synchronous,
//   the parent shows the outcome), devices (site devices; a console button needs a known KVM), showSummary.
// Everything from the server is text: names and labels in <bdi>, never HTML or links. Focus never moves on its own.

actionPoller.configure({ fetchProposal: id => getProposal(id) });
if (typeof window !== "undefined") window.addEventListener("dcim-session-expired", () => actionPoller.stopAll("session"));

// Hebrew text with Latin ids, names and English phrases isolated in <bdi>.
export function Bidi({ text }) {
  return bidiSegments(text).map((seg, i) => (seg.ltr
    ? <bdi key={i} className={/\s/.test(seg.text) ? undefined : "whitespace-nowrap"}>{seg.text}</bdi>
    : <Fragment key={i}>{seg.text}</Fragment>));
}

const NOTICE_TONE = {
  error: "border-rose-900 bg-rose-950/30 text-rose-200",
  warn: "border-amber-800 bg-amber-950/30 text-amber-200",
};
const SMALL_BUTTON = "rounded border px-2.5 py-1 text-xs disabled:opacity-50";

function Summary({ summary, showMain }) {
  return (
    <>
      {showMain && <p className={`font-medium ${TONE_TEXT[summary.tone] || TONE_TEXT.info}`}><Bidi text={summary.text} /></p>}
      {summary.lines.length > 0 && (
        <ul className="space-y-0.5 text-amber-200">{summary.lines.map((line, i) => <li key={i}><Bidi text={line} /></li>)}</ul>
      )}
    </>
  );
}

export default function ActionProgress({ proposal, onUpdate, onRestore, onOpenConsole, devices, showSummary = true }) {
  const { canOperate } = useAccounts();
  const baseId = useId();
  const id = proposalId(proposal);
  const [state, setState] = useState(() => (id ? actionPoller.get(id) : null));
  const [restore, setRestore] = useState({ busy: false, error: "", done: false });
  const [, setTick] = useState(0);
  const restoreBusy = useRef(false);
  const mounted = useRef(true);
  const onUpdateRef = useRef(onUpdate);
  const lastSent = useRef(null);

  useEffect(() => { onUpdateRef.current = onUpdate; });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // One subscription per proposal. The poller outlives this view: closing the panel only slows it down.
  useEffect(() => {
    if (!id) return undefined;
    return actionPoller.watch(proposal, setState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // A newer copy from the parent (the 202 answer of execute, a cancel) reaches the poller; older copies are ignored.
  useEffect(() => {
    if (id) actionPoller.update(proposal);
  }, [proposal, id]);

  // Hand each newer server copy up, normalized like every other proposal in the panel (also when the parent still
  // holds an older copy). A copy that shows the same thing is not sent again, so a parent that copies is no loop.
  useEffect(() => {
    const p = state?.proposal;
    if (!p || p === proposal || proposalId(p) !== id) return;
    if (!acceptUpdate(proposal, p) || proposalSignature(p) === proposalSignature(proposal)) return;
    if (lastSent.current?.p === p && lastSent.current?.prop === proposal) return;
    lastSent.current = { p, prop: proposal };
    const next = normalizeProposal(p);
    if (next) onUpdateRef.current?.(next);
  }, [state, proposal, id]);

  // Re-render when the connection has been lost for a minute, so the stronger notice appears on time.
  const failures = state?.failures || 0;
  const offlineSince = state?.offlineSince;
  useEffect(() => {
    if (!failures || !Number.isFinite(offlineSince)) return undefined;
    const left = offlineSince + OFFLINE_ALERT_MS - Date.now();
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setTick(n => n + 1), left + 50);
    return () => clearTimeout(timer);
  }, [failures, offlineSince]);

  // The poller's copy is the newest the browser has; the prop is used until the poller has one.
  const view = state?.proposal && proposalId(state.proposal) === id ? state.proposal : proposal;
  const status = proposalStatus(view);
  if (!id || status === "pending" || status === "ready") return null;

  const running = status === "executing";
  const final = isFinalStatus(status);
  const prog = progressInfo(view);
  const current = currentPdu(view);
  const summary = running ? null : summarizeResult(view);
  const rows = resultRows(view);
  const showRows = rows.length > 1 || rows.some(r => r.state !== "ok");
  const notice = pollNotice(state, Date.now());
  const consoles = final && typeof onOpenConsole === "function" ? consoleTargets(view, devices) : { buttons: [], invalid: 0, unknown: 0 };
  const hasConsoles = consoles.buttons.length + consoles.invalid + consoles.unknown > 0;
  const canRestore = final && view?.can_restore === true && typeof onRestore === "function";
  const helpId = `${baseId}-restore-help`;

  async function startRestore() {
    if (restoreBusy.current) return;
    restoreBusy.current = true;
    setRestore({ busy: true, error: "", done: false });
    try {
      await onRestore(view);
      if (mounted.current) setRestore({ busy: false, error: "", done: true });
    } catch (err) {
      let text = "";
      try { text = actionErrorInfo(err, { proposal: normalizeProposal(view), phase: "create" })?.text || ""; } catch { text = ""; }
      if (mounted.current) setRestore({ busy: false, error: text || restoreErrorText(err), done: false });
    } finally {
      restoreBusy.current = false;
    }
  }

  // Synchronous inside the click, so the browser allows the popup; the parent shows the outcome.
  function openConsole(button) {
    try { onOpenConsole(button.entry); } catch { /* the parent reports its own failures */ }
  }

  return (
    <div className="space-y-2 text-xs" data-action-progress={status}>
      {running && (
        <div className="space-y-1.5">
          {showSummary && <p className="text-zinc-200"><Bidi text={executingLine(view)} /></p>}
          <div role="progressbar" aria-label="התקדמות הפעולה" aria-valuemin={0} aria-valuemax={prog.total || undefined}
            aria-valuenow={prog.total ? prog.done : undefined} aria-valuetext={prog.text || "הפעולה מתחילה"}
            className="h-1.5 w-full overflow-hidden rounded bg-zinc-800">
            <div className={`h-full bg-nv-400 motion-safe:transition-[width] motion-safe:duration-500 ${prog.total ? "" : "w-full opacity-40 motion-safe:animate-pulse"}`}
              style={prog.total ? { width: `${prog.percent}%` } : undefined} />
          </div>
          {current && (
            <p className="text-zinc-400">כעת: <bdi className="font-mono">{current.name}</bdi>{current.rack ? <> · <bdi className="font-mono">{current.rack}</bdi></> : null}</p>
          )}
          <p className="text-zinc-400">{executingNote(view)}</p>
        </div>
      )}

      {/* One polite region for the start and a successful end; failures are announced once as an alert. */}
      {showSummary && (
        <div role="status" className="space-y-1">
          {running ? <span className="sr-only">הפעולה התחילה</span> : summary && !summary.alert ? <Summary summary={summary} showMain /> : null}
        </div>
      )}
      {summary && (summary.alert || !showSummary) && (
        <div role={showSummary && summary.alert ? "alert" : undefined} className="space-y-1">
          <Summary summary={summary} showMain={showSummary} />
        </div>
      )}

      {notice && (
        <div role={notice.alert ? "alert" : "status"} className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 ${NOTICE_TONE[notice.tone] || NOTICE_TONE.warn}`}>
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.action && (
            <button type="button" onClick={() => actionPoller.refresh(id)} className={`${SMALL_BUTTON} border-zinc-600 bg-zinc-900 text-zinc-100 hover:bg-zinc-800`}>
              {notice.action === "retry" ? "נסה עכשיו" : "בדוק מצב"}
            </button>
          )}
        </div>
      )}

      {showRows && (
        <ul aria-label={rows[0].type === "pdu" ? "תוצאות לפי PDU" : "תוצאות לפי שקע"} tabIndex={rows.length > 6 ? 0 : undefined}
          className="max-h-64 divide-y divide-zinc-800 overflow-y-auto rounded border border-zinc-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-nv-300">
          {rows.map(r => (
            <li key={r.key} className="space-y-0.5 px-2 py-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="min-w-0 break-words text-zinc-200">
                  <bdi className="font-mono">{r.pduName}</bdi>
                  {r.outlet !== null ? <> · שקע {r.outlet}</> : null}
                  {r.rack ? <> · <bdi className="font-mono">{r.rack}</bdi></> : null}
                  {r.who ? <> · <bdi className="font-mono">{r.who}</bdi></> : null}
                </span>
                <span className={`shrink-0 ${TONE_TEXT[r.tone] || TONE_TEXT.info}`}>
                  {r.mark ? <span aria-hidden="true">{r.mark} </span> : null}{r.text}
                </span>
              </div>
              {r.notes.map((note, i) => <p key={i} className="break-words text-zinc-300">{note}</p>)}
              {r.detail ? <p className="break-words text-zinc-400"><bdi dir="ltr">{r.detail}</bdi></p> : null}
            </li>
          ))}
        </ul>
      )}

      {canRestore && (
        <div className="space-y-1">
          <button type="button" onClick={startRestore} disabled={restore.busy} aria-describedby={helpId}
            className="min-h-10 rounded border border-nv-400/70 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-nv-300 hover:bg-zinc-800 disabled:opacity-50">
            {restore.busy ? "מכין הצעה…" : RESTORE_BUTTON}
          </button>
          <p id={helpId} className="text-[11px] text-zinc-400">{RESTORE_HELP}</p>
          {restore.done && <p role="status" className="text-emerald-300">{RESTORE_CREATED}</p>}
          {restore.error && <p role="alert" className="text-rose-300"><Bidi text={restore.error} /></p>}
        </div>
      )}

      {hasConsoles && (
        <div className="space-y-1">
          {!canOperate ? <p className="text-zinc-400">דרושה הרשאת Operator לפתיחת KVM.</p> : (
            <>
              {consoles.buttons.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {consoles.buttons.map(b => (
                    <button key={b.key} type="button" onClick={() => openConsole(b)}
                      className="min-h-10 rounded border border-nv-400 bg-nv-400 px-3 py-1.5 text-start text-xs font-semibold text-zinc-950 hover:bg-nv-300">
                      פתח KVM
                      <span className="block text-[11px] font-normal text-zinc-900">
                        <bdi className="font-mono">{b.kvmName}</bdi> · פורט {b.port}{b.label ? <> · <bdi className="font-mono">{b.label}</bdi></> : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {consoles.buttons.some(b => b.inUse) && <p className="text-amber-200">ייתכן שמישהו אחר מחובר לקונסול הזה כרגע.</p>}
              {consoles.buttons.length > 0 && kindSwitch(view?.kind) === "cycle" && <p className="text-zinc-400">{CONSOLE_AFTER_CYCLE_NOTE}</p>}
              {consoles.invalid > 0 && <p className="text-amber-200">{CONSOLE_INVALID_NOTE}</p>}
              {consoles.unknown > 0 && <p className="text-amber-200">{CONSOLE_UNKNOWN_NOTE}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
