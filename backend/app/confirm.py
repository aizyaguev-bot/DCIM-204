"""Server-side password re-confirmation for hardware-affecting actions: body parsing, throttle and verification."""
import asyncio
import hashlib
import re
import secrets
import time
from typing import Awaitable, Callable, Literal

from fastapi import HTTPException, Request
from sqlalchemy import case, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from . import accounts
from .models import AuthThrottle, User

SHARED_BY = "shared-password"
MAX_PASSWORD = 256
MAX_REASON = 200
FAILURE_LIMIT = 10
FAILURE_WINDOW = 300
CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# One password check at a time, so a pending attempt never counts toward another request's limit.
confirm_lock = asyncio.Lock()


def password_mode(settings) -> str:
    if settings.accounts_enabled: return "account"
    if settings.lab_manager_password: return "shared"
    return "unavailable"


def require_password_mode(settings, detail: str = "Maintenance actions require a configured password"):
    if password_mode(settings) == "unavailable":
        raise HTTPException(403, detail)


async def read_body(request: Request, reason: Literal["none", "optional", "required"] = "none") -> tuple[str, str, dict]:
    # Parsed by hand: a pydantic 422 body would echo the submitted password.
    try: body = await request.json()
    except ValueError: body = None
    if not isinstance(body, dict): raise HTTPException(400, "Invalid request body")
    password = body.get("password")
    if not isinstance(password, str) or not password: raise HTTPException(400, "Password is required")
    if len(password) > MAX_PASSWORD: raise HTTPException(400, "Password is too long")
    text = ""
    if reason != "none":
        raw = body.get("reason") if isinstance(body.get("reason"), str) else ""
        if CONTROL.search(raw): raise HTTPException(400, "Reason contains unsupported characters")
        text = raw.strip()
        low = 1 if reason == "required" else 0
        if not low <= len(text) <= MAX_REASON:
            raise HTTPException(400, f"Reason is required (1–{MAX_REASON} characters)" if low else
                                f"Reason is too long (at most {MAX_REASON} characters)")
    return password, text, {k: v for k, v in body.items() if k != "password"}


async def refund_attempt(db: AsyncSession, digest: str):
    await db.execute(update(AuthThrottle).where(AuthThrottle.key == digest, AuthThrottle.attempts > 0)
                     .values(attempts=AuthThrottle.attempts - 1))
    await db.commit()


async def reserve_attempt(db: AsyncSession, key: str) -> str:
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
        await refund_attempt(db, digest)
        raise HTTPException(429, "Too many attempts. Try again in five minutes.", headers={"Retry-After": "300"})
    return digest


async def verify(request: Request, db: AsyncSession, password: str, settings, lock: asyncio.Lock,
                 on_denied: Callable[[str], Awaitable[None]]) -> str:
    """Verifies the re-entered password and returns the audit name; denials go to on_denied, never the password."""
    async with lock:
        if password_mode(settings) == "account":
            current = accounts.account(request)
            by = current["user"]["username"]
            # ":" cannot occur in usernames, so these keys never collide with login throttle keys.
            digest = await reserve_attempt(db, "maint:user:" + by)
            user = await db.get(User, current["user"]["id"])
            valid = bool(user) and await asyncio.to_thread(accounts.verify_password, password, user.password_hash)
        else:
            by = SHARED_BY
            digest = await reserve_attempt(db, "maint:client:" + (request.client.host if request.client else "unknown"))
            valid = secrets.compare_digest(password.encode(), settings.lab_manager_password.encode())
        if not valid:
            await on_denied(by)
            await db.commit()
            raise HTTPException(403, "Password is incorrect")
        await refund_attempt(db, digest)
    return by
