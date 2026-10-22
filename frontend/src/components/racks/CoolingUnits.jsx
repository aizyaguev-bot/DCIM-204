import { useCallback, useEffect, useRef, useState } from "react";
import { validShelf, shelfLabel, describePlace } from "./chillers.js";

// ─── chip ─────────────────────────────────────────────────────────────────────
// One cooling unit as a button: on its shelf, in a rack's "not on a shelf" strip, or in the page panel.
// dragHandle: dnd-kit listeners/attributes/setNodeRef for Edit mode on the overview (null otherwise).
export function CoolingChip({ unit, variant = "shelf", onOpen, dragHandle = null, highlighted = false }) {
  const placed = validShelf(unit.u);
  const where = placed ? shelfLabel(unit.u) : unit.rack ? "no shelf" : "no rack";
  const { setNodeRef, listeners, attributes, isDragging } = dragHandle || {};
  // Only the pointer drags (no keyboard sensor): dnd-kit's role and keyboard instructions are dropped; the keyboard
  // and touch path is the dialog.
  return <button type="button" ref={setNodeRef} {...(attributes || {})} {...(listeners || {})} role={undefined} tabIndex={0}
    aria-roledescription={undefined} aria-describedby={undefined} aria-pressed={undefined}
    className="cooling-chip" data-unit-id={unit.id} data-variant={variant}
    data-placed={placed ? "" : undefined} data-unassigned={unit.rack ? undefined : ""} data-match={highlighted ? "" : undefined}
    data-dragging={isDragging ? "" : undefined} data-draggable={dragHandle ? "" : undefined}
    aria-label={`Cooling unit ${unit.name}, ${describePlace(unit)}`} title={`${unit.name} · ${describePlace(unit)}`}
    onClick={e => { e.stopPropagation(); onOpen?.(unit, e.currentTarget); }} onKeyDown={e => e.stopPropagation()}>
    <span aria-hidden="true" className="cooling-glyph">❄</span><span dir="auto" className="cooling-name">{unit.name}</span>
    {variant !== "shelf" && <span className="cooling-where">{where}</span>}
  </button>;
}

// ─── strip ────────────────────────────────────────────────────────────────────
// The rack's units that are not on a shelf, under its shelves. In Edit mode it is also the "not on a shelf" drop
// target and offers "+ Cooling". list: the rack detail's form, one line per unit with its place and action.
export function CoolingStrip({ rack, units, canEdit, editMode, onOpen, onAdd, list = false, dropRef = null, isOver = false, renderChip = null, matchKeys = null }) {
  const placed = Object.entries(units?.placed || {}).sort((a, b) => Number(a[0]) - Number(b[0])).flatMap(([, us]) => us);
  const unplaced = units?.unplaced || [];
  if (list) {
    const all = [...placed, ...unplaced];
    return <div className="cooling-list" ref={dropRef}>
      {all.length ? <ul>{all.map(unit => <li key={unit.id} data-unit-id={unit.id}>
        <span aria-hidden="true" className="cooling-glyph">❄</span><span dir="auto" className="cooling-name">{unit.name}</span>
        <span className="cooling-where">{validShelf(unit.u) ? shelfLabel(unit.u) : "Not on a shelf"}</span>
        <button type="button" className="racks-btn racks-btn-sm" onClick={e => onOpen(unit, e.currentTarget)}
          aria-label={`${canEdit ? (validShelf(unit.u) ? "Move" : "Place") : "Details of"} ${unit.name}`}>
          {canEdit ? (validShelf(unit.u) ? "Move…" : "Place…") : "Details"}</button>
      </li>)}</ul> : <p className="racks-muted">No cooling units in this rack.</p>}
      {canEdit && <button type="button" className="racks-btn racks-btn-sm" onClick={e => onAdd(rack, e.currentTarget)}>+ Cooling unit</button>}
    </div>;
  }
  if (!unplaced.length && !(editMode && canEdit)) return null;
  return <div className="cooling-strip" ref={dropRef} data-rack={rack} data-over={isOver ? "" : undefined}>
    <span className="cooling-strip-label">{unplaced.length ? "Not on a shelf" : "Cooling"}</span>
    {unplaced.map(unit => renderChip ? renderChip(unit)
      : <CoolingChip key={unit.id} unit={unit} variant="strip" onOpen={onOpen} highlighted={!!matchKeys?.has(`c:${unit.id}`)}/>)}
    {editMode && canEdit && <button type="button" className="cooling-add" onClick={e => onAdd(rack, e.currentTarget)}
      aria-label={`Add a cooling unit to ${rack}`}>+ Cooling</button>}
  </div>;
}

// ─── history ──────────────────────────────────────────────────────────────────
// Earlier versions of the cooling document (GET /api/chillers/history, Operator and up). Restoring writes that
// version back (POST /api/chillers/restore with the current ETag); "Bring back" re-adds one unit a save left out.
function when(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at ?? "") : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CoolingHistory({ canRestore, currentIds, onLoad, onRestore, onBringBack }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: false, error: "", versions: null });
  const [confirmRev, setConfirmRev] = useState(null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState("");
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setState(s => ({ ...s, loading: true, error: "" }));
    try {
      const versions = await onLoad();
      if (mine === seq.current) setState({ loading: false, error: "", versions });
    } catch (e) {
      if (mine === seq.current) setState(s => ({ ...s, loading: false, error: e?.message || "The history could not load." }));
    }
  }, [onLoad]);
  useEffect(() => { if (open) load(); }, [open, load]);
  async function act(key, action) {
    if (busy) return;
    setBusy(key); setMessage("");
    try { await action(); setConfirmRev(null); await load(); }
    catch (e) { setMessage(e?.message || "Nothing was changed."); }
    finally { setBusy(null); }
  }
  return <details className="cooling-history" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Change history</summary>
    {state.loading && !state.versions && <p className="racks-muted">Loading history…</p>}
    {state.error && <p role="alert" className="racks-dialog-error">History could not load: {state.error} <button type="button" className="racks-link" onClick={load}>Retry</button></p>}
    {message && <p role="alert" dir="auto" className="racks-dialog-error">{message}</p>}
    {state.versions && !state.versions.length && <p className="racks-muted">No earlier versions yet. Every save from now on is kept here.</p>}
    {state.versions?.length > 0 && <ol className="cooling-history-list">{state.versions.map(v => {
      const missing = (v.removed || []).filter(u => u && !currentIds.has(u.id));
      return <li key={v.revision} data-revision={v.revision}>
        <div className="cooling-history-head">
          <span className="racks-mono">#{v.revision}</span>
          <span>{when(v.at)}</span>
          {v.by && <span dir="auto">by <bdi>{v.by}</bdi></span>}
          <span>{v.units} {v.units === 1 ? "unit" : "units"}</span>
          {canRestore && (v.units < currentIds.size
            // Restoring a version with fewer units would delete the ones added since: units are never deleted here.
            ? <span className="racks-muted" title="Restoring it would remove cooling units added since. Use Bring back or move units instead.">fewer units than now</span>
            : <button type="button" className="racks-btn racks-btn-sm" disabled={!!busy}
              aria-expanded={confirmRev === v.revision} onClick={() => setConfirmRev(r => (r === v.revision ? null : v.revision))}>Restore…</button>)}
        </div>
        {missing.length > 0 && <p className="cooling-history-removed">Left out by the next save: {missing.map((u, i) => <span key={u.id}>{i ? ", " : ""}
          <bdi>{u.name || u.id}</bdi>{canRestore && <> <button type="button" className="racks-link" disabled={!!busy}
            onClick={() => act(`b:${u.id}`, () => onBringBack(u))}>{busy === `b:${u.id}` ? "Bringing back…" : "Bring back"}</button></>}</span>)}</p>}
        {confirmRev === v.revision && <div className="cooling-history-confirm" role="group" aria-label={`Restore version ${v.revision}`}>
          <p>Put every cooling unit back where it was in version #{v.revision}? The current layout is kept in this history, so this can be undone.</p>
          <button type="button" className="racks-btn racks-btn-primary" disabled={!!busy} onClick={() => act(`r:${v.revision}`, () => onRestore(v.revision))}>{busy === `r:${v.revision}` ? "Restoring…" : `Restore #${v.revision}`}</button>
          <button type="button" className="racks-btn" disabled={!!busy} onClick={() => setConfirmRev(null)}>Cancel</button>
        </div>}
      </li>;
    })}</ol>}
    {!canRestore && state.versions?.length > 0 && <p className="racks-muted">Turn on Edit to restore an earlier version.</p>}
  </details>;
}

// ─── panel ────────────────────────────────────────────────────────────────────
// Every cooling unit on one panel: units that need a rack first, then rack by rack. In Edit mode (Operator and up)
// each row offers Place… or Move…, otherwise Details.
export function CoolingPanel({ groups, rackNames, loaded, loadError, canEdit, canOperate, editMode, lastChange, matchKeys,
  onOpen, onAdd, onUndo, onRetry, onClose, history }) {
  const total = groups.unassigned.length + rackNames.reduce((n, r) => n + (groups.byRack[r]?.unplaced.length || 0) + Object.values(groups.byRack[r]?.placed || {}).flat().length, 0);
  const row = (unit, place, needsRack = false) => {
    const placed = validShelf(unit.u);
    const label = canEdit ? (placed && !needsRack ? "Move…" : "Place…") : "Details";
    return <li key={unit.id} data-unit-id={unit.id} data-match={matchKeys?.has(`c:${unit.id}`) ? "" : undefined} data-needs-rack={needsRack ? "" : undefined}>
      <span aria-hidden="true" className="cooling-glyph">❄</span>
      <span dir="auto" className="cooling-name">{unit.name}</span>
      <span className="cooling-place" dir="auto">{place}</span>
      <button type="button" className="racks-btn racks-btn-sm" onClick={e => onOpen(unit, e.currentTarget)}
        aria-label={`${label.replace("…", "")} ${unit.name}`}>{label}</button>
    </li>;
  };
  const racksWithUnits = rackNames.filter(r => groups.byRack[r] && (groups.byRack[r].unplaced.length || Object.keys(groups.byRack[r].placed).length));
  return <section id="cooling-panel" className="cooling-panel" aria-labelledby="cooling-panel-title">
    <header className="cooling-panel-header">
      <h2 id="cooling-panel-title">Cooling units · {total}</h2>
      <div className="cooling-panel-actions">
        {editMode && canEdit && lastChange && <button type="button" className="racks-btn racks-btn-sm" onClick={onUndo}>Undo last change</button>}
        {editMode && canEdit && <button type="button" className="racks-btn racks-btn-sm racks-btn-primary" onClick={e => onAdd(null, e.currentTarget)}>+ Add cooling unit</button>}
        <button type="button" className="icon-btn" aria-label="Close the cooling units panel" onClick={onClose}>×</button>
      </div>
    </header>
    {loadError ? <p role="alert" className="racks-dialog-error">Cooling units could not load: {loadError}. <button type="button" className="racks-link" onClick={onRetry}>Retry</button></p>
      : !loaded ? <p className="racks-muted">Loading cooling units…</p>
      : !total ? <p className="racks-muted">No cooling units recorded.</p>
      : <div className="cooling-panel-groups">
        {groups.unassigned.length > 0 && <div className="cooling-group" data-group="needs-rack">
          <h3>Needs a rack ({groups.unassigned.length})</h3>
          <ul>{groups.unassigned.map(({ unit, reason }) => row(unit, reason === "rack-not-found"
            ? `${unit.rack} (not found)${validShelf(unit.u) ? ` · ${shelfLabel(unit.u)}` : ""}` : "No rack", true))}</ul>
        </div>}
        {racksWithUnits.map(rack => {
          const g = groups.byRack[rack];
          const units = [...Object.entries(g.placed).sort((a, b) => a[0] - b[0]).flatMap(([, us]) => us), ...g.unplaced];
          return <div key={rack} className="cooling-group" data-rack={rack}>
            <h3><bdi>{rack}</bdi> ({units.length})</h3>
            <ul>{units.map(unit => row(unit, validShelf(unit.u) ? shelfLabel(unit.u) : "Not on a shelf"))}</ul>
          </div>;
        })}
      </div>}
    {!editMode && canOperate && <p className="racks-muted">Turn on Edit to place, move or add cooling units.</p>}
    {canOperate && history && <CoolingHistory canRestore={editMode && canEdit && !loadError} currentIds={history.currentIds}
      onLoad={history.load} onRestore={history.restore} onBringBack={history.bringBack}/>}
  </section>;
}
