// The Activity timeline of one server window (v1 §1.5). Pure (no React, no DOM), so node --test imports it.
//
// buildTimeline({ key, incidents, removedLog, admin, units, lastChange }) -> [entry], newest first; this session's
// Last change (it has no time) comes first.
//   incidents   GET /api/monitoring/incidents?target_id=<this server's monitor>   [{ first_failed_at, ended_at, ... }]
//   removedLog  the `log` of GET /api/removed-servers (Admins only get it)          [{ at, action, key, by, reason }]
//   units       the units on this server's floor (record.units), with tracking_history [{ at, action, from, to, note }];
//               from / to are { rack, u, position } (backend inventory_store.location), or text in older entries
//   lastChange  the provider's Last change of this key: { title, lines }
// entry = { id, at /* ms | null */, kind: "incident" | "removal" | "unit" | "change", title, detail, tone }
//   tone: "ok" | "bad" | "warn" | "off"
import { placeWord, validFloor } from "../components/racks/floors.js";

export const ELSEWHERE_NOTE = "Moves, renames and owner changes made elsewhere are not recorded yet.";

const asArray = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? "" : String(value).trim());

// A time from the API (epoch seconds, epoch milliseconds or an ISO string) in milliseconds; null when unknown.
export function toMs(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? (Math.abs(value) < 1e12 ? value * 1000 : value) : null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

// "3 failed checks" / "1 failed check".
const checks = n => `${n} failed ${n === 1 ? "check" : "checks"}`;

// How an incident ended, in words ("Reply received", "Closed: paused", "No recovery observed").
export function incidentEnd(incident) {
  if (!incident?.ended_at) return "No recovery observed";
  const reason = text(incident.end_reason);
  if (!reason || reason === "recovered") return "Reply received";
  return `Closed: ${reason.replaceAll("_", " ")}`;
}

// One ping incident as a timeline entry. format(ms) turns a time into text (the component's clock).
export function incidentEntry(incident, format = ms => new Date(ms).toISOString()) {
  const first = toMs(incident?.first_failed_at);
  const last = toMs(incident?.last_failed_at);
  const ended = toMs(incident?.ended_at);
  const recovered = !!ended && (!incident?.end_reason || incident.end_reason === "recovered");
  const parts = [];
  const n = Number(incident?.failed_checks);
  if (Number.isFinite(n) && n > 0) parts.push(checks(n));
  if (last != null && last !== first) parts.push(`last failed ${format(last)}`);
  parts.push(ended != null ? `${incidentEnd(incident)} ${format(ended)}` : incidentEnd(incident));
  return {
    id: `incident:${incident?.id ?? first}`,
    at: first,
    kind: "incident",
    title: ended != null ? "Did not answer ping" : "Not answering ping",
    detail: parts.join(" · "),
    tone: ended == null ? "bad" : recovered ? "ok" : "off",
  };
}

// The removal log entries of this server (Admin only: the API sends the log to Admins only, and admin=false drops it).
export function removalEntries(log, key, { admin = true } = {}) {
  if (!admin || !key) return [];
  return asArray(log).filter(e => e && text(e.key).toLowerCase() === String(key).toLowerCase()).map((e, i) => {
    const restored = e.action === "restored";
    const by = text(e.by);
    const reason = text(e.reason);
    return {
      id: `removal:${e.at ?? i}:${e.action}`,
      at: toMs(e.at),
      kind: "removal",
      title: restored ? "Restored to the lab" : e.action === "removed" ? "Removed from the lab" : `Removal log: ${text(e.action) || "change"}`,
      detail: [by ? `by ${by}` : "", reason].filter(Boolean).join(" — "),
      tone: restored ? "ok" : "warn",
    };
  });
}

// A place in a unit's tracking entry, in words. The backend writes { rack, u, position } (inventory_store.location);
// older and hand-made entries are text, kept as they are. { rack: "Rack-05", u: 3 } -> "Rack-05 · floor 3"; u 0 is
// "rack level"; a U above the floors is "U 7"; a position ("left") is added.
export function placeOf(value) {
  if (value == null) return "";
  if (typeof value !== "object") return text(value);
  const rack = text(value.rack);
  if (!rack) return "";
  const n = typeof value.u === "string" && value.u.trim() ? Number(value.u) : value.u;
  const spot = validFloor(n, rack) ? `${placeWord(rack)} ${n}` : n === 0 ? "rack level" : Number.isInteger(n) && n > 0 ? `U ${n}` : "";
  return [rack, spot, text(value.position)].filter(Boolean).join(" · ");
}

// The "moved" tracking entries of the units on this floor.
export function unitMoveEntries(units) {
  const out = [];
  for (const unit of asArray(units)) {
    const name = text(unit?.name) || text(unit?.id) || "A unit";
    asArray(unit?.tracking_history).forEach((e, i) => {
      if (!e || e.action !== "moved") return;
      const from = placeOf(e.from) || "?";
      const to = placeOf(e.to) || "?";
      out.push({
        id: `unit:${unit?.id ?? name}:${i}`,
        at: toMs(e.at),
        kind: "unit",
        title: `${name} moved`,
        detail: [`${from} → ${to}`, text(e.note)].filter(Boolean).join(" · "),
        tone: "off",
      });
    });
  }
  return out;
}

// This session's Last change of the server (the provider keeps the latest one per key).
export function sessionEntry(lastChange) {
  if (!lastChange) return null;
  const lines = asArray(lastChange.lines).map(text).filter(Boolean);
  return { id: "change:session", at: null, kind: "change", title: `This session: ${text(lastChange.title) || "Saved."}`,
    detail: lines.join(" · "), tone: "ok" };
}

export function buildTimeline({ key, incidents = [], removedLog = [], admin = false, units = [], lastChange = null, format } = {}) {
  const dated = [
    ...asArray(incidents).map(i => incidentEntry(i, format)),
    ...removalEntries(removedLog, key, { admin }),
    ...unitMoveEntries(units),
  ].sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  const session = sessionEntry(lastChange);
  return session ? [session, ...dated] : dated;
}

// The newest `count` checks (the API answers newest first), oldest to newest: the strip of check results.
export function checkStrip(history, count = 60) {
  return asArray(history).slice(0, count).reverse();
}

// The address "Monitor this server" offers first: the server's identity key, as discovery would use it (a DNS name).
export function defaultMonitorHost(record) {
  const key = text(record?.key);
  return /^[a-z0-9][a-z0-9.-]*$/i.test(key) ? key : "";
}

// Turning "Monitor this server" off closes an open incident (backend monitoring.edit_target): ask first. True when a
// save would turn a monitored server off.
export function pausesMonitor(saved, draft) {
  return !!saved?.enabled && draft?.enabled === false;
}
