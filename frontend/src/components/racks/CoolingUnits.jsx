import { useCallback, useEffect, useRef, useState } from "react";
import { validShelf, shelfLabel, describePlace, placeChanges } from "./chillers.js";

// ─── chip ─────────────────────────────────────────────────────────────────────
// One cooling unit as a button: on its shelf, in a rack's "not on a shelf" strip, or in the page panel.
// dragHandle: dnd-kit listeners/attributes/setNodeRef for Edit mode on the overview (null otherwise).
// actionLabel ("Place…"): the chip opens the unit to be placed (an Operator outside Edit mode); it replaces "no shelf".
export function CoolingChip({ unit, variant = "shelf", onOpen, dragHandle = null, highlighted = false, actionLabel = null }) {
  const placed = validShelf(unit.u);
  const where = actionLabel || (placed ? shelfLabel(unit.u) : unit.rack ? "no shelf" : "no rack");
  const { setNodeRef, listeners, attributes, isDragging } = dragHandle || {};
  const label = `${actionLabel ? `${actionLabel.replace("…", "")} cooling unit` : "Cooling unit"} ${unit.name}, ${describePlace(unit)}`;
  // Only the pointer drags (no keyboard sensor): dnd-kit's role and keyboard instructions are dropped; the keyboard
  // and touch path is the dialog.
  return <button type="button" ref={setNodeRef} {...(attributes || {})} {...(listeners || {})} role={undefined} tabIndex={0}
    aria-roledescription={undefined} aria-describedby={undefined} aria-pressed={undefined}
    className="cooling-chip" data-unit-id={unit.id} data-variant={variant} data-action={actionLabel ? "" : undefined}
    data-placed={placed ? "" : undefined} data-unassigned={unit.rack ? undefined : ""} data-match={highlighted ? "" : undefined}
    data-dragging={isDragging ? "" : undefined} data-draggable={dragHandle ? "" : undefined}
    aria-label={label} title={`${unit.name} · ${describePlace(unit)}${actionLabel ? ` · ${actionLabel}` : ""}`}
    onClick={e => { e.stopPropagation(); onOpen?.(unit, e.currentTarget); }} onKeyDown={e => e.stopPropagation()}>
    <span aria-hidden="true" className="cooling-glyph">❄</span><span dir="auto" className="cooling-name">{unit.name}</span>
    {variant !== "shelf" && <span className="cooling-where">{where}</span>}
  </button>;
}

const placeLabel = (unit, needsRack = false) => (validShelf(unit.u) && !needsRack ? "Move…" : "Place…");

// ─── strip ────────────────────────────────────────────────────────────────────
// The rack's units that are not on a shelf, under its shelves. In Edit mode it is also the "not on a shelf" drop
// target and offers "+ Cooling". list: the rack detail's form, one line per unit with its place and action.
// canEdit: the unit can be placed or moved (Place… / Move…; outside Edit mode that turns Edit on), else Details.
export function CoolingStrip({ rack, units, canEdit, canAdd = canEdit, editMode, onOpen, onAdd, list = false, dropRef = null, isOver = false, renderChip = null, matchKeys = null }) {
  const placed = Object.entries(units?.placed || {}).sort((a, b) => Number(a[0]) - Number(b[0])).flatMap(([, us]) => us);
  const unplaced = units?.unplaced || [];
  if (list) {
    const all = [...placed, ...unplaced];
    return <div className="cooling-list" ref={dropRef}>
      {all.length ? <ul>{all.map(unit => <li key={unit.id} data-unit-id={unit.id}>
        <span aria-hidden="true" className="cooling-glyph">❄</span><span dir="auto" className="cooling-name">{unit.name}</span>
        <span className="cooling-where">{validShelf(unit.u) ? shelfLabel(unit.u) : "Not on a shelf"}</span>
        <button type="button" className="racks-btn racks-btn-sm" onClick={e => onOpen(unit, e.currentTarget)}
          aria-label={`${canEdit ? placeLabel(unit).replace("…", "") : "Details of"} ${unit.name}`}>
          {canEdit ? placeLabel(unit) : "Details"}</button>
      </li>)}</ul> : <p className="racks-muted">No cooling units in this rack.</p>}
      {canAdd && <button type="button" className="racks-btn racks-btn-sm" onClick={e => onAdd(rack, e.currentTarget)}>+ Cooling unit</button>}
    </div>;
  }
  if (!unplaced.length && !(editMode && canAdd)) return null;
  return <div className="cooling-strip" ref={dropRef} data-rack={rack} data-over={isOver ? "" : undefined}>
    <span className="cooling-strip-label">{unplaced.length ? "Not on a shelf" : "Cooling"}</span>
    {unplaced.map(unit => renderChip ? renderChip(unit)
      : <CoolingChip key={unit.id} unit={unit} variant="strip" onOpen={onOpen} highlighted={!!matchKeys?.has(`c:${unit.id}`)}/>)}
    {editMode && canAdd && <button type="button" className="cooling-add" onClick={e => onAdd(rack, e.currentTarget)}
      aria-label={`Add a cooling unit to ${rack}`}>+ Cooling</button>}
  </div>;
}

// ─── history ──────────────────────────────────────────────────────────────────
// Earlier versions of the cooling document (GET /api/chillers/history, Operator and up), newest first; each one says
// what the save after it changed. Restoring puts that version's places back and keeps every unit added since (the
// server merges, so a restore never deletes a unit); "Bring back" re-adds one unit an older server let a save leave out.
function when(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at ?? "") : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ChangeLine({ change }) {
  const name = <bdi>{change.name}</bdi>;
  const at = place => (place === "No rack" ? "with no rack" : <>at <bdi>{place}</bdi></>);
  if (change.from === null) return <li>{name}: added {at(change.to)}</li>;
  if (change.to === null) return <li>{name}: left out (was {change.from === "No rack" ? "not in a rack" : <bdi>{change.from}</bdi>})</li>;
  if (change.renamedFrom && change.from === change.to) return <li><bdi>{change.renamedFrom}</bdi> renamed to {name} (<bdi>{change.to}</bdi>)</li>;
  return <li>{change.renamedFrom ? <><bdi>{change.renamedFrom}</bdi> → </> : null}{name}: <bdi>{change.from}</bdi> → <bdi>{change.to}</bdi></li>;
}

const Chevron = () => <svg className="cooling-history-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6"/></svg>;

function CoolingHistory({ canRestore, currentIds, currentPlaces, onLoad, onRestore, onBringBack }) {
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
  const versions = state.versions || [];
  const count = state.versions ? ` (${versions.length} ${versions.length === 1 ? "version" : "versions"})` : "";
  return <details className="cooling-history" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary><Chevron/><span>Change history{count}</span></summary>
    {state.loading && !state.versions && <p className="racks-muted">Loading history…</p>}
    {state.error && <p role="alert" className="racks-dialog-error">History could not load: {state.error} <button type="button" className="racks-link" onClick={load}>Retry</button></p>}
    {message && <p role="alert" dir="auto" className="racks-dialog-error">{message}</p>}
    {state.versions && !versions.length && <p className="racks-muted">No earlier versions yet. Every save from now on is kept here.</p>}
    {versions.length > 0 && <ol className="cooling-history-list">{versions.map((v, i) => {
      const missing = (v.removed || []).filter(u => u && !currentIds.has(u.id));
      // The save after this version: the next newer version, or the current document for the newest one.
      const next = i === 0 ? currentPlaces : versions[i - 1].places;
      const changes = Array.isArray(v.places) && Array.isArray(next) ? placeChanges(v.places, next) : null;
      const later = i > 0 && versions[i - 1].revision !== v.revision + 1;
      const kept = Array.isArray(v.places) ? [...currentIds].filter(id => !v.places.some(p => p?.id === id)) : [];
      return <li key={v.revision} data-revision={v.revision}>
        <div className="cooling-history-head">
          <span className="racks-mono">#{v.revision}</span>
          {i === 0 && <strong className="cooling-history-tag">Before the last change</strong>}
          <span>{when(v.at)}</span>
          {v.by && <span dir="auto">by <bdi>{v.by}</bdi></span>}
          <span>{v.units} {v.units === 1 ? "unit" : "units"}</span>
          {canRestore && <button type="button" className="racks-btn racks-btn-sm" disabled={!!busy}
            aria-expanded={confirmRev === v.revision} onClick={() => setConfirmRev(r => (r === v.revision ? null : v.revision))}>Restore…</button>}
        </div>
        {changes && (changes.length ? <div className="cooling-history-changes">
          <span className="racks-muted">{later ? "Changed by later saves:" : i === 0 ? "The last change:" : "Changed by the next save:"}</span>
          <ul>{changes.slice(0, 3).map(c => <ChangeLine key={c.id} change={c}/>)}
            {changes.length > 3 && <li className="racks-muted">+{changes.length - 3} more</li>}</ul>
        </div> : <p className="racks-muted">No unit changed place after it.</p>)}
        {missing.length > 0 && <p className="cooling-history-removed">Left out by the next save: {missing.map((u, k) => <span key={u.id}>{k ? ", " : ""}
          <bdi>{u.name || u.id}</bdi>{canRestore && <> <button type="button" className="racks-link" disabled={!!busy}
            onClick={() => act(`b:${u.id}`, () => onBringBack(u))}>{busy === `b:${u.id}` ? "Bringing back…" : "Bring back"}</button></>}</span>)}</p>}
        {confirmRev === v.revision && <div className="cooling-history-confirm" role="group" aria-label={`Restore version ${v.revision}`}>
          <p>Put every cooling unit of version #{v.revision} back where it was then?{kept.length > 0 && ` ${kept.length} ${kept.length === 1 ? "unit" : "units"} added since ${kept.length === 1 ? "stays" : "stay"} where ${kept.length === 1 ? "it is" : "they are"}.`} The current layout is kept in this history, so this can be undone.</p>
          <button type="button" className="racks-btn racks-btn-primary" disabled={!!busy} onClick={() => act(`r:${v.revision}`, () => onRestore(v.revision))}>{busy === `r:${v.revision}` ? "Restoring…" : `Restore #${v.revision}`}</button>
          <button type="button" className="racks-btn" disabled={!!busy} onClick={() => setConfirmRev(null)}>Cancel</button>
        </div>}
      </li>;
    })}</ol>}
    {!canRestore && versions.length > 0 && <p className="racks-muted">Turn on Edit to restore an earlier version.</p>}
  </details>;
}

// ─── panel ────────────────────────────────────────────────────────────────────
// The cooling units that need a place first: units with no rack (or a rack that is gone) and every rack's units that
// are not on a shelf; units on a shelf are one line per rack until "Show all". A search shows only the units it
// matches. Rows offer Place… / Move… (canPlace: Operator and up; outside Edit mode it turns Edit on), else Details.
// On a phone the panel can be folded to its header (expanded / onExpand).
export function CoolingPanel({ groups, rackNames, loaded, loadError, canEdit, canPlace, canOperate, editMode, lastChange, matchKeys,
  onOpen, onPlace, onAdd, onUndo, onRetry, onClose, history, phone = false, expanded = true, onExpand }) {
  const [showAll, setShowAll] = useState(false);
  const searching = !!matchKeys;
  const hit = unit => !searching || matchKeys.has(`c:${unit.id}`);
  const racks = rackNames.map(rack => {
    const g = groups.byRack[rack];
    if (!g) return null;
    return { rack, placed: Object.entries(g.placed).sort((a, b) => a[0] - b[0]).flatMap(([, us]) => us), unplaced: g.unplaced };
  }).filter(r => r && (r.placed.length || r.unplaced.length));
  const total = groups.unassigned.length + racks.reduce((n, r) => n + r.placed.length + r.unplaced.length, 0);
  const needs = groups.unassigned.length;
  const detailed = showAll || searching;
  const row = (unit, place, needsRack = false) => {
    const label = canPlace ? placeLabel(unit, needsRack) : "Details";
    return <li key={unit.id} data-unit-id={unit.id} data-match={matchKeys?.has(`c:${unit.id}`) ? "" : undefined} data-needs-rack={needsRack ? "" : undefined}>
      <span aria-hidden="true" className="cooling-glyph">❄</span>
      <span dir="auto" className="cooling-name">{unit.name}</span>
      <span className="cooling-place" dir="auto">{place}</span>
      <button type="button" className="racks-btn racks-btn-sm" onClick={e => (canPlace ? onPlace : onOpen)(unit, e.currentTarget)}
        aria-label={`${label.replace("…", "")} ${unit.name}`}>{label}</button>
    </li>;
  };
  const needsRows = groups.unassigned.filter(({ unit }) => hit(unit));
  const rackGroups = racks.map(r => ({ ...r, rows: [...(detailed ? r.placed : []), ...r.unplaced].filter(hit) })).filter(r => r.rows.length);
  const onShelf = detailed ? [] : racks.filter(r => r.placed.length);
  const folded = phone && !expanded && !searching;
  return <section id="cooling-panel" className="cooling-panel" aria-labelledby="cooling-panel-title" data-folded={folded ? "" : undefined}>
    <header className="cooling-panel-header">
      <h2 id="cooling-panel-title">Cooling units · {total}{needs > 0 && <span className="badge-amber">{needs} need a place</span>}</h2>
      <div className="cooling-panel-actions">
        {!folded && editMode && canEdit && lastChange && <button type="button" className="racks-btn racks-btn-sm" onClick={onUndo}>Undo last change</button>}
        {!folded && editMode && canEdit && <button type="button" className="racks-btn racks-btn-sm racks-btn-primary" onClick={e => onAdd(null, e.currentTarget)}>+ Add cooling unit</button>}
        {phone && !searching && <button type="button" className="racks-btn racks-btn-sm cooling-panel-show" aria-expanded={expanded} aria-controls="cooling-panel-body"
          onClick={() => onExpand?.(!expanded)}>{expanded ? "Hide" : "Show"}</button>}
        <button type="button" className="icon-btn" aria-label="Close the cooling units panel" onClick={onClose}>×</button>
      </div>
    </header>
    {!folded && <div id="cooling-panel-body" className="cooling-panel-body">
      {loadError ? <p role="alert" className="racks-dialog-error">Cooling units could not load: {loadError}. <button type="button" className="racks-link" onClick={onRetry}>Retry</button></p>
        : !loaded ? <p className="racks-muted">Loading cooling units…</p>
        : !total ? <p className="racks-muted">No cooling units recorded.</p>
        : <>
          {(needsRows.length > 0 || rackGroups.length > 0) ? <div className="cooling-panel-groups">
            {needsRows.length > 0 && <div className="cooling-group" data-group="needs-rack">
              <h3>Needs a rack ({needsRows.length})</h3>
              <ul>{needsRows.map(({ unit, reason }) => row(unit, reason === "rack-not-found"
                ? `${unit.rack} (not found)${validShelf(unit.u) ? ` · ${shelfLabel(unit.u)}` : ""}` : "No rack", true))}</ul>
            </div>}
            {rackGroups.map(r => <div key={r.rack} className="cooling-group" data-rack={r.rack}>
              <h3><bdi>{r.rack}</bdi> {detailed ? `(${r.rows.length})` : `· not on a shelf (${r.rows.length})`}</h3>
              <ul>{r.rows.map(unit => row(unit, validShelf(unit.u) ? shelfLabel(unit.u) : "Not on a shelf"))}</ul>
            </div>)}
          </div> : !searching && <p className="racks-muted">Every cooling unit is on a shelf.</p>}
          {onShelf.length > 0 && <div className="cooling-on-shelf">
            <span className="racks-muted">On a shelf:</span>
            <ul>{onShelf.map(r => <li key={r.rack} data-rack={r.rack} title={`${r.rack}: ${r.placed.length} on a shelf`}><bdi>{r.rack}</bdi> · {r.placed.length}</li>)}</ul>
          </div>}
        </>}
      {(loaded && !loadError && total > 0 && !searching) || (!editMode && canOperate) ? <div className="cooling-panel-foot">
        {loaded && !loadError && total > 0 && !searching && <button type="button" className="racks-link cooling-show-all" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>
          {showAll ? "Show only units that need a place" : `Show all ${total} units`}</button>}
        {!editMode && canPlace && <span className="racks-muted">Place… and Move… turn on Edit mode; turn on Edit to add a unit.</span>}
        {!editMode && canOperate && !canPlace && <span className="racks-muted">Turn on Edit to place, move or add cooling units.</span>}
      </div> : null}
      {canOperate && history && <CoolingHistory canRestore={editMode && canEdit && !loadError} currentIds={history.currentIds}
        currentPlaces={history.currentPlaces} onLoad={history.load} onRestore={history.restore} onBringBack={history.bringBack}/>}
    </div>}
  </section>;
}
