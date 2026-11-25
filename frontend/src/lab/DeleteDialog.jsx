// The one delete dialog (v2 spec §D.2) for one item or many: servers, PDUs, KVMs, racks, units, cooling units and 3D-only
// records. The provider mounts it for act.openDelete(targets, { options, onDone }).
// Props: { targets: [{ kind, id }], options?: {}, onClose(), onDone(result) }   z-[60], data-dialog="delete"
//
// Step 1, the preview (POST /api/lab/delete with dry_run): Will be deleted (each item, with a red line when it shows signs
// of life; in a bulk preview those start unticked), Blocked (red; Delete stays disabled), Also changes, where it
// disappears; the options that apply; an optional reason. Step 2, confirm: one item without signs of life is a red
// button naming it, one with signs of life asks for its name, two or more for the count. A 409 for a changed plan runs
// the preview again and keeps the options. After the delete the open window closes and the provider toast offers Undo
// (the batch is restored when nothing blocks it).
//
// Kinds on the wire: server (identity key), device (PDU / KVM id), rack (rack name), unit (rack item id), cooling
// (cooling unit id), twin (lab-data.json id). A window's "dev" target is a device here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useDialogFocus from "../components/racks/useDialogFocus.js";
import { applyDelete, previewDelete, undoDelete } from "../api/labDelete.js";
import { useLabWindow } from "../window/labWindowContext.js";
import { MAX_REASON, applyOrRepreview, confirmRule, confirmed, defaultOptions, groupPlan, hasEvidence, initialSelection,
  optionsFor, restoredText, targetKey, undoText } from "./deletePlan.js";
import "./deleteDialog.css";

const KIND = { dev: "device" };
const KIND_WORD = { server: "Server", device: "PDU / KVM", rack: "Rack", unit: "Unit", cooling: "Cooling unit", twin: "3D record" };
const normalize = targets => (Array.isArray(targets) ? targets : [targets]).filter(t => t && t.kind && t.id != null)
  .map(t => ({ kind: KIND[t.kind] || t.kind, id: String(t.id) }));

export default function DeleteDialog({ targets = [], options: given = null, onClose, onDone }) {
  const lab = useLabWindow();
  const { act, can } = lab;
  const all = useMemo(() => normalize(targets), [targets]);
  const bulk = all.length > 1;
  const [options, setOptions] = useState(() => defaultOptions(all, given));
  const [selected, setSelected] = useState(null);        // Set of target keys, or null until the first preview
  const [first, setFirst] = useState(null);              // the first preview: every target's name and evidence
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const panelRef = useRef(null);
  const cancelRef = useRef(null);
  const seq = useRef(0);
  useDialogFocus(panelRef, { initialRef: cancelRef, busyRef, onEscape: () => { if (!busyRef.current) onClose?.(); } });

  const chosen = useMemo(() => (selected ? all.filter(t => selected.has(targetKey(t))) : all), [all, selected]);
  const preview = useCallback(async (list, opts) => {
    const turn = ++seq.current;
    setLoading(true);
    try {
      const fresh = list.length ? await previewDelete(list, opts) : null;
      if (turn !== seq.current) return null;
      setPlan(fresh);
      setError("");
      return fresh;
    } catch (e) {
      if (turn === seq.current) { setPlan(null); setError(e.message || "The delete could not be previewed."); }
      return null;
    } finally {
      if (turn === seq.current) setLoading(false);
    }
  }, []);

  // The first preview covers every target (their names and evidence); a bulk preview then unticks the ones with evidence.
  const start = useCallback(async () => {
    const fresh = await preview(all, options);
    if (!fresh) return;
    setFirst(fresh);
    const ticked = initialSelection(fresh.items);
    setSelected(ticked);
    if (ticked.size !== all.length) await preview(all.filter(t => ticked.has(targetKey(t))), options);
  }, [all, options, preview]);
  useEffect(() => { start(); return () => { seq.current++; }; }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const repreview = (nextSelected, nextOptions) => {
    setTyped("");
    preview(all.filter(t => nextSelected.has(targetKey(t))), nextOptions);
  };
  const toggle = key => {
    if (busyRef.current) return;
    const next = new Set(selected || []);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelected(next);
    repreview(next, options);
  };
  const setOption = (name, value) => {
    if (busyRef.current) return;
    const next = { ...options, [name]: value };
    setOptions(next);
    repreview(selected || new Set(all.map(targetKey)), next);
  };

  const rows = (first?.items || []).map(item => ({ ...item, key: targetKey(item) }));
  const shown = groupPlan(plan);
  const deleting = shown.items;
  const rule = deleting.length ? confirmRule(deleting) : null;
  const blocked = shown.blockers.length > 0;
  const ready = !!plan && !loading && !blocked && deleting.length > 0 && confirmed(rule, typed);
  const optionList = plan ? optionsFor(chosen, plan, can, options) : [];
  const title = all.length === 1 ? `Delete ${rows[0]?.name || all[0]?.id}?` : `Delete ${all.length} items?`;

  async function confirm() {
    if (!ready || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    const outcome = await applyOrRepreview({ applyDelete, previewDelete }, { targets: chosen, options, plan, reason: reason.trim() });
    busyRef.current = false; setBusy(false);
    if (outcome.plan) { setPlan(outcome.plan); setTyped(""); }
    if (outcome.error) { setError(outcome.error); return; }
    const result = outcome.result;
    const batch = result?.batch?.id;
    if (lab.current) lab.close();
    act.showResult?.(`delete:${batch}`, { title: undoText(result), lines: groupPlan(result).also.flatMap(g => g.rows).slice(0, 12) });
    act.toast(undoText(result), {
      undo: batch ? async () => {
        try {
          const undone = await undoDelete(batch);
          if (undone.restored) act.toast(restoredText(undone.plan));
          else act.toast(`Nothing was restored: ${undone.plan.blockers[0]?.text || "something blocks it."} Manage › Deleted lists the delete.`, { tone: "error" });
        } catch (e) {
          act.toast(`Nothing was restored: ${e.message}`, { tone: "error" });
        }
        act.reload?.();
      } : null,
    });
    onDone?.(result);
  }

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    onMouseDown={e => { if (e.target === e.currentTarget && !busyRef.current) onClose?.(); }}>
    <section ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="lab-delete-title" aria-describedby="lab-delete-body"
      tabIndex={-1} className="racks-dialog lab-delete" data-dialog="delete" aria-busy={loading || busy}>
      <h2 id="lab-delete-title" dir="auto" className="racks-dialog-title">{title}</h2>
      <div id="lab-delete-body" className="lab-delete-body">
        {!first && loading && <p className="racks-muted" role="status">Checking what this deletes…</p>}
        {first && <>
          <h3 className="racks-dialog-subtitle">Will be deleted</h3>
          <ul className="lab-delete-items" data-list="items">
            {rows.map(item => {
              const on = !selected || selected.has(item.key);
              return <li key={item.key} data-item={item.key} data-selected={on ? "true" : "false"}>
                <label className="lab-delete-item">
                  {bulk && <input type="checkbox" checked={on} disabled={busy} onChange={() => toggle(item.key)}
                    aria-label={`Delete ${item.name}`}/>}
                  <span dir="auto" className="lab-delete-name">{item.name}</span>
                  <span className="lab-delete-kind">{KIND_WORD[item.kind] || item.kind}</span>
                </label>
                {hasEvidence(item) && <p className="lab-delete-evidence" data-evidence="" dir="auto">{item.evidence.join(" · ")}</p>}
                {item.info?.length > 0 && <p className="lab-delete-info" dir="auto">{item.info.join(" · ")}</p>}
              </li>;
            })}
          </ul>
          {bulk && deleting.length === 0 && !loading && <p className="racks-muted" role="status">Tick at least one item to delete.</p>}
          {blocked && <section className="lab-delete-blocked" data-list="blockers" role="alert">
            <h3 className="racks-dialog-subtitle">Blocked</h3>
            <ul>{shown.blockers.map(text => <li key={text} dir="auto">{text}</li>)}</ul>
          </section>}
          {shown.also.length > 0 && <section data-list="also">
            <h3 className="racks-dialog-subtitle">Also changes</h3>
            {shown.also.map(group => <div key={group.key} className="lab-delete-group" data-group={group.key}>
              <h4>{group.title}</h4>
              <ul>{group.rows.map(text => <li key={text} dir="auto">{text}</li>)}</ul>
            </div>)}
          </section>}
          {shown.screens.length > 0 && <p className="lab-delete-screens" data-list="screens">
            Disappears from: {shown.screens.join(", ")}.</p>}
          {optionList.length > 0 && <fieldset className="lab-delete-options" disabled={busy}>
            <legend>Options</legend>
            {optionList.map(option => option.type === "radio"
              ? <div key={option.name} role="radiogroup" aria-label={option.label} className="lab-delete-radio" data-option={option.name}>
                  <span>{option.label}:</span>
                  {option.choices.map(([value, text]) => <label key={value}>
                    <input type="radio" name={`lab-delete-${option.name}`} value={value} checked={option.value === value}
                      onChange={() => setOption(option.name, value)}/> {text}
                  </label>)}
                </div>
              : <label key={option.name} className="lab-delete-option" data-option={option.name}>
                  <input type="checkbox" checked={option.value} onChange={e => setOption(option.name, e.target.checked)}/> {option.label}
                </label>)}
          </fieldset>}
          <div className="racks-field">
            <label htmlFor="lab-delete-reason">Reason (optional)</label>
            <input id="lab-delete-reason" value={reason} maxLength={MAX_REASON} disabled={busy} dir="auto"
              placeholder="e.g. Returned to vendor" onChange={e => setReason(e.target.value)}/>
          </div>
          <p className="power-consequence">Everything deleted here can be restored for 90 days (Manage › Deleted).</p>
          {rule && rule.mode !== "button" && !blocked && <div className="racks-field">
            <label htmlFor="lab-delete-confirm">{rule.prompt}</label>
            <input id="lab-delete-confirm" value={typed} disabled={busy || loading} dir="auto" autoComplete="off"
              data-confirm={rule.mode} onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") confirm(); }}/>
          </div>}
        </>}
        {loading && first && <p className="racks-muted" role="status">Checking again…</p>}
        {error && <p role="alert" dir="auto" className="racks-dialog-error">{error}</p>}
      </div>
      <div className="racks-dialog-actions">
        <button ref={cancelRef} type="button" className="racks-btn" disabled={busy} onClick={onClose}>Cancel</button>
        {!first && error && <button type="button" className="racks-btn" onClick={start}>Try again</button>}
        <button type="button" className="racks-btn racks-btn-danger" data-action="delete" disabled={!ready || busy} onClick={confirm}
          title={blocked ? "Fix what is blocked first" : undefined}>
          {busy ? "Deleting…" : rule?.label || "Delete"}
        </button>
      </div>
    </section>
  </div>;
}
