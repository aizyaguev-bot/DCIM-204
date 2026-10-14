import { useAccounts } from "../accounts";

const ACTIONS = {
  shutdown: ["Shutdown", "text-rose-300 border-rose-500/40 bg-rose-500/10"],
  restore:  ["Restore", "text-nv-300 border-nv-400/40 bg-nv-400/10"],
  denied:   ["Denied", "text-amber-300 border-amber-500/40 bg-amber-500/10"],
};

export function formatMaintenanceTime(epoch) {
  if (epoch == null) return "—";
  const d = new Date(epoch * 1000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

export function maintenanceStateFor(maintenance, id) {
  return maintenance?.pdus?.[String(id)] || null;
}

export default function MaintenanceColumn({ pdus, pduStatuses, maintenance, error, onShutdown, onRestore }) {
  const { canOperate } = useAccounts();
  const passwordMode = maintenance?.password_mode;
  const unavailable = passwordMode === "unavailable";
  const actionsEnabled = canOperate && !!maintenance && !unavailable;
  const names = new Map(pdus.map(p => [String(p.id), p.name]));
  const log = (maintenance?.log || []).slice(0, 15);
  const sorted = [...pdus].sort((a, b) => (a.rack || "").localeCompare(b.rack || "") || a.name.localeCompare(b.name));

  return (
    <aside aria-labelledby="maintenance-heading" className="w-full xl:w-[380px] xl:shrink-0 mt-4 space-y-4">
      <section className="bg-zinc-900/70 border border-zinc-800 rounded-xl">
        <div className="p-4 border-b border-zinc-800">
          <h2 id="maintenance-heading" className="text-sm font-semibold text-white">Maintenance</h2>
          <p className="text-xs text-zinc-500 mt-1">Switch off every outlet of a PDU and later restore exactly the outlets that were on. Requires password confirmation.</p>
        </div>
        {error && <div role="alert" className="px-4 py-2 bg-rose-500/10 border-b border-rose-500/30 text-rose-300 text-xs">Maintenance state could not load: {error}</div>}
        {!canOperate && <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-500">Viewer · read only</div>}
        {canOperate && unavailable && (
          <div role="note" className="px-4 py-2 border-b border-zinc-800 text-xs text-amber-300">
            Maintenance actions require a configured password. Ask a lab administrator to enable accounts or set the Lab Manager password.
          </div>
        )}
        {!maintenance && !error ? (
          <div className="p-4 text-xs text-zinc-600 text-center">Loading maintenance state…</div>
        ) : sorted.length === 0 ? (
          <div className="p-4 text-xs text-zinc-600 text-center">No PDUs configured.</div>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {sorted.map(p => {
              const st = maintenanceStateFor(maintenance, p.id);
              const outlets = pduStatuses[p.id]?.outlets || [];
              const on = outlets.filter(o => o.state === "on").length;
              return (
                <li key={p.id} className={`p-3 ${st ? "bg-amber-500/5" : ""}`}>
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-100 truncate">{p.name}</span>
                        <span className="text-[11px] text-zinc-500 shrink-0">{p.rack || "—"}</span>
                      </div>
                      <div className="text-[11px] text-zinc-500 tabular-nums mt-0.5">
                        {pduStatuses[p.id]?.reachable === false ? <span className="text-rose-300">Unreachable</span> : outlets.length ? `${on} / ${outlets.length} outlets on` : "—"}
                      </div>
                      {st ? (
                        <div className="text-xs mt-1 space-y-0.5">
                          <div className="text-amber-300">In maintenance since {formatMaintenanceTime(st.started_at)}{st.started_by ? ` by ${st.started_by}` : ""}</div>
                          {st.reason && <div className="text-zinc-400 break-words">{st.reason}</div>}
                          <div className="text-zinc-500">{(st.outlets_off || []).length} outlet{(st.outlets_off || []).length === 1 ? "" : "s"} to restore</div>
                          {st.failed?.length > 0 && <div className="text-rose-300">Failed outlets: {st.failed.join(", ")}</div>}
                        </div>
                      ) : (
                        <div className="text-xs mt-1 text-zinc-400">{maintenance ? "Normal" : "Unknown"}</div>
                      )}
                    </div>
                    {canOperate && (
                      st ? (
                        <button type="button" disabled={!actionsEnabled} onClick={() => onRestore(p)} aria-label={`Restore power on ${p.name}`}
                          className="shrink-0 text-xs px-2.5 py-1.5 rounded border border-nv-400/50 text-nv-300 hover:bg-nv-400/10 disabled:opacity-40 disabled:cursor-not-allowed">
                          Restore power
                        </button>
                      ) : (
                        <button type="button" disabled={!actionsEnabled} onClick={() => onShutdown(p)} aria-label={`Shut down all outlets on ${p.name}`}
                          className="shrink-0 text-xs px-2.5 py-1.5 rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 disabled:opacity-40 disabled:cursor-not-allowed">
                          Shut down all outlets
                        </button>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="maintenance-log-heading" className="bg-zinc-900/70 border border-zinc-800 rounded-xl">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h3 id="maintenance-log-heading" className="text-xs uppercase tracking-wider text-zinc-500">Recent maintenance activity</h3>
        </div>
        {log.length === 0 ? (
          <div className="p-4 text-xs text-zinc-600 text-center">{maintenance ? "No maintenance actions yet." : "—"}</div>
        ) : (
          <ol className="divide-y divide-zinc-800/70">
            {log.map((entry, i) => {
              const [label, cls] = ACTIONS[entry.action] || [entry.action, "text-zinc-300 border-zinc-700"];
              return (
                <li key={`${entry.at}-${entry.device_id}-${i}`} className="px-4 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase ${cls}`}>{label}</span>
                    <span className="text-zinc-200 truncate">{names.get(String(entry.device_id)) || `PDU ${entry.device_id}`}</span>
                    <span className="ml-auto text-zinc-500 tabular-nums shrink-0">{formatMaintenanceTime(entry.at)}</span>
                  </div>
                  <div className="text-zinc-500 mt-0.5">
                    {entry.by || "unknown"}
                    {entry.action !== "denied" && ` · ${entry.ok ?? 0} ok${entry.failed ? ` · ${entry.failed} failed` : ""}`}
                    {entry.reason ? ` · ${entry.reason}` : ""}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </aside>
  );
}
