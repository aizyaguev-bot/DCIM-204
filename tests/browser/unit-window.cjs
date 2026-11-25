// The unit and cooling windows (one-place spec v2 WP-2, §W.4): open=unit:<id> and open=cooling:<id> over any tab.
// Fixture: DCIM_TEST_ACCOUNTS=1 DCIM_FIXTURE_ONE_PLACE=1 (fresh). Every change is undone and checked. No hardware.
// UW-1 Operator edits a unit's serial number with an explicit Save (PUT /api/rack-items with If-Match).
// UW-2 A stale ETag (another session saved the list; the change feed held) gives 409: nothing saved, the edit kept.
// UW-3 A unit on a server's floor shows that server's owner, read-only, with "Open <server>"; a unit with no server keeps
//      its own owner, editable (PUT /api/opt-owners/item:<id>).
// UW-4 Move… to Storage-Main, Undo puts it back.
// UW-5 Operator Delete… on a unit not seen for 30 days (in the bar) opens the one delete dialog for {kind: unit}.
// UW-6 Cooling: an Operator edits its floor (Undo); Delete… is Admin only.
// UW-7 Add unit… (server window, Units on this floor) creates a unit and opens its window; its form sets a barcode (a
//      duplicate is refused at that field; once linked it is read only) and a shelf position.
// UW-8 Viewer: read-only details; no horizontal scroll at 1440 / 1280 / 1024 / 390 / 375 px.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9702';
const PASSWORD = 'test-password-123';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [];
  let items0 = null, chillers0 = null;
  async function session(username, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const login = await context.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(login.status(), 200, `${username} signs in`);
    const csrf = (await login.json()).csrf_token;
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${username}: ${e.message}`));
    page.on('dialog', d => { errors.push(`${username} native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
    return { context, page, csrf, username };
  }
  const win = (page, kind) => page.locator(`[data-window="${kind}"]`);
  const toast = (page, text) => page.locator('.lab-toast').filter({ hasText: text });
  const param = (page, name) => new URL(page.url()).searchParams.get(name);

  try {
    const admin = await session('admin'), operator = await session('operator'), viewer = await session('viewer');
    const api = admin.context.request;
    assert.equal((await (await api.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    assert.ok((await (await api.get(origin + '/api/devices/')).json()).some(d => d.id === 'pdu8'), 'Start the fixture with DCIM_FIXTURE_ONE_PLACE=1');
    const get = async path => (await api.get(origin + path)).json();
    const items = async () => { const r = await api.get(origin + '/api/rack-items'); return { data: await r.json(), etag: r.headers().etag }; };
    const find = (doc, id) => { for (const [rack, list] of Object.entries(doc)) { const item = list.find(i => i.id === id); if (item) return { rack, item }; } return null; };
    async function putItems(mutate) {
      const { data, etag } = await items(); mutate(data);
      const r = await api.put(origin + '/api/rack-items', { data, headers: { 'If-Match': etag, 'X-DCIM-CSRF': admin.csrf } });
      assert.equal(r.status(), 200, await r.text());
    }
    items0 = (await items()).data;
    chillers0 = await get('/api/chillers');
    const op = operator.page, uw = win(op, 'unit');

    // ── UW-1 Edit the serial number and Save ──
    const sent = [];
    op.on('request', r => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && !/\/api\/auth\//.test(r.url())) sent.push([`${r.method()} ${new URL(r.url()).pathname}`, r.headers()['if-match'] || '']); });
    await op.goto(origin + '/?tab=dashboard&open=unit:u-old-nic');
    await uw.locator('h2', { hasText: 'Old NIC' }).waitFor();
    assert.equal((await uw.locator('.lab-window-state').innerText()).trim(), 'Rack-04 · floor 3');
    await uw.locator('.lab-window-badge').getByText(/^Not seen 4\d days$/).waitFor();
    const serial = uw.getByLabel('Serial number', { exact: true });
    assert.equal(await serial.inputValue(), 'OLD-NIC-001');
    await serial.fill('OLD-NIC-002');
    await uw.locator('[data-action="save-unit"]').click();
    await toast(op, 'Saved Old NIC.').waitFor();
    assert.equal(find((await items()).data, 'u-old-nic').item.serial_number, 'OLD-NIC-002');
    assert.equal(sent.at(-1)[0], 'PUT /api/rack-items');
    assert.ok(sent.at(-1)[1], 'the save sends If-Match');
    await uw.locator('[data-facts]').getByText('SN OLD-NIC-002', { exact: true }).waitFor();
    checks.push('UW-1 open=unit:u-old-nic ("Rack-04 · floor 3", badge "Not seen 4x days"): Serial number OLD-NIC-001 → OLD-NIC-002 with Save (PUT /api/rack-items with If-Match)');

    // ── UW-2 A stale ETag: 409, nothing saved, the edit kept ──
    await op.route('**/api/changes', route => route.fulfill({ status: 503, body: '{}' }));
    await op.waitForTimeout(3000);   // reloads this window's own save started are over before the other session saves
    await putItems(d => { d['Rack-01'] = d['Rack-01'].map(i => (i.id === 'ci-1' ? { ...i, notes: 'Changed in another session' } : i)); });
    const model = uw.getByLabel('Model', { exact: true });
    await model.fill('QA model');
    await uw.locator('[data-action="save-unit"]').click();
    await uw.locator('[data-unit-error]').getByText('Equipment changed in another session, so nothing was saved.', { exact: false }).waitFor();
    assert.equal(find((await items()).data, 'u-old-nic').item.model, undefined, 'nothing was saved');
    assert.equal(find((await items()).data, 'ci-1').item.notes, 'Changed in another session', 'the other session\'s change is kept');
    assert.equal(await model.inputValue(), 'QA model', 'the edit is kept');
    await op.unroute('**/api/changes');
    await uw.locator('[data-action="save-unit"]').click();
    await toast(op, 'Saved Old NIC.').nth(0).waitFor();
    await op.waitForFunction(() => document.querySelector('[data-window="unit"] [data-facts]')?.innerText.includes('QA model'), null, { timeout: 10000 });
    assert.equal(find((await items()).data, 'u-old-nic').item.model, 'QA model');
    checks.push('UW-2 another session saved the equipment list (change feed held): Save gets 409, "Equipment changed in another session, so nothing was saved", the edit stays; the next Save works');

    // ── UW-3 Owner: derived and read-only on a server's floor; its own owner otherwise ──
    await op.goto(origin + '/?tab=dashboard&open=unit:u-tray53');
    await uw.locator('h2', { hasText: 'Tray 53' }).waitFor();
    const derived = uw.locator('[data-unit-owner="derived"]');
    await derived.locator('[data-owner-value]').getByText('Alice Feed', { exact: true }).waitFor();
    await derived.getByText('From OPT53, the server on this floor. Change it on the server.', { exact: true }).waitFor();
    assert.equal(await uw.locator('select[aria-label^="Owner for"]').count(), 0, 'no owner select on a server\'s floor');
    await derived.getByRole('button', { name: 'Open OPT53', exact: true }).click();
    await win(op, 'server').locator('h2', { hasText: 'OPT53' }).waitFor();
    assert.equal(param(op, 'srv'), 'opt53');
    await op.goBack();
    await uw.locator('h2', { hasText: 'Tray 53' }).waitFor();
    await op.goto(origin + '/?tab=dashboard&open=unit:storage-fixture');
    await uw.locator('h2', { hasText: 'Spare switch' }).waitFor();
    const own = uw.getByLabel('Owner for Spare switch', { exact: true });
    await own.selectOption({ label: 'Yaniv Shnur' });
    await uw.locator('[data-unit-owner="own"]').getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    assert.equal((await get('/api/opt-owners'))['item:storage-fixture'], 'Yaniv Shnur');
    await own.selectOption({ value: '' });
    await op.waitForTimeout(800);
    assert.equal((await get('/api/opt-owners'))['item:storage-fixture'], undefined);
    checks.push('UW-3 Tray 53 (OPT53\'s floor) shows Alice Feed read-only, "From OPT53, the server on this floor. Change it on the server.", and "Open OPT53" opens the server window (Back returns); Spare switch (no server) has its own owner select (item:storage-fixture saved, then cleared)');

    // ── UW-4 Move… to Storage-Main, Undo ──
    await op.goto(origin + '/?tab=dashboard&open=unit:u-old-nic');
    await uw.locator('h2', { hasText: 'Old NIC' }).waitFor();
    await uw.getByRole('button', { name: 'Move…', exact: true }).click();
    const moveDialog = op.locator('[data-dialog="unit-move"]');
    await moveDialog.waitFor();
    await moveDialog.getByLabel('Rack').selectOption('Storage-Main');
    await moveDialog.getByLabel('Shelf').selectOption('0');
    await moveDialog.getByRole('button', { name: 'Move to Storage-Main', exact: true }).click();
    await moveDialog.waitFor({ state: 'detached' });
    await op.waitForFunction(() => document.querySelector('[data-window="unit"] .lab-window-state')?.innerText.trim() === 'Storage-Main', null, { timeout: 10000 });
    let at = find((await items()).data, 'u-old-nic');
    assert.deepEqual([at.rack, at.item.u], ['Storage-Main', 0]);
    await toast(op, 'Moved Old NIC to Storage-Main.').getByRole('button', { name: 'Undo', exact: true }).click();
    await toast(op, 'Old NIC is back on Rack-04 · floor 3.').waitFor();
    at = find((await items()).data, 'u-old-nic');
    assert.deepEqual([at.rack, at.item.u], ['Rack-04', 3]);
    checks.push('UW-4 Move… Old NIC to Storage-Main (whole storage): saved and shown; Undo puts it back on Rack-04 · floor 3');

    // ── UW-5 Operator Delete… (in the bar: not seen for 30 days) opens the one delete dialog for {kind: unit} ──
    const deletes = [];
    op.on('request', r => { if (r.method() === 'POST' && /\/api\/lab\/delete$/.test(r.url())) deletes.push(JSON.parse(r.postData() || '{}')); });
    await uw.locator('.lab-window-bar').getByRole('button', { name: 'Delete…', exact: true }).click();
    const del = op.locator('[data-dialog="delete"]');
    await del.waitFor();
    const stub = /not available yet/.test(await del.innerText());
    assert.ok(!stub, 'Delete… opens the one DeleteDialog (WP-D), not its stub');
    // WP-D's DeleteDialog: wait for its preview, type the name when it asks, delete; the window closes.
    async function confirmDelete(page, dialog, name) {
      await page.waitForFunction(() => document.querySelector('[data-dialog="delete"]')?.getAttribute('aria-busy') === 'false', null, { timeout: 20000 });
      await dialog.getByText(name, { exact: false }).first().waitFor();
      const typed = dialog.locator('#lab-delete-confirm');
      if (await typed.count()) await typed.fill(name);
      await dialog.locator('button[data-action="delete"]').click();
      await dialog.waitFor({ state: 'detached' });
    }
    if (stub) {
      await del.getByRole('heading', { name: 'Delete u-old-nic', exact: true }).waitFor();
      await del.getByRole('button', { name: 'Close', exact: true }).click();
      await del.waitFor({ state: 'detached' });
    } else {
      await confirmDelete(op, del, 'Old NIC');
      assert.ok(deletes.some(b => JSON.stringify(b.targets) === JSON.stringify([{ kind: 'unit', id: 'u-old-nic' }])), JSON.stringify(deletes));
      assert.equal(find((await items()).data, 'u-old-nic'), null, 'deleted');
      await op.locator('.lab-toast').filter({ hasText: 'Deleted Old NIC' }).getByRole('button', { name: 'Undo', exact: true }).click();
      await op.locator('.lab-toast').filter({ hasText: 'Restored' }).waitFor({ timeout: 15000 });
      assert.ok(find((await items()).data, 'u-old-nic'), 'Undo brought it back');
      // Deleted again, its window shows "Deleted …" with Restore (Operator).
      await op.goto(origin + '/?tab=dashboard&open=unit:u-old-nic');
      await uw.locator('h2', { hasText: 'Old NIC' }).waitFor();
      await uw.locator('.lab-window-bar').getByRole('button', { name: 'Delete…', exact: true }).click();
      await del.waitFor();
      await confirmDelete(op, del, 'Old NIC');
      await op.goto(origin + '/?tab=dashboard&open=unit:u-old-nic');
      const banner = uw.locator('[data-deleted-banner]');
      await banner.waitFor();
      assert.match(await banner.innerText(), /^Deleted /);
      assert.equal((await uw.locator('h2').innerText()).trim(), 'Old NIC', 'the deleted unit is named, not shown by its id');
      assert.equal((await uw.locator('.lab-window-state').innerText()).trim(), 'Deleted');
      await banner.getByRole('button', { name: 'Restore', exact: true }).click();
      await toast(op, 'Old NIC is back.').waitFor({ timeout: 15000 });
      await uw.locator('[data-unit-form]').waitFor();
      assert.ok(find((await items()).data, 'u-old-nic'), 'restored from its window');
      // An id that is in no list: "No unit with id …" and a search that opens a unit in its place.
      await op.goto(origin + '/?tab=dashboard&open=unit:no-such-unit');
      await uw.getByText('No unit with id no-such-unit in Lab Manager.', { exact: true }).waitFor();
      await uw.getByLabel('Find a unit', { exact: true }).fill('old nic');
      await uw.locator('.lab-window-results').getByRole('button', { name: 'Old NIC', exact: true }).click();
      await uw.locator('[data-unit-form]').waitFor();
      assert.equal(param(op, 'open'), 'unit:u-old-nic');
    }
    checks.push(`UW-5 Operator: Delete… sits in the bar of a unit not seen for 30 days and opens the delete dialog for {kind: unit, id: u-old-nic}${stub ? ' (WP-D DeleteDialog not built yet: the stub names it)' : '; deleted (the window closes), Undo in the toast brought it back; deleted again, its window says "Deleted …" under its name and Restore brought it back; an unknown id offers a search that opens Old NIC'}`);

    // ── UW-6 Cooling: an Operator moves it (Undo); Delete… is Admin only ──
    const cw = win(op, 'cooling');
    await op.goto(origin + '/?tab=dashboard&open=cooling:ch5');
    await cw.locator('h2', { hasText: 'Cooling' }).waitFor();
    assert.equal((await cw.locator('.lab-window-state').innerText()).trim(), 'Rack-05 · Floor 3');
    await cw.getByLabel('Floor', { exact: true }).selectOption('4');
    await cw.getByRole('button', { name: 'Save', exact: true }).click();
    await toast(op, 'Cooling: Rack-05 · Floor 4.').waitFor();
    assert.equal((await get('/api/chillers')).units.find(u => u.id === 'ch5').u, 4);
    await toast(op, 'Cooling: Rack-05 · Floor 4.').getByRole('button', { name: 'Undo', exact: true }).click();
    await toast(op, 'Cooling is back at Rack-05 · Floor 3.').waitFor();
    assert.equal((await get('/api/chillers')).units.find(u => u.id === 'ch5').u, 3);
    assert.equal(await cw.getByRole('button', { name: '⋯ More', exact: true }).count(), 0, 'an Operator has no Delete… for a cooling unit');
    assert.equal(await cw.getByRole('button', { name: 'Delete…', exact: true }).count(), 0);
    const ad = admin.page, acw = win(ad, 'cooling');
    await ad.goto(origin + '/?tab=dashboard&open=cooling:ch5');
    await acw.locator('h2', { hasText: 'Cooling' }).waitFor();
    await acw.getByRole('button', { name: '⋯ More', exact: true }).click();
    await acw.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    const adel = ad.locator('[data-dialog="delete"]');
    await adel.waitFor();
    assert.doesNotMatch(await adel.innerText(), /not available yet/, 'the one DeleteDialog (WP-D), not its stub');
    if (/not available yet/.test(await adel.innerText())) {
      await adel.getByRole('heading', { name: 'Delete ch5', exact: true }).waitFor();
      await adel.getByRole('button', { name: 'Close', exact: true }).click();
    } else {
      await confirmDelete(ad, adel, 'Cooling');
      assert.equal((await get('/api/chillers')).units.some(u => u.id === 'ch5'), false, 'deleted');
      await ad.locator('.lab-toast').filter({ hasText: 'Deleted Cooling' }).getByRole('button', { name: 'Undo', exact: true }).click();
      await ad.locator('.lab-toast').filter({ hasText: 'Restored' }).waitFor({ timeout: 15000 });
      assert.ok((await get('/api/chillers')).units.some(u => u.id === 'ch5'), 'Undo restored the cooling unit');
    }
    await adel.waitFor({ state: 'detached' });
    checks.push(`UW-6 open=cooling:ch5: an Operator moves it to Floor 4 in the embedded form and Undo puts it back; Operators have no Delete…, Admin More › Delete… opens the delete dialog for ch5${stub ? '' : ' (deleted, Undo in the toast restored it)'}`);

    // ── UW-7 Add unit… from the server window's "Units on this floor" ──
    await op.goto(origin + '/?tab=dashboard&srv=opt51&sec=units');
    const sw = win(op, 'server');
    await sw.locator('h2', { hasText: 'OPT51' }).waitFor();
    await sw.getByRole('button', { name: 'Add unit…', exact: true }).click();
    const add = op.locator('[data-dialog="add-unit"]');
    await add.waitFor();
    assert.equal(await add.getByLabel('Rack').inputValue(), 'Rack-05');
    assert.equal(await add.getByLabel('Floor').inputValue(), '1');
    await add.getByLabel('Name').fill('QA window unit');
    await add.getByLabel('Serial number (optional)').fill('QA-WIN-UNIT-1');
    await add.getByRole('button', { name: 'Add to Rack-05 · floor 1', exact: true }).click();
    await uw.locator('h2', { hasText: 'QA window unit' }).waitFor();
    assert.match(param(op, 'open'), /^unit:ci-/);
    const created = Object.values((await items()).data).flat().find(i => i.serial_number === 'QA-WIN-UNIT-1');
    assert.ok(created && created.u === 1 && find((await items()).data, created.id).rack === 'Rack-05');
    await uw.locator('[data-unit-owner="derived"]').getByText('From OPT51, the server on this floor.', { exact: false }).waitFor();
    // The form's barcode (locked once linked) and shelf position (v2 §W.4): a barcode another unit has is refused at its field.
    const barcode = uw.getByLabel('Barcode', { exact: true }), position = uw.getByLabel('Shelf position', { exact: true });
    await barcode.fill('TEST-002');
    await uw.locator('[data-action="save-unit"]').click();
    await uw.getByRole('alert').filter({ hasText: 'already belongs to another item' }).waitFor();
    assert.equal(await barcode.getAttribute('aria-invalid'), 'true', 'the refusal is shown at the Barcode field');
    assert.equal(find((await items()).data, created.id).item.barcode, undefined, 'nothing saved');
    await barcode.fill('QA-WIN-BC-1');
    await position.fill('left slot');
    await uw.locator('[data-action="save-unit"]').click();
    await toast(op, 'Saved QA window unit.').waitFor();
    const linked = find((await items()).data, created.id).item;
    assert.deepEqual([linked.barcode, linked.shelf_position], ['QA-WIN-BC-1', 'left slot']);
    await uw.locator('[data-barcode-linked]').waitFor();
    assert.equal(await uw.getByLabel('Barcode', { exact: true }).getAttribute('readonly'), '', 'a linked barcode is read only');
    assert.equal(await position.inputValue(), 'left slot');
    await op.goBack();
    await sw.locator(`[data-unit-id="${created.id}"]`).waitFor();
    await putItems(d => { d['Rack-05'] = d['Rack-05'].filter(i => i.id !== created.id); });
    checks.push('UW-7 OPT51 › Units on this floor › Add unit… (Rack-05 floor 1 preset) creates "QA window unit" and opens its window (owner from OPT51); barcode TEST-002 (Switch 02 has it) refused at its field, QA-WIN-BC-1 and shelf position "left slot" saved, the linked barcode read only; Back lists it under OPT51');

    // ── UW-8 Viewer read only; no horizontal scroll ──
    const vp = viewer.page, vw = win(vp, 'unit');
    await vp.goto(origin + '/?tab=dashboard&open=unit:u-tray53');
    await vw.locator('h2', { hasText: 'Tray 53' }).waitFor();
    await vw.getByText('Viewer · read only', { exact: true }).waitFor();
    await vw.locator('[data-unit-details]').getByText('TRAY-053', { exact: true }).waitFor();
    for (const sel of ['[data-unit-form]', '[data-action="move-unit"]', '[data-action="save-unit"]', 'select']) assert.equal(await vw.locator(sel).count(), 0, `a Viewer has no ${sel}`);
    await vp.goto(origin + '/?tab=dashboard&open=cooling:ch5');
    await win(vp, 'cooling').locator('[data-cooling-form="view"]').waitFor();
    for (const width of [1440, 1280, 1024, 390, 375]) {
      await op.setViewportSize({ width, height: width < 600 ? 812 : 900 });
      await op.goto(origin + '/?tab=racks&open=unit:u-tray53');
      await uw.locator('h2', { hasText: 'Tray 53' }).waitFor();
      await op.waitForTimeout(200);
      const size = await op.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth,
        panel: (() => { const w = document.querySelector('[data-window]'); return w ? w.scrollWidth - w.clientWidth : 0; })() }));
      assert.ok(size.doc <= size.view && size.panel <= 0, `${width} px: no horizontal scroll ${JSON.stringify(size)}`);
    }
    checks.push('UW-8 Viewer: Tray 53 read only (details, no form, no Move), the cooling form in view mode; no horizontal scroll at 1440 / 1280 / 1024 / 390 / 375 px');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    try {
      const a = await browser.newContext();
      const login = await a.request.post(origin + '/api/auth/login', { data: { username: 'admin', password: PASSWORD } });
      const h = { 'X-DCIM-CSRF': (await login.json()).csrf_token };
      if (items0) {
        const g = await a.request.get(origin + '/api/rack-items');
        const r = await a.request.put(origin + '/api/rack-items', { data: items0, headers: { ...h, 'If-Match': g.headers().etag } });
        if (r.status() !== 200) throw new Error(`rack-items: ${await r.text()}`);
      }
      if (chillers0) {
        const now = await (await a.request.get(origin + '/api/chillers')).json();
        if (!now.units.some(u => u.id === 'ch5') || now.units.find(u => u.id === 'ch5').u !== 3) throw new Error('ch5 is not back on Rack-05 floor 3');
      }
      const r = await a.request.put(origin + '/api/opt-owners/item%3Astorage-fixture', { data: { engineer_id: null }, headers: h });
      if (r.status() !== 200) throw new Error(`owner: ${await r.text()}`);
      checks.push('fixture put back: the equipment list as it was, ch5 on Rack-05 floor 3, no owner on the storage unit');
      await a.close();
    } catch (e) { console.error('restore:', e.message); process.exitCode = 1; }
    await browser.close();
    checks.forEach(c => console.log('PASS', c));
    console.log(process.exitCode ? 'FAILED' : `OK ${checks.length} checks`);
  }
})();
