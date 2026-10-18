from contextlib import asynccontextmanager
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import asyncio, uuid, json, pathlib

from .. import inventory_store
from ..database import get_db
from ..models import Device, PduMaintenance
from ..pdu_locks import maintenance_lock
from ..schemas import DeviceCreate, DeviceOut
from ..crypto import encrypt, decrypt

router = APIRouter(prefix="/api/devices", tags=["devices"])

_BACKEND_DIR = pathlib.Path(__file__).parent.parent.parent
_labels_lock = asyncio.Lock()


async def _one_label_writer():
    """Label writes cascade across devices; one at a time keeps a labels revision check valid until the commit."""
    async with _labels_lock:
        yield


async def _rename_monitor_and_owner(db, old_name, new_name):
    """Keep stable monitor IDs/history and owner assignments across inventory renames."""
    from ..models import AssetOwner, PingTarget
    from ..ping_monitor import server_identity
    from ..engineers import owner_map
    old, new = server_identity(old_name), server_identity(new_name)
    if not old or not new:
        return
    target = await db.scalar(select(PingTarget).where(PingTarget.source_key == "server:" + old[0]))
    if old[0] != new[0]:
        collision = await db.scalar(select(PingTarget).where(PingTarget.source_key == "server:" + new[0]))
        if collision:
            raise HTTPException(409, "This server name already has a monitor. Choose a different name.")
        owners = await owner_map(db)
        if new[0] in owners:
            raise HTTPException(409, "This server name already has an owner. Choose a different name.")
        assignment = await db.get(AssetOwner, old[0])
        if assignment or old[0] in owners:
            destination = await db.get(AssetOwner, new[0])
            if destination is None:
                destination = AssetOwner(asset_key=new[0]); db.add(destination)
            destination.engineer_id = assignment.engineer_id if assignment else None
            destination.legacy_name = assignment.legacy_name if assignment else owners[old[0]]
            if assignment is None:
                assignment = AssetOwner(asset_key=old[0]); db.add(assignment)
            # Tombstone prevents the old JSON fallback from resurrecting an owner.
            assignment.engineer_id, assignment.legacy_name = None, ""
    if target:
        target.source_key, target.name = "server:" + new[0], new[1]
        target.revision += 1  # Ignore a probe still in flight for the old identity.


def _rename_server_ids_in_file(path: pathlib.Path, id_renames: dict[str, str]) -> None:
    """Rename server IDs inside rack_positions / rack_slots / switch_assignments / rack_overrides JSON files,
    with the same per-file lock and atomic writer as their PUT endpoints."""
    if path.exists():
        with inventory_store.locked_file(path, inventory_store.LAYOUT_SAVE_FAILED):
            _rename_server_ids_locked(path, id_renames)


def _rename_server_ids_locked(path: pathlib.Path, id_renames: dict[str, str]) -> None:
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

    elif name in ("switch_assignments.json", "rack_overrides.json"):
        # { server_id: { switch, port } } / { server_id: rack }
        new_data = {id_renames.get(k, k): v for k, v in data.items()}
        if new_data != data:
            data = new_data
            changed = True

    if changed:
        inventory_store.write_json(path, data)


@router.get("/", response_model=list[DeviceOut])
async def list_devices(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Device).order_by(Device.rack, Device.name))
    return result.scalars().all()


def _check_address(ip: str):
    """One IP address or DNS host name: no scheme, port, path, quotes or spaces (it reaches drivers and proxied pages)."""
    from ..ping_monitor import validate_host
    try:
        if ip != ip.strip():
            raise ValueError
        validate_host(ip)
    except ValueError:
        raise HTTPException(422, "Enter a single IP address or DNS host name (no http://, port, path, quotes or spaces).") from None


@router.post("/", response_model=DeviceOut, status_code=201)
async def create_device(body: DeviceCreate, db: AsyncSession = Depends(get_db)):
    _check_address(body.ip)
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


async def _reject_if_in_maintenance(device_id: str, db: AsyncSession):
    # The maintenance restore list is only meaningful for the PDU at the address it was taken from.
    if await db.get(PduMaintenance, device_id, populate_existing=True):
        raise HTTPException(409, "PDU is in maintenance mode; restore it first")


@asynccontextmanager
async def _locked_device(device_id: str, db: AsyncSession):
    """Holds the PDU maintenance lock so the maintenance check and the commit cannot interleave with a shutdown."""
    await _get_or_404(device_id, db)  # unknown ids never get a lock entry
    async with maintenance_lock(device_id):
        dev = await db.scalar(select(Device).where(Device.id == device_id).execution_options(populate_existing=True))
        if not dev:
            raise HTTPException(status_code=404, detail="Device not found")
        yield dev


@router.put("/{device_id}", response_model=DeviceOut)
async def update_device(device_id: str, body: DeviceCreate, db: AsyncSession = Depends(get_db)):
    async with _locked_device(device_id, db) as dev:
        if body.ip != dev.ip:
            _check_address(body.ip)  # an unchanged saved address never blocks other edits
        if body.ip != dev.ip or body.kind != dev.kind:
            await _reject_if_in_maintenance(device_id, db)
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
    if_match: str | None = Header(default=None),
    _writer: None = Depends(_one_label_writer),
):
    dev = await _get_or_404(device_id, db)
    if if_match and if_match != inventory_store.revision(dev.labels):
        raise HTTPException(409, "Port labels on this device were changed in another session. Reload and try again.")
    old_labels = json.loads(dev.labels_json) if dev.labels_json else {}
    if any(not isinstance(v, str) for v in labels.values()):
        raise HTTPException(422, "Label values must be text")
    # Keys this device already has are accepted whatever they are, so saved maps keep round-tripping.
    if any(not (k.isascii() and k.isdigit()) and k not in old_labels for k in labels):
        raise HTTPException(422, "Port keys must be numbers")
    new_labels = {str(k): v for k, v in labels.items() if v}

    # Detect renames: same port key, different non-empty value
    renames = {
        old_labels[port]: new_labels[port]
        for port in old_labels
        if port in new_labels
        and new_labels[port] != old_labels[port]
        and old_labels[port]
    }

    for old_name, new_name in renames.items():
        await _rename_monitor_and_owner(db, old_name, new_name)
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
        for fname in ("rack_positions.json", "rack_slots.json", "switch_assignments.json", "rack_overrides.json"):
            _rename_server_ids_in_file(_BACKEND_DIR / fname, id_renames)

    await db.commit()
    return {"ok": True, "synced": list(renames.keys()), "labels_revision": inventory_store.revision(new_labels)}


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
async def set_direct_label(body: dict, db: AsyncSession = Depends(get_db), _writer: None = Depends(_one_label_writer)):
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
async def rename_opt(body: dict, db: AsyncSession = Depends(get_db), _writer: None = Depends(_one_label_writer)):
    """Rename an OPT globally across all PDUs, KVMs, and DCIM position files."""
    old_name = (body.get("old_name") or "").strip()
    new_name = (body.get("new_name") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(status_code=400, detail="old_name and new_name required")
    if old_name.lower() == new_name.lower():
        raise HTTPException(status_code=400, detail="Names are identical")

    await _rename_monitor_and_owner(db, old_name, new_name)

    result = await db.execute(select(Device))
    updated = []
    for dev in result.scalars().all():
        labels = json.loads(dev.labels_json) if dev.labels_json else {}
        new_labels = {p: (new_name if v.lower() == old_name.lower() else v) for p, v in labels.items()}
        if new_labels != labels:
            dev.labels_json = json.dumps(new_labels)
            updated.append(dev.name)

    id_renames = {old_name.lower(): new_name.lower()}
    for fname in ("rack_positions.json", "rack_slots.json", "switch_assignments.json", "rack_overrides.json"):
        _rename_server_ids_in_file(_BACKEND_DIR / fname, id_renames)

    await db.commit()
    return {"ok": True, "updated_devices": updated}


@router.delete("/{device_id}", status_code=204)
async def delete_device(device_id: str, db: AsyncSession = Depends(get_db)):
    async with _locked_device(device_id, db) as dev:
        await _reject_if_in_maintenance(device_id, db)
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
