import json, re, secrets, time, asyncio
from typing import Annotated
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models import Device
from ..schemas import KvmStatus, KvmPort
from ..routers.devices import get_creds
from ..routers.kvm_proxy import ensure_session
from drivers.raritan_kvm import RaritanKvmDriver, RaritanKvmError, classify_error

router = APIRouter(prefix="/api/kvms", tags=["kvms"])

# { device_id: (fetched_at, KvmStatus) }
_cache: dict[str, tuple[float, KvmStatus]] = {}
_CACHE_TTL = 20
_refreshing: set[str] = set()

# In-use tracking: { device_id: { port_number: { lease: expires_at (monotonic) } } }
# Every console launch gets its own lease, so closing one console never frees a
# port that another console still has open. A port is IN USE while any lease lives.
_in_use: dict[str, dict[int, dict[str, float]]] = {}
_IN_USE_TTL = 4 * 3600  # 4 hours — clears automatically if user forgets to close tab
_AUTO_CLEAR_GRACE = 120  # seconds after the newest launch before live status may clear a port
_MAX_LEASES_PER_PORT = 50  # bounds memory; far above any real number of consoles on one port
_LEASE_RE = re.compile(r"[0-9a-fA-F]{1,64}")


def _live_leases(device_id: str, port: int, now: float) -> dict[str, float]:
    """Drop expired leases for one port and return the live ones (empty containers removed)."""
    ports = _in_use.get(device_id)
    if not ports or port not in ports:
        return {}
    leases = {lease: exp for lease, exp in ports[port].items() if now < exp}
    if leases:
        ports[port] = leases
    else:
        ports.pop(port, None)
        if not ports:
            _in_use.pop(device_id, None)
    return leases


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
        error = await driver.probe()
        if error is not None:
            return KvmStatus(device_id=device_id, reachable=False, error=error)
        ports_raw = await driver.get_ports(port_count=dev.port_count)
        labels = json.loads(dev.labels_json or "{}")
        for p in ports_raw:
            key = str(p["number"])
            if key in labels:
                p["label"] = labels[key]
        ports = [KvmPort(**p) for p in ports_raw]
        # Reachable, but a rejected sign-in is reported instead of a healthy port list.
        return KvmStatus(device_id=device_id, reachable=True, ports=ports, error=driver.auth_error)
    except Exception as e:
        return KvmStatus(device_id=device_id, reachable=False, error=classify_error(e))
    finally:
        await driver.close()


async def _refresh_background(device_id: str, dev: Device):
    if device_id in _refreshing:
        return
    _refreshing.add(device_id)
    try:
        result = await _fetch_status(device_id, dev)
        _cache[device_id] = (time.monotonic(), result)
        # Auto-clear in-use markers only when the device's live status positively
        # reports the port as not active. Sidebar/static ports never report
        # "active", so their manual mark stays until mark-free or expiry.
        # Wait 2 min before clearing so the initial connection has time to establish.
        if result.reachable and device_id in _in_use:
            now = time.monotonic()
            live_inactive = {
                p.number for p in result.ports
                if p.status_source == "live" and p.status != "active"
            }
            # The grace period runs from the NEWEST launch on the port, so a console
            # opened a moment ago is not cleared because an older one has gone idle.
            to_clear = [
                pnum for pnum, leases in list(_in_use[device_id].items())
                if pnum in live_inactive and leases
                and now - (max(leases.values()) - _IN_USE_TTL) >= _AUTO_CLEAR_GRACE
            ]
            for pnum in to_clear:
                _in_use[device_id].pop(pnum, None)
            if not _in_use[device_id]:
                _in_use.pop(device_id, None)
        await ensure_session(device_id, dev)
    finally:
        _refreshing.discard(device_id)


def _apply_overlays(device_id: str, status: KvmStatus, labels: dict) -> KvmStatus:
    """Apply DB label overrides and in-use tracking on top of cached status."""
    now = time.monotonic()
    in_use = {
        p for p, leases in _in_use.get(device_id, {}).items()
        if any(now < exp for exp in leases.values())
    }

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
    """Start one console session on the port. Send the returned lease to mark-free."""
    now = time.monotonic()
    leases = _live_leases(device_id, port, now)
    while len(leases) >= _MAX_LEASES_PER_PORT:
        leases.pop(min(leases, key=leases.get))
    lease = secrets.token_hex(16)
    leases[lease] = now + _IN_USE_TTL
    _in_use.setdefault(device_id, {})[port] = leases
    return {"ok": True, "lease": lease, "sessions": len(leases)}


_LEASE_HINT = 'Send the console lease as JSON: {"lease": "<hex>"}.'
_MAX_FREE_BODY = 512  # bytes; a lease body is under 100, so anything larger is not one


def _parse_lease(body) -> str | None:
    """Return the lease from a mark-free body, None when no lease was given."""
    if body is None:
        return None
    if isinstance(body, (bytes, str)):
        if len(body) > _MAX_FREE_BODY:
            raise HTTPException(status_code=422, detail=_LEASE_HINT)
        try:
            body = json.loads(body) if body.strip() else None
        except (ValueError, RecursionError):
            raise HTTPException(status_code=422, detail=_LEASE_HINT)
        if body is None:
            return None
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail=_LEASE_HINT)
    lease = body.get("lease")
    if lease is None:
        return None
    if not isinstance(lease, str) or not _LEASE_RE.fullmatch(lease):
        raise HTTPException(status_code=422, detail=_LEASE_HINT)
    return lease.lower()


async def _mark_free_body(request: Request) -> bytes:
    # Read the raw body so a lease sent without a JSON Content-Type
    # (a plain fetch or keepalive request on page close) is still honoured.
    return await request.body()


@router.post("/{device_id}/ports/{port}/mark-free", include_in_schema=False)
async def mark_port_free(
    device_id: str,
    port: int,
    body: Annotated[bytes | dict | None, Depends(_mark_free_body)] = None,
):
    """End one console session on the port (called when a console closes).

    With {"lease": ...} only that session ends; an unknown or expired lease
    changes nothing. Without a lease the oldest session ends. The port stays
    IN USE while any other session is still open.
    """
    lease = _parse_lease(body)
    leases = _live_leases(device_id, port, time.monotonic())
    if leases:
        if lease is None:
            leases.pop(min(leases, key=leases.get))
        else:
            leases.pop(lease, None)
        if not leases:
            ports = _in_use.get(device_id, {})
            ports.pop(port, None)
            if not ports:
                _in_use.pop(device_id, None)
    return {"ok": True, "sessions": len(leases)}


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
