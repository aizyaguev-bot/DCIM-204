// The pure part of the server window's place dialogs (WP-1): the floors and the servers on them from
// GET /api/devices/locations, the PDU outlets and KVM ports an empty floor can take, the move-server bodies, the key a
// preview is tied to, and the texts of a preview and of the "Last change" panel. No React, no DOM: node --test imports it.
//
// The owner's rules (2026-11-10): the PDU outlet and the KVM port belong to the FLOOR. A server that lands on a floor
// takes over that floor's outlet and port (the labels are rewritten; the PDU and KVM devices never move), and the units
// on the floor it leaves go with it (units_follow). Every change is a dry run first, applied with its plan_revision.
import { floorsFor, placeWord, validFloor } from "../components/racks/floors.js";
import { floorOutlet, isFreeOutletLabel, labelChangeText } from "../components/racks/serverMove.js";
import { drawnOf } from "./serverRecord.js";
import { windowKey } from "./serverKey.js";

const asArray = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? "" : String(value));
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

// ── servers and floors ──

// Every server of /locations as the dialogs see it: { key, name, drawn, rack, slot, removed, pdu, kvm }.
// hidden: the removal list's Set of keys (useRemovedServers), so a server removed meanwhile counts as removed too.
export function moveServers(locations, hidden = null) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(locations?.servers)) {
    const key = text(row?.key) || windowKey(row?.name) || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: text(row.name || key), drawn: drawnOf(row), rack: row.rack ?? null,
      slot: Number.isInteger(row.slot) ? row.slot : null, removed: row.removed === true || !!hidden?.has?.(key),
      pdu: asArray(row.pdu), kvm: asArray(row.kvm) });
  }
  return out.sort(byName);
}

// The servers a picker offers: never a removed one, never the server itself.
export const pickable = (servers, except = null) => asArray(servers).filter(s => s && !s.removed && s.key !== except);

// The servers drawn on that floor of the rack (removed servers are never drawn), `except` left out: [{ key, name }].
export function occupants(servers, rack, u, except = null) {
  return pickable(servers, except).filter(s => s.drawn?.rack === rack && s.drawn?.u === u).map(s => ({ key: s.key, name: s.name }));
}

// The first floor (storage: shelf) of the rack that no other server is on; null when every one is taken.
export function firstFreeFloor(servers, rack, except = null) {
  for (let u = 1; u <= floorsFor(rack); u++) if (!occupants(servers, rack, u, except).length) return u;
  return null;
}

// The floor Move to… starts on in a rack: the first one no other server is on, never the one the server is on now;
// when every other floor is taken, the first other floor (a swap with its server, previewed before anything is saved).
export function defaultFloor(servers, rack, record) {
  const own = record?.drawn?.rack === rack ? record.drawn.u : null;
  const others = Array.from({ length: floorsFor(rack) }, (_, i) => i + 1).filter(u => u !== own);
  return others.find(u => !occupants(servers, rack, u, record?.key).length) ?? others[0] ?? 1;
}

// The racks a server can move to: every rack /locations knows, in natural order.
export function moveRacks(locations) {
  const names = new Set(asArray(locations?.racks).map(String).filter(Boolean));
  for (const row of asArray(locations?.servers)) if (row?.rack) names.add(String(row.rack));
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// "Rack-05 · floor 2", "Storage-Main · shelf 3", "Rack-01 · U 7", "Rack-02", "not on a rack": a place of the
// move-server plan ({ rack, slot }) or of a picker row ({ drawn } / { rack }).
export function whereText(place) {
  const rack = place?.rack || null;
  if (!rack) return "not on a rack";
  const u = place.slot ?? place.u;
  if (validFloor(u, rack)) return `${rack} · ${placeWord(rack)} ${u}`;
  return Number.isInteger(u) && u > 0 ? `${rack} · U ${u}` : rack;
}

// Where a picker row is: its drawn floor, else its rack ("not drawn"), else "not on a rack".
export function serverPlaceText(server) {
  if (server?.drawn?.rack) return whereText({ rack: server.drawn.rack, slot: server.drawn.u });
  return server?.rack ? `${server.rack} · not drawn` : "not on a rack";
}

// The picker's hits for what was typed: exact names first, then names that start with it, then the rest that contain
// it, each in natural order. Removed servers and the server itself are never offered.
export function matchServers(servers, query, except = null, limit = 8) {
  const q = text(query).trim().toLowerCase();
  const list = pickable(servers, except);
  if (!q) return list.slice(0, limit);
  const exact = [], starts = [], has = [];
  for (const s of list) {
    const name = s.name.toLowerCase();
    if (name === q || s.key === q) exact.push(s);
    else if (name.startsWith(q) || s.key.startsWith(q)) starts.push(s);
    else if (name.includes(q) || s.key.includes(q)) has.push(s);
  }
  return [...exact, ...starts, ...has].slice(0, limit);
}

// ── an empty floor: which outlet feeds it, which KVM port serves it ──

export const outletValue = o => `${o.pduId}:${o.outlet}`;
export const kvmValue = p => `${p.kvmId}:${p.port}`;
const splitValue = value => {
  const at = String(value).lastIndexOf(":");
  return at > 0 ? { device_id: value.slice(0, at), port: value.slice(at + 1) } : null;
};

// The KVMs of a rack: its own and those shared with it ("shared:<rack>" in the KVM's notes).
export const rackKvms = (devices, rack) => asArray(devices).filter(d => d && d.kind === "kvm" && (d.rack === rack ||
  String(d.notes || "").split(",").map(s => s.trim()).includes(`shared:${rack}`)));

// The free ports of a rack's KVMs, each { kvmId, kvmName, port, label }: ports 1..port_count (or the highest labelled
// one) whose saved label is blank, a default name or a placeholder, and that /locations lists as empty (a port whose
// name the KVM itself reports as a server is not free). empty: GET /api/devices/locations empty_ports.kvm.
export function freeKvmPorts(devices, rack, empty = null) {
  const open = Array.isArray(empty) ? new Set(empty.map(p => `${p.device_id}:${Number(p.port)}`)) : null;
  const out = [];
  for (const kvm of rackKvms(devices, rack)) {
    const labels = kvm.labels && typeof kvm.labels === "object" ? kvm.labels : {};
    const numbered = Object.keys(labels).map(Number).filter(n => Number.isInteger(n) && n > 0);
    const count = Math.min(Math.max(Number(kvm.port_count) || 0, ...numbered, 0), 96);
    for (let port = 1; port <= count; port++) {
      const label = String(labels[String(port)] ?? "").trim();
      if (!isFreeOutletLabel(label)) continue;
      if (open && !open.has(`${kvm.id}:${port}`)) continue;
      out.push({ kvmId: kvm.id, kvmName: kvm.name || kvm.id, port, label });
    }
  }
  return out;
}

// The KVM port that serves an empty floor, when the KVM says so: the one free port labelled as a placeholder ("spare",
// "empty") whose number is the floor's. null otherwise (two such ports are a guess), as floorOutlet for outlets.
export function floorKvmPort(free, floor) {
  const numbered = asArray(free).filter(p => /^(empty|free|spare|n\/a|-+)$/i.test(String(p.label || "")) && p.port === floor);
  return numbered.length === 1 ? numbered[0] : null;
}

// The outlet choices for an empty floor. One per PDU feed the server has now: "keep" (default), "drop" or a free outlet
// ("<pdu>:<outlet>"); a server on no PDU outlet gets one choice, "none" or a free outlet. Feed 1 starts on the floor's
// own outlet only when the PDU labels exactly one free outlet with the floor's number (floorOutlet). A second feed is
// never dropped by default.
export function feedDefaults(record, free, floor) {
  const known = floorOutlet(free, floor);
  const feeds = asArray(record?.pdu);
  if (!feeds.length) return [known ? outletValue(known) : "none"];
  return feeds.map((_, i) => (i === 0 && known ? outletValue(known) : "keep"));
}

// The KVM choice for an empty floor: the floor's own placeholder port when the KVM says so, else "keep" when the
// server has a KVM port, else "none".
export function kvmDefault(record, freeKvm, floor) {
  const known = floorKvmPort(freeKvm, floor);
  if (known) return kvmValue(known);
  return asArray(record?.kvm).length ? "keep" : "none";
}

// The server's ports after a move onto an empty floor, from those choices: { ports: [{ device_id, port }], error,
// noPdu }. error: no port at all (move-server needs one), or the same outlet chosen twice. noPdu: no PDU outlet stays,
// so Racks will not draw it.
export function floorPorts(record, feeds, kvm) {
  const ports = [];
  const own = asArray(record?.pdu);
  asArray(feeds).forEach((value, i) => {
    if (value === "keep") { if (own[i]) ports.push({ device_id: text(own[i].device_id), port: text(own[i].port) }); }
    else if (value && value !== "drop" && value !== "none") { const p = splitValue(value); if (p) ports.push(p); }
  });
  const pdus = ports.length;
  if (kvm === "keep") for (const p of asArray(record?.kvm)) ports.push({ device_id: text(p.device_id), port: text(p.port) });
  else if (kvm && kvm !== "none") { const p = splitValue(kvm); if (p) ports.push(p); }
  const keys = ports.map(p => `${p.device_id}:${Number(p.port) || p.port}`);
  const error = !ports.length ? "Choose a PDU outlet or a KVM port: a server needs at least one."
    : new Set(keys).size !== keys.length ? "The same port is chosen twice." : "";
  return { ports, error, noPdu: pdus === 0 };
}

// ── move-server bodies ──

// A server's ports now: its PDU outlets, then its KVM ports.
export const ownPorts = record => [...asArray(record?.pdu), ...asArray(record?.kvm)]
  .map(p => ({ device_id: text(p.device_id), port: text(p.port) }));

// The POST /api/devices/move-server body (dry_run and plan_revision are added by the caller):
//   swap      { server, target_server, swap: true }            each takes the other's ports, place and floor's units
//   takeover  { server, target_server, swap: false }           the target loses its ports and place (becomes unplaced)
//   move      { server, target_ports, target_rack, target_slot, swap: false }   onto an empty floor
//   pin       { server, target_ports: its own, target_rack, target_slot: its drawn floor, swap: false }
// Every body carries units_follow. null while the choice is incomplete.
export function moveBody({ mode, record, other = null, rack = null, u = null, ports = null, unitsFollow = true }) {
  if (!record?.name) return null;
  const base = { server: record.name };
  const follow = { units_follow: !!unitsFollow };
  if (mode === "swap" || mode === "takeover") return other ? { ...base, target_server: other, swap: mode === "swap", ...follow } : null;
  if (mode === "pin") {
    const d = record.drawn;
    const own = ownPorts(record);
    if (!d?.rack || !validFloor(d.u, d.rack) || !own.length) return null;
    return { ...base, target_ports: own, target_rack: d.rack, target_slot: d.u, swap: false, ...follow };
  }
  if (!rack || !Number.isInteger(u) || !asArray(ports).length) return null;
  return { ...base, target_ports: ports.map(p => ({ device_id: text(p.device_id), port: text(p.port) })), target_rack: rack,
    target_slot: u, swap: false, ...follow };
}

// What the toast's Undo sends: a swap is undone by the same swap; a move by a move back to the ports and place the
// server had before (its drawn floor, else its saved rack and U). null when there is nothing to go back to (it had no
// port), and for a take-over, a pin and a clear (nothing to undo them with: they say so in their preview).
export function undoBody(mode, record, body) {
  if (!body) return null;
  if (mode === "swap") return { ...body };
  if (mode !== "move") return null;
  const ports = ownPorts(record);
  if (!ports.length) return null;
  const d = record.drawn;
  const back = { server: record.name, target_ports: ports };
  if (d?.rack && validFloor(d.u, d.rack)) Object.assign(back, { target_rack: d.rack, target_slot: d.u });
  else if (record.rack) {
    back.target_rack = record.rack;
    if (Number.isInteger(record.slot) && record.slot >= 1 && record.slot <= 999) back.target_slot = record.slot;
  }
  return { ...back, swap: false, units_follow: !!body.units_follow };
}

// ── the preview key ──

// A short hash of a text (FNV-1a), so a key over a whole /locations body stays small.
function hash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// The data a preview depends on: the /locations body, the rack-items ETag and every PDU's / KVM's labels_revision.
// When it changes (anything saved anywhere), the open dialog previews again with the choices made in it.
export function moveDataKey(locations, rackItemsEtag, devices) {
  const revisions = asArray(devices).filter(d => d && (d.kind === "pdu" || d.kind === "kvm"))
    .map(d => `${d.id}=${d.labels_revision || ""}`).join(",");
  return hash(`${JSON.stringify(locations ?? null)}|${rackItemsEtag || ""}|${revisions}`);
}

// ── texts of a preview and of the "Last change" panel ──

export const switchText = value => (value && (value.switch || value.port)
  ? `${value.switch || "switch"}${value.port ? ` port ${value.port}` : ""}` : "none");

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The plan's places that really change: [{ server, before, after }].
export const movedPlaces = plan => asArray(plan?.positions).filter(p => p && !same(
  { rack: p.before?.rack ?? null, slot: p.before?.slot ?? null }, { rack: p.after?.rack ?? null, slot: p.after?.slot ?? null }));
// The plan's switch ports that change (WP-B's "switch"): [{ server, before, after }].
export const switchChanges = plan => asArray(plan?.switch).filter(s => s && !same(s.before, s.after));

export const placeLine = p => `${p.server}: ${whereText(p.before)} → ${whereText(p.after)}`;
export const switchLine = s => `${s.server}: ${switchText(s.before)} → ${switchText(s.after)}`;
export const unitNamesOf = entry => asArray(entry?.units).map(u => text(u?.name || u?.id || "Unit"));
export const unitLine = m => `${unitNamesOf(m).join(", ")} with ${m.server}: ${whereText(m.from)} → ${whereText(m.to)}`;

// Every line of a move or clear result, for the "Last change" panel: port labels before → after, places, servers that
// become unplaced, the units that moved, the switch ports that changed.
export function resultLines(plan) {
  return [
    ...asArray(plan?.changes).map(labelChangeText),
    ...movedPlaces(plan).map(placeLine),
    ...asArray(plan?.unplaced).map(name => `${name} becomes unplaced`),
    ...asArray(plan?.units).map(m => `Moved: ${unitLine(m)}`),
    ...switchChanges(plan).map(p => `Switch ${switchLine(p)}`),
  ];
}

// The one-line summary of a saved move (the toast and the panel's title).
export function moveSummary(mode, record, other, place) {
  const name = record?.name || "The server";
  if (mode === "swap") return `${name} and ${other} swapped places.`;
  if (mode === "takeover") return `${name} took over the place of ${other}; ${other} is unplaced now.`;
  if (mode === "pin") return `${name} is pinned to ${whereText(place)}.`;
  if (mode === "ports") return `${name}: ports changed.`;
  if (mode === "clear") return `${name}: location cleared. It keeps its saved rack place.`;
  return `${name} moved to ${whereText(place)}.`;
}

// A refused or failed save, as one line. A plan that changed since the preview is the usual 409.
export function moveError(e) {
  const detail = text(e?.detail);
  if (e?.status === 409 && /^Changed since the preview/.test(detail)) {
    return "Something changed in another session meanwhile, so nothing was saved. Check the new preview and confirm again.";
  }
  if (detail) return detail;
  if (e?.status === 403) return "Moving servers requires the Operator or Admin role.";
  return e?.status ? `The request failed (HTTP ${e.status}).` : "The request failed. Check the connection and try again.";
}
