// Device name sync end to end: site port names -> PDU/KVM, with the real backend and in-memory fake devices.
// Fixture: DCIM_TEST_ACCOUNTS=1 DCIM_FAKE_NAME_DEVICES=1 python tests/browser/preview-server.py 8840
// No real device is ever contacted; the fake devices are switched through the fixture-only /__fixture/name-devices.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8840';
const MARKER = 'LOCAL PREVIEW - TEST DATA';
const PASSWORD = 'test-password-123';
const UNREACHABLE = 'Device unreachable — retry later';
const BAD_CHARS = 'Name has characters the device cannot store';
const TOO_LONG = 'Name is too long for this device (max 64)';
const OTHER_SETTINGS = 'Other outlet settings changed during the write — check the PDU';
const KVM_UNSUPPORTED = 'Port names cannot be written to this KVM yet';

(async () => {
  const url = new URL(origin);
  assert.equal(url.hostname, '127.0.0.1', 'Use the isolated local fixture only');
  assert.notEqual(url.port, '8000', 'Never use port 8000');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unsafe = [], observed = {};
  const fixture = (method, route, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(origin + route, { method, headers: data ? { 'Content-Type': 'application/json' } : {} }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${route}: HTTP ${res.statusCode} ${text}`));
        if (!/json/.test(res.headers['content-type'] || '')) return reject(new Error('No fake name devices: start the fixture with DCIM_TEST_ACCOUNTS=1 DCIM_FAKE_NAME_DEVICES=1'));
        resolve(JSON.parse(text));
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const device = async id => (await fixture('GET', '/__fixture/name-devices'))[id];
  const setDevice = (id, body) => fixture('POST', '/__fixture/name-devices/' + id, body);
  async function until(fn, message, timeout = 15000) {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 150)); }
    throw new Error(`Timed out: ${message} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
  }

  async function login(username, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${username}: ${e.message}`));
    context.on('request', r => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method())) unsafe.push(`${username} ${r.method()} ${new URL(r.url()).pathname}`); });
    await page.goto(origin + '/?tab=power');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('region', { name: 'PDU 01' }).waitFor();
    assert.equal((await (await context.request.get(origin + '/api/version')).json()).version, MARKER, 'Refuse any real lab environment');
    return { context, page };
  }
  async function openPdu(page, name = 'PDU 01') {
    await page.goto(origin + '/?tab=power');
    await page.getByRole('region', { name }).getByRole('button', { name: 'Details →' }).click();
    await page.getByText('Device names', { exact: true }).first().waitFor();
    await page.locator('main div.rounded-lg.border').first().waitFor();
  }
  const panel = page => page.locator('div[aria-busy]').filter({ hasText: 'Device names' });
  const outletCard = (page, n) => page.locator('main div.rounded-lg.border').filter({ has: page.locator('div.w-8', { hasText: new RegExp(`^${n}$`) }) });
  const outletBadge = async (page, n) => {
    const badge = outletCard(page, n).locator('span.sr-only', { hasText: 'Name on device' });
    return (await badge.count()) ? (await badge.first().textContent()) : '';
  };
  const row = (page, port) => panel(page).locator('tbody tr').nth(port - 1);
  const rowCells = async (page, port) => {
    const cells = (await row(page, port).locator('td').allInnerTexts()).map(t => t.trim());
    return { site: cells[2], device: cells[3], state: cells[4] };
  };
  async function compare(page) {
    const button = panel(page).getByRole('button', { name: /^(Compare with device|Compare again)$/ });
    const response = page.waitForResponse(r => /\/api\/devices\/[^/]+\/device-names$/.test(new URL(r.url()).pathname));
    await button.click();
    const answer = await response;
    await until(async () => !(await panel(page).getByText(/^Reading names from /).count()), 'compare finished');
    return answer;
  }
  async function saveLabels(page, changes) {
    await page.getByRole('button', { name: 'Edit Labels' }).click();
    for (const [n, value] of Object.entries(changes)) await page.getByLabel(`Label for outlet ${n}`, { exact: true }).fill(value);
    const saved = page.waitForResponse(r => /\/api\/devices\/[^/]+\/labels$/.test(new URL(r.url()).pathname) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await saved;
    assert.equal(response.status(), 200, 'label save');
    return response.json();
  }
  async function confirmAndWrite(page, lines) {
    const p = panel(page);
    await p.getByRole('button', { name: /^Write \d+ names? to device$/ }).click();
    const group = page.getByRole('group', { name: /^Write \d+ names? to PDU 01\?$/ });
    await group.waitFor();
    assert.deepEqual((await group.locator('li').allInnerTexts()).map(t => t.trim()), lines, 'confirm lists old -> new');
    await group.getByText('Only the names change. Power and every other device setting stay as they are.').waitFor();
    const pushed = page.waitForResponse(r => /\/device-names\/push$/.test(new URL(r.url()).pathname));
    await group.getByRole('button', { name: /^Write \d+ names? to device$/ }).click();
    return pushed;
  }
  const retrySummary = page => panel(page).getByRole('button', { name: /^Compare with the device, then retry \d+ failed names?$/ });
  async function selectOnly(page, ports) {
    for (const box of await panel(page).locator('tbody input[type="checkbox"]').all()) {
      const port = (await box.getAttribute('aria-label')).match(/^Write outlet (\d+):/)[1];
      if ((await box.isChecked()) !== ports.includes(Number(port))) await box.click();
    }
  }
  const saveNoticeText = page => until(async () => {
    const notice = page.getByText(/^(Sent to device|Not sent to device(: .+)?|Not sent: .+)$/);
    return (await notice.count()) && (await notice.first().innerText()).trim();
  }, 'save notice');
  const statusRows = async (page, id) => page.evaluate(async id => (await (await fetch('/api/devices/name-sync/status?device_id=' + id)).json()).devices[id], id);
  const cards = page => panel(page).locator('ul[aria-label^="Site names compared"] > li');
  const results = async page => (await panel(page).locator('div[aria-live="polite"] li').allInnerTexts()).map(t => t.trim());

  try {
    // Preconditions: the fake devices exist (DCIM_FAKE_NAME_DEVICES=1) and auto mode is on.
    const start = await fixture('GET', '/__fixture/name-devices');
    assert.deepEqual(start.pdu1.names, { 1: 'OPT11', 2: 'OPT12', 3: 'OPT13', 4: 'OPT14' }, 'Restart the fixture before this check');
    assert.equal(start.kvm1.kind, 'kvm');

    // ── Operator: label save -> automatic write, pending -> synced ───────────────────────────────────────────
    const op = await login('operator');
    const page = op.page;
    await openPdu(page);
    await panel(page).getByText('Saved names are written to the device automatically.').waitFor();
    await setDevice('pdu1', { delay: 3, clear_log: true });   // slow enough to see "pending" in the page
    const save1 = await saveLabels(page, { 2: 'optn-qa-2' });
    assert.equal(save1.device_names, 'queued');
    await page.getByText('Sent to device', { exact: true }).waitFor();
    await until(async () => (await outletBadge(page, 2)) === 'Name on device: writing…', 'outlet 2 badge pending');
    await until(async () => (await outletBadge(page, 2)) === 'Name on device: synced', 'outlet 2 badge synced', 20000);
    assert.equal(await outletCard(page, 2).getByText('optn-qa-2', { exact: true }).count(), 1);
    let pdu1 = await device('pdu1');
    assert.deepEqual(pdu1.writes, [[2, 'optn-qa-2']], 'exactly the changed outlet was written');
    assert.equal(pdu1.names[2], 'optn-qa-2');
    checks.push('Operator label save: "Sent to device", badge pending -> synced, only that outlet written');
    await setDevice('pdu1', { delay: 0.2 });

    await compare(page);
    assert.deepEqual(await rowCells(page, 2), { site: 'optn-qa-2', device: 'optn-qa-2', state: 'In sync' });
    await panel(page).getByText('Nothing differs: every name on the device matches the site.').waitFor();
    assert.equal(await panel(page).getByRole('button', { name: /^Write \d+ names? to device$/ }).count(), 0, 'nothing to write');
    checks.push('Compare: saved name in_sync on the device, no write button');

    // ── Name changed on the device behind the site's back -> differs -> select -> confirm -> write ──────────
    await setDevice('pdu1', { names: { 3: 'renamed-on-device' }, clear_log: true });
    await compare(page);
    assert.deepEqual(await rowCells(page, 3), { site: 'OPT13', device: 'renamed-on-device', state: 'Differs' });
    const box3 = row(page, 3).getByRole('checkbox');
    assert.equal(await box3.isChecked(), true, 'a differing port is pre-selected');
    await box3.uncheck();
    assert.equal(await panel(page).getByRole('button', { name: 'Write 0 names to device' }).isDisabled(), true);
    await box3.check();
    assert.equal(await row(page, 1).getByRole('checkbox').count(), 0, 'no checkbox for an in-sync port');
    const push1 = await confirmAndWrite(page, ['Outlet 3: renamed-on-device → OPT13']);
    assert.deepEqual(push1.request().postDataJSON(), { ports: ['3'], expected: { 3: 'OPT13' } }, 'explicit ports + expected');
    assert.equal(push1.status(), 200);
    await panel(page).getByText('1 written.', { exact: true }).waitFor();
    assert.deepEqual(await results(page), ['Outlet 3: written (OPT13)']);
    assert.equal((await rowCells(page, 3)).state, 'In sync');
    pdu1 = await device('pdu1');
    assert.deepEqual(pdu1.writes, [[3, 'OPT13']]);
    await until(async () => (await outletBadge(page, 3)) === 'Name on device: synced', 'outlet 3 badge synced');
    checks.push('Device-side rename: compare differs -> select -> confirm "renamed-on-device → OPT13" -> written and synced');

    // ── Clear a label -> the PDU's own default name ("") ───────────────────────────────────────────────────
    await setDevice('pdu1', { clear_log: true });
    const save2 = await saveLabels(page, { 4: '' });
    assert.equal(save2.device_names, 'queued');
    await until(async () => (await outletBadge(page, 4)) === 'Name on device: synced', 'outlet 4 badge synced');
    pdu1 = await device('pdu1');
    assert.deepEqual(pdu1.writes, [[4, '']], 'a cleared label writes "" (device default)');
    assert.equal(await outletCard(page, 4).getByText('Outlet 4', { exact: true }).count(), 1);
    await compare(page);
    assert.deepEqual(await rowCells(page, 4), { site: 'Outlet 4 (device default)', device: 'device default', state: 'In sync' });
    checks.push('Cleared label: "" written, compare shows device default in sync');

    // ── Names the PDU cannot store: refused before any write ─────────────────────────────────────────────────
    await setDevice('pdu1', { clear_log: true });
    const save3 = await saveLabels(page, { 1: "O'Brien-01", 2: 'x'.repeat(65) });
    assert.deepEqual([save3.device_names, save3.device_names_reason], ['not_sent', BAD_CHARS], 'nothing is queued');
    assert.equal(await saveNoticeText(page), `Not sent to device: ${BAD_CHARS}`);
    await until(async () => (await outletBadge(page, 1)) === `Name on device: failed — ${BAD_CHARS}`, 'outlet 1 failed (apostrophe)');
    await until(async () => (await outletBadge(page, 2)) === `Name on device: failed — ${TOO_LONG}`, 'outlet 2 failed (65 chars)');
    pdu1 = await device('pdu1');
    assert.deepEqual([pdu1.writes, pdu1.refused], [[], []], 'nothing reached the device');
    assert.deepEqual([pdu1.names[1], pdu1.names[2]], ['OPT11', 'optn-qa-2']);
    await panel(page).getByText('Names on device: 2 synced, 2 failed', { exact: true }).waitFor();
    assert.equal(await retrySummary(page).isVisible(), true, 'summary Retry');
    await compare(page);
    assert.equal((await rowCells(page, 1)).state, 'Not writable');
    assert.equal(await row(page, 1).getByRole('checkbox').count(), 0, 'a refused name is never selectable');
    // The same names again: the device already stores them, so the ports sync without a write.
    const save4 = await saveLabels(page, { 1: 'OPT11', 2: 'optn-qa-2' });
    assert.equal(save4.device_names, 'queued');
    await until(async () => (await outletBadge(page, 1)) === 'Name on device: synced' && (await outletBadge(page, 2)) === 'Name on device: synced', 'outlets 1-2 synced again');
    assert.deepEqual((await device('pdu1')).writes, [], 'a name the device already has is not rewritten');
    checks.push('Apostrophe / 65 characters: "Not sent to device: <reason>", failed with the fixed reason, nothing written; unchanged names sync without a write');

    // ── Other outlet settings changed during the write: the batch stops ─────────────────────────────────────
    await setDevice('pdu1', { names: { 1: 'dev-a', 4: 'dev-b' }, mode: 'settings_changed', clear_log: true });
    await compare(page);
    assert.deepEqual([(await rowCells(page, 1)).state, (await rowCells(page, 4)).state], ['Differs', 'Differs']);
    const push2 = await confirmAndWrite(page, ['Outlet 1: dev-a → OPT11', 'Outlet 4: dev-b → device default']);
    assert.equal(push2.status(), 200);
    await panel(page).getByText('2 failed.', { exact: true }).waitFor();
    assert.deepEqual(await results(page), [`Outlet 1: failed — ${OTHER_SETTINGS}`, `Outlet 4: failed — ${OTHER_SETTINGS}`]);
    assert.deepEqual((await device('pdu1')).writes, [[1, 'OPT11']], 'the batch stopped after the first outlet');
    await panel(page).getByRole('button', { name: 'Retry failed (2)' }).waitFor();
    checks.push('Settings changed during a write: fixed reason, remaining outlets not written');

    // ── Unreachable device: failed with the fixed reason, no crash; then Retry once it is back ─────────────
    await setDevice('pdu1', { mode: 'ok', names: { 3: 'off-site-name' }, clear_log: true });
    await compare(page);
    assert.equal((await rowCells(page, 3)).state, 'Differs');
    await selectOnly(page, [3]);
    await setDevice('pdu1', { mode: 'unreachable' });
    const push3 = await confirmAndWrite(page, ['Outlet 3: off-site-name → OPT13']);
    assert.equal(push3.status(), 200);
    assert.deepEqual(await results(page), [`Outlet 3: failed — ${UNREACHABLE}`]);
    await panel(page).getByRole('button', { name: 'Retry failed (1)' }).waitFor();
    await compare(page);
    await panel(page).getByText(`Cannot reach device: ${UNREACHABLE}`, { exact: true }).waitFor();
    const save5 = await saveLabels(page, { 2: 'optn-qa-2u' });
    assert.equal(save5.device_names, 'queued');
    await until(async () => (await outletBadge(page, 2)) === `Name on device: failed — ${UNREACHABLE}`, 'auto write to unreachable PDU failed');
    pdu1 = await device('pdu1');
    assert.deepEqual([pdu1.writes, pdu1.names[3], pdu1.names[2]], [[], 'off-site-name', 'optn-qa-2']);
    await setDevice('pdu1', { mode: 'ok' });
    await retrySummary(page).click();   // compare, select the failed ports that still differ, confirm step
    const group = page.getByRole('group', { name: /^Write \d+ names? to PDU 01\?$/ });
    await group.waitFor();
    // Outlet 1 failed earlier but the device already stores OPT11 (in sync), so it is not offered again.
    assert.deepEqual((await group.locator('li').allInnerTexts()).map(t => t.trim()),
      ['Outlet 2: optn-qa-2 → optn-qa-2u', 'Outlet 3: off-site-name → OPT13', 'Outlet 4: dev-b → device default']);
    const push4 = page.waitForResponse(r => /\/device-names\/push$/.test(new URL(r.url()).pathname));
    await group.getByRole('button', { name: /^Write \d+ names? to device$/ }).click();
    assert.equal((await push4).status(), 200);
    await panel(page).getByText('3 written.', { exact: true }).waitFor();
    assert.deepEqual((await device('pdu1')).names, { 1: 'OPT11', 2: 'optn-qa-2u', 3: 'OPT13', 4: '' });
    const rowsAfterRetry = await until(async () => {
      const rows = await statusRows(page, 'pdu1');
      return Object.values(rows).every(r => r.status === 'synced') && rows;
    }, 'every pdu1 status row synced after Retry');
    observed.summaryAfterRetry = await until(async () => {
      const text = (await panel(page).getByText(/^Names on device:/).first().innerText()).trim();
      return text === `Names on device: ${Object.keys(rowsAfterRetry).length} synced` && text;
    }, 'summary matches the status rows');
    checks.push('Unreachable: panel write and automatic write fail with the fixed reason, compare shows it; summary Retry writes after recovery');

    // ── Stale expected: the site name changed after the compare -> 409 -> "Names changed — review again." ──
    await setDevice('pdu1', { names: { 2: 'stale-device-name' }, clear_log: true });
    await compare(page);
    assert.deepEqual(await rowCells(page, 2), { site: 'optn-qa-2u', device: 'stale-device-name', state: 'Differs' });
    const other = await op.context.newPage();   // another tab of the same Operator saves a new label meanwhile
    await other.goto(origin + '/?tab=power');
    await other.getByRole('region', { name: 'PDU 01' }).waitFor();
    const patched = await other.evaluate(async () => {
      const dev = (await (await fetch('/api/devices/')).json()).find(d => d.id === 'pdu1');
      const res = await fetch('/api/devices/pdu1/labels', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...dev.labels, 2: 'optn-qa-2-new' }) });
      return { status: res.status, body: await res.json() };
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.device_names, 'queued');
    await other.close();
    const push5 = await confirmAndWrite(page, ['Outlet 2: stale-device-name → optn-qa-2u']);
    assert.equal(push5.status(), 409, 'stale expected is refused');
    await panel(page).getByText('Names changed — review again.', { exact: true }).waitFor();
    await until(async () => (await rowCells(page, 2)).site === 'optn-qa-2-new', 'compare re-run with the new site name');
    await until(async () => (await device('pdu1')).names[2] === 'optn-qa-2-new', 'the other tab\'s save was written');
    assert.ok(!(await device('pdu1')).writes.some(([, n]) => n === 'optn-qa-2u'), 'the stale name was never written');
    checks.push('Stale expected: 409 -> "Names changed — review again." and a fresh compare; the stale name is never written');

    // ── Two quick saves of one outlet while the first write is still running: the later name wins ──────────
    await setDevice('pdu1', { delay: 1.5, clear_log: true });
    const race = await page.evaluate(async () => {
      const labels = (await (await fetch('/api/devices/')).json()).find(d => d.id === 'pdu1').labels;
      const patch = async value => (await fetch('/api/devices/pdu1/labels', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...labels, 3: value }) })).json();
      const first = await patch('race-a');
      await new Promise(r => setTimeout(r, 300));   // the first write is now in progress on the device
      const second = await patch('race-b');
      return [first.device_names, second.device_names];
    });
    assert.deepEqual(race, ['queued', 'queued']);
    const settled = await until(async () => {
      const rows = await page.evaluate(async () => (await (await fetch('/api/devices/name-sync/status?device_id=pdu1')).json()).devices.pdu1);
      return rows['3'].status !== 'pending' && rows['3'];
    }, 'outlet 3 settled after two quick saves', 20000);
    assert.deepEqual([settled.status, settled.desired, (await device('pdu1')).names[3]], ['synced', 'race-b', 'race-b']);
    observed.raceWrites = (await device('pdu1')).writes;
    assert.deepEqual(observed.raceWrites.at(-1), [3, 'race-b'], 'the later save is the last write');
    await setDevice('pdu1', { delay: 0.2 });
    checks.push('Two quick saves during a running write: the later name is written last and recorded as synced');

    // ── KVM: no recognised rename method -> not supported, no write button ─────────────────────────────────
    await page.goto(origin + '/?tab=consoles');
    await page.getByRole('button', { name: 'Details →' }).click();
    await page.getByText('Device names', { exact: true }).first().waitFor();
    await compare(page);
    await panel(page).getByText(KVM_UNSUPPORTED, { exact: true }).waitFor();
    const kvmStates = await panel(page).locator('tbody tr td:nth-child(5)').allInnerTexts();
    assert.ok(kvmStates.length >= 4 && kvmStates.every(s => s.trim() === 'Not writable'), 'every KVM port is not writable');
    assert.equal(await panel(page).getByRole('checkbox').count(), 0);
    assert.equal(await panel(page).getByRole('button', { name: /^Write \d+ names? to device$/ }).count(), 0);
    assert.deepEqual((await device('kvm1')).refused, [], 'no write was attempted on the KVM');
    checks.push('KVM: "Port names cannot be written to this KVM yet", every port not writable, no write button');
    // A KVM label save: the port is recorded as not written (no rename method), nothing is attempted on the KVM.
    await page.getByRole('button', { name: 'Edit Labels' }).click();
    await page.getByLabel('Label for port 2', { exact: true }).fill('kvm-qa-2');
    const kvmSaved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/devices/kvm1/labels');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal((await kvmSaved).status(), 200);
    const kvmBody = await (await kvmSaved).json();
    assert.deepEqual([kvmBody.device_names, kvmBody.device_names_reason], ['not_sent', KVM_UNSUPPORTED]);
    assert.equal(await saveNoticeText(page), `Not sent to device: ${KVM_UNSUPPORTED}`);
    const kvmCard = page.getByRole('button', { name: /kvm-qa-2/ });
    await until(async () => (await kvmCard.locator('span.sr-only', { hasText: 'Name on device' }).first().textContent().catch(() => '')) ===
      `Name on device: not written — ${KVM_UNSUPPORTED}`, 'KVM port 2 badge: not written');
    assert.deepEqual((await device('kvm1')).refused, [], 'still no write attempted on the KVM');
    checks.push('KVM label save: "Not sent to device: Port names cannot be written to this KVM yet", badge not written, no write attempted');
    await op.context.close();

    // ── Viewer: badges and summary only; the panel actions and the API are refused ────────────────────────
    const viewer = await login('viewer');
    await openPdu(viewer.page);
    await viewer.page.getByText(/^Names on device: \d+ synced/).waitFor();
    assert.equal(await viewer.page.locator('div[aria-busy]').filter({ hasText: 'Device names' }).count(), 0, 'no Operator panel');
    assert.equal(await outletBadge(viewer.page, 3), 'Name on device: synced');
    assert.equal(await viewer.page.getByRole('button', { name: /Compare with device|Compare again|Retry|Write/ }).count(), 0, 'no panel buttons');
    assert.equal(await viewer.page.getByRole('button', { name: 'Edit Labels' }).isDisabled(), true);
    const viewerApi = await viewer.page.evaluate(async () => {
      const push = await fetch('/api/devices/pdu1/device-names/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ports: ['3'], expected: { 3: 'OPT13' } }) });
      const live = await fetch('/api/devices/pdu1/device-names');
      const status = await fetch('/api/devices/name-sync/status?device_id=pdu1');
      return { push: push.status, pushDetail: (await push.json()).detail, live: live.status, status: status.status };
    });
    assert.deepEqual(viewerApi, { push: 403, pushDetail: 'Your role does not allow this action', live: 403, status: 200 });
    checks.push('Viewer: summary + badges only, no panel buttons; push 403, live compare 403, status 200');
    await viewer.context.close();

    // ── Phone width 375: the panel, its table, the confirm step stay inside the screen ─────────────────────
    await setDevice('pdu1', { names: { 1: 'phone-check' }, clear_log: true });
    const phone = await login('operator', { width: 375, height: 812 });
    await openPdu(phone.page);
    await compare(phone.page);
    const card1 = cards(phone.page).nth(0);
    assert.equal((await card1.locator('span.ml-auto').innerText()).trim(), 'Differs');
    assert.match((await card1.innerText()).replace(/\s+/g, ' '), /Outlet 1.*OPT11.*phone-check/);
    assert.equal(await card1.getByRole('checkbox').isChecked(), true);
    await panel(phone.page).getByRole('button', { name: /^Write \d+ names? to device$/ }).click();
    const phoneGroup = phone.page.getByRole('group', { name: /^Write \d+ names? to PDU 01\?$/ });
    await phoneGroup.waitFor();
    const layout = await phone.page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
      const root = [...document.querySelectorAll('div[aria-busy]')].find(d => d.textContent.includes('Device names'));
      return { page: document.documentElement.scrollWidth, panel: box(root), group: box(root.querySelector('[role="group"]')),
               buttons: [...root.querySelectorAll('button')].map(box),
               tableShown: root.querySelector('table').getClientRects().length > 0,
               list: (() => { const list = root.querySelector('ul[aria-label^="Site names compared"]');
                 return { box: box(list), scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, cards: [...list.children].map(box),
                          states: [...list.children].map(li => box(li.querySelector('span.ml-auto'))) }; })() };
    });
    assert.ok(layout.page <= 375, `no horizontal page scroll (${layout.page})`);
    assert.equal(layout.tableShown, false, 'the table is replaced by cards on a phone');
    assert.ok(layout.list.scrollWidth <= layout.list.clientWidth, `no sideways scrolling in the card list (${layout.list.scrollWidth}/${layout.list.clientWidth})`);
    assert.equal(layout.list.cards.length, 4);
    for (const [left, right] of [layout.panel, layout.group, layout.list.box, ...layout.list.cards, ...layout.list.states, ...layout.buttons]) {
      assert.ok(left >= 0 && right <= 375, `inside 375 px: ${left}-${right}`);
    }
    observed.phoneList = { scrollWidth: layout.list.scrollWidth, clientWidth: layout.list.clientWidth, cards: layout.list.cards.length };
    await phone.page.screenshot({ path: process.env.DCIM_QA_SCREENSHOT || path.join(os.tmpdir(), 'dcim-name-sync-375.png'), fullPage: true });
    await phoneGroup.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await device('pdu1')).names[1], 'phone-check', 'Cancel writes nothing');
    checks.push('Phone 375 px: compare as cards (state visible, no sideways scroll), confirm step and buttons fit; Cancel writes nothing');
    await phone.context.close();

    const fakes = await fixture('GET', '/__fixture/name-devices');
    for (const [id, state] of Object.entries(fakes)) {
      assert.deepEqual([state.forbidden, state.clobbered], [[], []], `${id}: only name RPCs, no other outlet setting overwritten`);
    }
    observed.xerusSettingsPdu1 = fakes.pdu1.outlets['1'];
    checks.push('Fake Xerus PDUs: only getOutlets/getSettings/setSettings reached them; no setSettings changed another setting');
    const forbidden = unsafe.filter(u => /\/api\/pdus\/|\/power|maintenance|\/api\/kvms\//.test(u));
    assert.deepEqual(forbidden, [], 'no power, maintenance or KVM action was requested');
    assert.deepEqual(errors, [], 'no page errors');
    console.log(JSON.stringify({ passed: checks, observed, unsafe, errors }, null, 1));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
