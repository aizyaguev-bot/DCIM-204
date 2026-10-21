// Browser SSH terminal API (/api/ssh) and pure helpers for SshTerminal, SshAdmin and the SSH buttons.
// Helpers stay free of DOM/React so node --test can import this module.
// The browser never receives the private key or any server password: only the public key, fingerprints,
// user names and the terminal stream. Server-supplied reasons are mapped to a fixed English vocabulary
// and are never written into the terminal.

async function req(method, path, body, headers) {
  let res;
  try {
    res = await fetch(`/api/ssh${path}`, {
      method,
      cache: "no-store",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error("Lab Manager did not answer");
    err.network = true;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`${res.status}: ${text}`);
    err.status = res.status;
    try {
      const detail = JSON.parse(text).detail;
      err.detail = typeof detail === "string" ? detail
        : Array.isArray(detail) ? detail.map(e => e?.msg).filter(Boolean).join("; ") || undefined
        : undefined;
    } catch {}
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

const hostPath = (key, action) => `/hosts/${encodeURIComponent(key)}/${action}`;

export const sshApi = {
  status: () => req("GET", "/status"),
  key:    () => req("GET", "/key"),
  // Rotation is a compare-and-swap: the server replaces the key only if it is still `expectedFingerprint`.
  generateKey: (password, { rotate = false, expectedFingerprint = "", endSessions = false } = {}) =>
    req("POST", "/key", rotate
      ? { password, rotate: true, expected_fingerprint: expectedFingerprint, ...(endSessions ? { end_sessions: true } : {}) }
      : { password, rotate: false }),
  // Admin: the exact saved settings {default_user, per_server_user, targets}.
  config: () => req("GET", "/config"),
  // payload from buildConfigPayload; `revision` (status.config_revision) is sent as If-Match.
  saveConfig: (payload, revision) => req("PUT", "/config", payload, revision ? { "If-Match": revision } : undefined),
  // Trust `fingerprint` for this server (marks it confirmed) if the pin is still `expected` ("" = no pin).
  acceptHostKey: (key, password, fingerprint, expected) =>
    req("POST", hostPath(key, "accept"), { password, fingerprint, expected_fingerprint: expected || "" }),
  sessions: () => req("GET", "/sessions"),
  endSessions: (password) => req("POST", "/sessions/end", { password }),
};

// ─── Server identity (mirror of backend ping_monitor.server_identity) ──────────────────────────────
// "opt12 (PSU2)" and "OPT12" are the same server "opt12"; default outlet/port names are not servers.
export function serverKey(name) {
  const text = String(name ?? "").trim();
  if (!text || /^(?:outlet|port)\s*\d+$/i.test(text)) return null;
  const match = /^(optn?\d+)(?:\s*\([^)]*\))?$/i.exec(text);
  return (match ? match[1] : text).toLowerCase();
}

// Status rows carry the server's id (`key`, used in URLs) and its canonical name; a label matches either.
export function findServer(servers, name) {
  const key = serverKey(name);
  if (!key || !Array.isArray(servers)) return null;
  return servers.find(s => s && (s.key === key || serverKey(s.name) === key)) || null;
}

// Only the server id goes into the URL: no command, user, host or input parameters.
export function terminalPageUrl(key) {
  return `/?tab=ssh&server=${encodeURIComponent(key)}`;
}

export const ADMIN_SSH_URL = "/?tab=admin&section=ssh";

// ─── WebSocket protocol ───────────────────────────────────────────────────────────────────────────
// client → server: {"type":"auth","csrf_token":str} first, then {"type":"input","data":str} | {"type":"resize","cols":int,"rows":int}
// server → client: {"type":"output","data":str} | {"type":"status","state":"connecting|connected|closed","reason":str}
// The CSRF token travels only in that first message, never in the URL.

export function terminalUrl(key, loc) {
  if (!key || !loc?.host) return null;
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/api/ssh/${encodeURIComponent(key)}/terminal`;
}

// Read at connect time: AccountsProvider keeps the current session's token on this transport object.
export function currentCsrf(win = globalThis.window) {
  const token = win?.__dcimAccountTransport?.csrf;
  return typeof token === "string" ? token : "";
}

export function authMessage(csrf) {
  return JSON.stringify({ type: "auth", csrf_token: typeof csrf === "string" ? csrf : "" });
}

// The server rejects messages over 64 KiB. 4096 code points stay below that even when every
// character is JSON-escaped (\u0000 = 6 bytes) or a 4-byte UTF-8 sequence; surrogate pairs are never split.
export const INPUT_CHUNK = 4096;
export function inputMessages(data, size = INPUT_CHUNK) {
  if (typeof data !== "string" || data === "") return [];
  const points = Array.from(data);
  const out = [];
  for (let i = 0; i < points.length; i += size) {
    out.push(JSON.stringify({ type: "input", data: points.slice(i, i + size).join("") }));
  }
  return out;
}

export const MAX_COLS = 500;
export const MAX_ROWS = 200;
export function resizeMessage(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  return JSON.stringify({ type: "resize", cols: Math.min(cols, MAX_COLS), rows: Math.min(rows, MAX_ROWS) });
}

const STATES = ["connecting", "connected", "closed"];
export function parseServerMessage(raw) {
  if (typeof raw !== "string") return null;
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== "object") return null;
  if (msg.type === "output" && typeof msg.data === "string") return { type: "output", data: msg.data };
  if (msg.type === "status" && STATES.includes(msg.state)) {
    return { type: "status", state: msg.state, reason: typeof msg.reason === "string" ? msg.reason : "" };
  }
  return null;
}

// SHA256 fingerprints only (base64 body), so nothing else from a reason is ever shown.
export function pinnedFingerprint(reason) {
  const match = /new host key pinned\s+(SHA256:[A-Za-z0-9+/]{16,64}=?)(?=\s|$|[.,;])/i.exec(String(reason ?? ""));
  return match ? match[1] : "";
}

// For any text that would go into the terminal itself: no C0/C1 controls or ESC sequences.
export function stripControls(text) {
  return String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

// xterm link handler policy: only absolute http(s) URLs open, in a new tab without opener/referrer.
export function safeLinkUrl(text) {
  const value = String(text ?? "").trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

// ─── Errors: a fixed vocabulary ───────────────────────────────────────────────────────────────────
export function classifyReason(reason) {
  const text = String(reason ?? "");
  if (!text) return "";
  if (/host key changed|host key mismatch/i.test(text)) return "host-key-changed";
  if (/not installed/i.test(text)) return "not-installed";
  if (/requires user accounts|accounts are not enabled/i.test(text)) return "no-accounts";
  if (/insecure|unencrypted|plain http|requires https/i.test(text)) return "insecure";
  if (/prohibited address|could not be (checked|resolved) safely/i.test(text)) return "target";
  if (/connection rate limit/i.test(text)) return "connect-rate";
  if (/input rate limit/i.test(text)) return "input-rate";
  if (/maximum session length|lifetime/i.test(text)) return "lifetime";
  if (/disabled/i.test(text)) return "disabled";
  if (/csrf/i.test(text)) return "csrf";
  if (/invalid terminal/i.test(text)) return "protocol";
  if (/idle/i.test(text)) return "idle";
  if (/limit|too many|maximum/i.test(text)) return "limit";
  if (/sign.?in|signed.?out|session expired|access revoked|role does not allow/i.test(text)) return "auth";
  if (/not allowed|not approved|must approve/i.test(text)) return "not-allowed";
  if (/timed out|timeout/i.test(text)) return "timeout";
  if (/generate the ssh key|has not been generated|no ssh key/i.test(text)) return "no-key";
  if (/not found/i.test(text)) return "not-found";
  if (/session ended|browser disconnected|cancelled/i.test(text)) return "ended";
  if (/connection failed|could not connect|refused|unreachable|permission denied|authentication/i.test(text)) return "failed";
  return "other";
}

export const NOT_INSTALLED_TEXT = "SSH support is not installed on the Lab Manager server. An Admin must update the Lab Manager installation on the VM so it installs the backend requirements (asyncssh).";
export const DISABLED_TEXT = "The SSH terminal is turned off in the Lab Manager settings.";
export const NO_ACCOUNTS_TEXT = "SSH terminals need user accounts (sign-in) to be enabled on Lab Manager.";
export const INSECURE_TEXT = "SSH terminals stay off until the owner sets SSH_ALLOW_INSECURE_TRANSPORT=true on the VM: Lab Manager uses plain HTTP, so keystrokes would cross the network unencrypted.";
export const NO_KEY_TEXT = "Lab Manager has no SSH key yet. An Admin must generate one in Admin → SSH.";

const CLOSE_CODES = {
  4400: "The terminal sent a message the server did not accept. Reconnect to start again.",
  4401: "Your sign-in session ended. Sign in again, then reconnect.",
  4403: "The terminal could not be authorized. Reload the page and try again.",
  4404: "Lab Manager does not know this server.",
  4409: "The server's host key changed. An Admin must check it and accept the new key in Admin → SSH.",
  4429: "Too many SSH terminals are open. Close another terminal and try again.",
  4503: NOT_INSTALLED_TEXT,
};

// What to show after a terminal closes. `reason` is the server's final status reason (or the close
// frame's reason) and is only classified, never displayed; `server`/`user` come from /api/ssh/status.
export function describeClose({ code, reason, opened, server, user } = {}) {
  const kind = classifyReason(reason) || (code === 4409 ? "host-key-changed" : code === 4503 ? "not-installed" : "");
  const who = server || "this server";
  const fixed = {
    "host-key-changed": ["error", `The host key of ${who} changed. If the server was reinstalled, an Admin can compare and accept the new key in Admin → SSH, then you can reconnect. If it was not reinstalled, do not connect: someone may be intercepting the connection.`],
    "not-installed": ["error", NOT_INSTALLED_TEXT],
    "no-accounts": ["error", NO_ACCOUNTS_TEXT],
    "insecure": ["error", INSECURE_TEXT],
    "disabled": ["error", DISABLED_TEXT],
    "csrf": ["error", CLOSE_CODES[4403]],
    "protocol": ["error", CLOSE_CODES[4400]],
    "idle": ["info", "Closed after a period without typing. Reconnect to continue."],
    "limit": ["error", "Too many SSH terminals are open (per-user or site-wide limit). Close another terminal and try again."],
    "connect-rate": ["error", "Too many connection attempts in the last minute. Wait a minute, then reconnect."],
    "input-rate": ["error", "Input arrived faster than the allowed rate, so the session was closed. Reconnect and paste smaller pieces."],
    "lifetime": ["info", "The session reached its maximum length. Reconnect to continue."],
    "target": ["error", `Lab Manager refused to connect: the address of ${who} is not allowed or could not be checked safely (for example it points to the Lab Manager VM or a local address). Check the server's host in Ping Monitor.`],
    "auth": ["error", "Your sign-in session ended or your access changed. Sign in again, then reconnect."],
    "not-allowed": ["error", `SSH is not allowed for ${who}. An Admin can allow it in Admin → SSH.`],
    "timeout": ["error", `${who} did not answer in time. Check that it is powered on and reachable on port 22.`],
    "no-key": ["error", NO_KEY_TEXT],
    "not-found": ["error", CLOSE_CODES[4404]],
    "ended": ["info", "The SSH session ended."],
    "failed": ["error", `Could not open an SSH session to ${who}. Check that the server is up, that the Lab Manager public key is installed for ${user ? `user "${user}"` : "the SSH user"}, and that the SSH user in Admin → SSH is right.`],
    "other": ["error", "The terminal connection was refused or closed by Lab Manager."],
  }[kind];
  if (fixed) return { tone: fixed[0], kind, text: fixed[1] };
  if (CLOSE_CODES[code]) return { tone: "error", kind: `code-${code}`, text: CLOSE_CODES[code] };
  if (!opened) return { tone: "error", kind: "unreachable", text: "Lab Manager refused the terminal connection before it started. Reload the page and try again; if it keeps failing, check Admin → SSH." };
  if (code === 1000) return { tone: "info", kind: "ended", text: "The SSH session ended." };
  return { tone: "error", kind: "lost", text: "The connection to Lab Manager was lost. Reconnect to start a new session." };
}

// Terminal connection state. Every event carries the attempt number of its WebSocket, so events
// from a socket that was already replaced (Reconnect) are ignored.
// phase: idle → opening (handshake) → authorizing (CSRF sent) → connecting (SSH) → connected → closed
export const INITIAL_CONNECTION = { phase: "idle", attempt: 0, opened: false, finalReason: "", notice: "", closed: null };

export function connectionReducer(state, event) {
  if (event.type === "start") {
    return { ...INITIAL_CONNECTION, phase: "opening", attempt: event.attempt };
  }
  if (event.attempt !== state.attempt || state.phase === "closed") return state;
  switch (event.type) {
    case "open":
      return { ...state, opened: true, phase: state.phase === "opening" ? "authorizing" : state.phase };
    case "status":
      if (event.state === "connecting") return { ...state, phase: "connecting" };
      if (event.state === "connected") {
        const fp = pinnedFingerprint(event.reason);
        return { ...state, phase: "connected",
          notice: fp ? `First connection: the server's host key ${fp} is now pinned but not yet confirmed. Ask an Admin to compare it with the key shown on the server's console (Admin → SSH).` : state.notice };
      }
      return { ...state, finalReason: event.reason || state.finalReason };
    case "close":
      return { ...state, phase: "closed", closed: describeClose({
        code: event.code, reason: state.finalReason || event.reason, opened: state.opened, server: event.server, user: event.user }) };
    case "local-close":
      return { ...state, phase: "closed", closed: { tone: "info", kind: "local", text: "Disconnected." } };
    default:
      return state;
  }
}

export const PHASE_LABEL = {
  idle: "Not connected", opening: "Connecting…", authorizing: "Connecting…", connecting: "Opening SSH session…",
  connected: "Connected", closed: "Disconnected",
};

// REST errors from sshApi, in plain English for the Admin page and dialogs.
export function httpErrorText(err, { accountMode } = {}) {
  if (!err) return "";
  if (err.network) return "Lab Manager did not answer. Check the connection and try again.";
  const detail = err.detail || "";
  const kind = classifyReason(detail);
  if (kind === "no-accounts") return NO_ACCOUNTS_TEXT;
  if (kind === "insecure") return INSECURE_TEXT;
  switch (err.status) {
    case 503: return kind === "disabled" ? DISABLED_TEXT : NOT_INSTALLED_TEXT;
    case 401: return accountMode === "legacy" ? NO_ACCOUNTS_TEXT : "Your session has expired. Sign in again.";
    case 403: return detail || "Your role does not allow this action.";
    case 404: return detail && detail !== "Not Found" ? detail : "SSH is not available on this Lab Manager version.";
    case 409: case 412: return "These SSH settings changed in another window. The page reloaded them; review and try again.";
    case 428: return "Lab Manager needs the current values to confirm this change. Reload the page and try again.";
    case 429: return detail || "Too many attempts. Wait a few minutes and try again.";
    case 400: case 422: return detail || "The request was rejected.";
    default: return detail || err.message || "The request failed.";
  }
}

// ─── Host keys (M1: pins are confirmed by an Admin; a changed key needs "accept") ─────────────────
// Returns { state: "none" | "unconfirmed" | "confirmed" | "changed", pinned, offered }.
export function hostKeyState(server) {
  const hk = server?.host_key;
  if (hk && typeof hk === "object") {
    const pinned = typeof hk.fingerprint === "string" ? hk.fingerprint : "";
    const offered = typeof hk.offered_fingerprint === "string" ? hk.offered_fingerprint : "";
    if (offered && offered !== pinned) return { state: "changed", pinned, offered };
    if (pinned) return { state: hk.confirmed ? "confirmed" : "unconfirmed", pinned, offered: "" };
    return { state: "none", pinned: "", offered: "" };
  }
  // Older status: only "a key is pinned"; it was never confirmed by an Admin.
  if (server?.host_key_known === true) return { state: "unconfirmed", pinned: "", offered: "" };
  return { state: "none", pinned: "", offered: "" };
}

// ─── SSH button availability ──────────────────────────────────────────────────────────────────────
// The backend reports `available` (enabled and transport allowed) with a `blocked_reason`; older
// builds only report insecure_transport_allowed, which matters on a plain-HTTP page.
export function transportBlocked(status, protocol) {
  if (!status) return false;
  if (typeof status.available === "boolean") {
    return !status.available && status.enabled !== false && (status.transport_allowed === false || classifyReason(status.blocked_reason) === "insecure");
  }
  return protocol !== "https:" && status.insecure_transport_allowed === false;
}

// Returns { enabled, reason, server }; `reason` is the tooltip and accessible description.
export function sshAvailability({ status, error, loading, name, accountMode, protocol }) {
  if (accountMode === "legacy") return { enabled: false, reason: NO_ACCOUNTS_TEXT };
  if (!serverKey(name)) return { enabled: false, reason: "Not a server name." };
  if (!status) {
    if (error) return { enabled: false, reason: `SSH status could not load: ${httpErrorText(error, { accountMode })}` };
    return { enabled: false, reason: loading === false ? "SSH status is not loaded." : "Checking SSH availability…" };
  }
  if (status.enabled === false) return { enabled: false, reason: DISABLED_TEXT };
  if (status.installed === false) return { enabled: false, reason: NOT_INSTALLED_TEXT };
  if (transportBlocked(status, protocol)) return { enabled: false, reason: INSECURE_TEXT };
  if (!status.key_exists) return { enabled: false, reason: NO_KEY_TEXT };
  const server = findServer(status.servers, name);
  if (!server) return { enabled: false, reason: `Lab Manager does not know a host for ${name} yet.` };
  const label = server.name || name;
  if (server.allowed === false) return { enabled: false, server, reason: `SSH is not allowed for ${label}. An Admin can allow it in Admin → SSH.` };
  if (hostKeyState(server).state === "changed") return { enabled: false, server, reason: `The host key of ${label} changed. An Admin must check and accept the new key in Admin → SSH.` };
  const target = server.user && (server.approved_host || server.host) ? ` as ${server.user}@${server.approved_host || server.host}` : "";
  return { enabled: true, server, reason: `Open an SSH terminal to ${label}${target} (new tab)` };
}

// ─── Admin settings ───────────────────────────────────────────────────────────────────────────────
// Same rule as the backend: lowercase POSIX user names, at most 32 characters, optional trailing $.
export function isPosixUser(name) {
  return typeof name === "string" && /^[a-z_][a-z0-9_-]{0,31}\$?$/.test(name);
}

// The backend has the opt-in list (H4) when its status rows report `allowed`.
export function hasOptIn(status) {
  return (status?.servers || []).some(s => s && typeof s.allowed === "boolean");
}

// Per-server user overrides. Prefers the explicit map; otherwise derives it from each row's
// effective user (an override equal to the default cannot be told apart and is not kept).
export function overridesFromStatus(status) {
  if (!status) return {};
  const explicit = status.per_server_user;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    return Object.fromEntries(Object.entries(explicit).filter(([, v]) => typeof v === "string" && v));
  }
  const def = status.default_user || "";
  return Object.fromEntries((status.servers || [])
    .filter(s => s?.key && typeof s.user === "string" && s.user && s.user !== def)
    .map(s => [s.key, s.user]));
}

// Editable copy of the saved settings: { default_user, servers: { key: { allowed, approved_host, user } } }.
// `config` (Admin: GET /api/ssh/config) gives the exact per-server users and approved targets.
export function formFromStatus(status, config) {
  const exact = !!(config && typeof config === "object" && config.per_server_user && typeof config.per_server_user === "object");
  const overrides = exact ? overridesFromStatus({ per_server_user: config.per_server_user }) : overridesFromStatus(status);
  const targets = exact && config.targets && typeof config.targets === "object" ? config.targets : null;
  const servers = {};
  for (const s of status?.servers || []) {
    if (!s?.key) continue;
    const allowed = targets ? typeof targets[s.key] === "string" && !!targets[s.key] : s.allowed === true;
    servers[s.key] = { allowed, approved_host: allowed ? (targets ? targets[s.key] : s.approved_host || "") : "", user: overrides[s.key] || "" };
  }
  return { default_user: (exact && config.default_user) || status?.default_user || "", servers };
}

// Approved hosts are compared like the backend does after normalisation (case-insensitive).
export const sameHost = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

// Validates the form for PUT /api/ssh/config. Blank users mean "use the default" and are dropped;
// servers that disappeared are dropped; an allowed server keeps its approved host (or approves the
// currently discovered one when it is newly allowed). Hosts never come from free text.
export function buildConfigPayload(form, servers, { optIn = false } = {}) {
  const errors = {};
  const def = String(form?.default_user ?? "").trim();
  if (!isPosixUser(def)) errors.default_user = "Use a lowercase POSIX user name (letters, digits, _ or -, at most 32 characters).";
  const per = {};
  const allowed = {};
  for (const s of servers || []) {
    if (!s?.key) continue;
    const entry = form?.servers?.[s.key] || {};
    const user = String(entry.user ?? "").trim();
    if (user) {
      if (isPosixUser(user)) per[s.key] = user;
      else errors[s.key] = "Use a lowercase POSIX user name.";
    }
    if (optIn && entry.allowed) {
      const host = entry.approved_host || s.host || "";
      if (!host) errors[`${s.key}:host`] = "Lab Manager has no host for this server.";
      else if (s.host && !sameHost(host, s.host)) errors[`${s.key}:host`] = "The server's host changed. Approve the new host or turn SSH off for this server.";
      else allowed[s.key] = host;
    }
  }
  const payload = { default_user: def, per_server_user: per, ...(optIn ? { allowed } : {}) };
  return { ok: Object.keys(errors).length === 0, errors, payload };
}

export const EVENT_LABELS = {
  terminal: "Terminal", key_generated: "Key generated", key_rotated: "Key replaced", config_updated: "Settings saved",
  host_key_accepted: "Host key accepted", sessions_revoked: "Sessions ended", denied: "Denied",
};
export const END_REASON_LABELS = {
  remote_closed: "Session ended", browser_disconnected: "Browser closed", idle_timeout: "Idle timeout", session_expired: "Signed out or ended by an Admin",
  lifetime_limit: "Maximum length", disabled: "SSH turned off", host_key_changed: "Host key changed", connect_timeout: "Connection timed out",
  connection_failed: "Connection failed", invalid_message: "Invalid message", input_rate_limit: "Input rate limit", cancelled: "Cancelled",
  denied: "Denied", service_interrupted: "Service restarted", admin_action: "—",
};
export const eventLabel = event => EVENT_LABELS[event] || (event ? String(event) : "Terminal");
export const endReasonLabel = reason => reason ? END_REASON_LABELS[reason] || String(reason) : "—";

export function normalizeSessions(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : [];
  return list.filter(s => s && typeof s === "object");
}

// Seconds, milliseconds or ISO text → milliseconds (null when unknown).
export function toMillis(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value).replace(" ", "T"));
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatDuration(startMs, endMs) {
  if (startMs == null || endMs == null || endMs < startMs) return "—";
  const total = Math.round((endMs - startMs) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Shared status store (one request for every SSH button on the page) ───────────────────────────
export const STATUS_MAX_AGE = 60_000;

export function createStatusStore(load = sshApi.status, now = () => Date.now()) {
  let snapshot = { data: null, error: null, loading: false, at: 0 };
  const listeners = new Set();
  let seq = 0;
  let inflight = null;
  const emit = next => { snapshot = next; for (const listener of [...listeners]) listener(); };
  function refresh({ force = false } = {}) {
    if (inflight && !force) return inflight;
    const id = ++seq;
    emit({ ...snapshot, loading: true });
    const run = Promise.resolve().then(load).then(
      data => { if (id === seq) emit({ data, error: null, loading: false, at: now() }); },
      error => { if (id === seq) emit({ data: snapshot.data, error, loading: false, at: now() }); },
    ).finally(() => { if (inflight === run) inflight = null; });
    inflight = run;
    return run;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (!inflight && now() - snapshot.at > STATUS_MAX_AGE) refresh();
      return () => listeners.delete(listener);
    },
    refresh,
  };
}

export const sshStatusStore = createStatusStore();
