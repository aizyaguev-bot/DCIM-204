import { useState, useRef, useEffect } from "react";
import StatusDot from "./StatusDot";
import {useAccounts} from "../accounts";

export default function PduCard({ device, status, onOpen, onOutletAction }) {
  const outlets = status?.outlets || [];
  const on = outlets.filter(o => o.state === "on").length;
  const totalW = status?.total_watts || 0;
  const reachable = status ? status.reachable : null;
  const devStatus = reachable === false ? "offline" : reachable === true ? "online" : "unknown";

  return (
    <section className="device-card" aria-label={device.name}>
      <div className="device-card-header">
        <div className="device-icon">
          <PduIcon />
        </div>
        <button onClick={onOpen} className="flex-1 min-w-0 text-left group">
          <div className="flex items-center gap-2">
            <span className="device-name group-hover:text-nv-400 transition truncate">{device.name}</span>
            <StatusDot status={devStatus} label />
          </div>
          <div className="device-subtitle" title={`${device.model} · ${device.ip} · ${device.rack}`}>{device.model} · {device.ip} · {device.rack}</div>
        </button>
        <button onClick={onOpen} className="device-details">Details →</button>
      </div>
      {status?.error && (
        <div className="px-4 py-2 bg-rose-500/10 border-b border-rose-500/30 text-rose-300 text-xs">⚠ {status.error}</div>
      )}
      <div className="px-4 py-3">
        {outlets.length > 0 ? (
          <div className="grid grid-cols-6 gap-1.5">
            {outlets.map((o, i) => (
              <OutletCell key={o.number} outlet={o} index={i} totalCount={outlets.length}
                onAction={a => onOutletAction(o.number, a)} />
            ))}
          </div>
        ) : (
          <div className="text-xs text-zinc-600 text-center py-4">
            {reachable === false ? "Cannot reach device" : "Loading outlets…"}
          </div>
        )}
      </div>
      <div className="device-card-footer">
        <span>{outlets.length > 0 ? `${on} of ${outlets.length} outlets active` : "—"}</span>
        <div className="flex items-center gap-1.5">
          <EnvBadges status={status} />
          <span className="font-mono font-bold text-white">{outlets.length > 0 ? `${(totalW / 1000).toFixed(2)} kW` : "—"}</span>
        </div>
      </div>
    </section>
  );
}

function OutletCell({ outlet, index, totalCount, onAction }) {
  const {canOperate} = useAccounts();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, openUp: false });
  const btnRef = useRef(null);
  const isOn = outlet.state === "on";

  const hasName = !/^Outlet \d+$/.test(outlet.label);
  const cls = outlet.state === "unknown"
    ? "bg-zinc-800/50 border-zinc-700 text-zinc-600"
    : hasName
    ? (isOn ? "bg-nv-400/15 border-nv-400/40 text-nv-300" : "bg-nv-400/8 border-nv-400/25 text-nv-400/50")
    : (isOn ? "bg-rose-500/15 border-rose-500/40 text-rose-300" : "bg-rose-900/20 border-rose-800/40 text-rose-600");

  const handleClick = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const openUp = r.bottom > window.innerHeight / 2;
      setPos({
        top: openUp ? r.top - 4 : r.bottom + 4,
        left: Math.min(Math.max(r.left + r.width / 2 - 104, 8), window.innerWidth - 220),
        openUp,
      });
    }
    setOpen(o => !o);
  };

  // Close on scroll
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleClick}
        title={`${outlet.label}\n${isOn ? `${outlet.watts}W` : outlet.state}`}
        data-state={outlet.state} data-labelled={hasName}
        className={`pdu-outlet-cell ${cls} hover:brightness-125 transition`}
      >
        <span className="truncate">{outlet.label || outlet.number}</span>
      </button>

      {open && (
        <>
          {/* full-screen backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* popup */}
          <div
            className="fixed z-50 w-52 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-2 text-sm"
            style={{
              top: pos.openUp ? undefined : pos.top,
              bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
              left: pos.left,
            }}>
            <div className="px-2 py-1.5 border-b border-zinc-800 mb-1">
              <div className="font-medium truncate">{outlet.label}</div>
              <div className="text-xs text-zinc-500">
                Outlet {outlet.number} · {isOn ? `${outlet.watts}W / ${outlet.current}A` : outlet.state}
              </div>
            </div>
            {!canOperate ? <p className="text-xs text-zinc-500 px-2 py-1">Viewer · read only</p> : isOn ? (
              <>
                <MI onClick={() => { onAction("cycle"); setOpen(false); }} icon="↻" label="Power cycle" />
                <MI
                  onClick={() => { onAction("off"); setOpen(false); }}
                  icon="⏻" label="Turn off" danger />
              </>
            ) : (
              <MI onClick={() => { onAction("on"); setOpen(false); }} icon="⏻" label="Turn on" success />
            )}
          </div>
        </>
      )}
    </>
  );
}

function MI({ onClick, icon, label, danger, success }) {
  const c = danger ? "hover:bg-rose-500/15 text-rose-300" : success ? "hover:bg-nv-400/15 text-nv-300" : "hover:bg-zinc-800 text-zinc-200";
  return (
    <button onClick={onClick} className={`w-full text-left px-2 py-1.5 rounded ${c} flex items-center gap-2`}>
      <span className="w-4 text-center">{icon}</span>{label}
    </button>
  );
}

function EnvBadges({ status }) {
  if (!status) return null;
  const { temperature, humidity, leak_detected } = status;
  if (temperature == null && humidity == null && leak_detected == null) return null;
  return (
    <div className="flex items-center gap-1">
      {temperature != null && <span title="Temperature" className="tabular-nums text-zinc-500">🌡{temperature}°C</span>}
      {humidity != null && <span title="Humidity" className="tabular-nums text-zinc-500">💧{humidity}%</span>}
      {leak_detected && <span className="font-medium text-rose-400">⚠ Leak</span>}
      <span className="text-zinc-700">·</span>
    </div>
  );
}

function PduIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="8" width="18" height="8" rx="1.5" />
      <circle cx="8" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="16" cy="12" r="1" />
    </svg>
  );
}
