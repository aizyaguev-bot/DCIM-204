# Lab Manager — Changelog

---

## v2.3.0 — 2026-07-16

### Changed
- **Rack diagram visual overhaul** — complete redesign of the rack chassis, slot rows, and server/equipment cells:
  - U row height 38 → 48 px; empty row height 14 → 20 px — more breathing room per slot
  - Overview rack width 320 → 400 px; detail view rack 420 → 520 px
  - **Left U-rail column** — dedicated dark column (10 px wide) with U number (zero-padded `01`/`02`…) and screw-dot markers flanking the number on occupied rows
  - **Rack screw dots** — top and bottom cap bars each show four small screw dots (two per side) giving a realistic chassis look
  - **Server cell left stripe** — 4 px vertical stripe whose color matches power state (NVIDIA-green / red / zinc) for at-a-glance status without reading text
  - **ON/OFF badge** — small right-aligned state label so servers are readable even when the LED dot is hard to see
  - **Equipment cell left stripe** — matches the equipment type color, same stripe pattern as server cells
  - **PDU footer** — larger bar (1.5 px), bold "POWER" label, uppercase tracking, more contrast
  - **Rack header** — monospace rack name in 13 px, bold "ONLINE/OFFLINE/NO PDU" status badge, tighter metadata line

---

## v2.2.0 — 2026-07-16

### Fixed
- **Equipment save** — previously the modal closed immediately even if the backend PUT failed (silently). Now the save is confirmed server-side before closing; errors are shown in the modal.
- **Panel close race condition** — storing server ID instead of full object eliminates the 15-second PDU poll race that re-opened closed panels.
- **KVM removed from DCIM** — KVM is room-level, not rack-mounted; removed from all DCIM tables, KPI bar, and rack detail.
- **Browser cache** — `index.html` is now served with `Cache-Control: no-cache` so a normal page refresh always loads the latest bundle.

### Changed
- **Rack diagram bigger and more detailed** — U row height increased from 28 → 38 px; overview rack width 270 → 320 px; detail view rack 330 → 420 px. Each server cell now shows a second line with switch name and wattage.
- **Equipment shows next to server at same U** — items at the same U level are laid out **side-by-side** in one row: `[U#] [grip] [Server] [Switch] [Patch Panel] …` instead of stacking vertically.
- **All panels use React portals** — modals render directly into `document.body`, immune to any CSS stacking context from parent components.

---

## v2.1.0 — 2026-07-15

### Fixed
- **Close window after pressing OPT** — all modals (Add OPT, Add Equipment, Edit Equipment, Server Edit Panel) now close on: backdrop click, X button, Cancel button, and ESC key. Added `useEscClose()` hook used in every panel/modal.

### Added
- **Drag handles to reorder OPTs** — each server row in the rack now has a ⠿ grip icon on the left. Drag only activates by holding the grip (not the whole row), so clicking a row still opens the edit panel.
- **Inline rename** — double-click any OPT name directly in the rack diagram to edit it in place. Press Enter to confirm, Escape to cancel, or click away to commit. Changes save to the PDU outlet label immediately.
- **Multiple items per U slot** — any U level can now hold a server plus additional equipment. Use the "+ Equipment" button (inside rack detail view) to add: Switch, Patch Panel, Cable Management, PDU, KVM, UPS, Blank Panel, or Other. Each item has a name, type, U slot, and optional notes. Items persist in `backend/rack_items.json` via the new `/api/rack-items` GET+PUT endpoints. Click any custom item row to open its edit/delete panel.
- **Changelog always updated** — `CHANGELOG.md` documents every release with a dated entry. The Changelog tab in DCIM reads it live from disk.

---

## v2.0.0 — 2026-07-16

### Fixed
- **Add OPT modal could not be closed** — modal was rendered inside the rack's DnD context (which applies CSS transforms), making `fixed` positioning unreliable. Moved modal rendering to the parent `RacksView` level, completely outside any transform or overflow container. X button, backdrop click, and Cancel all work correctly now.

### Added
- **Rack drill-down** — click the rack name (↗) in overview to open a full detail view for that rack
  - Breadcrumb back button: "← All racks / Rack-01"
  - Left: large rack diagram (320 px wide, 30 px per U slot)
  - Right: info grid (servers, power draw, PDU capacity, outlets on, KVM active, PDU status)
  - PDU list with IP addresses
  - KVM list
  - **Server table** — all servers in the rack with U slot, state, watts, outlet, PDU, switch, KVM columns; click any row to open the edit panel
  - **"+ Add OPT" button** inside the detail view

---

## v1.9.0 — 2026-07-16

### Changed
- **Visual rack diagram** — each rack is now drawn as a physical cabinet with U-numbered slots. Servers appear as coloured blocks at their exact U position: NVIDIA-green gradient when powered on, dark zinc when off. Empty slots render as subtle separator rows. Racks are displayed side by side in a horizontal scroll for easy comparison.
- **Rack chassis look** — outer left/right borders with ear-strip caps give each rack a hardware-panel feel. The footer shows a per-PDU power bar with live utilisation %.
- **Cleaner KPI bar** — compact inline strip (total kW, servers on/total, racks, KVM sessions, alerts) instead of card grid.
- **Inventory U column** — explicit U positions are now shown in the Inventory table alongside outlet and switch columns.

---

## v1.8.0 — 2026-07-15

### Added
- **Rack Unit (U level) editing** — click any server in the Rack view and type the exact U slot number in the "Rack Unit" field. Saves to `/api/rack-slots` (persists across restarts). The rack diagram shows empty dashed rows between servers to visualise gaps in the layout.
- **Network switch assignment** — each server now has a Switch name + Port number field in the edit panel. Saved to `/api/switch-assignments`. Assigned ports appear as a teal `SW·12` badge in the rack slot row and in the Inventory table.
- **Improved rack row UI** — each slot row shows the U-slot label, a coloured power rail (green glow when on), KVM badge (purple), switch badge (cyan), live wattage, and an online/offline dot. Empty slots render as subtle dashed spacer rows.
- **Larger + clearer edit panel** — renamed to full right-side slide-out; sections: Power Control (On/Off/Cycle), Rack Unit, Rename, Network Switch, Connection details, Remove.
- **New backend endpoints** — `/api/rack-slots` GET+PUT and `/api/switch-assignments` GET+PUT, both auth-bypassed, storing JSON files in the backend directory.

### Not changed
- Dashboard, PDU detail, KVM detail, Add Device
- All 53 unit tests passing

---

## v1.7.0 — 2026-07-15

### Added
- **Click any server in Racks view** → right-side edit panel slides in
  - Status dot (green/red/zinc) + live wattage
  - **Power On / Off / Cycle** buttons with spinner while action is in flight
  - **Rename** — pre-filled input, Save writes to the PDU's outlet labels immediately
  - **Details grid** — rack, PDU name + IP, outlet #, KVM name + port (read-only)
  - **Remove from DCIM** — clears the outlet label, OPT disappears from all views
- **"+ Add OPT" button** on every rack card that has a PDU
  - Opens a modal: PDU selector (when multiple PDUs), outlet number (1–48), OPT name
  - Save creates the label in the database; OPT appears in Racks and Inventory immediately
- All label changes go through the existing `PATCH /api/devices/{id}/labels` endpoint and trigger a device + PDU status reload

### Not changed
- Dashboard, PDU detail, KVM detail, Add Device
- All 53 unit tests passing

---

## v1.6.0 — 2026-07-15

### Added
- **Drag-and-drop rack layout** — grab the ⠿ grip on any server slot in the Racks view and drag it up or down to reorder. Custom position is saved instantly to `/api/rack-positions` (a JSON file on disk) and persists across page refreshes and server restarts.
- **Inline rename** — double-click any server name in the rack card to edit it in-place. Press Enter to confirm, Escape to cancel.
- **U-slot numbers** — each server row now shows its rack unit number (`U01`, `U02`…) on the left edge, styled as a dark column.
- **`/api/rack-positions` endpoint (GET + PUT)** — stores custom rack slot order in `backend/rack_positions.json`; auth-bypassed like `/api/version`.
- **DragOverlay** — while dragging, a floating ghost card shows the server being moved with a green border.

### Not changed
- Dashboard, PDU detail, KVM detail, Add Device
- All 53 unit tests passing

---

## v1.5.0 — 2026-07-15

### Changed
- **DCIM full visual redesign** — professional dark-theme overhaul across all four sub-tabs
  - **Summary KPI bar** — always-visible strip at the top of DCIM showing Total Draw (kW), Servers Online, Racks Online, KVM Sessions, and Alerts; replaces scattered stats
  - **Rack cards** — redesigned with outlet-number badges (`#9`, `#17`…) on every server slot, capacity utilisation bar with percentage, PDU online/offline dot indicator, KVM session count, cleaner typography
  - **Inventory table** — new PDU IP column, outlet `#N` badges, KVM name shown as a purple pill, colour-coded rows (green tint for powered-on servers), right-aligned numeric columns, uppercase column headers
  - **Power view** — kW shown inline on bar chart labels (`1.23 kW · 42% capacity`), Peak Rack tile added, bar labels now show kW + capacity%
- **Version badge moved to top-right** of the header bar (was between logo and search bar)
- **All 53 unit tests passing**

### Not changed
- Dashboard, PDU detail, KVM detail, Add Device
- Backend API, drivers, database, auth

---

## v1.4.0 — 2026-07-15

### Added
- **7 racks in DCIM** — Rack-07 added to seed data with Optn29 and Optn149 (the two OPTs that previously had KVM port assignments but no PDU outlet). IP placeholder `10.7.30.202` — update in `seed.py` when the real IP is known.
- **Server slots always visible** — rack cards no longer collapse the OPT list. Each OPT is shown as a visual rack slot with a power LED (green glow when on, dark when off), KVM port badge, and wattage. Grid now fits 4 columns on wide screens.
- **Changelog tab** — new sub-tab inside DCIM → Changelog. Shows all versions with the current one highlighted. Fetches live from `/api/changelog` (reads `CHANGELOG.md` from disk — no restart needed to update).
- **`/api/changelog` endpoint** — serves `CHANGELOG.md` as JSON; auth-bypassed like `/api/version`.

### Not changed
- Dashboard, PDU detail, KVM detail, Add Device
- All 53 unit tests passing

---

## v1.2.0 — 2026-07-15

### Changed
- **DCIM now shows OPTs from saved labels immediately** — previously the Inventory and Racks views only populated assets when a PDU was online and its status had been polled. Now the asset list is built from the stored outlet labels (`device.labels`, persisted in the database) so every OPT you've named via Edit Labels appears in DCIM from the first page load, even if the PDU is currently offline.
- Power state (`on` / `off` / `unknown`) is still enriched from live PDU data when available; `unknown` is shown for any asset whose PDU hasn't responded yet.
- KVM port cross-referencing now also reads from stored KVM labels (same pattern), so KVM port assignments survive KVM downtime.

### Backend
- `Device` ORM model (`models.py`) — added `labels` Python property that parses `labels_json` into a dict.
- `DeviceOut` schema (`schemas.py`) — added `labels: dict` field; Pydantic reads it from the ORM property via `from_attributes=True`. The field is now included in every `GET /api/devices/` response.

### Tests
- Added 3 new tests in `DcimView.test.jsx` covering the stored-labels path:
  - OPTs visible with empty `pduStatuses` (PDU offline)
  - State shows `"unknown"` before first PDU poll
  - State updates to `"on"` / `"off"` once live data arrives
- Total: **51 tests / 51 passing**

---

All notable changes to this project are recorded here.
To roll back to a specific version, tell me "let's go back to vX.Y.Z".

---

## v1.1.0 — 2026-07-15

### Added
- **DCIM tab** — new top-level tab alongside the original Dashboard
  - **Racks sub-view**: card per rack showing online status, live power bar, outlet counts, KVM active ports, expandable server list
  - **Inventory sub-view**: auto-detected server table derived from PDU outlet labels, cross-referenced against KVM port labels; sortable by any column; filterable by rack, power state, and free-text search
  - **Power sub-view**: total draw summary tiles, per-rack horizontal bar chart sorted by consumption, top-10 power consumers list
- **Unit test suite** (Vitest + React Testing Library) — `npm run test:run`
  - `StatusDot.test.jsx` — 9 tests covering all status colors and fallback
  - `StatsBar.test.jsx` — 8 tests covering formatting, kW conversion, danger styling
  - `Header.test.jsx` — 7 tests covering name, version badge, search, and button callbacks
  - `DcimView.test.jsx` — 24 tests covering `isDefaultOutletLabel`, rack detection, inventory filtering, KVM cross-reference, and power calculations
- **Version badge** in header — `__APP_VERSION__` baked at build time from `backend/version.txt`, styled as a green NVIDIA-tinted chip; hover shows git hash
- **`backend/version.txt`** — authoritative version source (read by backend `/api/version` endpoint and injected into the frontend build)
- **`vite.config.js`** — now injects `__APP_VERSION__` and adds Vitest configuration (`environment: jsdom`, `globals: true`)

### Not changed
- Original Dashboard (PDU cards, KVM cards, search, rack filter)
- PDU detail page
- KVM detail page
- Add Device modal
- Backend API, drivers, database, auth, KVM proxy
- App name "Lab Manager" and all original header/footer text

---

## v1.0.0 — (original release)

### Features
- Dashboard grid of PDU and KVM device cards with live status
- PDU detail: outlet table with per-outlet wattage/amperage, power on/off/cycle, edit labels
- KVM detail: port grid with active-glow thumbnails, edit port labels
- KVM auto-login: server-side credential exchange opens console in new tab without password prompt
- KVM in-use tracking: marks ports in-use when console is open, 4-hour TTL, auto-clears on port idle
- KVM reverse proxy: transparent HTTP + WebSocket proxy, strips CSP/X-Frame headers, rewrites URLs
- Add / delete device management (name, IP, rack, model, encrypted credentials)
- 15-second background polling of all device statuses
- Startup cache warm-up (pre-fetches all statuses before first page load)
- Global stats bar: device count, outlets on/total, total kW, KVM ports active, alert count
- Search across device names, IPs, racks, outlet labels, and port labels
- Filter by device type (All / PDUs / KVMs) and rack
- NVIDIA green dark theme (Tailwind + custom `nv-*` palette, JetBrains Mono)
- FastAPI backend + async SQLite (aiosqlite) + Fernet-encrypted credentials
