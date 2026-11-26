import { useState } from "react";
import { useAccounts } from "../accounts";
import { useRemovedServers } from "../removedServers.jsx";
import { restoreServer } from "../api/removedServers.js";

// Admin → Removed servers: servers an Admin removed from the lab ("Remove from lab" in a server's details on Racks),
// with who removed them, when and why, and Restore. Restore shows the server again from its PDU label; the rack
// position, switch port and owner cleaned at removal are not brought back. A removed name that was written on another
// PDU/KVM port later is shown again everywhere ("Shown again"); Remove it again from Racks to hide it with that port.
const formatTime = ts => (ts ? new Date(ts * 1000).toLocaleString() : "—");
const portText = p => `${p.device_name || p.device_id} ${p.kind === "kvm" ? "port" : "outlet"} ${p.port}`;

export default function RemovedServersView() {
  const { canAdmin } = useAccounts();
  const { data, etag, loaded, refresh } = useRemovedServers();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  if (!canAdmin) return <p role="alert" className="p-6">Only administrators can see and restore removed servers.</p>;
  const servers = Array.isArray(data?.servers) ? data.servers : [];
  const log = Array.isArray(data?.log) ? data.log : [];

  async function restore(server) {
    setBusy(server.key); setError(""); setNotice("");
    try {
      await restoreServer(server.key, etag);   // the ETag of the list shown here: a change made elsewhere since is a 409
      setNotice(`${server.name} is back in the lab. Its rack position, switch port and owner were not restored.`);
    } catch (e) {
      setError(`${server.name} was not restored: ${e.message}`);
    } finally {
      await refresh().catch(() => {});
      setBusy(null);
    }
  }

  return <main className="account-page max-w-none" data-page="removed-servers">
    <div className="mb-5">
      <h1 className="text-2xl font-bold text-white">Removed servers</h1>
      <p className="text-sm text-zinc-400 mt-2">Servers removed from the lab are hidden from Racks, monitoring, the lab display, owners, SSH and the 3D twin.
        Remove a server from its details on Racks. Restore shows it again from its PDU label; its rack position, switch port and owner are not brought back.</p>
    </div>
    {error && <p className="account-error my-3" role="alert">{error}</p>}
    {notice && <p className="text-sm text-nv-300 my-3" role="status">{notice}</p>}
    <div className="user-table-wrap"><table className="user-table">
      <thead><tr>{["Server", "Status", "Removed", "By", "Reason", "PDU / KVM labels (unchanged)", "Actions"].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>
        {servers.map(s => <tr key={s.key} data-removed-server={s.key}>
          <td className="font-semibold text-white" dir="auto">{s.name}</td>
          <td className={s.active ? "text-zinc-300" : "text-amber-300"}>{s.active ? "Hidden"
            : <>Shown again: its name is on {s.new_ports?.length === 1 ? "a new port" : "new ports"}. Remove it again from Racks to hide it.</>}</td>
          <td>{formatTime(s.removed_at)}</td>
          <td className="font-mono">{s.removed_by || "—"}</td>
          <td dir="auto">{s.reason || <span className="text-zinc-500">—</span>}</td>
          <td dir="auto">{s.ports?.length ? s.ports.map(portText).join(", ") : <span className="text-zinc-500">None</span>}</td>
          <td><button className="account-secondary" disabled={busy !== null} onClick={() => restore(s)} aria-label={`Restore ${s.name}`}>
            {busy === s.key ? "Restoring…" : "Restore"}</button></td>
        </tr>)}
      </tbody>
    </table>
    {!loaded && <p className="p-4 text-zinc-500">Loading removed servers…</p>}
    {loaded && servers.length === 0 && <p className="p-4 text-zinc-500">No server is removed from the lab.</p>}
    </div>
    {log.length > 0 && <section className="mt-6">
      <h2 className="text-lg font-semibold text-white mb-2">Recent activity</h2>
      <ul className="text-sm text-zinc-300 space-y-1" data-list="removed-servers-log">
        {log.slice(0, 20).map((e, i) => <li key={`${e.at}-${i}`} dir="auto">
          {formatTime(e.at)} · <bdi>{e.by}</bdi> {e.action === "restored" ? "restored" : "removed"} <bdi>{e.name}</bdi>{e.reason ? <> · <bdi>{e.reason}</bdi></> : null}
        </li>)}
      </ul>
    </section>}
  </main>;
}
