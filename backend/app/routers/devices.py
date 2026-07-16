from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import uuid, json

from ..database import get_db
from ..models import Device
from ..schemas import DeviceCreate, DeviceOut
from ..crypto import encrypt, decrypt

router = APIRouter(prefix="/api/devices", tags=["devices"])


@router.get("/", response_model=list[DeviceOut])
async def list_devices(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Device).order_by(Device.rack, Device.name))
    return result.scalars().all()


@router.post("/", response_model=DeviceOut, status_code=201)
async def create_device(body: DeviceCreate, db: AsyncSession = Depends(get_db)):
    dev = Device(
        id=str(uuid.uuid4()),
        name=body.name,
        kind=body.kind,
        model=body.model,
        ip=body.ip,
        rack=body.rack,
        port_count=body.port_count,
        notes=body.notes,
        username_enc=encrypt(body.username) if body.username else "",
        password_enc=encrypt(body.password) if body.password else "",
    )
    db.add(dev)
    await db.commit()
    await db.refresh(dev)
    return dev


@router.put("/{device_id}", response_model=DeviceOut)
async def update_device(device_id: str, body: DeviceCreate, db: AsyncSession = Depends(get_db)):
    dev = await _get_or_404(device_id, db)
    dev.name = body.name
    dev.kind = body.kind
    dev.model = body.model
    dev.ip = body.ip
    dev.rack = body.rack
    dev.port_count = body.port_count
    dev.notes = body.notes
    if body.username:
        dev.username_enc = encrypt(body.username)
    if body.password:
        dev.password_enc = encrypt(body.password)
    await db.commit()
    await db.refresh(dev)
    return dev


@router.patch("/{device_id}/labels", status_code=200)
async def update_labels(
    device_id: str,
    labels: dict,
    db: AsyncSession = Depends(get_db),
):
    dev = await _get_or_404(device_id, db)
    dev.labels_json = json.dumps({str(k): v for k, v in labels.items() if v})
    await db.commit()
    return {"ok": True}


@router.delete("/{device_id}", status_code=204)
async def delete_device(device_id: str, db: AsyncSession = Depends(get_db)):
    dev = await _get_or_404(device_id, db)
    await db.delete(dev)
    await db.commit()


async def _get_or_404(device_id: str, db: AsyncSession) -> Device:
    result = await db.execute(select(Device).where(Device.id == device_id))
    dev = result.scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="Device not found")
    return dev


def get_creds(dev: Device) -> tuple[str, str]:
    """Decrypt stored credentials for a device."""
    username = decrypt(dev.username_enc) if dev.username_enc else ""
    password = decrypt(dev.password_enc) if dev.password_enc else ""
    return username, password
