// STUB (WP-0, read-only). WP-2 replaces it: units on (drawn.rack, drawn.u) with type, SN, model and the derived owner,
// Open (act.open({ kind: "unit", id })), the shared-floor and cooling notes, and Scan barcode (Operator).
// Props: { record, can, act }. Rendered inside the collapsible "Units on this floor" block.
export default function UnitsSection({ record, act }) {
  if (!record.drawn || !record.units.length) {
    return <p className="lab-window-muted">{record.drawn ? "No units on this floor." : "Not on a rack floor, so no units are listed."}</p>;
  }
  return <ul className="m-0 p-0 list-none">
    {record.units.map(unit => <li key={unit.id} dir="auto">
      <button type="button" className="lab-window-link" onClick={() => act.open({ kind: "unit", id: String(unit.id) })}>{unit.name || unit.id}</button>
      {unit.serial_number ? ` · SN ${unit.serial_number}` : ""}
    </li>)}
  </ul>;
}
