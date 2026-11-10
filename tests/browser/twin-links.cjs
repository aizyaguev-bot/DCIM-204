// "Show in 3D" and live sync, 3D twin side (WP4), on the isolated fixture (tests/browser/preview-server.py with
// DCIM_TEST_ACCOUNTS=1 and a frontend build in DCIM_PREVIEW_DIST). The shared interface (frontend/src/twinLinks.js):
// ref = srv:<optKey> | item:<rack item id> | rack:<rack name>; /twin/index.html?embed=1&select=<encoded ref>; Lab
// Manager posts {type:'twin:select', ref} and {type:'twin:data-changed', domains} (same origin, its window) and the
// twin answers each selection the user makes with {type:'twin:selected', ref|null}.
// TL-1 ?select=srv:opt12 / rack:Rack-03 (any case) / item:ci-3 select, Focus and open the panel; an unknown ref toasts
//      "Not found in the 3D: <ref>" and changes nothing
// TL-2 the selection is kept per browser tab (sessionStorage twin.sel) and restored without a flight on a reload;
//      embedded, a restored selection is reported to Lab Manager (its address gets ?select=)
// TL-3 Lab Manager: "Show Rack-03 in 3D" ends with the iframe's __twin.S.selected = Rack-03's setup; a second Show in 3D
//      (OPT31) while the twin is loaded switches the selection without reloading the iframe
// TL-4 a selection made in the twin replaces Lab Manager's ?select= (no new history entry); closing it drops it; a ref
//      the twin cannot find (an old address with rack:Storage-Main) changes nothing there and the address follows what it still shows
// TL-5 cross-origin messages (and a same-origin one from another window) are ignored by the twin and by Lab Manager
// TL-6 twin:data-changed after an owner change via the API refreshes the twin within 3 s; power / monitoring alone do
//      not; while the user is moving something it waits until the move ends; a twin:select while the move dialog is
//      open ends the Move and closes its dialog (nothing written)
// TL-7 hidden on another Lab Manager tab the twin does ~no work (measured over 30 s: frames, ticks, requests, the page's
//      main-thread task time against Lab Manager alone); shown again it resumes with one refresh; a standalone twin pauses
//      on document.hidden; embedded, it never reads /api/changes; standalone, the missing feed (404) is quiet; shown
//      with unsaved editor input the refresh waits until the input is done; an ancestor of the iframe hidden pauses too
// TL-8 Lab Manager links (target _top): Open in Racks (server, unit, rack: ?tab=racks&rack=), Full history in Scan &
//      Track (unit: ?tab=scan), Manage maintenance in Power (PDU: ?tab=power); Open in Racks opens that rack's Racks page
// TL-9 a unit on OPT11's floor shows OPT11's owner (panel, inventory, search, read-only editor with the note); a unit on
//      no server's floor keeps its own; a new owner of OPT11 reaches the unit; two servers on one floor: the first in
//      slot order (rack-positions, then name) like Racks; on a storage-type rack "the server on this shelf"
// TL-10 PDUs and KVMs stay where they are after a server move (model place and 3D position); outlet labels "KVM Power"
//      and "empty" are no servers and never get a key in the rack-layout write; the Move tool refuses PDUs / KVMs, and
//      units (rack items) of type KVM / PDU, also as the other half of a swap
// Writes only fixture data (temporary folder): owners of opt11 / opt12 / item:ci-1 / item:storage-fixture, Switch 01's U
// (PUT /api/rack-items with If-Match), one server move (PUT /api/rack-layout), OPT11 / OPT12 onto Rack-01 U1 (PUT
// /api/rack-layout, twice). No hardware; evil.test is answered by the test itself (never resolved).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const PASSWORD = 'test-password-123';
const EVIL = 'http://evil.test';
const FRAME = 'iframe[title="3D Digital Twin"]';
const MEASURE_MS = Number(process.env.TWIN_HIDDEN_MEASURE_MS || 30000);
const NON_SERVER = /^(empty|kvm[\s_-]*power|pdu|spare|free|n\/a|-+)$/i;   // NON_SERVER_LABEL in lab-twin/app.js
// a cross-origin page inside Lab Manager: posts to the twin's window and to Lab Manager, then reports it did
const EVIL_PAGE = `<!doctype html><script>
  const twin = [...Array(parent.frames.length).keys()].map(i => parent.frames[i]).find(w => w !== window);
  twin.postMessage({ type: 'twin:select', ref: 'rack:Rack-05' }, '*');
  twin.postMessage({ type: 'twin:data-changed', domains: ['owners', 'layout'] }, '*');
  parent.postMessage({ type: 'twin:selected', ref: 'rack:Rack-05' }, '*');
  parent.postMessage({ type: 'probe' }, '*');
</script>`;

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const passed = [], errors = [], unexpected = [], measured = [];
  const pass = m => { passed.push(m); if (process.env.DCIM_QA_VERBOSE) console.error(new Date().toISOString().slice(11, 19) + ' ok: ' + m); };
  const allowed = [/^\/api\/auth\/login$/, /^\/api\/rack-layout$/];   // the page's own writes (API writes below use ctx.request)
  async function session(username, viewport = { width: 1440, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* blocked */ } });
    await ctx.route('**/*', route => {
      const req = route.request(), url = req.url();
      if (url.startsWith(EVIL + '/')) return route.fulfill({ status: 200, contentType: 'text/html', body: EVIL_PAGE });
      if (!url.startsWith(origin + '/')) return route.abort();
      const path = new URL(url).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !allowed.some(re => re.test(path))) { unexpected.push(req.method() + ' ' + path); return route.abort(); }
      return route.continue();
    });
    const login = await ctx.request.post(origin + '/api/auth/login', { data: { username, password: PASSWORD } });
    assert.equal(login.status(), 200, username + ' login');
    assert.equal((await (await ctx.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    return { ctx, csrf: (await login.json()).csrf_token };
  }
  async function open(ctx, path) {
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(path + ': ' + e.message));
    p.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
    await p.goto(origin + path);
    return p;
  }
  const ready = t => t.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.recs.size > 10 && window.__twin.S.live.pdu?.pdu1, null, { timeout: 60000 });
  const idle = t => t.waitForFunction(() => !window.__twin.S.tween, null, { timeout: 15000 });
  const selected = (t, id, timeout = 15000) => t.waitForFunction(id => window.__twin?.S.selected === id, id, { timeout });
  const twinFrame = p => p.frames().find(f => /\/twin\/index\.html/.test(f.url()));
  async function frameOf(p) { for (let i = 0; i < 300; i++) { const f = twinFrame(p); if (f) return f; await p.waitForTimeout(100); } throw new Error('no twin frame'); }
  const fromTwin = r => { try { return /\/twin\//.test(r.frame().url()); } catch { return false; } };
  const apiPath = r => new URL(r.url()).pathname;
  // what Focus framed: the object's centre on screen, how far the camera is, and the open panel
  const focusOf = (t, id) => t.evaluate(id => {
    const tw = window.__twin, r = tw.S.recs.get(id); tw.scene.updateMatrixWorld(true);
    const box = new THREE.Box3(); if (r.cat === 'setup') box.setFromObject(r.group); else r.meshes.forEach(m => box.expandByObject(m));
    const c = box.getCenter(new THREE.Vector3()), q = c.clone().project(tw.camera);
    return { dist: +tw.camera.position.distanceTo(c).toFixed(2), onScreen: Math.abs(q.x) < 1 && Math.abs(q.y) < 1 && q.z < 1,
      panel: !document.querySelector('#detail').classList.contains('hidden'), name: document.querySelector('#dName').textContent, view: tw.S.view };
  }, id);
  const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  // JavaScript self time (ms) of the twin's own scripts (/twin/…) in a CPU profile of the page (same-origin frames share it)
  const twinScriptMs = profile => { const byId = new Map(profile.nodes.map(n => [n.id, n])); let us = 0;
    profile.samples.forEach((id, i) => { if (/\/twin\//.test(byId.get(id)?.callFrame.url || '')) us += profile.timeDeltas[i] || 0; }); return us / 1000; };
  try {
    const { ctx, csrf } = await session('operator');
    const H = { 'X-DCIM-CSRF': csrf };
    const engineers = (await (await ctx.request.get(origin + '/api/engineers')).json()).filter(e => e.active);
    assert.ok(engineers.length >= 3, 'the fixture lists active engineers');
    const setOwner = async (key, person) => {
      const r = await ctx.request.put(origin + '/api/opt-owners/' + encodeURIComponent(key), { data: { engineer_id: person ? person.id : null }, headers: H });
      assert.equal(r.status(), 200, 'owner of ' + key);
    };

    // ── TL-1: ?select= on a standalone twin ──
    for (const [ref, want, name] of [['srv:opt12', 'LIVE-opt12', 'OPT12'], ['rack:Rack-03', 'SETUP-003', 'Rack-03'], ['rack:rack-03', 'SETUP-003', 'Rack-03'], ['item:ci-3', 'LIVE-ci-3', 'Switch 03']]) {
      const p = await open(ctx, '/twin/index.html?embed=1&select=' + encodeURIComponent(ref));
      await selected(p, want, 60000); await idle(p);
      const f = await focusOf(p, want);
      assert.equal(f.panel, true, ref + ': the detail panel is open');
      assert.equal(f.name, name, ref + ': the panel shows it');
      assert.equal(f.onScreen, true, ref + ': Focus brings it on screen');
      assert.ok(f.dist < (want.startsWith('SETUP') ? 6 : 3.5), `${ref}: Focus flew to it (camera ${f.dist} m away)`);
      assert.equal(await p.evaluate(() => sessionStorage.getItem('twin.sel')), ref === 'rack:rack-03' ? 'rack:Rack-03' : ref);
      await p.close();
    }
    {
      const p = await open(ctx, '/twin/index.html?embed=1&select=' + encodeURIComponent('srv:nope'));
      await p.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some(t => t.textContent === 'Not found in the 3D: srv:nope'), null, { timeout: 60000 });
      await ready(p);
      assert.equal(await p.evaluate(() => window.__twin.S.selected), null, 'an unknown ref selects nothing');
      await p.close();
    }
    pass('TL-1 /twin/?embed=1&select=srv:opt12 selects OPT12 (panel open, Focus: on screen, camera < 3.5 m); rack:Rack-03 and rack:rack-03 select SETUP-003 (Rack-03); item:ci-3 selects LIVE-ci-3 (Switch 03); srv:nope toasts "Not found in the 3D: srv:nope" and selects nothing');

    // ── TL-2: kept for this browser tab, restored on a reload without ?select (no flight) ──
    {
      const p = await open(ctx, '/twin/'); await ready(p);
      await p.locator('#search').fill('OPT21'); await p.locator('#search').press('Enter');
      await selected(p, 'LIVE-opt21');
      assert.equal(await p.evaluate(() => sessionStorage.getItem('twin.sel')), 'srv:opt21');
      await p.reload(); await ready(p); await selected(p, 'LIVE-opt21');
      const f = await focusOf(p, 'LIVE-opt21');
      assert.deepEqual([f.panel, f.view], [true, 'orbit'], 'restored with its panel, the camera stays on the overview');
      await p.locator('#dClose').click();
      assert.equal(await p.evaluate(() => sessionStorage.getItem('twin.sel')), null, 'closing forgets it');
      await p.reload(); await ready(p); await p.waitForTimeout(800);
      assert.equal(await p.evaluate(() => window.__twin.S.selected), null);
      await p.close();
    }
    {
      // embedded: the restored selection is reported, so Lab Manager's address names it again
      const p = await open(ctx, '/?tab=twin'); let t = await frameOf(p); await ready(t);
      await t.locator('#search').fill('OPT21'); await t.locator('#search').press('Enter');
      await p.waitForFunction(() => new URL(location.href).searchParams.get('select') === 'srv:opt21', null, { timeout: 5000 });
      await p.goto(origin + '/?tab=twin');   // the same browser tab, an address without ?select
      t = await frameOf(p); await ready(t); await selected(t, 'LIVE-opt21');
      await p.waitForFunction(() => new URL(location.href).searchParams.get('select') === 'srv:opt21', null, { timeout: 5000 });
      await p.close();
    }
    pass('TL-2 a selection is kept in sessionStorage twin.sel (srv:opt21) and restored after a reload with its panel, without a flight (view stays Overview); closing it forgets it; embedded in Lab Manager (/?tab=twin, no ?select) the restored OPT21 is reported and the address becomes ?tab=twin&select=srv:opt21');

    // ── baseline for TL-7: Lab Manager alone on Racks (no twin), main-thread task time over the same window ──
    let baseline;
    {
      const b = await open(ctx, '/?tab=racks'); await b.locator('[data-rack-id]').first().waitFor(); await b.waitForTimeout(2000);
      const cdp = await ctx.newCDPSession(b); await cdp.send('Performance.enable');
      const m0 = await metrics(cdp); await b.waitForTimeout(MEASURE_MS); const m1 = await metrics(cdp);
      baseline = { task: m1.TaskDuration - m0.TaskDuration, script: m1.ScriptDuration - m0.ScriptDuration };
      await b.close();
    }

    // ── TL-3: Lab Manager's Show in 3D ──
    const lm = await open(ctx, '/?tab=racks&rack=Rack-03');
    const lmRequests = []; lm.on('request', r => lmRequests.push({ at: Date.now(), twin: fromTwin(r), path: apiPath(r), method: r.method() }));
    await lm.locator('#rack-detail-title').waitFor();
    await lm.getByRole('button', { name: 'Show Rack-03 in 3D', exact: true }).click();
    await lm.locator(FRAME).waitFor({ state: 'visible' });
    let tw = await frameOf(lm);
    await selected(tw, 'SETUP-003', 60000); await ready(tw); await idle(tw);
    assert.equal((await focusOf(tw, 'SETUP-003')).name, 'Rack-03');
    await tw.evaluate(() => { window.__tlMark = 'first load'; });
    const tab = name => lm.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true });
    await lm.goBack(); await lm.locator('#rack-detail-title').waitFor();
    await tw.waitForFunction(() => window.__twin.isPaused(), null, { timeout: 5000 });
    await lm.locator('.racks-table').getByRole('button', { name: 'View OPT31', exact: true }).click();
    await lm.locator('[data-dialog="server"]').getByRole('button', { name: 'Show OPT31 in 3D', exact: true }).click();
    await lm.locator(FRAME).waitFor({ state: 'visible' });
    tw = await frameOf(lm);
    await selected(tw, 'LIVE-opt31'); await idle(tw);
    assert.equal(await tw.evaluate(() => window.__tlMark), 'first load', 'the iframe was not reloaded');
    const f31 = await focusOf(tw, 'LIVE-opt31');
    assert.deepEqual([f31.panel, f31.onScreen], [true, true]);
    pass(`TL-3 Lab Manager /?tab=racks&rack=Rack-03 → "Show Rack-03 in 3D" → the iframe's __twin.S.selected = SETUP-003 (Rack-03); back on Racks the hidden twin is paused; OPT31's Show in 3D then selects LIVE-opt31 in the same twin document (no reload), panel open, on screen (${f31.dist} m)`);

    // ── TL-4: a selection made in the twin goes into Lab Manager's address (replaced) ──
    const query = () => new URL(lm.url()).searchParams;
    const histLen = await lm.evaluate(() => history.length);
    await tw.locator('#search').fill('OPT21'); await tw.locator('#search').press('Enter');
    await selected(tw, 'LIVE-opt21');
    await lm.waitForFunction(() => new URL(location.href).searchParams.get('select') === 'srv:opt21', null, { timeout: 5000 });
    assert.equal(query().get('tab'), 'twin');
    assert.equal(await lm.evaluate(() => history.length), histLen, 'replaced: no new history entry');
    await tw.evaluate(() => window.__twin.select('SETUP-005', { keepCamera: true }));
    await lm.waitForFunction(() => new URL(location.href).searchParams.get('select') === 'rack:Rack-05', null, { timeout: 5000 });
    await tw.locator('#dClose').click();
    await lm.waitForFunction(() => !new URL(location.href).searchParams.has('select'), null, { timeout: 5000 });
    assert.equal(await lm.evaluate(() => history.length), histLen);
    await tw.locator('#search').fill('OPT21'); await tw.locator('#search').press('Enter');
    await lm.waitForFunction(() => new URL(location.href).searchParams.get('select') === 'srv:opt21', null, { timeout: 5000 });
    // a ref the twin cannot find (Storage-Main has no rack in the 3D, so Racks has no Show in 3D for it; an old address
    // or bookmark can still carry it, here reached with Back): nothing changes there, and the address follows what the
    // twin still shows (a reload opens on OPT21, not on the same "Not found"); the next selection is reported
    await tab('Racks').click(); await lm.locator('[data-rack-id]').first().waitFor();
    assert.equal(await lm.getByRole('button', { name: 'Show Storage-Main in 3D', exact: true }).count(), 0, 'a storage rack has no Show in 3D');
    await lm.evaluate(() => { history.pushState(null, '', '/?tab=twin&select=rack%3AStorage-Main'); history.pushState(null, '', '/?tab=racks'); history.back(); });
    await lm.locator(FRAME).waitFor({ state: 'visible' });
    await tw.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some(t => t.textContent === 'Not found in the 3D: rack:Storage-Main'), null, { timeout: 10000 });
    await lm.waitForFunction(() => new URL(location.href).searchParams.get('select') === 'srv:opt21', null, { timeout: 5000 });
    assert.deepEqual([await tw.evaluate(() => window.__twin.S.selected), await tw.evaluate(() => window.__tlMark)], ['LIVE-opt21', 'first load'], 'the unknown ref changed nothing, no reload');
    await tw.evaluate(() => window.__twin.select('SETUP-005', { keepCamera: true }));
    await lm.waitForFunction(() => new URL(location.href).searchParams.get('select') === 'rack:Rack-05', null, { timeout: 5000 });
    await tw.locator('#search').fill('OPT21'); await tw.locator('#search').press('Enter');
    await lm.waitForFunction(() => new URL(location.href).searchParams.get('select') === 'srv:opt21', null, { timeout: 5000 });
    pass('TL-4 OPT21 chosen in the twin\'s search → Lab Manager\'s address ?tab=twin&select=srv:opt21; Rack-05 → rack:Rack-05; Close → no ?select=; history.length unchanged (replaceState); no Show in 3D on the storage rack Storage-Main; Back onto an address with select=rack:Storage-Main toasts "Not found in the 3D: rack:Storage-Main", OPT21 stays selected and the address returns to select=srv:opt21; Rack-05 and OPT21 chosen afterwards are reported again');

    // ── TL-5: messages from another origin or another window are ignored ──
    await tw.evaluate(() => { clearInterval(window.__twin.S.live.timer); window.__twin.S.live.timer = null; });   // no 15 s refresh in this window
    const before5 = { sel: await tw.evaluate(() => window.__twin.S.selected), addr: lm.url() };
    let mark = Date.now();
    await lm.evaluate(evil => {
      window.__probe = []; window.addEventListener('message', e => { if (e.data && e.data.type === 'probe') window.__probe.push(e.origin); });
      const f = document.createElement('iframe'); f.id = 'evilProbe'; f.src = evil + '/probe.html'; f.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0';
      document.body.appendChild(f);
    }, EVIL);
    await lm.waitForFunction(() => window.__probe.length > 0, null, { timeout: 10000 });
    assert.deepEqual(await lm.evaluate(() => window.__probe), [EVIL], 'the cross-origin page ran and posted');
    await tw.evaluate(() => window.postMessage({ type: 'twin:select', ref: 'rack:Rack-05' }, location.origin));   // same origin, not the parent
    await lm.waitForTimeout(1200);
    assert.equal(await tw.evaluate(() => window.__twin.S.selected), before5.sel, 'the twin ignored them');
    assert.equal(lm.url(), before5.addr, 'Lab Manager ignored the forged twin:selected');
    assert.deepEqual(lmRequests.filter(r => r.twin && r.at >= mark && r.path.startsWith('/api/')).map(r => r.path), [], 'the forged twin:data-changed read nothing');
    await lm.evaluate(() => document.getElementById('evilProbe').remove());
    pass('TL-5 a cross-origin page inside Lab Manager posting twin:select rack:Rack-05, twin:data-changed and twin:selected changes nothing (selection, address, no request); a same-origin message from the twin\'s own window (not its parent) is ignored too');

    // ── TL-6: twin:data-changed refreshes; power alone does not; it waits while moving ──
    const owner12 = () => tw.evaluate(() => window.__twin.S.model.items.find(i => i.id === 'LIVE-opt12')?.owner || null);
    const post = domains => lm.evaluate(([sel, domains]) => document.querySelector(sel).contentWindow.postMessage({ type: 'twin:data-changed', domains }, location.origin), [FRAME, domains]);
    const [e1, e2, e3] = engineers.filter(e => e.name !== 'Fixture owner');
    assert.notEqual(await owner12(), e1.name);
    await setOwner('opt12', e1);
    await lm.waitForTimeout(1500);
    assert.notEqual(await owner12(), e1.name, 'nothing refreshes the twin on its own in this window');
    mark = Date.now(); await post(['power', 'monitoring']); await lm.waitForTimeout(1200);
    assert.deepEqual(lmRequests.filter(r => r.twin && r.at >= mark && r.path.startsWith('/api/')).map(r => r.path), [], 'power / monitoring changes alone read nothing');
    const t0 = Date.now(); await post(['owners']);
    await tw.waitForFunction(name => window.__twin.S.model.items.find(i => i.id === 'LIVE-opt12')?.owner === name, e1.name, { timeout: 3000 });
    const latency = Date.now() - t0;
    await tw.evaluate(() => window.__twin.select('LIVE-opt12', { keepCamera: true }));
    assert.match(await tw.locator('#dBody .scell').filter({ hasText: 'Owner' }).first().innerText(), new RegExp(e1.name));
    // while moving: the change waits until the move ends
    await tw.evaluate(() => { const t = window.__twin; t.toggleEdit(true); t.select('LIVE-opt11', { keepCamera: true }); t.startMove('LIVE-opt11'); });
    assert.equal(await tw.evaluate(() => window.__twin.S.moveItem), 'LIVE-opt11');
    await setOwner('opt12', e2); await post(['owners', 'layout']); await lm.waitForTimeout(1500);
    assert.equal(await owner12(), e1.name, 'no rebuild while moving');
    assert.equal(await tw.evaluate(() => window.__twin.S.moveItem), 'LIVE-opt11', 'the move goes on');
    await tw.evaluate(() => window.__twin.cancelMove());
    await tw.waitForFunction(name => window.__twin.S.model.items.find(i => i.id === 'LIVE-opt12')?.owner === name, e2.name, { timeout: 3000 });
    // Show in 3D while the move dialog is open: the Move ends and its dialog closes, so its Swap / Move cannot write
    await tw.evaluate(() => { const t = window.__twin; t.select('LIVE-opt11', { keepCamera: true }); t.startMove('LIVE-opt11');
      t.requestMove([...t.S.recs.values()].find(r => r.cat === 'shelf' && r.setup === 'SETUP-002' && t.shelfToU('SETUP-002', r.id) === 2)); });
    await tw.locator('#confirmModal:not(.hidden)').waitFor();
    mark = Date.now();
    await lm.evaluate(sel => document.querySelector(sel).contentWindow.postMessage({ type: 'twin:select', ref: 'srv:opt21' }, location.origin), FRAME);
    await selected(tw, 'LIVE-opt21');
    await lm.waitForTimeout(800);
    assert.deepEqual(await tw.evaluate(() => ({ dialog: !document.querySelector('#confirmModal').classList.contains('hidden'), moving: window.__twin.S.moveItem, body: document.body.classList.contains('moving'), choices: document.querySelectorAll('#cfActions [data-choice]').length })),
      { dialog: false, moving: null, body: false, choices: 0 }, 'the move dialog closed with the Move');
    assert.deepEqual(lmRequests.filter(r => r.twin && r.at >= mark && r.method !== 'GET').map(r => r.method + ' ' + r.path), [], 'nothing written');
    await tw.evaluate(() => window.__twin.toggleEdit(false));
    measured.push(`data-changed → owner shown: ${latency} ms`);
    pass(`TL-6 OPT12's owner changed via PUT /api/opt-owners/opt12; the twin keeps the old one until Lab Manager posts twin:data-changed ['owners'], then shows ${e1.name} after ${latency} ms (< 3 s); ['power','monitoring'] reads nothing; during Move a change waits and is applied within 3 s of Cancel; a twin:select (srv:opt21) while the Move dialog (OPT11 → Rack-02 › Shelf 2) is open selects OPT21, ends the Move and closes the dialog, nothing is written`);

    // ── TL-7: hidden, the twin does ~no work; shown again, one refresh ──
    await tw.evaluate(() => { const t = window.__twin; t.S.live.timer = setInterval(t.refreshStatuses, 15000); });   // its normal poll again
    assert.equal(lmRequests.filter(r => r.twin && r.path === '/api/changes').length, 0, 'embedded, the twin never reads /api/changes');
    await tab('Racks').click(); await lm.locator('[data-rack-id]').first().waitFor();
    assert.equal(await lm.locator(FRAME).isHidden(), true);
    await tw.waitForFunction(() => window.__twin.isPaused() && window.__twin.S.live.timer === null, null, { timeout: 3000 });
    await lm.waitForTimeout(1000);
    const cdp = await ctx.newCDPSession(lm); await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    const s0 = await tw.evaluate(() => ({ ...window.__twin.S.stats })); const m0 = await metrics(cdp); mark = Date.now();
    await cdp.send('Profiler.start');
    await lm.waitForTimeout(MEASURE_MS);
    const hiddenProfile = (await cdp.send('Profiler.stop')).profile;
    const s1 = await tw.evaluate(() => ({ ...window.__twin.S.stats })); const m1 = await metrics(cdp);
    const hiddenReqs = lmRequests.filter(r => r.twin && r.at >= mark);
    const work = { frames: s1.frames - s0.frames, ticks: s1.ticks - s0.ticks, requests: hiddenReqs.length, task: m1.TaskDuration - m0.TaskDuration, script: m1.ScriptDuration - m0.ScriptDuration, twinMs: twinScriptMs(hiddenProfile) };
    assert.ok(work.frames <= 1, `no frames rendered while hidden: ${work.frames}`);
    assert.equal(work.ticks, 0, 'no 1 s ticks while hidden');
    assert.deepEqual(hiddenReqs.map(r => r.path), [], 'no twin requests while hidden');
    assert.ok(work.twinMs < 20, `the twin's own scripts ran ${work.twinMs.toFixed(1)} ms while hidden`);
    measured.push(`hidden ${MEASURE_MS / 1000} s: twin frames ${work.frames}, ticks ${work.ticks}, twin requests ${work.requests}, twin script self time ${work.twinMs.toFixed(1)} ms (CPU profile); whole page main-thread task ${work.task.toFixed(3)} s (script ${work.script.toFixed(3)} s) vs Lab Manager alone ${baseline.task.toFixed(3)} s (script ${baseline.script.toFixed(3)} s)`);
    // for the record: would the browser still run animation frames in the hidden (display: none) twin? (why it pauses)
    const rafHidden = await tw.evaluate(() => new Promise(done => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => done(n), 1200); }));
    measured.push(`a hidden twin frame still gets ${rafHidden} animation frames per second from the browser (without the pause each would render the scene)`);
    // shown again: renders at once and refreshes once
    mark = Date.now();
    await tab('3D Twin').click(); await lm.locator(FRAME).waitFor({ state: 'visible' });
    await tw.waitForFunction(() => !window.__twin.isPaused() && window.__twin.S.live.timer !== null, null, { timeout: 3000 });
    for (let i = 0; i < 30 && !lmRequests.some(r => r.twin && r.at >= mark && r.path === '/api/devices/'); i++) await lm.waitForTimeout(100);
    const refreshAt = lmRequests.find(r => r.twin && r.at >= mark && r.path === '/api/devices/');
    assert.ok(refreshAt, 'one refresh at once when shown'); const refreshMs = refreshAt.at - mark;
    // the same profile shown (the attribution works): the twin's scripts run again
    const f0 = await tw.evaluate(() => window.__twin.S.stats.frames); await cdp.send('Profiler.start'); await lm.waitForTimeout(3000);
    const shownMs = twinScriptMs((await cdp.send('Profiler.stop')).profile); const f1 = await tw.evaluate(() => window.__twin.S.stats.frames);
    assert.ok(f1 > f0 && shownMs > work.twinMs, `renders again (${f1 - f0} frames, twin scripts ${shownMs.toFixed(1)} ms in 3 s)`);
    measured.push(`shown again: refresh request after ${refreshMs} ms; 3 s shown: ${f1 - f0} frames, twin script self time ${shownMs.toFixed(1)} ms`);
    // shown again with unsaved editor input: the one refresh waits until the input is done (Edit off here)
    await tw.evaluate(() => { const t = window.__twin; t.toggleEdit(true); t.select('SHELF-01', { keepCamera: true }); });
    await tw.locator('#eNotes').click(); await tw.locator('#eNotes').pressSequentially(' typed');
    await tab('Racks').click(); await tw.waitForFunction(() => window.__twin.isPaused(), null, { timeout: 3000 });
    mark = Date.now();
    await tab('3D Twin').click(); await tw.waitForFunction(() => !window.__twin.isPaused(), null, { timeout: 3000 });
    await lm.waitForTimeout(2000);
    assert.equal(lmRequests.filter(r => r.twin && r.at >= mark && r.path === '/api/devices/').length, 0, 'no refresh while the editor has unsaved input');
    assert.match(await tw.locator('#eNotes').inputValue(), / typed$/, 'the typed notes are kept');
    mark = Date.now(); await tw.evaluate(() => window.__twin.toggleEdit(false));
    for (let i = 0; i < 30 && !lmRequests.some(r => r.twin && r.at >= mark && r.path === '/api/devices/'); i++) await lm.waitForTimeout(100);
    const deferredAt = lmRequests.find(r => r.twin && r.at >= mark && r.path === '/api/devices/');
    assert.ok(deferredAt, 'the waiting refresh runs once the input is done');
    measured.push(`shown with unsaved editor input: no refresh for 2 s; refresh ${deferredAt.at - mark} ms after Edit off`);
    // an ancestor of the iframe display: none (not the iframe's own attribute) pauses it as well
    await lm.evaluate(sel => document.querySelector(sel).parentElement.style.setProperty('display', 'none'), FRAME);
    await tw.waitForFunction(() => window.__twin.isPaused() && window.__twin.S.live.timer === null, null, { timeout: 3000 });
    const a0 = await tw.evaluate(() => window.__twin.S.stats.frames); await lm.waitForTimeout(1500); const a1 = await tw.evaluate(() => window.__twin.S.stats.frames);
    assert.ok(a1 - a0 <= 1, `no frames with an ancestor hidden: ${a1 - a0}`);
    await lm.evaluate(sel => document.querySelector(sel).parentElement.style.removeProperty('display'), FRAME);
    await tw.waitForFunction(() => !window.__twin.isPaused() && window.__twin.S.live.timer !== null, null, { timeout: 3000 });
    measured.push(`the iframe's parent element display: none: paused, ${a1 - a0} frames in 1.5 s; resumed when shown`);
    pass(`TL-7 hidden on Racks for ${MEASURE_MS / 1000} s the twin rendered ${work.frames} frames, ran ${work.ticks} ticks, sent ${work.requests} requests and ran ${work.twinMs.toFixed(1)} ms of its own script (paused; poll timer stopped); page task time ${work.task.toFixed(2)} s vs ${baseline.task.toFixed(2)} s for Lab Manager alone; shown again it renders and reads /api/devices/ after ${refreshMs} ms, its poll timer restarted; embedded it never reads /api/changes; shown with unsaved SHELF-01 notes it refreshes only once Edit is off (notes kept meanwhile); the iframe's parent element display: none pauses it (${a1 - a0} frames) and removing that resumes it`);

    // ── TL-8: links back to Lab Manager ──
    const links = await tw.evaluate(() => {
      const t = window.__twin, out = {};
      const grab = id => { t.select(id, { keepCamera: true }); return [...document.querySelectorAll('#dBody a[data-lm]')].map(a => ({ lm: a.dataset.lm, text: a.textContent, href: a.getAttribute('href'), target: a.target, section: a.closest('section')?.querySelector('.sec-h')?.textContent || '' })); };
      for (const id of ['LIVE-opt31', 'LIVE-ci-3', 'SETUP-003', 'LIVE-pdu3']) out[id] = grab(id);
      return out;
    });
    const racks3 = { lm: 'racks', text: 'Open in Racks', href: '/?tab=racks&rack=Rack-03', target: '_top', section: 'Location' };
    assert.deepEqual(links['LIVE-opt31'], [racks3], 'server');
    assert.deepEqual(links['LIVE-ci-3'], [racks3, { lm: 'scan', text: 'Full history in Scan & Track', href: '/?tab=scan', target: '_top', section: 'Tracking' }], 'unit');
    assert.deepEqual(links['SETUP-003'], [racks3], 'rack');
    assert.deepEqual(links['LIVE-pdu3'], [{ lm: 'power', text: 'Manage maintenance in Power', href: '/?tab=power', target: '_top', section: 'Status' }], 'PDU');
    await tw.evaluate(() => window.__twin.select('LIVE-opt31', { keepCamera: true }));
    await Promise.all([lm.waitForURL(u => { const q = new URL(u).searchParams; return q.get('tab') === 'racks' && q.get('rack') === 'Rack-03'; }, { timeout: 15000 }), tw.locator('#dBody a[data-lm="racks"]').click()]);
    await lm.locator('#rack-detail-title').waitFor();
    assert.match(await lm.locator('#rack-detail-title').innerText(), /Rack-03/);
    await lm.close();
    pass('TL-8 "Open in Racks" (/?tab=racks&rack=Rack-03, target _top) in the Location section of OPT31, Switch 03 and Rack-03; Switch 03\'s Tracking section has "Full history in Scan & Track" (/?tab=scan); PDU 03\'s Status has "Manage maintenance in Power" (/?tab=power); clicking Open in Racks in the embedded twin opens Lab Manager\'s Rack-03 page');

    // ── TL-9: a unit on OPT11's floor shows OPT11's owner ──
    {
      const ri = await ctx.request.get(origin + '/api/rack-items'); const etag = ri.headers()['etag']; const data = await ri.json();
      data['Rack-01'].find(i => i.id === 'ci-1').u = 1;   // Switch 01 onto OPT11's floor (U1)
      assert.equal((await ctx.request.put(origin + '/api/rack-items', { data, headers: { ...H, 'If-Match': etag } })).status(), 200);
      await setOwner('item:ci-1', e3); await setOwner('item:storage-fixture', e3);
      const p = await open(ctx, '/twin/'); await ready(p);
      const m = await p.evaluate(() => { const S = window.__twin.S; const g = id => S.model.items.find(i => i.id === id) || {}; const u = g('LIVE-ci-1'), s = g('LIVE-opt11'), st = g('LIVE-storage-fixture');
        return { sameFloor: !!u.shelf && u.shelf === s.shelf, server: s.owner, unit: u.owner, from: u.ownerFrom?.name, own: u.ownOwner, storage: st.owner, storageFrom: st.ownerFrom || null }; });
      assert.deepEqual(m, { sameFloor: true, server: 'Fixture owner', unit: 'Fixture owner', from: 'OPT11', own: e3.name, storage: e3.name, storageFrom: null });
      await p.evaluate(() => window.__twin.select('LIVE-ci-1', { keepCamera: true }));
      const cellOf = await p.evaluate(() => { const c = [...document.querySelectorAll('#dBody .scell')].find(x => x.querySelector('.sl')?.textContent === 'Owner'); return { v: c?.querySelector('.sv')?.textContent, s: c?.querySelector('.ss')?.textContent, inv: document.querySelector('#dBody .kv')?.textContent.replace(/\s+/g, ' ') || '' }; });
      assert.deepEqual([cellOf.v, cellOf.s], ['Fixture owner', 'From OPT11, the server on this floor']);
      assert.match(cellOf.inv, /Owner\s*Fixture owner \(from OPT11, the server on this floor\)/);
      const hits = async q => { await p.locator('#search').fill(q); await p.locator('#searchResults .sr').first().waitFor(); return p.evaluate(() => [...document.querySelectorAll('#searchResults .sr[data-id]')].map(x => x.dataset.id)); };
      const byServer = await hits('Fixture owner'), byOwn = await hits(e3.name);
      assert.ok(byServer.includes('LIVE-ci-1') && byServer.includes('LIVE-opt11'), 'search by OPT11\'s owner finds the unit: ' + byServer);
      assert.ok(!byOwn.includes('LIVE-ci-1') && byOwn.includes('LIVE-storage-fixture'), 'its own stored owner no longer finds it; a unit on no server\'s floor keeps its own: ' + byOwn);
      await p.locator('#search').fill(''); await p.keyboard.press('Escape');
      const ed = await p.evaluate(() => { const t = window.__twin; t.toggleEdit(true); t.select('LIVE-ci-1', { keepCamera: true });
        const out = { from: document.querySelector('#eOwnerFrom')?.textContent, note: document.querySelector('#eOwnerNote')?.textContent, picker: !!document.querySelector('#eOwner'), open: document.querySelector('#dBody [data-edit="LIVE-opt11"]')?.textContent };
        t.select('LIVE-storage-fixture', { keepCamera: true }); out.storagePicker = document.querySelector('#eOwner')?.value; t.toggleEdit(false); return out; });
      assert.deepEqual(ed, { from: 'Fixture owner', note: 'From OPT11, the server on this floor. Change it on the server.', picker: false, open: 'Open OPT11', storagePicker: e3.name });
      await setOwner('opt11', e2); await p.evaluate(() => window.__twin.refreshStatuses());
      await p.waitForFunction(name => window.__twin.S.model.items.find(i => i.id === 'LIVE-ci-1')?.owner === name, e2.name, { timeout: 10000 });
      pass(`TL-9 Switch 01 on OPT11's floor (U1) shows OPT11's owner "Fixture owner" (its own ${e3.name} kept aside): panel Owner cell "From OPT11, the server on this floor", inventory "(from OPT11, …)", search by OPT11's owner finds it and by its own owner does not; Edit layout shows it read-only with "From OPT11, the server on this floor. Change it on the server." and "Open OPT11" (no picker); the storage unit (no server's floor) keeps ${e3.name} with a picker; OPT11's new owner reaches the unit`);

      // ── TL-10: PDUs / KVMs never move; non-server outlet labels never get a slot ──
      const infra = () => p.evaluate(() => { const t = window.__twin; t.scene.updateMatrixWorld(true); const out = {};
        for (const i of t.S.model.items) if (i.type === 'pdu' || i.type === 'kvm') { const r = t.S.recs.get(i.id); let c = null;
          if (r?.meshes?.length) { const b = new THREE.Box3(); r.meshes.forEach(x => b.expandByObject(x)); const v = b.getCenter(new THREE.Vector3()); c = [v.x, v.y, v.z].map(n => +n.toFixed(3)); }
          out[i.id] = { setup: i.setup ?? null, shelf: i.shelf ?? null, placement: i.placement ?? null, side: i.side ?? null, notInLm: !!i.notInLm, center: c }; }
        return out; });
      const devices = async () => (await (await ctx.request.get(origin + '/api/devices/')).json()).map(d => ({ id: d.id, kind: d.kind, rack: d.rack, labels: d.labels })).sort((a, b) => a.id.localeCompare(b.id));
      const devBefore = await devices();
      // PDU 03 outlets 3 / 4 read "KVM Power" / "empty" (in the twin only)
      await p.evaluate(() => { const t = window.__twin, S = t.S; clearInterval(S.live.timer); S.live.timer = null;
        const dev = S.live.devices.find(d => d.id === 'pdu3'); dev.labels = { ...dev.labels, 3: 'KVM Power', 4: 'empty' };
        S.live.pdu.pdu3 = { ...S.live.pdu.pdu3, outlets: S.live.pdu.pdu3.outlets.map(o => (o.number === 3 ? { ...o, label: 'KVM Power' } : o.number === 4 ? { ...o, label: 'empty' } : o)) };
        t.computeModel(); t.buildItems({ refresh: true }); });
      const asServers = await p.evaluate(() => window.__twin.S.model.items.filter(i => i.type === 'opt' && /kvm\s*power|^empty$|^opt3[34]$/i.test(i.name)).map(i => i.name));
      assert.deepEqual(asServers, [], '"KVM Power" / "empty" are no servers');
      const infraA = await infra();
      assert.ok(Object.keys(infraA).length >= 10, 'PDUs and KVMs in the model: ' + Object.keys(infraA).length);
      const target = await p.evaluate(() => { const t = window.__twin; return [...t.S.recs.values()].find(r => r.cat === 'shelf' && r.setup === 'SETUP-003' && t.shelfToU('SETUP-003', r.id) === 3).id; });
      const plan = await p.evaluate(id => { const pl = window.__twin.movePlan('LIVE-opt11', window.__twin.S.recs.get(id)); return { error: pl.error, occupant: pl.occupant?.id || null, kind: pl.kind }; }, target);
      assert.deepEqual(plan, { error: null, occupant: null, kind: 'opt' });
      await p.evaluate(id => { const t = window.__twin; t.toggleEdit(true); t.select('LIVE-opt11', { keepCamera: true }); t.startMove('LIVE-opt11'); t.requestMove(t.S.recs.get(id)); }, target);
      await p.locator('#confirmModal:not(.hidden)').waitFor();
      const put = p.waitForRequest(r => r.url().endsWith('/api/rack-layout') && r.method() === 'PUT');
      const answer = p.waitForResponse(r => r.url().endsWith('/api/rack-layout') && r.request().method() === 'PUT');
      await p.locator('#cfActions [data-choice="move"]').click();
      const body = JSON.parse((await put).postData()); assert.equal((await answer).status(), 200);
      const keys = [...Object.keys(body.rack_overrides.data), ...Object.values(body.rack_slots.data).flatMap(o => Object.keys(o || {})), ...Object.values(body.rack_positions.data).flatMap(a => (Array.isArray(a) ? a : []))];
      assert.deepEqual(keys.filter(k => NON_SERVER.test(String(k).trim())), [], 'no outlet label that is not a server gets a slot, position or override');
      assert.equal(body.rack_slots.data['Rack-03'].opt11, 3, 'OPT11 goes to Rack-03 U3');
      assert.equal(body.rack_overrides.data.opt11, 'Rack-03');
      await p.waitForFunction(id => window.__twin.S.recs.get('LIVE-opt11')?.shelf === id, target, { timeout: 15000 });
      await p.evaluate(() => window.__twin.refreshStatuses()); await p.waitForTimeout(500);
      assert.deepEqual(await infra(), infraA, 'every PDU and KVM keeps its place and 3D position after the server move');
      assert.deepEqual(await devices(), devBefore, 'no device (PDU / KVM) changed rack or labels');
      const fixed = await p.evaluate(() => { const t = window.__twin; const shelf = [...t.S.recs.values()].find(r => r.cat === 'shelf' && r.setup === 'SETUP-002');
        const out = { kvmPlan: t.movePlan('ITEM-0041', shelf)?.error, pduPlan: t.movePlan('LIVE-pdu3', shelf)?.error };
        t.select('ITEM-0041', { keepCamera: true }); t.startMove('ITEM-0041'); out.moving = t.S.moveItem;
        out.editor = { fixed: document.querySelector('#eFixed')?.textContent || '', move: !!document.querySelector('#eMove'), unplace: !!document.querySelector('#eUnplace'), side: !!document.querySelector('#dBody [data-side]') };
        t.toggleEdit(false); return out; });
      const FIXED = 'PDUs and KVMs are fixed infrastructure: they stay where they are and never move with a server.';
      assert.deepEqual(fixed, { kvmPlan: FIXED, pduPlan: FIXED, moving: null, editor: { fixed: FIXED, move: false, unplace: false, side: false } });
      // units (Lab Manager rack items) of type KVM / PDU: Switch 02 → kvm, Switch 05 → pdu (in the twin only)
      const units = await p.evaluate(() => { const t = window.__twin, S = t.S;
        Object.values(S.live.rackItems).forEach(list => (list || []).forEach(ci => { if (ci.id === 'ci-2') ci.type = 'kvm'; if (ci.id === 'ci-5') ci.type = 'pdu'; }));
        t.computeModel(); t.buildItems({ refresh: true }); t.toggleEdit(true);
        const shelf = [...S.recs.values()].find(r => r.cat === 'shelf' && r.setup === 'SETUP-004' && t.shelfToU('SETUP-004', r.id) === 4);
        const out = { types: [S.recs.get('LIVE-ci-2')?.item?.type, S.recs.get('LIVE-ci-5')?.item?.type], kvm: t.movePlan('LIVE-ci-2', shelf)?.error, pdu: t.movePlan('LIVE-ci-5', shelf)?.error };
        const swap = t.movePlan('LIVE-ci-1', S.recs.get(S.recs.get('LIVE-ci-5').shelf)); out.swap = { occupant: swap.occupant?.id, swappable: swap.swappable };
        t.select('LIVE-ci-2', { keepCamera: true }); t.startMove('LIVE-ci-2'); out.moving = S.moveItem;
        out.editor = { fixed: document.querySelector('#eFixed')?.textContent || '', move: !!document.querySelector('#eMove') };
        t.toggleEdit(false); return out; });
      assert.deepEqual(units, { types: ['equip-kvm', 'equip-pdu'], kvm: FIXED, pdu: FIXED, swap: { occupant: 'LIVE-ci-5', swappable: false }, moving: null, editor: { fixed: FIXED, move: false } });
      pass(`TL-10 with PDU 03 outlets 3 / 4 labelled "KVM Power" / "empty" (no servers then), OPT11 moved to Rack-03 › Shelf 3 in one PUT /api/rack-layout: no key matching NON_SERVER_LABEL in rack_slots / rack_positions / rack_overrides; all ${Object.keys(infraA).length} PDUs / KVMs keep setup, shelf, placement, side and 3D centre; GET /api/devices/ unchanged; Move refuses a KVM and a PDU ("${FIXED}") and their editor has no Move / Unplace / side buttons; a unit of type KVM (Switch 02) or PDU (Switch 05) is refused the same way (movePlan, startMove, editor note without Move), and Switch 01 cannot swap with the PDU unit`);

      // ── TL-7 (standalone): document.hidden pauses; the missing change feed is quiet ──
      const feed = []; p.on('request', r => { if (apiPath(r) === '/api/changes') feed.push(Date.now()); });
      await p.reload(); await ready(p); await p.waitForTimeout(6000);
      assert.equal(feed.length, 1, `standalone, /api/changes was asked once and, answering 404, not again for a minute (${feed.length})`);
      const devReq = []; p.on('request', r => { if (apiPath(r) === '/api/devices/') devReq.push(Date.now()); });
      await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      const h0 = await p.evaluate(() => ({ paused: window.__twin.isPaused(), timer: window.__twin.S.live.timer, frames: window.__twin.S.stats.frames }));
      await p.waitForTimeout(2000);
      const h1 = await p.evaluate(() => window.__twin.S.stats.frames);
      assert.deepEqual([h0.paused, h0.timer, h1 - h0.frames <= 1], [true, null, true], 'document.hidden pauses rendering and polling');
      mark = Date.now();
      await p.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      await p.waitForFunction(() => !window.__twin.isPaused() && window.__twin.S.live.timer !== null, null, { timeout: 3000 });
      for (let i = 0; i < 30 && !devReq.some(t => t >= mark); i++) await p.waitForTimeout(100);
      assert.ok(devReq.some(t => t >= mark), 'shown again: one refresh');
      await p.close();
      pass('TL-7b standalone: document.hidden pauses the twin (no frames, poll timer stopped) and showing it refreshes at once; GET /api/changes (404 on this branch) is asked once, then left alone for a minute, without a toast or error');
    }

    // ── TL-9 (several servers on one floor): the unit takes the first server in slot order, as Racks does ──
    {
      const get = async path => { const r = await ctx.request.get(origin + path); return { data: await r.json(), etag: r.headers()['etag'] }; };
      const rack01 = async first => {   // OPT11 and OPT12 both on Rack-01 U1; rack-positions puts `first` first
        const [slots, ov, pos] = await Promise.all([get('/api/rack-slots'), get('/api/rack-overrides'), get('/api/rack-positions')]);
        Object.values(slots.data).forEach(r => { if (r) { delete r.opt11; delete r.opt12; } });
        Object.keys(pos.data).forEach(r => { if (Array.isArray(pos.data[r])) pos.data[r] = pos.data[r].filter(k => k !== 'opt11' && k !== 'opt12'); });
        slots.data['Rack-01'] = { ...(slots.data['Rack-01'] || {}), opt11: 1, opt12: 1 };
        Object.assign(ov.data, { opt11: 'Rack-01', opt12: 'Rack-01' });
        pos.data['Rack-01'] = [...(first === 'opt12' ? ['opt12', 'opt11'] : ['opt11', 'opt12']), ...(pos.data['Rack-01'] || [])];
        const w = await ctx.request.put(origin + '/api/rack-layout', { data: { rack_slots: { data: slots.data, if_match: slots.etag }, rack_overrides: { data: ov.data, if_match: ov.etag }, rack_positions: { data: pos.data, if_match: pos.etag } }, headers: H });
        assert.equal(w.status(), 200, 'rack-layout');
      };
      const [e1, e2] = engineers.filter(e => e.name !== 'Fixture owner');
      await setOwner('opt12', e1); await setOwner('opt11', e2);
      await rack01('opt12');
      const p = await open(ctx, '/twin/'); await ready(p);
      const unit = () => p.evaluate(() => { const S = window.__twin.S; const g = id => S.model.items.find(i => i.id === id) || {}; const u = g('LIVE-ci-1');
        return { floor: !!u.shelf && u.shelf === g('LIVE-opt11').shelf && u.shelf === g('LIVE-opt12').shelf, owner: u.owner, from: u.ownerFrom?.name, place: u.ownerFrom?.place }; });
      assert.deepEqual(await unit(), { floor: true, owner: e1.name, from: 'OPT12', place: 'floor' }, 'rack-positions [opt12, opt11]: OPT12 (OPT11 comes first in PDU outlet order)');
      await rack01('opt11'); await p.evaluate(() => window.__twin.refreshStatuses());
      await p.waitForFunction(() => window.__twin.S.model.items.find(i => i.id === 'LIVE-ci-1')?.ownerFrom?.name === 'OPT11', null, { timeout: 10000 });
      assert.deepEqual(await unit(), { floor: true, owner: e2.name, from: 'OPT11', place: 'floor' }, 'rack-positions [opt11, opt12]: OPT11');
      // a storage-type rack (its PDU model "Storage", in the twin only): a level is a shelf there, as Racks says it
      const st = await p.evaluate(() => { const t = window.__twin, S = t.S; clearInterval(S.live.timer); S.live.timer = null;
        S.live.devices.filter(d => d.rack === 'Rack-01' && (d.kind === 'pdu' || d.kind === 'rack')).forEach(d => { d.model = 'Storage'; });
        t.computeModel(); t.buildItems({ refresh: true }); const u = S.model.items.find(i => i.id === 'LIVE-ci-1');
        t.select('LIVE-ci-1', { keepCamera: true }); const c = [...document.querySelectorAll('#dBody .scell')].find(x => x.querySelector('.sl')?.textContent === 'Owner');
        return { shelves: t.shelvesFor(S.data.setups.find(s => s.id === 'SETUP-001')).length, from: u.ownerFrom?.name, place: u.ownerFrom?.place, note: c?.querySelector('.ss')?.textContent }; });
      assert.deepEqual(st, { shelves: 16, from: 'OPT11', place: 'shelf', note: 'From OPT11, the server on this shelf' });
      await p.close();
      pass(`TL-9b OPT11 and OPT12 both on Rack-01 U1 with Switch 01: rack-positions [opt12, opt11] → the unit shows OPT12's owner ${e1.name} (not OPT11, first in PDU outlet order); [opt11, opt12] → OPT11's ${e2.name}; Rack-01 as a storage-type rack (16 shelves) → "From OPT11, the server on this shelf"`);
    }

    assert.deepEqual(unexpected, [], 'no unexpected writes');
    assert.deepEqual(errors, [], 'no page errors');
    console.log(passed.map(x => 'PASS ' + x).join('\n'));
    console.log(measured.map(x => 'MEASURED ' + x).join('\n'));
    console.log(`twin-links: ${passed.length} checks passed`);
  } catch (e) {
    console.error(passed.map(x => 'PASS ' + x).join('\n'));
    console.error(measured.map(x => 'MEASURED ' + x).join('\n'));
    console.error('FAIL', e && e.stack || e);
    if (errors.length) console.error('page errors:', errors);
    if (unexpected.length) console.error('unexpected writes:', unexpected);
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
