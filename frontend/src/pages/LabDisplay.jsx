// Lab display (?tab=display): a read-only full-screen page for the wall TV at the lab entrance. It only reads (GET)
// what a Viewer may read, refreshes every 15 s without blanking (the last good data stays up; after 60 s without data
// a NOT LIVE banner covers the top and the panels turn grey), recovers by itself after a network loss, never scrolls
// (long lists and the rack grid turn pages every 10 s, alarms stay pinned) and has no buttons, dialogs, assistant or
// footer. Helpers and thresholds: ../labDisplay.js.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAccounts } from "../accounts";
import nvidiaLogo from "../assets/nvidia-logo.svg";
import {
  REFRESH_MS, STALE_MS, STALE_ALARM_MS, ROTATE_MS, REQUEST_TIMEOUT_MS, OVERRIDES_EVERY, INCIDENT_LIMIT, ROW_EM,
  LIST_GAP_EM, LOAD_COL_EM, TICKER_ITEM_EM, RATED_AMPS,
  buildServers, buildRacks, environment, kpis, attentionItems, consolesInUse, recentChanges, maintenanceEntries,
  rackGrid, rowsThatFit, pageOf, pinnedPage, labStatus, sourceAfter, relativeAge, formatNumber, formatKw, formatRange,
  clockTime, longDate, changeTime, connectionState, pruneStatuses,
} from "../labDisplay";

const LAB_NAME = "Lab 204";
const LAB_PLACE = "Yokneam";
const EMPTY = { devices: [], pduStatuses: {}, kvmStatuses: {}, maintenance: null, monitoring: null, incidents: null, rackOverrides: {} };
// Burn-in care for a screen that runs all day: every 5 minutes the whole layout moves by 0-4 px.
const SHIFT_MS = 5 * 60_000;
const SHIFT_PX = 4;
// Narrower than this, or portrait: a notice instead of the display (it is laid out for a landscape TV).
const NARROW_QUERY = "(max-width: 899px), (orientation: portrait)";

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The request timed out")), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, status: error?.status, error }));
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// The data cycle: one at a time (a slow server never stacks requests), every REFRESH_MS after the last one finished,
// at once when the network comes back or the tab becomes visible, paused while the tab is hidden. Each extra source
// (maintenance, Ping Monitor, incidents, rack overrides) keeps its last good copy for STALE_MS after its last success
// and is then "unknown" (sources[name].state), never an old copy shown as current.
function useLabFeed() {
  const [feed, setFeed] = useState({ data: EMPTY, sources: {}, loaded: false, state: "connecting", lastSuccess: 0, error: "" });
  useEffect(() => {
    let alive = true, busy = false, timer = null, cycle = 0;
    let data = EMPTY;
    let sources = {};
    const okAt = new Map();   // device id -> ms of its last good status (only devices that still exist)
    const schedule = () => { clearTimeout(timer); timer = setTimeout(run, REFRESH_MS); };
    async function run() {
      if (!alive || busy) return;
      clearTimeout(timer);
      if (document.hidden) { schedule(); return; }
      busy = true;
      const n = cycle++;
      try {
        const list = await withTimeout(api.getDevices());
        if (!alive) return;
        const devices = Array.isArray(list) ? list : [];
        const pdus = devices.filter(d => d.kind === "pdu");
        const kvms = devices.filter(d => d.kind === "kvm");
        const readOverrides = n % OVERRIDES_EVERY === 0 || !sources.overrides;
        const [pduRes, kvmRes, maintenance, monitoring, incidents, overrides] = await Promise.all([
          Promise.allSettled(pdus.map(p => withTimeout(api.getPduStatus(p.id)))),
          Promise.allSettled(kvms.map(k => withTimeout(api.getKvmStatus(k.id)))),
          settle(withTimeout(api.maintenanceList())),
          settle(withTimeout(getJson("/api/monitoring"))),
          settle(withTimeout(getJson(`/api/monitoring/incidents?limit=${INCIDENT_LIMIT}`))),
          readOverrides ? settle(withTimeout(getJson("/api/rack-overrides"))) : Promise.resolve(null),
        ]);
        if (!alive) return;
        const now = Date.now();
        const ids = new Set(devices.map(d => String(d.id)));
        for (const id of okAt.keys()) if (!ids.has(id)) okAt.delete(id);
        // One failed status read keeps the device's last good reading for up to STALE_MS; after that it shows as
        // "status not available" (never a guess).
        const merge = (list, results, previous, blank) => {
          const out = {};
          list.forEach((device, i) => {
            const result = results[i];
            const id = String(device.id);
            if (result.status === "fulfilled" && result.value) { out[device.id] = result.value; okAt.set(id, now); return; }
            const last = previous[device.id];
            const recent = last && !last.requestFailed && now - (okAt.get(id) || 0) <= STALE_MS;
            out[device.id] = recent ? last : { device_id: device.id, requestFailed: true, error: errorMessage(result.reason), ...blank };
          });
          return pruneStatuses(out, ids);
        };
        sources = {
          maintenance: sourceAfter(sources.maintenance, maintenance, now),
          monitoring: sourceAfter(sources.monitoring, monitoring, now),
          incidents: sourceAfter(sources.incidents, incidents, now),
          // Read every OVERRIDES_EVERY cycles, so it may be that much older before it counts as unknown.
          overrides: overrides ? sourceAfter(sources.overrides, overrides, now, STALE_MS + OVERRIDES_EVERY * REFRESH_MS) : sources.overrides,
        };
        data = {
          devices,
          pduStatuses: merge(pdus, pduRes, data.pduStatuses, { outlets: [] }),
          kvmStatuses: merge(kvms, kvmRes, data.kvmStatuses, { ports: [] }),
          maintenance: sources.maintenance.value,
          monitoring: sources.monitoring.value,
          incidents: sources.incidents.value,
          // Unknown overrides keep the last copy: without it moved servers would jump back to their PDU's rack.
          rackOverrides: sources.overrides?.state === "unknown" ? data.rackOverrides : asObject(sources.overrides?.value),
        };
        setFeed({ data, sources, loaded: true, state: "online", lastSuccess: now, error: "" });
      } catch (error) {
        if (!alive) return;
        setFeed(f => ({ ...f, state: error?.status === 401 ? "signed-out" : "offline", error: errorMessage(error) }));
      } finally {
        busy = false;
        if (alive) schedule();
      }
    }
    const runNow = () => { if (!busy) run(); };
    const onVisible = () => { if (document.visibilityState === "visible") runNow(); };
    window.addEventListener("online", runNow);
    document.addEventListener("visibilitychange", onVisible);
    run();
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("online", runNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return feed;
}

function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

// True once the last good data is older than STALE_MS: re-rendered exactly when that moment comes.
function useStale(lastSuccess) {
  const [, wake] = useState(0);
  useEffect(() => {
    if (!lastSuccess) return undefined;
    const due = lastSuccess + STALE_MS - Date.now() + 50;
    if (due <= 0) return undefined;
    const timer = setTimeout(() => wake(w => w + 1), due);
    return () => clearTimeout(timer);
  }, [lastSuccess]);
  return lastSuccess > 0 && Date.now() - lastSuccess > STALE_MS;
}

// The page turn shared by every list: a step number and when it turned (for "next in n s").
function useRotation() {
  const [rotation, setRotation] = useState(() => ({ tick: 0, at: Date.now() }));
  useEffect(() => {
    const timer = setInterval(() => setRotation(r => ({ tick: (r.tick + 1) % 1_000_000, at: Date.now() })), ROTATE_MS);
    return () => clearInterval(timer);
  }, []);
  return rotation;
}

function useBurnInShift() {
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const step = () => Math.floor(Math.random() * (SHIFT_PX + 1));
    const timer = setInterval(() => setShift({ x: step(), y: step() }), SHIFT_MS);
    return () => clearInterval(timer);
  }, []);
  return shift;
}

function useNarrowScreen() {
  const query = () => typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const list = window.matchMedia(NARROW_QUERY);
    const follow = () => setNarrow(list.matches);
    follow();
    list.addEventListener?.("change", follow);
    return () => list.removeEventListener?.("change", follow);
  }, []);
  return narrow;
}

// The size of a box that does not depend on its content, and the em (px) its rows are measured in.
function useBox() {
  const ref = useRef(null);
  const [box, setBox] = useState({ width: 0, height: 0, em: 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const em = parseFloat(getComputedStyle(el).fontSize) || 16;
      const next = { width: Math.floor(rect.width), height: Math.floor(rect.height), em };
      setBox(b => (b.width === next.width && b.height === next.height && b.em === next.em ? b : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box];
}

// A TV page: its own title, no page scroll, the screen kept awake where the browser allows it, and the pointer hidden
// after a few seconds without movement.
function useScreenSetup(rootRef) {
  useEffect(() => {
    const title = document.title;
    const html = document.documentElement;
    const overflow = html.style.overflow;
    document.title = `Lab display · ${LAB_NAME}`;
    html.style.overflow = "hidden";
    let lock = null, alive = true, pointerTimer = null;
    const keepAwake = async () => {
      if (!alive || lock || document.visibilityState !== "visible" || !navigator.wakeLock?.request) return;
      try {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener?.("release", () => { lock = null; });
        if (!alive) lock.release().catch(() => {});
      } catch { lock = null; }
    };
    const onPointer = () => {
      const root = rootRef.current;
      if (!root) return;
      root.dataset.pointer = "visible";
      clearTimeout(pointerTimer);
      pointerTimer = setTimeout(() => { delete root.dataset.pointer; }, 3000);
    };
    keepAwake();
    document.addEventListener("visibilitychange", keepAwake);
    window.addEventListener("pointermove", onPointer, { passive: true });
    return () => {
      alive = false;
      clearTimeout(pointerTimer);
      document.title = title;
      html.style.overflow = overflow;
      document.removeEventListener("visibilitychange", keepAwake);
      window.removeEventListener("pointermove", onPointer);
      lock?.release?.().catch?.(() => {});
    };
  }, [rootRef]);
}

// Text in parts: what people typed (names, who, why) is isolated in <bdi dir="auto"> so Hebrew keeps its place.
function Parts({ parts }) {
  return (parts || []).map((part, i) => (part.user ? <bdi key={i} dir="auto">{part.text}</bdi> : <Fragment key={i}>{part.text}</Fragment>));
}

export default function LabDisplay() {
  const narrow = useNarrowScreen();
  return narrow ? <NarrowNotice /> : <DisplayScreen />;
}

function NarrowNotice() {
  useEffect(() => {
    const title = document.title;
    document.title = `Lab display · ${LAB_NAME}`;
    return () => { document.title = title; };
  }, []);
  return (
    <main className="lab-display-narrow" data-testid="display-narrow">
      <p role="status">The lab display is made for a landscape TV. <a href="/?tab=dashboard">Open the Dashboard</a> on this device.</p>
    </main>
  );
}

function DisplayScreen() {
  const rootRef = useRef(null);
  const feed = useLabFeed();
  const rotation = useRotation();
  useScreenSetup(rootRef);
  const stale = useStale(feed.lastSuccess);
  const shift = useBurnInShift();

  const view = useMemo(() => {
    const { data, sources } = feed;
    const pdus = data.devices.filter(d => d.kind === "pdu");
    const servers = buildServers(pdus, data.pduStatuses, data.rackOverrides);
    const env = environment(pdus, data.pduStatuses);
    const monitoringUnknownSince = sources.monitoring?.state === "unknown" ? sources.monitoring.since : null;
    const attention = attentionItems({ ...data, env, now: feed.lastSuccess || Date.now(), monitoringUnknownSince });
    return {
      env,
      attention,
      status: labStatus(attention),
      kpi: kpis({ ...data, servers }),
      racks: buildRacks(data.devices, data.pduStatuses, servers, data.maintenance, { sensors: env.sensors, attention }),
      inUse: consolesInUse(data.devices, data.kvmStatuses),
      changes: recentChanges(data),
      maintenance: maintenanceEntries(data),
    };
  }, [feed.data, feed.sources, feed.lastSuccess]);
  const partial = Object.values(feed.sources).some(source => source?.state === "unknown");

  return (
    <div ref={rootRef} className="lab-display" data-loaded={feed.loaded ? "true" : "false"} data-stale={stale ? "true" : "false"}
      data-partial={partial ? "true" : "false"} data-connection={feed.state}
      style={{ "--ld-shift-x": `${shift.x}px`, "--ld-shift-y": `${shift.y}px` }}>
      <TopBar feed={feed} status={feed.loaded && !stale ? view.status : null} partial={partial} />
      {stale && <StaleBanner feed={feed} />}
      <RoleWarning />
      {!feed.loaded
        ? <FirstLoad feed={feed} />
        : <>
          <Kpis view={view} />
          <MaintenanceBand entries={view.maintenance} source={feed.sources.maintenance} rotation={rotation} />
          <main className="ld-main" aria-label="Lab status">
            <div className="ld-column">
              <RacksPanel racks={view.racks} rotation={rotation} />
              <LoadPanel loads={view.kpi.loads} rotation={rotation} />
            </div>
            <div className="ld-column ld-side">
              <AttentionPanel items={view.attention} rotation={rotation} />
              <InUsePanel rows={view.inUse} kvmTotal={view.kpi.kvms.total} rotation={rotation} stale={stale} />
            </div>
          </main>
          <ChangesStrip rows={view.changes} rotation={rotation} />
        </>}
    </div>
  );
}

function TopBar({ feed, status, partial }) {
  const now = useNow(1000);
  const { mode, user } = useAccounts();
  const conn = connectionState({ state: feed.state, lastSuccess: feed.lastSuccess, now, partial });
  const updated = feed.lastSuccess ? `Updated ${relativeAge(now - feed.lastSuccess)}` : "Waiting for the first reading";
  return (
    <header className="ld-top">
      <div className="ld-brand">
        <img src={nvidiaLogo} alt="NVIDIA" />
        <span className="ld-brand-rule" aria-hidden="true" />
        <h1>{LAB_NAME} <span>· {LAB_PLACE}</span></h1>
        {status && <span className="ld-status" data-level={status.level} data-testid="lab-status">{status.text}</span>}
      </div>
      <div className="ld-conn" data-level={conn.level}>
        <span className="ld-conn-state" role="status"><i aria-hidden="true" />{conn.text}</span>
        <span className="ld-conn-updated">
          {updated}
          {mode === "accounts" && user && <span className="ld-role" data-testid="display-role" data-role={user.role}>{user.role}</span>}
        </span>
      </div>
      <div className="ld-clock">
        <time className="ld-clock-time" dateTime={new Date(now).toISOString()}>{clockTime(now)}<small>:{clockTime(now, true).slice(-2)}</small></time>
        <span className="ld-clock-date">{longDate(now)}</span>
      </div>
    </header>
  );
}

// Full width under the top bar while the data is older than STALE_MS: a warning, an alarm after STALE_ALARM_MS.
function StaleBanner({ feed }) {
  const now = useNow(1000);
  const age = now - feed.lastSuccess;
  const why = feed.state === "signed-out" ? "signed out" : feed.state === "online" ? "data not refreshed" : "Lab Manager is not answering";
  return (
    <div className="ld-stale-banner" role="status" data-testid="stale-banner" data-level={age > STALE_ALARM_MS ? "alarm" : "warn"}>
      NOT LIVE · last update {clockTime(feed.lastSuccess)} ({relativeAge(age)}) · {why}
    </div>
  );
}

// An unattended screen at the door should hold a Viewer session: any higher role can switch power from this browser.
function RoleWarning() {
  const { mode, user } = useAccounts();
  if (mode !== "accounts" || !user || user.role === "Viewer") return null;
  return <p className="ld-role-warn" role="status" data-testid="role-warning">Signed in as {user.role} — use a Viewer account for this screen</p>;
}

function FirstLoad({ feed }) {
  const text = feed.state === "signed-out" ? "Sign in with the lab's Viewer account to show the lab display."
    : feed.state === "offline" ? `Lab Manager is not answering. Retrying every ${REFRESH_MS / 1000} s.`
    : "Connecting…";
  return <main className="ld-first" aria-label="Lab status"><p role="status">{text}</p></main>;
}

// Status in words as well as colour: a chip on every KPI tile at warning or alarm level.
const CHIP = { warn: "CHECK", alarm: "ALARM" };

function Chip({ level, testId, text }) {
  const word = text || CHIP[level];
  return word ? <span className="ld-chip" data-level={level} data-testid={testId}>{word}</span> : null;
}

// A number is never cut off: when it does not fit its tile (a long value, a narrow tile) it is drawn smaller until it
// does. The CSS size (min(3.6em, 31cqi)) already fits the usual values; this covers the rest.
function useFitWidth(key) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      el.style.fontSize = "";
      if (el.scrollWidth <= el.clientWidth) return;
      const px = parseFloat(getComputedStyle(el).fontSize) || 0;
      el.style.fontSize = `${Math.floor(px * (el.clientWidth / el.scrollWidth) * 0.97 * 10) / 10}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement);
    return () => observer.disconnect();
  }, [key]);
  return ref;
}

function Tile({ label, value, unit, sub, level = "idle", testId, chip }) {
  const fitRef = useFitWidth(`${value}|${unit}|${level}`);
  return (
    <section className="ld-tile" data-level={level} data-testid={testId} aria-label={label}>
      <h2>{label}</h2>
      <div className="ld-tile-row">
        <p ref={fitRef} className="ld-tile-value">{value}{unit && <small>{unit}</small>}</p>
      </div>
      {/* The word on its own line, so it never squeezes the number. */}
      {(chip || CHIP[level]) && <p className="ld-tile-flag"><Chip level={level} testId={`${testId}-chip`} text={chip} /></p>}
      <p className="ld-tile-sub">{sub}</p>
    </section>
  );
}

function Kpis({ view }) {
  const { kpi, env } = view;
  const s = kpi.servers;
  const pdusDown = kpi.pdus.read - kpi.pdus.reachable;
  const kvmsDown = kpi.kvms.read - kpi.kvms.reachable;
  const missing = kpi.pdus.total - kpi.power.known;
  const envLevel = env.hasSensors ? env.level : "idle";
  return (
    <div className="ld-kpis">
      <Tile testId="kpi-on" label="Servers on" value={s.on} level={s.total ? "ok" : "idle"} sub={`of ${s.total} servers`} />
      <Tile testId="kpi-off" label="Servers off" value={s.off} level={s.off ? "neutral" : "idle"} sub="Outlet switched off" />
      <Tile testId="kpi-noreading" label="No reading" value={s.noReading} level={s.noReading ? "warn" : "idle"} sub="Power unknown" />
      <Tile testId="kpi-pdus" label="PDUs online" value={kpi.pdus.reachable} unit={` / ${kpi.pdus.total}`}
        level={!kpi.pdus.total ? "idle" : pdusDown > 0 ? "alarm" : "ok"}
        sub={pdusDown > 0 ? `${pdusDown} unreachable` : kpi.pdus.maintenance ? `${kpi.pdus.maintenance} in maintenance` : kpi.pdus.total ? "All answering" : "No PDUs"} />
      <Tile testId="kpi-kvms" label="KVMs online" value={kpi.kvms.reachable} unit={` / ${kpi.kvms.total}`}
        level={!kpi.kvms.total ? "idle" : kvmsDown > 0 ? "warn" : "ok"}
        sub={kvmsDown > 0 ? `${kvmsDown} unreachable` : view.inUse.length ? `${view.inUse.length} ${view.inUse.length === 1 ? "console" : "consoles"} open` : kpi.kvms.total ? "All answering" : "No KVMs"} />
      <Tile testId="kpi-power" label="Total power" value={formatKw(kpi.power.watts)} unit={kpi.power.watts == null ? "" : " kW"}
        // A total in kW is neither healthy nor unhealthy: neutral, or PARTIAL when some PDUs gave no reading.
        level={kpi.power.watts == null ? "idle" : kpi.power.complete ? "neutral" : "warn"} chip={kpi.power.watts != null && !kpi.power.complete ? "PARTIAL" : undefined}
        sub={kpi.power.watts == null ? "No PDU reading" : kpi.power.complete ? `${kpi.pdus.total} ${kpi.pdus.total === 1 ? "PDU" : "PDUs"}` : missing > 0 ? `${kpi.power.known} of ${kpi.pdus.total} PDUs read` : "Some outlets unread"} />
      <section className="ld-tile ld-env" data-level={envLevel} data-testid="kpi-env" aria-label="Environment">
        <h2>Environment <Chip level={envLevel} testId="kpi-env-chip" /></h2>
        {env.hasSensors ? <dl>
          <div data-level={env.tempLevel}><dt>Temp</dt><dd>{formatRange(env.tempMin, env.tempMax, env.tempMin === env.tempMax ? 1 : 0)}<small> °C</small></dd></div>
          <div data-level={env.humLevel}><dt>Humidity</dt><dd>{formatRange(env.humMin, env.humMax, 0)}<small> %</small></dd></div>
          <div data-level={env.leakLevel}><dt>Leak</dt><dd>{env.leakSensors ? env.leak ? "YES" : "None" : "—"}</dd></div>
        </dl> : <><p className="ld-tile-value ld-muted">—</p><p className="ld-tile-sub">No PDU sensors reporting</p></>}
      </section>
    </div>
  );
}

// Maintenance in progress, always in view while it lasts (one PDU at a time when there are several).
function MaintenanceBand({ entries, source, rotation }) {
  if (source?.state === "unknown") {
    return (
      <div className="ld-maint-band" data-level="warn" data-testid="maint-band" role="status">
        <strong className="ld-maint-label">MAINTENANCE</strong>
        <span className="ld-maint-text">Maintenance status unavailable since {clockTime(source.since)}</span>
      </div>
    );
  }
  if (!entries.length) return null;
  const { items: [entry], page, pages } = pageOf(entries, 1, rotation.tick);
  return (
    <div className="ld-maint-band" data-level="maint" data-testid="maint-band" role="status">
      <strong className="ld-maint-label">MAINTENANCE IN PROGRESS</strong>
      <span className="ld-maint-text"><Parts parts={entry.parts} /></span>
      {pages > 1 && <span className="ld-maint-count" data-page={`${page + 1}/${pages}`}>{page + 1} of {pages}</span>}
    </div>
  );
}

function Countdown({ at }) {
  const now = useNow(1000);
  return <>{Math.max(1, Math.ceil((at + ROTATE_MS - now) / 1000))} s</>;
}

// "+N more · next in 10 s": how much is not on screen and when the next page comes.
function Pager({ more, page, pages, rotation }) {
  if (!more) return null;
  return (
    <span className="ld-pager" data-page={`${page + 1}/${pages}`}>
      +{more} more{pages > 1 && <> · next in <Countdown at={rotation.at} /></>}
    </span>
  );
}

function PanelHead({ title, count, note, pager }) {
  return (
    <div className="ld-panel-head">
      <h2>{title}{count != null && <span className="ld-count">{count}</span>}</h2>
      {note && <span className="ld-panel-note">{note}</span>}
      {pager}
    </div>
  );
}

function RacksPanel({ racks, rotation }) {
  const [ref, box] = useBox();
  const layout = rackGrid(racks.length, box.width, box.height, box.em);
  const { items, page, pages } = pageOf(racks, layout.perPage, rotation.tick);
  return (
    <section className="ld-panel ld-racks" aria-label="Racks">
      <PanelHead title="Racks" count={racks.length} pager={<Pager more={racks.length - items.length} page={page} pages={pages} rotation={rotation} />} />
      <div ref={ref} className="ld-panel-body">
        {racks.length === 0 ? <p className="ld-empty">No racks are set up yet.</p> :
          <div className="ld-rack-grid" data-compact={layout.compact ? "true" : "false"}
            style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, gridAutoRows: `${layout.cellH}px`, gap: `${layout.gapEm}em` }}>
            {items.map(r => {
              // No reading for any server: never a 0 that reads as "all off".
              const unknown = !r.storage && r.total > 0 && r.noReading >= r.total;
              const extra = r.storage ? [] : unknown ? ["Power unknown"] : [r.watts == null ? "— kW" : `${formatKw(r.watts)} kW`,
                r.off > 0 && `${r.off} off`, r.noReading > 0 && `${r.noReading} unknown`].filter(Boolean);
              return (
                <article key={r.rack} className="ld-rack" data-level={r.level} data-rack={r.rack}>
                  <h3 dir="auto">{r.rack}</h3>
                  {/* A compact card has no room for a sentence: storage and empty racks say so in the state line. */}
                  {r.storage || r.total === 0 ? !layout.compact && <p className="ld-rack-servers ld-muted">{r.storage ? "Equipment storage" : "No servers"}</p>
                    : unknown ? <p className="ld-rack-servers" data-unknown="true"><strong>—</strong><span> / {r.total}</span></p>
                    : <p className="ld-rack-servers"><strong>{r.on}</strong><span> / {r.total} on</span></p>}
                  {!layout.compact && <p className="ld-rack-extra">
                    {r.maintenancePdus.length > 0 && <span className="ld-badge" data-level="maint">Maint</span>}
                    <span>{extra.join(" · ")}</span>
                  </p>}
                  <p className="ld-rack-state" data-level={r.level}>{layout.compact ? r.reason || (r.storage ? "Storage" : "No servers") : r.reason}</p>
                </article>
              );
            })}
          </div>}
      </div>
    </section>
  );
}

const SEVERITY_TEXT = { alarm: "Alarm", warn: "Warning", info: "Info" };

function AttentionPanel({ items, rotation }) {
  const [ref, box] = useBox();
  const rows = rowsThatFit(box.height, ROW_EM.attention * box.em, LIST_GAP_EM * box.em);
  const { items: shown, moreAlarms, more, page, pages } = pinnedPage(items, rows, rotation.tick);
  const alarms = items.filter(i => i.severity === "alarm").length;
  return (
    <section className="ld-panel ld-attention" aria-label="Attention" data-level={alarms ? "alarm" : items.length ? "warn" : "ok"}>
      <PanelHead title="Attention" count={items.length} pager={<Pager more={more} page={page} pages={pages} rotation={rotation} />} />
      <div ref={ref} className="ld-panel-body">
        {items.length === 0 ? <p className="ld-allclear"><i aria-hidden="true" />All clear: every device answers and nothing needs a look.</p> :
          <ul className="ld-list" style={{ gap: `${LIST_GAP_EM}em` }}>
            {shown.map(item => (
              <li key={item.key} className="ld-attn" data-level={item.severity} data-kind={item.kind} style={{ height: `${ROW_EM.attention}em` }}>
                <span className="ld-attn-tag">{SEVERITY_TEXT[item.severity]}</span>
                <span className="ld-attn-text"><strong dir="auto"><Parts parts={item.titleParts} /></strong><span dir="auto"><Parts parts={item.parts} /></span></span>
              </li>
            ))}
            {moreAlarms > 0 && <li className="ld-attn ld-attn-more" data-level="alarm" style={{ height: `${ROW_EM.attention}em` }}>
              <span className="ld-attn-tag">Alarm</span><span className="ld-attn-more-text">+{moreAlarms} more {moreAlarms === 1 ? "alarm" : "alarms"}</span>
            </li>}
          </ul>}
      </div>
    </section>
  );
}

function LoadPanel({ loads, rotation }) {
  const [ref, box] = useBox();
  // Two columns of PDUs when the panel is wide enough for two readable rows side by side.
  const cols = box.width >= 2 * LOAD_COL_EM * box.em ? 2 : 1;
  const perPage = cols * rowsThatFit(box.height, ROW_EM.load * box.em, LIST_GAP_EM * box.em);
  const { items, page, pages } = pageOf(loads, perPage, rotation.tick);
  return (
    <section className="ld-panel ld-load" aria-label="Power by PDU">
      <PanelHead title="Power by PDU" note={`Load vs ${RATED_AMPS} A`} pager={<Pager more={loads.length - items.length} page={page} pages={pages} rotation={rotation} />} />
      <div ref={ref} className="ld-panel-body">
        {loads.length === 0 ? <p className="ld-empty">No PDUs are set up.</p> :
          <ul className="ld-list ld-load-list" style={{ gap: `${LIST_GAP_EM}em 2.4em`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {items.map(l => {
              const down = l.state === "offline" || l.state === "unavailable";
              const pct = l.pct == null ? 0 : Math.max(0, Math.min(100, l.pct));
              return (
                <li key={l.id} className="ld-loadrow" data-level={l.level} data-pdu={l.name} style={{ height: `${ROW_EM.load}em` }}>
                  <span className="ld-load-name"><strong dir="auto">{l.name}</strong></span>
                  <span className="ld-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                  <span className="ld-load-value">
                    {down ? <b>{l.state === "offline" ? "Unreachable" : "No reading"}</b>
                      : l.state === "loading" ? "Reading…"
                      : <>{l.watts == null ? "—" : `${formatKw(l.watts)} kW`}<b>{l.pct == null ? "—" : `${formatNumber(l.pct, 0)}%`}</b></>}
                  </span>
                </li>
              );
            })}
          </ul>}
      </div>
    </section>
  );
}

function InUsePanel({ rows, kvmTotal, rotation, stale }) {
  const [ref, box] = useBox();
  const perPage = rowsThatFit(box.height, ROW_EM.inUse * box.em, LIST_GAP_EM * box.em);
  const { items, page, pages } = pageOf(rows, perPage, rotation.tick);
  return (
    <section className="ld-panel ld-inuse" aria-label="Working now">
      <PanelHead title="Working now" count={stale ? null : rows.length} note="Remote consoles open"
        pager={stale ? null : <Pager more={rows.length - items.length} page={page} pages={pages} rotation={rotation} />} />
      <div ref={ref} className="ld-panel-body">
        {stale ? <p className="ld-empty" data-testid="inuse-unknown">Unknown while the display is not live</p>
          : rows.length === 0 ? <p className="ld-empty">{kvmTotal ? "No remote consoles are open." : "No KVMs are set up."}</p> :
          <ul className="ld-list" style={{ gap: `${LIST_GAP_EM}em` }}>
            {items.map(r => (
              <li key={r.key} className="ld-inuse-row" style={{ height: `${ROW_EM.inUse}em` }}>
                <strong dir="auto">{r.server}</strong><span><bdi dir="auto">{r.kvm}</bdi> · port {r.port}</span>
              </li>
            ))}
          </ul>}
      </div>
    </section>
  );
}

function ChangesStrip({ rows, rotation }) {
  const [ref, box] = useBox();
  // A row of changes across the strip, newest first; more than fit turn pages.
  const perPage = Math.max(1, Math.floor(box.width / (TICKER_ITEM_EM * box.em)) || 1);
  const { items, page, pages } = pageOf(rows, perPage, rotation.tick);
  return (
    <footer className="ld-changes" aria-label="Recent changes">
      <h2>Recent</h2>
      <div ref={ref} className="ld-changes-body" style={{ height: `${ROW_EM.ticker}em` }}>
        {rows.length === 0 ? <span className="ld-muted">No maintenance or ping changes recorded recently.</span> :
          <ul style={{ gridTemplateColumns: `repeat(${perPage}, minmax(0, 1fr))` }}>
            {items.map(r => (
              <li key={r.key} data-level={r.kind}><time dateTime={new Date(r.at).toISOString()}>{changeTime(r.at)}</time><span dir="auto"><Parts parts={r.parts} /></span></li>
            ))}
          </ul>}
      </div>
      <Pager more={rows.length - items.length} page={page} pages={pages} rotation={rotation} />
    </footer>
  );
}
