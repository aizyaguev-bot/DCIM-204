// STUB (WP-0): today's PDU detail page inside the window shell, so open=dev:<id> works now. WP-DW replaces the body
// (Readings, Details, Outlets with Edit / Clear rows, Device names, Activity; v2 §W.2) and keeps these props.
// Props: { target, device, status, can, act, onClose }
//   device / status   the PDU (GET /api/devices/) and its reading (App's pduStatuses[id]); DeviceWindow shows a removed
//                     server's name on an outlet as the outlet's default name
//   act.app           outletAction(device, n, action, confirmed), turnOnAll(device, numbers), openMaintenance(mode, id),
//                     saveLabels(id, labels, revision)
// Delete… (Admin): ⋯ More › Delete… and the page's "Remove device" open the one delete dialog (act.openDelete).
import PduDetail from "../pages/PduDetail.jsx";
import { maintenanceStateFor } from "../components/MaintenanceColumn.jsx";
import { deviceState } from "../api/client.js";
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell from "../window/WindowShell.jsx";

const STATE = {
  online: { word: "Online", tone: "ok" }, offline: { word: "Unreachable", tone: "bad" }, error: { word: "Error", tone: "bad" },
  unavailable: { word: "Status unavailable", tone: "unknown" }, unknown: { word: "Waiting for a reading", tone: "unknown" },
};

export default function PduWindow({ device, status, can, act, onClose }) {
  const { data } = useLabWindow();
  const maintenance = maintenanceStateFor(data.maintenance, device.id);
  const state = maintenance ? { word: "In maintenance", tone: "warn" } : STATE[deviceState(status)] || STATE.unknown;
  const openDelete = () => act.openDelete([{ kind: "device", id: device.id }]);
  // Every outlet switch in the window asks first and names the outlet (Power on included, whatever the account's
  // confirm_power says), like the server window and Racks power.
  const outletAction = (n, a) => {
    const label = status?.outlets?.find(o => String(o.number) === String(n))?.label;
    const target = label && !/^Outlet \d+$/.test(label) ? `${label} (${device.name} · outlet ${n})` : `${device.name}, outlet ${n}`;
    if (!window.confirm(`Power ${a} ${target}?`)) return;
    return act.app.outletAction(device, n, a, true);
  };
  return <WindowShell kind="pdu" name={device.name} state={state} size="wide" can={can} onClose={onClose}
    deleteTarget={{ kind: "device", id: device.id }} deleteRole="admin"
    badges={[maintenance ? { text: "Maintenance", tone: "warn" } : null, device.enabled === false ? "Disabled" : null].filter(Boolean)}
    facts={[device.rack, device.model, device.port_count ? `${device.port_count} outlets` : "Outlet count not set", device.ip]}>
    <div className="lab-window-embed">
      <PduDetail key={`pdu:${device.id}`} device={device} status={status} maintenance={maintenance}
        maintenanceMode={data.maintenance?.password_mode}
        onMaintenance={mode => act.app.openMaintenance(mode, device.id)}
        onBack={onClose} from="Lab Manager"
        onOutletAction={outletAction}
        onTurnOnAll={numbers => act.app.turnOnAll(device, numbers)}
        onDelete={openDelete}
        onLabelsSave={(labels, revision) => act.app.saveLabels(device.id, labels, revision)}
        devices={data.devices}/>
    </div>
  </WindowShell>;
}
