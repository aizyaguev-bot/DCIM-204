import { useState, useEffect, useRef } from "react";
import { useAuth } from "../auth/AuthContext";

export default function Header({ search, setSearch, onAdd, onHome }) {
  const [version, setVersion] = useState("");
  const { user, isAuthenticated, logout, logoutAll } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((d) => setVersion(d.version))
      .catch(() => {});
  }, []);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handle(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

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
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search devices, outlets, ports, IPs…"
            className="w-full bg-zinc-900/70 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-nv-400/60 placeholder:text-zinc-500"
          />
        </div>

        <button
          onClick={onAdd}
          className="bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium text-sm px-3.5 py-2 rounded-lg flex items-center gap-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Add Device
        </button>

        {version && (
          <span className="text-[11px] text-zinc-600 whitespace-nowrap font-mono" title="deployed commit">
            {version}
          </span>
        )}

        {/* User avatar + menu */}
        {isAuthenticated && user && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 group"
              title={user.email}
            >
              <Avatar user={user} />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-2 w-52 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-2xl py-1 z-50">
                <div className="px-3 py-2 border-b border-zinc-800">
                  <div className="text-sm font-medium text-white truncate">{user.name}</div>
                  <div className="text-xs text-zinc-500 truncate">{user.email}</div>
                </div>
                <button
                  onClick={() => { setMenuOpen(false); logout(); }}
                  className="w-full text-left px-3 py-2 text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 transition flex items-center gap-2"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                    <polyline points="16 17 21 12 16 7"/>
                    <line x1="21" y1="12" x2="9" y2="12"/>
                  </svg>
                  Logout this device
                </button>
                <button
                  onClick={() => { setMenuOpen(false); logoutAll(); }}
                  className="w-full text-left px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-zinc-800/60 transition flex items-center gap-2"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                  </svg>
                  Logout all devices
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function Avatar({ user }) {
  const [imgError, setImgError] = useState(false);
  const initials = (user.name || user.email || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  if (user.avatar_url && !imgError) {
    return (
      <img
        src={user.avatar_url}
        alt={user.name}
        onError={() => setImgError(true)}
        className="w-8 h-8 rounded-full border border-zinc-700 object-cover"
      />
    );
  }

  return (
    <div className="w-8 h-8 rounded-full bg-nv-400/20 border border-nv-400/40 flex items-center justify-center text-xs font-semibold text-nv-400">
      {initials}
    </div>
  );
}
