import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useAccounts } from "../accounts";
import ExportCsvButton from "../components/ExportCsvButton";
import SshButton from "../components/SshButton";
import {
  applyBody, buildMoveRequest, clearAsResult, clearFailureText, clearPorts, filterServers, formatLocation, groupByDevice, kindNoun,
  locationClearPlan, moveErrorText, moveResultIsEmpty, normalizeLocations, normalizeMoveResult, parsePortInUse, portKey, portOptions,
  portText, takenPorts,
} from "../api/locations";

const input = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-nv-400/60 disabled:opacity-50";

// Server-centric view: where each server sits (rack, slot, PDU outlets, KVM port) and a guarded Move flow.
export default function LocationsView({ devices, onChanged }) {
  const { canOperate } = useAccounts();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [rack, setRack] = useState("all");
  const [moving, setMoving] = useState(null);       // { key, snapshot }: the dialog stays on this server until closed
  const [clearing, setClearing] = useState(null);   // server key being cleared
  const [notice, setNotice] = useState(null);       // { title, result, error } after a move or clear
  const [exportError, setExportError] = useState("");
  const seq = useRef(0);

  // Only the newest request may update the table; an older reply arriving late is ignored.
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const raw = await api.getLocations();
      if (mine !== seq.current) return;
      setData(normalizeLocations(raw));
      setLoadError("");
    } catch (e) {
      if (mine === seq.current) setLoadError(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // Device labels changed elsewhere (devices reloaded): read locations again.
  useEffect(() => { load(); }, [load, devices]);
  useEffect(() => () => { seq.current++; }, []);

  const servers = data?.servers || [];
  const racks = useMemo(() => {
    const names = new Set([...(data?.racks || []), ...servers.map(s => s.rack).filter(Boolean)]);
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [data]);
  const visible = useMemo(() => filterServers(servers, search, rack), [servers, search, rack]);
  const movingServer = moving ? servers.find(s => s.key === moving.key) || null : null;
  const emptyPdu = data?.empty_ports.pdu.length ?? 0;
  const emptyKvm = data?.empty_ports.kvm.length ?? 0;

  async function applied(server, result) {
    const n = result.changes.length, m = result.positions.length;
    setNotice({ title: `${server.name} moved: ${n} port label${n === 1 ? "" : "s"} changed${m ? `, ${m} position${m === 1 ? "" : "s"} updated` : ""}.`, result, error: "" });
    await Promise.allSettled([load(), onChanged?.()]);
  }

  // Removes every PDU outlet and KVM port label of the server (one direct-label write per port); rack position untouched.
  async function clearLocation(server) {
    const plan = locationClearPlan(server);
    if (!plan || !canOperate || clearing || !confirm(plan.message)) return;
    setClearing(server.key);
    try {
      const { cleared, failed } = await clearPorts(plan.ports, api.setDirectLabel);
      setNotice({
        title: `${server.name}: ${cleared.length} of ${plan.ports.length} port label${plan.ports.length === 1 ? "" : "s"} cleared. Rack position kept.`,
        result: clearAsResult(cleared),
        error: failed.length ? `Not cleared: ${clearFailureText(failed)}` : "",
      });
    } finally {
      await Promise.allSettled([load(), onChanged?.()]);
      setClearing(null);
    }
  }

  return (
    <main className="max-w-[1400px] mx-auto w-full px-4 sm:px-6 py-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-zinc-100">Server locations</h1>
          <p className="text-xs text-zinc-400 mt-1 max-w-3xl">
            Each server with its rack slot, PDU outlets and KVM port. Move relocates a server's PDU outlets, KVM port and rack position together;
            landing on another server swaps the two unless you turn swap off. Ping monitors and owners stay with the server.
          </p>
          {!canOperate && <p className="text-xs text-amber-300 mt-2">Read only. Moving servers and Export CSV require the Operator or Admin role.</p>}
        </div>
        {/* Same file as Admin > Connections: every server with rack, U slot, IP, PDU outlets and KVM ports. */}
        <ExportCsvButton onError={e => setExportError(!e ? "" : e.status === 403 ? "Operator role needed to export." : errorMessage(e))} />
      </div>

      {exportError && (
        <div role="alert" className="mb-4 rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">
          CSV export failed: {exportError}{" "}
          <button type="button" className="underline" onClick={() => setExportError("")}>Dismiss</button>
        </div>
      )}

      {notice && (
        <div role={notice.error ? "alert" : "status"} className={`mb-4 rounded-lg border p-3 text-sm ${notice.error ? "border-amber-500/40 bg-amber-500/10" : "border-nv-400/30 bg-nv-400/5"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className={`font-medium ${notice.error ? "text-amber-300" : "text-nv-300"}`}>{notice.title}</div>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss summary"
              className="text-zinc-400 hover:text-zinc-100 w-7 h-7 shrink-0 rounded hover:bg-zinc-800">✕</button>
          </div>
          {notice.error && <p className="text-xs text-amber-200 mt-1">{notice.error}</p>}
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">Show changes</summary>
            <div className="mt-2"><ChangeList result={notice.result} /></div>
          </details>
        </div>
      )}

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <input type="search" aria-label="Search servers" placeholder="Search server, rack, PDU or KVM…" value={search}
          onChange={e => setSearch(e.target.value)} className={`${input} w-full sm:w-72 rounded-lg px-3`} />
        <label className="flex items-center gap-2 text-xs text-zinc-400">Rack
          <select aria-label="Rack" value={rack} onChange={e => setRack(e.target.value)} className={`${input} max-w-[180px]`}>
            <option value="all">All racks</option>
            {racks.map(r => <option key={r} value={r}>{r}</option>)}
            <option value="unplaced">Unplaced</option>
          </select>
        </label>
        <button type="button" onClick={load} disabled={loading}
          className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded disabled:opacity-50">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {data && (
          <span className="text-xs text-zinc-500 sm:ml-auto" aria-live="polite">
            {visible.length} of {servers.length} server{servers.length === 1 ? "" : "s"} · {emptyPdu} empty outlet{emptyPdu === 1 ? "" : "s"} · {emptyKvm} empty KVM port{emptyKvm === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">
          {data ? "Locations could not refresh" : "Locations could not load"}: {loadError}.{" "}
          <button type="button" className="underline" onClick={load}>Retry</button>
        </div>
      )}

      {!data && loading && <p role="status" className="text-sm text-zinc-500 py-10 text-center">Loading locations…</p>}

      {data && (
        <>
          <div className="hidden md:block rounded-xl border border-zinc-800/60 overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-zinc-900/60 border-b border-zinc-800 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  <th scope="col" className="px-3 py-2.5">Server</th>
                  <th scope="col" className="px-3 py-2.5">Rack</th>
                  <th scope="col" className="px-3 py-2.5 w-16">Slot</th>
                  <th scope="col" className="px-3 py-2.5">PDU outlets</th>
                  <th scope="col" className="px-3 py-2.5">KVM port</th>
                  <th scope="col" className="px-3 py-2.5 w-52"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/40">
                {visible.map(s => (
                  <tr key={s.key} className="hover:bg-zinc-800/20 align-top">
                    <td className="px-3 py-2.5 font-mono text-zinc-100">{s.name}</td>
                    <td className="px-3 py-2.5 text-zinc-300">{s.rack || <span className="text-zinc-600">Unplaced</span>}</td>
                    <td className="px-3 py-2.5 text-zinc-300 font-mono">{s.slot != null ? `U${s.slot}` : <span className="text-zinc-600">—</span>}</td>
                    <td className="px-3 py-2.5"><PortCell server={s} kind="pdu" /></td>
                    <td className="px-3 py-2.5"><PortCell server={s} kind="kvm" /></td>
                    <td className="px-3 py-2.5 text-right">
                      {canOperate && <RowActions server={s} clearing={clearing} onMove={() => setMoving({ key: s.key, snapshot: s })} onClear={() => clearLocation(s)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="md:hidden space-y-2" aria-label="Server locations">
            {visible.map(s => (
              <li key={s.key} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-zinc-100 break-all">{s.name}</div>
                    <div className="text-xs text-zinc-400 mt-0.5">{formatLocation(s)}</div>
                  </div>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-zinc-500">PDU</dt><dd><PortCell server={s} kind="pdu" /></dd>
                  <dt className="text-zinc-500">KVM</dt><dd><PortCell server={s} kind="kvm" /></dd>
                </dl>
                {canOperate && <div className="mt-2"><RowActions server={s} clearing={clearing} tall onMove={() => setMoving({ key: s.key, snapshot: s })} onClear={() => clearLocation(s)} /></div>}
              </li>
            ))}
          </ul>

          {visible.length === 0 && (
            <p className="text-center py-10 text-sm text-zinc-500">
              {servers.length === 0 ? "No servers are labelled on any PDU or KVM yet." : "No servers match the search."}
            </p>
          )}

          <EmptyPorts empty={data.empty_ports} />
        </>
      )}

      {moving && data && (
        <MoveServerDialog key={moving.key} server={movingServer || moving.snapshot} gone={!movingServer} locations={data}
          onClose={() => setMoving(null)}
          onApplied={result => applied(movingServer || moving.snapshot, result)}
          onStale={load} />
      )}
    </main>
  );
}

function RowActions({ server, clearing, tall, onMove, onClear }) {
  const size = tall ? "h-9" : "py-1";
  // Servers known only from a rack slot or a ping monitor have no ports to clear.
  const noPorts = server.pdu.length + server.kvm.length === 0;
  return (
    <div className="flex gap-2 justify-end">
      <SshButton name={server.name} size="md" className={tall ? "h-9" : ""} />
      <button type="button" onClick={onMove} disabled={clearing === server.key} aria-label={`Move ${server.name}`}
        className={`px-3 ${size} text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded whitespace-nowrap disabled:opacity-50`}>
        Move…
      </button>
      <button type="button" onClick={onClear} disabled={!!clearing || noPorts} aria-label={`Clear location of ${server.name}`}
        title={noPorts ? "No PDU outlets or KVM ports to clear" : undefined}
        className={`px-3 ${size} text-xs bg-zinc-800 hover:bg-rose-500/10 border border-rose-500/40 text-rose-300 rounded whitespace-nowrap disabled:opacity-50`}>
        {clearing === server.key ? "Clearing…" : "Clear location"}
      </button>
    </div>
  );
}

function PortCell({ server, kind }) {
  const ports = server[kind];
  if (!ports.length) return <span className="text-zinc-600">—</span>;
  return (
    <ul className="space-y-0.5">
      {ports.map(p => (
        <li key={portKey(p)} className="text-zinc-300 whitespace-nowrap">
          {p.device_name} <span className="font-mono text-zinc-400">#{p.port}</span>
          {p.label && p.label.trim().toLowerCase() !== server.name.toLowerCase() && (
            <>{" "}<span className="ml-1 text-[11px] text-zinc-500">{p.label}</span></>
          )}
        </li>
      ))}
    </ul>
  );
}

function EmptyPorts({ empty }) {
  const total = empty.pdu.length + empty.kvm.length;
  if (!total) return null;
  return (
    <details className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm">
      <summary className="cursor-pointer text-zinc-300">Empty ports ({total})</summary>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {["pdu", "kvm"].map(kind => (
          <div key={kind}>
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">{kind === "pdu" ? "PDU outlets" : "KVM ports"}</div>
            {groupByDevice(empty[kind]).map(g => (
              <div key={g.device_id} className="text-xs text-zinc-400">
                <span className="text-zinc-300">{g.device_name}</span>: {g.ports.map(p => p.port).join(", ")}
              </div>
            ))}
            {empty[kind].length === 0 && <div className="text-xs text-zinc-600">None</div>}
          </div>
        ))}
      </div>
    </details>
  );
}

function ChangeList({ result }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-xs text-zinc-500 mb-1">Port labels ({result.changes.length})</div>
        {result.changes.length === 0 ? <p className="text-xs text-zinc-500">No port label changes.</p> : (
          <ul className="max-h-48 overflow-y-auto rounded border border-zinc-800 divide-y divide-zinc-800/60">
            {result.changes.map((c, i) => (
              <li key={`${c.device_id}:${c.port}:${i}`} className="px-2 py-1.5 text-xs flex flex-wrap gap-x-2">
                <span className="text-zinc-400">{c.where}</span>
                <span><span className="font-mono text-zinc-400">{c.before}</span> <span aria-hidden="true">→</span><span className="sr-only">to</span> <span className="font-mono text-zinc-100">{c.after}</span></span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {result.positions.length > 0 && (
        <div>
          <div className="text-xs text-zinc-500 mb-1">Rack positions</div>
          <ul className="rounded border border-zinc-800 divide-y divide-zinc-800/60">
            {result.positions.map((p, i) => (
              <li key={`${p.server}:${i}`} className="px-2 py-1.5 text-xs flex flex-wrap gap-x-2">
                <span className="font-mono text-zinc-200">{p.server}</span>
                <span className="text-zinc-400">{p.before} <span aria-hidden="true">→</span><span className="sr-only">to</span> <span className="text-zinc-100">{p.after}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.unplaced.length > 0 && (
        <p className="text-xs text-amber-300">Becomes unplaced (no ports, no rack position): {result.unplaced.join(", ")}</p>
      )}
    </div>
  );
}

function MoveServerDialog({ server, gone, locations, onClose, onApplied, onStale }) {
  const [draft, setDraft] = useState(() => ({ mode: "server", target: "", swap: true, rack: "", slot: "",
    pdu: server.pdu.map(p => ({ ...p, current: true })), kvm: server.kvm.map(p => ({ ...p, current: true })) }));
  const [preview, setPreview] = useState(null);   // normalized dry-run result + the body it was made for
  const [result, setResult] = useState(null);     // normalized applied result
  const [busy, setBusy] = useState(null);         // "preview" | "apply"
  const [error, setError] = useState("");
  const [inUse, setInUse] = useState(null);       // port named by a 409 "Port N on X is used by Y"
  const panelRef = useRef(null);
  const firstRef = useRef(null);
  const applyRef = useRef(null);
  const previewRef = useRef(null);
  const errorRef = useRef(null);
  const focusAfter = useRef(null);                // "preview" | "error": where focus goes once the request settles
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const previewSeq = useRef(0);
  const keyHandler = useRef(null);
  keyHandler.current = onKeyDown;

  const others = useMemo(() => locations.servers.filter(s => s.key !== server.key)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [locations, server.key]);
  const target = others.find(s => s.key === draft.target) || null;
  const pduOptions = useMemo(() => portOptions(locations, server, "pdu"), [locations, server]);
  const kvmOptions = useMemo(() => portOptions(locations, server, "kvm"), [locations, server]);
  const racks = useMemo(() => [...new Set([...locations.racks, server.rack].filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [locations, server.rack]);
  const takenPdu = draft.mode === "ports" ? takenPorts(draft.pdu, locations, server, "pdu", inUse) : {};
  const takenKvm = draft.mode === "ports" ? takenPorts(draft.kvm, locations, server, "kvm", inUse) : {};
  const anyTaken = Object.keys(takenPdu).length + Object.keys(takenKvm).length > 0;

  // The busy buttons are disabled while a request runs, which drops focus to <body>; put it back somewhere useful.
  useEffect(() => {
    if (busy || !focusAfter.current) return;
    const where = focusAfter.current;
    focusAfter.current = null;
    if (where === "preview") (applyRef.current && !applyRef.current.disabled ? applyRef.current : previewRef.current)?.focus();
    else errorRef.current?.focus();
  }, [busy, preview, error]);

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    firstRef.current?.focus();
    const listener = e => keyHandler.current(e);
    document.addEventListener("keydown", listener);
    return () => {
      mounted.current = false;
      previewSeq.current++;
      document.removeEventListener("keydown", listener);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  function close() {
    if (busyRef.current) return;
    onClose();
  }

  function onKeyDown(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll("button, input, select, textarea, summary, [href], [tabindex]:not([tabindex='-1'])")]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!panelRef.current.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
      e.preventDefault(); (e.shiftKey ? last : first).focus();
    }
  }

  // Any edit invalidates the preview: Apply always sends exactly what was previewed.
  function update(patch) {
    previewSeq.current++;
    setDraft(d => ({ ...d, ...patch }));
    setPreview(null);
    setError("");
    setInUse(null);
  }

  async function runPreview(e) {
    e?.preventDefault();
    if (busyRef.current) return;
    const built = buildMoveRequest(server, draft, true);
    if (built.error) { focusAfter.current = "error"; setError(built.error); setPreview(null); return; }
    const mine = ++previewSeq.current;
    busyRef.current = true;
    setBusy("preview");
    setError("");
    try {
      const raw = await api.moveServer(built.body);
      if (!mounted.current || mine !== previewSeq.current) return;
      focusAfter.current = "preview";
      setPreview({ ...normalizeMoveResult(raw), body: built.body });
    } catch (err) {
      if (!mounted.current || mine !== previewSeq.current) return;
      focusAfter.current = "error";
      setPreview(null);
      setError(moveErrorText(err));
      setInUse(err.status === 409 ? parsePortInUse(err.detail) : null);
      if ([404, 409].includes(err.status)) onStale?.();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function apply() {
    if (busyRef.current || !preview || moveResultIsEmpty(preview)) return;
    busyRef.current = true;
    setBusy("apply");
    setError("");
    try {
      const raw = await api.moveServer(applyBody(preview));
      const done = normalizeMoveResult(raw);
      onApplied?.(done);
      if (mounted.current) setResult(done);
    } catch (err) {
      if (!mounted.current) return;
      focusAfter.current = "error";
      setPreview(null);
      setError(moveErrorText(err));
      setInUse(err.status === 409 ? parsePortInUse(err.detail) : null);
      if ([404, 409].includes(err.status)) onStale?.();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  const disabled = !!busy || (gone && !result);
  const canApply = preview && !moveResultIsEmpty(preview) && !busy && !gone;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="move-dialog-title" aria-describedby="move-dialog-desc"
        className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-xl max-h-[calc(100vh-16px)] sm:max-h-[calc(100vh-32px)] overflow-y-auto">
        <div className="px-4 sm:px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between gap-3">
          <div id="move-dialog-title" className="font-medium text-nv-300 truncate">{result ? `${server.name} moved` : `Move ${server.name}`}</div>
          <button type="button" onClick={close} disabled={!!busy} aria-label="Close" className="text-zinc-400 hover:text-zinc-100 w-8 h-8 shrink-0 rounded hover:bg-zinc-800 disabled:opacity-40">✕</button>
        </div>

        <div id="move-dialog-desc" className="px-4 sm:px-5 pt-4 text-xs text-zinc-400 space-y-0.5">
          <div>Now: <span className="text-zinc-200">{formatLocation(server)}</span></div>
          <div>PDU: <span className="text-zinc-200">{server.pdu.map(p => `${p.device_name} #${p.port}`).join(", ") || "none"}</span></div>
          <div>KVM: <span className="text-zinc-200">{server.kvm.map(p => `${p.device_name} #${p.port}`).join(", ") || "none"}</span></div>
        </div>

        {gone && !result && (
          <p role="alert" className="mx-4 sm:mx-5 mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            {server.name} is no longer on any PDU or KVM port, so it cannot be moved. The list has been refreshed; close this dialog.
          </p>
        )}

        {result ? (
          <div className="p-4 sm:p-5 space-y-4">
            <p role="status" className="text-sm text-nv-300">Saved. {result.changes.length} port label{result.changes.length === 1 ? "" : "s"} changed.</p>
            <ChangeList result={result} />
            <div className="flex justify-end">
              <button type="button" autoFocus onClick={onClose} className="text-sm px-3.5 py-1.5 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium">Close</button>
            </div>
          </div>
        ) : (
          <form onSubmit={runPreview} noValidate>
            <div className="p-4 sm:p-5 space-y-4 text-sm">
              <fieldset disabled={disabled}>
                <legend className="text-xs text-zinc-400 mb-1.5">Move to</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <label className="flex items-center gap-2 text-zinc-200">
                    <input ref={firstRef} type="radio" name="move-mode" value="server" checked={draft.mode === "server"} onChange={() => update({ mode: "server" })} className="accent-nv-400" />
                    Another server's location
                  </label>
                  <label className="flex items-center gap-2 text-zinc-200">
                    <input type="radio" name="move-mode" value="ports" checked={draft.mode === "ports"} onChange={() => update({ mode: "ports" })} className="accent-nv-400" />
                    Empty ports
                  </label>
                </div>
              </fieldset>

              {draft.mode === "server" ? (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="move-target" className="block text-xs text-zinc-400 mb-1">Target server</label>
                    <select id="move-target" value={draft.target} disabled={disabled} onChange={e => update({ target: e.target.value })} className={`${input} w-full`}>
                      <option value="">Choose a server…</option>
                      {others.map(s => <option key={s.key} value={s.key}>{s.name} — {formatLocation(s)}</option>)}
                    </select>
                  </div>
                  {target && (
                    <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2.5 text-xs text-zinc-400 space-y-0.5">
                      <div><span className="text-zinc-200 font-mono">{target.name}</span> · {formatLocation(target)}</div>
                      <div>PDU: <span className="text-zinc-300">{target.pdu.map(p => `${p.device_name} #${p.port}`).join(", ") || "none"}</span></div>
                      <div>KVM: <span className="text-zinc-300">{target.kvm.map(p => `${p.device_name} #${p.port}`).join(", ") || "none"}</span></div>
                    </div>
                  )}
                  <label className="flex items-start gap-2 text-zinc-200">
                    <input type="checkbox" checked={draft.swap} disabled={disabled} onChange={e => update({ swap: e.target.checked })} className="mt-1 accent-nv-400" />
                    <span>
                      Swap with {target ? target.name : "the target server"}
                      <span className="block text-xs text-zinc-500">
                        {draft.swap
                          ? `${target ? target.name : "The target"} takes ${server.name}'s current ports and position.`
                          : `${server.name}'s current ports are cleared and ${target ? target.name : "the target"} loses its ports and position (becomes unplaced).`}
                      </span>
                    </span>
                  </label>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-zinc-500">The selected ports replace {server.name}'s current ports. Current ports you remove are cleared.</p>
                  <PortPicker kind="pdu" title="PDU outlets" options={pduOptions} chosen={draft.pdu} taken={takenPdu} disabled={disabled} onChange={pdu => update({ pdu })} />
                  <PortPicker kind="kvm" title="KVM port" options={kvmOptions} chosen={draft.kvm} taken={takenKvm} disabled={disabled} onChange={kvm => update({ kvm })} />
                  {anyTaken && (
                    <p className="text-xs text-rose-300">Ports marked "in use" belong to another server. Remove them, or pick that server under "Another server's location" to swap.</p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="move-rack" className="block text-xs text-zinc-400 mb-1">Rack (optional)</label>
                      <select id="move-rack" value={draft.rack} disabled={disabled} onChange={e => update({ rack: e.target.value })} className={`${input} w-full`}>
                        <option value="">Keep current</option>
                        {racks.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="move-slot" className="block text-xs text-zinc-400 mb-1">Slot U (optional)</label>
                      <input id="move-slot" type="number" inputMode="numeric" min="1" max="99" value={draft.slot} disabled={disabled}
                        onChange={e => update({ slot: e.target.value })} placeholder={server.slot != null ? String(server.slot) : "—"} className={`${input} w-full`} />
                    </div>
                  </div>
                  {String(draft.slot).trim() !== "" && (
                    <label className="flex items-start gap-2 text-zinc-200">
                      <input type="checkbox" checked={draft.swap} disabled={disabled} onChange={e => update({ swap: e.target.checked })} className="mt-1 accent-nv-400" />
                      <span>If that slot holds another server, swap positions with it</span>
                    </label>
                  )}
                </div>
              )}

              {error && <p ref={errorRef} tabIndex={-1} role="alert" className="text-xs text-rose-300 focus:outline-none">{error}</p>}

              {preview && (
                <section ref={previewRef} tabIndex={-1} aria-label="Preview of changes" className="rounded border border-zinc-800 bg-zinc-900/40 p-3 focus:outline-none focus-visible:border-nv-400/60">
                  <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Preview — nothing saved yet</div>
                  {moveResultIsEmpty(preview) ? <p className="text-xs text-zinc-400">Nothing would change.</p> : <ChangeList result={preview} />}
                </section>
              )}
            </div>
            <div className="px-4 sm:px-5 py-3 border-t border-zinc-800 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={close} disabled={!!busy} className="text-sm px-3 py-1.5 rounded hover:bg-zinc-800 text-zinc-300 disabled:opacity-40">Cancel</button>
              <button type="submit" disabled={disabled}
                className="text-sm px-3.5 py-1.5 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:opacity-50">
                {busy === "preview" ? "Checking…" : preview ? "Preview again" : "Preview changes"}
              </button>
              <button type="button" ref={applyRef} onClick={apply} disabled={!canApply} title={!preview ? "Preview the changes first" : undefined}
                className="text-sm px-3.5 py-1.5 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium disabled:opacity-50">
                {busy === "apply" ? "Applying…" : "Apply"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function PortPicker({ kind, title, options, chosen, taken = {}, disabled, onChange }) {
  const [pick, setPick] = useState("");
  const noun = kindNoun(kind);
  const chosenKeys = new Set(chosen.map(portKey));
  const available = options.filter(o => !chosenKeys.has(portKey(o)));
  const selectId = `move-add-${kind}`;

  function add() {
    const port = available.find(o => portKey(o) === pick);
    if (!port) return;
    onChange([...chosen, port]);
    setPick("");
  }

  return (
    <fieldset disabled={disabled} className="rounded border border-zinc-800 p-2.5">
      <legend className="px-1 text-xs text-zinc-400">{title}</legend>
      {chosen.length === 0 ? <p className="text-xs text-zinc-500 mb-2">None selected.</p> : (
        <ul className="flex flex-wrap gap-1.5 mb-2">
          {chosen.map(p => {
            const owner = taken[portKey(p)];
            return (
              <li key={portKey(p)} className={`flex items-center gap-1 rounded border pl-2 text-xs text-zinc-200 ${owner ? "border-rose-500/60 bg-rose-500/10" : "border-nv-400/30 bg-nv-400/5"}`}>
                {portText(p, kind)}
                {owner ? <span className="text-rose-300">(in use by {owner})</span> : p.current && <span className="text-zinc-500">(current)</span>}
                <button type="button" onClick={() => onChange(chosen.filter(c => portKey(c) !== portKey(p)))}
                  aria-label={`Remove ${portText(p, kind)}${owner ? `, in use by ${owner}` : ""}`}
                  className="w-7 h-7 text-zinc-400 hover:text-zinc-100">✕</button>
              </li>
            );
          })}
        </ul>
      )}
      {available.length === 0 ? <p className="text-xs text-zinc-600">No other empty {noun}s.</p> : (
        <div className="flex gap-2">
          <label htmlFor={selectId} className="sr-only">Add {kind === "pdu" ? "PDU outlet" : "KVM port"}</label>
          <select id={selectId} value={pick} onChange={e => setPick(e.target.value)} className={`${input} flex-1 min-w-0`}>
            <option value="">Choose an empty {noun}…</option>
            {groupByDevice(available).map(g => (
              <optgroup key={g.device_id} label={g.device_name}>
                {g.ports.map(p => <option key={portKey(p)} value={portKey(p)}>{g.device_name} · {noun} {p.port}{p.current ? " (current)" : ""}</option>)}
              </optgroup>
            ))}
          </select>
          <button type="button" onClick={add} disabled={!pick}
            className="px-3 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded disabled:opacity-50">Add</button>
        </div>
      )}
    </fieldset>
  );
}
