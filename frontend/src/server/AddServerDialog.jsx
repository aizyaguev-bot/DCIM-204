// Add server (Operator): a new server on a rack, in one clear flow. Racks opens it from its toolbar ("Add server"), from
// a free floor in Edit mode and from a rack's detail; the Manage page opens it with no rack chosen.
//   Rack (preselected when opened from a rack) -> floor (a free one) -> the PDU outlet that feeds it, chosen from the
//   rack's free outlets (blank, default, "empty" and "spare" first; never one that names a server) -> the server's name
//   (a name that already exists is refused, with Open) -> optionally a free KVM port of the rack.
// Save pins the floor (rack_slots), then writes the outlet's label exactly as Racks' old "+ OPT" did (PATCH
// /api/devices/{id}/labels with the PDU's saved labels and If-Match), then the KVM port's label the same way, and opens
// the new server's window. A refused label save takes the pin back, so nothing is left half added.
// Props: { rack?: string, u?: number, onClose(), onAdded?({ key, name, rack, u }) }   z-[60], data-dialog="add-server"
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { saveLayout } from "../api/layout.js";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { placeWord } from "../components/racks/floors.js";
import { useLabData } from "../window/labWindowContext.js";
import { windowKey } from "./serverKey.js";
import { addFloors, addKvmPorts, addOutlets, addRacks, dcimId, defaultFloor, defaultKvm, defaultOutlet, labelsWith,
  nameProblem, outletText, withPin, withoutPin } from "./addServerModel.js";

const saveError = (e, device) => (e?.status === 409
  ? `The port names of ${device} were changed in another session. The lists now show the latest; check them and save again.`
  : e?.detail || e?.message || "The change was not saved.");

export default function AddServerDialog({ rack: askedRack = null, u: askedU = null, onClose, onAdded = null }) {
  const { data, act, can } = useLabData("servers");
  const devices = data.devices || [];
  const panelRef = useRef(null);
  const firstRef = useRef(null);
  const busyRef = useRef(false);
  const [rack, setRack] = useState(askedRack || "");
  const [floorChoice, setFloor] = useState(Number.isInteger(askedU) ? askedU : null);
  const [outletChoice, setOutlet] = useState(null);   // null: this floor's default
  const [kvmChoice, setKvm] = useState(null);         // null: this floor's default ("" = no KVM port)
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(panelRef, { initialRef: firstRef, busyRef, onEscape: onClose });

  const racks = useMemo(() => addRacks(devices, askedRack), [devices, askedRack]);
  const loading = data.locations == null;
  // The first field gets the focus once the racks are read (until then the panel has it).
  const focused = useRef(false);
  useEffect(() => {
    if (loading || focused.current) return;
    focused.current = true;
    const active = document.activeElement;
    if (!active || active === panelRef.current || !panelRef.current?.contains(active)) firstRef.current?.focus();
  }, [loading]);
  const floors = useMemo(() => addFloors(data.locations, data.hidden, rack), [data.locations, data.hidden, rack]);
  const free = floors.filter(f => !f.taken.length);
  const floor = floorChoice != null && free.some(f => f.u === floorChoice) ? floorChoice : defaultFloor(floors, askedRack === rack ? askedU : null);
  const outlets = useMemo(() => (rack ? addOutlets(devices, data.pduStatuses, rack, data.locations?.empty_ports?.pdu) : []),
    [devices, data.pduStatuses, rack, data.locations]);
  const outlet = outletChoice && outlets.some(o => o.value === outletChoice) ? outletChoice : defaultOutlet(outlets, floor);
  const ports = useMemo(() => (rack ? addKvmPorts(devices, rack, data.locations?.empty_ports?.kvm) : []), [devices, rack, data.locations]);
  const kvm = kvmChoice != null && (kvmChoice === "" || ports.some(p => p.value === kvmChoice)) ? kvmChoice : defaultKvm(ports, floor);
  const problem = loading ? null : nameProblem(name, data.locations, data.removed);
  const word = placeWord(rack || null);
  const pdus = devices.filter(d => d.kind === "pdu" && d.rack === rack);
  const blocked = !rack ? "Choose a rack."
    : !pdus.length ? `${rack} has no PDU, so a server there has no outlet. Add a PDU to it in Manage first.`
    : floor == null ? `Every ${word} of ${rack} has a server. Choose another rack, or move a server away first.`
    : !outlets.length ? `${rack} has no free PDU outlet${pdus.some(p => !Number(p.port_count) && !data.pduStatuses?.[p.id]?.reachable) ? " that Lab Manager knows of (its PDU did not report its outlets)" : ""}.`
    : null;
  const ready = !loading && !blocked && !problem && !!outlet && !busy && can.operate;

  function chooseRack(next) {
    setRack(next); setFloor(null); setOutlet(null); setKvm(null); setError("");
  }

  async function save(e) {
    e?.preventDefault();
    setTouched(true);
    if (busyRef.current || !ready) return;
    const chosen = outlets.find(o => o.value === outlet);
    const pdu = devices.find(d => d.id === chosen?.pduId);
    if (!chosen || !pdu) return;
    const serverName = name.trim();
    const key = windowKey(serverName);
    const id = dcimId(serverName);
    const where = `${rack} · ${word} ${floor}`;
    busyRef.current = true; setBusy(true); setError("");
    let pinned = false;
    try {
      // 1. The floor first: once the outlet names it, the server is drawn there and no other server moves.
      await act.during(() => saveLayout("/api/rack-slots", doc => withPin(doc, rack, id, floor)));
      pinned = true;
      // 2. The outlet's label, as Racks' "+ OPT" wrote it.
      await act.during(() => act.app.saveLabels(pdu.id, labelsWith(pdu, chosen.outlet, serverName), pdu.labels_revision));
    } catch (err) {
      if (pinned) await saveLayout("/api/rack-slots", doc => withoutPin(doc, rack, id, floor)).catch(() => {});
      busyRef.current = false; setBusy(false);
      setError(pinned ? `Nothing was added: ${saveError(err, pdu.name || pdu.id)}` : `Nothing was added: ${saveError(err, "rack layout")}`);
      return;
    }
    // 3. The KVM port (optional). The server exists now; a refusal here is reported and can be fixed in its window.
    let kvmError = "";
    const port = ports.find(p => p.value === kvm);
    const kvmDevice = port ? devices.find(d => d.id === port.kvmId) : null;
    if (port && kvmDevice) {
      try { await act.during(() => act.app.saveLabels(kvmDevice.id, labelsWith(kvmDevice, port.port, serverName), kvmDevice.labels_revision)); }
      catch (err) { kvmError = saveError(err, kvmDevice.name || kvmDevice.id); }
    }
    await act.reload(["devices", "layout"]).catch(() => {});
    busyRef.current = false;
    act.toast(kvmError ? `Added ${serverName} on ${where}, but its KVM port was not saved: ${kvmError} Choose it in the server window (More › Choose ports…).`
      : `Added ${serverName} on ${where} (${chosen.pduName} · outlet ${chosen.outlet}${port ? `, ${port.kvmName} · port ${port.port}` : ""}).`,
      { tone: kvmError ? "error" : "ok" });
    onAdded?.({ key, name: serverName, rack, u: floor });
    onClose?.();
    if (key) act.openServer(key);
  }

  function openExisting(key) {
    onClose?.();
    act.openServer(key);
  }

  const titleId = "add-server-title", noteId = "add-server-note";
  const field = id => `add-server-${id}`;
  const showProblem = problem && (touched || name.trim());
  const dialog = <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    onMouseDown={ev => { if (ev.target === ev.currentTarget && !busyRef.current) onClose?.(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={noteId} tabIndex={-1}
      className="racks-dialog" data-dialog="add-server">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">{askedRack ? <>Add server to <bdi>{askedRack}</bdi></> : "Add server"}</h2>
      <p id={noteId} className="racks-dialog-note">Choose where it goes and which PDU outlet feeds it. Every screen shows it within seconds.</p>
      {loading ? <p className="racks-muted mt-3" role="status">Loading the racks…</p> : <form onSubmit={save} noValidate>
        <div className="racks-field">
          <label htmlFor={field("rack")}>Rack</label>
          <select id={field("rack")} ref={askedRack ? null : firstRef} value={rack} disabled={busy} onChange={ev => chooseRack(ev.target.value)}>
            {!rack && <option value="">Choose a rack…</option>}
            {racks.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        {rack && <div className="racks-field">
          <label htmlFor={field("floor")}>{word === "shelf" ? "Shelf" : "Floor"}</label>
          <select id={field("floor")} value={floor ?? ""} disabled={busy || floor == null} onChange={ev => { setFloor(Number(ev.target.value)); setOutlet(null); setKvm(null); }}>
            {floor == null && <option value="">No free {word}</option>}
            {floors.map(f => <option key={f.u} value={f.u} disabled={f.taken.length > 0}>{f.label}</option>)}
          </select>
        </div>}
        {rack && pdus.length > 0 && floor != null && <div className="racks-field">
          <label htmlFor={field("outlet")}>{`PDU outlet that feeds ${word} ${floor}`}</label>
          <select id={field("outlet")} value={outlet} disabled={busy || !outlets.length} onChange={ev => setOutlet(ev.target.value)}>
            {!outlets.length && <option value="">No free outlet</option>}
            {outlets.map(o => <option key={o.value} value={o.value}>{outletText(o)}</option>)}
          </select>
          <p className="racks-field-hint">Only free outlets are listed; an outlet that names a server is never offered.</p>
        </div>}
        <div className="racks-field">
          <label htmlFor={field("name")}>Server name</label>
          <input id={field("name")} ref={askedRack ? firstRef : null} value={name} dir="auto" autoComplete="off" spellCheck={false} maxLength={80}
            placeholder="e.g. OPT52" disabled={busy} aria-invalid={showProblem ? true : undefined}
            aria-describedby={showProblem ? field("name-problem") : undefined}
            onChange={ev => { setName(ev.target.value); setError(""); }}/>
          {showProblem && <p id={field("name-problem")} role="alert" className="racks-field-error" dir="auto">{problem.text}
            {problem.key && <> <button type="button" className="racks-link" data-action="open-existing" onClick={() => openExisting(problem.key)}>Open <bdi>{problem.name}</bdi></button></>}</p>}
        </div>
        {rack && floor != null && pdus.length > 0 && <div className="racks-field">
          <label htmlFor={field("kvm")}>KVM port (optional)</label>
          <select id={field("kvm")} value={kvm} disabled={busy} onChange={ev => setKvm(ev.target.value)}>
            <option value="">No KVM port</option>
            {ports.map(p => <option key={p.value} value={p.value}>{`${p.kvmName} · port ${p.port}${p.label ? ` · ${p.label}` : ""}`}</option>)}
          </select>
          {!ports.length && <p className="racks-field-hint">No free KVM port on {rack}.</p>}
        </div>}
        {blocked && rack && <p className="racks-dialog-error" role="status" data-add-blocked="">{blocked}</p>}
        {error && <p className="racks-dialog-error" role="alert" dir="auto">{error}</p>}
        <div className="racks-dialog-actions">
          <button type="button" className="racks-btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="racks-btn racks-btn-primary" data-action="add-server-save" disabled={!ready}>{busy ? "Adding…" : "Add server"}</button>
        </div>
      </form>}
    </section>
  </div>;
  return createPortal(dialog, document.body);
}
