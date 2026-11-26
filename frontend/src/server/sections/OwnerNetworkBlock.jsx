// Owner & network (one-place spec v1 §1.3, WP-2): the owner (Operator edits with OwnerSelect; written under every key
// of ownerWriteKeys(record), in order, stopping at the first failure; a guarded Undo), the switch port (draft and an
// explicit Save, PUT /api/switch-assignments with If-Match; withSwitch writes the value under every DCIM id) and the
// project (derived from the floor's first unit, read-only). Viewers read the same values. Props: { record, can, act }.
import { useEffect, useRef, useState } from "react";
import { accountRequest } from "../../accounts.jsx";
import { OwnerSelect } from "../../engineers.jsx";
import { useLabWindow } from "../../window/labWindowContext.js";
import { WindowSection } from "../../window/WindowShell.jsx";
import { ownerWriteKeys, withSwitch } from "../ownerKey.js";
import { ownerChangedSince, ownerSummary, ownerUndoPlan, partialOwnerText, perKeyText, sameSwitch, switchText, switchValue, writeEveryKey } from "../serverIdentity.js";
import "../../units/units.css";

// One owner key (Operator). Never the unkeyed PUT /api/opt-owners: it is Admin only and replaces every owner.
const putOwner = (key, engineerId) => accountRequest(`/opt-owners/${encodeURIComponent(key)}`, "PUT", { engineer_id: engineerId });

function OwnerField({ record, can, act }) {
  const { data } = useLabWindow();
  const owner = record.owner;
  const keys = ownerWriteKeys(record);

  // OwnerSelect shows "Saving…", then "Saved" or the error this throws.
  async function choose(engineerId) {
    const person = (data.engineers || []).find(e => e.id === engineerId) || null;
    const written = person ? person.name : "";
    const before = { ...owner.perKey };
    const result = await act.during(() => writeEveryKey(keys, key => putOwner(key, engineerId)));
    await act.reload(["owners"]);
    if (result.failed) throw new Error(partialOwnerText(result, keys));
    const undo = ownerUndoPlan(keys, before, data.engineers);
    const what = written ? `Owner of ${record.name} set to ${written}.` : `Owner of ${record.name} cleared.`;
    act.toast(undo.ok ? what : `${what} ${undo.why}`, { undo: undo.ok ? () => undoOwner(undo.writes, written, before) : null });
  }

  // Guarded Undo: it reverts only when every key still holds what this window wrote (PUT /api/opt-owners/{key} is
  // last-write-wins, so a change another session made meanwhile is never overwritten).
  async function undoOwner(writes, written, before) {
    try {
      const live = await accountRequest("/opt-owners");
      const changed = ownerChangedSince(keys, written, live);
      if (changed.length) {
        act.toast(`Not undone: the owner of ${record.name} was changed in another session.`, { tone: "error" });
        await act.reload(["owners"]);
        return;
      }
      const byKey = new Map(writes.map(w => [w.key, w.engineer_id]));
      const back = await act.during(() => writeEveryKey(keys, key => putOwner(key, byKey.get(key) ?? null)));
      await act.reload(["owners"]);
      if (back.failed) act.toast(`Not fully undone. ${partialOwnerText(back, keys)}`, { tone: "error" });
      else act.toast(`Owner of ${record.name} is back to ${ownerSummary(record, before)}.`);
    } catch (e) {
      act.toast(`Not undone: ${e.message || e}`, { tone: "error" });
    }
  }

  return <div className="unit-form-pair" data-owner-block="">
    <dt>Owner</dt>
    <dd>
      {can.operate
        ? <OwnerSelect owner={owner.value} label={`Owner for ${record.name}`} disabled={data.owners == null} onChange={choose}/>
        : <span dir="auto" data-owner-value="">{owner.value || "No owner"}</span>}
      {owner.disagree && <p className="lab-window-muted mt-1" dir="auto" data-owner-disagree="">
        Feeds disagree: {perKeyText(record, owner.perKey)}{can.operate ? " — choosing an owner sets both." : "."}
      </p>}
      <p className="lab-window-muted mt-1">Units on this floor show this owner.</p>
    </dd>
  </div>;
}

function SwitchField({ record, can, act }) {
  const { data } = useLabWindow();
  const base = record.switch.value;
  // Draft and base (MonitoringView's pattern): the fields follow the saved value until they are edited here.
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const busyRef = useRef(false);
  const shown = draft || { switch: base?.switch || "", port: base?.port || "" };
  let value = null, invalid = "";
  try { value = switchValue(shown); } catch (e) { invalid = e.message; }
  const dirty = !!draft && !sameSwitch(value, base);
  // The saved value caught up with the draft (this save, or the same value saved elsewhere): back to following it.
  useEffect(() => { if (draft && !invalid && sameSwitch(value, base)) setDraft(null); }, [base?.switch, base?.port]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e) {
    e?.preventDefault();
    if (busyRef.current || !dirty || invalid) return;
    busyRef.current = true; setBusy(true); setError(""); setSaved(false);
    try {
      // The If-Match is the ETag of the document this window shows: a change saved elsewhere since is refused (409).
      await act.during(async () => {
        const response = await fetch("/api/switch-assignments", {
          method: "PUT", cache: "no-store",
          headers: { "Content-Type": "application/json", ...(data.etags?.switches ? { "If-Match": data.etags.switches } : {}) },
          body: JSON.stringify(withSwitch(data.switches, record, value)),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const err = new Error(typeof body.detail === "string" ? body.detail : `The switch port was not saved (HTTP ${response.status}).`);
          err.status = response.status;
          throw err;
        }
      });
      setSaved(true);
      act.toast(value ? `Switch of ${record.name} set to ${switchText(value)}.` : `Switch of ${record.name} cleared.`);
    } catch (err) {
      setError(err.status === 409 || err.status === 428
        ? "The switch list changed in another session, so nothing was saved. It was read again; check the values and save again."
        : err.message || String(err));
    } finally {
      busyRef.current = false; setBusy(false);
      await act.reload(["layout"]);
    }
  }

  return <div className="unit-form-pair" data-switch-block="">
    <dt>Switch</dt>
    <dd>
      {can.operate ? <form className="unit-form-row" onSubmit={save}>
        <label className="unit-form-inline"><span>Switch</span>
          <input value={shown.switch} dir="auto" maxLength={120} disabled={busy} aria-label={`Switch for ${record.name}`} autoComplete="off"
            onChange={e => { setSaved(false); setError(""); setDraft({ ...shown, switch: e.target.value }); }}/></label>
        <label className="unit-form-inline unit-form-narrow"><span>Port</span>
          <input value={shown.port} dir="auto" maxLength={40} disabled={busy} aria-label={`Switch port for ${record.name}`} autoComplete="off"
            onChange={e => { setSaved(false); setError(""); setDraft({ ...shown, port: e.target.value }); }}/></label>
        <button type="submit" className="lab-window-btn" data-action="save-switch" disabled={busy || !dirty || !!invalid || data.switches == null}>{busy ? "Saving…" : "Save"}</button>
        {dirty && !busy && <button type="button" className="lab-window-link" onClick={() => { setDraft(null); setError(""); }}>Reset</button>}
      </form> : <span dir="auto" data-switch-value="">{switchText(base)}</span>}
      {invalid && <p role="alert" className="unit-form-error">{invalid}</p>}
      {error && <p role="alert" className="unit-form-error" dir="auto" data-switch-error="">{error}</p>}
      {saved && !dirty && !error && <p role="status" className="lab-window-muted mt-1">Saved.</p>}
      {record.switch.disagree && <p className="lab-window-muted mt-1" dir="auto" data-switch-disagree="">
        The feeds have different switch ports: {perKeyText(record, record.switch.perKey, switchText)}{can.operate ? " — saving sets every feed." : "."}
      </p>}
    </dd>
  </div>;
}

export default function OwnerNetworkBlock({ record, can, act }) {
  return <WindowSection title="Owner & network" id="owner">
    <dl className="lab-window-dl unit-form-dl">
      <OwnerField record={record} can={can} act={act}/>
      <SwitchField record={record} can={can} act={act}/>
      <div className="unit-form-pair">
        <dt>Project</dt>
        <dd dir="auto" data-project="">{record.project || "—"}{record.project ? <span className="lab-window-muted"> (from the first unit on its floor)</span> : null}</dd>
      </div>
    </dl>
  </WindowSection>;
}
