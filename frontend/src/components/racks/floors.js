// A rack's floors: the one place that says how many there are. A rack has four floors (1 at the top … 4 at the
// bottom, like the 3D Twin's SHELF 1 (TOP) … SHELF 4 (BOTTOM)); Main storage is a storage unit of 16 numbered shelves.
import { MAIN_STORAGE } from "../../api/inventory.js";

export const RACK_FLOORS = 4;
export const STORAGE_SHELVES = 16;

// Main storage has shelves; every other rack has floors.
export const rackHasFloors = rack => rack !== MAIN_STORAGE;

// How many numbered places the rack has: floors 1-RACK_FLOORS, or Main storage's shelves 1-STORAGE_SHELVES.
export const floorsFor = rack => (rackHasFloors(rack) ? RACK_FLOORS : STORAGE_SHELVES);

// A floor of that rack (no rack: a compute rack): a whole number from 1 to floorsFor(rack).
export const validFloor = (u, rack = null) => Number.isInteger(u) && u >= 1 && u <= floorsFor(rack);

// "floor" / "floors" in a rack, "shelf" / "shelves" in Main storage.
export const placeWord = rack => (rackHasFloors(rack) ? "floor" : "shelf");
export const placesWord = rack => (rackHasFloors(rack) ? "floors" : "shelves");
