import { useEffect } from "react";
import StatusDot from "./StatusDot";

export default function KvmViewerModal({ device, portNumber, portLabel, portStatus, onClose }) {
  useEffect(() => {
    const handler = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const managerUrl = `https://${device.ip}/home.asp`;

  function handleOpenConsole() {
    window.open(`/api/kvms/${device.id}/autologin?port=${portNumber}`, "_blank");
  }
  const isActive   = portStatus === "active";
  const isEmpty    = portStatus === "empty";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-zinc-800 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center">
              <KvmIcon />
            </div>
            <div>
              <div className="font-semibold text-base">{device.name}</div>
              <div className="text-xs text-zinc-500">{device.model} · {device.ip}</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-800 transition"
          >✕</button>
        </div>

        {/* Port info */}
        <div className="px-6 py-6 flex flex-col items-center text-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
              Port {portNumber}
            </span>
            <StatusDot status={isActive ? "active" : isEmpty ? "offline" : "unknown"} />
            <span className="text-xs text-zinc-500 capitalize">{portStatus ?? "idle"}</span>
          </div>

          <div className="text-3xl font-bold tracking-tight">
            {portLabel}
          </div>

          {isActive && (
            <div className="text-xs text-nv-400 bg-nv-400/10 border border-nv-400/20 rounded-lg px-3 py-1.5">
              Active connection — console is live
            </div>
          )}
          {isEmpty && (
            <div className="text-xs text-zinc-500 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-1.5">
              No device connected to this port
            </div>
          )}
          {!isActive && !isEmpty && (
            <div className="text-xs text-zinc-500 bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-1.5">
              Port idle — no active KVM session
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex flex-col gap-2">
          <button
            onClick={handleOpenConsole}
            className="w-full flex items-center justify-center gap-2 bg-nv-400 hover:bg-nv-300 text-zinc-950 font-semibold text-sm py-2.5 rounded-xl transition"
          >
            <MonitorIcon />
            Open KVM Console ↗
          </button>
          <a
            href={managerUrl}
            target="_blank"
            rel="noreferrer"
            className="w-full flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm py-2 rounded-xl transition"
          >
            Open KVM Manager ↗
          </a>
        </div>

        <div className="px-6 py-3 border-t border-zinc-800/80 bg-zinc-900/30 text-[11px] text-zinc-600 text-center">
          Esc to close
        </div>
      </div>
    </div>
  );
}

function KvmIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
