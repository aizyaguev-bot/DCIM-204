"""Monitoring configuration and read-only observations; protected by app authentication."""
import csv
import io
import time
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..database import get_db
from ..models import PingIncident, PingMonitorState, PingSample, PingTarget, PingTargetName
from ..monitor_links import connection_index
from ..ping_monitor import close_incident, interval_minutes, iso, next_slot, server_identity, validate_host, inventory_sources

router = APIRouter(prefix="/api/monitoring", tags=["ping monitoring"])


class TargetEdit(BaseModel):
    host: str = Field(max_length=253)
    enabled: bool
    revision: int = Field(ge=0)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    sync_name: bool | None = None

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        if value is not None and not value.strip():
            raise ValueError("A server name is required")
        return value.strip() if value is not None else None

    @field_validator("host")
    @classmethod
    def valid_host(cls, value):
        return validate_host(value)


class TargetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    host: str = Field(min_length=1, max_length=253)
    rack: str = Field(default="", max_length=120)

    @field_validator("name", "host")
    @classmethod
    def clean(cls, value, info):
        value = value.strip()
        if not value:
            raise ValueError("This field is required")
        return validate_host(value) if info.field_name == "host" else value


def zone():
    try:
        return ZoneInfo(get_settings().ping_monitor_timezone)
    except (ValueError, KeyError) as exc:
        raise HTTPException(503, "Invalid monitoring timezone or missing tzdata. Check server configuration.") from exc


def target_view(target, tz, *, name_override="", inventory_name=None):
    status = target.status
    if not target.enabled:
        status = "paused"
    elif not target.host:
        status = "unconfigured"
    elif target.checked_at and time.time() > next_slot(target.checked_at, tz) + 120:
        status = "stale"
    return {
        "id": target.id, "name": name_override or inventory_name or target.name, "host": target.host, "rack": target.rack,
        "inventory_name": inventory_name or target.name, "name_synced": not bool(name_override),
        "source": target.source, "enabled": target.enabled, "revision": target.revision,
        "status": status, "last_result": target.status, "checked_at": iso(target.checked_at),
        "last_up_at": iso(target.last_up_at), "rtt_ms": target.rtt_ms, "detail": target.detail,
    }


@router.get("")
async def overview(response: Response, db: AsyncSession = Depends(get_db)):
    tz, now = zone(), time.time()
    settings = get_settings()
    state = await db.get(PingMonitorState, 1)
    targets = (await db.execute(select(PingTarget).order_by(PingTarget.name))).scalars().all()
    sources = await inventory_sources(db)
    overrides = {n.target_id:n.override for n in (await db.execute(select(PingTargetName))).scalars()}
    service = "not_started"
    if not settings.ping_monitor_enabled:
        service = "disabled"
    elif state:
        service = "running" if state.lease_until > now else "overdue" if state.next_run_at < now - 60 else "scheduled"
        if state.error:
            service = "error"
    response.headers["Cache-Control"] = "no-store"
    connections = await connection_index(db, tz, now)
    from ..alerts import overview as alert_overview
    return {
        "email_alerts": await alert_overview(db, settings),
        "timezone": settings.ping_monitor_timezone, "service": service,
        "interval_minutes": interval_minutes(now, tz), "server_time": iso(now),
        "next_run_at": iso(state.next_run_at) if state and settings.ping_monitor_enabled else None,
        "last_started_at": iso(state.last_started_at) if state else None,
        "last_completed_at": iso(state.last_completed_at) if state else None,
        "error": state.error if state else "",
        "targets": [{**target_view(t, tz, name_override=overrides.get(t.id,""),
                     inventory_name=sources.get(t.source_key.removeprefix("server:"), (None,))[0] if t.source=="inventory" else None),
                     **connections.get(t.source_key, {"pdu": [], "kvm": []})} for t in targets],
    }


@router.post("/check", status_code=202)
async def check_now(db: AsyncSession = Depends(get_db)):
    zone()
    if not get_settings().ping_monitor_enabled:
        raise HTTPException(409, "Monitoring is disabled in the server configuration")
    state = await db.get(PingMonitorState, 1)
    if not state:
        raise HTTPException(503, "Monitoring has not started yet")
    now = time.time()
    result = await db.execute(update(PingMonitorState).where(
        PingMonitorState.id == 1, PingMonitorState.lease_until <= now,
    ).values(next_run_at=now))
    await db.commit()
    if result.rowcount != 1:
        raise HTTPException(409, "A check is already running")
    return {"queued": True}


@router.post("/targets", status_code=201)
async def create_target(body: TargetCreate, db: AsyncSession = Depends(get_db)):
    identity = server_identity(body.name)
    if not identity:
        raise HTTPException(422, "Choose a server name, not a default port label")
    target = PingTarget(id=uuid4().hex, source_key="server:" + identity[0], name=body.name,
                        host=body.host, rack=body.rack.strip(), source="manual")
    db.add(target)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "This server already exists. Edit its address in the list.") from exc
    await db.refresh(target)
    return target_view(target, zone())


@router.put("/targets/{target_id}")
async def edit_target(target_id: str, body: TargetEdit, db: AsyncSession = Depends(get_db)):
    # Compare-and-swap also serializes changes against result writers on SQLite.
    result = await db.execute(update(PingTarget).where(
        PingTarget.id == target_id, PingTarget.revision == body.revision,
    ).values(revision=PingTarget.revision + 1).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        await db.rollback()
        exists = await db.get(PingTarget, target_id)
        raise HTTPException(409 if exists else 404, "Server changed. Refresh and try again." if exists else "Server not found")
    target = await db.get(PingTarget, target_id, populate_existing=True)
    changed = target.host != body.host
    if changed or not body.enabled:
        await close_incident(db, target.id, time.time(), "address_changed" if changed else "paused")
    if changed or target.enabled != body.enabled:
        target.status, target.checked_at, target.rtt_ms, target.detail = "pending", None, None, ""
        if changed:
            target.last_up_at = None
    target.host, target.enabled = body.host, body.enabled
    name_record = await db.get(PingTargetName, target.id)
    if body.name is not None or body.sync_name is not None:
        if target.source == "manual":
            if body.name is not None: target.name = body.name
        else:
            if name_record is None:
                name_record = PingTargetName(target_id=target.id)
                db.add(name_record)
            name_record.override = "" if body.sync_name else (body.name or target.name)
    await db.commit()
    return target_view(target, zone(), name_override=name_record.override if name_record else "")


def incident_view(incident, target, name=None):
    return {
        "id": incident.id, "target_id": target.id, "name": name or target.name, "rack": target.rack,
        "host": incident.host, "previous_up_at": iso(incident.previous_up_at),
        "first_failed_at": iso(incident.first_failed_at), "last_failed_at": iso(incident.last_failed_at),
        "ended_at": iso(incident.ended_at), "end_reason": incident.end_reason,
        "failed_checks": incident.failed_checks,
        "observed_seconds": round((incident.ended_at or incident.last_failed_at) - incident.first_failed_at),
    }


async def incident_rows(db, target_id, limit):
    query = select(PingIncident, PingTarget).join(PingTarget, PingTarget.id == PingIncident.target_id)
    if target_id:
        query = query.where(PingIncident.target_id == target_id)
    return (await db.execute(query.order_by(PingIncident.first_failed_at.desc()).limit(limit))).all()


async def display_names(db):
    sources = await inventory_sources(db)
    overrides = {n.target_id:n.override for n in (await db.execute(select(PingTargetName))).scalars()}
    return sources, overrides


async def named_incidents(db, target_id, limit):
    sources, overrides = await display_names(db)
    return [incident_view(i, t, overrides.get(t.id) or
            (sources.get(t.source_key.removeprefix("server:"), (t.name,))[0] if t.source == "inventory" else t.name))
            for i, t in await incident_rows(db, target_id, limit)]


@router.get("/incidents")
async def incidents(target_id: str | None = None, limit: int = Query(default=200, ge=1, le=2000), db: AsyncSession = Depends(get_db)):
    return await named_incidents(db, target_id, limit)


@router.get("/incidents.csv")
async def export_incidents(db: AsyncSession = Depends(get_db)):
    rows = await named_incidents(db, None, 10000)
    out = io.StringIO(newline="")
    fields = ["name", "host", "rack", "previous_up_at", "first_failed_at", "last_failed_at", "ended_at", "end_reason", "failed_checks", "observed_seconds"]
    writer = csv.writer(out)
    writer.writerow(fields)
    for row in rows:
        values = [row[f] for f in fields]
        writer.writerow(["'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r")) else v for v in values])
    return Response("\ufeff" + out.getvalue(), media_type="text/csv", headers={
        "Content-Disposition": 'attachment; filename="ping-incidents.csv"', "Cache-Control": "no-store",
    })


@router.get("/targets/{target_id}/history")
async def history(target_id: str, limit: int = Query(default=200, ge=1, le=2000), db: AsyncSession = Depends(get_db)):
    if not await db.get(PingTarget, target_id):
        raise HTTPException(404, "Server not found")
    rows = (await db.execute(select(PingSample).where(PingSample.target_id == target_id)
                            .order_by(PingSample.checked_at.desc(), PingSample.id.desc()).limit(limit))).scalars()
    return [{"id": r.id, "host": r.host, "checked_at": iso(r.checked_at), "status": r.status,
             "rtt_ms": r.rtt_ms, "detail": r.detail} for r in rows]
