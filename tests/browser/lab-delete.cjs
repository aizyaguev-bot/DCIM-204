// Delete and restore (one-place spec v2 §D, WP-D Accept 1-8): the one delete dialog's preview (what is deleted, what else
// changes, what blocks it), its confirm rules (a button naming the item, its typed name, the typed count), the toast's
// Undo, the lab display (TV) and the 3D twin following a delete within seconds, and the roles.
// Fixture: DCIM_TEST_ACCOUNTS=1 DCIM_FIXTURE_ONE_PLACE=1 FIXTURE_PXE_HOLD=1 POWER_PROTECTED_OUTLETS=pdu1:4, fresh. Nothing is
// written to a PDU or KVM (the fixture's devices are database rows; device name sync is off).
//
// Entry points: a server window has Delete… (⋯ More); the PDU, KVM, unit and 3D windows get theirs in later packages, so
// until a window shows Delete… this suite opens the same dialog through the provider's act.openDelete (found on the React
// tree), exactly what a window's Delete… calls.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9660';
const PASSWORD = 'test-password-123';
const FIVE_S = 5000;

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [];
  async function session(username, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* ignore */ } });
    await context.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
    const login = await context.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(login.status(), 200, `${username} signs in`);
    const csrf = (await login.json()).csrf_token;
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${username}: ${e.message}`));
    page.on('dialog', d => { errors.push(`${username} native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
    return { context, csrf, page, username };
  }
  const json = async (s, path) => (await s.context.request.get(origin + path)).json();
  const dialog = page => page.locator('[data-dialog="delete"]');
  const deleteButton = page => dialog(page).locator('[data-action="delete"]');
  const toast = page => page.locator('.lab-toast').last();

  // A window's Delete… when it has one (bar, else ⋯ More), else the provider's act.openDelete with the same target.
  async function openDelete(page, targets, { windowFirst = true } = {}) {
    if (windowFirst) {
      const win = page.locator('[data-window]');
      if (await win.count()) {
        const bar = win.getByRole('button', { name: 'Delete…', exact: true });
        if (await bar.count()) await bar.click();
        else {
          const more = win.getByRole('button', { name: '⋯ More' });
          if (await more.count()) {
            await more.click();
            const item = win.getByRole('menuitem', { name: 'Delete…', exact: true });
            if (await item.count()) await item.click();
            else await page.keyboard.press('Escape');
          }
        }
      }
    }
    if (!(await dialog(page).count())) {
      await page.locator('[data-window-backdrop]').waitFor({ state: 'attached', timeout: 30000 });
      await page.evaluate(list => {
        const root = document.querySelector('[data-window-backdrop]');
        const key = root && Object.keys(root).find(k => k.startsWith('__reactFiber$'));
        for (let fiber = key ? root[key] : null; fiber; fiber = fiber.return) {
          const value = fiber.memoizedProps?.value;
          if (value?.act && typeof value.act.openDelete === 'function') { value.act.openDelete(list); return; }
        }
        throw new Error('the lab window provider is not on the page');
      }, targets);
    }
    await dialog(page).waitFor();
    await deleteButton(page).waitFor();
    // the preview has arrived when the item list and the button are there and nothing is checking any more
    await page.waitForFunction(() => {
      const d = document.querySelector('[data-dialog="delete"]');
      return d && d.getAttribute('aria-busy') === 'false' && d.querySelector('[data-list="items"]');
    }, null, { timeout: 30000 });
    return dialog(page);
  }

  try {
    const admin = await session('admin'), operator = await session('operator'), viewer = await session('viewer', { width: 1920, height: 1080 });
    assert.equal((await json(admin, '/api/version')).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const devices = await json(admin, '/api/devices/');
    assert.ok(devices.some(d => d.id === 'pdu8'), 'Start the fixture with DCIM_FIXTURE_ONE_PLACE=1 (PDU-Rack-08 is missing)');
    const page = admin.page;

    // ── The lab display (TV) as a Viewer, before anything is deleted: 8 PDUs and PDU-Rack-08's open alert ──
    const tv = viewer.page;
    await tv.goto(origin + '/?tab=display');
    const kpiPdus = tv.locator('[data-testid="kpi-pdus"]');
    await kpiPdus.waitFor({ timeout: 30000 });
    await tv.waitForFunction(() => /\/\s*8(?!\d)/.test(document.querySelector('[data-testid="kpi-pdus"]')?.textContent || ''), null, { timeout: 30000 });
    const attention = tv.locator('.ld-attention');
    await tv.waitForFunction(() => (document.querySelector('.ld-attention')?.textContent || '').includes('PDU-Rack-08: PDU API availability'), null, { timeout: 30000 });
    const attentionCount = async () => Number((await tv.locator('.ld-attention .ld-count').textContent()).replace(/\D+/g, '') || 0);
    const before = await attentionCount();

    // ── 1. Admin, Dashboard, open=dev:pdu8 › Delete…: PDU-Rack-08, ITEM-0040, "alert closed"; "Delete PDU-Rack-08" ──
    await page.goto(origin + '/?tab=dashboard&open=dev:pdu8');
    await page.locator('[data-window]').waitFor();
    let d = await openDelete(page, [{ kind: 'device', id: 'pdu8' }]);
    const text = await d.innerText();
    for (const part of ['PDU-Rack-08', 'ITEM-0040', 'alert closed']) assert.ok(text.includes(part), `the preview lists ${part}: ${text}`);
    assert.equal((await deleteButton(page).innerText()).trim(), 'Delete PDU-Rack-08');
    assert.equal(await deleteButton(page).isEnabled(), true, 'no signs of life: one red button, no typing');
    assert.equal(await d.locator('#lab-delete-confirm').count(), 0);
    await deleteButton(page).click();
    await dialog(page).waitFor({ state: 'detached', timeout: 15000 });
    await page.locator('.lab-toast', { hasText: 'Deleted PDU-Rack-08' }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('[data-window]').count(), 0, 'the window closes after the delete');
    assert.ok(!(await json(admin, '/api/devices/')).some(x => x.id === 'pdu8'), 'PDU-Rack-08 is deleted');
    checks.push('1: open=dev:pdu8 › Delete… lists PDU-Rack-08, ITEM-0040 and "alert closed"; "Delete PDU-Rack-08"; applied, window closed');

    // ── 2. the Viewer's TV drops the PDU from its KPI and the alert from Attention within 5 s ──
    const t0 = Date.now();
    await tv.waitForFunction(() => /\/\s*7(?!\d)/.test(document.querySelector('[data-testid="kpi-pdus"]')?.textContent || ''), null, { timeout: FIVE_S + 2500 });
    await tv.waitForFunction(() => !(document.querySelector('.ld-attention')?.textContent || '').includes('PDU-Rack-08'), null, { timeout: FIVE_S + 2500 });
    const tvSeconds = (Date.now() - t0) / 1000;
    assert.ok(tvSeconds <= 7.5, `the TV followed in ${tvSeconds}s`);
    assert.ok(await attentionCount() < before, 'fewer Attention items');
    const alertMails = (await json(admin, '/api/monitoring')).email_alerts?.recent?.filter(r => /PDU-Rack-08/.test(r.subject)).map(r => r.subject) || [];
    assert.equal(alertMails[0], '[DCIM closed] PDU-Rack-08: PDU API availability', 'the alert is closed, never "recovered"');
    assert.ok(!alertMails.some(s => s.startsWith('[DCIM recovered]')));
    checks.push(`2: the Viewer's TV shows 7 PDUs and no PDU-Rack-08 Attention item ${tvSeconds.toFixed(1)}s after the delete`);

    // ── 3. Undo brings the PDU back within 5 s; the alert stays closed ──
    const t1 = Date.now();
    await page.locator('.lab-toast', { hasText: 'Deleted PDU-Rack-08' }).getByRole('button', { name: 'Undo' }).click();
    await page.locator('.lab-toast', { hasText: 'Restored PDU-Rack-08' }).waitFor({ timeout: 10000 });
    await tv.waitForFunction(() => /\/\s*8(?!\d)/.test(document.querySelector('[data-testid="kpi-pdus"]')?.textContent || ''), null, { timeout: FIVE_S + 2500 });
    const undoSeconds = (Date.now() - t1) / 1000;
    assert.ok(undoSeconds <= 7.5, `Undo reached the TV in ${undoSeconds}s`);
    await tv.waitForTimeout(2500);
    assert.ok(!(await attention.textContent()).includes('PDU-Rack-08: PDU API availability'), 'the alert stays closed');
    const back = (await json(admin, '/api/devices/')).find(x => x.id === 'pdu8');
    assert.ok(back && back.name === 'PDU-Rack-08' && back.rack === 'Rack-08', 'PDU-Rack-08 is back as it was');
    checks.push(`3: Undo restored PDU-Rack-08 (TV back to 8 PDUs in ${undoSeconds.toFixed(1)}s); its alert stays closed`);

    // ── 4. Blockers: pdu1 (protected), kvm2 (remote install's console port), pdu2 (remote install's PDU), OPT21 (its key) ──
    const blockerOf = async (targets, expected, open) => {
      if (open) await open(); else await page.goto(origin + '/?tab=dashboard');
      const dd = await openDelete(page, targets, { windowFirst: !!open });
      const blocked = dd.locator('[data-list="blockers"]');
      await blocked.waitFor();
      const shown = await blocked.innerText();
      assert.ok(shown.includes(expected), `${JSON.stringify(targets)} shows "${expected}": ${shown}`);
      assert.equal(await deleteButton(page).isDisabled(), true, 'Delete is disabled while something blocks it');
      await dd.getByRole('button', { name: 'Cancel' }).click();
      await dialog(page).waitFor({ state: 'detached' });
    };
    await blockerOf([{ kind: 'device', id: 'pdu1' }], 'Remove PDU 01 from POWER_PROTECTED_OUTLETS in the server settings first');
    await blockerOf([{ kind: 'device', id: 'kvm2' }], 'Remote install is running on OPT21 through KVM 02 · port 1; finish or cancel it first.');
    await blockerOf([{ kind: 'device', id: 'pdu2' }], 'Remote install is running on OPT21 with PDU 02; finish or cancel it first.');
    await blockerOf([{ kind: 'server', id: 'opt21' }], 'Remote install is running on OPT21; finish or cancel it first.', async () => {
      await page.goto(origin + '/?tab=dashboard&srv=opt21');
      await page.locator('[data-window="server"]').waitFor();
    });
    checks.push('4: pdu1 (protected), kvm2 (PXE console port), pdu2 (PXE PDU) and OPT21 (PXE key, from its window) show their blocker; Delete disabled');

    // ── 5. pdu3 answers and draws: its name must be typed; OPT31-34 are kept ──
    await page.goto(origin + '/?tab=dashboard&open=dev:pdu3');
    await page.locator('[data-window]').waitFor();
    d = await openDelete(page, [{ kind: 'device', id: 'pdu3' }]);
    assert.ok((await d.locator('[data-evidence]').innerText()).includes('Answers now'), 'the red evidence line');
    const kept = await d.locator('[data-group="servers_kept"]').innerText();
    for (const server of ['OPT31', 'OPT32', 'OPT33', 'OPT34']) assert.ok(kept.includes(server), `${server} is kept: ${kept}`);
    assert.ok(/OPT32 is kept \(still answers\)/.test(kept), kept);
    const confirmBox = d.locator('#lab-delete-confirm');
    assert.equal((await d.locator('label[for="lab-delete-confirm"]').innerText()).trim(), 'Type PDU 03 to delete it');
    assert.equal(await deleteButton(page).isDisabled(), true, 'disabled until the name is typed');
    await confirmBox.fill('PDU 0');
    assert.equal(await deleteButton(page).isDisabled(), true);
    await confirmBox.fill('PDU 03');
    assert.equal(await deleteButton(page).isEnabled(), true, 'enabled once "PDU 03" is typed');
    await d.getByRole('button', { name: 'Cancel' }).click();
    await dialog(page).waitFor({ state: 'detached' });
    checks.push('5: deleting pdu3 asks for "PDU 03"; OPT31 (still on KVM 03) and OPT32-34 (still answer) are kept');

    // ── 6. OPT11 from its window: frees PDU 01·1 and KVM 01·1, the twin drops it; Undo writes the names back ──
    const twinHas = async () => {
      const t = await admin.context.newPage();
      t.on('pageerror', e => errors.push(`twin: ${e.message}`));
      await t.goto(origin + '/twin/');
      await t.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.model?.items?.length && window.__twin.S.live.devices?.length, null, { timeout: 60000 });
      await t.waitForFunction(() => 'removed' in window.__twin.S.live, null, { timeout: 20000 }).catch(() => {});
      await t.waitForTimeout(1000);
      const has = await t.evaluate(() => window.__twin.S.model.items.some(i => i.type === 'opt' && window.__twin.pingKey(i.name) === 'opt11'));
      await t.close();
      return has;
    };
    assert.equal(await twinHas(), true, 'the twin shows OPT11 before');
    await page.goto(origin + '/?tab=dashboard&srv=opt11');
    await page.locator('[data-window="server"]').waitFor();
    d = await openDelete(page, [{ kind: 'server', id: 'opt11' }]);
    const freed = await d.locator('[data-group="ports_freed"]').innerText();
    assert.ok(freed.includes('PDU 01 · outlet 1: OPT11 → Outlet 1') && freed.includes('KVM 01 · port 1: OPT11 → Port 1'), freed);
    await d.locator('#lab-delete-confirm').fill('OPT11');
    await deleteButton(page).click();
    await page.locator('.lab-toast', { hasText: 'Deleted OPT11' }).waitFor({ timeout: 15000 });
    const labelOf = async (id, port) => (await json(admin, '/api/devices/')).find(x => x.id === id).labels[port];
    assert.equal(await labelOf('pdu1', '1'), 'Outlet 1');
    assert.equal(await labelOf('kvm1', '1'), 'Port 1');
    await page.goto(origin + '/?tab=dashboard');
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    assert.equal(await twinHas(), false, 'the twin drops OPT11');
    // The toast's Undo is gone by now (15 s; the twin took longer): Restore the batch as Manage › Deleted does.
    const batch = (await json(admin, '/api/lab/deleted')).batches.find(b => b.entries.some(e => e.id === 'opt11'));
    const listed = await admin.context.request.get(origin + '/api/lab/deleted');
    const plan = await (await admin.context.request.post(origin + '/api/lab/restore', { headers: { 'x-dcim-csrf': admin.csrf },
      data: { batch: batch.id, dry_run: true } })).json();
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.consequences.ports_restored.length === 2, JSON.stringify(plan.consequences));
    const r = await admin.context.request.post(origin + '/api/lab/restore', { headers: { 'x-dcim-csrf': admin.csrf, 'If-Match': listed.headers()['etag'] },
      data: { batch: batch.id, plan_revision: plan.plan_revision } });
    assert.equal(r.status(), 200, await r.text());
    assert.equal(await labelOf('pdu1', '1'), 'OPT11', 'Restore writes the outlet name back');
    assert.equal(await labelOf('kvm1', '1'), 'OPT11', 'and the KVM port name');
    assert.ok(!(await json(admin, '/api/removed-servers')).hidden.includes('opt11'));
    checks.push('6: OPT11 deleted from its window (name typed) frees PDU 01·1 and KVM 01·1, the twin drops it; Restore writes both back');

    // ── 7. a bulk delete of 3 asks for "3"; Undo puts the three 3D records back ──
    await page.goto(origin + '/?tab=dashboard');
    d = await openDelete(page, [{ kind: 'twin', id: 'ITEM-0044' }, { kind: 'twin', id: 'ITEM-0045' }, { kind: 'twin', id: 'ITEM-0048' }], { windowFirst: false });
    assert.equal(await d.locator('[data-list="items"] input[type="checkbox"]:checked').count(), 3, 'no signs of life: all three ticked');
    assert.equal((await d.locator('label[for="lab-delete-confirm"]').innerText()).trim(), 'Type 3 to delete 3 items');
    assert.equal(await deleteButton(page).isDisabled(), true);
    await d.locator('#lab-delete-confirm').fill('3');
    assert.equal((await deleteButton(page).innerText()).trim(), 'Delete 3 items');
    await deleteButton(page).click();
    await page.locator('.lab-toast', { hasText: 'Deleted 3 items' }).waitFor({ timeout: 15000 });
    const twinIds = async () => new Set(((await json(admin, '/api/twin-data')).items || []).map(i => i.id));
    let ids = await twinIds();
    assert.ok(!ids.has('ITEM-0044') && !ids.has('ITEM-0045') && !ids.has('ITEM-0048'), 'the three records are gone from lab-data.json');
    await page.locator('.lab-toast', { hasText: 'Deleted 3 items' }).getByRole('button', { name: 'Undo' }).click();
    await page.locator('.lab-toast', { hasText: 'Restored 3 items' }).waitFor({ timeout: 10000 });
    ids = await twinIds();
    assert.ok(ids.has('ITEM-0044') && ids.has('ITEM-0045') && ids.has('ITEM-0048'), 'Undo puts them back');
    checks.push('7: a bulk delete of 3 asks for "3" ("Delete 3 items"); Undo restores all three');

    // ── 8. Operator: unit u-pc300 with Undo; no Delete on devices; the API answers 403 for a device ──
    const op = operator.page;
    await op.goto(origin + '/?tab=dashboard&open=unit:u-pc300');
    await op.locator('[data-window]').waitFor();
    d = await openDelete(op, [{ kind: 'unit', id: 'u-pc300' }]);
    assert.ok((await d.innerText()).includes('OPT300 stays in Ping Monitor; an Admin can delete it'), 'the Operator is told the server stays');
    assert.equal((await deleteButton(op).innerText()).trim(), 'Delete OPT300');
    await deleteButton(op).click();
    await op.locator('.lab-toast', { hasText: 'Deleted OPT300' }).waitFor({ timeout: 15000 });
    const unitIds = async () => new Set(Object.values(await json(operator, '/api/rack-items')).flat().map(u => u.id));
    assert.equal((await unitIds()).has('u-pc300'), false, 'the unit is deleted');
    await op.locator('.lab-toast', { hasText: 'Deleted OPT300' }).getByRole('button', { name: 'Undo' }).click();
    await op.locator('.lab-toast', { hasText: 'Restored OPT300' }).waitFor({ timeout: 10000 });
    assert.equal((await unitIds()).has('u-pc300'), true, 'Undo brings the unit back');
    await op.goto(origin + '/?tab=dashboard&open=dev:pdu8');
    await op.locator('[data-window]').waitFor();
    await op.waitForTimeout(500);
    assert.equal(await op.locator('[data-window]').getByRole('button', { name: 'Delete…' }).count(), 0, 'no Delete… in a device window');
    const more = op.locator('[data-window]').getByRole('button', { name: '⋯ More' });
    if (await more.count()) {
      await more.click();
      assert.equal(await op.locator('[data-window]').getByRole('menuitem', { name: 'Delete…' }).count(), 0, 'nor in its ⋯ More');
      await op.keyboard.press('Escape');
    }
    const refused = await operator.context.request.post(origin + '/api/lab/delete', { headers: { 'x-dcim-csrf': operator.csrf },
      data: { targets: [{ kind: 'device', id: 'pdu8' }], dry_run: true } });
    assert.equal(refused.status(), 403);
    assert.equal((await refused.json()).detail, 'Only an Admin can delete servers, PDUs, KVMs, racks and cooling units.');
    checks.push('8: an Operator deletes unit u-pc300 (Delete OPT300) and Undoes it; no Delete… on a device; POST /api/lab/delete {device} is 403');

    // ── 9. A server removed earlier with Remove from lab (the real site's optn144): its name still on a PDU outlet and a
    //       KVM port, and a 3D record. Delete frees both ports and deletes the 3D record; it stays removed, its monitor
    //       stays paused and Ping Monitor marks it removed; Undo puts the names and the 3D record back, still removed. ──
    const post = async (s, path, data, headers = {}) => s.context.request.post(origin + path, { headers: { 'x-dcim-csrf': s.csrf, ...headers }, data });
    const twinDoc = await admin.context.request.get(origin + '/api/twin-data');
    const doc = await twinDoc.json();
    doc.items.push({ id: 'ITEM-OPT74', type: 'opt', name: 'OPT74', setup: 'SETUP-007', dcim: { optKey: 'opt74' } });
    const put = await admin.context.request.put(origin + '/api/twin-data', { headers: { 'x-dcim-csrf': admin.csrf, 'If-Match': twinDoc.headers()['etag'] }, data: doc });
    assert.equal(put.status(), 200, await put.text());
    const named = await admin.context.request.patch(origin + '/api/devices/direct-label', { headers: { 'x-dcim-csrf': admin.csrf },
      data: { device_id: 'kvm1', port: '2', label: 'OPT74' } });
    assert.equal(named.status(), 200, await named.text());
    // Its name on a new port shows it again; Remove from lab (today's route) records both ports.
    const removePlan = await (await post(admin, '/api/removed-servers', { name: 'OPT74', dry_run: true })).json();
    const removedList = await admin.context.request.get(origin + '/api/removed-servers');
    const removedNow = await post(admin, '/api/removed-servers', { name: 'OPT74', plan_revision: removePlan.plan_revision }, { 'If-Match': removedList.headers()['etag'] });
    assert.equal(removedNow.status(), 200, await removedNow.text());
    const hiddenNow = async () => (await json(admin, '/api/removed-servers')).hidden;
    assert.ok((await hiddenNow()).includes('opt74'), 'OPT74 is removed');
    const t74 = async () => (await json(admin, '/api/monitoring')).targets.find(t => t.id === 't74');
    assert.equal((await t74()).removed, true, 'Ping Monitor marks the monitor of a removed server');
    await page.goto(origin + '/?tab=dashboard&srv=opt74&sec=delete');
    await dialog(page).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => {
      const dd = document.querySelector('[data-dialog="delete"]');
      return dd && dd.getAttribute('aria-busy') === 'false' && dd.querySelector('[data-list="items"]');
    }, null, { timeout: 30000 });
    d = dialog(page);
    assert.equal(await d.locator('[data-list="blockers"]').count(), 0, 'an earlier removal is no blocker');
    const freed74 = await d.locator('[data-group="ports_freed"]').innerText();
    assert.ok(freed74.includes('PDU 07 · outlet 4: OPT74 → Outlet 4') && freed74.includes('KVM 01 · port 2: OPT74 → Port 2'), freed74);
    assert.ok((await d.locator('[data-group="twin_deleted"]').innerText()).includes('ITEM-OPT74'));
    assert.ok((await d.locator('[data-group="notes"]').innerText()).includes('OPT74 was removed from the lab before; it stays removed'));
    if (await d.locator('#lab-delete-confirm').count()) await d.locator('#lab-delete-confirm').fill('OPT74');
    assert.equal((await deleteButton(page).innerText()).trim(), 'Delete OPT74');
    await deleteButton(page).click();
    await page.locator('.lab-toast', { hasText: 'Deleted OPT74' }).waitFor({ timeout: 15000 });
    assert.equal(await labelOf('pdu7', '4'), 'Outlet 4');
    assert.equal(await labelOf('kvm1', '2'), 'Port 2');
    assert.ok(!(await twinIds()).has('ITEM-OPT74'), 'its 3D record is deleted');
    assert.ok((await hiddenNow()).includes('opt74'), 'it stays removed');
    assert.equal((await t74()).enabled, false, 'its monitor stays paused');
    assert.equal((await t74()).removed, true);
    await page.locator('.lab-toast', { hasText: 'Deleted OPT74' }).getByRole('button', { name: 'Undo' }).click();
    const restored74 = page.locator('.lab-toast', { hasText: 'Restored OPT74' });
    await restored74.waitFor({ timeout: 10000 });
    assert.ok((await restored74.innerText()).includes('it stays removed from the lab, as before'), 'the Undo toast says it stays removed');
    assert.equal(await labelOf('pdu7', '4'), 'OPT74', 'Undo writes the outlet name back');
    assert.equal(await labelOf('kvm1', '2'), 'OPT74', 'and the KVM port name');
    assert.ok((await twinIds()).has('ITEM-OPT74'), 'and the 3D record');
    assert.ok((await hiddenNow()).includes('opt74'), 'it is still removed, as before the delete');
    checks.push('9: OPT74, removed earlier with its name on PDU 07·4, KVM 01·2 and a 3D record: Delete frees both ports and deletes the record, it stays removed with its monitor paused (Ping Monitor: removed); Undo puts them back');

    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ passed: checks, errors }, null, 1));
})().catch(error => { console.error(error); process.exitCode = 1; });
