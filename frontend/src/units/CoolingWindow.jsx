// The cooling unit's window (one-place spec v2 §W.4, WP-2): the shell with today's CoolingUnitDialog form as its body
// (its `embedded` prop). Operators edit (name, rack, floor or shelf, Take off floor; PUT /api/chillers with If-Match,
// read fresh and applied to that copy, never dropping a unit), with Undo in the toast; Viewers read. Delete… (Admin) is
// placed by the shell and opens the one DeleteDialog.
// Props: { target: { kind: "cooling", id: <unit id> }, onClose }
import { useEffect, useRef } from "react";
import { saveLayout } from "../api/layout.js";
import CoolingUnitDialog from "../components/racks/CoolingUnitDialog.jsx";
import { assertKeepsUnits, coolingChange, describePlace, normalizeChillers, undoCoolingChange, updateChiller, validShelf } from "../components/racks/chillers.js";
import { floorsFor } from "../components/racks/floors.js";
import { floorOptions } from "../components/racks/rackView.js";
import { drawnOf } from "../server/serverRecord.js";
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell, { WindowSection } from "../window/WindowShell.jsx";
import { useDeletedEntry } from "./deletedList.js";
import { DeletedNotice } from "./UnitForm.jsx";
import { rackChoices, unitU } from "./unitModel.js";
import "./units.css";

const asArray = value => (Array.isArray(value) ? value : []);

// The floor choices of a rack, named as on the rack card (rackView.js floorOptions): the servers drawn on each floor
// (/locations), its units (rack items) and its cooling units.
function floorChoices(data, rack) {
  const rows = [];
  for (let u = 1; u <= floorsFor(rack); u++) {
    const servers = asArray(data.locations?.servers).filter(row => row && !row.removed && drawnOf(row)?.rack === rack && drawnOf(row)?.u === u);
    const units = asArray(data.rackItems?.[rack]).filter(item => item && unitU(item) === u);
    rows.push({ u, items: [...servers.map(s => ({ data: { name: s.name } })), ...units.map(item => ({ data: { name: item.name } }))] });
  }
  const placed = {};
  for (const unit of asArray(data.chillers?.units)) if (unit && unit.rack === rack && validShelf(unit.u)) (placed[unit.u] ||= []).push(unit);
  return floorOptions(rows, placed, rack);
}

export default function CoolingWindow({ target, onClose }) {
  const { data, act, can, open } = useLabWindow();
  const busyRef = useRef(false);
  const seen = useRef(false);
  const unit = asArray(data.chillers?.units).find(u => u && String(u.id) === String(target.id)) || null;
  if (unit) seen.current = true;
  // Gone (a fresh list without it): its Deleted-list entry, so the window names it and offers Restore (Admin).
  const deleted = useDeletedEntry("cooling", target.id, !unit && data.chillers ? "gone" : null);
  // sec=delete (a shared link, the twin's Delete…) opens the delete preview once; it never applies anything.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !unit || target.sec !== "delete") return;
    asked.current = true;
    if (can.admin) act.openDelete([{ kind: "cooling", id: String(unit.id) }]);
  }, [!!unit]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!unit) {
    const [entry] = deleted;
    const choices = asArray(data.chillers?.units).filter(u => u && u.id != null).map(u => ({ id: u.id, name: u.name, place: describePlace(u) }));
    return <WindowShell kind="cooling" name={entry?.entry?.name || target.id} onClose={onClose}
      state={{ word: !data.chillers ? "Loading…" : entry ? "Deleted" : "Not found", tone: "unknown" }}
      can={{ operate: false, admin: false }} readOnlyText="Nothing to change">
      {data.chillers ? <DeletedNotice deleted={deleted} canRestore={can.admin} act={act} noun="cooling unit" choices={choices}
        onOpen={id => open({ kind: "cooling", id }, { replace: true })}
        fallback={seen.current ? "This cooling unit is no longer in Lab Manager." : `No cooling unit with id ${target.id} in Lab Manager.`}/>
        : <p role="status" className="lab-window-muted">Loading the cooling unit…</p>}
    </WindowShell>;
  }

  // One change to this unit on the latest saved document (a fresh read; If-Match; a 409 reads it again once).
  async function save(after) {
    let change = null;
    try {
      busyRef.current = true;
      await act.during(() => saveLayout("/api/chillers", doc => {
        const base = normalizeChillers(doc);
        const current = base.units.find(x => x && typeof x === "object" && x.id === unit.id);
        if (!current) throw new Error("This cooling unit is no longer in the list.");
        change = coolingChange(current, after);
        const next = updateChiller(base, unit.id, after);
        assertKeepsUnits(doc, next);
        return next;
      }));
    } catch (e) {
      throw new Error(`The cooling unit was not saved: ${e.message}`);
    } finally { busyRef.current = false; }
    await act.reload(["inventory"]);
    act.toast(`${change.name}: ${describePlace(change.after)}.`, { undo: () => undo(change) });
  }

  // Undo: refused when the unit was changed again since, by anyone (undoCoolingChange).
  async function undo(change) {
    try {
      await act.during(() => saveLayout("/api/chillers", doc => {
        const next = undoCoolingChange(doc, change);
        assertKeepsUnits(doc, next);
        return next;
      }));
      await act.reload(["inventory"]);
      act.toast(`${change.name} is back at ${describePlace(change.before)}.`);
    } catch (e) {
      act.toast(e.message || String(e), { tone: "error" });
    }
  }

  const place = describePlace(unit);
  return <WindowShell kind="cooling" name={unit.name || unit.id} state={{ word: place, tone: unit.rack ? "ok" : "unknown" }} can={can} busyRef={busyRef}
    onClose={onClose} facts={[place, `Id ${unit.id}`]} badges={unit.rack ? [] : [{ text: "No rack" }]}
    tools={unit.rack ? <button type="button" className="lab-window-btn" onClick={() => act.showOnRacks(unit.rack)}>Show on Racks</button> : null}
    deleteTarget={{ kind: "cooling", id: String(unit.id) }} deleteRole="admin">
    <WindowSection title={can.operate ? "Place" : "Details"} id="details">
      <CoolingUnitDialog embedded key={`${unit.id}|${unit.name}|${unit.rack}|${unit.u}`} mode={can.operate ? "edit" : "view"} unit={unit}
        rackNames={rackChoices(data)} floorOptionsFor={rack => floorChoices(data, rack)} canOperate={can.operate}
        onSave={save} onTakeOffShelf={() => save({ name: unit.name, rack: unit.rack, u: null })} onClose={onClose}/>
      <p className="lab-window-muted mt-2">A cooling unit stays where it is when a server moves.</p>
    </WindowSection>
  </WindowShell>;
}
