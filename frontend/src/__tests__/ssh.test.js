import test from "node:test";
import assert from "node:assert/strict";
import {
  sshApi, serverKey, findServer, terminalPageUrl, terminalUrl, currentCsrf, authMessage, inputMessages, INPUT_CHUNK,
  resizeMessage, parseServerMessage, pinnedFingerprint, stripControls, safeLinkUrl, classifyReason, describeClose,
  connectionReducer, INITIAL_CONNECTION, httpErrorText, hostKeyState, transportBlocked, sshAvailability, isPosixUser,
  hasOptIn, overridesFromStatus, formFromStatus, buildConfigPayload, normalizeSessions, toMillis, formatDuration,
  formatBytes, createStatusStore, STATUS_MAX_AGE, NOT_INSTALLED_TEXT, DISABLED_TEXT, NO_ACCOUNTS_TEXT, INSECURE_TEXT,
  sameHost, eventLabel, endReasonLabel, createOutputFlow, OUTPUT_HIGH_WATER, OUTPUT_LOW_WATER,
} from "../api/ssh.js";

// Reason texts exactly as backend/app/routers/ssh.py and ssh_store.py send them (2026-10-21).
const BACKEND_INSECURE = "SSH terminal requires SSH_ALLOW_INSECURE_TRANSPORT=true: browser terminal traffic on HTTP is unencrypted; enable this only after accepting that risk and plan HTTPS";

const FP_OLD = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FP_NEW = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// ─── identity and URLs ──────────────────────────────────────────────────────────────────────────
test("server keys follow the backend server_identity rule", () => {
  assert.equal(serverKey("OPT12"), "opt12");
  assert.equal(serverKey("opt12 (PSU2)"), "opt12");
  assert.equal(serverKey("optn3"), "optn3");
  assert.equal(serverKey("  build-host  "), "build-host");
  assert.equal(serverKey("Outlet 7"), null);
  assert.equal(serverKey("port12"), null);
  assert.equal(serverKey(""), null);
  assert.equal(serverKey(null), null);
});

test("a label finds its status row by id or by canonical name", () => {
  const servers = [{ key: "opt12", name: "opt12" }, { key: "3f2a9c", name: "OPT7" }];
  assert.equal(findServer(servers, "OPT12 (PSU1)").key, "opt12");
  assert.equal(findServer(servers, "opt7").key, "3f2a9c");
  assert.equal(findServer(servers, "opt99"), null);
  assert.equal(findServer(servers, "Outlet 1"), null);
  assert.equal(findServer(null, "opt12"), null);
});

test("the terminal page URL carries only the server id", () => {
  assert.equal(terminalPageUrl("opt12"), "/?tab=ssh&server=opt12");
  assert.equal(terminalPageUrl("a b&c=d"), "/?tab=ssh&server=a%20b%26c%3Dd");
});

test("terminal WebSocket URL follows the page scheme and never carries a token", () => {
  assert.equal(terminalUrl("opt12", { protocol: "http:", host: "lab.local:8080" }), "ws://lab.local:8080/api/ssh/opt12/terminal");
  assert.equal(terminalUrl("opt12", { protocol: "https:", host: "lab.local" }), "wss://lab.local/api/ssh/opt12/terminal");
  assert.equal(terminalUrl("a/b?c", { protocol: "http:", host: "h" }), "ws://h/api/ssh/a%2Fb%3Fc/terminal");
  assert.equal(terminalUrl("", { protocol: "http:", host: "h" }), null);
  assert.equal(terminalUrl("opt12", {}), null);
  assert.ok(!/csrf|token/i.test(terminalUrl("opt12", { protocol: "http:", host: "h" })));
});

// ─── message protocol ───────────────────────────────────────────────────────────────────────────
test("the first message carries the CSRF token of the current session", () => {
  assert.deepEqual(JSON.parse(authMessage("tok-123")), { type: "auth", csrf_token: "tok-123" });
  assert.deepEqual(JSON.parse(authMessage(null)), { type: "auth", csrf_token: "" });
  assert.equal(currentCsrf({ __dcimAccountTransport: { csrf: "abc" } }), "abc");
  assert.equal(currentCsrf({ __dcimAccountTransport: { csrf: null } }), "");
  assert.equal(currentCsrf({}), "");
  assert.equal(currentCsrf(undefined), "");
});

test("input is sent as JSON messages, chunked below the 64 KiB server limit", () => {
  assert.deepEqual(inputMessages("ls -la\r").map(m => JSON.parse(m)), [{ type: "input", data: "ls -la\r" }]);
  assert.deepEqual(inputMessages(""), []);
  assert.deepEqual(inputMessages(42), []);
  const paste = "x".repeat(INPUT_CHUNK * 2 + 5);
  const parts = inputMessages(paste);
  assert.equal(parts.length, 3);
  assert.equal(parts.map(m => JSON.parse(m).data).join(""), paste);
  // Worst cases: every character escaped, or every character a 4-byte UTF-8 sequence.
  for (const worst of ["\x01".repeat(INPUT_CHUNK * 3), "😀".repeat(INPUT_CHUNK * 3)]) {
    for (const message of inputMessages(worst)) assert.ok(Buffer.byteLength(message, "utf8") < 65536);
    assert.equal(inputMessages(worst).map(m => JSON.parse(m).data).join(""), worst);
  }
});

test("chunking never splits a surrogate pair", () => {
  const text = "a😀b😀c";
  const parts = inputMessages(text, 2).map(m => JSON.parse(m).data);
  assert.deepEqual(parts, ["a😀", "b😀", "c"]);
  for (const part of parts) assert.ok(!/[\uD800-\uDBFF]$/.test(part));
});

test("resize messages are integers within the server bounds", () => {
  assert.deepEqual(JSON.parse(resizeMessage(120, 40)), { type: "resize", cols: 120, rows: 40 });
  assert.deepEqual(JSON.parse(resizeMessage(9000, 9000)), { type: "resize", cols: 500, rows: 200 });
  assert.equal(resizeMessage(0, 24), null);
  assert.equal(resizeMessage(80.5, 24), null);
  assert.equal(resizeMessage("80", 24), null);
  assert.equal(resizeMessage(undefined, undefined), null);
});

test("output pauses once at the high watermark and resumes only after xterm consumes the backlog", () => {
  const writes = [], callbacks = [], controls = [];
  const flow = createOutputFlow({
    write: (data, consumed) => { writes.push(data); callbacks.push(consumed); },
    send: message => controls.push(JSON.parse(message)),
  });
  const chunk = "x".repeat(64 * 1024);
  const highChunks = OUTPUT_HIGH_WATER / chunk.length;
  for (let i = 0; i < highChunks; i++) flow.write(chunk);
  assert.equal(flow.pendingBytes, OUTPUT_HIGH_WATER);
  assert.deepEqual(controls, [{ type: "pause" }]);
  // Already in-flight frames are still delivered in order without another pause.
  flow.write("tail");
  assert.equal(writes.join(""), chunk.repeat(highChunks) + "tail");
  assert.equal(flow.pendingBytes, OUTPUT_HIGH_WATER + 4);
  assert.equal(controls.length, 1);
  while (flow.pendingBytes > OUTPUT_LOW_WATER + chunk.length) callbacks.shift()();
  assert.equal(flow.paused, true);
  assert.equal(controls.length, 1);
  callbacks.shift()();
  assert.equal(flow.paused, false);
  assert.deepEqual(controls, [{ type: "pause" }, { type: "resume" }]);
  while (callbacks.length) callbacks.shift()();
  assert.equal(flow.pendingBytes, 0);
  assert.equal(controls.length, 2);
  // A later burst can pause and resume independently.
  flow.write("z".repeat(OUTPUT_HIGH_WATER));
  const consumed = callbacks.shift();
  consumed(); consumed();
  assert.equal(flow.pendingBytes, 0);
  assert.deepEqual(controls, [{ type: "pause" }, { type: "resume" }, { type: "pause" }, { type: "resume" }]);
});

test("output watermarks count UTF-8 bytes rather than string length", () => {
  const callbacks = [], controls = [], writes = [];
  const flow = createOutputFlow({
    highWater: 8, lowWater: 2,
    write: (data, consumed) => { writes.push(data); callbacks.push(consumed); },
    send: message => controls.push(JSON.parse(message)),
  });
  flow.write("\u{1f642}");
  flow.write("\u00e9");
  assert.equal(flow.pendingBytes, 6);
  assert.deepEqual(controls, []);
  flow.write("\ud800"); // TextEncoder treats an unpaired surrogate as a three-byte replacement.
  assert.equal(flow.pendingBytes, 9);
  assert.deepEqual(writes, ["\u{1f642}", "\u00e9", "\ud800"]);
  assert.deepEqual(controls, [{ type: "pause" }]);
  callbacks.shift()();
  callbacks.shift()();
  assert.equal(flow.pendingBytes, 3);
  assert.equal(flow.paused, true);
  callbacks.shift()();
  assert.equal(flow.pendingBytes, 0);
  assert.deepEqual(controls, [{ type: "pause" }, { type: "resume" }]);
});

test("output callbacks from a closed or replaced socket cannot control the next connection", () => {
  const oldCallbacks = [], newCallbacks = [], controls = [];
  let epoch = 1, open = true;
  const make = (attempt, callbacks) => createOutputFlow({
    highWater: 4, lowWater: 1,
    write: (data, consumed) => callbacks.push(consumed),
    send: message => controls.push({ attempt, ...JSON.parse(message) }),
    isActive: () => open && epoch === attempt,
  });
  const old = make(1, oldCallbacks);
  old.write("old!");
  epoch = 2;
  const current = make(2, newCallbacks);
  current.write("new!");
  oldCallbacks.shift()();
  assert.equal(old.write("stale output"), false);
  assert.equal(current.pendingBytes, 4);
  assert.deepEqual(controls, [{ attempt: 1, type: "pause" }, { attempt: 2, type: "pause" }]);
  open = false;
  newCallbacks.shift()();
  assert.equal(current.write("after close"), false);
  assert.equal(controls.length, 2);
});

test("disposing an output controller invalidates delayed callbacks without discarding queued writes", () => {
  const callbacks = [], writes = [], controls = [];
  const flow = createOutputFlow({
    highWater: 4, lowWater: 1,
    write: (data, consumed) => { writes.push(data); callbacks.push(consumed); },
    send: message => controls.push(JSON.parse(message)),
  });
  flow.write("tail");
  flow.dispose();
  assert.doesNotThrow(() => callbacks.shift()());
  assert.equal(flow.pendingBytes, 0);
  assert.equal(flow.write("after dispose"), false);
  assert.deepEqual(writes, ["tail"]);
  assert.deepEqual(controls, [{ type: "pause" }]);
});

test("server messages are validated", () => {
  assert.deepEqual(parseServerMessage('{"type":"output","data":"hi"}'), { type: "output", data: "hi" });
  assert.deepEqual(parseServerMessage('{"type":"status","state":"connected","reason":""}'), { type: "status", state: "connected", reason: "" });
  assert.deepEqual(parseServerMessage('{"type":"status","state":"closed"}'), { type: "status", state: "closed", reason: "" });
  assert.equal(parseServerMessage('{"type":"status","state":"exploded"}'), null);
  assert.equal(parseServerMessage('{"type":"output","data":5}'), null);
  assert.equal(parseServerMessage('{"type":"eval","data":"x"}'), null);
  assert.equal(parseServerMessage("not json"), null);
  assert.equal(parseServerMessage("null"), null);
  assert.equal(parseServerMessage(new ArrayBuffer(2)), null);
});

test("only a SHA256 fingerprint is taken from the pinned-key reason", () => {
  assert.equal(pinnedFingerprint(`new host key pinned ${FP_NEW}`), FP_NEW);
  assert.equal(pinnedFingerprint(`new host key pinned ${FP_NEW}.`), FP_NEW);
  assert.equal(pinnedFingerprint("new host key pinned \x1b[31m<b>evil</b>"), "");
  assert.equal(pinnedFingerprint(""), "");
});

test("terminal safety helpers", () => {
  assert.equal(stripControls("a\x1b[31mb\x07c\x9bd\r\n"), "a[31mbcd");
  assert.equal(safeLinkUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeLinkUrl("http://host:8080/"), "http://host:8080/");
  assert.equal(safeLinkUrl("javascript:alert(1)"), null);
  assert.equal(safeLinkUrl("file:///etc/passwd"), null);
  assert.equal(safeLinkUrl("data:text/html,x"), null);
  assert.equal(safeLinkUrl("//evil.example"), null);
  assert.equal(safeLinkUrl("ftp://x"), null);
  assert.equal(safeLinkUrl("https://"), null);
});

// ─── errors ─────────────────────────────────────────────────────────────────────────────────────
test("backend reasons are classified", () => {
  const cases = {
    "Host key changed for opt12 — an Admin must confirm and forget the old key": "host-key-changed",
    "SSH support is not installed on the server": "not-installed",
    "SSH terminal requires user accounts": "no-accounts",
    "SSH over plain HTTP is refused: set SSH_ALLOW_INSECURE_TRANSPORT=true": "insecure",
    "SSH terminal is disabled": "disabled",
    "Refresh the page and retry (invalid CSRF token)": "csrf",
    "Invalid terminal message": "protocol",
    "Idle timeout": "idle",
    "SSH session limit reached": "limit",
    "Sign-in session expired or access revoked": "auth",
    "signed_out": "auth",
    "SSH is not allowed for this server": "not-allowed",
    "SSH connection timed out": "timeout",
    "SSH key has not been generated": "no-key",
    "Generate the SSH key in Admin settings first": "no-key",
    "Server not found": "not-found",
    "SSH session ended": "ended",
    "SSH connection failed": "failed",
    "Cross-origin action rejected": "other",
    [BACKEND_INSECURE]: "insecure",
    "Host key changed; an Admin must confirm the offered fingerprint": "host-key-changed",
    "An Admin must approve this SSH target first": "not-allowed",
    "SSH target resolves to a prohibited address": "target",
    "SSH target could not be resolved safely": "target",
    "SSH connection rate limit reached": "connect-rate",
    "Terminal input rate limit reached": "input-rate",
    "Maximum session length reached": "lifetime",
    "SSH action denied": "other",
    "Browser disconnected": "ended",
    "": "",
  };
  for (const [reason, kind] of Object.entries(cases)) assert.equal(classifyReason(reason), kind, reason);
});

test("new reason kinds have their own fixed messages", () => {
  assert.match(describeClose({ code: 4429, reason: "SSH connection rate limit reached", opened: true }).text, /^Too many connection attempts/);
  assert.match(describeClose({ code: 1011, reason: "Terminal input rate limit reached", opened: true }).text, /paste smaller pieces/);
  assert.equal(describeClose({ code: 1000, reason: "Maximum session length reached", opened: true }).tone, "info");
  assert.match(describeClose({ code: 4403, reason: "SSH target resolves to a prohibited address", opened: true, server: "OPT11" }).text, /address of OPT11 is not allowed/);
  assert.match(describeClose({ code: 4403, reason: "An Admin must approve this SSH target first", opened: true, server: "OPT11" }).text, /not allowed for OPT11/);
  assert.equal(describeClose({ code: 4403, reason: BACKEND_INSECURE, opened: true }).text, INSECURE_TEXT);
});

test("close messages come from a fixed vocabulary, never the raw reason", () => {
  const evil = "Host key changed \x1b]0;pwned\x07 <img src=x onerror=alert(1)>";
  const shown = describeClose({ code: 4409, reason: evil, opened: true, server: "opt12" });
  assert.equal(shown.kind, "host-key-changed");
  assert.match(shown.text, /^The host key of opt12 changed\./);
  assert.ok(!shown.text.includes("pwned") && !shown.text.includes("<img") && !shown.text.includes("\x1b"));
  const other = describeClose({ code: 1011, reason: "Traceback: secret detail", opened: true });
  assert.equal(other.text, "The terminal connection was refused or closed by Lab Manager.");
  assert.equal(describeClose({ code: 4503, reason: "", opened: true }).text, NOT_INSTALLED_TEXT);
  assert.equal(describeClose({ code: 4403, reason: "SSH terminal is disabled", opened: true }).text, DISABLED_TEXT);
  assert.equal(describeClose({ code: 4403, reason: "requires HTTPS (insecure transport)", opened: true }).text, INSECURE_TEXT);
  assert.equal(describeClose({ code: 4429, reason: "SSH session limit reached", opened: true }).kind, "limit");
  assert.equal(describeClose({ code: 1000, reason: "Idle timeout", opened: true }).tone, "info");
  assert.equal(describeClose({ code: 1000, reason: "SSH session ended", opened: true }).text, "The SSH session ended.");
  assert.match(describeClose({ code: 1011, reason: "SSH connection failed", opened: true, server: "opt12", user: "lab" }).text, /user "lab"/);
  assert.equal(describeClose({ code: 4401, reason: "", opened: true }).kind, "code-4401");
  assert.equal(describeClose({ code: 1006, reason: "", opened: false }).kind, "unreachable");
  assert.equal(describeClose({ code: 1006, reason: "", opened: true }).kind, "lost");
  assert.equal(describeClose({ code: 1000, reason: "", opened: true }).kind, "ended");
});

test("REST errors become plain English", () => {
  assert.equal(httpErrorText({ status: 503, detail: "SSH support is not installed on the server" }), NOT_INSTALLED_TEXT);
  assert.equal(httpErrorText({ status: 503, detail: "SSH terminal is disabled" }), DISABLED_TEXT);
  assert.equal(httpErrorText({ status: 403, detail: "SSH terminal requires user accounts" }), NO_ACCOUNTS_TEXT);
  assert.equal(httpErrorText({ status: 403, detail: "Refused: insecure transport" }), INSECURE_TEXT);
  assert.equal(httpErrorText({ status: 401 }, { accountMode: "legacy" }), NO_ACCOUNTS_TEXT);
  assert.equal(httpErrorText({ status: 401 }, { accountMode: "accounts" }), "Your session has expired. Sign in again.");
  assert.equal(httpErrorText({ status: 403, detail: "Password is incorrect" }), "Password is incorrect");
  assert.equal(httpErrorText({ status: 404, detail: "Not Found" }), "SSH is not available on this Lab Manager version.");
  assert.equal(httpErrorText({ status: 404, detail: "Server not found" }), "Server not found");
  assert.match(httpErrorText({ status: 412 }), /changed in another window/);
  assert.match(httpErrorText({ status: 409, detail: "stale" }), /changed in another window/);
  assert.equal(httpErrorText({ status: 429 }), "Too many attempts. Wait a few minutes and try again.");
  assert.match(httpErrorText({ network: true }), /did not answer/);
  assert.equal(httpErrorText(null), "");
});

// ─── connection state ───────────────────────────────────────────────────────────────────────────
test("connection phases follow the socket and the server status", () => {
  let s = connectionReducer(INITIAL_CONNECTION, { type: "start", attempt: 1 });
  assert.equal(s.phase, "opening");
  s = connectionReducer(s, { type: "open", attempt: 1 });
  assert.equal(s.phase, "authorizing");
  s = connectionReducer(s, { type: "status", attempt: 1, state: "connecting", reason: "" });
  assert.equal(s.phase, "connecting");
  s = connectionReducer(s, { type: "status", attempt: 1, state: "connected", reason: `new host key pinned ${FP_NEW}` });
  assert.equal(s.phase, "connected");
  assert.match(s.notice, /SHA256:B+ is now pinned but not yet confirmed/);
  s = connectionReducer(s, { type: "status", attempt: 1, state: "closed", reason: "Idle timeout" });
  assert.equal(s.phase, "connected");
  s = connectionReducer(s, { type: "close", attempt: 1, code: 1000, reason: "" });
  assert.equal(s.phase, "closed");
  assert.equal(s.closed.kind, "idle");
});

test("events from a replaced socket are ignored and a closed session stays closed", () => {
  let s = connectionReducer(INITIAL_CONNECTION, { type: "start", attempt: 1 });
  s = connectionReducer(s, { type: "start", attempt: 2 });
  assert.equal(connectionReducer(s, { type: "close", attempt: 1, code: 1006 }), s);
  assert.equal(connectionReducer(s, { type: "status", attempt: 1, state: "connected" }), s);
  s = connectionReducer(s, { type: "close", attempt: 2, code: 4429, reason: "SSH session limit reached" });
  assert.equal(s.closed.kind, "limit");
  assert.equal(connectionReducer(s, { type: "status", attempt: 2, state: "connected" }), s);
  const local = connectionReducer(connectionReducer(INITIAL_CONNECTION, { type: "start", attempt: 3 }), { type: "local-close", attempt: 3 });
  assert.equal(local.closed.text, "Disconnected.");
  assert.equal(local.closed.tone, "info");
});

test("a refusal before the handshake explains sign-in/role", () => {
  let s = connectionReducer(INITIAL_CONNECTION, { type: "start", attempt: 1 });
  s = connectionReducer(s, { type: "close", attempt: 1, code: 1006, reason: "" });
  assert.equal(s.closed.kind, "unreachable");
});

// ─── host keys and availability ─────────────────────────────────────────────────────────────────
test("host key states", () => {
  assert.equal(hostKeyState({ host_key: null }).state, "none");
  assert.equal(hostKeyState({}).state, "none");
  assert.equal(hostKeyState({ host_key_known: true }).state, "unconfirmed");
  assert.deepEqual(hostKeyState({ host_key: { fingerprint: FP_OLD, confirmed: false } }), { state: "unconfirmed", pinned: FP_OLD, offered: "" });
  assert.equal(hostKeyState({ host_key: { fingerprint: FP_OLD, confirmed: true } }).state, "confirmed");
  assert.deepEqual(hostKeyState({ host_key: { fingerprint: FP_OLD, confirmed: true, offered_fingerprint: FP_NEW } }), { state: "changed", pinned: FP_OLD, offered: FP_NEW });
  assert.equal(hostKeyState({ host_key: { fingerprint: FP_OLD, confirmed: true, offered_fingerprint: FP_OLD } }).state, "confirmed");
});

const READY = {
  enabled: true, installed: true, key_exists: true, insecure_transport_allowed: true, default_user: "lab",
  servers: [
    { key: "opt12", name: "opt12", host: "opt12.lab", user: "lab", allowed: true, approved_host: "opt12.lab", host_key: null },
    { key: "opt13", name: "opt13", host: "opt13.lab", user: "lab", allowed: false, approved_host: null, host_key: null },
    { key: "opt14", name: "opt14", host: "opt14.lab", user: "root", allowed: true, approved_host: "opt14.lab", host_key: { fingerprint: FP_OLD, confirmed: true, offered_fingerprint: FP_NEW } },
  ],
};
const avail = (patch = {}, name = "opt12", extra = {}) =>
  sshAvailability({ status: { ...READY, ...patch }, name, accountMode: "accounts", protocol: "http:", ...extra });

test("the SSH button is enabled only when everything is ready", () => {
  const ok = avail();
  assert.equal(ok.enabled, true);
  assert.equal(ok.server.key, "opt12");
  assert.match(ok.reason, /as lab@opt12\.lab/);
  assert.equal(avail({}, "OPT12 (PSU2)").enabled, true);
});

test("the SSH button explains why it is disabled", () => {
  assert.equal(sshAvailability({ name: "opt12", accountMode: "legacy" }).reason, NO_ACCOUNTS_TEXT);
  assert.equal(sshAvailability({ name: "opt12", accountMode: "accounts", loading: true }).reason, "Checking SSH availability…");
  assert.match(sshAvailability({ name: "opt12", accountMode: "accounts", error: { status: 500, detail: "boom" } }).reason, /could not load: boom/);
  assert.equal(avail({ enabled: false }).reason, DISABLED_TEXT);
  assert.equal(avail({ installed: false }).reason, NOT_INSTALLED_TEXT);
  assert.equal(avail({ insecure_transport_allowed: false }).reason, INSECURE_TEXT);
  assert.equal(avail({ insecure_transport_allowed: false }, "opt12", { protocol: "https:" }).enabled, true);
  assert.match(avail({ key_exists: false }).reason, /no SSH key/);
  assert.match(avail({}, "opt99").reason, /does not know a host for opt99/);
  assert.match(avail({}, "opt13").reason, /not allowed for opt13/);
  assert.match(avail({}, "opt14").reason, /host key of opt14 changed/);
  assert.equal(avail({}, "Outlet 3").enabled, false);
});

test("the backend's available/blocked_reason decides the transport block, whatever the page scheme", () => {
  const blocked = { available: false, transport_allowed: false, insecure_transport_allowed: false, blocked_reason: BACKEND_INSECURE };
  assert.equal(transportBlocked({ ...READY, ...blocked }, "http:"), true);
  assert.equal(transportBlocked({ ...READY, ...blocked }, "https:"), true);
  assert.equal(avail(blocked, "opt12", { protocol: "https:" }).reason, INSECURE_TEXT);
  assert.equal(transportBlocked({ ...READY, available: true, transport_allowed: true }, "http:"), false);
  // Turned off wins over the transport explanation.
  assert.equal(avail({ ...blocked, enabled: false }).reason, DISABLED_TEXT);
  assert.equal(transportBlocked({ ...READY, ...blocked, enabled: false }, "http:"), false);
});

test("an older status without the new fields still works", () => {
  const legacyStatus = { enabled: true, installed: true, key_exists: true, servers: [{ key: "opt12", name: "opt12", host: "opt12", user: "root", host_key_known: true }] };
  assert.equal(sshAvailability({ status: legacyStatus, name: "opt12", accountMode: "accounts", protocol: "http:" }).enabled, true);
  assert.equal(transportBlocked(legacyStatus, "http:"), false);
  assert.equal(hasOptIn(legacyStatus), false);
  assert.equal(hasOptIn(READY), true);
});

// ─── admin settings ─────────────────────────────────────────────────────────────────────────────
test("SSH user names follow the backend rule", () => {
  for (const ok of ["root", "lab", "_svc", "a-b_c9", "a".repeat(32)]) assert.ok(isPosixUser(ok), ok);
  for (const bad of ["", "Root", "9lab", "-x", "a b", "a;rm", "a".repeat(33), "lab@host", "machine$", "root\n", "root\r", "root\u2028", null]) assert.ok(!isPosixUser(bad), String(bad));
});

test("per-server overrides prefer the explicit map", () => {
  assert.deepEqual(overridesFromStatus({ default_user: "lab", per_server_user: { opt12: "root", opt13: "" } }), { opt12: "root" });
  assert.deepEqual(overridesFromStatus(READY), { opt14: "root" });
  assert.deepEqual(overridesFromStatus(null), {});
});

test("the settings form starts from the saved values", () => {
  const form = formFromStatus(READY);
  assert.equal(form.default_user, "lab");
  assert.deepEqual(form.servers.opt12, { allowed: true, approved_host: "opt12.lab", user: "" });
  assert.deepEqual(form.servers.opt13, { allowed: false, approved_host: "", user: "" });
  assert.deepEqual(form.servers.opt14, { allowed: true, approved_host: "opt14.lab", user: "root" });
});

test("the config payload validates users and approves only discovered hosts", () => {
  const form = formFromStatus(READY);
  form.servers.opt13 = { allowed: true, approved_host: "", user: "  ops " };
  form.servers.opt12.user = "";
  form.servers.gone = { allowed: true, approved_host: "evil.example", user: "x" };
  const result = buildConfigPayload(form, READY.servers, { optIn: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    default_user: "lab",
    per_server_user: { opt13: "ops", opt14: "root" },
    allowed: { opt12: "opt12.lab", opt13: "opt13.lab", opt14: "opt14.lab" },
  });
  const legacy = buildConfigPayload(form, READY.servers, { optIn: false });
  assert.deepEqual(Object.keys(legacy.payload).sort(), ["default_user", "per_server_user"]);
  const bad = buildConfigPayload({ default_user: "Root", servers: { opt12: { user: "a b" } } }, READY.servers);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.default_user && bad.errors.opt12);
  const hostless = buildConfigPayload({ default_user: "lab", servers: { x: { allowed: true } } }, [{ key: "x", name: "x", host: "" }], { optIn: true });
  assert.equal(hostless.ok, false);
  assert.ok(hostless.errors["x:host"]);
});

test("the exact Admin config wins over values derived from the status", () => {
  const config = { default_user: "lab", per_server_user: { opt12: "lab", opt14: "root" }, targets: { opt12: "opt12.lab" } };
  const form = formFromStatus(READY, config);
  assert.deepEqual(form.servers.opt12, { allowed: true, approved_host: "opt12.lab", user: "lab" }, "an override equal to the default is kept");
  assert.deepEqual(form.servers.opt14, { allowed: false, approved_host: "", user: "root" });
  assert.equal(formFromStatus(READY, null).servers.opt12.user, "");
});

test("a server whose host moved must be re-approved before saving", () => {
  const servers = [{ key: "opt12", name: "opt12", host: "opt12-new.lab" }];
  const stale = buildConfigPayload({ default_user: "lab", servers: { opt12: { allowed: true, approved_host: "opt12.lab" } } }, servers, { optIn: true });
  assert.equal(stale.ok, false);
  assert.match(stale.errors["opt12:host"], /host changed/);
  const fixed = buildConfigPayload({ default_user: "lab", servers: { opt12: { allowed: true, approved_host: "OPT12-NEW.lab" } } }, servers, { optIn: true });
  assert.equal(fixed.ok, true);
  assert.equal(sameHost("A.lab ", "a.LAB"), true);
});

test("audit rows get readable labels", () => {
  assert.equal(eventLabel("terminal"), "Terminal");
  assert.equal(eventLabel("key_rotated"), "Key replaced");
  assert.equal(eventLabel(undefined), "Terminal");
  assert.equal(eventLabel("something_new"), "something_new");
  assert.equal(endReasonLabel("idle_timeout"), "Idle timeout");
  assert.equal(endReasonLabel(null), "—");
  assert.equal(endReasonLabel("custom"), "custom");
});

test("session rows and times", () => {
  assert.deepEqual(normalizeSessions([{ id: 1 }, null, 3]), [{ id: 1 }]);
  assert.deepEqual(normalizeSessions({ sessions: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(normalizeSessions(undefined), []);
  assert.equal(toMillis("2026-10-21T08:00:00+00:00"), Date.UTC(2026, 9, 21, 8));
  assert.equal(toMillis(1_760_000_000), 1_760_000_000_000);
  assert.equal(toMillis(1_760_000_000_000), 1_760_000_000_000);
  assert.equal(toMillis(null), null);
  assert.equal(toMillis("nonsense"), null);
  assert.equal(formatDuration(0, 59_000), "59s");
  assert.equal(formatDuration(0, 61_000), "1m 1s");
  assert.equal(formatDuration(0, 3_720_000), "1h 2m");
  assert.equal(formatDuration(null, 1), "—");
  assert.equal(formatDuration(5, 1), "—");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatBytes(undefined), "—");
});

// ─── shared status store ────────────────────────────────────────────────────────────────────────
test("the status store shares one request and refreshes when stale", async () => {
  let calls = 0, clock = 1_000_000;
  const store = createStatusStore(async () => { calls++; return { n: calls }; }, () => clock);
  const unsubscribeA = store.subscribe(() => {});
  const unsubscribeB = store.subscribe(() => {});
  await store.refresh();
  assert.equal(calls, 1);
  assert.deepEqual(store.getSnapshot().data, { n: 1 });
  store.subscribe(() => {})();
  assert.equal(calls, 1);
  clock += STATUS_MAX_AGE + 1;
  store.subscribe(() => {});
  await store.refresh();
  assert.equal(calls, 2);
  unsubscribeA(); unsubscribeB();
});

test("a forced refresh wins over an older in-flight response", async () => {
  const resolvers = [];
  const store = createStatusStore(() => new Promise(resolve => resolvers.push(resolve)), () => 1);
  const first = store.refresh();
  const second = store.refresh({ force: true });
  await new Promise(r => setTimeout(r, 0));
  resolvers[1]({ v: "new" });
  await second;
  resolvers[0]({ v: "old" });
  await first;
  assert.deepEqual(store.getSnapshot().data, { v: "new" });
  assert.equal(store.getSnapshot().loading, false);
});

test("a failed refresh keeps the last good status", async () => {
  let fail = false;
  const store = createStatusStore(async () => { if (fail) throw Object.assign(new Error("x"), { status: 500 }); return { ok: 1 }; }, () => 1);
  await store.refresh();
  fail = true;
  await store.refresh();
  assert.deepEqual(store.getSnapshot().data, { ok: 1 });
  assert.equal(store.getSnapshot().error.status, 500);
});

// ─── REST client (mocked fetch) ─────────────────────────────────────────────────────────────────
function mockFetch(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    return responder(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

test("key generation, rotation, config and host-key requests have the agreed shapes", async () => {
  const m = mockFetch(() => json(200, { ok: true }));
  try {
    await sshApi.generateKey("pw");
    await sshApi.generateKey("pw", { rotate: true, expectedFingerprint: FP_OLD });
    await sshApi.saveConfig({ default_user: "lab", per_server_user: {}, allowed: { opt12: "opt12.lab" } }, "rev-7");
    await sshApi.saveConfig({ default_user: "lab", per_server_user: {} });
    await sshApi.acceptHostKey("opt/12", "pw", FP_NEW, FP_OLD);
    await sshApi.status();
    await sshApi.generateKey("pw", { rotate: true, expectedFingerprint: FP_OLD, endSessions: true });
    await sshApi.endSessions("pw");
    await sshApi.config();
  } finally { m.restore(); }
  const [gen, rot, put, putNoRev, accept, status, rotEnd, end, config] = m.calls;
  assert.deepEqual(rotEnd.body, { password: "pw", rotate: true, expected_fingerprint: FP_OLD, end_sessions: true });
  assert.deepEqual([end.method, end.url, end.body], ["POST", "/api/ssh/sessions/end", { password: "pw" }]);
  assert.deepEqual([config.method, config.url], ["GET", "/api/ssh/config"]);
  assert.deepEqual([gen.method, gen.url, gen.body], ["POST", "/api/ssh/key", { password: "pw", rotate: false }]);
  assert.deepEqual(rot.body, { password: "pw", rotate: true, expected_fingerprint: FP_OLD });
  assert.deepEqual([put.method, put.url, put.headers["If-Match"]], ["PUT", "/api/ssh/config", "rev-7"]);
  assert.deepEqual(put.body.allowed, { opt12: "opt12.lab" });
  assert.equal(putNoRev.headers["If-Match"], undefined);
  assert.deepEqual([accept.url, accept.body], ["/api/ssh/hosts/opt%2F12/accept", { password: "pw", fingerprint: FP_NEW, expected_fingerprint: FP_OLD }]);
  assert.deepEqual([status.method, status.url, status.body], ["GET", "/api/ssh/status", undefined]);
});

test("REST failures carry status and detail; network failures are flagged", async () => {
  let m = mockFetch(() => json(503, { detail: "SSH support is not installed on the server" }));
  try {
    await assert.rejects(sshApi.key(), err => err.status === 503 && err.detail === "SSH support is not installed on the server");
  } finally { m.restore(); }
  m = mockFetch(() => json(422, { detail: [{ msg: "bad user" }, { msg: "bad host" }] }));
  try {
    await assert.rejects(sshApi.saveConfig({}), err => err.status === 422 && err.detail === "bad user; bad host");
  } finally { m.restore(); }
  m = mockFetch(() => { throw new TypeError("Failed to fetch"); });
  try {
    await assert.rejects(sshApi.status(), err => err.network === true && httpErrorText(err).includes("did not answer"));
  } finally { m.restore(); }
});

// ─── App.jsx integration (v2.40.0 Admin sub-pages + SSH, merged) ──────────────────────────────
test("App: ?tab=ssh is a page, Admin -> SSH is Operator+ and ?tab=admin&section=ssh opens it", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const sections = app.match(/const ADMIN_SECTIONS = (\[[^\]]+\]);/)?.[1];
  const helper = app.match(/function linkedAdminSection\(search\) \{[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(sections && helper, "App has the Admin section deep link");
  const linked = new Function(`const ADMIN_SECTIONS = ${sections}; ${helper}; return linkedAdminSection;`)();
  assert.equal(linked("?tab=admin&section=ssh"), "ssh");
  assert.equal(linked("?tab=admin&section=assistant"), "assistant");
  assert.equal(linked("?tab=admin&section=<script>"), "devices");
  assert.equal(linked("?tab=admin"), "devices");
  assert.match(app, /useState\(\(\) => \(\{[^}]+\}\)\[new URLSearchParams\(location\.search\)\.get\("tab"\)\] \|\| linkedAdminSection\(location\.search\)\)/);
  assert.match(app, /setAdminSection\(event\.state\?\.adminSection \|\| section \|\| linkedAdminSection\(location\.search\)\)/);
  assert.match(app, /"changelog", "account", "ssh"\]\.includes\(tab\)/);
  assert.match(app, /\.\.\.\(canOperate\?\[\["ssh","SSH"\]\]:\[\]\)/);
  assert.match(app, /adminSection === "ssh" && <SshAdmin \/>/);
  // navigate() never carries the terminal's server id or a section into another page.
  const navigate = app.slice(app.indexOf("  function navigate("), app.indexOf("  function navigateAdmin("));
  assert.match(navigate, /if \(tab !== "ssh"\) url\.searchParams\.delete\("server"\);/);
  assert.match(navigate, /url\.searchParams\.delete\("section"\);/);
  // The terminal page has no assistant panel or footer over it.
  assert.match(app, /\{!sshPage && <AssistantPanel /);
  assert.match(app, /\{!sshPage && <footer /);
});

test("Racks: an SSH button sits next to KVM in the rack diagram, the rack table and the phone list, through the Racks v4 SSH slot", async () => {
  const { readFileSync } = await import("node:fs");
  const dcim = readFileSync(new URL("../pages/DcimView.jsx", import.meta.url), "utf8");
  const component = dcim.slice(dcim.indexOf("function RackSshButton("), dcim.indexOf("function Portal("));
  assert.match(component, /useContext\(ServerActionsContext\)/);
  assert.match(component, /if \(!name \|\| !canOperate\) return null;/, "nothing for Viewers or non-server labels");
  assert.match(component, /<SshButton name=\{name\}/, "the shared SshButton (same server identity as the other SSH buttons)");
  assert.match(component, /onClick=\{e => e\.stopPropagation\(\)\} onKeyDown=\{e => e\.stopPropagation\(\)\}/, "never opens the server row");
  assert.match(dcim, /createContext\(\{ kvmFor: \(\) => null, openConsole: null, sshFor: \(\) => null, canOperate: false,/);
  assert.match(dcim, /sshFor: name => serverIdentity\(name\) \? name : null,/);
  // Racks v4 draws SSH through its slot (data-ssh-slot); the DcimView root fills every slot with RackSshButton.
  assert.match(dcim, /renderSsh: \(server, size\) => <RackSshButton server=\{server\} compact=\{size === "sm"\}\/>,/);
  const slot = dcim.slice(dcim.indexOf("function SshSlot("), dcim.indexOf("\n}", dcim.indexOf("function SshSlot(")));
  assert.match(slot, /renderSsh \? <span data-ssh-slot className="contents">\{renderSsh\(server, size\)\}<\/span> : null/);
  const cell = dcim.slice(dcim.indexOf("function ServerCell("), dcim.indexOf("\n}", dcim.indexOf("function ServerCell(")));
  assert.match(cell, /<KvmButton server=\{server\} compact\/>\s*<SshSlot server=\{server\} size="sm"\/>/);
  assert.match(dcim, /<KvmButton server=\{s\} compact\/><SshSlot server=\{s\} size="sm"\/>/, "rack detail table");
  assert.match(dcim, /<KvmButton server=\{s\}\/><SshSlot server=\{s\} size="sm"\/>/, "phone list");
  assert.match(dcim, /\["U","Name","Type","State","W","Owner","Outlet","Switch","Notes","Actions"\]/, "KVM and SSH share the Actions column");
  assert.match(dcim, /sshSlot=\{<SshSlot server=\{selectedServer\} size="md"\/>\}/, "server details dialog");
});
