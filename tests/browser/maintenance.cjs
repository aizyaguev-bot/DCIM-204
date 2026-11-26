const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';

// Outlet states the browser sees for a PDU; the fixture's own live read (used by the server) is not changed.
const ROUTED = {
  pdu1: { 1: 'on', 2: 'on', 3: 'unknown', 4: 'cycling' },
  pdu3: { 1: 'on', 2: 'off', 3: 'on', 4: 'off' },
};
const WARNING = /unknown or cycling state and will not be switched off/;

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    // What's new opens over the page in a fresh profile; it is not under test here.
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
          url.pathname !== '/api/auth/login' &&
          !/^\/api\/pdus\/pdu1\/maintenance\/(shutdown|restore)$/.test(url.pathname)) {
        unexpectedWrites.push(request.method() + ' ' + url.pathname); return route.abort();
      }
      const routed = /^\/api\/pdus\/(pdu\d+)\/status$/.exec(url.pathname);
      if (request.method() === 'GET' && routed && ROUTED[routed[1]]) {
        const response = await route.fetch();
        const json = await response.json();
        json.outlets = json.outlets.map(o => ({ ...o, state: ROUTED[routed[1]][o.number] || o.state }));
        return route.fulfill({ response, json });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?tab=power');
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill('test-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Power distribution units' }).waitFor();
    const state = await (await context.request.get(origin + '/api/pdus/maintenance')).json();
    assert.equal(state.password_mode, 'account');
    assert.equal(state.pdus.pdu1, undefined, 'PDU 01 must start outside maintenance; restart the fixture');

    async function openDialog(action, pdu, title) {
      const opener = page.getByRole('button', { name: `${action} on ${pdu}`, exact: true });
      await opener.waitFor();
      await opener.click();
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await dialog.waitFor();
      return dialog;
    }
    async function cancel(dialog) {
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    }
    const desc = dialog => dialog.locator('#maint-dialog-desc');

    // Wait until the column shows the routed states, so the dialog is opened with them.
    await page.locator('aside li').filter({ hasText: 'PDU 01' }).getByText('2 / 4 outlets on', { exact: true }).waitFor();
    await page.locator('aside li').filter({ hasText: 'PDU 03' }).getByText('2 / 4 outlets on', { exact: true }).waitFor();
    let dialog = await openDialog('Shut down all outlets', 'PDU 01', 'Shut down all outlets');
    assert.match(await desc(dialog).innerText(), /2 of 4 outlets are on and will be switched off\./);
    const warning = desc(dialog).getByRole('alert');
    assert.equal(await warning.count(), 1);
    const text = await warning.innerText();
    assert.match(text, /^2 outlets are in an unknown or cycling state and will not be switched off\. They may still carry power:/);
    assert.match(text, /3 OPT13 \(unknown\)/);
    assert.match(text, /4 OPT14 \(cycling\)/);
    assert.doesNotMatch(text, /OPT1[12]/, 'Outlets that are on are not listed as uncertain');
    assert.equal(await page.evaluate(() => document.activeElement?.placeholder), 'e.g. Rack rewiring', 'The warning does not take focus from Reason');
    const described = await page.evaluate(() => {
      const panel = document.querySelector('[role=dialog]');
      return document.getElementById(panel.getAttribute('aria-describedby'))?.querySelector('[role=alert]')?.textContent || '';
    });
    assert.match(described, WARNING, 'The warning is part of the dialog description');
    checks.push('Shutdown: keeps "2 of 4 outlets are on" and warns about OPT13 (unknown) and OPT14 (cycling)');

    // The submit flow still works with the warning shown; the fixture switches its own simulated outlets.
    await dialog.getByLabel('Reason').fill('Browser check B20');
    await dialog.getByLabel('Your account password', { exact: true }).fill('test-password-123');
    await dialog.getByRole('button', { name: 'Shut down all outlets', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    checks.push('Shutdown with the warning shown still submits and closes');

    dialog = await openDialog('Restore power', 'PDU 01', 'Restore power');
    assert.match(await desc(dialog).innerText(), /4 outlets that were on before maintenance will be switched on\./);
    assert.equal(await dialog.getByRole('alert').count(), 0);
    assert.doesNotMatch(await dialog.innerText(), WARNING);
    checks.push('Restore: no unknown/cycling warning even when the status shows such outlets');
    await dialog.getByLabel('Your account password', { exact: true }).fill('test-password-123');
    await dialog.getByRole('button', { name: 'Restore power', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Shut down all outlets on PDU 01', exact: true }).waitFor();
    checks.push('Restore submits and returns PDU 01 to normal');

    for (const [pdu, expected] of [['PDU 03', /2 of 4 outlets are on/], ['PDU 02', /4 of 4 outlets are on/]]) {
      dialog = await openDialog('Shut down all outlets', pdu, 'Shut down all outlets');
      assert.match(await desc(dialog).innerText(), expected);
      assert.equal(await dialog.getByRole('alert').count(), 0);
      assert.doesNotMatch(await dialog.innerText(), WARNING);
      await cancel(dialog);
    }
    checks.push('Shutdown with outlets only on or off: no warning');

    dialog = await openDialog('Shut down all outlets', 'PDU 07', 'Shut down all outlets');
    const alerts = dialog.getByRole('alert');
    assert.equal(await alerts.count(), 1);
    assert.match(await alerts.innerText(), /^This PDU is unreachable/);
    assert.doesNotMatch(await dialog.innerText(), WARNING);
    await cancel(dialog);
    checks.push('Unreachable PDU: only the existing unreachable message');

    await page.setViewportSize({ width: 375, height: 812 });
    dialog = await openDialog('Shut down all outlets', 'PDU 01', 'Shut down all outlets');
    await desc(dialog).getByRole('alert').waitFor();
    const fits = await page.evaluate(() => {
      const panel = document.querySelector('[role=dialog]');
      return { page: document.documentElement.scrollWidth, panel: panel.scrollWidth - panel.clientWidth };
    });
    assert.ok(fits.page <= 375 && fits.panel <= 0, 'The warning fits at 375 px: ' + JSON.stringify(fits));
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    checks.push('Phone width: the warning wraps inside the dialog; Escape closes it');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedWrites, [], 'Only the PDU 01 maintenance actions may write');
    console.log(JSON.stringify({ passed: checks, errors }, null, 2));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
