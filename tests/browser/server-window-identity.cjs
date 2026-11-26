// The server window's identity package (one-place spec v1 WP-2, v2 WP-2): Rename…, Owner & network, Units on this
// floor and Delete / Restore, all from the server window, with Edit mode off. Fixture: DCIM_TEST_ACCOUNTS=1
// DCIM_FIXTURE_ONE_PLACE=1 (fresh). Every change is undone and checked at the end. Only fixture data; no hardware.
// ID-1 Rename OPT12 → OPT12X: the preview lists its PDU outlet, KVM port, rack place, monitor and owner; Apply moves the
//      window to srv=opt12x without ever showing "No longer in the lab list"; the Last change panel; rename back.
// ID-2 A name that exists (OPT13): "Swap with OPT13" (act.openMove swap), nothing renamed.
// ID-3 Owner of the two-PSU OPT53 (owners differ per feed): one choice writes every key in order; the unit on its floor
//      shows it on Racks and the 3D twin has it within 5 s; no Undo for a legacy owner.
// ID-4 Guarded Undo: not reverted when another session changed the owner meanwhile; reverted otherwise.
// ID-5 Switch: draft + Save writes both feeds; a stale ETag gives the conflict message and nothing is saved.
// ID-6 Scan barcode adds a unit to OPT53's floor and Undo removes it; hidden for the unplaced OPT96 with the reason.
// ID-7 Admin: Delete… → the one delete dialog for {kind: server, id: opt12} → removed window is read only → Restore….
//      (With WP-D's DeleteDialog: also Undo.)
// ID-8 Operator: no Delete…; Viewer: read only; both get 403 from the remove API.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9701';
const PASSWORD = 'test-password-123';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], checks = [];
  let switches0 = null;   // the switch ports to put back
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
  const headers = (s, extra = {}) => ({ 'X-DCIM-CSRF': s.csrf, ...extra });
  const win = (page, kind = 'server') => page.locator(`[data-window="${kind}"]`);
  const param = (page, name) => new URL(page.url()).searchParams.get(name);
  const toast = (page, text) => page.locator('.lab-toast').filter({ hasText: text });

  try {
    const admin = await session('admin'), operator = await session('operator'), viewer = await session('viewer');
    const api = admin.context.request;
    assert.equal((await (await api.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    assert.ok((await (await api.get(origin + '/api/devices/')).json()).some(d => d.id === 'pdu8'), 'Start the fixture with DCIM_FIXTURE_ONE_PLACE=1');
    const get = async path => (await api.get(origin + path)).json();
    async function write(method, path, data, extra = {}) {
      const r = await api.fetch(origin + path, { method, headers: headers(admin, extra), data });
      assert.equal(r.status(), 200, `${method} ${path}: ${await r.text()}`);
      return r.json();
    }
    const owners = () => get('/api/opt-owners');
    const people = await get('/api/engineers');
    const engineer = name => { const e = people.find(p => p.name === name && p.active); assert.ok(e, `${name} is an engineer`); return e.id; };
    const setOwner = (key, name) => write('PUT', `/api/opt-owners/${encodeURIComponent(key)}`, { engineer_id: name ? engineer(name) : null });
    const server = async name => (await get('/api/devices/locations')).servers.find(s => s.name === name);
    const op = operator.page;

    // ── setup: OPT12's KVM port 2 is saved under its name (the KVM reports it), and OPT12 has an owner ──
    await write('PATCH', '/api/devices/direct-label', { device_id: 'kvm1', port: '2', label: 'OPT12', expected: '' });
    await setOwner('opt12', 'Eden Levi');
    switches0 = await get('/api/switch-assignments');

    // ── ID-1 Rename OPT12 → OPT12X and back, from the window ──
    const sent = [];
    op.on('request', r => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && !/\/api\/auth\//.test(r.url())) sent.push([`${r.method()} ${new URL(r.url()).pathname}`, r.postData() || '']); });
    await op.goto(origin + '/?tab=dashboard&srv=opt12');
    const w = win(op);
    await w.locator('h2', { hasText: 'OPT12' }).waitFor();
    await w.getByRole('button', { name: 'Rename…', exact: true }).click();
    const rename = op.locator('[data-dialog="rename"]');
    await rename.waitFor();
    assert.equal(await rename.getByLabel('New name').inputValue(), 'OPT12');
    await rename.getByLabel('New name').fill('OPT12X');
    await rename.getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = rename.locator('[data-rename-preview]');
    await preview.waitFor();
    const text = await preview.innerText();
    for (const line of ['PDU 01 outlet 2: OPT12 → OPT12X', 'KVM 01 port 2: OPT12 → OPT12X']) assert.ok(text.includes(line), `the preview lists "${line}": ${text}`);
    assert.match(await preview.locator('[data-rename="position"]').innerText(), /^Rack-01, U2 \(kept/);
    assert.equal((await preview.locator('[data-rename="monitor"]').innerText()).trim(), 'OPT12 → OPT12X');
    assert.match(await preview.locator('[data-rename="owner"]').innerText(), /Eden Levi \(kept\)/);
    assert.deepEqual(sent.map(([k]) => k), ['POST /api/devices/rename-opt'], 'only the preview was sent');
    assert.equal(JSON.parse(sent[0][1]).dry_run, true);
    // Watch the window from now on: it must never say the server is gone.
    await op.evaluate(() => {
      window.__goneSeen = [];
      new MutationObserver(() => {
        const t = document.querySelector('[data-window="server"]')?.innerText || '';
        if (/No longer in the lab list|No server named/.test(t)) window.__goneSeen.push(t.slice(0, 80));
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await rename.getByRole('button', { name: 'Rename to OPT12X', exact: true }).click();
    await rename.waitFor({ state: 'detached' });
    await w.locator('h2', { hasText: 'OPT12X' }).waitFor();
    assert.equal(param(op, 'srv'), 'opt12x', 'the address names the new key');
    await w.locator('[data-last-change]').getByText('Renamed OPT12 to OPT12X.', { exact: false }).waitFor();
    await toast(op, 'Renamed OPT12 to OPT12X.').waitFor();
    await op.waitForTimeout(1500);   // the live reload that follows
    assert.deepEqual(await op.evaluate(() => window.__goneSeen), [], 'the window never showed the server as gone');
    assert.equal(JSON.parse(sent[1][1]).plan_revision?.length > 0, true, 'the apply carries the preview\'s plan_revision');
    const renamed = await server('OPT12X');
    assert.deepEqual([renamed.pdu.map(p => `${p.device_id}:${p.port}`), renamed.kvm.map(p => `${p.device_id}:${p.port}`)], [['pdu1:2'], ['kvm1:2']]);
    assert.equal(await server('OPT12'), undefined);
    assert.equal((await owners()).opt12x, 'Eden Levi', 'the owner follows');
    // Rename back from the window.
    await w.getByRole('button', { name: 'Rename…', exact: true }).click();
    await rename.waitFor();
    await rename.getByLabel('New name').fill('OPT12');
    await rename.getByRole('button', { name: 'Preview', exact: true }).click();
    await rename.getByRole('button', { name: 'Rename to OPT12', exact: true }).click();
    await rename.waitFor({ state: 'detached' });
    await w.locator('h2', { hasText: /^OPT12$/ }).waitFor();
    assert.equal(param(op, 'srv'), 'opt12');
    await op.waitForTimeout(1000);
    assert.deepEqual(await op.evaluate(() => window.__goneSeen), []);
    assert.ok(await server('OPT12'), 'OPT12 is back');
    assert.equal((await owners()).opt12, 'Eden Levi');
    checks.push('ID-1 Rename OPT12 → OPT12X: the preview lists PDU 01 outlet 2, KVM 01 port 2, Rack-01 U2, the monitor and owner; Apply (with plan_revision) moves the window to srv=opt12x with no "gone" state and a Last change panel; renamed back the same way');

    // ── ID-2 A name that already exists: Swap with it ──
    sent.length = 0;
    await w.getByRole('button', { name: 'Rename…', exact: true }).click();
    await rename.waitFor();
    await rename.getByLabel('New name').fill('OPT13');
    await rename.getByRole('button', { name: 'Preview', exact: true }).click();
    await rename.getByRole('alert').getByText('OPT13 already exists', { exact: false }).waitFor();
    assert.equal(await rename.getByRole('button', { name: /^Rename to/ }).count(), 0, 'nothing to apply');
    await rename.getByRole('button', { name: 'Swap with OPT13', exact: true }).click();
    await rename.waitFor({ state: 'detached' });
    // act.openMove({ mode: "swap", swapWith: "opt13" }) replaces the rename dialog with WP-1's move dialog (when built).
    const move = op.locator('[data-dialog="server-move"]');
    const moveBuilt = await move.waitFor({ timeout: 5000 }).then(() => true, () => false);
    assert.ok(moveBuilt, 'Swap with opens the move dialog (WP-1 MoveDialog)');
    if (moveBuilt) {
      assert.match(await move.innerText(), /OPT13/, 'the move dialog swaps with OPT13');
      await op.keyboard.press('Escape');
      await move.waitFor({ state: 'detached' });
    }
    await op.waitForTimeout(300);
    assert.deepEqual(sent.map(([k, body]) => [k, JSON.parse(body).dry_run === true]).filter(([k]) => /rename-opt/.test(k)), [['POST /api/devices/rename-opt', true]], 'only the preview');
    assert.ok(!sent.some(([k, body]) => /move-server/.test(k) && !JSON.parse(body).dry_run), 'nothing was moved');
    checks.push(`ID-2 Renaming OPT12 to OPT13 is refused ("OPT13 already exists"); "Swap with OPT13" closes the rename and opens the swap${moveBuilt ? ' (WP-1 move dialog names OPT13)' : ' (WP-1 move dialog not built yet: openMove only)'}; nothing renamed`);

    // ── ID-3 Owner of the two-PSU OPT53: every key, Racks and 3D within 5 s ──
    const watcher = viewer.page;
    await watcher.goto(origin + '/?tab=racks');
    await watcher.waitForFunction(() => document.querySelector('.racks-grid .equipment-cell[data-item-id="u-tray53"]'), null, { timeout: 30000 });
    assert.equal(await watcher.locator('.racks-grid .equipment-cell[data-item-id="u-tray53"]').getAttribute('data-owner'), 'Alice Feed');
    const twin = await viewer.context.newPage();
    twin.on('pageerror', e => errors.push(`twin: ${e.message}`));
    await twin.goto(origin + '/twin/');
    await twin.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.live.owners && Object.keys(window.__twin.S.live.owners).length, null, { timeout: 60000 });
    // The standalone twin's change feed takes its first answer as the baseline: wait until it has polled twice.
    await twin.waitForFunction(() => window.__twin.S.stats.changePolls >= 2, null, { timeout: 30000 });
    await op.goto(origin + '/?tab=dashboard&srv=opt53');
    await w.locator('h2', { hasText: 'OPT53' }).waitFor();
    await w.locator('[data-owner-disagree]').getByText('Feeds disagree: OPT53 (PSU1) → Alice Feed, OPT53 (PSU2) → Bob Feed — choosing an owner sets both.', { exact: true }).waitFor();
    sent.length = 0;
    await w.getByLabel('Owner for OPT53', { exact: true }).selectOption({ label: 'Ariel Vinograd' });
    await w.locator('[data-owner-block]').getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    const t0 = Date.now();   // saved: from here every screen has 5 s
    assert.deepEqual(sent.map(([k]) => k), ['PUT /api/opt-owners/opt53', 'PUT /api/opt-owners/opt53%20(psu1)', 'PUT /api/opt-owners/opt53%20(psu2)'], 'one PUT per key, in order, never the unkeyed map');
    const after = await owners();
    assert.deepEqual([after.opt53, after['opt53 (psu1)'], after['opt53 (psu2)']], ['Ariel Vinograd', 'Ariel Vinograd', 'Ariel Vinograd']);
    const within = Math.max(1000, 5000 - (Date.now() - t0));
    await Promise.all([
      watcher.waitForFunction(() => document.querySelector('.racks-grid .equipment-cell[data-item-id="u-tray53"]')?.dataset.owner === 'Ariel Vinograd', null, { timeout: within })
        .catch(async e => { throw new Error(`Racks: the unit still shows ${await watcher.locator('.racks-grid .equipment-cell[data-item-id="u-tray53"]').getAttribute('data-owner')} after 5 s (${e.message.split('\n')[0]})`); }),
      twin.waitForFunction(() => window.__twin.S.live.owners['opt53 (psu1)'] === 'Ariel Vinograd' && window.__twin.S.live.owners['opt53 (psu2)'] === 'Ariel Vinograd', null, { timeout: within })
        .catch(async e => { throw new Error(`3D twin: ${JSON.stringify(await twin.evaluate(() => [window.__twin.S.live.owners['opt53 (psu1)'], window.__twin.S.live.owners['opt53 (psu2)']]))} after 5 s (${e.message.split('\n')[0]})`); }),
    ]);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    await toast(op, 'Owner of OPT53 set to Ariel Vinograd.').waitFor();
    assert.match(await toast(op, 'Owner of OPT53 set to Ariel Vinograd.').innerText(), /Alice Feed is not in the engineer list/);
    assert.equal(await toast(op, 'Owner of OPT53 set to Ariel Vinograd.').getByRole('button', { name: 'Undo' }).count(), 0, 'no Undo back to a legacy owner');
    await w.locator('[data-owner-disagree]').waitFor({ state: 'detached' });
    checks.push(`ID-3 OPT53 owner → Ariel Vinograd: PUT opt53, opt53 (psu1), opt53 (psu2) in order; the Tray 53 tooltip on Racks and the 3D twin show it within 5 s of the save (${seconds} s); no Undo to the legacy feed owners`);
    await twin.close();

    // ── ID-4 Guarded Undo on OPT12 (owner Eden Levi) ──
    await op.goto(origin + '/?tab=dashboard&srv=opt12');
    await w.locator('h2', { hasText: /^OPT12$/ }).waitFor();
    await w.getByLabel('Owner for OPT12', { exact: true }).selectOption({ label: 'Roy Mendelson' });
    let t = toast(op, 'Owner of OPT12 set to Roy Mendelson.');
    await t.waitFor();
    await setOwner('opt12', 'Liran Cohen');   // another session, meanwhile
    await t.getByRole('button', { name: 'Undo', exact: true }).click();
    await toast(op, 'Not undone: the owner of OPT12 was changed in another session.').waitFor();
    assert.equal((await owners()).opt12, 'Liran Cohen', 'the other session\'s owner is kept');
    await w.getByLabel('Owner for OPT12', { exact: true }).locator('option:checked').filter({ hasText: 'Liran Cohen' }).waitFor({ state: 'attached' });
    await w.getByLabel('Owner for OPT12', { exact: true }).selectOption({ label: 'Adam Cohen' });
    t = toast(op, 'Owner of OPT12 set to Adam Cohen.');
    await t.waitFor();
    assert.equal((await owners()).opt12, 'Adam Cohen');
    await t.getByRole('button', { name: 'Undo', exact: true }).click();
    await toast(op, 'Owner of OPT12 is back to').waitFor();
    assert.equal((await owners()).opt12, 'Liran Cohen', 'Undo puts the previous owner back');
    checks.push('ID-4 Guarded Undo: after another session set Liran Cohen, Undo of Roy Mendelson reverts nothing ("changed in another session"); Undo of Adam Cohen puts Liran Cohen back');

    // ── ID-5 Switch on OPT53: both feeds; a stale ETag gives the conflict message ──
    await op.goto(origin + '/?tab=dashboard&srv=opt53');
    await w.locator('h2', { hasText: 'OPT53' }).waitFor();
    const swName = w.getByLabel('Switch for OPT53', { exact: true }), swPort = w.getByLabel('Switch port for OPT53', { exact: true });
    await w.locator('[data-switch-disagree]').waitFor();
    assert.deepEqual([await swName.inputValue(), await swPort.inputValue()], ['SW-05', '3']);
    await swName.fill('SW-QA');
    await swPort.fill('9');
    const saveSwitch = w.locator('[data-action="save-switch"]');
    await saveSwitch.click();
    await toast(op, 'Switch of OPT53 set to SW-QA · port 9.').waitFor();
    let sw = await get('/api/switch-assignments');
    assert.deepEqual([sw['opt53 (psu1)'], sw['opt53 (psu2)']], [{ switch: 'SW-QA', port: '9' }, { switch: 'SW-QA', port: '9' }]);
    await w.locator('[data-switch-disagree]').waitFor({ state: 'detached' });
    // Stale: the change feed is held, so the window keeps the ETag it read; another session saves the list meanwhile.
    await op.route('**/api/changes', route => route.fulfill({ status: 503, body: '{}' }));
    await op.waitForTimeout(3000);   // reloads this window's own save started are over before the other session saves
    {
      const g = await api.get(origin + '/api/switch-assignments');
      const doc = await g.json(); doc.opt11 = { switch: 'SW-01', port: '2' };
      const r = await api.put(origin + '/api/switch-assignments', { data: doc, headers: headers(admin, { 'If-Match': g.headers().etag }) });
      assert.equal(r.status(), 200, await r.text());
    }
    await swPort.fill('10');
    await saveSwitch.click();
    await w.locator('[data-switch-error]').getByText('changed in another session', { exact: false }).waitFor();
    sw = await get('/api/switch-assignments');
    assert.deepEqual([sw['opt53 (psu1)'].port, sw.opt11.port], ['9', '2'], 'nothing was overwritten');
    await op.unroute('**/api/changes');
    assert.equal(await swPort.inputValue(), '10', 'the edit is kept');
    await saveSwitch.click();
    await toast(op, 'Switch of OPT53 set to SW-QA · port 10.').waitFor();
    sw = await get('/api/switch-assignments');
    assert.deepEqual([sw['opt53 (psu1)'].port, sw['opt53 (psu2)'].port, sw.opt11.port], ['10', '10', '2']);
    checks.push('ID-5 Switch SW-QA · 9 saved under both OPT53 feeds; with a stale ETag the save is refused with "changed in another session", the edit is kept, and the next Save works');

    // ── ID-6 Scan barcode on OPT53's floor, Undo; hidden for the unplaced OPT96 ──
    const units = w.locator('[data-section="units"]');
    await units.locator('[data-unit-id="u-tray53"]').waitFor();
    await units.getByRole('button', { name: 'Scan barcode', exact: true }).click();
    const scan = op.locator('[data-dialog="scan-unit"]');
    await scan.waitFor();
    await scan.getByLabel('Unit barcode').fill('QAWIN0001');
    await scan.getByLabel('Unit barcode').press('Enter');
    await scan.locator('.scan-unit-log li[data-action="created"]').waitFor();
    const added = async () => Object.values(await get('/api/rack-items')).flat().find(i => i.serial_number === 'QAWIN0001' || i.barcode === 'QAWIN0001');
    const unit = await added();
    assert.ok(unit, 'the scanned unit is saved');
    const where = Object.entries(await get('/api/rack-items')).find(([, list]) => list.some(i => i.id === unit.id))[0];
    assert.deepEqual([where, unit.u], ['Rack-05', 3], 'on OPT53\'s floor');
    await units.locator(`[data-unit-id="${unit.id}"]`).waitFor();
    await scan.getByRole('button', { name: 'Done', exact: true }).click();
    await scan.waitFor({ state: 'detached' });
    await op.locator('.lab-toast').filter({ hasText: 'Added' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await units.locator(`[data-unit-id="${unit.id}"]`).waitFor({ state: 'detached' });
    assert.equal(await added(), undefined, 'Undo removed it');
    await op.goto(origin + '/?tab=dashboard&srv=opt96&sec=units');
    await w.locator('h2', { hasText: 'OPT96' }).waitFor();
    await w.locator('[data-units-why]').getByText(/^OPT96 is not drawn on a rack, so it has no floor for units.$/i).waitFor();
    assert.equal(await w.getByRole('button', { name: 'Scan barcode', exact: true }).count(), 0);
    checks.push('ID-6 Scan barcode adds a unit to Rack-05 floor 3 (listed under OPT53 at once) and Undo removes it; OPT96 (unplaced) has no Scan, with "OPT96 is not drawn on a rack, so it has no floor for units."');

    // ── ID-7 Admin: Delete… through the one delete dialog, the removed window is read only, Restore ──
    const ad = admin.page;
    const aw = win(ad);
    const adminSent = [];
    ad.on('request', r => { if (r.method() === 'POST' && /\/api\/(lab|removed-servers)/.test(r.url())) adminSent.push([new URL(r.url()).pathname, r.postData() || '']); });
    await ad.goto(origin + '/?tab=dashboard&srv=opt12');
    await aw.locator('h2', { hasText: /^OPT12$/ }).waitFor();
    async function deleteFromWindow() {
      await aw.getByRole('button', { name: '⋯ More', exact: true }).click();
      await aw.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
      const lab = ad.locator('[data-dialog="delete"]'), legacy = ad.locator('[data-dialog="remove-server"]');
      await lab.or(legacy).first().waitFor();
      if (await legacy.count()) {
        await legacy.getByRole('heading', { name: /^Remove OPT12 from the lab\?$/i }).waitFor();
        await legacy.locator('[data-list="cleaned"] li').first().waitFor();
        await legacy.locator('button[data-action="remove-server"]').click();
        await legacy.waitFor({ state: 'detached' });
        return 'legacy';
      }
      // WP-D's DeleteDialog: the preview names OPT12; confirm (type what it asks for); the window closes.
      await ad.waitForFunction(() => document.querySelector('[data-dialog="delete"]')?.getAttribute('aria-busy') === 'false', null, { timeout: 20000 });
      await lab.getByText('OPT12', { exact: false }).first().waitFor();
      const typed = lab.locator('#lab-delete-confirm');
      if (await typed.count()) await typed.fill((await lab.locator('label[for="lab-delete-confirm"]').innerText()).replace(/^Type (.+) to delete.*$/, '$1'));
      await lab.locator('button[data-action="delete"]').click();
      await lab.waitFor({ state: 'detached' });
      return 'lab';
    }
    const kind = await deleteFromWindow();
    assert.equal(kind, 'lab', 'Delete… opens the one DeleteDialog (WP-D), not the old remove dialog');
    if (kind === 'legacy') assert.deepEqual(adminSent.map(([p, body]) => [p, String(JSON.parse(body).name).toLowerCase(), JSON.parse(body).dry_run === true]), [['/api/removed-servers', 'opt12', true], ['/api/removed-servers', 'opt12', false]]);
    else assert.ok(adminSent.some(([p, body]) => p === '/api/lab/delete' && JSON.stringify(JSON.parse(body).targets) === JSON.stringify([{ kind: 'server', id: 'opt12' }])), `the delete names {kind: server, id: opt12}: ${JSON.stringify(adminSent)}`);
    const hiddenNow = async () => (await get('/api/removed-servers')).hidden.includes('opt12');
    if (kind === 'lab') {   // the window closed; Undo from the provider toast, then delete again from the window
      await ad.locator('.lab-toast').filter({ hasText: 'Deleted OPT12' }).getByRole('button', { name: 'Undo', exact: true }).click();
      await ad.locator('.lab-toast').filter({ hasText: 'Restored' }).waitFor({ timeout: 15000 });
      assert.equal(await hiddenNow(), false, 'Undo brought OPT12 back');
      await ad.goto(origin + '/?tab=dashboard&srv=opt12');
      await aw.getByRole('button', { name: 'Rename…', exact: true }).waitFor();
      await deleteFromWindow();
    }
    assert.equal(await hiddenNow(), true, 'OPT12 is removed');
    // The banner names "Deleted" or "Removed from the lab" only once the Deleted list was read (never one, then the other).
    const said = [];
    await ad.exposeFunction('__bannerSaid', t => said.push(t));
    await ad.addInitScript(() => new MutationObserver(() => {
      const b = document.querySelector('[data-removed-banner]');
      const t = b ? `${b.dataset.removedBanner}: ${b.innerText}` : '';
      if (t && t !== window.__bannerLast) { window.__bannerLast = t; window.__bannerSaid(t); }
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true }));
    await ad.goto(origin + '/?tab=dashboard&srv=opt12');
    await aw.locator(`[data-removed-banner="${kind === 'lab' ? 'deleted' : 'removed'}"]`).filter({ hasText: 'by admin' }).waitFor();
    assert.ok(said.every(t => /^(checking|deleted|removed): /.test(t)) && !(said.some(t => t.startsWith('removed')) && said.some(t => t.startsWith('deleted'))),
      `the banner never switches between "Removed from the lab" and "Deleted": ${JSON.stringify(said)}`);
    assert.match(await aw.locator('[data-removed-banner]').innerText(), kind === 'lab' ? /^Deleted .*by admin\. Read only\./ : /^Removed from the lab .*by admin\. Read only\./);
    await aw.getByText('Removed · read only', { exact: true }).waitFor();
    assert.equal(await aw.getByRole('button', { name: 'Rename…', exact: true }).count(), 0, 'read only');
    assert.equal(await aw.getByLabel('Owner for OPT12', { exact: true }).count(), 0, 'no owner select');
    await aw.getByRole('button', { name: 'Restore…', exact: true }).click();
    const restore = ad.locator('[data-dialog="restore-server"]');
    await restore.waitFor();
    await restore.getByText('Its rack place, switch port and owner do not come back.', { exact: true }).waitFor();
    await restore.getByRole('button', { name: 'Restore', exact: true }).click();
    await restore.waitFor({ state: 'detached' });
    await toast(ad, kind === 'lab' ? 'Restored OPT12' : 'OPT12 is back in the lab.').waitFor();   // a deleted server's Restore says Restored
    await aw.locator('[data-removed-banner]').waitFor({ state: 'detached' });
    await aw.getByRole('button', { name: 'Rename…', exact: true }).waitFor();
    assert.equal((await get('/api/removed-servers')).hidden.includes('opt12'), false, 'OPT12 is not removed any more');
    checks.push(`ID-7 Admin: More › Delete… opens the one delete dialog for OPT12 (${kind === 'lab' ? 'WP-D DeleteDialog: POST /api/lab/delete {kind: server, id: opt12}, Undo, delete again' : 'today\'s RemoveServerDialog until WP-D'}); the window turns read only ("Removed · read only", banner by admin); Restore… brings it back in the window`);

    // ── ID-8 Operator: no Delete…; Viewer: read only; 403 from the API ──
    await op.goto(origin + '/?tab=dashboard&srv=opt11');
    await w.locator('h2', { hasText: 'OPT11' }).waitFor();
    await w.getByRole('button', { name: 'Rename…', exact: true }).waitFor();
    const more = w.getByRole('button', { name: '⋯ More', exact: true });
    if (await more.count()) {
      await more.click();
      assert.equal(await w.getByRole('menuitem', { name: 'Delete…', exact: true }).count(), 0, 'an Operator has no Delete…');
      await op.keyboard.press('Escape');
    }
    assert.equal(await w.getByRole('button', { name: 'Delete…', exact: true }).count(), 0);
    const vw = win(viewer.page);
    await viewer.page.goto(origin + '/?tab=dashboard&srv=opt53');
    await vw.locator('h2', { hasText: 'OPT53' }).waitFor();
    await vw.getByText('Viewer · read only', { exact: true }).waitFor();
    await vw.locator('[data-owner-value]').getByText('Ariel Vinograd', { exact: true }).waitFor();
    await vw.locator('[data-switch-value]').getByText('SW-QA · port 10', { exact: true }).waitFor();
    for (const [what, sel] of [['owner select', 'select'], ['Scan barcode', '[data-action="scan-unit"]'], ['Rename', '[data-action="rename"]'], ['Save', '[data-action="save-switch"]']]) {
      assert.equal(await vw.locator(sel).count(), 0, `a Viewer has no ${what}`);
    }
    for (const s of [operator, viewer]) {
      const g = await s.context.request.get(origin + '/api/removed-servers');
      const h = headers(s, { 'If-Match': g.headers().etag });
      assert.equal((await s.context.request.post(origin + '/api/removed-servers', { data: { name: 'OPT11', dry_run: true }, headers: h })).status(), 403);
      assert.equal((await s.context.request.post(origin + '/api/removed-servers/restore', { data: { key: 'opt74' }, headers: h })).status(), 403);
      const lab = await s.context.request.post(origin + '/api/lab/delete', { data: { targets: [{ kind: 'server', id: 'opt11' }], dry_run: true }, headers: h });
      assert.equal(lab.status(), 403, `${s.username} POST /api/lab/delete server: ${lab.status()}`);
    }
    checks.push('ID-8 Operator has Rename… but no Delete…; Viewer reads the owner and switch with no controls; both get 403 from remove / restore');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    // Put the fixture back: owners, switch ports.
    try {
      const a = await browser.newContext();
      const login = await a.request.post(origin + '/api/auth/login', { data: { username: 'admin', password: PASSWORD } });
      const h = { 'X-DCIM-CSRF': (await login.json()).csrf_token };
      for (const key of ['opt12', 'opt53']) {
        const r = await a.request.put(origin + `/api/opt-owners/${encodeURIComponent(key)}`, { data: { engineer_id: null }, headers: h });
        if (r.status() !== 200) throw new Error(`owner ${key}: ${await r.text()}`);
      }
      if (switches0) {
        const g = await a.request.get(origin + '/api/switch-assignments');
        const r = await a.request.put(origin + '/api/switch-assignments', { data: switches0, headers: { ...h, 'If-Match': g.headers().etag } });
        if (r.status() !== 200) throw new Error(`switch: ${await r.text()}`);
      }
      checks.push('fixture put back: OPT12 / OPT53 owners cleared, switch ports restored');
      await a.close();
    } catch (e) { console.error('restore:', e.message); process.exitCode = 1; }
    await browser.close();
    checks.forEach(c => console.log('PASS', c));
    console.log(process.exitCode ? 'FAILED' : `OK ${checks.length} checks`);
  }
})();
