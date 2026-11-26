// Lab Twin navigation that never runs away — isolated fixture only: DCIM_TEST_ACCOUNTS=1 tests/browser/preview-server.py.
// Checks at 1440×900 (Operator):
//  1. button zoom / rotate keep the rack clearance: Rack-05 Focus + 20 × "+" (#zIn) and Focus + 12 × rotate left
//     (#rotL), sampled every frame: rackClearance(camera) >= min(0.4 m, the clearance after Focus); a step a rack stops
//     says so ("A rack is in the way"); quick presses add up (6 × rotate left = 90°, 2 × "+" = 0.49 × the distance),
//     a held key's repeats do not; North up (compass) reaches north and never ends nearer a rack than allowed;
//  2. the Pan / Rotate switch: with #mRotate a left drag changes the azimuth and leaves controls.target (±1 cm); with
//     #mPan the reverse; aria-pressed, remembered in localStorage, Move mode uses Pan without storing it and restores
//     the stored choice afterwards;
//  3. a canvas click on an object at ~90 % of the view width: its projected box stays inside the canvas after the
//     drawer opens (keepInView), clear of the camera buttons, with the drawer closed and with a server already selected;
//     a click on an object low in the view (target on the floor) ends with its box inside frameSafe() vertically, the
//     target still on the floor and the rack clearance kept (also a tap on a phone with the sheet opening);
//  4. hover tip: hovering OPT11 shows "OPT11 · ON/OFF/? · Rack-01 › Shelf n"; it follows live data while the pointer
//     rests (a reading that turns stale shows "?"); a fast move off an object leaves no stale tip / hover; hidden on
//     pointer down; never on touch;
//  5. zoom-out limit = 1.6 × the overview distance; the camera cluster has accessible names, sits clear of the legend,
//     the zoom bar, the drawer, the environment panel and the move banner (1440 / 1024 / 1920, 1366 × 657, 1280 × 640,
//     844 × 390, Move mode at 740 / 800 px); phones (390 × 844, 375 × 667, 360 × 640, 360 × 560) keep it behind a
//     "Rotate" button: opened, every button is on screen and tappable, Escape closes it, Move mode hides it.
// Read-only: every non-GET request except the sign-in is aborted and reported; changes live only in the page.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const origin = process.env.DCIM_PREVIEW_URL || 'http://127.0.0.1:8770';
const shots = process.env.DCIM_QA_SHOTS || 'C:/t/twin-nav';

(async () => {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the isolated local fixture only');
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [], errors = [], writes = [];
  const pass = m => { checks.push(m); if (process.env.DCIM_QA_VERBOSE) console.error('ok: ' + m); };
  const open = async (opts) => {
    const ctx = await browser.newContext(opts);
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
    await page.waitForTimeout(1000);
    return { ctx, page };
  };
  // software WebGL can take a few hundred ms per frame: wait for frames drawn after the camera stopped
  const settle = async page => {
    await page.waitForFunction(() => !__twin.S.tween && !__twin.controls.moving, null, { timeout: 20000 });
    await page.evaluate(() => { window.__f0 = __twin.renderer.info.render.frame; });
    await page.waitForFunction(() => __twin.renderer.info.render.frame >= window.__f0 + 3, null, { timeout: 20000 });
  };
  const shot = (page, name) => page.screenshot({ path: path.join(shots, name) });
  try {
    const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } });

    // ── 5a. the camera cluster: names, titles, pressed state, placement
    const ui = await page.evaluate(() => {
      const q = s => document.querySelector(s); const r = el => el.getBoundingClientRect();
      const btns = ['#mPan', '#mRotate', '#rotL', '#rotR', '#tiltU', '#tiltD'].map(s => ({ id: s, name: q(s).getAttribute('aria-label'), title: q(s).title, shown: r(q(s)).width > 0 }));
      return { btns, pressed: [q('#mPan').getAttribute('aria-pressed'), q('#mRotate').getAttribute('aria-pressed')], more: getComputedStyle(q('#navMore')).display, mode: __twin.controls.leftAction };
    });
    assert.ok(ui.btns.every(b => b.name && b.title && b.shown), 'every camera button is shown with a name and a title: ' + JSON.stringify(ui.btns));
    assert.deepEqual(ui.pressed, ['true', 'false'], 'Pan is the default'); assert.equal(ui.mode, 'pan'); assert.equal(ui.more, 'none', 'no "Rotate" collapse button on a desktop');
    const clearOf = () => page.evaluate(() => {
      const r = el => el ? el.getBoundingClientRect() : null; const hit = (a, b) => a && b && a.width > 0 && b.width > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const pad = r(document.querySelector('#navPad')), vp = r(document.querySelector('#viewport'));
      const others = { legend: '#legend', zoombar: '.zoombar', detail: '#detail', crumb: '#crumb', attnDock: '#attnDock', envPanel: '#envPanel', moveBanner: '#moveBanner', saveBar: '#saveBar' };
      return { shown: pad.width > 0, inside: pad.left >= vp.left && pad.right <= vp.right && pad.top >= vp.top && pad.bottom <= vp.bottom, over: Object.entries(others).filter(([, s]) => hit(pad, r(document.querySelector(s)))).map(([k]) => k) };
    });
    for (const [w, h, sel] of [[1440, 900, null], [1440, 900, 'SETUP-003'], [1024, 768, 'SETUP-003'], [1920, 1080, null]]) {
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(250);
      if (sel) await page.evaluate(s => __twin.select(s, { keepCamera: true }), sel); else await page.evaluate(() => __twin.closeDetail());
      await page.waitForTimeout(250); const c = await clearOf();
      assert.ok(c.inside && !c.over.length, `${w}×${h}${sel ? ' ' + sel : ''}: camera cluster inside the 3D view, clear of ${JSON.stringify(c.over)}`);
    }
    // the environment panel at common laptop sizes (page-only content: the fixture has no room sensors; the 1 s ticker
    // places the cluster), a landscape phone with a selection (legend row above the zoom bar), Move mode in narrow
    // windows (the move banner)
    const fakeEnv = on => page.evaluate(on => {
      const env = document.querySelector('#envPanel'); if (!on) { env.className = 'envpanel hidden'; env.innerHTML = ''; return; }
      env.className = 'envpanel'; env.innerHTML = '<div class="e-title">Lab environment <small>avg of 6 sensors</small></div><div class="e-row"><b>22.4°C</b><small>20.1–24.0</small></div><div class="e-row"><b>41%</b><small>humidity</small></div><div class="e-row"><b>no leaks</b></div><div class="e-row e-foot"><small>3.21 kW total</small></div>';
    }, on);
    const layouts = [];
    for (const [w, h, st] of [[1366, 657, 'env'], [1280, 640, 'env'], [844, 390, 'SETUP-003'], [740, 560, 'move'], [800, 500, 'move'], [1440, 900, 'move']]) {
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(250);
      await page.evaluate(st => { const t = __twin; t.cancelMove(); if (t.S.editMode) t.toggleEdit(false); t.closeDetail(); if (st === 'move') { t.toggleEdit(true); t.select('LIVE-opt11', { keepCamera: true }); t.startMove('LIVE-opt11'); } else if (st !== 'env') t.select(st, { keepCamera: true }); }, st);
      await fakeEnv(st === 'env'); await page.waitForTimeout(1300); const c = await clearOf();
      assert.ok(c.shown && c.inside && !c.over.length, `${w}×${h} ${st}: camera cluster shown inside the 3D view, clear of ${JSON.stringify(c.over)}`);
      layouts.push(`${w}×${h} ${st}`);
    }
    await page.evaluate(() => { const t = __twin; t.cancelMove(); if (t.S.editMode) t.toggleEdit(false); }); await fakeEnv(false);
    await page.setViewportSize({ width: 1440, height: 900 }); await page.evaluate(() => __twin.closeDetail()); await page.waitForTimeout(300);
    pass('camera cluster: Pan / Rotate / rotate L R / tilt U D with names and titles, Pan pressed by default, clear of the legend, zoom bar and drawer at 1440 / 1024 / 1920, and of every overlay at ' + layouts.join(', '));

    // ── 5b. zoom-out limit
    await page.locator('#vReset').click(); await settle(page);
    const lim = await page.evaluate(() => ({ max: __twin.controls.maxDistance, d: __twin.controls.getDistance() }));
    assert.ok(lim.max <= 1.6 * lim.d + 0.05 && lim.max >= 1.4 * lim.d, `maxDistance ${lim.max.toFixed(2)} = 1.6 × overview ${lim.d.toFixed(2)}`);
    for (let i = 0; i < 6; i++) { await page.locator('#zOut').click(); await page.waitForTimeout(60); }
    await settle(page); const out = await page.evaluate(() => __twin.controls.getDistance());
    assert.ok(out <= lim.max + 1e-3 && out > lim.d + 0.5, `zoom out stops at the limit: ${out.toFixed(2)} <= ${lim.max.toFixed(2)}`);
    pass(`zoom-out limit: maxDistance ${lim.max.toFixed(2)} m = 1.6 × overview ${lim.d.toFixed(2)} m; 6 × "−" stops at ${out.toFixed(2)} m`);

    // ── 1. button zoom / rotate keep the rack clearance (every frame)
    await page.evaluate(() => {
      const t = __twin; window.__navRec = { on: false, min: Infinity, frames: 0 };
      (function loop() { const R = window.__navRec; if (R.on) { R.frames++; R.min = Math.min(R.min, t.rackClearance(t.camera.position)); } requestAnimationFrame(loop); })();
    });
    const focus05 = async () => {
      await page.locator('#vReset').click(); await settle(page);
      await page.locator('#rackBar [data-jump="SETUP-005"]').click(); await settle(page); await page.locator('#vFocus').click(); await settle(page);
      return page.evaluate(() => ({ c: __twin.rackClearance(__twin.camera.position), d: __twin.controls.getDistance(), az: __twin.controls.getAzimuthalAngle() }));
    };
    await page.evaluate(() => { window.__toasts = []; new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => window.__toasts.push(n.textContent)))).observe(document.querySelector('#toasts'), { childList: true }); });
    const runs = [];
    for (const [btn, n] of [['#zIn', 20], ['#rotL', 12]]) {
      await page.evaluate(() => { window.__toasts.length = 0; });
      const s = await focus05();
      await page.evaluate(() => Object.assign(window.__navRec, { on: true, min: Infinity, frames: 0 }));
      for (let i = 0; i < n; i++) { await page.locator(btn).click(); await page.waitForTimeout(90); }
      await settle(page);
      const r = await page.evaluate(() => { const R = window.__navRec; R.on = false; return { min: R.min, frames: R.frames, d: __twin.controls.getDistance(), az: __twin.controls.getAzimuthalAngle(), now: __twin.rackClearance(__twin.camera.position) }; });
      const need = Math.min(0.4, s.c) - 0.002;
      assert.ok(r.frames > 5, `${btn}: frames sampled (${r.frames})`);
      assert.ok(r.min >= need, `${btn} × ${n} after Rack-05 Focus: the camera came within ${r.min.toFixed(3)} m of a rack (start ${s.c.toFixed(3)} m)`);
      if (btn === '#zIn') assert.ok(r.d < s.d - 0.3, `"+" still zooms in (${s.d.toFixed(2)} -> ${r.d.toFixed(2)})`);
      else {
        assert.ok(Math.abs(Math.atan2(Math.sin(r.az - s.az), Math.cos(r.az - s.az))) > 0.1, `rotate left still turns the view (${s.az.toFixed(2)} -> ${r.az.toFixed(2)})`);
        const hint = await page.evaluate(() => window.__toasts.slice());
        assert.ok(hint.some(t => /A rack is in the way/.test(t)), 'a rotate step a rack stops says why: ' + JSON.stringify(hint));
      }
      runs.push(`${btn} × ${n}: start ${s.c.toFixed(3)} m, min ${r.min.toFixed(3)} m over ${r.frames} frames`);
    }
    // quick presses add up; a held key's repeats do not (each starts from the current view)
    await page.locator('#vReset').click(); await settle(page);
    const azd = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
    const a0 = await page.evaluate(() => __twin.controls.getAzimuthalAngle());
    await page.evaluate(() => { for (let i = 0; i < 6; i++) document.querySelector('#rotL').click(); }); await settle(page);
    const a1 = await page.evaluate(() => __twin.controls.getAzimuthalAngle());
    assert.ok(Math.abs(azd(a0, a1) - Math.PI / 2) < 0.02, `6 quick presses of rotate left turn 90°: ${azd(a0, a1).toFixed(4)} rad`);
    await page.evaluate(() => { document.body.focus(); for (let i = 0; i < 6; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, repeat: true, bubbles: true })); }); await settle(page);
    const a2 = await page.evaluate(() => __twin.controls.getAzimuthalAngle());
    assert.ok(Math.abs(azd(a1, a2) - Math.PI / 12) < 0.02, `6 held-key repeats of Shift + ← turn one step: ${azd(a1, a2).toFixed(4)} rad`);
    const z0 = await page.evaluate(() => __twin.controls.getDistance());
    await page.evaluate(() => { for (let i = 0; i < 2; i++) document.querySelector('#zIn').click(); }); await settle(page);
    const z1 = await page.evaluate(() => __twin.controls.getDistance());
    assert.ok(Math.abs(z1 / z0 - 0.49) < 0.01, `2 quick presses of "+" zoom to 0.49 × the distance: ${(z1 / z0).toFixed(3)}`);
    runs.push(`6 × rotate left = ${azd(a0, a1).toFixed(3)} rad, 6 held Shift + ← = ${azd(a1, a2).toFixed(3)} rad, 2 × "+" = ${(z1 / z0).toFixed(3)} × distance`);
    // North up reaches north and never ends nearer a rack than allowed (its path is a recovery like Fit / Focus)
    for (const id of ['SETUP-004', 'SETUP-005', 'STORAGE-01']) {
      await page.evaluate(() => __twin.closeDetail()); await page.locator('#vReset').click(); await settle(page);
      await page.evaluate(id => __twin.select(id, { fly: true }), id); await settle(page); await page.locator('#vFocus').click(); await settle(page);
      await page.evaluate(() => __twin.orbitTo(__twin.controls.getAzimuthalAngle() + 2.2, null, 0, false)); await settle(page);
      const c0 = await page.evaluate(() => __twin.rackClearance(__twin.camera.position));
      await page.locator('#vCompass').click(); await settle(page);
      const n1 = await page.evaluate(() => ({ c: __twin.rackClearance(__twin.camera.position), h: document.querySelector('#vCompass').dataset.heading }));
      assert.equal(n1.h, '0', `${id}: north up`); assert.ok(n1.c >= Math.min(0.4, c0) - 0.002, `${id}: north up ends ${n1.c.toFixed(3)} m from a rack (before ${c0.toFixed(3)} m)`);
      runs.push(`north up after ${id} Focus ends ${n1.c.toFixed(3)} m clear`);
    }
    await page.evaluate(() => __twin.closeDetail());
    await shot(page, 'nav-buttons.png');
    // tilt buttons turn the polar angle like Shift + arrows (from the overview, away from the racks)
    await page.locator('#vReset').click(); await settle(page);
    const tilt = await page.evaluate(async () => { const t = __twin; const p0 = t.controls.getPolarAngle(); document.querySelector('#tiltD').click(); await new Promise(r => setTimeout(r, 600)); return [p0, t.controls.getPolarAngle()]; });
    assert.ok(tilt[1] < tilt[0] - 0.05, 'tilt down looks more from above: ' + tilt);
    pass('rack clearance on buttons: ' + runs.join('; ') + `; tilt down ${tilt.map(v => v.toFixed(2)).join(' -> ')} rad`);

    // ── 2. Pan / Rotate switch
    const vb = await page.locator('#c').boundingBox();
    const snap = () => page.evaluate(() => ({ t: __twin.controls.target.toArray(), az: __twin.controls.getAzimuthalAngle(), polar: __twin.controls.getPolarAngle() }));
    const ldrag = async (dx, dy) => { const x = vb.x + vb.width * 0.5, y = vb.y + vb.height * 0.55; await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.waitForTimeout(120); await page.mouse.up(); await settle(page); };
    const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i])); const dAz = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    await page.locator('#vReset').click(); await settle(page);
    await page.locator('#mRotate').click();
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#mPan').getAttribute('aria-pressed'), document.querySelector('#mRotate').getAttribute('aria-pressed'), __twin.controls.leftAction, localStorage.getItem('twin.leftAction')]), ['false', 'true', 'rotate', '"rotate"']);
    let a = await snap(); await ldrag(160, 0); let b = await snap();
    assert.ok(dAz(a.az, b.az) > 0.1, `Rotate: a left drag turns the view (azimuth ${a.az.toFixed(3)} -> ${b.az.toFixed(3)})`);
    assert.ok(dist(a.t, b.t) <= 0.01, `Rotate: the target stays (moved ${dist(a.t, b.t).toFixed(4)} m)`);
    const rot = { az: dAz(a.az, b.az), t: dist(a.t, b.t) };
    await page.locator('#mPan').click();
    a = await snap(); await ldrag(120, -60); b = await snap();
    assert.ok(dist(a.t, b.t) > 0.05, `Pan: a left drag moves the target (${dist(a.t, b.t).toFixed(3)} m)`);
    assert.ok(dAz(a.az, b.az) < 1e-3 && Math.abs(a.polar - b.polar) < 1e-3, `Pan: no turn, no tilt (azimuth ${dAz(a.az, b.az).toFixed(5)})`);
    const pan = { az: dAz(a.az, b.az), t: dist(a.t, b.t) };
    // remembered; Move mode returns to Pan
    await page.locator('#mRotate').click();
    const mv = await page.evaluate(() => { const t = __twin; t.toggleEdit(true); const id = [...t.S.recs.values()].find(r => r.cat === 'item' && r.item?.type === 'opt' && r.group).id; t.select(id, { keepCamera: true }); t.startMove(id);
      const during = [t.S.moveItem === id, t.controls.leftAction, document.querySelector('#mPan').getAttribute('aria-pressed'), localStorage.getItem('twin.leftAction')]; t.cancelMove(); t.closeDetail(); t.toggleEdit(false); return { during, after: [t.controls.leftAction, document.querySelector('#mRotate').getAttribute('aria-pressed')], stored: localStorage.getItem('twin.leftAction') }; });
    assert.deepEqual(mv, { during: [true, 'pan', 'true', '"rotate"'], after: ['rotate', 'true'], stored: '"rotate"' }, 'Move mode uses Pan without storing it, then restores the stored Rotate');
    await page.locator('#mPan').click();
    pass(`Pan / Rotate switch: Rotate drag turns ${rot.az.toFixed(3)} rad with the target moved ${(rot.t * 100).toFixed(2)} cm; Pan drag moves the target ${pan.t.toFixed(3)} m with ${pan.az.toFixed(5)} rad turn; stored in localStorage; Move mode uses Pan (not stored) and restores the stored choice`);

    // ── 3. a canvas click near the right edge keeps the object on screen after the drawer opens
    // view object `id` from 3.2 m (current direction) with its centre at NDC x = nx: camera and target translated
    // together, applied through a zero-length app tween (no collision sweep for the jump); then is a pick there a hit?
    // ny (optional): also put the centre at NDC y = ny, with the target slid along the line of sight to the floor (as
    // the app keeps it after a gesture)
    const placeAt = async (id, nx, ny = null, pg = page) => {
      const clear = await pg.evaluate(([id, nx, ny]) => {
        const t = __twin; const rec = t.S.recs.get(id); const cam = t.camera.clone(); const box = new THREE.Box3(); rec.meshes.forEach(m => box.expandByObject(m));
        const c = box.getCenter(new THREE.Vector3()); let tgt = c.clone(); cam.position.copy(c).add(t.camera.position.clone().sub(t.controls.target).setLength(3.2)); cam.lookAt(tgt);
        for (let i = 0; i < 5; i++) {
          cam.updateMatrixWorld(); const v = c.clone().project(cam); const depth = -c.clone().applyMatrix4(cam.matrixWorldInverse).z; const th = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
          const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
          const k = (v.x - nx) * depth * th * cam.aspect, ky = ny == null ? 0 : (v.y - ny) * depth * th;
          cam.position.addScaledVector(right, k).addScaledVector(up, ky); tgt.addScaledVector(right, k).addScaledVector(up, ky); cam.lookAt(tgt);
        }
        if (ny != null) { const d = tgt.clone().sub(cam.position).normalize(); tgt = cam.position.clone().addScaledVector(d, -cam.position.y / d.y); tgt.y = 0; }
        t.S.tween = { t0: performance.now(), ms: 0, p0: t.camera.position.clone(), p1: cam.position.clone(), t0v: t.controls.target.clone(), t1v: tgt.clone() };
        return t.rackClearance(cam.position);
      }, [id, nx, ny]);
      await settle(pg);
      const at = await pg.evaluate(id => {
        const t = __twin; const rec = t.S.recs.get(id); const box = new THREE.Box3(); rec.meshes.forEach(m => box.expandByObject(m)); t.camera.updateMatrixWorld();
        const v = box.getCenter(new THREE.Vector3()).project(t.camera); const r = document.querySelector('#c').getBoundingClientRect();
        const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height; const hit = t.pickAt({ clientX: x, clientY: y });
        return { x, y, nx: v.x, ny: v.y, hits: hit?.object.userData.id === id && document.elementFromPoint(x, y)?.id === 'c' };
      }, id);
      return { ...at, clear };
    };
    // the box's NDC y range against frameSafe(), the target height
    const vertical = (id, pg = page) => pg.evaluate(id => {
      const t = __twin; const rec = t.S.recs.get(id); const box = new THREE.Box3(); rec.meshes.forEach(m => box.expandByObject(m)); t.camera.updateMatrixWorld();
      let y0 = Infinity, y1 = -Infinity; for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) { const v = new THREE.Vector3(x, y, z).project(t.camera); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      const s = t.frameSafe(); return { y0, y1, b: s.b, t: s.t, inside: y0 >= s.b - 0.01 && y1 <= s.t + 0.01, targetY: t.controls.target.y };
    }, id);
    const boxOnScreen = id => page.evaluate(id => {
      const t = __twin; const rec = t.S.recs.get(id); const box = new THREE.Box3(); rec.meshes.forEach(m => box.expandByObject(m)); const r = document.querySelector('#c').getBoundingClientRect();
      t.camera.updateMatrixWorld(); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) { const v = new THREE.Vector3(x, y, z).project(t.camera); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      const px = { l: r.left + (x0 + 1) / 2 * r.width, r: r.left + (x1 + 1) / 2 * r.width, t: r.top + (1 - y1) / 2 * r.height, b: r.top + (1 - y0) / 2 * r.height };
      const n = document.querySelector('#navPadBody').getBoundingClientRect(); const underPad = n.width > 0 && px.l < n.right && n.left < px.r && px.t < n.bottom && n.top < px.b;
      return { px, canvas: { l: r.left, r: r.right, t: r.top, b: r.bottom }, inside: px.l >= r.left && px.r <= r.right && px.t >= r.top && px.b <= r.bottom && !underPad, underPad, sel: t.S.selected };
    }, id);
    const servers = await page.evaluate(() => [...__twin.S.recs.values()].filter(r => r.cat === 'item' && r.item?.type === 'opt' && r.group && r.meshes.length && r.setup).map(r => r.id));
    const clickRight = async (label, skip) => {
      for (const id of servers) {
        if (id === skip) continue;
        await page.locator('#vReset').click(); await settle(page);
        if (skip) await page.evaluate(s => __twin.select(s, { keepCamera: true }), skip); else await page.evaluate(() => __twin.closeDetail());
        await page.waitForTimeout(250);
        const at = await placeAt(id, 0.8); if (!at.hits || at.clear < 0.4) continue;
        const before = await page.evaluate(() => __twin.camera.position.toArray());
        await page.mouse.click(at.x, at.y); await page.waitForFunction(id => __twin.S.selected === id, id, { timeout: 5000 }); await settle(page);
        const s = await boxOnScreen(id); const after = await page.evaluate(() => __twin.camera.position.toArray());
        return { id, at, s, moved: dist(before, after), label };
      }
      throw new Error(label + ': no server could be placed at 90 % of the view and clicked');
    };
    const k1 = await clickRight('drawer closed');
    assert.ok(k1.s.inside, `${k1.label}: ${k1.id} clicked at 90 % stays inside the canvas after the drawer opens, clear of the camera buttons: ${JSON.stringify(k1.s)}`);
    assert.ok(k1.moved > 0.005, `${k1.label}: the view moved to keep it (${k1.moved.toFixed(3)} m)`);
    await shot(page, 'nav-keep-in-view.png');
    const k2 = await clickRight('a server selected', k1.id);
    assert.ok(k2.s.inside, `${k2.label}: ${k2.id} clicked at 90 % stays inside the canvas: ${JSON.stringify(k2.s)}`);
    pass(`keep in view: ${k1.id} clicked at 90 % with the drawer closed → box ${Math.round(k1.s.px.l)}–${Math.round(k1.s.px.r)} px inside canvas ${Math.round(k1.s.canvas.l)}–${Math.round(k1.s.canvas.r)} (moved ${k1.moved.toFixed(2)} m); ${k2.id} with a server selected → inside (moved ${k2.moved.toFixed(2)} m)`);
    // an object low in the view, target on the floor: the box ends inside frameSafe() vertically (the target bound does
    // not undo the shift), the target stays on the floor and the rack clearance holds (sampled every frame)
    let low = null;
    for (const id of ['LIVE-opt11', ...servers]) {
      for (const nx of [0.2, 0.35, -0.1]) {
        await page.locator('#vReset').click(); await settle(page); await page.evaluate(() => __twin.closeDetail()); await page.waitForTimeout(200);
        const at = await placeAt(id, nx, -0.86); if (!at.hits || at.clear < 0.4 || at.ny > -0.8) continue;
        await page.evaluate(() => Object.assign(window.__navRec, { on: true, min: Infinity, frames: 0 }));
        await page.mouse.click(at.x, at.y); await page.waitForFunction(id => __twin.S.selected === id, id, { timeout: 5000 }); await settle(page);
        const rec = await page.evaluate(() => { const R = window.__navRec; R.on = false; return R.min; });
        low = { id, at, v: await vertical(id), min: rec }; break;
      }
      if (low) break;
    }
    assert.ok(low, 'a server could be placed low in the view and clicked');
    assert.ok(low.v.inside, `${low.id} clicked at NDC y ${low.at.ny.toFixed(2)}: box ${low.v.y0.toFixed(3)}..${low.v.y1.toFixed(3)} inside frameSafe ${low.v.b.toFixed(3)}..${low.v.t.toFixed(3)}`);
    assert.ok(Math.abs(low.v.targetY) < 1e-6, 'the target stays on the floor: ' + low.v.targetY);
    assert.ok(low.min >= Math.min(0.4, low.at.clear) - 0.002, `keep in view keeps the rack clearance: ${low.min.toFixed(3)} m (before ${low.at.clear.toFixed(3)} m)`);
    pass(`keep in view (low in the view): ${low.id} clicked at NDC y ${low.at.ny.toFixed(2)} → box ${low.v.y0.toFixed(3)}..${low.v.y1.toFixed(3)} inside frameSafe ${low.v.b.toFixed(3)}..${low.v.t.toFixed(3)}, target on the floor, clearance ${low.min.toFixed(3)} m`);
    await page.evaluate(() => __twin.closeDetail());

    // ── 4. hover tip on OPT11
    const hoverTarget = async pg => {
      await pg.evaluate(() => { __twin.closeDetail(); }); await pg.locator('#vReset').click(); await settle(pg);
      await pg.evaluate(() => __twin.select('LIVE-opt11', { fly: true })); await settle(pg); await pg.evaluate(() => __twin.closeDetail()); await settle(pg);
      return pg.evaluate(() => {
        const t = __twin; const rec = t.S.recs.get('LIVE-opt11'); const box = new THREE.Box3(); rec.meshes.forEach(m => box.expandByObject(m)); const r = document.querySelector('#c').getBoundingClientRect();
        const c = box.getCenter(new THREE.Vector3()); const s = box.getSize(new THREE.Vector3());
        for (const [fx, fy, fz] of [[0, 0, 0], [0, 0.25, 0], [0, -0.25, 0], [0.25, 0, 0.25], [-0.25, 0, -0.25]]) {
          const v = new THREE.Vector3(c.x + fx * s.x, c.y + fy * s.y, c.z + fz * s.z).project(t.camera);
          const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
          if (t.pickAt({ clientX: x, clientY: y })?.object.userData.id === 'LIVE-opt11') return { x, y };
        }
        return null;
      });
    };
    const tipState = pg => pg.evaluate(() => { const el = document.querySelector('#hoverTip'); return { shown: !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0, text: el.innerText.replace(/\s+/g, ' ').trim() }; });
    const ht = await hoverTarget(page); assert.ok(ht, 'OPT11 can be hovered');
    await page.mouse.move(ht.x - 40, ht.y - 30); await page.mouse.move(ht.x, ht.y, { steps: 6 }); await page.waitForTimeout(250);
    const tip = await tipState(page);
    assert.ok(tip.shown, 'hover tip shown over OPT11: ' + JSON.stringify(tip));
    assert.match(tip.text, /OPT11/); assert.match(tip.text, /Rack-01/); assert.match(tip.text, /^OPT11 · (ON|OFF|\?) · Rack-01 › Shelf \d$/, 'tip wording: ' + tip.text);
    await shot(page, 'nav-hover.png');
    // live data under a resting pointer: every PDU reading turns stale → the tip says "?" within the 1 s ticker
    assert.match(tip.text, /· (ON|OFF) ·/, 'OPT11 has a power reading in the fixture: ' + tip.text);
    const savedAt = await page.evaluate(() => { const at = __twin.S.live.pduAt; const s = { ...at }; for (const k in at) at[k] = Date.now() - 3600e3; return s; });
    await page.waitForFunction(() => { const el = document.querySelector('#hoverTip'); return !el.hidden && / · \? · /.test(el.innerText.replace(/\s+/g, ' ')); }, null, { timeout: 6000 });
    const staleTip = (await tipState(page)).text;
    await page.evaluate(s => Object.assign(__twin.S.live.pduAt, s), savedAt);
    await page.waitForFunction(() => / · (ON|OFF) · /.test(document.querySelector('#hoverTip').innerText.replace(/\s+/g, ' ')), null, { timeout: 6000 });
    await page.mouse.down(); await page.waitForTimeout(100); const down = await tipState(page); await page.mouse.up();
    assert.equal(down.shown, false, 'hidden on pointer down');
    await page.mouse.move(ht.x + 2, ht.y + 1); await page.waitForTimeout(200);
    await page.evaluate(() => { const t = __twin; t.toggleEdit(true); t.startMove('LIVE-opt11'); });
    await page.mouse.move(ht.x - 3, ht.y, { steps: 3 }); await page.waitForTimeout(200); const moving = await tipState(page);
    await page.evaluate(() => { const t = __twin; t.cancelMove(); t.closeDetail(); t.toggleEdit(false); });
    assert.equal(moving.shown, false, 'hidden in Move mode');
    // a fast move off an object (the last move lands inside the 40 ms pick window) leaves no stale tip or hover
    await page.locator('#vReset').click(); await settle(page);
    const fast = await page.evaluate(async () => {
      const t = __twin; const c = document.querySelector('#c'); const r = c.getBoundingClientRect(); let A = null, E = null;
      for (let y = r.top + 60; y < r.bottom - 60 && !(A && E); y += 16) for (let x = r.left + 60; x < r.right - 60; x += 16) {
        if (document.elementFromPoint(x, y) !== c) continue; const h = t.pickAt({ clientX: x, clientY: y });
        if (h && !A && t.S.recs.get(h.object.userData.id)?.cat !== 'zone') A = { x, y, id: h.object.userData.id }; else if (!h && A && !E) E = { x, y }; if (A && E) break;
      }
      if (!A || !E) return null;
      const mv = p => c.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x, clientY: p.y, pointerType: 'mouse', bubbles: true, buttons: 0 }));
      await new Promise(res => setTimeout(res, 100)); mv(A); await new Promise(res => setTimeout(res, 120)); const atA = [!document.querySelector('#hoverTip').hidden, t.S.hover];
      mv(A); await new Promise(res => setTimeout(res, 60)); mv(A); await new Promise(res => setTimeout(res, 10)); mv(E); await new Promise(res => setTimeout(res, 250));
      return { A: A.id, atA, after: [!document.querySelector('#hoverTip').hidden, t.S.hover] };
    });
    assert.ok(fast, 'an object and an empty point were found');
    assert.deepEqual(fast.atA, [true, fast.A], 'tip shown over ' + fast.A); assert.deepEqual(fast.after, [false, null], 'a fast move off the object leaves no tip / hover: ' + JSON.stringify(fast));
    pass(`hover tip: "${tip.text}"; follows live data ("${staleTip}" when the reading is stale); a fast move off ${fast.A} clears it; hidden on pointer down and in Move mode`);

    // reduced motion: the keep-in-view / button tweens jump (zero-length)
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const rm = await page.evaluate(() => { __twin.zoomBy(0.9); const ms = __twin.S.tween?.ms; return ms; });
    assert.equal(rm, 0, 'reduced motion: button zoom jumps'); await page.emulateMedia({ reducedMotion: 'no-preference' }); await settle(page);
    await ctx.close();

    // ── 4b. touch (emulated tablet, desktop layout): no hover tip
    const touch = await open({ viewport: { width: 1280, height: 800 }, isMobile: true, hasTouch: true });
    const th = await hoverTarget(touch.page); assert.ok(th, 'OPT11 reachable on the tablet');
    await touch.page.touchscreen.tap(th.x, th.y); await touch.page.waitForTimeout(250); const t1 = await tipState(touch.page);
    await touch.page.mouse.move(th.x - 20, th.y); await touch.page.mouse.move(th.x, th.y, { steps: 4 }); await touch.page.waitForTimeout(250); const t2 = await tipState(touch.page);
    assert.deepEqual([t1.shown, t2.shown], [false, false], 'no hover tip on touch: ' + JSON.stringify([t1, t2]));
    await touch.ctx.close();
    pass('touch: no hover tip on a tablet (tap or mouse move)');
    // ── 5c. phones: the cluster sits behind a "Rotate" button beside the zoom bar; opened, every button is on screen
    // and tappable (no header over it), clear of the zoom bar, legend and sheet; Escape closes it; Move mode hides it
    const phones = [];
    for (const [w, h] of [[390, 844], [375, 667], [360, 640], [360, 560]]) {
      const phone = await open({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      const ph = () => phone.page.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const more = document.querySelector('#navMore'); const vp = r('#viewport'), sheet = r('#sheet');
        const hit = (a, b) => a.width > 0 && b.width > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const btns = [...document.querySelectorAll('#navPad .zb')].filter(b => b.getBoundingClientRect().width > 0).map(b => { const q = b.getBoundingClientRect(); const at = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
          return { id: b.id, ok: !!at && b.contains(at) && q.top >= vp.top && q.bottom <= sheet.top && q.left >= 0 && q.right <= innerWidth, top: Math.round(q.top) }; });
        return { more: [more.textContent, more.getAttribute('aria-expanded'), r('#navMore').width > 0, Math.round(r('#navMore').height)], body: r('#navPadBody').width > 0, btns,
          over: Object.entries({ zoombar: '.zoombar', legend: '#legend', sheet: '#sheet' }).filter(([, s]) => hit(r('#navPadBody'), r(s)) || hit(r('#navMore'), r(s))).map(([k]) => k) }; });
      const p1 = await ph(); assert.deepEqual(p1.more, ['Rotate', 'false', true, 44], `${w}×${h}: "Rotate" button`); assert.equal(p1.body, false, 'collapsed by default on a phone');
      await phone.page.locator('#navMore').tap(); await phone.page.waitForTimeout(200); const p2 = await ph();
      assert.equal(p2.more[1], 'true'); assert.equal(p2.btns.length, 7, `${w}×${h}: 7 buttons shown`);
      assert.ok(p2.btns.every(b => b.ok) && !p2.over.length, `${w}×${h}: every opened button on screen and tappable, clear of ${JSON.stringify(p2.over)}: ` + JSON.stringify(p2.btns));
      const az0 = await phone.page.evaluate(() => __twin.controls.getAzimuthalAngle());
      await phone.page.locator('#rotL').tap(); await settle(phone.page);
      const az1 = await phone.page.evaluate(() => __twin.controls.getAzimuthalAngle());
      assert.ok(Math.abs(Math.atan2(Math.sin(az1 - az0), Math.cos(az1 - az0))) > 0.2, `${w}×${h}: a tap on rotate left turns the view`);
      if (w === 390) {
        await phone.page.screenshot({ path: path.join(shots, 'nav-phone.png') });
        await phone.page.evaluate(() => document.querySelector('#rotL').focus()); await phone.page.keyboard.press('Escape'); await phone.page.waitForTimeout(150);
        assert.deepEqual(await phone.page.evaluate(() => [document.querySelector('#navMore').getAttribute('aria-expanded'), document.querySelector('#navPadBody').getBoundingClientRect().width > 0, document.activeElement?.id]), ['false', false, 'navMore'], 'Escape closes the cluster and focuses "Rotate"');
        const mvh = await phone.page.evaluate(() => { const t = __twin; t.toggleEdit(true); const id = 'LIVE-opt11'; t.select(id, { keepCamera: true }); t.startMove(id); const during = document.querySelector('#navMore').getBoundingClientRect().width; t.cancelMove(); t.toggleEdit(false); t.closeDetail(); return [during, document.querySelector('#navMore').getBoundingClientRect().width > 0]; });
        assert.deepEqual(mvh, [0, true], 'phone: Move mode hides the camera cluster, Cancel brings it back');
        // a tap on a server low in the view (sheet at peek): the half sheet opens over it and keepInView lifts it into frameSafe
        await phone.page.evaluate(() => __twin.setSheet('peek')); await phone.page.waitForTimeout(300);
        const at = await placeAt('LIVE-opt11', 0, -0.55, phone.page); assert.ok(at.hits, 'phone: OPT11 placed low and tappable: ' + JSON.stringify(at));
        await phone.page.touchscreen.tap(at.x, at.y); await phone.page.waitForFunction(() => __twin.S.selected === 'LIVE-opt11', null, { timeout: 5000 }); await settle(phone.page);
        const v = await vertical('LIVE-opt11', phone.page);
        assert.ok(v.inside && Math.abs(v.targetY) < 1e-6, `phone: OPT11 tapped at NDC y ${at.ny.toFixed(2)} ends ${v.y0.toFixed(3)}..${v.y1.toFixed(3)} inside frameSafe ${v.b.toFixed(3)}..${v.t.toFixed(3)} with the target on the floor`);
        phones.push(`390×844 tap low → box ${v.y0.toFixed(3)}..${v.y1.toFixed(3)} in ${v.b.toFixed(3)}..${v.t.toFixed(3)}`);
      }
      phones.push(`${w}×${h} buttons ${Math.min(...p2.btns.map(b => b.top))}+ px`);
      await phone.ctx.close();
    }
    pass('phones: camera cluster behind a 44 px "Rotate" button beside the zoom bar; opened, all 6 buttons on screen and tappable, clear of the zoom bar, legend and sheet (' + phones.join('; ') + '); Escape closes it; Move mode hides it');

    assert.deepEqual(writes, [], 'no writes'); assert.deepEqual(errors, [], 'page errors');
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.stack || String(e), checks, errors, writes }, null, 2));
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
