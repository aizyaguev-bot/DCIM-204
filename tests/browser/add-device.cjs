// Add device modal: one request per submit, real rack options, trimmed names and server errors (DASH-1, DASH-4, DASH-5, DASH-2 alert).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8940';
const MARKER = 'LOCAL PREVIEW - TEST DATA';
const DEVICES = '/api/devices/';
// Contract C4 text (B01) for a PDU/KVM address that another PDU/KVM already uses.
const C4_DETAIL = 'PDU 01 (PDU) already uses this address. Each PDU or KVM needs its own address.';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [], errors = [], unexpectedWrites = [], created = new Set();
  let context, csrf, c4 = 'not checked';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // What's new opens over the page in a fresh profile; it is not under test here.
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const { pathname } = new URL(request.url());
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
      if (write && pathname !== DEVICES && pathname !== '/api/auth/login' &&
          !(request.method() === 'DELETE' && created.has(pathname.slice(DEVICES.length)))) {
        unexpectedWrites.push(request.method() + ' ' + pathname); return route.abort();
      }
      return route.continue();
    });
    const login = await context.request.post(origin + '/api/auth/login', { data: { username: 'admin', password: 'test-password-123' } });
    assert.equal(login.status(), 200, 'admin login on the fixture');
    csrf = (await login.json()).csrf_token;
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, MARKER, 'Refuse any real lab environment');

    const serverDevices = async () => {
      const response = await context.request.get(origin + DEVICES);
      assert.equal(response.status(), 200);
      return response.json();
    };
    const before = await serverDevices();
    const expectedRacks = [...new Set(before.map(d => d.rack).filter(Boolean))].sort();

    // latency: ms to hold each device POST; emptyLab: the device list reads as [];
    // reply: fulfil the POST with this {status, json} instead of reaching the fixture.
    async function openPage({ latency = 0, emptyLab = false, reply = null } = {}) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      const posts = [], dialogs = [];
      page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
      page.on('response', async response => {
        const request = response.request();
        if (request.method() !== 'POST' || new URL(response.url()).pathname !== DEVICES || response.status() !== 201) return;
        try { created.add((await response.json()).id); } catch {}
      });
      await page.route(url => url.pathname === DEVICES, async route => {
        const request = route.request();
        if (request.method() === 'GET' && emptyLab) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        if (request.method() !== 'POST') return route.continue();
        posts.push(request.postDataJSON());
        if (latency) await sleep(latency);
        if (reply) return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.json) });
        return route.continue();
      });
      await page.goto(origin + '/');
      await page.locator('button.device-add').waitFor();
      return { page, posts, dialogs };
    }
    async function openModal(page) {
      await page.locator('button.device-add').click();
      const dialog = page.getByRole('dialog', { name: 'Add device' });
      await dialog.waitFor();
      return dialog;
    }
    const submitButton = dialog => dialog.getByRole('button', { name: /^(Add device|Adding…)$/ });
    async function fill(dialog, name, ip) {
      await dialog.getByLabel('Display name', { exact: true }).fill(name);
      await dialog.getByLabel('IP address', { exact: true }).fill(ip);
    }
    async function expectOneDevice(page, name) {
      await page.locator(`section.device-card[aria-label="${name}"]`).first().waitFor();
      await sleep(400); // room for a duplicate request or card to show up
      assert.equal(await page.locator(`section.device-card[aria-label="${name}"]`).count(), 1, name + ' card count');
      const matches = (await serverDevices()).filter(d => d.name === name);
      assert.equal(matches.length, 1, name + ' stored once');
      matches.forEach(d => created.add(d.id));
    }
    async function expectBusy(dialog, label) {
      const button = submitButton(dialog);
      await assert.doesNotReject(button.filter({ hasText: 'Adding…' }).waitFor({ timeout: 2000 }), label + ': Adding… label');
      assert.equal(await button.isDisabled(), true, label + ': submit disabled');
      assert.equal(await button.getAttribute('aria-busy'), 'true', label + ': aria-busy');
      assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), false, label + ': Cancel stays enabled');
    }

    // DASH-1: a double click at 0 ms and 800 ms latency sends one POST and shows one card.
    for (const latency of [0, 800]) {
      const name = `QA-DBL-${latency}`;
      const { page, posts } = await openPage({ latency });
      const dialog = await openModal(page);
      await fill(dialog, name, `192.0.2.${latency ? 161 : 160}`);
      const done = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === DEVICES);
      await submitButton(dialog).dblclick();
      if (latency) await expectBusy(dialog, name);
      assert.equal((await done).status(), 201);
      await dialog.waitFor({ state: 'detached' });
      await expectOneDevice(page, name);
      assert.equal(posts.length, 1, name + ' POST count');
      await page.close();
      checks.push(`double click at ${latency} ms latency adds one device${latency ? '; submit shows Adding… and is disabled meanwhile' : ''}`);
    }

    // DASH-1: two real clicks 60 ms apart, and two clicks inside one task (before React re-renders).
    for (const mode of ['mouse 60 ms', 'same task']) {
      const name = mode === 'same task' ? 'QA-SYNC' : 'QA-60MS';
      const { page, posts } = await openPage({ latency: 400 });
      const dialog = await openModal(page);
      await fill(dialog, name, mode === 'same task' ? '192.0.2.163' : '192.0.2.162');
      if (mode === 'same task') {
        await submitButton(dialog).evaluate(button => { button.click(); button.click(); });
      } else {
        const box = await submitButton(dialog).boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(60);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      await dialog.waitFor({ state: 'detached' });
      await expectOneDevice(page, name);
      assert.equal(posts.length, 1, name + ' POST count');
      await page.close();
      checks.push(`two clicks (${mode}) send one POST`);
    }

    // DASH-4: rack options come from the lab only, once each, after "No rack".
    {
      const { page, posts } = await openPage();
      const dialog = await openModal(page);
      const rack = dialog.getByRole('combobox', { name: 'Rack', exact: true });
      const options = await rack.locator('option').evaluateAll(list => list.map(o => [o.value, o.textContent]));
      assert.deepEqual(options[0], ['', 'No rack']);
      const values = options.slice(1).map(([value, text]) => { assert.equal(value, text); return value; });
      assert.equal(new Set(values).size, values.length, 'rack options are unique');
      assert.ok(!values.includes('Rack-08'), 'no hard-coded Rack-08');
      assert.deepEqual(values, expectedRacks, 'rack options match the lab racks');
      assert.equal(await rack.inputValue(), expectedRacks[0], 'first lab rack is preselected');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(posts.length, 0);
      await page.close();
      checks.push(`rack options are "No rack" + ${values.length} unique lab racks (no Rack-07/08 extras); Escape closes`);
    }

    // DASH-4: an empty lab offers "No rack" and posts rack "".
    {
      const { page, posts } = await openPage({ emptyLab: true });
      const dialog = await openModal(page);
      const rack = dialog.getByRole('combobox', { name: 'Rack', exact: true });
      assert.deepEqual(await rack.locator('option').evaluateAll(list => list.map(o => [o.value, o.textContent])), [['', 'No rack']]);
      assert.equal(await rack.inputValue(), '');
      await fill(dialog, 'QA-EMPTY', '192.0.2.164');
      await submitButton(dialog).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(posts.length, 1);
      assert.equal(posts[0].rack, '', 'empty lab posts rack ""');
      await page.close();
      checks.push('empty lab shows only "No rack" and posts rack ""');
    }

    // DASH-5: a blank name is refused before any request; names are sent trimmed, the IP as typed.
    {
      const { page, posts, dialogs } = await openPage();
      const dialog = await openModal(page);
      await fill(dialog, '   ', '192.0.2.165');
      await submitButton(dialog).click();
      await sleep(300);
      assert.deepEqual(dialogs, ['Name and IP are required.']);
      assert.equal(posts.length, 0, 'blank name sends nothing');
      assert.equal(await dialog.isVisible(), true, 'dialog stays open');
      assert.equal(await submitButton(dialog).isDisabled(), false);
      checks.push('"   " name shows the required alert and sends no POST');

      await fill(dialog, ' PDU-X ', '192.0.2.165');
      await submitButton(dialog).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(posts.length, 1);
      assert.equal(posts[0].name, 'PDU-X');
      assert.equal(posts[0].ip, '192.0.2.165');
      await expectOneDevice(page, 'PDU-X');
      await page.close();
      checks.push('" PDU-X " posts and shows "PDU-X"');
    }

    // DASH-2 (B01 contract C4): a 409 shows its detail, keeps the dialog and re-enables Add device.
    async function expectRefused(page, dialog, dialogs, detail, label) {
      await submitButton(dialog).filter({ hasText: 'Add device' }).waitFor();
      assert.deepEqual(dialogs, [`Failed to add device: ${detail}`], label + ' alert');
      assert.equal(await dialog.isVisible(), true, label + ': dialog stays open');
      assert.equal(await submitButton(dialog).isDisabled(), false, label + ': submit enabled again');
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true, label + ': focus stays in the dialog');
      assert.equal(await dialog.getByLabel('Display name', { exact: true }).inputValue(), 'QA-DUP', label + ': form kept');
    }
    {
      const { page, posts, dialogs } = await openPage({ latency: 300, reply: { status: 409, json: { detail: C4_DETAIL } } });
      const dialog = await openModal(page);
      await fill(dialog, 'QA-DUP', '192.0.2.1');
      await submitButton(dialog).click();
      await expectBusy(dialog, 'mocked 409');
      await expectRefused(page, dialog, dialogs, C4_DETAIL, 'mocked 409');
      assert.equal(posts.length, 1);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.close();
      checks.push('409 detail (C4 text) is shown, dialog and form stay, submit re-enabled with focus inside');
    }
    {
      const { page, dialogs } = await openPage();
      const dialog = await openModal(page);
      await fill(dialog, 'QA-DUP', before.find(d => d.kind === 'pdu').ip);
      const done = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === DEVICES);
      await submitButton(dialog).click();
      const response = await done;
      if (response.status() === 409) {
        await expectRefused(page, dialog, dialogs, (await response.json()).detail, 'server 409');
        c4 = 'server refuses duplicate address';
        checks.push('fixture backend refuses a duplicate PDU address and the dialog stays open');
      } else {
        assert.equal(response.status(), 201, 'duplicate address: unexpected status');
        await dialog.waitFor({ state: 'detached' });
        c4 = 'backend without C4 (duplicate accepted; device removed again)';
        if (process.env.DCIM_REQUIRE_C4 === '1') assert.fail('Backend accepted a duplicate PDU address (C4 missing)');
      }
      await page.close();
    }

    assert.deepEqual(unexpectedWrites, [], 'only device writes');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    for (const id of created) {
      try {
        const response = await context.request.delete(origin + DEVICES + id, { headers: { 'x-dcim-csrf': csrf } });
        if (![200, 204, 404].includes(response.status())) { errors.push(`cleanup ${response.status()}`); process.exitCode = 1; }
      } catch (error) { errors.push('cleanup ' + error.message); process.exitCode = 1; }
    }
    await browser.close();
  }
  console.log(JSON.stringify({ passed: checks, c4, cleanedUp: created.size, writes: unexpectedWrites, errors }));
})().catch(error => { console.error(error); process.exitCode = 1; });
