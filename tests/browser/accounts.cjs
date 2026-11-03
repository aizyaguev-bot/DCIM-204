// Accounts frontend, end to end in Microsoft Edge against tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1
// (temporary data, no hardware). Covers:
//   ACC-1 a role or status change needs a confirm (arrow keys on the role select, Disable and Enable);
//   ACC-3 a session ended underneath the page: explained, page kept under an inert overlay, same user keeps unsaved
//         input, another user gets a fresh page, a deliberate Sign out shows no message;
//   ACC-5 Sign out after the session was already revoked ends on the sign-in screen without an error;
//   ACC-2 a sign-out or sign-in in a second tab reaches the first tab within 2 s (timed from the server's answer), the
//         notice sits in the page flow and stays until dismissed, and a legitimate 403 costs one status check.
// It changes only fixture users (roles and enabled flags, restored) and their sessions. Restart the fixture before
// repeating it. DEBUG_ACCOUNTS=1 prints each tab's sign-in traffic with timestamps.
//
//   DCIM_TEST_ACCOUNTS=1 DCIM_PREVIEW_DIST=<built frontend> python tests/browser/preview-server.py 8942
//   DCIM_PREVIEW_URL=http://127.0.0.1:8942 node tests/browser/accounts.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8942';
const PASSWORD = 'test-password-123';
const MARKER = 'LOCAL PREVIEW - TEST DATA';
const ENDED = 'Your session ended: it expired or an administrator changed your account.';
const KEPT = 'Unsaved input on this page is kept if you sign in as the same user.';
// The only writes this check may send.
const ALLOWED = [/^POST \/api\/auth\/(login|logout)$/, /^PATCH \/api\/users\/(viewer|operator)$/, /^PUT \/api\/me\/preferences$/];

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], patches = [];
  const started = Date.now();
  const passed = { push: line => { passed.lines.push(line); console.log(`ok ${((Date.now() - started) / 1000).toFixed(0)} s  ${line}`); }, lines: [] };

  async function newContext() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // What's new opens over the page in a fresh profile; it is not under test here.
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const line = `${request.method()} ${new URL(request.url()).pathname}`;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !ALLOWED.some(rule => rule.test(line))) {
        errors.push('unexpected write: ' + line); return route.abort();
      }
      return route.continue();
    });
    return context;
  }
  // Every native dialog must be expected; each expectation answers exactly one dialog.
  async function newPage(context, name) {
    const page = await context.newPage();
    const answers = [];
    // DEBUG_ACCOUNTS=1 prints each tab's sign-in traffic and failed requests with timestamps.
    if (process.env.DEBUG_ACCOUNTS) {
      const at = () => ((Date.now() - started) / 1000).toFixed(2);
      page.on('response', async r => {
        const u = new URL(r.url());
        if (!u.pathname.startsWith('/api/auth') && r.status() < 400) return;
        const who = u.pathname === '/api/auth/status' ? await r.json().then(data => data.user?.username ?? 'nobody', () => '?') : '';
        console.log(at(), name, r.request().method(), u.pathname, r.status(), who);
      });
      page.on('console', m => console.log(at(), name, 'console', m.type(), m.text().slice(0, 200)));
    }
    page.on('pageerror', error => errors.push('pageerror: ' + error.message));
    page.on('request', request => { if (request.method() === 'PATCH') patches.push(new URL(request.url()).pathname); });
    page.on('dialog', dialog => {
      const next = answers.shift();
      if (!next) { errors.push('unexpected dialog: ' + dialog.message()); return dialog.dismiss(); }
      next.resolve(dialog.message());
      return next.accept ? dialog.accept() : dialog.dismiss();
    });
    page.expectDialog = accept => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('expected a confirm dialog within 10 s')), 10000);
      answers.push({ accept, resolve: message => { clearTimeout(timer); resolve(message); } });
    });
    return page;
  }
  async function signIn(page, username) {
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  const role = page => page.locator('.account-menu-toggle span');
  const nav = (page, name) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  const overlay = page => page.locator('[role="dialog"][aria-modal="true"][aria-labelledby="sign-in-title"]');
  const userRow = (page, username) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: username, exact: true }) });
  const patchDone = (page, username) => page.waitForResponse(response =>
    response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/users/${username}` && response.status() === 200);
  const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function revoke(admin, username) {
    // Disable then Enable: the account keeps its role, every session of it ends.
    const row = userRow(admin, username);
    let asked = admin.expectDialog(true); let done = patchDone(admin, username);
    await row.getByRole('button', { name: 'Disable', exact: true }).click(); await asked; await done;
    await row.getByRole('cell', { name: 'Disabled', exact: true }).waitFor();
    asked = admin.expectDialog(true); done = patchDone(admin, username);
    await row.getByRole('button', { name: 'Enable', exact: true }).click(); await asked; await done;
    await row.getByRole('cell', { name: 'Active', exact: true }).waitFor();
  }

  try {
    const adminContext = await newContext();
    // Before any sign-in or write: this must be the isolated test fixture.
    assert.equal((await (await adminContext.request.get(origin + '/api/version')).json()).version, MARKER, 'Refuse any real lab environment');
    const admin = await newPage(adminContext, 'admin-tab');
    await admin.goto(origin + '/?tab=admin');
    await signIn(admin, 'admin');
    await role(admin).filter({ hasText: 'Admin' }).waitFor();
    await admin.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Users', exact: true }).click();
    const viewerRole = admin.getByLabel('Role for viewer', { exact: true });
    await viewerRole.waitFor();

    // ---- ACC-1: an arrow key on the role select asks first; Cancel changes nothing ----
    await viewerRole.focus();
    let asked = admin.expectDialog(false);
    await admin.keyboard.press('ArrowUp');
    assert.equal(await asked, 'Change viewer from Viewer to Operator? Their sessions will end.');
    await settle(700);
    assert.deepEqual(patches, [], 'Cancel sends no PATCH');
    assert.equal(await viewerRole.inputValue(), 'Viewer', 'Cancel keeps the saved role on screen');
    await viewerRole.focus();
    asked = admin.expectDialog(true); let done = patchDone(admin, 'viewer');
    await admin.keyboard.press('ArrowUp');
    await asked; await done;
    await admin.waitForFunction(() => document.querySelector('select[aria-label="Role for viewer"]')?.value === 'Operator');
    await settle(500);
    assert.deepEqual(patches, ['/api/users/viewer'], 'OK sends exactly one PATCH');
    await viewerRole.focus();
    asked = admin.expectDialog(true); done = patchDone(admin, 'viewer');
    await admin.keyboard.press('ArrowDown');
    assert.equal(await asked, 'Change viewer from Operator to Viewer? Their sessions will end.');
    await done;
    await admin.waitForFunction(() => document.querySelector('select[aria-label="Role for viewer"]')?.value === 'Viewer');
    asked = admin.expectDialog(false);
    await userRow(admin, 'viewer').getByRole('button', { name: 'Disable', exact: true }).click();
    assert.match(await asked, /^Disable viewer\? Their sessions will end/);
    await settle(700);
    assert.equal(patches.length, 2, 'Disable with Cancel sends no PATCH');
    await userRow(admin, 'viewer').getByRole('cell', { name: 'Active', exact: true }).waitFor();
    passed.push('ACC-1: role arrow key and Disable ask first; Cancel sends nothing and keeps the role, OK sends one PATCH');

    // ---- ACC-3: the session ends underneath an operator who is typing ----
    const operatorContext = await newContext();
    const operator = await newPage(operatorContext, 'operator');
    await operator.goto(origin + '/?tab=monitoring');
    await signIn(operator, 'operator');
    await role(operator).filter({ hasText: 'Operator' }).waitFor();
    await operator.getByRole('button', { name: '+ Add server', exact: true }).click();
    const typed = { 'Server name': 'QA keep me', 'IP address / hostname': 'qa-keep.example', 'Rack (optional)': 'Rack-QA' };
    for (const [label, value] of Object.entries(typed)) await operator.getByLabel(label, { exact: true }).fill(value);

    let revokedAt = Date.now();
    await revoke(admin, 'operator');
    // Enable with Cancel leaves the account disabled.
    asked = admin.expectDialog(true); done = patchDone(admin, 'operator');
    await userRow(admin, 'operator').getByRole('button', { name: 'Disable', exact: true }).click(); await asked; await done;
    asked = admin.expectDialog(false);
    await userRow(admin, 'operator').getByRole('button', { name: 'Enable', exact: true }).click();
    assert.equal(await asked, 'Enable operator? They can sign in again with their current password.');
    await settle(700);
    await userRow(admin, 'operator').getByRole('cell', { name: 'Disabled', exact: true }).waitFor();
    asked = admin.expectDialog(true); done = patchDone(admin, 'operator');
    await userRow(admin, 'operator').getByRole('button', { name: 'Enable', exact: true }).click(); await asked; await done;
    passed.push('ACC-1: Enable asks first too; Cancel keeps the account disabled');

    const alert = overlay(operator).getByRole('alert');
    await alert.filter({ hasText: ENDED }).waitFor({ timeout: 20000 });
    const seconds = (Date.now() - revokedAt) / 1000;
    assert.ok((await alert.innerText()).includes(KEPT));
    assert.equal(await operator.getByLabel('Username', { exact: true }).inputValue(), 'operator', 'the ended user is suggested');
    assert.equal(await operator.locator('div[inert]').count(), 1, 'the page under the overlay is inert');
    // Like a native modal dialog, Tab may pass to the browser itself (body), but never into the page underneath.
    const focusIn = [];
    for (let i = 0; i < 12; i++) {
      await operator.keyboard.press('Tab');
      focusIn.push(await operator.evaluate(() => document.activeElement?.closest('[role="dialog"][aria-modal="true"]') ? 'overlay'
        : document.activeElement === document.body || !document.activeElement ? 'browser' : 'page'));
    }
    assert.ok(!focusIn.includes('page') && focusIn.filter(place => place === 'overlay').length >= 8, 'Tab stays out of the inert page: ' + focusIn.join(','));
    await signIn(operator, 'operator');
    await overlay(operator).waitFor({ state: 'detached' });
    await role(operator).filter({ hasText: 'Operator' }).waitFor();
    for (const [label, value] of Object.entries(typed)) assert.equal(await operator.getByLabel(label, { exact: true }).inputValue(), value, label + ' kept');
    assert.deepEqual(await operator.evaluate(() => [...document.querySelectorAll('[inert]')].map(node => node.outerHTML.slice(0, 120))), [], 'nothing stays inert');
    passed.push(`ACC-3: session end explained after ${seconds.toFixed(1)} s; the same user signs in again and keeps the typed server`);

    revokedAt = Date.now();
    await revoke(admin, 'operator');
    await alert.filter({ hasText: ENDED }).waitFor({ timeout: 20000 });
    await signIn(operator, 'admin');
    await overlay(operator).waitFor({ state: 'detached' });
    await role(operator).filter({ hasText: 'Admin' }).waitFor();
    assert.equal(await operator.getByLabel('Server name', { exact: true }).count(), 0, 'another user does not get the open form');
    await operator.getByRole('button', { name: '+ Add server', exact: true }).click();
    for (const label of Object.keys(typed)) assert.equal(await operator.getByLabel(label, { exact: true }).inputValue(), '', label + ' empty for another user');
    passed.push('ACC-3: a different user gets a fresh page with empty inputs');

    await operator.locator('.account-menu-toggle').click();
    await operator.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await operator.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    await settle(500);
    assert.equal(await overlay(operator).count(), 0, 'a deliberate sign-out is not an overlay');
    assert.equal(await operator.getByRole('alert').count(), 0, 'a deliberate sign-out shows no message');
    passed.push('ACC-3: a deliberate Sign out shows the plain sign-in screen, no message');

    // ---- ACC-5: Sign out after an administrator already ended the session ----
    await signIn(operator, 'operator');
    await role(operator).filter({ hasText: 'Operator' }).waitFor();
    // Auto-refresh 60 s, saved just now: no status poll can notice the revocation before Sign out is clicked.
    await operator.locator('.account-menu-toggle').click();
    await operator.getByRole('menuitem', { name: 'Account settings', exact: true }).click();
    await operator.getByLabel('Auto-refresh', { exact: true }).selectOption('60');
    await operator.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await operator.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
    await operator.locator('.account-menu-toggle').click();
    await operator.getByRole('menuitem', { name: 'Sign out', exact: true }).waitFor();
    await revoke(admin, 'operator');
    if (await overlay(operator).count()) throw new Error('A status poll ended the session before Sign out; rerun the check');
    const loggedOut = operator.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
    await operator.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    assert.equal((await loggedOut).status(), 401, 'the server already ended this session');
    await operator.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    await settle(500);
    assert.equal(await operator.locator('.account-error').count(), 0, 'no red error');
    assert.equal(await operator.getByRole('alert').count(), 0);
    assert.equal(await overlay(operator).count(), 0);
    passed.push('ACC-5: Sign out of a revoked session (401) shows the sign-in screen without an error');
    await operatorContext.close();

    // ---- ACC-2: two tabs, one browser session ----
    await nav(admin, 'Power');
    await admin.waitForFunction(() => [...document.querySelectorAll('button[aria-label^="Shut down all outlets on"]')].some(b => !b.disabled));
    const second = await newPage(adminContext, 'second-tab');
    await second.goto(origin + '/');
    await role(second).filter({ hasText: 'Admin' }).waitFor();
    await second.locator('.account-menu-toggle').click();
    const secondOut = second.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
    await second.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    assert.equal((await secondOut).status(), 200);
    const signedOutAt = Date.now();
    await overlay(admin).getByRole('alert').filter({ hasText: 'You signed out in another tab.' }).waitFor({ timeout: 15000 });
    const covered = (Date.now() - signedOutAt) / 1000;
    assert.ok(covered <= 2, `the other tab is covered within 2 s (took ${covered.toFixed(1)} s)`);
    await second.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await second.getByRole('alert').count(), 0, 'the tab that signed out shows no message');
    passed.push(`ACC-2: signing out in one tab covers the other tab after ${covered.toFixed(1)} s`);

    const statusCalls = [];
    admin.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/status') statusCalls.push(Date.now()); });
    const loggedIn = second.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
    await signIn(second, 'viewer');
    assert.equal((await loggedIn).status(), 200);
    const switchedAt = Date.now();
    // The other tab takes the new account (overlay gone, notice says who is signed in), then its fresh page shows the
    // Viewer in the header. Both are timed from the sign-in response and must take at most 2 s.
    const notice = admin.getByRole('status').filter({ hasText: 'Signed in as Viewer (Viewer) from another tab or window.' });
    await notice.waitFor({ timeout: 15000 });
    const took = (Date.now() - switchedAt) / 1000;
    assert.equal(await overlay(admin).count(), 0, 'the sign-in overlay is gone');
    await role(admin).filter({ hasText: 'Viewer' }).waitFor({ timeout: 15000 });
    const header = (Date.now() - switchedAt) / 1000;
    assert.ok(took <= 2 && header <= 2, `the other tab follows within 2 s (notice after ${took.toFixed(1)} s, header after ${header.toFixed(1)} s)`);
    await role(second).filter({ hasText: 'Viewer' }).waitFor();
    // The notice sits above the header in the page flow and never covers its controls.
    const [noticeBox, headerBox] = [await notice.boundingBox(), await admin.locator('.app-header').boundingBox()];
    assert.ok(noticeBox.y + noticeBox.height <= headerBox.y + 0.5, `notice ${JSON.stringify(noticeBox)} must not overlap the header ${JSON.stringify(headerBox)}`);
    // The Maintenance column has loaded for the new account: a Viewer gets no enabled Shut down button.
    await admin.getByRole('complementary', { name: 'Maintenance', exact: true }).getByText('Viewer · read only', { exact: true }).waitFor();
    assert.equal(await admin.evaluate(() => [...document.querySelectorAll('button[aria-label^="Shut down all outlets on"]')].filter(b => !b.disabled).length), 0, 'no enabled shutdown button for a Viewer');
    await nav(admin, 'Admin');
    await admin.getByRole('navigation', { name: 'Administration' }).waitFor();
    assert.equal(await admin.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Users', exact: true }).count(), 0, 'no Users section for a Viewer');
    assert.equal(await admin.getByLabel('Role for viewer', { exact: true }).count(), 0, 'the user table is gone');
    passed.push(`ACC-2: the other tab follows the Viewer sign-in (notice after ${took.toFixed(1)} s, Viewer header after ${header.toFixed(1)} s); Power and Users follow the role`);

    await settle(1500);
    statusCalls.length = 0;
    const forbidden = await admin.evaluate(() => fetch('/api/devices/connections').then(response => response.status));
    assert.equal(forbidden, 403);
    await settle(1500);
    assert.equal(statusCalls.length, 1, 'one status check per legitimate 403');
    await role(admin).filter({ hasText: 'Viewer' }).waitFor();
    assert.equal(await overlay(admin).count(), 0);
    statusCalls.length = 0;
    await settle(2000);
    assert.equal(statusCalls.length, 0, 'no status polling loop');
    passed.push('ACC-2: a legitimate 403 causes exactly one status check and changes nothing');

    await admin.getByRole('button', { name: 'Dismiss account notice', exact: true }).click();
    await notice.waitFor({ state: 'detached' });
    passed.push('ACC-2: the account notice stays until Dismiss, which removes it');

    assert.deepEqual(errors, [], 'No browser errors, unexpected dialogs or writes');
    console.log(`accounts.cjs: ${passed.lines.length} checks passed in ${((Date.now() - started) / 1000).toFixed(0)} s, 0 errors`);
  } finally {
    if (errors.length) console.error('browser errors:', errors);
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
