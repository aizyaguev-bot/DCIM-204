import { useEffect, useId, useMemo, useRef, useState } from "react";
import useDialogFocus from "./useDialogFocus.js";
import { floorsFor, placeWord } from "./floors.js";
import { serverIdentity } from "../../api/locations.js";
import {
  firstFreeFloor, floorOutlet, freeOutlets, labelChangeText, moveServerBody, placeText, portsAfterMove,
  serversOnFloor, swapMoves, takesOverText, uncheckedText, unitNames,
} from "./serverMove.js";

// Moving or swapping a server on the Racks page (Edit mode): a drag onto another server (any rack) or onto a rack's
// card, the U / shelf field and "Move…" in the server's edit panel. The PDU outlet and KVM port belong to the floor:
// a server that lands on a floor takes over that floor's outlet and port, and the dialog previews exactly what changes
// (the server's dry run of POST /api/devices/move-server: every port label, every server's place) before anything is
// saved. A floor that holds one server swaps the two (each takes the other's floor, outlet, port and units). On an
// empty floor the server takes the outlet the PDU labels for that floor ("empty" or "spare" with the floor's number),
// preselected and explained, never presented as certain; otherwise the dialog asks which outlet feeds it (default:
// keep its own). The units on the floor it leaves go with it
// ("Moves with it: …") unless "Move the units on this floor with the server" is cleared. If anything changed elsewhere
// meanwhile, nothing is saved: this dialog stays open with the choices made here and previews the latest again.
// When the preview says a PDU/KVM's own port names are unknown (unchecked: it does not answer, or nothing read it since
// the server started), the dialog reads its status once (readStatus) and previews again; if they are still unknown it
// says plainly that those ports were not checked, instead of claiming that each server takes over its new KVM port.
//
// request: { id, rack, floor, swapWith, fixed }: the server, the rack and floor it goes to, the server it was dropped
// onto, fixed: the target is decided (dropped onto a server) and cannot be changed here.
// placements / nameOf / planUnits(moves) / rackNames / pdus: from the page; dataKey changes when the page's floors or
// port labels change (the preview is read again). loadLocations() reads GET /api/devices/locations (each server's
// ports, the empty ports); preview(body) the dry run; onMove({ body, planRevision, unitMoves }) saves;
// readStatus({ device_id, kind }) reads that PDU's or KVM's status (GET /api/pdus|kvms/{id}/status).
export default function ServerMoveDialog({ request, server, placements, nameOf, planUnits, rackNames, pdus, dataKey = "",
  loadLocations, preview, onMove, onClose, onDone, readStatus = null }) {
  const panelRef = useRef(null);
  const busyRef = useRef(false);
  const openRef = useRef(true);
  useEffect(() => { openRef.current = true; return () => { openRef.current = false; }; }, []);
  const id = useId();
  const from = placements[request.id] || null;
  const startFloor = rack => {
    if (request.swapWith && placements[request.swapWith]?.rack === rack) return placements[request.swapWith].u;
    if (Number.isInteger(request.floor) && rack === request.rack) return request.floor;
    return firstFreeFloor(placements, rack, floorsFor(rack), [request.id]) ?? 1;
  };
  const [rack, setRack] = useState(request.rack);
  const [floor, setFloor] = useState(() => startFloor(request.rack));
  const [unitsFollow, setUnitsFollow] = useState(true);
  const [outletPick, setOutletPick] = useState(null);   // null: the floor's own outlet when known, else keep its own
  const [locations, setLocations] = useState({ data: null, error: "" });
  const [plan, setPlan] = useState({ key: null, result: null, error: "" });
  const [again, setAgain] = useState(0);                // a refused save (or a status read) reads everything again
  const [statusRead, setStatusRead] = useState("");     // "": not yet; "reading"; "done": unchecked devices were read
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(panelRef, { busyRef, onEscape: onClose });

  useEffect(() => {
    let alive = true;
    loadLocations().then(data => { if (alive) setLocations({ data, error: "" }); })
      .catch(e => { if (alive) setLocations(l => ({ data: l.data, error: e?.detail || e?.message || "The server's ports could not be read." })); });
    return () => { alive = false; };
  }, [again, dataKey]);

  const name = server?.name || nameOf(request.id);
  const count = floorsFor(rack);
  const word = placeWord(rack);
  const occupants = serversOnFloor(placements, rack, floor).filter(other => other !== request.id);
  const swapWith = request.fixed ? request.swapWith : occupants.length === 1 ? occupants[0] : null;
  const crowded = !swapWith && occupants.length > 1;
  const nothing = !swapWith && from?.rack === rack && from?.u === floor;
  const moves = useMemo(() => (swapWith ? swapMoves(request.id, swapWith, placements) : null) || [{ id: request.id, toRack: rack, toU: floor }],
    [swapWith, request.id, placements, rack, floor]);
  const unitMoves = planUnits(moves);

  // An empty floor: which outlet feeds it (the one the PDU labels for it when known; otherwise the person says, and by
  // default the server keeps its own). Its KVM port stays.
  const row = locations.data?.servers?.find(r => r.key === serverIdentity(name)) || null;
  const free = useMemo(() => (swapWith ? [] : freeOutlets(pdus, rack, locations.data?.empty_ports?.pdu)), [swapWith, pdus, rack, locations.data]);
  const known = swapWith ? null : floorOutlet(free, floor);
  const outletValue = outletPick ?? (known ? `${known.pduId}:${known.outlet}` : "keep");
  const chosen = outletValue === "keep" ? null : free.find(o => `${o.pduId}:${o.outlet}` === outletValue) || null;
  const ready = !!swapWith || !!locations.data;
  const body = !server || nothing || crowded || !ready ? null : swapWith
    ? moveServerBody({ name, swapWith: nameOf(swapWith) })
    : moveServerBody({ name, rack, floor, ports: portsAfterMove(row, chosen, server.pduId ? [{ device_id: server.pduId, port: server.outlet, kind: "pdu" }] : []) });
  const bodyKey = body ? JSON.stringify(body) : "";
  // A preview counts only for this body and this state of the page (dataKey) and attempt: anything newer reads it again.
  const planKey = bodyKey ? `${bodyKey}|${dataKey}|${again}` : "";

  // The preview: the server's dry run of exactly this move, read again whenever the choice or the page's data changes.
  useEffect(() => {
    if (!planKey) return;
    let alive = true;
    const timer = setTimeout(() => {
      preview(JSON.parse(bodyKey)).then(result => { if (alive) setPlan({ key: planKey, result, error: "" }); })
        .catch(e => { if (alive) setPlan({ key: planKey, result: null, error: e?.detail || e?.message || "The move could not be previewed." }); });
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [planKey]);
  const current = planKey && plan.key === planKey ? plan : { result: null, error: "" };
  const planned = current.result;
  const unchecked = Array.isArray(planned?.unchecked) ? planned.unchecked : [];

  // A PDU/KVM whose own port names the server does not know now: read its status once (that fills the server's status
  // cache when the device answers) and preview again. Whatever the reads answer, the preview that follows counts.
  // (The reads finish even when this effect runs again for its own "reading" state; only a closed dialog drops them.)
  useEffect(() => {
    if (!unchecked.length || statusRead || !readStatus) return;
    setStatusRead("reading");
    Promise.allSettled(unchecked.map(d => readStatus(d))).then(() => {
      if (!openRef.current) return;
      setStatusRead("done");
      setAgain(n => n + 1);
    });
  }, [unchecked.length, statusRead]);
  const reading = statusRead === "reading" || (unchecked.length > 0 && !statusRead && !!readStatus);
  const takesOver = planned ? takesOverText(planned.changes) : null;   // null: not previewed yet, so nothing is claimed

  function chooseRack(next) {
    setRack(next); setFloor(startFloor(next)); setOutletPick(null); setError("");
  }

  async function confirm() {
    if (busyRef.current || !body || !planned?.plan_revision || reading) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const sent = unitsFollow ? unitMoves : [];
      await onMove({ body, planRevision: planned.plan_revision, unitMoves: sent });
      busyRef.current = false;
      const units = sent.flatMap(m => unitNames(m.units));
      onDone?.(swapWith
        ? `${name} and ${nameOf(swapWith)} swapped places${units.length ? `, with ${units.join(", ")}` : ""}.`
        : `${name} moved to ${placeText(rack, floor)}${units.length ? ` with ${units.join(", ")}` : ""}.`);
    } catch (e) {
      busyRef.current = false; setBusy(false);
      setError(e?.detail || e?.message || "The move was not saved.");
      setAgain(n => n + 1);
    }
  }

  const titleId = `${id}-title`, bodyId = `${id}-body`;
  const title = swapWith ? <>Swap <bdi>{name}</bdi> and <bdi>{nameOf(swapWith)}</bdi></> : <>Move <bdi>{name}</bdi></>;
  const placeOf = p => placeText(p?.rack || null, Number.isInteger(p?.slot) ? p.slot : null);
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}
      className="racks-dialog racks-dialog-wide" data-dialog="server-move">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">{title}</h2>
      <div id={bodyId}>
        <p className="racks-dialog-note" data-move-plan="">{swapWith && moves.length === 2
          ? <><bdi>{name}</bdi> goes to {placeText(moves[0].toRack, moves[0].toU)}; <bdi>{nameOf(swapWith)}</bdi> goes to {placeText(moves[1].toRack, moves[1].toU)}.{takesOver == null ? null : takesOver
            ? <> Each takes over the {takesOver} of its new {word}.</>
            : <> Neither has a PDU outlet or KVM port label to take over.</>}</>
          : <>From {from ? placeText(from.rack, from.u) : "no place"} to {placeText(rack, floor)}.</>}</p>
        {!server && <p role="alert" className="racks-dialog-error">This server is no longer on the page (removed or renamed in another session).</p>}
        {!request.fixed && <>
          <div className="racks-field">
            <label htmlFor={`${id}-rack`}>Rack</label>
            <select id={`${id}-rack`} value={rack} disabled={busy} onChange={e => chooseRack(e.target.value)}>
              {rackNames.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="racks-field">
            <label htmlFor={`${id}-floor`}>{word === "shelf" ? "Shelf" : "Floor"}</label>
            <select id={`${id}-floor`} value={String(floor)} disabled={busy} onChange={e => { setFloor(Number(e.target.value)); setOutletPick(null); setError(""); }}>
              {Array.from({ length: count }, (_, i) => i + 1).map(u => {
                const here = serversOnFloor(placements, rack, u).filter(other => other !== request.id).map(nameOf);
                return <option key={u} value={u}>{`${word === "shelf" ? "Shelf" : "Floor"} ${u}${u === 1 && word === "floor" ? " (top)" : ""} · ${here.length ? here.join(", ") : "free"}`}</option>;
              })}
            </select>
          </div>
          {crowded && <p className="racks-dialog-error" role="note">{occupants.map(nameOf).join(" and ")} share this {word}. Drop <bdi>{name}</bdi> onto one of them to swap, or choose another {word}.</p>}
        </>}
        {!swapWith && !nothing && !crowded && server && <div className="racks-field" data-floor-outlet="">
          <label htmlFor={`${id}-outlet`}>{`Which PDU outlet feeds ${word} ${floor}?`}</label>
          <select id={`${id}-outlet`} value={outletValue} disabled={busy || !locations.data} onChange={e => { setOutletPick(e.target.value); setError(""); }}>
            <option value="keep">{server.pduName ? `Keep ${server.pduName} · outlet ${server.outlet}` : "Keep its outlet"}</option>
            {free.map(o => <option key={`${o.pduId}:${o.outlet}`} value={`${o.pduId}:${o.outlet}`}>{`${o.pduName} · outlet ${o.outlet}${o.label ? ` (${o.label})` : ""}`}</option>)}
          </select>
          <p className="racks-field-hint" data-outlet-hint="">{known && outletValue === `${known.pduId}:${known.outlet}`
            ? <>Preselected: {known.pduName} outlet {known.outlet} is labelled “{known.label}” and has this {word}'s number. Choose another outlet if a different one feeds it. Its KVM port stays as it is.</>
            : <>{free.length ? "Not known for this " + word + ": choose its outlet, or keep the current one." : `${rack} has no free PDU outlet: it keeps its current outlet.`} Its KVM port stays as it is.</>}</p>
          {locations.error && <p className="racks-field-error" role="alert">{locations.error}</p>}
        </div>}
        {unitMoves.length > 0 && <div className="units-follow" role="group" aria-label="Units that move with the server" data-units-follow="">
          {unitMoves.map(m => <p key={m.id} data-moves-with={m.id}>
            <span className="units-follow-label">{m.id === request.id ? "Moves with it" : <>Moves with <bdi>{nameOf(m.id)}</bdi></>}:</span> <bdi>{unitNames(m.units).join(", ")}</bdi>
          </p>)}
          <label className="units-follow-check">
            <input type="checkbox" checked={unitsFollow} disabled={busy} onChange={e => setUnitsFollow(e.target.checked)}/>
            <span>Move the units on this floor with the server</span>
          </label>
          {!unitsFollow && <p className="racks-muted">The units stay where they are now.</p>}
        </div>}
        {body && <div className="move-preview" data-move-preview="" aria-live="polite">
          {!planned && !current.error && <p className="racks-muted" role="status">Checking what changes…</p>}
          {current.error && <p className="racks-dialog-error" role="alert">{current.error}</p>}
          {planned && <>
            <p className="racks-dialog-subtitle">Port labels</p>
            {planned.changes?.length
              ? <ul className="move-preview-list" data-list="labels">{planned.changes.map(c => <li key={`${c.device_id}:${c.port}`} dir="auto">{labelChangeText(c)}</li>)}</ul>
              : <p className="racks-muted">No PDU outlet or KVM port changes.</p>}
            {planned.positions?.length > 0 && <>
              <p className="racks-dialog-subtitle">Places</p>
              <ul className="move-preview-list" data-list="places">{planned.positions.map(p => <li key={p.server} dir="auto"><bdi>{p.server}</bdi>: {placeOf(p.before)} → {placeOf(p.after)}</li>)}</ul>
            </>}
            {unchecked.length > 0 && (reading
              ? <p className="racks-muted" role="status" data-unchecked="reading">Reading the port names of {unchecked.map(d => d.device_name || d.device_id).join(", ")}…</p>
              : <p className="move-preview-warning" role="alert" dir="auto" data-unchecked="">Not checked: {uncheckedText(unchecked)}. {unchecked.length > 1 ? "These devices do not answer now, so their" : "This device does not answer now, so its"} own port names are unknown and those ports keep their names. If one of them names a server that moves, it still names that server on its old {word} afterwards: check it under Consoles or Power and fix it in Locations.</p>)}
          </>}
        </div>}
        {!body && server && !nothing && !crowded && !ready && !locations.error && <p className="racks-muted" role="status">Reading the server's ports…</p>}
        {nothing && <p className="racks-muted" role="status">It is already there.</p>}
        {error && <p role="alert" dir="auto" className="racks-dialog-error">{error}</p>}
      </div>
      <div className="racks-dialog-actions">
        <button type="button" className="racks-btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="racks-btn racks-btn-primary" data-action="confirm-move" disabled={busy || !body || !planned?.plan_revision || reading} onClick={confirm}>
          {busy ? (swapWith ? "Swapping…" : "Moving…") : swapWith ? "Swap" : "Move"}
        </button>
      </div>
    </section>
  </div>;
}
