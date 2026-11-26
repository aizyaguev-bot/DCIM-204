// The server window's power, header tools and Activity (one-place spec v1 WP-3): Power always asks (PowerConfirmDialog,
// also with confirm_power off), a PDU in maintenance refuses with its reason, Viewers read only (the API answers 403),
// the monitor's settings (address save, revision conflict, unticking asks first, "Monitor this server"), the timeline
// (incidents, the removal log for Admins), Ping Monitor rows open the window on Activity while a monitor that is no
// server keeps its side panel, and 3D selects srv:<DCIM id>. The console from the window is in kvm-launch.cjs.
// Fixture: DCIM_TEST_ACCOUNTS=1 DCIM_FIXTURE_ONE_PLACE=1. It switches fixture outlets only (fake PDUs) and puts them back.
const { chromium } = require('playwright');
// The 3D twin is switched off (frontend/src/twinLinks.js TWIN_ENABLED false): the window then has no 3D tool, and the
// 3D steps below run only while it is on.
const TWIN = /export const TWIN_ENABLED = true;/.test(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/src/twinLinks.js'), 'utf8'));
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9730';
const PASSWORD = 'test-password-123';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [], writes = [];
  async function login(username, { viewport = { width: 1440, height: 1000 }, preferences = {} } = {}) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) return route.abort();
      // confirm_power off: the window asks anyway (v1 §0.9).
      if (new URL(request.url()).pathname === '/api/auth/status') {
        const response = await route.fetch();
        const json = await response.json();
        if (json.user?.preferences) json.user.preferences = { ...json.user.preferences, confirm_power: false, ...preferences };
        return route.fulfill({ response, json });
      }
      return route.continue();
    });
    const answer = await context.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(answer.status(), 200, `${username} signs in`);
    assert.equal((await (await context.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${username}: ${e.message}`));
    page.on('request', r => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && !/\/api\/auth\//.test(r.url())) writes.push(`${username} ${r.method()} ${new URL(r.url()).pathname}`); });
    return { context, page };
  }
  const win = page => page.locator('[data-window="server"]');
  const param = (page, name) => new URL(page.url()).searchParams.get(name);
  async function openWindow(page, key, name, sec = '') {
    await page.goto(`${origin}/?tab=dashboard&srv=${key}${sec ? `&sec=${sec}` : ''}`);
    await win(page).locator('h2', { hasText: name }).waitFor();
    return win(page);
  }
  const api = async (context, path) => (await context.request.get(origin + path)).json();
  const target = async (context, id) => (await api(context, '/api/monitoring')).targets.find(t => t.id === id);
  const outletState = async (context, pdu, n) => (await api(context, `/api/pdus/${pdu}/status`)).outlets.find(o => o.number === n)?.state;
  const powerDialog = page => page.locator('[data-dialog="power"]');
  // PowerConfirmDialog arms its buttons 400 ms after it opens (a double click must never switch a server off).
  const armed = page => page.waitForTimeout(550);
  const countWrites = prefix => writes.filter(w => w.includes(prefix)).length;

  try {
    const admin = await login('admin');
    const devices = await (await admin.context.request.get(origin + '/api/devices/')).json();
    assert.ok(devices.some(d => d.id === 'pdu8'), 'Start the fixture with DCIM_FIXTURE_ONE_PLACE=1 (PDU-Rack-08 is missing)');
    const a = admin.page;

    // 1. Ping Monitor: a server's row opens its window on Activity (the 60-check strip, its two incidents); the incident
    //    log's name too; the "device:" monitor keeps its side panel; the monitor-only server opens a window.
    await a.goto(origin + '/?tab=monitoring');
    await a.getByRole('button', { name: 'View history for OPT11', exact: true }).click();
    const w = win(a);
    await w.locator('h2', { hasText: 'OPT11' }).waitFor();
    assert.equal(param(a, 'srv'), 'opt11');
    assert.equal(param(a, 'sec'), 'activity');
    assert.equal(param(a, 'tab'), 'monitoring', 'over the Ping Monitor tab');
    const activity = w.locator('details[data-section="activity"]');
    assert.equal(await activity.evaluate(el => el.open), true, 'Activity is expanded');
    await w.locator('[data-check-strip] > div').nth(59).waitFor();
    assert.equal(await w.locator('[data-check-strip] > div').count(), 60, 'the 60-check strip');
    await w.locator('[data-activity-timeline] [data-kind="incident"]').nth(1).waitFor();
    assert.equal(await w.locator('[data-activity-timeline] [data-kind="incident"]').count(), 2, 'its two closed incidents');
    await w.locator('[data-activity-timeline]').getByText('Reply received', { exact: false }).first().waitFor();
    await w.getByText('Moves, renames and owner changes made elsewhere are not recorded yet.', { exact: true }).waitFor();
    await w.getByRole('button', { name: 'Close', exact: true }).click();
    await w.waitFor({ state: 'detached' });
    await a.getByRole('button', { name: 'View history for Lab printer', exact: true }).click();
    await a.getByRole('complementary', { name: 'Lab printer', exact: true }).waitFor();
    assert.equal(await win(a).count(), 0, 'a monitor that is no server keeps the side panel');
    assert.equal(param(a, 'srv'), null);
    await a.getByRole('button', { name: 'Close server details' }).click();
    await a.getByRole('button', { name: 'View history for optn85', exact: true }).click();
    await w.locator('h2', { hasText: 'optn85' }).waitFor();
    await w.locator('[data-monitor-details]').waitFor();
    await a.keyboard.press('Escape');
    await w.waitFor({ state: 'detached' });
    await a.getByRole('button', { name: 'OPT11', exact: true }).first().click();   // the incident log
    await w.locator('h2', { hasText: 'OPT11' }).waitFor();
    assert.equal(param(a, 'sec'), 'activity');
    checks.push('Ping Monitor rows and incidents with a server key open the window on Activity (60-check strip, 2 incidents); "Lab printer" keeps its panel; optn85 opens a window');

    // 2. Monitor settings in the window: an address save, then a revision conflict with another session.
    await openWindow(a, 'opt12', 'OPT12', 'activity');
    const addr = w.getByLabel('Address for OPT12', { exact: true });
    await addr.fill('opt12-qa');
    const [saved] = await Promise.all([a.waitForResponse(r => r.request().method() === 'PUT' && r.url() === `${origin}/api/monitoring/targets/t12`),
      w.getByRole('button', { name: 'Save settings', exact: true }).click()]);
    assert.equal(saved.status(), 200);
    await w.getByRole('button', { name: 'Save settings', exact: true }).waitFor();
    assert.equal((await target(admin.context, 't12')).host, 'opt12-qa');
    const operator = await login('operator');
    const o = operator.page;
    await openWindow(o, 'opt12', 'OPT12', 'activity');
    await addr.fill('opt12-mine');
    const oAddr = win(o).getByLabel('Address for OPT12', { exact: true });
    await oAddr.fill('opt12-theirs');
    const [theirs] = await Promise.all([o.waitForResponse(r => r.request().method() === 'PUT' && r.url() === `${origin}/api/monitoring/targets/t12`),
      win(o).getByRole('button', { name: 'Save settings', exact: true }).click()]);
    assert.equal(theirs.status(), 200);
    const conflict = w.getByRole('alert').filter({ hasText: 'Someone else changed this server' });
    await conflict.waitFor({ timeout: 10000 });   // the change feed brings the new revision within seconds
    await conflict.getByText('opt12-theirs', { exact: true }).waitFor();
    assert.equal(await addr.inputValue(), 'opt12-mine', 'the typed address stays');
    assert.equal(await w.getByRole('button', { name: 'Save settings', exact: true }).isDisabled(), true);
    await conflict.getByRole('button', { name: 'Load current values', exact: true }).click();
    assert.equal(await addr.inputValue(), 'opt12-theirs');
    await addr.fill('opt12');
    await w.getByRole('button', { name: 'Save settings', exact: true }).click();
    for (let i = 0; i < 25 && (await target(admin.context, 't12')).host !== 'opt12'; i++) await a.waitForTimeout(200);
    assert.equal((await target(admin.context, 't12')).host, 'opt12');
    checks.push('Activity › Monitor: an address save (PUT 200), and another session\'s save shows the conflict with the current values; the address is put back');

    // 3. Unticking "Monitor this server" asks first; Keep monitoring sends nothing; Stop monitoring + Save pauses it.
    const monitored = w.getByRole('checkbox', { name: 'Monitor this server', exact: true });
    const putsBefore = countWrites('/api/monitoring/targets/t12');
    await monitored.uncheck();
    const ask = w.getByRole('group', { name: 'Stop monitoring?' });
    await ask.waitFor();
    assert.equal(await w.getByRole('button', { name: 'Save settings', exact: true }).isDisabled(), true, 'no save while it asks');
    await ask.getByRole('button', { name: 'Keep monitoring', exact: true }).click();
    await ask.waitFor({ state: 'detached' });
    assert.equal(await monitored.isChecked(), true);
    assert.equal(countWrites('/api/monitoring/targets/t12'), putsBefore, 'Keep monitoring sends nothing');
    await monitored.uncheck();
    await ask.getByRole('button', { name: 'Stop monitoring', exact: true }).click();
    const [paused] = await Promise.all([a.waitForResponse(r => r.request().method() === 'PUT' && r.url() === `${origin}/api/monitoring/targets/t12`),
      w.getByRole('button', { name: 'Save settings', exact: true }).click()]);
    assert.equal(paused.status(), 200);
    assert.equal((await target(admin.context, 't12')).enabled, false);
    await w.locator('[data-monitor-details]').getByText('Paused', { exact: true }).first().waitFor();
    await w.getByRole('button', { name: 'Save settings', exact: true }).waitFor();
    await monitored.check();
    assert.equal(await ask.count(), 0, 'ticking it again does not ask');
    await w.getByRole('button', { name: 'Save settings', exact: true }).click();
    for (let i = 0; i < 25 && !(await target(admin.context, 't12')).enabled; i++) await a.waitForTimeout(200);
    assert.equal((await target(admin.context, 't12')).enabled, true);
    checks.push('unticking "Monitor this server" asks first (Keep monitoring sends nothing; Stop monitoring + Save pauses it); ticking again does not ask');

    // 4. "Monitor this server" on a server with no monitor (OPT90, KVM only), as an Operator.
    await openWindow(o, 'opt90', 'OPT90', 'activity');
    const add = win(o).locator('[data-monitor-add]');
    await add.waitFor();
    assert.equal(await add.getByLabel('Address to monitor OPT90', { exact: true }).inputValue(), 'opt90');
    const [created] = await Promise.all([o.waitForResponse(r => r.request().method() === 'POST' && r.url() === `${origin}/api/monitoring/targets`),
      add.getByRole('button', { name: 'Monitor this server', exact: true }).click()]);
    assert.equal(created.status(), 201);
    await win(o).getByLabel('Address for OPT90', { exact: true }).waitFor();
    const opt90 = (await api(admin.context, '/api/monitoring')).targets.find(t => t.server_key === 'opt90');
    assert.equal(opt90?.host, 'opt90');
    checks.push('"Monitor this server" (Operator) creates the monitor and the window shows its settings');

    // 5. The timeline: the removal log of OPT74 for Admins only; its monitor is paused; the window is read only.
    await openWindow(a, 'opt74', 'OPT74', 'activity');
    await w.locator('[data-kind="removal"]').nth(2).waitFor();
    assert.equal(await w.locator('[data-kind="removal"]').count(), 3, 'removed, restored, removed');
    await w.locator('[data-kind="removal"]').filter({ hasText: 'Fixture: the machine left the lab' }).waitFor();
    assert.equal(await w.getByLabel('Address for OPT74').count(), 0, 'a removed server is read only');
    await openWindow(o, 'opt74', 'OPT74', 'activity');
    await win(o).locator('[data-monitor-details]').waitFor();
    assert.equal(await win(o).locator('[data-kind="removal"]').count(), 0, 'Operators see no removal log');
    checks.push('the removal log shows in Activity for Admins only (3 entries for OPT74); a removed server is read only');

    // 6. Power, as an Operator with confirm_power off: the whole two-feed server, then one feed, always through the
    //    dialog; Cancel sends nothing.
    await openWindow(o, 'opt53', 'OPT53');
    const ow = win(o);
    const powerButton = ow.getByRole('button', { name: 'Power ▾', exact: true });
    await powerButton.click();
    const menu = ow.getByRole('menu', { name: 'Power OPT53' });
    for (const item of ['Power on all feeds…', 'Power off all feeds…', 'Power on OPT53 (PSU1)…', 'Power off OPT53 (PSU2)…', 'Power cycle OPT53 (PSU2)…'])
      await menu.getByRole('menuitem', { name: item, exact: true }).waitFor();
    await o.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    assert.equal(await ow.count(), 1, 'Escape closes the menu, not the window');
    await powerButton.click();
    await menu.getByRole('menuitem', { name: 'Power off all feeds…', exact: true }).click();
    const dialog = powerDialog(o);
    await dialog.waitFor();
    await dialog.getByText('outlet 3', { exact: false }).first().waitFor();
    await dialog.getByText('outlet 4', { exact: false }).first().waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(countWrites('/api/pdus/'), 0, 'Cancel switches nothing');
    await powerButton.click();
    await menu.getByRole('menuitem', { name: 'Power off all feeds…', exact: true }).click();
    await dialog.waitFor();
    await armed(o);
    await dialog.locator('button[data-action="off"]').click();
    await dialog.waitFor({ state: 'detached' });
    await o.locator('.lab-toast').filter({ hasText: 'OPT53 is off' }).waitFor();
    assert.equal(await outletState(admin.context, 'pdu5', 3), 'off');
    assert.equal(await outletState(admin.context, 'pdu5', 4), 'off');
    await ow.locator('[data-feed="pdu5:3"][data-state="off"]').waitFor();
    checks.push('Power ▾ › Power off all feeds… asks in PowerConfirmDialog with confirm_power off (Cancel sends nothing), then switches both feeds');
    await ow.getByRole('button', { name: 'Power on feed OPT53 (PSU1)', exact: true }).click();
    await dialog.waitFor();
    await o.getByRole('alertdialog', { name: 'Power on feed OPT53 (PSU1) of OPT53?' }).waitFor();
    await armed(o);
    await dialog.locator('button[data-action="on"]').click();
    await dialog.waitFor({ state: 'detached' });
    await ow.locator('[data-feed="pdu5:3"][data-state="on"]').waitFor();
    assert.equal(await outletState(admin.context, 'pdu5', 4), 'off', 'only that feed');
    await powerButton.click();
    await menu.getByRole('menuitem', { name: 'Power on all feeds…', exact: true }).click();
    await dialog.waitFor();
    await dialog.getByText('already on — skipped', { exact: false }).waitFor();
    await armed(o);
    await dialog.locator('button[data-action="on"]').click();
    await dialog.waitFor({ state: 'detached' });
    await ow.locator('[data-feed="pdu5:4"][data-state="on"]').waitFor();
    assert.equal(await outletState(admin.context, 'pdu5', 3), 'on');
    assert.equal(await outletState(admin.context, 'pdu5', 4), 'on');
    checks.push('one feed from Power feeds (its own dialog), then the whole server on again (the feed already on is skipped)');

    // 7. PDU 04 is in maintenance: the reason shows on the feed, and Power on is refused in the dialog with it.
    await openWindow(o, 'opt41', 'OPT41');
    await ow.locator('[data-feed="pdu4:1"]').getByText('PDU 04 is in maintenance: Fixture: rewiring Rack-04', { exact: false }).waitFor();
    const switchedBefore = countWrites('/api/pdus/');
    await powerButton.click();
    await ow.getByRole('menu', { name: 'Power OPT41' }).getByRole('menuitem', { name: 'Power on…', exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole('alert').filter({ hasText: 'PDU is in maintenance mode; restore it first' }).waitFor();
    assert.equal(await dialog.locator('button[data-action="on"]').isDisabled(), true, 'Power on is refused');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(countWrites('/api/pdus/'), switchedBefore);
    checks.push('a PDU in maintenance: the feed shows the reason and Power on is refused in the dialog');

    // 8. More › Monitor settings opens Activity at the address; Admin's More › SSH settings goes to Admin › SSH.
    await openWindow(o, 'opt13', 'OPT13');
    assert.equal(await ow.locator('details[data-section="activity"]').evaluate(el => el.open), false);
    await ow.getByRole('button', { name: '⋯ More', exact: true }).click();
    assert.equal(await ow.getByRole('menuitem', { name: 'SSH settings', exact: true }).count(), 0, 'SSH settings is for Admins');
    await ow.getByRole('menuitem', { name: 'Monitor settings', exact: true }).click();
    await o.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Address for OPT13', null, { timeout: 10000 })
      .catch(async e => { throw new Error(`Monitor settings: focus is on ${await o.evaluate(() => document.activeElement?.outerHTML?.slice(0, 160))}; Activity open: ${await ow.locator('details[data-section="activity"]').evaluate(el => el.open)} (${e.message})`); });
    await openWindow(a, 'opt13', 'OPT13');
    await w.getByRole('button', { name: '⋯ More', exact: true }).click();
    await w.getByRole('menuitem', { name: 'SSH settings', exact: true }).click();
    await w.waitFor({ state: 'detached' });
    assert.equal(param(a, 'tab'), 'admin');
    assert.equal(param(a, 'section'), 'ssh');
    assert.equal(param(a, 'focus'), 'opt13');
    checks.push('More › Monitor settings opens Activity on the address; More › SSH settings (Admin) opens Admin › SSH with focus=opt13');

    // 9. Header tools: Console and SSH for Operators (Console only with a KVM port); 3D selects srv:<first DCIM id>.
    await openWindow(o, 'opt11', 'OPT11');
    await ow.locator('[data-tool="console"]').waitFor();
    await ow.locator('[data-tool="ssh"]').waitFor();
    await openWindow(o, 'opt96', 'OPT96');
    assert.equal(await ow.locator('[data-tool="console"]').count(), 0, 'no KVM port: no Console');
    await openWindow(o, 'opt53', 'OPT53');
    if (TWIN) {
      await ow.locator('[data-tool="3d"]').click();
      await ow.waitFor({ state: 'detached' });
      assert.equal(param(o, 'tab'), 'twin');
      assert.equal(param(o, 'select'), 'srv:opt53 (psu1)', '3D selects srv:<first DCIM id>');
    } else assert.equal(await ow.locator('[data-tool="3d"]').count(), 0, 'no 3D tool while the 3D is off');
    checks.push(`Console and SSH for Operators (no Console without a KVM port); ${TWIN ? '3D opens the Twin on srv:opt53 (psu1)' : 'no 3D tool (3D off)'}`);

    // 10. Viewer: read only in the window, and the API refuses power and monitor writes.
    const viewer = await login('viewer');
    const v = viewer.page;
    const vw = await openWindow(v, 'opt11', 'OPT11', 'activity');
    await vw.getByText('Viewer · read only', { exact: true }).waitFor();
    await vw.locator('[data-monitor-details]').waitFor();
    for (const selector of ['[data-power]', '[data-tool="console"]', '[data-tool="ssh"]', '.srv-feed-actions', '[data-monitor-settings]', '[data-monitor-add]'])
      assert.equal(await vw.locator(selector).count(), 0, `Viewer: no ${selector}`);
    if (TWIN) await vw.locator('[data-tool="3d"]').waitFor();
    const refused = await v.evaluate(async () => {
      const post = (path, body, method = 'POST') => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.status);
      return [await post('/api/pdus/pdu1/outlets/1/power', { action: 'off' }), await post('/api/monitoring/targets/t11', { host: 'x', enabled: false, revision: 0 }, 'PUT')];
    });
    assert.deepEqual(refused, [403, 403], 'the API refuses a Viewer');
    assert.equal(await outletState(admin.context, 'pdu1', 1), 'on');
    checks.push('Viewer: "Viewer · read only", no Power, Console, SSH or monitor settings; power and monitor writes answer 403');

    // 11. A unit's move as the backend records it ({ rack, u, position }) reads as places in the timeline: OPT53 swaps
    //     with OPT51 and Tray 53 follows it from floor 3 to floor 1 (move-server with units_follow, as the move dialog).
    const swapped = await a.evaluate(async () => {
      const post = async body => { const r = await fetch('/api/devices/move-server', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
      const body = { server: 'OPT53 (PSU1)', target_server: 'OPT51', swap: true, units_follow: true };
      const dry = await post({ ...body, dry_run: true });
      return [dry.status, (await post({ ...body, plan_revision: dry.json?.plan_revision })).status];
    });
    assert.deepEqual(swapped, [200, 200], 'the swap is applied');
    await openWindow(a, 'opt53', 'OPT53', 'activity');
    const unitMove = w.locator('[data-activity-timeline] [data-kind="unit"]').filter({ hasText: 'Tray 53 moved' });
    await unitMove.getByText('Rack-05 · floor 3 → Rack-05 · floor 1', { exact: false }).waitFor();
    assert.doesNotMatch(await unitMove.innerText(), /object/i, 'no [object Object]');
    checks.push('a unit that moved with its server reads "Rack-05 · floor 3 → Rack-05 · floor 1" in the timeline');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    const unexpected = writes.filter(w => !/ (PUT \/api\/monitoring\/targets\/t12|POST \/api\/monitoring\/targets|POST \/api\/pdus\/pdu5\/outlets\/[34]\/power|POST \/api\/pdus\/pdu1\/outlets\/1\/power|PUT \/api\/monitoring\/targets\/t11|POST \/api\/devices\/move-server)$/.test(w));
    assert.deepEqual(unexpected, [], 'only the writes this suite means to make');
    console.log(JSON.stringify({ passed: checks }, null, 2));
    for (const ctx of [admin.context, operator.context, viewer.context]) { await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close(); }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
