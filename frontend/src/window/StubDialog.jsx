import { useRef } from "react";
import useDialogFocus from "../components/racks/useDialogFocus.js";

// The dialog a WP-0 stub shows until its package is built: the title and one line, then Close. z-[60] (above a
// window), useDialogFocus, data-dialog for tests.
export default function StubDialog({ id, title, text, onClose }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  useDialogFocus(panelRef, { initialRef: closeRef, onEscape: onClose });
  const titleId = `stub-dialog-${id}`;
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="racks-dialog" data-dialog={id}>
      <h2 id={titleId} dir="auto" className="racks-dialog-title">{title}</h2>
      <p className="racks-dialog-note" dir="auto">{text}</p>
      <div className="racks-dialog-actions">
        <button ref={closeRef} type="button" className="racks-btn" onClick={onClose}>Close</button>
      </div>
    </section>
  </div>;
}
