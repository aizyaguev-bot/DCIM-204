# Lab Manager — Changelog

---

## Unreleased — Remote PXE install

### Added
- **Remote install** for Operator and Admin accounts. Choose a computer from its
  live KVM port label, reboot it, pick the network boot entry and the install
  profile, and review the `inst.repo` / `inst.ks` host change before the
  installer starts. Reboot and install each ask for the operator password.
  If an install may already have started, that computer stays blocked until an
  Admin acknowledges it. Leaving the page cancels a job that was never started,
  so it does not keep the computer blocked.
- With `PXE_DRIVER=raritan`, an allowlisted computer is driven through its
  Raritan JavaScript console. That path stays unavailable until the console
  browser and a screen reader are installed, and it does not send the install
  key unless the edited line on screen matches the review.

### Changed
- With user accounts enabled, the 3D twin's lab data needs a signed-in session.
  Without one, the twin shows "Sign in required" with a link to Lab Manager, so
  a wall screen showing the twin must stay signed in (a Viewer account is enough).
- With user accounts enabled, replacing all owners at once (`PUT /api/opt-owners`)
  is Admin-only. Setting the owner of a single asset, which the app and the twin
  use, is unchanged.

### Fixed
- Outlet power errors showed raw server output such as `409: {"detail": …}`.
  They now show the server's message.
- 3D twin: moving equipment could overwrite layout changes saved meanwhile in
  another session, and a failed save could still say "saved in Lab Manager".
  A move now starts from the latest saved layout and shows the server's message
  when it fails.
- 3D twin: text from the saved twin data and rack item IDs could run script in
  the page. It is now always shown as plain text.
- 3D twin: after a session expired, the twin kept showing "Live" with frozen
  data. It now shows "Signed out", stops polling, and reconnects after sign-in.
- 3D twin: a KVM that answers but fails to sign in was shown as active. It now
  shows the sign-in error and appears under Attention.
- 3D twin: owners of live Lab Manager equipment could not be changed in the
  twin, and rack items showed no owner. The twin now shows and saves owners in
  Lab Manager.
- 3D twin: Power On and Cycle stayed available for outlets of a PDU in
  maintenance, and power errors showed raw server output. They are now disabled
  with the reason, and errors show the server's message.
- 3D twin: Viewer accounts saw outlet power buttons, could change the rack
  mapping locally, and saw a "Save to server" button that the server refuses.
  These controls are now hidden for Viewers.
- 3D twin: unsaved input in the editor was lost when live data refreshed, and
  the kiosk Attention list jumped back to the top on every refresh.
- KVM console: requests forwarded to the KVM no longer include Lab Manager's own
  sign-in, CSRF or forwarding headers, and device values written into the
  console page are encoded so they cannot run script.
- A CSRF header with non-ASCII characters caused a server error. It is now
  refused with 403.

### Notes
- Remote install stays off until `PXE_ENABLED` is set. The default driver is
  simulated and does not open a KVM, switch a PDU outlet, or reboot a computer.
- The live KVM regression tests in `backend/tests/test_kvm_regression.py` run
  only when `DCIM_LIVE_KVM_TESTS=1` and `DCIM_TEST_BASE_URL` are set. They no
  longer read `.env` or assume `localhost:8000`.

### AI lab assistant
- **Lab assistant**: a Hebrew (right-to-left) chat panel for every role,
  Viewer included. Ask about equipment status, power, consoles, owners,
  maintenance and the rack layout, or what switching something off would affect.
- The assistant only reads lab data. Its tools are read-only: it never switches
  power, opens a console or changes a setting. Each answer lists the sources it
  used.
- Without an Anthropic API key, or with the language model turned off, it
  answers in a clearly labelled demo mode ("מצב הדגמה — ללא מודל שפה") built
  from the real lab data by fixed rules. The key stays on the server
  (`ASSISTANT_ANTHROPIC_API_KEY`, see `.env.assistant.example`) and is never
  sent to the browser or written to logs. A site with no user accounts and no
  shared password stays in demo mode unless `ASSISTANT_ALLOW_OPEN_LLM` is set.
- Work items: the assistant drafts a task from an answer; Operator and Admin
  accounts edit it and save it to the team's list.
- Voice: dictate a question and have answers read aloud, in browsers that
  support speech.
- Questions are limited per user (per minute and per hour), language-model
  questions have a daily cap for the whole site, and only a few questions are
  answered at the same time.
- Remote install (PXE) stays off by default: `PXE_ENABLED` is false and the
  driver is the simulated one unless the server's `.env` changes them.

---

## v2.38.0 — 2026-10-19 — Automatic VM updates and public version check

### Added
- The VM can install every new commit of `feat/lab-manager-v3-accounts` by
  itself. After this release is installed, a one-time command on the VM,
  `backend/.venv/bin/python scripts/vm-auto-update.py install`, adds a
  crontab line that checks GitHub every 2 minutes. A new commit is installed
  with the same installer as the manual runbook, keeping user accounts on when
  they are on now, usually within about 5 minutes of a push. Every install
  restarts the site once.
- A failed update is retried after 30 minutes, at most 3 times, then skipped
  until a newer commit appears. If a failed attempt leaves down a site that was
  up before, it is started again. Nothing is installed in the first 5 minutes
  after a boot or with less than 1 GiB free.
- `vm-auto-update.py status` shows the installed and the newest commit, the
  last result and the size of the installer backups; `remove` deletes only its
  own crontab line. Logs and state are kept in `.monitor-backups/auto-update/`.
  See section 9 of `docs/vm-runbook.md`.

### Changed
- `GET /api/version` no longer needs a sign-in when user accounts are on, so a
  release can be confirmed without signing in. It shows only the installed
  version (on the VM, the first 7 characters of the installed commit). Every
  other page and API, and any other method on this address, still needs a
  session.

### Notes
- Once automatic updates are on, anyone who can push to
  `feat/lab-manager-v3-accounts` can run code on the VM within minutes. Turn
  on GitHub branch protection for this branch (owner action).
- Run `install` as the normal user, never as root, from a shell that exports
  no application settings; they belong in `.env`.

---

## v2.37.2 — 2026-10-14 — KVM console in browsers that opened it before

### Fixed
- The KVM console could stay white after updating, because the browser kept
  the broken copy of the KVM's scripts from the earlier version. The KVM sends
  them without cache headers, so browsers reuse them for months. Console pages
  and scripts now load from a new address, are never cached, and the browser's
  "has it changed?" and partial-download requests are no longer passed on to
  the KVM, so the browser always receives a complete, matching script.
- While the KVM reports no picture, the console says that the server's screen
  is probably asleep or off, and that moving the mouse or pressing a key wakes
  it.

---

## v2.37.1 — 2026-10-14 — KVM console fix

### Fixed
- The KVM console opened as a white page. The proxy changed single quotes to
  double quotes inside the KVM's own scripts, which broke jQuery. Rewritten
  links now keep their original quotes.
- With user accounts enabled, the console's live connection (WebSocket) was
  always refused because `ws://` was compared with the browser's `http://`
  origin. Same-site connections are accepted again; other sites are still
  refused.
- With user accounts enabled, the KVM web client's own requests were refused
  for a missing CSRF header that it cannot send. Requests through the KVM
  proxy now need an Operator session and a same-site `Origin` header instead.

---

## v2.37.0 — 2026-10-13 — PDU maintenance mode, KVM fixes and twin daily-tracking view

### Added
- **What's new** window: after an update, each browser shows once the changelog
  sections added since the version it last saw, with a link to the full
  Changelog tab.
- Power tab **Maintenance** column. "Turn off all outlets" puts a PDU in
  maintenance mode. It asks for a reason and the user's password, or the shared
  Lab Manager password in legacy mode, and records which outlets were on.
  "Restore power" switches exactly those outlets back on. Every shutdown,
  restore and wrong-password attempt is kept in a maintenance log, and the last
  15 entries are shown in the column. API: `GET /api/pdus/maintenance`,
  `POST /api/pdus/{id}/maintenance/shutdown`, `POST /api/pdus/{id}/maintenance/restore`.
- While a PDU is in maintenance, outlet on/cycle requests return 409 and are
  disabled in the PDU card and the detail page. Changing its IP or kind, or
  deleting it, also returns 409.
- Wrong maintenance passwords are throttled separately from login
  (10 failures per 5 minutes; 429 with `Retry-After`).
- 3D twin: an **Attention** tab and a kiosk dock list leaks, unreachable PDUs
  and KVMs, high temperature, high rack load, OPTs that are off, in an unknown
  state or missing from the DCIM labels, auto-placed or unplaced items,
  unmapped racks and equipment not scanned for over 30 days, sorted by
  severity. Clicking an entry focuses its rack or item. Identity shows when the
  device was last seen and how many trackers it has. Heat is off by default and
  remembered per browser. Refreshes keep the panel scroll position and any
  open edit.

### Fixed
- Restoring a PDU from maintenance only counts outlets that the PDU reports as
  on. Outlets missing from the status reading stay on the restore list instead
  of ending maintenance mode while still off.
- KVM ports marked in use on LX II and other units without live port status
  no longer lose the mark after two minutes. The mark stays until Mark free
  or expiry.
- A KVM that rejects the saved credentials now reports "Device API
  authentication failed" instead of appearing online with generic ports, and
  stops after the first refused sign-in.
- 3D twin labels, search results and inventory rows escape device names.

### Notes
- Maintenance mode is not a physical lockout. Disconnect power physically
  before hands-on work. Without accounts and without `LAB_MANAGER_PASSWORD`,
  maintenance actions are disabled.

---

## Unreleased — Unknown power readings and VM operations tools

### Added
- `scripts/diagnose-device-api.py`: a read-only VM check per PDU/KVM (DNS,
  route, TCP 443, TLS, HTTPS, proxy environment of the running backend) that
  separates connection failures from slow responses. It sends no credentials
  and makes no device changes. See `docs/device-api-diagnostics.md`.
- `scripts/lab-service.py`: `status` (backend PIDs, version, monitoring and
  alert state, inventory counts), idempotent `start`, safe `restart`, and an
  optional `@reboot` start (`install-boot` / `remove-boot`) that refuses to add
  a second boot mechanism and cannot start a second backend.
- `scripts/alerts-setup.py`: check, configure SMTP from approved values, send
  one test mail and show the relay's reply, enable alerts only after a matching
  successful test, verify the running worker, and an isolated alert simulation.
- `docs/vm-runbook.md`: ordered VM steps for install, diagnosis, SMTP, alerts,
  boot start and before/after inventory comparison.

### Fixed
- Missing or invalid PDU readings are shown as unknown instead of 0 W/V/A.
  Totals that include unknown outlets are marked partial; measured inlet
  current is kept when only outlet watts are incomplete.
- PDU and KVM API failures report fixed failure classes (authentication, HTTP
  status, connection/read/pool timeout, DNS, refused, unreachable, TLS, proxy).
  Device response bodies, RPC messages and raw connection errors are no longer
  returned by the API or included in monitor details and alert emails. The PDU
  sensor debug view returns status codes and numeric samples only.

---

## Unreleased — KVM console launch recovery

### Fixed
- When a browser refuses a new KVM tab, a port click opens the console inside
  the application instead of silently doing nothing. Closing it releases that
  port's in-use marker and keeps the existing application view intact.
- KVM cards and detail pages explain why Viewer accounts cannot open consoles.
  Operator/Admin permissions and saved device connections are unchanged.

---

## v3.1.1 — 2026-10-01

### Added
- Optional email alerts for persistent PDU/KVM API-check failures, with one
  notification per episode and a recovery message. Existing device-check schedules
  remain in use; SMTP configuration is still required to enable delivery.

### Fixed
- Monitor diagnostics distinguish connection, read and connection-pool timeouts.
  Connection failures no longer imply that the device replied too slowly.

---

## v3.1.0 — 2026-10-01

### Added
- An engineer directory seeded with the requested ten names, and Owner selection
  in Inventory, rack editors and the Twin. Admins can add, rename or disable
  engineers; Operators can assign owners. Existing ownership remains preserved.
- Reset View, Fit Lab and Focus Selection controls, with Hebrew navigation hints.

### Fixed
- Twin mouse input now uses the bundled official OrbitControls. Rotation, screen
  pan and bounded zoom share one controller; releasing or cancelling a drag stops
  navigation. Equipment only moves through explicit Edit → Move → destination.
- Monitor names follow inventory changes and can use a saved display alias.
  Server renames preserve monitoring history, port associations and ownership.
- PDU checks have sufficient time for multiple outlet requests and expose safe
  failure details instead of hiding the reason behind Check failed.
- KVM sign-in redirects to the same-origin viewer proxy; its HTTP/WebSocket
  traffic no longer requires opening the device's certificate warning page.

---

## v3.0.0 — 2026-09-30

### Added
- Real accounts with Admin, Operator and Viewer permissions, account settings,
  temporary passwords and user management. Activation reuses the existing site
  password for the first administrator and preserves the existing inventory.
- Optional email alerts for observed network outages and configured PDU inlet
  limits. Delivery remains disabled until SMTP and thresholds are configured.
- The Linux installer can activate accounts, test sign-in before changing the
  running site, and restore the previous login configuration on failure.

### Changed
- Integrated the v3 design into the existing application. Dashboard remains the
  default page; Racks, Inventory, monitoring, console controls and 3D Twin remain
  connected to the real APIs.
- Storage racks appear on Dashboard with their saved equipment. Compute rack
  placeholders do not create additional Dashboard cards for Rack 6 or Rack 7.
- Rack editing is explicit; opening a rack no longer adds cooling assignments.

---

## v2.36.0 — 2026-07-30

### Fixed
- **PDU environmental sensors** — rewrote sensor discovery to use the correct Raritan API path: PDU → `getPeripheralDeviceSlots` → `getConnectedDevice` → `getSensors`; previously used `getSensors` on the PDU root object which returned nothing on G4 firmware. Temperature, humidity, and leak detection now read from DX2 peripheral sensor modules.

### Changed
- **Temperature alert threshold** — 24°C triggers amber warning (was 28°C) across StatsBar and PDU detail panel

---

## v2.35.0 — 2026-07-30

### Fixed
- **PDU sensor crash** — `get_env_sensors()` rewrote to never throw: uses `isinstance` checks on all API responses, catches all exceptions, removed broken `asyncio.sleep(0, result=None)` pattern that crashed PDU status reads
- **Syntax error** — duplicate `finally:` block in `sensors-debug` endpoint removed
- **Temperature alert threshold** — changed from 28°C to 24°C across StatsBar and PduDetail
- **Sensor name matching** — flexible keyword matching (handles `temperature1`, `relativeHumidity`, `leakDetector` etc. across Raritan firmware versions)

### Added
- **Sensor debug endpoint** — `GET /api/pdus/{id}/sensors-debug` (with auth) tries multiple Raritan API methods to discover where environmental sensors are exposed; use `curl -u x:YOUR_SITE_PASSWORD http://localhost:8000/api/pdus/pdu-rack01/sensors-debug` to diagnose

---

## v2.34.0 — 2026-07-30

### Added
- **PDU sensor summary in top bar** — temperature (°C range), humidity (% range), and leak alert now visible in the StatsBar at the top of every page; color-coded amber above 28°C / 70% humidity, red above 35°C; ⚠ Leak pulses red; section hidden when no sensors are connected

### Fixed
- **Chiller save after refresh** — race condition where auto-seed ran before API load and overwrote saved U assignments; added `chillersLoaded` flag so seed only runs after the stored data is confirmed empty
- **Chiller unassign** — clicking ✕ on an assigned chiller now clears only the U slot (returns to pool), not the rack assignment (previously deleted the chiller entirely)

---

## v2.33.0 — 2026-07-30

### Fixed
- **Chiller disconnect** — click ❄ in right column reveals "✕ נתק"; clicking returns chiller to rack pool (u=null, rack kept)

---

## v2.32.0 — 2026-07-30

### Changed
- **Chiller — drag from within rack** — removed external cooling panel entirely; unassigned chillers appear at the bottom of their rack chassis (inside the rack body); drag from there to a specific U-row → chiller gets assigned to that U
- **Chiller right-column** — every OPT row has a right-side slot (14px column) showing ❄ and chiller name when a chiller is assigned to that U; empty slot is invisible unless hovered

---

## v2.31.0 — 2026-07-30

### Changed
- **Chiller always visible** — removed Cooling toggle button; Cooling units panel is always shown at the bottom of the Racks view; no mode switching
- **Chiller styled as OPT** — assigned chiller appears in the rack diagram as a full-height row identical in structure to an OPT row: U-rail, left cyan stripe, snowflake icon, name, "Cooling unit" sub-label
- Unassigned chillers shown with dashed border and "drag to shelf" hint

---

## v2.30.0 — 2026-07-30

### Changed
- **Chiller — U-slot assignment** — drag a chiller card onto a specific row (U-level) in the rack diagram; the ghost label shows "→ U03" while hovering; chiller appears as a cyan ❄ row at exactly that U position in the rack; Cooling panel shows "→ Rack / U03" assignment

---

## v2.29.0 — 2026-07-30

### Changed
- **Chiller — simplified drag** — removed SVG pipe visualization; chillers are now dragged directly onto a rack card to assign; assigned chillers appear as cyan badges in the rack footer; unassign via ✕ button on the chiller card in the Cooling panel
- **Rack cards wider** — grid minimum width 280→340px for more breathing room
- **Owner visible in rack** — each server row now shows the owner name as a purple label directly in the rack diagram, no need to open Inventory

---

## v2.28.0 — 2026-07-30

### Added
- **Chiller / Cooling system** — visual cooling pipe map in Racks view:
  - Toggle "❄ Cooling" button in the rack overview header to enter cooling mode
  - Each rack shows its chiller unit(s) below the rack card (Rack-04 has 2 chillers pre-seeded; all other racks get 1 automatically on first load)
  - **Drag to connect**: hover over a chiller badge and drag to any rack card or specific U-slot row to draw a pipe connection; release to save
  - Connections shown as animated cyan bezier pipe lines with U-slot label
  - Click the red ✕ button on a pipe midpoint to delete the connection
  - Press ESC during drag to cancel
  - Data persisted in `backend/chillers.json` via new `/api/chillers` GET+PUT endpoint

---

## v2.27.0 — 2026-07-29

### Added
- **Amps per rack card** — each rack card in Racks view now shows current draw (A) in the footer next to watts, and in the info line below the rack name; rack detail panel stats grid shows "Current" tile alongside "Power draw"

---

## v2.26.0 — 2026-07-29

### Added
- **Owner / Engineer assignment** — every OPT can have an assigned owner (engineer name):
  - Inventory table: new "Owner" column; click any cell to edit inline with autocomplete from existing names; click away or press Enter to save instantly; shows purple "+ assign" when unset
  - Server edit panel: "Owner / Engineer" field with autocomplete; saves on blur or Enter
  - Stored in `backend/opt_owners.json` via new `/api/opt-owners` GET+PUT endpoint; search in Inventory also filters by owner name
- **Amperage in PDU detail** — the Summary panel now shows "Current (A)" row alongside Total draw when inlet voltage is available
- **Changelog fix** — fixed path bug that caused Changelog tab to show "not found"

---

## v2.25.0 — 2026-07-29

### Added
- **PDU environmental sensors** — temperature, humidity, and leak detection from Raritan PDUs shown in UI for PDUs with sensors; hidden when none connected
  - PduCard footer: compact badges (🌡 temp, 💧 humidity, ⚠ Leak)
  - PduDetail sidebar: "Environment" card with color-coded thresholds (temp red >35°C, amber >28°C; humidity amber >70%)
- **Amperage tracking** — current draw visible at floor, rack, and PDU level
  - KPI bar: "Floor current" tile (total amps across all PDUs)
  - Power tab per-rack: amps shown alongside watts on each bar
  - Power tab "Amperage per PDU" table: voltage, current, load % bar, free outlets; color-coded
  - Power tab "Where to connect" panel: PDUs ranked by available headroom with tag (Plenty of room / Some room / Near capacity)

---

## v2.20.0 — 2026-07-21

### Changed
- **Switch stays with server** — in the DCIM rack diagram, the switch assignment for a server now renders as a dedicated cyan cell at the same U level as the server. When the server is reordered, the switch cell follows automatically. The small inline badge inside the server row has been removed.

---

## v2.15.0 — 2026-07-19

### Added
- **Edit PDU from DCIM** — the Edit Rack modal (pencil icon on rack card) now includes a PDU section for each PDU in the rack. You can update PDU name, IP address, username, and password. Leave credentials blank to keep existing values.

---

## v2.14.0 — 2026-07-19

### Added
- **Edit Rack** — hover over any rack card in the DCIM overview to reveal a pencil icon. Click it to open the Edit Rack modal where you can rename the rack and switch between Compute/Storage type. Changes are saved to all devices in that rack.
- **Delete Rack** — the Edit Rack modal has a "Delete Rack" button. Clicking it shows a confirmation step. For racks with PDUs, a warning is shown that PDU devices will also be removed. Confirms before deleting.

---

## v2.13.0 — 2026-07-19

### Fixed
- **"Move to rack" missing new DCIM racks** — the move dropdown in the OPT edit panel was built from `pdus` (kind="pdu" only), so racks added via "+ Add Rack" (kind="rack") were invisible. Now passes `rackDevices` (includes both kinds) through `ServerEditPanel` → `MoveOptSection`, so all racks appear in the dropdown.

---

## v2.8.0 — 2026-07-19

### Fixed
- **Add Rack modal typing bug** — `Field` was defined inside the component, so React unmounted/remounted the input on every keystroke (losing focus after 1 letter). Moved input class to a module-level constant and inlined inputs directly.
- **Add Rack simplified** — only rack name is required now. PDU name/IP/credentials removed; a placeholder PDU is auto-created. You can edit PDU details later via Add Device.

---

## v2.7.0 — 2026-07-19

### Added
- **Add Rack button** in DCIM overview — "+ Add Rack" button top-right of the rack grid. Opens a modal to enter Rack name, PDU name, PDU IP, and optional username/password. Saves directly to the database; rack appears immediately without page reload.

### Fixed
- **Rack detail right panel too narrow** — rack diagram was using `w-full` and expanding to fill the entire container, pushing the right panel to ~150px. Fixed with `fixed` prop (`flex-shrink-0` + `width: 480px`) on the detail view diagram, leaving the right panel the space it needs.

---

## v2.6.0 — 2026-07-19

### Added
- **Rack-08** — new empty rack added to DCIM. Use the VDI `curl` command to register it, then add OPTs via the UI. IP placeholder `10.7.30.203` — update when known.

---

## v2.5.0 — 2026-07-19

### Changed
- **Rack detail right panel redesign** — cleaner, more readable layout:
  - Action buttons (+ Equipment, + OPT) moved to the top as full-height buttons instead of being squeezed next to the rack name
  - Stats grid now uses 2-column layout with larger text (`text-lg font-bold`) and monospace uppercase labels — easier to scan at a glance
  - Added "Status" tile (Online / Offline / No PDU) so rack health is immediately visible
  - PDU section is now its own card with a green glow dot for online PDUs
  - Removed the previous cramped info card that mixed rack name, buttons, stats, and PDU info in a single block

---

## v2.4.0 — 2026-07-19

### Changed
- **Rack grid layout** — overview racks now use a responsive CSS grid (`auto-fill, minmax(280px, 1fr)`) instead of a horizontal scroll row. All racks are visible on screen without scrolling; they wrap to the next row on smaller screens.

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
