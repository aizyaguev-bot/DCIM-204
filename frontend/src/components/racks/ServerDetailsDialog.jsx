import { useRef } from "react";
import { useAccounts } from "../../accounts";
import useDialogFocus from "./useDialogFocus.js";
import { PowerActionButtons, powerBlockReason } from "./ServerPowerControl.jsx";

const FEED_STATE = s => (s === "on" ? "ON" : s === "off" ? "OFF" : "Unknown");

// A server's details in view mode: place, owner, switch, power (whole server and per feed) and console.
// Changing the shelf, outlet, switch or owner stays in Edit mode (ServerEditPanel).
export default function ServerDetailsDialog({ server, visual, owner, sw, shelf, watts, group, pending, waiting, onRequestPower, onClose, consoleButton, sshSlot }) {
  const { canOperate } = useAccounts();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: closeRef, onEscape: onClose });
  const titleId = "server-details-title";
  const feeds = group?.feeds || [];
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="racks-dialog racks-dialog-wide" data-dialog="server" data-state={visual.state}>
      <header className="server-details-header">
        <span className="server-led" data-state={visual.state} aria-hidden="true"/>
        <h2 id={titleId} dir="auto" className="racks-dialog-title">{server.name}</h2>
        <span className="server-state" data-state={visual.state} title={visual.title}>{visual.word}</span>
        {visual.maintenance && <span className="maint-badge">Maintenance</span>}
        <span className="server-details-tools">{sshSlot}<button ref={closeRef} type="button" className="icon-btn" aria-label="Close" onClick={onClose}>×</button></span>
      </header>
      <dl className="racks-dl racks-dl-grid">
        <div><dt>Rack</dt><dd dir="auto">{server.rack}</dd></div>
        <div><dt>Shelf</dt><dd>{shelf}</dd></div>
        <div><dt>Owner</dt><dd dir="auto">{owner || "Owner not set"}</dd></div>
        <div><dt>Switch</dt><dd dir="auto">{sw?.switch ? `${sw.switch}${sw.port != null && sw.port !== "" ? ` · port ${sw.port}` : ""}` : "—"}</dd></div>
        <div><dt>Power (W)</dt><dd>{watts}</dd></div>
        <div><dt>PDU</dt><dd dir="auto">{server.pduName} · outlet {server.outlet}</dd></div>
      </dl>
      <h3 className="racks-dialog-subtitle">Power</h3>
      {canOperate && group && onRequestPower && <div className="power-whole">
        <span className="power-whole-label">Whole server ({feeds.length} {feeds.length === 1 ? "feed" : "feeds"})</span>
        {waiting ? <p className="racks-muted">{powerBlockReason(group, "on", { waiting: true })}</p>
          : <PowerActionButtons group={group} actions={["on", "off"]} pending={pending} label={`Power ${server.name}`}
            onRequest={(action, el) => onRequestPower(action, el, { scope: "server" })}/>}
      </div>}
      {feeds.length > 0 ? <div className="racks-table-wrap"><table className="racks-table">
        <thead><tr><th scope="col">PDU</th><th scope="col">Outlet</th><th scope="col">Label</th><th scope="col">State</th>{canOperate && onRequestPower && feeds.length > 1 && <th scope="col">This feed only</th>}</tr></thead>
        <tbody>{feeds.map(f => <tr key={f.id} data-feed={f.id}>
          <td dir="auto">{f.pduName}{f.inMaintenance && <span className="maint-badge">Maintenance</span>}</td>
          <td>{f.outlet}</td><td dir="auto">{f.label}{f.protected && <span className="racks-muted"> · protected</span>}</td>
          <td><span className="server-state" data-state={f.state === "on" || f.state === "off" ? f.state : "unknown"}>{FEED_STATE(f.state)}</span></td>
          {canOperate && onRequestPower && feeds.length > 1 && <td>{!waiting
            ? <PowerActionButtons group={group} actions={["on", "off"]} scope="feed" feedId={f.id} pending={pending} label={`Power ${f.label} only`}
              onRequest={(action, el) => onRequestPower(action, el, { scope: "feed", feedId: f.id })}/>
            : <span className="racks-muted">—</span>}</td>}
        </tr>)}</tbody>
      </table></div> : <p className="racks-muted">No PDU outlet carries this server's name.</p>}
      {!canOperate && <p className="racks-dialog-note">Viewer · read only</p>}
      {canOperate && consoleButton && <><h3 className="racks-dialog-subtitle">Console</h3><div>{consoleButton}</div></>}
      <p className="racks-dialog-note">Turn on Edit to change this server's shelf, outlet, switch or owner.</p>
    </section>
  </div>;
}
