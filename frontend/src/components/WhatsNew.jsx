import { useEffect, useRef, useState } from "react";
import { releaseNotesSince, SEEN_VERSION_KEY } from "../api/changelog";

function readSeen() {
  try { return localStorage.getItem(SEEN_VERSION_KEY); } catch { return null; }
}

function markSeen(version) {
  try { localStorage.setItem(SEEN_VERSION_KEY, version); } catch { /* private mode: shown again next time */ }
}

function plain(text) {
  return text.replace(/\*\*/g, "").replace(/`/g, "");
}

function SectionBody({ body }) {
  const blocks = [];
  let items = null;
  body.split("\n").forEach((line, i) => {
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    if (bullet) { if (!items) { items = []; blocks.push(<ul key={i} className="list-disc pl-5 space-y-1">{items}</ul>); } items.push(<li key={i}>{plain(bullet[1])}</li>); return; }
    if (/^\s{2,}\S/.test(line) && items?.length) { const last = items.length - 1; items[last] = <li key={items[last].key}>{items[last].props.children} {plain(line.trim())}</li>; return; }
    items = null;
    if (!line.trim()) return;
    const sub = /^###\s+(.*)$/.exec(line);
    blocks.push(sub ? <h4 key={i} className="text-xs uppercase tracking-wider text-zinc-500 mt-3">{plain(sub[1])}</h4> : <p key={i}>{plain(line)}</p>);
  });
  return <div className="space-y-2 text-sm text-zinc-300">{blocks}</div>;
}

export default function WhatsNew({ version, onOpenChangelog }) {
  const [notes, setNotes] = useState(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!version || version === "unknown") return;
    const seen = readSeen();
    if (seen === version) return;
    let cancelled = false;
    fetch("/api/changelog", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(data => {
      if (cancelled || !data) return;
      const found = releaseNotesSince(data.changelog, seen, version);
      if (found.length) setNotes(found); else markSeen(version);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [version]);

  useEffect(() => { if (notes) closeRef.current?.focus(); }, [notes]);

  if (!notes) return null;
  const close = () => { markSeen(version); setNotes(null); };
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onKeyDown={e => { if (e.key === "Escape") close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="whats-new-heading" className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h2 id="whats-new-heading" className="text-lg font-semibold text-white">What's new in {version}</h2>
          <p className="text-xs text-zinc-500 mt-1">Lab Manager was updated. These are the changes since you last opened it.</p>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-5" dir="auto">
          {notes.map(section => (
            <section key={section.title}>
              <h3 className="text-sm font-semibold text-nv-300 mb-2">{plain(section.title)}</h3>
              <SectionBody body={section.body} />
            </section>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 rounded-md border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800" onClick={() => { close(); onOpenChangelog?.(); }}>Full changelog</button>
          <button type="button" ref={closeRef} className="px-3 py-1.5 rounded-md bg-nv-400 text-zinc-950 text-sm font-semibold hover:bg-nv-300" onClick={close}>Got it</button>
        </div>
      </div>
    </div>
  );
}
