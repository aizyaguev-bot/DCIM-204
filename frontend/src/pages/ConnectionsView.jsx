import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAccounts } from "../accounts";
import ExportCsvButton from "../components/ExportCsvButton";
import SshButton from "../components/SshButton";

export function connectionRacks(servers = []) {
  return [...new Set(servers.flatMap(server => [server.rack, ...(server.pdu || []).map(link => link.rack)]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function filterConnections(servers = [], { search = "", rack = "all", connection = "all" } = {}) {
  const query = search.trim().toLowerCase();
  return servers.filter(server => {
    const pdus = server.pdu || [];
    const kvms = server.kvm || [];
    if (rack !== "all" && server.rack !== rack && !pdus.some(link => link.rack === rack)) return false;
    if (connection === "missing-kvm" && kvms.length !== 0) return false;
    if (connection === "missing-pdu" && pdus.length !== 0) return false;
    if (connection === "single-feed" && pdus.length !== 1) return false;
    if (!query) return true;
    const fields = [server.key, server.name, server.server_ip, server.rack, server.owner, server.ping_status];
    if (server.slot != null && server.slot !== "") fields.push(server.slot, `U${server.slot}`);
    for (const link of [...pdus, ...kvms]) {
      fields.push(link.device_id, link.device_name, link.device_ip, link.rack, link.port, `#${link.port}`, link.label, link.state);
    }
    return fields.some(value => value != null && String(value).toLowerCase().includes(query));
  });
}

function ConnectionList({ links = [], power = false }) {
  if (!links.length) return <span className="text-zinc-500">{power ? "No PDU" : "No KVM"}</span>;
  return <ul className="space-y-2">{links.map(link => <li key={`${link.device_id}:${link.port}`}>
    <div><span className="text-zinc-200">{link.device_name}</span> <span className="font-mono">#{link.port}</span>
      {power && <span className={`ml-2 text-xs ${link.state === "on" ? "text-emerald-300" : link.state === "off" ? "text-amber-300" : "text-zinc-500"}`}>{link.state || "unknown"}</span>}
    </div>
    <div className="text-xs text-zinc-400"><span className="font-mono">{link.device_ip || "No IP"}</span>{link.rack && <span> · {link.rack}</span>}</div>
    {link.label && <div className="text-xs text-zinc-500 break-words">{link.label}</div>}
  </li>)}</ul>;
}

function PingStatus({ status }) {
  const color = status === "up" ? "text-emerald-300" : status === "down" ? "text-rose-300" : "text-zinc-400";
  return <span className={color}>{status || "unknown"}</span>;
}

export default function ConnectionsView() {
  const { canOperate } = useAccounts();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [rack, setRack] = useState("all");
  const [connection, setConnection] = useState("all");

  useEffect(() => {
    if (!canOperate) { setData(null); setLoading(false); return; }
    let active = true;
    setLoading(true);
    setError("");
    setDenied(false);
    api.getConnections()
      .then(result => { if (active) setData(result); })
      .catch(e => {
        if (!active) return;
        setData(null);
        if (e.status === 403) setDenied(true);
        else setError(errorMessage(e));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [canOperate, refresh]);

  const servers = data?.servers || [];
  const racks = useMemo(() => connectionRacks(servers), [servers]);
  const visible = useMemo(() => filterConnections(servers, { search, rack, connection }), [servers, search, rack, connection]);

  function exportFailed(e) {
    if (!e) setError("");
    else if (e.status === 403) { setDenied(true); setData(null); }
    else setError(`CSV export failed: ${errorMessage(e)}`);
  }

  if (!canOperate || denied) return <main className="p-4 sm:p-6"><h1 className="text-xl font-semibold text-white">Connections</h1><p role="alert" className="mt-3 text-zinc-400">Operator role needed</p></main>;

  const inputClass = "bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200";
  return <main className="p-4 sm:p-6 w-full mx-auto">
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div><h1 className="text-xl font-semibold text-white">Connections</h1><p className="text-sm text-zinc-400 mt-1">Server locations (rack and U slot), addresses, owners, power outlets and console ports.</p></div>
      <div className="flex gap-2">
        <button onClick={() => setRefresh(value => value + 1)} disabled={loading} className={`${inputClass} disabled:opacity-50`}>Refresh</button>
        <ExportCsvButton disabled={loading || !data} onError={exportFailed} />
      </div>
    </div>
    <div className="flex flex-wrap gap-3 items-end mb-3">
      <label className="flex flex-col gap-1 text-xs text-zinc-400 flex-1 min-w-48">Search
        <input type="search" aria-label="Search connections" value={search} onChange={e => setSearch(e.target.value)} placeholder="Server, IP, owner, PDU, KVM, port…" className={`${inputClass} w-full`} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">Rack
        <select aria-label="Filter connections by rack" value={rack} onChange={e => setRack(e.target.value)} className={inputClass}><option value="all">All racks</option>{racks.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">Connections
        <select aria-label="Filter connection coverage" value={connection} onChange={e => setConnection(e.target.value)} className={inputClass}>
          <option value="all">All connections</option><option value="missing-kvm">Missing KVM</option><option value="missing-pdu">Missing PDU</option><option value="single-feed">Single feed</option>
        </select>
      </label>
    </div>
    <div className="flex flex-wrap justify-between gap-2 text-xs text-zinc-400 mb-4">
      <p role="status" aria-live="polite">{loading ? "Loading connections…" : `${visible.length} of ${servers.length} servers`} · CSV includes all servers</p>
      {data?.generated_at && <p>Updated {new Date(data.generated_at).toLocaleString()}</p>}
    </div>
    {error && <p role="alert" className="border border-rose-900 bg-rose-950/30 p-3 mb-4 text-sm text-rose-300">{error} <button className="underline" onClick={() => setRefresh(value => value + 1)}>Retry</button></p>}
    {!loading && data && visible.length === 0 && <div className="border border-zinc-800 p-8 text-center text-sm text-zinc-400">
      {servers.length === 0 ? "No server connections found." : <><p>No servers match the selected filters.</p><button className="text-nv-300 underline mt-2" onClick={() => { setSearch(""); setRack("all"); setConnection("all"); }}>Clear filters</button></>}
    </div>}
    {visible.length > 0 && <>
      <div className="hidden md:block border border-zinc-800 rounded-xl overflow-x-auto">
        <table className="w-full text-sm text-left"><caption className="sr-only">Server power and console connections</caption>
          <thead className="bg-zinc-900 text-zinc-400"><tr>{["Server", "Rack", "U slot", "Server IP", "Owner", "Ping", "PDU outlets", "KVM ports"].map(label => <th scope="col" key={label} className="p-3 font-medium whitespace-nowrap">{label}</th>)}</tr></thead>
          <tbody>{visible.map(server => <tr key={server.key} className="border-t border-zinc-800 align-top">
            <th scope="row" className="p-3 font-medium text-white"><span className="inline-flex items-center gap-2">{server.name}<SshButton name={server.name} /></span></th><td className="p-3">{server.rack || "—"}</td><td className="p-3 font-mono whitespace-nowrap">{server.slot != null && server.slot !== "" ? `U${server.slot}` : "—"}</td><td className="p-3 font-mono whitespace-nowrap">{server.server_ip || "—"}</td><td className="p-3">{server.owner || "—"}</td><td className="p-3"><PingStatus status={server.ping_status} /></td><td className="p-3"><ConnectionList links={server.pdu} power /></td><td className="p-3"><ConnectionList links={server.kvm} /></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="md:hidden space-y-3">{visible.map(server => <article key={server.key} className="border border-zinc-800 rounded-xl p-4 text-sm">
        <div className="flex items-start justify-between gap-3 mb-3"><h2 className="font-semibold text-white">{server.name}</h2><PingStatus status={server.ping_status} /></div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3">
          <dt className="text-zinc-400">Rack</dt><dd>{server.rack || "—"}</dd><dt className="text-zinc-400">U slot</dt><dd className="font-mono">{server.slot != null && server.slot !== "" ? `U${server.slot}` : "—"}</dd><dt className="text-zinc-400">Server IP</dt><dd className="font-mono break-all">{server.server_ip || "—"}</dd><dt className="text-zinc-400">Owner</dt><dd>{server.owner || "—"}</dd>
          <dt className="text-zinc-400">PDU outlets</dt><dd className="min-w-0"><ConnectionList links={server.pdu} power /></dd><dt className="text-zinc-400">KVM ports</dt><dd className="min-w-0"><ConnectionList links={server.kvm} /></dd>
        </dl>
      </article>)}</div>
    </>}
  </main>;
}
