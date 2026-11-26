// open=dev:<device id>: the window of a PDU, a KVM or a rack row (a rack-kind device opens its rack's window).
// Dispatches to PduWindow / KvmWindow / RackWindow, which keep their props when WP-DW fills them in.
// A server removed from the lab shows nowhere: its name still written on an outlet or KVM port reads as that port's
// default name ("Outlet 22", "Port 8"), as on the Dashboard cards (api/removedServers.js with data.hidden).
// Props: { target: { kind: "dev", id, sec? }, onClose }
import { useMemo } from "react";
import { withoutRemovedDevice, withoutRemovedStatus } from "../api/removedServers.js";
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell from "../window/WindowShell.jsx";
import PduWindow from "./PduWindow.jsx";
import KvmWindow from "./KvmWindow.jsx";
import RackWindow from "./RackWindow.jsx";

export default function DeviceWindow({ target, onClose }) {
  const { data, act, can } = useLabWindow();
  const devices = data.devices || [];
  const found = devices.find(d => d.id === target.id);
  const reading = found?.kind === "pdu" ? data.pduStatuses?.[found.id] : found?.kind === "kvm" ? data.kvmStatuses?.[found.id] : undefined;
  const device = useMemo(() => withoutRemovedDevice(found, data.hidden), [found, data.hidden]);
  const status = useMemo(() => withoutRemovedStatus(reading, data.hidden), [reading, data.hidden]);
  if (device?.kind === "pdu") return <PduWindow target={target} device={device} status={status} can={can} act={act} onClose={onClose}/>;
  if (device?.kind === "kvm") return <KvmWindow target={target} device={device} status={status} can={can} act={act} onClose={onClose}/>;
  if (device?.kind === "rack" && device.rack) return <RackWindow target={{ kind: "rack", id: device.rack }} onClose={onClose}/>;
  // A PDU or KVM removed here or in another session (or a link to one that never existed).
  return <WindowShell kind="pdu" name={target.id} state={{ word: "Not found", tone: "unknown" }} can={{ operate: false, admin: false }}
    readOnlyText="Nothing to change" onClose={onClose}>
    <p role="status" className="lab-window-muted">{devices.length ? "This device was removed." : "Loading the device…"}</p>
  </WindowShell>;
}
