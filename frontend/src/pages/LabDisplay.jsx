// Lab display (?tab=display): a read-only full-screen page for the wall TV at the lab entrance. It only reads (GET)
// what a Viewer may read, refreshes every 15 s without blanking (the last good data stays up; after 60 s without data
// a NOT LIVE banner covers the top and the panels turn grey), recovers by itself after a network loss, never scrolls
// (long lists and the rack grid turn pages every 10 s, alarms stay pinned) and has no buttons, dialogs, assistant or
// footer. Laid out for a 24-inch monitor at the lab entrance (1920 x 1080, or 1536 x 864 at 125 % scaling) read from
// 2-3 m: every size follows the screen, so larger and smaller 16:9 screens show the same layout. Helpers and
// thresholds: ../labDisplay.js.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAccounts } from "../accounts";
import nvidiaLogo from "../assets/nvidia-logo.svg";
import {
  REFRESH_MS, STALE_MS, STALE_ALARM_MS, ROTATE_MS, REQUEST_TIMEOUT_MS, OVERRIDES_EVERY, INCIDENT_LIMIT, ROW_EM,
  LIST_GAP_EM, STRIP_ITEM_EM,
  buildServers, buildRacks, environment, kpis, attentionItems, consolesInUse, recentChanges, maintenanceEntries,
  rackGrid, fillRows, pageOf, pinnedPage, labStatus, sourceAfter, relativeAge, formatKw, formatRange,
  clockTime, longDate, changeTime, connectionState, pruneStatuses, withTimeout, partsText,
} from "../labDisplay";

const LAB_NAME = "Lab 204";
const LAB_PLACE = "Yokneam";
const EMPTY = { devices: [], pduStatuses: {}, kvmStatuses: {}, maintenance: null, monitoring: null, incidents: null, rackOverrides: {} };
// Burn-in care for a screen that runs all day: every 5 minutes the whole layout moves by 0-4 px.
const SHIFT_MS = 5 * 60_000;
const SHIFT_PX = 4;
// Narrower than this, or portrait: a notice instead of the display (it is laid out for a landscape TV).
const NARROW_QUERY = "(max-width: 899px), (orientation: portrait)";

async function getJson(path, signal) {
  const response = await fetch(path, { cache: "no-store", signal });
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
// and is then "unknown" (sources[name].state), never an old copy shown as current. Every request is aborted when it
// takes longer than REQUEST_TIMEOUT_MS and when the page goes away (withTimeout), so a hung server never piles up
// open connections.
function useLabFeed() {
  const [feed, setFeed] = useState({ data: EMPTY, sources: {}, loaded: false, state: "connecting", lastSuccess: 0, error: "" });
  useEffect(() => {
    let alive = true, busy = false, timer = null, cycle = 0;
    const stop = new AbortController();
    const timed = request => withTimeout(request, { ms: REQUEST_TIMEOUT_MS, stop: stop.signal });
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
        const list = await timed(signal => api.getDevices({ signal }));
        if (!alive) return;
        const devices = Array.isArray(list) ? list : [];
        const pdus = devices.filter(d => d.kind === "pdu");
        const kvms = devices.filter(d => d.kind === "kvm");
        const readOverrides = n % OVERRIDES_EVERY === 0 || !sources.overrides;
        const [pduRes, kvmRes, maintenance, monitoring, incidents, overrides] = await Promise.all([
          Promise.allSettled(pdus.map(p => timed(signal => api.getPduStatus(p.id, { signal })))),
          Promise.allSettled(kvms.map(k => timed(signal => api.getKvmStatus(k.id, { signal })))),
          settle(timed(signal => api.maintenanceList({ signal }))),
          settle(timed(signal => getJson("/api/monitoring", signal))),
          settle(timed(signal => getJson(`/api/monitoring/incidents?limit=${INCIDENT_LIMIT}`, signal))),
          readOverrides ? settle(timed(signal => getJson("/api/rack-overrides", signal))) : Promise.resolve(null),
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
      stop.abort();
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
          {/* Two halves: the racks on the left, what needs a look on the right. A PDU near its rating shows on its rack
              card and in Attention (no per-PDU panel: too small to read from the door). */}
          <main className="ld-main" aria-label="Lab status">
            <RacksPanel racks={view.racks} rotation={rotation} />
            <AttentionPanel items={view.attention} rotation={rotation} />
          </main>
          {/* One line each along the bottom: who is working now, and what changed recently. */}
          <footer className="ld-bottom">
            <InUseStrip rows={view.inUse} kvmTotal={view.kpi.kvms.total} rotation={rotation} stale={stale} />
            <ChangesStrip rows={view.changes} rotation={rotation} />
          </footer>
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
// does. The CSS size (min(5em, 34cqi)) already fits the usual values; this covers the rest.
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

// Free text too long for its line (an Attention title, a maintenance reason, a rack name) is drawn smaller, step by
// step, down to FIT_MIN_EM of the screen's base size (2em: 32 px at 1920 x 1080, the smallest text on the screen); only
// what still does not fit then ends in "…" (CSS), at the text's own end: the line takes the text's direction (dir="auto"
// on the line itself, or textDir when the text sits in <bdi> parts), so Hebrew keeps its first words. It is measured
// before paint, once per `key` (the text, and what shares its line: the MAINT badge beside a rack name, the maintenance
// entry beside a reason), and again whenever the element's own width or its line's width changes: a neighbour that
// appears or grows narrows it (smaller again), one that goes away widens it (back up towards the normal size). A
// refresh that changes nothing changes nothing on screen, and a fit never measures again because of its own size
// change (the widths are taken after the fit), so it never loops. It never wraps.
const FIT_MIN_EM = 2;
const FIT_STEP_PX = 0.5;
function useShrinkToFit(key, minEm = FIT_MIN_EM) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return undefined;
    let widths = "";
    let alive = true;
    const shrink = () => {
      el.style.fontSize = "";
      if (el.scrollWidth <= el.clientWidth) return;
      const base = parseFloat(getComputedStyle(el.closest(".lab-display") || el).fontSize) || 16;
      const floor = Math.round(minEm * base * 10) / 10;
      let px = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (px <= floor) return;
      // First the size the width ratio implies, then smaller steps until it fits or reaches the floor.
      px = Math.max(floor, Math.floor(px * (el.clientWidth / el.scrollWidth) * 10) / 10);
      el.style.fontSize = `${px}px`;
      while (px > floor && el.scrollWidth > el.clientWidth) {
        px = Math.max(floor, Math.round((px - FIT_STEP_PX) * 10) / 10);
        el.style.fontSize = `${px}px`;
      }
    };
    const now = () => `${box.clientWidth}|${el.clientWidth}`;
    // Both widths are taken after the fit: the fit's own change of size is not a reason to fit again.
    const fit = force => {
      if (!alive || (!force && now() === widths)) return;
      shrink();
      widths = now();
    };
    fit(true);
    const observer = new ResizeObserver(() => fit(false));
    observer.observe(box);
    observer.observe(el);
    // A web font that arrives late changes the text's width, not the line's.
    document.fonts?.ready?.then(() => fit(true));
    return () => { alive = false; observer.disconnect(); };
  }, [key, minEm]);
  return ref;
}

// The direction of a line from its first letter that has one (Hebrew / Arabic: rtl, Latin: ltr), as dir="auto" would
// find it; for a line whose text is all inside <bdi> parts, where dir="auto" on the line itself finds no letter.
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const LTR_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
function textDir(text) {
  for (const ch of String(text || "")) {
    if (RTL_LETTER.test(ch)) return "rtl";
    if (LTR_LETTER.test(ch)) return "ltr";
  }
  return "auto";
}

// One line of free text that shrinks to fit (useShrinkToFit); `text` is what it says, children what it shows (by
// default the text); the measure runs again when the text or `fitKey` (what shares its line) changes.
function FitText({ as: Tag = "span", text, fitKey = "", className, dir, children }) {
  const ref = useShrinkToFit(`${text}|${fitKey}`);
  return <Tag ref={ref} className={className} dir={dir}>{children ?? text}</Tag>;
}

// Three lines, the same on every tile: the label, the number, then the status word (CHECK / ALARM / PARTIAL) when
// there is one, else a short line of detail. The word never shares a line with the number, so it never squeezes it.
function Tile({ label, value, unit, sub, level = "idle", testId, chip }) {
  const fitRef = useFitWidth(`${value}|${unit}|${level}`);
  return (
    <section className="ld-tile" data-level={level} data-testid={testId} aria-label={label}>
      <h2>{label}</h2>
      <div className="ld-tile-row">
        <p ref={fitRef} className="ld-tile-value">{value}{unit && <small>{unit}</small>}</p>
      </div>
      <p className="ld-tile-foot">
        {chip || CHIP[level] ? <Chip level={level} testId={`${testId}-chip`} text={chip} /> : <span className="ld-tile-sub">{sub}</span>}
      </p>
    </section>
  );
}

function Kpis({ view }) {
  const { kpi, env } = view;
  const s = kpi.servers;
  const pdusDown = kpi.pdus.read - kpi.pdus.reachable;
  const kvmsDown = kpi.kvms.read - kpi.kvms.reachable;
  const envLevel = env.hasSensors ? env.level : "idle";
  return (
    <div className="ld-kpis">
      {/* Servers switched off are a normal state: counted under Servers on, not a tile of their own. */}
      <Tile testId="kpi-on" label="Servers on" value={s.on} level={s.total ? "ok" : "idle"} sub={`of ${s.total} · ${s.off} off`} />
      <Tile testId="kpi-noreading" label="No reading" value={s.noReading} level={s.noReading ? "warn" : "idle"} sub="Every server read" />
      <Tile testId="kpi-pdus" label="PDUs online" value={kpi.pdus.reachable} unit={` / ${kpi.pdus.total}`}
        level={!kpi.pdus.total ? "idle" : pdusDown > 0 ? "alarm" : "ok"}
        sub={pdusDown > 0 ? `${pdusDown} unreachable` : kpi.pdus.maintenance ? `${kpi.pdus.maintenance} in maintenance` : kpi.pdus.total ? "All answering" : "No PDUs"} />
      <Tile testId="kpi-kvms" label="KVMs online" value={kpi.kvms.reachable} unit={` / ${kpi.kvms.total}`}
        level={!kpi.kvms.total ? "idle" : kvmsDown > 0 ? "warn" : "ok"}
        sub={kvmsDown > 0 ? `${kvmsDown} unreachable` : view.inUse.length ? `${view.inUse.length} ${view.inUse.length === 1 ? "console" : "consoles"} open` : kpi.kvms.total ? "All answering" : "No KVMs"} />
      <Tile testId="kpi-power" label="Total power" value={formatKw(kpi.power.watts)} unit={kpi.power.watts == null ? "" : " kW"}
        // A total in kW is neither healthy nor unhealthy: neutral, or PARTIAL when some PDUs gave no reading.
        level={kpi.power.watts == null ? "idle" : kpi.power.complete ? "neutral" : "warn"} chip={kpi.power.watts != null && !kpi.power.complete ? "PARTIAL" : undefined}
        sub={kpi.power.watts == null ? "No PDU reading" : `${kpi.pdus.total} ${kpi.pdus.total === 1 ? "PDU" : "PDUs"}`} />
      <section className="ld-tile ld-env" data-level={envLevel} data-testid="kpi-env" aria-label="Environment">
        <h2>Environment <Chip level={envLevel} testId="kpi-env-chip" /></h2>
        {env.hasSensors ? <dl>
          <div data-level={env.tempLevel}><dt>Temp</dt><dd>{formatRange(env.tempMin, env.tempMax, env.tempMin === env.tempMax ? 1 : 0)}<small> °C</small></dd></div>
          <div data-level={env.humLevel}><dt>Humidity</dt><dd>{formatRange(env.humMin, env.humMax, 0)}<small> %</small></dd></div>
          <div data-level={env.leakLevel}><dt>Leak</dt><dd>{env.leakSensors ? env.leak ? "YES" : "None" : "—"}</dd></div>
        </dl> : <><p className="ld-tile-value ld-muted">—</p><p className="ld-tile-foot"><span className="ld-tile-sub">No sensors reporting</span></p></>}
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
        <span className="ld-maint-text"><span className="ld-maint-where">Maintenance status unavailable since {clockTime(source.since)}</span></span>
      </div>
    );
  }
  if (!entries.length) return null;
  const { items: [entry], page, pages } = pageOf(entries, 1, rotation.tick);
  // Where, when and who, then the reason in a box of its own: a reason too long for the line loses its last words
  // (its own end, also in Hebrew), never its first ones or the where / who.
  return (
    <div className="ld-maint-band" data-level="maint" data-testid="maint-band" role="status">
      <strong className="ld-maint-label">MAINTENANCE</strong>
      <span className="ld-maint-text">
        <span className="ld-maint-where"><Parts parts={entry.head || entry.parts} /></span>
        {entry.head && entry.reason && <><span className="ld-maint-sep" aria-hidden="true">·</span><FitText as="bdi" dir="auto" className="ld-maint-why" text={entry.reason} fitKey={`${entry.key}|${partsText(entry.head)}`} /></>}
      </span>
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

function PanelHead({ title, count, pager }) {
  return (
    <div className="ld-panel-head">
      <h2>{title}{count != null && <span className="ld-count">{count}</span>}</h2>
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
              const counted = !r.storage && r.total > 0;
              const badge = !layout.compact && r.maintenancePdus.length > 0;
              const servers = !counted ? !layout.compact && <p className="ld-rack-servers">{r.storage ? "Storage" : "No servers"}</p>
                : unknown ? <p className="ld-rack-servers" data-unknown="true"><strong>—</strong><span> / {r.total}</span></p>
                : <p className="ld-rack-servers"><strong>{r.on}</strong><span> / {r.total}{layout.compact ? "" : " on"}</span></p>;
              return (
                <article key={r.rack} className="ld-rack" data-level={r.level} data-rack={r.rack}>
                  {/* Line 1: the name (the whole line, or beside MAINT; a compact card adds on / total). Line 2: servers
                      on / total and the rack's power on one baseline. Line 3: its state. */}
                  <div className="ld-rack-head">
                    <FitText as="h3" dir="auto" text={r.rack} fitKey={`${badge}|${layout.compact ? `${r.on}/${r.total}/${unknown}` : ""}`} />
                    {badge && <span className="ld-badge" data-level="maint">Maint</span>}
                    {layout.compact && servers}
                  </div>
                  {!layout.compact && <div className="ld-rack-line">
                    {servers}
                    {counted && !unknown && <p className="ld-rack-power">{r.watts == null ? "— kW" : `${formatKw(r.watts)} kW`}</p>}
                  </div>}
                  {/* A compact card has no room for a sentence: storage and empty racks say so in the state line. */}
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
  // As many rows as fit; a full page shares the panel's height among them, so the list ends at the panel's bottom.
  const { rows, rowH } = fillRows(box.height, ROW_EM.attention * box.em, LIST_GAP_EM * box.em, items.length);
  const { items: shown, moreAlarms, more, page, pages } = pinnedPage(items, rows, rotation.tick);
  const alarms = items.filter(i => i.severity === "alarm").length;
  const height = box.height ? `${rowH}px` : `${ROW_EM.attention}em`;
  return (
    <section className="ld-panel ld-attention" aria-label="Attention" data-level={alarms ? "alarm" : items.length ? "warn" : "ok"}>
      <PanelHead title="Attention" count={items.length} pager={<Pager more={more} page={page} pages={pages} rotation={rotation} />} />
      <div ref={ref} className="ld-panel-body">
        {items.length === 0 ? <p className="ld-allclear"><i aria-hidden="true" />All clear: nothing needs a look.</p> :
          <ul className="ld-list ld-attn-list" style={{ gap: `${LIST_GAP_EM}em` }}>
            {shown.map(item => (
              <li key={item.key} className="ld-attn" data-level={item.severity} data-kind={item.kind} style={{ height }}>
                <span className="ld-attn-tag">{SEVERITY_TEXT[item.severity]}</span>
                <span className="ld-attn-text"><FitText as="strong" dir={textDir(item.title)} text={item.title}><Parts parts={item.titleParts} /></FitText><span dir="auto"><Parts parts={item.parts} /></span></span>
              </li>
            ))}
            {/* The same count as the pager above ("+N more"), with how many of them are alarms. */}
            {moreAlarms > 0 && <li className="ld-attn ld-attn-more" data-level="alarm" style={{ height }}>
              <span className="ld-attn-tag">Alarm</span>
              <span className="ld-attn-more-text">+{more} more{more > moreAlarms ? ` · ${moreAlarms}` : ""} {moreAlarms === 1 ? "alarm" : "alarms"}</span>
            </li>}
          </ul>}
      </div>
    </section>
  );
}

// Who is working now: the remote consoles open from this site, one line; more than fit turn pages.
function InUseStrip({ rows, kvmTotal, rotation, stale }) {
  const [ref, box] = useBox();
  const perPage = Math.max(1, Math.floor(box.width / (STRIP_ITEM_EM.inUse * box.em)) || 1);
  const { items, page, pages } = pageOf(rows, perPage, rotation.tick);
  return (
    <section className="ld-strip ld-inuse" aria-label="Working now">
      <h2>Working now{!stale && <span className="ld-count">{rows.length}</span>}</h2>
      <div ref={ref} className="ld-strip-body" style={{ height: `${ROW_EM.strip}em` }}>
        {stale ? <span className="ld-muted" data-testid="inuse-unknown">Unknown while the display is not live</span>
          : rows.length === 0 ? <span className="ld-muted">{kvmTotal ? "No remote consoles open" : "No KVMs are set up"}</span> :
          <ul style={{ gridTemplateColumns: `repeat(${perPage}, minmax(0, 1fr))` }}>
            {items.map(r => (
              <li key={r.key}><strong dir="auto">{r.server}</strong><span><bdi dir="auto">{r.kvm}</bdi> · port {r.port}</span></li>
            ))}
          </ul>}
      </div>
      {!stale && <Pager more={rows.length - items.length} page={page} pages={pages} rotation={rotation} />}
    </section>
  );
}

function ChangesStrip({ rows, rotation }) {
  const [ref, box] = useBox();
  // Changes across the strip, newest first; more than fit turn pages.
  const perPage = Math.max(1, Math.floor(box.width / (STRIP_ITEM_EM.changes * box.em)) || 1);
  const { items, page, pages } = pageOf(rows, perPage, rotation.tick);
  return (
    <section className="ld-strip ld-changes" aria-label="Recent changes">
      <h2>Recent</h2>
      <div ref={ref} className="ld-strip-body" style={{ height: `${ROW_EM.strip}em` }}>
        {rows.length === 0 ? <span className="ld-muted">No recent maintenance or ping changes</span> :
          <ul style={{ gridTemplateColumns: `repeat(${perPage}, minmax(0, 1fr))` }}>
            {items.map(r => (
              <li key={r.key} data-level={r.kind}><time dateTime={new Date(r.at).toISOString()}>{changeTime(r.at)}</time><span dir="auto"><Parts parts={r.parts} /></span></li>
            ))}
          </ul>}
      </div>
      <Pager more={rows.length - items.length} page={page} pages={pages} rotation={rotation} />
    </section>
  );
}
