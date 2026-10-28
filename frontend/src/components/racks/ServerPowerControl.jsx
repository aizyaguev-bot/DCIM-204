import { useId } from "react";
import { useAccounts } from "../../accounts";
import { BLOCK, planServerPower } from "./serverPower.js";

const blockKey = reason => reason ? (Object.entries(BLOCK).find(([, text]) => reason.includes(text))?.[0] || "blocked") : undefined;

// Why a request cannot be made right now (null when it can). waiting: no PDU reading has arrived yet.
export function powerBlockReason(group, action, { pending = null, waiting = false, scope = "server", feedId = null } = {}) {
  if (pending) return BLOCK.busy;
  if (waiting) return "Waiting for the first PDU reading";
  if (!group) return "This server has no PDU outlet";
  return planServerPower(group, action, scope, feedId).disabledReason;
}

// The power symbol on the switch knob (decorative; the button's name and aria-checked carry the meaning).
const POWER_ICON = <svg className="power-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  strokeWidth="3" strokeLinecap="round" focusable="false"><path d="M12 3v8"/><path d="M6.3 7.2a8 8 0 1 0 11.4 0"/></svg>;

// The row's ON/OFF switch: a pill with its state written in it (ON / OFF) and a round knob; an unknown state is an
// empty dashed pill with the knob in the middle, and split feeds are an amber "Mixed" pill. It never switches anything
// itself: activating it asks for the opposite state (onRequest(action, element)), or for a choice when the feeds
// disagree (action null). Blocked controls stay focusable with aria-disabled and say why (title and a visually hidden
// description); a click then does nothing.
export default function ServerPowerControl({ server, group, pending = null, waiting = false, onRequest }) {
  const { canOperate } = useAccounts();
  const reasonId = useId();
  if (!canOperate || !group || !onRequest) return null;
  const name = server.name;
  if (group.state === "partial" && !pending && !waiting) {
    return <button type="button" className="power-toggle" data-power-state="partial" aria-haspopup="dialog"
      aria-label={`Power ${name}: some feeds on`} title="Some feeds are on and some are off"
      onClick={e => onRequest(null, e.currentTarget)}><span className="power-mixed"><span aria-hidden="true" className="power-half"/>Mixed</span></button>;
  }
  const on = group.state === "on";
  const action = on ? "off" : "on";
  const reason = group.state === "on" || group.state === "off"
    ? powerBlockReason(group, action, { pending, waiting })
    : pending ? BLOCK.busy : waiting ? "Waiting for the first PDU reading" : group.feeds.map(f => f.blocked?.on).find(Boolean) || BLOCK.unknown;
  return <>
    <button type="button" role="switch" aria-checked={on} className="power-toggle"
      data-power-state={group.state} data-blocked={blockKey(reason)}
      aria-disabled={reason ? "true" : undefined} aria-busy={pending ? "true" : undefined}
      aria-label={`Power ${name}`} aria-describedby={reason ? reasonId : undefined}
      title={reason || (on ? `Power off ${name}` : `Power on ${name}`)}
      onClick={e => { if (!reason) onRequest(action, e.currentTarget); }}>
      <span aria-hidden="true" className="power-track">
        {(on || group.state === "off") && <span className="power-label">{on ? "ON" : "OFF"}</span>}
        <span className="power-knob">{pending ? <span className="power-spin"/> : POWER_ICON}</span>
      </span>
    </button>
    {reason && <span id={reasonId} className="sr-only">{reason}</span>}
  </>;
}

// Text buttons for the server details dialog and the edit panel. A blocked button shows its reason as visible text.
// actions: e.g. ["on", "off"] or ["on", "off", "cycle"]; scope/feedId as in planServerPower.
export function PowerActionButtons({ group, actions, scope = "server", feedId = null, pending = null, label, onRequest }) {
  const LABEL = { on: "Power on", off: "Power off", cycle: "Power cycle" };
  const reasons = Object.fromEntries(actions.map(a => [a, powerBlockReason(group, a, { pending, scope, feedId })]));
  const shown = [...new Set(Object.values(reasons).filter(Boolean))];
  return <div className="power-actions">
    <div className="power-actions-row" role="group" aria-label={label}>
      {actions.map(a => <button key={a} type="button" className="power-btn" data-action={a}
        aria-disabled={reasons[a] ? "true" : undefined} title={reasons[a] || undefined}
        onClick={e => { if (!reasons[a]) onRequest(a, e.currentTarget, { scope, feedId }); }}>
        {pending === a ? "Working…" : LABEL[a]}</button>)}
    </div>
    {shown.length > 0 && <ul className="power-reasons">{shown.map(r => <li key={r}>{r}</li>)}</ul>}
  </div>;
}
