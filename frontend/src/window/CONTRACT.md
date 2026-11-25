# Lab windows — the WP-0 contract

This file is the contract that the wave 1 and wave 2 packages build on. It covers WP-1, WP-2, WP-3, WP-D, WP-DW, WP-M, WP-5, WP-7, WP-4 and WP-8, and (section 11, v3 shelves) WP-S, WP-P and WP-5S.

- The specs are `C:/t/one-window-spec.md` (v1) and `C:/t/one-place-spec-v2.md` (v2). v2 is a delta on v1.
- `C:/t/one-place-spec-v3-shelf-ports.md` (v3) is a delta on both: shelves own the PDU outlets and KVM ports. Its frontend contract is section 11.
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
| `api/shelves.js` | v3 shelves: pure helpers and the `/api/shelves` requests (section 11) | lead (done) |
| `pages/ManageView.jsx` | stub: today's table via `DcimView section="inventory"` | WP-M |
| `backend/tests/fixtures/twin_classify.json` | the link rule's cases | WP-0 (WP-7 and WP-D read it) |

The tests are:

- `__tests__/server-window.test.js`
- `__tests__/window-url.test.js`
- `__tests__/twin-classify.test.js` (the frontend copy; WP-7 adds the twin copy)
- `__tests__/shelves.test.js` (v3, section 11)
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

`useLabData(level = "all" | "servers" | "shelves")` returns the same value. While the component is mounted, the provider loads:

- `"servers"`: `GET /api/devices/locations`;
- `"shelves"`: that and `GET /api/shelves` (v3, section 11);
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
| `shelves` | `GET /api/shelves` (v3, section 11): `null` while loading, `unavailableShelves()` without the backend |
| `removed`, `hidden` | `useRemovedServers()` data and its hidden `Set` |
| `engineers` | `useEngineers()` list |
| `etags` | `{ rackItems, switches, chillers, twin, removed }`: the If-Match of a later save |

Stores reload on the change feed:

| Domain | Stores reloaded |
|---|---|
| layout | locations, switches, shelves |
| devices | locations, shelves |
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
openAddServer({ rack, shelf, seat, name }, { onAdded }),   // v3: the add-server dialog (section 11.3)
toast(text, { undo, tone: "ok" | "error", timeout }),  // provider toasts, 15 s; undo() is the Undo button
showResult(key, result),                    // the "Last change" panel: result = { title, lines: [text] }
showOnRacks(rack), goTo(tab, target), showIn3d(ref),
during(fn), reload(domains?),
power: { enabled, groupFor(name), pending(key), request(name, action, opener, { scope, feedId }), blocked(name, scope) },   // blocked: v3, 11.6
app: { outletAction, turnOnAll, openMaintenance, saveLabels, markKvmFree, openConsole, deleteDevice, switchFeeds, refresh }

// server window (ServerWindow.jsx) on top of the above
openMove({ mode: "swap" | "move" | "takeover" | "pin", swapWith, moveTo, fixed })   // → dialog { type: "move", key, … }
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

## 11. Shelves (v3)

The spec is `C:/t/one-place-spec-v3-shelf-ports.md` (v3, a delta on v1 and v2; v3 wins). Shelves own the PDU outlets and KVM ports: the table `shelf_ports` gives each outlet or port at most one place (rack, shelf, seat) plus a feed number, and the label on the port stays the carrier of the server's name. The backend is WP-S (`backend/app/shelves.py`, `backend/app/routers/shelves.py`). This section is the frontend contract; it was built before WP-S, so every part of it fails soft.

**Decision 3: an unavailable or empty map means today's behaviour.**

- Without the backend, `data.shelves` is `{ unavailable: true, … }` (or `null` while it loads), every helper answers `null`, `[]` or `""`, and every caller behaves exactly as before.
- `hasShelfMap(shelves)` is true only when at least one outlet or port is assigned to a shelf. Use it to choose between the shelf flow and the legacy flow.
- The UI word is `placeWord(rack)` (`components/racks/floors.js`) until the WP-8 sweep (spec decision 12): "floor" on compute racks today, "shelf" on storage racks. Browser tests match `/(floor|shelf) N/`.

### 11.1 Backend shapes (spec §3.4, §4.1, §6)

**`GET /api/shelves`** (Viewer; never contacts a device; `ETag: <revision>`):

```
{revision, seeded:{at, finished_at}|null, seed_report:{…}|null,
 racks:[{rack, storage:bool, shelf_count,
   shelves:[{shelf, seats:[{seat, status:"used"|"empty"|"no-ports", mapped:bool,
     server:{key,name}|null, kvm_only:bool, stale_names:[name],
     pdu:[{device_id,device_name,port,feed,label}], kvm:{device_id,device_name,port,label}|null}]}]}],
 unmapped:{pdu:[{device_id,device_name,rack,port,label,free}], kvm:[…]},
 off_shelf:[{key,name,reason:"unplaced"|"monitor-only"|"above-shelves"|"kvm-only"|"not-assigned"|"conflict"}],
 problems:[{code,text,key?,place?}]}
```

- `free`: the label is blank, a default name or a placeholder (`empty|free|spare|n/a|-`). "KVM Power" and "PDU" are never free.
- Power state, watts and KVM in-use are not included: join them from `data.pduStatuses` / `data.kvmStatuses`.
- A conflict problem is code `"split"` with `key` (or `"split:<key>"`), with `places` or `place`.

**Changed endpoints** (WP-S):

| Endpoint | Adds |
|---|---|
| `GET /api/devices/locations` | each row: `place` = `{rack, shelf, seat, source: "shelf" \| "conflict", places?}` or `null`; each row port may carry `place` (or `null`: not a shelf port); `empty_ports.pdu[]/kvm[]`: `place`; top level: `shelves_revision` (**always present**, also for an empty map: the provider uses it to detect the backend) |
| `GET /api/devices` | each pdu/kvm: `places: {"<port>": {rack, shelf, seat, feed}}` |
| `POST /api/devices/move-server` | `target_place: {rack, shelf, seat?}` (WP-P) |

**`PUT /api/shelves/ports`** (Admin): `{revision, dry_run, plan_revision?, changes:[{device_id, port, place:{rack,shelf,seat,feed?}|null}]}`. The dry run answers `{plan_revision, changes:[{device_id,device_name,kind,port,label,before,after}], servers_moving:[{key,name,before,after}], warnings:[text]}`; the apply answers `{revision, changes}` (428 without `plan_revision`, 409 when stale or when the §4.3 guard refuses).

**`POST /api/shelves/add-server`** (Operator; Admin for `assign`, a new seat or `reuse_deleted`): `{name, rack, shelf, seat?, owner_id?, assign?:{pdu:[{device_id,port}], kvm:{device_id,port}|null}, reuse_deleted?, dry_run, plan_revision?}`.

- The dry run answers `{plan_revision, place:{rack,shelf,seat}, ports:[{device_id,device_name,kind,port,feed,before,after}], assigned:[…], monitor:"new"|"kept"|"resumed", owner:{id,name}|null, warnings:[text]}`.
- The apply answers `{key, name, place, ports, names}`.
- Refusals: 422 (name), 409 with a code (`deleted` with `{key, name, deleted_at, batch}`, `exists`, `taken`, `no_ports`), 403 (an Operator with `assign` or `reuse_deleted`).

**Refusal bodies.** `detail` is a string, a pydantic list, or an object `{code, text | message, …}`. The request helpers turn each into an `Error` (see 11.2).

### 11.2 `api/shelves.js` (pure helpers and request helpers; node --test imports it)

```js
// places and texts
normalizePlace(place) -> {rack, shelf, seat, feed?, source?, places?} | null     // seat defaults to 1
portKey(port) -> "3"                                  // decimal text without a leading zero
seatLetter(seat) -> "A" | "B" | … | "AA" | ""
placeText(place, { seats }) -> "Rack-05 · floor 3" | "Rack-06 · floor 1 · B" | ""   // seats > 1: seat 1 reads "· A"
shelfTag(place) -> "R05·S3" | "Storage-Main·S3" | "R06·S1·B" | ""                  // a rack without digits keeps its name
portPlace(device, port) -> {rack, shelf, seat, feed} | null                         // device.places of GET /api/devices
isFreePortLabel(label) -> bool                         // §6.1 free
seatPortsText(seat) -> "PDU 05 · outlets 3 and 4 · KVM 02 · port 3" | ""            // feed order

// the document
loadShelves() -> {revision, seeded, seed_report, racks, unmapped, off_shelf, problems, etag}   // 404 / not JSON: unavailableShelves()
unavailableShelves() -> {unavailable: true, revision: null, …, racks: [], unmapped: {pdu: [], kvm: []}, off_shelf: [], problems: [], etag: null}
normalizeShelves(body, etag) ; shelvesAvailable(locations) -> bool (shelves_revision is present) ; hasShelfMap(shelves) -> bool
findRack(shelves, rack) ; findSeat(shelves, { rack, shelf, seat = 1 }) -> seat | null
serverSeat(shelves, key) -> {rack, shelf, seat, seats, status, mapped, kvm_only} | null    // the seat that shows the server

// Add server and Assign (§7.1, §7.10)
pduServes(pdu, rack) -> bool                           // its own rack or "shared:<rack>" in its notes (split on ",", trimmed, exact)
freeShelfCandidates({devices, pduStatuses, shelves, rack, shelf}) -> {pdu:[…], kvm:[…], suggested:{pdu, kvm}}
//   candidate = { value: "<device_id>:<port>", kind, device_id, device_name, rack, port, label, own, text: "PDU 05 · outlet 2 · Spare" }
//   pdu: free unmapped outlets of the PDUs that serve the rack (own first, then shared); kvm: free unmapped ports of every KVM
//   (the rack's own first). From shelves.unmapped (free only); without it (no backend), from the devices (ports with no
//   places entry). A reachable PDU whose live name of the outlet is a server, "KVM Power" or "PDU" never offers it.
//   suggested.pdu: the one candidate whose label is a placeholder ("Spare", "empty") and whose number is the shelf's (the
//   old floorOutlet rule, shared PDUs included); null when none or two match. suggested.kvm: the same among the rack's own KVMs.
addServerBody(input) -> {name, rack, shelf, seat?, owner_id?, assign?, reuse_deleted?}   // accepts candidates and "<id>:<port>"
shelfPortChanges(changes) -> [{device_id, port, place|null}]

// requests (fetch; the account transport adds the CSRF header)
previewAddServer(body) ; addServer(body, planRevision)                       // POST /api/shelves/add-server, dry_run true / false
previewShelfPorts(changes, revision) ; saveShelfPorts(changes, revision, planRevision)   // PUT /api/shelves/ports
shelfError(status, body) -> Error { message, status, detail?, code?, info?, unavailable? }
//   message: the server's text (detail, or detail.text / detail.message); code and info: an object detail;
//   unavailable: a 404 "Not found" (the backend has no such route yet), message UNAVAILABLE_TEXT

// conflicts (§4.1 source "conflict", §7.11, §8.3)
placeConflicts(locations, shelves) -> Map key -> {key, name, places}       // rows with source "conflict", then "split" problems
conflictOf(conflicts, key) -> conflict | null                              // a Map, a plain object or a Set
conflictPowerReason(conflict) -> "Its outlets are on two floors; switch single outlets from the PDU window."
conflictBannerText(name, conflict) -> "OPT53's name is on outlets of two floors (Rack-05 · floor 3 and Rack-05 · floor 4). Whole-server power is off until this is fixed: open the PDU and assign or clear the outlet."
placePowerBlock(conflict, scope = "server") -> reason | null              // scope "feed" (one outlet) is never blocked
withPlaceConflict(group, conflict) -> {...group, placeConflict, wholeServerBlocked} | group
```

### 11.3 Provider (`window/LabWindowProvider.jsx`)

**`data.shelves`**

- A new store, `shelves`, reloaded on the `devices` and `layout` domains (the backend's `/api/shelves` rule records devices, layout, owners and monitoring).
- It is loaded lazily, like the others: while a window is open, under `useLabData("all")`, under the new level `useLabData("shelves")` (that is `locations` and `shelves`), and while the add-server dialog is open.
- `GET /api/shelves` is sent only when the `/locations` body names `shelves_revision`. Without it `data.shelves` is `unavailableShelves()`, with no request, so an older backend never logs a 404. It is `null` until `/locations` has loaded.
- A failure is `errors.shelves`; the previous document stays.

**`act.openAddServer({ rack, shelf, seat, name }, { onAdded })`**

- It opens the add-server dialog. Every part is optional (`windowUrl.js` `addServerTarget` cleans it). It is also `openAddServer` on the context value, and `apiRef.current.openAddServer`.
- `open({ kind: "add-server", rack, shelf })` does the same, so App's twin listener needs no change.
- The context value also has `adding`: the open request `{ rack, shelf, seat?, name?, seq }` or `null`.
- The dialog is shown to Operators and Admins only. A Viewer's request is dropped (and its `?add=server` removed from the address).
- The dialog is not a window: the open window stays, and the dialog sits above it (`z-[60]`).

**The dialog component** is WP-5S's `server/AddServerDialog.jsx`.

- The provider renders its default export lazily (`import.meta.glob`, so the build works without the file), with props `{ rack, shelf, seat, name, onClose, onAdded }`. It also passes `u` (= shelf) for WP-5's current dialog, which reads `{ rack, u }`.
- `data-dialog="add-server"`, `useDialogFocus`, a portal to `document.body`.
- On success the dialog shows the toast (§8.1), calls `onAdded(result)`, then `onClose()`, then `act.openServer(key)`. The provider's `onAdded` calls the opener's `onAdded` and reloads `devices` and `layout`.
- WP-5S reads `data.shelves` (call `useLabData("shelves")`) and uses `previewAddServer` / `addServer`, and `freeShelfCandidates` for the Admin assign sub-form.

**Power.** The provider passes `conflicts = placeConflicts(locations, shelves)` to `useServerPower` and adds `blocked` to `act.power`.

### 11.4 URL (`window/windowUrl.js`)

- `?…&add=server[&rack=R][&shelf=N]` opens the add-server dialog over the current tab and window. The provider reads it on load, on Back / Forward and after every render.
- Closing the dialog removes `add=` and `shelf=` from the address with `replaceState`. `rack=` stays, because on Racks it is the selected rack.
- `parseWindow` never returns this kind and `WINDOW_DROP_PARAMS` is unchanged.

```js
ADD_SERVER_KIND = "add-server" ; ADD_SERVER_PARAMS = ["add", "shelf"]
addServerTarget({ rack, shelf, seat, name }) -> { kind: "add-server", rack | null, shelf (1-99) | null, seat?, name? (≤ 80) }
parseAddServer(search) -> { kind: "add-server", rack, shelf } | null
addServerSearch(search, target | null) -> "?…"          // writes the request, or drops add= and shelf=
twinOpenRequest({ type: "twin:open", target: { kind: "add-server", rack, shelf } }) -> { target: { kind: "add-server", rack, shelf }, moveTo: null }
```

The twin's "Add server here" (WP-7) sends that message; App passes the target to `open()`.

### 11.5 Server record (`server/serverRecord.js`)

`buildRecord` adds these fields. Every one is `null` without the shelf backend or with an empty map (no outlet or port assigned to any shelf: `hasShelfMap` false; decision 3), and the rest of the record is unchanged.

| Field | Meaning |
|---|---|
| `place` | the row's `place` (`normalizePlace`): `{ rack, shelf, seat, source, places? }` or `null` |
| `placeConflict` | `{ key, name, places, text, reason }` when the server's name is on outlets of more than one seat (the row's `source: "conflict"`, or a `split` problem of `/api/shelves`), else `null`. `text` is the §8.3 banner and `reason` the power reason |
| `shelfSeat` | `serverSeat(data.shelves, key)`: the seat that shows the server, with `seats` (how many seats that shelf has) and `mapped`. `null` while the map is empty, where the backend lists every drawn server as `mapped: false` |
| `pdu[i].place`, `kvm[i].place` | `{ rack, shelf, seat, feed }` or `null`: the port's `place` in the row, else `device.places` |
| `powerGroup` | on a conflict it also carries `placeConflict` and `wholeServerBlocked` (the reason) |

`placeText(record)`:

- A server on one seat reads that seat: "Rack-05 · floor 3", or "Rack-06 · floor 1 · B" on a shared shelf.
- A legacy server drawn on a shelf whose outlets are not assigned to it reads "Rack-01 · floor 2 · outlets not assigned to this floor". Never on a storage rack (its shelves have no outlets by nature), and never while the map is empty.
- A conflict keeps the drawn place; the banner (WP-P) explains it.
- Without the backend, or with an empty map, the text is as before.

### 11.6 Power (`server/useServerPower.js`)

`useServerPower({ …, conflicts })` keeps every earlier field, and turns whole-server power off for a server whose outlets are on two seats (§7.11):

- `blocked(name, scope = "server")` returns the reason, or `null`.
- `groupFor(name)` returns the group with `placeConflict` and `wholeServerBlocked`, so the menus and the Racks pill can show the reason.
- `request(name, action, opener, { scope: "server" })` opens no confirmation. It shows the reason as an error toast and answers `"blocked"` (not `false`, so callers do not add "no PDU outlet").
- The switch checks again on the latest map and refuses: "… — nothing was switched."
- One outlet (`scope: "feed"`) stays switchable.

WP-P disables the whole-server items in `PowerAction` and `PowerBlock` with `record.placeConflict.reason` (or `act.power.group.wholeServerBlocked`), and shows the banner `record.placeConflict.text`.

### 11.7 Who uses what (spec §13)

| Package | Uses |
|---|---|
| WP-S | builds the backend shapes of 11.1 (`shelves_revision` always on `/locations`) |
| WP-P | `record.place`, `placeConflict`, `pdu[i].place`, `act.power.blocked`; `target_place` moves |
| WP-5S | the dialog props of 11.3, `useLabData("shelves")`, `previewAddServer`, `addServer`, `freeShelfCandidates`, `seatPortsText`, `act.openAddServer` everywhere |
| WP-DW | `portPlace`, `placeText`, `findSeat`, `previewShelfPorts`, `saveShelfPorts`, `act.openAddServer({ rack, shelf, seat })` |
| WP-M | `data.shelves` (`off_shelf`, `problems`, `seed_report`), `act.openAddServer({})` |
| WP-7 | the twin message of 11.4 |
| WP-4 | `shelfTag(portPlace(device, port))` |
| lead | `tests/browser/preview-server.py` `DCIM_FIXTURE_SHELVES=1`, after WP-S |

### 11.8 Interpretations made by the lead

1. **Detecting the backend.** The provider asks `GET /api/shelves` only when `/locations` names `shelves_revision` (spec §3.3), so today's fixture and an older VM never see a 404 in the console. `loadShelves()` called directly still turns a 404 into `unavailableShelves()`.
2. **Add server is a dialog, not a window.** It opens over the open window, and the server window opens after a successful add. `parseWindow` ignores `add=`.
3. **Conflict power.** Only whole-server requests are refused, as the spec's "whole-server power" says; a single feed stays switchable in the server window too. The refusal is a toast, because `PowerConfirmDialog` (WP-5's file) has no room for an outside reason.
4. **Seat letters.** `placeText` shows the letter for seat 2 and up, and for seat 1 only when it is told the shelf has more than one seat. `shelfTag` writes "R06·S1·B".
5. **Pre-selection.** `suggested.pdu` follows the old `floorOutlet` rule over the PDUs that serve the rack, shared ones included, so two matches (one on a shared PDU) pre-select nothing. `suggested.kvm` looks at the rack's own KVMs only.
6. **An empty map is no map.** With WP-S installed but nothing in `shelf_ports`, `GET /api/shelves` lists every drawn server as `used, mapped: false`. Screens use `hasShelfMap` before acting on `mapped: false` (the record's `shelfSeat` is `null` then), so the fixture without `DCIM_FIXTURE_SHELVES` reads exactly as before.
