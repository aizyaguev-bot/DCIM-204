import { useSyncExternalStore } from "react";
import { useAccounts } from "../accounts";
import { sshAvailability, sshStatusStore, terminalPageUrl, serverKey } from "../api/ssh";

// Shared /api/ssh/status snapshot: one request for every SSH button on the page, refreshed when older than a minute.
export function useSshStatus() {
  return useSyncExternalStore(sshStatusStore.subscribe, sshStatusStore.getSnapshot);
}

const base = "inline-flex items-center justify-center gap-1 rounded border font-mono font-semibold whitespace-nowrap transition";
const sizes = { sm: "px-2 py-0.5 text-[10px]", md: "px-2.5 py-1 text-xs" };

// "SSH" for one server (Operator+ only). Opens the terminal page in a new tab; when SSH cannot be used
// it stays focusable but inactive, and its tooltip and accessible name give the reason.
export default function SshButton({ name, size = "sm", className = "" }) {
  const { canOperate, mode } = useAccounts();
  if (!canOperate || !serverKey(name)) return null;
  const cls = `${base} ${sizes[size] || sizes.sm} ${className}`;
  // Without user accounts SSH is refused anyway; no status request is made.
  if (mode === "legacy") return <Unavailable name={name} cls={cls} reason={sshAvailability({ name, accountMode: mode }).reason} />;
  return <SshButtonLive name={name} cls={cls} mode={mode} />;
}

function Unavailable({ name, cls, reason }) {
  return <button type="button" aria-disabled="true" title={reason} aria-label={`SSH to ${name} unavailable: ${reason}`}
    onClick={e => { e.preventDefault(); e.stopPropagation(); }}
    className={`${cls} border-zinc-800 text-zinc-600 cursor-not-allowed`}>SSH</button>;
}

function SshButtonLive({ name, cls, mode }) {
  const snapshot = useSshStatus();
  const { enabled, reason, server } = sshAvailability({ status: snapshot.data, error: snapshot.error, loading: snapshot.loading,
    name, accountMode: mode, protocol: window.location.protocol });
  if (!enabled) return <Unavailable name={name} cls={cls} reason={reason} />;
  return <a href={terminalPageUrl(server.key)} target="_blank" rel="noopener noreferrer" title={reason}
    aria-label={`SSH to ${server.name || name} (opens a terminal page in a new tab)`}
    onClick={e => e.stopPropagation()}
    className={`${cls} border-nv-400/50 text-nv-300 hover:bg-nv-400/10 hover:border-nv-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-nv-400`}>SSH</a>;
}
