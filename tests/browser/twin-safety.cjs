// Digital Twin safety and usability regression (isolated fixture only: tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1).
// Covers: power only from live DCIM mappings, one confirmation for On/Off/Cycle, fly-to framing inside the room,
// mirrored label anchors, live warnings kept out of notes, move confirmation + swap without shifting other servers,
// search ranking / keyboard / owners, blocked KVM popup, KVM in-use question and per-console leases, viewer card, rack bar, reduced motion, focus and disposal.
// Writes only fixture data: one power cycle + one power on (simulated PDU), KVM port marks, rack-slot swaps and
// two saves of the fixture's temporary lab-data.json (only meta.modified changes).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [], errors = [], unexpected = [];
  const progress = m => { if (process.env.DCIM_QA_VERBOSE) console.error(new Date().toISOString().slice(11, 19) + ' ' + m); };
  const pass = m => { checks.push(m); progress('ok: ' + m); };
  const allowed = [/^\/api\/auth\/login$/, /^\/api\/pdus\/pdu\d\/outlets\/\d\/power$/, /^\/api\/kvms\/kvm1\/ports\/\d\/mark-(in-use|free)$/, /^\/api\/rack-layout$/, /^\/api\/twin-data$/];   // moves: one atomic PUT /api/rack-layout, never the single stores
  async function open(user, options = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: options.reducedMotion || 'no-preference' });
    await ctx.route('**/*', route => {
      const req = route.request(); if (!req.url().startsWith(origin + '/')) return route.abort();
      const path = new URL(req.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !allowed.some(re => re.test(path))) { unexpected.push(req.method() + ' ' + path); return route.abort(); }
      return route.continue();
    });
    assert.equal((await ctx.request.post(origin + '/api/auth/login', { data: { username: user, password: 'test-password-123' } })).status(), 200);
    assert.equal((await (await ctx.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    if (options.init) await ctx.addInitScript(options.init);
    const page = await ctx.newPage(); const posts = [];
    page.on('pageerror', e => errors.push(user + ': ' + e.message));
    page.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) posts.push({ path: new URL(r.url()).pathname, body: r.postData() }); });
    page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
    await page.goto(origin + '/twin/');
    await page.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.recs.size > 10 && window.__twin.S.live.pdu.pdu1, null, { timeout: 60000 });   // a busy machine can be slow to load WebGL
    await page.waitForTimeout(1500);
    return { ctx, page, posts };
  }
  const dialogOpen = page => page.locator('#confirmModal:not(.hidden)');
  // the drawer's single "Power…" button opens a menu with Power on / off / cycle (each still confirmed)
  const pw = async (page, action) => { await page.locator('#dBody [data-power-menu]').click(); await page.locator(`#dBody [data-pw="${action}"]`).click(); };
  try {
    const { ctx, page, posts } = await open('admin');
    const idle = () => page.waitForFunction(() => !__twin.S.tween, null, { timeout: 8000 });

    // 1 — a server missing from the live PDU labels never gets power or console (its lab-data.json outlet may be stale)
    const stale = await page.evaluate(() => { const r = [...__twin.S.recs.values()].find(r => r.cat === 'item' && r.item?.type === 'opt' && r.item.live?.inDcim === false && r.item.dcim?.pdu); __twin.select(r.id, { keepCamera: true }); return r.id; });
    await page.getByText('Not in live DCIM — power disabled').first().waitFor();
    for (const b of await page.locator('#dBody [data-pw], #dBody [data-kvm]').all()) assert.equal(await b.isDisabled(), true, 'stale power / console button must be disabled');
    pass(`stale mapping ${stale}: power and console disabled with an explanation`);

    // 2 — one confirmation for every power action, Cancel focused, Escape / Enter-on-Cancel do nothing
    await page.evaluate(() => __twin.select('LIVE-opt12', { keepCamera: true }));
    const before = posts.length;
    await pw(page, 'off');
    await dialogOpen(page).waitFor();
    assert.match(await page.locator('#cfTitle').innerText(), /^Power off OPT12\?$/);
    assert.match(await page.locator('#cfBody').innerText(), /PDU 01 · outlet 2 · currently On/);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.choice), 'cancel', 'Cancel has the focus');
    await page.keyboard.press('Escape'); await dialogOpen(page).waitFor({ state: 'detached' }).catch(() => {});
    assert.equal(await dialogOpen(page).count(), 0); assert.equal(posts.length, before, 'Escape cancels');
    await pw(page, 'on'); await dialogOpen(page).waitFor();
    assert.match(await page.locator('#cfTitle').innerText(), /^Power on OPT12\?$/, 'Power On asks too (confirm_power default)');
    await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    assert.equal(posts.length, before, 'Enter on the focused Cancel does nothing');
    await pw(page, 'cycle'); await dialogOpen(page).waitFor();
    const cycled = page.waitForRequest(r => /\/api\/pdus\/pdu1\/outlets\/2\/power$/.test(r.url()));
    await page.locator('#cfActions [data-choice="go"]').click();
    assert.deepEqual(JSON.parse((await cycled).postData()), { action: 'cycle' });
    await page.evaluate(() => { window.DCIM_ACCOUNT_PREFS.confirm_power = false; });
    const on = page.waitForRequest(r => /\/api\/pdus\/pdu1\/outlets\/2\/power$/.test(r.url()) && JSON.parse(r.postData()).action === 'on');
    await pw(page, 'on'); await on;
    assert.equal(await dialogOpen(page).count(), 0, 'confirm_power=false skips Power On only');
    await pw(page, 'off'); await dialogOpen(page).waitFor();
    await page.locator('#cfActions [data-choice="cancel"]').click();
    await page.evaluate(() => { window.DCIM_ACCOUNT_PREFS.confirm_power = true; });
    pass('power: one dialog naming server/PDU/outlet/state, Cancel default, Escape cancels, preference skips only On');

    // 3 — fly-to stays in free space inside the room and keeps the target in the uncovered part of the view
    for (const id of ['SETUP-001', 'SETUP-002', 'SETUP-004', 'SETUP-005', 'SETUP-006', 'SETUP-007', 'STORAGE-02']) {
      await page.evaluate(id => __twin.select(id, { fly: true }), id); await idle(); await page.waitForTimeout(150);
      const r = await page.evaluate(id => {
        const t = __twin, p = t.camera.position, room = t.S.data.room;
        const boxOf = g => { const b = new THREE.Box3(); g.traverseVisible(o => { if ((o.isMesh || o.isLine) && o.geometry) { o.geometry.computeBoundingBox(); b.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } }); return b; };
        const inside = [...t.S.recs.values()].filter(r => (r.cat === 'setup' || r.cat === 'storage') && r.group && boxOf(r.group).containsPoint(p)).map(r => r.id);
        const rec = t.S.recs.get(id); const c = boxOf(rec.group).getCenter(new THREE.Vector3()).project(t.camera); const s = t.safeArea();
        return { inRoom: p.x <= 0 && p.x >= -room.width && p.z >= 0 && p.z <= room.depth && p.y > 0 && p.y < room.height, inside, centre: c.x > s.l && c.x < s.r && c.y > s.b && c.y < s.t && c.z < 1 };
      }, id);
      assert.ok(r.inRoom, id + ': camera inside the room'); assert.deepEqual(r.inside, [], id + ': camera not inside a rack'); assert.ok(r.centre, id + ': target centre in the safe area');
    }
    pass('fly-to: camera in the room, outside every rack, target centred in the uncovered view');

    // 4 — labels of mirrored geometry sit on their objects
    await page.evaluate(() => { __twin.closeDetail(); __twin.setView('top'); }); await idle();
    await page.locator('#btnLayers').click();   // the label / wall / zone toggles live in the Layers popover
    await page.locator('#tLabels').click();   // setups -> all; labels are placed by the render loop
    await page.waitForFunction(() => ['DOOR-01', 'PILLAR-01'].every(id => __twin.S.recs.get(id).label.style.display !== 'none'), null, { timeout: 15000 }); await page.waitForTimeout(200);
    const offsets = await page.evaluate(() => {
      const t = __twin, cv = document.querySelector('#c').getBoundingClientRect(); const out = {};
      for (const id of ['Z01', 'Z02', 'Z03', 'Z04', 'DOOR-01', 'WIN-02', 'PILLAR-01', 'ESTOP-01']) {
        const rec = t.S.recs.get(id); if (!rec?.label || rec.label.style.display === 'none') continue;
        const c = new THREE.Box3().setFromObject(rec.meshes[0]).getCenter(new THREE.Vector3()).project(t.camera); const lr = rec.label.getBoundingClientRect();
        out[id] = Math.round(Math.abs(lr.left + lr.width / 2 - (cv.left + (c.x + 1) / 2 * cv.width)));
      }
      return out;
    });
    assert.ok(Object.keys(offsets).length >= 5, 'labels shown');
    for (const [id, dx] of Object.entries(offsets)) assert.ok(dx < 40, `${id} label ${dx}px from its object`);
    await page.locator('#tLabels').click(); await page.locator('#tLabels').click(); await page.keyboard.press('Escape');
    pass('labels of zones / doors / windows / pillar / E-stop follow the mirrored world');

    // 5 — live warnings are shown, never written into notes
    await page.evaluate(id => { __twin.setView('orbit'); __twin.toggleEdit(true); __twin.select(id, { keepCamera: true }); }, stale);
    assert.doesNotMatch(await page.locator('#eNotes').inputValue(), /⚠|Not present in the/);
    await page.locator('#dBody .warn-box').filter({ hasText: 'Not present in the live DCIM labels.' }).waitFor();
    await page.locator('#eSave').click();
    assert.doesNotMatch(await page.evaluate(id => JSON.stringify(__twin.S.data.items.find(i => i.id === id)), stale), /Not present in the/);
    assert.equal(await page.evaluate(() => __twin.S.model.items.some(i => /Not present in the/.test(i.notes || ''))), false);
    await page.evaluate(() => { localStorage.removeItem('twin.draft'); });
    pass('live warnings stay out of notes and out of lab-data.json');

    // 6 — moving ignores the search filter, always confirms from → to, and a swap shifts nobody else
    await page.locator('#search').fill('OPT11'); await page.keyboard.press('Escape');
    const plan = await page.evaluate(() => {
      const t = __twin; const mover = t.S.recs.get('LIVE-opt11'); const rackOf = s => t.S.data.setups.find(x => x.id === s.setup)?.dcimRack;
      const target = [...t.S.recs.values()].find(s => s.cat === 'shelf' && s.setup !== mover.setup && rackOf(s) && t.movePlan('LIVE-opt11', s)?.swappable);
      t.select(target.setup, { fly: true }); return { target: target.id, source: mover.shelf };
    });
    await idle();
    await page.evaluate(() => __twin.startMove('LIVE-opt11'));
    // a real canvas point whose tap resolves to the target shelf (not covered by an overlay or another rack)
    const tap = await page.evaluate(id => {
      const t = __twin, canvas = document.querySelector('#c'), cv = canvas.getBoundingClientRect(); const sh = t.S.recs.get(id);
      const b = new THREE.Box3().setFromObject(sh.slot); const pts = [];
      for (const fx of [.5, .3, .7, .15, .85]) for (const fy of [.5, .3, .7]) for (const fz of [.5, .3, .7, .15, .85]) pts.push(new THREE.Vector3(b.min.x + (b.max.x - b.min.x) * fx, b.min.y + (b.max.y - b.min.y) * fy, b.min.z + (b.max.z - b.min.z) * fz));
      for (const p of pts) {
        const q = p.clone().project(t.camera); const x = cv.left + (q.x + 1) / 2 * cv.width, y = cv.top + (1 - q.y) / 2 * cv.height;
        if (q.z > 1 || document.elementFromPoint(x, y) !== canvas) continue;
        const hit = t.pickAt({ clientX: x, clientY: y }); if (hit && t.resolveMoveTarget(hit)?.id === id) return { x, y, filtered: sh.filtered };
      }
      return { filtered: sh.filtered };
    }, plan.target);
    assert.equal(tap.filtered, false, 'destinations are not hidden by the search while moving');
    assert.ok(tap.x != null, 'the target shelf is reachable with a tap');
    const shelvesBefore = await page.evaluate(() => Object.fromEntries(__twin.S.model.items.filter(i => i.type === 'opt' && i.live?.inDcim).map(i => [i.id, i.shelf])));
    await page.mouse.click(tap.x, tap.y); await dialogOpen(page).waitFor();
    assert.equal(await page.locator('#cfTitle').innerText(), `${plan.target} is occupied`);
    assert.match(await page.locator('#cfBody').innerText(), /From[\s\S]*To/i);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.choice), 'cancel');
    const quiet = posts.length; await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    assert.equal(posts.length, quiet, 'cancelling a move writes nothing'); assert.equal(await page.evaluate(() => __twin.S.moveItem), 'LIVE-opt11', 'still choosing a destination');
    await page.mouse.click(tap.x, tap.y); await dialogOpen(page).waitFor();
    const occupant = await page.evaluate(id => __twin.movePlan('LIVE-opt11', __twin.S.recs.get(id)).occupant.id, plan.target);
    const writesBefore = posts.length; const atomic = page.waitForResponse(r => r.url().endsWith('/api/rack-layout') && r.request().method() === 'PUT');
    await page.locator('#cfActions [data-choice="swap"]').click();
    assert.equal((await atomic).status(), 200);
    await page.waitForFunction(id => __twin.S.recs.get('LIVE-opt11')?.shelf === id, plan.target, { timeout: 15000 });
    assert.deepEqual(posts.slice(writesBefore).map(p => p.path), ['/api/rack-layout'], 'a swap is one atomic layout write');
    assert.deepEqual(Object.keys(JSON.parse(posts[writesBefore].body)).sort(), ['rack_overrides', 'rack_positions', 'rack_slots']);
    await page.evaluate(() => __twin.refreshStatuses()); await page.waitForTimeout(300);
    const shelvesAfter = await page.evaluate(() => Object.fromEntries(__twin.S.model.items.filter(i => i.type === 'opt' && i.live?.inDcim).map(i => [i.id, i.shelf])));
    assert.equal(shelvesAfter['LIVE-opt11'], plan.target); assert.equal(shelvesAfter[occupant], plan.source);
    for (const [id, shelf] of Object.entries(shelvesBefore)) if (id !== 'LIVE-opt11' && id !== occupant) assert.equal(shelvesAfter[id], shelf, `${id} must not move`);
    // a JSON-only item: plain from → to confirmation, Cancel keeps everything
    await page.evaluate(id => { __twin.select(id, { keepCamera: true }); __twin.startMove(id); }, stale);
    await page.evaluate(() => { __twin.requestMove(__twin.S.recs.get('STORAGE-02')); });   // resolves only after the dialog: not awaited here
    await dialogOpen(page).waitFor();
    assert.match(await page.locator('#cfTitle').innerText(), /^Move .+\?$/); assert.match(await page.locator('#cfBody').innerText(), /STORAGE-02/);
    await page.locator('#cfActions [data-choice="cancel"]').click(); await page.locator('#moveCancel').click();
    await page.evaluate(() => __twin.toggleEdit(false)); await page.locator('#search').fill('');
    pass('move: search ignored, from → to confirmation, occupied shelf asks Swap/Cancel, swap moves only the two servers');

    // 7 — search: exact match first, arrow keys, owners
    await page.locator('#search').fill('OPT11'); await page.waitForTimeout(150);
    assert.equal(await page.locator('#searchResults .sr').first().getAttribute('data-id'), 'LIVE-opt11', 'exact name first');
    await page.keyboard.press('ArrowDown'); assert.equal(await page.locator('#searchResults .sr.active').getAttribute('data-id'), await page.locator('#searchResults .sr').nth(1).getAttribute('data-id'));
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => __twin.S.selected), 'LIVE-opt11');
    await page.locator('#search').fill('Fixture owner'); await page.waitForTimeout(150);
    assert.ok(await page.locator('#searchResults .sr[data-id]').count() >= 1, 'owner names are searchable');
    await page.locator('#search').fill('');
    pass('search: exact match first, arrow keys + Enter, owner names');

    // 8 — a blocked KVM popup opens the console inline and always frees the port again
    const port1 = () => page.evaluate(() => !!__twin.S.live.kvm.kvm1?.ports?.find(p => p.number === 1)?.in_use);
    const port1Is = (v, timeout = 2000) => page.waitForFunction(v => !!__twin.S.live.kvm.kvm1?.ports?.find(p => p.number === 1)?.in_use === v, v, { timeout });
    // the lease this console must free: from the server's own mark-in-use answer ('' = server without leases → no body)
    const leaseOf = async res => { const j = await res.json().catch(() => ({})); return typeof j?.lease === 'string' ? j.lease : ''; };
    const freeBody = req => { const b = req.postData(); return b ? JSON.parse(b) : null; };
    const isPortCall = (r, kind, n = 1) => { const u = new URL(r.url()); return u.pathname === `/api/kvms/kvm1/ports/${n}/${kind}` && u.search === '' && r.method() === 'POST'; };
    const serverInUse = async () => !!(await (await ctx.request.get(origin + '/api/kvms/kvm1/status')).json()).ports?.find(p => p.number === 1)?.in_use;
    assert.equal(await port1(), false, 'KVM port 1 starts free (restart the fixture after an aborted run)');
    await page.evaluate(() => { window.open = () => null; __twin.select('LIVE-opt11', { keepCamera: true }); });
    const marked = page.waitForResponse(r => isPortCall(r.request(), 'mark-in-use'));
    await page.locator('#dBody [data-kvm]').first().click();
    const lease1 = await leaseOf(await marked);
    await page.locator('#kvmInline:not(.hidden)').waitFor();
    await page.frameLocator('#kvmInlineFrame').getByRole('heading', { name: 'Console preview' }).waitFor();
    await port1Is(true);   // KVM-4: IN USE shows right after mark-in-use, not at the next 15 s poll
    const free = page.waitForRequest(r => isPortCall(r, 'mark-free'));
    await page.keyboard.press('Escape');
    assert.deepEqual(freeBody(await free), lease1 ? { lease: lease1 } : null, 'mark-free frees exactly this console\'s lease');
    assert.equal(await page.locator('#kvmInline').isHidden(), true);
    await port1Is(false);
    await page.evaluate(() => { window.open = () => { throw new Error('Popup refused'); }; });
    await page.locator('#dBody [data-kvm]').first().click(); await page.locator('#kvmInline:not(.hidden)').waitFor();
    await port1Is(true);
    const free2 = page.waitForRequest(r => isPortCall(r, 'mark-free')); await page.locator('#kvmInlineClose').click(); await free2;
    await port1Is(false);
    pass(`KVM: blocked or throwing popup opens an inline console; IN USE shows at once; closing frees the port (${lease1 ? 'own lease in the body' : 'server without leases: no body'})`);

    // 8b — a port someone else uses asks first (advisory dialog); Cancel opens and marks nothing
    await page.evaluate(() => { window.__opened = []; window.open = url => { const w = { closed: false, url }; window.__opened.push(w); return w; }; });
    const otherMarked = page.waitForResponse(r => isPortCall(r.request(), 'mark-in-use'));
    await page.locator('#dBody [data-kvm]').first().click(); await otherMarked;   // "another session": a console tab that stays open
    await port1Is(true);
    assert.equal(await dialogOpen(page).count(), 0, 'a free port opens without a question');
    const beforeAsk = posts.length;
    await page.locator('#dBody [data-kvm]').first().click(); await dialogOpen(page).waitFor();
    assert.equal(await page.locator('#cfTitle').innerText(), 'Port already in use');
    assert.match(await page.locator('#cfBody').innerText(), /KVM 01 · Port 1 · OPT11/);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.choice), 'cancel', 'Cancel has the focus');
    assert.deepEqual(await page.locator('#cfActions [data-choice]').allInnerTexts(), ['Cancel', 'Open anyway']);
    assert.match(await page.locator('#cfBody').innerText(), /Someone else is probably working on this server through the KVM/);
    await page.locator('#cfActions [data-choice="cancel"]').click(); await page.waitForTimeout(300);
    assert.equal(await dialogOpen(page).count(), 0);
    assert.equal(await page.evaluate(() => window.__opened.length), 1, 'Cancel opens no console');
    assert.deepEqual(posts.slice(beforeAsk), [], 'Cancel sends no mark-in-use');
    await page.locator('#dBody [data-kvm]').first().click(); await dialogOpen(page).waitFor();
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__opened.length), 1, 'Escape opens no console'); assert.deepEqual(posts.slice(beforeAsk), [], 'Escape sends no mark-in-use');
    const secondMarked = page.waitForResponse(r => isPortCall(r.request(), 'mark-in-use'));
    await page.locator('#dBody [data-kvm]').first().click(); await dialogOpen(page).waitFor();
    await page.locator('#cfActions [data-choice="go"]').click(); await secondMarked;
    assert.equal(await page.evaluate(() => window.__opened.length), 2, '"Open anyway" opens the console');
    assert.match(await page.evaluate(() => window.__opened[1].url), /\/api\/kvms\/kvm1\/autologin\?port=1$/);
    const bothFreed = [], onFree = r => { if (isPortCall(r, 'mark-free')) bothFreed.push(r); };
    page.on('request', onFree);
    const firstFreed = page.waitForResponse(r => isPortCall(r.request(), 'mark-free'));
    await page.evaluate(() => { window.__opened[0].closed = true; });   // the twin checks closed tabs every 2 s
    await firstFreed;
    // KVM-1: with per-console leases, closing one console never frees the port while the other one is still open
    if (lease1) { assert.equal(await serverInUse(), true, 'the second console keeps the port IN USE'); await port1Is(true, 4000); }
    await page.evaluate(() => { window.__opened[1].closed = true; });
    for (let i = 0; i < 60 && bothFreed.length < 2; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(2500);   // a third mark-free would come at the next check
    page.off('request', onFree);
    assert.equal(bothFreed.length, 2, 'each closed console tab frees its own lease once');
    await port1Is(false, 4000);
    pass(`KVM: an in-use port asks first (Cancel focused); Cancel / Escape open and mark nothing; "Open anyway" opens; each tab frees once${lease1 ? '; one closed console keeps the port IN USE for the other' : ''}`);

    // 8c — the mark-free body carries the lease from mark-in-use and the URL still ends in mark-free (no query string)
    const LEASE = '0123456789abcdef0123456789abcdef';
    const fakeLease = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, lease: LEASE, sessions: 1 }) });
    await page.route(/\/api\/kvms\/kvm1\/ports\/1\/mark-in-use$/, fakeLease);
    await page.evaluate(() => { window.open = () => null; });
    const leased = page.waitForResponse(r => isPortCall(r.request(), 'mark-in-use'));
    await page.locator('#dBody [data-kvm]').first().click(); await leased; await page.locator('#kvmInline:not(.hidden)').waitFor();
    const leaseFree = page.waitForRequest(r => /mark-free$/.test(r.url()));
    await page.locator('#kvmInlineClose').click();
    const lf = await leaseFree;
    assert.equal(new URL(lf.url()).pathname, '/api/kvms/kvm1/ports/1/mark-free'); assert.equal(new URL(lf.url()).search, '', 'the lease never goes in the URL');
    assert.deepEqual(freeBody(lf), { lease: LEASE }); assert.match(lf.headers()['content-type'] || '', /application\/json/);
    await page.unroute(/\/api\/kvms\/kvm1\/ports\/1\/mark-in-use$/, fakeLease);
    pass('KVM: mark-free sends {lease} in the JSON body to …/mark-free');

    // 8d — a failed mark-in-use sends no mark-free (it would clear someone else's marker)
    const refuse = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Fixture: mark-in-use refused' }) });
    await page.route(/\/api\/kvms\/kvm1\/ports\/1\/mark-in-use$/, refuse);
    await port1Is(false, 20000);
    const failed = page.waitForResponse(r => isPortCall(r.request(), 'mark-in-use'));
    const beforeFail = posts.length;
    await page.locator('#dBody [data-kvm]').first().click(); await failed; await page.locator('#kvmInline:not(.hidden)').waitFor();
    await page.getByText('marking the port as in use failed').first().waitFor();
    await page.locator('#kvmInlineClose').click(); await page.waitForTimeout(800);
    assert.equal(await page.locator('#kvmInline').isHidden(), true);
    assert.deepEqual(posts.slice(beforeFail).map(p => p.path), ['/api/kvms/kvm1/ports/1/mark-in-use'], 'no mark-free after a failed mark-in-use');
    await page.unroute(/\/api\/kvms\/kvm1\/ports\/1\/mark-in-use$/, refuse);
    pass('KVM: a failed mark-in-use sends no mark-free');

    // 8e — leaving the twin with an inline console open still frees its port (keepalive mark-free on pagehide)
    assert.equal(await serverInUse(), false);
    const leave = await ctx.newPage();
    leave.on('pageerror', e => errors.push('admin (2nd tab): ' + e.message));
    leave.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
    await leave.goto(origin + '/twin/');
    await leave.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.live.kvm.kvm1, null, { timeout: 60000 });
    await leave.evaluate(() => { window.open = () => null; __twin.select('LIVE-opt11', { keepCamera: true }); });
    const leaveMarked = leave.waitForResponse(r => isPortCall(r.request(), 'mark-in-use'));
    await leave.locator('#dBody [data-kvm]').first().click(); await leaveMarked; await leave.locator('#kvmInline:not(.hidden)').waitFor();
    assert.equal(await serverInUse(), true);
    await leave.goto('about:blank');
    for (let i = 0; i < 40 && await serverInUse(); i++) await page.waitForTimeout(100);
    assert.equal(await serverInUse(), false, 'pagehide frees the inline console\'s port');
    await leave.close();
    pass('KVM: leaving the page frees the inline console\'s port (keepalive)');

    // 9 / 10 — rack bar, focus rings, tooltips, selection-box disposal
    await page.evaluate(() => __twin.select('SETUP-003', { keepCamera: true }));
    await page.waitForTimeout(200);
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('#rackBar button.on')).backgroundColor);   // same tick: the bar re-renders on refresh
    assert.match(bg, /^rgb\(/, 'selected rack button is opaque (' + bg + ')');
    await page.evaluate(() => window.__twin.showTab('attn'));
    await page.keyboard.press('Shift');   // keyboard modality, so programmatic focus shows :focus-visible
    await page.locator('#attn .attn-row').first().focus();
    assert.notEqual(await page.locator('#attn .attn-row').first().evaluate(e => getComputedStyle(e).outlineStyle), 'none');
    await page.evaluate(() => window.__twin.showTab('tree')); await page.locator('#tree .tn').first().focus();
    assert.notEqual(await page.locator('#tree .tn').first().evaluate(e => getComputedStyle(e).outlineStyle), 'none');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[title]')].map(e => e.title).filter(t => /[֐-׿]/.test(t))), [], 'tooltips are English');
    const leak = await page.evaluate(() => {
      const orig = THREE.BufferGeometry.prototype.dispose; THREE.BufferGeometry.prototype.dispose = function () { this.__gone = true; return orig.call(this); };
      const seen = []; const grab = () => __twin.scene.traverse(o => { if (o.type === 'Box3Helper' && !seen.includes(o)) seen.push(o); });
      grab(); for (let i = 0; i < 5; i++) { __twin.select('SETUP-003', { keepCamera: true, refresh: true }); grab(); }
      THREE.BufferGeometry.prototype.dispose = orig; return seen.filter(h => !h.parent && !h.geometry.__gone).length;
    });
    assert.equal(leak, 0, 'replaced selection boxes are disposed');
    pass('opaque selected rack button, focus rings on attention + tree rows, English tooltips, no selection-box leak');

    // 11 — live / JSON values never become HTML (switch assignment port, live states, ids)
    const injected = await page.evaluate(() => {
      const t = __twin; t.S.live.sw.opt11 = { switch: 'SW<img id="xss1">', port: '<img id="xss2">' };
      t.computeModel(); t.buildItems(); t.select('LIVE-opt11', { keepCamera: true }); const n1 = document.querySelectorAll('#xss1, #xss2').length;
      t.showTab('tree'); t.select(t.S.recs.get('LIVE-opt11').shelf, { keepCamera: true }); const n2 = document.querySelectorAll('#xss1, #xss2').length;
      delete t.S.live.sw.opt11; t.computeModel(); t.buildItems(); return n1 + n2;
    });
    assert.equal(injected, 0, 'switch name / port are escaped');
    pass('HTML in live switch assignments is shown as text');

    // 12 — rebuilt outlines free their materials; a spare chassis can go into a plain cabinet; hidden walls are not pickable
    const outlines = await page.evaluate(() => {
      const mats = [...__twin.S.recs.values()].filter(r => r.cat === 'item' && r.edges.length).flatMap(r => r.edges.map(e => e.material));
      const orig = THREE.Material.prototype.dispose; THREE.Material.prototype.dispose = function () { this.__gone = true; return orig.call(this); };
      __twin.computeModel(); __twin.buildItems({ refresh: true }); THREE.Material.prototype.dispose = orig;
      return { total: mats.length, gone: mats.filter(m => m.__gone).length };
    });
    assert.ok(outlines.total > 10); assert.equal(outlines.gone, outlines.total, 'old outline materials are disposed');
    await page.evaluate(() => { const t = __twin; const it = t.S.data.items.find(i => i.type === 'spare-chassis'); const cab = t.S.data.storage.find(s => s.template !== 'trayRack');
      t.toggleEdit(true); t.select(it.id, { keepCamera: true }); t.startMove(it.id); t.finishMove(t.S.recs.get(cab.id)); });   // opens the confirmation
    await dialogOpen(page).waitFor(); await page.locator('#cfActions [data-choice="move"]').click(); await page.waitForTimeout(300);
    const chassis = await page.evaluate(async () => {
      const t = __twin; const it = t.S.data.items.find(i => i.type === 'spare-chassis'); const cab = t.S.data.storage.find(s => s.template !== 'trayRack');
      const rec = t.S.recs.get(it.id); const b = new THREE.Box3(); rec.meshes.forEach(m => b.expandByObject(m));
      const inside = new THREE.Box3().setFromObject(t.S.recs.get(cab.id).group).expandByScalar(0.05).containsBox(b);
      let helper = null; t.scene.traverse(o => { if (o.type === 'Box3Helper') helper = o.box.clone(); });
      return { storage: rec.item.storage === cab.id, meshes: rec.meshes.length, inside, helperOnIt: !!helper && helper.expandByScalar(0.05).containsBox(b) };
    });
    assert.deepEqual(chassis, { storage: true, meshes: chassis.meshes, inside: true, helperOnIt: true }); assert.ok(chassis.meshes > 0);
    await page.evaluate(() => { localStorage.removeItem('twin.draft'); __twin.S.dirty = false; });
    const walls = await page.evaluate(async () => {
      const t = __twin; t.toggleEdit(false); t.closeDetail(); t.setView('orbit'); await new Promise(r => setTimeout(r, 900));
      const cv = document.querySelector('#c').getBoundingClientRect(); const door = t.S.recs.get('DOOR-01');
      const q = new THREE.Box3().setFromObject(door.meshes[0]).getCenter(new THREE.Vector3()).project(t.camera);
      const pt = { clientX: cv.left + (q.x + 1) / 2 * cv.width, clientY: cv.top + (1 - q.y) / 2 * cv.height };
      const shown = t.pickAt(pt)?.object.userData.id; document.querySelector('#tWalls').click(); const hidden = t.pickAt(pt)?.object.userData.id || null; document.querySelector('#tWalls').click();
      return { shown, hidden };
    });
    assert.equal(walls.shown, 'DOOR-01'); assert.notEqual(walls.hidden, 'DOOR-01', 'a hidden wall door cannot be picked');
    pass('outline materials disposed on rebuild, chassis stored in a cabinet (selection box on it), hidden walls not pickable');

    // 13 — a refresh answered after a move must not put the old placement back
    let delayOnce = false, delayStarted, delayDone;
    const started = new Promise(r => { delayStarted = r; }), done = new Promise(r => { delayDone = r; });
    await page.route('**/api/rack-slots', async route => {
      if (delayOnce && route.request().method() === 'GET') { delayOnce = false; const old = await route.fetch(); delayStarted(); await new Promise(r => setTimeout(r, 2500)); await route.fulfill({ response: old }); delayDone(); return; }
      return route.fallback();
    });
    delayOnce = true; page.evaluate(() => __twin.refreshStatuses()).catch(() => {});
    await started;   // a refresh (this one or the 15 s timer) now holds the old rack-slots
    const late = await page.evaluate(() => {
      const t = __twin; const mover = [...t.S.recs.values()].find(r => r.cat === 'item' && r.item?.type === 'opt' && r.item.live?.inDcim && r.shelf);
      const target = [...t.S.recs.values()].find(s => s.cat === 'shelf' && s.setup !== mover.setup && t.movePlan(mover.id, s)?.swappable);
      t.toggleEdit(true); t.startMove(mover.id); t.finishMove(target); return { id: mover.id, target: target.id };   // opens the confirmation
    });
    const lateWrite = page.waitForResponse(r => r.url().endsWith('/api/rack-layout') && r.request().method() === 'PUT');
    await dialogOpen(page).waitFor(); await page.locator('#cfActions [data-choice="swap"]').click(); assert.equal((await lateWrite).status(), 200);
    await done; await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(id => __twin.S.recs.get(id).shelf, late.id), late.target, 'late refresh response did not undo the move');
    await page.unroute('**/api/rack-slots');
    pass('a refresh answered after a move keeps the new placement');

    // 13b — re-checks right before acting: the occupant changed while the move dialog was open → nothing is written,
    // the user is asked again; a PDU outlet relabelled while the power dialog was open → nothing is switched;
    // there is no move without the dialog; non-computer labels never take a U slot
    const swapCase = await page.evaluate(() => {
      const t = __twin; const mover = t.S.recs.get('LIVE-opt12');
      const target = [...t.S.recs.values()].find(s => s.cat === 'shelf' && s.setup !== mover.setup && t.movePlan(mover.id, s)?.swappable);
      const occ = t.movePlan(mover.id, target).occupant;
      const other = [...t.S.recs.values()].find(r => r.cat === 'item' && r.item?.type === 'opt' && r.item.live?.inDcim && r.setup === target.setup && r.id !== occ.id && r.shelf && r.shelf !== target.id);
      t.toggleEdit(true); t.select(mover.id, { keepCamera: true }); t.startMove(mover.id); t.finishMove(target);
      return { target: target.id, rack: occ.item.live.rack, occ: { key: occ.item.dcim.optKey, u: occ.item.live.u, name: occ.def.name }, other: { key: other.item.dcim.optKey, u: other.item.live.u, name: other.def.name } };
    });
    await dialogOpen(page).waitFor();
    assert.match(await page.locator('#cfBody').innerText(), new RegExp(swapCase.occ.name));
    // another session swaps the occupant with its neighbour while the dialog is open
    const csrf = (await (await ctx.request.get(origin + '/api/auth/status')).json()).csrf_token;
    const slotsNow = await ctx.request.get(origin + '/api/rack-slots'); const slotsData = await slotsNow.json();
    (slotsData[swapCase.rack] = slotsData[swapCase.rack] || {})[swapCase.occ.key] = swapCase.other.u; slotsData[swapCase.rack][swapCase.other.key] = swapCase.occ.u;
    assert.equal((await ctx.request.put(origin + '/api/rack-slots', { data: slotsData, headers: { 'If-Match': slotsNow.headers()['etag'], 'X-DCIM-CSRF': csrf } })).status(), 200);
    const quietMove = posts.length;
    await page.locator('#cfActions [data-choice="swap"]').click();
    await page.waitForFunction(name => document.querySelector('#confirmModal:not(.hidden) #cfBody')?.innerText.includes(name), swapCase.other.name, { timeout: 15000 });
    assert.equal(posts.slice(quietMove).filter(p => p.path === '/api/rack-layout').length, 0, 'nothing written for a changed destination');
    await page.keyboard.press('Escape'); await page.locator('#moveCancel').click();
    // the debug handle cannot move without the dialog either
    await page.evaluate(() => { const t = __twin; t.startMove('LIVE-opt12'); t.finishMove([...t.S.recs.values()].find(s => s.cat === 'shelf' && s.id !== t.S.recs.get('LIVE-opt12').shelf)); });
    await dialogOpen(page).waitFor(); await page.keyboard.press('Escape'); await page.locator('#moveCancel').click(); await page.evaluate(() => __twin.toggleEdit(false));
    assert.equal(posts.slice(quietMove).filter(p => /rack-layout|rack-items/.test(p.path)).length, 0);
    // PDU outlet menu: the outlet is relabelled while the confirmation is open → refused
    const pduRec = await page.evaluate(() => { const r = [...__twin.S.recs.values()].find(r => r.cat === 'item' && r.item?.type === 'pdu' && r.item.live?.device?.id === 'pdu1'); __twin.select(r.id, { keepCamera: true }); return r.id; });
    await page.locator('#dBody [data-outlet="3"]').click(); await page.locator('.pop [data-a="cycle"]').click(); await dialogOpen(page).waitFor();
    assert.match(await page.locator('#cfTitle').innerText(), /^Power cycle OPT13\?$/);
    await page.evaluate(() => { const st = __twin.S.live.pdu.pdu1; st.outlets.find(o => o.number === 3).label = 'OPT99'; });   // a refresh remapped it
    const quietPower = posts.length; await page.locator('#cfActions [data-choice="go"]').click(); await page.waitForTimeout(400);
    assert.equal(posts.slice(quietPower).filter(p => /\/power$/.test(p.path)).length, 0, 'a remapped outlet is not switched');
    await page.evaluate(() => __twin.refreshStatuses());
    // "empty" before four computers: the fourth still gets U4 (a shelf), like Lab Manager's rack view
    const emptyLabel = await page.evaluate(() => {
      const t = __twin; const pdu = t.S.live.devices.find(d => d.id === 'pdu7'); const saved = { labels: pdu.labels, slots: t.S.live.rackSlots, order: t.S.live.rackOrder, ov: t.S.live.rackOverrides, pdu: t.S.live.pdu.pdu7 };
      pdu.labels = { 1: 'empty', 2: 'KVM Power', 3: 'OPT71', 4: 'OPT72', 5: 'OPT73', 6: 'OPT74' }; t.S.live.pdu.pdu7 = { reachable: false, outlets: [] };
      t.S.live.rackSlots = {}; t.S.live.rackOrder = {}; t.S.live.rackOverrides = {}; t.computeModel();
      const items = t.S.model.items.filter(i => i.type === 'opt' && i.live?.inDcim && i.live.rack === 'Rack-07');
      const res = { names: items.map(i => i.name).sort(), u: Object.fromEntries(items.map(i => [i.name, i.live.u])), shelves: items.filter(i => i.shelf).length };
      pdu.labels = saved.labels; Object.assign(t.S.live, { rackSlots: saved.slots, rackOrder: saved.order, rackOverrides: saved.ov }); t.S.live.pdu.pdu7 = saved.pdu; t.computeModel(); t.buildItems();
      return res;
    });
    assert.deepEqual(emptyLabel, { names: ['OPT71', 'OPT72', 'OPT73', 'OPT74'], u: { OPT71: 1, OPT72: 2, OPT73: 3, OPT74: 4 }, shelves: 4 });
    pass('re-checks before acting: changed move destination asks again, remapped PDU outlet refused, no dialog-less move, non-computer labels take no U');

    // 14 — keyboard-only Move: Move button → destination list → Move here, and Enter on a tree shelf row
    await page.evaluate(() => { __twin.toggleEdit(true); __twin.select('LIVE-opt12', { keepCamera: true }); });
    await page.locator('#eMove').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'moveTarget', 'focus goes to the destination list');
    const kbTarget = await page.evaluate(() => { const t = __twin; const m = t.S.recs.get('LIVE-opt12'); return [...t.S.recs.values()].find(s => s.cat === 'shelf' && s.id !== m.shelf).id; });
    await page.selectOption('#moveTarget', kbTarget); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'moveGo'); await page.keyboard.press('Enter');
    await dialogOpen(page).waitFor(); assert.ok(['Move OPT12?', `${kbTarget} is occupied`].includes(await page.locator('#cfTitle').innerText()), 'move confirmation for the chosen shelf');
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    await page.evaluate(() => __twin.showTab('tree'));
    const row = page.locator(`#tree .tn[data-id="${kbTarget}"]`); await row.focus(); await page.keyboard.press('Enter');
    await dialogOpen(page).waitFor(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => __twin.S.moveItem), 'LIVE-opt12', 'still moving after Cancel');
    await page.locator('#moveCancel').click(); await page.evaluate(() => __twin.toggleEdit(false));
    pass('Move works from the keyboard (destination list, tree rows)');

    // 15 — saving lab-data.json: an edit made during the save stays unsaved; a stale page refuses to overwrite
    await page.reload(); await page.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.recs.size > 10); await page.waitForTimeout(800);   // drop the local chassis edit
    progress('reloaded'); const other = await open('admin'); progress('second window open');
    const editSetup = p => p.evaluate(() => { const t = __twin; if (!t.S.editMode) t.toggleEdit(true); t.select('SETUP-001', { keepCamera: true }); document.querySelector('#eSave').click(); return t.S.dirty; });
    assert.equal(await editSetup(page), true);
    let releasePut, putArrived; const putHeld = new Promise(r => { releasePut = r; }), putSent = new Promise(r => { putArrived = r; });
    await page.route('**/api/twin-data', async route => { if (route.request().method() === 'PUT') { putArrived(); await putHeld; } return route.fallback(); });
    const put1 = page.waitForResponse(r => r.url().endsWith('/api/twin-data') && r.request().method() === 'PUT');
    await page.locator('#sbSave').click(); await putSent;   // the request body is fixed now; the next edit is not in it
    assert.equal(await editSetup(page), true, 'edit while the save is in flight');
    releasePut(); assert.equal((await put1).status(), 200); await page.waitForTimeout(300); progress('first save done');
    assert.equal(await page.evaluate(() => __twin.S.dirty), true, 'an edit made during the save is still unsaved');
    await page.unroute('**/api/twin-data');
    const put2 = page.waitForResponse(r => r.url().endsWith('/api/twin-data') && r.request().method() === 'PUT');
    await page.locator('#sbSave').click(); assert.equal((await put2).status(), 200); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => __twin.S.dirty), false);
    // the second window still holds the file as it was before these saves
    const staleWrites = other.posts.length; assert.equal(await editSetup(other.page), true);
    await other.page.locator('#sbSave').click(); await dialogOpen(other.page).waitFor({ timeout: 60000 }); progress('stale dialog shown');   // two WebGL pages: slow on a busy machine
    assert.equal(await other.page.locator('#cfTitle').innerText(), 'lab-data.json changed on the server');
    assert.equal(other.posts.filter(p => p.path === '/api/twin-data').length, 0, 'the stale window did not overwrite');
    assert.equal(other.posts.length, staleWrites);
    await other.page.locator('#cfActions [data-choice="cancel"]').click();
    assert.equal(await other.page.evaluate(() => __twin.S.dirty), true, 'its edits stay in the browser');
    await other.page.evaluate(() => localStorage.removeItem('twin.draft')); await other.ctx.close();
    await page.evaluate(() => { localStorage.removeItem('twin.draft'); __twin.toggleEdit(false); });
    pass('save keeps edits made during the request unsaved and refuses to overwrite a newer lab-data.json');

    // 16 — the Lab Manager fallback tab creates the hidden Twin iframe only when the Twin tab is opened
    const embedPage = await ctx.newPage();
    await embedPage.setContent('<div><button class="px-4 border-b-2 text-nv-400">Dashboard</button><button class="px-4 border-b-2">DCIM</button></div>');
    await embedPage.addScriptTag({ content: require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'lab-twin', 'embed-tab.js'), 'utf8') });
    await embedPage.getByRole('button', { name: 'Dashboard' }).click(); await embedPage.getByRole('button', { name: 'DCIM' }).click();
    assert.equal(await embedPage.locator('iframe').count(), 0, 'no hidden Twin before the tab is opened');
    await embedPage.getByRole('button', { name: '3D Twin' }).click();
    assert.equal(await embedPage.locator('iframe').count(), 1); await embedPage.close();
    pass('embedded Twin iframe is created only when its tab is opened');
    await ctx.close();

    // viewer: an explanation instead of an empty power card
    const viewer = await open('viewer');
    await viewer.page.evaluate(() => __twin.select('LIVE-opt12', { keepCamera: true }));
    await viewer.page.getByText('Read-only · Power and console need the Operator role.').waitFor();
    assert.equal(await viewer.page.locator('#dBody [data-pw], #dBody [data-kvm]').count(), 0);
    await viewer.ctx.close();
    pass('viewer sees the read-only explanation');

    // reduced motion: camera jumps, no CSS animation
    const calm = await open('admin', { reducedMotion: 'reduce' });
    await calm.page.evaluate(() => __twin.select('SETUP-002', { fly: true })); await calm.page.waitForTimeout(120);
    assert.equal(await calm.page.evaluate(() => !!__twin.S.tween), false, 'no camera glide');
    assert.equal(await calm.page.evaluate(() => getComputedStyle(document.querySelector('.sb-dot')).animationName), 'none');
    await calm.ctx.close();
    pass('prefers-reduced-motion: instant camera, no pulsing');

    assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(unexpected, [], 'no writes outside the fixture power / KVM / placement stores');
    console.log(JSON.stringify({ passed: checks, errors }, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
