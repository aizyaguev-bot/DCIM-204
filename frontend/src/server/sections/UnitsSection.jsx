// Units on this floor (one-place spec v1 §1.4, WP-2): the rack items on the server's floor (drawn.rack, drawn.u) with
// type, serial number, model and the owner they show by the lab owner's rule (the server's), each with Open (the unit
// window); the shared-floor and cooling / rack-level notes; Scan barcode and Add unit… (Operator) fixed to this floor.
// Without a floor (not drawn, KVM-only, above the floors) the buttons are hidden and the text says why.
// Props: { record, can, act }. ServerWindow renders it inside the collapsible "Units on this floor" block.
import { useState } from "react";
import ScanUnitDialog from "../../components/racks/ScanUnitDialog.jsx";
import { useLabWindow } from "../../window/labWindowContext.js";
import AddUnitDialog from "../../units/AddUnitDialog.jsx";
import { unitOwner, unitTypeText } from "../../units/unitModel.js";
import { useRackOrder } from "../../units/rackOrder.js";
import { floorNotes, scanTarget } from "../serverIdentity.js";
import "../../units/units.css";

export default function UnitsSection({ record, can, act }) {
  const { data } = useLabWindow();
  const rackOrder = useRackOrder();   // a shared floor: the server whose owner its units show, as Racks picks it
  const [dialog, setDialog] = useState(null);   // "scan" | "add" | null
  const place = scanTarget(record);
  const notes = floorNotes(record, data);
  const units = record.units || [];

  return <div data-units-section="">
    {!record.drawn ? <p className="lab-window-muted" data-units-why="">{place.why}</p>
      : !units.length ? <p className="lab-window-muted">{place.target ? "No units on this floor." : place.why}</p>
      : <ul className="unit-list" aria-label={`Units on ${record.name}'s floor`}>
        {units.map(unit => {
          const { owner, server } = unitOwner(unit, record.drawn.rack, { ...data, rackOrder });
          return <li key={unit.id} data-unit-id={unit.id}>
            <button type="button" className="lab-window-link" onClick={() => act.open({ kind: "unit", id: String(unit.id) })}
              aria-label={`Open ${unit.name || unit.id}`}><bdi>{unit.name || unit.id}</bdi></button>
            <span className="lab-window-muted" dir="auto">
              {` · ${unitTypeText(unit.type)}`}{unit.serial_number ? ` · SN ${unit.serial_number}` : ""}{unit.model ? ` · ${unit.model}` : ""}
              {` · Owner ${owner || "none"}${server && server.key !== record.key ? ` (from ${server.name})` : ""}`}
            </span>
          </li>;
        })}
      </ul>}
    {record.drawn && !place.target && units.length > 0 && <p className="lab-window-muted mt-2">{place.why}</p>}
    {notes.map(note => <p key={note} className="lab-window-muted mt-2" dir="auto" data-units-note="">{note}</p>)}
    {can.operate && place.target && <div className="unit-actions">
      <button type="button" className="lab-window-btn" data-action="scan-unit" onClick={() => setDialog("scan")}>Scan barcode</button>
      <button type="button" className="lab-window-btn" data-action="add-unit" onClick={() => setDialog("add")}>Add unit…</button>
    </div>}
    {dialog === "scan" && place.target && <ScanUnitDialog target={place.target} onClose={() => setDialog(null)}
      onItemsChanged={() => { act.reload(["inventory"]); }}
      onToast={(text, tone, undo) => act.toast(text, { tone: tone === "error" ? "error" : "ok", undo: undo || null })}/>}
    {dialog === "add" && place.target && <AddUnitDialog rack={place.target.rack} u={place.target.u} onClose={() => setDialog(null)}
      onAdded={unit => { setDialog(null); act.open({ kind: "unit", id: String(unit.id) }); }}/>}
  </div>;
}
