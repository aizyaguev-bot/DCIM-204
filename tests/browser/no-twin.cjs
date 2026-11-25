// The 3D twin is switched off (twinLinks.js TWIN_ENABLED false; the backend serves /twin only with TWIN_ENABLED=1):
// no "3D Twin" tab, no "Show in 3D" button on Racks, ?tab=twin opens Racks, and /twin/ answers with Racks.
// Isolated local fixture only (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1, without TWIN_ENABLED).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9741';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await c.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* ignore */ } });
    await c.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
    const login = await c.request.post(origin + '/api/auth/login', { data: { username: 'admin', password: 'test-password-123' } });
    assert.equal(login.status(), 200);
    assert.equal((await (await c.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const page = await c.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const nav = page.getByRole('navigation', { name: 'Main navigation' });

    await page.goto(origin + '/?tab=racks');
    await page.locator('.racks-toolbar').first().waitFor({ timeout: 30000 });
    assert.equal(await nav.getByRole('button', { name: '3D Twin', exact: true }).count(), 0, 'no 3D Twin tab');
    assert.equal(await page.locator('.show-3d, [aria-label^="Show "][aria-label$=" in 3D"]').count(), 0, 'no Show in 3D button on Racks');
    checks.push('no 3D Twin tab and no Show in 3D on Racks');

    await page.goto(origin + '/?tab=twin&select=rack%3ARack-03');
    await page.locator('.racks-toolbar').first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator('iframe[title="3D Digital Twin"]').count(), 0, 'the twin frame never loads');
    checks.push('?tab=twin opens Racks, no 3D frame');

    const r = await c.request.get(origin + '/twin/index.html', { maxRedirects: 0 });
    assert.equal(r.status(), 307, `/twin/ redirects (got ${r.status()})`);
    assert.equal(r.headers()['location'], '/?tab=racks');
    checks.push('/twin/ redirects to Racks');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message, checks, errors }, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
