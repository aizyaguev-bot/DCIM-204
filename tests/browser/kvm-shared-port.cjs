// Two people on one KVM port: each console holds its own lease, so one closing never frees the other.
// Needs the lease server (kvms.py, contract C1), the in-use port tile (KvmDetail) and the App console lifecycle.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8774';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [];
  async function login(username, blockPopup = false) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
          url.pathname !== '/api/auth/login' && !/^\/api\/kvms\/kvm1\/ports\/1\/mark-(in-use|free)$/.test(url.pathname)) {
        unexpectedWrites.push(url.pathname); return route.abort();
      }
      return route.continue();
    });
    if (blockPopup) await context.addInitScript(() => { window.open = () => null; });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const dialogs = { answer: true, messages: [] };
    page.on('dialog', dialog => { dialogs.messages.push(dialog.message()); return dialogs.answer ? dialog.accept() : dialog.dismiss(); });
    await page.goto(origin + '/?tab=consoles');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('test-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Remote consoles' }).waitFor();
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    await page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).waitFor();
    return { context, page, dialogs };
  }
  const marking = (page, action) => page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/kvms/kvm1/ports/1/' + action && response.status() === 200);
  async function port1(context) {
    const status = await (await context.request.get(origin + '/api/kvms/kvm1/status')).json();
    return status.ports.find(p => p.number === 1);
  }
  try {
    const admin = await login('admin');
    const popupReady = admin.context.waitForEvent('page');
    const adminUsed = marking(admin.page, 'mark-in-use');
    await admin.page.locator('.kvm-port-tile').filter({ hasText: 'OPT11' }).click();
    const popup = await popupReady;
    const adminLease = (await (await adminUsed).json()).lease;
    assert.match(adminLease || '', /^[0-9a-f]{32}$/, 'mark-in-use returns a lease');
    checks.push('Admin console on port 1 holds a lease');

    // The operator signs in afterwards, so the first status already shows the admin's console.
    const operator = await login('operator', true);
    await operator.page.getByRole('button', { name: 'Details →' }).click();
    const tile = operator.page.locator('[data-in-use="true"]').filter({ hasText: 'OPT11' });
    await tile.waitFor();
    assert.match(await tile.getAttribute('title'), /In use/);
    const writes = [];
    operator.page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
    operator.dialogs.answer = false;
    await operator.page.getByRole('button', { name: /OPT11/ }).click();
    await operator.page.waitForTimeout(500);
    assert.equal(operator.dialogs.messages.length, 1, 'An in-use port asks before opening');
    assert.match(operator.dialogs.messages[0], /OPT11/);
    assert.deepEqual(writes, [], 'Cancel marks nothing');
    assert.equal(await operator.page.getByRole('dialog', { name: 'KVM console', exact: true }).count(), 0, 'Cancel opens nothing');
    checks.push('Operator sees the port in use and Cancel opens nothing');

    operator.dialogs.answer = true;
    const operatorUsed = marking(operator.page, 'mark-in-use');
    await operator.page.getByRole('button', { name: /OPT11/ }).click();
    await operator.page.getByRole('dialog', { name: 'KVM console', exact: true }).waitFor();
    const operatorLease = (await (await operatorUsed).json()).lease;
    assert.notEqual(operatorLease, adminLease);
    assert.equal((await port1(operator.context)).in_use, true);
    const operatorFreed = marking(operator.page, 'mark-free');
    await operator.page.getByRole('button', { name: 'Close KVM console' }).click();
    const freedRequest = (await operatorFreed).request();
    assert.deepEqual(JSON.parse(freedRequest.postData()), { lease: operatorLease });
    assert.equal((await port1(operator.context)).in_use, true, "Closing the operator's console keeps the admin's mark");
    checks.push("Closing the operator's console keeps the port in use while the admin console is open");

    const adminFreed = marking(admin.page, 'mark-free');
    await popup.close();
    assert.deepEqual(JSON.parse((await adminFreed).request().postData()), { lease: adminLease });
    assert.equal((await port1(admin.context)).in_use, false, 'The port is free once both consoles closed');
    checks.push('The port is free after the admin closes too');
    await operator.context.close();
    await admin.context.close();
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedWrites, [], 'Only the port markers are written');
    console.log(JSON.stringify({ passed: checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
