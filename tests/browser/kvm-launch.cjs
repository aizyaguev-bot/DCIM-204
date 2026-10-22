const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8774';
// The Tab trap belongs to InlineKvmConsole; set this only to run the other checks on a tree without it.
const skipFocusTrap = process.env.DCIM_SKIP_FOCUS_TRAP === '1';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [];
  const allowedWrite = /^\/api\/kvms\/kvm1\/(ports\/[134]\/mark-(in-use|free)|mark-free)$/;
  // Status polling is slowed to an hour, so an IN USE mark that shows up quickly came from the click itself.
  async function login(username, { blockPopup = false, viewport = { width: 1440, height: 1000 } } = {}) {
    const context = await browser.newContext({ viewport });
    // What's new opens over the page in a fresh profile; it is not under test here.
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
          url.pathname !== '/api/auth/login' && !allowedWrite.test(url.pathname)) {
        unexpectedWrites.push(url.pathname); return route.abort();
      }
      if (url.pathname === '/api/auth/status') {
        const response = await route.fetch();
        const json = await response.json();
        if (json.user?.preferences) json.user.preferences = { ...json.user.preferences, refresh_seconds: 3600 };
        return route.fulfill({ response, json });
      }
      return route.continue();
    });
    if (blockPopup) await context.addInitScript(() => { window.open = () => null; });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    // Any confirm a port in use can raise; tests set the answer and read the messages.
    const dialogs = { answer: true, messages: [] };
    page.on('dialog', dialog => { dialogs.messages.push(dialog.message()); return dialogs.answer ? dialog.accept() : dialog.dismiss(); });
    await page.goto(origin + '/?tab=consoles');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('test-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Remote consoles' }).waitFor();
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    // Reload so the account status (with the slow refresh) is read again; the sign-in cookie stays.
    await page.reload();
    await page.getByText('Auto-refreshes every 3600s').waitFor();
    await page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).waitFor();
    return { context, page, dialogs };
  }
  const marking = (page, action, port = 1) => page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/kvms/kvm1/ports/${port}/${action}` && response.status() === 200);
  const leaseOf = async response => (await response.json()).lease || '';
  // mark-free carries this session's lease, or no body at all when the server gave none.
  function assertFreedWith(response, lease) {
    const body = response.request().postData();
    if (lease) assert.deepEqual(JSON.parse(body), { lease });
    else assert.ok(!body, 'No lease: mark-free has no body');
    assert.ok(new URL(response.url()).pathname.endsWith('/mark-free'), 'The lease never goes in the URL');
  }
  async function portInUse(context, port) {
    const status = await (await context.request.get(origin + '/api/kvms/kvm1/status')).json();
    return !!status.ports.find(p => p.number === port)?.in_use;
  }
  const card = page => page.locator('section[aria-label="KVM 01"]');
  const consoleDialog = page => page.getByRole('dialog', { name: 'KVM console', exact: true });
  try {
    const admin = await login('admin');
    // A mark left by an earlier, interrupted run would hide the check below: restart the fixture then.
    assert.equal(await portInUse(admin.context, 1), false, 'Port 1 starts free (restart the fixture after an interrupted run)');
    await admin.page.locator('section[aria-label="KVM 01"][data-in-use="false"]').waitFor({ timeout: 2000 });
    const popupReady = admin.context.waitForEvent('page');
    const used = marking(admin.page, 'mark-in-use');
    await admin.page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).click();
    const popup = await popupReady;
    await popup.getByRole('heading', { name: 'Console preview' }).waitFor();
    const lease = await leaseOf(await used);
    assert.equal(new URL(popup.url()).pathname, '/api/kvms/kvm1/autologin');
    assert.equal(new URL(popup.url()).searchParams.get('port'), '1');
    await admin.page.locator('section[aria-label="KVM 01"][data-in-use="true"]').waitFor({ timeout: 2000 });
    await card(admin.page).getByText('IN USE', { exact: true }).waitFor({ timeout: 2000 });
    checks.push('IN USE shows within 2 s of opening, with status polling slowed to an hour');
    const freed = marking(admin.page, 'mark-free');
    await popup.close();
    assertFreedWith(await freed, lease);
    await admin.page.locator('section[aria-label="KVM 01"][data-in-use="false"]').waitFor({ timeout: 2000 });
    assert.equal(await portInUse(admin.context, 1), false);
    checks.push('Admin port opens the correct console; closing the popup frees only that port');

    // The banner X clears every port's mark, other people's too: it asks first and names the ports.
    const secondPopup = admin.context.waitForEvent('page');
    await admin.page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).click();
    const popup2 = await secondPopup;
    await card(admin.page).getByText('IN USE', { exact: true }).waitFor({ timeout: 2000 });
    const deviceWide = [];
    admin.page.on('request', request => { if (new URL(request.url()).pathname === '/api/kvms/kvm1/mark-free') deviceWide.push(request.method()); });
    admin.dialogs.answer = false;
    await card(admin.page).getByRole('button', { name: 'Mark KVM free' }).click();
    await admin.page.waitForTimeout(500);
    assert.match(admin.dialogs.messages.at(-1), /KVM 01/);
    assert.match(admin.dialogs.messages.at(-1), /OPT11 \(P1\)/);
    assert.deepEqual(deviceWide, [], 'Cancel sends nothing');
    assert.equal(await portInUse(admin.context, 1), true);
    admin.dialogs.answer = true;
    const cleared = admin.page.waitForResponse(response => new URL(response.url()).pathname === '/api/kvms/kvm1/mark-free' && response.status() === 200);
    await card(admin.page).getByRole('button', { name: 'Mark KVM free' }).click();
    await cleared;
    await admin.page.locator('section[aria-label="KVM 01"][data-in-use="false"]').waitFor({ timeout: 2000 });
    const freed2 = marking(admin.page, 'mark-free');
    await popup2.close(); await freed2;
    checks.push('Mark KVM free asks first, lists the ports it clears, and Cancel keeps the marks');
    await admin.context.close();

    const operator = await login('operator', { blockPopup: true });
    for (const source of ['card', 'details']) {
      if (source === 'details') {
        await operator.page.getByRole('button', { name: 'Details →' }).click();
        await operator.page.evaluate(() => { window.open = () => { throw new Error('Popup refused'); }; });
      }
      const used = marking(operator.page, 'mark-in-use');
      if (source === 'card') await operator.page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).click();
      else await operator.page.getByRole('button', { name: /OPT11/ }).click();
      await consoleDialog(operator.page).waitFor();
      await operator.page.frameLocator('iframe[title="KVM console viewer"]').getByRole('heading', { name: 'Console preview' }).waitFor();
      const lease = await leaseOf(await used);
      assert.equal(operator.context.pages().length, 1, 'No new page when popups are blocked');
      assert.equal(new URL(operator.page.url()).searchParams.get('tab'), 'consoles', 'Existing app navigation is preserved');
      const freed = marking(operator.page, 'mark-free');
      await operator.page.getByRole('button', { name: 'Close KVM console' }).click();
      assertFreedWith(await freed, lease);
      assert.equal(await consoleDialog(operator.page).count(), 0);
      checks.push('Operator ' + source + ': popup refusal opens an inline console and preserves the application');
    }

    // Still on the KVM details: an inline console on P3, then a second console replaces it.
    const used3 = marking(operator.page, 'mark-in-use', 3);
    await operator.page.getByRole('button', { name: /OPT13/ }).click();
    await consoleDialog(operator.page).waitFor();
    const lease3 = await leaseOf(await used3);
    if (skipFocusTrap) checks.push('SKIPPED: inline console Tab trap (DCIM_SKIP_FOCUS_TRAP=1)');
    else {
      const inDialog = () => operator.page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="KVM console"]'));
      for (const key of [...Array(30).fill('Tab'), ...Array(30).fill('Shift+Tab')]) {
        await operator.page.keyboard.press(key);
        assert.equal(await inDialog(), true, `${key} keeps focus inside the console dialog`);
      }
      checks.push('Inline console: 30 Tab and 30 Shift+Tab stay inside the dialog');
    }
    const freed3 = marking(operator.page, 'mark-free', 3);
    const used1 = marking(operator.page, 'mark-in-use', 1);
    // A click that reaches a port behind the console (script, assistive tech) replaces the console.
    await operator.page.evaluate(() => [...document.querySelectorAll('main button')].find(button => /OPT11/.test(button.textContent)).click());
    assertFreedWith(await freed3, lease3);
    const lease1 = await leaseOf(await used1);
    await consoleDialog(operator.page).getByText('Port 1').waitFor();
    assert.equal(await portInUse(operator.context, 3), false);
    const freed1 = marking(operator.page, 'mark-free', 1);
    await operator.page.keyboard.press('Escape');
    assertFreedWith(await freed1, lease1);
    assert.equal(await consoleDialog(operator.page).count(), 0);
    await operator.page.getByText('Edit Labels').waitFor();
    checks.push('Replacing an inline console frees the port it held; Escape frees the new one and stays on the page');
    await operator.context.close();

    // Phone, popups blocked: Back closes the console before it leaves the page; leaving the page frees the port.
    const phone = await login('operator', { blockPopup: true, viewport: { width: 375, height: 812 } });
    await phone.page.getByRole('button', { name: 'Details →' }).click();
    const used4 = marking(phone.page, 'mark-in-use', 4);
    await phone.page.getByRole('button', { name: /OPT14/ }).click();
    await consoleDialog(phone.page).waitFor();
    const lease4 = await leaseOf(await used4);
    const freed4 = marking(phone.page, 'mark-free', 4);
    await phone.page.goBack();
    assertFreedWith(await freed4, lease4);
    assert.equal(await consoleDialog(phone.page).count(), 0);
    await phone.page.getByText('Edit Labels').waitFor();
    await phone.page.goBack();
    await phone.page.getByRole('heading', { name: 'Remote consoles' }).waitFor();
    assert.equal(await phone.page.getByText('Edit Labels').count(), 0);
    checks.push('Phone: Back closes the console and frees its port; a second Back returns to the list');
    const reopened = marking(phone.page, 'mark-in-use', 4);
    await phone.page.locator('.kvm-port-tile').filter({ hasText: 'OPT14' }).click();
    await consoleDialog(phone.page).waitFor();
    await reopened;
    assert.equal(await portInUse(phone.context, 4), true);
    await phone.page.goto('about:blank');
    for (let i = 0; i < 25 && await portInUse(phone.context, 4); i++) await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await portInUse(phone.context, 4), false, 'Leaving the page frees the inline console port');
    checks.push('Phone: leaving the page with an inline console open frees its port');
    await phone.context.close();

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
