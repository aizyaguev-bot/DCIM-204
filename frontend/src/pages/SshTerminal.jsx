import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAccounts } from "../accounts";
import { useSshStatus } from "../components/SshButton";
import {
  sshApi, terminalUrl, currentCsrf, authMessage, inputMessages, resizeMessage, parseServerMessage, safeLinkUrl, createOutputFlow,
  connectionReducer, INITIAL_CONNECTION, PHASE_LABEL, BUSY_PHASES, ADMIN_SSH_URL, httpErrorText, sshAvailability, hostKeyState,
  sshStatusStore, shouldAutoConnect, installRowFor, copyText, NO_KEY_TEXT, classifyReason, KEY_SOURCE_TEXT, normalizeKeySource,
} from "../api/ssh";

const THEME = { background: "#0c0c0c", foreground: "#d4d4d4", cursor: "#76b900", cursorAccent: "#0c0c0c", selectionBackground: "#3f6a14" };
const DOT = { idle: "bg-zinc-600", connected: "bg-nv-400", closed: "bg-zinc-600" };
const BUSY_DOT = "bg-amber-400 animate-pulse";
const RECONNECT_MARK = "\x1b[?1049l\x1b[!p\r\n\x1b[90m[New session]\x1b[0m\r\n";   // fixed text only; never server data
const ADMIN_LINK_KINDS = ["host-key-changed", "not-allowed", "no-key", "code-4409", "denied"];

// Full-height browser terminal for one known server (/?tab=ssh&server=<key>). No private key or password ever
// reaches the browser: the backend signs in with the VM account's SSH keys and/or the Lab Manager key (Admin → SSH)
// and streams only terminal text. When SSH is available for the server the page connects at once; after a close
// the person reconnects with Reconnect. Lab Manager never runs anything on the server by itself.
export default function SshTerminal({ serverKey, onExit }) {
  const { canOperate, canAdmin, mode } = useAccounts();
  if (!serverKey) return <Notice text="No server was selected. Open SSH from a server in Racks, Inventory or Admin → PDU–KVM mapping." onExit={onExit} />;
  if (!canOperate) return <Notice text="SSH terminals require the Operator or Admin role." onExit={onExit} />;
  if (mode === "legacy") return <Notice text={sshAvailability({ name: serverKey, accountMode: mode }).reason} onExit={onExit} />;
  return <TerminalSession serverKey={serverKey} onExit={onExit} canAdmin={canAdmin} accountMode={mode} />;
}

function Notice({ text, onExit }) {
  return <main className="device-page">
    <h1 className="text-2xl font-bold text-white">SSH terminal</h1>
    <p role="alert" className="text-sm text-zinc-400 mt-2">{text}</p>
    <button type="button" className="account-secondary mt-4" onClick={onExit}>Back to Lab Manager</button>
  </main>;
}

function TerminalSession({ serverKey, onExit, canAdmin, accountMode }) {
  const status = useSshStatus();
  const server = status.data?.servers?.find(s => s?.key === serverKey) || null;
  const name = server?.name || serverKey;
  const availability = status.data
    ? sshAvailability({ status: status.data, name: server?.name || serverKey, accountMode, protocol: window.location.protocol })
    : null;
  const blockedReason = availability && !availability.enabled ? availability.reason : "";
  const keySource = normalizeKeySource(status.data?.key_source);
  const [conn, dispatch] = useReducer(connectionReducer, INITIAL_CONNECTION);
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const socketRef = useRef(null);
  const outputRef = useRef(null);
  const attemptRef = useRef(0);
  const autoStartedRef = useRef("");      // the server this page already connected to by itself
  const primaryRef = useRef(null);
  const phaseRef = useRef(conn.phase);
  phaseRef.current = conn.phase;
  const serverRef = useRef({ name, user: server?.user, keySource });
  serverRef.current = { name, user: server?.user, keySource };

  // Keystrokes and size changes go to the server only while the SSH session is open: before that the
  // socket carries just the CSRF message.
  const send = useCallback(text => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && text && phaseRef.current === "connected") ws.send(text);
  }, []);

  const disconnect = useCallback((userAction) => {
    outputRef.current?.dispose();
    outputRef.current = null;
    const ws = socketRef.current;
    socketRef.current = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(1000, "Closed by user"); } catch {}
    if (userAction) dispatch({ type: "local-close", attempt: attemptRef.current });
  }, []);

  const connect = useCallback(() => {
    disconnect(false);
    const attempt = ++attemptRef.current;
    dispatch({ type: "start", attempt });
    let ws;
    try { ws = new WebSocket(terminalUrl(serverKey, window.location)); }
    catch { dispatch({ type: "close", attempt, code: 1006, reason: "" }); return; }
    socketRef.current = ws;
    const term = termRef.current;
    const output = createOutputFlow({
      write: (data, consumed) => term.write(data, consumed),
      send: message => ws.send(message),
      isActive: () => attempt === attemptRef.current && socketRef.current === ws
        && ws.readyState === WebSocket.OPEN && !!term && termRef.current === term,
    });
    outputRef.current = output;
    let opened = false;
    ws.onopen = () => {
      if (attempt !== attemptRef.current) return;
      opened = true;
      dispatch({ type: "open", attempt });
      // The first message carries this session's CSRF token (never the URL), or the server closes with 4403.
      ws.send(authMessage(currentCsrf()));
    };
    ws.onmessage = event => {
      if (attempt !== attemptRef.current) return;
      const msg = parseServerMessage(event.data);
      if (!msg) return;
      if (msg.type === "output") { output.write(msg.data); return; }
      dispatch({ type: "status", attempt, state: msg.state, reason: msg.reason });
      if (msg.state === "connected") {
        const current = termRef.current;
        const size = current && resizeMessage(current.cols, current.rows);
        if (size) { try { ws.send(size); } catch {} }
        current?.focus();
      }
    };
    ws.onclose = event => {
      output.dispose();
      if (outputRef.current === output) outputRef.current = null;
      if (attempt !== attemptRef.current) return;
      if (socketRef.current === ws) socketRef.current = null;
      // Refused before the handshake (the browser gets no reason): reload the status, which names the cause.
      if (!opened) sshStatusStore.refresh({ force: true });
      const { name: serverName, user, keySource: source } = serverRef.current;
      dispatch({ type: "close", attempt, code: event.code, reason: event.reason, server: serverName, user, keySource: source });
    };
  }, [serverKey, disconnect]);

  // One xterm per page; resize follows the container. Hardened options: links open only as http(s) in a
  // new tab without opener, no clipboard/image/proposed-API addons, default (disabled) window options,
  // bounded scrollback, and the remote title is never copied anywhere.
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true, scrollback: 5000, fontSize: 14, theme: THEME, allowProposedApi: false,
      fontFamily: '"JetBrains Mono", Consolas, ui-monospace, monospace',
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (event, text) => {
          const url = safeLinkUrl(text);
          if (url && confirm(`Open this link from the terminal in a new tab?\n\n${url}`)) window.open(url, "_blank", "noopener,noreferrer");
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    const refit = () => { try { fit.fit(); } catch {} };
    refit();
    const inputs = term.onData(data => { for (const message of inputMessages(data)) send(message); });
    let resizeTimer = null;
    const resizes = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => send(resizeMessage(cols, rows)), 120);
    });
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(refit); });
    observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(resizeTimer);
      inputs.dispose();
      resizes.dispose();
      outputRef.current?.dispose();
      outputRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [send]);

  // Leaving the page (or another server) ends the session; another server starts again from "idle" and connects
  // by itself like a freshly opened page.
  useEffect(() => () => {
    disconnect(false);
    autoStartedRef.current = "";
    dispatch({ type: "reset" });
  }, [serverKey, disconnect]);

  // Connect at once when SSH is available for this server; never when the status is missing or refuses.
  const availableNow = !!availability?.enabled;
  useEffect(() => {
    if (!shouldAutoConnect({ status: status.data, availability: { enabled: availableNow }, phase: conn.phase,
      alreadyStarted: autoStartedRef.current === serverKey })) return;
    autoStartedRef.current = serverKey;
    connect();
    termRef.current?.focus();
  }, [status.data, availableNow, conn.phase, serverKey, connect]);

  useEffect(() => {
    const previous = document.title;
    document.title = `SSH · ${name}`;
    return () => { document.title = previous; };
  }, [name]);

  // When the server refused the keys, show this server's Lab Manager key-install command next to the terminal.
  const closedKind = conn.phase === "closed" ? conn.closed?.kind : "";
  const showInstall = closedKind === "auth-failed" && !!status.data?.key_exists;

  // Keyboard users land on Reconnect after a session ends (unless they are already somewhere else).
  useEffect(() => {
    if (conn.phase !== "closed") return;
    const active = document.activeElement;
    if (!active || active === document.body || hostRef.current?.contains(active)) primaryRef.current?.focus();
  }, [conn.phase]);

  function start() {
    if (conn.phase !== "idle") termRef.current?.write(RECONNECT_MARK);
    autoStartedRef.current = serverKey;
    connect();
    termRef.current?.focus();
  }

  function close() {
    disconnect(true);
    // A tab opened from an SSH button closes; otherwise return to the app.
    try { window.close(); } catch {}
    setTimeout(() => { if (!window.closed) onExit(); }, 150);
  }

  const busy = BUSY_PHASES.includes(conn.phase);
  const live = busy || conn.phase === "connected";
  const closed = conn.phase === "closed" ? conn.closed : null;
  const statusError = !status.data && status.error ? httpErrorText(status.error, { accountMode }) : "";
  const statusLoading = status.loading && !status.data && !status.error;
  const keyState = hostKeyState(server);
  const host = server?.approved_host || server?.host || "";
  const target = server?.user && host ? `${server.user}@${host}` : "";
  const canStart = !live && !blockedReason && !statusLoading;
  const primary = live
    ? <button ref={primaryRef} type="button" className="account-secondary" onClick={() => disconnect(true)}>{busy ? "Cancel" : "Disconnect"}</button>
    : <button ref={primaryRef} type="button" className="account-primary" onClick={start} disabled={!canStart}
        title={blockedReason || undefined}>{conn.phase === "idle" ? "Connect" : "Reconnect"}</button>;

  return <main className="flex-1 min-h-0 flex flex-col px-4 pb-3 pt-3 gap-2" aria-label={`SSH terminal for ${name}`}>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-white font-mono truncate">{name}</h1>
        <p className="text-xs text-zinc-400 font-mono truncate">
          {target || (statusLoading ? "Loading server details…" : statusError || (server ? "SSH user and host are not shown" : "Server details unavailable"))}
          {target && <span className="text-zinc-600"> · port 22</span>}
          {target && keySource && <span className="text-zinc-600"> · {KEY_SOURCE_TEXT[keySource]}</span>}
          {keyState.state === "unconfirmed" && <span className="text-amber-300"> · host key not yet confirmed by an Admin</span>}
        </p>
      </div>
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-zinc-300">
        <span aria-hidden="true" className={`w-2 h-2 rounded-full ${DOT[conn.phase] || (busy ? BUSY_DOT : DOT.idle)}`} />
        {PHASE_LABEL[conn.phase] || conn.phase}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {primary}
        <button type="button" className="account-secondary" onClick={close}>Close</button>
      </div>
    </div>
    {blockedReason && !live && <p role="alert" className="text-sm rounded border border-amber-800 bg-amber-950/30 px-3 py-2 text-amber-200">{blockedReason}</p>}
    {conn.notice && <p role="status" className="text-xs rounded border border-amber-800 bg-amber-950/20 px-3 py-2 text-amber-200">{conn.notice}</p>}
    {closed && (
      <div role={closed.tone === "error" ? "alert" : "status"}
        className={`text-sm rounded border px-3 py-2 ${closed.tone === "error" ? "border-rose-900 bg-rose-950/30 text-rose-200" : "border-zinc-800 bg-zinc-900 text-zinc-300"}`}>
        {closed.text}
        {ADMIN_LINK_KINDS.includes(closed.kind) && canAdmin && <> <a className="underline text-nv-300" href={ADMIN_SSH_URL} target="_blank" rel="noopener noreferrer">Open Admin → SSH</a></>}
      </div>
    )}
    {conn.phase === "idle" && !blockedReason && <p role="status" className="text-xs text-zinc-500">
      {statusError ? `SSH status could not load: ${statusError} Click Connect to try anyway.`
        : availability?.enabled ? `Connecting to ${name}${target ? ` as ${target}` : ""}…`
        : `Checking whether SSH is available for ${name}…`}
    </p>}
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-2">
      <div className="relative flex-1 min-h-[240px] rounded border border-zinc-800 bg-[#0c0c0c] p-2 overflow-hidden">
        <div ref={hostRef} className="h-full w-full" />
      </div>
      {showInstall && <KeyInstallPanel key={`${serverKey}:${status.data.public_key_fingerprint || ""}`} serverKey={serverKey} server={server}
        name={name} user={server?.user || ""} accountMode={accountMode} />}
    </div>
  </main>;
}

// Shown after the server refused the keys: the same restricted authorized_keys command as Admin → SSH, for this
// server only. Lab Manager never runs it; the person may copy it and run it on the server (for example from its
// KVM console). Remounted (key) when the server or the Lab Manager key changes.
function KeyInstallPanel({ serverKey, server, name, user, accountMode }) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    setState(s => ({ ...s, loading: true }));
    try {
      const data = await sshApi.key(serverKey);
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState(s => ({ data: s.data, error, loading: false }));
    }
  }, [serverKey]);
  useEffect(() => {
    load();
    return () => { seq.current++; };
  }, [load]);

  const row = installRowFor(state.data, server || { key: serverKey, name });
  const noKey = state.error && (state.error.status === 404 && classifyReason(state.error.detail) === "no-key");
  const placeholderIp = row && (row.source_ip === "<VM IP>" || /<VM IP>/.test(row.command));
  return <aside className="lg:w-[360px] shrink-0 min-h-0 lg:overflow-y-auto rounded border border-zinc-800 bg-zinc-950 text-sm"
    aria-labelledby="ssh-install-title">
    <div className="px-3 py-3 space-y-2">
      <h2 id="ssh-install-title" className="font-semibold text-zinc-200">Install the Lab Manager key on {name}</h2>
      <p className="text-xs text-zinc-400">Run this once on {name}{user ? ` as ${user}` : ""}, for example from its KVM console. It adds one restricted line to ~/.ssh/authorized_keys, so Lab Manager can sign in with its own key. Lab Manager never runs it for you.</p>
      {state.loading && !state.data && <p role="status" className="text-xs text-zinc-500">Loading the command…</p>}
      {state.error && <p role="alert" className="account-error">
        {noKey ? NO_KEY_TEXT : `The command could not load: ${httpErrorText(state.error, { accountMode })}`}
        {!noKey && <> <button type="button" className="underline" onClick={load}>Retry</button></>}
      </p>}
      {state.data && !row && <p className="text-xs text-zinc-500">Lab Manager has no install command for {name}: SSH is not allowed for it.</p>}
      {row && <>
        {row.address_changed && <p className="text-xs text-amber-300">{typeof row.reason === "string" && row.reason.trim() ? row.reason.trim().slice(0, 400) : `The address of ${name} changed. An Admin must allow it again in Admin → SSH before Lab Manager can connect.`}</p>}
        {placeholderIp && <p className="text-xs text-amber-300">Lab Manager could not work out its own address for {name}. Replace &lt;VM IP&gt; with the Lab Manager VM's address before running the command.</p>}
        <pre tabIndex={0} aria-label={`Key-install command for ${name}`}
          className="whitespace-pre-wrap break-all rounded border border-zinc-800 bg-black p-2 text-[11px] leading-relaxed font-mono text-zinc-200 select-all max-h-48 overflow-y-auto">{row.command}</pre>
        <CopyButton text={row.command} what={`key-install command for ${name}`} />
      </>}
      <p className="text-[11px] text-zinc-500">Sessions are logged (who, when, how much data), never what you type or see.</p>
    </div>
  </aside>;
}

function CopyButton({ text, what }) {
  const [result, setResult] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <span className="inline-flex flex-wrap items-center gap-2">
    <button type="button" className="account-secondary" aria-label={`Copy ${what}`}
      onClick={async () => {
        const ok = await copyText(text);
        setResult(ok ? "Copied" : "Copy failed: select the text and copy it");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setResult(""), 2500);
      }}>Copy</button>
    <span role="status" className={`text-[11px] ${result === "Copied" ? "text-nv-300" : "text-amber-300"}`}>{result}</span>
  </span>;
}
