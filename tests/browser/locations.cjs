// Locations page (Admin > Locations): Clear location wording, the two swap boxes, no-op moves and a same-rack move
// with a blank slot. Runs only against the isolated preview fixture (tests/browser/preview-server.py).
//
// Writes on the fixture: OPT34's PDU outlet label is cleared and then put back; OPT64 is placed at Rack-06 U6 once
// (a repeat run finds it there and skips that step). Every other move is a preview only.
//
// The Clear position text and the same-rack U need the server's kept_position field and its same-rack move rule
// (sweep B01). Against an older backend set LOCATIONS_LEGACY_BACKEND=1: those checks then assert the fallback text
// instead and the same-rack preview check is reported as skipped.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const legacy = process.env.LOCATIONS_LEGACY_BACKEND === '1';
const FIXTURE = 'LOCAL PREVIEW - TEST DATA';
const ALLOWED_WRITES = new Set(['POST /api/auth/login', 'PATCH /api/devices/direct-label', 'POST /api/devices/move-server']);

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  assert.notEqual(new URL(origin).port, '8000', 'Never the live port');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], skipped = [], unexpectedWrites = [];
  let restoreOpt34 = null, restore = async () => 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const method = request.method(), path = new URL(request.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !ALLOWED_WRITES.has(`${method} ${path}`)) {
        unexpectedWrites.push(`${method} ${path}`); return route.abort();
      }
      return route.continue();
    });
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, FIXTURE, 'Refuse any real lab environment');
    const login = await context.request.post(origin + '/api/auth/login', { data: { username: 'admin', password: 'test-password-123' } });
    assert.equal(login.status(), 200, 'Fixture admin login (start the fixture with DCIM_TEST_ACCOUNTS=1)');
    const csrf = (await login.json()).csrf_token;
    // Puts OPT34 back on its outlet so other checks on this fixture see the original data.
    restore = async () => {
      const response = await context.request.patch(origin + '/api/devices/direct-label', { data: restoreOpt34, headers: { 'X-DCIM-CSRF': csrf } });
      if (response.status() === 200) restoreOpt34 = null;
      return response.status();
    };

    const locations = async () => (await (await context.request.get(origin + '/api/devices/locations')).json()).servers;
    const servers = await locations();
    const hasKept = servers.length > 0 && servers.every(s => 'kept_position' in s);
    if (!legacy) assert.ok(hasKept, 'GET /api/devices/locations must send kept_position (sweep B01); set LOCATIONS_LEGACY_BACKEND=1 for an older backend');

    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?tab=locations');
    await page.getByRole('heading', { name: 'Server locations' }).waitFor();
    const row = name => page.locator('tbody tr').filter({ has: page.locator('td:first-child').getByText(name, { exact: true }) });
    await row('OPT34').waitFor();
    const moveDialog = () => page.getByRole('dialog');
    async function openMove(name) {
      await page.getByRole('button', { name: `Move ${name}`, exact: true }).click();
      await moveDialog().waitFor();
    }
    async function preview(dialog) {
      const sent = page.waitForRequest(r => r.url().endsWith('/api/devices/move-server') && r.method() === 'POST');
      await dialog.getByRole('button', { name: /^Preview (changes|again)$/ }).click();
      const body = (await sent).postDataJSON();
      const section = dialog.getByRole('region', { name: 'Preview of changes' });
      await section.waitFor();
      return { body, section };
    }
    async function cancel(dialog) {
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    }

    // 1. Clear location: OPT34's rack comes only from its PDU (Rack-03), so the confirm and notice must not promise it.
    const opt34 = servers.find(s => s.key === 'opt34');
    assert.ok(opt34 && opt34.rack === 'Rack-03' && opt34.pdu.length === 1, 'Fresh fixture: OPT34 on PDU 03 outlet 4 in Rack-03');
    if (!legacy) assert.deepEqual(opt34.kept_position, { rack: null, slot: null }, 'OPT34 has no saved rack position');
    let confirmText = '';
    page.once('dialog', dialog => { confirmText = dialog.message(); dialog.accept(); });
    const cleared = page.waitForResponse(r => r.url().endsWith('/api/devices/direct-label') && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Clear location of OPT34', exact: true }).click();
    assert.equal((await cleared).status(), 200);
    restoreOpt34 = { device_id: opt34.pdu[0].device_id, port: String(opt34.pdu[0].port), label: opt34.pdu[0].label || 'OPT34' };
    assert.match(confirmText, /^Clear OPT34 from all 1 port\?/);
    assert.doesNotMatch(confirmText, /is kept/, 'The confirm must not say the rack position is kept');
    const notice = page.getByRole('status').filter({ hasText: 'OPT34: 1 of 1 port label cleared.' });
    await notice.waitFor();
    if (legacy) {
      assert.match(confirmText, /Its rack may not be kept if it comes only from these ports\.$/);
      assert.equal((await notice.locator('div.font-medium').innerText()).trim(), 'OPT34: 1 of 1 port label cleared.');
      checks.push('Clear without kept_position promises nothing about the rack');
    } else {
      assert.match(confirmText, /It becomes Unplaced: its rack \(Rack-03\) comes only from these ports\.$/);
      assert.equal((await notice.locator('div.font-medium').innerText()).trim(), 'OPT34: 1 of 1 port label cleared. Now unplaced.');
      await row('OPT34').locator('td').nth(1).getByText('Unplaced', { exact: true }).waitFor();
      checks.push('Clear OPT34: the confirm says it becomes Unplaced and the notice says Now unplaced');
    }

    // 2. The two swap boxes are separate: unticking the slot swap keeps the server swap on, so the target keeps a place.
    await openMove('OPT51');
    let dialog = moveDialog();
    const serverSwap = dialog.getByRole('checkbox', { name: /^Swap with/ });
    assert.equal(await serverSwap.isChecked(), true);
    await dialog.getByRole('radio', { name: 'Empty ports' }).check();
    await dialog.locator('#move-slot').fill('3');
    const slotSwap = dialog.getByRole('checkbox', { name: 'If that slot holds another server, swap positions with it' });
    assert.equal(await slotSwap.isChecked(), true);
    await slotSwap.uncheck();
    await dialog.getByRole('radio', { name: "Another server's location" }).check();
    assert.equal(await serverSwap.isChecked(), true, 'Unticking the slot swap must not untick the server swap');
    await dialog.locator('#move-target').selectOption('opt52');
    let { body, section } = await preview(dialog);
    assert.equal(body.swap, true, 'Server mode sends its own swap box');
    assert.equal(await section.getByText(/Becomes unplaced/).count(), 0, 'With swap on nothing becomes unplaced');
    await section.getByText('OPT52', { exact: false }).first().waitFor();
    await dialog.getByRole('radio', { name: 'Empty ports' }).check();
    assert.equal(await slotSwap.isChecked(), false, 'The slot box keeps its own state');
    await cancel(dialog);
    checks.push('Swap boxes do not carry over between modes; the server swap stays ticked and nothing becomes unplaced');

    // 3. A move to the ports the server already has changes nothing: no position line, Apply disabled.
    await openMove('OPT41');
    dialog = moveDialog();
    await dialog.getByRole('radio', { name: 'Empty ports' }).check();
    ({ body, section } = await preview(dialog));
    assert.deepEqual(body.target_ports, [{ device_id: 'pdu4', port: '1' }]);
    await section.getByText('Nothing would change.', { exact: true }).waitFor();
    assert.equal(await section.getByText('Rack positions').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
    await cancel(dialog);
    checks.push('A no-op move shows Nothing would change. and Apply stays disabled');

    // 4. Same rack with a blank slot keeps the U. First place OPT64 at Rack-06 U6 (once per fixture).
    if ((await locations()).find(s => s.key === 'opt64')?.slot !== 6) {
      await openMove('OPT64');
      dialog = moveDialog();
      await dialog.getByRole('radio', { name: 'Empty ports' }).check();
      await dialog.locator('#move-rack').selectOption('Rack-06');
      await dialog.locator('#move-slot').fill('6');
      ({ section } = await preview(dialog));
      await section.getByText('Rack-06 · U6', { exact: false }).first().waitFor();
      const applied = page.waitForResponse(r => r.url().endsWith('/api/devices/move-server') && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      assert.equal((await applied).status(), 200);
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
      await dialog.waitFor({ state: 'detached' });
    }
    await row('OPT64').locator('td').nth(2).getByText('U6', { exact: true }).waitFor();
    await openMove('OPT64');
    dialog = moveDialog();
    await dialog.getByRole('radio', { name: 'Empty ports' }).check();
    const slot = dialog.locator('#move-slot');
    assert.equal(await slot.getAttribute('placeholder'), '6', 'Keep current rack: the blank slot keeps U6');
    await dialog.locator('#move-rack').selectOption('Rack-05');
    assert.equal(await slot.getAttribute('placeholder'), '—', 'Another rack: no U until one is chosen');
    await dialog.locator('#move-rack').selectOption('Rack-06');
    assert.equal(await slot.getAttribute('placeholder'), '6', 'The same rack chosen again: the blank slot keeps U6');
    checks.push('Slot placeholder shows the current U only while the rack stays the same');
    // Its own ports, the same rack chosen and a blank slot: a U that stays is no position change, so nothing changes.
    // (A dropped U would show as "OPT64 Rack-06 · U6 → Rack-06".)
    ({ body, section } = await preview(dialog));
    assert.deepEqual(body.target_ports, [{ device_id: 'pdu6', port: '4' }]);
    assert.equal(body.target_rack, 'Rack-06');
    assert.equal(body.target_slot, null);
    if (legacy) {
      skipped.push('same-rack blank-slot preview keeps U6 (needs the sweep B01 backend)');
    } else {
      await section.getByText('Nothing would change.', { exact: true }).waitFor();
      assert.equal(await section.getByText('Rack positions').count(), 0, 'Same rack, blank slot: OPT64 stays at U6');
      assert.equal(await dialog.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
      checks.push('Same rack with a blank slot: the preview keeps OPT64 at U6');
    }
    await cancel(dialog);

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedWrites, [], 'Only label and move requests may write');
    assert.equal(await restore(), 200, 'OPT34 label restored');
    console.log(JSON.stringify({ passed: checks, skipped, backend: legacy ? 'legacy (no kept_position)' : 'kept_position', errors }, null, 2));
  } finally {
    if (restoreOpt34 && await restore().catch(() => 0) !== 200) console.error('OPT34 was cleared and not restored; restart the fixture before repeating.');
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
