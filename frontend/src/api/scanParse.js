// What one scanned unit barcode says about the unit: the code to look it up and store, and what can be filled in
// from it (serial, part number, model, MAC, type and a name). Pure, so node --test covers it.
// Handles a keyboard-wedge or camera scan of: a GS1 code ("(01)…(21)…", or raw with FNC1 group separators and an
// optional "]C1" / "]d2" / "]Q3" symbology prefix), a QR "key: value" label (SN, P/N, Model, MAC …), a plain NVIDIA /
// Mellanox serial (MT…), a MAC address, a known part number, or any other text (used as it is).

export const UNIT_CODE_MAX = 200;
const FIELD_MAX = 120;
const NAME_MAX = 160;
const GS = "\x1d";

// GS1 application identifiers we read; a number is a fixed length, null is variable (ends at FNC1 or the end).
const GS1_AIS = { "00": 18, "01": 14, "02": 14, "10": null, "11": 6, "13": 6, "15": 6, "17": 6, "21": null, "240": null, "241": null, "30": null, "37": null, "8004": null };

const TYPE_LABELS = { switch: "Switch", cable: "Cable", pdu: "PDU", kvm: "KVM", ups: "UPS", computer: "Computer", patchpanel: "Patch panel", other: "Unit" };

// Part numbers (or model names) to a unit type; the first match wins. "NIC" is shown in the name, stored as other.
const PART_TYPES = [
  [/^(MQM|MSN|MSB|MSX|QM\d|SN\d{4})/i, "switch"],
  [/^(MCP|MFS|MMA|MC2|MMS)/i, "cable"],
  [/^(PX\d?-|PX[234]\b|RARITAN\s+PX)/i, "pdu"],
  [/^(DKX|DLX|DKX3|KX\d|DOMINION)/i, "kvm"],
  [/^MCX/i, "other"],
];

const KEYS = [
  [/^(SN|S\/N|SER|SERIAL|SERIAL\s*(NO|NUMBER|#))$/i, "serial"],
  [/^(PN|P\/N|PART|PART\s*(NO|NUMBER|#)|PARTNUMBER)$/i, "part_number"],
  [/^(MODEL|MODEL\s*(NO|NAME))$/i, "model"],
  [/^(MAC|MAC\s*ADDRESS|MAC\s*ADDR)$/i, "mac"],
];
const KEY_WORDS = "SN|S\\/N|SER|SERIAL(?:\\s*(?:NO|NUMBER|#))?|PN|P\\/N|PART(?:\\s*(?:NO|NUMBER|#))?|PARTNUMBER|MODEL(?:\\s*(?:NO|NAME))?|MAC(?:\\s*(?:ADDRESS|ADDR))?";
const KEY_VALUE = new RegExp(`^\\s*(${KEY_WORDS})\\s*[:=]\\s*(.*?)\\s*$`, "i");
const NEXT_KEY = new RegExp(`\\s+(?=(?:${KEY_WORDS})\\s*[:=])`, "i");

const clean = (value, max = FIELD_MAX) => Array.from(String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, max).join("");

function fail(message) {
  const error = new Error(message);
  error.parse = true;
  return error;
}

export function typeForPart(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  for (const [pattern, type] of PART_TYPES) if (pattern.test(value)) return type;
  return "";
}

function macOf(text) {
  const value = String(text || "").trim();
  const match = /^([0-9A-F]{2})([:-]?)([0-9A-F]{2})\2([0-9A-F]{2})\2([0-9A-F]{2})\2([0-9A-F]{2})\2([0-9A-F]{2})$/i.exec(value);
  return match ? [1, 3, 4, 5, 6, 7].map(i => match[i].toUpperCase()).join(":") : "";
}

// "(01)…(21)…" written out, as on the human-readable line of a GS1 label.
function gs1Bracketed(text) {
  if (!/^\(\d{2,4}\)/.test(text)) return null;
  const fields = new Map();
  const pattern = /\((\d{2,4})\)([^(]*)/g;
  let match, end = 0;
  while ((match = pattern.exec(text))) {
    if (match.index !== end) return null;
    fields.set(match[1], match[2].trim());
    end = pattern.lastIndex;
  }
  return end === text.length && fields.size ? fields : null;
}

// Raw GS1 element string: AIs back to back, a variable-length one ended by FNC1 (GS).
function gs1Raw(text) {
  const fields = new Map();
  let at = 0;
  while (at < text.length) {
    if (text[at] === GS) { at++; continue; }
    const ai = ["8004", "240", "241"].find(k => text.startsWith(k, at)) || text.slice(at, at + 2);
    if (!(ai in GS1_AIS)) return null;
    at += ai.length;
    const size = GS1_AIS[ai];
    let value;
    if (size) { value = text.slice(at, at + size); if (value.length !== size) return null; at += size; }
    else { const stop = text.indexOf(GS, at); value = text.slice(at, stop < 0 ? text.length : stop); at = stop < 0 ? text.length : stop + 1; }
    fields.set(ai, value);
  }
  return fields.size ? fields : null;
}

function keyValues(text) {
  const pieces = text.split(/[\r\n;|,\t]+/).flatMap(piece => piece.split(NEXT_KEY));
  const fields = {};
  let found = 0;
  for (const piece of pieces) {
    const match = KEY_VALUE.exec(piece);
    if (!match) continue;
    const key = KEYS.find(([pattern]) => pattern.test(match[1].replace(/\s+/g, " ").trim()))?.[1];
    if (key && match[2] && !fields[key]) { fields[key] = match[2]; found++; }
  }
  return found ? fields : null;
}

// raw: the scanned text (a wedge scanner's keystrokes, or a camera reading). Throws an Error with a sentence for the
// operator when it cannot be a unit barcode (empty, a location label, too long).
export function parseUnitBarcode(raw) {
  let text = String(raw ?? "").replace(/^[\s\r\n]+|[\s\r\n]+$/g, "");
  let gs1 = false;
  const symbology = /^\][A-Za-z][0-9A-Za-z]/.exec(text);
  if (symbology) {
    gs1 = /^\](C1|d2|Q3|e0|J1)$/.test(symbology[0]);
    text = text.slice(3);
  }
  text = text.replace(/<GS>|\^\]/gi, GS).replace(/^\x1d+|\x1d+$/g, "").trim();
  if (!text) throw fail("Scan a barcode first.");
  if (/^(LOC|RACK|STORE):/i.test(text)) throw fail("This is a location label. Scan the barcode on the unit itself.");

  const result = { code: "", raw: "", serial: "", part_number: "", model: "", mac: "", gtin: "", lot: "", type: "", name: "" };
  const fields = gs1Bracketed(text) || ((gs1 || text.includes(GS)) ? gs1Raw(text) : null);
  let readable = clean(text, Infinity);
  if (fields) {
    const ai = key => fields.get(key) || "";
    result.gtin = clean(ai("01") || ai("02"));
    result.serial = clean(ai("21") || ai("8004"));
    result.part_number = clean(ai("240") || ai("241"));
    result.lot = clean(ai("10"));
    // Stored as the readable "(01)…(21)…" form, in scan order, never with control characters.
    readable = clean([...fields].map(([key, value]) => `(${key})${value}`).join(""), Infinity);
  } else {
    const pairs = keyValues(text);
    if (pairs) {
      result.serial = clean(pairs.serial || "");
      result.part_number = clean(pairs.part_number || "");
      result.model = clean(pairs.model || "");
      result.mac = macOf(pairs.mac) || clean(pairs.mac || "");
    } else if (/^MT\d{4}[A-Z0-9]{4,}$/i.test(readable)) {
      result.serial = readable.toUpperCase();
    } else if (macOf(readable)) {
      result.mac = macOf(readable);
    } else if (typeForPart(readable) && !/\s/.test(readable)) {
      result.part_number = readable;
    }
  }

  // A part number, model or GTIN names the product, not this unit: two switches of one model share it, so it would
  // match (and move) the wrong unit. Only a serial, a MAC or an unrecognised code identifies one unit.
  if (!result.serial && !result.mac && (fields ? result.gtin || result.part_number : result.part_number || result.model))
    throw fail("This barcode only names the product, not this unit. Scan the serial number barcode on the unit.");

  result.raw = readable;
  result.code = result.serial || result.mac || readable;
  if (Array.from(result.code).length > UNIT_CODE_MAX) throw fail(`This barcode is too long (more than ${UNIT_CODE_MAX} characters). Scan the serial number barcode on the unit instead.`);
  if (Array.from(result.raw).length > UNIT_CODE_MAX) result.raw = result.code;

  result.type = typeForPart(result.part_number) || typeForPart(result.model) || "other";
  const kind = /^MCX/i.test(result.part_number) ? "NIC" : TYPE_LABELS[result.type];
  const label = result.model || result.part_number;
  const id = result.code;
  const named = label && label.toLowerCase() !== id.toLowerCase() ? `${label} ${id}` : result.type !== "other" || kind === "NIC" ? `${kind} ${id}` : id;
  result.name = clean(named, NAME_MAX);
  return result;
}

export function unitTypeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.other;
}
