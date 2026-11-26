import { useEffect, useId, useRef, useState } from "react";
import { useLabWindow } from "./labWindowContext.js";
import useWindowFocus from "./useWindowFocus.js";

// The frame every lab window uses (server, PDU, KVM, rack, unit, cooling unit, 3D-only record). CONTRACT.md lists the
// props. Escape, × and Back close it; closing waits while `busyRef.current` is set (a save is running).
//
// kind        "server" | "pdu" | "kvm" | "rack" | "unit" | "cooling" | "twin"   (data-window)
// name        the title (dir="auto")
// state       { word, tone }   tone: "ok" | "warn" | "bad" | "off" | "unknown"
// badges      [string | { text, tone }]   at most 2 are shown, in the order given
// tools       header tools (Console, SSH, 3D, Native UI …), before ×
// facts       [node]   the fact line, joined with " · "
// bar         the action bar's buttons (shown to roles with can.operate; Viewers see "Viewer · read only")
// more        [MenuItem]  ⋯ More: { id, label, onSelect, tone?: "danger", separator?: true (a line before it),
//             disabled?, title? }
// deleteTarget / deleteRole   { kind, id } and "operator" | "admin": adds Delete… (act.openDelete) when the role may;
//             in the bar when maybeGone, else last in More after a line, in red. A read-only window (can.operate false,
//             e.g. a removed server's) still shows it, after the read-only text, to a role that may delete.
// banner      a notice under the header (removed, deleted, gone)
// can         { operate, admin }
// size        "normal" | "wide"
// busyRef     closing is refused while busyRef.current is true
// readOnlyText  the bar's text for a role without can.operate (default "Viewer · read only")
export default function WindowShell({ kind, name, state = null, badges = [], tools = null, facts = [], bar = null, more = [],
  deleteTarget = null, deleteRole = "admin", maybeGone = false, banner = null, can = { operate: false, admin: false },
  size = "normal", busyRef = null, readOnlyText = "Viewer · read only", onClose, children }) {
  const { act } = useLabWindow();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const moreRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(false);
  menuRef.current = menuOpen;
  const titleId = useId();
  const tryClose = () => { if (!busyRef?.current) onClose?.(); };
  useWindowFocus(panelRef, { initialRef: closeRef, busyRef, onEscape: () => { if (menuRef.current) { setMenuOpen(false); moreRef.current?.focus(); } else tryClose(); } });
  // Announce the window (the assistant panel closes itself on a phone).
  useEffect(() => { window.dispatchEvent(new CustomEvent("dcim-server-window", { detail: { open: true, kind } })); }, [kind]);

  const mayDelete = !!deleteTarget && (deleteRole === "operator" ? can.operate : can.admin);
  const openDelete = () => { setMenuOpen(false); act.openDelete?.([deleteTarget]); };
  const items = (more || []).filter(Boolean);
  if (mayDelete && !maybeGone) items.push({ id: "delete", label: "Delete…", tone: "danger", separator: true, onSelect: openDelete });
  const shownBadges = (badges || []).filter(Boolean).slice(0, 2).map(b => (typeof b === "string" ? { text: b } : b));
  const shownFacts = (facts || []).filter(f => f != null && f !== false && f !== "");

  return <div className="lab-window-layer z-[55]" data-size={size}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="lab-window"
      data-window={kind} data-size={size}>
      <header className="lab-window-head">
        <span className="lab-window-led" data-tone={state?.tone || "unknown"} aria-hidden="true"/>
        <h2 id={titleId} dir="auto" className="lab-window-name">{name}</h2>
        {state?.word && <span className="lab-window-state" data-tone={state.tone || "unknown"}>{state.word}</span>}
        {shownBadges.map(b => <span key={b.text} className="lab-window-badge" data-tone={b.tone || undefined}>{b.text}</span>)}
        <div className="lab-window-tools">
          {tools}
          <button ref={closeRef} type="button" className="lab-window-btn lab-window-close" aria-label="Close" onClick={tryClose}>×</button>
        </div>
      </header>
      {banner}
      {shownFacts.length > 0 && <p className="lab-window-facts" data-facts="">{shownFacts.map((fact, i) => <span key={i} dir="auto">{fact}</span>)}</p>}
      <div className="lab-window-bar" role="toolbar" aria-label="Actions">
        {can.operate ? <>
          {bar}
          {mayDelete && maybeGone && <button type="button" className="lab-window-btn" data-tone="danger" onClick={openDelete}>Delete…</button>}
          {items.length > 0 && <button ref={moreRef} type="button" className="lab-window-btn" aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}>⋯ More</button>}
          {menuOpen && <ul role="menu" aria-label="More actions" className="lab-window-menu">
            {items.map(item => <li key={item.id} role="none">
              {item.separator && <hr/>}
              <button type="button" role="menuitem" data-tone={item.tone || undefined} disabled={!!item.disabled} title={item.title || undefined}
                onClick={() => { setMenuOpen(false); item.onSelect?.(); }}>{item.label}</button>
            </li>)}
          </ul>}
        </> : <>
          <span className="lab-window-readonly">{readOnlyText}</span>
          {mayDelete && <button type="button" className="lab-window-btn" data-tone="danger" onClick={openDelete}>Delete…</button>}
        </>}
      </div>
      <div className="lab-window-body">{children}</div>
    </section>
  </div>;
}

// A titled block of a window body. collapsible: a <details> that renders its children only while open (Activity
// loads when expanded).
export function WindowSection({ title, id, collapsible = false, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!collapsible) return <section className="lab-window-section" data-section={id}><h3>{title}</h3><div className="lab-window-section-body">{children}</div></section>;
  return <details className="lab-window-section" data-section={id} open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{title}</summary>
    {open && <div className="lab-window-section-body">{children}</div>}
  </details>;
}
