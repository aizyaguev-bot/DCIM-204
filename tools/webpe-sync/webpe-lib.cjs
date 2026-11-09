// Shared by the one-shot sync (sync.cjs, sync.cjs --apply) and the automatic lookup (sync.cjs --watch): how a webpe
// SN analysis record becomes DCIM details, and the local memory of which serial numbers were already looked up.
// Pure functions only (plus the state file), so `node --test tools/webpe-sync/webpe-lib.test.cjs` covers them.
const fs = require('fs');
const path = require('path');

// The product's short name: the first part of the description, without "NVIDIA", up to the first spec word, at most 4 words
// ("NVIDIA CHAMELEON SPC5 LIQUID COOLED ETH SWITCH ..." -> "CHAMELEON SPC5"; "CHAMELEON-6S, SPECTRUM-6 ..." -> "CHAMELEON-6S").
const SPEC_WORD = /^(LIQUID|AIR|COOLED|ETH|ETHERNET|SWITCH|W\/|WITH|\d+X?|\d+GBE|\d+VDC|OCP|DC|AC|BUSBAR|NVILINK\d*|NVLINK\d*|MNG|IB|INFINIBAND)$/i;
function productName(d) {
  const words = String(d || '').split(',')[0].trim().split(/\s+/).filter(w => w && !/^NVIDIA$/i.test(w));
  const kept = [];
  for (const w of words) { if (kept.length && SPEC_WORD.test(w)) break; kept.push(w); if (kept.length === 4) break; }
  return kept.join(' ');
}
const webpeType = d => /SWITCH/i.test(d || '') ? 'switch' : null;

// The one-shot sync's rule for a name nobody typed: empty, the unit's own code, a bare type label, or "<type> <code>".
const TYPE_WORDS = /^(unit|switch|nic|cable|pdu|kvm|ups|computer|patch panel|other|transceiver)$/i;
function genericName(item) {
  const name = String(item.name || '').trim(), codes = [item.serial_number, item.barcode, item.id].filter(Boolean).map(c => String(c).trim().toLowerCase());
  if (!name || codes.includes(name.toLowerCase()) || TYPE_WORDS.test(name)) return true;
  const m = /^(\S+(?:\s+panel)?)\s+(.+)$/i.exec(name);
  return !!(m && TYPE_WORDS.test(m[1]) && codes.includes(m[2].toLowerCase()));
}

// The first record webpe returned that has a P/N, or null (webpe answers [] for an unknown SN).
const foundRecord = records => (Array.isArray(records) ? records : []).find(r => r && r.PN) || null;

// One row for POST /api/inventory/serial-details. A field webpe did not show is left out (an empty value never clears
// anything); "type" only when the description itself says SWITCH (mark_switch handles units nobody identified yet).
// webpe text as DCIM stores it: control characters (tabs, line breaks) become spaces, whitespace runs one space.
const tidy = v => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const MODEL_MAX = 120;  // DCIM's model limit (DETAIL_LIMITS); a longer product line is left out rather than refused.
function detailRow(serial, rec, source) {
  const row = { serial: String(serial).trim(), part_number: tidy(rec.PN) };
  const name = tidy(productName(rec.PN_DESCRIPTION));
  if (name) row.name = name;
  const model = tidy(rec.PRODUCT_LINE);
  if (model && model.length <= MODEL_MAX) row.model = model;
  if (webpeType(rec.PN_DESCRIPTION)) row.type = 'switch';
  if (source) row.source = source;
  return row;
}

// ---- automatic lookup: which units to look up, and when to try a serial number again ----
const MINUTE = 60 * 1000;
// found: saved; tried again only when a unit with that SN has no P/N again (re-added, or the P/N was cleared).
// not_found: webpe does not know it (or two DCIM units share it): again after 6 h. rejected: DCIM refused what webpe
// gave for it (an over-long P/N, say): again after 6 h. error: again after 5 min.
const RESULTS = ['found', 'not_found', 'rejected', 'error'];
const RETRY_MS = { found: 10 * MINUTE, not_found: 6 * 60 * MINUTE, rejected: 6 * 60 * MINUTE, error: 5 * MINUTE };
const snKey = sn => String(sn || '').trim().toUpperCase();

function isDue(entry, now) {
  if (!entry) return true;
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return true;
  return now - at >= (RETRY_MS[entry.result] ?? RETRY_MS.error);
}

// Units (GET /api/inventory/serials rows) that have a serial number or barcode and no P/N: [{sn, key}] that are due
// now, and `waiting` = how many such units are not due yet. One entry per serial number.
function candidates(items, state, now) {
  const due = [], seen = new Set();
  let waiting = 0;
  for (const item of items || []) {
    const sn = String(item.serial || item.barcode || '').trim();
    if (!sn || String(item.part_number || '').trim()) continue;
    const key = snKey(sn);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isDue(state.sns[key], now)) due.push({ sn, key }); else waiting++;
  }
  return { due, waiting };
}

function localDate(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function remember(state, key, result, now) { state.sns[key] = { result, at: new Date(now).toISOString() }; }

// Units filled today (the laptop's own date).
function countToday(state, n, now) {
  const today = localDate(now);
  if (state.today?.date !== today) state.today = { date: today, count: 0 };
  state.today.count += n;
}
const lookedUpToday = (state, now) => (state.today?.date === localDate(now) ? state.today.count : 0);

function stateFile(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(require('os').homedir(), '.local', 'share');
  return path.join(base, 'webpe-sync', 'state.json');
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const validEntry = e => isObject(e) && RESULTS.includes(e.result) && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at));

// A hand-edited or half-written file never stops the tool: only well-formed entries are kept (a dropped serial number
// is simply looked up again), anything unreadable starts over.
function loadState(file) {
  const state = { sns: {}, today: null, last_lookup: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(data) && isObject(data.sns)) for (const [key, entry] of Object.entries(data.sns)) if (validEntry(entry)) state.sns[key] = { result: entry.result, at: entry.at };
    if (isObject(data?.today) && typeof data.today.date === 'string' && Number.isInteger(data.today.count) && data.today.count >= 0) state.today = { date: data.today.date, count: data.today.count };
    if (typeof data?.last_lookup === 'string' && Number.isFinite(Date.parse(data.last_lookup))) state.last_lookup = data.last_lookup;
  } catch { /* missing or unreadable: start over */ }
  return state;
}

// Entries older than 30 days (or not well-formed) are dropped; the file is replaced atomically (a temporary file, then rename).
function saveState(file, state, now = Date.now()) {
  for (const [key, entry] of Object.entries(state.sns)) if (!validEntry(entry) || !(now - Date.parse(entry.at) < 30 * 24 * 60 * MINUTE)) delete state.sns[key];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

module.exports = { SPEC_WORD, productName, webpeType, genericName, foundRecord, tidy, detailRow, RETRY_MS, snKey, isDue, candidates,
  remember, countToday, lookedUpToday, localDate, stateFile, loadState, saveState };
