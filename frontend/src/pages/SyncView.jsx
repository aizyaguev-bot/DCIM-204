import { useState, useMemo } from "react";
import { api } from "../api/client";
import {useAccounts} from "../accounts";
import { syncClearPlan, clearPorts, clearFailureText } from "../api/locations";
import {
  syncKvmIndex, syncKvmPorts, syncKvmUnavailable, syncPduUnavailable, syncPduRows, syncPduSummary,
  syncKvmChanged, syncKvmConflict, syncSaveWrites, runSyncWrites, syncSaveFailureText,
} from "../api/sync";

function EditRow({ row, kvms, kvmStatuses, saving, onSave, onCancel }) {
  // The row as it was shown when editing began. Every write sends these labels as `expected`, so a port that another
  // session changed meanwhile is refused instead of silently overwritten with a later poll's values.
  const [shown] = useState(row);
  const [label,       setLabel]       = useState(shown.assigned ? shown.label : "");
  const [kvmDeviceId, setKvmDeviceId] = useState(shown.kvm?.device_id || "");
  const [kvmPort,     setKvmPort]     = useState(shown.kvm?.port       || "");

  const kvm = kvms.find(k => k.id === kvmDeviceId);
  const kvmPorts = kvm ? syncKvmPorts(kvm, kvmStatuses[kvmDeviceId]) : [];
  // The label the list shows for the chosen port; undefined when the port number was typed by hand.
  const targetShown = kvmPorts.find(p => p.number === String(kvmPort))?.label;

  const sel = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200";
  const inp = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200";

  return (
    <tr className="bg-zinc-800/40" onKeyDown={e => { if (e.key === "Escape" && !saving) { e.preventDefault(); onCancel(); } }}>
      <td className="px-3 py-2 text-zinc-500 text-sm font-mono">{row.outlet_number}</td>
      <td className="px-3 py-2">
        <div className={`w-1.5 h-1.5 rounded-full inline-block ${row.outlet_state === "on" ? "bg-emerald-400" : "bg-zinc-600"}`} />
      </td>
      <td className="px-3 py-2 text-zinc-500 text-xs">{row.outlet_watts != null ? `${row.outlet_watts.toFixed(0)}W` : "—"}</td>
      <td className="px-3 py-2">
        <input
          autoFocus
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="— empty —"
          aria-label={`OPT label for ${row.pdu_name} outlet ${row.outlet_number}`}
          className={`${inp} w-32`}
        />
      </td>
      <td className="px-3 py-2" colSpan={2}>
        <div className="flex gap-2 items-center">
          <select value={kvmDeviceId} onChange={e => { setKvmDeviceId(e.target.value); setKvmPort(""); }} aria-label={`KVM for outlet ${row.outlet_number}`} className={`${sel} flex-1 min-w-[130px]`}>
            <option value="">— none —</option>
            {kvms.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          {kvmDeviceId && kvmPorts.length > 0 ? (
            <select value={kvmPort} onChange={e => setKvmPort(e.target.value)} aria-label={`KVM port for outlet ${row.outlet_number}`} className={`${sel} min-w-[8rem]`}>
              <option value="">port…</option>
              {kvmPorts.map(p => (
                <option key={p.number} value={p.number}>
                  #{p.number}{p.label && p.label.toLowerCase() !== label.toLowerCase() ? ` (${p.label})` : ""}
                </option>
              ))}
            </select>
          ) : kvmDeviceId ? (
            <input type="number" min="1" value={kvmPort} onChange={e => setKvmPort(e.target.value)} placeholder="port #" aria-label={`KVM port for outlet ${row.outlet_number}`} className={`${inp} w-20`} />
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-2 justify-end">
          <button onClick={() => onSave(shown, { label: label.trim(), kvmDeviceId, kvmPort: String(kvmPort).trim() }, targetShown)} disabled={saving}
            className="px-3 py-1 bg-nv-400 hover:bg-nv-300 text-zinc-950 rounded text-xs font-medium disabled:opacity-50">
            {saving ? "…" : "Save"}
          </button>
          <button onClick={onCancel} disabled={saving} className="px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded text-xs disabled:opacity-50">
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

const nameList = devices => devices.map((d, i) => <span key={d.id}>{i > 0 && ", "}<bdi>{d.name || d.id}</bdi></span>);

export default function SyncView({ devices, pduStatuses, kvmStatuses, onChanged }) {
  const {canOperate} = useAccounts();
  const [editing, setEditing] = useState(null); // { pdu_id, outlet_number }
  const [saving,  setSaving]  = useState(false);
  const [clearing, setClearing] = useState(null); // editKey of the row being cleared
  const [search,  setSearch]  = useState("");
  const [filter,  setFilter]  = useState("all"); // "all" | "assigned" | "empty"

  const pdus = useMemo(() => devices.filter(d => d.kind === "pdu"), [devices]);
  const kvms = useMemo(() => devices.filter(d => d.kind === "kvm"), [devices]);

  // label_lower → { device_id, device_name, port, label }; saved labels keep the links while a KVM cannot be read.
  const kvmByLabel = useMemo(() => syncKvmIndex(kvms, kvmStatuses), [kvms, kvmStatuses]);

  // Every outlet of every PDU: live outlets, saved labels for a PDU that cannot be read, a placeholder otherwise.
  const allRows = useMemo(
    () => pdus.flatMap(pdu => syncPduRows(pdu, pduStatuses[pdu.id], kvmByLabel)),
    [pdus, pduStatuses, kvmByLabel]);

  const filtered = useMemo(() => {
    let result = allRows;
    if (filter === "assigned") result = result.filter(r => r.noStatus || r.assigned);
    if (filter === "empty")    result = result.filter(r => r.noStatus || !r.assigned);
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

  const outletRows    = allRows.filter(r => !r.noStatus);
  const totalAssigned = outletRows.filter(r => r.assigned).length;
  const totalEmpty    = outletRows.length - totalAssigned;

  const editKey = (pdu_id, outlet_number) => `${pdu_id}:${outlet_number}`;

  // `row` is the snapshot the edit row took when it opened; `targetShown` is the chosen KVM port's listed label.
  async function handleSave(row, draft, targetShown) {
    const oldLabel = row.assigned ? row.label : "";
    const newLabel = draft.label;
    // Linking a KVM port writes the server name to it; without a name it would wipe whatever that port holds.
    if (syncKvmChanged(row, draft) && draft.kvmDeviceId && draft.kvmPort && !(newLabel || oldLabel)) {
      alert("Enter the server name for this outlet before linking a KVM port.");
      return;
    }
    const kvmName = kvms.find(k => k.id === draft.kvmDeviceId)?.name || draft.kvmDeviceId;
    // Asked before any write, so Cancel leaves every port as it was.
    const conflict = syncKvmConflict(row, draft, kvmName, targetShown);
    if (conflict && !confirm(conflict)) return;
    const writes = syncSaveWrites(row, draft, kvmName, targetShown);
    if (!writes.length) { setEditing(null); return; }
    setSaving(true);
    try {
      const { done, failed } = await runSyncWrites(writes, api.setDirectLabel);
      if (failed) {
        // After a partial save, or a port changed in another session (409), the draft no longer matches what is
        // saved: close the row so the refreshed table shows the server's labels.
        if (done.length || failed.error?.status === 409) setEditing(null);
        alert(syncSaveFailureText(done, failed));
      } else {
        setEditing(null);
      }
      try { await onChanged?.(); } catch {}
    } finally {
      setSaving(false);
    }
  }

  // Removes this outlet's label and its linked KVM port label only (no cascade); confirm names every port first.
  async function handleClear(row) {
    const plan = syncClearPlan(row);
    if (!plan || !canOperate || clearing || !confirm(plan.message)) return;
    setClearing(editKey(row.pdu_id, row.outlet_number));
    try {
      const { failed } = await clearPorts(plan.ports, api.setDirectLabel);
      if (failed.length) alert(`Clear failed for ${clearFailureText(failed)}. The other ports were cleared.`);
    } finally {
      try { await onChanged?.(); } catch {}
      setClearing(null);
    }
  }

  const waiting = [...pdus.filter(p => !pduStatuses[p.id]), ...kvms.filter(k => !kvmStatuses[k.id])];
  const unavailablePdus = syncPduUnavailable(pdus, pduStatuses);
  const unavailablePduIds = new Set(unavailablePdus.map(p => p.id));
  const unavailableKvms = syncKvmUnavailable(kvms, kvmStatuses);

  return (
    <div className="w-full max-w-[1400px] mx-auto px-4 sm:px-6 py-5">
      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">PDU ↔ KVM Sync Map</h2>
          <p dir="rtl" className="text-xs text-zinc-400 mt-0.5">כל האאוטלטים — ערוך label וKVM ללא cascade</p>
        </div>
      </div>

      {waiting.length > 0 && (
        <div dir="rtl" role="status" className="mb-4 text-xs text-amber-400 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2">
          ממתין לסטטוס: {nameList(waiting)}
        </div>
      )}

      {unavailablePdus.length > 0 && (
        <div dir="rtl" role="alert" className="mb-4 text-xs text-rose-300 bg-rose-950/30 border border-rose-900 rounded-lg px-3 py-2 break-words">
          PDU לא זמין: {nameList(unavailablePdus)}. מצב השקעים וההספק לא ידוע; מוצגות התוויות השמורות{canOperate ? " וניתן לערוך אותן" : ""}.
        </div>
      )}

      {unavailableKvms.length > 0 && (
        <div dir="rtl" role="status" className="mb-4 text-xs text-amber-400 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2 break-words">
          סטטוס KVM לא זמין: {nameList(unavailableKvms)}. הקישורים מוצגים מתוויות שמורות.
        </div>
      )}

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <input
          type="text"
          dir="auto"
          aria-label="Search outlets"
          placeholder="חיפוש לפי OPT, PDU, outlet…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-nv-400/60 w-64 max-w-full"
        />
        <div className="flex gap-1">
          {[
            { id: "all",      label: `הכל (${outletRows.length})` },
            { id: "assigned", label: `מוקצה (${totalAssigned})` },
            { id: "empty",    label: `ריק (${totalEmpty})` },
          ].map(f => (
            <button key={f.id} dir="rtl" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
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

      {/* relative: keeps the sr-only "Actions" text inside this scroll box instead of widening the page. */}
      <div className="relative rounded-xl border border-zinc-800/60 overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-zinc-900/60 border-b border-zinc-800">
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider w-16">Outlet</th>
              <th className="w-8" />
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider w-20">Watts</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">OPT</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">KVM</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-zinc-400 uppercase tracking-wider w-16">Port</th>
              <th className="w-32"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/40">
            {(() => {
              let lastPdu = null;
              return filtered.flatMap(row => {
                const elements = [];
                if (row.pdu_id !== lastPdu) {
                  lastPdu = row.pdu_id;
                  const down = unavailablePduIds.has(row.pdu_id);
                  elements.push(
                    <tr key={`g-${row.pdu_id}`} className="bg-zinc-900/80">
                      <td colSpan={7} className="px-4 py-1.5">
                        <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-widest">{row.pdu_name}</span>
                        <span className={`ml-3 text-[10px] ${down ? "text-rose-300" : "text-zinc-500"}`}>{syncPduSummary(pduStatuses[row.pdu_id])}</span>
                      </td>
                    </tr>
                  );
                }

                if (row.noStatus) {
                  elements.push(
                    <tr key={`ns-${row.pdu_id}`} className={row.pending ? "opacity-40" : ""}>
                      <td colSpan={7} dir="rtl" className={`px-4 py-2 text-xs italic ${row.pending ? "text-zinc-500" : "text-rose-300"}`}>
                        {row.pending ? "לא נטען עדיין…" : "ה-PDU לא זמין ואין לו תוויות שמורות להצגה."}
                      </td>
                    </tr>
                  );
                  return elements;
                }

                const key = editKey(row.pdu_id, row.outlet_number);
                if (editing === key) {
                  elements.push(
                    <EditRow key={key} row={row} kvms={kvms}
                      kvmStatuses={kvmStatuses}
                      saving={saving}
                      onSave={handleSave}
                      onCancel={() => setEditing(null)} />
                  );
                  return elements;
                }

                elements.push(
                  <tr key={key} className={`hover:bg-zinc-800/20 transition-colors ${!row.assigned ? "opacity-40 hover:opacity-70" : ""}`}>
                    <td className="px-3 py-2.5 text-zinc-400 font-mono text-sm">#{row.outlet_number}</td>
                    <td className="px-1 py-2.5">
                      <div className={`w-1.5 h-1.5 rounded-full ${row.outlet_state === "on" ? "bg-emerald-400" : "bg-zinc-700"}`} />
                    </td>
                    <td className="px-3 py-2.5 text-zinc-500 text-xs">
                      {row.outlet_watts != null ? `${row.outlet_watts.toFixed(0)}W` : "—"}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-sm text-zinc-100">
                      {row.assigned ? row.label : <span className="text-zinc-600 text-xs">{row.label || "—"}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-400 text-sm">{row.kvm?.device_name || <span className="text-zinc-700">—</span>}</td>
                    <td className="px-3 py-2.5 text-zinc-400 font-mono text-sm">{row.kvm ? `#${row.kvm.port}` : <span className="text-zinc-700">—</span>}</td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex gap-2 justify-end">
                        {syncClearPlan(row) && (
                          <button disabled={!canOperate || !!clearing} onClick={() => handleClear(row)}
                            aria-label={`Clear ${row.label} from ${row.pdu_name} outlet ${row.outlet_number}${row.kvm ? ` and ${row.kvm.device_name} port ${row.kvm.port}` : ""}`}
                            className="px-3 py-1 text-xs bg-zinc-800 hover:bg-rose-500/10 border border-rose-500/40 text-rose-300 rounded transition disabled:opacity-50">
                            {clearing === key ? "Clearing…" : "Clear"}
                          </button>
                        )}
                        <button disabled={!canOperate || clearing === key} onClick={() => setEditing(key)}
                          aria-label={`Edit ${row.pdu_name} outlet ${row.outlet_number}${row.assigned ? ` (${row.label})` : ""}`}
                          className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded transition">
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                );
                return elements;
              });
            })()}
            {filtered.length === 0 && allRows.length === 0 && (
              <tr><td colSpan={7} dir="rtl" className="text-center py-12 text-zinc-500">ממתין לסטטוס PDU…</td></tr>
            )}
            {filtered.length === 0 && allRows.length > 0 && (
              <tr><td colSpan={7} dir="rtl" className="text-center py-10 text-zinc-500">אין תוצאות לפילטר הזה</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
