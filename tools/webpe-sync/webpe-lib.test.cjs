// node --test tools/webpe-sync/webpe-lib.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./webpe-lib.cjs');

test('the product name is the start of the webpe description', () => {
  assert.equal(lib.productName('NVIDIA CHAMELEON SPC5 LIQUID COOLED ETH SWITCH 64X800G'), 'CHAMELEON SPC5');
  assert.equal(lib.productName('CHAMELEON-6S, SPECTRUM-6 102.4T'), 'CHAMELEON-6S');
  assert.equal(lib.productName(''), '');
  assert.equal(lib.webpeType('... ETH SWITCH ...'), 'switch');
  assert.equal(lib.webpeType('ConnectX-7 adapter'), null);
});

test('a webpe record becomes one serial-details row; missing fields are left out', () => {
  const rec = { PN: ' 920-9N42F-00RI-7C0 ', PN_DESCRIPTION: 'NVIDIA CHAMELEON SPC5 LIQUID COOLED ETH SWITCH', PRODUCT_LINE: 'SPECTRUM-5' };
  assert.deepEqual(lib.detailRow(' MT1 ', rec, 'webpe SN analysis (auto)'),
    { serial: 'MT1', part_number: '920-9N42F-00RI-7C0', name: 'CHAMELEON SPC5', model: 'SPECTRUM-5', type: 'switch', source: 'webpe SN analysis (auto)' });
  assert.deepEqual(lib.detailRow('MT2', { PN: 'MCX75310', PN_DESCRIPTION: 'ConnectX-7 adapter card' }),
    { serial: 'MT2', part_number: 'MCX75310', name: 'ConnectX-7 adapter card' });
  assert.equal(lib.foundRecord([{ SN: 'x' }, { PN: 'P1' }]).PN, 'P1');
  assert.equal(lib.foundRecord([]), null);
});

test('only units with a code and no P/N are looked up, and each result waits its own time', () => {
  const now = Date.parse('2026-11-09T10:00:00Z');
  const ago = ms => new Date(now - ms).toISOString();
  const state = { sns: {
    FOUND: { result: 'found', at: ago(60e3) }, NF: { result: 'not_found', at: ago(5 * 3600e3) }, NF_OLD: { result: 'not_found', at: ago(7 * 3600e3) },
    ERR: { result: 'error', at: ago(4 * 60e3) }, ERR_OLD: { result: 'error', at: ago(6 * 60e3) } } };
  const items = [
    { serial: 'new1', part_number: '' }, { serial: 'NEW1', part_number: '' }, { serial: '', barcode: 'bc2' }, { serial: 'has', part_number: 'P' },
    { serial: '', barcode: '' }, { serial: 'found' }, { serial: 'nf' }, { serial: 'nf_old' }, { serial: 'err' }, { serial: 'err_old' }, { serial: 'Portia tray' }, { serial: '', barcode: 'two words' }];
  const { due, waiting } = lib.candidates(items, state, now);
  assert.deepEqual(due.map(c => c.key), ['NEW1', 'BC2', 'NF_OLD', 'ERR_OLD']);
  assert.equal(waiting, 3);
});

test('the state file survives a restart and counts today only', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpe-lib-')), 'sub', 'state.json');
  const now = Date.now();
  const state = lib.loadState(file);
  assert.deepEqual(state.sns, {});
  lib.remember(state, 'A', 'found', now);
  lib.remember(state, 'OLD', 'not_found', now - 40 * 24 * 3600e3);
  lib.countToday(state, 2, now); lib.countToday(state, 1, now);
  lib.saveState(file, state, now);
  const back = lib.loadState(file);
  assert.deepEqual(Object.keys(back.sns), ['A']);
  assert.equal(lib.lookedUpToday(back, now), 3);
  assert.equal(lib.lookedUpToday(back, now + 2 * 24 * 3600e3), 0);
  assert.equal(lib.stateFile({ LOCALAPPDATA: 'C:\\L' }), path.join('C:\\L', 'webpe-sync', 'state.json'));
});
test('a broken state file never stops the tool: bad entries are dropped, the rest is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpe-lib-'));
  const file = path.join(dir, 'state.json');
  const at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ sns: { A: null, B: 'x', C: { result: 'found' }, D: { result: 'odd', at }, E: [], OK: { result: 'not_found', at } },
    today: { date: 5, count: 'x' }, last_lookup: {} }));
  const state = lib.loadState(file);
  assert.deepEqual(Object.keys(state.sns), ['OK']);
  assert.equal(state.today, null);
  assert.equal(state.last_lookup, null);
  state.sns.LATER = null;
  lib.saveState(file, state);
  assert.deepEqual(Object.keys(lib.loadState(file).sns), ['OK']);
  fs.writeFileSync(file, '{"sns": {"A": ');
  assert.deepEqual(lib.loadState(file).sns, {});
  assert.equal(lib.isDue({ result: 'rejected', at: new Date(Date.now() - 3600e3).toISOString() }, Date.now()), false);
});

test('webpe text is cleaned for DCIM; a product line DCIM cannot store is left out', () => {
  const row = lib.detailRow('MT3', { PN: ' 920-\tX1\n', PN_DESCRIPTION: 'NVIDIA QM9700\u0007 SWITCH', PRODUCT_LINE: 'L'.repeat(121) });
  assert.deepEqual(row, { serial: 'MT3', part_number: '920- X1', name: 'QM9700', type: 'switch' });
  assert.equal(lib.detailRow('MT4', { PN: 'P', PRODUCT_LINE: 'L'.repeat(120) }).model.length, 120);
});
