import { useState, useEffect, useMemo } from "react";
import { api } from "../api/client";

function EditRow({ entry, pdus, kvms, pduStatuses, kvmStatuses, saving, onSave, onCancel }) {
  const [pduDeviceId, setPduDeviceId] = useState(entry.pdus[0]?.device_id || "");
  const [pduPort,     setPduPort]     = useState(entry.pdus[0]?.port     || "");
  const [kvmDeviceId, setKvmDeviceId] = useState(entry.kvms[0]?.device_id || "");
  const [kvmPort,     setKvmPort]     = useState(entry.kvms[0]?.port     || "");

  const pduOutlets = pduDeviceId && pduStatuses[pduDeviceId]?.outlets
    ? pduStatuses[pduDeviceId].outlets.map(o => ({ number: String(o.number), label: o.label }))
    : [];
  const kvmPorts = kvmDeviceId && kvmStatuses[kvmDeviceId]?.ports
    ? kvmStatuses[kvmDeviceId].ports.map(p => ({ number: String(p.number), label: p.label }))
    : [];

  const sel = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200";
  const inp = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 w-24";

  return (
    <tr className="bg-zinc-800/40">
      <td className="px-4 py-3 font-mono text-sm text-nv-300 whitespace-nowrap">{entry.opt_name}</td>

      <td className="px-4 py-3" colSpan={2}>
        <div className="flex gap-2 items-center flex-wrap">
          <select value={pduDeviceId} onChange={e => { setPduDeviceId(e.target.value); setPduPort(""); }} className={`${sel} flex-1 min-w-[140px]`}>
            <option value="">— none —</option>
            {pdus.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {pduDeviceId && pduOutlets.length > 0 ? (
            <select value={pduPort} onChange={e => setPduPort(e.target.value)} className={`${sel} w-36`}>
              <option value="">outlet…</option>
              {pduOutlets.map(o => (
                <option key={o.number} value={o.number}>
                  #{o.number}{o.label && o.label.toLowerCase() !== entry.opt_name.toLowerCase() ? ` (${o.label})` : ""}
                </option>
              ))}
            </select>
          ) : pduDeviceId ? (
            <input type="number" min="1" value={pduPort} onChange={e => setPduPort(e.target.value)} placeholder="outlet #" className={inp} />
          ) : null}
        </div>
      </td>

      <td className="px-4 py-3" colSpan={2}>
        <div className="flex gap-2 items-center flex-wrap">
          <select value={kvmDeviceId} onChange={e => { setKvmDeviceId(e.target.value); setKvmPort(""); }} className={`${sel} flex-1 min-w-[140px]`}>
            <option value="">— none —</option>
            {kvms.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          {kvmDeviceId && kvmPorts.length > 0 ? (
            <select value={kvmPort} onChange={e => setKvmPort(e.target.value)} className={`${sel} w-36`}>
              <option value="">port…</option>
              {kvmPorts.map(p => (
                <option key={p.number} value={p.number}>
                  #{p.number}{p.label && p.label.toLowerCase() !== entry.opt_name.toLowerCase() ? ` (${p.label})` : ""}
                </option>
              ))}
            </select>
          ) : kvmDeviceId ? (
            <input type="number" min="1" value={kvmPort} onChange={e => setKvmPort(e.target.value)} placeholder="port #" className={inp} />
          ) : null}
        </div>
      </td>

      <td className="px-4 py-3">
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => onSave({ pduDeviceId, pduPort, kvmDeviceId, kvmPort })}
            disabled={saving}
            className="px-3 py-1 bg-nv-400 hover:bg-nv-300 text-zinc-950 rounded text-xs font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={onCancel} className="px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded text-xs">
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function SyncView({ devices, pduStatuses, kvmStatuses }) {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saving,  setSaving]  = useState(false);
  const [search,  setSearch]  = useState("");
  const [filter,  setFilter]  = useState("all"); // "all" | "linked" | "unlinked"

  const pdus = devices.filter(d => d.kind === "pdu");
  const kvms = devices.filter(d => d.kind === "kvm");

  async function load() {
    try {
      setLoading(true);
      setRows(await api.getSyncMap());
    } catch (e) {
      console.error("sync map:", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    let result = rows;
    if (filter === "linked")   result = result.filter(r => r.pdus.length > 0 && r.kvms.length > 0);
    if (filter === "unlinked") result = result.filter(r => r.pdus.length === 0 || r.kvms.length === 0);
    if (search.trim()) {
      const s = search.toLowerCase();
      result = result.filter(r => r.opt_name.toLowerCase().includes(s));
    }
    return [...result].sort((a, b) => {
      const aPdu  = a.pdus[0];
      const bPdu  = b.pdus[0];
      if (!aPdu && !bPdu) return a.opt_name.localeCompare(b.opt_name);
      if (!aPdu) return 1;
      if (!bPdu) return -1;
      const nameComp = aPdu.device_name.localeCompare(bPdu.device_name);
      if (nameComp !== 0) return nameComp;
      return parseInt(aPdu.port, 10) - parseInt(bPdu.port, 10);
    });
  }, [rows, search, filter]);

  async function handleSave(optName, draft) {
    setSaving(true);
    try {
      const original = rows.find(r => r.opt_name === optName);
      const origPdu  = original.pdus[0] || null;
      const origKvm  = original.kvms[0] || null;

      const pduChanged = origPdu?.device_id !== draft.pduDeviceId || origPdu?.port !== draft.pduPort;
      const kvmChanged = origKvm?.device_id !== draft.kvmDeviceId || origKvm?.port !== draft.kvmPort;

      if (pduChanged) {
        if (origPdu) await api.setDirectLabel(origPdu.device_id, origPdu.port, "");
        if (draft.pduDeviceId && draft.pduPort) await api.setDirectLabel(draft.pduDeviceId, draft.pduPort, optName);
      }
      if (kvmChanged) {
        if (origKvm) await api.setDirectLabel(origKvm.device_id, origKvm.port, "");
        if (draft.kvmDeviceId && draft.kvmPort) await api.setDirectLabel(draft.kvmDeviceId, draft.kvmPort, optName);
      }

      setEditing(null);
      await load();
    } catch (e) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const totalLinked   = rows.filter(r => r.pdus.length > 0 && r.kvms.length > 0).length;
  const totalUnlinked = rows.length - totalLinked;

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-5">
      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">PDU ↔ KVM Sync Map</h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Edit individual assignments without cascading rename to other devices
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded text-sm disabled:opacity-50 shrink-0"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <input
          type="text"
          placeholder="Filter by OPT name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-nv-400/60 w-56"
        />
        <div className="flex gap-1">
          {[
            { id: "all",      label: `All (${rows.length})` },
            { id: "linked",   label: `Linked (${totalLinked})` },
            { id: "unlinked", label: `Unlinked (${totalUnlinked})` },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${
                filter === f.id
                  ? "bg-nv-400/20 text-nv-300 border border-nv-400/30"
                  : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className="text-center text-zinc-500 py-16">Loading sync map…</div>
      ) : (
        <div className="rounded-xl border border-zinc-800/60 overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-zinc-900/60 border-b border-zinc-800">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">OPT</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">PDU</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider w-20">Outlet</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">KVM</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider w-16">Port</th>
                <th className="w-32" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/40">
              {(() => {
                let lastPduName = null;
                return filtered.flatMap(row => {
                  const pdu      = row.pdus[0];
                  const kvm      = row.kvms[0];
                  const isLinked = pdu && kvm;
                  const pduGroup = pdu?.device_name || "— No PDU —";
                  const elements = [];

                  if (pduGroup !== lastPduName) {
                    lastPduName = pduGroup;
                    elements.push(
                      <tr key={`group-${pduGroup}`} className="bg-zinc-900/70">
                        <td colSpan={6} className="px-4 py-1.5 text-[11px] font-semibold text-zinc-400 uppercase tracking-widest">
                          {pduGroup}
                        </td>
                      </tr>
                    );
                  }

                  if (editing === row.opt_name) {
                    elements.push(
                      <EditRow
                        key={row.opt_name}
                        entry={row}
                        pdus={pdus}
                        kvms={kvms}
                        pduStatuses={pduStatuses}
                        kvmStatuses={kvmStatuses}
                        saving={saving}
                        onSave={draft => handleSave(row.opt_name, draft)}
                        onCancel={() => setEditing(null)}
                      />
                    );
                    return elements;
                  }

                  elements.push(
                  <tr key={row.opt_name} className="hover:bg-zinc-800/20 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm text-zinc-100">{row.opt_name}</span>
                      {!isLinked && (
                        <span className="ml-2 text-[10px] bg-amber-900/30 text-amber-400 border border-amber-700/30 rounded px-1.5 py-0.5 align-middle">
                          unlinked
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-sm">{pdu?.device_name || <span className="text-zinc-700">—</span>}</td>
                    <td className="px-4 py-3 text-zinc-300 text-sm font-mono">{pdu ? `#${pdu.port}` : <span className="text-zinc-700">—</span>}</td>
                    <td className="px-4 py-3 text-zinc-300 text-sm">{kvm?.device_name || <span className="text-zinc-600">—</span>}</td>
                    <td className="px-4 py-3 text-zinc-400 text-sm font-mono">{kvm ? `#${kvm.port}` : <span className="text-zinc-700">—</span>}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setEditing(row.opt_name)}
                        className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded transition"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                  );
                  return elements;
                });
              })()}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-zinc-500">
                    {search || filter !== "all" ? "No entries match the filter" : "No label assignments found"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
