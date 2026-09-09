# Lab 204 Digital Twin — project notes for Claude / new sessions

Standalone Three.js (r128, classic scripts, **no build step**) app served by the Lab Manager FastAPI backend at `/twin/`.
Repo: `aizyaguev-bot/DCIM-204`, folder `lab-twin/`. Production: VM `yokbvdiprd955`, `~/DCIM-204`, uvicorn on :8000 (venv: `backend/.venv`).

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
- Backend endpoints used: `/api/devices/`, `/api/rack-slots`, `/api/switch-assignments`, `/api/opt-owners`, `/api/rack-items`, `/api/chillers`, `/api/rack-overrides`, `/api/pdus/{id}/status`, `POST /api/pdus/{id}/outlets/{n}/power`, `/api/kvms/{id}/status`, `/api/kvms/{id}/autologin?port=N`, `GET/PUT /api/twin-data`. No IPs/credentials in this folder — ever.
- Shelf rule (v0.3.x, from the Lab Manager rack view): ONE PC per shelf (`type: opt` = upright mini-tower, left slot) + ONE Lab Manager *rack item* on the right (`equip-switch` = switch under test rendered as an NVIDIA-style 1U switch; `equip-ups`, `equip-other` = generic box). U01 = top shelf. Outlet labels like "empty" / "KVM Power" are filtered by `NON_SERVER_LABEL`. When connected, live rack items are authoritative: JSON `equip-*` with the same name, or on a shelf that has a live rack item, are dropped (no doubles). `switch-assignments` (mgmt switch·port) is only shown as text on the PC.
- Moving devices: Edit mode → **drag** a device onto a shelf / rack / storage (or Move button → tap). Each shelf has an invisible `slot` volume (`srec.slot`) shown cyan while moving; `resolveMoveTarget()` maps any hit (item / rack post / slot) to the shelf at that height. OPTs known to the DCIM and `LIVE-` rack items are moved by writing `rack-slots` + `rack-overrides` + `rack-positions` / `rack-items` back to Lab Manager (`dcimMove`), because `computeModel()` derives their shelf from the DCIM U slot (`shelfForU` / `shelfToU`).
- Camera controls: custom `WalkControls` (not OrbitControls): one finger / left-drag = look around from where you stand (scene follows the finger), two fingers / right-drag = slide along the floor, pinch / wheel = step along the view; looking straight down (Top view) one finger slides. Keeps the `.target` API so `tweenCamera/flyTo/zoomBy/rotateBy/panBy` work unchanged. Tap in 3D flies only to racks; any touch cancels a running tween.
- Camera: `clampToRoom()` is rigid (target clamped, camera follows by the same delta, then slides toward the target if still outside); `panBy()` moves camera+target along the floor (◀ ▶ ▲ ▼ buttons / arrow keys).
- Same-origin auto-connect; `?embed=1` hides the brand (used by the React tab), `?kiosk=1` = lab screen mode.

## Dev loop
1. Edit files here. Preview: `start-twin.bat` (Python http.server on :8090) or open `../lab-twin-standalone.html` equivalent by bundling.
2. Sanity: `node --check app.js`.
3. Ship: `git add lab-twin && git commit -m "..." && git push` (from the repo root), then on the VM `cd ~/DCIM-204 && git pull` — static files are served from disk, **no restart needed**; hard-refresh the browser. Restart only if `backend/app/main.py` changed:
   `pkill -f "uvicorn app.main:app"; sleep 1; cd backend && nohup .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/lab-manager.log 2>&1 &`

## Open items
- Physical rack ↔ `Rack-0X` mapping is provisional (low confidence) — fix in Edit mode → Save to server.
- `DOOR-02` (right wall) unverified; room size 4.0×5.6 m is an estimate.
- Frontend tab "3D Twin" (App.jsx iframe) requires `npm run build` in `frontend/`.
