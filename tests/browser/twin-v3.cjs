// Lab Twin v3 (redesign) acceptance check — isolated fixture only: DCIM_TEST_ACCOUNTS=1 tests/browser/preview-server.py.
// Covers at 1440×900 (Operator, Viewer) and 390×844 (Operator): the 48 px top bar ("/" search, view switch, Layers,
// Color by, live age, issues badge, More menu), the rack bar, Issues / Racks / Data quality panel, health colours,
// rack labels and legend, injected maintenance / ping / offline states, the rack front view, the server drawer, the
// power confirmation (alertdialog, exact PDU / outlet, Cancel focused, Escape), and the phone bottom sheet with
// 44 px targets and no horizontal overflow. Read-only: every non-GET request except the sign-in is aborted and
// reported; injected states live only in the page. Screenshots go to DCIM_QA_SHOTS (default C:/t/tv3-after).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const shots = process.env.DCIM_QA_SHOTS || 'C:/t/tv3-after';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [], errors = [], writes = [];
  const pass = m => { checks.push(m); if (process.env.DCIM_QA_VERBOSE) console.error('ok: ' + m); };
  const shot = (page, name) => page.screenshot({ path: path.join(shots, name) });
  async function open(user, [width, height], url = '/twin/') {
    const phone = width < 500;
    const ctx = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
    await ctx.route('**/*', route => {
      const req = route.request(); if (!req.url().startsWith(origin + '/')) return route.abort();
      const p = new URL(req.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && p !== '/api/auth/login') { writes.push(`${user} ${req.method()} ${p}`); return route.abort(); }
      return route.continue();
    });
    assert.equal((await ctx.request.post(origin + '/api/auth/login', { data: { username: user, password: 'test-password-123' } })).status(), 200);
    assert.equal((await (await ctx.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    await ctx.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* ignore */ } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${user} ${width}px: ${e.message}`));
    page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
    await page.goto(origin + url);
    if (url.startsWith('/twin/')) {
      await page.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.recs.size > 10 && window.__twin.S.live.pdu.pdu1 && window.__twin.S.live.updatedAt, null, { timeout: 60000 });
      await page.waitForTimeout(1200);
    }
    return { ctx, page };
  }
  const idle = page => page.waitForFunction(() => !__twin.S.tween, null, { timeout: 8000 });
  const visible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);
  // visible interactive controls outside the 3D labels that are smaller than 44 × 44 px
  const smallTargets = page => page.evaluate(() => {
    const sel = 'button, [role="button"], [role="tab"], [role^="menuitem"], [role="radio"], [role="option"], input:not([type="hidden"]), select, summary, textarea';
    return [...document.querySelectorAll(sel)].filter(e => {
      if (e.closest('#labels') || e.closest('.hidden')) return false;
      const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false;
      const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      for (let p = e.parentElement; p; p = p.parentElement) { const ps = getComputedStyle(p); if (ps.visibility === 'hidden' || ps.display === 'none') return false; }
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
      if (e.type === 'checkbox') return false;
      return r.width < 43.5 || r.height < 43.5;
    }).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${[...e.classList].join('.')} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`);
  });
  try {
    // ───────────────────────────── desktop 1440 × 900, Operator
    const { ctx, page } = await open('operator', [1440, 900]);
    await page.evaluate(() => { clearInterval(__twin.S.live.timer); __twin.S.live.timer = null; });   // no 15 s refresh in the middle of a check
    await shot(page, 'desktop-1-overview.png');

    // top bar
    const hdr = await page.evaluate(() => ({ h: document.querySelector('.hdr').getBoundingClientRect().height, brand: document.querySelector('#btnHome').innerText.trim(), ph: document.querySelector('#search').placeholder, edit: document.querySelector('#btnEdit').innerText.trim(), live: document.querySelector('#liveText').textContent, issues: document.querySelector('#issuesBadge').textContent, issuesCls: document.querySelector('#issuesBadge').className }));
    assert.equal(hdr.h, 48, 'header is 48 px'); assert.equal(hdr.brand, 'Lab Twin'); assert.equal(hdr.ph, 'Search racks, devices, owners… (/)'); assert.equal(hdr.edit, 'Edit layout');
    assert.match(hdr.live, /^Live · updated \d+ s ago$/, 'live badge shows the age of the last refresh');
    assert.equal(hdr.issues, '1 critical', 'issues badge counts lab issues only'); assert.match(hdr.issuesCls, /\bcrit\b/);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('/'); assert.equal(await page.evaluate(() => document.activeElement.id), 'search', '"/" focuses the search');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    pass('top bar: 48 px, Lab Twin, "/" search, Live · updated n s ago, 1 critical, Edit layout');

    // view switch: one checked radio per preset; dragging the camera leaves every preset
    for (const [id, view] of [['#vTop', 'top'], ['#vEye', 'eye'], ['#vOrbit', 'orbit']]) {
      await page.locator(id).click(); await idle(page);
      const r = await page.evaluate(() => ({ view: __twin.S.view, checked: [...document.querySelectorAll('#viewSeg [role="radio"]')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.id) }));
      assert.equal(r.view, view); assert.deepEqual(r.checked, [id.slice(1)]);
    }
    const cv = await page.locator('#c').boundingBox();
    await page.mouse.move(cv.x + cv.width * .6, cv.y + cv.height * .6); await page.mouse.down(); await page.mouse.move(cv.x + cv.width * .7, cv.y + cv.height * .62, { steps: 8 }); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#viewSeg [aria-checked="true"]')].length), 0, 'an orbit drag leaves every preset');
    assert.equal((await page.locator('#crumbPath').innerText()).replace(/\s+/g, ' '), 'Lab › 3D view', 'breadcrumb after a free camera move');
    await page.locator('#btnHome').click(); await idle(page); assert.equal(await page.evaluate(() => __twin.S.view), 'orbit', 'the brand returns to the overview');
    assert.match((await page.locator('#crumbPath').innerText()).replace(/\s+/g, ' '), /^Lab › Overview$/);
    pass('view switch: Overview / Rack front / Aisle / Top radios, drag unchecks, brand → Overview, breadcrumb Lab › Overview');

    // Layers popover: toggles + filters reachable, Escape closes and returns focus
    await page.locator('#btnLayers').click();
    assert.equal(await visible(page, '#layersPanel'), true); assert.equal(await page.locator('#btnLayers').getAttribute('aria-expanded'), 'true');
    for (const id of ['#tWalls', '#tZones', '#tLabels', '#tHeat', '#tPower', '#tEnv', '#fZone', '#fSetup', '#fOnlyLow', '#fClear']) assert.equal(await visible(page, id), true, id + ' in Layers');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#layersPanel')), true, 'Tab stays in the popover');
    await page.keyboard.press('Escape'); assert.equal(await visible(page, '#layersPanel'), false); assert.equal(await page.evaluate(() => document.activeElement.id), 'btnLayers');
    // power on labels
    await page.locator('#btnLayers').click(); await page.locator('#tPower').click(); assert.equal(await page.evaluate(() => document.body.classList.contains('show-power')), true);
    await page.locator('#tPower').click(); await page.keyboard.press('Escape');
    pass('Layers: walls / zones / labels / heat / power / environment and filters in a popover; Escape closes and refocuses');

    // health model + labels + legend
    const health = await page.evaluate(() => {
      const t = __twin, lbl = t.S.recs.get('SETUP-007').label;
      const sw = [...document.querySelectorAll('#legend .li')].map(li => ({ t: li.textContent.trim(), bg: getComputedStyle(li.querySelector('.sw')).backgroundColor, border: getComputedStyle(li.querySelector('.sw')).borderTopStyle }));
      return { r7: t.rackHealth(t.S.model.setups.find(s => s.id === 'SETUP-007')).h, label: lbl.querySelector('.ln').textContent + lbl.querySelector('.ls').textContent, cls: lbl.className, legend: sw, legendTitle: document.querySelector('#legend .lg-t').textContent };
    });
    assert.equal(health.r7, 'down'); assert.equal(health.label, 'Rack-07 · PDU offline'); assert.match(health.cls, /\bh-down\b/);
    assert.equal(health.legendTitle, 'Health');
    assert.deepEqual(health.legend.map(l => l.t), ['Up', 'Down', 'Unknown', 'Maintenance', 'Selected']);
    assert.equal(health.legend[0].bg, 'rgb(74, 222, 128)'); assert.equal(health.legend[1].bg, 'rgb(248, 113, 113)'); assert.equal(health.legend[2].border, 'dashed'); assert.equal(health.legend[3].bg, 'rgb(192, 132, 252)');
    pass('health: Rack-07 down with label "Rack-07 · PDU offline" (h-down); legend Up / Down / Unknown (dashed) / Maintenance / Selected in the health colours');

    // rack bar
    const bar = await page.evaluate(() => [...document.querySelectorAll('#rackBar [data-jump]')].map(b => ({ id: b.dataset.jump, text: b.textContent.trim(), cls: b.className })));
    const r7 = bar.find(b => b.id === 'SETUP-007'); assert.equal(r7.text, 'Rack-07 · 1'); assert.match(r7.cls, /\bcrit\b/);
    assert.deepEqual(bar.filter(b => b.id !== 'SETUP-007' && /·/.test(b.text)), [], 'no other chip carries a count (data quality never counts)');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#rackBar .rb-row')].map(e => e.textContent)), ['Left rack row', 'Back wall', 'Right rack row', 'Storage'], 'rows come from the zones in lab-data.json');
    pass('rack bar: rows from lab-data.json zones, Rack-07 · 1 in red, no data-quality counts');

    // colour by lifecycle and back
    const capBefore = await page.evaluate(() => '#' + __twin.S.recs.get('SETUP-001').cap.material.color.getHexString());
    await page.locator('#btnColorBy').click(); await page.locator('#colorMenu [data-color="status"]').click();
    const st = await page.evaluate(() => ({ cap: '#' + __twin.S.recs.get('SETUP-001').cap.material.color.getHexString(), legend: document.querySelector('#legend .lg-t').textContent, btn: document.querySelector('#btnColorBy').textContent, cls: document.body.classList.contains('color-status') }));
    assert.equal(capBefore, '#4ade80'); assert.notEqual(st.cap, capBefore, 'rack caps follow the colouring'); assert.equal(st.legend, 'Lifecycle'); assert.equal(st.btn, 'Color by: Lifecycle'); assert.equal(st.cls, true);
    await page.locator('#btnColorBy').click(); await page.locator('#colorMenu [data-color="health"]').click();
    assert.equal(await page.evaluate(() => '#' + __twin.S.recs.get('SETUP-001').cap.material.color.getHexString()), '#4ade80');
    pass('Color by: Lifecycle repaints rack caps and the legend; Health restores them');

    // Issues panel and Data quality
    const cards = await page.evaluate(() => [...document.querySelectorAll('#attn .attn-row')].map(c => ({ ey: c.querySelector('.ey').textContent, tt: c.querySelector('.tt').textContent, sub: c.querySelector('.sub')?.innerText || '', title: c.title, tag: c.tagName })));
    assert.equal(cards.length, 1, 'the fixture has one lab issue'); assert.equal(cards[0].tt, 'PDU 07 unreachable'); assert.match(cards[0].sub, /^Rack-07 · power state of \d+ servers? unknown/);
    assert.match(cards[0].ey, /^Critical · /); assert.match(cards[0].title, /^First noticed by this page at \d\d:\d\d$/); assert.equal(cards[0].tag, 'BUTTON');
    const dq = await page.evaluate(() => ({ n: __twin.S.attention.filter(e => e.group === 'dq').length, foot: document.querySelector('#dqFooter').innerText.replace(/\s+/g, ' ').trim() }));
    assert.ok(dq.n > 0); assert.equal(dq.foot, `Data quality: ${dq.n} items Review`);
    await page.locator('#attn .attn-row').first().click();
    assert.equal(await page.evaluate(() => __twin.S.selected), 'LIVE-pdu7'); assert.equal(await page.evaluate(() => !!__twin.S.tween), true, 'flies to the problem');
    await idle(page);
    await page.locator('#dqFooter').click(); assert.equal(await visible(page, '#dqPanel'), true); assert.equal(await page.locator('#dqList .attn-row').count(), dq.n);
    await page.evaluate(() => __twin.showTab('tree')); assert.equal(await visible(page, '#tree'), true);
    await page.evaluate(() => __twin.showTab('unplaced')); assert.equal(await visible(page, '#unplaced'), true);
    await page.evaluate(() => __twin.showTab('attn'));
    pass(`issues: one card "PDU 07 unreachable" (Rack-07 · power state …) flies to LIVE-pdu7; Data quality: ${dq.n} items in its own tab`);

    // injected states (page only): maintenance on PDU 03, a server not answering ping, then back
    const inj = await page.evaluate(() => {
      const t = __twin, S = t.S; const saveM = S.live.maintenance, saveP = S.live.ping;
      S.live.maintenance = { pdus: { pdu3: { started_at: Date.now() / 1000 - 600, started_by: 'qa', reason: 'qa', outlets_off: [1, 2, 3, 4], failed: [] } } };
      S.live.ping = { ...(S.live.ping || {}), opt12: { status: 'down', rtt: null, checkedAt: new Date().toISOString(), lastUpAt: null } };
      t.computeModel(); t.buildItems({ refresh: true });
      const r3 = t.rackHealth(S.model.setups.find(s => s.id === 'SETUP-003'));
      const it12 = S.model.items.find(i => i.id === 'LIVE-opt12'); const h12 = t.itemHealth(it12);
      const issues = [...document.querySelectorAll('#attn .attn-row')].map(c => c.querySelector('.tt').textContent + ' | ' + c.querySelector('.ey').textContent + ' | ' + (c.querySelector('.sub')?.innerText || ''));
      const label3 = S.recs.get('SETUP-003').label; const out = { r3: r3.h, h12: h12, issues, label3: label3.querySelector('.ln').textContent + label3.querySelector('.ls').textContent, cls3: label3.className, badge: document.querySelector('#issuesBadge').textContent };
      S.live.maintenance = saveM; S.live.ping = saveP; t.computeModel(); t.buildItems({ refresh: true });
      return out;
    });
    assert.equal(inj.r3, 'maint'); assert.equal(inj.label3, 'Rack-03 · Maintenance'); assert.match(inj.cls3, /\bh-maint\b/);
    assert.deepEqual(inj.h12, { h: 'down', why: 'No ping' });
    assert.ok(inj.issues.some(s => /^Rack-03 PDU in maintenance \| Warning · since \d\d:\d\d \| 4 outlets kept off · restore from Power$/.test(s)), inj.issues.join('\n'));
    assert.ok(inj.issues.some(s => /^OPT12 not answering ping \| Warning/.test(s)), 'ping-down issue');
    assert.equal(inj.badge, '1 critical · 2 warnings');
    pass('injected: PDU 03 maintenance → Rack-03 maint + "Rack-03 PDU in maintenance · since HH:MM"; OPT12 ping down → down "No ping" + issue; badge 1 critical · 2 warnings');

    // server drawer (OPT11)
    await page.evaluate(() => __twin.select('LIVE-opt11', { keepCamera: true })); await page.waitForTimeout(200);
    const dr = await page.evaluate(() => {
      const cells = Object.fromEntries([...document.querySelectorAll('#dBody .scell')].map(c => [c.querySelector('.sl').textContent, c.querySelector('.sv').textContent]));
      const kvm = document.querySelector('#dBody [data-kvm="kvm1"][data-port="1"]');
      return { name: document.querySelector('#dName').textContent, id: document.querySelector('#dId').textContent, health: document.querySelector('#dHealth').textContent, cells, kvm: kvm && !kvm.disabled, kvmText: kvm?.textContent,
        conn: [...document.querySelectorAll('#dBody .crow')].map(r => r.innerText.replace(/\s*\n\s*/g, ' | ')), loc: document.querySelector('#dBody .loc-row span').textContent, power: document.querySelector('#dBody [data-power-menu]')?.textContent,
        note: document.querySelector('#dBody .act-note')?.textContent, more: [...document.querySelectorAll('#dBody details.more summary')].map(s => s.textContent) };
    });
    assert.equal(dr.name, 'OPT11'); assert.equal(dr.id, 'Server · host opt11'); assert.equal(dr.health, 'Up');
    assert.equal(dr.cells.Owner, 'Fixture owner'); assert.equal(dr.cells.Console, 'Free'); assert.match(dr.cells.Power, /^On · \d+ W$/); assert.ok(dr.cells.Ping);
    assert.equal(dr.kvm, true, 'Open console = the live KVM 01 port 1'); assert.equal(dr.kvmText, 'Open console'); assert.equal(dr.power, 'Power…');
    assert.equal(dr.note, 'Power actions always ask for confirmation and show the exact PDU and outlet.');
    assert.ok(dr.conn.includes('PDU 01 · outlet 1 | On'), dr.conn.join(' / ')); assert.ok(dr.conn.includes('KVM 01 · port 1 | Free'));
    assert.match(dr.loc, /^Rack-01 › Shelf \d › Left$/);
    assert.deepEqual(dr.more.map(s => s.replace(/ · \d+ issues?$/, '')), ['Inventory', 'Data quality', 'Photos & notes']);
    await shot(page, 'desktop-2-server-selected.png');
    pass('drawer: OPT11 Up, Power On · W, Owner Fixture owner, Console Free, Open console (KVM 01 p1), Power…, Rack-01 › Shelf n › Left, PDU 01 · outlet 1 On');

    // power confirmation (alertdialog), opened from the Power… menu; Escape writes nothing
    await page.evaluate(() => __twin.select('LIVE-opt12', { keepCamera: true })); await page.waitForTimeout(150);
    await page.locator('#dBody [data-power-menu]').click();
    assert.equal(await visible(page, '#pwMenu'), true); assert.equal(await page.locator('#dBody [data-power-menu]').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape'); assert.equal(await visible(page, '#pwMenu'), false); assert.equal(await page.evaluate(() => document.activeElement.matches('[data-power-menu]')), true, 'Escape returns to Power…');
    const before = writes.length;
    await page.locator('#dBody [data-power-menu]').click(); await page.locator('#dBody [data-pw="cycle"]').click();
    await page.locator('#confirmModal:not(.hidden)').waitFor();
    const dlg = await page.evaluate(() => { const c = document.querySelector('#confirmModal .modal-card'); return { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), desc: c.getAttribute('aria-describedby'), lab: c.getAttribute('aria-labelledby'), backdropRole: document.querySelector('#confirmModal').getAttribute('role'), title: document.querySelector('#cfTitle').textContent, body: document.querySelector('#cfBody').innerText, active: document.activeElement?.dataset.choice, buttons: [...document.querySelectorAll('#cfActions [data-choice]')].map(b => [b.dataset.choice, b.textContent, b.className]), foot: document.querySelector('#cfFoot').textContent }; });
    assert.equal(dlg.role, 'alertdialog'); assert.equal(dlg.modal, 'true'); assert.equal(dlg.desc, 'cfBody'); assert.equal(dlg.lab, 'cfTitle'); assert.equal(dlg.backdropRole, null);
    assert.equal(dlg.title, 'Power cycle OPT12?'); assert.match(dlg.body, /PDU 01 · outlet 2 · currently On( \(\d+ W\))?\. It turns off, then on again after a few seconds; unsaved work on it is lost\./);
    assert.match(dlg.body, /Server\s+OPT12 · Rack-01 › Shelf \d › Left/); assert.match(dlg.body, /Feeds switched\s+1 of 1/); assert.match(dlg.body, /Console\s+No KVM port mapped|Console\s+Free · nobody is using it|Console\s+In use/);
    assert.equal(dlg.active, 'cancel', 'Cancel has the focus');
    assert.deepEqual(dlg.buttons.map(b => b.slice(0, 2)), [['cancel', 'Cancel'], ['go', 'Power cycle OPT12']]); assert.match(dlg.buttons[1][2], /\bdanger\b/);
    assert.equal(dlg.foot, 'Cancel has the focus. Escape closes without changing anything.');
    await shot(page, 'desktop-3-power-dialog.png');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    assert.equal(await page.locator('#confirmModal:not(.hidden)').count(), 0); assert.equal(writes.length, before, 'Escape sends nothing');
    pass('power: Power… menu (Escape refocuses), alertdialog with aria-describedby=cfBody, "PDU 01 · outlet 2 · currently On", server / feeds / console facts, Cancel focused, Escape closes without a request');

    // rack front view
    await page.evaluate(() => __twin.closeDetail());
    const camBefore = await page.evaluate(() => __twin.camera.position.toArray());
    await page.evaluate(() => __twin.setView('front'));   // no selection → first rack with an issue
    assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-007', 'Rack front opens the rack with an issue');
    const front = id => page.evaluate(id => {
      const t = __twin; t.showRackFront(id); const el = document.querySelector('#rackFront');
      const caps = [...el.querySelectorAll('.rf-cap')].map(e => e.textContent).filter(x => x.startsWith('SHELF'));
      const shelves = [...el.querySelectorAll('.rf-shelf')].map(sh => {
        const sid = sh.dataset.shelf; const tiles = [...sh.querySelectorAll('.rf-tile')].map(b => b.dataset.id).sort();
        const want = [...t.S.recs.values()].filter(r => r.cat === 'item' && r.shelf === sid); const pcs = want.filter(r => r.item.type === 'opt').length;
        return { sid, same: JSON.stringify(tiles) === JSON.stringify(want.map(r => r.id).sort()), free: sh.querySelectorAll('.rf-free').length, wantFree: (pcs ? 0 : 1) + (want.length - pcs ? 0 : 1) };
      });
      return { caps, shelves, head: el.querySelector('.rf-head').innerText.replace(/\s*\n\s*/g, ' | '), label: el.getAttribute('aria-label'), crumb: document.querySelector('#crumbPath').innerText.replace(/\s+/g, ' '), side: getComputedStyle(document.querySelector('.side')).display };
    }, id);
    const f1 = await front('SETUP-001');
    assert.deepEqual(f1.caps, ['SHELF 1 (TOP)', 'SHELF 2', 'SHELF 3', 'SHELF 4 (BOTTOM)']); assert.equal(f1.label, 'Rack-01 front view'); assert.equal(f1.side, 'none');
    assert.ok(f1.shelves.every(s => s.same), 'every tile is an object on that shelf'); assert.ok(f1.shelves.every(s => s.free === s.wantFree), 'Free = empty slots');
    assert.match(f1.head, /^Rack-01 \| ≥?\d+\.\d\d kW · \d+\/\d+ on$/); assert.equal(f1.crumb, 'Lab › Left rack row › Rack-01');
    const f5 = await front('SETUP-005'); assert.deepEqual(f5.caps, ['SHELF 1 (TOP)', 'SHELF 2', 'SHELF 3 (BOTTOM)']);
    await front('SETUP-001'); await page.locator('#rfNext').click(); assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-002');
    await page.keyboard.press(']'); assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-003');
    await page.keyboard.press('['); assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-002');
    const tile = page.locator('#rackFront .rf-tile').first(); const tileId = await tile.getAttribute('data-id'); await tile.click();
    assert.equal(await page.evaluate(() => __twin.S.selected), tileId); assert.deepEqual(await page.evaluate(() => __twin.camera.position.toArray()), camBefore, 'a tile opens the drawer without moving the camera');
    assert.equal(await page.locator('#rackFront .rf-tile.sel').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => __twin.showRackFront('SETUP-001')); await page.waitForTimeout(100);
    await page.evaluate(() => __twin.select('LIVE-opt11', { keepCamera: true }));
    await shot(page, 'desktop-6-rack-front.png');
    await page.locator('#rackFront .rf-tile.sel').focus(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => __twin.S.selected), null, 'Escape closes the drawer first'); assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-001');
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => __twin.S.front), null, 'then returns to the overview');
    pass('rack front: Rack-01 4 shelves SHELF 1 (TOP)…SHELF 4 (BOTTOM), Rack-05 3, tiles = shelf objects, Free = empty slots, Next / ] / [ , tile click keeps the camera, Escape twice');

    // Rack-07 selected (for the side-by-side screenshot) and the More menu
    await page.evaluate(() => __twin.select('SETUP-007', { fly: true })); await idle(page); await page.waitForTimeout(300);
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('#rackBar button.on')).backgroundColor), /^rgb\(/);
    await shot(page, 'desktop-4-rack07-selected.png');
    await page.locator('#btnMore').click();
    const more = await page.evaluate(() => [...document.querySelectorAll('#moreMenu [role="menuitem"]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()));
    assert.deepEqual(more, ['Lab screen mode', '2D floor plan', 'Export layout (JSON)', 'Backend connection…', 'Mouse & keyboard help']);
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Lab screen mode'); await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '2D floor plan');
    await page.keyboard.press('Escape'); assert.equal(await visible(page, '#moreMenu'), false); assert.equal(await page.evaluate(() => document.activeElement.id), 'btnMore');
    await page.locator('#btnMore').click(); await page.locator('#btnHelp').click(); await page.locator('#confirmModal:not(.hidden)').waitFor();
    assert.equal(await page.locator('#cfTitle').innerText(), 'Mouse & keyboard help'); await page.keyboard.press('Escape');
    pass('More: Lab screen mode, 2D floor plan, Export layout (JSON), Backend connection…, Mouse & keyboard help; arrow keys; Escape refocuses More');

    // offline: every rack and server is unknown, the issues badge disappears
    const off = await page.evaluate(() => { const t = __twin; t.disconnect(); return { racks: t.S.model.setups.map(s => t.rackHealth(s).h), opts: t.S.model.items.filter(i => i.type === 'opt').map(i => t.itemHealth(i).h), badgeHidden: document.querySelector('#issuesBadge').classList.contains('hidden'), live: document.querySelector('#liveText').textContent, card: document.querySelector('#attn .attn-row .tt')?.textContent }; });
    assert.ok(off.racks.every(h => h === 'unknown')); assert.ok(off.opts.every(h => h === 'unknown')); assert.equal(off.badgeHidden, true); assert.equal(off.live, 'Offline · static data');
    assert.equal(off.card, 'Live data off — connect the backend');
    pass('offline: all racks / servers unknown, issues badge hidden, "Offline · static data", one "Live data off" card');
    await ctx.close();

    // ───────────────────────────── Viewer 1440 × 900: read-only drawer
    const viewer = await open('viewer', [1440, 900]);
    await viewer.page.evaluate(() => __twin.select('LIVE-opt12', { keepCamera: true }));
    await viewer.page.getByText('Read-only · Power and console need the Operator role.').waitFor();
    assert.equal(await viewer.page.locator('#dBody [data-pw], #dBody [data-kvm], #dBody [data-power-menu]').count(), 0);
    assert.equal(await visible(viewer.page, '#btnEdit'), false, 'no Edit layout for a viewer');
    await viewer.ctx.close();
    pass('viewer: "Read-only · Power and console need the Operator role.", no power / console / edit');

    // ───────────────────────────── phone 390 × 844, Operator
    const phone = await open('operator', [390, 844]);
    const p = phone.page; await p.evaluate(() => { clearInterval(__twin.S.live.timer); __twin.S.live.timer = null; });
    const lay = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.querySelector('.hdr').getBoundingClientRect().height, tabs: [...document.querySelectorAll('[data-sheet]')].map(t => t.textContent.trim()), sheet: getComputedStyle(document.querySelector('#sheet')).position, title: document.querySelector('#sheetTitle').textContent, bar: getComputedStyle(document.querySelector('#rackBar')).display }));
    assert.ok(lay.sw <= lay.iw, `no horizontal overflow (${lay.sw} > ${lay.iw})`); assert.equal(lay.h, 48); assert.deepEqual(lay.tabs, ['Issues', 'Racks', 'Details']); assert.equal(lay.sheet, 'fixed');
    assert.equal(lay.title, '1 critical · PDU 07 unreachable'); assert.equal(lay.bar, 'none');
    await shot(p, 'phone-1-overview.png');
    assert.deepEqual(await smallTargets(p), [], 'phone: every visible control is at least 44 × 44 px (overview)');
    await p.locator('[data-sheet="racks"]').click(); assert.equal(await visible(p, '#tree'), true);
    assert.deepEqual(await smallTargets(p), [], 'phone: 44 px targets (Racks)');
    await p.locator('[data-sheet="issues"]').click();
    await p.locator('#attn .attn-row').first().click(); await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => __twin.S.selected), 'LIVE-pdu7'); assert.equal(await p.locator('[data-sheet="details"]').getAttribute('aria-selected'), 'true');
    await p.evaluate(() => __twin.select('LIVE-opt11', { keepCamera: true })); await p.waitForTimeout(300);
    await shot(p, 'phone-2-server-selected.png');
    assert.deepEqual(await smallTargets(p), [], 'phone: 44 px targets (Details)');
    // the power confirmation fits the phone and keeps Cancel focused
    await p.evaluate(() => __twin.select('LIVE-opt12', { keepCamera: true })); await p.waitForTimeout(150);
    await p.locator('#dBody [data-power-menu]').click(); await p.locator('#dBody [data-pw="off"]').click(); await p.locator('#confirmModal:not(.hidden)').waitFor();
    const card = await p.locator('#confirmModal .modal-card').boundingBox();
    assert.ok(card.x >= 0 && card.x + card.width <= 390.5, `power dialog inside the phone width (${JSON.stringify(card)})`);
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.choice), 'cancel');
    assert.deepEqual(await smallTargets(p), [], 'phone: 44 px targets (power dialog)');
    await shot(p, 'phone-5-power-dialog.png');
    await p.keyboard.press('Escape'); await p.waitForTimeout(150); assert.equal(await p.locator('#confirmModal:not(.hidden)').count(), 0);
    await p.evaluate(() => __twin.select('LIVE-opt11', { keepCamera: true })); await p.waitForTimeout(150);
    await p.locator('#sheetHandle').click(); assert.equal(await p.evaluate(() => __twin.S.sheet.size), 'full');
    await p.waitForTimeout(200); await shot(p, 'phone-3-full.png');
    assert.deepEqual(await smallTargets(p), [], 'phone: 44 px targets (full sheet)');
    await p.locator('#sheetHandle').click(); await p.locator('#sheetHandle').click(); assert.equal(await p.evaluate(() => __twin.S.sheet.size), 'half');
    await p.locator('#btnMore').click(); assert.deepEqual(await smallTargets(p), [], 'phone: 44 px targets (More menu)');
    assert.ok(await p.evaluate(() => [...document.querySelectorAll('#moreMenu [role="menuitem"]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).includes('Fit lab')));
    await p.keyboard.press('Escape');
    await p.locator('#btnSearch').click(); assert.equal(await p.evaluate(() => document.activeElement.id), 'search');
    assert.equal(Math.round((await p.locator('#search').boundingBox()).height), 44); await p.locator('#search').fill('OPT1'); await p.waitForTimeout(150);
    assert.deepEqual(await smallTargets(p), [], 'phone: 44 px targets (search results)'); await p.locator('#search').fill(''); await p.keyboard.press('Escape');
    await p.evaluate(() => __twin.setView('front')); await p.waitForTimeout(200);
    assert.deepEqual(await smallTargets(p), [], 'phone: 44 px targets (rack front)');
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot(p, 'phone-4-rack-front.png');
    await phone.ctx.close();
    pass('phone: 48 px header, no overflow, sheet Issues / Racks / Details, issue tap → Details, 44 px targets in every state, full sheet, search row, rack front');

    // ───────────────────────────── embedded in the React site (?tab=twin)
    const emb = await open('operator', [1440, 900], '/?tab=twin');
    const frame = emb.page.frameLocator('iframe[title="3D Digital Twin"]');
    await frame.locator('#liveText').filter({ hasText: /^Live · updated/ }).waitFor({ timeout: 60000 });
    const embInfo = await frame.locator('body').evaluate(() => ({ embed: document.body.classList.contains('embed'), brand: getComputedStyle(document.querySelector('#btnHome')).display, settings: getComputedStyle(document.querySelector('#btnSettings')).display }));
    assert.deepEqual(embInfo, { embed: true, brand: 'none', settings: 'none' });
    await emb.page.waitForTimeout(1500); await shot(emb.page, 'desktop-5-embed.png');
    await emb.ctx.close();
    pass('embedded (?tab=twin): ?embed=1 hides the brand and Backend connection');

    assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(writes, [], 'no writes');
    console.log(JSON.stringify({ passed: checks, errors, writes }, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
