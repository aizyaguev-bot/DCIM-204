import { sumKnown, reading } from "../power";
import { useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef, useId, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { loadRackItems, saveRackItems, MAIN_STORAGE, detailText } from "../api/inventory";
import { loadLayout, saveLayout } from "../api/layout";
import { useLiveReload } from "../api/useLiveReload.js";
import { splitSections, sectionHeading, versionOf } from "../api/changelog";
import { SectionBody, plain } from "../components/WhatsNew";
import {useAccounts, accountRequest} from "../accounts";
import {OwnerSelect, useEngineers} from "../engineers";
import SshButton, { useSshStatus } from "../components/SshButton";
import { findServer } from "../api/ssh";
import { serverIdentity } from "../api/locations";
import { deviceState } from "../api/client";
import { serverVisualState, rackSummary, maintenanceFor, withCoolingRows, compactRows, rackFloors, RACK_FLOORS, buildSearchIndex, searchIndex, matchesFilter, floorOptions,
  FLOOR_UNIT_SLOTS, SHELF_SLOTS, splitSlots, moreText, serverFacts, midSplit } from "../components/racks/rackView.js";
import { STORAGE_SHELVES, floorsFor, placesWord, rackHasFloors, validFloor, setStorageRacks, storageRackNames } from "../components/racks/floors.js";
import { normalizeChillers, groupChillers, updateChiller, placeChiller, addChiller, newChillerId, assertKeepsUnits, describePlace, coolingChange, undoCoolingChange, validShelf, validPlace, placeWord, sameDocument } from "../components/racks/chillers.js";
import { BLOCK } from "../components/racks/serverPower.js";
import ServerPowerControl from "../components/racks/ServerPowerControl.jsx";
import CoolingUnitDialog from "../components/racks/CoolingUnitDialog.jsx";
import { CoolingChip, CoolingStrip, CoolingPanel } from "../components/racks/CoolingUnits.jsx";
import { RackKpis, RacksToolbar, filterEmptyText } from "../components/racks/RacksToolbar.jsx";
import { useRemovedServers } from "../removedServers.jsx";
import { withoutRemoved } from "../api/removedServers.js";
import UndoToast from "../components/racks/UndoToast.jsx";
import ScanUnitDialog from "../components/racks/ScanUnitDialog.jsx";
import ShelfLabelsDialog from "../components/racks/ShelfLabelsDialog.jsx";
import { buildShelfLabels } from "../shelfLabels.js";
import { floorServer, rowsUnitOwners, unitOwners, withUnitOwners, ownerOfUnit, ownerFromText } from "../unitOwner.js";
import { useStoredState, useMediaQuery, useDebounced, flash, prefersReducedMotion } from "../components/racks/hooks.js";
import { mergeServerFeeds } from "../labDisplay.js";
import { TWIN_ENABLED, rackRef } from "../twinLinks.js";
// The lab windows (window/CONTRACT.md): a server opens its window, a unit its unit window, a PDU or KVM its device
// window; a drag opens the server window on its move dialog; power goes through the provider's one power hook.
import { useLabWindow } from "../window/labWindowContext.js";
import { windowKey } from "../server/serverKey.js";
import AddServerDialog from "../server/AddServerDialog.jsx";

const EditContext = createContext(false);
// Server actions in the rack views: the KVM port of each server (by server identity), the console opener and SSH
// (sshFor, drawn through the SSH slot renderSsh), the server's power (feeds, pending request, the request that opens
// the in-app confirmation), scanning units onto a floor and adding a server ({ rack, u }: AddServerDialog).
const ServerActionsContext = createContext({ kvmFor: () => null, openConsole: null, sshFor: () => null, canOperate: false,
  powerFor: null, powerPending: () => null, requestPower: null, waitingFor: () => false, renderSsh: null, scanUnit: null, addServer: null });

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

// "Show in 3D" (every role): opens the 3D Twin tab on this rack (App's goTo("twin", { ref })). Nothing when DcimView
// has no twin link. The text button shows its whole name, "Show Rack-03 in 3D" (label in name). Servers and units show
// in 3D from their windows. blocked: why it cannot leave Racks now; it stays focusable, aria-disabled, and a click calls
// onBlocked instead.
const TwinLinkContext = createContext(null);
function ShowIn3dButton({ target, name, text = false, className = "icon-btn show-3d", blocked = null, onBlocked = null }) {
  if (!TWIN_ENABLED) return null;   // the 3D twin is switched off (twinLinks.js)
  const showIn3d = useContext(TwinLinkContext);
  if (!showIn3d || !target) return null;
  const label = `Show ${name} in 3D`;
  const open = e => { e.stopPropagation(); if (blocked) onBlocked?.(); else showIn3d(target); };
  const props = { type: "button", className, "data-action": "show-in-3d", "data-ref": target, "aria-disabled": blocked ? "true" : undefined, onClick: open };
  return text
    ? <button {...props} title={blocked || undefined}>{Icon.cube} Show <bdi>{name}</bdi> in 3D</button>
    : <button {...props} aria-label={label} title={blocked ? `${label}: ${blocked}` : label}>{Icon.cube}</button>;
}
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
  tag:   <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/></svg>,
  cube:  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"/></svg>,
};
const Spinner = () => (
  <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round"/>
  </svg>
);

// ─── custom item types ────────────────────────────────────────────────────────
// short: the type on a fixed-size unit chip of the floor template (the full label is its tooltip).
const ITEM_TYPES = {
  switch:     { label: "Switch",       short: "SW",    bg: "bg-cyan-900/25",   border: "border-cyan-800/50",   text: "text-cyan-300"   },
  computer:   { label: "Computer",     short: "PC",    bg: "bg-blue-900/25",   border: "border-blue-800/50",   text: "text-blue-300"   },
  patchpanel: { label: "Patch Panel",  short: "PATCH", bg: "bg-slate-800/40",  border: "border-slate-700/50",  text: "text-slate-300"  },
  cable:      { label: "Cable Mgmt",   short: "CABLE", bg: "bg-zinc-800/30",   border: "border-zinc-700/40",   text: "text-zinc-400"   },
  pdu:        { label: "PDU",          short: "PDU",   bg: "bg-amber-900/20",  border: "border-amber-800/50",  text: "text-amber-300"  },
  kvm:        { label: "KVM",          short: "KVM",   bg: "bg-purple-900/25", border: "border-purple-800/50", text: "text-purple-300" },
  ups:        { label: "UPS",          short: "UPS",   bg: "bg-green-900/20",  border: "border-green-800/50",  text: "text-green-300"  },
  blank:      { label: "Blank Panel",  short: "BLANK", bg: "bg-zinc-900/50",   border: "border-zinc-800/30",   text: "text-zinc-700"   },
  other:      { label: "Other",        short: "OTHER", bg: "bg-zinc-800/30",   border: "border-zinc-700/40",   text: "text-zinc-400"   },
};

// ─── helpers ─────────────────────────────────────────────────────────────────
export function isDefaultOutletLabel(label) {
  return !label || /^(outlet\s*\d+|port\s*\d+|\s*)$/i.test(label.trim());
}
// Outlet labels that are not computers ("empty", "KVM Power", placeholders such as "OptXXX": opt / optn followed only
// by x's, for a server not known yet) are not OPTs: they never take a U slot
// and are not counted. The 3D Twin (lab-twin/app.js NON_SERVER_LABEL) uses the same text, so both show the same shelves.
const NON_SERVER_LABEL = /^(empty|kvm[\s_-]*power|pdu|spare|free|n\/a|-+|optn?[\s_-]*x+)$/i;
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

// A storage rack's place choices for equipment: the whole unit (0) or one of its shelves 1-STORAGE_SHELVES. A saved value
// outside them (old data) is offered as its own choice, so opening the panel never changes it.
export function storageShelfOptions(current = "0") {
  const options = [{ value: "0", label: "Whole storage unit (no shelf)" }];
  for (let u = 1; u <= STORAGE_SHELVES; u++) options.push({ value: String(u), label: `Shelf ${u}` });
  const value = String(current ?? "0");
  if (!options.some(o => o.value === value)) options.push({ value, label: `${/^\d+$/.test(value) ? `Shelf ${value}` : `"${value}"`} · saved, not one of shelves 1–${STORAGE_SHELVES}` });
  return options;
}

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

  // A storage rack (Main storage, or a rack of type Storage) is a unit of STORAGE_SHELVES shelves.
  const storage = !rackHasFloors(rackName);

  // Assign U slots to servers (custom items no longer block server slots). In a storage rack an OPT with no saved shelf
  // goes on the next free shelf 1-STORAGE_SHELVES; when they are all taken it is with the whole storage (u 0), never on
  // a shelf above them (that is the "Other" line for old data).
  const uMap = {};
  sorted.forEach(s => { if (slots[s.id] != null) uMap[s.id] = Number(slots[s.id]); });
  let next = 1;
  sorted.forEach(s => {
    if (uMap[s.id] == null) {
      while (Object.values(uMap).includes(next)) next++;
      if (storage && next > STORAGE_SHELVES) uMap[s.id] = 0;
      else uMap[s.id] = next++;
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
  if (storage) {
    // A storage rack is a unit of STORAGE_SHELVES shelves: every shelf (an empty one too), then any occupied shelf above
    // them (old data, listed under "Other" by the card), then the whole-unit equipment.
    for (let u = 1; u <= STORAGE_SHELVES; u++) rows.push(row(u));
    [...groups.keys()].filter(u => u > STORAGE_SHELVES).sort((a, b) => a - b).forEach(u => rows.push(row(u)));
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

// A unit's name in its slot (the slot itself is the button that opens the unit window).
function InlineName({ value, className, mid = false }) {
  return <span title={value} dir="auto" className={`${className}${mid ? " mid-text" : ""} select-none`}>
    {mid ? <MidText text={value} keep={6}/> : value}
  </span>;
}

// ─── server row ───────────────────────────────────────────────────────────────
// The Racks view model the rows and cards read: row states, search hits, compacted shelves and cooling units.
const RackViewContext = createContext({
  visualFor: () => ({ state: "unknown", maintenance: false, word: "Unknown", title: "" }),
  summaryFor: null, matchKeys: null, rowKeep: null,
  coolingByRack: {}, coolingDrop: false, coolingDraggable: false, coolingEditable: false, coolingCanPlace: false,
  onOpenCooling: null, onPlaceCooling: null, onAddCooling: null, itemsError: false, onShelfLabels: null,
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

// The server's name is its open button (so Power, KVM and SSH are sibling buttons, never nested): a click opens the
// server window at once, in Edit mode too (no rename here: the window renames). hint: more about it for its tooltip.
function ServerName({ server, onOpen, hint = "" }) {
  return <button type="button" className="server-open" aria-label={`View ${server.name}`}
    title={`${server.name}${hint ? ` · ${hint}` : ""}`}
    onClick={e => { e.stopPropagation(); onOpen(); }}>
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

// The SSH host Lab Manager knows for a server (Operators and up get it from the /api/ssh/status snapshot the SSH buttons
// already share). Nothing when no host is known or when it is just the server's own name.
function ServerHost({ server }) {
  const { data } = useSshStatus();
  const known = findServer(data?.servers, server.name);
  const host = String(known?.approved_host || known?.host || "").trim();
  if (!host || serverIdentity(host) === serverIdentity(server.name)) return null;
  return <span className="unit-fact unit-host" data-fact="host" dir="ltr" title={`SSH host ${host}`}>{host}</span>;
}

// The "+N" chip of a full floor or shelf (the floor template, rackView.js splitSlots): a button that opens the rest of
// its items in a list over the floors below; Escape, a click elsewhere or the button again closes it. The floor never
// grows. match: a search hit is among the hidden items (the chip is highlighted like a hit).
function FloorMore({ kind, label, title, match = false, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const away = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return <div ref={ref} className="floor-more" data-floor-more={kind} data-open={open ? "" : undefined}
    onKeyDown={e => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); ref.current?.querySelector(".floor-more-toggle")?.focus(); } }}>
    <button type="button" className="floor-more-toggle" aria-expanded={open} aria-controls={listId} title={title} aria-label={label === title ? undefined : title}
      data-match={match ? "" : undefined} onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>{label}</button>
    <div id={listId} className="floor-more-list" role="group" aria-label={title} hidden={!open}>{children}</div>
  </div>;
}

// Opens the "+N" list that hides el (a search jump or a focus request lands on an item behind a "+N" chip).
function revealInFloor(el) {
  const more = el?.closest?.(".floor-more");
  if (more && !more.hasAttribute("data-open")) more.querySelector(".floor-more-toggle")?.click();
}

// One server in the floor template's server zone, two lines in a box of fixed height. Line 1: a status stripe on its
// left edge (the LED), the name, the state word (the meaning never depends on colour) and watts (Maintenance in their
// place), then KVM (a server with a console port), SSH and Power (view mode) at the line's end, SSH and Power always
// at the same place. Line 2: what else the app knows about it (a missing reading, owner, KVM console port, SSH host,
// switch port, PDU feeds), one line that ends in "…" when it is too long; every fact has its tooltip and the details
// have them all. In Edit mode the grip ⠿ at the start of line 1 drags it. more: the "+1 server" chip of a floor that
// holds more servers (old data), at the end of line 2.
// variant "chip": a storage shelf's unit slot (the same two lines, no actions; the details have them).
// data-feeds="partial": its feeds disagree (one on, one off), shown in amber like its Mixed switch.
function ServerCell({ server, sw, owner, onSelect, overlay = false, dragHandleProps = null, variant = "floor", more = null }) {
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
  const facts = serverFacts({ visual, owner, kvm, sw, feeds });
  const hint = facts.map(f => f.title).join(" · ");
  const watts = (visual.state === "on" || visual.state === "off") && Number.isFinite(server.watts) ? reading(server.watts, 0, " W") : null;
  const chip = variant === "chip";
  const showHost = !chip && canOperate && !!renderSsh && mode !== "legacy";
  const fact = f => <span key={f.key} className="unit-fact" data-fact={f.key} title={f.title} dir="auto">{f.text}</span>;
  return <div className={`server-cell unit-row${chip ? " server-chip" : ""}`} data-server={server.name} data-server-id={server.id} data-state={visual.state}
    data-variant={variant} data-feeds={partial ? "partial" : undefined}
    data-maintenance={visual.maintenance ? "" : undefined} data-match={matchKeys?.has(`s:${server.id}`) ? "" : undefined}
    title={chip ? `${server.name} · ${visual.word}${hint ? ` · ${hint}` : ""}` : undefined}
    onClick={e => {
      // A server listed behind this one's "+1 server" chip opens itself, never this one.
      if (e.target.closest(".server-cell") !== e.currentTarget || e.target.closest(".server-actions,input,.server-open,.shelf-grip")) return;
      const list = e.target.closest(".floor-more");
      if (list && e.currentTarget.contains(list)) return;
      open();
    }}>
    <span className="server-led" aria-hidden="true"/>
    <div className="unit-head">
      {editMode && !overlay && <div {...(dragHandleProps || {})} tabIndex={-1} className="shelf-grip" aria-label={`Move ${server.name}`} title="Drag to move" onClick={e => e.stopPropagation()}>{Icon.grip}</div>}
      <ServerName server={server} onOpen={open} hint={hint}/>
      <span className="unit-state">
        <span className="server-state" data-state={visual.state} title={visual.title}>{visual.word}</span>
        {!chip && visual.maintenance && <span className="maint-badge" title={BLOCK.maintenance}>Maintenance</span>}
        {!chip && watts && <span className="server-watts">{watts}</span>}
      </span>
    </div>
    {<div className="unit-facts" title={hint || undefined}>
      {facts.filter(f => f.key === "reading" || f.key === "owner" || f.key === "kvm").map(fact)}
      {showHost && <ServerHost server={server}/>}
      {facts.filter(f => f.key === "switch" || f.key === "feeds").map(fact)}
      {!facts.length && !showHost && <span className="unit-fact unit-fact-none">No other details</span>}
    </div>}
    {!chip && more}
    {!chip && !overlay && canOperate && <div className="server-actions unit-actions" data-edit={editMode ? "" : undefined} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      {!editMode && <RowPower server={server}/>}
      <KvmButton server={server} compact/>
      <SshSlot server={server} size="sm"/>
    </div>}
  </div>;
}

// A value cut in the middle when it is too long for its place (rackView.js midSplit): the head ends in "…" and the
// last characters always show, so values that differ only at the end ("…-1" / "…-2", "… name 1" / "… name 2") stay
// apart. The parent is a .mid-text box (one line).
function MidText({ text, keep = 5 }) {
  const { head, tail } = midSplit(text, keep);
  return <><span className="mid-head">{head}</span>{tail && <span className="mid-tail">{tail}</span>}</>;
}

// The serial number a unit slot, the detail table and the phone list show: the saved serial, else its barcode.
const unitSerial = item => detailText(item, "serial_number") || detailText(item, "barcode");

// The P/N and S/N cells of a row of the rack detail table (monospace, — when not recorded).
function UnitIdCells({ item }) {
  return <>{[["part_number", detailText(item, "part_number")], ["serial_number", unitSerial(item)]].map(([field, value]) =>
    <td key={field} className="racks-mono racks-id" data-field={field}>{value ? <bdi dir="auto">{value}</bdi> : <span className="racks-dash">—</span>}</td>)}</>;
}

// One labelled field of a unit slot ("P/N MQM8790-HS2F"): its label, then its value or "—"; a value too long for its
// place is cut in the middle (its end stays), and its tooltip has it whole.
function SlotField({ field, label, value }) {
  const text = String(value ?? "").trim();
  return <span className="slot-field" data-field={field} title={text ? `${label}: ${text}` : `${label}: not recorded`}>
    <span className="slot-label">{label}</span><span className="slot-value mid-text" dir="auto"><MidText text={text || "—"}/></span>
  </span>;
}

// A unit slot of the floor template that holds nothing: the same box and the same labelled places as a filled one.
function EmptySlot({ lines = 3 }) {
  return <div className="unit-slot unit-slot-empty" data-lines={lines} aria-hidden="true">
    <span className="slot-line"><SlotField field="name" label="Name" value=""/></span>
    <span className="slot-line"><SlotField field="part_number" label="P/N" value=""/></span>
    {lines > 2 && <span className="slot-line"><SlotField field="serial_number" label="S/N" value=""/></span>}
  </div>;
}

// One piece of equipment (switch, UPS, …) in a unit slot of the floor template (a floor's units row, a storage shelf, a
// "+N" list): a box of fixed size with its fields at fixed places, the same places as an empty slot. Line 1: "Name" and
// the name (a storage slot, two lines: the name alone, on the whole line); line 2: P/N (part number); line 3 (lines 3):
// S/N, on the whole line. Too long: cut in the middle, the end stays. Its type is the colour of its inline-start edge
// (and in its tooltip); model and MAC address are in its tooltip and its details. Enter or Space opens it.
// owner: its owner by the lab's rule (unitOwner.js); ownerFrom: the server on its floor it comes from. Both are in its
// tooltip and its accessible description (the slot keeps its fixed lines; the server beside it shows the same owner).
function EquipCell({ item, onSelect, lines = 3, owner = "", ownerFrom = null }) {
  const meta = ITEM_TYPES[item.type] || ITEM_TYPES.other;
  const { matchKeys } = useContext(RackViewContext);
  const ownerId = useId();
  const serial = unitSerial(item);
  const ownerText = owner ? `Owner ${owner}${ownerFrom?.name ? ` (from ${ownerFrom.name})` : ""}` : "";
  const tip = [`${meta.label}: ${item.name}`, detailText(item, "part_number") ? `P/N ${detailText(item, "part_number")}` : "", serial ? `SN ${serial}` : "",
    ownerText,
    detailText(item, "model") ? `Model ${detailText(item, "model")}` : "", detailText(item, "mac") ? `MAC ${detailText(item, "mac")}` : "",
    item.shelf_position ? `Position ${item.shelf_position}` : ""].filter(Boolean).join(" · ");
  return <div className="equipment-cell unit-slot" data-type={ITEM_TYPES[item.type] ? item.type : "other"} data-item-id={item.id} data-lines={lines} data-match={matchKeys?.has(`e:${item.id}`) ? "" : undefined}
    data-owner={owner || undefined} data-owner-from={ownerFrom?.name || undefined}
    onClick={() => onSelect?.(item)} role="button" tabIndex={0} aria-label={`View ${item.name}`} aria-describedby={ownerText ? ownerId : undefined} title={tip}
    onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect?.(item); } }}>
    {ownerText && <span id={ownerId} className="sr-only" dir="auto">{ownerText}</span>}
    <span className="slot-line slot-name">
      {lines > 2 && <span className="slot-label">Name</span>}
      <InlineName value={item.name} className="equipment-name" mid/>
    </span>
    <span className="slot-line"><SlotField field="part_number" label="P/N" value={detailText(item, "part_number")}/></span>
    {lines > 2 && <span className="slot-line"><SlotField field="serial_number" label="S/N" value={serial}/></span>}
  </div>;
}

// A cooling unit on a floor or in a rack's strip; in Edit mode on the overview it can also be dragged (pointer only).
// In a unit slot (variant "slot") it shows the same fixed lines as equipment (Name, P/N, S/N; a storage slot: name and
// P/N), its cooling colour on its inline-start edge.
function RackCoolingChip({ unit, variant, lines = 3 }) {
  const editMode = useContext(EditContext);
  const { coolingDraggable, onOpenCooling, onPlaceCooling, matchKeys } = useContext(RackViewContext);
  const drag = useDraggable({ id: `cooling:${unit.id}`, disabled: !coolingDraggable, data: { unit } });
  const place = variant === "strip" && !editMode && onPlaceCooling;
  const extra = variant === "slot" ? <>
    <span className="slot-line slot-name">
      {lines > 2 && <span className="slot-label">Name</span>}
      <span dir="auto" className="cooling-name equipment-name mid-text"><MidText text={unit.name} keep={6}/></span>
    </span>
    <span className="slot-line"><SlotField field="part_number" label="P/N" value={detailText(unit, "part_number")}/></span>
    {lines > 2 && <span className="slot-line"><SlotField field="serial_number" label="S/N" value={unitSerial(unit)}/></span>}
  </> : null;
  return <CoolingChip unit={unit} variant={variant} onOpen={place || onOpenCooling} actionLabel={place ? "Place…" : null}
    highlighted={!!matchKeys?.has(`c:${unit.id}`)} dragHandle={coolingDraggable ? drag : null} extra={extra} lines={lines}/>;
}

// The label on the left of a shelf: a rack's floors are 1-4 (1 at the top), a shelf above them "U5"…; a storage rack's
// shelves are 1-16 ("Shelf 7"), a shelf above them (old data) keeps its number.
function shelfIndex(u, floors, auto) {
  if (!u) return { text: "—", title: floors ? "Rack level (no shelf)"
    : auto ? `Whole storage unit (no shelf). Auto-placed: an OPT here has no saved shelf and shelves 1-${STORAGE_SHELVES} are taken; set its shelf in Edit mode.` : "Whole storage unit (no shelf)" };
  const autoTitle = `Auto-placed — no saved U for this OPT; it is shown on the next free ${floors ? "floor" : "shelf"} (${u}). Set its U in Edit mode to keep it here.`;
  if (!floors) return { text: String(u), title: auto ? autoTitle : u > STORAGE_SHELVES ? `Shelf ${u}: not one of the ${STORAGE_SHELVES} storage shelves (check its saved U)` : `Shelf ${u}` };
  if (u > RACK_FLOORS) return { text: `U${u}`, title: auto ? autoTitle : `U${u}: not one of the rack's ${RACK_FLOORS} floors (check its saved U)` };
  return { text: String(u), title: auto ? autoTitle : `Floor ${u}${u === 1 ? " (top)" : u === RACK_FLOORS ? " (bottom)" : ""}` };
}

// One floor in the floor template: a box of the same size on every floor of every rack, filled or empty. Its number
// (with the "+" that scans a unit onto it) | the server zone: its server (a floor with more servers, old data, shows the
// first and a "+1 server" chip), or "Free" | under it, the units row: a fixed number of unit slots (unitSlots), each a
// box of fixed size with the unit's labelled fields (name, P/N, S/N · model · MAC); a slot with nothing in it keeps its
// place and its labels. More units than slots: every slot shows a unit and a small "+N" chip at the end of the last
// slot's first line opens the rest. A storage shelf (floors false) is one row of `slots` unit slots for everything on
// it, servers and units alike ("+N" on the last); never servers | units.
function USlotGroup({ rack, u, items, auto, switchAssignments, optOwners, onSelectServer, onSelectCustom, sortable = false, floors = true, slots = SHELF_SLOTS.card, unitSlots = FLOOR_UNIT_SLOTS.card }) {
  const { coolingByRack, coolingDrop, matchKeys, onShelfLabels } = useContext(RackViewContext);
  const { scanUnit, addServer } = useContext(ServerActionsContext);
  const editMode = useContext(EditContext);
  const cooling = u > 0 ? coolingByRack?.[rack]?.placed?.[u] || [] : [];
  // Only a place the cooling dialog offers takes a cooling drop: floors 1-RACK_FLOORS (a storage rack: shelves
  // 1-STORAGE_SHELVES), never a row on the card's "Other" line (old data above them).
  const { setNodeRef, isOver } = useDroppable({ id: `shelf:${rack}:${u}`, disabled: !coolingDrop || !validPlace(u, rack) });
  const servers = items.filter(i => i.kind === "server");
  const equipment = items.filter(i => i.kind === "custom");
  const index = shelfIndex(u, floors, auto);
  const word = floors ? "floor" : "shelf";
  const where = u ? `${word} ${u}` : floors ? "the rack level" : "the whole storage";
  // "+" under the floor number: add a unit on this floor, beside its server (scan, type or pick its barcode/serial);
  // on a storage shelf: add a unit to this shelf.
  const names = floors ? servers.map(({ data }) => data.name).join(", ") : "";
  const addText = `Add a unit ${floors ? "on" : "to"} ${word} ${u}${names ? ` beside ${names}` : ""}`;
  const addHere = scanUnit && validFloor(u, rack)
    ? <button type="button" className="floor-add" data-floor-add={u} onClick={() => scanUnit({ rack, u, label: names, fixed: true })}
        aria-label={addText} title={`${addText} (scan its barcode)`}>+</button>
    : null;
  // Its shelf label (project, owner, server; ShelfLabelsDialog): a small tag under the "+" of a floor; a storage shelf has
  // no room for a third line, so its number is the button. Only a floor or shelf with a server or a unit has a label.
  const labelled = !!onShelfLabels && validFloor(u, rack) && items.length > 0;
  const labelName = `Label for ${rack} ${word} ${u}`;
  const labelTitle = `Shelf label · ${rack} · ${floors ? "Floor" : "Shelf"} ${u}`;
  const number = labelled && !floors
    ? <button type="button" className="floor-label floor-label-number" data-floor-label={u} aria-label={labelName} title={labelTitle}
        onClick={() => onShelfLabels({ rack, u })}>{index.text}</button>
    : <span>{index.text}</span>;
  const labelHere = labelled && floors
    ? <button type="button" className="floor-label" data-floor-label={u} aria-label={labelName} title={labelTitle}
        onClick={() => onShelfLabels({ rack, u })}>{Icon.tag}</button>
    : null;
  const indexCell = <span className="shelf-index" title={index.title}>{number}{addHere}{labelHere}</span>;
  const empty = !items.length && !cooling.length;
  const Row = sortable ? SortableServerRow : ServerCell;
  const serverRow = (data, variant, more = null) => <Row key={data.id} server={data} sw={switchAssignments[data.id]} owner={optOwners?.[data.id]}
    onSelect={onSelectServer} variant={variant} more={more}/>;
  // Each unit as a slot (lines: 3 on a floor, 2 on a storage shelf; the "+N" list shows all 3). optOwners is the shown
  // map (withUnitOwners): a unit's owner is the owner of the server on this floor (ownerServer), else its own.
  const ownerServer = floorServer({ u, items });
  const units = [
    ...equipment.map(({ data }) => ({ key: `e:${data.id}`, el: lines => <EquipCell key={data.id} item={data} lines={lines} onSelect={onSelectCustom}
      owner={ownerOfUnit(optOwners, data.id)} ownerFrom={ownerServer}/> })),
    ...cooling.map(unit => ({ key: `c:${unit.id}`, el: lines => <RackCoolingChip key={unit.id} unit={unit} variant="slot" lines={lines}/> })),
  ];
  const hit = list => !!matchKeys && list.some(x => matchKeys.has(x.key));
  const common = { ref: setNodeRef, "data-u-slot": u, "data-auto": auto ? "" : undefined, "data-over": isOver ? "" : undefined, "data-empty": empty ? "" : undefined };
  if (!floors) {
    const all = [...servers.map(({ data }) => ({ key: `s:${data.id}`, el: () => serverRow(data, "chip") })), ...units];
    const { shown, rest, more } = splitSlots(all, slots);
    const free = slots - shown.length;
    const last = shown.length - 1;
    return <div {...common} data-shelf-list="" className="floor-box shelf-line shelf-row">
      {indexCell}
      <div className="shelf-list" role="list" aria-label={u ? `Shelf ${u}${empty ? " (free)" : ""}` : "Whole storage unit"} style={{ "--slots": slots }}>
        {shown.map((x, i) => <div key={x.key} role="listitem" className="shelf-list-item" data-more={more > 0 && i === last ? "" : undefined}>
          {x.el(2)}
          {more > 0 && i === last && <FloorMore kind="shelf" label={`+${more}`} title={`${more} more on ${where}`} match={hit(rest)}>
            {rest.map(r => <div key={r.key} className="floor-more-item">{r.el(3)}</div>)}
          </FloorMore>}
        </div>)}
        {Array.from({ length: free }, (_, i) => <div key={`free-${i}`} className="shelf-list-item"><EmptySlot lines={2}/></div>)}
      </div>
    </div>;
  }
  const [first, ...extra] = servers;
  const moreServers = extra.length ? <FloorMore kind="servers" label={moreText(extra.length, "server")}
    title={`${extra.length} more ${extra.length === 1 ? "server" : "servers"} on ${where}`} match={hit(extra.map(({ data }) => ({ key: `s:${data.id}` })))}>
    {extra.map(({ data }) => <div key={data.id} className="floor-more-item">{serverRow(data, "floor")}</div>)}
  </FloorMore> : null;
  const { shown, rest, more } = splitSlots(units, unitSlots);
  const free = unitSlots - shown.length;
  const last = shown.length - 1;
  return <div {...common} className="floor-box shelf-row" data-cooling-only={!items.length && cooling.length ? "" : undefined}
    data-units={units.length ? "" : undefined}>
    {indexCell}
    <div className="floor-servers" data-more-servers={extra.length ? "" : undefined}>
      {first ? serverRow(first.data, "floor", moreServers)
        : editMode && addServer && validFloor(u, rack)
          ? <button type="button" className={empty ? "shelf-empty-line" : "floor-no-server"} data-action="add-server-floor" data-floor={u}
              aria-label={`Add a server on ${where} of ${rack}`} title={`Add a server on ${where} of ${rack}`} onClick={() => addServer({ rack, u })}>+ Add server</button>
          : <span className={empty ? "shelf-empty-line" : "floor-no-server"} title={u ? `No server on ${where}` : "Equipment for the whole rack, on no floor"}>{u ? "Free" : "Rack level"}</span>}
    </div>
    <div className="floor-units" role="list" aria-label={`Units on ${where}`} style={{ "--slots": unitSlots }}>
      {shown.map((x, i) => <div key={x.key} role="listitem" className="floor-unit" data-more={more > 0 && i === last ? "" : undefined}>
        {x.el(3)}
        {more > 0 && i === last && <FloorMore kind="units" label={`+${more}`} title={`${more} more ${more === 1 ? "unit" : "units"} on ${where}`} match={hit(rest)}>
          {rest.map(r => <div key={r.key} className="floor-more-item">{r.el(3)}</div>)}
        </FloorMore>}
      </div>)}
      {Array.from({ length: free }, (_, i) => <div key={`free-${i}`} className="floor-unit"><EmptySlot lines={3}/></div>)}
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

// The load bar; a rack without a reading keeps its (empty) place, so the floors of the cards in a grid row line up.
function LoadBar({ r, keepPlace = false }) {
  const pct = loadPercent(r);
  if (!r.pduOnline || pct == null) return keepPlace ? <div className="rack-load rack-load-none" aria-hidden="true"/> : null;
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
  if (summary.coolingUnplaced) parts.push(`${summary.coolingUnplaced} cooling ${summary.coolingUnplaced === 1 ? "unit needs" : "units need"} a ${placeWord(r.rack)}`);
  return parts.length ? parts.join(" · ") : summary.total ? `All ${summary.total} on` : "No servers";
}

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "rack";

// ─── RACK DIAGRAM ─────────────────────────────────────────────────────────────
// One rack card: header (name opens the detail), figures, load bar, its four floors (plus an "Other" line for anything
// on a U above floor 4, and the rack level) and the rack's cooling units that are not on a floor. Every floor is the same
// fixed template (USlotGroup), so the floors of all cards line up. A storage rack draws its 16 shelves the same way, each
// shelf one line of chips. In the rack detail (detail) the header is plain text and the template is larger.
function RackDiagram({ r, rackSlots, switchAssignments, rackOrder, customItems, optOwners, onReorder, onSelect, onSelectCustom, onHeaderClick, onEdit, fixed = false, external = false, externalActiveId = null, detail = false, collapsed = false, onToggleCollapse = null }) {
  const {canAdmin} = useAccounts();
  const editMode = useContext(EditContext);
  const view = useContext(RackViewContext);
  const [localActiveId, setLocalActiveId] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const { setNodeRef, isOver } = useDroppable({ id: "rack:" + r.rack, disabled: !editMode || detail });
  const strip = useDroppable({ id: `strip:${r.rack}`, disabled: !view.coolingDrop || detail });
  const built = useMemo(() => buildRackRows(r.servers, r.rack, rackOrder, rackSlots, customItems), [r.servers, r.rack, r.rackType, rackOrder, rackSlots, customItems]);
  const cooling = view.coolingByRack?.[r.rack];
  const coolingUs = useMemo(() => Object.keys(cooling?.placed || {}).map(Number), [cooling]);
  const rows = useMemo(() => withCoolingRows(built.rows, coolingUs), [built.rows, coolingUs]);
  const keep = view.rowKeep;
  const floors = rackHasFloors(r.rack);
  const count = floorsFor(r.rack);
  // A floor's unit slots and a storage shelf's slots (one each today; the detail could take more, except on a phone).
  const phone = useMediaQuery("(max-width: 640px)");
  const slots = detail && !phone ? SHELF_SLOTS.detail : SHELF_SLOTS.card;
  const unitSlots = detail && !phone ? FLOOR_UNIT_SLOTS.detail : FLOOR_UNIT_SLOTS.card;
  // Floors 1-4 (a storage rack: shelves 1-16) always (an empty one is one "Free" slot, never folded); a search still
  // folds the floors it hides.
  const display = useMemo(() => {
    const opts = { editMode, coolingUs: new Set(coolingUs), keep: keep ? row => keep(r.rack, row) : null };
    const parts = rackFloors(rows, opts.coolingUs, count);
    const other = compactRows(parts.other, { ...opts, showEmpty: true });
    return [...compactRows(parts.floors, { ...opts, showEmpty: true }), ...(other.length ? [{ kind: "other" }] : []), ...other, ...compactRows(parts.level, opts)];
  }, [rows, count, editMode, coolingUs, keep, r.rack]);
  const ids = built.sorted.map(s => s.id);
  const activeId = external ? externalActiveId : localActiveId;
  const summary = view.summaryFor ? view.summaryFor(r) : rackSummary(r, {});
  const titleId = `rack-${slug(r.rack)}-title${detail ? "-detail" : ""}`;
  const shelvesId = `rack-${slug(r.rack)}-shelves${detail ? "-detail" : ""}`;
  function endDrag({ active, over }) {
    setLocalActiveId(null);
    if (!editMode || !over || active.id === over.id) return;
    const from = ids.indexOf(active.id), to = ids.indexOf(over.id);
    if (from >= 0 && to >= 0) onReorder(r.rack, arrayMove(ids, from, to), { activeId: active.id, overId: over.id });
  }
  const content = <SortableContext items={ids} strategy={verticalListSortingStrategy}>
    {display.map(entry => {
      if (entry.kind === "other") return <p key="other" className="floors-other" role="note">Other · not on {placesWord(r.rack)} 1–{count}</p>;
      if (entry.kind === "gap") {
        const pad = n => (!floors || n <= count ? String(n) : String(n).padStart(2, "0"));
        const range = entry.from === entry.to ? pad(entry.from) : `${pad(entry.from)}–${pad(entry.to)}`;
        return <div key={`gap-${entry.from}`} className="shelf-gap" role="note" data-from={entry.from} data-to={entry.to} data-reason={entry.reason}>{range} · {entry.reason === "filtered" ? "hidden by filter" : "empty"}</div>;
      }
      const {u, items, auto} = entry.row;
      const props = {rack: r.rack, u, items, auto, floors, slots, unitSlots, switchAssignments, optOwners, onSelectServer: onSelect, onSelectCustom};
      return items.some(i => i.kind === "server") ? <SortableURow key={u} {...props} isDragging={editMode && items.some(i => i.data.id === activeId)}/> : <USlotGroup key={u} {...props}/>;
    })}
    {!rows.length && <p className="text-xs text-zinc-400 py-12 text-center">No equipment stored here</p>}
  </SortableContext>;
  return <section data-rack-id={r.rack} data-status={summary.status} data-maintenance={summary.maintenancePdus.length ? "" : undefined}
    data-collapsed={collapsed ? "" : undefined} data-detail={detail ? "" : undefined} data-rack-type={floors ? "compute" : "storage"}
    aria-labelledby={titleId} ref={external ? setNodeRef : undefined}
    className={`rack-card min-w-0 ${fixed ? `w-full lg:shrink-0 lg:max-w-[560px]${detail ? " xl:max-w-[640px] 2xl:max-w-[760px]" : ""}` : "w-full"} ${editMode && isOver ? "ring-2 ring-nv-400/40" : ""}`}>
    <header className="rack-card-header">
      <h3 id={titleId} className="rack-card-title">{onHeaderClick
        ? <button type="button" className="rack-card-name" onClick={onHeaderClick} title={`Open ${r.rack} details`}><span dir="auto">{r.rack}</span><svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg></button>
        : <span className="rack-card-name-static">{detail ? <>Shelves · <bdi>{r.rack}</bdi></> : <bdi>{r.rack}</bdi>}</span>}</h3>
      <div className="rack-card-badges">
        {!detail && <span className={`rack-status ${summary.status}`}>{summary.statusText}</span>}
        {!detail && summary.maintenancePdus.length > 0 && <span className="maint-badge" title={`In maintenance: ${summary.maintenancePdus.join(", ")}`}>Maintenance</span>}
        {!detail && view.onShelfLabels && <button type="button" className="icon-btn rack-labels" aria-label={`Shelf labels for ${r.rack}`} title="Shelf labels"
          onClick={() => view.onShelfLabels({ rack: r.rack })}>{Icon.tag}</button>}
        {!detail && floors && <ShowIn3dButton target={rackRef(r.rack)} name={r.rack}/>}
        {editMode && canAdmin && onEdit && <button type="button" className="icon-btn" aria-label={`Edit ${r.rack}`} title="Edit rack" onClick={onEdit}>{Icon.edit}</button>}
        {onToggleCollapse && <button type="button" className="icon-btn rack-collapse" aria-expanded={!collapsed} aria-controls={shelvesId}
          aria-label={`${collapsed ? "Show" : "Hide"} shelves of ${r.rack}`} onClick={onToggleCollapse}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>}
      </div>
    </header>
    {!detail && <RackFigures r={r} summary={summary} equipment={(customItems[r.rack] || []).length} itemsError={view.itemsError}/>}
    {!detail && <LoadBar r={r} keepPlace/>}
    {collapsed && <p className="rack-attention">{attentionText(r, summary)}</p>}
    {view.itemsError && <p className="rack-note" role="note">Equipment could not load</p>}
    <div id={shelvesId} className="rack-shelves" hidden={collapsed}>{external ? content : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={e => { if (editMode) setLocalActiveId(e.active.id); }} onDragEnd={endDrag} onDragCancel={() => setLocalActiveId(null)}>{content}</DndContext>}</div>
    {!detail && !collapsed && <CoolingStrip rack={r.rack} units={cooling} canEdit={view.coolingEditable} editMode={editMode}
      onOpen={view.onOpenCooling} onAdd={view.onAddCooling} dropRef={view.coolingDrop ? strip.setNodeRef : null} isOver={strip.isOver}
      renderChip={unit => <RackCoolingChip key={unit.id} unit={unit} variant="strip"/>}/>}
  </section>;
}

// A storage rack's place select for equipment (storageShelfOptions).
function StorageShelfSelect({ value, onChange, className, describedBy, label = "Shelf" }) {
  return <select value={value} onChange={e => onChange(e.target.value)} aria-label={label} aria-describedby={describedBy} className={className}>
    {storageShelfOptions(value).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>;
}

// ─── ADD EQUIPMENT MODAL ──────────────────────────────────────────────────────
function AddEquipmentModal({ rackName, onClose, onSave, onScan = null }) {
  useEscClose(onClose);
  const [name,  setName]  = useState("");
  const [type,  setType]  = useState("switch");
  // A storage rack (Main storage, or a rack of type Storage) offers its shelves; a rack its U slots.
  const storage = !rackHasFloors(rackName);
  const [u,     setU]     = useState(storage ? "0" : "");
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
          {onScan && <div className="scan-unit-entry">
            <button type="button" onClick={() => onScan(slot)} className="racks-btn racks-btn-accent">Scan barcode</button>
            <span className="text-[11px] text-zinc-400">Scan the unit instead: name, type and place are filled in and saved for you.</span>
          </div>}
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
          {storage ? <div><SL>Shelf</SL>
            <StorageShelfSelect value={u} onChange={setU} className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50"/>
          </div> : <div><SL>U slot (0 = whole rack)</SL>
            <input type="number" min="0" max="42" step="1" value={u} onChange={e => setU(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="e.g. 7" aria-label="U slot" aria-invalid={uError ? true : undefined} aria-describedby={uError ? "add-equipment-u-error" : undefined}
              className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm focus:outline-none placeholder:text-zinc-700 ${uError ? "border-rose-700 focus:border-rose-500" : "border-zinc-700/50 focus:border-nv-400/50"}`}/>
            {uError && <div id="add-equipment-u-error" role="alert" className="mt-1 text-[11px] text-rose-400">{uError}</div>}
          </div>}
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

// kvms: the rack's KVMs ({ id, name, ip, status }); its PDUs and KVMs open their device windows (onOpenDevice(id)).
function RackDetailView({ r, rackSlots, switchAssignments, rackOrder, customItems, optOwners, onBack, onReorder, onSelect, onSelectCustom, onAddServer = null, kvms = [], onOpenDevice = null, onRequestAddEquip, onEdit, phone, detailView, onDetailView }) {
  const { rows, uMap, sorted } = useMemo(
    () => buildRackRows(r.servers, r.rack, { [r.rack]: rackOrder[r.rack] }, { [r.rack]: rackSlots[r.rack] }, customItems),
    [r.servers, r.rack, rackOrder, rackSlots, customItems]
  );
  // optOwners is the shown map (withUnitOwners); ownerFrom: the server on its floor a unit's owner comes from.
  const ownerFrom = useMemo(() => rowsUnitOwners(rows, optOwners), [rows, optOwners]);
  const editMode = useContext(EditContext);
  const view = useContext(RackViewContext);
  const { scanUnit } = useContext(ServerActionsContext);
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
  // A storage rack names its places "Shelf 7" and "Whole storage"; a rack "U7" and "Rack level".
  const storage = !rackHasFloors(r.rack);
  const place = u => (u ? (storage ? `Shelf ${u}` : `U${u}`) : storage ? "Whole storage" : "Rack level");
  const uText = e => {
    if (e.kind === "server") return e.u == null ? place(0) : `${place(e.u)}${slots[e.data.id] == null ? " (auto)" : ""}`;
    return place(e.u);
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
        {view.onShelfLabels && <button type="button" className="racks-btn racks-btn-sm" data-action="shelf-labels" onClick={() => view.onShelfLabels({ rack: r.rack })}>{Icon.tag} Shelf labels</button>}
        {/* A storage rack has no place in the 3D twin (lab-data.json maps only Rack-01..07): no button that can only fail. */}
        {rackHasFloors(r.rack) && <ShowIn3dButton target={rackRef(r.rack)} name={r.rack} text className="racks-btn racks-btn-sm"/>}
      </div>
      <RackFigures r={r} summary={summary} equipment={equipment.length} itemsError={view.itemsError} detail/>
      <LoadBar r={r}/>
      {pdus.length + kvms.length > 0 && <ul className="rack-detail-pdus" aria-label="PDUs and KVMs">
        {[...pdus.map(p => { const d = r.pduData.find(x => x.id === p.id); return { id: p.id, name: p.name, ip: p.ip, kind: "PDU", st: d?.reachable === true ? "online" : d?.reachable === false ? "offline" : "unknown" }; }),
          ...kvms.map(k => ({ id: k.id, name: k.name, ip: k.ip, kind: "KVM", st: k.status }))].map(dev =>
          <li key={dev.id} data-status={dev.st} data-device={dev.id} data-kind={dev.kind.toLowerCase()}><span className="dot" aria-hidden="true"/>
            {onOpenDevice ? <button type="button" className="racks-link" data-action="open-device" title={`Open ${dev.name}`} onClick={() => onOpenDevice(dev.id)}><bdi>{dev.name}</bdi></button> : <bdi>{dev.name}</bdi>}
            {" "}· {dev.st === "online" ? "Online" : dev.st === "offline" ? "Offline" : "No reading"} · <span className="racks-mono">{dev.ip}</span></li>)}
      </ul>}
      {editMode && <div className="rack-detail-actions">
        <button type="button" onClick={() => onRequestAddEquip(r.rack)} className="racks-btn">{Icon.plus} Equipment</button>
        {scanUnit && <button type="button" onClick={() => scanUnit({ rack: r.rack })} className="racks-btn racks-btn-accent">Scan barcode</button>}
        {onAddServer && r.pduData.length > 0 && <button type="button" data-action="add-server-rack" onClick={() => onAddServer(r.rack)} className="racks-btn racks-btn-accent">{Icon.plus} Server</button>}
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
          fixed detail/>}

        {/* Right panel: full width in the phone column, so its table scrolls inside instead of widening the page */}
        <div className="w-full flex-1 min-w-0 space-y-4">
          {!phone && <div className="rack-detail-table">
            <div className="racks-table-wrap">
              <table className="racks-table">
                <caption className="sr-only">Everything in {r.rack}, by shelf</caption>
                <thead><tr>{["U","Name","P/N","S/N","Type","State","W","Owner","Outlet","Switch","Notes","Actions"].map(h => <th key={h} scope="col" className={h === "W" || h === "Outlet" ? "num" : undefined}>{h === "U" && storage ? "Shelf" : h}</th>)}</tr></thead>
                <tbody>
                  {entries.map(e => {
                    if (e.kind === "server") {
                      const s = e.data, sw = switchAssignments[s.id], visual = view.visualFor(s), owner = optOwners?.[s.id];
                      return <tr key={`s:${s.id}`} data-server={s.name} data-state={visual.state} data-match={view.matchKeys?.has(`s:${s.id}`) ? "" : undefined}>
                        <td className={`racks-mono ${slots[s.id] == null ? "italic" : ""}`} title={slots[s.id] == null ? "Auto-placed — no saved U for this OPT" : undefined}>{uText(e)}</td>
                        <td><button type="button" className="server-open" aria-label={`View ${s.name}`} onClick={() => onSelect(s)}><span dir="auto" className="server-name">{s.name}</span></button></td>
                        <UnitIdCells item={s}/>
                        <td>OPT</td>
                        <td><span className="server-state" data-state={visual.state} title={visual.title}>{visual.word}</span>{visual.maintenance && <> <span className="maint-badge">Maintenance</span></>}</td>
                        <td className="num racks-mono">{(visual.state === "on" || visual.state === "off") && Number.isFinite(s.watts) ? s.watts.toFixed(0) : <Dash/>}</td>
                        <td>{owner ? <bdi dir="auto">{owner}</bdi> : <Dash/>}</td>
                        <td className="num racks-mono">{s.outlet != null ? `#${s.outlet}` : <Dash/>}</td>
                        <td dir="auto">{sw?.switch ? `${sw.switch}${sw.port ? `:${sw.port}` : ""}` : <Dash/>}</td>
                        <td><Dash/></td>
                        <td><div className="server-actions">{!editMode && <RowPower server={s}/>}<KvmButton server={s} compact/><SshSlot server={s} size="sm"/></div></td>
                      </tr>;
                    }
                    const item = e.data, meta = ITEM_TYPES[item.type] || ITEM_TYPES.other, owner = ownerOfUnit(optOwners, item.id);
                    const from = ownerFromText(ownerFrom[item.id]?.server, storage);
                    return <tr key={`e:${item.id}`} data-item-id={item.id} data-match={view.matchKeys?.has(`e:${item.id}`) ? "" : undefined}>
                      <td className="racks-mono">{uText(e)}</td>
                      <td><button type="button" className="server-open" aria-label={`View ${item.name}`} onClick={() => onSelectCustom(item)}><span dir="auto" className="server-name">{item.name}</span></button></td>
                      <UnitIdCells item={item}/>
                      <td>{meta.label}</td>
                      <td><Dash/></td><td className="num"><Dash/></td>
                      <td data-field="owner" title={from || undefined}>{owner ? <bdi dir="auto">{owner}</bdi> : <Dash/>}</td>
                      <td className="num"><Dash/></td><td><Dash/></td>
                      <td dir="auto">{item.notes || <Dash/>}</td>
                      <td/>
                    </tr>;
                  })}
                  {!entries.length && <tr><td colSpan={12} className="racks-muted">No equipment in this rack.</td></tr>}
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
              const item = e.data, meta = ITEM_TYPES[item.type] || ITEM_TYPES.other, owner = ownerOfUnit(optOwners, item.id);
              return <li key={`e:${item.id}`} className="detail-item" data-item-id={item.id}>
                <div className="detail-item-head"><span className="detail-item-type">{meta.label}</span>
                  <button type="button" className="server-open" aria-label={`View ${item.name}`} onClick={() => onSelectCustom(item)}><span dir="auto" className="server-name">{item.name}</span></button></div>
                <div className="detail-item-facts" dir="auto">{[uText(e), owner && `Owner ${owner}`, item.notes].filter(Boolean).join(" · ")}</div>
                <div className="detail-item-ids">
                  {[["part_number", "P/N", detailText(item, "part_number")], ["serial_number", "S/N", unitSerial(item)]].map(([field, label, value]) =>
                    <span key={field} className="detail-item-id" data-field={field} title={`${label}: ${value || "not recorded"}`}>
                      <span className="slot-label">{label}</span><span className="detail-item-id-value" dir="auto">{value || "—"}</span></span>)}
                </div>
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

// ─── EDIT RACK MODAL ──────────────────────────────────────────────────────────
const inputCls = "w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700";

// Rename a rack and set its type: every device of the rack is saved with the new rack name, the type is the rack row's
// model. PDUs and KVMs are changed in their own windows; a rack is added in Manage. Delete rack… (onDelete) opens the
// one delete dialog, which previews what goes with the rack.
function EditRackModal({ rackName, rackType, rackDevs, onClose, onSave, onDelete }) {
  useEscClose(onClose);
  const [name,   setName]   = useState(rackName);
  const [type,   setType]   = useState(rackType === "storage" ? "Storage" : "Compute");
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState("");

  async function handleSave() {
    if (!name.trim()) { setErr("Rack name is required."); return; }
    setSaving(true); setErr("");
    try {
      await Promise.all(rackDevs.map(d => fetch(`/api/devices/${d.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...d, rack: name.trim(), model: d.kind === "rack" ? type : d.model }),
      }).then(r => { if (!r.ok) throw new Error(`Failed to update ${d.name}`); })));
      await onSave();
      onClose();
    } catch (e) {
      setErr(e.message || "Save failed.");
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Edit ${rackName}`} data-dialog="edit-rack"
        className="bg-zinc-950 border border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/50 sticky top-0 bg-zinc-950 z-10">
          <span className="text-sm font-bold text-zinc-100">Edit Rack — {rackName}</span>
          <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-200 transition">{Icon.x}</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label htmlFor="edit-rack-name" className="text-[11px] font-mono text-zinc-400 uppercase tracking-widest mb-1 block">Rack Name</label>
            <input id="edit-rack-name" value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="e.g. Rack-09"
              onKeyDown={e => e.key === "Enter" && handleSave()}/>
          </div>
          <div>
            <div className="text-[11px] font-mono text-zinc-400 uppercase tracking-widest mb-1.5">Type</div>
            <div className="flex gap-2" role="group" aria-label="Rack type">
              {["Compute", "Storage"].map(t => (
                <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}
                  className={`flex-1 py-2 text-sm rounded-xl border transition ${type === t
                    ? (t === "Storage" ? "border-cyan-500/60 text-cyan-400 bg-cyan-950/30" : "border-nv-400/60 text-nv-400 bg-nv-400/10")
                    : "border-zinc-800 text-zinc-400 hover:border-zinc-600"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[12px] text-zinc-400">PDUs and KVMs are changed in their own windows: click one in the rack's detail.</p>
        </div>
        {err && <div role="alert" className="px-5 pb-2 text-xs text-red-400">{err}</div>}
        {onDelete && <div className="px-5 pb-2">
          <button type="button" data-action="delete-rack" onClick={onDelete}
            className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-red-400 border border-red-900/40 hover:border-red-700/60 hover:bg-red-950/20 rounded-xl transition">
            {Icon.trash} Delete rack…
          </button>
        </div>}
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

// ─── RACKS VIEW ───────────────────────────────────────────────────────────────
// The overview (summary, find / filter / jump toolbar, cooling units panel, rack cards) or one rack's detail.
// base: visualFor, summaryFor, maintenance, itemsError from DcimView; cooling: the cooling units and their actions.
// onReorder(rack, ids, drop): a drag inside a rack (drop: { activeId, overId }, the server dropped onto: a swap);
// onRequestMove({ id, rack, swapWith }): a server dropped onto another rack's card (a move to that rack) or onto a server
// in another rack (a swap with it); both open the server's window on its move dialog. onSelect / onSelectCustom open the
// server / unit window; onAddServer({ rack?, u? }) opens Add server (Operator); kvmsByRack and onOpenDevice: the rack
// detail's PDU and KVM links (device windows).
function RacksView({ selectedRack: rackProp, onSelectRack, rackStats, rackSlots, rackOrder, switchAssignments, customItems, onReorder, onRequestMove, onSelect, onSelectCustom, onSaveItems, onRefresh, rackDevices, kvmsByRack = {}, onOpenDevice = null, onAddServer = null, optOwners, pduStatuses, base, cooling }) {
  const { act } = useLabWindow();
  // With onSelectRack the App owns the open rack (?rack= in the address, so Back and Forward work);
  // without it the open rack is local state that starts from ?rack=, as before.
  const [localRack,      setLocalRack]      = useState(() => onSelectRack ? null : new URLSearchParams(location.search).get("rack"));
  const selectedRack    = onSelectRack ? (rackProp || null) : localRack;
  const setSelectedRack = onSelectRack || setLocalRack;
  const [addEquipFor,    setAddEquipFor]    = useState(null);
  const [editRackTarget, setEditRackTarget] = useState(null); // rack name string
  const [activeId,       setActiveId]       = useState(null);
  const [coolingActive,  setCoolingActive]  = useState(null);
  const [labelsScope,    setLabelsScope]    = useState(null); // shelf labels: { rack, u } (rack null: every rack)
  const editMode = useContext(EditContext);
  const { scanUnit } = useContext(ServerActionsContext);
  const phone = useMediaQuery("(max-width: 640px)");
  const { visualFor, summaryFor } = base;

  // ── find, filter, empty shelves, collapsed cards (the last two and the panel are remembered per viewer) ──
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQ(query), 150); return () => clearTimeout(timer); }, [query]);
  const [filter, setFilter] = useState("all");
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
    // A hit behind a floor's "+N" chip: its list opens first.
    const hidden = el.offsetParent === null;
    revealInFloor(el);
    const go = () => {
      el.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      el.focus({ preventScroll: true });
      flash(el.closest(".server-cell") || el);
    };
    if (hidden) requestAnimationFrame(() => requestAnimationFrame(go)); else go();
  }
  function onSearchKey(e) {
    if (e.key === "Escape") { if (query) { e.preventDefault(); e.stopPropagation(); setQuery(""); setQ(""); } return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const list = searchIndex(index, query).ordered;
    if (!list.length) return;
    // One server found: Enter opens its window (the one place for that server).
    if (list.length === 1 && list[0].kind === "server") {
      const server = allServers.find(x => `s:${x.id}` === list[0].key);
      if (server && onSelect) { setQ(query); onSelect(server); return; }
    }
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
  // A cooling drag only sees floors (shelves) and "not on a floor" strips; a server drag never sees them.
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
      if (oldIdx !== -1 && newIdx !== -1) onReorder(sourceRack, arrayMove(ids, oldIdx, newIdx), { activeId: active.id, overId: over.id });
    } else {
      const server = rackStats.flatMap(rs => rs.servers).find(s => s.id === active.id);
      const swapWith = String(over.id).startsWith("rack:") ? null : over.id;
      if (server && rackStats.some(rs => rs.rack === targetRack)) onRequestMove?.({ id: server.id, rack: targetRack, swapWith, fixed: !!swapWith });
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
  // Shelf labels of every rack, from the same rows the cards draw (computed only while the labels dialog is open).
  const labelGroups = useMemo(() => !labelsScope ? [] : rackStats.map(rs => {
    const storage = !rackHasFloors(rs.rack);
    const { rows } = buildRackRows(rs.servers, rs.rack, rackOrder, rackSlots, customItems);
    return { rack: rs.rack, storage, labels: buildShelfLabels([{ rack: rs.rack, storage, rows }], optOwners) };
  }), [labelsScope, rackStats, rackOrder, rackSlots, customItems, optOwners]);
  const viewCtx = useMemo(() => ({
    ...base, matchKeys: searching ? search.keys : null, rowKeep,
    coolingByRack: cooling.groups.byRack, coolingDrop: overviewEdit, coolingDraggable: overviewEdit, coolingEditable: cooling.editable,
    coolingCanPlace: cooling.canPlace, onOpenCooling: cooling.open, onPlaceCooling: cooling.canPlace ? cooling.edit : null, onAddCooling: cooling.add,
    onShelfLabels: setLabelsScope,
  }), [base, searching, search, rowKeep, cooling, overviewEdit]);

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
          onAddServer={onAddServer ? rackName => onAddServer({ rack: rackName }) : null}
          kvms={kvmsByRack[r.rack] || []} onOpenDevice={onOpenDevice}
          onRequestAddEquip={setAddEquipFor}
          onEdit={() => setEditRackTarget(r.rack)}
          phone={phone} detailView={detailView} onDetailView={setDetailView}/>
      ) : (
        <>
          {editMode && <div role="status" className="edit-mode-notice">
            <p><strong>Edit mode.</strong> Drag the grip ⠿ onto another server to swap the two, or onto another rack to move it there; every move asks first. "+ Add server" on a free floor adds a server there. Click a cooling unit to place or move it. Click a server to open its window.</p>
          </div>}
          <RackKpis {...kpis}/>
          <RacksToolbar phone={phone} loading={kpis.loading} searchRef={searchRef} query={query} onQuery={setQuery} onSearchKey={onSearchKey} count={countText}
            filter={editMode ? "all" : filter} onFilter={setFilter} filterCounts={filterCounts} editMode={editMode}
            rackChips={rackChips} onJump={jumpTo}
            allCollapsed={allCollapsed} onToggleAll={toggleAll} coolingOpen={showPanel} onToggleCooling={() => toggleCooling()}
            coolingTotal={coolingTotal} coolingNeeds={coolingNeeds} onAddServer={onAddServer ? () => onAddServer({}) : null}/>
          <div className="racks-phone-options" data-desktop={phone ? undefined : ""}>
            {phone && <button type="button" className="racks-chip" onClick={toggleAll}>{allCollapsed ? "Expand all" : "Collapse all"}</button>}
            {phone && onAddServer && <button type="button" className="racks-chip" data-action="add-server" onClick={() => onAddServer({})}>{Icon.plus} Add server</button>}
            <button type="button" className="racks-chip" data-action="shelf-labels" onClick={() => setLabelsScope({ rack: null })}>{Icon.tag} Shelf labels</button>
          </div>
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
          {!rackStats.length && <p className="racks-empty">No racks yet. Add a rack or PDU in Manage (Admin).</p>}
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
                  onHeaderClick={() => setSelectedRack(rs.rack)}
                  onEdit={() => setEditRackTarget(rs.rack)}
                  collapsed={isCollapsed(rs.rack)} onToggleCollapse={() => toggleCollapse(rs.rack)}
                  external externalActiveId={activeId}/>
              ))}
            </div>
            <DragOverlay dropAnimation={null}>
              {activeServer && (
                <div className="rack-shelves drag-overlay" style={{ opacity: 0.9 }}>
                  <ServerCell server={activeServer} sw={switchAssignments[activeServer.id]} owner={optOwners?.[activeServer.id]} overlay/>
                </div>
              )}
              {coolingActive && <CoolingChip unit={coolingActive} variant="panel"/>}
            </DragOverlay>
          </DndContext>
        </>
      )}


      {/* Modals rendered via Portal — completely outside DOM tree, immune to any stacking context */}
      {addEquipFor && (
        <Portal>
          <AddEquipmentModal rackName={addEquipFor} onClose={() => setAddEquipFor(null)}
            onSave={item => handleSaveEquip(addEquipFor, item)}
            onScan={scanUnit ? u => { const rack = addEquipFor; setAddEquipFor(null); scanUnit({ rack, u }); } : null}/>
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
              onSave={async () => { await onRefresh?.(); if (selectedRack) setSelectedRack(null); }}
              onDelete={act.openDelete ? () => { const name = editRackTarget; setEditRackTarget(null); act.openDelete([{ kind: "rack", id: name }]); } : null}/>
          </Portal>
        ) : null;
      })()}
      {labelsScope && <ShelfLabelsDialog groups={labelGroups} scope={labelsScope} onClose={() => setLabelsScope(null)}/>}
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

// ─── ROOT ─────────────────────────────────────────────────────────────────────
// Racks is one of the views of the one place: a server opens its window (both modes), a unit its unit window, a PDU or KVM
// its device window; a drag opens the server window on its move dialog; power asks through the provider's power hook;
// Add server (Operator) is AddServerDialog. item: ?item=<unit id> (an old link to a Racks unit) opens its unit window.
// onOutletAction, onLabelChange, onRenameOpt and onSwitchFeeds are App's props, no longer read here (ManageView passes
// the same props; it renders the server table, section "inventory").
export default function DcimView({devices,pduStatuses,kvmStatuses,onOutletAction,onLabelChange,onRenameOpt,onRefresh, onOpenConsole, section: controlledSection, editMode = false, onSummary, maintenance, onSwitchFeeds, onRequestEdit, onShowIn3d = null, item = null, rack, onRackChange}) {
  const {canOperate, preferences} = useAccounts();
  const {revision: engineerRevision} = useEngineers();
  const {hidden: removedHidden} = useRemovedServers();
  const lab = useLabWindow();
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
  const [layoutError,       setLayoutError]       = useState("");
  const [addServerTarget,   setAddServerTarget]   = useState(null);   // Add server: { rack, u } (null: closed)

  // The rack layout (positions, U slots, overrides, equipment, owners, cooling units) is reloaded on the dashboard's
  // refresh interval, when the tab becomes visible again and when the DCIM tab changes, so moves made in Locations, the
  // 3D Twin, the assistant or another session show here without a page reload. One reload path for every store.
  // While editing, the periodic reload leaves the layout stores alone; equipment keeps reloading (B08 RACK-3; units are
  // edited in their unit window). itemsSeq drops an equipment answer that a save, or a newer reload, overtook. A failed
  // reload keeps what is shown.
  // Live sync (the change feed, ../api/changes.js): a change saved anywhere reloads the stores of its domains at once,
  // in Edit mode too (every edit here is saved at once, so no unsaved layout is lost; a reload waits while a save of this
  // page runs, live.during). An open cooling dialog holds the cooling store until it closes.
  const editingRef = useRef(editMode);
  editingRef.current = editMode;
  const itemsSeq = useRef(0);
  // Cooling units are edited through dialogs, never inline, so they keep reloading in Edit mode too, except while a
  // cooling dialog is open (its form is based on what it opened with); coolingSeq drops an answer a save overtook.
  const coolingSeq = useRef(0);
  const holdCoolingRef = useRef(false);
  const coolingMissed = useRef(false);   // a live change to the cooling units came while its dialog was open
  // Owners are saved the moment they are chosen (never a draft), so they keep reloading in Edit mode too: a server's
  // owner changed elsewhere reaches its units here at once. ownersSeq counts owner saves (one at the start, one at the
  // end) and owner reloads: an owner answer is used only when no save or later reload started or ended while it was on
  // its way (an older, slower answer never replaces a newer one).
  const ownersSeq = useRef(0);
  // The layout stores (rack positions, U slots, switch ports, rack overrides) are read together. layoutSeq numbers the
  // layout reloads in the order they started; layoutShown is the number of the newest one whose answer is shown. An
  // answer is used only when no later reload's answer is shown already, so a slower periodic reload never puts back an
  // older place over a newer live reload, while an answer that is not used (Edit mode began, or every store failed)
  // does not stop an earlier one that arrives after it. (A save is followed by the change feed's reload.)
  const layoutSeq = useRef(0);
  const layoutShown = useRef(0);
  // loadErrors: the stores whose last load failed ({ items, cooling, layout: message }), shown as banners with Retry.
  const [loadErrors, setLoadErrors] = useState({});
  // initial: the first load (a failed store starts empty, as before). force: Retry (also while editing or hidden).
  // live: a change-feed reload of these stores only (a Set of "layout", "items", "cooling", "owners").
  const reloadLayouts = useCallback((initial = false, force = false, live = null) => {
    if (!initial && !force && !live && document.hidden) return Promise.resolve();
    const want = store => !live || live.has(store);
    const editing = !initial && !force && !live && editingRef.current;
    const itemsTurn = !want("items") ? null : ++itemsSeq.current;
    const holdCooling = !initial && !force && holdCoolingRef.current;
    if (live && want("cooling") && holdCooling) coolingMissed.current = true;
    const coolingTurn = !want("cooling") || holdCooling ? null : ++coolingSeq.current;
    const layoutTurn = want("layout") && !editing ? ++layoutSeq.current : null;
    // Owners are saved the moment they are chosen, so they reload in Edit mode too (ownersSeq: an answer a save or a
    // later reload overtook is dropped).
    const ownersTurn = want("owners") ? ++ownersSeq.current : null;
    if (layoutTurn == null && ownersTurn == null && itemsTurn == null && coolingTurn == null) return Promise.resolve();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const keep = setter => next => setter(prev => same(prev, next) ? prev : next);
    const failed = {};
    const reason = e => (e?.status ? `HTTP ${e.status}` : e?.message || "no answer");
    const fetchStore = (store, path) => fetch(path, { cache: "no-store" }).then(r => { if (r.ok) return r.json(); const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; })
      .catch(e => { if (store) failed[store] ||= reason(e); return null; });
    const get = (store, path, wanted) => wanted ? fetchStore(store, path) : Promise.resolve(null);
    const layoutWanted = layoutTurn != null;
    return Promise.all([
      get("layout", "/api/rack-positions", layoutWanted),
      get("layout", "/api/rack-slots", layoutWanted),
      get("layout", "/api/switch-assignments", layoutWanted),
      itemsTurn == null ? Promise.resolve(null) : loadRackItems().catch(e => { failed.items = reason(e); return null; }),
      get("layout", "/api/rack-overrides", layoutWanted),
      get(null, "/api/opt-owners", ownersTurn != null),
      coolingTurn == null ? Promise.resolve(null) : fetchStore("cooling", "/api/chillers"),
    ]).then(([order,slots,sw,items,overrides,owners,chill])=>{
      const itemsCurrent = itemsTurn != null && itemsTurn === itemsSeq.current;
      if (itemsCurrent && (items || initial)) keep(setCustomItems)(items||{});
      const coolingCurrent = coolingTurn != null && coolingTurn === coolingSeq.current && (initial || force || !holdCoolingRef.current);
      const layoutCurrent = layoutTurn != null && layoutTurn > layoutShown.current;
      setLoadErrors(prev => {
        const next = { ...prev };
        const mark = store => { if (failed[store]) next[store] = failed[store]; else delete next[store]; };
        if (itemsCurrent) mark("items");
        if (layoutCurrent) mark("layout");
        if (coolingCurrent) mark("cooling");
        return same(prev, next) ? prev : next;
      });
      if (coolingCurrent && (chill || initial)) { keep(setChillers)(chill||{units:[],connections:[]}); setChillersLoaded(true); }
      if (owners && ownersTurn != null && ownersTurn === ownersSeq.current) { keep(setOptOwners)(owners); setOwnersLoaded(true); }
      if (!initial && !force && !live && editingRef.current) return;   // editing (or editing started while loading)
      // A failed reload keeps what is shown; the first load falls back to empty documents as before.
      if (layoutCurrent) {   // no later layout reload's answer is shown (layoutSeq, layoutShown)
        if (initial || order || slots || sw || overrides) layoutShown.current = layoutTurn;
        if (order || initial) keep(setRackOrder)(order||{});
        if (slots || initial) keep(setRackSlots)(slots||{});
        if (sw || initial) keep(setSwitchAssignments)(sw||{});
        if (overrides || initial) keep(setRackOverrides)(overrides||{});
      }
    });
  },[]);
  useEffect(()=>{ reloadLayouts(true); },[reloadLayouts]);
  // Changing the DCIM tab reloads.
  const reloadTrigger = useRef(false);
  useEffect(()=>{
    if (reloadTrigger.current) reloadLayouts();
    reloadTrigger.current = true;
  },[section, reloadLayouts]);
  const refreshSeconds = Math.max(5, Number(preferences?.refresh_seconds) || 15);
  useEffect(()=>{
    const timer = setInterval(() => reloadLayouts(), refreshSeconds * 1000);
    const onVisible = () => { if (!document.hidden) reloadLayouts(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  },[reloadLayouts, refreshSeconds]);
  // A change saved anywhere (another browser, the 3D twin, Locations, Scan & Track, the assistant): the stores of its
  // domains reload now. A server an Admin removed also loses its rack position, switch port and owner.
  // (The device list, PDU labels and readings come from the App, which reloads them on "devices" / "power".)
  const live = useLiveReload(["layout", "inventory", "owners", "removed"], domains => {
    const has = domain => domains.includes(domain);
    const stores = new Set();
    if (has("layout") || has("removed")) stores.add("layout");
    if (has("inventory")) { stores.add("items"); stores.add("cooling"); }
    if (has("owners") || has("removed")) stores.add("owners");
    return stores.size ? reloadLayouts(false, false, stores) : null;
  });

  // One layout edit: saved against the server's current document; on failure the optimistic
  // state is undone, the store reloaded, and the error rethrown for the caller to show.
  const persistLayout = useCallback((path, edit, setState, previous) => live.during(async () => {
    try {
      setState(await saveLayout(path, edit));
    } catch (e) {
      setState(previous);
      loadLayout(path).then(({ data }) => setState(data)).catch(() => {});
      throw e;
    }
  }), [live]);

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
    // A rename that keeps the place (old data such as U17 or 99 included) does not say "moved".
    const stayed = change.before.rack === change.after.rack && change.before.u === change.after.u;
    showToast(<><bdi>{change.name}</bdi> {!change.after.rack ? "has no rack now" : stayed ? `renamed; it stays in ${describePlace(change.after)}` : `moved to ${describePlace(change.after)}`}.</>, "ok", () => undoCooling(change));
  }, [showToast, undoCooling]);

  // inventory.js reports a rejected equipment save; a stale list is replaced by the reloaded one.
  const saveItems = useCallback((updated, options) => live.during(async () => {
    itemsSeq.current++;
    try {
      const saved = await saveRackItems(updated, customItems, options);
      setCustomItems(saved);
      return saved;
    } catch (e) {
      if (e.reloaded) setCustomItems(e.reloaded);
      throw e;
    } finally {
      itemsSeq.current++;
    }
  }), [customItems, live]);

  useEffect(()=>{let active=true;const turn=ownersSeq.current;accountRequest("/opt-owners").then(data=>{if(active&&turn===ownersSeq.current){setOptOwners(data);setOwnersLoaded(true);}}).catch(()=>{});return()=>{active=false;};},[engineerRevision]);
  const handleOwnerChange = useCallback((assetKey, engineerId) => live.during(async () => {
    ownersSeq.current++;
    try { setOptOwners(await accountRequest(`/opt-owners/${encodeURIComponent(assetKey)}`,"PUT",{engineer_id:engineerId})); }
    finally { ownersSeq.current++; }
  }),[live]);

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
  // The KVMs of each rack for the rack detail's device links ({ id, name, ip, status }).
  const kvmsByRack = useMemo(() => {
    const map = {};
    devices.filter(d => d.kind === "kvm" && d.rack).forEach(k => {
      const st = kvmStatuses?.[k.id];
      (map[k.rack] ||= []).push({ id: k.id, name: k.name, ip: k.ip, status: st?.reachable === true ? "online" : st?.reachable === false ? "offline" : "unknown" });
    });
    return map;
  }, [devices, kvmStatuses]);
  // Inventory racks have no device status; Dashboard links to their saved layout.
  const rackDevices = devices.filter(d=>d.kind==="pdu"||d.kind==="rack");
  const racks = useMemo(()=>[...new Set([...rackDevices.map(d=>d.rack).filter(Boolean), ...Object.keys(customItems)])].sort(),[rackDevices, customItems]);

  const servers = useMemo(()=>{
    // Every outlet that names a server is one feed of it. A server on two feeds (the same label on two outlets) is on
    // when any feed is on, its watts add up, and it names the PDU / outlet of the feed that decides its state
    // (mergeServerFeeds, the lab display's rule): a second feed never overwrites the first one's reading.
    const feeds=new Map();
    const add=(key,feed)=>{const list=feeds.get(key);if(list)list.push(feed);else feeds.set(key,[feed]);};
    pdus.forEach(pdu=>{
      const stored=pdu.labels||{},live=pduStatuses[pdu.id]?.outlets||[];
      const liveByN=Object.fromEntries((pduStatuses[pdu.id]?.reachable ? live : []).map(o=>[String(o.number),o]));
      Object.entries(stored).forEach(([num,label])=>{
        // A reachable PDU's live outlet list already carries the latest saved labels (the dashboard shows the same):
        // an older saved label for that outlet must not keep a server that has moved away.
        if(liveByN[num])return;
        if(!isServerLabel(label))return;const key=label.trim().toLowerCase();
        add(key,{id:key,name:label.trim(),rack:rackOverrides[key]||pdu.rack||"—",pduId:pdu.id,pduName:pdu.name,pduIp:pdu.ip,outlet:parseInt(num,10),state:"unknown",watts:null});
      });
      (pduStatuses[pdu.id]?.reachable ? live : []).forEach(o=>{
        if(!isServerLabel(o.label))return;const key=o.label.trim().toLowerCase();
        add(key,{id:key,name:o.label.trim(),rack:rackOverrides[key]||pdu.rack||"—",pduId:pdu.id,pduName:pdu.name,pduIp:pdu.ip,outlet:o.number,state:o.state,watts:o.watts??null});
      });
    });
    // Servers an Admin removed from the lab are left out here, before the rack rows number the U slots.
    return withoutRemoved([...feeds.values()].map(mergeServerFeeds), removedHidden).sort((a,b)=>a.name.localeCompare(b.name));
  },[pdus,pduStatuses,rackOverrides,removedHidden]);

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
  // Every storage rack (type Storage, Main storage) has 16 shelves: floors.js answers by rack type from here on, before
  // anything below draws a rack, a dialog or a select.
  const storageRacks = useMemo(() => storageRackNames(rackStats), [rackStats]);
  setStorageRacks(storageRacks);
  // Each unit's owner by the lab's rule (unitOwner.js): the owner of the server on its floor, from the rows the racks
  // draw, else its own saved owner. shownOwners is the owner map the Racks page shows and searches; optOwners stays the
  // saved map. It follows owner changes, moves and reloads at once (no page reload).
  const unitOwnerMap = useMemo(() => unitOwners(rackStats.map(rs => ({ rack: rs.rack, rows: buildRackRows(rs.servers, rs.rack, rackOrder, rackSlots, customItems).rows })), optOwners),
    [rackStats, rackOrder, rackSlots, customItems, optOwners, storageRacks]);
  // The same object while its content is the same (rackStats changes with every power reading, the owners do not).
  const shownOwnersRef = useRef(null);
  const shownOwners = useMemo(() => {
    const next = withUnitOwners(optOwners, unitOwnerMap), prev = shownOwnersRef.current;
    return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : (shownOwnersRef.current = next);
  }, [optOwners, unitOwnerMap]);

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
  // The cooling dialog offers the rack's floors 1-RACK_FLOORS (Main storage: its shelves), named as on the rack card.
  const floorOptionsFor = useCallback(rackName => {
    const rs = rackStats.find(x => x.rack === rackName);
    const rows = rs ? buildRackRows(rs.servers, rs.rack, rackOrder, rackSlots, customItems).rows : [];
    return floorOptions(rows, coolingGroups.byRack[rackName]?.placed || {}, rackName);
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
  // A live change to the cooling units that came while the dialog was open is read once it closes.
  useEffect(() => {
    if (coolingDialog || !coolingMissed.current) return;
    coolingMissed.current = false;
    reloadLayouts(false, false, new Set(["cooling"]));
  }, [coolingDialog, reloadLayouts]);
  const addCooling = useCallback(rackName => setCoolingDialog({ mode: "create", rack: rackName || null, newId: newChillerId() }), []);
  // After a save the focus goes to the unit's chip in its new place (the panel when its card is closed or hidden). A
  // chip behind its floor's "+N" chip (the floor's one slot already holds a unit) opens that list first.
  const focusUnit = useCallback(id => {
    const css = window.CSS.escape(id);
    const tries = [`[data-rack-id] .cooling-chip[data-unit-id="${css}"]`, `#cooling-panel li[data-unit-id="${css}"] button`, `[data-unit-id="${css}"] button`];
    const land = () => {
      const el = tries.flatMap(sel => [...document.querySelectorAll(sel)]).find(x => x.offsetParent !== null);
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); flash(el); }
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const behind = [...document.querySelectorAll(tries[0])].find(x => x.offsetParent === null && x.closest(".floor-more:not([data-open])"));
      if (behind) { revealInFloor(behind); requestAnimationFrame(() => requestAnimationFrame(land)); }
      else land();
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
    showToast(<><bdi>{unit.name}</bdi> is off its {placeWord(unit.rack)}; it stays in {unit.rack}.</>, "ok", () => undoCooling(saved));
    focusUnit(unit.id);
  }, [coolingDialog, unitById, saveCooling, showToast, undoCooling, focusUnit]);
  // A drag in Edit mode on the overview: a floor (u) or the rack's "not on a floor" strip (u null).
  const placeCooling = useCallback(async (id, rackName, u) => {
    const unit = unitById(id);
    // Only the places the dialog offers: a floor of that rack (Main storage: a shelf), or no floor (u null).
    if (u != null && !validPlace(u, rackName)) return;
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

  // ── power: every row switch asks through the window provider's one power hook (server/useServerPower.js): the in-app
  // confirmation names the outlets (Power on included, whatever confirm_power says), the plan is checked again on the
  // latest readings before anything switches, and the result is a provider toast ──
  const power = lab.act?.power || null;
  const groupFor = power?.groupFor || null;
  const powerGroups = useMemo(() => {
    const map = new Map();
    if (!groupFor) return map;
    servers.forEach(s => { const key = serverIdentity(s.name); if (key && !map.has(key)) map.set(key, groupFor(s.name)); });
    return map;
  }, [servers, groupFor]);
  const powerEnabled = !!canOperate && !!power?.enabled;
  const powerFor = useCallback(s => (powerEnabled ? powerGroups.get(serverIdentity(s.name)) || null : null), [powerEnabled, powerGroups]);
  const pendingOf = power?.pending || null;
  const powerPending = useCallback(s => pendingOf?.(serverIdentity(s.name)) || null, [pendingOf]);
  const waitingFor = useCallback(s => pduStatuses[s.pduId] === undefined, [pduStatuses]);
  const powerRequest = power?.request || null;
  const requestPower = useCallback((server, action, opener, { scope = "server", feedId = null } = {}) => {
    if (!powerEnabled || !powerRequest || !powerGroups.get(serverIdentity(server.name))) return;
    powerRequest(server.name, action, opener, { scope, feedId: feedId || `${server.pduId}:${server.outlet}` });
  }, [powerEnabled, powerRequest, powerGroups]);

  // ── scan unit barcodes onto a floor: the dialog saves each unit itself; the equipment list is then reloaded (or
  // replaced by the list an Undo saved), and itemsSeq drops any reload that was already on its way with the old list ──
  // (a server's floor: the server window's "Units on this floor" scans there)
  const [scanTarget, setScanTarget] = useState(null);
  const openScanUnit = useCallback(({ rack = null, u = null, label = "", fixed = false } = {}) => {
    if (!rack) return;
    // A storage rack starts on the whole unit unless a shelf was given; a rack on floor 1.
    setScanTarget({ rack, u: Number.isInteger(u) ? u : !rackHasFloors(rack) ? 0 : 1, position: "", label,
      chooseFloor: !(fixed && Number.isInteger(u)) });
  }, []);
  const scanItemsChanged = useCallback(async saved => {
    if (saved) { itemsSeq.current++; setCustomItems(saved); return; }
    const turn = ++itemsSeq.current;
    try { const fresh = await loadRackItems(); if (turn === itemsSeq.current) setCustomItems(fresh); }
    catch { /* the next periodic reload tries again */ }
  }, []);

  // Add server (Operator): the toolbar, a free floor in Edit mode and a rack's detail open it ({ rack, u } preselected).
  const openAddServer = useCallback(({ rack: toRack = null, u = null } = {}) => setAddServerTarget({ rack: toRack, u }), []);
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
    // Scan unit barcodes onto a rack's floor ({ rack, u }) or a server's floor ({ server }); Operator and up.
    scanUnit: canOperate ? openScanUnit : null,
    addServer: canOperate ? openAddServer : null,
  }),[kvmByServer,onOpenConsole,canOperate,powerEnabled,powerGroups,powerFor,powerPending,requestPower,waitingFor,openScanUnit,openAddServer]);

  // ── the windows: a server opens its window, a unit its unit window, a PDU or KVM its device window ──
  const openServer = lab.openServer, openWindow = lab.open;
  const openServerWindow = useCallback(server => {
    const key = windowKey(server?.name) || serverIdentity(server?.name);
    if (key) openServer(key);
  }, [openServer]);
  const openUnitWindow = useCallback(unit => { if (unit?.id != null) openWindow({ kind: "unit", id: String(unit.id) }); }, [openWindow]);
  const openDevice = useCallback(id => openWindow({ kind: "dev", id }), [openWindow]);
  // ?item=<unit id> (an old link to a Racks unit): its unit window over Racks; the address keeps the window, not item.
  useEffect(() => {
    if (!item || section !== "racks") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("item");
    window.history.replaceState(window.history.state, "", url);
    openWindow({ kind: "unit", id: String(item) }, { replace: true });
  }, [item, section, openWindow]);

  // ── moving servers (Edit mode): a drag opens the server's window on its move dialog (server/MoveDialog.jsx) ──
  // The PDU outlet and KVM port belong to the floor (the owner's rule): the dialog previews the swap or the move (POST
  // /api/devices/move-server, a dry run) and saves it in one server step with units_follow, so the units on the floor go
  // along; the PDU and KVM devices never move. serverById: the rows by their DCIM id (the drag ids).
  const serverById = useMemo(() => new Map(servers.map(s => [s.id, s])), [servers]);
  const serverByIdRef = useRef(serverById);
  serverByIdRef.current = serverById;
  // A server dropped onto another server (any rack): a swap with it; onto another rack's card: a move to that rack.
  const requestMove = useCallback(({ id, rack: toRack = null, swapWith = null }) => {
    const server = serverByIdRef.current.get(id);
    const key = windowKey(server?.name);
    if (!key) return;
    const other = swapWith ? serverByIdRef.current.get(swapWith) : null;
    if (swapWith && (!other || windowKey(other.name) === key)) return;   // the other feed of the same server
    openServer(key, other ? { sec: "move", swapWith: other.name } : { sec: "move", moveTo: toRack ? { rack: toRack } : null });
  }, [openServer]);

  // A drag inside a rack: dropped onto another server, the two swap floors (each with the other's outlet, KVM port and
  // floor units), asked first in the move dialog. A drop that names no server keeps the old rack order save.
  const handleReorder = useCallback((rackName,newIds,drop=null)=>{
    if (!editMode) return;
    setLayoutError("");
    if (drop && drop.overId !== drop.activeId && serverByIdRef.current.has(drop.overId) && serverByIdRef.current.has(drop.activeId)) {
      requestMove({ id: drop.activeId, swapWith: drop.overId });
      return;
    }
    const edit = doc => ({ ...doc, [rackName]: newIds });
    const previous = rackOrder;
    setRackOrder(edit(rackOrder));
    persistLayout("/api/rack-positions", edit, setRackOrder, previous)
      .catch(e => setLayoutError(`The new order was not saved: ${e.message}`));
  },[rackOrder,editMode,persistLayout,requestMove]);

  // The layout stores read again through the one guarded reload (layoutSeq), in Edit mode too (after Add server pinned
  // the new server's floor): an older reload still on its way cannot put back an older place, and a failed read keeps
  // what is shown.
  function _reloadPositions() {
    return reloadLayouts(false, true, new Set(["layout"]));
  }

  const tabs=[
    {id:"racks",    label:"Racks",     icon:Icon.rack},
    {id:"inventory",label:"Inventory", icon:Icon.list},
    {id:"power",    label:"Power",     icon:Icon.bolt},
    {id:"changelog",label:"Changelog", icon:Icon.log},
  ];

  const scanFloorChoices = useMemo(() => {
    if (!scanTarget?.chooseFloor) return null;
    const list = Array.from({ length: floorsFor(scanTarget.rack) + 1 }, (_, n) => n);
    return list.includes(scanTarget.u) ? list : [...list, scanTarget.u];
  }, [scanTarget]);
  const dialogUnit = coolingDialog?.mode === "create" ? { id: coolingDialog.newId, name: "", rack: coolingDialog.rack ?? racks.find(r => rackHasFloors(r)) ?? null, u: null } : coolingDialog ? unitById(coolingDialog.unitId) : null;
  const loadBanner = (store, text, more = "") => loadErrors[store] && <div role="alert" className="racks-banner" data-store={store}>
    <span>{text} ({loadErrors[store]}).{more ? ` ${more}` : ""}</span> <button type="button" className="racks-link" onClick={() => reloadLayouts(false, true)}>Retry</button></div>;

  return (
    <TwinLinkContext.Provider value={onShowIn3d}><EditContext.Provider value={editMode}><ServerActionsContext.Provider value={serverActions}><main className={`flex-1 px-4 pb-5 w-full mx-auto ${section === "racks" ? "racks-main" : ""}`}>
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
          onReorder={handleReorder} onRequestMove={requestMove}
          onSelect={openServerWindow} onSelectCustom={openUnitWindow}
          onSaveItems={saveItems} onRefresh={onRefresh}
          rackDevices={rackDevices} kvmsByRack={kvmsByRack} onOpenDevice={openDevice}
          onAddServer={canOperate ? openAddServer : null} optOwners={shownOwners}
          pduStatuses={pduStatuses} base={rackView} cooling={coolingApi}/>
      )}
      {section==="inventory"&&<InventoryView servers={servers} switchAssignments={switchAssignments} rackSlots={rackSlots} customItems={customItems} optOwners={optOwners} ownersLoaded={ownersLoaded} onOwnerChange={handleOwnerChange}/>}
      {section==="power"&&<PowerView rackStats={rackStats}/>}
      {section==="changelog"&&<ChangelogView/>}

      {coolingDialog && dialogUnit && (() => {
        const mode = coolingDialog.mode === "edit" && !(editMode && coolingEditable) ? "view" : coolingDialog.mode;
        // A new key per mode: "Move…" in the view dialog opens a fresh edit dialog with the Rack select focused.
        return <Portal>
          <CoolingUnitDialog key={`${coolingDialog.unitId || coolingDialog.newId}:${mode}`} mode={mode}
            unit={dialogUnit} rackNames={racks} floorOptionsFor={floorOptionsFor} canOperate={!!canOperate}
            onRequestEdit={mode === "view" && canPlaceCooling ? () => editCooling(dialogUnit) : null}
            onSave={saveCoolingDialog} onTakeOffShelf={takeOffShelf} onClose={() => setCoolingDialog(null)}/>
        </Portal>;
      })()}
      {scanTarget && canOperate && section === "racks" && <Portal>
        <ScanUnitDialog key={`${scanTarget.rack}:${scanTarget.u}:${scanTarget.label}`} target={scanTarget} floorChoices={scanFloorChoices}
          onClose={() => setScanTarget(null)} onItemsChanged={scanItemsChanged} onToast={showToast}/>
      </Portal>}
      {addServerTarget && canOperate && <AddServerDialog rack={addServerTarget.rack} u={addServerTarget.u}
        onClose={() => setAddServerTarget(null)} onAdded={() => { _reloadPositions(); }}/>}
      {section === "racks" && <UndoToast toast={toast} onDismiss={dismissToast}/>}
    </main></ServerActionsContext.Provider></EditContext.Provider></TwinLinkContext.Provider>
  );
}
