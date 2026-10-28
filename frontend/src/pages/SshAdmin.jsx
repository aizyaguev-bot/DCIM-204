import { useEffect, useRef, useState } from "react";
import { useAccounts } from "../accounts";
import { passwordLabel } from "../components/MaintenanceDialog";
import SshButton, { useSshStatus } from "../components/SshButton";
import {
  sshApi, sshStatusStore, httpErrorText, formFromStatus, buildConfigPayload, hasOptIn, hostKeyState, transportBlocked, sameHost,
  normalizeSessions, toMillis, formatDuration, formatBytes, eventLabel, endReasonLabel, NOT_INSTALLED_TEXT, DISABLED_TEXT, INSECURE_TEXT,
  supportsAutoAllow, skippedServers, allowChange, APPROVAL_LABELS, KEY_SOURCE_TEXT, keySourceOf, vmKeyRows, sessionKeyLabel, copyText,
  KEY_SOURCES, KEY_SOURCE_LABELS, KEY_SOURCE_HELP, SYSTEM_SSH_UNAVAILABLE_TEXT, systemSshUnavailable, systemSshReason, ADDRESS_SKIP_STATES,
} from "../api/ssh";

const inputCls = "h-8 w-full min-w-[120px] bg-zinc-950 border border-zinc-800 rounded px-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-nv-400/60 disabled:opacity-60";
const fmtTime = ms => ms == null ? "—" : new Date(ms).toLocaleString();
const HOST_KEY_CHECK = "for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf \"$f\"; done";
const SIGN_IN_KPI = { system: "VM ssh command", vm: "VM account + Lab Manager", site: "Lab Manager only" };
const KEY_SOURCE_SAVED = {
  system: "Lab Manager now signs in with this VM's ssh command, like typing ssh on the VM.",
  vm: "Lab Manager now signs in with this VM account's SSH keys, then the Lab Manager key.",
  site: "Lab Manager now signs in with the Lab Manager key only.",
};

// Admin → SSH: which keys Lab Manager signs in with, the Lab Manager key, install/revoke commands, which servers
// allow SSH ("allow every server with an address" or one by one) and as which user, host key pins, and the session
// log. Private keys never leave the VM; only the public key, key file names/types and fingerprints are shown.
export default function SshAdmin() {
  const { canOperate, canAdmin, mode } = useAccounts();
  const snapshot = useSshStatus();
  const status = snapshot.data;
  const [keyInfo, setKeyInfo] = useState({ data: null, error: null, loading: false });
  const [sessions, setSessions] = useState({ data: null, error: null, loading: false });
  const [config, setConfig] = useState(null);   // Admin: exact saved settings, so editing never drops a value
  const [dialog, setDialog] = useState(null);   // { kind: "generate" | "rotate" | "accept" | "end-sessions", server?, pinned?, fingerprint? }
  const [notice, setNotice] = useState("");
  // One-setting saves (key source, "allow every server"): { busy: kind | "", kind, message, error }.
  const [setting, setSetting] = useState({ busy: "", kind: "", message: "", error: "" });
  const [formDirty, setFormDirty] = useState(false);
  const settingSeq = useRef(0);
  const keySeq = useRef(0);
  const sessionSeq = useRef(0);
  const configSeq = useRef(0);
  const legacy = mode === "legacy";

  useEffect(() => { if (canOperate && !legacy) sshStatusStore.refresh({ force: true }); }, [canOperate, legacy]);

  // The all-servers key list is Admin-only; an Operator sees install commands on each terminal page instead.
  const keyReady = !!(status?.key_exists && status?.installed !== false && canAdmin);
  async function loadKey() {
    const seq = ++keySeq.current;
    setKeyInfo(k => ({ ...k, loading: true }));
    try {
      const data = await sshApi.key();
      if (seq === keySeq.current) setKeyInfo({ data, error: null, loading: false });
    } catch (error) {
      if (seq === keySeq.current) setKeyInfo(k => ({ data: k.data, error, loading: false }));
    }
  }
  useEffect(() => {
    if (keyReady) loadKey();
    else { keySeq.current++; setKeyInfo({ data: null, error: null, loading: false }); }
  }, [keyReady, status?.public_key_fingerprint]);

  async function loadSessions() {
    const seq = ++sessionSeq.current;
    setSessions(s => ({ ...s, loading: true }));
    try {
      const data = await sshApi.sessions();
      if (seq === sessionSeq.current) setSessions({ data: normalizeSessions(data), error: null, loading: false });
    } catch (error) {
      if (seq === sessionSeq.current) setSessions(s => ({ data: s.data, error, loading: false }));
    }
  }
  useEffect(() => { if (canAdmin && !legacy) loadSessions(); }, [canAdmin, legacy]);

  // Reload the exact settings whenever the saved revision changes; a failure falls back to the status view.
  useEffect(() => {
    const seq = ++configSeq.current;
    if (!canAdmin || legacy || !status?.config_revision) { setConfig(null); return; }
    sshApi.config().then(data => { if (seq === configSeq.current) setConfig(data); }, () => { if (seq === configSeq.current) setConfig(null); });
  }, [canAdmin, legacy, status?.config_revision]);

  if (!canOperate) return <main className="account-page"><p role="alert" className="text-sm text-zinc-400">SSH settings require the Operator or Admin role.</p></main>;
  if (legacy) return <main className="account-page"><h1 className="text-2xl font-bold text-white">SSH terminal</h1><p role="alert" className="text-sm text-zinc-400 mt-2">{httpErrorText({ status: 401 }, { accountMode: mode })}</p></main>;

  const statusError = snapshot.error ? httpErrorText(snapshot.error, { accountMode: mode }) : "";
  const servers = status?.servers || [];
  const optIn = hasOptIn(status);
  const keyStates = servers.map(hostKeyState);
  const keySource = keySourceOf(status, config);
  // With the VM's ssh command the VM account's known_hosts checks host keys; Lab Manager's pins are not used.
  const systemKeys = keySource === "system";

  // Saves one setting on its own (PUT /config with only that field, If-Match = the shown revision). The table
  // form never sends these, so neither can undo the other. A newer revision elsewhere (409/412) reloads the page data.
  async function saveSetting(kind, patch, okText) {
    if (setting.busy) return;
    const seq = ++settingSeq.current;
    setSetting({ busy: kind, kind, message: "", error: "" });
    try {
      const saved = await sshApi.saveConfig(patch, status?.config_revision);
      await sshStatusStore.refresh({ force: true });
      if (keyReady) loadKey();
      if (canAdmin) loadSessions();   // the change is in the audit log
      if (seq !== settingSeq.current) return;
      const skipped = Array.isArray(saved?.skipped) ? saved.skipped.length : 0;
      setSetting({ busy: "", kind, error: "",
        message: okText + (skipped ? ` ${skipped} server${skipped === 1 ? " has" : "s have"} no usable address (listed below).` : "") });
    } catch (err) {
      if (err.status === 409 || err.status === 412) await sshStatusStore.refresh({ force: true });
      if (seq === settingSeq.current) setSetting({ busy: "", kind, message: "", error: httpErrorText(err, { accountMode: mode }) });
    }
  }

  function dialogProps() {
    const { kind, server, pinned, fingerprint } = dialog;
    if (kind === "end-sessions") {
      return {
        title: "End all SSH sessions", danger: true, confirmLabel: "End sessions", busyLabel: "Ending…",
        description: <p className="text-zinc-300">Every open SSH terminal closes within about 30 seconds. People can reconnect afterwards.</p>,
        onConfirm: password => sshApi.endSessions(password),
        onDone: async () => { setNotice("All open SSH sessions were told to end."); await loadSessions(); },
      };
    }
    if (kind === "accept") {
      const changed = !!pinned && pinned !== fingerprint;
      return {
        title: changed ? `Accept the new host key of ${server.name}` : `Confirm the host key of ${server.name}`,
        danger: changed, confirmLabel: changed ? "Accept new key" : "Confirm key", busyLabel: "Saving…",
        check: `The fingerprint matches what ${server.name}'s own console shows`,
        description: <>
          {changed
            ? <p className="text-zinc-300">{server.name} now presents a different host key. Accept it only if the server was legitimately reinstalled <strong className="text-white">and</strong> the new fingerprint matches its console. Otherwise someone may be intercepting the connection.</p>
            : <p className="text-zinc-300">This key was pinned on the first connection and has not been checked yet.</p>}
          <dl className="space-y-1 text-xs">
            {changed && <div><dt className="text-zinc-500">Pinned key (old)</dt><dd className="font-mono text-zinc-300 break-all">{pinned}</dd></div>}
            <div><dt className="text-zinc-500">{changed ? "Key the server offers now (new)" : "Pinned key"}</dt><dd className="font-mono text-white break-all">{fingerprint}</dd></div>
          </dl>
          <p className="text-xs text-zinc-400">Compare it on the server's console (KVM), not over SSH:</p>
          <CodeBlock text={HOST_KEY_CHECK} label="Command that prints the server's host key fingerprints" />
        </>,
        onConfirm: password => sshApi.acceptHostKey(server.key, password, fingerprint, pinned || ""),
        onDone: async () => { setNotice(changed ? `The new host key of ${server.name} is now trusted.` : `The host key of ${server.name} is confirmed.`); await sshStatusStore.refresh({ force: true }); },
      };
    }
    const rotate = kind === "rotate";
    // Snapshotted when the dialog opened, so a refresh cannot change which key the Admin agreed to replace.
    const current = fingerprint || "";
    return {
      title: rotate ? "Replace the SSH key" : "Generate the SSH key",
      danger: rotate, confirmLabel: rotate ? "Replace key" : "Generate key", busyLabel: "Generating…",
      check: rotate ? `Replace the key ${current || "shown on this page"}` : "",
      option: rotate ? "Also end all open SSH sessions now" : "",
      description: rotate
        ? <>
          <p className="text-zinc-300">The current key stops working on <strong className="text-rose-300">every</strong> server. Install the new public key on each server, then remove the old one with the revoke commands this page shows.</p>
          <div className="text-xs"><div className="text-zinc-500">Current key</div><div className="font-mono text-white break-all">{current || "—"}</div></div>
        </>
        : <p className="text-zinc-300">Lab Manager creates an ed25519 key pair on the VM. The private key stays on the VM; you then install the public key on each allowed server.</p>,
      onConfirm: (password, endSessions) => sshApi.generateKey(password, rotate ? { rotate: true, expectedFingerprint: current, endSessions } : {}),
      onDone: async data => {
        if (data?.public_key) setKeyInfo({ data, error: null, loading: false });
        setNotice(rotate ? "A new key was generated. Install it on every server and remove the old key with the revoke commands." : "The SSH key was generated. Install the public key on each allowed server.");
        await sshStatusStore.refresh({ force: true });
        if (canAdmin) loadSessions();
      },
    };
  }

  return <main className="account-page max-w-none">
    <div className="flex flex-wrap justify-between items-end gap-4 mb-5">
      <div>
        <h1 className="text-2xl font-bold text-white">SSH terminal</h1>
        <p className="text-sm text-zinc-400 mt-2">Operators and Admins open an SSH terminal in the browser to servers an Admin allowed. Lab Manager signs in with the keys chosen under Sign-in keys; every session is logged without its contents.</p>
      </div>
      <button type="button" className="account-secondary" disabled={snapshot.loading} onClick={() => { sshStatusStore.refresh({ force: true }); if (keyReady) loadKey(); if (canAdmin) loadSessions(); }}>
        {snapshot.loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>

    {statusError && <p role="alert" className="account-error mb-4">SSH status could not load: {statusError}</p>}
    {notice && <p role="status" className="text-sm text-nv-300 mb-4">{notice} <button type="button" className="underline text-zinc-400 ml-2" onClick={() => setNotice("")}>Dismiss</button></p>}

    <div className="user-kpis">
      {[["Terminal", !status ? "—" : status.enabled === false ? "Off" : "On"],
        ["SSH support", !status ? "—" : status.installed === false ? "Missing" : "Installed"],
        ["Key", !status ? "—" : status.key_exists ? "Ready" : "None"],
        ["Sign-in keys", !status ? "—" : SIGN_IN_KPI[keySource] || "—"],
        ["Servers allowed", !status ? "—" : optIn ? `${servers.filter(s => s.allowed).length} / ${servers.length}` : servers.length],
        ...(systemKeys ? [] : [["Host keys to check", status ? keyStates.filter(k => k.state === "unconfirmed" || k.state === "changed").length : "—"]])].map(([label, value]) =>
        <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div>
    {status?.enabled === false && <p role="alert" className="text-sm text-amber-300 mb-4">{DISABLED_TEXT}</p>}
    {status?.installed === false && <p role="alert" className="text-sm text-amber-300 mb-4">{NOT_INSTALLED_TEXT}</p>}
    {transportBlocked(status, window.location.protocol) && <p role="alert" className="text-sm text-amber-300 mb-4">{INSECURE_TEXT}</p>}

    <KeySourceCard status={status} config={config} source={keySource} canAdmin={canAdmin} setting={setting}
      onSave={value => saveSetting("key_source", { key_source: value }, KEY_SOURCE_SAVED[value])} />

    <div className="account-grid mb-4">
      <KeyCard status={status} keyInfo={keyInfo} canAdmin={canAdmin} onRetry={loadKey} unused={systemKeys}
        onGenerate={() => setDialog({ kind: status?.key_exists ? "rotate" : "generate", fingerprint: status?.public_key_fingerprint || keyInfo.data?.fingerprint || "" })} />
      <InstallCard status={status} keyInfo={keyInfo} />
    </div>

    <ServersCard status={status} config={config} servers={servers} optIn={optIn} canAdmin={canAdmin} accountMode={mode}
      setting={setting} onDirtyChange={setFormDirty} systemKeys={systemKeys}
      onAutoAllow={(on, again) => saveSetting("auto_allow", { auto_allow: on },
        !on ? "Only the servers ticked below are allowed now." : again ? "Every server's address was checked again." : "Every server with an address is now allowed.")}
      autoAllowLocked={formDirty}
      onAccept={(server, pinned, fingerprint) => setDialog({ kind: "accept", server, pinned, fingerprint })}
      onSaved={async () => { await sshStatusStore.refresh({ force: true }); if (keyReady) loadKey(); }} />

    {canAdmin && <SessionsCard sessions={sessions} accountMode={mode} onRefresh={loadSessions} onEndAll={() => setDialog({ kind: "end-sessions" })} />}

    {dialog && <PasswordDialog key={`${dialog.kind}-${dialog.server?.key || ""}`} accountMode={mode} {...dialogProps()} onClose={() => setDialog(null)} />}
  </main>;
}

function Card({ title, hint, actions, children }) {
  return <section className="account-card min-w-0">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div>{actions}</header>
    <div className="p-4 space-y-3 text-sm">{children}</div>
  </section>;
}

function CopyButton({ text, what }) {
  const [state, setState] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <span className="inline-flex items-center gap-2">
    <button type="button" className="account-secondary" aria-label={what ? `Copy ${what}` : "Copy"}
      onClick={async () => { const ok = await copyText(text); setState(ok ? "Copied" : "Copy failed: select the text and copy it"); clearTimeout(timer.current); timer.current = setTimeout(() => setState(""), 2500); }}>Copy</button>
    <span role="status" className={`text-[11px] ${state === "Copied" ? "text-nv-300" : "text-amber-300"}`}>{state}</span>
  </span>;
}

function CodeBlock({ text, label }) {
  return <pre tabIndex={0} aria-label={label} className="whitespace-pre-wrap break-all rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] leading-relaxed font-mono text-zinc-200 select-all">{text}</pre>;
}

// An on/off setting that saves when it is pressed (Space/Enter or click), so arrow keys never change it.
function Switch({ checked, label, disabled, busy, describedBy, onChange }) {
  return <button type="button" role="switch" aria-checked={checked} aria-describedby={describedBy} disabled={disabled}
    onClick={() => onChange(!checked)}
    className="inline-flex items-center gap-3 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:border-nv-400/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-nv-400 disabled:opacity-60 disabled:cursor-not-allowed">
    <span aria-hidden="true" className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-nv-400" : "bg-zinc-700"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </span>
    <span>{label}</span>
    <span aria-hidden="true" className={`text-xs font-normal ${checked ? "text-nv-300" : "text-zinc-500"}`}>{busy ? "Saving…" : checked ? "On" : "Off"}</span>
  </button>;
}

function SettingResult({ setting, kind }) {
  if (setting.kind !== kind) return null;
  if (setting.error) return <p role="alert" className="account-error">{setting.error}</p>;
  if (setting.message) return <p role="status" className="text-sm text-nv-300">{setting.message}</p>;
  return null;
}

// How Lab Manager signs in: the VM's own ssh command (the default, exactly like typing ssh on the VM), the VM account's
// key files then the Lab Manager key, or only the Lab Manager key. A native radio group: arrow keys only pick an option
// and nothing is saved until the Admin presses Save (one PUT with key_source alone, If-Match = the shown revision).
function KeySourceCard({ status, config, source, canAdmin, setting, onSave }) {
  const [choice, setChoice] = useState(source);
  const groupRef = useRef(null);
  const refocus = useRef(false);
  // The saved value changed (this save, another window or a reload): start again from it.
  useEffect(() => { setChoice(source); }, [source]);
  // The Save button is disabled while saving, which drops keyboard focus: put it back on the chosen option.
  useEffect(() => {
    if (setting.busy || !refocus.current) return;
    refocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) groupRef.current?.querySelector("input:checked")?.focus();
  }, [setting.busy]);
  const selected = KEY_SOURCES.includes(choice) ? choice : source;
  const vmKeys = vmKeyRows(config);
  const blocked = !status ? "" : status.installed === false ? NOT_INSTALLED_TEXT : status.enabled === false ? DISABLED_TEXT : "";
  const systemDown = systemSshUnavailable(status);
  const systemReason = systemSshReason(status);
  const saving = setting.busy === "key_source";
  const locked = !!setting.busy || !status?.config_revision;
  const dirty = !!source && selected !== source;
  return <section className="account-card mb-4">
    <header><h2>Sign-in keys</h2><p>How Lab Manager signs in to a server. Private keys never leave the VM and no password is ever asked for.</p></header>
    <div className="p-4 space-y-3 text-sm">
      {!status || !source ? <p className="text-zinc-500">Loading…</p>
        : <>
          <p role="status" className="font-semibold text-white">{KEY_SOURCE_TEXT[source]}</p>
          {source === "system" && systemDown && <p role="alert" className="text-xs text-amber-300">
            {SYSTEM_SSH_UNAVAILABLE_TEXT}{systemReason ? ` Lab Manager reports: ${systemReason}` : ""}</p>}
          {canAdmin
            ? <>
              <fieldset ref={groupRef} disabled={locked} className="space-y-2 disabled:opacity-80">
                <legend className="mb-2 text-xs text-zinc-400">Sign in with</legend>
                {KEY_SOURCES.map(value => <div key={value}
                  className={`flex items-start gap-3 rounded border p-3 ${selected === value ? "border-nv-400/60 bg-zinc-900" : "border-zinc-800"}`}>
                  <input id={`ssh-key-source-${value}`} type="radio" name="ssh-key-source" value={value} checked={selected === value}
                    aria-describedby={`ssh-key-source-${value}-help`} className="mt-0.5 w-4 h-4 shrink-0 accent-[#76b900] cursor-pointer"
                    onChange={() => setChoice(value)} />
                  <div className="min-w-0">
                    <label htmlFor={`ssh-key-source-${value}`} className="font-semibold text-white cursor-pointer">{KEY_SOURCE_LABELS[value]}</label>
                    {value === source && <span className="ml-2 text-[11px] text-nv-300">In use</span>}
                    <p id={`ssh-key-source-${value}-help`} className="mt-1 text-xs text-zinc-400">{KEY_SOURCE_HELP[value]}
                      {value === "system" && systemDown ? ` ${systemReason || SYSTEM_SSH_UNAVAILABLE_TEXT}` : ""}</p>
                  </div>
                </div>)}
              </fieldset>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="account-primary" disabled={!dirty || locked} onClick={() => { refocus.current = true; onSave(choice); }}>
                  {saving ? "Saving…" : "Save sign-in keys"}</button>
                {dirty && !saving && <span className="text-xs text-amber-300">Not saved yet: {KEY_SOURCE_LABELS[selected]}</span>}
              </div>
            </>
            : <>
              <p className="text-xs text-zinc-400"><span className="font-semibold text-zinc-200">{KEY_SOURCE_LABELS[source]}.</span> {KEY_SOURCE_HELP[source]}</p>
              <p className="text-xs text-zinc-500">Only an Admin can change which keys are used.</p>
            </>}
          <p className="text-xs text-zinc-500">Lab Manager connects only to the servers allowed below.</p>
          {blocked && <p className="text-xs text-amber-300">{blocked}</p>}
          <SettingResult setting={setting} kind="key_source" />
          {selected === "vm" && vmKeys.length > 0 && <div>
            <div className="text-xs text-zinc-500 mb-1">Keys of this VM account</div>
            <ul className="space-y-1 text-xs">
              {vmKeys.map(k => <li key={k.name} className="flex flex-wrap gap-x-2">
                <span className="font-mono text-zinc-200">{k.name}</span>
                {k.type && <span className="font-mono text-zinc-500">{k.type}</span>}
                {k.usable === true ? <span className="text-nv-300">Used</span>
                  : k.usable === false ? <span className="text-amber-300">Not used{k.reason ? `: ${k.reason}` : ""}</span>
                  : <span className="text-zinc-400">Found</span>}
              </li>)}
            </ul>
          </div>}
          {selected === "vm" && config && Array.isArray(config.vm_keys) && vmKeys.every(k => k.usable === false) &&
            <p className="text-xs text-amber-300">This VM account has no usable default SSH key (~/.ssh/id_ed25519, id_ecdsa or id_rsa without a passphrase), so only the Lab Manager key is offered.</p>}
        </>}
    </div>
  </section>;
}

function KeyCard({ status, keyInfo, canAdmin, onGenerate, onRetry, unused }) {
  const exists = !!status?.key_exists;
  const blockedReason = !status ? "" : status.installed === false ? NOT_INSTALLED_TEXT : status.enabled === false ? DISABLED_TEXT : "";
  return <Card title="Lab Manager SSH key" hint="One ed25519 key for all servers. Only the public key is shown here."
    actions={canAdmin && status && <button type="button" className={exists ? "account-secondary text-rose-300" : "account-primary"} disabled={!!blockedReason} onClick={onGenerate}
      title={blockedReason || undefined}>{exists ? "Replace key…" : "Generate key…"}</button>}>
    {unused && <p className="text-xs text-zinc-400">Not used while Lab Manager signs in with this VM's ssh command (Sign-in keys above).</p>}
    {!status ? <p className="text-zinc-500">Loading…</p>
      : !exists ? <p className="text-zinc-400">{canAdmin ? "No key yet. Generate one, then install its public key on the allowed servers." : "No key yet. An Admin must generate one."}</p>
      : <>
        <div><div className="text-xs text-zinc-500">Fingerprint</div><div className="font-mono text-xs text-zinc-200 break-all">{status.public_key_fingerprint || keyInfo.data?.fingerprint || "—"}</div></div>
        {keyInfo.loading && !keyInfo.data && <p role="status" className="text-zinc-500">Loading the public key…</p>}
        {keyInfo.error && <p role="alert" className="account-error">The public key could not load: {httpErrorText(keyInfo.error)} <button type="button" className="underline" onClick={onRetry}>Retry</button></p>}
        {keyInfo.data?.public_key && <>
          <div className="text-xs text-zinc-500">Public key</div>
          <CodeBlock text={keyInfo.data.public_key.trim()} label="Public key" />
          <CopyButton text={keyInfo.data.public_key.trim()} what="public key" />
        </>}
      </>}
  </Card>;
}

function Alternative({ summary, text, label }) {
  return <details className="text-xs">
    <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">{summary}</summary>
    <div className="mt-1.5 space-y-1.5"><CodeBlock text={text} label={label} /><CopyButton text={text} what={label.toLowerCase()} /></div>
  </details>;
}

const commandRows = list => (Array.isArray(list) ? list : []).filter(r => r && typeof r.command === "string" && r.command);

function InstallCard({ status, keyInfo }) {
  const install = commandRows(keyInfo.data?.install);
  const revoke = commandRows(keyInfo.data?.revoke);
  const current = keyInfo.data?.fingerprint || status?.public_key_fingerprint || "";
  const groups = [...revoke.reduce((map, row) => map.set(row.fingerprint || "", [...(map.get(row.fingerprint || "") || []), row]), new Map())];
  return <Card title="Install the key on servers" hint="You run these commands; Lab Manager never runs them. Passwords are typed there, never in the browser.">
    {!status?.key_exists ? <p className="text-zinc-500">Available after the key is generated.</p>
      : keyInfo.loading && !keyInfo.data ? <p role="status" className="text-zinc-500">Loading…</p>
      : <>
        <p className="text-xs text-amber-200">Install only on approved remote servers, never on the Lab Manager VM itself. Operators share the remote account; the Lab Manager audit identifies each person.</p>
        {install.length === 0
          ? <p className="text-zinc-500">{keyInfo.error ? "Install commands are unavailable until the public key loads." : "No allowed servers yet. Allow SSH for a server below to get its install command."}</p>
          : <ul className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
            {install.map((row, i) => <li key={`${row.server}-${i}`} className="space-y-1.5 border-t border-zinc-800 pt-2 first:border-0 first:pt-0">
              <div className="font-mono text-xs font-semibold text-white">{row.server}</div>
              <div className="text-[11px] text-zinc-400">Run on {row.server} as its SSH user (adds a restricted authorized_keys line):</div>
              <CodeBlock text={row.command} label={`Install command for ${row.server}`} />
              <CopyButton text={row.command} what={`install command for ${row.server}`} />
              {row.copy_command && <Alternative summary="Or run it from the Lab Manager VM (asks for the server user's password once)" text={row.copy_command} label={`VM install command for ${row.server}`} />}
              {row.manual && row.manual !== row.command && <Alternative summary="Alternative command" text={row.manual} label={`Alternative command for ${row.server}`} />}
              {row.authorized_keys && <Alternative summary="authorized_keys line only" text={row.authorized_keys} label={`authorized_keys line for ${row.server}`} />}
            </li>)}
          </ul>}
        {groups.length > 0 && <details className="border-t border-zinc-800 pt-3 text-sm">
          <summary className="cursor-pointer font-semibold text-rose-300">Remove a key from servers (revoke)</summary>
          <p className="text-xs text-zinc-400 mt-2">A replaced key still opens every server where it was installed until you remove it there. Use these after a key replacement, or to cut off access to a server.</p>
          {groups.map(([fp, rows]) => <div key={fp || "unknown"} className="mt-3 space-y-2">
            <div className="text-xs"><span className={fp && fp === current ? "text-amber-300" : "text-rose-300"}>{fp && fp === current ? "Current key" : "Previous key"}</span> <span className="font-mono text-zinc-400 break-all">{fp || "—"}</span></div>
            <ul className="space-y-2">
              {rows.map((row, i) => <li key={`${row.server}-${i}`} className="space-y-1">
                <div className="font-mono text-xs text-white">{row.server}</div>
                <CodeBlock text={row.command} label={`Revoke command for ${row.server} (${fp && fp === current ? "current" : "previous"} key)`} />
                <CopyButton text={row.command} what={`revoke command for ${row.server}`} />
              </li>)}
            </ul>
          </div>)}
        </details>}
      </>}
  </Card>;
}

function HostKeyCell({ server, state, canAdmin, onAccept, systemKeys }) {
  // The VM's ssh command checks host keys itself; Lab Manager's pins neither block nor can be accepted.
  if (systemKeys) return <span className="text-zinc-400">Host keys are checked by the VM account's known_hosts</span>;
  const { state: kind, pinned, offered } = state;
  if (kind === "none") return <span className="text-zinc-500">Not pinned yet (pinned on first connection)</span>;
  if (kind === "changed") return <div className="space-y-1">
    <div className="text-rose-300 font-semibold">Changed — connections refused</div>
    <div className="font-mono text-[10px] text-zinc-500 break-all">old {pinned || "—"}</div>
    <div className="font-mono text-[10px] text-zinc-300 break-all">new {offered}</div>
    {canAdmin && <button type="button" className="account-secondary text-rose-300" onClick={() => onAccept(server, pinned, offered)}>Accept new key…</button>}
  </div>;
  return <div className="space-y-1">
    <div className={kind === "confirmed" ? "text-nv-300" : "text-amber-300"}>{kind === "confirmed" ? "Confirmed" : "Pinned, not confirmed"}</div>
    {pinned && <div className="font-mono text-[10px] text-zinc-400 break-all">{pinned}</div>}
    {kind === "unconfirmed" && canAdmin && pinned && <button type="button" className="account-secondary" onClick={() => onAccept(server, pinned, pinned)}>Confirm key…</button>}
  </div>;
}

function ServersCard({ status, config, servers, optIn, canAdmin, accountMode, setting, onAutoAllow, autoAllowLocked, onDirtyChange, onAccept, onSaved, systemKeys }) {
  // Unsaved edits survive status refreshes; rows that appear later start from their saved values.
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState({});
  const [busy, setBusy] = useState(false);
  // With the VM's ssh command every server is allowed automatically (no "allow every server" click): the table edits
  // in that mode, where unticking a server turns it off (denied).
  const systemAuto = !!systemKeys && optIn;
  const base = formFromStatus(systemAuto && status ? { ...status, auto_allow: true } : status,
    systemAuto && config ? { ...config, auto_allow: true } : config);
  const view = form || base;
  const entryFor = key => view.servers[key] || base.servers[key] || { allowed: false, approved_host: "", user: "" };
  const dirty = !!form;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const autoSupported = optIn && (systemAuto || supportsAutoAllow(status, config));
  const autoMode = autoSupported && !!view.auto_allow;   // the saved mode this form edits in
  const savedAuto = autoSupported && !!base.auto_allow;
  const skipped = autoSupported ? skippedServers(status, { system: systemAuto }) : [];
  const settingBusy = !!setting?.busy;

  function edit(change) { setResult({}); setForm(f => change(f || { ...JSON.parse(JSON.stringify(base)), system: systemAuto })); }
  function editServer(key, patch) { edit(f => ({ ...f, servers: { ...f.servers, [key]: { ...(f.servers[key] || base.servers[key] || {}), ...patch } } })); }

  async function save(e) {
    e.preventDefault();
    if (!form || busy || settingBusy) return;
    // The table means different things with "allow every server" on or off; if it was switched elsewhere since these
    // edits began, saving them could turn servers off or on by mistake.
    if (autoSupported && (!!form.auto_allow !== !!base.auto_allow || !!form.system !== systemAuto)) {
      setForm(null); setErrors({});
      setResult({ error: form.system !== systemAuto
        ? "The sign-in keys were changed in the meantime, so your table changes were discarded. Review the table and make them again."
        : "“Allow every server with an address” was switched in the meantime, so your table changes were discarded. Review the table and make them again." });
      return;
    }
    const { ok, errors: found, payload } = buildConfigPayload(form, servers, { optIn, autoAllow: autoSupported ? !!form.auto_allow : undefined });
    setErrors(found);
    if (!ok) { setResult({ error: "Fix the highlighted fields." }); return; }
    setBusy(true); setResult({});
    try {
      const saved = await sshApi.saveConfig(payload, status?.config_revision);
      await onSaved();
      setForm(null); setErrors({});
      const skipped = Array.isArray(saved?.skipped) ? saved.skipped : [];
      setResult({ message: "SSH settings saved.",
        skipped: skipped.map(s => `${String(s?.name || s?.key || "")}: ${String(s?.reason || "")}`.slice(0, 400)) });
    } catch (err) {
      // Someone else saved first: their values win; reload them instead of overwriting.
      if (err.status === 409 || err.status === 412) { setForm(null); setErrors({}); await onSaved(); }
      else if (err.status === 400) onSaved();
      setResult({ error: httpErrorText(err, { accountMode }) });
    } finally { setBusy(false); }
  }

  const columns = [...(optIn ? ["Allow SSH"] : []), "Server", "Host", "SSH user", "Host key", "Open"];
  return <section className="account-card mb-4">
    <header>
      <h2>Servers</h2>
      <p>{systemAuto ? "Lab Manager connects to each server's saved address, on port 22." : optIn ? "SSH works only for servers an Admin allows, to the server's saved address, on port 22." : "Lab Manager connects only to known servers, on port 22."} A blank user uses the default.</p>
    </header>
    <form onSubmit={save} className="p-4 space-y-4" noValidate>
      {systemAuto && <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
        <p className="text-sm font-semibold text-white">SSH works for every lab server automatically; turn a server off here if needed.</p>
        {skipped.length > 0 && <div role="status" className="rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">
          <p className="font-semibold">Not allowed automatically ({skipped.length})</p>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">{skipped.map(item => <li key={item.key}><span className="font-mono">{item.name}</span>{item.reason ? `: ${item.reason}` : ""}</li>)}</ul>
        </div>}
      </div>}
      {autoSupported && !systemAuto && <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {canAdmin
            ? <Switch checked={savedAuto} label="Allow every server with an address" busy={setting?.busy === "auto_allow"}
                disabled={settingBusy || busy || autoAllowLocked || !status?.config_revision} describedBy="ssh-auto-help" onChange={on => onAutoAllow(on, false)} />
            : <p className="text-sm font-semibold text-white">{savedAuto ? "Every server with an address is allowed" : "Only the servers ticked below are allowed"}</p>}
          {canAdmin && savedAuto && <button type="button" className="account-secondary" disabled={settingBusy || busy || autoAllowLocked}
            onClick={() => onAutoAllow(true, true)}>Check addresses again</button>}
        </div>
        <p id="ssh-auto-help" className="text-xs text-zinc-400">{savedAuto
          ? "On: every known server whose saved address the VM can resolve is allowed, to that address only. New servers are allowed automatically. A server you turn off below stays off."
          : "Off: only the servers ticked below are allowed. Turn this on to allow every known server whose saved address the VM can resolve."}</p>
        {canAdmin && autoAllowLocked && <p className="text-xs text-amber-300">Save or discard the changes below before switching this.</p>}
        <SettingResult setting={setting || {}} kind="auto_allow" />
        {skipped.length > 0 && <div role="status" className="rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">
          <p className="font-semibold">Not allowed: no usable address ({skipped.length})</p>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">{skipped.map(item => <li key={item.key}><span className="font-mono">{item.name}</span>{item.reason ? `: ${item.reason}` : ""}</li>)}</ul>
        </div>}
      </div>}
      <label className="flex flex-col gap-1 text-xs text-zinc-400 max-w-xs">Default SSH user
        <input className={inputCls} value={view.default_user} disabled={!canAdmin || !status || busy} maxLength={33} autoComplete="off" spellCheck={false}
          aria-invalid={errors.default_user ? "true" : undefined} aria-describedby={errors.default_user ? "ssh-default-error" : undefined}
          onChange={e => { const value = e.target.value; edit(f => ({ ...f, default_user: value })); }} />
        {errors.default_user && <span id="ssh-default-error" className="account-error">{errors.default_user}</span>}
      </label>
      <div className="user-table-wrap">
        <table className="user-table">
          <thead><tr>{columns.map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {servers.map(s => {
              const entry = entryFor(s.key);
              const approved = entry.allowed ? entry.approved_host || s.host : "";
              const moved = optIn && !autoMode && entry.allowed && entry.approved_host && s.host && !sameHost(entry.approved_host, s.host);
              const noAddress = autoMode && ADDRESS_SKIP_STATES.includes(s.approval) && !entry.explicit;
              const approvalLabel = typeof s.approval === "string" ? APPROVAL_LABELS[s.approval] || "" : "";
              return <tr key={s.key}>
                {optIn && <td>
                  <input type="checkbox" className="w-4 h-4 accent-[#76b900]" checked={!!entry.allowed} disabled={!canAdmin || busy || settingBusy || noAddress}
                    aria-label={`Allow SSH to ${s.name}`} title={noAddress ? s.not_allowed_reason || undefined : undefined}
                    onChange={e => editServer(s.key, allowChange(entry, e.target.checked, { autoAllow: autoMode, host: s.host }))} />
                  {approvalLabel && <div className={`mt-1 text-[10px] ${s.allowed ? "text-nv-300" : "text-zinc-500"}`}>{approvalLabel}</div>}
                </td>}
                <td className="font-mono font-semibold text-white">{s.name}</td>
                <td className="font-mono text-zinc-400 break-all">
                  {optIn ? (entry.allowed ? approved || "—" : <span className="text-zinc-600">{s.host || "—"}</span>) : s.host || "—"}
                  {moved && <div className="mt-1 text-amber-300 font-sans">Now discovered as <span className="font-mono">{s.host}</span>.{canAdmin && <> <button type="button" className="underline" onClick={() => editServer(s.key, { approved_host: s.host })}>Approve this host</button></>}</div>}
                  {errors[`${s.key}:host`] && <div className="account-error mt-1">{errors[`${s.key}:host`]}</div>}
                </td>
                <td>
                  <input className={inputCls} value={entry.user} placeholder={view.default_user || "default"} disabled={!canAdmin || busy} maxLength={33} autoComplete="off" spellCheck={false}
                    aria-label={`SSH user for ${s.name}`} aria-invalid={errors[s.key] ? "true" : undefined}
                    onChange={e => editServer(s.key, { user: e.target.value })} />
                  {errors[s.key] && <div className="account-error mt-1">{errors[s.key]}</div>}
                </td>
                <td><HostKeyCell server={s} state={hostKeyState(s)} canAdmin={canAdmin} onAccept={onAccept} systemKeys={systemKeys} /></td>
                <td><SshButton name={s.name} size="md" /></td>
              </tr>;
            })}
            {status && servers.length === 0 && <tr><td colSpan={columns.length} className="text-zinc-500 py-6 text-center">No known servers yet. Servers come from Ping Monitor and PDU/KVM labels.</td></tr>}
            {!status && <tr><td colSpan={columns.length} className="text-zinc-500 py-6 text-center">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      {result.error && <p role="alert" className="account-error">{result.error}</p>}
      {result.message && <p role="status" className="text-sm text-nv-300">{result.message}</p>}
      {result.skipped?.length > 0 && <div role="alert" className="rounded border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">
        <p className="font-semibold">Not approved ({result.skipped.length}): these servers have no address the VM can reach.</p>
        <ul className="mt-1 list-disc pl-5 space-y-0.5">{result.skipped.map((line, i) => <li key={i}>{line}</li>)}</ul>
      </div>}
      {canAdmin ? <div className="flex flex-wrap gap-2">
        <button className="account-primary" disabled={!dirty || busy || settingBusy}>{busy ? "Saving…" : "Save changes"}</button>
        <button type="button" className="account-secondary" disabled={!dirty || busy} onClick={() => { setForm(null); setErrors({}); setResult({}); }}>Discard changes</button>
      </div> : <p className="text-xs text-zinc-500">Only an Admin can change which servers allow SSH, SSH users and host keys.</p>}
    </form>
  </section>;
}

function SessionsCard({ sessions, accountMode, onRefresh, onEndAll }) {
  const rows = sessions.data || [];
  const open = rows.filter(s => (s.event || "terminal") === "terminal" && toMillis(s.ended_at) == null).length;
  return <section className="account-card">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2>Recent sessions</h2><p>The newest 200 SSH sessions and SSH admin actions. Keystrokes and output are never recorded.</p></div>
      <div className="flex gap-2">
        <button type="button" className="account-secondary text-rose-300" onClick={onEndAll} disabled={!open}>{open ? `End ${open} open session${open === 1 ? "" : "s"}…` : "No open sessions"}</button>
        <button type="button" className="account-secondary" onClick={onRefresh} disabled={sessions.loading}>{sessions.loading ? "Loading…" : "Refresh"}</button>
      </div>
    </header>
    <div className="p-4 space-y-3">
      {sessions.error && <p role="alert" className="account-error">Sessions could not load: {httpErrorText(sessions.error, { accountMode })}</p>}
      <div className="user-table-wrap">
        <table className="user-table">
          <thead><tr>{["Started", "Event", "User", "Server", "Host", "Key", "Duration", "Ended because", "Sent", "Received"].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((s, i) => {
              const start = toMillis(s.started_at), end = toMillis(s.ended_at);
              const terminal = (s.event || "terminal") === "terminal";
              return <tr key={s.id ?? i}>
                <td className="whitespace-nowrap">{fmtTime(start)}</td>
                <td className={terminal ? "text-zinc-300" : "text-amber-200"}>{eventLabel(s.event)}</td>
                <td className="font-mono" title={s.user_name || undefined}>{s.user || "—"}</td>
                <td className="font-mono text-white">{s.server_key || s.server || "—"}</td>
                <td className="font-mono text-zinc-400 break-all">{s.host || "—"}</td>
                <td className="font-mono text-zinc-400 whitespace-nowrap">{terminal ? sessionKeyLabel(s) : "—"}</td>
                <td className="whitespace-nowrap">{!terminal ? "—" : end == null ? <span className="text-nv-300">Open</span> : formatDuration(start, end)}</td>
                <td className="text-zinc-300">{endReasonLabel(s.end_reason)}</td>
                <td className="font-mono whitespace-nowrap">{terminal ? formatBytes(s.bytes_in) : "—"}</td>
                <td className="font-mono whitespace-nowrap">{terminal ? formatBytes(s.bytes_out) : "—"}</td>
              </tr>;
            })}
            {sessions.data && rows.length === 0 && <tr><td colSpan={10} className="text-zinc-500 py-6 text-center">No SSH sessions yet.</td></tr>}
            {!sessions.data && !sessions.error && <tr><td colSpan={10} className="text-zinc-500 py-6 text-center">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}

// Password re-confirmation, like MaintenanceDialog: the password lives only in an uncontrolled input,
// is cleared before the request is sent, and never enters React state. `check` adds a required
// confirmation checkbox (e.g. "the fingerprint matches the console").
function PasswordDialog({ title, description, check, option, confirmLabel, busyLabel, danger, accountMode, onConfirm, onDone, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(false);
  const [optionOn, setOptionOn] = useState(false);
  const panelRef = useRef(null);
  const passwordRef = useRef(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const keyHandler = useRef(null);
  keyHandler.current = onKeyDown;

  function clearPassword() { if (passwordRef.current) passwordRef.current.value = ""; }
  function close() { if (busyRef.current) return; clearPassword(); onClose(); }

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    passwordRef.current?.focus();
    const listener = e => keyHandler.current(e);
    document.addEventListener("keydown", listener);
    return () => {
      mounted.current = false;
      document.removeEventListener("keydown", listener);
      if (passwordRef.current) passwordRef.current.value = "";
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => { if (!busy && error) passwordRef.current?.focus(); }, [busy, error]);

  function onKeyDown(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll("button, input, summary, [href], [tabindex]:not([tabindex='-1'])")]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!panelRef.current.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
      e.preventDefault(); (e.shiftKey ? last : first).focus();
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (busyRef.current) return;
    if (check && !checked) { setError("Tick the confirmation first."); return; }
    const password = passwordRef.current?.value || "";
    if (!password) { setError("Enter the password to confirm."); passwordRef.current?.focus(); return; }
    if (password.length > 256) { clearPassword(); setError("The password is too long."); return; }
    clearPassword();
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await onConfirm(password, optionOn);
      busyRef.current = false;
      await onDone?.(result);
      if (mounted.current) onClose();
    } catch (err) {
      if (err.status === 409 || err.status === 412) sshStatusStore.refresh({ force: true });
      if (mounted.current) setError(err.status === 403 && !err.detail ? "Password is incorrect" : httpErrorText(err, { accountMode }));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="ssh-dialog-title" aria-describedby="ssh-dialog-desc"
      className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg max-h-[calc(100vh-32px)] overflow-y-auto">
      <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
        <div id="ssh-dialog-title" className={`font-medium ${danger ? "text-rose-300" : "text-nv-300"}`}>{title}</div>
        <button type="button" onClick={close} disabled={busy} aria-label="Close" className="text-zinc-400 hover:text-zinc-100 w-7 h-7 rounded hover:bg-zinc-800 disabled:opacity-40">✕</button>
      </div>
      <form onSubmit={submit} noValidate>
        <div className="p-5 space-y-4 text-sm">
          <div id="ssh-dialog-desc" className="space-y-3">{description}</div>
          {check && <label className="flex items-start gap-2 text-sm text-zinc-200">
            <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#76b900]" checked={checked} disabled={busy} onChange={e => { setChecked(e.target.checked); setError(""); }} />
            <span className="break-all">{check}</span>
          </label>}
          {option && <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#76b900]" checked={optionOn} disabled={busy} onChange={e => setOptionOn(e.target.checked)} />
            <span>{option}</span>
          </label>}
          <label className="block">
            <div className="text-xs text-zinc-400 mb-1">{passwordLabel(accountMode === "accounts" ? "account" : "shared")}</div>
            <input ref={passwordRef} type="password" name="ssh-confirm-password" autoComplete="current-password" required maxLength={256} disabled={busy}
              aria-invalid={error ? "true" : undefined} aria-describedby={error ? "ssh-dialog-error" : undefined}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-nv-400/60" />
          </label>
          {error && <p id="ssh-dialog-error" role="alert" className="text-xs text-rose-300">{error}</p>}
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button type="button" onClick={close} disabled={busy} className="text-sm px-3 py-1.5 rounded hover:bg-zinc-800 text-zinc-300 disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={busy || (!!check && !checked)}
            className={`text-sm px-3.5 py-1.5 rounded font-medium disabled:opacity-50 ${danger ? "bg-rose-700 hover:bg-rose-600 text-white" : "bg-nv-400 hover:bg-nv-300 text-zinc-950"}`}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  </div>;
}
