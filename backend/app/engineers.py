"""Engineer directory and individual owner assignments, preserving legacy names."""
import json
import unicodedata
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .database import AsyncSessionLocal, get_db
from .models import AssetOwner, Engineer

router = APIRouter(prefix="/api", tags=["engineers"])
INITIAL_NAMES = (
    "Roy Mendelson", "Adam Cohen", "Ariel Vinograd", "Ofek Reiz", "Royi Journo",
    "Eden Levi", "Idan Czuckermann", "Liran Cohen", "Yaniv Shnur", "Limor Romano",
)


def name_key(value):
    return unicodedata.normalize("NFKC", " ".join(value.split())).casefold()


def legacy_owners():
    from .main import _OPT_OWNERS_FILE
    try:
        data = json.loads(_OPT_OWNERS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError) as exc:
        raise HTTPException(503, "Saved owner data could not be read; it was left unchanged") from exc
    if not isinstance(data, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in data.items()):
        raise HTTPException(503, "Saved owner data has an invalid format; it was left unchanged")
    from .inventory_store import read_items
    for items in read_items().values():
        for item in items:
            if item.get("id") and isinstance(item.get("owner"), str) and item["owner"]:
                data.setdefault("item:" + item["id"], item["owner"])
    return data


async def bootstrap_engineers():
    async with AsyncSessionLocal() as db:
        if await db.scalar(select(func.count()).select_from(Engineer)):
            return
        people = [Engineer(id=uuid4().hex, name=name, name_key=name_key(name), active=True) for name in INITIAL_NAMES]
        db.add_all(people)
        # Match existing names once. Unknown owners remain readable and unchanged.
        lookup = {p.name_key:p for p in people}
        for asset, value in legacy_owners().items():
            person = lookup.get(name_key(value))
            db.add(AssetOwner(asset_key=asset, engineer_id=person.id if person else None,
                              legacy_name="" if person else value))
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()  # Another worker already initialized the directory.


async def owner_map(db):
    result = legacy_owners()
    rows = (await db.execute(select(AssetOwner, Engineer).outerjoin(Engineer, Engineer.id == AssetOwner.engineer_id))).all()
    for assignment, person in rows:
        value = person.name if person else assignment.legacy_name
        if value:
            result[assignment.asset_key] = value
        else:
            result.pop(assignment.asset_key, None)
    return result


def person_view(person):
    return {"id":person.id, "name":person.name, "active":person.active}


class EngineerEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    active: bool = True

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = " ".join(value.split())
        if not value or any(unicodedata.category(c).startswith("C") for c in value):
            raise ValueError("Enter an engineer name")
        return value


class OwnerEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    engineer_id: str | None = Field(default=None, max_length=64)


@router.get("/engineers")
async def list_engineers(db: AsyncSession = Depends(get_db)):
    people = (await db.execute(select(Engineer).order_by(Engineer.name_key))).scalars().all()
    return [person_view(p) for p in people]


@router.post("/engineers", status_code=201)
async def add_engineer(body: EngineerEdit, db: AsyncSession = Depends(get_db)):
    person = Engineer(id=uuid4().hex, name=body.name, name_key=name_key(body.name), active=body.active)
    db.add(person)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "This engineer is already listed. Reactivate their existing entry if needed.") from exc
    return person_view(person)


@router.put("/engineers/{engineer_id}")
async def edit_engineer(engineer_id: str, body: EngineerEdit, db: AsyncSession = Depends(get_db)):
    person = await db.get(Engineer, engineer_id)
    if not person:
        raise HTTPException(404, "Engineer not found")
    person.name, person.name_key, person.active = body.name, name_key(body.name), body.active
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "Another engineer already uses this name") from exc
    return person_view(person)


@router.put("/opt-owners/{asset_key:path}")
async def assign_owner(asset_key: str, body: OwnerEdit, db: AsyncSession = Depends(get_db)):
    if not asset_key.strip() or len(asset_key) > 200:
        raise HTTPException(422, "Invalid asset")
    person = await db.get(Engineer, body.engineer_id) if body.engineer_id else None
    if body.engineer_id and (not person or not person.active):
        raise HTTPException(409, "Choose an active engineer from the list")
    assignment = await db.get(AssetOwner, asset_key)
    if not assignment:
        assignment = AssetOwner(asset_key=asset_key)
        db.add(assignment)
    assignment.engineer_id, assignment.legacy_name = person.id if person else None, ""
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "Owner changed. Refresh and select again.") from exc
    return await owner_map(db)


async def replace_legacy_owners(payload, db):
    if any(not isinstance(v, str) or len(v) > 120 for v in payload.values()):
        raise HTTPException(422, "Owner names must be text up to 120 characters")
    people = {p.name_key:p for p in (await db.execute(select(Engineer))).scalars()}
    current = {a.asset_key:a for a in (await db.execute(select(AssetOwner))).scalars()}
    for asset in set(await owner_map(db)) | set(payload):
        value = payload.get(asset, "").strip()
        person = people.get(name_key(value))
        assignment = current.get(asset)
        if assignment is None:
            assignment = AssetOwner(asset_key=asset)
            db.add(assignment)
        assignment.engineer_id = person.id if person else None
        assignment.legacy_name = "" if person else value
    await db.commit()
    return {"ok":True}
