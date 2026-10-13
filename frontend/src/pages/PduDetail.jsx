import { Fragment, useState } from "react";
import StatusDot from "../components/StatusDot";
import {useAccounts} from "../accounts";
import { formatMaintenanceTime } from "../components/MaintenanceColumn";

const MAINTENANCE_BLOCKED = "PDU is in maintenance mode; restore it from the Maintenance column first";

export default function PduDetail({ device, status, maintenance, maintenanceMode, onMaintenance, onBack, onOutletAction, onDelete, onLabelsSave }) {
  const {canOperate,canAdmin} = useAccounts();
  const [editMode, setEditMode] = useState(false);
  const [draftLabels, setDraftLabels] = useState({});
  const [saving, setSaving] = useState(false);
  if (!device) return null;
  const outlets = status?.outlets || [];
  const on = outlets.filter(o => o.state === "on").length;
  const inMaintenance = !!maintenance;
  const maintenanceReady = canOperate && maintenanceMode != null && maintenanceMode !== "unavailable";
  const maintenanceHint = maintenanceMode === "unavailable" ? "Maintenance actions require a configured password"
    : maintenanceMode == null ? "Maintenance state is not loaded yet" : undefined;

  function startEdit() {
    const current = {};
    outlets.forEach(o => { current[o.number] = o.label || ""; });
    setDraftLabels(current);
    setEditMode(true);
  }

  async function saveLabels() {
    setSaving(true);
    try {
      await onLabelsSave(draftLabels);
      setEditMode(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex-1 px-6 py-5 max-w-[1600px] w-full mx-auto">
      <BackBar onBack={onBack} crumbs={["Dashboard", device.name]} />
      {inMaintenance && (
        <div role="status" className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0 text-sm">
            <div className="font-semibold text-amber-300">
              In maintenance since {formatMaintenanceTime(maintenance.started_at)}{maintenance.started_by ? ` by ${maintenance.started_by}` : ""}
            </div>
            {maintenance.reason && <div className="text-zinc-300 break-words">{maintenance.reason}</div>}
            <div className="text-xs text-zinc-400 mt-0.5">
              {(maintenance.outlets_off || []).length} outlet{(maintenance.outlets_off || []).length === 1 ? "" : "s"} will be restored: {(maintenance.outlets_off || []).join(", ") || "none"}
              {maintenance.failed?.length > 0 && <span className="text-rose-300"> · Failed outlets: {maintenance.failed.join(", ")}</span>}
            </div>
          </div>
          {canOperate && (
            <button type="button" disabled={!maintenanceReady} title={maintenanceHint} onClick={() => onMaintenance("restore")}
              className="text-sm px-3.5 py-1.5 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium disabled:opacity-50">
              Restore power
            </button>
          )}
        </div>
      )}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-5">
        <section className="lg:col-span-2 bg-zinc-900/70 border border-zinc-800 rounded-xl">
          <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">{device.name}</div>
              <div className="text-xs text-zinc-500">{device.model} · {device.ip}</div>
            </div>
            <a href={`https://${device.ip}/`} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 hover:text-nv-400">
              Open native UI ↗
            </a>
          </div>
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">Outlets</div>
              {!editMode ? (
                <button disabled={!canOperate} onClick={startEdit}
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-nv-400 px-2 py-1 rounded hover:bg-zinc-800 transition">
                  <PencilIcon /> Edit Labels
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button onClick={() => setEditMode(false)}
                    className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">
                    Cancel
                  </button>
                  <button onClick={saveLabels} disabled={saving}
                    className="text-xs bg-nv-400 hover:bg-nv-300 text-zinc-950 font-semibold px-3 py-1 rounded transition disabled:opacity-50">
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
            </div>
            {outlets.length === 0 ? (
              <div className="text-zinc-600 text-sm text-center py-8">
                {status?.reachable === false ? `Cannot reach device: ${status.error}` : "Loading…"}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {outlets.map(o => {
                  const hasName = !/^Outlet \d+$/.test(o.label);
                  const isOn = o.state === "on";
                  const hasWatts = o.watts != null;
                  const borderCls = hasName
                    ? "border-nv-400/30 bg-nv-400/5"
                    : "border-rose-500/25 bg-rose-500/5";

                  if (editMode) {
                    return (
                      <div key={o.number} className="rounded-lg border border-nv-400/40 bg-nv-400/5 p-2.5 flex flex-col gap-1.5">
                        <span className="text-xs font-mono text-zinc-500">Outlet {o.number}</span>
                        <input
                          value={draftLabels[o.number] ?? ""}
                          onChange={e => setDraftLabels(d => ({ ...d, [o.number]: e.target.value }))}
                          placeholder={`Outlet ${o.number}`}
                          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-nv-400 w-full"
                        />
                      </div>
                    );
                  }

                  return (
                    <div key={o.number} className={`flex items-center gap-3 p-2.5 rounded-lg border ${isOn ? borderCls : "border-zinc-800 bg-zinc-900/40"}`}>
                      <div className={`w-8 text-center font-mono text-xs shrink-0 ${hasName ? "text-nv-400/70" : "text-rose-500/60"}`}>{o.number}</div>
                      <div className="flex-1 min-w-0">
                        <div className={`truncate text-sm font-medium ${hasName ? "text-zinc-200" : "text-zinc-500"}`}>{o.label}</div>
                        <div className="text-[11px] tabular-nums mt-0.5">
                          {!isOn
                            ? <span className="text-zinc-600">{o.state}</span>
                            : hasWatts
                            ? <span className="text-zinc-400">{o.watts == null ? "\u2014" : `${o.watts}W`} · {o.current == null ? "\u2014" : `${o.current}A`}</span>
                            : <span className="text-zinc-700">—</span>
                          }
                        </div>
                      </div>
                      <PowerButtons outlet={o} locked={inMaintenance} onAction={a => onOutletAction(o.number, a)} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Summary</div>
            <Row label="Status">
              <StatusDot status={status?.reachable ? "online" : "offline"} />
              <span className="ml-1.5">{status?.reachable ? "Online" : status ? "Offline" : "Unknown"}</span>
            </Row>
            <Row label="Rack" v={device.rack} />
            <Row label="IP" v={device.ip} />
            <Row label="Inlet voltage" v={status?.reachable && status.inlet_voltage != null ? `${status.inlet_voltage} V` : "—"} />
            <Row label="Active outlets" v={outlets.length ? `${on} / ${outlets.length}` : "—"} />
            <Row label="Total draw" v={status?.reachable && status.total_watts != null ? `${(status.total_watts/1000).toFixed(2)} kW${status.watts_complete === false ? " (partial)" : ""}` : "—"} />
            {status?.inlet_voltage > 0 && status?.total_watts != null && (
              <Row label="Current">
                <span className="tabular-nums">{(status.total_watts / status.inlet_voltage).toFixed(1)} A (estimate){status.watts_complete === false ? " (partial)" : ""}</span>
                <span className="text-zinc-600 text-xs ml-1">/ 16 A</span>
              </Row>
            )}
          </div>
          <EnvSensorsPanel status={status} />
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 space-y-1">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Quick actions</div>
            <button disabled={!canOperate || inMaintenance} title={inMaintenance ? MAINTENANCE_BLOCKED : undefined}
              className="w-full text-left text-sm px-3 py-2 rounded hover:bg-zinc-800 text-zinc-200 disabled:opacity-50 disabled:hover:bg-transparent"
              onClick={() => { if (confirm("Turn ON all outlets?")) outlets.forEach(o => o.state !== "on" && onOutletAction(o.number, "on")); }}>
              ⏻ Turn on all outlets
            </button>
            {inMaintenance ? (
              <button type="button" disabled={!maintenanceReady} title={maintenanceHint}
                className="w-full text-left text-sm px-3 py-2 rounded hover:bg-nv-400/15 text-nv-300 disabled:opacity-50 disabled:hover:bg-transparent"
                onClick={() => onMaintenance("restore")}>
                ⏻ Restore power
              </button>
            ) : (
              <button type="button" disabled={!maintenanceReady} title={maintenanceHint}
                className="w-full text-left text-sm px-3 py-2 rounded hover:bg-rose-500/15 text-rose-300 disabled:opacity-50 disabled:hover:bg-transparent"
                onClick={() => onMaintenance("shutdown")}>
                ⏻ Turn off all outlets
              </button>
            )}
            {canOperate && maintenanceMode === "unavailable" && (
              <p className="text-[11px] text-amber-300 px-3">Turning off all outlets requires a configured maintenance password.</p>
            )}
            <div className="border-t border-zinc-800 my-2" />
            <button disabled={!canAdmin} onClick={onDelete} className="w-full text-left text-sm px-3 py-2 rounded hover:bg-rose-500/10 text-rose-400">
              Remove device
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}

function EnvSensorsPanel({ status }) {
  const { temperature, humidity, leak_detected } = status || {};
  if (temperature == null && humidity == null && leak_detected == null) return null;
  return (
    <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 mt-4">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Environment</div>
      {temperature != null && (
        <div className="flex items-center justify-between text-sm py-1.5 border-b border-zinc-800/50">
          <span className="text-zinc-500 flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>
            Temperature
          </span>
          <span className={`tabular-nums font-medium ${temperature > 35 ? "text-rose-400" : temperature > 24 ? "text-amber-400" : "text-zinc-200"}`}>{temperature}°C</span>
        </div>
      )}
      {humidity != null && (
        <div className="flex items-center justify-between text-sm py-1.5 border-b border-zinc-800/50">
          <span className="text-zinc-500 flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
            Humidity
          </span>
          <span className={`tabular-nums font-medium ${humidity > 70 ? "text-amber-400" : "text-zinc-200"}`}>{humidity}%</span>
        </div>
      )}
      {leak_detected != null && (
        <div className="flex items-center justify-between text-sm py-1.5">
          <span className="text-zinc-500 flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10a8 8 0 0 0-16 0c0 6 8 10 8 10z"/></svg>
            Leak detection
          </span>
          {leak_detected ? <span className="font-medium text-rose-400">⚠ Leak detected</span> : <span className="text-emerald-500 font-medium">Clear</span>}
        </div>
      )}
    </div>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}

function PowerButtons({ outlet, locked, onAction }) {
  const {canOperate} = useAccounts();
  if (!canOperate) return <span className="text-xs text-zinc-600">Read only</span>;
  const on = outlet.state === "on";
  return (
    <div className="flex gap-1">
      {on ? (
        <>
          <button disabled={locked} onClick={() => onAction("cycle")} title={locked ? MAINTENANCE_BLOCKED : "Cycle"} className="w-7 h-7 rounded border border-zinc-700 hover:border-nv-400/60 hover:bg-nv-400/10 text-zinc-300 text-sm disabled:opacity-40 disabled:cursor-not-allowed">↻</button>
          <button onClick={() => onAction("off")} title="Off" className="w-7 h-7 rounded border border-zinc-700 hover:border-rose-500/60 hover:bg-rose-500/10 text-zinc-300 text-sm">⏻</button>
        </>
      ) : (
        <button disabled={locked} onClick={() => onAction("on")} title={locked ? MAINTENANCE_BLOCKED : undefined} className="px-2 h-7 rounded border border-zinc-700 hover:border-nv-400/60 hover:bg-nv-400/10 text-zinc-300 text-xs disabled:opacity-40 disabled:cursor-not-allowed">on</button>
      )}
    </div>
  );
}

function Row({ label, v, children }) {
  return (
    <div className="flex items-center justify-between text-sm py-1.5 border-b border-zinc-800/50 last:border-0">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200">{children ?? v}</span>
    </div>
  );
}

function BackBar({ onBack, crumbs }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <button onClick={onBack} className="text-zinc-400 hover:text-nv-400 flex items-center gap-1">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
        Back
      </button>
      <span className="text-zinc-600">/</span>
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          <span className={i === crumbs.length - 1 ? "text-zinc-200" : "text-zinc-500"}>{c}</span>
          {i < crumbs.length - 1 && <span className="text-zinc-700">/</span>}
        </Fragment>
      ))}
    </div>
  );
}
