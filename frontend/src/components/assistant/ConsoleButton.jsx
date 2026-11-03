import { useId, useState } from "react";
import { parseConsoleUrl } from "../../api/pxe.js";
import { AFTER_CYCLE_NOTE, CONSOLE_NOTES } from "../../api/assistantActions.js";

// "פתח KVM" for one console entry ({kvm_id, kvm_name, port, label, console_url}) of a proposal or a finished run.
// onOpenConsole(entry) is called synchronously inside the click handler (never after an await, so the browser
// allows the popup) and returns "popup" | "inline" | "denied" | "invalid"; it re-checks that the URL is an
// autologin URL of a KVM the site knows. A URL that does not even parse renders no button (SEC-ACT-18).
// Raw URLs are never rendered as links. Focus never moves here on its own.
export default function ConsoleButton({ entry, onOpenConsole, canOperate = true, afterCycle = false, primary = false }) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const parsed = parseConsoleUrl(entry?.console_url);
  const name = entry?.kvm_name || entry?.kvm_id || "KVM";
  const port = Number.isInteger(entry?.port) ? entry.port : parsed?.port;

  if (!canOperate) return <p className="text-xs text-zinc-400">דרושה הרשאת Operator לפתיחת KVM.</p>;
  if (!parsed || !onOpenConsole) return <p role="note" className="text-xs text-amber-200">{CONSOLE_NOTES.invalid}</p>;

  function open() {
    let outcome;
    try { outcome = onOpenConsole(entry); } catch { outcome = "invalid"; }
    const text = CONSOLE_NOTES[outcome] || CONSOLE_NOTES.popup;
    setNote(afterCycle && (outcome === "popup" || outcome === "inline" || outcome === undefined) ? `${text} ${AFTER_CYCLE_NOTE}` : text);
  }

  return (
    <div className="space-y-1">
      <button type="button" onClick={open} aria-describedby={note ? noteId : undefined}
        className={`min-h-10 rounded border px-3 py-1.5 text-start text-xs font-semibold ${primary
          ? "border-nv-400 bg-nv-400 text-zinc-950 hover:bg-nv-300"
          : "border-nv-400/70 bg-zinc-900 text-nv-300 hover:border-nv-400 hover:bg-zinc-800"}`}>
        פתח KVM
        <span className={`block text-[11px] font-normal ${primary ? "text-zinc-900" : "text-zinc-300"}`}>
          <bdi className="font-mono">{name}</bdi> · פורט {port}
          {entry?.label ? <> · <bdi className="font-mono">{entry.label}</bdi></> : null}
        </span>
      </button>
      <p id={noteId} role="status" className="text-xs text-zinc-300">{note}</p>
    </div>
  );
}
