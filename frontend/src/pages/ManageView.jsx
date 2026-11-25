// The Manage page (?tab=inventory, label "Manage"; one-place spec v2 §M, v1 WP-6 for Type = Servers): one place to find,
// add, open, edit and delete everything in the lab — servers, PDUs, KVMs, units, cooling units, racks and records that
// exist only in the 3D twin. Every row opens its item's window (useLabWindow().open); edits happen there.
//
//   Top        "+ Add ▾" (Server… and Unit… for Operators; PDU…, KVM…, Rack… for Admins) and the search box.
//   Filters    All · Needs a look (n) · Maybe gone (n) · Deleted (Operator+) · Type · Rack · More filters. show=, type= and q=
//              live in the URL (replaceState, so a link shares the view); the rack choice in sessionStorage.
//   Views      Type = Servers: v1's server table (State, W, U, Outlet, PDU, PDU IP, Switch, Owner, SSH, KVM, Ping, Server
//              IP for Operators; sort, state filter, Edit-mode owner select). Any other Type: one table of every kind.
//              show=free-ports: the free outlets and ports per device. show=deleted: the Deleted list (§M.6).
//              At 640 px and below the rows are cards.
//   Bulk       a checkbox on each row the account may delete; "N selected · Delete… · Clear" opens the one DeleteDialog.
//   Live       the window provider reloads its stores on the change feed; this page re-reads the Deleted list.
// Props (from App): editMode. App's other props (DcimView's) are not used.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accountRequest } from "../accounts.jsx";
import { listDeleted, purgeDeleted, restoreDeleted } from "../api/labDelete.js";
import { patchDevice } from "../api/devices.js";
import { restoreServer } from "../api/removedServers.js";
import { useLiveReload } from "../api/useLiveReload.js";
import { KIND_TEXT, SERVER_STATES, TYPE_CHOICES, csvText, entryState, filterServerTable, legacyRemoved, mayRestore, openEntries,
  outletCountCandidates, serverTableRow, showParam, sortServerTable, typeChoice, whenText } from "../api/serversList.js";
import ExportCsvButton from "../components/ExportCsvButton.jsx";
import SshButton from "../components/SshButton.jsx";
import AddDeviceDialog from "../devices/AddDeviceDialog.jsx";
import { OwnerSelect } from "../engineers.jsx";
import { PROBLEMS, filterRows, mismatchShown, mismatchText, rackNames } from "../lab/labIndex.js";
import { buildRecord } from "../server/serverRecord.js";
import { ownerWriteKeys } from "../server/ownerKey.js";
import { partialOwnerText, writeEveryKey } from "../server/serverIdentity.js";
import AddUnitDialog from "../units/AddUnitDialog.jsx";
import { itemRef, rackRef, serverRef } from "../twinLinks.js";
import { useLabData } from "../window/labWindowContext.js";
import "../lab/manage.css";

const LIVE = ["devices", "power", "layout", "inventory", "owners", "removed", "monitoring", "twin"];
const RACK_KEY = "dcim.manage.rack";
const BULK_MAX = 50;
const MORE_FILTERS = [["no-location", "No location"], ["single-feed", "Single feed"], ["missing-kvm", "No KVM port"],
  ["missing-pdu", "No PDU outlet"], ["free-ports", "Free ports"], ["not-in-lm", "Not in Lab Manager"]];
const CHIPS = [["unreachable", "Needs a look"], ["maybe-gone", "Maybe gone"]];
const TYPE_ORDER = { server: 0, pdu: 1, kvm: 2, unit: 3, cooling: 4, rack: 5, other: 6 };

const readSession = () => { try { return sessionStorage.getItem(RACK_KEY) || ""; } catch { return ""; } };
const writeSession = value => { try { if (value) sessionStorage.setItem(RACK_KEY, value); else sessionStorage.removeItem(RACK_KEY); } catch { /* private mode */ } };

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  return { show: showParam(p.get("show"), PROBLEMS), type: typeChoice(p.get("type")).value, q: p.get("q") || "" };
}
function writeUrl(next) {
  const p = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(next)) { if (value) p.set(key, value); else p.delete(key); }
  const search = p.toString();
  const href = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, "", href);
}

// 640 px and below: cards instead of tables.
function useNarrow() {
  const query = "(max-width: 640px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return undefined;
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

// A small menu (the "+ Add" menu and each row's ⋯): Escape and a click elsewhere close it.
function useMenu() {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (open == null) return undefined;
    const away = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(null); };
    const key = e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(null); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key, true); };
  }, [open]);
  return { open, setOpen, ref };
}

const twinRefOf = row => {
  if (row.kind === "server") return serverRef(row.name);
  if (row.kind === "rack") return rackRef(row.id);
  if (row.kind === "twin") return row.twinType === "setup" ? null : itemRef(row.id);
  return row.twinIds?.length ? itemRef(row.twinIds[0]) : null;
};

function download(name, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ManageView({ editMode = false }) {
  const lab = useLabData("all");
  const { act, can, index, data, errors, ready } = lab;
  const narrow = useNarrow();
  const [url, setUrl] = useState(readUrl);
  const [rack, setRackState] = useState(readSession);
  const [adding, setAdding] = useState(null);           // "unit" | "pdu" | "kvm" | "rack" (Server… is the provider's dialog)
  const [selected, setSelected] = useState(() => new Set());
  const [note, setNote] = useState(null);               // { tone, text }
  const addMenu = useMenu();
  const searchRef = useRef(null);

  useEffect(() => {
    const onPop = () => setUrl(readUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const change = useCallback(next => {
    setUrl(prev => {
      const merged = { ...prev, ...next };
      writeUrl({ show: merged.show || "", type: merged.type || "", q: merged.q || "" });
      return merged;
    });
  }, []);
  const setRack = value => { setRackState(value); writeSession(value); };

  const role = can.admin ? "admin" : can.operate ? "operator" : "viewer";
  const show = url.show === "deleted" && !can.operate ? null : url.show;
  const type = typeChoice(url.type);
  const rows = index?.rows || [];
  const counts = index?.counts || { total: 0, problems: {} };
  const racks = useMemo(() => rackNames(data), [data]);
  const rackFilter = rack && racks.includes(rack) ? rack : "";
  const visible = useMemo(() => {
    const list = filterRows(rows, { types: type.types, problem: show === "deleted" ? null : show, q: url.q, rack: rackFilter || null });
    return [...list].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
      || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  }, [rows, type.value, show, url.q, rackFilter]);

  // The selection follows the rows: one that is gone (deleted, or no longer selectable) leaves it.
  const selectable = useCallback(row => role !== "viewer" && !!row.deleteTarget && !row.bulkBlockedWhy && !row.problems.has("deleted"), [role]);
  useEffect(() => {
    setSelected(prev => {
      if (!prev.size) return prev;
      const ok = new Set(rows.filter(selectable).map(r => r.uid));
      const next = new Set([...prev].filter(uid => ok.has(uid)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows, selectable]);
  const toggle = uid => setSelected(prev => { const next = new Set(prev); if (next.has(uid)) next.delete(uid); else next.add(uid); return next; });
  const chosen = rows.filter(r => selected.has(r.uid));
  const selectAll = list => setSelected(new Set(list.filter(selectable).slice(0, BULK_MAX).map(r => r.uid)));
  const deleteChosen = () => act.openDelete(chosen.map(r => r.deleteTarget), { onDone: () => setSelected(new Set()) });

  const openRow = row => act.open(row.open);
  const rowMenu = row => {
    const items = [{ id: "open", label: "Open", onSelect: () => openRow(row) }];
    const ref = twinRefOf(row);
    if (ref) items.push({ id: "3d", label: "Show in 3D", onSelect: () => act.showIn3d(ref) });
    if (row.rack && row.kind !== "twin") items.push({ id: "racks", label: "Show on Racks", onSelect: () => act.showOnRacks(row.rack) });
    const allowed = row.deleteTarget && !row.problems.has("deleted") && (row.deleteRole === "admin" ? can.admin : can.operate);
    if (allowed) items.push({ id: "delete", label: "Delete…", tone: "danger", onSelect: () => act.openDelete([row.deleteTarget]) });
    return items;
  };

  // ── + Add ──
  const addItems = [
    ...(can.operate ? [{ id: "server", label: "Server…" }, { id: "unit", label: "Unit…" }] : []),
    ...(can.admin ? [{ id: "pdu", label: "PDU…" }, { id: "kvm", label: "KVM…" }, { id: "rack", label: "Rack…" }] : []),
  ];
  async function deviceAdded(device) {
    setAdding(null);
    try { await act.app.refresh(); } catch { /* the list reloads on the change feed too */ }
    if (device?.kind === "rack" && device.rack) act.open({ kind: "rack", id: device.rack });
    else if (device?.id) act.open({ kind: "dev", id: device.id });
  }

  // ── Set outlet counts from the PDUs (Admin) ──
  const outletFixes = can.admin ? outletCountCandidates(data.devices, data.pduStatuses) : [];
  const [fixing, setFixing] = useState(false);
  async function setOutletCounts() {
    setFixing(true); setNote(null);
    const lines = [];
    for (const pdu of outletFixes) {
      try {
        // PATCH /api/devices/{id} applies only a previewed change (its plan_revision); a blocker is reported, nothing saved.
        const body = { port_count: pdu.count };
        const plan = await patchDevice(pdu.id, body, { dryRun: true });
        if (plan?.blockers?.length) throw new Error(plan.blockers.map(b => (typeof b === "string" ? b : b?.text)).join(" "));
        await act.during(() => patchDevice(pdu.id, body, { planRevision: plan?.plan_revision }));
        lines.push(`${pdu.name}: ${pdu.count} outlets`);
      } catch (e) { lines.push(`${pdu.name}: not saved (${e.message})`); }
    }
    try { await act.app.refresh(); } catch { /* the change feed reloads it too */ }
    setFixing(false);
    setNote({ tone: lines.some(l => l.includes("not saved")) ? "error" : "ok", text: lines.join(" · ") });
  }

  // ── CSV of the rows shown (Operator) ──
  function exportRows() {
    const columns = [["Name", r => r.name], ["Type", r => r.typeText || r.type], ["Rack / place", r => r.place], ["Connected to", r => r.connection],
      ["State", r => r.state], ["Owner", r => r.owner], ["Address", r => r.address], ["Badges", r => r.badges.join("; ")], ["Id", r => r.id]];
    download(`lab-manage-${new Date().toISOString().slice(0, 10)}.csv`, csvText(columns, visible));
  }

  const filtered = !!(show || type.value || url.q || rackFilter);
  const clearFilters = () => { change({ show: null, type: "", q: "" }); setRack(""); };
  const loading = !ready || !index;
  const storeErrors = Object.entries(errors || {});
  const view = show === "deleted" ? "deleted" : show === "free-ports" ? "free" : type.value === "server" ? "servers" : "all";

  return <main className="manage" data-page="manage" aria-busy={loading ? "true" : "false"}>
    <div className="manage-top">
      <h2 className="manage-title">Manage</h2>
      {addItems.length > 0 && <div className="manage-add" ref={addMenu.ref}>
        <button type="button" className="manage-btn manage-btn-accent" data-action="add" aria-haspopup="menu" aria-expanded={addMenu.open === "add"}
          onClick={() => addMenu.setOpen(addMenu.open === "add" ? null : "add")}>+ Add ▾</button>
        {addMenu.open === "add" && <ul role="menu" aria-label="Add" className="manage-menu">
          {addItems.map(item => <li key={item.id} role="none">
            <button type="button" role="menuitem" data-add={item.id}
              onClick={() => { addMenu.setOpen(null); if (item.id === "server") act.openAddServer({}); else setAdding(item.id); }}>{item.label}</button>
          </li>)}
        </ul>}
      </div>}
      <label className="manage-search">
        <span className="sr-only">Search everything</span>
        <input ref={searchRef} type="search" value={url.q} onChange={e => change({ q: e.target.value })} aria-label="Search everything"
          placeholder="Find a server, PDU, KVM, unit, rack, owner, IP, SN…" autoComplete="off"/>
      </label>
      {can.operate && view !== "deleted" && (view === "servers"
        ? <ExportCsvButton/>
        : <button type="button" className="manage-btn" onClick={exportRows} disabled={!visible.length}>Export CSV</button>)}
      {outletFixes.length > 0 && <button type="button" className="manage-btn" data-action="outlet-counts" disabled={fixing} onClick={setOutletCounts}
        title={outletFixes.map(p => `${p.name}: ${p.count}`).join(", ")}>{fixing ? "Saving…" : `Set outlet counts from the PDUs (${outletFixes.length})`}</button>}
    </div>

    <div className="manage-filters" role="group" aria-label="Filters">
      <div className="manage-chips">
        <button type="button" className="manage-chip" aria-pressed={!show} data-chip="all" onClick={() => change({ show: null })}>
          All <span className="manage-count">{counts.total}</span></button>
        {CHIPS.map(([id, label]) => <button key={id} type="button" className="manage-chip" aria-pressed={show === id} data-chip={id}
          onClick={() => change({ show: show === id ? null : id })}>{label} <span className="manage-count">{counts.problems?.[id] ?? 0}</span></button>)}
        {can.operate && <button type="button" className="manage-chip" aria-pressed={show === "deleted"} data-chip="deleted"
          onClick={() => change({ show: show === "deleted" ? null : "deleted" })}>Deleted</button>}
      </div>
      <div className="manage-selects">
        <label><span>Type</span>
          <select value={type.value} aria-label="Type" onChange={e => change({ type: e.target.value })}>
            {TYPE_CHOICES.map(([label, value]) => <option key={value || "all"} value={value}>{label}</option>)}
            {type.label === "Custom" && <option value={type.value}>Custom</option>}
          </select></label>
        <label><span>Rack</span>
          <select value={rackFilter} aria-label="Rack" onChange={e => setRack(e.target.value)}>
            <option value="">All racks</option>
            {racks.map(r => <option key={r} value={r}>{r}</option>)}
          </select></label>
        <label><span>More filters</span>
          <select value={MORE_FILTERS.some(([id]) => id === show) ? show : ""} aria-label="More filters" onChange={e => change({ show: e.target.value || null })}>
            <option value="">More filters ▾</option>
            {MORE_FILTERS.map(([id, label]) => <option key={id} value={id}>{label} ({counts.problems?.[id] ?? 0})</option>)}
          </select></label>
        {filtered && <button type="button" className="manage-link" onClick={clearFilters}>Clear filters</button>}
      </div>
    </div>

    {index && mismatchShown(index.mismatch) && <p className="manage-banner" role="note" data-banner="mismatch">{mismatchText(index.mismatch)}</p>}
    {storeErrors.length > 0 && <p className="manage-banner" data-tone="error" role="alert">
      Some lab data did not load ({storeErrors.map(([k, v]) => `${k}: ${v}`).join("; ")}). The list shows what did load.</p>}
    {note && <p className="manage-note" data-tone={note.tone} role="status">{note.text}
      <button type="button" className="manage-link" onClick={() => setNote(null)} aria-label="Dismiss">×</button></p>}

    {loading && <p className="manage-muted" role="status">Loading the lab…</p>}
    {!loading && view === "deleted" && <DeletedView can={can} act={act} removed={data.removed} removedEtag={data.etags?.removed || null}/>}
    {!loading && view === "free" && <FreePorts rows={visible} open={act.open} narrow={narrow}/>}
    {!loading && view === "servers" && <ServersTable rows={visible} data={data} can={can} editMode={editMode} narrow={narrow}
      openRow={openRow} rowMenu={rowMenu} selectable={selectable} selected={selected} toggle={toggle} total={counts.types?.server ?? 0}
      filtered={!!show} selectAll={selectAll}/>}
    {!loading && view === "all" && <AllTable rows={visible} role={role} narrow={narrow} openRow={openRow} rowMenu={rowMenu}
      selectable={selectable} selected={selected} toggle={toggle} filtered={!!show} selectAll={selectAll} total={counts.total}/>}

    {chosen.length > 0 && <div className="manage-bulk" role="region" aria-label="Selection" data-bulk="">
      <span><strong>{chosen.length}</strong> selected</span>
      <button type="button" className="manage-btn manage-btn-danger" data-action="bulk-delete" onClick={deleteChosen}>Delete…</button>
      <button type="button" className="manage-btn" onClick={() => setSelected(new Set())}>Clear</button>
    </div>}

    {adding === "unit" && <AddUnitDialog onClose={() => setAdding(null)}
      onAdded={unit => { setAdding(null); if (unit?.id != null) act.open({ kind: "unit", id: String(unit.id) }); }}/>}
    {["pdu", "kvm", "rack"].includes(adding) && <AddDeviceDialog kind={adding} racks={racks} onClose={() => setAdding(null)} onAdded={deviceAdded}/>}
  </main>;
}

// ── shared row parts ──

function SelectBox({ row, selectable, selected, toggle, role }) {
  if (role === "viewer") return null;
  const ok = selectable(row);
  return <input type="checkbox" className="manage-check" checked={ok && selected.has(row.uid)} disabled={!ok}
    title={ok ? `Select ${row.name}` : row.bulkBlockedWhy || "Cannot be deleted"} aria-label={`Select ${row.name}`}
    onClick={e => e.stopPropagation()} onChange={() => ok && toggle(row.uid)} data-select={row.uid}/>;
}

// A table scrolls inside .manage-table-wrap, which would clip an absolute menu: the row menu is fixed to the viewport
// at its button, opens upwards when there is no room below, and follows the button when the page scrolls or resizes.
const MENU_ROOM = 200;
function menuPlace(button) {
  const r = button?.getBoundingClientRect();
  if (!r) return null;
  const right = Math.max(8, window.innerWidth - r.right);
  return r.bottom + MENU_ROOM > window.innerHeight && r.top > MENU_ROOM
    ? { position: "fixed", right, left: "auto", top: "auto", bottom: window.innerHeight - r.top + 4 }
    : { position: "fixed", right, left: "auto", top: r.bottom + 4, bottom: "auto" };
}

function RowMenu({ row, rowMenu }) {
  const menu = useMenu();
  const buttonRef = useRef(null);
  const [place, setPlace] = useState(null);
  const { open, setOpen } = menu;
  useEffect(() => {
    if (open == null) return undefined;
    const follow = () => setPlace(menuPlace(buttonRef.current));
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => { window.removeEventListener("resize", follow); window.removeEventListener("scroll", follow, true); };
  }, [open]);
  const items = menu.open ? rowMenu(row) : [];
  return <div className="manage-rowmenu" ref={menu.ref} onClick={e => e.stopPropagation()}>
    <button ref={buttonRef} type="button" className="manage-btn manage-dots" aria-haspopup="menu" aria-expanded={!!menu.open} aria-label={`Actions for ${row.name}`}
      onClick={() => { if (menu.open) { setOpen(null); return; } setPlace(menuPlace(buttonRef.current)); setOpen(row.uid); }}>⋯</button>
    {menu.open && <ul role="menu" aria-label={`Actions for ${row.name}`} className="manage-menu manage-menu-right" style={place || undefined}>
      {items.map(item => <li key={item.id} role="none">
        <button type="button" role="menuitem" data-tone={item.tone || undefined} onClick={() => { menu.setOpen(null); item.onSelect(); }}>{item.label}</button>
      </li>)}
    </ul>}
  </div>;
}

const Badges = ({ badges }) => (badges?.length ? <span className="manage-badges">{badges.map(b => <span key={b} className="manage-badge"
  data-tone={b === "Deleted" ? "bad" : /^Not seen|Maintenance|Disabled/.test(b) ? "warn" : b === "3D only" || b === "Monitor only" ? "dim" : undefined}>{b}</span>)}</span> : null);

function BulkHint({ filtered, rows, selectable, selectAll, role }) {
  if (role === "viewer" || !filtered) return null;
  const n = Math.min(rows.filter(selectable).length, BULK_MAX);
  if (!n) return null;
  return <button type="button" className="manage-link" data-action="select-all" onClick={() => selectAll(rows)}
    title={`Selects at most ${BULK_MAX}`}>Select all {n} shown</button>;
}

function Empty({ text }) {
  return <p className="manage-muted manage-empty">{text}</p>;
}

// ── every kind in one table ──

function AllTable({ rows, role, narrow, openRow, rowMenu, selectable, selected, toggle, filtered, selectAll, total }) {
  const head = <div className="manage-meta"><span>{rows.length} / {total}</span>
    <BulkHint filtered={filtered} rows={rows} selectable={selectable} selectAll={selectAll} role={role}/></div>;
  if (!rows.length) return <>{head}<Empty text="Nothing matches. Clear the filters or search for something else."/></>;
  if (narrow) return <>{head}<ul className="manage-cards" data-list="manage">
    {rows.map(row => <li key={row.uid} className="manage-card" data-uid={row.uid} onClick={() => openRow(row)}>
      <div className="manage-card-head">
        <SelectBox row={row} selectable={selectable} selected={selected} toggle={toggle} role={role}/>
        <button type="button" className="manage-name" dir="auto" onClick={e => { e.stopPropagation(); openRow(row); }}>{row.name}</button>
        <RowMenu row={row} rowMenu={rowMenu}/>
      </div>
      <div className="manage-card-line"><span>{row.typeText || row.type}</span><span dir="auto">{row.place}</span>
        <span className="manage-state" data-tone={row.stateTone}>{row.state}</span></div>
    </li>)}
  </ul></>;
  return <>{head}<div className="manage-table-wrap"><table className="manage-table" data-list="manage">
    <thead><tr>
      {role !== "viewer" && <th scope="col" className="manage-col-check"><span className="sr-only">Select</span></th>}
      <th scope="col">Name</th><th scope="col">Type</th><th scope="col">Rack / place</th><th scope="col">Connected to</th>
      <th scope="col">State</th><th scope="col">Owner</th><th scope="col">Address</th><th scope="col">Badges</th>
      <th scope="col"><span className="sr-only">Actions</span></th>
    </tr></thead>
    <tbody>{rows.map(row => <tr key={row.uid} data-uid={row.uid} onClick={() => openRow(row)}>
      {role !== "viewer" && <td className="manage-col-check"><SelectBox row={row} selectable={selectable} selected={selected} toggle={toggle} role={role}/></td>}
      <td><button type="button" className="manage-name" dir="auto" onClick={e => { e.stopPropagation(); openRow(row); }}>{row.name}</button></td>
      <td className="manage-dim">{row.typeText || row.type}</td>
      <td dir="auto">{row.place}</td>
      <td className="manage-dim" dir="auto">{row.connection || "—"}</td>
      <td><span className="manage-state" data-tone={row.stateTone}>{row.state}</span></td>
      <td dir="auto">{row.owner || <span className="manage-dim">—</span>}</td>
      <td className="manage-mono">{row.address || <span className="manage-dim">—</span>}</td>
      <td><Badges badges={row.badges}/></td>
      <td className="manage-col-menu"><RowMenu row={row} rowMenu={rowMenu}/></td>
    </tr>)}</tbody>
  </table></div></>;
}

// ── Type = Servers: v1's server table ──

const SERVER_COLUMNS = [["name", "Server"], ["rack", "Rack"], ["state", "State"], ["watts", "W", true], ["u", "U", true], ["outlet", "Outlet", true],
  ["pduName", "PDU"], ["pduIp", "PDU IP"], ["switch", "Switch"], ["owner", "Owner"]];

function ServersTable({ rows, data, can, editMode, narrow, openRow, rowMenu, selectable, selected, toggle, total, filtered, selectAll }) {
  const role = can.admin ? "admin" : can.operate ? "operator" : "viewer";
  const [state, setState] = useState("all");
  const [sort, setSort] = useState({ key: "rack", dir: 1 });
  const [ownerError, setOwnerError] = useState("");
  const table = useMemo(() => {
    const byKey = new Map(rows.map(r => [r.id, r]));
    const list = rows.map(r => ({ ...serverTableRow(buildRecord(r.id, data), { operate: can.operate }), row: r }));
    return { byKey, list: sortServerTable(filterServerTable(list, { state }), sort.key, sort.dir) };
  }, [rows, data, can.operate, state, sort]);
  async function setOwner(key, engineerId) {
    setOwnerError("");
    const record = buildRecord(key, data);
    const keys = ownerWriteKeys(record);
    const result = await writeEveryKey(keys, k => accountRequest(`/opt-owners/${encodeURIComponent(k)}`, "PUT", { engineer_id: engineerId }));
    if (result.failed) { const text = partialOwnerText(result, keys); setOwnerError(`${record.name}: ${text}`); throw new Error(text); }
  }
  const Th = ({ k, label, right }) => <th scope="col" className={right ? "manage-right" : undefined}
    aria-sort={sort.key === k ? (sort.dir > 0 ? "ascending" : "descending") : undefined}>
    <button type="button" className="manage-sort" onClick={() => setSort(s => (s.key === k ? { key: k, dir: -s.dir } : { key: k, dir: 1 }))}>
      {label}{sort.key === k && <span aria-hidden="true">{sort.dir > 0 ? " ↑" : " ↓"}</span>}</button></th>;
  const head = <div className="manage-meta">
    <label className="manage-inline"><span>State</span>
      <select value={state} aria-label="Power state" onChange={e => setState(e.target.value)}>
        <option value="all">All states</option>{SERVER_STATES.map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
      </select></label>
    <span>{table.list.length} / {total}</span>
    <BulkHint filtered={filtered} rows={table.list.map(s => s.row)} selectable={selectable} selectAll={selectAll} role={role}/>
  </div>;
  if (!table.list.length) return <>{head}<Empty text="No matching servers."/></>;
  if (narrow) return <>{head}<ul className="manage-cards" data-list="servers">
    {table.list.map(s => <li key={s.key} className="manage-card" data-uid={s.row.uid} onClick={() => openRow(s.row)}>
      <div className="manage-card-head">
        <SelectBox row={s.row} selectable={selectable} selected={selected} toggle={toggle} role={role}/>
        <button type="button" className="manage-name" dir="auto" onClick={e => { e.stopPropagation(); openRow(s.row); }}>{s.name}</button>
        <RowMenu row={s.row} rowMenu={rowMenu}/>
      </div>
      <div className="manage-card-line"><span dir="auto">{s.row.place}</span><span className="manage-state" data-tone={s.state === "on" ? "ok" : s.state === "off" ? "off" : "unknown"}>{s.state}</span>
        {s.owner && <span dir="auto">{s.owner}</span>}</div>
    </li>)}
  </ul></>;
  return <>{head}
    {ownerError && <p className="manage-note" data-tone="error" role="alert">{ownerError}</p>}
    <div className="manage-table-wrap"><table className="manage-table manage-servers" data-list="servers">
      <thead><tr>
        {role !== "viewer" && <th scope="col" className="manage-col-check"><span className="sr-only">Select</span></th>}
        {SERVER_COLUMNS.map(([k, label, right]) => <Th key={k} k={k} label={label} right={right}/>)}
        {can.operate && <th scope="col">SSH</th>}
        <Th k="kvm" label="KVM"/><Th k="ping" label="Ping"/>
        {can.operate && <Th k="serverIp" label="Server IP"/>}
        <th scope="col"><span className="sr-only">Actions</span></th>
      </tr></thead>
      <tbody>{table.list.map(s => <tr key={s.key} data-uid={s.row.uid} data-server={s.key} onClick={() => openRow(s.row)}>
        {role !== "viewer" && <td className="manage-col-check"><SelectBox row={s.row} selectable={selectable} selected={selected} toggle={toggle} role={role}/></td>}
        <td><button type="button" className="manage-name" dir="auto" onClick={e => { e.stopPropagation(); openRow(s.row); }}>{s.name}</button>
          <Badges badges={s.row.badges.filter(b => b !== "In 3D")}/></td>
        <td className="manage-mono manage-dim">{s.rack || "—"}</td>
        <td><span className="manage-state" data-tone={s.state === "on" ? "ok" : s.state === "off" ? "off" : "unknown"}>{s.state}</span></td>
        <td className="manage-mono manage-right">{s.watts != null ? s.watts.toFixed(0) : "—"}</td>
        <td className="manage-mono manage-right">{s.u != null ? `U${s.u}` : "—"}</td>
        <td className="manage-mono manage-right">{s.outlets ? `#${s.outlets.split(", ").join(", #")}` : "—"}</td>
        <td dir="auto">{s.pduName || "—"}</td>
        <td className="manage-mono">{s.pduIp || "—"}</td>
        <td>{s.switch || <span className="manage-dim">—</span>}</td>
        <td className="manage-owner" onClick={e => { if (editMode) e.stopPropagation(); }}>
          {editMode && can.operate
            ? <OwnerSelect owner={s.owner} label={`Owner for ${s.name}`} disabled={data.owners == null} onChange={id => setOwner(s.key, id)}/>
            : <span className={s.owner ? undefined : "manage-dim"} dir="auto">{s.owner || "Owner not set"}</span>}</td>
        {can.operate && <td onClick={e => e.stopPropagation()}><SshButton name={s.name}/></td>}
        <td dir="auto">{s.kvm || <span className="manage-dim">—</span>}</td>
        <td><span className="manage-state" data-tone={s.ping === "up" ? "ok" : s.ping === "down" ? "bad" : "unknown"}>{s.ping || "—"}</span></td>
        {can.operate && <td className="manage-mono">{s.serverIp || "—"}</td>}
        <td className="manage-col-menu"><RowMenu row={s.row} rowMenu={rowMenu}/></td>
      </tr>)}</tbody>
    </table></div></>;
}

// ── show=free-ports: the free outlets and KVM ports of each device ──

function FreePorts({ rows, open }) {
  const devices = rows.filter(r => r.kind === "dev" && (r.free?.pdu?.length || r.free?.kvm?.length));
  if (!devices.length) return <Empty text="No free outlet or KVM port."/>;
  return <ul className="manage-free" data-list="free-ports">
    {devices.map(r => {
      const ports = r.free.pdu || r.free.kvm || [];
      return <li key={r.uid} data-uid={r.uid}>
        <button type="button" className="manage-name" onClick={() => open(r.open)}>{r.name}</button>
        <span className="manage-dim">{r.place}</span>
        <span>{ports.length} free {r.type === "pdu" ? (ports.length === 1 ? "outlet" : "outlets") : ports.length === 1 ? "port" : "ports"}: {ports.join(", ")}</span>
      </li>;
    })}
  </ul>;
}

// ── show=deleted: the Deleted list (§M.6) ──

function DeletedView({ can, act, removed, removedEtag }) {
  const [state, setState] = useState({ batches: null, etag: null, error: "" });
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);
  const [forget, setForget] = useState("");     // the batch whose "Delete forever" asks for a second click
  const turn = useRef(0);
  const load = useCallback(async () => {
    const mine = ++turn.current;
    try {
      const { data, etag } = await listDeleted();
      if (mine === turn.current) setState({ batches: Array.isArray(data?.batches) ? data.batches : [], etag, error: "" });
    } catch (e) {
      if (mine === turn.current) setState(s => ({ ...s, error: e.message || "The Deleted list did not load." }));
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useLiveReload(LIVE, () => load());

  async function restore(batch, entries) {
    const id = `${batch.id}:${entries ? entries.map(e => `${e.kind}:${e.id}`).join(",") : "all"}`;
    setBusy(id); setNote(null);
    try {
      const plan = await restoreDeleted(batch.id, entries, { dryRun: true });
      if (plan?.blockers?.length) { setNote({ tone: "error", text: `Not restored: ${plan.blockers.map(b => b.text).join(" ")}` }); return; }
      await act.during(() => restoreDeleted(batch.id, entries, { planRevision: plan.plan_revision, etag: state.etag }));
      const list = entries || openEntries(batch);
      const text = list.length === 1 ? `Restored ${list[0].name || list[0].id}.` : `Restored ${list.length} items.`;
      setNote({ tone: "ok", text });
      act.toast(text);
    } catch (e) {
      setNote({ tone: "error", text: `Not restored: ${e.message}` });
    } finally {
      setBusy("");
      await load();
      act.reload().catch(() => {});
    }
  }
  async function purge(batch) {
    setBusy(`${batch.id}:forever`); setNote(null); setForget("");
    try { await act.during(() => purgeDeleted(batch.id)); setNote({ tone: "ok", text: "Deleted forever." }); }
    catch (e) { setNote({ tone: "error", text: `Not deleted: ${e.message}` }); }
    finally { setBusy(""); await load(); }
  }
  async function restoreLegacy(server) {
    setBusy(`legacy:${server.key}`); setNote(null);
    try {
      await act.during(() => restoreServer(server.key, removedEtag));
      setNote({ tone: "ok", text: `${server.name} is back in the lab. Its rack position, switch port and owner were not restored.` });
    } catch (e) {
      setNote({ tone: "error", text: `${server.name} was not restored: ${e.message}` });
    } finally {
      setBusy("");
      window.dispatchEvent(new Event("dcim-removed-servers"));
    }
  }

  const batches = state.batches || [];
  const legacy = legacyRemoved(removed, batches);
  const log = Array.isArray(removed?.log) ? removed.log : [];
  return <section className="manage-deleted" data-view="deleted" aria-label="Deleted">
    {note && <p className="manage-note" data-tone={note.tone} role="status">{note.text}</p>}
    {state.error && <p className="manage-note" data-tone="error" role="alert">{state.error}</p>}
    <h3 className="manage-h3">Deleted</h3>
    {state.batches == null && !state.error && <p className="manage-muted" role="status">Loading…</p>}
    {state.batches && !batches.length && <p className="manage-muted">Nothing was deleted in the last 90 days.</p>}
    {batches.length > 0 && <div className="manage-table-wrap"><table className="manage-table" data-list="deleted">
      <thead><tr><th scope="col">When</th>{can.admin && <th scope="col">Who and reason</th>}<th scope="col">Entries</th><th scope="col">Actions</th></tr></thead>
      <tbody>{batches.map(batch => {
        const left = openEntries(batch);
        const mayAll = left.length > 0 && left.every(e => mayRestore(e.kind, can));
        return <tr key={batch.id} data-batch={batch.id}>
          <td className="manage-nowrap">{whenText(batch.at)}</td>
          {can.admin && <td dir="auto">{batch.by || "—"}{batch.reason ? <> · <bdi>{batch.reason}</bdi></> : null}</td>}
          <td><ul className="manage-entries">{(batch.entries || []).map(e => <li key={`${e.kind}:${e.id}`} data-entry={`${e.kind}:${e.id}`}>
            <span className="manage-dim">{KIND_TEXT[e.kind] || e.kind}</span> <bdi className="manage-entry-name">{e.name || e.id}</bdi>
            <span className="manage-entry-state" data-tone={e.restored_at ? "ok" : e.restorable === false ? "bad" : undefined}> · {entryState(e)}</span>
            {batch.entries.length > 1 && !e.restored_at && e.restorable !== false && mayRestore(e.kind, can) &&
              <button type="button" className="manage-link" disabled={!!busy} onClick={() => restore(batch, [{ kind: e.kind, id: e.id, name: e.name }])}
                aria-label={`Restore ${e.name || e.id}`}>Restore</button>}
          </li>)}</ul></td>
          <td className="manage-actions">
            {left.length > 0 && <button type="button" className="manage-btn" data-action="restore-batch" disabled={!!busy || !mayAll}
              title={mayAll ? undefined : "Only an Admin can restore servers, PDUs, KVMs, racks and cooling units."}
              onClick={() => restore(batch, null)}>{busy === `${batch.id}:all` ? "Restoring…" : left.length === 1 ? "Restore" : "Restore batch"}</button>}
            {can.admin && (forget === batch.id
              ? <span className="manage-confirm">Delete forever? <button type="button" className="manage-btn manage-btn-danger" onClick={() => purge(batch)}>Yes</button>
                <button type="button" className="manage-btn" onClick={() => setForget("")}>No</button></span>
              : <button type="button" className="manage-btn manage-btn-danger" disabled={!!busy} onClick={() => setForget(batch.id)}>Delete forever</button>)}
          </td>
        </tr>;
      })}</tbody>
    </table></div>}

    {(legacy.length > 0 || (can.admin && log.length > 0)) && <>
      <h3 className="manage-h3">Servers removed before this release</h3>
      {legacy.length > 0 && <div className="manage-table-wrap"><table className="manage-table" data-list="removed-servers">
        <thead><tr>{["Server", "Status", "Removed", "By", "Reason", "PDU / KVM labels", ""].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{legacy.map(s => <tr key={s.key} data-removed-server={s.key}>
          <td><button type="button" className="manage-name" dir="auto" onClick={() => act.openServer(s.key)}>{s.name}</button></td>
          <td>{s.active === false ? "Shown again (its name is on a new port)" : "Hidden"}</td>
          <td className="manage-nowrap">{whenText(s.removed_at) || "—"}</td>
          <td className="manage-mono">{s.removed_by || "—"}</td>
          <td dir="auto">{s.reason || "—"}</td>
          <td dir="auto">{s.ports?.length ? s.ports.map(p => `${p.device_name || p.device_id} ${p.kind === "kvm" ? "port" : "outlet"} ${p.port}`).join(", ") : "None"}</td>
          <td>{can.admin && <button type="button" className="manage-btn" disabled={!!busy} onClick={() => restoreLegacy(s)}
            aria-label={`Restore ${s.name}`}>{busy === `legacy:${s.key}` ? "Restoring…" : "Restore"}</button>}</td>
        </tr>)}</tbody>
      </table></div>}
      {can.admin && log.length > 0 && <ul className="manage-log" data-list="removed-servers-log">
        {log.slice(0, 20).map((e, i) => <li key={`${e.at}-${i}`} dir="auto">{whenText(e.at)} · <bdi>{e.by}</bdi> {e.action === "restored" ? "restored" : "removed"} <bdi>{e.name}</bdi>
          {e.reason ? <> · <bdi>{e.reason}</bdi></> : null}</li>)}
      </ul>}
    </>}
  </section>;
}

