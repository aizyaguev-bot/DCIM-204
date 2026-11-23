// STUB (WP-0, read-only). WP-2 replaces the body (v2 §W.4): UnitForm (Operator, explicit Save, PUT /api/rack-items
// with If-Match), Move…, Scan barcode, the owner (derived and read-only on a server's floor), history, Delete….
// Props: { target: { kind: "unit", id: <rack item id> }, onClose }
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell, { WindowSection } from "../window/WindowShell.jsx";
import { itemRef } from "../twinLinks.js";
import { placeWord, validFloor } from "../components/racks/floors.js";

export function findUnit(rackItems, id) {
  for (const [rack, list] of Object.entries(rackItems && typeof rackItems === "object" ? rackItems : {})) {
    const item = (Array.isArray(list) ? list : []).find(u => u && String(u.id) === String(id));
    if (item) return { item, rack };
  }
  return null;
}

export default function UnitWindow({ target, onClose }) {
  const { data, act, can } = useLabWindow();
  const found = findUnit(data.rackItems, target.id);
  if (!found) return <WindowShell kind="unit" name={target.id} state={{ word: data.rackItems ? "Not found" : "Loading…", tone: "unknown" }}
    can={{ operate: false, admin: false }} readOnlyText="Nothing to change" onClose={onClose}>
    <p role="status" className="lab-window-muted">{data.rackItems ? `No unit with id ${target.id} in Lab Manager.` : "Loading the unit…"}</p>
  </WindowShell>;
  const { item, rack } = found;
  const u = Number(item.u);
  const place = validFloor(u, rack) ? `${rack} · ${placeWord(rack)} ${u}` : u === 0 ? `${rack} · rack level` : rack;
  return <WindowShell kind="unit" name={item.name || item.id} state={{ word: place, tone: "ok" }} can={{ operate: false, admin: false }}
    readOnlyText={can.operate ? "Unit changes stay in Racks › Edit for now" : "Viewer · read only"} onClose={onClose}
    facts={[item.type, item.serial_number ? `SN ${item.serial_number}` : null, item.model]}
    tools={<>
      <button type="button" className="lab-window-btn" onClick={() => act.goTo("racks", rack)}>Show on Racks</button>
      <button type="button" className="lab-window-btn" onClick={() => act.goTo("twin", { ref: itemRef(item.id) })}>3D</button>
    </>}>
    <WindowSection title="Details" id="details">
      <dl className="lab-window-dl">
        <dt>Name</dt><dd dir="auto">{item.name || "—"}</dd>
        <dt>Type</dt><dd>{item.type || "—"}</dd>
        <dt>Place</dt><dd dir="auto">{place}</dd>
        <dt>Serial</dt><dd dir="auto">{item.serial_number || "—"}</dd>
        <dt>Barcode</dt><dd dir="auto">{item.barcode || "—"}</dd>
        <dt>Model</dt><dd dir="auto">{item.model || "—"}</dd>
        <dt>Notes</dt><dd dir="auto">{item.notes || "—"}</dd>
      </dl>
    </WindowSection>
  </WindowShell>;
}
