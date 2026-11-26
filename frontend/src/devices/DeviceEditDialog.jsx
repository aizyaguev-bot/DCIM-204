// STUB (WP-0). WP-DW builds it (v2 §D.6): Edit details of a PDU or KVM (Admin) through
// PATCH /api/devices/{id} {name?, ip?, username?, password?, model?, port_count?, notes?, enabled?} with ?dry_run=true
// first and plan_revision on apply (api/devices.js patchDevice). A blank username or password keeps the stored one.
// Props: { device, onClose(), onSaved(device) }
import StubDialog from "../window/StubDialog.jsx";

export default function DeviceEditDialog({ device, onClose }) {
  return <StubDialog id="device-edit" title={`Edit ${device?.name || "device"}`} text="Editing device details is not available yet." onClose={onClose}/>;
}
