// Lab Twin shelf cards and floor model — isolated fixture only: DCIM_TEST_ACCOUNTS=1 tests/browser/preview-server.py.
// Checks at 1440×900 (Operator):
//  1. the selected rack wins label space: after Reset + a click on each rack chip its cards are all shown with full detail
//     (full cards, or one-line cards that still carry power, name, IP and unit type), never hidden, never less detailed
//     than a neighbouring rack's cards; the same camera gives the same cards on a second run (no sticky state);
//  2. the app's floor model: every compute rack has 4 shelves, Rack-05 (3 shelves in lab-data.json) gets its 4th floor,
//     so OPT54 (u = 4) has a mesh, its power colour and a card; a storage-type rack has 16 shelves;
//  3. cards are not drawn over other racks: no shown card's sight line crosses another rack's box, and none of another
//     rack's cards is drawn over the selected rack from behind it (also after rotating around a focused rack);
//     A mesh raycast to each shown card must not hit another rack's posts, shelves or equipment (also on views that
//     graze a corner post, and 8 views around every rack);
//  6. the legend explains the server body power colours separately from health, in words also at 1440 / 1024 / 390 px;
//  the 3D switch marking follows the site: only generic units, never one named as something else or with a board OPN.
// Read-only: every non-GET request except the sign-in is aborted and reported; changes live only in the page.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const shots = process.env.DCIM_QA_SHOTS || 'C:/t/twin-shelves';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [], errors = [], writes = [];
  const pass = m => { checks.push(m); if (process.env.DCIM_QA_VERBOSE) console.error('ok: ' + m); };
  const shot = (page, name) => page.screenshot({ path: path.join(shots, name) });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.route('**/*', route => {
      const req = route.request(); if (!req.url().startsWith(origin + '/')) return route.abort();
      const p = new URL(req.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && p !== '/api/auth/login') { writes.push(`${req.method()} ${p}`); return route.abort(); }
      return route.continue();
    });
    assert.equal((await ctx.request.post(origin + '/api/auth/login', { data: { username: 'operator', password: 'test-password-123' } })).status(), 200);
    assert.equal((await (await ctx.request.get(origin + '/api/version')).json()).version, 'LOCAL PREVIEW - TEST DATA', 'Refuse any real lab environment');
    await ctx.addInitScript(() => { try { localStorage.setItem('dcim.seenVersion', 'LOCAL PREVIEW - TEST DATA'); } catch { /* ignore */ } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
    await page.goto(origin + '/twin/');
    await page.waitForFunction(() => window.__twin?.S.live.connected && window.__twin.S.recs.size > 10 && window.__twin.S.live.pdu.pdu1 && window.__twin.S.live.updatedAt, null, { timeout: 60000 });
    await page.waitForTimeout(1200);
    // software WebGL can take a few hundred ms per frame: wait for frames drawn after the camera stopped
    const settle = async () => {
      await page.waitForFunction(() => !__twin.S.tween && !__twin.controls.moving, null, { timeout: 20000 });
      await page.evaluate(() => { window.__f0 = __twin.renderer.info.render.frame; });
      await page.waitForFunction(() => __twin.renderer.info.render.frame >= window.__f0 + 3, null, { timeout: 20000 });
    };

    // ── 2. floor model
    const floors = await page.evaluate(() => {
      const t = __twin, S = t.S; const shelves = sid => [...S.recs.values()].filter(r => r.cat === 'shelf' && r.setup === sid);
      const per = Object.fromEntries(S.data.setups.map(su => [su.id, shelves(su.id).length]));
      const opt = S.recs.get('LIVE-opt54'); const c = opt?.meshes[0]?.material.color;
      const sh = opt?.shelf ? S.recs.get(opt.shelf) : null;
      return { per, json: S.data.shelves.length, opt54: opt ? { shelf: opt.shelf, meshes: opt.meshes.length, u: opt.item.live?.u, power: opt.power, rgb: c ? [c.r, c.g, c.b] : null, shelfU: sh ? t.shelfToU(sh.setup, sh.id) : null, derived: !!sh?.def.derived, card: sh?.cardText || '' } : null,
        r5: shelves('SETUP-005').sort((a, b) => b.level - a.level).map(r => [r.id, t.shelfToU('SETUP-005', r.id), +r.y.toFixed(2)]) };
    });
    assert.ok(Object.values(floors.per).every(n => n === 4), 'every compute rack has 4 shelves: ' + JSON.stringify(floors.per));
    assert.equal(floors.json, 27, 'lab-data.json shelves are not changed (the 4th floor of Rack-05 is derived)');
    assert.deepEqual(floors.r5.map(x => x.slice(0, 2)), [['SHELF-19', 1], ['SHELF-18', 2], ['SHELF-17', 3], ['SHELF-SETUP-005-L0', 4]], 'Rack-05 floors 1-3 stay on the known shelves, floor 4 is below them: ' + JSON.stringify(floors.r5));
    assert.ok(floors.opt54 && floors.opt54.shelf === 'SHELF-SETUP-005-L0' && floors.opt54.meshes > 0 && floors.opt54.u === 4 && floors.opt54.shelfU === 4, 'OPT54 (u 4) is on Rack-05 floor 4 with a mesh: ' + JSON.stringify(floors.opt54));
    const [cr, cg, cb] = floors.opt54.rgb; assert.ok(floors.opt54.power === 'on' && cg > 0.3 && cg > 3 * cr && cg > 3 * cb, 'OPT54 body is green (power on): ' + floors.opt54.rgb);
    assert.match(floors.opt54.card, /^Rack-05 › Shelf 4$/m); assert.match(floors.opt54.card, /^ON OPT54 opt54$/m, 'OPT54 card: ' + floors.opt54.card);
    // a storage-type rack (the fixture's "Storage shelf": its rack device has model Storage) has 16 shelves
    const storage = await page.evaluate(() => {
      const t = __twin, S = t.S; const su = S.data.setups.find(s => s.id === 'SETUP-007'); const was = su.dcimRack;
      const flags = { storageShelf: t.isStorageRack('Storage shelf'), main: t.isStorageRack('Storage-Main'), rack01: t.isStorageRack('Rack-01'), rack06: t.isStorageRack('Rack-06') };
      su.dcimRack = 'Storage shelf'; t.computeModel(); t.buildItems();   // the floor model change rebuilds the racks
      const sh = [...S.recs.values()].filter(r => r.cat === 'shelf' && r.setup === 'SETUP-007').sort((a, b) => b.level - a.level);
      const out = { flags, n: sh.length, us: sh.map(r => t.shelfToU('SETUP-007', r.id)), ys: sh.map(r => r.y), known: sh.slice(0, 4).map(r => r.id), ids: new Set(sh.map(r => r.id)).size, dirty: S.dirty, top: sh[0].cardText.split('\n')[0] };
      su.dcimRack = was; t.computeModel(); t.buildItems();
      out.after = [...S.recs.values()].filter(r => r.cat === 'shelf' && r.setup === 'SETUP-007').length;
      return out;
    });
    assert.deepEqual(storage.flags, { storageShelf: true, main: true, rack01: false, rack06: false }, 'storage racks like the app (floors.js / DcimView rackStats)');
    assert.equal(storage.n, 16, 'a storage-type rack has 16 shelves'); assert.equal(storage.ids, 16);
    assert.deepEqual(storage.us, Array.from({ length: 16 }, (_, i) => i + 1), 'shelf 1 at the top … 16 at the bottom');
    assert.ok(storage.ys.every((y, i) => i === 0 || y < storage.ys[i - 1]) && storage.ys[0] < 2.1 && storage.ys[15] > 0.1, 'shelves inside the rack: ' + storage.ys);
    assert.deepEqual(storage.known, ['SHELF-27', 'SHELF-26', 'SHELF-25', 'SHELF-24'], 'the known shelves keep shelves 1-4');
    assert.equal(storage.top, 'Storage shelf › Shelf 1'); assert.equal(storage.dirty, false, 'nothing to save'); assert.equal(storage.after, 4, 'back to 4 floors');
    pass('floor model: 4 shelves per compute rack, Rack-05 floor 4 derived (OPT54 green, card "ON OPT54 opt54"), storage-type rack 16 shelves');

    // ── 1 + 3. the selected rack's cards after Reset + a rack chip, twice
    const snap = () => page.evaluate(() => {
      const t = __twin, S = t.S; const sel = t.S.selected; const cam = t.camera.position;
      const vr = document.querySelector('#c').getBoundingClientRect();
      const cards = [...S.recs.values()].filter(r => r.cat === 'shelf').map(r => {
        const e = r.label; const shown = e.style.display !== 'none' && getComputedStyle(e).visibility !== 'hidden'; const b = e.getBoundingClientRect();
        return { id: r.id, setup: r.setup, shown, lod: shown ? e.dataset.lod : '-', why: r.cardWhy || '', text: shown ? e.innerText.replace(/\s+/g, ' ').trim() : '',
          rect: shown ? [b.left - vr.left, b.top - vr.top, b.right - vr.left, b.bottom - vr.top].map(Math.round) : null, dist: r.cardAnchor.distanceTo(cam) };
      });
      // hosts of the servers on each shelf (what the full detail must contain)
      const hosts = {}; for (const r of S.recs.values()) if (r.cat === 'item' && r.shelf && r.item?.type === 'opt') (hosts[r.shelf] = hosts[r.shelf] || []).push(t.hostOf(r.item) || 'no IP');
      // independent sight-line check against every other rack's box (world space, from its own frame); the selected
      // rack's own cards stay even behind another rack (faded)
      const blocked = cards.filter(c => c.shown && c.setup !== sel).filter(c => {
        const rec = S.recs.get(c.id); const a = rec.cardAnchor;
        return [...S.recs.values()].some(su => {
          if (su.cat !== 'setup' || su.id === c.setup) return false;
          const inv = su.group.matrixWorld.clone().invert(); const o = cam.clone().applyMatrix4(inv), p = a.clone().applyMatrix4(inv);
          const d = p.clone().sub(o); const len = d.length(); const ray = new THREE.Ray(o, d.normalize());
          const box = su.localBox.clone().expandByScalar(-0.03); const hit = ray.intersectBox(box, new THREE.Vector3());
          return box.containsPoint(o) || (hit && hit.distanceTo(o) < len);
        });
      }).map(c => c.id);
      // the same with the drawn geometry: a ray from the camera to the card's anchor must not hit an opaque, visible mesh
      // of another rack (its posts, frame, shelves or the equipment on them) — catches a sight line that grazes a post
      const owner = new Map(); for (const r of S.recs.values()) { const sid = r.cat === 'setup' ? r.id : r.setup; if (!sid || !['setup', 'shelf', 'item'].includes(r.cat)) continue; for (const o of [r.group, ...(r.meshes || [])].filter(Boolean)) o.traverse?.(x => { if (!owner.has(x)) owner.set(x, sid); }); }
      const ownerOf = o => { for (let x = o; x; x = x.parent) if (owner.has(x)) return owner.get(x); return null; };
      const shownTo = o => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
      const rc = new THREE.Raycaster();
      const meshBlocked = cards.filter(c => c.shown && c.setup !== sel).map(c => {
        const a = S.recs.get(c.id).cardAnchor; const d = a.clone().sub(cam); const len = d.length(); rc.set(cam, d.normalize()); rc.far = len - 0.03;
        const hit = rc.intersectObjects(t.scene.children, true).find(h => h.object.isMesh && !(h.object.material?.transparent && (h.object.material.opacity ?? 1) < 0.5) && shownTo(h.object) && ownerOf(h.object) && ownerOf(h.object) !== c.setup);
        return hit ? `${c.id} behind ${ownerOf(hit.object)} at ${hit.distance.toFixed(2)} m` : null;
      }).filter(Boolean);
      // the selected rack's outline on screen (its 8 box corners; null when one is behind the camera) and distance
      let foot = null; const su = S.recs.get(sel);
      if (su?.cat === 'setup') {
        const b = su.localBox; const xs = [], ys = [];
        let front = true; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const v = new THREE.Vector3(x, y, z).applyMatrix4(su.group.matrixWorld).project(t.camera); if (v.z > 1) front = false; xs.push((v.x + 1) / 2 * vr.width); ys.push((1 - v.y) / 2 * vr.height); }
        if (front) foot = { pts: xs.map((x, i) => [x, ys[i]]), dist: new THREE.Vector3(b.max.x, (b.min.y + b.max.y) / 2, 0).applyMatrix4(su.group.matrixWorld).distanceTo(cam) };
      }
      return { sel, cards, hosts, blocked, meshBlocked, foot, cam: cam.toArray().map(v => +v.toFixed(4)) };
    });
    // is a point inside the convex hull of pts? (inside every edge of the hull, built by gift wrapping)
    const hullOf = pts => { const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const half = l => { const h = []; for (const q of l) { while (h.length >= 2 && cr(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); } h.pop(); return h; }; return [...half(p), ...half([...p].reverse())]; };
    const inHull = (h, x, y) => h.every((p, i) => { const q = h[(i + 1) % h.length]; return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]) > 0.5; });
    // a card of another rack, farther than the selected rack, drawn over its outline (a 5 × 5 grid of points in the card)
    const behindOver = (c, foot) => { if (!foot || c.dist <= foot.dist) return false; const h = hullOf(foot.pts); const [l, t, r, b] = c.rect;
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) if (inHull(h, l + 1 + (r - l - 2) * i / 4, t + 1 + (b - t - 2) * j / 4)) return true; return false; };
    const overlaps = cards => { const r = cards.filter(c => c.shown).map(c => c.rect); let bad = 0; for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (Math.min(r[i][2], r[j][2]) - Math.max(r[i][0], r[j][0]) > 2 && Math.min(r[i][3], r[j][3]) - Math.max(r[i][1], r[j][1]) > 2) bad++; return bad; };
    const checkSelected = (s, label) => {
      const mine = s.cards.filter(c => c.setup === s.sel), others = s.cards.filter(c => c.setup !== s.sel && c.shown);
      assert.equal(mine.length, 4, label + ': 4 shelves');
      assert.ok(mine.every(c => c.shown && (c.lod === 'full' || c.lod === 'line')), `${label}: every selected-rack card shown with full detail: ${JSON.stringify(mine.map(c => [c.id, c.lod, c.why]))}`);
      assert.equal(new Set(mine.map(c => c.lod)).size, 1, label + ': one level of detail for the selected rack');
      for (const c of mine) for (const h of s.hosts[c.id] || []) assert.ok(c.text.includes(h), `${label}: ${c.id} card names the server's IP / host ${h}: ${c.text}`);
      if (others.some(c => c.lod === 'full')) assert.ok(mine.every(c => c.lod === 'full'), `${label}: neighbours show full cards, so the selected rack does too`);
      assert.ok(others.every(c => c.lod !== 'line'), label + ': only the selected rack uses the detailed one-line card');
      assert.equal(overlaps(s.cards), 0, label + ': shown cards overlap');
      assert.deepEqual(s.blocked, [], label + ': cards shown through another rack');
      assert.deepEqual(s.meshBlocked, [], label + ': cards shown through another rack\'s geometry');
      if (s.foot) { const behind = others.filter(c => behindOver(c, s.foot)); assert.deepEqual(behind.map(c => c.id), [], label + ': cards of racks behind the selected one drawn over it'); }
    };
    const runs = [];
    for (let run = 0; run < 2; run++) {
      const res = {};
      for (let n = 1; n <= 7; n++) {
        const id = `SETUP-00${n}`;
        await page.locator('#vReset').click(); await settle();
        await page.locator(`#rackBar [data-jump="${id}"]`).click(); await settle();
        const s = await snap(); assert.equal(s.sel, id, 'rack selected from the rack bar');
        checkSelected(s, `Rack-0${n} run ${run + 1}`);
        res[id] = { cam: s.cam, cards: s.cards.map(c => [c.id, c.shown, c.lod, c.rect && c.rect.join(',')].join(' ')) };
        if (run === 0) await shot(page, `select-${id}.png`);
      }
      runs.push(res);
    }
    for (const id of Object.keys(runs[0])) {
      if (JSON.stringify(runs[0][id].cam) !== JSON.stringify(runs[1][id].cam)) continue;   // the flight ended elsewhere: not comparable
      assert.deepEqual(runs[1][id].cards, runs[0][id].cards, `${id}: the same camera gives the same cards on a second run`);
    }
    pass('selected rack: Reset + rack chip for Rack-01…07 (twice): all 4 cards shown with full detail (IP / host included), never less detailed than a neighbour, no overlap, nothing through another rack, nothing from behind over it, identical on the second run');

    // the same camera position twice, set exactly (no flight): identical cards; also with a different selection history
    const fixedCam = async (sel, prev) => {
      if (prev) { await page.evaluate(p => __twin.select(p, { keepCamera: true }), prev); await settle(); }
      await page.evaluate(sel => { const t = __twin, S = t.S; t.select(sel, { keepCamera: true }); S.tween = null; t.controls.cancel(); const rec = S.recs.get(sel);
        const c = rec.group.localToWorld(new THREE.Vector3(0, 1.5, 0)); const p = rec.group.localToWorld(new THREE.Vector3(2.3, 1.6, 0.3));
        S.tween = { ms: 0, t0: performance.now(), p0: p.clone(), p1: p.clone(), t0v: c.clone(), t1v: c.clone() }; }, sel);
      await settle(); return snap();
    };
    for (const id of ['SETUP-003', 'SETUP-005']) {
      const a = await fixedCam(id, null), b = await fixedCam(id, id === 'SETUP-003' ? 'SETUP-002' : 'SETUP-006');
      checkSelected(a, id + ' fixed camera');
      assert.deepEqual(b.cards.map(c => [c.id, c.shown, c.lod, c.rect && c.rect.join(',')]), a.cards.map(c => [c.id, c.shown, c.lod, c.rect && c.rect.join(',')]), id + ': same camera, same cards');
    }
    pass('determinism: the same camera position (set exactly) gives the same cards after a different selection history');

    // ── 3. rotate around a focused rack: cards of other racks never float over it, its own front cards stay
    for (const id of ['SETUP-003', 'SETUP-005']) {
      await page.locator('#vReset').click(); await settle();
      await page.locator(`#rackBar [data-jump="${id}"]`).click(); await settle();
      const vb = await page.locator('#c').boundingBox(); const mx = vb.x + vb.width * .5, my = vb.y + vb.height * .5;
      await page.mouse.move(mx, my); await page.mouse.down({ button: 'right' }); await page.mouse.move(mx + 200, my, { steps: 12 }); await page.mouse.up({ button: 'right' }); await settle();
      const s = await snap();
      assert.deepEqual(s.blocked, [], id + ' rotated: cards shown through another rack');
      assert.deepEqual(s.meshBlocked, [], id + ' rotated: cards shown through another rack\'s geometry');
      if (s.foot) { const behind = s.cards.filter(c => c.setup !== s.sel && c.shown && behindOver(c, s.foot)); assert.deepEqual(behind.map(c => c.id), [], id + ' rotated: cards from behind over the selected rack'); }
      const mine = s.cards.filter(c => c.setup === s.sel); const facing = await page.evaluate(sel => [...__twin.S.recs.values()].filter(r => r.cat === 'shelf' && r.setup === sel).map(r => [r.id, __twin.camera.position.clone().sub(r.cardAnchor).normalize().dot(r.front)]), s.sel);
      for (const [sid, f] of facing) if (f > 0.05) { const c = mine.find(x => x.id === sid); assert.ok(c.shown && c.lod !== 'compact', `${id} rotated: own card ${sid} (facing ${f.toFixed(2)}) shown in detail: ${c.lod} ${c.why}`); }
      assert.equal(overlaps(s.cards), 0, id + ' rotated: cards overlap');
      await shot(page, `rotated-${id}.png`);
    }
    pass('rotating around Focus Rack-03 / Rack-05: no card through another rack or from behind over the focused rack; its own front cards shown');

    // a sight line that grazes another rack's corner post (Rack-04's cards seen past Rack-07's front post, with Rack-05
    // selected and with nothing selected) hides the card; more oblique views around the rows are checked the same way
    const setCam = async (sel, cam, tgt) => {
      await page.evaluate(([sel, cam, tgt]) => { const t = __twin, S = t.S; if (sel) t.select(sel, { keepCamera: true }); else t.closeDetail(); S.tween = null; t.controls.cancel();
        const p = new THREE.Vector3(...cam), q = new THREE.Vector3(...tgt); S.tween = { ms: 0, t0: performance.now(), p0: p.clone(), p1: p.clone(), t0v: q.clone(), t1v: q.clone() }; }, [sel, cam, tgt]);
      await settle(); return snap();
    };
    const grazes = [[-4.498, 1.442, 1.71], [-4.606, 1.442, 1.777], [-4.3, 1.5, 1.6], [-4.8, 1.3, 1.9]];
    let shownOther = 0;
    for (const sel of ['SETUP-005', null]) for (const cam of grazes) {
      const s = await setCam(sel, cam, [-2.494, 1.163, 5.107]);
      assert.deepEqual(s.meshBlocked, [], `graze ${sel} ${cam}: cards shown through another rack's geometry`);
      assert.deepEqual(s.blocked, [], `graze ${sel} ${cam}: cards shown through another rack`);
      if (sel) assert.ok(s.cards.filter(c => c.setup === sel).every(c => c.shown), `graze ${sel} ${cam}: the selected rack keeps its cards`);
      shownOther += s.cards.filter(c => c.shown && c.setup !== sel).length;
    }
    await shot(page, 'graze-SETUP-005.png');
    // and a sweep of views around every rack (45° steps, 3 m out, eye height): nothing through another rack's geometry
    let sweep = 0;
    for (const su of await page.evaluate(() => __twin.S.data.setups.map(s => s.id))) for (let k = 0; k < 8; k++) {
      const v = await page.evaluate(([id, k]) => { const g = __twin.S.recs.get(id).group; const c = g.localToWorld(new THREE.Vector3(0, 1.2, 0)); const a = k * Math.PI / 4;
        return { cam: [c.x + 3 * Math.cos(a), 1.5, c.z + 3 * Math.sin(a)], tgt: c.toArray() }; }, [su, k]);
      const s = await setCam(null, v.cam, v.tgt); sweep += s.cards.filter(c => c.shown).length;
      assert.deepEqual(s.meshBlocked, [], `view ${k * 45}° around ${su}: cards shown through another rack's geometry`);
    }
    assert.ok(sweep > 40, 'the sweep shows cards at all: ' + sweep);
    pass(`occlusion: a sight line grazing another rack's corner post hides the card (Rack-04 past Rack-07, ${shownOther} other cards still shown); 56 views around the racks, ${sweep} cards, none through another rack's posts, shelves or equipment`);

    // ── 6. legend: server body power colours, apart from health
    await page.locator('#vReset').click(); await settle(); await shot(page, 'legend.png');
    const legend = await page.evaluate(() => ({ text: document.querySelector('#legend').textContent.replace(/\s+/g, ' '), shown: document.querySelector('#legend').getBoundingClientRect().width > 0, title: document.querySelector('#legend').title, towers: [...document.querySelectorAll('#legend .sw.tower')].map(e => getComputedStyle(e).backgroundColor) }));
    assert.ok(legend.shown, 'legend shown'); assert.match(legend.text, /Health/); assert.match(legend.text, /Server body = power/); assert.match(legend.text, /Power ON/); assert.match(legend.text, /Power OFF/); assert.match(legend.text, /Power unknown/);
    assert.deepEqual(legend.towers, ['rgb(34, 197, 94)', 'rgb(220, 38, 38)', 'rgb(107, 114, 128)'], 'tower swatches green / red / grey');
    assert.match(legend.title, /green ON, red OFF, grey unknown/); assert.match(legend.title, /separate from ping health/);
    pass('legend: "Server body = power" ON green / OFF red / Unknown grey, separate from Health');
    // narrower views: the power group keeps a title and words on screen (health may drop to swatches with tooltips)
    const seen = () => page.evaluate(() => {
      const lg = document.querySelector('#legend'); const vis = e => getComputedStyle(e).display !== 'none';
      const after = e => getComputedStyle(e, '::after').content.replace(/^"|"$/g, '').replace(/^none$/, '');
      const pt = lg.querySelector('.lg-pt'); const ptl = pt.querySelector('.pt-l');
      const r = lg.getBoundingClientRect(); const z = document.querySelector('.zoombar').getBoundingClientRect();
      const clear = z.width === 0 || r.right <= z.left || r.left >= z.right || r.bottom <= z.top || r.top >= z.bottom;
      return { shown: vis(lg) && r.width > 0, fits: lg.scrollWidth <= lg.clientWidth + 1 && r.right <= innerWidth && r.left >= 0 && clear, cls: lg.className,
        title: vis(pt) ? (vis(ptl) ? ptl.textContent : after(pt)) : '',
        power: [...lg.querySelectorAll('.li.pw')].map(li => vis(li) ? (vis(li.querySelector('.li-t')) ? li.querySelector('.li-t').textContent : after(li)) : '') };
    });
    const widths = [];
    for (const [w, h, sel] of [[1920, 1080, null], [1440, 900, 'SETUP-003'], [1024, 768, null], [1024, 768, 'SETUP-003'], [390, 844, null]]) {
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300);
      if (sel) { await page.evaluate(sel => __twin.select(sel), sel); } else await page.evaluate(() => __twin.closeDetail());
      await page.waitForTimeout(400); await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await page.waitForTimeout(200);
      const s = await seen(); const tag = `${w}×${h}${sel ? ' ' + sel : ''}`;
      assert.ok(s.shown && s.fits, `${tag}: legend shown on one row, clear of the zoom bar: ${JSON.stringify(s)}`);
      assert.match(s.title, /^Server body/, `${tag}: the power group keeps its title: ${JSON.stringify(s)}`);
      assert.ok(['Power ON|Power OFF|Power unknown', 'ON|OFF|?'].includes(s.power.join('|')), `${tag}: power words on screen: ${JSON.stringify(s)}`);
      await shot(page, `legend-${w}${sel ? '-sel' : ''}.png`); widths.push(`${tag}: ${s.title} ${s.power.join(' / ')}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await page.evaluate(() => __twin.closeDetail());
    pass('legend at narrower views keeps the server body power key in words: ' + widths.join('; '));

    // the SN-means-switch rule in 3D follows the site's rule: servers, board OPNs and other vendors' units are not switches
    const kinds = await page.evaluate(() => Object.fromEntries(Object.entries({
      sn: { name: 'Unit', serial_number: 'MT2629X00QA1' }, dgx: { name: 'Unit', model: 'DGX H100', serial_number: 'X1' }, node: { name: 'GPU node 3', serial_number: 'X2' },
      opn: { name: 'Unit', part_number: '900-9X766-003N-SQ0', serial_number: 'X3' }, cisco: { name: 'Unit', model: 'Cisco Nexus 9300', serial_number: 'X4' },
      ciscoSw: { name: 'Unit', model: 'Cisco Nexus 9300 switch', serial_number: 'X5' }, code: { name: 'MT2629X00QA2', barcode: 'MT2629X00QA2' },
      // identified as something else by its name (the Racks page keeps these Other): never a switch
      ups: { name: 'UPS box', serial_number: 'X9' }, panel: { name: 'Patch panel', barcode: 'PP-1' }, h100: { name: 'H100 tray', serial_number: 'X10' },
      opnSerial: { name: 'Unit', serial_number: '900-9X766-003N-SQ0' }, opnCode: { name: '900-9X766-003N-SQ0', barcode: '900-9X766-003N-SQ0' },
      byId: { name: 'ci-77', dcimId: 'ci-77', serial_number: 'MT77' }, hpe: { name: 'Unit', model: 'HPE SN2010M', serial_number: 'X11' }, ups2: { name: 'Unit', model: 'UPS 3000VA', serial_number: 'X12' },
    }).map(([k, v]) => [k, __twin.unitInfo({ type: 'equip-other', ...v }).kind])));
    assert.deepEqual(kinds, { sn: 'switch', dgx: 'other', node: 'other', opn: 'other', cisco: 'other', ciscoSw: 'switch', code: 'switch',
      ups: 'other', panel: 'other', h100: 'other', opnSerial: 'other', opnCode: 'other', byId: 'switch', hpe: 'switch', ups2: 'other' }, '3D unit kinds');
    pass('3D: a generic unit with an SN or barcode is a switch; DGX, GPU node, board OPN (also as the serial), Cisco (not saying switch) and units named as something else (UPS box, Patch panel) are not');

    assert.deepEqual(writes, [], 'no writes'); assert.deepEqual(errors, [], 'page errors');
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.stack || String(e), checks, errors, writes }, null, 2));
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
