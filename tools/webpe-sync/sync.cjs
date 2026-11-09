// Usage: node tools/webpe-sync/sync.cjs [--apply | --watch]   (needs playwright; see README.md "Sync tool")
// Looks up DCIM units' serial numbers on webpe SN analysis through the owner's signed-in Edge window (CDP, default
// http://127.0.0.1:9333): a DCIM tab (owner's DCIM session) and a webpe tab (owner's NVIDIA SSO). Nothing is signed in
// by this tool and no password, cookie or token is read, printed or stored.
// - no option: dry run over every unit with a serial number; writes sync-dry-run.csv.
// - --apply: the same, then one whole-list save with If-Match.
// - --watch: automatic lookup. Every WEBPE_INTERVAL seconds (default 20) it reads the units, looks up on webpe each unit
//   that has a serial number or barcode and no P/N yet, saves what webpe knows through POST /api/inventory/serial-details
//   (only those units' rows, so a name someone typed is kept by the endpoint's own rule) and reports a heartbeat to
//   PUT /api/inventory/webpe-status, which the site shows. It keeps running through sign-outs and reports them.
// Saved per found serial: part_number = PN, model = PRODUCT_LINE, type = switch (webpe SWITCH description), and the
// Name = the product (first part of PN_DESCRIPTION) when the unit's current name is generic. A name someone typed is kept.
const fs = require('fs');
const path = require('path');
const lib = require('./webpe-lib.cjs');

const VERSION = 'webpe-sync 2.0';
const APPLY = process.argv.includes('--apply');
const WATCH = process.argv.includes('--watch');
const CDP = process.env.WEBPE_CDP || 'http://127.0.0.1:9333';
const WEBPE_ORIGIN = new URL(process.env.WEBPE_ORIGIN || 'https://webpe.nvidia.com').origin;
const SOURCE_AUTO = 'webpe SN analysis (auto)';
const MAX_PER_CYCLE = 25;
// The DCIM address: DCIM_URL, else vm_site in the local (git-ignored) .team/ops/release.local.json.
const localOps = path.join(__dirname, '..', '..', '.team', 'ops', 'release.local.json');
const site = (process.env.DCIM_URL || (fs.existsSync(localOps) ? JSON.parse(fs.readFileSync(localOps, 'utf8')).vm_site || '' : '')).replace(/\/$/, '');
if (!site) { console.error('Set DCIM_URL to the DCIM site address'); process.exit(1); }
const SITE_ORIGIN = new URL(site).origin;
const outDir = process.env.SYNC_REPORT_DIR || process.cwd();
const csv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };
// playwright, or playwright-core (what start-webpe-sync.cmd installs: no browser download).
const playwright = () => { try { return require('playwright'); } catch { return require('playwright-core'); } };
const allPages = browser => browser.contexts().flatMap(c => c.pages());

// ---- run inside the webpe tab: one SN lookup with the owner's webpe session ----
async function webpeLookup(sn) {
  let r;
  try {
    r = await fetch('/rest/rawdata/history/getSnData/v2?SN=' + encodeURIComponent(sn), { credentials: 'include', headers: { Accept: 'application/json' } });
  } catch {
    // A redirect to the SSO sign-in page on another site fails here (it is cross-origin).
    return { kind: 'signin' };
  }
  if (r.status === 401 || r.status === 403 || (r.redirected && new URL(r.url).origin !== location.origin)) return { kind: 'signin' };
  if (r.status !== 200) return { kind: 'error', detail: `webpe answered ${r.status}` };
  if (/html/i.test(r.headers.get('content-type') || '')) return { kind: 'signin' };
  let body;
  try { body = await r.json(); } catch { return { kind: 'signin' }; }
  return Array.isArray(body) ? { kind: 'ok', records: body } : { kind: 'error', detail: 'webpe gave an unexpected answer' };
}

// ---- run inside the DCIM tab, with the owner's DCIM session; the CSRF token never leaves the page ----
async function dcimSerials() {
  const r = await fetch('/api/inventory/serials', { cache: 'no-store' });
  return { status: r.status, items: r.status === 200 ? (await r.json()).items || [] : null };
}

async function dcimSave(rows) {
  const auth = await fetch('/api/auth/status', { cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  const headers = { 'Content-Type': 'application/json' };
  if (auth.csrf_token) headers['X-DCIM-CSRF'] = auth.csrf_token;
  const key = s => String(s || '').trim().toUpperCase();
  for (let attempt = 0; attempt < 2; attempt++) {
    // A fresh read for If-Match, and only the units that still have no P/N (someone may have typed one meanwhile).
    const r = await fetch('/api/inventory/serials', { cache: 'no-store' });
    if (r.status !== 200) return { status: r.status, detail: 'reading the serial numbers' };
    const etag = r.headers.get('ETag');
    const open = new Set(), filled = new Set();
    for (const item of (await r.json()).items || []) for (const code of [item.serial, item.barcode]) if (code) (String(item.part_number || '').trim() ? filled : open).add(key(code));
    const send = rows.filter(row => open.has(key(row.serial)));
    const skipped = rows.filter(row => !open.has(key(row.serial))).map(row => ({ serial: row.serial, status: filled.has(key(row.serial)) ? 'has_part_number' : 'not_found' }));
    if (!send.length) return { status: 200, results: skipped };
    const p = await fetch('/api/inventory/serial-details', { method: 'POST', headers: { ...headers, 'If-Match': etag },
      body: JSON.stringify({ items: send, dry_run: false, mark_switch: true, overwrite: false }) });
    if (p.status === 409 && attempt === 0) continue;
    const body = await p.json().catch(() => null);
    if (p.status !== 200) return { status: p.status, detail: typeof body?.detail === 'string' ? body.detail.slice(0, 200) : '' };
    return { status: 200, results: [...skipped, ...(body.results || []).map(e => ({ serial: e.serial, status: e.status, name: e.unit?.name || '', type: e.unit?.type || '' }))] };
  }
  return { status: 409, detail: 'the inventory kept changing' };
}

async function dcimHeartbeat(body) {
  const auth = await fetch('/api/auth/status', { cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  const headers = { 'Content-Type': 'application/json' };
  if (auth.csrf_token) headers['X-DCIM-CSRF'] = auth.csrf_token;
  const r = await fetch('/api/inventory/webpe-status', { method: 'PUT', headers, body: JSON.stringify(body) });
  return r.status;
}

// ---- automatic lookup ----
async function watch() {
  const { chromium } = playwright();
  const interval = Math.min(3600, Math.max(2, Math.round(Number(process.env.WEBPE_INTERVAL) || 20)));
  const file = lib.stateFile();
  const state = lib.loadState(file);
  let browser = null, lastLine = '';
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const say = line => { if (line !== lastLine) console.log(`${stamp()} ${line}`); lastLine = line; };
  const log = line => { console.log(`${stamp()} ${line}`); lastLine = ''; };
  console.log(`${stamp()} ${VERSION}: automatic lookup every ${interval} s; DCIM ${SITE_ORIGIN}, webpe ${WEBPE_ORIGIN}, Edge ${CDP}. Ctrl+C stops.`);

  async function cycle() {
    if (!browser || !browser.isConnected()) {
      browser = null;
      try { browser = await chromium.connectOverCDP(CDP, { timeout: 5000 }); }
      catch { say(`Waiting for Edge with remote debugging at ${CDP} (start tools/webpe-sync/start-webpe-sync.cmd).`); return; }
    }
    const pages = allPages(browser);
    const dcim = pages.find(p => sameOrigin(p.url(), SITE_ORIGIN));
    if (!dcim) { say(`DCIM sign-in needed: open ${SITE_ORIGIN} in the lab Edge window and sign in.`); return; }
    const webpe = pages.find(p => sameOrigin(p.url(), WEBPE_ORIGIN));
    const now = Date.now();
    const list = await dcim.evaluate(dcimSerials);
    if (list.status === 401) { say('DCIM sign-in needed: sign in to DCIM in the lab Edge window (Operator or Admin).'); return; }
    if (list.status === 403) { say('DCIM refused the serial numbers (403): sign in to DCIM with an Operator or Admin account.'); return; }
    let error = list.status === 200 ? null : `DCIM answered ${list.status}`;
    const { due, waiting } = list.items ? lib.candidates(list.items, state, now) : { due: [], waiting: 0 };
    const batch = due.slice(0, MAX_PER_CYCLE), rows = [];
    let handled = 0;
    const heartbeat = () => ({ last_check: new Date().toISOString(), last_lookup: state.last_lookup, looked_up_today: lib.lookedUpToday(state, now),
      pending: Math.max(0, due.length - handled), last_error: error ? lib.tidy(error).slice(0, 200) : null, version: VERSION, interval });
    // A long check (a backlog of units, a slow webpe) still reports at least once per interval, so the site keeps
    // showing Active while the lookups run. A report that fails here is retried by the one at the end of the check.
    let lastBeat = Date.now();
    const beatIfDue = async () => {
      if (Date.now() - lastBeat < interval * 1000) return;
      lastBeat = Date.now();
      await dcim.evaluate(dcimHeartbeat, heartbeat()).catch(() => {});
    };
    if (!webpe) error = 'webpe sign-in needed: open webpe SN analysis in the lab Edge window and sign in';
    else for (const c of batch) {
      await beatIfDue();
      const res = await webpe.evaluate(webpeLookup, c.sn);
      if (res.kind === 'signin') { error = 'webpe sign-in needed: sign in to webpe in the lab Edge window'; break; }
      handled++;
      state.last_lookup = new Date().toISOString();
      if (res.kind === 'error') { lib.remember(state, c.key, 'error', now); error = res.detail; log(`${c.sn}: ${res.detail}; tried again in 5 minutes`); continue; }
      const rec = lib.foundRecord(res.records);
      if (!rec) { lib.remember(state, c.key, 'not_found', now); log(`${c.sn}: not found on webpe; tried again in 6 hours`); continue; }
      rows.push({ c, row: lib.detailRow(c.sn, rec, SOURCE_AUTO) });
    }
    if (rows.length) {
      await beatIfDue();
      let saved = await dcim.evaluate(dcimSave, rows.map(r => r.row));
      if (saved.status === 422 && rows.length > 1) {
        // DCIM refused one of the rows (something webpe gave that DCIM does not accept): save them one by one, so the
        // other units are still filled and only the refused one waits.
        const results = [];
        for (const { row } of rows) {
          await beatIfDue();
          const one = await dcim.evaluate(dcimSave, [row]);
          if (one.status === 200) results.push(...one.results);
          else if (one.status === 422) results.push({ serial: row.serial, status: 'rejected', detail: one.detail });
          else { saved = one; break; }
          saved = { status: 200, results };
        }
      }
      if (saved.status === 422) saved = { status: 200, results: [{ serial: rows[0].row.serial, status: 'rejected', detail: saved.detail }] };
      if (saved.status === 200) {
        const bySerial = new Map(saved.results.map(e => [lib.snKey(e.serial), e]));
        let filled = 0;
        for (const { c, row } of rows) {
          const e = bySerial.get(c.key) || { status: 'not_found' };
          if (e.status === 'updated' || e.status === 'unchanged' || e.status === 'has_part_number') {
            lib.remember(state, c.key, 'found', now);
            if (e.status === 'updated') { filled++; log(`${c.sn}: saved ${row.part_number}${e.name ? ` · ${e.name}` : ''}${e.type ? ` · ${e.type}` : ''}`); }
          } else if (e.status === 'rejected') {
            lib.remember(state, c.key, 'rejected', now);
            error = `DCIM refused the webpe details of ${c.sn}${e.detail ? `: ${e.detail}` : ''}`;
            log(`${error}; tried again in 6 hours`);
          } else {
            // not_found (the unit was removed meanwhile) or ambiguous (two DCIM units share this SN): try again in 6 h.
            lib.remember(state, c.key, 'not_found', now);
            log(`${c.sn}: found on webpe but not saved (${e.status === 'ambiguous' ? 'two DCIM units have this serial number' : 'the unit is gone'})`);
          }
        }
        lib.countToday(state, filled, now);
      } else {
        for (const { c } of rows) lib.remember(state, c.key, 'error', now);
        error = saved.status === 401 ? 'DCIM sign-in needed' : `DCIM did not save the details (${saved.status}${saved.detail ? `: ${saved.detail}` : ''})`;
        log(error);
      }
    }
    // The status report goes out even if the local state file cannot be written (a full disk, say).
    let stateProblem = null;
    try { lib.saveState(file, state, now); } catch (e) { stateProblem = `cannot write ${file}: ${String(e?.message || e).split('\n')[0].slice(0, 100)}`; }
    if (stateProblem && !error) error = stateProblem;
    const report = heartbeat();
    const sent = await dcim.evaluate(dcimHeartbeat, report);
    if (sent === 401) { say('DCIM sign-in needed: sign in to DCIM in the lab Edge window (Operator or Admin).'); return; }
    if (sent !== 200) { say(`DCIM did not take the status report (${sent}): sign in with an Operator or Admin account.`); return; }
    say(error ? `Problem: ${error}` : `Running: ${report.pending} waiting, ${waiting} looked up recently, ${report.looked_up_today} filled today.`);
  }

  for (;;) {
    const started = Date.now();
    try { await cycle(); }
    catch (e) {
      const message = String(e?.message || e).split('\n')[0].slice(0, 200);
      // A tab that reloads or closes during a check: the next check finds the tabs again.
      say(/context was destroyed|has been closed|navigat/i.test(message) ? 'A DCIM or webpe tab was reloading; checking again.' : `Problem: ${message}; trying again.`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(1000, interval * 1000 - (Date.now() - started))));
  }
}

// ---- one-shot sync (dry run / --apply) ----
async function oneShot() {
  const { chromium } = playwright();
  const b = await chromium.connectOverCDP(CDP);
  const pages = allPages(b);
  const dcim = pages.find(x => sameOrigin(x.url(), SITE_ORIGIN)), webpe = pages.find(x => sameOrigin(x.url(), WEBPE_ORIGIN));
  if (!dcim || !webpe) throw new Error('Need both tabs open in the signed-in Edge window: DCIM and webpe');
  const got = await dcim.evaluate(async () => { const r = await fetch('/api/rack-items'); return { status: r.status, etag: r.headers.get('etag'), data: r.status === 200 ? await r.json() : null }; });
  if (got.status !== 200) throw new Error(`DCIM answered ${got.status}: sign in to DCIM in that Edge window`);
  const units = Object.entries(got.data).flatMap(([rack, list]) => list.map(item => ({ rack, item })));
  const withSn = units.filter(u => (u.item.serial_number || u.item.barcode));
  console.log(`DCIM: ${units.length} units, ${withSn.length} with a serial number or barcode`);
  const report = [['rack', 'unit id', 'serial', 'found', 'name before', 'name after', 'P/N before', 'P/N after', 'model after', 'type before', 'type after', 'description']];
  let changed = 0;
  for (const { rack, item } of withSn) {
    const sn = String(item.serial_number || item.barcode).trim();
    const res = await webpe.evaluate(webpeLookup, sn);
    if (res.kind === 'signin') throw new Error('webpe: signed out of webpe? Sign in to webpe in that Edge window');
    if (res.kind === 'error') throw new Error(`webpe: ${res.detail}`);
    const rec = lib.foundRecord(res.records);
    if (!rec) { report.push([rack, item.id, sn, 'no', item.name, '', item.part_number || '', '', '', item.type || '', '', '']); continue; }
    const before = { name: item.name, pn: item.part_number || '', type: item.type || '' };
    const row = lib.detailRow(sn, rec);
    if (lib.genericName(item) && row.name) item.name = row.name;
    item.part_number = row.part_number;
    if (row.model) item.model = row.model;
    if (row.type) item.type = 'switch';
    if (!item.serial_number && item.barcode) item.serial_number = item.barcode;
    if (item.name !== before.name || item.part_number !== before.pn || item.type !== before.type) changed++;
    report.push([rack, item.id, sn, 'yes', before.name, item.name, before.pn, item.part_number, item.model || '', before.type, item.type, rec.PN_DESCRIPTION || '']);
    console.log(`${sn}: ${before.name} -> ${item.name} | ${item.part_number} | ${item.type}`);
  }
  const file = path.join(outDir, `sync-${APPLY ? 'applied' : 'dry-run'}.csv`);
  fs.writeFileSync(file, '﻿' + report.map(r => r.map(csv).join(',')).join('\r\n') + '\r\n');
  console.log(`found in webpe: ${report.filter(r => r[3] === 'yes').length}/${withSn.length}, units to change: ${changed}; report ${file}`);
  if (APPLY && changed) {
    const put = await dcim.evaluate(async ({ data, etag }) => {
      const auth = await fetch('/api/auth/status', { cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
      const headers = { 'Content-Type': 'application/json', 'If-Match': etag };
      if (auth.csrf_token) headers['X-DCIM-CSRF'] = auth.csrf_token;
      const r = await fetch('/api/rack-items', { method: 'PUT', headers, body: JSON.stringify(data) });
      return { status: r.status, text: (await r.text()).slice(0, 300) };
    }, { data: got.data, etag: got.etag });
    console.log('saved:', put.status, put.status === 200 ? 'OK' : put.text);
  }
  await b.close().catch(() => {});
}

(WATCH ? watch() : oneShot()).catch(e => { console.error('STOPPED:', e.message); process.exit(1); });
