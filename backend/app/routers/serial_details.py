"""Serial numbers of the lab's units, out and back in: an export of every unit that has a serial number or barcode,
and applying details looked up by serial number elsewhere (product name, part number, model, switch type), for
example from the "SN analysis" page of an internal site. Uses the same records, revision (ETag / If-Match) and
history as the scanner and DCIM."""
import csv
from copy import deepcopy
import io
import re

from fastapi import APIRouter, Header, Response
from pydantic import BaseModel, Field, field_validator

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
# Types that say nothing about the product: mark_switch turns only these into "switch" (a PDU, cable or KVM stays one).
GENERIC_TYPES = {"", "other"}


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
    # True: a matched unit whose type is still generic ("other" or empty) becomes a switch, because the serial numbers
    # were looked up as Switch. A unit with a real type (PDU, cable, KVM...) keeps it; only a row's own type changes it.
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
    changes = {}
    if row.part_number and item.get("part_number") != row.part_number:
        changes["part_number"] = (item.get("part_number", ""), row.part_number)
    if row.model and item.get("model") != row.model and (overwrite or not str(item.get("model") or "").strip()):
        changes["model"] = (item.get("model", ""), row.model)
    if row.name and item.get("name") != row.name and (overwrite or generic_name(item)):
        changes["name"] = (item.get("name", ""), row.name)
    generic_type = str(item.get("type") or "").strip() in GENERIC_TYPES
    if (is_switch(row.type) or (mark_switch and not row.type and generic_type)) and item.get("type") != "switch":
        changes["type"] = (item.get("type", ""), "switch")
    # A unit without a serial number was found by its barcode: that code is its serial number, so it is recorded as one.
    if not item.get("serial_number"):
        changes["serial_number"] = ("", row.serial)
    return changes


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
                changes = planned_changes(item, row, body.overwrite, body.mark_switch)
                entry["unit"] = unit_view(rack, item)
                if changes:
                    entry.update(status="updated", changes={field: {"before": before, "after": after} for field, (before, after) in changes.items()})
                    plans.append((rack, item, row, changes))
                else:
                    entry["status"] = "unchanged"
                if row.name and "name" not in changes and item.get("name") != row.name:
                    entry["name_kept"] = NAME_KEPT
            report.append(entry)
        if plans and not body.dry_run:
            # Work on a copy so a refused value leaves the stored list exactly as it was.
            updated = deepcopy(data)
            by_id = {item["id"]: item for items in updated.values() for item in items}
            for rack, item, row, changes in plans:
                target = by_id[item["id"]]
                for field, (_, after) in changes.items():
                    target[field] = after
                if "serial_number" in changes:
                    store.ensure_unique(updated, row.serial, target["id"])
                store.record(target, "details updated", store.location(rack, target), store.location(rack, target),
                             f"Details from {row.source or SOURCE_DEFAULT}: " + ", ".join(LABELS[field] for field in changes))
            store.write_items(updated)
            data = updated
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
