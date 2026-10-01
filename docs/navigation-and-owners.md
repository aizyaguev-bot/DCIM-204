# Navigation, ownership and monitoring update

## Twin navigation

The previous custom camera controller picked a different rotation pivot beneath
each pointer-down and projected pan onto the floor. Near-horizontal projections
and a second camera clamp could abruptly change the camera position/distance.
Equipment drag could start after camera movement, and gesture cancellation did
not consistently stop document listeners or view tweens.

The viewer now uses the bundled official OrbitControls matching Three.js r128.
One controller handles rotation, screen pan and bounded zoom, with fixed Y up,
moderate speed and light damping. Camera bounds translate the target and camera
together, and a swept ray prevents navigation from crossing equipment surfaces.
Pointer capture, outside release, cancellation and window blur clear input and
residual deltas. UI layers sit above labels, and controls do not receive menu
input. Hover and kiosk idle time cause no camera movement.

Canvas clicks select without moving the camera. Reset View, Fit Lab and Focus
Selection provide explicit recovery. Editing starts disabled; moving equipment
requires Edit, selection, Move and a destination. Existing placement persistence,
inventory and device actions remain in use. Hebrew instructions describe mouse
navigation next to the scene.

## Engineers and monitor names

Admins manage engineers independently of login accounts. The directory starts
with the ten requested names. Operators select an active engineer for an asset.
Assignments use engineer IDs, so renaming a directory entry updates the owner
display; disabling an engineer preserves existing assignments. Legacy names
remain visible. New single-asset writes preserve unrelated ownership. Existing
JSON ownership and equipment data remain intact as migration fallbacks; cleared
assignments retain a database tombstone so old names do not reappear.

Monitoring names follow current inventory immediately. Details allows a display
alias or a return to automatic synchronization. A global server rename or
cascading port label edit retains monitor ID, history, address override, pause
state and owner. Aliases do not change the device port association.

## PDU failures and KVM sign-in

The former monitoring timeout allowed only 12 seconds for an entire multi-outlet
PDU read, and discarded error details. PDU reads now allow 45 seconds (KVM: 20).
HTTP request timeouts are distinguished from connection errors even when the
underlying exception has no message. Failed checks store a safe explanation
without response bodies or credentials, clear it on recovery and display it in
the monitoring table. This does not establish which cause affects any particular
live PDU; check again on the VM for the current observation.

KVM sign-in obtains a fresh console session on the server and redirects to the
site's existing HTTP/WebSocket proxy. Browser traffic stays on the site's origin;
the browser does not need to visit the KVM certificate warning page. The proxy
handles already-rewritten URLs once, compressed assets, binary/text messages,
selected subprotocols and peer disconnect cleanup. Saved device credentials and
KVM console permissions are still required.

## Verification and deployment

- Full backend/installer suite: 273 tests passed, excluding physical KVM tests.
  Final PDU timeout adjustment: 38 related tests passed, including a new regression.
- Production frontend build passed. Syntax/compile checks passed.
- Actual browser mouse tests passed: short/long orbit, screen pan, fast zoom,
  hover, outside release, blur, resize, UI buttons, fit/reset/focus, real object
  picking, collision-limited zoom and explicit Move surviving inventory refresh.
  Navigation made no inventory writes or unintended equipment changes.
- Browser owner and monitor tests passed: directory selection, legacy names,
  reload, engineer rename/deactivation, display alias/automatic reset, visible
  failed-PDU detail, embedded Twin and Viewer restrictions. No JavaScript errors.
- KVM protocol tests passed using simulated connections; no live KVM console,
  lab network outage or SMTP delivery was induced. See `tests/browser/README.md`.

The repositories contain the built UI. Deployment continues from
`aizyaguev-bot/DCIM-204`; `A7asaf-cloud/DCIM-204-Lab-Manager` is an additional
private copy. Use the original repository's pinned installer on the existing
VM checkout; it preserves runtime inventory and backs it up before updating.
The VM project, deployment source and runtime data remain in their original locations.
Live KVM video/input, hardware reachability and any SMTP settings still need
verification in the lab. The site URL remains http://ftlab.nvidia.com:8000/.
