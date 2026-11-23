# Lab windows — the WP-0 contract

This file is the contract that the wave 1 and wave 2 packages build on. It covers WP-1, WP-2, WP-3, WP-D, WP-DW, WP-M, WP-5, WP-7, WP-4 and WP-8.

- The specs are `C:/t/one-window-spec.md` (v1) and `C:/t/one-place-spec-v2.md` (v2). v2 is a delta on v1.
- Where the code and this file disagree, fix one of them in the same change and post the change in `.agents/log.md`.
- Every name, prop and URL rule below exists in the tree now. The stubs keep their props when you fill them in.
- English UI text, plain and short. CRLF line endings.

## 1. Files and owners

| Path | What | Built by |
|---|---|---|
| `window/windowUrl.js` | URL rules, twin message parser, assistant detail (pure) | WP-0 (done) |
| `window/labWindowContext.js` | context, `useLabWindow`, `useServerWindow` (alias), `useLabData` | WP-0 (done) |
| `window/LabWindowProvider.jsx` | provider, window registry, toasts, power and delete dialogs, `WindowBackdrop` | WP-0 (done) |
| `window/WindowShell.jsx` | the frame of every window, `WindowSection` | WP-0 (done) |
| `window/useWindowFocus.js` | keys and focus of a window | WP-0 (done) |
| `window/window.css` | width bands, shell styles, toasts | WP-0 (done) |
| `window/format.js`, `window/StubDialog.jsx` | small helpers | WP-0 (done) |
| `server/serverKey.js`, `ownerKey.js`, `serverRecord.js`, `useServerRecord.js`, `useServerPower.js` | server foundation | WP-0 (done) |
| `server/ServerWindow.jsx`, `server/ServerLink.jsx` | server window composition, the link | WP-0 (done) |
| `server/PlaceActions.jsx`, `server/sections/PlaceBlock.jsx` | stubs | WP-1 |
| `server/RenameAction.jsx`, `server/RemoveAction.jsx`, `server/sections/OwnerNetworkBlock.jsx`, `server/sections/UnitsSection.jsx` | stubs | WP-2 |
| `server/PowerAction.jsx`, `server/HeaderTools.jsx`, `server/sections/PowerBlock.jsx`, `server/sections/ActivitySection.jsx` | stubs | WP-3 |
| `devices/DeviceWindow.jsx` | dispatcher (done) | WP-DW may change |
| `devices/PduWindow.jsx`, `KvmWindow.jsx`, `RackWindow.jsx`, `AddDeviceDialog.jsx`, `DeviceEditDialog.jsx`, `CorrectRackDialog.jsx` | stubs | WP-DW |
| `units/UnitWindow.jsx`, `CoolingWindow.jsx`, `AddUnitDialog.jsx` | stubs | WP-2 |
| `lab/TwinItemWindow.jsx` | stub | WP-DW |
| `lab/DeleteDialog.jsx` | stub: a server target uses `RemoveServerDialog` | WP-D |
| `lab/twinRecords.js` | `classifyTwin` (full) | WP-0 (done) |
| `lab/labIndex.js` | the contract plus server rows | WP-M (other kinds) |
| `api/twinData.js` | `loadTwinData` (full) | WP-0 (done) |
| `pages/ManageView.jsx` | stub: today's table via `DcimView section="inventory"` | WP-M |
| `backend/tests/fixtures/twin_classify.json` | the link rule's cases | WP-0 (WP-7 and WP-D read it) |

The tests are:

- `__tests__/server-window.test.js`
- `__tests__/window-url.test.js`
- `__tests__/twin-classify.test.js` (the frontend copy; WP-7 adds the twin copy)
- `tests/browser/server-window-shell.cjs`

## 2. URL rules (`window/windowUrl.js`)

**Address format**

- A server window is `?…&srv=<identity key>`. The key is lower-cased, for example `srv=opt11`.
- Any other window is `?…&open=<kind>:<id>`, with kind one of `dev`, `unit`, `cooling`, `rack` or `twin`.
  - The value is split at the first `:`, so an id may contain `:`.
  - Colons are written unescaped (`open=dev:pdu8`).
- `sec` is optional and takes `units`, `activity`, `move` or `delete`. `sec=delete` only opens the preview; it never applies anything.
- `srv` and `open` never appear together; `windowSearch` drops the other one. If both are written by hand, `srv` wins.
- The tab and every other parameter stay as they are, so a window opens over the current tab and a link to it can be shared.

**Functions**

- `parseWindow(search)` returns `{ kind, id, sec? }` or `null`.
- `windowSearch(search, target|null)` returns `"?…"` or `""`.
- `windowHref(href, target|null)`
- `windowTarget(kind, id, sec)`
- `sameWindow(a, b)` compares kind and id.
- `windowId(target)` returns `"server:opt11"`.

**Opening and closing**

- `open(target)` pushes a history entry `{...history.state, labWindow: token}`. It drops `kvmConsole`, and an old `view: {kind: pdu|kvm}` becomes `dashboard`.
- `open(target, { replace: true })` replaces the entry instead. Use it after a rename (`act.rekey`) and for "No server named X" → Open.
- Opening another window while one is open replaces it with a push, so Back returns to the previous window.
- `close()` calls `history.back()` when this page pushed the current entry. Otherwise it calls `replaceState` without `srv`, `open` and `sec`.
- Back, Escape and × all close the window. Escape and × wait while the window's `busyRef.current` is set.
- The provider re-reads the address on `popstate` and after every render, so a `pushState` from `navigate()` is seen too.
- An unknown key shows "No server named X" with a search box. An unknown kind opens nothing.

**Tab changes**

- `navigate()` and `selectRack()` in `App.jsx` drop `srv`, `open`, `sec`, `item` and `focus` (`WINDOW_DROP_PARAMS`).
- The twin's `replaceState` (`?select=`) keeps them.
- `act.showOnRacks(rack)` goes to `?tab=racks&rack=R` and keeps the window. It produces one history entry.

**Old history entries**

- `legacyViewTarget(history.state)` turns an old entry with `view: {kind: "pdu" | "kvm", id}` into `{kind: "dev", id}`.
- The provider rewrites the entry's address to `open=dev:<id>`, and App resets `view` to `dashboard`.

**Twin message**

- Two forms are accepted:
  - `{ type: "twin:open", target: { kind, id, sec?, moveTo?: { rack, u } } }`, where `TWIN_OPEN_MESSAGE` in `twinLinks.js` is `"twin:open"`;
  - v1's `{ type: "twin:open-server", key, sec?, moveTo? }`.
- `twinOpenRequest(data)` returns `{ target, moveTo }` or `null`.
- `App.jsx` accepts the message only when `event.origin === location.origin && event.source === twinFrameRef.current.contentWindow`.

**Assistant context**

- `assistantDetail(target, devices)` maps the open window to the assistant's kinds:
  - server → `{kind: "server", id}`;
  - dev → `pdu` or `kvm`;
  - unit → `item`;
  - rack → `rack`;
  - any other kind → `null`.

## 3. Provider (`window/LabWindowProvider.jsx`)

App mounts the provider once, around the page:

```jsx
<LabWindowProvider devices pduStatuses kvmStatuses maintenance apiRef={labWindowRef} onWindowChange={setWindowTarget}
  app={{ goTo, outletAction(device, n, action, confirmed), turnOnAll(device, numbers), openMaintenance(mode, pduId),
         saveLabels(id, labels, revision), markKvmFree(id), openConsole(deviceId, port), deleteDevice(id),
         switchFeeds(targets, action, opts), refresh() }}>
  <Header/>                      ← stays clickable while a window is open (a tab change closes it)
  <WindowBackdrop> …page… </WindowBackdrop>   ← aria-hidden + inert while a window is open
  …App's own dialogs (console z-[65], maintenance, What's new, assistant, footer)…
</LabWindowProvider>
```

App reaches the provider only through `apiRef.current = { open, openServer, close, current }`. App's `openDetail({kind: "pdu" | "kvm", id})` is `open({kind: "dev", id})`.

### 3.1 `useLabWindow()`

`useServerWindow` is the same hook.

```js
{
  open(target, { replace }), openServer(key, { sec, moveTo, swapWith, replace }), close(),
  current,          // { kind, id, sec?, moveTo?, swapWith? } | null
  index,            // buildLabIndex(data, role) while a window is open or useLabData("all") is mounted, else null
  twin,             // { data, etag } of GET /api/twin-data, or null
  servers,          // [{ key, name, rack, removed }] for pickers and search; removed servers for Admins only
  data,             // see 3.2
  ready,            // the server list has loaded
  errors,           // { storeName: text } for stores that failed to load
  reload(domains?), // reload the loaded stores (all, or those of these change-feed domains)
  act,              // see section 4 (window-agnostic parts)
  can,              // { operate, admin } of the signed-in account (legacy mode: both true)
  want(level),      // used by useLabData
  lastChange(key), dismissLastChange(key),
  dialog, closeDialog,   // the window's own open dialog: { type, ...props } (act.openDialog)
}
```

`useLabData(level = "all" | "servers")` returns the same value. While the component is mounted, the provider loads:

- `"servers"`: `GET /api/devices/locations`;
- `"all"`: every store in 3.2.

A component that shows lab data outside a window (the Manage page, a `ServerLink`, a search box) calls it. A window does not need it.

### 3.2 `data`

All reads below are Viewer reads.

| Field | Source |
|---|---|
| `devices`, `pduStatuses`, `kvmStatuses`, `maintenance` | App's own data |
| `locations` | `GET /api/devices/locations` body, with WP-B's `dcim_ids`, `drawn {rack,u,auto}\|null` and `removed` |
| `rackItems` | `GET /api/rack-items` document `{ rack: [item] }` |
| `owners` | `GET /api/opt-owners` `{ key: name }` |
| `switches` | `GET /api/switch-assignments` `{ dcim id: { switch, port } }` |
| `monitoring` | `GET /api/monitoring` (`targets[].server_key`) |
| `chillers` | `GET /api/chillers` `{ units, connections }` |
| `twin` | `{ data, etag }` of `GET /api/twin-data` |
| `removed`, `hidden` | `useRemovedServers()` data and its hidden `Set` |
| `engineers` | `useEngineers()` list |
| `etags` | `{ rackItems, switches, chillers, twin, removed }`: the If-Match of a later save |

Stores reload on the change feed:

| Domain | Stores reloaded |
|---|---|
| layout | locations, switches |
| devices | locations |
| removed | locations |
| monitoring | monitoring, locations |
| inventory | rackItems, chillers |
| owners | owners |
| twin | twin |

Previous data stays on screen while a store reloads. Wrap your saves in `act.during(fn)`. Never call `pokeChanges()`: the feed pokes itself after every successful write.

## 4. `act`

The provider gives the window-agnostic parts. `ServerWindow` adds the server-bound ones.

```js
// provider
open(target, opts), openServer(key, opts), close(),
openDelete(targets, { options, onDone }),   // the one DeleteDialog (lab/DeleteDialog.jsx), z-[60]
openDialog(type, props), closeDialog(),     // a window's own dialog; the window renders it (see 5.3)
toast(text, { undo, tone: "ok" | "error", timeout }),  // provider toasts, 15 s; undo() is the Undo button
showResult(key, result),                    // the "Last change" panel: result = { title, lines: [text] }
showOnRacks(rack), goTo(tab, target), showIn3d(ref),
during(fn), reload(domains?),
power: { enabled, groupFor(name), pending(key), request(name, action, opener, { scope, feedId }) },
app: { outletAction, turnOnAll, openMaintenance, saveLabels, markKvmFree, openConsole, deleteDevice, switchFeeds, refresh }

// server window (ServerWindow.jsx) on top of the above
openMove({ mode: "swap" | "move" | "takeover" | "pin", swapWith, moveTo })   // → dialog { type: "move", key, … }
openPorts()  → dialog { type: "ports", key }      openClear() → dialog { type: "clear", key }
rekey(newKey)            // replaceState to srv=<newKey> (after a rename, before the reload)
showResult(result)       // bound to this server's key
power: { group, pending, request(action, opener, { scope, feedId }) }   // bound to this server
openConsole(kvmPort)     // kvmPort from record.kvm: asks when the port is IN USE (App's openKvmConsole)
showIn3d(ref?)           // default serverRef(record.dcim_ids[0] ?? record.name); leaves for the Twin tab
showOnRacks(rack?)       // default the record's rack
```

`useServerPower` (`server/useServerPower.js`):

- It is the one power hook. WP-5 uses it for Racks too.
- Every request opens `PowerConfirmDialog`, Power on included and whatever `confirm_power` says.
- The plan is checked again on the latest readings before anything switches.
- The result is a provider toast.

## 5. Server window

### 5.1 Keys

`server/serverKey.js` provides:

- `NON_SERVER_LABEL`: byte for byte the regex in `DcimView.jsx`, `backend/app/ping_monitor.py` and `lab-twin/app.js`. A test keeps them equal.
- `isServerLabel(label)`
- `windowKey(label)`: returns `null` for `""`, `Outlet 3`, `Port 3` and placeholders. Otherwise it returns `serverIdentity(label)`, so `"OPTN45 (PSU2)"` gives `"optn45"`.

`server/ownerKey.js` provides:

- `ownerReadKeys(record)` and `ownerWriteKeys(record)`: `[key, ...dcim_ids]`, unique.
  - Write with `PUT /api/opt-owners/{key}` once per key, in this order.
  - Stop at the first failure and report which keys were saved.
  - Never call the unkeyed `PUT /api/opt-owners`: it is Admin only and replaces every owner. A test fails if a window file does.
- `ownerOf(record, owners)` returns `{ value, perKey, disagree }`.
- `switchOf(record, assignments)` returns `{ value: {switch, port} | null, perKey, disagree }`. It reads the DCIM ids, else the identity key.
- `withSwitch(assignments, record, value)` returns a new document with the value under every DCIM id. An empty value removes them.

### 5.2 Record

`server/serverRecord.js` `buildRecord(key, data)` is pure. `useServerRecord(key)` memoises it.

```js
{ key, name, dcim_ids,
  removed: null | { record /* GET /api/removed-servers entry */, active },
  drawn: { rack, u, auto } | null, rack, slot, kept_position,
  pdu: [{ device_id, device_name, port, label, state, watts, pduIp }],
  kvm: [{ device_id, device_name, port, label, inUse }],
  owner /* ownerOf */, switch /* switchOf */, monitor /* target | null */,
  units: [item] /* on (drawn.rack, drawn.u) when validFloor */, floorShared: [name], project /* productName(units[0]) */,
  powerGroup /* serverPowerGroup | null */, loading /* no /locations yet */, missing /* read, and no row and no removal record */ }
```

How some fields are filled:

- A removed server whose labels are gone (no /locations row) is built from its removal record. Its ports are the ones recorded at removal, and `drawn` is `null`.
- A /locations row with WP-B's `removed: true` is removed (`{ record: { key, name }, active: true }`) until the removal list arrives with the full record, so the window is read-only from the first read.
- Without WP-B's fields, `dcim_ids` and `drawn` are derived (`dcimIdsOf`, `drawnOf`).
- `placeText(record)` returns one of:
  - `"Rack-01 · floor 3"`
  - `"Storage-Main · shelf 3"`
  - `"Rack-01 · U 7, above the floors"`
  - `"Rack-02 · not drawn"`
  - `"Not on a rack"`
- `serverList(locations, { hidden, admin })` gives the pickers' list.

### 5.3 Composition (`ServerWindow.jsx`)

The window is composed of the following parts:

- **Header tools**: `<HeaderTools record can act/>`, rendered before ×.
- **Fact line**:
  - `placeText`;
  - `PDU 01 · outlet 3` for each outlet;
  - `KVM 01 · port 5`;
  - `Owner: …`;
  - `Project: …`.
- **Bar and More**: from `PACKAGES = [PlaceActions, RenameAction, PowerAction, RemoveAction]`, in that order.
- **Banner**: `RemoveAction.Banner`.
- **Body**:
  - the Last change panel;
  - Overview: `PlaceBlock`, `PowerBlock`, `OwnerNetworkBlock`;
  - "Units on this floor" (collapsible, open when it has units or `sec=units`): `UnitsSection`;
  - "Activity" (collapsible, closed unless `sec=activity`, rendered only while open): `ActivitySection`.
- **Delete…**:
  - `WindowShell` places it from `deleteTarget={{kind:"server", id:key}}` and `deleteRole="admin"`;
  - it goes in the bar when the server has no PDU or KVM port ("maybe gone"); otherwise it is last in More, in red;
  - it calls `act.openDelete`. Until WP-D, `DeleteDialog` uses `RemoveServerDialog` for one server.
- **Section links**:
  - `sec=move` opens `act.openMove({ mode, moveTo, swapWith })` once, for Operators;
  - `sec=delete` opens `act.openDelete` once, for Admins.

`can = { operate: canOperate && !record.removed?.active && !record.missing, admin: canAdmin }`. A removed window is read-only for every role; its bar says "Removed · read only".

Every action package default-exports an object:

```js
export default {
  Bar: ({ record, can, act }) => <>buttons</>,            // rendered only when can.operate
  more: ({ record, can, act }) => [MenuItem],              // a plain function, no hooks
  Dialogs: ({ dialog, record, can, act, close }) => el,    // renders its dialog when dialog.type ∈ dialogTypes
  dialogTypes: ["move", "ports", "clear"],                 // PlaceActions; RenameAction: ["rename"]
  Banner: ({ record, can, act }) => el | null,             // RemoveAction only
}
MenuItem = { id, label, onSelect(), tone?: "danger", separator?: true /* a line before it */, disabled?, title? }
```

The menu order is Pin (only when `drawn.auto`), Take over…, Choose ports…, Clear location…, Monitor settings, SSH settings, then the separator and Delete… (the shell adds it).

Sections are components `({ record, can, act })`. They render their own `<WindowSection title id>`, except `UnitsSection` and `ActivitySection`, which render only their content (`ServerWindow` wraps them).

The window's own dialogs:

- They use `useDialogFocus`, `z-[60]` and `data-dialog="…"`.
- Full-screen overlays that still use `z-50` (MaintenanceDialog) are lifted to 60 while a window is open (`window.css`).
- The KVM console layers are `z-[65]`.

### 5.4 ServerLink

`<ServerLink label="OPT23 (PSU1)"/>` or `<ServerLink serverKey="opt23">OPT23</ServerLink>`. React keeps the `key` prop for itself, so pass the key as `serverKey`.

- It is a button only for a server the provider knows (`windowKey` in `servers`). Otherwise it renders the text as it is.
- `sec` picks the part of the window to open on.
- Clicks stop propagation.

## 6. WindowShell (`window/WindowShell.jsx`)

```jsx
<WindowShell kind name state={{ word, tone }} badges tools facts bar more deleteTarget deleteRole maybeGone banner
  can size busyRef readOnlyText onClose>{blocks}</WindowShell>
```

**Props**

| Prop | Meaning |
|---|---|
| `kind` | `server`, `pdu`, `kvm`, `rack`, `unit`, `cooling` or `twin`; it becomes `data-window` |
| `state.tone` | `ok`, `warn`, `bad`, `off` or `unknown` |
| `badges` | `[text \| { text, tone }]`; at most 2 are shown, in the order given |
| `bar` | rendered only when `can.operate`; otherwise the line says `readOnlyText` (default "Viewer · read only") |
| `more` | `[MenuItem]` |
| `deleteRole` | `"operator"` (units, 3D-only records) or `"admin"` (servers, devices, racks, cooling units) |
| `size` | `"normal"` or `"wide"` (the PDU / KVM detail stubs: a centred sheet up to 1200 px at every width) |

**Element**

- `role="dialog"`, `aria-modal="true"`, labelled by the name `h2`, class `lab-window`, layer `z-[55]`.
- `useWindowFocus` is `useDialogFocus`'s behaviour, except that a window leaves every key to any other `aria-modal` element on screen: its own dialogs, the inline console, the maintenance dialog.
- It fires the window event `dcim-server-window` `{ open: true, kind }` when it opens.

**Width bands**

| Viewport | Layout |
|---|---|
| ≥ 1280 px with no `[data-assistant-panel]` | right drawer, 600 px, page visible and the header clickable |
| ≥ 1440 px | right drawer, also with the assistant panel open |
| below that | full-height sheet, max 720 px, centred |
| ≤ 640 px | full-screen sheet; the tools wrap |

There is no horizontal scroll at 1440, 1280, 1024, 390 or 375 px.

`<WindowSection title id collapsible defaultOpen>` is the body block. A collapsible section mounts its children only while it is open.

## 7. Other windows (the registry)

| Target | Component | Props |
|---|---|---|
| `server` | `server/ServerWindow` | `{ target, onClose }` |
| `dev` | `devices/DeviceWindow` → `PduWindow` / `KvmWindow`; a rack-kind device opens `RackWindow` for its rack | `PduWindow` / `KvmWindow`: `{ target, device, status, can, act, onClose }` |
| `rack` | `devices/RackWindow` | `{ target: { kind: "rack", id: rackName }, onClose }` |
| `unit` | `units/UnitWindow` | `{ target, onClose }`; `findUnit(rackItems, id)` is exported |
| `cooling` | `units/CoolingWindow` | `{ target, onClose }` |
| `twin` | `lab/TwinItemWindow` | `{ target, onClose }`; `findTwinRecord(doc, id)` is exported (`items[]`, `storage[]`, `setups[]`) |

Every window is keyed by `windowId(target)`, so another target starts a fresh component. Windows read their data with `useLabWindow()`.

Dialog stubs and their props:

| Dialog | Props |
|---|---|
| `AddDeviceDialog` | `{ kind?, rack?, racks, onClose, onAdded(device) }` (today: `AddDeviceModal`) |
| `DeviceEditDialog` | `{ device, onClose, onSaved }` |
| `CorrectRackDialog` | `{ device, onClose, onSaved }` |
| `AddUnitDialog` | `{ rack?, u?, onClose, onAdded(unit) }` |
| `DeleteDialog` | `{ targets: [{ kind, id }], options?, onClose, onDone(result) }`, `data-dialog="delete"` |

## 8. Manage index (`lab/labIndex.js`) and 3D links (`lab/twinRecords.js`)

```js
TYPES = ["server", "pdu", "kvm", "unit", "cooling", "rack", "other"]
PROBLEMS = ["unreachable", "maybe-gone", "deleted", "no-location", "single-feed", "missing-kvm", "missing-pdu", "free-ports", "not-in-lm"]
buildLabIndex(data, role /* "viewer" | "operator" | "admin" or { operate, admin } */) ->
  { rows: [{ uid, kind, type, id, name, rack, place, connection, state, owner, address, badges, problems: Set, twinIds, searchText,
             open: target, deleteTarget, deleteRole, bulkBlockedWhy }],
    counts: { total, types: { type: n }, problems: { problem: n } }, mismatch: { unlinked, total } }
filterRows(rows, { types, problem, q, rack })   // "deleted" rows show only under problem "deleted"
liveForTwin(data)                               // the live side of classifyTwin
classifyTwin(twinDoc, live) -> { linked: Map<twin id, uid>, only: [{ id, type, name, reason }] }
classifyTwinJson(twinDoc, live)                 // the same with linked as a plain object (the fixture's shape)
```

The uids are:

- `server:<key>`
- `dev:<device id>`
- `unit:<rack item id>`
- `cooling:<unit id>`
- `rack:<rack name>`
- `twin:<id>`

Server rows exist now. WP-M adds the rows of the other kinds with the same shape. The badges are "Monitor only", "Unit", "In 3D" and "Deleted":

- A server whose key is the identity of a computer or server rack item gets the badge "Unit". It opens and deletes as that unit (Operator).

`classifyTwin` implements the link rule exactly as `backend/tests/fixtures/twin_classify.json` pins it:

- The fixture's comparison of `only` ignores order.
- Chillers are one-to-one: each Lab Manager unit, in order, takes the first unlinked 3D chiller of its rack's setup (the twin's own rule).
- A record with no device id gets the reason "No PDU named X in Lab Manager".

## 9. Fixture (`tests/browser/preview-server.py`, lead only)

The flags are opt-in, so every older check keeps its fixture (`racks-ui.cjs` counts 9 racks):

- `DCIM_FIXTURE_ONE_PLACE=1`
- `FIXTURE_PXE_HOLD=1`, used with the first flag.

The runner command is:

```
bash run_suite.sh <worktree> <port> <suite.cjs> <dist> DCIM_FIXTURE_ONE_PLACE=1 [FIXTURE_PXE_HOLD=1] [POWER_PROTECTED_OUTLETS=pdu1:4]
```

With `DCIM_FIXTURE_ONE_PLACE=1` the fixture holds these states:

- **Rack-05 (PDU 05)**
  - Outlet 1 "OPT51" is on floor 1.
  - Outlet 2 "Spare" leaves floor 2 empty, with the floor's number on a placeholder.
  - Outlets 3 and 4 are "OPT53 (PSU1)" and "OPT53 (PSU2)": one server on floor 3 with two feeds.
    - The owners differ per feed: Alice Feed and Bob Feed.
    - The switch ports differ per feed: SW-05 ports 3 and 4.
    - Unit "Tray 53" is on floor 3, so the project is "Tray 53".
  - Floor 4 is empty and unlabelled.
- **Rack-06**: OPT61 and OPT62 share floor 1; OPT63 and OPT64 are on floors 2 and 3. All are pinned in `rack_slots`.
- **Auto-placed**: every other rack (for example OPT41) has `drawn.auto` true.
- **KVM 02** (`kvm2`, Rack-02): reachable. Port 1 is "OPT21" and port 2 is "OPT90", a KVM-only server. It has no 3D record.
- **KVM 03** (`kvm3`, Rack-03): unreachable and never read, so a move preview lists it as unchecked. Port 1 is "OPT31".
- **OPT96**: unplaced; only an empty rack override names it.
- **Removed servers**
  - OPT74 is removed: PDU 07 outlet 4 still names it, its monitor is paused, and the log has entries.
  - OPT98 is removed and relabelled away (PDU 06 outlet 4 says OPT64), so it has no /locations row.
- **PDU 04**: in maintenance, with every outlet off.
- **PDU-Rack-08** (`pdu8`, Rack-08):
  - no outlet count and no labels;
  - unreachable;
  - a notified `device-api:pdu8` alert and its mail "[DCIM alert] PDU-Rack-08: PDU API availability";
  - it links to `ITEM-0040` by name.
- **Monitors**
  - OPT11 has 60 checks and 2 closed incidents.
  - `optn85` is monitor-only: down and never up.
  - OPT300 is computer unit `u-pc300` on Rack-03 floor 2 with a monitor (badge "Unit").
  - "Lab printer" is a `device:` target.
- **Units and racks**
  - "Old NIC" (`u-old-nic`) on Rack-04 floor 3 was last seen 40 days ago.
  - `Rack-09` exists only as an empty unit list.
- **lab-data.json**: unchanged. That is the ids-mismatch case.

With `FIXTURE_PXE_HOLD=1`, job `fixture-pxe-hold` holds OPT21 (`active_key`), `kvm2:1` and PDU 02 outlet 1. It is in `install_started` with a far lease, so the runner never touches it.

The users are `viewer`, `operator` and `admin`, with the password `test-password-123` (`DCIM_TEST_ACCOUNTS=1`).

## 10. Interpretations made by WP-0

1. **Fixture flags.** The new fixture states sit behind `DCIM_FIXTURE_ONE_PLACE=1`. The v1 Accept requires `racks-ui.cjs` and the others to pass unchanged, and `racks-ui.cjs` asserts 9 racks, while v2 §F adds Rack-08 and Rack-09.
2. **Focus hook.** The shell uses `useWindowFocus`, not `useDialogFocus`. `useDialogFocus` stops Escape for every dialog on its stack, which would close the window under the inline console and the maintenance dialog, which handle Escape themselves. The dialogs a window opens still use `useDialogFocus`.
3. **The page behind a window is `aria-hidden` and `inert`.** The header stays outside, so a tab change still closes the window.
4. **Device details are windows.** The PDU / KVM detail pages render inside the shell (`size="wide"`) until WP-DW. Browser tests now scope the detail selectors to `[data-window]` (`pdu-kvm-detail.cjs`, `kvm-launch.cjs`).
5. **v1 to v2 names.** v1's `server/ServerWindowProvider.jsx`, `serverWindowUrl.js` and `server-window.css` are `window/LabWindowProvider.jsx`, `windowUrl.js` and `window.css` (v2 §I). v1's `pages/InventoryView.jsx` stub is `pages/ManageView.jsx`.
