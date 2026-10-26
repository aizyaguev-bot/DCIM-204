// Lab display (?tab=display): a read-only full-screen page for the wall TV at the lab entrance. It only reads (GET)
// what a Viewer may read, refreshes every 15 s without blanking (the last good data stays up, with a stale badge after
// 60 s), recovers by itself after a network loss, never scrolls (long lists and the rack grid turn pages every 10 s)
// and has no buttons, dialogs, assistant or footer. Helpers and thresholds: ../labDisplay.js.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import nvidiaLogo from "../assets/nvidia-logo.svg";
import {
  REFRESH_MS, STALE_MS, ROTATE_MS, REQUEST_TIMEOUT_MS, OVERRIDES_EVERY, INCIDENT_LIMIT, ROW_EM, RACK_CARD_EM, LIST_GAP_EM,
  LOAD_COL_EM, TICKER_ITEM_EM,
  TEMP_WARN_C, TEMP_ALARM_C, HUMIDITY_WARN, RATED_AMPS,
  buildServers, buildRacks, environment, kpis, attentionItems, consolesInUse, recentChanges,
  gridLayout, rowsThatFit, pageOf, relativeAge, formatNumber, formatKw, formatRange, clockTime, longDate, changeTime,
  connectionState, pruneStatuses,
} from "../labDisplay";

const LAB_NAME = "Lab 204";
const LAB_PLACE = "Yokneam";
const EMPTY = { devices: [], pduStatuses: {}, kvmStatuses: {}, maintenance: null, monitoring: null, incidents: null, rackOverrides: {} };

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
// A source the server does not offer (older backend: 404) or does not allow (403) is left out; any other failure keeps
// the last good copy until the next cycle.
const keepOr = (result, previous) => (result.ok ? result.value : result.status === 404 || result.status === 403 ? null : previous);

// The data cycle: one at a time (a slow server never stacks requests), every REFRESH_MS after the last one finished,
// at once when the network comes back or the tab becomes visible, paused while the tab is hidden.
function useLabFeed() {
  const [feed, setFeed] = useState({ data: EMPTY, loaded: false, state: "connecting", lastSuccess: 0, error: "" });
  useEffect(() => {
    let alive = true, busy = false, timer = null, cycle = 0;
    let data = EMPTY;
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
        const [pduRes, kvmRes, maintenance, monitoring, incidents, overrides] = await Promise.all([
          Promise.allSettled(pdus.map(p => withTimeout(api.getPduStatus(p.id)))),
          Promise.allSettled(kvms.map(k => withTimeout(api.getKvmStatus(k.id)))),
          settle(withTimeout(api.maintenanceList())),
          settle(withTimeout(getJson("/api/monitoring"))),
          settle(withTimeout(getJson(`/api/monitoring/incidents?limit=${INCIDENT_LIMIT}`))),
          n % OVERRIDES_EVERY === 0 ? settle(withTimeout(getJson("/api/rack-overrides"))) : Promise.resolve(null),
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
        data = {
          devices,
          pduStatuses: merge(pdus, pduRes, data.pduStatuses, { outlets: [] }),
          kvmStatuses: merge(kvms, kvmRes, data.kvmStatuses, { ports: [] }),
          maintenance: keepOr(maintenance, data.maintenance),
          monitoring: keepOr(monitoring, data.monitoring),
          incidents: keepOr(incidents, data.incidents),
          rackOverrides: overrides ? (overrides.ok && overrides.value && typeof overrides.value === "object" ? overrides.value : overrides.status === 404 || overrides.status === 403 ? {} : data.rackOverrides) : data.rackOverrides,
        };
        setFeed({ data, loaded: true, state: "online", lastSuccess: now, error: "" });
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

export default function LabDisplay() {
  const rootRef = useRef(null);
  const feed = useLabFeed();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => (t + 1) % 1_000_000), ROTATE_MS);
    return () => clearInterval(timer);
  }, []);
  useScreenSetup(rootRef);

  const view = useMemo(() => {
    const { data } = feed;
    const pdus = data.devices.filter(d => d.kind === "pdu");
    const servers = buildServers(pdus, data.pduStatuses, data.rackOverrides);
    const env = environment(pdus, data.pduStatuses);
    return {
      env,
      kpi: kpis({ ...data, servers }),
      racks: buildRacks(data.devices, data.pduStatuses, servers, data.maintenance),
      attention: attentionItems({ ...data, env, now: feed.lastSuccess || Date.now() }),
      inUse: consolesInUse(data.devices, data.kvmStatuses),
      changes: recentChanges(data),
    };
  }, [feed.data, feed.lastSuccess]);

  // Stale is re-checked on every rotation step (10 s); the header line counts the seconds on its own.
  const stale = feed.lastSuccess > 0 && Date.now() - feed.lastSuccess > STALE_MS;

  return (
    <div ref={rootRef} className="lab-display" data-loaded={feed.loaded ? "true" : "false"} data-stale={stale ? "true" : "false"} data-connection={feed.state}>
      <TopBar feed={feed} />
      {!feed.loaded
        ? <FirstLoad feed={feed} />
        : <>
          <Kpis view={view} />
          <main className="ld-main" aria-label="Lab status">
            <div className="ld-column">
              <RacksPanel racks={view.racks} tick={tick} />
              <LoadPanel loads={view.kpi.loads} tick={tick} />
            </div>
            <div className="ld-column ld-side">
              <AttentionPanel items={view.attention} tick={tick} />
              <InUsePanel rows={view.inUse} kvmTotal={view.kpi.kvms.total} tick={tick} />
            </div>
          </main>
          <ChangesStrip rows={view.changes} tick={tick} />
        </>}
    </div>
  );
}

function TopBar({ feed }) {
  const now = useNow(1000);
  const conn = connectionState({ state: feed.state, lastSuccess: feed.lastSuccess, now });
  const updated = feed.lastSuccess ? `Updated ${relativeAge(now - feed.lastSuccess)}` : "Waiting for the first reading";
  return (
    <header className="ld-top">
      <div className="ld-brand">
        <img src={nvidiaLogo} alt="NVIDIA" />
        <span className="ld-brand-rule" aria-hidden="true" />
        <div>
          <h1>{LAB_NAME} <span>· {LAB_PLACE}</span></h1>
          <p>Lab Manager · live status</p>
        </div>
      </div>
      <div className="ld-conn" data-level={conn.level}>
        <span className="ld-conn-state" role="status"><i aria-hidden="true" />{conn.text}</span>
        <span className="ld-conn-updated">{updated}</span>
        {conn.stale && <span className="ld-stale" data-testid="stale-badge">Stale data · {feed.state === "online" ? "not refreshed" : "Lab Manager is not answering"}</span>}
      </div>
      <div className="ld-clock">
        <time className="ld-clock-time" dateTime={new Date(now).toISOString()}>{clockTime(now)}<small>:{String(new Date(now).getSeconds()).padStart(2, "0")}</small></time>
        <span className="ld-clock-date">{longDate(now)}</span>
      </div>
    </header>
  );
}

function FirstLoad({ feed }) {
  const text = feed.state === "signed-out" ? "Sign in with a Lab Manager account (Viewer is enough) to show the lab display."
    : feed.state === "offline" ? `Lab Manager is not answering (${feed.error || "no connection"}). Retrying every ${REFRESH_MS / 1000} s.`
    : "Connecting to Lab Manager…";
  return <main className="ld-first" aria-label="Lab status"><p role="status">{text}</p></main>;
}

function Tile({ label, value, unit, sub, level = "idle", testId, children }) {
  return (
    <section className="ld-tile" data-level={level} data-testid={testId} aria-label={label}>
      <h2>{label}</h2>
      <p className="ld-tile-value">{value}{unit && <small>{unit}</small>}</p>
      {children || <p className="ld-tile-sub">{sub}</p>}
    </section>
  );
}

function Kpis({ view }) {
  const { kpi, env } = view;
  const s = kpi.servers;
  const pdusDown = kpi.pdus.read - kpi.pdus.reachable;
  const kvmsDown = kpi.kvms.read - kpi.kvms.reachable;
  const missing = kpi.pdus.total - kpi.power.known;
  return (
    <div className="ld-kpis">
      <Tile testId="kpi-on" label="Servers on" value={s.on} level={s.total ? "ok" : "idle"} sub={`of ${s.total} servers`} />
      <Tile testId="kpi-off" label="Servers off" value={s.off} level={s.off ? "neutral" : "idle"} sub="Outlet switched off" />
      <Tile testId="kpi-noreading" label="No reading" value={s.noReading} level={s.noReading ? "warn" : "idle"} sub="Power state unknown" />
      <Tile testId="kpi-pdus" label="PDUs reachable" value={kpi.pdus.reachable} unit={` / ${kpi.pdus.total}`}
        level={!kpi.pdus.total ? "idle" : pdusDown > 0 ? "alarm" : "ok"}
        sub={pdusDown > 0 ? `${pdusDown} unreachable` : kpi.pdus.maintenance ? `${kpi.pdus.maintenance} in maintenance` : kpi.pdus.total ? "All answering" : "No PDUs"} />
      <Tile testId="kpi-kvms" label="KVMs reachable" value={kpi.kvms.reachable} unit={` / ${kpi.kvms.total}`}
        level={!kpi.kvms.total ? "idle" : kvmsDown > 0 ? "warn" : "ok"}
        sub={kvmsDown > 0 ? `${kvmsDown} unreachable` : view.inUse.length ? `${view.inUse.length} ${view.inUse.length === 1 ? "console" : "consoles"} open` : kpi.kvms.total ? "All answering" : "No KVMs"} />
      <Tile testId="kpi-power" label="Total power" value={formatKw(kpi.power.watts)} unit={kpi.power.watts == null ? "" : " kW"}
        level={kpi.power.watts == null ? "idle" : "ok"}
        sub={kpi.power.watts == null ? "No PDU reading" : kpi.power.complete ? `${kpi.pdus.total} ${kpi.pdus.total === 1 ? "PDU" : "PDUs"}` : missing > 0 ? `Partial · ${kpi.power.known} of ${kpi.pdus.total} PDUs` : "Partial reading"} />
      <section className="ld-tile ld-env" data-level={env.hasSensors ? env.level : "idle"} data-testid="kpi-env" aria-label="Environment">
        <h2>Environment</h2>
        {env.hasSensors ? <dl>
          <div data-level={env.tempLevel}><dt>Temp</dt><dd>{formatRange(env.tempMin, env.tempMax, env.tempMin === env.tempMax ? 1 : 0)}<small> °C</small></dd></div>
          <div data-level={env.humLevel}><dt>Humidity</dt><dd>{formatRange(env.humMin, env.humMax, 0)}<small> %</small></dd></div>
          <div data-level={env.leakLevel}><dt>Leak</dt><dd>{env.leakSensors ? env.leak ? "YES" : "None" : "—"}</dd></div>
        </dl> : <><p className="ld-tile-value ld-muted">—</p><p className="ld-tile-sub">No PDU sensors reporting</p></>}
        <p className="ld-env-limits">Warn &gt; {TEMP_WARN_C} °C · alarm &gt; {TEMP_ALARM_C} °C · humidity &gt; {HUMIDITY_WARN} %</p>
      </section>
    </div>
  );
}

function Pager({ page, pages }) {
  if (pages <= 1) return null;
  return (
    <span className="ld-pager">
      <span className="ld-pager-text"><span className="sr-only">Page </span>{page + 1} / {pages}</span>
      <span className="ld-pager-dots" aria-hidden="true">{Array.from({ length: Math.min(pages, 12) }, (_, i) => <i key={i} data-on={i === page ? "true" : undefined} />)}</span>
    </span>
  );
}

function PanelHead({ title, count, page, pages, note }) {
  return (
    <div className="ld-panel-head">
      <h2>{title}{count != null && <span className="ld-count">{count}</span>}</h2>
      {note && <span className="ld-panel-note">{note}</span>}
      <Pager page={page} pages={pages} />
    </div>
  );
}

const RACK_TEXT = { offline: "Unreachable", unavailable: "No reading", loading: "Reading…", "no-pdu": "No PDU", storage: "" };

function RacksPanel({ racks, tick }) {
  const [ref, box] = useBox();
  const em = box.em;
  const layout = gridLayout(racks.length, box.width, box.height, {
    minW: RACK_CARD_EM.minW * em, minH: RACK_CARD_EM.minH * em, maxH: RACK_CARD_EM.maxH * em, gap: RACK_CARD_EM.gap * em,
  });
  const { items, page, pages } = pageOf(racks, layout.perPage, tick);
  return (
    <section className="ld-panel ld-racks" aria-label="Racks">
      <PanelHead title="Racks" count={racks.length} page={page} pages={pages} />
      <div ref={ref} className="ld-panel-body">
        {racks.length === 0 ? <p className="ld-empty">No racks are set up yet.</p> :
          <div className="ld-rack-grid" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, gridAutoRows: `${layout.cellH}px`, gap: `${RACK_CARD_EM.gap}em` }}>
            {items.map(r => {
              const text = r.status === "online" ? (r.noReading ? `${r.noReading} no reading` : "Online") : RACK_TEXT[r.status] ?? r.statusText;
              return (
                <article key={r.rack} className="ld-rack" data-level={r.level} data-rack={r.rack}>
                  <div className="ld-rack-head">
                    <h3>{r.rack}</h3>
                    {r.maintenancePdus.length > 0 && <span className="ld-badge" data-level="maint" title={`In maintenance: ${r.maintenancePdus.join(", ")}`}>Maint</span>}
                  </div>
                  {r.storage || r.total === 0 ? <p className="ld-rack-servers ld-muted">{r.storage ? "Equipment storage" : "No servers"}</p> :
                    <p className="ld-rack-servers"><strong>{r.on}</strong><span> / {r.total} on</span></p>}
                  <p className="ld-rack-foot">
                    <span className="ld-rack-state">{text}</span>
                    {!r.storage && <span>{r.watts == null ? "—" : `${formatKw(r.watts)} kW`}{r.off > 0 ? ` · ${r.off} off` : ""}</span>}
                  </p>
                </article>
              );
            })}
          </div>}
      </div>
    </section>
  );
}

const SEVERITY_TEXT = { alarm: "Alarm", warn: "Warning", info: "Info" };

function AttentionPanel({ items, tick }) {
  const [ref, box] = useBox();
  const perPage = rowsThatFit(box.height, ROW_EM.attention * box.em, LIST_GAP_EM * box.em);
  const { items: shown, page, pages } = pageOf(items, perPage, tick);
  const alarms = items.filter(i => i.severity === "alarm").length;
  return (
    <section className="ld-panel ld-attention" aria-label="Attention" data-level={alarms ? "alarm" : items.length ? "warn" : "ok"}>
      <PanelHead title="Attention" count={items.length} page={page} pages={pages} />
      <div ref={ref} className="ld-panel-body">
        {items.length === 0 ? <p className="ld-allclear"><i aria-hidden="true" />All clear: every device answers and nothing needs a look.</p> :
          <ul className="ld-list" style={{ gap: `${LIST_GAP_EM}em` }}>
            {shown.map(item => (
              <li key={item.key} className="ld-attn" data-level={item.severity} data-kind={item.kind} style={{ height: `${ROW_EM.attention}em` }}>
                <span className="ld-attn-tag">{SEVERITY_TEXT[item.severity]}</span>
                <span className="ld-attn-text"><strong>{item.title}</strong><span>{item.detail}</span></span>
              </li>
            ))}
          </ul>}
      </div>
    </section>
  );
}

function LoadPanel({ loads, tick }) {
  const [ref, box] = useBox();
  // Two columns of PDUs when the panel is wide enough for two readable rows side by side.
  const cols = box.width >= 2 * LOAD_COL_EM * box.em ? 2 : 1;
  const perPage = cols * rowsThatFit(box.height, ROW_EM.load * box.em, LIST_GAP_EM * box.em);
  const { items, page, pages } = pageOf(loads, perPage, tick);
  return (
    <section className="ld-panel ld-load" aria-label="Power by PDU">
      <PanelHead title="Power by PDU" page={page} pages={pages} note={`Load vs ${RATED_AMPS} A`} />
      <div ref={ref} className="ld-panel-body">
        {loads.length === 0 ? <p className="ld-empty">No PDUs are set up.</p> :
          <ul className="ld-list ld-load-list" style={{ gap: `${LIST_GAP_EM}em 2.4em`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {items.map(l => {
              const down = l.state === "offline" || l.state === "unavailable";
              const pct = l.pct == null ? 0 : Math.max(0, Math.min(100, l.pct));
              return (
                <li key={l.id} className="ld-loadrow" data-level={l.level} data-pdu={l.name} style={{ height: `${ROW_EM.load}em` }}>
                  <span className="ld-load-name"><strong>{l.name}</strong>{l.rack && <span>{l.rack}</span>}</span>
                  <span className="ld-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                  <span className="ld-load-value">
                    {down ? (l.state === "offline" ? "Unreachable" : "No reading")
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

function InUsePanel({ rows, kvmTotal, tick }) {
  const [ref, box] = useBox();
  const perPage = rowsThatFit(box.height, ROW_EM.inUse * box.em, LIST_GAP_EM * box.em);
  const { items, page, pages } = pageOf(rows, perPage, tick);
  return (
    <section className="ld-panel ld-inuse" aria-label="Working now">
      <PanelHead title="Working now" count={rows.length} page={page} pages={pages} note="Remote consoles open" />
      <div ref={ref} className="ld-panel-body">
        {rows.length === 0 ? <p className="ld-empty">{kvmTotal ? "No remote consoles are open." : "No KVMs are set up."}</p> :
          <ul className="ld-list" style={{ gap: `${LIST_GAP_EM}em` }}>
            {items.map(r => (
              <li key={r.key} className="ld-inuse-row" style={{ height: `${ROW_EM.inUse}em` }}>
                <strong>{r.server}</strong><span>{r.kvm} · port {r.port}</span>
              </li>
            ))}
          </ul>}
      </div>
    </section>
  );
}

function ChangesStrip({ rows, tick }) {
  const [ref, box] = useBox();
  // A row of changes across the strip, newest first; more than fit turn pages.
  const perPage = Math.max(1, Math.floor(box.width / (TICKER_ITEM_EM * box.em)) || 1);
  const { items, page, pages } = pageOf(rows, perPage, tick);
  return (
    <footer className="ld-changes" aria-label="Recent changes">
      <h2>Recent</h2>
      <div ref={ref} className="ld-changes-body" style={{ height: `${ROW_EM.ticker}em` }}>
        {rows.length === 0 ? <span className="ld-muted">No maintenance or ping changes recorded recently.</span> :
          <ul style={{ gridTemplateColumns: `repeat(${perPage}, minmax(0, 1fr))` }}>
            {items.map(r => (
              <li key={r.key} data-level={r.kind}><time dateTime={new Date(r.at).toISOString()}>{changeTime(r.at)}</time><span>{r.text}</span></li>
            ))}
          </ul>}
      </div>
      <Pager page={page} pages={pages} />
    </footer>
  );
}
