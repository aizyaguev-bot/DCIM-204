import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAccounts } from "../../accounts.jsx";
import { errorText, formatAsOf, listWorkItems, normalizeDraft, updateWorkItem } from "../../api/assistant.js";
import { EntityChips, PriorityBadge, WORK_ITEMS_CHANGED_EVENT } from "./DraftEditor.jsx";

// Saved work items (team-wide). Everyone with access sees them; Operators can mark an open item done or
// cancelled (the only transitions the API allows), each after an inline confirmation. The PATCH carries the
// item's updated_at as expected_updated_at; a 409 (changed by someone else) reloads the list and says so.
// Server data is never changed locally before the server confirms, and a list response that is older than a
// confirmed update never overwrites it. Equipment is shown as plain text (SEC-AI-7).
// Optional prop: refreshKey (reload when it changes). An onOpenRef prop is accepted and ignored.

const STATUS = {
  saved: { label: "פתוחה", cls: "border-sky-800 bg-sky-950/30 text-sky-300" },
  done: { label: "בוצעה", cls: "border-nv-400/60 bg-nv-400/10 text-nv-300" },
  cancelled: { label: "בוטלה", cls: "border-zinc-700 bg-zinc-900 text-zinc-400" },
};
const ACTIONS = {
  done: { button: "סמן כבוצעה", question: "לסמן את המשימה כבוצעה?", confirm: "כן, בוצעה", announce: "סומנה כבוצעה" },
  cancelled: { button: "בטל משימה", question: "לבטל את המשימה? היא תישאר ברשימה כמבוטלת.", confirm: "כן, בטל", announce: "בוטלה" },
};
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const FORBIDDEN_UPDATE = "נדרשת הרשאת Operator כדי לעדכן משימה";
const CONFLICT_UPDATE = "עודכן על ידי משתמש אחר";
const SMALL = "text-xs px-2.5 py-1 rounded border disabled:opacity-40";

const timeOf = iso => { const ms = Date.parse(iso || ""); return Number.isFinite(ms) ? ms : 0; };

function normalizeItem(raw) {
  const d = normalizeDraft(raw);
  const text = v => (typeof v === "string" ? v : "");
  return {
    ...d,
    id: text(raw?.id) || String(raw?.id ?? ""),
    status: STATUS[raw?.status] ? raw.status : "saved",
    created_by: text(raw?.created_by),
    created_at: text(raw?.created_at) || null,
    updated_at: text(raw?.updated_at) || null,
    updated_by: text(raw?.updated_by),
  };
}

export function normalizeItems(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.work_items) ? raw.work_items : [];
  return list.filter(x => x && typeof x === "object").map(normalizeItem).filter(x => x.id);
}

// Open items first, then by priority, then the most recently changed.
function sortItems(items) {
  return [...items].sort((a, b) => Number(a.status !== "saved") - Number(b.status !== "saved")
    || (a.status === "saved" ? PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] : 0)
    || timeOf(b.updated_at || b.created_at) - timeOf(a.updated_at || a.created_at));
}

export default function WorkItemsList({ refreshKey }) {
  const { canOperate } = useAccounts();
  const [items, setItems] = useState(null);          // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("open");
  const [expanded, setExpanded] = useState({});
  const [confirm, setConfirm] = useState(null);      // {id, status}
  const [pending, setPending] = useState({});        // id -> true while a PATCH runs
  const [itemErrors, setItemErrors] = useState({});
  const [announce, setAnnounce] = useState("");
  const seq = useRef(0);
  const confirmed = useRef({});                      // id -> updated_at of the last update the server confirmed
  const pendingRef = useRef({});                     // same as `pending`, readable before React re-renders
  const mounted = useRef(true);
  const headingRef = useRef(null);
  const confirmButtonRef = useRef(null);
  const actionRefs = useRef({});
  const baseId = useId();

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setLoadError("");
    try {
      const fresh = normalizeItems(await listWorkItems());
      if (!mounted.current || mine !== seq.current) return;
      // Keep a confirmed update when this list was read before it was committed.
      setItems(current => {
        const local = new Map((current || []).map(x => [x.id, x]));
        return fresh.map(item => {
          const known = local.get(item.id);
          const confirmedAt = confirmed.current[item.id];
          return known && confirmedAt && timeOf(confirmedAt) > timeOf(item.updated_at) ? known : item;
        });
      });
    } catch (err) {
      if (!mounted.current || mine !== seq.current) return;
      setLoadError(errorText(err));
    } finally {
      if (mounted.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener(WORK_ITEMS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(WORK_ITEMS_CHANGED_EVENT, onChanged);
  }, [load]);

  useEffect(() => {
    if (confirm) confirmButtonRef.current?.focus();
  }, [confirm]);

  // Focus the item's first action, or the list heading when the item left the current filter.
  function focusInList(id) {
    const target = actionRefs.current[id];
    (target?.isConnected ? target : headingRef.current)?.focus();
  }

  function askConfirm(item, status) {
    setItemErrors(e => ({ ...e, [item.id]: "" }));
    setConfirm({ id: item.id, status });
  }

  function cancelConfirm() {
    const id = confirm?.id;
    setConfirm(null);
    if (id) requestAnimationFrame(() => focusInList(id));
  }

  async function applyStatus(item, status) {
    if (pendingRef.current[item.id]) return;
    pendingRef.current[item.id] = true;
    setPending(p => ({ ...p, [item.id]: true }));
    setItemErrors(e => ({ ...e, [item.id]: "" }));
    try {
      const patch = { status };
      if (item.updated_at) patch.expected_updated_at = item.updated_at;
      const raw = await updateWorkItem(item.id, patch);
      if (!mounted.current) return;
      const updated = raw && typeof raw === "object" && raw.id ? normalizeItem(raw) : { ...item, status, updated_at: new Date().toISOString() };
      confirmed.current[item.id] = updated.updated_at || new Date().toISOString();
      setItems(list => (list || []).map(x => (x.id === item.id ? updated : x)));
      setConfirm(null);
      setAnnounce(`המשימה "${item.title}" ${ACTIONS[status].announce}.`);
      // The item may leave the current filter; keep focus in the list.
      requestAnimationFrame(() => focusInList(item.id));
    } catch (err) {
      if (!mounted.current) return;
      const message = err?.status === 403 ? FORBIDDEN_UPDATE
        : err?.status === 409 ? `${CONFLICT_UPDATE}. הרשימה רועננה; בדוק את המצב העדכני ונסה שוב אם צריך.`
        : err?.status === 404 ? "המשימה לא נמצאה. ייתכן שנמחקה; הרשימה רועננה."
        : errorText(err);
      setItemErrors(e => ({ ...e, [item.id]: message }));
      setConfirm(null);
      if (err?.status === 404 || err?.status === 409) load();
    } finally {
      delete pendingRef.current[item.id];
      if (mounted.current) setPending(p => { const next = { ...p }; delete next[item.id]; return next; });
    }
  }

  const all = items ? sortItems(items) : [];
  const openCount = all.filter(x => x.status === "saved").length;
  const shown = filter === "open" ? all.filter(x => x.status === "saved") : all;

  return (
    <section dir="rtl" lang="he" aria-labelledby={`${baseId}-heading`} className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${baseId}-heading`} ref={headingRef} tabIndex={-1} className="font-medium text-zinc-100 focus:outline-none">משימות שמורות</h3>
        <div role="group" aria-label="סינון משימות" className="flex rounded border border-zinc-800 overflow-hidden text-xs">
          <button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")}
            className={`px-2.5 py-1 ${filter === "open" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"}`}>
            פתוחות{items ? ` (${openCount})` : ""}
          </button>
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}
            className={`px-2.5 py-1 border-r border-zinc-800 ${filter === "all" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900"}`}>
            הכל{items ? ` (${all.length})` : ""}
          </button>
        </div>
        <button type="button" onClick={load} disabled={loading} className={`mr-auto ${SMALL} border-zinc-800 text-zinc-300 hover:bg-zinc-800`}>
          {loading ? "טוען…" : "רענן"}
        </button>
      </div>

      {!canOperate && (
        <p className="text-xs text-zinc-500">צפייה בלבד: {FORBIDDEN_UPDATE}.</p>
      )}

      <p role="status" aria-live="polite" className="sr-only">{announce}</p>

      {loadError && (
        <div role="alert" className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-300 flex flex-wrap items-center gap-2">
          <span className="flex-1">{items ? `לא ניתן לרענן את הרשימה; מוצגת הרשימה האחרונה שנטענה. ${loadError}` : `לא ניתן לטעון את המשימות. ${loadError}`}</span>
          <button type="button" onClick={load} disabled={loading} className={`${SMALL} border-rose-800 text-rose-200 hover:bg-rose-950/60`}>נסה שוב</button>
        </div>
      )}

      {items === null && !loadError && <p role="status" className="text-xs text-zinc-400">טוען משימות…</p>}

      {items !== null && shown.length === 0 && (
        <p className="text-xs text-zinc-500">
          {all.length === 0
            ? "אין עדיין משימות שמורות. אפשר ליצור טיוטת עבודה מתוך המלצה בתשובה של העוזר, לערוך אותה ולשמור."
            : "אין משימות פתוחות. אפשר לבחור \"הכל\" כדי לראות משימות שבוצעו או בוטלו."}
        </p>
      )}

      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map(item => {
            const open = !!expanded[item.id];
            const detailsId = `${baseId}-details-${item.id}`;
            const busy = !!pending[item.id];
            const asking = confirm?.id === item.id ? confirm.status : null;
            const actions = item.status === "saved" ? ["done", "cancelled"] : [];
            return (
              <li key={item.id} className="rounded border border-zinc-800 bg-zinc-900/60 p-3 space-y-2" aria-busy={busy || undefined}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <PriorityBadge priority={item.priority} />
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] ${STATUS[item.status].cls}`}>{STATUS[item.status].label}</span>
                </div>
                <h4 dir="auto" className="font-medium text-zinc-100 break-words">{item.title || "(ללא כותרת)"}</h4>
                <EntityChips refs={item.entity_refs} />
                <div className="text-xs text-zinc-500 space-y-0.5">
                  <div>נוצרה על ידי <bdi className="text-zinc-300">{item.created_by || "לא ידוע"}</bdi> · {formatAsOf(item.created_at)}</div>
                  {item.status !== "saved" && item.updated_by && (
                    <div>{STATUS[item.status].label} על ידי <bdi className="text-zinc-300">{item.updated_by}</bdi> · {formatAsOf(item.updated_at)}</div>
                  )}
                </div>

                <button type="button" aria-expanded={open} aria-controls={detailsId}
                  onClick={() => setExpanded(x => ({ ...x, [item.id]: !open }))}
                  className="text-xs text-nv-300 hover:underline">
                  {open ? "הסתר פרטים" : "הצג פרטים"}
                </button>
                {open && (
                  <div id={detailsId} className="space-y-2 text-xs text-zinc-300 border-t border-zinc-800 pt-2">
                    {item.description && <p dir="auto" className="whitespace-pre-wrap break-words">{item.description}</p>}
                    {item.steps.length > 0 && (
                      <div>
                        <div className="text-zinc-500 mb-0.5">שלבים</div>
                        <ol className="list-decimal pr-5 space-y-0.5">{item.steps.map((s, i) => <li key={i} dir="auto" className="break-words">{s}</li>)}</ol>
                      </div>
                    )}
                    {item.rationale && (
                      <div>
                        <div className="text-zinc-500 mb-0.5">נימוק</div>
                        <p dir="auto" className="whitespace-pre-wrap break-words">{item.rationale}</p>
                      </div>
                    )}
                    {!item.description && !item.steps.length && !item.rationale && <p className="text-zinc-500">אין פרטים נוספים.</p>}
                  </div>
                )}

                {canOperate && !asking && actions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {actions.map((status, i) => (
                      <button key={status} type="button" disabled={busy}
                        ref={i === 0 ? el => { if (el) actionRefs.current[item.id] = el; else delete actionRefs.current[item.id]; } : undefined}
                        onClick={() => askConfirm(item, status)}
                        className={`${SMALL} ${status === "cancelled" ? "border-zinc-700 text-zinc-300 hover:bg-zinc-800" : "border-nv-400/60 text-nv-300 hover:bg-nv-400/10"}`}>
                        {busy ? "מעדכן…" : ACTIONS[status].button}
                      </button>
                    ))}
                  </div>
                )}
                {canOperate && asking && (
                  <div role="group" aria-labelledby={`${detailsId}-q`}
                    onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!busy) cancelConfirm(); } }}
                    className="rounded border border-zinc-700 bg-zinc-950 p-2.5 space-y-2">
                    <p id={`${detailsId}-q`} className="text-xs text-zinc-200">{ACTIONS[asking].question}</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" ref={confirmButtonRef} disabled={busy} onClick={() => applyStatus(item, asking)}
                        className={`${SMALL} ${asking === "cancelled" ? "border-rose-700 bg-rose-700 text-white hover:bg-rose-600" : "border-nv-400 bg-nv-400 text-zinc-950 hover:bg-nv-300"}`}>
                        {busy ? "מעדכן…" : ACTIONS[asking].confirm}
                      </button>
                      <button type="button" disabled={busy} onClick={cancelConfirm} className={`${SMALL} border-zinc-700 text-zinc-300 hover:bg-zinc-800`}>חזור</button>
                    </div>
                  </div>
                )}
                {itemErrors[item.id] && <p role="alert" className="text-xs text-rose-300">{itemErrors[item.id]}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
