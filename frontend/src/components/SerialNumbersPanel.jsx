import { useEffect, useId, useRef, useState } from "react";
import { useAccounts } from "../accounts";
import { applyDetails, CHANGE_LABELS, COLUMN_LABELS, downloadSerialsCsv, loadSerials, parseDetails, previewDetails, requestItems, serialsText } from "../api/serialDetails";

// Scan & Track > Serial numbers: export every unit's serial number (switches first) to look the units up elsewhere,
// for example as "Switch" on the SN analysis page, then import the product name and part number found there.
// Everyone can see and export the list; importing is for Operators and Admins and always shows a preview first.
const input = "w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-nv-400 disabled:opacity-50";
const primary = "rounded-lg px-4 py-2.5 text-sm font-semibold bg-nv-400 text-zinc-950 hover:bg-nv-300 disabled:opacity-40";
const secondary = "rounded-lg px-4 py-2.5 text-sm border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40";
const SOURCE = "webpe SN analysis";
const READ_ONLY = "Importing details requires the Operator or Admin role.";
const OVERWRITE_LABEL = "Also replace names and models set by hand";
const STATUS_TEXT = { updated: "Will change", unchanged: "No change", not_found: "Not found", ambiguous: "Ambiguous" };
const STATUS_DONE = { updated: "Updated", unchanged: "No change", not_found: "Not found", ambiguous: "Ambiguous" };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const placeOf = unit => unit ? `${unit.rack}${unit.u ? ` · U${unit.u}` : ""}${unit.position ? ` · ${unit.position}` : ""}` : "";
const failure = e => e instanceof TypeError ? "Could not reach the server. Check the connection and try again." : e?.message || "Something went wrong.";

function summary(counts, applied) {
  const parts = [`${counts.updated} ${applied ? "updated" : "will change"}`, `${counts.unchanged} unchanged`];
  if (counts.not_found) parts.push(`${counts.not_found} not found`);
  if (counts.ambiguous) parts.push(`${counts.ambiguous} ambiguous`);
  return parts.join(" · ");
}

// The server's name_kept note names its API option; here it names the checkbox that does the same.
const NAME_KEPT = `Name kept: the unit already has its own name. Turn on "${OVERWRITE_LABEL}" to replace it.`;

function ChangeList({ entry }) {
  if (entry.status !== "updated") return <span className="text-zinc-400">{entry.detail || (entry.name_kept ? NAME_KEPT : "Already up to date")}</span>;
  return <ul className="space-y-0.5">
    {Object.entries(entry.changes).map(([field, { before, after }]) => <li key={field} className="break-words">
      <span className="text-zinc-400">{CHANGE_LABELS[field] || field}:</span> <span className="line-through text-zinc-500">{before || "empty"}</span> → <span className="text-zinc-100">{after}</span>
    </li>)}
    {entry.name_kept && <li className="text-xs text-zinc-500">{NAME_KEPT}</li>}
  </ul>;
}

export default function SerialNumbersPanel({ onChanged }) {
  const { canOperate } = useAccounts();
  const [list, setList] = useState(null);
  const [listError, setListError] = useState("");
  const [copied, setCopied] = useState("");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [markSwitch, setMarkSwitch] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const listId = useId();
  const items = list?.items || [];
  const switches = items.filter(item => item.type === "switch").length;

  async function refresh() {
    try {
      const { data } = await loadSerials();
      if (mounted.current) { setList(data); setListError(""); }
    } catch (e) { if (mounted.current) setListError(failure(e)); }
  }
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, []);

  // Any edit of the import makes the shown preview stale: it is dropped, so Apply always sends what was previewed.
  function edited(value) { setText(value); setPreview(null); setParsed(null); setResult(null); setError(""); }

  async function exportCsv() {
    setError("");
    try {
      const blob = await downloadSerialsCsv();
      const url = URL.createObjectURL(blob);
      const anchor = Object.assign(document.createElement("a"), { href: url, download: "serial-numbers.csv" });
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(failure(e)); }
  }

  async function copyList() {
    const value = serialsText(items);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(`Copied ${plural(value ? value.split("\n").length : 0, "serial number")}.`);
    } catch {
      // No clipboard permission (or not a secure page): select the list so Ctrl+C copies it.
      const area = document.getElementById(listId);
      area?.focus(); area?.select();
      setCopied("Press Ctrl+C to copy the selected list.");
    }
  }

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError("This file is larger than 5 MB. Choose a smaller CSV or TSV file."); return; }
    edited(await file.text());
    setFileName(file.name);
  }

  async function runPreview(options = {}) {
    const current = parseDetails(text);
    setParsed(current); setPreview(null); setResult(null); setError("");
    if (current.error) return;
    const items = requestItems(current.rows, { source: SOURCE });
    const settings = { markSwitch: options.markSwitch ?? markSwitch, overwrite: options.overwrite ?? overwrite };
    setBusy(true);
    try {
      const { data, revision } = await previewDetails(items, settings);
      if (mounted.current) setPreview({ data, revision, items, settings });
    } catch (e) { if (mounted.current) setError(failure(e)); }
    finally { if (mounted.current) setBusy(false); }
  }

  // An option change re-runs a shown preview, so the table always says what Apply would do.
  function option(setter, key) {
    return event => { const value = event.target.checked; setter(value); setResult(null); if (preview) runPreview({ [key]: value }); };
  }

  async function apply() {
    setBusy(true); setError("");
    try {
      const { data } = await applyDetails(preview.items, preview.settings, preview.revision);
      if (!mounted.current) return;
      setResult(data); setPreview(null);
      await refresh();
      onChanged?.();
    } catch (e) { if (mounted.current) setError(failure(e)); }
    finally { if (mounted.current) setBusy(false); }
  }

  const report = result || preview?.data;
  const changes = preview?.data.counts.updated || 0;

  return <section aria-labelledby={`${listId}-title`} className="rounded-2xl border border-zinc-800 p-5 space-y-4">
    <div className="flex flex-wrap justify-between gap-3 items-start">
      <div>
        <h2 id={`${listId}-title`} className="font-medium">Serial numbers · {items.length}</h2>
        <p className="text-xs text-zinc-400 mt-1">Every unit with a serial number or barcode{items.length ? `, switches first (${switches})` : ""}. Look each one up as <strong className="text-zinc-200">Switch</strong> in SN analysis, then import the product name and P/N it shows.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondary} onClick={exportCsv} disabled={!list}>Export serial numbers</button>
        <button type="button" className={secondary} onClick={copyList} disabled={!items.length}>Copy serial numbers</button>
      </div>
    </div>
    {listError && <p role="alert" className="text-sm text-rose-300">{listError}</p>}
    {copied && <p className="text-xs text-nv-400" aria-live="polite">{copied}</p>}
    <div className="grid lg:grid-cols-[240px_1fr] gap-4">
      <label className="block space-y-1.5"><span className="block text-xs text-zinc-400">One serial number per line</span>
        <textarea id={listId} aria-label="Serial number list" readOnly rows={8} value={serialsText(items)} className={`${input} font-mono text-xs`}/></label>
      <div className="min-w-0 max-h-56 overflow-auto rounded-lg border border-zinc-800">
        <table aria-label="Units with serial numbers" className="w-full text-xs">
          <thead className="text-zinc-400 bg-zinc-900 sticky top-0"><tr><th className="text-left p-2">Serial number</th><th className="text-left p-2">Name</th><th className="text-left p-2">Type</th><th className="text-left p-2">Part number</th><th className="text-left p-2">Place</th></tr></thead>
          <tbody>{items.map((item, n) => <tr key={`${item.serial}-${item.barcode}-${n}`} className="border-t border-zinc-800">
            <td className="p-2 font-mono whitespace-nowrap" dir="auto">{item.serial || <span className="text-zinc-500">{item.barcode} (barcode)</span>}</td>
            <td className="p-2 min-w-[8rem]" dir="auto">{item.name}</td><td className="p-2 whitespace-nowrap">{item.type}</td>
            <td className="p-2 font-mono whitespace-nowrap" dir="auto">{item.part_number}</td><td className="p-2 whitespace-nowrap">{item.place}</td></tr>)}</tbody>
        </table>
        {list && !items.length && <p className="p-3 text-sm text-zinc-500">No unit has a serial number or barcode yet.</p>}
      </div>
    </div>

    <div className="border-t border-zinc-800 pt-4 space-y-3">
      <h3 className="font-medium">Import details</h3>
      {!canOperate ? <p role="note" className="text-xs text-amber-300">{READ_ONLY}</p> : <>
        <p className="text-xs text-zinc-400">Choose a CSV or TSV file, or paste rows copied from Excel or a web table. The first row names the columns: SN / Serial Number, P/N / Part Number, Name / Description / Product, Model, Type. Units are matched by serial number (or barcode). A unit's name is replaced only when it is still a generic name, like its type or its serial number.</p>
        <div className="flex flex-wrap gap-3 items-center">
          <label className={`${secondary} cursor-pointer`}>Choose file<input type="file" aria-label="Details file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" className="sr-only" onChange={chooseFile} disabled={busy}/></label>
          {fileName && <span className="text-xs text-zinc-400">{fileName}</span>}
        </div>
        <textarea aria-label="Paste details" rows={6} value={text} disabled={busy} spellCheck={false} placeholder={"SN\tP/N\tDescription\nMT2614X00001\tMQM9700-NS2F\tQuantum-2 QM9700 switch"}
          onChange={e => { edited(e.target.value); setFileName(""); }} className={`${input} font-mono text-xs`}/>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-nv-400" checked={markSwitch} disabled={busy} onChange={option(setMarkSwitch, "markSwitch")}/>Mark units of type Other as switches (looked up as Switch; a PDU, cable or KVM keeps its type)</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-nv-400" checked={overwrite} disabled={busy} onChange={option(setOverwrite, "overwrite")}/>{OVERWRITE_LABEL}</label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondary} disabled={busy || !text.trim()} onClick={() => runPreview()}>{busy && !preview ? "Checking…" : "Preview changes"}</button>
          {preview && <button type="button" className={primary} disabled={busy || !changes} onClick={apply}>{busy ? "Applying…" : `Apply ${plural(changes, "change")}`}</button>}
        </div>
        {parsed && !parsed.error && <p className="text-xs text-zinc-400">Columns found: {Object.keys(parsed.columns).map(field => COLUMN_LABELS[field]).join(", ")} · {plural(parsed.rows.length, "row")} to check{parsed.problems.length ? ` · ${plural(parsed.problems.length, "row")} left out` : ""}.</p>}
        {parsed?.problems.length > 0 && <ul aria-label="Rows left out" className="text-xs text-amber-300 space-y-0.5">{parsed.problems.slice(0, 20).map(p => <li key={p.line}>Line {p.line}: {p.reason}</li>)}{parsed.problems.length > 20 && <li>…and {parsed.problems.length - 20} more</li>}</ul>}
        {(parsed?.error || error) && <div role="alert" className="rounded-xl border border-rose-800 bg-rose-950/30 text-rose-200 p-3 text-sm">{parsed?.error || error}</div>}
      </>}
      {report && <div className="space-y-2">
        <p role="status" className="text-sm text-nv-400">{result ? "Applied: " : "Preview: "}{summary(report.counts, Boolean(result))}.{!result && !changes ? " Nothing to apply." : ""}</p>
        <div className="max-h-96 overflow-auto rounded-lg border border-zinc-800">
          <table aria-label={result ? "Import result" : "Import preview"} className="w-full text-xs">
            <thead className="text-zinc-400 bg-zinc-900 sticky top-0"><tr><th className="text-left p-2">Serial number</th><th className="text-left p-2">Unit</th><th className="text-left p-2">Status</th><th className="text-left p-2">Changes</th></tr></thead>
            <tbody>{report.results.map((entry, n) => <tr key={`${entry.serial}-${n}`} className="border-t border-zinc-800 align-top">
              <td className="p-2 font-mono whitespace-nowrap" dir="auto">{entry.serial}</td>
              <td className="p-2 min-w-[8rem]" dir="auto">{entry.unit ? <>{entry.unit.name}<div className="text-zinc-500 whitespace-nowrap">{placeOf(entry.unit)}</div></> : entry.units ? entry.units.map(u => `${u.name} (${placeOf(u)})`).join("; ") : "—"}</td>
              <td className="p-2 whitespace-nowrap">{(result ? STATUS_DONE : STATUS_TEXT)[entry.status]}</td>
              <td className="p-2 min-w-[12rem]"><ChangeList entry={entry}/></td></tr>)}</tbody>
          </table>
        </div>
      </div>}
    </div>
  </section>;
}
