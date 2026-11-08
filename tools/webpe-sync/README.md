# webpe SN analysis -> DCIM: the contract for the laptop tool

The lab owner wants every serial number (SN) in the lab looked up on the internal **SN analysis** page of
webpe.nvidia.com, so each unit gets its product name and part number (P/N) in DCIM. webpe needs NVIDIA SSO, so the
lookup runs as a browser tool on the owner's laptop. **This folder holds no webpe code yet**; it describes what DCIM
offers that tool. Everything here also works by hand today from **Scan & Track > Serial numbers** in the site.

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
