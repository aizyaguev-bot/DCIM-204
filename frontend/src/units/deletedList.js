// The Deleted list (one-place spec v2 §D.4, WP-D's backend): what a window shows once its item is gone, and its
// Restore. GET /api/lab/deleted (Operator) -> { batches: [{ id, at, by?, reason?, entries: [{ kind, id, name, restorable,
// why_not, restored_at }] }] } with an ETag; POST /api/lab/restore { batch, entries, dry_run, plan_revision? } with
// If-Match (that ETag). Before WP-D the list does not exist (404): windows then show only "no longer in Lab Manager".
import { useCallback, useEffect, useState } from "react";
import { deletedEntry } from "../server/serverIdentity.js";

export async function callJson(method, path, body, headers = {}) {
  const response = await fetch(path, {
    method, cache: "no-store",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : "";
    const error = new Error(detail || `Request failed (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return { data, etag: response.headers.get("ETag") };
}

// The Deleted list, or null where the backend has none (404 / 405: before WP-D).
export async function loadDeleted() {
  try { return await callJson("GET", "/api/lab/deleted"); }
  catch (e) { if (e.status === 404 || e.status === 405) return null; throw e; }
}

// The Deleted-list entry of one item while `active` (the item is gone or removed): [{ batch, entry, etag } | null,
// refresh(), loaded]. loaded: the list was read (or has none) since `active` last changed.
export function useDeletedEntry(kind, id, active) {
  const [state, setState] = useState({ found: null, loaded: false });
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (!active || id == null) { setState({ found: null, loaded: true }); return undefined; }
    let live = true;
    setState(s => ({ ...s, loaded: false }));
    loadDeleted().then(answer => {
      if (!live) return;
      const hit = answer ? deletedEntry(answer.data, String(id), kind) : null;
      setState({ found: hit ? { ...hit, etag: answer.etag } : null, loaded: true });
    }).catch(() => { if (live) setState({ found: null, loaded: true }); });
    return () => { live = false; };
  }, [kind, id, active, turn]);
  const refresh = useCallback(() => setTurn(t => t + 1), []);
  return [state.found, refresh, state.loaded];
}

// Restore one entry of a batch: a dry run, then the apply with its plan_revision when nothing blocks it. Resolves to
// { done: true } or { done: false, blockers: [text] }.
export async function restoreEntry(found) {
  const body = { batch: found.batch.id, entries: [{ kind: found.entry.kind, id: found.entry.id }] };
  const headers = found.etag ? { "If-Match": found.etag } : {};
  const { data: plan } = await callJson("POST", "/api/lab/restore", { ...body, dry_run: true }, headers);
  const blockers = (Array.isArray(plan?.blockers) ? plan.blockers : []).map(b => (typeof b === "string" ? b : b?.text)).filter(Boolean);
  if (blockers.length) return { done: false, blockers };
  await callJson("POST", "/api/lab/restore", { ...body, dry_run: false, plan_revision: plan?.plan_revision }, headers);
  return { done: true };
}
