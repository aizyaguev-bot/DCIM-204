// STUB (WP-0): today's PDU detail page inside the window shell, so open=dev:<id> works now. WP-DW replaces the body
// (Readings, Details, Outlets with Edit / Clear rows, Device names, Activity; v2 §W.2) and keeps these props.
// Props: { target, device, status, can, act, onClose }
//   device / status   the PDU (GET /api/devices/) and its reading (App's pduStatuses[id])
//   act.app           outletAction(device, n, action, confirmed), turnOnAll(device, numbers), openMaintenance(mode, id),
//                     saveLabels(id, labels, revision), deleteDevice(id) (legacy; WP-D: act.openDelete)
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
  return <WindowShell kind="pdu" name={device.name} state={state} size="wide" can={can} onClose={onClose}
    badges={[maintenance ? { text: "Maintenance", tone: "warn" } : null, device.enabled === false ? "Disabled" : null].filter(Boolean)}
    facts={[device.rack, device.model, device.port_count ? `${device.port_count} outlets` : "Outlet count not set", device.ip]}>
    <div className="lab-window-embed">
      <PduDetail key={`pdu:${device.id}`} device={device} status={status} maintenance={maintenance}
        maintenanceMode={data.maintenance?.password_mode}
        onMaintenance={mode => act.app.openMaintenance(mode, device.id)}
        onBack={onClose} from="Lab Manager"
        onOutletAction={(n, a, confirmed) => act.app.outletAction(device, n, a, confirmed)}
        onTurnOnAll={numbers => act.app.turnOnAll(device, numbers)}
        onDelete={async () => { if (await act.app.deleteDevice(device.id)) onClose(); }}
        onLabelsSave={(labels, revision) => act.app.saveLabels(device.id, labels, revision)}
        devices={data.devices}/>
    </div>
  </WindowShell>;
}
