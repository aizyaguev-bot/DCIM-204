import { useState } from "react";

export default function AddDeviceModal({ onClose, onAdd, racks }) {
  const [kind, setKind] = useState("pdu");
  const [form, setForm] = useState({
    name: "", ip: "", rack: racks[0] || "",
    model: "Raritan PDU", username: "ftlab", password: "",
    port_count: 16,
  });
  const upd = k => e => setForm({ ...form, [k]: e.target.value });
  const inp = "w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-nv-400/60";

  const submit = () => {
    if (!form.name || !form.ip) { alert("Name and IP are required."); return; }
    onAdd({ kind, ...form, port_count: Number(form.port_count) });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <div className="font-medium">Add device</div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 w-7 h-7 rounded hover:bg-zinc-800">✕</button>
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
              <input type={type} className={inp} value={form[key]} onChange={upd(key)} placeholder={ph} />
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
              {racks.map(r => <option key={r}>{r}</option>)}
              <option>Rack-07</option><option>Rack-08</option>
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
          <button onClick={submit} className="text-sm px-3.5 py-1.5 rounded bg-nv-400 hover:bg-nv-300 text-zinc-950 font-medium">Add device</button>
        </div>
      </div>
    </div>
  );
}
