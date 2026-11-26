// The pure part of Add server (server/AddServerDialog.jsx): which racks can take a new server, its floor, the free PDU
// outlets and KVM ports of the rack, the name check and the rack_slots pin that keeps the floor chosen. No React, no
// DOM: node --test imports it.
//
// The owner's rules (2026-11-10): the PDU outlet and the KVM port belong to the FLOOR. A new server is written exactly
// as Racks' old "+ OPT" did it (PATCH /api/devices/{id}/labels with the PDU's saved labels and If-Match), and its floor
// is pinned in rack_slots first, so it lands on the floor chosen and no other server's floor changes.
import { floorsFor, placeWord, validFloor } from "../components/racks/floors.js";
import { floorKvmPort, freeKvmPorts, kvmValue, moveServers, occupants } from "./moveModel.js";
import { isServerLabel, windowKey } from "./serverKey.js";

const asArray = value => (Array.isArray(value) ? value : []);
const text = value => (value == null ? "" : String(value));
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

// Labels of an outlet that powers equipment, never a server: never offered.
const INFRASTRUCTURE = /^(kvm[\s_-]*power|pdu)$/i;
// "Nothing runs here": a default name, blank, or a free placeholder. Offered first.
const FREE_FIRST = /^((outlet|port)\s*\d+|empty|free|spare|n\/a|-+)?$/i;
const PLACEHOLDER = /^(empty|free|spare|n\/a|-+)$/i;

// The PDUs of a rack (its own; a PDU shared from another rack would draw the server on that rack).
export const rackOwnPdus = (devices, rack) => asArray(devices).filter(d => d && d.kind === "pdu" && d.rack === rack);

// The racks a server can be added to: every rack with a PDU, in natural order, plus `also` (the rack the dialog was
// opened from) when it has none, so the dialog can say why.
export function addRacks(devices, also = null) {
  const names = new Set(asArray(devices).filter(d => d && d.kind === "pdu" && d.rack).map(d => String(d.rack)));
  if (also) names.add(String(also));
  return [...names].sort(natural);
}

// The free outlets of the rack's PDUs, each { value: "<pduId>:<n>", pduId, pduName, outlet, label, rank }. An outlet's
// label is what the pages show: the reachable PDU's live name, else its saved label. Free: not a server name and not
// "KVM Power" / "PDU". empty: GET /api/devices/locations empty_ports.pdu; an outlet within the PDU's outlet count that
// it does not list names a server the backend knows of (for example a name only the PDU itself reports). Blank, default
// and "empty" / "spare" outlets come first (rank 0), other placeholders ("OptXXX") after them (rank 1).
export function addOutlets(devices, pduStatuses, rack, empty = null) {
  const open = Array.isArray(empty) ? new Set(empty.map(p => `${p.device_id}:${Number(p.port)}`)) : null;
  const out = [];
  for (const pdu of rackOwnPdus(devices, rack)) {
    const status = pduStatuses?.[pdu.id];
    const live = status?.reachable ? asArray(status.outlets) : [];
    const liveBy = new Map(live.map(o => [Number(o.number), o]));
    const saved = pdu.labels && typeof pdu.labels === "object" ? pdu.labels : {};
    const numbered = [...Object.keys(saved).map(Number), ...liveBy.keys()].filter(n => Number.isInteger(n) && n > 0);
    const portCount = Number(pdu.port_count) || 0;
    const count = Math.min(Math.max(portCount, ...numbered, 0), 96);
    for (let n = 1; n <= count; n++) {
      const label = text(liveBy.has(n) ? liveBy.get(n).label : saved[String(n)]).trim();
      if (isServerLabel(label) || INFRASTRUCTURE.test(label)) continue;
      if (open && n <= portCount && !open.has(`${pdu.id}:${n}`)) continue;
      out.push({ value: `${pdu.id}:${n}`, pduId: pdu.id, pduName: text(pdu.name || pdu.id), outlet: n, label,
        rank: FREE_FIRST.test(label) ? 0 : 1 });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || natural(a.pduName, b.pduName) || a.outlet - b.outlet);
}

// "PDU 05 · outlet 2 · Spare"
export const outletText = o => `${o.pduName} · outlet ${o.outlet}${o.label ? ` · ${o.label}` : ""}`;

// The outlet the dialog starts on for a floor: the one outlet labelled "empty" / "spare" with the floor's number (the
// PDU says it feeds that floor), else the first free one, else "".
export function defaultOutlet(outlets, floor) {
  const list = asArray(outlets);
  const numbered = list.filter(o => PLACEHOLDER.test(o.label) && o.outlet === floor);
  if (numbered.length === 1) return numbered[0].value;
  return list[0]?.value || "";
}

// The rack's free KVM ports ({ value, kvmId, kvmName, port, label }) and the one the dialog starts on: the port labelled
// as a placeholder with the floor's number when there is exactly one, else none ("").
export function addKvmPorts(devices, rack, empty = null) {
  return freeKvmPorts(devices, rack, empty).map(p => ({ ...p, value: kvmValue(p) }));
}
export function defaultKvm(ports, floor) {
  const known = floorKvmPort(ports, floor);
  return known ? kvmValue(known) : "";
}

// Every floor (storage: shelf) of the rack: [{ u, label, taken: [names] }], "Floor 2 · free" or "Floor 1 · OPT51".
export function addFloors(locations, hidden, rack) {
  if (!rack) return [];
  const servers = moveServers(locations, hidden);
  const word = placeWord(rack);
  const Word = word[0].toUpperCase() + word.slice(1);
  return Array.from({ length: floorsFor(rack) }, (_, i) => i + 1).map(u => {
    const taken = occupants(servers, rack, u).map(s => s.name);
    return { u, taken, label: `${Word} ${u} · ${taken.length ? taken.join(", ") : "free"}` };
  });
}

// The floor the dialog starts on: the one asked for when it is free, else the first free one, else null.
export function defaultFloor(floors, asked = null) {
  const list = asArray(floors);
  const free = list.filter(f => !f.taken.length);
  if (Number.isInteger(asked) && free.some(f => f.u === asked)) return asked;
  return free[0]?.u ?? null;
}

// Why the typed name cannot be added, or null: { text, key } (key: the existing server to open). A name must be a
// server name (not "Spare" or "Outlet 3") that no server, removed one included, has yet.
export function nameProblem(name, locations, removed = null) {
  const value = text(name).trim();
  if (!value) return { text: "Type the server's name." };
  if (value.length > 80) return { text: "Use at most 80 characters." };
  if (!isServerLabel(value)) return { text: `“${value}” is not a server name (it reads as a free or default outlet). Type the server's name, for example OPT52.` };
  const key = windowKey(value);
  const gone = asArray(removed?.servers).find(r => r && r.key === key && r.active !== false);
  const row = moveServers(locations).find(s => s.key === key);
  if (gone || row?.removed) {
    const shown = text(gone?.name || row?.name || value);
    return { key, removed: true, name: shown, text: `${shown} was removed from the lab. Restore it, or choose another name.` };
  }
  if (row) {
    const where = row.drawn?.rack ? `${row.drawn.rack}${validFloor(row.drawn.u, row.drawn.rack) ? ` · ${placeWord(row.drawn.rack)} ${row.drawn.u}` : ""}`
      : row.rack ? row.rack : "not on a rack";
    return { key, name: row.name, text: `${row.name} already exists (${where}). Open it to change its place or ports.` };
  }
  return null;
}

// The DCIM id the new server is drawn by (its label trimmed and lower-cased, as Racks keys rack_slots).
export const dcimId = name => text(name).trim().toLowerCase();

// rack_slots with the new server pinned on its floor. A malformed entry for the rack is never replaced.
export function withPin(doc, rack, id, floor) {
  const slots = doc && typeof doc === "object" && !Array.isArray(doc) ? { ...doc } : {};
  const entry = slots[rack];
  if (entry != null && (typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error(`The saved floors of ${rack} cannot be read, so nothing was added.`);
  }
  slots[rack] = { ...(entry || {}), [id]: floor };
  return slots;
}

// The same document without that pin (after a label save that failed), when it is still the one written.
export function withoutPin(doc, rack, id, floor) {
  const slots = doc && typeof doc === "object" && !Array.isArray(doc) ? { ...doc } : {};
  const entry = slots[rack];
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry[id] !== floor) return slots;
  const rest = { ...entry };
  delete rest[id];
  slots[rack] = rest;
  return slots;
}

// The labels to save on a device: its saved labels with the new name on that port (Racks' "+ OPT" did the same).
export const labelsWith = (device, port, name) => ({ ...(device?.labels && typeof device.labels === "object" ? device.labels : {}), [String(port)]: text(name).trim() });
