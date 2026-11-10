# webpe SN analysis -> DCIM: the contract for the laptop tool

The lab owner wants every serial number (SN) in the lab looked up on the internal **SN analysis** page of
webpe.nvidia.com, so each unit gets its product name and part number (P/N) in DCIM. webpe needs NVIDIA SSO, so the
lookup runs as a browser tool on the owner's laptop. `sync.cjs` here is that tool (see "Automatic lookup" and "Sync tool" at
the end); the rest describes what DCIM offers it. Everything here also works by hand today from **Scan & Track > Serial numbers** in the site.

## The flow

1. Sign in to DCIM (an Operator or Admin account).
2. `GET /api/inventory/serials` - every unit with a serial number or barcode, switches first.
3. For each `serial` (or `barcode` when `serial` is empty): open SN analysis on webpe, **choose "Switch"** as the
   product kind (`lookup_as` is `"switch"` on every row: the lab's serials are mostly switches), enter the SN and read
   the product name / description and the P/N.
4. `POST /api/inventory/serial-details` with `"dry_run": true` and `"mark_switch": true` - DCIM reports what would
   change per SN, writes nothing.
5. Show (or log) that report, then send the same items and options with `"dry_run": false` and `If-Match` = the `ETag` of the
   dry-run answer. All rows are applied together, or none.

## Signing in

DCIM uses its normal accounts; there is no separate token.

```
POST /api/auth/login        {"username": "...", "password": "..."}
-> 200 {"user": {...}, "csrf_token": "..."}   and a session cookie "dcim_session" (HttpOnly)
```

- Keep the cookie for every later request, and send `X-DCIM-CSRF: <csrf_token>` on every POST.
- Do not send a foreign `Origin` header (a cross-origin POST is refused with 403). A script that sends no `Origin`
  is accepted.
- The credentials come **only from environment variables the owner sets on the laptop**, for example
  `DCIM_URL`, `DCIM_USERNAME`, `DCIM_PASSWORD`. Never write them into a file in this repository, never print them,
  and never put them in a log or a report. (`.env` files are ignored by git, but environment variables are preferred.)
- Use a personal Operator account; a Viewer can read the export but gets 403 on `serial-details`.
- `POST /api/auth/logout` at the end.

## GET /api/inventory/serials (Viewer and up)

```json
{"lookup_as": "switch",
 "items": [{"serial": "MT2614X00001", "barcode": "", "name": "Unit", "type": "other", "part_number": "",
            "model": "", "rack": "Rack-02", "u": 30, "position": "", "place": "Rack-02 · U30",
            "lookup_as": "switch"}]}
```

Units without a serial number but with a barcode are listed with `serial: ""` and their `barcode`; look that barcode
up as the SN (it is matched the same way below). The response has an `ETag` (the inventory revision).

`GET /api/inventory/serials.csv` is the same list as a CSV file (columns `serial, barcode, name, type, part_number,
model, rack, u, position, place, lookup_as`; a cell starting with `= + - @` gets a leading `'`, so a spreadsheet does
not run it as a formula).

## POST /api/inventory/serial-details (Operator and up)

Request:

```json
{"dry_run": true, "overwrite": false, "mark_switch": true,
 "items": [{"serial": "MT2614X00001", "name": "Spectrum SN2700 switch", "part_number": "MSN2700-CS2F",
            "model": "SN2700", "source": "webpe SN analysis"}]}
```

- `serial` is required (1-200 characters); every other field is optional. Leave a field out when webpe did not show
  it - an empty value never clears anything.
- `mark_switch` (request option, default false): the serial numbers were looked up as "Switch", so a matched unit
  nobody identified yet - no type, or `other` with a generic name such as "Unit" or its own code - becomes a switch.
  This is the normal way to mark switches; send it as `true` together with the dry run and the apply.
- `type` (per row, optional): send it only when the SN analysis result itself names the product kind. A value with
  the word "switch" ("Switch", "Ethernet Switch", "Switch system"; not "non-switch" or "switchgear"), or a `name`
  (description) with that word, makes a unit of type `other` or empty a switch even when it has its own name. Do not
  add `"switch"` to every row - use `mark_switch` instead.
- A unit identified as something else is never made a switch, whatever the row or `mark_switch` says: any real type
  (`pdu`, `cable`, `nic`, `server`, `psu`...), a looked-up `type` that is not a switch, a name that is another kind's
  label ("PDU", "Cable", "Server"...), or a NIC / adapter - a name, model or description with NIC, adapter, ConnectX,
  HCA, BlueField or DPU, or an MCX / MBF / ConnectX part number (the scanner stores a NIC as `other` named
  "ConnectX-7 NIC"). The row then says `type_kept`, for example `"kept type other: it is a NIC or adapter by its name
  or part number, not a switch"`.
- `name` is the product name / description (cut to 160 characters). `part_number` and `model` up to 120 characters.
- `source` (up to 80 characters) is written into the unit's history note; default "webpe SN analysis".
- At most 5000 items per request. A row with control characters or a too-long serial / P/N refuses the whole request
  (422) and nothing is written.

What DCIM does per row:

- Matches the unit by its serial number or its barcode, compared like a scan (case, surrounding spaces and MAC
  spelling do not matter). A code that names two units is `ambiguous`.
- `part_number`: set when the unit has none or a different one (the old value is in the report).
- `name`: set only when the unit's current name is generic - empty, a type label such as "Unit" or "Switch", or the
  unit's own serial, barcode or part number. A name somebody typed is kept (the row says `name_kept`) unless
  `overwrite: true`.
- `model`: set when the unit has none (or always with `overwrite: true`).
- `type`: set to `switch` as described above (`mark_switch`, the row's own `type` or a description with "switch").
- A unit without a serial number, matched by its barcode, also gets that barcode (as the unit spells it) as its
  serial number.
- Each changed unit gets a history entry "details updated", note "Details from webpe SN analysis: Part number, Name, ...".
  Its place, notes and every other field stay as they are.

Response (the same for a dry run, which writes nothing):

```json
{"dry_run": true, "overwrite": false, "mark_switch": true,
 "counts": {"updated": 1, "unchanged": 0, "not_found": 0, "ambiguous": 0},
 "results": [{"serial": "MT2614X00001", "status": "updated",
              "unit": {"id": "...", "rack": "Rack-02", "u": 30, "position": "", "name": "Unit", "type": "other",
                       "serial": "MT2614X00001", "barcode": "MT2614X00001", "part_number": "", "model": ""},
              "changes": {"part_number": {"before": "", "after": "MSN2700-CS2F"},
                          "name": {"before": "Unit", "after": "Spectrum SN2700 switch"},
                          "type": {"before": "other", "after": "switch"}}}]}
```

`status` is one of:

| status      | meaning |
|-------------|---------|
| `updated`   | the unit changes as listed in `changes` (in a dry run: would change) |
| `unchanged` | the unit already has these details |
| `not_found` | no unit has this serial number or barcode |
| `ambiguous` | more than one unit has it (`units` lists them; fix the duplicate in DCIM), or the request lists this SN twice; nothing is applied for it |

Concurrency: `If-Match` is required when `dry_run` is false (428 without it). It must be the `ETag` of the dry-run
answer (or of `GET /api/inventory/serials`). If the inventory changed meanwhile the answer is 409 and nothing is
written: run the dry run again, review, apply. A dry run accepts `If-Match` too and then refuses a stale one the same way.

## Rules for the laptop tool

- Dry run first, always; apply only what the dry run showed.
- Never change anything on webpe; only read SN analysis results.
- Keep webpe pages, cookies and the DCIM password out of this repository and out of logs.
- Without the tool: export the list in Scan & Track > Serial numbers ("Copy serial numbers" gives one SN per line),
  look them up as Switch on webpe, copy the result table (SN, P/N, Description) and paste it into "Import details".

## Sync tool (`sync.cjs`)

Runs on the owner's laptop and uses the owner's own signed-in browser sessions; it reads no password and stores no
cookie.

1. Open a dedicated Edge window with remote debugging on the local machine only:
   `msedge --user-data-dir=%LOCALAPPDATA%\webpe-profile --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1`
2. In that window sign in to webpe.nvidia.com (SN analysis page) and to DCIM (Operator or Admin), one tab each.
3. `node tools/webpe-sync/sync.cjs` - dry run: lists, per unit with a serial number or barcode, what webpe returns
   and what would change, and writes `sync-dry-run.csv` (in `SYNC_REPORT_DIR` or the current folder).
4. `node tools/webpe-sync/sync.cjs --apply` - saves: P/N, model (product line), type switch when webpe describes a
   switch, and the product name only where the unit's name is generic (its code, "Unit", "<type> <code>"). One
   whole-list save with `If-Match`, so a change made meanwhile on the site stops it instead of being overwritten.
   Report: `sync-applied.csv`. Run the dry run again afterwards: it should report 0 units to change.

The DCIM address comes from `DCIM_URL` (or `vm_site` in the git-ignored `.team/ops/release.local.json`).

## Automatic lookup (`start-webpe-sync.cmd`)

Every unit added to DCIM with a serial number (or barcode) and no P/N gets its P/N, model, product name and type
switch from webpe within a minute, without running anything by hand. It runs on the lab laptop, because only that
laptop can sign in to webpe.

The owner's steps, once:

1. Double-click `tools\webpe-sync\start-webpe-sync.cmd` (or run `start-webpe-sync.cmd --install-startup` once, so it
   also starts by itself at every sign-in to Windows).
2. An Edge window opens with its own profile (`%LOCALAPPDATA%\webpe-profile`) on two tabs: DCIM and webpe. Sign in to
   both there (DCIM with an Operator or Admin account). The profile remembers the sign-ins; keep that window open
   (minimized is fine).
3. Done. Scan & Track > Serial numbers and the scan dialog show "webpe auto lookup: Active · last check 10:05 · 3 looked
   up today". "webpe sign-in needed on the lab laptop" means: sign in to webpe again in that Edge window. "Not running"
   means: start `start-webpe-sync.cmd` again.

What it does: `node sync.cjs --watch` checks every 20 seconds (`WEBPE_INTERVAL`). It reads `GET /api/inventory/serials`
in the DCIM tab, looks up each unit that has a serial number or barcode and no P/N with the webpe tab's own session,
and saves the found ones with `POST /api/inventory/serial-details` (`mark_switch`, no `overwrite`, `If-Match`; on 409 it
reads again and retries once). Only those units' rows are sent, so a name someone typed is kept. Name = the product
(first part of the description), model = product line, type switch when the description says SWITCH - the same rule
as the one-shot sync. After every check it reports to `PUT /api/inventory/webpe-status`, which the site shows (Active
while a report came within 3 intervals); a long check (up to 25 lookups, a slow webpe) also reports once per interval
while it runs, so the site keeps saying Active.

- It remembers what it looked up in `%LOCALAPPDATA%\webpe-sync\state.json`: an SN webpe does not know is asked again
  after 6 hours, an SN that failed after 5 minutes; a signed-out webpe marks nothing, so those units are looked up right
  after signing in again. A broken or hand-edited state file is not a problem: bad entries are dropped and looked up
  again.
- If DCIM refuses what webpe gave for one unit (a P/N longer than 120 characters, say), the units of that check are
  saved one by one: the others are filled, the refused one is reported ("DCIM refused the webpe details of ...") and
  asked again after 6 hours. Control characters are removed from webpe text, and a product line DCIM cannot store is
  left out.
- Signed out of webpe (401, a redirect to the sign-in page, or a page instead of data): it reports "webpe sign-in needed"
  and keeps waiting. Signed out of DCIM: it cannot report to the site (the site then says "Not running"); the window
  of the tool says "DCIM sign-in needed".
- No password, cookie or token is read, printed or stored: the lookups and saves run inside the two signed-in tabs.
- Edge's remote debugging listens on 127.0.0.1 only. `WEBPE_CDP_PORT` (default 9333), `DCIM_URL` (default `vm_site` in
  `.team/ops/release.local.json`) and `WEBPE_PAGE` (the page the webpe tab opens; the SN analysis page) can be set
  before starting. The first start installs `playwright-core` (the library only, no browser download) into
  `%LOCALAPPDATA%\webpe-sync\node` when Playwright is not installed. Node.js must be installed.
- To stop it: close the "webpe auto lookup" window. To stop starting it at sign-in: delete "webpe auto lookup" from the
  Startup folder (`shell:startup`).

Test: `tests/browser/webpe-auto.cjs` runs all of this against a local mock of webpe and the test fixture
(`WEBPE_CDP` and `WEBPE_ORIGIN` point the tool at them).
