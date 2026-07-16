import StatusDot from "./StatusDot";

export default function KvmCard({ device, status, onOpen, onPortClick, onMarkFree }) {
  const ports = status?.ports || [];
  const isOpt = p => /^opt/i.test(p.label || "");
  const optCount = ports.filter(isOpt).length;
  const inUsePorts = ports.filter(p => p.in_use);
  const isLx = device.model?.includes("LX");
  const devStatus = status ? (status.reachable ? "online" : "offline") : "unknown";

  return (
    <div className={`bg-zinc-900/70 border rounded-xl overflow-hidden transition
      ${inUsePorts.length > 0 ? "border-emerald-500/40 hover:border-emerald-500/60" : "border-zinc-800 hover:border-zinc-700"}`}>
      <div className="px-4 py-3 flex items-center gap-3 border-b border-zinc-800/80">
        <div className="w-9 h-9 rounded-md bg-zinc-800/70 border border-zinc-700 flex items-center justify-center text-zinc-300">
          <KvmIcon />
        </div>
        <button onClick={onOpen} className="flex-1 text-left group">
          <div className="flex items-center gap-2">
            <span className="font-medium group-hover:text-nv-400 transition">{device.name}</span>
            <StatusDot status={devStatus} />
            {inUsePorts.length > 0 && (
              <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 tracking-wide border border-emerald-500/40 bg-emerald-500/10 rounded px-1.5 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
                IN USE
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">{device.model} · {device.ip} · {device.rack}</div>
        </button>
        <button onClick={onOpen} className="text-xs text-zinc-400 hover:text-nv-400 px-2 py-1 rounded">Details →</button>
      </div>
      {inUsePorts.length > 0 && (
        <div className="px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
          <span className="flex-1">In use — {inUsePorts.map(p => p.label || `P${p.number}`).join(", ")}</span>
          <button onClick={e => { e.stopPropagation(); onMarkFree && onMarkFree(); }}
            title="Mark as free"
            className="text-emerald-600 hover:text-emerald-300 transition leading-none px-1">✕</button>
        </div>
      )}
      {isLx && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs">
          LX II — viewer opens in new tab
        </div>
      )}
      <div className="p-4">
        {ports.length > 0 ? (
          <div className="grid grid-cols-4 gap-1.5">
            {ports.map(p => <PortThumb key={p.number} port={p} onClick={() => onPortClick(p)} />)}
          </div>
        ) : (
          <div className="text-xs text-zinc-600 text-center py-4">
            {status?.reachable === false ? "Cannot reach device" : "Loading ports…"}
          </div>
        )}
      </div>
      <div className="px-4 py-2.5 border-t border-zinc-800/80 bg-zinc-950/40 text-xs text-zinc-400 flex justify-between">
        <span>{ports.length > 0 ? `${optCount} of ${ports.length} ports active` : "—"}</span>
        <span className="text-zinc-200">{device.model?.includes("LX") ? "LX II" : "KX III"}</span>
      </div>
    </div>
  );
}

function PortThumb({ port, onClick }) {
  const active = port.status === "active";
  const occupied = !!port.label && !/^port\s*\d+$/i.test(port.label);
  return (
    <button onClick={onClick}
      className={`relative rounded border cursor-pointer overflow-hidden aspect-[4/3] transition
        ${active
          ? "bg-emerald-950/40 border-emerald-500/60 shadow-[0_0_8px_rgba(52,211,153,0.2)]"
          : occupied
            ? "bg-nv-400/5 border-nv-400/40 hover:border-nv-400/70"
            : "bg-zinc-950 border-zinc-800 hover:border-zinc-700"
        }`}
      title={port.label}>
      <div className="absolute inset-0 flex items-center justify-center px-1 pb-4">
        {occupied ? (
          <span className={`font-mono font-semibold text-center text-[8px] leading-tight
            ${active ? "text-emerald-300" : "text-nv-300"}`}>
            {port.label}
          </span>
        ) : (
          <span className="text-zinc-700 text-[8px]">—</span>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 px-1 py-0.5 bg-gradient-to-t from-black to-transparent flex items-center gap-1">
        <span className="text-[8px] font-mono text-zinc-500">P{port.number}</span>
      </div>
      {active && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />}
      {occupied && !active && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-nv-400/60" />}
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
