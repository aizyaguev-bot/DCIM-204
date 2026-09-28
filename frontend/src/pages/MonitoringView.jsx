import { useEffect, useState } from "react";

const input = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:border-nv-400";
const button = "rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40";
const primary = "rounded-lg bg-nv-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-nv-300 disabled:opacity-40";
const states = {
  up: ["Reachable", "text-emerald-300 bg-emerald-400/10", "bg-emerald-400"],
  down: ["No reply", "text-rose-300 bg-rose-400/10", "bg-rose-400"],
  error: ["Probe error", "text-amber-300 bg-amber-400/10", "bg-amber-400"],
  stale: ["Overdue", "text-amber-300 bg-amber-400/10", "bg-amber-400"],
  pending: ["Awaiting check", "text-zinc-400 bg-zinc-800", "bg-zinc-600"],
  unconfigured: ["Needs address", "text-amber-300 bg-amber-400/10", "bg-amber-400"],
  paused: ["Paused", "text-zinc-400 bg-zinc-800", "bg-zinc-600"],
};

async function request(path = "", method = "GET", body, signal) {
  const response = await fetch(`/api/monitoring${path}`, {
    method, signal, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = typeof data.detail === "string" ? data.detail : data.detail?.map(e => e.msg).join("; ");
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return response.json();
}

function Badge({ status }) {
  const [label, color, dot] = states[status] || states.pending;
  return <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs whitespace-nowrap ${color}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{label}
  </span>;
}

function when(value, timezone) {
  return value ? new Date(value).toLocaleString(undefined, { timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
}

function elapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const connectionStates = {
  on: ["Power on", "text-emerald-300 bg-emerald-400/10"],
  off: ["Power off", "text-rose-300 bg-rose-400/10"],
  cycling: ["Cycling", "text-amber-300 bg-amber-400/10"],
  active: ["Port active", "text-emerald-300 bg-emerald-400/10"],
  idle: ["Port idle", "text-emerald-300 bg-emerald-400/10"],
  configured: ["Configured · unverified", "text-amber-300 bg-amber-400/10"],
  empty: ["No target", "text-rose-300 bg-rose-400/10"],
  error: ["Check failed", "text-rose-300 bg-rose-400/10"],
  stale: ["Overdue", "text-amber-300 bg-amber-400/10"],
  unknown: ["Port unverified", "text-amber-300 bg-amber-400/10"],
  pending: ["Awaiting check", "text-zinc-400 bg-zinc-800"],
  disabled: ["Disabled", "text-zinc-400 bg-zinc-800"],
};

function Connections({ links = [], kind, timezone, expanded = false }) {
  if (!links.length) return <span className="text-xs text-amber-300" title={`No ${kind.toUpperCase()} port label matches this server name.`}>Not linked</span>;
  return <div className="space-y-3 min-w-40">{links.map(link => {
    const [label, color] = connectionStates[link.status] || connectionStates.unknown;
    return <div key={`${link.device_id}-${link.port}`} title={`${link.detail} Checked: ${when(link.checked_at, timezone)}`}>
      <span className={`inline-block rounded-full px-2.5 py-1 text-xs whitespace-nowrap ${color}`}>{label}</span>
      <p className="mt-1 text-xs text-zinc-400 break-words">{link.device_name} · {kind === "pdu" ? "Outlet" : "Port"} {link.port}</p>
      {expanded && <><p className="text-xs text-zinc-500 mt-1">{link.device_ip} · Checked {when(link.checked_at, timezone)}</p><p className="text-xs text-zinc-400 mt-1">{link.detail}</p></>}
    </div>;
  })}</div>;
}

function TargetSettings({ target, onSaved }) {
  const [host, setHost] = useState(target.host);
  const [enabled, setEnabled] = useState(target.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await request(`/targets/${target.id}`, "PUT", { host, enabled, revision: target.revision });
      await onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <form onSubmit={save} className="space-y-3 border-b border-zinc-800 pb-5 mb-5">
    <label className="block text-xs text-zinc-400">IP address or DNS hostname
      <input aria-label={`Address for ${target.name}`} className={`${input} mt-2`} value={host} onChange={e => setHost(e.target.value)} maxLength={253} placeholder="e.g. opt133 or 10.7.30.25" disabled={busy} />
    </label>
    <div className="flex items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={busy} />Monitor this server</label>
      <button className={button} disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
    </div>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
  </form>;
}

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

function ServerHistory({ target, timezone, onSaved, onClose }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try { const rows = await request(`/targets/${target.id}/history`, "GET", undefined, controller.signal); if (!controller.signal.aborted) { setHistory(rows); setError(""); } }
      catch (e) { if (!controller.signal.aborted) setError(e.message); }
      finally { pending = false; }
    }
    load(); const timer = setInterval(load, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [target.id]);
  return <aside className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 min-w-0">
    <div className="flex justify-between items-start mb-4 gap-3">
      <div><h2 className="font-semibold text-lg break-words">{target.name}</h2><p className="text-xs text-zinc-500 mt-1">{target.rack || "No rack"} · <span className="font-mono">{target.host || "Address needed"}</span></p></div>
      <button className={button} onClick={onClose} aria-label="Close server details">×</button>
    </div>
    <div className="mb-4"><Badge status={target.status} />{target.detail && <p className="text-xs text-zinc-400 mt-2 break-words">{target.detail}</p>}</div>
    <div className="space-y-4 mb-5 border-b border-zinc-800 pb-5">{["pdu", "kvm"].map(kind => <section key={kind} aria-label={`${kind.toUpperCase()} connections for ${target.name}`}><h3 className="text-sm font-semibold mb-2">{kind.toUpperCase()}</h3><Connections links={target[kind]} kind={kind} timezone={timezone} expanded /></section>)}</div>
    <TargetSettings key={`${target.id}-${target.revision}`} target={target} onSaved={onSaved} />
    <h3 className="text-sm font-semibold">Recent checks</h3>
    <p className="text-xs text-zinc-500 mt-1">Latest 200 checks · stored for 30 days</p>
    {error && <p role="alert" className="text-sm text-rose-300 mt-3">History could not refresh: {error}</p>}
    {history?.length > 0 && <div className="flex gap-1 h-7 mt-4" aria-label="Last 60 check results, oldest to newest">
      {history.slice(0, 60).reverse().map(row => <div key={row.id} className={`flex-1 rounded-sm min-w-0 ${states[row.status]?.[2] || "bg-zinc-700"}`} title={`${when(row.checked_at, timezone)} · ${states[row.status]?.[0]}`} />)}
    </div>}
    <div className="max-h-[420px] overflow-y-auto mt-4 space-y-3">
      {history === null && !error && <p className="text-sm text-zinc-500">Loading checks…</p>}
      {history?.length === 0 && <p className="text-sm text-zinc-500">No checks yet. Save an address, then use “Check all now” or wait for the next scheduled check.</p>}
      {history?.map(row => <div key={row.id} className="border-b border-zinc-800/60 pb-3">
        <div className="flex items-center justify-between gap-2 text-xs"><time className="text-zinc-400">{when(row.checked_at, timezone)}</time><Badge status={row.status} /></div>
        <p className="mt-1 text-xs text-zinc-500 font-mono">{row.host}{row.rtt_ms != null ? ` · ${row.rtt_ms} ms` : ""}</p>
        {row.detail && <p className="text-xs text-zinc-500 mt-1 break-words">{row.detail}</p>}
      </div>)}
    </div>
  </aside>;
}

export default function MonitoringView() {
  const [data, setData] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh(signal) {
    const [next, events] = await Promise.all([request("", "GET", undefined, signal), request("/incidents", "GET", undefined, signal)]);
    if (!signal?.aborted) { setData(next); setIncidents(events); setError(""); }
  }
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
    load(); const timer = setInterval(load, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  async function check() {
    setBusy(true); setError(""); setNotice("");
    try { await request("/check", "POST"); await refresh(); setNotice("Check queued. Results refresh automatically every 15 seconds."); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const targets = data?.targets || [];
  const timezone = data?.timezone || "Asia/Jerusalem";
  const selected = targets.find(t => t.id === selectedId);
  const attention = t => ["error", "stale", "unconfigured", "pending"].includes(t.status) || ["pdu", "kvm"].some(kind => !t[kind]?.length || t[kind].some(link => !["on", "active", "idle"].includes(link.status)));
  const visible = targets.filter(t => `${t.name} ${t.host} ${t.rack}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "attention" ? attention(t) : t.status === filter)));
  const problem = data && ["disabled", "not_started", "overdue", "error"].includes(data.service);
  return <main className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-5">
    <div className="flex flex-wrap justify-between items-start gap-4">
      <div><div className="text-xs text-nv-400 uppercase tracking-widest font-semibold mb-2">Network monitoring</div><h1 className="text-2xl font-semibold text-zinc-100">Server health</h1><p className="text-sm text-zinc-400 mt-2 max-w-2xl">Ping, PDU outlet power and KVM port observations for each server. Device connections are matched by server name.</p></div>
      <div className="flex gap-2"><button className={button} onClick={() => setAdding(!adding)}>+ Add server</button><button className={primary} onClick={check} disabled={busy || !data || data.service === "running" || data.service === "disabled"}>{busy ? "Queueing…" : data?.service === "running" ? "Checking…" : "Check all now"}</button></div>
    </div>
    {error && <div role="alert" className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">Monitoring could not refresh: {error}. Previously displayed results may be out of date.</div>}
    {notice && <div role="status" className="text-sm text-nv-400">{notice}</div>}
    {problem && <div role="alert" className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-300">Monitor {data.service.replaceAll("_", " ")}. {data.error || "Check that the Lab Manager backend is running and monitoring is enabled."}</div>}
    {adding && <AddServer onSaved={refresh} onClose={() => setAdding(false)} />}
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm"><div><span className="text-zinc-500 text-xs block mb-1">07:00–20:00</span><strong className="font-medium">Every 5 minutes</strong></div><div><span className="text-zinc-500 text-xs block mb-1">20:00–07:00</span><strong className="font-medium">Every 30 minutes</strong></div><div><span className="text-zinc-500 text-xs block mb-1">Timezone · every day</span><strong className="font-medium">{timezone}</strong></div></div>
      <div className="text-xs text-zinc-400 space-y-1"><p>Next check: <span className="text-zinc-200">{when(data?.next_run_at, timezone)}</span></p><p>Last round completed: {when(data?.last_completed_at, timezone)}</p></div>
    </section>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[["Registered servers", targets.length, "text-zinc-100"], ["Ping reachable", targets.filter(t => t.status === "up").length, "text-emerald-300"], ["No reply", targets.filter(t => t.status === "down").length, "text-rose-300"], ["Needs attention", targets.filter(attention).length, "text-amber-300"]].map(([label, count, color]) => <div key={label} className="rounded-xl border border-zinc-800 p-4"><div className="text-xs text-zinc-500">{label}</div><div className={`text-3xl font-semibold mt-2 tabular-nums ${color}`}>{data ? count : "—"}</div></div>)}
    </div>
    <div className={`grid gap-5 items-start ${selected ? "xl:grid-cols-[minmax(0,1fr)_390px]" : ""}`}>
      <section className="rounded-xl border border-zinc-800 overflow-hidden min-w-0">
        <div className="p-4 flex flex-wrap items-center gap-3 border-b border-zinc-800"><h2 className="font-semibold mr-auto">Servers <span className="text-zinc-500 font-normal text-sm">{visible.length}</span></h2><input aria-label="Search monitored servers" placeholder="Search name, IP, rack…" value={query} onChange={e => setQuery(e.target.value)} className={`${input} sm:!w-60`} /><select aria-label="Filter server status" value={filter} onChange={e => setFilter(e.target.value)} className={`${input} !w-auto`}><option value="all">All statuses</option><option value="up">Reachable</option><option value="down">No reply</option><option value="attention">Needs attention</option><option value="paused">Paused</option></select></div>
        <div className="relative overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-zinc-900/60 text-xs text-zinc-500"><tr>{["Server / address", "Rack", "Ping", "PDU", "KVM", "Last ping", "RTT", ""].map((h, i) => <th key={i} scope="col" className="px-4 py-3 font-medium">{h || <span className="sr-only">Details</span>}</th>)}</tr></thead><tbody>
          {visible.map(t => <tr key={t.id} className={`border-t border-zinc-800/60 ${selectedId === t.id ? "bg-nv-400/5" : "hover:bg-zinc-900/50"}`}><td className="px-4 py-3"><button onClick={() => setSelectedId(t.id)} className="font-medium text-zinc-100 hover:text-nv-400 text-left" aria-label={`View history for ${t.name}`}>{t.name}</button><div className="font-mono text-xs text-zinc-500 mt-1">{t.host || "Set an address →"}</div></td><td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{t.rack || "—"}</td><td className="px-4 py-3"><Badge status={t.status} /></td>{["pdu", "kvm"].map(kind => <td key={kind} className="px-4 py-3 align-top"><Connections links={t[kind]} kind={kind} timezone={timezone} /></td>)}<td className="px-4 py-3 text-xs text-zinc-400 whitespace-nowrap">{when(t.checked_at, timezone)}</td><td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{t.rtt_ms != null ? `${t.rtt_ms} ms` : "—"}</td><td className="px-4 py-3"><button className="text-xs text-nv-400 hover:underline" onClick={() => setSelectedId(t.id)} aria-label={`Configure ${t.name}`}>Details</button></td></tr>)}
          {!visible.length && <tr><td colSpan={8} className="px-5 py-10 text-center text-zinc-500">{!data ? "Loading monitor…" : targets.length ? "No servers match this filter." : "Servers are imported from PDU/KVM labels and computer inventory during a check. You can also add a server here."}</td></tr>}
        </tbody></table></div>
        <p className="px-4 py-3 text-xs text-zinc-500 border-t border-zinc-800">Select a server to edit its address, pause checks or inspect its history. All matching outlets and ports are listed. Not linked means no matching port label; configured or unverified KVM ports have no confirmed live state. Details show each device check time.</p>
      </section>
      {selected && <ServerHistory key={selected.id} target={selected} timezone={timezone} onSaved={refresh} onClose={() => setSelectedId(null)} />}
    </div>
    <section className="rounded-xl border border-zinc-800 overflow-hidden">
      <div className="p-4 border-b border-zinc-800 flex flex-wrap justify-between items-center gap-3"><div><h2 className="font-semibold">Ping failure & recovery log</h2><p className="text-xs text-zinc-500 mt-1">Latest 200 incidents across all servers · closed incidents retained for 90 days</p></div><a href="/api/monitoring/incidents.csv" className={button} download>Export CSV</a></div>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="text-xs text-zinc-500 bg-zinc-900/60"><tr>{["Server", "First failed check", "Last failed check", "First reply / closed", "Observed window", "Failed checks"].map(h => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{incidents.map(i => <tr key={i.id} className="border-t border-zinc-800/60"><td className="px-4 py-3"><button onClick={() => setSelectedId(i.target_id)} className="font-medium hover:text-nv-400">{i.name}</button><div className="text-xs font-mono text-zinc-500 mt-1">{i.host}</div></td><td className="px-4 py-3 text-xs whitespace-nowrap text-rose-300">{when(i.first_failed_at, timezone)}</td><td className="px-4 py-3 text-xs whitespace-nowrap text-zinc-400">{when(i.last_failed_at, timezone)}</td><td className="px-4 py-3 text-xs whitespace-nowrap">{i.ended_at ? <><span className={i.end_reason === "recovered" ? "text-emerald-300" : "text-zinc-400"}>{when(i.ended_at, timezone)}</span><div className="text-zinc-500 mt-1">{i.end_reason === "recovered" ? "Reply received" : i.end_reason?.replaceAll("_", " ")}</div></> : <span className="text-rose-300">No recovery observed</span>}</td><td className="px-4 py-3 text-xs text-zinc-400 whitespace-nowrap">{elapsed(i.observed_seconds)}</td><td className="px-4 py-3 text-zinc-400 tabular-nums">{i.failed_checks}</td></tr>)}{!incidents.length && <tr><td colSpan={6} className="text-center text-zinc-500 px-5 py-8">{data ? "No failed ICMP checks recorded yet." : "Loading incidents…"}</td></tr>}</tbody></table></div>
    </section>
    <p className="text-xs text-zinc-500 leading-relaxed max-w-4xl">PDU power and KVM observations do not verify the operating system, applications or a working remote console session. A missing ICMP reply indicates a reachability problem, not necessarily a server crash. Brief failures between checks may be missed. Incident windows show observations at check times; they do not establish continuous downtime or the exact failure time. DNS or local probe errors appear separately. Monitoring continues while the backend is running, even with this page closed.</p>
  </main>;
}
