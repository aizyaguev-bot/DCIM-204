// A rack's floors: the one place that says how many there are. A compute rack has four floors (1 at the top … 4 at the
// bottom, like the 3D Twin's SHELF 1 (TOP) … SHELF 4 (BOTTOM)); a storage rack is a storage unit of 16 numbered shelves.
// A rack is a storage rack by its type (rack type Storage, the "storage" status on its card); Main storage always is.
import { MAIN_STORAGE } from "../../api/inventory.js";

export const RACK_FLOORS = 4;
export const STORAGE_SHELVES = 16;

// The storage racks the Racks page knows (setStorageRacks, from each rack's type); Main storage is always one.
let storageRacks = new Set([MAIN_STORAGE]);
export function setStorageRacks(names) {
  const next = new Set([MAIN_STORAGE, ...(names || []).filter(name => name != null && name !== "")]);
  if (next.size !== storageRacks.size || [...next].some(name => !storageRacks.has(name))) storageRacks = next;
}
export const isStorageRack = rack => rack != null && storageRacks.has(rack);

// The storage racks among rack stats ({ rack, rackType }): the ones whose type is "storage", and Main storage.
export const storageRackNames = rackStats => (rackStats || []).filter(rs => rs?.rackType === "storage" || rs?.rack === MAIN_STORAGE).map(rs => rs.rack);

// A storage rack has shelves; every other rack has floors.
export const rackHasFloors = rack => !isStorageRack(rack);

// How many numbered places the rack has: floors 1-RACK_FLOORS, or a storage rack's shelves 1-STORAGE_SHELVES.
export const floorsFor = rack => (rackHasFloors(rack) ? RACK_FLOORS : STORAGE_SHELVES);

// A floor of that rack (no rack: a compute rack): a whole number from 1 to floorsFor(rack).
export const validFloor = (u, rack = null) => Number.isInteger(u) && u >= 1 && u <= floorsFor(rack);

// "floor" / "floors" in a rack, "shelf" / "shelves" in a storage rack.
export const placeWord = rack => (rackHasFloors(rack) ? "floor" : "shelf");
export const placesWord = rack => (rackHasFloors(rack) ? "floors" : "shelves");
