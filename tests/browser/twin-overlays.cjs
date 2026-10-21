// Digital Twin overlay / keyboard regression (isolated fixture only: tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1).
// Covers, at 1440 px and 375 px: the move banner covers no control, an unreachable PDU shows its own outlet count
// (never a made-up 24) with an unknown state, search results by keyboard (↓/↑, Enter, Escape), a visible focus ring
// on the Zone / Setup dropdowns, and the React lab-assistant launcher kept off the embedded twin.
// The launcher check needs a frontend build of the current source (frontend/dist or DCIM_PREVIEW_DIST).
// Read-only: every non-GET request from the pages is aborted; the move is started and cancelled, never applied.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const SIZES = [[1440, 900], [375, 812]];

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [], errors = [], unexpected = [];
  const pass = m => { checks.push(m); if (process.env.DCIM_QA_VERBOSE) console.error('ok: ' + m); };
  async function open(path, [width, height]) {
    const phone = width < 500;
    const ctx = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
    await ctx.route('**/*', route => {
      const req = route.request(); if (!req.url().startsWith(origin + '/')) return route.abort();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { unexpected.push(req.method() + ' ' + new URL(req.url()).pathname); return route.abort(); }
      return route.continue();
    });
    assert.equal((await ctx.request.post(origin + '/api/auth/login', { data: { username: 'admin', password: 'test-password-123' } })).status(), 200);
    assert.equal((await (await ctx.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    await ctx.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* ignore */ } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${width}px ${path}: ${e.message}`));
    await page.goto(origin + path);
    return { ctx, page };
  }
  const rectOf = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; }, sel);
  const overlaps = (a, b) => !!(a && b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5);
  try {
    for (const size of SIZES) {
      const w = size[0];
      const { ctx, page } = await open('/twin/', size);
      await page.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.recs.size > 10 && window.__twin.S.live.pdu.pdu1 && window.__twin.S.live.pdu.pdu7, null, { timeout: 60000 });
      await page.waitForTimeout(800);
      await page.evaluate(() => { clearInterval(__twin.S.live.timer); __twin.S.live.timer = null; });   // no 15 s refresh in the middle of a check

      // a — the move banner sits under the toolbar and covers no control
      await page.evaluate(() => { __twin.toggleEdit(true); __twin.select('LIVE-opt11', { keepCamera: true }); __twin.startMove('LIVE-opt11'); });
      await page.waitForTimeout(250);
      const banner = await rectOf(page, '#moveBanner'); const vp = await rectOf(page, '#viewport');
      assert.ok(banner, 'move banner shown');
      assert.ok(banner.l >= vp.l && banner.r <= vp.r + 0.5 && banner.t >= vp.t, 'banner inside the 3D view');
      const controls = await page.evaluate(() => [...document.querySelectorAll('.toolbar .tb, #attnDock, .zoombar .zb, #rackBar button, #saveBar, #envPanel')]
        .map(e => { const r = e.getBoundingClientRect(); return { id: e.id || e.textContent.trim().slice(0, 16), l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width }; }).filter(c => c.w > 0));
      const covered = controls.filter(c => overlaps(banner, c)).map(c => c.id);
      assert.deepEqual(covered, [], `${w}px: the move banner covers ${covered.join(', ')}`);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'moveTarget', 'destination list has the focus');
      await page.locator('#moveCancel').click();
      assert.equal(await page.evaluate(() => __twin.S.moveItem), null); assert.equal(await page.locator('#moveBanner.hidden').count(), 1);
      await page.evaluate(() => __twin.toggleEdit(false));
      pass(`${w}px: move banner below the toolbar, clear of ${controls.length} controls`);

      // b — an unreachable PDU: its own outlet count, unknown state, never 24
      const cells = async () => page.evaluate(() => ({ all: document.querySelectorAll('#dBody .ogrid .ocell').length, unknown: document.querySelectorAll('#dBody .ogrid .ocell.unknown').length,
        head: [...document.querySelectorAll('#dBody .sec-h')].find(h => h.textContent.startsWith('Outlets'))?.textContent || '', note: document.querySelector('#dBody .note')?.textContent || '' }));
      const showPdu7 = () => page.evaluate(() => { __twin.computeModel(); __twin.buildItems({ refresh: true }); __twin.select('LIVE-pdu7', { keepCamera: true }); });
      await showPdu7();
      let c = await cells();
      assert.equal(c.all, 4, 'fixture PDU 07: 4 outlets'); assert.equal(c.unknown, 4, 'every outlet state unknown'); assert.match(c.head, /unreachable · 4 outlets .*state unknown/);
      assert.equal(await page.evaluate(() => __twin.S.pduOutletsSeen.pdu1), 4, 'a reachable PDU remembers how many outlets it reported');
      // the real backend answers an unreachable PDU without outlets: the count comes from Lab Manager (port_count)
      await page.evaluate(() => { __twin.S.live.pdu.pdu7 = { device_id: 'pdu7', reachable: false, outlets: [], error: 'Fixture: PDU unavailable' }; });
      await showPdu7(); c = await cells();
      assert.equal(c.all, 4); assert.equal(c.unknown, 4); assert.match(c.head, /4 outlets \(set in Lab Manager\)/);
      // no port_count and never seen: only the labelled outlets, and the count is called unknown
      await page.evaluate(() => { const d = __twin.S.live.devices.find(x => x.id === 'pdu7'); d._pc = d.port_count; d.port_count = 0; d._lb = d.labels; d.labels = { 2: 'OPT72' }; delete __twin.S.pduOutletsSeen.pdu7; });
      await showPdu7(); c = await cells();
      assert.equal(c.all, 1, 'only the labelled outlet'); assert.match(c.head, /outlet count unknown/); assert.match(c.note, /Outlet count unknown/);
      await page.evaluate(() => { const d = __twin.S.live.devices.find(x => x.id === 'pdu7'); d.port_count = d._pc; d.labels = d._lb; delete d._pc; delete d._lb; __twin.closeDetail(); });
      await page.evaluate(() => __twin.refreshStatuses());
      pass(`${w}px: unreachable PDU shows its own outlets (fixture 4, port_count, labelled only) with unknown state`);

      // c — search results by keyboard
      const search = page.locator('#search'); const active = () => page.evaluate(() => document.querySelector('#searchResults .sr.active')?.dataset.id || null);
      const ids = () => page.evaluate(() => [...document.querySelectorAll('#searchResults .sr[data-id]')].map(e => e.dataset.id));
      const open_ = () => page.evaluate(() => !document.querySelector('#searchResults').classList.contains('hidden'));
      await search.click(); await search.fill('OPT1'); await page.waitForTimeout(100);
      const list = await ids(); assert.ok(list.length >= 3, 'several results');
      assert.equal(await active(), list[0]);
      await page.keyboard.press('ArrowDown'); assert.equal(await active(), list[1]);
      await page.keyboard.press('ArrowDown'); assert.equal(await active(), list[2]);
      await page.keyboard.press('ArrowUp'); assert.equal(await active(), list[1]);
      assert.equal(await search.getAttribute('aria-activedescendant'), await page.locator('#searchResults .sr.active').getAttribute('id'));
      await page.keyboard.press('Escape'); assert.equal(await open_(), false, 'Escape closes the list');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'search', 'focus stays in the search box');
      await page.keyboard.press('ArrowDown'); assert.equal(await open_(), true, '↓ reopens the list'); assert.equal(await active(), list[0]);
      await page.keyboard.press('ArrowUp'); assert.equal(await active(), list[list.length - 1], '↑ wraps to the last result');
      await page.keyboard.press('Enter'); await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => __twin.S.selected), list[list.length - 1], 'Enter selects the highlighted result'); assert.equal(await open_(), false);
      await page.keyboard.press('Escape'); assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'search', 'a second Escape leaves the box');
      await search.fill(''); await page.evaluate(() => __twin.closeDetail());
      pass(`${w}px: search ↓/↑ move through results, Escape closes, ↓ reopens, Enter selects`);

      // c — visible focus ring on the Zone / Setup dropdowns (desktop; on phones the lists sit below the 3D view)
      if (w > 720) {
        const ring = id => page.evaluate(id => { const s = getComputedStyle(document.getElementById(id)); return { focused: document.activeElement?.id === id, style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; }, id);
        await page.locator('#fSetup').focus(); await page.keyboard.press('Shift+Tab');
        let r = await ring('fZone'); assert.ok(r.focused && r.style === 'solid' && r.width >= 2, `Zone focus ring: ${JSON.stringify(r)}`);
        await page.keyboard.press('Tab');
        r = await ring('fSetup'); assert.ok(r.focused && r.style === 'solid' && r.width >= 2, `Setup focus ring: ${JSON.stringify(r)}`);
        pass(`${w}px: Zone and Setup dropdowns show a focus ring`);
      }
      await ctx.close();
    }

    // d — the React lab assistant launcher never covers the embedded twin, and stays in its corner elsewhere
    for (const size of SIZES) {
      const w = size[0];
      const { ctx, page } = await open('/?tab=twin', size);
      const launcher = page.locator('button[aria-controls="assistant-panel"]');
      await launcher.waitFor(); await page.locator('iframe[title="3D Digital Twin"]').waitFor();
      await page.waitForFunction(() => document.querySelector('button[aria-controls="assistant-panel"]')?.dataset.placement === 'title', null, { timeout: 10000 });
      for (const scroll of [0, 1e6]) {
        await page.evaluate(y => scrollTo(0, y), scroll); await page.waitForTimeout(150);
        const b = await rectOf(page, 'button[aria-controls="assistant-panel"]'), f = await rectOf(page, 'iframe[title="3D Digital Twin"]');
        assert.ok(b && f, 'launcher and twin shown'); assert.equal(overlaps(b, f), false, `${w}px scroll ${scroll}: launcher over the twin ${JSON.stringify({ b, f })}`);
        assert.ok(b.l >= 0 && b.r <= w + 0.5, 'launcher inside the page width');
      }
      await launcher.click(); await page.locator('#assistant-panel').waitFor();
      await page.keyboard.press('Escape'); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-controls') === 'assistant-panel');
      await ctx.close();
      const other = await open('/?tab=dashboard', size);
      await other.page.locator('button[aria-controls="assistant-panel"]').waitFor();
      assert.equal(await other.page.locator('button[aria-controls="assistant-panel"]').getAttribute('data-placement'), 'corner', 'other pages keep the corner launcher');
      await other.ctx.close();
      pass(`${w}px: assistant launcher in the 3D Twin title row (never over the twin), corner elsewhere`);
    }

    assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(unexpected, [], 'no writes');
    console.log(JSON.stringify({ passed: checks, errors }, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
