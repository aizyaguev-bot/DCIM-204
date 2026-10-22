import { useEffect, useState } from "react";

// One toast at a time, bottom centre, above the assistant launcher. The live region is always present so the text is
// announced when it appears. It hides after 10 s; hovering it or focusing inside pauses the timer. Undo is a real
// button; Escape does not dismiss it (Escape belongs to dialogs).
// toast = { id, text (node), tone: "ok" | "error", onUndo?: async () => void }
export default function UndoToast({ toast, onDismiss }) {
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); setPaused(false); }, [toast?.id]);
  useEffect(() => {
    if (!toast || paused || busy) return undefined;
    const timer = setTimeout(() => onDismiss(toast.id), 10000);
    return () => clearTimeout(timer);
  }, [toast?.id, paused, busy, onDismiss]);
  return <div className="toast-region" role="status" aria-live="polite">
    {toast && <div className="toast" data-tone={toast.tone || "ok"}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false); }}>
      {/* English messages: names inside them are <bdi>, so a message that starts with a Hebrew name still reads left to right. */}
      <span className="toast-text">{toast.text}</span>
      {toast.onUndo && <button type="button" className="toast-undo" disabled={busy}
        onClick={async () => { setBusy(true); try { await toast.onUndo(); } finally { setBusy(false); } }}>{busy ? "Undoing…" : "Undo"}</button>}
      <button type="button" className="toast-close" aria-label="Dismiss message" onClick={() => onDismiss(toast.id)}>×</button>
    </div>}
  </div>;
}
