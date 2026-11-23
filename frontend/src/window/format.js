// Small text helpers shared by the windows. Pure.

// A time from the API (epoch seconds, epoch milliseconds or an ISO string) as "on 17 Nov 2026, 14:05"; "" when unknown.
export function formatTime(value) {
  if (value == null || value === "") return "";
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return `on ${new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

// "PDU 01 · outlet 3" / "KVM 01 · port 5".
export const outletText = p => `${p.device_name || p.device_id} · outlet ${p.port}`;
export const kvmPortText = p => `${p.device_name || p.device_id} · port ${p.port}`;
