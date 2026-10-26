// PDU and KVM detail pages: label drafts survive a 409, Turn on all, role reasons, maintenance hint,
// LX II text, IN USE ports and the inline console focus trap. Runs only against the isolated local fixture.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8936';
const PASSWORD = 'test-password-123';
// Fixture-only writes this check may make; anything else is aborted and fails the run.
const ALLOWED_WRITES = [
  /^\/api\/auth\/login$/,
  /^\/api\/devices\/(pdu1|kvm1)\/labels$/,
  /^\/api\/devices\/rename-opt$/,   // the rename preview (dry run); this check always answers "Only this outlet/port"
  /^\/api\/devices\/kvm1$/,
  /^\/api\/pdus\/pdu1\/outlets\/\d+\/power$/,
  /^\/api\/pdus\/pdu2\/maintenance\/(shutdown|restore)$/,
  /^\/api\/kvms\/kvm1\/ports\/\d+\/mark-(in-use|free)$/,
];

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], unexpectedWrites = [];

  async function login(username, { blockPopup = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      const url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !ALLOWED_WRITES.some(re => re.test(url.pathname))) {
        unexpectedWrites.push(request.method() + ' ' + url.pathname); return route.abort();
      }
      return route.continue();
    });
    if (blockPopup) await context.addInitScript(() => { window.open = () => null; });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(username + ': ' + error.message));
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept().catch(() => {}); });
    await page.goto(origin + '/?tab=power');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Power distribution units' }).waitFor();
    const version = await (await context.request.get(origin + '/api/version')).json();
    assert.equal(version.version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    return { context, page, dialogs };
  }

  // Requests through the page so the app's account wrapper adds the CSRF header.
  const call = (page, method, path, body, headers = {}) => page.evaluate(async ({ method, path, body, headers }) => {
    const response = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { method, path, body, headers });
  const device = async (page, id) => (await call(page, 'GET', '/api/devices/')).body.find(d => d.id === id);
  // Typing a new server name over a server asks "Rename X to Y?" (rename-everywhere.cjs covers it): answer each one with
  // "Only this outlet/port" until the label PATCH is sent, so this check keeps testing the single-device save.
  async function onlyThisPort(page, response) {
    let done = false;
    response.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      const only = page.locator('[data-dialog="rename-everywhere"] [data-choice="only"]');
      if (await only.count()) await only.click().catch(() => {});
      else await page.waitForTimeout(100);
    }
    return response;
  }

  async function openDetail(page, tab, name) {
    await page.goto(origin + '/?tab=' + tab);
    await page.getByRole('region', { name }).getByRole('button', { name: 'Details →' }).click();
    await page.getByText('Summary', { exact: true }).waitFor();
  }

  // Another session saves the device's labels while this one edits: the 409 keeps the editor and its draft.
  async function labelConflict({ page, other, tab, name, id, noun, typed, theirsPort, theirs, startLabels }) {
    await openDetail(page, tab, name);
    const edit = page.getByRole('button', { name: 'Edit Labels' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Edit Labels') && !b.disabled));
    await edit.click();
    const input = port => page.getByLabel(`Label for ${noun} ${port}`, { exact: true });
    for (const [port, text] of Object.entries(typed)) await input(port).fill(text);
    const before = await device(other, id);
    const changed = await call(other, 'PATCH', `/api/devices/${id}/labels`, { ...before.labels, [theirsPort]: theirs }, { 'If-Match': before.labels_revision });
    assert.equal(changed.status, 200, 'the other session saves first');
    const conflict = page.waitForResponse(r => new URL(r.url()).pathname === `/api/devices/${id}/labels` && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal((await onlyThisPort(page, conflict)).status(), 409);
    await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value,
      { selector: `input[aria-label="Label for ${noun} ${theirsPort}"]`, value: theirs }, { timeout: 5000 });
    for (const [port, text] of Object.entries(typed)) assert.equal(await input(port).inputValue(), text, `${noun} ${port} keeps the typed text`);
    const note = (await page.locator(`#${tab === 'power' ? 'pdu' : 'kvm'}-label-note`).innerText()).trim();
    assert.ok(note.length > 0, 'a note explains the change');
    assert.doesNotMatch(note, /reload/i, 'the note never asks for a reload');
    assert.equal(await page.getByRole('alert').filter({ hasText: 'Labels were not saved' }).count(), 0);
    const saved = page.waitForResponse(r => new URL(r.url()).pathname === `/api/devices/${id}/labels` && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal((await onlyThisPort(page, saved)).status(), 200, 'the second Save is accepted');
    await edit.waitFor();
    const after = await device(other, id);
    for (const [port, text] of Object.entries(typed)) assert.equal(after.labels[port], text);
    assert.equal(after.labels[theirsPort], theirs, "the other session's change is kept");
    // Leave the fixture as it was for the next checks.
    const reset = await call(other, 'PATCH', `/api/devices/${id}/labels`, startLabels, { 'If-Match': after.labels_revision });
    assert.equal(reset.status, 200);
  }

  try {
    const admin = await login('admin');
    const operator = await login('operator');

    // PDU-2 and its KVM twin: a 409 keeps the editor open with the typed labels and shows the other change.
    const pduStart = (await device(admin.page, 'pdu1')).labels;
    await labelConflict({ page: admin.page, other: operator.page, tab: 'power', name: 'PDU 01', id: 'pdu1', noun: 'outlet',
      typed: { 1: 'MY-NEW-SERVER-1', 2: 'MY-OTHER-SERVER-1' }, theirsPort: '4', theirs: 'ADMIN-CHANGED-4', startLabels: pduStart });
    checks.push('PDU-2: after a 409 the PDU editor stays open, keeps outlets 1-2, shows outlet 4 from the other session; the second Save is 200');
    const kvmStart = (await device(admin.page, 'kvm1')).labels;
    await labelConflict({ page: admin.page, other: operator.page, tab: 'consoles', name: 'KVM 01', id: 'kvm1', noun: 'port',
      typed: { 2: 'MY-KVM-PORT-2', 3: 'MY-KVM-PORT-3' }, theirsPort: '4', theirs: 'ADMIN-KVM-4', startLabels: kvmStart });
    checks.push('PDU-2 (KVM): the KVM label editor keeps its draft across a 409 the same way');

    // PDU-5: nothing to turn on means no dialog; one outlet off means exactly one POST.
    const { page } = admin;
    await openDetail(page, 'power', 'PDU 01');
    const turnOnAll = page.getByRole('button', { name: /Turn on all outlets/ });
    await page.getByRole('button', { name: 'Power off OPT13' }).waitFor();
    assert.equal(await turnOnAll.isDisabled(), true);
    assert.equal(await turnOnAll.getAttribute('title'), 'All outlets are already on');
    const dialogsBefore = admin.dialogs.length;
    await turnOnAll.click({ force: true });
    await page.waitForTimeout(300);
    assert.equal(admin.dialogs.length, dialogsBefore, 'no confirm when every outlet is on');
    const off = page.waitForResponse(r => new URL(r.url()).pathname === '/api/pdus/pdu1/outlets/3/power');
    await page.getByRole('button', { name: 'Power off OPT13' }).click();
    assert.equal((await off).status(), 200);
    await page.getByRole('button', { name: 'Power on OPT13' }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => /Turn on all outlets/.test(b.textContent) && !b.disabled));
    const posts = [];
    const onPost = request => { if (request.method() === 'POST' && /\/outlets\/\d+\/power$/.test(new URL(request.url()).pathname)) posts.push(new URL(request.url()).pathname); };
    page.on('request', onPost);
    const on = page.waitForResponse(r => new URL(r.url()).pathname === '/api/pdus/pdu1/outlets/3/power');
    await turnOnAll.click();
    assert.equal((await on).status(), 200);
    await page.getByRole('button', { name: 'Power off OPT13' }).waitFor();
    await page.waitForTimeout(300);
    page.off('request', onPost);
    assert.deepEqual(posts, ['/api/pdus/pdu1/outlets/3/power'], 'Turn on all sends exactly the outlets that are off');
    assert.match(admin.dialogs.at(-1), /outlet 3 of PDU 01/);
    checks.push('PDU-5: Turn on all is disabled with "All outlets are already on"; with one outlet off it sends exactly one POST');

    // PDU-4: power controls of a PDU in maintenance point to Restore power on the page.
    const shutdown = await call(page, 'POST', '/api/pdus/pdu2/maintenance/shutdown', { password: PASSWORD, reason: 'B06 detail check' });
    assert.equal(shutdown.status, 200);
    try {
      await openDetail(page, 'power', 'PDU 02');
      await page.getByText(/In maintenance since/).waitFor();
      await page.getByRole('button', { name: 'Power on OPT21' }).waitFor();
      const titles = await page.locator('main button[title]').evaluateAll(buttons => buttons.map(b => b.title));
      const locked = titles.filter(t => /maintenance mode/.test(t));
      assert.ok(locked.length >= 5, 'outlet buttons and Turn on all explain the lock: ' + JSON.stringify(titles));
      for (const title of locked) { assert.match(title, /Restore power/); assert.doesNotMatch(title, /Maintenance column/); }
      checks.push('PDU-4: maintenance-locked buttons say "use Restore power on this page", never "Maintenance column"');
    } finally {
      const restore = await call(page, 'POST', '/api/pdus/pdu2/maintenance/restore', { password: PASSWORD });
      assert.equal(restore.status, 200);
    }

    // KVM-1: a port marked in use shows it on its detail tile.
    assert.equal((await call(page, 'POST', '/api/kvms/kvm1/ports/2/mark-in-use')).status, 200);
    try {
      await openDetail(page, 'consoles', 'KVM 01');
      const tile = page.locator('main button[data-in-use]').filter({ hasText: 'P2' });
      await page.waitForFunction(() => [...document.querySelectorAll('main button[data-in-use="true"]')].some(b => b.textContent.includes('P2')), null, { timeout: 5000 });
      assert.match(await tile.getAttribute('title'), /· In use$/);
      assert.match(await tile.innerText(), /IN USE/);
      assert.equal(await page.locator('main button[data-in-use]').filter({ hasText: 'P3' }).getAttribute('data-in-use'), 'false');
      assert.equal(await page.getByRole('button', { name: /OPT11/ }).count(), 1, 'the tile keeps its visible name');
      checks.push('KVM-1: an in-use port tile has data-in-use=true, "In use" in its title and a visible IN USE');
    } finally {
      assert.equal((await call(page, 'POST', '/api/kvms/kvm1/ports/2/mark-free')).status, 200);
    }

    // KVM-5: an LX II unit shows no native-viewer banner or card note; its ports still open the console.
    const kvm = await device(page, 'kvm1');
    const asLx = { name: kvm.name, kind: kvm.kind, model: 'Raritan Dominion LX II', ip: kvm.ip, rack: kvm.rack, port_count: kvm.port_count, notes: kvm.notes || '' };
    assert.equal((await call(page, 'PUT', '/api/devices/kvm1', asLx)).status, 200);
    try {
      await page.goto(origin + '/?tab=consoles');
      const card = page.getByRole('region', { name: 'KVM 01' });
      await card.getByText('LX II', { exact: true }).waitFor();
      assert.equal(await card.getByText(/viewer opens in a new tab/i).count(), 0);
      await card.getByRole('button', { name: 'Details →' }).click();
      await page.getByText('Summary', { exact: true }).waitFor();
      assert.equal(await page.getByText(/native viewer|LX II unit/i).count(), 0);
      const popupReady = page.context().waitForEvent('page');
      const used = page.waitForResponse(r => new URL(r.url()).pathname === '/api/kvms/kvm1/ports/2/mark-in-use');
      await page.locator('main button[data-in-use]').filter({ hasText: 'P2' }).click();
      const popup = await popupReady;
      assert.equal(new URL(popup.url()).pathname, '/api/kvms/kvm1/autologin');
      assert.equal(new URL(popup.url()).searchParams.get('port'), '2');
      await used;
      const freed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/kvms/kvm1/ports/2/mark-free');
      await popup.close(); await freed;
      checks.push('KVM-5: no LX II banner or card note; P2 still opens autologin?port=2');
    } finally {
      assert.equal((await call(page, 'PUT', '/api/devices/kvm1', { ...asLx, model: kvm.model })).status, 200);
    }

    // PDU-6: role reasons on disabled controls, a visible note, and Remove for Admin only.
    const viewer = await login('viewer');
    await openDetail(viewer.page, 'power', 'PDU 01');
    const vp = viewer.page;
    await vp.locator('#pdu-readonly-note').waitFor();
    const roleTitles = [
      await vp.getByRole('button', { name: /Edit Labels/ }).getAttribute('title'),
      await vp.getByRole('button', { name: /Turn on all outlets/ }).getAttribute('title'),
      await vp.getByRole('button', { name: /Turn off all outlets/ }).getAttribute('title'),
      await vp.getByText('Read only', { exact: true }).first().getAttribute('title'),
    ];
    for (const title of roleTitles) assert.match(title || '', /Operator or Admin/);
    assert.equal(await vp.getByRole('button', { name: /Edit Labels/ }).getAttribute('aria-describedby'), 'pdu-readonly-note');
    const viewerRemove = vp.getByRole('button', { name: 'Remove device' });
    assert.equal(await viewerRemove.isDisabled(), true);
    assert.match(await viewerRemove.getAttribute('title'), /Admin/);
    await openDetail(vp, 'consoles', 'KVM 01');
    await vp.locator('#kvm-readonly-note').waitFor();
    assert.match(await vp.getByRole('button', { name: /Edit Labels/ }).getAttribute('title'), /Operator or Admin/);
    assert.match(await vp.getByRole('button', { name: 'Remove device' }).getAttribute('title'), /Admin/);
    await viewer.context.close();
    await openDetail(operator.page, 'power', 'PDU 01');
    const operatorRemove = operator.page.getByRole('button', { name: 'Remove device' });
    assert.equal(await operatorRemove.isDisabled(), true);
    assert.match(await operatorRemove.getAttribute('title'), /Admin/);
    await operator.page.locator('#pdu-remove-note').waitFor();
    await operator.page.getByRole('button', { name: 'Power off OPT11' }).waitFor();
    assert.equal(await operator.page.getByRole('button', { name: /Edit Labels/ }).getAttribute('title'), null);
    checks.push('PDU-6: Viewer controls say "Operator or Admin" with a visible note; Operator sees why Remove needs Admin (PDU and KVM)');
    await operator.context.close();

    // KVM-2: the inline console traps Tab and Shift+Tab, closes on Escape and returns focus to the port.
    const blocked = await login('operator', { blockPopup: true });
    const bp = blocked.page;
    await openDetail(bp, 'consoles', 'KVM 01');
    const p3 = bp.locator('main button[data-in-use]').filter({ hasText: 'P3' });
    const used3 = bp.waitForResponse(r => new URL(r.url()).pathname === '/api/kvms/kvm1/ports/3/mark-in-use');
    await p3.click();
    const dialog = bp.getByRole('dialog', { name: 'KVM console', exact: true });
    await dialog.waitFor();
    await bp.frameLocator('iframe[title="KVM console viewer"]').getByRole('heading', { name: 'Console preview' }).waitFor();
    await used3;
    const inDialog = () => bp.evaluate(() => !!document.querySelector('[role="dialog"]')?.contains(document.activeElement));
    assert.equal(await inDialog(), true, 'focus starts in the dialog');
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < 30; i++) {
        await bp.keyboard.press(key);
        assert.equal(await inDialog(), true, `${key} #${i + 1} keeps focus in the console dialog`);
      }
    }
    await bp.getByRole('button', { name: 'Close KVM console' }).focus();
    const freed3 = bp.waitForResponse(r => new URL(r.url()).pathname === '/api/kvms/kvm1/ports/3/mark-free');
    await bp.keyboard.press('Escape');
    await freed3;
    assert.equal(await dialog.count(), 0, 'Escape closes the console');
    assert.match(await bp.evaluate(() => document.activeElement?.textContent || ''), /P3/, 'focus returns to the port that opened it');
    checks.push('KVM-2: 30 Tab and 30 Shift+Tab stay in the inline console; Escape closes it, frees the port and restores focus');
    await blocked.context.close();
    await admin.context.close();

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedWrites, [], 'Only fixture writes listed in ALLOWED_WRITES');
    console.log(JSON.stringify({ passed: checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
