// Digital Twin data integrity (WP1): while connected, Lab Manager is the inventory of every DCIM-mapped rack.
// Isolated fixture only (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1), 1440×900, Operator.
// Covers: lab-data.json servers / units / PDUs / KVMs that Lab Manager does not know leave the mapped racks and are listed
// under Unplaced as "In lab-data.json, not in Lab Manager" (one server per floor); the offline layout is unchanged;
// Edit layout offers only Move / Owner and "Edit details in Racks" for Lab Manager records and "Add in Racks…" instead of
// twin-only adds on mapped racks and derived floors; a lab-data.json record cannot be moved onto a mapped rack; an owner
// change reads Lab Manager back (refreshSoon); PDU power is grey "Stale – last reading hh:mm" once the reading is old.
// QA follow-ups: a PDU that answers "unreachable" gives grey "No data · PDU unreachable" (no fresh-looking age); a
// lab-data.json server Lab Manager does not know is reported once in Data quality (no extra "not in DCIM labels");
// its editor has no Unplace (that would wipe the place lab-data.json keeps).
// Writes only fixture data: one owner change of OPT11 (PUT /api/opt-owners/opt11).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const JSON_ONLY = ['Opt207', 'optn85', 'Opt168', 'Opt133'];   // lab-data.json servers on Rack-01 that the fixture PDUs do not label

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [], errors = [], unexpected = [];
  const pass = m => { checks.push(m); if (process.env.DCIM_QA_VERBOSE) console.error('ok: ' + m); };
  const allowed = [/^\/api\/auth\/login$/, /^\/api\/opt-owners\/opt11$/];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.route('**/*', route => {
      const req = route.request(); if (!req.url().startsWith(origin + '/')) return route.abort();
      const path = new URL(req.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !allowed.some(re => re.test(path))) { unexpected.push(req.method() + ' ' + path); return route.abort(); }
      return route.continue();
    });
    assert.equal((await ctx.request.post(origin + '/api/auth/login', { data: { username: 'operator', password: 'test-password-123' } })).status(), 200);
    assert.equal((await (await ctx.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
    await page.goto(origin + '/twin/');
    await page.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.recs.size > 10 && window.__twin.S.live.pdu.pdu1 && window.__twin.S.live.pduAt?.pdu1 && window.__twin.S.live.pduAt?.pdu7, null, { timeout: 60000 });
    await page.waitForTimeout(1000);

    // 1 — one server per floor, no lab-data.json server on a mapped rack, all of them under Unplaced
    const model = await page.evaluate(names => {
      const t = __twin, S = t.S; const perShelf = {}, unitsPerShelf = {};
      for (const r of S.recs.values()) if (r.cat === 'item' && r.shelf && r.item) {
        if (r.item.type === 'opt') perShelf[r.shelf] = (perShelf[r.shelf] || 0) + 1;
        else if (r.item.type !== 'pdu') unitsPerShelf[r.shelf] = (unitsPerShelf[r.shelf] || 0) + 1;
      }
      const mapped = new Set(S.data.setups.filter(s => s.dcimRack).map(s => s.id));
      const jsonOnMapped = S.model.items.filter(i => !i.id.startsWith('LIVE-') && mapped.has(i.setup) && (i.type === 'opt' || i.type.startsWith('equip-')));
      // PDUs and KVMs are fixed infrastructure: each stays where lab-data.json puts it, matched or not.
      const infraMoved = S.data.items.filter(d => d.type === 'pdu' || d.type === 'kvm').filter(d => { const i = S.model.items.find(x => x.id === d.id); return !i || i.notInLm || (i.setup ?? null) !== (d.setup ?? null); }).map(d => d.id + ' ' + d.name);
      const named = names.map(n => { const i = S.model.items.find(x => x.name === n); const r = i && S.recs.get(i.id); return { n, id: i?.id, setup: i?.setup ?? null, shelf: i?.shelf ?? null, unplaced: !!r?.unplaced, where: r ? t.placeLabel(r) : '' }; });
      return { maxOpt: Math.max(0, ...Object.values(perShelf)), multi: Object.entries(perShelf).filter(([, n]) => n > 1), maxUnits: Math.max(0, ...Object.values(unitsPerShelf)), jsonOnMapped: jsonOnMapped.map(i => i.id + ' ' + i.name), infraMoved, named,
        live11: S.model.items.find(i => i.id === 'LIVE-opt11')?.setup };
    }, JSON_ONLY);
    assert.ok(model.maxOpt <= 1, 'one server per floor: ' + JSON.stringify(model.multi));
    assert.ok(model.maxUnits <= 1, 'one unit per floor, got ' + model.maxUnits);
    assert.deepEqual(model.jsonOnMapped, [], 'no lab-data.json server / unit on a DCIM-mapped rack');
    assert.deepEqual(model.infraMoved, [], 'every PDU and KVM stays where lab-data.json puts it');
    for (const x of model.named) {
      assert.ok(x.id, x.n + ' is still in the model');
      assert.deepEqual([x.setup, x.shelf, x.unplaced, x.where], [null, null, true, 'In lab-data.json, not in Lab Manager'], x.n + ': ' + JSON.stringify(x));
    }
    assert.equal(model.live11, 'SETUP-001', 'OPT11 is on Rack-01');
    await page.evaluate(() => __twin.showTab('unplaced'));
    const unplaced = await page.locator('#unplaced').textContent();   // textContent: the headings are upper-cased by CSS
    assert.match(unplaced, /In lab-data.json, not in Lab Manager/);
    for (const n of JSON_ONLY) assert.ok(unplaced.includes(n), n + ' listed under Unplaced');
    const dq = await page.evaluate(() => __twin.S.attention.filter(e => e.kind === 'unplaced' && /not in Lab Manager/.test(e.text)).length);
    assert.ok(dq >= JSON_ONLY.length, 'data-quality entries name them: ' + dq);
    const once = await page.evaluate(names => names.map(n => { const t = __twin, S = t.S; const i = S.model.items.find(x => x.name === n);
      const dqFor = S.attention.filter(e => e.group === 'dq' && (e.id === i.id || e.text.includes(n)));
      t.select(i.id, { keepCamera: true });
      const sum = [...document.querySelectorAll('#dBody details.more summary')].map(x => x.textContent).find(x => /^Data quality/.test(x)) || '';
      return { n, type: i.type, kinds: dqFor.map(e => e.kind), drawer: sum, li: [...document.querySelectorAll('#dBody .dq-ul li')].length }; }), JSON_ONLY);
    await page.evaluate(() => __twin.closeDetail());
    for (const x of once) {
      assert.deepEqual(x.kinds, ['unplaced'], x.n + ' is reported once in Data quality: ' + JSON.stringify(x));
      assert.equal(x.drawer, 'Data quality · 1 issue', x.n + ' drawer: ' + JSON.stringify(x));
      assert.equal(x.li, 1, x.n + ' drawer lists one data-quality finding');
    }
    assert.ok(once.some(x => x.type === 'opt'), 'at least one is a server (OPT)');
    pass(`one server per floor (max ${model.maxOpt}) and one unit (max ${model.maxUnits}); ${JSON_ONLY.join(', ')} have no setup and are under Unplaced as "In lab-data.json, not in Lab Manager"`);
    pass(`${JSON_ONLY.join(', ')}: one Data quality entry each (no "not in DCIM labels" duplicate), drawer "Data quality · 1 issue"`);

    // 2 — Edit layout: derived floor and mapped shelf / rack offer "Add in Racks…", never a twin-only add
    const ed = await page.evaluate(names => {
      const t = __twin, S = t.S; t.toggleEdit(true); const body = () => document.querySelector('#dBody');
      const look = id => { t.select(id, { keepCamera: true }); const b = body(); const a = b.querySelector('#eAddRacks');
        return { here: !!b.querySelector('#eAddHere'), bay: !!b.querySelector('#eAddBay'), store: !!b.querySelector('#eAddStore'), racks: a ? { text: a.textContent.trim(), href: a.getAttribute('href'), target: a.target } : null, derived: !!S.recs.get(id)?.def.derived }; };
      const shelf11 = S.recs.get('LIVE-opt11').shelf;
      const out = { derived: look('SHELF-SETUP-005-L0'), shelf: look(shelf11), rack: look('SETUP-001'), storage: look('STORAGE-01') };
      t.select('LIVE-opt11', { keepCamera: true });
      const b = body(); const link = [...b.querySelectorAll('a')].find(a => /Edit details in Racks/.test(a.textContent));
      out.jsonOnly = names.map(n => { const i = S.model.items.find(x => x.name === n); t.select(i.id, { keepCamera: true }); const e = body();
        return { n, unplace: !!e.querySelector('#eUnplace'), move: !!e.querySelector('#eMove'), note: [...e.querySelectorAll('.edit-note')].map(x => x.textContent).join(' | ') }; });
      t.select('LIVE-opt11', { keepCamera: true });
      out.opt11 = { name: !!b.querySelector('#eName'), type: !!b.querySelector('#eType'), pdu: !!b.querySelector('#ePdu'), move: !!b.querySelector('#eMove'), owner: !!b.querySelector('#eOwner'), materialize: !!b.querySelector('#eMaterialize'), href: link?.getAttribute('href') || '', target: link?.target || '' };
      return out;
    }, JSON_ONLY);
    assert.equal(ed.derived.derived, true, 'SHELF-SETUP-005-L0 is the derived Rack-05 floor 4');
    assert.equal(ed.derived.here, false, 'derived floor: no #eAddHere');
    assert.match(ed.derived.racks?.href || '', /tab=racks&rack=Rack-05/);
    assert.equal(ed.shelf.here, false, 'mapped shelf: no #eAddHere');
    assert.match(ed.shelf.racks?.text || '', /^Add in Racks/);
    assert.match(ed.shelf.racks.href, /tab=racks&rack=Rack-01/); assert.equal(ed.shelf.racks.target, '_top');
    assert.equal(ed.rack.bay, false, 'mapped rack: no #eAddBay'); assert.match(ed.rack.racks?.href || '', /tab=racks&rack=Rack-01/);
    assert.equal(ed.storage.store, true, '#eAddStore stays (geometry objects)');
    assert.deepEqual([ed.opt11.name, ed.opt11.type, ed.opt11.pdu, ed.opt11.materialize], [false, false, false, false], 'OPT11: no Name / Type / PDU / twin copy');
    assert.deepEqual([ed.opt11.move, ed.opt11.owner], [true, true], 'OPT11: Move and Owner');
    assert.match(ed.opt11.href, /tab=racks&rack=Rack-01/); assert.equal(ed.opt11.target, '_top');
    for (const x of ed.jsonOnly) {
      assert.equal(x.unplace, false, x.n + ': no Unplace for a record that is only in lab-data.json');
      assert.equal(x.move, true, x.n + ': Move stays');
      assert.match(x.note, /Unplaced here because Lab Manager does not list it; lab-data.json keeps it on Rack-01/, x.n + ' note');
    }
    pass(`Edit layout: ${JSON_ONLY.join(', ')} offer no Unplace (their lab-data.json place is kept) and say why they are unplaced`);
    pass('Edit layout: derived Rack-05 floor 4, a Rack-01 shelf and Rack-01 show "Add in Racks…" (target _top, rack=…); OPT11 has only Move, Owner and "Edit details in Racks"');

    // 3 — a lab-data.json record cannot be moved onto a mapped rack (it would vanish again on the next refresh)
    const moveErr = await page.evaluate(id => { const t = __twin; return t.movePlan(id, t.S.recs.get('SHELF-04'))?.error || ''; }, model.named[0].id);
    assert.match(moveErr, /Rack-01 gets its servers and units from Lab Manager/);
    pass('moving a lab-data.json server onto Rack-01 is refused with "add it there in Racks"');

    // 4 — an owner change in 3D reads Lab Manager back right after the write
    await page.evaluate(() => __twin.select('LIVE-opt11', { keepCamera: true }));
    const choice = await page.evaluate(() => [...document.querySelectorAll('#eOwner option')].find(o => o.value && !o.disabled && !o.selected)?.value || '');
    assert.ok(choice, 'an engineer to choose');
    const put = page.waitForResponse(r => r.request().method() === 'PUT' && /\/api\/opt-owners\/opt11$/.test(r.url()));
    const reread = page.waitForRequest(r => r.method() === 'GET' && /\/api\/opt-owners$/.test(r.url()), { timeout: 15000 });
    await page.locator('#eOwner').selectOption(choice);
    assert.equal((await put).status(), 200);
    await reread;
    await page.waitForFunction(name => __twin.S.model.items.find(i => i.id === 'LIVE-opt11')?.owner === name, choice, { timeout: 15000 });
    pass(`owner of OPT11 saved in Lab Manager (${choice}) and read back at once`);
    await page.evaluate(() => { __twin.closeDetail(); __twin.toggleEdit(false); });

    // 5 — PDU power is honest about its age: fresh → ON / OFF with PDU, outlet and age; failed polls → grey "Stale"
    const fresh = await page.evaluate(() => { const t = __twin; t.select('LIVE-opt11', { keepCamera: true });
      const cell = [...document.querySelectorAll('#dBody .scell')].map(c => ({ l: c.querySelector('.sl')?.textContent, v: c.querySelector('.sv')?.textContent, s: c.querySelector('.ss')?.textContent || '' }));
      return { power: t.powerOf(t.S.recs.get('LIVE-opt11').item), cells: cell }; });
    assert.equal(fresh.power, 'on', 'OPT11 is on with a fresh reading');
    const pc = fresh.cells.find(c => c.l === 'Power');
    assert.match(pc.v, /^On/); assert.match(pc.s, /^PDU 01 · outlet 1 · \d+ s ago$/);
    assert.ok(fresh.cells.some(c => c.l === 'Ping monitor'), 'the ping cell is labelled "Ping monitor"');
    const unreach = await page.evaluate(() => { const t = __twin; t.select('LIVE-opt71', { keepCamera: true });
      const c = [...document.querySelectorAll('#dBody .scell')].find(x => x.querySelector('.sl')?.textContent === 'Power');
      return { v: c.querySelector('.sv').textContent, s: c.querySelector('.ss')?.textContent || '', cls: c.className, color: getComputedStyle(c.querySelector('.sv')).color, power: t.powerOf(t.S.recs.get('LIVE-opt71').item) }; });
    assert.equal(unreach.v, 'No data · PDU unreachable', 'OPT71 on the unreachable PDU 07');
    assert.ok(!/\bbad\b/.test(unreach.cls) && /\bunk\b/.test(unreach.cls), 'grey unknown tone, never red: ' + unreach.cls);
    assert.equal(unreach.color, 'rgb(156, 163, 175)', 'Power value colour');
    assert.match(unreach.s, /^PDU 07 · outlet \d+ · PDU unreachable · checked (\d+ s ago|just now|\d+ min ago)$/);
    assert.doesNotMatch(unreach.s.replace(/checked .*$/, ''), /\d+ s ago/, 'no bare age that reads as a fresh reading');
    assert.equal(unreach.power, 'unknown');
    pass(`PDU 07 answers unreachable: OPT71 Power "${unreach.v}" in grey, source "${unreach.s}"`);
    await page.route('**/api/pdus/*/status', r => r.abort());
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { const real = window.__realNow || (window.__realNow = Date.now.bind(Date)); window.__shift = (window.__shift || 0) + 16000; Date.now = () => real() + window.__shift; });
      await page.evaluate(() => __twin.refreshStatuses());
    }
    await page.waitForFunction(() => __twin.powerOf(__twin.S.recs.get('LIVE-opt11').item) === 'unknown', null, { timeout: 10000 });
    const stale = await page.evaluate(() => {
      const t = __twin, rec = t.S.recs.get('LIVE-opt11'); t.select('LIVE-opt11', { keepCamera: true });
      const body = rec.meshes[0]; const want = new THREE.Color('#6b7280').convertSRGBToLinear();
      const cell = [...document.querySelectorAll('#dBody .scell')].find(c => c.querySelector('.sl')?.textContent === 'Power');
      const shelf = t.S.recs.get(rec.shelf);
      return { power: body.userData.power, same: body.material.color.equals(want), hex: '#' + body.material.color.clone().convertLinearToSRGB().getHexString(),
        v: cell.querySelector('.sv').textContent, s: cell.querySelector('.ss')?.textContent || '', err: !!t.S.live.pduErr.pdu1, card: shelf.cardText, health: t.itemHealth(rec.item) };
    });
    assert.equal(stale.power, 'unknown'); assert.ok(stale.same, 'tower colour ' + stale.hex);
    assert.equal(stale.hex, '#6b7280');
    assert.match(stale.v, /Stale|No data/); assert.match(stale.v, /^Stale – last reading \d\d:\d\d$/);
    assert.match(stale.s, /PDU 01 · outlet 1 · .* · last poll failed \d\d:\d\d/);
    assert.ok(stale.err, 'the failed poll is recorded');
    assert.match(stale.card, /\? OPT11/, 'the shelf card shows ? for OPT11');
    assert.deepEqual(stale.health, { h: 'unknown', why: 'Power reading stale' });
    pass(`failed PDU polls: OPT11 tower ${stale.hex}, "${stale.v}", "${stale.s}"`);
    await page.unroute('**/api/pdus/*/status');
    await page.evaluate(() => __twin.refreshStatuses());
    await page.waitForFunction(() => __twin.powerOf(__twin.S.recs.get('LIVE-opt11').item) === 'on', null, { timeout: 10000 });
    pass('the next good reading turns OPT11 green again');

    // 6 — offline, lab-data.json is shown as before
    const offline = await page.evaluate(() => { const t = __twin; t.disconnect(); const i = t.S.model.items.find(x => x.name === 'Opt207'); return { setup: i.setup, shelf: i.shelf, placed: !t.S.recs.get(i.id).unplaced }; });
    assert.deepEqual(offline, { setup: 'SETUP-001', shelf: 'SHELF-04', placed: true });
    pass('offline: Opt207 is back on Rack-01 Shelf 1 from lab-data.json');

    assert.deepEqual(unexpected, [], 'no unexpected writes');
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`twin-data: ${checks.length} checks passed`); checks.forEach(c => console.log('  ✓ ' + c));
    await ctx.close();
  } catch (e) {
    console.error('FAILED after: ' + (checks[checks.length - 1] || '(nothing)')); console.error(e); if (errors.length) console.error('page errors:', errors); process.exitCode = 1;
  } finally { await browser.close(); }
})();
