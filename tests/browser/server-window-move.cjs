// Place & ports in the server window (one-place spec v1 §1.7, WP-1 Accept 1-11), as an Operator with Edit mode off:
// swap (search picker, preview with PDU / KVM / switch / units, a Viewer's Dashboard follows, Undo), move onto an empty
// floor (the Spare-N outlet preselected, an unlabelled floor keeps its outlet, the KVM port a choice, two feeds kept),
// pin an auto-placed server, take over a place, choose ports (a second feed), clear location (one clear-server request,
// put back with Choose ports), KVM-only and unplaced servers, a shared floor, removed servers in no picker, a Viewer
// reads only (403), and a label changed elsewhere between the preview and Confirm (409, re-preview, choices kept).
// The PDU outlet and KVM port belong to the FLOOR; no PDU or KVM ever moves.
//
// Fixture: tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1 DCIM_FIXTURE_ONE_PLACE=1 (run_suite.sh ...
// DCIM_FIXTURE_ONE_PLACE=1). A fresh fixture per run; only fixture data is changed, and put back. No hardware.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9680';
const PASSWORD = 'test-password-123';
const LIVE_MS = Number(process.env.LIVE_MS || 5000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], passed = [];
  async function session(username, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const login = await context.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(login.status(), 200, `${username} signs in (DCIM_TEST_ACCOUNTS=1)`);
    assert.equal((await (await context.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    return { context, csrf: (await login.json()).csrf_token, username };
  }
  async function page(s, url) {
    const p = await s.context.newPage();
    p.on('pageerror', e => errors.push(`${s.username} ${url}: ${e.message}`));
    p.on('dialog', d => { errors.push(`native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
    await p.goto(origin + url);
    return p;
  }

  try {
    const admin = await session('admin'), operator = await session('operator'), viewer = await session('viewer');
    const H = s => ({ 'X-DCIM-CSRF': s.csrf });
    const get = async path => { const r = await admin.context.request.get(origin + path); assert.equal(r.status(), 200, path); return r.json(); };
    const devicesNow = () => get('/api/devices/');
    const labelsOf = async id => ((await devicesNow()).find(d => d.id === id) || {}).labels || {};
    const setLabels = async (id, map) => { const r = await admin.context.request.patch(origin + `/api/devices/${id}/labels`, { data: map, headers: H(admin) }); assert.equal(r.status(), 200, await r.text()); };
    const locations = () => get('/api/devices/locations');
    const rowOf = async key => (await locations()).servers.find(s => s.key === key) || null;
    const portsOf = row => row ? { pdu: row.pdu.map(p => `${p.device_id}:${p.port}`), kvm: row.kvm.map(p => `${p.device_id}:${p.port}`), drawn: row.drawn } : null;
    const devicePlaces = async () => (await devicesNow()).filter(d => d.kind === 'pdu' || d.kind === 'kvm').map(d => `${d.id}:${d.rack}:${d.notes || ''}`).sort();
    assert.ok((await devicesNow()).some(d => d.id === 'pdu8'), 'Start the fixture with DCIM_FIXTURE_ONE_PLACE=1 (PDU-Rack-08 is missing)');
    // KVM 01's own port names (OPT11..OPT14) are read once, as the Dashboard does, so a move sees its KVM ports.
    assert.equal((await get('/api/kvms/kvm1/status')).reachable, true);
    const placesBefore = await devicePlaces();
    const original = { pdu: {}, kvm1: await labelsOf('kvm1'), kvm2: await labelsOf('kvm2') };
    for (const id of ['pdu1', 'pdu2', 'pdu4', 'pdu5', 'pdu6']) original.pdu[id] = await labelsOf(id);

    const win = p => p.locator('[data-window="server"]');
    const moveDialog = p => p.locator('[data-dialog="server-move"]');
    async function openServer(p, key, name, tab = 'racks') {
      await p.goto(origin + `/?tab=${tab}&srv=${key}`);
      await win(p).locator('h2', { hasText: name }).waitFor({ timeout: 30000 });
      await win(p).locator('[data-section="place"]').waitFor();
    }
    async function more(p, label) {
      await win(p).getByRole('button', { name: '⋯ More' }).click();
      await win(p).getByRole('menuitem', { name: label }).click();
    }
    async function previewed(dlg) {
      await dlg.locator('[data-list="places"]').waitFor({ timeout: 20000 });
      await dlg.locator('[data-action="confirm-move"]:not([disabled])').waitFor({ timeout: 20000 });
      return dlg.locator('[data-move-preview]').innerText();
    }
    const applied = p => p.waitForResponse(r => r.url().endsWith('/api/devices/move-server') && r.request().method() === 'POST'
      && !JSON.parse(r.request().postData() || '{}').dry_run, { timeout: 20000 });
    async function pick(dlg, text) {
      const box = dlg.getByRole('combobox');
      await box.fill(text);
      await dlg.getByRole('option').first().waitFor();
      await box.press('Enter');
    }
    async function within(label, since, check, ms = LIVE_MS) {
      for (;;) {
        if (await check().catch(() => false)) return Date.now() - since;
        if (Date.now() - since > ms) assert.fail(`${label}: not shown within ${ms} ms`);
        await sleep(100);
      }
    }
    async function undoFromToast(p, text) {
      const toast = p.locator('.lab-toast', { hasText: text }).last();
      await toast.waitFor();
      const done = applied(p);
      await toast.getByRole('button', { name: 'Undo' }).click();
      assert.equal((await done).status(), 200, 'the Undo move is applied');
      await p.locator('.lab-toast', { hasText: 'Undone:' }).last().waitFor();
    }

    const op = await page(operator, '/?tab=racks');
    const watcher = await page(viewer, '/?tab=dashboard');
    const outlets = (p, name) => p.locator(`section.device-card[aria-label="${name}"] .pdu-outlet-cell`).evaluateAll(els => els.map(e => e.innerText.trim()));
    await watcher.locator('section.device-card[aria-label="PDU 01"] .pdu-outlet-cell').first().waitFor({ timeout: 30000 });
    assert.deepEqual(await outlets(watcher, 'PDU 01'), ['OPT11', 'OPT12', 'OPT13', 'OPT14'], 'start: PDU 01 as the fixture has it');

    // ── 1. Racks › OPT11 › Swap with › "OPT13" › Enter: the preview, Swap, a Viewer's Dashboard follows, Undo ──
    {
      await openServer(op, 'opt11', 'OPT11');
      assert.equal(await win(op).getByText('Viewer · read only').count(), 0);
      await win(op).getByRole('button', { name: 'Swap with…' }).click();
      const dlg = moveDialog(op);
      await dlg.waitFor();
      assert.equal(await dlg.getAttribute('aria-modal'), 'true');
      await pick(dlg, 'OPT13');
      const plan = await previewed(dlg);
      assert.match(await dlg.locator('h2').innerText(), /^Swap OPT11 and OPT13$/);
      for (const line of ['PDU 01 outlet 1: OPT11 → OPT13', 'PDU 01 outlet 3: OPT13 → OPT11', 'KVM 01 port 1: OPT11 → OPT13']) assert.ok(plan.includes(line), `"${line}" in\n${plan}`);
      assert.match(await dlg.locator('[data-list="places"]').innerText(), /OPT11: Rack-01 · floor 1 → Rack-01 · floor 3/);
      assert.match(await dlg.locator('[data-list="switch"]').innerText(), /SW-01 port 1/, 'the switch port change is in the preview');
      assert.match(await dlg.locator('[data-units-follow]').innerText(), /Moves with it/);
      assert.equal(await dlg.getByLabel('Move the units on this floor with the server').isChecked(), true);
      const sent = op.waitForRequest(r => r.url().endsWith('/api/devices/move-server') && !JSON.parse(r.postData() || '{}').dry_run);
      const done = applied(op);
      await dlg.locator('[data-action="confirm-move"]').click();
      assert.equal((await done).status(), 200);
      const t = Date.now();
      const body = (await sent).postDataJSON();
      assert.deepEqual({ ...body, plan_revision: !!body.plan_revision }, { server: 'OPT11', target_server: 'OPT13', swap: true, units_follow: true, dry_run: false, plan_revision: true });
      await dlg.waitFor({ state: 'detached' });
      await win(op).locator('[data-last-change]', { hasText: 'OPT11 and OPT13 swapped places.' }).waitFor();
      assert.match(await win(op).locator('[data-last-change]').innerText(), /PDU 01 outlet 1: OPT11 → OPT13/);
      const pdu1 = await labelsOf('pdu1');
      assert.deepEqual([pdu1['1'], pdu1['3']], ['OPT13', 'OPT11'], 'PDU 01 outlets 1 and 3 swapped names');
      const took = await within('Viewer Dashboard follows the swap', t, async () => JSON.stringify(await outlets(watcher, 'PDU 01')) === JSON.stringify(['OPT13', 'OPT12', 'OPT11', 'OPT14']));
      await win(op).locator('[data-place-text]', { hasText: 'Rack-01 · floor 3' }).waitFor({ timeout: LIVE_MS });
      await undoFromToast(op, 'OPT11 and OPT13 swapped places.');
      const back = await labelsOf('pdu1');
      assert.deepEqual([back['1'], back['3']], ['OPT11', 'OPT13'], 'Undo swapped them back');
      await within('Viewer Dashboard follows the Undo', Date.now(), async () => JSON.stringify(await outlets(watcher, 'PDU 01')) === JSON.stringify(['OPT11', 'OPT12', 'OPT13', 'OPT14']));
      assert.deepEqual(await devicePlaces(), placesBefore, 'no PDU or KVM moved');
      passed.push(`1 Racks › OPT11 › Swap with › "OPT13" › Enter: the preview lists PDU 01 outlets 1/3, KVM 01 port 1, the switch port and "Moves with it"; Swap (one move-server with units_follow and the plan revision); the Viewer's Dashboard showed it after ${took} ms; Undo swapped back`);
    }

    // ── 2. Move to an empty floor: Spare-N preselected, an unlabelled floor keeps, the KVM port a choice, two feeds ──
    {
      await openServer(op, 'opt53', 'OPT53');
      await win(op).getByRole('button', { name: 'Move to…' }).click();
      let dlg = moveDialog(op);
      await dlg.waitFor();
      assert.equal(await dlg.getByLabel('Rack', { exact: true }).inputValue(), 'Rack-05');
      assert.equal(await dlg.getByLabel('Floor', { exact: true }).inputValue(), '2', 'the first free floor');
      const feeds = dlg.locator('[data-floor-outlet] [data-feed] select');
      assert.equal(await feeds.count(), 2, 'the two-feed server has one select per feed');
      assert.deepEqual([await feeds.nth(0).inputValue(), await feeds.nth(1).inputValue()], ['pdu5:2', 'keep'], 'floor 2: feed 1 takes the Spare outlet, feed 2 is kept');
      await dlg.getByLabel('Floor', { exact: true }).selectOption('4');
      assert.deepEqual([await feeds.nth(0).inputValue(), await feeds.nth(1).inputValue()], ['keep', 'keep'], 'floor 4 (no outlet of its own): both feeds kept');
      assert.ok((await feeds.nth(1).locator('option').allInnerTexts()).includes('Drop this feed'), 'a feed can be dropped, never by default');
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await dlg.waitFor({ state: 'detached' });

      await openServer(op, 'opt11', 'OPT11');
      await win(op).getByRole('button', { name: 'Move to…' }).click();
      dlg = moveDialog(op);
      await dlg.waitFor();
      await dlg.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
      assert.equal(await dlg.getByLabel('Floor', { exact: true }).inputValue(), '2');
      const feed = dlg.locator('[data-floor-outlet] [data-feed] select');
      assert.equal(await feed.count(), 1);
      assert.equal(await feed.inputValue(), 'pdu5:2', 'the Spare-N outlet is preselected');
      assert.match(await dlg.locator('[data-outlet-hint]').innerText(), /^Preselected: PDU 05 outlet 2 is labelled “Spare” and has this floor's number\./);
      const kvm = dlg.locator('[data-floor-kvm] select');
      assert.equal(await kvm.inputValue(), 'keep', 'the KVM port: keep by default');
      assert.deepEqual(await kvm.locator('option').allInnerTexts(), ['Keep KVM 01 · port 1', 'No KVM port'], 'and a choice');
      assert.match(await dlg.locator('[data-floor-kvm]').innerText(), /Which KVM port serves floor 2\?/);
      await dlg.getByLabel('Floor', { exact: true }).selectOption('4');
      assert.equal(await feed.inputValue(), 'keep', 'an unlabelled floor defaults to Keep');
      await dlg.getByLabel('Floor', { exact: true }).selectOption('2');
      const plan = await previewed(dlg);
      assert.ok(plan.includes('PDU 05 outlet 2: Spare → OPT11') && plan.includes('PDU 01 outlet 1: OPT11 → Outlet 1'), plan);
      assert.match(await dlg.locator('[data-list="places"]').innerText(), /OPT11: Rack-01 · floor 1 → Rack-05 · floor 2/);
      const done = applied(op);
      await dlg.locator('[data-action="confirm-move"]').click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      const moved = portsOf(await rowOf('opt11'));
      assert.deepEqual(moved, { pdu: ['pdu5:2'], kvm: ['kvm1:1'], drawn: { rack: 'Rack-05', u: 2, auto: false } }, 'OPT11 is on floor 2 with its outlet; its KVM port stayed');
      await win(op).locator('[data-place-text]', { hasText: 'Rack-05 · floor 2' }).waitFor({ timeout: LIVE_MS });
      await undoFromToast(op, 'OPT11 moved to Rack-05 · floor 2.');
      assert.deepEqual(portsOf(await rowOf('opt11')), { pdu: ['pdu1:1'], kvm: ['kvm1:1'], drawn: { rack: 'Rack-01', u: 1, auto: false } }, 'Undo put it back on floor 1');
      assert.deepEqual(await devicePlaces(), placesBefore, 'no PDU or KVM moved');
      passed.push('2 Move to…: OPT53 shows two feed selects (floor 2: Spare outlet + keep; floor 4: keep both; Drop only by choice); OPT11 → Rack-05: floor 2 preselects PDU 05 outlet 2 (Spare) and says why, floor 4 keeps; the KVM port is a choice (keep / none); Move, then Undo puts it back');
    }

    // ── 3. Pin the auto-placed server ──
    {
      const before = await rowOf('opt41');
      assert.deepEqual(before.drawn, { rack: 'Rack-04', u: 1, auto: true }, 'start: OPT41 is placed automatically');
      await openServer(op, 'opt41', 'OPT41');
      await more(op, 'Pin to floor 1');
      const dlg = moveDialog(op);
      await dlg.waitFor();
      assert.match(await dlg.locator('h2').innerText(), /^Pin OPT41 to Rack-04 · floor 1$/);
      assert.match(await dlg.locator('[data-move-plan]').innerText(), /No server moves\. OPT42, OPT43 and OPT44 are pinned to the floors they show now as well\.$/,
        'move-server pins every auto-placed server of the rack: the dialog says so');
      await previewed(dlg);
      const done = applied(op);
      await dlg.getByRole('button', { name: 'Pin', exact: true }).click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      assert.equal((await get('/api/rack-slots'))['Rack-04']?.opt41, 1, 'GET /api/rack-slots holds its U');
      assert.equal((await rowOf('opt41')).drawn.auto, false, 'drawn.auto is false');
      assert.deepEqual((await locations()).servers.filter(s => s.drawn?.rack === 'Rack-04').map(s => `${s.key}:${s.drawn.u}:${s.drawn.auto}`),
        ['opt41:1:false', 'opt42:2:false', 'opt43:3:false', 'opt44:4:false'], 'its neighbours keep their floors, pinned as the dialog said');
      await within('the window shows it pinned', Date.now(), async () => (await win(op).locator('[data-place-text]').innerText()) === 'Rack-04 · floor 1');
      await win(op).getByRole('button', { name: '⋯ More' }).click();
      assert.equal(await win(op).getByRole('menuitem', { name: /^Pin to/ }).count(), 0, 'no Pin for a pinned server');
      await op.keyboard.press('Escape');
      passed.push('3 More › Pin to floor 1 on OPT41 (auto): the dialog says OPT42-44 are pinned too; /api/rack-slots Rack-04.opt41 = 1, drawn.auto false, and Pin is gone from More');
    }

    // ── 8. A floor with two servers: two "Swap with" buttons and no save ──
    {
      await openServer(op, 'opt63', 'OPT63');
      await win(op).getByRole('button', { name: 'Move to…' }).click();
      const dlg = moveDialog(op);
      await dlg.waitFor();
      await dlg.getByLabel('Floor', { exact: true }).selectOption('1');
      const crowded = dlg.locator('[data-crowded]');
      await crowded.waitFor();
      assert.deepEqual(await crowded.getByRole('button').allInnerTexts(), ['Swap with OPT61', 'Swap with OPT62']);
      assert.equal(await dlg.locator('[data-action="confirm-move"]').isDisabled(), true, 'nothing to save');
      await crowded.getByRole('button', { name: 'Swap with OPT62' }).click();
      await previewed(dlg);
      assert.match(await dlg.locator('h2').innerText(), /^Swap OPT63 and OPT62$/);
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await dlg.waitFor({ state: 'detached' });
      passed.push('8 Move to… Rack-06 floor 1 (OPT61 and OPT62): two "Swap with" buttons, Move disabled; "Swap with OPT62" turns it into that swap\'s preview');
    }

    // ── 9. The removed server appears in no picker (Admins see removed servers elsewhere) ──
    {
      const ad = await page(admin, '/?tab=racks');
      await openServer(ad, 'opt71', 'OPT71');
      await win(ad).getByRole('button', { name: 'Swap with…' }).click();
      let dlg = moveDialog(ad);
      await dlg.waitFor();
      await dlg.getByRole('combobox').fill('OPT7');
      await dlg.getByRole('option').first().waitFor();
      const names = await dlg.getByRole('option').evaluateAll(els => els.map(e => e.dataset.server));
      assert.deepEqual(names, ['OPT72', 'OPT73'], 'OPT74 (removed) is not offered');
      await dlg.getByRole('combobox').fill('OPT98');
      await dlg.getByText('No server matches').waitFor();
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await win(ad).getByRole('button', { name: 'Move to…' }).click();
      dlg = moveDialog(ad);
      await dlg.waitFor();
      const floors = (await dlg.getByLabel('Floor', { exact: true }).locator('option').allInnerTexts()).join(' | ');
      assert.doesNotMatch(floors, /OPT74/, floors);
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await more(ad, 'Take over a place…');
      dlg = moveDialog(ad);
      await dlg.getByRole('combobox').fill('OPT74');
      await dlg.getByText('No server matches').waitFor();
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await ad.close();
      passed.push('9 as Admin: Swap with "OPT7" offers OPT72 and OPT73 only, "OPT98" matches nothing, the Rack-07 floors and the Take over picker never name OPT74');
    }

    // ── 10. Viewer: no buttons, and POST move-server returns 403 ──
    {
      await openServer(watcher, 'opt11', 'OPT11', 'dashboard');
      await win(watcher).getByText('Viewer · read only').waitFor();
      assert.equal(await win(watcher).getByRole('button', { name: /Swap with|Move to|More/ }).count(), 0, 'no place actions');
      const r = await viewer.context.request.post(origin + '/api/devices/move-server', { data: { server: 'OPT11', target_server: 'OPT13', swap: true, dry_run: true }, headers: H(viewer) });
      assert.equal(r.status(), 403, 'a Viewer may not even preview a move');
      const c = await viewer.context.request.post(origin + '/api/devices/clear-server', { data: { server: 'OPT11', dry_run: true }, headers: H(viewer) });
      assert.equal(c.status(), 403, 'nor a clear');
      await watcher.goto(origin + '/?tab=dashboard');
      passed.push('10 Viewer: "Viewer · read only", no Swap with / Move to / More; POST move-server and clear-server answer 403');
    }

    // ── a phone: the move dialog fits (no sideways scroll at 375 px) ──
    {
      const phone = await operator.context.newPage();
      phone.on('pageerror', e => errors.push(`operator phone: ${e.message}`));
      await phone.setViewportSize({ width: 375, height: 812 });
      await openServer(phone, 'opt53', 'OPT53');
      await win(phone).getByRole('button', { name: 'Move to…' }).click();
      const dlg = moveDialog(phone);
      await dlg.getByLabel('Floor', { exact: true }).selectOption('4');
      await previewed(dlg);
      const size = await phone.evaluate(() => { const d = document.querySelector('[data-dialog="server-move"]');
        return { doc: document.documentElement.scrollWidth, view: window.innerWidth, dialog: d.scrollWidth - d.clientWidth, right: d.getBoundingClientRect().right }; });
      assert.ok(size.doc <= size.view && size.dialog <= 0 && size.right <= size.view, `no horizontal scroll at 375 px ${JSON.stringify(size)}`);
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await phone.close();
      passed.push('phone 375 px: Move to… with two feed selects, the KVM choice and the preview fits without sideways scroll');
    }

    // ── 11. A label changed elsewhere between the preview and Confirm: 409, then a re-preview with the choices kept ──
    {
      await openServer(op, 'opt14', 'OPT14');
      await win(op).getByRole('button', { name: 'Move to…' }).click();
      const dlg = moveDialog(op);
      await dlg.waitFor();
      await dlg.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
      await dlg.getByLabel('Floor', { exact: true }).selectOption('4');
      await dlg.locator('[data-floor-kvm] select').selectOption('none');
      // This tab hears of the other change only through the refused save: its change feed and device list are held.
      await op.route('**/api/changes', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      const plan = await previewed(dlg);
      assert.ok(plan.includes('KVM 01 port 4: OPT14 → Port 4'), `the preview drops its KVM port:\n${plan}`);
      let open; const gate = new Promise(r => { open = r; }); const deviceList = u => u.pathname === '/api/devices/';
      await op.route(deviceList, async r => { await gate; await r.continue().catch(() => {}); });
      await setLabels('kvm1', { ...original.kvm1, 4: 'Port 4' });   // OPT14 loses its KVM port elsewhere
      const before = await labelsOf('pdu1');
      let done = applied(op);
      await dlg.locator('[data-action="confirm-move"]').click();
      const refused = (await done).status();
      open(); await op.unroute(deviceList);
      assert.equal(refused, 409, 'the server refuses a plan that changed since the preview');
      await dlg.locator('[data-move-error]', { hasText: 'changed in another session meanwhile, so nothing was saved' }).waitFor();
      assert.deepEqual(await labelsOf('pdu1'), before, 'nothing was written');
      assert.equal(await dlg.getByLabel('Rack', { exact: true }).inputValue(), 'Rack-05', 'the rack is kept');
      assert.equal(await dlg.getByLabel('Floor', { exact: true }).inputValue(), '4', 'the floor is kept');
      assert.equal(await dlg.locator('[data-floor-kvm] select').inputValue(), 'none', 'the KVM choice is kept');
      await op.unroute('**/api/changes');
      await within('the dialog previews the latest', Date.now(), async () => {
        const text = await dlg.locator('[data-move-preview]').innerText();
        return text.includes('OPT14: Rack-01 · floor 4 → Rack-05 · floor 4') && !text.includes('KVM 01 port 4');
      }, 10000);
      await dlg.locator('[data-action="confirm-move"]:not([disabled])').waitFor();
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await dlg.waitFor({ state: 'detached' });
      await setLabels('kvm1', original.kvm1);
      passed.push('11 OPT14 → Rack-05 floor 4 with "No KVM port"; KVM 01 port 4 relabelled elsewhere before Confirm: 409 "changed in another session meanwhile, so nothing was saved", nothing written, rack / floor / KVM choice kept, and the dialog previews the latest');
    }

    // ── 12. A free outlet chosen in Move to… is taken elsewhere meanwhile: the select falls back to the floor's default ──
    {
      await openServer(op, 'opt11', 'OPT11');
      await win(op).getByRole('button', { name: 'Move to…' }).click();
      const dlg = moveDialog(op);
      await dlg.waitFor();
      await dlg.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
      await dlg.getByLabel('Floor', { exact: true }).selectOption('4');
      const feed = dlg.locator('[data-floor-outlet] [data-feed] select');
      await feed.selectOption('pdu5:2');
      assert.match(await previewed(dlg), /PDU 05 outlet 2: (Spare|Outlet 2) → OPT11/, 'the chosen outlet is previewed (the Undo of check 2 left it named Outlet 2)');
      const pdu5 = await labelsOf('pdu5');
      await setLabels('pdu5', { ...pdu5, 2: 'OPT55' });   // a server lands on PDU 05 outlet 2 in another session
      await dlg.locator('[data-stale-choice]').waitFor({ timeout: LIVE_MS });
      assert.equal(await feed.inputValue(), 'keep', 'the select shows what is sent: Keep');
      const plan = await previewed(dlg);
      assert.ok(!plan.includes('PDU 05 outlet 2') && plan.includes('OPT11: Rack-01 · floor 1 → Rack-05 · floor 4'), plan);
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      await dlg.waitFor({ state: 'detached' });
      await setLabels('pdu5', pdu5);
      passed.push('12 Move to… Rack-05 floor 4 with PDU 05 outlet 2 chosen; that outlet is taken elsewhere: the select falls back to Keep, says the chosen port was taken, and the preview follows (Move stays possible)');
    }

    // ── 5. Choose ports: add a second feed (and drop it again) ──
    {
      await openServer(op, 'opt51', 'OPT51');
      await more(op, 'Choose ports…');
      const dlg = op.locator('[data-dialog="ports-move"]');
      await dlg.waitFor();
      await dlg.getByLabel('Add PDU outlet').selectOption('pdu5:2');
      await dlg.locator('[data-port-picker="pdu"]').getByRole('button', { name: 'Add' }).click();
      await dlg.getByRole('button', { name: 'Preview changes' }).click();
      await dlg.locator('[data-move-preview]').waitFor();
      assert.match(await dlg.locator('[data-list="labels"]').innerText(), /PDU 05 outlet 2[\s\S]*OPT51/);
      let done = applied(op);
      await dlg.getByRole('button', { name: 'Apply', exact: true }).click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      assert.deepEqual(portsOf(await rowOf('opt51')).pdu, ['pdu5:1', 'pdu5:2'], 'OPT51 has a second feed');
      await win(op).locator('[data-place-pdu]', { hasText: 'PDU 05 · outlet 2' }).waitFor({ timeout: LIVE_MS });
      await more(op, 'Choose ports…');
      await dlg.waitFor();
      await dlg.getByRole('button', { name: 'Remove PDU 05 · outlet 2' }).click();
      await dlg.getByRole('button', { name: 'Preview changes' }).click();
      await dlg.locator('[data-move-preview]').waitFor();
      done = applied(op);
      await dlg.getByRole('button', { name: 'Apply', exact: true }).click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      assert.deepEqual(portsOf(await rowOf('opt51')).pdu, ['pdu5:1'], 'and drops it again');
      passed.push('5 More › Choose ports… on OPT51: add PDU 05 outlet 2 → preview → Apply gives it a second feed; removing it again restores one feed');
    }

    // ── 6. Clear location: preview, ONE clear-server request; put back with Choose ports ──
    {
      await openServer(op, 'opt12', 'OPT12');
      const writes = [];
      const onRequest = r => { if (!['GET', 'HEAD'].includes(r.method()) && r.url().includes('/api/')) writes.push({ path: new URL(r.url()).pathname, body: r.postDataJSON?.() }); };
      op.on('request', onRequest);
      await more(op, 'Clear location…');
      const dlg = op.locator('[data-dialog="clear-location"]');
      await dlg.waitFor();
      await dlg.locator('[data-list="labels"]').waitFor();
      const labels = await dlg.locator('[data-list="labels"]').innerText();
      assert.ok(labels.includes('PDU 01 outlet 2: OPT12 → Outlet 2'), labels);
      assert.match(await dlg.innerText(), /It is no longer drawn on Racks; its saved rack place is kept for a later move\./);
      const done = op.waitForResponse(r => r.url().endsWith('/api/devices/clear-server') && !JSON.parse(r.request().postData() || '{}').dry_run);
      await dlg.getByRole('button', { name: 'Clear location' }).click();
      const answer = await done;
      assert.equal(answer.status(), 200);
      const cleared = (await answer.json()).changes;
      await dlg.waitFor({ state: 'detached' });
      op.off('request', onRequest);
      const applies = writes.filter(w => !w.body?.dry_run);
      assert.deepEqual(applies.map(w => w.path), ['/api/devices/clear-server'], 'one request applies the clear, no per-port writes');
      assert.equal((await labelsOf('pdu1'))['2'], 'Outlet 2');
      await win(op).locator('[data-place-pdu]', { hasText: 'No PDU outlet' }).waitFor({ timeout: LIVE_MS });
      // Put it back with Choose ports: the very ports the clear freed.
      await more(op, 'Choose ports…');
      const ports = op.locator('[data-dialog="ports-move"]');
      await ports.waitFor();
      for (const c of cleared) {
        await ports.getByLabel(c.kind === 'kvm' ? 'Add KVM port' : 'Add PDU outlet').selectOption(`${c.device_id}:${c.port}`);
        await ports.locator(`[data-port-picker="${c.kind}"]`).getByRole('button', { name: 'Add' }).click();
      }
      await ports.getByRole('button', { name: 'Preview changes' }).click();
      await ports.locator('[data-move-preview]').waitFor();
      const back = applied(op);
      await ports.getByRole('button', { name: 'Apply', exact: true }).click();
      assert.equal((await back).status(), 200);
      await ports.waitFor({ state: 'detached' });
      const row = portsOf(await rowOf('opt12'));
      assert.deepEqual([...row.pdu, ...row.kvm].sort(), cleared.map(c => `${c.device_id}:${c.port}`).sort(), 'OPT12 is back on its ports');
      assert.equal(row.drawn?.rack, 'Rack-01', 'and drawn on Rack-01 again');
      passed.push(`6 More › Clear location… on OPT12: the preview lists ${cleared.length} port(s) and says its rack place is kept; Apply is ONE clear-server request; Choose ports puts it back on the same ports`);
    }

    // ── 7. KVM-only and unplaced servers can Swap and Move ──
    {
      // OPT90 is on KVM 02 port 2 only: swap with OPT22, then Undo.
      await openServer(op, 'opt90', 'OPT90');
      await win(op).getByRole('button', { name: 'Swap with…' }).click();
      let dlg = moveDialog(op);
      await pick(dlg, 'OPT22');
      let plan = await previewed(dlg);
      assert.ok(plan.includes('KVM 02 port 2: OPT90 → OPT22') && plan.includes('PDU 02 outlet 2: OPT22 → OPT90'), plan);
      let done = applied(op);
      await dlg.locator('[data-action="confirm-move"]').click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      assert.deepEqual(portsOf(await rowOf('opt90')).pdu, ['pdu2:2'], 'OPT90 took OPT22\'s outlet');
      await undoFromToast(op, 'OPT90 and OPT22 swapped places.');
      assert.deepEqual(portsOf(await rowOf('opt90')).pdu, [], 'Undo: KVM-only again');
      await win(op).locator('[data-place-pdu]', { hasText: 'No PDU outlet' }).waitFor({ timeout: LIVE_MS });
      // OPT90 moves onto an empty floor: without a PDU outlet it would not be drawn, so it takes one.
      await win(op).getByRole('button', { name: 'Move to…' }).click();
      dlg = moveDialog(op);
      await dlg.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
      await dlg.getByLabel('Floor', { exact: true }).selectOption('2');
      const feed = dlg.locator('[data-floor-outlet] [data-feed] select');
      assert.equal(await dlg.locator('[data-floor-outlet] label').first().innerText(), 'PDU outlet');
      await feed.selectOption('none');
      await dlg.locator('[data-no-pdu]', { hasText: 'Without a PDU outlet OPT90 is not drawn on Racks.' }).waitFor();
      await feed.selectOption('pdu5:2');
      plan = await previewed(dlg);
      done = applied(op);
      await dlg.locator('[data-action="confirm-move"]').click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      assert.deepEqual(portsOf(await rowOf('opt90')), { pdu: ['pdu5:2'], kvm: ['kvm2:2'], drawn: { rack: 'Rack-05', u: 2, auto: false } });
      await undoFromToast(op, 'OPT90 moved to Rack-05 · floor 2.');
      assert.deepEqual(portsOf(await rowOf('opt90')).pdu, [], 'Undo: KVM-only again');
      // OPT96 has no port at all: it needs one, then moves; nothing to undo to, so Clear location puts it back.
      await openServer(op, 'opt96', 'OPT96');
      await win(op).getByRole('button', { name: 'Move to…' }).click();
      dlg = moveDialog(op);
      await dlg.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
      await dlg.getByLabel('Floor', { exact: true }).selectOption('2');
      await dlg.locator('[data-floor-outlet] [data-feed] select').selectOption('none');
      await dlg.getByText('Choose a PDU outlet or a KVM port: a server needs at least one.').waitFor();
      assert.equal(await dlg.locator('[data-action="confirm-move"]').isDisabled(), true);
      await dlg.locator('[data-floor-outlet] [data-feed] select').selectOption('pdu5:2');
      await previewed(dlg);
      done = applied(op);
      await dlg.locator('[data-action="confirm-move"]').click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      assert.deepEqual(portsOf(await rowOf('opt96')), { pdu: ['pdu5:2'], kvm: [], drawn: { rack: 'Rack-05', u: 2, auto: false } }, 'the unplaced server is drawn now');
      const toast = op.locator('.lab-toast', { hasText: 'OPT96 moved to Rack-05 · floor 2.' });
      await toast.waitFor();
      assert.equal(await toast.getByRole('button', { name: 'Undo' }).count(), 0, 'no Undo: it had no port before');
      // Swap the unplaced server with OPT64, then Undo.
      await win(op).locator('[data-place-text]', { hasText: 'Rack-05 · floor 2' }).waitFor({ timeout: LIVE_MS });
      await more(op, 'Clear location…');
      const clear = op.locator('[data-dialog="clear-location"]');
      await clear.locator('[data-list="labels"]').waitFor();
      const cleared = op.waitForResponse(r => r.url().endsWith('/api/devices/clear-server') && !JSON.parse(r.request().postData() || '{}').dry_run);
      await clear.getByRole('button', { name: 'Clear location' }).click();
      assert.equal((await cleared).status(), 200);
      assert.deepEqual(portsOf(await rowOf('opt96')).pdu, [], 'cleared again');
      await win(op).getByRole('button', { name: 'Swap with…' }).click();
      dlg = moveDialog(op);
      await pick(dlg, 'OPT64');
      plan = await previewed(dlg);
      assert.match(plan, /PDU 06 outlet 4: OPT64 → OPT96/i, 'OPT96 is known only from the rack layout, so its name is the layout id "opt96"');
      done = applied(op);
      await dlg.locator('[data-action="confirm-move"]').click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      assert.deepEqual(portsOf(await rowOf('opt96')).pdu, ['pdu6:4']);
      await undoFromToast(op, 'OPT96 and OPT64 swapped places.');
      assert.equal((await labelsOf('pdu6'))['4'], 'OPT64', 'Undo: OPT64 is back on PDU 06 outlet 4');
      assert.deepEqual(await devicePlaces(), placesBefore, 'no PDU or KVM moved');
      passed.push('7 OPT90 (KVM-only) swaps with OPT22 and back, and moves to Rack-05 floor 2 taking PDU 05 outlet 2 ("Without a PDU outlet … not drawn" until it does) and back; OPT96 (unplaced) needs a port, moves (no Undo offered), is cleared, swaps with OPT64 and back');
    }

    // ── 4. Take over: the target is listed as "becomes unplaced" and the button names it ──
    {
      await openServer(op, 'opt96', 'OPT96');
      await more(op, 'Take over a place…');
      const dlg = moveDialog(op);
      await dlg.waitFor();
      await pick(dlg, 'OPT63');
      await previewed(dlg);
      assert.match(await dlg.locator('[data-list="unplaced"]').innerText(), /OPT63 loses its outlet, port and place/);
      const unplacedFirst = await dlg.locator('[data-move-preview]').evaluate(el => {
        const lists = [...el.querySelectorAll('[data-list]')].map(e => e.dataset.list);
        return lists.indexOf('unplaced') === 0;
      });
      assert.ok(unplacedFirst, 'the unplaced list is shown first');
      const button = dlg.locator('[data-action="confirm-move"]');
      assert.equal(await button.innerText(), 'Take over — OPT63 loses its outlet and port');
      let done = applied(op);
      await button.click();
      assert.equal((await done).status(), 200);
      await dlg.waitFor({ state: 'detached' });
      assert.equal((await labelsOf('pdu6'))['3'].toLowerCase(), 'opt96', 'OPT96 (named by its layout id) took PDU 06 outlet 3');
      // Put it back: OPT63 takes its place back the same way.
      await openServer(op, 'opt63', 'OPT63');
      await more(op, 'Take over a place…');
      await pick(moveDialog(op), 'OPT96');
      await previewed(moveDialog(op));
      done = applied(op);
      await moveDialog(op).locator('[data-action="confirm-move"]').click();
      assert.equal((await done).status(), 200);
      const row = portsOf(await rowOf('opt63'));
      assert.deepEqual({ pdu: row.pdu, drawn: row.drawn }, { pdu: ['pdu6:3'], drawn: { rack: 'Rack-06', u: 2, auto: false } }, 'OPT63 is back on floor 2');
      passed.push('4 More › Take over a place… OPT96 → "OPT63": "Becomes unplaced: OPT63" first, the button reads "Take over — OPT63 loses its outlet and port"; applied, then OPT63 takes its place back');
    }

    // ── the fixture: no PDU or KVM moved; the server labels are as they were (cleared spares keep their default name) ──
    {
      assert.deepEqual(await devicePlaces(), placesBefore, 'no PDU or KVM moved');
      const named = map => Object.fromEntries(Object.entries(map).filter(([, v]) => /^OPT/i.test(String(v))));
      for (const id of ['pdu1', 'pdu2', 'pdu4', 'pdu6']) assert.deepEqual(named(await labelsOf(id)), named(original.pdu[id]), `${id} names its servers as before`);
      assert.deepEqual(named(await labelsOf('pdu5')), named(original.pdu.pdu5), 'pdu5 names its servers as before');
      assert.deepEqual(named(await labelsOf('kvm2')), named(original.kvm2), 'kvm2 as before');
      passed.push('fixture: every PDU / KVM in place, every server label back');
    }
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    console.log(JSON.stringify({ passed }, null, 1));
    await Promise.race([browser.close(), sleep(15000)]);
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
