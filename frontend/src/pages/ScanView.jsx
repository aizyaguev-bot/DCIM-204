import { cloneElement, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import JsBarcode from "jsbarcode";
import { loadInventory, updateInventory, locationCode, parseLocationCode, rackCode, mainStorageCode, MAIN_STORAGE } from "../api/inventory";

const input = "w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-nv-400 disabled:opacity-50";
const primary = "rounded-lg px-4 py-2.5 text-sm font-semibold bg-nv-400 text-zinc-950 hover:bg-nv-300 disabled:opacity-40";
const secondary = "rounded-lg px-4 py-2.5 text-sm border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40";
const types = ["switch", "computer", "patchpanel", "cable", "pdu", "kvm", "ups", "other"];
const emptyLocation = { rack: "", u: 1, position: "" };
const place = item => ({ rack: item.rack, u: item.u ?? 0, position: item.shelf_position || "" });
function where(p) { return p ? p.rack === MAIN_STORAGE ? "Main storage · whole unit" : `${p.rack} · ${p.u ? `Shelf ${String(p.u).padStart(2, "0")}` : "Whole rack / no shelf"}${p.position ? ` · ${p.position}` : ""}` : "Not registered"; }
function when(value) { return value ? new Date(value).toLocaleString() : "Not confirmed by scan yet"; }

function Field({ label, children }) {
  const id = useId();
  return <div className="space-y-1.5"><label htmlFor={id} className="block text-xs text-zinc-400">{label}</label>{cloneElement(children, { id })}</div>;
}

function LocationFields({ value, onChange, racks, disabled }) {
  const storage = value.rack === MAIN_STORAGE;
  return <div className="grid gap-3 sm:grid-cols-[1fr_110px_1fr]">
    <Field label="Rack / storage"><select aria-label="Destination rack" className={input} disabled={disabled} value={value.rack} onChange={e => onChange({ rack: e.target.value, u: 0, position: "" })}>
      <option value="">Choose location…</option>{racks.map(r => <option key={r} value={r}>{r === MAIN_STORAGE ? "Main storage" : r}</option>)}
    </select></Field>
    <Field label={storage ? "Whole unit" : "Shelf / U (0 = whole rack)"}><input aria-label="Destination shelf" className={input} disabled={disabled || storage} type="number" min="0" max="42" value={value.u} onChange={e => onChange({ ...value, u: e.target.value === "" ? "" : Number(e.target.value) })}/></Field>
    <Field label="Position on shelf"><input aria-label="Position on shelf" className={input} disabled={disabled || storage} maxLength={80} value={value.position} placeholder="e.g. left / front / slot A" onChange={e => onChange({ ...value, position: e.target.value })}/></Field>
  </div>;
}

function BarcodeSvg({ value }) {
  const ref = useRef(null);
  useEffect(() => { JsBarcode(ref.current, value, { format: "CODE128", width: 1.5, height: 58, margin: 12, fontSize: 11 }); }, [value]);
  return <svg ref={ref} role="img" aria-label={`Barcode ${value}`} className="max-w-full h-auto"/>;
}

function ShelfLabels({ racks, onClose }) {
  const physicalRacks = racks.filter(r => r !== MAIN_STORAGE);
  const [rack, setRack] = useState(physicalRacks[0] || "");
  const [kind, setKind] = useState("shelf");
  const [first, setFirst] = useState(1);
  const [last, setLast] = useState(4);
  const [position, setPosition] = useState("");
  const valid = kind === "storage" || rack && (kind === "rack" || Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last <= 42 && last >= first);
  const labels = !valid ? [] : kind === "storage" ? [{ rack: MAIN_STORAGE, u: 0, position: "" }] : kind === "rack" ? [{ rack, u: 0, position: "" }] : Array.from({ length: last - first + 1 }, (_, i) => ({ rack, u: first + i, position: position.trim() }));
  const cards = labels.map(label => <div key={label.u} className="scan-label-card bg-white text-black rounded-lg p-4">
    <strong>{where(label)}</strong><BarcodeSvg value={label.rack === MAIN_STORAGE ? mainStorageCode : label.u === 0 ? rackCode(label.rack) : locationCode(label.rack, label.u, label.position)}/><small>{kind === "shelf" ? "Shelf 01 is the top shelf" : "Whole location - no shelf assigned"} · Lab Manager</small>
  </div>);
  return <>
    <div role="dialog" aria-modal="true" aria-label="Location labels" className="fixed inset-0 z-50 bg-black/80 p-4 flex items-center justify-center" onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 max-w-3xl w-full max-h-[90vh] overflow-auto space-y-4">
        <div className="flex justify-between gap-4 items-center"><h2 className="text-lg font-semibold">Print location labels</h2><button className={secondary} onClick={onClose}>Close</button></div>
        <p className="text-sm text-zinc-400">Scan equipment first, then its destination label. Rack labels select the whole rack; main storage has one label for the entire unit. Save to confirm the move.</p>
        <Field label="Label type"><select className={input} value={kind} onChange={e => setKind(e.target.value)}><option value="shelf">Shelf</option><option value="rack">Whole rack</option><option value="storage">Main storage (one label)</option></select></Field>
        <div className="grid sm:grid-cols-4 gap-3">
          <Field label="Rack"><select className={input} disabled={kind === "storage"} value={rack} onChange={e => setRack(e.target.value)}>{physicalRacks.map(r => <option key={r}>{r}</option>)}</select></Field>
          <Field label="First shelf"><input className={input} disabled={kind !== "shelf"} type="number" min="1" max="42" value={first} onChange={e => setFirst(Number(e.target.value))}/></Field>
          <Field label="Last shelf"><input className={input} disabled={kind !== "shelf"} type="number" min="1" max="42" value={last} onChange={e => setLast(Number(e.target.value))}/></Field>
          <Field label="Position (optional)"><input className={input} disabled={kind !== "shelf"} value={position} maxLength={80} onChange={e => setPosition(e.target.value)}/></Field>
        </div>
        <button className={primary} disabled={!valid} onClick={() => window.print()}>Print labels</button>
        <div className="grid sm:grid-cols-2 gap-3">{cards}</div>
      </div>
    </div>
    {createPortal(<div className="scan-label-print"><style>{`
      .scan-label-print { display: none; }
      @media print {
        @page { size: A4; margin: 10mm; }
        html, body { height: auto !important; background: white !important; color: black !important; }
        body > * { display: none !important; }
        body > .scan-label-print { display: grid !important; grid-template-columns: repeat(2, 1fr); gap: 5mm; color: black; background: white; }
        .scan-label-card { break-inside: avoid; border: 1px solid #bbb; padding: 3mm; font: 12pt sans-serif; }
        .scan-label-card svg { max-width: 100%; height: auto; }
      }
    `}</style>{cards}</div>, document.body)}
  </>;
}

export default function ScanView() {
  const [snapshot, setSnapshot] = useState(null);
  const [selected, setSelected] = useState(null);
  const [editRevision, setEditRevision] = useState(null);
  const [destination, setDestination] = useState(emptyLocation);
  const [scan, setScan] = useState("");
  const [unknown, setUnknown] = useState("");
  const [matches, setMatches] = useState([]);
  const [linkId, setLinkId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("switch");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const inputRef = useRef(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const items = snapshot?.data.items || [];
  const racks = snapshot?.data.racks || [];

  useEffect(() => {
    mounted.current = true;
    loadInventory().then(data => { if (mounted.current) setSnapshot(data); })
      .catch(e => { if (mounted.current) setError(e.message); })
      .finally(() => { if (mounted.current) setBusy(false); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { if (!busy && !labelsOpen) inputRef.current?.focus(); }, [busy, labelsOpen]);

  function choose(item, revision = snapshot?.revision) {
    setSelected(item); setEditRevision(revision); setDestination(place(item));
    setUnknown(""); setMatches([]); setLinkId(""); setError("");
  }

  async function run(action) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (e) { if (mounted.current) setError(e.message); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }

  async function scanCode(event) {
    event?.preventDefault();
    const code = scan.trim();
    if (!code || inFlight.current) return;
    await run(async () => {
      const location = parseLocationCode(code);
      if (location) {
        if (!selected && !unknown) throw new Error("Scan an equipment barcode before scanning a location label.");
        if (!racks.includes(location.rack)) throw new Error("This rack is not in the inventory. Add it in DCIM first.");
        setDestination(location); setScan(""); setMessage("Destination selected. Review it below, then save to confirm.");
        return;
      }
      const result = await loadInventory(code);
      if (!mounted.current) return;
      setSnapshot(result); setSelected(null); setUnknown(""); setMatches([]); setLinkId(""); setName(""); setScan("");
      setEditRevision(result.revision);
      if (result.data.matches.length === 1) {
        choose(result.data.matches[0], result.revision);
        setMessage("Equipment found. Scan its shelf label or choose a destination below.");
      } else if (result.data.matches.length > 1) {
        setMatches(result.data.matches);
        setError("This code matches multiple items. Select the correct item by ID and location; nothing has been changed.");
      } else {
        setUnknown(code); setDestination({ ...emptyLocation, rack: result.data.racks[0] || "" });
        setMessage("New barcode. Link it to existing equipment, or register a new item.");
      }
    });
  }

  function acceptSaved(result) {
    setSnapshot(old => ({ revision: result.revision, data: { ...old.data, items: [...old.data.items.filter(i => i.id !== result.data.id), result.data] } }));
    choose(result.data, result.revision);
  }

  async function saveLocation(event) {
    event.preventDefault();
    await run(async () => {
      const result = await updateInventory(`/${encodeURIComponent(selected.id)}/location`, destination, editRevision);
      if (!mounted.current) return;
      acceptSaved(result); setMessage(`Saved: ${result.data.name} → ${where(destination)}`);
    });
  }

  async function reload() {
    await run(async () => {
      const result = await loadInventory();
      if (!mounted.current) return;
      setSnapshot(result); setEditRevision(result.revision);
      const current = selected && result.data.items.find(i => i.id === selected.id);
      if (current) choose(current, result.revision);
      else setSelected(null);
      setMessage("Inventory refreshed. Review the current location before saving.");
    });
  }

  const locationValid = destination.rack && Number.isInteger(destination.u) && destination.u >= 0 && destination.u <= 42 && (destination.rack !== MAIN_STORAGE || destination.u === 0 && !destination.position);
  const neighbors = items.filter(i => i.id !== selected?.id && i.rack === destination.rack && i.u === destination.u);
  const visible = items.filter(i => [i.name, i.barcode, i.serial_number, i.rack, i.shelf_position].some(v => String(v || "").toLowerCase().includes(filter.toLowerCase())));

  return <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6 space-y-5">
    <div className="flex flex-wrap justify-between items-start gap-3">
      <div><h1 className="text-2xl font-semibold">Scan & Track</h1><p className="text-sm text-zinc-400 mt-1">Equipment → rack → exact shelf position. Every saved move stays with the item.</p></div>
      <div className="flex gap-2"><button className={secondary} disabled={busy} onClick={reload}>Refresh</button><button className={secondary} disabled={!racks.length || busy} onClick={() => setLabelsOpen(true)}>Location labels</button></div>
    </div>
    <section className="bg-zinc-900/60 rounded-2xl border border-zinc-800 p-5 space-y-3">
      <form onSubmit={scanCode} className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[220px]"><Field label="Scan equipment or a location label"><input ref={inputRef} aria-label="Scan barcode" value={scan} onChange={e => setScan(e.target.value)} onKeyDown={e => { if (e.key === "Tab" && scan.trim()) scanCode(e); }} disabled={busy || labelsOpen} autoComplete="off" spellCheck={false} maxLength={600} placeholder="Click here, then scan…" className={`${input} text-lg font-mono py-3`}/></Field></div>
        <button type="submit" className={primary} disabled={busy || !scan.trim()}>{busy ? "Please wait…" : "Find barcode"}</button>
        <button type="button" className={secondary} onClick={() => inputRef.current?.focus()} disabled={busy}>Focus scanner</button>
      </form>
      <p className="text-xs text-zinc-400">USB / Bluetooth keyboard scanner: use English keyboard mode and an Enter or Tab suffix. Shelf 01 is the top shelf. Scanning alone does not change a location.</p>
    </section>
    {error && <div role="alert" className="rounded-xl border border-rose-800 bg-rose-950/30 text-rose-200 p-4">{error}</div>}
    {message && <div role="status" aria-live="polite" className="rounded-xl border border-nv-400/30 bg-nv-400/5 text-nv-400 p-4">{message}</div>}
    {!!matches.length && <div className="space-y-2">{matches.map(item => <button key={item.id} className={`${secondary} block w-full text-left`} onClick={() => choose(item)}>{item.name} · {where({ ...place(item), u: item.u })} · {item.id}</button>)}</div>}
    {selected && <div className="grid lg:grid-cols-[1.3fr_1fr] gap-5">
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-5">
        <div><div className="text-xs uppercase text-zinc-500 mb-1">Selected equipment</div><h2 className="text-xl font-semibold">{selected.name}</h2><div className="text-xs text-zinc-500 font-mono break-all mt-1">ID: {selected.id}</div></div>
        <div className="grid sm:grid-cols-2 gap-3 text-sm"><div><span className="text-zinc-500">Barcode</span><div className="font-mono break-all">{selected.barcode || "Not linked"}</div></div><div><span className="text-zinc-500">Serial number</span><div className="font-mono break-all">{selected.serial_number || "Not recorded"}</div></div></div>
        <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-4"><div className="text-xs text-zinc-400">Current saved location</div><div className="text-lg font-medium mt-1">{where({ ...place(selected), u: selected.u })}</div><div className="text-xs text-zinc-500 mt-2">Last confirmed: {when(selected.last_seen_at)}</div></div>
        <form onSubmit={saveLocation} className="space-y-4"><h3 className="font-medium">Confirm or move equipment</h3><LocationFields value={destination} onChange={setDestination} racks={racks} disabled={busy}/>
          {!!neighbors.length && <p className="text-xs text-amber-300">Also on this shelf: {neighbors.map(i => `${i.name}${i.shelf_position ? ` (${i.shelf_position})` : ""}`).join(", ")}. Check that the destination has space.</p>}
          <p className="text-sm text-zinc-400">Save to confirm <strong className="text-zinc-200">{selected.name}</strong> is at <strong className="text-zinc-200">{where(destination)}</strong>.</p>
          <button className={primary} type="submit" disabled={busy || !locationValid}>Save and confirm location</button>
        </form>
      </section>
      <section className="rounded-2xl border border-zinc-800 p-5"><h2 className="font-medium mb-1">Tracking history</h2><p className="text-xs text-zinc-500 mb-4">Latest {snapshot?.data.history_limit || 100} recorded actions. Scan confirmations and moves from DCIM or 3D Twin.</p>
        <div className="max-h-[430px] overflow-auto space-y-3">{[...(selected.tracking_history || [])].reverse().map((event, n) => <div key={`${event.at}-${n}`} className="border-l-2 border-nv-400/40 pl-3 py-1 text-sm"><div className="capitalize text-zinc-200">{event.action}</div><div className="text-xs text-zinc-500">{when(event.at)}</div><div className="text-zinc-400 mt-1">{event.action === "moved" && <>{where(event.from)} → </>}{where(event.to)}</div>{event.note && <div className="text-xs text-zinc-500">{event.note}</div>}</div>)}
          {!selected.tracking_history?.length && <p className="text-sm text-zinc-500">No scan history yet. Confirm this equipment at its shelf to start tracking.</p>}
        </div>
      </section>
    </div>}
    {unknown && <section className="rounded-2xl border border-zinc-800 p-5 space-y-5">
      <h2 className="text-lg font-medium">Unknown barcode: <span className="font-mono break-all">{unknown}</span></h2>
      <div className="grid lg:grid-cols-2 gap-6">
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); run(async () => { const result = await updateInventory(`/${encodeURIComponent(linkId)}/barcode`, { code: unknown }, editRevision); if (mounted.current) { acceptSaved(result); setMessage("Barcode linked to existing equipment. Its serial number and location were kept."); } }); }}>
          <h3 className="font-medium">Link to existing equipment</h3><p className="text-xs text-zinc-400">Choose the existing rack item to keep one equipment record.</p>
          <select aria-label="Existing equipment" className={input} disabled={busy} value={linkId} onChange={e => setLinkId(e.target.value)}><option value="">Choose equipment…</option>{items.filter(i => !i.barcode).map(i => <option key={i.id} value={i.id}>{i.name} · {i.rack} / {i.u || "?"} · {i.id}</option>)}</select>
          <button className={secondary} disabled={busy || !linkId}>Link barcode</button>
        </form>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); run(async () => { const result = await updateInventory("", { code: unknown, name: name.trim(), type, ...destination }, editRevision); if (mounted.current) { acceptSaved(result); setMessage("Equipment registered and its location saved in DCIM."); } }); }}>
          <h3 className="font-medium">Register new equipment</h3><div className="grid grid-cols-2 gap-3"><Field label="Equipment name"><input required maxLength={160} className={input} disabled={busy} value={name} onChange={e => setName(e.target.value)}/></Field><Field label="Type"><select className={input} value={type} disabled={busy} onChange={e => setType(e.target.value)}>{types.map(t => <option key={t}>{t}</option>)}</select></Field></div>
          <LocationFields value={destination} onChange={setDestination} racks={racks} disabled={busy}/>
          {!racks.length && <p className="text-xs text-amber-300">Add a rack in DCIM before registering equipment.</p>}
          <button className={primary} disabled={busy || !name.trim() || !locationValid}>Register equipment</button>
        </form>
      </div>
    </section>}
    <section className="rounded-2xl border border-zinc-800 p-5 space-y-3">
      <div className="flex flex-wrap justify-between gap-3 items-center"><h2 className="font-medium">Rack equipment · {items.length}</h2><input aria-label="Filter equipment" className={`${input} sm:max-w-sm`} value={filter} onChange={e => setFilter(e.target.value)} placeholder="Name, barcode, serial, rack, position…"/></div>
      <p className="text-xs text-zinc-500">Choose an existing rack item or scan its serial number. Manage PDU outlet / OPT connections in DCIM.</p>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-2 max-h-80 overflow-auto">{visible.map(item => <button key={item.id} disabled={busy} onClick={() => { choose(item); setMessage(""); }} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-left hover:border-nv-400/50 disabled:opacity-50"><div className="text-sm font-medium">{item.name}</div><div className="text-xs text-zinc-400 mt-1">{where({ ...place(item), u: item.u })}</div><div className="font-mono text-xs text-zinc-500 break-all mt-1">{item.barcode || item.serial_number || "No barcode linked"}</div></button>)}</div>
      {!busy && !visible.length && <p className="text-sm text-zinc-500">No matching rack equipment. Scan a barcode to register or link an item.</p>}
    </section>
    {labelsOpen && <ShelfLabels racks={racks} onClose={() => setLabelsOpen(false)}/>}
  </main>;
}
