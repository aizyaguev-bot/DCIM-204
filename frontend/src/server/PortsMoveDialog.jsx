import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import {
  applyBody, buildMoveRequest, formatLocation, groupByDevice, kindNoun, moveResultIsEmpty, normalizeLocations,
  normalizeMoveResult, parsePortInUse, portKey, portOptions, portText, takenPorts,
} from "../api/locations.js";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { uncheckedText } from "../components/racks/serverMove.js";
import { useLabWindow } from "../window/labWindowContext.js";
import { moveError, moveServers, moveSummary, resultLines, switchChanges, switchLine } from "./moveModel.js";
import "./place.css";

const input = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/60 disabled:opacity-50";

// The server's 409 when a move to ports names a slot another server holds: "U3 in Rack-01 is used by OPTN44. Choose
// OPTN44 as the target to swap the two servers (their outlets and KVM ports swap too), or choose an empty slot."
const SLOT_IN_USE = /^U(\d+) in (.+?) is used by (.+?)\. Choose \3 as the target to swap/;
function parseSlotInUse(detail) {
  const match = SLOT_IN_USE.exec(String(detail || ""));
  return match ? { slot: Number(match[1]), rack: match[2], owner: match[3] } : null;
}

// More › Choose ports… (v1 §1.7): the server's PDU outlets (add a second feed, drop one), its KVM port, and optionally
// a rack and a U (above the floors too, 1-999). Copied from the Locations page's Move dialog ("Empty ports") with the
// window's dialog focus and layer; "Another server's location" is the window's Swap with… and Take over a place….
// One POST /api/devices/move-server dry run (units_follow: true), then Apply with its plan_revision. A slot another
// server holds is refused (409) and offered as a swap with that server instead.
export default function PortsMoveDialog({ record, act, close }) {
  const { data } = useLabWindow();
  // Every server stays in this list, removed ones too: their ports still count as taken.
  const locations = useMemo(() => normalizeLocations(data.locations), [data.locations]);
  const choosable = useMemo(() => moveServers(data.locations, data.hidden).filter(s => !s.removed), [data.locations, data.hidden]);
  const server = useMemo(() => locations.servers.find(s => s.key === record.key) || {
    key: record.key, name: record.name, rack: record.rack, slot: record.slot, kept: null, keptKnown: false,
    pdu: record.pdu.map(p => ({ device_id: p.device_id, device_name: p.device_name, port: p.port, label: p.label })),
    kvm: record.kvm.map(p => ({ device_id: p.device_id, device_name: p.device_name, port: p.port, label: p.label })),
  }, [locations, record]);
  const [draft, setDraft] = useState(() => ({ mode: "ports", slotSwap: false, swap: false, rack: "", slot: "",
    pdu: server.pdu.map(p => ({ ...p, current: true })), kvm: server.kvm.map(p => ({ ...p, current: true })) }));
  const [preview, setPreview] = useState(null);   // normalized dry-run result + the body it was made for
  const [busy, setBusy] = useState(null);         // "preview" | "apply"
  const [error, setError] = useState("");
  const [inUse, setInUse] = useState(null);
  const [slotTaken, setSlotTaken] = useState(null);
  const panelRef = useRef(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const previewSeq = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewSeq.current++; }; }, []);
  useDialogFocus(panelRef, { busyRef, onEscape: close });

  const pduOptions = useMemo(() => portOptions(locations, server, "pdu"), [locations, server]);
  const kvmOptions = useMemo(() => portOptions(locations, server, "kvm"), [locations, server]);
  const racks = useMemo(() => [...new Set([...locations.racks, server.rack].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [locations, server.rack]);
  const takenPdu = takenPorts(draft.pdu, locations, server, "pdu", inUse);
  const takenKvm = takenPorts(draft.kvm, locations, server, "kvm", inUse);
  const anyTaken = Object.keys(takenPdu).length + Object.keys(takenKvm).length > 0;
  // The server holding the slot a move was refused for, offered as a swap (never a removed server).
  const slotOwner = slotTaken ? choosable.find(s => s.key !== server.key && s.name.toLowerCase() === slotTaken.owner.toLowerCase()) || null : null;
  const keepsSlot = server.slot != null && (!draft.rack || draft.rack === server.rack);

  // Any edit invalidates the preview: Apply always sends exactly what was previewed.
  function update(patch) {
    previewSeq.current++;
    setDraft(d => ({ ...d, ...patch }));
    setPreview(null);
    setError("");
    setInUse(null);
    setSlotTaken(null);
  }

  function refused(err) {
    setPreview(null);
    setError(moveError(err));
    setInUse(err.status === 409 ? parsePortInUse(err.detail) : null);
    setSlotTaken(err.status === 409 ? parseSlotInUse(err.detail) : null);
  }

  async function runPreview(e) {
    e?.preventDefault();
    if (busyRef.current) return;
    const built = buildMoveRequest(server, draft, true, { maxSlot: 999 });
    if (built.error) { setError(built.error); setPreview(null); return; }
    const mine = ++previewSeq.current;
    busyRef.current = true;
    setBusy("preview");
    setError("");
    try {
      const raw = await api.moveServer(built.body);
      if (!mounted.current || mine !== previewSeq.current) return;
      setPreview({ ...normalizeMoveResult(raw), switch: switchChanges(raw), body: built.body });
    } catch (err) {
      if (!mounted.current || mine !== previewSeq.current) return;
      refused(err);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function apply() {
    if (busyRef.current || !preview || moveResultIsEmpty(preview)) return;
    busyRef.current = true;
    setBusy("apply");
    setError("");
    try {
      const raw = await act.during(() => api.moveServer(applyBody(preview)));
      busyRef.current = false;
      const title = moveSummary("ports", record);
      act.showResult({ title, lines: resultLines(raw) });
      act.toast(title);
      act.reload?.();
      close();
    } catch (err) {
      busyRef.current = false;
      if (!mounted.current) return;
      refused(err);
      setBusy(null);
    }
  }

  const disabled = !!busy;
  const canApply = preview && !moveResultIsEmpty(preview) && !busy;
  return <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-2 sm:p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) close(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="ports-dialog-title" aria-describedby="ports-dialog-desc" tabIndex={-1}
      data-dialog="ports-move"
      className="place-dialog bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-xl max-h-[calc(100dvh-16px)] sm:max-h-[calc(100dvh-32px)] overflow-y-auto">
      <div className="px-4 sm:px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between gap-3">
        <h2 id="ports-dialog-title" dir="auto" className="font-medium text-nv-300 truncate">Choose ports for {server.name}</h2>
        <button type="button" onClick={() => { if (!busyRef.current) close(); }} disabled={disabled} aria-label="Close" className="text-zinc-400 hover:text-zinc-100 w-8 h-8 shrink-0 rounded hover:bg-zinc-800 disabled:opacity-40">✕</button>
      </div>
      <div id="ports-dialog-desc" className="px-4 sm:px-5 pt-4 text-xs text-zinc-400 space-y-0.5">
        <div>Now: <span className="text-zinc-200">{formatLocation(server)}</span></div>
        <div>PDU: <span className="text-zinc-200">{server.pdu.map(p => `${p.device_name} #${p.port}`).join(", ") || "none"}</span></div>
        <div>KVM: <span className="text-zinc-200">{server.kvm.map(p => `${p.device_name} #${p.port}`).join(", ") || "none"}</span></div>
      </div>
      <form onSubmit={runPreview} noValidate>
        <div className="p-4 sm:p-5 space-y-4 text-sm">
          <p className="text-xs text-zinc-500">The selected ports replace {server.name}'s current ports. Current ports you remove are cleared. To take another server's place, use Swap with… or Take over a place….</p>
          <PortPicker kind="pdu" title="PDU outlets" options={pduOptions} chosen={draft.pdu} taken={takenPdu} disabled={disabled} onChange={pdu => update({ pdu })}/>
          <PortPicker kind="kvm" title="KVM port" options={kvmOptions} chosen={draft.kvm} taken={takenKvm} disabled={disabled} onChange={kvm => update({ kvm })}/>
          {anyTaken && <p className="text-xs text-rose-300">Ports marked "in use" belong to another server. Remove them, or swap with that server (Swap with…).</p>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ports-rack" className="block text-xs text-zinc-400 mb-1">Rack (optional)</label>
              <select id="ports-rack" value={draft.rack} disabled={disabled} onChange={e => update({ rack: e.target.value })} className={`${input} w-full`}>
                <option value="">Keep current</option>
                {racks.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ports-slot" className="block text-xs text-zinc-400 mb-1">Slot U (optional)</label>
              <input id="ports-slot" type="number" inputMode="numeric" min="1" max="999" value={draft.slot} disabled={disabled}
                onChange={e => update({ slot: e.target.value })} placeholder={keepsSlot ? String(server.slot) : "—"} className={`${input} w-full`}/>
            </div>
          </div>
          {String(draft.slot).trim() !== "" && <p className="text-xs text-zinc-500" data-slot-hint="">
            Choose an empty slot (1-4 are the floors; a higher U is above them). To take another server's slot, swap with that server: its outlets and KVM port swap too.
          </p>}
          {error && <p role="alert" dir="auto" className="text-xs text-rose-300" data-move-error="">{error}</p>}
          {error && slotOwner && <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400" data-slot-taken="">
            <button type="button" disabled={disabled} onClick={() => act.openMove({ mode: "swap", swapWith: slotOwner.name })}
              className="px-3 py-1.5 rounded border border-nv-400/40 bg-nv-400/10 hover:bg-nv-400/20 text-nv-300 disabled:opacity-50">
              Swap with {slotOwner.name} instead
            </button>
            <span>{server.name} takes {formatLocation(slotTaken)} with its outlets and KVM port; {slotOwner.name} takes {server.name}'s place and ports.</span>
          </div>}
          {preview && <section tabIndex={-1} aria-label="Preview of changes" data-move-preview="" className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Preview — nothing saved yet</div>
            {moveResultIsEmpty(preview) ? <p className="text-xs text-zinc-400">Nothing would change.</p> : <ChangeList result={preview}/>}
          </section>}
        </div>
        <div className="px-4 sm:px-5 py-3 border-t border-zinc-800 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => { if (!busyRef.current) close(); }} disabled={disabled} className="text-sm px-3 py-1.5 rounded hover:bg-zinc-800 text-zinc-300 disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={disabled} data-action="preview-ports"
            className="text-sm px-3.5 py-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:opacity-50">
            {busy === "preview" ? "Checking…" : preview ? "Preview again" : "Preview changes"}
          </button>
          <button type="button" onClick={apply} disabled={!canApply} data-action="apply-ports" title={!preview ? "Preview the changes first" : undefined}
            className="text-sm px-3.5 py-1.5 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium disabled:opacity-50">
            {busy === "apply" ? "Applying…" : "Apply"}
          </button>
        </div>
      </form>
    </section>
  </div>;
}

function ChangeList({ result }) {
  return <div className="space-y-3 text-sm">
    <div>
      <div className="text-xs text-zinc-500 mb-1">Port labels ({result.changes.length})</div>
      {result.changes.length === 0 ? <p className="text-xs text-zinc-500">No port label changes.</p> : (
        <ul className="max-h-48 overflow-y-auto rounded border border-zinc-800 divide-y divide-zinc-800/60" data-list="labels">
          {result.changes.map((c, i) => <li key={`${c.device_id}:${c.port}:${i}`} className="px-2 py-1.5 text-xs flex flex-wrap gap-x-2">
            <span className="text-zinc-400">{c.where}</span>
            <span><span className="font-mono text-zinc-400">{c.before}</span> <span aria-hidden="true">→</span><span className="sr-only">to</span> <span className="font-mono text-zinc-100">{c.after}</span></span>
          </li>)}
        </ul>
      )}
    </div>
    {result.positions.length > 0 && <div>
      <div className="text-xs text-zinc-500 mb-1">Rack positions</div>
      <ul className="rounded border border-zinc-800 divide-y divide-zinc-800/60" data-list="places">
        {result.positions.map((p, i) => <li key={`${p.server}:${i}`} className="px-2 py-1.5 text-xs flex flex-wrap gap-x-2">
          <span className="font-mono text-zinc-200">{p.server}</span>
          <span className="text-zinc-400">{p.before} <span aria-hidden="true">→</span><span className="sr-only">to</span> <span className="text-zinc-100">{p.after}</span></span>
        </li>)}
      </ul>
    </div>}
    {result.units?.length > 0 && <div data-list="units">
      <div className="text-xs text-zinc-500 mb-1">Units that move with their servers</div>
      <ul className="rounded border border-zinc-800 divide-y divide-zinc-800/60">
        {result.units.map((m, i) => <li key={`${m.server}:${i}`} className="px-2 py-1.5 text-xs flex flex-wrap gap-x-2" dir="auto">
          <span className="font-mono text-zinc-200">{m.server}</span>
          <span className="text-zinc-100"><bdi>{m.names.join(", ")}</bdi></span>
          <span className="text-zinc-400">{m.from} <span aria-hidden="true">→</span><span className="sr-only">to</span> <span className="text-zinc-100">{m.to}</span></span>
        </li>)}
      </ul>
    </div>}
    {result.switch?.length > 0 && <div data-list="switch">
      <div className="text-xs text-zinc-500 mb-1">Switch ports</div>
      <ul className="rounded border border-zinc-800 divide-y divide-zinc-800/60">
        {result.switch.map(s => <li key={s.server} className="px-2 py-1.5 text-xs" dir="auto">{switchLine(s)}</li>)}
      </ul>
    </div>}
    {result.unplaced.length > 0 && <p className="text-xs text-amber-300" data-list="unplaced">Becomes unplaced (no ports, no rack position): {result.unplaced.join(", ")}</p>}
    {result.unchecked?.length > 0 && <p className="text-xs text-amber-300" role="note" dir="auto" data-unchecked="">
      Not checked: {uncheckedText(result.unchecked)}. Their own port names are unknown right now (the device does not answer, or it was not read since the server started), so those ports keep their names: check them under Consoles or Power and fix the label there.
    </p>}
  </div>;
}

function PortPicker({ kind, title, options, chosen, taken = {}, disabled, onChange }) {
  const [pick, setPick] = useState("");
  const noun = kindNoun(kind);
  const chosenKeys = new Set(chosen.map(portKey));
  const available = options.filter(o => !chosenKeys.has(portKey(o)));
  const selectId = `ports-add-${kind}`;

  function add() {
    const port = available.find(o => portKey(o) === pick);
    if (!port) return;
    onChange([...chosen, port]);
    setPick("");
  }

  return <fieldset disabled={disabled} className="rounded border border-zinc-800 p-2.5" data-port-picker={kind}>
    <legend className="px-1 text-xs text-zinc-400">{title}</legend>
    {chosen.length === 0 ? <p className="text-xs text-zinc-500 mb-2">None selected.</p> : (
      <ul className="flex flex-wrap gap-1.5 mb-2">
        {chosen.map(p => {
          const owner = taken[portKey(p)];
          return <li key={portKey(p)} className={`flex items-center gap-1 rounded border pl-2 text-xs text-zinc-200 ${owner ? "border-rose-500/60 bg-rose-500/10" : "border-nv-400/30 bg-nv-400/5"}`}>
            {portText(p, kind)}
            {owner ? <span className="text-rose-300">(in use by {owner})</span> : p.current && <span className="text-zinc-500">(current)</span>}
            <button type="button" onClick={() => onChange(chosen.filter(c => portKey(c) !== portKey(p)))}
              aria-label={`Remove ${portText(p, kind)}${owner ? `, in use by ${owner}` : ""}`}
              className="w-7 h-7 text-zinc-400 hover:text-zinc-100">✕</button>
          </li>;
        })}
      </ul>
    )}
    {available.length === 0 ? <p className="text-xs text-zinc-600">No other empty {noun}s.</p> : (
      <div className="flex gap-2">
        <label htmlFor={selectId} className="sr-only">Add {kind === "pdu" ? "PDU outlet" : "KVM port"}</label>
        <select id={selectId} value={pick} onChange={e => setPick(e.target.value)} className={`${input} flex-1 min-w-0`}>
          <option value="">Choose an empty {noun}…</option>
          {groupByDevice(available).map(g => <optgroup key={g.device_id} label={g.device_name}>
            {g.ports.map(p => <option key={portKey(p)} value={portKey(p)}>{g.device_name} · {noun} {p.port}{p.current ? " (current)" : ""}</option>)}
          </optgroup>)}
        </select>
        <button type="button" onClick={add} disabled={!pick}
          className="px-3 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded disabled:opacity-50">Add</button>
      </div>
    )}
  </fieldset>;
}
