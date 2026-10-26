// Renaming a server on the PDU page (RENAME-SYNC): typing a NEW server name over a server asks "Rename X to Y?" with
// a preview (both PDU feeds, the KVM port, rack/U, monitor, owner). "Rename everywhere" renames all of them,
// "Only this outlet" changes one outlet, an existing server name saves without asking, and Cancel / Escape write
// nothing. Runs only against the isolated local fixture (start it fresh); it puts every label back at the end.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9321';
const PASSWORD = 'test-password-123';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [], contexts = [];
  try {
    const probe = await browser.newContext();
    contexts.push(probe);
    assert.equal((await (await probe.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');

    // Admin API session for fixture setup, reads and restores (not routed, not counted as page writes).
    const api = await browser.newContext();
    contexts.push(api);
    const login = await api.request.post(origin + '/api/auth/login', { data: { username: 'admin', password: PASSWORD } });
    assert.equal(login.status(), 200);
    const headers = { Origin: origin, 'X-DCIM-CSRF': (await login.json()).csrf_token };
    const get = async path => (await api.request.get(origin + path)).json();
    const labels = async () => Object.fromEntries((await get('/api/devices/')).filter(d => d.labels).map(d => [d.id, d.labels]));
    const label = async (id, port) => (await labels())[id]?.[String(port)];
    async function write(method, path, data, extra = {}) {
      const response = await api.request.fetch(origin + path, { method, headers: { ...headers, ...extra }, data });
      assert.equal(response.status(), 200, `${method} ${path}: ${await response.text()}`);
      return response.json();
    }
    async function rackSlots(value) {
      const response = await api.request.get(origin + '/api/rack-slots');
      if (value === undefined) return response.json();
      return write('PUT', '/api/rack-slots', value, { 'If-Match': response.headers().etag });
    }
    const server = async name => (await get('/api/devices/locations')).servers.find(s => s.name === name);
    const monitor = async id => ((await get('/api/monitoring')).targets || []).find(t => t.id === id);

    const original = await labels();
    // OPT11 gets a second feed (PDU 02 outlet 4) and a saved rack U: PDU 01 outlet 1, PDU 02 outlet 4, KVM 01 port 1.
    await write('PATCH', '/api/devices/direct-label', { device_id: 'pdu2', port: '4', label: 'OPT11 (PSU2)', expected: 'OPT24' });
    await rackSlots({ 'Rack-01': { opt11: 3 } });

    const storage = await api.storageState();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: storage });
    contexts.push(context);
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    const sent = [];   // every write the page makes, in order: [method path, body]
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      const key = request.method() + ' ' + url.pathname;
      if (['PATCH /api/devices/pdu1/labels', 'POST /api/devices/rename-opt'].includes(key)) {
        sent.push([key, request.postDataJSON()]);
        return route.continue();
      }
      unexpectedWrites.push(key);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const tokens = [];   // plan_revision of each preview the page received
    page.on('response', async response => {
      if (new URL(response.url()).pathname === '/api/devices/rename-opt' && response.request().postDataJSON()?.dry_run) {
        tokens.push((await response.json().catch(() => ({}))).plan_revision);
      }
    });
    page.on('dialog', dialog => { errors.push('unexpected browser dialog: ' + dialog.message()); dialog.dismiss().catch(() => {}); });

    const dialog = page.locator('[data-dialog="rename-everywhere"]');
    const input = port => page.getByLabel(`Label for outlet ${port}`, { exact: true });
    async function editPdu01(port, text) {
      await page.goto(origin + '/?tab=power');
      await page.getByRole('region', { name: 'PDU 01' }).getByRole('button', { name: 'Details →' }).click();
      await page.getByText('Summary', { exact: true }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Edit Labels') && !b.disabled));
      await page.getByRole('button', { name: 'Edit Labels' }).click();
      await input(port).fill(text);
    }
    const save = () => page.getByRole('button', { name: 'Save', exact: true }).click();
    const settle = () => page.waitForTimeout(700);
    const start = await labels();

    // ---- Cancel and Escape: the preview is shown, nothing is written ----
    await editPdu01(1, 'OPT19');
    await save();
    await dialog.waitFor();
    assert.equal((await dialog.getByRole('heading').innerText()).trim(), 'Rename OPT11 to OPT19?');
    const text = await dialog.innerText();
    for (const line of ['PDU 01 outlet 1: OPT11 → OPT19', 'PDU 02 outlet 4: OPT11 (PSU2) → OPT19 (PSU2)', 'KVM 01 port 1: OPT11 → OPT19']) {
      assert.ok(text.includes(line), `the preview lists "${line}"`);
    }
    assert.match(await dialog.locator('[data-rename="position"]').innerText(), /Rack-01, U3 \(kept/);
    assert.equal((await dialog.locator('[data-rename="monitor"]').innerText()).trim(), 'OPT11 → OPT19');
    assert.match(await dialog.locator('[data-rename="owner"]').innerText(), /Fixture owner/);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.choice), 'everywhere', 'Rename everywhere is the default');
    await dialog.locator('[data-choice="cancel"]').click();
    await dialog.waitFor({ state: 'detached' });
    await save();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await settle();
    assert.deepEqual(sent.map(([key, body]) => [key, body.dry_run === true]), [
      ['POST /api/devices/rename-opt', true], ['POST /api/devices/rename-opt', true]], 'only previews were sent');
    assert.deepEqual(await labels(), start, 'Cancel and Escape write nothing');
    assert.equal(await input(1).inputValue(), 'OPT19', 'the editor stays open with the typed name');
    checks.push('Cancel and Escape: the preview lists both feeds, the KVM port, Rack-01 U3, the monitor and owner; nothing is written');

    // ---- Rename everywhere: both feeds, the KVM port, the rack U, monitor and owner follow ----
    sent.length = 0;
    await save();
    await dialog.waitFor();
    await dialog.locator('[data-choice="everywhere"]').click();
    await page.getByRole('button', { name: 'Edit Labels' }).waitFor();
    await page.getByRole('button', { name: 'Power off OPT19' }).waitFor();
    assert.deepEqual(sent.map(([key]) => key), ['POST /api/devices/rename-opt', 'POST /api/devices/rename-opt', 'PATCH /api/devices/pdu1/labels']);
    assert.equal(sent[1][1].old_name, 'OPT11');
    assert.equal(sent[1][1].plan_revision, tokens.at(-1), 'the apply carries the token of the preview it showed');
    let now = await labels();
    assert.deepEqual([now.pdu1['1'], now.pdu2['4'], now.kvm1['1']], ['OPT19', 'OPT19 (PSU2)', 'OPT19']);
    assert.deepEqual(await rackSlots(), { 'Rack-01': { opt19: 3 } });
    const renamed = await server('OPT19');
    assert.deepEqual([renamed.rack, renamed.slot], ['Rack-01', 3]);
    assert.deepEqual(renamed.pdu.map(p => `${p.device_id}:${p.port}`), ['pdu1:1', 'pdu2:4']);
    assert.deepEqual(renamed.kvm.map(p => `${p.device_id}:${p.port}`), ['kvm1:1']);
    assert.equal(await server('OPT11'), undefined, 'no OPT11 is left behind');
    assert.equal((await monitor('t11'))?.name, 'OPT19', 'the ping monitor follows');
    const owners = await get('/api/opt-owners');
    assert.equal(owners.opt19, 'Fixture owner');
    assert.equal(owners.opt11, undefined);
    checks.push('Rename everywhere on the PDU page: PDU 01 outlet 1, PDU 02 outlet 4 (PSU2), KVM 01 port 1, Rack-01 U3, monitor and owner all become OPT19');

    // ---- Only this outlet: one outlet changes, the other feed, the KVM port and the rack U keep OPT19 ----
    sent.length = 0;
    await editPdu01(1, 'OPT18');
    await save();
    await dialog.waitFor();
    assert.equal((await dialog.getByRole('heading').innerText()).trim(), 'Rename OPT19 to OPT18?');
    await dialog.locator('[data-choice="only"]').click();
    await page.getByRole('button', { name: 'Power off OPT18' }).waitFor();
    assert.deepEqual(sent.map(([key, body]) => [key, !!body.dry_run]), [['POST /api/devices/rename-opt', true], ['PATCH /api/devices/pdu1/labels', false]]);
    now = await labels();
    assert.deepEqual([now.pdu1['1'], now.pdu2['4'], now.kvm1['1']], ['OPT18', 'OPT19 (PSU2)', 'OPT19']);
    assert.deepEqual(await rackSlots(), { 'Rack-01': { opt19: 3 } });
    checks.push('Only this outlet: PDU 01 outlet 1 becomes OPT18; PDU 02 outlet 4, KVM 01 port 1 and the rack U keep OPT19');

    // ---- An existing server name: saved at once, no preview and no dialog ----
    sent.length = 0;
    await editPdu01(2, 'OPT13');
    await save();
    await page.getByRole('button', { name: 'Edit Labels' }).waitFor();
    await settle();
    assert.equal(await dialog.count(), 0, 'no dialog for an existing server');
    assert.deepEqual(sent.map(([key]) => key), ['PATCH /api/devices/pdu1/labels'], 'no rename-opt call at all');
    assert.equal(await label('pdu1', 2), 'OPT13');
    checks.push('An existing server name (OPT13 on outlet 2) is saved for that outlet only, without asking');

    // ---- The PDU–KVM mapping page asks the same way: the other feed's KVM port and the rack U follow ----
    sent.length = 0;
    await page.goto(origin + '/?tab=sync');
    await page.getByRole('heading', { name: 'PDU ↔ KVM Sync Map' }).waitFor();
    await page.getByRole('button', { name: 'Edit PDU 02 outlet 4 (OPT19 (PSU2))', exact: true }).click();
    await page.getByLabel('OPT label for PDU 02 outlet 4', { exact: true }).fill('OPT17 (PSU2)');
    await save();
    await dialog.waitFor();
    assert.equal((await dialog.getByRole('heading').innerText()).trim(), 'Rename OPT19 to OPT17?');
    await dialog.locator('[data-choice="everywhere"]').click();
    await page.getByRole('button', { name: 'Edit PDU 02 outlet 4 (OPT17 (PSU2))', exact: true }).waitFor();
    assert.deepEqual(sent.map(([key, body]) => [key, !!body.dry_run]), [['POST /api/devices/rename-opt', true], ['POST /api/devices/rename-opt', false]]);
    now = await labels();
    assert.deepEqual([now.pdu1['1'], now.pdu2['4'], now.kvm1['1']], ['OPT18', 'OPT17 (PSU2)', 'OPT17']);
    assert.deepEqual(await rackSlots(), { 'Rack-01': { opt17: 3 } });
    checks.push('Sync page: Rename everywhere of PDU 02 outlet 4 renames KVM 01 port 1 and the Rack-01 U3 entry too (OPT17)');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedWrites, [], 'The pages wrote only PDU 01 labels and the rename');

    // Put the fixture back: OPT11 on PDU 01 outlets 1-2, KVM 01 port 1, its monitor/owner; OPT24 on PDU 02 outlet 4.
    await write('POST', '/api/devices/rename-opt', { old_name: 'OPT17', new_name: 'OPT11' });
    await write('PATCH', '/api/devices/direct-label', { device_id: 'pdu1', port: '1', label: 'OPT11', expected: 'OPT18' });
    await write('PATCH', '/api/devices/direct-label', { device_id: 'pdu1', port: '2', label: 'OPT12', expected: 'OPT13' });
    await write('PATCH', '/api/devices/direct-label', { device_id: 'pdu2', port: '4', label: 'OPT24', expected: 'OPT11 (PSU2)' });
    await rackSlots({});
    assert.deepEqual(await labels(), original, 'every label is put back');
    assert.equal((await monitor('t11'))?.name, 'OPT11');
    assert.equal((await get('/api/opt-owners')).opt11, 'Fixture owner');
    console.log(JSON.stringify({ passed: checks, errors }, null, 2));
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
