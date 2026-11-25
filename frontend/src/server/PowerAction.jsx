// Power ▾ in the server window's bar (v1 §1.1, §1.6): the whole server or one feed. Every item goes through
// act.power.request(action, opener, { scope, feedId }), which always opens PowerConfirmDialog (useServerPower), Power on
// included and whatever the account's confirm_power says; the plan is checked again on the latest readings before
// anything switches. A blocked feed (PDU in maintenance, protected outlet, unreachable PDU) is refused there, with the
// reason. The bar is rendered for Operators only (Viewers read "Viewer · read only"; the API answers 403 anyway).
//
// ⋯ More gets two items from here: Monitor settings (opens Activity › Monitor) and SSH settings (Admin).
// Export shape: window/CONTRACT.md.
import { useEffect, useRef, useState } from "react";
import { ADMIN_SSH_URL } from "../api/ssh";
import { planServerPower } from "../components/racks/serverPower.js";
import { revealMonitor } from "./sections/ActivitySection.jsx";
import "./server-ops.css";

const VERB = { on: "Power on", off: "Power off", cycle: "Power cycle" };
const PENDING = { on: "Powering on…", off: "Powering off…", cycle: "Power cycling…" };

// Why an item would do nothing (shown as its tooltip; the dialog says it too): a block, or "already on".
function itemNote(group, action, scope, feedId) {
  const plan = planServerPower(group, action, scope, feedId);
  return plan.disabledReason || "";
}

// The menu of one power group: [{ id, label, action, scope, feedId, note, separator? }].
//   one feed:   Power on…, Power off…, Power cycle…
//   two feeds+: Power on all feeds…, Power off all feeds…, then per feed Power on / off / cycle <label>…
export function powerItems(group) {
  const feeds = group?.feeds || [];
  if (!feeds.length) return [];
  const item = (action, scope, feed, label, extra = {}) => ({ id: `${action}:${scope}:${feed.id}`, label, action, scope, feedId: feed.id,
    note: itemNote(group, action, scope, feed.id), ...extra });
  if (feeds.length === 1) return ["on", "off", "cycle"].map(a => item(a, a === "cycle" ? "feed" : "server", feeds[0], `${VERB[a]}…`));
  const out = ["on", "off"].map(a => item(a, "server", feeds[0], `${VERB[a]} all feeds…`));
  for (const feed of feeds) for (const a of ["on", "off", "cycle"]) out.push(item(a, "feed", feed, `${VERB[a]} ${feed.label}…`, a === "on" ? { separator: true } : {}));
  return out;
}

function Bar({ record, act }) {
  const group = act.power?.group ?? record.powerGroup ?? null;
  const pending = act.power?.pending || null;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const items = powerItems(group);

  // While the menu is open: Escape closes the menu (not the window: this listener runs before the window's own, on
  // document), the arrow keys move between items, and a click elsewhere closes it.
  useEffect(() => {
    if (!open) return;
    const list = () => [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    list()[0]?.focus();
    const onKey = e => {
      if (!wrapRef.current) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); buttonRef.current?.focus(); return; }
      if (!menuRef.current?.contains(document.activeElement)) return;
      const all = list();
      const at = all.indexOf(document.activeElement);
      const go = i => { e.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
      if (e.key === "ArrowDown") go(at + 1);
      else if (e.key === "ArrowUp") go(at - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(all.length - 1);
    };
    const onDown = e => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); };
  }, [open]);

  function choose(item) {
    setOpen(false);
    // The confirmation returns focus to the element focused when it opened: the Power button.
    buttonRef.current?.focus();
    const asked = act.power?.request?.(item.action, buttonRef.current, { scope: item.scope, feedId: item.feedId });
    if (asked === false) act.toast?.(`${record.name}: no PDU outlet to switch.`, { tone: "error" });
  }

  const none = !items.length;
  return <span ref={wrapRef} className="srv-power" data-power="">
    <button ref={buttonRef} type="button" className="lab-window-btn" aria-haspopup="menu" aria-expanded={open}
      disabled={none || !!pending} title={none ? "No PDU outlet carries this server's name" : undefined}
      onClick={() => setOpen(o => !o)}>{pending ? PENDING[pending] || "Switching…" : "Power ▾"}</button>
    {open && <ul ref={menuRef} role="menu" aria-label={`Power ${record.name}`} className="lab-window-menu srv-power-menu">
      {items.map(item => <li key={item.id} role="none">
        {item.separator && <hr/>}
        <button type="button" role="menuitem" data-action={item.action} data-scope={item.scope} aria-label={item.label} title={item.note || undefined}
          onClick={() => choose(item)}>{item.label}{item.note ? <span className="srv-menu-note">{item.note}</span> : null}</button>
      </li>)}
    </ul>}
  </span>;
}

// Admin › SSH with this server highlighted (focus=<key>): the page's own navigation (one history entry; Back returns to
// the window).
export function openSshSettings(key) {
  const url = `${ADMIN_SSH_URL}&focus=${encodeURIComponent(key)}`;
  window.history.pushState({ tab: "admin", view: { kind: "dashboard" }, adminSection: "ssh" }, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

function more({ record, can }) {
  if (!record || record.missing) return [];
  const items = [{ id: "monitor-settings", label: "Monitor settings", onSelect: () => revealMonitor() }];
  if (can?.admin) items.push({ id: "ssh-settings", label: "SSH settings", onSelect: () => openSshSettings(record.key) });
  return items;
}

export default { Bar, more };
