// The Manage page (?tab=inventory; one-place spec v2 §M, WP-M Accept; v1 WP-6 on Type = Servers). Replaces servers-list.cjs.
// Fixture: DCIM_TEST_ACCOUNTS=1 DCIM_FIXTURE_ONE_PLACE=1 POWER_PROTECTED_OUTLETS=pdu1:4, fresh. Local fixture only; nothing is
// written to a PDU or KVM (the fixture's devices are database rows).
//
//  M-1  every chip count equals buildLabIndex run here (dynamic import) on the same API responses
//  M-2  show=not-in-lm: ITEM-0044, ITEM-0043 (with its reason), ITEM-0033, "optn85 · Monitor only"; not ITEM-0040 or OPT300;
//       the mismatch banner; 3D-only PDU / KVM rows have a disabled checkbox
//  M-3  "Select all" only under a show= filter, at most 50; the sticky bar
//  M-4  every row opens its item's window (server, PDU, unit, 3D record)
//  M-5  Type = Servers: v1's columns, state filter, sort, search, count; coverage filters equal Connections'
//  M-6  show=free-ports and show=unplaced
//  M-7  Viewer: no checkboxes, no server address, no Server IP, no CSV, no + Add, no Deleted; Operator: CSV
//  M-8  the Edit-mode owner select writes every key of the server (ownerWriteKeys)
//  M-9  live: another context moves a server; the table follows
//  M-10 Admin bulk delete of 5 (cart, ladder, a JSON opt, a JSON equip, optn85): typed "5"; gone from Manage, the TV and the
//       twin within 5 s; show=deleted lists them; Restore brings them back
//  M-11 show=deleted: the servers removed before this release with the log; a row opens the removed server's window
//  M-12 + Add › Server… adds a server on Rack-05 and its window opens
//  M-13 no horizontal page scroll at 1440, 1280, 1024, 390 and 375 px
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:9840';
const PASSWORD = 'test-password-123';
const LIVE_MS = 7500;   // "within 5 s" plus the page's own poll of the change feed
const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const mod = p => import(pathToFileURL(path.join(SRC, p)).href);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [], passed = [], notes = [];
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
  const json = async (s, p) => { const r = await s.context.request.get(origin + p); assert.equal(r.status(), 200, `GET ${p}`); return r.json(); };
  const manage = async (s, query = '') => {
    await s.page.goto(`${origin}/?tab=inventory${query ? `&${query}` : ''}`);
    await s.page.locator('[data-page="manage"][aria-busy="false"]').waitFor({ timeout: 30000 });
    return s.page;
  };
  const rowOf = (page, uid) => page.locator(`[data-uid="${uid}"]`);
  const shownUids = page => page.locator('[data-list="manage"] [data-uid], [data-list="servers"] [data-uid]').evaluateAll(els => els.map(e => e.dataset.uid));
  const chip = (page, id) => page.locator(`[data-chip="${id}"]`);
  const chipCount = async (page, id) => Number((await chip(page, id).locator('.manage-count').innerText()).trim());
  const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // The index the page builds, built here from the same API responses (frontend/src/lab/labIndex.js).
  async function expectedIndex(s, role) {
    const [{ buildLabIndex }, { hiddenSet }, floors] = await Promise.all([mod('lab/labIndex.js'), mod('api/removedServers.js'), mod('components/racks/floors.js')]);
    const devices = await json(s, '/api/devices/');
    floors.setStorageRacks(floors.storageRacksFromDevices(devices));
    const status = async (kind, id) => { const r = await s.context.request.get(`${origin}/api/${kind}s/${id}/status`); return r.ok() ? r.json() : { device_id: id, requestFailed: true }; };
    const pduStatuses = {}, kvmStatuses = {};
    for (const d of devices) {
      if (d.kind === 'pdu') pduStatuses[d.id] = await status('pdu', d.id);
      if (d.kind === 'kvm') kvmStatuses[d.id] = await status('kvm', d.id);
    }
    const removed = await json(s, '/api/removed-servers');
    const data = { devices, pduStatuses, kvmStatuses, maintenance: null, locations: await json(s, '/api/devices/locations'),
      rackItems: await json(s, '/api/rack-items'), owners: await json(s, '/api/opt-owners'), switches: await json(s, '/api/switch-assignments'),
      monitoring: await json(s, '/api/monitoring'), chillers: await json(s, '/api/chillers'), twin: { data: await json(s, '/api/twin-data') },
      removed, hidden: hiddenSet(removed) };
    return buildLabIndex(data, role);
  }

  try {
    const admin = await session('admin'), operator = await session('operator'), viewer = await session('viewer');
    assert.equal((await json(admin, '/api/version')).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    assert.ok((await json(admin, '/api/devices/')).some(d => d.id === 'pdu8'), 'Start the fixture with DCIM_FIXTURE_ONE_PLACE=1 (PDU-Rack-08 is missing)');

    // ── M-1 chip counts = buildLabIndex on the same responses ──
    let page = await manage(admin);
    const expected = await expectedIndex(admin, 'admin');
    const want = { all: expected.counts.total, unreachable: expected.counts.problems.unreachable, 'maybe-gone': expected.counts.problems['maybe-gone'] };
    try {
      await page.waitForFunction(w => Object.entries(w).every(([id, n]) => Number(document.querySelector(`[data-chip="${id}"] .manage-count`)?.textContent) === n),
        want, { timeout: 20000 });
    } catch {
      assert.deepEqual({ all: await chipCount(page, 'all'), unreachable: await chipCount(page, 'unreachable'), 'maybe-gone': await chipCount(page, 'maybe-gone') }, want, 'chip counts');
    }
    const more = await page.getByLabel('More filters').locator('option').allTextContents();
    for (const [id, label] of [['no-location', 'No location'], ['single-feed', 'Single feed'], ['missing-kvm', 'No KVM port'], ['missing-pdu', 'No PDU outlet'],
      ['free-ports', 'Free ports'], ['not-in-lm', 'Not in Lab Manager']]) {
      assert.ok(more.includes(`${label} (${expected.counts.problems[id]})`), `More filters shows ${label} (${expected.counts.problems[id]}): ${more.join(' | ')}`);
    }
    assert.equal(await page.locator('[data-list="manage"] tbody tr').count(), expected.counts.total, 'All lists every row');
    passed.push(`M-1 chips All ${want.all} · Needs a look ${want.unreachable} · Maybe gone ${want['maybe-gone']} and every More filters count equal buildLabIndex on the same API responses`);

    // ── M-2 not-in-lm ──
    page = await manage(admin, 'show=not-in-lm');
    let uids = await shownUids(page);
    for (const uid of ['twin:ITEM-0044', 'twin:ITEM-0043', 'twin:ITEM-0033', 'server:optn85']) assert.ok(uids.includes(uid), `not-in-lm lists ${uid}`);
    for (const uid of ['twin:ITEM-0040', 'server:opt300', 'dev:pdu8']) assert.ok(!uids.includes(uid), `not-in-lm leaves out ${uid}`);
    assert.match(await rowOf(page, 'twin:ITEM-0043').innerText(), /No KVM with id kvm-unit3 or name KVM-Unit-3 in Lab Manager/);
    assert.match(await rowOf(page, 'server:optn85').innerText(), /optn85[\s\S]*Monitor only/);
    assert.match(await page.locator('[data-banner="mismatch"]').innerText(), /lab-data\.json PDU\/KVM ids do not match Lab Manager \(10 of 11\)/);
    for (const uid of ['twin:ITEM-0033', 'twin:ITEM-0043']) {
      const box = rowOf(page, uid).locator('input[type="checkbox"]');
      assert.equal(await box.isDisabled(), true, `${uid}: a 3D PDU / KVM row cannot be selected`);
      assert.match(await box.getAttribute('title'), /3D PDU and KVM records are never bulk-selected/);
    }
    assert.equal(await rowOf(page, 'twin:ITEM-0044').locator('input[type="checkbox"]').isDisabled(), false);
    // OPT300 is the computer unit u-pc300: one row, badge "Unit", opening the unit window
    page = await manage(admin, 'q=opt300');
    assert.deepEqual(await shownUids(page), ['server:opt300']);
    assert.match(await rowOf(page, 'server:opt300').innerText(), /Unit/);
    passed.push('M-2 show=not-in-lm lists ITEM-0044, ITEM-0043 ("No KVM with id kvm-unit3 or name KVM-Unit-3 in Lab Manager"), ITEM-0033 and "optn85 · Monitor only", not ITEM-0040 or OPT300; the mismatch banner (10 of 11); 3D PDU/KVM rows have a disabled checkbox');

    // ── M-3 Select all only under show=, at most 50 ──
    page = await manage(admin);
    assert.equal(await page.locator('[data-action="select-all"]').count(), 0, 'no Select all without a show= filter');
    page = await manage(admin, 'show=maybe-gone');
    const selectAll = page.locator('[data-action="select-all"]');
    const label = (await selectAll.innerText()).trim();
    const n = Number(label.match(/Select all (\d+) shown/)[1]);
    assert.ok(n > 0 && n <= 50, label);
    await selectAll.click();
    await page.locator('[data-bulk]').waitFor();
    assert.match(await page.locator('[data-bulk]').innerText(), new RegExp(`${n}\\s+selected`));
    assert.equal(await page.locator('input[data-select]:checked').count(), n);
    await page.locator('[data-bulk]').getByRole('button', { name: 'Clear' }).click();
    await page.locator('[data-bulk]').waitFor({ state: 'detached' });
    passed.push(`M-3 "Select all" only under a show= filter ("${label}", at most 50); the bar says "${n} selected"; Clear empties it`);

    // ── M-4 every row opens its window ──
    page = await manage(admin);
    for (const [uid, kind] of [['server:opt11', 'server'], ['dev:pdu5', null], ['unit:u-tray53', 'unit'], ['twin:ITEM-0044', 'twin'], ['rack:Rack-05', null], ['cooling:ch5', 'cooling']]) {
      await rowOf(page, uid).locator('.manage-name').click();
      const win = kind ? page.locator(`[data-window="${kind}"]`) : page.locator('[data-window]');
      await win.waitFor({ timeout: 15000 });
      await page.keyboard.press('Escape');
      await page.locator('[data-window]').waitFor({ state: 'detached', timeout: 10000 });
    }
    // ⋯ › Open does the same; a click on the row itself too
    await rowOf(page, 'server:opt12').getByRole('button', { name: 'Actions for OPT12' }).click();
    const menuItems = await rowOf(page, 'server:opt12').getByRole('menuitem').allTextContents();
    assert.deepEqual(menuItems, ['Open', 'Show in 3D', 'Show on Racks', 'Delete…']);
    await rowOf(page, 'server:opt12').getByRole('menuitem', { name: 'Open' }).click();
    await page.locator('[data-window="server"] h2', { hasText: 'OPT12' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('srv'), 'opt12');
    await page.keyboard.press('Escape');
    await page.locator('[data-window]').waitFor({ state: 'detached' });
    passed.push('M-4 a server, PDU, unit, 3D record, rack and cooling row each open their window (Escape closes); ⋯ has Open · Show in 3D · Show on Racks · Delete…');

    // ── M-5 Type = Servers (v1 table) ──
    page = await manage(operator, 'type=server');
    const heads = (await page.locator('[data-list="servers"] thead th').allInnerTexts()).map(t => t.replace(/[↑↓]/g, '').trim().toUpperCase())
      .filter(t => t && t !== 'SELECT' && t !== 'ACTIONS');
    assert.deepEqual(heads, ['SERVER', 'RACK', 'STATE', 'W', 'U', 'OUTLET', 'PDU', 'PDU IP', 'SWITCH', 'OWNER', 'SSH', 'KVM', 'PING', 'SERVER IP']);
    const total = Number((await page.locator('.manage-meta').innerText()).match(/(\d+) \/ (\d+)/)[2]);
    const count = async () => Number((await page.locator('.manage-meta').innerText()).match(/(\d+) \/ \d+/)[1]);
    assert.equal(await count(), total);
    await page.getByLabel('Power state').selectOption('off');
    const offRows = await page.locator('[data-list="servers"] tbody tr').evaluateAll(trs => trs.map(tr => tr.children[3].innerText.trim()));
    assert.ok(offRows.length > 0 && offRows.every(s => s === 'off'), `state filter: ${offRows}`);
    assert.equal(await count(), offRows.length);
    await page.getByLabel('Power state').selectOption('all');
    await page.locator('[data-list="servers"] thead').getByRole('button', { name: 'W', exact: true }).click();
    const watts = await page.locator('[data-list="servers"] tbody tr').evaluateAll(trs => trs.map(tr => tr.children[4].innerText.trim()).filter(t => t !== '—').map(Number));
    assert.deepEqual(watts, [...watts].sort((a, b) => a - b), 'sorted by W');
    await page.locator('[data-list="servers"] thead').getByRole('button', { name: 'W', exact: true }).click();
    const down = await page.locator('[data-list="servers"] tbody tr').evaluateAll(trs => trs.map(tr => tr.children[4].innerText.trim()).filter(t => t !== '—').map(Number));
    assert.deepEqual(down, [...down].sort((a, b) => b - a), 'a second click sorts the other way');
    await page.getByLabel('Search everything').fill('SW-01');
    await page.waitForFunction(() => document.querySelectorAll('[data-list="servers"] tbody tr').length === 1);
    assert.deepEqual(await shownUids(page), ['server:opt11'], 'search by switch');
    await page.getByLabel('Search everything').fill('alice');
    await page.waitForFunction(() => document.querySelectorAll('[data-list="servers"] tbody tr').length === 1);
    assert.deepEqual(await shownUids(page), ['server:opt53'], 'search by owner');
    assert.equal(new URL(page.url()).searchParams.get('q'), 'alice', 'the search is in the address');
    // coverage filters: the same counts as Admin › Connections (the servers that are not removed)
    const { filterConnections } = await mod('api/serversList.js');
    const removedKeys = new Set((await json(operator, '/api/removed-servers')).hidden);
    const conn = (await json(operator, '/api/devices/connections')).servers.filter(s => !removedKeys.has(s.key));
    for (const id of ['missing-kvm', 'missing-pdu', 'single-feed']) {
      page = await manage(operator, `type=server&show=${id}`);
      const mine = (await shownUids(page)).length;
      assert.equal(mine, filterConnections(conn, { connection: id }).length, `${id}: Manage ${mine} = Connections`);
    }
    passed.push(`M-5 Type = Servers: State, W, U, Outlet, PDU, PDU IP, Switch, Owner, SSH, KVM, Ping, Server IP; state filter, W sort both ways, search (switch, owner; q= in the address), "rows / ${total}"; missing-kvm, missing-pdu and single-feed equal Connections`);

    // ── M-6 free ports and unplaced ──
    page = await manage(operator, 'show=free-ports');
    // the free ports /locations reports now (KVM port names come from the KVMs' last read, so they change as they are read)
    const emptyPorts = (await json(operator, '/api/devices/locations')).empty_ports;
    const freeBy = new Map();
    for (const [kind, list] of Object.entries(emptyPorts)) for (const p of list) freeBy.set(p.device_id, { kind, name: p.device_name, ports: [...(freeBy.get(p.device_id)?.ports || []), p.port] });
    assert.ok(freeBy.has('pdu5'), 'PDU 05 outlet 2 (Spare) is free');
    await page.waitForFunction(n => document.querySelectorAll('[data-list="free-ports"] [data-uid]').length === n, freeBy.size, { timeout: 15000 });
    for (const [id, f] of freeBy) {
      const line = (await page.locator(`[data-list="free-ports"] [data-uid="dev:${id}"]`).innerText()).replace(/\s+/g, ' ');
      const noun = f.kind === 'pdu' ? (f.ports.length === 1 ? 'outlet' : 'outlets') : (f.ports.length === 1 ? 'port' : 'ports');
      assert.ok(line.includes(f.name) && line.includes(`${f.ports.length} free ${noun}: ${f.ports.join(', ')}`), `${id}: ${line}`);
    }
    const kvmFree = [...freeBy].find(([, f]) => f.kind === 'kvm')?.[0] || 'pdu5';
    await page.locator(`[data-list="free-ports"] [data-uid="dev:${kvmFree}"] .manage-name`).click();
    await page.locator('[data-window]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('open'), `dev:${kvmFree}`);
    await page.keyboard.press('Escape');
    page = await manage(operator, 'type=server&show=unplaced');
    assert.deepEqual((await shownUids(page)).sort(), ['server:opt96', 'server:optn85']);
    assert.equal(await page.getByLabel('More filters').inputValue(), 'no-location', 'unplaced is the No location filter');
    passed.push(`M-6 show=free-ports lists every device with free ports exactly as /locations reports them (${[...freeBy].map(([, f]) => `${f.name}: ${f.ports.join(', ')}`).join('; ')}) and opens the device window; show=unplaced (v1 alias) lists opt96 and optn85`);

    // ── M-7 roles ──
    page = await manage(viewer);
    assert.equal(await page.locator('input[data-select]').count(), 0, 'a Viewer has no checkboxes');
    assert.equal(await page.locator('[data-action="add"]').count(), 0, 'no + Add');
    assert.equal(await chip(page, 'deleted').count(), 0, 'no Deleted');
    assert.equal(await page.getByRole('button', { name: 'Export CSV' }).count(), 0, 'no CSV');
    const viewerAddress = await rowOf(page, 'server:opt11').locator('td').nth(6).innerText();
    assert.equal(viewerAddress.trim(), '—', 'no server address for a Viewer');
    assert.equal((await rowOf(page, 'dev:pdu1').locator('td').nth(6).innerText()).trim(), '192.0.2.1', 'device addresses stay (as Dashboard)');
    page = await manage(viewer, 'type=server');
    const viewerHeads = await page.locator('[data-list="servers"] thead th').allInnerTexts();
    assert.ok(!viewerHeads.some(h => /SERVER IP|SSH/.test(h)), `no Server IP or SSH: ${viewerHeads}`);
    page = await manage(viewer, 'show=deleted');
    assert.equal(await page.locator('[data-view="deleted"]').count(), 0, 'a Viewer has no Deleted view');
    page = await manage(operator);
    assert.equal(await page.getByRole('button', { name: 'Export CSV' }).isEnabled(), true, 'an Operator has CSV');
    assert.equal(await rowOf(page, 'server:opt11').locator('input[data-select]').isDisabled(), true, 'an Operator cannot select a server (Admin only)');
    assert.equal(await rowOf(page, 'unit:u-tray53').locator('input[data-select]').isDisabled(), false, 'but can select a unit');
    await page.locator('[data-action="add"]').click();
    assert.deepEqual(await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem').allTextContents(), ['Server…', 'Unit…'], 'Operator: Server… and Unit…');
    await page.keyboard.press('Escape');
    page = await manage(admin);
    await page.locator('[data-action="add"]').click();
    assert.deepEqual(await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem').allTextContents(), ['Server…', 'Unit…', 'PDU…', 'KVM…', 'Rack…'], 'Admin: everything, Server… first');
    await page.keyboard.press('Escape');
    passed.push('M-7 Viewer: no checkboxes, no server address (device addresses stay), no Server IP / SSH, no CSV, no + Add, no Deleted; Operator: CSV, + Add › Server…, Unit…, units selectable, servers "Admin only"; Admin: + Add › Server…, Unit…, PDU…, KVM…, Rack…');

    // ── M-8 the Edit-mode owner select writes every key ──
    page = await manage(operator, 'type=server');
    await page.locator('button.edit-toggle').click();
    const select = page.getByLabel('Owner for OPT53', { exact: true });
    await select.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => { const s = document.querySelector('select[aria-label="Owner for OPT53"]'); return s && !s.disabled && s.options.length > 2; }, null, { timeout: 15000 });
    const option = await select.locator('option').evaluateAll(os => os.map(o => [o.value, o.textContent]).find(([v]) => v && v !== '__current__'));
    const puts = [];
    page.on('request', r => { if (r.method() === 'PUT' && r.url().includes('/api/opt-owners')) puts.push(decodeURIComponent(new URL(r.url()).pathname)); });
    await select.selectOption(option[0]);
    for (let i = 0; i < 50 && puts.length < 3; i++) await sleep(100);
    assert.deepEqual(puts, ['/api/opt-owners/opt53', '/api/opt-owners/opt53 (psu1)', '/api/opt-owners/opt53 (psu2)'], 'one PUT per key, never the unkeyed map');
    await sleep(500);
    const owners = await json(operator, '/api/opt-owners');
    for (const key of ['opt53', 'opt53 (psu1)', 'opt53 (psu2)']) assert.equal(owners[key], option[1].trim(), `${key} has the new owner`);
    await page.locator('button.edit-toggle').click();
    passed.push(`M-8 Edit mode: the owner select of OPT53 writes "${option[1].trim()}" under opt53, opt53 (psu1) and opt53 (psu2) (three keyed PUTs)`);

    // ── M-9 live: another context moves a server ──
    page = await manage(viewer, 'type=server');
    const uOf = key => page.locator(`[data-server="${key}"] td`).nth(4).innerText();
    assert.equal((await uOf('opt41')).trim(), 'U1');
    const move = { server: 'opt41', target_server: 'opt42', target_ports: null, target_rack: null, target_slot: null, swap: true, units_follow: true };
    const preview = await (await admin.context.request.post(origin + '/api/devices/move-server', { headers: { 'x-dcim-csrf': admin.csrf }, data: { ...move, dry_run: true } })).json();
    const t0 = Date.now();
    const applied = await admin.context.request.post(origin + '/api/devices/move-server', { headers: { 'x-dcim-csrf': admin.csrf },
      data: { ...move, dry_run: false, ...(preview.plan_revision ? { plan_revision: preview.plan_revision } : {}) } });
    assert.equal(applied.status(), 200, await applied.text());
    await page.waitForFunction(() => document.querySelector('[data-server="opt41"]')?.children[4]?.innerText.trim() === 'U2', null, { timeout: LIVE_MS });
    passed.push(`M-9 another context swaps OPT41 and OPT42 (move-server); the Viewer's table shows OPT41 on U2 in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    // ── M-10 Admin bulk delete of five; the TV and the twin follow; Deleted › Restore ──
    const tv = viewer.page;
    await tv.goto(origin + '/?tab=display');
    await tv.locator('[data-testid="kpi-pdus"]').waitFor({ timeout: 30000 });
    await sleep(1500);
    const tvHad = (await tv.locator('body').innerText()).toLowerCase().includes('optn85');
    const twin = await admin.context.newPage();
    twin.on('pageerror', e => errors.push(`twin: ${e.message}`));
    await twin.goto(origin + '/twin/');
    await twin.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.model?.items?.length, null, { timeout: 60000 });
    const FIVE = ['twin:ITEM-0044', 'twin:ITEM-0045', 'twin:ITEM-0049', 'twin:ITEM-0051', 'server:optn85'];
    const TWIN_IDS = ['ITEM-0044', 'ITEM-0045', 'ITEM-0049', 'ITEM-0051'];
    // the records the open twin draws now (it leaves out a 3D unit whose shelf holds a Lab Manager unit, such as SSD SA)
    const DRAWN = await twin.evaluate(ids => ids.filter(id => window.__twin.S.model.items.some(i => i.id === id)), TWIN_IDS);
    for (const id of ['ITEM-0044', 'ITEM-0045', 'ITEM-0049']) assert.ok(DRAWN.includes(id), `the twin has ${id}`);
    page = await manage(admin, 'show=not-in-lm');
    for (const uid of FIVE) await rowOf(page, uid).locator('input[data-select]').check();
    assert.match(await page.locator('[data-bulk]').innerText(), /5\s+selected/);
    await page.locator('[data-action="bulk-delete"]').click();
    const dlg = page.locator('[data-dialog="delete"]');
    await page.waitForFunction(() => { const d = document.querySelector('[data-dialog="delete"]'); return d && d.getAttribute('aria-busy') === 'false' && d.querySelector('[data-list="items"]'); }, null, { timeout: 30000 });
    assert.equal(await dlg.locator('[data-list="items"] input[type="checkbox"]:checked').count(), 5, 'all five ticked (no signs of life)');
    assert.equal((await dlg.locator('label[for="lab-delete-confirm"]').innerText()).trim(), 'Type 5 to delete 5 items');
    await dlg.locator('#lab-delete-confirm').fill('5');
    await dlg.locator('[data-action="delete"]').click();
    const t1 = Date.now();
    await page.locator('.lab-toast', { hasText: 'Deleted 5 items' }).waitFor({ timeout: 15000 });
    await page.waitForFunction(uids => uids.every(uid => !document.querySelector(`[data-uid="${uid}"]`)), FIVE, { timeout: LIVE_MS });
    const manageSeconds = (Date.now() - t1) / 1000;
    const other = await manage(operator, 'show=not-in-lm');
    for (const uid of FIVE) assert.equal(await rowOf(other, uid).count(), 0, `${uid} is gone for another account too`);
    let tvText = 'TV: never listed optn85';
    if (tvHad) {
      await tv.waitForFunction(() => !document.body.innerText.toLowerCase().includes('optn85'), null, { timeout: LIVE_MS });
      tvText = `TV dropped optn85 in ${((Date.now() - t1) / 1000).toFixed(1)} s`;
    }
    let twinText;
    try {
      await twin.waitForFunction(ids => ids.every(id => !window.__twin.S.model.items.some(i => i.id === id)), DRAWN, { timeout: LIVE_MS });
      twinText = `the open twin dropped them in ${((Date.now() - t1) / 1000).toFixed(1)} s`;
    } catch {
      await twin.reload();
      await twin.waitForFunction(() => window.__twin?.S.model?.items?.length, null, { timeout: 60000 });
      assert.equal(await twin.evaluate(ids => ids.some(id => window.__twin.S.model.items.some(i => i.id === id)), TWIN_IDS), false, 'a reloaded twin has none of them');
      twinText = 'the open twin did not drop them live (lab-twin live re-read is WP-7); a reloaded twin has none';
      notes.push('M-10: the 3D twin page does not drop deleted records live yet (WP-7, lab-twin/app.js); after a reload it does.');
    }
    const ids = new Set(((await json(admin, '/api/twin-data')).items || []).map(i => i.id));
    assert.ok(TWIN_IDS.every(id => !ids.has(id)), 'gone from lab-data.json');
    // Deleted › Restore
    page = await manage(admin, 'show=deleted');
    const batchRow = page.locator('[data-list="deleted"] [data-batch]').filter({ hasText: 'optn85' }).first();
    await batchRow.waitFor({ timeout: 15000 });
    const entries = await batchRow.locator('[data-entry]').evaluateAll(els => els.map(e => e.dataset.entry).sort());
    assert.deepEqual(entries, ['server:optn85', 'twin:ITEM-0044', 'twin:ITEM-0045', 'twin:ITEM-0049', 'twin:ITEM-0051']);
    assert.match(await batchRow.innerText(), /Restorable/);
    await batchRow.locator('[data-action="restore-batch"]').click();
    await page.locator('.manage-note', { hasText: 'Restored 5 items.' }).waitFor({ timeout: 15000 });
    page = await manage(admin, 'show=not-in-lm');
    await page.waitForFunction(uids => uids.every(uid => document.querySelector(`[data-uid="${uid}"]`)), FIVE, { timeout: LIVE_MS });
    const back = new Set(((await json(admin, '/api/twin-data')).items || []).map(i => i.id));
    assert.ok(TWIN_IDS.every(id => back.has(id)), 'the 3D records are back');
    await twin.close();
    passed.push(`M-10 Admin selects the cart, the ladder, Opt207 (JSON opt), SSD SA (JSON equip) and optn85; "Type 5 to delete 5 items"; gone from Manage in ${manageSeconds.toFixed(1)} s and for another account; ${tvText}; ${twinText}; show=deleted lists the batch's 5 entries; Restore batch brings them back`);

    // ── M-11 the servers removed before this release ──
    page = await manage(admin, 'show=deleted');
    const legacy = page.locator('[data-list="removed-servers"]');
    await legacy.waitFor({ timeout: 15000 });
    const legacyText = await legacy.innerText();
    for (const part of ['OPT74', 'OPT98', 'Fixture: the machine left the lab', 'PDU 07 outlet 4']) assert.ok(legacyText.includes(part), `legacy list shows ${part}`);
    assert.ok((await page.locator('[data-list="removed-servers-log"]').innerText()).includes('OPT74'), 'and the log');
    await legacy.getByRole('button', { name: 'OPT74', exact: true }).click();
    await page.locator('[data-window="server"] h2', { hasText: 'OPT74' }).waitFor({ timeout: 15000 });
    await page.keyboard.press('Escape');
    page = await manage(operator, 'show=deleted');
    await page.locator('[data-view="deleted"]').waitFor();
    assert.equal(await page.locator('[data-list="removed-servers"] button', { hasText: 'Restore' }).count(), 0, 'an Operator cannot restore a removed server');
    passed.push('M-11 show=deleted: OPT74 and OPT98 (removed before this release) with when, by, reason, labels and the log; OPT74 opens its window; Operators see no Restore there');

    // ── M-12 + Add › Server… on Rack-05; its window opens ──
    page = await manage(admin);
    await page.locator('[data-action="add"]').click();
    await page.getByRole('menuitem', { name: 'Server…' }).click();
    const add = page.locator('[data-dialog="add-server"]');
    await add.waitFor();
    assert.equal((await add.locator('h2').innerText()).trim(), 'Add server', 'no rack chosen');
    await add.getByLabel('Rack', { exact: true }).selectOption('Rack-05');
    await add.getByLabel('Server name', { exact: true }).fill('OPT58');
    await add.locator('[data-action="add-server-save"]').click();
    await add.waitFor({ state: 'detached', timeout: 15000 });
    await page.locator('[data-window="server"] h2', { hasText: 'OPT58' }).waitFor({ timeout: 15000 });
    assert.equal(new URL(page.url()).searchParams.get('srv'), 'opt58');
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'inventory', 'over the Manage page');
    await page.locator('[data-window="server"] [data-facts]', { hasText: 'Rack-05 · floor 2' }).waitFor({ timeout: 15000 });
    await page.keyboard.press('Escape');
    await rowOf(page, 'server:opt58').waitFor({ timeout: LIVE_MS });
    passed.push('M-12 + Add › Server… (no rack chosen) › Rack-05 › OPT58 › Add server: the window of OPT58 opens over Manage (Rack-05 · floor 2), and Manage lists it');

    // ── M-13 no horizontal page scroll ──
    for (const width of [1440, 1280, 1024, 390, 375]) {
      await admin.page.setViewportSize({ width, height: 900 });
      for (const q of ['', 'type=server', 'show=deleted', 'show=not-in-lm']) {
        page = await manage(admin, q);
        await sleep(200);
        assert.equal(await noHScroll(page), true, `no horizontal scroll at ${width} px (${q || 'All'})`);
      }
    }
    passed.push('M-13 no horizontal page scroll at 1440, 1280, 1024, 390 and 375 px (All, Servers, Deleted, not-in-lm)');

    assert.deepEqual(errors, [], 'no page errors or native dialogs');
    console.log(passed.map(p => `PASS ${p}`).join('\n'));
    if (notes.length) console.log(notes.map(n => `NOTE ${n}`).join('\n'));
    console.log(`manage.cjs: ${passed.length} checks passed`);
    await browser.close();
  } catch (e) {
    console.log(passed.map(p => `PASS ${p}`).join('\n'));
    console.error(e);
    if (errors.length) console.error(errors.join('\n'));
    await browser.close();
    process.exit(1);
  }
})();
