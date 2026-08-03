from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import uuid, json, pathlib

from ..database import get_db
from ..models import Device
from ..schemas import DeviceCreate, DeviceOut
from ..crypto import encrypt, decrypt

router = APIRouter(prefix="/api/devices", tags=["devices"])

_BACKEND_DIR = pathlib.Path(__file__).parent.parent.parent


def _rename_server_ids_in_file(path: pathlib.Path, id_renames: dict[str, str]) -> None:
    """Rename server IDs inside rack_positions / rack_slots / switch_assignments JSON files."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return

    changed = False
    name = path.name

    if name == "rack_positions.json":
        # { rack: [server_id, ...] }
        for rack, ids in data.items():
            new_ids = [id_renames.get(sid, sid) for sid in ids]
            if new_ids != ids:
                data[rack] = new_ids
                changed = True

    elif name == "rack_slots.json":
        # { rack: { server_id: u_slot } }
        for rack, slots in data.items():
            new_slots = {id_renames.get(k, k): v for k, v in slots.items()}
            if new_slots != slots:
                data[rack] = new_slots
                changed = True

    elif name == "switch_assignments.json":
        # { server_id: { switch, port } }
        new_data = {id_renames.get(k, k): v for k, v in data.items()}
        if new_data != data:
            data = new_data
            changed = True

    if changed:
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")


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
    old_labels = json.loads(dev.labels_json) if dev.labels_json else {}
    new_labels = {str(k): v for k, v in labels.items() if v}

    # Detect renames: same port key, different non-empty value
    renames = {
        old_labels[port]: new_labels[port]
        for port in old_labels
        if port in new_labels
        and new_labels[port] != old_labels[port]
        and old_labels[port]
    }

    dev.labels_json = json.dumps(new_labels)

    if renames:
        # Case-insensitive lookup so "opt207" matches rename of "Opt207"
        renames_ci = {old.lower(): new for old, new in renames.items()}

        # Cascade label renames to all other PDUs and KVMs
        result = await db.execute(select(Device).where(Device.id != device_id))
        for other in result.scalars().all():
            other_labels = json.loads(other.labels_json) if other.labels_json else {}
            updated = {p: renames_ci.get(v.lower(), v) for p, v in other_labels.items()}
            if updated != other_labels:
                other.labels_json = json.dumps(updated)

        # Also rename server IDs in DCIM runtime JSON files so rack positions/slots stay intact
        id_renames = {old.lower(): new.lower() for old, new in renames.items()}
        for fname in ("rack_positions.json", "rack_slots.json", "switch_assignments.json"):
            _rename_server_ids_in_file(_BACKEND_DIR / fname, id_renames)

    await db.commit()
    return {"ok": True, "synced": list(renames.keys())}


@router.get("/sync-map")
async def get_sync_map(db: AsyncSession = Depends(get_db)):
    """Cross-reference all OPT labels across PDUs and KVMs."""
    result = await db.execute(select(Device))
    opt_index: dict[str, dict] = {}
    for dev in result.scalars().all():
        labels = json.loads(dev.labels_json) if dev.labels_json else {}
        for port, label in labels.items():
            if not label:
                continue
            key = label.lower()
            if key not in opt_index:
                opt_index[key] = {"opt_name": label, "pdus": [], "kvms": []}
            entry = {"device_id": dev.id, "device_name": dev.name, "port": port}
            if dev.kind == "pdu":
                opt_index[key]["pdus"].append(entry)
            elif dev.kind == "kvm":
                opt_index[key]["kvms"].append(entry)
    return sorted(opt_index.values(), key=lambda x: x["opt_name"].lower())


@router.patch("/direct-label", status_code=200)
async def set_direct_label(body: dict, db: AsyncSession = Depends(get_db)):
    """Set a label on one device port without cascading to other devices."""
    device_id = body.get("device_id")
    port = str(body.get("port", "")).strip()
    label = (body.get("label") or "").strip()
    if not device_id or not port:
        raise HTTPException(status_code=400, detail="device_id and port required")
    dev = await _get_or_404(device_id, db)
    labels = json.loads(dev.labels_json) if dev.labels_json else {}
    if label:
        labels[port] = label
    else:
        labels.pop(port, None)
    dev.labels_json = json.dumps(labels)
    await db.commit()
    return {"ok": True}


@router.post("/rename-opt", status_code=200)
async def rename_opt(body: dict, db: AsyncSession = Depends(get_db)):
    """Rename an OPT globally across all PDUs, KVMs, and DCIM position files."""
    old_name = (body.get("old_name") or "").strip()
    new_name = (body.get("new_name") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(status_code=400, detail="old_name and new_name required")
    if old_name.lower() == new_name.lower():
        raise HTTPException(status_code=400, detail="Names are identical")

    result = await db.execute(select(Device))
    updated = []
    for dev in result.scalars().all():
        labels = json.loads(dev.labels_json) if dev.labels_json else {}
        new_labels = {p: (new_name if v.lower() == old_name.lower() else v) for p, v in labels.items()}
        if new_labels != labels:
            dev.labels_json = json.dumps(new_labels)
            updated.append(dev.name)

    id_renames = {old_name.lower(): new_name.lower()}
    for fname in ("rack_positions.json", "rack_slots.json", "switch_assignments.json"):
        _rename_server_ids_in_file(_BACKEND_DIR / fname, id_renames)

    await db.commit()
    return {"ok": True, "updated_devices": updated}


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
