"""Port names on the PDUs/KVMs themselves: sync status (database only), live compare and push (Operator).

Included in main.py before the devices router, so /api/devices/name-sync/... is never taken for a device id."""
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import name_sync
from ..accounts import same_origin
from ..database import get_db
from ..models import Device, DeviceNameSync

router = APIRouter(prefix="/api/devices", tags=["device-names"])

_MAX_IDS = 500
_MAX_PORTS = 512
_OFF = "Device name sync is off (DEVICE_NAME_SYNC=off, or the site has no sign-in), so no names are written to devices."
_CHANGED = "A site name changed since the compare. Reload Device names and try again."
_EXPECTED = "expected must give, for every port, the name the compare showed in its write column"


async def _port_device_or_404(device_id: str, db: AsyncSession) -> Device:
    dev = await db.scalar(select(Device).where(Device.id == device_id, Device.kind.in_(name_sync.PORT_KINDS)))
    if dev is None:
        raise HTTPException(404, "PDU or KVM not found")
    return dev


async def _rows(db: AsyncSession, device_ids=None) -> dict[str, dict[str, dict]]:
    query = select(DeviceNameSync)
    if device_ids is not None:
        query = query.where(DeviceNameSync.device_id.in_(list(device_ids)))
    found: dict[str, dict[str, dict]] = {}
    for row in (await db.execute(query)).scalars():
        found.setdefault(row.device_id, {})[row.port] = name_sync.row_out(row)
    return found


@router.get("/name-sync/status")
async def name_sync_status(device_id: list[str] | None = Query(default=None), db: AsyncSession = Depends(get_db)):
    """Each port's last sync record. Reads the database only; never contacts a device (Viewer)."""
    if device_id is not None and len(device_id) > _MAX_IDS:
        raise HTTPException(422, f"Ask for at most {_MAX_IDS} devices")
    devices = await _rows(db, device_id)
    for requested in device_id or ():
        devices.setdefault(requested, {})
    return {"mode": name_sync.mode(), "devices": devices}


@router.get("/{device_id}/device-names")
async def device_names(device_id: str, db: AsyncSession = Depends(get_db)):
    """Live compare: the site name and the name on the device for every port (Operator: contacts the device, except a
    disabled one; one shared read per device per 5 s)."""
    dev = await _port_device_or_404(device_id, db)
    rows = (await _rows(db, [device_id])).get(device_id, {})
    return await name_sync.live_compare(dev, rows)


def _requested(dev: Device, body) -> tuple[set[str], dict[str, str | None]]:
    """Explicit ports (never "all") and, for each, the write value the compare showed."""
    raw = body.get("ports") if isinstance(body, dict) else None
    if not isinstance(raw, list) or not raw or len(raw) > _MAX_PORTS:
        raise HTTPException(422, f"Choose the ports to write: a list of 1 to {_MAX_PORTS} port numbers")
    given = body.get("expected")
    if not isinstance(given, dict):
        raise HTTPException(422, _EXPECTED)
    expected_by_port = {}
    for key, value in given.items():
        port = name_sync.port_key(key)
        if port is None or (value is not None and not isinstance(value, str)):
            raise HTTPException(422, _EXPECTED)
        expected_by_port[port] = value
    ports, expected = set(), {}
    for value in raw:
        port = name_sync.port_key(value)
        if port is None or not name_sync.in_range(dev, port):
            shown = value if isinstance(value, (str, int)) and len(str(value)) <= 16 else "?"
            raise HTTPException(422, f"Unknown port: {shown}")
        if port not in expected_by_port:
            raise HTTPException(422, _EXPECTED)
        ports.add(port)
        expected[port] = expected_by_port[port]
    return ports, expected


@router.post("/{device_id}/device-names/push")
async def push_device_names(request: Request, device_id: str, body: dict | None = Body(default=None),
                            db: AsyncSession = Depends(get_db)):
    """Write the site names of exactly `ports` to the device, each then read back; `expected` ({port: write} from the
    compare) must still match, else 409. Awaited, one port at a time, under the device's write lock (Operator)."""
    # Without accounts there is no CSRF token and CORS allows any origin: a foreign page must never trigger a write.
    if not same_origin(request):
        raise HTTPException(403, "Cross-origin action rejected")
    if name_sync.mode() == "off":
        raise HTTPException(409, _OFF)
    dev = await _port_device_or_404(device_id, db)
    if not dev.enabled:
        raise HTTPException(409, name_sync.DISABLED)
    ports, expected = _requested(dev, body)
    if name_sync.current_writes(dev, ports) != expected:
        raise HTTPException(409, _CHANGED)
    try:
        results = await name_sync.push(dev.id, ports, expected)
    except name_sync.ExpectedMismatch:
        raise HTTPException(409, _CHANGED) from None
    except name_sync.Busy:
        raise HTTPException(409, name_sync.BUSY) from None
    return {"ok": all(r["status"] == "synced" for r in results), "results": results}
