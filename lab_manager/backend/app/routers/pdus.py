import json, time
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models import Device
from ..schemas import PduStatus, OutletState, PowerAction
from ..routers.devices import get_creds
from drivers.raritan_pdu import RaritanPduDriver, RaritanPduError

router = APIRouter(prefix="/api/pdus", tags=["pdus"])

# { device_id: (fetched_at, PduStatus) }
_cache: dict[str, tuple[float, PduStatus]] = {}
_CACHE_TTL = 20
_refreshing: set[str] = set()


async def _get_pdu_or_404(device_id: str, db: AsyncSession) -> Device:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.kind == "pdu")
    )
    dev = result.scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="PDU not found")
    return dev


async def _fetch_status(device_id: str, dev: Device) -> PduStatus:
    username, password = get_creds(dev)
    driver = RaritanPduDriver(dev.ip, username, password)
    try:
        outlets_raw = await driver.get_outlets()
        inlet = await driver.get_inlet()
        labels = json.loads(dev.labels_json or "{}")
        for o in outlets_raw:
            key = str(o["number"])
            if key in labels:
                o["label"] = labels[key]
        outlets = [OutletState(**o) for o in outlets_raw]
        total_watts = sum(o.watts for o in outlets)
        return PduStatus(
            device_id=device_id,
            reachable=True,
            inlet_voltage=inlet.get("voltage", 0.0),
            total_watts=total_watts,
            outlets=outlets,
        )
    except Exception as e:
        return PduStatus(device_id=device_id, reachable=False, error=str(e))
    finally:
        await driver.close()


async def _refresh_background(device_id: str, dev: Device):
    if device_id in _refreshing:
        return
    _refreshing.add(device_id)
    try:
        result = await _fetch_status(device_id, dev)
        _cache[device_id] = (time.monotonic(), result)
    finally:
        _refreshing.discard(device_id)


@router.get("/{device_id}/status", response_model=PduStatus)
async def pdu_status(
    device_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    dev = await _get_pdu_or_404(device_id, db)

    cached = _cache.get(device_id)
    age = time.monotonic() - cached[0] if cached else float("inf")

    if cached and age < _CACHE_TTL:
        # Fresh — apply latest DB labels and return instantly
        status = cached[1]
        labels = json.loads(dev.labels_json or "{}")
        if labels:
            updated = []
            for o in status.outlets:
                key = str(o.number)
                label = labels.get(key, o.label)
                updated.append(o.model_copy(update={"label": label}))
            status = status.model_copy(update={"outlets": updated})
        return status

    if cached:
        # Stale — return old data instantly, refresh in background
        background_tasks.add_task(_refresh_background, device_id, dev)
        return cached[1]

    # First load — fetch now
    result = await _fetch_status(device_id, dev)
    _cache[device_id] = (time.monotonic(), result)
    return result


@router.post("/{device_id}/outlets/{outlet_number}/power")
async def outlet_power(
    device_id: str,
    outlet_number: int,
    body: PowerAction,
    db: AsyncSession = Depends(get_db),
):
    dev = await _get_pdu_or_404(device_id, db)
    username, password = get_creds(dev)
    driver = RaritanPduDriver(dev.ip, username, password)
    try:
        success = await driver.set_outlet_state(outlet_number, body.action)
        # Invalidate cache so next poll gets fresh state
        _cache.pop(device_id, None)
        return {"ok": success, "outlet": outlet_number, "action": body.action}
    except (RaritanPduError, ValueError) as e:
        raise HTTPException(status_code=502, detail=str(e))
    finally:
        await driver.close()
