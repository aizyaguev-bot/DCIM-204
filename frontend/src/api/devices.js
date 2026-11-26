// Device edits (v2 spec §D.6; backend PATCH /api/devices/{id}, Admin). Pure request helpers for the device window's
// Edit details and Correct rack… dialogs (WP-DW). A refusal throws an Error with the server's text and `status`.
//
// patchDevice(id, body, { dryRun, planRevision })
//   body: { name?, ip?, username?, password?, model?, port_count?, notes?, enabled? } (a blank username or password keeps
//         the stored one; kind cannot change), or { rack, confirm_name? } on its own (Correct rack…).
//   dryRun: answers { dry_run, changes: [{ field, before, after }], servers_moving: [{ key, name, from, to }],
//           blockers: [text], plan_revision } and writes nothing.
//   planRevision: applies the previewed change (428 without one, 409 when anything changed or a blocker applies; a rack
//           change with moving servers or named ports needs confirm_name = the device name, else 422). Answers
//           { ok, device, changes, servers_moving }.
async function call(method, path, body) {
  const response = await fetch(path, {
    method, cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail
      : Array.isArray(data?.detail) ? data.detail.map(d => d?.msg).filter(Boolean).join("; ") : "";
    const error = new Error(detail || `Request failed (HTTP ${response.status})`);
    error.status = response.status;
    if (detail) error.detail = detail;
    throw error;
  }
  return data;
}

export async function patchDevice(id, body, { dryRun = false, planRevision = null } = {}) {
  const path = `/api/devices/${encodeURIComponent(id)}${dryRun ? "?dry_run=true" : ""}`;
  return call("PATCH", path, { ...(body || {}), ...(planRevision && !dryRun ? { plan_revision: planRevision } : {}) });
}
