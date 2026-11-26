// The 3D twin's inventory (lab-twin/lab-data.json) as Lab Manager reads it: GET /api/twin-data (Viewer), with the
// ETag a later write must send as If-Match. Read-only here; the twin saves its own edits, and deletes go through
// POST /api/lab/delete.
import { loadLayout } from "./layout.js";

export const TWIN_DATA_PATH = "/api/twin-data";

// -> { data, etag }. A failed read throws (status and detail on the error), like loadLayout.
export async function loadTwinData() {
  const { data, etag } = await loadLayout(TWIN_DATA_PATH);
  return { data: data && typeof data === "object" ? data : {}, etag: etag || null };
}
