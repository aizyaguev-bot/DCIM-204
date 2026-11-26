// Serial numbers out and looked-up details back in (Scan & Track > Serial numbers). The parsing is pure, so node --test
// covers it: a CSV/TSV file, or rows pasted from Excel or a web table, with a header row whose columns are recognised
// by name (SN / Serial / Serial Number, P/N / Part Number / PN / OPN / מק"ט, Name / Description / Product, Model, Type).
// The server matches each row to a unit by serial number (or barcode) and reports what would change (dry run) before
// anything is applied. Lookups on the SN analysis page are done as "switch", so with "Mark as switches" on (mark_switch)
// a matched unit nobody identified yet (no type, or Other with a generic name) becomes a switch; a unit identified as
// something else (a NIC by its name or MCX / ConnectX part number, a PDU, cable, server...) keeps its type and the
// preview says so ("kept type ...").

export const LOOKUP_AS = "switch";
const HEADER_SEARCH = 5;   // a copied web table may start with a title line or two above its header row
export const MAX_ROWS = 5000;
const SERIAL_MAX = 200, PART_MAX = 120, MODEL_MAX = 120, NAME_MAX = 160, TYPE_MAX = 60;

// Header text -> comparable key: lower case, letters and digits only (Hebrew kept), so "Serial Number", "serial_number",
// "S/N" and "Serial #" all compare as their letters.
export function headerKey(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const COLUMN_NAMES = {
  serial: ["sn", "serial", "serialnumber", "serialno", "serialnum", "sno", "snno", "snnumber", "unitserial", "unitsn", "מספרסידורי", "מססידורי", "סריאלי"],
  part_number: ["pn", "partnumber", "partno", "partnum", "part", "opn", "orderingpartnumber", "mpn", "mfgpartnumber", "manufacturerpartnumber", "productpartnumber", "itempartnumber", "מקט", "מספרפריט"],
  name: ["name", "description", "desc", "product", "productname", "productdescription", "itemdescription", "itemname", "partdescription", "productfamily", "שם", "תיאור", "מוצר", "שםמוצר", "תיאורמוצר"],
  model: ["model", "modelname", "modelnumber", "productmodel", "דגם"],
  type: ["type", "producttype", "devicetype", "unittype", "itemtype", "category", "productcategory", "סוג", "סוגמוצר"],
};
// When no header matches exactly: a header that contains one of these is the column (the first such column wins).
const COLUMN_HINTS = [["serial", /serial/], ["part_number", /partnumber|partno/], ["name", /description|productname/], ["type", /type$/]];

// {serial, part_number, name, model, type}: the column index of each recognised column (absent = not found).
export function detectColumns(cells) {
  const keys = cells.map(headerKey);
  const columns = {};
  for (const [field, names] of Object.entries(COLUMN_NAMES)) {
    const index = keys.findIndex(key => names.includes(key));
    if (index >= 0) columns[field] = index;
  }
  for (const [field, hint] of COLUMN_HINTS) {
    if (field in columns) continue;
    const used = new Set(Object.values(columns));
    const index = keys.findIndex((key, i) => !used.has(i) && hint.test(key));
    if (index >= 0) columns[field] = index;
  }
  return columns;
}

// One delimited line set -> rows of cells. Quotes ("a, b" and "" for a quote) follow CSV rules for any delimiter, so a
// quoted cell may hold the delimiter or a line break.
export function splitRows(text, delimiter) {
  const rows = [];
  let row = [], cell = "", quoted = false, i = 0;
  const source = String(text ?? "").replace(/^﻿/, "");
  while (i < source.length) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell.trim() === "") { quoted = true; cell = ""; i++; continue; }
    if (c === delimiter) { row.push(cell); cell = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
      i += c === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += c; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(value => value.trim() !== ""));
}

// Tab when one of the first lines has one (Excel, a web table, a .tsv; a title line above the header has none), else
// ";" when they have more of them than ",", else ",".
export function detectDelimiter(text) {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).filter(line => line.trim()).slice(0, HEADER_SEARCH);
  if (lines.some(line => line.includes("\t"))) return "\t";
  const head = lines.join("\n");
  const count = ch => head.split(ch).length - 1;
  return count(";") > count(",") ? ";" : ",";
}

const DELIMITERS = ["\t", ";", ","];

// A CSV cell exported with a leading apostrophe (the formula guard of the DCIM exports) reads as its value again.
function cellValue(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
}

const DETAIL_COLUMNS = ["part_number", "name", "model", "type"];

// The index of the header row (a serial column and a details column) among the first rows, or -1.
function findHeader(table) {
  return table.slice(0, HEADER_SEARCH).findIndex(cells => {
    const found = detectColumns(cells);
    return "serial" in found && DETAIL_COLUMNS.some(field => field in found);
  });
}

// Text of a file or a paste -> { rows: [{line, serial, name, part_number, model, type}], columns, problems: [{line, reason}],
// error }. error (a sentence) means nothing can be imported; problems are single rows that were left out.
export function parseDetails(text) {
  // The likely delimiter first; when its split has no header row, the first other delimiter whose split has one.
  const preferred = detectDelimiter(text);
  let table = splitRows(text, preferred), headerAt = findHeader(table);
  for (const delimiter of DELIMITERS) {
    if (headerAt >= 0 || delimiter === preferred) continue;
    const other = splitRows(text, delimiter), at = findHeader(other);
    if (at >= 0) { table = other; headerAt = at; }
  }
  if (!table.length) return { rows: [], columns: {}, problems: [], error: "Paste rows or choose a file first." };
  if (headerAt < 0) {
    const columns = detectColumns(table[0]);
    return { rows: [], columns, problems: [], error: "serial" in columns
      ? "No details column found next to the serial numbers. Add a P/N, Description, Model or Type column."
      : "No serial number column found. The first row must name the columns, for example: SN, P/N, Description." };
  }
  const columns = detectColumns(table[headerAt]);
  const candidates = [], problems = [];
  table.slice(headerAt + 1).forEach((cells, n) => {
    const line = headerAt + n + 2;
    const get = field => field in columns ? cellValue(cells[columns[field]]) : "";
    const row = { line, serial: get("serial"), part_number: get("part_number"), model: get("model"), type: get("type") };
    // A Model column alone is also the product name; with a Name/Description column the model stays the model.
    row.name = Array.from(get("name") || row.model).slice(0, NAME_MAX).join("");
    if (!row.serial) { if (row.part_number || row.name) problems.push({ line, reason: "No serial number" }); return; }
    if (/[\x00-\x1f\x7f]/.test(row.serial + row.part_number + row.model)) { problems.push({ line, reason: "Contains control characters" }); return; }
    if (row.serial.length > SERIAL_MAX) { problems.push({ line, reason: `Serial number longer than ${SERIAL_MAX} characters` }); return; }
    if (row.part_number.length > PART_MAX) { problems.push({ line, reason: `Part number longer than ${PART_MAX} characters` }); return; }
    if (row.model.length > MODEL_MAX) row.model = "";
    if (row.type.length > TYPE_MAX) row.type = "";
    if (!DETAIL_COLUMNS.some(field => row[field])) { problems.push({ line, reason: "No details for this serial number" }); return; }
    candidates.push(row);
  });
  // The same serial twice: identical rows count once; different details leave every row of it out, because which one
  // is right is not known.
  const groups = new Map();
  for (const row of candidates) {
    const key = row.serial.toLowerCase();
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const rows = [];
  for (const group of groups.values()) {
    const [first] = group;
    if (group.every(row => DETAIL_COLUMNS.every(field => row[field] === first[field]))) rows.push(first);
    else for (const row of group) problems.push({ line: row.line, reason: `Serial number ${row.serial} is listed more than once with different details` });
  }
  problems.sort((a, b) => a.line - b.line);
  if (rows.length > MAX_ROWS) return { rows: [], columns, problems, error: `At most ${MAX_ROWS} rows can be imported at once.` };
  if (!rows.length) return { rows: [], columns, problems, error: "No row has both a serial number and details." };
  return { rows, columns, problems, error: "" };
}

// Rows -> the request items: only the values a row carries. Marking units as switches is the request's mark_switch
// option (the server applies it only to units not identified as something else), never a type added to every row.
export function requestItems(rows, { source = "" } = {}) {
  return rows.map(row => {
    const item = { serial: row.serial };
    for (const field of ["name", "part_number", "model", "type"]) if (row[field]) item[field] = row[field];
    if (source) item.source = source;
    return item;
  });
}

// One code per line for pasting into a web form: the serial number, or the barcode of a unit that has none.
export function serialsText(items) {
  return items.map(item => item.serial || item.barcode).filter(Boolean).join("\n");
}

export const COLUMN_LABELS = { serial: "Serial number", part_number: "Part number", name: "Name", model: "Model", type: "Type" };
export const CHANGE_LABELS = { name: "Name", part_number: "Part number", model: "Model", type: "Type", serial_number: "Serial number" };

async function parse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body.detail === "string" ? body.detail
      : Array.isArray(body.detail) ? body.detail.map(e => [e?.loc?.slice(1).join(" "), e?.msg].filter(Boolean).join(": ")).filter(Boolean).join("; ") : "";
    const error = new Error(response.status === 409 && /another session/.test(detail)
      ? "Equipment changed in another session since the preview. Preview again, then apply."
      : detail || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return { data: body, revision: response.headers.get("ETag") };
}

export async function loadSerials() {
  return parse(await fetch("/api/inventory/serials", { cache: "no-store" }));
}

export async function downloadSerialsCsv() {
  const response = await fetch("/api/inventory/serials.csv", { cache: "no-store" });
  if (!response.ok) throw new Error(`Export failed (${response.status}).`);
  return response.blob();
}

// The request body: items plus the options {overwrite, markSwitch}.
export function requestBody(items, { overwrite = false, markSwitch = false } = {}, dryRun = true) {
  return { items, overwrite: Boolean(overwrite), mark_switch: Boolean(markSwitch), dry_run: dryRun };
}

// dry run: the report of what would change, and the revision it describes (apply sends it back as If-Match).
export async function previewDetails(items, options) {
  return parse(await fetch("/api/inventory/serial-details", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(items, options, true)),
  }));
}

export async function applyDetails(items, options, revision) {
  if (!revision) throw new Error("Preview the changes before applying them.");
  return parse(await fetch("/api/inventory/serial-details", {
    method: "POST", headers: { "Content-Type": "application/json", "If-Match": revision },
    body: JSON.stringify(requestBody(items, options, false)),
  }));
}
