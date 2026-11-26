// The server window's header tools (v1 §1.1), before ×. Props: { record, can, act }.
//   Console  Operator, when a KVM port carries the server's name: act.openConsole(kvmPort) is App's openKvmConsole, so it
//            opens the console with autologin, marks the port IN USE and asks first when the port is already IN USE.
//            One button per KVM port (a server on two KVMs gets two).
//   SSH      Operator: the shared SshButton; its status is read fresh when the window opens (the page's copy can be a
//            minute old).
//   3D       every role: the Twin tab on srv:<first DCIM id> (it leaves the window).
import { useEffect } from "react";
import { TWIN_ENABLED } from "../twinLinks.js";
import { useAccounts } from "../accounts";
import { sshStatusStore } from "../api/ssh";
import SshButton from "../components/SshButton";
import { kvmPortText } from "../window/format.js";
import "./server-ops.css";

export default function HeaderTools({ record, can, act }) {
  const { mode } = useAccounts();
  const operate = !!can?.operate && !!record && !record.missing;
  useEffect(() => {
    if (operate && mode === "accounts") sshStatusStore.refresh({ force: true })?.catch?.(() => {});
  }, [operate, mode]);
  if (!record || record.missing) return null;
  const ports = operate ? record.kvm || [] : [];
  return <>
    {ports.map(port => {
      const where = kvmPortText(port);
      const label = ports.length > 1 ? `Console ${port.device_name || port.device_id} · ${port.port}` : "Console";
      return <button key={`${port.device_id}:${port.port}`} type="button" className="lab-window-btn" data-tool="console"
        data-in-use={port.inUse ? "true" : "false"}
        title={port.inUse ? `${where} is marked IN USE: someone may be working on it` : `Open the KVM console (${where})`}
        aria-label={`Open the console of ${record.name} (${where}${port.inUse ? ", IN USE" : ""})`}
        onClick={() => act.openConsole(port)}>
        {label}{port.inUse && <span className="srv-tool-flag">IN USE</span>}
      </button>;
    })}
    {operate && <span className="srv-ssh" data-tool="ssh"><SshButton name={record.name} size="md"/></span>}
    {TWIN_ENABLED && <button type="button" className="lab-window-btn" data-tool="3d" title={`Show ${record.name} in 3D`} onClick={() => act.showIn3d()}>3D</button>}
  </>;
}
