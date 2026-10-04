# Design integration

The Claude handoff supplied a standalone HTML prototype with simulated data and
missing design-system assets. Its layout and colors have been recreated in the
existing React application. No prototype runtime, hard-coded sign-in credentials,
fake charts or client-only data store is included in the application build.

Dashboard remains the default route and the first navigation tab. It retains device
cards, status/sensor summaries, search, rack filters and PDU/KVM operations.
Storage locations saved as `kind=rack, model=Storage` also have Dashboard inventory
cards with saved equipment counts, equipment/serial search and direct rack-detail
links. They do not contribute invented PDU readings or offline device alerts.
The Storage filter shows these locations separately. Compute rack placeholders
remain in the Racks page and do not create duplicate Dashboard cards. Racks,
Inventory, Power, Consoles, Scan & Track, Ping Monitor, 3D Twin, Admin and Changelog
have direct tabs. Admin exposes devices, the existing PDU–KVM mapping and help.
The existing shared-password login is retained by default. Optional real accounts
add Admin/Operator/Viewer roles and the handoff's Users and Account settings pages;
see [user accounts](user-accounts.md) for activation and migration details.

The latest supplied `Lab Manager v3.dc.html` supersedes v2's visual tokens. The UI
uses a black app bar, underline tabs, flat dark surfaces, 2px corners and neutral
equipment/owner colors. Dashboard is still the landing page. The horizontal logo
is stored locally from the [official NVIDIA website](https://www.nvidia.com/en-us/);
the handoff's unavailable design-system scripts are not loaded.

Rack cards use the new palette, status chips, compact shelves and owner badges.
Edit enables rack layout changes, inline names and inventory owners; normal viewing
opens read-only asset details. Drag handlers are disabled in both the rack grid
and rack detail when Edit is off. Existing power controls and Scan & Track keep
their explicit operations and confirmations. Cooling assignments are read from
saved data; opening the page no longer seeds invented assignments.

The existing inventory API, ETags, whole-rack labels, main storage labels, automatic
barcode registration and tracking history remain in use. Ping Monitor retains the
PDU/KVM connection columns and now displays email configuration and delivery status.
The Twin tab embeds the existing `/twin/index.html?embed=1` application.

The supplied font files were absent. Font stacks use installed NVIDIA Sans and
JetBrains Mono when available, with system sans-serif/monospace fallbacks. Existing
Google Fonts loading remains optional; functionality does not depend on it.

## Verification before publication

- Backend: 238 tests passed, excluding `test_kvm_regression.py`, which requires
  actual hardware/network access. Alerts use mocked SMTP and device readings.
- Account tests cover CSRF/origin checks, role enforcement (including KVM GET/WS),
  session expiry/revocation, temporary passwords, admin protection, registration
  opt-in, profile/preferences and rate limiting.
- Frontend: Vite production build and five existing barcode utility tests passed.
- Browser: Edge tested the real React application against an isolated FastAPI
  instance with a temporary SQLite database, temporary inventory and simulated
  hardware. Checks cover default Dashboard, rack viewing/edit guards, persisted
  drag reordering and inline renaming, inventory search, PDU detail, KVM popup
  routing, rack scan/move, main-storage registration, malformed barcode handling,
  monitor connection/email panels, the Twin iframe, Admin and Changelog.
- Nine primary screens were checked at 390px width, without page overflow or
  JavaScript errors. Real PDU operations, KVM sessions and SMTP delivery still
  need validation in the VM environment with its actual configuration.
- A separate browser run exercised the real account API: Viewer restrictions,
  Admin user creation/reset/disable/removal, mandatory password changes, session
  revocation after a role change, Operator editing, saved preferences and mobile
  account layouts. Screenshot review also caught a logo asset path that worked
  in Vite but not in FastAPI; the logo is now bundled with the application assets.
  A final production-page check confirmed the logo renders and the standalone
  Twin applies Viewer/Operator permissions to its controls.
- Storage Dashboard checks cover populated/empty/failed inventory reads, serial
  search, rack/type filters, direct detail navigation and browser Back, mobile
  layout, Viewer access, and absence of storage-device polling or write requests.
- Release installer: 49 tests passed, including account activation, preserving
  credential configuration, rollback to the previous login, authenticated health
  checks and removal of temporary health-check sessions. Stuck-shutdown recovery
  checks project ownership and process identity, preserves committed SQLite WAL
  data in an online snapshot, and aborts before shutdown if the snapshot fails.

Installation must be run on the VM with the pinned release installer. The main
design preview reads actual VM data through a local
read-only gateway, using the VM's existing authentication. Browser/role regression
tests run separately on clearly marked temporary test data. A local preview startup
issue that omitted Tailwind styles was corrected by starting in the frontend root.

For local development, `DCIM_BACKEND_URL` can select a separate backend for Vite's
`/api` and `/twin` proxies. The default remains `http://localhost:8000`.
