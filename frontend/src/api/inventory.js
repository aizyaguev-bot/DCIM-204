const versions = new WeakMap();

async function parse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.detail === "string" ? body.detail : `Request failed (${response.status}). Check the fields and try again.`;
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

export function parseLocationCode(code) {
  if (!/^LOC:/i.test(code)) return null;
  const pieces = code.split(":");
  if (pieces.length !== 4) throw new Error("This shelf label is incomplete. Print a new label from Shelf labels.");
  try {
    const rack = decodeURIComponent(pieces[1]);
    const u = Number(pieces[2]);
    const position = decodeURIComponent(pieces[3]);
    if (!rack.trim() || !Number.isInteger(u) || u < 1 || u > 42 || position.length > 80) throw new Error();
    return { rack, u, position };
  } catch {
    throw new Error("Invalid shelf label. Choose a rack and shelf manually.");
  }
}
