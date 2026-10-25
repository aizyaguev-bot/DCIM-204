import { useEffect, useRef } from "react";

// Modal focus handling, the same behaviour as PxeConfirmDialog: focus starts on initialRef (else the first focusable
// element), Tab stays inside the panel, Escape calls onEscape unless busyRef.current is set, and on close focus goes
// back to the element that opened the dialog (or to fallback() when that element is gone).
// Dialogs can stack (a power confirmation over the server details): only the newest one handles keys, and it stops
// the key there so the dialog underneath (and its window Escape listener) does not react as well.
const stack = [];

const FOCUSABLE = "button, input, textarea, select, [href], [tabindex]:not([tabindex='-1'])";
export function focusableIn(panel) {
  if (!panel) return [];
  return [...panel.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.offsetParent !== null && !el.closest("[hidden]"));
}

export default function useDialogFocus(panelRef, { initialRef, onEscape, busyRef, fallback } = {}) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    const opener = document.activeElement;
    const entry = { panelRef };
    stack.push(entry);
    const start = initialRef?.current || focusableIn(panelRef.current)[0] || panelRef.current;
    start?.focus?.();
    const onKey = e => {
      const panel = panelRef.current;
      if (!panel || stack[stack.length - 1] !== entry) return;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (!busyRef?.current) escape.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusableIn(panel);
      if (!list.length) { e.preventDefault(); panel.focus?.(); return; }
      const first = list[0], last = list[list.length - 1];
      if (!panel.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
        e.preventDefault(); (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      if (opener instanceof HTMLElement && opener !== document.body && document.contains(opener)) opener.focus();
      else fallbackRef.current?.()?.focus?.();
    };
  }, []);
}
