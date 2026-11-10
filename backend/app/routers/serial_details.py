"""Serial numbers of the lab's units, out and back in: an export of every unit that has a serial number or barcode,
and applying details looked up by serial number elsewhere (product name, part number, model, switch type), for
example from the "SN analysis" page of an internal site. Uses the same records, revision (ETag / If-Match) and
history as the scanner and DCIM."""
import csv
from copy import deepcopy
from datetime import datetime, timezone
import io
import json
import re

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .. import inventory_store as store
from .inventory import set_headers

router = APIRouter(prefix="/api/inventory", tags=["inventory"])

MAX_ROWS = 5000
NAME_MAX = 160
SOURCE_DEFAULT = "webpe SN analysis"
# The serial numbers are looked up as this product kind on the SN analysis page: the lab's serials are mostly switches.
LOOKUP_AS = "switch"
EXPORT_FIELDS = ("serial", "barcode", "name", "type", "part_number", "model", "rack", "u", "position", "place", "lookup_as")
# The names a unit gets when nobody named it: the scanner's type labels (scanParse.js TYPE_LABELS, plus "NIC") and
# the stored type values. A unit whose name is one of these, or its own code, serial or part number, has no real name.
GENERIC_NAMES = {name.casefold() for name in (
    "Unit", "Switch", "Cable", "PDU", "KVM", "UPS", "Computer", "Patch panel", "NIC", "Other", "Server", "Item",
    "Equipment", "patchpanel", "New unit", "New item", "Unknown")}
DUPLICATE_ROW = "This serial number is listed more than once in the request; none of its rows were applied."
AMBIGUOUS = "More than one unit has this serial number or barcode. Resolve the duplicate in DCIM first."
NAME_KEPT = "The unit already has its own name, so it was kept; overwrite=true replaces it."
# Types that say nothing about the product: only a unit of one of these can become a switch (a PDU, cable, NIC, server
# or any other real type stays what it is).
GENERIC_TYPES = {"", "other"}
# Looked-up row types that do not identify the product either ("Other", "Unit"): they neither mark nor block a switch.
GENERIC_ROW_TYPES = {"", "other", "unit", "unknown", "n/a", "na", "-"}
# A name, model or description that says the unit is a network adapter, not a switch. The scanner stores a NIC as type
# "other" named "ConnectX-7 NIC" (scanParse.js), so the name and part number are the only signs it is not a switch.
NOT_SWITCH_NAME = re.compile(r"(?<![a-z0-9])(?:super)?nics?(?![a-z0-9])|(?<![a-z0-9])adapters?(?![a-z0-9])|connect-?x"
                             r"|(?<![a-z0-9])hcas?(?![a-z0-9])|bluefield|(?<![a-z0-9])dpus?(?![a-z0-9])", re.IGNORECASE)
# NVIDIA / Mellanox adapter part numbers: MCX... ConnectX NICs, MBF... BlueField DPUs.
NOT_SWITCH_PART = re.compile(r"^\s*(?:MCX|MBF)|connect-?x", re.IGNORECASE)
NIC = "a NIC or adapter by its name or part number"
# Type labels of other kinds (GENERIC_NAMES): a unit of type "other" named "PDU" or "Server" is identified by its name.
KIND_NAMES = {name.casefold() for name in ("Cable", "PDU", "KVM", "UPS", "Computer", "Patch panel", "patchpanel", "Server")}


class SerialDetail(BaseModel):
    serial: str = Field(min_length=1, max_length=store.DETAIL_LIMITS["serial_number"])
    name: str | None = Field(default=None, max_length=1000)
    part_number: str | None = Field(default=None, max_length=store.DETAIL_LIMITS["part_number"])
    type: str | None = Field(default=None, max_length=60)
    model: str | None = Field(default=None, max_length=store.DETAIL_LIMITS["model"])
    source: str | None = Field(default=None, max_length=80)

    @field_validator("serial")
    @classmethod
    def clean_serial(cls, value):
        value = store.clean_detail("serial_number", value)
        if not value:
            raise ValueError("Serial number is required")
        return value

    @field_validator("part_number", "model")
    @classmethod
    def clean_detail(cls, value, info):
        return None if value is None else store.clean_detail(info.field_name, value)

    @field_validator("name", "type", "source")
    @classmethod
    def clean_text(cls, value, info):
        if value is None:
            return None
        # Pasted table cells may carry tabs or line breaks; whitespace runs become one space.
        value = " ".join(value.split())
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError(f"{info.field_name} cannot contain control characters")
        # A looked-up product description can be longer than a unit name; it is cut, not refused.
        return value[:NAME_MAX].rstrip() if info.field_name == "name" else value


class SerialDetailsRequest(BaseModel):
    items: list[SerialDetail] = Field(min_length=1, max_length=MAX_ROWS)
    dry_run: bool = False
    overwrite: bool = False   # True: the looked-up name and model replace a unit's real (non-generic) name and model too
    # True: a matched unit that is not identified yet (no type, or "other" with a generic name) becomes a switch, because
    # the serial numbers were looked up as Switch. A unit identified as something else (a NIC by its name or part
    # number, or any real type: PDU, cable, server...) keeps its type, and the report says so (type_kept).
    mark_switch: bool = False


def generic_name(item):
    """True when the unit's name says nothing about the product: empty, a type label, or its own id, code, serial or
    part number (the scanner names a unit after its part number when it knows nothing else)."""
    name = " ".join(str(item.get("name") or "").split())
    if not name or name.casefold() in GENERIC_NAMES or name.casefold() == str(item.get("type") or "").casefold():
        return True
    key = store.identity_key(name)
    own = store.identity_keys(item) | {store.identity_key(item.get("part_number"))}
    return key in own - {""}


def is_switch(value):
    """True for a type that names a switch ("switch", "Ethernet Switch", "Switch system"), not "non-switch" or "switchgear"."""
    return bool(value) and re.search(r"(?<![\w-])switch(es)?(?![\w-])", value, re.IGNORECASE) is not None


def not_switch_reason(item, row):
    """Why the unit is known not to be a switch, or None: a real type other than switch, a looked-up type other than
    switch, or a NIC / adapter name or part number (the unit's own or the looked-up one)."""
    current = str(item.get("type") or "").strip()
    if current.casefold() not in GENERIC_TYPES | {"switch"}:
        return f"it is a {current}"
    looked_up = str(row.type or "").strip()
    if looked_up.casefold() not in GENERIC_ROW_TYPES and not is_switch(looked_up):
        return f"it was looked up as {looked_up}"
    for name in (item.get("name"), row.name):
        if " ".join(str(name or "").split()).casefold() in KIND_NAMES:
            return f"it is named {name}"
    names = (item.get("name"), item.get("model"), row.name, row.model)
    parts = (item.get("part_number"), item.get("model"), row.part_number, row.model)
    if any(NOT_SWITCH_NAME.search(str(v or "")) for v in names) or any(NOT_SWITCH_PART.search(str(v or "")) for v in parts):
        return f"it is {NIC}"
    return None


def switch_change(item, row, mark_switch):
    """(make_switch, type_kept note): whether the unit becomes a switch, and when a switch was asked for (by the row or
    by mark_switch) but the unit keeps its type, a note that says which type it keeps and why."""
    current = str(item.get("type") or "").strip()
    if current.casefold() == "switch":
        return False, None
    # The looked-up row says so: its type, or a product name / description with the word "switch".
    said = is_switch(row.type) or is_switch(row.name)
    if not (said or mark_switch):
        return False, None
    kept = f"kept type {current or '(none)'}"
    reason = not_switch_reason(item, row)
    if reason:
        return False, f"{kept}: {reason}, not a switch"
    # mark_switch alone marks only a unit nobody identified yet: no type, or "other" with a generic name (or its own
    # name that says switch).
    if said or generic_name(item) or is_switch(str(item.get("name") or "")):
        return True, None
    return False, f"{kept}: the unit has its own name; a looked-up type or description that says Switch changes it"


def match_index(data):
    """{identity key: [(rack, item)]}: each unit under its serial number and under its barcode, compared the way a scan
    compares codes, so a unit is found by either one (a code that names two units is ambiguous)."""
    index = {}
    for rack, items in data.items():
        for item in items:
            keys = {store.identity_key(item.get(field)) for field in ("serial_number", "barcode")
                    if isinstance(item.get(field), (str, int))} - {""}
            for key in keys:
                index.setdefault(key, []).append((rack, item))
    return index


def unit_view(rack, item):
    return {"id": item["id"], "rack": rack, "u": item.get("u"), "position": item.get("shelf_position", ""),
            "name": item.get("name", ""), "type": item.get("type", ""), "serial": item.get("serial_number", ""),
            "barcode": item.get("barcode", ""), "part_number": item.get("part_number", ""), "model": item.get("model", "")}


def planned_changes(item, row, overwrite, mark_switch=False):
    """{field: (before, after)} that `row` makes to `item`; nothing for a value the row does not carry."""
    return plan(item, row, overwrite, mark_switch)[0]


def own_serial(item, row):
    """The serial number a unit found by its barcode gets: its own barcode as stored (the row may spell the code in
    another case or as another MAC spelling); the row's spelling only when the barcode cannot be stored as one."""
    barcode = str(item.get("barcode") or "").strip()
    usable = (barcode and len(barcode) <= store.DETAIL_LIMITS["serial_number"]
              and not any(ord(c) < 32 or ord(c) == 127 for c in barcode)
              and store.identity_key(barcode) == store.identity_key(row.serial))
    return barcode if usable else row.serial


def plan(item, row, overwrite, mark_switch=False):
    """({field: (before, after)}, type_kept note or None) for `row` applied to `item`."""
    changes = {}
    if row.part_number and item.get("part_number") != row.part_number:
        changes["part_number"] = (item.get("part_number", ""), row.part_number)
    if row.model and item.get("model") != row.model and (overwrite or not str(item.get("model") or "").strip()):
        changes["model"] = (item.get("model", ""), row.model)
    if row.name and item.get("name") != row.name and (overwrite or generic_name(item)):
        changes["name"] = (item.get("name", ""), row.name)
    make_switch, type_kept = switch_change(item, row, mark_switch)
    if make_switch:
        changes["type"] = (item.get("type", ""), "switch")
    # A unit without a serial number was found by its barcode: that code is its serial number, so it is recorded as one.
    if not item.get("serial_number"):
        changes["serial_number"] = ("", own_serial(item, row))
    return changes, type_kept


LABELS = {**store.DETAIL_LABELS, "name": "Name", "type": "Type"}


@router.post("/serial-details")
async def apply_serial_details(body: SerialDetailsRequest, response: Response, if_match: str | None = Header(default=None)):
    """Apply details looked up by serial number. Every row is matched by a unit's serial number or barcode, compared
    the way a scan compares codes. All rows are applied together or none: a stale If-Match is 409
    and nothing is written. dry_run=true returns the same report and writes nothing (If-Match is then optional)."""
    with store.locked_items() as data:
        if if_match or not body.dry_run:
            store.check_revision(data, if_match)
        index = match_index(data)
        keys = [store.identity_key(row.serial) for row in body.items]
        repeated = {key for key in keys if keys.count(key) > 1} if len(set(keys)) != len(keys) else set()
        report, plans = [], []
        for row, key in zip(body.items, keys):
            entry = {"serial": row.serial}
            found = index.get(key, [])
            if key in repeated:
                entry.update(status="ambiguous", detail=DUPLICATE_ROW)
            elif not found:
                entry.update(status="not_found", detail="No unit has this serial number or barcode.")
            elif len(found) > 1:
                entry.update(status="ambiguous", detail=AMBIGUOUS, units=[unit_view(rack, item) for rack, item in found])
            else:
                rack, item = found[0]
                changes, type_kept = plan(item, row, body.overwrite, body.mark_switch)
                entry["unit"] = unit_view(rack, item)
                if changes:
                    entry.update(status="updated", changes={field: {"before": before, "after": after} for field, (before, after) in changes.items()})
                    plans.append((rack, item, row, changes, entry))
                else:
                    entry["status"] = "unchanged"
                if row.name and "name" not in changes and item.get("name") != row.name:
                    entry["name_kept"] = NAME_KEPT
                if type_kept:
                    entry["type_kept"] = type_kept
            report.append(entry)
        if plans and not body.dry_run:
            # Work on a copy so a refused value leaves the stored list exactly as it was.
            updated = deepcopy(data)
            by_id = {item["id"]: item for items in updated.values() for item in items}
            for rack, item, row, changes, entry in plans:
                target = by_id[item["id"]]
                for field, (_, after) in changes.items():
                    target[field] = after
                if "serial_number" in changes:
                    store.ensure_unique(updated, target["serial_number"], target["id"])
                store.record(target, "details updated", store.location(rack, target), store.location(rack, target),
                             f"Details from {row.source or SOURCE_DEFAULT}: " + ", ".join(LABELS[field] for field in changes))
            store.write_items(updated)
            data = updated
            # The applied report shows each changed unit as it is now (its new name, type and part number).
            for rack, item, row, changes, entry in plans:
                entry["unit"] = unit_view(rack, by_id[item["id"]])
        set_headers(response, data)
    counts = {status: sum(entry["status"] == status for entry in report) for status in ("updated", "unchanged", "not_found", "ambiguous")}
    return {"dry_run": body.dry_run, "overwrite": body.overwrite, "mark_switch": body.mark_switch, "counts": counts, "results": report}


def export_rows(data):
    """Every unit with a serial number or barcode; switches first, then by rack, U slot and name."""
    rows = []
    for rack, items in data.items():
        for item in items:
            serial, barcode = str(item.get("serial_number") or "").strip(), str(item.get("barcode") or "").strip()
            if not serial and not barcode:
                continue
            u = item.get("u")
            position = item.get("shelf_position", "") or ""
            place = rack + (f" · U{u}" if store.valid_u(u) and u else "") + (f" · {position}" if position else "")
            rows.append({"serial": serial, "barcode": barcode, "name": item.get("name", ""), "type": item.get("type", ""),
                         "part_number": item.get("part_number", ""), "model": item.get("model", ""), "rack": rack,
                         "u": u if store.valid_u(u) else None, "position": position, "place": place, "lookup_as": LOOKUP_AS})
    rows.sort(key=lambda r: (r["type"] != "switch", r["rack"].casefold(), r["u"] if r["u"] is not None else 99, str(r["name"]).casefold()))
    return rows


@router.get("/serials")
async def serials(response: Response):
    data = store.read_items()
    set_headers(response, data)
    return {"items": export_rows(data), "lookup_as": LOOKUP_AS}


def csv_cell(value):
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text


@router.get("/serials.csv")
async def serials_csv():
    data = store.read_items()
    out = io.StringIO(newline="")
    writer = csv.writer(out)
    writer.writerow(EXPORT_FIELDS)
    for row in export_rows(data):
        writer.writerow([csv_cell(row[field]) for field in EXPORT_FIELDS])
    return Response("﻿" + out.getvalue(), media_type="text/csv", headers={
        "Content-Disposition": 'attachment; filename="serial-numbers.csv"', "Cache-Control": "no-store",
        "ETag": store.revision(data)})


# ---- automatic webpe lookup: the laptop tool's heartbeat (tools/webpe-sync/sync.cjs --watch) ----
# The tool runs on the lab laptop (webpe needs NVIDIA SSO, which this server cannot reach) and reports after every check;
# the site shows whether it runs. One small JSON file next to the inventory.
WEBPE_STATUS_NAME = "webpe_status.json"
WEBPE_STATUS_FIELDS = ("last_check", "last_lookup", "looked_up_today", "pending", "last_error", "version", "interval", "seen_at")
WEBPE_INTERVAL_DEFAULT = 20


def webpe_status_file():
    return store.ITEMS_FILE.parent / WEBPE_STATUS_NAME


class WebpeStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    last_check: datetime | None = None
    last_lookup: datetime | None = None
    looked_up_today: int = Field(default=0, ge=0, le=1_000_000)
    pending: int = Field(default=0, ge=0, le=1_000_000)
    last_error: str | None = Field(default=None, max_length=200)
    version: str | None = Field(default=None, max_length=40)
    interval: int = Field(default=WEBPE_INTERVAL_DEFAULT, ge=1, le=3600)

    @field_validator("last_error", "version")
    @classmethod
    def plain_text(cls, value, info):
        if value is None:
            return None
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError(f"{info.field_name} cannot contain control characters")
        return value.strip() or None


def iso(value):
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def read_webpe_status():
    try:
        data = json.loads(webpe_status_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {field: data.get(field) for field in WEBPE_STATUS_FIELDS} if isinstance(data, dict) else {}


def webpe_status_view(data, now=None):
    """The stored report plus "active": the tool reported within 3 check intervals (by this server's clock, so a laptop
    clock that is off does not matter)."""
    now = now or datetime.now(timezone.utc)
    view = {field: data.get(field) for field in WEBPE_STATUS_FIELDS}
    interval = data.get("interval") if isinstance(data.get("interval"), int) and data.get("interval") > 0 else WEBPE_INTERVAL_DEFAULT
    view["interval"] = interval
    try:
        seen = datetime.fromisoformat(str(data.get("seen_at")).replace("Z", "+00:00"))
        view["active"] = 0 <= (now - seen).total_seconds() <= 3 * interval
    except (TypeError, ValueError):
        view["active"] = False
    return view


@router.get("/webpe-status")
async def get_webpe_status(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return webpe_status_view(read_webpe_status())


@router.put("/webpe-status")
async def put_webpe_status(body: WebpeStatus, response: Response):
    """The laptop tool's report after each check (Operator and up, with the CSRF header like every other write)."""
    now = datetime.now(timezone.utc)
    data = {"last_check": iso(body.last_check), "last_lookup": iso(body.last_lookup), "looked_up_today": body.looked_up_today,
            "pending": body.pending, "last_error": body.last_error, "version": body.version, "interval": body.interval,
            "seen_at": iso(now)}
    path = webpe_status_file()
    with store.locked_file(path, "The webpe lookup status could not be saved. Please retry."):
        try:
            store.write_json(path, data, prefix=".webpe-status-")
        except OSError as exc:
            raise HTTPException(503, "The webpe lookup status could not be saved. Please retry.") from exc
    response.headers["Cache-Control"] = "no-store"
    return webpe_status_view(data, now)
