import { useEffect, useRef, useState } from "react";
import { useAccounts } from "../accounts";
import { getDeviceNames, pushDeviceNames } from "../api/deviceNames";
import {
  applyResults, COMPARE_TEXT, confirmList, failedResultPorts, MODE_TEXT, NAMES_CHANGED, nameSyncErrorText, nameText,
  normalizeCompare, normalizeResults, portNoun, pushBody, resultHeadline, resultText, syncSummary, writablePorts, writeBlock,
  writeButtonText,
} from "../deviceNames";
import NameSyncBadge from "./NameSyncBadge";

const STATE_TONE = { in_sync: "text-emerald-400", differs: "text-amber-300", unknown: "text-zinc-500", not_writable: "text-zinc-500" };
const button = "text-xs px-2.5 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition disabled:opacity-50 disabled:hover:bg-transparent";
const primary = "text-xs px-3 py-1 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-semibold transition disabled:opacity-50";
const NOTHING_TO_RETRY = "Nothing to retry: those names now match the device or cannot be written.";

// "Device names" on a PDU/KVM detail page: compares the site names with the names stored on the device itself and writes
// the selected ones (Operator, after a confirm step that lists every change). Every write sends the explicit ports plus
// the values this compare showed; a 409 (names changed since) re-runs the compare. A Viewer sees the status summary only.
// Device names are rendered as plain text only. sync: useNameSync(...) of the same device (re-read after a write).
export default function DeviceNamesPanel({ device, kind, sync }) {
  const { canOperate } = useAccounts();
  const noun = portNoun(kind);
  const [compare, setCompare] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);   // { ok, results } or { error, body }
  const seq = useRef(0);
  const controller = useRef(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const compareRef = useRef(null);
  const writeRef = useRef(null);
  const confirmTitleRef = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; seq.current++; controller.current?.abort(); };
  }, []);

  // Saved site names changed: the compare (and a pending confirm list) no longer shows what would be written.
  const seenRevision = useRef(device.labels_revision);
  const hasCompare = useRef(false);
  hasCompare.current = !!compare;
  useEffect(() => {
    if (seenRevision.current === device.labels_revision) return;
    seenRevision.current = device.labels_revision;
    if (hasCompare.current) setNote("Site names changed since the last compare. Compare again before writing.");
    setCompare(null);
    setConfirming(false);
  }, [device.labels_revision]);

  useEffect(() => { if (confirming) confirmTitleRef.current?.focus(); }, [confirming]);

  const summary = syncSummary(sync.ports);
  const mode = compare?.mode ?? sync.mode;
  const options = { enabled: device.enabled };
  const blocked = writeBlock(compare, options);
  const writable = writablePorts(compare, options);
  const writableSet = new Set(writable.map(p => p.port));
  const chosen = [...selected].filter(p => writableSet.has(p));
  const changes = confirming ? confirmList(compare?.ports, chosen, kind) : [];
  const canRetrySummary = canOperate && mode !== "off" && device.enabled !== false && summary.failedPorts.length > 0;

  if (!canOperate) {
    // Viewer: status only (the compare contacts the device and is Operator-only).
    if (!summary.text) return null;
    return (
      <div className="px-4 py-3 border-t border-zinc-800 text-xs text-zinc-400">
        <span className="uppercase tracking-wider text-zinc-500 mr-2">Device names</span>
        <span>{summary.text}</span>
      </div>
    );
  }

  // select: only these ports are pre-selected (and confirm opens the confirm step); notice: shown after the compare.
  async function runCompare({ select, confirm = false, notice = "" } = {}) {
    if (busyRef.current) return;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const id = ++seq.current;
    setLoading(true);
    setError("");
    setNote("");
    setConfirming(false);
    setOutcome(null);
    try {
      const next = normalizeCompare(await getDeviceNames(device.id, { signal: ctrl.signal }));
      if (id !== seq.current) return;
      const writableNow = writablePorts(next, options).map(p => p.port);
      const pick = select ? writableNow.filter(p => select.includes(p)) : writableNow;
      setCompare(next);
      setSelected(new Set(pick));
      if (select && !pick.length) setNote(NOTHING_TO_RETRY);
      else if (notice && !writeBlock(next, options)) setNote(notice);
      if (confirm && pick.length) setConfirming(true);
    } catch (e) {
      if (id !== seq.current || ctrl.signal.aborted) return;
      setError(nameSyncErrorText(e));
      if (notice) setNote(notice);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }

  // body: pushBody(compare, ports). The write itself is never aborted from here: a request that reached the server
  // finishes there, and a late answer is only dropped when the panel is gone.
  async function push(body) {
    if (busyRef.current || !body) return;
    controller.current?.abort();
    seq.current++;
    busyRef.current = true;
    setLoading(false);
    setBusy(true);
    setConfirming(false);
    setOutcome(null);
    setError("");
    setNote("");
    let conflict = false;
    try {
      const result = normalizeResults(await pushDeviceNames(device.id, body));
      if (!alive.current) return;
      setOutcome(result);
      setCompare(c => applyResults(c, result.results));
      const written = new Set(result.results.filter(r => r.status === "synced").map(r => r.port));
      setSelected(s => new Set([...s].filter(p => !written.has(p))));
    } catch (e) {
      if (!alive.current) return;
      if (e.status === 409) conflict = true;
      else setOutcome({ error: nameSyncErrorText(e), body });
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        sync.watch();
        if (conflict) runCompare({ notice: NAMES_CHANGED });
        requestAnimationFrame(() => compareRef.current?.focus());
      }
    }
  }

  function toggle(port) {
    setSelected(s => { const next = new Set(s); next.has(port) ? next.delete(port) : next.add(port); return next; });
  }

  function toggleAll() {
    setSelected(allChosen ? new Set() : new Set(writable.map(p => p.port)));
  }

  // The per-port checkbox (table row and phone card): only for a differing port with a value to write.
  function rowBox(p, size = "") {
    return (
      <input type="checkbox" checked={selected.has(p.port)} disabled={working || confirming} onChange={() => toggle(p.port)}
        aria-label={`Write ${noun.toLowerCase()} ${p.port}: ${nameText(p.device)} to ${nameText(p.write)}`}
        className={`accent-nv-400 shrink-0 ${size}`} />
    );
  }

  function cancelConfirm() {
    setConfirming(false);
    requestAnimationFrame(() => writeRef.current?.focus());
  }

  const allChosen = writable.length > 0 && chosen.length === writable.length;
  const allInSync = !!compare && compare.ports.length > 0 && compare.ports.every(p => p.state === "in_sync");
  const failedNow = outcome?.results ? failedResultPorts(outcome.results) : [];
  const retryBody = failedNow.length ? pushBody(compare, failedNow) : null;
  const working = busy || loading;

  return (
    <div className="px-4 py-3 border-t border-zinc-800 space-y-2.5 text-sm" aria-busy={working}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="text-xs uppercase tracking-wider text-zinc-500">Device names</div>
        {summary.text && <div className="text-xs text-zinc-400">{summary.text}</div>}
        {canRetrySummary && (
          <button type="button" onClick={() => runCompare({ select: summary.failedPorts, confirm: true })} disabled={working} className={button}
            aria-label={`Compare with the device, then retry ${summary.failedPorts.length} failed name${summary.failedPorts.length === 1 ? "" : "s"}`}>
            Retry
          </button>
        )}
        <button ref={compareRef} type="button" onClick={() => runCompare()} disabled={working} className={`${button} ml-auto`}
          title="Read the names stored on the device and compare them with the site">
          {loading ? "Comparing…" : compare ? "Compare again" : "Compare with device"}
        </button>
      </div>

      {mode && <p className="text-[11px] text-zinc-500">{MODE_TEXT[mode]}</p>}
      {note && <p role="status" className="text-xs text-amber-300">{note}</p>}
      {error && <p role="alert" className="text-xs text-rose-300">Could not compare names: {error}</p>}
      {loading && <p role="status" className="text-xs text-zinc-500">Reading names from {device.name}…</p>}

      {compare && !loading && (
        !compare.reachable ? (
          <p role="alert" className="text-xs text-rose-300">Cannot reach device: {compare.error || "no answer"}</p>
        ) : compare.ports.length === 0 ? (
          <p className="text-xs text-zinc-500">The device reported no {noun.toLowerCase()}s.</p>
        ) : (
          <>
            {blocked && compare.mode !== "off" && <p className="text-xs text-amber-300">{blocked}</p>}
            {allInSync && <p className="text-xs text-emerald-400">Nothing differs: every name on the device matches the site.</p>}
            <div className="hidden sm:block max-h-80 overflow-auto rounded border border-zinc-800">
              <table className="w-full table-fixed text-xs">
                <caption className="sr-only">Site names compared with the names stored on {device.name}</caption>
                <thead className="sticky top-0 bg-zinc-900 text-zinc-500 text-left">
                  <tr>
                    <th scope="col" className="w-8 px-2 py-1.5">
                      {writable.length > 0 && (
                        <input type="checkbox" checked={allChosen} disabled={working || confirming} onChange={toggleAll}
                          aria-label={allChosen ? "Clear the selection" : `Select all ${writable.length} differing ${noun.toLowerCase()}s`}
                          className="accent-nv-400" />
                      )}
                    </th>
                    <th scope="col" className="w-16 px-2 py-1.5 font-medium">{noun}</th>
                    <th scope="col" className="px-2 py-1.5 font-medium">Site name</th>
                    <th scope="col" className="px-2 py-1.5 font-medium">On device</th>
                    <th scope="col" className="w-24 px-2 py-1.5 font-medium">State</th>
                  </tr>
                </thead>
                <tbody>
                  {compare.ports.map(p => (
                    <tr key={p.port} className="border-t border-zinc-800/70">
                      <td className="px-2 py-1">{writableSet.has(p.port) && rowBox(p)}</td>
                      <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">{p.port}<NameSyncBadge row={sync.ports[p.port] ?? p.sync} /></span>
                      </td>
                      <td className="px-2 py-1 text-zinc-200 truncate" title={nameText(p.site)}>
                        {p.site ? nameText(p.site) : "—"}
                        {p.write === "" && <span className="text-zinc-500"> (device default)</span>}
                      </td>
                      <td className={`px-2 py-1 truncate ${p.device ? "text-zinc-200" : "text-zinc-500 italic"}`} title={nameText(p.device)}>
                        {nameText(p.device)}
                      </td>
                      <td className={`px-2 py-1 whitespace-nowrap ${STATE_TONE[p.state]}`}>{COMPARE_TEXT[p.state]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Below 640 px: one card per port (port + state, then site -> device), no sideways scrolling. */}
            <div className="sm:hidden space-y-1.5">
              {writable.length > 0 && (
                <label className="flex items-center gap-2 py-1 text-xs text-zinc-400">
                  <input type="checkbox" checked={allChosen} disabled={working || confirming} onChange={toggleAll} className="accent-nv-400 w-4 h-4" />
                  Select all differing ({writable.length})
                </label>
              )}
              <ul aria-label={`Site names compared with the names stored on ${device.name}`}
                className="max-h-96 overflow-y-auto rounded border border-zinc-800 divide-y divide-zinc-800/70">
                {compare.ports.map(p => (
                  <li key={p.port} className="px-2.5 py-2 space-y-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {writableSet.has(p.port) && rowBox(p, "w-4 h-4")}
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-zinc-400">{noun} {p.port}<NameSyncBadge row={sync.ports[p.port] ?? p.sync} /></span>
                      <span className={`ml-auto shrink-0 text-xs ${STATE_TONE[p.state]}`}>{COMPARE_TEXT[p.state]}</span>
                    </div>
                    <div className="text-xs break-words [overflow-wrap:anywhere]">
                      <span className="sr-only">Site name: </span>
                      <span className="text-zinc-200">{p.site ? nameText(p.site) : "—"}</span>
                      {p.write === "" && <span className="text-zinc-500"> (device default)</span>}
                      <span aria-hidden="true" className="text-zinc-600"> → </span>
                      <span className="sr-only">, on device: </span>
                      <span className={p.device ? "text-zinc-200" : "text-zinc-500 italic"}>{nameText(p.device)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {writable.length > 0 && !confirming && (
              <div className="flex justify-end">
                <button ref={writeRef} type="button" onClick={() => setConfirming(true)} disabled={working || chosen.length === 0}
                  title={chosen.length === 0 ? `Select the ${noun.toLowerCase()}s to write` : undefined} className={primary}>
                  {busy ? "Writing…" : writeButtonText(chosen.length)}
                </button>
              </div>
            )}
          </>
        )
      )}

      {confirming && changes.length > 0 && (
        <div role="group" aria-labelledby="device-names-confirm" className="rounded border border-nv-400/40 bg-nv-400/5 p-3 space-y-2"
          onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelConfirm(); } }}>
          <p id="device-names-confirm" ref={confirmTitleRef} tabIndex={-1} className="text-xs font-medium text-nv-300 focus:outline-none">
            Write {changes.length} name{changes.length === 1 ? "" : "s"} to {device.name}?
          </p>
          <ul className="text-xs text-zinc-200 font-mono space-y-0.5 max-h-48 overflow-auto break-words [overflow-wrap:anywhere]">
            {changes.map(c => <li key={c.port}>{c.text}</li>)}
          </ul>
          <p className="text-[11px] text-zinc-500">Only the names change. Power and every other device setting stay as they are.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={cancelConfirm} className={button}>Cancel</button>
            <button type="button" onClick={() => push(pushBody(compare, changes.map(c => c.port)))} className={primary}>
              {writeButtonText(changes.length)}
            </button>
          </div>
        </div>
      )}

      <div aria-live="polite" className="space-y-1.5">
        {busy && <p className="text-xs text-zinc-400">Writing names to {device.name}…</p>}
        {outcome?.error && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-rose-300">Names were not written: {outcome.error}</p>
            <button type="button" onClick={() => push(outcome.body)} disabled={working} className={button}>Try again</button>
          </div>
        )}
        {outcome?.results && (
          <>
            <p className={`text-xs ${failedNow.length ? "text-amber-300" : "text-emerald-400"}`}>{resultHeadline(outcome.results)}</p>
            {outcome.results.length > 0 && (
              <ul className="text-xs space-y-0.5 break-words [overflow-wrap:anywhere]">
                {outcome.results.map(r => (
                  <li key={r.port} className={r.status === "synced" ? "text-zinc-300" : r.status === "failed" ? "text-rose-300" : "text-zinc-400"}>
                    {resultText(r, kind)}
                  </li>
                ))}
              </ul>
            )}
            {retryBody && (
              <button type="button" onClick={() => push(retryBody)} disabled={working} className={button}>
                Retry failed ({retryBody.ports.length})
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
