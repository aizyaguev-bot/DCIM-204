// The lab window shell (one-place spec v1 WP-0 and v2 WP-0): ?srv= and ?open= open a window over the current tab,
// Back / Escape / × close it, a reload reopens it, a tab change drops it, Viewers read only, only the twin's frame may
// ask for a window, and nothing scrolls sideways. Fixture: DCIM_TEST_ACCOUNTS=1 DCIM_FIXTURE_ONE_PLACE=1. Read-only.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9600';
const PASSWORD = 'test-password-123';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], writes = [];
  async function login(username, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const answer = await context.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(answer.status(), 200, `${username} signs in`);
    assert.equal((await (await context.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${username}: ${e.message}`));
    page.on('request', r => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && !/\/api\/auth\//.test(r.url())) writes.push(`${username} ${r.method()} ${new URL(r.url()).pathname}`); });
    return { context, page };
  }
  const win = (page, kind) => page.locator(kind ? `[data-window="${kind}"]` : '[data-window]');
  const param = (page, name) => new URL(page.url()).searchParams.get(name);
  async function noSideScroll(page, label) {
    const size = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth,
      panel: (() => { const w = document.querySelector('[data-window]'); return w ? w.scrollWidth - w.clientWidth : 0; })() }));
    assert.ok(size.doc <= size.view && size.panel <= 0, `${label}: no horizontal scroll ${JSON.stringify(size)}`);
  }

  try {
    const admin = await login('admin');
    const devices = await (await admin.context.request.get(origin + '/api/devices/')).json();
    assert.ok(devices.some(d => d.id === 'pdu8'), 'Start the fixture with DCIM_FIXTURE_ONE_PLACE=1 (PDU-Rack-08 is missing)');
    const page = admin.page;

    // 1. ?srv= over Dashboard: the window, its name and fact line; Back closes it and stays on Dashboard; Forward and a
    //    reload reopen it.
    await page.goto(origin + '/?tab=dashboard');
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    await page.goto(origin + '/?tab=dashboard&srv=opt11');
    const server = win(page, 'server');
    await server.waitFor();
    assert.equal(await server.getAttribute('role'), 'dialog');
    assert.equal(await server.getAttribute('aria-modal'), 'true');
    const facts = server.locator('[data-facts]');
    await facts.getByText('Rack-01 · floor 1', { exact: true }).waitFor();
    assert.equal((await server.locator('h2').innerText()).trim(), 'OPT11', 'named as the label says, once loaded');
    for (const fact of ['PDU 01 · outlet 1', 'KVM 01 · port 1', 'Owner: Fixture owner']) await facts.getByText(fact, { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: 'OPT11' }).count(), 1, 'the window is named by its server');
    assert.equal(await page.getByRole('heading', { name: 'Dashboard', exact: true }).count(), 0, 'the page behind is hidden from assistive technology');
    assert.equal(await page.locator('[data-window-backdrop][inert]').count(), 1, 'and inert');
    checks.push('?tab=dashboard&srv=opt11 opens [data-window=server] "OPT11" with Rack-01 · floor 1, PDU 01 · outlet 1, KVM 01 · port 1 and the owner');
    await page.goBack();
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    assert.equal(await win(page).count(), 0, 'Back closes the window');
    assert.equal(param(page, 'tab'), 'dashboard');
    await page.goForward();
    await server.waitFor();
    await page.reload();
    await server.waitFor();
    await server.locator('h2', { hasText: 'OPT11' }).waitFor();
    checks.push('Back closes it and stays on Dashboard; Forward and a reload with srv reopen it');

    // 2. Escape and × close it; closing a window this page opened goes back over its own history entry.
    await page.keyboard.press('Escape');
    await win(page).waitFor({ state: 'detached' });
    assert.equal(param(page, 'srv'), null, 'Escape drops srv from the address');
    await page.locator('section[aria-label="PDU 01"]').getByRole('button', { name: 'Details →' }).click();
    const pdu = win(page, 'pdu');
    await pdu.waitFor();
    assert.equal(param(page, 'open'), 'dev:pdu1');
    const length = await page.evaluate(() => history.length);
    await pdu.getByRole('button', { name: 'Close', exact: true }).click();
    await win(page).waitFor({ state: 'detached' });
    assert.equal(param(page, 'open'), null);
    assert.equal(await page.evaluate(() => history.length), length, 'no new history entry for closing');
    await page.goForward();
    await pdu.waitFor();
    await page.goBack();
    await win(page).waitFor({ state: 'detached' });
    checks.push('Escape and × close the window; Details → opens open=dev:pdu1 over Dashboard, × goes back over its entry');

    // 3. A key that is no server: "No server named"; an unknown window kind opens nothing.
    await page.goto(origin + '/?tab=dashboard&srv=kvm%20power');
    await win(page, 'server').getByText('No server named', { exact: false }).waitFor();
    await win(page, 'server').getByLabel('Find a server').fill('opt1');
    await win(page, 'server').getByRole('button', { name: 'OPT12', exact: true }).click();
    await win(page, 'server').locator('h2', { hasText: 'OPT12' }).waitFor();
    assert.equal(param(page, 'srv'), 'opt12', 'the search opens the server it found in place');
    await page.goto(origin + '/?tab=dashboard&open=bogus:1');
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    assert.equal(await win(page).count(), 0);
    checks.push('srv=kvm%20power shows "No server named" with a search that opens OPT12; open=bogus:1 opens nothing');

    // 4. v2 windows of other kinds: open=dev:pdu8 (Back closes it), open=unit:u-pc300, open=twin:ITEM-0044.
    await page.goto(origin + '/?tab=dashboard');
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    await page.goto(origin + '/?tab=dashboard&open=dev:pdu8');
    await win(page, 'pdu').waitFor();
    assert.equal((await win(page, 'pdu').locator('h2').first().innerText()).trim(), 'PDU-Rack-08');
    await page.goBack();
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    assert.equal(await win(page).count(), 0, 'Back closes the PDU window');
    await page.goto(origin + '/?tab=dashboard&open=unit:u-pc300');
    await win(page, 'unit').locator('h2', { hasText: 'OPT300' }).waitFor();
    await page.goto(origin + '/?tab=dashboard&open=twin:ITEM-0044');
    await win(page, 'twin').locator('h2', { hasText: 'Blue mobile stand' }).waitFor();
    await win(page, 'twin').getByText('3D only', { exact: true }).first().waitFor();
    checks.push('open=dev:pdu8 opens [data-window=pdu] (Back closes it); open=unit:u-pc300 [data-window=unit]; open=twin:ITEM-0044 [data-window=twin]');

    // 5. A tab change drops the window: the Racks tab while OPT11's window is open.
    await page.goto(origin + '/?tab=dashboard&srv=opt11');
    await win(page, 'server').waitFor();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Racks', exact: true }).click();
    await win(page).waitFor({ state: 'detached' });
    assert.equal(param(page, 'tab'), 'racks');
    assert.equal(param(page, 'srv'), null, 'the Racks tab drops srv');
    checks.push('clicking the Racks tab closes the window and drops srv');

    // 6. Only the twin's frame may ask for a window.
    await page.goto(origin + '/?tab=dashboard');
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    await page.evaluate(() => {
      window.postMessage({ type: 'twin:open-server', key: 'opt12' }, location.origin);
      window.postMessage({ type: 'twin:open', target: { kind: 'server', id: 'opt12' } }, location.origin);
    });
    await page.waitForTimeout(500);
    assert.equal(await win(page).count(), 0, 'a message from another window is ignored');
    await page.goto(origin + '/?tab=twin');
    const frame = page.frameLocator('iframe[title="3D Digital Twin"]');
    await frame.locator('body').waitFor();
    const twinFrame = page.frames().find(f => f.url().includes('/twin/'));
    assert.ok(twinFrame, 'the twin frame loaded');
    await twinFrame.evaluate(() => parent.postMessage({ type: 'twin:open', target: { kind: 'server', id: 'opt12' } }, location.origin));
    await win(page, 'server').locator('h2', { hasText: 'OPT12' }).waitFor();
    assert.equal(param(page, 'tab'), 'twin', 'the window opens over the Twin tab');
    assert.equal(param(page, 'srv'), 'opt12');
    await page.keyboard.press('Escape');
    await win(page).waitFor({ state: 'detached' });
    checks.push('postMessage from the page itself is ignored; the twin frame\'s twin:open opens OPT12 over the Twin tab');

    // 7. Viewer: the window opens and reads "Viewer · read only".
    const viewer = await login('viewer');
    await viewer.page.goto(origin + '/?tab=dashboard&srv=opt53');
    await win(viewer.page, 'server').locator('h2', { hasText: 'OPT53' }).waitFor();
    await win(viewer.page, 'server').getByText('Viewer · read only', { exact: true }).waitFor();
    await win(viewer.page, 'server').getByText('Feeds disagree', { exact: false }).waitFor();
    assert.equal(await win(viewer.page, 'server').getByRole('button', { name: '⋯ More' }).count(), 0);
    await viewer.context.close();
    const operator = await login('operator');
    await operator.page.goto(origin + '/?tab=dashboard&srv=opt74');
    await win(operator.page, 'server').getByText('Removed · read only', { exact: true }).waitFor();
    await win(operator.page, 'server').getByText('Removed from the lab', { exact: false }).waitFor();
    await operator.page.goto(origin + '/?tab=dashboard&srv=opt98');
    await win(operator.page, 'server').locator('h2', { hasText: 'OPT98' }).waitFor();
    await win(operator.page, 'server').getByText('Removed from the lab', { exact: false }).waitFor();
    await operator.context.close();
    checks.push('Viewer sees "Viewer · read only" (and the two-PSU owner note); a removed server, also one with no row left, is read-only');

    // 8. No horizontal scroll at 1440, 1280, 1024, 390 and 375 px with the window open.
    for (const width of [1440, 1280, 1024, 390, 375]) {
      await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
      await page.goto(origin + '/?tab=racks&srv=opt53');
      await win(page, 'server').locator('h2', { hasText: 'OPT53' }).waitFor();
      await page.waitForTimeout(250);
      await noSideScroll(page, `${width} px`);
      const box = await win(page, 'server').boundingBox();
      if (width >= 1280) assert.ok(Math.abs(box.width - 600) <= 2 && box.x + box.width >= width - 2, `${width} px: a 600 px right drawer ${JSON.stringify(box)}`);
      else if (width <= 640) assert.ok(box.width >= width - 1, `${width} px: a full-screen sheet`);
    }
    checks.push('no horizontal scroll at 1440 / 1280 / 1024 / 390 / 375 px; a 600 px drawer from 1280 px, a full sheet on phones');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(writes, [], 'Opening windows writes nothing');
    console.log(JSON.stringify({ passed: checks }, null, 2));
    await admin.context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
