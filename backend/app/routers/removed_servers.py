"""Removed servers (Admin): hide a server that is no longer in the lab, and restore it.

A server exists in DCIM because a PDU outlet (or KVM port) label names it. When the machine is physically gone but the
label is still on the PDU, it keeps showing everywhere. Removing it records it in removed_servers.json (who, when, why)
and every page hides it; its DCIM-side data that would otherwise dangle is cleaned in the same operation. Nothing is
written to a PDU or KVM: the outlet label stays as it is.

THE KEY RULE. A removed server is identified by its server identity (ping_monitor.server_identity: "OPTN44 (PSU2)" ->
"optn44"), the same key the owners, ping monitors, SSH and Locations use, and never by a prefix or a substring: removing
"optn44" never hides "optn4" or "optn440". A renamed or relabelled server has another identity, so it is a different
server and is not hidden. The record also keeps the PDU/KVM ports that carried the name at removal time, and it hides
the server only while every port that carries that identity is one of them. When the same name is written on another
port later (a new machine that reuses the name), the record stops hiding it ("active": false, the name is shown again
everywhere) instead of hiding the new label by accident; removing it again records the new ports.

What a removal cleans (and Restore does not bring back; the UI says so):
  * rack layout files: its rack override, rack U slot, rack order and switch assignment entries (every DCIM id of the
    server: "optn44", "optn44 (psu1)", ...); other servers whose U number was automatic and would move up are pinned
    where they are, so nothing else moves;
  * its owner assignments (a tombstone, so the legacy owners file cannot bring the owner back).
What it pauses (and Restore resumes when it was running): its ping monitor. The monitor and its history are kept;
while the server is removed no monitor is created for it automatically.
Never touched: equipment units (rack items) on its shelf stay in the rack, SSH settings, PDU/KVM labels, devices.

Concurrency: GET returns an ETag; remove and restore need it as If-Match (428 without, 409 when stale). A remove
preview (dry_run) returns a plan_revision; applying with a plan_revision is refused (409) if anything changed since.
The record and the layout files are written together or not at all (inventory_store.save_layouts, each file checked
against the revision it was planned from); the owner and monitor changes commit right after, and if that commit fails
the files are put back.
"""
import json
import logging
import time
import unicodedata

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import inventory_store
from ..config import get_settings
from ..confirm import SHARED_BY
from ..database import get_db
from ..models import AssetOwner, Device, PingTarget
from . import devices

router = APIRouter(prefix="/api/removed-servers", tags=["removed servers"])
log = logging.getLogger(__name__)

STORE_NAME = "removed_servers.json"
EMPTY = {"servers": {}, "log": []}
LOG_KEEP = 200
MAX_REASON = 300
MAX_NAME = 200

NOT_A_SERVER = "{} is not a server name."
UNKNOWN = "No server named {} is in the lab."
ALREADY = "{} is already removed. Restore it from Admin → Removed servers."
NOT_REMOVED = "This server is not in the removed list any more. Reload the list."
PLAN_CHANGED = "The server or the rack layout changed since the preview. Nothing was removed; preview again."
RELOAD = "Reload the removed servers list before saving."
STALE = "The removed servers list was changed in another session. Reload and try again."
UNREADABLE = "The removed servers list cannot be read, so nothing was changed."
NOT_SAVED = "The change could not be saved. Nothing was changed; please retry."


def store_path():
    # Read at call time: tests point devices._BACKEND_DIR at a temporary folder.
    return devices._BACKEND_DIR / STORE_NAME


def read_store(strict=False):
    """The removed servers document. A missing file is empty; an unreadable one is empty for hiding (fail open: the
    servers show) but stops every write, so it is never overwritten."""
    try:
        data = json.loads(store_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"servers": {}, "log": []}
    except (OSError, ValueError) as exc:
        if strict:
            raise HTTPException(503, UNREADABLE) from exc
        return {"servers": {}, "log": []}
    if not isinstance(data, dict) or not isinstance(data.get("servers"), dict) or not isinstance(data.get("log", []), list):
        if strict:
            raise HTTPException(503, UNREADABLE)
        return {"servers": {}, "log": []}
    return data


def _revision_on_disk():
    return inventory_store.revision(inventory_store.read_layout(store_path(), EMPTY))


def _port_id(device_id, port):
    return f"{device_id}:{devices._number_key(port)}"


def _records(store):
    return [r for r in store["servers"].values() if isinstance(r, dict) and isinstance(r.get("key"), str)]


def ports_by_key(port_labels: dict) -> dict:
    """identity key -> {"device_id:port"} from {device_id: {port: label}}."""
    ports = {}
    for dev_id, labels in port_labels.items():
        for port, label in (labels or {}).items():
            key = devices._key_of(label)
            if key:
                ports.setdefault(key, set()).add(_port_id(dev_id, port))
    return ports


async def current_ports(db) -> dict:
    """identity key -> {"device_id:port"} for every PDU/KVM port whose saved label, or the name the device itself
    reported (status cache only, never a device contact), names a server."""
    ports = {}
    for dev in (await db.execute(select(Device))).scalars().all():
        if dev.kind not in devices._PORT_KINDS:
            continue
        for labels in (devices._saved_labels(dev)[0], devices._live_labels(dev)):
            for key, ids in ports_by_key({dev.id: labels}).items():
                ports.setdefault(key, set()).update(ids)
    return ports


def is_hiding(record, ports_now) -> bool:
    """True while the record hides its server: no port outside the ones recorded at removal carries the name."""
    recorded = set(record.get("ports_ids") or ())
    return set(ports_now.get(record.get("key"), ())) <= recorded


async def hidden_keys(db, store=None) -> set:
    """The identity keys every page hides now (see the key rule in the module docstring)."""
    records = _records(read_store() if store is None else store)
    if not records:
        return set()
    ports_now = await current_ports(db)
    return {r["key"] for r in records if is_hiding(r, ports_now)}


def hidden_for_labels(port_labels: dict) -> set:
    """hidden_keys for code without a database session: the ports are the labels the caller shows
    ({device_id: {port: label}}). Used by devices._dcim_units so the backend numbers rack U slots as the pages do."""
    records = _records(read_store())
    if not records:
        return set()
    ports_now = ports_by_key(port_labels)
    return {r["key"] for r in records if is_hiding(r, ports_now)}


def _who(request: Request) -> str:
    current = getattr(request.state, "account", None)
    return (current or {}).get("user", {}).get("username") or SHARED_BY


def _is_admin(request: Request) -> bool:
    if not get_settings().accounts_enabled:
        return True
    current = getattr(request.state, "account", None)
    return (current or {}).get("user", {}).get("role") == "Admin"


def _clean_reason(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise HTTPException(400, "reason must be text")
    text = " ".join("".join(" " if unicodedata.category(c).startswith("C") else c for c in value).split())
    if len(text) > MAX_REASON:
        raise HTTPException(400, f"The reason is at most {MAX_REASON} characters.")
    return text


def _require_if_match(if_match):
    if not if_match:
        raise HTTPException(428, RELOAD)


def _public(record, ports_now, admin):
    out = {"key": record.get("key"), "name": record.get("name"), "removed_at": record.get("removed_at"),
           "ports": record.get("ports") or [], "cleaned": record.get("cleaned") or {},
           "monitor_paused": bool(record.get("monitor")), "active": is_hiding(record, ports_now)}
    recorded = set(record.get("ports_ids") or ())
    out["new_ports"] = sorted(set(ports_now.get(record.get("key"), ())) - recorded)
    if admin:
        out["removed_by"] = record.get("removed_by") or ""
        out["reason"] = record.get("reason") or ""
    return out


@router.get("")
async def list_removed(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    """Every signed-in role (each page hides these servers): {servers: [{key, name, removed_at, ports, cleaned,
    monitor_paused, active, new_ports[, removed_by, reason]}], hidden: [keys hidden now][, log]}. Who removed a
    server, the reason and the log are Admin only. ETag = the revision to send as If-Match with remove / restore."""
    data = inventory_store.read_layout(store_path(), EMPTY)
    response.headers["ETag"] = inventory_store.revision(data)
    response.headers["Cache-Control"] = "no-store"
    store = read_store()
    ports_now = await current_ports(db)
    admin = _is_admin(request)
    records = _records(store)
    servers = sorted((_public(r, ports_now, admin) for r in records), key=lambda r: -(r["removed_at"] or 0))
    body = {"servers": servers, "hidden": sorted(r["key"] for r in servers if r["active"])}
    if admin:
        body["log"] = [e for e in reversed(store.get("log") or []) if isinstance(e, dict)][:50]
    return body


async def _plan(db, name):
    """What removing the server named `name` does, computed without writing: (plan, layouts, after_layouts, owners,
    target). Raises 400 for a name that is no server and 404 for a server the lab does not know."""
    identity = devices._identity(name)
    if not identity:
        raise HTTPException(400, NOT_A_SERVER.format(name))
    key = identity[0]
    all_devices = sorted((await db.execute(select(Device))).scalars().all(), key=devices._device_order)
    port_devices = [d for d in all_devices if d.kind in devices._PORT_KINDS]
    shown = {d.id: devices._effective_labels(d, devices._saved_labels(d)[0]) for d in port_devices}
    layouts, _ = devices._read_layouts(strict=True)
    index = devices._layout_ids(layouts)
    servers = devices._all_servers(port_devices, shown, layouts, await devices._monitor_names(db))
    target = await db.scalar(select(PingTarget).where(PingTarget.source_key == "server:" + key))
    from ..engineers import owner_map
    owners_now = await owner_map(db)
    owner_keys = sorted(k for k in owners_now if not k.startswith("item:") and devices._key_of(k) == key)
    if key not in servers and not owner_keys and target is None:
        raise HTTPException(404, UNKNOWN.format(name))
    server = servers.get(key, {"name": identity[1], "ports": []})

    # Every port that names it now (saved labels and what the devices reported), as the hiding rule counts them.
    ports_ids = sorted((await current_ports(db)).get(key, set()))
    ports = []
    for dev in port_devices:
        labels = {**devices._live_labels(dev), **devices._saved_labels(dev)[0]}
        for port in sorted(labels, key=devices._port_order):
            if devices._key_of(labels[port]) == key:
                ports.append({"device_id": dev.id, "device_name": dev.name, "kind": dev.kind, "port": str(port),
                              "label": labels[port]})

    ids = index.get(key, set())
    position = devices._position(server, ids, layouts) if key in servers else {"rack": None, "slot": None}
    after = {fname: _without_ids(fname, data, ids) for fname, data in layouts.items()}

    # The DCIM rack view gives a server without a saved U the next free U: freeing this server's U could move the
    # servers below it. Where any other server's U would change, the automatic U numbers of that rack are pinned.
    shown_after = {dev_id: {p: l for p, l in labels.items() if devices._key_of(l) != key} for dev_id, labels in shown.items()}
    units = devices._dcim_units(port_devices, shown, layouts)
    units_after = devices._dcim_units(port_devices, shown_after, after)
    pins = []
    for rack, entries in sorted(units.items()):
        rest = {k: v for k, v in entries.items() if devices._key_of(k) != key}
        moved = any(units_after.get(rack, {}).get(k, (None,))[0] != u for k, (u, _) in rest.items())
        if not moved:
            continue
        slots = after["rack_slots.json"].setdefault(rack, {})
        if not isinstance(slots, dict):
            continue
        for sid, (u, automatic) in sorted(rest.items()):
            if automatic and slots.get(sid) is None:
                slots[sid] = u
                pins.append({"rack": rack, "id": sid, "slot": u})

    layout = []
    for fname in devices._LAYOUT_FILES:
        data = layouts[fname]
        for rk, value in sorted(data.items(), key=lambda item: str(item[0])):
            if fname == "rack_slots.json" and isinstance(value, dict):
                layout += [{"file": fname, "rack": rk, "id": sid, "slot": devices._slot_value(u)}
                           for sid, u in sorted(value.items()) if sid in ids]
            elif fname == "rack_positions.json" and isinstance(value, list):
                layout += [{"file": fname, "rack": rk, "id": sid} for sid in sorted({v for v in value if v in ids})]
            elif fname in ("rack_overrides.json", "switch_assignments.json") and rk in ids:
                layout.append({"file": fname, "rack": value if fname == "rack_overrides.json" and isinstance(value, str)
                               else None, "id": rk})

    # Equipment units on its shelf stay in the rack (they are never deleted); the preview names them.
    units_kept = []
    if position["rack"] is not None and position["slot"] is not None:
        try:
            rack_items = inventory_store.read_items().get(position["rack"], [])
        except HTTPException:
            rack_items = []   # informational only: an unreadable inventory is not touched by a removal
        for item in rack_items:
            if devices._slot_value(item.get("u")) == position["slot"]:
                units_kept.append({"id": item["id"], "name": str(item.get("name") or item["id"])})

    owner = {"keys": owner_keys, "name": owners_now[owner_keys[0]]} if owner_keys else None
    monitor = ({"id": target.id, "name": target.name, "host": target.host, "enabled": bool(target.enabled)}
               if target is not None else None)
    plan = {"key": key, "name": server["name"], "ports": ports, "ports_ids": ports_ids, "position": position,
            "layout": layout, "pins": pins, "owner": owner, "monitor": monitor, "units_kept": units_kept}
    plan["plan_revision"] = inventory_store.revision(plan)
    return plan, layouts, after, target


def _without_ids(fname, data, ids):
    """A copy of one layout file without the entries of `ids` (shapes as devices._renamed_ids reads them)."""
    if not isinstance(data, dict):
        return data
    if fname == "rack_positions.json":
        return {rack: [s for s in v if s not in ids] if isinstance(v, list) else v for rack, v in data.items()}
    if fname == "rack_slots.json":
        return {rack: {k: u for k, u in v.items() if k not in ids} if isinstance(v, dict) else v for rack, v in data.items()}
    return {k: v for k, v in data.items() if k not in ids}


def _log_entry(store, action, record, by, reason=""):
    entries = [e for e in store.get("log") or [] if isinstance(e, dict)]
    entries.append({"at": time.time(), "action": action, "key": record["key"], "name": record["name"], "by": by,
                    "reason": reason})
    store["log"] = entries[-LOG_KEEP:]


def _layout_entries(layouts, after):
    """save_layouts entries for the layout files a removal changes, each checked against what the plan read."""
    entries = []
    for fname in devices._LAYOUT_FILES:
        if after[fname] != layouts[fname]:
            path = devices._BACKEND_DIR / fname
            # The plan read the file strictly: a missing file was {} and reads as {} again (read_layout's default).
            entries.append((fname, path, after[fname], inventory_store.revision(layouts[fname]), {}))
    return entries


async def _commit_or_put_back(db, written):
    """Commit the owner / monitor changes; if that fails, put the files written just before back."""
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        try:
            inventory_store.save_layouts([(name, path, before, revision, default)
                                          for name, path, before, revision, default in written])
        except Exception:
            log.exception("Removed servers: files could not be put back after a failed database commit")
        raise HTTPException(503, NOT_SAVED) from exc


@router.post("")
async def remove_server(body: dict, request: Request, response: Response, db: AsyncSession = Depends(get_db),
                        if_match: str | None = Header(default=None)):
    """Admin. Body {name, reason?, dry_run?, plan_revision?}: `name` is any label of the server ("OPTN44 (PSU1)" removes
    optn44). dry_run returns the plan: ports that name it (left as they are), layout entries that are cleaned, other
    servers' U numbers that are pinned, owner, monitor (paused), equipment units that stay, and a plan_revision. Apply
    needs If-Match (the ETag of GET /api/removed-servers). Returns the record and the new ETag."""
    raw, dry_run, expected_plan = body.get("name"), body.get("dry_run", False), body.get("plan_revision")
    if not isinstance(raw, str) or not raw.strip():
        raise HTTPException(400, "name is required")
    name = raw.strip()
    if len(name) > MAX_NAME:
        raise HTTPException(400, f"Server names are at most {MAX_NAME} characters.")
    if not isinstance(dry_run, bool):
        raise HTTPException(400, "dry_run must be true or false")
    if expected_plan is not None and not isinstance(expected_plan, str):
        raise HTTPException(400, "plan_revision must be the token from the preview")
    reason = _clean_reason(body.get("reason"))
    async with devices._labels_lock:   # labels cannot change between the plan and the write
        plan, layouts, after, target = await _plan(db, name)
        store = read_store(strict=True)
        existing = store["servers"].get(plan["key"])
        if isinstance(existing, dict) and is_hiding(existing, await current_ports(db)):
            raise HTTPException(409, ALREADY.format(existing.get("name") or plan["name"]))
        public_plan = {k: v for k, v in plan.items() if k != "ports_ids"}
        if dry_run:
            response.headers["Cache-Control"] = "no-store"
            return {"ok": True, "dry_run": True, **public_plan}
        _require_if_match(if_match)
        if if_match != _revision_on_disk():
            raise HTTPException(409, STALE)
        if expected_plan is not None and expected_plan != plan["plan_revision"]:
            raise HTTPException(409, PLAN_CHANGED)

        by = _who(request)
        record = {"key": plan["key"], "name": plan["name"], "removed_at": time.time(), "removed_by": by,
                  "reason": reason, "ports": [{k: p[k] for k in ("device_id", "device_name", "kind", "port", "label")}
                                              for p in plan["ports"]],
                  "ports_ids": plan["ports_ids"], "position": plan["position"],
                  "cleaned": {"layout": len(plan["layout"]), "pinned": len(plan["pins"]),
                              "owner": plan["owner"]["name"] if plan["owner"] else None},
                  "monitor": None}
        # Owner: a tombstone per key, so the legacy owners file cannot bring the owner back.
        for asset in (plan["owner"] or {}).get("keys", []):
            assignment = await db.get(AssetOwner, asset)
            if assignment is None:
                assignment = AssetOwner(asset_key=asset)
                db.add(assignment)
            assignment.engineer_id, assignment.legacy_name = None, ""
        # Monitor: paused (history kept); restore resumes it only when it was running.
        if target is not None:
            # Removed again after its name came back on another port: the monitor that removal paused still counts
            # as running, so a restore resumes it.
            earlier = (existing or {}).get("monitor") if isinstance(existing, dict) else None
            paused_by_us = isinstance(earlier, dict) and earlier.get("id") == target.id and earlier.get("was_enabled")
            record["monitor"] = {"id": target.id, "was_enabled": bool(target.enabled or paused_by_us)}
            if target.enabled:
                from ..ping_monitor import close_incident
                target.enabled = False
                target.revision += 1   # a probe still in flight is ignored
                await close_incident(db, target.id, time.time(), "server removed")
        await db.flush()

        new_store = {"servers": {**store["servers"], plan["key"]: record}, "log": list(store.get("log") or [])}
        _log_entry(new_store, "removed", record, by, reason)
        entries = [("removed_servers", store_path(), new_store, if_match, EMPTY)] + _layout_entries(layouts, after)
        try:
            revisions = inventory_store.save_layouts(entries)
        except BaseException:
            await db.rollback()
            raise
        written = [(n, p, store if n == "removed_servers" else layouts[n], revisions[n], d) for n, p, _, _, d in entries]
        await _commit_or_put_back(db, written)
    log.info("Server %s removed from the lab by %s", plan["key"], by)
    response.headers["ETag"] = revisions["removed_servers"]
    ports_now = await current_ports(db)
    return {"ok": True, "removed": _public(record, ports_now, True), "revision": revisions["removed_servers"],
            "layout_revisions": {n: r for n, r in revisions.items() if n != "removed_servers"}}


@router.post("/{key}/restore")
async def restore_server(key: str, request: Request, response: Response, db: AsyncSession = Depends(get_db),
                         if_match: str | None = Header(default=None)):
    """Admin. If-Match = the ETag of GET /api/removed-servers. The server shows again from its PDU label; the cleaned
    rack position, switch and owner are not brought back. Its ping monitor resumes when it was running at removal."""
    _require_if_match(if_match)
    store = read_store(strict=True)
    if if_match != _revision_on_disk():
        raise HTTPException(409, STALE)
    record = store["servers"].get(key)
    if not isinstance(record, dict):
        raise HTTPException(404, NOT_REMOVED)
    by = _who(request)
    resumed = False
    monitor = record.get("monitor") or {}
    if monitor.get("was_enabled") and isinstance(monitor.get("id"), str):
        target = await db.get(PingTarget, monitor["id"])
        if target is not None and not target.enabled and target.source_key == "server:" + key:
            target.enabled = True
            target.revision += 1
            resumed = True
    await db.flush()
    new_store = {"servers": {k: v for k, v in store["servers"].items() if k != key}, "log": list(store.get("log") or [])}
    _log_entry(new_store, "restored", {"key": key, "name": record.get("name") or key}, by)
    try:
        revisions = inventory_store.save_layouts([("removed_servers", store_path(), new_store, if_match, EMPTY)])
    except BaseException:
        await db.rollback()
        raise
    await _commit_or_put_back(db, [("removed_servers", store_path(), store, revisions["removed_servers"], EMPTY)])
    log.info("Server %s restored to the lab by %s", key, by)
    response.headers["ETag"] = revisions["removed_servers"]
    return {"ok": True, "key": key, "name": record.get("name") or key, "monitor_resumed": resumed,
            "revision": revisions["removed_servers"]}
