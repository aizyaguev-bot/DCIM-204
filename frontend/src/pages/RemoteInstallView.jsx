import { useEffect, useRef, useState } from "react";
import PxeConfirmDialog from "../components/PxeConfirmDialog";
import { useAccounts } from "../accounts";
import {
  pxeApi, screenshotUrl, isTerminal, stateLabel, STEPS, stepIndex, menuPhase, canFlags, asList, normalizeOptions,
  choiceKind, rebootMethods, formatCountdown, isExpired, highlightSegments, errorText, formatWhen, toMillis,
  isSimulated, takeoverConsole, shortId, blockerText, blockedNotice,
} from "../api/pxe";

const input = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:outline-none focus:border-nv-400 disabled:opacity-50";
const button = "rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40";
const primary = "rounded-lg bg-nv-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-nv-300 disabled:opacity-40";
const danger = "rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600 disabled:opacity-40";
const card = "rounded-xl border border-zinc-800 bg-zinc-900/40 p-4";

const POLL_MS = 1500;
const LIST_MS = 10000;
const COMPUTERS_MS = 30000;

const text = value => value && typeof value === "object" ? value.message || value.detail || value.code || JSON.stringify(value) : String(value ?? "");
const kvmKey = k => `${k.device_id}:${k.port}`;

function StateBadge({ job }) {
  const state = job?.state;
  const color = state === "completed" ? "text-emerald-300 bg-emerald-400/10"
    : state === "failed" ? "text-rose-300 bg-rose-400/10"
    : ["cancelled", "draft"].includes(state) ? "text-zinc-400 bg-zinc-800"
    : state === "manual_takeover" ? "text-amber-300 bg-amber-400/10"
    : "text-nv-300 bg-nv-400/10";
  return <span dir="auto" className={`inline-block rounded-full px-2.5 py-1 text-xs whitespace-nowrap ${color}`}>{stateLabel(job)}</span>;
}

function ComputerPicker({ config, computers, error, onReload, onOpenJob, onStart }) {
  const [query, setQuery] = useState("");
  const [computerKey, setComputerKey] = useState("");
  const [kvmChoice, setKvmChoice] = useState("");
  const [method, setMethod] = useState("kvm_cad");
  const methods = rebootMethods(config);
  const list = computers || [];
  const visible = list.filter(c => `${c.name} ${c.rack || ""} ${(c.kvm || []).map(k => k.device_name).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  // A selection the search hides cannot be started: the form and its warnings are not on screen.
  const chosen = list.find(c => c.key === computerKey) || null;
  const selected = visible.find(c => c.key === computerKey) || null;
  const hidden = chosen && !selected ? chosen : null;
  const kvms = selected?.kvm || [];
  const kvm = kvms.length === 1 ? kvms[0] : kvms.find(k => kvmKey(k) === kvmChoice) || null;
  const hasPdu = (selected?.pdu || []).length > 0;
  const passwordUnavailable = config?.password_mode === "unavailable";
  const effectiveMethod = methods.some(m => m.id === method) ? method : methods[0]?.id || "";
  const reasons = (selected?.blockers || []).map(blockerText).filter(Boolean);
  const blocked = !selected ? "Choose a computer."
    : selected.eligible === false ? `This computer cannot be installed remotely right now${reasons.length ? `: ${reasons.join(", ")}.` : "."}`
    : selected.active_job_id != null ? "This computer already has an active job." : !kvm ? "Choose the KVM port this computer is connected to."
    : !effectiveMethod ? "Choose a reboot method." : effectiveMethod === "pdu_cycle" && !hasPdu ? "No PDU outlet is mapped to this computer."
    : passwordUnavailable ? "Remote install requires a configured password." : "";

  function pick(key) {
    setComputerKey(key);
    setKvmChoice("");
    if (method === "pdu_cycle") setMethod("kvm_cad");
  }

  return <section aria-labelledby="pxe-picker-title" className={`${card} space-y-4`}>
    <div className="flex flex-wrap items-center gap-3">
      <h2 id="pxe-picker-title" className="font-semibold mr-auto">New install</h2>
      <input aria-label="Search computers" placeholder="Search computer, rack, KVM…" value={query} onChange={e => setQuery(e.target.value)} className={`${input} sm:!w-64`} />
      <button className={button} onClick={onReload}>Refresh list</button>
    </div>
    {error && <p role="alert" dir="auto" className="text-sm text-rose-300">Computers could not load: {error}</p>}
    <div className="max-h-80 overflow-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm text-left">
        <thead className="bg-zinc-900/60 text-xs text-zinc-500 sticky top-0"><tr>
          {["", "Computer", "Rack", "KVM", "PDU outlets", "Status"].map((h, i) => <th key={i} scope="col" className="px-3 py-2 font-medium">{h || <span className="sr-only">Select</span>}</th>)}
        </tr></thead>
        <tbody>
          {visible.map(c => {
            const disabled = c.eligible === false;
            return <tr key={c.key} className={`border-t border-zinc-800/60 ${computerKey === c.key ? "bg-nv-400/5" : ""}`}>
              <td className="p-0"><label className={`flex items-center justify-center px-3 py-2 ${disabled ? "" : "cursor-pointer"}`}><input id={`pxe-computer-${c.key}`} type="radio" name="pxe-computer" aria-label={`Select ${c.name}`} checked={computerKey === c.key} disabled={disabled} onChange={() => pick(c.key)} className="w-4 h-4" /></label></td>
              <td className="p-0 font-medium text-zinc-100"><label htmlFor={`pxe-computer-${c.key}`} className={`block px-3 py-2 ${disabled ? "" : "cursor-pointer"}`}>{c.name}</label></td>
              <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">{c.rack || "—"}</td>
              <td className="px-3 py-2 text-xs text-zinc-300">{(c.kvm || []).length ? c.kvm.map(k => <div key={kvmKey(k)}>{k.device_name} · Port {k.port}</div>) : <span className="text-amber-300">No KVM port</span>}</td>
              <td className="px-3 py-2 text-xs text-zinc-300">{(c.pdu || []).length ? c.pdu.map(p => <div key={`${p.device_id}:${p.outlet}`}>{p.device_name} · Outlet {p.outlet}</div>) : <span className="text-zinc-500">None</span>}</td>
              <td className="px-3 py-2 text-xs">
                {c.active_job_id != null && <button className="text-nv-300 hover:underline block" title={`Job ${c.active_job_id}`} onClick={() => onOpenJob(c.active_job_id)}>Active job #{shortId(c.active_job_id)}</button>}
                {(c.blockers || []).filter(b => !(b === "active_job" && c.active_job_id != null)).map((b, i) => <div key={i} dir="auto" className="text-amber-300">{blockerText(b)}</div>)}
                {c.eligible !== false && !(c.blockers || []).length && c.active_job_id == null && <span className="text-emerald-300">Ready</span>}
              </td>
            </tr>;
          })}
          {!visible.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-zinc-500">{computers === null ? "Loading computers…" : list.length ? "No computers match the search." : "No computers are mapped to a KVM port."}</td></tr>}
        </tbody>
      </table>
    </div>

    {selected && <div className="grid gap-3 md:grid-cols-2">
      <p className="md:col-span-2 text-sm text-zinc-300">Computer: <strong dir="auto" className="text-zinc-100">{selected.name}</strong>{selected.rack ? <span className="text-zinc-400"> · {selected.rack}</span> : null}</p>
      <label className="text-xs text-zinc-400">KVM port
        {kvms.length > 1
          ? <select className={`${input} mt-2`} value={kvmChoice} onChange={e => setKvmChoice(e.target.value)} required aria-describedby="pxe-kvm-hint">
              <option value="">Choose a KVM port…</option>
              {kvms.map(k => <option key={kvmKey(k)} value={kvmKey(k)}>{k.device_name}{k.model ? ` (${k.model})` : ""} · Port {k.port}</option>)}
            </select>
          : <div className="mt-2 text-sm text-zinc-200">{kvm ? `${kvm.device_name}${kvm.model ? ` (${kvm.model})` : ""} · Port ${kvm.port}` : "None"}</div>}
        {kvms.length > 1 && <span id="pxe-kvm-hint" className="block mt-1 text-amber-300">This computer appears on several KVM ports. Choose the one it is actually connected to.</span>}
      </label>
      <label className="text-xs text-zinc-400">Reboot method
        <select className={`${input} mt-2`} value={effectiveMethod} onChange={e => setMethod(e.target.value)}>
          {methods.map(m => <option key={m.id} value={m.id} disabled={m.id === "pdu_cycle" && !hasPdu}>{m.label}</option>)}
        </select>
      </label>
      {effectiveMethod === "pdu_cycle" && <div role="alert" className="md:col-span-2 rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-200">
        PDU power cycle cuts power to {selected.pdu.map(p => `${p.device_name} outlet ${p.outlet}`).join(", ")} and turns it back on. The computer is not shut down cleanly — unsaved work and open sessions are lost.
      </div>}
      {effectiveMethod === "kvm_cad" && <p className="md:col-span-2 text-xs text-zinc-400">Ctrl+Alt+Del is sent through the KVM. The operating system decides whether to restart.</p>}
      {effectiveMethod === "manual" && <p className="md:col-span-2 text-xs text-zinc-400">After you confirm, restart the computer yourself. The job watches the screen for the BIOS and opens the boot menu.</p>}
    </div>}

    <div className="flex flex-wrap items-center gap-3">
      <button className={effectiveMethod === "pdu_cycle" ? danger : primary} disabled={!!blocked}
        aria-describedby={hidden ? "pxe-hidden-note" : undefined}
        onClick={() => { if (selected && !blocked) onStart({ computer: selected, kvm, method: effectiveMethod, methodLabel: methods.find(m => m.id === effectiveMethod)?.label }); }}>Reboot and open boot menu</button>
      {blocked && selected && <span className="text-xs text-zinc-500">{blocked}</span>}
      {hidden && <span id="pxe-hidden-note" role="status" dir="auto" className="text-xs text-amber-300">
        The selected computer ({hidden.name}) is hidden by the search. Clear the search to review and start it.{" "}
        <button type="button" className="underline hover:text-amber-200" onClick={() => setQuery("")}>Clear search</button>
      </span>}
    </div>
  </section>;
}

function Stepper({ job }) {
  const state = job?.state;
  const failed = ["failed", "cancelled", "manual_takeover"].includes(state);
  const current = stepIndex(state, job?.failed_step);
  const phase = menuPhase(state);
  return <ol className="grid grid-cols-5 gap-2" aria-label="Install progress" dir="rtl">
    {STEPS.map((label, i) => {
      const done = current != null && (i < current || state === "completed");
      const here = current === i && state !== "completed";
      const tone = here && failed ? "border-rose-500 text-rose-300" : here ? "border-nv-400 text-nv-300" : done ? "border-emerald-600 text-emerald-300" : "border-zinc-800 text-zinc-500";
      return <li key={label} aria-current={here ? "step" : undefined} className={`border-t-2 pt-2 text-xs ${tone}`}>
        <div className="font-medium">{done ? "✓ " : ""}{label}</div>
        {here && (i === 1 || i === 2) && phase && <div className="text-zinc-500 mt-0.5">{phase === "grub" ? "GRUB" : "Boot menu (F12)"}</div>}
        {here && state === "ready_to_install" && <div className="text-zinc-500 mt-0.5">ממתין לאישור</div>}
      </li>;
    })}
  </ol>;
}

function Screenshot({ job, onRefresh, busy }) {
  const seq = job?.screenshot_seq;
  const [failedSrc, setFailedSrc] = useState("");
  const src = job ? screenshotUrl(job.id, seq) : "";
  const missing = !job || seq === 0 || seq === null || failedSrc === src;
  return <section aria-label="Latest screenshot" className={card}>
    <div className="flex items-center justify-between gap-3 mb-3">
      <h3 className="text-sm font-semibold">Screen</h3>
      <div className="flex items-center gap-3">
        {seq != null && <span className="text-xs text-zinc-500">#{seq}</span>}
        <button className={button} onClick={onRefresh} disabled={busy || !job || !canFlags(job).refresh_screenshot}>Refresh screenshot</button>
      </div>
    </div>
    {missing
      ? <div className="aspect-video rounded-lg border border-dashed border-zinc-800 flex items-center justify-center text-sm text-zinc-500">No screenshot yet.</div>
      : <img key={src} src={src} alt={`Screen of ${job.computer_name || "the computer"}`} onError={() => setFailedSrc(src)}
          className="w-full rounded-lg border border-zinc-800 bg-black" />}
  </section>;
}

function ChoicePanel({ job, kind, busy, onChoose }) {
  const options = normalizeOptions(kind === "boot" ? job.boot_options ?? job.options : job.grub_options ?? job.options, job.highlight_row);
  const [picked, setPicked] = useState(null);
  useEffect(() => setPicked(null), [job.id, job.version, kind]);
  const pickedOption = options.find(o => String(o.id) === picked);
  return <section aria-labelledby="pxe-choice-title" className={`${card} space-y-3`}>
    <h3 id="pxe-choice-title" className="font-semibold">{kind === "boot" ? "Choose the network boot entry" : "Choose the install profile (GRUB)"}</h3>
    <p className="text-xs text-zinc-400">These options were read from the computer's screen. The highlighted entry is what the computer would start on Enter.</p>
    {options.length === 0 ? <p className="text-sm text-amber-300">No options were read from the screen yet. Refresh the screenshot or wait.</p> :
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Options on screen</legend>
        {options.map(o => <label key={String(o.id)} className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${picked === String(o.id) ? "border-nv-400 bg-nv-400/5" : "border-zinc-800"} ${o.selectable ? "" : "opacity-50"}`}>
          <input type="radio" name="pxe-option" value={String(o.id)} checked={picked === String(o.id)} onChange={() => setPicked(String(o.id))} disabled={busy || !o.selectable} />
          <span dir="auto" className="font-mono text-xs text-zinc-100 flex-1">{o.label}</span>
          {o.recommended && <span className="text-xs rounded-full bg-nv-400/15 px-2 py-0.5 text-nv-300">Recommended</span>}
          {!o.selectable && <span className="text-xs text-zinc-500">{kind === "boot" ? "Not a network boot entry" : "Not an install entry"}</span>}
          {o.highlighted && <span className="text-xs rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">Highlighted on screen</span>}
        </label>)}
      </fieldset>}
    <button className={primary} disabled={busy || !pickedOption} onClick={() => onChoose(kind, pickedOption.id)}>{busy ? "Sending…" : "Select"}</button>
  </section>;
}

function Highlighted({ value, changes, side }) {
  return <code dir="ltr" className="block whitespace-pre-wrap break-all rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-xs text-zinc-300">
    {highlightSegments(value, changes, side).map((s, i) => s.changed
      ? <mark key={i} className={side === "after" ? "bg-emerald-400/20 text-emerald-200 rounded px-0.5" : "bg-rose-400/20 text-rose-200 rounded px-0.5 line-through"}>{s.text}</mark>
      : <span key={i}>{s.text}</span>)}
  </code>;
}

function profileLabel(job) {
  const choice = job.grub_choice ?? job.choice;
  if (job.grub_choice_label) return job.grub_choice_label;
  const match = normalizeOptions(job.grub_options ?? job.options).find(o => String(o.id) === String(choice));
  return match?.label || (choice != null ? String(choice) : "—");
}

function kvmText(job, kvmNames) {
  const name = job.kvm_device_name || kvmNames?.[job.kvm_device_id] || (job.kvm_device_id != null ? `KVM ${job.kvm_device_id}` : "KVM");
  return job.kvm_port != null ? `${name} · Port ${job.kvm_port}` : name;
}

function InstallSummary({ job, busy, sent, kvmNames, onInstall }) {
  const rewrite = job.rewrite || {};
  const changes = Array.isArray(rewrite.changes) ? rewrite.changes : [];
  const warnings = rewrite.warnings ?? job.warnings ?? [];
  const hash = job.rewrite_hash ?? rewrite.hash;
  return <section aria-labelledby="pxe-summary-title" className="rounded-xl border border-rose-900/70 bg-zinc-900/40 p-4 space-y-4">
    <h3 id="pxe-summary-title" className="font-semibold">Ready to install — review before starting</h3>
    <dl className="grid gap-3 sm:grid-cols-3 text-sm">
      <div><dt className="text-xs text-zinc-500">Computer</dt><dd className="text-zinc-100 font-medium">{job.computer_name}</dd></div>
      <div><dt className="text-xs text-zinc-500">KVM port</dt><dd className="text-zinc-200">{kvmText(job, kvmNames)}</dd></div>
      <div><dt className="text-xs text-zinc-500">Profile (GRUB entry)</dt><dd dir="auto" className="text-zinc-200 font-mono text-xs">{profileLabel(job)}</dd></div>
    </dl>
    {changes.length > 0 && <ul className="text-xs space-y-1">{changes.map((c, i) => <li key={i} className="font-mono"><span className="text-zinc-400">{c.key}:</span> <span className="text-rose-300">{c.before}</span> → <span className="text-emerald-300">{c.after}</span></li>)}</ul>}
    <div className="space-y-1"><div className="text-xs text-zinc-500">Before</div><Highlighted value={rewrite.before} changes={changes} side="before" /></div>
    <div className="space-y-1"><div className="text-xs text-zinc-500">After (sent to the installer)</div><Highlighted value={rewrite.after} changes={changes} side="after" /></div>
    {warnings.length > 0 && <ul role="alert" className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-200 space-y-1">{warnings.map((w, i) => <li key={i} dir="auto">{text(w)}</li>)}</ul>}
    <p className="text-sm text-rose-200">Starting the install boots the installer with this command line. Depending on the selected profile, it may erase the disk and overwrite the operating system and all data on this computer.</p>
    {!hash && <p role="alert" className="text-xs text-amber-300">The server did not provide the rewrite fingerprint. Refresh the job before starting.</p>}
    {sent && <p role="status" className="text-xs text-zinc-400">The install command was sent. Waiting for the job to update…</p>}
    <button className={danger} disabled={busy || sent || !hash} onClick={onInstall}>Start install</button>
  </section>;
}

function Events({ events }) {
  const at = e => { const ms = toMillis(e?.at); return Number.isFinite(ms) ? ms : 0; };
  const rows = (Array.isArray(events) ? events : []).slice().sort((a, b) => at(b) - at(a));
  return <section aria-label="Job events" className={card}>
    <h3 className="text-sm font-semibold mb-3">Events</h3>
    {rows.length === 0 ? <p className="text-sm text-zinc-500">No events yet.</p> :
      <ol className="space-y-2 max-h-72 overflow-y-auto">{rows.map((e, i) => <li key={e.id ?? i} className="border-b border-zinc-800/60 pb-2 text-xs">
        <div className="flex flex-wrap gap-x-3 text-zinc-400"><time>{formatWhen(e.at)}</time>{e.actor && <span>{e.actor}</span>}{e.action && <span className="text-zinc-300">{e.action}</span>}</div>
        {(e.from_state || e.to_state) && <div className="text-zinc-300 mt-0.5" dir="auto">{stateLabel(e.from_state)}{e.from_state && e.to_state ? " ← " : ""}{stateLabel(e.to_state)}</div>}
        {e.detail && <div dir="auto" className="text-zinc-500 mt-0.5 break-words">{text(e.detail)}</div>}
      </li>)}</ol>}
  </section>;
}

function JobPanel({ job, error, now, busy, actionError, notice, consoleTarget, installSent, kvmNames, onChoose, onInstall, onRefreshShot, onCancel, onTakeover,
  onOpenConsole, onComplete, onAcknowledge, onStart, onClose }) {
  const { canAdmin } = useAccounts();
  if (!job) return <section className={card}>{error ? <p role="alert" dir="auto" className="text-sm text-rose-300">{error}</p> : <p className="text-sm text-zinc-500">Loading job…</p>}</section>;
  const can = canFlags(job);
  const kind = choiceKind(job.state);
  const countdown = !isTerminal(job.state) ? formatCountdown(job.deadline_at, now) : null;
  const expired = isExpired(job.deadline_at, now);
  const simulated = isSimulated(job);
  const target = simulated ? null : consoleTarget || (job.state === "manual_takeover" ? takeoverConsole(job).open || null : null);
  const startable = job.state === "draft" && can.start && !expired;
  const heldNotice = job.state === "failed" ? blockedNotice(job) : "";
  return <section aria-labelledby="pxe-job-title" className="space-y-4">
    <div className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="pxe-job-title" className="font-semibold text-lg" title={`Job ${job.id}`}>{job.computer_name} · Job #{shortId(job.id)}</h2>
          <p className="text-xs text-zinc-500 mt-1">{kvmText(job, kvmNames)}{job.reboot_method ? ` · ${rebootMethods({ reboot_methods: [job.reboot_method] })[0]?.label}` : ""}{job.created_by ? ` · by ${job.created_by}` : ""}</p>
        </div>
        <div className="flex items-center gap-3">
          <StateBadge job={job} />
          {countdown && <span className={`text-xs tabular-nums ${expired ? "text-rose-300" : "text-zinc-400"}`} aria-label="Time left for this step">⏱ {countdown}</span>}
          <button className={button} onClick={onClose} aria-label="Close job">×</button>
        </div>
      </div>
      <Stepper job={job} />
      {error && <p role="alert" dir="auto" className="text-sm text-amber-300">Job could not refresh: {error}. The view may be out of date.</p>}
      {actionError && <p role="alert" dir="auto" className="text-sm text-rose-300">{actionError}</p>}
      {notice && <p role="status" dir="auto" className="text-sm text-nv-300">{notice}</p>}

      {job.state === "draft" && (startable
        ? <p className="text-sm text-zinc-400">The job has not started. Confirm with the password to reboot the computer.</p>
        : <p className="text-sm text-amber-300">The job expired. Cancel it or wait; a new job can be created.</p>)}
      {["rebooting", "waiting_for_menu", "waiting_for_grub", "updating_urls"].includes(job.state) && <p className="text-sm text-zinc-400">Working automatically — no action is needed.</p>}
      {job.state === "installing" && <p className="text-sm text-zinc-300">The install command was sent. Waiting for the installer to appear on screen.</p>}
      {job.state === "install_started" && <p role="status" className="text-sm text-nv-300">Installer started — waiting for completion. The install is not finished until this job says it is completed.</p>}
      {job.state === "completed" && <p role="status" className="text-sm text-emerald-300">The install is completed.</p>}
      {job.state === "cancelled" && <p className="text-sm text-zinc-400">This job was cancelled.</p>}
      {job.state === "manual_takeover" && <p className="text-sm text-amber-300">{simulated
        ? `Automation stopped. Simulation — there is no real console. In a real job this opens the KVM console for Port ${job.kvm_port ?? "?"}.`
        : "Automation stopped. Continue manually in the KVM console."}</p>}

      {job.state === "failed" && <div role="alert" className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm space-y-1">
        <div className="text-rose-200 font-medium">Failed{job.failed_step ? ` at ${stateLabel(job.failed_step)}` : ""}{job.error_code ? ` · ${job.error_code}` : ""}</div>
        {job.error_detail && <div dir="auto" className="text-rose-200/80 break-words">{text(job.error_detail)}</div>}
        {heldNotice && <div dir="auto" className={job.needs_acknowledge === false ? "text-zinc-300" : "text-amber-300"}>{heldNotice}</div>}
      </div>}

      <div className="flex flex-wrap gap-2">
        {startable && <button className={job.reboot_method === "pdu_cycle" ? danger : primary} disabled={busy} onClick={() => onStart(job)}>Reboot and open boot menu</button>}
        {can.takeover && <button className={button} disabled={busy} onClick={onTakeover}>{simulated ? "Manual takeover (simulation)" : "Open console (manual takeover)"}</button>}
        {target && <button className={button} onClick={() => onOpenConsole(target)}>Open console</button>}
        {can.complete && <button className={button} disabled={busy} onClick={onComplete}>Mark as completed</button>}
        {can.acknowledge && canAdmin && <button className={button} disabled={busy} onClick={onAcknowledge}>Acknowledge (Admin)</button>}
        {can.cancel && <button className={`${button} text-rose-300`} disabled={busy} onClick={onCancel}>Cancel job</button>}
      </div>
    </div>

    {kind && (kind === "boot" ? can.choose_boot : can.choose_grub) && <ChoicePanel job={job} kind={kind} busy={busy} onChoose={onChoose} />}
    {job.state === "ready_to_install" && can.install && <InstallSummary job={job} busy={busy} sent={installSent} kvmNames={kvmNames} onInstall={onInstall} />}
    <Screenshot job={job} busy={busy} onRefresh={onRefreshShot} />
    <Events events={job.events} />
  </section>;
}

function JobHistory({ jobs, error, selectedId, onSelect }) {
  return <aside aria-labelledby="pxe-history-title" className={`${card} min-w-0`}>
    <h2 id="pxe-history-title" className="font-semibold mb-3">Job history</h2>
    {error && <p role="alert" dir="auto" className="text-sm text-rose-300 mb-2">History could not refresh: {error}</p>}
    {jobs === null ? <p className="text-sm text-zinc-500">Loading jobs…</p> : jobs.length === 0 ? <p className="text-sm text-zinc-500">No jobs yet.</p> :
      <ul className="space-y-1 max-h-[600px] overflow-y-auto">{jobs.map(j => <li key={j.id}>
        <button onClick={() => onSelect(j.id)} aria-current={String(selectedId) === String(j.id) ? "true" : undefined}
          className={`w-full text-left rounded-lg px-3 py-2 text-sm hover:bg-zinc-800/60 ${String(selectedId) === String(j.id) ? "bg-nv-400/5 border border-nv-400/40" : "border border-transparent"}`}>
          <div className="flex items-center justify-between gap-2"><span className="font-medium text-zinc-100 truncate" title={`Job ${j.id}`}>{j.computer_name} · #{shortId(j.id)}</span><StateBadge job={j} /></div>
          <div className="text-xs text-zinc-500 mt-1">{formatWhen(j.created_at)}{j.created_by ? ` · ${j.created_by}` : ""}</div>
        </button>
      </li>)}</ul>}
  </aside>;
}

export default function RemoteInstallView({ config, onOpenConsole, kvmNames }) {
  const [computers, setComputers] = useState(null);
  const [computersError, setComputersError] = useState("");
  const [jobs, setJobs] = useState(null);
  const [jobsError, setJobsError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [job, setJob] = useState(null);
  const [jobError, setJobError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [consoleTarget, setConsoleTarget] = useState(null);
  const [installSent, setInstallSent] = useState(null);   // "id:version" after a successful install request
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);
  const selectedRef = useRef(null);
  const jobSeq = useRef(0);
  const jobsSeq = useRef(0);
  const computersSeq = useRef(0);
  // The start dialog's job: {id, resumed?, starting?}. A draft this dialog created is cancelled when the dialog
  // is left without starting it; a resumed draft (created elsewhere, started from its job panel) never is.
  const draftRef = useRef(null);
  const jobVersion = useRef(null);   // {id, version} of the job shown in the panel
  const autoSelected = useRef(false);
  const mounted = useRef(true);

  // Leaving with an unstarted draft releases its computer; a confirmed start still in flight is kept.
  function releaseDraft(opts) {
    const draft = draftRef.current;
    if (draft?.id == null || draft.starting || draft.resumed) return;
    draftRef.current = null;
    pxeApi.cancel(draft.id, opts).catch(() => {});
  }

  useEffect(() => {
    mounted.current = true;
    // A reload or closed tab never unmounts React; keepalive lets the cancel outlive the page.
    const onPageHide = () => releaseDraft({ keepalive: true });
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      mounted.current = false;
      releaseDraft();
    };
  }, []);

  async function loadComputers() {
    const seq = ++computersSeq.current;
    try {
      const data = asList(await pxeApi.computers(), "computers");
      if (mounted.current && seq === computersSeq.current) { setComputers(data); setComputersError(""); }
    } catch (e) { if (mounted.current && seq === computersSeq.current) setComputersError(errorText(e)); }
  }

  async function loadJobs() {
    const seq = ++jobsSeq.current;
    try {
      const data = asList(await pxeApi.jobs(), "jobs");
      if (!mounted.current || seq !== jobsSeq.current) return;
      setJobs(data); setJobsError("");
      // The dialog's draft was started or closed elsewhere: never cancel it on close or pagehide.
      const draft = draftRef.current;
      const row = draft?.id != null && !draft.starting ? data.find(j => String(j.id) === String(draft.id)) : null;
      if (row && row.state !== "draft" && draftRef.current === draft) draftRef.current = null;
      // A finished job is no longer polled; reload it when someone else changes it (e.g. an Admin acknowledge).
      const shown = jobVersion.current;
      const listed = shown && data.find(j => String(j.id) === String(shown.id));
      if (listed && listed.version !== shown.version && String(selectedRef.current) === String(shown.id)) loadJob(shown.id);
      if (!autoSelected.current) {
        autoSelected.current = true;
        const active = data.find(j => !isTerminal(j.state) && j.state !== "draft");
        if (active && selectedRef.current == null) selectJob(active.id);
      }
    } catch (e) { if (mounted.current && seq === jobsSeq.current) setJobsError(errorText(e)); }
  }

  async function loadJob(id = selectedRef.current) {
    if (id == null) return;
    const seq = ++jobSeq.current;
    const stillSelected = () => mounted.current && seq === jobSeq.current && String(selectedRef.current) === String(id);
    try {
      const data = await pxeApi.job(id);
      if (stillSelected()) { jobVersion.current = { id: data?.id ?? id, version: data?.version }; setJob(data); setJobError(""); }
    } catch (e) {
      if (stillSelected()) setJobError(errorText(e));
    }
  }

  function selectJob(id) {
    selectedRef.current = id;
    jobVersion.current = null;
    jobSeq.current++;
    setSelectedId(id); setJob(null); setJobError(""); setActionError(""); setNotice(""); setConsoleTarget(null);
    if (id != null) loadJob(id);
  }

  useEffect(() => {
    loadComputers(); loadJobs();
    const lists = setInterval(() => { if (!document.hidden) loadJobs(); }, LIST_MS);
    const comps = setInterval(() => { if (!document.hidden) loadComputers(); }, COMPUTERS_MS);
    return () => { clearInterval(lists); clearInterval(comps); };
  }, []);

  const current = job && String(job.id) === String(selectedId) ? job : null;
  const active = !!current && !isTerminal(current.state);

  useEffect(() => {
    if (selectedId == null || !active) return;
    let inFlight = false;
    const tick = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try { await loadJob(selectedId); } finally { inFlight = false; }
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [selectedId, active]);

  useEffect(() => {
    if (!active || !current?.deadline_at) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, current?.deadline_at]);

  const lastState = useRef(null);
  useEffect(() => {
    const state = current?.state;
    if (state && lastState.current && state !== lastState.current) { loadJobs(); if (isTerminal(state)) loadComputers(); }
    lastState.current = state || null;
  }, [current?.state]);

  async function act(fn, { conflict } = {}) {
    if (!current || busyRef.current) return;
    const id = current.id;
    busyRef.current = true;
    setBusy(true); setActionError(""); setNotice("");
    try {
      await fn(id);
      await loadJob(id);
    } catch (e) {
      if (e.status === 409) { await loadJob(id); setActionError(conflict || e.detail || "The job state changed. It has been reloaded."); }
      else setActionError(errorText(e));
      if ([403, 404, 502].includes(e.status)) loadJob(id);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function choose(kind, optionId) {
    const version = current.version;
    act(id => (kind === "boot" ? pxeApi.chooseBoot : pxeApi.chooseGrub)(id, optionId, version),
      { conflict: "The screen changed before your choice was applied. The options were reloaded — check them and choose again." });
  }

  function refreshShot() {
    act(id => pxeApi.refreshShot(id));
  }

  function cancel() {
    if (!confirm(`Cancel the job for ${current.computer_name} (#${shortId(current.id)})?`)) return;
    act(id => pxeApi.cancel(id));
  }

  function acknowledge() {
    if (!confirm(`Acknowledge the failed job for ${current.computer_name} (#${shortId(current.id)})? This allows a new install job for ${current.computer_name}.`)) return;
    act(async id => { await pxeApi.acknowledge(id); loadComputers(); });
  }

  function takeover() {
    const jobBefore = current;
    if (!confirm(isSimulated(jobBefore) ? "Stop the simulated job? No real console is opened in simulation."
      : "Stop the automation and continue manually in the KVM console?")) return;
    act(async id => {
      const result = await pxeApi.takeover(id);
      if (!mounted.current) return;
      const decision = takeoverConsole(jobBefore, result);
      if (decision.simulated) {
        // The manual_takeover state text already explains the simulation.
        setConsoleTarget(null);
      } else if (decision.open) {
        setConsoleTarget(decision.open);
        onOpenConsole(decision.open.deviceId, decision.open.port);
      } else {
        setConsoleTarget(null);
        setNotice("Automation stopped. Open the console from the Consoles tab.");
      }
    });
  }

  function openConsole(target) {
    if (!current || isSimulated(current) || !target) return;
    onOpenConsole(target.deviceId, target.port);
  }

  function openStart(selection) {
    draftRef.current = null;
    setDialog({ kind: "start", ...selection, kvmLabel: `${selection.kvm.device_name} · Port ${selection.kvm.port}` });
  }

  // Starts a draft created elsewhere (the API, another tab or user) from its job panel; closing does not cancel it.
  function resumeStart(jobData) {
    if (!jobData || busyRef.current || dialog) return;
    const computer = (computers || []).find(c => c.key === jobData.computer_key);
    draftRef.current = { id: jobData.id, resumed: true };
    setDialog({ kind: "start", resumed: true, jobId: jobData.id, createdBy: jobData.created_by || "",
      computer: { key: jobData.computer_key, name: jobData.computer_name, rack: computer?.rack || "" },
      kvmLabel: kvmText(jobData, kvmNames), method: jobData.reboot_method,
      methodLabel: rebootMethods({ reboot_methods: [jobData.reboot_method] })[0]?.label || jobData.reboot_method });
  }

  // After a failed start: which draft the dialog may retry (and, unless resumed, cancel on close).
  // A 409 means the job id may be stale (started elsewhere, expired, closed): keep it only while it is still a startable draft.
  async function draftAfterFailure(id, resumed, err) {
    if (err?.status === 404) return null;
    if (err?.status !== 409) return { id, resumed };
    try {
      const data = await pxeApi.job(id);
      return data?.state === "draft" && canFlags(data).start ? { id, resumed } : null;
    } catch {
      return null;
    }
  }

  async function submitStart(password, reason) {
    const { computer, kvm, method } = dialog;
    // A resumed dialog always starts its own job and never creates one, even after loadJobs dropped draftRef.
    const resumed = dialog.resumed === true;
    let id = resumed ? dialog.jobId : draftRef.current?.id;
    try {
      if (id == null) {
        const created = await pxeApi.createJob({ computer_key: computer.key, kvm_device_id: kvm.device_id, kvm_port: kvm.port, reboot_method: method });
        id = created?.id;
      }
      draftRef.current = { id, starting: true, resumed };
      await pxeApi.start(id, password, reason);
    } catch (e) {
      if (id != null) draftRef.current = await draftAfterFailure(id, resumed, e);
      if (!mounted.current) releaseDraft();
      // Another install may be running (run limit) or the computer was taken: show the current blockers.
      else if (e?.status === 409) { loadComputers(); loadJobs(); }
      throw e;
    }
    draftRef.current = null;
    selectJob(id);
    loadJobs(); loadComputers();
  }

  async function submitInstall(password) {
    const id = current.id;
    const sentKey = `${id}:${current.version}`;
    if (installSent === sentKey) return;
    try {
      await pxeApi.install(id, password, current.rewrite_hash ?? current.rewrite?.hash);
      setInstallSent(sentKey);
    } catch (e) {
      if (e.status !== 409) throw e;
      await loadJob(id);
      setActionError("The screen changed since the summary was shown. Review the reloaded summary before starting the install.");
      return;
    }
    await loadJob(id);
  }

  async function submitComplete(password) {
    const id = current.id;
    try {
      await pxeApi.complete(id, password);
    } catch (e) {
      if (e.status !== 409) throw e;
      setActionError("The job state changed. It has been reloaded.");
    }
    await loadJob(id);
  }

  function closeDialog(submitted) {
    const wasStart = dialog?.kind === "start";
    setDialog(null);
    if (!wasStart || submitted) return;
    const draft = draftRef.current;
    draftRef.current = null;
    if (draft?.id == null || draft.resumed || draft.starting) return;
    // Cancel only while it is still this dialog's unstarted draft: someone may have started it from its job panel.
    pxeApi.job(draft.id)
      .then(data => data?.state === "draft" ? pxeApi.cancel(draft.id) : null)
      .catch(() => {})
      .finally(() => { if (mounted.current) { loadJobs(); loadComputers(); if (String(selectedRef.current) === String(draft.id)) loadJob(draft.id); } });
  }

  const passwordMode = config?.password_mode;
  const simulated = config?.driver === "simulated";
  const repoHint = config?.new_repo_host ? `Install URLs are rewritten to ${config.new_repo_host}.` : "";

  return <main className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-5">
    <div>
      <div className="text-xs text-nv-400 uppercase tracking-widest font-semibold mb-2">PXE</div>
      <h1 className="text-2xl font-semibold text-zinc-100">Remote install</h1>
      <p className="text-sm text-zinc-400 mt-2 max-w-3xl">Reboot a computer into its network boot menu, choose the install profile and point the installer at the new repository — through the computer's KVM screen. {repoHint}</p>
    </div>
    {simulated && <div role="status" className="rounded-lg border border-sky-900 bg-sky-950/30 p-3 text-sm text-sky-200">Simulation mode — jobs run against a simulated computer. No KVM, PDU or real computer is touched.</div>}
    {passwordMode === "unavailable" && <div role="alert" className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-300">Remote install requires a configured password. Ask a lab administrator to enable accounts or set the Lab Manager password.</div>}

    <div className="grid gap-5 items-start xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5 min-w-0">
        <ComputerPicker config={config} computers={computers} error={computersError} onReload={loadComputers} onOpenJob={selectJob} onStart={openStart} />
        {selectedId != null && <JobPanel job={current} error={jobError} now={now} busy={busy} actionError={actionError} notice={notice}
          consoleTarget={consoleTarget} installSent={!!current && installSent === `${current.id}:${current.version}`} kvmNames={kvmNames}
          onChoose={choose} onRefreshShot={refreshShot} onCancel={cancel} onTakeover={takeover}
          onOpenConsole={openConsole} onAcknowledge={acknowledge} onStart={resumeStart}
          onInstall={() => { if (!busyRef.current) setDialog({ kind: "install" }); }} onComplete={() => setDialog({ kind: "complete" })} onClose={() => selectJob(null)} />}
      </div>
      <JobHistory jobs={jobs} error={jobsError} selectedId={selectedId} onSelect={selectJob} />
    </div>

    {dialog?.kind === "start" && <PxeConfirmDialog title="Reboot and open boot menu" confirmLabel="Reboot" busyLabel="Starting…" requireReason
      danger={dialog.method === "pdu_cycle"} passwordMode={passwordMode} onSubmit={submitStart} onClose={closeDialog}>
      <div className="font-semibold text-white">{dialog.computer.name}</div>
      <div className="text-xs text-zinc-500">{[dialog.computer.rack, dialog.kvmLabel].filter(Boolean).join(" · ")}</div>
      {dialog.resumed && <p className="text-xs text-zinc-400" title={`Job ${dialog.jobId}`}>Starts the existing job #{shortId(dialog.jobId)}{dialog.createdBy ? `, created by ${dialog.createdBy}` : ""}.</p>}
      <p className="text-zinc-300">Reboot method: <strong>{dialog.methodLabel}</strong></p>
      {dialog.method === "pdu_cycle" && <p className="text-rose-300">Power to the computer's PDU outlets will be cut and restored. The computer is not shut down cleanly.</p>}
      <p className="text-xs text-zinc-400">Nothing is installed at this step. You will choose the boot entry and confirm the install separately.</p>
      <p dir="rtl" className="text-xs text-zinc-400">הפעולה מאתחלת את המחשב ופותחת את תפריט האתחול. נדרשת סיסמה לאישור.</p>
    </PxeConfirmDialog>}
    {dialog?.kind === "install" && current && <PxeConfirmDialog title="Start install" confirmLabel="Start install" busyLabel="Starting install…" danger
      passwordMode={passwordMode} onSubmit={submitInstall} onClose={closeDialog}>
      <div className="font-semibold text-white">{current.computer_name}</div>
      <div className="text-xs text-zinc-500">{kvmText(current, kvmNames)} · <span dir="auto">{profileLabel(current)}</span></div>
      <p className="text-rose-300">The installer may erase the disk and overwrite the operating system and all data on this computer, depending on the profile. This cannot be undone or cancelled once sent.</p>
      <p dir="rtl" className="text-xs text-zinc-400">ההתקנה עלולה לדרוס את מערכת ההפעלה והמידע במחשב. נדרשת סיסמה לאישור.</p>
    </PxeConfirmDialog>}
    {dialog?.kind === "complete" && current && <PxeConfirmDialog title="Mark as completed" confirmLabel="Mark as completed" busyLabel="Saving…"
      passwordMode={passwordMode} onSubmit={submitComplete} onClose={closeDialog}>
      <div className="font-semibold text-white">{current.computer_name}</div>
      <p className="text-zinc-300">Confirm only after you have checked that the install finished successfully on this computer.</p>
    </PxeConfirmDialog>}
  </main>;
}
