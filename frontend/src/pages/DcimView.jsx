import { sumKnown, reading } from "../power";
import { useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { loadRackItems, saveRackItems, MAIN_STORAGE } from "../api/inventory";
import { loadLayout, saveLayout } from "../api/layout";
import { splitSections, sectionHeading, versionOf } from "../api/changelog";
import { SectionBody, plain } from "../components/WhatsNew";
import {useAccounts, accountRequest} from "../accounts";
import {OwnerSelect, useEngineers} from "../engineers";
import SshButton, { useSshStatus } from "../components/SshButton";
import { findServer } from "../api/ssh";
import { serverIdentity } from "../api/locations";
import { deviceState } from "../api/client";
import { serverVisualState, rackSummary, maintenanceFor, withCoolingRows, compactRows, buildSearchIndex, searchIndex, matchesFilter, shelfOptions } from "../components/racks/rackView.js";
import { normalizeChillers, groupChillers, updateChiller, placeChiller, addChiller, newChillerId, assertKeepsUnits, describePlace, coolingChange, undoCoolingChange, validShelf, shelfLabel, sameDocument } from "../components/racks/chillers.js";
import { BLOCK, serverPowerGroup, planServerPower, sameTargets, serverDisplayName } from "../components/racks/serverPower.js";
import ServerPowerControl, { PowerActionButtons } from "../components/racks/ServerPowerControl.jsx";
import PowerConfirmDialog from "../components/racks/PowerConfirmDialog.jsx";
import CoolingUnitDialog from "../components/racks/CoolingUnitDialog.jsx";
import { CoolingChip, CoolingStrip, CoolingPanel } from "../components/racks/CoolingUnits.jsx";
import { RackKpis, RacksToolbar, filterEmptyText } from "../components/racks/RacksToolbar.jsx";
import ServerDetailsDialog from "../components/racks/ServerDetailsDialog.jsx";
import UndoToast from "../components/racks/UndoToast.jsx";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { useStoredState, useMediaQuery, useDebounced, flash, prefersReducedMotion } from "../components/racks/hooks.js";

const EditContext = createContext(false);
// Server actions in the rack views: the KVM port of each server (by server identity), the console opener and SSH
// (sshFor, drawn through the SSH slot renderSsh), and the server's power (feeds, pending request, the request that
// opens the in-app confirmation).
const ServerActionsContext = createContext({ kvmFor: () => null, openConsole: null, sshFor: () => null, canOperate: false,
  powerFor: null, powerPending: () => null, requestPower: null, waitingFor: () => false, renderSsh: null });

// Small KVM button for a server row: opens that server's KVM console (Operator and up).
function KvmButton({ server, compact = false }) {
  const { kvmFor, openConsole, canOperate } = useContext(ServerActionsContext);
  const target = kvmFor(server.name);
  if (!target || !openConsole || !canOperate) return null;
  return <button type="button" className={compact ? "kvm-open kvm-open-compact" : "kvm-open"}
    title={`Open the KVM console of ${server.name} (${target.kvmName}, port ${target.port})`}
    aria-label={`Open KVM console of ${server.name}`}
    onClick={e => { e.stopPropagation(); openConsole(target.kvmId, target.port); }}
    onKeyDown={e => e.stopPropagation()}>KVM</button>;
}

// SSH button next to KVM for a server row: the shared SshButton (the terminal link in a new tab, or an inactive button
// that names the reason). Nothing for Viewers or for labels that are not servers; clicks and keys stay off the row.
function RackSshButton({ server, compact = false }) {
  const { sshFor, canOperate } = useContext(ServerActionsContext);
  const name = sshFor(server.name);
  if (!name || !canOperate) return null;
  return <span className="contents" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <SshButton name={name} size={compact ? "sm" : "md"} className={compact ? "ssh-open-compact" : ""}/>
  </span>;
}

function Portal({ children }) {
  return createPortal(children, document.body);
}
import {
  DndContext, closestCenter, PointerSensor,
  useSensor, useSensors, DragOverlay, useDroppable, useDraggable, pointerWithin,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ─── icons ───────────────────────────────────────────────────────────────────
const I = ({ d, size = 14, sw = 1.8 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    <path d={d}/>
  </svg>
);
const Icon = {
  rack:  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/></svg>,
  bolt:  <I d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" size={13}/>,
  list:  <I d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1zM9 12h6M9 16h4" size={13}/>,
  log:   <I d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" size={13}/>,
  x:     <I d="M18 6 6 18M6 6l12 12" sw={2.5} size={15}/>,
  check: <I d="M20 6 9 17l-5-5" sw={2.5} size={12}/>,
  back:  <I d="M19 12H5M12 5l-7 7 7 7" size={14}/>,
  plus:  <I d="M12 5v14M5 12h14" size={12}/>,
  grip:  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="2" r="1.3"/><circle cx="7" cy="2" r="1.3"/><circle cx="3" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="3" cy="12" r="1.3"/><circle cx="7" cy="12" r="1.3"/></svg>,
  edit:  <I d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" size={11}/>,
  trash: <I d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" size={11}/>,
};
const Spinner = () => (
  <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round"/>
  </svg>
);

// ─── custom item types ────────────────────────────────────────────────────────
const ITEM_TYPES = {
  switch:     { label: "Switch",       bg: "bg-cyan-900/25",   border: "border-cyan-800/50",   text: "text-cyan-300"   },
  computer:   { label: "Computer",     bg: "bg-blue-900/25",   border: "border-blue-800/50",   text: "text-blue-300"   },
  patchpanel: { label: "Patch Panel",  bg: "bg-slate-800/40",  border: "border-slate-700/50",  text: "text-slate-300"  },
  cable:      { label: "Cable Mgmt",   bg: "bg-zinc-800/30",   border: "border-zinc-700/40",   text: "text-zinc-400"   },
  pdu:        { label: "PDU",          bg: "bg-amber-900/20",  border: "border-amber-800/50",  text: "text-amber-300"  },
  kvm:        { label: "KVM",          bg: "bg-purple-900/25", border: "border-purple-800/50", text: "text-purple-300" },
  ups:        { label: "UPS",          bg: "bg-green-900/20",  border: "border-green-800/50",  text: "text-green-300"  },
  blank:      { label: "Blank Panel",  bg: "bg-zinc-900/50",   border: "border-zinc-800/30",   text: "text-zinc-700"   },
  other:      { label: "Other",        bg: "bg-zinc-800/30",   border: "border-zinc-700/40",   text: "text-zinc-400"   },
};

// ─── helpers ─────────────────────────────────────────────────────────────────
export function isDefaultOutletLabel(label) {
  return !label || /^(outlet\s*\d+|port\s*\d+|\s*)$/i.test(label.trim());
}
// Outlet labels that are not computers ("empty", "KVM Power", placeholders) are not OPTs: they never take a U slot
// and are not counted. The 3D Twin (lab-twin/app.js NON_SERVER_LABEL) uses the same text, so both show the same shelves.
const NON_SERVER_LABEL = /^(empty|kvm[\s_-]*power|pdu|spare|free|n\/a|-+)$/i;
export function isServerLabel(label) {
  return !isDefaultOutletLabel(label) && !NON_SERVER_LABEL.test(String(label).trim());
}
// A U slot an operator may enter for equipment: a whole number from 0 (whole rack) to 42.
export const U_SLOT_ERROR = "U slot must be a whole number from 0 to 42.";
export function parseUSlot(text) {
  const value = String(text ?? "").trim();
  return /^\d{1,2}$/.test(value) && Number(value) <= 42 ? Number(value) : null;
}
function genId() { return `ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`; }

export function buildRackRows(servers, rackName, rackOrder, rackSlots, customItems) {
  const order  = rackOrder[rackName] || [];
  const slots  = rackSlots[rackName] || {};
  const custom = customItems[rackName] || [];

  const sorted = servers.filter(s => !NON_SERVER_LABEL.test(String(s.name || "").trim())).sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1; if (bi === -1) return -1;
    return ai - bi;
  });

  // Assign U slots to servers (custom items no longer block server slots)
  const uMap = {};
  sorted.forEach(s => { if (slots[s.id] != null) uMap[s.id] = Number(slots[s.id]); });
  let next = 1;
  sorted.forEach(s => {
    if (uMap[s.id] == null) {
      while (Object.values(uMap).includes(next)) next++;
      uMap[s.id] = next++;
    }
  });

  // Build per-U groups: u → [{kind, data}]. A saved U that is not a whole number from 0 (old or hand-edited
  // rack_slots data) is listed with the whole-rack equipment; uMap keeps the saved value, as the Twin and backend read it.
  const groups = new Map();
  sorted.forEach(s => {
    const u = Number.isInteger(uMap[s.id]) && uMap[s.id] >= 0 ? uMap[s.id] : 0;
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u).push({ kind: "server", data: s });
  });

  // Equipment belongs on its recorded shelf, including shelves without an OPT. A U that is not a whole number
  // from 0 to 42 (old or hand-edited data) is listed with the whole-rack equipment instead of stretching the rack.
  custom.forEach(item => {
    const n = typeof item.u === "string" && item.u.trim() ? Number(item.u) : item.u;
    const u = Number.isInteger(n) && n >= 0 && n <= 42 ? n : 0;
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u).push({ kind: "custom", data: item });
  });

  // auto: the shelf shows an OPT whose U nobody saved; it was placed on the next free shelf.
  const row = u => {
    const items = groups.get(u) || [];
    return { u, items, auto: items.some(i => i.kind === "server" && slots[i.data.id] == null) };
  };
  const rows = [];
  if (rackName === MAIN_STORAGE) {
    // Main storage has no empty shelves to draw: its occupied shelves in order, then the whole-unit equipment.
    [...groups.keys()].filter(u => u > 0).sort((a, b) => a - b).forEach(u => rows.push(row(u)));
  } else {
    const maxU   = Math.max(0, ...[...groups.keys()].filter(u => Number.isInteger(u) && u >= 1));
    const totalU = Math.max(maxU + 2, 8);
    for (let u = 1; u <= totalU; u++) rows.push(row(u));
  }
  if (groups.has(0)) rows.push(row(0));
  return { rows, uMap, sorted };
}

// ─── primitives ──────────────────────────────────────────────────────────────
function Pill({ color = "zinc", sm, children }) {
  const sz  = sm ? "text-[9px] px-1 py-px" : "text-[11px] px-1.5 py-0.5";
  const map = {
    green:  "bg-emerald-900/40 text-emerald-400 border-emerald-800/50",
    red:    "bg-rose-900/30 text-rose-400 border-rose-800/40",
    zinc:   "bg-zinc-800/50 text-zinc-400 border-zinc-700/40",
    purple: "bg-purple-900/30 text-purple-400 border-purple-800/40",
    cyan:   "bg-cyan-900/30 text-cyan-400 border-cyan-800/40",
    nv:     "bg-nv-400/10 text-nv-400 border-nv-400/30",
  };
  return <span className={`inline-flex items-center gap-0.5 font-medium rounded border ${sz} ${map[color]}`}>{children}</span>;
}
function SL({ children }) {
  return <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5">{children}</div>;
}
function TabBtn({ label, icon, active, onClick }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg transition
      ${active ? "bg-nv-400/15 text-nv-400 border border-nv-400/30" : "text-zinc-500 hover:text-zinc-300 border border-transparent hover:bg-zinc-800/40"}`}>
      {icon}{label}
    </button>
  );
}
function CloseBtn({ onClose }) {
  return (
    <button onClick={onClose} aria-label="Close"
      className="flex items-center justify-center w-7 h-7 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 transition border border-zinc-700/50 flex-shrink-0">
      {Icon.x}
    </button>
  );
}

// ─── ESC to close ─────────────────────────────────────────────────────────────
function useEscClose(onClose) {
  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

// ─── RACK SLOT ROWS ───────────────────────────────────────────────────────────
const SLOT_H = 48;   // height of an occupied U row
const EMPTY_H = 20;  // height of an empty U row

// Module-level: rows remount when their shelf changes, which must not drop or orphan a pending open.
let pendingOpen = null;

// Inline-rename text span
function InlineName({ value, onRename, onOpen, className }) {
  const editMode = useContext(EditContext);
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  const ref = useRef(null);

  useEffect(() => { if (editing) { setDraft(value); ref.current?.select(); } }, [editing]);

  function commit() {
    const v = draft.trim();
    if (editMode && v && v !== value) onRename?.(v);
    setEditing(false);
  }

  if (editing && editMode) {
    return (
      <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        onBlur={commit} onClick={e => e.stopPropagation()} dir="auto" aria-label={`Rename ${value}`}
        className="flex-1 min-w-0 bg-transparent border-b border-nv-400/70 outline-none text-[11px] font-mono text-zinc-100"/>
    );
  }
  return (
    <span onDoubleClick={e => { e.stopPropagation(); clearTimeout(pendingOpen); if (editMode) setEditing(true); }}
      onClick={e => {
        if (!editMode) return;
        // Opening waits out the double-click window so a double-click still renames.
        e.stopPropagation(); clearTimeout(pendingOpen);
        if (onOpen) pendingOpen = setTimeout(onOpen, 250);
      }}
      title={editMode ? "Click to open · double-click to rename" : value} dir="auto"
      className={`${className} cursor-text select-none`}>
      {value}
    </span>
  );
}

// ─── server row ───────────────────────────────────────────────────────────────
// The Racks view model the rows and cards read: row states, search hits, compacted shelves and cooling units.
const RackViewContext = createContext({
  visualFor: () => ({ state: "unknown", maintenance: false, word: "Unknown", title: "" }),
  summaryFor: null, matchKeys: null, rowKeep: null, showEmpty: false,
  coolingByRack: {}, coolingDrop: false, coolingDraggable: false, coolingEditable: false, coolingCanPlace: false,
  onOpenCooling: null, onPlaceCooling: null, onAddCooling: null, itemsError: false,
});

// SSH slot: empty (and taking no space) until the SSH release sets renderSsh on ServerActionsContext.
function SshSlot({ server, size = "sm" }) {
  const { renderSsh } = useContext(ServerActionsContext);
  return renderSsh ? <span data-ssh-slot className="contents">{renderSsh(server, size)}</span> : null;
}

function RowPower({ server }) {
  const { powerFor, powerPending, requestPower, waitingFor } = useContext(ServerActionsContext);
  if (!requestPower || !powerFor) return null;
  return <ServerPowerControl server={server} group={powerFor(server)} pending={powerPending(server)} waiting={waitingFor(server)}
    onRequest={(action, el) => requestPower(server, action, el)}/>;
}

// The server's name is its open button (so Power, KVM and SSH are sibling buttons, never nested). In Edit mode a
// click opens after the double-click window and a double-click renames.
function ServerName({ server, onOpen, onRename }) {
  const editMode = useContext(EditContext);
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(server.name);
  const ref = useRef(null);
  useEffect(() => { if (editing) { setDraft(server.name); ref.current?.select(); } }, [editing]);
  useEffect(() => { if (!editMode) setEditing(false); }, [editMode]);
  function commit() {
    const v = draft.trim();
    if (editMode && v && v !== server.name) onRename?.(v);
    setEditing(false);
  }
  if (editing && editMode) {
    return <input ref={ref} dir="auto" aria-label={`Rename ${server.name}`} value={draft} onChange={e => setDraft(e.target.value)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
      onBlur={commit} onClick={e => e.stopPropagation()} className="server-rename"/>;
  }
  return <button type="button" className="server-open" aria-label={`View ${server.name}`}
    title={editMode ? `${server.name} · click to open · double-click to rename` : server.name}
    onClick={e => { e.stopPropagation(); clearTimeout(pendingOpen); if (editMode) pendingOpen = setTimeout(onOpen, 250); else onOpen(); }}
    onDoubleClick={e => { e.stopPropagation(); clearTimeout(pendingOpen); if (editMode) setEditing(true); }}>
    <span dir="auto" className="server-name">{server.name}</span>
  </button>;
}

// The PDU feeds a server row names: the outlets carrying this row's own label (an OPT labelled PSU1/PSU2 has a row per
// PSU), else every feed of the server, else the outlet the Racks list found it on.
function rowFeeds(server, group) {
  const name = String(server.name || "").trim().toLowerCase();
  const feeds = group?.feeds || [];
  const own = feeds.filter(f => String(f.label).trim().toLowerCase() === name);
  if (own.length) return own;
  if (feeds.length) return feeds;
  const outlet = Number(server.outlet);
  return server.pduName && Number.isFinite(outlet) ? [{ id: `${server.pduId}:${outlet}`, pduName: server.pduName, outlet, state: server.state }] : [];
}

// One chip per feed, "PDU 01 · 3". When the server's feeds disagree the chips are amber and say which feed is on or off.
function FeedChips({ feeds, partial }) {
  return feeds.map(f => {
    const state = f.state === "on" || f.state === "off" ? f.state : "unknown";
    return <span key={f.id} className="unit-chip feed-chip" data-feed-state={state} data-partial={partial ? "" : undefined}
      title={`${f.pduName} · outlet ${f.outlet} · ${state === "unknown" ? "no reading" : state}`}>
      <bdi>{f.pduName}</bdi>&nbsp;· {f.outlet}{partial && state !== "unknown" ? ` · ${state.toUpperCase()}` : ""}
    </span>;
  });
}

// The SSH host Lab Manager knows for a server (Operators and up get it from the /api/ssh/status snapshot the SSH buttons
// already share). Nothing when no host is known or when it is just the server's own name.
function ServerHost({ server }) {
  const { data } = useSshStatus();
  const known = findServer(data?.servers, server.name);
  const host = String(known?.approved_host || known?.host || "").trim();
  if (!host || serverIdentity(host) === serverIdentity(server.name)) return null;
  return <span className="unit-host" dir="ltr" title={`SSH host ${host}`}>{host}</span>;
}

// One server on a shelf, as one row of a list whose columns line up down the rack card: a status stripe on its left
// edge (the LED), the name, the state word (the meaning never depends on colour), maintenance and watts, its PDU feeds,
// KVM port, owner, SSH host and switch port, then KVM, SSH and Power (view mode) at the row's end. In Edit mode the
// grip ⠿ at the start of the row drags it. A narrow card (the overview grid, a phone) shows the chips on a second line.
// data-feeds="partial": its feeds disagree (one on, one off), shown in amber like its Mixed switch.
function ServerCell({ server, sw, owner, onSelect, onRename, overlay = false, dragHandleProps = null }) {
  const editMode = useContext(EditContext);
  const { visualFor, matchKeys } = useContext(RackViewContext);
  const { powerFor, feedsFor, kvmFor, canOperate, renderSsh } = useContext(ServerActionsContext);
  const { mode } = useAccounts();
  const visual = visualFor(server);
  const partial = powerFor?.(server)?.state === "partial";
  const group = feedsFor?.(server) || null;
  const feeds = rowFeeds(server, group);
  const kvm = kvmFor?.(server.name);
  const open = () => onSelect?.(server);
  return <div className="server-cell unit-row" data-server={server.name} data-server-id={server.id} data-state={visual.state}
    data-feeds={partial ? "partial" : undefined}
    data-maintenance={visual.maintenance ? "" : undefined} data-match={matchKeys?.has(`s:${server.id}`) ? "" : undefined}
    onClick={e => { if (!e.target.closest(".server-actions,input,.server-open,.shelf-grip")) open(); }}>
    <span className="server-led" aria-hidden="true"/>
    <div className="unit-main">
      {editMode && !overlay && <div {...(dragHandleProps || {})} tabIndex={-1} className="shelf-grip" aria-label={`Move ${server.name}`} title="Drag to move" onClick={e => e.stopPropagation()}>{Icon.grip}</div>}
      <ServerName server={server} onOpen={open} onRename={onRename}/>
    </div>
    <div className="unit-state">
      <span className="server-state" data-state={visual.state} title={visual.title}>{visual.word}</span>
      {visual.maintenance && <span className="maint-badge" title={BLOCK.maintenance}>Maintenance</span>}
      {(visual.state === "on" || visual.state === "off") && Number.isFinite(server.watts) && <span className="server-watts">{reading(server.watts, 0, " W")}</span>}
    </div>
    <div className="unit-details">
      <span className="unit-col unit-feeds"><FeedChips feeds={feeds} partial={group?.state === "partial"}/></span>
      <span className="unit-col unit-kvm">{kvm && <span className="unit-chip kvm-chip" title={`KVM: ${kvm.kvmName}, port ${kvm.port}`}><bdi>{kvm.kvmName}</bdi>&nbsp;· port {kvm.port}</span>}</span>
      <span className="unit-col unit-owner">{owner && <span className="owner-pill" dir="auto" title={`Owner: ${owner}`}>{owner}</span>}</span>
      <span className="unit-col unit-net">
        {canOperate && renderSsh && mode !== "legacy" && <ServerHost server={server}/>}
        {sw?.switch && <span className="server-switch" dir="auto" title={`Switch ${sw.switch}${sw.port ? ` · port ${sw.port}` : ""}`}>{sw.switch}{sw.port ? `:${sw.port}` : ""}</span>}
      </span>
    </div>
    {!overlay && canOperate && <div className="server-actions unit-actions" data-edit={editMode ? "" : undefined} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      {!editMode && <RowPower server={server}/>}
      <KvmButton server={server} compact/>
      <SshSlot server={server} size="sm"/>
    </div>}
  </div>;
}

// One equipment row (Enter or Space opens it): its name under the server names, its type chip in the state column,
// serial and position in the chips column. It keeps an empty actions column so the columns line up with the servers.
function EquipCell({ item, onSelect, onRename }) {
  const editMode = useContext(EditContext);
  const { canOperate } = useContext(ServerActionsContext);
  const meta = ITEM_TYPES[item.type] || ITEM_TYPES.other;
  const { matchKeys } = useContext(RackViewContext);
  return <div className="equipment-cell unit-row" data-type={item.type} data-item-id={item.id} data-match={matchKeys?.has(`e:${item.id}`) ? "" : undefined}
    onClick={() => onSelect?.(item)} role="button" tabIndex={0} aria-label={`View ${item.name}`}
    onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect?.(item); } }}>
    <div className="unit-main">
      {editMode && <span className="unit-grip-space" aria-hidden="true"/>}
      <InlineName value={item.name} onRename={onRename} onOpen={() => onSelect?.(item)} className="equipment-name"/>
    </div>
    <div className="unit-state"><span className="equipment-type">{meta.label}</span></div>
    {(item.serial_number || item.barcode || item.shelf_position) && <div className="unit-details">
      <span className="unit-col unit-feeds">{(item.serial_number || item.barcode) && <span className="equipment-serial" title={item.serial_number || item.barcode}>SN: {item.serial_number || item.barcode}</span>}</span>
      <span className="unit-col unit-kvm">{item.shelf_position && <span className="equipment-serial" title={`Position: ${item.shelf_position}`}>{item.shelf_position}</span>}</span>
    </div>}
    {canOperate && <span className="unit-actions" data-edit={editMode ? "" : undefined} aria-hidden="true"/>}
  </div>;
}

// A cooling unit on a shelf or in a rack's strip; in Edit mode on the overview it can also be dragged (pointer only).
function RackCoolingChip({ unit, variant }) {
  const editMode = useContext(EditContext);
  const { coolingDraggable, onOpenCooling, onPlaceCooling, matchKeys } = useContext(RackViewContext);
  const drag = useDraggable({ id: `cooling:${unit.id}`, disabled: !coolingDraggable, data: { unit } });
  const place = variant === "strip" && !editMode && onPlaceCooling;
  return <CoolingChip unit={unit} variant={variant} onOpen={place || onOpenCooling} actionLabel={place ? "Place…" : null}
    highlighted={!!matchKeys?.has(`c:${unit.id}`)} dragHandle={coolingDraggable ? drag : null}/>;
}

// One shelf: its number once on the left, then one row per server (several servers = stacked rows), one row per piece of
// equipment and the cooling units on that shelf; an empty shelf is a compact dashed "Free" row.
function USlotGroup({ rack, u, items, auto, switchAssignments, optOwners, onSelectServer, onSelectCustom, onRenameServer, onRenameCustom, sortable = false }) {
  const { coolingByRack, coolingDrop } = useContext(RackViewContext);
  const cooling = u > 0 ? coolingByRack?.[rack]?.placed?.[u] || [] : [];
  const { setNodeRef, isOver } = useDroppable({ id: `shelf:${rack}:${u}`, disabled: !coolingDrop || !(u > 0) });
  const servers = items.filter(i => i.kind === "server");
  const index = String(u).padStart(2, "0");
  if (!items.length && !cooling.length) return <div ref={setNodeRef} data-u-slot={u} data-over={isOver ? "" : undefined} className="shelf-empty"><span className="shelf-index">{index}</span><span className="shelf-empty-line">Free</span></div>;
  const Row = sortable ? SortableServerRow : ServerCell;
  return <div ref={setNodeRef} data-u-slot={u} data-auto={auto ? "" : undefined} data-cooling-only={!items.length ? "" : undefined} data-over={isOver ? "" : undefined} className="shelf-row">
    <span className="shelf-index" title={auto ? `Auto-placed — no saved U for this OPT; it is shown on the next free shelf (${u}). Set its U in Edit mode to keep it here.` : u ? `Shelf ${u}` : "Rack level (no shelf)"}>{u ? index : "—"}</span>
    <div className="shelf-content">
      {servers.map(({data}) => <Row key={data.id} server={data} sw={switchAssignments[data.id]} owner={optOwners?.[data.id]} onSelect={onSelectServer} onRename={v => onRenameServer?.(data, v)}/>)}
      {items.filter(i => i.kind === "custom").map(({data}) => <EquipCell key={data.id} item={data} onSelect={onSelectCustom} onRename={v => onRenameCustom?.(data, v)}/>)}
      {cooling.length > 0 && <div className="shelf-cooling">{cooling.map(unit => <RackCoolingChip key={unit.id} unit={unit} variant="shelf"/>)}</div>}
    </div>
  </div>;
}

// A server row that Edit mode can drag by its grip (to another shelf of the rack, or onto another rack's card).
function SortableServerRow(props) {
  const editMode = useContext(EditContext);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.server.id, disabled: !editMode });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`unit-sortable${editMode && isDragging ? " opacity-30" : ""}`}>
    <ServerCell {...props} dragHandleProps={{ ...listeners, ...attributes }}/>
  </div>;
}

// A shelf with servers: each server row is sortable on its own (the rack card decides where a dropped row goes).
function SortableURow({ isDragging, ...props }) {
  return <USlotGroup {...props} sortable/>;
}

// ─── RACK CARD PARTS ──────────────────────────────────────────────────────────
function loadPercent(r) {
  return r.maxWatts > 0 && Number.isFinite(r.totalWatts) ? Math.min(100, r.totalWatts / r.maxWatts * 100) : null;
}
const loadColor = pct => (pct > 80 ? "#fe3f3f" : pct >= 60 ? "#ef9100" : "#76b900");

// The figures line: "N OPTs" always first (racks.cjs reads it), then states and the power reading.
function RackFigures({ r, summary, equipment, itemsError, detail = false }) {
  const pct = loadPercent(r);
  const names = r.pduData.map(p => p.name).join(", ");
  return <div className="rack-meta">
    <span>{r.servers.length} OPTs</span>
    {(summary.status === "storage" || summary.status === "no-pdu" || detail) && !itemsError && <span>· {equipment} equipment</span>}
    {summary.status === "loading" && <span>· Reading PDUs…</span>}
    {summary.status === "no-pdu" && <span>· No PDU reading</span>}
    {(summary.status === "offline" || summary.status === "unavailable") && <span className="rack-meta-off">· No reading from <bdi>{names}</bdi></span>}
    {summary.status === "online" && <>
      <span>· {summary.on} on</span>
      {summary.off ? <span className="rack-meta-off">· {summary.off} off</span> : null}
      {summary.noReading ? <span>· {summary.noReading} no reading</span> : null}
    </>}
    {summary.status === "online" && r.pduOnline && <>
      <span>· {reading(r.totalWatts, 0, " W")}</span>
      <span>· {r.currentEstimated ? "≈" : ""}{reading(r.totalAmps, 1, " A")}</span>
      {pct != null && <span>· {Math.round(pct)}%{detail ? " of PDU capacity (estimate)" : ""}</span>}
      {summary.partial && <span className="rack-partial" title="Some PDUs or outlets did not report; totals are lower bounds.">partial</span>}
    </>}
  </div>;
}

function LoadBar({ r }) {
  const pct = loadPercent(r);
  if (!r.pduOnline || pct == null) return null;
  return <div className="rack-load" role="img" aria-label={`Estimated load ${Math.round(pct)}% of PDU capacity`}
    title="Load estimate uses the existing 16 A per inlet assumption; email alert thresholds are configured separately.">
    <div style={{ width: `${pct}%`, background: loadColor(pct) }}/>
  </div>;
}

// The one-line state of a collapsed card.
function attentionText(r, summary) {
  if (summary.status === "storage") return `${r.servers.length} OPTs stored`;
  if (summary.status === "no-pdu") return "No PDU reading";
  if (summary.status === "loading") return "Reading PDUs…";
  if (summary.status === "offline" || summary.status === "unavailable") return `No reading from ${r.pduData.map(p => p.name).join(", ")}`;
  const parts = [];
  if (summary.off) parts.push(`${summary.off} off`);
  if (summary.noReading) parts.push(`${summary.noReading} no reading`);
  if (summary.maintenancePdus.length) parts.push("PDU in maintenance");
  if (summary.coolingUnplaced) parts.push(`${summary.coolingUnplaced} cooling ${summary.coolingUnplaced === 1 ? "unit needs" : "units need"} a shelf`);
  return parts.length ? parts.join(" · ") : summary.total ? `All ${summary.total} on` : "No servers";
}

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "rack";

// ─── RACK DIAGRAM ─────────────────────────────────────────────────────────────
// One rack card: header (name opens the detail), figures, load bar, shelves (compacted in view mode) and the rack's
// cooling units that are not on a shelf. In the rack detail (detail) the header is plain text.
function RackDiagram({ r, rackSlots, switchAssignments, rackOrder, customItems, optOwners, onReorder, onSelect, onSelectCustom, onRenameServer, onRenameCustom, onHeaderClick, onEdit, fixed = false, external = false, externalActiveId = null, detail = false, collapsed = false, onToggleCollapse = null }) {
  const {canAdmin} = useAccounts();
  const editMode = useContext(EditContext);
  const view = useContext(RackViewContext);
  const [localActiveId, setLocalActiveId] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const { setNodeRef, isOver } = useDroppable({ id: "rack:" + r.rack, disabled: !editMode || detail });
  const strip = useDroppable({ id: `strip:${r.rack}`, disabled: !view.coolingDrop || detail });
  const built = useMemo(() => buildRackRows(r.servers, r.rack, rackOrder, rackSlots, customItems), [r.servers, r.rack, rackOrder, rackSlots, customItems]);
  const cooling = view.coolingByRack?.[r.rack];
  const coolingUs = useMemo(() => Object.keys(cooling?.placed || {}).map(Number), [cooling]);
  const rows = useMemo(() => withCoolingRows(built.rows, coolingUs), [built.rows, coolingUs]);
  const keep = view.rowKeep;
  const display = useMemo(() => compactRows(rows, { editMode, showEmpty: view.showEmpty, coolingUs: new Set(coolingUs), keep: keep ? row => keep(r.rack, row) : null }),
    [rows, editMode, view.showEmpty, coolingUs, keep, r.rack]);
  const ids = built.sorted.map(s => s.id);
  const activeId = external ? externalActiveId : localActiveId;
  const summary = view.summaryFor ? view.summaryFor(r) : rackSummary(r, {});
  const titleId = `rack-${slug(r.rack)}-title${detail ? "-detail" : ""}`;
  const shelvesId = `rack-${slug(r.rack)}-shelves${detail ? "-detail" : ""}`;
  function endDrag({ active, over }) {
    setLocalActiveId(null);
    if (!editMode || !over || active.id === over.id) return;
    const from = ids.indexOf(active.id), to = ids.indexOf(over.id);
    if (from >= 0 && to >= 0) onReorder(r.rack, arrayMove(ids, from, to));
  }
  const content = <SortableContext items={ids} strategy={verticalListSortingStrategy}>
    {display.map(entry => {
      if (entry.kind === "gap") {
        const pad = n => String(n).padStart(2, "0");
        const range = entry.from === entry.to ? pad(entry.from) : `${pad(entry.from)}–${pad(entry.to)}`;
        return <div key={`gap-${entry.from}`} className="shelf-gap" role="note" data-from={entry.from} data-to={entry.to} data-reason={entry.reason}>{range} · {entry.reason === "filtered" ? "hidden by filter" : "empty"}</div>;
      }
      const {u, items, auto} = entry.row;
      const props = {rack: r.rack, u, items, auto, switchAssignments, optOwners, onSelectServer: onSelect, onSelectCustom, onRenameServer, onRenameCustom};
      return items.some(i => i.kind === "server") ? <SortableURow key={u} {...props} isDragging={editMode && items.some(i => i.data.id === activeId)}/> : <USlotGroup key={u} {...props}/>;
    })}
    {!rows.length && <p className="text-xs text-zinc-400 py-12 text-center">No equipment stored here</p>}
  </SortableContext>;
  return <section data-rack-id={r.rack} data-status={summary.status} data-maintenance={summary.maintenancePdus.length ? "" : undefined}
    data-collapsed={collapsed ? "" : undefined} aria-labelledby={titleId} ref={external ? setNodeRef : undefined}
    className={`rack-card min-w-0 ${fixed ? "w-full lg:shrink-0 lg:max-w-[480px]" : "w-full"} ${editMode && isOver ? "ring-2 ring-nv-400/40" : ""}`}>
    <header className="rack-card-header">
      <h3 id={titleId} className="rack-card-title">{onHeaderClick
        ? <button type="button" className="rack-card-name" onClick={onHeaderClick} title={`Open ${r.rack} details`}><span dir="auto">{r.rack}</span><svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg></button>
        : <span className="rack-card-name-static">{detail ? <>Shelves · <bdi>{r.rack}</bdi></> : <bdi>{r.rack}</bdi>}</span>}</h3>
      <div className="rack-card-badges">
        {!detail && <span className={`rack-status ${summary.status}`}>{summary.statusText}</span>}
        {!detail && summary.maintenancePdus.length > 0 && <span className="maint-badge" title={`In maintenance: ${summary.maintenancePdus.join(", ")}`}>Maintenance</span>}
        {editMode && canAdmin && onEdit && <button type="button" className="icon-btn" aria-label={`Edit ${r.rack}`} title="Edit rack" onClick={onEdit}>{Icon.edit}</button>}
        {onToggleCollapse && <button type="button" className="icon-btn rack-collapse" aria-expanded={!collapsed} aria-controls={shelvesId}
          aria-label={`${collapsed ? "Show" : "Hide"} shelves of ${r.rack}`} onClick={onToggleCollapse}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>}
      </div>
    </header>
    {!detail && <RackFigures r={r} summary={summary} equipment={(customItems[r.rack] || []).length} itemsError={view.itemsError}/>}
    {!detail && <LoadBar r={r}/>}
    {collapsed && <p className="rack-attention">{attentionText(r, summary)}</p>}
    {view.itemsError && <p className="rack-note" role="note">Equipment could not load</p>}
    <div id={shelvesId} className="rack-shelves" hidden={collapsed}>{external ? content : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={e => { if (editMode) setLocalActiveId(e.active.id); }} onDragEnd={endDrag} onDragCancel={() => setLocalActiveId(null)}>{content}</DndContext>}</div>
    {!detail && !collapsed && <CoolingStrip rack={r.rack} units={cooling} canEdit={view.coolingEditable} editMode={editMode}
      onOpen={view.onOpenCooling} onAdd={view.onAddCooling} dropRef={view.coolingDrop ? strip.setNodeRef : null} isOver={strip.isOver}
      renderChip={unit => <RackCoolingChip key={unit.id} unit={unit} variant="strip"/>}/>}
  </section>;
}

// ─── ADD OPT MODAL ────────────────────────────────────────────────────────────
// Rendered OUTSIDE any DnD context (at RacksView level) — this is the fix for close not working
function AddOptModal({ rack, onClose, onSave }) {
  useEscClose(onClose);
  const [pduId, setPduId]   = useState(rack.pdus[0]?.id || "");
  const [outlet, setOutlet] = useState("");
  const [name,   setName]   = useState("");
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState("");
  const pdu = rack.pdus.find(p => p.id === pduId);

  async function submit() {
    if (!outlet || !name.trim()) return;
    setBusy(true); setError("");
    try { await onSave(pduId, parseInt(outlet, 10), name.trim(), pdu?.labels || {}); }
    catch (e) { setError("Save failed — check PDU connection."); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/85"
      onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700/60 rounded-2xl shadow-2xl w-80 overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-zinc-800/60 flex items-center justify-between">
          <span className="text-sm font-bold text-zinc-100">Add OPT — {rack.rack}</span>
          <CloseBtn onClose={onClose}/>
        </div>
        <div className="px-5 py-4 space-y-3">
          {rack.pdus.length > 1 && (
            <div><SL>PDU</SL>
              <select value={pduId} onChange={e => setPduId(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50">
                {rack.pdus.map(p => <option key={p.id} value={p.id}>{p.name} — {p.ip}</option>)}
              </select>
            </div>
          )}
          <div><SL>Outlet number</SL>
            <input type="number" min="1" max="48" value={outlet} onChange={e => setOutlet(e.target.value)}
              placeholder="1 – 48"
              className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
          </div>
          <div><SL>OPT name</SL>
            <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="e.g. Opt106"
              className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
          </div>
          {error && <div className="text-[10px] text-rose-400">{error}</div>}
        </div>
        <div className="px-5 pb-4 flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 text-sm text-zinc-500 border border-zinc-700/40 rounded-lg hover:text-zinc-300 transition">Cancel</button>
          <button onClick={submit} disabled={!outlet || !name.trim() || busy}
            className="flex-1 py-2 text-sm font-bold bg-nv-400 text-zinc-950 rounded-lg disabled:opacity-40 flex items-center justify-center gap-2 transition">
            {busy && <Spinner/>}Add OPT
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ADD EQUIPMENT MODAL ──────────────────────────────────────────────────────
function AddEquipmentModal({ rackName, onClose, onSave }) {
  useEscClose(onClose);
  const [name,  setName]  = useState("");
  const [type,  setType]  = useState("switch");
  const [u,     setU]     = useState(rackName === MAIN_STORAGE ? "0" : "");
  const [notes, setNotes] = useState("");
  const [busy,  setBusy]  = useState(false);
  const slot = parseUSlot(u);
  const uError = u.trim() !== "" && slot === null ? U_SLOT_ERROR : "";

  async function submit() {
    if (!name.trim() || slot === null || busy) return;
    setBusy(true);
    try { await onSave({ id: genId(), name: name.trim(), type, u: slot, notes: notes.trim() }); }
    catch { /* the save already told the user why */ }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/85"
      onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700/60 rounded-2xl shadow-2xl w-80 overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-zinc-800/60 flex items-center justify-between">
          <span className="text-sm font-bold text-zinc-100">Add Equipment — {rackName}</span>
          <CloseBtn onClose={onClose}/>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div><SL>Name</SL>
            <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="e.g. SW-Lab-01"
              className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
          </div>
          <div><SL>Type</SL>
            <select value={type} onChange={e => setType(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50">
              {Object.entries(ITEM_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div><SL>{rackName === MAIN_STORAGE ? "Whole storage unit" : "U slot (0 = whole rack)"}</SL>
            <input type="number" min="0" max="42" step="1" value={u} disabled={rackName === MAIN_STORAGE} onChange={e => setU(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="e.g. 7" aria-label="U slot" aria-invalid={uError ? true : undefined} aria-describedby={uError ? "add-equipment-u-error" : undefined}
              className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm focus:outline-none placeholder:text-zinc-700 ${uError ? "border-rose-700 focus:border-rose-500" : "border-zinc-700/50 focus:border-nv-400/50"}`}/>
            {uError && <div id="add-equipment-u-error" role="alert" className="mt-1 text-[11px] text-rose-400">{uError}</div>}
          </div>
          <div><SL>Notes (optional)</SL>
            <input value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="e.g. 48-port 1G managed"
              className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
          </div>
        </div>
        <div className="px-5 pb-4 flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 text-sm text-zinc-500 border border-zinc-700/40 rounded-lg hover:text-zinc-300 transition">Cancel</button>
          <button onClick={submit} disabled={!name.trim() || slot === null || busy}
            className="flex-1 py-2 text-sm font-bold bg-nv-400 text-zinc-950 rounded-lg disabled:opacity-40 flex items-center justify-center gap-2">
            {busy && <Spinner/>}Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── EDIT EQUIPMENT PANEL (custom items) ──────────────────────────────────────
// `item` is always the latest saved record. After another session changed it (a rejected save reloads the list) the
// panel is opened again on the fresh record; `draft` then refills the fields this person had changed.
function EditEquipmentPanel({ item, draft, reloaded, rackName, allRacks, owner, ownersLoaded, onOwnerChange, onClose, onSave, onDelete, onMove }) {
  useEscClose(onClose);
  const [name,      setName]      = useState(draft?.name ?? item.name);
  const [type,      setType]      = useState(draft?.type ?? (item.type || "other"));
  const [u,         setU]         = useState(String(draft?.u ?? item.u ?? 0));
  const [notes,     setNotes]     = useState(draft?.notes ?? (item.notes || ""));
  const [busy,      setBusy]      = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [moveRack,  setMoveRack]  = useState("");
  const [moving,    setMoving]    = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  // Delete is asked in the panel itself (never window.confirm), the same two steps as "Remove from DCIM".
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteCancelRef = useRef(null);
  const deleteOpenRef = useRef(null);
  useEffect(() => { if (confirmDelete) deleteCancelRef.current?.focus(); }, [confirmDelete]);
  function cancelDelete() { setConfirmDelete(false); requestAnimationFrame(() => deleteOpenRef.current?.focus()); }
  async function doDelete() {
    if (deleting) return;
    setDeleting(true);
    try { await onDelete(item); onClose(); }
    catch { /* the save already told the user why */ }
    finally { setDeleting(false); }
  }

  // Only the fields changed here are saved, so a barcode, shelf position or move saved meanwhile elsewhere is kept.
  // An old U outside 0-42 that nobody touches is left as it is.
  const storage = rackName === MAIN_STORAGE;
  const slot = parseUSlot(u);
  const uChanged = !storage && u.trim() !== String(item.u ?? 0);
  const uError = uChanged && slot === null ? U_SLOT_ERROR : "";
  const changes = {};
  if (name.trim() && name.trim() !== item.name) changes.name = name.trim();
  if (type !== (item.type || "other")) changes.type = type;
  if (uChanged && slot !== null && slot !== (item.u ?? 0)) changes.u = slot;
  if (notes.trim() !== (item.notes || "")) changes.notes = notes.trim();
  const dirty = Object.keys(changes).length > 0;

  async function submit() {
    if (busy || uError || !name.trim()) return;
    if (!dirty) { setUnchanged(true); return; }
    setBusy(true); setUnchanged(false);
    try { await onSave(item.id, changes); setSaved(true); setTimeout(()=>setSaved(false),2000); }
    catch { /* the save already told the user why */ }
    finally { setBusy(false); }
  }

  async function doMove() {
    if (!moveRack) return;
    setMoving(true);
    try { await onMove(item, moveRack); onClose(); }
    catch { /* the save already told the user why */ }
    finally { setMoving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="h-full w-[300px] bg-zinc-950 border-l border-zinc-800/80 shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800/60 bg-zinc-900/60 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-zinc-100">{item.name}</div>
            <div className="text-[10px] text-zinc-600 mt-0.5">{(ITEM_TYPES[item.type]||ITEM_TYPES.other).label} · {rackName} · U{item.u}</div>
          </div>
          <CloseBtn onClose={onClose}/>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {reloaded && <div role="status" className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            This equipment was changed in another session. The panel now shows the saved values{draft ? " with your edits kept" : ""}. Review them and save again.
          </div>}
          <div><SL>Owner / Engineer</SL><OwnerSelect owner={owner} disabled={!ownersLoaded} label={`Owner for ${item.name}`} onChange={id=>onOwnerChange(`item:${item.id}`,id)}/></div>
          <div><SL>Name</SL>
            <input value={name} onChange={e=>setName(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50"/>
          </div>
          <div><SL>Type</SL>
            <select value={type} onChange={e=>setType(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50">
              {Object.entries(ITEM_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div><SL>{rackName === MAIN_STORAGE ? "Whole storage unit" : "U slot (0 = whole rack)"}</SL>
            <input type="number" min="0" max="42" step="1" value={u} disabled={storage} onChange={e=>setU(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&submit()}
              aria-label="U slot" aria-invalid={uError ? true : undefined} aria-describedby={uError ? "edit-equipment-u-error" : undefined}
              className={`w-full bg-zinc-900 border rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none ${uError ? "border-rose-700 focus:border-rose-500" : "border-zinc-800 focus:border-nv-400/50"}`}/>
            {uError && <div id="edit-equipment-u-error" role="alert" className="mt-1 text-[11px] text-rose-400">{uError}</div>}
          </div>
          <div><SL>Notes</SL>
            <textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={2}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50 resize-none"/>
          </div>
          <div className="text-xs text-zinc-400 space-y-1">
            {item.serial_number && <div>SN: <span className="font-mono">{item.serial_number}</span></div>}
            {item.barcode && <div>Barcode: <span className="font-mono">{item.barcode}</span></div>}
            {item.shelf_position && <div>Position: {item.shelf_position}</div>}
            <div className="text-zinc-500">Use Scan & Track for barcode linking and shelf positions.</div>
          </div>
          {allRacks && allRacks.filter(r => r !== rackName).length > 0 && (
            <div><SL>Move to rack</SL>
              <div className="flex gap-2">
                <select value={moveRack} onChange={e => setMoveRack(e.target.value)}
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50">
                  <option value="">Select rack…</option>
                  {allRacks.filter(r => r !== rackName).map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <button onClick={doMove} disabled={moving || !moveRack}
                  className="px-3 py-2 text-sm font-semibold text-zinc-950 bg-nv-400 hover:bg-nv-300 rounded-lg transition disabled:opacity-40">
                  {moving ? "…" : "Move"}
                </button>
              </div>
            </div>
          )}
          <button onClick={submit} disabled={busy || !name.trim() || !!uError}
            className={`w-full py-2 text-sm font-bold rounded-lg transition flex items-center justify-center gap-2
              ${saved?"bg-emerald-900/50 text-emerald-400 border border-emerald-800/50":"bg-nv-400 text-zinc-950 disabled:opacity-40"}`}>
            {busy?<Spinner/>:saved?Icon.check:null}{saved?"Saved":"Save changes"}
          </button>
          {unchanged && !dirty && <div role="status" className="text-[11px] text-zinc-400 text-center">No changes to save.</div>}
        </div>
        <div className="px-5 py-4 border-t border-zinc-800/40">
          {confirmDelete ? <div role="group" aria-label={`Delete ${item.name} from ${rackName}`} className="space-y-2"
            onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); cancelDelete(); } }}>
            <p className="text-xs text-rose-300" dir="auto">Delete <bdi>{item.name}</bdi> from <bdi>{rackName}</bdi>? This removes it from the rack layout.</p>
            <div className="flex gap-2">
              <button ref={deleteCancelRef} type="button" onClick={cancelDelete} disabled={deleting} className="flex-1 py-2 text-xs font-medium text-zinc-300 border border-zinc-700 rounded-lg">Cancel</button>
              <button type="button" onClick={doDelete} disabled={deleting} className="equipment-delete-confirm flex-1 py-2 text-xs font-bold text-white rounded-lg">{deleting ? "Deleting…" : "Delete"}</button>
            </div>
          </div> : <button ref={deleteOpenRef} type="button" onClick={() => setConfirmDelete(true)}
            className="w-full py-2 text-xs font-medium text-rose-400 hover:text-rose-300 border border-rose-900/40 hover:border-rose-800/60 rounded-lg transition">
            Delete from rack
          </button>}
        </div>
      </div>
    </div>
  );
}

// ─── MOVE OPT SECTION (inside ServerEditPanel) ────────────────────────────────
function MoveOptSection({ server, pdu, pdus, rackDevices, onRackOverrideChange, onLabelChange, onClose }) {
  const allRacks = [...new Set((rackDevices || pdus).map(p => p.rack).filter(Boolean))].sort();
  const [targetRack,   setTargetRack]   = useState("");
  const [targetPduId,  setTargetPduId]  = useState("");
  const [targetOutlet, setTargetOutlet] = useState(server.outlet != null ? String(server.outlet) : "");
  const [moving,       setMoving]       = useState(false);
  const [err,          setErr]          = useState("");

  // Include PDUs native to target rack + PDUs shared with target rack via notes
  const rackPdus = targetRack ? pdus.filter(p =>
    p.rack === targetRack ||
    (p.notes || "").split(",").map(s => s.trim()).includes(`shared:${targetRack}`)
  ) : [];

  // Auto-select PDU if only one option
  const effectivePduId = targetPduId || (rackPdus.length === 1 ? rackPdus[0].id : "");

  async function move() {
    if (!targetRack) { setErr("Select a target rack."); return; }
    if (!effectivePduId) { setErr("Select a PDU."); return; }
    if (!targetOutlet) { setErr("Enter an outlet number."); return; }
    const tPdu = pdus.find(p => p.id === effectivePduId);
    if (!tPdu) return;
    setMoving(true); setErr("");
    try {
      if (effectivePduId !== server.pduId) {
        // Different PDU: clear old label, set new label
        if (pdu && server.outlet != null) {
          const cur = { ...pdu.labels }; delete cur[String(server.outlet)];
          await onLabelChange(server.pduId, cur);
        }
        await onLabelChange(effectivePduId, { ...tPdu.labels, [String(targetOutlet)]: server.name });
      } else if (String(targetOutlet) !== String(server.outlet)) {
        // Same PDU, different outlet
        const updated = { ...tPdu.labels };
        delete updated[String(server.outlet)];
        updated[String(targetOutlet)] = server.name;
        await onLabelChange(effectivePduId, updated);
      }
      // Always set rack override so OPT displays under target rack
      await onRackOverrideChange(server.id, targetRack);
      onClose();
    } catch (e) {
      setErr(e.detail || e.message || "Move failed.");
    } finally { setMoving(false); }
  }

  const sel = "w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50";

  return (
    <div>
      <SL>Move to rack</SL>
      <div className="space-y-2">
        <select value={targetRack} onChange={e => { setTargetRack(e.target.value); setTargetPduId(""); setErr(""); }} className={sel}>
          <option value="">Select rack…</option>
          {allRacks.filter(r => r !== server.rack).map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        {targetRack && rackPdus.length === 0 && (
          <div className="text-xs text-amber-500">No PDU found for {targetRack}.</div>
        )}
        {rackPdus.length > 1 && (
          <select value={targetPduId} onChange={e => { setTargetPduId(e.target.value); setErr(""); }} className={sel}>
            <option value="">Select PDU…</option>
            {rackPdus.map(p => <option key={p.id} value={p.id}>{p.name} ({p.ip})</option>)}
          </select>
        )}
        {effectivePduId && (
          <input type="number" min="1" max="48" value={targetOutlet}
            onChange={e => { setTargetOutlet(e.target.value); setErr(""); }}
            placeholder="Outlet number (1–48)"
            className={sel + " placeholder:text-zinc-700"}/>
        )}
        {err && <div className="text-xs text-red-400">{err}</div>}
        {targetRack && effectivePduId && (
          <button onClick={move} disabled={moving || !targetOutlet}
            className="w-full py-2 text-sm font-semibold text-zinc-950 bg-nv-400 hover:bg-nv-300 rounded-lg transition disabled:opacity-40">
            {moving ? "Moving…" : `Move to ${targetRack}`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── SERVER EDIT PANEL ────────────────────────────────────────────────────────
function ServerEditPanel({ server, pdus, rackDevices, rackSlots, switchAssignments, optOwners, ownersLoaded, onOwnerChange, onRackOverrideChange, onClose, onLabelChange, onRenameOpt, onSlotSave, onSwitchSave, powerGroup, powerPending, onRequestPower }) {
  const panelRef = useRef(null);
  useDialogFocus(panelRef, { onEscape: onClose });
  const pdu   = pdus.find(p => p.id === server.pduId);
  const curU  = (rackSlots[server.rack] || {})[server.id];
  const curSw = switchAssignments[server.id] || {};

  const [name,   setName]   = useState(server.name);
  const [outlet, setOutlet] = useState(server.outlet != null ? String(server.outlet) : "");
  const [uSlot,  setUSlot]  = useState(curU != null ? String(curU) : "");
  const [swName, setSwName] = useState(curSw.switch || "");
  const [swPort, setSwPort] = useState(curSw.port != null ? String(curSw.port) : "");
  const [doing,  setDoing]  = useState(null);
  const [saved,  setSaved]  = useState(null);
  const [error,  setError]  = useState("");

  const isOn = server.state==="on", isOff=server.state==="off";
  const led  = isOn?"bg-nv-400 shadow-[0_0_7px_#76b900]":isOff?"bg-red-700":"bg-zinc-700";
  function tick(k){setSaved(k);setTimeout(()=>setSaved(s=>s===k?null:s),2000);}
  // A failed save shows the server's reason, never the success tick, and frees the buttons again.
  async function attempt(key,action){setDoing(key);setError("");try{await action();tick(key);return true;}catch(e){setError(e.detail||e.message||"The change was not saved.");return false;}finally{setDoing(null);}}

  const feedId = `${server.pduId}:${server.outlet}`;
  async function saveName(){if(!name.trim())return;await attempt("name",async()=>{if(onRenameOpt&&name.trim()!==server.name){await onRenameOpt(server.name,name.trim());}else if(pdu&&onLabelChange){await onLabelChange(server.pduId,{...pdu.labels,[String(server.outlet)]:name.trim()});}});}
  async function saveOutlet(){const n=parseInt(outlet,10);if(isNaN(n)||n<1||!pdu||!onLabelChange)return;if(n===server.outlet)return;const updated={...pdu.labels};delete updated[String(server.outlet)];updated[String(n)]=name.trim()||server.name;await attempt("outlet",()=>onLabelChange(server.pduId,updated));}
  async function saveSlot(){const u=parseInt(uSlot,10);if(isNaN(u)||u<1)return;await attempt("slot",()=>onSlotSave(server.rack,server.id,u));}
  async function saveSw(){const value=swName.trim()||swPort?{switch:swName.trim(),port:swPort?parseInt(swPort,10):null}:null;await attempt("sw",()=>onSwitchSave(server.id,value));}
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Asked in the panel itself (never window.confirm); the second click removes.
  async function remove(){if(!pdu||!onLabelChange)return;const l={...pdu.labels};delete l[String(server.outlet)];if(await attempt("remove",()=>onLabelChange(server.pduId,l)))onClose();}

  const SetBtn=({id,onClick,disabled})=>(
    <button onClick={onClick} disabled={disabled||doing===id}
      className={`px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border flex items-center gap-1 transition
        ${saved===id?"bg-emerald-900/40 text-emerald-400 border-emerald-800/50":"bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700/50 disabled:opacity-40"}`}>
      {doing===id?<Spinner/>:saved===id?Icon.check:"Set"}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="server-edit-title" tabIndex={-1}
        className="h-full w-[320px] max-w-full bg-zinc-950 border-l border-zinc-800/80 shadow-2xl flex flex-col"
        onClick={e=>e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800/60 bg-zinc-900/60">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`w-3 h-3 rounded-full flex-shrink-0 mt-0.5 ${led}`} aria-hidden="true"/>
              <div className="min-w-0">
                <h2 id="server-edit-title" dir="auto" className="text-sm font-bold text-zinc-100 truncate">{server.name}</h2>
                <div className={`text-[11px] mt-0.5 ${isOn?"text-nv-400":isOff?"text-red-400":"text-zinc-400"}`}>
                  {server.state||"unknown"}{` · ${reading(server.watts, 0, " W")}`}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0"><SshSlot server={server} size="md"/><CloseBtn onClose={onClose}/></div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
            {[["Rack",server.rack||"—"],["Outlet",server.outlet!=null?`#${server.outlet}`:"—"],["U",curU!=null?`U${curU}`:"auto"],["PDU",pdu?.name||"—"]].map(([k,v])=>(
              <div key={k} className="flex items-baseline gap-1">
                <span className="text-[11px] text-zinc-400 w-10 flex-shrink-0">{k}</span>
                <span className="text-[11px] font-mono text-zinc-300 truncate">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {error&&<div role="alert" className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300 break-words">{error}</div>}
          {powerGroup&&onRequestPower&&server.pduId&&server.outlet!=null&&(
            <div><SL>Power control · this outlet</SL>
              <PowerActionButtons group={powerGroup} actions={["on","off","cycle"]} scope="feed" feedId={feedId} pending={powerPending}
                label={`Power ${server.name}`} onRequest={(a, el) => onRequestPower(a, el, {scope:"feed", feedId})}/>
            </div>
          )}

          <div><SL>Name</SL>
            <div className="relative">
              <input value={name} onChange={e=>setName(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&saveName()}
                onBlur={saveName}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50"/>
              {saved==="name"&&<span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-emerald-400">{Icon.check}</span>}
            </div>
          </div>

          <div><SL>PDU outlet</SL>
            <div className="relative">
              <input type="number" min="1" max="48" value={outlet} onChange={e=>setOutlet(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&saveOutlet()}
                placeholder="Outlet number"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
              {saved==="outlet"&&<span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-emerald-400">{Icon.check}</span>}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">Press Enter to move the label to this outlet</div>
          </div>

          <div><SL>Rack unit (U)</SL>
            <div className="relative">
              <input type="number" min="1" max="42" value={uSlot} onChange={e=>setUSlot(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&saveSlot()}
                onBlur={saveSlot}
                placeholder={curU!=null?`U${curU}`:"auto"}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
              {saved==="slot"&&<span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-emerald-400">{Icon.check}</span>}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">{curU!=null?`Currently U${curU}`:"Auto-assigned"}</div>
          </div>

          <div><SL>Network switch</SL>
            <div className="space-y-2">
              <input value={swName} onChange={e=>setSwName(e.target.value)} placeholder="Switch name"
                onBlur={saveSw}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-700/50 placeholder:text-zinc-700"/>
              <div className="relative">
                <input type="number" min="1" max="96" value={swPort} onChange={e=>setSwPort(e.target.value)} placeholder="Port"
                  onKeyDown={e=>e.key==="Enter"&&saveSw()}
                  onBlur={saveSw}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-700/50 placeholder:text-zinc-700"/>
                {saved==="sw"&&<span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-emerald-400">{Icon.check}</span>}
              </div>
              {curSw.switch&&<div className="text-[11px] text-cyan-300">{curSw.switch}{curSw.port?` · port ${curSw.port}`:""}</div>}
            </div>
          </div>

          <div><SL>Connection</SL>
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 divide-y divide-zinc-800/40">
              {[["Rack",server.rack||"—"],["PDU",pdu?.name||"—"],["PDU IP",pdu?.ip||"—"],["Outlet",server.outlet!=null?`#${server.outlet}`:"—"],["Switch",curSw.switch?`${curSw.switch}${curSw.port?`·${curSw.port}`:""}` :"—"]].map(([k,v])=>(
                <div key={k} className="flex items-center px-3 py-1.5 gap-3">
                  <span className="text-[11px] text-zinc-400 uppercase tracking-wide w-14 flex-shrink-0">{k}</span>
                  <span className="text-[11px] font-mono text-zinc-400 break-all">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div><SL>Owner / Engineer</SL>
            <OwnerSelect owner={optOwners?.[server.id]||""} disabled={!ownersLoaded} label={`Owner for ${server.name}`} onChange={id=>onOwnerChange(server.id,id)}/>
            {optOwners?.[server.id]&&<div className="mt-1 text-[11px] text-purple-300">{optOwners[server.id]}</div>}
          </div>

          <MoveOptSection server={server} pdu={pdu} pdus={pdus} rackDevices={rackDevices}
            onRackOverrideChange={onRackOverrideChange}
            onLabelChange={onLabelChange} onClose={onClose}/>
        </div>

        <div className="px-5 py-4 border-t border-zinc-800/40 bg-zinc-900/30">
          {confirmRemove ? <div role="group" aria-label={`Remove ${server.name} from DCIM`} className="space-y-2">
            <p className="text-xs text-rose-300" dir="auto">Remove <bdi>{server.name}</bdi> from DCIM? Its label is cleared from {pdu?.name || "the PDU"} outlet {server.outlet}; the server keeps its power.</p>
            <div className="flex gap-2">
              <button type="button" onClick={()=>setConfirmRemove(false)} className="flex-1 py-2 text-xs font-medium text-zinc-300 border border-zinc-700 rounded-lg">Cancel</button>
              <button type="button" onClick={remove} disabled={doing==="remove"} className="flex-1 py-2 text-xs font-bold text-white bg-rose-900 border border-rose-800 rounded-lg">{doing==="remove"?"Removing…":"Remove"}</button>
            </div>
          </div> : <button type="button" onClick={()=>setConfirmRemove(true)} className="w-full py-2 text-xs font-medium text-rose-400 hover:text-rose-300 border border-rose-900/40 hover:border-rose-800/60 rounded-lg transition">
            Remove from DCIM
          </button>}
        </div>
      </div>
    </div>
  );
}

// ─── RACK DETAIL VIEW ─────────────────────────────────────────────────────────
// A rack's page: heading, figures, PDUs, the shelves diagram and one table of everything in U order (servers before
// equipment on the same U, rack level last), then its cooling units. Phones get a List | Diagram switch.
// A server's shelf for display: its U when that is a whole number from 0, otherwise null (buildRackRows lists it
// at rack level).
function serverShelf(u) {
  return Number.isInteger(u) && u >= 0 ? u : null;
}
function equipmentU(item) {
  const n = typeof item.u === "string" && item.u.trim() ? Number(item.u) : item.u;
  return Number.isInteger(n) && n >= 0 && n <= 42 ? n : 0;
}
const Dash = () => <span className="racks-dash">—</span>;

function RackDetailView({ r, rackSlots, switchAssignments, rackOrder, customItems, optOwners, onBack, onReorder, onSelect, onSelectCustom, onRenameServer, onRenameCustom, onRequestAddOpt, onRequestAddEquip, onEdit, phone, detailView, onDetailView }) {
  const { rows, uMap, sorted } = useMemo(
    () => buildRackRows(r.servers, r.rack, { [r.rack]: rackOrder[r.rack] }, { [r.rack]: rackSlots[r.rack] }, customItems),
    [r.servers, r.rack, rackOrder, rackSlots, customItems]
  );
  const editMode = useContext(EditContext);
  const view = useContext(RackViewContext);
  const {canAdmin} = useAccounts();
  const summary = view.summaryFor(r);
  const slots = rackSlots[r.rack] || {};
  const equipment = customItems[r.rack] || [];
  const cooling = view.coolingByRack?.[r.rack];
  const listMode = phone && !editMode && detailView !== "diagram";
  const entries = [
    ...sorted.map(s => ({ kind: "server", u: serverShelf(uMap[s.id]), data: s })),
    ...equipment.map(item => ({ kind: "custom", u: equipmentU(item), data: item })),
  ].sort((a, b) => ((a.u || 999) - (b.u || 999)) || (a.kind === b.kind ? 0 : a.kind === "server" ? -1 : 1));
  const uText = e => {
    if (e.kind === "server") return e.u == null ? "Rack level" : `U${e.u}${slots[e.data.id] == null ? " (auto)" : ""}`;
    return e.u ? `U${e.u}` : "Rack level";
  };
  const pdus = r.pdus.filter(p => p.kind === "pdu");
  return (
    <div className="rack-detail">
      <div className="rack-detail-head">
        <nav aria-label="Breadcrumb" className="rack-detail-crumbs">
          <button type="button" onClick={onBack} className="racks-back">{Icon.back}<span>All racks</span></button>
          <span aria-hidden="true">/</span>
        </nav>
        <h2 id="rack-detail-title" tabIndex={-1} dir="auto">{r.rack}</h2>
        <span className={`rack-status ${summary.status}`}>{summary.statusText}</span>
        {summary.maintenancePdus.length > 0 && <span className="maint-badge" title={`In maintenance: ${summary.maintenancePdus.join(", ")}`}>Maintenance</span>}
        {editMode && canAdmin && <button type="button" className="racks-btn racks-btn-sm" onClick={onEdit}>{Icon.edit} Edit rack</button>}
      </div>
      <RackFigures r={r} summary={summary} equipment={equipment.length} itemsError={view.itemsError} detail/>
      <LoadBar r={r}/>
      {pdus.length > 0 && <ul className="rack-detail-pdus" aria-label="PDUs">
        {pdus.map(p => { const d = r.pduData.find(x => x.id === p.id); const st = d?.reachable === true ? "online" : d?.reachable === false ? "offline" : "unknown";
          return <li key={p.id} data-status={st}><span className="dot" aria-hidden="true"/><bdi>{p.name}</bdi> · {st === "online" ? "Online" : st === "offline" ? "Offline" : "No reading"} · <span className="racks-mono">{p.ip}</span></li>; })}
      </ul>}
      {editMode && <div className="rack-detail-actions">
        <button type="button" onClick={() => onRequestAddEquip(r.rack)} className="racks-btn">{Icon.plus} Equipment</button>
        {r.pduData.length > 0 && <button type="button" onClick={() => onRequestAddOpt(r)} className="racks-btn racks-btn-accent">{Icon.plus} OPT</button>}
        {view.coolingEditable && <button type="button" onClick={e => view.onAddCooling(r.rack, e.currentTarget)} className="racks-btn">{Icon.plus} Cooling unit</button>}
      </div>}
      {phone && !editMode && <div role="group" aria-label="Rack view" className="racks-segment">
        <button type="button" aria-pressed={listMode} onClick={() => onDetailView("list")}>List</button>
        <button type="button" aria-pressed={!listMode} onClick={() => onDetailView("diagram")}>Diagram</button>
      </div>}

      <div className="flex flex-col lg:flex-row gap-6 items-start min-w-0">
        {!listMode && <RackDiagram r={r} rackSlots={rackSlots} switchAssignments={switchAssignments}
          rackOrder={rackOrder} customItems={customItems} optOwners={optOwners}
          onReorder={onReorder} onSelect={onSelect} onSelectCustom={onSelectCustom}
          onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}
          fixed detail/>}

        {/* Right panel: full width in the phone column, so its table scrolls inside instead of widening the page */}
        <div className="w-full flex-1 min-w-0 space-y-4">
          {!phone && <div className="rack-detail-table">
            <div className="racks-table-wrap">
              <table className="racks-table">
                <caption className="sr-only">Everything in {r.rack}, by shelf</caption>
                <thead><tr>{["U","Name","Type","State","W","Owner","Outlet","Switch","Notes","Actions"].map(h => <th key={h} scope="col" className={h === "W" || h === "Outlet" ? "num" : undefined}>{h}</th>)}</tr></thead>
                <tbody>
                  {entries.map(e => {
                    if (e.kind === "server") {
                      const s = e.data, sw = switchAssignments[s.id], visual = view.visualFor(s), owner = optOwners?.[s.id];
                      return <tr key={`s:${s.id}`} data-server={s.name} data-state={visual.state} data-match={view.matchKeys?.has(`s:${s.id}`) ? "" : undefined}>
                        <td className={`racks-mono ${slots[s.id] == null ? "italic" : ""}`} title={slots[s.id] == null ? "Auto-placed — no saved U for this OPT" : undefined}>{uText(e)}</td>
                        <td><button type="button" className="server-open" aria-label={`View ${s.name}`} onClick={() => onSelect(s)}><span dir="auto" className="server-name">{s.name}</span></button></td>
                        <td>OPT</td>
                        <td><span className="server-state" data-state={visual.state} title={visual.title}>{visual.word}</span>{visual.maintenance && <> <span className="maint-badge">Maintenance</span></>}</td>
                        <td className="num racks-mono">{(visual.state === "on" || visual.state === "off") && Number.isFinite(s.watts) ? s.watts.toFixed(0) : <Dash/>}</td>
                        <td dir="auto">{owner || <Dash/>}</td>
                        <td className="num racks-mono">{s.outlet != null ? `#${s.outlet}` : <Dash/>}</td>
                        <td dir="auto">{sw?.switch ? `${sw.switch}${sw.port ? `:${sw.port}` : ""}` : <Dash/>}</td>
                        <td><Dash/></td>
                        <td><div className="server-actions">{!editMode && <RowPower server={s}/>}<KvmButton server={s} compact/><SshSlot server={s} size="sm"/></div></td>
                      </tr>;
                    }
                    const item = e.data, meta = ITEM_TYPES[item.type] || ITEM_TYPES.other, owner = optOwners?.[`item:${item.id}`];
                    return <tr key={`e:${item.id}`} data-item-id={item.id} data-match={view.matchKeys?.has(`e:${item.id}`) ? "" : undefined}>
                      <td className="racks-mono">{uText(e)}</td>
                      <td><button type="button" className="server-open" aria-label={`View ${item.name}`} onClick={() => onSelectCustom(item)}><span dir="auto" className="server-name">{item.name}</span></button></td>
                      <td>{meta.label}</td>
                      <td><Dash/></td><td className="num"><Dash/></td>
                      <td dir="auto">{owner || <Dash/>}</td>
                      <td className="num"><Dash/></td><td><Dash/></td>
                      <td dir="auto">{item.notes || <Dash/>}</td>
                      <td/>
                    </tr>;
                  })}
                  {!entries.length && <tr><td colSpan={10} className="racks-muted">No equipment in this rack.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>}
          {listMode && <ul className="detail-list" aria-label={`Servers and equipment in ${r.rack}`}>
            {entries.map(e => {
              if (e.kind === "server") {
                const s = e.data, sw = switchAssignments[s.id], visual = view.visualFor(s), owner = optOwners?.[s.id];
                const facts = [uText(e), (visual.state === "on" || visual.state === "off") && Number.isFinite(s.watts) ? `${s.watts.toFixed(0)} W` : null, owner, sw?.switch ? `${sw.switch}${sw.port ? `:${sw.port}` : ""}` : null].filter(Boolean);
                return <li key={`s:${s.id}`} className="detail-item" data-server={s.name} data-state={visual.state} data-maintenance={visual.maintenance ? "" : undefined}>
                  <div className="detail-item-head"><span className="server-led" aria-hidden="true"/>
                    <button type="button" className="server-open" aria-label={`View ${s.name}`} onClick={() => onSelect(s)}><span dir="auto" className="server-name">{s.name}</span></button>
                    <span className="server-state" data-state={visual.state} title={visual.title}>{visual.word}</span>
                    {visual.maintenance && <span className="maint-badge">Maintenance</span>}</div>
                  <div className="detail-item-facts" dir="auto">{facts.join(" · ")}</div>
                  <div className="server-actions">{!editMode && <RowPower server={s}/>}<KvmButton server={s}/><SshSlot server={s} size="sm"/></div>
                </li>;
              }
              const item = e.data, meta = ITEM_TYPES[item.type] || ITEM_TYPES.other;
              return <li key={`e:${item.id}`} className="detail-item" data-item-id={item.id}>
                <div className="detail-item-head"><span className="detail-item-type">{meta.label}</span>
                  <button type="button" className="server-open" aria-label={`View ${item.name}`} onClick={() => onSelectCustom(item)}><span dir="auto" className="server-name">{item.name}</span></button></div>
                <div className="detail-item-facts" dir="auto">{[uText(e), item.notes].filter(Boolean).join(" · ")}</div>
              </li>;
            })}
            {!entries.length && <li className="racks-muted">No equipment in this rack.</li>}
          </ul>}
          <section className="rack-detail-cooling" aria-labelledby="rack-detail-cooling-title">
            <h3 id="rack-detail-cooling-title">Cooling units in <bdi>{r.rack}</bdi></h3>
            <CoolingStrip list rack={r.rack} units={cooling} canEdit={editMode ? view.coolingEditable : !!view.onPlaceCooling}
              canAdd={editMode && view.coolingEditable} editMode={editMode}
              onOpen={!editMode && view.onPlaceCooling ? view.onPlaceCooling : view.onOpenCooling} onAdd={view.onAddCooling}/>
          </section>
        </div>
      </div>
    </div>
  );
}

// ─── ADD RACK MODAL ───────────────────────────────────────────────────────────
const inputCls = "w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700";

function AddRackModal({ onClose, onSave }) {
  const [rackName,  setRackName]  = useState("");
  const [rackType,  setRackType]  = useState("Compute");
  const [pduName,   setPduName]   = useState("");
  const [pduIp,     setPduIp]     = useState("");
  const [pduUser,   setPduUser]   = useState("");
  const [pduPass,   setPduPass]   = useState("");
  const [saving,    setSaving]    = useState(false);
  const [err,       setErr]       = useState("");
  useEscClose(onClose);

  async function handleSave() {
    if (!rackName.trim()) { setErr("Rack name is required."); return; }
    setSaving(true); setErr("");
    try {
      const res = await fetch("/api/devices/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:     pduName.trim() || `${rackType}-${rackName.trim()}`,
          kind:     "rack",          // Inventory only; Storage also appears on Dashboard.
          model:    rackType,        // "Compute" or "Storage"
          ip:       pduIp.trim()   || "0.0.0.0",
          rack:     rackName.trim(),
          username: pduUser.trim(),
          password: pduPass,
        }),
      });
      if (!res.ok) { const t = await res.text(); throw new Error(t || res.status); }
      await onSave();
      onClose();
    } catch (e) {
      setErr(e.message || "Failed to add rack.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-950 border border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/50">
          <span className="text-sm font-bold text-zinc-100">Add Rack</span>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition">{Icon.x}</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1">Rack name <span className="text-nv-400">*</span></div>
            <input autoFocus value={rackName} onChange={e => setRackName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSave()}
              placeholder="e.g. Rack-08" className={inputCls}/>
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-2">Rack type</div>
            <div className="grid grid-cols-2 gap-2">
              {["Compute", "Storage"].map(t => (
                <button key={t} onClick={() => setRackType(t)}
                  className={`py-2 text-sm font-semibold rounded-xl border transition
                    ${rackType === t
                      ? t === "Storage"
                        ? "bg-cyan-900/40 border-cyan-600/60 text-cyan-300"
                        : "bg-nv-400/15 border-nv-400/60 text-nv-400"
                      : "border-zinc-800 text-zinc-600 hover:border-zinc-600 hover:text-zinc-400"}`}>
                  {t === "Compute" ? "⚡ Compute" : "💾 Storage"}
                </button>
              ))}
            </div>
          </div>
          <div className="pt-1 border-t border-zinc-800/40">
            <div className="text-[10px] text-zinc-700 mb-2">PDU — optional</div>
            <div className="space-y-2">
              <input value={pduName} onChange={e => setPduName(e.target.value)}
                placeholder="PDU name" className={inputCls}/>
              <input value={pduIp} onChange={e => setPduIp(e.target.value)}
                placeholder="PDU IP" className={inputCls}/>
              <div className="grid grid-cols-2 gap-2">
                <input value={pduUser} onChange={e => setPduUser(e.target.value)}
                  placeholder="Username" className={inputCls}/>
                <input type="password" value={pduPass} onChange={e => setPduPass(e.target.value)}
                  placeholder="Password" className={inputCls}/>
              </div>
            </div>
          </div>
          {err && <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2">{err}</div>}
        </div>
        <div className="flex gap-2 px-5 pb-4">
          <button onClick={onClose} className="flex-1 py-2 text-sm text-zinc-400 border border-zinc-800 hover:border-zinc-600 rounded-xl transition">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2 text-sm font-semibold text-zinc-950 bg-nv-400 hover:bg-nv-300 rounded-xl transition disabled:opacity-50">
            {saving ? "Adding…" : "Add Rack"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── EDIT RACK MODAL ──────────────────────────────────────────────────────────
function EditRackModal({ rackName, rackType, rackDevs, onClose, onSave }) {
  useEscClose(onClose);
  const pdus = rackDevs.filter(d => d.kind === "pdu");

  const [name,       setName]       = useState(rackName);
  const [type,       setType]       = useState(rackType === "storage" ? "Storage" : "Compute");
  // pduEdits: { [id]: { name, ip, username, password } }
  const [pduEdits,   setPduEdits]   = useState(() =>
    Object.fromEntries(pdus.map(p => [p.id, { name: p.name, ip: p.ip, username: "", password: "" }]))
  );
  // new PDU fields (only used when rack has no PDU yet)
  const [newPdu, setNewPdu] = useState({ name: "", ip: "", username: "", password: "" });
  const [saving,     setSaving]     = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err,        setErr]        = useState("");

  function setPduField(id, field, val) {
    setPduEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: val } }));
  }

  async function handleSave() {
    if (!name.trim()) { setErr("Rack name is required."); return; }
    setSaving(true); setErr("");
    try {
      // Update existing devices
      await Promise.all(rackDevs.map(d => {
        const e = pduEdits[d.id];
        const body = {
          ...d,
          rack:  name.trim(),
          model: d.kind === "rack" ? type : d.model,
          ...(e ? { name: e.name.trim() || d.name, ip: e.ip.trim() || d.ip } : {}),
          ...(e?.username ? { username: e.username } : {}),
          ...(e?.password ? { password: e.password } : {}),
        };
        return fetch(`/api/devices/${d.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then(r => { if (!r.ok) throw new Error(`Failed to update ${d.name}`); });
      }));
      // Create new PDU if fields filled (rack has no PDU yet)
      if (pdus.length === 0 && newPdu.ip.trim()) {
        const res = await fetch("/api/devices/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name:     newPdu.name.trim() || `PDU-${name.trim()}`,
            kind:     "pdu",
            model:    "Raritan PDU",
            ip:       newPdu.ip.trim(),
            rack:     name.trim(),
            username: newPdu.username || "",
            password: newPdu.password || "",
          }),
        });
        if (!res.ok) throw new Error("Failed to create PDU.");
      }
      await onSave();
      onClose();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    setDeleting(true); setErr("");
    try {
      await Promise.all(rackDevs.map(d =>
        fetch(`/api/devices/${d.id}`, { method: "DELETE" })
          .then(r => { if (!r.ok) throw new Error(`Failed to delete ${d.name}`); })
      ));
      await onSave();
      onClose();
    } catch (e) {
      setErr(e.message || "Delete failed.");
    } finally { setDeleting(false); setConfirmDel(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-950 border border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/50 sticky top-0 bg-zinc-950 z-10">
          <span className="text-sm font-bold text-zinc-100">Edit Rack — {rackName}</span>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition">{Icon.x}</button>
        </div>

        {/* Rack fields */}
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-1 block">Rack Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="e.g. Rack-09"
              onKeyDown={e => e.key === "Enter" && handleSave()}/>
          </div>
          <div>
            <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-1.5 block">Type</label>
            <div className="flex gap-2">
              {["Compute", "Storage"].map(t => (
                <button key={t} onClick={() => setType(t)}
                  className={`flex-1 py-2 text-sm rounded-xl border transition ${type === t
                    ? (t === "Storage" ? "border-cyan-500/60 text-cyan-400 bg-cyan-950/30" : "border-nv-400/60 text-nv-400 bg-nv-400/10")
                    : "border-zinc-800 text-zinc-500 hover:border-zinc-600"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* PDU section — add PDU when none exists */}
        {pdus.length === 0 && (
          <div className="border-t border-zinc-800/50 px-5 py-4 space-y-3">
            <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Add PDU <span className="text-zinc-700 normal-case tracking-normal">(optional)</span></div>
            <div>
              <label className="text-[10px] text-zinc-600 mb-1 block">PDU Name</label>
              <input value={newPdu.name} onChange={e => setNewPdu(p => ({ ...p, name: e.target.value }))} className={inputCls} placeholder={`PDU-${name || rackName}`}/>
            </div>
            <div>
              <label className="text-[10px] text-zinc-600 mb-1 block">IP Address</label>
              <input value={newPdu.ip} onChange={e => setNewPdu(p => ({ ...p, ip: e.target.value }))} className={inputCls} placeholder="e.g. 10.7.30.200"/>
            </div>
            <div>
              <label className="text-[10px] text-zinc-600 mb-1 block">Username <span className="text-zinc-700">(optional)</span></label>
              <input value={newPdu.username} onChange={e => setNewPdu(p => ({ ...p, username: e.target.value }))} className={inputCls} placeholder="ftlab" autoComplete="off"/>
            </div>
            <div>
              <label className="text-[10px] text-zinc-600 mb-1 block">Password <span className="text-zinc-700">(optional)</span></label>
              <input type="password" value={newPdu.password} onChange={e => setNewPdu(p => ({ ...p, password: e.target.value }))} className={inputCls} placeholder="optional" autoComplete="new-password"/>
            </div>
          </div>
        )}

        {/* PDU section — edit existing PDUs */}
        {pdus.length > 0 && (
          <div className="border-t border-zinc-800/50">
            {pdus.map((p, i) => {
              const e = pduEdits[p.id] || {};
              return (
                <div key={p.id} className="px-5 py-4 space-y-3">
                  <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
                    PDU{pdus.length > 1 ? ` ${i + 1}` : ""}
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 mb-1 block">Name</label>
                    <input value={e.name} onChange={ev => setPduField(p.id, "name", ev.target.value)} className={inputCls} placeholder={p.name}/>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 mb-1 block">IP Address</label>
                    <input value={e.ip} onChange={ev => setPduField(p.id, "ip", ev.target.value)} className={inputCls} placeholder={p.ip}/>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 mb-1 block">Username <span className="text-zinc-700">(leave blank to keep current)</span></label>
                    <input value={e.username} onChange={ev => setPduField(p.id, "username", ev.target.value)} className={inputCls} placeholder="unchanged" autoComplete="off"/>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 mb-1 block">Password <span className="text-zinc-700">(leave blank to keep current)</span></label>
                    <input type="password" value={e.password} onChange={ev => setPduField(p.id, "password", ev.target.value)} className={inputCls} placeholder="unchanged" autoComplete="new-password"/>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {err && <div className="px-5 pb-2 text-xs text-red-400">{err}</div>}

        {/* Delete */}
        <div className="px-5 pb-2">
          {!confirmDel ? (
            <button onClick={() => setConfirmDel(true)}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-red-500 border border-red-900/40 hover:border-red-700/60 hover:bg-red-950/20 rounded-xl transition">
              {Icon.trash} Delete Rack
            </button>
          ) : (
            <div className="bg-red-950/20 border border-red-900/50 rounded-xl p-3 space-y-2">
              <div className="text-xs text-red-400">
                {pdus.length
                  ? `This will permanently delete ${rackDevs.length} device(s) including PDU(s). Cannot be undone.`
                  : "Delete this rack permanently? Cannot be undone."}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setConfirmDel(false)} className="flex-1 py-1.5 text-xs text-zinc-400 border border-zinc-800 hover:border-zinc-600 rounded-lg transition">Cancel</button>
                <button onClick={handleDelete} disabled={deleting}
                  className="flex-1 py-1.5 text-xs font-semibold text-white bg-red-700 hover:bg-red-600 rounded-lg transition disabled:opacity-50">
                  {deleting ? "Deleting…" : "Confirm Delete"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 px-5 py-4">
          <button onClick={onClose} className="flex-1 py-2 text-sm text-zinc-400 border border-zinc-800 hover:border-zinc-600 rounded-xl transition">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2 text-sm font-semibold text-zinc-950 bg-nv-400 hover:bg-nv-300 rounded-xl transition disabled:opacity-50">
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── CROSS-RACK MOVE MODAL ────────────────────────────────────────────────────
function CrossRackMoveModal({ server, targetRackStat, pdus, onLabelChange, onClose }) {
  useEscClose(onClose);
  const rackPdus = targetRackStat.pdus;
  const [pduId, setPduId] = useState(rackPdus[0]?.id || "");
  const [outlet, setOutlet] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function doMove() {
    if (!pduId || !outlet) { setErr("Select PDU and outlet."); return; }
    const srcPdu = pdus.find(p => p.id === server.pduId);
    const tgtPdu = pdus.find(p => p.id === pduId);
    if (!tgtPdu) return;
    setSaving(true); setErr("");
    try {
      if (srcPdu && server.outlet != null) {
        const cur = { ...srcPdu.labels }; delete cur[String(server.outlet)];
        await onLabelChange(server.pduId, cur);
      }
      await onLabelChange(pduId, { ...tgtPdu.labels, [String(outlet)]: server.name });
      onClose();
    } catch (e) {
      setErr(e.message || "Move failed.");
    } finally {
      setSaving(false);
    }
  }

  const sel = "w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-950 border border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-xs" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/50">
          <span className="text-sm font-bold text-zinc-100">Move to {targetRackStat.rack}</span>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition">{Icon.x}</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="text-xs text-zinc-500">Moving <span className="text-zinc-200 font-mono">{server.name}</span> from <span className="text-zinc-400">{server.rack}</span></div>
          {rackPdus.length > 1 && (
            <select value={pduId} onChange={e => setPduId(e.target.value)} className={sel}>
              {rackPdus.map(p => <option key={p.id} value={p.id}>{p.name} ({p.ip})</option>)}
            </select>
          )}
          {rackPdus.length === 1 && <div className="text-xs text-zinc-600 font-mono">{rackPdus[0].name} · {rackPdus[0].ip}</div>}
          {rackPdus.length === 0 && <div className="text-xs text-amber-600">This rack has no PDU attached.</div>}
          <input type="number" min="1" max="48" value={outlet} onChange={e => setOutlet(e.target.value)}
            placeholder="Outlet number (1–48)" className={sel + " placeholder:text-zinc-700"}
            onKeyDown={e => e.key === "Enter" && doMove()}/>
          {err && <div className="text-xs text-red-400">{err}</div>}
        </div>
        <div className="flex gap-2 px-5 pb-4">
          <button onClick={onClose} className="flex-1 py-2 text-sm text-zinc-400 border border-zinc-800 hover:border-zinc-600 rounded-xl transition">Cancel</button>
          <button onClick={doMove} disabled={saving || !outlet || rackPdus.length === 0}
            className="flex-1 py-2 text-sm font-semibold text-zinc-950 bg-nv-400 hover:bg-nv-300 rounded-xl transition disabled:opacity-40">
            {saving ? "Moving…" : "Move"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RACKS VIEW ───────────────────────────────────────────────────────────────
// The overview (summary, find / filter / jump toolbar, cooling units panel, rack cards) or one rack's detail.
// base: visualFor, summaryFor, maintenance, itemsError from DcimView; cooling: the cooling units and their actions.
function RacksView({ selectedRack: rackProp, onSelectRack, rackStats, rackSlots, rackOrder, switchAssignments, customItems, onReorder, onSelect, onSelectCustom, onLabelChange, onSlotsChange, onRenameServer, onRenameCustom, onSaveItems, onRefresh, pdus, rackDevices, optOwners, pduStatuses, base, cooling }) {
  const {canAdmin} = useAccounts();
  // With onSelectRack the App owns the open rack (?rack= in the address, so Back and Forward work);
  // without it the open rack is local state that starts from ?rack=, as before.
  const [localRack,      setLocalRack]      = useState(() => onSelectRack ? null : new URLSearchParams(location.search).get("rack"));
  const selectedRack    = onSelectRack ? (rackProp || null) : localRack;
  const setSelectedRack = onSelectRack || setLocalRack;
  const [addOptFor,      setAddOptFor]      = useState(null);
  const [addEquipFor,    setAddEquipFor]    = useState(null);
  const [addRackOpen,    setAddRackOpen]    = useState(false);
  const [editRackTarget, setEditRackTarget] = useState(null); // rack name string
  const [activeId,       setActiveId]       = useState(null);
  const [coolingActive,  setCoolingActive]  = useState(null);
  const [pendingMove,    setPendingMove]    = useState(null);
  const editMode = useContext(EditContext);
  const phone = useMediaQuery("(max-width: 640px)");
  const { visualFor, summaryFor } = base;

  // ── find, filter, empty shelves, collapsed cards (the last two and the panel are remembered per viewer) ──
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQ(query), 150); return () => clearTimeout(timer); }, [query]);
  const [filter, setFilter] = useState("all");
  const [showEmpty, setShowEmpty] = useStoredState("dcim.racks.showEmpty", false);
  const [storedCollapsed, setStoredCollapsed] = useStoredState("dcim.racks.collapsed", null);
  const [detailView, setDetailView] = useStoredState("dcim.racks.detailView", "list");
  const [panelPref, setPanelPref] = useStoredState("dcim.racks.coolingPanel", null);
  const [panelOpen, setPanelOpen] = useState(panelPref === "open");
  // Phones: the panel starts folded to its header (also when it opens by itself); opening it on purpose unfolds it.
  const [panelExpanded, setPanelExpanded] = useState(!phone);
  const searchRef = useRef(null);
  const matchAt = useRef(-1);

  // A saved U that is not a whole number has no shelf to jump to: search gets null for it.
  const uMaps = useMemo(() => Object.fromEntries(rackStats.map(rs => {
    const { uMap } = buildRackRows(rs.servers, rs.rack, rackOrder, rackSlots, customItems);
    return [rs.rack, Object.fromEntries(Object.entries(uMap).map(([id, u]) => [id, serverShelf(u)]))];
  })), [rackStats, rackOrder, rackSlots, customItems]);
  const index = useMemo(() => buildSearchIndex({ rackStats, optOwners, switchAssignments, customItems, coolingUnits: cooling.units, uMaps }),
    [rackStats, optOwners, switchAssignments, customItems, cooling.units, uMaps]);
  const search = useMemo(() => searchIndex(index, q), [index, q]);
  useEffect(() => { matchAt.current = -1; }, [search]);
  const searching = !!search.query;
  const filtering = filter !== "all" && !editMode;
  const hiding = !editMode && (searching || filtering);
  const coolingAt = useCallback((rack, u) => cooling.groups.byRack[rack]?.placed?.[u] || [], [cooling.groups]);
  const serverPasses = useCallback(s => (!filtering || matchesFilter(visualFor(s), filter)) && (!searching || search.keys.has(`s:${s.id}`)),
    [filtering, filter, searching, search, visualFor]);
  // A row stays when one of its servers passes; with a search (and no filter) equipment and cooling hits count too.
  const rowKeep = useMemo(() => !hiding ? null : (rack, row) => {
    if (row.items.some(i => i.kind === "server" && serverPasses(i.data))) return true;
    if (filtering || !searching) return false;
    return row.items.some(i => i.kind === "custom" && search.keys.has(`e:${i.data.id}`)) || coolingAt(rack, row.u).some(c => search.keys.has(`c:${c.id}`));
  }, [hiding, filtering, searching, search, serverPasses, coolingAt]);
  const rackPasses = useCallback(rs => {
    if (!hiding) return true;
    if (rs.servers.some(serverPasses)) return true;
    if (filtering) return false;
    return (search.racks.get(rs.rack) || 0) > 0;
  }, [hiding, filtering, serverPasses, search]);
  const visibleRacks = rackStats.filter(rackPasses);
  const allServers = useMemo(() => rackStats.flatMap(rs => rs.servers), [rackStats]);
  const filterCounts = useMemo(() => {
    const counts = { all: allServers.length, off: 0, "no-reading": 0, maintenance: 0 };
    allServers.forEach(s => { const v = visualFor(s); ["off", "no-reading", "maintenance"].forEach(f => { if (matchesFilter(v, f)) counts[f]++; }); });
    return counts;
  }, [allServers, visualFor]);

  // Phones start with collapsed cards; what the viewer opens or closes is remembered. A search or filter opens the
  // racks it shows without changing what is remembered.
  const allNames = useMemo(() => rackStats.map(rs => rs.rack), [rackStats]);
  const collapsedSet = useMemo(() => new Set(storedCollapsed ?? (phone ? allNames : [])), [storedCollapsed, phone, allNames]);
  const isCollapsed = rack => collapsedSet.has(rack) && !hiding;
  const toggleCollapse = rack => setStoredCollapsed(prev => {
    const set = new Set(prev ?? (phone ? allNames : []));
    if (set.has(rack)) set.delete(rack); else set.add(rack);
    return [...set];
  });
  const allCollapsed = allNames.length > 0 && allNames.every(n => collapsedSet.has(n));
  const toggleAll = () => setStoredCollapsed(allCollapsed ? [] : allNames);

  const focusRackCard = useCallback((rack, { flashIt = true, smooth = true } = {}) => {
    requestAnimationFrame(() => {
      const card = document.querySelector(`[data-rack-id="${window.CSS.escape(rack)}"]`);
      if (!card) return;
      card.scrollIntoView({ block: "start", behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
      card.querySelector(".rack-card-name")?.focus({ preventScroll: true });
      if (flashIt) flash(card);
    });
  }, []);
  function jumpTo(rack) {
    if (hiding && !visibleRacks.some(rs => rs.rack === rack)) { setQuery(""); setQ(""); setFilter("all"); }
    setStoredCollapsed(prev => {
      if (prev == null && !phone) return prev;
      const set = new Set(prev ?? allNames); set.delete(rack); return [...set];
    });
    focusRackCard(rack);
  }
  function applyFilter(next) {
    setFilter(next);
    requestAnimationFrame(() => document.querySelector(".racks-toolbar")?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" }));
  }
  function clearFind() { setQuery(""); setQ(""); setFilter("all"); searchRef.current?.focus(); }

  // Enter: the next match (Shift+Enter: the previous one); Escape clears the search.
  function focusEntry(entry) {
    const id = window.CSS.escape(entry.key.slice(2));
    let el = entry.kind === "server" ? document.querySelector(`.server-cell[data-server-id="${id}"] button.server-open`)
      : entry.kind === "equipment" ? document.querySelector(`.equipment-cell[data-item-id="${id}"]`)
      : document.querySelector(`[data-rack-id] .cooling-chip[data-unit-id="${id}"]`);
    if (!el && entry.kind === "cooling") {
      setPanelOpen(true); setPanelExpanded(true);
      requestAnimationFrame(() => { const row = document.querySelector(`#cooling-panel li[data-unit-id="${id}"] button`); row?.scrollIntoView({ block: "center" }); row?.focus({ preventScroll: true }); flash(row?.closest("li")); });
      return;
    }
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
    flash(el.closest(".server-cell") || el);
  }
  function onSearchKey(e) {
    if (e.key === "Escape") { if (query) { e.preventDefault(); e.stopPropagation(); setQuery(""); setQ(""); } return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const list = searchIndex(index, query).ordered;
    if (!list.length) return;
    setQ(query);
    matchAt.current = (matchAt.current + (e.shiftKey ? -1 : 1) + list.length) % list.length;
    const entry = list[matchAt.current];
    requestAnimationFrame(() => requestAnimationFrame(() => focusEntry(entry)));
  }
  // "/" focuses the search box (not while typing somewhere or in a dialog).
  useEffect(() => {
    if (selectedRack) return undefined;
    const onKey = e => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='alertdialog']")) return;
      e.preventDefault(); searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedRack]);

  // ── cooling units panel: opens by itself once when a unit needs a rack, unless this viewer closed it before ──
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !cooling.loaded) return;
    autoOpened.current = true;
    if (cooling.groups.unassigned.length > 0 && panelPref !== "closed") setPanelOpen(true);
  }, [cooling.loaded, cooling.groups, panelPref]);
  const looseCoolingHit = searching && cooling.groups.unassigned.some(({ unit }) => search.keys.has(`c:${unit.id}`));
  // With a search the panel lists only the units it matches, and is hidden when it matches none.
  const coolingHits = searching ? cooling.units.filter(u => search.keys.has(`c:${u.id}`)).length : null;
  const showPanel = (panelOpen || looseCoolingHit) && (!searching || coolingHits > 0);
  function toggleCooling(open = !showPanel) {
    setPanelOpen(open); setPanelPref(open ? "open" : "closed");
    if (open) setPanelExpanded(true);
    if (open) requestAnimationFrame(() => { const panel = document.getElementById("cooling-panel"); panel?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" }); panel?.querySelector("h2")?.focus({ preventScroll: true }); });
  }
  const coolingTotal = cooling.units.length;
  const coolingNeeds = cooling.groups.unassigned.length;

  // ── opening a rack: the page starts at its heading; back: its card again ──
  const prevRack = useRef(selectedRack);
  useEffect(() => {
    const prev = prevRack.current;
    prevRack.current = selectedRack;
    if (prev === selectedRack) return;
    if (selectedRack) requestAnimationFrame(() => { window.scrollTo({ top: 0 }); document.getElementById("rack-detail-title")?.focus({ preventScroll: true }); });
    else if (prev) focusRackCard(prev, { flashIt: false, smooth: false });
  }, [selectedRack, focusRackCard]);

  const r = selectedRack ? rackStats.find(r => r.rack === selectedRack) : null;

  const serverRackMap = useMemo(() => {
    const m = {};
    rackStats.forEach(rs => rs.servers.forEach(s => { m[s.id] = rs.rack; }));
    return m;
  }, [rackStats]);

  const crossSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const activeServer = activeId ? rackStats.flatMap(rs => rs.servers).find(s => s.id === activeId) : null;
  // A cooling drag only sees shelves and "not on a shelf" strips; a server drag never sees them.
  const collision = useCallback(args => {
    const isCooling = String(args.active?.id).startsWith("cooling:");
    const droppableContainers = args.droppableContainers.filter(c => {
      const id = String(c.id);
      const target = id.startsWith("shelf:") || id.startsWith("strip:");
      return isCooling ? target : !target;
    });
    return isCooling ? pointerWithin({ ...args, droppableContainers }) : closestCenter({ ...args, droppableContainers });
  }, []);

  function handleCrossRackDragEnd({ active, over }) {
    setActiveId(null);
    if (!editMode || !active || !over || active.id === over.id) return;
    const sourceRack = serverRackMap[active.id];
    const targetRack = over.id.startsWith("rack:") ? over.id.slice(5) : serverRackMap[over.id];
    if (!sourceRack || !targetRack) return;
    if (sourceRack === targetRack) {
      // Sort by visual rackOrder (same logic as buildRackRows) to avoid mix-ups
      const sourceStat = rackStats.find(rs => rs.rack === sourceRack);
      const order = rackOrder[sourceRack] || [];
      const ids = [...(sourceStat?.servers || [])].sort((a, b) => {
        const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
        if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
        if (ai === -1) return 1; if (bi === -1) return -1;
        return ai - bi;
      }).map(s => s.id);
      const oldIdx = ids.indexOf(active.id);
      const newIdx = ids.indexOf(over.id);
      if (oldIdx !== -1 && newIdx !== -1) onReorder(sourceRack, arrayMove(ids, oldIdx, newIdx));
    } else {
      const server = rackStats.flatMap(rs => rs.servers).find(s => s.id === active.id);
      const targetRackStat = rackStats.find(rs => rs.rack === targetRack);
      if (server && targetRackStat) setPendingMove({ server, targetRackStat });
    }
  }
  function handleDragStart(e) {
    if (!editMode) return;
    if (String(e.active.id).startsWith("cooling:")) setCoolingActive(e.active.data.current?.unit || null);
    else setActiveId(e.active.id);
  }
  function handleDragEnd(e) {
    const id = String(e.active?.id || "");
    if (!id.startsWith("cooling:")) { handleCrossRackDragEnd(e); return; }
    setCoolingActive(null);
    const over = e.over?.id != null ? String(e.over.id) : null;
    if (!editMode || !over) return;
    let rack, u = null;
    if (over.startsWith("shelf:")) { const rest = over.slice(6), at = rest.lastIndexOf(":"); rack = rest.slice(0, at); u = Number(rest.slice(at + 1)); }
    else if (over.startsWith("strip:")) rack = over.slice(6);
    else return;
    cooling.place(id.slice(8), rack, u);
  }

  async function handleSaveOpt(pduId, outlet, name, existing) {
    try { await onLabelChange(pduId, { ...existing, [String(outlet)]: name }); }
    finally { setAddOptFor(null); }
  }

  async function handleSaveEquip(rackName, item) {
    await onSaveItems({ ...customItems, [rackName]: [...(customItems[rackName]||[]), item] });
    setAddEquipFor(null);
  }

  // ── summary tiles ──
  const kpis = useMemo(() => {
    const unique = [...new Map(rackStats.flatMap(rs => rs.pduData).map(p => [p.id, p])).values()];
    const loading = unique.some(p => pduStatuses[p.id] === undefined);
    const online = unique.filter(p => p.reachable);
    const totalW = sumKnown(online.map(p => p.watts));
    const totalA = sumKnown(online.map(p => p.amps));
    let on = 0, off = 0, noReading = 0;
    allServers.forEach(s => { const v = visualFor(s).state; if (v === "on") on++; else if (v === "off") off++; else if (v === "unknown" || v === "unreachable") noReading++; });
    const summaries = rackStats.map(rs => summaryFor(rs));
    const offlinePdus = unique.filter(p => ["offline", "unavailable"].includes(deviceState(pduStatuses[p.id]))).length;
    const maintPdus = unique.filter(p => maintenanceFor(base.maintenance, p.id)).length;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const attention = [
      offlinePdus && { key: "pdu-offline", count: offlinePdus, label: `${plural(offlinePdus, "PDU", "PDUs")} offline`, onClick: editMode ? null : () => applyFilter("no-reading") },
      off && { key: "servers-off", count: off, label: `${plural(off, "server", "servers")} off`, onClick: editMode ? null : () => applyFilter("off") },
      maintPdus && { key: "maintenance", count: maintPdus, label: `${plural(maintPdus, "PDU", "PDUs")} in maintenance`, onClick: editMode ? null : () => applyFilter("maintenance") },
      coolingNeeds && { key: "cooling", count: coolingNeeds, label: `${plural(coolingNeeds, "cooling unit needs", "cooling units need")} a place`, onClick: () => toggleCooling(true) },
    ].filter(Boolean);
    return {
      loading, totalKw: totalW != null ? `${(totalW / 1000).toFixed(2)} kW` : "—",
      totalA: totalA != null ? `${online.some(p => p.currentEstimated) ? "≈" : ""}${totalA.toFixed(1)} A` : "—",
      partial: online.length !== unique.length || online.some(p => !p.wattsComplete || p.amps == null),
      serversOn: on, serversTotal: allServers.length, serversOff: off, noReading,
      racks: rackStats.length, racksOnline: summaries.filter(s => s.status === "online").length,
      racksOffline: summaries.filter(s => s.status === "offline" || s.status === "unavailable").length, attention,
    };
  }, [rackStats, pduStatuses, allServers, visualFor, summaryFor, base.maintenance, coolingNeeds, editMode]);

  const rackChips = useMemo(() => rackStats.map(rs => { const s = summaryFor(rs); return { rack: rs.rack, status: s.status, statusText: s.statusText, on: s.on, total: s.total, storage: s.status === "storage" }; }), [rackStats, summaryFor]);

  const overviewEdit = editMode && !r && cooling.editable;
  const viewCtx = useMemo(() => ({
    ...base, matchKeys: searching ? search.keys : null, rowKeep, showEmpty,
    coolingByRack: cooling.groups.byRack, coolingDrop: overviewEdit, coolingDraggable: overviewEdit, coolingEditable: cooling.editable,
    coolingCanPlace: cooling.canPlace, onOpenCooling: cooling.open, onPlaceCooling: cooling.canPlace ? cooling.edit : null, onAddCooling: cooling.add,
  }), [base, searching, search, rowKeep, showEmpty, cooling, overviewEdit]);

  const countText = searching ? `${search.total} ${search.total === 1 ? "match" : "matches"} in ${search.racks.size} ${search.racks.size === 1 ? "rack" : "racks"}` : "";
  const hiddenRacks = rackStats.length - visibleRacks.length;

  return (
    <RackViewContext.Provider value={viewCtx}><div className="racks-view">
      {r ? (
        <RackDetailView r={r}
          rackSlots={rackSlots} rackOrder={rackOrder}
          switchAssignments={switchAssignments} customItems={customItems} optOwners={optOwners}
          onBack={() => setSelectedRack(null)}
          onReorder={onReorder} onSelect={onSelect} onSelectCustom={onSelectCustom}
          onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}
          onRequestAddOpt={setAddOptFor}
          onRequestAddEquip={setAddEquipFor}
          onEdit={() => setEditRackTarget(r.rack)}
          phone={phone} detailView={detailView} onDetailView={setDetailView}/>
      ) : (
        <>
          {editMode && <div role="status" className="edit-mode-notice">
            <p><strong>Edit mode — changes save immediately.</strong> Drag the grip ⠿ to move an OPT to another shelf or rack, or open it to set its U and rack. Click a cooling unit to place or move it. Power on/off is in each server's panel.</p>
            {canAdmin && <button type="button" onClick={() => setAddRackOpen(true)} className="racks-btn racks-btn-accent">{Icon.plus} Add Rack</button>}
          </div>}
          <RackKpis {...kpis}/>
          <RacksToolbar phone={phone} loading={kpis.loading} searchRef={searchRef} query={query} onQuery={setQuery} onSearchKey={onSearchKey} count={countText}
            filter={editMode ? "all" : filter} onFilter={setFilter} filterCounts={filterCounts} editMode={editMode}
            rackChips={rackChips} onJump={jumpTo} showEmpty={showEmpty} onShowEmpty={setShowEmpty}
            allCollapsed={allCollapsed} onToggleAll={toggleAll} coolingOpen={showPanel} onToggleCooling={() => toggleCooling()}
            coolingTotal={coolingTotal} coolingNeeds={coolingNeeds}/>
          {phone && <div className="racks-phone-options">
            <button type="button" className="racks-chip" onClick={toggleAll}>{allCollapsed ? "Expand all" : "Collapse all"}</button>
            <button type="button" className="racks-chip" aria-pressed={showEmpty} onClick={() => setShowEmpty(!showEmpty)}>Empty shelves</button>
          </div>}
          {hiding && hiddenRacks > 0 && visibleRacks.length > 0 && <p className="racks-hidden-note">
            {hiddenRacks} {hiddenRacks === 1 ? "rack has" : "racks have"} no match · <button type="button" className="racks-link" onClick={clearFind}>{searching ? "Clear search" : "Show all"}</button></p>}
          {hiding && visibleRacks.length === 0 && <p className="racks-empty" role="status">
            {searching ? <>No servers, equipment or cooling units {filtering ? "in this filter " : ""}match “<bdi>{search.query}</bdi>”{looseCoolingHit ? " in a rack (see the cooling units panel)" : ""}. </> : <>{filterEmptyText(filter)} </>}
            <button type="button" className="racks-link" onClick={clearFind}>{searching ? "Clear search" : "Show all"}</button></p>}
          {showPanel && <CoolingPanel groups={cooling.groups} rackNames={allNames} loaded={cooling.loaded} loadError={cooling.loadError}
            canEdit={editMode && cooling.editable} canPlace={cooling.canPlace} canOperate={cooling.canOperate} editMode={editMode} lastChange={cooling.lastChange}
            matchKeys={searching ? search.keys : null} onOpen={cooling.open} onPlace={cooling.edit} onAdd={cooling.add} onUndo={cooling.undoLast}
            onRetry={cooling.retry} onClose={() => toggleCooling(false)} history={cooling.history}
            phone={phone} expanded={panelExpanded} onExpand={setPanelExpanded}/>}
          {!rackStats.length && <p className="racks-empty">No racks yet. Add a PDU in Admin → Devices, or turn on Edit to add a rack (Admin).</p>}
          <DndContext sensors={crossSensors} collisionDetection={collision}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => { setActiveId(null); setCoolingActive(null); }}>
            <div className="racks-grid">
              {visibleRacks.map(rs => (
                <RackDiagram key={rs.rack} r={rs}
                  rackSlots={rackSlots} rackOrder={rackOrder}
                  switchAssignments={switchAssignments} customItems={customItems}
                  optOwners={optOwners}
                  onReorder={onReorder} onSelect={onSelect} onSelectCustom={onSelectCustom}
                  onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}
                  onHeaderClick={() => setSelectedRack(rs.rack)}
                  onEdit={() => setEditRackTarget(rs.rack)}
                  collapsed={isCollapsed(rs.rack)} onToggleCollapse={() => toggleCollapse(rs.rack)}
                  external externalActiveId={activeId}/>
              ))}
            </div>
            <DragOverlay dropAnimation={null}>
              {activeServer && (
                <div style={{ opacity: 0.9 }}>
                  <ServerCell server={activeServer} sw={switchAssignments[activeServer.id]} overlay/>
                </div>
              )}
              {coolingActive && <CoolingChip unit={coolingActive} variant="panel"/>}
            </DragOverlay>
          </DndContext>
        </>
      )}


      {/* Modals rendered via Portal — completely outside DOM tree, immune to any stacking context */}
      {addOptFor && (
        <Portal>
          <AddOptModal rack={addOptFor} onClose={() => setAddOptFor(null)} onSave={handleSaveOpt}/>
        </Portal>
      )}
      {addEquipFor && (
        <Portal>
          <AddEquipmentModal rackName={addEquipFor} onClose={() => setAddEquipFor(null)}
            onSave={item => handleSaveEquip(addEquipFor, item)}/>
        </Portal>
      )}
      {addRackOpen && (
        <Portal>
          <AddRackModal onClose={() => setAddRackOpen(false)} onSave={async () => { await onRefresh?.(); }}/>
        </Portal>
      )}
      {editRackTarget && (() => {
        const rs = rackStats.find(r => r.rack === editRackTarget);
        const devs = (rackDevices || []).filter(d => d.rack === editRackTarget);
        return rs ? (
          <Portal>
            <EditRackModal
              rackName={editRackTarget}
              rackType={rs.rackType}
              rackDevs={devs}
              onClose={() => setEditRackTarget(null)}
              onSave={async () => { await onRefresh?.(); if (selectedRack) setSelectedRack(null); }}/>
          </Portal>
        ) : null;
      })()}
      {pendingMove && (
        <Portal>
          <CrossRackMoveModal
            server={pendingMove.server}
            targetRackStat={pendingMove.targetRackStat}
            pdus={pdus}
            onLabelChange={onLabelChange}
            onClose={() => setPendingMove(null)}/>
        </Portal>
      )}
    </div></RackViewContext.Provider>
  );
}

// ─── INVENTORY VIEW ───────────────────────────────────────────────────────────
function InventoryView({ servers, switchAssignments, rackSlots, customItems, optOwners, ownersLoaded, onOwnerChange }) {
  const editMode = useContext(EditContext);
  const {canOperate} = useAccounts();
  const [rack,  setRack]  = useState("all");
  const [state, setState] = useState("all");
  const [q, setQ]         = useState("");
  const [sk, setSk]       = useState("rack");
  const [sd, setSd]       = useState(1);
  const racks = useMemo(()=>[...new Set(servers.map(s=>s.rack))].sort(),[servers]);
  const rows  = useMemo(()=>{
    let list=servers;
    if(rack!=="all")list=list.filter(s=>s.rack===rack);
    if(state!=="all")list=list.filter(s=>s.state===state);
    if(q.trim()){const lq=q.toLowerCase();list=list.filter(s=>s.name.toLowerCase().includes(lq)||(s.rack||"").toLowerCase().includes(lq)||(switchAssignments[s.id]?.switch||"").toLowerCase().includes(lq)||(optOwners?.[s.id]||"").toLowerCase().includes(lq));}
    return [...list].sort((a,b)=>{const av=a[sk]??"",bv=b[sk]??"";if(typeof av==="number"||typeof bv==="number"){if(av===""||bv==="")return av===bv?0:av===""?1:-1;return sd*(av-bv);}return sd*String(av).localeCompare(String(bv));});
  },[servers,rack,state,q,sk,sd,switchAssignments,optOwners]);


  const Th=({k,label,right})=>(<th onClick={()=>{if(sk===k)setSd(d=>-d);else{setSk(k);setSd(1);}}} className={`text-[9px] font-bold uppercase tracking-widest px-3 py-2.5 whitespace-nowrap select-none cursor-pointer hover:text-zinc-300 transition ${right?"text-right":"text-left"} text-zinc-600`}>{label}{sk===k&&<span className="ml-0.5 opacity-50">{sd>0?"↑":"↓"}</span>}</th>);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative"><svg className="absolute left-2.5 top-2" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search…" className="bg-zinc-900 border border-zinc-800 rounded-lg pl-7 pr-3 py-1.5 text-sm w-44 focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/></div>
        <select value={rack} onChange={e=>setRack(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded-lg text-sm px-2.5 py-1.5 focus:outline-none focus:border-nv-400/50"><option value="all">All racks</option>{racks.map(r=><option key={r}>{r}</option>)}</select>
        <select value={state} onChange={e=>setState(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded-lg text-sm px-2.5 py-1.5 focus:outline-none focus:border-nv-400/50"><option value="all">All states</option><option value="on">On</option><option value="off">Off</option><option value="unknown">Unknown</option></select>
        <span className="ml-auto text-[11px] text-zinc-500">{rows.length} / {servers.length}</span>
      </div>
      <div className="border border-zinc-800/60 rounded-xl overflow-hidden bg-zinc-900/30">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/70">
              <tr><Th k="name" label="Asset"/><Th k="rack" label="Rack"/><Th k="state" label="State"/><Th k="watts" label="W" right/><th className="text-[9px] font-bold uppercase tracking-widest px-3 py-2.5 text-zinc-600 text-right">U</th><Th k="outlet" label="Outlet" right/><Th k="pduName" label="PDU"/><Th k="pduIp" label="PDU IP"/><th className="text-[9px] font-bold uppercase tracking-widest px-3 py-2.5 text-zinc-600">Switch</th><th className="text-[9px] font-bold uppercase tracking-widest px-3 py-2.5 text-zinc-600">Owner</th>{canOperate&&<th className="text-[9px] font-bold uppercase tracking-widest px-3 py-2.5 text-zinc-600">SSH</th>}</tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/30">
              {rows.map(s=>{const isOn=s.state==="on",isOff=s.state==="off",sw=switchAssignments[s.id],u=(rackSlots[s.rack]||{})[s.id],ow=optOwners?.[s.id];return(
                <tr key={s.id} className={`hover:bg-zinc-800/20 transition-colors ${isOn?"hover:bg-nv-400/4":""}`}>
                  <td className="px-3 py-2"><div className="flex items-center gap-2"><div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isOn?"bg-emerald-400 shadow-[0_0_3px_#34d399]":isOff?"bg-red-700":"bg-zinc-800"}`}/><span className="font-mono text-[11px] font-semibold text-zinc-200">{s.name}</span></div></td>
                  <td className="px-3 py-2 text-xs text-zinc-500 font-mono">{s.rack||"—"}</td>
                  <td className="px-3 py-2"><Pill color={isOn?"green":isOff?"red":"zinc"} sm>{s.state||"?"}</Pill></td>
                  <td className="px-3 py-2 font-mono text-xs text-right">{s.watts!=null?<span className={isOn?"text-nv-400/80":"text-zinc-500"}>{s.watts.toFixed(0)}</span>:<span className="text-zinc-500">—</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-500 text-right">{u!=null?`U${u}`:<span className="text-zinc-500">—</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-500 text-right">{s.outlet!=null?`#${s.outlet}`:<span className="text-zinc-500">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-zinc-500">{s.pduName||"—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-500">{s.pduIp||"—"}</td>
                  <td className="px-3 py-2 text-xs">{sw?.switch?<Pill color="cyan" sm>{sw.switch}{sw.port?`·${sw.port}`:""}</Pill>:<span className="text-zinc-500">—</span>}</td>
                  <td className="px-3 py-2 text-xs min-w-[110px]">
                    {editMode?<OwnerSelect owner={ow||""} disabled={!ownersLoaded} label={`Owner for ${s.name}`} onChange={id=>onOwnerChange(s.id,id)}/>:<span className={ow?"text-zinc-200":"text-zinc-500"}>{ow||"Owner not set"}</span>}
                  </td>
                  {canOperate&&<td className="px-3 py-2"><SshButton name={s.name}/></td>}
                </tr>
              );})}
              {rows.length===0&&<tr><td colSpan={canOperate?11:10} className="px-3 py-10 text-center text-zinc-700 text-sm">No matching assets</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── POWER VIEW ───────────────────────────────────────────────────────────────
function PowerView({ rackStats }) {
  const allPdus=[...new Map(rackStats.flatMap(r=>r.pduData||[]).map(p=>[p.id,p])).values()];
  const total=sumKnown(allPdus.map(p=>p.watts));
  const partial=allPdus.some(p=>!p.wattsComplete);
  const totalA=sumKnown(allPdus.map(p=>p.amps));
  const knownWatts=rackStats.map(r=>r.totalWatts).filter(v=>v!=null);
  const maxR=Math.max(...knownWatts,1);
  const sorted=[...rackStats].sort((a,b)=>(b.totalWatts??-1)-(a.totalWatts??-1));
  const top=rackStats.flatMap(r=>r.servers).filter(s=>s.watts>0).sort((a,b)=>b.watts-a.watts).slice(0,10);
  if(!rackStats.length)return<div className="text-zinc-600 text-sm py-24 text-center">No power data.</div>;
  const Tile=({label,val,sub,hi})=>(<div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl px-4 py-3"><div className={`text-lg font-bold tabular-nums ${hi?"text-nv-400":"text-zinc-100"}`}>{val}</div><div className="text-[11px] text-zinc-500 mt-0.5">{label}</div>{sub&&<div className="text-[11px] text-zinc-500 mt-0.5">{sub}</div>}</div>);
  const aCol=(p)=>p>80?"#ef4444":p>55?"#f59e0b":"#76b900";
  const aCls=(p)=>p>80?"text-rose-400":p>55?"text-amber-400":"text-zinc-200";
  const recs=[...allPdus].filter(p=>p.reachable===true&&p.wattsComplete&&p.amps!=null&&p.outletsTotal>0).sort((a,b)=>b.headroomAmps-a.headroomAmps).slice(0,8);
  return(
    <div className="space-y-6">
      <p className="text-xs text-zinc-500">Load and headroom are estimates using the existing 16 A rating assumption. Current uses inlet measurements when available and a watts / voltage estimate otherwise. Email alert thresholds are configured separately.</p>
      <div className="flex flex-wrap gap-3">
        <Tile label="Floor draw" val={total == null ? "\u2014" : `${(total/1000).toFixed(2)} kW`} sub={partial ? "partial readings" : reading(total,0," W")} hi/>
        <Tile label="Floor current" val={reading(totalA,1," A")} sub={allPdus.some(p=>p.amps==null) ? "partial readings (estimate)" : "sum of all PDUs (estimate)"}/>
        <Tile label="Online racks" val={rackStats.filter(r=>r.pduOnline).length} sub={`of ${rackStats.length}`}/>
        <Tile label="Peak rack" val={sorted[0]?.totalWatts!=null?`${sorted[0].totalWatts.toFixed(0)} W`:"—"} sub={`${sorted[0]?.rack || ""}${sorted[0] && !sorted[0].wattsComplete ? " (partial)" : ""}`}/>
        <Tile label="Outlets on" val={`${rackStats.reduce((a,r)=>a+r.outletsOn,0)}/${rackStats.reduce((a,r)=>a+r.outletsTotal,0)}`}/>
      </div>
      <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-800/50 text-sm font-semibold text-zinc-200 flex justify-between"><span>Per rack</span><span className="text-[10px] text-zinc-600 font-normal">highest draw first</span></div>
        <div className="p-5 space-y-3">{sorted.map(r=>{const cap=r.totalWatts!=null&&r.maxWatts>0?Math.min(100,r.totalWatts/r.maxWatts*100):null;const col=aCol(cap||0);const rA=r.totalAmps;return(<div key={r.rack}><div className="flex items-center justify-between mb-1"><div className="flex items-center gap-2"><span className={`w-1.5 h-1.5 rounded-full ${r.pduOnline?"bg-nv-400":"bg-zinc-700"}`}/><span className="text-xs font-mono text-zinc-300 w-20 truncate">{r.rack}</span><Pill color={r.pduOnline?"nv":r.pduData.length?"red":"zinc"} sm>{r.pduOnline?"online":r.pduData.length?"offline":"no PDU"}</Pill></div><div className="flex items-center gap-4 text-xs font-mono">{rA!=null&&<span className="text-zinc-500">{r.currentEstimated ? "~" : ""}{rA.toFixed(1)} A{r.ampsComplete ? "" : " (partial)"}</span>}<span className="text-zinc-400">{r.totalWatts!=null?`${r.totalWatts.toFixed(0)} W${r.wattsComplete ? "" : " (partial)"}`:<span className="text-zinc-700">—</span>}</span></div></div><div className="relative h-3.5 bg-zinc-800/50 rounded overflow-hidden"><div className="h-full rounded transition-all duration-700" style={{width:`${r.totalWatts==null?0:(r.totalWatts/maxR)*100}%`,background:col}}/></div>{r.totalWatts!=null&&cap!=null&&<div className="mt-1 text-[11px] text-zinc-500 tabular-nums">{(r.totalWatts/1000).toFixed(2)} kW · {cap.toFixed(0)}% (estimate){!r.wattsComplete ? " (partial)" : ""}</div>}</div>);})}</div>
      </div>
      {allPdus.length>0&&<div className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-800/50 flex items-baseline justify-between"><span className="text-sm font-semibold text-zinc-200">Amperage per PDU</span><span className="text-[10px] text-zinc-600">rated 16 A per circuit</span></div>
        <div className="overflow-x-auto"><table className="w-full text-xs">
          <thead><tr className="border-b border-zinc-800/40 text-[9px] uppercase tracking-widest text-zinc-600">
            <th className="px-5 py-2 text-left font-medium">PDU</th><th className="px-3 py-2 text-left font-medium">Rack</th><th className="px-3 py-2 text-right font-medium">V</th><th className="px-3 py-2 text-right font-medium">Current</th><th className="px-5 py-2 text-right font-medium">Load</th><th className="px-5 py-2 text-right font-medium">Free outlets</th>
          </tr></thead>
          <tbody>{allPdus.map(p=>{const pct=p.ratedAmps>0?Math.min(100,p.amps/p.ratedAmps*100):0;return(
            <tr key={p.id} className="border-b border-zinc-800/20 hover:bg-zinc-800/20">
              <td className="px-5 py-2.5"><div className="flex items-center gap-1.5"><span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.reachable?"bg-nv-400":"bg-zinc-600"}`}/><span className="font-mono text-zinc-300">{p.name}</span></div></td>
              <td className="px-3 py-2.5 text-zinc-500 font-mono">{p.rack}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-zinc-500">{reading(p.voltage,0," V")}</td>
              <td className="px-3 py-2.5 text-right tabular-nums"><span className={aCls(pct)}>{p.currentEstimated && p.amps != null ? "≈" : ""}{reading(p.amps,1," A")}</span><span className="text-zinc-700 text-[9px] ml-1">/ {p.ratedAmps} A</span></td>
              <td className="px-5 py-2.5"><div className="flex items-center justify-end gap-2"><div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{width:`${pct}%`,background:aCol(pct)}}/></div><span className={`text-[10px] tabular-nums w-8 text-right ${aCls(pct)}`}>{p.amps == null ? "\u2014" : `${pct.toFixed(0)}% (estimate)`}</span></div></td>
              <td className="px-5 py-2.5 text-right tabular-nums"><span className={p.freeOutlets>0?"text-nv-400":"text-zinc-700"}>{p.freeOutlets}</span>{p.outletsTotal>0&&<span className="text-zinc-700 text-[9px] ml-1">/ {p.outletsTotal}</span>}</td>
            </tr>);})}</tbody>
        </table></div>
      </div>}
      {recs.length>0&&<div className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-800/50"><div className="text-sm font-semibold text-zinc-200">Where to connect new units</div><div className="text-[10px] text-zinc-600 mt-0.5">Sorted by available amperage headroom · assumes 16 A rated PDU</div></div>
        <div className="p-4 space-y-2">{recs.map((p,i)=>{const pct=p.ratedAmps>0?Math.min(100,p.amps/p.ratedAmps*100):0;const tag=pct<40?{t:"Plenty of room",c:"text-nv-400 bg-nv-400/8 border-nv-400/25"}:pct<70?{t:"Some room",c:"text-amber-400 bg-amber-400/8 border-amber-400/25"}:{t:"Near capacity",c:"text-rose-400 bg-rose-400/8 border-rose-400/25"};const maxLoad=p.headroomAmps*(p.voltage>0?p.voltage:208);return(
          <div key={p.id} className="flex items-center gap-3 p-3 bg-zinc-900/50 border border-zinc-800/40 rounded-xl">
            <span className="text-[9px] font-mono text-zinc-700 w-4 shrink-0 text-right">{i+1}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-0.5"><span className="text-xs font-mono text-zinc-200">{p.name}</span><span className="text-[9px] text-zinc-600 font-mono">{p.rack}</span><span className={`text-[9px] font-medium px-1.5 py-px rounded border ${tag.c}`}>{tag.t}</span></div>
              <div className="text-[10px] text-zinc-600 tabular-nums">{p.headroomAmps.toFixed(1)} A headroom · max new load ≈ {(maxLoad/1000).toFixed(1)} kW · {p.freeOutlets} free outlet{p.freeOutlets!==1?"s":""}</div>
            </div>
            <div className="shrink-0 text-right"><div className="text-[10px] font-mono tabular-nums text-zinc-400">{p.amps.toFixed(1)} / {p.ratedAmps} A</div><div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden mt-1 ml-auto"><div className="h-full rounded-full" style={{width:`${pct}%`,background:aCol(pct)}}/></div></div>
          </div>);})}</div>
      </div>}
      {top.length>0&&<div className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl overflow-hidden"><div className="px-5 py-3 border-b border-zinc-800/50 text-sm font-semibold text-zinc-200">Top consumers</div><div className="p-5 space-y-2">{top.map((s,i)=>(<div key={s.id} className="flex items-center gap-3"><span className="text-[9px] font-mono text-zinc-700 w-4 text-right">{i+1}</span><div className={`w-1.5 h-1.5 rounded-full ${s.state==="on"?"bg-emerald-400":"bg-zinc-600"}`}/><span className="text-[11px] font-mono text-zinc-300 flex-1 truncate">{s.name}</span><Pill color="zinc" sm>{s.rack}</Pill><div className="w-24 h-1 bg-zinc-800 rounded-full overflow-hidden"><div className="h-full bg-nv-400 rounded-full" style={{width:`${(s.watts/top[0].watts)*100}%`}}/></div><span className="text-[11px] font-mono text-nv-400 w-12 text-right">{s.watts.toFixed(0)} W</span></div>))}</div></div>}
    </div>
  );
}

// ─── CHANGELOG VIEW ───────────────────────────────────────────────────────────
function ChangelogView() {
  const [text,setText]=useState("");const [loading,setLoading]=useState(true);
  useEffect(()=>{fetch("/api/changelog").then(r=>r.json()).then(d=>setText(d.changelog||"")).catch(()=>setText("Could not load.")).finally(()=>setLoading(false));},[]);
  if(loading)return<div className="text-zinc-600 text-sm py-10 text-center animate-pulse">Loading…</div>;
  // Same parser and renderer as What's new, so Unreleased sections get their own cards.
  const sections=splitSections(text);
  if(!sections.length)return<pre className="text-xs text-zinc-500 font-mono whitespace-pre-wrap">{text}</pre>;
  const current=sections.findIndex(s=>versionOf(s.title));
  return(
    <div className="space-y-3 max-w-2xl">{sections.map((s,i)=>{const {label,detail,unreleased}=sectionHeading(s.title);const hi=i===current;return(
      <section key={`${i}:${s.title}`} className={`border rounded-xl overflow-hidden ${hi?"border-nv-400/30 bg-nv-400/4":unreleased?"border-amber-500/30 bg-amber-500/5":"border-zinc-800/60 bg-zinc-900/30"}`}>
        <div className={`px-4 py-2.5 border-b flex items-center gap-2.5 ${hi?"border-nv-400/20 bg-nv-400/8":"border-zinc-800/50 bg-zinc-900/50"}`}>
          <h3 className={`font-mono text-sm font-bold ${hi?"text-nv-400":unreleased?"text-amber-300":"text-zinc-300"}`}>{plain(label)}</h3>
          {hi&&<span className="text-[9px] px-1.5 py-px bg-nv-400/20 text-nv-400 border border-nv-400/30 rounded font-bold tracking-wide">CURRENT</span>}
          {detail&&<span className="text-xs text-zinc-500 ml-auto font-mono text-right">{plain(detail)}</span>}
        </div>
        <div className="px-4 py-3"><SectionBody body={s.body}/></div>
      </section>);})}</div>
  );
}

// ─── KPI BAR ──────────────────────────────────────────────────────────────────
function KpiBar({servers,rackStats,pdus,pduStatuses}) {
  const unique = [...new Map(rackStats.flatMap(r => r.pduData).map(p => [p.id,p])).values()];
  const online = unique.filter(p => p.reachable);
  const totalW = sumKnown(online.map(p=>p.watts));
  const totalA = sumKnown(online.map(p=>p.amps));
  const on = servers.filter(s => s.state === "on").length;
  const partial = online.length !== unique.length || online.some(p=>!p.wattsComplete || p.amps==null);
  return <div className="rack-kpis">
    {[["Total draw", totalW != null ? `${(totalW/1000).toFixed(2)} kW` : "—", partial ? "partial readings" : "all PDUs"],
      ["Floor current", totalA != null ? `${online.some(p=>p.currentEstimated) ? "≈" : ""}${totalA.toFixed(1)} A` : "—", partial ? "partial readings" : "all PDUs"],
      ["Servers on", `${on}/${servers.length}`, `${servers.length-on} off or unknown`],
      ["Racks", rackStats.length, `${rackStats.filter(r=>r.pduOnline).length} online`]].map(([label,value,sub], i) => <div key={label} className="rack-kpi"><strong style={i===0 ? {color:"#76b900"} : undefined}>{value}</strong><span>{label}</span><small>{sub}</small></div>)}
  </div>;
}

function ReadOnlyAsset({ item, owner, onClose, sshName }) {
  const panelRef = useRef(null);
  useDialogFocus(panelRef, { onEscape: onClose });
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="asset-details-title" tabIndex={-1} onClick={e=>e.stopPropagation()} className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <div className="flex justify-between gap-3"><h2 id="asset-details-title" dir="auto" className="font-mono text-xl text-white break-all">{item.name}</h2><div className="flex items-start gap-2 flex-shrink-0">{sshName&&<SshButton name={sshName} size="md"/>}<CloseBtn onClose={onClose}/></div></div>
      <dl className="grid grid-cols-2 gap-3 text-sm my-6">{Object.entries({Type:item.type||"Server", Rack:item.rack, State:item.state, "Power (W)":item.watts??"\u2014", "Serial number":item.serial_number, Barcode:item.barcode, Shelf:item.u, Owner:owner||"Owner not set", PDU:item.pduName, Outlet:item.outlet}).filter(([,v])=>v!=null&&v!=="").map(([key,value])=><div key={key}><dt className="text-xs text-zinc-500">{key}</dt><dd className="mt-1 break-words">{value}</dd></div>)}</dl>
      <p className="text-xs text-zinc-400">Turn on Edit to change this equipment.</p>
    </section>
  </div>;
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function DcimView({devices,pduStatuses,kvmStatuses,onOutletAction,onLabelChange,onRenameOpt,onRefresh, onOpenConsole, section: controlledSection, editMode = false, onSummary, maintenance, onSwitchFeeds, onRequestEdit, rack, onRackChange}) {
  const {canOperate, canAdmin, preferences} = useAccounts();
  const {revision: engineerRevision} = useEngineers();
  const [localSection, setSection] = useState("racks");
  const section = controlledSection || localSection;
  const [rackOrder,         setRackOrder]         = useState({});
  const [rackSlots,         setRackSlots]         = useState({});
  const [switchAssignments, setSwitchAssignments] = useState({});
  const [customItems,       setCustomItems]       = useState({});
  const [rackOverrides,     setRackOverrides]     = useState({});
  const [optOwners,         setOptOwners]         = useState({});
  const [ownersLoaded,      setOwnersLoaded]      = useState(false);
  const [chillers,          setChillers]          = useState({units:[],connections:[]});
  const [chillersLoaded,    setChillersLoaded]    = useState(false);
  const [selectedServerId,  setSelectedServerId]  = useState(null);
  const [selectedCustomId,  setSelectedCustomId]  = useState(null);
  // epoch reopens the equipment panel on the fresh record after another session's change was reloaded;
  // draft: the fields this person had changed in it; notice: the panel says why it was reopened.
  const [customPanel,       setCustomPanel]       = useState({epoch:0, draft:null, notice:false});
  const [layoutError,       setLayoutError]       = useState("");
  const selectCustom = useCallback(item => { setSelectedCustomId(item?.id ?? null); setCustomPanel({epoch:0, draft:null, notice:false}); }, []);

  // The rack layout (positions, U slots, overrides, equipment, owners, cooling units) is reloaded on the dashboard's
  // refresh interval, when the tab becomes visible again and when the DCIM tab changes, so moves made in Locations, the
  // 3D Twin, the assistant or another session show here without a page reload. One reload path for every store.
  // While editing, the layout stores pause, so a reload never replaces what is being edited; equipment keeps reloading
  // (B08 RACK-3) except while an equipment panel is open, whose form is based on the record it opened with. itemsSeq
  // drops an equipment answer that a save, or a newer reload, overtook. A failed reload keeps what is shown.
  const editingRef = useRef(editMode);
  editingRef.current = editMode;
  const itemsSeq = useRef(0);
  // Cooling units are edited through dialogs, never inline, so they keep reloading in Edit mode too, except while a
  // cooling dialog is open (its form is based on what it opened with); coolingSeq drops an answer a save overtook.
  const coolingSeq = useRef(0);
  const holdCoolingRef = useRef(false);
  const holdItems = selectedCustomId != null;
  const holdItemsRef = useRef(holdItems);
  holdItemsRef.current = holdItems;
  // loadErrors: the stores whose last load failed ({ items, cooling, layout: message }), shown as banners with Retry.
  const [loadErrors, setLoadErrors] = useState({});
  // initial: the first load (a failed store starts empty, as before). force: Retry (also while editing or hidden).
  const reloadLayouts = useCallback((initial = false, force = false) => {
    if (!initial && !force && document.hidden) return Promise.resolve();
    const editing = !initial && !force && editingRef.current;
    const itemsTurn = holdItemsRef.current ? null : ++itemsSeq.current;
    const coolingTurn = !initial && !force && holdCoolingRef.current ? null : ++coolingSeq.current;
    if (editing && itemsTurn == null && coolingTurn == null) return Promise.resolve();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const keep = setter => next => setter(prev => same(prev, next) ? prev : next);
    const failed = {};
    const reason = e => (e?.status ? `HTTP ${e.status}` : e?.message || "no answer");
    const fetchStore = (store, path) => fetch(path, { cache: "no-store" }).then(r => { if (r.ok) return r.json(); const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; })
      .catch(e => { if (store) failed[store] ||= reason(e); return null; });
    const get = (store, path) => editing ? Promise.resolve(null) : fetchStore(store, path);
    return Promise.all([
      get("layout", "/api/rack-positions"),
      get("layout", "/api/rack-slots"),
      get("layout", "/api/switch-assignments"),
      itemsTurn == null ? Promise.resolve(null) : loadRackItems().catch(e => { failed.items = reason(e); return null; }),
      get("layout", "/api/rack-overrides"),
      get(null, "/api/opt-owners"),
      coolingTurn == null ? Promise.resolve(null) : fetchStore("cooling", "/api/chillers"),
    ]).then(([order,slots,sw,items,overrides,owners,chill])=>{
      const itemsCurrent = itemsTurn != null && itemsTurn === itemsSeq.current;
      if (itemsCurrent && (items || initial)) keep(setCustomItems)(items||{});
      const coolingCurrent = coolingTurn != null && coolingTurn === coolingSeq.current && (initial || force || !holdCoolingRef.current);
      setLoadErrors(prev => {
        const next = { ...prev };
        const mark = store => { if (failed[store]) next[store] = failed[store]; else delete next[store]; };
        if (itemsCurrent) mark("items");
        if (!editing) mark("layout");
        if (coolingCurrent) mark("cooling");
        return same(prev, next) ? prev : next;
      });
      if (coolingCurrent && (chill || initial)) { keep(setChillers)(chill||{units:[],connections:[]}); setChillersLoaded(true); }
      if (!initial && !force && editingRef.current) return;   // editing (or editing started while loading)
      // A failed reload keeps what is shown; the first load falls back to empty documents as before.
      if (order || initial) keep(setRackOrder)(order||{});
      if (slots || initial) keep(setRackSlots)(slots||{});
      if (sw || initial) keep(setSwitchAssignments)(sw||{});
      if (overrides || initial) keep(setRackOverrides)(overrides||{});
      if (owners) { keep(setOptOwners)(owners); setOwnersLoaded(true); }
    });
  },[]);
  useEffect(()=>{ reloadLayouts(true); },[reloadLayouts]);
  // Opening an equipment panel drops an equipment answer still on its way; closing it or changing the DCIM tab reloads.
  const reloadTrigger = useRef(false);
  useEffect(()=>{
    if (holdItems) { itemsSeq.current++; return; }
    if (reloadTrigger.current) reloadLayouts();
    reloadTrigger.current = true;
  },[section, holdItems, reloadLayouts]);
  const refreshSeconds = Math.max(5, Number(preferences?.refresh_seconds) || 15);
  useEffect(()=>{
    const timer = setInterval(() => reloadLayouts(), refreshSeconds * 1000);
    const onVisible = () => { if (!document.hidden) reloadLayouts(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  },[reloadLayouts, refreshSeconds]);

  // One layout edit: saved against the server's current document; on failure the optimistic
  // state is undone, the store reloaded, and the error rethrown for the caller to show.
  const persistLayout = useCallback(async (path, edit, setState, previous) => {
    try {
      setState(await saveLayout(path, edit));
    } catch (e) {
      setState(previous);
      loadLayout(path).then(({ data }) => setState(data)).catch(() => {});
      throw e;
    }
  }, []);

  // ── toast (one at a time) ──
  const [toast, setToast] = useState(null);
  const showToast = useCallback((text, tone = "ok", onUndo = null) => setToast({ id: `${Date.now()}-${Math.random()}`, text, tone, onUndo }), []);
  const dismissToast = useCallback(id => setToast(t => (t?.id === id ? null : t)), []);

  // ── cooling units: never deleted; every edit is checked (assertKeepsUnits) and saved against the latest document ──
  const chillersRef = useRef(chillers);
  chillersRef.current = chillers;
  const [lastCooling, setLastCooling] = useState(null);
  // change: the move as this page saw it. Its "before" is taken again from the server document the edit is applied to
  // (another session may have moved the unit meanwhile), so Undo puts back where the unit really was; resolves to it.
  const saveCooling = useCallback(async (edit, change) => {
    const previous = chillersRef.current;
    let saved = change;
    const guarded = doc => {
      const base = normalizeChillers(doc);
      if (change) { const unit = base.units.find(u => u && typeof u === "object" && u.id === change.unitId); if (unit) saved = coolingChange(unit, change.after); }
      const next = edit(base); assertKeepsUnits(doc, next); return next;
    };
    coolingSeq.current++;
    setChillers(guarded(previous));   // optimistic; an edit that cannot apply throws here, before anything is sent
    try { await persistLayout("/api/chillers", guarded, setChillers, previous); }
    finally { coolingSeq.current++; }
    if (saved) setLastCooling(saved);
    return saved;
  }, [persistLayout]);
  const undoCooling = useCallback(async change => {
    try {
      await saveCooling(doc => undoCoolingChange(doc, change), null);
      setLastCooling(c => (c === change ? null : c));
      showToast(<><bdi>{change.name}</bdi> is back at {describePlace(change.before)}.</>);
    } catch (e) {
      setLayoutError(`The cooling change was not undone: ${e.message}`);
      showToast(e.message, "error");
    }
  }, [saveCooling, showToast]);
  const coolingMoved = useCallback(change => {
    showToast(<><bdi>{change.name}</bdi> {change.after.rack ? `moved to ${describePlace(change.after)}` : "has no rack now"}.</>, "ok", () => undoCooling(change));
  }, [showToast, undoCooling]);

  const handleSlotSave = useCallback((rack, id, u) => {
    const edit = doc => ({ ...doc, [rack]: { ...(doc?.[rack] || {}), [id]: u } });
    const previous = rackSlots;
    setRackSlots(edit(rackSlots));
    return persistLayout("/api/rack-slots", edit, setRackSlots, previous);
  }, [rackSlots, persistLayout]);

  const handleSwitchSave = useCallback((id, value) => {
    const edit = doc => { const next = { ...doc }; if (value) next[id] = value; else delete next[id]; return next; };
    const previous = switchAssignments;
    setSwitchAssignments(edit(switchAssignments));
    return persistLayout("/api/switch-assignments", edit, setSwitchAssignments, previous);
  }, [switchAssignments, persistLayout]);

  const handleRackOverrideSave = useCallback((id, rack) => {
    const edit = doc => ({ ...doc, [id]: rack });
    const previous = rackOverrides;
    setRackOverrides(edit(rackOverrides));
    return persistLayout("/api/rack-overrides", edit, setRackOverrides, previous);
  }, [rackOverrides, persistLayout]);

  // inventory.js reports a rejected equipment save; a stale list is replaced by the reloaded one, and an open
  // equipment panel is reopened on its fresh record (it closes if the item was deleted meanwhile).
  const saveItems = useCallback(async (updated) => {
    itemsSeq.current++;
    try {
      const saved = await saveRackItems(updated, customItems);
      setCustomItems(saved);
      return saved;
    } catch (e) {
      if (e.reloaded) {
        setCustomItems(e.reloaded);
        setCustomPanel(p => ({epoch: p.epoch + 1, draft: null, notice: true}));
      }
      throw e;
    } finally {
      itemsSeq.current++;
    }
  }, [customItems]);

  useEffect(()=>{let active=true;accountRequest("/opt-owners").then(data=>{if(active){setOptOwners(data);setOwnersLoaded(true);}}).catch(()=>{});return()=>{active=false;};},[engineerRevision]);
  const handleOwnerChange = useCallback(async (assetKey, engineerId) => {
    setOptOwners(await accountRequest(`/opt-owners/${encodeURIComponent(assetKey)}`,"PUT",{engineer_id:engineerId}));
  },[]);

  const pdus       = devices.filter(d=>d.kind==="pdu");
  // Each server's KVM port: live port labels of a reachable KVM first (as on the dashboard), then saved labels.
  const kvmByServer = useMemo(()=>{
    const map=new Map();
    devices.filter(d=>d.kind==="kvm").forEach(kvm=>{
      const st=kvmStatuses?.[kvm.id];
      const live=st?.reachable ? (st.ports||[]) : [];
      const liveNums=new Set(live.map(p=>String(p.number)));
      const add=(label,port)=>{const id=serverIdentity(label);const n=parseInt(port,10);if(id&&Number.isFinite(n)&&!map.has(id))map.set(id,{kvmId:kvm.id,kvmName:kvm.name,port:n});};
      live.forEach(p=>add(p.label,p.number));
      Object.entries(kvm.labels||{}).forEach(([num,label])=>{if(!liveNums.has(num))add(label,num);});
    });
    return map;
  },[devices,kvmStatuses]);
  // Inventory racks have no device status; Dashboard links to their saved layout.
  const rackDevices = devices.filter(d=>d.kind==="pdu"||d.kind==="rack");
  const racks = useMemo(()=>[...new Set([...rackDevices.map(d=>d.rack).filter(Boolean), ...Object.keys(customItems)])].sort(),[rackDevices, customItems]);

  const servers = useMemo(()=>{
    const map=new Map();
    pdus.forEach(pdu=>{
      const stored=pdu.labels||{},live=pduStatuses[pdu.id]?.outlets||[];
      const liveByN=Object.fromEntries((pduStatuses[pdu.id]?.reachable ? live : []).map(o=>[String(o.number),o]));
      Object.entries(stored).forEach(([num,label])=>{
        // A reachable PDU's live outlet list already carries the latest saved labels (the dashboard shows the same):
        // an older saved label for that outlet must not keep a server that has moved away.
        if(liveByN[num])return;
        if(!isServerLabel(label))return;const key=label.trim().toLowerCase();if(map.has(key))return;
        const lo=liveByN[num];map.set(key,{id:key,name:label.trim(),rack:rackOverrides[key]||pdu.rack||"—",pduId:pdu.id,pduName:pdu.name,pduIp:pdu.ip,outlet:parseInt(num,10),state:lo?.state??"unknown",watts:lo?.watts??null});
      });
      (pduStatuses[pdu.id]?.reachable ? live : []).forEach(o=>{
        if(!isServerLabel(o.label))return;const key=o.label.trim().toLowerCase();
        if(map.has(key)){const e=map.get(key);e.state=o.state;e.watts=o.watts??null;return;}
        map.set(key,{id:key,name:o.label.trim(),rack:rackOverrides[key]||pdu.rack||"—",pduId:pdu.id,pduName:pdu.name,pduIp:pdu.ip,outlet:o.number,state:o.state,watts:o.watts??null});
      });
    });
    return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
  },[pdus,pduStatuses,rackOverrides]);

  const rackStats = useMemo(()=>racks.map(rn=>{
    const rPdus=rackDevices.filter(p=>p.rack===rn);
    const sharedPdus=rackDevices.filter(p=>
      p.kind==="pdu" && p.rack!==rn &&
      (p.notes||"").split(",").map(s=>s.trim()).includes(`shared:${rn}`)
    );
    const allPdus=[...rPdus, ...sharedPdus];
    const pduData=allPdus.filter(p=>p.kind==="pdu").map(pdu=>{
      const st=pduStatuses[pdu.id];
      const voltage=st?.reachable ? st.inlet_voltage ?? null : null;
      const estimateVoltage = voltage > 0 ? voltage : 208;
      const watts=st?.reachable ? st.total_watts ?? null : null;
      const wattsComplete=st?.reachable === true && st.watts_complete === true;
      const readings = st?.reachable ? st.inlet_readings || [] : [];
      const measured = readings.length > 0 && readings.every(i => i.current != null);
      const amps = measured ? readings.reduce((sum, i) => sum + i.current, 0) : wattsComplete && watts != null ? parseFloat((watts/estimateVoltage).toFixed(2)) : null;
      const ratedAmps=16;
      const outlets=st?.outlets||[];
      const onCount=outlets.filter(o=>o.state==="on").length;
      const freeOutlets=outlets.filter(o=>isDefaultOutletLabel(o.label)).length;
      return{id:pdu.id,name:pdu.name,ip:pdu.ip,rack:rn,reachable:st?.reachable??null,
        watts,wattsComplete,voltage,amps,currentEstimated:!measured,ratedAmps,maxWatts:ratedAmps*estimateVoltage,
        outletsOn:onCount,outletsTotal:outlets.length,freeOutlets,
        headroomAmps:amps == null ? null : parseFloat(Math.max(0,ratedAmps-amps).toFixed(2)),
        headroomPct:amps == null ? null : Math.max(0,1-amps/ratedAmps)};
    });
    const totalWatts=sumKnown(pduData.map(p=>p.watts));
    const wattsComplete=pduData.length>0 && pduData.every(p=>p.wattsComplete);
    let outletsOn=0,outletsTotal=0;
    pduData.forEach(p=>{outletsOn+=p.outletsOn;outletsTotal+=p.outletsTotal;});
    const totalAmps=sumKnown(pduData.map(p=>p.amps));
    const ampsComplete=pduData.length>0 && pduData.every(p=>p.amps != null);
    const rServers=servers.filter(s=>s.rack===rn);
    const pduOnline=pduData.length>0 && pduData.every(p=>p.reachable===true);
    const maxWatts=pduData.reduce((a,p)=>a+p.maxWatts,0)||outletsTotal*150;
    const rackType=rn===MAIN_STORAGE||rPdus[0]?.model==="Storage"?"storage":"compute";
    return{rack:rn,pdus:allPdus,pduData,servers:rServers,totalWatts,wattsComplete,totalAmps,ampsComplete,outletsOn,outletsTotal,maxWatts,pduOnline,rackType,currentEstimated:pduData.some(p=>p.currentEstimated)};
  }),[racks,rackDevices,pduStatuses,servers]);

  useEffect(() => { onSummary?.(`${racks.length} racks · ${servers.length} OPTs · ${Object.values(customItems).flat().length} equipment items`); }, [racks.length, servers.length, customItems, onSummary]);

  // ── row states and rack summaries ──
  const visualFor = useCallback(server => serverVisualState(server, pduStatuses[server.pduId], maintenanceFor(maintenance, server.pduId)), [pduStatuses, maintenance]);
  const chillerDoc = useMemo(() => normalizeChillers(chillers), [chillers]);
  const coolingGroups = useMemo(() => groupChillers(chillerDoc.units, racks), [chillerDoc, racks]);
  const summaries = useMemo(() => new Map(rackStats.map(rs => [rs.rack, rackSummary(rs, { pduStatuses, maintenance, cooling: coolingGroups.byRack[rs.rack] })])), [rackStats, pduStatuses, maintenance, coolingGroups]);
  const summaryFor = useCallback(rs => summaries.get(rs.rack) || rackSummary(rs, { pduStatuses, maintenance }), [summaries, pduStatuses, maintenance]);
  const rackView = useMemo(() => ({ visualFor, summaryFor, maintenance, itemsError: !!loadErrors.items }), [visualFor, summaryFor, maintenance, loadErrors.items]);

  // ── cooling dialog: view (anyone), edit / create (Edit mode, Operator and up, store loaded) ──
  const [coolingDialog, setCoolingDialog] = useState(null);   // { mode, unitId?, rack?, newId?, focusUnit? }
  const coolingEditable = !!canOperate && chillersLoaded && !loadErrors.cooling;
  const unitById = useCallback(id => chillerDoc.units.find(u => u?.id === id) || null, [chillerDoc]);
  const shelfOptionsFor = useCallback(rackName => {
    const rs = rackStats.find(x => x.rack === rackName);
    const rows = rs ? buildRackRows(rs.servers, rs.rack, rackOrder, rackSlots, customItems).rows : [];
    return shelfOptions(rows, 42, coolingGroups.byRack[rackName]?.placed || {});
  }, [rackStats, rackOrder, rackSlots, customItems, coolingGroups]);
  const openCooling = useCallback(unit => setCoolingDialog({ mode: editMode && coolingEditable ? "edit" : "view", unitId: unit.id }), [editMode, coolingEditable]);
  // Place… / Move… outside Edit mode: Edit turns on (App's own toggle) and the unit opens to be edited, Rack focused.
  const canPlaceCooling = coolingEditable && (editMode || !!onRequestEdit);
  const editCooling = useCallback(unit => {
    if (!coolingEditable) return;
    if (!editingRef.current) { if (!onRequestEdit) return; onRequestEdit(); }
    setCoolingDialog({ mode: "edit", unitId: unit.id });
  }, [coolingEditable, onRequestEdit]);
  holdCoolingRef.current = coolingDialog != null;
  const addCooling = useCallback(rackName => setCoolingDialog({ mode: "create", rack: rackName || null, newId: newChillerId() }), []);
  // After a save the focus goes to the unit's chip in its new place (the panel when its card is closed or hidden).
  const focusUnit = useCallback(id => {
    const css = window.CSS.escape(id);
    const tries = [`[data-rack-id] .cooling-chip[data-unit-id="${css}"]`, `#cooling-panel li[data-unit-id="${css}"] button`, `[data-unit-id="${css}"] button`];
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = tries.flatMap(sel => [...document.querySelectorAll(sel)]).find(x => x.offsetParent !== null);
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); flash(el); }
    }));
  }, []);
  const saveCoolingDialog = useCallback(async ({ name, rack: rackName, u }) => {
    const dialog = coolingDialog;
    if (!dialog) return;
    if (dialog.mode === "create") {
      await saveCooling(doc => addChiller(doc, { id: dialog.newId, name, rack: rackName, u }), null)
        .catch(e => { throw new Error(`The cooling unit was not added: ${e.message}`); });
      setCoolingDialog(null);
      showToast(<>Added <bdi>{name}</bdi> {rackName ? `to ${describePlace({ rack: rackName, u })}` : "with no rack"}. To take it out of the rack, open it and choose No rack.</>);
      focusUnit(dialog.newId);
      return;
    }
    const unit = unitById(dialog.unitId);
    if (!unit) throw new Error("This cooling unit is no longer in the list. Close and reopen the panel.");
    const saved = await saveCooling(doc => updateChiller(doc, unit.id, { name, rack: rackName, u }), coolingChange(unit, { name, rack: rackName, u }))
      .catch(e => { throw new Error(`The cooling assignment was not saved: ${e.message}`); });
    setCoolingDialog(null);
    coolingMoved(saved);
    focusUnit(unit.id);
  }, [coolingDialog, saveCooling, unitById, showToast, coolingMoved, focusUnit]);
  const takeOffShelf = useCallback(async () => {
    const unit = unitById(coolingDialog?.unitId);
    if (!unit) return;
    const saved = await saveCooling(doc => updateChiller(doc, unit.id, { u: null }), coolingChange(unit, { name: unit.name, rack: unit.rack, u: null }))
      .catch(e => { throw new Error(`The cooling assignment was not saved: ${e.message}`); });
    setCoolingDialog(null);
    showToast(<><bdi>{unit.name}</bdi> is off its shelf; it stays in {unit.rack}.</>, "ok", () => undoCooling(saved));
    focusUnit(unit.id);
  }, [coolingDialog, unitById, saveCooling, showToast, undoCooling, focusUnit]);
  // A drag in Edit mode on the overview: shelf (u) or the rack's "not on a shelf" strip (u null).
  const placeCooling = useCallback(async (id, rackName, u) => {
    const unit = unitById(id);
    if (!unit || (unit.rack === rackName && (validShelf(unit.u) ? unit.u : null) === u)) return;
    try {
      coolingMoved(await saveCooling(doc => placeChiller(doc, id, rackName, u), coolingChange(unit, { name: unit.name, rack: rackName, u })));
    } catch (e) {
      setLayoutError(`The cooling assignment was not saved: ${e.message}`);
      showToast(`The cooling assignment was not saved: ${e.message}`, "error");
    }
  }, [unitById, saveCooling, coolingMoved, showToast]);
  const coolingHistory = useMemo(() => ({
    currentIds: new Set(chillerDoc.units.filter(u => u && typeof u === "object").map(u => u.id)),
    currentPlaces: chillerDoc.units.filter(u => u && typeof u === "object").map(u => ({ id: u.id, name: u.name, rack: u.rack ?? null, u: u.u ?? null })),
    load: async () => {
      const response = await fetch("/api/chillers/history", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "this server does not keep a history yet" : `HTTP ${response.status}`);
      const body = await response.json();
      return (Array.isArray(body?.versions) ? body.versions : []).slice(0, 20);
    },
    // The restore is sent with the ETag of the document this page shows: if the server's document is not that one any
    // more, the page shows the latest instead and nothing is restored (the person decides again on what is current).
    restore: async revision => {
      const shown = chillersRef.current;
      const { data, etag } = await loadLayout("/api/chillers");
      if (!sameDocument(data, shown)) {
        coolingSeq.current++; setChillers(data); setLastCooling(null);
        throw new Error("The cooling units changed in another session; the list now shows the latest. Nothing was restored — check the history again.");
      }
      const response = await fetch("/api/chillers/restore", { method: "POST", headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) }, body: JSON.stringify({ revision }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (response.status === 409) { reloadLayouts(false, true); throw new Error("The cooling units changed in another session meanwhile; the list was reloaded. Try again."); }
        throw new Error(typeof body?.detail === "string" ? body.detail : `Restore failed (HTTP ${response.status}).`);
      }
      const doc = await response.json();
      coolingSeq.current++; setChillers(doc); setLastCooling(null);
      showToast(`Cooling units restored to version #${revision}. Units added since stay where they are; the layout before it is in the history.`);
    },
    bringBack: async unit => {
      await saveCooling(doc => addChiller(doc, { id: unit.id, name: unit.name || unit.id, rack: unit.rack ?? null, u: validShelf(unit.u) ? unit.u : null }), null);
      showToast(<>Brought back <bdi>{unit.name || unit.id}</bdi> to {describePlace(unit)}.</>);
    },
  }), [chillerDoc, reloadLayouts, saveCooling, showToast]);
  const coolingApi = useMemo(() => ({
    units: chillerDoc.units.filter(u => u && typeof u === "object"), groups: coolingGroups, loaded: chillersLoaded, loadError: loadErrors.cooling || "",
    editable: coolingEditable, canOperate: !!canOperate, canPlace: canPlaceCooling, lastChange: lastCooling,
    open: openCooling, edit: editCooling, add: addCooling, place: placeCooling,
    undoLast: () => { if (lastCooling) undoCooling(lastCooling); },
    retry: () => reloadLayouts(false, true), history: canOperate ? coolingHistory : null,
  }), [chillerDoc, coolingGroups, chillersLoaded, loadErrors.cooling, coolingEditable, canOperate, canPlaceCooling, lastCooling, openCooling, editCooling, addCooling, placeCooling, undoCooling, reloadLayouts, coolingHistory]);

  // ── power: the row switch, the details dialog and the edit panel all go through requestPower ──
  const powerCtx = useMemo(() => ({ devices, pduStatuses, maintenance }), [devices, pduStatuses, maintenance]);
  const powerLatest = useRef(powerCtx);
  powerLatest.current = powerCtx;
  const powerGroups = useMemo(() => {
    const map = new Map();
    servers.forEach(s => { const key = serverIdentity(s.name); if (key && !map.has(key)) map.set(key, serverPowerGroup(s.name, powerCtx)); });
    return map;
  }, [servers, powerCtx]);
  const [powerPendingMap, setPowerPendingMap] = useState({});
  const [powerDialog, setPowerDialog] = useState(null);
  const powerEnabled = !!canOperate && !!onSwitchFeeds;
  const powerFor = useCallback(s => (powerEnabled ? powerGroups.get(serverIdentity(s.name)) || null : null), [powerEnabled, powerGroups]);
  const powerPending = useCallback(s => powerPendingMap[serverIdentity(s.name)] || null, [powerPendingMap]);
  const waitingFor = useCallback(s => pduStatuses[s.pduId] === undefined, [pduStatuses]);
  // After a feed-only request on a multi-feed server the toast says what still powers the server (a cycle of one feed
  // does not power-cycle a server that another feed keeps running).
  const powerToast = useCallback((serverName, action, results, { scope = "server", group = null } = {}) => {
    const server = serverDisplayName(serverName);
    const failed = (results || []).filter(r => !r.ok);
    const done = (results || []).filter(r => r.ok);
    const where = done.map(r => `${r.pduName} · outlet ${r.outlet}`).join(", ");
    if (failed.length) {
      showToast(<>Some outlets of <bdi>{server}</bdi> were not switched: {failed.map(r => `${r.pduName} outlet ${r.outlet}${r.error ? ` (${r.error})` : ""}`).join(", ")}.</>, "error");
      return;
    }
    const switched = new Set(done.map(r => `${r.pduId}:${r.outlet}`));
    const powered = scope === "feed" && action !== "on" ? (group?.feeds || []).filter(f => !switched.has(f.id) && f.state === "on") : [];
    if (powered.length && done.length === 1) {
      const still = powered.map(f => `${f.pduName} · outlet ${f.outlet}`).join(", ");
      showToast(action === "cycle"
        ? <><bdi>{done[0].label}</bdi> was power-cycled ({where}); <bdi>{server}</bdi> stayed powered by {still}, so it was not power-cycled.</>
        : <><bdi>{done[0].label}</bdi> is off ({where}); <bdi>{server}</bdi> is still powered by {still}.</>);
      return;
    }
    if (scope === "feed" && action === "on" && done.length === 1 && (group?.feeds.length || 0) > 1) {
      showToast(<><bdi>{done[0].label}</bdi> is on ({where}).</>);
      return;
    }
    showToast(<><bdi>{server}</bdi> is {action === "cycle" ? "power-cycled" : action} ({where}).</>);
  }, [showToast]);
  // The plan is checked again against the latest PDU readings; if the outlets changed, nothing is switched.
  const runPower = useCallback(async ({ serverName, action, scope, feedId, plan }) => {
    if (!powerEnabled) throw new Error("Viewer account: read only");
    const fresh = planServerPower(serverPowerGroup(serverName, powerLatest.current), action, scope, feedId);
    // A feed that became blocked (maintenance, protected outlet) refuses the whole request before any outlet switches.
    if (fresh.disabledReason) throw new Error(`${fresh.disabledReason} — nothing was switched.`);
    if (!sameTargets(plan, fresh)) throw new Error("The outlet mapping changed while the dialog was open — nothing was switched.");
    const key = serverIdentity(serverName);
    setPowerPendingMap(p => ({ ...p, [key]: action }));
    try { return await onSwitchFeeds(fresh.targets, action, { stopOnFailure: action === "off" }); }
    finally { setPowerPendingMap(p => { const next = { ...p }; delete next[key]; return next; }); }
  }, [powerEnabled, onSwitchFeeds]);
  // Every request on this page opens the in-app confirmation that names the outlets, Power on included: the account
  // preference confirm_power ("Ask before Power off and Power cycle") is not a reason to switch a server unasked here.
  const requestPower = useCallback((server, action, opener, { scope = "server", feedId = null } = {}) => {
    const group = powerGroups.get(serverIdentity(server.name));
    if (!group || !powerEnabled) return;
    const feed = feedId || `${server.pduId}:${server.outlet}`;
    setPowerDialog({ serverName: server.name, key: group.key, snapshot: group, action, scope, feedId: feed, allowScopeChoice: group.feeds.length > 1 && scope === "server" });
  }, [powerGroups, powerEnabled]);

  const serverActions = useMemo(()=>({
    kvmFor: name => kvmByServer.get(serverIdentity(name)) || null,
    openConsole: onOpenConsole || null,
    sshFor: name => serverIdentity(name) ? name : null,
    canOperate: !!canOperate,
    // Every feed of a server for its row's PDU chips (read-only, every role); powerFor stays Operator-only.
    feedsFor: s => powerGroups.get(serverIdentity(s.name)) || null,
    powerFor: powerEnabled ? powerFor : null, powerPending, requestPower: powerEnabled ? requestPower : null, waitingFor,
    // The SSH slot of every server row, the detail table, the phone list and the details dialogs (v2.41 SSH button).
    renderSsh: (server, size) => <RackSshButton server={server} compact={size === "sm"}/>,
  }),[kvmByServer,onOpenConsole,canOperate,powerEnabled,powerGroups,powerFor,powerPending,requestPower,waitingFor]);

  const handleReorder = useCallback((rackName,newIds)=>{
    if (!editMode) return;
    const edit = doc => ({ ...doc, [rackName]: newIds });
    const previous = rackOrder;
    setRackOrder(edit(rackOrder));
    setLayoutError("");
    persistLayout("/api/rack-positions", edit, setRackOrder, previous)
      .catch(e => setLayoutError(`The new order was not saved: ${e.message}`));
  },[rackOrder,editMode,persistLayout]);

  async function _reloadPositions() {
    const [positions, slots, switches] = await Promise.all([
      fetch("/api/rack-positions").then(r => r.json()).catch(() => ({})),
      fetch("/api/rack-slots").then(r => r.json()).catch(() => ({})),
      fetch("/api/switch-assignments").then(r => r.json()).catch(() => ({})),
    ]);
    setRackOrder(positions);
    setRackSlots(slots);
    setSwitchAssignments(switches);
  }

  // After any label change reload positions so renamed IDs stay in place
  const handleLabelChange = useCallback(async (pduId, newLabels) => {
    await onLabelChange(pduId, newLabels);
    await _reloadPositions();
  }, [onLabelChange]);

  // Global rename via dedicated endpoint — one call updates all PDUs, KVMs and DCIM files
  const handleRenameOpt = useCallback(async (oldName, newName) => {
    if (!onRenameOpt) return;
    await onRenameOpt(oldName, newName);
    await _reloadPositions();
  }, [onRenameOpt]);

  // Inline rename server (double-click in rack)
  const handleRenameServer = useCallback(async (server, newName) => {
    const pdu = pdus.find(p => p.id === server.pduId);
    if (!pdu) return;
    await handleLabelChange(server.pduId, { ...pdu.labels, [String(server.outlet)]: newName });
  }, [pdus, handleLabelChange]);

  // Inline rename custom item
  const handleRenameCustom = useCallback(async (item, newName) => {
    const rackName = Object.keys(customItems).find(r => customItems[r].some(i => i.id === item.id));
    if (!rackName) return;
    const updated = { ...customItems, [rackName]: customItems[rackName].map(i => i.id===item.id ? {...i, name: newName} : i) };
    await saveItems(updated).catch(() => {});
  }, [customItems, saveItems]);

  // Save custom item edits: only the changed fields, merged into the latest record
  const handleSaveCustom = useCallback(async (id, changes) => {
    const rackName = Object.keys(customItems).find(r => customItems[r].some(i => i.id === id));
    if (!rackName) return;
    const updated = { ...customItems, [rackName]: customItems[rackName].map(i => i.id===id ? {...i, ...changes} : i) };
    try {
      await saveItems(updated);
      setCustomPanel(p => ({...p, draft: null, notice: false}));
    } catch (e) {
      if (e.reloaded) setCustomPanel(p => ({...p, draft: changes}));
      throw e;
    }
  }, [customItems, saveItems]);

  // Delete custom item
  const handleDeleteCustom = useCallback(async (item) => {
    const rackName = Object.keys(customItems).find(r => customItems[r].some(i => i.id === item.id));
    if (!rackName) return;
    const updated = { ...customItems, [rackName]: customItems[rackName].filter(i => i.id !== item.id) };
    await saveItems(updated);
  }, [customItems, saveItems]);

  // Move custom item to a different rack
  const handleMoveCustom = useCallback(async (item, targetRack) => {
    const srcRack = Object.keys(customItems).find(r => customItems[r].some(i => i.id === item.id));
    if (!srcRack || srcRack === targetRack) return;
    const latest = customItems[srcRack].find(i => i.id === item.id);
    const updated = {
      ...customItems,
      [srcRack]: customItems[srcRack].filter(i => i.id !== item.id),
      [targetRack]: [...(customItems[targetRack] || []), { ...latest, u: 0, shelf_position: "" }],
    };
    await saveItems(updated);
  }, [customItems, saveItems]);

  // Derive live server data from servers list — no stale closure race possible
  const selectedServer = selectedServerId ? servers.find(s => s.id === selectedServerId) ?? null : null;

  const tabs=[
    {id:"racks",    label:"Racks",     icon:Icon.rack},
    {id:"inventory",label:"Inventory", icon:Icon.list},
    {id:"power",    label:"Power",     icon:Icon.bolt},
    {id:"changelog",label:"Changelog", icon:Icon.log},
  ];

  // The selected equipment and its rack, always from the latest list (no stale copy is ever edited or saved)
  const selectedCustomRack = selectedCustomId
    ? Object.keys(customItems).find(r => customItems[r].some(i => i.id === selectedCustomId)) ?? null
    : null;
  const selectedCustom = selectedCustomRack ? customItems[selectedCustomRack].find(i => i.id === selectedCustomId) : null;
  // Deleted in another session (seen in a reloaded list): its panel is gone, so equipment reloads resume.
  useEffect(() => { if (selectedCustomId != null && !selectedCustom) setSelectedCustomId(null); }, [selectedCustomId, selectedCustom]);

  // The open server's shelf, as its rack draws it ("U03" or "U03 (auto)").
  const selectedShelf = useMemo(() => {
    if (!selectedServer) return "";
    const rs = rackStats.find(x => x.rack === selectedServer.rack);
    if (!rs) return "—";
    const u = serverShelf(buildRackRows(rs.servers, rs.rack, rackOrder, rackSlots, customItems).uMap[selectedServer.id]);
    if (u == null) return "—";
    return `${shelfLabel(u)}${(rackSlots[rs.rack] || {})[selectedServer.id] == null ? " (auto)" : ""}`;
  }, [selectedServer, rackStats, rackOrder, rackSlots, customItems]);
  const selectedVisual = selectedServer ? visualFor(selectedServer) : null;
  const dialogUnit = coolingDialog?.mode === "create" ? { id: coolingDialog.newId, name: "", rack: coolingDialog.rack ?? racks.find(r => r !== MAIN_STORAGE) ?? null, u: null } : coolingDialog ? unitById(coolingDialog.unitId) : null;
  const powerGroupNow = powerDialog ? powerGroups.get(powerDialog.key) || powerDialog.snapshot : null;
  const loadBanner = (store, text, more = "") => loadErrors[store] && <div role="alert" className="racks-banner" data-store={store}>
    <span>{text} ({loadErrors[store]}).{more ? ` ${more}` : ""}</span> <button type="button" className="racks-link" onClick={() => reloadLayouts(false, true)}>Retry</button></div>;

  return (
    <EditContext.Provider value={editMode}><ServerActionsContext.Provider value={serverActions}><main className={`flex-1 px-4 pb-5 w-full mx-auto ${section === "racks" ? "racks-main" : ""}`}>
      {layoutError&&<div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-rose-900 bg-rose-950/30 px-3 py-2 text-sm text-rose-300"><span className="flex-1 break-words">{layoutError}</span><button type="button" className="underline text-xs" onClick={()=>setLayoutError("")}>Dismiss</button></div>}
      {section !== "changelog" && <>
        {loadBanner("items", "Equipment could not load", "Shelves may be missing items.")}
        {loadBanner("cooling", "Cooling units could not load")}
        {loadBanner("layout", "Shelf positions could not load")}
      </>}
      {!controlledSection && <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-sm font-bold tracking-tight text-zinc-100">DCIM</h2>
          <p className="text-[11px] text-zinc-400">{racks.length} rack{racks.length!==1?"s":""} · {servers.length} OPTs · {Object.values(customItems).flat().length} equipment items</p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
          {tabs.map(t=><TabBtn key={t.id} label={t.label} icon={t.icon} active={section===t.id} onClick={()=>setSection(t.id)}/>)}
        </div>
      </div>}

      {section!=="changelog"&&section!=="racks"&&(
        <KpiBar servers={servers} rackStats={rackStats} pdus={pdus} pduStatuses={pduStatuses}/>
      )}

      {section==="racks"&&(
        <RacksView selectedRack={rack} onSelectRack={onRackChange}
          rackStats={rackStats} rackSlots={rackSlots} rackOrder={rackOrder}
          switchAssignments={switchAssignments} customItems={customItems}
          onReorder={handleReorder}
          onSelect={s => setSelectedServerId(s.id)} onSelectCustom={selectCustom}
          onLabelChange={handleLabelChange} onSlotsChange={setRackSlots}
          onRenameServer={handleRenameServer} onRenameCustom={handleRenameCustom}
          onSaveItems={saveItems} onRefresh={onRefresh}
          pdus={pdus} rackDevices={rackDevices} optOwners={optOwners}
          pduStatuses={pduStatuses} base={rackView} cooling={coolingApi}/>
      )}
      {section==="inventory"&&<InventoryView servers={servers} switchAssignments={switchAssignments} rackSlots={rackSlots} customItems={customItems} optOwners={optOwners} ownersLoaded={ownersLoaded} onOwnerChange={handleOwnerChange}/>}
      {section==="power"&&<PowerView rackStats={rackStats}/>}
      {section==="changelog"&&<ChangelogView/>}

      {selectedServer&&!editMode&&<Portal>
        <ServerDetailsDialog server={selectedServer} visual={selectedVisual} owner={optOwners[selectedServer.id]} sw={switchAssignments[selectedServer.id]}
          shelf={selectedShelf} watts={(selectedVisual.state === "on" || selectedVisual.state === "off") ? reading(selectedServer.watts, 0, " W") : "—"}
          group={powerGroups.get(serverIdentity(selectedServer.name)) || null} pending={powerPending(selectedServer)} waiting={waitingFor(selectedServer)}
          onRequestPower={powerEnabled ? (action, el, opts) => requestPower(selectedServer, action, el, opts) : null}
          onClose={()=>setSelectedServerId(null)}
          consoleButton={canOperate && onOpenConsole && kvmByServer.get(serverIdentity(selectedServer.name)) ? <KvmButton server={selectedServer}/> : null} sshSlot={<SshSlot server={selectedServer} size="md"/>}/>
      </Portal>}
      {selectedServer&&editMode&&(
        <Portal>
          <ServerEditPanel server={selectedServer} pdus={pdus} rackDevices={rackDevices} rackSlots={rackSlots}
            switchAssignments={switchAssignments} optOwners={optOwners} ownersLoaded={ownersLoaded} onOwnerChange={handleOwnerChange}
            onRackOverrideChange={handleRackOverrideSave}
            onClose={()=>setSelectedServerId(null)}
            onLabelChange={handleLabelChange} onRenameOpt={handleRenameOpt}
            onSlotSave={handleSlotSave} onSwitchSave={handleSwitchSave}
            powerGroup={powerFor(selectedServer)} powerPending={powerPending(selectedServer)}
            onRequestPower={powerEnabled ? (action, el, opts) => requestPower(selectedServer, action, el, opts) : null}/>
        </Portal>
      )}

      {selectedCustom&&selectedCustomRack&&!editMode&&<Portal><ReadOnlyAsset item={{...selectedCustom,rack:selectedCustomRack}} owner={optOwners[`item:${selectedCustom.id}`]} sshName={["computer","server"].includes(selectedCustom.type)?selectedCustom.name:null} onClose={()=>selectCustom(null)}/></Portal>}
      {selectedCustom&&selectedCustomRack&&editMode&&(
        <Portal>
          <EditEquipmentPanel key={`${selectedCustom.id}:${customPanel.epoch}`} item={selectedCustom} rackName={selectedCustomRack}
            draft={customPanel.draft} reloaded={customPanel.notice}
            owner={optOwners[`item:${selectedCustom.id}`]||""} ownersLoaded={ownersLoaded} onOwnerChange={handleOwnerChange}
            allRacks={racks} onClose={()=>selectCustom(null)}
            onSave={handleSaveCustom} onDelete={handleDeleteCustom} onMove={handleMoveCustom}/>
        </Portal>
      )}

      {coolingDialog && dialogUnit && (() => {
        const mode = coolingDialog.mode === "edit" && !(editMode && coolingEditable) ? "view" : coolingDialog.mode;
        // A new key per mode: "Move…" in the view dialog opens a fresh edit dialog with the Rack select focused.
        return <Portal>
          <CoolingUnitDialog key={`${coolingDialog.unitId || coolingDialog.newId}:${mode}`} mode={mode}
            unit={dialogUnit} rackNames={racks} shelfOptionsFor={shelfOptionsFor} canOperate={!!canOperate}
            onRequestEdit={mode === "view" && canPlaceCooling ? () => editCooling(dialogUnit) : null}
            onSave={saveCoolingDialog} onTakeOffShelf={takeOffShelf} onClose={() => setCoolingDialog(null)}/>
        </Portal>;
      })()}
      {powerDialog && <Portal>
        <PowerConfirmDialog serverName={powerDialog.serverName} group={powerGroupNow} action={powerDialog.action} scope={powerDialog.scope}
          feedId={powerDialog.feedId} allowScopeChoice={powerDialog.allowScopeChoice}
          onConfirm={({ action, scope, feedId, plan }) => runPower({ serverName: powerDialog.serverName, action, scope, feedId, plan })}
          onClose={(done, results, action, scope) => { const name = powerDialog.serverName; setPowerDialog(null); if (done) powerToast(name, action, results, { scope, group: powerGroupNow }); }}/>
      </Portal>}
      {section === "racks" && <UndoToast toast={toast} onDismiss={dismissToast}/>}
    </main></ServerActionsContext.Provider></EditContext.Provider>
  );
}
