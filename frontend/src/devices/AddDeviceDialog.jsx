// STUB (WP-0): today's Add Device form. WP-DW replaces it (v2 §D.7): PDU / KVM / Rack (+ "Also add its PDU"), Admin,
// and the new item's window opens afterwards. It replaces components/AddDeviceModal.jsx.
// Props: { kind?: "pdu" | "kvm" | "rack", rack?: string (fixed rack), racks: [rack name], onClose(), onAdded(device) }
import AddDeviceModal from "../components/AddDeviceModal.jsx";
import { api, errorMessage } from "../api/client.js";

export default function AddDeviceDialog({ racks = [], onClose, onAdded }) {
  async function add(payload) {
    try {
      const device = await api.createDevice(payload);
      onAdded?.(device);
      onClose?.();
    } catch (e) {
      alert(`Failed to add device: ${errorMessage(e)}`);
    }
  }
  return <AddDeviceModal racks={racks} onClose={onClose} onAdd={add}/>;
}
