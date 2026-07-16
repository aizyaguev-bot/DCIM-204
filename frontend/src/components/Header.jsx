import { useState, useEffect } from "react";

export default function Header({ search, setSearch, onAdd, onHome }) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    fetch("/api/version")
      .then(r => r.json())
      .then(d => setVersion(d.version))
      .catch(() => {});
  }, []);

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur sticky top-0 z-30">
      <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center gap-4">
        <button onClick={onHome} className="flex items-center gap-2 group">
          <div className="w-8 h-8 rounded-md bg-nv-400/20 border border-nv-400/40 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#76b900" strokeWidth="2.5">
              <path d="M3 12h3l2-7 4 14 2-7h7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="leading-tight text-left">
            <div className="font-semibold tracking-tight group-hover:text-nv-400 transition">Lab Manager</div>
            <div className="text-[11px] text-zinc-500 -mt-0.5">Raritan PDU + KVM control</div>
          </div>
        </button>
        <div className="flex-1 max-w-xl mx-auto relative">
          <svg className="absolute left-3 top-2.5 text-zinc-500" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/>
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search devices, outlets, ports, IPs…"
            className="w-full bg-zinc-900/70 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-nv-400/60 placeholder:text-zinc-500" />
        </div>
        <button onClick={onAdd} className="bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium text-sm px-3.5 py-2 rounded-lg flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 5v14M5 12h14"/></svg>
          Add Device
        </button>
        {version && (
          <span className="text-[11px] text-zinc-600 whitespace-nowrap font-mono" title="deployed commit">
            {version}
          </span>
        )}
      </div>
    </header>
  );
}
