export default function InventoryRackCard({ rack, items, error, onOpen }) {
  return <section className="device-card" aria-label={rack.name} data-inventory-rack={rack.rack}>
    <div className="device-card-header">
      <div className="device-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 3h16v18H4zM4 9h16M4 15h16M8 6h.01M8 12h.01M8 18h.01"/></svg></div>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left group">
        <span className="device-name group-hover:text-nv-400 block truncate">{rack.name}</span>
        <span className="device-subtitle block truncate">{rack.model || "Inventory rack"} · {rack.rack}</span>
      </button>
      <button onClick={onOpen} className="device-details">Details →</button>
    </div>
    <div className="px-4 py-3 text-xs text-zinc-400">
      {error ? <p role="alert">Inventory could not load. {error}</p> : items == null ? <p>Loading inventory…</p> : items.length === 0 ? <p>No equipment registered in this rack.</p> : <ul className="space-y-2">
        {items.slice(0, 4).map(item => <li key={item.id} className="flex gap-3 justify-between min-w-0">
          <span className="truncate text-zinc-200" title={item.name}>{item.name}</span>
          <span className="shrink-0">{Number(item.u) > 0 ? `Shelf ${String(item.u).padStart(2, "0")}` : "Whole rack"}</span>
        </li>)}
        {items.length > 4 && <li>+{items.length - 4} more</li>}
      </ul>}
    </div>
    <div className="device-card-footer"><span>{!error && items != null ? `${items.length} equipment ${items.length === 1 ? "item" : "items"}` : "Inventory location"}</span><span>Rack inventory</span></div>
  </section>;
}
