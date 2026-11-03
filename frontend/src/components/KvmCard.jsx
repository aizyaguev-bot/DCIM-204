import StatusDot from "./StatusDot";
import {useAccounts} from "../accounts";
import { deviceState, STATE_DOT, STATE_TEXT } from "../api/client";

export default function KvmCard({ device, status, onOpen, onPortClick, onMarkFree }) {
  const {canOperate} = useAccounts();
  const ports = status?.ports || [];
  const mappedCount = ports.filter(p => p.label?.trim() && !/^port\s*\d+$/i.test(p.label.trim())).length;
  const inUsePorts = ports.filter(p => p.in_use);
  const state = deviceState(status);

  return (
    <section className="device-card" aria-label={device.name} data-in-use={inUsePorts.length > 0}>
      <div className="device-card-header">
        <div className="device-icon">
          <KvmIcon />
        </div>
        <button onClick={onOpen} className="flex-1 min-w-0 text-left group">
          <div className="flex items-center gap-2">
            <span className="device-name group-hover:text-nv-400 transition truncate">{device.name}</span>
            <span className="inline-flex items-center gap-1.5 shrink-0"><StatusDot status={STATE_DOT[state]} /><span className="text-xs font-normal text-zinc-400">{STATE_TEXT[state]}</span></span>
            {inUsePorts.length > 0 && (
              <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 tracking-wide border border-emerald-500/40 bg-emerald-500/10 rounded px-1.5 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
                IN USE
              </span>
            )}
          </div>
          <div className="device-subtitle" title={`${device.model} · ${device.ip} · ${device.rack}`}>{device.model} · {device.ip} · {device.rack}</div>
        </button>
        <button onClick={onOpen} className="device-details">Details →</button>
      </div>
      {inUsePorts.length > 0 && (
        <div className="px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
          <span className="flex-1">In use — {inUsePorts.map(p => p.label || `P${p.number}`).join(", ")}</span>
          <button disabled={!canOperate} onClick={e => { e.stopPropagation(); onMarkFree && onMarkFree(); }}
            title={canOperate ? "Mark as free" : "Requires the Operator or Admin role"} aria-label="Mark KVM free"
            className="w-6 h-6 inline-flex items-center justify-center rounded text-emerald-600 hover:text-emerald-300 hover:bg-emerald-500/10 transition leading-none">✕</button>
        </div>
      )}
      {status?.error && (
        <div role={state === "error" ? "alert" : undefined} className={`px-4 py-2 border-b text-xs ${state === "unavailable" ? "bg-zinc-800/40 border-zinc-700/60 text-zinc-400" : "bg-rose-500/10 border-rose-500/30 text-rose-300"}`}>⚠ {status.error}</div>
      )}
      <div className="px-4 py-3">
        {!canOperate && <p dir="rtl" className="text-xs text-amber-300 mb-3">לפתיחת קונסול KVM נדרשת הרשאת Operator או Admin. החשבון הנוכחי הוא לצפייה בלבד.</p>}
        {ports.length > 0 ? (
          <div className="grid grid-cols-4 gap-2">
            {ports.map(p => <PortThumb key={p.number} port={p} onClick={() => onPortClick(p)} />)}
          </div>
        ) : (
          <div className="text-xs text-zinc-600 text-center py-4">
            {{ offline: "Cannot reach device", error: "Port list unavailable", unavailable: "Status unavailable" }[state] || "Loading ports…"}
          </div>
        )}
      </div>
      <div className="device-card-footer">
        <span>{ports.length > 0 ? `${mappedCount} of ${ports.length} ports mapped` : "—"}</span>
        <span className="font-mono font-bold text-white">{device.model?.includes("LX") ? "LX II" : "KX III"}</span>
      </div>
    </section>
  );
}

function PortThumb({ port, onClick }) {
  const {canOperate} = useAccounts();
  const active = port.status === "active";
  const occupied = !!port.label && !/^port\s*\d+$/i.test(port.label);
  return (
    <button onClick={onClick} disabled={!canOperate}
      className="kvm-port-tile" data-mapped={occupied} data-active={active} data-in-use={!!port.in_use}
      title={!canOperate ? "KVM console requires an Operator or Admin account" : `${port.label || `Port ${port.number}`} · ${port.in_use ? "In use" : port.status || "Unknown"}`}>
      <div className="absolute inset-0 flex items-center justify-center px-2 pb-2">
        {occupied ? (
          <span className="font-mono font-bold text-center text-[11px] truncate text-nv-300">
            {port.label}
          </span>
        ) : (
          <span className="text-zinc-600 text-[11px]">—</span>
        )}
      </div>
      <span className="absolute bottom-[5px] left-[6px] text-[9px] font-mono text-zinc-600">P{port.number}</span>
      {(port.in_use || occupied || active) && <span className="kvm-port-dot" data-in-use={!!port.in_use} />}
    </button>
  );
}

function KvmIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2.5" y="4" width="19" height="13" rx="1.5"/>
      <path d="M8 21h8M12 17v4"/>
    </svg>
  );
}
