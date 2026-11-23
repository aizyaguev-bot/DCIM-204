// STUB (WP-0, read-only). WP-2 replaces the body (v2 §W.4): today's CoolingUnitDialog form (its new `embedded`
// prop) inside the shell, and Delete… (Admin).
// Props: { target: { kind: "cooling", id: <unit id> }, onClose }
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell, { WindowSection } from "../window/WindowShell.jsx";

export default function CoolingWindow({ target, onClose }) {
  const { data, can } = useLabWindow();
  const units = Array.isArray(data.chillers?.units) ? data.chillers.units : [];
  const unit = units.find(u => u && String(u.id) === String(target.id));
  if (!unit) return <WindowShell kind="cooling" name={target.id} state={{ word: data.chillers ? "Not found" : "Loading…", tone: "unknown" }}
    can={{ operate: false, admin: false }} readOnlyText="Nothing to change" onClose={onClose}>
    <p role="status" className="lab-window-muted">{data.chillers ? `No cooling unit with id ${target.id} in Lab Manager.` : "Loading the cooling unit…"}</p>
  </WindowShell>;
  return <WindowShell kind="cooling" name={unit.name || unit.id} state={{ word: unit.rack ? unit.rack : "No rack", tone: "ok" }}
    can={{ operate: false, admin: false }} readOnlyText={can.operate ? "Cooling changes stay in Racks for now" : "Viewer · read only"} onClose={onClose}
    facts={[unit.rack, Number.isInteger(unit.u) ? `floor ${unit.u}` : null]}>
    <WindowSection title="Details" id="details">
      <dl className="lab-window-dl">
        <dt>Name</dt><dd dir="auto">{unit.name || "—"}</dd>
        <dt>Rack</dt><dd dir="auto">{unit.rack || "—"}</dd>
        <dt>Floor</dt><dd>{unit.u ?? "—"}</dd>
      </dl>
    </WindowSection>
  </WindowShell>;
}
