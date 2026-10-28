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

export async function saveRackItems(updated, previous) {
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
    // Older equipment dialogs do not render server errors themselves.
    window.alert(error.message);
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
