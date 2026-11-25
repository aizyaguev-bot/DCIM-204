// Activity (v1 §1.5): rendered only while the collapsible block is open, so it loads its own data on mount.
//   Monitor   MonitorDetails (status, last check, RTT, PDU / KVM links with device check times, recent checks that
//             refresh, the 60-check strip) and TargetSettings for Operators (PUT /api/monitoring/targets/{id}: explicit
//             Save, revision conflict, unticking asks first). No monitor yet: "Monitor this server" (Operator,
//             POST /api/monitoring/targets).
//   Timeline  ping incidents of this server's monitor, the removal log (Admin), "moved" entries of the units on its
//             floor and this session's Last change (server/serverHistory.js).
// Props: { record, can, act }.
import { useCallback, useEffect, useRef, useState } from "react";
import { useLabWindow } from "../../window/labWindowContext.js";
import { formatTime } from "../../window/format.js";
import { useLiveReload } from "../../api/useLiveReload.js";
import MonitorDetails, { monitorRequest } from "../../components/monitoring/MonitorDetails.jsx";
import TargetSettings from "../../components/monitoring/TargetSettings.jsx";
import { ELSEWHERE_NOTE, buildTimeline, defaultMonitorHost } from "../serverHistory.js";
import "../server-ops.css";

// More › Monitor settings (PowerAction): open the Activity block and bring its monitor into view, focused on the
// address (or on "Monitor this server"). The block focuses it itself once its content is final: the monitor list may
// still be loading when the block mounts, and "Monitor this server" must not take the focus a moment before the
// settings replace it. A request is honoured for a few seconds only.
const REVEAL_EVENT = "dcim-server-reveal-monitor";
let revealWanted = 0;
export function revealMonitor(doc = typeof document !== "undefined" ? document : null) {
  const details = doc?.querySelector('[data-window="server"] details[data-section="activity"]');
  if (!details) return false;
  revealWanted = Date.now();
  if (details.open) window.dispatchEvent(new Event(REVEAL_EVENT));
  else details.open = true;   // the block mounts ActivitySection, which reveals on mount
  return true;
}

// "Monitor this server": the address to ping (the server's name as a DNS name by default) and its rack.
function AddMonitor({ record, act, reload }) {
  const [host, setHost] = useState(() => defaultMonitorHost(record));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await act.during(async () => {
        await monitorRequest("/targets", "POST", { name: record.name, host: host.trim(), rack: record.drawn?.rack || record.rack || "" });
        await reload();
      });
      act.toast?.(`${record.name} is monitored now (${host.trim()}).`);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }
  return <form onSubmit={save} className="srv-monitor-add" data-monitor-add="">
    <p className="lab-window-muted">This server has no ping monitor.</p>
    <label className="srv-field">IP address or DNS hostname
      <input className="lab-window-search" aria-label={`Address to monitor ${record.name}`} value={host} onChange={e => setHost(e.target.value)}
        required maxLength={253} placeholder="e.g. opt133 or 10.7.30.25" disabled={busy}/>
    </label>
    <button type="submit" className="lab-window-btn" data-tone="accent" disabled={busy || !host.trim()}>{busy ? "Adding…" : "Monitor this server"}</button>
    {error && <p role="alert" className="srv-error">{error}</p>}
  </form>;
}

// The incidents of one monitor: read on mount and when the change feed reports a monitoring change.
function useIncidents(targetId) {
  const [state, setState] = useState({ rows: [], error: "", loaded: false });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!targetId) { setState({ rows: [], error: "", loaded: true }); return; }
    const turn = ++seq.current;
    try {
      const rows = await monitorRequest(`/incidents?target_id=${encodeURIComponent(targetId)}&limit=100`);
      if (turn === seq.current) setState({ rows: Array.isArray(rows) ? rows : [], error: "", loaded: true });
    } catch (e) {
      if (turn === seq.current) setState(s => ({ ...s, error: e.message, loaded: true }));
    }
  }, [targetId]);
  useEffect(() => { load(); }, [load]);
  useLiveReload(["monitoring"], load);
  return state;
}

export default function ActivitySection({ record, can, act }) {
  const lab = useLabWindow();
  const rootRef = useRef(null);
  const monitor = record.monitor;
  const timezone = lab.data?.monitoring?.timezone || undefined;
  const incidents = useIncidents(monitor?.id || null);
  const reloadMonitoring = useCallback(() => lab.reload(["monitoring"]), [lab.reload]);
  // The monitor list (GET /api/monitoring) may arrive after the server list: until then nothing says "no monitor".
  const monitoringLoaded = lab.data?.monitoring != null;
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => {
    const again = () => setRevealTick(n => n + 1);
    window.addEventListener(REVEAL_EVENT, again);
    return () => window.removeEventListener(REVEAL_EVENT, again);
  }, []);
  useEffect(() => {
    if (!revealWanted || Date.now() - revealWanted > 5000 || !monitoringLoaded) return;
    revealWanted = 0;
    const spot = rootRef.current?.querySelector("[data-activity-monitor]");
    if (!spot) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    spot.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    spot.querySelector('input[aria-label^="Address for"]:not([disabled]), [data-monitor-add] input, [data-monitor-add] button')?.focus({ preventScroll: true });
  }, [revealTick, monitoringLoaded]);
  // Opened on sec=activity (a Ping Monitor row, a shared link): bring the block into view once.
  useEffect(() => {
    if (lab.current?.sec !== "activity") return;
    const frame = requestAnimationFrame(() => rootRef.current?.closest("details")?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, []);

  const entries = buildTimeline({
    key: record.key,
    incidents: incidents.rows,
    removedLog: lab.data?.removed?.log,
    admin: !!can?.admin,
    units: record.units,
    lastChange: lab.lastChange?.(record.key),
    format: ms => formatTime(ms).replace(/^on /, ""),
  });

  return <div ref={rootRef} className="srv-activity" data-activity="">
    <section className="srv-activity-part" data-activity-monitor="" aria-label="Ping monitor">
      <h4 className="srv-activity-title">Ping monitor</h4>
      {!monitoringLoaded ? <p className="lab-window-muted" role="status">{lab.errors?.monitoring ? `The ping monitor could not load: ${lab.errors.monitoring}` : "Loading the ping monitor…"}</p>
        : monitor ? <MonitorDetails key={monitor.id} target={monitor} timezone={timezone} compact headingLevel={4}
        settings={can?.operate ? <TargetSettings key={monitor.id} target={monitor} onSaved={reloadMonitoring} during={act.during}/> : null}/>
        : can?.operate ? <AddMonitor record={record} act={act} reload={reloadMonitoring}/>
        : <p className="lab-window-muted">This server has no ping monitor.</p>}
    </section>
    <section className="srv-activity-part" data-activity-timeline="" aria-label="Timeline">
      <h4 className="srv-activity-title">Timeline</h4>
      {incidents.error && <p role="alert" className="srv-error">Incidents could not load: {incidents.error}</p>}
      {entries.length ? <ol className="srv-timeline">
        {entries.map(e => <li key={e.id} className="srv-event" data-kind={e.kind} data-tone={e.tone}>
          <span className="srv-event-title" dir="auto">{e.title}</span>
          {e.at != null && <time className="srv-event-time" dateTime={new Date(e.at).toISOString()}>{formatTime(e.at).replace(/^on /, "")}</time>}
          {e.detail && <span className="srv-event-detail" dir="auto">{e.detail}</span>}
        </li>)}
      </ol> : <p className="lab-window-muted">{!monitoringLoaded || (monitor && !incidents.loaded) ? "Loading…" : "Nothing recorded for this server yet."}</p>}
      <p className="lab-window-muted mt-2">{ELSEWHERE_NOTE}</p>
    </section>
  </div>;
}
