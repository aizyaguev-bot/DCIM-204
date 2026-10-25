// The Racks overview's summary tiles, the "need attention" row and the sticky find / filter / jump toolbar.

const FILTERS = [["all", "All"], ["off", "Off"], ["no-reading", "No reading"], ["maintenance", "Maintenance"]];
const FILTER_TEXT = Object.fromEntries(FILTERS);

const Skeleton = () => <span className="skeleton" aria-hidden="true"/>;
// A count that is not known yet (PDUs still reporting): never "0", which would read as "every server is off".
const Pending = () => <span aria-hidden="true">…</span>;

// Four tiles of the same height. While no PDU has reported yet the figures are skeletons (never "0/28"). The attention
// tile counts the kinds of issue; each issue is a chip in one row under the tiles (it applies a filter or opens the
// cooling panel).
export function RackKpis({ loading, totalKw, totalA, partial, serversOn, serversTotal, serversOff, noReading, racks, racksOnline, racksOffline, attention }) {
  const sub = text => (loading ? "Reading PDUs…" : text);
  const issues = attention.length;
  return <>
    <div className="rack-kpis" aria-busy={loading ? "true" : undefined}>
      <div className="rack-kpi" data-kpi="draw"><strong style={{ color: "#9fe040" }}>{loading ? <Skeleton/> : totalKw}</strong><span>Total draw</span>
        <small>{sub(`${totalA} floor current${partial ? " · partial" : ""}`)}</small></div>
      <div className="rack-kpi" data-kpi="servers"><strong>{loading ? <Skeleton/> : `${serversOn}/${serversTotal}`}</strong><span>Servers on</span>
        <small>{sub(`${serversOff} off · ${noReading} no reading`)}</small></div>
      <div className="rack-kpi" data-kpi="racks"><strong>{racks}</strong><span>Racks</span>
        <small>{sub(`${racksOnline} online${racksOffline ? ` · ${racksOffline} offline` : ""}`)}</small></div>
      <div className="rack-kpi" data-kpi="attention">
        <strong style={issues || loading ? undefined : { color: "#9fe040" }}>{loading ? <Skeleton/> : issues ? `${issues} ${issues === 1 ? "issue" : "issues"}` : "All clear"}</strong>
        <span>Need attention</span>
        <small>{sub(issues ? "Choose one below" : "Nothing needs attention")}</small>
      </div>
    </div>
    {!loading && issues > 0 && <div className="rack-attention-row" role="group" aria-label="Need attention">
      {attention.map(a => a.onClick
        ? <button key={a.key} type="button" className="racks-chip" data-attention={a.key} onClick={a.onClick}>{a.label}</button>
        : <span key={a.key} className="racks-chip racks-chip-static" data-attention={a.key}>{a.label}</span>)}
    </div>}
  </>;
}

// Desktop: row 1 search and count; row 2 filters and options; row 3 every rack as a chip (wrapping, never cut).
// Phone: row 1 the search box at full width (the count inside it); row 2 Show, Jump to rack and the cooling button.
export function RacksToolbar({ phone, loading = false, searchRef, query, onQuery, onSearchKey, count, filter, onFilter, filterCounts, editMode,
  rackChips, onJump, showEmpty, onShowEmpty, allCollapsed, onToggleAll, coolingOpen, onToggleCooling, coolingTotal, coolingNeeds }) {
  const filterOff = editMode ? "Filters are off in Edit mode so every shelf stays a drop target" : undefined;
  const coolingLabel = `Cooling units ${coolingTotal}${coolingNeeds ? `, ${coolingNeeds} need a place` : ""}`;
  const chipLoading = r => r.status === "loading";
  const search = <label className="racks-search">
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>
    <input ref={searchRef} type="search" dir="auto" value={query} placeholder="Find server, owner, switch…"
      aria-label="Find server, owner, switch, equipment or cooling unit" onChange={e => onQuery(e.target.value)} onKeyDown={onSearchKey}/>
    {phone && <span className="racks-count" aria-live="polite">{count}</span>}
  </label>;
  if (phone) {
    return <div className="racks-toolbar" role="search" aria-label="Find in racks" data-phone="">
      <div className="racks-toolbar-row">{search}</div>
      <div className="racks-toolbar-row racks-toolbar-phone">
        <select className="racks-select" aria-label="Show servers" value={filter} disabled={editMode} title={filterOff}
          aria-busy={loading ? "true" : undefined} onChange={e => onFilter(e.target.value)}>
          {FILTERS.map(([id, label]) => <option key={id} value={id}>{label} ({loading ? "…" : filterCounts[id] ?? 0})</option>)}
        </select>
        <select className="racks-select" aria-label="Jump to rack" value="" onChange={e => { if (e.target.value) onJump(e.target.value); }}>
          <option value="">Racks…</option>
          {rackChips.map(r => <option key={r.rack} value={r.rack}>{r.rack} · {r.storage ? "storage" : chipLoading(r) ? "…" : `${r.on}/${r.total}`}</option>)}
        </select>
        <button type="button" className="racks-chip racks-cooling-toggle" aria-expanded={coolingOpen} aria-controls="cooling-panel"
          aria-label={coolingLabel} onClick={onToggleCooling}><span aria-hidden="true">❄</span>{coolingNeeds > 0 && <span className="badge-amber" aria-hidden="true">{coolingNeeds}</span>}</button>
      </div>
    </div>;
  }
  return <div className="racks-toolbar" role="search" aria-label="Find in racks">
    <div className="racks-toolbar-row">
      {search}
      <span className="racks-count" aria-live="polite">{count}</span>
    </div>
    <div className="racks-toolbar-row racks-toolbar-wrap">
      <div role="group" aria-label="Show servers" className="racks-filter" aria-busy={loading ? "true" : undefined}>
        {FILTERS.map(([id, label]) => <button key={id} type="button" className="racks-chip" aria-pressed={filter === id}
          aria-disabled={editMode ? "true" : undefined} title={filterOff} data-filter={id}
          onClick={() => { if (!editMode) onFilter(id); }}>{label} <small>{loading ? <Pending/> : filterCounts[id] ?? 0}</small></button>)}
      </div>
      <div className="racks-options">
        <button type="button" className="racks-chip" aria-pressed={showEmpty} onClick={() => onShowEmpty(!showEmpty)}
          title={editMode ? "Edit mode always shows every shelf" : undefined}>Empty shelves</button>
        <button type="button" className="racks-chip" onClick={onToggleAll}>{allCollapsed ? "Expand all" : "Collapse all"}</button>
        <button type="button" className="racks-chip racks-cooling-toggle" aria-expanded={coolingOpen} aria-controls="cooling-panel" onClick={onToggleCooling}>
          <span aria-hidden="true">❄</span> Cooling units <small>{coolingTotal}</small>
          {coolingNeeds > 0 && <span className="badge-amber">{coolingNeeds} need a place</span>}</button>
      </div>
    </div>
    <nav aria-label="Jump to rack" className="racks-jump">
      {rackChips.map(r => <button key={r.rack} type="button" className="racks-chip" data-status={chipLoading(r) ? "loading" : r.status} data-rack={r.rack}
        onClick={() => onJump(r.rack)} title={`Go to ${r.rack} · ${r.statusText}`}>
        <span className="dot" aria-hidden="true"/><span dir="auto">{r.rack}</span> <small>{r.storage ? "storage" : chipLoading(r) ? <Pending/> : `${r.on}/${r.total}`}</small></button>)}
    </nav>
  </div>;
}

export function filterEmptyText(filter) {
  return { off: "No servers are off.", "no-reading": "Every PDU is reporting.", maintenance: "No PDU is in maintenance." }[filter] || `No servers match ${FILTER_TEXT[filter] || filter}.`;
}
