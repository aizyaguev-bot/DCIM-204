"""Delete and restore for every lab item (v2 spec section D): the planner, the 3D link rule and the Deleted list.

One delete path. Servers, PDUs, KVMs, racks, units (rack items), cooling units and 3D-only records (lab-data.json items,
storage cabinets and setups) are deleted through POST /api/lab/delete (routers/lab_delete.py): a dry run returns the plan
(what is deleted, what else changes, what blocks it, where it disappears) with a plan_revision; the apply recomputes the
plan under the locks and is refused when anything changed. Every delete is one batch in deleted.json (next to the other
backend stores, devices._BACKEND_DIR), kept 90 days and restorable from there (POST /api/lab/restore). Nothing here
contacts a PDU or KVM: evidence comes from the status caches and the database only. Freed outlet and port names go to the
devices afterwards through device name sync, as a server move does.

What each kind does (the plan builds it on in-memory copies of every store, then writes them in one step):
  server   frees every outlet and KVM port that carries its name (the default name, as clear-server; option keep_labels
           keeps them), then the removed-servers core (routers/removed_servers.py apply_core: record, owner tombstones,
           monitor paused, incident and network alert closed); its rack layout, switch and owner entries are cleaned; its
           3D opt record and dcim seed entries go (twin_records); floor_units also deletes the units on its floor.
           A server removed earlier (Remove from lab) is deleted the same way and stays removed with its monitor paused:
           the names it still holds are freed and its 3D records go (Delete.delete_removed).
  device   a PDU or KVM row is deleted with its labels, name sync, monitor snapshot and error rows; its device-api and
           power alerts are closed; servers whose every port was on the deleted devices and that show no sign of life
           are removed (orphan_servers), the others are kept and listed; its 3D record and dcim seed entries go.
  rack     every device on it, every server drawn on it (without evidence), its layout entries, its units (to
           Storage-Main or deleted: rack_units), its cooling units (no rack), and its 3D frame (twin_frame).
  unit     taken out of rack_items with its owner; its 3D equip record goes; unit_server (Admin) also removes the
           server of a computer/server unit that is only pinged.
  cooling  taken out of chillers.json (a versioned write); its 3D chiller record goes.
  twin     a 3D-only record (item, storage cabinet, setup with no Lab Manager rack) and, per twin_contents, what is in it.
Alerts are closed with one "[DCIM closed]" email each (alerts.close_deleted), never a "[DCIM recovered]".

Restore puts a batch (or some of its entries) back: devices with their labels and encrypted credentials, removed servers
(their freed names go back where the port still holds the default name the delete wrote), units, cooling units, layout
entries of a rack, and 3D records. Each entry is refused with the reason when its id, name or address is taken again.

classify_twin is the Python copy of the 3D link rule (frontend/src/lab/twinRecords.js, lab-twin/classify.js); one
hand-written fixture, backend/tests/fixtures/twin_classify.json, pins all three.
"""
from __future__ import annotations

import copy
import json
import re
import time
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import delete as sql_delete, select

from . import inventory_store
from .models import (AlertCondition, AssetOwner, Device, DeviceNameSync, DeviceNameSyncLease, MonitorDeviceError,
                     MonitorDeviceSnapshot, PduMaintenance, PingTarget, PxeJob)
from .routers import devices, removed_servers

STORE_NAME = "deleted.json"
EMPTY = {"batches": []}
KEEP_SECONDS = 90 * 86400
MAX_TARGETS = 200
MAX_REASON = 300
MAX_ID = 400
KINDS = ("server", "device", "rack", "unit", "cooling", "twin")
ADMIN_KINDS = frozenset({"server", "device", "rack", "cooling"})
OPTIONS = {"orphan_servers": True, "twin_records": True, "keep_labels": False, "floor_units": False,
           "rack_units": "storage", "twin_frame": True, "twin_contents": True, "unit_server": True}
MAIN_STORAGE = "Storage-Main"
CHILLERS_EMPTY = {"units": [], "connections": []}
SERVER_UNIT_TYPES = ("computer", "server")
EVIDENCE_WATTS = 5
PING_DAY = 86400
UNIT_SEEN_DAYS = 30
STATUS_FRESH = 600      # a status cache entry younger than this answers "now"
SNAPSHOT_FRESH = 1800   # a monitor device snapshot checked within this answers "now"

ADMIN_ONLY = "Only an Admin can delete servers, PDUs, KVMs, racks and cooling units."
ADMIN_ONLY_RESTORE = "Only an Admin can restore servers, PDUs, KVMs, racks and cooling units."
ADMIN_ONLY_ALSO = "Only an Admin can restore it: it also brings back {}."
# What a batch entry's snapshot brings back that only an Admin may restore, whatever the entry's kind.
ADMIN_SNAPSHOT = ("servers", "devices", "freed", "paused", "cooling", "layout")
NOT_DELETABLE = "Not deletable: {} is part of the room (zones, walls, doors, benches and single shelves stay)."
PLAN_CHANGED = "The lab changed since the preview. Nothing was changed; preview again."
NEEDS_PREVIEW = "Preview first (dry_run), then send its plan_revision."
STALE = "The Deleted list was changed in another session. Reload and try again."
RELOAD = "Reload the Deleted list before restoring."
UNREADABLE = "The Deleted list cannot be read, so nothing was changed."
TWIN_UNREADABLE = "The 3D data (lab-data.json) cannot be read, so nothing was changed."
NOT_SAVED = "The change could not be saved. Nothing was changed; please retry."
NO_BATCH = "This delete is not in the Deleted list any more (kept 90 days). Reload the list."

CONSEQUENCES = ("devices_deleted", "servers_deleted", "servers_kept", "servers_lose_port", "ports_freed", "units_moved", "units_deleted",
                "cooling_unassigned", "monitors_paused", "alerts_closed", "twin_deleted", "twin_unplaced",
                "setups_unmapped", "layout", "owners", "shared_kept", "notes")
RESTORE_CONSEQUENCES = ("devices_restored", "servers_restored", "ports_restored", "ports_not_restored",
                        "units_restored", "units_to_storage", "cooling_restored", "monitors_resumed", "twin_restored",
                        "layout", "owners", "notes")
SCREENS = {
    "server": ("Racks", "Manage", "Dashboard / Power", "Lab display (TV)", "3D twin", "Ping Monitor"),
    "device": ("Dashboard / Power", "Racks", "Manage", "Lab display (TV)", "3D twin"),
    "rack": ("Racks", "Manage", "Dashboard / Power", "Lab display (TV)", "3D twin"),
    "unit": ("Racks", "Manage", "3D twin"),
    "cooling": ("Racks", "Manage", "3D twin"),
    "twin": ("3D twin", "Manage"),
}
SCREEN_ORDER = ("Racks", "Manage", "Dashboard / Power", "Lab display (TV)", "3D twin", "Ping Monitor")


# ── the Deleted list (deleted.json) ─────────────────────────────────────────────────────────────────────────────────
def store_path():
    # Read at call time: tests (and the browser fixture) point devices._BACKEND_DIR at a temporary folder.
    return devices._BACKEND_DIR / STORE_NAME


def read_store(strict=False) -> dict:
    """The Deleted list {"batches": [...]}. Missing is empty; an unreadable file is empty for reading but stops every
    write (503), so it is never overwritten."""
    try:
        data = json.loads(store_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"batches": []}
    except (OSError, ValueError) as exc:
        if strict:
            raise HTTPException(503, UNREADABLE) from exc
        return {"batches": []}
    if not isinstance(data, dict) or not isinstance(data.get("batches"), list):
        if strict:
            raise HTTPException(503, UNREADABLE)
        return {"batches": []}
    data["batches"] = [b for b in data["batches"] if isinstance(b, dict) and isinstance(b.get("id"), str)]
    return data


def store_revision() -> str:
    return inventory_store.revision(inventory_store.read_layout(store_path(), EMPTY))


def purged(store, now) -> dict:
    """The store without batches older than 90 days (a purge runs with every write of the list)."""
    keep = [b for b in store.get("batches") or [] if isinstance(b.get("at"), (int, float)) and now - b["at"] < KEEP_SECONDS]
    return {**store, "batches": keep}


def find_batch(store, batch_id):
    return next((b for b in store.get("batches") or [] if b.get("id") == batch_id), None)


def admin_only(entry) -> str:
    """"" when an Operator may restore this batch entry; otherwise why not. Servers, PDUs, KVMs, racks and cooling units
    are Admin kinds, and an entry of another kind needs an Admin too when its snapshot brings back what an Admin deleted
    with it (a computer unit's only-pinged server)."""
    if entry.get("kind") in ADMIN_KINDS:
        return ADMIN_ONLY_RESTORE
    snapshot = entry.get("snapshot") or {}
    if any(snapshot.get(field) for field in ADMIN_SNAPSHOT):
        servers = [str(k).upper() for k in snapshot.get("servers") or []]
        return ADMIN_ONLY_ALSO.format("server " + ", ".join(servers) if servers else "what was deleted with it")
    return ""


# ── the 3D link rule (v2 spec section M.5; the same rule as frontend/src/lab/twinRecords.js) ─────────────────────────
_RACK_FLOORS = 4


def _as_list(value):
    return value if isinstance(value, list) else []


def norm_name(value) -> str:
    """trimmed, lower-case, spaces collapsed (JavaScript's normName)."""
    return re.sub(r"\s+", " ", _js_text(value).strip().lower())


def _js_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _js_template(record, field) -> str:
    """`${record.field}` in JavaScript: a missing field reads "undefined", null "null"."""
    if not isinstance(record, dict) or field not in record:
        return "undefined"
    value = record[field]
    return "null" if value is None else _js_text(value)


def js_identity(label):
    """frontend serverIdentity: the server a label names, lower-cased; None for blank and default port names."""
    name = _js_text(label).strip()
    if not name or re.fullmatch(r"(?:outlet|port)\s*[0-9]+", name, re.I):
        return None
    match = re.fullmatch(r"(optn?[0-9]+)(?:\s*\([^)]*\))?", name, re.I)
    return (match[1] if match else name).lower()


def _js_number(value):
    """Number(value) for a U, as an int when it is a whole number (else None)."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"\s*[+-]?[0-9]+(\.0*)?\s*", value):
        return int(float(value))
    return None


def _shelf_for_u(twin, setup_id, u):
    if not isinstance(u, int) or u < 1:
        return None
    shelves = [s for s in _as_list((twin or {}).get("shelves")) if isinstance(s, dict) and s.get("setup") == setup_id]
    shelves.sort(key=lambda s: s.get("level") if isinstance(s.get("level"), (int, float)) else 0)
    n = max(_RACK_FLOORS, len(shelves))
    if u > n:
        return None
    dcim = (twin or {}).get("dcim") if isinstance((twin or {}).get("dcim"), dict) else {}
    top_down = (dcim.get("uNumbering") or "top-down") == "top-down"
    missing = n - len(shelves)
    every = [None] * missing + shelves if top_down else shelves + [None] * missing
    hit = every[n - u if top_down else u - 1]
    return (hit or {}).get("id") or None


def classify_twin(twin, live) -> dict:
    """{"linked": {twin id: Lab Manager uid}, "only": [{id, type, name, reason}]} (twinRecords.js classifyTwinJson).
    live: {servers: [{key}], devices: [{id, kind, name}], rackItems: {rack: [unit]}, chillers: [{id, rack}], racks}."""
    twin = twin if isinstance(twin, dict) else {}
    live = live if isinstance(live, dict) else {}
    linked, only = {}, []
    items = _as_list(twin.get("items"))
    setups = _as_list(twin.get("setups"))
    server_keys = {s.get("key") for s in _as_list(live.get("servers")) if isinstance(s, dict) and s.get("key")}
    devices_ = [d for d in _as_list(live.get("devices")) if isinstance(d, dict)]
    rack_items = live.get("rackItems") if isinstance(live.get("rackItems"), dict) else {}
    units = [{**u, "rack": rack} for rack, lst in rack_items.items() for u in _as_list(lst) if isinstance(u, dict)]
    racks = {str(r) for r in _as_list(live.get("racks"))}
    setup_rack = {s.get("id"): (s["dcimRack"] if isinstance(s.get("dcimRack"), str) and s["dcimRack"] else None)
                  for s in setups if isinstance(s, dict)}
    setup_of_rack = {}
    for s in setups:
        if isinstance(s, dict) and setup_rack.get(s.get("id")):
            setup_of_rack[setup_rack[s.get("id")]] = s.get("id")

    def skip(record, kind, reason):
        only.append({"id": record.get("id"), "type": kind, "name": _js_text(record.get("name")), "reason": reason})

    by_id = set()
    for item in items:
        if not isinstance(item, dict) or item.get("type") not in ("pdu", "kvm"):
            continue
        dcim = item.get("dcim") if isinstance(item.get("dcim"), dict) else {}
        device_id = dcim.get("deviceId")
        if device_id and any(d.get("kind") == item["type"] and d.get("id") == device_id for d in devices_):
            linked[item.get("id")] = f"dev:{device_id}"
            by_id.add(device_id)
    chillers = [i for i in items if isinstance(i, dict) and i.get("type") == "chiller"]
    for unit in _as_list(live.get("chillers")):
        if not isinstance(unit, dict):
            continue
        setup = setup_of_rack.get(unit.get("rack")) if unit.get("rack") else None
        hit = next((c for c in chillers if setup and c.get("setup") == setup and c.get("id") not in linked), None)
        if hit:
            linked[hit.get("id")] = f"cooling:{unit.get('id')}"

    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or item["id"] in linked:
            continue
        kind = _js_text(item.get("type"))
        dcim = item.get("dcim") if isinstance(item.get("dcim"), dict) else {}
        if kind == "opt":
            opt_key = dcim["optKey"].strip().lower() if isinstance(dcim.get("optKey"), str) else ""
            candidates = [k for k in (opt_key, js_identity(opt_key), js_identity(item.get("name"))) if k]
            key = next((k for k in candidates if k in server_keys), None)
            if key:
                linked[item["id"]] = f"server:{key}"
            else:
                skip(item, kind, f"No server named {_js_template(item, 'name')} in Lab Manager")
        elif kind in ("pdu", "kvm"):
            same = [d for d in devices_ if d.get("kind") == kind and norm_name(d.get("name")) == norm_name(item.get("name"))]
            if len(same) == 1 and same[0].get("id") not in by_id:
                linked[item["id"]] = f"dev:{same[0].get('id')}"
            else:
                noun = "PDU" if kind == "pdu" else "KVM"
                device_id = dcim.get("deviceId")
                skip(item, kind, f"No {noun} with id {_js_text(device_id)} or name {_js_template(item, 'name')} in Lab Manager"
                     if device_id else f"No {noun} named {_js_template(item, 'name')} in Lab Manager")
        elif kind.startswith("equip-"):
            same = [u for u in units if norm_name(u.get("name")) == norm_name(item.get("name"))]
            if len(same) == 1:
                linked[item["id"]] = f"unit:{same[0].get('id')}"
            elif item.get("shelf") and any(u["rack"] in setup_of_rack and
                                           _shelf_for_u(twin, setup_of_rack[u["rack"]], _js_number(u.get("u"))) == item["shelf"]
                                           for u in units):
                skip(item, kind, "Hidden in 3D: a Lab Manager unit is on its shelf")
            else:
                skip(item, kind, f"No unit named {_js_template(item, 'name')} in Lab Manager")
        elif kind == "chiller":
            skip(item, kind, f"No cooling unit on {setup_rack.get(item.get('setup')) or 'this rack'} in Lab Manager")
        else:
            skip(item, kind, "3D only")
    for storage in _as_list(twin.get("storage")):
        if isinstance(storage, dict) and storage.get("id"):
            skip(storage, "storage", "3D only")
    for setup in setups:
        if not isinstance(setup, dict) or not setup.get("id"):
            continue
        rack = setup_rack.get(setup["id"])
        if rack and rack in racks:
            linked[setup["id"]] = f"rack:{rack}"
        else:
            skip(setup, "setup", "Not mapped to a Lab Manager rack")
    return {"linked": linked, "only": only}


# ── reading the lab (once per plan; never a device) ─────────────────────────────────────────────────────────────────
def _twin_files():
    from . import main   # lazy: main imports the routers (and so this module); the fixture patches these paths
    return main._TWIN_DATA_FILE, main._CHILLERS_FILE


def _raw(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def _read_twin(path):
    """lab-data.json, strictly: missing is {}; a file that exists but cannot be parsed stops the change (503)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise HTTPException(503, TWIN_UNREADABLE) from exc
    if not isinstance(data, dict):
        raise HTTPException(503, TWIN_UNREADABLE)
    return data


def _iso_age(value, now):
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return now - stamp.timestamp()


def _port_word(kind):
    return "outlet" if kind == "pdu" else "port"


def _place_text(rack, u):
    return f"{rack} · floor {u}" if rack and isinstance(u, int) and u > 0 else (rack or "no rack")


class Lab:
    """What a delete or restore reads, loaded once, plus the in-memory copies it changes."""

    async def load(self, db):
        self.now = time.time()
        rows = (await db.execute(select(Device).execution_options(populate_existing=True))).scalars().all()
        self.devs = {d.id: d for d in rows}
        self.port_devs = sorted((d for d in rows if d.kind in devices._PORT_KINDS), key=devices._device_order)
        self.observed = await devices._observed_labels(db, self.port_devs)
        self.saved0, self.readable = {}, {}
        for dev in self.port_devs:
            self.saved0[dev.id], self.readable[dev.id] = devices._saved_labels(dev)
        self.saved = copy.deepcopy(self.saved0)
        self.live = {d.id: devices._live_labels(d) for d in self.port_devs}
        self.shown0 = {d.id: devices._effective_labels(d, self.saved0[d.id], self.observed) for d in self.port_devs}
        self.layouts0, _ = devices._read_layouts(strict=True)
        self.layouts = copy.deepcopy(self.layouts0)
        self.items0 = inventory_store.read_items()
        self.items = copy.deepcopy(self.items0)
        self.twin_path, self.chillers_path = _twin_files()
        self.twin0 = _read_twin(self.twin_path)
        self.twin = copy.deepcopy(self.twin0)
        self.chillers0, self.chillers_existed = inventory_store._read_store(self.chillers_path, CHILLERS_EMPTY)
        if not isinstance(self.chillers0, dict):
            raise HTTPException(503, inventory_store.STORE_UNREADABLE)
        self.chillers = copy.deepcopy(self.chillers0)
        self.removed0 = removed_servers.read_store(strict=True)
        self.removed = copy.deepcopy(self.removed0)
        self.store0 = read_store(strict=True)
        # the revision of every file as save_layouts_with_items compares it, and the bytes a failed commit puts back
        self.rev0 = {"removed": inventory_store.revision(inventory_store.read_layout(removed_servers.store_path(), removed_servers.EMPTY)),
                     "deleted": store_revision(),
                     "twin": inventory_store.revision(inventory_store.read_layout(self.twin_path, {})),
                     "chillers": inventory_store.revision(inventory_store.read_layout(self.chillers_path, CHILLERS_EMPTY)),
                     **{f: inventory_store.revision(inventory_store.read_layout(devices._BACKEND_DIR / f, {}))
                        for f in devices._LAYOUT_FILES}}
        self.raw0 = {"removed": _raw(removed_servers.store_path()), "deleted": _raw(store_path()),
                     "twin": _raw(self.twin_path), "chillers": _raw(self.chillers_path),
                     "chillers_history": _raw(inventory_store.history_path(self.chillers_path)),
                     "items": _raw(inventory_store.ITEMS_FILE),
                     **{f: _raw(devices._BACKEND_DIR / f) for f in devices._LAYOUT_FILES}}
        targets = (await db.execute(select(PingTarget).execution_options(populate_existing=True))).scalars().all()
        self.monitors = {t.source_key[len("server:"):]: t for t in targets if t.source_key.startswith("server:")}
        self.monitor_names = await devices._monitor_names(db)
        self.servers = devices._all_servers(self.port_devs, self.shown0, self.layouts0, self.monitor_names)
        self.layout_index = devices._layout_ids(self.layouts0)
        self.ports_now = await removed_servers.current_ports(db)
        self.hidden = {r["key"] for r in removed_servers._records(self.removed0) if removed_servers.is_hiding(r, self.ports_now)}
        from .engineers import owner_map
        self.owners = await owner_map(db)
        self.owner_rows = {a.asset_key: a for a in (await db.execute(select(AssetOwner))).scalars().all()}
        self.jobs = (await db.execute(select(PxeJob).where(PxeJob.active_key.is_not(None)))).scalars().all()
        self.maintenance = set((await db.execute(select(PduMaintenance.device_id))).scalars().all())
        self.snapshots = {s.device_id: s for s in (await db.execute(select(MonitorDeviceSnapshot))).scalars().all()}
        self.down_since = {c.key[len("device-api:"):]: c.started_at for c in
                           (await db.execute(select(AlertCondition).where(AlertCondition.key.startswith("device-api:")))).scalars().all()
                           if c.started_at is not None}
        self.lab_racks = ({d.rack for d in rows if isinstance(d.rack, str) and d.rack.strip()}
                          | {r for r in self.items0 if isinstance(r, str) and r.strip()} | {MAIN_STORAGE})
        live = {"servers": [{"key": k} for k in self.servers], "devices": [{"id": d.id, "kind": d.kind, "name": d.name} for d in rows],
                "rackItems": self.items0, "chillers": _as_list(self.chillers0.get("units")),
                "racks": sorted({d.rack for d in rows if d.rack} | set(self.items0))}
        self.links = classify_twin(self.twin0, live)
        self.twin_of = {}
        for twin_id, uid in self.links["linked"].items():
            self.twin_of.setdefault(uid, []).append(twin_id)
        return self

    # ── reading helpers ──
    def unit_of(self, unit_id, items=None):
        for rack, lst in (self.items if items is None else items).items():
            for index, unit in enumerate(lst):
                if isinstance(unit, dict) and unit.get("id") == unit_id:
                    return rack, index, unit
        return None

    def chiller_of(self, unit_id, doc=None):
        for index, unit in enumerate(_as_list((self.chillers if doc is None else doc).get("units"))):
            if isinstance(unit, dict) and unit.get("id") == unit_id:
                return index, unit
        return None

    def twin_record(self, rid, doc=None):
        doc = self.twin if doc is None else doc
        for name in ("items", "storage", "setups"):
            for index, record in enumerate(_as_list(doc.get(name))):
                if isinstance(record, dict) and record.get("id") == rid:
                    return name, index, record
        return None

    def room_ids(self):
        """Ids in lab-data.json that are part of the room, never deleted: zones, benches, shelves and structure."""
        ids = set()
        for name in ("zones", "benches", "shelves"):
            ids |= {r.get("id") for r in _as_list(self.twin.get(name)) if isinstance(r, dict)}
        structure = self.twin.get("structure") if isinstance(self.twin.get("structure"), dict) else {}
        for lst in structure.values():
            ids |= {r.get("id") for r in _as_list(lst) if isinstance(r, dict)}
        return ids - {None}

    def outlets(self, dev):
        """{port number as text: (state, watts)} from the status cache, else the latest monitor snapshot."""
        from .routers import pdus
        cached = pdus._cache.get(dev.id)
        if cached and getattr(cached[1], "outlets", None):
            return {str(o.number): (o.state, o.watts) for o in cached[1].outlets}
        snap = self.snapshots.get(dev.id)
        if snap is None or (snap.kind, snap.ip) != (dev.kind, dev.ip):
            return {}
        try:
            ports = json.loads(snap.ports_json or "[]")
        except ValueError:
            return {}
        return {str(p.get("number")): (p.get("state"), p.get("watts")) for p in _as_list(ports) if isinstance(p, dict)}

    def answers(self, dev):
        from .routers import kvms, pdus
        cached = (pdus._cache if dev.kind == "pdu" else kvms._cache).get(dev.id)
        if cached and time.monotonic() - cached[0] < STATUS_FRESH and getattr(cached[1], "reachable", False):
            return True
        snap = self.snapshots.get(dev.id)
        return bool(snap is not None and (snap.kind, snap.ip) == (dev.kind, dev.ip) and snap.reachable
                    and self.now - (snap.checked_at or 0) < SNAPSHOT_FRESH)

    @staticmethod
    def in_use(dev_id, port):
        from .routers import kvms
        leases = kvms._in_use.get(dev_id, {}).get(int(port)) if str(port).isdigit() else None
        return bool(leases) and any(time.monotonic() < exp for exp in leases.values())

    def server_evidence(self, key):
        out = []
        target = self.monitors.get(key)
        if target is not None and ((target.last_up_at and self.now - target.last_up_at < PING_DAY) or
                                   (target.status == "up" and target.checked_at and self.now - target.checked_at < PING_DAY)):
            out.append("Answered ping in the last 24 hours")
        for dev, port, _ in (self.servers.get(key) or {}).get("ports", []):
            if dev.kind == "pdu":
                state, watts = self.outlets(dev).get(devices._number_key(port), (None, None))
                if state == "on" and isinstance(watts, (int, float)) and watts > EVIDENCE_WATTS:
                    out.append(f"{dev.name} · outlet {port} is on, drawing {round(watts)} W")
            elif dev.kind == "kvm" and self.in_use(dev.id, port):
                out.append(f"{dev.name} · port {port} is IN USE")
        return out

    def device_evidence(self, dev):
        evidence, info = [], []
        if dev.kind in devices._PORT_KINDS and self.answers(dev):
            evidence.append("Answers now")
        if dev.kind == "pdu":
            keys, watts = set(), 0.0
            for port, (state, value) in self.outlets(dev).items():
                if state == "on" and isinstance(value, (int, float)) and value > EVIDENCE_WATTS:
                    watts += value
                    key = devices._key_of(self.shown0.get(dev.id, {}).get(port))
                    if key:
                        keys.add(key)
            if watts:
                kw = f"{watts / 1000:.1f} kW"
                evidence.append(f"Feeds {len(keys)} server{'s' if len(keys) != 1 else ''} drawing {kw}" if keys
                                else f"Outlets drawing {kw}")
        if dev.kind == "kvm":
            from .routers import kvms
            busy = sorted(p for p in kvms._in_use.get(dev.id, {}) if self.in_use(dev.id, p))
            if busy:
                evidence.append(f"{len(busy)} port{'s' if len(busy) != 1 else ''} IN USE")
        if dev.kind in devices._PORT_KINDS and not self.answers(dev):
            since = self.down_since.get(dev.id)
            info.append(f"Unreachable since {removed_local(since)}" if since else "Not answering now")
        return evidence, info

    def unit_evidence(self, unit):
        age = _iso_age(unit.get("last_seen_at"), self.now) if unit.get("last_seen_at") else None
        if age is not None and age < UNIT_SEEN_DAYS * 86400:
            return [f"Seen by a scan {max(0, int(age // 86400))} days ago"]
        return []

    def owner_keys(self, key):
        return sorted(k for k in self.owners if not k.startswith("item:") and devices._key_of(k) == key)

    def server_name(self, key):
        server = self.servers.get(key)
        if server:
            return server["name"]
        target = self.monitors.get(key)
        if target is not None:
            return target.name
        record = self.removed0["servers"].get(key)
        return str(record.get("name") or key) if isinstance(record, dict) else key

    def uid_name(self, uid):
        kind, _, ident = uid.partition(":")
        if kind == "dev":
            return getattr(self.devs.get(ident), "name", ident)
        if kind == "server":
            return self.server_name(ident)
        if kind == "unit":
            found = self.unit_of(ident, self.items0)
            return str(found[2].get("name") or ident) if found else ident
        if kind == "cooling":
            found = self.chiller_of(ident, self.chillers0)
            return str(found[1].get("name") or ident) if found else ident
        return ident


def removed_local(stamp):
    from .alerts import local_time
    try:
        return local_time(stamp)
    except Exception:  # noqa: BLE001 - informational text only
        return "earlier"


def _jobs_text(job):
    return job.computer_name or job.computer_key or "a server"


# ── the delete plan ─────────────────────────────────────────────────────────────────────────────────────────────────
class Delete(Lab):
    def __init__(self, targets, options, admin, who="", reason=""):
        self.raw_targets = targets
        self.options = {**OPTIONS, **{k: v for k, v in (options or {}).items() if k in OPTIONS}}
        self.admin = admin
        self.who = who
        self.reason = reason
        self.items_out, self.entries, self.blockers = [], [], []
        self.c = {name: {} for name in CONSEQUENCES}
        self.gone = {}               # device id -> snapshot of the row
        self.removing = {}           # server key -> what apply_core needs
        self.freed = []              # [(device id, port)]
        self.deleted_units = set()
        self.moved_units = set()
        self.deleted_racks = []
        self.rack_servers = {}       # server key -> the deleted rack it is drawn on
        self.alert_keys = set()
        self.unit_owners = {}        # asset key -> (engineer_id, legacy_name) before the delete
        self.cur = None              # the batch entry effects are recorded under
        self.screens = set()
        self.pausing = {}            # server key -> the running monitor of an already removed server, paused by the delete
        self.idle_removed = {}       # server key -> (name, monitor, names kept) of a removed server with nothing to delete

    # ── recording ──
    def note(self, group, ident, /, **fields):
        self.c[group].setdefault(ident, fields)

    def block(self, kind, ident, code, text):
        if not any(b["code"] == code and b["id"] == ident for b in self.blockers):
            self.blockers.append({"kind": kind, "id": ident, "code": code, "text": text})

    def snap(self, field, value):
        """Record what an effect removed under the current batch entry; `seq` orders the undo across entries."""
        if self.cur is not None:
            self.seq = getattr(self, "seq", 0) + 1
            if isinstance(value, dict):
                value = {**value, "seq": self.seq}
            self.cur["snapshot"].setdefault(field, []).append(value)

    # ── targets ──
    def normalize(self):
        if not isinstance(self.raw_targets, list) or not self.raw_targets:
            raise HTTPException(400, "Choose what to delete (targets).")
        if len(self.raw_targets) > MAX_TARGETS:
            raise HTTPException(400, f"At most {MAX_TARGETS} items can be deleted at once.")
        seen, out = set(), []
        for target in self.raw_targets:
            if not isinstance(target, dict) or target.get("kind") not in KINDS:
                raise HTTPException(400, "Each target needs a kind (server, device, rack, unit, cooling or twin) and an id.")
            ident = target.get("id")
            if not isinstance(ident, str) or not ident.strip() or len(ident) > MAX_ID:
                raise HTTPException(400, "Each target needs an id.")
            ident = ident.strip()
            kind = target["kind"]
            if kind == "server":
                ident = devices._key_of(ident) or ident
            if (kind, ident) not in seen:
                seen.add((kind, ident))
                out.append((kind, ident))
        return out

    async def build(self, db):
        await self.load(db)
        targets = self.normalize()
        racks = {ident for kind, ident in targets if kind == "rack"}
        merged = []
        for kind, ident in targets:
            if kind == "unit":
                found = self.unit_of(ident)
                if found and found[0] in racks:
                    merged.append((kind, ident, found[0]))
                    continue
            if kind == "device" and ident in self.devs and self.devs[ident].rack in racks:
                merged.append((kind, ident, self.devs[ident].rack))
                continue
            if kind == "cooling":
                found = self.chiller_of(ident)
                if found and found[1].get("rack") in racks:
                    merged.append((kind, ident, found[1].get("rack")))
                    continue
            self.entries.append({"kind": kind, "id": ident, "name": ident, "snapshot": {}, "restored_at": None})
        for kind, ident, rack in merged:
            self.note("notes", f"merged:{kind}:{ident}", text=f"{ident} goes with rack {rack}")
        order = {k: i for i, k in enumerate(("rack", "device", "server", "unit", "cooling", "twin"))}
        for entry in sorted(self.entries, key=lambda e: order[e["kind"]]):
            self.cur = entry
            self.screens.update(SCREENS[entry["kind"]])
            await getattr(self, "_" + entry["kind"])(db, entry)
        self.cur = None
        self._orphans()
        self._pins()
        self._goes()
        return self

    def _item(self, entry, name, evidence=(), info=()):
        entry["name"] = name
        self.items_out.append({"kind": entry["kind"], "id": entry["id"], "name": name, "evidence": list(evidence),
                               "info": list(info)})

    # ── server ──
    async def _server(self, db, entry):
        key = entry["id"]
        if not devices._identity(key) or not devices._key_of(key):
            self._item(entry, key)
            self.block("server", key, "not-server", f"{key} is not a server name.")
            return
        known = key in self.servers or key in self.monitors or self.owner_keys(key) or key in self.hidden
        name = self.server_name(key)
        self._item(entry, name, self.server_evidence(key))
        if not known:
            self.block("server", key, "missing", f"No server named {name} is in the lab.")
            return
        if key in self.hidden:
            self.delete_removed(key, entry)
            return
        self.remove_server(key, free=not self.options["keep_labels"], why="")
        if self.options["floor_units"]:
            position = self.removing.get(key, {}).get("plan", {}).get("position") or {}
            rack, slot = position.get("rack"), position.get("slot")
            for unit in list(self.items.get(rack) or []) if rack and slot else []:
                if devices._slot_value(unit.get("u")) == slot:
                    self.delete_unit(unit["id"], why=f"on {name}'s floor")
        elif key in self.servers:
            position = devices._position(self.servers[key], self.layout_index.get(key, set()), self.layouts0)
            rack, slot = position.get("rack"), position.get("slot")
            units = [u for u in (self.items0.get(rack) or []) if slot and devices._slot_value(u.get("u")) == slot]
            if units:
                self.note("notes", f"floor:{key}", count=len(units), text=f"{len(units)} unit{'s' if len(units) != 1 else ''} on its floor "
                                                        f"stay{'s' if len(units) == 1 else ''} in {rack}")

    def remove_server(self, key, free=True, why=""):
        """The server rule (v2 spec D.3): free its ports (unless keep_labels), then the removed-servers core."""
        if key in self.removing or key in self.hidden:
            return
        for job in self.jobs:
            if job.active_key == key:
                self.block("server", key, "pxe", f"Remote install is running on {self.server_name(key)}; finish or cancel it first.")
        server = self.servers.get(key) or {"name": self.server_name(key), "ports": []}
        name = server["name"]
        ports = []
        for dev in self.port_devs:
            labels = {**self.live[dev.id], **self.saved0[dev.id]}
            for port in sorted(labels, key=devices._port_order):
                if devices._key_of(labels[port]) == key:
                    ports.append({"device_id": dev.id, "device_name": dev.name, "kind": dev.kind, "port": str(port),
                                  "label": labels[port]})
        ids = self.layout_index.get(key, set())
        position = devices._position(server, ids, self.layouts0) if key in self.servers else {"rack": None, "slot": None}
        layout = []
        for fname in devices._LAYOUT_FILES:
            before = self.layouts[fname]
            after = removed_servers._without_ids(fname, before, ids)
            if after != before:
                self.layouts[fname] = after
                layout.append({"file": fname, "id": ", ".join(sorted(ids))})
                self.note("layout", f"{fname}:{key}", file=fname, text=f"{name}: {devices._LAYOUT_NAMES[fname]} entry removed")
        owner_keys = self.owner_keys(key)
        owner = {"keys": owner_keys, "name": self.owners[owner_keys[0]]} if owner_keys else None
        if owner:
            names = list(dict.fromkeys(str(self.owners[k]) for k in owner_keys if self.owners.get(k)))
            self.note("owners", key, key=key, name=owner["name"],
                      text=f"{name}: owner{'s' if len(names) > 1 else ''} {' and '.join(names) or owner['name']} removed")
        target = self.monitors.get(key)
        if target is not None and target.enabled:
            self.note("monitors_paused", key, key=key, name=name, text=f"{name}: ping monitor paused (history kept)")
            self.screens.add("Ping Monitor")
        if target is not None:
            self.alert_keys.add("network:" + target.id)
        existing = self.removed0["servers"].get(key)
        plan = {"key": key, "name": name, "ports": ports, "ports_ids": sorted(self.ports_now.get(key, set())),
                "position": position, "layout": layout, "pins": [], "owner": owner}
        self.removing[key] = {"plan": plan, "target": target, "existing": existing if isinstance(existing, dict) else None,
                              "entry": self.cur}
        if why:
            self.note("servers_deleted", key, key=key, name=name, text=f"{name} ({why})")
        self.snap("servers", key)
        if free:
            self.free_ports(key)
        self._twin_linked(f"server:{key}", name)

    def free_ports(self, key) -> int:
        """Every outlet and KVM port (of a device that stays) whose shown name is this server gets its default name, as
        clear-server writes it; the delete's snapshot keeps the name and the default it wrote (Restore writes the name
        back only where that default is still there). Returns how many ports it frees."""
        count = 0
        for dev in self.port_devs:
            if dev.id in self.gone:
                continue
            for port, label in sorted(self.shown0[dev.id].items(), key=lambda p: devices._port_order(p[0])):
                if devices._key_of(label) != key:
                    continue
                if not self.readable[dev.id]:
                    self.block("server", key, "labels", f"The saved port labels of {dev.name} cannot be read, so its "
                                                        "names cannot be freed.")
                    continue
                devices._clear_port(self.saved[dev.id], dev, str(port))
                after = self.saved[dev.id].get(str(port))
                self.freed.append((dev.id, str(port)))
                self.snap("freed", {"device_id": dev.id, "device_name": dev.name, "kind": dev.kind, "port": str(port),
                                    "label": label, "expected": after})
                self.note("ports_freed", f"{dev.id}:{port}", device_id=dev.id, port=str(port),
                          text=f"{dev.name} · {_port_word(dev.kind)} {port}: {label} → {after or 'no name'}")
                count += 1
        return count

    def delete_removed(self, key, entry):
        """A server removed from the lab earlier (today's Remove from lab, or a delete that kept its names) is deleted
        like any other server, except that it already is removed: it stays removed (its removal record is kept as it
        is) and its monitor stays paused. What still names it goes: the outlet and KVM port names it still holds are
        freed (the default name, queued to the devices; keep_labels keeps them), its 3D records and their dcim seed
        entries are deleted (twin_records), a monitor that was switched on again is paused, and its network alert is
        closed. Restore of the batch puts those back, and the server stays removed, as it was before this delete.
        Nothing left to delete (no name on a port, no 3D record, no running monitor, no open alert) is a blocker."""
        name = self.server_name(key)
        for job in self.jobs:
            if job.active_key == key:
                self.block("server", key, "pxe", f"Remote install is running on {name}; finish or cancel it first.")
        entry["snapshot"]["kept_removed"] = True
        before = len(self.c["ports_freed"]) + len(self.c["twin_deleted"])
        if not self.options["keep_labels"]:
            self.free_ports(key)
        self._twin_linked(f"server:{key}", name)
        busy = len(self.c["ports_freed"]) + len(self.c["twin_deleted"]) > before
        target = self.monitors.get(key)
        if target is not None:
            self.alert_keys.add("network:" + target.id)
            if target.enabled:
                self.pausing[key] = target
                self.snap("paused", {"id": target.id, "key": key})
                self.note("monitors_paused", key, key=key, name=name, text=f"{name}: ping monitor paused (history kept)")
                self.screens.add("Ping Monitor")
                busy = True
        if not busy:   # titles() decides once it knows whether an open alert closes
            held = any(devices._key_of(label) == key for dev in self.port_devs if dev.id not in self.gone
                       for label in self.shown0[dev.id].values())
            self.idle_removed[key] = (name, target, held)
        self.note("notes", f"removed:{key}", text=f"{name} was removed from the lab before; it stays removed and its "
                                                    "monitor stays paused")

    # ── device ──
    async def _device(self, db, entry):
        dev = self.devs.get(entry["id"])
        if dev is None:
            self._item(entry, entry["id"])
            self.block("device", entry["id"], "missing", f"No PDU or KVM with id {entry['id']} is in the lab.")
            return
        evidence, info = self.device_evidence(dev)
        self._item(entry, dev.name, evidence, info)
        if dev.kind == "rack":
            self.block("device", dev.id, "rack-row", f"{dev.name} is a rack: delete the rack {dev.rack or ''} instead "
                                                     "(its rack window).".replace("  ", " "))
            return
        self.delete_device(dev)

    def delete_device(self, dev):
        if dev.id in self.gone:
            return
        self.gone[dev.id] = {c: getattr(dev, c) for c in ("id", "name", "kind", "model", "ip", "rack", "port_count",
                                                            "username_enc", "password_enc", "labels_json", "enabled", "notes")}
        self.snap("devices", self.gone[dev.id])
        if dev.kind == "pdu":
            if dev.id in self.maintenance:
                self.block("device", dev.id, "maintenance", f"{dev.name} is in maintenance mode; restore it first.")
            outlets, _ = devices._protected_names(dev)
            if outlets or any(entry.split(":")[0].strip() in (dev.id, dev.name) for entry in self._protection_entries()):
                self.block("device", dev.id, "protected",
                           f"Remove {dev.name} from POWER_PROTECTED_OUTLETS in the server settings first; deleting it "
                           "would make the list invalid and block every Off and Cycle.")
            for job in self.jobs:
                try:
                    targets = json.loads(job.pdu_targets_json or "[]")
                except ValueError:
                    targets = []
                if any(isinstance(t, dict) and t.get("device_id") == dev.id for t in _as_list(targets)):
                    self.block("device", dev.id, "pxe", f"Remote install is running on {_jobs_text(job)} with {dev.name}; "
                                                        "finish or cancel it first.")
        if dev.kind == "kvm":
            for job in self.jobs:
                if (job.active_port_key or "").startswith(dev.id + ":"):
                    port = job.active_port_key.split(":", 1)[1]
                    self.block("device", dev.id, "pxe", f"Remote install is running on {_jobs_text(job)} through "
                                                        f"{dev.name} · port {port}; finish or cancel it first.")
        self.alert_keys.update({"device-api:" + dev.id, f"power:{dev.id}:"})
        self._twin_linked(f"dev:{dev.id}", dev.name)

    @staticmethod
    def _protection_entries():
        from .config import get_settings
        raw = str(getattr(get_settings(), "power_protected_outlets", "") or "").strip()
        if not raw or raw.lower() == "none":
            return []
        return [part.strip().rpartition(":")[0] or part.strip() for part in raw.split(",")]

    def _orphans(self):
        """Phase 2: the servers of the deleted devices and racks."""
        gone = set(self.gone)
        for key, server in self.servers.items():
            if key in self.removing or key in self.hidden:
                continue
            ports = server["ports"]
            on_gone = [(d, p) for d, p, _ in ports if d.id in gone]
            rack = self.rack_servers.get(key)
            if not on_gone and not rack:
                continue
            first = next((e for e in self.entries if (rack and e["kind"] == "rack" and e["id"] == rack) or
                          (e["kind"] == "device" and on_gone and e["id"] == on_gone[0][0].id)), None)
            if first is None and on_gone:   # a device deleted with its rack
                first = next((e for e in self.entries if e["kind"] == "rack" and e["id"] == on_gone[0][0].rack), None)
            self.cur = first
            rest = [(d, p) for d, p, _ in ports if d.id not in gone]
            for dev, port in on_gone:
                if rest or not rack:
                    self.note("servers_lose_port", f"{key}:{dev.id}:{port}", key=key, name=server["name"],
                              text=f"{server['name']} loses {dev.name} · {_port_word(dev.kind)} {port}")
            evidence = self.server_evidence(key)
            if rest and not rack:
                where = ", ".join(f"{d.name} · {_port_word(d.kind)} {p}" for d, p in rest)
                self.note("servers_kept", key, key=key, name=server["name"], why=f"still on {where}")
                continue
            if evidence or not self.options["orphan_servers"]:
                why = "still answers" if evidence else "kept (option off)"
                self.note("servers_kept", key, key=key, name=server["name"], why=why)
                continue
            where = f"drawn on {rack}" if rack else "only on " + ", ".join(sorted({d.name for d, _ in on_gone}))
            self.remove_server(key, free=True, why=where)
        self.cur = None

    def _after(self):
        """(remaining port devices, labels the pages would show after the delete, the servers they list)."""
        remaining = [d for d in self.port_devs if d.id not in self.gone]
        labels = {d.id: devices._effective_labels(d, self.saved[d.id], self.observed) for d in remaining}
        return remaining, labels, devices._all_servers(remaining, labels, self.layouts, self.monitor_names)

    def _pins(self):
        """Freeing a U never moves the servers drawn after it: in a rack where any other automatically numbered server
        would change floor, every automatic U of that rack is pinned where it is (as Remove from lab and clear-server)."""
        remaining, labels, _ = self._after()
        drop = set(self.removing)
        shown_after = {d: {p: l for p, l in lbl.items() if devices._key_of(l) not in drop} for d, lbl in labels.items()}
        before = devices._dcim_units(self.port_devs, self.shown0, self.layouts0)
        after = devices._dcim_units(remaining, shown_after, self.layouts)
        slots = self.layouts["rack_slots.json"]
        for rack, entries in sorted(before.items()):
            if rack in self.deleted_racks or (rack in slots and not isinstance(slots[rack], dict)):
                continue
            now = after.get(rack, {})
            auto = {i: u for i, (u, automatic) in entries.items() if automatic and devices._key_of(i) not in drop and i in now}
            if not any(now[i][0] != u for i, u in auto.items()):
                continue
            for i, u in sorted(auto.items()):
                if slots.setdefault(rack, {}).get(i) is None:
                    slots[rack][i] = u
                    self.note("layout", f"pin:{rack}:{i}", file="rack_slots.json",
                              text=f"{i} pinned on {rack} floor {u} (so it does not move)")
                    for info in self.removing.values():
                        if (info["plan"]["position"] or {}).get("rack") == rack:
                            info["plan"]["pins"].append({"rack": rack, "id": i, "slot": u})

    def _goes(self):
        if not self.c["servers_kept"]:
            return
        _, _, listed = self._after()
        index = devices._layout_ids(self.layouts)
        for key, fields in self.c["servers_kept"].items():
            before = devices._position(self.servers[key], self.layout_index.get(key, set()), self.layouts0)["rack"] \
                if key in self.servers else None
            if key not in listed:
                goes = "no longer listed"
            else:
                rack = devices._position(listed[key], index.get(key, set()), self.layouts)["rack"]
                goes = (f"stays on {rack}" if rack == before else f"falls back to {rack}") if rack else "stays listed as unplaced"
            fields["goes"] = goes
            fields["text"] = f"{fields['name']} is kept ({fields['why']}); {goes}"

    # ── rack ──
    async def _rack(self, db, entry):
        rack = entry["id"]
        self._item(entry, rack)
        if rack.casefold() == MAIN_STORAGE.casefold():
            self.block("rack", rack, "storage", f"{MAIN_STORAGE} cannot be deleted: units go there when a rack is deleted.")
            return
        known = rack in self.lab_racks or rack in devices._layout_racks(self.layouts0)
        if not known:
            self.block("rack", rack, "missing", f"No rack named {rack} is in the lab.")
            return
        self.deleted_racks.append(rack)
        evidence = []
        rack_devs = sorted((d for d in self.devs.values() if d.rack == rack), key=devices._device_order)
        for dev in rack_devs:
            ev, _ = self.device_evidence(dev)
            evidence += [f"{dev.name}: {e}" for e in ev]
            self.delete_device(dev)
            if dev.kind != "rack":
                self.note("devices_deleted", dev.id, text=f"{dev.name} ({dev.kind.upper()} on {rack})")
        drawn = devices._dcim_units(self.port_devs, self.shown0, self.layouts0).get(rack, {})
        keys = sorted({devices._key_of(i) for i in drawn} - {None})
        for key in keys:
            if key in self.hidden:
                continue
            self.rack_servers.setdefault(key, rack)
            evidence += [f"{self.server_name(key)}: {e}" for e in self.server_evidence(key)]
        for dev in self.port_devs:
            if dev.rack != rack and dev.id not in self.gone and any(devices._key_of(l) in keys for l in self.shown0[dev.id].values()):
                self.note("shared_kept", dev.id, text=f"{dev.name} stays (belongs to {dev.rack or 'no rack'})")
        self.items_out[-1]["evidence"] = evidence
        layout = {}
        for fname in ("rack_slots.json", "rack_positions.json"):
            if rack in self.layouts[fname]:
                layout[fname] = self.layouts[fname].pop(rack)
                self.note("layout", f"{fname}:{rack}", file=fname, text=f"{rack}: {devices._LAYOUT_NAMES[fname]} removed")
        overrides = {i: v for i, v in self.layouts["rack_overrides.json"].items() if v == rack}
        for i in overrides:
            del self.layouts["rack_overrides.json"][i]
        if overrides:
            layout["rack_overrides.json"] = overrides
            self.note("layout", f"overrides:{rack}", file="rack_overrides.json",
                      text=f"{len(overrides)} rack assignment{'s' if len(overrides) != 1 else ''} to {rack} removed")
        self.cur["snapshot"]["layout"] = layout
        self.cur["snapshot"]["rack_items_key"] = rack in self.items0
        for unit in list(self.items.get(rack) or []):
            if self.options["rack_units"] == "delete":
                self.delete_unit(unit["id"], why=f"on {rack}")
            else:
                self.items[rack].remove(unit)
                moved = {**copy.deepcopy(unit), "u": 0}
                self.items.setdefault(MAIN_STORAGE, []).append(moved)
                self.moved_units.add(unit["id"])
                self.snap("units_moved", {"id": unit["id"], "u": unit.get("u")})
                self.note("units_moved", unit["id"], id=unit["id"], name=str(unit.get("name") or unit["id"]),
                          text=f"{unit.get('name') or unit['id']}: {_place_text(rack, devices._slot_value(unit.get('u')))} → {MAIN_STORAGE}")
        self.items.pop(rack, None)
        for unit in _as_list(self.chillers.get("units")):
            if isinstance(unit, dict) and unit.get("rack") == rack:
                unit["rack"] = ""
                self.snap("cooling", unit.get("id"))
                self.note("cooling_unassigned", unit.get("id"), text=f"{unit.get('name') or unit.get('id')} is taken off {rack}")
        for setup in [s for s in _as_list(self.twin.get("setups")) if isinstance(s, dict) and s.get("dcimRack") == rack]:
            if self.options["twin_frame"]:
                self._twin_delete(setup["id"], f"3D frame of {rack}")
            else:
                setup.pop("dcimRack", None)
                self.snap("unmapped", {"id": setup["id"], "dcimRack": rack})
                self.note("setups_unmapped", setup["id"], text=f"3D frame {setup.get('name') or setup['id']} is no longer mapped to {rack}")

    # ── unit ──
    async def _unit(self, db, entry):
        found = self.unit_of(entry["id"])
        if not found:
            self._item(entry, entry["id"])
            self.block("unit", entry["id"], "missing", f"No unit with id {entry['id']} is in the lab.")
            return
        rack, _, unit = found
        self._item(entry, str(unit.get("name") or unit["id"]), self.unit_evidence(unit))
        self.delete_unit(unit["id"], why="")

    def delete_unit(self, unit_id, why=""):
        found = self.unit_of(unit_id)
        if not found or unit_id in self.deleted_units:
            return
        rack, index, unit = found
        self.items[rack].pop(index)
        if not self.items[rack] and rack != MAIN_STORAGE:
            del self.items[rack]
        self.deleted_units.add(unit_id)
        name = str(unit.get("name") or unit_id)
        asset = "item:" + unit_id
        owner = self.owner_rows.get(asset)
        if asset in self.owners or owner is not None:
            self.unit_owners[asset] = (owner.engineer_id, owner.legacy_name) if owner is not None else (None, self.owners.get(asset, ""))
            if self.owners.get(asset):
                self.note("owners", asset, key=asset, name=self.owners[asset], text=f"{name}: owner {self.owners[asset]} removed")
        original = self.unit_of(unit_id, self.items0)
        self.snap("units", {"rack": original[0] if original else rack, "index": original[1] if original else index,
                            "item": copy.deepcopy(original[2] if original else unit),
                            "owner": list(self.unit_owners.get(asset) or []) or None})
        if why:
            self.note("units_deleted", unit_id, id=unit_id, name=name, text=f"{name} ({why})")
        self._twin_linked(f"unit:{unit_id}", name)
        if unit.get("type") in SERVER_UNIT_TYPES:
            key = devices._key_of(unit.get("name"))
            if key and key in self.monitors and not self.ports_now.get(key) and key not in self.hidden:
                if self.admin and self.options["unit_server"]:
                    self.remove_server(key, free=False, why=f"it is only pinged; unit {name}")
                else:
                    self.note("notes", f"unit-server:{key}",
                              text=f"{self.server_name(key)} stays in Ping Monitor; an Admin can delete it")

    # ── cooling ──
    async def _cooling(self, db, entry):
        found = self.chiller_of(entry["id"])
        if not found:
            self._item(entry, entry["id"])
            self.block("cooling", entry["id"], "missing", f"No cooling unit with id {entry['id']} is in the lab.")
            return
        index, unit = found
        name = str(unit.get("name") or unit.get("id"))
        self._item(entry, name)
        self.chillers["units"].pop(index)
        connections = _as_list(self.chillers.get("connections"))
        linked = [c for c in connections if isinstance(c, dict) and entry["id"] in [v for v in c.values() if isinstance(v, str)]]
        if linked:
            self.chillers["connections"] = [c for c in connections if c not in linked]
        entry["snapshot"].update({"index": index, "unit": copy.deepcopy(unit), "connections": copy.deepcopy(linked)})
        self._twin_linked(f"cooling:{entry['id']}", name)

    # ── 3D records ──
    async def _twin(self, db, entry):
        rid = entry["id"]
        if rid in self.room_ids():
            raise HTTPException(400, NOT_DELETABLE.format(rid))
        found = self.twin_record(rid)
        if not found:
            self._item(entry, rid)
            self.block("twin", rid, "missing", f"{rid} is not in the 3D data any more.")
            return
        _, _, record = found
        self._item(entry, _js_text(record.get("name")) or rid)
        uid = self.links["linked"].get(rid)
        if uid:
            kind, _, ident = uid.partition(":")
            if kind == "rack":
                self.block("twin", rid, "linked", f"Delete {ident} itself (rack window); its 3D frame can go with it.")
            else:
                self.block("twin", rid, "linked", f"Delete {self.uid_name(uid)} itself; its 3D record goes with it.")
            return
        self._twin_delete(rid, "")

    def _twin_linked(self, uid, name):
        """twin_records: the 3D records linked to a Lab Manager record that is deleted."""
        if not self.options["twin_records"]:
            return
        for rid in self.twin_of.get(uid, []):
            if uid.startswith("rack:"):
                continue
            self._twin_delete(rid, f"3D record of {name}")

    def _twin_delete(self, rid, why):
        found = self.twin_record(rid)
        if not found:
            return
        list_name, index, record = found
        self.twin[list_name].pop(index)
        self.snap("twin", {"list": list_name, "index": index, "record": copy.deepcopy(record)})
        label = _js_text(record.get("name")) or rid
        self.note("twin_deleted", rid, id=rid, text=f"{label} ({rid})" + (f": {why}" if why else ""))
        self.screens.add("3D twin")
        self._seeds(record)
        contents = []
        if list_name == "storage":
            contents = [i for i in _as_list(self.twin.get("items")) if isinstance(i, dict) and i.get("storage") == rid]
        elif list_name == "setups":
            contents = [i for i in _as_list(self.twin.get("items")) if isinstance(i, dict) and i.get("setup") == rid]
            shelves = _as_list(self.twin.get("shelves"))
            for shelf in [s for s in shelves if isinstance(s, dict) and s.get("setup") == rid]:
                position = shelves.index(shelf)
                shelves.pop(position)
                self.snap("twin", {"list": "shelves", "index": position, "record": copy.deepcopy(shelf)})
        for item in contents:
            linked = item.get("id") in self.links["linked"]
            if self.options["twin_contents"] and not linked:
                self._twin_delete(item["id"], f"in {label}")
            else:
                fields = {k: item.pop(k) for k in ("setup", "shelf", "storage") if k in item}
                self.snap("unplaced", {"id": item["id"], "fields": fields})
                self.note("twin_unplaced", item["id"], text=f"{_js_text(item.get('name')) or item['id']} becomes unplaced in 3D")

    def _seeds(self, record):
        """The dcim seed entries a deleted 3D record names (lab-data.json "dcim": pdus, kvms, optOwners, rackSlots)."""
        dcim = self.twin.get("dcim") if isinstance(self.twin.get("dcim"), dict) else None
        info = record.get("dcim") if isinstance(record.get("dcim"), dict) else {}
        if dcim is None:
            return
        kind = record.get("type")
        if kind in ("pdu", "kvm") and info.get("deviceId"):
            lst = _as_list(dcim.get(kind + "s"))
            for position in reversed(range(len(lst))):
                if isinstance(lst[position], dict) and lst[position].get("id") == info["deviceId"]:
                    self.snap("seeds", {"list": kind + "s", "index": position, "value": copy.deepcopy(lst[position])})
                    lst.pop(position)
        if kind == "opt":
            key = js_identity(info.get("optKey")) or js_identity(record.get("name"))
            owners = dcim.get("optOwners") if isinstance(dcim.get("optOwners"), dict) else {}
            for k in [k for k in owners if js_identity(k) == key]:
                self.snap("seeds", {"map": "optOwners", "key": k, "value": owners.pop(k)})
            slots = dcim.get("rackSlots") if isinstance(dcim.get("rackSlots"), dict) else {}
            for rack, entries in slots.items():
                if isinstance(entries, dict):
                    for k in [k for k in entries if js_identity(k) == key]:
                        self.snap("seeds", {"map": "rackSlots", "rack": rack, "key": k, "value": entries.pop(k)})

    # ── the answer ──
    def public(self):
        consequences = {}
        for name in CONSEQUENCES:
            rows = []
            for key, fields in sorted(self.c[name].items(), key=lambda kv: str(kv[1].get("text") or kv[0]).casefold()):
                rows.append({"key": key, **fields})
            consequences[name] = rows
        for key in self.alert_titles:
            consequences["alerts_closed"].append({"key": key, "title": self.alert_titles[key],
                                                  "text": f"{self.alert_titles[key]}: alert closed"})
        plan = {"targets": [{"kind": e["kind"], "id": e["id"]} for e in self.entries], "items": self.items_out,
                "consequences": consequences, "blockers": self.blockers,
                "screens": [s for s in SCREEN_ORDER if s in self.screens], "options": self.options}
        basis = {**plan, "items": [{"kind": i["kind"], "id": i["id"], "name": i["name"], "evidence": bool(i["evidence"])}
                                   for i in self.items_out]}
        plan["plan_revision"] = inventory_store.revision(basis)
        return plan

    async def titles(self, db):
        from .alerts import open_alert_titles
        self.alert_titles = await open_alert_titles(db, sorted(self.alert_keys))
        for key, (name, target, held) in self.idle_removed.items():
            if target is not None and "network:" + target.id in self.alert_titles:
                continue   # its open alert is closed: that is still something to do
            in_3d = bool(self.twin_of.get(f"server:{key}")) and not self.options["twin_records"]
            if held or in_3d:
                kept = [part for part, on in (("its name stays on its ports (the option to keep its name is on)", held),
                                              ("its 3D record stays (the option to delete 3D records is off)", in_3d)) if on]
                self.block("server", key, "removed", f"Nothing to delete: {name} is already removed, and "
                                                     f"{' and '.join(kept)}.")
            else:
                self.block("server", key, "removed", f"{name} is already deleted: no outlet, KVM port or 3D record names it "
                                                     "any more.")
        return self

    def affected_pdus(self):
        ids = {d for d in self.gone if self.gone[d]["kind"] == "pdu"}
        ids |= {dev_id for dev_id, _ in self.freed if getattr(self.devs.get(dev_id), "kind", "") == "pdu"}
        return sorted(ids)

    async def apply(self, db):
        """Write the plan (the caller holds the locks and checked the plan_revision): the database part first (flushed),
        then every file in one step, then the commit; a failed commit puts the files back."""
        from .alerts import close_deleted
        batch_id = uuid.uuid4().hex[:16]
        now = time.time()
        for key, info in self.removing.items():
            record = await removed_servers.apply_core(db, info["plan"], info["target"], info["existing"], self.who,
                                                      self.reason, now, batch_id)
            self.removed["servers"][key] = record
            removed_servers._log_entry(self.removed, "removed", record, self.who, self.reason)
        if self.pausing:
            from .ping_monitor import close_incident
            for target in self.pausing.values():   # an already removed server whose monitor was switched on again
                target.enabled = False
                target.revision += 1   # a probe still in flight is ignored
                await close_incident(db, target.id, now, "server removed")
        changed = {}
        for dev in self.port_devs:
            if dev.id in self.gone or self.saved[dev.id] == self.saved0[dev.id]:
                continue
            dev.labels_json = json.dumps(self.saved[dev.id])
            changed[dev.id] = {p for p in set(self.saved0[dev.id]) | set(self.saved[dev.id])
                               if self.saved0[dev.id].get(p) != self.saved[dev.id].get(p)}
        for dev_id in self.gone:
            for model in (DeviceNameSync, DeviceNameSyncLease, MonitorDeviceSnapshot, MonitorDeviceError):
                await db.execute(sql_delete(model).where(model.device_id == dev_id))
            await db.execute(sql_delete(Device).where(Device.id == dev_id).execution_options(synchronize_session=False))
            if dev_id in self.devs:
                db.expunge(self.devs[dev_id])
        await close_deleted(db, sorted(self.alert_keys), self.who, now)
        for asset in self.unit_owners:
            row = await db.get(AssetOwner, asset)
            if row is None:
                row = AssetOwner(asset_key=asset)
                db.add(row)
            row.engineer_id, row.legacy_name = None, ""
        await db.flush()
        batch = {"id": batch_id, "at": now, "by": self.who, "reason": self.reason, "entries": self.entries}
        store = purged(self.store0, now)
        store["batches"] = [*store["batches"], batch]
        files = self._file_entries(store)
        try:
            revisions, _ = inventory_store.save_layouts_with_items(
                files, items=(self.items, inventory_store.revision(self.items0)) if self.items != self.items0 else None,
                items_allow_drop=frozenset(self.deleted_units), items_note=self._moved_note())
        except BaseException:
            await db.rollback()
            raise
        await commit_or_put_back(db, self._written(files))
        from . import name_sync
        from .routers import kvms, pdus
        for dev_id in self.gone:
            pdus.invalidate(dev_id)
            kvms._cache.pop(dev_id, None)
            kvms._in_use.pop(dev_id, None)
        names = await name_sync.queue(changed)
        return batch, revisions, names

    def _moved_note(self):
        if not self.deleted_racks:
            return inventory_store.MOVED_WITH_SERVER_NOTE
        return f"Moved to {MAIN_STORAGE}: rack {', '.join(self.deleted_racks)} deleted"

    def _file_entries(self, store):
        files = []
        if self.removed != self.removed0:
            files.append(("removed_servers", removed_servers.store_path(), self.removed, self.rev0["removed"],
                          removed_servers.EMPTY))
        for fname in devices._LAYOUT_FILES:
            if self.layouts[fname] != self.layouts0[fname]:
                files.append((fname, devices._BACKEND_DIR / fname, self.layouts[fname], self.rev0[fname], {}))
        if self.chillers != self.chillers0:
            files.append(("chillers", self.chillers_path, self.chillers, self.rev0["chillers"], CHILLERS_EMPTY,
                          {"versioned": {"by": self.who or None, "action": "deleted"}}))
        if self.twin != self.twin0:
            files.append(("twin", self.twin_path, self.twin, self.rev0["twin"], {}, {"ensure_ascii": False}))
        files.append(("deleted", store_path(), store, self.rev0["deleted"], EMPTY))
        return files

    def _written(self, files):
        paths = {"removed_servers": "removed", "chillers": "chillers", "twin": "twin", "deleted": "deleted",
                 **{f: f for f in devices._LAYOUT_FILES}}
        written = [(entry[1], self.raw0[paths[entry[0]]]) for entry in files]
        if any(entry[0] == "chillers" for entry in files):
            written.append((inventory_store.history_path(self.chillers_path), self.raw0["chillers_history"]))
        if self.items != self.items0:
            written.append((inventory_store.ITEMS_FILE, self.raw0["items"]))
        return written


async def commit_or_put_back(db, written):
    """Commit the database part; when that fails, put every file written just before back to its exact earlier bytes
    (as removed_servers does) and answer 503."""
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        for path, raw in written:
            try:
                with inventory_store.locked_file(path, inventory_store.LAYOUT_SAVE_FAILED):
                    inventory_store._put_back(path, raw)
            except Exception:  # noqa: BLE001 - logged by the caller's 503
                pass
        raise HTTPException(503, NOT_SAVED) from exc


# ── restore ─────────────────────────────────────────────────────────────────────────────────────────────────────────
class Restore(Lab):
    def __init__(self, batch_id, selection, admin, who=""):
        self.batch_id = batch_id
        self.selection = selection
        self.admin = admin
        self.who = who
        self.c = {name: {} for name in RESTORE_CONSEQUENCES}
        self.blockers = []
        self.items_out = []
        self.added = {}           # device id -> snapshot to insert
        self.resume = []          # removal records whose monitor resumes
        self.unpause = []         # {id, key} of monitors a delete of an already removed server paused
        self.owner_set = {}       # asset key -> (engineer_id, legacy_name)
        self.restored_units = set()
        self.moved_back = []
        self.racks = []
        self.chosen = []

    def note(self, group, ident, /, **fields):
        self.c[group].setdefault(ident, fields)

    def block(self, entry, code, text):
        self.blockers.append({"kind": entry["kind"], "id": entry["id"], "code": code, "text": text})

    async def build(self, db):
        await self.load(db)
        self.store = purged(self.store0, self.now)
        self.batch = find_batch(self.store, self.batch_id)
        if self.batch is None:
            raise HTTPException(404, NO_BATCH)
        wanted = None
        if self.selection is not None:
            if not isinstance(self.selection, list) or not all(isinstance(s, dict) for s in self.selection):
                raise HTTPException(400, "entries is a list of {kind, id}.")
            wanted = {(s.get("kind"), s.get("id")) for s in self.selection}
        for entry in self.batch.get("entries") or []:
            if entry.get("restored_at") or (wanted is not None and (entry.get("kind"), entry.get("id")) not in wanted):
                continue
            if not self.admin and admin_only(entry):
                raise HTTPException(403, admin_only(entry))
            self.chosen.append(entry)
        if not self.chosen:
            raise HTTPException(409, "Nothing to restore: these entries are already back.")
        for entry in self.chosen:
            self.items_out.append({"kind": entry["kind"], "id": entry["id"], "name": entry.get("name") or entry["id"]})
            snapshot = entry.get("snapshot") or {}
            for dev in snapshot.get("devices") or []:
                self._device(entry, dev)
            if entry["kind"] == "rack":
                self._rack(entry, snapshot)
        # units go back in their original order (lowest list position first), across every chosen entry
        units = [(entry, unit) for entry in self.chosen for unit in (entry.get("snapshot") or {}).get("units") or []]
        for entry, unit in sorted(units, key=lambda eu: (str(eu[1].get("rack")), eu[1].get("index", 0), eu[1].get("seq", 0))):
            self._unit(entry, unit)
        for entry in self.chosen:
            snapshot = entry.get("snapshot") or {}
            if entry["kind"] == "cooling":
                self._cooling(entry, snapshot)
            for key in snapshot.get("servers") or []:
                self._server(entry, key)
            if snapshot.get("kept_removed"):
                self._kept_removed(entry, snapshot)
            self._freed(snapshot.get("freed") or [])
        self._twin(self.chosen)
        return self

    # ── devices ──
    def _device(self, entry, snap):
        if snap["id"] in self.devs or snap["id"] in self.added:
            self.block(entry, "id-taken", f"A device with id {snap['id']} is in the lab again; {snap['name']} cannot come back.")
            return
        key = devices.name_key(snap["name"])
        others = [(d.kind, d.name, d.ip) for d in self.devs.values()] + [(a["kind"], a["name"], a["ip"]) for a in self.added.values()]
        address = devices._address_key(snap["ip"])
        for kind, name, ip in others:
            if kind == snap["kind"] and devices.name_key(name) == key:
                self.block(entry, "name-taken", devices.name_taken_text(snap["kind"], snap["name"]))
                return
            if snap["kind"] in devices._PORT_KINDS and kind in devices._PORT_KINDS and \
                    address not in devices._UNSET_ADDRESSES and devices._address_key(ip) == address:
                self.block(entry, "address-taken", f"{name} ({kind.upper()}) now uses the address of {snap['name']}.")
                return
        self.added[snap["id"]] = snap
        self.note("devices_restored", snap["id"], text=f"{snap['name']} ({snap['kind'].upper() if snap['kind'] != 'rack' else 'rack'})")
        if snap["kind"] in devices._PORT_KINDS:
            try:
                labels = json.loads(snap.get("labels_json") or "{}")
            except ValueError:
                labels = {}
            self.saved.setdefault(snap["id"], labels if isinstance(labels, dict) else {})

    # ── servers ──
    def _server(self, entry, key):
        record = self.removed["servers"].get(key)
        if isinstance(record, dict) and record.get("batch") == self.batch_id:
            del self.removed["servers"][key]
            removed_servers._log_entry(self.removed, "restored", {"key": key, "name": record.get("name") or key}, self.who)
            self.resume.append(record)
            self.note("servers_restored", key, text=str(record.get("name") or key))
            monitor = record.get("monitor") or {}
            if monitor.get("was_enabled"):
                self.note("monitors_resumed", key, text=f"{record.get('name') or key}: ping monitor resumes")
        elif isinstance(record, dict):
            self.note("notes", f"server:{key}", text=f"{record.get('name') or key} was removed again later; restore it "
                                                     "from that removal")
        else:
            self.note("notes", f"server:{key}", text=f"{key} is already back in the lab")

    def _kept_removed(self, entry, snapshot):
        """A server that was already removed when it was deleted: its names, 3D records and a monitor the delete paused
        come back, and it stays removed (restore it from its window to show it again)."""
        key = entry["id"]
        record = self.removed["servers"].get(key)
        name = (record.get("name") if isinstance(record, dict) else None) or entry.get("name") or key
        for paused in snapshot.get("paused") or []:
            self.unpause.append(paused)
            self.note("monitors_resumed", paused.get("key") or key, text=f"{name}: ping monitor resumes")
        if isinstance(record, dict):
            self.note("notes", f"removed:{key}", text=f"{name} stays removed from the lab, as it was before this delete; "
                                                        "Restore… in its window shows it again")

    def _freed(self, freed):
        for f in freed:
            dev = self.devs.get(f["device_id"])
            word = _port_word(f.get("kind"))
            where = f"{f.get('device_name') or f['device_id']} · {word} {f['port']}"
            if dev is None:
                self.note("ports_not_restored", where, text=f"{where}: the device is not in the lab — not restored")
                continue
            labels = self.saved.setdefault(dev.id, {})
            current = labels.get(f["port"])
            if current == f.get("expected"):
                if f.get("label"):
                    labels[f["port"]] = f["label"]
                else:
                    labels.pop(f["port"], None)
                self.note("ports_restored", where, text=f"{where} → {f.get('label')}")
            else:
                shown = current or self.shown0.get(dev.id, {}).get(f["port"]) or "something else"
                self.note("ports_not_restored", where, text=f"{where} now says {shown} — not restored")

    # ── units ──
    def _unit(self, entry, snap):
        item = copy.deepcopy(snap["item"])
        if self.unit_of(item["id"]):
            self.block(entry, "id-taken", f"A unit with id {item['id']} is in the lab again; {item.get('name') or item['id']} "
                                          "cannot come back.")
            return
        index = inventory_store.identity_index(self.items)
        for key in inventory_store.identity_keys(item) - {inventory_store.identity_key(item["id"])}:
            if index.get(key):
                other = self.unit_of(sorted(index[key])[0])
                self.block(entry, "unit-taken", f"The barcode, serial or MAC of {item.get('name') or item['id']} now "
                                                f"belongs to {other[2].get('name') if other else 'another unit'}.")
                return
        rack = snap.get("rack")
        if rack in self.lab_racks or rack in self.racks or rack in {d.get("rack") for d in self.added.values()}:
            self.items.setdefault(rack, []).insert(min(snap.get("index", 0), len(self.items.get(rack) or [])), item)
            self.note("units_restored", item["id"], text=f"{item.get('name') or item['id']} → {_place_text(rack, devices._slot_value(item.get('u')))}")
        else:
            item["u"] = 0
            self.items.setdefault(MAIN_STORAGE, []).append(item)
            self.note("units_to_storage", item["id"], text=f"{item.get('name') or item['id']} → {MAIN_STORAGE} ({rack} is gone)")
        self.restored_units.add(item["id"])
        if snap.get("owner"):
            self.owner_set["item:" + item["id"]] = tuple(snap["owner"])

    # ── rack ──
    def _rack(self, entry, snapshot):
        rack = entry["id"]
        self.racks.append(rack)
        layout = snapshot.get("layout") or {}
        for fname in ("rack_slots.json", "rack_positions.json"):
            if fname in layout:
                if rack in self.layouts[fname]:
                    self.note("notes", f"{fname}:{rack}", text=f"{rack} has new {devices._LAYOUT_NAMES[fname]}; the old ones are not restored")
                else:
                    self.layouts[fname][rack] = layout[fname]
                    self.note("layout", f"{fname}:{rack}", text=f"{rack}: {devices._LAYOUT_NAMES[fname]} restored")
        for i, value in (layout.get("rack_overrides.json") or {}).items():
            if i not in self.layouts["rack_overrides.json"]:
                self.layouts["rack_overrides.json"][i] = value
        if snapshot.get("rack_items_key") and rack not in self.items:
            self.items[rack] = []
        for moved in snapshot.get("units_moved") or []:
            found = self.unit_of(moved["id"])
            if not found or found[0] != MAIN_STORAGE:
                self.note("notes", f"moved:{moved['id']}", text=f"{moved['id']} is no longer in {MAIN_STORAGE}; it stays where it is")
                continue
            _, index, unit = found
            self.items[MAIN_STORAGE].pop(index)
            u = moved.get("u")
            unit["u"] = u if inventory_store.valid_u(u) else 0
            self.items.setdefault(rack, []).append(unit)
            self.moved_back.append(unit["id"])
            self.note("units_restored", unit["id"], text=f"{unit.get('name') or unit['id']} → {_place_text(rack, devices._slot_value(u))}")
        for unit_id in snapshot.get("cooling") or []:
            found = self.chiller_of(unit_id)
            if found and not found[1].get("rack"):
                found[1]["rack"] = rack
                self.note("cooling_restored", unit_id, text=f"{found[1].get('name') or unit_id} → {rack}")

    # ── cooling ──
    def _cooling(self, entry, snapshot):
        unit = snapshot.get("unit")
        if not isinstance(unit, dict):
            return
        if self.chiller_of(unit.get("id")):
            self.block(entry, "id-taken", f"A cooling unit with id {unit.get('id')} is in the lab again.")
            return
        units = self.chillers.setdefault("units", [])
        units.insert(min(snapshot.get("index", len(units)), len(units)), copy.deepcopy(unit))
        if snapshot.get("connections"):
            self.chillers.setdefault("connections", []).extend(copy.deepcopy(snapshot["connections"]))
        self.note("cooling_restored", unit.get("id"), text=str(unit.get("name") or unit.get("id")))

    # ── 3D ──
    def _twin(self, chosen):
        """Every 3D record of the chosen entries, put back in the reverse order of the delete (so each lands at its
        place in the list); an entry whose 3D id is used again is refused."""
        records, seeds, ok = [], [], []
        for entry in chosen:
            snapshot = entry.get("snapshot") or {}
            mine = snapshot.get("twin") or []
            taken = next((rec["record"].get("id") for rec in mine if self._twin_taken(rec)), None)
            if taken:
                self.block(entry, "twin-taken", f"3D id {taken} is used again; its 3D record cannot come back.")
                continue
            records += mine
            seeds += snapshot.get("seeds") or []
            ok.append(snapshot)
        for rec in sorted(records, key=lambda r: -r.get("seq", 0)):
            lst = self.twin.setdefault(rec["list"], [])
            lst.insert(min(rec["index"], len(lst)), copy.deepcopy(rec["record"]))
            if rec["list"] != "shelves":
                self.note("twin_restored", rec["record"].get("id"),
                          text=f"{_js_text(rec['record'].get('name')) or rec['record'].get('id')} ({rec['record'].get('id')})")
        dcim = self.twin.setdefault("dcim", {}) if seeds else None
        for seed in sorted(seeds, key=lambda s: -s.get("seq", 0)):
            if "list" in seed:
                lst = dcim.setdefault(seed["list"], [])
                lst.insert(min(seed["index"], len(lst)), seed["value"])
            elif seed.get("map") == "optOwners":
                dcim.setdefault("optOwners", {}).setdefault(seed["key"], seed["value"])
            elif seed.get("map") == "rackSlots":
                dcim.setdefault("rackSlots", {}).setdefault(seed["rack"], {}).setdefault(seed["key"], seed["value"])
        for snapshot in ok:
            for moved in snapshot.get("unplaced") or []:
                found = self.twin_record(moved["id"])
                if found and not any(k in found[2] for k in ("setup", "shelf", "storage")):
                    found[2].update(moved["fields"])
            for mapping in snapshot.get("unmapped") or []:
                found = self.twin_record(mapping["id"])
                if found and not found[2].get("dcimRack"):
                    found[2]["dcimRack"] = mapping["dcimRack"]

    def _twin_taken(self, rec):
        rid = rec["record"].get("id")
        if rec["list"] == "shelves":
            return any(isinstance(s, dict) and s.get("id") == rid for s in _as_list(self.twin.get("shelves")))
        return bool(self.twin_record(rid))

    # ── the answer ──
    def public(self):
        consequences = {name: [{"key": k, **f} for k, f in sorted(self.c[name].items(), key=lambda kv: str(kv[1].get("text")).casefold())]
                        for name in RESTORE_CONSEQUENCES}
        plan = {"batch": self.batch_id, "items": self.items_out, "consequences": consequences, "blockers": self.blockers}
        plan["plan_revision"] = inventory_store.revision(plan)
        return plan

    def affected_pdus(self):
        return sorted({dev_id for dev_id in self.saved if getattr(self.devs.get(dev_id), "kind", "") == "pdu"
                       and self.saved[dev_id] != self.saved0.get(dev_id)})

    async def apply(self, db):
        now = time.time()
        for snap in self.added.values():
            db.add(Device(**{k: snap[k] for k in ("id", "name", "kind", "model", "ip", "rack", "port_count", "username_enc",
                                                  "password_enc", "labels_json", "enabled", "notes")}))
        changed = {}
        for dev in self.port_devs:
            if self.saved.get(dev.id) != self.saved0.get(dev.id):
                dev.labels_json = json.dumps(self.saved[dev.id])
                changed[dev.id] = {p for p in set(self.saved0[dev.id]) | set(self.saved[dev.id])
                                   if self.saved0[dev.id].get(p) != self.saved[dev.id].get(p)}
        for record in self.resume:
            await removed_servers.restore_core(db, record)
        for paused in self.unpause:
            target = await db.get(PingTarget, paused.get("id"))
            if target is not None and not target.enabled and target.source_key == "server:" + str(paused.get("key")):
                target.enabled = True
                target.revision += 1
        for asset, (engineer_id, legacy_name) in self.owner_set.items():
            row = await db.get(AssetOwner, asset)
            if row is None:
                row = AssetOwner(asset_key=asset)
                db.add(row)
            if engineer_id is not None:
                from .models import Engineer
                if await db.get(Engineer, engineer_id) is None:
                    engineer_id, legacy_name = None, legacy_name or ""
            row.engineer_id, row.legacy_name = engineer_id, legacy_name or ""
        await db.flush()
        chosen = {(e["kind"], e["id"]) for e in self.chosen}
        for entry in self.batch["entries"]:
            if (entry["kind"], entry["id"]) in chosen:
                entry["restored_at"] = now
                entry["restored_by"] = self.who
        files = Delete._file_entries(self, self.store)
        files = [(n, p, d, r, df, *([{"versioned": {"by": self.who or None, "action": "restored"}}] if n == "chillers" else
                                     ([{"ensure_ascii": False}] if n == "twin" else [])))
                 for n, p, d, r, df, *_ in files]
        try:
            revisions, _ = inventory_store.save_layouts_with_items(
                files, items=(self.items, inventory_store.revision(self.items0)) if self.items != self.items0 else None,
                items_note=f"Restored from the Deleted list", items_restored=frozenset(self.restored_units))
        except BaseException:
            await db.rollback()
            raise
        await commit_or_put_back(db, Delete._written(self, files))
        from . import name_sync
        names = await name_sync.queue(changed)
        return revisions, names


# ── the Deleted list as GET answers it ──────────────────────────────────────────────────────────────────────────────
async def listing(db, admin):
    """{batches: [{id, at, by?, reason?, entries: [{kind, id, name, restorable, why_not, restored_at}]}]}, newest first.
    Who and why are Admin only; snapshots (credentials included) are never returned."""
    store = purged(read_store(), time.time())
    rows = (await db.execute(select(Device))).scalars().all()
    ids = {d.id for d in rows}
    try:
        items = inventory_store.read_items()
    except HTTPException:
        items = {}
    unit_ids = {u.get("id") for lst in items.values() for u in lst if isinstance(u, dict)}
    twin_path, chillers_path = _twin_files()
    twin = inventory_store.read_layout(twin_path, {})
    twin_ids = {r.get("id") for name in ("items", "storage", "setups") for r in _as_list((twin or {}).get(name)) if isinstance(r, dict)}
    chillers = inventory_store.read_layout(chillers_path, CHILLERS_EMPTY)
    cooling_ids = {u.get("id") for u in _as_list((chillers or {}).get("units")) if isinstance(u, dict)}
    out = []
    for batch in sorted(store["batches"], key=lambda b: -(b.get("at") or 0)):
        entries = []
        for entry in batch.get("entries") or []:
            snapshot = entry.get("snapshot") or {}
            why = ""
            if entry.get("restored_at"):
                why = "Restored"
            elif any(d.get("id") in ids for d in snapshot.get("devices") or []):
                why = "A device with the same id is in the lab again"
            elif any((u.get("item") or {}).get("id") in unit_ids for u in snapshot.get("units") or []):
                why = "A unit with the same id is in the lab again"
            elif entry.get("kind") == "cooling" and (snapshot.get("unit") or {}).get("id") in cooling_ids:
                why = "A cooling unit with the same id is in the lab again"
            elif any(t["list"] != "shelves" and t["record"].get("id") in twin_ids for t in snapshot.get("twin") or []):
                why = "Its 3D id is used again"
            elif not admin and entry.get("kind") not in ADMIN_KINDS and admin_only(entry):
                why = admin_only(entry)   # Admin kinds the page already offers to Admins only
            entries.append({"kind": entry.get("kind"), "id": entry.get("id"), "name": entry.get("name") or entry.get("id"),
                            "restorable": not why, "why_not": "" if why == "Restored" else why,
                            "restored_at": entry.get("restored_at")})
        row = {"id": batch["id"], "at": batch.get("at"), "entries": entries}
        if admin:
            row["by"], row["reason"] = batch.get("by") or "", batch.get("reason") or ""
        out.append(row)
    return {"batches": out}


def forget_batch(batch_id):
    """Delete forever: the batch and its snapshots (encrypted credentials included) leave deleted.json. Servers it
    removed stay removed; they are restored from Removed servers from then on. 404 for an unknown batch."""
    path = store_path()
    with inventory_store.locked_file(path, inventory_store.LAYOUT_SAVE_FAILED):
        store = read_store(strict=True)
        if find_batch(store, batch_id) is None:
            raise HTTPException(404, NO_BATCH)
        kept = purged({**store, "batches": [b for b in store["batches"] if b.get("id") != batch_id]}, time.time())
        inventory_store.write_json(path, kept)
    return inventory_store.revision(kept)
