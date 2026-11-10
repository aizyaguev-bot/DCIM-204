import { useEffect, useRef, useState } from "react";

export default function AddDeviceModal({ onClose, onAdd, racks = [] }) {
  const panelRef = useRef(null);
  const nameRef = useRef(null);
  const submitRef = useRef(null);
  // Synchronous guard: a double click fires twice before React re-renders the disabled button.
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const [saving, setSaving] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // On the document so Escape and the Tab trap still work after a click on plain text.
  useEffect(() => {
    const opener = document.activeElement;
    nameRef.current?.focus();
    const onKey = e => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll("button, input, select, textarea, [href], [tabindex]:not([tabindex='-1'])")].filter(el => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!panelRef.current.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const [kind, setKind] = useState("pdu");
  const [form, setForm] = useState({
    name: "", ip: "", rack: racks[0] || "",
    model: "Raritan PDU", username: "ftlab", password: "",
    port_count: 16,
  });
  const upd = k => e => setForm({ ...form, [k]: e.target.value });
  // If the lab's rack list changes while the dialog is open, keep the chosen rack listed so the select shows what will be sent.
  const rackOptions = form.rack && !racks.includes(form.rack) ? [...racks, form.rack] : racks;
  const inp = "w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-nv-400/60";

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // A failed add keeps the dialog open; the disabled button dropped focus, so bring it back.
  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current && !saving && panelRef.current && !panelRef.current.contains(document.activeElement)) submitRef.current?.focus();
    wasSaving.current = saving;
  }, [saving]);

  const submit = async () => {
    if (savingRef.current) return;
    const name = form.name.trim();
    if (!name || !form.ip) { alert("Name and IP are required."); return; }
    savingRef.current = true;
    setSaving(true);
    try {
      await onAdd({ kind, ...form, name, port_count: Number(form.port_count) });
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="add-device-title" onClick={e => e.stopPropagation()} className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <div id="add-device-title" className="font-medium">Add device</div>
          <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-100 w-7 h-7 rounded hover:bg-zinc-800">✕</button>
        </div>
        <div className="p-5">
          <div className="flex gap-1 mb-4 p-1 bg-zinc-900 rounded-md">
            {["pdu", "kvm"].map(k => (
              <button key={k} onClick={() => { setKind(k); setForm(f => ({ ...f, model: k === "pdu" ? "Raritan PDU" : "Raritan Dominion KX III", username: k === "pdu" ? "ftlab" : "admin" })); }}
                className={`flex-1 text-sm py-1.5 rounded ${kind === k ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>
                {k === "pdu" ? "PDU" : "KVM"}
              </button>
            ))}
          </div>
          {[["Display name", "name", "text", "PDU-Rack-C2"], ["IP address", "ip", "text", "10.7.30.x"]].map(([label, key, type, ph]) => (
            <label key={key} className="block mb-3">
              <div className="text-xs text-zinc-400 mb-1">{label}</div>
              <input ref={key === "name" ? nameRef : undefined} type={type} className={inp} value={form[key]} onChange={upd(key)} placeholder={ph} />
            </label>
          ))}
          <label className="block mb-3">
            <div className="text-xs text-zinc-400 mb-1">Model</div>
            <select className={inp} value={form.model} onChange={upd("model")}>
              {kind === "pdu"
                ? ["Raritan PDU", "Raritan PX4-5874", "Raritan PX4-5848"].map(m => <option key={m}>{m}</option>)
                : ["Raritan Dominion KX III", "Raritan Dominion LX II"].map(m => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label className="block mb-3">
            <div className="text-xs text-zinc-400 mb-1">Rack</div>
            <select className={inp} value={form.rack} onChange={upd("rack")}>
              <option value="">No rack</option>
              {rackOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          {kind === "kvm" && (
            <label className="block mb-3">
              <div className="text-xs text-zinc-400 mb-1">Port count</div>
              <select className={inp} value={form.port_count} onChange={upd("port_count")}>
                {[8, 16, 32].map(n => <option key={n} value={n}>{n} ports</option>)}
              </select>
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            {[["Username", "username"], ["Password", "password"]].map(([label, key]) => (
              <label key={key} className="block">
                <div className="text-xs text-zinc-400 mb-1">{label}</div>
                <input type={key === "password" ? "password" : "text"} className={inp} value={form[key]} onChange={upd(key)} />
              </label>
            ))}
          </div>
          <div className="text-[11px] text-zinc-500 mt-2">Credentials are encrypted before storage.</div>
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded hover:bg-zinc-800 text-zinc-300">Cancel</button>
          <button ref={submitRef} onClick={submit} disabled={saving} aria-busy={saving}
            className="text-sm px-3.5 py-1.5 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium disabled:opacity-60 disabled:cursor-wait disabled:hover:bg-nv-400">
            {saving ? "Adding…" : "Add device"}
          </button>
        </div>
      </div>
    </div>
  );
}
