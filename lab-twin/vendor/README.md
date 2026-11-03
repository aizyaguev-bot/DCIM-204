Three.js and OrbitControls are bundled locally for use without Internet access.

Both files match upstream Three.js r128 (MIT):
https://github.com/mrdoob/three.js/tree/r128/examples/js/controls

OrbitControls retains its upstream navigation algorithm. The local `cancel()`
extension resets its pointer state, document listeners and accumulated deltas.
Mouse/touch end and dispose call it so release, window blur and cancellation do
not leave residual movement. `app.js` also invokes it before view tweens and
explicit object Move. Do not reintroduce a parallel mouse camera controller.
