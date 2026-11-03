import { useEffect, useId, useRef, useState } from "react";
import useDialogFocus from "./useDialogFocus.js";
import { parseUnitBarcode } from "../../api/scanParse.js";
import { placeScannedUnit, undoScannedUnit, canUndo, filledFields, placeText, floorText } from "../../api/unitScan.js";
import { MAIN_STORAGE, UNIT_DETAILS } from "../../api/inventory.js";

// Add units to a server's floor (or a rack's floor) by scanning their barcodes: each scan looks the code up and, in
// one step, registers a new unit there or moves the unit that already has that barcode or serial (never a second
// row). A USB scanner types into the field and ends with Enter or Tab; the field keeps focus, and codes that arrive
// while one is saving wait in order. "Use camera" appears where the browser can read barcodes (BarcodeDetector over
// HTTPS or localhost). Each result is listed here with Undo, and also shown as the page's toast.
// target: { rack, u, position, label } (label: the server name, or "" for the rack itself); floorChoices: the floors
// to choose from when no server was chosen (null: the floor is fixed). Operator and up only (the caller checks).
// onItemsChanged(savedList | null): the equipment list changed (a saved list, or null to reload it).
// onToast(text, tone, onUndo): the page's one toast.

const CAMERA_FORMATS = ["code_128", "qr_code", "data_matrix", "ean_13", "code_39"];

export function cameraAvailable(win = typeof window === "undefined" ? null : window) {
  return !!win && "BarcodeDetector" in win && !!win.isSecureContext && !!win.navigator?.mediaDevices?.getUserMedia;
}

export function scanErrorText(error) {
  if (error?.status === 401) return "Your session ended. Sign in again, then scan the unit again.";
  if (error?.status === 403) return "Your account cannot add units. An Operator or Admin can.";
  if (error?.status === 413) return "This barcode is too long. Scan the serial number barcode on the unit instead.";
  if (error instanceof TypeError || !error?.message) return "The server did not answer. Check the connection, then scan the unit again.";
  return error.message;
}

// "serial number, model and MAC address": the fields a scan added to a known unit.
export function filledText(fields) {
  const names = UNIT_DETAILS.filter(([field]) => fields.includes(field)).map(([field, label]) => (field === "mac" ? label : label.toLowerCase()));
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function resultText(result, label) {
  const name = <bdi>{result.item.name}</bdi>;
  const here = <bdi>{placeText(result.after, label)}</bdi>;
  const filled = filledFields(result);
  const added = filled.length ? <> Added its {filledText(filled)}.</> : null;
  const notSaved = result.fillError ? <> Its scanned details were not saved: {result.fillError}</> : null;
  if (result.action === "created") return <>Added {name} to {here}.</>;
  if (result.action === "moved") return <>Moved {name} to {here} (it was in <bdi>{placeText(result.before)}</bdi>).{added}{notSaved}</>;
  return <>{name} is already on {here}.{added || notSaved ? <>{added}{notSaved}</> : " Nothing changed."}</>;
}

function undoneText(result) {
  const name = <bdi>{result.item.name}</bdi>;
  if (result.action === "created") return <>Undone: {name} was removed.</>;
  if (result.action === "confirmed") return <>Undone: the {filledText(filledFields(result))} added to {name} {filledFields(result).length > 1 ? "were" : "was"} removed.</>;
  return <>Undone: {name} is back in <bdi>{placeText(result.before)}</bdi>{filledFields(result).length ? <>, without the {filledText(filledFields(result))} the scan added</> : null}.</>;
}

function CameraScanner({ onCode, onStop }) {
  const videoRef = useRef(null);
  const [error, setError] = useState("");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  useEffect(() => {
    let stream = null, timer = null, stopped = false;
    const last = { value: "", at: 0 };
    (async () => {
      try {
        const supported = typeof window.BarcodeDetector.getSupportedFormats === "function" ? await window.BarcodeDetector.getSupportedFormats() : CAMERA_FORMATS;
        const formats = CAMERA_FORMATS.filter(f => supported.includes(f));
        if (!formats.length) throw Object.assign(new Error(), { name: "NoFormats" });
        const detector = new window.BarcodeDetector({ formats });
        const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        // Closed while the browser was still opening the camera: the cleanup below found no stream, so turn it off here.
        if (stopped) { opened.getTracks().forEach(t => t.stop()); return; }
        stream = opened;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play().catch(() => {});
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            const value = codes?.find(c => c?.rawValue)?.rawValue;
            // The same code stays in view for a while: it counts once until another code, or 3 s, has passed.
            if (value && !stopped && (value !== last.value || Date.now() - last.at > 3000)) {
              last.value = value; last.at = Date.now();
              onCodeRef.current(value);
            }
          } catch { /* a frame that cannot be read yet */ }
          if (!stopped) timer = setTimeout(tick, 150);
        };
        tick();
      } catch (e) {
        if (stopped) return;
        setError(e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "Camera access was blocked. Allow the camera for this site, or use a USB scanner."
          : e?.name === "NotFoundError" ? "No camera was found. Use a USB scanner or type the barcode."
          : e?.name === "NoFormats" ? "This browser cannot read these barcodes with the camera. Use a USB scanner or type the barcode."
          : "The camera could not start. Use a USB scanner or type the barcode.");
      }
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
  }, []);
  return <div className="scan-camera" data-scan-camera="">
    <video ref={videoRef} className="scan-camera-video" muted playsInline aria-label="Camera view: hold the unit's barcode in the frame"/>
    {error && <p role="alert" className="racks-dialog-error">{error}</p>}
    <button type="button" className="racks-btn racks-btn-sm" onClick={onStop}>Stop camera</button>
  </div>;
}

export default function ScanUnitDialog({ target, floorChoices = null, onClose, onItemsChanged, onToast }) {
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const titleId = useId();
  const hintId = useId();
  const [u, setU] = useState(target.u);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [log, setLog] = useState([]);
  const [camera, setCamera] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef([]);
  const mounted = useRef(true);
  const seq = useRef(0);
  const place = { rack: target.rack, u, position: target.position || "" };
  const placeRef = useRef(place);
  placeRef.current = place;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const withCamera = cameraAvailable();
  useDialogFocus(panelRef, { initialRef: inputRef, onEscape: () => { if (cameraRef.current) { setCamera(false); inputRef.current?.focus(); } else onClose(); } });
  useEffect(() => () => { mounted.current = false; }, []);

  const update = (key, change) => { if (mounted.current) setLog(list => list.map(e => (e.key === key ? { ...e, ...change } : e))); };

  async function undo(entry) {
    if (entry.state.undo !== "ready") return false;
    entry.state.undo = "busy"; update(entry.key, { undo: "busy" });
    try {
      const saved = await undoScannedUnit(entry.result);
      entry.state.undo = "done"; update(entry.key, { undo: "done" });
      onItemsChanged(saved);
      onToast(undoneText(entry.result), "ok");
      // Undo from the page's toast moves focus out of this dialog: the next scan must land in the field again.
      if (mounted.current) inputRef.current?.focus();
      return true;
    } catch (e) {
      entry.state.undo = "failed"; update(entry.key, { undo: "failed", error: scanErrorText(e) });
      onItemsChanged(e?.reloaded || null);
      onToast(scanErrorText(e), "error");
      if (mounted.current) inputRef.current?.focus();
      return false;
    }
  }

  async function processOne(code) {
    const key = ++seq.current;
    let parsed;
    try { parsed = parseUnitBarcode(code); }
    catch (e) { if (mounted.current) setLog(list => [{ key, code, error: e.message }, ...list]); return; }
    const at = { ...placeRef.current };
    try {
      const result = await placeScannedUnit(parsed, at);
      const entry = { key, code: parsed.code, result, label: target.label, undo: canUndo(result) ? "ready" : null };
      entry.state = { undo: entry.undo };
      if (mounted.current) setLog(list => [entry, ...list]);
      if (result.action !== "confirmed" || filledFields(result).length) onItemsChanged(null);
      onToast(resultText(result, target.label), "ok", entry.undo ? () => undo(entry) : null);
    } catch (e) {
      if (e?.status === 409 || e?.status === 404) onItemsChanged(null);
      if (mounted.current) setLog(list => [{ key, code: parsed.code, error: scanErrorText(e), matches: e?.matches || null }, ...list]);
    }
  }

  async function drain() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      while (pending.current.length) {
        const code = pending.current.shift();
        if (mounted.current) setQueued(pending.current.length);
        await processOne(code);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function enqueue(code) {
    pending.current.push(code);
    setQueued(pending.current.length);
    drain();
  }

  function submit(e) {
    e?.preventDefault();
    // The DOM value is what the scanner typed, even if React has not rendered its last keystroke yet.
    const input = inputRef.current;
    const code = input ? input.value : "";
    if (input) input.value = "";
    input?.focus();
    if (!code.trim()) { setLog(list => [{ key: ++seq.current, code: "", error: "Scan a barcode first." }, ...list]); return; }
    enqueue(code);
  }

  function onKey(e) {
    // A wedge scanner ends each code with Enter or Tab; both submit here, and focus stays in the field.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && e.currentTarget.value.trim())) submit(e);
  }

  const where = placeText(place, target.label);
  const latestError = log[0] && !log[0].result && log[0].error ? log[0] : null;
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} tabIndex={-1} className="racks-dialog racks-dialog-wide" data-dialog="scan-unit">
      <header className="server-details-header">
        <h2 id={titleId} className="racks-dialog-title">Scan unit barcode</h2>
        <span className="server-details-tools"><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>×</button></span>
      </header>
      <p id={hintId} className="racks-dialog-note">Units go to <strong><bdi>{where}</bdi></strong>{target.label && target.rack !== MAIN_STORAGE ? <> in <bdi>{target.rack}</bdi></> : null}. Scan each unit's serial number barcode; a new unit is added and saved right away, a unit that is already in DCIM is moved here. Scan as many units as you need.</p>
      {floorChoices && target.rack !== MAIN_STORAGE && <div className="racks-field">
        <label htmlFor={`${titleId}-floor`}>Floor in <bdi>{target.rack}</bdi></label>
        <select id={`${titleId}-floor`} value={u} onChange={e => { setU(Number(e.target.value)); inputRef.current?.focus(); }}>
          {floorChoices.map(n => <option key={n} value={n}>{n === 0 ? "Rack level (no floor)" : floorText(n).replace(/^f/, "F")}</option>)}
        </select>
      </div>}
      <form className="racks-field" onSubmit={submit}>
        <label htmlFor={`${titleId}-code`}>Unit barcode</label>
        <div className="scan-unit-row">
          <input ref={inputRef} id={`${titleId}-code`} name="unit-barcode" autoComplete="off" spellCheck={false} maxLength={4000}
            placeholder="Scan with the USB scanner, or type and press Enter" onKeyDown={onKey}
            aria-invalid={latestError ? true : undefined} aria-describedby={latestError ? `${titleId}-error` : undefined}/>
          <button type="submit" className="racks-btn racks-btn-primary">Add</button>
        </div>
        <span className="racks-field-hint" aria-live="polite">{busy ? `Saving…${queued > 0 ? ` ${queued} more ${queued === 1 ? "scan" : "scans"} waiting.` : ""}` : "Ready for the next scan."}</span>
      </form>
      {withCamera ? (camera
        ? <CameraScanner onCode={value => enqueue(value)} onStop={() => { setCamera(false); inputRef.current?.focus(); }}/>
        : <div className="scan-unit-camera"><button type="button" className="racks-btn racks-btn-sm" onClick={() => setCamera(true)}>Use camera</button></div>)
        : <p className="racks-field-hint">Camera scanning is not available in this browser or over plain HTTP. Use a USB barcode scanner, or type the code.</p>}
      {latestError && <p id={`${titleId}-error`} role="alert" className="racks-dialog-error">{latestError.error}</p>}
      {log.length > 0 && <ol className="scan-unit-log" aria-label="Scanned units">
        {log.map(entry => <li key={entry.key} data-action={entry.result?.action || "error"} data-undo={entry.undo || undefined}>
          {entry.result ? <span className="scan-unit-text">{resultText(entry.result, entry.label)}</span>
            : <span className="scan-unit-text scan-unit-error">{entry.code ? <><bdi className="racks-mono">{entry.code}</bdi>: </> : null}{entry.error}</span>}
          {entry.matches && <ul className="scan-unit-matches">{entry.matches.map(m => <li key={m.id}><bdi>{m.name}</bdi> · <bdi>{placeText({ rack: m.rack, u: m.u })}</bdi> · <span className="racks-mono">{m.id}</span></li>)}</ul>}
          {entry.undo === "ready" && <button type="button" className="racks-btn racks-btn-sm" onClick={() => { inputRef.current?.focus(); undo(entry); }}>Undo</button>}
          {entry.undo === "busy" && <span className="racks-muted">Undoing…</span>}
          {entry.undo === "done" && <span className="racks-muted">Undone</span>}
          {entry.undo === "failed" && <span className="scan-unit-error">{entry.error}</span>}
        </li>)}
      </ol>}
      <div className="racks-dialog-actions"><button type="button" className="racks-btn" onClick={onClose}>Done</button></div>
    </section>
  </div>;
}
