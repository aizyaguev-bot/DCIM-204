// Power for one server on the Racks page: every PDU outlet ("feed") that carries the server's name, which actions each
// feed allows, and the plan for one request. Pure; the switching itself is App's onSwitchFeeds.
// The backend (routers/pdus.py outlet_power) enforces role, CSRF, disabled, maintenance and protected outlets anyway;
// these rules only explain up front why a button does nothing.
import { deviceState } from "../../api/client.js";
import { serverIdentity } from "../../api/locations.js";

export const BLOCK = {
  offline: "PDU is unreachable; outlet power actions are unavailable",
  noStatus: "Outlet states are not available",
  unknown: "Outlet state is unknown",
  disabled: "This PDU is disabled; enable it in Admin -> Devices first",
  maintenance: "PDU is in maintenance mode; restore it from the Maintenance column first",
  protected: "This outlet is protected (POWER_PROTECTED_OUTLETS); it cannot be switched off here",
  protectionInvalid: "Protected outlets setting is invalid; power off is unavailable",
  busy: "A power request is in progress",
};

// Same text as DcimView.jsx NON_SERVER_LABEL and isDefaultOutletLabel (racks-power.test.js keeps them equal).
const NON_SERVER_LABEL = /^(empty|kvm[\s_-]*power|pdu|spare|free|n\/a|-+)$/i;
const DEFAULT_OUTLET_LABEL = /^(outlet\s*\d+|port\s*\d+|\s*)$/i;
function isServerLabel(label) {
  return !!label && !DEFAULT_OUTLET_LABEL.test(String(label).trim()) && !NON_SERVER_LABEL.test(String(label).trim());
}

function protectedOutlets(maintenance, pduId) {
  const list = maintenance?.protected?.[String(pduId)];
  return Array.isArray(list) ? list.map(Number) : [];
}

function feedBlocks({ device, status, state, inMaintenance, isProtected, protection }) {
  const all = reason => ({ on: reason, off: reason, cycle: reason });
  if (device?.enabled === false) return all(BLOCK.disabled);
  if (!status) return all(BLOCK.noStatus);
  const reach = deviceState(status);
  if (reach === "offline") return all(BLOCK.offline);
  if (reach === "unavailable") return all(BLOCK.noStatus);
  if (state !== "on" && state !== "off") return all(BLOCK.unknown);
  const offBlock = protection === "invalid" ? BLOCK.protectionInvalid : isProtected ? BLOCK.protected : null;
  return {
    on: inMaintenance ? BLOCK.maintenance : null,
    off: offBlock,
    cycle: inMaintenance ? BLOCK.maintenance : offBlock,
  };
}

// All feeds of the server named `name` (an OPT with PSU1/PSU2 labels is one server). Saved labels count unless the
// PDU is reachable and reports that outlet (its live label wins), the same rule as the Racks `servers` list.
export function serverPowerGroup(name, { devices, pduStatuses, maintenance }) {
  const key = serverIdentity(name);
  if (!key) return null;
  const protection = typeof maintenance?.protection === "string" ? maintenance.protection : null;
  const feeds = [];
  for (const device of devices || []) {
    if (device.kind !== "pdu") continue;
    const status = pduStatuses?.[device.id];
    const live = status?.reachable ? status.outlets || [] : [];
    const liveByN = new Map(live.map(o => [String(o.number), o]));
    const add = (outlet, label, state) => {
      if (!isServerLabel(label) || serverIdentity(label) !== key) return;
      const n = Number(outlet);
      if (!Number.isFinite(n) || feeds.some(f => f.pduId === device.id && f.outlet === n)) return;
      const inMaintenance = !!maintenance?.pdus?.[String(device.id)];
      const isProtected = protectedOutlets(maintenance, device.id).includes(n);
      feeds.push({ id: `${device.id}:${n}`, pduId: device.id, pduName: device.name, rack: device.rack || null, outlet: n,
        label: String(label).trim(), state, inMaintenance, protected: isProtected,
        blocked: feedBlocks({ device, status, state, inMaintenance, isProtected, protection }) });
    };
    Object.entries(device.labels || {}).forEach(([num, label]) => { if (!liveByN.has(num)) add(num, label, "unknown"); });
    live.forEach(o => add(o.number, o.label, o.state === "on" || o.state === "off" ? o.state : "unknown"));
  }
  if (!feeds.length) return null;
  feeds.sort((a, b) => a.label.localeCompare(b.label) || String(a.pduName).localeCompare(String(b.pduName)) || a.outlet - b.outlet);
  const states = new Set(feeds.map(f => f.state));
  const state = states.size === 1 ? [...states][0] : states.has("on") || states.has("off") ? "partial" : "unknown";
  return { key, name: String(name).trim(), state, feeds };
}

const word = action => (action === "on" ? "on" : "off");

// The outlets one request switches. Server scope switches every feed that is not already in the target state; a
// blocked feed refuses the whole request (no partial execution). Cycle works on one feed only.
export function planServerPower(group, action, scope = "server", feedId = null) {
  const plan = { targets: [], skipped: [], disabledReason: null };
  if (!group) return { ...plan, disabledReason: "This server has no PDU outlet" };
  if (action === "cycle" && scope !== "feed") return { ...plan, disabledReason: "Cycle works on one feed" };
  const feeds = scope === "feed" ? group.feeds.filter(f => f.id === feedId) : group.feeds;
  if (!feeds.length) return { ...plan, disabledReason: "This outlet is no longer mapped to the server" };
  for (const feed of feeds) {
    if (action !== "cycle" && feed.state === action) plan.skipped.push({ feed, reason: `already ${word(action)}` });
    else plan.targets.push(feed);
  }
  const blocked = plan.targets.find(f => f.blocked?.[action]);
  if (blocked) plan.disabledReason = `${blocked.pduName} outlet ${blocked.outlet}: ${blocked.blocked[action]}`;
  else if (!plan.targets.length) plan.disabledReason = `${scope === "feed" ? feeds[0].label : group.name} is already ${word(action)}`;
  return plan;
}

// The control's own reason for a blocked action (null when it may be requested).
export function actionBlock(group, action) {
  return planServerPower(group, action, "server").disabledReason;
}

export function sameTargets(a, b) {
  const list = plan => (plan?.targets || []).map(f => `${f.pduId}|${f.outlet}|${f.label}`).join("\n");
  return list(a) === list(b) && (a?.disabledReason || null) === (b?.disabledReason || null);
}

export function powerErrorText(e) {
  if (!e) return "The request failed.";
  if (e.status === 401) return "Your session ended. Sign in again and retry.";
  if ([403, 409, 502].includes(e.status)) return e.detail || e.message;
  // fetch() rejects with a TypeError when the site does not answer at all.
  if (!e.status) return e.name === "TypeError" || !e.message ? "Lab Manager did not answer. Check the connection and try again." : e.message;
  return e.detail || e.message || `The request failed (HTTP ${e.status}).`;
}
