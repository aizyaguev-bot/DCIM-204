// Delete and restore for every lab item (v2 spec §D; backend routers/lab_delete.py and app/lab_trash.py). Pure request
// helpers, free of DOM/React so node --test can import them. Every call answers its JSON body; a refusal throws an
// Error whose message is the server's text, with `status` (403 role, 409 changed or blocked, 428 no preview).
//
//   previewDelete(targets, options)                        dry run: the plan (items, consequences, blockers, screens,
//                                                          plan_revision); it writes nothing
//   applyDelete(targets, options, planRevision, reason)    the previewed delete; answers the plan and { batch, deleted_etag }
//   listDeleted()                                          { data: { batches }, etag } (the ETag is a restore's If-Match)
//   restoreDeleted(batch, entries, { dryRun, planRevision, etag })   entries: [{ kind, id }] or null for every entry
//   purgeDeleted(batch)                                    Delete forever (Admin)
//   undoDelete(batch)                                      Undo: a dry run, then the restore when nothing blocks it;
//                                                          answers { restored, plan }
export const LAB_PATH = "/api/lab";

async function call(method, path, body, headers = {}) {
  const response = await fetch(path, {
    method, cache: "no-store",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
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
  return { data, etag: response.headers.get("ETag") };
}

const targetList = targets => (Array.isArray(targets) ? targets : [targets]).filter(t => t && t.kind && t.id != null)
  .map(t => ({ kind: String(t.kind), id: String(t.id) }));

export async function previewDelete(targets, options = {}) {
  return (await call("POST", `${LAB_PATH}/delete`, { targets: targetList(targets), options: options || {}, dry_run: true })).data;
}

export async function applyDelete(targets, options = {}, planRevision, reason = "") {
  return (await call("POST", `${LAB_PATH}/delete`, {
    targets: targetList(targets), options: options || {}, plan_revision: planRevision, ...(reason ? { reason } : {}),
  })).data;
}

export async function listDeleted() {
  return call("GET", `${LAB_PATH}/deleted`);
}

// etag: the ETag of the Deleted list the page shows; without one, the list is read first (Undo right after a delete).
export async function restoreDeleted(batch, entries = null, { dryRun = false, planRevision = null, etag = null } = {}) {
  const body = { batch, ...(entries ? { entries: targetList(entries) } : {}), ...(dryRun ? { dry_run: true } : {}),
    ...(planRevision ? { plan_revision: planRevision } : {}) };
  if (dryRun) return (await call("POST", `${LAB_PATH}/restore`, body)).data;
  const ifMatch = etag || (await listDeleted()).etag;
  return (await call("POST", `${LAB_PATH}/restore`, body, ifMatch ? { "If-Match": ifMatch } : {})).data;
}

export async function purgeDeleted(batch) {
  return (await call("DELETE", `${LAB_PATH}/deleted/${encodeURIComponent(batch)}`)).data;
}

// Undo of a delete (the toast): preview the restore of the whole batch; apply it when nothing blocks it. When something
// does, nothing is written and { restored: false, plan } says why.
export async function undoDelete(batch) {
  const plan = await restoreDeleted(batch, null, { dryRun: true });
  if (plan.blockers?.length) return { restored: false, plan };
  const done = await restoreDeleted(batch, null, { planRevision: plan.plan_revision });
  return { restored: true, plan: done };
}
