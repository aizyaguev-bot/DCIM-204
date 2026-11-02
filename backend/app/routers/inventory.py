"""Barcode lookup and equipment tracking; uses the same records as DCIM and Twin."""
from copy import deepcopy
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Device
from .. import inventory_store as store

router = APIRouter(prefix="/api/inventory", tags=["inventory"])
MAIN_STORAGE = "Storage-Main"


class Placement(BaseModel):
    rack: str = Field(min_length=1, max_length=120)
    u: int = Field(ge=0, le=store.MAX_U, strict=True)
    position: str = Field(default="", max_length=80)

    @field_validator("rack", "position")
    @classmethod
    def trim(cls, value):
        return value.strip()

    @model_validator(mode="after")
    def storage_is_one_unit(self):
        if self.rack == MAIN_STORAGE and (self.u != 0 or self.position):
            raise ValueError("Main storage is one location without individual shelves or positions")
        return self


class Barcode(BaseModel):
    code: str = Field(min_length=1, max_length=200)

    @field_validator("code")
    @classmethod
    def clean_code(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Scan one barcode without control characters")
        if value.upper().startswith(("LOC:", "RACK:", "STORE:")):
            raise ValueError("Location labels cannot be assigned to equipment")
        return value


class UnitDetails(BaseModel):
    """Serial number, part number, model and MAC address of a unit, each optional. "serial" is also accepted as
    "serial_number" (its stored name). Trimmed; blank means "none"; MAC stored as 00:1A:2B:3C:4D:5E."""
    serial: str | None = Field(default=None, max_length=store.DETAIL_LIMITS["serial_number"])
    part_number: str | None = Field(default=None, max_length=store.DETAIL_LIMITS["part_number"])
    model: str | None = Field(default=None, max_length=store.DETAIL_LIMITS["model"])
    mac: str | None = Field(default=None, max_length=store.DETAIL_LIMITS["mac"])

    @model_validator(mode="before")
    @classmethod
    def serial_number_alias(cls, data):
        if isinstance(data, dict) and "serial_number" in data and data.get("serial") is None:
            data = {**data, "serial": data["serial_number"]}
        return data

    @field_validator("serial", "part_number", "model", "mac")
    @classmethod
    def clean(cls, value, info):
        return None if value is None else store.clean_detail("serial_number" if info.field_name == "serial" else info.field_name, value)

    def details(self):
        """{stored field: cleaned value ('' = clear)} for the fields that were sent."""
        sent = {"serial_number": self.serial, "part_number": self.part_number, "model": self.model, "mac": self.mac}
        return {field: value for field, value in sent.items() if value is not None}


class RegisterItem(Placement, Barcode, UnitDetails):
    name: str = Field(min_length=1, max_length=160)
    type: Literal["switch", "computer", "patchpanel", "cable", "pdu", "kvm", "ups", "other"] = "other"

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Equipment name is required")
        return value


async def known_racks(db):
    result = await db.execute(select(Device.rack).where(Device.rack != ""))
    return set(result.scalars().all()) | {MAIN_STORAGE}


def view_item(rack, item):
    return {**item, "rack": rack}


def set_headers(response, data):
    response.headers["ETag"] = store.revision(data)
    response.headers["Cache-Control"] = "no-store"


def find_item(data, item_id):
    matches = [(rack, item) for rack, items in data.items() for item in items if item["id"] == item_id]
    if not matches:
        raise HTTPException(404, "Equipment no longer exists. Refresh the inventory.")
    if len(matches) != 1:
        raise HTTPException(409, "Duplicate equipment IDs must be resolved in the inventory first.")
    return matches[0]


def validate_rack(rack, data, racks):
    if rack not in racks | set(data):
        raise HTTPException(422, "Choose an existing rack. Add new racks in DCIM first.")


@router.get("")
async def inventory(response: Response, code: str | None = Query(default=None, max_length=200), db: AsyncSession = Depends(get_db)):
    racks = await known_racks(db)
    data = store.read_items()
    items = [view_item(rack, item) for rack, group in data.items() for item in group]
    keys = store.lookup_keys(code) if code is not None else set()
    matches = [item for item in items if keys & store.identity_keys(item)] if keys else []
    set_headers(response, data)
    return {"items": items, "matches": matches, "racks": sorted(racks | set(data)), "history_limit": store.HISTORY_LIMIT}


@router.post("", status_code=201)
async def register(body: RegisterItem, response: Response, if_match: str | None = Header(default=None), db: AsyncSession = Depends(get_db)):
    racks = await known_racks(db)
    with store.locked_items() as data:
        store.check_revision(data, if_match)
        validate_rack(body.rack, data, racks)
        store.ensure_unique(data, body.code)
        item = {"id": "ci-" + uuid4().hex, "name": body.name, "type": body.type, "barcode": body.code, "u": body.u, "shelf_position": body.position, "notes": ""}
        store.apply_details(item, body.details())
        store.ensure_unique_details(data, item)
        event = store.record(item, "registered", None, store.location(body.rack, item))
        item["last_seen_at"] = event["at"]
        data.setdefault(body.rack, []).append(item)
        store.write_items(data)
        set_headers(response, data)
        return view_item(body.rack, item)


@router.post("/{item_id}/barcode")
async def link_barcode(item_id: str, body: Barcode, response: Response, if_match: str | None = Header(default=None)):
    with store.locked_items() as data:
        store.check_revision(data, if_match)
        rack, item = find_item(data, item_id)
        store.ensure_unique(data, body.code, item_id)
        if item.get("barcode") and item["barcode"].casefold() != body.code.casefold():
            raise HTTPException(409, "This item already has a barcode. Its existing barcode was kept.")
        if item.get("barcode") != body.code:
            item["barcode"] = body.code
            store.record(item, "barcode linked", store.location(rack, item), store.location(rack, item))
            store.write_items(data)
        set_headers(response, data)
        return view_item(rack, item)


@router.post("/{item_id}/location")
async def move(item_id: str, body: Placement, response: Response, if_match: str | None = Header(default=None), db: AsyncSession = Depends(get_db)):
    racks = await known_racks(db)
    with store.locked_items() as data:
        store.check_revision(data, if_match)
        validate_rack(body.rack, data, racks)
        rack, item = find_item(data, item_id)
        before = store.location(rack, item)
        after = {"rack": body.rack, "u": body.u, "position": body.position}
        if rack != body.rack:
            data[rack].remove(item)
            data.setdefault(body.rack, []).append(item)
        item["u"] = body.u
        item["shelf_position"] = body.position
        event = store.record(item, "confirmed" if before == after else "moved", before, after)
        item["last_seen_at"] = event["at"]
        store.write_items(data)
        set_headers(response, data)
        return view_item(body.rack, item)


class DetailsUpdate(UnitDetails):
    # True: only fields the unit does not have yet are filled (a scan of a known unit); a stored value is never changed.
    only_missing: bool = False


@router.post("/{item_id}/details")
async def update_details(item_id: str, body: DetailsUpdate, response: Response, if_match: str | None = Header(default=None)):
    """Set or clear a unit's serial number, part number, model and MAC; fields left out are kept. Its place is not changed."""
    with store.locked_items() as data:
        store.check_revision(data, if_match)
        rack, item = find_item(data, item_id)
        values = body.details()
        if body.only_missing:
            values = {field: value for field, value in values.items() if value and not str(item.get(field) or "").strip()}
        updated = deepcopy(item)
        changed = store.apply_details(updated, values)
        if changed:
            store.ensure_unique_details(data, updated, item_id, changed)
            item.clear()
            item.update(updated)
            store.record(item, "details updated", store.location(rack, item), store.location(rack, item),
                         ", ".join(store.DETAIL_LABELS[field] for field in changed))
            store.write_items(data)
        set_headers(response, data)
        return view_item(rack, item)

