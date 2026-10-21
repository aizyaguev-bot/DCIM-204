import { useCallback, useEffect, useReducer, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAccounts } from "../accounts";
import { useSshStatus } from "../components/SshButton";
import {
  terminalUrl, currentCsrf, authMessage, inputMessages, resizeMessage, parseServerMessage, safeLinkUrl,
  connectionReducer, INITIAL_CONNECTION, PHASE_LABEL, ADMIN_SSH_URL, httpErrorText, sshAvailability, hostKeyState, sshStatusStore,
} from "../api/ssh";

const THEME = { background: "#0c0c0c", foreground: "#d4d4d4", cursor: "#76b900", cursorAccent: "#0c0c0c", selectionBackground: "#3f6a14" };
const DOT = { idle: "bg-zinc-600", opening: "bg-amber-400 animate-pulse", authorizing: "bg-amber-400 animate-pulse", connecting: "bg-amber-400 animate-pulse", connected: "bg-nv-400", closed: "bg-zinc-600" };
const RECONNECT_MARK = "\x1b[?1049l\x1b[!p\r\n\x1b[90m[New session]\x1b[0m\r\n";   // fixed text only; never server data

// Full-height browser terminal for one known server (/?tab=ssh&server=<key>). Keys and passwords
// never reach the browser: the backend connects with its own key and streams only terminal text.
// Nothing connects until the user clicks Connect.
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
  // A failed status request does not block: the server decides and its refusal is shown.
  const blockedReason = availability && !availability.enabled ? availability.reason : "";
  const [conn, dispatch] = useReducer(connectionReducer, INITIAL_CONNECTION);
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const socketRef = useRef(null);
  const attemptRef = useRef(0);
  const serverRef = useRef({ name, user: server?.user });
  serverRef.current = { name, user: server?.user };

  const send = useCallback(text => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && text) ws.send(text);
  }, []);

  const disconnect = useCallback((userAction) => {
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
    let opened = false;
    ws.onopen = () => {
      if (attempt !== attemptRef.current) return;
      opened = true;
      dispatch({ type: "open", attempt });
      // The first message carries this session's CSRF token (never the URL), or the server closes with 4403.
      ws.send(authMessage(currentCsrf()));
      const term = termRef.current;
      const size = term && resizeMessage(term.cols, term.rows);
      if (size) ws.send(size);
    };
    ws.onmessage = event => {
      if (attempt !== attemptRef.current) return;
      const msg = parseServerMessage(event.data);
      if (!msg) return;
      if (msg.type === "output") { termRef.current?.write(msg.data); return; }
      dispatch({ type: "status", attempt, state: msg.state, reason: msg.reason });
      if (msg.state === "connected") termRef.current?.focus();
    };
    ws.onclose = event => {
      if (attempt !== attemptRef.current) return;
      if (socketRef.current === ws) socketRef.current = null;
      // Refused before the handshake (the browser gets no reason): reload the status, which names the cause.
      if (!opened) sshStatusStore.refresh({ force: true });
      dispatch({ type: "close", attempt, code: event.code, reason: event.reason, server: serverRef.current.name, user: serverRef.current.user });
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
      term.dispose();
      termRef.current = null;
    };
  }, [send]);

  // Leaving the page (or another server) ends the session.
  useEffect(() => () => disconnect(false), [serverKey, disconnect]);

  useEffect(() => {
    const previous = document.title;
    document.title = `SSH · ${name}`;
    return () => { document.title = previous; };
  }, [name]);

  function start() {
    if (conn.phase !== "idle") termRef.current?.write(RECONNECT_MARK);
    connect();
    termRef.current?.focus();
  }

  function close() {
    disconnect(true);
    // A tab opened from an SSH button closes; otherwise return to the app.
    try { window.close(); } catch {}
    setTimeout(() => { if (!window.closed) onExit(); }, 150);
  }

  const busy = ["opening", "authorizing", "connecting"].includes(conn.phase);
  const live = busy || conn.phase === "connected";
  const closed = conn.phase === "closed" ? conn.closed : null;
  const statusError = !status.data && status.error ? httpErrorText(status.error, { accountMode }) : "";
  const keyState = hostKeyState(server);
  const target = server?.user && (server.approved_host || server.host) ? `${server.user}@${server.approved_host || server.host}` : "";
  const canStart = !live && !blockedReason && !(status.loading && !status.data);
  const primary = live
    ? <button type="button" className="account-secondary" onClick={() => disconnect(true)}>{busy ? "Cancel" : "Disconnect"}</button>
    : <button type="button" className={conn.phase === "idle" ? "account-primary" : "account-secondary"} onClick={start} disabled={!canStart}
        title={blockedReason || undefined}>{conn.phase === "idle" ? "Connect" : "Reconnect"}</button>;

  return <main className="flex-1 min-h-0 flex flex-col px-4 pb-3 pt-3 gap-2" aria-label={`SSH terminal for ${name}`}>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-white font-mono truncate">{name}</h1>
        <p className="text-xs text-zinc-400 font-mono truncate">
          {target || (status.loading && !status.data ? "Loading server details…" : statusError || (server ? "SSH user and host are not shown" : "Server details unavailable"))}
          {target && <span className="text-zinc-600"> · port 22</span>}
          {keyState.state === "unconfirmed" && <span className="text-amber-300"> · host key not yet confirmed by an Admin</span>}
        </p>
      </div>
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-zinc-300">
        <span aria-hidden="true" className={`w-2 h-2 rounded-full ${DOT[conn.phase] || DOT.idle}`} />
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
        {["host-key-changed", "not-allowed", "no-key", "code-4409"].includes(closed.kind) && canAdmin && <> <a className="underline text-nv-300" href={ADMIN_SSH_URL} target="_blank" rel="noopener noreferrer">Open Admin → SSH</a></>}
      </div>
    )}
    {conn.phase === "idle" && !blockedReason && <p className="text-xs text-zinc-500">Click Connect to open an SSH session{target ? ` as ${target}` : ""}. The session is logged (who, when, how much data) but not what you type or see.</p>}
    <div className="flex-1 min-h-[240px] rounded border border-zinc-800 bg-[#0c0c0c] p-2 overflow-hidden">
      <div ref={hostRef} className="h-full w-full" />
    </div>
  </main>;
}
