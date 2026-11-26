import { useId, useMemo, useState } from "react";
import { matchServers, serverPlaceText } from "./moveModel.js";

// The search picker of "Swap with…" and "Take over a place…": type a server's name, Enter (or a click) picks the
// highlighted one, the arrow keys move the highlight. Removed servers and the server itself are never offered
// (moveModel.matchServers).
//
// servers: moveModel.moveServers(); except: the key of the window's server; value: the picked server or null;
// onPick(key | null): null when the text no longer names the picked server.
export default function SwapWithPicker({ label, servers, except, value, onPick, disabled = false, inputRef = null }) {
  const id = useId();
  const [query, setQuery] = useState(value?.name || "");
  const [open, setOpen] = useState(!value);
  const [active, setActive] = useState(0);
  const hits = useMemo(() => matchServers(servers, query, except), [servers, query, except]);
  const listId = `${id}-list`;
  const optionId = i => `${id}-option-${i}`;
  const shown = open && !disabled;

  function pick(server) {
    if (!server) return;
    setQuery(server.name);
    setOpen(false);
    setActive(0);
    onPick(server.key);
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const n = hits.length;
      if (n) setActive(i => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown && hits.length) pick(hits[Math.min(active, hits.length - 1)]);
    }
  }

  return <div className="racks-field swap-picker" data-swap-picker="">
    <label htmlFor={`${id}-input`}>{label}</label>
    <input ref={inputRef} id={`${id}-input`} type="text" role="combobox" autoComplete="off" spellCheck={false}
      aria-autocomplete="list" aria-expanded={shown && hits.length > 0} aria-controls={listId}
      aria-activedescendant={shown && hits.length ? optionId(Math.min(active, hits.length - 1)) : undefined}
      value={query} disabled={disabled} placeholder="Type a server name, e.g. OPT13"
      onChange={e => {
        setQuery(e.target.value);
        setOpen(true);
        setActive(0);
        if (value && e.target.value.trim().toLowerCase() !== value.name.toLowerCase()) onPick(null);
      }}
      onFocus={() => { if (!value) setOpen(true); }}
      onKeyDown={onKeyDown}/>
    {shown && hits.length > 0 && <ul id={listId} role="listbox" aria-label={label} className="swap-picker-list">
      {hits.map((s, i) => <li key={s.key} id={optionId(i)} role="option" aria-selected={i === Math.min(active, hits.length - 1)}
        data-server={s.name} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(s)}>
        <bdi className="swap-picker-name">{s.name}</bdi> <span className="swap-picker-place">{serverPlaceText(s)}</span>
      </li>)}
    </ul>}
    {shown && query.trim() && hits.length === 0 && <p className="racks-field-hint" role="status">No server matches “{query.trim()}”.</p>}
    {value && !shown && <p className="racks-field-hint" data-picked="">{value.name} is on {serverPlaceText(value)}.</p>}
  </div>;
}
