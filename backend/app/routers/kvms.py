import json, time, asyncio
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models import Device
from ..schemas import KvmStatus, KvmPort
from ..routers.devices import get_creds
from ..routers.kvm_proxy import ensure_session
from drivers.raritan_kvm import RaritanKvmDriver, RaritanKvmError

router = APIRouter(prefix="/api/kvms", tags=["kvms"])

# { device_id: (fetched_at, KvmStatus) }
_cache: dict[str, tuple[float, KvmStatus]] = {}
_CACHE_TTL = 20
_refreshing: set[str] = set()

# In-use tracking: { device_id: { port_number: expires_at (monotonic) } }
_in_use: dict[str, dict[int, float]] = {}
_IN_USE_TTL = 4 * 3600  # 4 hours — clears automatically if user forgets to close tab


async def _get_kvm_or_404(device_id: str, db: AsyncSession) -> Device:
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.kind == "kvm")
    )
    dev = result.scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="KVM not found")
    return dev


async def _fetch_status(device_id: str, dev: Device) -> KvmStatus:
    username, password = get_creds(dev)
    driver = RaritanKvmDriver(dev.ip, username, password, model=dev.model)
    try:
        reachable = await driver.ping()
        if not reachable:
            return KvmStatus(device_id=device_id, reachable=False, error="Cannot reach device")
        ports_raw = await driver.get_ports(port_count=dev.port_count)
        labels = json.loads(dev.labels_json or "{}")
        for p in ports_raw:
            key = str(p["number"])
            if key in labels:
                p["label"] = labels[key]
        ports = [KvmPort(**p) for p in ports_raw]
        return KvmStatus(device_id=device_id, reachable=True, ports=ports)
    except Exception as e:
        return KvmStatus(device_id=device_id, reachable=False, error=str(e))
    finally:
        await driver.close()


async def _refresh_background(device_id: str, dev: Device):
    if device_id in _refreshing:
        return
    _refreshing.add(device_id)
    try:
        result = await _fetch_status(device_id, dev)
        _cache[device_id] = (time.monotonic(), result)
        # Auto-clear in-use markers when KVM reports the port as no longer active.
        # Wait 2 min before clearing so the initial connection has time to establish.
        if result.reachable and device_id in _in_use:
            now = time.monotonic()
            active_ports = {p.number for p in result.ports if p.status == "active"}
            to_clear = [
                pnum for pnum, exp in list(_in_use[device_id].items())
                if pnum not in active_ports and now - (exp - _IN_USE_TTL) > 120
            ]
            for pnum in to_clear:
                _in_use[device_id].pop(pnum, None)
        await ensure_session(device_id, dev)
    finally:
        _refreshing.discard(device_id)


def _apply_overlays(device_id: str, status: KvmStatus, labels: dict) -> KvmStatus:
    """Apply DB label overrides and in-use tracking on top of cached status."""
    now = time.monotonic()
    in_use = {p: exp for p, exp in _in_use.get(device_id, {}).items() if now < exp}

    if not labels and not in_use:
        return status

    updated_ports = []
    for p in status.ports:
        overrides = {}
        key = str(p.number)
        if key in labels:
            overrides["label"] = labels[key]
        if p.number in in_use:
            overrides["in_use"] = True
        updated_ports.append(p.model_copy(update=overrides) if overrides else p)

    return status.model_copy(update={"ports": updated_ports})


@router.get("/{device_id}/status", response_model=KvmStatus)
async def kvm_status(
    device_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    dev = await _get_kvm_or_404(device_id, db)
    labels = json.loads(dev.labels_json or "{}")

    cached = _cache.get(device_id)
    age = time.monotonic() - cached[0] if cached else float("inf")

    if cached and age < _CACHE_TTL:
        return _apply_overlays(device_id, cached[1], labels)

    if cached:
        background_tasks.add_task(_refresh_background, device_id, dev)
        return _apply_overlays(device_id, cached[1], labels)

    result = await _fetch_status(device_id, dev)
    _cache[device_id] = (time.monotonic(), result)
    background_tasks.add_task(ensure_session, device_id, dev)
    return _apply_overlays(device_id, result, labels)


@router.post("/{device_id}/ports/{port}/mark-in-use", include_in_schema=False)
async def mark_port_in_use(device_id: str, port: int):
    if device_id not in _in_use:
        _in_use[device_id] = {}
    _in_use[device_id][port] = time.monotonic() + _IN_USE_TTL
    return {"ok": True}


@router.post("/{device_id}/ports/{port}/mark-free", include_in_schema=False)
async def mark_port_free(device_id: str, port: int):
    """Called automatically when the KVM console tab closes."""
    if device_id in _in_use:
        _in_use[device_id].pop(port, None)
    return {"ok": True}


@router.post("/{device_id}/mark-free", include_in_schema=False)
async def mark_device_free(device_id: str):
    """Dismiss the IN USE indicator for this device (clears all in-use markers)."""
    _in_use.pop(device_id, None)
    return {"ok": True}


@router.get("/{device_id}/ports/{port_number}/viewer")
async def kvm_viewer_url(
    device_id: str,
    port_number: int,
    db: AsyncSession = Depends(get_db),
):
    dev = await _get_kvm_or_404(device_id, db)
    proxy_url = f"/api/kvms/{device_id}/proxy/home.asp"
    launch_url = f"https://{dev.ip}/home.asp"
    return {"embed_url": proxy_url, "launch_url": launch_url, "can_embed": True}
