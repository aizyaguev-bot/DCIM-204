// The automatic webpe lookup (tools/webpe-sync/sync.cjs --watch on the lab laptop): whether it runs, for the Serial
// numbers panel and the scan dialog. Pure (no React), so node --test covers it; useWebpeStatus.js polls it.

export const POLL_MS = 30000;
export const LAUNCHER = "tools/webpe-sync/start-webpe-sync.cmd";
export const FILL_NOTE = "P/N and name will be filled from webpe within a minute";
const SIGN_IN = /^webpe sign-in needed/i;

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// "10:05", or "Nov 8, 09:12" for another day.
export function clockText(iso, now = new Date()) {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return sameDay(at, now) ? time : `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

// {state: "active" | "signin" | "problem" | "stopped", text} for a GET /api/inventory/webpe-status answer, or null when
// there is nothing to show (the status could not be read).
export function webpeStatusText(status, { now = new Date(), clock = clockText } = {}) {
  if (!status || typeof status !== "object") return null;
  const error = typeof status.last_error === "string" ? status.last_error.trim() : "";
  if (!status.active) {
    const seen = status.seen_at ? clock(status.seen_at, now) : "";
    return { state: "stopped", text: `webpe auto lookup: Not running${seen ? ` (last seen ${seen})` : ""} — start ${LAUNCHER} on the lab laptop` };
  }
  if (SIGN_IN.test(error)) return { state: "signin", text: "webpe sign-in needed on the lab laptop" };
  const parts = ["Active"];
  const checked = clock(status.last_check || status.seen_at, now);
  if (checked) parts.push(`last check ${checked}`);
  parts.push(`${Number(status.looked_up_today) || 0} looked up today`);
  if (Number(status.pending) > 0) parts.push(`${status.pending} waiting`);
  return { state: error ? "problem" : "active", text: `webpe auto lookup: ${parts.join(" · ")}${error ? ` — problem: ${error}` : ""}` };
}

// A unit the scan just added that the lookup will fill: it has a serial number and no P/N, and the lookup runs.
export function willFill(item, status) {
  return Boolean(status?.active && !SIGN_IN.test(String(status.last_error || ""))
    && String(item?.serial_number || item?.barcode || "").trim() && !String(item?.part_number || "").trim());
}

export async function loadWebpeStatus() {
  const response = await fetch("/api/inventory/webpe-status", { cache: "no-store" });
  if (!response.ok) throw Object.assign(new Error(`Status unavailable (${response.status}).`), { status: response.status });
  return response.json();
}
