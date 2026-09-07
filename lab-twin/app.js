/* Lab Manager — Digital Twin (Three.js r128, classic scripts, no build step)
 * Geometry is built here from lab-data.json; inventory/positions live in the JSON.
 * Live mode talks to the DCIM-204 FastAPI backend (same endpoints the React UI uses).
 */
/* global THREE */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────── constants
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STATUS_COLOR = { active: '#76b900', building: '#fbbf24', inactive: '#71717a', dismantled: '#f43f5e', unknown: '#52525b' };
  const STATUS_LABEL = { active: 'Active', building: 'In construction', inactive: 'Inactive', dismantled: 'Dismantled', unknown: 'Unknown' };
  const STATUSES = Object.keys(STATUS_COLOR);
  const CONF_OPACITY = { high: 1.0, medium: 0.82, low: 0.5 };
  const TYPE_STRIPE = { opt: '#76b900', kvm: '#a78bfa', pdu: '#fbbf24', chiller: '#22d3ee', 'equip-switch': '#22d3ee', 'equip-patchpanel': '#94a3b8', 'equip-kvm': '#a78bfa', 'equip-pdu': '#fbbf24', 'equip-ups': '#4ade80', 'equip-cable': '#71717a', 'equip-blank': '#3f3f46', 'equip-other': '#a1a1aa', cart: '#3b82f6', ladder: '#facc15', toolbox: '#f97316', 'spare-chassis': '#d6c9a8', misc: '#71717a' };
  // realistic body colours (photo-matched); status is shown by edge outline + LED + label dot
  const TYPE_BODY = { opt: '#2a2c31', kvm: '#1c1c20', pdu: '#1b1b20', chiller: '#e6e1d5', 'equip-switch': '#232a38', 'equip-patchpanel': '#3a3f47', 'equip-ups': '#26292e', 'equip-kvm': '#1c1c20', 'equip-pdu': '#1b1b20', 'equip-cable': '#3f3f46', 'equip-blank': '#3f3f46', 'equip-other': '#4b5058', cart: '#2f6fd6', ladder: '#f2c230', toolbox: '#2b2b2b', 'spare-chassis': '#c9bf9c', misc: '#8a8f97', other: '#8a8f97' };
  const CABLE_COLORS = ['#d92b2b', '#d92b2b', '#1a1a1a', '#d92b2b', '#22c1a6', '#d92b2b', '#f4f4f5'];
  const EQUIP_LABEL = { switch: 'Switch', patchpanel: 'Patch Panel', cable: 'Cable Mgmt', pdu: 'PDU', kvm: 'KVM', ups: 'UPS', blank: 'Blank Panel', other: 'Other' };
  const POLL_MS = 15000;

  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('twin.' + k)); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('twin.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ───────────────────────────────────────────────────────────── state
  const S = {
    data: null,
    recs: new Map(),          // id -> record { id, cat, def, group, meshes[], edges[], label, anchor, status, conf, zone, setup, shelf, filtered }
    pickables: [],
    selected: null, hover: null,
    filters: { zone: '', setup: '', statuses: new Set(STATUSES), onlyLow: false, q: '' },
    dirty: false,                        // unsaved edits to S.data (draft mirrored in localStorage)
    settings: LS.get('settings', { url: '', pass: '', poll: true }),
    live: { connected: false, devices: [], pdu: {}, kvm: {}, rackSlots: {}, rackOrder: {}, sw: {}, owners: {}, rackItems: {}, chillers: null, rackOverrides: {}, error: null, timer: null },
    labelMode: 'setups', wallsVisible: true, zonesVisible: true,
    heat: LS.get('heat', true), embed: /[?&]embed=1/.test(location.search), editMode: LS.get('editMode', false), kiosk: LS.get('kiosk', false) || /[?&]kiosk=1/.test(location.search), moveItem: null, lastInput: performance.now(),
    model: null,              // computed effective model (setups, shelves, items)
    tween: null,
  };

  // ───────────────────────────────────────────────────────────── three.js setup
  const canvas = $('#c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  const scene = new THREE.Scene();
  scene.fog = null;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.1;
  controls.maxPolarAngle = Math.PI / 2 - 0.01; controls.minDistance = 0.3; controls.maxDistance = 9;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.screenSpacePanning = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55); sun.position.set(-6, 9, 4); scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fe040, 0.12); fill.position.set(-4, 5, -6); scene.add(fill);

  const wallsGroup = new THREE.Group(); wallsGroup.name = 'walls';
  const zonesGroup = new THREE.Group(); zonesGroup.name = 'zones';
  const staticGroup = new THREE.Group(); staticGroup.name = 'static';   // racks, storage
  const itemsGroup = new THREE.Group(); itemsGroup.name = 'items';
  // Data axes: x across the room (0 = LEFT wall when standing at the entrance looking in), z = depth from the entrance.
  // Three.js is right-handed (looking down +z, +x is on the viewer's LEFT), so the whole world is mirrored on x
  // to make data-x grow to the viewer's right. World x = -data x. The renderer flips face winding for negative scale.
  const world = new THREE.Group(); world.name = 'world'; world.scale.x = -1;
  world.add(wallsGroup, zonesGroup, staticGroup, itemsGroup); scene.add(world);
  const WX = x => -x; // data x -> world x (for camera targets)
  let selectionHelper = null;

  const labelsLayer = $('#labels');
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function resize() {
    const vp = $('#viewport'); const w = vp.clientWidth, h = vp.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // ───────────────────────────────────────────────────────────── geometry helpers
  const matCache = new Map();
  function mat(color, opts = {}) {
    const key = color + JSON.stringify(opts);
    if (!opts.unique && matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: opts.rough ?? 0.75, metalness: opts.metal ?? 0.12, transparent: true, opacity: opts.opacity ?? 1, side: opts.double ? THREE.DoubleSide : THREE.FrontSide, emissive: new THREE.Color(opts.emissive || 0x000000), emissiveIntensity: opts.emissiveIntensity ?? 1 });
    m.userData.baseOpacity = m.opacity; m.userData.unique = !!opts.unique;
    if (!opts.unique) matCache.set(key, m);
    return m;
  }
  function setEdgeOp(e, o) { e.material.opacity = o; e.userData.baseOpacity = o; return e; }
  function box(w, h, d, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); m.position.set(x, y, z); return m;
  }
  function edges(mesh, color, dashed = false) {
    const g = new THREE.EdgesGeometry(mesh.geometry, 20);
    const m = dashed ? new THREE.LineDashedMaterial({ color: new THREE.Color(color), dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.95 })
                     : new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.9 });
    const l = new THREE.LineSegments(g, m); l.position.copy(mesh.position); l.rotation.copy(mesh.rotation); l.scale.copy(mesh.scale);
    if (dashed) l.computeLineDistances();
    l.userData.baseOpacity = m.opacity; l.renderOrder = 2;
    return l;
  }
  function disposeGroup(g) {
    g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.userData.unique) o.material.dispose(); });
    while (g.children.length) g.remove(g.children[0]);
  }

  // record registration
  function reg(rec) { S.recs.set(rec.id, rec); rec.meshes.forEach(m => { m.userData.id = rec.id; S.pickables.push(m); }); return rec; }
  function makeLabel(rec, cls, html) {
    const el = document.createElement('div'); el.className = 'lbl ' + cls; el.innerHTML = html; el.dataset.id = rec.id;
    el.addEventListener('click', e => { e.stopPropagation(); select(rec.id); });
    labelsLayer.appendChild(el); rec.label = el;
  }

  // ───────────────────────────────────────────────────────────── room
  function buildRoom(d) {
    const { width: W, depth: D, height: H } = d.room;
    // floor
    const floor = box(W, 0.02, D, mat('#c4c8cc', { rough: 0.95, metal: 0 }), W / 2, -0.01, D / 2); floor.receiveShadow = true; staticGroup.add(floor);
    // grid 0.6 m
    const pts = [];
    for (let x = 0; x <= W + 1e-6; x += 0.6) pts.push(x, 0.002, 0, x, 0.002, D);
    for (let z = 0; z <= D + 1e-6; z += 0.6) pts.push(0, 0.002, z, W, 0.002, z);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    staticGroup.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x9a9ea3, transparent: true, opacity: 0.55 })));
    // walls
    const wallMat = mat('#eceef0', { opacity: 0.38, double: true, rough: 1, metal: 0, unique: true });
    const t = 0.08;
    (d.structure.walls || []).forEach(w => {
      const [x1, z1] = w.from, [x2, z2] = w.to; const len = Math.hypot(x2 - x1, z2 - z1);
      const m = box(len, H, t, wallMat, (x1 + x2) / 2, H / 2, (z1 + z2) / 2); m.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      const off = t / 2; // push outward so the interior face sits on the room boundary
      if (w.id === 'WALL-L') m.position.x -= off; if (w.id === 'WALL-R') m.position.x += off; if (w.id === 'WALL-F') m.position.z -= off; if (w.id === 'WALL-B') m.position.z += off;
      wallsGroup.add(m); wallsGroup.add(edges(m, '#9ca3af'));
    });
    // wall base line (visible even with translucent walls)
    const base = [0, 0.01, 0, W, 0.01, 0, W, 0.01, 0, W, 0.01, D, W, 0.01, D, 0, 0.01, D, 0, 0.01, D, 0, 0.01, 0];
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
    staticGroup.add(new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: 0x9a9aa3 })));
    // doors
    (d.structure.doors || []).forEach(dr => {
      const onZ = dr.wall === 'WALL-L' || dr.wall === 'WALL-R';
      const m = onZ ? box(0.12, dr.height, dr.width, mat('#cbb994', { rough: .8 }), dr.pos[0], dr.height / 2, dr.pos[1] + dr.width / 2)
                    : box(dr.width, dr.height, 0.12, mat('#cbb994', { rough: .8 }), dr.pos[0] + dr.width / 2, dr.height / 2, dr.pos[1]);
      const low = dr.confidence === 'low';
      if (low) m.material = mat('#cbb994', { rough: .8, opacity: .5, unique: true });
      wallsGroup.add(m); wallsGroup.add(edges(m, low ? '#f43f5e' : '#a8977a', low));
      const rec = reg({ id: dr.id, cat: 'structure', def: dr, group: m, meshes: [m], edges: [], status: 'active', conf: dr.confidence, zone: null, anchor: new THREE.Vector3(m.position.x, dr.height + 0.05, m.position.z) });
      makeLabel(rec, 'item' + (low ? ' low' : ''), `${dr.id}<small>door${low ? ' — verify' : ''}</small>`);
    });
    // windows
    (d.structure.windows || []).forEach(wn => {
      const onZ = wn.wall === 'WALL-L' || wn.wall === 'WALL-R';
      const glass = mat('#7dd3fc', { opacity: .35, emissive: '#7dd3fc', emissiveIntensity: .25, unique: true });
      const m = onZ ? box(0.1, wn.height, wn.width, glass, wn.pos[0], wn.sill + wn.height / 2, wn.pos[1] + wn.width / 2)
                    : box(wn.width, wn.height, 0.1, glass, wn.pos[0] + wn.width / 2, wn.sill + wn.height / 2, wn.pos[1]);
      wallsGroup.add(m); wallsGroup.add(edges(m, '#7dd3fc', wn.confidence === 'low'));
      const rec = reg({ id: wn.id, cat: 'structure', def: wn, group: m, meshes: [m], edges: [], status: 'active', conf: wn.confidence, zone: null, anchor: new THREE.Vector3(m.position.x, wn.sill + wn.height + 0.05, m.position.z) });
      makeLabel(rec, 'item', `${wn.id}<small>window</small>`);
    });
    // pillar
    (d.structure.pillars || []).forEach(p => {
      const cx = Math.min(Math.max(p.pos[0] - p.radius * 0.8, 0), W), cz = Math.min(Math.max(p.pos[1] - p.radius * 0.8, 0), D);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, H, 32), mat('#7c7c86', { opacity: .55, unique: true })); m.position.set(cx, H / 2, cz);
      wallsGroup.add(m);
      const rec = reg({ id: p.id, cat: 'structure', def: p, group: m, meshes: [m], edges: [], status: 'active', conf: p.confidence, zone: null, anchor: new THREE.Vector3(cx, H * 0.75, cz) });
      makeLabel(rec, 'item', `${p.id}<small>column</small>`);
    });
    // fixtures (E-stop)
    (d.structure.fixtures || []).forEach(f => {
      const m = box(0.06, 0.1, 0.1, mat('#ef4444', { emissive: '#ef4444', emissiveIntensity: .4 }), f.pos[0] + 0.04, f.height, f.pos[1]);
      wallsGroup.add(m);
      const rec = reg({ id: f.id, cat: 'structure', def: f, group: m, meshes: [m], edges: [], status: 'active', conf: f.confidence, zone: null, anchor: new THREE.Vector3(f.pos[0] + 0.1, f.height + 0.1, f.pos[1]) });
      makeLabel(rec, 'item', `${f.id}<small>emergency stop</small>`);
    });
    // ceiling lights
    (d.structure.ceilingLights || []).forEach(([x, z]) => {
      const m = box(1.2, 0.02, 0.3, mat('#f8fafc', { emissive: '#f8fafc', emissiveIntensity: .9 }), x, H - 0.01, z); wallsGroup.add(m);
    });
    // zones
    (d.zones || []).forEach(zn => {
      const [x1, z1, x2, z2] = zn.bounds;
      const m = box(x2 - x1, 0.004, z2 - z1, mat(zn.color, { opacity: .10, unique: true, rough: 1 }), (x1 + x2) / 2, 0.006, (z1 + z2) / 2);
      m.renderOrder = 1; zonesGroup.add(m);
      const e = setEdgeOp(edges(m, zn.color, zn.confidence === 'low'), .55); zonesGroup.add(e);
      const rec = reg({ id: zn.id, cat: 'zone', def: zn, group: m, meshes: [m], edges: [e], status: 'active', conf: zn.confidence, zone: zn.id, anchor: new THREE.Vector3((x1 + x2) / 2, 0.02, (z1 + z2) / 2) });
      makeLabel(rec, 'zone', `<span style="color:${zn.color}">${zn.id}</span>`);
    });
  }

  // ───────────────────────────────────────────────────────────── racks / storage
  function localToWorld(group, x, y, z) { return group.localToWorld(new THREE.Vector3(x, y, z)); }

  function buildRack(su, shelvesDefs, tpl) {
    const { width: w, depth: dd, height: h, shelfLevels, shelfThickness: st, profile: p } = tpl;
    const g = new THREE.Group(); g.position.set(su.pos[0], 0, su.pos[1]); g.rotation.y = THREE.MathUtils.degToRad(su.rot || 0); g.updateMatrixWorld(true);
    const status = effStatus(su); const col = STATUS_COLOR[status];
    const postMat = mat('#cdd0d5', { metal: .6, rough: .3, unique: true });
    const meshes = [], eds = [];
    // posts
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      const m = box(p, h, p, postMat, sx * (dd / 2 - p / 2), h / 2, sz * (w / 2 - p / 2)); g.add(m); meshes.push(m);
    });
    // frame rings (top + floor)
    [h - p / 2, 0.06].forEach(y => {
      [[-1], [1]].forEach(([sx]) => { const m = box(p, p, w - 2 * p, postMat, sx * (dd / 2 - p / 2), y, 0); g.add(m); meshes.push(m); });
      [[-1], [1]].forEach(([sz]) => { const m = box(dd - 2 * p, p, p, postMat, 0, y, sz * (w / 2 - p / 2)); g.add(m); meshes.push(m); });
    });
    // status frame outline (colored edges of the rack envelope)
    const env = box(dd, h, w, mat('#000', { opacity: 0 }), 0, h / 2, 0); env.visible = false; g.add(env);
    const e = setEdgeOp(edges(env, col), .5); g.add(e); eds.push(e);
    staticGroup.add(g); g.updateMatrixWorld(true);
    const rec = reg({ id: su.id, cat: 'setup', def: su, group: g, meshes, edges: eds, status, conf: su.confidence, zone: su.zone, setup: su.id, anchor: localToWorld(g, 0, h + 0.12, 0), tpl });
    makeLabel(rec, 'setup', `<span class="lp" style="background:${col}"></span>${su.id}<small>${dcimRackOf(su) || 'no DCIM rack'} · ${su.name.split('—')[0].trim()}</small>`);
    // floating telemetry card (power / voltage / current / capacity / temp / humidity / leak) — filled by updateTelemetry()
    const tel = document.createElement('div'); tel.className = 'telem'; tel.dataset.id = su.id; tel.innerHTML = '<span class="t-muted">no live data</span>';
    tel.addEventListener('click', e => { e.stopPropagation(); select(su.id, { fly: true }); }); labelsLayer.appendChild(tel);
    rec.telem = tel; rec.telemAnchor = localToWorld(g, 0, h + 0.55, 0);
    // heat-map patch under the rack + leak ring (hidden until live data / toggle)
    const patch = box(dd + 0.3, 0.012, w + 0.3, mat('#22c55e', { opacity: .45, unique: true, rough: 1, emissive: '#22c55e', emissiveIntensity: .35 }), 0, 0.012, 0); patch.visible = false; g.add(patch); rec.heatPatch = patch;
    const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(dd, w) * 0.55, Math.max(dd, w) * 0.62, 48), new THREE.MeshBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: .8, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; ring.visible = false; g.add(ring); rec.leakRing = ring;

    // shelves
    shelvesDefs.forEach(sh => {
      const y = shelfLevels[sh.level - 1];
      const m = box(dd - 2 * p - 0.02, st, w - 2 * p - 0.02, mat('#dfe2e6', { metal: .3, rough: .5, unique: true }), 0, y - st / 2, 0); g.add(m);
      const shStatus = effStatus(sh); const se = setEdgeOp(edges(m, STATUS_COLOR[shStatus]), .7); g.add(se);
      // power strip above the shelf (part of the rack PDU)
      const strip = box(0.05, 0.045, 0.55, mat('#1b1b20', { rough: .6, metal: .3, unique: true }), -dd / 2 + p + 0.05, y + 0.22, 0); g.add(strip);
      const led = box(0.012, 0.012, 0.03, mat('#76b900', { emissive: '#76b900', emissiveIntensity: 1.2, unique: true }), -dd / 2 + p + 0.026, y + 0.22, 0.2); g.add(led);
      const srec = reg({ id: sh.id, cat: 'shelf', def: sh, group: m, meshes: [m], edges: [se], status: shStatus, conf: sh.confidence, zone: sh.zone, setup: su.id, level: sh.level, strip, led, anchor: null, y });
      srec.anchor = () => localToWorld(g, dd / 2 - 0.05, y + 0.02, -w / 2 + 0.12);
      // drop-target volume (the space above the shelf) — only visible / pickable while moving an item
      const nextLv = shelvesDefs.map(s => s.level).filter(l => l > sh.level).sort((a, b) => a - b)[0];
      const nextY = nextLv ? shelfLevels[nextLv - 1] : h - p; const sh0 = y + 0.01, sh1 = nextY - st - 0.01;
      const slot = box(dd - 2 * p - 0.02, Math.max(0.1, sh1 - sh0), w - 2 * p - 0.02, mat('#22d3ee', { opacity: .22, unique: true, emissive: '#22d3ee', emissiveIntensity: .5, rough: 1 }), 0, (sh0 + sh1) / 2, 0);
      slot.material.depthWrite = false; slot.visible = false; slot.userData.id = sh.id; slot.userData.slot = true; g.add(slot); S.pickables.push(slot); srec.slot = slot;
      makeLabel(srec, 'shelf', `${sh.id}<small>L${sh.level}</small>`);
    });
    return rec;
  }

  function buildTrayRack(sd, tpl) {
    const { width: w, depth: dd, height: h, trayPitch } = tpl; const p = 0.03;
    const g = new THREE.Group(); g.position.set(sd.pos[0], 0, sd.pos[1]); g.rotation.y = THREE.MathUtils.degToRad(sd.rot || 0); g.updateMatrixWorld(true);
    const status = effStatus(sd); const col = STATUS_COLOR[status]; const postMat = mat('#a3a7ae', { metal: .5, rough: .4, unique: true });
    const meshes = [];
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => { const m = box(p, h, p, postMat, sx * (dd / 2 - p / 2), h / 2, sz * (w / 2 - p / 2)); g.add(m); meshes.push(m); });
    [[-1], [1]].forEach(([sz]) => { const m = box(dd - 2 * p, p, p, postMat, 0, h - p / 2, sz * (w / 2 - p / 2)); g.add(m); meshes.push(m); });
    let y = 0.155; const trayY = [];
    trayPitch.forEach(pitch => { y += pitch; trayY.push(y); const m = box(dd - 2 * p - 0.02, 0.012, w - 2 * p - 0.02, mat('#c2c6cc', { metal: .35, rough: .5 }), 0, y, 0); g.add(m); meshes.push(m); });
    const env = box(dd, h, w, mat('#000', { opacity: 0 }), 0, h / 2, 0); env.visible = false; g.add(env);
    const e = setEdgeOp(edges(env, col), .55); g.add(e);
    staticGroup.add(g); g.updateMatrixWorld(true);
    const rec = reg({ id: sd.id, cat: 'storage', def: sd, group: g, meshes, edges: [e], status, conf: sd.confidence, zone: sd.zone, anchor: localToWorld(g, 0, h + 0.12, 0), trayY, tpl });
    makeLabel(rec, 'storage', `<span class="lp" style="background:${col}"></span>${sd.id}<small>${sd.name}</small>`);
    return rec;
  }

  function buildCabinet(sd) {
    const [w, dd, h] = sd.size; const g = new THREE.Group(); g.position.set(sd.pos[0], 0, sd.pos[1]); g.rotation.y = THREE.MathUtils.degToRad(sd.rot || 0); g.updateMatrixWorld(true);
    const status = effStatus(sd); const col = STATUS_COLOR[status];
    const m = box(w, h, dd, mat('#6b6f78', { metal: .4, rough: .5, opacity: CONF_OPACITY[sd.confidence], unique: true }), 0, h / 2, 0); g.add(m);
    const e = edges(m, col, sd.confidence === 'low'); g.add(e);
    const seam = box(0.005, h - 0.1, 0.01, mat('#3f3f46'), 0, h / 2, dd / 2 + 0.005); g.add(seam);
    staticGroup.add(g); g.updateMatrixWorld(true);
    const rec = reg({ id: sd.id, cat: 'storage', def: sd, group: g, meshes: [m], edges: [e], status, conf: sd.confidence, zone: sd.zone, anchor: localToWorld(g, 0, h + 0.12, 0) });
    makeLabel(rec, 'storage', `<span class="lp" style="background:${col}"></span>${sd.id}<small>${sd.name}</small>`);
    return rec;
  }

  // ───────────────────────────────────────────────────────────── items
  function buildItems() {
    // remove previous item recs
    for (const [id, r] of [...S.recs]) if (r.cat === 'item') { if (r.label) r.label.remove(); S.recs.delete(id); }
    S.pickables = S.pickables.filter(m => { const r = S.recs.get(m.userData.id); return !!r; });
    (S.itemGroups || []).forEach(g => { if (g.parent) g.parent.remove(g); disposeGroup(g); }); S.itemGroups = [];
    disposeGroup(itemsGroup);
    // reset strips (PDU visuals) before re-assigning
    for (const r of S.recs.values()) if (r.cat === 'shelf' && r.strip) { r.strip.material.emissive.setHex(0x000000); r.strip.material.emissiveIntensity = 0; r.led.visible = false; }

    const model = S.model; const tpl = S.data.templates;
    // group items by shelf to distribute along width
    const byShelf = new Map();
    model.items.forEach(it => { if (it.shelf) { if (!byShelf.has(it.shelf)) byShelf.set(it.shelf, []); byShelf.get(it.shelf).push(it); } });

    model.items.forEach(it => {
      const status = it.effStatus; const col = STATUS_COLOR[status];
      const pconf = it.placementConfidence || it.confidence || 'medium'; const op = CONF_OPACITY[pconf] ?? .8;
      const dashed = pconf === 'low';
      const stripeCol = TYPE_STRIPE[it.type] || '#71717a';
      let g = null, meshes = [], eds = [], anchor = null;

      const makeBox = (w, h, d, color, emis = 0) => {
        const m = box(w, h, d, mat(color, { opacity: op, unique: true, rough: .6, metal: .2, emissive: emis ? color : '#000', emissiveIntensity: emis }));
        return m;
      };
      const bodyCol = TYPE_BODY[it.type] || TYPE_BODY.other;
      const led = (x, y, z, c, size = 0.014) => box(size, size, size, mat(c, { emissive: c, emissiveIntensity: 1.3, unique: true }), x, y, z);
      let seed = 0; for (const ch of it.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const cable = (pts, c, r = 0.006) => { const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))); const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 18, r, 6, false), mat(c, { rough: .55, metal: .05, opacity: op, unique: true })); return m; };

      if (it.shelf && S.recs.has(it.shelf)) {
        const sh = S.recs.get(it.shelf); const su = S.recs.get(sh.setup); const rt = su.tpl;
        const siblings = byShelf.get(it.shelf); const n = siblings.length; const idx = siblings.indexOf(it);
        const usable = rt.width - 2 * rt.profile - 0.12; const slotW = usable / n;
        const zc = -usable / 2 + slotW * (idx + 0.5);
        g = new THREE.Group();
        let w = 0.48, d = 0.55, h = 0.09;
        if (it.type === 'kvm') { w = 0.44; d = 0.30; h = 0.045; }
        if (it.type.startsWith('equip-')) { w = 0.44; d = 0.35; h = 0.045; }
        w = Math.min(w, slotW - 0.03);
        const body = makeBox(d, h, w, bodyCol); body.position.set(0.04, sh.y + h / 2, zc); g.add(body); meshes.push(body);
        const fx = d / 2 + 0.04 + 0.002; // front face x (local)
        // front faceplate: silver band + port row (dark) + type stripe + status LED + blue activity LEDs
        g.add(box(0.006, h * .8, w * .94, mat('#9aa0a8', { metal: .7, rough: .35, opacity: op, unique: true }), fx, sh.y + h / 2, zc));
        g.add(box(0.008, Math.min(0.022, h * .35), w * .7, mat('#111114', { rough: .8, opacity: op, unique: true }), fx + 0.003, sh.y + h * .42, zc + w * .05));
        g.add(box(0.008, h * .55, 0.012, mat(stripeCol, { emissive: stripeCol, emissiveIntensity: .8, opacity: op, unique: true }), fx + 0.003, sh.y + h / 2, zc - w / 2 + 0.02));
        g.add(led(fx + 0.006, sh.y + h * .78, zc - w / 2 + 0.06, col));
        if (it.type === 'opt' && status !== 'dismantled') { const nb = 1 + Math.floor(rnd() * 3); for (let i = 0; i < nb; i++) g.add(led(fx + 0.006, sh.y + h * .78, zc - w / 2 + 0.1 + i * 0.03, '#3b82f6', 0.009)); }
        // cables from the front to the rack post (red fibre / black power), like the photos
        if (it.type === 'opt' || it.type.startsWith('equip-')) {
          const nc = 1 + Math.floor(rnd() * 2); const postZ = (zc > 0 ? 1 : -1) * (rt.width / 2 - rt.profile - 0.02); const postX = rt.depth / 2 - rt.profile;
          for (let i = 0; i < nc; i++) {
            const z0 = zc + (rnd() - 0.5) * w * .6, y0 = sh.y + h * .45; const cc = CABLE_COLORS[Math.floor(rnd() * CABLE_COLORS.length)];
            g.add(cable([[fx, y0, z0], [fx + 0.12 + rnd() * 0.1, y0 - 0.08 - rnd() * 0.12, z0 + (postZ - z0) * 0.35], [fx + 0.06, y0 - 0.22 - rnd() * 0.15, postZ * 0.9], [postX, sh.y - 0.12 - rnd() * 0.1, postZ]], cc));
          }
        }
        const e = edges(body, col, dashed); g.add(e); eds.push(e);
        su.group.add(g);
        anchor = () => localToWorld(su.group, 0.04 + d / 2, sh.y + h + 0.02, zc);
      } else if (it.placement === 'bottom-bay' && it.setup && S.recs.has(it.setup)) {
        const su = S.recs.get(it.setup); const c = tpl.chiller; const n = model.items.filter(x => x.placement === 'bottom-bay' && x.setup === it.setup); const idx = n.indexOf(it);
        const zc = n.length > 1 ? (idx === 0 ? -0.22 : 0.22) : -0.08;
        g = new THREE.Group();
        const body = makeBox(c.depth, c.height, c.width, bodyCol); body.position.set(-0.05, c.height / 2, zc); g.add(body); meshes.push(body);
        const fx = c.depth / 2 - 0.05 + 0.004;
        g.add(box(0.008, 0.045, 0.09, mat('#0b0b0e', { rough: .4, opacity: op, unique: true }), fx, c.height * .80, zc - 0.14));           // display window
        g.add(box(0.012, 0.014, 0.05, mat('#22c55e', { emissive: '#22c55e', emissiveIntensity: 1.2, unique: true }), fx + 0.002, c.height * .80, zc - 0.14)); // green digits
        g.add(box(0.008, 0.06, 0.05, mat('#d92b2b', { rough: .7, opacity: op, unique: true }), fx, c.height * .80, zc + 0.16));            // red warning label
        g.add(box(0.008, 0.16, 0.06, mat('#f4f4f5', { rough: .7, opacity: op, unique: true }), fx, c.height * .45, zc + 0.18));            // white spec label
        g.add(box(0.008, 0.05, 0.05, mat('#e11d48', { rough: .7, opacity: op, unique: true }), fx, c.height * .30, zc - 0.05));            // red sticker
        g.add(led(fx + 0.004, c.height * .92, zc - 0.22, col, 0.016));
        const e = edges(body, col, dashed); g.add(e); eds.push(e);
        su.group.add(g); anchor = () => localToWorld(su.group, c.depth / 2, c.height + 0.03, zc);
      } else if (it.placement === 'side-mount' && it.setup && S.recs.has(it.setup)) {
        // hung vertically on the outside of the rack's side frame (e.g. KVM). side: 'left' (−z) | 'right' (+z), mountHeight = centre height
        const su = S.recs.get(it.setup); const rt = su.tpl; const sgn = it.side === 'left' ? -1 : 1;
        const t = 0.045, L = 0.44, D2 = 0.30; const zc = sgn * (rt.width / 2 + t / 2 + 0.005); const yc = it.mountHeight || 1.45; const xc = -0.05;
        g = new THREE.Group();
        const body = makeBox(D2, L, t, bodyCol); body.position.set(xc, yc, zc); g.add(body); meshes.push(body);
        g.add(box(D2 * .9, L * .92, 0.006, mat('#9aa0a8', { metal: .7, rough: .35, opacity: op, unique: true }), xc, yc, zc + sgn * (t / 2 + 0.003)));          // faceplate
        for (let i = 0; i < 4; i++) g.add(box(0.05, 0.018, 0.008, mat('#111114', { rough: .8, opacity: op, unique: true }), xc - D2 * .3 + i * 0.06, yc + L * .3, zc + sgn * (t / 2 + 0.006)));  // port row
        g.add(led(xc + D2 * .38, yc + L * .42, zc + sgn * (t / 2 + 0.008), col));
        g.add(box(0.02, 0.08, 0.06, mat('#8a8f97', { metal: .6, rough: .4, opacity: op, unique: true }), xc, yc + L / 2 - 0.03, zc - sgn * (t / 2 + 0.02)));   // bracket top
        g.add(box(0.02, 0.08, 0.06, mat('#8a8f97', { metal: .6, rough: .4, opacity: op, unique: true }), xc, yc - L / 2 + 0.03, zc - sgn * (t / 2 + 0.02)));   // bracket bottom
        for (let i = 0; i < 3; i++) { const z0 = zc + sgn * (t / 2 + 0.01), y0 = yc + L * .3; g.add(cable([[xc - D2 * .3 + i * 0.06, y0, z0], [xc - D2 * .3 + i * 0.06 + 0.02, y0 + 0.15, z0 + sgn * 0.08], [xc + 0.1, y0 + 0.35, z0 + sgn * 0.03], [rt.depth / 2 - rt.profile, y0 + 0.5, sgn * (rt.width / 2 - rt.profile)]], CABLE_COLORS[(i * 3) % CABLE_COLORS.length])); }
        const e = edges(body, col, dashed); g.add(e); eds.push(e);
        su.group.add(g); anchor = () => localToWorld(su.group, xc, yc + L / 2 + 0.05, zc);
      } else if (it.placement === 'rack-strips' && it.setup && S.recs.has(it.setup)) {
        // PDU = the power strips already built with the rack
        const su = S.recs.get(it.setup); g = su.group;
        const shelves = [...S.recs.values()].filter(r => r.cat === 'shelf' && r.setup === it.setup);
        shelves.forEach(sh => { meshes.push(sh.strip); sh.strip.material.emissive = new THREE.Color(col); sh.strip.material.emissiveIntensity = status === 'unknown' ? .08 : .35; sh.led.visible = status === 'active'; });
        const top = shelves.reduce((a, s) => Math.max(a, s.y), 0);
        anchor = () => localToWorld(su.group, -su.tpl.depth / 2 + 0.1, top + 0.32, 0);
      } else if (it.storage && S.recs.has(it.storage) && it.type === 'spare-chassis') {
        const st = S.recs.get(it.storage); g = new THREE.Group(); const q = Math.min(it.quantity || 1, st.trayY.length);
        for (let i = 0; i < q; i++) { const m = makeBox(0.40, 0.045, 0.44, bodyCol); m.material.opacity = op; m.position.set(0, st.trayY[i] + 0.03, 0); g.add(m); meshes.push(m); eds.push(edges(m, col, dashed)); g.add(box(0.006, 0.02, 0.36, mat('#3f3f46', { rough: .8, opacity: op, unique: true }), 0.204, st.trayY[i] + 0.03, 0)); }
        eds.forEach(e => g.add(e)); st.group.add(g); anchor = () => localToWorld(st.group, 0.3, st.trayY[q - 1] + 0.12, 0);
      } else if (it.pos && it.size) {
        const [w, d, h] = it.size; const y0 = it.y || 0; g = new THREE.Group(); g.position.set(it.pos[0], y0, it.pos[1]);
        const body = makeBox(w, h, d, bodyCol); body.position.set(0, h / 2, 0); g.add(body); meshes.push(body);
        g.add(led(w / 2 * .8, h + 0.008, d / 2 * .8, col, 0.02));
        if (it.type === 'cart') { g.add(box(w * .8, 0.02, d * .6, mat('#0b0b0e', { rough: .4, opacity: op, unique: true }), 0, h + 0.01, 0)); g.add(box(0.04, 0.5, 0.04, mat('#2f6fd6', { rough: .5, opacity: op, unique: true }), 0, h + 0.25, -d / 2 * .6)); }
        if (it.type === 'ladder') { for (let i = 1; i <= 3; i++) g.add(box(w * .9, 0.02, 0.06, mat('#9ca3af', { metal: .5, rough: .4, opacity: op, unique: true }), 0, h * i / 3.5, -d / 2 + d * i / 4)); }
        const e = edges(body, col, dashed); g.add(e); eds.push(e);
        itemsGroup.add(g); anchor = new THREE.Vector3(it.pos[0], y0 + h + 0.05, it.pos[1]);
      } else {
        // unplaced — no geometry
        S.recs.set(it.id, { id: it.id, cat: 'item', def: it, group: null, meshes: [], edges: [], status, conf: it.confidence, zone: it.zone || null, setup: it.setup || null, shelf: null, unplaced: true, item: it });
        return;
      }
      if (g && it.placement !== 'rack-strips') S.itemGroups.push(g);
      const rec = reg({ id: it.id, cat: 'item', def: it, item: it, group: g, meshes, edges: eds, status, conf: it.confidence, pconf, zone: it.zone || null, setup: it.setup || null, shelf: it.shelf || null, anchor });
      const sub = it.type === 'opt' ? (it.live?.inDcim ? `${String(it.live.state || 'unknown').toUpperCase()}${it.live.watts ? ' · ' + Math.round(it.live.watts) + 'W' : ''}${it.live.sw ? ' · ' + it.live.sw.switch + (it.live.sw.port ? '·' + it.live.sw.port : '') : ''}` : `outlet #${it.dcim?.outlet ?? '?'}`) : (it.typeLabel || it.type);
      makeLabel(rec, 'item' + (dashed ? ' low' : ''), `<span class="lp" style="background:${col}"></span>${it.type === 'opt' ? it.name : it.id}<small>${it.type === 'opt' ? it.id + ' · ' + sub : sub}</small>`);
    });
    applyFilters(); updateTelemetry();
    if (S.selected && !S.recs.has(S.selected)) closeDetail();
    else if (S.selected) select(S.selected, { keepCamera: true });
  }

  // ───────────────────────────────────────────────────────────── effective model (static JSON + overrides + live)
  function ov() { return {}; }                       // legacy — edits now mutate S.data directly
  function dcimRackOf(su) { return su.dcimRack; }
  function effStatus(def) { return def.status || 'unknown'; }
  function isDefaultOutletLabel(label) { return !label || /^(outlet\s*\d+|port\s*\d+|\s*)$/i.test(label.trim()); }
  const optKey = s => (s || '').trim().toLowerCase();

  function computeModel() {
    const d = S.data; const live = S.live; const uTopDown = (d.dcim?.uNumbering || 'top-down') === 'top-down';
    const setups = d.setups.map(s => ({ ...s, dcimRack: dcimRackOf(s) }));
    const setupByRack = {}; setups.forEach(s => { if (s.dcimRack) setupByRack[s.dcimRack] = s.id; });
    const shelvesOf = sid => d.shelves.filter(sh => sh.setup === sid).sort((a, b) => a.level - b.level);
    const shelfForU = (sid, u) => { const sh = shelvesOf(sid); if (!sh.length) return null; const n = sh.length; const idx = uTopDown ? (n - 1 - ((u - 1) % n)) : ((u - 1) % n); return sh[idx].id; };

    let items = d.items.map(it => ({ ...it, ...pickOv(it.id) }));

    if (live.connected) {
      const pdus = live.devices.filter(x => x.kind === 'pdu');
      const kvms = live.devices.filter(x => x.kind === 'kvm');
      // 1) OPT servers exactly like DcimView.servers
      const servers = new Map();
      pdus.forEach(pdu => {
        const stored = pdu.labels || {}; const liveOut = live.pdu[pdu.id]?.outlets || []; const liveByN = Object.fromEntries(liveOut.map(o => [String(o.number), o]));
        Object.entries(stored).forEach(([num, label]) => {
          if (isDefaultOutletLabel(label)) return; const key = optKey(label); if (servers.has(key)) return;
          const lo = liveByN[num];
          servers.set(key, { key, name: label.trim(), rack: live.rackOverrides[key] || pdu.rack || null, pduId: pdu.id, pduName: pdu.name, outlet: parseInt(num, 10), state: lo?.state ?? 'unknown', watts: lo?.watts ?? 0 });
        });
        liveOut.forEach(o => {
          if (isDefaultOutletLabel(o.label)) return; const key = optKey(o.label);
          if (servers.has(key)) { const e = servers.get(key); e.state = o.state; e.watts = o.watts || 0; return; }
          servers.set(key, { key, name: o.label.trim(), rack: live.rackOverrides[key] || pdu.rack || null, pduId: pdu.id, pduName: pdu.name, outlet: o.number, state: o.state, watts: o.watts || 0 });
        });
      });
      // KVM cross-reference
      const kvmIdx = {};
      kvms.forEach(k => { Object.entries(k.labels || {}).forEach(([p, lbl]) => { const key = optKey(lbl); (kvmIdx[key] = kvmIdx[key] || []).push({ kvm: k.id, kvmName: k.name, port: parseInt(p, 10), status: live.kvm[k.id]?.ports?.find(x => x.number === parseInt(p, 10))?.status }); }); });
      // U assignment per rack (rack_slots first, then sequential like buildRackRows)
      const byRack = {}; [...servers.values()].forEach(s => { (byRack[s.rack] = byRack[s.rack] || []).push(s); });
      Object.entries(byRack).forEach(([rack, list]) => {
        const order = live.rackOrder[rack] || []; const slots = live.rackSlots[rack] || {};
        list.sort((a, b) => { const ai = order.indexOf(a.key), bi = order.indexOf(b.key); if (ai === -1 && bi === -1) return a.name.localeCompare(b.name); if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });
        const used = new Set(); list.forEach(s => { if (slots[s.key] != null) { s.u = Number(slots[s.key]); used.add(s.u); } });
        let next = 1; list.forEach(s => { if (s.u == null) { while (used.has(next)) next++; s.u = next; used.add(next); next++; } s.uExplicit = slots[s.key] != null; });
      });
      // merge into items
      const jsonOpts = new Map(items.filter(i => i.type === 'opt').map(i => [i.dcim?.optKey || optKey(i.name), i]));
      const seen = new Set();
      [...servers.values()].forEach(s => {
        seen.add(s.key);
        const sid = s.rack ? setupByRack[s.rack] || null : null;
        const shelf = sid ? shelfForU(sid, s.u) : null;
        const base = jsonOpts.get(s.key) || { id: 'LIVE-' + s.key.replace(/[^a-z0-9]+/g, '-'), name: s.name, category: 'item', type: 'opt', typeLabel: 'OPT — switch under test', confidence: 'high', photos: [], notes: 'Discovered live from the DCIM backend (not in lab-data.json).', ...pickOv('LIVE-' + s.key.replace(/[^a-z0-9]+/g, '-')) };
        const it = { ...base, setup: sid, shelf, zone: sid ? setups.find(x => x.id === sid)?.zone : null,
          placementConfidence: s.uExplicit ? 'high' : 'low',
          dcim: { ...(base.dcim || {}), optKey: s.key, pdu: s.pduId, pduName: s.pduName, outlet: s.outlet, kvm: kvmIdx[s.key] || kvmIdx[s.key.split(' (')[0]] || [] },
          live: { state: s.state, watts: s.watts, rack: s.rack, u: s.u, sw: live.sw[s.key] || null, owner: live.owners[s.key] || null, inDcim: true } };
        it.unmappedRack = !!s.rack && !sid;
        items = items.filter(x => x !== jsonOpts.get(s.key)); items.push(it);
      });
      items.filter(i => i.type === 'opt' && !seen.has(i.dcim?.optKey || optKey(i.name))).forEach(i => { i.live = { inDcim: false }; i.notes = (i.notes || '') + ' ⚠ Not present in the live DCIM labels.'; });
      // 2) PDU / KVM devices
      items.forEach(i => {
        if (i.type === 'pdu' && i.dcim?.deviceId) { const dev = pdus.find(p => p.id === i.dcim.deviceId); const st = live.pdu[i.dcim.deviceId]; if (dev) { i.live = { device: dev, status: st, reachable: st?.reachable ?? null }; if (dev.rack && setupByRack[dev.rack]) { i.setup = setupByRack[dev.rack]; i.zone = setups.find(x => x.id === i.setup)?.zone; } } }
        if (i.type === 'kvm' && i.dcim?.deviceId) { const dev = kvms.find(k => k.id === i.dcim.deviceId); const st = live.kvm[i.dcim.deviceId]; if (dev) i.live = { device: dev, status: st, reachable: st?.reachable ?? null }; }
      });
      // live-only PDUs (e.g. racks added in DCIM)
      pdus.filter(p => !items.some(i => i.type === 'pdu' && i.dcim?.deviceId === p.id)).forEach(p => {
        const sid = setupByRack[p.rack] || null; const id = 'LIVE-' + p.id;
        items.push({ id, name: p.name, category: 'item', type: 'pdu', typeLabel: 'Raritan PDU (live)', setup: sid, placement: sid ? 'rack-strips' : null, zone: sid ? setups.find(x => x.id === sid)?.zone : null, status: 'active', confidence: 'high', photos: [], dcim: { deviceId: p.id, outlets: 24, labels: p.labels || {} }, live: { device: p, status: live.pdu[p.id], reachable: live.pdu[p.id]?.reachable ?? null }, notes: 'Discovered live from the DCIM backend.', ...pickOv(id) });
      });
      // 3) rack_items (custom equipment: switches, patch panels …)
      Object.entries(live.rackItems || {}).forEach(([rack, list]) => (list || []).forEach(ci => {
        const sid = setupByRack[rack] || null; const id = 'LIVE-' + ci.id;
        items.push({ id, name: ci.name, category: 'item', type: 'equip-' + (ci.type || 'other'), typeLabel: (EQUIP_LABEL[ci.type] || 'Equipment') + ' (DCIM rack item)', setup: sid, shelf: sid ? shelfForU(sid, ci.u || 1) : null, zone: sid ? setups.find(x => x.id === sid)?.zone : null, status: 'active', confidence: 'high', placementConfidence: ci.u ? 'medium' : 'low', photos: [], notes: ci.notes || '', live: { rack, u: ci.u }, ...pickOv(id) });
      }));
      // 4) chillers from DCIM
      if (live.chillers?.units?.length) {
        live.chillers.units.forEach(ch => {
          const sid = ch.rack ? setupByRack[ch.rack] : null; const existing = items.find(i => i.type === 'chiller' && i.setup === sid && !i.live);
          if (existing) existing.live = { chiller: ch }; else if (sid) items.push({ id: 'LIVE-' + ch.id, name: ch.name || 'Chiller', category: 'item', type: 'chiller', setup: sid, placement: 'bottom-bay', zone: setups.find(x => x.id === sid)?.zone, status: 'active', confidence: 'medium', photos: [], notes: 'From DCIM chillers.json', live: { chiller: ch }, ...pickOv('LIVE-' + ch.id) });
        });
      }
    }
    items.forEach(it => {
      it.effStatus = it.status || 'unknown';
      if (it.type === 'opt' && it.live?.inDcim) it.effStatus = it.live.state === 'on' ? 'active' : it.live.state === 'off' ? 'inactive' : (it.status || 'unknown');
      if (it.type === 'pdu' && it.live) it.effStatus = it.live.reachable === false ? 'inactive' : it.live.reachable ? 'active' : it.effStatus;
      if (it.type === 'kvm' && it.live) it.effStatus = it.live.reachable === false ? 'inactive' : it.live.reachable ? 'active' : it.effStatus;
      if (it.type === 'opt' && it.live && it.live.owner) it.owner = it.live.owner;
    });
    // DCIM racks without a physical setup
    const liveRacks = live.connected ? [...new Set(live.devices.filter(x => x.kind === 'pdu' || x.kind === 'rack').map(x => x.rack).filter(Boolean))] : (d.dcim?.pdus || []).map(p => p.rack);
    const unmappedRacks = liveRacks.filter(r => !setupByRack[r]);
    S.model = { setups, setupByRack, items, unmappedRacks, liveRacks };
  }
  function pickOv() { return {}; }

  // ───────────────────────────────────────────────────────────── filters / search
  function matches(rec) {
    const f = S.filters;
    if (rec.cat === 'zone') return !f.zone || rec.id === f.zone;
    if (f.zone && rec.zone !== f.zone && rec.cat !== 'structure') return false;
    if (f.setup && rec.setup !== f.setup && rec.id !== f.setup) return false;
    if (rec.cat !== 'structure' && !f.statuses.has(rec.status)) return false;
    if (f.onlyLow && !(rec.conf === 'low' || rec.pconf === 'low' || (rec.cat === 'setup' && rec.def.dcimMappingConfidence === 'low'))) return false;
    if (f.q) { const q = f.q.toLowerCase(); const nm = (rec.def.name || '').toLowerCase(); if (!rec.id.toLowerCase().includes(q) && !nm.includes(q)) return false; }
    return true;
  }
  function applyFilters() {
    const anyFilter = S.filters.zone || S.filters.setup || S.filters.onlyLow || S.filters.q || S.filters.statuses.size < STATUSES.length;
    for (const rec of S.recs.values()) {
      const ok = matches(rec); rec.filtered = anyFilter && !ok;
      const fade = rec.filtered ? 0.07 : 1;
      rec.meshes.forEach(m => { if (m.material.userData.baseOpacity == null) m.material.userData.baseOpacity = m.material.opacity; m.material.opacity = m.material.userData.baseOpacity * fade; m.material.transparent = true; });
      rec.edges.forEach(e => { e.material.opacity = (e.userData.baseOpacity ?? .9) * (rec.filtered ? 0.15 : 1); });
      if (rec.cat === 'shelf' && rec.strip) { rec.strip.material.opacity = fade; rec.led.material.opacity = fade; }
    }
    renderTree(); renderInventory(); renderUnplaced(); renderStats(); renderRackBar();
  }
  function setupFilterUI() {
    const d = S.data;
    const fz = $('#fZone'); d.zones.forEach(z => { const o = document.createElement('option'); o.value = z.id; o.textContent = `${z.id} — ${z.name}`; fz.appendChild(o); });
    const fs = $('#fSetup'); d.setups.forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.id} — ${s.name.split('—')[0].trim()}`; fs.appendChild(o); });
    fz.onchange = () => { S.filters.zone = fz.value; applyFilters(); };
    fs.onchange = () => { S.filters.setup = fs.value; applyFilters(); };
    const chips = $('#fStatus'); STATUSES.forEach(st => {
      const c = document.createElement('span'); c.className = 'chip on'; c.innerHTML = `<span class="sw" style="background:${STATUS_COLOR[st]}"></span>${STATUS_LABEL[st]}`;
      c.onclick = () => { if (S.filters.statuses.has(st)) S.filters.statuses.delete(st); else S.filters.statuses.add(st); c.classList.toggle('on', S.filters.statuses.has(st)); c.classList.toggle('off', !S.filters.statuses.has(st)); applyFilters(); };
      chips.appendChild(c);
    });
    $('#fOnlyLow').onchange = e => { S.filters.onlyLow = e.target.checked; applyFilters(); };
    $('#fClear').onclick = () => { S.filters = { zone: '', setup: '', statuses: new Set(STATUSES), onlyLow: false, q: '' }; fz.value = ''; fs.value = ''; $('#fOnlyLow').checked = false; $('#search').value = ''; $$('#fStatus .chip').forEach(c => { c.classList.add('on'); c.classList.remove('off'); }); applyFilters(); };
    // legend
    const lg = $('#legend'); lg.innerHTML = STATUSES.map(st => `<div class="li"><span class="sw" style="background:${STATUS_COLOR[st]}"></span>${STATUS_LABEL[st]}</div>`).join('') +
      `<div class="li wide"><span class="sw" style="background:#a1a1aa"></span>solid · confidence high</div><div class="li"><span class="sw faded" style="background:#a1a1aa"></span>faded · medium</div><div class="li"><span class="sw dashed"></span>dashed · low / estimated</div>` +
      `<div class="li wide"><span class="sw" style="background:${TYPE_STRIPE.opt}"></span>edge stripe: OPT</div><div class="li"><span class="sw" style="background:${TYPE_STRIPE.kvm}"></span>KVM</div><div class="li"><span class="sw" style="background:${TYPE_STRIPE.pdu}"></span>PDU</div><div class="li"><span class="sw" style="background:${TYPE_STRIPE['equip-switch']}"></span>Switch / chiller</div>`;
    // search
    const inp = $('#search'), res = $('#searchResults');
    inp.addEventListener('input', () => {
      const q = inp.value.trim(); S.filters.q = q; applyFilters();
      if (!q) { res.classList.add('hidden'); return; }
      const ql = q.toLowerCase(); const hits = [...S.recs.values()].filter(r => r.id.toLowerCase().includes(ql) || (r.def.name || '').toLowerCase().includes(ql)).slice(0, 14);
      res.innerHTML = hits.map(r => `<div class="sr" data-id="${r.id}"><span class="id">${r.id}</span><span class="nm">${esc(r.def.name || '')}</span><span class="cat">${r.cat}</span></div>`).join('') || '<div class="sr"><span class="nm muted">No matches</span></div>';
      res.classList.remove('hidden');
      $$('.sr', res).forEach(el => el.onclick = () => { if (el.dataset.id) { select(el.dataset.id); res.classList.add('hidden'); } });
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const first = $('.sr[data-id]', res); if (first) { select(first.dataset.id); res.classList.add('hidden'); } } if (e.key === 'Escape') { res.classList.add('hidden'); inp.blur(); } });
    document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) res.classList.add('hidden'); });
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ───────────────────────────────────────────────────────────── sidebar: tree / inventory / unplaced
  function recsOf(pred) { return [...S.recs.values()].filter(pred); }
  function dot(rec) { return `<span class="st ${rec.pconf === 'low' || rec.conf === 'low' ? 'low' : ''}" style="background:${STATUS_COLOR[rec.status]}"></span>`; }
  function renderTree() {
    const d = S.data; const el = $('#tree'); const open = LS.get('treeOpen', {});
    const node = (rec, cls, extra = '', depth = 0) => `<div class="tn ${rec.filtered ? 'dim' : ''} ${S.selected === rec.id ? 'sel' : ''}" data-id="${rec.id}">${dot(rec)}<span class="id ${cls}">${rec.id}</span><span class="nm">${esc(rec.def.name || '')}</span>${extra}</div>`;
    let html = '';
    d.zones.forEach(zn => {
      html += `<div class="zone-h"><span class="sw" style="background:${zn.color}"></span>${zn.id} · ${esc(zn.name)}</div>`;
      // setups in zone
      recsOf(r => r.cat === 'setup' && r.zone === zn.id).forEach(su => {
        const isOpen = open[su.id] !== false;
        html += `<div class="tn grp ${isOpen ? 'open' : ''} ${su.filtered ? 'dim' : ''} ${S.selected === su.id ? 'sel' : ''}" data-id="${su.id}" data-grp="${su.id}"><span class="caret">▶</span>${dot(su)}<span class="id">${su.id}</span><span class="nm">${esc(su.def.name)}</span><span class="tag">${esc(dcimRackOf(su.def) || '—')}</span></div>`;
        if (isOpen) {
          html += `<div class="tgroup">`;
          recsOf(r => r.cat === 'shelf' && r.setup === su.id).sort((a, b) => b.level - a.level).forEach(sh => {
            const its = recsOf(r => r.cat === 'item' && r.shelf === sh.id);
            html += `<div class="tn ${sh.filtered ? 'dim' : ''} ${S.selected === sh.id ? 'sel' : ''}" data-id="${sh.id}">${dot(sh)}<span class="id shelf">${sh.id}</span><span class="nm">L${sh.level}${its.length ? '' : ' · empty'}</span></div>`;
            its.forEach(it => { const lv = it.item.live; const tag = it.item.type === 'opt' ? (lv?.inDcim ? `<span class="tag ${lv.state === 'on' ? 'on' : lv.state === 'off' ? 'offp' : ''}">${lv.state}</span>${lv.sw ? `<span class="tag sw">${esc(lv.sw.switch)}${lv.sw.port ? '·' + lv.sw.port : ''}</span>` : ''}` : `<span class="tag">#${it.item.dcim?.outlet ?? '?'}</span>`) : `<span class="tag">${esc(it.item.type)}</span>`; html += `<div class="tgroup">${node(it, 'item', tag)}</div>`; });
          });
          recsOf(r => r.cat === 'item' && r.setup === su.id && !r.shelf).forEach(it => { html += node(it, 'item', `<span class="tag">${esc(it.item.placement === 'side-mount' ? 'side · ' + (it.item.side || 'right') : it.item.type)}</span>`); });
          html += `</div>`;
        }
      });
      recsOf(r => r.cat === 'storage' && r.zone === zn.id).forEach(st => {
        html += `<div class="tn ${st.filtered ? 'dim' : ''} ${S.selected === st.id ? 'sel' : ''}" data-id="${st.id}">${dot(st)}<span class="id" style="color:#c4b5fd">${st.id}</span><span class="nm">${esc(st.def.name)}</span></div>`;
        recsOf(r => r.cat === 'item' && r.item?.storage === st.id).forEach(it => { html += `<div class="tgroup">${node(it, 'item', `<span class="tag">×${it.item.quantity || 1}</span>`)}</div>`; });
      });
      recsOf(r => r.cat === 'item' && r.zone === zn.id && !r.setup && !r.item?.storage && !r.unplaced).forEach(it => { html += node(it, 'item', `<span class="tag">${esc(it.item.type)}</span>`); });
    });
    html += `<div class="zone-h"><span class="sw" style="background:#52525b"></span>Structure</div>`;
    recsOf(r => r.cat === 'structure').forEach(r => { html += node(r, 'item', `<span class="tag">${r.conf}</span>`); });
    el.innerHTML = html;
    $$('.tn', el).forEach(n => n.onclick = e => {
      const id = n.dataset.id;
      if (n.dataset.grp && (e.target.classList.contains('caret'))) { const o = LS.get('treeOpen', {}); o[id] = !(o[id] !== false); LS.set('treeOpen', o); renderTree(); return; }
      select(id);
    });
  }
  function renderInventory() {
    const el = $('#inv'); const rows = [...S.recs.values()].filter(r => r.cat !== 'zone').sort((a, b) => a.id.localeCompare(b.id));
    el.innerHTML = `<div class="inv-row inv-h"><span>ID</span><span>Name</span><span style="text-align:right">Where</span></div>` + rows.map(r => `<div class="inv-row ${r.filtered ? 'dim' : ''}" data-id="${r.id}"><span class="id">${dot(r)} ${r.id}</span><span class="nm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.def.name || '')}</span><span class="loc">${r.shelf || r.setup || r.item?.storage || r.zone || (r.unplaced ? '—' : 'room')}</span></div>`).join('');
    $$('.inv-row[data-id]', el).forEach(n => n.onclick = () => select(n.dataset.id));
  }
  function renderUnplaced() {
    const el = $('#unplaced'); const list = [...S.recs.values()].filter(r => r.unplaced); const m = S.model;
    let html = '';
    if (m.unmappedRacks.length) html += `<div class="zone-h">DCIM racks without a physical setup</div>` + m.unmappedRacks.map(r => `<div class="tn"><span class="st" style="background:#fbbf24"></span><span class="id">${esc(r)}</span><span class="nm muted">assign it to a SETUP via the setup panel</span></div>`).join('');
    if (list.length) html += `<div class="zone-h">Items with no position</div>` + list.map(r => `<div class="tn" data-id="${r.id}">${dot(r)}<span class="id item">${r.id}</span><span class="nm">${esc(r.def.name)}</span><span class="tag">${esc(r.item.type)}</span></div>`).join('');
    if (!html) html = `<div class="muted small" style="padding:8px">Everything is placed.</div>`;
    el.innerHTML = html; $('#unplacedCount').textContent = list.length + m.unmappedRacks.length;
    $$('.tn[data-id]', el).forEach(n => n.onclick = () => select(n.dataset.id));
  }
  function renderStats() {
    const recs = [...S.recs.values()]; const items = S.model.items;
    const opts = items.filter(i => i.type === 'opt'); const on = opts.filter(i => i.live?.state === 'on').length; const off = opts.filter(i => i.live?.state === 'off').length;
    const low = recs.filter(r => r.conf === 'low' || r.pconf === 'low').length;
    let kw = 0, temps = []; Object.values(S.live.pdu).forEach(st => { kw += st?.total_watts || 0; if (st?.temperature != null) temps.push(st.temperature); });
    const live = S.live.connected;
    $('#stats').innerHTML = [
      `<span class="st">Setups <b>${S.data.setups.length}</b></span>`,
      `<span class="st">Shelves <b>${S.data.shelves.length}</b></span>`,
      `<span class="st">OPTs <b class="nv">${opts.length}</b>${live ? ` <span>on <b class="nv">${on}</b> · off <b>${off}</b></span>` : ''}</span>`,
      `<span class="st">Items <b>${items.length}</b></span>`,
      `<span class="st">Low-confidence objects <b class="${low ? 'warn' : ''}">${low}</b></span>`,
      live ? `<span class="st">Floor draw <b class="nv">${(kw / 1000).toFixed(2)} kW</b></span>` : `<span class="st muted">connect the backend for live power / state</span>`,
      temps.length ? `<span class="st">Temp <b class="${Math.max(...temps) > 24 ? 'warn' : ''}">${Math.min(...temps).toFixed(0)}–${Math.max(...temps).toFixed(0)}°C</b></span>` : '',
      S.model.unmappedRacks.length ? `<span class="st">Unmapped DCIM racks <b class="warn">${S.model.unmappedRacks.join(', ')}</b></span>` : '',
    ].join('');
  }

  // ───────────────────────────────────────────────────────────── selection & detail panel
  function anchorOf(rec) { if (!rec.anchor) return null; return typeof rec.anchor === 'function' ? rec.anchor() : rec.anchor; }
  function select(id, opts = {}) {
    const rec = S.recs.get(id); if (!rec) return;
    S.selected = id;
    if (selectionHelper) { scene.remove(selectionHelper); selectionHelper = null; }
    if (rec.group) {
      const b = new THREE.Box3(); rec.meshes.forEach(m => b.expandByObject(m)); if (rec.cat === 'setup' || rec.cat === 'storage') b.setFromObject(rec.group);
      if (!b.isEmpty()) { b.expandByScalar(0.02); selectionHelper = new THREE.Box3Helper(b, new THREE.Color('#76b900')); selectionHelper.material.transparent = true; selectionHelper.material.opacity = .95; scene.add(selectionHelper); }
      if (!opts.keepCamera && opts.fly !== false) flyTo(rec);
    }
    $$('.lbl.sel').forEach(l => l.classList.remove('sel')); if (rec.label) rec.label.classList.add('sel');
    if (S.editMode) renderEditor(rec); else renderDetail(rec); renderTree(); renderRackBar();
    $('#detail').classList.remove('hidden'); resize();
  }
  function closeDetail() { S.selected = null; if (selectionHelper) { scene.remove(selectionHelper); selectionHelper = null; } $('#detail').classList.add('hidden'); $$('.lbl.sel').forEach(l => l.classList.remove('sel')); renderTree(); resize(); }
  $('#dClose').onclick = closeDetail;
  $('#dFocus').onclick = () => { const r = S.recs.get(S.selected); if (r) flyTo(r, true); };

  function confPill(c) { return `<span class="pill conf-${c}"><span class="sw" style="background:currentColor"></span>${c}</span>`; }
  function statusPill(st) { return `<span class="pill" style="color:${STATUS_COLOR[st]};border-color:${STATUS_COLOR[st]}66;background:${STATUS_COLOR[st]}14"><span class="sw" style="background:${STATUS_COLOR[st]}"></span>${STATUS_LABEL[st]}</span>`; }
  const PHOTO_SRC = n => (window.LAB_PHOTOS && window.LAB_PHOTOS[n]) || `photos/photo-0${n}.jpg`;
  function photosHtml(list) {
    if (!list || !list.length) return `<div class="note muted">No photo shows this object directly (from DCIM data).</div>`;
    return `<div class="photos">${list.map(n => `<a href="${PHOTO_SRC(n)}" target="_blank" title="${esc(S.data.meta.photoIndex[n] || '')}"><img src="${PHOTO_SRC(n)}" alt="photo ${n}"/><div class="pn">photo ${n}</div></a>`).join('')}</div>`;
  }
  function link(id, text) { return `<a data-go="${id}">${esc(text || id)}</a>`; }
  function locationOf(rec) {
    const parts = [];
    if (rec.zone) { const z = S.data.zones.find(x => x.id === rec.zone); parts.push(link(rec.zone, z ? `${z.id} — ${z.name}` : rec.zone)); }
    if (rec.setup && rec.cat !== 'setup') { const su = S.recs.get(rec.setup); parts.push(link(rec.setup, su ? `${su.id} (${dcimRackOf(su.def) || 'unmapped'})` : rec.setup)); }
    if (rec.shelf) { const sh = S.recs.get(rec.shelf); parts.push(link(rec.shelf, sh ? `${sh.id} · level L${sh.level}` : rec.shelf)); }
    if (rec.item?.placement === 'bottom-bay') parts.push('bottom bay (floor)');
    if (rec.item?.storage) parts.push(link(rec.item.storage));
    const a = anchorOf(rec); if (a) parts.push(`<span class="mono muted">x ${a.x.toFixed(2)} · z ${a.z.toFixed(2)} m</span>`);
    return parts.join('<br/>') || '—';
  }

  function renderDetail(rec) {
    const def = rec.def; const it = rec.item;
    $('#dId').textContent = rec.id; $('#dName').textContent = def.name || rec.id;
    let html = '';
    const o = ov(rec.id);
    // status / identity
    html += `<div class="sec"><div class="sec-h">Identity</div><div class="kv">
      <span class="k">Category</span><span class="v">${rec.cat}${it?.typeLabel ? ' · ' + esc(it.typeLabel) : it?.type ? ' · ' + esc(it.type) : def.type ? ' · ' + esc(def.type) : ''}</span>
      <span class="k">Status</span><span class="v">${statusPill(rec.status)}${it?.live?.inDcim ? ` <span class="pill live-${it.live.state === 'on' ? 'on' : it.live.state === 'off' ? 'off' : 'unk'}">${it.live.state}${it.live.watts ? ' · ' + Math.round(it.live.watts) + ' W' : ''}</span>` : ''}</span>
      <span class="k">Confidence</span><span class="v">${confPill(rec.conf || 'medium')}${rec.pconf && rec.pconf !== rec.conf ? ` <span class="muted small">placement:</span> ${confPill(rec.pconf)}` : ''}${rec.cat === 'setup' && def.dcimMappingConfidence ? ` <span class="muted small">DCIM mapping:</span> ${confPill(ov(rec.id).dcimRack !== undefined ? 'medium' : def.dcimMappingConfidence)}` : ''}</span>
      <span class="k">Owner</span><span class="v">${esc(it?.owner || def.owner || '—')}${it?.live?.owner ? ' <span class="muted small">(DCIM)</span>' : ''}</span>
      <span class="k">Location</span><span class="v">${locationOf(rec)}</span>
      ${rec.cat === 'setup' ? `<span class="k">Setup</span><span class="v mono">${rec.id}</span>` : rec.setup ? `<span class="k">Setup</span><span class="v mono">${link(rec.setup)}</span>` : ''}
    </div></div>`;

    // ── OPT controls
    if (it?.type === 'opt') {
      const dc = it.dcim || {}; const live = S.live.connected;
      const kv = (dc.kvm || []);
      html += `<div class="sec"><div class="sec-h">Connections <span class="muted" style="font-weight:400;letter-spacing:0;text-transform:none">${live ? 'live · DCIM' : 'from DCIM seed (static)'}</span></div><div class="kv">
        <span class="k">PDU outlet</span><span class="v mono">${dc.pduName ? link(pduItemId(dc.pdu), dc.pduName) : '—'} · <b>#${dc.outlet ?? '?'}</b></span>
        <span class="k">KVM port</span><span class="v">${kv.length ? kv.map(k => `<span class="pill kvm-pill">${esc(k.kvmName)} · port ${k.port}${k.status ? ' · ' + k.status : ''}</span>`).join(' ') : '<span class="muted">none</span>'}</span>
        <span class="k">Network switch</span><span class="v">${it.live?.sw?.switch ? `<span class="pill sw-pill">${esc(it.live.sw.switch)}${it.live.sw.port ? ' · port ' + it.live.sw.port : ''}</span>` : `<span class="muted">${live ? 'not assigned in DCIM' : 'needs backend (switch_assignments.json is runtime data)'}</span>`}</span>
        <span class="k">DCIM rack / U</span><span class="v mono">${it.live?.rack ? `${esc(it.live.rack)} · U${String(it.live.u).padStart(2, '0')}${it.placementConfidence === 'low' ? ' <span class="muted">(auto)</span>' : ''}` : (S.recs.get(rec.setup)?.def ? dcimRackOf(S.recs.get(rec.setup).def) : '—')}</span>
      </div></div>`;
      html += `<div class="sec"><div class="sec-h">Power control</div>
        <div class="ctl-row">
          <button class="btn btn-on" data-pw="on" ${live ? '' : 'disabled'}>Power On</button>
          <button class="btn btn-off" data-pw="off" ${live ? '' : 'disabled'}>Power Off</button>
          <button class="btn btn-cycle" data-pw="cycle" ${live ? '' : 'disabled'}>Cycle</button>
        </div>
        ${kv.length ? `<div class="ctl-row" style="margin-top:6px">${kv.map(k => `<button class="btn btn-kvm" data-kvm="${esc(k.kvm)}" data-port="${k.port}" ${live ? '' : 'disabled'}>Open KVM console · ${esc(k.kvmName)} p${k.port}</button>`).join('')}</div>` : ''}
        ${live ? '' : '<div class="note muted" style="margin-top:8px">Connect the Lab Manager backend (⚙ Backend) to enable outlet control and KVM console — exactly the same API calls as the DCIM UI.</div>'}
        ${it.unmappedRack ? `<div class="warn-box" style="margin-top:8px">This OPT lives in DCIM rack <b>${esc(it.live.rack)}</b> which is not mapped to a physical SETUP yet.</div>` : ''}
      </div>`;
    }
    // ── PDU
    if (it?.type === 'pdu') {
      const st = it.live?.status; const live = S.live.connected; const labels = it.dcim?.labels || it.live?.device?.labels || {};
      const outlets = st?.outlets?.length ? st.outlets : Array.from({ length: it.dcim?.outlets || 24 }, (_, i) => ({ number: i + 1, label: labels[String(i + 1)] || `Outlet ${i + 1}`, state: 'unknown', watts: 0 }));
      html += `<div class="sec"><div class="sec-h">Outlets <span class="muted" style="font-weight:400;letter-spacing:0;text-transform:none">${live ? (st?.reachable === false ? `<span style="color:#fda4af">unreachable</span>` : st ? `${outlets.filter(x => x.state === 'on').length}/${outlets.length} on · ${((st.total_watts || 0) / 1000).toFixed(2)} kW` : 'loading…') : 'static labels · click needs backend'}</span></div>
        <div class="ogrid">${outlets.map(x => { const named = !isDefaultOutletLabel(x.label); const cls = x.state === 'unknown' ? 'unknown' : `${x.state} ${named ? 'named' : 'free'}`; return `<div class="ocell ${cls}" data-outlet="${x.number}" title="${esc(x.label)}"><span class="n">#${x.number}</span><span class="l">${named ? esc(x.label) : '—'}</span>${x.watts ? `<span class="w">${Math.round(x.watts)} W</span>` : ''}</div>`; }).join('')}</div>
        ${st?.temperature != null || st?.humidity != null ? `<div class="kv" style="margin-top:8px"><span class="k">Environment</span><span class="v">${st.temperature != null ? `🌡 ${st.temperature.toFixed(1)} °C` : ''} ${st.humidity != null ? `· 💧 ${st.humidity.toFixed(0)} %` : ''} ${st.leak_detected ? '<span style="color:#fda4af">· ⚠ leak</span>' : ''}</span></div>` : ''}
        ${st?.error ? `<div class="err-box" style="margin-top:8px">⚠ ${esc(st.error)}</div>` : ''}
      </div>`;
    }
    // ── KVM
    if (it?.type === 'kvm') {
      const st = it.live?.status; const live = S.live.connected; const labels = it.dcim?.labels || it.live?.device?.labels || {}; const n = it.dcim?.ports || it.live?.device?.port_count || 8;
      const ports = st?.ports?.length ? st.ports : Array.from({ length: n }, (_, i) => ({ number: i + 1, label: labels[String(i + 1)] || `Port ${i + 1}`, status: labels[String(i + 1)] ? 'idle' : 'empty' }));
      html += `<div class="sec"><div class="sec-h">Ports <span class="muted" style="font-weight:400;letter-spacing:0;text-transform:none">${live ? (st?.reachable === false ? '<span style="color:#fda4af">unreachable</span>' : 'click a port to open the console') : 'static labels'}</span></div>
        <div class="ogrid ${n <= 8 ? 'k8' : ''}">${ports.map(p => `<div class="ocell ${p.status}${p.in_use ? ' hl' : ''}" data-kport="${p.number}" title="${esc(p.label)}"><span class="n">p${p.number}</span><span class="l">${isDefaultOutletLabel(p.label) ? '—' : esc(p.label)}</span>${p.in_use ? '<span class="w">IN USE</span>' : ''}</div>`).join('')}</div></div>`;
    }
    // ── Setup: mapping + contents
    if (rec.cat === 'setup') {
      const racks = [...new Set([...(S.data.dcim?.pdus || []).map(p => p.rack), ...S.model.liveRacks])].filter(Boolean).sort();
      const cur = dcimRackOf(def) || '';
      html += `<div class="sec"><div class="sec-h">DCIM rack mapping</div><div class="edit-grid">
        <span>Rack in DCIM</span><select id="dRack"><option value="">— none —</option>${racks.map(r => `<option value="${esc(r)}" ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
      </div><div class="note muted" style="margin-top:6px">The photos do not show which physical rack is which DCIM rack. Change it here (saved in this browser) and use <b>Export JSON</b> to persist into lab-data.json.</div></div>`;
      const shelves = recsOf(r => r.cat === 'shelf' && r.setup === rec.id).sort((a, b) => b.level - a.level);
      html += `<div class="sec"><div class="sec-h">Shelves — what is on each level</div>` + shelves.map(sh => {
        const its = recsOf(r => r.cat === 'item' && r.shelf === sh.id);
        return `<div class="srow" data-go="${sh.id}"><span class="stripe" style="background:${STATUS_COLOR[sh.status]}"></span><span class="lvl">L${sh.level}</span><span class="nm" style="font-weight:500;color:#d4d4d8">${sh.id}</span><span class="sub">${its.length ? its.map(i => esc(i.item.name)).join(', ') : 'empty'}</span></div>`;
      }).join('') + `</div>`;
      const bay = recsOf(r => r.cat === 'item' && r.setup === rec.id && !r.shelf);
      if (bay.length) html += `<div class="sec"><div class="sec-h">Rack-level equipment</div>${bay.map(i => `<div class="srow" data-go="${i.id}"><span class="stripe" style="background:${STATUS_COLOR[i.status]}"></span><span class="nm">${esc(i.item.name)}</span><span class="sub">${esc(i.item.type)}</span></div>`).join('')}</div>`;
    }
    // ── Shelf contents
    if (rec.cat === 'shelf') {
      const its = recsOf(r => r.cat === 'item' && r.shelf === rec.id);
      html += `<div class="sec"><div class="sec-h">On this shelf</div>${its.length ? its.map(i => { const lv = i.item.live; return `<div class="srow" data-go="${i.id}"><span class="stripe" style="background:${STATUS_COLOR[i.status]}"></span><span class="nm">${esc(i.item.name)}</span><span class="sub">${i.item.type === 'opt' ? `#${i.item.dcim?.outlet ?? '?'}${lv?.sw ? ' · ' + esc(lv.sw.switch) + (lv.sw.port ? '·' + lv.sw.port : '') : ''}` : esc(i.item.type)}</span>${lv?.inDcim ? `<span class="stt ${lv.state === 'on' ? 'on' : lv.state === 'off' ? 'off' : 'unk'}">${lv.state}</span>` : ''}</div>`; }).join('') : '<div class="note muted">Nothing assigned to this shelf.</div>'}
        <div class="note muted" style="margin-top:6px">Shelf → OPT assignment comes from DCIM <code>rack_slots</code> when connected; otherwise a provisional top-down fill by outlet number.</div></div>`;
    }
    // ── Storage contents
    if (rec.cat === 'storage') {
      const its = recsOf(r => r.cat === 'item' && r.item?.storage === rec.id);
      if (its.length) html += `<div class="sec"><div class="sec-h">Contents</div>${its.map(i => `<div class="srow" data-go="${i.id}"><span class="stripe" style="background:${STATUS_COLOR[i.status]}"></span><span class="nm">${esc(i.item.name)}</span><span class="sub">×${i.item.quantity || 1}</span></div>`).join('')}</div>`;
    }
    // ── Edit (mutates lab-data.json in memory → Save to server / Download)
    const isLive = rec.id.startsWith('LIVE-');
    if (rec.cat === 'item' && isLive) {
      html += `<div class="sec"><div class="sec-h">Edit</div><div class="note muted">This object comes live from the DCIM backend (labels / rack items). Rename or move it in Lab Manager. To keep a physical record of it in the twin (photos, notes, exact shelf), add it to lab-data.json:</div>
        <div class="ctl-row" style="margin-top:8px"><button class="btn btn-xs" id="eMaterialize">+ Add a copy to lab-data.json</button></div></div>`;
    } else if (rec.cat === 'item') {
      const TYPES = ['opt', 'kvm', 'pdu', 'chiller', 'equip-switch', 'equip-patchpanel', 'equip-ups', 'equip-other', 'spare-chassis', 'cart', 'ladder', 'toolbox', 'misc', 'other'];
      const locVal = it.setup ? 'setup:' + it.setup : it.storage ? 'storage:' + it.storage : '';
      const shelvesOf = sid => S.data.shelves.filter(x => x.setup === sid).sort((a, b) => b.level - a.level);
      const shelfOpts = sid => `<option value="">— free / rack level —</option>` + shelvesOf(sid).map(x => `<option value="shelf:${x.id}" ${it.shelf === x.id ? 'selected' : ''}>${x.id} · L${x.level}</option>`).join('') + `<option value="bottom-bay" ${it.placement === 'bottom-bay' ? 'selected' : ''}>bottom bay (floor)</option><option value="side-right" ${it.placement === 'side-mount' && it.side !== 'left' ? 'selected' : ''}>hung on the right side</option><option value="side-left" ${it.placement === 'side-mount' && it.side === 'left' ? 'selected' : ''}>hung on the left side</option><option value="rack-strips" ${it.placement === 'rack-strips' ? 'selected' : ''}>power strips (PDU)</option>`;
      const pdus = S.data.dcim?.pdus || [];
      html += `<div class="sec"><div class="sec-h">Edit item <span class="muted" style="font-weight:400;letter-spacing:0;text-transform:none">changes → Save</span></div><div class="edit-grid">
        <span>Name</span><input id="eName" value="${esc(it.name || '')}" />
        <span>Type</span><select id="eType">${TYPES.map(t => `<option value="${t}" ${it.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <span>Type label</span><input id="eTypeLabel" value="${esc(it.typeLabel || '')}" placeholder="e.g. Spectrum-4 SN5600 under test" />
        <span>Status</span><select id="eStatus">${STATUSES.map(x => `<option value="${x}" ${(it.status || 'unknown') === x ? 'selected' : ''}>${STATUS_LABEL[x]}</option>`).join('')}</select>
        <span>Owner</span><input id="eOwner" value="${esc(it.owner || '')}" placeholder="engineer" />
        <span>Confidence</span><select id="eConf">${['high', 'medium', 'low'].map(x => `<option value="${x}" ${(it.confidence || 'medium') === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <span>Location</span><select id="eLoc"><option value="">— free position —</option>${S.data.setups.map(x => `<option value="setup:${x.id}" ${locVal === 'setup:' + x.id ? 'selected' : ''}>${x.id} · ${esc(x.name.split('—')[0].replace('Rack', '').trim())}</option>`).join('')}${S.data.storage.map(x => `<option value="storage:${x.id}" ${locVal === 'storage:' + x.id ? 'selected' : ''}>${x.id} · ${esc(x.name)}</option>`).join('')}</select>
        <span>Shelf</span><select id="eShelf" ${it.setup ? '' : 'disabled'}>${it.setup ? shelfOpts(it.setup) : '<option value="">—</option>'}</select>
        <span>Free pos x, z</span><div style="display:flex;gap:6px"><input id="eX" type="number" step="0.05" value="${it.pos ? it.pos[0] : ''}" placeholder="x m" ${it.setup || it.storage ? 'disabled' : ''}/><input id="eZ" type="number" step="0.05" value="${it.pos ? it.pos[1] : ''}" placeholder="z m" ${it.setup || it.storage ? 'disabled' : ''}/></div>
        <span>Size w, d, h</span><div style="display:flex;gap:6px"><input id="eW" type="number" step="0.05" value="${it.size ? it.size[0] : ''}" placeholder="w"/><input id="eD" type="number" step="0.05" value="${it.size ? it.size[1] : ''}" placeholder="d"/><input id="eH" type="number" step="0.05" value="${it.size ? it.size[2] : ''}" placeholder="h"/></div>
        <span>PDU / outlet</span><div style="display:flex;gap:6px"><select id="ePdu"><option value="">—</option>${pdus.map(x => `<option value="${x.id}" ${it.dcim?.pdu === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select><input id="eOutlet" type="number" min="1" max="48" value="${it.dcim?.outlet ?? ''}" placeholder="#" style="width:64px"/></div>
      </div>
      <textarea id="eNotes" placeholder="notes…" style="margin-top:6px">${esc(it.notes || '')}</textarea>
      <div class="ctl-row" style="margin-top:8px"><button class="btn btn-primary" id="eSave">Save item</button><button class="btn btn-xs" id="eDup">Duplicate</button><button class="btn btn-off" id="eDel">Delete</button></div></div>`;
    } else if (rec.cat === 'setup' || rec.cat === 'shelf' || rec.cat === 'storage') {
      html += `<div class="sec"><div class="sec-h">Edit</div><div class="edit-grid">
        <span>Name</span><input id="eName" value="${esc(def.name || '')}" />
        <span>Status</span><select id="eStatus">${STATUSES.map(x => `<option value="${x}" ${(def.status || 'unknown') === x ? 'selected' : ''}>${STATUS_LABEL[x]}</option>`).join('')}</select>
        <span>Owner</span><input id="eOwner" value="${esc(def.owner || '')}" placeholder="engineer" />
      </div><textarea id="eNotes" placeholder="notes…" style="margin-top:6px">${esc(def.notes || '')}</textarea>
      <div class="ctl-row" style="margin-top:8px"><button class="btn btn-primary" id="eSave">Save</button>${rec.cat === 'shelf' ? `<button class="btn btn-xs" id="eAddHere">+ Add item on this shelf</button>` : rec.cat === 'setup' ? `<button class="btn btn-xs" id="eAddBay">+ Add rack-level item</button>` : ''}</div></div>`;
    } else if (def.notes) html += `<div class="sec"><div class="sec-h">Notes</div><div class="note">${esc(def.notes)}</div></div>`;
    // ── Source photos & drawings
    html += `<div class="sec"><div class="sec-h">Source photos</div>${photosHtml(def.photos)}${rec.tpl?.source ? `<div class="note muted" style="margin-top:6px">Dimensions: ${esc(rec.tpl.source)}</div>` : ''}</div>`;
    $('#dBody').innerHTML = html;

    // handlers
    $$('[data-go]', $('#dBody')).forEach(el => el.onclick = e => { e.preventDefault(); select(el.dataset.go); });
    $$('[data-pw]', $('#dBody')).forEach(b => b.onclick = () => outletAction(it.dcim.pdu, it.dcim.outlet, b.dataset.pw, b));
    $$('[data-kvm]', $('#dBody')).forEach(b => b.onclick = () => openKvm(b.dataset.kvm, parseInt(b.dataset.port, 10)));
    $$('[data-outlet]', $('#dBody')).forEach(c => c.onclick = e => outletMenu(e, it, parseInt(c.dataset.outlet, 10)));
    $$('[data-kport]', $('#dBody')).forEach(c => c.onclick = () => { if (!S.live.connected) { toast('Connect the backend to open the KVM console', 'err'); return; } openKvm(it.dcim.deviceId, parseInt(c.dataset.kport, 10)); });
    const dr = $('#dRack'); if (dr) dr.onchange = () => { patchDef(rec.id, { dcimRack: dr.value || null, dcimMappingConfidence: 'medium' }); rebuildAll(); toast(`${rec.id} → ${dr.value || 'no DCIM rack'}`, 'ok'); };
    const eLoc = $('#eLoc'); if (eLoc) eLoc.onchange = () => { const v = eLoc.value; const sh = $('#eShelf'); const free = !v; ['#eX', '#eZ'].forEach(q => { $(q).disabled = !free; }); if (v.startsWith('setup:')) { sh.disabled = false; sh.innerHTML = `<option value="">— free / rack level —</option>` + S.data.shelves.filter(x => x.setup === v.slice(6)).sort((a, b) => b.level - a.level).map(x => `<option value="shelf:${x.id}">${x.id} · L${x.level}</option>`).join('') + `<option value="bottom-bay">bottom bay (floor)</option><option value="side-right">hung on the right side</option><option value="side-left">hung on the left side</option><option value="rack-strips">power strips (PDU)</option>`; } else { sh.disabled = true; sh.innerHTML = '<option value="">—</option>'; } };
    const eSave = $('#eSave'); if (eSave) eSave.onclick = () => {
      const patch = { name: $('#eName').value.trim() || def.name, status: $('#eStatus').value, owner: $('#eOwner').value.trim() || null, notes: $('#eNotes').value };
      if (rec.cat === 'item') {
        patch.type = $('#eType').value; patch.typeLabel = $('#eTypeLabel').value.trim() || undefined; patch.confidence = $('#eConf').value || it.confidence || 'medium';
        const loc = $('#eLoc').value, shv = $('#eShelf').value;
        patch.setup = null; patch.shelf = null; patch.storage = undefined; patch.placement = undefined; patch.zone = null;
        if (loc.startsWith('setup:')) { patch.setup = loc.slice(6); patch.zone = S.data.setups.find(x => x.id === patch.setup)?.zone || null; if (shv.startsWith('shelf:')) patch.shelf = shv.slice(6); else if (shv.startsWith('side-')) { patch.placement = 'side-mount'; patch.side = shv.slice(5); patch.mountHeight = it.mountHeight || 1.45; } else if (shv) patch.placement = shv; }
        else if (loc.startsWith('storage:')) { patch.storage = loc.slice(8); patch.zone = S.data.storage.find(x => x.id === patch.storage)?.zone || null; }
        else { const x = parseFloat($('#eX').value), z = parseFloat($('#eZ').value); if (!isNaN(x) && !isNaN(z)) { patch.pos = [x, z]; patch.zone = zoneAt(x, z); } }
        const w = parseFloat($('#eW').value), dd = parseFloat($('#eD').value), h = parseFloat($('#eH').value); if (!isNaN(w) && !isNaN(dd) && !isNaN(h)) patch.size = [w, dd, h]; else if (!patch.setup && !patch.storage && patch.pos) patch.size = it.size || [0.5, 0.5, 0.5];
        const pdu = $('#ePdu').value, outlet = parseInt($('#eOutlet').value, 10);
        if (pdu) { const pd = (S.data.dcim?.pdus || []).find(x => x.id === pdu); patch.dcim = { ...(it.dcim || {}), pdu, pduName: pd?.name, outlet: isNaN(outlet) ? undefined : outlet, optKey: optKey(patch.name) }; } else if (it.dcim && !pdu) { const { pdu: _p, pduName: _n, outlet: _o, ...rest } = it.dcim; patch.dcim = Object.keys(rest).length ? rest : undefined; }
        patch.placementConfidence = 'high';
      }
      patchDef(rec.id, patch); rebuildAll(); toast('Saved in the twin — press “Save to server” to persist', 'ok'); select(rec.id, { keepCamera: true });
    };
    const eDup = $('#eDup'); if (eDup) eDup.onclick = () => { const c = JSON.parse(JSON.stringify(S.data.items.find(x => x.id === rec.id))); c.id = nextItemId(); c.name = c.name + ' (copy)'; S.data.items.push(c); markDirty(); rebuildAll(); select(c.id, { keepCamera: true }); };
    const eDel = $('#eDel'); if (eDel) eDel.onclick = () => { if (!confirm(`Delete ${rec.id} — ${def.name}?`)) return; deleteItem(rec.id); };
    const eAdd = $('#eAddHere'); if (eAdd) eAdd.onclick = () => addItem({ setup: def.setup, shelf: def.id, zone: def.zone, type: 'opt', typeLabel: 'OPT — switch under test', name: 'New OPT', status: 'building' });
    const eBay = $('#eAddBay'); if (eBay) eBay.onclick = () => addItem({ setup: def.id, placement: 'bottom-bay', zone: def.zone, type: 'chiller', name: 'New rack-level item', status: 'building' });
    const eMat = $('#eMaterialize'); if (eMat) eMat.onclick = () => { const c = { id: nextItemId(), name: it.name, category: 'item', type: it.type, typeLabel: it.typeLabel, setup: it.setup || null, shelf: it.shelf || null, placement: it.placement, zone: it.zone || null, status: it.status || 'active', owner: it.owner || null, confidence: 'high', placementConfidence: 'medium', photos: [], notes: 'Added from live DCIM data.', dcim: it.dcim ? { optKey: it.dcim.optKey, pdu: it.dcim.pdu, pduName: it.dcim.pduName, outlet: it.dcim.outlet, deviceId: it.dcim.deviceId } : undefined }; S.data.items.push(c); markDirty(); rebuildAll(); select(c.id, { keepCamera: true }); };
  }
  // ── data editing helpers
  function findDef(id) { const d = S.data; return d.setups.find(x => x.id === id) || d.shelves.find(x => x.id === id) || d.storage.find(x => x.id === id) || d.items.find(x => x.id === id) || null; }
  function patchDef(id, patch) { const def = findDef(id); if (!def) return false; Object.entries(patch).forEach(([k, v]) => { if (v === undefined) delete def[k]; else def[k] = v; }); markDirty(); return true; }
  function nextItemId() { let n = 0; S.data.items.forEach(i => { const m = /^ITEM-(\d+)$/.exec(i.id); if (m) n = Math.max(n, +m[1]); }); return 'ITEM-' + String(n + 1).padStart(4, '0'); }
  function zoneAt(x, z) { const zn = S.data.zones.find(q => x >= q.bounds[0] && x <= q.bounds[2] && z >= q.bounds[1] && z <= q.bounds[3]); return zn ? zn.id : null; }
  function addItem(partial) { const it = { id: nextItemId(), name: 'New item', category: 'item', type: 'other', status: 'unknown', owner: null, confidence: 'high', placementConfidence: 'high', photos: [], notes: '', ...partial }; S.data.items.push(it); markDirty(); rebuildAll(); select(it.id, { keepCamera: true }); toast(`${it.id} added — fill in the details and Save`, 'ok'); }
  function deleteItem(id) { S.data.items = S.data.items.filter(i => i.id !== id); markDirty(); closeDetail(); rebuildAll(); toast(`${id} deleted`, 'ok'); }
  function dataFingerprint(d) { const str = JSON.stringify({ m: d.meta && d.meta.generated, v: d.meta && d.meta.version, s: d.setups.map(x => x.id + x.dcimRack), sh: d.shelves.map(x => x.id), i: d.items.map(x => x.id + (x.shelf || '') + (x.placement || '')) }); let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return str.length + ':' + h; }
  function markDirty() { S.dirty = true; S.data.meta.modified = new Date().toISOString(); LS.set('draft', { savedAt: Date.now(), base: S.dataBase, data: S.data }); updateSaveBar(); }
  function updateSaveBar() { const bar = $('#saveBar'); if (!bar) return; bar.classList.toggle('hidden', !S.dirty); $('#sbSave').disabled = !location.protocol.startsWith('http'); $('#sbSave').title = location.protocol.startsWith('http') ? 'PUT /api/twin-data (writes lab-twin/lab-data.json on the server)' : 'Only available when served from the Lab Manager backend'; }
  async function saveToServer() {
    const b = $('#sbSave'); b.disabled = true; b.innerHTML = '<span class="busy"></span> Saving…';
    try { await api('/api/twin-data', { method: 'PUT', body: JSON.stringify(S.data) }); S.dirty = false; LS.set('draft', null); updateSaveBar(); toast('lab-data.json saved on the server', 'ok'); }
    catch (e) { toast('Save failed: ' + e.message + ' — use Download JSON', 'err'); }
    finally { b.disabled = false; b.textContent = 'Save to server'; }
  }
  function downloadJson() { const blob = new Blob([JSON.stringify(S.data, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lab-data.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('lab-data.json downloaded — replace the file next to index.html', 'ok'); }
  function pduItemId(deviceId) { const r = [...S.recs.values()].find(r => r.cat === 'item' && r.item?.type === 'pdu' && r.item.dcim?.deviceId === deviceId); return r ? r.id : ''; }

  function rebuildAll() {
    // setups/shelves colors follow overrides → rebuild static + items
    for (const [id, r] of [...S.recs]) { if (r.label) r.label.remove(); if (r.telem) r.telem.remove(); S.recs.delete(id); }
    S.pickables = []; disposeGroup(staticGroup); disposeGroup(wallsGroup); disposeGroup(zonesGroup); disposeGroup(itemsGroup);
    buildStatic(); computeModel(); buildItems(); refreshLabelsStatic();
  }
  function refreshLabelsStatic() { setLabelMode(S.labelMode, true); wallsGroup.visible = S.wallsVisible; zonesGroup.visible = S.zonesVisible; }
  function buildStatic() {
    const d = S.data; world.updateMatrixWorld(true); buildRoom(d);
    d.setups.forEach(su => buildRack(su, d.shelves.filter(s => s.setup === su.id), d.templates.rack));
    d.storage.forEach(sd => { if (sd.template === 'trayRack') buildTrayRack(sd, d.templates.trayRack); else buildCabinet(sd); });
  }

  // ───────────────────────────────────────────────────────────── live backend
  function pill(cls, text) { const p = $('#livePill'); p.className = 'live-pill ' + cls; $('#liveText').textContent = text; }
  async function api(path, opts = {}) {
    const base = (S.settings.url || '').replace(/\/$/, '');
    const headers = {}; if (opts.body) headers['Content-Type'] = 'application/json'; if (S.settings.pass) headers.Authorization = 'Basic ' + btoa('x:' + S.settings.pass);
    const r = await fetch(base + path, { ...opts, headers });
    if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.trim());
    if (r.status === 204) return null; return r.json();
  }
  async function connect() {
    pill('connecting', 'Connecting…'); $('#sStatus').textContent = 'Connecting…';
    try {
      const devices = await api('/api/devices/');
      const [slots, order, sw, owners, rackItems, chillers, rov] = await Promise.all(['/api/rack-slots', '/api/rack-positions', '/api/switch-assignments', '/api/opt-owners', '/api/rack-items', '/api/chillers', '/api/rack-overrides'].map(p => api(p).catch(() => ({}))));
      Object.assign(S.live, { connected: true, devices, rackSlots: slots || {}, rackOrder: order || {}, sw: sw || {}, owners: owners || {}, rackItems: rackItems || {}, chillers: chillers || null, rackOverrides: rov || {}, error: null });
      pill('online', `${window.LAB_DEMO ? 'DEMO (simulated)' : 'Live'} · ${devices.filter(d => d.kind === 'pdu').length} PDU · ${devices.filter(d => d.kind === 'kvm').length} KVM`);
      $('#sStatus').textContent = `Connected — ${devices.length} devices.`;
      computeModel(); buildItems(); await refreshStatuses();
      if (S.live.timer) clearInterval(S.live.timer);
      if (S.settings.poll) S.live.timer = setInterval(refreshStatuses, POLL_MS);
      toast('Backend connected', 'ok');
    } catch (e) {
      S.live.connected = false; S.live.error = String(e.message || e);
      pill('error', 'Backend error'); $('#sStatus').textContent = 'Error: ' + S.live.error + (location.protocol === 'file:' ? ' — if you opened index.html from disk, make sure the URL includes http:// and the backend allows CORS (it does by default).' : '');
      toast('Backend connection failed: ' + S.live.error, 'err');
      computeModel(); buildItems();
    }
  }
  function disconnect() { S.live.connected = false; if (S.live.timer) clearInterval(S.live.timer); S.live.timer = null; S.live.pdu = {}; S.live.kvm = {}; pill('offline', 'Offline · static data'); computeModel(); buildItems(); $('#sStatus').textContent = 'Disconnected.'; }
  async function refreshStatuses() {
    if (!S.live.connected) return;
    const pdus = S.live.devices.filter(d => d.kind === 'pdu'), kvms = S.live.devices.filter(d => d.kind === 'kvm');
    await Promise.all([
      ...pdus.map(p => api(`/api/pdus/${p.id}/status`).then(s => { S.live.pdu[p.id] = s; }).catch(() => {})),
      ...kvms.map(k => api(`/api/kvms/${k.id}/status`).then(s => { S.live.kvm[k.id] = s; }).catch(() => {})),
    ]);
    computeModel(); buildItems();
  }
  async function outletAction(pduId, outlet, action, btn) {
    if (!S.live.connected) { toast('Connect the backend first', 'err'); return; }
    const old = btn ? btn.innerHTML : null; if (btn) { btn.disabled = true; btn.innerHTML = `<span class="busy"></span> ${action}…`; }
    try {
      await api(`/api/pdus/${pduId}/outlets/${outlet}/power`, { method: 'POST', body: JSON.stringify({ action }) });
      toast(`Outlet #${outlet} → ${action}`, 'ok');
      setTimeout(async () => { try { S.live.pdu[pduId] = await api(`/api/pdus/${pduId}/status`); computeModel(); buildItems(); } catch { /* ignore */ } }, 1500);
    } catch (e) { toast('Power action failed: ' + e.message, 'err'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
  }
  function openKvm(kvmId, port) {
    const base = (S.settings.url || '').replace(/\/$/, '');
    api(`/api/kvms/${kvmId}/ports/${port}/mark-in-use`, { method: 'POST' }).catch(() => {});
    const popup = window.open(`${base}/api/kvms/${kvmId}/autologin?port=${port}`, '_blank');
    if (popup) { const t = setInterval(() => { if (popup.closed) { clearInterval(t); api(`/api/kvms/${kvmId}/ports/${port}/mark-free`, { method: 'POST' }).catch(() => {}); refreshStatuses(); } }, 2000); }
    toast(`Opening KVM console · port ${port}`, 'ok');
  }
  let popEl = null;
  function outletMenu(e, pduItem, outlet) {
    if (popEl) popEl.remove();
    if (!S.live.connected) { toast('Connect the backend to control outlets', 'err'); return; }
    const r = e.currentTarget.getBoundingClientRect(); popEl = document.createElement('div'); popEl.className = 'pop';
    const lbl = pduItem.live?.status?.outlets?.find(o => o.number === outlet)?.label || pduItem.dcim?.labels?.[String(outlet)] || `Outlet ${outlet}`;
    popEl.innerHTML = `<div class="pt">${esc(pduItem.name)} · #${outlet} · ${esc(lbl)}</div><button class="btn btn-on" data-a="on">Power On</button><button class="btn btn-off" data-a="off">Power Off</button><button class="btn btn-cycle" data-a="cycle">Power Cycle</button>`;
    const openUp = r.bottom > window.innerHeight / 2; popEl.style.left = Math.min(Math.max(r.left + r.width / 2 - 100, 8), window.innerWidth - 210) + 'px'; popEl.style.top = (openUp ? r.top - 130 : r.bottom + 4) + 'px';
    document.body.appendChild(popEl);
    $$('button', popEl).forEach(b => b.onclick = () => { outletAction(pduItem.dcim.deviceId, outlet, b.dataset.a, b); setTimeout(() => popEl && popEl.remove(), 400); });
    setTimeout(() => document.addEventListener('click', function h(ev) { if (popEl && !popEl.contains(ev.target)) { popEl.remove(); popEl = null; } document.removeEventListener('click', h); }), 0);
  }

  // settings modal
  $('#btnSettings').onclick = () => { $('#sUrl').value = S.settings.url || ''; $('#sPass').value = S.settings.pass || ''; $('#sPoll').checked = S.settings.poll !== false; $('#settings').classList.remove('hidden'); };
  $('#sClose').onclick = () => $('#settings').classList.add('hidden');
  $('#sConnect').onclick = () => { S.settings = { url: $('#sUrl').value.trim(), pass: $('#sPass').value, poll: $('#sPoll').checked }; LS.set('settings', S.settings); connect(); };
  $('#sDisconnect').onclick = () => { disconnect(); };
  $('#livePill').onclick = () => $('#btnSettings').click();

  // export
  $('#btnExport').onclick = downloadJson;
  $('#sbSave').onclick = saveToServer; $('#sbDownload').onclick = downloadJson;
  $('#sbDiscard').onclick = () => { if (confirm('Discard all unsaved edits and reload the saved lab-data.json?')) { LS.set('draft', null); location.reload(); } };
  $('#btnPlan').onclick = () => window.open('floorplan.svg', '_blank');

  // ───────────────────────────────────────────────────────────── keep camera + target inside the room
  const _clampV = new THREE.Vector3();
  function clampToRoom() {
    if (!S.data) return; const { width: W, depth: D, height: H } = S.data.room; const m = 0.25;
    const cl = v => { v.x = Math.min(-m, Math.max(-W + m, v.x)); v.z = Math.min(D - m, Math.max(m, v.z)); };
    _clampV.copy(camera.position); cl(_clampV); _clampV.y = Math.min(12, Math.max(0.35, _clampV.y));
    if (!_clampV.equals(camera.position)) camera.position.copy(_clampV);
    _clampV.copy(controls.target); cl(_clampV); _clampV.y = Math.min(H, Math.max(0.05, _clampV.y));
    if (!_clampV.equals(controls.target)) controls.target.copy(_clampV);
  }

  // ───────────────────────────────────────────────────────────── camera views
  function roomCenter() { const { width: W, depth: D } = S.data.room; return new THREE.Vector3(W / 2, 0.9, D / 2); }
  function tweenCamera(pos, target, ms = 700) { S.tween = { t0: performance.now(), ms, p0: camera.position.clone(), p1: pos.clone(), t0v: controls.target.clone(), t1v: target.clone() }; }
  const VIEWS = {
    orbit() { const { width: W, depth: D } = S.data.room; tweenCamera(new THREE.Vector3(WX(0.6), 2.55, 0.45), new THREE.Vector3(WX(W / 2), 0.9, D * 0.55)); controls.maxPolarAngle = Math.PI / 2 - 0.01; },
    top() { const { width: W, depth: D } = S.data.room; tweenCamera(new THREE.Vector3(WX(W / 2), 11.5, D / 2 - 0.001), new THREE.Vector3(WX(W / 2), 0, D / 2)); controls.maxPolarAngle = Math.PI / 2 - 0.01; },
    eye() { const { width: W, depth: D } = S.data.room; tweenCamera(new THREE.Vector3(WX(W / 2), 1.65, 0.35), new THREE.Vector3(WX(W / 2), 1.35, D * 0.7)); controls.maxPolarAngle = Math.PI / 2 + 0.35; },
  };
  function setView(name) { VIEWS[name](); $$('.tb').forEach(b => b.classList.remove('active')); $('#v' + name[0].toUpperCase() + name.slice(1)).classList.add('active'); }
  function flyTo(rec, force) {
    if (!rec.group) return; const b = new THREE.Box3(); rec.meshes.forEach(m => b.expandByObject(m)); if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3()); let dist = Math.max(s.x, s.y, s.z) * 1.7 + 1.1;
    if (rec.cat === 'setup') { dist = 3.4; c.y = 1.25; } else if (rec.cat === 'shelf') { dist = 2.2; } else if (rec.cat === 'item' && rec.setup) { dist = Math.max(1.2, dist * 0.8); }
    let dir = camera.position.clone().sub(controls.target); if (dir.length() < 0.01) dir.set(-1, 1, -1); dir.normalize(); if (dir.y < 0.25) dir.y = 0.25; dir.normalize();
    // prefer approaching a rack from its front
    if (rec.cat === 'setup' || rec.cat === 'shelf' || (rec.cat === 'item' && rec.setup)) { const su = S.recs.get(rec.setup || rec.id); if (su && su.group) { const front = new THREE.Vector3(1, 0, 0).transformDirection(su.group.matrixWorld); dir = front.multiplyScalar(1).add(new THREE.Vector3(0, rec.cat === 'setup' ? 0.28 : 0.4, 0)).normalize(); } }
    tweenCamera(c.clone().add(dir.multiplyScalar(dist)), c, force ? 500 : 800);
  }
  $('#vOrbit').onclick = () => setView('orbit'); $('#vTop').onclick = () => setView('top'); $('#vEye').onclick = () => setView('eye');
  $('#vReset').onclick = () => { setView('orbit'); closeDetail(); };
  $('#btnHome').onclick = () => setView('orbit');
  $('#tWalls').onclick = () => { S.wallsVisible = !S.wallsVisible; wallsGroup.visible = S.wallsVisible; $('#tWalls').classList.toggle('active', !S.wallsVisible); $('#tWalls').textContent = S.wallsVisible ? 'Walls' : 'Walls hidden'; };
  $('#tZones').onclick = () => { S.zonesVisible = !S.zonesVisible; zonesGroup.visible = S.zonesVisible; $('#tZones').classList.toggle('active', S.zonesVisible); };
  $('#tZones').classList.add('active');
  function setLabelMode(mode, silent) { S.labelMode = mode; $('#tLabels').textContent = 'Labels: ' + { setups: 'setups', all: 'all', none: 'off' }[mode]; if (!silent) LS.set('labelMode', mode); }
  $('#tLabels').onclick = () => setLabelMode({ setups: 'all', all: 'none', none: 'setups' }[S.labelMode]);
  window.addEventListener('keydown', e => {
    if (e.target.matches('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (k === 'r') setView('orbit'); if (k === 't') setView('top'); if (k === 'e') setView('eye'); if (k === 'w') $('#tWalls').click(); if (k === 'l') $('#tLabels').click(); if (k === 'z') $('#tZones').click();
    if (k === 'k') toggleKiosk(); if (e.key === 'F2') toggleEdit();
    if (e.key === 'Home') $('#vReset').click(); if (e.key === 'Escape') { closeDetail(); $('#settings').classList.add('hidden'); }
  });

  // ───────────────────────────────────────────────────────────── picking
  let downPos = null;
  canvas.addEventListener('pointerdown', e => { downPos = [e.clientX, e.clientY]; S.lastInput = performance.now(); });
  ['pointermove', 'wheel', 'keydown', 'touchstart'].forEach(t => window.addEventListener(t, () => { S.lastInput = performance.now(); }, { passive: true }));
  canvas.addEventListener('pointerup', e => {
    if (!downPos) return; const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]); downPos = null; if (moved > (e.pointerType === 'touch' ? 14 : 6)) return;
    const hit = pickAt(e);
    if (S.moveItem) {
      // while moving: anything you tap resolves to the shelf / rack / storage at that spot — never changes the selection
      const target = hit ? resolveMoveTarget(hit) : null;
      if (target) finishMove(target); else toast('Tap a shelf, a rack or a storage unit (or Cancel)', 'err');
      return;
    }
    if (!hit) return;
    select(hit.object.userData.id, { fly: true });
  });
  let hoverT = 0;
  canvas.addEventListener('pointermove', e => {
    const now = performance.now(); if (now - hoverT < 40) return; hoverT = now; const hit = pickAt(e);
    let id = hit ? hit.object.userData.id : null;
    if (S.moveItem) { const t = hit ? resolveMoveTarget(hit) : null; id = t ? t.id : null; }
    if (id !== S.hover) { setHover(id); }
  });
  function pickAt(e) {
    const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(S.pickables.filter(m => m.visible && m.parent && (m.material.opacity > 0.2)), false);
    for (const h of hits) { const rec = S.recs.get(h.object.userData.id); if (!rec || rec.filtered) continue; if (rec.cat === 'zone') continue; return h; }
    // fall back to zone plane
    return hits.find(h => S.recs.get(h.object.userData.id)?.cat === 'zone') || null;
  }
  function pick(e) { const h = pickAt(e); return h ? h.object : null; }
  // Which shelf / rack / storage does a tap mean while moving an item? Items → their shelf; rack frame → shelf at that height.
  function resolveMoveTarget(hit) {
    const rec = S.recs.get(hit.object.userData.id); if (!rec || rec.id === S.moveItem) return null;
    if (rec.cat === 'shelf' || rec.cat === 'storage') return rec;
    const shelfAtHeight = (setupId, point) => {
      const su = S.recs.get(setupId); if (!su || !su.group) return null;
      const ly = su.group.worldToLocal(point.clone()).y; const st = su.tpl?.shelfThickness || 0.03;
      const shelves = recsOf(r => r.cat === 'shelf' && r.setup === setupId).sort((a, b) => a.y - b.y);
      if (!shelves.length) return su;
      let best = null; for (const sh of shelves) if (sh.y - st - 0.03 <= ly) best = sh;
      return best || su; // below the lowest shelf → bottom bay of the rack
    };
    if (rec.cat === 'setup') return shelfAtHeight(rec.id, hit.point);
    if (rec.cat === 'item') {
      const it = rec.item || {};
      if (it.shelf && S.recs.has(it.shelf)) return S.recs.get(it.shelf);
      if (it.storage && S.recs.has(it.storage)) return S.recs.get(it.storage);
      if (it.setup && S.recs.has(it.setup)) return shelfAtHeight(it.setup, hit.point);
    }
    return null;
  }
  function setHover(id) {
    if (S.hover) { const r = S.recs.get(S.hover); if (r) { r.meshes.forEach(m => { if (m.material.userData.hoverEm) { m.material.emissiveIntensity = m.material.userData.hoverEm.i; m.material.emissive.setHex(m.material.userData.hoverEm.c); m.material.userData.hoverEm = null; } }); if (r.slot) r.slot.material.opacity = .22; } }
    S.hover = id; canvas.style.cursor = id ? 'pointer' : 'default';
    if (id && S.moveItem) { const r = S.recs.get(id); if (r && r.slot) r.slot.material.opacity = .5; }
    if (id) { const r = S.recs.get(id); if (r && r.cat !== 'zone') r.meshes.forEach(m => { if (m.material.userData.unique !== false && !m.material.userData.hoverEm) { m.material.userData.hoverEm = { i: m.material.emissiveIntensity, c: m.material.emissive.getHex() }; m.material.emissive.setHex(0x76b900); m.material.emissiveIntensity = 0.35; } }); }
  }

  // ───────────────────────────────────────────────────────────── labels projection
  const tmpV = new THREE.Vector3();
  function updateLabels() {
    const r = canvas.getBoundingClientRect(); const camPos = camera.position;
    for (const rec of S.recs.values()) {
      const el = rec.telem; if (!el) continue;
      const show = !rec.filtered && S.labelMode !== 'none' && (S.live.connected || S.selected === rec.id);
      if (!show) { el.style.display = 'none'; continue; }
      tmpV.copy(rec.telemAnchor); const dist = tmpV.distanceTo(camPos); tmpV.project(camera);
      if (tmpV.z > 1 || Math.abs(tmpV.x) > 1.1 || Math.abs(tmpV.y) > 1.1) { el.style.display = 'none'; continue; }
      el.style.display = ''; el.style.left = ((tmpV.x + 1) / 2 * r.width) + 'px'; el.style.top = ((1 - tmpV.y) / 2 * r.height) + 'px'; el.style.opacity = dist > 16 ? .6 : 1; el.style.zIndex = Math.max(2, Math.round(110 - dist * 3));
    }
    for (const rec of S.recs.values()) {
      const el = rec.label; if (!el) continue;
      let show = !rec.filtered || S.selected === rec.id;
      if (show) {
        if (rec.cat === 'zone') show = S.zonesVisible && S.labelMode !== 'none';
        else if (rec.cat === 'setup' || rec.cat === 'storage') show = S.labelMode !== 'none' || S.selected === rec.id;
        else if (rec.cat === 'structure') show = S.wallsVisible && (S.labelMode === 'all' || S.selected === rec.id);
        else show = S.labelMode === 'all' || S.selected === rec.id || (S.filters.q && !rec.filtered);
      }
      if (!show) { el.style.display = 'none'; continue; }
      const a = anchorOf(rec); if (!a) { el.style.display = 'none'; continue; }
      tmpV.copy(a); const dist = tmpV.distanceTo(camPos);
      if ((rec.cat === 'item' || rec.cat === 'shelf') && dist > 9 && S.selected !== rec.id && !S.filters.q) { el.style.display = 'none'; continue; }
      tmpV.project(camera);
      if (tmpV.z > 1 || tmpV.x < -1.1 || tmpV.x > 1.1 || tmpV.y < -1.1 || tmpV.y > 1.1) { el.style.display = 'none'; continue; }
      el.style.display = ''; el.style.left = ((tmpV.x + 1) / 2 * r.width) + 'px'; el.style.top = ((1 - tmpV.y) / 2 * r.height) + 'px';
      el.style.opacity = rec.filtered ? .35 : (dist > 14 && rec.cat !== 'setup' ? .55 : 1); el.style.zIndex = Math.max(1, Math.round(100 - dist * 3));
    }
  }

  // ───────────────────────────────────────────────────────────── render loop
  function animate() {
    requestAnimationFrame(animate);
    if (S.kiosk) { const idle = performance.now() - S.lastInput; controls.autoRotate = idle > 45000 && !S.selected; controls.autoRotateSpeed = 0.6; } else controls.autoRotate = false;
    if (S.tween) { const k = Math.min(1, (performance.now() - S.tween.t0) / S.tween.ms); const e = 1 - Math.pow(1 - k, 3); camera.position.lerpVectors(S.tween.p0, S.tween.p1, e); controls.target.lerpVectors(S.tween.t0v, S.tween.t1v, e); if (k >= 1) S.tween = null; }
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 250); for (const r of S.recs.values()) if (r.leakRing && r.leakRing.visible) r.leakRing.material.opacity = pulse;
    controls.update(); clampToRoom(); renderer.render(scene, camera); updateLabels();
  }


  // ───────────────────────────────────────────────────────────── EDIT MODE (touch-friendly editor for the lab screen)
  const STATUS_ICON = { active: '●', building: '◐', inactive: '○', dismantled: '✕', unknown: '?' };
  function toggleEdit(force) { S.editMode = force !== undefined ? force : !S.editMode; LS.set('editMode', S.editMode); document.body.classList.toggle('editmode', S.editMode); $('#btnEdit').classList.toggle('on', S.editMode); $('#btnEdit').textContent = S.editMode ? '✓ Editing' : 'Edit'; if (!S.editMode) cancelMove(); if (S.selected) select(S.selected, { keepCamera: true }); toast(S.editMode ? 'Edit mode — tap any rack, shelf or item' : 'Edit mode off', 'ok'); }
  function toggleKiosk(force) { S.kiosk = force !== undefined ? force : !S.kiosk; LS.set('kiosk', S.kiosk); document.body.classList.toggle('kiosk', S.kiosk); $('#btnKiosk').classList.toggle('on', S.kiosk); if (S.kiosk && S.labelMode === 'none') setLabelMode('setups'); resize(); }
  $('#btnEdit').onclick = () => toggleEdit(); $('#btnKiosk').onclick = () => toggleKiosk();

  function startMove(itemId) { S.moveItem = itemId; document.body.classList.add('moving'); $('#moveBanner').classList.remove('hidden'); $('#moveText').textContent = `Tap the shelf (or rack / storage) where ${S.recs.get(itemId)?.def.name || itemId} goes now`; highlightTargets(true); }
  function cancelMove() { if (!S.moveItem) return; S.moveItem = null; document.body.classList.remove('moving'); $('#moveBanner').classList.add('hidden'); highlightTargets(false); }
  $('#moveCancel').onclick = cancelMove;
  function highlightTargets(on) {
    for (const r of S.recs.values()) if (r.cat === 'shelf') {
      r.edges.forEach(e => { e.material.color.set(on ? '#22d3ee' : STATUS_COLOR[r.status]); e.material.opacity = on ? 1 : (e.userData.baseOpacity ?? .7); });
      if (r.slot) { r.slot.visible = on; r.slot.material.opacity = .22; }
    }
    setHover(null);
  }
  // Devices that Lab Manager places itself (OPTs with a rack slot, DCIM rack items) must be moved in Lab Manager's own
  // files (rack-slots / rack-overrides / rack-items) — otherwise the live data snaps them back on the next refresh.
  function movesViaDcim(mit) {
    if (!S.live.connected || !mit) return false;
    if (mit.type === 'opt' && mit.live?.inDcim && mit.dcim?.optKey) return 'opt';
    if (mit.id.startsWith('LIVE-') && mit.type.startsWith('equip-') && mit.live?.rack) return 'rack-item';
    return false;
  }
  function shelfToU(setupId, shelfId) {
    const shelves = S.data.shelves.filter(sh => sh.setup === setupId).sort((a, b) => a.level - b.level); const n = shelves.length;
    const uTopDown = (S.data.dcim?.uNumbering || 'top-down') === 'top-down';
    const idx = shelfId ? shelves.findIndex(s => s.id === shelfId) : 0;   // no shelf (bottom bay) → lowest shelf
    return uTopDown ? n - Math.max(0, idx) : Math.max(0, idx) + 1;
  }
  async function dcimMove(mit, kind, target) {
    const sid = target.cat === 'shelf' ? target.setup : target.cat === 'setup' ? target.id : null;
    if (!sid) throw new Error('Lab Manager devices can only be moved onto a rack or a shelf');
    const su = S.data.setups.find(s => s.id === sid); const rack = dcimRackOf(su);
    if (!rack) throw new Error(`${sid} is not mapped to a DCIM rack yet — open the rack in Edit mode and set "DCIM rack" first`);
    const u = shelfToU(sid, target.cat === 'shelf' ? target.id : null);
    if (kind === 'opt') {
      const key = mit.dcim.optKey;
      const slots = JSON.parse(JSON.stringify(S.live.rackSlots || {})); const ov = { ...(S.live.rackOverrides || {}) }; const order = JSON.parse(JSON.stringify(S.live.rackOrder || {}));
      Object.keys(slots).forEach(r => { if (slots[r] && key in slots[r]) delete slots[r][key]; });
      (slots[rack] = slots[rack] || {})[key] = u;
      const pduRack = S.live.devices.find(d => d.id === mit.dcim.pdu)?.rack || null;
      if (rack === pduRack) delete ov[key]; else ov[key] = rack;
      Object.keys(order).forEach(r => { if (Array.isArray(order[r])) order[r] = order[r].filter(k => k !== key); });
      (order[rack] = order[rack] || []).push(key);
      await api('/api/rack-slots', { method: 'PUT', body: JSON.stringify(slots) });
      await api('/api/rack-overrides', { method: 'PUT', body: JSON.stringify(ov) });
      await api('/api/rack-positions', { method: 'PUT', body: JSON.stringify(order) }).catch(() => {});
      S.live.rackSlots = slots; S.live.rackOverrides = ov; S.live.rackOrder = order;
      return `${rack} · U${u}`;
    }
    // DCIM rack item (switch / patch panel …)
    const ciId = mit.id.slice(5); const items = JSON.parse(JSON.stringify(S.live.rackItems || {})); let ci = null;
    Object.keys(items).forEach(r => { const i = (items[r] || []).findIndex(x => String(x.id) === ciId); if (i >= 0) { ci = items[r][i]; items[r].splice(i, 1); } });
    if (!ci) throw new Error('rack item not found in Lab Manager data');
    ci.u = u; (items[rack] = items[rack] || []).push(ci);
    await api('/api/rack-items', { method: 'PUT', body: JSON.stringify(items) }); S.live.rackItems = items;
    return `${rack} · U${u}`;
  }
  async function finishMove(target) {
    const id = S.moveItem; cancelMove(); if (!id) return;
    const rec = S.recs.get(id); const mit = rec?.item; const def = S.data.items.find(x => x.id === id);
    if (!def && !mit) return;
    const name = (mit || def).name || id;
    const kind = movesViaDcim(mit);
    if (kind) {
      toast(`Moving ${name} in Lab Manager…`);
      try { const where = await dcimMove(mit, kind, target); toast(`${name} → ${target.id} (${where} saved in Lab Manager)`, 'ok'); }
      catch (e) { toast('Move failed: ' + e.message, 'err'); return; }
    }
    if (def) {
      const patch = { setup: null, shelf: null, storage: undefined, placement: undefined, pos: undefined, side: undefined, placementConfidence: 'high' };
      if (target.cat === 'shelf') { patch.setup = target.setup; patch.shelf = target.id; patch.zone = target.zone; }
      else if (target.cat === 'setup') { patch.setup = target.id; patch.placement = 'bottom-bay'; patch.zone = target.zone; }
      else if (target.cat === 'storage') { patch.storage = target.id; patch.zone = target.zone; }
      patchDef(id, patch); rebuildAll();
      if (!kind) toast(`${name} → ${target.id}`, 'ok');
    } else { computeModel(); buildItems(); }
    select(id, { keepCamera: true });
  }

  function bigChips(cur) { return `<div class="chips-lg">${STATUSES.map(st => `<button class="chip-lg ${cur === st ? 'on' : ''}" data-st="${st}" style="--c:${STATUS_COLOR[st]}"><span class="ic">${STATUS_ICON[st]}</span>${STATUS_LABEL[st]}</button>`).join('')}</div>`; }
  function shelfName(id) { const sh = S.data.shelves.find(x => x.id === id); return sh ? `${sh.setup} · L${sh.level}` : id; }

  function renderEditor(rec) {
    const def = rec.def; const it = rec.item; const isLive = rec.id.startsWith('LIVE-');
    $('#dId').textContent = rec.id; $('#dName').textContent = def.name || rec.id;
    let html = `<div class="edit-hint">EDIT MODE · tap another object in the 3D view to switch</div>`;
    if (rec.cat === 'item' && isLive) {
      const loc = it.shelf ? shelfName(it.shelf) : it.setup ? `${it.setup} · ${it.live?.rack || ''} U${it.live?.u ?? '?'}` : it.live?.rack ? `${it.live.rack} (rack not mapped to a 3D setup)` : 'not placed';
      html += `<div class="sec big"><div class="note">Live from Lab Manager (DCIM). Moving it here writes the rack / U slot back into Lab Manager.</div>
        <label class="lbl-lg">Where</label><div class="where"><span class="where-txt">${esc(loc)}</span></div>
        ${movesViaDcim(it) ? `<div class="row-lg"><button class="btn-lg btn-cyan" id="eMove">⇄ Move… (tap a shelf)</button></div>` : ''}
        <button class="btn-lg" id="eMaterialize">＋ Add a physical record of it here</button></div>`;
    } else if (rec.cat === 'item') {
      const loc = it.shelf ? shelfName(it.shelf) : it.placement === 'side-mount' ? `${it.setup} · hung on the ${it.side || 'right'} side` : it.placement === 'bottom-bay' ? `${it.setup} · bottom bay` : it.placement === 'rack-strips' ? `${it.setup} · power strips` : it.storage ? it.storage : it.pos ? `free · x ${it.pos[0]} z ${it.pos[1]}` : 'not placed';
      const pdus = S.data.dcim?.pdus || [];
      html += `<div class="sec big">
        <label class="lbl-lg">Name</label><input class="in-lg" id="eName" value="${esc(it.name || '')}" />
        <label class="lbl-lg">Status</label>${bigChips(it.status || 'unknown')}
        <label class="lbl-lg">Where</label>
        <div class="where"><span class="where-txt">${esc(loc)}</span></div>
        <div class="row-lg"><button class="btn-lg btn-cyan" id="eMove">⇄ Move… (tap a shelf)</button><button class="btn-lg" id="eUnplace">Unplace</button></div>
        ${it.setup ? `<div class="row-lg"><button class="btn-lg sm" data-side="left">⇤ Hang on left side</button><button class="btn-lg sm" data-side="right">Hang on right side ⇥</button><button class="btn-lg sm" data-side="bay">Bottom bay</button></div>` : ''}
        <label class="lbl-lg">Type</label><select class="in-lg" id="eType">${['opt', 'kvm', 'pdu', 'chiller', 'equip-switch', 'equip-patchpanel', 'equip-ups', 'equip-other', 'spare-chassis', 'cart', 'ladder', 'toolbox', 'misc', 'other'].map(t => `<option value="${t}" ${it.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <label class="lbl-lg">Owner</label><input class="in-lg" id="eOwner" value="${esc(it.owner || '')}" placeholder="engineer" />
        <label class="lbl-lg">PDU · outlet</label>
        <div class="row-lg"><select class="in-lg" id="ePdu" style="flex:2"><option value="">— no PDU —</option>${pdus.map(x => `<option value="${x.id}" ${it.dcim?.pdu === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <div class="stepper"><button data-step="-1">−</button><input id="eOutlet" type="number" min="1" max="48" value="${it.dcim?.outlet ?? ''}" placeholder="#" /><button data-step="1">＋</button></div></div>
        <label class="lbl-lg">Notes</label><textarea class="in-lg" id="eNotes">${esc(it.notes || '')}</textarea>
        <input type="hidden" id="eStatus" value="${it.status || 'unknown'}" />
      </div>
      <div class="sec big actions">
        <button class="btn-lg btn-save" id="eSave">✓ Save</button>
        <button class="btn-lg btn-amber" id="eReplace">⟳ Replace with new device</button>
        <div class="row-lg"><button class="btn-lg" id="eDup">Duplicate</button><button class="btn-lg btn-danger" id="eDel">Delete</button></div>
      </div>`;
    } else if (rec.cat === 'shelf') {
      const its = recsOf(r => r.cat === 'item' && r.shelf === rec.id);
      html += `<div class="sec big"><div class="lbl-lg">On ${rec.id} · level L${rec.level} · ${rec.setup}</div>
        ${its.length ? its.map(i => `<div class="itm-lg"><span class="dot-lg" style="background:${STATUS_COLOR[i.status]}"></span><span class="itm-name">${esc(i.item.name)}<small>${esc(i.item.typeLabel || i.item.type)}${i.item.dcim?.outlet ? ' · outlet #' + i.item.dcim.outlet : ''}</small></span><button class="btn-lg sm" data-edit="${i.id}">Edit</button><button class="btn-lg sm btn-cyan" data-move="${i.id}">Move</button></div>`).join('') : '<div class="note">Shelf is empty.</div>'}
        <button class="btn-lg btn-save" id="eAddHere">＋ Add device on this shelf</button></div>
        <div class="sec big"><label class="lbl-lg">Shelf status</label>${bigChips(def.status || 'unknown')}<input type="hidden" id="eStatus" value="${def.status || 'unknown'}"/><label class="lbl-lg">Notes</label><textarea class="in-lg" id="eNotes">${esc(def.notes || '')}</textarea><button class="btn-lg btn-save" id="eSave">✓ Save</button></div>`;
    } else if (rec.cat === 'setup') {
      const racks = [...new Set([...(S.data.dcim?.pdus || []).map(p => p.rack), ...S.model.liveRacks])].filter(Boolean).sort(); const cur = def.dcimRack || '';
      const shelves = recsOf(r => r.cat === 'shelf' && r.setup === rec.id).sort((a, b) => b.level - a.level);
      html += `<div class="sec big"><label class="lbl-lg">Name</label><input class="in-lg" id="eName" value="${esc(def.name)}"/>
        <label class="lbl-lg">DCIM rack (which Rack-0X is this physically?)</label><select class="in-lg" id="dRack"><option value="">— none —</option>${racks.map(r => `<option value="${esc(r)}" ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
        <label class="lbl-lg">Status</label>${bigChips(def.status || 'unknown')}<input type="hidden" id="eStatus" value="${def.status || 'unknown'}"/>
        <label class="lbl-lg">Notes</label><textarea class="in-lg" id="eNotes">${esc(def.notes || '')}</textarea><button class="btn-lg btn-save" id="eSave">✓ Save</button></div>
        <div class="sec big"><div class="lbl-lg">Shelves (tap to edit)</div>${shelves.map(sh => { const its = recsOf(r => r.cat === 'item' && r.shelf === sh.id); return `<div class="itm-lg" data-go="${sh.id}"><span class="lvl-lg">L${sh.level}</span><span class="itm-name">${its.length ? its.map(i => esc(i.item.name)).join(', ') : '<i>empty</i>'}<small>${sh.id}</small></span><span class="chev">›</span></div>`; }).join('')}
        <button class="btn-lg" id="eAddBay">＋ Add rack-level item (bottom bay)</button></div>`;
    } else if (rec.cat === 'storage') {
      const its = recsOf(r => r.cat === 'item' && r.item?.storage === rec.id);
      html += `<div class="sec big"><label class="lbl-lg">Name</label><input class="in-lg" id="eName" value="${esc(def.name)}"/><label class="lbl-lg">Status</label>${bigChips(def.status || 'unknown')}<input type="hidden" id="eStatus" value="${def.status || 'unknown'}"/><label class="lbl-lg">Notes</label><textarea class="in-lg" id="eNotes">${esc(def.notes || '')}</textarea><button class="btn-lg btn-save" id="eSave">✓ Save</button></div>
        <div class="sec big"><div class="lbl-lg">Contents</div>${its.map(i => `<div class="itm-lg"><span class="dot-lg" style="background:${STATUS_COLOR[i.status]}"></span><span class="itm-name">${esc(i.item.name)}<small>×${i.item.quantity || 1}</small></span><button class="btn-lg sm" data-edit="${i.id}">Edit</button></div>`).join('') || '<div class="note">Empty.</div>'}<button class="btn-lg" id="eAddStore">＋ Add item here</button></div>`;
    } else {
      html += `<div class="sec big"><div class="note">${esc(def.notes || 'Nothing editable here — tap a rack, shelf or device.')}</div></div>`;
    }
    $('#dBody').innerHTML = html;
    const body = $('#dBody');
    $$('.chip-lg', body).forEach(c => c.onclick = () => { $$('.chip-lg', body).forEach(x => x.classList.remove('on')); c.classList.add('on'); $('#eStatus').value = c.dataset.st; });
    $$('[data-go]', body).forEach(el => el.onclick = () => select(el.dataset.go, { keepCamera: true }));
    $$('[data-edit]', body).forEach(el => el.onclick = e => { e.stopPropagation(); select(el.dataset.edit, { keepCamera: true }); });
    $$('[data-move]', body).forEach(el => el.onclick = e => { e.stopPropagation(); startMove(el.dataset.move); });
    $$('[data-step]', body).forEach(b => b.onclick = () => { const i = $('#eOutlet'); i.value = Math.min(48, Math.max(1, (parseInt(i.value, 10) || 0) + parseInt(b.dataset.step, 10))); });
    const mv = $('#eMove'); if (mv) mv.onclick = () => startMove(rec.id);
    $$('[data-side]', body).forEach(b => b.onclick = () => { const v = b.dataset.side; const patch = v === 'bay' ? { shelf: null, placement: 'bottom-bay', side: undefined } : { shelf: null, placement: 'side-mount', side: v, mountHeight: it.mountHeight || 1.45 }; patchDef(rec.id, patch); rebuildAll(); select(rec.id, { keepCamera: true }); });
    const un = $('#eUnplace'); if (un) un.onclick = () => { patchDef(rec.id, { setup: null, shelf: null, placement: undefined, storage: undefined, pos: undefined }); rebuildAll(); select(rec.id, { keepCamera: true }); toast('Item unplaced — find it under Unplaced', 'ok'); };
    const dr = $('#dRack'); if (dr) dr.onchange = () => { patchDef(rec.id, { dcimRack: dr.value || null, dcimMappingConfidence: 'medium' }); rebuildAll(); select(rec.id, { keepCamera: true }); toast(`${rec.id} → ${dr.value || 'no DCIM rack'}`, 'ok'); };
    const sv = $('#eSave'); if (sv) sv.onclick = () => {
      const patch = { status: $('#eStatus').value, notes: $('#eNotes')?.value ?? def.notes };
      if ($('#eName')) patch.name = $('#eName').value.trim() || def.name;
      if (rec.cat === 'item') {
        patch.type = $('#eType').value; patch.owner = $('#eOwner').value.trim() || null;
        const pdu = $('#ePdu').value, outlet = parseInt($('#eOutlet').value, 10);
        if (pdu) { const pd = (S.data.dcim?.pdus || []).find(x => x.id === pdu); patch.dcim = { ...(it.dcim || {}), pdu, pduName: pd?.name, outlet: isNaN(outlet) ? undefined : outlet, optKey: optKey(patch.name) }; }
        else if (it.dcim) { const { pdu: _p, pduName: _n, outlet: _o, ...rest } = it.dcim; patch.dcim = Object.keys(rest).length ? rest : undefined; }
      }
      patchDef(rec.id, patch); rebuildAll(); select(rec.id, { keepCamera: true }); toast('Saved — press “Save to server” when done', 'ok');
    };
    const rp = $('#eReplace'); if (rp) rp.onclick = () => {
      const name = prompt('Name of the NEW device (the old one is kept as “dismantled” history):', it.name); if (!name) return;
      const n = { ...JSON.parse(JSON.stringify(it)), id: nextItemId(), name, status: 'building', confidence: 'high', placementConfidence: 'high', photos: [], notes: `Replaced ${it.name} (${it.id}) on ${new Date().toISOString().slice(0, 10)}.` };
      if (n.dcim) n.dcim.optKey = optKey(name); delete n.live; delete n.effStatus;
      S.data.items.push(n);
      patchDef(rec.id, { status: 'dismantled', setup: null, shelf: null, placement: undefined, storage: undefined, pos: undefined, notes: (it.notes || '') + ` Replaced by ${n.id} (${name}) on ${new Date().toISOString().slice(0, 10)}.` });
      rebuildAll(); select(n.id, { keepCamera: true }); toast(`${name} installed in place of ${it.name}`, 'ok');
    };
    const dup = $('#eDup'); if (dup) dup.onclick = () => { const c = JSON.parse(JSON.stringify(S.data.items.find(x => x.id === rec.id))); c.id = nextItemId(); c.name += ' (copy)'; delete c.live; delete c.effStatus; S.data.items.push(c); markDirty(); rebuildAll(); select(c.id, { keepCamera: true }); };
    const del = $('#eDel'); if (del) del.onclick = () => { if (confirm(`Delete ${def.name}?`)) deleteItem(rec.id); };
    const ah = $('#eAddHere'); if (ah) ah.onclick = () => addItem({ setup: def.setup, shelf: def.id, zone: def.zone, type: 'opt', typeLabel: 'OPT — switch under test', name: 'New device', status: 'building' });
    const ab = $('#eAddBay'); if (ab) ab.onclick = () => addItem({ setup: def.id, placement: 'bottom-bay', zone: def.zone, type: 'chiller', name: 'New rack-level item', status: 'building' });
    const as_ = $('#eAddStore'); if (as_) as_.onclick = () => addItem({ storage: def.id, zone: def.zone, type: 'spare-chassis', quantity: 1, name: 'New stored item', status: 'inactive' });
    const mat_ = $('#eMaterialize'); if (mat_) mat_.onclick = () => { const c = { id: nextItemId(), name: it.name, category: 'item', type: it.type, typeLabel: it.typeLabel, setup: it.setup || null, shelf: it.shelf || null, placement: it.placement, zone: it.zone || null, status: it.status || 'active', owner: it.owner || null, confidence: 'high', placementConfidence: 'medium', photos: [], notes: 'Added from live DCIM data.', dcim: it.dcim ? { optKey: it.dcim.optKey, pdu: it.dcim.pdu, pduName: it.dcim.pduName, outlet: it.dcim.outlet, deviceId: it.dcim.deviceId } : undefined }; S.data.items.push(c); markDirty(); rebuildAll(); select(c.id, { keepCamera: true }); };
  }

  // ───────────────────────────────────────────────────────────── telemetry (power / env) per rack
  const RATED_AMPS = 16;
  function heatColor(t) { // 18°C blue → 22 green → 26 amber → 32+ red
    if (t == null) return '#52525b'; if (t <= 18) return '#3b82f6'; if (t <= 22) return '#22c55e'; if (t <= 26) return '#84cc16'; if (t <= 30) return '#f59e0b'; return '#ef4444';
  }
  function rackTelemetry(su) {
    const rack = su.dcimRack; if (!S.live.connected || !rack) return null;
    const pdus = S.live.devices.filter(d => d.kind === 'pdu' && (d.rack === rack || (d.notes || '').split(',').map(x => x.trim()).includes('shared:' + rack)));
    if (!pdus.length) return null;
    let watts = 0, amps = 0, volts = 0, n = 0, on = 0, total = 0, temp = null, hum = null, leak = false, reach = 0, any = false;
    pdus.forEach(p => { const st = S.live.pdu[p.id]; if (!st) return; any = true; if (st.reachable === false) return; reach++; const v = st.inlet_voltage > 0 ? st.inlet_voltage : 208; volts += v; n++; watts += st.total_watts || 0; amps += (st.total_watts || 0) / v; (st.outlets || []).forEach(o => { total++; if (o.state === 'on') on++; }); if (st.temperature != null) temp = temp == null ? st.temperature : Math.max(temp, st.temperature); if (st.humidity != null) hum = hum == null ? st.humidity : Math.max(hum, st.humidity); if (st.leak_detected) leak = true; });
    if (!any) return { loading: true };
    return { watts, amps, volts: n ? volts / n : 0, cap: amps / (RATED_AMPS * pdus.length), on, total, temp, hum, leak, reachable: reach > 0, pduCount: pdus.length };
  }
  function updateTelemetry() {
    let tSum = 0, tN = 0, hSum = 0, hN = 0, tMin = null, tMax = null, leaks = [], kwTot = 0;
    for (const rec of S.recs.values()) {
      if (rec.cat !== 'setup' || !rec.telem) continue;
      const t = rackTelemetry(rec.def);
      if (!t || t.loading || !t.reachable) {
        rec.telem.className = 'telem dim'; rec.telem.innerHTML = `<span class="t-muted">${!t ? (S.live.connected ? (rec.def.dcimRack ? 'no PDU' : 'unmapped') : '—') : t.loading ? '…' : 'PDU offline'}</span>`;
        rec.heatPatch.visible = false; rec.leakRing.visible = false; continue;
      }
      kwTot += t.watts;
      if (t.temp != null) { tSum += t.temp; tN++; tMin = tMin == null ? t.temp : Math.min(tMin, t.temp); tMax = tMax == null ? t.temp : Math.max(tMax, t.temp); }
      if (t.hum != null) { hSum += t.hum; hN++; }
      if (t.leak) leaks.push(rec.def.dcimRack || rec.id);
      const capPct = Math.round(t.cap * 100); const capCls = t.cap > .95 ? 'bad' : t.cap > .8 ? 'warn' : 'ok';
      rec.telem.className = 'telem' + (t.leak ? ' leak' : capCls === 'bad' ? ' bad' : capCls === 'warn' ? ' warn' : '');
      rec.telem.innerHTML = `<div class="t-row"><b class="t-kw">${(t.watts / 1000).toFixed(2)}</b><span class="t-u">kW</span><span class="t-sep"></span><span class="t-v">${t.volts.toFixed(0)} V</span><span class="t-sep"></span><span class="t-v">${t.amps.toFixed(1)} A</span>${t.leak ? '<span class="t-leak">LEAK</span>' : ''}</div><div class="t-cap ${capCls}" title="${capPct}% of ${RATED_AMPS * t.pduCount} A · ${t.on}/${t.total} outlets on"><i style="width:${Math.min(100, capPct)}%"></i></div>`;
      rec.heatPatch.visible = S.heat; rec.heatPatch.material.color.set(heatColor(t.temp)); rec.heatPatch.material.emissive.set(heatColor(t.temp));
      rec.leakRing.visible = !!t.leak;
    }
    // one environment window for the whole lab (average of all PDU sensors)
    const env = $('#envPanel'); if (!env) return;
    if (!S.live.connected || (tN === 0 && hN === 0 && !leaks.length)) { env.classList.add('hidden'); return; }
    const tAvg = tN ? tSum / tN : null, hAvg = hN ? hSum / hN : null;
    const tCls = tAvg == null ? '' : tAvg > 35 ? 'bad' : tAvg > 24 ? 'warn' : 'ok';
    env.className = 'envpanel' + (leaks.length ? ' leak' : tCls === 'bad' ? ' bad' : tCls === 'warn' ? ' warn' : '');
    env.innerHTML = `<div class="e-title">Lab environment <small>avg of ${tN || hN} sensor${(tN || hN) === 1 ? '' : 's'}</small></div>
      <div class="e-row"><span class="e-ic">🌡</span><b class="e-${tCls}">${tAvg == null ? '—' : tAvg.toFixed(1) + '°C'}</b>${tN > 1 ? `<small>${tMin.toFixed(1)}–${tMax.toFixed(1)}</small>` : ''}</div>
      <div class="e-row"><span class="e-ic">💧</span><b>${hAvg == null ? '—' : hAvg.toFixed(0) + '%'}</b><small>humidity</small></div>
      <div class="e-row"><span class="e-ic">${leaks.length ? '⚠' : '●'}</span><b class="${leaks.length ? 'e-bad' : 'e-ok'}">${leaks.length ? 'LEAK · ' + leaks.join(', ') : 'no leaks'}</b></div>
      <div class="e-row e-foot"><small>${(kwTot / 1000).toFixed(2)} kW total</small></div>`;
  }
  $('#tHeat').onclick = () => { S.heat = !S.heat; $('#tHeat').classList.toggle('active', S.heat); updateTelemetry(); };

  // ───────────────────────────────────────────────────────────── quick-jump rack bar + zoom buttons
  function renderRackBar() {
    const bar = $('#rackBar'); if (!bar || !S.data) return;
    bar.innerHTML = S.data.setups.map(su => `<button data-jump="${su.id}" class="${S.selected === su.id ? 'on' : ''}"><span><span class="rb-dot" style="background:${STATUS_COLOR[su.status || 'unknown']}"></span>${esc(su.dcimRack || su.id)}</span><small>${esc(su.name.split('—')[0].replace('Rack', '').trim())}</small></button>`).join('') +
      S.data.storage.map(st => `<button data-jump="${st.id}" class="${S.selected === st.id ? 'on' : ''}"><span><span class="rb-dot" style="background:${STATUS_COLOR[st.status || 'unknown']}"></span>${st.id.replace('STORAGE-', 'ST-')}</span><small>${esc(st.name.split(' ').slice(0, 2).join(' '))}</small></button>`).join('');
    $$('[data-jump]', bar).forEach(b => b.onclick = () => select(b.dataset.jump, { fly: true }));
  }
  function zoomBy(f) { const dir = camera.position.clone().sub(controls.target); const len = Math.min(controls.maxDistance, Math.max(controls.minDistance, dir.length() * f)); dir.setLength(len); tweenCamera(controls.target.clone().add(dir), controls.target.clone(), 250); }
  function rotateBy(a) { const dir = camera.position.clone().sub(controls.target); dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), a); tweenCamera(controls.target.clone().add(dir), controls.target.clone(), 300); }
  $('#zIn').onclick = () => zoomBy(0.7); $('#zOut').onclick = () => zoomBy(1.4); $('#zL').onclick = () => rotateBy(Math.PI / 8); $('#zR').onclick = () => rotateBy(-Math.PI / 8);

  // ───────────────────────────────────────────────────────────── toasts / tabs
  function toast(msg, cls = '') { const t = document.createElement('div'); t.className = 'toast ' + cls; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3200); }
  $$('.tab').forEach(b => b.onclick = () => { $$('.tab').forEach(x => x.classList.remove('active')); b.classList.add('active'); ['tree', 'inv', 'unplaced'].forEach(id => $('#' + id).classList.toggle('hidden', id !== b.dataset.tab)); });

  // ───────────────────────────────────────────────────────────── boot
  function init(data) {
    // a browser draft is only restored if it was made on top of THIS exact dataset (otherwise a newer lab-data.json would be hidden by stale edits)
    S.dataBase = dataFingerprint(data);
    const draft = LS.get('draft', null);
    if (draft && draft.data && draft.data.meta && draft.base === S.dataBase) { data = draft.data; S.dirty = true; setTimeout(() => toast('Restored unsaved edits from this browser — Save or Discard', 'ok'), 800); }
    else if (draft) { LS.set('draft', null); if (draft.data) setTimeout(() => toast('lab-data.json changed on the server — old unsaved browser edits were dropped', 'err'), 800); }
    S.data = data; $('#ver').textContent = `twin v${data.meta.version} · ${data.meta.generated}`;
    document.title = `${data.meta.title} — Lab Manager`;
    setupFilterUI(); buildStatic(); computeModel(); buildItems();
    setLabelMode(LS.get('labelMode', 'setups'), true); updateSaveBar();
    $('#tHeat').classList.toggle('active', S.heat); document.body.classList.toggle('embed', S.embed); document.body.classList.toggle('kiosk', S.kiosk); $('#btnKiosk').classList.toggle('on', S.kiosk); document.body.classList.toggle('editmode', S.editMode); $('#btnEdit').classList.toggle('on', S.editMode); $('#btnEdit').textContent = S.editMode ? '✓ Editing' : 'Edit';
    resize(); VIEWS.orbit(); camera.position.copy(S.tween.p1); controls.target.copy(S.tween.t1v); S.tween = null; $('#vOrbit').classList.add('active');
    animate();
    const auto = S.settings.url || location.protocol.startsWith('http') || window.LAB_DEMO; // same-origin when served from the backend (LAB_DEMO = simulated backend in the preview bundle)
    if (S.settings.url) connect(); else if (auto) { api('/api/version').then(() => connect()).catch(() => {}); }
  }
  // debug handle (console): __twin.select('SETUP-003'), __twin.S.model.items …
  window.__twin = { S, scene, camera, controls, select, setView, connect, computeModel, buildItems, VIEWS, finishMove, startMove, resolveMoveTarget, pickAt, toggleEdit, toggleKiosk };
  const boot = window.LAB_DATA ? Promise.resolve(window.LAB_DATA) : fetch('lab-data.json', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  boot.then(init).catch(err => {
    console.warn('lab-data.json fetch failed:', err);
    $('#loadFallback').classList.remove('hidden');
    $('#fileJson').onchange = e => { const f = e.target.files[0]; if (!f) return; f.text().then(t => { $('#loadFallback').classList.add('hidden'); init(JSON.parse(t)); }).catch(er => toast('Invalid JSON: ' + er.message, 'err')); };
  });
})();
