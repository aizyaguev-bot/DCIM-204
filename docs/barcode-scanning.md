# Barcode scanning and shelf tracking

Open **Scan & Track** in Lab Manager, or append `?tab=scan` to the site URL.
This page uses the existing DCIM rack equipment records, including their serial
numbers. There is no separate scanner inventory to reconcile.

## Connect the scanner

1. Connect a USB scanner or pair a Bluetooth scanner in keyboard / HID mode with
   the computer displaying the site.
2. Configure the scanner to send **Enter** or **Tab** after each barcode. Use an
   English keyboard layout for the scanner's input.
3. Open Scan & Track and click **Focus scanner**. A manual barcode followed by
   Enter works as well.

The computer needs access to the lab site. A keyboard scanner does not need a
browser plugin, camera permission, or a direct connection to the Linux VM.
The physical scanner must support the barcode symbology on the equipment.

## Find and track equipment

- Scan the destination shelf, whole-rack or main-storage label first. The page
  displays the selected destination and asks for the equipment barcode.
- Scan an existing serial number, assigned barcode, or equipment ID to find its
  record. Matches are exact, case-insensitive strings; leading zeros are kept.
  The selected destination is kept instead of being replaced by the item's
  current saved location.
- Unknown codes can be linked to an existing rack item. Match the name, ID,
  rack and shelf before linking. Its serial number and other properties remain.
- To register equipment that is not in DCIM, enter its name, type, rack, shelf
  and optional position. It will appear in the DCIM rack view too.
- To change the destination, scan another label or select the rack and shelf manually.
  **Shelf 01 / U01 means the top shelf.** The optional position identifies a
  particular spot, for example `left / front`, `right`, or `slot A`.
- Review the proposed destination and click **Save and confirm location**.
  Scanning alone performs a lookup; it does not move equipment.
- The destination stays selected after saving, so scan another unit to place it
  there, then confirm that unit separately. Scan a new location label to change
  the destination. **Clear destination** clears the destination and pending item.
  Reloading the page or leaving Scan & Track also clears the selected destination.

Equipment-first scanning still works. When a destination is selected first,
unknown barcodes keep it during registration and linking. Linking a barcode only
links the equipment record; use **Save and confirm location** afterward to move
it. **Register equipment** creates a new item directly at the chosen destination.

The page tracks rack equipment, such as switches and independently registered
computers. Existing OPT records derived from PDU outlet labels and their cable,
power and KVM connections remain managed in DCIM. Inventory moves do not issue
power commands or change those connections.

## Location labels

Use **Location labels** to select a rack, a shelf range and an optional position,
then print. Attach the labels to the corresponding physical shelves or slots.
Short position names keep labels easy to scan. Labels use Code 128, rendered
locally with [JsBarcode](https://github.com/lindell/JsBarcode); generation works
without an external barcode service.

Each label encodes `LOC:<URL-encoded rack>:<shelf number>:<URL-encoded position>`.
The `LOC:` prefix is reserved for locations. A location label fills the proposed
destination; it still requires the save button. Rack names in labels must match
existing DCIM racks. Reprint labels after renaming a rack.

Select **Whole rack** to print `RACK:<URL-encoded rack>`. It selects the rack
without assigning a shelf (`u: 0`). You can then scan a shelf label to refine
the destination before saving. The existing `LOC:` shelf labels remain valid.

Select **Main storage (one label)** to print `STORE:MAIN`. It selects one shared
`Storage-Main` inventory location for the entire storage unit, without shelves
or positions. No new device credentials or PDU records are created. The same
equipment ID and history are kept when moving between a shelf, a whole rack and
main storage. Storage contents also appear in DCIM after the first item is saved.
The physical storage unit is whichever unit receives this single label; this
does not automatically map it to a cabinet in the 3D floor plan.

Rack and storage labels require the location-label update on the VM. Older
scanner versions only understand the `LOC:` shelf format. All three prefixes
(`LOC:`, `RACK:`, `STORE:`) are reserved and cannot be linked to equipment.

For the Lab 204 printable set, the physical model lists Rack-01 through Rack-07,
four shelves each except Rack-05 with three: 7 rack labels, 27 shelf labels and
one main-storage label. Rack-08 is marked planned/unplaced in that model and is
not included. Confirm the physical shelf counts before attaching the labels.
Print the A4 PDF at 100% / Actual size; its 92 x 46 mm cut lines are for plain
paper or full-sheet adhesive A4, not a particular pre-cut label stock.

## Shared state and history

Barcode, serial number, location, last scan confirmation and the latest 100
tracking events stay on the same record in `backend/rack_items.json`. Moves from
the DCIM equipment editor or 3D Twin also appear in the history. Existing
history is server-managed. Deleting a rack item also deletes that item's history.

Every scan reloads the current inventory. Use **Refresh** to reload a selected
item; switch to DCIM to see its saved shelf. The connected 3D Twin refreshes
inventory every 15 seconds when auto-refresh is enabled. Position within a shelf
appears as text in the Twin's Identity panel; the 3D layout depicts its shelf.

Writes are atomic and version checked. If another client changed the inventory,
the save is rejected with a message to refresh and review the destination.
Disconnected or failed writes display an error and do not show success.

## Install on the existing Linux VM

The repository includes a built frontend and `scripts/install-barcode.py`.
Use the existing `backend/.venv/bin/python`, not the VM's system Python 3.6.
The installer takes the full reviewed commit SHA and defaults to `~/DCIM-204`:

```bash
"$HOME/DCIM-204/backend/.venv/bin/python" /tmp/install-barcode.py FULL_COMMIT_SHA
```

Download the installer from that same reviewed commit first. It:

1. Verifies the repository and refuses staged changes, local source edits,
   diverged Git history or a port owned by an unrelated process.
2. Fetches the exact commit and tests it with an empty database on a temporary
   local port using the VM's Python environment.
3. Stops only the current user's uvicorn process in this project's backend
   directory on port 8000, then backs up `.env`, databases, runtime JSON files,
   deployment version and live Twin data under a private `.barcode-backups/`.
4. Fast-forwards the local checkout, restores the live Twin inventory and starts
   the backend in the background. No sudo or dependency installation is needed.
5. Checks the version and inventory endpoint. If startup fails, rolls back its
   update and restarts the old backend, provided no new source edits intervene.

The installer keeps the existing inventory and Python environment. Reload open
browser tabs after installation. It does not configure startup after a VM reboot.
Shutdown checks distinguish a running process from an exited process still listed
as a Linux zombie. The installer waits up to 20 seconds for graceful shutdown and
checks that port 8000 is free before changing application files. It does not
force-kill an existing backend. If shutdown finishes while an error is raised,
rollback restarts the previous backend when the port is free.

If installation stops because of local `frontend/package-lock.json` edits, use
`--backup-frontend-lock` to save that file under the private backup's
`local-source/frontend/package-lock.json` and install the reviewed lockfile.
The bundled frontend is already built; no npm install is performed on the VM.
The option preserves the original bytes for review and restores them if the
update fails. Staged changes and edits to any other source file still stop the
installer before the running backend is stopped.

For the barcode feature branch, fetch the installer and run it from the same
commit (without sudo):

```bash
cd "$HOME/DCIM-204" && git fetch origin feat/barcode-inventory && git show FETCH_HEAD:scripts/install-barcode.py | backend/.venv/bin/python - "$(git rev-parse FETCH_HEAD)" --backup-frontend-lock
```

## API compatibility

`GET /api/rack-items` still returns the existing rack-to-items mapping and now
includes an `ETag`. `PUT /api/rack-items` requires that ETag in `If-Match`, returns
the saved mapping and a new ETag, and records location changes. Missing versions
return 428; stale versions return 409. Updated DCIM and Twin clients use this
contract. Existing third-party writers must also send the version.

Scanner endpoints are `GET /api/inventory?code=...`, `POST /api/inventory`,
`POST /api/inventory/{id}/barcode`, and `POST /api/inventory/{id}/location`.
All writes use `If-Match`. When the shared site password is configured, scanner
endpoints and writes require the same site login; existing public metadata reads
remain available. Corrupt inventory and disk errors are surfaced, never treated
as a successfully saved empty inventory.

## Validation

```bash
cd backend
python -m pytest tests/ --ignore=tests/test_kvm_regression.py -q
cd ../frontend
npm run test:inventory
npm run build
```

Browser verification uses fake equipment to exercise keyboard input, Enter / Tab
suffixes, linking, registration, precise shelf moves, stale-session rejection,
network failures, reload persistence, DCIM shelf placement and printable labels.
Physical hardware scanning still requires a check with the user's scanner.
