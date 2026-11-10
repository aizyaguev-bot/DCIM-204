// What one scanned unit barcode says about the unit: the code to look it up and store, and what can be filled in
// from it (serial, part number, model, MAC, type and a name). Pure, so node --test covers it.
// Handles a keyboard-wedge or camera scan of: a GS1 code ("(01)…(21)…", or raw with FNC1 group separators and an
// optional "]C1" / "]d2" / "]Q3" symbology prefix), a QR "key: value" label (SN, P/N, Model, MAC …), a plain NVIDIA /
// Mellanox serial (MT…), a MAC address, a known part number, or any other text (used as it is).
// The code that identifies the unit is its serial number (a plain code too); the name is the product (model, the
// product a known part number stands for, the part number, or the type), never the serial.

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

// Known NVIDIA / Mellanox part-number prefixes to the product they stand for; the first match wins. Only families we are
// sure of: MCX7… ConnectX-7, MCX6… ConnectX-6, MCX5… ConnectX-5 adapters; MBF… BlueField DPUs; MQM97… Quantum-2
// QM9700/QM9790 and MQM87… Quantum QM8700/QM8790 InfiniBand switches; MSN2700… / MSN3700… the Spectrum SN2700 and
// Spectrum-2 SN3700 Ethernet switches, MSN4… the Spectrum-3 SN4000 series; MCP… copper DAC cables; MFS… active optical
// cables and MMA… optical transceivers. Any other part number is its own name.
const PART_PRODUCTS = [
  [/^MCX7/i, "ConnectX-7 NIC"],
  [/^MCX6/i, "ConnectX-6 NIC"],
  [/^MCX5/i, "ConnectX-5 NIC"],
  [/^MBF/i, "BlueField DPU"],
  [/^MQM97/i, "Quantum-2 QM9700 switch"],
  [/^MQM87/i, "Quantum QM8700 switch"],
  [/^MSN2700/i, "Spectrum SN2700 switch"],
  [/^MSN3700/i, "Spectrum-2 SN3700 switch"],
  [/^MSN4/i, "Spectrum-3 SN4000 switch"],
  [/^MCP/i, "DAC cable"],
  [/^(MFS|MMA)/i, "Optical cable/transceiver"],
];

const KEYS = [
  [/^(SN|S\/N|SER|SERIAL|SERIAL\s*(NO|NUMBER|#))$/i, "serial"],
  [/^(PN|P\/N|PART|PART\s*(NO|NUMBER|#)|PARTNUMBER)$/i, "part_number"],
  [/^(MODEL|MODEL\s*(NO|NAME))$/i, "model"],
  [/^(MAC|MAC\s*ADDRESS|MAC\s*ADDR)$/i, "mac"],
  [/^(DESC|DESCRIPTION|PRODUCT|PRODUCT\s*NAME)$/i, "description"],
];
const KEY_WORDS = "SN|S\\/N|SER|SERIAL(?:\\s*(?:NO|NUMBER|#))?|PN|P\\/N|PART(?:\\s*(?:NO|NUMBER|#))?|PARTNUMBER|MODEL(?:\\s*(?:NO|NAME))?|MAC(?:\\s*(?:ADDRESS|ADDR))?|DESC(?:RIPTION)?|PRODUCT(?:\\s*NAME)?";
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

// The product a part number stands for ("ConnectX-7 NIC"), or "" when it is not a known one.
export function productForPart(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  for (const [pattern, product] of PART_PRODUCTS) if (pattern.test(value)) return product;
  return "";
}

// The lab owner's rule: a unit that has a serial number and nothing that names another product is most likely a switch
// under test, so it is saved (or marked) as a switch. Not caught: a part number or model of a known type (a cable, PDU,
// KVM ... keeps that type); a NIC, DPU or other known NVIDIA part (MCX…, MBF…, MCP…, ConnectX, BlueField, adapter);
// an NVIDIA board or GPU OPN (900-9X766-…, 699-…), also as the serial or code itself; a model or description that
// names a server or another product (DGX, HGX, server, PowerEdge, ProLiant, ThinkSystem, compute, node, UPS, board,
// superchip, an H100 / A100 / GB200 … GPU, an NVL72 system); and another vendor's unit (Cisco, Arista, Dell …), which is a switch only
// when its label says so ("switch", "PowerSwitch") or names an NVIDIA switch model (an HPE-sold SN2010M).
// code: the unit's serial number (a labelled SN, a GS1 (21) or a plain scanned code); only checked for a board OPN.
// Returns the type: "switch", a known type, or "other".
const SERVER_WORDS = /\b(DGX|HGX|servers?|PowerEdge|ProLiant|ThinkSystem|ThinkAgile|compute|nodes?|workstation|UPS|boards?|superchip|Grace|Hopper|[AHBL]\d{2,3}S?|GB\d{3}|NVL\d+)\b/i;
const BOARD_OPN = /(^|[^0-9A-Z])(900|699)-[0-9A-Z]{5}-[0-9A-Z]{4}/i;
const OTHER_VENDORS = /\b(Cisco|Arista|Juniper|Dell|HPE|HP|Hewlett|Aruba|Lenovo|Supermicro|Gigabyte|ASUS|ASRock|Inspur|Wiwynn|Foxconn|Brocade|Extreme\s+Networks|Netgear|Ubiquiti|MikroTik|Huawei|Fortinet|Edgecore|Celestica|Quanta)\b/i;
const SWITCH_WORDS = /switch(es)?\b|\bM?(SN|QM)\d{4}[A-Z]{0,2}\b|\b(Spectrum|Quantum)\b/i;
export function serialUnitType({ part_number = "", model = "", description = "", code = "" } = {}) {
  const named = typeForPart(part_number) || typeForPart(model);
  if (named) return named;
  const words = [model, description].join(" "), all = [part_number, words].join(" ");
  if (productForPart(part_number) || /\b(connect-?x|blue-?field|nic|dpu|hca|adapter|gpu)/i.test(words)) return "other";
  if (BOARD_OPN.test(part_number) || BOARD_OPN.test(words) || BOARD_OPN.test(code)) return "other";
  if (SERVER_WORDS.test(all)) return "other";
  if (OTHER_VENDORS.test(all)) return SWITCH_WORDS.test(all) ? "switch" : "other";
  return "switch";
}

// A unit nothing identifies yet: type other with the generic name ("Unit", the name a scan gives it) or with its own
// code (barcode, serial number or id) as its name. A serial number entered for it marks it as a switch by the rule above.
export const GENERIC_UNIT_NAME = TYPE_LABELS.other;
export function isGenericUnit(item) {
  if ((item?.type || "other") !== "other") return false;
  const name = String(item?.name || "").trim().toLowerCase();
  if (!name || name === GENERIC_UNIT_NAME.toLowerCase()) return true;
  return [item.barcode, item.serial_number, item.id].some(code => String(code || "").trim().toLowerCase() === name);
}

// "00:1A:…", "00-1a-…", "001A2B3C4D5E" or "001a.2b3c.4d5e" (the forms the server reads as a MAC) -> "00:1A:2B:3C:4D:5E".
function macOf(text) {
  const value = String(text || "").trim();
  const match = /^([0-9A-F]{2})([:-]?)([0-9A-F]{2})\2([0-9A-F]{2})\2([0-9A-F]{2})\2([0-9A-F]{2})\2([0-9A-F]{2})$/i.exec(value);
  if (match) return [1, 3, 4, 5, 6, 7].map(i => match[i].toUpperCase()).join(":");
  return /^[0-9A-F]{4}\.[0-9A-F]{4}\.[0-9A-F]{4}$/i.test(value) ? value.replace(/\./g, "").toUpperCase().match(/../g).join(":") : "";
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

  // serial_from_code: the serial is the scanned code itself (a plain code), not a value the label calls a serial.
  const result = { code: "", raw: "", serial: "", serial_from_code: false, part_number: "", model: "", mac: "", gtin: "", lot: "", type: "", name: "" };
  let description = "";
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
      description = clean(pairs.description || "");
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
  // A plain code (not a GS1 or key: value label, not a MAC) is the unit's own identifier: its serial number. The code
  // stays as well, so the unit is still found by it and the server's barcode/serial duplicate rule still applies.
  if (!fields && !result.serial && !result.mac) {
    result.serial = result.code;
    result.serial_from_code = true;
  }

  // A unit whose label gives its serial number but no other product is most likely a switch under test, by the lab
  // owner's rule (serialUnitType), so it is saved as a switch; its type can be changed in DCIM. A part number, model or
  // description that names a NIC, DPU, board, server or any other known product keeps that product's type (or other).
  const named = typeForPart(result.part_number) || typeForPart(result.model);
  result.type = named || (result.serial ? serialUnitType({ part_number: result.part_number, model: result.model, description, code: result.serial }) : "other");
  // The product, never the serial: two units of one product share a name; the serial tells them apart.
  const kind = /^MCX/i.test(result.part_number) ? "NIC" : TYPE_LABELS[result.type];
  result.name = clean(result.model || productForPart(result.part_number) || description || result.part_number || kind, NAME_MAX);
  return result;
}

export function unitTypeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.other;
}
