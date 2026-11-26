import { useCallback, useEffect, useRef, useState } from "react";
import { getNameSyncStatus } from "../api/deviceNames";
import { badgeInfo, deviceNamesForMode, hasPending, normalizeStatus, NOTICE_TONE, noticeDuration, POLL_LIMIT_MS, POLL_MS, saveNotice } from "../deviceNames";

const TONE = { synced: "text-emerald-400", pending: "text-sky-300", failed: "text-rose-300", skipped: "text-zinc-500" };

// Tiny per-port badge for the name stored on the device. Nothing is shown for a port without a status row.
export default function NameSyncBadge({ row }) {
  const info = badgeInfo(row);
  if (!info) return null;
  return (
    <span title={info.text} className={`inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 text-[11px] leading-none font-bold ${TONE[row.status]}`}>
      <span aria-hidden="true" className={row.status === "pending" ? "inline-block motion-safe:animate-spin" : undefined}>{info.symbol}</span>
      <span className="sr-only">{info.text}</span>
    </span>
  );
}

// The short note after a label save (from useNameSync().notice). Always mounted so the change is announced.
export function NameSyncNotice({ notice }) {
  return (
    <p role="status" className={notice ? `mb-3 text-xs ${NOTICE_TONE[notice.tone] || NOTICE_TONE.muted}` : "sr-only"}>
      {notice?.text || ""}
    </p>
  );
}

// Name sync status rows of one device (database only, no device contact). Pending rows are re-read every 3 s for at
// most 60 s after the page opened, a save, a push or a labels revision change. Responses of an older request or of
// another device are dropped. A failed read keeps the last rows: badges are an extra, never an error on the page.
export function useNameSync(deviceId, labelsRevision) {
  const [data, setData] = useState({ mode: null, ports: {} });
  const [notice, setNotice] = useState(null);
  const seq = useRef(0);
  const deadline = useRef(0);
  const timer = useRef(null);
  const controller = useRef(null);
  const noticeTimer = useRef(null);
  const modeRef = useRef(null);
  const pendingRef = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    controller.current?.abort();
    if (!deviceId) return null;
    const ctrl = new AbortController();
    controller.current = ctrl;
    const id = ++seq.current;
    try {
      const next = normalizeStatus(await getNameSyncStatus([deviceId], { signal: ctrl.signal }), deviceId);
      if (id !== seq.current) return null;
      modeRef.current = next.mode;
      pendingRef.current = hasPending(next.ports);
      setData(next);
      if (pendingRef.current && Date.now() < deadline.current) timer.current = setTimeout(load, POLL_MS);
      return next;
    } catch (e) {
      // A passing failure (network, 5xx) keeps polling while rows are pending; 4xx (no access / older backend) stops.
      const clientError = e?.status >= 400 && e?.status < 500;
      if (id === seq.current && !ctrl.signal.aborted && !clientError && pendingRef.current && Date.now() < deadline.current) {
        timer.current = setTimeout(load, POLL_MS);
      }
      return null;
    }
  }, [deviceId]);

  const watch = useCallback(() => {
    deadline.current = Date.now() + POLL_LIMIT_MS;
    return load();
  }, [load]);

  useEffect(() => {
    setData({ mode: null, ports: {} });
    modeRef.current = null;
    pendingRef.current = false;
    watch();
    return () => { seq.current++; controller.current?.abort(); clearTimeout(timer.current); };
  }, [watch]);

  // Labels saved elsewhere (another page or session) queue writes too: look again when the revision moves.
  const seenRevision = useRef(labelsRevision);
  useEffect(() => {
    if (seenRevision.current === labelsRevision) return;
    seenRevision.current = labelsRevision;
    watch();
  }, [labelsRevision, watch]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(noticeTimer.current); };
  }, []);

  const showNotice = useCallback(value => {
    clearTimeout(noticeTimer.current);
    setNotice(value);
    if (value) noticeTimer.current = setTimeout(() => setNotice(null), noticeDuration(value));
  }, []);

  // deviceNames/reason: the save response's "device_names" and "device_names_reason"; without them the configured
  // mode gives the same answer.
  const afterSave = useCallback(async (deviceNames, reason) => {
    const known = saveNotice(deviceNames, reason);
    if (known) showNotice(known);
    const next = await watch();
    if (!known && alive.current) showNotice(saveNotice(deviceNamesForMode(next?.mode ?? modeRef.current)));
  }, [watch, showNotice]);

  // Called when a save starts: a note from an earlier save must never stand for this one.
  const clearNotice = useCallback(() => showNotice(null), [showNotice]);

  return { mode: data.mode, ports: data.ports, notice, watch, afterSave, clearNotice };
}
