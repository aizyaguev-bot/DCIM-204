// Lab assistant Anthropic API key (/api/assistant/key, Admin only) and the pure helpers AssistantKeyView uses.
// Kept free of DOM/React so node --test can import this module. Requests go through the global fetch wrapper
// (accounts.jsx), which adds X-DCIM-CSRF to writes. Nothing here logs, stores or echoes the key: errors carry only
// the server's fixed detail text (with anything key-like masked), never the request body or a raw response.

export const KEY_PATH = "/api/assistant/key";
// Same rule as the backend keystore.validate_format (checked after trimming).
export const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;
export const KEY_MAX_LENGTH = 256;
export const FORMAT_ERROR = "This does not look like an Anthropic API key (sk-ant-…)";
export const MASTER_KEY_ERROR = "Set LAB_MANAGER_MASTER_KEY on the VM first; the key would not be protected";
export const HELP_SITE = "console.anthropic.com";
export const HELP_TEXT = `Create a key at ${HELP_SITE} → Settings → API Keys → Create Key. It starts with sk-ant- and is shown only once.`;

// Masks anything that looks like a key, so a server message can never put one on screen.
export const redactKey = text => String(text ?? "").replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…");

async function request(method, body) {
  let res;
  try {
    res = await fetch(KEY_PATH, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error("Could not reach the server. Check the connection and try again.");
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    // Only a plain-text detail is used; FastAPI's list form can carry the submitted input, so it is ignored.
    let detail;
    try {
      const parsed = (await res.json())?.detail;
      if (typeof parsed === "string" && parsed.trim()) detail = redactKey(parsed.trim()).slice(0, 300);
    } catch {}
    const err = new Error(detail || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const getKey = () => request("GET");
export const saveKey = ({ key, password, test = true } = {}) =>
  request("PUT", { key: String(key ?? "").trim(), password: String(password ?? ""), test: test !== false });
export const removeKey = ({ password } = {}) => request("DELETE", { password: String(password ?? "") });

export const looksLikeKey = key => KEY_PATTERN.test(String(key ?? "").trim());

// "…" + at most the last 4 characters, whatever the server sent.
export function safeHint(hint) {
  const tail = String(hint ?? "").trim().replace(/^(?:…|\.\.\.)/, "").slice(-4);
  return /^[A-Za-z0-9_-]{1,4}$/.test(tail) ? `…${tail}` : "";
}

export const SOURCE_LABELS = { site: "Site", env: "VM .env", none: "Not set" };
export const MODE_LABELS = { llm: "Language model", demo: "Demo" };
// English text for the router's demo reason codes (assistant/router.py DEMO_REASONS).
export const REASON_TEXT = {
  assistant_disabled: "The assistant is turned off on the server (ASSISTANT_ENABLED=false).",
  llm_disabled: "The language model is turned off on the server (ASSISTANT_LLM_ENABLED=false).",
  no_api_key: "No Anthropic API key is set.",
  sdk_missing: "The anthropic package is not installed on the VM.",
  open_site: "The site has no user accounts and no shared password, so the language model stays off (ASSISTANT_ALLOW_OPEN_LLM=false).",
  daily_limit: "Today's language model question limit is used up (ASSISTANT_DAILY_LIMIT).",
  llm_auth_failed: "The API key was rejected by Anthropic.",
  llm_rate_limited: "Anthropic is rate limiting requests for now.",
  llm_unreachable: "Could not reach the Anthropic API from the VM (network or proxy).",
  llm_unavailable: "The Anthropic API is unavailable right now.",
  llm_rejected: "The Anthropic API rejected the request.",
  llm_error: "A language model call failed.",
};

export function reasonText(reason) {
  if (typeof reason !== "string" || !reason.trim()) return "";
  return (own(REASON_TEXT, reason) && REASON_TEXT[reason]) || redactKey(reason.trim()).slice(0, 300);
}

const own = (map, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key);

// Tolerates missing fields so a partial response still renders.
export function normalizeKeyStatus(data) {
  const source = own(SOURCE_LABELS, data?.source) ? data.source : "none";
  const mode = own(MODE_LABELS, data?.mode) ? data.mode : "";
  return {
    source,
    hint: source === "none" ? "" : safeHint(data?.hint),
    setBy: typeof data?.set_by === "string" ? data.set_by : "",
    setAt: typeof data?.set_at === "string" ? data.set_at : "",
    masterKeyConfigured: data?.master_key_configured === true,
    // A site key row exists but cannot be decrypted (the master key changed): it can be replaced or removed.
    storedKeyUnreadable: data?.stored_key_unreadable === true,
    mode,
    reason: mode === "demo" ? reasonText(data?.reason) || reasonText(data?.reason_code) : "",
  };
}

export function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

// The PUT response's `test`: an object { ok, reason }, a reason string, true, or nothing when the test was skipped.
export function testText(test) {
  if (test && typeof test === "object" && typeof test.reason === "string" && test.reason.trim()) return redactKey(test.reason.trim());
  if (typeof test === "string" && test.trim()) return redactKey(test.trim());
  if (test === true || test?.ok === true) return "Key works";
  return "";
}

export function saveResultText(result, tested) {
  const hint = safeHint(result?.hint);
  const saved = `Saved. The assistant now uses the site key${hint ? ` ${hint}` : ""}.`;
  if (!tested) return `${saved} The key was not tested.`;
  const text = testText(result?.test);
  return text ? `${saved} Test: ${text.replace(/\.$/, "")}.` : saved;
}

export function removedText(status) {
  if (status?.source === "env") return "The site key was removed. The assistant now uses the key from the VM .env file.";
  if (status?.source === "none") return "The site key was removed. No key is set, so the assistant answers in Demo mode.";
  return "The site key was removed.";
}

const ERRORS = {
  0: "Could not reach the server. Check the connection and try again.",
  400: "The request was not accepted. Fill in every field and try again.",
  401: "Your session has expired. Sign in again.",
  403: "Only administrators can change the assistant key.",
  404: "This server version cannot store the assistant key yet.",
  409: MASTER_KEY_ERROR,
  422: "The key was not accepted. Nothing was saved.",
  429: "Too many attempts. Try again in five minutes.",
};

export function keyErrorText(e) {
  return redactKey(e?.detail || ERRORS[e?.status] || (e?.status ? `The request failed (HTTP ${e.status}).` : "The request failed. Check the connection and try again."));
}
