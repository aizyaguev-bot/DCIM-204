// STUB (WP-0). WP-2 builds it (v2 §M.4): Manage › + Add › Unit… (Operator), UnitForm with rack and floor or
// Storage-Main, PUT /api/rack-items with If-Match; the new unit's window opens afterwards.
// Props: { rack?: string, u?: number, onClose(), onAdded(unit) }
import StubDialog from "../window/StubDialog.jsx";

export default function AddUnitDialog({ onClose }) {
  return <StubDialog id="add-unit" title="Add unit" text="Adding a unit here is not available yet. Use Racks › Edit or Scan & Track." onClose={onClose}/>;
}
