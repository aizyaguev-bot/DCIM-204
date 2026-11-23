// STUB (WP-0, read-only). WP-DW replaces the body (v2 §W.4): type, server and unit counts, its PDUs and KVMs (and the
// shared ones), cooling units, the 3D frame; Show on Racks and 3D; Admin [+ Add PDU to this rack] and Delete rack….
// Props: { target: { kind: "rack", id: <rack name> }, onClose }
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell, { WindowSection } from "../window/WindowShell.jsx";
import { rackRef } from "../twinLinks.js";
import { MAIN_STORAGE } from "../api/inventory.js";

export default function RackWindow({ target, onClose }) {
  const { data, act, can } = useLabWindow();
  const rack = target.id;
  const devices = (data.devices || []).filter(d => d.rack === rack);
  const units = data.rackItems?.[rack] || [];
  const servers = (data.locations?.servers || []).filter(s => (s.drawn?.rack || s.rack) === rack);
  const known = devices.length > 0 || Array.isArray(data.rackItems?.[rack]) || servers.length > 0 || rack === MAIN_STORAGE;
  const storage = rack === MAIN_STORAGE || devices.some(d => d.kind === "rack" && d.model === "Storage");
  return <WindowShell kind="rack" name={rack} state={known ? { word: storage ? "Storage" : "Compute", tone: "ok" } : { word: "Not found", tone: "unknown" }}
    can={{ operate: false, admin: false }} readOnlyText={can.operate ? "Rack changes stay in Racks › Edit rack for now" : "Viewer · read only"} onClose={onClose}
    facts={[`${servers.length} ${servers.length === 1 ? "server" : "servers"}`, `${units.length} ${units.length === 1 ? "unit" : "units"}`]}
    tools={<>
      <button type="button" className="lab-window-btn" onClick={() => act.goTo("racks", rack)}>Show on Racks</button>
      {rackRef(rack) && <button type="button" className="lab-window-btn" onClick={() => act.goTo("twin", { ref: rackRef(rack) })}>3D</button>}
    </>}>
    <WindowSection title="PDUs and KVMs" id="devices">
      {devices.filter(d => d.kind !== "rack").length ? <ul className="m-0 p-0 list-none">
        {devices.filter(d => d.kind !== "rack").map(d => <li key={d.id}>
          <button type="button" className="lab-window-link" onClick={() => act.open({ kind: "dev", id: d.id })}>{d.name}</button>
          <span className="lab-window-muted"> · {d.kind.toUpperCase()}</span>
        </li>)}
      </ul> : <p className="lab-window-muted">None on this rack.</p>}
    </WindowSection>
    <WindowSection title="Servers and units" id="contents">
      {servers.length + units.length ? <ul className="m-0 p-0 list-none">
        {servers.map(s => <li key={s.key}><button type="button" className="lab-window-link" onClick={() => act.open({ kind: "server", id: s.key })}>{s.name}</button></li>)}
        {units.map(u => <li key={u.id}><button type="button" className="lab-window-link" onClick={() => act.open({ kind: "unit", id: String(u.id) })}>{u.name || u.id}</button></li>)}
      </ul> : <p className="lab-window-muted">{known ? "Nothing on this rack." : "No rack with this name in Lab Manager."}</p>}
    </WindowSection>
  </WindowShell>;
}
