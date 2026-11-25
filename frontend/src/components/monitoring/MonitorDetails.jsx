// One ping monitor in detail: its status, the PDU / KVM links with each device's check time, the settings form (passed
// in), the strip of the last 60 checks and the recent checks, which refresh on their own. Used by the server window's
// Activity block and by Ping Monitor's side panel (monitors that are no server). Extracted from pages/MonitoringView.jsx
// (its ServerHistory body); the page and the window share it, so nothing is lost either way.
import { useCallback, useEffect, useState } from "react";
import { useAccounts } from "../../accounts";
import { useLiveReload } from "../../api/useLiveReload";
import { checkStrip } from "../../server/serverHistory.js";

// GET / PUT / POST under /api/monitoring. Errors carry the server's detail and the HTTP status.
export async function monitorRequest(path = "", method = "GET", body, signal) {
  const response = await fetch(`/api/monitoring${path}`, {
    method, signal, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = typeof data.detail === "string" ? data.detail : data.detail?.map(e => e.msg).join("; ");
    const error = new Error(detail || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export const MONITOR_STATES = {
  up: ["Reachable", "text-emerald-300 bg-emerald-400/10", "bg-emerald-400"],
  down: ["No reply", "text-rose-300 bg-rose-400/10", "bg-rose-400"],
  error: ["Probe error", "text-amber-300 bg-amber-400/10", "bg-amber-400"],
  stale: ["Overdue", "text-amber-300 bg-amber-400/10", "bg-amber-400"],
  pending: ["Awaiting check", "text-zinc-400 bg-zinc-800", "bg-zinc-600"],
  unconfigured: ["Needs address", "text-amber-300 bg-amber-400/10", "bg-amber-400"],
  paused: ["Paused", "text-zinc-400 bg-zinc-800", "bg-zinc-600"],
};

// An overdue check hides the last ping result from the status; keep a failed reply visible.
export function lastKnown(target) {
  return target.status === "stale" && target.last_result === "down" ? `Last known: ${MONITOR_STATES.down[0]}` : "";
}

export function StatusBadge({ status }) {
  const [label, color, dot] = MONITOR_STATES[status] || MONITOR_STATES.pending;
  return <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs whitespace-nowrap ${color}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{label}
  </span>;
}

export function when(value, timezone) {
  return value ? new Date(value).toLocaleString(undefined, { timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
}

export function elapsed(seconds) {
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

// The PDU outlets or KVM ports a monitor is linked to by name; expanded adds each device's address and check time.
export function Connections({ links = [], kind, timezone, expanded = false }) {
  if (!links.length) return <span className="text-xs text-amber-300" title={`No ${kind.toUpperCase()} port label matches this server name.`}>Not linked</span>;
  return <div className="space-y-3 min-w-40">{links.map(link => {
    const [label, color] = connectionStates[link.status] || connectionStates.unknown;
    return <div key={`${link.device_id}-${link.port}`} title={`${link.detail} Checked: ${when(link.checked_at, timezone)}`}>
      <span className={`inline-block rounded-full px-2.5 py-1 text-xs whitespace-nowrap ${color}`}>{label}</span>
      <p className="mt-1 text-xs text-zinc-400 break-words">{link.device_name} · {kind === "pdu" ? "Outlet" : "Port"} {link.port}</p>
      {expanded && <p className="text-xs text-zinc-500 mt-1">{link.device_ip} · Checked {when(link.checked_at, timezone)}</p>}
      {(expanded || link.status === "error") && <p className="text-xs text-zinc-400 mt-1 max-w-64">{link.detail}</p>}
    </div>;
  })}</div>;
}

// The recent checks of one monitor: read now, every refresh_seconds, and when the change feed reports a monitoring
// change (a finished round, an address change). Returns { history, error }.
function useCheckHistory(targetId) {
  const { preferences } = useAccounts();
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const again = useCallback(() => setTick(n => n + 1), []);
  useLiveReload(["monitoring"], again);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try { const rows = await monitorRequest(`/targets/${encodeURIComponent(targetId)}/history`, "GET", undefined, controller.signal); if (!controller.signal.aborted) { setHistory(rows); setError(""); } }
      catch (e) { if (!controller.signal.aborted) setError(e.message); }
      finally { pending = false; }
    }
    load(); const timer = setInterval(load, (preferences.refresh_seconds || 15) * 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [targetId, preferences.refresh_seconds, tick]);
  return { history, error };
}

// target: a GET /api/monitoring target. settings: the form shown between the links and the checks (TargetSettings,
// for roles that may edit). compact: shorter lists for a window. headingLevel: 3 (page panel) or 4 (inside a window
// section).
export default function MonitorDetails({ target, timezone, settings = null, compact = false, headingLevel = 3 }) {
  const { history, error } = useCheckHistory(target.id);
  const known = lastKnown(target);
  const H = headingLevel >= 4 ? "h4" : "h3";
  return <div className="min-w-0" data-monitor-details={target.id}>
    <div className="mb-4"><StatusBadge status={target.status} />{known && <p className="text-xs text-rose-300 mt-2">{known}</p>}{target.detail && <p className="text-xs text-zinc-400 mt-2 break-words">{target.detail}</p>}
      <p className="text-xs text-zinc-500 mt-2">Last check: {when(target.checked_at, timezone)}{target.rtt_ms != null ? ` · RTT ${target.rtt_ms} ms` : ""} · <span className="font-mono">{target.host || "Address needed"}</span></p>
    </div>
    <div className={`space-y-4 mb-5 border-b border-zinc-800 pb-5 ${compact ? "sm:grid sm:grid-cols-2 sm:gap-4 sm:space-y-0" : ""}`}>{["pdu", "kvm"].map(kind => <section key={kind} aria-label={`${kind.toUpperCase()} connections for ${target.name}`}><H className="text-sm font-semibold mb-2">{kind.toUpperCase()}</H><Connections links={target[kind] || []} kind={kind} timezone={timezone} expanded /></section>)}</div>
    {settings}
    <H className="text-sm font-semibold">Recent checks</H>
    <p className="text-xs text-zinc-500 mt-1">Latest 200 checks · stored for 30 days</p>
    {error && <p role="alert" className="text-sm text-rose-300 mt-3">History could not refresh: {error}</p>}
    {history?.length > 0 && <div className="flex gap-1 h-7 mt-4" aria-label="Last 60 check results, oldest to newest" data-check-strip="">
      {checkStrip(history, 60).map(row => <div key={row.id} className={`flex-1 rounded-sm min-w-0 ${MONITOR_STATES[row.status]?.[2] || "bg-zinc-700"}`} title={`${when(row.checked_at, timezone)} · ${MONITOR_STATES[row.status]?.[0]}`} />)}
    </div>}
    <div className={`${compact ? "max-h-[300px]" : "max-h-[420px]"} overflow-y-auto mt-4 space-y-3`}>
      {history === null && !error && <p className="text-sm text-zinc-500">Loading checks…</p>}
      {history?.length === 0 && <p className="text-sm text-zinc-500">No checks yet. Save an address, then use “Check all now” on Ping Monitor or wait for the next scheduled check.</p>}
      {history?.map(row => <div key={row.id} className="border-b border-zinc-800/60 pb-3">
        <div className="flex items-center justify-between gap-2 text-xs"><time className="text-zinc-400">{when(row.checked_at, timezone)}</time><StatusBadge status={row.status} /></div>
        <p className="mt-1 text-xs text-zinc-500 font-mono">{row.host}{row.rtt_ms != null ? ` · ${row.rtt_ms} ms` : ""}</p>
        {row.detail && <p className="text-xs text-zinc-500 mt-1 break-words">{row.detail}</p>}
      </div>)}
    </div>
  </div>;
}
