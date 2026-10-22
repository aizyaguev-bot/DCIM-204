import { useRef, useState } from "react";
import useDialogFocus from "./useDialogFocus.js";
import { planServerPower, powerErrorText } from "./serverPower.js";

const TITLE = { on: "Power on", off: "Power off", cycle: "Power cycle" };
const BUSY = { on: "Powering on…", off: "Powering off…", cycle: "Power cycling…" };
const STATE = s => (s === "on" ? "On" : s === "off" ? "Off" : "Unknown");
const AFTER = { on: "On", off: "Off", cycle: "Off → On" };
// The Twin's wording for what switching off means.
const CONSEQUENCE = {
  off: "The server loses power immediately; unsaved work on it is lost.",
  cycle: "The server is switched off and on again; unsaved work on it is lost.",
};

function FeedLine({ feed, action }) {
  return <li className="power-feed">
    <bdi>{feed.pduName}</bdi> · outlet {feed.outlet} · <bdi>{feed.label}</bdi> · {STATE(feed.state)} → {AFTER[action]}
    {feed.rack && <span className="power-feed-rack"> (<bdi>{feed.rack}</bdi>)</span>}
  </li>;
}

// The in-app power confirmation (never window.confirm). action null = the feeds disagree: offer both.
// onConfirm({ action, scope, feedId, plan }) resolves to one result per feed ({ ok, error?, notAttempted? }) or throws
// when the outlet mapping changed meanwhile. onClose(done, results) — done is true after an all-ok switch.
export default function PowerConfirmDialog({ serverName, group, action, scope: initialScope = "server", feedId = null,
  allowScopeChoice = false, onConfirm, onClose }) {
  const [scope, setScope] = useState(action === "cycle" ? "feed" : initialScope);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);   // { results: [], error: "" }
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const cancelRef = useRef(null);
  const headingRef = useRef(null);
  const resultRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: cancelRef, busyRef, onEscape: () => onClose(false) });

  const feed = group?.feeds.find(f => f.id === feedId) || null;
  const choice = allowScopeChoice && action !== "cycle" && feed && (group?.feeds.length || 0) > 1;
  const actions = action ? [action] : ["on", "off"];
  const plans = Object.fromEntries(actions.map(a => [a, planServerPower(group, a, a === "cycle" ? "feed" : scope, feedId)]));
  const titleId = "power-confirm-title", bodyId = "power-confirm-body";

  async function confirm(a) {
    if (busyRef.current) return;
    const plan = plans[a];
    if (plan.disabledReason) return;
    busyRef.current = true; setBusy(a);
    try {
      const results = await onConfirm({ action: a, scope: a === "cycle" ? "feed" : scope, feedId, plan });
      if ((results || []).every(r => r.ok)) { busyRef.current = false; onClose(true, results, a); return; }
      setResult({ results, error: "" });
    } catch (e) {
      setResult({ results: [], error: powerErrorText(e) });
    } finally {
      busyRef.current = false; setBusy(null);
    }
    requestAnimationFrame(() => resultRef.current?.focus());
  }

  const others = feed && group ? group.feeds.filter(f => f.id !== feed.id) : [];
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) onClose(false); }}>
    <section ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}
      className="racks-dialog" data-dialog="power">
      <h2 id={titleId} ref={headingRef} dir="auto" className="racks-dialog-title">
        {action ? <>{TITLE[action]} <bdi>{serverName}</bdi>?</> : <>Power <bdi>{serverName}</bdi></>}
      </h2>
      {result ? <div id={bodyId} className="power-result">
        <h3 ref={resultRef} tabIndex={-1} className="power-result-title">Some outlets were not switched</h3>
        {result.error && <p role="alert" dir="auto" className="racks-dialog-error">{result.error}</p>}
        {result.results.length > 0 && <ul className="power-feeds">{result.results.map(r => <li key={`${r.pduId}:${r.outlet}`} className="power-feed" data-ok={r.ok ? "" : undefined}>
          <span aria-hidden="true">{r.ok ? "✓" : r.notAttempted ? "–" : "✗"}</span> <bdi>{r.pduName}</bdi> · outlet {r.outlet} · <bdi>{r.label}</bdi> · {r.ok ? "switched" : r.notAttempted ? "not attempted" : <span dir="auto">{r.error}</span>}
        </li>)}</ul>}
        <div className="racks-dialog-actions"><button type="button" className="racks-btn" onClick={() => onClose(false)}>Close</button></div>
      </div> : <div id={bodyId}>
        {choice && <fieldset className="power-scope">
          <legend className="sr-only">What to switch</legend>
          <label><input type="radio" name="power-scope" checked={scope === "server"} onChange={() => setScope("server")} disabled={!!busy}/> Whole server ({group.feeds.length} feeds)</label>
          <label><input type="radio" name="power-scope" checked={scope === "feed"} onChange={() => setScope("feed")} disabled={!!busy}/> Only this feed (<bdi>{feed.label}</bdi>)</label>
          {scope === "feed" && others.length > 0 && <p className="power-warning" dir="auto">
            <bdi>{serverName}</bdi> stays powered by {others.map((f, i) => <span key={f.id}>{i ? ", " : ""}<bdi>{f.pduName}</bdi> outlet {f.outlet}</span>)}.</p>}
        </fieldset>}
        {actions.map(a => {
          const plan = plans[a];
          return <div key={a} className="power-plan">
            {!action && <h3 className="power-plan-title">{a === "on" ? "Power on all feeds" : "Power off all feeds"}</h3>}
            {plan.targets.length > 0 && <ul className="power-feeds">{plan.targets.map(f => <FeedLine key={f.id} feed={f} action={a}/>)}</ul>}
            {plan.skipped.length > 0 && <ul className="power-feeds power-skipped">{plan.skipped.map(s => <li key={s.feed.id} className="power-feed">
              <bdi>{s.feed.pduName}</bdi> · outlet {s.feed.outlet} · {s.reason} — skipped</li>)}</ul>}
            {plan.disabledReason && <p role="alert" dir="auto" className="racks-dialog-error">{plan.disabledReason}</p>}
          </div>;
        })}
        {actions.some(a => CONSEQUENCE[a]) && <p className="power-consequence">{CONSEQUENCE[action || "off"]}</p>}
        <div className="racks-dialog-actions">
          <button ref={cancelRef} type="button" className="racks-btn" disabled={!!busy} onClick={() => onClose(false)}>Cancel</button>
          {actions.map(a => <button key={a} type="button" className="racks-btn power-confirm" data-action={a}
            disabled={!!busy || !!plans[a].disabledReason} onClick={() => confirm(a)}>
            {busy === a ? BUSY[a] : action ? TITLE[a] : a === "on" ? "Power on all feeds" : "Power off all feeds"}</button>)}
        </div>
      </div>}
    </section>
  </div>;
}
