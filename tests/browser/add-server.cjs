// Add server (one-place WP-5, server/AddServerDialog.jsx): the owner could not find where to add a new server. Racks has a
// visible "+ Add server" in its toolbar (Operator and up, Edit mode or not) and a "+ Add server" on every free floor in
// Edit mode; both open one dialog: rack -> floor -> a free PDU outlet from a list -> name (an existing one is refused,
// with Open) -> optional KVM port. Save pins the floor, writes the outlet's label (the same PATCH as Racks' old + OPT)
// and opens the new server's window; another context's Dashboard shows the label within 5 s. A Viewer has no Add server.
// Fixture: tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1 DCIM_FIXTURE_ONE_PLACE=1 (Rack-05: PDU 05 outlet 2
// "Spare", floors 2 and 4 free). Everything it changes is put back and checked. Only fixture data; no hardware.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9800';
const PASSWORD = 'test-password-123';
const LIVE_MS = Number(process.env.LIVE_MS || 5000);
const NAME = 'OPT52', KEY = 'opt52';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], passed = [], cleanups = [];
  async function session(username, viewport = { width: 1440, height: 1000 }) {
    const c = await browser.newContext({ viewport });
    await c.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await c.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
    const login = await c.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(login.status(), 200, `${username} login`);
    return { c, csrf: (await login.json()).csrf_token, username };
  }
  async function page(s, url) {
    const p = await s.c.newPage();
    p.on('pageerror', e => errors.push(`${s.username}: ${e.message}`));
    p.on('dialog', d => { errors.push(`${s.username} native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
    await p.goto(origin + url);
    return p;
  }
  try {
    const admin = await session('admin'), operator = await session('operator'), viewer = await session('viewer');
    assert.equal((await (await admin.c.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'fixture marker');
    const H = (s, etag) => ({ ...(etag ? { 'If-Match': etag } : {}), 'X-DCIM-CSRF': s.csrf });
    const get = async path => { const r = await admin.c.request.get(origin + path); assert.equal(r.status(), 200, path); return { data: await r.json(), etag: r.headers()['etag'] }; };
    const device = async id => (await get('/api/devices/')).data.find(d => d.id === id);
    const pdu5 = await device('pdu5');
    assert.equal(pdu5?.labels?.['2'], 'Spare', 'start the fixture with DCIM_FIXTURE_ONE_PLACE=1 (PDU 05 outlet 2 "Spare")');
    const slots0 = (await get('/api/rack-slots')).data;
    assert.equal(slots0['Rack-05']?.[KEY], undefined, `${NAME} is not on Rack-05 yet`);
    assert.equal((await get('/api/devices/locations')).data.servers.some(s => s.key === KEY), false, `no server ${NAME} yet`);
    cleanups.push(async () => {
      const now = await device('pdu5');
      if (JSON.stringify(now.labels) !== JSON.stringify(pdu5.labels)) {
        const r = await admin.c.request.patch(origin + '/api/devices/pdu5/labels', { data: pdu5.labels, headers: H(admin) });
        assert.equal(r.status(), 200, await r.text());
      }
      const { data, etag } = await get('/api/rack-slots');
      if (JSON.stringify(data) !== JSON.stringify(slots0)) {
        const r = await admin.c.request.put(origin + '/api/rack-slots', { data: slots0, headers: H(admin, etag) });
        assert.equal(r.status(), 200, await r.text());
      }
    });

    // ── another context watches the Dashboard's PDU 05 card ──
    const dash = await page(admin, '/?tab=dashboard');
    const outlets = () => dash.locator('section.device-card[aria-label="PDU 05"] .pdu-outlet-cell').evaluateAll(els => els.map(e => e.innerText.trim()));
    await dash.locator('section.device-card[aria-label="PDU 05"] .pdu-outlet-cell').first().waitFor({ timeout: 30000 });
    assert.ok(!(await outlets()).some(t => t.includes(NAME)), `the Dashboard does not show ${NAME} yet`);

    // ── AS-1 Operator: the toolbar's "+ Add server", visible without Edit mode ──
    const p = await page(operator, '/?tab=racks');
    await p.locator('[data-rack-id="Rack-05"]').waitFor({ timeout: 30000 });
    assert.equal(await p.locator('button.edit-toggle').getAttribute('aria-pressed'), 'false', 'Edit mode is off');
    const add = p.locator('.racks-toolbar button[data-action="add-server"]');
    assert.equal(await add.isVisible(), true, 'the toolbar shows + Add server');
    assert.equal((await add.innerText()).trim(), '+ Add server');
    await add.click();
    const dlg = p.locator('[data-dialog="add-server"]');
    await dlg.waitFor();
    assert.equal(await dlg.locator('h2').innerText(), 'Add server');
    await p.waitForFunction(() => document.activeElement?.id === 'add-server-rack', null, { timeout: 10000 });   // focus starts on the rack
    assert.equal(await dlg.locator('[data-action="add-server-save"]').isDisabled(), true, 'nothing to save yet');
    await dlg.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
    const floor = dlg.getByLabel('Floor', { exact: true });
    assert.deepEqual(await floor.locator('option').evaluateAll(o => o.map(e => [e.value, e.textContent, e.disabled])),
      [['1', 'Floor 1 · OPT51', true], ['2', 'Floor 2 · free', false], ['3', 'Floor 3 · OPT53', true], ['4', 'Floor 4 · free', false]], 'taken floors cannot be chosen');
    assert.equal(await floor.inputValue(), '2', 'the first free floor');
    const outlet = dlg.getByLabel('PDU outlet that feeds floor 2', { exact: true });
    assert.deepEqual(await outlet.locator('option').allTextContents(), ['PDU 05 · outlet 2 · Spare'], 'only the free outlet: never one that names a server');
    assert.equal(await outlet.inputValue(), 'pdu5:2');
    assert.match(await dlg.innerText(), /No free KVM port on Rack-05\./);
    passed.push('AS-1 Operator, Edit mode off: the Racks toolbar shows "+ Add server"; the dialog starts on Rack; Rack-05 offers floors 2 and 4 (1 and 3 shown taken by OPT51 / OPT53, disabled) and only PDU 05 · outlet 2 · Spare');

    // ── AS-2 the name: a placeholder and an existing server are refused (with Open); nothing is sent ──
    const writes = [];
    p.on('request', r => { if (!['GET', 'HEAD'].includes(r.method()) && r.url().startsWith(origin + '/api/') && !r.url().endsWith('/api/auth/login')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    const name = dlg.getByLabel('Server name', { exact: true });
    const save = dlg.locator('[data-action="add-server-save"]');
    await name.fill('Spare');
    await dlg.getByRole('alert').filter({ hasText: 'is not a server name' }).waitFor();
    assert.equal(await save.isDisabled(), true);
    await name.fill('opt51');
    const refused = dlg.getByRole('alert').filter({ hasText: 'OPT51 already exists (Rack-05 · floor 1).' });
    await refused.waitFor();
    assert.equal(await save.isDisabled(), true, 'a name that exists cannot be saved');
    assert.equal(await name.getAttribute('aria-invalid'), 'true');
    await name.press('Enter');
    await sleep(400);
    assert.deepEqual(writes, [], 'a refused name sends nothing');
    // its Open opens that server's window (the dialog closes)
    await refused.getByRole('button', { name: 'Open OPT51' }).click();
    await dlg.waitFor({ state: 'detached' });
    const win = p.locator('[data-window="server"]');
    await win.locator('h2.lab-window-name', { hasText: 'OPT51' }).waitFor();
    assert.equal(new URL(p.url()).searchParams.get('srv'), 'opt51');
    await p.keyboard.press('Escape'); await win.waitFor({ state: 'detached' });
    passed.push('AS-2 "Spare" is not a server name; "opt51" is refused ("OPT51 already exists (Rack-05 · floor 1).", Save disabled, Enter sends nothing) and its "Open OPT51" opens that server\'s window');

    // ── AS-3 Save: the floor pinned, the outlet labelled (the same PATCH as + OPT), the new window opens; the other
    //    context's Dashboard shows it within LIVE_MS ──
    await add.click(); await dlg.waitFor();
    await dlg.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
    await name.fill(NAME);
    assert.equal(await dlg.getByRole('alert').count(), 0, `${NAME} is a new name`);
    const patch = p.waitForRequest(r => r.method() === 'PATCH' && r.url().endsWith('/api/devices/pdu5/labels'));
    writes.length = 0;
    await save.click();
    const sent = await patch; const t0 = Date.now();
    assert.deepEqual(JSON.parse(sent.postData()), { ...pdu5.labels, 2: NAME }, 'the PDU\'s saved labels with the new name on outlet 2');
    assert.equal(sent.headers()['if-match'], pdu5.labels_revision, 'sent with the labels\' revision (If-Match)');
    await dlg.waitFor({ state: 'detached' });
    await win.locator('h2.lab-window-name', { hasText: NAME }).waitFor({ timeout: 15000 });
    assert.equal(new URL(p.url()).searchParams.get('srv'), KEY, 'the new server\'s window');
    await win.locator('[data-facts]', { hasText: 'Rack-05 · floor 2' }).waitFor({ timeout: 15000 });
    assert.match(await win.locator('[data-facts]').innerText(), /PDU 05 · outlet 2/);
    await p.locator('.lab-toast', { hasText: `Added ${NAME} on Rack-05 · floor 2 (PDU 05 · outlet 2).` }).waitFor();
    assert.deepEqual(writes.filter(w => !w.startsWith('POST /api/devices/move-server')).slice(0, 2), ['PUT /api/rack-slots', 'PATCH /api/devices/pdu5/labels'], 'the floor is pinned first, then the label');
    assert.equal((await get('/api/rack-slots')).data['Rack-05'][KEY], 2, 'rack_slots: Rack-05 opt52 = 2');
    assert.equal((await device('pdu5')).labels['2'], NAME);
    let took = null;
    for (;;) { if ((await outlets()).some(t => t.includes(NAME))) { took = Date.now() - t0; break; } if (Date.now() - t0 > LIVE_MS + 3000) break; await sleep(100); }
    assert.ok(took != null && took <= LIVE_MS, `the Dashboard (another context) shows ${NAME} after ${took} ms (limit ${LIVE_MS} ms)`);
    await p.keyboard.press('Escape'); await win.waitFor({ state: 'detached' });
    await p.locator('[data-rack-id="Rack-05"] [data-u-slot="2"] .server-cell[data-server="OPT52"]').waitFor({ timeout: 10000 });
    passed.push(`AS-3 Rack-05, floor 2, PDU 05 · outlet 2, ${NAME}: PUT rack-slots (opt52 = 2) then PATCH pdu5 labels (the saved labels with outlet 2 = ${NAME}, If-Match), the toast, ${NAME}'s window opens on "Rack-05 · floor 2 · PDU 05 · outlet 2"; the other context's Dashboard PDU 05 card shows it after ${took} ms; Racks draws it on floor 2`);

    // ── AS-4 the same name again is refused; Edit mode: a free floor's "+ Add server" preselects rack and floor ──
    await add.click(); await dlg.waitFor();
    await dlg.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
    await name.fill('opt52');
    await dlg.getByRole('alert').filter({ hasText: `${NAME} already exists (Rack-05 · floor 2).` }).waitFor();
    assert.equal(await save.isDisabled(), true);
    assert.match(await dlg.locator('[data-add-blocked]').innerText().catch(() => ''), /^$|has no free PDU outlet/, 'outlet 2 is not free any more');
    await p.keyboard.press('Escape'); await dlg.waitFor({ state: 'detached' });
    await p.locator('button.edit-toggle').click();
    await p.waitForFunction(() => document.querySelector('button.edit-toggle')?.getAttribute('aria-pressed') === 'true');
    const plus = p.locator('[data-rack-id="Rack-05"] [data-u-slot="4"] [data-action="add-server-floor"]');
    assert.equal(await plus.getAttribute('aria-label'), 'Add a server on floor 4 of Rack-05');
    assert.equal(await p.locator('[data-rack-id="Rack-05"] [data-u-slot="2"] [data-action="add-server-floor"]').count(), 0, 'a floor with a server has none');
    await plus.click(); await dlg.waitFor();
    assert.equal(await dlg.locator('h2').innerText(), 'Add server to Rack-05');
    assert.equal(await dlg.getByLabel('Rack', { exact: true }).inputValue(), 'Rack-05');
    assert.equal(await dlg.getByLabel('Floor', { exact: true }).inputValue(), '4', 'the floor it was opened on');
    await p.waitForFunction(() => document.activeElement?.id === 'add-server-name', null, { timeout: 10000 });   // a preselected rack starts on the name
    assert.match(await dlg.locator('[data-add-blocked]').innerText(), /Rack-05 has no free PDU outlet/, 'every outlet of Rack-05 names a server now');
    await p.keyboard.press('Escape'); await dlg.waitFor({ state: 'detached' });
    await p.locator('button.edit-toggle').click();
    passed.push(`AS-4 "opt52" is refused now (${NAME} already exists (Rack-05 · floor 2)); Edit mode: Rack-05 floor 4's "+ Add server" opens "Add server to Rack-05" on floor 4 with the name focused, and says Rack-05 has no free PDU outlet left`);

    // ── AS-5 a 390 px phone: the button under the toolbar, the dialog inside the screen ──
    const phone = await session('operator', { width: 390, height: 844 });
    const m = await page(phone, '/?tab=racks');
    await m.locator('[data-rack-id]').first().waitFor({ timeout: 30000 });
    await m.locator('.racks-phone-options button[data-action="add-server"]').click();
    await m.locator('[data-dialog="add-server"]').waitFor();
    const fit = await m.evaluate(() => { const d = document.querySelector('[data-dialog="add-server"]').getBoundingClientRect(); return { l: d.left, r: d.right, w: innerWidth, sw: document.documentElement.scrollWidth }; });
    assert.ok(fit.l >= 0 && fit.r <= fit.w && fit.sw <= fit.w, `the dialog fits 390 px (${JSON.stringify(fit)})`);
    await m.keyboard.press('Escape'); await phone.c.close();
    passed.push('AS-5 390 px: "+ Add server" under the toolbar; the dialog fits the screen, no sideways scroll');

    // ── AS-6 Viewer: no Add server anywhere ──
    const v = await page(viewer, '/?tab=racks');
    await v.locator('[data-rack-id="Rack-05"]').waitFor({ timeout: 30000 });
    assert.equal(await v.locator('[data-action="add-server"], [data-action="add-server-floor"], [data-action="add-server-rack"]').count(), 0, 'a Viewer has no Add server');
    await v.goto(origin + '/?tab=racks&rack=Rack-05'); await v.locator('#rack-detail-title').waitFor();
    assert.equal(await v.locator('[data-action^="add-server"]').count(), 0);
    passed.push('AS-6 Viewer: no "+ Add server" in the toolbar, on a floor or in the rack detail');

    assert.deepEqual(errors, [], 'no page errors');
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    for (const undo of cleanups.reverse()) { try { await undo(); } catch (e) { console.error('cleanup:', e.message); process.exitCode = 1; } }
    await browser.close();
    passed.forEach(x => console.log('PASS', x));
    console.log(process.exitCode ? 'FAILED' : `OK ${passed.length} checks`);
  }
})();
