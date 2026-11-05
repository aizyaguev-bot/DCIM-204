// Remove a server from the lab (Admin): "Remove from lab" in the server's details on Racks (and in its Edit panel), a
// confirm step that names the server and lists what is cleaned, the server gone from Racks, Ping Monitor, Locations,
// SSH, the lab display and the 3D twin, Undo in the toast, and Restore in Admin → Removed servers. Operators and
// Viewers never see the controls and get 403 from the API. Runs only against the isolated local fixture
// (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1, fresh); nothing is written to a PDU or KVM.
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
    const monitor = async id => (await get(admin, '/api/monitoring')).targets.find(t => t.id === id);
    async function putLayout(path, mutate) {
      const g = await operator.c.request.get(origin + path); const data = await g.json(); mutate(data);
      const r = await operator.c.request.put(origin + path, { data, headers: { 'If-Match': g.headers()['etag'], 'X-DCIM-CSRF': operator.csrf } });
      assert.equal(r.status(), 200, await r.text());
    }
    // OPT11's DCIM data that a removal cleans: a pinned U, a switch port (its owner and monitor are in the fixture).
    await putLayout('/api/rack-slots', d => { d['Rack-01'] = { ...(d['Rack-01'] || {}), [KEY]: 1 }; });
    await putLayout('/api/switch-assignments', d => { d[KEY] = { switch: 'SW-QA', port: '7' }; });
    assert.equal((await get(admin, '/api/opt-owners'))[KEY], 'Fixture owner');
    const sshBefore = (await get(admin, '/api/ssh/status'))?.servers?.some?.(s => s.key === KEY) || false;

    const p = admin.page;
    if (sshBefore) {   // Admin → SSH lists OPT11 before the removal
      await p.goto(origin + '/?tab=admin&section=ssh');
      await p.getByLabel(`SSH user for ${SERVER}`, { exact: true }).waitFor({ timeout: 15000 });
    }
    const view = (page, name = SERVER) => page.locator(`button.server-open[aria-label="View ${name}"]`);
    const details = page => page.locator('[role="dialog"][data-dialog="server"]');
    const confirmDialog = page => page.locator('[role="alertdialog"][data-dialog="remove-server"]');
    const toast = page => page.locator('.toast');
    const nav = (page, name) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();

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
    assert.equal(twin0.has, true, 'the twin shows OPT11 before the removal');

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

    // ── Admin: details → Remove from lab → confirm names the server and lists what is cleaned ──
    await p.goto(origin + '/?tab=racks');
    await view(p).click();
    await details(p).waitFor();
    await details(p).getByRole('button', { name: 'Remove from lab', exact: true }).click();
    const dlg = confirmDialog(p); await dlg.waitFor();
    await dlg.getByRole('heading', { name: `Remove ${SERVER} from the lab?` }).waitFor();
    const cleaned = dlg.locator('[data-list="cleaned"] li');
    await cleaned.first().waitFor();
    const cleanedText = await cleaned.allTextContents();
    for (const want of ['Its rack shelf (U) position (Rack-01 U1)', 'Its switch port', 'Its owner (Fixture owner)'])
      assert.ok(cleanedText.includes(want), `cleaned list ${JSON.stringify(cleanedText)} misses ${want}`);
    assert.ok(cleanedText.some(t => t.startsWith('Its ping monitor is paused')), JSON.stringify(cleanedText));
    const keptText = (await dlg.locator('[data-list="kept"] li').allTextContents()).join(' | ');
    assert.match(keptText, /PDU\/KVM labels stay as they are: PDU 01 outlet 1, KVM 01 port 1/);
    await dlg.getByText('Restore shows the server again from its PDU label', { exact: false }).waitFor();
    // Cancel writes nothing.
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click(); await dlg.waitFor({ state: 'detached' });
    assert.deepEqual((await removed()).hidden, []);
    checks.push('confirm names the server, lists what is cleaned and what stays; Cancel writes nothing');

    await details(p).getByRole('button', { name: 'Remove from lab', exact: true }).click();
    await dlg.waitFor(); await cleaned.first().waitFor();
    await dlg.getByLabel('Reason (optional)').fill('QA: returned to vendor');
    const danger = dlg.locator('button[data-action="remove-server"]');
    assert.match(await danger.getAttribute('class'), /racks-btn-danger/);
    await danger.click();
    await toast(p).filter({ hasText: `${SERVER} was removed from the lab.` }).waitFor();
    await view(p).waitFor({ state: 'detached' });
    await view(p, 'OPT12').waitFor();
    let list = await removed();
    assert.deepEqual(list.hidden, [KEY]);
    assert.equal(list.servers[0].reason, 'QA: returned to vendor'); assert.equal(list.servers[0].removed_by, 'admin');
    assert.equal((await get(admin, '/api/rack-slots'))['Rack-01']?.[KEY], undefined);
    assert.equal((await get(admin, '/api/switch-assignments'))[KEY], undefined);
    assert.equal((await get(admin, '/api/opt-owners'))[KEY], undefined);
    assert.equal((await monitor('t11')).enabled, false);
    assert.equal((await get(admin, '/api/devices/')).find(d => d.id === 'pdu1').labels['1'], 'OPT11', 'the PDU label is not changed');
    checks.push('admin removes: gone from Racks, layout/owner cleaned, monitor paused, PDU label kept');

    // ── gone everywhere ──
    await nav(p, 'Ping Monitor');
    await p.getByRole('button', { name: 'View history for OPT12', exact: true }).waitFor();
    assert.equal(await p.getByRole('button', { name: `View history for ${SERVER}`, exact: true }).count(), 0);
    await p.goto(origin + '/?tab=locations');
    await p.getByRole('cell', { name: 'OPT12', exact: true }).first().waitFor();
    assert.equal(await p.getByRole('cell', { name: SERVER, exact: true }).count(), 0);
    if (sshBefore) {
      await p.goto(origin + '/?tab=admin&section=ssh');
      await p.getByLabel('SSH user for OPT12', { exact: true }).waitFor({ timeout: 15000 });
      assert.equal(await p.getByLabel(`SSH user for ${SERVER}`, { exact: true }).count(), 0);
    }
    assert.equal(await tvTotal(), tv0 - 1, 'the lab display counts one server less');
    const twin1 = await twinHas();
    assert.equal(twin1.has, false, 'the twin hides OPT11');
    assert.equal(twin1.others, twin0.others - 1);
    // Operators and Viewers see it hidden too.
    for (const s of [operator, viewer]) {
      // The removed list arrives right after the first paint: wait for it, then the server must stay away.
      await s.page.goto(origin + '/?tab=racks'); await view(s.page, 'OPT12').waitFor();
      await s.page.waitForResponse(r => r.url() === origin + '/api/removed-servers', { timeout: 10000 }).catch(() => {});
      await view(s.page).waitFor({ state: 'detached', timeout: 10000 });
      await s.page.waitForTimeout(500);
      assert.equal(await view(s.page).count(), 0, `${s.username} still sees ${SERVER}`);
    }
    checks.push(`gone from Ping Monitor, Locations${sshBefore ? ', SSH' : ''}, the lab display, the 3D twin and every role's Racks`);

    // ── Undo in the toast restores it ──
    await p.goto(origin + '/?tab=racks'); await view(p, 'OPT12').waitFor();
    // The toast lives on the page that removed it; remove again from the Edit panel to get a fresh toast.
    await p.locator('button.edit-toggle').click();
    assert.equal(await p.locator('button.edit-toggle').getAttribute('aria-pressed'), 'true');
    // Restore through the API first so OPT11 is listed, then remove it from its Edit panel.
    {
      const g = await admin.c.request.get(origin + '/api/removed-servers');
      const r = await admin.c.request.post(origin + `/api/removed-servers/${KEY}/restore`, { headers: { 'If-Match': g.headers()['etag'], 'X-DCIM-CSRF': admin.csrf } });
      assert.equal(r.status(), 200, await r.text());
      await p.evaluate(() => window.dispatchEvent(new Event('dcim-removed-servers')));
    }
    await view(p).waitFor();
    await view(p).click();
    await p.locator('[data-action="open-remove-server"]').click();
    await dlg.waitFor(); await cleaned.first().waitFor().catch(() => {});
    await dlg.locator('button[data-action="remove-server"]').click();
    const t1 = toast(p).filter({ hasText: `${SERVER} was removed from the lab.` }); await t1.waitFor();
    await view(p).waitFor({ state: 'detached' });
    await t1.getByRole('button', { name: 'Undo', exact: true }).click();
    await toast(p).filter({ hasText: `${SERVER} is back in the lab.` }).waitFor();
    await view(p).waitFor();
    assert.deepEqual((await removed()).hidden, []);
    assert.equal((await monitor('t11')).enabled, true, 'Undo resumes the monitor');
    await p.locator('button.edit-toggle').click();
    checks.push('Edit panel offers Remove from lab; Undo in the toast restores the server and its monitor');

    // ── Admin → Removed servers lists it with Restore ──
    await view(p).click(); await details(p).getByRole('button', { name: 'Remove from lab', exact: true }).click();
    await dlg.waitFor(); await cleaned.first().waitFor().catch(() => {});
    await dlg.getByLabel('Reason (optional)').fill('Moved to another lab');
    await dlg.locator('button[data-action="remove-server"]').click();
    await toast(p).filter({ hasText: `${SERVER} was removed from the lab.` }).waitFor();
    await nav(p, 'Admin');
    await p.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Removed servers', exact: true }).click();
    await p.getByRole('heading', { name: 'Removed servers', exact: true }).waitFor();
    const row = p.locator(`tr[data-removed-server="${KEY}"]`); await row.waitFor();
    await row.getByText('Moved to another lab', { exact: true }).waitFor();
    await row.getByText('admin', { exact: true }).waitFor();
    await row.getByText('Hidden', { exact: true }).waitFor();
    await p.locator('[data-list="removed-servers-log"]').getByText('removed', { exact: false }).first().waitFor();
    await row.getByRole('button', { name: `Restore ${SERVER}`, exact: true }).click();
    await p.getByRole('status').filter({ hasText: `${SERVER} is back in the lab.` }).waitFor();
    await row.waitFor({ state: 'detached' });
    await p.getByText('No server is removed from the lab.', { exact: true }).waitFor();
    assert.deepEqual((await removed()).hidden, []);
    await nav(p, 'Racks'); await view(p).waitFor();
    checks.push('Admin → Removed servers shows who/why and Restore brings it back');

    // ── Operator and Viewer: no controls, 403 from the API ──
    for (const s of [operator, viewer]) {
      await s.page.goto(origin + '/?tab=racks'); await view(s.page).click(); await details(s.page).waitFor();
      assert.equal(await details(s.page).getByRole('button', { name: 'Remove from lab', exact: true }).count(), 0, `${s.username} sees Remove from lab`);
      await s.page.keyboard.press('Escape');
      await s.page.goto(origin + '/?tab=admin');
      await s.page.getByRole('navigation', { name: 'Administration' }).waitFor();
      assert.equal(await s.page.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Removed servers', exact: true }).count(), 0);
      const g = await s.c.request.get(origin + '/api/removed-servers');
      assert.equal(g.status(), 200);
      const body = await g.json(); assert.equal('log' in body, false);
      const headers = { 'If-Match': g.headers()['etag'], 'X-DCIM-CSRF': s.csrf };
      assert.equal((await s.c.request.post(origin + '/api/removed-servers', { data: { name: SERVER, dry_run: true }, headers })).status(), 403);
      assert.equal((await s.c.request.post(origin + '/api/removed-servers', { data: { name: SERVER }, headers })).status(), 403);
      assert.equal((await s.c.request.post(origin + `/api/removed-servers/${KEY}/restore`, { headers })).status(), 403);
    }
    assert.deepEqual((await removed()).hidden, []);
    checks.push('Operator and Viewer: no Remove from lab, no Removed servers page, 403 on remove / restore');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: checks, errors }));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
