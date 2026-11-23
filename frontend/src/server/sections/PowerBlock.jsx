// STUB (WP-0, read-only). WP-3 replaces it: one row per feed with state, W and the maintenance or protection reason,
// and per-feed power through act.power.request(action, opener, { scope: "feed", feedId }). Props: { record, can, act }.
import { WindowSection } from "../../window/WindowShell.jsx";

const STATE = s => (s === "on" ? "On" : s === "off" ? "Off" : "Unknown");

export default function PowerBlock({ record }) {
  const feeds = record.powerGroup?.feeds || [];
  return <WindowSection title="Power feeds" id="power">
    {feeds.length ? <ul className="m-0 p-0 list-none">
      {feeds.map(f => <li key={f.id} dir="auto">{f.pduName} · outlet {f.outlet} · {STATE(f.state)}{f.inMaintenance ? " · Maintenance" : ""}</li>)}
    </ul> : <p className="lab-window-muted">No PDU outlet carries this server's name.</p>}
  </WindowSection>;
}
