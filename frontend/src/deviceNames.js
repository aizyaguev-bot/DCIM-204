// Pure helpers for writing site port names to the PDUs/KVMs themselves (NS): status rows from
// GET /api/devices/name-sync/status, the live compare from GET /api/devices/{id}/device-names and the push results.
// Kept free of DOM/React so node --test can import this module.

export const POLL_MS = 3000;          // a pending row is re-read every 3 s ...
export const POLL_LIMIT_MS = 60000;   // ... for at most 60 s after the page opened or a save
export const NOTICE_MS = 6000;
export const NOTICE_WARN_MS = 15000;  // a "not sent" warning stays longer: it needs reading

const MODES = ["auto", "manual", "off"];
export const COMPARE_STATES = ["in_sync", "differs", "unknown", "not_writable"];
export const SYNC_STATUSES = ["pending", "synced", "failed", "skipped"];

export const COMPARE_TEXT = { in_sync: "In sync", differs: "Differs", unknown: "Unknown", not_writable: "Not writable" };
export const MODE_TEXT = {
  auto: "Saved names are written to the device automatically.",
  manual: "Manual mode: saved names are not sent automatically. Write them from here.",
  off: "Device name sync is off: names are compared only, nothing is written.",
};

const str = value => (value == null ? "" : String(value));
const nameOrNull = value => (value == null ? null : String(value));
const portOrder = (a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b));

export const portNoun = kind => (kind === "pdu" ? "Outlet" : "Port");
export const normalizeMode = mode => (MODES.includes(mode) ? mode : null);

// A device name as the UI shows it (plain text, control characters removed): "" is the device's own default name,
// null is not known (not read).
export const nameText = value => (value == null ? "unknown" : value === "" ? "device default" : String(value).replace(/[\u0000-\u001f\u007f]/g, ""));
export const NAMES_CHANGED = "Names changed — review again.";

// The server's state wins; a row without one is classified from the names (write null = this port is never written).
export function classifyPort(row) {
  if (COMPARE_STATES.includes(row?.state)) return row.state;
  if (row?.write == null) return "not_writable";
  if (row?.device == null) return "unknown";
  return String(row.write) === String(row.device) ? "in_sync" : "differs";
}

// Tolerates missing fields so a partial response still renders. supported must be an explicit true: never guess a write.
export function normalizeCompare(data) {
  const ports = (Array.isArray(data?.ports) ? data.ports : [])
    .filter(p => p && p.port != null && p.port !== "")
    .map(p => {
      const row = {
        port: String(p.port),
        site: str(p.site),
        device: nameOrNull(p.device),
        write: nameOrNull(p.write),
        sync: p.sync && typeof p.sync === "object" ? p.sync : null,
      };
      return { ...row, state: classifyPort({ ...row, state: p.state }) };
    })
    .sort((a, b) => portOrder(a.port, b.port));
  return {
    deviceId: str(data?.device_id),
    kind: data?.kind === "pdu" || data?.kind === "kvm" ? data.kind : null,
    mode: normalizeMode(data?.mode),
    supported: data?.supported === true,
    reason: str(data?.reason),
    reachable: data?.reachable === true,
    error: str(data?.error),
    ports,
  };
}

// Whether this compare allows any write at all (and if not, the one fixed reason the panel shows).
export function writeBlock(compare, { enabled = true } = {}) {
  if (!compare) return "";
  if (compare.mode === "off") return MODE_TEXT.off;
  if (enabled === false) return "This device is disabled in Lab Manager: names are never written to it.";
  if (!compare.reachable) return "";  // the unreachable error is shown on its own
  if (!compare.supported) return compare.reason || "Port names cannot be written to this device.";
  return "";
}

// Ports that can be selected for a write: they differ and the server named a value to write (a port without a saved
// site label is not_writable and never gets a checkbox).
export function writablePorts(compare, options) {
  if (!compare || !compare.reachable || writeBlock(compare, options)) return [];
  return compare.ports.filter(p => p.state === "differs" && p.write != null);
}

// The confirm step: one line per selected port, "Outlet 5: optn44 → optn45" ("device default" for an empty name).
export function confirmList(ports, selected, kind) {
  const chosen = new Set([...(selected || [])].map(String));
  return (ports || []).filter(p => chosen.has(String(p.port))).map(p => {
    const from = nameText(p.device), to = nameText(p.write);
    return { port: String(p.port), from, to, text: `${portNoun(kind)} ${p.port}: ${from} → ${to}` };
  });
}

// POST body for a push: an explicit, non-empty port list plus the value the compare showed for each ({port: write}),
// so the server refuses (409) when the site names changed after the review. null when nothing can be sent.
export function pushBody(compare, ports) {
  const rows = new Map((compare?.ports || []).filter(p => p.write != null).map(p => [p.port, p]));
  const chosen = [...new Set([...(ports || [])].map(String))].filter(port => rows.has(port)).sort(portOrder);
  if (!chosen.length) return null;
  return { ports: chosen, expected: Object.fromEntries(chosen.map(port => [port, rows.get(port).write])) };
}

export const writeButtonText = n => `Write ${n} name${n === 1 ? "" : "s"} to device`;

// GET /api/devices/name-sync/status -> this device's rows keyed by port; rows with an unknown status are dropped.
export function normalizeStatus(data, deviceId) {
  const rows = data?.devices?.[deviceId];
  const ports = {};
  if (rows && typeof rows === "object") {
    for (const [port, row] of Object.entries(rows)) {
      if (!row || !SYNC_STATUSES.includes(row.status)) continue;
      ports[String(port)] = {
        status: row.status,
        desired: str(row.desired),
        reason: str(row.reason),
        updated_at: row.updated_at ?? null,
        synced_at: row.synced_at ?? null,
      };
    }
  }
  return { mode: normalizeMode(data?.mode), ports };
}

export const hasPending = ports => Object.values(ports || {}).some(r => r?.status === "pending");

// Device-level summary: "Names on device: 22 synced, 1 failed" (only the counts that are not zero).
export function syncSummary(ports) {
  const counts = { synced: 0, pending: 0, failed: 0, skipped: 0 };
  const failedPorts = [];
  for (const [port, row] of Object.entries(ports || {})) {
    if (!(row?.status in counts)) continue;
    counts[row.status] += 1;
    if (row.status === "failed") failedPorts.push(String(port));
  }
  failedPorts.sort(portOrder);
  const parts = ["synced", "pending", "failed", "skipped"].filter(s => counts[s]).map(s => `${counts[s]} ${s}`);
  const total = counts.synced + counts.pending + counts.failed + counts.skipped;
  return { ...counts, total, failedPorts, text: total ? `Names on device: ${parts.join(", ")}` : "" };
}

// The per-port badge; null when this port has no status row (nothing is shown then).
export function badgeInfo(row) {
  const reason = str(row?.reason);
  switch (row?.status) {
    case "synced": return { symbol: "✓", text: "Name on device: synced" };
    case "pending": return { symbol: "⟳", text: "Name on device: writing…" };
    case "failed": return { symbol: "!", text: `Name on device: failed${reason ? ` — ${reason}` : ""}` };
    case "skipped": return { symbol: "–", text: `Name on device: not written${reason ? ` — ${reason}` : ""}` };
    default: return null;
  }
}

// The short note after a label save, from the save response's "device_names" (+ "device_names_reason"). "not_sent":
// nothing was queued (every name refused, or a KVM save) and is never shown as sent; a manual answer with a reason
// (e.g. a save too large to push automatically) shows that reason. Reasons are fixed server texts, shown as given.
export function saveNotice(deviceNames, reason) {
  const why = str(reason).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  switch (deviceNames) {
    case "queued": return { text: "Sent to device", tone: "ok" };
    case "not_sent": return { text: why ? `Not sent to device: ${why}` : "Not sent to device", tone: "warn" };
    case "manual": return why ? { text: `Not sent to device: ${why}`, tone: "warn" } : { text: "Not sent: manual mode", tone: "muted" };
    case "off": return { text: "Not sent: device name sync is off", tone: "muted" };
    default: return null;
  }
}

export const NOTICE_TONE = { ok: "text-emerald-400", warn: "text-amber-300", muted: "text-zinc-400" };
export const noticeDuration = notice => (notice?.tone === "warn" ? NOTICE_WARN_MS : NOTICE_MS);

// When the save response did not carry "device_names", the configured mode tells the same thing.
export const deviceNamesForMode = mode => ({ auto: "queued", manual: "manual", off: "off" })[mode] ?? null;

// POST .../device-names/push -> { ok, results } sorted by port; an unknown status counts as failed.
export function normalizeResults(data) {
  const results = (Array.isArray(data?.results) ? data.results : [])
    .filter(r => r && r.port != null && r.port !== "")
    .map(r => {
      const known = SYNC_STATUSES.includes(r.status);
      return {
        port: String(r.port),
        status: known ? r.status : "failed",
        device: nameOrNull(r.device),
        reason: str(r.reason) || (known ? "" : "No result was reported"),
      };
    })
    .sort((a, b) => portOrder(a.port, b.port));
  return { ok: data?.ok === true, results };
}

export const failedResultPorts = results => (results || []).filter(r => r.status === "failed").map(r => r.port);

export function resultCounts(results) {
  const counts = { synced: 0, pending: 0, failed: 0, skipped: 0 };
  for (const r of results || []) if (r.status in counts) counts[r.status] += 1;
  return counts;
}

export function resultHeadline(results) {
  const c = resultCounts(results);
  if (!(results || []).length) return "Nothing was written: no port needed a change.";
  const parts = [];
  if (c.synced) parts.push(`${c.synced} written`);
  if (c.pending) parts.push(`${c.pending} queued`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.skipped) parts.push(`${c.skipped} not written`);
  return `${parts.join(", ")}.`;
}

export function resultText(result, kind) {
  const head = `${portNoun(kind)} ${result.port}`;
  switch (result.status) {
    case "synced": return `${head}: written (${nameText(result.device)})`;
    case "pending": return `${head}: queued`;
    case "skipped": return `${head}: not written${result.reason ? ` — ${result.reason}` : ""}`;
    default: return `${head}: failed${result.reason ? ` — ${result.reason}` : ""}`;
  }
}

// After a push: written ports show the name read back from the device.
export function applyResults(compare, results) {
  const written = new Map((results || []).filter(r => r.status === "synced").map(r => [r.port, r]));
  if (!compare || written.size === 0) return compare;
  return {
    ...compare,
    ports: compare.ports.map(p => {
      const r = written.get(p.port);
      if (!r) return p;
      const device = r.device ?? p.write;
      return { ...p, device, state: p.write == null ? p.state : device === p.write ? "in_sync" : "differs" };
    }),
  };
}

// Fixed, short texts for failed requests; a server detail (already secret-free) wins where it exists.
export function nameSyncErrorText(error) {
  const detail = typeof error?.detail === "string" ? error.detail.trim() : "";
  switch (error?.status) {
    case 401: return "Your session has expired. Sign in again.";
    case 403: return detail || "Operator role needed to read or write names on the device.";
    case 404: return detail && detail !== "Not Found" ? detail : "This device or the device names feature is not available. Reload the page.";
    case 409: return detail || MODE_TEXT.off;
    case 422: return detail || "Some ports are not on this device any more. Compare again.";
    default: break;
  }
  if (detail) return detail;
  if (error?.status) return `Request failed (${error.status}). Try again.`;
  return "Could not reach Lab Manager. Check the connection and try again.";
}
