import { useEffect, useRef } from "react";

// A modal console: Escape closes, Tab and Shift+Tab stay on the close button and the viewer, focus cannot move
// behind the dialog, and closing returns focus to the control that opened it. No `inert` on #root: the assistant
// button is portalled outside it.
export default function InlineKvmConsole({ console, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => [...dialog.querySelectorAll("button, iframe")].filter(el => !el.disabled);
    const onKeyDown = event => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    // Tab out of the viewer happens inside the iframe and never reaches the keydown above: pull focus back here.
    const onFocusIn = event => {
      if (!dialog.contains(event.target)) closeRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  return <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="KVM console" aria-describedby="kvm-console-note"
    className="fixed inset-0 z-50 bg-zinc-950 flex flex-col">
    <div className="flex items-center justify-between gap-4 p-3 border-b border-zinc-800">
      <div><strong>{console.name} · Port {console.port}</strong>
        <p id="kvm-console-note" dir="rtl" className="text-xs text-zinc-400 mt-1">הדפדפן לא פתח לשונית חדשה. הקונסול נפתח כאן בתוך האתר.</p>
      </div>
      <button ref={closeRef} onClick={() => onCloseRef.current()} className="border border-zinc-700 rounded px-3 py-2" aria-label="Close KVM console">סגירה ✕</button>
    </div>
    <iframe title="KVM console viewer" src={console.url} allowFullScreen referrerPolicy="no-referrer"
      className="flex-1 w-full border-0 bg-black" />
    {/* Tab past the viewer lands here, inside the dialog, even when nothing focusable follows it on the page. */}
    <span tabIndex={0} data-focus-guard="" onFocus={() => closeRef.current?.focus()} className="sr-only" />
  </div>;
}
