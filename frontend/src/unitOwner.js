// A unit's owner, by the lab owner's rule (2026-11-10): "a product (unit) on a floor or shelf belongs to whoever is
// registered on the server there". Pure (no DOM, no React), so the Racks page, its search, the shelf labels and the unit
// tests share one rule.
//
//   a unit on a floor or shelf with a server   that server's owner (none when the server has none). Several servers on
//                                              one floor: the first in slot order, the server its card and its shelf
//                                              label show first.
//   a unit on a floor or shelf with no server, its own saved owner ("item:<id>" in the owner map), else none.
//   on the rack level (u 0) or outside a rack
//
// The owner is derived when it is shown: nothing is migrated and a unit's saved owner is never changed. It counts again
// when the unit moves to a floor without a server. Rows are the rows the Racks page draws (buildRackRows):
// [{ u, items: [{ kind: "server" | "custom", data }] }], servers first and in slot order.

// The owner map's key for a unit (rack item).
export const itemOwnerKey = id => `item:${id}`;

const clean = value => (value == null ? "" : String(value).trim());

// The server whose owner the units on this row take: the first server in slot order; none on the rack level (u 0).
export function floorServer(row) {
  if (!row || !(Number(row.u) >= 1)) return null;
  const hit = (row.items || []).find(i => i?.kind === "server" && i.data);
  return hit ? hit.data : null;
}

// One unit's owner: { owner, server }. server: the server on its floor it takes the owner from (null: its own saved
// owner). owner: "" for none.
export function unitOwner(itemId, server, owners = {}) {
  if (server) return { owner: clean(owners?.[server.id]), server };
  return { owner: clean(owners?.[itemOwnerKey(itemId)]), server: null };
}

// Every unit on these rows: { [item id]: { owner, server } }, added to `into` (several racks share one result).
export function rowsUnitOwners(rows, owners = {}, into = {}) {
  for (const row of rows || []) {
    const server = floorServer(row);
    for (const entry of row?.items || []) {
      if (entry?.kind === "custom" && entry.data?.id != null) into[entry.data.id] = unitOwner(entry.data.id, server, owners);
    }
  }
  return into;
}

// Every unit of these racks ([{ rack, rows }]): { [item id]: { owner, server } }.
export function unitOwners(racks, owners = {}) {
  const out = {};
  for (const entry of racks || []) rowsUnitOwners(entry?.rows, owners, out);
  return out;
}

// The owner map as the page shows it: each unit's "item:<id>" is its owner by the rule (a unit with none has no key);
// servers and units on no listed rack keep their saved owners. The saved map is never changed.
export function withUnitOwners(owners, shown) {
  const out = { ...(owners || {}) };
  for (const [id, entry] of Object.entries(shown || {})) {
    const key = itemOwnerKey(id);
    if (entry?.owner) out[key] = entry.owner;
    else delete out[key];
  }
  return out;
}

// A unit's owner in an owner map ("" for none); in the map withUnitOwners makes, the owner by the rule.
export const ownerOfUnit = (owners, id) => clean(owners?.[itemOwnerKey(id)]);

// Why a unit has that owner, for its panel and tooltips: "From OPT12, the server on this floor." ("" for its own owner).
export function ownerFromText(server, storage = false) {
  const name = clean(server?.name);
  return name ? `From ${name}, the server on this ${storage ? "shelf" : "floor"}.` : "";
}
