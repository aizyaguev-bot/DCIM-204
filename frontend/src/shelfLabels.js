// Shelf labels: the three-line label the lab sticks on each floor of a rack (and each storage shelf). Pure (no DOM, no
// React), so the Racks page and the unit tests share it.
//
//   project: Portia tray        the product on that floor: the first unit (rack item) in slot order, by its name, else
//                               its model, else its part number; nothing on the floor: "—"
//   owner: Ariel Vinograd       the server's owner (the engineer the floor shows as its owner); a floor with no server:
//                               the unit's own owner (unitOwner.js: a unit's owner is its server's); none: "—"
//   OPTN146                     the server on that floor, exactly as shown; a floor with no server (only a unit): "—"
//
// One label per server (a floor with two servers gets two); a floor with no server and no unit gets none. Only a rack's
// floors 1-RACK_FLOORS and a storage rack's shelves 1-STORAGE_SHELVES get labels (never the rack level or old data above
// them). Cooling units are not products and never name a label.
import { RACK_FLOORS, STORAGE_SHELVES } from "./components/racks/floors.js";
import { ownerOfUnit } from "./unitOwner.js";

export const LABEL_NONE = "—";

const clean = value => (value == null ? "" : String(value).trim());

// The product name of a unit: its name, else its model, else its part number ("" when it has none).
export function productName(item) {
  return clean(item?.name) || clean(item?.model) || clean(item?.part_number);
}

// "Rack-01 · Floor 2" / "Storage-Main · Shelf 3".
export function labelWhere(rack, u, storage = false) {
  return `${rack} · ${storage ? "Shelf" : "Floor"} ${u}`;
}

// racks: [{ rack, storage, rows }], rows as buildRackRows makes them ([{ u, items: [{ kind: "server"|"custom", data }] }]).
// owners: the page's owner map (server id -> name, "item:<id>" -> a unit's owner; the saved map or the shown one,
// withUnitOwners: a unit-only floor's units keep their own owners in both).
// -> [{ key, rack, u, storage, where, project, owner, server }] in rack order, then floor order, then slot order.
export function buildShelfLabels(racks, owners = {}) {
  const out = [];
  for (const entry of racks || []) {
    if (!entry || entry.rack == null) continue;
    const storage = !!entry.storage;
    const count = storage ? STORAGE_SHELVES : RACK_FLOORS;
    const byU = new Map((entry.rows || []).map(row => [row.u, row]));
    for (let u = 1; u <= count; u++) {
      const items = byU.get(u)?.items || [];
      const servers = items.filter(i => i?.kind === "server" && i.data).map(i => i.data);
      const units = items.filter(i => i?.kind === "custom" && i.data).map(i => i.data);
      if (!servers.length && !units.length) continue;
      const project = (units.length ? productName(units.find(productName) || units[0]) : "") || LABEL_NONE;
      const base = { rack: entry.rack, u, storage, where: labelWhere(entry.rack, u, storage), project };
      if (!servers.length) {
        const unitOwner = units.map(unit => ownerOfUnit(owners, unit.id)).find(Boolean);
        out.push({ ...base, key: `${entry.rack}\u0000${u}\u0000unit`, owner: unitOwner || LABEL_NONE, server: LABEL_NONE });
        continue;
      }
      for (const server of servers) {
        out.push({ ...base, key: `${entry.rack}\u0000${u}\u0000${server.id ?? server.name}`,
          owner: clean(owners?.[server.id]) || LABEL_NONE, server: clean(server.name) || LABEL_NONE });
      }
    }
  }
  return out;
}

// The three lines of one label, as it is printed and copied.
export function labelLines(label) {
  const line = value => clean(value) || LABEL_NONE;
  return [`project: ${line(label?.project)}`, `owner: ${line(label?.owner)}`, line(label?.server)];
}

export function labelText(label) {
  return labelLines(label).join("\n");
}

// Several labels: each label's three lines, a blank line between labels.
export function labelsText(labels) {
  return (labels || []).map(labelText).join("\n\n");
}

// A label with this printout's edits applied (edits: key -> { project?, owner?, server? }); the saved data never changes.
export function withEdits(label, edits) {
  const own = edits?.[label.key];
  return own ? { ...label, ...own } : label;
}
