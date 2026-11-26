// Moving and swapping servers on the Racks page (the owner's rules of 2026-11-10). Pure (no React, no DOM), so
// node --test can import it.
//
// - The PDU outlet and the KVM port belong to the FLOOR, never to the server: a server that lands on a floor takes over
//   that floor's outlet and port (the labels on the PDU / KVM are rewritten; the PDU and KVM devices never move). The
//   server does that with POST /api/devices/move-server (port labels, rack layout and the units that go along together
//   or not at all; a dry run previews it): a swap is { server, target_server, swap: true } (each takes the other's ports
//   and place), a move to an empty floor is { server, target_ports, target_rack, target_slot } (its outlet: the floor's
//   when known, else the one the person chose, else its own; its KVM port stays). The server also leaves "empty",
//   "KVM Power" and other placeholder labels out of rack_slots / rack_positions / rack_overrides when it writes them.
// - Everything on the floor moves with the server: the units (rack items) on the floor it leaves go to the floor it
//   lands on (a swap swaps both floors' units), unless the person turned that off. The server works them out itself
//   (units_follow in the move-server request; the server window's MoveDialog sends it).
//
// placements: { [serverId]: { rack, u, auto } } where every server is drawn now. u is its floor (a storage rack: its
// shelf) as the rack card shows it, auto-placed ones included: a whole number from 0, or null when its saved U is not
// one. auto: it has no saved U (it sits on the next free floor).
// moves: [{ id, toRack, toU }]: one for a move, two for a swap (swapMoves).
// isFloor(rack, u): u is one of that rack's floors 1-4 or storage shelves 1-16 (floors.js validFloor).
import { placeWord } from "./floors.js";

// A unit's floor as the rack card draws it: a whole number from 0 to 42, anything else is the rack level (0).
export function unitFloor(item) {
  const n = typeof item?.u === "string" && item.u.trim() ? Number(item.u) : item?.u;
  return Number.isInteger(n) && n >= 0 && n <= 42 ? n : 0;
}

export const serversOnFloor = (placements, rack, u) =>
  Object.keys(placements || {}).filter(id => placements[id]?.rack === rack && placements[id]?.u === u);

// The units on that floor of the rack. The rack level / whole storage (u 0) is no floor: nothing is "on" it.
export function unitsOnFloor(items, rack, u) {
  if (!Number.isInteger(u) || u < 1) return [];
  return (Array.isArray(items?.[rack]) ? items[rack] : []).filter(item => item && typeof item === "object" && unitFloor(item) === u);
}

// The two moves of a swap: each server takes the other's place. null when either has no place to give.
export function swapMoves(a, b, placements) {
  const pa = placements?.[a], pb = placements?.[b];
  if (!pa?.rack || !pb?.rack || pa.u == null || pb.u == null || a === b) return null;
  return [{ id: a, toRack: pb.rack, toU: pb.u }, { id: b, toRack: pa.rack, toU: pa.u }];
}

// The server's 409 when the equipment list changed since the ETag a move sent (backend devices._ITEMS_CHANGED):
// another unit was saved meanwhile. Only this refusal is worth sending again with the list read afresh.
export const UNITS_CHANGED = "The units on these floors were changed in another session.";
export const unitsConflict = e => e?.status === 409 && String(e?.detail || "").startsWith(UNITS_CHANGED);

// ── PDU outlets and KVM ports (they belong to the floor) ──

// Outlet labels that say "nothing runs here": a free outlet. "KVM Power" and "PDU" feed equipment: never free.
const PLACEHOLDER_LABEL = /^(empty|free|spare|n\/a|-+)$/i;
const DEFAULT_LABEL = /^((outlet|port)\s*\d+)?$/i;

export const isFreeOutletLabel = label => { const text = String(label ?? "").trim(); return DEFAULT_LABEL.test(text) || PLACEHOLDER_LABEL.test(text); };

// The PDUs that feed a rack: its own and those shared with it ("shared:<rack>" in the PDU's notes).
export const rackPdus = (pdus, rack) => (pdus || []).filter(p => p && p.kind !== "rack" && (p.rack === rack ||
  String(p.notes || "").split(",").map(s => s.trim()).includes(`shared:${rack}`)));

// The free outlets of a rack's PDUs, each { pduId, pduName, outlet, label }: outlets 1..port_count (or the highest
// labelled one) whose label is blank, a default name or a placeholder ("empty"). empty: the server's list of empty
// ports (GET /api/devices/locations empty_ports.pdu) when known; an outlet missing from it names a server there.
export function freeOutlets(pdus, rack, empty = null) {
  const open = Array.isArray(empty) ? new Set(empty.map(p => `${p.device_id}:${Number(p.port)}`)) : null;
  const out = [];
  for (const pdu of rackPdus(pdus, rack)) {
    const labels = pdu.labels && typeof pdu.labels === "object" ? pdu.labels : {};
    const numbered = Object.keys(labels).map(Number).filter(n => Number.isInteger(n) && n > 0);
    const count = Math.min(Math.max(Number(pdu.port_count) || 0, ...numbered, 0), 96);
    for (let outlet = 1; outlet <= count; outlet++) {
      const label = String(labels[String(outlet)] ?? "").trim();
      if (!isFreeOutletLabel(label)) continue;
      if (open && !open.has(`${pdu.id}:${outlet}`)) continue;
      out.push({ pduId: pdu.id, pduName: pdu.name || pdu.id, outlet, label });
    }
  }
  return out;
}

// The outlet that feeds an empty floor, when the PDU says so: the one outlet on the rack's PDUs that is labelled as
// free ("empty", "spare") and has the floor's number. null otherwise: the dialog asks which outlet feeds the floor
// (default: the server keeps its own). A free label on an outlet of another number says nothing about this floor
// (QA 2026-11-10: "Spare" on outlet 1 was offered for every floor), and two such outlets of that number are a guess.
export function floorOutlet(free, floor) {
  const numbered = (free || []).filter(o => PLACEHOLDER_LABEL.test(o.label) && o.outlet === floor);
  return numbered.length === 1 ? numbered[0] : null;
}

// What a move preview could not check (the server's "unchecked": PDUs/KVMs whose own port names are unknown now):
// "KVM 01 ports 2, 3 and 4", joined with "; ". Empty text when there is none.
export function uncheckedText(unchecked) {
  return (Array.isArray(unchecked) ? unchecked : []).map(d => {
    const ports = (Array.isArray(d?.ports) ? d.ports : []).map(String);
    const list = ports.length > 1 ? `${ports.slice(0, -1).join(", ")} and ${ports[ports.length - 1]}` : ports.join("");
    return `${d?.device_name || d?.device_id} ${d?.kind === "pdu" ? "outlet" : "port"}${ports.length > 1 ? "s" : ""} ${list}`;
  }).join("; ");
}

// Which ports a swap's servers take over, from the preview's label changes: "PDU outlet and KVM port", "PDU outlet",
// "KVM port", or "" when no label changes.
export function takesOverText(changes) {
  const kinds = new Set((changes || []).map(c => c?.kind));
  return [kinds.has("pdu") && "PDU outlet", kinds.has("kvm") && "KVM port"].filter(Boolean).join(" and ");
}

// The move-server body. swapWith: the other server's name (a swap: each takes the other's ports and place). Else a
// move to that rack and floor with `ports`: [{ device_id, port }] (its PDU outlet(s) and KVM port(s) afterwards).
export function moveServerBody({ name, swapWith = null, rack, floor, ports = [] }) {
  if (swapWith) return { server: name, target_server: swapWith, swap: true };
  return { server: name, target_ports: ports.map(p => ({ device_id: String(p.device_id), port: String(p.port) })),
    target_rack: rack, target_slot: floor, swap: false };
}

// One port label change of a move preview: "PDU 01 outlet 3: OPT13 → OPT11".
export function labelChangeText(change) {
  const word = change?.kind === "kvm" ? "port" : "outlet";
  return `${change?.device_name || change?.device_id} ${word} ${change?.port}: ${change?.before || "—"} → ${change?.after || "—"}`;
}

// The first floor (storage: shelf) of the rack that no server is on, other than the ones given; null when all are taken.
export function firstFreeFloor(placements, rack, count, except = []) {
  const skip = new Set(except);
  const taken = new Set(Object.keys(placements || {}).filter(id => !skip.has(id) && placements[id]?.rack === rack).map(id => placements[id].u));
  for (let u = 1; u <= count; u++) if (!taken.has(u)) return u;
  return null;
}

// "Rack-02 · floor 3", "Storage shelf · shelf 9", "Rack-02 · rack level", "Storage-Main · whole storage".
export function placeText(rack, u) {
  if (!rack) return "no rack";
  const word = placeWord(rack);
  if (Number.isInteger(u) && u > 0) return `${rack} · ${word} ${u}`;
  return `${rack} · ${word === "shelf" ? "whole storage" : "rack level"}`;
}

// The names the confirmation lists after "Moves with …".
export const unitNames = units => (units || []).map(unit => String(unit?.name || unit?.id || "Unit"));
