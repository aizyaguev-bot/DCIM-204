// PDU–KVM mapping page (SyncView) against the isolated fixture: taking over a used KVM port asks first (SYNC-1),
// a save made from a stale edit row is refused (SYNC-2), links survive an unavailable KVM status (SYNC-3), an
// unreachable PDU stays editable (SYNC-4), a partial save says what was saved (SYNC-5) and the page fits 375 px
// (SYNC-6). Every label this check changes is put back through the API, so it can run again on the same fixture.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const PASSWORD = 'test-password-123';
const LABEL_WRITE = '/api/devices/direct-label';
// SYNC_CASES=1,4 runs only those cases (all by default).
const only = (process.env.SYNC_CASES || '').split(',').map(s => s.trim()).filter(Boolean);
const run = id => !only.length || only.includes(String(id));

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [];
  const contexts = [];

  async function waitFor(fn, label, timeout = 10000) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // One sign-in per role, reused by every page of that role: the fixture throttles repeated sign-ins per user.
  const sessions = {};
  async function signIn(username) {
    const context = await browser.newContext();
    contexts.push(context);
    const response = await context.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(response.status(), 200, `sign in as ${username}`);
    sessions[username] = await context.storageState();
    return { context, csrf: (await response.json()).csrf_token };
  }

  async function open(username, { viewport = { width: 1440, height: 1000 }, setup } = {}) {
    if (!sessions[username]) await (await signIn(username)).context.close();
    const context = await browser.newContext({ viewport, storageState: sessions[username] });
    contexts.push(context);
    // What's new opens over the page in a fresh profile; it is not under test here.
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    const writes = [];
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || url.pathname === '/api/auth/login') return route.continue();
      if (request.method() === 'PATCH' && url.pathname === LABEL_WRITE) { writes.push(request.postDataJSON()); return route.continue(); }
      unexpectedWrites.push(request.method() + ' ' + url.pathname);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    // confirm() answers come from `answers` (dismissed when empty); alerts are accepted. Every dialog is recorded.
    const dialogs = [], answers = [];
    page.on('dialog', async dialog => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'confirm' && !answers.shift()) await dialog.dismiss(); else await dialog.accept();
    });
    if (setup) await setup(page);
    await page.goto(origin + '/?tab=sync');
    await page.getByRole('heading', { name: 'PDU ↔ KVM Sync Map' }).waitFor();
    await page.getByRole('button', { name: 'Edit PDU 01 outlet 1 (OPT11)' }).waitFor();
    // Every PDU and KVM status has arrived (the "waiting for status" banner is gone).
    await waitFor(async () => (await page.getByText('ממתין לסטטוס').count()) === 0, 'all device statuses');
    return { context, page, writes, dialogs, answers };
  }

  // Refuse anything but the isolated fixture before signing in or writing.
  const probe = await browser.newContext();
  contexts.push(probe);
  assert.equal((await (await probe.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
  // Admin API session for reading and restoring fixture labels (not routed, not counted as page writes).
  const { context: api, csrf } = await signIn('admin');
  const apiHeaders = { Origin: origin, 'X-DCIM-CSRF': csrf };
  async function savedLabel(deviceId, port) {
    const devices = await (await api.request.get(origin + '/api/devices/')).json();
    return devices.find(d => d.id === deviceId)?.labels?.[String(port)];
  }
  async function restore(deviceId, port, label, expected) {
    const response = await api.request.patch(origin + LABEL_WRITE, { headers: apiHeaders, data: { device_id: deviceId, port: String(port), label, expected } });
    assert.equal(response.status(), 200, `restore ${deviceId} port ${port}`);
  }
  const editButton = (page, name) => page.getByRole('button', { name: `Edit ${name}`, exact: true });
  const tableRow = (page, name) => page.locator('tr', { has: editButton(page, name) });
  const settle = page => page.waitForTimeout(600);

  try {
    // ---- SYNC-1: a KVM port used by another server is taken over only after a confirm ----
    if (run(1)) {
      const s = await open('admin');
      await editButton(s.page, 'PDU 02 outlet 1 (OPT21)').click();
      await s.page.getByLabel('KVM for outlet 1', { exact: true }).selectOption({ label: 'KVM 01' });
      const portSelect = s.page.getByLabel('KVM port for outlet 1', { exact: true });
      assert.match(await portSelect.locator('option[value="2"]').textContent(), /#2 \(OPT12\)/, 'the port list names the server on each port');
      const box = await portSelect.boundingBox();
      assert.ok(box.width >= 128, 'port list is at least 8rem wide, got ' + box.width);
      await portSelect.selectOption('2');
      await s.page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitFor(() => s.dialogs.length === 1, 'the takeover confirm');
      assert.equal(s.dialogs[0].type, 'confirm');
      assert.match(s.dialogs[0].message, /KVM 01 port 2 is used by OPT12/);
      assert.match(s.dialogs[0].message, /OPT21/);
      await settle(s.page);
      assert.deepEqual(s.writes, [], 'Cancel writes nothing');
      checks.push('SYNC-1 taking over KVM 01 port 2 (OPT12) asks first; Cancel sends no PATCH');

      s.answers.push(true);
      await s.page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitFor(() => s.writes.length === 1, 'the KVM write');
      assert.deepEqual(s.writes[0], { device_id: 'kvm1', port: '2', label: 'OPT21', expected: 'OPT12' });
      await waitFor(async () => (await tableRow(s.page, 'PDU 02 outlet 1 (OPT21)').textContent()).includes('#2'), 'OPT21 linked to KVM 01 #2');
      assert.equal(s.dialogs.length, 2);
      assert.equal(await savedLabel('kvm1', 2), 'OPT21');
      checks.push('SYNC-1 OK writes KVM 01 port 2 with expected "OPT12" and links OPT21');
      await restore('kvm1', 2, 'OPT12', 'OPT21');
      await s.context.close();
    }

    // ---- SYNC-2: a save from an edit row opened before another session's save is refused (no lost update) ----
    if (run(2)) {
      const a = await open('admin');
      const b = await open('operator');
      await editButton(a.page, 'PDU 03 outlet 1 (OPT31)').click();
      await a.page.getByLabel('OPT label for PDU 03 outlet 1', { exact: true }).fill('OPT31-A');
      await editButton(b.page, 'PDU 03 outlet 1 (OPT31)').click();
      await b.page.getByLabel('OPT label for PDU 03 outlet 1', { exact: true }).fill('OPT31-B');
      await b.page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitFor(() => b.writes.length === 1, 'session B save');
      assert.deepEqual(b.writes[0], { device_id: 'pdu3', port: '1', label: 'OPT31-B', expected: 'OPT31' });
      await editButton(b.page, 'PDU 03 outlet 1 (OPT31-B)').waitFor();
      // Let session A poll at least once (15 s refresh), so its table already holds B's label under the open edit row.
      await a.page.waitForTimeout(16000);
      await a.page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitFor(() => a.dialogs.length === 1, 'the refusal message');
      assert.deepEqual(a.writes, [{ device_id: 'pdu3', port: '1', label: 'OPT31-A', expected: 'OPT31' }]);
      assert.equal(a.dialogs[0].type, 'alert');
      assert.equal(a.dialogs[0].message, 'Save failed: This port changed in another session. Reload and try again.');
      await editButton(a.page, 'PDU 03 outlet 1 (OPT31-B)').waitFor();
      assert.equal(await a.page.getByLabel('OPT label for PDU 03 outlet 1', { exact: true }).count(), 0, 'the edit row closes on 409');
      assert.equal(await savedLabel('pdu3', 1), 'OPT31-B');
      checks.push('SYNC-2 a save from a stale edit row gets 409 after a 16 s poll; the other session\'s label survives');
      await restore('pdu3', 1, 'OPT31', 'OPT31-B');
      await a.context.close(); await b.context.close();
    }

    // ---- SYNC-3: KVM status unavailable — links come from saved labels; Edit and Clear write both ports ----
    if (run(3)) {
      const s = await open('admin', { setup: page => page.route('**/api/kvms/kvm1/status', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ device_id: 'kvm1', reachable: false, ports: [], error: 'Fixture: KVM unavailable' }) })) });
      await waitFor(async () => /KVM 01\s*#1/.test(await tableRow(s.page, 'PDU 01 outlet 1 (OPT11)').textContent()), 'OPT11 linked from saved labels');
      await s.page.getByText('סטטוס KVM לא זמין').waitFor();
      await s.page.getByText('הקישורים מוצגים מתוויות שמורות').waitFor();
      await editButton(s.page, 'PDU 01 outlet 1 (OPT11)').click();
      await s.page.getByLabel('OPT label for PDU 01 outlet 1', { exact: true }).fill('OPT11X');
      await s.page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitFor(() => s.writes.length === 2, 'both renames');
      assert.deepEqual(s.writes, [
        { device_id: 'pdu1', port: '1', label: 'OPT11X', expected: 'OPT11' },
        { device_id: 'kvm1', port: '1', label: 'OPT11X', expected: 'OPT11' },
      ]);
      await waitFor(async () => /KVM 01\s*#1/.test(await tableRow(s.page, 'PDU 01 outlet 1 (OPT11X)').textContent()), 'OPT11X still linked');
      checks.push('SYNC-3 KVM status unavailable: link shown from saved labels; Edit renames the outlet and the KVM port');

      s.answers.push(true);
      await s.page.getByRole('button', { name: 'Clear OPT11X from PDU 01 outlet 1 and KVM 01 port 1', exact: true }).click();
      await waitFor(() => s.writes.length === 4, 'both clears');
      assert.equal(s.dialogs.at(-1).message, 'Clear OPT11X from PDU 01 outlet 1 and KVM 01 port 1?');
      assert.deepEqual(s.writes.slice(2), [
        { device_id: 'pdu1', port: '1', label: '', expected: 'OPT11X' },
        { device_id: 'kvm1', port: '1', label: '', expected: 'OPT11X' },
      ]);
      assert.equal(await savedLabel('pdu1', 1), 'Outlet 1');
      assert.equal(await savedLabel('kvm1', 1), 'Port 1');
      checks.push('SYNC-3 Clear removes the server from the outlet and the KVM port');
      await restore('pdu1', 1, 'OPT11', 'Outlet 1');
      await restore('kvm1', 1, 'OPT11', 'Port 1');
      await s.context.close();
    }

    // ---- SYNC-4: an unreachable PDU without outlets lists its saved labels and stays editable ----
    if (run(4)) {
      const s = await open('admin', { setup: page => page.route('**/api/pdus/pdu7/status', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ device_id: 'pdu7', reachable: false, inlet_voltage: 0, total_watts: 0, watts_complete: false,
          outlets: [], inlet_readings: [], error: 'Fixture: PDU unavailable' }) })) });
      for (let i = 1; i <= 4; i++) {
        const edit = editButton(s.page, `PDU 07 outlet ${i} (OPT7${i})`);
        await edit.waitFor();
        assert.equal(await edit.isEnabled(), true, `OPT7${i} is editable`);
      }
      assert.equal(await s.page.getByText('לא נטען עדיין…').count(), 0, 'no "not loaded yet" placeholder');
      await s.page.getByText('Offline · Fixture: PDU unavailable').waitFor();
      await s.page.getByRole('alert').filter({ hasText: 'PDU לא זמין' }).waitFor();
      const count = async id => Number(/\((\d+)\)/.exec(await s.page.getByRole('button', { name: new RegExp(`^${id} \\(`) }).textContent())[1]);
      const [all, assigned, empty] = [await count('הכל'), await count('מוקצה'), await count('ריק')];
      assert.equal(all, assigned + empty, `All ${all} = assigned ${assigned} + empty ${empty}`);
      assert.equal(all, 28, 'seven PDUs with four outlets each');
      await editButton(s.page, 'PDU 07 outlet 2 (OPT72)').click();
      await s.page.getByLabel('OPT label for PDU 07 outlet 2', { exact: true }).fill('OPT72X');
      await s.page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitFor(() => s.writes.length === 1, 'the PDU 07 write');
      assert.deepEqual(s.writes[0], { device_id: 'pdu7', port: '2', label: 'OPT72X', expected: 'OPT72' });
      await editButton(s.page, 'PDU 07 outlet 2 (OPT72X)').waitFor();
      checks.push('SYNC-4 unreachable PDU 07: OPT71–74 listed and editable, header shows the state, All = assigned + empty');
      await restore('pdu7', 2, 'OPT72', 'OPT72X');
      await s.context.close();
    }

    // ---- SYNC-5: the PDU write succeeds and the KVM write fails: the message names both ----
    if (run(5)) {
      const s = await open('admin', { setup: page => page.route('**' + LABEL_WRITE, route => {
        if (route.request().postDataJSON()?.device_id !== 'kvm1') return route.fallback();
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Fixture: KVM write failed' }) });
      }) });
      await waitFor(async () => /KVM 01\s*#3/.test(await tableRow(s.page, 'PDU 01 outlet 3 (OPT13)').textContent()), 'OPT13 linked');
      await editButton(s.page, 'PDU 01 outlet 3 (OPT13)').click();
      await s.page.getByLabel('OPT label for PDU 01 outlet 3', { exact: true }).fill('OPT13X');
      await s.page.getByRole('button', { name: 'Save', exact: true }).click();
      await waitFor(() => s.dialogs.length === 1, 'the partial-save message');
      assert.equal(s.dialogs[0].message, 'PDU 01 outlet 3 was updated, but KVM 01 port 3 could not be updated: Fixture: KVM write failed.');
      assert.deepEqual(s.writes, [{ device_id: 'pdu1', port: '3', label: 'OPT13X', expected: 'OPT13' }], 'the KVM write never reached the server');
      await editButton(s.page, 'PDU 01 outlet 3 (OPT13X)').waitFor();
      assert.equal(await s.page.getByLabel('OPT label for PDU 01 outlet 3', { exact: true }).count(), 0, 'the edit row closes after a partial save');
      checks.push('SYNC-5 partial save names what was updated and what failed, then closes the row');
      await restore('pdu1', 3, 'OPT13', 'OPT13X');
      await s.context.close();
    }

    // ---- SYNC-6: 375 px phone width for every role ----
    for (const role of run(6) ? ['admin', 'operator', 'viewer'] : []) {
      const s = await open(role, { viewport: { width: 375, height: 812 } });
      await settle(s.page);
      const size = await s.page.evaluate(() => {
        const table = [...document.querySelectorAll('table')].find(t => t.textContent.includes('Outlet'));
        const box = table.parentElement;
        return { page: document.documentElement.scrollWidth, body: document.body.scrollWidth,
          boxScroll: box.scrollWidth, boxClient: box.clientWidth, overflow: getComputedStyle(box).overflowX };
      });
      assert.equal(size.page, 375, `${role}: page scrollWidth ${size.page}`);
      assert.equal(size.body, 375, `${role}: body scrollWidth ${size.body}`);
      assert.equal(size.overflow, 'auto');
      assert.ok(size.boxScroll > size.boxClient, `${role}: the table scrolls inside its box (${size.boxScroll} > ${size.boxClient})`);
      assert.equal(await editButton(s.page, 'PDU 01 outlet 1 (OPT11)').isEnabled(), role !== 'viewer', `${role}: Edit enabled only for Operator/Admin`);
      checks.push(`SYNC-6 ${role} at 375×812: page 375 px wide, table scrolls inside its box`);
      assert.deepEqual(s.writes, []);
      await s.context.close();
    }

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedWrites, [], 'The mapping page writes only port labels');
    for (const [id, port, label] of [['kvm1', 1, 'OPT11'], ['kvm1', 2, 'OPT12'], ['pdu1', 1, 'OPT11'], ['pdu1', 3, 'OPT13'], ['pdu3', 1, 'OPT31'], ['pdu7', 2, 'OPT72']]) {
      assert.equal(await savedLabel(id, port), label, `${id} port ${port} restored`);
    }
    console.log(JSON.stringify({ passed: checks, errors }, null, 2));
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
