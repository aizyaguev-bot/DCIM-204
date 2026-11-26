import { useEffect, useMemo, useRef, useState } from "react";
import { useLabWindow } from "../window/labWindowContext.js";
import WindowShell, { WindowSection } from "../window/WindowShell.jsx";
import { kvmPortText, outletText } from "../window/format.js";
import { serverRef } from "../twinLinks.js";
import { windowKey } from "./serverKey.js";
import { placeText } from "./serverRecord.js";
import { useServerRecord } from "./useServerRecord.js";
import HeaderTools from "./HeaderTools.jsx";
import PlaceActions from "./PlaceActions.jsx";
import RenameAction from "./RenameAction.jsx";
import PowerAction from "./PowerAction.jsx";
import RemoveAction from "./RemoveAction.jsx";
import PlaceBlock from "./sections/PlaceBlock.jsx";
import OwnerNetworkBlock from "./sections/OwnerNetworkBlock.jsx";
import PowerBlock from "./sections/PowerBlock.jsx";
import UnitsSection from "./sections/UnitsSection.jsx";
import ActivitySection from "./sections/ActivitySection.jsx";

// The packages that put actions into the window (window/CONTRACT.md). Their order is the order in the bar and in More.
const PACKAGES = [PlaceActions, RenameAction, PowerAction, RemoveAction];

// The header's state word and LED: removed, the PDU feeds, else the ping monitor.
function serverState(record) {
  if (record.removed?.active) return { word: "Removed", tone: "off" };
  const power = record.powerGroup?.state;
  if (power === "on") return { word: "On", tone: "ok" };
  if (power === "off") return { word: "Off", tone: "off" };
  if (power === "partial") return { word: "Partly on", tone: "warn" };
  const ping = record.monitor?.status;
  if (ping === "up") return { word: "Answers ping", tone: "ok" };
  if (ping === "down") return { word: "Not answering", tone: "bad" };
  return { word: "Unknown", tone: "unknown" };
}

// At most 2, in this priority: Removed › Maintenance › Not on a rack › Not monitored.
function serverBadges(record) {
  const out = [];
  if (record.removed?.active) out.push({ text: "Removed", tone: "bad" });
  if ((record.powerGroup?.feeds || []).some(f => f.inMaintenance)) out.push({ text: "Maintenance", tone: "warn" });
  if (!record.drawn) out.push({ text: "Not on a rack" });
  if (!record.monitor) out.push({ text: "Not monitored" });
  return out.slice(0, 2);
}

// "No server named X" (an unknown key) or "No longer in the lab list" (it was here): a search over the server list.
function NotFound({ id, gone, renamedTo, onOpen }) {
  const { servers } = useLabWindow();
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase();
  const hits = words ? servers.filter(s => s.name.toLowerCase().includes(words) || s.key.includes(words)).slice(0, 8) : [];
  return <div>
    {renamedTo ? <p role="status">Renamed to <bdi>{renamedTo.name}</bdi> — <button type="button" className="lab-window-link" onClick={() => onOpen(renamedTo.key)}>Open <bdi>{renamedTo.name}</bdi></button></p>
      : <p role="status" dir="auto">{gone ? "No longer in the lab list." : <>No server named <bdi>{id}</bdi>.</>}</p>}
    <label className="lab-window-muted block mt-3" htmlFor="server-window-find">Find a server</label>
    <input id="server-window-find" className="lab-window-search mt-1" value={q} onChange={e => setQ(e.target.value)} placeholder="Name, e.g. OPT12" autoComplete="off"/>
    {hits.length > 0 && <ul className="lab-window-results">{hits.map(s => <li key={s.key}>
      <button type="button" className="lab-window-link" onClick={() => onOpen(s.key)}>{s.name}</button>{s.rack ? <span className="lab-window-muted"> · {s.rack}</span> : null}
    </li>)}</ul>}
  </div>;
}

// The server window (v1 §1): one window for every change to one server. Keyed by identity (windowKey), so every feed
// of a server opens it; KVM-only, unplaced, monitor-only and removed servers open too (removed: read-only).
export default function ServerWindow({ target, onClose }) {
  const lab = useLabWindow();
  const key = windowKey(target.id);
  const record = useServerRecord(key || target.id);
  const removedActive = !!record.removed?.active;
  const can = useMemo(() => ({ operate: lab.can.operate && !removedActive && !record.missing, admin: lab.can.admin }),
    [lab.can.operate, lab.can.admin, removedActive, record.missing]);
  const busyRef = useRef(false);
  // A record that was shown and then disappears: "No longer in the lab list" (or "Renamed to X" when its monitor now
  // belongs to another server).
  const seen = useRef({ found: false, monitorId: null });
  if (key && !record.loading && !record.missing) seen.current = { found: true, monitorId: record.monitor?.id || seen.current.monitorId };

  const act = useMemo(() => {
    const base = lab.act;
    return {
      ...base,
      openMove: ({ mode = "move", swapWith = null, moveTo = null, fixed = null } = {}) => base.openDialog("move", { key, mode, swapWith, moveTo, fixed }),
      openPorts: () => base.openDialog("ports", { key }),
      openClear: () => base.openDialog("clear", { key }),
      rekey: newKey => lab.openServer(newKey, { replace: true }),
      showResult: result => base.showResult(key, result),
      power: { group: record.powerGroup, pending: base.power.pending(key), request: (action, opener, opts) => base.power.request(record.name, action, opener, opts) },
      openConsole: kvmPort => base.app.openConsole(kvmPort.device_id, Number(kvmPort.port)),
      showIn3d: ref => base.goTo("twin", { ref: ref || serverRef(record.dcim_ids[0] ?? record.name) }),
      showOnRacks: rack => base.showOnRacks(rack || record.drawn?.rack || record.rack),
    };
  }, [lab.act, lab.openServer, key, record.powerGroup, record.name, record.dcim_ids, record.drawn, record.rack]);

  // sec=move (the twin's Move… of a live server) and sec=delete open their dialog once, prefilled. Never applied.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || record.loading || record.missing || !key) return;
    opened.current = true;
    if (target.sec === "move" && can.operate) act.openMove({ mode: target.swapWith ? "swap" : "move", moveTo: target.moveTo || null, swapWith: target.swapWith || null });
    if (target.sec === "delete" && can.admin) act.openDelete([{ kind: "server", id: key }]);
  }, [record.loading, record.missing]);

  if (!key || record.missing || record.loading) {
    const renamed = seen.current.monitorId && (lab.data.monitoring?.targets || []).find(t => t.id === seen.current.monitorId && t.server_key && t.server_key !== key);
    return <WindowShell kind="server" name={key ? record.name : target.id} onClose={onClose} can={{ operate: false, admin: false }}
      state={record.loading && key ? { word: "Loading…", tone: "unknown" } : { word: "Not found", tone: "unknown" }}
      readOnlyText={record.loading && key ? "Loading…" : "Nothing to change"}>
      {record.loading && key ? <p className="lab-window-muted" role="status">Loading the server…</p>
        : <NotFound id={target.id} gone={seen.current.found} renamedTo={renamed ? { key: renamed.server_key, name: renamed.name } : null} onOpen={k => lab.openServer(k, { replace: true })}/>}
    </WindowShell>;
  }

  const ctx = { record, can, act };
  const facts = [
    placeText(record),
    ...record.pdu.map(outletText),
    ...record.kvm.map(kvmPortText),
    `Owner: ${record.owner.value || "none"}`,
    record.project ? `Project: ${record.project}` : null,
  ];
  const more = PACKAGES.flatMap(p => (typeof p.more === "function" ? p.more(ctx) || [] : []));
  const dialog = lab.dialog && lab.dialog.key === key ? lab.dialog : null;
  const last = lab.lastChange(key);
  return <WindowShell kind="server" name={record.name} state={serverState(record)} badges={serverBadges(record)} onClose={onClose}
    tools={<HeaderTools {...ctx}/>} facts={facts} can={can} busyRef={busyRef}
    readOnlyText={removedActive ? "Removed · read only" : undefined}
    bar={PACKAGES.map((p, i) => (p.Bar ? <p.Bar key={i} {...ctx}/> : null))}
    more={more} deleteTarget={{ kind: "server", id: key }} deleteRole="admin"
    maybeGone={!record.pdu.length && !record.kvm.length}
    banner={RemoveAction.Banner ? <RemoveAction.Banner {...ctx}/> : null}>
    {last && <div className="lab-window-banner" data-tone="warn" role="status" data-last-change="">
      <strong>Last change:</strong> {last.title || "Saved."}
      {Array.isArray(last.lines) && last.lines.length > 0 && <ul className="mt-1 ml-4 list-disc">{last.lines.map((line, i) => <li key={i} dir="auto">{line}</li>)}</ul>}
      <button type="button" className="lab-window-link ml-2" onClick={() => lab.dismissLastChange(key)}>Dismiss</button>
    </div>}
    <div className="flex flex-col gap-3" data-section="overview">
      <PlaceBlock {...ctx}/>
      <PowerBlock {...ctx}/>
      <OwnerNetworkBlock {...ctx}/>
    </div>
    <WindowSection title="Units on this floor" id="units" collapsible defaultOpen={record.units.length > 0 || target.sec === "units"}>
      <UnitsSection {...ctx}/>
    </WindowSection>
    <WindowSection title="Activity" id="activity" collapsible defaultOpen={target.sec === "activity"}>
      <ActivitySection {...ctx}/>
    </WindowSection>
    {dialog && PACKAGES.map((p, i) => (p.Dialogs && (p.dialogTypes || []).includes(dialog.type)
      ? <p.Dialogs key={i} dialog={dialog} {...ctx} close={lab.closeDialog}/> : null))}
  </WindowShell>;
}
