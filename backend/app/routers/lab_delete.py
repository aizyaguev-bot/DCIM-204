"""Delete and restore for every lab item (v2 spec section D): POST /api/lab/delete, GET /api/lab/deleted,
POST /api/lab/restore and DELETE /api/lab/deleted/{batch_id}. The planner and the Deleted list are app/lab_trash.py.

Roles (accounts.required_role): every /api/lab/* call needs an Operator, DELETE (Delete forever) an Admin. The handlers
also require an Admin when any target or restore entry is a server, PDU/KVM, rack or cooling unit (403: "Only an Admin
can delete servers, PDUs, KVMs, racks and cooling units."); Operators delete and restore units and 3D-only records,
except an entry that also brings back what an Admin deleted with it (a computer unit's only-pinged server: 403, and the
Deleted list shows it to Operators as not restorable, lab_trash.admin_only).
Without accounts everybody counts as Admin (removed_servers._is_admin).

POST /api/lab/delete {targets: [{kind, id}], options?, reason?, dry_run?, plan_revision?}
  A server removed earlier (Remove from lab) is deleted too: the names it still holds are freed, its 3D records go, and
  it stays removed with its monitor paused (lab_trash.Delete.delete_removed); with nothing left to delete it is blocked.
  dry_run: the plan {plan_revision, targets, items: [{kind, id, name, evidence: [text], info: [text]}], consequences:
  {devices_deleted, servers_deleted, servers_kept, servers_lose_port, ports_freed, units_moved, units_deleted,
  cooling_unassigned, monitors_paused, alerts_closed, twin_deleted, twin_unplaced, setups_unmapped, layout, owners,
  shared_kept, notes} (each a list of {key, text, ...}), blockers: [{kind, id, code, text}], screens: [text], options};
  it writes nothing and counts no change. Apply needs the plan_revision (428 without it, 409 when the plan changed) and no
  blockers (409, the first one's text). Locks, always in this order: devices._labels_lock, then the maintenance lock of
  each PDU whose outlets change or that is deleted (by id), then (restore of devices only) devices._address_lock. The
  database part is flushed, every file is written in one step (inventory_store.save_layouts_with_items), then the
  database commits; when that commit fails the files are put back. Freed names go to the devices after the commit.
  Answers {ok, batch: {id, at, entries: [{kind, id, name}]}, ...the plan, deleted_etag, device_names...}.
GET /api/lab/deleted -> {batches: [{id, at, by?, reason?, entries: [{kind, id, name, restorable, why_not,
  restored_at}]}]} with an ETag (the If-Match of a restore). Who and why are Admin only; snapshots never leave the server.
POST /api/lab/restore {batch, entries?: [{kind, id}], dry_run?, plan_revision?} + If-Match on apply (428 / 409 stale):
  the restore plan {plan_revision, batch, items, consequences: {devices_restored, servers_restored, ports_restored,
  ports_not_restored, units_restored, units_to_storage, cooling_restored, monitors_resumed, twin_restored, layout, owners,
  notes}, blockers} or its apply ({ok, ...plan, deleted_etag}). entries left out: every entry not restored yet.
DELETE /api/lab/deleted/{batch_id} (Admin): Delete forever (the batch's snapshots, encrypted credentials included).
Change feed (changes.RULES): delete and restore bump devices, layout, inventory, owners, removed, monitoring, twin and
power; the Deleted list's own writes bump removed; dry runs bump nothing.
"""
from contextlib import AsyncExitStack

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from .. import changes as change_feed, lab_trash
from ..database import get_db
from ..pdu_locks import maintenance_lock
from . import devices, removed_servers

router = APIRouter(prefix="/api/lab", tags=["lab delete"])


def _flag(body, name, default=False):
    value = body.get(name, default)
    if not isinstance(value, bool):
        raise HTTPException(400, f"{name} must be true or false")
    return value


def _options(raw):
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise HTTPException(400, "options must be an object")
    out = {}
    for name, default in lab_trash.OPTIONS.items():
        if name not in raw:
            continue
        value = raw[name]
        if name == "rack_units":
            if value not in ("storage", "delete"):
                raise HTTPException(400, 'rack_units is "storage" or "delete"')
        elif not isinstance(value, bool):
            raise HTTPException(400, f"{name} must be true or false")
        out[name] = value
    return out


def _revision(body):
    value = body.get("plan_revision")
    if value is not None and not isinstance(value, str):
        raise HTTPException(400, "plan_revision must be the token from the preview")
    return value


async def _locked(stack, pdu_ids, address=False):
    """The maintenance lock of each PDU in id order, then (for a restore that adds devices) the address lock; the
    caller already holds devices._labels_lock (the lock order every writer keeps: labels, maintenance, address)."""
    for device_id in sorted(set(pdu_ids)):
        await stack.enter_async_context(maintenance_lock(device_id))
    if address:
        await stack.enter_async_context(devices._address_lock)


@router.post("/delete")
async def delete_items(body: dict, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    """Preview (dry_run) or apply a delete of one item or many (see the module docstring)."""
    targets = body.get("targets")
    options = _options(body.get("options"))
    dry_run = _flag(body, "dry_run")
    expected = _revision(body)
    reason = removed_servers._clean_reason(body.get("reason"))
    admin = removed_servers._is_admin(request)
    if isinstance(targets, list) and any(isinstance(t, dict) and t.get("kind") in lab_trash.ADMIN_KINDS for t in targets) \
            and not admin:
        raise HTTPException(403, lab_trash.ADMIN_ONLY)
    who = removed_servers._who(request)
    response.headers["Cache-Control"] = "no-store"
    async with devices._labels_lock:
        plan = await (await lab_trash.Delete(targets, options, admin, who, reason).build(db)).titles(db)
        if dry_run:
            change_feed.unchanged()   # a preview writes nothing: open pages need not reload
            return {"ok": True, "dry_run": True, **plan.public()}
        if not expected:
            raise HTTPException(428, lab_trash.NEEDS_PREVIEW)
        async with AsyncExitStack() as stack:
            await _locked(stack, plan.affected_pdus())
            plan = await (await lab_trash.Delete(targets, options, admin, who, reason).build(db)).titles(db)
            public = plan.public()
            if public["plan_revision"] != expected:
                raise HTTPException(409, lab_trash.PLAN_CHANGED)
            if public["blockers"]:
                raise HTTPException(409, public["blockers"][0]["text"])
            batch, revisions, names = await plan.apply(db)
    response.headers["ETag"] = revisions["deleted"]
    return {"ok": True, "dry_run": False, **public, **names, "deleted_etag": revisions["deleted"],
            "batch": {"id": batch["id"], "at": batch["at"],
                      "entries": [{"kind": e["kind"], "id": e["id"], "name": e["name"]} for e in batch["entries"]]}}


@router.get("/deleted")
async def list_deleted(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    """The Deleted list (Operator), newest first, with the ETag a restore sends as If-Match."""
    response.headers["ETag"] = lab_trash.store_revision()
    response.headers["Cache-Control"] = "no-store"
    return await lab_trash.listing(db, removed_servers._is_admin(request))


@router.post("/restore")
async def restore_items(body: dict, request: Request, response: Response, db: AsyncSession = Depends(get_db),
                        if_match: str | None = Header(default=None)):
    """Preview (dry_run) or apply restoring a batch, or some of its entries (see the module docstring)."""
    batch = body.get("batch")
    if not isinstance(batch, str) or not batch or len(batch) > 64:
        raise HTTPException(400, "batch is the id of an entry of the Deleted list")
    selection = body.get("entries")
    dry_run = _flag(body, "dry_run")
    expected = _revision(body)
    admin = removed_servers._is_admin(request)
    who = removed_servers._who(request)
    response.headers["Cache-Control"] = "no-store"
    async with devices._labels_lock:
        plan = await lab_trash.Restore(batch, selection, admin, who).build(db)
        if dry_run:
            change_feed.unchanged()
            return {"ok": True, "dry_run": True, **plan.public()}
        if not if_match:
            raise HTTPException(428, lab_trash.RELOAD)
        if if_match != lab_trash.store_revision():
            raise HTTPException(409, lab_trash.STALE)
        if not expected:
            raise HTTPException(428, lab_trash.NEEDS_PREVIEW)
        async with AsyncExitStack() as stack:
            await _locked(stack, plan.affected_pdus(), address=bool(plan.added))
            plan = await lab_trash.Restore(batch, selection, admin, who).build(db)
            public = plan.public()
            if public["plan_revision"] != expected:
                raise HTTPException(409, lab_trash.PLAN_CHANGED)
            if public["blockers"]:
                raise HTTPException(409, public["blockers"][0]["text"])
            revisions, names = await plan.apply(db)
    response.headers["ETag"] = revisions["deleted"]
    return {"ok": True, "dry_run": False, **public, **names, "deleted_etag": revisions["deleted"]}


@router.delete("/deleted/{batch_id}")
async def forget(batch_id: str, response: Response):
    """Delete forever (Admin): the batch and its snapshots leave the Deleted list; it cannot be restored any more."""
    response.headers["ETag"] = lab_trash.forget_batch(batch_id)
    return {"ok": True}
