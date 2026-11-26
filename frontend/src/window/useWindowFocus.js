// Keyboard handling of a window (WindowShell): the components/racks/useDialogFocus.js behaviour (focus starts inside,
// Tab stays inside, Escape closes unless busyRef.current, focus returns to the opener) with one difference: a window
// is the lowest layer, so while any other modal is open (a dialog the window opened, the inline KVM console, the
// maintenance dialog) the window leaves every key to it. useDialogFocus stops Escape for every dialog on its stack,
// which would close the window under a console that handles Escape itself.
import { useEffect, useRef } from "react";
import { focusableIn } from "../components/racks/useDialogFocus.js";

// Another modal is open: an element with aria-modal="true" that is not this window.
export function otherModalOpen(panel) {
  // getClientRects, not offsetParent: a fixed-position dialog has no offsetParent.
  return [...document.querySelectorAll('[aria-modal="true"]')].some(el => el !== panel && el.getClientRects().length > 0);
}

export default function useWindowFocus(panelRef, { initialRef, onEscape, busyRef, restoreFocus = true } = {}) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const opener = document.activeElement;
    const start = initialRef?.current || panelRef.current;
    start?.focus?.({ preventScroll: true });
    const onKey = e => {
      const panel = panelRef.current;
      if (!panel || otherModalOpen(panel)) return;
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
      if (restoreFocus && opener instanceof HTMLElement && opener !== document.body && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);
}
