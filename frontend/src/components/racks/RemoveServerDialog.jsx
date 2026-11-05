import { useCallback, useEffect, useRef, useState } from "react";
import useDialogFocus from "./useDialogFocus.js";
import { describeRemoval, previewRemoval, removeServer } from "../../api/removedServers.js";

const MAX_REASON = 300;

// Admin: "Remove from lab" confirmation. It previews the removal (what is cleaned and what stays), names the server and
// takes an optional reason. Nothing is written to a PDU or KVM: the server is hidden from every page and its DCIM data
// (rack position, switch port, owner) is cleaned; Restore (Admin → Removed servers, or Undo) shows it again but does
// not bring that data back. onRemoved(result) gets the server's answer; onClose() cancels.
export default function RemoveServerDialog({ serverName, onRemoved, onClose }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const cancelRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: cancelRef, busyRef, onEscape: onClose });

  const preview = useCallback(async () => {
    setPlan(null); setError("");
    try { setPlan(await previewRemoval(serverName)); }
    catch (e) { setError(e.message || "The removal could not be previewed."); }
  }, [serverName]);
  useEffect(() => { preview(); }, [preview]);

  async function confirm() {
    if (busyRef.current || !plan) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await removeServer(serverName, { reason: reason.trim(), planRevision: plan.plan_revision });
      busyRef.current = false;
      onRemoved(result, plan);
    } catch (e) {
      busyRef.current = false; setBusy(false);
      setError(e.message || "The server was not removed.");
      if (e.status === 409) preview().then(() => setError(`${e.message} The list below is up to date now.`));
    }
  }

  const { cleaned, kept } = describeRemoval(plan);
  const name = plan?.name || serverName;
  const titleId = "remove-server-title", bodyId = "remove-server-body";
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) onClose(); }}>
    <section ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}
      className="racks-dialog" data-dialog="remove-server">
      <h2 id={titleId} dir="auto" className="racks-dialog-title">Remove <bdi>{name}</bdi> from the lab?</h2>
      <div id={bodyId}>
        <p className="racks-dialog-note">It disappears from Racks, monitoring, the lab display, owners, SSH and the 3D twin.
          Use this for a server that is no longer in the lab.</p>
        {!plan && !error && <p className="racks-muted" role="status">Checking what will be cleaned…</p>}
        {plan && <>
          <h3 className="racks-dialog-subtitle">Cleaned</h3>
          {cleaned.length ? <ul className="remove-server-list" data-list="cleaned">{cleaned.map(t => <li key={t} dir="auto">{t}</li>)}</ul>
            : <p className="racks-muted">No rack position, switch port, owner or monitor is saved for it.</p>}
          {kept.length > 0 && <><h3 className="racks-dialog-subtitle">Not changed</h3>
            <ul className="remove-server-list" data-list="kept">{kept.map(t => <li key={t} dir="auto">{t}</li>)}</ul></>}
          <p className="power-consequence">Restore shows the server again from its PDU label, but its rack position, switch port and owner are not brought back.</p>
          <div className="racks-field">
            <label htmlFor="remove-server-reason">Reason (optional)</label>
            <input id="remove-server-reason" value={reason} maxLength={MAX_REASON} disabled={busy} dir="auto"
              placeholder="e.g. Returned to vendor" onChange={e => setReason(e.target.value)}/>
          </div>
        </>}
        {error && <p role="alert" dir="auto" className="racks-dialog-error">{error}</p>}
      </div>
      <div className="racks-dialog-actions">
        <button ref={cancelRef} type="button" className="racks-btn" disabled={busy} onClick={onClose}>Cancel</button>
        {!plan && error && <button type="button" className="racks-btn" onClick={preview}>Try again</button>}
        <button type="button" className="racks-btn racks-btn-danger" data-action="remove-server" disabled={busy || !plan} onClick={confirm}>
          {busy ? "Removing…" : "Remove from lab"}
        </button>
      </div>
    </section>
  </div>;
}
