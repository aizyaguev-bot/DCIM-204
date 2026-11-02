const versions = new WeakMap();
export const MAIN_STORAGE = "Storage-Main";
export const mainStorageCode = "STORE:MAIN";

export function rackCode(rack) {
  return `RACK:${encodeURIComponent(rack)}`;
}

async function parse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // FastAPI sends a 422 detail as a list of { msg } entries; join them like client.js does.
    const detail = typeof body.detail === "string" ? body.detail
      : Array.isArray(body.detail) ? body.detail.map(e => e?.msg).filter(Boolean).join("; ")
      : "";
    const message = detail || `Request failed (${response.status}). Check the fields and try again.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return { data: body, revision: response.headers.get("ETag") };
}

export async function loadRackItems() {
  const { data, revision } = await parse(await fetch("/api/rack-items", { cache: "no-store" }));
  versions.set(data, revision);
  return data;
}

export async function saveRackItems(updated, previous, { alert = true } = {}) {
  try {
    const revision = versions.get(previous);
    if (!revision) throw new Error("Reload DCIM before editing equipment.");
    const saved = await parse(await fetch("/api/rack-items", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": revision },
      body: JSON.stringify(updated),
    }));
    versions.set(saved.data, saved.revision);
    return saved.data;
  } catch (error) {
    // A stale revision would fail every later save too; callers apply error.reloaded instead.
    if (error.status === 409 || error.status === 428) {
      error.reloaded = await loadRackItems().catch(() => null);
      if (error.reloaded) error.message = "Equipment changed in another session. The equipment list was reloaded; review it and try again.";
    }
    // Older equipment dialogs do not render server errors themselves; callers that show the error pass alert: false.
    if (alert) window.alert(error.message);
    throw error;
  }
}

export async function loadInventory(code) {
  const query = code == null ? "" : `?code=${encodeURIComponent(code)}`;
  return parse(await fetch(`/api/inventory${query}`, { cache: "no-store" }));
}

export async function updateInventory(path, body, revision) {
  if (!revision) throw new Error("Load the inventory before saving.");
  return parse(await fetch(`/api/inventory${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "If-Match": revision },
    body: JSON.stringify(body),
  }));
}

export function locationCode(rack, u, position = "") {
  return `LOC:${encodeURIComponent(rack)}:${u}:${encodeURIComponent(position)}`;
}

// The one value a printed location label carries. Its barcode and its QR code both encode exactly this text,
// so a scan of either goes through parseLocationCode below.
export function labelCode(label) {
  return label.rack === MAIN_STORAGE ? mainStorageCode : label.u === 0 ? rackCode(label.rack) : locationCode(label.rack, label.u, label.position);
}

export function parseLocationCode(code) {
  if (/^STORE:/i.test(code)) {
    if (code.toUpperCase() !== mainStorageCode) throw new Error("Unknown storage label. Use the Main storage label.");
    return { rack: MAIN_STORAGE, u: 0, position: "" };
  }
  if (/^RACK:/i.test(code)) {
    try {
      const pieces = code.split(":");
      const rack = decodeURIComponent(pieces[1]);
      if (pieces.length !== 2 || !rack.trim() || rack.length > 120 || rack === MAIN_STORAGE || /[\x00-\x1f\x7f]/.test(rack)) throw new Error();
      return { rack, u: 0, position: "" };
    } catch {
      throw new Error("Invalid rack label. Choose the destination manually.");
    }
  }
  if (!/^LOC:/i.test(code)) return null;
  const pieces = code.split(":");
  if (pieces.length !== 4) throw new Error("This shelf label is incomplete. Print a new label from Shelf labels.");
  try {
    const rack = decodeURIComponent(pieces[1]);
    const u = Number(pieces[2]);
    const position = decodeURIComponent(pieces[3]);
    if (!rack.trim() || rack.length > 120 || rack === MAIN_STORAGE || !Number.isInteger(u) || u < 1 || u > 42 || position.length > 80) throw new Error();
    return { rack, u, position };
  } catch {
    throw new Error("Invalid shelf label. Choose a rack and shelf manually.");
  }
}

// A unit's serial number, part number, model and MAC address: separate fields of the equipment record (stored names),
// in the order the panels show them. The server trims them, stores a MAC as 00:1A:2B:3C:4D:5E and drops a blank one.
export const UNIT_DETAILS = [["serial_number", "Serial number"], ["part_number", "Part number"], ["model", "Model"], ["mac", "MAC address"]];
export const UNIT_DETAIL_FIELDS = UNIT_DETAILS.map(([field]) => field);
export const UNIT_DETAIL_LIMITS = { serial_number: 200, part_number: 120, model: 120, mac: 40 };
export const MAC_ERROR = "MAC address must be six pairs of hex digits, like 00:1A:2B:3C:4D:5E.";

// "00-1a-2b-3c-4d-5e", "001A2B3C4D5E" or "001a.2b3c.4d5e" -> "00:1A:2B:3C:4D:5E"; anything else -> "".
export function normalizeMac(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const pairs = /^([0-9a-f]{2})([:-])([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})$/i.exec(text);
  const digits = pairs ? [1, 3, 4, 5, 6, 7].map(i => pairs[i]).join("")
    : /^[0-9a-f]{12}$/i.test(text) ? text
    : /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(text) ? text.replace(/\./g, "") : "";
  return digits ? digits.toUpperCase().match(/../g).join(":") : "";
}

export function detailText(item, field) {
  const value = item?.[field];
  return value == null ? "" : String(value);
}

// The edit panel's detail fields against the saved record: { changes, errors }. Only edited fields are in `changes`
// ("" clears one); an unedited legacy value is never rewritten. errors: { field: sentence }.
export function unitDetailChanges(item, values) {
  const changes = {}, errors = {};
  for (const [field, label] of UNIT_DETAILS) {
    if (!(field in values)) continue;
    const raw = String(values[field] ?? "");
    if (raw === detailText(item, field)) continue;
    let value = raw.trim();
    if (value && /[\x00-\x1f\x7f]/.test(value)) { errors[field] = `${label} cannot contain control characters.`; continue; }
    if (field === "mac" && value) {
      value = normalizeMac(value);
      if (!value) { errors[field] = MAC_ERROR; continue; }
    } else if (value.length > UNIT_DETAIL_LIMITS[field]) { errors[field] = `${label} can be at most ${UNIT_DETAIL_LIMITS[field]} characters.`; continue; }
    if (value !== detailText(item, field).trim() || (!value && field in item)) changes[field] = value;
  }
  return { changes, errors };
}
