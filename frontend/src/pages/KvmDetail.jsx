import { Fragment, useState } from "react";
import StatusDot from "../components/StatusDot";
import {useAccounts} from "../accounts";
import { deviceState, errorMessage, STATE_DOT, STATE_TEXT } from "../api/client";
import { labelChanges, labelEditState, labelMoveHints, labelPatchBody } from "../api/locations";

export default function KvmDetail({ device, status, onBack, from, onPortClick, onDelete, onLabelsSave, onMarkFree, devices }) {
  const {canOperate,canAdmin} = useAccounts();
  const [editMode, setEditMode] = useState(false);
  const [draftLabels, setDraftLabels] = useState({});
  const [draftRevision, setDraftRevision] = useState(undefined);
  const [draftOriginal, setDraftOriginal] = useState({});
  const [draftBase, setDraftBase] = useState({});   // saved labels when editing started
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  if (!device) return null;
  const ports = status?.ports || [];
  const active = ports.filter(p => p.status === "active").length;
  const inUsePorts = ports.filter(p => p.in_use);
  const isLx = device.model?.includes("LX");
  const state = deviceState(status);
  const moveHints = editMode ? labelMoveHints(device, draftLabels, draftOriginal, devices) : {};

  function startEdit() {
    // The PATCH replaces the whole map: never start from an empty list. Saved labels win over the status reading
    // so the map matches the revision sent with it; saved ports the status does not list are kept as they are.
    if (!ports.length) return;
    const { draft, original, base } = labelEditState(device.labels, ports);
    setDraftLabels(draft);
    setDraftOriginal(original);
    setDraftBase(base);
    setDraftRevision(device.labels_revision);
    setSaveError("");
    setEditMode(true);
  }

  async function saveLabels() {
    if (labelChanges(draftLabels, draftOriginal).length === 0) { setEditMode(false); return; }
    setSaving(true);
    setSaveError("");
    try {
      await onLabelsSave(labelPatchBody(draftBase, draftLabels, draftOriginal), draftRevision);
      setEditMode(false);
    } catch (e) {
      setSaveError(errorMessage(e));
      if (e.status === 409) setEditMode(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex-1 px-6 py-5 max-w-[1600px] w-full mx-auto">
      <BackBar onBack={onBack} crumbs={[from || "Dashboard", device.name]} />
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-5">
        <section className="lg:col-span-2 bg-zinc-900/70 border border-zinc-800 rounded-xl">
          <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">{device.name}</div>
              <div className="text-xs text-zinc-500">{device.model} · {device.ip}</div>
            </div>
            <a href={`https://${device.ip}/`} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 hover:text-nv-400">
              Open native UI ↗
            </a>
          </div>
          {inUsePorts.length > 0 && (
            <div className="px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
              <span className="flex-1">KVM in use — {inUsePorts.map(p => p.label || `Port ${p.number}`).join(", ")}</span>
              <button disabled={!canOperate} onClick={e => { e.stopPropagation(); onMarkFree && onMarkFree(); }}
                title="Mark as free" aria-label="Mark KVM free"
                className="w-6 h-6 inline-flex items-center justify-center rounded text-emerald-600 hover:text-emerald-300 hover:bg-emerald-500/10 transition leading-none">✕</button>
            </div>
          )}
          {state === "error" && (
            <div role="alert" className="px-4 py-2.5 bg-rose-500/10 border-b border-rose-500/30 text-rose-300 text-xs">⚠ {status.error}</div>
          )}
          {isLx && (
            <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs">
              LX II unit — clicking a port opens the native viewer in a new tab
            </div>
          )}
          <div className="p-4">
            {!canOperate && <p dir="rtl" className="text-sm text-amber-300 mb-3">לפתיחת קונסול KVM נדרשת הרשאת Operator או Admin. החשבון הנוכחי הוא לצפייה בלבד.</p>}
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">Ports</div>
              {!editMode ? (
                <button disabled={!canOperate || ports.length === 0} onClick={startEdit}
                  title={canOperate && ports.length === 0 ? "Labels can be edited once the port list has loaded" : undefined}
                  className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-nv-400 px-2 py-1 rounded hover:bg-zinc-800 transition disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-zinc-400">
                  <PencilIcon /> Edit Labels
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button onClick={() => setEditMode(false)}
                    className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">
                    Cancel
                  </button>
                  <button onClick={saveLabels} disabled={saving}
                    className="text-xs bg-nv-400 hover:bg-nv-300 text-zinc-950 font-semibold px-3 py-1 rounded transition disabled:opacity-50">
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
            </div>
            {saveError && <p role="alert" className="mb-3 text-sm text-rose-300">Labels were not saved: {saveError}</p>}
            {editMode && <p className="mb-3 text-xs text-zinc-400">Saving changes only these port labels on {device.name}. To move a server with its PDU outlets, KVM port and rack position, use Admin → Locations → Move.</p>}
            {ports.length === 0 ? (
              <div className="text-zinc-600 text-sm text-center py-8">
                {state === "offline" ? `Cannot reach device: ${status.error}` : state === "error" ? "The port list is unavailable." : state === "unavailable" ? `Status unavailable: ${status.error}` : "Loading…"}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {ports.map(p => (
                  <div key={p.number} className="space-y-1">
                    {editMode ? (
                      <div className="rounded border border-nv-400/40 bg-nv-400/5 p-3 flex flex-col gap-2">
                        <span className="text-xs font-mono text-zinc-500">Port {p.number}</span>
                        <input
                          value={draftLabels[p.number] ?? ""}
                          onChange={e => setDraftLabels(d => ({ ...d, [p.number]: e.target.value }))}
                          placeholder="Empty"
                          aria-label={`Label for port ${p.number}`}
                          aria-describedby={moveHints[p.number] ? `move-hint-kvm-${p.number}` : undefined}
                          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-nv-400 w-full"
                        />
                        {moveHints[p.number] && (
                          <p id={`move-hint-kvm-${p.number}`} className="text-[11px] leading-snug text-amber-300">
                            {moveHints[p.number].name} is already on {moveHints[p.number].where.join(", ")}. Saving changes only this port. To move a server use Locations → Move.
                          </p>
                        )}
                      </div>
                    ) : (
                      <PortCard port={p} onClick={() => onPortClick(p)} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Summary</div>
            <Row label="Status">
              <StatusDot status={STATE_DOT[state]} />
              <span className="ml-1.5">{STATE_TEXT[state]}</span>
            </Row>
            <Row label="Rack" v={device.rack} />
            <Row label="IP" v={device.ip} />
            <Row label="Model" v={device.model} />
            <Row label="Ports" v={ports.length ? `${active} / ${ports.length} active` : `${device.port_count || "—"} configured`} />
          </div>
          {device.notes && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-xs text-amber-200">ⓘ {device.notes}</div>
          )}
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
            <button disabled={!canAdmin} onClick={onDelete} className="w-full text-left text-sm px-3 py-2 rounded hover:bg-rose-500/10 text-rose-400">
              Remove device
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}

function PortCard({ port, onClick }) {
  const {canOperate} = useAccounts();
  const active = port.status === "active";
  const occupied = !!port.label && !/^port\s*\d+$/i.test(port.label);
  return (
    <button disabled={!canOperate} onClick={onClick}
      className={`w-full relative rounded border cursor-pointer overflow-hidden aspect-[4/3] transition
        ${active
          ? "bg-emerald-950/40 border-emerald-500/70 shadow-[0_0_14px_rgba(52,211,153,0.25)]"
          : occupied
            ? "bg-nv-400/5 border-nv-400/40 hover:border-nv-400/70"
            : "bg-zinc-950 border-zinc-800 hover:border-zinc-700"
        }`}>

      <div className="absolute inset-0 flex flex-col items-center justify-center px-2 pb-6">
        {occupied ? (
          <span className={`font-mono font-semibold text-center leading-tight
            ${active ? "text-emerald-300 text-base" : "text-nv-300 text-sm"}`}>
            {port.label}
          </span>
        ) : (
          <span className="text-zinc-700 text-xs">—</span>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black to-transparent flex items-center gap-1.5">
        <span className="font-mono text-zinc-500 text-[11px]">P{port.number}</span>
        <StatusDot status={port.status} />
        {active && <span className="ml-auto text-[10px] font-bold text-emerald-400 tracking-wide">ACTIVE</span>}
      </div>

      {active   && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />}
      {occupied && !active && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-nv-400/70" />}
    </button>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}

function Row({ label, v, children }) {
  return (
    <div className="flex items-center justify-between text-sm py-1.5 border-b border-zinc-800/50 last:border-0">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200">{children ?? v}</span>
    </div>
  );
}

function BackBar({ onBack, crumbs }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <button onClick={onBack} className="text-zinc-400 hover:text-nv-400 flex items-center gap-1">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
        Back
      </button>
      <span className="text-zinc-600">/</span>
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          <span className={i === crumbs.length - 1 ? "text-zinc-200" : "text-zinc-500"}>{c}</span>
          {i < crumbs.length - 1 && <span className="text-zinc-700">/</span>}
        </Fragment>
      ))}
    </div>
  );
}
