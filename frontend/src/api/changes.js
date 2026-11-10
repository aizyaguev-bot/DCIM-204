// Live data sync (owner's rule, 2026-11-10): a change made anywhere (any page, the 3D twin, Scan & Track, another
// browser, the webpe tool, the assistant) shows on every open screen within about 2 seconds, without a reload.
//
// The server keeps a change counter per data domain (backend/app/changes.py) and bumps it after every successful write
// under /api/. GET /api/changes -> {"rev": n, "domains": {"layout": n, "inventory": n, ...}, "at": "..."}.
// This feed reads it every POLL_MS while the page is visible (at once when the page becomes visible or gets focus, and
// right after a write made from this tab), and when counters moved it fires one window event:
//   window "dcim-data-changed"  detail: { domains: ["layout", "owners", ...] }
// Views listen with useDataChanged(domains, reload) (./useDataChanged.js) and reload what they show, keeping any
// unsaved edits (the existing "changed in another session" patterns).
//
// Domains (the server's table in backend/app/changes.py is the source of truth):
//   layout     server places: rack-slots, rack-positions, rack-overrides, rack-layout, switch-assignments
//   inventory  rack items (units), serial details, scans, chillers
//   owners     opt-owners, engineers
//   devices    devices (PDUs, KVMs, racks), device names, outlet labels, server renames
//   removed    removed servers
//   monitoring ping-monitor targets
//   twin       twin-data (lab-data.json)
//   power      outlet power actions, PDU maintenance
//   other      anything else
export const POLL_MS = 2000;
export const DOMAINS = ["layout", "inventory", "owners", "devices", "removed", "monitoring", "twin", "power", "other"];
export const EVENT = "dcim-data-changed";

let started = false;
let last = null;          // { rev, domains } of the last answer
let timer = null;
let inFlight = null;
let again = false;

// The domains whose counters differ between two answers (all of them when the server restarted with lower counters).
export function changedDomains(before, after) {
  if (!before || !after) return [];
  if (!(Number(after.rev) >= Number(before.rev))) return [...DOMAINS];
  if (Number(after.rev) === Number(before.rev)) return [];
  const a = after.domains || {}, b = before.domains || {};
  const out = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(d => Number(a[d] || 0) !== Number(b[d] || 0));
  return out.length ? out : ["other"];
}

async function readChanges() {
  const res = await nativeFetch("/api/changes", { cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const body = await res.json();
  return body && typeof body === "object" && Number.isFinite(Number(body.rev)) ? body : null;
}

// One read of the counters; overlapping calls share one request and run once more after it.
export function pollChanges() {
  if (inFlight) { again = true; return inFlight; }
  inFlight = (async () => {
    try {
      const now = await readChanges();
      if (!now) return;
      const domains = changedDomains(last, now);
      last = now;
      if (domains.length) window.dispatchEvent(new CustomEvent(EVENT, { detail: { domains } }));
    } catch { /* offline or signed out: try again on the next tick */ }
    finally {
      inFlight = null;
      if (again) { again = false; pollChanges(); }
    }
  })();
  return inFlight;
}

// A write from this tab: read the counters at once, so this tab updates now and not on the next tick.
export function pokeChanges() { if (started) setTimeout(pollChanges, 50); }

let nativeFetch = (...args) => window.fetch(...args);
const QUIET = /^\/api\/(changes|auth\/|inventory\/webpe-status|version)/;

// Starts the feed once per page (App and the lab display call it). Watches this tab's own fetch calls so a successful
// write under /api/ pokes the feed; the response is passed through untouched.
export function startChangeFeed() {
  if (started || typeof window === "undefined") return;
  started = true;
  const original = window.fetch.bind(window);
  nativeFetch = original;
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    try {
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (method !== "GET" && method !== "HEAD" && res.ok && url.origin === location.origin && url.pathname.startsWith("/api/") && !QUIET.test(url.pathname)) pokeChanges();
    } catch { /* never break a request */ }
    return res;
  };
  const tick = () => { if (!document.hidden) pollChanges(); };
  timer = setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("focus", tick);
  pollChanges();
}

// Tests only.
export function _resetChangeFeed() { started = false; last = null; inFlight = null; again = false; if (timer) clearInterval(timer); timer = null; }
