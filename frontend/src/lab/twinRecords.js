// Which 3D records (lab-twin/lab-data.json) are the same thing as a Lab Manager record, and why the others are "3D
// only". Pure (no React, no DOM). The same rule lives in lab-twin/classify.js (the 3D twin) and
// backend/app/lab_trash.py classify_twin; backend/tests/fixtures/twin_classify.json pins all three.
//
// twin: the lab-data.json document ({ items, storage, setups, shelves, dcim }).
// live: what Lab Manager knows (the Manage page's rows):
//   servers    [{ key, name }]                 GET /api/devices/locations servers
//   devices    [{ id, kind, name }]            GET /api/devices/ (kind pdu | kvm | rack)
//   rackItems  { rack: [{ id, name, u }] }     GET /api/rack-items
//   chillers   [{ id, rack }]                  GET /api/chillers units
//   racks      [rack name]                     the Manage page's rack rows
// Returns { linked: Map<twin id, Lab Manager uid>, only: [{ id, type, name, reason }] }.
// uids: "server:<key>", "dev:<device id>", "unit:<rack item id>", "cooling:<unit id>", "rack:<rack name>".
//
// The rules (one per record type):
//   opt        dcim.optKey, else the identity of dcim.optKey, else the identity of its name ("Optn85 (SSD)" -> optn85),
//              is a server key. Else: "No server named <name> in Lab Manager".
//   pdu / kvm  dcim.deviceId is a device of that kind; else exactly one device of that kind has the same normalized name
//              (trimmed, lower-case, spaces collapsed) and no record is linked to it by id. Else: "No PDU with id <id> or
//              name <name> in Lab Manager" (KVM likewise; "No PDU named <name> in Lab Manager" without an id).
//   equip-*    exactly one rack item has the same normalized name. Else "Hidden in 3D: a Lab Manager unit is on its
//              shelf" when a rack item sits on the record's shelf (the 3D draws the Lab Manager unit there instead),
//              else "No unit named <name> in Lab Manager".
//   chiller    Lab Manager cooling units in their order: each takes the first unlinked 3D chiller whose setup is mapped
//              to the unit's rack (the twin's own rule, lab-twin/app.js). Else "No cooling unit on <rack> in Lab Manager".
//   setups     linked to rack R when dcimRack is R and R is a rack row. Else "Not mapped to a Lab Manager rack".
//   storage and every other item type: never linked, "3D only".
import { serverIdentity } from "../api/locations.js";

const asArray = value => (Array.isArray(value) ? value : []);
export const normName = value => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const RACK_FLOORS = 4;

// The 3D shelf a Lab Manager unit on floor u of a setup is drawn on (lab-twin/app.js shelfForU for a compute rack:
// shelves by level, floor 1 = the top one with top-down numbering; floors the file has no shelf for are not shelves).
function shelfForU(twin, setupId, u) {
  if (!Number.isInteger(u) || u < 1) return null;
  const json = asArray(twin?.shelves).filter(sh => sh && sh.setup === setupId).sort((a, b) => a.level - b.level);
  const n = Math.max(RACK_FLOORS, json.length);
  if (u > n) return null;
  const topDown = (twin?.dcim?.uNumbering || "top-down") === "top-down";
  // Missing floors are added below the lowest known shelf (top-down) or above the highest one.
  const missing = n - json.length;
  const all = topDown ? [...Array(missing).fill(null), ...json] : [...json, ...Array(missing).fill(null)];
  return all[topDown ? n - u : u - 1]?.id || null;
}

function optCandidates(item) {
  const key = typeof item?.dcim?.optKey === "string" ? item.dcim.optKey.trim().toLowerCase() : "";
  return [key, serverIdentity(key), serverIdentity(item?.name)].filter(Boolean);
}

export function classifyTwin(twin, live) {
  live = live && typeof live === "object" ? live : {};
  const linked = new Map();
  const only = [];
  const items = asArray(twin?.items);
  const setups = asArray(twin?.setups);
  const serverKeys = new Set(asArray(live.servers).map(s => s?.key).filter(Boolean));
  const devices = asArray(live.devices);
  const rackItems = Object.entries(live.rackItems && typeof live.rackItems === "object" ? live.rackItems : {})
    .flatMap(([rack, list]) => asArray(list).filter(Boolean).map(item => ({ ...item, rack })));
  const racks = new Set(asArray(live.racks).map(String));
  const setupRack = new Map(setups.map(s => [s.id, typeof s.dcimRack === "string" && s.dcimRack ? s.dcimRack : null]));
  const setupOfRack = new Map(setups.filter(s => setupRack.get(s.id)).map(s => [setupRack.get(s.id), s.id]));
  const skip = (record, type, reason) => only.push({ id: record.id, type, name: String(record.name ?? ""), reason });

  // pdu / kvm: by id first (every record), then by a unique name to a device nobody links by id.
  const byId = new Set();
  for (const item of items) {
    if (item?.type !== "pdu" && item?.type !== "kvm") continue;
    const id = item.dcim?.deviceId;
    if (id && devices.some(d => d.kind === item.type && d.id === id)) { linked.set(item.id, `dev:${id}`); byId.add(id); }
  }
  // chillers: each Lab Manager unit takes the first unlinked 3D chiller on its rack's setup.
  const chillers = items.filter(i => i?.type === "chiller");
  for (const unit of asArray(live.chillers)) {
    const setup = unit?.rack ? setupOfRack.get(unit.rack) : null;
    const hit = setup && chillers.find(c => c.setup === setup && !linked.has(c.id));
    if (hit) linked.set(hit.id, `cooling:${unit.id}`);
  }

  for (const item of items) {
    if (!item || typeof item.id !== "string" || linked.has(item.id)) continue;
    const type = String(item.type || "");
    if (type === "opt") {
      const key = optCandidates(item).find(k => serverKeys.has(k));
      if (key) linked.set(item.id, `server:${key}`);
      else skip(item, type, `No server named ${item.name} in Lab Manager`);
    } else if (type === "pdu" || type === "kvm") {
      const same = devices.filter(d => d.kind === type && normName(d.name) === normName(item.name));
      if (same.length === 1 && !byId.has(same[0].id)) linked.set(item.id, `dev:${same[0].id}`);
      else {
        const noun = type === "pdu" ? "PDU" : "KVM";
        const id = item.dcim?.deviceId;
        skip(item, type, id ? `No ${noun} with id ${id} or name ${item.name} in Lab Manager` : `No ${noun} named ${item.name} in Lab Manager`);
      }
    } else if (type.startsWith("equip-")) {
      const same = rackItems.filter(unit => normName(unit.name) === normName(item.name));
      if (same.length === 1) linked.set(item.id, `unit:${same[0].id}`);
      else if (item.shelf && rackItems.some(unit => setupOfRack.has(unit.rack) && shelfForU(twin, setupOfRack.get(unit.rack), Number(unit.u)) === item.shelf)) {
        skip(item, type, "Hidden in 3D: a Lab Manager unit is on its shelf");
      } else skip(item, type, `No unit named ${item.name} in Lab Manager`);
    } else if (type === "chiller") {
      skip(item, type, `No cooling unit on ${setupRack.get(item.setup) || "this rack"} in Lab Manager`);
    } else skip(item, type, "3D only");
  }
  for (const storage of asArray(twin?.storage)) if (storage?.id) skip(storage, "storage", "3D only");
  for (const setup of setups) {
    if (!setup?.id) continue;
    const rack = setupRack.get(setup.id);
    if (rack && racks.has(rack)) linked.set(setup.id, `rack:${rack}`);
    else skip(setup, "setup", "Not mapped to a Lab Manager rack");
  }
  return { linked, only };
}

// classifyTwin's result as plain JSON ({ linked: { twin id: uid }, only }), the shape the shared fixture pins.
export function classifyTwinJson(twin, live) {
  const { linked, only } = classifyTwin(twin, live);
  return { linked: Object.fromEntries(linked), only };
}
