import test from "node:test";
import assert from "node:assert/strict";
import {
  DICTATION_PRIVACY_NOTE, answerToSpeech, dictationErrorText, mergeTranscript, pickHebrewVoice, readAloudErrorText, readRecognitionEvent,
  recognitionConstructor, speakable, speechSupport, splitForSpeech,
} from "../api/speech.js";

class FakeRecognition {}
class FakeUtterance {}
const synth = { speak() {}, cancel() {}, getVoices: () => [] };

test("support: nothing without a window", () => {
  assert.deepEqual(speechSupport(undefined), { dictation: false, readAloud: false, dictationBlocked: null });
  assert.deepEqual(speechSupport(null), { dictation: false, readAloud: false, dictationBlocked: null });
});

test("support: standard and webkit-prefixed recognition, synthesis needs speak/cancel and the utterance class", () => {
  assert.deepEqual(speechSupport({ SpeechRecognition: FakeRecognition, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance, isSecureContext: true }),
    { dictation: true, readAloud: true, dictationBlocked: null });
  assert.deepEqual(speechSupport({ webkitSpeechRecognition: FakeRecognition, isSecureContext: true }),
    { dictation: true, readAloud: false, dictationBlocked: null });
  assert.equal(recognitionConstructor(undefined), null);
  assert.equal(recognitionConstructor({ webkitSpeechRecognition: FakeRecognition }), FakeRecognition);
  assert.equal(recognitionConstructor({ SpeechRecognition: FakeRecognition, webkitSpeechRecognition: class {} }), FakeRecognition);
  assert.deepEqual(speechSupport({ speechSynthesis: synth }), { dictation: false, readAloud: false, dictationBlocked: null });
  assert.deepEqual(speechSupport({ speechSynthesis: {}, SpeechSynthesisUtterance: FakeUtterance }), { dictation: false, readAloud: false, dictationBlocked: null });
  assert.deepEqual(speechSupport({ speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance }), { dictation: false, readAloud: true, dictationBlocked: null });
});

test("support: a non-constructor recognition value is unsupported", () => {
  assert.equal(speechSupport({ SpeechRecognition: {}, webkitSpeechRecognition: "x" }).dictation, false);
  assert.equal(recognitionConstructor({ SpeechRecognition: {} }), null);
});

test("support: dictation only on a secure page (the VM site is plain HTTP); read-aloud does not need it", () => {
  assert.deepEqual(speechSupport({ webkitSpeechRecognition: FakeRecognition, isSecureContext: false }),
    { dictation: false, readAloud: false, dictationBlocked: "insecure" });
  // isSecureContext missing or not exactly true counts as insecure.
  assert.deepEqual(speechSupport({ webkitSpeechRecognition: FakeRecognition }),
    { dictation: false, readAloud: false, dictationBlocked: "insecure" });
  assert.equal(speechSupport({ SpeechRecognition: FakeRecognition, isSecureContext: "yes" }).dictation, false);
  assert.deepEqual(speechSupport({ SpeechRecognition: FakeRecognition, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance, isSecureContext: false }),
    { dictation: false, readAloud: true, dictationBlocked: "insecure" });
  // No recognition API at all is plain "unsupported", never "blocked".
  assert.equal(speechSupport({ isSecureContext: false }).dictationBlocked, null);
});

test("privacy note says dictation uses the browser vendor's cloud speech service, in one Hebrew line", () => {
  assert.match(DICTATION_PRIVACY_NOTE, /בענן/);
  assert.match(DICTATION_PRIVACY_NOTE, /יצרן הדפדפן/);
  assert.ok(!/[\r\n]/.test(DICTATION_PRIVACY_NOTE));
});

test("Hebrew voice: he-IL preferred over he and iw, default then local wins, else null", () => {
  const en = { name: "English", lang: "en-US", default: true };
  const he = { name: "he plain", lang: "he" };
  const heIL = { name: "Asaf", lang: "he-IL", localService: false };
  const heILLocal = { name: "Asaf local", lang: "he_IL", localService: true };
  const iw = { name: "Android", lang: "iw-IL" };
  assert.equal(pickHebrewVoice([en, he, heIL]), heIL);
  assert.equal(pickHebrewVoice([en, iw, he]), he);
  assert.equal(pickHebrewVoice([en, iw]), iw);
  assert.equal(pickHebrewVoice([en, heIL, heILLocal]), heILLocal);
  assert.equal(pickHebrewVoice([heILLocal, { ...heIL, default: true }]).name, "Asaf");
  assert.equal(pickHebrewVoice([en, { name: "x", lang: "hu-HU" }]), null);
  assert.equal(pickHebrewVoice([]), null);
  assert.equal(pickHebrewVoice(undefined), null);
  assert.equal(pickHebrewVoice([{ name: "no lang" }]), null);
});

test("speakable text drops source ids, hex ids, urls and markdown but keeps names, racks and IPs", () => {
  assert.equal(speakable("השרת **OPT207** לא זמין [ping_targets:opt207] ping_targets:opt207"), "השרת OPT207 לא זמין");
  assert.equal(speakable("ראה https://example.test/x?y=1 ו-`Rack-01`"), "ראה ו- Rack-01");
  assert.equal(speakable("עבודה 0123456789abcdef0123456789abcdef נשמרה"), "עבודה נשמרה");
  assert.equal(speakable("כתובת 10.0.0.5 בשעה 10:30 , Rack-03"), "כתובת 10.0.0.5 בשעה 10:30, Rack-03");
  assert.equal(speakable(null), "");
});

test("answerToSpeech reads summary, numbered first checks and first recommendations only", () => {
  const answer = {
    summary: "שני שרתים לא זמינים ברשת",
    facts: [{ text: "OPT207 down", source_ids: ["ping_targets:opt207"] }],
    hypotheses: [{ text: "PDU", support: [], verify: "", source_ids: [] }],
    checks: ["בדוק את שקע 4 ב-PDU של Rack-03", "בדוק כבל רשת", "", "c3", "c4", "c5", "c6"],
    recommendations: [
      { title: "החלפת כבל", next_step: "פתח טיוטת עבודה", priority: "high", source_ids: ["x:y"], entity_refs: [] },
      { title: "בדיקת PDU", next_step: "", priority: "medium" },
      { title: "שלישית", next_step: "צעד" },
      { title: "רביעית", next_step: "לא תוקרא" },
    ],
    missing_data: ["אין ניטור UPS"],
    entity_refs: [{ kind: "server", id: "opt207", label: "OPT207" }],
  };
  const text = answerToSpeech(answer);
  assert.ok(text.startsWith("שני שרתים לא זמינים ברשת. מה לבדוק קודם: בדיקה ראשונה: בדוק את שקע 4 ב-PDU של Rack-03."), text);
  assert.ok(text.includes("בדיקה שנייה: בדוק כבל רשת."));
  assert.ok(text.includes("בדיקה חמישית: c5."));
  assert.ok(!text.includes("c6"));
  assert.ok(text.includes("ועוד 1 בדיקות בחלונית."));
  assert.ok(text.includes("המלצות: המלצה ראשונה: החלפת כבל. הצעד הבא: פתח טיוטת עבודה."));
  assert.ok(text.includes("המלצה שנייה: בדיקת PDU."));
  assert.ok(!text.includes("לא תוקרא"));
  assert.ok(text.includes("ועוד 1 המלצות בחלונית."));
  assert.ok(!/ping_targets|opt207|x:y|אין ניטור UPS|OPT207 down/.test(text), text);
});

test("answerToSpeech tolerates missing arrays, a single recommendation and bad input", () => {
  assert.equal(answerToSpeech({ summary: "הכל נקרא." }), "הכל נקרא.");
  assert.equal(answerToSpeech({ summary: "", checks: null, recommendations: [{ title: "יחידה", next_step: "צעד" }] }),
    "המלצה: יחידה. הצעד הבא: צעד.");
  assert.equal(answerToSpeech({ recommendations: [null, { title: "" }] }), "");
  assert.equal(answerToSpeech(null), "");
  assert.equal(answerToSpeech("text"), "");
});

test("splitForSpeech keeps sentences together and caps chunk length", () => {
  assert.deepEqual(splitForSpeech(""), []);
  assert.deepEqual(splitForSpeech("משפט אחד. משפט שני."), ["משפט אחד. משפט שני."]);
  const chunks = splitForSpeech("א".repeat(50) + ". " + "ב".repeat(50) + ". " + "ג".repeat(50) + ".", 110);
  assert.deepEqual(chunks, ["א".repeat(50) + ". " + "ב".repeat(50) + ".", "ג".repeat(50) + "."]);
  const long = Array.from({ length: 80 }, (_, i) => `מילה${i}`).join(" ");
  const parts = splitForSpeech(long, 100);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= 100), JSON.stringify(parts.map(p => p.length)));
  assert.equal(parts.join(" "), long);
});

test("mergeTranscript appends with one space and never loses the typed text", () => {
  assert.equal(mergeTranscript("", "מה נפל במעבדה"), "מה נפל במעבדה");
  assert.equal(mergeTranscript("מה נפל", " במעבדה  היום "), "מה נפל במעבדה היום");
  assert.equal(mergeTranscript("שאלה ", "המשך"), "שאלה המשך");
  assert.equal(mergeTranscript("שורה\n", "חדשה"), "שורה\nחדשה");
  assert.equal(mergeTranscript("   ", "טקסט"), "טקסט");
  assert.equal(mergeTranscript("טקסט", ""), "טקסט");
  assert.equal(mergeTranscript("טקסט", "   "), "טקסט");
  assert.equal(mergeTranscript(undefined, null), "");
  assert.equal(mergeTranscript("abc", "defgh", 6), "abc de");
  assert.equal(mergeTranscript("abc", "d", 0), "abc d");
});

test("readRecognitionEvent separates new final text from interim text", () => {
  const r = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
  const event = { resultIndex: 1, results: [r("ישן", true), r("מה נפל", true), r(" במעבדה", false)] };
  assert.deepEqual(readRecognitionEvent(event), { final: "מה נפל", interim: "במעבדה" });
  assert.deepEqual(readRecognitionEvent({ resultIndex: 0, results: [r("א", true), r("ב", true)] }), { final: "א ב", interim: "" });
  assert.deepEqual(readRecognitionEvent({ results: [r("ג", false)] }), { final: "", interim: "ג" });
  assert.deepEqual(readRecognitionEvent({ resultIndex: 0, results: [r("  ", true)] }), { final: "", interim: "" });
  assert.deepEqual(readRecognitionEvent(null), { final: "", interim: "" });
});

test("dictation and read-aloud errors are Hebrew; our own stops are silent", () => {
  assert.equal(dictationErrorText("aborted"), null);
  assert.match(dictationErrorText("not-allowed"), /הרשאה למיקרופון/);
  assert.match(dictationErrorText("not-allowed", { insecure: true }), /HTTPS/);
  assert.match(dictationErrorText("service-not-allowed"), /הרשאה למיקרופון/);
  assert.match(dictationErrorText("no-speech"), /לא נקלט דיבור/);
  assert.match(dictationErrorText("audio-capture"), /מיקרופון/);
  assert.match(dictationErrorText("network"), /רשת/);
  assert.match(dictationErrorText("something-new"), /ההכתבה נכשלה/);
  assert.equal(readAloudErrorText("interrupted"), null);
  assert.equal(readAloudErrorText("canceled"), null);
  assert.match(readAloudErrorText("voice-unavailable"), /עברית/);
  assert.match(readAloudErrorText("other"), /ההקראה נכשלה/);
});
