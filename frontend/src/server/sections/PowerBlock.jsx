// Power feeds (v1 §1.3): one row per PDU outlet that carries the server's name (serverPowerGroup), with its state, W and
// why an action is refused there (PDU maintenance with its reason, a protected outlet, an unreachable PDU). Operators
// switch one feed from its row: act.power.request(action, opener, { scope: "feed", feedId }) always asks first
// (PowerConfirmDialog). Props: { record, can, act }.
import { useLabWindow } from "../../window/labWindowContext.js";
import { WindowSection } from "../../window/WindowShell.jsx";
import { formatTime } from "../../window/format.js";
import "../server-ops.css";

const STATE = s => (s === "on" ? "On" : s === "off" ? "Off" : "Unknown");
const TONE = s => (s === "on" ? "ok" : s === "off" ? "off" : "unknown");
const ACTIONS = [["on", "On"], ["off", "Off"], ["cycle", "Cycle"]];
const VERB = { on: "Power on", off: "Power off", cycle: "Power cycle" };

// The reason lines of one feed: maintenance (with who, when and why), protection, or a block on every action.
export function feedNotes(feed, maintenance) {
  const notes = [];
  if (feed.inMaintenance) {
    const m = maintenance?.pdus?.[String(feed.pduId)] || null;
    const why = m?.reason ? `: ${String(m.reason).trim()}` : "";
    const since = m?.started_at ? formatTime(m.started_at) : "";
    const who = m?.started_by ? ` by ${m.started_by}` : "";
    notes.push({ tone: "warn", text: `${feed.pduName} is in maintenance${why}${since || who ? ` (started${who}${since ? ` ${since}` : ""})` : ""}. Power on and cycle are refused until it is restored.` });
  }
  if (feed.protected) notes.push({ tone: "warn", text: "Protected outlet: it is never switched off from Lab Manager." });
  const b = feed.blocked || {};
  if (!feed.inMaintenance && b.on && b.on === b.off && b.off === b.cycle) notes.push({ tone: "bad", text: b.on });
  return notes;
}

export default function PowerBlock({ record, can, act }) {
  const { data } = useLabWindow();
  const group = record.powerGroup;
  const feeds = group?.feeds || [];
  const pending = act?.power?.pending || null;
  const watts = feed => record.pdu.find(p => p.device_id === feed.pduId && String(p.port) === String(feed.outlet))?.watts;
  return <WindowSection title="Power feeds" id="power">
    {feeds.length ? <ul className="srv-feeds">
      {feeds.map(f => {
        const w = watts(f);
        const notes = feedNotes(f, data?.maintenance);
        return <li key={f.id} className="srv-feed" data-feed={f.id} data-state={f.state}>
          <div className="srv-feed-line">
            <span className="srv-feed-led" data-tone={TONE(f.state)} aria-hidden="true"/>
            <span className="srv-feed-text" dir="auto"><bdi>{f.label}</bdi> · <bdi>{f.pduName}</bdi> · outlet {f.outlet} · <strong>{STATE(f.state)}</strong>{w != null ? ` · ${w} W` : ""}</span>
            {can?.operate && <span className="srv-feed-actions">
              {ACTIONS.map(([action, word]) => <button key={action} type="button" className="lab-window-btn srv-feed-btn" disabled={!!pending}
                aria-label={`${VERB[action]} feed ${f.label}`}
                onClick={e => act.power.request(action, e.currentTarget, { scope: "feed", feedId: f.id })}>{word}</button>)}
            </span>}
          </div>
          {notes.map((n, i) => <p key={i} className="srv-feed-note" data-tone={n.tone} dir="auto">{n.text}</p>)}
        </li>;
      })}
    </ul> : <p className="lab-window-muted">No PDU outlet carries this server's name, so it cannot be switched from here.</p>}
    {pending && <p className="lab-window-muted mt-2" role="status">Switching power…</p>}
  </WindowSection>;
}
