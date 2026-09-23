"""Barcode lookup and equipment tracking; uses the same records as DCIM and Twin."""
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Device
from .. import inventory_store as store

router = APIRouter(prefix="/api/inventory", tags=["inventory"])


class Placement(BaseModel):
    rack: str = Field(min_length=1, max_length=120)
    u: int = Field(ge=1, le=42, strict=True)
    position: str = Field(default="", max_length=80)

    @field_validator("rack", "position")
    @classmethod
    def trim(cls, value):
        return value.strip()


class Barcode(BaseModel):
    code: str = Field(min_length=1, max_length=200)

    @field_validator("code")
    @classmethod
    def clean_code(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Scan one barcode without control characters")
        if value.upper().startswith("LOC:"):
            raise ValueError("Shelf labels cannot be assigned to equipment")
        return value


class RegisterItem(Placement, Barcode):
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
    return set(result.scalars().all())


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
    key = code.strip().casefold() if code is not None else None
    matches = [item for item in items if key in store.identifiers(item)] if key else []
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
