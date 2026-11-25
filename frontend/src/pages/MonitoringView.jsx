import { useEffect, useId, useRef, useState } from "react";
import {useAccounts} from "../accounts";
import { useRemovedServers } from "../removedServers.jsx";
import { withoutRemovedTargets } from "../api/removedServers.js";
import { useLiveReload } from "../api/useLiveReload";
import { isPlaceholderMonitor } from "../labDisplay.js";
import { useLabWindow } from "../window/labWindowContext.js";
import MonitorDetails, { Connections, StatusBadge as Badge, elapsed, lastKnown, monitorRequest as request, when } from "../components/monitoring/MonitorDetails.jsx";
import TargetSettings from "../components/monitoring/TargetSettings.jsx";

const input = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:border-nv-400";
const button = "rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40";
const primary = "rounded-lg bg-nv-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-nv-300 disabled:opacity-40";

function AddServer({ onSaved, onClose }) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [rack, setRack] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e) {
    e.preventDefault(); setBusy(true); setError("");
    try { await request("/targets", "POST", { name, host, rack }); await onSaved(); onClose(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <form onSubmit={save} className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 space-y-4">
    <div className="grid gap-3 md:grid-cols-3">
      <label className="text-xs text-zinc-400">Server name<input className={`${input} mt-2`} value={name} onChange={e => setName(e.target.value)} required maxLength={160} disabled={busy} /></label>
      <label className="text-xs text-zinc-400">IP address / hostname<input className={`${input} mt-2`} value={host} onChange={e => setHost(e.target.value)} required maxLength={253} disabled={busy} /></label>
      <label className="text-xs text-zinc-400">Rack (optional)<input className={`${input} mt-2`} value={rack} onChange={e => setRack(e.target.value)} maxLength={120} disabled={busy} /></label>
    </div>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    <div className="flex gap-2"><button className={primary} disabled={busy}>{busy ? "Adding…" : "Add server"}</button><button type="button" className={button} onClick={onClose} disabled={busy}>Cancel</button></div>
  </form>;
}

// The side panel of a monitor that is no server (no server_key, e.g. a "device:" target). A server's monitor opens the
// server window instead (Activity), which shows the same MonitorDetails and TargetSettings.
function ServerHistory({ target, timezone, onSaved, onClose, panelRef }) {
  const {canOperate} = useAccounts();
  const headingId = useId();
  return <aside ref={panelRef} aria-labelledby={headingId} onKeyDown={e => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } }} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 min-w-0 scroll-mt-4">
    <div className="flex justify-between items-start mb-4 gap-3">
      <div className="min-w-0"><h2 id={headingId} tabIndex={-1} data-panel-heading className="font-semibold text-lg break-words rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-nv-400/60">{target.name}</h2><p className="text-xs text-zinc-500 mt-1">{target.rack || "No rack"} · <span className="font-mono">{target.host || "Address needed"}</span></p></div>
      <button className={button} onClick={onClose} aria-label="Close server details">×</button>
    </div>
    <MonitorDetails target={target} timezone={timezone} settings={canOperate ? <TargetSettings key={target.id} target={target} onSaved={onSaved} /> : null} />
  </aside>;
}

export default function MonitoringView() {
  const {canOperate,preferences} = useAccounts();
  const { hidden: removedHidden } = useRemovedServers();
  const { openServer } = useLabWindow();
  const [data, setData] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(0);
  const panelRef = useRef(null);
  const openerRef = useRef(null);
  const searchRef = useRef(null);
  const latestRefresh = useRef(0);

  async function refresh(signal) {
    // Polls and post-save refreshes overlap; only the most recently started one may update the page.
    const id = ++latestRefresh.current;
    const [next, events] = await Promise.all([request("", "GET", undefined, signal), request("/incidents", "GET", undefined, signal)]);
    if (!signal?.aborted && id === latestRefresh.current) { setData(next); setIncidents(events); setError(""); }
  }

  // A server's monitor (server_key) opens the server window on Activity (the monitor, its settings and its history);
  // a monitor that is no server keeps the side panel here.
  function openDetails(id, event) {
    const target = (data?.targets || []).find(t => t.id === id);
    if (target?.server_key) { openServer(target.server_key, { sec: "activity" }); return; }
    openerRef.current = event?.currentTarget || null;
    setSelectedId(id);
    setReveal(n => n + 1);
  }
  function closeDetails() {
    const opener = openerRef.current;
    openerRef.current = null;
    setSelectedId(null);
    (opener?.isConnected ? opener : searchRef.current)?.focus();
  }
  // The panel sits beside the table on wide screens and below it otherwise: bring it into view and move focus to it.
  useEffect(() => {
    const panel = panelRef.current;
    if (!reveal || !panel) return;
    const top = panel.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight / 3) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      panel.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }
    panel.querySelector("[data-panel-heading]")?.focus({ preventScroll: true });
  }, [reveal]);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try { await refresh(controller.signal); }
      catch (e) { if (!controller.signal.aborted) setError(e.message); }
      finally { pending = false; }
    }
    load(); const timer = setInterval(load, preferences.refresh_seconds * 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [preferences.refresh_seconds]);

  // Live sync: a server moved, swapped, renamed or relabelled anywhere, or a monitor changed, shows here at once (the Rack
  // column follows the rack layout). An open settings form keeps what is typed in it (TargetSettings).
  useLiveReload(["monitoring", "layout", "devices", "removed", "power"], () => refresh().catch(e => setError(e.message)));

  async function check() {
    setBusy(true); setError(""); setNotice("");
    try { await request("/check", "POST"); await refresh(); setNotice("Check queued. Results refresh automatically every 15 seconds."); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  // Servers an Admin removed from the lab are not listed (their monitors are paused, history kept). Nor are monitors
  // imported for placeholder labels ("empty", "KVM Power", "OptXXX"): no servers, the next check deletes them. A
  // monitor added by hand stays listed whatever its name, so it can still be edited or paused here.
  const placeholderIds = new Set((data?.targets || []).filter(isPlaceholderMonitor).map(t => t.id));
  const targets = withoutRemovedTargets(data?.targets || [], removedHidden).filter(t => !placeholderIds.has(t.id));
  const shownIncidents = incidents.filter(i => !placeholderIds.has(i.target_id));
  const timezone = data?.timezone || "Asia/Jerusalem";
  const selected = targets.find(t => t.id === selectedId);
  const attention = t => ["error", "stale", "unconfigured", "pending"].includes(t.status) || ["pdu", "kvm"].some(kind => !t[kind]?.length || t[kind].some(link => !["on", "active", "idle"].includes(link.status)));
  const visible = targets.filter(t => `${t.name} ${t.host} ${t.rack}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "attention" ? attention(t) : t.status === filter)));
  const problem = data && ["disabled", "not_started", "overdue", "error"].includes(data.service);
  return <main className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-5">
    <div className="flex flex-wrap justify-between items-start gap-4">
      <div><div className="text-xs text-nv-400 uppercase tracking-widest font-semibold mb-2">Network monitoring</div><h1 className="text-2xl font-semibold text-zinc-100">Server health</h1><p className="text-sm text-zinc-400 mt-2 max-w-2xl">Ping, PDU outlet power and KVM port observations for each server. Device connections are matched by server name.</p></div>
      {canOperate && <div className="flex gap-2"><button className={button} onClick={() => setAdding(!adding)}>+ Add server</button><button className={primary} onClick={check} disabled={busy || !data || data.service === "running" || data.service === "disabled"}>{busy ? "Queueing…" : data?.service === "running" ? "Checking…" : "Check all now"}</button></div>}
    </div>
    {error && <div role="alert" className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">Monitoring could not refresh: {error}. Previously displayed results may be out of date.</div>}
    {notice && <div role="status" className="text-sm text-nv-400">{notice}</div>}
    {problem && <div role="alert" className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-300">{data.service === "disabled"
      ? "Monitoring is turned off in the server configuration, so no checks run. Ask a lab administrator to enable it."
      : <>Monitor {data.service.replaceAll("_", " ")}. {data.error || "Check that the Lab Manager backend is running and monitoring is enabled."}</>}</div>}
    {adding && <AddServer onSaved={refresh} onClose={() => setAdding(false)} />}
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm"><div><span className="text-zinc-500 text-xs block mb-1">07:00–20:00</span><strong className="font-medium">Every 5 minutes</strong></div><div><span className="text-zinc-500 text-xs block mb-1">20:00–07:00</span><strong className="font-medium">Every 30 minutes</strong></div><div><span className="text-zinc-500 text-xs block mb-1">Timezone · every day</span><strong className="font-medium">{timezone}</strong></div></div>
      <div className="text-xs text-zinc-400 space-y-1"><p>Next check: <span className="text-zinc-200">{when(data?.next_run_at, timezone)}</span></p><p>Last round completed: {when(data?.last_completed_at, timezone)}</p></div>
    </section>
    {data?.email_alerts && <section aria-label="Email alerts" className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap justify-between gap-3"><h2 className="font-semibold">Email alerts</h2><span className={`text-xs ${data.email_alerts.ready ? "text-nv-300" : "text-amber-300"}`}>{data.email_alerts.enabled ? data.email_alerts.ready ? `Configured · worker ${data.email_alerts.worker.replaceAll("_", " ")}` : "Setup required" : "Not enabled"}</span></div>
      <p className="mt-2 text-sm text-zinc-400 break-words">Recipient: {data.email_alerts.recipient}</p>
      <p className="mt-2 text-xs text-zinc-500">{data.email_alerts.minute_probes ? "Additional ping checks every minute, 24/7. Alert after failures span more than 5 minutes." : "Uses scheduled checks. Nighttime outage alerts can be delayed by the 30-minute interval."} One notification per incident, followed by a recovery message.</p>
      <p className="mt-2 text-xs text-zinc-500">PDU and KVM API failures also alert after failed checks span more than 5 minutes. These checks use the 5/30-minute schedule, so notification can be delayed. An API failure does not prove that a server has lost power.</p>
      <p className="mt-2 text-xs text-zinc-500">{data.email_alerts.power_rules.length ? `PDU inlet thresholds: ${data.email_alerts.power_rules.map(r=>`${r.metric} ${r.side} ${r.value} ${r.unit}`).join(" · ")}` : "Electrical alerts await configured voltage, current or power thresholds."}</p>
      {!data.email_alerts.ready && data.email_alerts.problems.length > 0 && <p className="mt-2 text-xs text-amber-300">{data.email_alerts.problems.join(" · ")}</p>}
      <details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer">Delivery log · {data.email_alerts.pending} pending</summary>
        <div className="mt-3 space-y-2">{data.email_alerts.recent.length ? data.email_alerts.recent.map(row=><div key={row.id} className="border-t border-zinc-800 pt-2"><p className="break-words">{row.subject}</p><p className="text-zinc-500 mt-1">{when(row.created_at, timezone)} · {row.sent_at ? "Accepted by mail relay" : row.error ? `Retry pending (${row.error})` : "Queued"}</p></div>) : <p>No emails queued yet.</p>}</div>
      </details>
    </section>}
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[["Registered servers", targets.length, "text-zinc-100"], ["Ping reachable", targets.filter(t => t.status === "up").length, "text-emerald-300"], ["No reply", targets.filter(t => t.status === "down").length, "text-rose-300"], ["Needs attention", targets.filter(attention).length, "text-amber-300"]].map(([label, count, color]) => <div key={label} className="rounded-xl border border-zinc-800 p-4"><div className="text-xs text-zinc-500">{label}</div><div className={`text-3xl font-semibold mt-2 tabular-nums ${color}`}>{data ? count : "—"}</div></div>)}
    </div>
    <div className={`grid gap-5 items-start ${selected ? "xl:grid-cols-[minmax(0,1fr)_390px]" : ""}`}>
      <section className="rounded-xl border border-zinc-800 overflow-hidden min-w-0">
        <div className="p-4 flex flex-wrap items-center gap-3 border-b border-zinc-800"><h2 className="font-semibold mr-auto">Servers <span className="text-zinc-500 font-normal text-sm">{visible.length}</span></h2><input ref={searchRef} aria-label="Search monitored servers" placeholder="Search name, IP, rack…" value={query} onChange={e => setQuery(e.target.value)} className={`${input} sm:!w-60`} /><select aria-label="Filter server status" value={filter} onChange={e => setFilter(e.target.value)} className={`${input} !w-auto`}><option value="all">All statuses</option><option value="up">Reachable</option><option value="down">No reply</option><option value="attention">Needs attention</option><option value="paused">Paused</option></select></div>
        <div className="relative overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-zinc-900/60 text-xs text-zinc-500"><tr>{["Server / address", "Rack", "Ping", "PDU", "KVM", "Last ping", "RTT", ""].map((h, i) => <th key={i} scope="col" className="px-4 py-3 font-medium">{h || <span className="sr-only">Details</span>}</th>)}</tr></thead><tbody>
          {visible.map(t => <tr key={t.id} className={`border-t border-zinc-800/60 ${selectedId === t.id ? "bg-nv-400/5" : "hover:bg-zinc-900/50"}`}><td className="px-4 py-3"><button onClick={e => openDetails(t.id, e)} className="font-medium text-zinc-100 hover:text-nv-400 text-left" aria-label={`View history for ${t.name}`}>{t.name}</button><div className="font-mono text-xs text-zinc-500 mt-1">{t.host || "Set an address →"}</div></td><td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{t.rack || "—"}</td><td className="px-4 py-3"><Badge status={t.status} />{lastKnown(t) && <div className="text-xs text-rose-300 mt-1 whitespace-nowrap">{lastKnown(t)}</div>}</td>{["pdu", "kvm"].map(kind => <td key={kind} className="px-4 py-3 align-top"><Connections links={t[kind]} kind={kind} timezone={timezone} /></td>)}<td className="px-4 py-3 text-xs text-zinc-400 whitespace-nowrap">{when(t.checked_at, timezone)}</td><td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{t.rtt_ms != null ? `${t.rtt_ms} ms` : "—"}</td><td className="px-4 py-3"><button className="text-xs text-nv-400 hover:underline" onClick={e => openDetails(t.id, e)} aria-label={`Configure ${t.name}`}>Details</button></td></tr>)}
          {!visible.length && <tr><td colSpan={8} className="px-5 py-10 text-center text-zinc-500">{!data ? "Loading monitor…" : targets.length ? "No servers match this filter." : "Servers are imported from PDU/KVM labels and computer inventory during a check. You can also add a server here."}</td></tr>}
        </tbody></table></div>
        <p className="px-4 py-3 text-xs text-zinc-500 border-t border-zinc-800">Click a server to open its window: its address, pause and check history are under Activity. A monitor that is not a server opens a panel here. All matching outlets and ports are listed. Not linked means no matching port label; configured or unverified KVM ports have no confirmed live state. Details show each device check time.</p>
      </section>
      {selected && <ServerHistory key={selected.id} panelRef={panelRef} target={selected} timezone={timezone} onSaved={refresh} onClose={closeDetails} />}
    </div>
    <section className="rounded-xl border border-zinc-800 overflow-hidden">
      <div className="p-4 border-b border-zinc-800 flex flex-wrap justify-between items-center gap-3"><div><h2 className="font-semibold">Ping failure & recovery log</h2><p className="text-xs text-zinc-500 mt-1">Latest 200 incidents across all servers · closed incidents retained for 90 days</p></div><a href="/api/monitoring/incidents.csv" className={button} download>Export CSV</a></div>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="text-xs text-zinc-500 bg-zinc-900/60"><tr>{["Server", "First failed check", "Last failed check", "First reply / closed", "Observed window", "Failed checks"].map(h => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{shownIncidents.map(i => <tr key={i.id} className="border-t border-zinc-800/60"><td className="px-4 py-3"><button onClick={e => openDetails(i.target_id, e)} className="font-medium hover:text-nv-400">{i.name}</button><div className="text-xs font-mono text-zinc-500 mt-1">{i.host}</div></td><td className="px-4 py-3 text-xs whitespace-nowrap text-rose-300">{when(i.first_failed_at, timezone)}</td><td className="px-4 py-3 text-xs whitespace-nowrap text-zinc-400">{when(i.last_failed_at, timezone)}</td><td className="px-4 py-3 text-xs whitespace-nowrap">{i.ended_at ? <><span className={i.end_reason === "recovered" ? "text-emerald-300" : "text-zinc-400"}>{when(i.ended_at, timezone)}</span><div className="text-zinc-500 mt-1">{i.end_reason === "recovered" ? "Reply received" : i.end_reason?.replaceAll("_", " ")}</div></> : <span className="text-rose-300">No recovery observed</span>}</td><td className="px-4 py-3 text-xs text-zinc-400 whitespace-nowrap">{elapsed(i.observed_seconds)}</td><td className="px-4 py-3 text-zinc-400 tabular-nums">{i.failed_checks}</td></tr>)}{!shownIncidents.length && <tr><td colSpan={6} className="text-center text-zinc-500 px-5 py-8">{data ? "No failed ICMP checks recorded yet." : "Loading incidents…"}</td></tr>}</tbody></table></div>
    </section>
    <p className="text-xs text-zinc-500 leading-relaxed max-w-4xl">PDU power and KVM observations do not verify the operating system, applications or a working remote console session. A missing ICMP reply indicates a reachability problem, not necessarily a server crash. Brief failures between checks may be missed. Incident windows show observations at check times; they do not establish continuous downtime or the exact failure time. DNS or local probe errors appear separately. Monitoring continues while the backend is running, even with this page closed.</p>
  </main>;
}
