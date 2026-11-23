// STUB (WP-0, read-only). WP-2 replaces it: Owner (OwnerSelect, Operator, written under every ownerWriteKeys(record)
// key, guarded Undo, "Units on this floor show this owner") and Switch / port (draft + Save, If-Match, withSwitch).
// Props: { record, can, act }.
import { WindowSection } from "../../window/WindowShell.jsx";

export default function OwnerNetworkBlock({ record }) {
  const owner = record.owner;
  const sw = record.switch.value;
  return <WindowSection title="Owner & network" id="owner">
    <dl className="lab-window-dl">
      <dt>Owner</dt><dd dir="auto">{owner.value || "No owner"}</dd>
      <dt>Switch</dt><dd dir="auto">{sw ? `${sw.switch}${sw.port ? ` · port ${sw.port}` : ""}` : "—"}</dd>
      <dt>Project</dt><dd dir="auto">{record.project || "—"}</dd>
    </dl>
    {owner.disagree && <p className="lab-window-muted mt-2" dir="auto">Feeds disagree: {Object.entries(owner.perKey).map(([k, v]) => `${k} → ${v}`).join(", ")}.</p>}
  </WindowSection>;
}
