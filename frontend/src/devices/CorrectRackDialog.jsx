// STUB (WP-0). WP-DW builds it (v2 §D.6): Admin "Correct rack…" of a PDU or KVM. PATCH /api/devices/{id}
// {rack, confirm_name?} alone; the dry run lists servers_moving (KVM-only servers move with their KVM); the device name
// is typed to confirm when servers move or the device has named ports.
// Props: { device, onClose(), onSaved(device) }
import StubDialog from "../window/StubDialog.jsx";

export default function CorrectRackDialog({ device, onClose }) {
  return <StubDialog id="correct-rack" title={`Correct the rack of ${device?.name || "device"}`} text="Correcting a device's rack is not available yet." onClose={onClose}/>;
}
