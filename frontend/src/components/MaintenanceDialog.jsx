import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

const FALLBACK_ERRORS = {
  400: "The request was rejected. Check the reason and password.",
  401: "Your session has expired. Sign in again.",
  403: "Password is incorrect",
  404: "This PDU no longer exists.",
  409: "The maintenance state changed. The column has been refreshed.",
  422: "The request was rejected. Check the reason and password.",
  429: "Too many attempts. Wait a few minutes and try again.",
  502: "The PDU is unreachable. No outlets were switched.",
};

export const isNamedOutlet = o => !!o?.label && !/^Outlet \d+$/.test(o.label);

export function passwordLabel(mode) {
  return mode === "account" ? "Your account password" : "Lab Manager password";
}

// The password is read from an uncontrolled input and never kept in React state.
export default function MaintenanceDialog({ mode, device, status, state, passwordMode, onClose, onChanged }) {
  const shutdown = mode === "shutdown";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState(null);
  const panelRef = useRef(null);
  const passwordRef = useRef(null);
  const reasonRef = useRef(null);
  const cancelRef = useRef(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const keyHandler = useRef(null);
  keyHandler.current = onKeyDown;

  const unavailable = passwordMode === "unavailable";
  // Unknown outlet states: nothing can be switched off, and the server would refuse anyway.
  const unreachable = shutdown && status?.reachable === false;
  const blocked = unavailable || unreachable;
  const outlets = status?.outlets || [];
  const byNumber = new Map(outlets.map(o => [o.number, o]));
  const onOutlets = outlets.filter(o => o.state === "on");
  const restoreList = (state?.outlets_off || []).map(n => byNumber.get(n) || { number: n, label: `Outlet ${n}` });
  const affected = shutdown ? onOutlets : restoreList;
  const named = affected.filter(isNamedOutlet);

  function clearPassword() {
    if (passwordRef.current) passwordRef.current.value = "";
  }

  function close() {
    if (busyRef.current) return;
    clearPassword();
    onClose();
  }

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    (blocked ? cancelRef.current : shutdown ? reasonRef.current : passwordRef.current)?.focus();
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
    if (!busy && error && !outcome) {
      const target = shutdown && !reason.trim() ? reasonRef.current : passwordRef.current;
      target?.focus();
    }
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
    if (busyRef.current || blocked || !device) return;
    const trimmed = reason.trim();
    if (shutdown && (trimmed.length < 1 || trimmed.length > 200)) {
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
      const result = shutdown
        ? await api.maintenanceShutdown(device.id, password, trimmed)
        : await api.maintenanceRestore(device.id, password);
      onChanged?.();
      const failed = (result?.results || []).filter(r => !r.ok).map(r => r.outlet);
      if (!mounted.current) return;
      if (failed.length === 0) { busyRef.current = false; onClose(); return; }
      setOutcome({ ok: (result.results || []).length - failed.length, failed });
    } catch (err) {
      if ([403, 409, 502].includes(err.status)) onChanged?.();
      if (!mounted.current) return;
      setError(err.detail || FALLBACK_ERRORS[err.status] || "The request failed. Check the connection and try again.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const title = shutdown ? "Shut down all outlets" : "Restore power";
  const verb = shutdown ? "lose power" : "be powered on again";

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="maint-dialog-title" aria-describedby="maint-dialog-desc"
        className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md max-h-[calc(100vh-32px)] overflow-y-auto">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <div id="maint-dialog-title" className={`font-medium ${shutdown ? "text-rose-300" : "text-nv-300"}`}>{title}</div>
          <button type="button" onClick={close} disabled={busy} aria-label="Close" className="text-zinc-400 hover:text-zinc-100 w-7 h-7 rounded hover:bg-zinc-800 disabled:opacity-40">✕</button>
        </div>

        {outcome ? (
          <div className="p-5 space-y-3 text-sm">
            <p role="status" className="text-amber-300">
              {outcome.ok} outlet{outcome.ok === 1 ? "" : "s"} switched. {outcome.failed.length} failed: {outcome.failed.join(", ")}.
            </p>
            <p className="text-zinc-400">
              {shutdown ? "The failed outlets may still be powered." : "The PDU stays in maintenance until every outlet is restored. Try Restore power again."}
            </p>
            <div className="flex justify-end">
              <button type="button" autoFocus onClick={onClose} className="text-sm px-3.5 py-1.5 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium">Close</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <div className="p-5 space-y-4 text-sm">
              <div id="maint-dialog-desc" className="space-y-2">
                <div>
                  <div className="font-semibold text-white">{device?.name || "Unknown PDU"}</div>
                  <div className="text-xs text-zinc-500">{[device?.rack, device?.model].filter(Boolean).join(" · ")}</div>
                </div>
                {shutdown ? (
                  unreachable
                    ? <p role="alert" className="text-amber-300">This PDU is unreachable, so its outlet states are unknown and no outlet can be switched off. Try again when it is back online.</p>
                    : outlets.length === 0
                    ? <p className="text-amber-300">Outlet states are not loaded. The server reads them live and switches off only the outlets that are on.</p>
                    : <p className="text-zinc-300"><strong className="text-rose-300">{onOutlets.length}</strong> of {outlets.length} outlets are on and will be switched off.</p>
                ) : (
                  <p className="text-zinc-300"><strong className="text-nv-300">{restoreList.length}</strong> outlet{restoreList.length === 1 ? "" : "s"} that were on before maintenance will be switched on.</p>
                )}
                {named.length > 0 && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-1">Devices that will {verb}:</div>
                    <ul className="max-h-36 overflow-y-auto rounded border border-zinc-800 divide-y divide-zinc-800/60">
                      {named.map(o => (
                        <li key={o.number} className="flex gap-2 px-2 py-1 text-xs">
                          <span className="w-6 text-right font-mono text-zinc-500">{o.number}</span>
                          <span className="truncate text-zinc-200">{o.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {affected.length > named.length && (
                  <p className="text-xs text-zinc-500">{affected.length - named.length} unlabelled outlet{affected.length - named.length === 1 ? "" : "s"} also affected.</p>
                )}
                <p dir="rtl" className="text-xs text-zinc-400">
                  {shutdown ? "הפעולה מנתקת חשמל לציוד המחובר. נדרשת סיסמה לאישור." : "יופעלו מחדש רק השקעים שהיו דולקים לפני התחזוקה. נדרשת סיסמה לאישור."}
                </p>
              </div>

              {unavailable && (
                <p role="alert" className="text-amber-300 text-xs">Maintenance actions require a configured password. Ask a lab administrator to enable accounts or set the Lab Manager password.</p>
              )}

              {shutdown && (
                <label className="block">
                  <div className="text-xs text-zinc-400 mb-1">Reason <span className="text-rose-400" aria-hidden="true">*</span></div>
                  <input ref={reasonRef} value={reason} onChange={e => setReason(e.target.value)} required maxLength={200} disabled={busy || blocked}
                    placeholder="e.g. Rack rewiring"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-nv-400/60" />
                </label>
              )}

              <label className="block">
                <div className="text-xs text-zinc-400 mb-1">{passwordLabel(passwordMode)}</div>
                <input ref={passwordRef} type="password" name="maintenance-password" autoComplete="current-password" required maxLength={256}
                  disabled={busy || blocked}
                  aria-invalid={error ? "true" : undefined} aria-describedby={error ? "maint-dialog-error" : undefined}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-nv-400/60" />
              </label>

              {error && <p id="maint-dialog-error" role="alert" className="text-xs text-rose-300">{error}</p>}
            </div>
            <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
              <button type="button" ref={cancelRef} onClick={close} disabled={busy} className="text-sm px-3 py-1.5 rounded hover:bg-zinc-800 text-zinc-300 disabled:opacity-40">Cancel</button>
              <button type="submit" disabled={busy || blocked}
                className={`text-sm px-3.5 py-1.5 rounded font-medium disabled:opacity-50 ${shutdown ? "bg-rose-700 hover:bg-rose-600 text-white" : "bg-nv-400 hover:bg-nv-300 text-zinc-950"}`}>
                {busy ? (shutdown ? "Switching off…" : "Restoring…") : title}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
