// Layout stores (rack positions, rack slots, switch assignments, rack overrides, chillers) are
// whole JSON documents that the Twin and other sessions also write. A save re-reads the store,
// applies only its own edit to that fresh copy and sends it with If-Match when the server
// provides an ETag; a 409 means another session saved first, so the cycle runs once more.

const ATTEMPTS = 2;

async function failure(response) {
  const body = await response.json().catch(() => null);
  const detail = typeof body?.detail === "string" ? body.detail : "";
  const error = new Error(detail || `The layout could not be saved (HTTP ${response.status}).`);
  error.status = response.status;
  if (detail) error.detail = detail;
  return error;
}

export async function loadLayout(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return { data: await response.json(), etag: response.headers.get("ETag") };
}

// edit(fresh) returns the document to save; resolves to that document once the server accepted it.
export async function saveLayout(path, edit) {
  for (let attempt = 1; ; attempt++) {
    const { data, etag } = await loadLayout(path);
    const next = edit(data);
    const headers = { "Content-Type": "application/json" };
    if (etag) headers["If-Match"] = etag;
    const response = await fetch(path, { method: "PUT", headers, body: JSON.stringify(next) });
    if (response.ok) return next;
    if (response.status !== 409 || attempt >= ATTEMPTS) throw await failure(response);
  }
}
