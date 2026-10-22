// Pure helpers for the server Locations view (GET /api/devices/locations, POST /api/devices/move-server).
// Kept free of DOM/React so node --test can import this module.

// Mirrors backend ping_monitor.server_identity: "OPTN45 (PSU2)" -> "optn45"; "Outlet 3"/"Port 3"/"" -> null.
export function serverIdentity(label) {
  const name = String(label ?? "").trim();
  if (!name || /^(?:outlet|port)\s*\d+$/i.test(name)) return null;
  const match = /^(optn?\d+)(?:\s*\([^)]*\))?$/i.exec(name);
  return (match ? match[1] : name).toLowerCase();
}

const asArray = value => (Array.isArray(value) ? value : []);
const portRef = p => ({
  device_id: String(p?.device_id ?? ""),
  device_name: String(p?.device_name ?? p?.device_id ?? ""),
  port: String(p?.port ?? ""),
  ...(p?.label != null ? { label: String(p.label) } : {}),
});
const portOrder = (a, b) => a.device_name.localeCompare(b.device_name) || (Number(a.port) - Number(b.port)) || a.port.localeCompare(b.port);

const rackOf = value => (value ? String(value) : null);
const slotOf = value => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const isPosition = value => !!value && typeof value === "object" && !Array.isArray(value);

// Tolerates missing fields so a partial response still renders.
// kept: where the server stays once its PDU outlets and KVM ports are cleared (rack layout files only; the server's
// kept_position field). An older server does not send it: keptKnown is then false and kept null.
export function normalizeLocations(data) {
  const servers = asArray(data?.servers).filter(s => s && (s.key || s.name)).map(s => ({
    key: String(s.key ?? serverIdentity(s.name) ?? s.name),
    name: String(s.name ?? s.key),
    rack: rackOf(s.rack),
    slot: slotOf(s.slot),
    pdu: asArray(s.pdu).map(portRef),
    kvm: asArray(s.kvm).map(portRef),
    kept: isPosition(s.kept_position) ? { rack: rackOf(s.kept_position.rack), slot: slotOf(s.kept_position.slot) } : null,
    keptKnown: isPosition(s.kept_position),
  }));
  const empty = data?.empty_ports || {};
  return {
    servers,
    empty_ports: { pdu: asArray(empty.pdu).map(portRef).sort(portOrder), kvm: asArray(empty.kvm).map(portRef).sort(portOrder) },
    racks: asArray(data?.racks).map(String),
  };
}

export const portKey = p => `${p.device_id}:${p.port}`;
export const kindNoun = kind => (kind === "kvm" ? "port" : "outlet");
export const portText = (p, kind) => `${p.device_name} · ${kindNoun(kind)} ${p.port}`;

// Same rack and U (no rack equals no rack, no U equals no U).
export function sameLocation(a, b) {
  return rackOf(a?.rack) === rackOf(b?.rack) && slotOf(a?.slot) === slotOf(b?.slot);
}

export function formatLocation(loc) {
  if (!loc || (!loc.rack && loc.slot == null)) return "Unplaced";
  return [loc.rack || "No rack", loc.slot != null ? `U${loc.slot}` : null].filter(Boolean).join(" · ");
}

export function filterServers(servers, query, rack = "all") {
  const q = String(query || "").trim().toLowerCase();
  return servers.filter(s => {
    if (rack === "unplaced" ? !!s.rack : rack !== "all" && s.rack !== rack) return false;
    if (!q) return true;
    const ports = [...s.pdu, ...s.kvm].flatMap(p => [p.device_name, `${p.device_name} ${p.port}`, `#${p.port}`]);
    return [s.name, s.key, s.rack, s.slot != null ? `u${s.slot}` : "", ...ports]
      .some(v => String(v || "").toLowerCase().includes(q));
  });
}

// Ports the server could move to: empty ones plus the ones it already has (kept when re-selected).
export function portOptions(locations, server, kind) {
  const own = (server?.[kind] || []).map(p => ({ ...p, current: true }));
  const ownKeys = new Set(own.map(portKey));
  const empty = (locations?.empty_ports?.[kind] || []).filter(p => !ownKeys.has(portKey(p)));
  return [...own, ...empty].sort(portOrder);
}

// Groups options per device for <optgroup>.
export function groupByDevice(ports) {
  const groups = new Map();
  for (const p of ports) {
    if (!groups.has(p.device_id)) groups.set(p.device_id, { device_id: p.device_id, device_name: p.device_name, ports: [] });
    groups.get(p.device_id).ports.push(p);
  }
  return [...groups.values()];
}

// Builds the move-server body from the dialog draft, or an error to show next to the form.
// draft: { mode: "server"|"ports", target, swap, slotSwap, pdu: [ports], kvm: [ports], rack, slot }
// swap is the "Swap with the target server" box and slotSwap the "If that slot holds another server" box. Each mode
// sends only its own box, so unticking one never carries over to the other (a draft without slotSwap uses swap).
export function buildMoveRequest(server, draft, dryRun) {
  if (!server?.key) return { error: "Choose a server to move." };
  const swap = (draft?.mode === "server" ? draft?.swap : (draft?.slotSwap ?? draft?.swap)) !== false;
  const base = { server: server.key, target_server: null, target_ports: null, target_rack: null, target_slot: null, swap, dry_run: !!dryRun };
  if (draft?.mode === "server") {
    if (!draft.target) return { error: "Choose the server whose location this server takes." };
    if (draft.target === server.key) return { error: "Choose a different server." };
    return { body: { ...base, target_server: draft.target } };
  }
  const ports = [...(draft?.pdu || []), ...(draft?.kvm || [])];
  if (ports.length === 0) return { error: "Choose at least one PDU outlet or KVM port." };
  const keys = ports.map(portKey);
  if (new Set(keys).size !== keys.length) return { error: "The same port is selected twice." };
  const slotText = String(draft?.slot ?? "").trim();
  let slot = null;
  if (slotText) {
    slot = Number(slotText);
    if (!Number.isInteger(slot) || slot < 1 || slot > 99) return { error: "Slot must be a whole number from 1 to 99." };
  }
  const rack = String(draft?.rack || "").trim() || (slot != null ? server.rack : null) || null;
  if (slot != null && !rack) return { error: "Choose a rack for the slot." };
  return {
    body: {
      ...base,
      target_ports: ports.map(p => ({ device_id: p.device_id, port: String(p.port) })),
      target_rack: rack,
      target_slot: slot,
    },
  };
}

const KIND_LABEL = { pdu: "outlet", kvm: "port" };
export function describeChange(c) {
  const where = `${c?.device_name || c?.device_id || "Device"} ${KIND_LABEL[c?.kind] || "port"} ${c?.port ?? "?"}`;
  return { where, before: c?.before || "(empty)", after: c?.after || "(empty)" };
}

// The server lists the position of every server involved, moved or not; only real moves are shown and counted.
export function normalizeMoveResult(result) {
  return {
    dryRun: !!result?.dry_run,
    changes: asArray(result?.changes).map(c => ({ ...c, ...describeChange(c) })),
    positions: asArray(result?.positions).filter(p => !sameLocation(p?.before, p?.after))
      .map(p => ({ server: String(p?.server ?? ""), before: formatLocation(p?.before), after: formatLocation(p?.after) })),
    unplaced: asArray(result?.unplaced).map(String),
    // The preview's token: Apply sends it back and the server refuses (409) if the plan changed since.
    planRevision: typeof result?.plan_revision === "string" ? result.plan_revision : null,
  };
}

// The Apply request for a preview: the same body, not a dry run, carrying the preview's plan token.
export const applyBody = preview => ({
  ...preview.body, dry_run: false, ...(preview.planRevision ? { plan_revision: preview.planRevision } : {}),
});

export const moveResultIsEmpty = r => r.changes.length === 0 && r.positions.length === 0 && r.unplaced.length === 0;

const MOVE_ERRORS = {
  400: "The move was rejected. Check the target and try again.",
  401: "Your session has expired. Sign in again.",
  403: "Moving servers requires the Operator or Admin role.",
  404: "This server no longer exists. The list has been refreshed.",
  409: "The ports or positions changed. The list has been refreshed; preview again.",
  423: "Labels are being saved elsewhere. Try again in a moment.",
};
export function moveErrorText(e) {
  return e?.detail || MOVE_ERRORS[e?.status] || (e?.status ? `The request failed (HTTP ${e.status}).` : "The request failed. Check the connection and try again.");
}

// "OPTN44 (PSU2)" -> "(psu2)"; no suffix (or a non-OPT name) -> "".
export function feedSuffix(label) {
  const match = /^(optn?\d+)\s*(\([^)]*\))?$/i.exec(String(label ?? "").trim());
  return match?.[2] ? match[2].replace(/\s+/g, "").toLowerCase() : "";
}

// Label editors change only one port. A new label that names a server already on another port of the same kind
// looks like an attempted move; return those ports so the editor can point to Locations -> Move instead.
// Not a move: another feed of the same server ("OPT44 (PSU2)" next to "OPT44 (PSU1)") or its first KVM port.
// draft/original: { port: label } for the edited device; devices: the device list with saved labels.
export function labelMoveHints(device, draft, original, devices) {
  const hints = {};
  const others = [];
  for (const d of devices || []) {
    if (!d || d.id === device?.id || d.kind !== device?.kind) continue;
    for (const [port, label] of Object.entries(d.labels || {})) others.push({ device_name: d.name, kind: d.kind, port, label });
  }
  for (const [port, label] of Object.entries(draft || {})) {
    const key = serverIdentity(label);
    if (!key || key === serverIdentity(original?.[port])) continue;
    const suffix = feedSuffix(label);
    const sameFeed = l => serverIdentity(l) === key && (!suffix || !feedSuffix(l) || feedSuffix(l) === suffix);
    const found = [
      ...Object.entries(draft).filter(([p, l]) => p !== port && sameFeed(l))
        .map(([p]) => ({ device_name: device?.name || "This device", kind: device?.kind, port: p })),
      ...others.filter(o => sameFeed(o.label)),
    ];
    if (found.length) hints[port] = { name: String(label).trim(), where: found.map(f => `${f.device_name} ${kindNoun(f.kind)} ${f.port}`) };
  }
  return hints;
}

// ---- PDU/KVM label editor: PATCH /api/devices/{id}/labels replaces the device's whole map ----
// The form holds every saved label plus every port the live status lists (saved labels win).
export function labelEditState(saved, ports) {
  const draft = {};
  for (const [k, v] of Object.entries(saved || {})) draft[String(k)] = typeof v === "string" ? v : "";
  for (const p of ports || []) {
    const k = String(p?.number ?? "");
    if (k && !(k in draft)) draft[k] = p.label ?? "";
  }
  return { draft, original: { ...draft }, base: { ...(saved || {}) } };
}

const changed = (draft, original, k) => String(draft[k] ?? "").trim() !== String(original?.[k] ?? "").trim();
export const labelChanges = (draft, original) => Object.keys(draft || {}).filter(k => changed(draft, original, k));

// Body for the PATCH: the saved map as it was when editing started, plus only the ports the user changed.
// An emptied port is sent as "" (the server stores its default name); untouched live names are never saved.
export function labelPatchBody(base, draft, original) {
  const body = {};
  for (const [k, v] of Object.entries(base || {})) body[String(k)] = v;
  for (const k of labelChanges(draft, original)) body[k] = String(draft[k] ?? "").trim();
  return body;
}

// ---- Clearing labels (no cascade: one PATCH /api/devices/direct-label per port, label "") ----
const portWhere = p => `${p.device_name} ${kindNoun(p.kind)} ${p.port}`;

// Sync map row: the outlet's label plus the KVM port linked to it (kvmByLabel), if any.
export function syncClearPlan(row) {
  if (!serverIdentity(row?.label)) return null;   // "Outlet 7" placeholders have nothing saved to clear
  const ports = [{ device_id: row.pdu_id, device_name: row.pdu_name, kind: "pdu", port: String(row.outlet_number), label: row.label }];
  if (row.kvm) ports.push({ device_id: row.kvm.device_id, device_name: row.kvm.device_name, kind: "kvm", port: String(row.kvm.port), label: row.kvm.label ?? row.label });
  return { ports, message: `Clear ${row.label} from ${ports.map(portWhere).join(" and ")}?` };
}

// Locations row: every PDU outlet and KVM port of the server. The rack layout files are not touched, but a rack known
// only from the server's PDU or KVM goes with the ports: the server's kept position says what stays.
// after: the position once every port is cleared ({ rack, slot }), or null when the server did not say (older server).
function clearPosition(server) {
  const now = { rack: server.rack ?? null, slot: server.slot ?? null };
  if (!now.rack && now.slot == null) return { after: now, text: "It has no rack position." };
  if (!server.keptKnown || !server.kept) return { after: null, text: "Its rack may not be kept if it comes only from these ports." };
  // A U without a rack is no position (the Racks view cannot draw it): treat it as unplaced.
  const kept = server.kept.rack ? { rack: server.kept.rack, slot: server.kept.slot ?? null } : { rack: null, slot: null };
  const from = formatLocation(now), to = formatLocation(kept);
  let text;
  if (sameLocation(kept, now)) text = `Its saved rack position (${from}) is kept. The Racks view and 3D Twin show it again once it has a PDU outlet.`;
  else if (!kept.rack) text = `It becomes Unplaced: its rack (${now.rack || from}) comes only from these ports.`;
  else if (kept.rack === now.rack) text = `Its position changes from ${from} to ${to} (its saved position).`;
  else text = `Its rack changes from ${from} to ${to} (its saved position).`;
  return { after: kept, text };
}

export function locationClearPlan(server) {
  const ports = [...(server?.pdu || []).map(p => ({ ...p, kind: "pdu" })), ...(server?.kvm || []).map(p => ({ ...p, kind: "kvm" }))];
  if (!ports.length) return null;
  const lines = ports.map(p => `• ${portWhere(p)}${p.label && p.label !== server.name ? ` (${p.label})` : ""}`);
  const { after, text } = clearPosition(server);
  return { ports, after, message: `Clear ${server.name} from all ${ports.length} port${ports.length === 1 ? "" : "s"}?\n\n${lines.join("\n")}\n\n${text}` };
}

// Notice after a Clear: how many labels were cleared and, only when every port was cleared and the server said where
// the server stays, its position now.
export function clearSummary(server, plan, cleared, failed) {
  const total = plan.ports.length;
  const head = `${server.name}: ${cleared.length} of ${total} port label${total === 1 ? "" : "s"} cleared.`;
  const after = plan.after;
  if (failed.length || cleared.length !== total || !after) return head;
  if (!after.rack && after.slot == null) return `${head} Now unplaced.`;
  return sameLocation(after, server) ? `${head} Rack position kept (${formatLocation(after)}).` : `${head} Now at ${formatLocation(after)}.`;
}

// Clears one port at a time so a failure names exactly which ports are still labelled. Each request carries the
// label that was shown, so a port relabelled in another session is refused (409) instead of cleared.
export async function clearPorts(ports, setLabel) {
  const cleared = [], failed = [];
  for (const p of ports) {
    try { await setLabel(p.device_id, p.port, "", p.label ?? ""); cleared.push(p); }
    catch (e) { failed.push({ ...p, error: moveErrorText(e) }); }
  }
  return { cleared, failed };
}

export const clearFailureText = failed => failed.map(f => `${portWhere(f)}: ${f.error}`).join("; ");

// What a cleared port shows afterwards: the server stores the default name for numbered ports
// (backend _cleared_label) and removes any other key.
export const defaultPortLabel = (kind, port) => (/^\d+$/.test(String(port ?? "")) ? `${kind === "kvm" ? "Port" : "Outlet"} ${port}` : "");

// Shapes a clear outcome like a move result so the same change list can show it.
export const clearAsResult = cleared => ({
  dryRun: false, positions: [], unplaced: [],
  changes: cleared.map(p => ({ device_id: p.device_id, device_name: p.device_name, kind: p.kind, port: p.port,
    ...describeChange({ ...p, before: p.label, after: defaultPortLabel(p.kind, p.port) }) })),
});

// ---- Move dialog: ports that are no longer free ----
// The server's 409 text: "Port 3 on PDU 01 is used by OPT99. Choose OPT99 as the target to swap."
// (older wording: "...is used by OPT99; choose it as target_server to swap").
export function parsePortInUse(detail) {
  const match = /^Port (\S+) on (.+?) is used by (.+?)(?:\. Choose |;)/.exec(String(detail || ""));
  return match ? { port: match[1], device_name: match[2], owner: match[3] } : null;
}

const samePortNumber = (a, b) => String(a) === String(b) || (/^\d+$/.test(String(a)) && /^\d+$/.test(String(b)) && Number(a) === Number(b));

// Chosen ports another server now holds: { portKey: owner name } from the fresh list and, if given, the 409 detail.
export function takenPorts(chosen, locations, server, kind, inUse) {
  const free = new Set(portOptions(locations, server, kind).map(portKey));
  const owners = new Map();
  for (const s of locations?.servers || []) for (const p of s[kind] || []) owners.set(portKey(p), s.name);
  const taken = {};
  for (const p of chosen || []) {
    if (inUse && p.device_name === inUse.device_name && samePortNumber(p.port, inUse.port)) taken[portKey(p)] = inUse.owner;
    else if (!free.has(portKey(p))) taken[portKey(p)] = owners.get(portKey(p)) || "another server";
  }
  return taken;
}
