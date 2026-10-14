"""PDU maintenance: switch off every powered outlet after server-side password re-confirmation."""
import asyncio, hashlib, json, re, secrets, time

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import case, delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import accounts
from ..config import get_settings
from ..database import get_db
from ..models import AuthThrottle, PduMaintenance, PduMaintenanceLog, User
from . import pdus

router = APIRouter(prefix="/api/pdus", tags=["pdu-maintenance"])

SHARED_BY = "shared-password"
MAX_PASSWORD = 256
MAX_REASON = 200
LOG_LIMIT = 50
LOG_KEEP = 500
FAILURE_LIMIT = 10
FAILURE_WINDOW = 300
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# One password check at a time, so a pending attempt never counts toward another request's limit.
_confirm_lock = asyncio.Lock()


def password_mode() -> str:
    settings = get_settings()
    if settings.accounts_enabled: return "account"
    if settings.lab_manager_password: return "shared"
    return "unavailable"


def _state(row: PduMaintenance) -> dict:
    return {"device_id": row.device_id, "started_at": row.started_at, "started_by": row.started_by, "reason": row.reason,
            "outlets_off": json.loads(row.outlets_off_json or "[]"), "failed": json.loads(row.failed_json or "[]")}


def _entry(row: PduMaintenanceLog) -> dict:
    return {"at": row.at, "device_id": row.device_id, "action": row.action, "by": row.by, "reason": row.reason,
            "ok": row.ok, "failed": row.failed}


async def _log(db: AsyncSession, device_id: str, action: str, by: str, reason: str) -> PduMaintenanceLog:
    """Adds an audit entry to the caller's transaction and keeps only the newest LOG_KEEP rows."""
    entry = PduMaintenanceLog(at=time.time(), device_id=device_id, action=action, by=by, reason=reason, ok=0, failed=0)
    db.add(entry)
    await db.flush()
    cutoff = select(PduMaintenanceLog.id).order_by(PduMaintenanceLog.id.desc()).offset(LOG_KEEP - 1).limit(1).scalar_subquery()
    await db.execute(delete(PduMaintenanceLog).where(PduMaintenanceLog.id < cutoff).execution_options(synchronize_session=False))
    return entry


async def _read_body(request: Request, need_reason: bool) -> tuple[str, str]:
    # Parsed by hand: a pydantic 422 body would echo the submitted password.
    try: body = await request.json()
    except ValueError: body = None
    if not isinstance(body, dict): raise HTTPException(400, "Invalid request body")
    password = body.get("password")
    if not isinstance(password, str) or not password: raise HTTPException(400, "Password is required")
    if len(password) > MAX_PASSWORD: raise HTTPException(400, "Password is too long")
    reason = ""
    if need_reason:
        raw = body.get("reason") if isinstance(body.get("reason"), str) else ""
        if _CONTROL.search(raw): raise HTTPException(400, "Reason contains unsupported characters")
        reason = raw.strip()
        if not 1 <= len(reason) <= MAX_REASON: raise HTTPException(400, f"Reason is required (1–{MAX_REASON} characters)")
    return password, reason


def _require_password_mode():
    if password_mode() == "unavailable":
        raise HTTPException(403, "Maintenance actions require a configured password")


async def _refund_attempt(db: AsyncSession, digest: str):
    await db.execute(update(AuthThrottle).where(AuthThrottle.key == digest, AuthThrottle.attempts > 0)
                     .values(attempts=AuthThrottle.attempts - 1))
    await db.commit()


async def _reserve_attempt(db: AsyncSession, key: str) -> str:
    """Counts an attempt in a maintenance-only throttle namespace; refunded unless the password turns out wrong."""
    now = time.time()
    digest = hashlib.sha256(key.encode()).hexdigest()
    expired = AuthThrottle.window_at < now - FAILURE_WINDOW
    statement = update(AuthThrottle).where(AuthThrottle.key == digest).values(
        attempts=case((expired, 1), else_=AuthThrottle.attempts + 1),
        window_at=case((expired, now), else_=AuthThrottle.window_at)).returning(AuthThrottle.attempts)
    attempts = (await db.execute(statement)).scalar_one_or_none()
    if attempts is None:
        db.add(AuthThrottle(key=digest, attempts=1, window_at=now))
        try:
            await db.commit()
            attempts = 1
        except IntegrityError:
            await db.rollback()
            attempts = (await db.execute(statement)).scalar_one()
    await db.commit()
    if attempts > FAILURE_LIMIT:
        await _refund_attempt(db, digest)
        raise HTTPException(429, "Too many attempts. Try again in five minutes.", headers={"Retry-After": "300"})
    return digest


async def _confirm(request: Request, db: AsyncSession, device_id: str, password: str, attempted: str) -> str:
    """Verifies the re-entered password and returns the audit name; denials are logged, never the password."""
    async with _confirm_lock:
        if password_mode() == "account":
            current = accounts.account(request)
            by = current["user"]["username"]
            # ":" cannot occur in usernames, so these keys never collide with login throttle keys.
            digest = await _reserve_attempt(db, "maint:user:" + by)
            user = await db.get(User, current["user"]["id"])
            valid = bool(user) and await asyncio.to_thread(accounts.verify_password, password, user.password_hash)
        else:
            by = SHARED_BY
            digest = await _reserve_attempt(db, "maint:client:" + (request.client.host if request.client else "unknown"))
            valid = secrets.compare_digest(password.encode(), get_settings().lab_manager_password.encode())
        if not valid:
            await _log(db, device_id, "denied", by, attempted)
            await db.commit()
            raise HTTPException(403, "Password is incorrect")
        await _refund_attempt(db, digest)
    return by


async def _switch(dev, numbers: list[int], action: str) -> list[tuple[int, bool]]:
    if not numbers: return []
    username, password = pdus.get_creds(dev)
    driver = pdus.RaritanPduDriver(dev.ip, username, password)
    results = []
    try:
        for number in numbers:
            try: ok = bool(await driver.set_outlet_state(number, action))
            except Exception: ok = False
            results.append((number, ok))
    finally:
        await driver.close()
    return results


async def _not_in_state(device_id: str, dev, expected: str, targets=()) -> set[int] | None:
    """Live re-read after switching: outlets seen in another state plus targets missing from the read,
    or None when the PDU cannot be read."""
    status = await pdus._fetch_status(device_id, dev)
    if not status.reachable: return None
    seen = {o.number for o in status.outlets}
    return {o.number for o in status.outlets if o.state != expected} | (set(targets) - seen)


@router.get("/maintenance")
async def maintenance_list(db: AsyncSession = Depends(get_db)):
    rows = (await db.scalars(select(PduMaintenance))).all()
    log = (await db.scalars(select(PduMaintenanceLog).order_by(PduMaintenanceLog.id.desc()).limit(LOG_LIMIT))).all()
    return {"password_mode": password_mode(), "pdus": {row.device_id: _state(row) for row in rows},
            "log": [_entry(row) for row in log]}


@router.post("/{device_id}/maintenance/shutdown")
async def maintenance_shutdown(device_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    await pdus._get_pdu_or_404(device_id, db)
    _require_password_mode()
    password, reason = await _read_body(request, need_reason=True)
    async with pdus.locked_pdu(device_id, db) as dev:
        if await db.get(PduMaintenance, device_id, populate_existing=True):
            raise HTTPException(409, "PDU is already in maintenance mode")
        by = await _confirm(request, db, device_id, password, "shutdown")
        status = await pdus._fetch_status(device_id, dev)  # live read, not the status cache
        if not status.reachable: raise HTTPException(502, status.error or "PDU is unreachable")
        if not any(o.state in ("on", "off") for o in status.outlets):
            raise HTTPException(502, "Device API returned no usable outlet states")
        powered = [o.number for o in status.outlets if o.state == "on"]
        # Cycling/unknown outlets may still carry power; they are reported as failed, not switched or restored.
        unknown = [o.number for o in status.outlets if o.state not in ("on", "off")]
        row = PduMaintenance(device_id=device_id, started_at=time.time(), started_by=by, reason=reason,
                             outlets_off_json=json.dumps(powered), failed_json=json.dumps(unknown))
        try:
            db.add(row)
            entry = await _log(db, device_id, "shutdown", by, reason)
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "PDU is already in maintenance mode")
        switched = await _switch(dev, powered, "off")
        still_on = await _not_in_state(device_id, dev, "off", powered)
        pdus._cache.pop(device_id, None)
        # A lost response may still have switched the outlet, so every outlet that was on stays in the restore list.
        if still_on is not None: failed = still_on
        else: failed = {n for n, ok in switched if not ok} | set(unknown)
        row.failed_json = json.dumps(sorted(failed))
        entry.ok, entry.failed = len(set(powered) - failed), len(failed)
        await db.commit()
        results = [{"outlet": n, "ok": n not in failed} for n in sorted(set(powered) | failed)]
        return {"state": _state(row), "results": results}


@router.post("/{device_id}/maintenance/restore")
async def maintenance_restore(device_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    await pdus._get_pdu_or_404(device_id, db)
    _require_password_mode()
    password, _ = await _read_body(request, need_reason=False)
    async with pdus.locked_pdu(device_id, db) as dev:
        row = await db.get(PduMaintenance, device_id, populate_existing=True)
        if not row: raise HTTPException(409, "PDU is not in maintenance mode")
        by = await _confirm(request, db, device_id, password, "restore")
        entry = await _log(db, device_id, "restore", by, row.reason)
        await db.commit()
        targets = json.loads(row.outlets_off_json or "[]")
        await _switch(dev, targets, "on")
        still_off = await _not_in_state(device_id, dev, "on", targets) if targets else set()
        pdus._cache.pop(device_id, None)
        # Without a successful verification read no outlet counts as restored.
        failed = set(targets) if still_off is None else still_off & set(targets)
        entry.ok, entry.failed = len(targets) - len(failed), len(failed)
        if failed:
            # Only the outlets still off remain to restore on the next attempt.
            row.outlets_off_json = row.failed_json = json.dumps(sorted(failed))
            state = _state(row)
        else:
            await db.delete(row)
            state = None
        await db.commit()
        return {"state": state, "results": [{"outlet": n, "ok": n not in failed} for n in targets]}
