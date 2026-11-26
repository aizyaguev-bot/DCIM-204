// Remove / Delete and Restore (one-place spec v1 WP-2, v2 §W.1 and §D): Delete… itself is placed by WindowShell from
// ServerWindow's deleteTarget ({ kind: "server", id: key }, Admin) and calls act.openDelete, the one DeleteDialog
// (lab/DeleteDialog.jsx). This package shows the banner of a removed or deleted server ("Removed from the lab …" /
// "Deleted … by …", read only) and its Restore (Admin):
//   - an entry of the Deleted list (GET /api/lab/deleted): POST /api/lab/restore, a dry run first, then the apply with
//     its plan_revision (If-Match: the list's ETag);
//   - a server removed before the Deleted list existed: POST /api/removed-servers/restore (If-Match: the ETag of the
//     removed servers list this page shows).
// Export shape: window/CONTRACT.md.
import { useEffect, useRef, useState } from "react";
import { restoreServer } from "../api/removedServers.js";
import { restoredText } from "../lab/deletePlan.js";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { useRemovedServers } from "../removedServers.jsx";
import { callJson, useDeletedEntry as useDeletedItem } from "../units/deletedList.js";
import { useLabWindow } from "../window/labWindowContext.js";
import { formatTime } from "../window/format.js";

// The server's Deleted-list entry, read while the window shows a removed server (again when it is removed again):
// [{ batch, entry, etag } | null, refresh].
const useDeletedEntry = record => useDeletedItem("server", record?.key,
  record?.removed ? String(record.removed.record?.removed_at ?? "removed") : null);

function more() {
  return [];
}

function Banner({ record, can, act }) {
  const [deleted, , listRead] = useDeletedEntry(record);
  if (!record?.removed) return null;
  const { record: removed, active } = record.removed;
  // The time and who are unknown until the removal list has loaded (the /locations flag came first).
  const when = formatTime(deleted?.batch?.at ?? removed?.removed_at);
  const at = when ? ` ${when}` : "";
  const by = deleted?.batch?.by || removed?.removed_by;
  const restore = can.admin && <button type="button" className="lab-window-btn ml-2" data-action="restore-server"
    onClick={() => act.openDialog("restore", { key: record.key })}>Restore…</button>;
  if (!active) return <div className="lab-window-banner" data-tone="warn" role="status" data-removed-banner="shown-again">
    Removed{at}, but its name is on new ports now, so it shows again.{restore}
  </div>;
  // Deleted (in the Deleted list) or removed before that list existed is known once the list was read: until then the
  // banner says neither, so it never names one and then the other.
  if (!deleted && !listRead) return <div className="lab-window-banner" role="status" data-removed-banner="checking">Read only.{restore}</div>;
  return <div className="lab-window-banner" role="status" data-removed-banner={deleted ? "deleted" : "removed"}>
    {deleted ? "Deleted" : "Removed from the lab"}{at}{by ? ` by ${by}` : ""}. Read only.{restore}
  </div>;
}

function RestoreDialog({ record, act, close }) {
  const lab = useLabWindow();
  const removedList = useRemovedServers();
  const [deleted, refreshDeleted, listRead] = useDeletedEntry(record);
  const [plan, setPlan] = useState(null);          // the Deleted-list restore's dry run
  const [turn, setTurn] = useState(0);             // a refused restore previews again (the list's ETag may be the same)
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const cancelRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: cancelRef, busyRef, onEscape: close });
  const name = record.name;
  const restoreBody = deleted ? { batch: deleted.batch.id, entries: [{ kind: "server", id: record.key }] } : null;

  // A Deleted-list entry: preview the restore (blockers, ports that now say something else).
  useEffect(() => {
    if (!deleted) { setPlan(null); return undefined; }
    let live = true;
    callJson("POST", "/api/lab/restore", { ...restoreBody, dry_run: true }, deleted.etag ? { "If-Match": deleted.etag } : {})
      .then(answer => { if (live) setPlan(answer.data); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [deleted?.batch?.id, deleted?.etag, turn]);   // eslint-disable-line react-hooks/exhaustive-deps

  const blockers = Array.isArray(plan?.blockers) ? plan.blockers : [];
  // What does not come back (WP-D's restore plan: a port that says something else now, notes).
  const notes = ["ports_not_restored", "notes"].flatMap(k => (Array.isArray(plan?.consequences?.[k]) ? plan.consequences[k] : []))
    .map(x => (typeof x === "string" ? x : x?.text)).filter(Boolean);

  async function confirm() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      let restored = null;   // the Deleted-list restore's answer: its items and consequences.servers_restored
      await act.during(async () => {
        if (deleted) {
          restored = (await callJson("POST", "/api/lab/restore", { ...restoreBody, dry_run: false, plan_revision: plan?.plan_revision },
            deleted.etag ? { "If-Match": deleted.etag } : {})).data;
        } else {
          await restoreServer(record.key, removedList.etag);
        }
      });
      window.dispatchEvent(new Event("dcim-removed-servers"));
      await Promise.all([removedList.refresh?.().catch(() => {}), lab.reload()]);
      // A server that was removed from the lab before it was deleted comes back still removed, and the toast says so
      // (restoredText), so nobody looks for it on the racks. The old removal list's restore brings it back to the lab.
      act.toast(deleted ? restoredText(Array.isArray(restored?.items) && restored.items.length ? restored
        : { items: [{ kind: "server", id: record.key, name }], consequences: restored?.consequences }) : `${name} is back in the lab.`);
      close();
    } catch (e) {
      busyRef.current = false; setBusy(false);
      if (e.status === 409 || e.status === 428) {
        // The list or the lab changed in another session since the preview: read the list and preview the restore
        // again (a changed plan keeps the list's ETag), so the next Restore uses what is true now.
        await Promise.all([removedList.refresh?.().catch(() => {}), Promise.resolve(refreshDeleted())]);
        setPlan(null); setTurn(t => t + 1);
        setError(`${e.message} It was checked again; look at it and restore again.`);
      } else setError(e.message || "The server was not restored.");
    }
  }

  const titleId = "restore-server-title";
  // Restore waits until the Deleted list was read: a server in it comes back through its batch, never the old route.
  const ready = !listRead ? false : deleted ? !!plan && !blockers.length : true;
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) close(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="racks-dialog" data-dialog="restore-server">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">Restore <bdi>{name}</bdi>?</h2>
      {deleted ? <>
        <p className="racks-dialog-note">It comes back from the Deleted list: its outlet and KVM port names are written back where those ports are still free, and its monitor resumes if it was running.</p>
        {!plan && !error && <p className="racks-muted" role="status">Checking what comes back…</p>}
        {blockers.length > 0 && <ul className="remove-server-list mt-2" data-list="blockers">{blockers.map((b, i) => <li key={i} dir="auto" className="text-rose-300">{b?.text || String(b)}</li>)}</ul>}
        {notes.length > 0 && <ul className="remove-server-list mt-2" data-list="not-restored">{notes.map((t, i) => <li key={i} dir="auto">{t}</li>)}</ul>}
      </> : <p className="racks-dialog-note">It shows again from its PDU and KVM port names, and its monitor resumes if it was running.</p>}
      <p className="power-consequence">Its rack place, switch port and owner do not come back.</p>
      {error && <p role="alert" dir="auto" className="racks-dialog-error">{error}</p>}
      <div className="racks-dialog-actions">
        <button ref={cancelRef} type="button" className="racks-btn" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="racks-btn racks-btn-primary" data-action="confirm-restore" disabled={busy || !ready} onClick={confirm}>
          {busy ? "Restoring…" : "Restore"}</button>
      </div>
    </section>
  </div>;
}

function Dialogs({ dialog, record, can, act, close }) {
  if (dialog?.type !== "restore" || !can.admin || !record?.removed) return null;
  return <RestoreDialog record={record} act={act} close={close}/>;
}

export default { more, Banner, Dialogs, dialogTypes: ["restore"] };
