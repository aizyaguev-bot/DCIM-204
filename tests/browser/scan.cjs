// Scan & Track: keyboard-wedge scans while requests run, failed scans, Viewer limits and the labels dialog.
// Runs only against the isolated fixture (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const READ_ONLY = 'Read only. Saving locations, linking barcodes and registering equipment require the Operator or Admin role.';
// The only writes a scan may make: sign in, register (POST /api/inventory) and save a location.
const ALLOWED_WRITE = /^\/api\/(auth\/login|inventory|inventory\/[^/]+\/location)$/;
const isInventory = url => url.pathname === '/api/inventory' || url.pathname.startsWith('/api/inventory/');

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [];
  const runId = Date.now().toString(36).toUpperCase();

  async function login(username) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // What's new opens over the page in a fresh profile; it is not under test here.
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !ALLOWED_WRITE.test(url.pathname)) {
        unexpectedWrites.push(request.method() + ' ' + url.pathname); return route.abort();
      }
      return route.continue();
    });
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(username + ': ' + error.message));
    const posts = [], lookups = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (!isInventory(url)) return;
      if (request.method() === 'POST') posts.push({ path: url.pathname, body: request.postDataJSON() });
      else if (url.searchParams.has('code')) lookups.push(url.searchParams.get('code'));
    });
    await page.goto(origin + '/?tab=scan');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('test-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Scan & Track' }).waitFor();
    return { username, context, page, posts, lookups };
  }

  async function open(s) {
    await s.page.goto(origin + '/?tab=scan');
    await s.page.getByRole('heading', { name: 'Scan & Track' }).waitFor();
    await s.page.getByRole('button', { name: 'Find barcode' }).waitFor();
    await s.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Scan barcode');
    s.posts.length = 0; s.lookups.length = 0;
  }
  // A keyboard-wedge scanner types into whatever has focus and ends with Enter.
  async function wedge(page, code) { await page.keyboard.type(code); await page.keyboard.press('Enter'); }
  const scanInput = page => page.getByRole('textbox', { name: 'Scan barcode' });
  const status = (page, text) => page.getByRole('status').filter({ hasText: text });
  const alert = (page, text) => page.getByRole('alert').filter({ hasText: text });
  async function barcodes(s) {
    const response = await s.context.request.get(origin + '/api/inventory');
    assert.equal(response.status(), 200);
    return (await response.json()).items.map(item => item.barcode).filter(Boolean);
  }
  async function newBarcodes(s, before) { return (await barcodes(s)).filter(code => !before.includes(code)); }
  // While the page is busy ("Please wait…"), record which element has focus.
  async function startFocusSampler(page) {
    await page.evaluate(() => {
      window.__scanFocus = [];
      window.__scanFocusTimer = setInterval(() => {
        if ([...document.querySelectorAll('button')].some(b => b.textContent === 'Please wait…'))
          window.__scanFocus.push(document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName || 'none');
      }, 5);
    });
  }
  const stopFocusSampler = page => page.evaluate(() => { clearInterval(window.__scanFocusTimer); return window.__scanFocus; });
  const registered = s => s.posts.filter(p => p.path === '/api/inventory').map(p => p.body);

  async function backToBack(s, rack, u, gap, latency) {
    const { page } = s;
    await open(s);
    const delay = async route => { await sleep(latency); await route.fallback(); };
    if (latency) await page.route(isInventory, delay);
    const before = await barcodes(s);
    const label = `${s.username.toUpperCase()}-${latency ? 'L' : 'G'}${gap}`;
    const codes = [`B03-${runId}-${label}-A`, `B03-${runId}-${label}-B`];
    await startFocusSampler(page);
    await wedge(page, `LOC:${rack}:${u}:`);
    for (const code of codes) { await sleep(gap); await wedge(page, code); }
    await status(page, `Registered automatically: ${codes[1]} →`).waitFor({ timeout: 20000 });
    const focus = await stopFocusSampler(page);
    if (latency) await page.unroute(isInventory, delay);
    const saved = registered(s);
    assert.deepEqual(saved.map(b => b.code), codes, `${label}: exactly the two scans are saved, in order`);
    for (const body of saved) assert.deepEqual([body.name, body.rack, body.u], [body.code, rack, u], `${label}: saved at the scanned label`);
    const added = await newBarcodes(s, before);
    assert.deepEqual([...added].sort(), [...codes].sort(), `${label}: no extra, cut or merged item`);
    for (const code of added) for (const scanned of codes)
      assert.ok(code === scanned || !(scanned.startsWith(code) || scanned.endsWith(code) || code.startsWith(scanned) || code.endsWith(scanned)), `${label}: ${code} is part of ${scanned}`);
    assert.equal(await scanInput(page).inputValue(), '');
    if (latency) assert.ok(focus.length > 0, `${label}: the page was busy during the scans`);
    assert.ok(focus.every(name => name === 'Scan barcode'), `${label}: focus left the scan input while busy: ${[...new Set(focus)]}`);
    checks.push(`${s.username}: LOC + 2 scans, gap ${gap} ms${latency ? `, ${latency} ms latency` : ''}: both saved whole and in order; focus stayed in the scan input`);
  }

  async function forcedConflict(s, rack, u) {
    const { page } = s;
    await open(s);
    const before = await barcodes(s);
    const codes = [`B03-${runId}-${s.username.toUpperCase()}-409A`, `B03-${runId}-${s.username.toUpperCase()}-409B`];
    let forced = false;
    const conflict = async route => {
      if (route.request().method() !== 'POST' || forced) return route.fallback();
      forced = true; await sleep(900);
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Fixture: the inventory changed in another session.' }) });
    };
    const register = url => url.pathname === '/api/inventory';
    await page.route(register, conflict);
    await wedge(page, `LOC:${rack}:${u}:`);
    await wedge(page, codes[0]);
    await wedge(page, codes[1]);
    await page.getByText('1 scan waiting').waitFor({ timeout: 800 });
    await alert(page, `Not processed — scan again: ${codes[1]}`).waitFor();
    assert.match(await page.getByRole('alert').innerText(), /changed in another session/);
    await page.unroute(register, conflict);
    assert.deepEqual(registered(s).map(b => b.code), [codes[0]], 'The second scan is not sent after the first failed');
    assert.deepEqual(await newBarcodes(s, before), []);
    assert.equal(await scanInput(page).inputValue(), '');
    await wedge(page, codes[1]);
    await status(page, `Registered automatically: ${codes[1]} →`).waitFor();
    assert.deepEqual(await newBarcodes(s, before), [codes[1]]);
    checks.push(`${s.username}: a 409 on the first save names the waiting scan; scanning it again registers it`);
  }

  async function abortedLookup(s, rack, u) {
    const { page } = s;
    await open(s);
    const before = await barcodes(s);
    const lost = `B03-${runId}-${s.username.toUpperCase()}-LOST`, next = `B03-${runId}-${s.username.toUpperCase()}-NEXT`;
    let aborted = false;
    const once = route => { if (aborted) return route.fallback(); aborted = true; return route.abort('failed'); };
    const matcher = url => url.pathname === '/api/inventory' && url.searchParams.get('code') === lost;
    await page.route(matcher, once);
    await wedge(page, `LOC:${rack}:${u}:`);
    await wedge(page, lost);
    await alert(page, 'Could not reach the server').waitFor();
    assert.equal(await scanInput(page).inputValue(), '', 'The failed scan does not stay in the field');
    await wedge(page, next);
    await status(page, `Registered automatically: ${next} →`).waitFor();
    await page.unroute(matcher, once);
    assert.deepEqual(registered(s).map(b => [b.code, b.name]), [[next, next]], 'The next scan is registered alone');
    assert.deepEqual(await newBarcodes(s, before), [next]);
    checks.push(`${s.username}: an aborted lookup leaves the field empty and the next scan registers alone`);
  }

  async function failedLabelThenItem(s) {
    const { page } = s;
    await open(s);
    await wedge(page, 'LOC:Rack-01:1');
    await alert(page, 'This shelf label is incomplete').waitFor();
    assert.equal(await scanInput(page).inputValue(), '');
    await wedge(page, 'TEST-004');
    await status(page, 'Equipment found.').waitFor();
    await page.getByRole('heading', { name: 'Switch 04', exact: true }).waitFor();
    assert.equal(await page.getByText('Unknown barcode:').count(), 0);
    assert.deepEqual(s.lookups, ['TEST-004'], 'The failed label text is not merged into the next scan');
    assert.equal(s.posts.length, 0);
    checks.push(`${s.username}: a failed LOC:Rack-01:1 scan is cleared; TEST-004 is found`);
  }

  async function tooLong(s) {
    const { page } = s;
    await open(s);
    const long = `B03-${runId}-`.padEnd(221, 'X');
    await wedge(page, long);
    await alert(page, 'Barcode is too long (max 200 characters).').waitFor();
    assert.equal(await scanInput(page).inputValue(), '');
    assert.deepEqual(s.lookups, [], 'A code the server cannot store is not sent');
    await wedge(page, 'TEST-005');
    await status(page, 'Equipment found.').waitFor();
    await page.getByRole('heading', { name: 'Switch 05', exact: true }).waitFor();
    checks.push(`${s.username}: 221 characters says "Barcode is too long", clears the field, and the next scan works`);
  }

  async function newLabelAfterSave(s, u) {
    const { page } = s;
    await open(s);
    const save = page.getByRole('button', { name: 'Save and confirm location' });
    await wedge(page, `LOC:Rack-02:${u}:`);
    await wedge(page, 'TEST-002');
    await status(page, 'Equipment found. Review the selected destination').waitFor();
    await save.click();
    await status(page, 'Saved: Switch 02 → Rack-02').waitFor();
    assert.deepEqual(s.posts.map(p => [p.path, p.body.rack, p.body.u]), [['/api/inventory/ci-2/location', 'Rack-02', u]]);
    await scanInput(page).focus();
    await wedge(page, `LOC:Rack-03:${u}:`);
    await status(page, 'Destination selected. Now scan the equipment barcode').waitFor();
    assert.equal(await save.count(), 0, 'The item that was just saved is not offered for another move');
    // An item that is not yet at the chosen destination still waits for Save when the label changes.
    await wedge(page, 'TEST-003');
    await status(page, 'Equipment found. Review the selected destination').waitFor();
    await wedge(page, `LOC:Rack-03:${u + 1}:`);
    await status(page, 'Destination selected. Review it below, then save to confirm.').waitFor();
    assert.equal(await save.count(), 1);
    assert.equal(s.posts.length, 1);
    checks.push(`${s.username}: a new label after Save asks for the next equipment instead of offering to move the saved item`);
  }

  async function labelsDialog(s) {
    const { page } = s;
    await open(s);
    await page.getByRole('button', { name: 'Location labels' }).click();
    const dialog = page.getByRole('dialog', { name: 'Location labels' });
    await dialog.waitFor();
    const focusInDialog = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Location labels"]')));
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Close', 'Focus starts on Close');
    for (let i = 0; i < 16; i++) { await page.keyboard.press('Tab'); assert.ok(await focusInDialog(), `Tab ${i + 1} stays in the dialog`); }
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Shift+Tab'); assert.ok(await focusInDialog(), `Shift+Tab ${i + 1} stays in the dialog`); }
    await page.locator('main button', { hasText: 'Switch 01' }).first().focus();
    assert.ok(await focusInDialog(), 'Focus cannot move to a card behind the dialog');
    await page.keyboard.press('Enter');
    await sleep(200);
    assert.equal(await dialog.count(), 1, 'Enter did not close the dialog');
    assert.equal(await page.getByText('Selected equipment').count(), 0, 'Enter did not select a background card');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Scan barcode');
    checks.push(`${s.username}: labels dialog takes focus, traps Tab, ignores the background, closes on Escape and returns to the scan input`);
  }

  async function viewer() {
    const s = await login('viewer');
    const { page } = s;
    await open(s);
    await page.getByRole('note').filter({ hasText: READ_ONLY }).waitFor();
    const auto = page.getByRole('checkbox', { name: 'Automatically register new equipment' });
    assert.equal(await auto.isDisabled(), true); assert.equal(await auto.isChecked(), false);
    await wedge(page, 'LOC:Rack-01:3:');
    await status(page, 'Destination selected. Scan equipment to look it up. Read only.').waitFor();
    await wedge(page, 'TEST-001');
    await status(page, 'Equipment found. Read only.').waitFor();
    for (const name of ['Destination rack', 'Destination shelf', 'Position on shelf']) assert.equal(await page.getByLabel(name, { exact: true }).isDisabled(), true, name);
    const save = page.getByRole('button', { name: 'Save and confirm location' });
    assert.equal(await save.isDisabled(), true); assert.equal(await save.getAttribute('title'), READ_ONLY);
    const unknown = `B03-${runId}-VIEWER`;
    await wedge(page, unknown);
    await status(page, 'New barcode: it is not linked to any equipment. Read only.').waitFor();
    for (const name of ['Existing equipment', 'Equipment name', 'Destination rack']) assert.equal(await page.getByLabel(name, { exact: true }).isDisabled(), true, name);
    for (const name of ['Link barcode', 'Register equipment']) {
      const button = page.getByRole('button', { name, exact: true });
      assert.equal(await button.isDisabled(), true, name); assert.equal(await button.getAttribute('title'), READ_ONLY, name);
    }
    assert.equal(await page.getByRole('button', { name: 'Register barcode here' }).count(), 0);
    assert.equal(s.posts.length, 0, 'Viewer scans never write');
    checks.push('viewer: read-only note, role-aware messages, disabled fields and explained buttons');
    await s.context.close();
  }

  try {
    for (const [username, rack] of [['operator', 'Rack-04'], ['admin', 'Rack-05']]) {
      const s = await login(username);
      let u = 10;
      for (const gap of [0, 20, 60]) await backToBack(s, rack, u++, gap, 0);
      for (const gap of [1100, 1160, 1220]) await backToBack(s, rack, u++, gap, 600);
      await forcedConflict(s, rack, u++);
      await abortedLookup(s, rack, u++);
      await failedLabelThenItem(s);
      await tooLong(s);
      await newLabelAfterSave(s, username === 'operator' ? 20 : 30);
      await labelsDialog(s);
      await s.context.close();
    }
    await viewer();
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedWrites, [], 'Scanning writes only inventory registrations and locations');
    console.log(JSON.stringify({ passed: checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
