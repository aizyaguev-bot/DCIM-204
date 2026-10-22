// The Racks overview's summary tiles and its sticky find / filter / jump toolbar.

const FILTERS = [["all", "All"], ["off", "Off"], ["no-reading", "No reading"], ["maintenance", "Maintenance"]];
const FILTER_TEXT = Object.fromEntries(FILTERS);

const Skeleton = () => <span className="skeleton" aria-hidden="true"/>;

// Four tiles. While no PDU has reported yet the figures are skeletons (never "0/28").
export function RackKpis({ loading, totalKw, totalA, partial, serversOn, serversTotal, serversOff, noReading, racks, racksOnline, racksOffline, attention }) {
  const sub = text => (loading ? "Reading PDUs…" : text);
  return <div className="rack-kpis" aria-busy={loading ? "true" : undefined}>
    <div className="rack-kpi" data-kpi="draw"><strong style={{ color: "#9fe040" }}>{loading ? <Skeleton/> : totalKw}</strong><span>Total draw</span>
      <small>{sub(`${totalA} floor current${partial ? " · partial" : ""}`)}</small></div>
    <div className="rack-kpi" data-kpi="servers"><strong>{loading ? <Skeleton/> : `${serversOn}/${serversTotal}`}</strong><span>Servers on</span>
      <small>{sub(`${serversOff} off · ${noReading} no reading`)}</small></div>
    <div className="rack-kpi" data-kpi="racks"><strong>{racks}</strong><span>Racks</span>
      <small>{sub(`${racksOnline} online${racksOffline ? ` · ${racksOffline} offline` : ""}`)}</small></div>
    <div className="rack-kpi" data-kpi="attention">
      <strong style={attention.length || loading ? undefined : { color: "#9fe040" }}>{loading ? <Skeleton/> : attention.length ? attention.reduce((n, a) => n + a.count, 0) : "All clear"}</strong>
      <span>Need attention</span>
      {!loading && attention.length > 0 && <div className="rack-kpi-chips">{attention.slice(0, 4).map(a => a.onClick
        ? <button key={a.key} type="button" className="racks-chip" data-attention={a.key} onClick={a.onClick}>{a.label}</button>
        : <small key={a.key}>{a.label}</small>)}</div>}
      {loading && <small>Reading PDUs…</small>}
    </div>
  </div>;
}

export function RacksToolbar({ phone, searchRef, query, onQuery, onSearchKey, count, filter, onFilter, filterCounts, editMode,
  rackChips, onJump, showEmpty, onShowEmpty, allCollapsed, onToggleAll, coolingOpen, onToggleCooling, coolingTotal, coolingNeeds }) {
  const filterOff = editMode ? "Filters are off in Edit mode so every shelf stays a drop target" : undefined;
  const coolingLabel = `Cooling units ${coolingTotal}${coolingNeeds ? `, ${coolingNeeds} need a place` : ""}`;
  return <div className="racks-toolbar" role="search" aria-label="Find in racks">
    <div className="racks-toolbar-row">
      <label className="racks-search">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>
        <input ref={searchRef} type="search" dir="auto" value={query} placeholder="Find server, owner, switch…"
          aria-label="Find server, owner, switch, equipment or cooling unit" onChange={e => onQuery(e.target.value)} onKeyDown={onSearchKey}/>
      </label>
      {!phone && <span className="racks-count" aria-live="polite">{count}</span>}
      {phone ? <>
        <select className="racks-select" aria-label="Show servers" value={filter} disabled={editMode} title={filterOff}
          onChange={e => onFilter(e.target.value)}>
          {FILTERS.map(([id, label]) => <option key={id} value={id}>{label} ({filterCounts[id] ?? 0})</option>)}
        </select>
        <select className="racks-select" aria-label="Jump to rack" value="" onChange={e => { if (e.target.value) onJump(e.target.value); }}>
          <option value="">Racks…</option>
          {rackChips.map(r => <option key={r.rack} value={r.rack}>{r.rack} · {r.on}/{r.total}</option>)}
        </select>
        <button type="button" className="racks-chip racks-cooling-toggle" aria-expanded={coolingOpen} aria-controls="cooling-panel"
          aria-label={coolingLabel} onClick={onToggleCooling}><span aria-hidden="true">❄</span>{coolingNeeds > 0 && <span className="badge-amber" aria-hidden="true">{coolingNeeds}</span>}</button>
      </> : null}
    </div>
    {phone && <span className="racks-count" aria-live="polite">{count}</span>}
    {!phone && <div className="racks-toolbar-row racks-toolbar-wrap">
      <div role="group" aria-label="Show servers" className="racks-filter">
        {FILTERS.map(([id, label]) => <button key={id} type="button" className="racks-chip" aria-pressed={filter === id}
          aria-disabled={editMode ? "true" : undefined} title={filterOff} data-filter={id}
          onClick={() => { if (!editMode) onFilter(id); }}>{label} <small>{filterCounts[id] ?? 0}</small></button>)}
      </div>
      <nav aria-label="Jump to rack" className="racks-jump">
        {rackChips.map(r => <button key={r.rack} type="button" className="racks-chip" data-status={r.status} data-rack={r.rack}
          onClick={() => onJump(r.rack)} title={`Go to ${r.rack} · ${r.statusText}`}>
          <span className="dot" aria-hidden="true"/><span dir="auto">{r.rack}</span> <small>{r.storage ? "storage" : `${r.on}/${r.total}`}</small></button>)}
      </nav>
      <div className="racks-options">
        <button type="button" className="racks-chip" aria-pressed={showEmpty} onClick={() => onShowEmpty(!showEmpty)}
          title={editMode ? "Edit mode always shows every shelf" : undefined}>Empty shelves</button>
        <button type="button" className="racks-chip" onClick={onToggleAll}>{allCollapsed ? "Expand all" : "Collapse all"}</button>
        <button type="button" className="racks-chip racks-cooling-toggle" aria-expanded={coolingOpen} aria-controls="cooling-panel" onClick={onToggleCooling}>
          <span aria-hidden="true">❄</span> Cooling units <small>{coolingTotal}</small>
          {coolingNeeds > 0 && <span className="badge-amber">{coolingNeeds} need a place</span>}</button>
      </div>
    </div>}
  </div>;
}

export function filterEmptyText(filter) {
  return { off: "No servers are off.", "no-reading": "Every PDU is reporting.", maintenance: "No PDU is in maintenance." }[filter] || `No servers match ${FILTER_TEXT[filter] || filter}.`;
}
