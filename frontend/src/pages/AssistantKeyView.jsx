import { useEffect, useRef, useState } from "react";
import { useAccounts } from "../accounts";
import {
  FORMAT_ERROR, HELP_SITE, HELP_TEXT, KEY_MAX_LENGTH, MODE_LABELS, SOURCE_LABELS, formatWhen, getKey, keyErrorText, looksLikeKey,
  normalizeKeyStatus, removeKey, removedText, saveKey, saveResultText,
} from "../api/assistantKey";

// Admin -> AI assistant: the Anthropic API key the lab assistant uses. The key goes to the server once and is never
// read back; the page shows only its last 4 characters. Key and password leave component state right after a submit.

// A persistent live region, so a success message is announced; errors are alerts.
function Outcome({ outcome }) {
  return <>
    <div role="status" aria-live="polite">{outcome?.message && <p className="text-sm text-nv-300">{outcome.message}</p>}</div>
    {outcome?.error && <p role="alert" className="account-error">{outcome.error}</p>}
  </>;
}

function Card({ title, hint, headingRef, children }) {
  return <section className="account-card">
    <header><h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="focus:outline-none">{title}</h2>{hint && <p>{hint}</p>}</header>
    <div className="account-fields">{children}</div>
  </section>;
}

export default function AssistantKeyView() {
  const { canAdmin, mode: accountMode } = useAccounts();
  const [status, setStatus] = useState(null);         // last status the server sent; kept when a reload fails
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [denied, setDenied] = useState(false);
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [testFirst, setTestFirst] = useState(true);
  const [removePassword, setRemovePassword] = useState("");
  const [busy, setBusy] = useState("");               // "save" | "remove" while a request runs
  const [saveOutcome, setSaveOutcome] = useState(null);
  const [removeOutcome, setRemoveOutcome] = useState(null);
  const seq = useRef(0);
  const keyInput = useRef(null);
  const removeInput = useRef(null);
  const statusHeading = useRef(null);
  const focusNext = useRef(null);                     // focused once the request ends and the form is enabled again

  useEffect(() => {
    if (busy || !focusNext.current) return;
    focusNext.current.current?.focus();
    focusNext.current = null;
  }, [busy, status]);

  // Only the newest request may update the status; an older reply arriving late is ignored. Returns the new status.
  async function load() {
    const mine = ++seq.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = normalizeKeyStatus(await getKey());
      if (mine !== seq.current) return null;
      setStatus(next);
      setDenied(false);
      return next;
    } catch (e) {
      if (mine !== seq.current) return null;
      if (e.status === 403) { setDenied(true); setStatus(null); }
      else setLoadError(keyErrorText(e));
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (canAdmin) load();
    else setLoading(false);
    return () => { seq.current += 1; };   // a reply after leaving the page changes nothing
  }, [canAdmin]);

  async function submitSave(e) {
    e.preventDefault();
    if (busy) return;
    const submitted = { key: key.trim(), password, test: testFirst };
    setKey("");
    setPassword("");
    setSaveOutcome(null);
    setRemoveOutcome(null);
    if (!looksLikeKey(submitted.key)) {
      setSaveOutcome({ error: FORMAT_ERROR });
      keyInput.current?.focus();   // nothing was sent, so the form is still enabled
      return;
    }
    setBusy("save");
    try {
      const result = await saveKey(submitted);
      setSaveOutcome({ message: saveResultText(result, submitted.test) });
      await load();
    } catch (err) {
      setSaveOutcome({ error: keyErrorText(err) });
      if (err.status === 409) load();   // shows why: the master key is missing
      focusNext.current = keyInput;
    } finally {
      setBusy("");
    }
  }

  async function submitRemove(e) {
    e.preventDefault();
    if (busy) return;
    const submitted = { password: removePassword };
    setRemovePassword("");
    setSaveOutcome(null);
    setRemoveOutcome(null);
    setBusy("remove");
    try {
      const result = await removeKey(submitted);
      const next = await load();
      setRemoveOutcome({ message: removedText(next || normalizeKeyStatus(result)) });
      focusNext.current = statusHeading;   // the Remove form is gone once the site key is
    } catch (err) {
      setRemoveOutcome({ error: keyErrorText(err) });
      focusNext.current = removeInput;
    } finally {
      setBusy("");
    }
  }

  const title = <div className="mb-5"><h1 className="text-2xl font-bold text-white">AI assistant</h1>
    <p className="text-sm text-zinc-400 mt-2">The Anthropic API key the lab assistant uses for language model answers. Without a key it answers in Demo mode.</p></div>;
  if (!canAdmin || denied) return <main className="account-page">{title}<p role="alert" className="text-zinc-400">Admin role needed</p></main>;

  const masterMissing = status && !status.masterKeyConfigured;
  const hasSiteKey = status?.source === "site" || !!status?.storedKeyUnreadable;
  const canSave = !!status && status.masterKeyConfigured && !busy;
  const passwordHint = accountMode === "accounts" ? "" : "Enter the shared Lab Manager password.";
  const row = (label, value) => <><dt className="text-zinc-400">{label}</dt><dd className="min-w-0 break-words text-zinc-100">{value || "—"}</dd></>;

  return <main className="account-page">
    {title}
    <div className="account-grid">
      <Card title="Status" hint="What the assistant uses now." headingRef={statusHeading}>
        <p role="status" aria-live="polite" className="text-xs text-zinc-400">{loading ? "Loading the key status…" : ""}</p>
        {loadError && <p role="alert" className="account-error">{loadError}{status ? " Showing the last loaded status." : ""} <button type="button" className="underline" onClick={load} disabled={loading}>Retry</button></p>}
        {status && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          {row("Source", SOURCE_LABELS[status.source])}
          {row("Key", status.hint && <span className="font-mono">{status.hint}</span>)}
          {status.source === "site" && <>{row("Set by", status.setBy)}{row("Set at", formatWhen(status.setAt))}</>}
          {row("Assistant mode", status.mode && <>{MODE_LABELS[status.mode]}{status.reason && <span className="block text-xs text-zinc-400 mt-0.5">{status.reason}</span>}</>)}
        </dl>}
        {status?.storedKeyUnreadable && <p className="border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">A key saved on the site can no longer be decrypted (was LAB_MANAGER_MASTER_KEY changed?). Save a new key or remove the site key.</p>}
        <Outcome outcome={removeOutcome?.message ? removeOutcome : null} />
        <button type="button" className="account-secondary self-start disabled:opacity-50" onClick={load} disabled={loading || !!busy}>Refresh</button>
      </Card>

      <Card title="Set the API key" hint="A key saved here takes precedence over the VM .env key and applies within seconds, without a restart.">
        <p className="text-sm text-zinc-300">{HELP_TEXT.split(HELP_SITE)[0]}<a href={`https://${HELP_SITE}/settings/keys`} target="_blank" rel="noopener noreferrer" className="text-nv-300 underline">{HELP_SITE}</a>{HELP_TEXT.split(HELP_SITE)[1]}</p>
        {masterMissing && <p className="border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">LAB_MANAGER_MASTER_KEY is not set on the VM, so a key saved here would not be protected. Saving is turned off until it is set in the VM's service environment.</p>}
        <form className="account-fields" onSubmit={submitSave} aria-busy={busy === "save"}>
          <fieldset disabled={!canSave} className="account-fields disabled:opacity-60">
            <label>Anthropic API key
              <input ref={keyInput} type="password" name="assistant-api-key" value={key} onChange={e => setKey(e.target.value)} required
                autoComplete="one-time-code" spellCheck={false} autoCapitalize="off" autoCorrect="off" maxLength={KEY_MAX_LENGTH}
                placeholder="sk-ant-…" data-1p-ignore="" data-lpignore="true" aria-describedby="assistant-key-note" />
            </label>
            <p id="assistant-key-note" className="text-xs text-zinc-500 -mt-2">Stored encrypted on the server. Only its last 4 characters are ever shown.</p>
            <label>Your password
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" maxLength={256}
                aria-describedby={passwordHint ? "assistant-key-password-note" : undefined} />
            </label>
            {passwordHint && <p id="assistant-key-password-note" className="text-xs text-zinc-500 -mt-2">{passwordHint}</p>}
            <label className="account-check"><input type="checkbox" checked={testFirst} onChange={e => setTestFirst(e.target.checked)} />Test the key before saving</label>
            <button className="account-primary self-start disabled:opacity-50 disabled:cursor-not-allowed">{busy === "save" ? (testFirst ? "Testing the key…" : "Saving…") : "Save"}</button>
          </fieldset>
          {busy === "save" && testFirst && <p className="text-xs text-zinc-400">The test asks Anthropic once and can take up to 15 seconds.</p>}
          {!status && !loading && <p className="text-xs text-zinc-500">Saving is available once the key status has loaded.</p>}
          <Outcome outcome={saveOutcome} />
        </form>
      </Card>

      {(hasSiteKey || removeOutcome?.error) && <Card title="Remove the site key" hint={hasSiteKey ? "The assistant falls back to the VM .env key if one is set, otherwise to Demo mode." : undefined}>
        {hasSiteKey && <form className="account-fields" onSubmit={submitRemove} aria-busy={busy === "remove"}>
          <label>Your password
            <input ref={removeInput} type="password" value={removePassword} onChange={e => setRemovePassword(e.target.value)} required autoComplete="current-password" maxLength={256} disabled={!!busy} />
          </label>
          <button className="account-secondary self-start text-rose-300 disabled:opacity-50" disabled={!!busy}>{busy === "remove" ? "Removing…" : "Remove the site key"}</button>
        </form>}
        <Outcome outcome={removeOutcome?.error ? removeOutcome : null} />
      </Card>}
    </div>
  </main>;
}
