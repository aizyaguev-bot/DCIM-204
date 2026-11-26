// STUB (WP-0): today's KVM detail page inside the window shell, so open=dev:<id> works now. WP-DW replaces the body
// ("N / M ports active", the ports table with Console / Mark free / Details, Device names, Activity; v2 §W.3) and keeps
// these props.
// Props: { target, device, status, can, act, onClose }
//   device / status   the KVM and its reading; DeviceWindow shows a removed server's name on a port as the port's default
//             name
//   act.app   openConsole(deviceId, port) (asks when the port is IN USE), markKvmFree(id), saveLabels(id, labels, revision)
// Delete… (Admin): ⋯ More › Delete… and the page's "Remove device" open the one delete dialog (act.openDelete).
import KvmDetail from "../pages/KvmDetail.jsx";
import { deviceState } from "../api/client.js";
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell from "../window/WindowShell.jsx";

const STATE = {
  online: { word: "Online", tone: "ok" }, offline: { word: "Unreachable", tone: "bad" }, error: { word: "Sign-in error", tone: "bad" },
  unavailable: { word: "Status unavailable", tone: "unknown" }, unknown: { word: "Waiting for a reading", tone: "unknown" },
};

export default function KvmWindow({ device, status, can, act, onClose }) {
  const { data } = useLabWindow();
  const ports = status?.ports || [];
  const active = ports.filter(p => p.status === "active").length;
  const openDelete = () => act.openDelete([{ kind: "device", id: device.id }]);
  return <WindowShell kind="kvm" name={device.name} state={STATE[deviceState(status)] || STATE.unknown} size="wide" can={can} onClose={onClose}
    deleteTarget={{ kind: "device", id: device.id }} deleteRole="admin"
    facts={[device.rack, device.model, ports.length ? `${active} / ${ports.length} ports active` : null, device.ip]}>
    <div className="lab-window-embed">
      <KvmDetail key={`kvm:${device.id}`} device={device} status={status} onBack={onClose} from="Lab Manager"
        onPortClick={port => act.app.openConsole(device.id, port.number)}
        onDelete={openDelete}
        onMarkFree={() => act.app.markKvmFree(device.id)}
        onLabelsSave={(labels, revision) => act.app.saveLabels(device.id, labels, revision)}
        devices={data.devices}/>
    </div>
  </WindowShell>;
}
