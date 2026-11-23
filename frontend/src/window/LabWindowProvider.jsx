import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccounts } from "../accounts.jsx";
import { useRemovedServers } from "../removedServers.jsx";
import { useEngineers } from "../engineers.jsx";
import { api, errorMessage } from "../api/client.js";
import { loadLayout } from "../api/layout.js";
import { loadTwinData } from "../api/twinData.js";
import { useLiveReload } from "../api/useLiveReload.js";
import { setStorageRacks, storageRacksFromDevices } from "../components/racks/floors.js";
import { buildLabIndex } from "../lab/labIndex.js";
import { serverList } from "../server/serverRecord.js";
import { useServerPower } from "../server/useServerPower.js";
import ServerWindow from "../server/ServerWindow.jsx";
import DeviceWindow from "../devices/DeviceWindow.jsx";
import RackWindow from "../devices/RackWindow.jsx";
import UnitWindow from "../units/UnitWindow.jsx";
import CoolingWindow from "../units/CoolingWindow.jsx";
import TwinItemWindow from "../lab/TwinItemWindow.jsx";
import DeleteDialog from "../lab/DeleteDialog.jsx";
import { LabWindowContext, useLabData, useLabWindow, useServerWindow } from "./labWindowContext.js";
import { legacyViewTarget, parseWindow, sameWindow, windowHref, windowId, windowTarget } from "./windowUrl.js";
import "./window.css";

export { useLabData, useLabWindow, useServerWindow };

// The stores the windows read, the change-feed domains that reload each, and how each is read (all Viewer reads).
// Layout-file stores keep { data, etag } (the ETag is a later save's If-Match).
const STORES = {
  locations: { domains: ["layout", "devices", "removed", "monitoring"], load: () => api.getLocations() },
  rackItems: { domains: ["inventory"], load: () => loadLayout("/api/rack-items") },
  owners: { domains: ["owners"], load: async () => (await loadLayout("/api/opt-owners")).data },
  switches: { domains: ["layout"], load: () => loadLayout("/api/switch-assignments") },
  monitoring: { domains: ["monitoring"], load: async () => (await loadLayout("/api/monitoring")).data },
  chillers: { domains: ["inventory"], load: () => loadLayout("/api/chillers") },
  twin: { domains: ["twin"], load: () => loadTwinData() },
};
const ALL = Object.keys(STORES);
const SERVERS_ONLY = ["locations"];
const LIVE_DOMAINS = ["layout", "inventory", "owners", "devices", "removed", "monitoring", "twin"];
const TOAST_MS = 15000;

// The window an address and its history entry name: an old PDU / KVM detail entry ({ view: { kind: "pdu", id } }),
// else ?srv= / ?open=.
const locationTarget = () => legacyViewTarget(window.history.state) || parseWindow(window.location.search);
const withoutConsole = state => { const { kvmConsole, labWindow, ...rest } = state && typeof state === "object" ? state : {}; return rest; };

// The one place every lab window lives (v2 §I). Mounted once by App around the page; it renders the open window, the
// dialogs it opens (power, delete), and the toasts. Props from App:
//   devices, pduStatuses, kvmStatuses, maintenance   App's own data (one copy for the whole page)
//   app      { goTo(tab, target), outletAction(device, n, action, confirmed), turnOnAll(device, numbers),
//              openMaintenance(mode, pduId), saveLabels(id, labels, revision), markKvmFree(id),
//              openConsole(deviceId, port), deleteDevice(id), switchFeeds(targets, action, opts), refresh() }
//   apiRef   App's handle: apiRef.current = { open, openServer, close, current }
//   onWindowChange(target | null)   App's assistant context
export function LabWindowProvider({ children, devices = [], pduStatuses = {}, kvmStatuses = {}, maintenance = null, app = {}, apiRef = null, onWindowChange = null }) {
  const { canOperate, canAdmin } = useAccounts();
  const removed = useRemovedServers();
  const directory = useEngineers();
  const appRef = useRef(app);
  appRef.current = app;
  const changeRef = useRef(onWindowChange);
  changeRef.current = onWindowChange;

  // ── which window is open: the address is the truth (Back / Forward, a shared link, a reload) ──
  const [current, setCurrent] = useState(locationTarget);
  const currentRef = useRef(current);
  currentRef.current = current;
  const pushed = useRef(new Set());          // history entries this page pushed for a window (their labWindow token)
  const seq = useRef(0);
  const lastSearch = useRef(window.location.search);
  const adopt = useCallback(next => {
    setCurrent(prev => (prev && next && sameWindow(prev, next) && prev.sec === next.sec ? prev : next));
  }, []);
  const sync = useCallback(() => {
    const legacy = legacyViewTarget(window.history.state);
    if (legacy) {
      // An entry written before windows existed (or by an old bundle): its address names the device window from now on.
      window.history.replaceState({ ...withoutConsole(window.history.state), view: { kind: "dashboard" }, kvmConsole: window.history.state?.kvmConsole },
        "", windowHref(window.location.href, legacy));
    }
    lastSearch.current = window.location.search;
    adopt(legacy || parseWindow(window.location.search));
  }, [adopt]);
  useEffect(() => {
    if (legacyViewTarget(window.history.state)) sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [sync]);
  // navigate() and selectRack() change the address with pushState (no event): read it after every render of the page.
  useEffect(() => { if (window.location.search !== lastSearch.current) sync(); });

  const open = useCallback((target, { replace = false } = {}) => {
    const clean = windowTarget(target?.kind, target?.id, target?.sec);
    if (!clean) return;
    const full = { ...clean, ...(target.moveTo ? { moveTo: target.moveTo } : {}), ...(target.swapWith ? { swapWith: target.swapWith } : {}) };
    const href = windowHref(window.location.href, clean);
    const state = withoutConsole(window.history.state);
    if (legacyViewTarget(state)) state.view = { kind: "dashboard" };
    const mine = window.history.state?.labWindow;
    if (replace && mine) {
      window.history.replaceState({ ...state, labWindow: mine }, "", href);
    } else if (replace) {
      window.history.replaceState(state, "", href);
    } else {
      const token = `${windowId(clean)}#${++seq.current}`;
      pushed.current.add(token);
      window.history.pushState({ ...state, labWindow: token }, "", href);
    }
    lastSearch.current = window.location.search;
    setCurrent(full);
  }, []);
  const openServer = useCallback((key, { sec, moveTo, swapWith, replace } = {}) => open({ kind: "server", id: key, sec, moveTo, swapWith }, { replace }), [open]);
  const close = useCallback(() => {
    const token = window.history.state?.labWindow;
    if (token && pushed.current.has(token)) { window.history.back(); return; }   // popstate → sync
    const { labWindow, ...state } = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
    window.history.replaceState(state, "", windowHref(window.location.href, null));
    lastSearch.current = window.location.search;
    setCurrent(null);
  }, []);
  // Show on Racks keeps the window: the Racks tab with ?rack= and the window's own parameter, one history entry.
  const showOnRacks = useCallback(rack => {
    const target = currentRef.current;
    appRef.current.goTo?.("racks", rack || undefined);
    if (target) open(target, { replace: true });
  }, [open]);

  useEffect(() => { changeRef.current?.(current); }, [current]);

  // ── the shared data: loaded while a window is open or a component asks for it (useLabData) ──
  const [interest, setInterest] = useState({ servers: 0, all: 0 });
  const want = useCallback(level => {
    const k = level === "servers" ? "servers" : "all";
    setInterest(i => ({ ...i, [k]: i[k] + 1 }));
    return () => setInterest(i => ({ ...i, [k]: i[k] - 1 }));
  }, []);
  const wanted = current || interest.all > 0 ? ALL : interest.servers > 0 ? SERVERS_ONLY : [];
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const [stores, setStores] = useState({});
  const [errors, setErrors] = useState({});
  const seqs = useRef({});
  const loadStore = useCallback(async name => {
    const turn = (seqs.current[name] || 0) + 1;
    seqs.current[name] = turn;
    try {
      const value = await STORES[name].load();
      if (seqs.current[name] !== turn) return;
      setStores(s => ({ ...s, [name]: value }));
      setErrors(e => { if (!(name in e)) return e; const next = { ...e }; delete next[name]; return next; });
    } catch (e) {
      if (seqs.current[name] === turn) setErrors(er => ({ ...er, [name]: errorMessage(e) }));
    }
  }, []);
  const wantedKey = wanted.join(",");
  useEffect(() => { for (const name of wanted) loadStore(name); }, [wantedKey, loadStore]);
  const reload = useCallback(async (domains = null) => {
    const names = wantedRef.current.filter(name => !domains || STORES[name].domains.some(d => domains.includes(d)));
    await Promise.all(names.map(loadStore));
  }, [loadStore]);
  const live = useLiveReload(LIVE_DOMAINS, domains => reload(domains));
  // Storage racks (16 shelves) by the rack's type, also when Racks was never opened (floors.js).
  useEffect(() => { setStorageRacks(storageRacksFromDevices(devices)); }, [devices]);

  const data = useMemo(() => ({
    devices, pduStatuses, kvmStatuses, maintenance,
    locations: stores.locations ?? null,
    rackItems: stores.rackItems?.data ?? null,
    owners: stores.owners ?? null,
    switches: stores.switches?.data ?? null,
    monitoring: stores.monitoring ?? null,
    chillers: stores.chillers?.data ?? null,
    twin: stores.twin ?? null,
    removed: removed?.data ?? null,
    hidden: removed?.hidden ?? new Set(),
    engineers: directory?.engineers ?? null,
    etags: { rackItems: stores.rackItems?.etag ?? null, switches: stores.switches?.etag ?? null, chillers: stores.chillers?.etag ?? null,
      twin: stores.twin?.etag ?? null, removed: removed?.etag ?? null },
  }), [devices, pduStatuses, kvmStatuses, maintenance, stores, removed?.data, removed?.hidden, removed?.etag, directory?.engineers]);
  const role = canAdmin ? "admin" : canOperate ? "operator" : "viewer";
  const full = wanted === ALL;
  const index = useMemo(() => (full ? buildLabIndex(data, role) : null), [full, data, role]);
  const servers = useMemo(() => serverList(stores.locations, { hidden: removed?.hidden, admin: !!canAdmin }), [stores.locations, removed?.hidden, canAdmin]);
  const can = useMemo(() => ({ operate: !!canOperate, admin: !!canAdmin }), [canOperate, canAdmin]);

  // ── toasts and the "Last change" panel: kept here so a result outlives its window ──
  const [toasts, setToasts] = useState([]);
  const toastSeq = useRef(0);
  const dismissToast = useCallback(id => setToasts(list => list.filter(t => t.id !== id)), []);
  const toast = useCallback((text, { undo = null, tone = "ok", timeout = TOAST_MS } = {}) => {
    const id = ++toastSeq.current;
    setToasts(list => [...list.slice(-2), { id, text, undo, tone }]);
    if (timeout) setTimeout(() => dismissToast(id), timeout);
    return id;
  }, [dismissToast]);
  const [changes, setChanges] = useState({});
  const showResult = useCallback((key, result) => setChanges(c => ({ ...c, [key]: result })), []);
  const lastChange = useCallback(key => changes[key] || null, [changes]);
  const dismissLastChange = useCallback(key => setChanges(c => { const next = { ...c }; delete next[key]; return next; }), []);

  // ── dialogs a window opens: its own (act.openDialog) and the shared delete and power dialogs ──
  const [dialog, setDialog] = useState(null);
  const openDialog = useCallback((type, props = {}) => setDialog({ type, ...props }), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  useEffect(() => { if (!current) setDialog(null); }, [current]);
  const [deleting, setDeleting] = useState(null);
  const openDelete = useCallback((targets, { options = null, onDone = null } = {}) => {
    const list = (Array.isArray(targets) ? targets : [targets]).filter(t => t && t.kind && t.id != null);
    if (list.length) setDeleting({ targets: list, options, onDone });
  }, []);
  const power = useServerPower({ devices, pduStatuses, maintenance, canOperate, toast,
    switchFeeds: (...args) => appRef.current.switchFeeds?.(...args) });
  const powerApi = useMemo(() => ({ enabled: power.enabled, groupFor: power.groupFor, pending: power.pending, request: power.request }),
    [power.enabled, power.groupFor, power.pending, power.request]);

  const act = useMemo(() => ({
    open, openServer, close, openDelete, openDialog, closeDialog, toast, showResult, showOnRacks,
    during: live.during, reload,
    goTo: (tab, target) => appRef.current.goTo?.(tab, target),
    showIn3d: ref => appRef.current.goTo?.("twin", { ref }),
    power: powerApi,
    app: {
      outletAction: (...a) => appRef.current.outletAction?.(...a),
      turnOnAll: (...a) => appRef.current.turnOnAll?.(...a),
      openMaintenance: (...a) => appRef.current.openMaintenance?.(...a),
      saveLabels: (...a) => appRef.current.saveLabels?.(...a),
      markKvmFree: (...a) => appRef.current.markKvmFree?.(...a),
      openConsole: (...a) => appRef.current.openConsole?.(...a),
      deleteDevice: (...a) => appRef.current.deleteDevice?.(...a),
      switchFeeds: (...a) => appRef.current.switchFeeds?.(...a),
      refresh: (...a) => appRef.current.refresh?.(...a),
    },
  }), [open, openServer, close, openDelete, openDialog, closeDialog, toast, showResult, showOnRacks, live.during, reload, powerApi]);

  if (apiRef) apiRef.current = { open, openServer, close, current };

  const value = useMemo(() => ({
    open, openServer, close, current, index, twin: stores.twin ?? null, servers, data, ready: data.locations != null, errors,
    reload, act, can, want, lastChange, dismissLastChange, dialog, closeDialog, mounted: true,
  }), [open, openServer, close, current, index, stores.twin, servers, data, errors, reload, act, can, want, lastChange, dismissLastChange, dialog, closeDialog]);

  return <LabWindowContext.Provider value={value}>
    {children}
    {current && <WindowHost target={current} onClose={close}/>}
    {power.element}
    {deleting && <DeleteDialog targets={deleting.targets} options={deleting.options}
      onClose={() => setDeleting(null)}
      onDone={result => { const done = deleting.onDone; setDeleting(null); done?.(result); reload(); }}/>}
    {toasts.length > 0 && <div className="lab-toasts" role="status" aria-live="polite">
      {toasts.map(t => <div key={t.id} className="lab-toast" data-tone={t.tone}>
        <span dir="auto">{t.text}</span>
        {t.undo && <button type="button" className="lab-window-btn" onClick={() => { dismissToast(t.id); t.undo(); }}>Undo</button>}
        <button type="button" className="lab-window-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>×</button>
      </div>)}
    </div>}
  </LabWindowContext.Provider>;
}

// The window registry (v2 §I): one component per kind, keyed by the window so a new one starts clean.
function WindowHost({ target, onClose }) {
  const Windows = { server: ServerWindow, dev: DeviceWindow, rack: RackWindow, unit: UnitWindow, cooling: CoolingWindow, twin: TwinItemWindow };
  const Window = Windows[target.kind];
  return Window ? <Window key={windowId(target)} target={target} onClose={onClose}/> : null;
}

// The page behind a window: hidden from assistive technology and not focusable while a window is open (the header
// stays outside it, so a tab change still works). display: contents keeps the page's own layout.
export function WindowBackdrop({ children }) {
  const { current } = useLabWindow();
  const open = !!current;
  return <div style={{ display: "contents" }} data-window-backdrop="" inert={open ? "" : undefined} aria-hidden={open ? "true" : undefined}>{children}</div>;
}
