// Lab Twin v3 (redesign) acceptance check — isolated fixture only: DCIM_TEST_ACCOUNTS=1 tests/browser/preview-server.py.
// Covers at 1440×900 (Operator, Viewer) and 390×844 (Operator): the 48 px top bar ("/" search, view switch, Layers,
// Color by, live age, issues badge, More menu), the rack bar, Issues / Racks / Data quality panel, health colours,
// rack labels and legend, injected maintenance / ping / offline states, the rack front view, the server drawer, the
// power confirmation (alertdialog, exact PDU / outlet, Cancel focused, Escape), and the phone bottom sheet with
// 44 px targets and no horizontal overflow. Review fixes (TV3-FIX): KVM "In use" status, rack front keeps the drawer
// only for its own rack, phone rack front (sheet, toolbar), click without drag keeps the preset, rack framing and
// breadcrumb, two-column shelves, Edit layout drawer, Power… menu, Hebrew text direction, connecting / error states,
// toasts over the 3D view, one-row legend, phone Data quality, rack bar overflow, label overlap, cap colours, read-only
// DCIM rack mapping and the Backend connection dialog keyboard.
// Read-only: every non-GET request except the sign-in is aborted and reported; injected states live only in the page.
// Screenshots go to DCIM_QA_SHOTS (default C:/t/tv3-after).
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
    // a plain click on empty 3D space (no drag) does not move the camera, so the preset and the breadcrumb stay
    const empty = await page.evaluate(() => { const t = __twin, cv = document.querySelector('#c'), r = cv.getBoundingClientRect();
      for (let fy = 0.15; fy < 0.95; fy += 0.05) for (let fx = 0.05; fx < 0.95; fx += 0.05) { const x = r.left + r.width * fx, y = r.top + r.height * fy; if (document.elementFromPoint(x, y) === cv && !t.pickAt({ clientX: x, clientY: y })) return { x, y }; }
      return null; });
    assert.ok(empty, 'an empty point in the 3D view');
    const camAtClick = await page.evaluate(() => __twin.camera.position.toArray());
    await page.mouse.click(empty.x, empty.y); await page.waitForTimeout(200);
    assert.deepEqual(await page.evaluate(() => __twin.camera.position.toArray()), camAtClick, 'a click does not move the camera');
    assert.equal(await page.locator('#vOrbit').getAttribute('aria-checked'), 'true', 'a click without a drag keeps Overview checked');
    assert.equal((await page.locator('#crumbPath').innerText()).replace(/\s+/g, ' '), 'Lab › Overview');
    pass('view switch: Overview / Rack front / Aisle / Top radios, drag unchecks, a plain click keeps Overview, brand → Overview, breadcrumb Lab › Overview');

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
    const capBefore = await page.evaluate(() => __twin.S.recs.get('SETUP-001').cap.userData.hex);
    await page.locator('#btnColorBy').click(); await page.locator('#colorMenu [data-color="status"]').click();
    const st = await page.evaluate(() => ({ cap: __twin.S.recs.get('SETUP-001').cap.userData.hex, legend: document.querySelector('#legend .lg-t').textContent, btn: document.querySelector('#btnColorBy').textContent, cls: document.body.classList.contains('color-status') }));
    assert.equal(capBefore, '#4ade80'); assert.notEqual(st.cap, capBefore, 'rack caps follow the colouring'); assert.equal(st.legend, 'Lifecycle'); assert.equal(st.btn, 'Color by: Lifecycle'); assert.equal(st.cls, true);
    await page.locator('#btnColorBy').click(); await page.locator('#colorMenu [data-color="health"]').click();
    assert.equal(await page.evaluate(() => __twin.S.recs.get('SETUP-001').cap.userData.hex), '#4ade80');
    // on screen the cap is the legend colour (unlit, sRGB-correct), not a washed-out mint; the down rack has a dashed red outline
    const capPx = await page.evaluate(() => {
      const t = __twin, rec = t.S.recs.get('SETUP-001'), gl = t.renderer.getContext(); t.renderer.render(t.scene, t.camera);
      const b = new THREE.Box3().setFromObject(rec.cap); const out = [];
      for (const fx of [.3, .5, .7]) for (const fz of [.3, .5, .7]) {
        const q = new THREE.Vector3(b.min.x + (b.max.x - b.min.x) * fx, b.max.y, b.min.z + (b.max.z - b.min.z) * fz).project(t.camera);
        const d = new Uint8Array(4); gl.readPixels(Math.round((q.x + 1) / 2 * gl.drawingBufferWidth), Math.round((q.y + 1) / 2 * gl.drawingBufferHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d); out.push([d[0], d[1], d[2]]);
      }
      const r7 = t.S.recs.get('SETUP-007'); return { out, down: r7.envDown.visible, dash: [r7.envDown.material.type, r7.envDown.material.dashSize, r7.envDown.material.gapSize], up: t.S.recs.get('SETUP-001').envDown.visible };
    });
    assert.ok(capPx.out.some(c => c.every((v, i) => Math.abs(v - [74, 222, 128][i]) <= 14)), 'Rack-01 cap renders #4ade80: ' + JSON.stringify(capPx.out));
    assert.deepEqual([capPx.down, capPx.up, capPx.dash], [true, false, ['LineDashedMaterial', 0.06, 0.04]]);
    pass('Color by: Lifecycle repaints rack caps and the legend; Health restores them; the cap renders #4ade80 on screen; Rack-07 (down) has a dashed red outline');

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

    // KVM port in use: the Connections row reads "In use" in amber — never the 11 px spinning circle of the busy rule
    const setInUse = v => page.evaluate(v => { const t = __twin; t.S.live.kvm.kvm1.ports.find(p => p.number === 1).in_use = v; t.computeModel(); t.buildItems({ refresh: true }); t.select('LIVE-opt11', { keepCamera: true }); }, v);
    await setInUse(true);
    const inUse = await page.evaluate(() => {
      const st = [...document.querySelectorAll('#dBody .crow')].find(r => /^KVM 01/.test(r.innerText)).querySelector('.cst'); const r = st.getBoundingClientRect();
      return { text: st.textContent, w: r.width, anim: getComputedStyle(st).animationName, color: getComputedStyle(st).color, cell: [...document.querySelectorAll('#dBody .scell')].find(c => c.querySelector('.sl').textContent === 'Console').querySelector('.sv').textContent };
    });
    assert.equal(inUse.text, 'In use'); assert.ok(inUse.w > 30, `status text width ${inUse.w}`); assert.equal(inUse.anim, 'none'); assert.equal(inUse.color, 'rgb(252, 211, 77)'); assert.equal(inUse.cell, 'In use');
    await shot(page, 'desktop-7-kvm-in-use.png');
    await page.locator('#dBody [data-power-menu]').click(); await page.locator('#dBody [data-pw="cycle"]').click(); await page.locator('#confirmModal:not(.hidden)').waitFor();
    assert.match(await page.locator('#cfBody').innerText(), /Console\s+In use · a Lab Manager console is open/);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await setInUse(false);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#dBody .crow')].find(r => /^KVM 01/.test(r.innerText)).querySelector('.cst').textContent), 'Free');
    pass('KVM in use: Connections row "In use" (amber text, no spinner animation), Console cell In use, power dialog "In use · a Lab Manager console is open"');

    // Hebrew owner: data text gets dir="auto" (right-to-left), the interface stays English; search names are isolated
    const heb = await page.evaluate(() => {
      const t = __twin; t.S.live.owners = { ...t.S.live.owners, opt11: 'עדן לוי (QA)' }; t.computeModel(); t.buildItems({ refresh: true }); t.select('LIVE-opt11', { keepCamera: true });
      const sv = [...document.querySelectorAll('#dBody .scell')].find(c => c.querySelector('.sl').textContent === 'Owner').querySelector('.sv');
      return { text: sv.textContent, dir: sv.getAttribute('dir'), cdir: getComputedStyle(sv).direction, label: getComputedStyle(document.querySelector('#dBody .scell .sl')).direction, search: document.querySelector('#search').getAttribute('dir'), name: document.querySelector('#dName').getAttribute('dir') };
    });
    assert.deepEqual(heb, { text: 'עדן לוי (QA)', dir: 'auto', cdir: 'rtl', label: 'ltr', search: 'auto', name: 'auto' });
    await page.locator('#search').fill('עדן'); await page.waitForTimeout(200);
    const hebRow = await page.evaluate(() => { const b = document.querySelector('#searchResults .sr .ow bdi'); return b && [b.textContent, getComputedStyle(b).direction]; });
    assert.deepEqual(hebRow, ['עדן לוי (QA)', 'rtl'], 'search row: owner in <bdi>');
    await shot(page, 'desktop-8-hebrew-owner.png');
    await page.locator('#search').fill(''); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.evaluate(() => { const t = __twin; t.S.live.owners = { ...t.S.live.owners, opt11: 'Fixture owner' }; t.computeModel(); t.buildItems({ refresh: true }); });
    pass('Hebrew owner: .sv[dir=auto] computes rtl, labels stay ltr; #search and #dName dir=auto; search owner in <bdi> (rtl)');

    // legend: one 32 px row next to the zoom bar with the side panel and the drawer open (780 px 3D view)
    const lg = await page.evaluate(() => { const l = document.querySelector('#legend'), z = document.querySelector('.zoombar').getBoundingClientRect(), r = l.getBoundingClientRect(); return { h: r.height, right: r.right, zoom: z.left, tops: [...new Set([...l.querySelectorAll('.li')].map(e => Math.round(e.getBoundingClientRect().top)))].length, words: getComputedStyle(l.querySelector('.li-t')).display }; });
    assert.equal(lg.h, 32); assert.equal(lg.tops, 1, 'legend on one row'); assert.ok(lg.right <= lg.zoom, 'legend clear of the zoom bar'); assert.notEqual(lg.words, 'none', 'words stay at 1440 px');
    pass('legend: one 32 px row beside the zoom bar at 1440 × 900 with the drawer open');

    // power confirmation (alertdialog), opened from the Power… menu; Escape writes nothing
    await page.evaluate(() => __twin.select('LIVE-opt12', { keepCamera: true })); await page.waitForTimeout(150);
    await page.locator('#dBody [data-power-menu]').click();
    assert.equal(await visible(page, '#pwMenu'), true); assert.equal(await page.locator('#dBody [data-power-menu]').getAttribute('aria-expanded'), 'true');
    const pm = await page.evaluate(() => { const m = document.querySelector('#pwMenu'); const it = a => m.querySelector(`[data-pw="${a}"]`); return { head: m.querySelector('.menu-head')?.textContent, label: m.getAttribute('aria-label'), on: [it('on').textContent, it('on').disabled], off: [it('off').textContent, it('off').disabled, getComputedStyle(it('off')).color], cycle: [it('cycle').disabled, getComputedStyle(it('cycle')).color] }; });
    assert.deepEqual(pm, { head: 'PDU 01 · outlet 2 · On', label: 'Power · PDU 01 · outlet 2 · On', on: ['Power on · already on', true], off: ['Power off', false, 'rgb(252, 165, 165)'], cycle: [false, 'rgb(252, 165, 165)'] });
    await page.keyboard.press('Escape'); assert.equal(await visible(page, '#pwMenu'), false); assert.equal(await page.evaluate(() => document.activeElement.matches('[data-power-menu]')), true, 'Escape returns to Power…');
    const before = writes.length;
    await page.locator('#dBody [data-power-menu]').click(); await page.locator('#dBody [data-pw="cycle"]').click();
    await page.locator('#confirmModal:not(.hidden)').waitFor();
    const dlg = await page.evaluate(() => { const c = document.querySelector('#confirmModal .modal-card'); return { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), desc: c.getAttribute('aria-describedby'), lab: c.getAttribute('aria-labelledby'), backdropRole: document.querySelector('#confirmModal').getAttribute('role'), title: document.querySelector('#cfTitle').textContent, body: document.querySelector('#cfBody').innerText, active: document.activeElement?.dataset.choice, buttons: [...document.querySelectorAll('#cfActions [data-choice]')].map(b => [b.dataset.choice, b.textContent, b.className]), foot: document.querySelector('#cfFoot').textContent }; });
    assert.equal(dlg.role, 'alertdialog'); assert.equal(dlg.modal, 'true'); assert.equal(dlg.desc, 'cfBody'); assert.equal(dlg.lab, 'cfTitle'); assert.equal(dlg.backdropRole, null);
    assert.equal(dlg.title, 'Power cycle OPT12?'); assert.match(dlg.body, /PDU 01 · outlet 2 · currently On( \(\d+ W\))?\. It turns off, then on again after a few seconds; unsaved work on it is lost\./);
    assert.match(dlg.body, /Server\s+OPT12 · Rack-01 › Shelf \d › Left/); assert.match(dlg.body, /Feeds switched\s+1 of 1/); assert.match(dlg.body, /Console\s+(No KVM port mapped|No Lab Manager console open|In use · a Lab Manager console is open|Unknown · KVM state not available)/); assert.doesNotMatch(dlg.body, /nobody is using it/);
    assert.equal(dlg.active, 'cancel', 'Cancel has the focus');
    assert.deepEqual(dlg.buttons.map(b => b.slice(0, 2)), [['cancel', 'Cancel'], ['go', 'Power cycle OPT12']]); assert.match(dlg.buttons[1][2], /\bdanger\b/);
    assert.equal(dlg.foot, 'Cancel has the focus. Escape closes without changing anything.');
    await shot(page, 'desktop-3-power-dialog.png');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    assert.equal(await page.locator('#confirmModal:not(.hidden)').count(), 0); assert.equal(writes.length, before, 'Escape sends nothing');
    // maintenance: the reason is inside the menu (phones show no tooltips)
    const maintMenu = await page.evaluate(() => { const t = __twin, S = t.S; const save = S.live.maintenance; S.live.maintenance = { pdus: { pdu1: { started_at: Date.now() / 1000, outlets_off: [], failed: [] } } }; t.select('LIVE-opt12', { keepCamera: true });
      const m = document.querySelector('#pwMenu'); const out = { note: m.querySelector('.menu-note')?.textContent, on: m.querySelector('[data-pw="on"]').disabled, cycle: m.querySelector('[data-pw="cycle"]').disabled, desc: m.querySelector('[data-pw="cycle"]').getAttribute('aria-describedby') };
      S.live.maintenance = save; t.select('LIVE-opt12', { keepCamera: true }); return out; });
    assert.deepEqual(maintMenu, { note: 'Blocked: PDU in maintenance — Power on and Power cycle stay off until it is restored in Lab Manager.', on: true, cycle: true, desc: 'pwMenuNote' });
    pass('power: Power… menu names PDU 01 · outlet 2 · On, Power on disabled ("already on"), Off / Cycle red, maintenance reason inside the menu');
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
        // two columns filled in order (servers, then equipment): a missing server / equipment place shows Free unless the row is full
        const tops = [...sh.querySelectorAll('.rf-tile, .rf-free')].map(e => Math.round(e.getBoundingClientRect().top));
        return { sid, same: JSON.stringify(tiles) === JSON.stringify(want.map(r => r.id).sort()), free: sh.querySelectorAll('.rf-free').length, wantFree: (pcs ? 0 : 1) + (want.length - pcs ? 0 : (Math.max(pcs, 1) % 2 ? 1 : 0)), rows: new Set(tops).size, cells: tops.length };
      });
      return { caps, shelves, head: el.querySelector('.rf-head').innerText.replace(/\s*\n\s*/g, ' | '), label: el.getAttribute('aria-label'), crumb: document.querySelector('#crumbPath').innerText.replace(/\s+/g, ' '), side: getComputedStyle(document.querySelector('.side')).display };
    }, id);
    const f1 = await front('SETUP-001');
    assert.deepEqual(f1.caps, ['SHELF 1 (TOP)', 'SHELF 2', 'SHELF 3', 'SHELF 4 (BOTTOM)']); assert.equal(f1.label, 'Rack-01 front view'); assert.equal(f1.side, 'none');
    assert.ok(f1.shelves.every(s => s.same), 'every tile is an object on that shelf'); assert.ok(f1.shelves.every(s => s.free === s.wantFree), 'Free = empty slots');
    assert.ok(f1.shelves.every(s => s.rows === Math.ceil(s.cells / 2)), 'two places per row: ' + JSON.stringify(f1.shelves));
    assert.match(f1.head, /^Rack-01 \| ≥?\d+\.\d\d kW · \d+\/\d+ on$/); assert.equal(f1.crumb, 'Lab › Left rack row › Rack-01');
    const f5 = await front('SETUP-005'); assert.deepEqual(f5.caps, ['SHELF 1 (TOP)', 'SHELF 2', 'SHELF 3 (BOTTOM)']);
    await front('SETUP-001'); await page.locator('#rfNext').click(); assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-002');
    await page.keyboard.press(']'); assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-003');
    await page.keyboard.press('['); assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-002');
    const tile = page.locator('#rackFront .rf-tile').first(); const tileId = await tile.getAttribute('data-id'); await tile.click();
    assert.equal(await page.evaluate(() => __twin.S.selected), tileId); assert.deepEqual(await page.evaluate(() => __twin.camera.position.toArray()), camBefore, 'a tile opens the drawer without moving the camera');
    assert.equal(await page.locator('#rackFront .rf-tile.sel').getAttribute('aria-pressed'), 'true');
    // Next shows another rack: the drawer of a machine that is no longer on screen closes (and its Power… menu)
    await page.locator('#rfNext').click();
    assert.deepEqual(await page.evaluate(() => [__twin.S.front, __twin.S.selected, document.querySelector('#detail').classList.contains('hidden'), __twin.S.pwMenuOpen]), ['SETUP-003', null, true, false], 'Next closes the drawer of an object outside the rack shown');
    assert.equal((await page.locator('#rfNext').innerText()).trim(), 'Next ›'); assert.equal(await page.locator('#rfNext').getAttribute('title'), 'Next rack (])');
    // a tall rack fits at 1440 × 900 with the drawer open: SHELF 4 (BOTTOM) and its row end above the legend and Back
    for (const id of ['SETUP-001', 'SETUP-006']) {
      const fit = await page.evaluate(id => {
        const t = __twin; t.showRackFront(id); t.select(document.querySelector('#rackFront .rf-tile').dataset.id, { keepCamera: true });
        const cap = [...document.querySelectorAll('#rackFront .rf-cap')].find(e => e.textContent === 'SHELF 4 (BOTTOM)'); const row = cap.nextElementSibling.getBoundingClientRect();
        return { drawer: !document.querySelector('#detail').classList.contains('hidden'), front: t.S.front, cap: cap.getBoundingClientRect().bottom, row: row.bottom, legend: document.querySelector('#legend').getBoundingClientRect().top, back: document.querySelector('#vBack').getBoundingClientRect().top, scroll: document.querySelector('#rackFront').scrollTop };
      }, id);
      assert.ok(fit.drawer && fit.front === id && fit.scroll === 0 && fit.row < fit.legend && fit.row < fit.back, `${id}: SHELF 4 (BOTTOM) above the legend with the drawer open ${JSON.stringify(fit)}`);
    }
    await shot(page, 'desktop-9-rack-front-06.png');
    await page.evaluate(() => __twin.showRackFront('SETUP-001')); await page.waitForTimeout(100);
    await page.evaluate(() => __twin.select('LIVE-opt11', { keepCamera: true }));
    await shot(page, 'desktop-6-rack-front.png');
    await page.locator('#rackFront .rf-tile.sel').focus(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => __twin.S.selected), null, 'Escape closes the drawer first'); assert.equal(await page.evaluate(() => __twin.S.front), 'SETUP-001');
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => __twin.S.front), null, 'then returns to the overview');
    pass('rack front: Rack-01 4 shelves SHELF 1 (TOP)…SHELF 4 (BOTTOM), Rack-05 3, two places per row, Free = empty places, Next / ] / [ , tile click keeps the camera, Next closes a foreign drawer, Rack-01 / Rack-06 fit above the legend, Escape twice');

    // rack framing (Rack-03 from the rack bar): whole rack and cap between the breadcrumb band and the legend band,
    // at least 1.2 × the rack height away; breadcrumb names the rack; no telemetry card cut at the top
    await page.locator('#rackBar [data-jump="SETUP-003"]').click(); await idle(page); await page.waitForTimeout(300);
    const fr = await page.evaluate(() => {
      const t = __twin, rec = t.S.recs.get('SETUP-003'), cv = document.querySelector('#c').getBoundingClientRect();
      const b = new THREE.Box3(); rec.group.traverseVisible(o => { if ((o.isMesh || o.isLine) && o.geometry) { o.geometry.computeBoundingBox(); b.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
      const xs = [], ys = []; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const q = new THREE.Vector3(x, y, z).project(t.camera); xs.push((q.x + 1) / 2 * cv.width); ys.push((1 - q.y) / 2 * cv.height); }
      const telem = [...document.querySelectorAll('.telem')].filter(e => e.style.display !== 'none' && getComputedStyle(e).visibility !== 'hidden').map(e => e.getBoundingClientRect().top - cv.top);
      return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys), w: cv.width, h: cv.height, crumb: document.querySelector('#crumbPath').innerText.replace(/\s+/g, ' '), telem, dist: t.camera.position.distanceTo(b.getCenter(new THREE.Vector3())) };
    });
    assert.equal(fr.crumb, 'Lab › Left rack row › Rack-03');
    assert.ok(fr.l >= 0 && fr.r <= fr.w && fr.t >= 80 && fr.b <= fr.h - 64, 'Rack-03 whole, inside the frame area: ' + JSON.stringify(fr));
    assert.ok(fr.dist >= 1.2 * 2.225, 'not closer than 1.2 × the rack height'); assert.ok(fr.telem.every(y => y >= 0), 'no telemetry card cut at the top');
    await shot(page, 'desktop-10-rack03-framed.png');
    pass(`framing: Rack-03 whole between the breadcrumb and legend bands (${Math.round(fr.t)}–${Math.round(fr.b)} of ${fr.h} px), ${fr.dist.toFixed(2)} m away; breadcrumb Lab › Left rack row › Rack-03`);

    // rack drawer: the DCIM rack mapping is read-only text outside Edit layout
    const rackDr = await page.evaluate(() => { __twin.select('SETUP-007', { keepCamera: true }); return { select: !!document.querySelector('#dBody #dRack'), rows: [...document.querySelectorAll('#dBody .crow')].map(r => r.innerText.replace(/\s*\n\s*/g, ' | ')), id: document.querySelector('#dId').textContent }; });
    assert.equal(rackDr.select, false, 'no DCIM rack select outside Edit layout'); assert.ok(rackDr.rows.includes('DCIM rack | Rack-07'), rackDr.rows.join(' / ')); assert.ok(rackDr.rows.includes('PDU 07 | Offline'));
    assert.equal(rackDr.id, 'Rack · Right rack row');

    // Edit layout: the same 380 px drawer, header and 12 px headings; WHERE as in Location; Kaizen buttons; no internal ids
    await page.evaluate(() => { __twin.toggleEdit(true); __twin.select('LIVE-opt11', { keepCamera: true }); }); await page.waitForTimeout(300);
    const ed = await page.evaluate(() => {
      const mv = document.querySelector('#eMove'), toast = [...document.querySelectorAll('#toasts .toast')].pop()?.getBoundingClientRect(), vp = document.querySelector('#viewport').getBoundingClientRect();
      return { w: Math.round(document.querySelector('#detail').getBoundingClientRect().width), name: document.querySelector('#dName').textContent, where: document.querySelector('#dBody .where').textContent, move: [mv.textContent, Math.round(mv.getBoundingClientRect().height), mv.className], mat: document.querySelector('#eMaterialize').className,
        hint: document.querySelector('#dBody .edit-hint').textContent, hFont: getComputedStyle(document.querySelector('#dBody .lbl-lg')).fontSize, hCase: getComputedStyle(document.querySelector('#dBody .lbl-lg')).textTransform, text: document.querySelector('#dBody').innerText,
        toastDx: toast ? Math.abs(toast.left + toast.width / 2 - (vp.left + vp.width / 2)) : null, toastBottom: toast?.bottom, legendTop: document.querySelector('#legend').getBoundingClientRect().top, zoomTop: document.querySelector('.zoombar').getBoundingClientRect().top };
    });
    assert.deepEqual([ed.w, ed.name, ed.move, ed.mat, ed.hFont, ed.hCase], [380, 'OPT11', ['Move…', 36, 'kbtn secondary md'], 'link', '12px', 'uppercase']);
    assert.match(ed.where, /^Rack-01 › Shelf \d › Left$/); assert.match(ed.hint, /^Edit mode/); assert.doesNotMatch(ed.text, /SETUP-|SHELF-|\bL\d\b/);
    // toasts are centred on the 3D view, above the legend and the zoom bar
    assert.ok(ed.toastDx !== null && ed.toastDx < 2 && ed.toastBottom <= Math.min(ed.legendTop, ed.zoomTop), 'toast over the 3D view: ' + JSON.stringify({ dx: ed.toastDx, b: ed.toastBottom, lg: ed.legendTop, zb: ed.zoomTop }));
    await shot(page, 'desktop-11-edit-opt11.png');
    const edRack = await page.evaluate(() => { __twin.select('SETUP-001', { keepCamera: true }); return { dRack: !!document.querySelector('#dBody #dRack'), shelves: [...document.querySelectorAll('#dBody .itm-lg .lvl-lg')].map(e => e.textContent), text: document.querySelector('#dBody').innerText, id: document.querySelector('#dId').textContent }; });
    assert.equal(edRack.dRack, true, 'the DCIM rack select lives in Edit layout'); assert.deepEqual(edRack.shelves, ['Shelf 1 (top)', 'Shelf 2', 'Shelf 3', 'Shelf 4 (bottom)']);
    assert.doesNotMatch(edRack.text + edRack.id, /SETUP-|SHELF-|\bL\d\b/);
    await page.evaluate(() => { __twin.toggleEdit(false); __twin.closeDetail(); });
    pass('drawers: rack mapping read-only (DCIM rack | Rack-07); Edit layout 380 px, OPT11 header, WHERE "Rack-01 › Shelf n › Left", Move… secondary md 36 px, physical record as a link, 12 px headings, no SETUP / SHELF / L4; toast centred over the 3D view above the legend');

    // Backend connection dialog: focus in, Tab stays inside, Escape closes and returns to the Live badge
    await page.locator('#livePill').click(); await page.locator('#settings:not(.hidden)').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sUrl');
    const inside = []; for (let i = 0; i < 9; i++) { await page.keyboard.press('Tab'); inside.push(await page.evaluate(() => !!document.activeElement.closest('#settings .modal-card'))); }
    assert.ok(inside.every(Boolean), 'Tab stays inside the dialog');
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#settings .modal-card')), true);
    await page.keyboard.press('Escape');
    assert.equal(await visible(page, '#settings'), false, 'Escape closes it'); assert.equal(await page.evaluate(() => document.activeElement.id), 'livePill', 'focus returns to the Live badge');
    pass('Backend connection: focus in #sUrl, Tab / Shift+Tab stay inside, Escape closes and refocuses the Live badge');

    // 3D labels never overlap: search "opt1" shows OPT11…OPT14 apart (nudged or hidden), selection / issues stay
    await page.locator('#btnHome').click(); await idle(page);
    await page.locator('#search').fill('opt1'); await page.waitForTimeout(400);
    const clash = await page.evaluate(() => {
      const shown = [...document.querySelectorAll('#labels .lbl')].filter(e => e.style.display !== 'none' && getComputedStyle(e).visibility !== 'hidden').map(e => ({ t: e.textContent, r: e.getBoundingClientRect() }));
      const bad = []; for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) { const a = shown[i].r, b = shown[j].r; if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) bad.push(shown[i].t + ' / ' + shown[j].t); }
      return { n: shown.length, bad, hits: shown.filter(s => /^OPT1\d/.test(s.t)).length };
    });
    assert.deepEqual(clash.bad, [], 'overlapping labels'); assert.ok(clash.hits >= 2, 'search hits labelled: ' + clash.hits);
    await shot(page, 'desktop-12-search-labels.png');
    await page.locator('#search').fill(''); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    pass(`labels: ${clash.n} labels for "opt1" with no overlap (${clash.hits} search hits shown)`);

    // narrower windows: the header never passes the edge (1024 px, long issues badge); at 800 px the critical chip is in view
    await page.evaluate(() => { const t = __twin, S = t.S; window.__saved = { m: S.live.maintenance, p: S.live.ping }; S.live.maintenance = { pdus: { pdu3: { started_at: Date.now() / 1000 - 600, outlets_off: [1], failed: [] } } }; S.live.ping = { ...(S.live.ping || {}), opt12: { status: 'down', rtt: null, checkedAt: new Date().toISOString(), lastUpAt: null } }; t.computeModel(); t.buildItems({ refresh: true }); });
    await page.setViewportSize({ width: 1024, height: 900 }); await page.waitForTimeout(400);
    const w1024 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, badge: document.querySelector('#issuesBadge').textContent, more: document.querySelector('#btnMore').getBoundingClientRect().right }));
    assert.deepEqual([w1024.sw, w1024.badge], [1024, '1 critical · 2 warnings']); assert.ok(w1024.more <= 1024, 'More inside the window');
    await page.setViewportSize({ width: 800, height: 900 }); await page.waitForTimeout(400);
    const w800 = await page.evaluate(() => { const c = document.querySelector('#rackBar .rb.crit').getBoundingClientRect(), b = document.querySelector('#rackBar').getBoundingClientRect(); return { c: [c.left, c.right], b: [b.left, b.right], wrap: document.querySelector('#rackBarWrap').className, sw: document.documentElement.scrollWidth }; });
    assert.ok(w800.c[0] >= w800.b[0] && w800.c[1] <= w800.b[1], 'critical chip visible at 800 px: ' + JSON.stringify(w800)); assert.match(w800.wrap, /can-left|can-right/); assert.equal(w800.sw, 800);
    await shot(page, 'desktop-13-w800.png');
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(300);
    await page.evaluate(() => { const t = __twin, S = t.S; S.live.maintenance = window.__saved.m; S.live.ping = window.__saved.p; t.computeModel(); t.buildItems({ refresh: true }); });
    pass('narrow windows: 1024 px scrollWidth = 1024 with "1 critical · 2 warnings"; 800 px critical chip in view with edge fades');

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
    // phone labels: only the racks with an issue (plus the selection and search hits), never piled up
    const phoneLabels = await p.evaluate(() => [...document.querySelectorAll('#labels .lbl')].filter(e => e.style.display !== 'none' && getComputedStyle(e).visibility !== 'hidden').map(e => e.dataset.id));
    assert.deepEqual(phoneLabels, ['SETUP-007'], 'phone: only the rack with an issue is labelled');
    // three issues: every card fits the half sheet, Data quality ends the list (no pinned footer), the title counts
    const three = await p.evaluate(() => {
      const t = __twin, S = t.S; window.__saved = { m: S.live.maintenance, p: S.live.ping };
      S.live.maintenance = { pdus: { pdu3: { started_at: Date.now() / 1000 - 600, started_by: 'qa', reason: 'qa', outlets_off: [1, 2, 3, 4], failed: [] } } };
      S.live.ping = { ...(S.live.ping || {}), opt12: { status: 'down', rtt: null, checkedAt: new Date().toISOString(), lastUpAt: null } };
      t.computeModel(); t.buildItems({ refresh: true });
      const panel = document.querySelector('#attn').getBoundingClientRect(), sheet = document.querySelector('#sheet').getBoundingClientRect();
      return { title: document.querySelector('#sheetTitle').textContent, tip: document.querySelector('#sheetTitle').title, cards: [...document.querySelectorAll('#attn .attn-row')].map(c => { const r = c.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; }),
        panel: [Math.round(panel.top), Math.round(panel.bottom)], sheet: Math.round(sheet.bottom), footer: getComputedStyle(document.querySelector('#dqFooter')).display, inline: document.querySelector('#attn > :last-child')?.matches('[data-dq-inline]') };
    });
    assert.equal(three.title, '1 critical · 2 warnings'); assert.equal(three.tip, 'Worst: PDU 07 unreachable'); assert.equal(three.cards.length, 3);
    assert.ok(three.cards.every(([t, b]) => t >= three.panel[0] && b <= three.panel[1] && b <= three.sheet), 'all three cards fully visible in the half sheet: ' + JSON.stringify(three));
    assert.equal(three.footer, 'none', 'no Data quality footer pinned in the sheet'); assert.equal(three.inline, true, 'Data quality ends the Issues list');
    await shot(p, 'phone-6-three-issues.png');
    await p.evaluate(() => { const t = __twin, S = t.S; S.live.maintenance = window.__saved.m; S.live.ping = window.__saved.p; t.computeModel(); t.buildItems({ refresh: true }); });
    pass('phone: only the issue rack labelled; three issues fit the half sheet; title "1 critical · 2 warnings" (worst in the tooltip); Data quality at the end of the list');
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
    await p.locator('#dBody [data-power-menu]').click();
    // the Power… menu is a bottom action sheet: every choice on screen and tappable without scrolling
    const pmPhone = await p.evaluate(() => [...document.querySelectorAll('#pwMenu [role="menuitem"]')].map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent, top: r.top, bottom: r.bottom, h: r.height, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === e }; }));
    assert.equal(pmPhone.length, 3); assert.ok(pmPhone.every(i => i.top >= 0 && i.bottom <= 844 && i.h >= 44 && i.hit), 'every Power… item inside the phone view: ' + JSON.stringify(pmPhone));
    await shot(p, 'phone-7-power-menu.png');
    await p.locator('#dBody [data-pw="off"]').click(); await p.locator('#confirmModal:not(.hidden)').waitFor();
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
    // rack front on the phone: the sheet drops to peek, one 44 px row above the rack (‹ previous · this rack · next › · Overview),
    // no floating Back button over the tiles; Issues and Racks still open from the sheet
    const pf = await p.evaluate(() => {
      const bar = document.querySelector('#rfBar'), rack = document.querySelector('#rackFront .rf-rack'); const t = __twin;
      return { size: t.S.sheet.size, cur: bar.querySelector('.rfb-cur')?.textContent, want: t.S.recs.get(t.S.front).def.dcimRack, parts: [...bar.children].map(e => e.textContent.trim()), h: Math.round(bar.getBoundingClientRect().height), barBottom: bar.getBoundingClientRect().bottom, rackTop: rack.getBoundingClientRect().top,
        back: getComputedStyle(document.querySelector('#vBack')).display, crumb: getComputedStyle(document.querySelector('#crumb')).display };
    });
    assert.equal(pf.size, 'peek'); assert.equal(pf.cur, pf.want); assert.equal(pf.parts.length, 4); assert.match(pf.parts[0], /^‹ Rack-\d\d$/); assert.match(pf.parts[2], /^Rack-\d\d ›$/); assert.equal(pf.parts[3], 'Overview');
    assert.equal(pf.h, 44); assert.ok(pf.barBottom <= pf.rackTop, 'the toolbar does not cover the rack'); assert.deepEqual([pf.back, pf.crumb], ['none', 'none']);
    await p.locator('[data-sheet="issues"]').click(); await p.waitForTimeout(200);
    assert.equal(await visible(p, '#attn .attn-row'), true, 'Issues cards in the rack front');
    await p.locator('[data-sheet="racks"]').click(); await p.waitForTimeout(200);
    assert.equal(await visible(p, '#tree'), true, 'Racks tree in the rack front');
    assert.deepEqual(await smallTargets(p), [], 'phone: 44 px targets (rack front, Racks)');
    await shot(p, 'phone-8-rack-front-racks.png');
    await p.locator('#rfBar [data-rf="1"]').click(); assert.notEqual(await p.evaluate(() => __twin.S.front), null);
    await p.locator('#rfBar [data-rf="leave"]').click(); assert.equal(await p.evaluate(() => __twin.S.front), null, 'Overview leaves the rack front');
    await phone.ctx.close();
    pass('phone: 48 px header, no overflow, sheet Issues / Racks / Details, issue tap → Details, 44 px targets in every state, full sheet, search row, rack front (peek sheet, 44 px ‹ · › · Overview row, no floating Back, Issues / Racks work), Power… sheet on screen');

    // ───────────────────────────── connecting, then a backend error: one clear card, no "· no live data" on every rack
    const errCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let deviceCalls = 0;
    await errCtx.route('**/*', route => {
      const req = route.request(); if (!req.url().startsWith(origin + '/')) return route.abort();
      const path = new URL(req.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && path !== '/api/auth/login') { writes.push(`error-state ${req.method()} ${path}`); return route.abort(); }
      return route.continue();
    });
    await errCtx.route(/\/api\/devices\/$/, async route => { deviceCalls++; await new Promise(r => setTimeout(r, deviceCalls === 1 ? 3000 : 0)); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Fixture: Lab Manager unavailable' }) }); });
    assert.equal((await errCtx.request.post(origin + '/api/auth/login', { data: { username: 'operator', password: 'test-password-123' } })).status(), 200);
    assert.equal((await (await errCtx.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    await errCtx.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* ignore */ } });
    const ep = await errCtx.newPage(); ep.on('pageerror', e => errors.push('error-state: ' + e.message)); ep.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
    await ep.goto(origin + '/twin/');
    await ep.locator('#attn .attn-row .tt').filter({ hasText: 'Connecting to Lab Manager…' }).waitFor({ timeout: 30000 });
    const conn = await ep.evaluate(() => ({ spin: !!document.querySelector('#attn .attn-row .tt .spinner'), title: document.querySelector('#sheetTitle').textContent, live: document.querySelector('#liveText').textContent, n: document.querySelectorAll('#attn .attn-row').length }));
    assert.deepEqual(conn, { spin: true, title: 'Connecting…', live: 'Connecting…', n: 1 });
    await ep.locator('#attn .attn-row.sev-err').waitFor({ timeout: 30000 });
    const err = await ep.evaluate(() => ({ tt: document.querySelector('#attn .sev-err .tt').textContent, sub: document.querySelector('#attn .sev-err .sub').textContent, btn: document.querySelector('#attn .sev-err [data-retry]')?.textContent, title: document.querySelector('#sheetTitle').textContent, n: document.querySelectorAll('#attn .attn-row').length,
      labels: [...__twin.S.recs.values()].filter(r => r.cat === 'setup').map(r => r.label.querySelector('.ln').textContent + r.label.querySelector('.ls').textContent) }));
    assert.deepEqual([err.tt, err.sub, err.btn, err.title, err.n], ['Lab Manager did not answer (HTTP 503)', 'Showing saved layout · retrying every 15 s', 'Retry now', 'No live data', 1]);
    assert.ok(err.labels.every(l => /^Rack-\d\d$/.test(l)), 'no "· no live data" suffix on every rack: ' + err.labels.join(', '));
    await shot(ep, 'desktop-14-backend-error.png');
    const calls = deviceCalls; await ep.locator('#attn [data-retry]').click();
    for (let i = 0; i < 50 && deviceCalls === calls; i++) await ep.waitForTimeout(100);
    assert.ok(deviceCalls > calls, 'Retry now asks Lab Manager again');
    await ep.locator('#attn .attn-row.sev-err').waitFor({ timeout: 30000 });
    await errCtx.close();
    pass('states: "Connecting to Lab Manager…" (spinner, sheet "Connecting…"), then "Lab Manager did not answer (HTTP 503)" · "Showing saved layout · retrying every 15 s" · Retry now (asks again), sheet "No live data", plain rack labels');

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
