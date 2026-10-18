// Voice helpers for the lab assistant: dictation (Web Speech API recognition) and read-aloud (speechSynthesis).
// Pure functions only, free of DOM/React, so node --test can import this module. The components pass `window`.

export const DICTATION_LANG = "he-IL";

const MAX_CHECKS = 5;
const MAX_RECOMMENDATIONS = 3;
const ORDINALS = ["ראשונה", "שנייה", "שלישית", "רביעית", "חמישית"];

function recognitionClass(win) {
  if (!win) return null;
  const Rec = win.SpeechRecognition || win.webkitSpeechRecognition;
  return typeof Rec === "function" ? Rec : null;
}

// What the browser offers. Dictation needs a secure page (HTTPS or localhost): browsers refuse the microphone on
// plain HTTP, so there it is reported unavailable (`dictationBlocked: "insecure"`) and the mic stays hidden.
// A window without isSecureContext is treated as insecure.
export function speechSupport(win) {
  if (!win) return { dictation: false, readAloud: false, dictationBlocked: null };
  const synth = win.speechSynthesis;
  const readAloud = !!synth && typeof synth.speak === "function" && typeof synth.cancel === "function"
    && typeof win.SpeechSynthesisUtterance === "function";
  const hasRecognition = !!recognitionClass(win);
  const insecure = hasRecognition && win.isSecureContext !== true;
  return { dictation: hasRecognition && !insecure, readAloud, dictationBlocked: insecure ? "insecure" : null };
}

// Shown next to the mic: browser dictation sends the audio to the browser vendor's cloud speech service.
export const DICTATION_PRIVACY_NOTE = "הכתבה קולית עוברת לשירות זיהוי הדיבור בענן של יצרן הדפדפן.";

export function recognitionConstructor(win) {
  return recognitionClass(win);
}

function voiceRank(voice) {
  const lang = String(voice?.lang || "").toLowerCase().replace("_", "-");
  if (lang === "he-il") return 0;
  if (lang === "he" || lang.startsWith("he-")) return 1;
  if (lang === "iw" || lang.startsWith("iw-")) return 2;   // old Hebrew code, still used by some Android voices
  return -1;
}

// Hebrew voice to read answers with: he-IL first, then any he-*, then the legacy iw-* code; within a rank the
// system default voice wins, then a local (offline) voice, then the browser's order. null when there is none.
export function pickHebrewVoice(voices) {
  const list = Array.from(voices || []).filter(v => voiceRank(v) >= 0);
  if (!list.length) return null;
  return list
    .map((voice, index) => ({ voice, index }))
    .sort((a, b) => voiceRank(a.voice) - voiceRank(b.voice)
      || Number(!!b.voice.default) - Number(!!a.voice.default)
      || Number(!!b.voice.localService) - Number(!!a.voice.localService)
      || a.index - b.index)[0].voice;
}

// Text for speech: drops what is noise when heard (source ids like "ping_targets:opt207", long hex ids, URLs,
// markdown marks, bracketed references) and collapses whitespace. Names, racks and IPs stay.
export function speakable(text) {
  return String(text ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[[^\]\n]{0,80}\]/g, " ")
    .replace(/\b[a-z][a-z0-9_]*:[\w./:-]+/g, " ")
    .replace(/\b[0-9a-f]{16,}\b/gi, " ")
    .replace(/[*`#_>|]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+([.,:;!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(text) {
  const t = speakable(text);
  if (!t) return "";
  return /[.!?:׃]$/.test(t) ? t : `${t}.`;
}

function ordinal(i) {
  return ORDINALS[i] || String(i + 1);
}

// Plain Hebrew text to read an answer aloud: the summary, the first checks (numbered) and the first
// recommendations with their next step. Never source ids, entity refs or the sources list.
export function answerToSpeech(answer) {
  if (!answer || typeof answer !== "object") return "";
  const parts = [];
  const summary = sentence(answer.summary);
  if (summary) parts.push(summary);

  const checks = (Array.isArray(answer.checks) ? answer.checks : []).map(c => speakable(c)).filter(Boolean);
  if (checks.length) {
    parts.push("מה לבדוק קודם:");
    checks.slice(0, MAX_CHECKS).forEach((c, i) => parts.push(`בדיקה ${ordinal(i)}: ${sentence(c)}`));
    if (checks.length > MAX_CHECKS) parts.push(`ועוד ${checks.length - MAX_CHECKS} בדיקות בחלונית.`);
  }

  const recs = (Array.isArray(answer.recommendations) ? answer.recommendations : [])
    .filter(r => r && typeof r === "object" && (speakable(r.title) || speakable(r.next_step)));
  if (recs.length) {
    parts.push(recs.length === 1 ? "המלצה:" : "המלצות:");
    recs.slice(0, MAX_RECOMMENDATIONS).forEach((r, i) => {
      const title = sentence(r.title);
      const step = speakable(r.next_step);
      const head = recs.length === 1 ? "" : `המלצה ${ordinal(i)}: `;
      parts.push(`${head}${title}${step ? ` הצעד הבא: ${sentence(step)}` : ""}`.trim());
    });
    if (recs.length > MAX_RECOMMENDATIONS) parts.push(`ועוד ${recs.length - MAX_RECOMMENDATIONS} המלצות בחלונית.`);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Long utterances get cut off by some engines (Chrome stops after about 15 seconds), so speech is queued as
// sentence-sized chunks of at most `max` characters.
export function splitForSpeech(text, max = 180) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?:׃]+[.!?:׃]*\s*/g) || [clean];
  const chunks = [];
  let current = "";
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  for (const s of sentences) {
    if (s.length > max) {
      push();
      let rest = s.trim();
      while (rest.length > max) {
        let cut = rest.lastIndexOf(" ", max);
        if (cut < max / 2) cut = max;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest ? `${rest} ` : "";
    } else if ((current + s).length > max) {
      push();
      current = s;
    } else {
      current += s;
    }
  }
  push();
  return chunks;
}

// Appends dictated text to what is already in the textbox (the user edits before sending). One space between
// them unless the current text already ends in whitespace; `max` (optional) caps the result length.
export function mergeTranscript(current, finalText, max) {
  const base = String(current ?? "");
  const add = String(finalText ?? "").replace(/\s+/g, " ").trim();
  if (!add) return base;
  const joined = !base.trim() ? add : /\s$/.test(base) ? base + add : `${base} ${add}`;
  return Number.isFinite(max) && max > 0 ? joined.slice(0, max) : joined;
}

// Splits a SpeechRecognition "result" event into newly finalised text and the current interim (not final) text.
// Only results from event.resultIndex on are new; earlier final results were delivered by previous events.
export function readRecognitionEvent(event) {
  const results = event?.results;
  const finals = [];
  const interim = [];
  if (!results) return { final: "", interim: "" };
  const start = Number.isInteger(event.resultIndex) && event.resultIndex >= 0 ? event.resultIndex : 0;
  for (let i = start; i < results.length; i += 1) {
    const result = results[i];
    const text = String(result?.[0]?.transcript ?? "").trim();
    if (!text) continue;
    (result.isFinal ? finals : interim).push(text);
  }
  return { final: finals.join(" "), interim: interim.join(" ") };
}

// Hebrew message for a SpeechRecognition error code; null when nothing should be shown (the user stopped).
export function dictationErrorText(code, { insecure = false } = {}) {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return insecure
        ? "הדפדפן חוסם את המיקרופון בחיבור לא מאובטח (HTTP). הכתבה קולית פועלת רק בחיבור HTTPS."
        : "אין הרשאה למיקרופון. אפשר לאשר גישה למיקרופון בהגדרות הדפדפן ולנסות שוב.";
    case "no-speech":
      return "לא נקלט דיבור. נסה שוב ודבר קרוב יותר למיקרופון.";
    case "audio-capture":
      return "לא נמצא מיקרופון פעיל במחשב.";
    case "network":
      return "שירות זיהוי הדיבור של הדפדפן אינו זמין כרגע (נדרש חיבור לרשת). אפשר להקליד את השאלה.";
    case "language-not-supported":
      return "הדפדפן אינו תומך בזיהוי דיבור בעברית.";
    default:
      return "ההכתבה נכשלה. נסה שוב או הקלד את השאלה.";
  }
}

// Hebrew message for a speechSynthesis utterance error; null for an interruption we caused (stop / new text).
export function readAloudErrorText(code) {
  switch (code) {
    case "interrupted":
    case "canceled":
      return null;
    case "not-allowed":
      return "הדפדפן חסם את ההקראה. לחץ שוב על כפתור ההקראה.";
    case "language-unavailable":
    case "voice-unavailable":
    case "synthesis-unavailable":
      return "אין במכשיר הזה קול זמין להקראה בעברית.";
    default:
      return "ההקראה נכשלה. נסה שוב.";
  }
}

export const NO_HEBREW_VOICE = "לא נמצא במכשיר הזה קול להקראה בעברית. אפשר להוסיף קול עברי בהגדרות השפה של מערכת ההפעלה.";
