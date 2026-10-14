const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8774';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [];
  async function login(username, blockPopup = false) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
          url.pathname !== '/api/auth/login' &&
          !/^\/api\/kvms\/kvm1\/ports\/1\/mark-(in-use|free)$/.test(url.pathname)) {
        unexpectedWrites.push(url.pathname); return route.abort();
      }
      return route.continue();
    });
    if (blockPopup) await context.addInitScript(() => { window.open = () => null; });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?tab=consoles');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('test-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Remote consoles' }).waitFor();
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    await page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).waitFor();
    return { context, page };
  }
  const marking = (page, action) => page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/kvms/kvm1/ports/1/' + action && response.status() === 200);
  try {
    const admin = await login('admin');
    const popupReady = admin.context.waitForEvent('page');
    const used = marking(admin.page, 'mark-in-use');
    await admin.page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).click();
    const popup = await popupReady;
    await popup.getByRole('heading', { name: 'Console preview' }).waitFor();
    await used;
    assert.equal(new URL(popup.url()).pathname, '/api/kvms/kvm1/autologin');
    assert.equal(new URL(popup.url()).searchParams.get('port'), '1');
    const freed = marking(admin.page, 'mark-free');
    await popup.close(); await freed;
    checks.push('Admin port opens the correct console; closing the popup frees only that port');
    await admin.context.close();

    const operator = await login('operator', true);
    for (const source of ['card', 'details']) {
      if (source === 'details') {
        await operator.page.getByRole('button', { name: 'Details →' }).click();
        await operator.page.evaluate(() => { window.open = () => { throw new Error('Popup refused'); }; });
      }
      const used = marking(operator.page, 'mark-in-use');
      if (source === 'card') await operator.page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).click();
      else await operator.page.getByRole('button', { name: /OPT11/ }).click();
      await operator.page.getByRole('dialog', { name: 'KVM console', exact: true }).waitFor();
      await operator.page.frameLocator('iframe[title="KVM console viewer"]').getByRole('heading', { name: 'Console preview' }).waitFor();
      await used;
      assert.equal(operator.context.pages().length, 1, 'No new page when popups are blocked');
      assert.equal(new URL(operator.page.url()).searchParams.get('tab'), 'consoles', 'Existing app navigation is preserved');
      const freed = marking(operator.page, 'mark-free');
      await operator.page.getByRole('button', { name: 'Close KVM console' }).click();
      await freed;
      assert.equal(await operator.page.getByRole('dialog', { name: 'KVM console', exact: true }).count(), 0);
      checks.push('Operator ' + source + ': popup refusal opens an inline console and preserves the application');
    }
    await operator.context.close();

    const viewer = await login('viewer');
    assert.equal(await viewer.page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).isDisabled(), true);
    await viewer.page.getByText('לפתיחת קונסול KVM נדרשת הרשאת Operator או Admin. החשבון הנוכחי הוא לצפייה בלבד.').waitFor();
    await viewer.page.getByRole('button', { name: 'Details →' }).click();
    assert.equal(await viewer.page.getByRole('button', { name: /OPT11/ }).isDisabled(), true);
    await viewer.page.getByText('לפתיחת קונסול KVM נדרשת הרשאת Operator או Admin. החשבון הנוכחי הוא לצפייה בלבד.').waitFor();
    checks.push('Viewer access stays disabled and explains the required role on both views');
    await viewer.context.close();
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedWrites, [], 'Opening consoles must not write inventory or other equipment');
    console.log(JSON.stringify({ passed: checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
