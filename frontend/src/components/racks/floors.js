// A rack's floors: the one place that says how many there are. A rack has four floors (1 at the top … 4 at the
// bottom, like the 3D Twin's SHELF 1 (TOP) … SHELF 4 (BOTTOM)); Main storage has numbered shelves instead of floors.
import { MAIN_STORAGE } from "../../api/inventory.js";

export const RACK_FLOORS = 4;

// Main storage keeps numbered shelves; every other rack has floors 1-RACK_FLOORS.
export const rackHasFloors = rack => rack !== MAIN_STORAGE;

// A floor of a rack: a whole number from 1 to RACK_FLOORS.
export const validFloor = u => Number.isInteger(u) && u >= 1 && u <= RACK_FLOORS;
