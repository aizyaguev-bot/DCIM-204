import { useEffect, useId, useRef, useState } from "react";
import {
  DICTATION_LANG, DICTATION_PRIVACY_NOTE, NO_HEBREW_VOICE, dictationErrorText, pickHebrewVoice, readAloudErrorText,
  readRecognitionEvent, recognitionConstructor, speechSupport, splitForSpeech,
} from "../../api/speech.js";

// Dictation into the question box and read-aloud of an answer, through the browser's Web Speech API.
// - Dictation starts only on a click on the mic. Final text is handed to onTranscript (the panel appends it to the
//   textbox for editing); nothing is ever sent automatically. Interim text is shown but never handed over.
// - The mic is hidden when the browser lacks the API or the page is not a secure context (the VM site is plain
//   HTTP, where browsers refuse the microphone). A one-line note says the browser vendor's cloud service is used.
// - Read-aloud is hidden without speechSynthesis or without text. A new speakText stops the old reading.
// - Both stop on unmount (panel closed), when the tab is hidden and on dcim-session-expired.
// `disabled` stops and disables dictation (e.g. while a question is being sent); read-aloud stays available.

const iconProps = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: "false" };

function MicIcon() {
  return <svg {...iconProps}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>;
}
function SpeakerIcon() {
  return <svg {...iconProps}><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></svg>;
}
function StopIcon() {
  return <svg {...iconProps}><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" /></svg>;
}

const BUTTON = "w-8 h-8 shrink-0 inline-flex items-center justify-center rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const IDLE = "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800";
const ACTIVE_MIC = "border-rose-700 bg-rose-700 text-white hover:bg-rose-600";
const ACTIVE_SPEAK = "border-nv-400 bg-nv-400 text-zinc-950 hover:bg-nv-300";

function detach(rec) {
  if (!rec) return;
  rec.onresult = null;
  rec.onerror = null;
  rec.onend = null;
}

export default function VoiceControls({ onTranscript, speakText, disabled = false, className = "" }) {
  const win = typeof window !== "undefined" ? window : undefined;
  const [support] = useState(() => speechSupport(win));
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const recRef = useRef(null);
  const speakRunRef = useRef(0);       // id of this component's current read-aloud run; 0 = not speaking
  const runCounterRef = useRef(0);
  const voicesRef = useRef([]);
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const baseId = useId();
  const errorId = `${baseId}-error`;
  const noteId = `${baseId}-note`;

  const text = typeof speakText === "string" ? speakText.trim() : "";
  const showMic = typeof onTranscript === "function" && support.dictation;
  const showSpeak = support.readAloud && !!text;

  // ---- dictation -------------------------------------------------------------------------------------------
  function abortRecognition() {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    detach(rec);
    try { rec.abort(); } catch { /* already stopped */ }
    if (mountedRef.current) { setListening(false); setInterim(""); }
  }

  function stopRecognition() {
    const rec = recRef.current;
    if (!rec) return;
    // stop() lets the engine deliver the last words as a final result before "end".
    try { rec.stop(); } catch { abortRecognition(); }
  }

  function startRecognition() {
    if (disabled || recRef.current || !support.dictation) return;
    stopSpeaking();
    const Rec = recognitionConstructor(win);
    let rec;
    try { rec = new Rec(); } catch { setError(dictationErrorText("start-failed")); return; }
    rec.lang = DICTATION_LANG;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = event => {
      if (recRef.current !== rec || !mountedRef.current) return;
      const { final, interim: pending } = readRecognitionEvent(event);
      if (final) onTranscriptRef.current?.(final);
      setInterim(pending);
    };
    rec.onerror = event => {
      if (recRef.current !== rec || !mountedRef.current) return;
      const message = dictationErrorText(event?.error);
      if (message) setError(message);
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      recRef.current = null;
      if (mountedRef.current) { setListening(false); setInterim(""); }
    };
    recRef.current = rec;
    setError("");
    setInterim("");
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      recRef.current = null;
      detach(rec);
      setListening(false);
      setError(dictationErrorText(err?.name === "NotAllowedError" ? "not-allowed" : "start-failed"));
    }
  }

  function toggleDictation() {
    if (listening) stopRecognition(); else startRecognition();
  }

  // ---- read-aloud ------------------------------------------------------------------------------------------
  function finishSpeaking(run) {
    if (speakRunRef.current !== run) return;
    speakRunRef.current = 0;
    if (mountedRef.current) setSpeaking(false);
  }

  function stopSpeaking() {
    if (!speakRunRef.current) return;
    speakRunRef.current = 0;
    try { win?.speechSynthesis?.cancel(); } catch { /* nothing to stop */ }
    if (mountedRef.current) setSpeaking(false);
  }

  function startSpeaking() {
    const synth = win?.speechSynthesis;
    if (!synth || !text) return;
    abortRecognition();   // the microphone would otherwise transcribe the read-aloud
    let voices = [];
    try { voices = synth.getVoices?.() || []; } catch { voices = []; }
    if (!voices.length) voices = voicesRef.current;
    const voice = pickHebrewVoice(voices);
    // With a loaded voice list and no Hebrew voice the text would be read with a foreign voice: say so instead.
    if (voices.length && !voice) { setError(NO_HEBREW_VOICE); return; }
    const chunks = splitForSpeech(text);
    if (!chunks.length) return;
    try { synth.cancel(); } catch { /* nothing queued */ }
    const run = ++runCounterRef.current;
    speakRunRef.current = run;
    setError("");
    setSpeaking(true);
    try {
      chunks.forEach((chunk, i) => {
        const utterance = new win.SpeechSynthesisUtterance(chunk);
        utterance.lang = voice?.lang ? String(voice.lang).replace("_", "-") : DICTATION_LANG;
        if (voice) utterance.voice = voice;
        if (i === chunks.length - 1) utterance.onend = () => finishSpeaking(run);
        utterance.onerror = event => {
          if (speakRunRef.current !== run) return;
          const message = readAloudErrorText(event?.error);
          if (message && mountedRef.current) setError(message);
          speakRunRef.current = 0;
          try { synth.cancel(); } catch { /* already stopped */ }
          if (mountedRef.current) setSpeaking(false);
        };
        synth.speak(utterance);
      });
    } catch {
      speakRunRef.current = 0;
      try { synth.cancel(); } catch { /* already stopped */ }
      setSpeaking(false);
      setError(readAloudErrorText("failed"));
    }
  }

  function toggleSpeaking() {
    if (speaking) stopSpeaking(); else startSpeaking();
  }

  function stopAll() {
    abortRecognition();
    stopSpeaking();
  }
  const stopAllRef = useRef(stopAll);
  stopAllRef.current = stopAll;

  // Voices load asynchronously in Chrome/Edge; keep the latest list as a fallback.
  useEffect(() => {
    const synth = support.readAloud ? win?.speechSynthesis : null;
    if (!synth) return undefined;
    const load = () => { try { voicesRef.current = synth.getVoices?.() || []; } catch { voicesRef.current = []; } };
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => synth.removeEventListener?.("voiceschanged", load);
  }, []);

  // Busy (e.g. sending): stop listening without appending anything late.
  useEffect(() => {
    if (disabled) abortRecognition();
  }, [disabled]);

  // A different answer: stop reading the old one.
  useEffect(() => {
    stopSpeaking();
  }, [text]);

  // Tab hidden, page left or session expired: stop the microphone and the reading.
  useEffect(() => {
    if (!win) return undefined;
    const doc = win.document;
    const onVisibility = () => { if (doc?.hidden) stopAllRef.current(); };
    const onStop = () => stopAllRef.current();
    doc?.addEventListener("visibilitychange", onVisibility);
    win.addEventListener("pagehide", onStop);
    win.addEventListener("dcim-session-expired", onStop);
    return () => {
      doc?.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("pagehide", onStop);
      win.removeEventListener("dcim-session-expired", onStop);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRecognition();
      if (speakRunRef.current) {
        speakRunRef.current = 0;
        try { win?.speechSynthesis?.cancel(); } catch { /* nothing to stop */ }
      }
    };
  }, []);

  if (!showMic && !showSpeak) return null;

  const status = listening ? "מקליט… דבר בעברית ולחץ שוב כדי לעצור." : speaking ? "מקריא את התשובה…" : "";
  const describedBy = [showMic ? noteId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`text-xs ${className}`} dir="rtl" lang="he">
      <div className="flex items-center gap-1.5">
        {showMic && (
          <button type="button" aria-pressed={listening} aria-label={listening ? "עצור הכתבה" : "הכתבה קולית"}
            aria-describedby={describedBy} title={listening ? "עצור הכתבה" : "הכתבה קולית בעברית"}
            onClick={toggleDictation} disabled={disabled && !listening}
            className={`${BUTTON} ${listening ? ACTIVE_MIC : IDLE}`}>
            {listening ? <StopIcon /> : <MicIcon />}
          </button>
        )}
        {showSpeak && (
          <button type="button" aria-pressed={speaking} aria-label={speaking ? "עצור הקראה" : "הקרא את התשובה"}
            title={speaking ? "עצור הקראה" : "הקרא את התשובה בקול"} onClick={toggleSpeaking}
            className={`${BUTTON} ${speaking ? ACTIVE_SPEAK : IDLE}`}>
            {speaking ? <StopIcon /> : <SpeakerIcon />}
          </button>
        )}
        <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-zinc-400 min-w-0">
          {listening && <span aria-hidden="true" className="inline-block w-2 h-2 shrink-0 rounded-full bg-rose-500 motion-safe:animate-pulse" />}
          {status}
        </span>
      </div>
      {listening && interim && (
        <p className="mt-1 text-zinc-500 italic truncate" dir="auto" title={interim}>{interim}</p>
      )}
      {error && <p id={errorId} role="alert" className="mt-1 text-amber-300">{error}</p>}
      {/* Short screens (a phone in landscape): one line, the full note in the tooltip and for screen readers. */}
      {showMic && <p id={noteId} title={DICTATION_PRIVACY_NOTE} className="mt-1 text-[11px] leading-snug text-zinc-500 [@media(max-height:500px)]:truncate">{DICTATION_PRIVACY_NOTE}</p>}
    </div>
  );
}
