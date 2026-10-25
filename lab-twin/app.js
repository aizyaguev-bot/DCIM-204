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
  const TYPE_BODY = { opt: '#2b2d33', kvm: '#1c1c20', pdu: '#1b1b20', chiller: '#e6e1d5', 'equip-switch': '#1a1d24', 'equip-patchpanel': '#3a3f47', 'equip-ups': '#26292e', 'equip-kvm': '#1c1c20', 'equip-pdu': '#1b1b20', 'equip-cable': '#3f3f46', 'equip-blank': '#3f3f46', 'equip-other': '#4b5058', cart: '#2f6fd6', ladder: '#f2c230', toolbox: '#2b2b2b', 'spare-chassis': '#c9bf9c', misc: '#8a8f97', other: '#8a8f97' };
  const NON_SERVER_LABEL = /^(empty|kvm[\s_-]*power|pdu|spare|free|n\/a|-+)$/i;
  const CABLE_COLORS = ['#d92b2b', '#d92b2b', '#1a1a1a', '#d92b2b', '#22c1a6', '#d92b2b', '#f4f4f5'];
  const EQUIP_LABEL = { switch: 'Switch', computer: 'Computer', patchpanel: 'Patch Panel', cable: 'Cable Mgmt', pdu: 'PDU', kvm: 'KVM', ups: 'UPS', blank: 'Blank Panel', other: 'Other' };
  const POLL_MS = 15000;
  // attention list: severity:kind priority (computeAttention sorts by this, then by setup)
  const SEVERITIES = ['crit', 'warn', 'info'];
  const SEV_LABEL = { crit: 'Critical', warn: 'Warning', info: 'Info' };
  const SEV_COLOR = { crit: '#f43f5e', warn: '#fbbf24', info: '#38bdf8' };
  const ATTN_ORDER = ['crit:leak', 'crit:pdu-down', 'crit:load', 'crit:temp', 'warn:opt-off', 'warn:opt-unknown', 'warn:kvm-down', 'warn:kvm-error', 'warn:load', 'warn:temp', 'warn:pdu-maint', 'warn:ping-down', 'warn:unplaced', 'warn:unmapped-rack', 'warn:not-in-dcim', 'info:offline', 'info:stale', 'info:auto-u', 'info:mapping'];
  const STALE_DAYS = 30, ATTN_TEMP_CRIT = 30, ATTN_TEMP_WARN = 27, ATTN_LOAD_CRIT = 0.95, ATTN_LOAD_WARN = 0.8;
  // Issues = something is wrong with the lab right now; data quality = the inventory needs a person's attention.
  const ISSUE_KINDS = new Set(['leak', 'pdu-down', 'load', 'temp', 'opt-off', 'opt-unknown', 'kvm-down', 'kvm-error', 'pdu-maint', 'ping-down', 'offline']);
  // Health colouring (default): what the object is doing now. Lifecycle status colouring (STATUS_COLOR) stays one menu away.
  const HEALTH = { up: { c: '#4ade80', t: 'Up' }, down: { c: '#f87171', t: 'Down' }, unknown: { c: '#a1a1aa', t: 'Unknown' }, maint: { c: '#c084fc', t: 'Maintenance' } };
  const SELECT_COLOR = '#38bdf8', NEUTRAL = '#71717a', SHELF_NEUTRAL = '#52525b';
  const PING_MS = 60000;
  const VIEW_LABEL = { orbit: 'Overview', front: 'Rack front', eye: 'Aisle', top: 'Top' };
  const CAT_LABEL = { setup: 'Rack', shelf: 'Shelf', storage: 'Storage', zone: 'Zone', structure: 'Structure' };
  const ITEM_KIND = { opt: 'Server', pdu: 'PDU', kvm: 'KVM', chiller: 'Chiller', 'equip-switch': 'Switch', 'equip-ups': 'UPS', 'equip-patchpanel': 'Patch panel', 'equip-kvm': 'KVM', 'equip-pdu': 'PDU', cart: 'Cart', ladder: 'Ladder', toolbox: 'Tool box', 'spare-chassis': 'Spare chassis', misc: 'Object' };

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
    live: { connected: false, devices: [], engineers: [], pdu: {}, kvm: {}, rackSlots: {}, rackOrder: {}, sw: {}, owners: {}, rackItems: {}, chillers: null, rackOverrides: {}, ping: {}, updatedAt: null, error: null, timer: null },
    labelMode: 'setups', wallsVisible: true, zonesVisible: true,
    colorBy: LS.get('colorBy', 'health') === 'status' ? 'status' : 'health', showPower: !!LS.get('showPower', false), envPanel: !!LS.get('envPanel', false),
    attnSeen: new Map(), drawerOpen: LS.get('drawerOpen', {}), racksList: LS.get('racksList', 'tree') === 'inv' ? 'inv' : 'tree',
    view: null, front: null, viewBeforeFront: null, pwMenuOpen: false, sheet: { size: 'half', tab: 'issues' }, livePill: { cls: 'offline', text: 'Offline · static data' },
    attention: [], attnFilter: LS.get('attnFilter', 'all'), attnDockCollapsed: LS.get('attnDockCollapsed', false), attnDockAll: false, detailStale: false, detailEdited: false, labelHover: null,
    pduOutletsSeen: LS.get('pduOutlets', {}),   // PDU device id -> outlet count it last reported while reachable (this browser)
    heat: LS.get('heat', false), embed: /[?&]embed=1/.test(location.search), editMode: false, kiosk: LS.get('kiosk', false) || /[?&]kiosk=1/.test(location.search), moveItem: null, lastInput: performance.now(),
    model: null,              // computed effective model (setups, shelves, items)
    tween: null,
  };
  // When this page first noticed each issue (no server time for most of them); kept for the browser tab only.
  try { const seen = JSON.parse(sessionStorage.getItem('twin.attnSeen') || '[]'); if (Array.isArray(seen)) S.attnSeen = new Map(seen.filter(e => Array.isArray(e) && Number.isFinite(e[1]))); } catch { /* storage blocked */ }

  // ───────────────────────────────────────────────────────────── three.js setup
  const canvas = $('#c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  const scene = new THREE.Scene();
  scene.fog = null;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  // Official OrbitControls matches the bundled Three.js r128 build.
  // One navigation controller owns input; equipment moves use the explicit Move tool.
  camera.up.set(0, 1, 0);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.rotateSpeed = 0.45;
  controls.panSpeed = 0.65;
  controls.zoomSpeed = 0.65;
  controls.enableDamping = true;
  controls.dampingFactor = 0.18;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.8;
  controls.maxDistance = 35;
  controls.minPolarAngle = 0.035;
  controls.maxPolarAngle = Math.PI / 2 - 0.025;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  canvas.style.touchAction = 'none';
  // prefers-reduced-motion: camera moves jump instead of gliding, no inertia, no pulsing.
  const reduceMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(reduceMotionQuery && reduceMotionQuery.matches);
  const applyMotionPreference = () => { controls.enableDamping = !reducedMotion(); };
  applyMotionPreference();
  if (reduceMotionQuery && reduceMotionQuery.addEventListener) reduceMotionQuery.addEventListener('change', applyMotionPreference);
  const activePointers = new Set();
  function cancelNavigation() {
    controls.cancel();
    S.tween = null;
    downPos = null;
    activePointers.forEach(id => { try { canvas.releasePointerCapture(id); } catch {} });
    activePointers.clear();
  }
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' && ![0, 1, 2].includes(e.button)) return;
    controls.cancel(); S.tween = null; S.lastInput = performance.now();
    activePointers.add(e.pointerId);
    if (e.pointerType !== 'touch') { try { canvas.setPointerCapture(e.pointerId); } catch {} }
    canvas.focus({ preventScroll: true });
  }, true);
  window.addEventListener('pointerup', e => {
    activePointers.delete(e.pointerId);
    if (!activePointers.size) controls.cancel();
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    downPos = null;
  });
  canvas.addEventListener('wheel', () => { S.tween = null; S.lastInput = performance.now(); }, { capture: true, passive: true });
  window.addEventListener('pointercancel', cancelNavigation);
  canvas.addEventListener('lostpointercapture', () => { if (activePointers.size) cancelNavigation(); });
  window.addEventListener('blur', () => { cancelNavigation(); cancelMove(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelNavigation(); cancelMove(); } });
  window.addEventListener('pointerdown', e => { if (e.target !== canvas && activePointers.size) cancelNavigation(); }, true);

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
  const DX = x => -x; // world x -> data x (WX is its own inverse; named for readability)
  // A data-space point (x across, y up, z depth) as a world-space vector. Walls, zones and free items sit directly
  // under the mirrored `world` group, so their label anchors must go through WX like every camera position.
  const W3 = (x, y, z) => new THREE.Vector3(WX(x), y, z);
  let selectionHelper = null;
  function clearSelectionHelper() {
    if (!selectionHelper) return;
    scene.remove(selectionHelper); selectionHelper.geometry.dispose(); selectionHelper.material.dispose(); selectionHelper = null;
  }

  const labelsLayer = $('#labels');
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function resize() {
    const vp = $('#viewport'); const w = Math.max(1, vp.clientWidth), h = Math.max(1, vp.clientHeight);
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    placeAttnDock();
  }
  window.addEventListener('resize', () => { cancelNavigation(); resize(); });
  const viewportObserver = new ResizeObserver(resize); viewportObserver.observe($('#viewport'));
  window.addEventListener('pagehide', () => { cancelNavigation(); controls.dispose(); viewportObserver.disconnect(); });

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
    m.userData.unique = true;   // one material per outline: disposeGroup() frees it on rebuild
    const l = new THREE.LineSegments(g, m); l.position.copy(mesh.position); l.rotation.copy(mesh.rotation); l.scale.copy(mesh.scale);
    if (dashed) l.computeLineDistances();
    l.userData.baseOpacity = m.opacity; l.renderOrder = 2;
    return l;
  }
  const uniqueMat = m => { m.userData.unique = true; return m; };   // created per build → disposed with its group
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
    const floor = box(W, 0.02, D, uniqueMat(new THREE.MeshBasicMaterial({ color: 0x1c1d21 })), W / 2, -0.01, D / 2); staticGroup.add(floor);
    // grid 0.6 m
    const pts = [];
    for (let x = 0; x <= W + 1e-6; x += 0.6) pts.push(x, 0.002, 0, x, 0.002, D);
    for (let z = 0; z <= D + 1e-6; z += 0.6) pts.push(0, 0.002, z, W, 0.002, z);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    staticGroup.add(new THREE.LineSegments(gg, uniqueMat(new THREE.LineBasicMaterial({ color: 0x2a2b30, transparent: true, opacity: 0.9 }))));
    // walls
    const wallMat = uniqueMat(new THREE.MeshBasicMaterial({ color: 0x3a3d44, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    const t = 0.08;
    (d.structure.walls || []).forEach(w => {
      const [x1, z1] = w.from, [x2, z2] = w.to; const len = Math.hypot(x2 - x1, z2 - z1);
      const m = box(len, H, t, wallMat, (x1 + x2) / 2, H / 2, (z1 + z2) / 2); m.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      const off = t / 2; // push outward so the interior face sits on the room boundary
      if (w.id === 'WALL-L') m.position.x -= off; if (w.id === 'WALL-R') m.position.x += off; if (w.id === 'WALL-F') m.position.z -= off; if (w.id === 'WALL-B') m.position.z += off;
      wallsGroup.add(m); wallsGroup.add(edges(m, '#52525b'));
    });
    // wall base line (visible even with translucent walls)
    const base = [0, 0.01, 0, W, 0.01, 0, W, 0.01, 0, W, 0.01, D, W, 0.01, D, 0, 0.01, D, 0, 0.01, D, 0, 0.01, 0];
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
    staticGroup.add(new THREE.LineSegments(bg, uniqueMat(new THREE.LineBasicMaterial({ color: 0x3f3f46 }))));
    // entrance: a glowing floor strip along the entrance-wall door + an ENTRANCE label (not an object: not searchable or pickable)
    if (S.entrance?.el) S.entrance.el.remove(); S.entrance = null;
    const entry = (d.structure.doors || []).find(dr => dr.wall === 'WALL-F');
    if (entry) {
      const strip = box(entry.width, 0.006, 0.07, mat('#a3e635', { emissive: '#a3e635', emissiveIntensity: .9, rough: 1, metal: 0 }), entry.pos[0] + entry.width / 2, 0.006, entry.pos[1] + 0.06);
      staticGroup.add(strip);
      const el = document.createElement('div'); el.className = 'entrance-lbl'; el.textContent = 'ENTRANCE'; el.setAttribute('aria-hidden', 'true'); labelsLayer.appendChild(el);
      S.entrance = { el, anchor: W3(entry.pos[0] + entry.width / 2, 0.02, entry.pos[1] - 0.12) };
    }
    // doors
    (d.structure.doors || []).forEach(dr => {
      const onZ = dr.wall === 'WALL-L' || dr.wall === 'WALL-R';
      const m = onZ ? box(0.12, dr.height, dr.width, mat('#4b4f57', { rough: .8, opacity: .7 }), dr.pos[0], dr.height / 2, dr.pos[1] + dr.width / 2)
                    : box(dr.width, dr.height, 0.12, mat('#4b4f57', { rough: .8, opacity: .7 }), dr.pos[0] + dr.width / 2, dr.height / 2, dr.pos[1]);
      const low = dr.confidence === 'low';
      if (low) m.material = mat('#4b4f57', { rough: .8, opacity: .45, unique: true });
      wallsGroup.add(m); wallsGroup.add(edges(m, low ? '#f87171' : '#71717a', low));
      const rec = reg({ id: dr.id, cat: 'structure', def: dr, group: m, meshes: [m], edges: [], status: 'active', conf: dr.confidence, zone: null, anchor: W3(m.position.x, dr.height + 0.05, m.position.z) });
      makeLabel(rec, 'item' + (low ? ' low' : ''), `${esc(dr.id)}<small>door${low ? ' — verify' : ''}</small>`);
    });
    // windows
    (d.structure.windows || []).forEach(wn => {
      const onZ = wn.wall === 'WALL-L' || wn.wall === 'WALL-R';
      const glass = mat('#7dd3fc', { opacity: .35, emissive: '#7dd3fc', emissiveIntensity: .25, unique: true });
      const m = onZ ? box(0.1, wn.height, wn.width, glass, wn.pos[0], wn.sill + wn.height / 2, wn.pos[1] + wn.width / 2)
                    : box(wn.width, wn.height, 0.1, glass, wn.pos[0] + wn.width / 2, wn.sill + wn.height / 2, wn.pos[1]);
      wallsGroup.add(m); wallsGroup.add(edges(m, '#7dd3fc', wn.confidence === 'low'));
      const rec = reg({ id: wn.id, cat: 'structure', def: wn, group: m, meshes: [m], edges: [], status: 'active', conf: wn.confidence, zone: null, anchor: W3(m.position.x, wn.sill + wn.height + 0.05, m.position.z) });
      makeLabel(rec, 'item', `${esc(wn.id)}<small>window</small>`);
    });
    // pillar
    (d.structure.pillars || []).forEach(p => {
      const cx = Math.min(Math.max(p.pos[0] - p.radius * 0.8, 0), W), cz = Math.min(Math.max(p.pos[1] - p.radius * 0.8, 0), D);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, H, 32), mat('#7c7c86', { opacity: .55, unique: true })); m.position.set(cx, H / 2, cz);
      wallsGroup.add(m);
      const rec = reg({ id: p.id, cat: 'structure', def: p, group: m, meshes: [m], edges: [], status: 'active', conf: p.confidence, zone: null, anchor: W3(cx, H * 0.75, cz) });
      makeLabel(rec, 'item', `${esc(p.id)}<small>column</small>`);
    });
    // fixtures (E-stop)
    (d.structure.fixtures || []).forEach(f => {
      const m = box(0.06, 0.1, 0.1, mat('#ef4444', { emissive: '#ef4444', emissiveIntensity: .4 }), f.pos[0] + 0.04, f.height, f.pos[1]);
      wallsGroup.add(m);
      const rec = reg({ id: f.id, cat: 'structure', def: f, group: m, meshes: [m], edges: [], status: 'active', conf: f.confidence, zone: null, anchor: W3(f.pos[0] + 0.1, f.height + 0.1, f.pos[1]) });
      makeLabel(rec, 'item', `${esc(f.id)}<small>emergency stop</small>`);
    });
    // ceiling lights
    (d.structure.ceilingLights || []).forEach(([x, z]) => {
      const m = box(1.2, 0.02, 0.3, mat('#f8fafc', { emissive: '#f8fafc', emissiveIntensity: .9 }), x, H - 0.01, z); wallsGroup.add(m);
    });
    // zones
    (d.zones || []).forEach(zn => {
      const [x1, z1, x2, z2] = zn.bounds;
      const m = box(x2 - x1, 0.004, z2 - z1, mat(zn.color, { opacity: .05, unique: true, rough: 1 }), (x1 + x2) / 2, 0.006, (z1 + z2) / 2);
      m.renderOrder = 1; zonesGroup.add(m);
      const e = setEdgeOp(edges(m, zn.color, zn.confidence === 'low'), .35); zonesGroup.add(e);
      const rec = reg({ id: zn.id, cat: 'zone', def: zn, group: m, meshes: [m], edges: [e], status: 'active', conf: zn.confidence, zone: zn.id, anchor: W3((x1 + x2) / 2, 0.02, (z1 + z2) / 2) });
      makeLabel(rec, 'zone', `<span class="zn-sw" style="background:${esc(zn.color)}"></span>${esc(zn.id)} · ${esc(rowLabel(zn))}`);
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
    // status frame outline (colored edges of the rack envelope) + a dashed twin shown when the health is unknown
    const env = box(dd, h, w, mat('#000', { opacity: 0 }), 0, h / 2, 0); env.visible = false; g.add(env);
    const e = setEdgeOp(edges(env, col), .5); g.add(e); eds.push(e);
    const ed = setEdgeOp(edges(env, HEALTH.unknown.c, true), .75); ed.visible = false; g.add(ed); eds.push(ed);
    // health cap: a thin coloured plate on top of the rack (not pickable), painted by paintRacks()
    const cap = box(dd - 2 * p, 0.014, w - 2 * p, uniqueMat(new THREE.MeshBasicMaterial({ color: 0x3f3f46 })), 0, h + 0.008, 0); g.add(cap);
    staticGroup.add(g); g.updateMatrixWorld(true);
    const rec = reg({ id: su.id, cat: 'setup', def: su, group: g, meshes, edges: eds, status, conf: su.confidence, zone: su.zone, setup: su.id, anchor: localToWorld(g, 0, h + 0.12, 0), tpl, cap, envSolid: e, envDashed: ed });
    makeLabel(rec, 'setup', `<span class="lp" style="background:${col}"></span><span class="ln">${esc(rackName(su))}</span><span class="ls"></span><span class="lt"></span>`);
    rec.label.title = `${su.id} · ${su.name}`;
    rec.labelTel = rec.label.querySelector('.lt');
    rec.label.addEventListener('mouseenter', () => { S.labelHover = su.id; });
    rec.label.addEventListener('mouseleave', () => { if (S.labelHover === su.id) S.labelHover = null; });
    // full telemetry card (power / voltage / current / capacity / temp / humidity / leak) — filled by updateTelemetry();
    // shown only for the selected / hovered rack or with Heat on (the compact kW · A line lives in the setup label)
    const tel = document.createElement('div'); tel.className = 'telem'; tel.dataset.id = su.id; tel.innerHTML = '<span class="t-muted">no live data</span>';
    tel.addEventListener('click', e => { e.stopPropagation(); select(su.id, { fly: true }); }); labelsLayer.appendChild(tel);
    rec.telem = tel; rec.telemAnchor = localToWorld(g, 0, h + 0.55, 0);
    // attention badge on the rack front (DOM only, never pickable) — filled by renderAttention(), placed by updateLabels()
    const attnEl = document.createElement('div'); attnEl.className = 'attn-badge'; attnEl.dataset.id = su.id; attnEl.setAttribute('aria-hidden', 'true'); attnEl.style.display = 'none'; labelsLayer.appendChild(attnEl);
    rec.attnEl = attnEl; rec.attnN = 0; rec.attnAnchor = localToWorld(g, dd / 2 + 0.02, h - 0.18, 0);
    // heat-map patch under the rack + leak ring (hidden until live data / toggle)
    const patch = box(dd + 0.3, 0.012, w + 0.3, mat('#22c55e', { opacity: .45, unique: true, rough: 1, emissive: '#22c55e', emissiveIntensity: .35 }), 0, 0.012, 0); patch.visible = false; g.add(patch); rec.heatPatch = patch;
    const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(dd, w) * 0.55, Math.max(dd, w) * 0.62, 48), uniqueMat(new THREE.MeshBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: .8, side: THREE.DoubleSide }))); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; ring.visible = false; g.add(ring); rec.leakRing = ring;

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
      makeLabel(srec, 'shelf', `${esc(sh.id)}<small>L${esc(sh.level)}</small>`);
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
    makeLabel(rec, 'storage', `<span class="lp" style="background:${col}"></span><span class="ln">${esc(storageName(sd))}</span>`); rec.label.title = `${sd.id} · ${sd.name}`;
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
    makeLabel(rec, 'storage', `<span class="lp" style="background:${col}"></span><span class="ln">${esc(storageName(sd))}</span>`); rec.label.title = `${sd.id} · ${sd.name}`;
    return rec;
  }

  // ───────────────────────────────────────────────────────────── items
  function buildItems(opts = {}) {
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

    const byHealth = S.colorBy === 'health';
    model.items.forEach(it => {
      const status = it.effStatus; const health = itemHealth(it); const col = byHealth ? (health ? HEALTH[health.h].c : NEUTRAL) : STATUS_COLOR[status];
      const pconf = it.placementConfidence || it.confidence || 'medium'; const op = byHealth ? 1 : CONF_OPACITY[pconf] ?? .8;
      // dashed outline: health unknown (Health colouring) or low placement confidence (Lifecycle colouring)
      const dashed = byHealth ? health?.h === 'unknown' : pconf === 'low';
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
        // Shelf layout (like the Lab Manager rack view): ONE PC (the OPT) on the left, ONE unit (switch under test or
        // other equipment) on the right. Rack local frame: front = +x, width along z. Viewer's left = −z (world is x-mirrored).
        const sh = S.recs.get(it.shelf); const su = S.recs.get(sh.setup); const rt = su.tpl;
        const siblings = byShelf.get(it.shelf);
        const pcs = siblings.filter(x => x.type === 'opt'); const units = siblings.filter(x => x.type !== 'opt');
        const usable = rt.width - 2 * rt.profile - 0.06; const leftW = 0.36, rightW = usable - leftW;
        const isPC = it.type === 'opt';
        const grp = isPC ? pcs : units; const n = grp.length, idx = grp.indexOf(it);
        const slotW = (isPC ? leftW : rightW) / n; const zc = -usable / 2 + (isPC ? 0 : leftW) + slotW * (idx + 0.5);
        g = new THREE.Group();
        let w, d, h;
        if (isPC) { w = 0.17; h = 0.24; d = 0.31; }                               // small desktop PC — mini tower standing upright
        else if (it.type === 'equip-switch') { w = 0.44; h = 0.066; d = 0.50; }     // NVIDIA-style 1U switch under test (Lab Manager rack item of type switch)
        else if (it.type === 'kvm') { w = 0.44; d = 0.30; h = 0.045; }
        else { w = 0.40; d = 0.35; h = 0.05; }                                      // other rack equipment (UPS, SSD box …)
        w = Math.min(w, slotW - 0.02);
        const body = makeBox(d, h, w, bodyCol); body.position.set(0.02, sh.y + h / 2, zc); g.add(body); meshes.push(body);
        const fx = d / 2 + 0.02 + 0.002; // front face x (local)
        const dark = c => mat(c, { rough: .8, opacity: op, unique: true });
        if (isPC) {
          // upright mini tower: bezel, power button (status colour) on top, optical-drive slot, 2 USB + audio, vent grille, silver brand tag
          g.add(box(0.006, h * .96, w * .94, mat('#4a4e56', { rough: .55, metal: .25, opacity: op, unique: true }), fx, sh.y + h / 2, zc));
          g.add(box(0.004, h * .96, w * .94, mat('#22242a', { rough: .6, opacity: op, unique: true }), -d / 2 + 0.02 - 0.002, sh.y + h / 2, zc));      // rear panel
          g.add(led(fx + 0.006, sh.y + h * .90, zc, col, 0.016));                                                                                      // power button
          g.add(box(0.006, 0.006, w * .72, dark('#15161a'), fx + 0.004, sh.y + h * .74, zc));                                                          // DVD slot
          g.add(box(0.006, 0.002, w * .72, mat('#6b7078', { metal: .6, rough: .4, opacity: op, unique: true }), fx + 0.005, sh.y + h * .74 - 0.006, zc));
          for (let i = 0; i < 2; i++) g.add(box(0.006, 0.006, 0.013, dark('#0b0b0e'), fx + 0.004, sh.y + h * .58, zc - 0.03 + i * 0.024));             // USB
          g.add(box(0.006, 0.007, 0.007, mat('#22c55e', { emissive: '#22c55e', emissiveIntensity: .4, opacity: op, unique: true }), fx + 0.004, sh.y + h * .58, zc + 0.04)); // audio jack
          for (let i = 0; i < 6; i++) g.add(box(0.006, 0.003, w * .7, dark('#1a1b1f'), fx + 0.004, sh.y + h * .12 + i * 0.011, zc));                 // vents
          g.add(box(0.006, 0.012, 0.036, mat('#c0c4cc', { metal: .8, rough: .3, opacity: op, unique: true }), fx + 0.004, sh.y + h * .30, zc));       // brand tag
          if (status === 'active') g.add(led(fx + 0.006, sh.y + h * .84, zc + w * .3, '#f59e0b', 0.007));                                             // HDD activity
          // power + network cables from the rear, down to the rack post
          const postZ = -(rt.width / 2 - rt.profile - 0.02), postX = rt.depth / 2 - rt.profile; const bx = -d / 2 + 0.02;
          const nc = 1 + Math.floor(rnd() * 2);
          for (let i = 0; i < nc; i++) { const y0 = sh.y + h * (.3 + rnd() * .4), z0 = zc + (rnd() - .5) * w * .5; const cc = CABLE_COLORS[Math.floor(rnd() * CABLE_COLORS.length)]; g.add(cable([[bx, y0, z0], [bx - 0.08 - rnd() * 0.05, y0 - 0.1, z0 + (postZ - z0) * 0.5], [fx - 0.1, sh.y - 0.1 - rnd() * 0.1, postZ * 0.95], [postX, sh.y - 0.16 - rnd() * 0.1, postZ]], cc)); }
        } else if (it.type === 'equip-switch') {
          // faceplate, 2 × 12 QSFP cages, link LEDs, NVIDIA badge + green accent, rack ears, DAC cable to the PC
          g.add(box(0.006, h * .94, w * .98, mat('#23262e', { rough: .55, metal: .35, opacity: op, unique: true }), fx, sh.y + h / 2, zc));
          const cageW = 0.02, gap = 0.008, cols = Math.min(12, Math.floor((w * .78) / (cageW + gap))); const z0 = zc - (cols * (cageW + gap) - gap) / 2 + cageW / 2 + w * .04;
          for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) {
            const y = sh.y + h * (r ? .66 : .34), z = z0 + c * (cageW + gap);
            g.add(box(0.006, 0.017, cageW, mat('#0d0e12', { metal: .6, rough: .4, opacity: op, unique: true }), fx + 0.004, y, z));
            if (status === 'active' && rnd() < 0.35) g.add(led(fx + 0.007, y + 0.013, z + cageW / 2 - 0.004, rnd() < 0.7 ? '#76b900' : '#f59e0b', 0.005));
          }
          g.add(box(0.006, 0.014, 0.05, mat('#d4d4d8', { metal: .7, rough: .3, opacity: op, unique: true }), fx + 0.004, sh.y + h * .78, zc - w / 2 + 0.045));   // badge
          g.add(box(0.006, 0.012, 0.012, mat('#76b900', { emissive: '#76b900', emissiveIntensity: .9, opacity: op, unique: true }), fx + 0.005, sh.y + h * .78, zc - w / 2 + 0.014));
          g.add(box(0.006, 0.005, w * .92, mat('#76b900', { emissive: '#76b900', emissiveIntensity: .7, opacity: op, unique: true }), fx + 0.004, sh.y + h * .07, zc));  // accent
          g.add(led(fx + 0.007, sh.y + h * .78, zc + w / 2 - 0.03, col, 0.009)); g.add(led(fx + 0.007, sh.y + h * .78, zc + w / 2 - 0.05, '#3b82f6', 0.007));
          [-1, 1].forEach(s => g.add(box(0.02, h * .9, 0.014, mat('#9aa0a8', { metal: .7, rough: .35, opacity: op, unique: true }), fx - 0.01, sh.y + h / 2, zc + s * (w / 2 + 0.008))));
          const host = pcs[0]; if (host) { const zp = -usable / 2 + leftW / 2 + 0.085, ys = sh.y + h * .34, yp = sh.y + 0.24 * .45; g.add(cable([[fx + 0.004, ys, z0], [fx + 0.16, ys - 0.06, (z0 + zp) / 2], [fx - 0.08, yp, zp], [-0.13, yp, zp]], '#22c1a6', 0.005)); }
        } else {
          // generic equipment: silver band, port row, type stripe, status LED
          g.add(box(0.006, h * .8, w * .94, mat('#9aa0a8', { metal: .7, rough: .35, opacity: op, unique: true }), fx, sh.y + h / 2, zc));
          g.add(box(0.008, Math.min(0.022, h * .35), w * .7, dark('#111114'), fx + 0.003, sh.y + h * .42, zc + w * .05));
          g.add(box(0.008, h * .55, 0.012, mat(stripeCol, { emissive: stripeCol, emissiveIntensity: .8, opacity: op, unique: true }), fx + 0.003, sh.y + h / 2, zc - w / 2 + 0.02));
          g.add(led(fx + 0.006, sh.y + h * .78, zc - w / 2 + 0.06, col));
          const postZ = rt.width / 2 - rt.profile - 0.02, postX = rt.depth / 2 - rt.profile; const y0 = sh.y + h * .45;
          g.add(cable([[fx, y0, zc], [fx + 0.1, y0 - 0.1, zc + (postZ - zc) * 0.4], [postX, sh.y - 0.12, postZ]], CABLE_COLORS[Math.floor(rnd() * CABLE_COLORS.length)]));
        }
        const e = edges(body, col, dashed); g.add(e); eds.push(e);
        su.group.add(g);
        anchor = () => localToWorld(su.group, 0.02 + d / 2, sh.y + h + 0.02, zc);
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
        const dim = byHealth ? !health || health.h === 'unknown' : status === 'unknown'; const lit = byHealth ? health?.h === 'up' : status === 'active';
        shelves.forEach(sh => { meshes.push(sh.strip); sh.strip.material.emissive = new THREE.Color(col); sh.strip.material.emissiveIntensity = dim ? .08 : .35; sh.led.visible = lit; });
        const top = shelves.reduce((a, s) => Math.max(a, s.y), 0);
        anchor = () => localToWorld(su.group, -su.tpl.depth / 2 + 0.1, top + 0.32, 0);
      } else if (it.storage && S.recs.has(it.storage) && it.type === 'spare-chassis') {
        // tray stands have tray heights; a plain cabinet has none, so chassis stack inside it from the floor
        const st = S.recs.get(it.storage); g = new THREE.Group();
        const cabH = st.def?.size?.[2] || 1.8; const levels = st.trayY || Array.from({ length: Math.max(1, Math.floor((cabH - 0.15) / 0.06)) }, (_, i) => 0.08 + i * 0.06);
        const q = Math.max(1, Math.min(it.quantity || 1, levels.length));
        for (let i = 0; i < q; i++) { const m = makeBox(0.40, 0.045, 0.44, bodyCol); m.material.opacity = op; m.position.set(0, levels[i] + 0.03, 0); g.add(m); meshes.push(m); eds.push(edges(m, col, dashed)); g.add(box(0.006, 0.02, 0.36, mat('#3f3f46', { rough: .8, opacity: op, unique: true }), 0.204, levels[i] + 0.03, 0)); }
        eds.forEach(e => g.add(e)); st.group.add(g); anchor = () => localToWorld(st.group, 0.3, levels[q - 1] + 0.12, 0);
      } else if (it.pos && it.size) {
        const [w, d, h] = it.size; const y0 = it.y || 0; g = new THREE.Group(); g.position.set(it.pos[0], y0, it.pos[1]);
        const body = makeBox(w, h, d, bodyCol); body.position.set(0, h / 2, 0); g.add(body); meshes.push(body);
        g.add(led(w / 2 * .8, h + 0.008, d / 2 * .8, col, 0.02));
        if (it.type === 'cart') { g.add(box(w * .8, 0.02, d * .6, mat('#0b0b0e', { rough: .4, opacity: op, unique: true }), 0, h + 0.01, 0)); g.add(box(0.04, 0.5, 0.04, mat('#2f6fd6', { rough: .5, opacity: op, unique: true }), 0, h + 0.25, -d / 2 * .6)); }
        if (it.type === 'ladder') { for (let i = 1; i <= 3; i++) g.add(box(w * .9, 0.02, 0.06, mat('#9ca3af', { metal: .5, rough: .4, opacity: op, unique: true }), 0, h * i / 3.5, -d / 2 + d * i / 4)); }
        const e = edges(body, col, dashed); g.add(e); eds.push(e);
        itemsGroup.add(g); anchor = W3(it.pos[0], y0 + h + 0.05, it.pos[1]);
      } else {
        // unplaced — no geometry
        S.recs.set(it.id, { id: it.id, cat: 'item', def: it, group: null, meshes: [], edges: [], status, conf: it.confidence, zone: it.zone || null, setup: it.setup || null, shelf: null, unplaced: true, item: it });
        return;
      }
      if (g && it.placement !== 'rack-strips') S.itemGroups.push(g);
      const rec = reg({ id: it.id, cat: 'item', def: it, item: it, group: g, meshes, edges: eds, status, conf: it.confidence, pconf, zone: it.zone || null, setup: it.setup || null, shelf: it.shelf || null, anchor });
      const sub = it.type === 'opt' ? (it.live?.inDcim ? `${String(it.live.state || 'unknown').toUpperCase()}${' · ' + (it.live.watts == null ? '\u2014' : Math.round(it.live.watts) + 'W')}${it.live.sw ? ' · ' + it.live.sw.switch + (it.live.sw.port ? '·' + it.live.sw.port : '') : ''}` : `outlet #${it.dcim?.outlet ?? '?'}`) : it.type === 'equip-switch' ? `switch under test${it.live?.u ? ' · U' + it.live.u : ''}` : (it.typeLabel || it.type);
      const named = it.type === 'opt' || it.type.startsWith('equip-');
      makeLabel(rec, 'item' + (dashed ? ' low' : ''), `<span class="lp" style="background:${col}"></span>${esc(named ? it.name : it.id)}<small>${esc(it.type === 'opt' ? it.id + ' · ' + sub : sub)}</small>`);
    });
    S.attention = computeAttention(S.model, S.live, S.recs);
    noteAttentionSeen(); paintRacks();
    applyFilters(); updateTelemetry(); renderAttention(); renderLegend();
    if (S.selected && !S.recs.has(S.selected)) closeDetail();
    else if (S.selected) select(S.selected, { keepCamera: true, refresh: !!opts.refresh });
    if (S.front) renderRackFront();
  }

  // ───────────────────────────────────────────────────────────── effective model (static JSON + overrides + live)
  function ov() { return {}; }                       // legacy — edits now mutate S.data directly
  function dcimRackOf(su) { return su.dcimRack; }
  function effStatus(def) { return def.status || 'unknown'; }
  function isDefaultOutletLabel(label) { return !label || /^(outlet\s*\d+|port\s*\d+|\s*)$/i.test(label.trim()); }
  // A computer label: not a default "Outlet N" and not "empty" / "KVM Power" / a placeholder. Filtered BEFORE the U
  // assignment, exactly like Lab Manager's rack view (DcimView.buildRackRows), so both show the same shelf/U mapping.
  const isServerLabel = label => !isDefaultOutletLabel(label) && !NON_SERVER_LABEL.test(label.trim());
  const optKey = s => (s || '').trim().toLowerCase();
  // Live-data warnings are shown next to the notes, never written into them (the editor saves notes to lab-data.json).
  // Older saves may already contain the appended text, so it is stripped wherever notes are shown or saved.
  const LIVE_WARN = { notInDcim: 'Not present in the live DCIM labels.', notInRackItems: 'Not present in the Lab Manager rack items.' };
  const LIVE_WARN_RE = / ?⚠ Not present in the (?:live DCIM labels|Lab Manager rack items)\./g;
  const cleanNotes = s => String(s || '').replace(LIVE_WARN_RE, '').trim();

  function computeModel() {
    const d = S.data; const live = S.live; const uTopDown = (d.dcim?.uNumbering || 'top-down') === 'top-down';
    const setups = d.setups.map(s => ({ ...s, dcimRack: dcimRackOf(s) }));
    const setupByRack = {}; setups.forEach(s => { if (s.dcimRack) setupByRack[s.dcimRack] = s.id; });
    const shelvesOf = sid => d.shelves.filter(sh => sh.setup === sid).sort((a, b) => a.level - b.level);
    const shelfForU = (sid, u) => { const sh = shelvesOf(sid); const n = sh.length; if (!Number.isInteger(Number(u)) || u < 1 || u > n) return null; const idx = uTopDown ? n - Number(u) : Number(u) - 1; return sh[idx].id; };

    let items = d.items.map(it => ({ ...it, ...pickOv(it.id) }));

    if (live.connected) {
      const pdus = live.devices.filter(x => x.kind === 'pdu');
      const kvms = live.devices.filter(x => x.kind === 'kvm');
      // 1) OPT servers exactly like DcimView.servers
      const servers = new Map();
      pdus.forEach(pdu => {
        const stored = pdu.labels || {}; const liveOut = live.pdu[pdu.id]?.reachable ? live.pdu[pdu.id].outlets || [] : []; const liveByN = Object.fromEntries(liveOut.map(o => [String(o.number), o]));
        Object.entries(stored).forEach(([num, label]) => {
          if (!isServerLabel(label)) return; const key = optKey(label); if (servers.has(key)) return;
          const lo = liveByN[num];
          servers.set(key, { key, name: label.trim(), rack: live.rackOverrides[key] || pdu.rack || null, pduId: pdu.id, pduName: pdu.name, outlet: parseInt(num, 10), state: lo?.state ?? 'unknown', watts: lo?.watts ?? null });
        });
        liveOut.forEach(o => {
          if (!isServerLabel(o.label)) return; const key = optKey(o.label);
          if (servers.has(key)) { const e = servers.get(key); e.state = o.state; e.watts = o.watts ?? null; return; }
          servers.set(key, { key, name: o.label.trim(), rack: live.rackOverrides[key] || pdu.rack || null, pduId: pdu.id, pduName: pdu.name, outlet: o.number, state: o.state, watts: o.watts ?? null });
        });
      });
      // KVM cross-reference
      const kvmIdx = {};
      kvms.forEach(k => { Object.entries(k.labels || {}).forEach(([p, lbl]) => { const key = optKey(lbl); (kvmIdx[key] = kvmIdx[key] || []).push({ kvm: k.id, kvmName: k.name, port: parseInt(p, 10), status: live.kvm[k.id]?.error ? 'error' : live.kvm[k.id]?.ports?.find(x => x.number === parseInt(p, 10))?.status }); }); });
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
      items.filter(i => i.type === 'opt' && !seen.has(i.dcim?.optKey || optKey(i.name))).forEach(i => { i.live = { inDcim: false }; i.liveWarning = LIVE_WARN.notInDcim; });
      // 2) PDU / KVM devices
      items.forEach(i => {
        if (i.type === 'pdu' && i.dcim?.deviceId) { const dev = pdus.find(p => p.id === i.dcim.deviceId); const st = live.pdu[i.dcim.deviceId]; if (dev) { i.live = { device: dev, status: st, reachable: st?.reachable ?? null }; if (dev.rack && setupByRack[dev.rack]) { i.setup = setupByRack[dev.rack]; i.zone = setups.find(x => x.id === i.setup)?.zone; } } }
        if (i.type === 'kvm' && i.dcim?.deviceId) { const dev = kvms.find(k => k.id === i.dcim.deviceId); const st = live.kvm[i.dcim.deviceId]; if (dev) i.live = { device: dev, status: st, reachable: st?.reachable ?? null }; }
      });
      // live-only PDUs (e.g. racks added in DCIM)
      pdus.filter(p => !items.some(i => i.type === 'pdu' && i.dcim?.deviceId === p.id)).forEach(p => {
        const sid = setupByRack[p.rack] || null; const id = 'LIVE-' + p.id;
        items.push({ id, name: p.name, category: 'item', type: 'pdu', typeLabel: 'Raritan PDU (live)', setup: sid, placement: sid ? 'rack-strips' : null, zone: sid ? setups.find(x => x.id === sid)?.zone : null, status: 'active', confidence: 'high', photos: [], dcim: { deviceId: p.id, outlets: p.port_count > 0 ? p.port_count : null, labels: p.labels || {} }, live: { device: p, status: live.pdu[p.id], reachable: live.pdu[p.id]?.reachable ?? null }, notes: 'Discovered live from the DCIM backend.', ...pickOv(id) });
      });
      // 3) rack_items (custom equipment: switches, patch panels …)
      Object.entries(live.rackItems || {}).forEach(([rack, list]) => (list || []).forEach(ci => {
        const sid = setupByRack[rack] || null; const id = 'LIVE-' + ci.id;
        const history = Array.isArray(ci.tracking_history) ? ci.tracking_history : []; const owner = live.owners?.['item:' + ci.id] || null;
        items.push({ id, name: ci.name, serial_number: ci.serial_number || '', barcode: ci.barcode || '', shelf_position: ci.shelf_position || '', last_seen_at: ci.last_seen_at || null, tracking: { count: history.length, last: history[history.length - 1] || null }, category: 'item', type: 'equip-' + (ci.type || 'other'), typeLabel: (EQUIP_LABEL[ci.type] || 'Equipment') + ' (DCIM rack item)', setup: sid, shelf: sid && ci.u ? shelfForU(sid, ci.u) : null, zone: sid ? setups.find(x => x.id === sid)?.zone : null, status: 'active', confidence: 'high', placementConfidence: ci.u ? 'medium' : 'low', photos: [], notes: ci.notes || '', owner, live: { rack, u: ci.u, owner }, ...pickOv(id) });
      }));
      // 4) chillers from DCIM
      if (live.chillers?.units?.length) {
        live.chillers.units.forEach(ch => {
          const sid = ch.rack ? setupByRack[ch.rack] : null; const existing = items.find(i => i.type === 'chiller' && i.setup === sid && !i.live);
          if (existing) existing.live = { chiller: ch }; else if (sid) items.push({ id: 'LIVE-' + ch.id, name: ch.name || 'Chiller', category: 'item', type: 'chiller', setup: sid, placement: 'bottom-bay', zone: setups.find(x => x.id === sid)?.zone, status: 'active', confidence: 'medium', photos: [], notes: 'From DCIM chillers.json', live: { chiller: ch }, ...pickOv('LIVE-' + ch.id) });
        });
      }
    }
    // outlet labels that are not servers ("empty", "KVM Power" …) must not become PCs on a shelf
    items = items.filter(it => !(it.type === 'opt' && NON_SERVER_LABEL.test(it.name || '')));
    items.forEach(it => {
      it.effStatus = it.status || 'unknown';
      if (it.type === 'opt' && it.live?.inDcim) it.effStatus = it.live.state === 'on' ? 'active' : it.live.state === 'off' ? 'inactive' : (it.status || 'unknown');
      if (it.type === 'pdu' && it.live) it.effStatus = it.live.reachable === false ? 'inactive' : it.live.reachable ? 'active' : it.effStatus;
      // reachable + error = the KVM answered but its sign-in / API failed: not usable, never "active"
      if (it.type === 'kvm' && it.live) it.effStatus = it.live.reachable === false || it.live.status?.error ? 'inactive' : it.live.reachable ? 'active' : it.effStatus;
      if (it.type === 'opt' && it.live?.inDcim) it.owner = it.live.owner || null;   // DCIM (AssetOwner) is the owner source for live OPTs
    });
    // Equipment next to the PC (switch under test, UPS, SSD box …) = Lab Manager "rack items". When connected, the live
    // rack items are authoritative: a JSON equipment record with the same name is replaced by the live one (no doubles).
    if (live.connected) {
      const norm = x => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const liveEq = items.filter(i => i.id.startsWith('LIVE-') && i.type.startsWith('equip-'));
      const liveNames = new Set(liveEq.map(i => norm(i.name)));
      const liveShelves = new Set(liveEq.map(i => i.shelf).filter(Boolean));
      items = items.filter(i => !(i.type.startsWith('equip-') && !i.id.startsWith('LIVE-') && (liveNames.has(norm(i.name)) || (i.shelf && liveShelves.has(i.shelf)))));
      items.forEach(i => { if (i.type.startsWith('equip-') && !i.id.startsWith('LIVE-') && i.setup && setups.find(x => x.id === i.setup)?.dcimRack) i.liveWarning = LIVE_WARN.notInRackItems; });
    }
    // DCIM racks without a physical setup
    const liveRacks = live.connected ? [...new Set(live.devices.filter(x => x.kind === 'pdu' || x.kind === 'rack').map(x => x.rack).filter(Boolean))] : (d.dcim?.pdus || []).map(p => p.rack);
    const unmappedRacks = liveRacks.filter(r => !setupByRack[r]);
    S.model = { setups, setupByRack, items, unmappedRacks, liveRacks };
  }
  function pickOv() { return {}; }

  // ───────────────────────────────────────────────────────────── health, names, rows, ping, feeds (pure helpers)
  // Server identity exactly like the backend ping monitor (server_identity): "Opt114 (VM)" → "opt114", else the trimmed name.
  function pingKey(name) { const s = String(name || '').trim(); const m = /^(optn?\d+)(?:\s*\([^)]*\))?$/i.exec(s); return (m ? m[1] : s).toLowerCase(); }
  const maintOf = (live, pduId) => !!(live?.connected && pduId && live.maintenance?.pdus?.[pduId]);
  // Health of one object: { h: up|down|unknown|maint, why } — or null for things without a live signal (cart, chiller, equipment).
  function itemHealth(it, live = S.live) {
    if (!it) return null;
    const signal = ['opt', 'pdu', 'kvm'].includes(it.type);
    if (!live?.connected) return signal || String(it.id || '').startsWith('LIVE-') ? { h: 'unknown', why: 'No live data' } : null;
    if (it.type === 'opt') {
      if (it.live?.inDcim !== true) return { h: 'unknown', why: 'Not in live DCIM' };
      if (maintOf(live, it.dcim?.pdu)) return { h: 'maint', why: 'Maintenance' };
      if (it.live.state === 'off') return { h: 'down', why: 'Off' };
      if (it.live.state === 'on') return live.ping?.[pingKey(it.name)]?.status === 'down' ? { h: 'down', why: 'No ping' } : { h: 'up', why: '' };
      return { h: 'unknown', why: live.pdu?.[it.dcim?.pdu]?.reachable === false ? 'PDU unreachable' : 'Power state unknown' };
    }
    if (it.type === 'pdu') {
      if (!it.live) return { h: 'unknown', why: 'Not in live DCIM' };
      if (maintOf(live, it.dcim?.deviceId || it.live.device?.id)) return { h: 'maint', why: 'Maintenance' };
      if (it.live.reachable === false) return { h: 'down', why: 'Offline' };
      if (it.live.reachable) return it.live.status?.leak_detected ? { h: 'down', why: 'Leak' } : { h: 'up', why: '' };
      return { h: 'unknown', why: 'Loading' };
    }
    if (it.type === 'kvm') {
      if (!it.live) return { h: 'unknown', why: 'Not in live DCIM' };
      if (it.live.reachable === false) return { h: 'down', why: 'Offline' };
      if (it.live.status?.error) return { h: 'down', why: 'Sign-in failed' };
      if (it.live.reachable) return { h: 'up', why: '' };
      return { h: 'unknown', why: 'Loading' };
    }
    return null;
  }
  function rackPdus(su, live = S.live) {
    const rack = su?.dcimRack; if (!rack) return [];
    return (live.devices || []).filter(d => d.kind === 'pdu' && (d.rack === rack || (d.notes || '').split(',').map(x => x.trim()).includes('shared:' + rack)));
  }
  // Health of a rack: its PDUs, critical rack issues (leak, heat, load) and maintenance.
  function rackHealth(su, live = S.live, attention = S.attention) {
    if (!su) return null;
    if (!live?.connected) return { h: 'unknown', why: 'no live data' };
    if (!su.dcimRack) return { h: 'unknown', why: 'not mapped' };
    const pdus = rackPdus(su, live); if (!pdus.length) return { h: 'unknown', why: 'no PDU' };
    if (pdus.some(p => live.pdu?.[p.id]?.reachable === false)) return { h: 'down', why: 'PDU offline' };
    const crit = (attention || []).filter(e => e.setup === su.id && e.severity === 'crit');
    if (crit.some(e => e.kind === 'leak')) return { h: 'down', why: 'Leak' };
    if (crit.some(e => e.kind === 'temp')) return { h: 'down', why: 'Too hot' };
    if (crit.some(e => e.kind === 'load')) return { h: 'down', why: 'Overloaded' };
    if (pdus.some(p => maintOf(live, p.id))) return { h: 'maint', why: 'Maintenance' };
    if (pdus.every(p => !live.pdu?.[p.id])) return { h: 'unknown', why: 'loading' };
    return { h: 'up', why: '' };
  }
  function healthOfRec(rec) { if (!rec) return null; if (rec.cat === 'setup') return rackHealth(rec.def); if (rec.cat === 'item') return itemHealth(rec.item); return null; }
  // Colour of an object in the current colouring: health (default) or lifecycle status.
  function paint(rec) {
    if (S.colorBy !== 'health') return STATUS_COLOR[rec.status] || STATUS_COLOR.unknown;
    if (rec.cat === 'shelf') return SHELF_NEUTRAL;
    const h = healthOfRec(rec); return h ? HEALTH[h.h].c : NEUTRAL;
  }
  const shelfColor = r => S.colorBy === 'health' ? SHELF_NEUTRAL : STATUS_COLOR[r.status];
  // Row names come from the zones in lab-data.json ("Left rack row (wall x=0)" → "Left rack row"); `short` overrides.
  function rowLabel(zone) { if (!zone) return ''; return String(zone.short || String(zone.name || zone.id).split(/\s*[—(+,]/)[0]).trim() || zone.id; }
  const rackName = su => (su && (su.dcimRack || su.id)) || '';
  const storageName = sd => String(sd?.id || '').replace('STORAGE-', 'ST-');
  // Every live outlet that powers this server (labels "Optn84" and "Optn84 (2)" are two feeds of one host).
  function feedsOf(name, live = S.live) {
    const key = pingKey(name); const out = []; if (!key || !live?.connected) return out;
    (live.devices || []).filter(d => d.kind === 'pdu').forEach(d => {
      const seen = new Set();
      const add = (n, label) => {
        n = Number(n); label = String(label || '');
        if (!Number.isInteger(n) || seen.has(n) || !isServerLabel(label) || pingKey(label) !== key) return;
        seen.add(n); const o = live.pdu?.[d.id]?.outlets?.find(x => x.number === n);
        out.push({ pduId: d.id, pduName: d.name || d.id, outlet: n, state: o?.state || 'unknown' });
      };
      (live.pdu?.[d.id]?.outlets || []).forEach(o => add(o.number, o.label));
      Object.entries(d.labels || {}).forEach(([n, l]) => add(n, l));
    });
    return out;
  }
  function ageText(ms, now = Date.now()) { const s = Math.max(0, (now - ms) / 1000); return s < 60 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; }
  const hhmm = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
  // First time this page saw each issue (only maintenance and ping have a server time). Pruned only with live data.
  function noteAttentionSeen() {
    const now = Date.now(); const keys = new Set();
    (S.attention || []).forEach(e => { keys.add(e.key); if (!S.attnSeen.has(e.key)) S.attnSeen.set(e.key, now); });
    if (S.live.connected) for (const k of [...S.attnSeen.keys()]) if (!keys.has(k)) S.attnSeen.delete(k);
    try { sessionStorage.setItem('twin.attnSeen', JSON.stringify([...S.attnSeen])); } catch { /* storage blocked */ }
  }
  // Rack envelopes, health caps, rack labels, shelves and storage follow the current colouring.
  function paintRacks() {
    const byHealth = S.colorBy === 'health';
    for (const rec of S.recs.values()) {
      if (rec.cat === 'setup' && rec.envSolid) {
        const h = rackHealth(rec.def) || { h: 'unknown', why: '' }; rec.health = h;
        const col = byHealth ? HEALTH[h.h].c : STATUS_COLOR[rec.status]; const unknown = byHealth && h.h === 'unknown';
        rec.envSolid.material.color.set(col); rec.envSolid.visible = !unknown; rec.envDashed.visible = unknown;
        rec.cap.material.color.set(unknown ? '#3f3f46' : col);
        const el = rec.label;
        if (el) {
          el.classList.remove('h-up', 'h-down', 'h-unknown', 'h-maint'); if (byHealth) el.classList.add('h-' + h.h);
          const lp = el.querySelector('.lp'); if (lp) lp.style.background = col;
          const ls = el.querySelector('.ls'); if (ls) ls.textContent = byHealth && h.why ? ' · ' + h.why : '';
        }
      } else if (rec.cat === 'shelf') {
        if (!S.moveItem) rec.edges.forEach(e => e.material.color.set(shelfColor(rec)));
      } else if (rec.cat === 'storage') {
        const col = byHealth ? NEUTRAL : STATUS_COLOR[rec.status];
        rec.edges.forEach(e => e.material.color.set(col)); const lp = rec.label?.querySelector('.lp'); if (lp) lp.style.background = col;
      }
    }
  }
  // The rack (setup record) an object belongs to, or null.
  function rackRecOf(rec) {
    if (!rec) return null; if (rec.cat === 'setup') return rec;
    const su = rec.setup ? S.recs.get(rec.setup) : null; return su && su.cat === 'setup' ? su : null;
  }
  // Human location: "Rack-01 › Shelf 2 › Left" (shelf 1 = top, like Lab Manager), bottom bay, side, storage or the floor.
  function placeLabel(rec) {
    if (!rec) return '—';
    const it = rec.item || {}; const su = rackRecOf(rec); const rack = su ? rackName(su.def) : '';
    if (rec.cat === 'shelf') return `${rack} › Shelf ${shelfToU(rec.setup, rec.id)}`;
    if (rec.cat === 'setup') return [rowLabel(S.data.zones.find(z => z.id === rec.zone)), rack].filter(Boolean).join(' › ');
    if (rec.cat === 'storage') return storageName(rec.def);
    if (rec.shelf && su) return `${rack} › Shelf ${shelfToU(su.id, rec.shelf)} › ${it.type === 'opt' ? 'Left' : 'Right'}`;
    if (su && it.placement === 'bottom-bay') return `${rack} › bottom bay`;
    if (su && it.placement === 'side-mount') return `${rack} › ${it.side === 'left' ? 'left' : 'right'} side`;
    if (su && it.placement === 'rack-strips') return `${rack} › power strips`;
    if (su) return rack;
    if (it.storage) return storageName(S.data.storage.find(s => s.id === it.storage) || { id: it.storage });
    if (rec.unplaced) return it.live?.rack ? `${it.live.rack} · no shelf in 3D` : 'Not placed';
    const a = anchorOf(rec); return a ? `Floor · x ${DX(a.x).toFixed(2)} · z ${a.z.toFixed(2)} m` : '—';
  }
  // Drawer status cells (text only; escaped by the caller)
  function powerText(it) {
    if (!S.live.connected) return 'No live data';
    if (it.live?.inDcim !== true) return 'Not in live DCIM';
    if (inMaintenance(it.dcim?.pdu)) return 'Maintenance';
    if (it.live.state === 'on') return 'On' + (it.live.watts != null ? ` · ${Math.round(it.live.watts)} W` : '');
    if (it.live.state === 'off') return 'Off';
    return S.live.pdu?.[it.dcim?.pdu]?.reachable === false ? 'Unknown · PDU unreachable' : 'Unknown';
  }
  function pingText(it) {
    if (!S.live.connected) return 'No live data';
    if (S.live.ping === null) return 'Not available';
    const p = S.live.ping?.[pingKey(it.name)]; if (!p) return 'Not monitored';
    const checked = Date.parse(p.checkedAt || ''); const age = Number.isFinite(checked) ? ageText(checked) : '';
    const up = Date.parse(p.lastUpAt || '');
    if (p.status === 'up') return 'Up' + (p.rtt != null ? ` · ${p.rtt < 10 ? (+p.rtt).toFixed(1) : Math.round(p.rtt)} ms` : '') + (age ? ' · ' + age : '');
    if (p.status === 'down') return Number.isFinite(up) ? `Down since ${hhmm(up)}` : 'Down';
    if (p.status === 'stale') return 'Stale' + (age ? ' · checked ' + age : '');
    if (p.status === 'paused') return 'Paused';
    if (p.status === 'unconfigured') return 'Not configured';
    return 'Unknown';
  }
  function consoleText(it) {
    if (!S.live.connected) return 'No live data';
    const kv = kvmTargets(it); if (!kv.length) return 'No KVM';
    const st = S.live.kvm?.[kv[0].kvm];
    if (st?.reachable === false) return 'KVM unreachable';
    if (st?.error) return 'KVM sign-in failed';
    return kv.some(k => kvmPort(k.kvm, Number(k.port))?.in_use) ? 'In use' : 'Free';
  }
  const healthBadge = h => h ? `<span class="hdot h-${h.h}" aria-hidden="true"></span>${esc(HEALTH[h.h].t)}` : '';

  // ───────────────────────────────────────────────────────────── attention: what needs a person today
  // Pure (no DOM, no S): model + live + recs (+ now) → [{ key, id|null, setup|null, severity, kind, group, since, text, hint }].
  // group 'issue' = the lab needs someone now (Issues list); 'dq' = the inventory needs a correction (Data quality).
  // since = server time of the problem in ms (maintenance start, last ping answer) or null (the page notes when it first saw it).
  function computeAttention(model, live, recs, now = Date.now()) {
    const out = []; if (!model) return out;
    const add = (severity, kind, key, text, hint, id = null, setup = null, since = null) => out.push({ key: `${kind}:${key}`, id: id || null, setup: setup || null, severity, kind, group: ISSUE_KINDS.has(kind) ? 'issue' : 'dq', since: Number.isFinite(since) ? since : null, text, hint: hint || '' });
    const items = model.items || []; const connected = !!live?.connected;
    const names = list => list.slice(0, 4).map(i => i.name || i.id).join(', ') + (list.length > 4 ? ` +${list.length - 4}` : '');
    const bySetup = list => { const m = new Map(); list.forEach(i => { const k = i.setup || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(i); }); return m; };
    // "<rack label> · <fact>": the DCIM rack name of the setup (Rack-07), else the setup id
    const rackOf = sid => { const su = (model.setups || []).find(s => s.id === sid); return su ? su.dcimRack || su.id : ''; };
    const at = (sid, fact) => { const r = rackOf(sid); return r ? `${r} · ${fact}` : fact.charAt(0).toUpperCase() + fact.slice(1); };
    const opts = items.filter(i => i.type === 'opt');
    const shelfOf = o => o.live?.u != null ? `Shelf ${o.live.u}` : 'no shelf';
    if (connected) {
      items.filter(i => i.type === 'pdu' && i.live?.device).forEach(p => {
        const dev = p.dcim?.deviceId || p.id; const st = p.live.status; const name = p.name || dev;
        if (st?.leak_detected) add('crit', 'leak', dev, `Leak detected · ${name}`, at(p.setup, 'the leak sensor is alarming — check the chiller and the pipes now'), p.id, p.setup);
        if (p.live.reachable === false) {
          const stuck = opts.filter(o => o.live?.inDcim && o.dcim?.pdu === dev && o.live.state !== 'on' && o.live.state !== 'off');
          add('crit', 'pdu-down', dev, `${name} unreachable`, at(p.setup, stuck.length ? `power state of ${stuck.length} server${stuck.length === 1 ? '' : 's'} unknown` : 'check the PDU network and power'), p.id, p.setup);
        }
        if (st?.reachable && st.temperature != null) {
          if (st.temperature > ATTN_TEMP_CRIT) add('crit', 'temp', dev, `${name} ${st.temperature.toFixed(1)} °C`, at(p.setup, `above ${ATTN_TEMP_CRIT} °C — check the cooling`), p.id, p.setup);
          else if (st.temperature > ATTN_TEMP_WARN) add('warn', 'temp', dev, `${name} ${st.temperature.toFixed(1)} °C`, at(p.setup, `above ${ATTN_TEMP_WARN} °C — keep an eye on the cooling`), p.id, p.setup);
        }
      });
      (model.setups || []).forEach(su => {
        const t = rackTelemetry(su, live); if (!t || t.loading || t.cap == null) return;
        const pct = Math.round(t.cap * 100), hint = at(su.id, `${t.amps.toFixed(1)} A of ${RATED_AMPS * t.pduCount} A (estimate) — consider moving load`);
        if (t.cap >= ATTN_LOAD_CRIT) add('crit', 'load', su.id, `${rackOf(su.id)} power load ${pct}%`, hint, su.id, su.id);
        else if (t.cap >= ATTN_LOAD_WARN) add('warn', 'load', su.id, `${rackOf(su.id)} power load ${pct}%`, hint, su.id, su.id);
      });
      // a PDU in maintenance mode keeps outlets off until it is restored in Lab Manager
      Object.entries(live.maintenance?.pdus || {}).forEach(([dev, m]) => {
        if (!m) return;
        const p = items.find(i => i.type === 'pdu' && (i.dcim?.deviceId === dev || i.live?.device?.id === dev));
        const d = (live.devices || []).find(x => x.id === dev); const sid = p?.setup || model.setupByRack?.[d?.rack] || null;
        const n = Array.isArray(m.outlets_off) ? m.outlets_off.length : 0; const started = Number(m.started_at) * 1000;
        add('warn', 'pdu-maint', dev, `${rackOf(sid) || p?.name || d?.name || dev} PDU in maintenance`, `${n} outlet${n === 1 ? '' : 's'} kept off · restore from Power`, p?.id, sid, started);
      });
      opts.filter(o => o.live?.inDcim).forEach(o => {
        const where = `${shelfOf(o)} · outlet #${o.dcim?.outlet ?? '?'} on ${o.dcim?.pduName || o.dcim?.pdu || 'the PDU'}`;
        if (o.live.state === 'off') add('warn', 'opt-off', o.id, `${o.name} is off`, at(o.setup, `${where} is off`), o.id, o.setup);
        else if (o.live.state !== 'on' && live.pdu?.[o.dcim?.pdu]?.reachable === true) add('warn', 'opt-unknown', o.id, `${o.name} state unknown`, at(o.setup, `${where} reports no state`), o.id, o.setup);
        // outlet on but the server does not answer ping (only when ping monitoring knows the host)
        const ping = live.ping?.[pingKey(o.name)];
        if (o.live.state === 'on' && ping?.status === 'down') add('warn', 'ping-down', o.id, `${o.name} not answering ping`, at(o.setup, `${shelfOf(o)} · outlet on`), o.id, o.setup, Date.parse(ping.lastUpAt || ''));
      });
      items.filter(k => k.type === 'kvm' && k.live?.reachable === false).forEach(k => add('warn', 'kvm-down', k.dcim?.deviceId || k.id, `${k.name} unreachable`, at(k.setup, 'the KVM console is unavailable — check its network and power'), k.id, k.setup));
      (live.devices || []).filter(d => d.kind === 'kvm' && live.kvm?.[d.id]?.reachable && live.kvm[d.id].error).forEach(d => {
        const k = items.find(i => i.type === 'kvm' && i.dcim?.deviceId === d.id);
        add('warn', 'kvm-error', d.id, `${k?.name || d.name || d.id} sign-in failed`, `The KVM answers but sign-in failed: ${live.kvm[d.id].error} — check its credentials in Lab Manager`, k?.id, k?.setup || model.setupByRack?.[d.rack] || null);
      });
      bySetup(opts.filter(o => o.live && o.live.inDcim === false)).forEach((list, sid) => add('warn', 'not-in-dcim', sid || 'none', list.length === 1 ? `${list[0].name} not in DCIM labels` : `${list.length} OPTs not in DCIM labels`, at(sid, `not in the live PDU labels: ${names(list)}`), list.length === 1 || !sid ? list[0].id : sid, sid));
      items.filter(i => i.id.startsWith('LIVE-') && i.type.startsWith('equip-') && i.last_seen_at).forEach(i => {
        const t = Date.parse(i.last_seen_at); if (!Number.isFinite(t)) return; const days = Math.floor((now - t) / 864e5);
        if (days > STALE_DAYS) add('info', 'stale', i.id, `${i.name} not seen for ${days} days`, `Last scan ${String(i.last_seen_at).slice(0, 10)} — scan its barcode to confirm the location`, i.id, i.setup);
      });
      bySetup(opts.filter(o => o.live?.inDcim && o.setup && o.placementConfidence === 'low')).forEach((list, sid) => add('info', 'auto-u', sid, list.length === 1 ? `${list[0].name} auto-placed (no explicit U)` : `${list.length} OPTs auto-placed (no explicit U)`, at(sid, `shelf set by order, not by rack_slots — confirm with Move: ${names(list)}`), list.length === 1 ? list[0].id : sid, sid));
    } else {
      if (live?.signedOut) add('info', 'offline', 'live', 'Signed out — sign in to resume live data', 'Sign in to Lab Manager again; live data comes back on its own');
      else add('info', 'offline', 'live', 'Live data off — connect the backend', 'Only the static lab-data.json is shown (state, power and scans need the backend)');
    }
    // static checks (also offline)
    [...(recs ? recs.values() : [])].filter(r => r.unplaced).forEach(r => add('warn', 'unplaced', r.id, `${r.def?.name || r.id} has no position`, 'No place in 3D — place it with Edit layout (Move) or in Lab Manager', r.id, r.setup));
    (model.unmappedRacks || []).forEach(rack => add('warn', 'unmapped-rack', rack, `DCIM rack ${rack} has no physical setup`, 'Assign it to a rack in the rack details (DCIM rack mapping)'));
    const lowMap = (model.setups || []).filter(s => s.dcimMappingConfidence === 'low');
    if (lowMap.length) add('info', 'mapping', 'setups', lowMap.length === 1 ? `${lowMap[0].id} rack mapping unverified` : `${lowMap.length} rack mappings unverified`, `Physical rack ↔ Rack-0X not verified: ${lowMap.map(s => s.id).join(', ')}`, lowMap[0].id);
    const rank = e => { const i = ATTN_ORDER.indexOf(e.severity + ':' + e.kind); return i < 0 ? ATTN_ORDER.length : i; };
    return out.sort((a, b) => rank(a) - rank(b) || (a.setup ? 0 : 1) - (b.setup ? 0 : 1) || String(a.setup || '').localeCompare(String(b.setup || '')) || a.key.localeCompare(b.key));
  }
  function attnCounts(list) { const c = { crit: 0, warn: 0, info: 0 }; (list || []).forEach(e => { c[e.severity]++; }); return c; }
  function worstSeverity(list) { return SEVERITIES.find(s => list.some(e => e.severity === s)) || null; }
  function ago(ts, now = Date.now()) {
    const t = Date.parse(ts); if (!Number.isFinite(t)) return '—'; const s = Math.max(0, (now - t) / 1000);
    return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';
  }
  function fmtTs(ts) { const d = new Date(ts); if (isNaN(d)) return String(ts); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }

  // ───────────────────────────────────────────────────────────── filters / search
  const ownerOf = rec => rec.item?.owner || rec.item?.live?.owner || rec.def.owner || '';
  function matchesQuery(rec, query) {
    const q = query.toLowerCase();
    return [rec.id, rec.def.name, rec.item?.serial_number || rec.def.serial_number, rec.item?.barcode, rec.item?.shelf_position, ownerOf(rec)].some(value => String(value || '').toLowerCase().includes(q));
  }
  // Lower = better. An exact name / ID match must beat a longer name that merely starts the same (OPT11 before Opt114).
  function searchRank(rec, query) {
    const q = query.trim().toLowerCase(); const name = String(rec.def.name || '').trim().toLowerCase(); const id = rec.id.toLowerCase();
    const base = name.replace(/\s*\(.*\)\s*$/, '');
    if (name === q || id === q) return 0;
    if (base === q || id === 'live-' + q) return 1;
    if (name.startsWith(q) || id.startsWith(q) || id.startsWith('live-' + q)) return 2;
    if (name.split(/[\s·—\-_/]+/).some(w => w.startsWith(q))) return 3;
    if (name.includes(q) || id.includes(q)) return 4;
    return 5;   // serial number, barcode, shelf position or owner
  }
  function searchHits(query) {
    const catOrder = { item: 0, setup: 1, shelf: 2, storage: 3, structure: 4, zone: 5 };
    return [...S.recs.values()].filter(r => matchesQuery(r, query))
      .map(r => ({ r, rank: searchRank(r, query) }))
      .sort((a, b) => a.rank - b.rank || (catOrder[a.r.cat] ?? 9) - (catOrder[b.r.cat] ?? 9) || String(a.r.def.name || a.r.id).length - String(b.r.def.name || b.r.id).length || a.r.id.localeCompare(b.r.id))
      .map(x => x.r);
  }
  function matches(rec) {
    const f = S.filters;
    // While moving, every possible destination stays visible and pickable, whatever the search / filters hide.
    if (S.moveItem && (rec.cat === 'shelf' || rec.cat === 'setup' || rec.cat === 'storage')) return true;
    if (rec.cat === 'zone') return !f.zone || rec.id === f.zone;
    if (f.zone && rec.zone !== f.zone && rec.cat !== 'structure') return false;
    if (f.setup && rec.setup !== f.setup && rec.id !== f.setup) return false;
    if (rec.cat !== 'structure' && !f.statuses.has(rec.status)) return false;
    if (f.onlyLow && !(rec.conf === 'low' || rec.pconf === 'low' || (rec.cat === 'setup' && rec.def.dcimMappingConfidence === 'low'))) return false;
    if (f.q && !matchesQuery(rec, f.q)) return false;
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
      if (rec.cap) { rec.cap.material.transparent = true; rec.cap.material.opacity = fade; }
    }
    renderTree(); renderInventory(); renderUnplaced(); renderRackBar();
  }
  function setupFilterUI() {
    const d = S.data;
    const fz = $('#fZone'); d.zones.forEach(z => { const o = document.createElement('option'); o.value = z.id; o.textContent = `${z.id} — ${rowLabel(z)}`; fz.appendChild(o); });
    const fs = $('#fSetup'); d.setups.forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = `${rackName(s)} — ${s.id}`; fs.appendChild(o); });
    fz.onchange = () => { S.filters.zone = fz.value; applyFilters(); };
    fs.onchange = () => { S.filters.setup = fs.value; applyFilters(); };
    const chips = $('#fStatus'); STATUSES.forEach(st => {
      const c = document.createElement('button'); c.type = 'button'; c.className = 'chip on'; c.setAttribute('aria-pressed', 'true'); c.innerHTML = `<span class="sw" style="background:${STATUS_COLOR[st]}"></span>${STATUS_LABEL[st]}`;
      c.onclick = () => { if (S.filters.statuses.has(st)) S.filters.statuses.delete(st); else S.filters.statuses.add(st); const on = S.filters.statuses.has(st); c.classList.toggle('on', on); c.classList.toggle('off', !on); c.setAttribute('aria-pressed', String(on)); applyFilters(); };
      chips.appendChild(c);
    });
    $('#fOnlyLow').onchange = e => { S.filters.onlyLow = e.target.checked; applyFilters(); };
    $('#fClear').onclick = () => { S.filters = { zone: '', setup: '', statuses: new Set(STATUSES), onlyLow: false, q: '' }; fz.value = ''; fs.value = ''; $('#fOnlyLow').checked = false; $('#search').value = ''; $$('#fStatus .chip').forEach(c => { c.classList.add('on'); c.classList.remove('off'); c.setAttribute('aria-pressed', 'true'); }); applyFilters(); };
    // search
    const inp = $('#search'), res = $('#searchResults');
    let active = -1;
    const options = () => $$('.sr[data-id]', res);
    const hideResults = () => { res.classList.add('hidden'); inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); active = -1; };
    const setActive = i => {
      const opts = options(); if (!opts.length) { active = -1; return; }
      active = (i + opts.length) % opts.length;
      opts.forEach((el, n) => { el.classList.toggle('active', n === active); el.setAttribute('aria-selected', n === active ? 'true' : 'false'); });
      // keep the highlighted row visible by scrolling the list only (scrollIntoView could also scroll the page around an embedded twin)
      const el = opts[active]; inp.setAttribute('aria-activedescendant', el.id);
      if (el.offsetTop < res.scrollTop) res.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > res.scrollTop + res.clientHeight) res.scrollTop = el.offsetTop + el.offsetHeight - res.clientHeight;
    };
    const choose = el => { if (el && el.dataset.id) { select(el.dataset.id); hideResults(); } };
    // (re)build the result list for the current text; false when there is nothing to search for
    const showResults = () => {
      const q = inp.value.trim();
      if (!q) { hideResults(); return false; }
      const hits = searchHits(q).slice(0, 14); const ql = q.toLowerCase();
      res.innerHTML = hits.map((r, n) => { const owner = ownerOf(r); const byOwner = owner && owner.toLowerCase().includes(ql) && searchRank(r, q) === 5;
        const kind = r.cat === 'item' ? ITEM_KIND[r.item?.type] || 'Item' : CAT_LABEL[r.cat] || r.cat;
        return `<div class="sr" role="option" id="sr-${n}" aria-selected="false" data-id="${esc(r.id)}"><span class="nm">${esc(r.def.name || r.id)}${byOwner ? `<small class="ow"> · owner ${esc(owner)}</small>` : ''}</span><span class="id">${esc(r.id)}</span><span class="cat">${esc(kind)}</span></div>`; }).join('') || '<div class="sr" role="option" aria-disabled="true"><span class="nm muted">No matches</span></div>';
      res.classList.remove('hidden'); inp.setAttribute('aria-expanded', 'true');
      options().forEach((el, n) => { el.onclick = () => choose(el); el.onmouseenter = () => setActive(n); });
      setActive(0); return true;
    };
    inp.addEventListener('input', () => { S.filters.q = inp.value.trim(); applyFilters(); showResults(); });
    // ↓ / ↑ move through the results (and reopen a closed list), Enter selects the highlighted one,
    // Escape closes the list (focus stays in the box), a second Escape leaves the box.
    inp.addEventListener('keydown', e => {
      if (e.isComposing) return;
      const open = !res.classList.contains('hidden');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); const step = e.key === 'ArrowDown' ? 1 : -1;
        if (open) setActive(active + step); else if (showResults() && step < 0) setActive(-1);
      } else if (e.key === 'Enter') {
        if (!open && !showResults()) return;
        e.preventDefault(); choose(options()[Math.max(0, active)]);
      } else if (e.key === 'Escape') {
        e.preventDefault(); if (open) hideResults(); else inp.blur();
      }
    });
    document.addEventListener('click', e => { if (!e.target.closest('.search-wrap') && !e.target.closest('#btnSearch')) hideResults(); });
    // phone: the search row under the header stays open while it has text or the focus
    inp.addEventListener('blur', () => setTimeout(() => { if (!inp.value.trim() && document.activeElement !== inp) setSearchRow(false); }, 150));
  }
  function setSearchRow(open) {
    document.body.classList.toggle('search-open', !!open); const b = $('#btnSearch'); if (b) b.setAttribute('aria-expanded', String(!!open));
  }
  function focusSearch() {
    if (isPhone()) setSearchRow(true);
    const inp = $('#search'); inp.focus({ preventScroll: true }); inp.select();
  }
  const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ───────────────────────────────────────────────────────────── sidebar: tree / inventory / unplaced
  function recsOf(pred) { return [...S.recs.values()].filter(pred); }
  // health dot (Health colouring) or lifecycle dot; dashed ring = health unknown / low confidence
  function dot(rec) {
    const byHealth = S.colorBy === 'health';
    const h = byHealth ? healthOfRec(rec) : null;
    const dashed = byHealth ? h?.h === 'unknown' : rec.pconf === 'low' || rec.conf === 'low';
    return `<span class="st${dashed ? ' low' : ''}" style="${dashed && byHealth ? '' : `background:${paint(rec)}`}"></span>`;
  }
  function shelfCaption(sh) {
    const n = recsOf(r => r.cat === 'shelf' && r.setup === sh.setup).length; const u = shelfToU(sh.setup, sh.id);
    return `Shelf ${u}${n > 1 && u === 1 ? ' (top)' : n > 1 && u === n ? ' (bottom)' : ''}`;
  }
  function renderTree() {
    const d = S.data; const el = $('#tree'); const open = LS.get('treeOpen', {});
    const node = (rec, cls, extra = '', label = null) => `<div class="tn ${rec.filtered ? 'dim' : ''} ${S.selected === rec.id ? 'sel' : ''}" data-id="${esc(rec.id)}" tabindex="0" role="button">${dot(rec)}<span class="nm ${cls}">${esc(label ?? (rec.def.name || rec.id))}</span>${extra}</div>`;
    let html = '';
    d.zones.forEach(zn => {
      const racks = recsOf(r => r.cat === 'setup' && r.zone === zn.id), stores = recsOf(r => r.cat === 'storage' && r.zone === zn.id);
      const free = recsOf(r => r.cat === 'item' && r.zone === zn.id && !r.setup && !r.item?.storage && !r.unplaced);
      if (!racks.length && !stores.length && !free.length) return;
      html += `<div class="zone-h"><span class="sw" style="background:${esc(zn.color)}"></span>${esc(rowLabel(zn))}</div>`;
      racks.forEach(su => {
        const isOpen = open[su.id] !== false;
        html += `<div class="tn grp ${isOpen ? 'open' : ''} ${su.filtered ? 'dim' : ''} ${S.selected === su.id ? 'sel' : ''}" data-id="${esc(su.id)}" data-grp="${esc(su.id)}" tabindex="0" role="button" aria-expanded="${isOpen}"><span class="caret" aria-hidden="true">▶</span>${dot(su)}<span class="nm rack">${esc(rackName(su.def))}</span><span class="tag id">${esc(su.id)}</span></div>`;
        if (isOpen) {
          html += `<div class="tgroup">`;
          recsOf(r => r.cat === 'shelf' && r.setup === su.id).sort((a, b) => b.level - a.level).forEach(sh => {
            const its = recsOf(r => r.cat === 'item' && r.shelf === sh.id);
            html += node(sh, 'shelf', its.length ? '' : '<span class="tag">empty</span>', shelfCaption(sh));
            its.forEach(it => { const lv = it.item.live; const tag = it.item.type === 'opt' ? (lv?.inDcim ? `<span class="tag ${lv.state === 'on' ? 'on' : lv.state === 'off' ? 'offp' : ''}">${esc(lv.state)}</span>${lv.sw ? `<span class="tag sw">${esc(lv.sw.switch)}${lv.sw.port ? '·' + esc(lv.sw.port) : ''}</span>` : ''}` : `<span class="tag">#${esc(it.item.dcim?.outlet ?? '?')}</span>`) : `<span class="tag">${esc(ITEM_KIND[it.item.type] || it.item.type)}</span>`; html += `<div class="tgroup">${node(it, 'item', tag)}</div>`; });
          });
          recsOf(r => r.cat === 'item' && r.setup === su.id && !r.shelf).forEach(it => { html += node(it, 'item', `<span class="tag">${esc(it.item.placement === 'side-mount' ? 'side · ' + (it.item.side || 'right') : ITEM_KIND[it.item.type] || it.item.type)}</span>`); });
          html += `</div>`;
        }
      });
      stores.forEach(st => {
        html += node(st, 'store', `<span class="tag id">${esc(storageName(st.def))}</span>`);
        recsOf(r => r.cat === 'item' && r.item?.storage === st.id).forEach(it => { html += `<div class="tgroup">${node(it, 'item', `<span class="tag">×${esc(it.item.quantity || 1)}</span>`)}</div>`; });
      });
      free.forEach(it => { html += node(it, 'item', `<span class="tag">${esc(ITEM_KIND[it.item.type] || it.item.type)}</span>`); });
    });
    html += `<div class="zone-h"><span class="sw" style="background:#52525b"></span>Structure</div>`;
    recsOf(r => r.cat === 'structure').forEach(r => { html += node(r, 'item', `<span class="tag">${esc(r.conf)}</span>`, r.id); });
    const focusedId = el.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    el.innerHTML = html;
    const toggle = id => { const o = LS.get('treeOpen', {}); o[id] = !(o[id] !== false); LS.set('treeOpen', o); renderTree(); };
    $$('.tn', el).forEach(n => {
      n.onclick = e => {
        const id = n.dataset.id;
        if (n.dataset.grp && (e.target.classList.contains('caret'))) { toggle(id); return; }
        activateTreeRow(id);
      };
      n.onkeydown = e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTreeRow(n.dataset.id); }
        else if (n.dataset.grp && ((e.key === 'ArrowRight') !== n.classList.contains('open')) && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); toggle(n.dataset.id); }
      };
    });
    if (focusedId) { const again = $$('.tn[data-id]', el).find(n => n.dataset.id === focusedId); if (again) again.focus({ preventScroll: true }); }
  }
  function renderInventory() {
    const el = $('#inv'); const rows = [...S.recs.values()].filter(r => r.cat !== 'zone').sort((a, b) => a.id.localeCompare(b.id));
    el.innerHTML = `<div class="inv-row inv-h"><span>Name</span><span>ID</span><span style="text-align:right">Where</span></div>` + rows.map(r => `<div class="inv-row ${r.filtered ? 'dim' : ''} ${S.selected === r.id ? 'sel' : ''}" data-id="${esc(r.id)}" tabindex="0" role="button"><span class="nm">${dot(r)} ${esc(r.def.name || r.id)}</span><span class="id">${esc(r.id)}</span><span class="loc">${esc(r.shelf ? rackName(S.recs.get(r.setup)?.def) + ' · S' + shelfToU(r.setup, r.shelf) : r.cat === 'setup' ? rackName(r.def) : r.setup ? rackName(S.recs.get(r.setup)?.def) : r.item?.storage ? storageName({ id: r.item.storage }) : r.unplaced ? '—' : 'room')}</span></div>`).join('');
    $$('.inv-row[data-id]', el).forEach(n => { n.onclick = () => activateTreeRow(n.dataset.id); n.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTreeRow(n.dataset.id); } }; });
  }
  function setRacksList(mode) {
    S.racksList = mode === 'inv' ? 'inv' : 'tree'; LS.set('racksList', S.racksList);
    $('#tree').classList.toggle('hidden', S.racksList !== 'tree'); $('#inv').classList.toggle('hidden', S.racksList !== 'inv');
    $$('[data-rlist]').forEach(b => { const on = b.dataset.rlist === S.racksList; b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); });
  }
  function renderUnplaced() {
    const el = $('#unplaced'); const list = [...S.recs.values()].filter(r => r.unplaced); const m = S.model;
    let html = '';
    if (m.unmappedRacks.length) html += `<div class="zone-h">DCIM racks without a physical rack</div>` + m.unmappedRacks.map(r => `<div class="tn static"><span class="st" style="background:#fbbf24"></span><span class="nm">${esc(r)}</span><span class="tag">assign in rack details</span></div>`).join('');
    if (list.length) html += `<div class="zone-h">Objects with no place in 3D</div>` + list.map(r => `<div class="tn" data-id="${esc(r.id)}" tabindex="0" role="button">${dot(r)}<span class="nm item">${esc(r.def.name)}</span><span class="tag">${esc(ITEM_KIND[r.item.type] || r.item.type)}</span></div>`).join('');
    if (!html) html = `<div class="muted small" style="padding:8px">Everything is placed.</div>`;
    el.innerHTML = html;
    $$('.tn[data-id]', el).forEach(n => { n.onclick = () => activateTreeRow(n.dataset.id); n.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTreeRow(n.dataset.id); } }; });
  }

  // ───────────────────────────────────────────────────────────── issues (left panel), data quality, dock, badges
  const issuesOf = list => (list || []).filter(e => e.group === 'issue');
  // "Critical · 4 min ago" / "Warning · since 09:12": server time when known, else the moment this page first saw it
  function issueWhen(e) {
    const t = e.since || S.attnSeen.get(e.key) || null; if (!t) return { text: '', title: '' };
    if (e.kind === 'pdu-maint' && e.since) return { text: `since ${hhmm(e.since)}`, title: `Maintenance started at ${fmtTs(e.since)}` };
    return { text: ageText(t), title: e.since ? (e.kind === 'ping-down' ? `Last answered ping at ${fmtTs(e.since)}` : `Since ${fmtTs(e.since)}`) : `First noticed by this page at ${hhmm(t)}` };
  }
  function attnCard(e, i, compact) {
    const off = e.kind === 'offline'; const w = off || e.group === 'dq' ? { text: '', title: '' } : issueWhen(e);   // data-quality findings have no age
    const eyebrow = off ? 'Live data' : `${SEV_LABEL[e.severity]}${w.text ? ' · ' + w.text : ''}`;
    return `<button type="button" class="attn-row ${off ? 'sev-off' : 'sev-' + e.severity}${e.group === 'dq' ? ' dq' : ''}${compact ? ' compact' : ''}" data-attn="${i}" data-key="${esc(e.key)}"${w.title ? ` title="${esc(w.title)}"` : ''}>` +
      `<span class="ey">${esc(eyebrow)}</span><span class="tt">${esc(e.text)}</span>${e.hint && !compact ? `<span class="sub">${esc(e.hint)}${w.text ? `<span class="when-m"> · ${esc(w.text)}</span>` : ''}</span>` : ''}</button>`;
  }
  function bindAttnRows(root) {
    $$('[data-attn]', root).forEach(r => { r.onclick = () => focusAttention(S.attention[+r.dataset.attn]); });
  }
  // The move banner (while moving) sits under the breadcrumb, then the Issues dock (lab screen mode only). Neither covers
  // a control: the banner narrows before the save bar / environment panel / zoom bar, or drops below them.
  function placeAttnDock() {
    const vp = $('#viewport'); if (!vp) return; const W = vp.clientWidth;
    const shown = el => !!el && !el.classList.contains('hidden') && el.offsetWidth > 0 && el.offsetHeight > 0;
    const crumb = $('#crumb'); let top = shown(crumb) ? crumb.offsetTop + crumb.offsetHeight + 8 : 12;
    const mb = $('#moveBanner');
    if (mb && !mb.classList.contains('hidden')) {
      const others = [$('#saveBar'), $('#envPanel'), $('.zoombar'), $('#legend')].filter(shown);
      let bTop = top;
      for (let pass = 0; pass < 6; pass++) {
        mb.style.top = bTop + 'px'; let right = W - 12; mb.style.maxWidth = Math.max(200, right - mb.offsetLeft) + 'px';
        let moved = false;
        for (let k = 0; k < 2 && !moved; k++) {
          const h = mb.offsetHeight;
          for (const o of others) {
            const oTop = o.offsetTop, oBot = oTop + o.offsetHeight;
            if (oBot <= bTop || oTop >= bTop + h || o.offsetLeft + o.offsetWidth <= mb.offsetLeft) continue;
            if (o.offsetLeft - 10 - mb.offsetLeft >= 260) right = Math.min(right, o.offsetLeft - 10);
            else { bTop = oBot + 8; moved = true; break; }
          }
          mb.style.maxWidth = Math.max(200, right - mb.offsetLeft) + 'px';
        }
        if (!moved) break;
      }
      top = bTop + mb.offsetHeight + 8;
    }
    const dock = $('#attnDock'); if (dock) { dock.style.top = top + 'px'; dock.style.maxHeight = `max(72px, calc(100% - ${top + 72}px))`; }
  }
  function renderAttention() {
    const list = S.attention || []; const indexed = list.map((e, i) => [e, i]);
    const issues = indexed.filter(([e]) => e.group === 'issue'), dq = indexed.filter(([e]) => e.group === 'dq');
    // keep keyboard focus on the same card across the 15 s live refresh
    const fa = document.activeElement; const host = fa && fa.dataset && fa.dataset.key ? fa.closest('#attn, #attnDock, #dqList') : null;
    const focusKey = host ? [host.id, fa.dataset.key] : null;
    const el = $('#attn');
    if (el) { el.innerHTML = issues.map(([e, i]) => attnCard(e, i)).join('') || '<div class="empty">No issues right now.</div>'; bindAttnRows(el); }
    const real = issues.filter(([e]) => e.kind !== 'offline').map(([e]) => e); const c = attnCounts(real);
    const badge = $('#attnCount'); if (badge) { badge.textContent = real.length; badge.className = 'cnt' + (c.crit ? ' sev-crit' : c.warn ? ' sev-warn' : ''); }
    // data quality: corrections for the inventory, separate from what is wrong in the lab
    const dl = $('#dqList');
    if (dl) { dl.innerHTML = dq.map(([e, i]) => attnCard(e, i)).join('') || '<div class="empty">No data-quality findings.</div>'; bindAttnRows(dl); }
    const low = [...S.recs.values()].filter(r => r.conf === 'low' || r.pconf === 'low' || (r.cat === 'setup' && r.def.dcimMappingConfidence === 'low')).length;
    const lowEl = $('#dqLow'); if (lowEl) { lowEl.innerHTML = low ? `<div class="dq-low"><span>Low-confidence objects: <b>${low}</b></span><button type="button" class="link" id="dqOnlyLow">${S.filters.onlyLow ? 'Show all' : 'Show only these'}</button></div>` : ''; const b = $('#dqOnlyLow'); if (b) b.onclick = () => { const v = !S.filters.onlyLow; S.filters.onlyLow = v; $('#fOnlyLow').checked = v; applyFilters(); renderAttention(); }; }
    const cnt = $('#unplacedCount'); if (cnt) cnt.textContent = dq.length;
    const foot = $('#dqFooter'); if (foot) { foot.classList.toggle('none', !dq.length); foot.querySelector('span').innerHTML = `Data quality: <span id="unplacedCount">${dq.length}</span> item${dq.length === 1 ? '' : 's'}`; }
    // Issues dock: only in lab screen mode (the side panel is hidden there)
    const dock = $('#attnDock');
    if (dock) {
      const collapsed = !!S.attnDockCollapsed; const shown = S.attnDockAll ? issues : issues.slice(0, 5); const worst = worstSeverity(real);
      const dockScroll = $('.attn-dock-b', dock)?.scrollTop || 0;
      dock.className = 'attn-dock' + (collapsed ? ' collapsed' : '') + (worst ? ' sev-' + worst : '');
      dock.innerHTML = `<button type="button" class="attn-dock-h" id="attnDockToggle" aria-expanded="${!collapsed}" title="${collapsed ? 'Show the list' : 'Collapse the list'}"><span class="caret" aria-hidden="true">${collapsed ? '▸' : '▾'}</span>Issues<span class="attn-sum">${c.crit ? `<b class="bad">${c.crit}</b>` : ''}${c.warn ? `<b class="warn">${c.warn}</b>` : ''}${real.length ? '' : '<b class="ok">0</b>'}</span></button>` +
        (collapsed ? '' : `<div class="attn-dock-b">${shown.map(([e, i]) => attnCard(e, i, true)).join('') || '<div class="empty">No issues right now.</div>'}${issues.length > 5 ? `<button type="button" class="attn-more" id="attnMore">${S.attnDockAll ? 'Show top 5' : `+${issues.length - 5} more…`}</button>` : ''}</div>`);
      const dockBody = $('.attn-dock-b', dock); if (dockBody) dockBody.scrollTop = dockScroll;
      $('#attnDockToggle').onclick = () => { S.attnDockCollapsed = !S.attnDockCollapsed; LS.set('attnDockCollapsed', S.attnDockCollapsed); renderAttention(); };
      const more = $('#attnMore'); if (more) more.onclick = () => { S.attnDockAll = !S.attnDockAll; renderAttention(); };
      bindAttnRows(dock); placeAttnDock();
    }
    if (focusKey) { const again = $$('[data-key]', $('#' + focusKey[0])).find(r => r.dataset.key === focusKey[1]); if (again) again.focus({ preventScroll: true }); }
    // per-rack 3D badges: Lifecycle colouring only (in Health colouring the rack label carries the state); issues only
    const bySetup = new Map(); real.forEach(e => { if (e.setup) { if (!bySetup.has(e.setup)) bySetup.set(e.setup, []); bySetup.get(e.setup).push(e); } });
    for (const rec of S.recs.values()) {
      if (!rec.attnEl) continue;
      const mine = S.colorBy === 'status' ? bySetup.get(rec.id) || [] : []; rec.attnN = mine.length;
      if (!mine.length) { rec.attnEl.style.display = 'none'; continue; }
      const w = worstSeverity(mine); rec.attnEl.className = 'attn-badge sev-' + w; rec.attnEl.textContent = `⚠ ${mine.length}`;
    }
    renderIssuesBadge(real); renderSheetHead();
  }
  // Header badge: what is wrong in the lab now (never data quality); hidden without live data
  function renderIssuesBadge(real = issuesOf(S.attention).filter(e => e.kind !== 'offline')) {
    const b = $('#issuesBadge'); if (!b) return; const c = attnCounts(real);
    b.classList.toggle('hidden', !S.live.connected);
    const parts = []; if (c.crit) parts.push(`${c.crit} critical`); if (c.warn) parts.push(`${c.warn} warning${c.warn === 1 ? '' : 's'}`);
    b.textContent = parts.join(' · ') || 'No issues';
    b.className = b.className.replace(/\b(crit|warn|ok)\b/g, '').trim() + (c.crit ? ' crit' : c.warn ? ' warn' : ' ok');
    b.title = real.length ? 'Open the list of issues' : 'Nothing is wrong in the lab right now';
  }
  function focusAttention(e) {
    if (!e) return;
    if (e.kind === 'offline') { $('#btnSettings').click(); return; }
    if (e.id && S.recs.has(e.id)) { if (S.front) hideRackFront(); select(e.id, { fly: true }); return; }
    if (e.setup && S.recs.has(e.setup)) { if (S.front) hideRackFront(); select(e.setup, { fly: true }); return; }
    showTab('unplaced');
    if (S.kiosk) toast('The Data quality list is in the side panel — leave lab screen mode (K) to see it');
  }
  // Side panel tabs: Issues · Racks · Data quality ("inv" and "unplaced" are older names of the last two)
  const TAB_PANEL = { attn: '#attn', tree: '#racksPanel', dq: '#dqPanel' };
  function showTab(name) {
    let scrollTo = null;
    // 'racks' = the Racks tab as the user left it (By rack / All objects); 'tree' and 'inv' pick the list
    if (name === 'racks') name = 'tree'; else if (name === 'inv') { name = 'tree'; setRacksList('inv'); } else if (name === 'tree') setRacksList('tree');
    if (name === 'unplaced') { name = 'dq'; scrollTo = '#unplaced'; }
    if (!TAB_PANEL[name]) name = 'attn';
    $$('.tab[data-tab]').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    Object.entries(TAB_PANEL).forEach(([k, q]) => $(q).classList.toggle('hidden', k !== name));
    S.sideTab = name; LS.set('sideTab', name);
    if (isPhone() && S.sheet.tab !== 'details') setSheet(null, name === 'tree' ? 'racks' : 'issues');
    if (scrollTo) { const t = $(scrollTo); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest' }); }
  }

  // ───────────────────────────────────────────────────────────── selection & detail panel
  function anchorOf(rec) { if (!rec.anchor) return null; return typeof rec.anchor === 'function' ? rec.anchor() : rec.anchor; }
  // A live refresh must not throw away what the user is doing in the panel (typing, an open select or power menu,
  // unsaved editor input, scroll position).
  function detailBusy() {
    const a = document.activeElement; const d = $('#detail');
    return S.detailEdited || S.pwMenuOpen || (!!a && a !== document.body && d.contains(a) && (S.editMode || a.matches('input, select, textarea')));
  }
  function renderPanel(rec, keepScroll) {
    const body = $('#dBody'); const top = body.scrollTop;
    S.detailStale = false; S.detailEdited = false; S.pwMenuOpen = false;
    renderDetailHead(rec);
    if (S.editMode) renderEditor(rec); else renderDetail(rec);
    if (keepScroll) body.scrollTop = top;
  }
  // Unsaved editor input stays until Save / another selection re-renders the panel, even after focus leaves it.
  // Controls that apply immediately re-render first, so their (detached) target does not count.
  ['input', 'change', 'click'].forEach(type => $('#dBody').addEventListener(type, e => {
    if (e.target.isConnected && (type !== 'click' || e.target.closest('.chip-lg, [data-step]'))) S.detailEdited = true;
  }));
  $('#detail').addEventListener('focusout', () => setTimeout(() => {
    if (!S.detailStale || detailBusy()) return;
    const rec = S.recs.get(S.selected); if (rec) renderPanel(rec, true); else S.detailStale = false;
  }, 250));
  function select(id, opts = {}) {
    const rec = S.recs.get(id); if (!rec) return;
    const refresh = !!opts.refresh && S.selected === id;
    // Rack front view: anything in a rack shows that rack; anything else leaves the front view (and flies there)
    let stayFront = false;
    if (S.front) {
      const su = rackRecOf(rec);
      if (refresh) stayFront = true;
      else if (su) { stayFront = true; if (su.id !== S.front) S.front = su.id; }
      else hideRackFront();
    }
    S.selected = id; $('#vFocus').disabled = !id;
    clearSelectionHelper();   // dispose: a live refresh re-selects every 15 s
    if (rec.group) {
      scene.updateMatrixWorld(true);   // groups rebuilt a moment ago have not been rendered yet: their world matrices are stale
      const b = new THREE.Box3(); rec.meshes.forEach(m => b.expandByObject(m)); if (rec.cat === 'setup' || rec.cat === 'storage') b.setFromObject(rec.group);
      if (!b.isEmpty()) { b.expandByScalar(0.02); selectionHelper = new THREE.Box3Helper(b, new THREE.Color(SELECT_COLOR)); selectionHelper.material.transparent = true; selectionHelper.material.opacity = .95; scene.add(selectionHelper); }
    }
    $$('.lbl.sel').forEach(l => l.classList.remove('sel')); if (rec.label) rec.label.classList.add('sel');
    if (refresh && detailBusy()) S.detailStale = true; else renderPanel(rec, refresh);
    renderTree(); renderRackBar();
    $('#detail').classList.remove('hidden');
    if (!refresh) setSheet(S.sheet.size === 'peek' ? 'half' : null, 'details'); else updateSheetTabs();
    resize();
    if (S.front && !opts.refresh) renderRackFront();
    // fly only after the detail panel is open: framing uses the final viewport size and overlays
    if (rec.group && !opts.keepCamera && opts.fly !== false && !stayFront) flyTo(rec);
  }
  function closeDetail() {
    S.selected = null; S.pwMenuOpen = false; $('#vFocus').disabled = true; clearSelectionHelper(); $('#detail').classList.add('hidden');
    $$('.lbl.sel').forEach(l => l.classList.remove('sel')); renderTree(); renderRackBar();
    if (S.front) renderRackFront();
    if (S.sheet.tab === 'details') setSheet(null, S.sideTab === 'tree' ? 'racks' : 'issues'); else updateSheetTabs();
    resize();
  }
  $('#dClose').onclick = closeDetail;

  function confPill(c) { return `<span class="pill conf-${esc(c)}"><span class="sw" style="background:currentColor"></span>${esc(c)}</span>`; }
  function statusPill(st) { return `<span class="pill" style="color:${STATUS_COLOR[st]};border-color:${STATUS_COLOR[st]}66;background:${STATUS_COLOR[st]}14"><span class="sw" style="background:${STATUS_COLOR[st]}"></span>${STATUS_LABEL[st]}</span>`; }
  const PHOTO_SRC = n => (window.LAB_PHOTOS && window.LAB_PHOTOS[n]) || `photos/photo-0${n}.jpg`;
  function photosHtml(list) {
    if (!list || !list.length) return `<div class="note muted">No photo shows this object directly (from DCIM data).</div>`;
    return `<div class="photos">${list.map(n => `<a href="${esc(PHOTO_SRC(n))}" target="_blank" title="${esc(S.data.meta.photoIndex[n] || '')}"><img src="${esc(PHOTO_SRC(n))}" alt="photo ${esc(n)}"/><div class="pn">photo ${esc(n)}</div></a>`).join('')}</div>`;
  }
  function link(id, text) { return `<a href="#" data-go="${esc(id)}">${esc(text || id)}</a>`; }
  function locationOf(rec) {
    const parts = [];
    if (rec.zone) { const z = S.data.zones.find(x => x.id === rec.zone); parts.push(link(rec.zone, z ? `${z.id} — ${rowLabel(z)}` : rec.zone)); }
    if (rec.setup && rec.cat !== 'setup') { const su = S.recs.get(rec.setup); parts.push(link(rec.setup, su ? `${rackName(su.def)} (${su.id})` : rec.setup)); }
    if (rec.shelf) { const sh = S.recs.get(rec.shelf); parts.push(link(rec.shelf, sh ? `${shelfCaption(sh)} · ${sh.id}` : rec.shelf)); }
    if (rec.item?.placement === 'bottom-bay') parts.push('bottom bay (floor)');
    if (rec.item?.storage) parts.push(link(rec.item.storage));
    const a = anchorOf(rec); if (a) parts.push(`<span class="mono muted" title="metres from the left wall (x) and from the entrance wall (z)">x ${DX(a.x).toFixed(2)} · z ${a.z.toFixed(2)} m</span>`);
    return parts.join('<br/>') || '—';
  }
  function kindOf(rec) {
    if (rec.cat === 'item') return ITEM_KIND[rec.item?.type] || (String(rec.item?.type || '').startsWith('equip-') ? 'Equipment' : 'Object');
    if (rec.cat === 'structure') return /^DOOR/.test(rec.id) ? 'Door' : /^WIN/.test(rec.id) ? 'Window' : /^PILLAR/.test(rec.id) ? 'Column' : 'Fixture';
    return CAT_LABEL[rec.cat] || rec.cat;
  }
  // Drawer header: name, kind · id (an OPT shows its host name from the DCIM label), health badge
  function renderDetailHead(rec) {
    const it = rec.item; const def = rec.def;
    $('#dName').textContent = rec.cat === 'setup' ? rackName(def) : rec.cat === 'shelf' ? `${rackName(S.recs.get(rec.setup)?.def)} · ${shelfCaption(rec)}` : def.name || rec.id;
    $('#dId').textContent = it?.type === 'opt' && it.live?.inDcim ? `Server · host ${pingKey(it.name)}` : `${kindOf(rec)} · ${rec.id}`;
    const h = healthOfRec(rec); const hb = $('#dHealth');
    hb.className = 'hbadge' + (h ? ' h-' + h.h : ' hidden'); hb.textContent = h ? HEALTH[h.h].t : ''; hb.title = h?.why || '';
    $('#detail').setAttribute('aria-label', `${$('#dName').textContent} details`);
  }
  const cell = (label, value, cls = '') => `<div class="scell${cls ? ' ' + cls : ''}"><div class="sl">${esc(label)}</div><div class="sv">${esc(value)}</div></div>`;
  const section = (title, body) => `<section class="sec"><h3 class="sec-h">${title}</h3>${body}</section>`;
  const more = (key, title, body) => `<details class="more" data-more="${esc(key)}"${S.drawerOpen[key] ? ' open' : ''}><summary>${title}</summary><div class="more-b">${body}</div></details>`;
  function inventoryKv(rec) {
    const def = rec.def; const it = rec.item;
    return `<div class="kv">
      <span class="k">Type</span><span class="v">${esc(kindOf(rec))}${it?.typeLabel ? ' · ' + esc(it.typeLabel) : ''}</span>
      <span class="k">ID</span><span class="v mono">${esc(rec.id)}</span>
      ${rec.cat === 'setup' ? `<span class="k">Name</span><span class="v">${esc(def.name)}</span>` : ''}
      ${it?.serial_number ? `<span class="k">SN</span><span class="v mono">${esc(it.serial_number)}</span>` : ''}
      ${it?.barcode ? `<span class="k">Barcode</span><span class="v mono">${esc(it.barcode)}</span>` : ''}
      ${it?.shelf_position ? `<span class="k">Shelf position</span><span class="v">${esc(it.shelf_position)}</span>` : ''}
      ${it?.last_seen_at ? `<span class="k">Last seen</span><span class="v">${esc(ago(it.last_seen_at))} <span class="muted small mono">${esc(fmtTs(it.last_seen_at))}</span></span>` : it?.tracking ? `<span class="k">Last seen</span><span class="v muted">never scanned</span>` : ''}
      ${it?.tracking?.count ? `<span class="k">Tracking</span><span class="v">${it.tracking.count} event${it.tracking.count === 1 ? '' : 's'}${it.tracking.last ? ` · last: ${esc(it.tracking.last.action || '?')}${it.tracking.last.at ? ' ' + esc(ago(it.tracking.last.at)) : ''}` : ''}</span>` : ''}
      <span class="k">Lifecycle</span><span class="v">${statusPill(rec.status)}</span>
      <span class="k">Confidence</span><span class="v">${confPill(rec.conf || 'medium')}${rec.pconf && rec.pconf !== rec.conf ? ` <span class="muted small">placement:</span> ${confPill(rec.pconf)}` : ''}${rec.cat === 'setup' && def.dcimMappingConfidence ? ` <span class="muted small">DCIM mapping:</span> ${confPill(def.dcimMappingConfidence)}` : ''}</span>
      ${it?.type !== 'opt' ? `<span class="k">Owner</span><span class="v">${esc(it?.owner || def.owner || '—')}${it?.live?.owner ? ' <span class="muted small">(Lab Manager)</span>' : ''}</span>` : ''}
      <span class="k">Location</span><span class="v">${locationOf(rec)}</span>
    </div>`;
  }
  // Data-quality findings about this object: the Data quality entries, live warnings, an estimated place
  function dqOf(rec) {
    const out = (S.attention || []).filter(e => e.group === 'dq' && e.id === rec.id).map(e => esc(e.text) + (e.hint ? `<small>${esc(e.hint)}</small>` : ''));
    if (rec.item?.liveWarning) out.push(esc(rec.item.liveWarning));
    if (rec.pconf === 'low' && !(S.attention || []).some(e => e.kind === 'auto-u' && e.id === rec.id)) out.push('Place is estimated (low placement confidence)');
    return out;
  }
  function moreSections(rec) {
    const dq = dqOf(rec); const notes = cleanNotes(rec.item?.notes || rec.def.notes);
    return `<div class="more-list">${more('inv', 'Inventory', inventoryKv(rec))}` +
      more('dq', `Data quality · ${dq.length} issue${dq.length === 1 ? '' : 's'}`, dq.length ? `<ul class="dq-ul">${dq.map(x => `<li>${x}</li>`).join('')}</ul>` : '<div class="muted small">Nothing to correct.</div>') +
      more('photos', 'Photos &amp; notes', `${notes ? `<div class="note">${esc(notes)}</div>` : ''}${photosHtml(rec.def.photos)}${rec.tpl?.source ? `<div class="muted small" style="margin-top:6px">Dimensions: ${esc(rec.tpl.source)}</div>` : ''}`) + '</div>';
  }
  const locationSec = rec => section('Location', `<div class="loc-row"><span>${esc(placeLabel(rec))}</span>${rec.group ? '<button type="button" class="link" data-focus>Show in 3D</button>' : ''}</div>`);

  function renderDetail(rec) {
    const def = rec.def; const it = rec.item; const live = S.live.connected; const canOperate = !!window.DCIM_CAN_OPERATE;
    let html = '';
    // ── servers (OPT): status, actions, location, connections
    if (it?.type === 'opt') {
      const dc = it.dcim || {};
      // Power and console act only on a mapping that comes from live DCIM data. A lab-data.json outlet / KVM port
      // of a server missing from the live PDU labels may be stale and point at another machine.
      const pw = powerTarget(it); const kvLive = kvmTargets(it); const stale = live && !pw;
      const maint = pw && inMaintenance(pw.pduId);
      const pState = powerText(it);
      html += section('Status', `<div class="sgrid">${cell('Power', pState, /^On/.test(pState) ? 'ok' : /^Off|unreachable/.test(pState) ? 'bad' : '')}${cell('Ping', pingText(it), /^Up/.test(pingText(it)) ? 'ok' : /^Down/.test(pingText(it)) ? 'bad' : '')}${cell('Owner', it.owner || '—')}${cell('Console', consoleText(it))}</div>`);
      let act;
      if (!canOperate) act = `<div class="note readonly-note">Read-only · Power and console need the Operator role.</div>`;
      else {
        const why = !live ? 'Connect the backend first' : stale ? 'Not in live DCIM — power disabled' : '';
        const consoleBtns = kvLive.length
          ? kvLive.map(k => `<button type="button" class="kbtn primary md" data-kvm="${esc(k.kvm)}" data-port="${esc(k.port)}" title="Open the KVM console · ${esc(k.kvmName)} port ${esc(k.port)}">Open console${kvLive.length > 1 ? ` · ${esc(k.kvmName)} p${esc(k.port)}` : ''}</button>`).join('')
          : `<button type="button" class="kbtn primary md" disabled title="${esc(!live ? 'Connect the backend first' : stale ? 'Not in live DCIM — console disabled' : 'No KVM port is mapped to this server')}">Open console</button>`;
        const dis = pw ? '' : ' disabled'; const mt = maint ? ' disabled title="PDU in maintenance mode"' : '';
        act = `${stale ? `<div class="warn-box" role="status"><b>Not in live DCIM — power disabled</b><br/>This server is not in the live PDU labels, so the outlet and KVM port saved in lab-data.json may belong to another machine. Power and console stay disabled until it appears in Lab Manager.</div>` : ''}
          <div class="act-row">${consoleBtns}<div class="pw-wrap"><button type="button" class="kbtn danger-secondary md" data-power-menu aria-haspopup="menu" aria-expanded="false" aria-controls="pwMenu"${dis}${why ? ` title="${esc(why)}"` : ''}>Power…</button>
            <div class="menu pw-menu hidden" id="pwMenu" role="menu" aria-label="Power">
              <button type="button" role="menuitem" data-pw="on"${dis || mt}${why ? ` title="${esc(why)}"` : ''}>Power on</button>
              <button type="button" role="menuitem" data-pw="off"${dis}${why ? ` title="${esc(why)}"` : ''}>Power off</button>
              <button type="button" role="menuitem" data-pw="cycle"${dis || mt}${why ? ` title="${esc(why)}"` : ''}>Power cycle</button>
            </div></div></div>
          <div class="act-note">Power actions always ask for confirmation and show the exact PDU and outlet.</div>
          ${maint ? '<div class="note">This PDU is in maintenance mode: Power on and Power cycle stay blocked until it is restored in Lab Manager.</div>' : ''}
          ${live ? '' : '<div class="note">Connect the Lab Manager backend (More › Backend connection) to switch outlets and open the KVM console.</div>'}
          ${it.unmappedRack ? `<div class="warn-box">This server is in DCIM rack <b>${esc(it.live.rack)}</b>, which is not mapped to a physical rack yet.</div>` : ''}`;
      }
      html += section('Actions', act);
      html += locationSec(rec);
      // connections: PDU outlet, KVM port(s), management switch, DCIM rack / U
      const rows = [];
      if (dc.pduName || dc.pdu) {
        const st = !live ? 'Unknown' : stale ? 'Not live' : STATE_TEXT(it.live.state); const cls = st === 'On' ? 'on' : st === 'Off' ? 'off' : 'unk';
        const pid = pw ? pduItemId(dc.pdu) : '';
        rows.push(`<div class="crow"><span>${pid ? link(pid, `${dc.pduName || dc.pdu} · outlet ${dc.outlet ?? '?'}`) : esc(`${dc.pduName || dc.pdu} · outlet ${dc.outlet ?? '?'}`)}</span><span class="cst ${cls}">${esc(st)}</span></div>`);
      }
      (live ? kvLive : (dc.kvm || [])).forEach(k => {
        const p = live ? kvmPort(k.kvm, Number(k.port)) : null; const st = !live ? 'Unknown' : S.live.kvm?.[k.kvm]?.reachable === false ? 'Unreachable' : p?.in_use ? 'In use' : 'Free';
        rows.push(`<div class="crow"><span>${esc(`${k.kvmName || k.kvm} · port ${k.port}`)}</span><span class="cst ${st === 'Free' ? 'free' : st === 'In use' ? 'busy' : 'unk'}">${esc(st)}</span></div>`);
      });
      if (stale && (dc.kvm || []).length) rows.push(`<div class="crow muted"><span>KVM port in lab-data.json</span><span class="cst unk">not in live DCIM</span></div>`);
      if (it.live?.sw?.switch) rows.push(`<div class="crow"><span>${esc(it.live.sw.switch)}${it.live.sw.port ? ' · port ' + esc(it.live.sw.port) : ''}</span><span class="cst unk">Network</span></div>`);
      const rackU = it.live?.rack ? `DCIM rack ${it.live.rack} · U${String(it.live.u).padStart(2, '0')}${it.placementConfidence === 'low' ? ' (auto)' : ''}` : '';
      html += section('Connections', (rows.join('') || `<div class="muted small">${live ? 'No live connections.' : 'Connect the backend for live connections.'}</div>`) + (rackU ? `<div class="crow-foot">${esc(rackU)}</div>` : ''));
      html += moreSections(rec);
    } else if (rec.cat === 'item') {
      // ── other devices: a status grid, then their own sections (PDU outlets, KVM ports)
      if (it.type === 'pdu') {
        const st = it.live?.status; const dev = it.dcim?.deviceId || it.live?.device?.id; const m = dev && S.live.connected ? S.live.maintenance?.pdus?.[dev] : null;
        const reach = !live ? 'No live data' : !it.live ? 'Not in live DCIM' : st?.reachable === true ? 'Reachable' : st?.reachable === false ? 'Offline' : 'Loading…';
        const on = st?.reachable && st.outlets ? `${st.outlets.filter(o => o.state === 'on').length}/${st.outlets.length}` : '—';
        html += section('Status', `<div class="sgrid">${cell('Reachable', reach, reach === 'Reachable' ? 'ok' : reach === 'Offline' ? 'bad' : '')}${cell('Load', st?.reachable && st.total_watts != null ? `${(st.total_watts / 1000).toFixed(2)} kW${st.watts_complete === false ? ' (partial)' : ''}` : '—')}${cell('Outlets on', on)}${cell('Maintenance', m ? (Number(m.started_at) ? `Since ${hhmm(Number(m.started_at) * 1000)}` : 'Yes') : live ? 'No' : '—', m ? 'maint' : '')}</div>`);
      } else if (it.type === 'kvm') {
        const st = it.live?.status; const ports = st?.ports || [];
        const reach = !live ? 'No live data' : !it.live ? 'Not in live DCIM' : st?.reachable === false ? 'Offline' : st?.reachable ? 'Reachable' : 'Loading…';
        html += section('Status', `<div class="sgrid">${cell('Reachable', reach, reach === 'Reachable' ? 'ok' : reach === 'Offline' ? 'bad' : '')}${cell('Sign-in', st?.reachable ? (st.error ? 'Failed' : 'OK') : '—', st?.error ? 'bad' : '')}${cell('Ports in use', ports.length && !st?.error ? `${ports.filter(p => p.in_use).length} of ${ports.length}` : '—')}${cell('Owner', it.owner || def.owner || '—')}</div>`);
      } else {
        html += section('Status', `<div class="sgrid">${cell('Type', kindOf(rec))}${cell('Lifecycle', STATUS_LABEL[rec.status] || rec.status)}${cell('Owner', it.owner || def.owner || '—')}${cell(it.last_seen_at ? 'Last seen' : 'Placement', it.last_seen_at ? ago(it.last_seen_at) : (rec.pconf || rec.conf || 'medium') + ' confidence')}</div>`);
      }
      // ── PDU outlets (unchanged contract: the first .note is the outlet-count note, the heading starts with "Outlets")
      if (it.type === 'pdu') {
        const st = it.live?.status; const labels = it.dcim?.labels || it.live?.device?.labels || {};
        // Without a live outlet list (unreachable / not loaded / offline) show the PDU's own outlets with an unknown state:
        // the numbers it last answered with, else its known outlet count, else only its labelled outlets — never a made-up 24.
        const unknownOutlet = (n, label) => ({ number: n, label: labels[String(n)] || label || `Outlet ${n}`, state: 'unknown', watts: null });
        const count = st?.reachable && st.outlets?.length ? null : st?.outlets?.length ? { n: st.outlets.length, src: 'from Lab Manager' } : pduOutletCount(it);
        const outlets = !count ? st.outlets : st?.outlets?.length ? st.outlets.map(o => unknownOutlet(o.number, o.label))
          : count.n ? Array.from({ length: count.n }, (_, i) => unknownOutlet(i + 1))
          : Object.keys(labels).map(Number).filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b).map(n => unknownOutlet(n));
        const countNote = !count ? '' : count.n ? `${count.n} outlets (${count.src}) · state unknown` : 'outlet count unknown';
        html += `<section class="sec"><h3 class="sec-h">Outlets <span class="sec-sub">${live ? (st?.reachable === false ? `<span class="bad">unreachable</span> · ${countNote}` : st && !count ? `${outlets.filter(x => x.state === 'on').length}/${outlets.length} on · ${st.total_watts == null ? '—' : (st.total_watts / 1000).toFixed(2) + ' kW' + (st.watts_complete === false ? ' (partial)' : '')}` : st ? countNote : 'loading…') : 'static labels · click needs backend'}</span></h3>
          ${count && !count.n ? `<div class="note muted" style="margin-bottom:6px">Outlet count unknown: the PDU has not reported its outlets and no outlet count is set for it in Lab Manager.${outlets.length ? ' Only its labelled outlets are shown.' : ''}</div>` : ''}
          <div class="ogrid">${outlets.map(x => { const named = !isDefaultOutletLabel(x.label); const cls = x.state === 'unknown' ? 'unknown' : `${esc(x.state)} ${named ? 'named' : 'free'}`; return `<div class="ocell ${cls}" data-outlet="${esc(x.number)}" title="${esc(x.label)}"><span class="n">#${esc(x.number)}</span><span class="l">${named ? esc(x.label) : '—'}</span><span class="w">${x.watts == null ? '—' : Math.round(x.watts) + ' W'}</span></div>`; }).join('')}</div>
          ${st?.temperature != null || st?.humidity != null ? `<div class="kv" style="margin-top:8px"><span class="k">Environment</span><span class="v">${st.temperature != null ? `${st.temperature.toFixed(1)} °C` : ''} ${st.humidity != null ? `· ${st.humidity.toFixed(0)} % humidity` : ''} ${st.leak_detected ? '<span class="bad">· leak</span>' : ''}</span></div>` : ''}
          ${st?.error ? `<div class="err-box" style="margin-top:8px">${esc(st.error)}</div>` : ''}
        </section>`;
      }
      // ── KVM ports
      if (it.type === 'kvm') {
        const st = it.live?.status; const labels = it.dcim?.labels || it.live?.device?.labels || {}; const n = it.dcim?.ports || it.live?.device?.port_count || 8;
        const failed = live && st?.reachable && st.error;   // answered, but sign-in / API failed: port states are unknown
        const ports = st?.ports?.length && !failed ? st.ports : Array.from({ length: n }, (_, i) => ({ number: i + 1, label: labels[String(i + 1)] || `Port ${i + 1}`, status: failed ? 'unknown' : labels[String(i + 1)] ? 'idle' : 'empty' }));
        html += `<section class="sec"><h3 class="sec-h">Ports <span class="sec-sub">${live ? (st?.reachable === false ? '<span class="bad">unreachable</span>' : failed ? '<span class="bad">sign-in failed</span>' : !canOperate ? 'read-only · console needs the Operator role' : !it.live?.device ? 'not in live DCIM — console disabled' : 'click a port to open the console') : 'static labels'}</span></h3>
          <div class="ogrid ${n <= 8 ? 'k8' : ''}">${ports.map(p => `<div class="ocell ${esc(p.status)}${p.in_use ? ' hl' : ''}" data-kport="${esc(p.number)}" title="${esc(p.label)}"><span class="n">p${esc(p.number)}</span><span class="l">${isDefaultOutletLabel(p.label) ? '—' : esc(p.label)}</span>${p.in_use ? '<span class="w">IN USE</span>' : ''}</div>`).join('')}</div>${failed ? `<div class="err-box" style="margin-top:8px">${esc(st.error)}</div>` : ''}</section>`;
      }
      if (it.liveWarning) html += `<div class="warn-box" role="status">${esc(it.liveWarning)}</div>`;
      html += locationSec(rec) + moreSections(rec);
    } else if (rec.cat === 'setup') {
      // ── rack: power, PDU, issues, temperature; Rack front; DCIM mapping; shelves
      const t = rackTelemetry(def); const pdus = rackPdus(def); const m = pdus.map(p => S.live.maintenance?.pdus?.[p.id]).find(Boolean);
      const open = (S.attention || []).filter(e => e.group === 'issue' && e.kind !== 'offline' && e.setup === rec.id).length;
      const power = !live ? 'No live data' : !t ? (def.dcimRack ? 'No PDU' : 'Not mapped') : t.loading ? 'Loading…' : !t.reachable ? 'PDU offline' : `${t.watts == null ? '—' : (t.partial ? '≥' : '') + (t.watts / 1000).toFixed(2)} kW · ${t.on}/${t.total} on`;
      const pduTxt = !live ? '—' : !pdus.length ? 'None' : m && live ? (Number(m.started_at) ? `Maintenance since ${hhmm(Number(m.started_at) * 1000)}` : 'Maintenance') : pdus.some(p => S.live.pdu?.[p.id]?.reachable === false) ? 'Offline' : pdus.every(p => S.live.pdu?.[p.id]?.reachable) ? 'Reachable' : 'Loading…';
      html += section('Status', `<div class="sgrid">${cell('Power', power)}${cell('PDU', pduTxt, pduTxt === 'Offline' ? 'bad' : pduTxt === 'Reachable' ? 'ok' : /^Maint/.test(pduTxt) ? 'maint' : '')}${cell('Issues', open ? `${open} open` : 'None', open ? 'bad' : '')}${cell('Temperature', t?.temp != null ? `${t.temp.toFixed(1)} °C` : '—')}</div>`);
      html += section('Actions', `<div class="act-row"><button type="button" class="kbtn primary md" data-front="${esc(rec.id)}">Rack front</button><button type="button" class="kbtn secondary md" data-focus>Show in 3D</button></div>`);
      const racks = [...new Set([...(S.data.dcim?.pdus || []).map(p => p.rack), ...S.model.liveRacks])].filter(Boolean).sort();
      const cur = dcimRackOf(def) || '';
      html += section('DCIM rack mapping', `<div class="edit-grid"><span>Rack in DCIM</span><select id="dRack" ${canOperate ? '' : 'disabled'} aria-label="Rack in DCIM"><option value="">— none —</option>${racks.map(r => `<option value="${esc(r)}" ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></div><div class="muted small" style="margin-top:6px">The photos do not show which physical rack is which DCIM rack. Change it here and use More › Export layout (JSON) or Save to server to keep it.</div>`);
      const shelves = recsOf(r => r.cat === 'shelf' && r.setup === rec.id).sort((a, b) => b.level - a.level);
      html += section('Shelves', shelves.map(sh => {
        const its = recsOf(r => r.cat === 'item' && r.shelf === sh.id);
        return `<div class="srow" data-go="${esc(sh.id)}" tabindex="0" role="button"><span class="lvl">${esc(shelfCaption(sh))}</span><span class="sub">${its.length ? its.map(i => esc(i.item.name)).join(', ') : 'empty'}</span></div>`;
      }).join(''));
      const bay = recsOf(r => r.cat === 'item' && r.setup === rec.id && !r.shelf);
      if (bay.length) html += section('Rack-level equipment', bay.map(i => `<div class="srow" data-go="${esc(i.id)}" tabindex="0" role="button">${dot(i)}<span class="nm">${esc(i.item.name)}</span><span class="sub">${esc(ITEM_KIND[i.item.type] || i.item.type)}</span></div>`).join(''));
      html += moreSections(rec);
    } else if (rec.cat === 'shelf') {
      const its = recsOf(r => r.cat === 'item' && r.shelf === rec.id);
      html += section('On this shelf', `${its.length ? its.map(i => { const lv = i.item.live; return `<div class="srow" data-go="${esc(i.id)}" tabindex="0" role="button">${dot(i)}<span class="nm">${esc(i.item.name)}</span><span class="sub">${i.item.type === 'opt' ? `#${esc(i.item.dcim?.outlet ?? '?')}${lv?.sw ? ' · ' + esc(lv.sw.switch) + (lv.sw.port ? '·' + esc(lv.sw.port) : '') : ''}` : esc(ITEM_KIND[i.item.type] || i.item.type)}</span>${lv?.inDcim ? `<span class="stt ${lv.state === 'on' ? 'on' : lv.state === 'off' ? 'off' : 'unk'}">${esc(lv.state)}</span>` : ''}</div>`; }).join('') : '<div class="muted small">Nothing on this shelf.</div>'}
        <div class="muted small" style="margin-top:6px">Which server is on which shelf comes from Lab Manager rack slots when connected; otherwise lab-data.json.</div>`);
      html += locationSec(rec) + moreSections(rec);
    } else if (rec.cat === 'storage') {
      const its = recsOf(r => r.cat === 'item' && r.item?.storage === rec.id);
      html += section('Contents', its.length ? its.map(i => `<div class="srow" data-go="${esc(i.id)}" tabindex="0" role="button">${dot(i)}<span class="nm">${esc(i.item.name)}</span><span class="sub">×${esc(i.item.quantity || 1)}</span></div>`).join('') : '<div class="muted small">Empty.</div>');
      html += locationSec(rec) + moreSections(rec);
    } else {
      html += section('About', inventoryKv(rec)) + (def.note || def.notes ? section('Notes', `<div class="note">${esc(def.note || def.notes)}</div>`) : '') + section('Photos', photosHtml(def.photos));
    }
    const body = $('#dBody'); body.innerHTML = html;

    // handlers
    $$('[data-go]', body).forEach(el => { el.onclick = e => { e.preventDefault(); select(el.dataset.go); }; if (el.tagName !== 'A') el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(el.dataset.go); } }; });
    $$('[data-focus]', body).forEach(el => el.onclick = () => { if (S.front) hideRackFront(); if (isPhone()) setSheet('peek'); flyTo(rec, true); });
    $$('[data-front]', body).forEach(el => el.onclick = () => showRackFront(el.dataset.front));
    $$('details[data-more]', body).forEach(d => d.addEventListener('toggle', () => { S.drawerOpen[d.dataset.more] = d.open; LS.set('drawerOpen', S.drawerOpen); }));
    const pm = $('[data-power-menu]', body);
    if (pm) {
      pm.onclick = () => (S.pwMenuOpen ? closePwMenu(true) : openPwMenu());
      pm.onkeydown = e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openPwMenu(e.key === 'ArrowUp'); } };
      menuKeys($('#pwMenu'), r => closePwMenu(r));
    }
    // the mapping is re-checked at click time (a live refresh may have changed it since the panel was drawn)
    $$('[data-pw]', body).forEach(b => b.onclick = () => { const btn = $('[data-power-menu]', body); closePwMenu(true, true); outletAction(powerTarget(it), b.dataset.pw, btn); });
    $$('[data-kvm]', body).forEach(b => b.onclick = () => openKvm(b.dataset.kvm, parseInt(b.dataset.port, 10), it.name));
    $$('[data-outlet]', body).forEach(c => c.onclick = e => outletMenu(e, it, parseInt(c.dataset.outlet, 10)));
    $$('[data-kport]', body).forEach(c => c.onclick = () => { if (!S.live.connected) { toast('Connect the backend to open the KVM console', 'err'); return; } if (!it.live?.device) { toast('Not in live DCIM — console disabled', 'err'); return; } openKvm(it.live.device.id, parseInt(c.dataset.kport, 10), c.title); });
    const dr = $('#dRack'); if (dr) dr.onchange = () => { patchDef(rec.id, { dcimRack: dr.value || null, dcimMappingConfidence: 'medium' }); rebuildAll(); toast(`${rec.id} → ${dr.value || 'no DCIM rack'}`, 'ok'); };
  }
  // ── Power… menu in the drawer: the three actions, each still confirmed by outletAction
  function openPwMenu(last) {
    const m = $('#pwMenu'), b = $('#dBody [data-power-menu]'); if (!m || !b || b.disabled) return;
    m.classList.remove('hidden'); b.setAttribute('aria-expanded', 'true'); S.pwMenuOpen = true;
    const items = $$('[role="menuitem"]:not([disabled])', m); (last ? items[items.length - 1] : items[0])?.focus();
  }
  function closePwMenu(refocus, acting) {
    const m = $('#pwMenu'), b = $('#dBody [data-power-menu]'); const was = S.pwMenuOpen; S.pwMenuOpen = false;
    if (m) m.classList.add('hidden'); if (b) b.setAttribute('aria-expanded', 'false');
    if (refocus && b) b.focus({ preventScroll: true });
    // a refresh that arrived while the menu was open is applied now (not while a power dialog is about to open)
    if (was && !acting && S.detailStale && !detailBusy()) { const rec = S.recs.get(S.selected); if (rec) renderPanel(rec, true); }
  }
  // Arrow keys / Home / End move between enabled items of a menu, Escape closes it, Tab leaves it.
  function menuKeys(menu, onClose) {
    if (!menu) return;
    menu.onkeydown = e => {
      const items = $$('[role^="menuitem"]:not([disabled])', menu).filter(x => x.offsetParent !== null); const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); }
      else if (e.key === 'Tab') onClose(false);
    };
  }
  // ── data editing helpers
  function ownerPicker(current = '') {
    const people = S.live.engineers.filter(p => p.active || p.name === current);
    const known = people.some(p => p.name === current);
    return `<select id="eOwner" aria-label="Owner"><option value="">— No owner —</option>${current && !known ? `<option value="${esc(current)}" selected>${esc(current)} (current)</option>` : ''}${people.map(p => `<option value="${esc(p.name)}" ${p.name === current ? 'selected' : ''} ${!p.active ? 'disabled' : ''}>${esc(p.name)}${p.active ? '' : ' (inactive)'}</option>`).join('')}</select>`;
  }
  // Owners of live DCIM objects live in Lab Manager (AssetOwner): OPT key = label.trim().toLowerCase(), rack item key = item:<id>.
  // `owner` in lab-data.json stays only for static items.
  function dcimOwnerKey(it) {
    if (!S.live.connected || !it) return null;
    if (it.type === 'opt' && it.live?.inDcim && it.dcim?.optKey) return it.dcim.optKey;
    if (it.id.startsWith('LIVE-') && it.type.startsWith('equip-')) return 'item:' + it.id.slice(5);
    return null;
  }
  async function saveDcimOwner(key, name) {
    const person = name ? S.live.engineers.find(p => p.name === name) : null;
    if (name && !person) throw new Error('Choose an engineer from the list');
    S.live.owners = await layoutWrite(() => api('/api/opt-owners/' + encodeURIComponent(key), { method: 'PUT', body: JSON.stringify({ engineer_id: person ? person.id : null }) }));
    computeModel(); buildItems();
  }
  function findDef(id) { const d = S.data; return d.setups.find(x => x.id === id) || d.shelves.find(x => x.id === id) || d.storage.find(x => x.id === id) || d.items.find(x => x.id === id) || null; }
  function patchDef(id, patch) { const def = findDef(id); if (!def) return false; Object.entries(patch).forEach(([k, v]) => { if (v === undefined) delete def[k]; else def[k] = v; }); markDirty(); return true; }
  function nextItemId() { let n = 0; S.data.items.forEach(i => { const m = /^ITEM-(\d+)$/.exec(i.id); if (m) n = Math.max(n, +m[1]); }); return 'ITEM-' + String(n + 1).padStart(4, '0'); }
  function zoneAt(x, z) { const zn = S.data.zones.find(q => x >= q.bounds[0] && x <= q.bounds[2] && z >= q.bounds[1] && z <= q.bounds[3]); return zn ? zn.id : null; }
  function addItem(partial) { const it = { id: nextItemId(), name: 'New item', category: 'item', type: 'other', status: 'unknown', owner: null, confidence: 'high', placementConfidence: 'high', photos: [], notes: '', ...partial }; S.data.items.push(it); markDirty(); rebuildAll(); select(it.id, { keepCamera: true }); toast(`${it.id} added — fill in the details and Save`, 'ok'); }
  function deleteItem(id) { S.data.items = S.data.items.filter(i => i.id !== id); markDirty(); closeDetail(); rebuildAll(); toast(`${id} deleted`, 'ok'); }
  function dataFingerprint(d) { const str = JSON.stringify({ m: d.meta && d.meta.generated, v: d.meta && d.meta.version, s: d.setups.map(x => x.id + x.dcimRack), sh: d.shelves.map(x => x.id), i: d.items.map(x => x.id + (x.shelf || '') + (x.placement || '')) }); let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return str.length + ':' + h; }
  // Edits are numbered: a save only clears the dirty state if nothing was edited while its request was in flight.
  let editSeq = 0, saveInFlight = false;
  function markDirty() { editSeq++; S.dirty = true; S.data.meta.modified = new Date().toISOString(); LS.set('draft', { savedAt: Date.now(), base: S.dataBase, data: S.data }); updateSaveBar(); }
  function updateSaveBar() { const bar = $('#saveBar'); if (!bar) return; bar.classList.toggle('hidden', !S.dirty); $('#sbSave').disabled = saveInFlight || !location.protocol.startsWith('http'); $('#sbSave').title = location.protocol.startsWith('http') ? 'PUT /api/twin-data (writes lab-twin/lab-data.json on the server)' : 'Only available when served from the Lab Manager backend'; if (S.moveItem) placeAttnDock(); }
  // Content stamp of lab-data.json as this page last read or wrote it (FNV-1a over the canonical JSON text).
  function textStamp(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return str.length + ':' + h.toString(16); }
  const dataStamp = d => textStamp(JSON.stringify(d));
  async function staleSaveDialog() {
    const choice = await askChoice({ title: 'lab-data.json changed on the server',
      html: '<div class="warn-box">Someone saved lab-data.json after this page loaded it. Saving now would overwrite their changes, so nothing was saved.</div><div class="note">Download your edits as JSON to keep them, then reload the page and apply them again.</div>',
      choices: [{ id: 'cancel', label: 'Close' }, { id: 'download', label: 'Download my edits', cls: 'primary' }] });
    if (choice === 'download') downloadJson();
  }
  async function saveToServer() {
    if (saveInFlight) return;
    const b = $('#sbSave'); saveInFlight = true; b.disabled = true; b.innerHTML = '<span class="busy"></span> Saving…';
    try {
      // Refuse to overwrite a lab-data.json that someone else (another window, another person) saved after this page
      // read it; the ETag of that check then goes out as If-Match, so a save landing in between is refused too (409).
      let etag = null;
      if (S.serverStamp) {
        const fresh = await api('/api/twin-data', { cache: 'no-store', withEtag: true });
        const current = fresh.data; etag = fresh.etag;
        if (dataStamp(current) !== S.serverStamp) { await staleSaveDialog(); return; }
      }
      const seq = editSeq; const body = JSON.stringify(S.data);
      await api('/api/twin-data', { method: 'PUT', body, headers: etag ? { 'If-Match': etag } : {} });
      S.serverStamp = textStamp(body); S.dataBase = dataFingerprint(JSON.parse(body));
      S.dirty = editSeq !== seq;   // an edit made while the request was in flight is not on the server yet
      if (S.dirty) markDirty(); else LS.set('draft', null);
      toast(S.dirty ? 'Saved — newer edits made during the save are still unsaved' : 'lab-data.json saved on the server', 'ok');
    } catch (e) {
      if (e.status === 409) await staleSaveDialog();   // someone saved between our check and our PUT (If-Match)
      else toast('Save failed: ' + e.message + ' — use Download JSON', 'err');
    }
    finally { saveInFlight = false; b.textContent = 'Save to server'; updateSaveBar(); }
  }
  function downloadJson() { const blob = new Blob([JSON.stringify(S.data, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lab-data.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('lab-data.json downloaded — replace the file next to index.html', 'ok'); }
  function pduItemId(deviceId) { const r = [...S.recs.values()].find(r => r.cat === 'item' && r.item?.type === 'pdu' && r.item.dcim?.deviceId === deviceId); return r ? r.id : ''; }

  function rebuildAll() {
    // setups/shelves colors follow overrides → rebuild static + items
    for (const [id, r] of [...S.recs]) { if (r.label) r.label.remove(); if (r.telem) r.telem.remove(); if (r.attnEl) r.attnEl.remove(); S.recs.delete(id); }
    S.labelHover = null;
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
  // Live badge: "Live · updated 8 s ago" (amber once older than 2.5 refresh intervals); otherwise it says why there is no
  // live data. A 1 s ticker rewrites only the text (no re-render, no live region).
  function pill(cls, text) { S.livePill = { cls, text }; renderLive(); }
  const hhmmss = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  function renderLive() {
    const p = $('#livePill'); if (!p) return; let { cls, text } = S.livePill; let short = text.split(' · ')[0];
    if (cls === 'online') {
      const prefix = window.LAB_DEMO ? 'DEMO (simulated)' : 'Live'; const at = S.live.updatedAt;
      const every = (window.DCIM_ACCOUNT_PREFS?.refresh_seconds || 15) * 1000;
      if (!at) text = `${prefix} · loading…`;
      else {
        const s = Math.max(0, Math.round((Date.now() - at) / 1000));
        text = `${prefix} · updated ${s < 60 ? s + ' s' : Math.round(s / 60) + ' min'} ago`;
        if (Date.now() - at > 2.5 * every) cls = 'online stale';
      }
      short = cls.includes('stale') ? 'Stale' : prefix === 'Live' ? 'Live' : 'Demo';
    }
    ['online', 'offline', 'error', 'connecting', 'stale'].forEach(c => p.classList.toggle(c, cls.split(' ').includes(c)));
    const t = $('#liveText'); if (t.textContent !== text) t.textContent = text;
    const sl = $('#sheetLive'); if (sl) { if (sl.textContent !== short) sl.textContent = short; sl.className = 'kbadge outline ' + cls; }
    if (cls.startsWith('online')) {
      const devs = S.live.devices || []; let kw = 0, known = 0, partial = false;
      devs.filter(d => d.kind === 'pdu').forEach(d => { const st = S.live.pdu[d.id]; if (st?.reachable && st.total_watts != null) { kw += st.total_watts; known++; } if (!st?.reachable || st.watts_complete !== true) partial = true; });
      p.title = `${S.live.updatedAt ? 'Last refresh ' + hhmmss(S.live.updatedAt) + ' · ' : ''}${devs.filter(d => d.kind === 'pdu').length} PDU · ${devs.filter(d => d.kind === 'kvm').length} KVM${known ? ` · ${(kw / 1000).toFixed(2)} kW${partial ? ' (partial)' : ''}` : ''} — click for the backend connection`;
    } else p.title = 'Backend connection';
  }
  const rackItemVersions = new WeakMap();
  async function api(path, opts = {}) {
    const base = (S.settings.url || '').replace(/\/$/, '');
    const { withEtag, ...init } = opts;
    const headers = { ...(init.headers || {}) }; if (init.body) headers['Content-Type'] = 'application/json'; if (S.settings.pass) headers.Authorization = 'Basic ' + btoa('x:' + S.settings.pass);
    const r = await fetch(base + path, { ...init, headers });
    if (r.status === 401) signedOut();
    if (!r.ok) {
      // user-facing errors show the server's `detail`, not the raw "409 {json}" body
      const text = await r.text().catch(() => ''); let detail = '';
      try { const d = JSON.parse(text).detail; detail = typeof d === 'string' ? d : Array.isArray(d) ? d.map(x => x && x.msg).filter(Boolean).join('; ') : ''; } catch { /* not JSON */ }
      throw Object.assign(new Error(detail || `${r.status} ${text}`.trim()), { status: r.status, detail });
    }
    if (r.status === 204) return withEtag ? { data: null, etag: r.headers.get('ETag') } : null;
    const data = await r.json();
    if (path === '/api/rack-items' && data && typeof data === 'object') rackItemVersions.set(data, r.headers.get('ETag'));
    return withEtag ? { data, etag: r.headers.get('ETag') } : data;
  }
  // Layout reads / writes are counted (at start and end): a live refresh that overlapped one keeps the newer local copy
  // of the layout stores instead of its older response (otherwise a just-saved move would jump back until the next poll).
  // Moves write through readMoveLayout() + dcimMoveMany() (one atomic PUT /api/rack-layout with If-Match revisions).
  let layoutWrites = 0;
  const LAYOUT_KEYS = ['rackSlots', 'rackOverrides', 'rackOrder', 'rackItems', 'owners'];
  async function layoutWrite(fn) { layoutWrites++; try { return await fn(); } finally { layoutWrites++; } }
  // after a failed Lab Manager move, show what the server actually stores
  async function reloadLayout() {
    const fresh = await layoutWrite(() => Promise.all(['/api/rack-slots', '/api/rack-overrides', '/api/rack-positions', '/api/rack-items'].map(p => api(p).catch(() => null))));
    ['rackSlots', 'rackOverrides', 'rackOrder', 'rackItems'].forEach((key, i) => { if (fresh[i]) S.live[key] = fresh[i]; });
  }
  const INVENTORY_PATHS = {
    devices: '/api/devices/', rackSlots: '/api/rack-slots', rackOrder: '/api/rack-positions',
    sw: '/api/switch-assignments', owners: '/api/opt-owners', rackItems: '/api/rack-items',
    chillers: '/api/chillers', rackOverrides: '/api/rack-overrides', engineers: '/api/engineers', maintenance: '/api/pdus/maintenance',
  };
  // A PDU in maintenance mode refuses power on / cycle until it is restored in Lab Manager.
  const inMaintenance = pduId => !!(S.live.connected && pduId && S.live.maintenance?.pdus?.[pduId]);
  async function readLiveInventory() {
    // Share the same inventory source on connection and every live refresh.
    // Failed requests must not clear previously loaded devices or placements.
    const entries = await Promise.all(Object.entries(INVENTORY_PATHS).map(async ([key, path]) => {
      try { return [key, await api(path)]; } catch { return null; }
    }));
    return Object.fromEntries(entries.filter(entry => entry && entry[1] != null));
  }
  let liveSession = 0;
  let refreshInFlight = null, refreshQueued = null;
  async function connect() {
    const session = ++liveSession;
    if (S.live.timer) clearInterval(S.live.timer);
    S.live.timer = null;
    S.live.connected = false;
    pill('connecting', 'Connecting…'); $('#sStatus').textContent = 'Connecting…';
    try {
      await window.DCIM_ACCOUNT_REFRESH?.();   // a new sign-in has a new CSRF token and maybe another role
      const inventory = await readLiveInventory();
      if (session !== liveSession) return;
      if (!Array.isArray(inventory.devices)) throw new Error('Could not load devices');
      Object.assign(S.live, inventory, { connected: true, error: null, signedOut: false, updatedAt: null, ping: {} }); pingAt = 0;
      const devices = S.live.devices;
      pill('online', `${window.LAB_DEMO ? 'DEMO (simulated)' : 'Live'} · ${devices.filter(d => d.kind === 'pdu').length} PDU · ${devices.filter(d => d.kind === 'kvm').length} KVM`);
      $('#sStatus').textContent = `Connected — ${devices.length} devices.`;
      computeModel(); buildItems(); await refreshStatuses();
      if (session !== liveSession) return;
      if (S.live.timer) clearInterval(S.live.timer);
      if (S.settings.poll) S.live.timer = setInterval(refreshStatuses, (window.DCIM_ACCOUNT_PREFS.refresh_seconds || 15) * 1000);
      toast('Backend connected', 'ok');
    } catch (e) {
      if (session !== liveSession) return;
      S.live.connected = false; S.live.error = String(e.message || e);
      pill('error', 'Backend error'); $('#sStatus').textContent = 'Error: ' + S.live.error + (location.protocol === 'file:' ? ' — if you opened index.html from disk, make sure the URL includes http:// and the backend allows CORS (it does by default).' : '');
      toast('Backend connection failed: ' + S.live.error, 'err');
      computeModel(); buildItems();
    }
  }
  function disconnect() { ++liveSession; S.live.connected = false; S.live.signedOut = false; S.live.updatedAt = null; S.live.ping = {}; if (S.live.timer) clearInterval(S.live.timer); S.live.timer = null; S.live.pdu = {}; S.live.kvm = {}; pill('offline', 'Offline · static data'); computeModel(); buildItems(); $('#sStatus').textContent = 'Disconnected.'; }
  // 401 = the session expired or the user signed out: never keep showing frozen data as "Live".
  // Data polling stops; only the public auth status is checked until someone signs in again.
  function signedOut() {
    if (!S.live.signedOut) {
      ++liveSession; S.live.signedOut = true; S.live.connected = false; S.live.updatedAt = null; S.live.ping = {}; S.live.pdu = {}; S.live.kvm = {};
      if (S.live.timer) clearInterval(S.live.timer); S.live.timer = null;
      pill('error', 'Signed out · sign in to resume'); $('#sStatus').textContent = 'Signed out — sign in to Lab Manager again; live data resumes automatically.';
      toast('Signed out — live data paused until you sign in again', 'err');
      computeModel(); buildItems();
    }
    if (!S.live.timer) S.live.timer = setInterval(resumeAfterSignIn, POLL_MS);
  }
  async function resumeAfterSignIn() {
    if (!S.live.signedOut) return;
    try {
      const auth = await (await fetch((S.settings.url || '').replace(/\/$/, '') + '/api/auth/status', { cache: 'no-store' })).json();
      if (S.live.signedOut && (auth.mode === 'legacy' || auth.user)) connect();
    } catch { /* still unreachable */ }
  }
  window.addEventListener('focus', resumeAfterSignIn);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeAfterSignIn(); });
  // A reachable PDU reports its real outlets; remember how many, so an unreachable PDU still shows its own outlet count.
  function setPduStatus(id, s) {
    S.live.pdu[id] = s;
    const n = s?.reachable && Array.isArray(s.outlets) ? s.outlets.length : 0;
    if (n && S.pduOutletsSeen[id] !== n) { S.pduOutletsSeen[id] = n; LS.set('pduOutlets', S.pduOutletsSeen); }
  }
  // Outlet count of a PDU without a live outlet list: set in Lab Manager (port_count), last reported here, lab-data.json;
  // n = null when none is known (the twin never invents a count).
  function pduOutletCount(it) {
    const id = it.dcim?.deviceId, dev = it.live?.device;
    if (dev?.port_count > 0) return { n: dev.port_count, src: 'set in Lab Manager' };
    if (id && S.pduOutletsSeen[id] > 0) return { n: S.pduOutletsSeen[id], src: 'last reported' };
    if (it.dcim?.outlets > 0) return { n: it.dcim.outlets, src: 'lab-data.json' };
    return { n: null, src: '' };
  }
  // Ping results from Lab Manager's monitor (GET /api/monitoring, at most once a minute). Only the state per server is
  // kept — never the monitored host names or device addresses that the overview also contains.
  let pingAt = 0;
  async function refreshPing(session) {
    if (Date.now() - pingAt < PING_MS) return; pingAt = Date.now();
    try {
      const m = await api('/api/monitoring', { cache: 'no-store' }); if (session !== liveSession) return;
      const map = {};
      (Array.isArray(m?.targets) ? m.targets : []).forEach(t => {
        if (!t || t.source !== 'inventory') return; const key = pingKey(t.inventory_name || t.name); if (!key) return;
        map[key] = { status: String(t.status || ''), rtt: Number.isFinite(t.rtt_ms) ? t.rtt_ms : null, checkedAt: t.checked_at || null, lastUpAt: t.last_up_at || null };
      });
      S.live.ping = map;
    } catch (e) { if (session === liveSession && (e.status === 403 || e.status === 404)) S.live.ping = null; }   // other failures keep the last value
  }
  async function refreshStatuses() {
    const session = liveSession;
    if (!S.live.connected || refreshInFlight === session) return;
    refreshInFlight = session;
    try {
      const writes = layoutWrites;
      const inventory = await readLiveInventory();
      if (!S.live.connected || session !== liveSession) return;
      if (layoutWrites !== writes) LAYOUT_KEYS.forEach(k => { delete inventory[k]; });   // a move / owner change landed meanwhile
      Object.assign(S.live, inventory);
      const pdus = S.live.devices.filter(d => d.kind === 'pdu'), kvms = S.live.devices.filter(d => d.kind === 'kvm');
      // Update inventory immediately; a slow PDU must not delay shelf/SN changes.
      // refresh: keep the detail panel's scroll / an editor that has focus, never move the camera.
      computeModel(); buildItems({ refresh: true });
      await Promise.all([
        ...pdus.map(p => api(`/api/pdus/${p.id}/status`).then(s => { if (session === liveSession) setPduStatus(p.id, s); }).catch(() => {})),
        ...kvms.map(k => api(`/api/kvms/${k.id}/status`).then(s => { if (session === liveSession) S.live.kvm[k.id] = s; }).catch(() => {})),
        refreshPing(session),
      ]);
      if (!S.live.connected || session !== liveSession) return;
      if (Array.isArray(inventory.devices)) S.live.updatedAt = Date.now();   // a complete round: inventory + PDU / KVM states
      computeModel(); buildItems({ refresh: true }); renderLive();
    } finally {
      if (refreshInFlight === session) refreshInFlight = null;
      if (refreshQueued === session) { refreshQueued = null; if (session === liveSession) refreshStatuses().catch(() => {}); }
    }
  }
  // An explicit refresh after a change (e.g. a KVM port mark) must not be swallowed by a poll already in flight:
  // that poll may carry the status from before the change, so one more refresh runs when it ends.
  function refreshSoon() {
    if (refreshInFlight === liveSession) { refreshQueued = liveSession; return; }
    refreshStatuses().catch(() => {});
  }
  // ── power / console safety: act only on mappings that come from live DCIM data, always after an explicit choice
  const livePdu = id => (S.live.connected && id ? (S.live.devices || []).find(d => d.kind === 'pdu' && d.id === id) : null) || null;
  const liveKvm = id => (S.live.connected && id ? (S.live.devices || []).find(d => d.kind === 'kvm' && d.id === id) : null) || null;
  function powerTarget(it) {
    if (!it || it.type !== 'opt' || it.live?.inDcim !== true) return null;
    const pdu = livePdu(it.dcim?.pdu); const outlet = Number(it.dcim?.outlet);
    if (!pdu || !Number.isInteger(outlet) || outlet < 1) return null;
    return { pduId: pdu.id, pduName: pdu.name || pdu.id, outlet, server: it.name || it.id, state: it.live.state, key: it.dcim.optKey || null };
  }
  function kvmTargets(it) {
    if (!it || it.live?.inDcim !== true) return [];
    return (it.dcim?.kvm || []).filter(k => liveKvm(k.kvm) && Number.isInteger(Number(k.port)) && Number(k.port) > 0);
  }
  // Re-resolve against the current live model at click time and again after the dialog.
  function freshPowerTarget(target) {
    if (!target || !S.live.connected) return null;
    if (target.key) {
      const it = (S.model?.items || []).find(i => i.type === 'opt' && i.live?.inDcim && i.dcim?.optKey === target.key);
      const t = powerTarget(it); if (!t) return null;
      return t.pduId === target.pduId && t.outlet === target.outlet ? t : { ...t, changed: true };
    }
    // PDU outlet menu: the outlet must still carry the same server label as when the menu was opened
    const dev = livePdu(target.pduId); if (!dev) return null;
    const o = S.live.pdu?.[dev.id]?.outlets?.find(x => x.number === target.outlet);
    const t = { ...target, pduName: dev.name || target.pduName, state: o ? o.state : target.state };
    return outletLabelKey(dev.id, target.outlet) === target.labelKey ? t : { ...t, changed: true };
  }
  // Which server an outlet is labelled for right now (live reading first, then the stored DCIM label); '' = no server.
  function outletLabelKey(pduId, outlet) {
    const dev = livePdu(pduId); if (!dev) return null;
    const o = S.live.pdu?.[pduId]?.outlets?.find(x => x.number === outlet);
    const label = (o && o.label) || dev.labels?.[String(outlet)] || '';
    return isDefaultOutletLabel(label) ? '' : optKey(label);
  }
  const STATE_TEXT = st => st === 'on' ? 'On' : st === 'off' ? 'Off' : 'Unknown';
  const ACTION_TEXT = { on: 'Power on', off: 'Power off', cycle: 'Power cycle' };
  const ACTION_BTN = { on: 'primary', off: 'danger', cycle: 'danger' };
  // One modal for every risky choice. Cancel has the focus, Escape / backdrop = cancel, Tab stays inside.
  let choiceOpen = null;
  // alert: role=alertdialog (power); footnote: small text under the buttons.
  function askChoice({ title, html, choices, focus = 'cancel', alert = false, footnote = '' }) {
    if (choiceOpen) choiceOpen('cancel');
    const modal = $('#confirmModal'), acts = $('#cfActions'); const opener = document.activeElement;
    const card = $('.modal-card', modal); card.setAttribute('role', alert ? 'alertdialog' : 'dialog'); card.classList.toggle('alert', !!alert);
    $('#cfTitle').textContent = title; $('#cfBody').innerHTML = html;
    const foot = $('#cfFoot'); foot.textContent = footnote || ''; foot.classList.toggle('hidden', !footnote);
    acts.innerHTML = choices.map(c => `<button type="button" class="kbtn md ${c.cls || 'secondary'}" data-choice="${esc(c.id)}">${esc(c.label)}</button>`).join('');
    if (S.pwMenuOpen) closePwMenu(false, true);
    if (popEl) { popEl.remove(); popEl = null; }
    modal.classList.remove('hidden');
    return new Promise(resolve => {
      const buttons = $$('[data-choice]', acts);
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); }
        else if (e.key === 'Tab') { e.preventDefault(); const i = buttons.indexOf(document.activeElement); buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus(); }
        else if (!modal.contains(e.target)) e.stopPropagation();   // view shortcuts wait until the dialog is closed
      };
      function done(choice) {
        if (choiceOpen !== done) return; choiceOpen = null;
        window.removeEventListener('keydown', onKey, true); modal.onclick = null; modal.classList.add('hidden'); acts.innerHTML = '';
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
        resolve(choice);
      }
      choiceOpen = done;
      window.addEventListener('keydown', onKey, true);
      modal.onclick = e => { if (e.target === modal) done('cancel'); };
      buttons.forEach(b => { b.onclick = () => done(b.dataset.choice); });
      (buttons.find(b => b.dataset.choice === focus) || buttons[0]).focus();
    });
  }
  // What the power dialog shows besides the outlet: where the server is, how many feeds power it, who uses its console.
  function powerFacts(t) {
    const it = (S.model?.items || []).find(i => i.type === 'opt' && i.live?.inDcim && (t.key ? i.dcim?.optKey === t.key : t.labelKey && optKey(i.name) === t.labelKey)) || null;
    const o = S.live.pdu?.[t.pduId]?.outlets?.find(x => x.number === t.outlet);
    const rec = it ? S.recs.get(it.id) : null; const feeds = it ? feedsOf(it.name).length : 0;
    const kv = it ? kvmTargets(it) : [];
    const consoleTxt = !kv.length ? 'No KVM port mapped' : kv.some(k => kvmPort(k.kvm, Number(k.port))?.in_use) ? 'In use · someone may be working on it' : 'Free · nobody is using it';
    return { watts: o?.watts ?? it?.live?.watts ?? null, where: rec ? placeLabel(rec) : '', feeds: Math.max(1, feeds), console: consoleTxt };
  }
  async function outletAction(target, action, btn) {
    if (!window.DCIM_CAN_OPERATE) { toast('Viewer account: read only', 'err'); return false; }
    if (!S.live.connected) { toast('Connect the backend first', 'err'); return false; }
    if (!ACTION_TEXT[action]) return false;
    let t = freshPowerTarget(target);
    if (!t) { toast('Not in live DCIM — power disabled', 'err'); return false; }
    if (t.changed) { toast('The outlet mapping changed in Lab Manager — check the panel and try again', 'err'); computeModel(); buildItems({ refresh: true }); return false; }
    if (action !== 'off' && inMaintenance(t.pduId)) { toast('This PDU is in maintenance mode — restore it in Lab Manager first', 'err'); return false; }
    // Off and Cycle always ask. The account preference confirm_power=false may skip the question for Power on only —
    // a deliberate team-lead decision (2026-10-21): switching a server on cannot interrupt work running on it.
    if (!(action === 'on' && window.DCIM_ACCOUNT_PREFS?.confirm_power === false)) {
      const f = powerFacts(t);
      const consequence = action === 'on' ? 'It powers on.' : action === 'off' ? 'It loses power immediately; unsaved work on it is lost.' : 'It turns off, then on again after a few seconds; unsaved work on it is lost.';
      const row = (k, v, cls = '') => `<div class="cf-fact${cls ? ' ' + cls : ''}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
      const choice = await askChoice({
        title: `${ACTION_TEXT[action]} ${t.server}?`, alert: true,
        html: `<p class="cf-line">${esc(t.pduName)} · outlet ${esc(t.outlet)} · currently ${esc(STATE_TEXT(t.state))}${f.watts != null && t.state === 'on' ? ` (${Math.round(f.watts)} W)` : ''}. ${esc(consequence)}</p>
          <div class="cf-facts">${row('Server', f.where ? `${t.server} · ${f.where}` : t.server)}${row('Feeds switched', `1 of ${f.feeds}`)}${f.feeds > 1 && action !== 'on' ? row('', 'Other feeds stay on — the server may keep running', 'warn') : ''}${row('Console', f.console)}</div>`,
        choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: `${ACTION_TEXT[action]} ${t.server}`, cls: ACTION_BTN[action] }],
        footnote: 'Cancel has the focus. Escape closes without changing anything.',
      });
      if (choice !== 'go') return false;
      const again = freshPowerTarget(target);   // a refresh may have changed the mapping while the dialog was open
      if (!again || again.changed) { toast('The outlet mapping changed while the dialog was open — nothing was switched', 'err'); return false; }
      if (action !== 'off' && inMaintenance(again.pduId)) { toast('This PDU is in maintenance mode — restore it in Lab Manager first', 'err'); return false; }
      t = again;
    }
    const old = btn ? btn.innerHTML : null; if (btn) { btn.disabled = true; btn.innerHTML = `<span class="busy"></span> ${ACTION_TEXT[action]}…`; }
    try {
      await api(`/api/pdus/${encodeURIComponent(t.pduId)}/outlets/${t.outlet}/power`, { method: 'POST', body: JSON.stringify({ action }) });
      toast(`${t.server} · outlet #${t.outlet} → ${action}`, 'ok');
      setTimeout(async () => { try { setPduStatus(t.pduId, await api(`/api/pdus/${encodeURIComponent(t.pduId)}/status`)); computeModel(); buildItems({ refresh: true }); } catch { /* ignore */ } }, 1500);
      return true;
    } catch (e) { toast('Power action failed: ' + e.message, 'err'); return false; }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
  }
  // KVM console: like the Lab Manager UI — window.open inside the click; if the browser refuses a new tab the console
  // opens inline. A port that is already in use asks first (advisory: someone else may be working on that server).
  // Every console gets its own lease from mark-in-use and frees only that lease when its tab / inline console closes,
  // so closing one console never clears another person's IN USE marker. A failed mark-in-use frees nothing.
  let inlineConsole = null;
  const kvmPort = (kvmId, port) => S.live.kvm?.[kvmId]?.ports?.find(p => p.number === port) || null;
  // Show the server's answer at once (the status refresh that follows confirms it).
  function setKvmPortInUse(kvmId, port, inUse) {
    const p = kvmPort(kvmId, port); if (!p || !!p.in_use === inUse) return;
    p.in_use = inUse; computeModel(); buildItems({ refresh: true });
  }
  async function openKvm(kvmId, port, label) {
    if (!window.DCIM_CAN_OPERATE) { toast('Viewer account: read only', 'err'); return; }
    let dev = liveKvm(kvmId);
    if (!dev || !Number.isInteger(port) || port < 1) { toast('Not in live DCIM — console disabled', 'err'); return; }
    const named = label && !isDefaultOutletLabel(label) ? label : '';
    if (kvmPort(kvmId, port)?.in_use) {
      const choice = await askChoice({
        title: 'Port already in use',
        html: `<div class="cf-line">${esc(dev.name || kvmId)} · Port ${esc(port)}${named ? ' · ' + esc(named) : ''}</div><div class="note">Someone else is probably working on this server through the KVM. Opening it again shows you both the same screen, and you both control the same keyboard and mouse.</div>`,
        choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: 'Open anyway', cls: 'primary' }],
      });
      if (choice !== 'go') return;
      if (!window.DCIM_CAN_OPERATE) { toast('Viewer account: read only', 'err'); return; }
      dev = liveKvm(kvmId);   // the backend may have disconnected while the dialog was open
      if (!dev) { toast('Not in live DCIM — console disabled', 'err'); return; }
    }
    const base = (S.settings.url || '').replace(/\/$/, ''); const path = `/api/kvms/${encodeURIComponent(kvmId)}`;
    const url = `${base}${path}/autologin?port=${encodeURIComponent(port)}`;
    let popup = null; try { popup = window.open(url, '_blank'); } catch { popup = null; }
    // lease: this console's own marker; '' = an older server without leases (mark-free then has no body);
    // null = marking failed, so there is nothing of ours to free
    const lease = api(`${path}/ports/${port}/mark-in-use`, { method: 'POST' }).then(r => {
      try { setKvmPortInUse(kvmId, port, true); } catch { /* display only: the lease must still be freed */ }
      refreshSoon();   // KVM-4: confirm IN USE now, not at the next poll
      return typeof r?.lease === 'string' ? r.lease : '';
    }, () => { toast('The console opened, but marking the port as in use failed — check that you are still signed in', 'err'); return null; });
    // mark-free waits for mark-in-use, so a fast close can never leave the port stuck "in use"; sent at most once
    let freeing = null;
    const markFree = init => freeing || (freeing = lease.then(l => {
      if (l === null) return;
      return api(`${path}/ports/${port}/mark-free`, { method: 'POST', ...(l ? { body: JSON.stringify({ lease: l }) } : {}), ...(init || {}) })
        .then(r => r, () => null).then(r => {
          if (init) return;   // pagehide: the page is going away
          // sessions = consoles still open on this port (an older server without leases frees the whole port)
          try { if (r) setKvmPortInUse(kvmId, port, typeof r.sessions === 'number' ? r.sessions > 0 : false); } catch { /* display only */ }
          refreshSoon();
        });
    }));
    if (popup) {
      const t = setInterval(() => { if (popup.closed) { clearInterval(t); markFree(); } }, 2000);
      toast(`Opening KVM console · ${dev.name || kvmId} port ${port}`, 'ok'); return;
    }
    openInlineConsole({ title: `${dev.name || kvmId} · Port ${port}${named ? ' · ' + named : ''}`, url, markFree });
    toast('The browser blocked a new tab — the console opened inside the twin', 'err');
  }
  function openInlineConsole({ title, url, markFree }) {
    closeInlineConsole();
    inlineConsole = { markFree, opener: document.activeElement };
    $('#kvmInlineTitle').textContent = title; $('#kvmInlineFrame').src = url;
    $('#kvmInline').classList.remove('hidden'); $('#kvmInlineClose').focus();
  }
  function closeInlineConsole(init) {
    if (!inlineConsole) return; const c = inlineConsole; inlineConsole = null;
    $('#kvmInline').classList.add('hidden'); $('#kvmInlineFrame').src = 'about:blank';
    c.markFree(init);
    if (c.opener && c.opener.isConnected && typeof c.opener.focus === 'function') c.opener.focus({ preventScroll: true });
  }
  $('#kvmInlineClose').onclick = () => closeInlineConsole();
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && inlineConsole && !choiceOpen) { e.preventDefault(); e.stopPropagation(); closeInlineConsole(); } }, true);
  window.addEventListener('pagehide', () => { if (inlineConsole) closeInlineConsole({ keepalive: true }); });
  let popEl = null;
  function outletMenu(e, pduItem, outlet) {
    if (popEl) { popEl.remove(); popEl = null; }
    if (!window.DCIM_CAN_OPERATE) { toast('Viewer account: read only', 'err'); return; }
    if (!S.live.connected) { toast('Connect the backend to control outlets', 'err'); return; }
    const dev = pduItem.live?.device ? livePdu(pduItem.live.device.id) : null;
    if (!dev) { toast('Not in live DCIM — power disabled', 'err'); return; }
    if (pduItem.live?.status?.reachable === false) { toast('PDU is unreachable: outlet state unknown, power actions unavailable', 'err'); return; }
    const r = e.currentTarget.getBoundingClientRect(); popEl = document.createElement('div'); popEl.className = 'pop';
    const o = pduItem.live?.status?.outlets?.find(x => x.number === outlet);
    const lbl = o?.label || dev.labels?.[String(outlet)] || `Outlet ${outlet}`;
    // labelKey = the server this outlet is for now; checked again after the confirmation (a refresh may remap it)
    const target = { pduId: dev.id, pduName: dev.name || pduItem.name, outlet, server: isDefaultOutletLabel(lbl) ? `outlet ${outlet}` : lbl.trim(), state: o?.state, labelKey: outletLabelKey(dev.id, outlet) };
    const maint = inMaintenance(dev.id) ? ' disabled title="PDU in maintenance mode"' : '';
    popEl.innerHTML = `<div class="pt">${esc(pduItem.name)} · #${outlet} · ${esc(lbl)}${maint ? ' · maintenance' : ''}</div><button class="btn btn-on" data-a="on"${maint}>Power On</button><button class="btn btn-off" data-a="off">Power Off</button><button class="btn btn-cycle" data-a="cycle"${maint}>Power Cycle</button>`;
    const openUp = r.bottom > window.innerHeight / 2; popEl.style.left = Math.min(Math.max(r.left + r.width / 2 - 100, 8), window.innerWidth - 210) + 'px'; popEl.style.top = (openUp ? r.top - 130 : r.bottom + 4) + 'px';
    document.body.appendChild(popEl);
    $$('button', popEl).forEach(b => b.onclick = () => { if (popEl) { popEl.remove(); popEl = null; } outletAction(target, b.dataset.a, null); });
    setTimeout(() => document.addEventListener('click', function h(ev) { if (popEl && !popEl.contains(ev.target)) { popEl.remove(); popEl = null; } document.removeEventListener('click', h); }), 0);
  }

  // settings modal
  $('#btnSettings').onclick = () => { $('#sUrl').value = S.settings.url || ''; $('#sPass').value = S.settings.pass || ''; $('#sPoll').checked = S.settings.poll !== false; $('#settings').classList.remove('hidden'); $('#sUrl').focus(); };
  $('#sClose').onclick = () => $('#settings').classList.add('hidden');
  $('#sConnect').onclick = () => { S.settings = { url: $('#sUrl').value.trim(), pass: $('#sPass').value, poll: $('#sPoll').checked }; LS.set('settings', S.settings); connect(); };
  $('#sDisconnect').onclick = () => { disconnect(); };
  $('#livePill').onclick = () => $('#btnSettings').click();

  // export
  $('#btnExport').onclick = downloadJson;
  $('#sbSave').onclick = saveToServer; $('#sbDownload').onclick = downloadJson;
  $('#sbDiscard').onclick = () => { if (confirm('Discard all unsaved edits and reload the saved lab-data.json?')) { LS.set('draft', null); location.reload(); } };
  $('#btnPlan').onclick = () => window.open('floorplan.svg', '_blank');

  // Keep the focus near the lab by translating camera and target together.
  // The old camera box shortened the viewing radius every frame and caused jumps.
  const previousCamera = new THREE.Vector3(), previousTarget = new THREE.Vector3();
  const collisionRay = new THREE.Raycaster();
  function constrainNavigation(collisions = true) {
    if (!S.data) return;
    const { width: W, depth: D, height: H } = S.data.room;
    const bounded = controls.target.clone().clamp(new THREE.Vector3(-W - 0.5, 0, -0.5), new THREE.Vector3(0.5, H, D + 0.5));
    camera.position.add(bounded.clone().sub(controls.target)); controls.target.copy(bounded);
    if (camera.position.y < 0.3) { const rise = 0.3 - camera.position.y; camera.position.y += rise; controls.target.y += rise; }
    if (collisions) {
      const delta = camera.position.clone().sub(previousCamera), distance = delta.length();
      if (distance > 1e-6) {
        const solids = S.pickables.filter(m => isShown(m) && ['item', 'setup', 'shelf', 'storage'].includes(S.recs.get(m.userData.id)?.cat));
        collisionRay.set(previousCamera, delta.normalize()); collisionRay.far = distance + 0.18;
        const hit = collisionRay.intersectObjects(solids, false)[0];
        if (hit && hit.distance < distance + 0.18) {
          const fraction = Math.max(0, Math.min(1, (hit.distance - 0.18) / distance));
          camera.position.lerpVectors(previousCamera, camera.position.clone(), fraction);
          controls.target.lerpVectors(previousTarget, controls.target.clone(), fraction);
        }
      }
    }
    camera.lookAt(controls.target);
    previousCamera.copy(camera.position); previousTarget.copy(controls.target);
  }
  // pan the whole view (camera + target together) along the floor, relative to where you look
  function panBy(dx, dz) {
    markView(null);
    const fwd = controls.target.clone().sub(camera.position); fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const step = Math.max(0.35, camera.position.distanceTo(controls.target) * 0.25);
    const d = right.multiplyScalar(dx * step).add(fwd.multiplyScalar(dz * step));
    tweenCamera(camera.position.clone().add(d), controls.target.clone().add(d), 250);
  }

  // ───────────────────────────────────────────────────────────── camera views
  function roomCenter() { const { width: W, depth: D, height: H } = S.data.room; return new THREE.Vector3(WX(W / 2), H * 0.35, D / 2); }
  function tweenCamera(pos, target, ms = 700) {
    controls.cancel();
    // reduced motion: a zero-length tween jumps in one frame (collision sweep is skipped for that frame, like any tween)
    S.tween = { t0: performance.now(), ms: reducedMotion() ? 0 : ms, p0: camera.position.clone(), p1: pos.clone(), t0v: controls.target.clone(), t1v: target.clone() };
  }
  function fitLab(top = false) {
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(world);
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const vertical = THREE.MathUtils.degToRad(camera.fov), horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    // the free part of the view (the phone sheet covers its lower third): fit the room's sphere into that rectangle
    const safe = safeArea(1.2, ['#sheet']); const fw = Math.max(0.35, (safe.r - safe.l) / 2), fh = Math.max(0.35, (safe.t - safe.b) / 2);
    const half = Math.atan(Math.min(Math.tan(vertical / 2) * fh, Math.tan(horizontal / 2) * fw));
    const distance = Math.min(controls.maxDistance * 0.9, sphere.radius / Math.sin(half) * 1.12);
    const target = roomCenter();
    const direction = (top ? new THREE.Vector3(0, 1, -0.04) : new THREE.Vector3(0.45, 0.95, -1)).normalize();
    const P = target.clone().addScaledVector(direction, distance);
    fitCam.fov = camera.fov; fitCam.aspect = camera.aspect; fitCam.near = camera.near; fitCam.far = camera.far; fitCam.up.set(0, 1, 0); fitCam.updateProjectionMatrix();
    let T = target; try { T = framing(P, target, bounds, safe).T; } catch { /* keep the room centre */ }
    tweenCamera(P, T);
  }
  const VIEWS = {
    orbit() { fitLab(); },
    top() { fitLab(true); },
    eye() { const { width: W, depth: D } = S.data.room; tweenCamera(new THREE.Vector3(WX(W / 2), 1.65, 0.35), new THREE.Vector3(WX(W / 2), 1.35, D * 0.7)); },
    front() { showRackFront(pickFrontRack()); },   // a 2D view of one rack over the (unmoved) 3D camera
  };
  // Only the preset the camera is actually in is checked; focus / orbit / zoom / pan leave every preset.
  const VIEW_BTN = { orbit: '#vOrbit', front: '#vFront', eye: '#vEye', top: '#vTop' };
  function markView(name) {
    S.view = S.front ? 'front' : name !== 'front' && VIEW_BTN[name] ? name : null;
    Object.entries(VIEW_BTN).forEach(([k, q]) => { const b = $(q); const on = k === S.view; b.classList.toggle('on', on); b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on || (!S.view && k === 'orbit') ? 0 : -1; });
    const vm = $('#btnViewMenu'); if (vm) vm.textContent = `${VIEW_LABEL[S.view] || 'View'} ▾`;
    renderCrumb();
  }
  function setView(name) { if (name !== 'front') hideRackFront(); VIEWS[name](); markView(name); }
  controls.addEventListener('start', () => markView(null));
  // ── fly-to framing
  // Frame the target's bounding box inside the part of the viewport no overlay covers, from a camera position in free
  // space: inside the room, outside the target's own rack and in front of every other rack, cabinet or free item.
  // Candidate directions fan out from the rack front (or towards the room centre); the best one that fits wins, otherwise
  // the one that shows the largest part of the target from as far back as the free space allows.
  const fitCam = new THREE.PerspectiveCamera();
  function visibleBox(obj, box = new THREE.Box3()) {
    obj.updateMatrixWorld(true);
    obj.traverseVisible(o => { if ((o.isMesh || o.isLine) && o.geometry) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    return box;
  }
  function meshesBox(meshes, box = new THREE.Box3()) {
    meshes.forEach(m => { m.updateMatrixWorld(true); if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); });
    return box;
  }
  // Boxes to frame, best first. A rack is tried whole (with its label), then just its shelves.
  function frameBoxes(rec) {
    if (rec.cat === 'setup') {
      const full = visibleBox(rec.group); full.max.y = Math.max(full.max.y, (rec.tpl?.height || 2.2) + 0.2);
      const levels = recsOf(r => r.cat === 'shelf' && r.setup === rec.id).map(r => r.y);
      const shelves = full.clone(); if (levels.length) shelves.min.y = Math.max(full.min.y, Math.min(...levels) - 0.15);
      return [full, shelves];
    }
    if (rec.cat === 'storage') return [visibleBox(rec.group)];
    const b = meshesBox(rec.cat === 'shelf' && rec.slot ? [...rec.meshes, rec.slot] : rec.meshes);
    if (rec.cat === 'shelf') recsOf(r => r.cat === 'item' && r.shelf === rec.id).forEach(r => meshesBox(r.meshes, b));
    if (rec.cat === 'item' || rec.cat === 'structure') {   // keep some context around small objects
      const c = b.getCenter(new THREE.Vector3()); b.setFromCenterAndSize(c, b.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.7, 0.5, 0.7)));
    }
    return [b];
  }
  // [entry, exit] distances of a ray through an axis-aligned box, or null
  function slab(o, d, box) {
    let t0 = -Infinity, t1 = Infinity;
    for (const k of ['x', 'y', 'z']) {
      if (Math.abs(d[k]) < 1e-9) { if (o[k] < box.min[k] || o[k] > box.max[k]) return null; continue; }
      let a = (box.min[k] - o[k]) / d[k], b = (box.max[k] - o[k]) / d[k]; if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return null;
    }
    return [t0, t1];
  }
  function obstacleBoxes(rec) {
    const skip = new Set([rec.id, rec.setup, rec.item?.storage].filter(Boolean)); const out = [];
    for (const r of S.recs.values()) {
      if (skip.has(r.id) || !r.group) continue;
      // clearance: the camera never hovers in the narrow gap above a rack or cabinet; above a cart or ladder is fine
      if (r.cat === 'setup' || r.cat === 'storage') out.push(Object.assign(visibleBox(r.group), { clearance: 0.45 }));
      else if (r.cat === 'item' && r.group.parent === itemsGroup && r.meshes.length) out.push(Object.assign(meshesBox(r.meshes), { clearance: 0.1 }));
      else if (r.cat === 'structure' && r.def?.radius != null) out.push(Object.assign(meshesBox(r.meshes), { clearance: 0.45 }));   // pillar
    }
    return out;
  }
  // Share of the target the camera at P actually sees: its centre plus the corners and middle of the face that matters
  // (a rack's front, else the side facing the room), each sight line tested against other racks / cabinets / free items.
  function visibleShare(P, box, C, blockers, face) {
    const onX = Math.abs(face.x) >= Math.abs(face.z); const k = onX ? (face.x > 0 ? box.max.x : box.min.x) : (face.z > 0 ? box.max.z : box.min.z);
    const samples = [C, onX ? new THREE.Vector3(k, C.y, C.z) : new THREE.Vector3(C.x, C.y, k)];
    // corners pulled 10 % inwards: an edge shared with the neighbouring rack is not "hidden" by it
    const lerp = (a, b, f) => a + (b - a) * f; const ws = onX ? [box.min.z, box.max.z] : [box.min.x, box.max.x];
    for (const y of [lerp(box.min.y, box.max.y, 0.1), lerp(box.min.y, box.max.y, 0.9)]) for (const w of [lerp(ws[0], ws[1], 0.1), lerp(ws[0], ws[1], 0.9)]) samples.push(onX ? new THREE.Vector3(k, y, w) : new THREE.Vector3(w, y, k));
    let seen = 0;
    for (const q of samples) {
      const d = q.clone().sub(P); const len = d.length(); d.divideScalar(len || 1);
      // a sample inside another box (side-mounted gear makes neighbouring boxes overlap) is not hidden by it
      const hitBy = blockers.find(b => { if (b.containsPoint(P) || b.containsPoint(q)) return false; const s = slab(P, d, b); return s && s[0] > 0.02 && s[0] < len - 0.05; });
      if (!hitBy) seen++;
    }
    return seen / samples.length;
  }
  function roomInnerBox() {
    const { width: W, depth: D, height: H } = S.data.room;
    return new THREE.Box3(new THREE.Vector3(WX(W) + 0.15, 0.35, 0.15), new THREE.Vector3(WX(0) - 0.15, H - 0.1, D - 0.15));
  }
  // Part of the canvas that no overlay covers, in NDC. Each overlay trims the side that leaves the most room for a target
  // of the given on-screen aspect (width / height): a tall rack keeps a tall area, a flat zone a wide one.
  function safeArea(aspect = 1, only = null) {
    const vp = canvas.getBoundingClientRect(); const W = vp.width, H = vp.height; if (!W || !H) return { l: -1, r: 1, t: 1, b: -1 };
    const area = q => Math.max(0, q.r - q.l) * Math.max(0, q.b - q.t);
    const rects = (only || ['#crumb', '#attnDock', '#saveBar', '#moveBanner', '#envPanel', '.zoombar', '#legend', '#layersPanel', '#sheet'])
      .map(q => $(q)).filter(Boolean).map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0)
      .map(r => ({ l: r.left - vp.left - 6, t: r.top - vp.top - 6, r: r.right - vp.left + 6, b: r.bottom - vp.top + 6 }))
      .sort((a, b) => area(b) - area(a));
    let s = { l: 0, t: 0, r: W, b: H };
    for (const o of rects) {
      if (o.r <= s.l || o.l >= s.r || o.b <= s.t || o.t >= s.b) continue;
      const use = q => Math.min(Math.max(0, q.r - q.l) / aspect, Math.max(0, q.b - q.t));
      s = [{ ...s, t: Math.max(s.t, o.b) }, { ...s, b: Math.min(s.b, o.t) }, { ...s, l: Math.max(s.l, o.r) }, { ...s, r: Math.min(s.r, o.l) }]
        .reduce((a, q) => use(q) > use(a) + 0.5 || (Math.abs(use(q) - use(a)) <= 0.5 && area(q) > area(a)) ? q : a);
    }
    if (s.r - s.l < W * 0.3 || s.b - s.t < H * 0.3) s = { l: 0, t: 0, r: W, b: H };   // overlays cover too much: use the whole view
    return { l: s.l / W * 2 - 1, r: s.r / W * 2 - 1, t: 1 - s.t / H * 2, b: 1 - s.b / H * 2 };
  }
  // Camera at P: where to look so the box centre C sits in the middle of the safe area, and is the whole box inside it?
  function framing(P, C, box, safe) {
    fitCam.position.copy(P); fitCam.lookAt(C); fitCam.updateMatrixWorld(true);
    const dist = P.distanceTo(C), halfH = dist * Math.tan(THREE.MathUtils.degToRad(fitCam.fov / 2)), halfW = halfH * fitCam.aspect;
    const sx = (safe.l + safe.r) / 2, sy = (safe.t + safe.b) / 2;
    const T = C.clone().sub(new THREE.Vector3().setFromMatrixColumn(fitCam.matrixWorld, 0).multiplyScalar(sx * halfW)).sub(new THREE.Vector3().setFromMatrixColumn(fitCam.matrixWorld, 1).multiplyScalar(sy * halfH));
    fitCam.lookAt(T); fitCam.updateMatrixWorld(true);
    const m = 0.04; let ok = true;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(fitCam.matrixWorldInverse);
      if (v.z > -fitCam.near * 2) { ok = false; break; }
      v.applyMatrix4(fitCam.projectionMatrix);
      if (v.x < safe.l + m || v.x > safe.r - m || v.y < safe.b + m || v.y > safe.t - m) { ok = false; break; }
    }
    return { ok, T };
  }
  function planFlight(rec) {
    scene.updateMatrixWorld(true);
    fitCam.fov = camera.fov; fitCam.aspect = camera.aspect; fitCam.near = camera.near; fitCam.far = camera.far; fitCam.up.set(0, 1, 0); fitCam.updateProjectionMatrix();
    const boxes = frameBoxes(rec).filter(b => !b.isEmpty()); if (!boxes.length) return null;
    const sz0 = boxes[0].getSize(new THREE.Vector3()); const safe = safeArea(Math.max(0.2, Math.min(5, Math.max(sz0.x, sz0.z) / Math.max(0.05, sz0.y)))); const zone = rec.cat === 'zone';
    const own = rec.setup && S.recs.get(rec.setup)?.group ? visibleBox(S.recs.get(rec.setup).group)
      : rec.item?.storage && S.recs.get(rec.item.storage)?.group ? visibleBox(S.recs.get(rec.item.storage).group) : boxes[0].clone();
    own.expandByScalar(0.12);
    // camera clearance: never inside, nor in the gap just above, another rack / cabinet / free item
    const blockers = zone ? [] : obstacleBoxes(rec); const room = zone ? null : roomInnerBox();
    const obstacles = blockers.map(b => { const e = b.clone().expandByScalar(0.06); e.max.y += b.clearance; return e; });
    const C0 = boxes[0].getCenter(new THREE.Vector3());
    // base approach: rack front, else from the object towards the room centre, else the current view direction
    const su = S.recs.get(rec.cat === 'setup' ? rec.id : rec.setup);
    let base = su?.group && su.cat === 'setup' ? new THREE.Vector3(1, 0, 0).transformDirection(su.group.matrixWorld) : null;
    if (!base && !zone) base = roomCenter().sub(C0);
    if (!base || zone) base = camera.position.clone().sub(controls.target);
    base.y = 0; if (base.lengthSq() < 1e-6) base.set(0, 0, -1); base.normalize();
    const yaws = [0, 10, -10, 20, -20, 30, -30, 40, -40, 50, -50, 65, -65, 80, -80];
    const elevs = zone ? [50, 62, 75] : rec.cat === 'setup' ? [12, 20, 30, 42] : [15, 25, 35, 50, 65];
    const prefElev = zone ? 62 : 20; const maxD = controls.maxDistance * 0.9;
    let best = null;
    boxes.forEach((box, bi) => {
      const C = box.getCenter(new THREE.Vector3());
      for (const yaw of yaws) for (const elev of elevs) {
        const h = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yaw));
        const dir = h.multiplyScalar(Math.cos(THREE.MathUtils.degToRad(elev))).setY(Math.sin(THREE.MathUtils.degToRad(elev))).normalize();
        // the camera must be outside the target (or its rack) …
        const ownExit = slab(C, dir, own); let dmin = Math.max(controls.minDistance + 0.05, ownExit ? ownExit[1] : 0);
        // … and in front of the first obstacle / inside the room
        let free = maxD;
        if (room) { const s = slab(C, dir, room); free = Math.min(free, s && s[1] > 0 ? s[1] : 0); }
        for (const ob of obstacles) { const s = slab(C, dir, ob); if (s && s[0] > 0) free = Math.min(free, s[0] - 0.1); }
        if (free < dmin) continue;
        const fitsAt = d => framing(C.clone().addScaledVector(dir, d), C, box, safe).ok;
        let need = Infinity;
        if (fitsAt(free)) {
          let lo = dmin, hi = free; if (fitsAt(lo)) hi = lo; else for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (fitsAt(mid)) hi = mid; else lo = mid; }
          need = hi;
        } else if (fitsAt(maxD)) {
          let lo = free, hi = maxD; for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (fitsAt(mid)) hi = mid; else lo = mid; }
          need = hi;
        }
        const fits = need <= free + 1e-6; const coverage = fits ? 1 : Number.isFinite(need) ? free / need : 0;
        const d = fits ? need : free; const seen = blockers.length ? visibleShare(C.clone().addScaledVector(dir, d), box, C, blockers, base) : 1;
        const score = (fits && seen === 1 ? 3 - bi : coverage * seen * seen) - 0.3 * Math.abs(yaw) / 90 - 0.12 * Math.abs(elev - prefElev) / 60;
        if (!best || score > best.score) best = { score, d, dir, C, box, fits, yaw, elev, bi, coverage, seen };
      }
    });
    if (!best) return null;
    const P = best.C.clone().addScaledVector(best.dir, best.d);
    return { P, T: framing(P, best.C, best.box, safe).T, fits: best.fits, yaw: best.yaw, elev: best.elev, box: best.bi, coverage: +best.coverage.toFixed(2), seen: best.seen, safe };
  }
  function flyTo(rec, force) {
    if (!rec.group || !S.data) return;
    markView(null);
    let plan = null;
    try { plan = planFlight(rec); } catch (e) { console.warn('fly-to framing failed', e); }   // the camera still moves (fallback below)
    if (plan) { tweenCamera(plan.P, plan.T, force ? 500 : 800); return; }
    // nothing free around the target (should not happen inside the room): look from the current side, close in
    const b = meshesBox(rec.meshes); if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()); const dir = camera.position.clone().sub(c).setY(0).normalize().setY(0.5).normalize();
    tweenCamera(c.clone().addScaledVector(dir, Math.max(1.2, b.getSize(new THREE.Vector3()).length() * 1.2)), c, force ? 500 : 800);
  }
  $('#vOrbit').onclick = () => setView('orbit'); $('#vTop').onclick = () => setView('top'); $('#vEye').onclick = () => setView('eye'); $('#vFront').onclick = () => setView('front');
  // camera view radio group: arrows move and choose (one tab stop)
  $('#viewSeg').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault();
    const radios = $$('[role="radio"]', $('#viewSeg')); const i = Math.max(0, radios.indexOf(document.activeElement));
    const next = radios[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + radios.length) % radios.length]; next.click(); next.focus();
  });
  $('#vReset').onclick = () => { cancelMove(); closeDetail(); hideRackFront(); setView('orbit'); };
  $('#vFit').onclick = () => { hideRackFront(); setView('orbit'); };
  $('#vFocus').onclick = () => { const rec = S.recs.get(S.selected); if (!rec) return; hideRackFront(); flyTo(rec, true); };
  $('#vBack').onclick = () => leaveFront();
  $('#btnHome').onclick = () => { hideRackFront(); setView('orbit'); };
  // ── scene layers (Layers popover): highlighted / pressed = shown
  const setPressed = (el, on) => { if (!el) return; el.classList.toggle('active', !!on); el.setAttribute('aria-pressed', String(!!on)); };
  $('#tWalls').onclick = () => { S.wallsVisible = !S.wallsVisible; wallsGroup.visible = S.wallsVisible; setPressed($('#tWalls'), S.wallsVisible); };
  $('#tZones').onclick = () => { S.zonesVisible = !S.zonesVisible; zonesGroup.visible = S.zonesVisible; setPressed($('#tZones'), S.zonesVisible); };
  function setLabelMode(mode, silent) { S.labelMode = mode; $('#tLabels').textContent = 'Labels: ' + { setups: 'racks', all: 'all', none: 'off' }[mode]; setPressed($('#tLabels'), mode !== 'none'); if (!silent) LS.set('labelMode', mode); }
  $('#tLabels').onclick = () => setLabelMode({ setups: 'all', all: 'none', none: 'setups' }[S.labelMode]);
  $('#tPower').onclick = () => { S.showPower = !S.showPower; LS.set('showPower', S.showPower); applyLook(); };
  $('#tEnv').onclick = () => { S.envPanel = !S.envPanel; LS.set('envPanel', S.envPanel); applyLook(); updateTelemetry(); placeAttnDock(); };
  // body classes and pressed states that follow the settings above
  function applyLook() {
    const b = document.body; b.classList.toggle('show-power', S.showPower); b.classList.toggle('color-status', S.colorBy === 'status');
    setPressed($('#tWalls'), S.wallsVisible); setPressed($('#tZones'), S.zonesVisible); setPressed($('#tHeat'), S.heat); setPressed($('#tPower'), S.showPower); setPressed($('#tEnv'), S.envPanel);
    $('#btnColorBy').textContent = `Color by: ${S.colorBy === 'health' ? 'Health' : 'Lifecycle'}`;
    $$('#colorMenu [data-color]').forEach(m => m.setAttribute('aria-checked', String(m.dataset.color === S.colorBy)));
    const mc = $('#mColor'); if (mc) mc.textContent = S.colorBy === 'health' ? 'Color by lifecycle status' : 'Color by health';
  }
  function setColorBy(mode) {
    S.colorBy = mode === 'status' ? 'status' : 'health'; LS.set('colorBy', S.colorBy); applyLook();
    if (S.model) buildItems({ refresh: true });   // repaints items, racks, labels, legend, rack bar, tree and the rack front
  }
  $$('#colorMenu [data-color]').forEach(m => m.onclick = () => { setColorBy(m.dataset.color); closePopup(true); });
  // ── header popovers and menus (non-modal: Escape or a click outside closes them; focus returns to their button)
  let openPop = null;
  const visibleEl = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  function placePopup(el, anchor) {
    el.style.left = el.style.right = el.style.top = '';
    const hdr = $('.hdr').getBoundingClientRect();
    if (isPhone()) { el.style.left = '8px'; el.style.right = '8px'; el.style.top = Math.round(hdr.bottom + 4) + 'px'; return; }
    const r = anchor.getBoundingClientRect(); const w = el.offsetWidth;
    const left = r.left + w > innerWidth - 8 ? Math.max(8, r.right - w) : r.left;
    el.style.left = Math.round(left) + 'px'; el.style.top = Math.round(r.bottom + 6) + 'px';
  }
  function openPopup(el, opener, anchor = opener) {
    closePopup(false); if (S.pwMenuOpen) closePwMenu(false);
    el.classList.remove('hidden'); placePopup(el, visibleEl(anchor) ? anchor : $('#btnMore'));
    opener.setAttribute('aria-expanded', 'true'); openPop = { el, opener };
    const items = $$('[role^="menuitem"]:not([disabled])', el).filter(visibleEl);
    const first = el.getAttribute('role') === 'menu' ? items.find(m => m.getAttribute('aria-checked') === 'true') || items[0] : $$('button, select, input', el).find(visibleEl);
    if (first) first.focus({ preventScroll: true });
  }
  function closePopup(refocus = true) {
    if (!openPop) return; const { el, opener } = openPop; openPop = null;
    el.classList.add('hidden'); opener.setAttribute('aria-expanded', 'false');
    if (refocus) (visibleEl(opener) ? opener : $('#btnMore')).focus({ preventScroll: true });
  }
  const togglePopup = (el, opener) => { if (openPop && openPop.el === el) closePopup(); else openPopup(el, opener); };
  $('#btnLayers').onclick = () => togglePopup($('#layersPanel'), $('#btnLayers'));
  $('#btnColorBy').onclick = () => togglePopup($('#colorMenu'), $('#btnColorBy'));
  $('#btnMore').onclick = () => togglePopup($('#moreMenu'), $('#btnMore'));
  $('#btnViewMenu').onclick = () => togglePopup($('#viewMenu'), $('#btnViewMenu'));
  ['#colorMenu', '#moreMenu', '#viewMenu'].forEach(q => menuKeys($(q), r => closePopup(r)));
  $('#layersPanel').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopup(true); } });
  // menu items: data-proxy = the same action as a control that is hidden at this width (one id per control)
  $$('#moreMenu [role^="menuitem"], #viewMenu [role^="menuitem"]').forEach(m => m.addEventListener('click', () => {
    const proxy = m.dataset.proxy; closePopup(proxy !== 'btnLayers' && m.id !== 'btnSettings' && m.id !== 'btnHelp');
    if (proxy) $('#' + proxy)?.click();
  }));
  $('#mColor').onclick = () => setColorBy(S.colorBy === 'health' ? 'status' : 'health');
  document.addEventListener('pointerdown', e => {
    if (openPop && !openPop.el.contains(e.target) && !openPop.opener.contains(e.target)) closePopup(false);
    if (S.pwMenuOpen && !(e.target.closest && e.target.closest('.pw-wrap'))) closePwMenu(false);
  }, true);
  window.addEventListener('resize', () => closePopup(false));
  $('#btnSearch').onclick = () => { const open = !document.body.classList.contains('search-open'); setSearchRow(open); if (open) focusSearch(); };
  $('#issuesBadge').onclick = () => {
    hideRackFront(); showTab('attn'); if (isPhone()) setSheet('half', 'issues');
    if (S.kiosk && S.attnDockCollapsed) { S.attnDockCollapsed = false; LS.set('attnDockCollapsed', false); renderAttention(); }
    $('#attn .attn-row')?.focus({ preventScroll: true });
  };
  $('#dqFooter').onclick = () => showTab('dq');
  $$('[data-rlist]').forEach(b => b.onclick = () => setRacksList(b.dataset.rlist));
  // side panel tabs: one tab stop, arrows move between them
  $('.side-tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault();
    const tabs = $$('.tab[data-tab]'); const i = tabs.indexOf(document.activeElement); const n = tabs[(i + (e.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
    showTab(n.dataset.tab === 'tree' ? 'racks' : n.dataset.tab); n.focus();
  });
  $('#btnHelp').onclick = () => askChoice({ title: 'Mouse & keyboard help', choices: [{ id: 'cancel', label: 'Close', cls: 'primary' }],
    html: `<div class="help"><div><b>Left drag</b> or one finger: rotate</div><div><b>Right drag</b>: pan · <b>Wheel</b> or pinch: zoom</div><div><b>Click</b> an object: select it (the camera stays) · <b>Focus</b>: fly to it</div>
      <div><b>R</b> overview · <b>F</b> rack front · <b>E</b> aisle · <b>T</b> top · <b>[</b> / <b>]</b> previous / next rack in the rack front</div>
      <div><b>/</b> search · <b>W</b> walls · <b>Z</b> zones · <b>L</b> labels · <b>Arrow keys</b> pan</div>
      <div><b>K</b> lab screen mode · <b>F2</b> edit layout · <b>Home</b> reset view · <b>Esc</b> close</div></div>` });
  // ── keyboard: "/" search, views, rack front prev / next, Escape
  const editable = t => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  const overlayOpen = () => !!(choiceOpen || openPop || inlineConsole || !$('#settings').classList.contains('hidden'));
  window.addEventListener('keydown', e => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !editable(e.target) && !overlayOpen()) { e.preventDefault(); focusSearch(); return; }
    if (S.front && !overlayOpen() && !editable(e.target) && !S.pwMenuOpen) {
      if (e.key === '[' || e.key === ']') { e.preventDefault(); stepFront(e.key === ']' ? 1 : -1); return; }
      if (e.key === 'Escape' && (e.target === canvas || e.target === document.body || $('#rackFront').contains(e.target) || $('#detail').contains(e.target))) {
        e.preventDefault(); if (S.selected) closeDetail(); else leaveFront(); return;
      }
    }
    if (e.target !== canvas && e.target !== document.body) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') setView('orbit'); if (k === 't') setView('top'); if (k === 'e') setView('eye'); if (k === 'f') setView('front');
    if (k === 'w') $('#tWalls').click(); if (k === 'l') $('#tLabels').click(); if (k === 'z') $('#tZones').click();
    if (k === 'k') toggleKiosk(); if (e.key === 'F2') toggleEdit();
    if (e.key === 'Home') $('#vReset').click(); if (e.key === 'Escape') { closeDetail(); $('#settings').classList.add('hidden'); }
  });

  // ───────────────────────────────────────────────────────────── breadcrumb + legend
  function renderCrumb() {
    const el = $('#crumbPath'); if (!el || !S.data) return;
    let parts;
    if (S.front) { const su = S.recs.get(S.front); parts = ['Lab', rowLabel(S.data.zones.find(z => z.id === su?.zone)), rackName(su?.def)].filter(Boolean); }
    else parts = ['Lab', VIEW_LABEL[S.view] || '3D view'];
    el.innerHTML = parts.map((p, i) => `<span${i === parts.length - 1 ? ' class="cur"' : ''}>${esc(p)}</span>`).join('<span class="sep" aria-hidden="true">›</span>');
    $('#rfNav').classList.toggle('hidden', !S.front);
  }
  $('#rfPrev').onclick = () => stepFront(-1); $('#rfNext').onclick = () => stepFront(1);
  function renderLegend() {
    const lg = $('#legend'); if (!lg) return;
    const sw = (cls, style, label) => `<span class="li"><span class="sw ${cls}"${style ? ` style="${style}"` : ''} aria-hidden="true"></span>${label}</span>`;
    if (S.colorBy === 'health') lg.innerHTML = `<span class="lg-t">Health</span>${sw('dot', `background:${HEALTH.up.c}`, 'Up')}${sw('dot', `background:${HEALTH.down.c}`, 'Down')}${sw('dot unk', '', 'Unknown')}${sw('sq', `background:${HEALTH.maint.c}`, 'Maintenance')}${sw('sq sel', '', 'Selected')}`;
    else lg.innerHTML = `<span class="lg-t">Lifecycle</span>${STATUSES.map(st => sw('dot', `background:${STATUS_COLOR[st]}`, STATUS_LABEL[st])).join('')}${sw('sq dashed', '', 'Low confidence')}${sw('sq sel', '', 'Selected')}`;
    lg.title = S.colorBy === 'health' ? 'Dashed = health unknown (no live signal). Shelves stay neutral.' : 'Dashed outline = low placement confidence; faded = medium';
  }

  // ───────────────────────────────────────────────────────────── rack front view (one rack, shelf by shelf)
  function pickFrontRack() {
    const su = rackRecOf(S.recs.get(S.selected)); if (su) return su.id;
    const issue = issuesOf(S.attention).find(e => e.setup && S.recs.get(e.setup)?.cat === 'setup');
    return issue ? issue.setup : S.data.setups[0]?.id;
  }
  function showRackFront(sid) {
    const su = S.recs.get(sid); if (!su || su.cat !== 'setup') return;
    if (!S.front) { S.viewBeforeFront = S.view; cancelNavigation(); }
    S.front = sid; controls.enabled = false;
    document.body.classList.add('front'); $('#rackFront').classList.remove('hidden'); $('#vBack').classList.remove('hidden');
    markView('front'); renderRackFront(); renderRackBar(); resize(); placeAttnDock();
  }
  function hideRackFront() {
    if (!S.front) return; S.front = null; controls.enabled = true;
    document.body.classList.remove('front'); const el = $('#rackFront'); el.classList.add('hidden'); el.innerHTML = ''; $('#vBack').classList.add('hidden');
    markView(null); renderRackBar(); resize(); placeAttnDock();
  }
  function leaveFront() { const v = S.viewBeforeFront; hideRackFront(); markView(v); }
  function stepFront(d) { const ids = S.data.setups.map(s => s.id); const i = ids.indexOf(S.front); showRackFront(ids[(i + d + ids.length) % ids.length]); }
  function dotHtml(rec) {
    if (S.colorBy !== 'health') return `<span class="hdot" style="background:${paint(rec)}" aria-hidden="true"></span>`;
    const h = healthOfRec(rec); return `<span class="hdot ${h ? 'h-' + h.h : 'h-none'}" aria-hidden="true"></span>`;
  }
  function renderRackFront() {
    const el = $('#rackFront'); if (!el || !S.front) return; const su = S.recs.get(S.front);
    if (!su || su.cat !== 'setup') { hideRackFront(); return; }
    const def = su.def; const live = S.live.connected; const h = rackHealth(def) || { h: 'unknown', why: '' }; const t = rackTelemetry(def);
    const right = !live ? 'No live data' : !t ? (def.dcimRack ? 'No PDU' : 'Not mapped') : t.loading ? 'Loading…' : !t.reachable ? 'PDU offline' : `${t.watts == null ? '—' : (t.partial ? '≥' : '') + (t.watts / 1000).toFixed(2)} kW · ${t.on}/${t.total} on`;
    const fa = document.activeElement; const focusId = el.contains(fa) ? fa.dataset.id || fa.dataset.dest || null : null;
    const mover = S.moveItem ? S.recs.get(S.moveItem) : null; const moverPC = mover?.item?.type === 'opt';
    const tile = r => {
      const it = r.item; const hh = itemHealth(it); const sel = S.selected === r.id;
      const st = !hh ? ITEM_KIND[it.type] || 'Equipment' : hh.h === 'up' ? 'Up' : hh.h === 'maint' ? 'Maintenance' : hh.h === 'down' ? (hh.why === 'No ping' ? 'No ping' : hh.why === 'Off' ? 'Off' : 'Down') : 'Unknown';
      const noKvm = it.type === 'opt' && live && it.live?.inDcim && !kvmTargets(it).length;
      const dest = !!mover && r.id !== mover.id && ((it.type === 'opt') === moverPC);
      return `<button type="button" class="rf-tile${sel ? ' sel' : ''}${dest ? ' dest' : ''}" data-id="${esc(r.id)}" aria-pressed="${sel}"${mover && !dest ? ' disabled' : ''} title="${esc(dest ? `Move ${mover.def.name || mover.id} here (asks first; ${r.def.name || r.id} can swap)` : `${r.def.name || r.id} · ${hh?.why || st}`)}"><span class="rf-name">${esc(r.def.name || r.id)}</span><span class="rf-st">${noKvm ? '<span class="rf-tag">No KVM</span>' : ''}${dotHtml(r)}${esc(st)}${sel ? ' · selected' : ''}</span></button>`;
    };
    const free = (sh, pc) => mover && moverPC === pc ? `<button type="button" class="rf-free dest" data-dest="${esc(sh.id)}" title="Move ${esc(mover.def.name || mover.id)} here (asks first)">Move here</button>` : `<div class="rf-free">Free</div>`;
    const shelves = recsOf(r => r.cat === 'shelf' && r.setup === su.id).sort((a, b) => b.level - a.level);
    const rows = shelves.map(sh => {
      const its = recsOf(r => r.cat === 'item' && r.shelf === sh.id); const pcs = its.filter(r => r.item?.type === 'opt'), eq = its.filter(r => r.item?.type !== 'opt');
      return `<div class="rf-cap">${esc(shelfCaption(sh).toUpperCase())}</div><div class="rf-shelf" data-shelf="${esc(sh.id)}"><div class="rf-slot">${pcs.length ? pcs.map(tile).join('') : free(sh, true)}</div><div class="rf-slot">${eq.length ? eq.map(tile).join('') : free(sh, false)}</div></div>`;
    }).join('');
    const bay = recsOf(r => r.cat === 'item' && r.setup === su.id && !r.shelf);
    el.setAttribute('aria-label', `${rackName(def)} front view`);
    el.className = 'rackfront' + (mover ? ' moving' : '');
    el.innerHTML = `<div class="rf-rack ${S.colorBy === 'health' ? 'h-' + h.h : 'h-status'}"><div class="rf-head" title="${esc(h.why ? `${HEALTH[h.h].t} · ${h.why}` : HEALTH[h.h].t)}"><span>${esc(rackName(def))}</span><span>${esc(right)}</span></div>` +
      `<div class="rf-body">${rows || '<div class="rf-cap">This rack has no shelves in lab-data.json.</div>'}` +
      (bay.length ? `<div class="rf-cap">RACK LEVEL</div><div class="rf-bay">${bay.map(r => `<button type="button" class="rf-chip${S.selected === r.id ? ' sel' : ''}" data-id="${esc(r.id)}" aria-pressed="${S.selected === r.id}"${mover ? ' disabled' : ''}>${dotHtml(r)}${esc(r.def.name || r.id)}</button>`).join('')}</div>` : '') + `</div></div>`;
    $$('[data-id]', el).forEach(b => b.onclick = () => {
      if (S.moveItem) { const sh = b.closest('[data-shelf]')?.dataset.shelf; if (sh) requestMove(S.recs.get(sh)); return; }
      select(b.dataset.id, { keepCamera: true });
    });
    $$('[data-dest]', el).forEach(b => b.onclick = () => requestMove(S.recs.get(b.dataset.dest)));
    if (focusId) { const again = $$('[data-id], [data-dest]', el).find(b => (b.dataset.id || b.dataset.dest) === focusId); if (again) again.focus({ preventScroll: true }); }
  }

  // ───────────────────────────────────────────────────────────── phone: bottom sheet (Issues · Racks · Details)
  const SHEET_PX = { peek: 148, half: 330 };
  function setSheet(size, tab) {
    if (size) S.sheet.size = size;
    if (tab) S.sheet.tab = tab === 'details' && !S.selected ? 'issues' : tab;
    const b = document.body; b.dataset.sheetSize = S.sheet.size; b.dataset.stab = S.sheet.tab;
    document.documentElement.style.setProperty('--sheet-h', S.sheet.size === 'full' ? 'calc(100dvh - 56px)' : SHEET_PX[S.sheet.size] + 'px');
    $('#sheetHandle').setAttribute('aria-expanded', String(S.sheet.size === 'full'));
    $('#sheetHandle').setAttribute('aria-label', `Panel size: ${S.sheet.size} — tap to change`);
    if (S.sheet.tab === 'racks' && S.sideTab !== 'tree') showTab('racks');
    else if (S.sheet.tab === 'issues' && S.sideTab === 'tree') showTab('attn');
    updateSheetTabs();
    if (isPhone()) placeAttnDock();
  }
  function updateSheetTabs() {
    if (S.sheet.tab === 'details' && !S.selected) { S.sheet.tab = S.sideTab === 'tree' ? 'racks' : 'issues'; document.body.dataset.stab = S.sheet.tab; }
    $$('[data-sheet]').forEach(t => { const on = t.dataset.sheet === S.sheet.tab; t.setAttribute('aria-selected', String(on)); t.classList.toggle('on', on); t.tabIndex = on ? 0 : -1; if (t.dataset.sheet === 'details') t.disabled = !S.selected; });
  }
  function renderSheetHead() {
    const t = $('#sheetTitle'); if (!t) return;
    const real = issuesOf(S.attention).filter(e => e.kind !== 'offline'); const c = attnCounts(real);
    t.textContent = !S.live.connected ? (S.live.signedOut ? 'Signed out' : 'Live data off') : real.length ? `${c.crit ? c.crit + ' critical' : c.warn + ' warning' + (c.warn === 1 ? '' : 's')} · ${real[0].text}` : 'No issues';
  }
  $$('[data-sheet]').forEach(t => t.onclick = () => setSheet(S.sheet.size === 'peek' ? 'half' : null, t.dataset.sheet));
  $('.sheet-tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault();
    const tabs = $$('[data-sheet]').filter(t => !t.disabled); const i = tabs.indexOf(document.activeElement); const n = tabs[(i + (e.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
    n.click(); n.focus();
  });
  // the handle: tap = next size; drag = any height, released to the nearest size
  (() => {
    const hd = $('#sheetHandle'); let drag = null, dragged = false;
    hd.addEventListener('pointerdown', e => { drag = { y: e.clientY, h: $('#sheet').getBoundingClientRect().height }; dragged = false; try { hd.setPointerCapture(e.pointerId); } catch {} });
    hd.addEventListener('pointermove', e => {
      if (!drag) return; const dy = drag.y - e.clientY; if (Math.abs(dy) > 6) dragged = true; if (!dragged) return;
      const h = Math.max(SHEET_PX.peek, Math.min(innerHeight - 56, drag.h + dy)); document.documentElement.style.setProperty('--sheet-h', h + 'px');
    });
    const end = () => {
      if (!drag) return; const was = drag; drag = null; if (!dragged) return;
      const h = $('#sheet').getBoundingClientRect().height; const full = innerHeight - 56;
      const near = [['peek', SHEET_PX.peek], ['half', SHEET_PX.half], ['full', full]].sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0];
      setSheet(near); void was;
    };
    hd.addEventListener('pointerup', end); hd.addEventListener('pointercancel', end);
    hd.addEventListener('click', e => { if (dragged) { e.preventDefault(); dragged = false; return; } setSheet({ peek: 'half', half: 'full', full: 'peek' }[S.sheet.size]); });
  })();
  // ───────────────────────────────────────────────────────────── picking
  let downPos = null;
  canvas.addEventListener('pointerdown', e => {
    downPos = e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false } : null;
  });
  canvas.addEventListener('pointermove', e => {
    if (downPos && e.pointerId === downPos.id && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) downPos.moved = true;
    if (e.pointerType === 'mouse' && e.buttons === 0 && activePointers.size) cancelNavigation();
  }, true);
  canvas.addEventListener('pointerup', e => {
    const down = downPos; downPos = null;
    const rect = canvas.getBoundingClientRect();
    if (!down || down.id !== e.pointerId || down.moved || e.button !== 0 || activePointers.size > 1 ||
        e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
    const hit = pickAt(e);
    if (S.moveItem && S.editMode && window.DCIM_CAN_OPERATE) {
      const target = hit ? resolveMoveTarget(hit) : null;
      if (target) requestMove(target); else toast('Choose a shelf, rack or storage destination, or Cancel', 'err');
      return;
    }
    if (hit) select(hit.object.userData.id, { keepCamera: true });
  });
  ['pointerdown', 'wheel', 'keydown', 'touchstart'].forEach(t => window.addEventListener(t, () => { S.lastInput = performance.now(); }, { passive: true }));
  let hoverT = 0;
  canvas.addEventListener('pointermove', e => {
    const now = performance.now(); if (now - hoverT < 40) return; hoverT = now; const hit = pickAt(e);
    let id = hit ? hit.object.userData.id : null;
    if (S.moveItem) { const t = hit ? resolveMoveTarget(hit) : null; id = t ? t.id : null; }
    if (id !== S.hover) { setHover(id); }
  });
  function pickAt(e) {
    // A live refresh rebuilds item meshes; until the next frame is drawn their world matrices are stale, so a tap
    // right after a refresh would miss them (and in Move mode say "Choose a shelf").
    scene.updateMatrixWorld();
    const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(S.pickables.filter(m => isShown(m) && (m.material.opacity > 0.2)), false);
    for (const h of hits) { const rec = S.recs.get(h.object.userData.id); if (!rec || rec.filtered) continue; if (rec.cat === 'zone') continue; return h; }
    // fall back to zone plane
    return hits.find(h => S.recs.get(h.object.userData.id)?.cat === 'zone') || null;
  }
  // visible only if every ancestor up to the scene is visible (Walls / Zones off hide whole groups)
  function isShown(o) { for (let x = o; x; x = x.parent) { if (!x.visible) return false; if (x === scene) return true; } return false; }
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
    if (id) { const r = S.recs.get(id); if (r && r.cat !== 'zone') r.meshes.forEach(m => { if (m.material.userData.unique !== false && !m.material.userData.hoverEm) { m.material.userData.hoverEm = { i: m.material.emissiveIntensity, c: m.material.emissive.getHex() }; m.material.emissive.setHex(0xffffff); m.material.emissiveIntensity = 0.12; } }); }
  }

  // ───────────────────────────────────────────────────────────── labels projection
  const tmpV = new THREE.Vector3();
  function updateLabels() {
    const r = canvas.getBoundingClientRect(); const camPos = camera.position;
    const hoverSetup = S.labelHover || (S.hover ? (S.recs.get(S.hover)?.cat === 'setup' ? S.hover : S.recs.get(S.hover)?.setup) : null);
    if (S.entrance) {
      tmpV.copy(S.entrance.anchor).project(camera); const vis = S.labelMode !== 'none' && tmpV.z <= 1 && Math.abs(tmpV.x) <= 1 && Math.abs(tmpV.y) <= 1;
      S.entrance.el.style.display = vis ? '' : 'none'; if (vis) { S.entrance.el.style.left = ((tmpV.x + 1) / 2 * r.width) + 'px'; S.entrance.el.style.top = ((1 - tmpV.y) / 2 * r.height) + 'px'; }
    }
    for (const rec of S.recs.values()) {
      const ab = rec.attnEl;
      if (ab) {
        let vis = rec.attnN > 0 && !rec.filtered;
        if (vis) { tmpV.copy(rec.attnAnchor).project(camera); vis = tmpV.z <= 1 && Math.abs(tmpV.x) <= 1.05 && Math.abs(tmpV.y) <= 1.05; }
        if (!vis) ab.style.display = 'none';
        else { ab.style.display = ''; ab.style.left = ((tmpV.x + 1) / 2 * r.width) + 'px'; ab.style.top = ((1 - tmpV.y) / 2 * r.height) + 'px'; }
      }
      const el = rec.telem; if (!el) continue;
      const full = S.heat || S.selected === rec.id || hoverSetup === rec.id;
      const show = full && !rec.filtered && S.labelMode !== 'none' && (S.live.connected || S.selected === rec.id);
      if (!show) { el.style.display = 'none'; continue; }
      tmpV.copy(rec.telemAnchor); const dist = tmpV.distanceTo(camPos); tmpV.project(camera);
      if (tmpV.z > 1 || Math.abs(tmpV.x) > 1.1 || Math.abs(tmpV.y) > 1.1) { el.style.display = 'none'; continue; }
      el.style.display = ''; el.style.left = ((tmpV.x + 1) / 2 * r.width) + 'px'; el.style.top = ((1 - tmpV.y) / 2 * r.height) + 'px'; el.style.opacity = dist > 16 ? .6 : 1; el.style.zIndex = Math.max(2, Math.round(110 - dist * 3));
    }
    for (const rec of S.recs.values()) {
      const el = rec.label; if (!el) continue;
      let show = !rec.filtered || S.selected === rec.id;
      if (show) {
        if (rec.cat === 'zone') show = S.zonesVisible && S.labelMode === 'all';
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
    controls.autoRotate = false;
    const animating = !!S.tween;
    if (S.tween) { const k = S.tween.ms > 0 ? Math.min(1, (performance.now() - S.tween.t0) / S.tween.ms) : 1; const e = 1 - Math.pow(1 - k, 3); camera.position.lerpVectors(S.tween.p0, S.tween.p1, e); controls.target.lerpVectors(S.tween.t0v, S.tween.t1v, e); if (k >= 1) S.tween = null; }
    const pulse = reducedMotion() ? 0.85 : 0.55 + 0.45 * Math.sin(performance.now() / 250); for (const r of S.recs.values()) if (r.leakRing && r.leakRing.visible) r.leakRing.material.opacity = pulse;
    controls.update(); constrainNavigation(!animating); renderer.render(scene, camera); updateLabels();
  }


  // ───────────────────────────────────────────────────────────── EDIT MODE (touch-friendly editor for the lab screen)
  const STATUS_ICON = { active: '●', building: '◐', inactive: '○', dismantled: '✕', unknown: '?' };
  function toggleEdit(force) { if (!window.DCIM_CAN_OPERATE) { toast('Viewer account: read only', 'err'); return; } S.editMode = force !== undefined ? force : !S.editMode; LS.set('editMode', S.editMode); document.body.classList.toggle('editmode', S.editMode); markEdit(); if (!S.editMode) cancelMove(); if (S.selected) select(S.selected, { keepCamera: true }); toast(S.editMode ? 'Edit mode — tap any rack, shelf or item' : 'Edit mode off', 'ok'); }
  function markEdit() {
    const b = $('#btnEdit'); b.classList.toggle('on', S.editMode); b.setAttribute('aria-pressed', String(S.editMode)); b.textContent = S.editMode ? 'Done editing' : 'Edit layout';
    const m = $('#mEdit'); if (m) m.textContent = S.editMode ? 'Done editing' : 'Edit layout';
  }
  function toggleKiosk(force) {
    S.kiosk = force !== undefined ? force : !S.kiosk; LS.set('kiosk', S.kiosk); document.body.classList.toggle('kiosk', S.kiosk);
    const k = $('#btnKiosk'); k.classList.toggle('on', S.kiosk); k.textContent = S.kiosk ? 'Leave lab screen mode' : 'Lab screen mode';
    if (S.kiosk && S.labelMode === 'none') setLabelMode('setups'); renderAttention(); resize();
  }
  $('#btnEdit').onclick = () => toggleEdit(); $('#btnKiosk').onclick = () => toggleKiosk();

  function startMove(itemId) {
    if (!S.editMode || !window.DCIM_CAN_OPERATE) return;
    controls.cancel(); controls.enableRotate = false; S.moveItem = itemId; document.body.classList.add('moving'); $('#moveBanner').classList.remove('hidden');
    $('#moveText').textContent = `Move ${S.recs.get(itemId)?.def.name || itemId}: tap a shelf in 3D, or`;
    fillMoveTargets(itemId); applyFilters(); highlightTargets(true); placeAttnDock(); if (S.front) renderRackFront();
    $('#moveTarget').focus({ preventScroll: true });   // keyboard users can choose a destination without the 3D view
  }
  // Keyboard / screen-reader way to choose a destination: every shelf (top to bottom), rack bottom bay and storage.
  function fillMoveTargets(itemId) {
    const sel = $('#moveTarget'); const here = S.recs.get(itemId)?.item?.shelf;
    const opt = (id, text) => `<option value="${esc(id)}"${id === here ? ' disabled' : ''}>${esc(text)}</option>`;
    sel.innerHTML = `<option value="">Destination…</option>` + S.data.setups.map(su => {
      const shelves = recsOf(r => r.cat === 'shelf' && r.setup === su.id).sort((a, b) => b.level - a.level);
      const who = sh => recsOf(r => r.cat === 'item' && r.shelf === sh.id).map(r => r.def.name || r.id).join(', ');
      return `<optgroup label="${esc(su.id + (su.dcimRack ? ' · ' + su.dcimRack : ''))}">` + shelves.map(sh => opt(sh.id, `${sh.id} · L${sh.level}${who(sh) ? ' — ' + who(sh) : ' — empty'}`)).join('') + opt(su.id, `${su.id} · bottom bay`) + `</optgroup>`;
    }).join('') + `<optgroup label="Storage">${S.data.storage.map(st => opt(st.id, `${st.id} · ${st.name}`)).join('')}</optgroup>`;
  }
  // Tree rows: while moving, a shelf / rack / storage row (or a device row → its shelf) is the destination.
  function activateTreeRow(id) {
    const r = S.recs.get(id);
    if (S.moveItem && r) {
      const target = ['shelf', 'setup', 'storage'].includes(r.cat) ? r : r.cat === 'item' && r.shelf ? S.recs.get(r.shelf) : null;
      if (target) { requestMove(target); return; }
    }
    select(id);
  }
  $('#moveGo').onclick = () => { const r = S.recs.get($('#moveTarget').value); if (r) requestMove(r); else toast('Choose a destination first', 'err'); };
  function cancelMove() { controls.enableRotate = true; if (!S.moveItem) return; S.moveItem = null; document.body.classList.remove('moving'); $('#moveBanner').classList.add('hidden'); placeAttnDock(); highlightTargets(false); applyFilters(); if (S.front) renderRackFront(); }
  $('#moveCancel').onclick = cancelMove;
  function highlightTargets(on) {
    for (const r of S.recs.values()) if (r.cat === 'shelf') {
      r.edges.forEach(e => { e.material.color.set(on ? '#22d3ee' : shelfColor(r)); e.material.opacity = on ? 1 : (e.userData.baseOpacity ?? .7); });
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
  function dcimDestination(target) {
    const sid = target.cat === 'shelf' ? target.setup : target.cat === 'setup' ? target.id : null;
    if (!sid) throw new Error('Lab Manager devices can only be moved onto a rack or a shelf');
    const su = S.data.setups.find(s => s.id === sid); const rack = dcimRackOf(su);
    if (!rack) throw new Error(`${sid} is not mapped to a DCIM rack yet — open the rack in Edit mode and set "DCIM rack" first`);
    return { rack, u: shelfToU(sid, target.cat === 'shelf' ? target.id : null) };
  }
  // One write per Lab Manager store for the whole move (one device, or two for a swap), so a swap can never leave both
  // devices on one shelf. Servers the move does not touch keep their shelf: auto-placed ones in the affected racks are
  // pinned to the U they show now, otherwise taking or freeing a U would silently renumber them.
  // Fresh copies of the layout stores with their revisions (ETags). The occupancy check made right before a move and
  // the write itself use the same revisions, so a change by anyone in between is refused (409) instead of overwritten.
  async function readMoveLayout() {
    return layoutWrite(async () => {
      const [rackSlots, rackOverrides, rackOrder, rackItems] = await Promise.all(['/api/rack-slots', '/api/rack-overrides', '/api/rack-positions', '/api/rack-items']
        .map(p => api(p, { withEtag: true, cache: 'no-store' })));
      Object.assign(S.live, { rackSlots: rackSlots.data || {}, rackOverrides: rackOverrides.data || {}, rackOrder: rackOrder.data || {}, rackItems: rackItems.data || {} });
      return { rackSlots, rackOverrides, rackOrder, rackItems };
    });
  }
  // Write a move (one device, or two for a swap) in ONE request per store kind, against the revisions in `fresh`:
  // OPTs → PUT /api/rack-layout (rack_slots + rack_positions + rack_overrides together or not at all, server side);
  // DCIM rack items → PUT /api/rack-items. Servers the move does not touch keep their shelf: auto-placed ones in the
  // affected racks are pinned to the U they show now, otherwise taking or freeing a U would silently renumber them.
  async function dcimMoveMany(moves, fresh) {
    const dest = moves.map(m => ({ ...m, ...dcimDestination(m.target) }));
    const opts = dest.filter(m => m.kind === 'opt'), equips = dest.filter(m => m.kind === 'rack-item');
    const clone = x => JSON.parse(JSON.stringify(x || {}));
    if (opts.length) {
      const keys = new Set(opts.map(m => m.mit.dcim.optKey));
      const racks = new Set(opts.flatMap(m => [m.rack, m.mit.live?.rack].filter(Boolean)));
      const pins = (S.model?.items || []).filter(i => i.type === 'opt' && i.live?.inDcim && i.dcim?.optKey && !keys.has(i.dcim.optKey) && racks.has(i.live.rack) && i.placementConfidence === 'low' && Number.isInteger(i.live.u));
      const ov = clone(fresh.rackOverrides.data), slots = clone(fresh.rackSlots.data), order = clone(fresh.rackOrder.data);
      opts.forEach(m => {
        const key = m.mit.dcim.optKey; const pduRack = S.live.devices.find(d => d.id === m.mit.dcim.pdu)?.rack || null;
        if (m.rack === pduRack) delete ov[key]; else ov[key] = m.rack;
        Object.keys(slots).forEach(r => { if (slots[r] && key in slots[r]) delete slots[r][key]; });
        Object.keys(order).forEach(r => { if (Array.isArray(order[r])) order[r] = order[r].filter(k => k !== key); });
      });
      pins.forEach(i => { const r = (slots[i.live.rack] = slots[i.live.rack] || {}); if (r[i.dcim.optKey] == null) r[i.dcim.optKey] = i.live.u; });
      opts.forEach(m => { (slots[m.rack] = slots[m.rack] || {})[m.mit.dcim.optKey] = m.u; (order[m.rack] = order[m.rack] || []).push(m.mit.dcim.optKey); });
      await layoutWrite(() => api('/api/rack-layout', { method: 'PUT', body: JSON.stringify({
        rack_overrides: { data: ov, if_match: fresh.rackOverrides.etag }, rack_slots: { data: slots, if_match: fresh.rackSlots.etag }, rack_positions: { data: order, if_match: fresh.rackOrder.etag } }) }));
      Object.assign(S.live, { rackOverrides: ov, rackSlots: slots, rackOrder: order });
    }
    if (equips.length) {
      // the whole record moves, so SN, barcode and tracking fields stay with it
      const items = clone(fresh.rackItems.data);
      const found = equips.map(m => {
        const ciId = m.mit.id.slice(5); let ci = null;
        Object.keys(items).forEach(r => { const i = (items[r] || []).findIndex(x => String(x.id) === ciId); if (i >= 0) { ci = items[r][i]; items[r].splice(i, 1); } });
        if (!ci) throw new Error('rack item not found in Lab Manager data');
        return { m, ci };
      });
      found.forEach(({ m, ci }) => { ci.u = m.u; (items[m.rack] = items[m.rack] || []).push(ci); });
      if (!fresh.rackItems.etag) throw new Error('Refresh the backend connection before moving equipment');
      S.live.rackItems = await layoutWrite(() => api('/api/rack-items', { method: 'PUT', headers: { 'If-Match': fresh.rackItems.etag }, body: JSON.stringify(items) }));
    }
    return dest.map(m => `${m.rack} · U${m.u}`);
  }
  function placeText(it) {
    if (!it) return 'not placed';
    const u = it.live?.rack && it.live?.u != null ? ` (${it.live.rack} · U${it.live.u})` : '';
    if (it.shelf) return shelfName(it.shelf) + u;
    if (it.placement === 'bottom-bay' && it.setup) return `${it.setup} · bottom bay`;
    if (it.placement === 'side-mount' && it.setup) return `${it.setup} · ${it.side || 'right'} side`;
    if (it.placement === 'rack-strips' && it.setup) return `${it.setup} · power strips`;
    if (it.storage) return it.storage;
    if (it.pos) return `free · x ${it.pos[0]} z ${it.pos[1]}`;
    if (it.live?.rack) return `${it.live.rack}${it.live.u != null ? ' · U' + it.live.u : ''} · no shelf`;
    return 'not placed';
  }
  function targetText(target, kind) {
    let u = '';
    if (kind) { try { const d = dcimDestination(target); u = ` (${d.rack} · U${d.u})`; } catch { /* reported as plan.error */ } }
    if (target.cat === 'shelf') return shelfName(target.id) + u;
    if (target.cat === 'setup') return `${target.id} · bottom bay` + u;
    return target.id;
  }
  function placementPatch(target) {
    const patch = { setup: null, shelf: null, storage: undefined, placement: undefined, pos: undefined, side: undefined, placementConfidence: 'high' };
    if (target.cat === 'shelf') { patch.setup = target.setup; patch.shelf = target.id; patch.zone = target.zone; }
    else if (target.cat === 'setup') { patch.setup = target.id; patch.placement = 'bottom-bay'; patch.zone = target.zone; }
    else if (target.cat === 'storage') { patch.storage = target.id; patch.zone = target.zone; }
    return patch;
  }
  // What a drop on `target` would do: from → to, who already occupies the shelf, and whether the two can swap.
  // Shelf rule: one PC (OPT) and one rack item per shelf.
  function movePlan(id, target) {
    const rec = S.recs.get(id); const mit = rec?.item; const def = S.data.items.find(x => x.id === id);
    if (!target || (!def && !mit)) return null;
    const it = mit || def; const kind = movesViaDcim(mit);
    // Lab Manager places a device dropped on a rack's bottom bay on its lowest shelf: say so, and check that shelf
    if (kind && target.cat === 'setup') { const low = recsOf(r => r.cat === 'shelf' && r.setup === target.id).sort((a, b) => a.level - b.level)[0]; if (low) target = low; }
    const plan = { id, rec, mit, def, name: it.name || id, kind, target, from: placeText(it), to: targetText(target, kind), occupant: null, swappable: false, swapWhy: '', source: null, error: null, same: false };
    if (kind) { try { dcimDestination(target); } catch (e) { plan.error = e.message; } }
    if (target.cat !== 'shelf') return plan;
    if (it.shelf === target.id) { plan.same = true; return plan; }
    const isPC = it.type === 'opt';
    const occ = recsOf(r => r.cat === 'item' && r.shelf === target.id && r.id !== id && ((r.item?.type === 'opt') === isPC))
      .sort((a, b) => (movesViaDcim(b.item) ? 1 : 0) - (movesViaDcim(a.item) ? 1 : 0));   // live devices first
    plan.occupant = occ[0] || null;
    if (plan.occupant) {
      const src = it.shelf ? S.recs.get(it.shelf) : null; plan.source = src || null;
      const okind = movesViaDcim(plan.occupant.item); const odef = S.data.items.find(x => x.id === plan.occupant.id);
      if (!src) plan.swapWhy = `${plan.name} is not on a shelf now, so there is no place to swap to.`;
      else if (!okind && !odef) plan.swapWhy = `${plan.occupant.def.name || plan.occupant.id} cannot be moved from the twin.`;
      else if (okind) { try { dcimDestination(src); } catch (e) { plan.swapWhy = e.message; } }
      plan.swappable = !plan.swapWhy;
    }
    return plan;
  }
  // Runs only after the user confirmed `plan` in the dialog. The destination may have changed while the dialog was
  // open (a live refresh, another person's move), so it is planned again on what Lab Manager holds right now — read
  // with the revisions the write will carry. If the occupant (or the swap source) is not the one the user confirmed,
  // nothing is written and the user is asked again.
  async function performMove(plan, swap) {
    const occupantMoves = swap && plan.occupant && movesViaDcim(plan.occupant.item);
    let fresh = null;
    if (plan.kind || occupantMoves) {
      try { fresh = await readMoveLayout(); }
      catch (e) { toast('Move failed: ' + e.message, 'err'); return false; }
      computeModel(); buildItems();
    }
    const now = movePlan(plan.id, plan.target);
    const unchanged = !!now && !now.same && !now.error && (now.occupant?.id || null) === (plan.occupant?.id || null) && now.kind === plan.kind &&
      (!swap || (now.swappable && now.source?.id === plan.source?.id));
    if (!unchanged) {
      toast('The destination changed while the dialog was open — nothing was moved; check it and confirm again', 'err');
      if (S.editMode && window.DCIM_CAN_OPERATE && now && !now.same) { startMove(plan.id); return requestMove(plan.target); }
      return false;
    }
    plan = now;
    const moves = [{ id: plan.id, mit: plan.mit, def: plan.def, kind: plan.kind, target: plan.target }];
    if (swap) { const o = plan.occupant; moves.push({ id: o.id, mit: o.item, def: S.data.items.find(x => x.id === o.id), kind: movesViaDcim(o.item), target: plan.source }); }
    const viaDcim = moves.filter(m => m.kind);
    if (viaDcim.length) {
      toast(`Moving ${plan.name} in Lab Manager…`);
      try { await dcimMoveMany(viaDcim, fresh); }
      catch (e) {
        toast(e.status === 409 ? 'The rack layout changed in another session at the same moment — nothing was moved; try again' : 'Move failed: ' + e.message, 'err');
        await reloadLayout(); computeModel(); buildItems(); return false;
      }
    }
    const local = moves.filter(m => m.def);
    local.forEach(m => patchDef(m.id, placementPatch(m.target)));
    if (local.length) rebuildAll(); else { computeModel(); buildItems(); }
    const saved = viaDcim.length ? ' (saved in Lab Manager)' : '';
    toast(moves.length > 1 ? `${plan.name} ⇄ ${plan.occupant.def.name || plan.occupant.id} swapped${saved}` : `${plan.name} → ${plan.to}${saved}`, 'ok');
    select(plan.id, { keepCamera: true });
    return true;
  }
  // A tap (or the destination list / a tree row) while moving: always ask, showing from → to; an occupied shelf offers
  // Swap or Cancel. Cancel keeps the move mode so another shelf can be chosen (the banner's Cancel ends it).
  // There is deliberately no way to move without this dialog (window.__twin.finishMove opens it too).
  let moveAsking = false;
  async function requestMove(target) {
    if (!S.editMode || !window.DCIM_CAN_OPERATE) { cancelMove(); return false; }
    const id = S.moveItem; if (!id || moveAsking) return false;
    const plan = movePlan(id, target); if (!plan) { cancelMove(); return false; }
    if (plan.same) { toast(`${plan.name} is already on ${plan.to}`, 'err'); return false; }
    if (plan.error) { toast(plan.error, 'err'); return false; }
    moveAsking = true;
    let choice;
    try {
      const fromTo = `<div class="cf-move"><span class="k">From</span><b>${esc(plan.from)}</b><span class="k">To</span><b>${esc(plan.to)}</b></div>`;
      const where = plan.kind ? 'Saved in Lab Manager (rack / U slot).' : 'Saved in the twin — press “Save to server” afterwards.';
      if (plan.occupant) {
        const other = plan.occupant.def.name || plan.occupant.id;
        choice = await askChoice(plan.swappable
          ? { title: `${plan.target.id} is occupied`, html: `<div class="warn-box">${esc(other)} is already on ${esc(plan.to)}.</div>${fromTo}<div class="note">Swap places: ${esc(other)} moves to ${esc(plan.from)}. Nothing else moves. ${esc(where)}</div>`, choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'swap', label: 'Swap places', cls: 'primary' }] }
          : { title: `${plan.target.id} is occupied`, html: `<div class="warn-box">${esc(other)} is already on ${esc(plan.to)}.</div><div class="note">The two cannot swap places: ${esc(plan.swapWhy)} Choose a free shelf, or move ${esc(other)} first.</div>`, choices: [{ id: 'cancel', label: 'Choose another shelf' }] });
      } else {
        choice = await askChoice({ title: `Move ${plan.name}?`, html: `${fromTo}<div class="note">${esc(where)}</div>`, choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'move', label: 'Move here', cls: 'primary' }] });
      }
    } finally { moveAsking = false; }
    if (choice !== 'move' && choice !== 'swap') return false;
    cancelMove();
    return performMove(plan, choice === 'swap');
  }
  const finishMove = target => requestMove(target);   // kept name (debug handle, older notes): the same confirmed path

  function bigChips(cur) { return `<div class="chips-lg">${STATUSES.map(st => `<button class="chip-lg ${cur === st ? 'on' : ''}" data-st="${st}" style="--c:${STATUS_COLOR[st]}"><span class="ic">${STATUS_ICON[st]}</span>${STATUS_LABEL[st]}</button>`).join('')}</div>`; }
  function shelfName(id) { const sh = S.data.shelves.find(x => x.id === id); return sh ? `${sh.setup} · L${sh.level}` : id; }

  function renderEditor(rec) {
    const def = rec.def; const it = rec.item; const isLive = rec.id.startsWith('LIVE-');
    let html = `<div class="edit-hint">EDIT MODE · tap another object in the 3D view to switch</div>`;
    if (rec.cat === 'item' && isLive) {
      const loc = it.shelf ? shelfName(it.shelf) : it.setup ? `${it.setup} · ${it.live?.rack || ''} U${it.live?.u ?? '?'}` : it.live?.rack ? `${it.live.rack} (rack not mapped to a 3D setup)` : 'not placed';
      html += `<div class="sec big"><div class="note">Live from Lab Manager (DCIM). Moving it here writes the rack / U slot back into Lab Manager.</div>
        <label class="lbl-lg">Where</label><div class="where"><span class="where-txt">${esc(loc)}</span></div>
        ${movesViaDcim(it) ? `<div class="row-lg"><button class="btn-lg btn-cyan" id="eMove">⇄ Move… (tap a shelf)</button></div>` : ''}
        ${dcimOwnerKey(it) ? `<label class="lbl-lg">Owner (saved in Lab Manager)</label>${ownerPicker(it.owner)}` : ''}
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
        <label class="lbl-lg">Owner</label>${ownerPicker(it.owner)}
        <label class="lbl-lg">PDU · outlet</label>
        <div class="row-lg"><select class="in-lg" id="ePdu" style="flex:2"><option value="">— no PDU —</option>${pdus.map(x => `<option value="${esc(x.id)}" ${it.dcim?.pdu === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <div class="stepper"><button data-step="-1">−</button><input id="eOutlet" type="number" min="1" max="48" value="${esc(it.dcim?.outlet ?? '')}" placeholder="#" /><button data-step="1">＋</button></div></div>
        ${it.liveWarning ? `<div class="warn-box" role="status">⚠ ${esc(it.liveWarning)} <span class="muted">(live check — not part of the notes)</span></div>` : ''}
        <label class="lbl-lg">Notes</label><textarea class="in-lg" id="eNotes">${esc(cleanNotes(it.notes))}</textarea>
        <input type="hidden" id="eStatus" value="${esc(it.status || 'unknown')}" />
      </div>
      <div class="sec big actions">
        <button class="btn-lg btn-save" id="eSave">✓ Save</button>
        <button class="btn-lg btn-amber" id="eReplace">⟳ Replace with new device</button>
        <div class="row-lg"><button class="btn-lg" id="eDup">Duplicate</button><button class="btn-lg btn-danger" id="eDel">Delete</button></div>
      </div>`;
    } else if (rec.cat === 'shelf') {
      const its = recsOf(r => r.cat === 'item' && r.shelf === rec.id);
      html += `<div class="sec big"><div class="lbl-lg">On ${esc(rec.id)} · level L${esc(rec.level)} · ${esc(rec.setup)}</div>
        ${its.length ? its.map(i => `<div class="itm-lg"><span class="dot-lg" style="background:${STATUS_COLOR[i.status]}"></span><span class="itm-name">${esc(i.item.name)}<small>${esc(i.item.typeLabel || i.item.type)}${i.item.dcim?.outlet ? ' · outlet #' + esc(i.item.dcim.outlet) : ''}</small></span><button class="btn-lg sm" data-edit="${esc(i.id)}">Edit</button><button class="btn-lg sm btn-cyan" data-move="${esc(i.id)}">Move</button></div>`).join('') : '<div class="note">Shelf is empty.</div>'}
        <button class="btn-lg btn-save" id="eAddHere">＋ Add device on this shelf</button></div>
        <div class="sec big"><label class="lbl-lg">Shelf status</label>${bigChips(def.status || 'unknown')}<input type="hidden" id="eStatus" value="${esc(def.status || 'unknown')}"/><label class="lbl-lg">Notes</label><textarea class="in-lg" id="eNotes">${esc(def.notes || '')}</textarea><button class="btn-lg btn-save" id="eSave">✓ Save</button></div>`;
    } else if (rec.cat === 'setup') {
      const racks = [...new Set([...(S.data.dcim?.pdus || []).map(p => p.rack), ...S.model.liveRacks])].filter(Boolean).sort(); const cur = def.dcimRack || '';
      const shelves = recsOf(r => r.cat === 'shelf' && r.setup === rec.id).sort((a, b) => b.level - a.level);
      html += `<div class="sec big"><label class="lbl-lg">Name</label><input class="in-lg" id="eName" value="${esc(def.name)}"/>
        <label class="lbl-lg">DCIM rack (which Rack-0X is this physically?)</label><select class="in-lg" id="dRack"><option value="">— none —</option>${racks.map(r => `<option value="${esc(r)}" ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
        <label class="lbl-lg">Status</label>${bigChips(def.status || 'unknown')}<input type="hidden" id="eStatus" value="${esc(def.status || 'unknown')}"/>
        <label class="lbl-lg">Notes</label><textarea class="in-lg" id="eNotes">${esc(def.notes || '')}</textarea><button class="btn-lg btn-save" id="eSave">✓ Save</button></div>
        <div class="sec big"><div class="lbl-lg">Shelves (tap to edit)</div>${shelves.map(sh => { const its = recsOf(r => r.cat === 'item' && r.shelf === sh.id); return `<div class="itm-lg" data-go="${esc(sh.id)}"><span class="lvl-lg">L${esc(sh.level)}</span><span class="itm-name">${its.length ? its.map(i => esc(i.item.name)).join(', ') : '<i>empty</i>'}<small>${esc(sh.id)}</small></span><span class="chev">›</span></div>`; }).join('')}
        <button class="btn-lg" id="eAddBay">＋ Add rack-level item (bottom bay)</button></div>`;
    } else if (rec.cat === 'storage') {
      const its = recsOf(r => r.cat === 'item' && r.item?.storage === rec.id);
      html += `<div class="sec big"><label class="lbl-lg">Name</label><input class="in-lg" id="eName" value="${esc(def.name)}"/><label class="lbl-lg">Status</label>${bigChips(def.status || 'unknown')}<input type="hidden" id="eStatus" value="${esc(def.status || 'unknown')}"/><label class="lbl-lg">Notes</label><textarea class="in-lg" id="eNotes">${esc(def.notes || '')}</textarea><button class="btn-lg btn-save" id="eSave">✓ Save</button></div>
        <div class="sec big"><div class="lbl-lg">Contents</div>${its.map(i => `<div class="itm-lg"><span class="dot-lg" style="background:${STATUS_COLOR[i.status]}"></span><span class="itm-name">${esc(i.item.name)}<small>×${esc(i.item.quantity || 1)}</small></span><button class="btn-lg sm" data-edit="${esc(i.id)}">Edit</button></div>`).join('') || '<div class="note">Empty.</div>'}<button class="btn-lg" id="eAddStore">＋ Add item here</button></div>`;
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
    const eo = $('#eOwner'); if (eo && isLive) eo.onchange = () => { const key = dcimOwnerKey(it); if (key) saveDcimOwner(key, eo.value.trim() || null).then(() => toast('Owner saved in Lab Manager', 'ok')).catch(e => { toast('Owner not saved: ' + e.message, 'err'); select(rec.id, { keepCamera: true }); }); };
    $$('[data-side]', body).forEach(b => b.onclick = () => { const v = b.dataset.side; const patch = v === 'bay' ? { shelf: null, placement: 'bottom-bay', side: undefined } : { shelf: null, placement: 'side-mount', side: v, mountHeight: it.mountHeight || 1.45 }; patchDef(rec.id, patch); rebuildAll(); select(rec.id, { keepCamera: true }); });
    const un = $('#eUnplace'); if (un) un.onclick = () => { patchDef(rec.id, { setup: null, shelf: null, placement: undefined, storage: undefined, pos: undefined }); rebuildAll(); select(rec.id, { keepCamera: true }); toast('Item unplaced — find it under Unplaced', 'ok'); };
    const dr = $('#dRack'); if (dr) dr.onchange = () => { patchDef(rec.id, { dcimRack: dr.value || null, dcimMappingConfidence: 'medium' }); rebuildAll(); select(rec.id, { keepCamera: true }); toast(`${rec.id} → ${dr.value || 'no DCIM rack'}`, 'ok'); };
    const sv = $('#eSave'); if (sv) sv.onclick = () => {
      const patch = { status: $('#eStatus').value, notes: cleanNotes($('#eNotes') ? $('#eNotes').value : def.notes) };
      if ($('#eName')) patch.name = $('#eName').value.trim() || def.name;
      const ownerKey = rec.cat === 'item' ? dcimOwnerKey(it) : null; const owner = $('#eOwner') ? $('#eOwner').value.trim() || null : null;
      if (rec.cat === 'item') {
        patch.type = $('#eType').value; if (!ownerKey) patch.owner = owner;
        const pdu = $('#ePdu').value, outlet = parseInt($('#eOutlet').value, 10);
        if (pdu) { const pd = (S.data.dcim?.pdus || []).find(x => x.id === pdu); patch.dcim = { ...(it.dcim || {}), pdu, pduName: pd?.name, outlet: isNaN(outlet) ? undefined : outlet, optKey: optKey(patch.name) }; }
        else if (it.dcim) { const { pdu: _p, pduName: _n, outlet: _o, ...rest } = it.dcim; patch.dcim = Object.keys(rest).length ? rest : undefined; }
      }
      patchDef(rec.id, patch); rebuildAll(); select(rec.id, { keepCamera: true }); toast('Saved — press “Save to server” when done', 'ok');
      if (ownerKey && owner !== (it.owner || null)) saveDcimOwner(ownerKey, owner).then(() => toast('Owner saved in Lab Manager', 'ok')).catch(e => toast('Owner not saved: ' + e.message, 'err'));
    };
    const rp = $('#eReplace'); if (rp) rp.onclick = () => {
      const name = prompt('Name of the NEW device (the old one is kept as “dismantled” history):', it.name); if (!name) return;
      const n = { ...JSON.parse(JSON.stringify(it)), id: nextItemId(), name, status: 'building', confidence: 'high', placementConfidence: 'high', photos: [], notes: `Replaced ${it.name} (${it.id}) on ${new Date().toISOString().slice(0, 10)}.` };
      if (n.dcim) n.dcim.optKey = optKey(name); delete n.live; delete n.effStatus; delete n.liveWarning; delete n.unmappedRack;
      S.data.items.push(n);
      patchDef(rec.id, { status: 'dismantled', setup: null, shelf: null, placement: undefined, storage: undefined, pos: undefined, notes: (cleanNotes(it.notes) + ` Replaced by ${n.id} (${name}) on ${new Date().toISOString().slice(0, 10)}.`).trim() });
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
  function rackTelemetry(su, live = S.live) {
    const rack = su.dcimRack; if (!live.connected || !rack) return null;
    const pdus = (live.devices || []).filter(d => d.kind === 'pdu' && (d.rack === rack || (d.notes || '').split(',').map(x => x.trim()).includes('shared:' + rack)));
    if (!pdus.length) return null;
    let watts = 0, amps = 0, volts = 0, n = 0, on = 0, total = 0, temp = null, hum = null, leak = false, reach = 0, any = false, known = 0, partial = false, ampsPartial = false, estimated = false;
    pdus.forEach(p => {
      const st = (live.pdu || {})[p.id];
      if (!st) { partial = ampsPartial = true; return; }
      any = true;
      if (!st.reachable) { partial = ampsPartial = true; return; }
      reach++;
      if (st.inlet_voltage != null) { volts += st.inlet_voltage; n++; }
      if (st.total_watts != null) { watts += st.total_watts; known++; }
      if (st.watts_complete !== true) partial = true;
      const readings = st.inlet_readings || [];
      if (readings.length && readings.every(i => i.current != null)) {
        amps += readings.reduce((sum, i) => sum + i.current, 0);
      } else if (st.total_watts != null && st.watts_complete === true) {
        amps += st.total_watts / (st.inlet_voltage > 0 ? st.inlet_voltage : 208); estimated = true;
      } else { ampsPartial = true; }
      (st.outlets || []).forEach(o => { total++; if (o.state === 'on') on++; });
      if (st.temperature != null) temp = temp == null ? st.temperature : Math.max(temp, st.temperature);
      if (st.humidity != null) hum = hum == null ? st.humidity : Math.max(hum, st.humidity);
      if (st.leak_detected) leak = true;
    });
    if (!any) return { loading: true };
    return { watts: known ? watts : null, amps: ampsPartial ? null : amps, partial, estimated, volts: n ? volts / n : null, cap: ampsPartial ? null : amps / (RATED_AMPS * pdus.length), on, total, temp, hum, leak, reachable: reach > 0, pduCount: pdus.length };
  }
  function updateTelemetry() {
    let tSum = 0, tN = 0, hSum = 0, hN = 0, tMin = null, tMax = null, leaks = [], kwTot = 0, kwKnown = 0, kwPartial = false;
    for (const rec of S.recs.values()) {
      if (rec.cat !== 'setup' || !rec.telem) continue;
      const t = rackTelemetry(rec.def);
      const lt = rec.labelTel;
      if (!t || t.loading || !t.reachable) {
        if (t) kwPartial = true;
        rec.telem.className = 'telem dim'; rec.telem.innerHTML = `<span class="t-muted">${!t ? (S.live.connected ? (rec.def.dcimRack ? 'no PDU' : 'unmapped') : '—') : t.loading ? '…' : 'PDU offline'}</span>`;
        if (lt) { lt.className = 'lt' + (t && !t.loading ? ' off' : ' muted'); lt.textContent = !S.live.connected ? '' : !t ? (rec.def.dcimRack ? 'no PDU' : 'unmapped') : t.loading ? '…' : 'PDU offline'; }
        rec.heatPatch.visible = false; rec.leakRing.visible = false; continue;
      }
      if (t.watts != null) { kwTot += t.watts; kwKnown++; }
      if (t.partial) kwPartial = true;
      if (t.temp != null) { tSum += t.temp; tN++; tMin = tMin == null ? t.temp : Math.min(tMin, t.temp); tMax = tMax == null ? t.temp : Math.max(tMax, t.temp); }
      if (t.hum != null) { hSum += t.hum; hN++; }
      if (t.leak) leaks.push(rec.def.dcimRack || rec.id);
      const capPct = Math.round(t.cap * 100); const capCls = t.cap > .95 ? 'bad' : t.cap > .8 ? 'warn' : 'ok';
      rec.telem.className = 'telem' + (t.leak ? ' leak' : capCls === 'bad' ? ' bad' : capCls === 'warn' ? ' warn' : '');
      rec.telem.innerHTML = `<div class="t-row"><b class="t-kw">${t.watts == null ? '\u2014' : (t.watts / 1000).toFixed(2)}${t.partial ? ' (partial)' : ''}</b><span class="t-u">kW</span><span class="t-sep"></span><span class="t-v">${t.volts == null ? '\u2014' : t.volts.toFixed(0) + ' V'}</span><span class="t-sep"></span><span class="t-v">${t.amps == null ? '\u2014' : (t.estimated ? '~' : '') + t.amps.toFixed(1) + ' A' + (t.estimated ? ' (estimate)' : '')}</span>${t.leak ? '<span class="t-leak">LEAK</span>' : ''}</div><div class="t-cap ${capCls}" title="${t.cap == null ? 'unknown / partial' : capPct + '% (estimate)'} of ${RATED_AMPS * t.pduCount} A · ${t.on}/${t.total} outlets on"><i style="width:${Math.min(100, capPct)}%"></i></div>`;
      if (lt) {
        lt.className = 'lt' + (t.leak || capCls === 'bad' ? ' bad' : capCls === 'warn' ? ' warn' : '');
        lt.title = `${t.partial ? 'partial reading — not every outlet reports watts · ' : ''}${t.cap == null ? 'load unknown' : capPct + '% of ' + RATED_AMPS * t.pduCount + ' A (estimate)'}`;
        lt.innerHTML = `<b>${t.watts == null ? '\u2014' : (t.partial ? '≥' : '') + (t.watts / 1000).toFixed(2)}</b> kW · ${t.amps == null ? '\u2014' : (t.estimated ? '~' : '') + t.amps.toFixed(1)} A<i class="lt-bar"><i style="width:${t.cap == null ? 0 : Math.min(100, capPct)}%"></i></i>${t.leak ? '<span class="lt-leak">LEAK</span>' : ''}`;
      }
      rec.heatPatch.visible = S.heat; rec.heatPatch.material.color.set(heatColor(t.temp)); rec.heatPatch.material.emissive.set(heatColor(t.temp));
      rec.leakRing.visible = !!t.leak;
    }
    // one environment window for the whole lab (average of all PDU sensors)
    const env = $('#envPanel'); if (!env) return;
    if (!S.envPanel || !S.live.connected || (tN === 0 && hN === 0 && !leaks.length)) { env.classList.add('hidden'); return; }
    const tAvg = tN ? tSum / tN : null, hAvg = hN ? hSum / hN : null;
    const tCls = tAvg == null ? '' : tAvg > 35 ? 'bad' : tAvg > 24 ? 'warn' : 'ok';
    env.className = 'envpanel' + (leaks.length ? ' leak' : tCls === 'bad' ? ' bad' : tCls === 'warn' ? ' warn' : '');
    env.innerHTML = `<div class="e-title">Lab environment <small>avg of ${tN || hN} sensor${(tN || hN) === 1 ? '' : 's'}</small></div>
      <div class="e-row"><span class="e-ic">🌡</span><b class="e-${tCls}">${tAvg == null ? '—' : tAvg.toFixed(1) + '°C'}</b>${tN > 1 ? `<small>${tMin.toFixed(1)}–${tMax.toFixed(1)}</small>` : ''}</div>
      <div class="e-row"><span class="e-ic">💧</span><b>${hAvg == null ? '—' : hAvg.toFixed(0) + '%'}</b><small>humidity</small></div>
      <div class="e-row"><span class="e-ic">${leaks.length ? '⚠' : '●'}</span><b class="${leaks.length ? 'e-bad' : 'e-ok'}">${leaks.length ? 'LEAK · ' + esc(leaks.join(', ')) : 'no leaks'}</b></div>
      <div class="e-row e-foot"><small>${kwKnown ? (kwTot / 1000).toFixed(2) + ' kW total' + (kwPartial ? ' (partial)' : '') : '\u2014'}</small></div>`;
  }
  $('#tHeat').onclick = () => { S.heat = !S.heat; LS.set('heat', S.heat); setPressed($('#tHeat'), S.heat); updateTelemetry(); };

  // ───────────────────────────────────────────────────────────── quick-jump rack bar + zoom buttons
  function renderRackBar() {
    const bar = $('#rackBar'); if (!bar || !S.data || !S.model) return;
    const byHealth = S.colorBy === 'health'; const issues = issuesOf(S.attention).filter(e => e.kind !== 'offline');
    const chip = su => {
      const h = rackHealth(su) || { h: 'unknown', why: '' }; const mine = issues.filter(e => e.setup === su.id); const c = attnCounts(mine);
      const on = S.front ? S.front === su.id : S.selected === su.id;
      const dot = byHealth ? `<span class="rb-dot h-${h.h}" aria-hidden="true"></span>` : `<span class="rb-dot" style="background:${STATUS_COLOR[su.status || 'unknown']}" aria-hidden="true"></span>`;
      const title = `${su.id} · ${su.name}${byHealth ? ' · ' + HEALTH[h.h].t + (h.why ? ' (' + h.why + ')' : '') : ''}${mine.length ? ` · ${mine.length} issue${mine.length === 1 ? '' : 's'}` : ''}`;
      return `<button type="button" class="rb${on ? ' on' : ''}${c.crit ? ' crit' : c.warn ? ' warn' : ''}" data-jump="${esc(su.id)}" aria-pressed="${on}" title="${esc(title)}">${dot}${esc(rackName(su))}${mine.length ? `<span class="rb-n"> · ${mine.length}</span>` : ''}</button>`;
    };
    const zones = S.data.zones.map(z => ({ label: rowLabel(z), setups: S.model.setups.filter(su => su.zone === z.id) })).filter(g => g.setups.length);
    const rest = S.model.setups.filter(su => !S.data.zones.some(z => z.id === su.zone)); if (rest.length) zones.push({ label: 'Racks', setups: rest });
    const st = S.data.storage.map(sd => { const on = S.selected === sd.id; return `<button type="button" class="rb store${on ? ' on' : ''}" data-jump="${esc(sd.id)}" aria-pressed="${on}" title="${esc(sd.id + ' · ' + sd.name)}">${esc(storageName(sd))}</button>`; }).join('');
    bar.innerHTML = zones.map(g => `<span class="rb-row">${esc(g.label)}</span>${g.setups.map(chip).join('')}`).join('') + (st ? `<span class="rb-row">Storage</span>${st}` : '');
    $$('[data-jump]', bar).forEach(b => b.onclick = () => {
      const id = b.dataset.jump; if (S.front && S.recs.get(id)?.cat === 'setup') { showRackFront(id); return; }
      select(id, { fly: true });
    });
  }
  function zoomBy(f) { markView(null); const dir = camera.position.clone().sub(controls.target); const len = Math.min(controls.maxDistance, Math.max(controls.minDistance, dir.length() * f)); dir.setLength(len); tweenCamera(controls.target.clone().add(dir), controls.target.clone(), 250); }
  $('#zIn').onclick = () => zoomBy(0.7); $('#zOut').onclick = () => zoomBy(1.4);   // rotate with a drag, pan with the arrow keys or a right drag
  window.addEventListener('keydown', e => { if (e.target !== canvas && e.target !== document.body) return; const k = e.key; if (k === 'ArrowLeft') panBy(-1, 0); else if (k === 'ArrowRight') panBy(1, 0); else if (k === 'ArrowUp') panBy(0, 1); else if (k === 'ArrowDown') panBy(0, -1); else return; e.preventDefault(); });

  // ───────────────────────────────────────────────────────────── toasts / tabs
  function toast(msg, cls = '') { const t = document.createElement('div'); t.className = 'toast ' + cls; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3200); }
  $$('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab === 'tree' ? 'racks' : b.dataset.tab));

  // ───────────────────────────────────────────────────────────── boot
  function init(data) {
    if (!window.DCIM_CAN_OPERATE) S.editMode = false;
    // a browser draft is only restored if it was made on top of THIS exact dataset (otherwise a newer lab-data.json would be hidden by stale edits)
    S.dataBase = dataFingerprint(data);
    // what the server holds right now (before any browser draft is applied): the stale-save check compares against it
    S.serverStamp = location.protocol.startsWith('http') && !window.LAB_DATA ? dataStamp(data) : null;
    const draft = LS.get('draft', null);
    if (draft && draft.data && draft.data.meta && draft.base === S.dataBase) { data = draft.data; S.dirty = true; setTimeout(() => toast('Restored unsaved edits from this browser — Save or Discard', 'ok'), 800); }
    else if (draft) { LS.set('draft', null); if (draft.data) setTimeout(() => toast('lab-data.json changed on the server — old unsaved browser edits were dropped', 'err'), 800); }
    S.data = data; $('#ver').textContent = `twin v${data.meta.version} · ${data.meta.generated}`;
    document.title = `${data.meta.title} — Lab Manager`;
    setupFilterUI(); buildStatic(); computeModel(); buildItems();
    setLabelMode(LS.get('labelMode', 'setups'), true); updateSaveBar();
    document.body.classList.toggle('embed', S.embed); document.body.classList.toggle('kiosk', S.kiosk); $('#btnKiosk').classList.toggle('on', S.kiosk); if (S.kiosk) $('#btnKiosk').textContent = 'Leave lab screen mode'; document.body.classList.toggle('editmode', S.editMode); markEdit(); applyLook(); renderLegend();
    resize(); controls.maxDistance = Math.max(25, Math.hypot(S.data.room.width, S.data.room.depth, S.data.room.height) * 5);
    camera.far = controls.maxDistance + 50; camera.updateProjectionMatrix();
    VIEWS.orbit(); camera.position.copy(S.tween.p1); controls.target.copy(S.tween.t1v); S.tween = null; controls.update();
    previousCamera.copy(camera.position); previousTarget.copy(controls.target); markView('orbit');
    const racksList = S.racksList; setSheet('half', 'issues'); showTab(LS.get('sideTab', 'attn')); setRacksList(racksList); placeAttnDock();
    setInterval(renderLive, 1000);
    animate();
    const auto = S.settings.url || location.protocol.startsWith('http') || window.LAB_DEMO; // same-origin when served from the backend (LAB_DEMO = simulated backend in the preview bundle)
    if (S.settings.url) connect(); else if (auto) { api('/api/version').then(() => connect()).catch(() => {}); }
  }
  // debug handle (console): __twin.select('SETUP-003'), __twin.S.model.items …
  window.__twin = { S, scene, camera, controls, renderer, select, closeDetail, flyTo, planFlight, safeArea, setView, connect, disconnect, refreshStatuses, computeModel, buildItems, VIEWS, finishMove, requestMove, movePlan, startMove, cancelMove, resolveMoveTarget, pickAt, toggleEdit, toggleKiosk, computeAttention, renderAttention, focusAttention, showTab, itemHealth, rackHealth, rowLabel, renderRackFront, showRackFront, hideRackFront, setColorBy, setSheet, paint, pingKey, feedsOf };
  const boot = window.LAB_DATA ? Promise.resolve(window.LAB_DATA) : fetch('lab-data.json', { cache: 'no-store' }).then(r => { if (!r.ok) throw Object.assign(new Error(r.status), { status: r.status }); return r.json(); });
  Promise.all([boot, window.DCIM_ACCOUNT_READY]).then(([data]) => init(data)).catch(err => {
    console.warn('lab-data.json fetch failed:', err);
    if (err.status === 401) {   // accounts mode: the inventory file is only served to a signed-in session
      const fb = $('#loadFallback'); $('.modal-h', fb).textContent = 'Sign in required';
      $('.modal-b', fb).innerHTML = '<p>The Digital Twin shows the lab inventory only to signed-in users.</p><p>Sign in to Lab Manager, then reload this page.</p><p><a class="btn btn-primary" href="/" target="_top">Open Lab Manager</a> <button class="btn" type="button" id="fbReload">Reload</button></p>';
      $('#fbReload').onclick = () => location.reload();
      fb.classList.remove('hidden'); pill('error', 'Signed out · sign in to view'); return;
    }
    $('#loadFallback').classList.remove('hidden');
    $('#fileJson').onchange = e => { const f = e.target.files[0]; if (!f) return; f.text().then(t => { $('#loadFallback').classList.add('hidden'); init(JSON.parse(t)); }).catch(er => toast('Invalid JSON: ' + er.message, 'err')); };
  });
})();
