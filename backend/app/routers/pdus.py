import asyncio, json, time
from contextlib import asynccontextmanager
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models import Device, PduMaintenance
from ..pdu_locks import maintenance_lock
from ..schemas import PduStatus, OutletState, PowerAction
from ..routers.devices import get_creds
from .. import power_protection
from ..config import get_settings
from drivers.raritan_pdu import RaritanPduDriver, safe_error

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


@asynccontextmanager
async def locked_pdu(device_id: str, db: AsyncSession):
    """Holds the per-PDU maintenance lock and yields the PDU re-read inside it,
    so a concurrent address change cannot redirect the action."""
    await _get_pdu_or_404(device_id, db)  # unknown ids never get a lock entry
    async with maintenance_lock(device_id):
        dev = await db.scalar(select(Device).where(Device.id == device_id, Device.kind == "pdu")
                              .execution_options(populate_existing=True))
        if not dev:
            raise HTTPException(status_code=404, detail="PDU not found")
        yield dev


async def _fetch_status(device_id: str, dev: Device) -> PduStatus:
    username, password = get_creds(dev)
    driver = RaritanPduDriver(dev.ip, username, password)
    try:
        outlets_raw, inlet, env = await asyncio.gather(
            driver.get_outlets(),
            driver.get_inlet(),
            driver.get_env_sensors(),
        )
        labels = json.loads(dev.labels_json or "{}")
        for o in outlets_raw:
            key = str(o["number"])
            if key in labels:
                o["label"] = labels[key]
        outlets = [OutletState(**o) for o in outlets_raw]
        known_watts = [o.watts for o in outlets if o.watts is not None]
        total_watts = sum(known_watts) if known_watts else None
        return PduStatus(
            device_id=device_id,
            reachable=True,
            inlet_voltage=inlet.get("voltage"),
            inlet_readings=inlet.get("readings", []),
            total_watts=total_watts,
            watts_complete=bool(outlets) and len(known_watts) == len(outlets),
            outlets=outlets,
            temperature=env.get("temperature"),
            humidity=env.get("humidity"),
            leak_detected=env.get("leak_detected"),
        )
    except Exception as e:
        return PduStatus(device_id=device_id, reachable=False, error=safe_error(e))
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

    if cached:
        # Apply the latest DB labels and return instantly; stale data is also refreshed in the background
        status = cached[1]
        labels = json.loads(dev.labels_json or "{}")
        if labels:
            updated = []
            for o in status.outlets:
                key = str(o.number)
                label = labels.get(key, o.label)
                updated.append(o.model_copy(update={"label": label}))
            status = status.model_copy(update={"outlets": updated})
        if age >= _CACHE_TTL:
            background_tasks.add_task(_refresh_background, device_id, dev)
        return status

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
    # Validate before any device contact (an unknown action used to reach the PDU first).
    if body.action not in ("on", "off", "cycle"):
        raise HTTPException(status_code=400, detail="Unknown action; use on, off or cycle")
    if outlet_number < 1:
        raise HTTPException(status_code=400, detail="Outlet numbers start at 1")
    # The maintenance check and the switch share the shutdown lock, so an "on" cannot slip in after a shutdown.
    async with locked_pdu(device_id, db) as dev:
        if not dev.enabled:
            raise HTTPException(status_code=409, detail="This PDU is disabled; enable it in Admin -> Devices first")
        if body.action in ("on", "cycle") and await db.get(PduMaintenance, device_id, populate_existing=True):
            raise HTTPException(status_code=409, detail="PDU is in maintenance mode; restore it from the Maintenance column first")
        if body.action in ("off", "cycle"):
            # Outlets that feed the site itself (POWER_PROTECTED_OUTLETS) are never switched off from the UI either.
            protection = await power_protection.load(db, get_settings())
            # A stale entry (renamed PDU, outlet out of range) is dropped by parse() and could be exactly the outlet it
            # was meant to protect, so an invalid list refuses every off and cycle (the bulk actions' rule as well).
            if protection.errors:
                raise HTTPException(status_code=409, detail="Protected outlets setting is invalid; power off is unavailable")
            if protection.is_protected(device_id, outlet_number):
                raise HTTPException(status_code=409, detail="This outlet is protected (POWER_PROTECTED_OUTLETS); it cannot be switched off here")
        try:
            username, password = get_creds(dev)
        except Exception:
            raise HTTPException(status_code=502, detail="Stored PDU credentials could not be read; re-enter them in Admin -> Devices")
        driver = RaritanPduDriver(dev.ip, username, password)
        try:
            success = await driver.set_outlet_state(outlet_number, body.action)
            # Invalidate cache so next poll gets fresh state
            _cache.pop(device_id, None)
            return {"ok": success, "outlet": outlet_number, "action": body.action}
        except ValueError:
            raise HTTPException(status_code=400, detail="Unknown action; use on, off or cycle")
        except Exception as e:
            raise HTTPException(status_code=502, detail=safe_error(e))
        finally:
            await driver.close()


@router.get("/{device_id}/sensors-debug")
async def sensors_debug(device_id: str, db: AsyncSession = Depends(get_db)):
    """Returns all raw sensor names the PDU exposes — useful for diagnosing missing sensor data."""
    dev = await _get_pdu_or_404(device_id, db)
    username, password = get_creds(dev)
    driver = RaritanPduDriver(dev.ip, username, password)
    try:
        return await driver.list_sensors()
    except Exception as e:
        raise HTTPException(status_code=502, detail=safe_error(e))
    finally:
        await driver.close()
