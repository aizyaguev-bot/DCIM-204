Browser regression checks use real FastAPI routes and temporary SQLite/JSON data.
Hardware access is mocked or rejected. The server binds only to 127.0.0.1 and the
tests refuse to mutate anything without the `LOCAL PREVIEW - TEST DATA` marker.

Install backend requirements in a test environment, and make Playwright's Node
package and Microsoft Edge available (or set NODE_PATH to your existing runtime).
From the repository root, start the fixture in one terminal:

```sh
DCIM_TEST_ACCOUNTS=1 python tests/browser/preview-server.py 8770
```

Then run in a second terminal:

```sh
node tests/browser/navigation.cjs
node tests/browser/owners-monitor.cjs
node tests/browser/selection-move.cjs
DCIM_PREVIEW_URL=http://127.0.0.1:8770 node tests/browser/kvm-launch.cjs
```

For a fixture on another port, set `DCIM_PREVIEW_URL` for every check; without it
the checks use port 8770 (`kvm-launch.cjs` uses 8774).

The Racks page check `racks-ui.cjs` needs protected outlets on its fixture, started fresh:
`DCIM_TEST_ACCOUNTS=1 POWER_PROTECTED_OUTLETS=pdu1:4 python tests/browser/preview-server.py 8951`, then
`node tests/browser/racks-ui.cjs` (default port 8951; `RACKS_UI_ONLY=4,5` runs some sections). It undoes its
changes but adds four cooling units that are never deleted.

The device name sync check `name-sync.cjs` needs its own fixture, started fresh for every run (it changes
labels and the in-memory fake devices): `DCIM_TEST_ACCOUNTS=1 DCIM_FAKE_NAME_DEVICES=1 python tests/browser/preview-server.py 8840`,
then `node tests/browser/name-sync.cjs` (default port 8840). No real PDU or KVM is contacted.

To check frontend source changes without rebuilding `frontend/dist`, build into a
temporary folder (`npx vite build --outDir <folder> --emptyOutDir` from `frontend/`)
and start the fixture with `DCIM_PREVIEW_DIST=<folder>`.

The checks mark the fixture version as already seen, so the What's new dialog does
not cover the page. Restart the fixture before repeating `owners-monitor.cjs`; it renames/disables a
test engineer. The move check writes only the fixture's placement files. The
navigation check saves an optional screenshot to the system temporary directory
(override with DCIM_QA_SCREENSHOT). No live lab site or hardware is used.

The KVM launch check covers a normal console tab, blocked/throwing popup APIs
from both a device card and its details, per-port in-use cleanup, and explicit
Viewer restrictions. It exercises the built frontend with a simulated console;
it does not claim that video/input works against real KVM firmware.
