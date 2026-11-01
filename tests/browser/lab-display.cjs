// Lab display (?tab=display): the read-only screen at the lab entrance, made for a 24-inch monitor. Viewer and Operator,
// 1920 x 1080, 1536 x 864 (1920 x 1080 at 125 % scaling), 1920 x 1200, 2560 x 1440, 1280 x 720, 960 x 540 and
// 3840 x 2160. Checks: only GET requests, no page errors, no header / footer / assistant / What's new / dialogs /
// controls, no scrolling or clipped panels, an orderly layout (no text wider than its box, no panel or line overlapping
// another), the numbers the fixture implies (an unreadable rack shows "—", never 0), text sizes at 1920 x 1080
// (smallest >= 22 px, status words and panel titles >= 26-28 px, KPI numbers >= 64 px), two refresh cycles without re-mounting or memory
// growth, page rotation with alarms pinned, a network loss (last data kept, Reconnecting, NOT LIVE banner, greyed
// panels) and the recovery, one failing source ("Live · partial"), the role warning, the TV sign-in, the narrow-screen
// notice and the header link for both roles. Extra readings (sensors, an open console, maintenance, an email alert, many racks) are added
// to GET responses in the browser only; the fixture is never written.
// Run: DCIM_TEST_ACCOUNTS=1 python tests/browser/preview-server.py 9311, then
// DCIM_PREVIEW_URL=http://127.0.0.1:9311 node tests/browser/lab-display.cjs (screenshots: DCIM_QA_SHOTS, default C:/t/lb-shots).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const shots = process.env.DCIM_QA_SHOTS || 'C:/t/lb-shots';
const PASSWORD = 'test-password-123';
const EXTRA_RACKS = Array.from({ length: 22 }, (_, i) => ({ id: `qa-rack-${i}`, name: `QA rack ${i}`, kind: 'rack', model: 'Compute', ip: '0.0.0.0', rack: `Rack-${String(i + 20).padStart(2, '0')}`, labels: {}, enabled: true, port_count: 0, notes: '' }));

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [], errors = [], writes = [];
  const snapshots = {};
  try {
    const probe = await browser.newContext();
    assert.equal((await (await probe.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    await probe.close();

    async function open(role, viewport, { extraRacks = false, clock = false } = {}) {
      const context = await browser.newContext({ viewport });
      const login = await context.request.post(origin + '/api/auth/login', { data: { username: role, password: PASSWORD } });
      assert.equal(login.status(), 200, `${role} signs in`);
      const state = { offline: false, devicesGets: 0, failMaintenance: false };
      await context.route('**/*', async route => {
        const request = route.request();
        if (!request.url().startsWith(origin + '/')) return route.abort();
        const url = new URL(request.url());
        if (state.offline && url.pathname.startsWith('/api/')) return route.abort('internetdisconnected');
        if (state.failMaintenance && url.pathname === '/api/pdus/maintenance') return route.fulfill({ status: 500, json: { detail: 'QA failure' } });
        if (request.method() !== 'GET') return route.continue();
        const patch = async edit => { const response = await route.fetch(); const json = await response.json(); return route.fulfill({ response, json: edit(json) ?? json }); };
        if (url.pathname === '/api/devices/') { state.devicesGets++; if (extraRacks) return patch(list => [...list, ...EXTRA_RACKS]); }
        if (url.pathname === '/api/pdus/pdu2/status') return patch(j => Object.assign(j, { temperature: 27.5, humidity: 48, leak_detected: false }));
        if (url.pathname === '/api/pdus/pdu3/status') return patch(j => Object.assign(j, { temperature: 22.1, humidity: 41, leak_detected: false }));
        if (url.pathname === '/api/kvms/kvm1/status') return patch(j => { j.ports = j.ports.map(p => p.number === 2 ? { ...p, in_use: true } : p); });
        if (url.pathname === '/api/pdus/maintenance') return patch(j => {
          const t = Date.now() / 1000;
          j.pdus = { pdu3: { device_id: 'pdu3', started_at: t - 1500, started_by: 'admin', reason: 'Rewiring PSU feeds', outlets_off: [1, 2], failed: [] } };
          j.log = [{ at: t - 1500, device_id: 'pdu3', action: 'shutdown', by: 'admin', reason: 'Rewiring', ok: 2, failed: 0 },
                   { at: t - 1600, device_id: 'pdu3', action: 'denied', by: 'viewer', reason: '', ok: 0, failed: 0 }];
        });
        if (url.pathname === '/api/monitoring') return patch(j => { j.email_alerts.recent = [{ id: 'qa-alert', subject: '[DCIM alert] QA inlet current above 15 A', created_at: new Date(Date.now() - 600000).toISOString(), sent_at: null, attempts: 0, error: null }]; });
        return route.continue();
      });
      const page = await context.newPage();
      if (clock) await page.clock.install();
      page.on('pageerror', e => errors.push(`${role} ${viewport.width}: ${e.message}`));
      page.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) writes.push(`${role} ${r.method()} ${r.url()}`); });
      await page.goto(origin + '/?tab=display');
      await page.locator('.lab-display[data-loaded="true"]').waitFor({ timeout: 20000 });
      await page.waitForTimeout(600);
      return { context, page, state };
    }

    const text = (page, selector) => page.locator(selector).first().innerText();
    async function chromeFree(page, label) {
      const found = await page.evaluate(() => ({
        header: document.querySelectorAll('.app-header').length, footer: document.querySelectorAll('.app-footer').length,
        dialogs: document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length,
        controls: document.querySelectorAll('button, input, select, textarea, a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])').length,
        seen: (() => { try { return localStorage.getItem('dcim.seenVersion'); } catch { return 'unavailable'; } })(),
        scroll: [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight],
        clipped: [...document.querySelectorAll('.ld-panel-body, .ld-changes-body, .ld-tile, .ld-rack, .ld-attn, .ld-inuse-row, .ld-top, .ld-kpis, .ld-main')]
          .filter(e => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).map(e => e.className),
        outside: [...document.querySelectorAll('.lab-display *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5); }).length,
        title: document.title,
      }));
      assert.deepEqual([found.header, found.footer, found.dialogs, found.controls], [0, 0, 0, 0], `${label}: no header, footer, dialog or control`);
      assert.equal(found.seen, null, `${label}: What's new was not shown or marked seen`);
      assert.deepEqual(found.scroll, [0, 0], `${label}: the page does not scroll`);
      assert.deepEqual(found.clipped, [], `${label}: no panel is cut off`);
      assert.equal(found.outside, 0, `${label}: nothing outside the screen`);
      assert.match(found.title, /^Lab display/);
    }
    async function figures(page) {
      return page.evaluate(() => {
        const t = s => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim();
        return {
          on: t('[data-testid="kpi-on"] .ld-tile-value'), onSub: t('[data-testid="kpi-on"] .ld-tile-sub'), none: t('[data-testid="kpi-noreading"] .ld-tile-value'),
          pdus: t('[data-testid="kpi-pdus"] .ld-tile-value'), kvms: t('[data-testid="kpi-kvms"] .ld-tile-value'), power: t('[data-testid="kpi-power"] .ld-tile-value'),
          env: t('[data-testid="kpi-env"] dl'), racks: t('.ld-racks .ld-count'), attention: t('.ld-attention .ld-count'), inUse: t('.ld-inuse .ld-list'),
          firstAttention: t('.ld-attn strong'), changes: t('.ld-changes ul'),
        };
      });
    }
    // The pager reads "+N more · next in n s"; its data-page is "page/pages".
    const pager = (page, panel) => page.locator(`${panel} .ld-pager`).first().getAttribute('data-page', { timeout: 2000 }).catch(() => '');
    // Waits for the panel to turn to another page (every 10 s).
    const turned = (page, panel, from) => page.waitForFunction(([p, f]) => (document.querySelector(`${p} .ld-pager`)?.dataset.page || f) !== f, [panel, from], { timeout: 12000 });
    // Numbers are never cut off: every KPI value fits its box and has no ellipsis.
    async function numbersWhole(page, label) {
      const cut = await page.evaluate(() => [...document.querySelectorAll('.ld-tile-value, .ld-env dd, .ld-rack-servers strong, .ld-clock-time')]
        .filter(e => e.scrollWidth > e.clientWidth + 1 || /…/.test(e.innerText)).map(e => `${e.className}: ${e.innerText}`));
      assert.deepEqual(cut, [], `${label}: no number is cut off`);
    }
    // Every size follows the screen: `scale` is the screen's base size over 16 px (1 at 1920 x 1080, 0.8 at 1536 x 864),
    // so the minimums below are the 1920 x 1080 ones (read from 2-3 m on a 24-inch monitor) times that scale.
    async function textSizes(page, label, scale = 1) {
      const sizes = await page.evaluate(() => {
        const px = e => parseFloat(getComputedStyle(e).fontSize);
        const shown = e => e.getClientRects().length && e.innerText.trim();
        const texts = [...document.querySelectorAll('.lab-display *')].filter(e => e.getClientRects().length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
        const smallestOf = list => list.reduce((m, e) => (px(e) < m.px ? { px: px(e), what: `${e.className || e.tagName}: ${e.innerText.slice(0, 30)}` } : m), { px: Infinity });
        const words = [...document.querySelectorAll('.ld-attn-tag, .ld-rack-state, .ld-badge, .ld-conn-state, .ld-status, .ld-chip, .ld-maint-label, .ld-stale-banner')].filter(shown);
        const kpis = [...document.querySelectorAll('.ld-tile-value')].filter(shown);
        const titles = [...document.querySelectorAll('.ld-panel-head h2')].filter(shown);
        return { base: px(document.querySelector('.lab-display')), kpi: smallestOf(kpis), clock: px(document.querySelector('.ld-clock-time')),
          title: smallestOf(titles), attention: px(document.querySelector('.ld-attn strong')), smallest: smallestOf(texts), word: smallestOf(words), words: words.length };
      });
      // A hair under the round numbers: the base size is 0.8333vw, 15.9994 px at 1920.
      const min = n => n * scale - 0.05;
      assert.ok(sizes.base >= min(16) && sizes.kpi.px >= min(64) && sizes.clock >= min(76) && sizes.attention >= min(25) && sizes.title.px >= min(26),
        `${label}: ${JSON.stringify(sizes)}`);
      assert.ok(sizes.smallest.px >= min(22), `${label}: smallest text ${JSON.stringify(sizes.smallest)}`);
      assert.ok(sizes.words >= 5 && sizes.word.px >= min(28), `${label}: smallest status word ${JSON.stringify(sizes.word)}`);
      return sizes;
    }
    // Orderly: no text is wider than its box (no clipped number, status word or line), nothing overlaps (the screen's
    // blocks, and the lines inside a tile, rack card, Attention row or the top bar), nothing outside its block, no
    // scrollbar anywhere.
    async function orderly(page, label) {
      const found = await page.evaluate(() => {
        const name = e => `${e.className || e.tagName}: ${(e.innerText || '').replace(/\s+/g, ' ').slice(0, 40)}`;
        const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
        const texts = [...document.querySelectorAll('.lab-display *')].filter(e => visible(e) && getComputedStyle(e).display !== 'inline'
          && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
        // Wider than its box, wrapped onto a second line (two text boxes whose middles are most of a line apart; a small
        // unit beside a big number shares the line), or taller by more than the font's ascent / descent beyond a tight
        // line-height.
        const wrapped = e => {
          const range = document.createRange();
          range.selectNodeContents(e);
          const rects = [...range.getClientRects()].filter(q => q.width > 0.5);
          return rects.some(a => rects.some(b => Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) > 0.75 * Math.max(a.height, b.height)));
        };
        const overflow = texts.filter(e => e.scrollWidth > e.clientWidth + 1 || wrapped(e) || e.scrollHeight > e.clientHeight + 0.5 * parseFloat(getComputedStyle(e).fontSize))
          .map(e => `${name(e)} (${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight}${wrapped(e) ? ', wrapped' : ''})`);
        const overlap = (a, b) => { const r = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return Math.min(r.right, q.right) - Math.max(r.left, q.left) > 1 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 1; };
        const inside = (child, box) => { const r = child.getBoundingClientRect(), q = box.getBoundingClientRect(); return r.left >= q.left - 1 && r.right <= q.right + 1 && r.top >= q.top - 1 && r.bottom <= q.bottom + 1; };
        const pairs = list => { const out = []; list.forEach((a, i) => list.slice(i + 1).forEach(b => { if (overlap(a, b)) out.push(`${name(a)} / ${name(b)}`); })); return out; };
        const blocks = [...document.querySelectorAll('.ld-top, .ld-stale-banner, .ld-role-warn, .ld-tile, .ld-maint-band, .ld-panel, .ld-changes')].filter(visible);
        const overlaps = pairs(blocks), outside = [];
        for (const box of document.querySelectorAll('.ld-top, .ld-brand, .ld-conn, .ld-clock, .ld-tile, .ld-tile-row, .ld-tile-foot, .ld-env dl, .ld-env dl > div, .ld-maint-band, .ld-panel-head, .ld-rack, .ld-rack-grid, .ld-attn, .ld-attn-text, .ld-inuse-row, .ld-changes, .ld-changes li')) {
          const kids = [...box.children].filter(visible);
          overlaps.push(...pairs(kids));
          outside.push(...kids.filter(k => !inside(k, box)).map(k => `${name(k)} outside ${name(box)}`));
        }
        const scrollbars = [document.scrollingElement, ...document.querySelectorAll('.lab-display, .lab-display *')]
          .filter(e => { const s = getComputedStyle(e); return (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(s.overflowY)) || (e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(s.overflowX)); })
          .map(name);
        const page = [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight, innerWidth - document.documentElement.clientWidth];
        return { texts: texts.length, overflow, overlaps, outside, scrollbars, page };
      });
      assert.ok(found.texts > 40, `${label}: text found (${found.texts})`);
      assert.deepEqual(found.overflow, [], `${label}: no text wider or taller than its box`);
      assert.deepEqual(found.overlaps, [], `${label}: nothing overlaps`);
      assert.deepEqual(found.outside, [], `${label}: every line stays inside its block`);
      assert.deepEqual(found.scrollbars, [], `${label}: no scrollable box`);
      assert.deepEqual(found.page, [0, 0, 0], `${label}: no page scrollbar`);
      return found.texts;
    }

    // ── Viewer 1920 x 1080: content, two refresh cycles, network loss and recovery ──
    {
      const { context, page, state } = await open('viewer', { width: 1920, height: 1080 }, { clock: true });
      await chromeFree(page, 'viewer 1920');
      const f = await figures(page);
      snapshots.viewer = f;
      assert.deepEqual([f.on, f.onSub, f.none, f.pdus, f.kvms, f.power], ['24', 'of 28 · 0 off', '4', '6 / 7', '1 / 1', '3.96 kW']);
      assert.match(f.env, /Temp 22–28 °C Humidity 41–48 % Leak None/);
      assert.equal(f.racks, '8');
      assert.equal(f.firstAttention, 'QA inlet current above 15 A', 'alarms first');
      assert.match(f.inUse, /OPT12 KVM 01 · port 2/);
      assert.match(f.changes, /PDU 03 maintenance started · admin/);
      assert.doesNotMatch(f.changes, /denied|viewer/);
      const attention = await page.locator('.ld-attn:not(.ld-attn-more)').evaluateAll(rows => rows.map(r => [r.dataset.level, r.querySelector('strong').innerText]));
      const order = { alarm: 0, warn: 1, info: 2 };
      assert.ok(attention.every((row, i) => i === 0 || order[attention[i - 1][0]] <= order[row[0]]), 'attention sorted by severity');
      assert.ok(attention.some(([, t]) => t === 'PDU 07 unreachable') && attention.some(([, t]) => /^OPT7\d( not answering ping|: last ping failed)$/.test(t)), JSON.stringify(attention));
      assert.equal(await page.locator('[data-rack="Rack-03"] .ld-badge').innerText(), 'MAINT', 'maintenance badge');
      assert.equal(await page.locator('[data-rack="Rack-07"]').getAttribute('data-level'), 'alarm');
      // An unreachable PDU: the rack shows "—" for servers on, never a 0 that reads as "all off".
      assert.equal(await text(page, '[data-rack="Rack-07"] .ld-rack-servers strong'), '—', 'no reading is never 0');
      assert.equal(await text(page, '[data-rack="Rack-07"] .ld-rack-state'), 'Unreachable');
      // Status in words and shapes too: the top chip, PARTIAL power, the maintenance band with who and why.
      assert.match(await text(page, '[data-testid="lab-status"]'), /^\d+ ALARMS?$/);
      assert.equal(await page.locator('[data-testid="kpi-power"]').getAttribute('data-level'), 'warn');
      assert.equal(await text(page, '[data-testid="kpi-power-chip"]'), 'PARTIAL');
      assert.match((await text(page, '[data-testid="maint-band"]')).replace(/\s+/g, ' '), /^MAINTENANCE IN PROGRESS Rack-03 · PDU 03 · outlets 1, 2 off since \d\d:\d\d · admin · Rewiring PSU feeds$/);
      assert.equal(await page.locator('[data-testid="maint-band"] bdi[dir="auto"]').count(), 4, 'user text isolated in <bdi dir="auto">');
      assert.equal(await page.locator('[data-testid="role-warning"]').count(), 0, 'no role warning for a Viewer');
      assert.equal(await text(page, '[data-testid="display-role"]'), 'Viewer');
      assert.equal(await page.locator('.ld-attn[data-level="alarm"]').first().evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 79, 79)', 'alarm rows are a solid fill');
      checks.push('viewer 1920: KPIs, environment, racks (Rack-07 "—"), attention order, status chip, PARTIAL power, maintenance band, consoles in use, recent changes');
      // Readable from 2-3 m on a 24-inch monitor: big numbers, large text, an orderly grid.
      const sizes = await textSizes(page, 'viewer 1920');
      await numbersWhole(page, 'viewer 1920');
      const lines = await orderly(page, 'viewer 1920');
      checks.push(`viewer 1920: smallest text ${sizes.smallest.px}px, status words ${sizes.word.px}px, panel titles ${sizes.title.px}px, KPI ${sizes.kpi.px}px, clock ${sizes.clock}px; ${lines} text boxes, none cut off or overlapping`);
      await page.screenshot({ path: path.join(shots, 'viewer-1920x1080.png') });

      // Two refresh cycles: the same DOM stays (no blanking or re-mount), no memory growth.
      await page.evaluate(() => {
        window.__qaNode = document.querySelector('[data-testid="kpi-on"] .ld-tile-value');
        window.__qaBlank = 0;
        new MutationObserver(() => { if (document.querySelector('.lab-display')?.dataset.loaded !== 'true' || document.querySelector('.ld-first')) window.__qaBlank++; })
          .observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      // JS heap after a full garbage collection (Chrome DevTools Protocol), before and after the cycles.
      const cdp = await context.newCDPSession(page);
      const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
      const heap0 = await heap();
      assert.ok(heap0 > 0, 'heap size is measured');
      const gets0 = state.devicesGets;
      await page.waitForFunction(() => true);
      const deadline = Date.now() + 45000;
      while (state.devicesGets < gets0 + 2 && Date.now() < deadline) await page.waitForTimeout(500);
      assert.ok(state.devicesGets >= gets0 + 2, `two refresh cycles ran (${state.devicesGets - gets0})`);
      await page.waitForTimeout(1500);
      const heap1 = await heap();
      const kept = await page.evaluate(() => ({ same: window.__qaNode.isConnected, blank: window.__qaBlank }));
      assert.deepEqual(kept, { same: true, blank: 0 }, 'refresh keeps the page in place');
      assert.ok(heap1 - heap0 < 2_000_000, `heap growth ${heap1 - heap0} bytes over two cycles`);
      assert.match(await text(page, '.ld-conn-updated'), /^Updated (just now|\d+ s ago)\s+Viewer$/);
      assert.equal(await text(page, '.ld-conn-state'), 'Live');
      checks.push(`viewer 1920: two refresh cycles without re-mount (heap ${heap0} -> ${heap1})`);

      // Attention rotates (8+ items, two pages at this size).
      const before = await pager(page, '.ld-attention');
      assert.match(before, /^\d\/[2-9]$/);
      assert.match(await text(page, '.ld-attention .ld-pager'), /^\+\d+ more · next in \d+ s$/);
      const pinned = await page.locator('.ld-attn').evaluateAll(rows => rows.map(r => r.dataset.level));
      const titles = await page.locator('.ld-attn strong').allInnerTexts();
      await turned(page, '.ld-attention', before);
      const after = await pager(page, '.ld-attention');
      const pinnedAfter = await page.locator('.ld-attn').evaluateAll(rows => rows.map(r => r.dataset.level));
      assert.equal(pinnedAfter.filter(l => l === 'alarm').length, pinned.filter(l => l === 'alarm').length, 'alarms stay pinned on every page');
      assert.notDeepEqual(await page.locator('.ld-attn strong').allInnerTexts(), titles, 'another page of the list');
      checks.push(`viewer 1920: attention rotates (${before} -> ${after})`);

      // Network loss: the last data stays, the state says Reconnecting, then Connection lost with the NOT LIVE banner.
      state.offline = true;
      await page.waitForFunction(() => document.querySelector('.ld-conn-state')?.innerText === 'Reconnecting…', null, { timeout: 20000 });
      assert.equal((await figures(page)).on, '24', 'data kept while offline');
      await page.clock.fastForward('01:05');
      await page.waitForFunction(() => document.querySelector('[data-testid="stale-banner"]') && document.querySelector('.ld-conn-state')?.innerText === 'Connection lost', null, { timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('.lab-display').dataset.stale === 'true', null, { timeout: 15000 });
      assert.equal((await figures(page)).pdus, '6 / 7', 'data kept while stale');
      assert.match(await text(page, '[data-testid="stale-banner"]'), /^NOT LIVE · last update \d\d:\d\d \(\d+ (s|min) ago\) · Lab Manager is not answering$/);
      const greyed = await page.evaluate(() => ['.ld-kpis', '.ld-main', '.ld-changes'].map(s => getComputedStyle(document.querySelector(s)).filter));
      assert.deepEqual(greyed, ['grayscale(1)', 'grayscale(1)', 'grayscale(1)'], 'panels grey while not live');
      assert.equal(await text(page, '[data-testid="inuse-unknown"]'), 'Unknown while the display is not live');
      const bannerPx = await page.locator('[data-testid="stale-banner"]').evaluate(e => parseFloat(getComputedStyle(e).fontSize));
      assert.ok(bannerPx >= 31.9, `banner ${bannerPx}px`);
      await chromeFree(page, 'viewer 1920 stale');
      await orderly(page, 'viewer 1920 stale');
      await page.screenshot({ path: path.join(shots, 'viewer-1920x1080-stale.png') });
      checks.push('viewer 1920: network loss keeps the data, shows Reconnecting, then Connection lost, NOT LIVE banner, greyed panels');
      state.offline = false;
      await page.waitForFunction(() => document.querySelector('.ld-conn-state')?.innerText === 'Live' && !document.querySelector('[data-testid="stale-banner"]'), null, { timeout: 25000 });
      assert.equal(await page.evaluate(() => window.__qaNode.isConnected), true);
      checks.push('viewer 1920: recovers by itself after the network returns');

      // One source keeps failing for more than a minute: its last copy is not shown as current.
      state.failMaintenance = true;
      const gets1 = state.devicesGets;
      for (let i = 0; i < 100 && state.devicesGets < gets1 + 1; i++) { await page.clock.fastForward(1000); await page.waitForTimeout(300); }
      await page.clock.fastForward('01:05');
      await page.waitForFunction(() => document.querySelector('.ld-conn-state')?.innerText === 'Live · partial', null, { timeout: 25000 });
      assert.equal(await page.locator('[data-testid="maint-band"]').getAttribute('data-level'), 'warn');
      assert.match(await text(page, '[data-testid="maint-band"]'), /Maintenance status unavailable since \d\d:\d\d/);
      assert.equal(await page.locator('[data-rack="Rack-03"] .ld-badge').count(), 0, 'no MAINT badge from an old copy');
      await page.screenshot({ path: path.join(shots, 'viewer-1920x1080-partial.png') });
      state.failMaintenance = false;
      for (let i = 0; i < 100 && await text(page, '.ld-conn-state') !== 'Live'; i++) { await page.clock.fastForward(1000); await page.waitForTimeout(300); }
      assert.equal(await text(page, '.ld-conn-state'), 'Live');
      checks.push('viewer 1920: a source failing for over 60 s shows "Live · partial" and "Maintenance status unavailable"');
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── Operator 1920 x 1080: exactly the same screen as the Viewer, two cycles ──
    {
      const { context, page, state } = await open('operator', { width: 1920, height: 1080 });
      await chromeFree(page, 'operator 1920');
      const f = await figures(page);
      snapshots.operator = f;
      const comparable = s => ({ ...s, changes: s.changes.replace(/\d\d:\d\d/g, 'hh:mm') });
      assert.deepEqual(comparable(f), comparable(snapshots.viewer), 'Viewer and Operator see the same');
      assert.equal(await text(page, '[data-testid="role-warning"]'), 'Signed in as Operator — use a Viewer account for this screen');
      assert.equal(await text(page, '[data-testid="display-role"]'), 'Operator');
      const gets0 = state.devicesGets;
      const deadline = Date.now() + 45000;
      while (state.devicesGets < gets0 + 2 && Date.now() < deadline) await page.waitForTimeout(500);
      assert.ok(state.devicesGets >= gets0 + 2, 'operator: two refresh cycles');
      await chromeFree(page, 'operator 1920 after refresh');
      await orderly(page, 'operator 1920 (role warning)');
      await page.screenshot({ path: path.join(shots, 'operator-1920x1080.png') });
      checks.push('operator 1920: same figures as the Viewer, role warning, two refresh cycles, read-only');
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── The 24-inch monitor at 125 % scaling (1536 x 864) and other common sizes: the same layout to scale, orderly ──
    for (const [width, height] of [[1536, 864], [1920, 1200], [2560, 1440]]) {
      const { context, page } = await open('viewer', { width, height });
      const label = `viewer ${width}x${height}`;
      await chromeFree(page, label);
      const scale = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.lab-display')).fontSize) / 16);
      assert.ok(Math.abs(scale - Math.min(width / 1920, height / 1080)) < 0.01, `${label}: base follows the screen (${scale})`);
      const sizes = await textSizes(page, label, scale);
      await numbersWhole(page, label);
      const lines = await orderly(page, label);
      const f = await figures(page);
      assert.deepEqual([f.on, f.none, f.pdus, f.kvms, f.power], ['24', '4', '6 / 7', '1 / 1', '3.96 kW']);
      await page.screenshot({ path: path.join(shots, `viewer-${width}x${height}.png`) });
      checks.push(`${label}: scale ${scale.toFixed(3)}, smallest text ${sizes.smallest.px.toFixed(1)}px, ${lines} text boxes, none cut off or overlapping`);
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── 1280 x 720: still fits; many racks rotate through pages ──
    for (const role of ['operator', 'viewer']) {
      const { context, page } = await open(role, { width: 1280, height: 720 }, { extraRacks: role === 'operator' });
      await chromeFree(page, `${role} 1280`);
      if (role === 'operator') {
        assert.equal(await text(page, '.ld-racks .ld-count'), '30');
        const first = await pager(page, '.ld-racks');
        assert.match(first, /^\d\/2$/, 'compact cards: 30 racks in two pages');
        assert.equal(await page.locator('.ld-rack-grid').getAttribute('data-compact'), 'true');
        await orderly(page, 'operator 1280 compact racks');
        const names = () => page.locator('.ld-rack h3').allInnerTexts();
        const page1 = await names();
        await turned(page, '.ld-racks', first);
        const page2 = await names();
        assert.ok(page2.length && page2.every(n => !page1.includes(n)), 'the next page shows other racks');
        await chromeFree(page, 'operator 1280 page 2');
        checks.push(`operator 1280: 30 racks rotate (${first}, ${page1.length} per page)`);
      } else {
        assert.equal((await figures(page)).on, '24');
        checks.push('viewer 1280: fits without scrolling');
      }
      await page.screenshot({ path: path.join(shots, `${role}-1280x720.png`) });
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── 960 x 540 (many TV browsers and sticks): the 1920 layout at half size, nothing cut off ──
    {
      const { context, page } = await open('viewer', { width: 960, height: 540 });
      await chromeFree(page, 'viewer 960');
      const base = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.lab-display')).fontSize));
      assert.ok(Math.abs(base - 8) < 0.1, `960 base size ${base}`);
      await numbersWhole(page, 'viewer 960');
      const f = await figures(page);
      assert.deepEqual([f.on, f.none, f.pdus, f.kvms, f.power], ['24', '4', '6 / 7', '1 / 1', '3.96 kW']);
      await page.screenshot({ path: path.join(shots, 'viewer-960x540.png') });
      checks.push('viewer 960x540: fits, no number cut off');
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── First load while Lab Manager does not answer: plain words, no raw browser error ──
    {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      assert.equal((await context.request.post(origin + '/api/auth/login', { data: { username: 'viewer', password: PASSWORD } })).status(), 200);
      await context.route('**/*', route => {
        const url = route.request().url();
        if (!url.startsWith(origin + '/')) return route.abort();
        return new URL(url).pathname.startsWith('/api/devices') ? route.abort('internetdisconnected') : route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`first offline: ${e.message}`));
      await page.goto(origin + '/?tab=display');
      await page.waitForFunction(() => document.querySelector('.ld-first p')?.innerText === 'Lab Manager is not answering. Retrying every 15 s.', null, { timeout: 20000 });
      assert.equal(await text(page, '.ld-conn-state'), 'Connecting…', 'never Reconnecting before a first connection');
      checks.push('first load offline: "Lab Manager is not answering. Retrying every 15 s."');
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── A phone or portrait screen: a notice instead of the TV layout ──
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      assert.equal((await context.request.post(origin + '/api/auth/login', { data: { username: 'viewer', password: PASSWORD } })).status(), 200);
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`viewer 390: ${e.message}`));
      await page.goto(origin + '/?tab=display');
      assert.equal(await text(page, '[data-testid="display-narrow"]'), 'The lab display is made for a landscape TV. Open the Dashboard on this device.');
      checks.push('viewer 390x844: landscape-TV notice');
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── Signed out: the sign-in is drawn at TV scale and names the Viewer account ──
    {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`signed out: ${e.message}`));
      await page.goto(origin + '/?tab=display');
      const title = page.locator('.auth-tv #sign-in-title');
      await title.waitFor({ timeout: 15000 });
      assert.equal(await title.innerText(), "Lab display signed out — sign in with the lab's Viewer account");
      const px = await title.evaluate(e => parseFloat(getComputedStyle(e).fontSize));
      assert.ok(px >= 35, `TV sign-in title ${px}px`);
      assert.equal(await page.locator('.auth-tv input[name="remember"]').isChecked(), true);
      await page.screenshot({ path: path.join(shots, 'signed-out-1920x1080.png') });
      checks.push(`signed out 1920: TV-scale sign-in (title ${px}px), Keep me signed in ticked`);
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── 3840 x 2160: the same layout at twice the size ──
    {
      const { context, page } = await open('viewer', { width: 3840, height: 2160 });
      await chromeFree(page, 'viewer 3840');
      const base = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.lab-display')).fontSize));
      assert.ok(base >= 31.9, `4K base size ${base}`);
      await page.screenshot({ path: path.join(shots, 'viewer-3840x2160.png') });
      checks.push('viewer 3840: scales to 32 px base and fits');
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── The header link, for both roles: a new tab with the display ──
    for (const role of ['viewer', 'operator']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch {} });
      assert.equal((await context.request.post(origin + '/api/auth/login', { data: { username: role, password: PASSWORD } })).status(), 200);
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${role} header: ${e.message}`));
      await page.goto(origin + '/?tab=dashboard');
      const link = page.getByRole('link', { name: 'Lab display (TV)' });
      assert.equal(await link.getAttribute('href'), '/?tab=display');
      assert.equal(await link.getAttribute('target'), '_blank');
      const [tv] = await Promise.all([context.waitForEvent('page'), link.click()]);
      tv.on('pageerror', e => errors.push(`${role} tv: ${e.message}`));
      tv.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) writes.push(`${role} tv ${r.method()} ${r.url()}`); });
      await tv.locator('.lab-display[data-loaded="true"]').waitFor({ timeout: 20000 });
      assert.equal(new URL(tv.url()).searchParams.get('tab'), 'display');
      assert.equal(await page.locator('.app-header').count(), 1, 'the original tab stays on the site');
      checks.push(`${role}: header link "Lab display (TV)" opens the display in a new tab`);
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    assert.deepEqual(writes, [], 'the display sends GET requests only');
    assert.deepEqual(errors, [], 'no page errors');
    console.log(JSON.stringify({ passed: checks, writes, errors, shots }, null, 1));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
