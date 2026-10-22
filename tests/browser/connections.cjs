// Admin > Connections on the isolated fixture (SWEEP B16):
// CONN-1 — a power change made in another session appears without a Refresh click (account auto-refresh, 15 s by
//          default); a failed background refresh keeps the rows and says so, and the next refresh clears it.
// CONN-3 — search does not match hidden device ids ("U3" used to find every outlet of pdu3).
// CONN-6 — a Hebrew server label saved through PDU–KVM mapping is shown with dir="auto", right to left.
// Writes only fixture data: one simulated outlet power-off (PDU 01 outlet 2) and one outlet label (PDU 02 outlet 3).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8946';
const HEBREW = 'שרת בדיקה QA';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [];
  const allowedWrites = [/^\/api\/auth\/login$/, /^\/api\/pdus\/pdu1\/outlets\/2\/power$/, /^\/api\/devices\/direct-label$/];
  async function login(username, url) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // What's new opens over the page in a fresh profile; it is not under test here.
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const path = new URL(request.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !allowedWrites.some(rule => rule.test(path))) {
        unexpectedWrites.push(`${request.method()} ${path}`); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + url);
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('test-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    return { context, page };
  }
  try {
    // Session B (another tab/person) opens the dashboard first, so the PDU status cache is warm.
    const other = await login('admin', '/?tab=dashboard');
    await other.page.getByRole('region', { name: 'PDU 01' }).waitFor();

    const watcher = await login('admin', '/?tab=connections');
    const page = watcher.page;
    let connectionLoads = 0, refreshClicks = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/devices/connections') connectionLoads++; });
    await page.exposeFunction('__countRefreshClick', () => { refreshClicks++; });
    await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor();
    await page.evaluate(() => document.addEventListener('click', event => {
      const button = event.target.closest?.('button');
      if (button && ['Refresh', 'Retry'].includes(button.textContent.trim())) window.__countRefreshClick();
    }, true));
    const summary = page.getByText(/^\d+ of \d+ servers · CSV includes all servers$/);
    await summary.waitFor();
    // v2.41.0 puts the SSH button inside the row header, so its accessible name is "<server> SSH to <server> …".
    const headerName = name => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*SSH\\b.*)?$`);
    const row = name => page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: headerName(name) }) });
    const opt12Pdu = row('OPT12').getByRole('listitem').filter({ hasText: 'PDU 01' });
    await opt12Pdu.getByText('on', { exact: true }).waitFor({ timeout: 20000 });
    const updated = page.getByText(/^Updated /);
    const firstUpdated = await updated.textContent();
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');

    // CONN-3: no fixture server sits in U3, so "U3" must not match the hidden id of pdu3 (OPT31–OPT34).
    const search = page.getByRole('searchbox', { name: 'Search connections' });
    await search.fill('U3');
    await page.getByText('No servers match the selected filters.').waitFor();
    assert.match(await summary.textContent(), /^0 of \d+ servers/);
    assert.equal(await page.getByRole('rowheader').count(), 0);
    await search.fill('pdu3');
    await page.getByText('No servers match the selected filters.').waitFor();
    await search.fill('PDU 03');
    await row('OPT31').waitFor();
    assert.equal(await page.getByRole('rowheader').count(), 4, 'the shown device name still finds its four servers');
    await search.fill('');
    checks.push('search "U3" and "pdu3" return 0 (hidden device ids), the shown name "PDU 03" still finds OPT31–34');

    // CONN-1: power OPT12 off from the other session; this tab must show it without a Refresh click.
    const loadsBefore = connectionLoads;
    other.page.once('dialog', dialog => { assert.match(dialog.message(), /Power off OPT12/); dialog.accept(); });
    await other.page.getByRole('region', { name: 'PDU 01' }).getByRole('button', { name: 'Details →' }).click();
    const powered = other.page.waitForResponse(response => new URL(response.url()).pathname === '/api/pdus/pdu1/outlets/2/power' && response.status() === 200);
    await other.page.locator('button[aria-label="Power off OPT12"]:visible').click();
    await powered;
    const switchedAt = Date.now();
    await opt12Pdu.getByText('off', { exact: true }).waitFor({ timeout: 35000 });
    const seconds = (Date.now() - switchedAt) / 1000;
    assert.ok(seconds <= 35, `shown within 35 s (took ${seconds.toFixed(1)} s)`);
    assert.notEqual(await updated.textContent(), firstUpdated, 'the Updated time moved on');
    assert.ok(connectionLoads > loadsBefore, 'a background request reloaded the list');
    assert.equal(refreshClicks, 0, 'no Refresh click');
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    checks.push(`power-off in another session shown as "off" after ${seconds.toFixed(1)} s with no Refresh click; Updated changed`);

    // CONN-1: a failed background refresh keeps the rows and explains; the next good refresh removes the banner.
    await page.route('**/api/devices/connections', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"detail":"Fixture: upstream unavailable"}' }));
    const banner = page.getByRole('alert').filter({ hasText: 'Could not refresh connections' });
    await banner.waitFor({ timeout: 25000 });
    assert.match(await banner.textContent(), /Fixture: upstream unavailable\. Showing the list from the last successful update\./);
    assert.ok(await row('OPT12').isVisible(), 'rows stay on screen after a failed refresh');
    assert.ok(await opt12Pdu.getByText('off', { exact: true }).isVisible());
    await page.unroute('**/api/devices/connections');
    await banner.waitFor({ state: 'detached', timeout: 25000 });
    assert.equal(refreshClicks, 0, 'the banner cleared by itself');
    checks.push('a failed background refresh keeps the rows with an explanation; the next refresh clears it');

    // CONN-6: a Hebrew label saved through PDU–KVM mapping.
    await other.page.goto(origin + '/?tab=sync');
    await other.page.getByRole('button', { name: 'Edit PDU 02 outlet 3 (OPT23)', exact: true }).click();
    await other.page.getByLabel('OPT label for PDU 02 outlet 3', { exact: true }).fill(HEBREW);
    const saved = other.page.waitForResponse(response => new URL(response.url()).pathname === '/api/devices/direct-label' && response.status() === 200);
    await other.page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const header = page.getByRole('rowheader', { name: headerName(HEBREW) });
    await header.waitFor();
    const direction = locator => locator.evaluate(element => ({ dir: element.getAttribute('dir'), css: getComputedStyle(element).direction, rtl: element.matches(':dir(rtl)') }));
    assert.deepEqual(await direction(header), { dir: 'auto', css: 'rtl', rtl: true }, 'server name cell');
    const label = row(HEBREW).locator('li div[dir="auto"]').filter({ hasText: HEBREW });
    assert.deepEqual(await direction(label), { dir: 'auto', css: 'rtl', rtl: true }, 'outlet label');
    assert.deepEqual(await direction(row('OPT12').getByRole('rowheader')), { dir: 'auto', css: 'ltr', rtl: false }, 'a Latin name stays left to right');
    await page.setViewportSize({ width: 375, height: 812 });
    const card = page.getByRole('heading', { level: 2, name: HEBREW, exact: true });
    await card.waitFor();
    assert.deepEqual(await direction(card), { dir: 'auto', css: 'rtl', rtl: true }, 'phone card title');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll at 375 px');
    checks.push('Hebrew label from mapping: dir=auto and right to left in the table, the outlet label and the 375 px card');

    assert.deepEqual(unexpectedWrites, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: checks, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
