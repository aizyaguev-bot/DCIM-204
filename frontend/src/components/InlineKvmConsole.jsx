import { useEffect } from "react";

export default function InlineKvmConsole({ console, onClose }) {
  useEffect(() => {
    const close = event => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return <div role="dialog" aria-modal="true" aria-label="KVM console"
    className="fixed inset-0 z-50 bg-zinc-950 flex flex-col">
    <div className="flex items-center justify-between gap-4 p-3 border-b border-zinc-800">
      <div><strong>{console.name} · Port {console.port}</strong>
        <p dir="rtl" className="text-xs text-zinc-400 mt-1">הדפדפן לא פתח לשונית חדשה. הקונסול נפתח כאן בתוך האתר.</p>
      </div>
      <button onClick={onClose} className="border border-zinc-700 rounded px-3 py-2" aria-label="Close KVM console">סגירה ✕</button>
    </div>
    <iframe title="KVM console viewer" src={console.url} allowFullScreen referrerPolicy="no-referrer"
      className="flex-1 w-full border-0 bg-black" />
  </div>;
}
