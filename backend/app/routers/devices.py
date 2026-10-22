from contextlib import ExitStack, asynccontextmanager
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import asyncio, uuid, json, logging, pathlib

from .. import inventory_store, name_sync
from ..database import get_db
from ..models import Device, PduMaintenance
from ..pdu_locks import maintenance_lock
from ..schemas import DeviceCreate, DeviceOut
from ..crypto import encrypt, decrypt

router = APIRouter(prefix="/api/devices", tags=["devices"])
log = logging.getLogger(__name__)

_BACKEND_DIR = pathlib.Path(__file__).parent.parent.parent
_labels_lock = asyncio.Lock()


async def _one_label_writer():
    """Label writes (one device, a server move, a global rename) run one at a time, so a labels revision
    check stays valid until the commit."""
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
    # A port that had a saved label and is now empty or left out (DCIM's remove/move delete the key) keeps the
    # default name, so a name saved on the PDU/KVM itself cannot come back. Never-labelled ports stay absent.
    for port, before in old_labels.items():
        if port not in new_labels and isinstance(before, str) and before.strip():
            _clear_port(new_labels, dev, port)
    # The same for a port sent explicitly as "" whose server name comes only from the PDU/KVM itself (nothing saved,
    # status cache only): without the default name the device's own name would still show and the clear not stick.
    reported = _live_labels(dev)
    for port in (str(k) for k, v in labels.items() if not v):
        if port not in new_labels and _identity(reported.get(port)):
            _clear_port(new_labels, dev, port)
    # Only this device's ports change: no cascade to other PDUs/KVMs, monitors, owners or rack layout files.
    # A move goes through /move-server and a deliberate global rename through /rename-opt.
    dev.labels_json = json.dumps(new_labels)
    await db.commit()
    # Only now, with the save committed: the ports whose saved label changed go to the PDU/KVM itself.
    changed = {p for p in set(old_labels) | set(new_labels) if old_labels.get(p) != new_labels.get(p)}
    names = await name_sync.queue({device_id: changed})
    return {"ok": True, "synced": [], "labels_revision": inventory_store.revision(new_labels), **names}


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


def _cleared_label(dev, port: str) -> str:
    """What a cleared port stores: the default name, so a name saved on the PDU/KVM itself cannot come back."""
    return f"Outlet {port}" if dev.kind == "pdu" else f"Port {port}"


def _clear_port(labels: dict, dev, port: str) -> None:
    """Numbered ports keep the default name. A legacy non-numeric key is removed: no hardware name sits behind it,
    and "Outlet A1" would read as a server name (server_identity only treats "Outlet/Port <digits>" as default)."""
    if port.isascii() and port.isdigit():
        labels[port] = _cleared_label(dev, port)
    else:
        labels.pop(port, None)


def _shown_labels(dev, labels: dict, port: str) -> set:
    """Every label a page may have shown for this port: the saved one, or with nothing saved, blank, the default
    name or the name the PDU/KVM itself reports (cached status, no device contact)."""
    saved = labels.get(port)
    if isinstance(saved, str) and saved.strip():
        return {saved.strip()}
    shown = {""}
    if port.isascii() and port.isdigit():
        shown.add(_cleared_label(dev, port))
    live = _live_labels(dev).get(port)
    if live:
        shown.add(live.strip())
    return shown


def _live_labels(dev) -> dict:
    """Port names the PDU/KVM itself reported, from the in-memory status cache only (never contacts a device)."""
    from . import kvms, pdus
    cached = (pdus._cache if dev.kind == "pdu" else kvms._cache if dev.kind == "kvm" else {}).get(dev.id)
    entries = (getattr(cached[1], "outlets" if dev.kind == "pdu" else "ports", None) if cached else None) or []
    return {str(e.number): e.label for e in entries if isinstance(getattr(e, "label", None), str) and e.label.strip()}


def _effective_labels(dev, saved: dict) -> dict:
    """What the pages show: saved labels, and for a port with nothing saved, the name the device reports."""
    labels = dict(saved)
    for port, label in _live_labels(dev).items():
        labels.setdefault(port, label)
    return labels


@router.patch("/direct-label", status_code=200)
async def set_direct_label(body: dict, db: AsyncSession = Depends(get_db), _writer: None = Depends(_one_label_writer)):
    """Set a label on one device port without cascading to other devices. With `expected` (the label the page
    showed), a port changed in another session is refused instead of overwritten."""
    device_id = body.get("device_id")
    port = str(body.get("port", "")).strip()
    label = (body.get("label") or "").strip()
    expected = body.get("expected")
    if not device_id or not port:
        raise HTTPException(status_code=400, detail="device_id and port required")
    if expected is not None and not isinstance(expected, str):
        raise HTTPException(status_code=400, detail="expected must be the label shown for the port")
    dev = await _get_or_404(device_id, db)
    labels = json.loads(dev.labels_json) if dev.labels_json else {}
    if expected is not None and expected.strip() not in _shown_labels(dev, labels, port):
        raise HTTPException(409, "This port changed in another session. Reload and try again.")
    before = labels.get(port)
    if label:
        labels[port] = label
    else:
        # A numbered port keeps the default name ("Outlet N" / "Port N"), so a name saved on the PDU/KVM itself
        # cannot come back; a legacy non-numeric key is removed.
        _clear_port(labels, dev, port)
    dev.labels_json = json.dumps(labels)
    await db.commit()
    names = await name_sync.queue({device_id: {port}} if labels.get(port) != before else {})
    return {"ok": True, **names}


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
    updated, changed = [], {}
    for dev in result.scalars().all():
        labels = json.loads(dev.labels_json) if dev.labels_json else {}
        new_labels = {p: (new_name if v.lower() == old_name.lower() else v) for p, v in labels.items()}
        if new_labels != labels:
            dev.labels_json = json.dumps(new_labels)
            updated.append(dev.name)
            changed[dev.id] = {p for p in labels if new_labels[p] != labels[p]}

    id_renames = {old_name.lower(): new_name.lower()}
    for fname in ("rack_positions.json", "rack_slots.json", "switch_assignments.json", "rack_overrides.json"):
        _rename_server_ids_in_file(_BACKEND_DIR / fname, id_renames)

    await db.commit()
    # A default port name ("Outlet 5") renamed everywhere is not a server rename: it is never pushed automatically.
    if _identity(old_name) and _identity(new_name):
        names = await name_sync.queue(changed)
    else:
        names = name_sync.not_queued(name_sync.PLACEHOLDER_RENAME)
    return {"ok": True, "updated_devices": updated, **names}


# ── Server locations: which PDU outlets / KVM ports / rack slot each server occupies, with an explicit move ──
# A server is an identity (ping_monitor.server_identity) and its PORTS are every saved PDU/KVM label with that
# identity. A move rewrites port labels and the rack layout files; it never touches monitors or owners, which
# follow the server, not the location.

_LAYOUT_FILES = ("rack_overrides.json", "rack_positions.json", "rack_slots.json", "switch_assignments.json")
_PORT_KINDS = ("pdu", "kvm")
_MAX_LISTED_PORTS = 512
_MAX_TARGET_PORTS = 64
_MAX_NAME = 200
_MOVE_FAILED = "The move could not be saved. No changes were made; please retry."
_MOVE_HALF_SAVED = ("The move was only partly saved: the port labels changed but the rack positions did not. "
                    "Check this server in Locations and move it again.")
_LAYOUT_CHANGED = "The rack layout changed in another session during the move. No changes were made; preview again."
_MOVE_NOT_RESTORED = ("The move failed and the rack layout could not be fully restored ({files}). "
                      "Check Locations and fix the rack positions there.")


class _LayoutNotRestored(Exception):
    """A layout write failed and putting back an already written file failed too: the move is partly applied."""

    def __init__(self, files):
        super().__init__(", ".join(files))
        self.files = files


def _identity(name):
    from ..ping_monitor import server_identity
    return server_identity(name) if isinstance(name, str) else None


def _key_of(name):
    found = _identity(name)
    return found[0] if found else None


def _short_number(value):
    """True for 1-9 ASCII digits: int() of it is cheap (saved files and request bodies can hold anything)."""
    return isinstance(value, str) and 0 < len(value) <= 9 and value.isascii() and value.isdigit()


def _port_order(port):
    port = str(port)
    return (0, int(port), "") if _short_number(port) else (1, 0, port)


def _number_key(port):
    """A numbered port as its plain number ("01" -> "1"); other keys unchanged."""
    port = str(port)
    return str(int(port)) if _short_number(port) else port


def _saved_port_key(saved: dict, port: str) -> str:
    """The key this numbered port already has in the saved labels ("01" and "1" are the same outlet), else "1"."""
    number = _number_key(port)
    if number in saved:
        return number
    return next((k for k in saved if isinstance(k, str) and _number_key(k) == number), number)


def _device_order(dev):
    return (dev.kind != "pdu", (dev.rack or "").casefold(), (dev.name or "").casefold(), dev.id)


def _saved_labels(dev):
    """(labels, readable). Unreadable saved labels read as no labels and are never overwritten by a move."""
    try:
        labels = json.loads(dev.labels_json or "{}")
    except ValueError:
        return {}, False
    return (labels, True) if isinstance(labels, dict) else ({}, False)


def _relabel(label: str, name: str) -> str:
    """`name` on a port that held `label`, keeping that port's own suffix ("OPTN44 (PSU2)" -> "optn45 (PSU2)")
    as long as the result still names the same server."""
    stripped = label.strip()
    found = _identity(stripped)
    suffix = stripped[len(found[1]):] if found else ""
    if suffix and _key_of(name + suffix) != _key_of(name):
        return name
    return name + suffix


def _servers(devices, labels):
    """identity key -> {"name": display name as first written, "ports": [(device, port, label)]} from saved labels."""
    servers = {}
    for dev in devices:
        saved = labels[dev.id]
        for port in sorted(saved, key=_port_order):
            found = _identity(saved[port])
            if found:
                servers.setdefault(found[0], {"name": found[1], "ports": []})["ports"].append((dev, port, saved[port]))
    return servers


def _read_layouts(strict):
    """The four layout files as dicts, plus the names of the files that exist. A missing file is empty; an unreadable
    one is empty for a listing but stops a move (it would otherwise be overwritten)."""
    layouts, present = {}, set()
    for fname in _LAYOUT_FILES:
        path = _BACKEND_DIR / fname
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            present.add(fname)
        except FileNotFoundError:
            data = {}
        except (OSError, ValueError):
            data = None
        if not isinstance(data, dict):
            if strict:
                raise HTTPException(503, f"The rack layout file {fname} cannot be read, so nothing was moved.")
            data = {}
        layouts[fname] = data
    return layouts, present


def _layout_ids(layouts, fnames=None):
    """identity key -> server ids used as keys in the layout files (DCIM keys them by the lower-case port label)."""
    fnames = set(fnames or _LAYOUT_FILES)
    index = {}

    def add(value):
        key = _key_of(value)
        if key:
            index.setdefault(key, set()).add(value)

    if "rack_slots.json" in fnames:
        for entries in layouts["rack_slots.json"].values():
            if isinstance(entries, dict):
                for value in entries:
                    add(value)
    if "rack_positions.json" in fnames:
        for entries in layouts["rack_positions.json"].values():
            if isinstance(entries, list):
                for value in entries:
                    add(value)
    for fname in ("rack_overrides.json", "switch_assignments.json"):
        if fname in fnames:
            for value in layouts[fname]:
                add(value)
    return index


_POSITION_LAYOUTS = ("rack_slots.json", "rack_positions.json", "rack_overrides.json")


def _all_servers(devices, labels, layouts, names):
    """Servers on PDU/KVM ports, plus servers with no port that the rack layout files or a ping monitor still know
    (unplaced or cleared): they stay listed and can be moved to ports. A monitor's name is the display name."""
    servers = _servers(devices, labels)
    portless = {}
    for key, ids in _layout_ids(layouts, _POSITION_LAYOUTS).items():
        if key not in servers:
            portless[key] = _identity(sorted(ids)[0])[1]
    for key, name in names.items():
        if key not in servers:
            portless[key] = name
    for key in sorted(portless):
        servers[key] = {"name": portless[key], "ports": []}
    return servers


async def _monitor_names(db):
    """identity key -> name for every server ping monitor (source "server:<key>")."""
    from ..models import PingTarget
    rows = (await db.execute(select(PingTarget.source_key, PingTarget.name)
                             .where(PingTarget.source_key.startswith("server:")))).all()
    names = {}
    for source_key, name in rows:
        found = _identity(source_key[len("server:"):])
        if found:
            names[found[0]] = name if _key_of(name) == found[0] else found[1]
    return names


def _pin(layouts, dcim_ids, rack, slot):
    """Keep a server at rack/slot under its current ids (rack override, and its U in that rack)."""
    overrides, slots = layouts["rack_overrides.json"], layouts["rack_slots.json"]
    if slot is not None:
        if rack not in slots:
            slots[rack] = {}
        elif not isinstance(slots[rack], dict):
            raise HTTPException(503, f"The rack layout file rack_slots.json has an invalid entry for {rack}, so nothing was moved.")
    for i in dcim_ids:
        overrides[i] = rack
        if slot is not None:
            slots[rack][i] = slot


def _dcim_ids(server):
    """The ids the DCIM view uses for this server: each port label, trimmed and lower-cased, in port order."""
    ids = []
    for _, _, label in server["ports"]:
        value = label.strip().lower()
        if value not in ids:
            ids.append(value)
    return ids or [server["name"].lower()]


def _slot_value(value):
    """A rack U from a layout file, or None. Only 1..9999 counts (a huge number or digit string is ignored)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip()
        value = int(value) if 0 < len(value) <= 4 and value.isascii() and value.isdigit() else None
    elif isinstance(value, float):
        value = int(value) if value.is_integer() and 1 <= value <= 9999 else None
    return value if isinstance(value, int) and 1 <= value <= 9999 else None


def _position(server, ids, layouts):
    """Where the DCIM view shows a server: its rack override, else its first PDU's rack (as DCIM does), else the
    rack that lists it in rack_slots / rack_positions, else its KVM's rack; the slot is its U in that rack."""
    preferred = [i for i in _dcim_ids(server) if i in ids]
    ranked = preferred + sorted(set(ids) - set(preferred))
    overrides, slots, order = (layouts[f] for f in ("rack_overrides.json", "rack_slots.json", "rack_positions.json"))
    rack = next((overrides[i] for i in ranked if isinstance(overrides.get(i), str) and overrides[i].strip()), None)
    if rack is None:
        rack = next((dev.rack for dev, _, _ in server["ports"] if dev.kind == "pdu" and dev.rack), None)
    if rack is None:
        rack = next((r for r in sorted(slots) if isinstance(slots[r], dict) and any(i in slots[r] for i in ranked)), None)
    if rack is None:
        rack = next((r for r in sorted(order) if isinstance(order[r], list) and any(i in order[r] for i in ranked)), None)
    if rack is None:
        rack = next((dev.rack for dev, _, _ in server["ports"] if dev.rack), None)
    slot = None
    in_rack = slots.get(rack) if rack is not None else None
    if isinstance(in_rack, dict):
        slot = next((s for s in (_slot_value(in_rack.get(i)) for i in ranked if i in in_rack) if s is not None), None)
    return {"rack": rack, "slot": slot}


_VALUED_LAYOUTS = frozenset({"rack_slots.json", "rack_overrides.json", "switch_assignments.json"})
_LAYOUT_NAMES = {"rack_slots.json": "rack slots", "rack_overrides.json": "rack assignments",
                 "switch_assignments.json": "switch assignments", "rack_positions.json": "rack order"}


def _rename_layout_ids(layouts, renames, drop=frozenset(), strict=_VALUED_LAYOUTS):
    """Rename server ids in all four layout files at once (so a swap is one simultaneous rename); `drop` ids leave.
    When two ids would become one (dual feeds moved to plain-name ports), equal values merge; different values in a
    `strict` file are refused (409) rather than one silently lost. Elsewhere the entry already there is kept."""

    def remap(fname, keys, values=None):
        kept = [k for k in keys if not (isinstance(k, str) and k in drop)]
        fixed = {k for k in kept if isinstance(k, str) and k not in renames}
        out, produced = [], {}
        for k in kept:
            if isinstance(k, str) and k in renames:
                new = renames[k]
                if new in fixed or new in produced:
                    other = new if new in fixed else produced[new]
                    if values is not None and fname in strict and values[other] != values[k]:
                        raise HTTPException(409, f"The {_LAYOUT_NAMES[fname]} have different entries for {other} and "
                                                 f"{k}, which would both become {new}. Make them the same or remove "
                                                 "one in the DCIM view, then try again.")
                    continue
                produced[new] = k
                out.append((k, new))
            else:
                out.append((k, k))
        return out

    slots = layouts["rack_slots.json"]
    for rack, entries in list(slots.items()):
        if isinstance(entries, dict):
            slots[rack] = {new: entries[old] for old, new in remap("rack_slots.json", list(entries), entries)}
    order = layouts["rack_positions.json"]
    for rack, entries in list(order.items()):
        if isinstance(entries, list):
            order[rack] = [new for _, new in remap("rack_positions.json", entries)]
    for fname in ("rack_overrides.json", "switch_assignments.json"):
        data = layouts[fname]
        layouts[fname] = {new: data[old] for old, new in remap(fname, list(data), data)}


def _place(layouts, ids, dcim_ids, rack, slot):
    """Put one server at rack/slot: all its ids leave every rack, then each DCIM id gets the rack override and U."""
    drop = set(ids) | set(dcim_ids)
    slots, order, overrides = (layouts[f] for f in ("rack_slots.json", "rack_positions.json", "rack_overrides.json"))
    for entries in slots.values():
        if isinstance(entries, dict):
            for i in drop:
                entries.pop(i, None)
    for rack_name, entries in list(order.items()):
        if isinstance(entries, list):
            order[rack_name] = [i for i in entries if not (isinstance(i, str) and i in drop)]
    for i in drop:
        overrides.pop(i, None)
    if rack is None:
        return
    if slot is not None:
        if rack not in slots:
            slots[rack] = {}
        elif not isinstance(slots[rack], dict):
            raise HTTPException(503, f"The rack layout file rack_slots.json has an invalid entry for {rack}, so nothing was moved.")
    for i in dcim_ids:
        overrides[i] = rack
        if slot is not None:
            slots[rack][i] = slot


def _port_out(dev, port, label=None):
    entry = {"device_id": dev.id, "device_name": dev.name, "port": port}
    if label is not None:
        entry["label"] = label
    return entry


async def _port_devices(db):
    devices = (await db.execute(select(Device).where(Device.kind.in_(_PORT_KINDS)))).scalars().all()
    return sorted(devices, key=_device_order)


@router.get("/locations")
async def get_locations(db: AsyncSession = Depends(get_db)):
    """Server-centric view: each server's rack, U slot, PDU outlets and KVM ports, plus the empty ports."""
    return await server_locations(db)


async def server_locations(db) -> dict:
    """GET /locations' body. Read-only (saved labels, status caches, rack layout files; never a device); the
    connections export reuses it so its Rack / U slot columns and server list match the Locations page."""
    all_devices = (await db.execute(select(Device))).scalars().all()
    devices = sorted((d for d in all_devices if d.kind in _PORT_KINDS), key=_device_order)
    # As the pages show them: saved labels, else the name the PDU/KVM reports (status cache, no device contact).
    labels = {dev.id: _effective_labels(dev, _saved_labels(dev)[0]) for dev in devices}
    layouts, _ = _read_layouts(strict=False)
    index = _layout_ids(layouts)
    rows = []
    for key, server in _all_servers(devices, labels, layouts, await _monitor_names(db)).items():
        position = _position(server, index.get(key, set()), layouts)
        rows.append({"key": key, "name": server["name"], **position,
                     **{kind: [_port_out(dev, port, label) for dev, port, label in server["ports"] if dev.kind == kind]
                        for kind in _PORT_KINDS}})
    rows.sort(key=lambda r: (r["rack"] is None, (r["rack"] or "").casefold(), r["slot"] is None, r["slot"] or 0,
                             r["name"].casefold(), r["key"]))
    empty = {kind: [] for kind in _PORT_KINDS}
    for dev in sorted(devices, key=lambda d: ((d.name or "").casefold(), d.id)):
        count = min(dev.port_count or 0, _MAX_LISTED_PORTS)
        used = {_number_key(port) for port, label in labels[dev.id].items() if _identity(label)}
        empty[dev.kind].extend(_port_out(dev, str(n)) for n in range(1, count + 1) if str(n) not in used)
    racks = {d.rack for d in all_devices if d.rack} | {r["rack"] for r in rows if r["rack"]}
    racks |= set(layouts["rack_slots.json"]) | set(layouts["rack_positions.json"])
    racks |= {v for v in layouts["rack_overrides.json"].values() if isinstance(v, str) and v.strip()}
    try:
        racks |= set(inventory_store.read_items())
    except HTTPException:
        pass  # an unreadable equipment list only hides its rack names here
    return {"servers": rows, "empty_ports": empty, "racks": sorted(racks, key=lambda r: (r.casefold(), r))}


def _choice(body, name):
    value = body.get(name)
    if value is not None and (not isinstance(value, str) or len(value) > _MAX_NAME or not _key_of(value)):
        raise HTTPException(400, "Choose a server by name.")
    return value


def _plan_move(body, devices, labels, unreadable, layouts, names):
    """Everything a move changes, computed in memory: (new labels, new layouts, response). Raises 400/404/409."""
    if not isinstance(body.get("server"), str) or len(body["server"]) > _MAX_NAME or not _key_of(body["server"]):
        raise HTTPException(400, "Choose the server to move")
    target_server, target_ports = _choice(body, "target_server"), body.get("target_ports")
    if (target_server is None) == (target_ports is None):
        raise HTTPException(400, "Choose either a target server or target ports, not both")
    swap = body.get("swap", True)
    if not isinstance(swap, bool):
        raise HTTPException(400, "swap must be true or false")
    target_rack, target_slot = body.get("target_rack"), body.get("target_slot")
    if target_rack is not None and (not isinstance(target_rack, str) or not target_rack.strip()
                                    or len(target_rack) > _MAX_NAME):
        raise HTTPException(400, "Choose a rack name (at most 200 characters).")
    if target_slot is not None and (isinstance(target_slot, bool) or not isinstance(target_slot, int)
                                    or not 1 <= target_slot <= 999):
        raise HTTPException(400, "The slot must be a whole number from 1 to 999.")
    if target_server is not None and (target_rack is not None or target_slot is not None):
        raise HTTPException(400, "A target server brings its own rack and slot; choose a rack or slot only when moving to ports.")

    servers = _all_servers(devices, labels, layouts, names)
    key = _key_of(body["server"])
    mover = servers.get(key)
    if mover is None:
        raise HTTPException(404, "Server not found")
    index = _layout_ids(layouts)
    new_labels = {dev_id: dict(saved) for dev_id, saved in labels.items()}
    new_layouts = json.loads(json.dumps(layouts))
    involved, unplaced = [key], []

    if target_server is not None:
        tkey = _key_of(target_server)
        if tkey == key:
            raise HTTPException(400, "The server and the target server are the same")
        target = servers.get(tkey)
        if target is None:
            raise HTTPException(404, "Target server not found")
        involved.append(tkey)
        if swap:
            for dev, port, label in mover["ports"]:
                new_labels[dev.id][port] = _relabel(label, target["name"])
            renames = {i: _relabel(i, target["name"]).lower() for i in index.get(key, ())}
            drop = set()
        else:
            for dev, port, _ in mover["ports"]:
                _clear_port(new_labels[dev.id], dev, port)
            renames, drop = {}, index.get(key, set())
            unplaced.append(target["name"])
        for dev, port, label in target["ports"]:
            new_labels[dev.id][port] = _relabel(label, mover["name"])
        renames.update({i: _relabel(i, mover["name"]).lower() for i in index.get(tkey, ())})
        _rename_layout_ids(new_layouts, renames, drop)
    else:
        if not isinstance(target_ports, list) or not target_ports:
            raise HTTPException(400, "Choose at least one target port")
        if len(target_ports) > _MAX_TARGET_PORTS:
            raise HTTPException(400, f"Choose at most {_MAX_TARGET_PORTS} target ports")
        by_id = {dev.id: dev for dev in devices}
        chosen, seen = [], set()
        for entry in target_ports:
            port = entry.get("port") if isinstance(entry, dict) else None
            if isinstance(port, int) and not isinstance(port, bool):
                port = str(port)
            device_id = entry.get("device_id") if isinstance(entry, dict) else None
            if not isinstance(device_id, str) or not isinstance(port, str) or not port.strip():
                raise HTTPException(400, "Each target port needs a device_id and a port")
            port = port.strip()
            dev = by_id.get(device_id)
            if dev is None:
                raise HTTPException(404, "PDU or KVM not found")
            # A port is a 1-4 digit number within the device's port count, or a key the device already has.
            numbered = len(port) <= 4 and _short_number(port) and bool(dev.port_count) and 1 <= int(port) <= dev.port_count
            if port not in labels[dev.id] and not numbered:
                raise HTTPException(400, f"{dev.name} has no port {port}" if len(port) <= 16 else f"{dev.name} has no such port")
            if numbered:
                port = _saved_port_key(labels[dev.id], port)  # "01" and "1" are the same outlet
            same_port = [k for k in labels[dev.id] if k == port or (numbered and _number_key(k) == _number_key(port))]
            owner = next((o for o in (_key_of(labels[dev.id][k]) for k in same_port) if o and o != key), None)
            if owner:
                name = servers[owner]["name"]
                raise HTTPException(409, f"Port {_number_key(port)} on {dev.name} is used by {name}. "
                                         f"Choose {name} as the target to swap.")
            if (dev.id, port) not in seen:
                seen.add((dev.id, port))
                chosen.append((dev, port))
        keep = {(d.id, p) for d, p in chosen}
        for dev, port, _ in mover["ports"]:
            if (dev.id, port) not in keep:
                _clear_port(new_labels[dev.id], dev, port)
        for dev, port in chosen:
            if _key_of(labels[dev.id].get(port)) != key:
                new_labels[dev.id][port] = mover["name"]
        moved = _servers(devices, new_labels)[key]
        current_ids = _dcim_ids(moved)
        obsolete = {i for i in index.get(key, ()) if i not in current_ids}
        if obsolete:
            # The DCIM view keys positions by label, so the mover's layout entries follow its new labels. A rack
            # given here replaces the mover's rack entries and slot (and a slot alone its slot), so only conflicts
            # that survive the placement below stop the move.
            strict = set(_VALUED_LAYOUTS)
            if target_rack is not None:
                strict -= {"rack_slots.json", "rack_overrides.json"}
            elif target_slot is not None:
                strict -= {"rack_slots.json"}
            _rename_layout_ids(new_layouts, {i: current_ids[0] for i in sorted(obsolete)}, strict=strict)
        original = _position(mover, index.get(key, set()), layouts)
        if target_rack is None and target_slot is None:
            # Ports alone never move a server: a port on another rack's PDU must not change its rack or drop its U.
            after_index = _layout_ids(new_layouts)
            if original["rack"] is not None and _position(moved, after_index.get(key, set()), new_layouts) != original:
                _pin(new_layouts, current_ids, original["rack"], original["slot"])
        else:
            after_servers = _all_servers(devices, new_labels, new_layouts, names)
            after_index = _layout_ids(new_layouts)
            rack = target_rack.strip() if target_rack is not None else original["rack"]
            if rack is None:
                raise HTTPException(400, "Choose a rack for the slot")
            occupant = None
            if target_slot is not None:
                occupant = next((k for k, s in sorted(after_servers.items()) if k != key and
                                 _position(s, after_index.get(k, set()), new_layouts) == {"rack": rack, "slot": target_slot}), None)
            if occupant and not swap:
                name = after_servers[occupant]["name"]
                raise HTTPException(409, f"U{target_slot} in {rack} is used by {name}. "
                                         f"Allow the swap to exchange positions with {name}, or choose another slot.")
            _place(new_layouts, after_index.get(key, set()), current_ids, rack, target_slot)
            if occupant:
                involved.append(occupant)
                _place(new_layouts, after_index.get(occupant, set()), _dcim_ids(after_servers[occupant]),
                       original["rack"], original["slot"])

    changes = []
    for dev in devices:
        before, after = labels[dev.id], new_labels[dev.id]
        for port in sorted(set(before) | set(after), key=_port_order):
            if before.get(port) != after.get(port):
                if dev.id in unreadable:
                    raise HTTPException(503, f"The saved port labels of {dev.name} cannot be read, so nothing was moved.")
                changes.append({"device_id": dev.id, "device_name": dev.name, "kind": dev.kind, "port": port,
                                "before": before.get(port), "after": after.get(port)})
    after_servers, after_index = _all_servers(devices, new_labels, new_layouts, names), _layout_ids(new_layouts)
    positions = []
    for k in involved:
        name = servers[k]["name"]
        positions.append({"server": name,
                          "before": _position(servers[k], index.get(k, set()), layouts),
                          "after": _position(after_servers.get(k) or {"name": name, "ports": []},
                                             after_index.get(k, set()), new_layouts)})
    plan = {"changes": changes, "positions": positions, "unplaced": unplaced}
    # The preview's token: Apply sends it back and is refused if a fresh plan differs from what was previewed.
    plan["plan_revision"] = inventory_store.revision(plan)
    return new_labels, new_layouts, {"ok": True, **plan}


@router.post("/move-server", status_code=200)
async def move_server(body: dict, db: AsyncSession = Depends(get_db), _writer: None = Depends(_one_label_writer)):
    """Move a server to another server's location (swap, or take it over) or to empty ports, with its rack position.
    dry_run returns the same answer without writing, plus plan_revision; an Apply that sends it back is refused if
    anything changed since. Monitors and owners follow the server and are not touched.

    Order, so that a failure never leaves half a move behind: plan everything in memory; commit the port labels;
    then, holding the layout file locks with no await inside, write the changed layout files and put back the ones
    already written if any write fails; only after that (locks released) undo the labels in a second commit. No other
    layout writer can run between this move's file writes and their restore."""
    dry_run, expected_plan = body.get("dry_run", False), body.get("plan_revision")
    if not isinstance(dry_run, bool):
        raise HTTPException(400, "dry_run must be true or false")
    if expected_plan is not None and not isinstance(expected_plan, str):
        raise HTTPException(400, "plan_revision must be the token from the preview")
    devices, names = await _port_devices(db), await _monitor_names(db)
    saved, labels, unreadable = {}, {}, set()
    for dev in devices:
        saved[dev.id], readable = _saved_labels(dev)
        if not readable:
            unreadable.add(dev.id)
        # Names the PDU/KVM reports itself count as occupied ports and as the mover's own ports.
        labels[dev.id] = _effective_labels(dev, saved[dev.id])
    original = {dev.id: dev.labels_json for dev in devices}
    # Layout files are replaced atomically, so this read needs no lock; the write below checks them again locked.
    layouts, present = _read_layouts(strict=True)
    new_labels, new_layouts, result = _plan_move(body, devices, labels, unreadable, layouts, names)
    result = {"ok": True, "dry_run": dry_run, **{k: v for k, v in result.items() if k != "ok"}}
    if dry_run:
        return result
    if expected_plan is not None and expected_plan != result["plan_revision"]:
        raise HTTPException(409, "Changed since the preview. Preview again.")

    # 1. The port labels. Nothing else has been written yet, so a failed commit needs only a rollback.
    changed = {}
    for dev in devices:
        if new_labels[dev.id] != labels[dev.id]:
            written = _saved_after(saved[dev.id], labels[dev.id], new_labels[dev.id])
            dev.labels_json = json.dumps(written)
            changed[dev.id] = {p for p in set(saved[dev.id]) | set(written) if saved[dev.id].get(p) != written.get(p)}
    error, cancelled = await _finish_commit(db)
    if error is not None:
        log.error("Server move was not saved (%s); no layout file was written", type(error).__name__)
        await _rollback(db)
        if cancelled:
            raise asyncio.CancelledError()
        raise HTTPException(503, _MOVE_FAILED)

    # 2. The layout files, all-or-nothing (see _write_layouts).
    try:
        _write_layouts((body, devices, labels, unreadable, names), layouts, present, new_labels, new_layouts, result)
    except BaseException as failure:
        # 3. Put the labels back as well. The files are as they were before the move, unless restoring one of them
        # failed too (_LayoutNotRestored): then the answer says so. A write or lock error otherwise reaches here as
        # the file lock's generic 503 (locked_file turns an OSError into it).
        unrestored = failure.files if isinstance(failure, _LayoutNotRestored) else []
        refused = isinstance(failure, HTTPException) and failure.detail != inventory_store.LAYOUT_SAVE_FAILED
        if isinstance(failure, Exception) and not refused:
            cause = failure.__cause__ or failure.__context__ or failure
            log.error("Server move: a rack layout file could not be written (%s); undoing the move",
                      type(cause).__name__)
        reverted, cancelled_again = await _revert_labels(db, devices, original)
        if not isinstance(failure, Exception):
            raise failure  # KeyboardInterrupt, SystemExit, CancelledError: undone as far as possible, then passed on
        if unrestored:
            detail = _MOVE_NOT_RESTORED.format(files=", ".join(unrestored))
            if not reverted:
                detail += " The port labels could not be put back either."
            raise HTTPException(503, detail) from None
        if not reverted:
            raise HTTPException(503, _MOVE_HALF_SAVED) from None
        if cancelled or cancelled_again:
            raise asyncio.CancelledError() from None
        if refused:
            raise failure  # 409 layout changed, or 503 unreadable layout file: nothing was written
        raise HTTPException(503, _MOVE_FAILED) from None
    # Labels and layout files are both saved (also when only the caller went away): now the device names follow.
    result.update(await name_sync.queue(changed))
    if cancelled:
        raise asyncio.CancelledError()  # saved; only the caller went away
    return result


def _saved_after(saved: dict, before: dict, after: dict) -> dict:
    """The saved labels after a move: only ports whose shown label changed are written (a reported device name
    that the move leaves alone stays unsaved)."""
    result = dict(saved)
    for port in set(before) | set(after):
        if before.get(port) != after.get(port):
            if port in after:
                result[port] = after[port]
            else:
                result.pop(port, None)
    return result


async def _finish_commit(db):
    """Commit and wait for the outcome even if the request is cancelled meanwhile, so the layout files are kept
    exactly when the labels were saved. Returns (error or None, cancelled)."""
    commit = asyncio.ensure_future(db.commit())
    cancelled = False
    while not commit.done():
        try:
            await asyncio.shield(commit)
        except asyncio.CancelledError:
            if not commit.done():
                cancelled = True
        except Exception:
            pass
    if commit.cancelled():
        return asyncio.CancelledError(), cancelled
    return commit.exception(), cancelled


async def _rollback(db):
    try:
        await db.rollback()
    except BaseException:
        log.exception("Rollback after a failed server move did not finish")


async def _revert_labels(db, devices, original):
    """Second commit after the layout files could not be written: every port label as it was before the move.
    Returns (reverted, cancelled)."""
    for dev in devices:
        if dev.labels_json != original[dev.id]:
            dev.labels_json = original[dev.id]
    error, cancelled = await _finish_commit(db)
    if error is not None:
        log.error("Server move: the port labels could not be put back (%s)", type(error).__name__)
        await _rollback(db)
        return False, cancelled
    return True, cancelled


def _lock_layouts(stack):
    """The same per-file locks as the layout PUT endpoints, always taken in one order."""
    for fname in sorted(_LAYOUT_FILES):
        stack.enter_context(inventory_store.locked_file(_BACKEND_DIR / fname, inventory_store.LAYOUT_SAVE_FAILED))


def _write_layouts(plan_inputs, layouts, present, new_labels, new_layouts, result):
    """Write a move's layout changes under the layout file locks. The locks are synchronous (they also serialize
    uvicorn workers), so nothing here awaits: a layout save waiting on one of them only waits for this function.

    If another session saved a layout file since the plan was made, the move is planned again on the current files
    and goes ahead only when it changes exactly the same labels and positions (that other edit is kept); otherwise
    409 and nothing is written. Any failure while writing, including KeyboardInterrupt or cancellation, puts back
    every file already written before the locks are released, then propagates; if a file cannot be put back, an
    Exception becomes _LayoutNotRestored naming the files (a BaseException still propagates as it is)."""
    body, devices, labels, unreadable, names = plan_inputs
    with ExitStack() as locks:
        _lock_layouts(locks)
        current, current_present = _read_layouts(strict=True)
        if current != layouts or current_present != present:
            try:
                replanned_labels, new_layouts, replanned = _plan_move(body, devices, labels, unreadable, current, names)
            except HTTPException as exc:
                raise HTTPException(409, _LAYOUT_CHANGED) from exc
            if replanned_labels != new_labels or replanned["plan_revision"] != result["plan_revision"]:
                raise HTTPException(409, _LAYOUT_CHANGED)
            layouts, present = current, current_present
        written = []
        try:
            for fname in _LAYOUT_FILES:
                if new_layouts[fname] != layouts[fname]:
                    written.append(fname)
                    inventory_store.write_json(_BACKEND_DIR / fname, new_layouts[fname])
        except BaseException as exc:
            unrestored = _restore_layouts(written, layouts, present)
            if unrestored:
                if isinstance(exc, Exception):
                    raise _LayoutNotRestored(unrestored) from exc
                log.error("Server move interrupted; rack layout files not restored: %s", ", ".join(unrestored))
            raise


def _restore_layouts(written, layouts, present):
    """Still under the layout locks that covered the writes: put back each file the move wrote (a file it created is
    removed). Nobody else can have saved them in between. Returns the files that do not hold their content from
    before the move afterwards (a file whose own write failed and was left untouched counts as restored)."""
    failed = []
    for fname in written:
        path = _BACKEND_DIR / fname
        try:
            if fname in present:
                inventory_store.write_json(path, layouts[fname])
            else:
                path.unlink(missing_ok=True)
        except Exception as exc:
            if not _holds(path, layouts[fname] if fname in present else None):
                log.error("Could not restore %s after a failed server move (%s)", fname, type(exc).__name__)
                failed.append(fname)
    return failed


def _holds(path, expected):
    """True when the file holds exactly `expected` (None: the file does not exist)."""
    try:
        return json.loads(path.read_text(encoding="utf-8")) == expected
    except FileNotFoundError:
        return expected is None
    except (OSError, ValueError):
        return False


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
