import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KEY_PATH, FORMAT_ERROR, MASTER_KEY_ERROR, HELP_TEXT, getKey, saveKey, removeKey, looksLikeKey, safeHint, redactKey,
  normalizeKeyStatus, reasonText, testText, saveResultText, removedText, keyErrorText, formatWhen, SOURCE_LABELS, MODE_LABELS,
} from "../api/assistantKey.js";

// Fake keys only: never a real key, and fetch is always stubbed (nothing leaves the process).
const FAKE_KEY = `sk-ant-${"fake0TEST_key-".repeat(3)}`;
const realFetch = globalThis.fetch;

function stubFetch(t, ...responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return next.clone();
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("getKey reads the Admin key status without a body and without caching", async t => {
  const status = { source: "site", hint: "…ST-x", set_by: "admin", set_at: "2026-10-21T08:00:00+00:00", master_key_configured: true, mode: "llm", reason: null };
  const calls = stubFetch(t, json(status));
  assert.deepEqual(await getKey(), status);
  assert.equal(calls[0].url, "/api/assistant/key");
  assert.equal(calls[0].url, KEY_PATH);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(calls[0].init.headers, {});
});

test("saveKey PUTs the trimmed key, the password and the test flag (default on)", async t => {
  const calls = stubFetch(t, json({ ok: true, source: "site", hint: "…ey-", test: { ok: true, reason: "Key works" } }));
  await saveKey({ key: `  ${FAKE_KEY}\n`, password: "pw" });
  await saveKey({ key: FAKE_KEY, password: "pw", test: false });
  await saveKey({ key: FAKE_KEY, password: "pw", test: true });
  assert.equal(calls[0].url, "/api/assistant/key");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[0].init.body), { key: FAKE_KEY, password: "pw", test: true });
  assert.equal(JSON.parse(calls[1].init.body).test, false);
  assert.equal(JSON.parse(calls[2].init.body).test, true);
});

test("removeKey sends DELETE with only the password", async t => {
  const calls = stubFetch(t, json({ ok: true, source: "env" }));
  await removeKey({ password: "pw" });
  assert.equal(calls[0].url, "/api/assistant/key");
  assert.equal(calls[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[0].init.body), { password: "pw" });
});

test("errors carry the status and the server's fixed detail", async t => {
  stubFetch(t, json({ detail: FORMAT_ERROR }, 422));
  await assert.rejects(saveKey({ key: "nope", password: "pw" }), e => e.status === 422 && e.detail === FORMAT_ERROR && keyErrorText(e) === FORMAT_ERROR);
  stubFetch(t, json({ detail: MASTER_KEY_ERROR }, 409));
  await assert.rejects(saveKey({ key: FAKE_KEY, password: "pw" }), e => e.status === 409 && keyErrorText(e) === MASTER_KEY_ERROR);
  stubFetch(t, json({ detail: "Password is incorrect" }, 403));
  await assert.rejects(removeKey({ password: "wrong" }), e => e.status === 403 && keyErrorText(e) === "Password is incorrect");
});

test("an error never shows the submitted key, even if a response were to echo it", async t => {
  // FastAPI's list-form 422 echoes the input: it is ignored, so only a fixed text by status remains.
  stubFetch(t, json({ detail: [{ msg: "Field required", input: { key: FAKE_KEY, password: "pw" } }] }, 422));
  await assert.rejects(saveKey({ key: FAKE_KEY, password: "pw" }), e => {
    for (const text of [e.message, e.detail ?? "", keyErrorText(e)]) {
      assert.ok(!text.includes(FAKE_KEY) && !text.includes("fake0TEST") && !text.includes("pw"), text);
    }
    return e.status === 422 && keyErrorText(e) === "The key was not accepted. Nothing was saved.";
  });
  stubFetch(t, json({ detail: `Bad key ${FAKE_KEY}` }, 422));
  await assert.rejects(saveKey({ key: FAKE_KEY, password: "pw" }), e => !keyErrorText(e).includes("fake0TEST") && keyErrorText(e) === "Bad key sk-ant-…");
  stubFetch(t, new Response(`<html>${FAKE_KEY}</html>`, { status: 502 }));
  await assert.rejects(saveKey({ key: FAKE_KEY, password: "pw" }), e => e.message === "Request failed (HTTP 502)" && keyErrorText(e) === "The request failed (HTTP 502).");
});

test("a network failure is reported without details", async t => {
  stubFetch(t, new TypeError("Failed to fetch"));
  await assert.rejects(getKey(), e => e.status === 0 && keyErrorText(e) === "Could not reach the server. Check the connection and try again.");
});

test("status texts for the common HTTP errors", () => {
  assert.equal(keyErrorText({ status: 401 }), "Your session has expired. Sign in again.");
  assert.equal(keyErrorText({ status: 403 }), "Only administrators can change the assistant key.");
  assert.equal(keyErrorText({ status: 404 }), "This server version cannot store the assistant key yet.");
  assert.equal(keyErrorText({ status: 409 }), MASTER_KEY_ERROR);
  assert.equal(keyErrorText({ status: 429 }), "Too many attempts. Try again in five minutes.");
  assert.equal(keyErrorText({ status: 500 }), "The request failed (HTTP 500).");
  assert.equal(keyErrorText(undefined), "The request failed. Check the connection and try again.");
});

test("key format matches the backend rule after trimming", () => {
  assert.ok(looksLikeKey(FAKE_KEY));
  assert.ok(looksLikeKey(` ${FAKE_KEY} \n`));
  assert.ok(looksLikeKey(`sk-ant-${"a".repeat(20)}`));
  assert.ok(looksLikeKey(`sk-ant-${"a".repeat(200)}`));
  assert.ok(!looksLikeKey(`sk-ant-${"a".repeat(19)}`));
  assert.ok(!looksLikeKey(`sk-ant-${"a".repeat(201)}`));
  assert.ok(!looksLikeKey(`sk-${"a".repeat(30)}`));
  assert.ok(!looksLikeKey(`SK-ANT-${"a".repeat(30)}`));
  assert.ok(!looksLikeKey(`sk-ant-${"a".repeat(25)} b`));
  assert.ok(!looksLikeKey(`sk-ant-${"a".repeat(25)}.`));
  assert.ok(!looksLikeKey(""));
  assert.ok(!looksLikeKey(undefined));
});

test("the hint shows at most the last 4 characters", () => {
  assert.equal(safeHint("…AbC9"), "…AbC9");
  assert.equal(safeHint("...AbC9"), "…AbC9");
  assert.equal(safeHint(FAKE_KEY), "…key-");
  assert.equal(safeHint("…_x"), "…_x");
  assert.equal(safeHint("…"), "");
  assert.equal(safeHint("…a b!"), "");
  assert.equal(safeHint(null), "");
  assert.equal(redactKey(`x ${FAKE_KEY} y`), "x sk-ant-… y");
  assert.equal(redactKey(FORMAT_ERROR), FORMAT_ERROR);
});

test("status normalisation labels the source and mode and tolerates missing fields", () => {
  const site = normalizeKeyStatus({ source: "site", hint: "…AbC9", set_by: "admin", set_at: "2026-10-21T08:00:00+00:00", master_key_configured: true, mode: "llm", reason: null });
  assert.deepEqual(site, { source: "site", hint: "…AbC9", setBy: "admin", setAt: "2026-10-21T08:00:00+00:00", masterKeyConfigured: true, storedKeyUnreadable: false, mode: "llm", reason: "" });
  assert.equal(SOURCE_LABELS[site.source], "Site");
  assert.equal(MODE_LABELS[site.mode], "Language model");

  const env = normalizeKeyStatus({ source: "env", hint: "…wxyz", master_key_configured: false, mode: "demo", reason: "open_site" });
  assert.equal(SOURCE_LABELS[env.source], "VM .env");
  assert.equal(env.masterKeyConfigured, false);
  assert.equal(MODE_LABELS[env.mode], "Demo");
  assert.match(env.reason, /no user accounts and no shared password/);

  const none = normalizeKeyStatus({ source: "none", hint: "…zzzz", master_key_configured: "yes", mode: "demo", reason: "no_api_key" });
  assert.equal(SOURCE_LABELS[none.source], "Not set");
  assert.equal(none.hint, "");
  assert.equal(none.masterKeyConfigured, false, "only a real true counts");
  assert.equal(none.reason, "No Anthropic API key is set.");

  assert.deepEqual(normalizeKeyStatus(null), { source: "none", hint: "", setBy: "", setAt: "", masterKeyConfigured: false, storedKeyUnreadable: false, mode: "", reason: "" });

  // The backend sends English reason text plus the code; the text wins, the code is the fallback.
  const sent = normalizeKeyStatus({ source: "none", mode: "demo", reason: "No API key is set on the site or in the VM .env file.", reason_code: "no_api_key", stored_key_unreadable: true });
  assert.equal(sent.reason, "No API key is set on the site or in the VM .env file.");
  assert.equal(sent.storedKeyUnreadable, true);
  assert.equal(normalizeKeyStatus({ mode: "demo", reason: null, reason_code: "sdk_missing" }).reason, "The anthropic package is not installed on the VM.");
  assert.equal(normalizeKeyStatus({ mode: "llm", reason: "x", reason_code: "sdk_missing" }).reason, "");
  assert.equal(normalizeKeyStatus({ source: "toString", mode: "constructor" }).source, "none");
  assert.equal(normalizeKeyStatus({ source: "toString", mode: "constructor" }).mode, "");
});

test("demo reasons: known codes in English, other text shown as sent (key-like text masked)", () => {
  assert.equal(reasonText("sdk_missing"), "The anthropic package is not installed on the VM.");
  assert.equal(reasonText("daily_limit"), "Today's language model question limit is used up (ASSISTANT_DAILY_LIMIT).");
  assert.equal(reasonText("לא הוגדר מפתח"), "לא הוגדר מפתח");
  assert.equal(reasonText(`leak ${FAKE_KEY}`), "leak sk-ant-…");
  assert.equal(reasonText("constructor"), "constructor");
  assert.equal(reasonText(null), "");
  assert.equal(reasonText("  "), "");
});

test("save and remove results describe what changed", () => {
  assert.equal(saveResultText({ ok: true, source: "site", hint: "…AbC9", test: { ok: true, reason: "Key works" } }, true),
    "Saved. The assistant now uses the site key …AbC9. Test: Key works.");
  assert.equal(saveResultText({ ok: true, hint: "…AbC9", test: "Anthropic API rate limit — the key itself works" }, true),
    "Saved. The assistant now uses the site key …AbC9. Test: Anthropic API rate limit — the key itself works.");
  assert.equal(saveResultText({ ok: true, hint: "…AbC9", test: null }, false), "Saved. The assistant now uses the site key …AbC9. The key was not tested.");
  assert.equal(saveResultText({ ok: true }, true), "Saved. The assistant now uses the site key.");
  assert.equal(testText(true), "Key works");
  assert.equal(testText({ ok: true }), "Key works");
  assert.equal(testText(null), "");
  assert.match(removedText({ source: "env" }), /key from the VM \.env file/);
  assert.match(removedText({ source: "none" }), /Demo mode/);
  assert.equal(removedText(null), "The site key was removed.");
  assert.equal(formatWhen("not a date"), "");
  assert.equal(formatWhen(""), "");
  assert.notEqual(formatWhen("2026-10-21T08:00:00+00:00"), "");
});

test("help text names where to create a key", () => {
  assert.equal(HELP_TEXT, "Create a key at console.anthropic.com → Settings → API Keys → Create Key. It starts with sk-ant- and is shown only once.");
});

// ---- App.jsx: the Admin "AI assistant" section and its shareable ?tab=assistant link ----
const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const navigationSource = appSource.slice(appSource.indexOf("  function navigate("), appSource.indexOf("  function openDetail("));
const popSource = appSource.slice(appSource.indexOf("    const onPop ="), appSource.indexOf('    window.addEventListener("popstate"'));

function navigationHarness(adminSection = "devices") {
  const state = { adminSection, mainTab: "dashboard" };
  const window = { location: { href: "https://example.test/?tab=dashboard", search: "?tab=dashboard" } };
  const history = {
    state: null,
    pushState(value, title, url) { this.state = value; window.location.href = String(url); window.location.search = new URL(url).search; },
    replaceState(value) { this.state = value; },
  };
  const setters = ["view", "mainTab", "editMode", "adminSection", "openRack"].map(key => value => { state[key] = value; });
  const mainTabRef = { get current() { return state.mainTab; } };
  const actions = () => new Function("window", "history", "setView", "setMainTab", "setEditMode", "setAdminSection", "setOpenRack", "adminSection", `${navigationSource}; return { navigate, navigateAdmin };`)(window, history, ...setters, state.adminSection);
  const pop = new Function("location", "setView", "setMainTab", "setEditMode", "setAdminSection", "setOpenRack", "mainTabRef", `${popSource}; return onPop;`)(window.location, ...setters, mainTabRef);
  return { state, window, history, actions, pop };
}

test("AI assistant has its own shareable ?tab=assistant link and Back restores it", () => {
  const app = navigationHarness();
  app.actions().navigateAdmin("assistant");
  assert.equal(new URL(app.window.location.href).searchParams.get("tab"), "assistant");
  assert.equal(app.state.mainTab, "admin");
  assert.equal(app.state.adminSection, "assistant");
  const entry = app.history.state;
  assert.equal(entry.adminSection, "assistant");
  app.actions().navigateAdmin("connections");
  assert.equal(app.state.adminSection, "connections");
  app.pop({ state: entry });
  assert.equal(app.state.adminSection, "assistant");
  assert.equal(app.state.mainTab, "admin");
  app.pop({ state: null });   // the URL now says ?tab=connections
  assert.equal(app.state.adminSection, "connections");
  app.actions().navigate("assistant");
  assert.equal(app.state.mainTab, "admin");
  assert.equal(app.state.adminSection, "assistant");
});

test("a shared ?tab=assistant link opens Admin -> AI assistant on load", () => {
  const initTab = appSource.match(/const \[mainTab, setMainTab\] = useState\(\(\) => \{\s*const tab = [^;]+;\s*return ([^;]+);/)?.[1];
  assert.ok(initTab, "App reads the start tab from the URL");
  assert.equal(new Function("tab", "preferences", `return ${initTab};`)("assistant", { start_page: "dashboard" }), "admin");
  const initSection = appSource.match(/const \[adminSection, setAdminSection\] = useState\(\(\) => (\(\{[^}]+\}\))\[/)?.[1];
  assert.ok(initSection, "App reads the Admin section from the URL");
  assert.equal(new Function(`return ${initSection};`)().assistant, "assistant");
});

test("the AI assistant sub-tab is listed for Admins only and renders the key page", () => {
  assert.match(appSource, /import AssistantKeyView from "\.\/pages\/AssistantKeyView";/);
  assert.match(appSource, /\.\.\.\(canAdmin\s*\?\s*\[\["assistant",\s*"AI assistant"\]\]\s*:\s*\[\]\)/);
  assert.match(appSource, /adminSection === "assistant" && <AssistantKeyView \/>/);
});

// ---- AssistantKeyView.jsx (JSX is not importable here, so its key handling is checked in the source) ----
const view = readFileSync(new URL("../pages/AssistantKeyView.jsx", import.meta.url), "utf8");
const fn = name => view.slice(view.indexOf(`async function ${name}(`), view.indexOf("\n  }\n", view.indexOf(`async function ${name}(`)));

test("the key field is a password field that is not autocompleted or spell-checked", () => {
  const input = view.match(/<input ref=\{keyInput\}[\s\S]*?\/>/)?.[0];
  assert.ok(input, "key input found");
  assert.match(input, /type="password"/);
  // "one-time-code": browsers never offer to save it as a password (Chrome ignores "off" on password fields).
  assert.match(input, /autoComplete="one-time-code"/);
  assert.match(input, /spellCheck=\{false\}/);
  assert.match(view, />Anthropic API key\s*</);
  assert.match(view, />Your password\s*</);
  assert.match(view, /Test the key before saving/);
  assert.match(view, /const \[testFirst, setTestFirst\] = useState\(true\)/);
});

test("key and password leave state right after a submit, before the request", () => {
  const save = fn("submitSave");
  assert.ok(save.indexOf('setKey("")') > 0 && save.indexOf('setPassword("")') > 0);
  assert.ok(save.indexOf('setKey("")') < save.indexOf("await saveKey"));
  assert.ok(save.indexOf('setPassword("")') < save.indexOf("await saveKey"));
  assert.ok(save.indexOf('setKey("")') < save.indexOf("looksLikeKey"), "cleared even when the format check fails");
  const remove = fn("submitRemove");
  assert.ok(remove.indexOf('setRemovePassword("")') > 0 && remove.indexOf('setRemovePassword("")') < remove.indexOf("await removeKey"));
});

test("results are announced, stale loads are ignored and a missing master key disables Save", () => {
  assert.match(view, /role="status" aria-live="polite"/);
  assert.match(view, /role="alert"/);
  assert.match(view, /if \(mine !== seq\.current\) return null;/);
  assert.match(view, /const canSave = !!status && status\.masterKeyConfigured && !busy;/);
  assert.match(view, /<fieldset disabled=\{!canSave\}/);
  assert.match(view, /LAB_MANAGER_MASTER_KEY is not set on the VM/);
  assert.match(view, /if \(!canAdmin \|\| denied\) return/);
});

test("the key page and its API module never log", () => {
  const api = readFileSync(new URL("../api/assistantKey.js", import.meta.url), "utf8");
  for (const source of [view, api]) assert.doesNotMatch(source, /console\.(?:log|info|warn|error|debug|trace)\b|localStorage|sessionStorage/);
});
