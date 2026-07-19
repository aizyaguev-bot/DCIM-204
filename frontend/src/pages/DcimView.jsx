import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

function Portal({ children }) {
  return createPortal(children, document.body);
}
import {
  DndContext, closestCenter, PointerSensor,
  useSensor, useSensors, DragOverlay,
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
};
const Spinner = () => (
  <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round"/>
  </svg>
);

// ─── custom item types ────────────────────────────────────────────────────────
const ITEM_TYPES = {
  switch:     { label: "Switch",       bg: "bg-cyan-900/25",   border: "border-cyan-800/50",   text: "text-cyan-300"   },
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
function genId() { return `ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`; }

function buildRackRows(servers, rackName, rackOrder, rackSlots, customItems) {
  const order  = rackOrder[rackName] || [];
  const slots  = rackSlots[rackName] || {};
  const custom = customItems[rackName] || [];

  const sorted = [...servers].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1; if (bi === -1) return -1;
    return ai - bi;
  });

  // Assign U slots to servers
  const uMap = {};
  sorted.forEach(s => { if (slots[s.id] != null) uMap[s.id] = Number(slots[s.id]); });
  let next = 1;
  const usedByCustom = new Set(custom.map(c => c.u).filter(Boolean));
  sorted.forEach(s => {
    if (uMap[s.id] == null) {
      while (Object.values(uMap).includes(next)) next++;
      uMap[s.id] = next++;
    }
  });

  // Build per-U groups: u → [{kind, data}]
  const groups = new Map();
  sorted.forEach(s => {
    const u = uMap[s.id];
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u).push({ kind: "server", data: s });
  });
  custom.forEach(item => {
    const u = item.u || 99;
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u).push({ kind: "custom", data: item });
  });

  const maxU   = groups.size ? Math.max(...groups.keys()) : 0;
  const totalU = Math.max(maxU + 2, 8);
  const rows   = [];
  for (let u = 1; u <= totalU; u++) {
    rows.push({ u, items: groups.get(u) || [] });
  }
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
  return <div className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mb-1.5">{children}</div>;
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
    <button onClick={onClose}
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

// Inline-rename text span
function InlineName({ value, onRename, className }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  const ref = useRef(null);

  useEffect(() => { if (editing) { setDraft(value); ref.current?.select(); } }, [editing]);

  function commit() {
    const v = draft.trim();
    if (v && v !== value) onRename?.(v);
    setEditing(false);
  }

  if (editing) {
    return (
      <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        onBlur={commit} onClick={e => e.stopPropagation()}
        className="flex-1 min-w-0 bg-transparent border-b border-nv-400/70 outline-none text-[11px] font-mono text-zinc-100"/>
    );
  }
  return (
    <span onDoubleClick={e => { e.stopPropagation(); setEditing(true); }}
      title="Double-click to rename"
      className={`${className} cursor-text select-none`}>
      {value}
    </span>
  );
}

// Individual server cell (takes flex-1 in the row)
function ServerCell({ server, sw, onSelect, onRename }) {
  const isOn = server.state === "on", isOff = server.state === "off";
  const stateStripe = isOn ? "bg-nv-400/80" : isOff ? "bg-red-800/80" : "bg-zinc-700/50";
  const ledColor    = isOn ? "bg-nv-400 shadow-[0_0_8px_#76b900]" : isOff ? "bg-red-700" : "bg-zinc-700";
  return (
    <div onClick={() => onSelect?.(server)}
      className={`flex-1 min-w-0 flex items-stretch rounded overflow-hidden cursor-pointer transition-all
        ${isOn ? "bg-gradient-to-r from-nv-400/20 via-nv-400/8 to-transparent border border-nv-400/35 hover:border-nv-400/60 hover:from-nv-400/28"
               : isOff ? "bg-zinc-800/60 border border-zinc-700/40 hover:bg-zinc-800/80"
               : "bg-zinc-900/50 border border-zinc-800/30 hover:bg-zinc-900/80"}`}
      style={{ minHeight: SLOT_H - 6 }}>
      {/* left state stripe */}
      <div className={`w-1 flex-shrink-0 ${stateStripe}`}/>
      {/* content */}
      <div className="flex flex-1 items-center gap-2 px-2 min-w-0">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${ledColor}`}/>
        <div className="flex-1 min-w-0">
          <InlineName value={server.name} onRename={onRename}
            className={`text-[11px] font-mono font-bold leading-tight block truncate
              ${isOn ? "text-zinc-100" : isOff ? "text-zinc-500" : "text-zinc-600"}`}/>
          {(sw?.switch || server.watts > 0) && (
            <div className="flex items-center gap-1 mt-0.5">
              {sw?.switch && <span className="text-[7px] font-mono text-cyan-400/70 bg-cyan-950/60 px-1 rounded border border-cyan-900/40 leading-tight truncate max-w-[80px]">{sw.switch}{sw.port ? `·${sw.port}` : ""}</span>}
              {server.watts > 0 && <span className={`text-[8px] font-mono tabular-nums leading-tight ${isOn ? "text-nv-400/80" : "text-zinc-600"}`}>{server.watts.toFixed(0)}W</span>}
            </div>
          )}
        </div>
        {isOn  && <span className="text-[7px] font-bold text-nv-400/60 uppercase tracking-widest flex-shrink-0 pr-1">ON</span>}
        {isOff && <span className="text-[7px] font-bold text-red-900/80 uppercase tracking-widest flex-shrink-0 pr-1">OFF</span>}
      </div>
    </div>
  );
}

// Individual equipment cell (fixed compact width)
function EquipCell({ item, onSelect, onRename }) {
  const meta = ITEM_TYPES[item.type] || ITEM_TYPES.other;
  return (
    <div onClick={() => onSelect?.(item)}
      className={`flex-shrink-0 flex items-stretch rounded overflow-hidden cursor-pointer hover:brightness-125 transition-all border ${meta.border}`}
      style={{ minHeight: SLOT_H - 6, width: 96 }}>
      {/* left type stripe */}
      <div className={`w-1 flex-shrink-0 ${meta.bg} opacity-80`}/>
      <div className={`flex-1 flex flex-col justify-center px-1.5 ${meta.bg}`}>
        <span className={`text-[7px] font-bold uppercase tracking-widest ${meta.text} opacity-60 leading-tight`}>{meta.label}</span>
        <InlineName value={item.name} onRename={onRename}
          className={`text-[9px] font-mono font-semibold ${meta.text} leading-tight block truncate`}/>
        {item.notes && <span className="text-[7px] text-zinc-600 truncate leading-tight">{item.notes}</span>}
      </div>
    </div>
  );
}

// One U row — server + equipment side by side, or just equipment, or empty
function USlotGroup({ u, items, switchAssignments, onSelectServer, onSelectCustom, onRenameServer, onRenameCustom, dragHandleProps }) {
  const serverItem = items.find(i => i.kind === "server");
  const equipItems = items.filter(i => i.kind === "custom");

  if (items.length === 0) {
    return (
      <div style={{ height: EMPTY_H }} className="flex items-center select-none group/empty">
        {/* U rail */}
        <div className="w-10 flex-shrink-0 h-full bg-zinc-900/70 border-r border-zinc-800/50 flex items-center justify-end pr-1.5">
          <span className="text-[7px] font-mono text-zinc-800 group-hover/empty:text-zinc-700 transition">{String(u).padStart(2,"0")}</span>
        </div>
        <div className="w-5 flex-shrink-0"/>
        <div className="flex-1 h-px bg-zinc-900/80"/>
        {/* right screw dot */}
        <div className="w-2 flex-shrink-0 flex items-center justify-center">
          <div className="w-1 h-1 rounded-full bg-zinc-800/60"/>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: SLOT_H }} className="flex items-stretch border-b border-zinc-900/40 last:border-0">
      {/* U rail column */}
      <div className="w-10 flex-shrink-0 bg-zinc-900/70 border-r border-zinc-800/50 flex flex-col items-center justify-center select-none gap-0.5">
        <div className="w-1 h-1 rounded-full bg-zinc-700/40 flex-shrink-0"/>
        <span className="text-[8px] font-mono font-bold text-zinc-500">{String(u).padStart(2,"0")}</span>
        <div className="w-1 h-1 rounded-full bg-zinc-700/40 flex-shrink-0"/>
      </div>
      {/* drag grip — only if there's a server */}
      {serverItem ? (
        <div {...(dragHandleProps || {})} onClick={e => e.stopPropagation()}
          className="flex items-center justify-center w-5 flex-shrink-0 text-zinc-800 hover:text-zinc-500 cursor-grab active:cursor-grabbing transition-colors">
          {Icon.grip}
        </div>
      ) : <div className="w-5 flex-shrink-0"/>}
      {/* content: server + equipment side-by-side */}
      <div className="flex-1 flex items-stretch gap-1.5 py-1.5 pr-2 min-w-0 overflow-hidden">
        {serverItem && (
          <ServerCell server={serverItem.data}
            sw={switchAssignments[serverItem.data.id]}
            onSelect={onSelectServer}
            onRename={v => onRenameServer?.(serverItem.data, v)}/>
        )}
        {equipItems.map(({ data }) => (
          <EquipCell key={data.id} item={data}
            onSelect={onSelectCustom}
            onRename={v => onRenameCustom?.(data, v)}/>
        ))}
      </div>
    </div>
  );
}

// Sortable wrapper — applies DnD to the server in a U group
function SortableURow({ u, items, switchAssignments, onSelectServer, onSelectCustom, onRenameServer, onRenameCustom, isDragging }) {
  const serverId = items.find(i => i.kind === "server")?.data.id;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: serverId || "noop" });
  const dragHandleProps = serverId ? { ...listeners, ...attributes } : {};

  return (
    <div ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-30" : ""}>
      <USlotGroup u={u} items={items} switchAssignments={switchAssignments}
        onSelectServer={onSelectServer} onSelectCustom={onSelectCustom}
        onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}
        dragHandleProps={dragHandleProps}/>
    </div>
  );
}

// ─── RACK DIAGRAM ─────────────────────────────────────────────────────────────
function RackDiagram({ r, rackSlots, switchAssignments, rackOrder, customItems, onReorder, onSelect, onSelectCustom, onRenameServer, onRenameCustom, onHeaderClick, width = 400, fixed = false }) {
  const [activeId, setActiveId] = useState(null);
  const containerRef = useRef(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { rows, uMap, sorted } = useMemo(
    () => buildRackRows(r.servers, r.rack, { [r.rack]: rackOrder[r.rack] }, { [r.rack]: rackSlots[r.rack] }, customItems),
    [r.servers, r.rack, rackOrder, rackSlots, customItems]
  );

  const serverIds    = sorted.map(s => s.id);
  const activeServer = sorted.find(s => s.id === activeId);
  const pduOnline    = r.pduOnline;
  const capPct       = r.maxWatts > 0 ? Math.min(100, r.totalWatts / r.maxWatts * 100) : 0;
  const capColor     = capPct > 80 ? "#ef4444" : capPct > 55 ? "#f59e0b" : "#76b900";
  const borderCls    = pduOnline ? "border-zinc-700" : r.pdus.length ? "border-zinc-800" : "border-zinc-900";

  function handleDragEnd({ active, over }) {
    setActiveId(null);
    if (!active || !over || active.id === over.id) return;
    onReorder(r.rack, arrayMove(serverIds, serverIds.indexOf(active.id), serverIds.indexOf(over.id)));
  }

  return (
    <div ref={containerRef} className={fixed ? "flex-shrink-0" : "w-full min-w-0"} style={fixed ? { width } : undefined}>
      {/* label plate */}
      <div className={`mb-0 rounded-t-xl border-2 border-b-0 px-4 py-2.5 bg-zinc-900
        ${pduOnline ? "border-zinc-700" : r.pdus.length ? "border-red-900/60" : "border-zinc-800"}`}>
        <div className="flex items-center justify-between gap-2">
          <button onClick={onHeaderClick} className="flex items-center gap-1.5 min-w-0 group/rh">
            <span className="text-[13px] font-bold font-mono text-zinc-100 group-hover/rh:text-nv-400 transition truncate tracking-wide">{r.rack}</span>
            {onHeaderClick && <span className="text-[10px] text-zinc-600 group-hover/rh:text-nv-400 transition">↗</span>}
          </button>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${pduOnline ? "bg-nv-400 shadow-[0_0_6px_#76b900]" : r.pdus.length ? "bg-red-600" : "bg-zinc-700"}`}/>
              <span className={`text-[9px] font-mono font-bold ${pduOnline ? "text-nv-400" : r.pdus.length ? "text-red-500" : "text-zinc-600"}`}>
                {pduOnline ? "ONLINE" : r.pdus.length ? "OFFLINE" : "NO PDU"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex gap-3 text-[9px] font-mono mt-1">
          <span className="text-zinc-500">{r.servers.length} OPT{r.servers.length!==1?"s":""}</span>
          {(customItems[r.rack]||[]).length > 0 && <span className="text-zinc-600">{(customItems[r.rack]||[]).length} equip</span>}
          {r.totalWatts > 0 && <span className="text-zinc-500">{r.totalWatts.toFixed(0)} W</span>}
          {r.pdus.map(p => <span key={p.id} className="text-zinc-700">{p.ip}</span>)}
        </div>
      </div>

      {/* chassis body */}
      <div className={`border-l-4 border-r-4 bg-zinc-950 ${borderCls}`}>
        {/* top cap bar with screw dots */}
        <div className="bg-zinc-900 border-b border-zinc-800/80 h-3 flex items-center justify-between px-2">
          <div className="flex gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700/60"/>
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700/60"/>
          </div>
          <div className="flex gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700/60"/>
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700/60"/>
          </div>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragStart={e => setActiveId(e.active.id)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}>
          <SortableContext items={serverIds} strategy={verticalListSortingStrategy}>
            {rows.map(({ u, items }) => {
              const serverItem = items.find(i => i.kind === "server");
              if (serverItem) {
                return (
                  <SortableURow key={`u${u}`} u={u} items={items}
                    switchAssignments={switchAssignments}
                    onSelectServer={onSelect} onSelectCustom={onSelectCustom}
                    onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}
                    isDragging={serverItem.data.id === activeId}/>
                );
              }
              return (
                <USlotGroup key={`u${u}`} u={u} items={items}
                  switchAssignments={switchAssignments}
                  onSelectServer={onSelect} onSelectCustom={onSelectCustom}
                  onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}/>
              );
            })}
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {activeServer && (
              <div style={{ width: (containerRef.current?.offsetWidth || width) - 8, background: "#0d0d0d", border: "1px solid #76b90040" }}
                className="rounded shadow-xl opacity-90 overflow-hidden">
                <ServerCell server={activeServer} sw={switchAssignments[activeServer.id]}/>
              </div>
            )}
          </DragOverlay>
        </DndContext>
        {/* bottom cap bar with screw dots */}
        <div className="bg-zinc-900 border-t border-zinc-800/80 h-3 flex items-center justify-between px-2">
          <div className="flex gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700/60"/>
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700/60"/>
          </div>
          <div className="flex gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700/60"/>
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-700/60"/>
          </div>
        </div>
      </div>

      {/* footer */}
      <div className={`border-l-4 border-r-4 border-b-4 rounded-b-xl bg-zinc-900 px-4 py-2.5 ${borderCls}`}>
        {r.pdus.length ? (
          <>
            <div className="flex justify-between items-center text-[9px] font-mono mb-1.5">
              <span className="text-zinc-600 font-bold uppercase tracking-widest">Power</span>
              <span style={{ color: capColor }} className="font-bold">
                {r.totalWatts > 0 ? `${r.totalWatts.toFixed(0)} W · ${capPct.toFixed(0)}%` : "offline"}
              </span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${capPct}%`, background: capColor }}/>
            </div>
          </>
        ) : <div className="text-[9px] font-mono text-zinc-800 text-center uppercase tracking-widest">No PDU attached</div>}
      </div>
    </div>
  );
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
  const [u,     setU]     = useState("");
  const [notes, setNotes] = useState("");
  const [busy,  setBusy]  = useState(false);

  async function submit() {
    if (!name.trim() || !u) return;
    setBusy(true);
    try { await onSave({ id: genId(), name: name.trim(), type, u: parseInt(u, 10), notes: notes.trim() }); }
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
          <div><SL>U slot</SL>
            <input type="number" min="1" max="42" value={u} onChange={e => setU(e.target.value)}
              placeholder="e.g. 7"
              className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
          </div>
          <div><SL>Notes (optional)</SL>
            <input value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="e.g. 48-port 1G managed"
              className="w-full bg-zinc-800 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
          </div>
        </div>
        <div className="px-5 pb-4 flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 text-sm text-zinc-500 border border-zinc-700/40 rounded-lg hover:text-zinc-300 transition">Cancel</button>
          <button onClick={submit} disabled={!name.trim() || !u || busy}
            className="flex-1 py-2 text-sm font-bold bg-nv-400 text-zinc-950 rounded-lg disabled:opacity-40 flex items-center justify-center gap-2">
            {busy && <Spinner/>}Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── EDIT EQUIPMENT PANEL (custom items) ──────────────────────────────────────
function EditEquipmentPanel({ item, rackName, onClose, onSave, onDelete }) {
  useEscClose(onClose);
  const [name,  setName]  = useState(item.name);
  const [type,  setType]  = useState(item.type || "other");
  const [u,     setU]     = useState(item.u ? String(item.u) : "");
  const [notes, setNotes] = useState(item.notes || "");
  const [busy,  setBusy]  = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit() {
    setBusy(true);
    try { await onSave({ ...item, name: name.trim(), type, u: parseInt(u,10)||item.u, notes: notes.trim() }); setSaved(true); setTimeout(()=>setSaved(false),2000); }
    finally { setBusy(false); }
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
          <div><SL>U slot</SL>
            <input type="number" min="1" max="42" value={u} onChange={e=>setU(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50"/>
          </div>
          <div><SL>Notes</SL>
            <textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={2}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50 resize-none"/>
          </div>
          <button onClick={submit} disabled={busy || !name.trim()}
            className={`w-full py-2 text-sm font-bold rounded-lg transition flex items-center justify-center gap-2
              ${saved?"bg-emerald-900/50 text-emerald-400 border border-emerald-800/50":"bg-nv-400 text-zinc-950 disabled:opacity-40"}`}>
            {busy?<Spinner/>:saved?Icon.check:null}{saved?"Saved":"Save changes"}
          </button>
        </div>
        <div className="px-5 py-4 border-t border-zinc-800/40">
          <button onClick={async()=>{ if(!confirm(`Delete "${item.name}"?`))return; await onDelete(item); onClose(); }}
            className="w-full py-2 text-xs font-medium text-rose-600 hover:text-rose-400 border border-rose-900/40 hover:border-rose-800/60 rounded-lg transition">
            Delete from rack
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SERVER EDIT PANEL ────────────────────────────────────────────────────────
function ServerEditPanel({ server, pdus, rackSlots, switchAssignments, onClose, onOutletAction, onLabelChange, onSlotsChange, onSwitchChange }) {
  useEscClose(onClose);
  const pdu   = pdus.find(p => p.id === server.pduId);
  const curU  = (rackSlots[server.rack] || {})[server.id];
  const curSw = switchAssignments[server.id] || {};

  const [name,   setName]   = useState(server.name);
  const [uSlot,  setUSlot]  = useState(curU != null ? String(curU) : "");
  const [swName, setSwName] = useState(curSw.switch || "");
  const [swPort, setSwPort] = useState(curSw.port != null ? String(curSw.port) : "");
  const [doing,  setDoing]  = useState(null);
  const [saved,  setSaved]  = useState(null);

  const isOn = server.state==="on", isOff=server.state==="off";
  const led  = isOn?"bg-nv-400 shadow-[0_0_7px_#76b900]":isOff?"bg-red-700":"bg-zinc-700";
  function tick(k){setSaved(k);setTimeout(()=>setSaved(s=>s===k?null:s),2000);}

  async function power(a){if(!onOutletAction)return;setDoing(a);try{await onOutletAction(server.pduId,server.outlet,a);}finally{setDoing(null);}}
  async function saveName(){if(!name.trim()||!pdu||!onLabelChange)return;setDoing("name");await onLabelChange(server.pduId,{...pdu.labels,[String(server.outlet)]:name.trim()});setDoing(null);tick("name");}
  async function saveSlot(){const u=parseInt(uSlot,10);if(isNaN(u)||u<1)return;setDoing("slot");const up={...rackSlots,[server.rack]:{...(rackSlots[server.rack]||{}),[server.id]:u}};onSlotsChange(up);await fetch("/api/rack-slots",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(up)});setDoing(null);tick("slot");}
  async function saveSw(){setDoing("sw");const up={...switchAssignments};if(swName.trim()||swPort)up[server.id]={switch:swName.trim(),port:swPort?parseInt(swPort,10):null};else delete up[server.id];onSwitchChange(up);await fetch("/api/switch-assignments",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(up)});setDoing(null);tick("sw");}
  async function remove(){if(!pdu||!onLabelChange)return;if(!confirm(`Remove "${server.name}" from DCIM?`))return;const l={...pdu.labels};delete l[String(server.outlet)];await onLabelChange(server.pduId,l);onClose();}

  const SetBtn=({id,onClick,disabled})=>(
    <button onClick={onClick} disabled={disabled||doing===id}
      className={`px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border flex items-center gap-1 transition
        ${saved===id?"bg-emerald-900/40 text-emerald-400 border-emerald-800/50":"bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700/50 disabled:opacity-40"}`}>
      {doing===id?<Spinner/>:saved===id?Icon.check:"Set"}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="h-full w-[320px] bg-zinc-950 border-l border-zinc-800/80 shadow-2xl flex flex-col"
        onClick={e=>e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-800/60 bg-zinc-900/60">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`w-3 h-3 rounded-full flex-shrink-0 mt-0.5 ${led}`}/>
              <div className="min-w-0">
                <div className="text-sm font-bold text-zinc-100 truncate">{server.name}</div>
                <div className={`text-[10px] mt-0.5 ${isOn?"text-nv-400":isOff?"text-red-500":"text-zinc-500"}`}>
                  {server.state||"unknown"}{server.watts>0?` · ${server.watts.toFixed(0)} W`:""}
                </div>
              </div>
            </div>
            <CloseBtn onClose={onClose}/>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
            {[["Rack",server.rack||"—"],["Outlet",server.outlet!=null?`#${server.outlet}`:"—"],["U",curU!=null?`U${curU}`:"auto"],["PDU",pdu?.name||"—"]].map(([k,v])=>(
              <div key={k} className="flex items-baseline gap-1">
                <span className="text-[9px] text-zinc-700 w-10 flex-shrink-0">{k}</span>
                <span className="text-[10px] font-mono text-zinc-400 truncate">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {onOutletAction&&server.pduId&&server.outlet!=null&&(
            <div><SL>Power control</SL>
              <div className="grid grid-cols-3 gap-1.5">
                {[{a:"on",l:"Power On",c:"bg-emerald-900/50 hover:bg-emerald-900 text-emerald-400 border-emerald-800/40"},
                  {a:"off",l:"Power Off",c:"bg-rose-900/40 hover:bg-rose-900/70 text-rose-400 border-rose-800/40"},
                  {a:"cycle",l:"Cycle",c:"bg-amber-900/30 hover:bg-amber-900/60 text-amber-400 border-amber-800/40"}
                ].map(({a,l,c})=>(
                  <button key={a} onClick={()=>power(a)} disabled={!!doing}
                    className={`flex flex-col items-center justify-center py-2.5 text-[10px] font-semibold rounded-xl border transition gap-1 ${c} disabled:opacity-40`}>
                    {doing===a&&<Spinner/>}{l}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div><SL>Rename</SL>
            <div className="flex gap-2">
              <input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveName()}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50"/>
              <SetBtn id="name" onClick={saveName} disabled={!name.trim()}/>
            </div>
          </div>

          <div><SL>Rack unit (U)</SL>
            <div className="flex gap-2">
              <input type="number" min="1" max="42" value={uSlot} onChange={e=>setUSlot(e.target.value)}
                placeholder={curU!=null?`U${curU}`:"auto"}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
              <SetBtn id="slot" onClick={saveSlot} disabled={!uSlot}/>
            </div>
            <div className="mt-1 text-[10px] text-zinc-700">{curU!=null?`Currently U${curU}`:"Auto-assigned"}</div>
          </div>

          <div><SL>Network switch</SL>
            <div className="space-y-2">
              <input value={swName} onChange={e=>setSwName(e.target.value)} placeholder="Switch name"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-700/50 placeholder:text-zinc-700"/>
              <div className="flex gap-2">
                <input type="number" min="1" max="96" value={swPort} onChange={e=>setSwPort(e.target.value)} placeholder="Port"
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-cyan-700/50 placeholder:text-zinc-700"/>
                <SetBtn id="sw" onClick={saveSw}/>
              </div>
              {curSw.switch&&<div className="text-[10px] text-cyan-700">{curSw.switch}{curSw.port?` · port ${curSw.port}`:""}</div>}
            </div>
          </div>

          <div><SL>Connection</SL>
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 divide-y divide-zinc-800/40">
              {[["Rack",server.rack||"—"],["PDU",pdu?.name||"—"],["PDU IP",pdu?.ip||"—"],["Outlet",server.outlet!=null?`#${server.outlet}`:"—"],["Switch",curSw.switch?`${curSw.switch}${curSw.port?`·${curSw.port}`:""}` :"—"]].map(([k,v])=>(
                <div key={k} className="flex items-center px-3 py-1.5 gap-3">
                  <span className="text-[9px] text-zinc-700 uppercase tracking-wide w-14 flex-shrink-0">{k}</span>
                  <span className="text-[11px] font-mono text-zinc-400 break-all">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-zinc-800/40 bg-zinc-900/30">
          <button onClick={remove} className="w-full py-2 text-xs font-medium text-rose-600 hover:text-rose-400 border border-rose-900/40 hover:border-rose-800/60 rounded-lg transition">
            Remove from DCIM
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RACK DETAIL VIEW ─────────────────────────────────────────────────────────
function RackDetailView({ r, rackSlots, switchAssignments, rackOrder, customItems, onBack, onReorder, onSelect, onSelectCustom, onRenameServer, onRenameCustom, onRequestAddOpt, onRequestAddEquip }) {
  const { rows, uMap, sorted } = useMemo(
    () => buildRackRows(r.servers, r.rack, { [r.rack]: rackOrder[r.rack] }, { [r.rack]: rackSlots[r.rack] }, customItems),
    [r.servers, r.rack, rackOrder, rackSlots, customItems]
  );
  const pduOnline = r.pduOnline;
  const capPct    = r.maxWatts > 0 ? Math.min(100, r.totalWatts/r.maxWatts*100) : 0;
  const capColor  = capPct>80?"#ef4444":capPct>55?"#f59e0b":"#76b900";
  const Th=({label,right})=>(
    <th className={`text-[9px] font-bold uppercase tracking-widest px-3 py-2 text-zinc-600 ${right?"text-right":"text-left"} whitespace-nowrap`}>{label}</th>
  );
  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-nv-400 border border-zinc-800 hover:border-nv-400/40 px-2.5 py-1 rounded-lg transition">
          {Icon.back} All racks
        </button>
        <span className="text-zinc-700">/</span>
        <span className="text-sm font-bold text-zinc-100">{r.rack}</span>
        <Pill color={pduOnline?"nv":r.pdus.length?"red":"zinc"} sm>{pduOnline?"online":r.pdus.length?"offline":"no PDU"}</Pill>
      </div>

      <div className="flex gap-6 items-start min-w-0 overflow-x-auto">
        {/* Large rack diagram */}
        <RackDiagram r={r} rackSlots={rackSlots} switchAssignments={switchAssignments}
          rackOrder={rackOrder} customItems={customItems}
          onReorder={onReorder} onSelect={onSelect} onSelectCustom={onSelectCustom}
          onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}
          width={480} fixed/>

        {/* Right panel */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Action buttons */}
          <div className="flex gap-2">
            <button onClick={() => onRequestAddEquip(r.rack)}
              className="flex items-center gap-1.5 text-sm font-semibold text-zinc-300 border border-zinc-700/50 hover:border-zinc-500 hover:text-zinc-100 px-4 py-2 rounded-xl transition">
              {Icon.plus} Equipment
            </button>
            {r.pdus.length > 0 && (
              <button onClick={() => onRequestAddOpt(r)}
                className="flex items-center gap-1.5 text-sm font-semibold text-nv-400 border border-nv-400/40 hover:border-nv-400/70 hover:bg-nv-400/8 px-4 py-2 rounded-xl transition">
                {Icon.plus} OPT
              </button>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            {[
              ["OPTs", r.servers.length],
              ["Equipment", (customItems[r.rack]||[]).length],
              ["Power draw", r.totalWatts > 0 ? `${r.totalWatts.toFixed(0)} W` : "—"],
              ["PDU capacity", `${capPct.toFixed(0)}%`],
              ["Outlets on", `${r.outletsOn} / ${r.outletsTotal}`],
              ["Status", pduOnline ? "Online" : r.pdus.length ? "Offline" : "No PDU"],
            ].map(([k, v]) => (
              <div key={k} className="bg-zinc-900/60 border border-zinc-800/50 rounded-xl px-4 py-3">
                <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1">{k}</div>
                <div className="text-lg font-bold text-zinc-100">{v}</div>
              </div>
            ))}
          </div>

          {/* PDUs */}
          {r.pdus.length > 0 && (
            <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl px-4 py-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-2">PDUs</div>
              {r.pdus.map(p => (
                <div key={p.id} className="flex items-center gap-3 py-1.5 border-b border-zinc-800/30 last:border-0">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${pduOnline ? "bg-nv-400 shadow-[0_0_4px_#76b900]" : "bg-zinc-600"}`}/>
                  <span className="text-sm font-semibold text-zinc-200">{p.name}</span>
                  <span className="text-xs font-mono text-zinc-500 ml-auto">{p.ip}</span>
                </div>
              ))}
            </div>
          )}

          {/* Server table */}
          <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-zinc-800/50 flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-200">All equipment — {r.rack}</span>
              <span className="text-[10px] text-zinc-600">double-click name to rename · click row to edit</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-zinc-800/70 bg-zinc-900/40">
                  <tr><Th label="U"/><Th label="Name"/><Th label="Type"/><Th label="State"/><Th label="W" right/><Th label="Outlet" right/><Th label="Switch"/></tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/30">
                  {/* PDU servers */}
                  {sorted.map(s=>{
                    const u=uMap[s.id],sw=switchAssignments[s.id];
                    const isOn=s.state==="on",isOff=s.state==="off";
                    return (
                      <tr key={s.id} onClick={()=>onSelect(s)}
                        className={`cursor-pointer hover:bg-zinc-800/30 transition-colors ${isOn?"hover:bg-nv-400/5":""}`}>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-600">U{u}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isOn?"bg-nv-400 shadow-[0_0_4px_#76b900]":isOff?"bg-red-700":"bg-zinc-700"}`}/>
                            <span className="font-mono text-[11px] font-bold text-zinc-200">{s.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-600">OPT</td>
                        <td className="px-3 py-2"><Pill color={isOn?"green":isOff?"red":"zinc"} sm>{s.state||"?"}</Pill></td>
                        <td className="px-3 py-2 text-xs font-mono text-right">{s.watts>0?<span className={isOn?"text-nv-400":"text-zinc-600"}>{s.watts.toFixed(0)}</span>:<span className="text-zinc-800">—</span>}</td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-600 text-right">{s.outlet!=null?`#${s.outlet}`:<span className="text-zinc-800">—</span>}</td>
                        <td className="px-3 py-2 text-xs">{sw?.switch?<Pill color="cyan" sm>{sw.switch}{sw.port?`·${sw.port}`:""}</Pill>:<span className="text-zinc-800">—</span>}</td>
                      </tr>
                    );
                  })}
                  {/* Custom items */}
                  {(customItems[r.rack]||[]).map(item=>{
                    const meta=ITEM_TYPES[item.type]||ITEM_TYPES.other;
                    return (
                      <tr key={item.id} onClick={()=>onSelectCustom(item)}
                        className="cursor-pointer hover:bg-zinc-800/25 transition-colors">
                        <td className="px-3 py-2 font-mono text-xs text-zinc-600">U{item.u||"?"}</td>
                        <td className="px-3 py-2 font-mono text-[11px] font-bold text-zinc-300">{item.name}</td>
                        <td className="px-3 py-2 text-xs"><span className={`${meta.text} font-medium`}>{meta.label}</span></td>
                        <td className="px-3 py-2 text-xs text-zinc-700">—</td>
                        <td className="px-3 py-2 text-xs text-zinc-800 text-right">—</td>
                        <td className="px-3 py-2 text-xs text-zinc-800 text-right">—</td>
                        <td className="px-3 py-2 text-xs text-zinc-700">{item.notes||"—"}</td>
                      </tr>
                    );
                  })}
                  {sorted.length===0&&(customItems[r.rack]||[]).length===0&&(
                    <tr><td colSpan={8} className="px-4 py-10 text-center text-zinc-700 text-sm">No equipment in this rack</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ADD RACK MODAL ───────────────────────────────────────────────────────────
function AddRackModal({ onClose, onSave }) {
  const [rackName, setRackName] = useState("");
  const [pduName,  setPduName]  = useState("");
  const [pduIp,    setPduIp]    = useState("");
  const [pduUser,  setPduUser]  = useState("");
  const [pduPass,  setPduPass]  = useState("");
  const [saving,   setSaving]   = useState(false);
  const [err,      setErr]      = useState("");
  useEscClose(onClose);

  async function handleSave() {
    if (!rackName.trim() || !pduName.trim() || !pduIp.trim()) {
      setErr("Rack name, PDU name and IP are required.");
      return;
    }
    setSaving(true); setErr("");
    try {
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: pduName.trim(),
          kind: "pdu",
          model: "Raritan PDU",
          ip: pduIp.trim(),
          rack: rackName.trim(),
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

  const Field = ({ label, value, onChange, placeholder, type = "text" }) => (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1">{label}</div>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-950 border border-zinc-800/80 rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/50">
          <span className="text-sm font-bold text-zinc-100">Add Rack</span>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition">{Icon.x}</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Field label="Rack name" value={rackName} onChange={setRackName} placeholder="e.g. Rack-08"/>
          <Field label="PDU name" value={pduName} onChange={setPduName} placeholder="e.g. PDU-Rack-08"/>
          <Field label="PDU IP address" value={pduIp} onChange={setPduIp} placeholder="e.g. 10.7.30.203"/>
          <div className="grid grid-cols-2 gap-2">
            <Field label="PDU username" value={pduUser} onChange={setPduUser} placeholder="optional"/>
            <Field label="PDU password" value={pduPass} onChange={setPduPass} placeholder="optional" type="password"/>
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

// ─── RACKS VIEW ───────────────────────────────────────────────────────────────
function RacksView({ rackStats, rackSlots, rackOrder, switchAssignments, customItems, onReorder, onSelect, onSelectCustom, onLabelChange, onSlotsChange, onRenameServer, onRenameCustom, onCustomItemsChange, onRefresh }) {
  const [selectedRack, setSelectedRack] = useState(null);
  const [addOptFor,    setAddOptFor]    = useState(null);
  const [addEquipFor,  setAddEquipFor]  = useState(null);
  const [addRackOpen,  setAddRackOpen]  = useState(false);

  const r = selectedRack ? rackStats.find(r => r.rack === selectedRack) : null;

  async function handleSaveOpt(pduId, outlet, name, existing) {
    try { await onLabelChange(pduId, { ...existing, [String(outlet)]: name }); }
    finally { setAddOptFor(null); }
  }

  async function handleSaveEquip(rackName, item) {
    const updated = { ...customItems, [rackName]: [...(customItems[rackName]||[]), item] };
    const res = await fetch("/api/rack-items", {
      method: "PUT",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(updated),
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    onCustomItemsChange(updated);
    setAddEquipFor(null);
  }

  if (!rackStats.length) return (
    <div className="flex flex-col items-center justify-center py-32 gap-3 text-zinc-600">
      <div className="text-sm">No racks discovered yet.</div>
      <button onClick={() => setAddRackOpen(true)}
        className="flex items-center gap-1.5 text-sm font-semibold text-nv-400 border border-nv-400/40 hover:border-nv-400/70 hover:bg-nv-400/8 px-4 py-2 rounded-xl transition">
        {Icon.plus} Add Rack
      </button>
    </div>
  );

  return (
    <div>
      {r ? (
        <RackDetailView r={r}
          rackSlots={rackSlots} rackOrder={rackOrder}
          switchAssignments={switchAssignments} customItems={customItems}
          onBack={() => setSelectedRack(null)}
          onReorder={onReorder} onSelect={onSelect} onSelectCustom={onSelectCustom}
          onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}
          onRequestAddOpt={setAddOptFor}
          onRequestAddEquip={setAddEquipFor}/>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="text-[10px] text-zinc-700">Click rack name ↗ to open · drag grip to reorder · double-click name to rename</div>
            <button onClick={() => setAddRackOpen(true)}
              className="flex items-center gap-1.5 text-sm font-semibold text-nv-400 border border-nv-400/40 hover:border-nv-400/70 hover:bg-nv-400/8 px-3 py-1.5 rounded-xl transition flex-shrink-0">
              {Icon.plus} Add Rack
            </button>
          </div>
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {rackStats.map(rs => (
              <RackDiagram key={rs.rack} r={rs}
                rackSlots={rackSlots} rackOrder={rackOrder}
                switchAssignments={switchAssignments} customItems={customItems}
                onReorder={onReorder} onSelect={onSelect} onSelectCustom={onSelectCustom}
                onRenameServer={onRenameServer} onRenameCustom={onRenameCustom}
                onHeaderClick={() => setSelectedRack(rs.rack)}/>
            ))}
          </div>
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
    </div>
  );
}

// ─── INVENTORY VIEW ───────────────────────────────────────────────────────────
function InventoryView({ servers, switchAssignments, rackSlots, customItems }) {
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
    if(q.trim()){const lq=q.toLowerCase();list=list.filter(s=>s.name.toLowerCase().includes(lq)||(s.rack||"").toLowerCase().includes(lq)||(switchAssignments[s.id]?.switch||"").toLowerCase().includes(lq));}
    return [...list].sort((a,b)=>{const av=a[sk]??"",bv=b[sk]??"";return typeof av==="number"?sd*(av-bv):sd*String(av).localeCompare(String(bv));});
  },[servers,rack,state,q,sk,sd,switchAssignments]);
  const Th=({k,label,right})=>(<th onClick={()=>{if(sk===k)setSd(d=>-d);else{setSk(k);setSd(1);}}} className={`text-[9px] font-bold uppercase tracking-widest px-3 py-2.5 whitespace-nowrap select-none cursor-pointer hover:text-zinc-300 transition ${right?"text-right":"text-left"} text-zinc-600`}>{label}{sk===k&&<span className="ml-0.5 opacity-50">{sd>0?"↑":"↓"}</span>}</th>);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative"><svg className="absolute left-2.5 top-2" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search…" className="bg-zinc-900 border border-zinc-800 rounded-lg pl-7 pr-3 py-1.5 text-sm w-44 focus:outline-none focus:border-nv-400/50 placeholder:text-zinc-700"/></div>
        <select value={rack} onChange={e=>setRack(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded-lg text-sm px-2.5 py-1.5 focus:outline-none focus:border-nv-400/50"><option value="all">All racks</option>{racks.map(r=><option key={r}>{r}</option>)}</select>
        <select value={state} onChange={e=>setState(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded-lg text-sm px-2.5 py-1.5 focus:outline-none focus:border-nv-400/50"><option value="all">All states</option><option value="on">On</option><option value="off">Off</option><option value="unknown">Unknown</option></select>
        <span className="ml-auto text-[10px] text-zinc-700">{rows.length} / {servers.length}</span>
      </div>
      <div className="border border-zinc-800/60 rounded-xl overflow-hidden bg-zinc-900/30">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/70">
              <tr><Th k="name" label="Asset"/><Th k="rack" label="Rack"/><Th k="state" label="State"/><Th k="watts" label="W" right/><th className="text-[9px] font-bold uppercase tracking-widest px-3 py-2.5 text-zinc-600 text-right">U</th><Th k="outlet" label="Outlet" right/><Th k="pduName" label="PDU"/><Th k="pduIp" label="PDU IP"/><th className="text-[9px] font-bold uppercase tracking-widest px-3 py-2.5 text-zinc-600">Switch</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/30">
              {rows.map(s=>{const isOn=s.state==="on",isOff=s.state==="off",sw=switchAssignments[s.id],u=(rackSlots[s.rack]||{})[s.id];return(
                <tr key={s.id} className={`hover:bg-zinc-800/20 transition-colors ${isOn?"hover:bg-nv-400/4":""}`}>
                  <td className="px-3 py-2"><div className="flex items-center gap-2"><div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isOn?"bg-emerald-400 shadow-[0_0_3px_#34d399]":isOff?"bg-red-700":"bg-zinc-800"}`}/><span className="font-mono text-[11px] font-semibold text-zinc-200">{s.name}</span></div></td>
                  <td className="px-3 py-2 text-xs text-zinc-500 font-mono">{s.rack||"—"}</td>
                  <td className="px-3 py-2"><Pill color={isOn?"green":isOff?"red":"zinc"} sm>{s.state||"?"}</Pill></td>
                  <td className="px-3 py-2 font-mono text-xs text-right">{s.watts>0?<span className={isOn?"text-nv-400/80":"text-zinc-600"}>{s.watts.toFixed(0)}</span>:<span className="text-zinc-800">—</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-600 text-right">{u!=null?`U${u}`:<span className="text-zinc-800">—</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-600 text-right">{s.outlet!=null?`#${s.outlet}`:<span className="text-zinc-800">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-zinc-500">{s.pduName||"—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-700">{s.pduIp||"—"}</td>
                  <td className="px-3 py-2 text-xs">{sw?.switch?<Pill color="cyan" sm>{sw.switch}{sw.port?`·${sw.port}`:""}</Pill>:<span className="text-zinc-800">—</span>}</td>
                </tr>
              );})}
              {rows.length===0&&<tr><td colSpan={9} className="px-3 py-10 text-center text-zinc-700 text-sm">No matching assets</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── POWER VIEW ───────────────────────────────────────────────────────────────
function PowerView({ rackStats }) {
  const total=rackStats.reduce((a,r)=>a+r.totalWatts,0);
  const maxR=Math.max(...rackStats.map(r=>r.totalWatts),1);
  const sorted=[...rackStats].sort((a,b)=>b.totalWatts-a.totalWatts);
  const top=rackStats.flatMap(r=>r.servers).filter(s=>s.watts>0).sort((a,b)=>b.watts-a.watts).slice(0,10);
  if(!rackStats.length)return<div className="text-zinc-600 text-sm py-24 text-center">No power data.</div>;
  const Tile=({label,val,sub,hi})=>(<div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl px-4 py-3"><div className={`text-lg font-bold tabular-nums ${hi?"text-nv-400":"text-zinc-100"}`}>{val}</div><div className="text-[10px] text-zinc-600 mt-0.5">{label}</div>{sub&&<div className="text-[9px] text-zinc-700 mt-0.5">{sub}</div>}</div>);
  return(
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3"><Tile label="Total draw" val={`${(total/1000).toFixed(2)} kW`} sub={`${total.toFixed(0)} W`} hi/><Tile label="Online racks" val={rackStats.filter(r=>r.pduOnline).length} sub={`of ${rackStats.length}`}/><Tile label="Peak rack" val={sorted[0]?.totalWatts>0?`${sorted[0].totalWatts.toFixed(0)} W`:"—"} sub={sorted[0]?.rack}/><Tile label="Outlets on" val={`${rackStats.reduce((a,r)=>a+r.outletsOn,0)}/${rackStats.reduce((a,r)=>a+r.outletsTotal,0)}`}/></div>
      <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl overflow-hidden"><div className="px-5 py-3 border-b border-zinc-800/50 text-sm font-semibold text-zinc-200 flex justify-between"><span>Power per rack</span><span className="text-[10px] text-zinc-600 font-normal">highest first</span></div>
        <div className="p-5 space-y-3">{sorted.map(r=>{const cap=r.maxWatts>0?Math.min(100,r.totalWatts/r.maxWatts*100):0;const col=cap>80?"#ef4444":cap>55?"#f59e0b":"#76b900";return(<div key={r.rack}><div className="flex items-center justify-between mb-1"><div className="flex items-center gap-2"><span className={`w-1.5 h-1.5 rounded-full ${r.pduOnline?"bg-nv-400":"bg-zinc-700"}`}/><span className="text-xs font-mono text-zinc-300 w-20 truncate">{r.rack}</span><Pill color={r.pduOnline?"nv":r.pdus.length?"red":"zinc"} sm>{r.pduOnline?"online":r.pdus.length?"offline":"no PDU"}</Pill></div><span className="text-xs font-mono text-zinc-400">{r.totalWatts>0?`${r.totalWatts.toFixed(0)} W`:<span className="text-zinc-700">—</span>}</span></div><div className="relative h-3.5 bg-zinc-800/50 rounded overflow-hidden"><div className="h-full rounded transition-all duration-700" style={{width:`${(r.totalWatts/maxR)*100}%`,background:col}}/>{r.totalWatts>0&&<span className="absolute inset-0 flex items-center pl-2 text-[8px] font-semibold text-zinc-950">{(r.totalWatts/1000).toFixed(2)} kW · {cap.toFixed(0)}%</span>}</div></div>);})}</div></div>
      {top.length>0&&<div className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl overflow-hidden"><div className="px-5 py-3 border-b border-zinc-800/50 text-sm font-semibold text-zinc-200">Top consumers</div><div className="p-5 space-y-2">{top.map((s,i)=>(<div key={s.id} className="flex items-center gap-3"><span className="text-[9px] font-mono text-zinc-700 w-4 text-right">{i+1}</span><div className={`w-1.5 h-1.5 rounded-full ${s.state==="on"?"bg-emerald-400":"bg-zinc-600"}`}/><span className="text-[11px] font-mono text-zinc-300 flex-1 truncate">{s.name}</span><Pill color="zinc" sm>{s.rack}</Pill><div className="w-24 h-1 bg-zinc-800 rounded-full overflow-hidden"><div className="h-full bg-nv-400 rounded-full" style={{width:`${(s.watts/top[0].watts)*100}%`}}/></div><span className="text-[11px] font-mono text-nv-400 w-12 text-right">{s.watts.toFixed(0)} W</span></div>))}</div></div>}
    </div>
  );
}

// ─── CHANGELOG VIEW ───────────────────────────────────────────────────────────
function ChangelogView() {
  const [text,setText]=useState("");const [loading,setLoading]=useState(true);
  useEffect(()=>{fetch("/api/changelog").then(r=>r.json()).then(d=>setText(d.changelog||"")).catch(()=>setText("Could not load.")).finally(()=>setLoading(false));},[]);
  if(loading)return<div className="text-zinc-600 text-sm py-10 text-center animate-pulse">Loading…</div>;
  const blocks=[];let cur=null;
  text.split("\n").forEach(line=>{const m=line.match(/^##\s+(v[\d.]+)\s*[—–-]\s*(.+)/);if(m){if(cur)blocks.push(cur);cur={ver:m[1],date:m[2].trim(),lines:[]};}else if(cur)cur.lines.push(line);});
  if(cur)blocks.push(cur);
  if(!blocks.length)return<pre className="text-xs text-zinc-500 font-mono whitespace-pre-wrap">{text}</pre>;
  return(
    <div className="space-y-3 max-w-2xl">{blocks.map((b,i)=>(
      <div key={b.ver} className={`border rounded-xl overflow-hidden ${i===0?"border-nv-400/30 bg-nv-400/4":"border-zinc-800/60 bg-zinc-900/30"}`}>
        <div className={`px-4 py-2.5 border-b flex items-center gap-2.5 ${i===0?"border-nv-400/20 bg-nv-400/8":"border-zinc-800/50 bg-zinc-900/50"}`}>
          <span className={`font-mono text-sm font-bold ${i===0?"text-nv-400":"text-zinc-300"}`}>{b.ver}</span>
          {i===0&&<span className="text-[9px] px-1.5 py-px bg-nv-400/20 text-nv-400 border border-nv-400/30 rounded font-bold tracking-wide">CURRENT</span>}
          <span className="text-[10px] text-zinc-600 ml-auto font-mono">{b.date}</span>
        </div>
        <div className="px-4 py-3 space-y-0.5">{b.lines.map((line,j)=>{
          const h3=line.match(/^###\s+(.+)/),bul=line.match(/^[-*]\s+(.+)/),sub=line.match(/^\s{2,}[-*]\s+(.+)/);
          if(h3)return<div key={j} className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mt-3 mb-1 first:mt-0">{h3[1]}</div>;
          if(sub)return<div key={j} className="text-[10px] text-zinc-600 pl-4 flex gap-1.5"><span className="text-zinc-700">↳</span>{sub[1]}</div>;
          if(bul)return<div key={j} className="text-[11px] text-zinc-400 flex gap-2"><span className="text-zinc-700">·</span><span>{bul[1]}</span></div>;
          if(!line.trim())return null;
          return<div key={j} className="text-[10px] text-zinc-600">{line}</div>;
        })}</div>
      </div>
    ))}</div>
  );
}

// ─── KPI BAR ──────────────────────────────────────────────────────────────────
function KpiBar({servers,rackStats,pdus,pduStatuses}) {
  const totalW=rackStats.reduce((a,r)=>a+r.totalWatts,0);
  const on=servers.filter(s=>s.state==="on").length;
  const alerts=pdus.filter(p=>pduStatuses[p.id]&&pduStatuses[p.id].reachable===false).length;
  const Kpi=({label,value,sub,hi})=>(<div className="flex flex-col min-w-[100px]"><div className={`text-lg font-bold tabular-nums leading-none ${hi?"text-nv-400":"text-zinc-100"}`}>{value}</div><div className="text-[10px] text-zinc-600 mt-px">{label}</div>{sub&&<div className="text-[9px] text-zinc-700 mt-px">{sub}</div>}</div>);
  return(
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 mb-6 px-5 py-3.5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
      <Kpi label="Total draw" value={totalW>0?`${(totalW/1000).toFixed(2)} kW`:"—"} hi/>
      <div className="w-px h-8 bg-zinc-800 hidden sm:block"/>
      <Kpi label="Servers on" value={`${on}/${servers.length}`} sub={`${servers.length-on} off or unknown`}/>
      <Kpi label="Racks" value={rackStats.length} sub={`${rackStats.filter(r=>r.pduOnline).length} online`}/>
      {alerts>0&&<><div className="w-px h-8 bg-zinc-800 hidden sm:block"/><div className="flex items-center gap-1.5 text-red-500"><div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"/><span className="text-sm font-semibold">{alerts} alert{alerts!==1?"s":""}</span><span className="text-[10px] text-red-700">PDU unreachable</span></div></>}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function DcimView({devices,pduStatuses,kvmStatuses,onOutletAction,onLabelChange,onRefresh}) {
  const [section,           setSection]           = useState("racks");
  const [rackOrder,         setRackOrder]         = useState({});
  const [rackSlots,         setRackSlots]         = useState({});
  const [switchAssignments, setSwitchAssignments] = useState({});
  const [customItems,       setCustomItems]       = useState({});
  const [selectedServerId,  setSelectedServerId]  = useState(null);
  const [selectedCustom,    setSelectedCustom]    = useState(null);

  useEffect(()=>{
    Promise.all([
      fetch("/api/rack-positions").then(r=>r.json()).catch(()=>({})),
      fetch("/api/rack-slots").then(r=>r.json()).catch(()=>({})),
      fetch("/api/switch-assignments").then(r=>r.json()).catch(()=>({})),
      fetch("/api/rack-items").then(r=>r.json()).catch(()=>({})),
    ]).then(([order,slots,sw,items])=>{
      setRackOrder(order||{});setRackSlots(slots||{});setSwitchAssignments(sw||{});setCustomItems(items||{});
    });
  },[]);

  const pdus  = devices.filter(d=>d.kind==="pdu");
  const racks = useMemo(()=>[...new Set(devices.map(d=>d.rack).filter(Boolean))].sort(),[devices]);

  const servers = useMemo(()=>{
    const map=new Map();
    pdus.forEach(pdu=>{
      const stored=pdu.labels||{},live=pduStatuses[pdu.id]?.outlets||[];
      const liveByN=Object.fromEntries(live.map(o=>[String(o.number),o]));
      Object.entries(stored).forEach(([num,label])=>{
        if(isDefaultOutletLabel(label))return;const key=label.trim().toLowerCase();if(map.has(key))return;
        const lo=liveByN[num];map.set(key,{id:key,name:label.trim(),rack:pdu.rack||"—",pduId:pdu.id,pduName:pdu.name,pduIp:pdu.ip,outlet:parseInt(num,10),state:lo?.state??"unknown",watts:lo?.watts??0});
      });
      live.forEach(o=>{
        if(isDefaultOutletLabel(o.label))return;const key=o.label.trim().toLowerCase();
        if(map.has(key)){const e=map.get(key);e.state=o.state;e.watts=o.watts||0;return;}
        map.set(key,{id:key,name:o.label.trim(),rack:pdu.rack||"—",pduId:pdu.id,pduName:pdu.name,pduIp:pdu.ip,outlet:o.number,state:o.state,watts:o.watts||0});
      });
    });
    return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
  },[pdus,pduStatuses]);

  const rackStats = useMemo(()=>racks.map(rn=>{
    const rPdus=pdus.filter(p=>p.rack===rn);
    let totalWatts=0,outletsOn=0,outletsTotal=0;
    rPdus.forEach(pdu=>{const st=pduStatuses[pdu.id];if(st?.outlets){outletsOn+=st.outlets.filter(o=>o.state==="on").length;outletsTotal+=st.outlets.length;totalWatts+=st.total_watts||0;}});
    const rServers=servers.filter(s=>s.rack===rn);
    const pduOnline=rPdus.length>0?(pduStatuses[rPdus[0].id]?.reachable!==false&&!!pduStatuses[rPdus[0].id]):false;
    return {rack:rn,pdus:rPdus,servers:rServers,totalWatts,outletsOn,outletsTotal,maxWatts:outletsTotal*150,pduOnline};
  }),[racks,pdus,pduStatuses,servers]);

  const handleReorder = useCallback((rackName,newIds)=>{
    const n={...rackOrder,[rackName]:newIds};setRackOrder(n);
    fetch("/api/rack-positions",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(n)}).catch(()=>{});
  },[rackOrder]);

  // Inline rename server (double-click in rack)
  const handleRenameServer = useCallback(async (server, newName) => {
    const pdu = pdus.find(p => p.id === server.pduId);
    if (!pdu || !onLabelChange) return;
    await onLabelChange(server.pduId, { ...pdu.labels, [String(server.outlet)]: newName });
  }, [pdus, onLabelChange]);

  // Inline rename custom item
  const handleRenameCustom = useCallback(async (item, newName) => {
    const rackName = Object.keys(customItems).find(r => customItems[r].some(i => i.id === item.id));
    if (!rackName) return;
    const updated = { ...customItems, [rackName]: customItems[rackName].map(i => i.id===item.id ? {...i, name: newName} : i) };
    setCustomItems(updated);
    await fetch("/api/rack-items",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(updated)}).catch(()=>{});
  }, [customItems]);

  // Save custom item edits
  const handleSaveCustom = useCallback(async (item) => {
    const rackName = Object.keys(customItems).find(r => customItems[r].some(i => i.id === item.id));
    if (!rackName) return;
    const updated = { ...customItems, [rackName]: customItems[rackName].map(i => i.id===item.id ? item : i) };
    setCustomItems(updated);
    // update selectedCustom so panel reflects changes
    setSelectedCustom(item);
    await fetch("/api/rack-items",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(updated)}).catch(()=>{});
  }, [customItems]);

  // Delete custom item
  const handleDeleteCustom = useCallback(async (item) => {
    const rackName = Object.keys(customItems).find(r => customItems[r].some(i => i.id === item.id));
    if (!rackName) return;
    const updated = { ...customItems, [rackName]: customItems[rackName].filter(i => i.id !== item.id) };
    setCustomItems(updated);
    await fetch("/api/rack-items",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(updated)}).catch(()=>{});
  }, [customItems]);

  // Derive live server data from servers list — no stale closure race possible
  const selectedServer = selectedServerId ? servers.find(s => s.id === selectedServerId) ?? null : null;

  const tabs=[
    {id:"racks",    label:"Racks",     icon:Icon.rack},
    {id:"inventory",label:"Inventory", icon:Icon.list},
    {id:"power",    label:"Power",     icon:Icon.bolt},
    {id:"changelog",label:"Changelog", icon:Icon.log},
  ];

  // The rackName for selected custom item
  const selectedCustomRack = selectedCustom
    ? Object.keys(customItems).find(r => customItems[r].some(i => i.id === selectedCustom.id))
    : null;

  return (
    <main className="flex-1 px-6 py-5 max-w-[1600px] w-full mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-sm font-bold tracking-tight text-zinc-100">DCIM</h2>
          <p className="text-[11px] text-zinc-600">{racks.length} rack{racks.length!==1?"s":""} · {servers.length} OPTs · {Object.values(customItems).flat().length} equipment items</p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
          {tabs.map(t=><TabBtn key={t.id} label={t.label} icon={t.icon} active={section===t.id} onClick={()=>setSection(t.id)}/>)}
        </div>
      </div>

      {section!=="changelog"&&(
        <KpiBar servers={servers} rackStats={rackStats} pdus={pdus} pduStatuses={pduStatuses}/>
      )}

      {section==="racks"&&(
        <RacksView rackStats={rackStats} rackSlots={rackSlots} rackOrder={rackOrder}
          switchAssignments={switchAssignments} customItems={customItems}
          onReorder={handleReorder}
          onSelect={s => setSelectedServerId(s.id)} onSelectCustom={setSelectedCustom}
          onLabelChange={onLabelChange} onSlotsChange={setRackSlots}
          onRenameServer={handleRenameServer} onRenameCustom={handleRenameCustom}
          onCustomItemsChange={setCustomItems} onRefresh={onRefresh}/>
      )}
      {section==="inventory"&&<InventoryView servers={servers} switchAssignments={switchAssignments} rackSlots={rackSlots} customItems={customItems}/>}
      {section==="power"&&<PowerView rackStats={rackStats}/>}
      {section==="changelog"&&<ChangelogView/>}

      {selectedServer&&(
        <Portal>
          <ServerEditPanel server={selectedServer} pdus={pdus} rackSlots={rackSlots}
            switchAssignments={switchAssignments} onClose={()=>setSelectedServerId(null)}
            onOutletAction={onOutletAction} onLabelChange={onLabelChange}
            onSlotsChange={setRackSlots} onSwitchChange={setSwitchAssignments}/>
        </Portal>
      )}

      {selectedCustom&&selectedCustomRack&&(
        <Portal>
          <EditEquipmentPanel item={selectedCustom} rackName={selectedCustomRack}
            onClose={()=>setSelectedCustom(null)}
            onSave={handleSaveCustom} onDelete={handleDeleteCustom}/>
        </Portal>
      )}
    </main>
  );
}
