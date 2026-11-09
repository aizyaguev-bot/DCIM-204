/* Lab Twin map navigation (Google Maps style) for Three.js r128, classic script, no build step.
 *
 * The one camera controller of the twin. Mouse: left drag pans across the floor (the floor point under the pointer
 * stays under the pointer), right / middle drag (or Ctrl / Shift / Alt + left drag) rotates and tilts around the
 * target point, the wheel zooms towards the point under the pointer. Touch: one finger pans, two fingers pinch-zoom
 * about their midpoint, twist to rotate, and push both up / down together to tilt.
 *
 * The camera never rolls: it always looks at `target` with world Y up. User rotation keeps the polar angle inside
 * [minPolarAngle, maxPolarAngle] (never under the floor or over the top), user zoom keeps the distance inside
 * [minDistance, maxDistance]. Release keeps a short, decaying inertia; prefers-reduced-motion (enableDamping = false)
 * turns inertia and wheel smoothing off. Camera tweens and app constraints may write camera.position / target
 * directly between frames; update() works from whatever they are.
 *
 * Events: 'start' / 'end' around a gesture, 'change' whenever this controller itself moved the camera (never for
 * app tweens), so the app can leave a view preset only on real user movement.
 */
/* global THREE */
(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const Y = new THREE.Vector3(0, 1, 0);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const INERTIA_S = 0.16;          // inertia time constant (s)
  const ZOOM_S = 0.07;             // wheel smoothing time constant (s)
  const SAMPLE_MS = 90;            // pointer samples used for the release velocity
  const STILL_MS = 70;             // a pointer that rested this long before release gets no inertia

  class LabMapControls extends THREE.EventDispatcher {
    constructor(camera, domElement) {
      super();
      this.object = camera; this.domElement = domElement;
      this.target = new THREE.Vector3();
      this.enabled = true; this.enablePan = true; this.enableRotate = true; this.enableZoom = true;
      this.enableDamping = true;
      this.minDistance = 0.8; this.maxDistance = 35;
      this.minPolarAngle = 0.02; this.maxPolarAngle = 1.5;
      this.rotateSpeed = 0.5;        // a drag over the full view height turns rotateSpeed × 2π
      this.zoomSpeed = 1;
      this.groundY = 0;              // the floor the target sits on
      this.groundBounds = null;      // THREE.Box3: a grounded target must land inside it
      this._pointers = new Map();    // pointerId → { x, y, type }
      this._gesture = null;          // { kind: 'pan' | 'rotate' | 'touch', ... }
      this._samples = [];            // recent movement for the release velocity
      this._vel = { pan: new THREE.Vector3(), theta: 0, phi: 0 };
      this._zoom = { log: 0, anchor: null };
      this._last = performance.now();
      this._ray = new THREE.Raycaster(); this._ndc = new THREE.Vector2();
      this._bind();
    }

    // ── geometry helpers
    getDistance() { return this.object.position.distanceTo(this.target); }
    _spherical() { return new THREE.Spherical().setFromVector3(this.object.position.clone().sub(this.target)); }
    getPolarAngle() { return this._spherical().phi; }
    getAzimuthalAngle() { return this._spherical().theta; }
    _rect() { return this.domElement.getBoundingClientRect(); }
    _rayAt(x, y) {
      const r = this._rect(); this.object.updateMatrixWorld();
      this._ndc.set(((x - r.left) / Math.max(1, r.width)) * 2 - 1, -((y - r.top) / Math.max(1, r.height)) * 2 + 1);
      this._ray.setFromCamera(this._ndc, this.object); return this._ray.ray.clone();
    }
    // The point where the pointer ray meets the horizontal plane through the target, or null when that is badly
    // conditioned (near the horizon or far beyond the view): such a point would turn a pixel into metres of travel.
    _groundAt(x, y, planeY = this.target.y) {
      const ray = this._rayAt(x, y); const dy = ray.direction.y;
      if (dy > -0.08) return null;
      const t = (planeY - ray.origin.y) / dy; if (!(t > 0)) return null;
      if (t > 3 * this.getDistance() + 3) return null;
      return ray.origin.clone().addScaledVector(ray.direction, t);
    }
    // Move the target (only) along the line of sight down to the floor, so rotation pivots on the floor point in the
    // middle of the view. The view itself does not change. Kept where the line of sight misses the floor area.
    groundTarget() {
      const cam = this.object.position, t = this.target;
      if (Math.abs(t.y - this.groundY) < 1e-6) { t.y = this.groundY; return true; }
      const dir = t.clone().sub(cam); const len = dir.length(); if (len < 1e-6) return false; dir.divideScalar(len);
      if (dir.y > -0.12) return false;
      const k = (this.groundY - cam.y) / dir.y; if (!(k > 0)) return false;
      const p = cam.clone().addScaledVector(dir, k);
      if (k > this.maxDistance * 0.98) return false;
      if (this.groundBounds && !this.groundBounds.containsPoint(p)) return false;
      t.copy(p); t.y = this.groundY; return true;
    }

    // ── camera operations (each one moves camera and/or target and reports 'change')
    translate(d) { if (d.lengthSq() < 1e-14) return; this.object.position.add(d); this.target.add(d); this._changed(); }
    // Orbit around the target: theta = azimuth, phi = polar angle from straight down.
    rotate(dTheta, dPhi) {
      const off = this.object.position.clone().sub(this.target); const s = new THREE.Spherical().setFromVector3(off);
      // never jump: a camera that a view preset put outside the limits may only move back towards them
      const lo = Math.min(this.minPolarAngle, s.phi), hi = Math.max(this.maxPolarAngle, s.phi);
      s.theta += dTheta; s.phi = clamp(s.phi + dPhi, lo, hi); s.makeSafe();
      off.setFromSpherical(s); this.object.position.copy(this.target).add(off); this._changed();
    }
    // Turn camera and target about the vertical axis through `pivot` (two-finger twist).
    rotateAround(pivot, angle) {
      if (!angle) return;
      this.object.position.sub(pivot).applyAxisAngle(Y, angle).add(pivot);
      this.target.sub(pivot).applyAxisAngle(Y, angle).add(pivot); this._changed();
    }
    // Scale camera and target about `anchor` by `s` (< 1 zooms in). Points on the line through the camera and the
    // anchor stay where they are on screen, so the thing under the pointer stays under the pointer.
    zoomAbout(anchor, s) {
      const r = this.getDistance(); if (r < 1e-9) return 1;
      const k = clamp(s, this.minDistance / r, this.maxDistance / r); if (Math.abs(k - 1) < 1e-9) return k;
      const a = anchor || this.target;
      this.object.position.sub(a).multiplyScalar(k).add(a);
      this.target.sub(a).multiplyScalar(k).add(a); this._changed(); return k;
    }
    _changed() { this._moved = true; }
    _metresPerPixel() { const r = this._rect(); return 2 * this.getDistance() * Math.tan(THREE.MathUtils.degToRad(this.object.fov) / 2) / Math.max(1, r.height); }
    _horizontalAxes() {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.object.quaternion); right.y = 0;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.object.quaternion); fwd.y = 0;
      if (right.lengthSq() < 1e-10) right.set(1, 0, 0); if (fwd.lengthSq() < 1e-10) fwd.crossVectors(Y, right);
      return { right: right.normalize(), fwd: fwd.normalize() };
    }
    // Pan by a pointer movement. Anchored: the floor point grabbed at the start stays under the pointer. Where the
    // pointer ray is near the horizon, a bounded scaled pan is used instead, and the grab point is taken again.
    _panStep(g, x, y, px, py) {
      let d = null;
      if (g.grab) { const p = this._groundAt(x, y, g.grab.y); if (p) d = g.grab.clone().sub(p).setY(0); }
      if (!d) {
        g.grab = null;   // taken again below, at the new camera position, so going back to anchored never jumps
        const m = this._metresPerPixel(); const { right, fwd } = this._horizontalAxes();
        const tilt = Math.min(2.5, 1 / Math.max(0.4, Math.cos(this.getPolarAngle())));
        d = right.multiplyScalar(-(x - px) * m).addScaledVector(fwd, (y - py) * m * tilt);
      }
      const cap = Math.max(0.5, this.getDistance() * 0.6); if (d.length() > cap) d.setLength(cap);
      this.translate(d);
      if (!g.grab) g.grab = this._groundAt(x, y);
      return d;
    }
    _rotateStep(dx, dy) {
      const h = Math.max(1, this._rect().height);
      const dT = -TAU * dx / h * this.rotateSpeed, dP = -TAU * dy / h * this.rotateSpeed;
      if (this.enableRotate) this.rotate(dT, dP);
      return { dT, dP };
    }

    // ── input
    _bind() {
      const el = this.domElement; const win = el.ownerDocument.defaultView || window;
      this._onDown = e => this._pointerDown(e);
      this._onMove = e => this._pointerMove(e);
      this._onUp = e => this._pointerUp(e);
      this._onWheel = e => this._wheel(e);
      this._onMenu = e => { if (this.enabled) e.preventDefault(); };
      el.addEventListener('pointerdown', this._onDown);
      win.addEventListener('pointermove', this._onMove);
      win.addEventListener('pointerup', this._onUp);
      win.addEventListener('pointercancel', this._onUp);
      el.addEventListener('wheel', this._onWheel, { passive: false });
      el.addEventListener('contextmenu', this._onMenu);
      this._win = win;
    }
    dispose() {
      this.cancel(); const el = this.domElement, win = this._win;
      el.removeEventListener('pointerdown', this._onDown); win.removeEventListener('pointermove', this._onMove);
      win.removeEventListener('pointerup', this._onUp); win.removeEventListener('pointercancel', this._onUp);
      el.removeEventListener('wheel', this._onWheel); el.removeEventListener('contextmenu', this._onMenu);
    }
    // Stop everything at once: gesture, inertia and pending wheel zoom (blur, resize, view tweens, Move).
    cancel() {
      const had = !!this._gesture; this._pointers.clear(); this._gesture = null; this._samples = [];
      this._vel.pan.set(0, 0, 0); this._vel.theta = 0; this._vel.phi = 0; this._zoom.log = 0; this._zoom.anchor = null;
      if (had) this.dispatchEvent({ type: 'end' });
    }
    _stopMotion() { this._vel.pan.set(0, 0, 0); this._vel.theta = 0; this._vel.phi = 0; this._zoom.log = 0; this._zoom.anchor = null; }
    // Drop inertia and pending wheel zoom but keep a gesture going (the app stopped the camera in front of a rack).
    // Stops motion after a clamp. A pan in progress takes its grab point again at the corrected camera, so dragging
    // back moves at once instead of first retracing the part the clamp refused.
    halt() { this._stopMotion(); const g = this._gesture; if (g && g.grab !== undefined) g.grab = null; this._samples = []; }
    _pointerDown(e) {
      if (!this.enabled) return;
      if (e.pointerType !== 'touch' && ![0, 1, 2].includes(e.button)) return;
      if (e.pointerType === 'touch' && this._pointers.size >= 2) return;
      this._stopMotion();
      const first = !this._gesture;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (first) { this.groundTarget(); this.dispatchEvent({ type: 'start' }); }
      this._startGesture(e);
    }
    _startGesture(e) {
      this._samples = [];
      const pts = [...this._pointers.values()];
      if (e && e.pointerType !== 'touch') {
        const rotate = e.button === 2 || e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
        this._gesture = rotate ? { kind: 'rotate', x: e.clientX, y: e.clientY } : { kind: 'pan', x: e.clientX, y: e.clientY, grab: this._groundAt(e.clientX, e.clientY) };
        return;
      }
      if (pts.length === 1) { const p = pts[0]; this._gesture = { kind: 'pan', x: p.x, y: p.y, grab: this._groundAt(p.x, p.y) }; return; }
      const [a, b] = pts; const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this._gesture = { kind: 'touch', mode: null, mx, my, d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), sx: mx, sy: my, sd: Math.hypot(b.x - a.x, b.y - a.y), sang: Math.atan2(b.y - a.y, b.x - a.x), a0: { ...a }, b0: { ...b }, grab: this._groundAt(mx, my) };
    }
    _sample(pan, dT, dP) {
      const now = performance.now(); this._samples.push({ t: now, pan: pan ? pan.clone() : new THREE.Vector3(), dT, dP });
      while (this._samples.length && now - this._samples[0].t > SAMPLE_MS) this._samples.shift();
    }
    _pointerMove(e) {
      const p = this._pointers.get(e.pointerId); if (!p || !this._gesture) return;
      if (!this.enabled) { this.cancel(); return; }
      if (e.pointerType === 'mouse' && e.buttons === 0) { this._pointerUp(e); return; }   // released outside the window
      p.x = e.clientX; p.y = e.clientY;
      const g = this._gesture;
      if (g.kind === 'pan') {
        if (!this.enablePan) { g.x = p.x; g.y = p.y; return; }
        const d = this._panStep(g, p.x, p.y, g.x, g.y); g.x = p.x; g.y = p.y; this._sample(d, 0, 0);
      } else if (g.kind === 'rotate') {
        const r = this._rotateStep(p.x - g.x, p.y - g.y); g.x = p.x; g.y = p.y; this._sample(null, r.dT, r.dP);
      } else if (g.kind === 'touch') this._touchStep(g);
      this._afterInput();
    }
    _touchStep(g) {
      const [a, b] = [...this._pointers.values()]; if (!a || !b) return;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (!g.mode) {
        // decide once, after a little movement: both fingers pushed up / down together = tilt, anything else = map
        const ady = a.y - g.a0.y, bdy = b.y - g.b0.y, adx = a.x - g.a0.x, bdx = b.x - g.b0.x;
        const ma = Math.hypot(adx, ady), mb = Math.hypot(bdx, bdy), moved = Math.max(ma, mb);
        if (moved < 10) return;
        // Browsers send one pointermove per finger, so right after the first finger's event the other one has not
        // reported its move yet: wait until both fingers moved, or one moved far enough that the other is clearly
        // holding still (a one-finger-anchored pinch or twist), before deciding.
        if (Math.min(ma, mb) < 4 && moved < 24) return;
        const together = Math.sign(ady) === Math.sign(bdy) && Math.min(Math.abs(ady), Math.abs(bdy)) > 6;
        const vertical = Math.abs(ady + bdy) > 2 * Math.abs(adx + bdx);
        const pinch = Math.abs(d - g.sd), twist = Math.abs(ang - g.sang) * d / 2;
        g.mode = together && vertical && pinch < 12 && twist < 12 ? 'tilt' : 'map';
        g.mx = mx; g.my = my; g.d = d; g.ang = ang;
        if (g.mode === 'map') g.grab = this._groundAt(mx, my);
        return;
      }
      if (g.mode === 'tilt') {
        const r = this._rotateStep(0, my - g.my); this._sample(null, 0, r.dP);
      } else {
        let pan = null; if (this.enablePan) pan = this._panStep(g, mx, my, g.mx, g.my);
        const pivot = this._groundAt(mx, my) || this.target.clone();
        if (this.enableZoom) this.zoomAbout(pivot, g.d / d);
        let da = ang - g.ang; if (da > Math.PI) da -= TAU; if (da < -Math.PI) da += TAU;
        if (this.enableRotate) this.rotateAround(pivot, da);
        g.grab = this._groundAt(mx, my);
        this._sample(pan, this.enableRotate ? da : 0, 0);
      }
      g.mx = mx; g.my = my; g.d = d; g.ang = ang;
    }
    _pointerUp(e) {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.delete(e.pointerId);
      const g = this._gesture;
      if (this._pointers.size) {   // one finger of two lifted: carry on panning with the other, without a jump
        const rest = [...this._pointers.values()][0]; this._gesture = { kind: 'pan', x: rest.x, y: rest.y, grab: this._groundAt(rest.x, rest.y) }; this._samples = []; return;
      }
      this._gesture = null;
      if (g && e.type !== 'pointercancel') this._release(g);
      this._samples = [];
      this.dispatchEvent({ type: 'end' });
    }
    // Inertia from the last ~90 ms of movement, unless the pointer rested before it was released.
    _release(g) {
      const now = performance.now(); const s = this._samples;
      if (!this.enableDamping || !s.length || now - s[s.length - 1].t > STILL_MS) return;
      const span = Math.max(16, now - s[0].t + 16) / 1000;   // + one frame: pointer samples arrive at most once a frame
      const pan = s.reduce((v, x) => v.add(x.pan), new THREE.Vector3()).divideScalar(span);
      const cap = Math.max(1, this.getDistance() * 2.5); if (pan.length() > cap) pan.setLength(cap);
      this._vel.pan.copy(pan);
      if (g.kind === 'rotate' || (g.kind === 'touch' && g.mode === 'tilt')) {
        this._vel.theta = clamp(s.reduce((v, x) => v + x.dT, 0) / span, -3, 3);
        this._vel.phi = clamp(s.reduce((v, x) => v + x.dP, 0) / span, -2, 2);
      }
    }
    _wheel(e) {
      if (!this.enabled || !this.enableZoom) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const dy = clamp(e.deltaY * unit, -300, 300); if (!dy) return;
      if (!this._gesture) { this._vel.pan.set(0, 0, 0); this._vel.theta = 0; this._vel.phi = 0; }
      this.groundTarget();
      this.dispatchEvent({ type: 'start' });
      this._zoom.anchor = this._groundAt(e.clientX, e.clientY) || this.target.clone();
      this._zoom.log += dy * 0.0016 * this.zoomSpeed;
      if (!this.enableDamping) this._applyZoom(1);
      this.dispatchEvent({ type: 'end' });
    }
    _applyZoom(fraction) {
      const z = this._zoom; if (!z.log) return;
      let step = z.log * fraction; if (Math.abs(z.log - step) < 1e-4) step = z.log;
      const want = Math.exp(step), got = this.zoomAbout(z.anchor, want);
      z.log = Math.abs(got - want) > 1e-9 ? 0 : z.log - step;   // reached the near / far limit: drop the rest
      if (!z.log) z.anchor = null;
    }
    _afterInput() { this.update(true); }

    // Called every frame: inertia, wheel smoothing, then the camera looks at the target (world Y up, no roll).
    update(fromInput = false) {
      const now = performance.now(); const dt = clamp((now - this._last) / 1000, 0, 0.05); this._last = now;
      if (!fromInput && !this._gesture) {
        const v = this._vel;
        if (v.pan.lengthSq() > 0) {
          this.translate(v.pan.clone().multiplyScalar(dt)); v.pan.multiplyScalar(Math.exp(-dt / INERTIA_S));
          // stop once the rest of the glide is about a pixel (0.1 % of the viewing distance)
          if (v.pan.length() * INERTIA_S < 0.001 * Math.max(1, this.getDistance())) v.pan.set(0, 0, 0);
        }
        if (v.theta || v.phi) {
          this.rotate(v.theta * dt, v.phi * dt); const k = Math.exp(-dt / INERTIA_S); v.theta *= k; v.phi *= k;
          if (Math.abs(v.theta) * INERTIA_S < 1e-3) v.theta = 0; if (Math.abs(v.phi) * INERTIA_S < 1e-3) v.phi = 0;
        }
      }
      if (this._zoom.log) this._applyZoom(this.enableDamping ? 1 - Math.exp(-Math.max(dt, 1 / 120) / ZOOM_S) : 1);
      this.object.lookAt(this.target);
      if (this._moved) { this._moved = false; this.dispatchEvent({ type: 'change' }); return true; }
      return false;
    }
    // Animations / tests: is the controller still moving the camera on its own?
    get moving() { return !!(this._gesture || this._zoom.log || this._vel.pan.lengthSq() || this._vel.theta || this._vel.phi); }
  }

  THREE.LabMapControls = LabMapControls;
})();
