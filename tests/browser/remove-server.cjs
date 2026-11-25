// Delete a server from the lab (Admin), through its window (one-place WP-D): the server window's Delete… opens the one
// DeleteDialog. Its preview names the server and lists what is freed (PDU outlet, KVM port, rack slot, switch, owner,
// monitor); Cancel writes nothing. After the delete the server is gone from Racks, Ping Monitor, Manage, SSH, the lab
// display (?tab=display) and the 3D twin, for every role; the toast's Undo brings it back; Manage › Deleted
// (?tab=inventory&show=deleted) restores it, refusing a Restore on a list changed in another session; the deleted
// server's window is read only and its banner's Restore… brings it back. Operators and Viewers have no Delete… and the
// APIs answer 403 (POST /api/lab/delete and /api/lab/restore, and the older POST /api/removed-servers, which still
// exists). Runs only against the isolated local fixture (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1,
// fresh); nothing is written to a PDU or KVM (the fixture's devices are database rows).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9741';
const PASSWORD = 'test-password-123';
const SERVER = 'OPT11', KEY = 'opt11';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [];
  async function session(username, viewport = { width: 1440, height: 1000 }) {
    const c = await browser.newContext({ viewport });
    await c.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* ignore */ } });
    await c.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
    const login = await c.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(login.status(), 200, `${username} login`);
    const csrf = (await login.json()).csrf_token;
    const page = await c.newPage();
    page.on('pageerror', e => errors.push(`${username}: ${e.message}`));
    page.on('dialog', d => { errors.push(`${username} native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
    return { c, csrf, page, username };
  }
  try {
    const admin = await session('admin'), operator = await session('operator'), viewer = await session('viewer');
    assert.equal((await (await admin.c.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const get = async (s, path) => (await s.c.request.get(origin + path)).json();
    const removed = () => get(admin, '/api/removed-servers');
    const deletedList = async () => (await get(admin, '/api/lab/deleted')).batches || [];
    const monitor = async id => (await get(admin, '/api/monitoring')).targets.find(t => t.id === id);
    const labelOf = async (id, port) => (await get(admin, '/api/devices/')).find(d => d.id === id).labels[port];
    async function putLayout(path, mutate) {
      const g = await operator.c.request.get(origin + path); const data = await g.json(); mutate(data);
      const r = await operator.c.request.put(origin + path, { data, headers: { 'If-Match': g.headers()['etag'], 'X-DCIM-CSRF': operator.csrf } });
      assert.equal(r.status(), 200, await r.text());
    }
    // OPT11's DCIM data that a delete cleans: a pinned U, a switch port (its owner and monitor are in the fixture).
    await putLayout('/api/rack-slots', d => { d['Rack-01'] = { ...(d['Rack-01'] || {}), [KEY]: 1 }; });
    await putLayout('/api/switch-assignments', d => { d[KEY] = { switch: 'SW-QA', port: '7' }; });
    assert.equal((await get(admin, '/api/opt-owners'))[KEY], 'Fixture owner');
    assert.equal((await monitor('t11')).enabled, true, 'OPT11\'s monitor runs in the fixture');
    assert.deepEqual([await labelOf('pdu1', '1'), await labelOf('kvm1', '1')], [SERVER, SERVER]);
    assert.deepEqual((await removed()).hidden, []);
    const batches0 = (await deletedList()).length;
    const sshBefore = (await get(admin, '/api/ssh/status'))?.servers?.some?.(s => s.key === KEY) || false;

    const p = admin.page;
    if (sshBefore) {   // Admin → SSH lists OPT11 before the delete
      await p.goto(origin + '/?tab=admin&section=ssh');
      await p.getByLabel(`SSH user for ${SERVER}`, { exact: true }).waitFor({ timeout: 15000 });
    }
    const view = (page, name = SERVER) => page.locator(`button.server-open[aria-label="View ${name}"]`);
    const win = page => page.locator('[data-window="server"]');
    const deleteDialog = page => page.locator('[role="alertdialog"][data-dialog="delete"]');
    const toast = (page, text) => page.locator('.lab-toast').filter({ hasText: text });
    const nav = (page, name) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
    // The window's Delete…: in the bar when the server looks gone, else last in ⋯ More. Waits for the preview.
    async function openDelete(page) {
      const w = win(page);
      await w.locator('h2', { hasText: SERVER }).waitFor();
      const bar = w.getByRole('button', { name: 'Delete…', exact: true });
      if (await bar.count()) await bar.click();
      else {
        await w.getByRole('button', { name: '⋯ More', exact: true }).click();
        await w.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
      }
      const d = deleteDialog(page);
      await d.waitFor();
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-dialog="delete"]');
        return el && el.getAttribute('aria-busy') === 'false' && el.querySelector('[data-list="items"]');
      }, null, { timeout: 30000 });
      return d;
    }
    // Confirm: a server with signs of life asks for its name, one without has a red button naming it.
    async function confirmDelete(page, d, reason) {
      if (reason) await d.getByLabel('Reason (optional)').fill(reason);
      const button = d.locator('button[data-action="delete"]');
      assert.equal((await button.innerText()).trim(), `Delete ${SERVER}`);
      assert.match(await button.getAttribute('class'), /racks-btn-danger/);
      const typed = d.locator('#lab-delete-confirm');
      let how = 'one red button';
      if (await typed.count()) {
        how = 'its name typed';
        assert.equal((await d.locator('label[for="lab-delete-confirm"]').innerText()).trim(), `Type ${SERVER} to delete it`);
        assert.equal(await button.isDisabled(), true, 'Delete waits for the typed name');
        await typed.fill(SERVER);
      }
      assert.equal(await button.isEnabled(), true);
      await button.click();
      await d.waitFor({ state: 'detached', timeout: 15000 });
      return how;
    }

    // ── 3D twin before: OPT11 is a live server there ──
    const twinHas = async () => {
      const t = await admin.c.newPage(); t.on('pageerror', e => errors.push(`twin: ${e.message}`));
      await t.goto(origin + '/twin/');
      await t.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.model?.items?.length && window.__twin.S.live.devices?.length, null, { timeout: 60000 });
      await t.waitForFunction(() => 'removed' in window.__twin.S.live, null, { timeout: 20000 }).catch(() => {});
      const has = await t.evaluate(key => window.__twin.S.model.items.some(i => i.type === 'opt' && window.__twin.pingKey(i.name) === key), KEY);
      const others = await t.evaluate(() => window.__twin.S.model.items.filter(i => i.type === 'opt' && i.live?.inDcim).length);
      await t.close();
      return { has, others };
    };
    const twin0 = await twinHas();
    assert.equal(twin0.has, true, 'the twin shows OPT11 before the delete');

    // ── the lab display before ──
    const tvTotal = async () => {
      const t = await admin.c.newPage(); t.on('pageerror', e => errors.push(`display: ${e.message}`));
      await t.goto(origin + '/?tab=display');
      const tile = t.locator('[data-testid="kpi-on"]'); await tile.waitFor({ timeout: 30000 });
      await t.waitForFunction(() => /of \d+/.test(document.querySelector('[data-testid="kpi-on"]')?.textContent || ''), null, { timeout: 30000 });
      await t.waitForTimeout(1500);   // the removed list arrives with the first reads
      const total = Number(/of (\d+)/.exec(await tile.textContent())[1]);
      await t.close();
      return total;
    };
    const tv0 = await tvTotal();

    // ── 1. Admin, Racks: OPT11 opens its window; Delete… previews what it frees; Cancel writes nothing ──
    await p.goto(origin + '/?tab=racks');
    await view(p).click();
    let dlg = await openDelete(p);
    assert.equal((await dlg.locator('#lab-delete-title').innerText()).trim(), `Delete ${SERVER}?`);
    const item = dlg.locator(`[data-list="items"] [data-item="server:${KEY}"]`);
    assert.match(await item.innerText(), new RegExp(`${SERVER}[\\s\\S]*Server`));
    const groupText = async group => (await dlg.locator(`[data-group="${group}"]`).count()) ? dlg.locator(`[data-group="${group}"]`).innerText() : '';
    const freed = await groupText('ports_freed');
    for (const want of [`PDU 01 · outlet 1: ${SERVER} → Outlet 1`, `KVM 01 · port 1: ${SERVER} → Port 1`])
      assert.ok(freed.includes(want), `the freed list ${JSON.stringify(freed)} misses ${want}`);
    const layout = await groupText('layout');
    for (const want of [`${SERVER}: rack slots entry removed`, `${SERVER}: switch assignments entry removed`])
      assert.ok(layout.includes(want), `the layout list ${JSON.stringify(layout)} misses ${want}`);
    assert.ok((await groupText('owners')).includes('Fixture owner'), 'the preview names the owner that is cleaned');
    assert.ok((await groupText('monitors_paused')).includes(`${SERVER}: ping monitor paused (history kept)`));
    const screens = await dlg.locator('[data-list="screens"]').innerText();
    for (const want of ['Racks', 'Manage', 'Lab display (TV)', '3D twin', 'Ping Monitor'])
      assert.ok(screens.includes(want), `"Disappears from" ${JSON.stringify(screens)} misses ${want}`);
    assert.equal(await dlg.locator('[data-list="blockers"]').count(), 0, 'nothing blocks the delete');
    await dlg.getByText('Everything deleted here can be restored for 90 days (Manage › Deleted).', { exact: true }).waitFor();
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dlg.waitFor({ state: 'detached' });
    await p.waitForTimeout(500);
    assert.deepEqual((await removed()).hidden, []);
    assert.equal((await deletedList()).length, batches0, 'Cancel adds nothing to the Deleted list');
    assert.equal(await labelOf('pdu1', '1'), SERVER, 'Cancel frees nothing');
    assert.equal(await win(p).count(), 1, 'Cancel keeps the window');
    checks.push('Racks › OPT11 › window › Delete…: "Delete OPT11?" lists PDU 01 · outlet 1 and KVM 01 · port 1 freed, its rack slot, switch, owner (Fixture owner) and monitor; disappears from Racks, Manage, TV, 3D twin and Ping Monitor; Cancel writes nothing');

    // ── 2. Delete it: the window closes, gone from Racks, everything cleaned and freed; the toast's Undo brings it back ──
    dlg = await openDelete(p);
    const how1 = await confirmDelete(p, dlg, 'QA: returned to vendor');
    const t1 = toast(p, `Deleted ${SERVER}`); await t1.waitFor({ timeout: 15000 });
    await win(p).waitFor({ state: 'detached' });
    await view(p).waitFor({ state: 'detached', timeout: 15000 });
    await view(p, 'OPT12').waitFor();
    let list = await removed();
    assert.deepEqual(list.hidden, [KEY]);
    assert.equal(list.servers[0].reason, 'QA: returned to vendor'); assert.equal(list.servers[0].removed_by, 'admin');
    const batch1 = (await deletedList()).find(b => b.entries.some(e => e.id === KEY && !e.restored_at));
    assert.ok(batch1, 'the delete is one batch of the Deleted list');
    assert.deepEqual([batch1.by, batch1.reason], ['admin', 'QA: returned to vendor']);
    assert.equal((await get(admin, '/api/rack-slots'))['Rack-01']?.[KEY], undefined);
    assert.equal((await get(admin, '/api/switch-assignments'))[KEY], undefined);
    assert.equal((await get(admin, '/api/opt-owners'))[KEY], undefined);
    assert.equal((await monitor('t11')).enabled, false);
    assert.deepEqual([await labelOf('pdu1', '1'), await labelOf('kvm1', '1')], ['Outlet 1', 'Port 1'], 'its outlet and KVM port are freed');
    await t1.getByRole('button', { name: 'Undo', exact: true }).click();
    await toast(p, `Restored ${SERVER}`).waitFor({ timeout: 15000 });
    await view(p).waitFor({ timeout: 15000 });
    assert.deepEqual((await removed()).hidden, []);
    assert.equal((await monitor('t11')).enabled, true, 'Undo resumes the monitor');
    assert.deepEqual([await labelOf('pdu1', '1'), await labelOf('kvm1', '1')], [SERVER, SERVER], 'Undo writes the outlet and port names back');
    checks.push(`Delete (${how1}, reason kept): the window closes, OPT11 leaves Racks; removed by admin, one Deleted batch, rack slot / switch / owner cleaned, monitor paused, PDU 01·1 → Outlet 1 and KVM 01·1 → Port 1; the toast's Undo brings it back with its names and monitor`);

    // ── 3. Delete it again from Ping Monitor's row (its window on Activity): gone from every screen, every role ──
    await nav(p, 'Ping Monitor');
    await p.getByRole('button', { name: `View history for ${SERVER}`, exact: true }).click();
    await win(p).locator('[data-monitor-details]').waitFor();
    dlg = await openDelete(p);
    await confirmDelete(p, dlg, 'Moved to another lab');
    await toast(p, `Deleted ${SERVER}`).waitFor({ timeout: 15000 });
    await win(p).waitFor({ state: 'detached' });
    await p.getByRole('button', { name: 'View history for OPT12', exact: true }).waitFor();
    await p.getByRole('button', { name: `View history for ${SERVER}`, exact: true }).waitFor({ state: 'detached', timeout: 15000 });
    assert.deepEqual((await removed()).hidden, [KEY]);
    await p.goto(origin + '/?tab=inventory');
    await p.locator('[data-uid="server:opt12"]').first().waitFor({ timeout: 20000 });
    assert.equal(await p.locator(`[data-uid="server:${KEY}"]`).count(), 0, 'Manage lists it no more');
    if (sshBefore) {
      await p.goto(origin + '/?tab=admin&section=ssh');
      await p.getByLabel('SSH user for OPT12', { exact: true }).waitFor({ timeout: 15000 });
      assert.equal(await p.getByLabel(`SSH user for ${SERVER}`, { exact: true }).count(), 0);
    }
    assert.equal(await tvTotal(), tv0 - 1, 'the lab display counts one server less');
    const twin1 = await twinHas();
    assert.equal(twin1.has, false, 'the twin hides OPT11');
    assert.equal(twin1.others, twin0.others - 1);
    for (const s of [admin, operator, viewer]) {
      // The removed list arrives right after the first paint: wait for it, then the server must stay away.
      await s.page.goto(origin + '/?tab=racks'); await view(s.page, 'OPT12').waitFor();
      await s.page.waitForResponse(r => r.url() === origin + '/api/removed-servers', { timeout: 10000 }).catch(() => {});
      await view(s.page).waitFor({ state: 'detached', timeout: 10000 });
      await s.page.waitForTimeout(500);
      assert.equal(await view(s.page).count(), 0, `${s.username} still sees ${SERVER}`);
    }
    checks.push(`deleted again from its Ping Monitor row's window: gone from Ping Monitor, Manage${sshBefore ? ', SSH' : ''}, the lab display (${tv0} → ${tv0 - 1}), the 3D twin and every role's Racks`);

    // ── 4. Its window is read only: "Deleted … by admin" with Restore…; Operators and Viewers cannot restore it ──
    await p.goto(origin + '/?tab=racks&srv=opt11');
    await win(p).locator('[data-removed-banner="deleted"]').filter({ hasText: 'by admin' }).waitFor({ timeout: 15000 });
    await win(p).getByText('Removed · read only', { exact: true }).waitFor();
    for (const action of ['Rename…', 'Move…', 'Swap with…'])
      assert.equal(await win(p).getByRole('button', { name: action, exact: true }).count(), 0, `a deleted server's window has no ${action}`);
    await win(p).getByRole('button', { name: 'Restore…', exact: true }).waitFor();
    const batch2 = (await deletedList()).find(b => b.entries.some(e => e.id === KEY && !e.restored_at));
    assert.ok(batch2 && batch2.id !== batch1.id, 'a second batch');
    for (const s of [operator, viewer]) {
      const sw = win(s.page);
      await s.page.goto(origin + '/?tab=racks&srv=opt11');
      await sw.locator('[data-removed-banner]').waitFor({ timeout: 15000 });
      assert.equal(await sw.getByRole('button', { name: 'Restore…', exact: true }).count(), 0, `${s.username} has no Restore…`);
      assert.equal(await sw.getByRole('button', { name: 'Delete…', exact: true }).count(), 0, `${s.username} has no Delete…`);
      const headers = { 'X-DCIM-CSRF': s.csrf };
      const restoreBody = { batch: batch2.id, dry_run: true };
      assert.equal((await s.c.request.post(origin + '/api/lab/restore', { data: restoreBody, headers })).status(), 403, `${s.username}: restore is 403`);
    }
    // An Operator sees the Deleted list, but its server batch cannot be restored there; a Viewer has no Deleted list.
    await operator.page.goto(origin + '/?tab=inventory&show=deleted');
    const opRow = operator.page.locator(`tr[data-batch="${batch2.id}"]`);
    await opRow.waitFor({ timeout: 20000 });
    assert.equal(await opRow.locator('[data-action="restore-batch"]').isDisabled(), true, 'the Operator\'s Restore is disabled');
    assert.equal(await opRow.locator('[data-action="restore-batch"]').getAttribute('title'), 'Only an Admin can restore servers, PDUs, KVMs, racks and cooling units.');
    await viewer.page.goto(origin + '/?tab=inventory&show=deleted');
    await viewer.page.locator('[data-page="manage"][aria-busy="false"]').waitFor({ timeout: 20000 });
    assert.equal(await viewer.page.locator('[data-view="deleted"]').count(), 0, 'a Viewer has no Deleted list');
    assert.equal(await viewer.page.locator('[data-chip="deleted"]').count(), 0);
    assert.equal((await viewer.c.request.get(origin + '/api/lab/deleted')).status(), 403);
    checks.push('the deleted server\'s window: "Deleted … by admin", Removed · read only (no Rename… / Move…), Restore… for the Admin only; Operator: Restore disabled in Manage › Deleted, POST /api/lab/restore 403; Viewer: no Deleted list, GET /api/lab/deleted 403');

    // ── 5. Manage › Deleted: who and why; a Restore on a list changed in another session is refused; Restore brings it back ──
    await p.goto(origin + '/?tab=inventory&show=deleted');
    const row = p.locator(`tr[data-batch="${batch2.id}"]`);
    await row.waitFor({ timeout: 20000 });
    await row.locator(`li[data-entry="server:${KEY}"]`).getByText(SERVER, { exact: true }).waitFor();
    await row.getByText('Moved to another lab', { exact: true }).waitFor();
    assert.match(await row.innerText(), /admin/);
    assert.match(await row.locator(`li[data-entry="server:${KEY}"]`).innerText(), /Restorable/);
    const restore = row.locator('[data-action="restore-batch"]');
    assert.equal((await restore.innerText()).trim(), 'Restore');
    // Another session deletes OPT12 while this page shows the list (its change feed held, so the page keeps its list).
    await p.route(origin + '/api/changes', r => r.abort());
    {
      const headers = { 'X-DCIM-CSRF': admin.csrf };
      const plan = await (await admin.c.request.post(origin + '/api/lab/delete', { data: { targets: [{ kind: 'server', id: 'opt12' }], dry_run: true }, headers })).json();
      assert.deepEqual(plan.blockers, []);
      const r = await admin.c.request.post(origin + '/api/lab/delete', { data: { targets: [{ kind: 'server', id: 'opt12' }], plan_revision: plan.plan_revision }, headers });
      assert.equal(r.status(), 200, await r.text());
    }
    await restore.click();
    await p.locator('.manage-note[role="status"]').filter({ hasText: 'Not restored: The Deleted list was changed in another session.' }).waitFor({ timeout: 15000 });
    const batch12 = (await deletedList()).find(b => b.entries.some(e => e.id === 'opt12' && !e.restored_at));
    await p.locator(`tr[data-batch="${batch12.id}"]`).waitFor({ timeout: 15000 });   // the list is read again
    assert.deepEqual((await removed()).hidden.sort(), [KEY, 'opt12']);
    await p.unroute(origin + '/api/changes');
    await restore.click();
    await p.locator('.manage-note[role="status"]').filter({ hasText: `Restored ${SERVER}.` }).waitFor({ timeout: 15000 });
    await toast(p, `Restored ${SERVER}.`).waitFor();
    await row.locator('[data-action="restore-batch"]').waitFor({ state: 'detached' });
    assert.match(await row.locator(`li[data-entry="server:${KEY}"]`).innerText(), /Restored/);
    await p.locator(`tr[data-batch="${batch12.id}"] [data-action="restore-batch"]`).click();
    await p.locator('.manage-note[role="status"]').filter({ hasText: 'Restored OPT12.' }).waitFor({ timeout: 15000 });
    assert.deepEqual((await removed()).hidden, []);
    assert.equal((await monitor('t11')).enabled, true, 'Restore resumes the monitor');
    assert.deepEqual([await labelOf('pdu1', '1'), await labelOf('kvm1', '1'), await labelOf('pdu1', '2')], [SERVER, SERVER, 'OPT12'], 'Restore writes the names back');
    await nav(p, 'Racks'); await view(p).waitFor({ timeout: 15000 }); await view(p, 'OPT12').waitFor();
    assert.equal((await twinHas()).has, true, 'the twin shows OPT11 again');
    checks.push('Manage › Deleted (?tab=inventory&show=deleted): OPT11 by admin, "Moved to another lab", Restorable; OPT12 deleted in another session meanwhile → Restore refused ("changed in another session") and the list read again; Restore brings OPT11 back (names, monitor, Racks, 3D twin), then OPT12');

    // ── 6. A shared link to its Delete (sec=delete) previews only; the window banner's Restore… brings it back ──
    await p.goto(origin + '/?tab=racks&srv=opt11&sec=delete');
    dlg = deleteDialog(p);
    await dlg.waitFor({ timeout: 20000 });
    await p.waitForFunction(() => document.querySelector('[data-dialog="delete"]')?.getAttribute('aria-busy') === 'false', null, { timeout: 30000 });
    assert.deepEqual((await removed()).hidden, [], 'sec=delete applies nothing');
    await confirmDelete(p, dlg, '');
    await toast(p, `Deleted ${SERVER}`).waitFor({ timeout: 15000 });
    await p.goto(origin + '/?tab=racks&srv=opt11');
    const w = win(p);
    await w.locator('[data-removed-banner="deleted"]').filter({ hasText: 'by admin' }).waitFor({ timeout: 15000 });
    assert.deepEqual((await removed()).hidden, [KEY]);
    await w.getByRole('button', { name: 'Restore…', exact: true }).click();
    const restoreDialog = p.locator('[data-dialog="restore-server"]');
    await restoreDialog.getByRole('heading', { name: `Restore ${SERVER}?` }).waitFor();
    await restoreDialog.getByText('Its rack place, switch port and owner do not come back.', { exact: true }).waitFor();
    const confirmRestore = restoreDialog.locator('[data-action="confirm-restore"]');
    await p.waitForFunction(() => { const b = document.querySelector('[data-dialog="restore-server"] [data-action="confirm-restore"]'); return b && !b.disabled; }, null, { timeout: 20000 });
    await confirmRestore.click();
    await restoreDialog.waitFor({ state: 'detached', timeout: 15000 });
    // "Restored OPT11" (the Deleted list's words, as Undo says it); "OPT11 is back in the lab." before that wording
    await p.locator('.lab-toast > span').filter({ hasText: new RegExp(`^(Restored ${SERVER}|${SERVER} is back in the lab\\.)$`) }).waitFor();
    await w.locator('[data-removed-banner]').waitFor({ state: 'detached', timeout: 15000 });
    assert.deepEqual((await removed()).hidden, []);
    assert.equal((await monitor('t11')).enabled, true, 'Restore… resumes the monitor');
    assert.deepEqual([await labelOf('pdu1', '1'), await labelOf('kvm1', '1')], [SERVER, SERVER]);
    checks.push('?srv=opt11&sec=delete opens the preview only (nothing applied until confirmed); the deleted window\'s Restore… ("Its rack place, switch port and owner do not come back.") brings OPT11 back with its names and monitor');

    // ── 7. Operator and Viewer: no Delete… on a server window; every delete / restore API answers 403 ──
    for (const s of [operator, viewer]) {
      const sw = win(s.page);
      await s.page.goto(origin + '/?tab=racks');
      await view(s.page).click();
      await sw.locator('h2', { hasText: SERVER }).waitFor();
      await s.page.waitForTimeout(300);
      assert.equal(await sw.getByRole('button', { name: 'Delete…', exact: true }).count(), 0, `${s.username} has no Delete… in the bar`);
      const more = sw.getByRole('button', { name: '⋯ More', exact: true });
      if (await more.count()) {
        await more.click();
        await sw.getByRole('menu').waitFor();
        assert.equal(await sw.getByRole('menuitem', { name: 'Delete…', exact: true }).count(), 0, `${s.username} has no Delete… in ⋯ More`);
        await s.page.keyboard.press('Escape');
      }
      await s.page.keyboard.press('Escape');
      await sw.waitFor({ state: 'detached' });
      const lab = { 'X-DCIM-CSRF': s.csrf };
      assert.equal((await s.c.request.post(origin + '/api/lab/delete', { data: { targets: [{ kind: 'server', id: KEY }], dry_run: true }, headers: lab })).status(), 403);
      assert.equal((await s.c.request.post(origin + '/api/lab/delete', { data: { targets: [{ kind: 'server', id: KEY }], plan_revision: 'x' }, headers: lab })).status(), 403);
      // The older Remove from lab API still exists (Admin only).
      const g = await s.c.request.get(origin + '/api/removed-servers');
      assert.equal(g.status(), 200);
      assert.equal('log' in (await g.json()), false, 'the removal log is Admin only');
      const headers = { 'If-Match': g.headers()['etag'], 'X-DCIM-CSRF': s.csrf };
      assert.equal((await s.c.request.post(origin + '/api/removed-servers', { data: { name: SERVER, dry_run: true }, headers })).status(), 403);
      assert.equal((await s.c.request.post(origin + '/api/removed-servers', { data: { name: SERVER }, headers })).status(), 403);
      assert.equal((await s.c.request.post(origin + '/api/removed-servers/restore', { data: { key: KEY }, headers })).status(), 403);
    }
    assert.deepEqual((await removed()).hidden, []);
    checks.push('Operator and Viewer: no Delete… on the server window (bar or ⋯ More); POST /api/lab/delete (preview and apply) and POST /api/removed-servers (preview, remove, restore) answer 403');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: checks, errors }));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
