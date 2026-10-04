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

Restart the fixture before repeating `owners-monitor.cjs`; it renames/disables a
test engineer. The move check writes only the fixture's placement files. The
navigation check saves an optional screenshot to the system temporary directory
(override with DCIM_QA_SCREENSHOT). No live lab site or hardware is used.

The KVM launch check covers a normal console tab, blocked/throwing popup APIs
from both a device card and its details, per-port in-use cleanup, and explicit
Viewer restrictions. It exercises the built frontend with a simulated console;
it does not claim that video/input works against real KVM firmware.
