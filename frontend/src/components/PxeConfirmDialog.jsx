import { useEffect, useRef, useState } from "react";
import { passwordLabel } from "./MaintenanceDialog";
import { errorText } from "../api/pxe";

// The password is read from an uncontrolled input and never kept in React state.
// onSubmit(password, reason) must throw an error carrying status/detail on failure.
// onClose(submitted) is called with true after a successful submit, false on cancel.
export default function PxeConfirmDialog({ title, children, confirmLabel, busyLabel, danger = false, requireReason = false,
  passwordMode, onSubmit, onClose }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panelRef = useRef(null);
  const passwordRef = useRef(null);
  const reasonRef = useRef(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const keyHandler = useRef(null);
  keyHandler.current = onKeyDown;
  const unavailable = passwordMode === "unavailable";

  function clearPassword() {
    if (passwordRef.current) passwordRef.current.value = "";
  }

  function close() {
    if (busyRef.current) return;
    clearPassword();
    onClose(false);
  }

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    (requireReason ? reasonRef.current : passwordRef.current)?.focus();
    // On the document: a click on plain text moves focus to <body>, outside the panel.
    const listener = e => keyHandler.current(e);
    document.addEventListener("keydown", listener);
    return () => {
      mounted.current = false;
      document.removeEventListener("keydown", listener);
      if (passwordRef.current) passwordRef.current.value = "";
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (!busy && error) (requireReason && !reason.trim() ? reasonRef.current : passwordRef.current)?.focus();
  }, [busy, error]);

  function onKeyDown(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll("button, input, textarea, select, [href], [tabindex]:not([tabindex='-1'])")]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!panelRef.current.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
      e.preventDefault(); (e.shiftKey ? last : first).focus();
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (busyRef.current || unavailable) return;
    const trimmed = reason.trim();
    if (requireReason && (trimmed.length < 1 || trimmed.length > 200)) {
      setError("Enter a reason (1–200 characters).");
      reasonRef.current?.focus();
      return;
    }
    const password = passwordRef.current?.value || "";
    if (!password) {
      setError("Enter the password to confirm.");
      passwordRef.current?.focus();
      return;
    }
    if (password.length > 256) {
      clearPassword();
      setError("The password is too long.");
      return;
    }
    clearPassword();
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onSubmit(password, trimmed);
      busyRef.current = false;
      if (mounted.current) onClose(true);
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="pxe-dialog-title" aria-describedby="pxe-dialog-desc"
        className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg max-h-[calc(100vh-32px)] overflow-y-auto">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <div id="pxe-dialog-title" className={`font-medium ${danger ? "text-rose-300" : "text-nv-300"}`}>{title}</div>
          <button type="button" onClick={close} disabled={busy} aria-label="Close" className="text-zinc-400 hover:text-zinc-100 w-7 h-7 rounded hover:bg-zinc-800 disabled:opacity-40">✕</button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="p-5 space-y-4 text-sm">
            <div id="pxe-dialog-desc" className="space-y-2">{children}</div>

            {unavailable && (
              <p role="alert" className="text-amber-300 text-xs">Remote install requires a configured password. Ask a lab administrator to enable accounts or set the Lab Manager password.</p>
            )}

            {requireReason && (
              <label className="block">
                <div className="text-xs text-zinc-400 mb-1">Reason <span className="text-rose-400" aria-hidden="true">*</span></div>
                <input ref={reasonRef} value={reason} onChange={e => setReason(e.target.value)} required maxLength={200} disabled={busy || unavailable}
                  placeholder="e.g. Reinstall for test cycle"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-nv-400/60" />
              </label>
            )}

            <label className="block">
              <div className="text-xs text-zinc-400 mb-1">{passwordLabel(passwordMode)}</div>
              <input ref={passwordRef} type="password" name="pxe-password" autoComplete="current-password" required maxLength={256}
                disabled={busy || unavailable}
                aria-invalid={error ? "true" : undefined} aria-describedby={error ? "pxe-dialog-error" : undefined}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-nv-400/60" />
            </label>

            {error && <p id="pxe-dialog-error" role="alert" dir="auto" className="text-xs text-rose-300">{error}</p>}
          </div>
          <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
            <button type="button" onClick={close} disabled={busy} className="text-sm px-3 py-1.5 rounded hover:bg-zinc-800 text-zinc-300 disabled:opacity-40">Cancel</button>
            <button type="submit" disabled={busy || unavailable}
              className={`text-sm px-3.5 py-1.5 rounded font-medium disabled:opacity-50 ${danger ? "bg-rose-700 hover:bg-rose-600 text-white" : "bg-nv-400 hover:bg-nv-300 text-zinc-950"}`}>
              {busy ? (busyLabel || "Working…") : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
