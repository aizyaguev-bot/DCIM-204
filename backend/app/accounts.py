"""Optional database-backed accounts; no shared-password bypass in account mode."""
import asyncio
import hashlib
import json
import re
import secrets
import time
import uuid
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, delete, func, select, update
from sqlalchemy.exc import IntegrityError
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse

from .config import get_settings
from .database import AsyncSessionLocal
from .models import AuthThrottle, User, UserSession

router = APIRouter(prefix="/api", tags=["accounts"])
COOKIE = "dcim_session"
DEFAULT_PREFS = {"start_page": "dashboard", "refresh_seconds": 15, "confirm_power": True, "compact_racks": False}
PUBLIC = {"/api/auth/status", "/api/auth/login", "/api/auth/register"}
ROLES = {"Viewer": 0, "Operator": 1, "Admin": 2}


def hash_password(password):
    salt = secrets.token_bytes(16)
    value = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=5, dklen=64, maxmem=64*1024*1024)
    return f"scrypt${salt.hex()}${value.hex()}"


def verify_password(password, encoded):
    try:
        scheme, salt, expected = encoded.split("$")
        if scheme != "scrypt": return False
        value = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=5, dklen=64, maxmem=64*1024*1024)
        return secrets.compare_digest(value.hex(), expected)
    except (ValueError, TypeError):
        return False


def public_user(user):
    try: preferences = {**DEFAULT_PREFS, **json.loads(user.preferences_json)}
    except (ValueError, TypeError): preferences = DEFAULT_PREFS.copy()
    return {key: getattr(user, key) for key in ("id", "username", "name", "email", "role", "enabled", "must_change_password", "created_at", "last_login_at")} | {"preferences": preferences}


async def bootstrap_admin():
    settings = get_settings()
    if not settings.accounts_enabled or not settings.lab_manager_password: return
    async with AsyncSessionLocal() as db:
        if await db.scalar(select(func.count()).select_from(User)): return
        username = settings.accounts_admin_username.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,31}", username):
            raise RuntimeError("ACCOUNTS_ADMIN_USERNAME must be a valid username")
        db.add(User(id="initial-admin", username=username, name="Lab Admin", role="Admin", enabled=True,
                    password_hash=await asyncio.to_thread(hash_password, settings.lab_manager_password), created_at=time.time()))
        try: await db.commit()
        except IntegrityError: await db.rollback()  # another worker initialized it


async def identity(connection):
    token = connection.cookies.get(COOKIE, "")
    if not token or len(token) > 128: return None
    digest = hashlib.sha256(token.encode()).hexdigest()
    async with AsyncSessionLocal() as db:
        row = (await db.execute(select(UserSession, User).join(User, User.id == UserSession.user_id).where(
            UserSession.token_hash == digest, UserSession.expires_at > time.time(), User.enabled.is_(True)
        ))).first()
        if not row: return None
        session, user = row
        return {"user": public_user(user), "csrf_token": session.csrf_token, "session_hash": digest}


def required_role(path, method):
    if (path == "/api/engineers" or path.startswith("/api/engineers/")) and method not in ("GET", "HEAD", "OPTIONS"): return "Admin"
    if path == "/api/users" or path.startswith("/api/users/"): return "Admin"
    if path.startswith("/api/kvms/") and any(part in path for part in ("/proxy", "/autologin", "/console-url", "/viewer")):
        return "Operator"
    if method in ("GET", "HEAD", "OPTIONS"): return "Viewer"
    if path in ("/api/auth/logout", "/api/me", "/api/me/password", "/api/me/preferences"): return "Viewer"
    if path == "/api/devices" or re.fullmatch(r"/api/devices/[^/]+", path):
        if path not in ("/api/devices/rename-opt", "/api/devices/direct-label"): return "Admin"
    return "Operator"


def same_origin(connection):
    origin = connection.headers.get("origin")
    if not origin: return connection.headers.get("sec-fetch-site") != "cross-site"
    expected = urlsplit(str(connection.url))
    supplied = urlsplit(origin)
    return supplied.scheme == expected.scheme and supplied.netloc == expected.netloc


class AccountAccess:
    def __init__(self, app): self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not get_settings().accounts_enabled:
            return await self.app(scope, receive, send)
        path = scope.get("path", "").rstrip("/")
        # Static assets stay public so the sign-in screen can load.
        if not (path.startswith("/api") or path in ("/docs", "/redoc", "/openapi.json")):
            return await self.app(scope, receive, send)
        connection = HTTPConnection(scope)
        method = scope.get("method", "GET")
        unsafe = method not in ("GET", "HEAD", "OPTIONS")

        async def deny(status, detail):
            if scope["type"] == "websocket": await send({"type":"websocket.close", "code":4403 if status == 403 else 4401})
            else: await JSONResponse({"detail":detail}, status_code=status, headers={"Cache-Control":"no-store"})(scope, receive, send)

        if (unsafe or scope["type"] == "websocket") and not same_origin(connection):
            return await deny(403, "Cross-origin action rejected")
        current = await identity(connection)
        scope.setdefault("state", {})["account"] = current
        if path in PUBLIC:
            return await self.app(scope, receive, send)
        if not current: return await deny(401, "Sign in to continue")
        user = current["user"]
        if user["must_change_password"] and path not in ("/api/me", "/api/me/password", "/api/auth/logout"):
            return await deny(403, "Change your temporary password in Account settings first")
        if ROLES[user["role"]] < ROLES[required_role(path, method)]:
            return await deny(403, "Your role does not allow this action")
        if unsafe and not secrets.compare_digest(connection.headers.get("x-dcim-csrf", ""), current["csrf_token"]):
            return await deny(403, "Refresh the page and retry (invalid CSRF token)")
        await self.app(scope, receive, send)


def account(request):
    if not get_settings().accounts_enabled: raise HTTPException(404, "User accounts are not enabled")
    value = getattr(request.state, "account", None)
    if not value: raise HTTPException(401, "Sign in to continue")
    return value


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Credentials(Input):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=256, repr=False)


class Registration(Credentials):
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=256, repr=False)

    @field_validator("username")
    @classmethod
    def username_valid(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,31}", value): raise ValueError("Use 3–32 letters, digits, dots, dashes or underscores")
        return value

    @field_validator("name")
    @classmethod
    def name_valid(cls, value):
        if not value.strip(): raise ValueError("Full name is required")
        return value.strip()


class NewUser(Registration):
    role: Literal["Admin", "Operator", "Viewer"] = "Viewer"


class UserUpdate(Input):
    role: Literal["Admin", "Operator", "Viewer"] | None = None
    enabled: bool | None = None


class Profile(Input):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(default="", max_length=254)

    @field_validator("name")
    @classmethod
    def name_valid(cls, value): return Registration.name_valid(value)

    @field_validator("email")
    @classmethod
    def email_valid(cls, value):
        value = value.strip()
        if value and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value): raise ValueError("Enter a valid email address")
        return value


class PasswordChange(Input):
    current_password: str = Field(min_length=1, max_length=256, repr=False)
    new_password: str = Field(min_length=8, max_length=256, repr=False)


class Preferences(Input):
    start_page: Literal["dashboard", "racks", "inventory", "power", "consoles", "monitoring"] = "dashboard"
    refresh_seconds: Literal[5, 15, 30, 60] = 15
    confirm_power: bool = True
    compact_racks: bool = False


async def throttle(request, username):
    now = time.time()
    peer = request.client.host if request.client else "unknown"
    for key, limit in (("ip:" + peer, 50), ("user:" + username.strip().lower(), 10)):
        key = hashlib.sha256(key.encode()).hexdigest()
        async with AsyncSessionLocal() as db:
            await db.execute(delete(AuthThrottle).where(AuthThrottle.window_at < now - 3600))
            values = {"attempts":case((AuthThrottle.window_at < now-300, 1), else_=AuthThrottle.attempts+1),
                      "window_at":case((AuthThrottle.window_at < now-300, now), else_=AuthThrottle.window_at)}
            attempts = (await db.execute(update(AuthThrottle).where(AuthThrottle.key == key).values(**values).returning(AuthThrottle.attempts))).scalar_one_or_none()
            if attempts is None:
                db.add(AuthThrottle(key=key, attempts=1, window_at=now))
                try: await db.commit()
                except IntegrityError:
                    await db.rollback()
                    attempts = (await db.execute(update(AuthThrottle).where(AuthThrottle.key == key).values(**values).returning(AuthThrottle.attempts))).scalar_one()
            await db.commit()
            if attempts and attempts > limit: raise HTTPException(429, "Too many attempts. Try again in five minutes.", headers={"Retry-After":"300"})


async def issue_session(db, user, request, response):
    raw = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    seconds = get_settings().accounts_session_hours * 3600
    await db.execute(delete(UserSession).where(UserSession.expires_at <= time.time()))
    db.add(UserSession(token_hash=hashlib.sha256(raw.encode()).hexdigest(), user_id=user.id, csrf_token=csrf, expires_at=time.time()+seconds))
    response.set_cookie(COOKIE, raw, max_age=seconds, httponly=True, samesite="lax", secure=get_settings().accounts_secure_cookie or request.url.scheme == "https", path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"user":public_user(user), "csrf_token":csrf}


@router.get("/auth/status")
async def auth_status(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    if not get_settings().accounts_enabled: return {"mode":"legacy", "user":None}
    current = getattr(request.state, "account", None)
    async with AsyncSessionLocal() as db:
        setup_required = not bool(await db.scalar(select(func.count()).select_from(User)))
    return {"mode":"accounts", "registration_enabled":get_settings().accounts_registration_enabled and not setup_required,
            "setup_required":setup_required, "user":current["user"] if current else None, "csrf_token":current["csrf_token"] if current else None}


@router.post("/auth/login")
async def login(body: Credentials, request: Request, response: Response):
    if not get_settings().accounts_enabled: raise HTTPException(404, "User accounts are not enabled")
    await throttle(request, body.username)
    async with AsyncSessionLocal() as db:
        user = await db.scalar(select(User).where(User.username == body.username.strip().lower()))
        # Run the same password work for unknown names to avoid a cheap username oracle.
        encoded = user.password_hash if user else "scrypt$" + "00"*16 + "$" + "00"*64
        valid = await asyncio.to_thread(verify_password, body.password, encoded)
        if not valid or not user or not user.enabled: raise HTTPException(401, "Wrong username or password, or this account is disabled.")
        user.last_login_at = time.time()
        old = getattr(request.state, "account", None)
        if old: await db.execute(delete(UserSession).where(UserSession.token_hash == old["session_hash"]))
        result = await issue_session(db, user, request, response)
        await db.commit()
        return result


@router.post("/auth/register", status_code=201)
async def register(body: Registration, request: Request, response: Response):
    settings = get_settings()
    if not settings.accounts_enabled or not settings.accounts_registration_enabled: raise HTTPException(403, "Ask a lab admin to create your account")
    await throttle(request, body.username)
    async with AsyncSessionLocal() as db:
        if not await db.scalar(select(func.count()).select_from(User)): raise HTTPException(403, "An administrator must initialize accounts first")
        user = User(id=str(uuid.uuid4()), username=body.username, name=body.name, role="Viewer", enabled=True, created_at=time.time(),
                    email="", preferences_json="{}", must_change_password=False, password_hash=await asyncio.to_thread(hash_password, body.password))
        db.add(user)
        try: await db.flush()
        except IntegrityError: raise HTTPException(409, "Username is already taken")
        result = await issue_session(db, user, request, response)
        await db.commit()
        return result


@router.post("/auth/logout")
async def logout(request: Request, response: Response):
    current = account(request)
    async with AsyncSessionLocal() as db:
        await db.execute(delete(UserSession).where(UserSession.token_hash == current["session_hash"]))
        await db.commit()
    response.delete_cookie(COOKIE, path="/")
    return {"ok":True}


@router.get("/me")
async def me(request: Request): return account(request)["user"]


@router.put("/me")
async def profile(body: Profile, request: Request):
    current = account(request)
    async with AsyncSessionLocal() as db:
        user = await db.get(User, current["user"]["id"])
        user.name, user.email = body.name, body.email
        await db.commit()
        return public_user(user)


@router.put("/me/preferences")
async def preferences(body: Preferences, request: Request):
    current = account(request)
    async with AsyncSessionLocal() as db:
        user = await db.get(User, current["user"]["id"])
        user.preferences_json = json.dumps(body.model_dump())
        await db.commit()
        return public_user(user)


@router.put("/me/password")
async def password_change(body: PasswordChange, request: Request, response: Response):
    current = account(request)
    await throttle(request, current["user"]["username"])
    async with AsyncSessionLocal() as db:
        user = await db.get(User, current["user"]["id"])
        if not await asyncio.to_thread(verify_password, body.current_password, user.password_hash): raise HTTPException(400, "Current password is wrong")
        user.password_hash = await asyncio.to_thread(hash_password, body.new_password)
        user.must_change_password = False
        await db.execute(delete(UserSession).where(UserSession.user_id == user.id))
        result = await issue_session(db, user, request, response)
        await db.commit()
        return result


@router.get("/users")
async def users(request: Request):
    account(request)
    async with AsyncSessionLocal() as db:
        return [public_user(user) for user in (await db.scalars(select(User).order_by(User.username))).all()]


@router.post("/users", status_code=201)
async def create_user(body: NewUser, request: Request):
    account(request)
    async with AsyncSessionLocal() as db:
        user = User(id=str(uuid.uuid4()), username=body.username, name=body.name, role=body.role, created_at=time.time(),
                    password_hash=await asyncio.to_thread(hash_password, body.password), must_change_password=True)
        db.add(user)
        try: await db.commit()
        except IntegrityError: raise HTTPException(409, "Username is already taken")
        await db.refresh(user)
        return public_user(user)


@router.patch("/users/{user_id}")
async def change_user(user_id: str, body: UserUpdate, request: Request):
    current = account(request)
    if user_id == current["user"]["id"]: raise HTTPException(400, "You cannot change your own role or account status")
    async with AsyncSessionLocal() as db:
        active_admins = select(func.count()).select_from(User).where(User.role == "Admin", User.enabled.is_(True)).scalar_subquery()
        guard = (User.role != "Admin") | User.enabled.is_(False) | (active_admins > 1)
        values = body.model_dump(exclude_none=True)
        if not values: raise HTTPException(400, "No changes supplied")
        result = await db.execute(update(User).where(User.id == user_id, guard).values(**values))
        if not result.rowcount: raise HTTPException(400, "User does not exist or is the last active administrator")
        # Revoke existing sessions on every permission/status change.
        await db.execute(delete(UserSession).where(UserSession.user_id == user_id))
        await db.commit()
        return public_user(await db.get(User, user_id))


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, request: Request):
    current = account(request)
    if user_id == current["user"]["id"]: raise HTTPException(400, "You cannot remove your own account")
    async with AsyncSessionLocal() as db:
        active_admins = select(func.count()).select_from(User).where(User.role == "Admin", User.enabled.is_(True)).scalar_subquery()
        guard = (User.role != "Admin") | User.enabled.is_(False) | (active_admins > 1)
        # Sessions have no business history; inventory and monitor history are untouched.
        await db.execute(delete(UserSession).where(UserSession.user_id == user_id))
        result = await db.execute(delete(User).where(User.id == user_id, guard))
        if not result.rowcount: raise HTTPException(400, "User does not exist or is the last active administrator")
        await db.commit()
        return {"ok":True}


@router.post("/users/{user_id}/reset-password")
async def reset_password(user_id: str, request: Request):
    current = account(request)
    if user_id == current["user"]["id"]: raise HTTPException(400, "Use Account settings to change your own password")
    temporary = secrets.token_urlsafe(16)
    async with AsyncSessionLocal() as db:
        user = await db.get(User, user_id)
        if not user: raise HTTPException(404, "User not found")
        user.password_hash = await asyncio.to_thread(hash_password, temporary)
        user.must_change_password = True
        await db.execute(delete(UserSession).where(UserSession.user_id == user_id))
        await db.commit()
    return {"temporary_password":temporary}
