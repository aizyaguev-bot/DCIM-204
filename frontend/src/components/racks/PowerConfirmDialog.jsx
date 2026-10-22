import { useEffect, useRef, useState } from "react";
import useDialogFocus from "./useDialogFocus.js";
import { planServerPower, powerErrorText, serverDisplayName, otherFeeds } from "./serverPower.js";

const TITLE = { on: "Power on", off: "Power off", cycle: "Power cycle" };
const BUSY = { on: "Powering on…", off: "Powering off…", cycle: "Power cycling…" };
const STATE = s => (s === "on" ? "On" : s === "off" ? "Off" : "Unknown");
const AFTER = { on: "On", off: "Off", cycle: "Off → On" };
// The Twin's wording for what switching off means.
const CONSEQUENCE = {
  off: "The server loses power immediately; unsaved work on it is lost.",
  cycle: "The server is switched off and on again; unsaved work on it is lost.",
};
// The action buttons only work once the dialog has been on screen for ARM_MS and a pointer or key press started inside
// it: the second click of a double click (or a double tap) on a row switch lands on the button that appears under the
// pointer, and must never switch a server off.
export const ARM_MS = 400;

function FeedLine({ feed, action }) {
  return <li className="power-feed">
    <bdi>{feed.pduName}</bdi> · outlet {feed.outlet} · <bdi>{feed.label}</bdi> · {STATE(feed.state)} → {AFTER[action]}
    {feed.rack && <span className="power-feed-rack"> (<bdi>{feed.rack}</bdi>)</span>}
  </li>;
}

const Outlets = ({ feeds }) => feeds.map((f, i) => <span key={f.id}>{i ? ", " : ""}<bdi>{f.pduName}</bdi> outlet {f.outlet}</span>);

// What a request for one feed of a multi-feed server leaves: the feeds that keep the server powered, or that this is
// its last powered feed. Only feeds that are on count as power.
function FeedScopeNote({ server, group, feedId, action }) {
  const { others, powered, unpowered } = otherFeeds(group, feedId);
  if (!others.length) return null;
  if (action === "on") {
    return unpowered.length ? <p className="power-warning" dir="auto">Only this feed is switched on; <Outlets feeds={unpowered}/> {unpowered.length === 1 ? "stays" : "stay"} off.</p> : null;
  }
  if (!powered.length) {
    return action === "off" ? <p className="power-consequence" data-last-feed="" dir="auto">This is the last powered feed — <bdi>{server}</bdi> loses power.</p> : null;
  }
  return <p className="power-warning" dir="auto"><bdi>{server}</bdi> stays powered by <Outlets feeds={powered}/>{action === "cycle" ? ", so it is not power-cycled" : ""}.</p>;
}

// The in-app power confirmation (never window.confirm). action null = the feeds disagree: offer both.
// onConfirm({ action, scope, feedId, plan }) resolves to one result per feed ({ ok, error?, notAttempted? }) or throws
// when the outlet mapping changed meanwhile. onClose(done, results, action, scope) — done is true after an all-ok switch.
export default function PowerConfirmDialog({ serverName, group, action, scope: initialScope = "server", feedId = null,
  allowScopeChoice = false, onConfirm, onClose }) {
  const [scope, setScope] = useState(action === "cycle" ? "feed" : initialScope);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);   // { results: [], error: "" }
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const cancelRef = useRef(null);
  const resultRef = useRef(null);
  const openedAt = useRef(null);
  if (openedAt.current === null) openedAt.current = performance.now();
  const touched = useRef(false);
  useDialogFocus(panelRef, { initialRef: cancelRef, busyRef, onEscape: () => onClose(false) });
  useEffect(() => {
    const panel = panelRef.current;
    const mark = () => { touched.current = true; };
    panel?.addEventListener("pointerdown", mark);
    panel?.addEventListener("keydown", mark);
    return () => { panel?.removeEventListener("pointerdown", mark); panel?.removeEventListener("keydown", mark); };
  }, []);
  function armed(e) {
    if (!touched.current || e.detail > 1) return false;
    const now = performance.now();
    const at = e.timeStamp > 0 && e.timeStamp <= now + 1000 ? e.timeStamp : now;
    return at - openedAt.current >= ARM_MS;
  }

  const feed = group?.feeds.find(f => f.id === feedId) || null;
  const multi = (group?.feeds.length || 0) > 1;
  const server = serverDisplayName(serverName);
  const choice = allowScopeChoice && action !== "cycle" && feed && multi;
  const actions = action ? [action] : ["on", "off"];
  const scopeOf = a => (a === "cycle" ? "feed" : scope);
  const plans = Object.fromEntries(actions.map(a => [a, planServerPower(group, a, scopeOf(a), feedId)]));
  const titleId = "power-confirm-title", bodyId = "power-confirm-body";
  const feedOnly = a => scopeOf(a) === "feed" && multi && !!feed;
  // Off / Cycle of one feed while another feed is on leaves the server running: no "loses power" line then.
  const losesPower = a => !plans[a].disabledReason && (!feedOnly(a) || !otherFeeds(group, feedId).powered.length);
  const both = { on: scope === "feed" ? "Power on this feed" : "Power on all feeds", off: scope === "feed" ? "Power off this feed" : "Power off all feeds" };

  async function confirm(a, e) {
    if (busyRef.current || !armed(e)) return;
    const plan = plans[a];
    if (plan.disabledReason) return;
    busyRef.current = true; setBusy(a);
    try {
      const results = await onConfirm({ action: a, scope: scopeOf(a), feedId, plan });
      if ((results || []).every(r => r.ok)) { busyRef.current = false; onClose(true, results, a, scopeOf(a)); return; }
      setResult({ results, error: "" });
    } catch (err) {
      setResult({ results: [], error: powerErrorText(err) });
    } finally {
      busyRef.current = false; setBusy(null);
    }
    requestAnimationFrame(() => resultRef.current?.focus());
  }

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) onClose(false); }}>
    <section ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}
      className="racks-dialog" data-dialog="power">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">
        {!action ? <>Power <bdi>{server}</bdi></>
          : feedOnly(action) ? <>{TITLE[action]} feed <bdi>{feed.label}</bdi> of <bdi>{server}</bdi>?</>
          : <>{TITLE[action]} <bdi>{server}</bdi>?</>}
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
        </fieldset>}
        {actions.map(a => {
          const plan = plans[a];
          return <div key={a} className="power-plan" data-plan={a}>
            {!action && <h3 className="power-plan-title">{both[a]}</h3>}
            {plan.targets.length > 0 && <ul className="power-feeds">{plan.targets.map(f => <FeedLine key={f.id} feed={f} action={a}/>)}</ul>}
            {plan.skipped.length > 0 && <ul className="power-feeds power-skipped">{plan.skipped.map(s => <li key={s.feed.id} className="power-feed">
              <bdi>{s.feed.pduName}</bdi> · outlet {s.feed.outlet} · {s.reason} — skipped</li>)}</ul>}
            {plan.noop ? <p dir="auto" className="power-noop">{plan.disabledReason}</p>
              : plan.disabledReason ? <p role="alert" dir="auto" className="racks-dialog-error">{plan.disabledReason}</p>
              : feedOnly(a) && <FeedScopeNote server={server} group={group} feedId={feedId} action={a}/>}
          </div>;
        })}
        {actions.some(a => CONSEQUENCE[a] && losesPower(a)) && <p className="power-consequence">{CONSEQUENCE[action || "off"]}</p>}
        <div className="racks-dialog-actions">
          <button ref={cancelRef} type="button" className="racks-btn" disabled={!!busy} onClick={() => onClose(false)}>Cancel</button>
          {actions.map(a => <button key={a} type="button" className="racks-btn power-confirm" data-action={a}
            disabled={!!busy || (!!plans[a].disabledReason && !plans[a].noop)} aria-disabled={plans[a].noop ? "true" : undefined}
            onClick={e => confirm(a, e)}>
            {busy === a ? BUSY[a] : action ? TITLE[a] : both[a]}</button>)}
        </div>
      </div>}
    </section>
  </div>;
}
