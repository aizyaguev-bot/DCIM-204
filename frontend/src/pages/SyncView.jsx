import { useState, useMemo } from "react";
import { api } from "../api/client";

function EditRow({ row, pdus, kvms, pduStatuses, kvmStatuses, saving, onSave, onCancel }) {
  const [label,       setLabel]       = useState(row.label);
  const [kvmDeviceId, setKvmDeviceId] = useState(row.kvm?.device_id || "");
  const [kvmPort,     setKvmPort]     = useState(row.kvm?.port       || "");

  const kvmPorts = kvmDeviceId && kvmStatuses[kvmDeviceId]?.ports
    ? kvmStatuses[kvmDeviceId].ports.map(p => ({ number: String(p.number), label: p.label }))
    : [];

  const sel = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200";
  const inp = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200";

  return (
    <tr className="bg-zinc-800/40">
      <td className="px-3 py-2 text-zinc-500 text-sm font-mono">{row.outlet_number}</td>
      <td className="px-3 py-2">
        <div className={`w-1.5 h-1.5 rounded-full inline-block ${row.outlet_state === "on" ? "bg-emerald-400" : "bg-zinc-600"}`} />
      </td>
      <td className="px-3 py-2 text-zinc-500 text-xs">{row.outlet_watts > 0 ? `${row.outlet_watts.toFixed(0)}W` : ""}</td>
      <td className="px-3 py-2">
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="— empty —"
          className={`${inp} w-32`}
        />
      </td>
      <td className="px-3 py-2" colSpan={2}>
        <div className="flex gap-2 items-center">
          <select value={kvmDeviceId} onChange={e => { setKvmDeviceId(e.target.value); setKvmPort(""); }} className={`${sel} flex-1 min-w-[130px]`}>
            <option value="">— none —</option>
            {kvms.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          {kvmDeviceId && kvmPorts.length > 0 ? (
            <select value={kvmPort} onChange={e => setKvmPort(e.target.value)} className={`${sel} w-24`}>
              <option value="">port…</option>
              {kvmPorts.map(p => (
                <option key={p.number} value={p.number}>
                  #{p.number}{p.label && p.label.toLowerCase() !== label.toLowerCase() ? ` (${p.label})` : ""}
                </option>
              ))}
            </select>
          ) : kvmDeviceId ? (
            <input type="number" min="1" value={kvmPort} onChange={e => setKvmPort(e.target.value)} placeholder="port #" className={`${inp} w-20`} />
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-2 justify-end">
          <button onClick={() => onSave({ label: label.trim(), kvmDeviceId, kvmPort })} disabled={saving}
            className="px-3 py-1 bg-nv-400 hover:bg-nv-300 text-zinc-950 rounded text-xs font-medium disabled:opacity-50">
            {saving ? "…" : "Save"}
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
  const [editing, setEditing] = useState(null); // { pdu_id, outlet_number }
  const [saving,  setSaving]  = useState(false);
  const [search,  setSearch]  = useState("");
  const [filter,  setFilter]  = useState("all"); // "all" | "assigned" | "empty"

  const pdus = devices.filter(d => d.kind === "pdu");
  const kvms = devices.filter(d => d.kind === "kvm");

  // Build KVM lookup: label_lower → { device_id, device_name, port }
  const kvmByLabel = useMemo(() => {
    const map = {};
    kvms.forEach(kvm => {
      const status = kvmStatuses[kvm.id];
      if (!status?.ports) return;
      status.ports.forEach(p => {
        if (p.label) map[p.label.toLowerCase()] = { device_id: kvm.id, device_name: kvm.name, port: String(p.number) };
      });
    });
    return map;
  }, [kvms, kvmStatuses]);

  // Build full table: every outlet from every PDU (including PDUs with no status yet)
  const allRows = useMemo(() => {
    const rows = [];
    pdus.forEach(pdu => {
      const status = pduStatuses[pdu.id];
      if (!status?.outlets?.length) {
        // PDU exists but no status yet — add a placeholder row so the group appears
        rows.push({
          pdu_id:        pdu.id,
          pdu_name:      pdu.name,
          outlet_number: null,
          outlet_state:  null,
          outlet_watts:  0,
          label:         "",
          kvm:           null,
          noStatus:      true,
        });
        return;
      }
      status.outlets.forEach(outlet => {
        const label = outlet.label || "";
        rows.push({
          pdu_id:        pdu.id,
          pdu_name:      pdu.name,
          outlet_number: outlet.number,
          outlet_state:  outlet.state,
          outlet_watts:  outlet.watts || 0,
          label,
          kvm: label ? (kvmByLabel[label.toLowerCase()] || null) : null,
          noStatus:      false,
        });
      });
    });
    return rows;
  }, [pdus, pduStatuses, kvmByLabel]);

  const filtered = useMemo(() => {
    let result = allRows;
    if (filter === "assigned") result = result.filter(r => r.noStatus || r.label);
    if (filter === "empty")    result = result.filter(r => r.noStatus || !r.label);
    if (search.trim()) {
      const s = search.toLowerCase();
      result = result.filter(r =>
        r.noStatus ||
        r.label.toLowerCase().includes(s) ||
        r.pdu_name.toLowerCase().includes(s) ||
        String(r.outlet_number).includes(s)
      );
    }
    return result;
  }, [allRows, search, filter]);

  const totalAssigned = allRows.filter(r => !r.noStatus && r.label).length;
  const totalEmpty    = allRows.filter(r => !r.noStatus && !r.label).length;

  const editKey = (pdu_id, outlet_number) => `${pdu_id}:${outlet_number}`;

  async function handleSave(row, draft) {
    setSaving(true);
    try {
      const oldLabel = row.label;
      const newLabel = draft.label;
      const labelChanged = oldLabel !== newLabel;

      // Update PDU outlet label (no cascade)
      if (labelChanged) {
        await api.setDirectLabel(row.pdu_id, String(row.outlet_number), newLabel);
      }

      // Update KVM assignment
      const origKvm   = row.kvm;
      const kvmChanged = origKvm?.device_id !== draft.kvmDeviceId || origKvm?.port !== draft.kvmPort;
      if (kvmChanged) {
        if (origKvm) await api.setDirectLabel(origKvm.device_id, origKvm.port, "");
        if (draft.kvmDeviceId && draft.kvmPort) {
          await api.setDirectLabel(draft.kvmDeviceId, draft.kvmPort, newLabel || oldLabel);
        }
      } else if (labelChanged && origKvm) {
        // label renamed but KVM stayed same — update KVM port label too (no cascade)
        await api.setDirectLabel(origKvm.device_id, origKvm.port, newLabel);
      }

      setEditing(null);
      // Reload statuses via parent (trigger re-render naturally on next poll)
      // For immediate feedback, force a status refresh
      await Promise.all([
        fetch(`/api/pdus/${row.pdu_id}/status`).catch(() => {}),
        ...(origKvm ? [fetch(`/api/kvms/${origKvm.device_id}/status`).catch(() => {})] : []),
        ...(draft.kvmDeviceId ? [fetch(`/api/kvms/${draft.kvmDeviceId}/status`).catch(() => {})] : []),
      ]);
    } catch (e) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const pdusWithNoStatus = pdus.filter(p => !pduStatuses[p.id]);

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-5">
      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">PDU ↔ KVM Sync Map</h2>
          <p className="text-xs text-zinc-400 mt-0.5">כל האאוטלטים — ערוך label וKVM ללא cascade</p>
        </div>
      </div>

      {pdusWithNoStatus.length > 0 && (
        <div className="mb-4 text-xs text-amber-400 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2">
          ממתין לסטטוס: {pdusWithNoStatus.map(p => p.name).join(", ")}
        </div>
      )}

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <input
          type="text"
          placeholder="חיפוש לפי OPT, PDU, outlet…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-nv-400/60 w-64"
        />
        <div className="flex gap-1">
          {[
            { id: "all",      label: `הכל (${allRows.length})` },
            { id: "assigned", label: `מוקצה (${totalAssigned})` },
            { id: "empty",    label: `ריק (${totalEmpty})` },
          ].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`px-3 py-1 rounded text-xs font-medium transition ${
                filter === f.id
                  ? "bg-nv-400/20 text-nv-300 border border-nv-400/30"
                  : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200"
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800/60 overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-zinc-900/60 border-b border-zinc-800">
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider w-16">Outlet</th>
              <th className="w-8" />
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider w-20">Watts</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">OPT</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">KVM</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider w-16">Port</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/40">
            {(() => {
              let lastPdu = null;
              return filtered.flatMap(row => {
                const elements = [];
                if (row.pdu_name !== lastPdu) {
                  lastPdu = row.pdu_name;
                  const pduStatus = pduStatuses[row.pdu_id];
                  const onCount  = pduStatus?.outlets?.filter(o => o.state === "on").length ?? "?";
                  const totalW   = pduStatus?.total_watts ?? 0;
                  elements.push(
                    <tr key={`g-${row.pdu_name}`} className="bg-zinc-900/80">
                      <td colSpan={7} className="px-4 py-1.5">
                        <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-widest">{row.pdu_name}</span>
                        <span className="ml-3 text-[10px] text-zinc-500">{onCount} on · {totalW > 0 ? `${totalW.toFixed(0)}W` : ""}</span>
                      </td>
                    </tr>
                  );
                }

                if (row.noStatus) {
                  elements.push(
                    <tr key={`ns-${row.pdu_id}`} className="opacity-40">
                      <td colSpan={7} className="px-4 py-2 text-xs text-zinc-500 italic">לא נטען עדיין…</td>
                    </tr>
                  );
                  return elements;
                }

                const key = editKey(row.pdu_id, row.outlet_number);
                if (editing === key) {
                  elements.push(
                    <EditRow key={key} row={row} pdus={pdus} kvms={kvms}
                      pduStatuses={pduStatuses} kvmStatuses={kvmStatuses}
                      saving={saving}
                      onSave={draft => handleSave(row, draft)}
                      onCancel={() => setEditing(null)} />
                  );
                  return elements;
                }

                elements.push(
                  <tr key={key} className={`hover:bg-zinc-800/20 transition-colors ${!row.label ? "opacity-40 hover:opacity-70" : ""}`}>
                    <td className="px-3 py-2.5 text-zinc-400 font-mono text-sm">#{row.outlet_number}</td>
                    <td className="px-1 py-2.5">
                      <div className={`w-1.5 h-1.5 rounded-full ${row.outlet_state === "on" ? "bg-emerald-400" : "bg-zinc-700"}`} />
                    </td>
                    <td className="px-3 py-2.5 text-zinc-500 text-xs">
                      {row.outlet_watts > 0 ? `${row.outlet_watts.toFixed(0)}W` : ""}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-sm text-zinc-100">
                      {row.label || <span className="text-zinc-700 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-400 text-sm">{row.kvm?.device_name || <span className="text-zinc-700">—</span>}</td>
                    <td className="px-3 py-2.5 text-zinc-400 font-mono text-sm">{row.kvm ? `#${row.kvm.port}` : <span className="text-zinc-700">—</span>}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button onClick={() => setEditing(key)}
                        className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded transition">
                        Edit
                      </button>
                    </td>
                  </tr>
                );
                return elements;
              });
            })()}
            {filtered.length === 0 && allRows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-zinc-500">ממתין לסטטוס PDU…</td></tr>
            )}
            {filtered.length === 0 && allRows.length > 0 && (
              <tr><td colSpan={7} className="text-center py-10 text-zinc-500">אין תוצאות לפילטר הזה</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
