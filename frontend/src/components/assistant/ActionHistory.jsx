import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatAsOf } from "../../api/assistant.js";
import { listProposals } from "../../api/assistantActions.js";
import {
  actionPoller, CONSOLE_INVALID_NOTE, CONSOLE_NOTES, HISTORY_LIMIT, HISTORY_TEXT, historyErrorText, historyRetryable, historyRow,
  mergeHistory, normalizeHistory, pickNewer, progressInfo, proposalId,
} from "../../api/assistantActionProgress.js";
import ActionProgress, { Bidi } from "./ActionProgress.jsx";

// "פעולות אחרונות" (the assistant panel's actions tab, ACT-9): the latest 20 action proposals the server lets this
// user see (own; Admin: all). Each row shows status, title, who and when; a running one shows live progress (shared
// actionPoller). A row expands to ActionProgress (results, restore, consoles). A list read before a newer poll
// answer never overwrites it, and a slow list answer never overwrites a newer list.
// props: onSelect(proposal) (optional, called when a row is opened), onRestore(proposal) -> Promise,
//   onOpenConsole(entry) (synchronous), devices, refreshKey (reload when it changes).

const SMALL = "rounded border px-2.5 py-1 text-xs disabled:opacity-40";

export default function ActionHistory({ onSelect, onRestore, onOpenConsole, devices, refreshKey }) {
  const baseId = useId();
  const [items, setItems] = useState(null);          // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);          // {text, retry}
  const [open, setOpen] = useState({});
  const [consoleNotes, setConsoleNotes] = useState({});
  const seq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const raw = await listProposals(HISTORY_LIMIT);
      if (!mounted.current || mine !== seq.current) return;
      const fresh = mergeHistory(normalizeHistory(raw), id => actionPoller.get(id)?.proposal || null);
      setItems(current => {
        const known = new Map((current || []).map(x => [proposalId(x), x]));
        return fresh.map(x => pickNewer(known.get(proposalId(x)) || null, x));
      });
    } catch (err) {
      if (!mounted.current || mine !== seq.current) return;
      setError({ text: historyErrorText(err), retry: historyRetryable(err) });
    } finally {
      if (mounted.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Every newer copy the poller sees (from any card or this list) updates the matching row.
  useEffect(() => actionPoller.onAny(s => {
    if (!s?.proposal) return;
    setItems(list => {
      if (!list) return list;
      const at = list.findIndex(x => proposalId(x) === s.id);
      if (at < 0) return list;
      const next = pickNewer(list[at], s.proposal);
      if (next === list[at]) return list;
      const copy = list.slice();
      copy[at] = next;
      return copy;
    });
  }), []);

  // Running rows are watched while this tab is shown (2 s); afterwards the poller goes on more slowly by itself.
  const running = (items || []).filter(x => x.status === "executing");
  const runningKey = running.map(proposalId).join(",");
  useEffect(() => {
    if (!runningKey) return undefined;
    const offs = running.map(p => actionPoller.watch(p, () => {}));
    return () => offs.forEach(off => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey]);

  const restoreFor = useCallback(async proposal => {
    const created = await onRestore(proposal);
    if (mounted.current) load();
    return created;
  }, [onRestore, load]);

  function openConsoleFor(id) {
    return entry => {
      let outcome;
      try { outcome = onOpenConsole(entry); } catch { outcome = "invalid"; }
      setConsoleNotes(n => ({ ...n, [id]: outcome === "invalid" ? CONSOLE_INVALID_NOTE : CONSOLE_NOTES[outcome] || "" }));
      return outcome;
    };
  }

  function toggle(proposal, id) {
    const opening = !open[id];
    setOpen(o => ({ ...o, [id]: opening }));
    if (opening) onSelect?.(proposal);
  }

  return (
    <section dir="rtl" lang="he" aria-labelledby={`${baseId}-heading`} className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${baseId}-heading`} className="font-medium text-zinc-100">{HISTORY_TEXT.heading}</h3>
        <button type="button" onClick={load} disabled={loading} className={`ms-auto ${SMALL} border-zinc-800 text-zinc-300 hover:bg-zinc-800`}>
          {loading ? "טוען…" : HISTORY_TEXT.refresh}
        </button>
      </div>

      {error && (
        <div role="alert" className={`flex flex-wrap items-center gap-2 rounded border p-3 text-xs ${error.retry
          ? "border-rose-900 bg-rose-950/30 text-rose-300" : "border-amber-800 bg-amber-950/30 text-amber-200"}`}>
          <span className="min-w-0 flex-1">{items ? `לא ניתן לרענן את הרשימה; מוצגת הרשימה האחרונה שנטענה. ${error.text}` : error.text}</span>
          {error.retry && (
            <button type="button" onClick={load} disabled={loading} className={`${SMALL} border-rose-800 text-rose-200 hover:bg-rose-950/60`}>
              {HISTORY_TEXT.retry}
            </button>
          )}
        </div>
      )}

      {items === null && !error && <p role="status" className="text-xs text-zinc-400">{HISTORY_TEXT.loading}</p>}
      {items !== null && items.length === 0 && <p className="text-xs text-zinc-400">{HISTORY_TEXT.empty}</p>}

      {items !== null && items.length > 0 && (
        <ul className="space-y-2">
          {items.map(p => {
            const row = historyRow(p);
            const isOpen = !!open[row.id];
            const detailsId = `${baseId}-details-${row.id}`;
            const prog = progressInfo(p);
            return (
              <li key={row.id} className="rounded border border-zinc-800 bg-zinc-900/60">
                <button type="button" aria-expanded={isOpen} aria-controls={detailsId} onClick={() => toggle(p, row.id)}
                  className="block w-full space-y-1 p-2.5 text-start hover:bg-zinc-800/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-nv-300">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] ${row.chip.className} ${row.running ? "motion-safe:animate-pulse" : ""}`}>
                      {row.chip.label}
                    </span>
                    {row.progress && <span className="font-mono text-[11px] text-zinc-400"><bdi>{row.progress}</bdi></span>}
                    <span aria-hidden="true" className="ms-auto text-xs text-zinc-400">{isOpen ? "▴" : "▾"}</span>
                  </span>
                  <span className="block truncate text-zinc-100"><Bidi text={row.title} /></span>
                  <span className="block text-[11px] text-zinc-400">
                    על ידי <bdi className="text-zinc-300">{row.by}</bdi> · <bdi>{formatAsOf(row.createdAt)}</bdi>
                  </span>
                </button>
                {row.running && !isOpen && (
                  <div className="px-2.5 pb-2.5">
                    <div role="progressbar" aria-label={`התקדמות: ${row.title}`} aria-valuemin={0} aria-valuemax={prog.total || undefined}
                      aria-valuenow={prog.total ? prog.done : undefined} aria-valuetext={prog.text || "הפעולה מתחילה"}
                      className="h-1 w-full overflow-hidden rounded bg-zinc-800">
                      <div className={`h-full bg-nv-400 motion-safe:transition-[width] ${prog.total ? "" : "w-full opacity-40 motion-safe:animate-pulse"}`}
                        style={prog.total ? { width: `${prog.percent}%` } : undefined} />
                    </div>
                  </div>
                )}
                {isOpen && (
                  <div id={detailsId} className="space-y-2 border-t border-zinc-800 p-2.5">
                    {row.status === "pending" ? <p className="text-xs text-zinc-300">{HISTORY_TEXT.pending}</p>
                      : row.status === "ready" ? <p className="text-xs text-zinc-300">{HISTORY_TEXT.ready}</p>
                      : <ActionProgress proposal={p} devices={devices} onRestore={onRestore ? restoreFor : undefined}
                          onOpenConsole={onOpenConsole ? openConsoleFor(row.id) : undefined} />}
                    {consoleNotes[row.id] && <p role="status" className="text-xs text-zinc-300">{consoleNotes[row.id]}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
