# Lab 204 Digital Twin — project notes for Claude / new sessions

Standalone Three.js (r128, classic scripts, **no build step**) app served by the Lab Manager FastAPI backend at `/twin/`.
Deployment repo: `aizyaguev-bot/DCIM-204`, folder `lab-twin/`. Additional private copy: `A7asaf-cloud/DCIM-204-Lab-Manager`. Production: VM `yokbvdiprd955`, `~/DCIM-204`, uvicorn on :8000 (venv: `backend/.venv`).

## Files
- `index.html` — layout: header (search, Edit, Screen, Backend), stats bar, left sidebar (filters/legend/tree), 3D viewport (toolbar, rack bar, zoom buttons, save bar, move banner), right detail/editor panel, modals.
- `styles.css` — Lab Manager theme (NVIDIA green `#76b900` on zinc, JetBrains Mono). Sections: header, buttons, layout, detail, edit-mode (`.btn-lg`, `.chip-lg`), kiosk (`body.kiosk`), embed (`body.embed`).
- `app.js` — everything: scene/geometry (`buildRoom`, `buildRack`, `buildTrayRack`, `buildCabinet`, `buildItems`), effective model (`computeModel` = JSON + live DCIM), filters/search/tree, detail panel (`renderDetail`), touch editor (`renderEditor`, `startMove/finishMove`), live backend (`connect`, `refreshStatuses`, `outletAction`, `openKvm`), views/camera (`VIEWS`, `flyTo`, `zoomBy`), persistence (`markDirty`, `saveToServer` → `PUT /api/twin-data`, `downloadJson`).
- `lab-data.json` — **the inventory** (room, templates, structure, zones, setups=racks, shelves, storage, items, dcim seed). Edit this, never hard-code inventory in JS.
- `vendor/` — three.min.js + OrbitControls.js (local, lab has no internet). `photos/` — 4 source photos.
- `floorplan.svg` — 2D plan generated from the JSON (generator scripts live in the Cowork outputs of the original session; regenerate manually if positions change).

## Conventions
- Units: metres. Data axes: `x` across the room (0 = LEFT wall when standing at the entrance), `z` depth from the entrance wall, `y` up. The Three.js world is mirrored on x (`world.scale.x = -1`) so data-x grows to the viewer's right — use `WX()` for camera positions, `transformDirection(matrixWorld)` for directions.
- Rack local frame: front = +x local, width along z, `rot` = yaw degrees (0 → front faces +x, 90 → faces −z, 180 → faces −x).
- IDs: `Z01`, `SETUP-001`, `SHELF-01…28` (4 per rack, L1 = lowest), `STORAGE-01`, `ITEM-0001`. `LIVE-*` = objects that come from the DCIM backend only (not in JSON).
- Status colours: active green, building amber, inactive grey, dismantled rose, unknown dark grey — shown on edge outlines, LEDs and label dots (bodies use realistic colours from `TYPE_BODY`). Confidence: high solid, medium faded, low dashed.
- Backend endpoints used: `/api/devices/`, `/api/rack-slots`, `/api/switch-assignments`, `/api/opt-owners`, `/api/engineers`, `/api/rack-items`, `/api/chillers`, `/api/rack-overrides`, `/api/pdus/{id}/status`, `POST /api/pdus/{id}/outlets/{n}/power`, `/api/kvms/{id}/status`, `/api/kvms/{id}/autologin?port=N`, `GET/PUT /api/twin-data`. No IPs/credentials in this folder — ever.
- Shelf rule (v0.3.x, from the Lab Manager rack view): ONE PC per shelf (`type: opt` = upright mini-tower, left slot) + ONE Lab Manager *rack item* on the right (`equip-switch` = switch under test rendered as an NVIDIA-style 1U switch; `equip-ups`, `equip-other` = generic box). U01 = top shelf. Outlet labels like "empty" / "KVM Power" are filtered by `NON_SERVER_LABEL`. When connected, live rack items are authoritative: JSON `equip-*` with the same name, or on a shelf that has a live rack item, are dropped (no doubles). `switch-assignments` (mgmt switch·port) is only shown as text on the PC.
- Moving devices: Edit mode → select an object → **Move** → select the destination shelf / rack / storage. Camera drags never move equipment; Edit starts disabled on every load. Each shelf has an invisible `slot` volume (`srec.slot`) shown cyan while moving; `resolveMoveTarget()` maps any hit (item / rack post / slot) to the shelf at that height. OPTs known to the DCIM and `LIVE-` rack items are moved by writing `rack-slots` + `rack-overrides` + `rack-positions` / `rack-items` back to Lab Manager (`dcimMove`), because `computeModel()` derives their shelf from the DCIM U slot (`shelfForU` / `shelfToU`).
- Camera controls: official `THREE.OrbitControls` matching bundled Three.js r128; left drag or one finger orbits around a fixed target, right drag pans in the screen plane, wheel or two-finger pinch zooms. Moderate sensitivity, light damping, fixed Y up and bounded polar angles/distance. Hover does not move the camera. Canvas clicks select without flying; explicit Focus, Reset and Fit Lab buttons recover the view. Hebrew usage instructions appear below the viewport.
- Camera lifecycle: one controller owns navigation; capture/release pointers, cancel on blur, pointer cancel, outside release and resize. The small vendor `cancel()` extension only clears gesture listeners and residual motion, leaving the upstream camera algorithm intact. Pointer input cancels camera tweens. Kiosk mode does not rotate automatically. Target bounds translate camera and target together; a swept ray prevents zoom/pan crossing equipment surfaces. Labels live in their own stacking context below UI controls.
- Same-origin auto-connect; `?embed=1` hides the brand (used by the React tab), `?kiosk=1` = lab screen mode.
- Inventory synchronization: while connected with auto-refresh enabled, reload the same DCIM inventory endpoints every 15 seconds, including rack items, positions, labels, owners, engineers, switch assignments and chillers. Keep the last successful value when an endpoint fails; discard responses from a disconnected/replaced backend session.
- Equipment SN: `serial_number` belongs to the existing rack item, so it follows the device when moved. The live Twin reads it from `/api/rack-items`, displays it in Identity and includes it in search. For photo mapping updates, maintain the corresponding existing `lab-data.json` equipment record as the Git/offline copy and verify the live record after saving. User shelf 1 = top (U01), shelf 4 = bottom (U04); Twin geometric level is the reverse. Do not match devices by name alone.
- Barcode tracking: rack items also carry `barcode`, `shelf_position`, `last_seen_at` and server-managed `tracking_history`. GET `/api/rack-items` returns an ETag; all PUTs must send it as `If-Match` and use the returned saved mapping. Preserve those fields when moving or editing. The React Scan & Track tab and Twin share the same records. A U outside the mapped physical shelf count is unplaced rather than wrapping to another shelf. See `../docs/barcode-scanning.md`.

## Dev loop
1. Edit files here. Preview: `start-twin.bat` (Python http.server on :8090) or open `../lab-twin-standalone.html` equivalent by bundling.
2. Sanity: `node --check app.js`.
3. Ship the tested frontend build and backend changes together with the pinned `scripts/install-monitoring.py` installer. It backs up inventory, checks startup and restarts the app safely. See `../docs/navigation-and-owners.md`; avoid ad hoc process termination on the VM.

## Open items
- Physical rack ↔ `Rack-0X` mapping is provisional (low confidence) — fix in Edit mode → Save to server.
- `DOOR-02` (right wall) unverified; room size 4.0×5.6 m is an estimate.
- Frontend tab "3D Twin" (App.jsx iframe) requires `npm run build` in `frontend/`.
