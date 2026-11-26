import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { floorsFor, placeWord } from "../components/racks/floors.js";
import { freeOutlets, labelChangeText, takesOverText, uncheckedText } from "../components/racks/serverMove.js";
import { useLabWindow } from "../window/labWindowContext.js";
import { windowKey } from "./serverKey.js";
import SwapWithPicker from "./SwapWithPicker.jsx";
import {
  defaultFloor, feedDefaults, floorPorts, freeKvmPorts, kvmDefault, kvmValue, moveBody, moveDataKey, moveError,
  moveRacks, moveServers, moveSummary, movedPlaces, occupants, outletValue, placeLine, resultLines, switchChanges,
  switchLine, undoBody, unitNamesOf, whereText,
} from "./moveModel.js";
import "./place.css";

// The toast's Undo of a swap or a move: the reverse move, previewed and applied with that preview's plan revision (the
// Undo click is the confirmation). Refused (409 and the like) when something changed meanwhile: the toast says so.
export async function undoMove(act, body, name) {
  try {
    const plan = await api.moveServer({ ...body, dry_run: true });
    const result = await act.during(() => api.moveServer({ ...body, dry_run: false, plan_revision: plan.plan_revision }));
    act.showResult({ title: `Undone: ${name} is back where it was.`, lines: resultLines(result) });
    act.toast(`Undone: ${name} is back where it was.`);
    act.reload?.();
  } catch (e) {
    act.toast(`Undo failed: ${moveError(e)}`, { tone: "error" });
  }
}

const TITLE = {
  swap: (name, other) => (other ? <>Swap <bdi>{name}</bdi> and <bdi>{other}</bdi></> : <>Swap <bdi>{name}</bdi> with…</>),
  takeover: (name, other) => (other ? <><bdi>{name}</bdi> takes over the place of <bdi>{other}</bdi></> : <>Take over a place for <bdi>{name}</bdi></>),
  move: name => <>Move <bdi>{name}</bdi></>,
  pin: (name, _other, place) => <>Pin <bdi>{name}</bdi> to {place}</>,
};

// Swap, move, take over and pin, from the server window (v1 §1.7). Built only from the provider's
// GET /api/devices/locations (floors from each row's `drawn`) and the server's own dry run of
// POST /api/devices/move-server, so it works for KVM-only, unplaced and two-feed servers.
//   swap      pick a server (search): each takes the other's ports, place and the units of its floor
//   move      pick a rack and floor: a floor with one server is a swap with it; a floor with several offers one
//             "Swap with" button each and saves nothing; an empty floor asks which outlet feeds it (per feed: keep,
//             a free outlet or drop it) and which KVM port serves it
//   takeover  pick a server: this one takes its ports and place, the other becomes unplaced
//   pin       an auto-placed server keeps the floor it shows now (rack_slots)
// The units on the floor it leaves move with it unless "Move the units on this floor with the server" is cleared.
// The preview is read again whenever the lab data changes (moveDataKey) and after a refused save (409), with every
// choice kept. A PDU/KVM whose own port names are unknown is read once and then named as not checked.
//
// dialog: { type: "move", key, mode, swapWith?, moveTo?: { rack, u }, fixed? } (act.openMove); fixed: the target was
// decided elsewhere (a drag on Racks) and cannot be changed here.
export default function MoveDialog({ dialog, record, act, close }) {
  const { data } = useLabWindow();
  const panelRef = useRef(null);
  const pickerRef = useRef(null);
  const busyRef = useRef(false);
  const openRef = useRef(true);
  useEffect(() => { openRef.current = true; return () => { openRef.current = false; }; }, []);
  const id = useId();
  const fixed = !!dialog.fixed;

  const servers = useMemo(() => moveServers(data.locations, data.hidden), [data.locations, data.hidden]);
  const keyOf = value => (value ? windowKey(value) || String(value).trim().toLowerCase() : null);
  const [mode, setMode] = useState(["swap", "takeover", "pin", "move"].includes(dialog.mode) ? dialog.mode : "move");
  const [otherKey, setOtherKey] = useState(() => keyOf(dialog.swapWith));
  const other = otherKey ? servers.find(s => s.key === otherKey && !s.removed && s.key !== record.key) || null : null;
  const racks = useMemo(() => moveRacks(data.locations), [data.locations]);
  const [rack, setRack] = useState(() => dialog.moveTo?.rack || record.drawn?.rack || record.rack || racks[0] || "");
  const [floor, setFloor] = useState(() => (Number.isInteger(dialog.moveTo?.u) ? dialog.moveTo.u
    : defaultFloor(servers, dialog.moveTo?.rack || record.drawn?.rack || record.rack || racks[0] || "", record)));
  const [feeds, setFeeds] = useState(null);       // null: the defaults of this floor (feedDefaults)
  const [kvm, setKvm] = useState(null);           // null: kvmDefault
  const [unitsFollow, setUnitsFollow] = useState(true);
  const [plan, setPlan] = useState({ key: null, result: null, error: "" });
  const [ticked, setTicked] = useState({ key: "", units: [] });   // the units of the last preview with the box ticked
  const [again, setAgain] = useState(0);          // a refused save (or a status read) previews again
  const [statusRead, setStatusRead] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Focus starts in the server picker (Swap with…, Take over…), else on the first field.
  useDialogFocus(panelRef, { initialRef: pickerRef, busyRef, onEscape: close });

  // ── what this choice means ──
  const word = placeWord(rack);
  const count = floorsFor(rack);
  const moving = mode === "move";
  const here = moving ? occupants(servers, rack, floor, record.key) : [];
  const already = moving && record.drawn?.rack === rack && record.drawn?.u === floor;
  const floorSwap = moving && !already && here.length === 1 ? here[0] : null;
  const crowded = moving && !already && here.length > 1;
  const empty = moving && !already && here.length === 0;
  const devices = data.devices || [];
  const pdus = useMemo(() => devices.filter(d => d?.kind === "pdu"), [devices]);
  const free = useMemo(() => (empty ? freeOutlets(pdus, rack, data.locations?.empty_ports?.pdu) : []), [empty, pdus, rack, data.locations]);
  const freeKvm = useMemo(() => (empty ? freeKvmPorts(devices, rack, data.locations?.empty_ports?.kvm) : []), [empty, devices, rack, data.locations]);
  // The choices on screen. One that is no longer offered (its outlet or port was taken elsewhere meanwhile, or the
  // server's own feeds changed) falls back to this floor's default, so each select shows what is previewed and sent.
  const ownFeedsNow = record.pdu || [];
  const validFeed = (value, i) => (value === "keep" || value === "drop" ? !!ownFeedsNow[i]
    : value === "none" ? i === 0 && !ownFeedsNow.length : free.some(o => outletValue(o) === value));
  const validKvm = value => (value === "keep" ? record.kvm.length > 0 : value === "none" || freeKvm.some(p => kvmValue(p) === value));
  const feedValues = feedDefaults(record, free, floor).map((d, i) => (feeds && validFeed(feeds[i], i) ? feeds[i] : d));
  const kvmChoice = kvm && validKvm(kvm) ? kvm : kvmDefault(record, freeKvm, floor);
  const staleChoice = (!!feeds && (feeds.length !== feedValues.length || feeds.some((v, i) => v !== feedValues[i])))
    || (!!kvm && kvm !== kvmChoice);
  const onFloor = empty ? floorPorts(record, feedValues, kvmChoice) : null;
  const effective = floorSwap ? "swap" : mode;               // a move onto one server's floor is a swap with it
  const target = floorSwap || other;                         // the other server of a swap or take-over
  const body = mode === "pin" ? moveBody({ mode, record, unitsFollow })
    : mode === "swap" || mode === "takeover" ? (other ? moveBody({ mode, record, other: other.name, unitsFollow }) : null)
    : floorSwap ? moveBody({ mode: "swap", record, other: floorSwap.name, unitsFollow })
    : empty && !onFloor.error ? moveBody({ mode: "move", record, rack, u: floor, ports: onFloor.ports, unitsFollow })
    : null;
  const bodyKey = body ? JSON.stringify(body) : "";
  const choiceKey = body ? JSON.stringify({ ...body, units_follow: true }) : "";
  const dataKey = moveDataKey(data.locations, data.etags?.rackItems, devices);
  // A preview counts only for this body, this state of the lab data and this attempt: anything newer reads it again.
  const planKey = bodyKey ? `${bodyKey}|${dataKey}|${again}` : "";

  useEffect(() => {
    if (!planKey) return;
    let alive = true;
    const timer = setTimeout(() => {
      api.moveServer({ ...JSON.parse(bodyKey), dry_run: true })
        .then(result => { if (alive) setPlan({ key: planKey, result, error: "" }); })
        .catch(e => { if (alive) setPlan({ key: planKey, result: null, error: moveError(e) }); });
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [planKey]);
  const current = planKey && plan.key === planKey ? plan : { result: null, error: "" };
  const planned = current.result;
  const unchecked = Array.isArray(planned?.unchecked) ? planned.unchecked : [];
  const plannedUnits = Array.isArray(planned?.units) ? planned.units : [];
  // The units the ticked box would move, kept so that clearing the box can name the ones that stay.
  useEffect(() => {
    if (planned && unitsFollow && choiceKey && ticked.key !== `${choiceKey}|${dataKey}`) setTicked({ key: `${choiceKey}|${dataKey}`, units: plannedUnits });
  }, [planned]);
  const staying = !unitsFollow && ticked.key.startsWith(`${choiceKey}|`) ? ticked.units : null;

  // A PDU/KVM whose own port names the server does not know now: read its status once (that fills the server's status
  // cache when it answers) and preview again; whatever the reads answer, the next preview counts.
  useEffect(() => {
    if (!unchecked.length || statusRead) return;
    setStatusRead("reading");
    Promise.allSettled(unchecked.map(d => (d.kind === "kvm" ? api.getKvmStatus(d.device_id) : api.getPduStatus(d.device_id)))).then(() => {
      if (!openRef.current) return;
      setStatusRead("done");
      setAgain(n => n + 1);
    });
  }, [unchecked.length, statusRead]);
  const reading = statusRead === "reading" || (unchecked.length > 0 && !statusRead);
  // What a swap's servers take over, from the preview's label changes: never claimed before the preview, and never a
  // port the preview could not check (a KVM that does not answer).
  const takesOver = planned ? takesOverText(planned.changes) : null;
  const ready = !!body && !!planned?.plan_revision && !reading && !busy;

  function reset(patch = {}) {
    setError("");
    if ("rack" in patch) { setRack(patch.rack); setFloor(patch.floor ?? defaultFloor(servers, patch.rack, record)); setFeeds(null); setKvm(null); }
    if ("floor" in patch && !("rack" in patch)) { setFloor(patch.floor); setFeeds(null); setKvm(null); }
  }
  function swapWith(server) {
    setMode("swap"); setOtherKey(server.key); setError("");
  }

  async function confirm() {
    if (busyRef.current || !ready) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const sent = { ...body, dry_run: false, plan_revision: planned.plan_revision };
      const result = await act.during(() => api.moveServer(sent));
      busyRef.current = false;
      const place = effective === "pin" ? { rack: record.drawn?.rack, slot: record.drawn?.u } : { rack, slot: floor };
      const title = moveSummary(effective, record, target?.name, place);
      act.showResult({ title, lines: resultLines(result) });
      const undo = undoBody(effective, record, body);
      act.toast(title, undo ? { undo: () => undoMove(act, undo, record.name) } : {});
      act.reload?.();
      close();
    } catch (e) {
      busyRef.current = false; setBusy(false);
      setError(moveError(e));
      setAgain(n => n + 1);   // read the latest and preview again, every choice kept
    }
  }

  const titleId = `${id}-title`, bodyId = `${id}-body`;
  const pinPlace = whereText({ rack: record.drawn?.rack, slot: record.drawn?.u });
  const title = (TITLE[effective] || TITLE.move)(record.name, target?.name, pinPlace);
  const victim = effective === "takeover" ? target?.name : null;
  const confirmText = busy ? (effective === "swap" ? "Swapping…" : "Saving…")
    : effective === "swap" ? "Swap" : effective === "takeover" ? (victim ? `Take over — ${victim} loses its outlet and port` : "Take over")
    : effective === "pin" ? "Pin" : "Move";
  const unplaced = Array.isArray(planned?.unplaced) ? planned.unplaced : [];
  const places = movedPlaces(planned);
  const switches = switchChanges(planned);
  const ownFeeds = record.pdu || [];
  // A pin (any move-server) also pins the other automatically placed servers of the rack to the floors they show now.
  const pinWord = placeWord(record.drawn?.rack);
  const pinAlso = effective === "pin" ? servers.filter(s => s.key !== record.key && !s.removed && s.drawn?.auto
    && s.drawn.rack === record.drawn?.rack).map(s => s.name) : [];

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) close(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}
      className="racks-dialog racks-dialog-wide place-dialog" data-dialog="server-move" data-mode={effective}>
      <h2 id={titleId} dir="auto" className="racks-dialog-title">{title}</h2>
      <div id={bodyId}>
        <p className="racks-dialog-note" data-move-plan="">
          {effective === "pin" ? <>It keeps {pinPlace} from now on, when servers before it move or leave. No server moves.{pinAlso.length > 0 && <> <bdi>{listText(pinAlso)}</bdi> {pinAlso.length > 1 ? "are" : "is"} pinned to the {pinAlso.length > 1 ? (pinWord === "shelf" ? "shelves" : "floors") : pinWord} {pinAlso.length > 1 ? "they show" : "it shows"} now as well.</>}</>
            : effective === "takeover" ? <>It takes the PDU outlet, KVM port and place of the server you choose; that server keeps none of them.</>
            : effective === "swap" && target ? <><bdi>{record.name}</bdi> goes to {whereTextOf(target)}; <bdi>{target.name}</bdi> goes to {whereTextOf(record)}.{takesOver == null ? null : takesOver
              ? <> Each takes over the {takesOver} of its new {placeWord(target.drawn?.rack || record.drawn?.rack)}.</>
              : <> Neither has a PDU outlet or KVM port label to take over.</>}</>
            : effective === "swap" ? <>Each takes over the other's PDU outlet, KVM port and place.</>
            : <>From {whereTextOf(record)}. The PDU outlet and KVM port belong to the floor: the server takes over the ones of its new floor.</>}
        </p>

        {(mode === "swap" || mode === "takeover") && !fixed && <SwapWithPicker inputRef={pickerRef}
          label={mode === "swap" ? "Swap with" : "Take over the place of"} servers={servers} except={record.key} value={other}
          disabled={busy} onPick={key => { setOtherKey(key); setError(""); }}/>}

        {moving && !fixed && <div className="place-dialog-row">
          <div className="racks-field">
            <label htmlFor={`${id}-rack`}>Rack</label>
            <select id={`${id}-rack`} value={rack} disabled={busy} onChange={e => reset({ rack: e.target.value })}>
              {racks.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="racks-field">
            <label htmlFor={`${id}-floor`}>{word === "shelf" ? "Shelf" : "Floor"}</label>
            <select id={`${id}-floor`} value={String(floor)} disabled={busy} onChange={e => reset({ floor: Number(e.target.value) })}>
              {Array.from({ length: count }, (_, i) => i + 1).map(u => {
                const names = occupants(servers, rack, u, record.key).map(s => s.name);
                const mine = record.drawn?.rack === rack && record.drawn?.u === u;
                return <option key={u} value={u}>{`${word === "shelf" ? "Shelf" : "Floor"} ${u} · ${mine ? "its place now" : names.length ? names.join(", ") : "free"}`}</option>;
              })}
            </select>
          </div>
        </div>}

        {crowded && <div className="place-dialog-crowded" role="group" aria-label={`Servers on ${word} ${floor}`} data-crowded="">
          <p className="racks-dialog-error" role="note"><bdi>{here.map(s => s.name).join(" and ")}</bdi> share this {word}. Swap with one of them, or choose another {word}.</p>
          <div className="racks-dialog-actions place-dialog-swaps">
            {here.map(s => <button key={s.key} type="button" className="racks-btn" disabled={busy} onClick={() => swapWith(s)}>Swap with {s.name}</button>)}
          </div>
        </div>}
        {floorSwap && <p className="racks-muted" role="note" data-floor-swap="">{word === "shelf" ? "Shelf" : "Floor"} {floor} holds <bdi>{floorSwap.name}</bdi>: the two swap places.</p>}
        {already && <p className="racks-muted" role="status">It is already there.</p>}

        {empty && <>
          <fieldset className="place-dialog-fieldset" data-floor-outlet="" disabled={busy}>
            <legend>{`Which PDU outlet feeds ${word} ${floor}?`}</legend>
            {feedValues.map((value, i) => {
              const own = ownFeeds[i] || null;
              const selectId = `${id}-feed-${i}`;
              return <div key={i} className="racks-field" data-feed={i + 1}>
                <label htmlFor={selectId}>{own ? `Feed ${i + 1} (${own.device_name || own.device_id} · outlet ${own.port})` : "PDU outlet"}</label>
                <select id={selectId} value={value} onChange={e => { const next = [...feedValues]; next[i] = e.target.value; setFeeds(next); setError(""); }}>
                  {own ? <option value="keep">{`Keep ${own.device_name || own.device_id} · outlet ${own.port}`}</option> : <option value="none">No PDU outlet</option>}
                  {free.map(o => <option key={outletValue(o)} value={outletValue(o)}>{`${o.pduName} · outlet ${o.outlet}${o.label ? ` (${o.label})` : ""}`}</option>)}
                  {own && <option value="drop">Drop this feed</option>}
                </select>
              </div>;
            })}
            <p className="racks-field-hint" data-outlet-hint="">{outletHint(free, floor, word, feedValues, rack)}</p>
            {onFloor.noPdu && <p className="move-preview-warning" role="note" data-no-pdu="">Without a PDU outlet <bdi>{record.name}</bdi> is not drawn on Racks.</p>}
          </fieldset>
          <div className="racks-field" data-floor-kvm="">
            <label htmlFor={`${id}-kvm`}>{`Which KVM port serves ${word} ${floor}?`}</label>
            <select id={`${id}-kvm`} value={kvmChoice} disabled={busy} onChange={e => { setKvm(e.target.value); setError(""); }}>
              {record.kvm.length > 0 && <option value="keep">{`Keep ${record.kvm.map(p => `${p.device_name || p.device_id} · port ${p.port}`).join(", ")}`}</option>}
              {freeKvm.map(p => <option key={kvmValue(p)} value={kvmValue(p)}>{`${p.kvmName} · port ${p.port}${p.label ? ` (${p.label})` : ""}`}</option>)}
              <option value="none">No KVM port</option>
            </select>
            {!freeKvm.length && <p className="racks-field-hint">{rack} has no free KVM port.</p>}
          </div>
          {staleChoice && <p className="racks-field-hint" role="status" data-stale-choice="">A port chosen here was taken meanwhile, so this {word}'s default is shown instead.</p>}
          {onFloor.error && <p className="racks-field-error" role="alert">{onFloor.error}</p>}
        </>}

        {effective !== "pin" && body && <div className="units-follow" role="group" aria-label="Units that move with the server" data-units-follow="">
          {unitsFollow
            ? (planned ? (plannedUnits.length
              ? plannedUnits.map((m, i) => <p key={i} data-moves-with={m.server}>
                <span className="units-follow-label">{m.server === record.name ? "Moves with it" : <>Moves with <bdi>{m.server}</bdi></>}:</span> <bdi>{unitNamesOf(m).join(", ")}</bdi> <span className="racks-muted">({whereText(m.from)} → {whereText(m.to)})</span>
              </p>)
              : <p><span className="units-follow-label">Moves with it:</span> no units (nothing on the floors it leaves).</p>)
              : <p className="racks-muted" role="status">Checking which units move with it…</p>)
            : <p className="racks-muted" data-units-stay="">{staying?.length
              ? <>These stay where they are: <bdi>{staying.flatMap(unitNamesOf).join(", ")}</bdi>.</>
              : "The units stay where they are now."}</p>}
          <label className="units-follow-check">
            <input type="checkbox" checked={unitsFollow} disabled={busy} onChange={e => { setUnitsFollow(e.target.checked); setError(""); }}/>
            <span>Move the units on this floor with the server</span>
          </label>
        </div>}

        {body && <div className="move-preview" data-move-preview="" aria-live="polite">
          {!planned && !current.error && <p className="racks-muted" role="status">Checking what changes…</p>}
          {current.error && <p className="racks-dialog-error" role="alert" dir="auto">{current.error}</p>}
          {planned && <>
            {unplaced.length > 0 && <>
              <p className="racks-dialog-subtitle">Becomes unplaced</p>
              <ul className="move-preview-list" data-list="unplaced">{unplaced.map(n => <li key={n} dir="auto"><bdi>{n}</bdi> loses its outlet, port and place</li>)}</ul>
            </>}
            <p className="racks-dialog-subtitle">Port labels</p>
            {planned.changes?.length
              ? <ul className="move-preview-list" data-list="labels">{planned.changes.map(c => <li key={`${c.device_id}:${c.port}`} dir="auto">{labelChangeText(c)}</li>)}</ul>
              : <p className="racks-muted" data-list="labels">No PDU outlet or KVM port changes.</p>}
            <p className="racks-dialog-subtitle">Places</p>
            {places.length
              ? <ul className="move-preview-list" data-list="places">{places.map(p => <li key={p.server} dir="auto">{placeLine(p)}</li>)}</ul>
              : <p className="racks-muted" data-list="places">No place changes.</p>}
            <p className="racks-dialog-subtitle">Switch ports</p>
            {switches.length
              ? <ul className="move-preview-list" data-list="switch">{switches.map(s => <li key={s.server} dir="auto">{switchLine(s)}</li>)}</ul>
              : <p className="racks-muted" data-list="switch">No switch port changes.</p>}
            {unchecked.length > 0 && (reading
              ? <p className="racks-muted" role="status" data-unchecked="reading">Reading the port names of {unchecked.map(d => d.device_name || d.device_id).join(", ")}…</p>
              : <p className="move-preview-warning" role="alert" dir="auto" data-unchecked="">Not checked: {uncheckedText(unchecked)}. {unchecked.length > 1 ? "These devices do not answer now, so their" : "This device does not answer now, so its"} own port names are unknown and those ports keep their names. If one of them names a server that moves, it still names that server on its old {word} afterwards: check it under Consoles or Power and fix the label there.</p>)}
            {effective === "takeover" && <p className="racks-muted">There is no Undo for a take-over: to put <bdi>{victim}</bdi> back, open it and use Move or Choose ports.</p>}
          </>}
        </div>}
        {(mode === "swap" || mode === "takeover") && !other && !fixed && <p className="racks-muted" role="status">Choose the other server to see what changes.</p>}
        {error && <p role="alert" dir="auto" className="racks-dialog-error" data-move-error="">{error}</p>}
      </div>
      <div className="racks-dialog-actions">
        <button type="button" className="racks-btn" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="racks-btn racks-btn-primary" data-action="confirm-move" disabled={!ready || crowded} onClick={confirm}>{confirmText}</button>
      </div>
    </section>
  </div>;
}

// "OPT42", "OPT42 and OPT43", "OPT42, OPT43 and OPT44".
function listText(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
}

// Where a server or record is now, as the dialog's first line says it.
function whereTextOf(server) {
  if (server?.drawn?.rack) return whereText({ rack: server.drawn.rack, slot: server.drawn.u });
  return server?.rack ? `${server.rack} (not drawn)` : "no place";
}

// The hint under the outlet choice: why feed 1 is preselected, or that it is not known.
function outletHint(free, floor, word, values, rack) {
  const chosen = free.find(o => o.outlet === floor && values[0] === outletValue(o) && /^(empty|free|spare|n\/a|-+)$/i.test(o.label));
  if (chosen) return `Preselected: ${chosen.pduName} outlet ${chosen.outlet} is labelled “${chosen.label}” and has this ${word}'s number. Choose another outlet if a different one feeds it.`;
  if (!free.length) return `${rack} has no free PDU outlet: it keeps its outlet unless you drop it.`;
  return `Not known for this ${word}: choose its outlet, or keep the current one.`;
}
