// Lab display (?tab=display): the read-only wall TV page. Viewer and Operator, 1920 x 1080, 1280 x 720 and 3840 x 2160.
// Checks: only GET requests, no page errors, no header / footer / assistant / What's new / dialogs / controls, no
// scrolling or clipped panels, the numbers the fixture implies, two refresh cycles without re-mounting or memory
// growth, page rotation, a network loss (last data kept, Reconnecting, stale badge) and the recovery, and the header
// link for both roles. Extra readings (sensors, an open console, maintenance, an email alert, many racks) are added
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
      const state = { offline: false, devicesGets: 0 };
      await context.route('**/*', async route => {
        const request = route.request();
        if (!request.url().startsWith(origin + '/')) return route.abort();
        const url = new URL(request.url());
        if (state.offline && url.pathname.startsWith('/api/')) return route.abort('internetdisconnected');
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
        clipped: [...document.querySelectorAll('.ld-panel-body, .ld-changes-body, .ld-tile, .ld-rack, .ld-attn, .ld-loadrow, .ld-inuse-row, .ld-top, .ld-kpis, .ld-main')]
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
          on: t('[data-testid="kpi-on"] .ld-tile-value'), off: t('[data-testid="kpi-off"] .ld-tile-value'), none: t('[data-testid="kpi-noreading"] .ld-tile-value'),
          pdus: t('[data-testid="kpi-pdus"] .ld-tile-value'), kvms: t('[data-testid="kpi-kvms"] .ld-tile-value'), power: t('[data-testid="kpi-power"] .ld-tile-value'),
          env: t('[data-testid="kpi-env"] dl'), racks: t('.ld-racks .ld-count'), attention: t('.ld-attention .ld-count'), inUse: t('.ld-inuse .ld-list'),
          firstAttention: t('.ld-attn strong'), changes: t('.ld-changes ul'),
        };
      });
    }
    const pager = (page, panel) => page.locator(`${panel} .ld-pager-text`).evaluate(e => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
    // Waits for the panel to turn to another page (every 10 s).
    const turned = (page, panel, from) => page.waitForFunction(([p, f]) => (document.querySelector(`${p} .ld-pager-text`)?.textContent.replace(/\s+/g, ' ').trim() || f) !== f, [panel, from], { timeout: 12000 });

    // ── Viewer 1920 x 1080: content, two refresh cycles, network loss and recovery ──
    {
      const { context, page, state } = await open('viewer', { width: 1920, height: 1080 }, { clock: true });
      await chromeFree(page, 'viewer 1920');
      const f = await figures(page);
      snapshots.viewer = f;
      assert.deepEqual([f.on, f.off, f.none, f.pdus, f.kvms, f.power], ['24', '0', '4', '6 / 7', '1 / 1', '3.96 kW']);
      assert.match(f.env, /Temp 22–28 °C Humidity 41–48 % Leak None/);
      assert.equal(f.racks, '8');
      assert.equal(f.firstAttention, 'QA inlet current above 15 A', 'alarms first');
      assert.match(f.inUse, /OPT12 KVM 01 · port 2/);
      assert.match(f.changes, /PDU 03 maintenance started · admin/);
      assert.doesNotMatch(f.changes, /denied|viewer/);
      const attention = await page.locator('.ld-attn').evaluateAll(rows => rows.map(r => [r.dataset.level, r.querySelector('strong').innerText]));
      const order = { alarm: 0, warn: 1, info: 2 };
      assert.ok(attention.every((row, i) => i === 0 || order[attention[i - 1][0]] <= order[row[0]]), 'attention sorted by severity');
      assert.ok(attention.some(([, t]) => t === 'PDU 07 unreachable') && attention.some(([, t]) => /^OPT7\d( not answering ping|: last ping failed)$/.test(t)), JSON.stringify(attention));
      assert.equal(await page.locator('[data-rack="Rack-03"] .ld-badge').innerText(), 'MAINT', 'maintenance badge');
      assert.equal(await page.locator('[data-rack="Rack-07"]').getAttribute('data-level'), 'alarm');
      checks.push('viewer 1920: KPIs, environment, racks, attention order, consoles in use, recent changes');
      // Readable from 3 m: big numbers, large text.
      const sizes = await page.evaluate(() => ({ base: parseFloat(getComputedStyle(document.querySelector('.lab-display')).fontSize),
        kpi: parseFloat(getComputedStyle(document.querySelector('.ld-tile-value')).fontSize),
        clock: parseFloat(getComputedStyle(document.querySelector('.ld-clock-time')).fontSize),
        attention: parseFloat(getComputedStyle(document.querySelector('.ld-attn strong')).fontSize),
        smallest: Math.min(...[...document.querySelectorAll('.lab-display *')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => parseFloat(getComputedStyle(e).fontSize))) }));
      assert.ok(sizes.base >= 15.9 && sizes.kpi >= 56 && sizes.clock >= 64 && sizes.attention >= 22 && sizes.smallest >= 15, JSON.stringify(sizes));
      checks.push(`viewer 1920: text sizes ${JSON.stringify(sizes)}`);
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
      assert.match(await text(page, '.ld-conn-updated'), /^Updated (just now|\d+ s ago)$/);
      assert.equal(await text(page, '.ld-conn-state'), 'Live');
      checks.push(`viewer 1920: two refresh cycles without re-mount (heap ${heap0} -> ${heap1})`);

      // Attention rotates (8+ items, two pages at this size).
      const before = await pager(page, '.ld-attention');
      assert.match(before, /^Page \d \/ [2-9]$/);
      const titles = await page.locator('.ld-attn strong').allInnerTexts();
      await turned(page, '.ld-attention', before);
      const after = await pager(page, '.ld-attention');
      assert.notDeepEqual(await page.locator('.ld-attn strong').allInnerTexts(), titles, 'another page of the list');
      checks.push(`viewer 1920: attention rotates (${before} -> ${after})`);

      // Network loss: the last data stays, the state says Reconnecting, then Connection lost with a stale badge.
      state.offline = true;
      await page.waitForFunction(() => document.querySelector('.ld-conn-state')?.innerText === 'Reconnecting…', null, { timeout: 20000 });
      assert.equal((await figures(page)).on, '24', 'data kept while offline');
      await page.clock.fastForward('01:05');
      await page.waitForFunction(() => document.querySelector('[data-testid="stale-badge"]') && document.querySelector('.ld-conn-state')?.innerText === 'Connection lost', null, { timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('.lab-display').dataset.stale === 'true', null, { timeout: 15000 });
      assert.equal((await figures(page)).pdus, '6 / 7', 'data kept while stale');
      await chromeFree(page, 'viewer 1920 stale');
      await page.screenshot({ path: path.join(shots, 'viewer-1920x1080-stale.png') });
      checks.push('viewer 1920: network loss keeps the data, shows Reconnecting, then Connection lost + stale badge');
      state.offline = false;
      await page.waitForFunction(() => document.querySelector('.ld-conn-state')?.innerText === 'Live' && !document.querySelector('[data-testid="stale-badge"]'), null, { timeout: 25000 });
      assert.equal(await page.evaluate(() => window.__qaNode.isConnected), true);
      checks.push('viewer 1920: recovers by itself after the network returns');
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
      const gets0 = state.devicesGets;
      const deadline = Date.now() + 45000;
      while (state.devicesGets < gets0 + 2 && Date.now() < deadline) await page.waitForTimeout(500);
      assert.ok(state.devicesGets >= gets0 + 2, 'operator: two refresh cycles');
      await chromeFree(page, 'operator 1920 after refresh');
      await page.screenshot({ path: path.join(shots, 'operator-1920x1080.png') });
      checks.push('operator 1920: same figures as the Viewer, two refresh cycles, read-only');
      await context.unrouteAll({ behavior: "ignoreErrors" }); await context.close();
    }

    // ── 1280 x 720: still fits; many racks rotate through pages ──
    for (const role of ['operator', 'viewer']) {
      const { context, page } = await open(role, { width: 1280, height: 720 }, { extraRacks: role === 'operator' });
      await chromeFree(page, `${role} 1280`);
      if (role === 'operator') {
        assert.equal(await text(page, '.ld-racks .ld-count'), '30');
        const first = await pager(page, '.ld-racks');
        assert.match(first, /^Page \d \/ [2-9]$/);
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
