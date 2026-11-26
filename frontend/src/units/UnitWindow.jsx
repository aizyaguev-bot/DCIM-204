// The unit window (one-place spec v2 §W.4, WP-2): one rack item (a unit) and every change to it.
//   header  its place ("Rack-01 · floor 3", "Storage-Main", "Rack-01 · rack level"), the badge "Not seen N days",
//           Show on Racks and 3D (item:<id>)
//   bar     Operator: Move… (rack and floor, or Storage-Main) and Scan barcode; Delete… (Operator) is placed by the
//           shell (in the bar when it was not seen for 30 days, else last in More) and opens the one DeleteDialog
//   body    Owner: on a server's floor the server's owner, derived and read-only, with "Open <server>" (the lab owner's
//           rule, unitOwner.js); else its own owner (OwnerSelect, PUT /api/opt-owners/item:<id>, Operator)
//           Details: UnitForm (Operator; explicit Save, PUT /api/rack-items with If-Match), UnitDetails for Viewers
//           History: tracking_history
// Props: { target: { kind: "unit", id: <rack item id> }, onClose }
import { useEffect, useRef, useState } from "react";
import { accountRequest } from "../accounts.jsx";
import { OwnerSelect } from "../engineers.jsx";
import { MAIN_STORAGE } from "../api/inventory.js";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import ScanUnitDialog from "../components/racks/ScanUnitDialog.jsx";
import { floorsFor, rackHasFloors, validFloor } from "../components/racks/floors.js";
import { TWIN_ENABLED, itemRef } from "../twinLinks.js";
import { itemOwnerKey, ownerFromText } from "../unitOwner.js";
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell, { WindowSection } from "../window/WindowShell.jsx";
import { formatTime } from "../window/format.js";
import { useDeletedEntry } from "./deletedList.js";
import { useRackOrder } from "./rackOrder.js";
import { DeletedNotice, UnitDetails, UnitForm, putRackItems, STALE_TEXT } from "./UnitForm.jsx";
import { NOT_SEEN_DAYS, daysSince, findUnit, historyRows, moveUnit, placeChoices, rackChoices, unitOwner, unitPlace, unitTypeText, unitU } from "./unitModel.js";
import "./units.css";

export { findUnit };

// Move…: another rack (its floor or shelf, or its rack level) or Storage-Main. PUT /api/rack-items with If-Match.
function MoveUnitDialog({ item, rack, data, act, onClose }) {
  const racks = rackChoices(data);
  const [toRack, setToRack] = useState(rack);
  const [place, setPlace] = useState(String(unitU(item)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const rackRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: rackRef, busyRef, onEscape: onClose });
  const places = placeChoices(toRack);
  // The place the select shows: a saved U that is no floor or shelf of the rack (U 7) shows, and moves to, its rack level.
  const shownPlace = places.some(p => p.value === place) ? place : "0";
  const u = Number(shownPlace);
  const same = toRack === rack && u === unitU(item);
  const target = unitPlace({ u }, toRack);

  async function move(e) {
    e?.preventDefault();
    if (busyRef.current || same) return;
    busyRef.current = true; setBusy(true); setError("");
    const from = { rack, u: unitU(item) };
    try {
      await act.during(() => putRackItems(moveUnit(data.rackItems, item.id, toRack, u), data.etags?.rackItems));
      await act.reload(["inventory"]);
      act.toast(`Moved ${item.name} to ${target}.`, { undo: () => undoMove(from, { rack: toRack, u }) });
      onClose();
    } catch (err) {
      busyRef.current = false; setBusy(false);
      setError(err.stale ? STALE_TEXT.replace(" with your edits kept", "") : err.message || String(err));
      if (err.stale) act.reload(["inventory"]);
    }
  }

  // Undo: back to where it was, only while it is still where this move put it (a fresh read, If-Match).
  async function undoMove(from, to) {
    try {
      const response = await fetch("/api/rack-items", { cache: "no-store" });
      const doc = await response.json();
      const now = findUnit(doc, item.id);
      if (!now || now.rack !== to.rack || unitU(now.item) !== to.u) {
        act.toast(`Not undone: ${item.name} was changed or moved in another session.`, { tone: "error" });
        return;
      }
      await act.during(() => putRackItems(moveUnit(doc, item.id, from.rack, from.u), response.headers.get("ETag")));
      await act.reload(["inventory"]);
      act.toast(`${item.name} is back on ${unitPlace({ u: from.u }, from.rack)}.`);
    } catch (err) {
      act.toast(`Not undone: ${err.message || err}`, { tone: "error" });
    }
  }

  const titleId = "unit-move-title";
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="racks-dialog" data-dialog="unit-move">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">Move <bdi>{item.name}</bdi></h2>
      <p className="racks-dialog-note">Now on <bdi>{unitPlace(item, rack)}</bdi>.</p>
      <form onSubmit={move}>
        <div className="racks-field">
          <label htmlFor="unit-move-rack">Rack</label>
          <select id="unit-move-rack" ref={rackRef} value={toRack} disabled={busy}
            onChange={e => { const next = e.target.value; setToRack(next); setPlace(next === rack ? String(unitU(item)) : "0"); }}>
            {racks.map(r => <option key={r} value={r}>{r === MAIN_STORAGE ? `${r} (storage)` : r}</option>)}
          </select>
        </div>
        <div className="racks-field">
          <label htmlFor="unit-move-place">{rackHasFloors(toRack) ? "Floor" : "Shelf"}</label>
          <select id="unit-move-place" value={shownPlace} disabled={busy} onChange={e => setPlace(e.target.value)}>
            {places.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        {error && <p role="alert" dir="auto" className="racks-dialog-error">{error}</p>}
        <div className="racks-dialog-actions">
          <button type="button" className="racks-btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="racks-btn racks-btn-primary" data-action="move-unit" disabled={busy || same}>{busy ? "Moving…" : `Move to ${target}`}</button>
        </div>
      </form>
    </section>
  </div>;
}

function OwnerBlock({ item, rack, owner, server, can, act, data, dirtyRef }) {
  const storage = !rackHasFloors(rack);
  if (server) return <div data-unit-owner="derived">
    <p dir="auto"><strong data-owner-value="">{owner || "No owner"}</strong></p>
    <p className="lab-window-muted mt-1" id="unit-owner-from" dir="auto">{ownerFromText(server, storage)}{can.operate ? " Change it on the server." : ""}</p>
    <button type="button" className="lab-window-link mt-1" data-action="open-owner-server" onClick={() => {
      if (dirtyRef?.current && !window.confirm(`Discard your unsaved changes to ${item.name || item.id} and open ${server.name}?`)) return;
      act.openServer(server.key);
    }}>Open <bdi>{server.name}</bdi></button>
  </div>;
  if (!can.operate) return <p dir="auto" data-unit-owner="own"><span data-owner-value="">{owner || "No owner"}</span></p>;
  return <div data-unit-owner="own">
    <OwnerSelect owner={owner} label={`Owner for ${item.name}`} disabled={data.owners == null} onChange={async engineerId => {
      await act.during(() => accountRequest(`/opt-owners/${encodeURIComponent(itemOwnerKey(item.id))}`, "PUT", { engineer_id: engineerId }));
      await act.reload(["owners"]);
    }}/>
    <p className="lab-window-muted mt-1">{storage ? "No server is on this shelf, so the unit keeps its own owner." : "No server is on this floor, so the unit keeps its own owner."}</p>
  </div>;
}

// The search of a window whose unit is gone: every unit now, with its place.
const unitChoices = rackItems => Object.entries(rackItems && typeof rackItems === "object" ? rackItems : {})
  .flatMap(([rack, list]) => (Array.isArray(list) ? list : []).filter(item => item && item.id != null)
    .map(item => ({ id: item.id, name: item.name, place: unitPlace(item, rack), text: [item.serial_number, item.barcode, item.model].filter(Boolean).join(" ") })));

export default function UnitWindow({ target, onClose }) {
  const { data, act, can, open } = useLabWindow();
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);   // UnitForm has unsaved edits
  const [dialog, setDialog] = useState(null);   // "move" | "scan" | null
  const seen = useRef(false);
  const rackOrder = useRackOrder();
  const found = findUnit(data.rackItems, target.id);
  if (found) seen.current = true;
  // Gone (a fresh equipment list without it): its Deleted-list entry, so the window names it and offers Restore.
  const deleted = useDeletedEntry("unit", target.id, !found && data.rackItems ? "gone" : null);
  // sec=delete (the twin's Delete…, a shared link) opens the delete preview once; it never applies anything.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !found || target.sec !== "delete") return;
    asked.current = true;
    if (can.operate) act.openDelete([{ kind: "unit", id: String(found.item.id) }]);
  }, [!!found]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!found) {
    const [entry] = deleted;
    return <WindowShell kind="unit" name={entry?.entry?.name || target.id} onClose={onClose}
      state={{ word: !data.rackItems ? "Loading…" : entry ? "Deleted" : "Not found", tone: "unknown" }}
      can={{ operate: false, admin: false }} readOnlyText="Nothing to change">
      {data.rackItems ? <DeletedNotice deleted={deleted} canRestore={can.operate} act={act} noun="unit" choices={unitChoices(data.rackItems)}
        onOpen={id => open({ kind: "unit", id }, { replace: true })}
        fallback={seen.current ? "This unit is no longer in Lab Manager." : `No unit with id ${target.id} in Lab Manager.`}/>
        : <p role="status" className="lab-window-muted">Loading the unit…</p>}
    </WindowShell>;
  }
  const { item, rack } = found;
  const place = unitPlace(item, rack);
  const { owner, server } = unitOwner(item, rack, { ...data, rackOrder });
  const days = daysSince(item.last_seen_at);
  const notSeen = days != null && days >= NOT_SEEN_DAYS;
  const history = historyRows(item);
  const storage = !rackHasFloors(rack);
  const u = unitU(item);
  // Scan barcode adds units to this unit's floor or shelf; from the rack level or a U above the floors, to floor 1 (a
  // storage rack: the whole storage), chosen in the dialog.
  const scanU = validFloor(u, rack) ? u : storage ? 0 : 1;
  return <WindowShell kind="unit" name={item.name || item.id} state={{ word: place, tone: notSeen ? "warn" : "ok" }}
    badges={notSeen ? [{ text: `Not seen ${days} days`, tone: "warn" }] : []} can={can} busyRef={busyRef} onClose={onClose}
    facts={[unitTypeText(item.type), item.serial_number ? `SN ${item.serial_number}` : null, item.model || null, `Owner: ${owner || "none"}${server ? ` (from ${server.name})` : ""}`]}
    tools={<>
      <button type="button" className="lab-window-btn" onClick={() => act.showOnRacks(rack)}>Show on Racks</button>
      {TWIN_ENABLED && <button type="button" className="lab-window-btn" title={`Show ${item.name} in 3D`} onClick={() => act.showIn3d(itemRef(item.id))}>3D</button>}
    </>}
    bar={<>
      <button type="button" className="lab-window-btn" data-action="move-unit" onClick={() => setDialog("move")} disabled={!data.etags?.rackItems}>Move…</button>
      <button type="button" className="lab-window-btn" data-action="scan-unit" onClick={() => setDialog("scan")}>Scan barcode</button>
    </>}
    deleteTarget={{ kind: "unit", id: String(item.id) }} deleteRole="operator" maybeGone={notSeen}>
    <WindowSection title="Owner" id="owner">
      <OwnerBlock item={item} rack={rack} owner={owner} server={server} can={can} act={act} data={data} dirtyRef={dirtyRef}/>
    </WindowSection>
    <WindowSection title="Details" id="details">
      {can.operate ? <UnitForm item={item} rack={rack} data={data} act={act} busyRef={busyRef} dirtyRef={dirtyRef}/>
        : <UnitDetails item={item} rack={rack} owner={owner} server={server}/>}
    </WindowSection>
    <WindowSection title="History" id="history" collapsible defaultOpen={false}>
      {history.length ? <ul className="unit-history">{history.map((h, i) => <li key={i} dir="auto">
        {h.at ? <span className="lab-window-muted">{formatTime(h.at).replace(/^on /, "")} · </span> : null}{h.text}
      </li>)}</ul> : <p className="lab-window-muted">No history recorded for this unit.</p>}
    </WindowSection>
    {dialog === "move" && can.operate && <MoveUnitDialog item={item} rack={rack} data={data} act={act} onClose={() => setDialog(null)}/>}
    {dialog === "scan" && can.operate && <ScanUnitDialog target={{ rack, u: scanU, position: "", label: "" }}
      floorChoices={[0, ...Array.from({ length: floorsFor(rack) }, (_, i) => i + 1)]}
      onClose={() => setDialog(null)} onItemsChanged={() => { act.reload(["inventory"]); }}
      onToast={(text, tone, undo) => act.toast(text, { tone: tone === "error" ? "error" : "ok", undo: undo || null })}/>}
  </WindowShell>;
}
