// Servers an Admin removed from the lab (backend routers/removed_servers.py). Pure helpers, free of DOM/React so
// node --test can import them; the shared state lives in ../removedServers.jsx.
//
// The one filter every page uses: a server is hidden when its server identity (serverIdentity: "OPTN44 (PSU2)" ->
// "optn44") is in the `hidden` list GET /api/removed-servers returns. The identity is compared exactly, never as a
// prefix or substring, so removing optn44 never hides optn4 or optn440. A renamed server has another identity and
// shows. The server decides what is hidden: a removed name written on another PDU/KVM port later stops being hidden
// there (see the key rule in the backend module), so pages never second-guess the list.
import { serverIdentity } from "./locations.js";

export const REMOVED_PATH = "/api/removed-servers";

// GET body -> Set of hidden identity keys. Anything malformed hides nothing (fail open: servers stay visible).
export function hiddenSet(data) {
  const list = Array.isArray(data?.hidden) ? data.hidden : [];
  return new Set(list.filter(k => typeof k === "string" && k).map(k => k.toLowerCase()));
}

export function isRemovedServer(name, hidden) {
  if (!hidden || !hidden.size) return false;
  const key = serverIdentity(name);
  return !!key && hidden.has(key);
}

// The list without removed servers. nameOf picks the server's name (or key) from an entry; the same array comes back
// when nothing is hidden, so memoised pages do not re-render.
export function withoutRemoved(list, hidden, nameOf = s => s?.name) {
  if (!Array.isArray(list)) return [];
  if (!hidden || !hidden.size) return list;
  const kept = list.filter(entry => !isRemovedServer(nameOf(entry), hidden));
  return kept.length === list.length ? list : kept;
}

// Ping monitor targets (GET /api/monitoring) carry their server identity as server_key; older answers do not, so the
// monitor's inventory name is used then.
export function withoutRemovedTargets(targets, hidden) {
  return withoutRemoved(targets, hidden, t => (typeof t?.server_key === "string" && t.server_key ? t.server_key : t?.inventory_name || t?.name));
}

// Removed servers' monitors are paused, so the monitoring document without them (targets only; the rest unchanged).
export function withoutRemovedMonitoring(monitoring, hidden) {
  if (!monitoring || !Array.isArray(monitoring.targets)) return monitoring;
  const targets = withoutRemovedTargets(monitoring.targets, hidden);
  return targets === monitoring.targets ? monitoring : { ...monitoring, targets };
}

// The confirm dialog's list of what a removal does, from the preview (POST /api/removed-servers with dry_run).
// Returns { cleaned: [text], kept: [text] }.
export function describeRemoval(plan) {
  const cleaned = [], kept = [];
  const files = { "rack_overrides.json": "rack assignment", "rack_slots.json": "rack shelf (U) position",
    "rack_positions.json": "rack order entry", "switch_assignments.json": "switch port" };
  const layout = Array.isArray(plan?.layout) ? plan.layout : [];
  for (const [file, what] of Object.entries(files)) {
    const entries = layout.filter(e => e?.file === file);
    if (!entries.length) continue;
    const where = [...new Set(entries.map(e => (file === "rack_slots.json" && e.slot != null ? `${e.rack} U${e.slot}` : e.rack)).filter(Boolean))];
    cleaned.push(`Its ${what}${entries.length > 1 ? "s" : ""}${where.length ? ` (${where.join(", ")})` : ""}`);
  }
  if (plan?.owner?.name) cleaned.push(`Its owner (${plan.owner.name})`);
  if (plan?.monitor) cleaned.push(plan.monitor.enabled ? `Its ping monitor is paused${plan.monitor.host ? ` (${plan.monitor.host})` : ""}; its history is kept` : "Its ping monitor stays paused; its history is kept");
  const pins = Array.isArray(plan?.pins) ? plan.pins : [];
  if (pins.length) kept.push(`${pins.length} other ${pins.length === 1 ? "server keeps its" : "servers keep their"} shelf position`);
  const ports = Array.isArray(plan?.ports) ? plan.ports : [];
  if (ports.length) kept.push(`The PDU/KVM labels stay as they are: ${ports.map(p => `${p.device_name || p.device_id} ${p.kind === "kvm" ? "port" : "outlet"} ${p.port}`).join(", ")}`);
  const units = Array.isArray(plan?.units_kept) ? plan.units_kept : [];
  if (units.length) kept.push(`Equipment on its shelf stays in the rack: ${units.map(u => u.name).join(", ")}`);
  return { cleaned, kept };
}

async function call(method, path, body, headers = {}) {
  const response = await fetch(path, {
    method, cache: "no-store",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : "";
    const error = new Error(detail || `Request failed (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return { data, etag: response.headers.get("ETag") };
}

export async function loadRemoved() {
  return call("GET", REMOVED_PATH);
}

export async function previewRemoval(name) {
  return (await call("POST", REMOVED_PATH, { name, dry_run: true })).data;
}

// Applies the previewed plan; a 409 means the list or the layout changed since (preview again).
export async function removeServer(name, { reason = "", planRevision } = {}) {
  const { etag } = await loadRemoved();
  return (await call("POST", REMOVED_PATH, { name, reason, ...(planRevision ? { plan_revision: planRevision } : {}) },
    etag ? { "If-Match": etag } : {})).data;
}

export async function restoreServer(key) {
  const { etag } = await loadRemoved();
  return (await call("POST", `${REMOVED_PATH}/${encodeURIComponent(key)}/restore`, null, etag ? { "If-Match": etag } : {})).data;
}
