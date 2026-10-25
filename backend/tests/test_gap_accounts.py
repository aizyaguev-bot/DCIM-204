"""Gap tests for user accounts (app/accounts.py) and the maintenance password confirmation (app/confirm.py).

Covers what the older account tests leave open: the reviewed role of every /api route in app.main and its enforcement
by the middleware, session-bound CSRF and origin rules, cookie lifetime and expiry, the temporary-password gate,
the sign-in throttle, the last-active-admin guard, first-start bootstrap and stored preferences.
Temporary SQLite databases and in-process ASGI clients only: no device, VM, live site or network.
"""
import asyncio
import hashlib
import json
import re
import secrets
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.requests import HTTPConnection, Request
from starlette.routing import WebSocketRoute

from app import accounts, confirm
from app.database import Base
from app.models import AuthThrottle, User, UserSession

PASSWORD = "gap-test-password-1"
_REAL_SCRYPT = hashlib.scrypt


class CheapHashlib:
    """hashlib with a low-cost scrypt for accounts: the real hash/verify code, format, salt and comparison run,
    in milliseconds instead of seconds per sign-in."""
    sha256 = staticmethod(hashlib.sha256)

    @staticmethod
    def scrypt(password, *, salt, n, r, p, dklen, maxmem=0):
        return _REAL_SCRYPT(password, salt=salt, n=16, r=1, p=1, dklen=dklen)


@pytest.fixture
async def bare(tmp_path, monkeypatch):
    """Accounts middleware + accounts router + a catch-all API on an empty temporary user database."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'gap-accounts.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(accounts, "hashlib", CheapHashlib)
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)

    @app.api_route("/api/{path:path}", methods=["GET", "PUT", "POST", "PATCH", "DELETE"])
    async def action(path: str):
        return {"ok": True}

    yield SimpleNamespace(app=app, sessions=sessions, settings=settings)
    await engine.dispose()


@pytest.fixture
async def env(bare):
    """`bare` after the first start: the bootstrap Admin ("admin", id initial-admin) plus a Viewer and an Operator."""
    await accounts.bootstrap_admin()
    await add_user(bare, "viewer", "Viewer")
    await add_user(bare, "operator", "Operator")
    return bare


async def add_user(env, username, role, password=PASSWORD, **fields):
    async with env.sessions() as db:
        db.add(User(id=username, username=username, name=username.title(), role=role, created_at=time.time(),
                    password_hash=accounts.hash_password(password), **fields))
        await db.commit()


def client(env, ip="127.0.0.1"):
    return AsyncClient(transport=ASGITransport(app=env.app, client=(ip, 50000)), base_url="http://test")


async def sign_in(c, username, password=PASSWORD):
    r = await c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
    return r


async def login(c, username, password=PASSWORD):
    return await c.post("/api/auth/login", json={"username": username, "password": password})


async def session_for(env, user_id, token=None, expires_in=3600.0):
    """A session row as login stores it (only the token's SHA-256), without going through the login route."""
    token = token or secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    async with env.sessions() as db:
        db.add(UserSession(token_hash=hashlib.sha256(token.encode()).hexdigest(), user_id=user_id, csrf_token=csrf,
                           expires_at=time.time() + expires_in))
        await db.commit()
    return token, csrf


async def scalar(env, statement):
    async with env.sessions() as db:
        return await db.scalar(statement)


# -- The reviewed role of every /api route in app.main ----------------------------------------------------------------

CONVERSATION = "0123456789abcdef" * 2
PUBLIC = "Public"
ROUTE_ROLES = {
    "GET /api/version": PUBLIC, "GET /api/auth/status": PUBLIC, "POST /api/auth/login": PUBLIC, "POST /api/auth/register": PUBLIC,
    # Own account: every signed-in role.
    "POST /api/auth/logout": "Viewer", "GET /api/me": "Viewer", "PUT /api/me": "Viewer", "PUT /api/me/password": "Viewer",
    "PUT /api/me/preferences": "Viewer",
    # User management.
    "GET /api/users": "Admin", "POST /api/users": "Admin", "PATCH /api/users/{user_id}": "Admin",
    "DELETE /api/users/{user_id}": "Admin", "POST /api/users/{user_id}/reset-password": "Admin",
    # Lab assistant: asking and deleting one's own conversation are the only Viewer writes.
    "GET /api/assistant/status": "Viewer", "POST /api/assistant/chat": "Viewer", "GET /api/assistant/conversations": "Viewer",
    "GET /api/assistant/conversations/{conversation_id}": "Viewer", "DELETE /api/assistant/conversations/{conversation_id}": "Viewer",
    "GET /api/assistant/work-items": "Viewer", "POST /api/assistant/work-items": "Operator",
    "PATCH /api/assistant/work-items/{item_id}": "Operator",
    "GET /api/changelog": "Viewer",
    # Layout stores: read by anyone signed in, written by Operators.
    "GET /api/chillers": "Viewer", "PUT /api/chillers": "Operator", "GET /api/rack-items": "Viewer", "PUT /api/rack-items": "Operator",
    "PUT /api/rack-layout": "Operator", "GET /api/rack-overrides": "Viewer", "PUT /api/rack-overrides": "Operator",
    "GET /api/rack-positions": "Viewer", "PUT /api/rack-positions": "Operator", "GET /api/rack-slots": "Viewer",
    "PUT /api/rack-slots": "Operator", "GET /api/switch-assignments": "Viewer", "PUT /api/switch-assignments": "Operator",
    "GET /api/twin-data": "Viewer", "PUT /api/twin-data": "Operator",
    "GET /api/opt-owners": "Viewer", "PUT /api/opt-owners": "Admin", "PUT /api/opt-owners/{asset_key:path}": "Operator",
    "GET /api/engineers": "Viewer", "POST /api/engineers": "Admin", "PUT /api/engineers/{engineer_id}": "Admin",
    # Devices: configuration is Admin, labels/moves are Operator, the connection export is Operator even to read.
    "GET /api/devices/": "Viewer", "POST /api/devices/": "Admin", "PUT /api/devices/{device_id}": "Admin",
    "DELETE /api/devices/{device_id}": "Admin", "PATCH /api/devices/{device_id}/labels": "Operator",
    "PATCH /api/devices/direct-label": "Operator", "POST /api/devices/rename-opt": "Operator",
    "POST /api/devices/move-server": "Operator", "GET /api/devices/locations": "Viewer", "GET /api/devices/sync-map": "Viewer",
    "GET /api/devices/connections": "Operator", "GET /api/devices/connections.csv": "Operator",
    "GET /api/inventory": "Viewer", "POST /api/inventory": "Operator", "POST /api/inventory/{item_id}/barcode": "Operator",
    "POST /api/inventory/{item_id}/location": "Operator",
    # KVM: status is a read; every console route (and its proxy, any method) needs an Operator.
    "GET /api/kvms/{device_id}/status": "Viewer", "GET /api/kvms/{device_id}/autologin": "Operator",
    "GET /api/kvms/{device_id}/console-url": "Operator", "GET /api/kvms/{device_id}/ports/{port_number}/viewer": "Operator",
    "POST /api/kvms/{device_id}/mark-free": "Operator", "POST /api/kvms/{device_id}/ports/{port}/mark-free": "Operator",
    "POST /api/kvms/{device_id}/ports/{port}/mark-in-use": "Operator",
    **{f"{m} /api/kvms/{{device_id}}/proxy/{{path:path}}": "Operator" for m in ("GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE")},
    "WEBSOCKET /api/kvms/{device_id}/proxy/ws/{path:path}": "Operator",
    "GET /api/monitoring": "Viewer", "POST /api/monitoring/check": "Operator", "GET /api/monitoring/incidents": "Viewer",
    "GET /api/monitoring/incidents.csv": "Viewer", "POST /api/monitoring/targets": "Operator",
    "PUT /api/monitoring/targets/{target_id}": "Operator", "GET /api/monitoring/targets/{target_id}/history": "Viewer",
    # PDU power and maintenance.
    "GET /api/pdus/maintenance": "Viewer", "POST /api/pdus/{device_id}/maintenance/shutdown": "Operator",
    "POST /api/pdus/{device_id}/maintenance/restore": "Operator", "POST /api/pdus/{device_id}/outlets/{outlet_number}/power": "Operator",
    "GET /api/pdus/{device_id}/status": "Viewer", "GET /api/pdus/{device_id}/sensors-debug": "Viewer",
    # PXE: Operator even to read; only acknowledging a manual takeover needs an Admin.
    "GET /api/pxe/config": "Operator", "GET /api/pxe/computers": "Operator", "GET /api/pxe/jobs": "Operator",
    "POST /api/pxe/jobs": "Operator", "GET /api/pxe/jobs/{job_id}": "Operator", "GET /api/pxe/jobs/{job_id}/screenshot": "Operator",
    **{f"POST /api/pxe/jobs/{{job_id}}/{a}": "Operator" for a in ("cancel", "choose-boot", "choose-grub", "complete", "install",
                                                                   "refresh-screenshot", "start", "takeover")},
    "POST /api/pxe/jobs/{job_id}/acknowledge": "Admin",
}
ROLE_USER = {"Viewer": "viewer", "Operator": "operator", "Admin": "initial-admin"}


def concrete(template):
    path = template.replace("{conversation_id}", CONVERSATION)
    path = re.sub(r"\{[^}:]+:path\}", "jsclient/page.asp", path)
    return re.sub(r"\{[^}]+\}", "x1", path)


def main_api_routes():
    import app.main as main
    for route in main.app.routes:
        if not route.path.startswith("/api"):
            continue
        if isinstance(route, APIRoute):
            yield from ((method, route.path) for method in sorted(route.methods))
        elif isinstance(route, WebSocketRoute):
            yield "WEBSOCKET", route.path


def test_every_api_route_in_main_has_its_reviewed_role():
    def effective(method, template):
        path = concrete(template).rstrip("/")   # as the middleware sees it
        if path in accounts.PUBLIC or (method == "GET" and path == "/api/version"):
            return PUBLIC
        return accounts.required_role(path, "GET" if method == "WEBSOCKET" else method)

    actual = {f"{method} {template}": effective(method, template) for method, template in main_api_routes()}
    assert sorted(set(actual) - set(ROUTE_ROLES)) == [], "a new /api route needs a reviewed role in ROUTE_ROLES"
    assert sorted(set(ROUTE_ROLES) - set(actual)) == [], "a reviewed route no longer exists in app.main"
    assert {key: role for key, role in actual.items() if role != ROUTE_ROLES[key]} == {}
    assert accounts.PUBLIC == {"/api/auth/status", "/api/auth/login", "/api/auth/register"}


@pytest.mark.parametrize("role", [None, "Viewer", "Operator", "Admin"])
async def test_every_api_route_in_main_is_enforced_by_the_middleware(env, role):
    """Stub handlers on app.main's real route table: the middleware alone decides 401/403, no handler logic runs."""
    stub = FastAPI()
    stub.add_middleware(accounts.AccountAccess)

    async def ok():
        return {"ok": True}
    routes = [(m, t) for m, t in main_api_routes() if m != "WEBSOCKET"]
    for method, template in routes:
        stub.add_api_route(template, ok, methods=[method])
    headers = {"Origin": "http://test"}
    async with AsyncClient(transport=ASGITransport(app=stub), base_url="http://test") as c:
        if role:
            token, headers["X-DCIM-CSRF"] = await session_for(env, ROLE_USER[role])
            c.cookies.set(accounts.COOKIE, token)
        wrong = {}
        for method, template in routes:
            needed = ROUTE_ROLES[f"{method} {template}"]
            if needed == PUBLIC: want = 200
            elif role is None: want = 401
            else: want = 200 if accounts.ROLES[role] >= accounts.ROLES[needed] else 403
            r = await c.request(method, concrete(template), headers=headers)
            if r.status_code != want:
                wrong[f"{method} {template}"] = (r.status_code, want)
            if want in (401, 403):
                assert r.headers["cache-control"] == "no-store"
    assert wrong == {}


async def test_api_schema_and_docs_need_a_session(env, monkeypatch):
    import app.main as main
    monkeypatch.setattr(main, "get_settings", lambda: env.settings)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as c:
        for path in ("/openapi.json", "/openapi.json/", "/docs", "/redoc"):
            r = await c.get(path)
            assert r.status_code == 401 and r.json() == {"detail": "Sign in to continue"}, path
        token, _ = await session_for(env, "viewer")
        c.cookies.set(accounts.COOKIE, token)
        r = await c.get("/openapi.json")
        assert r.status_code == 200 and "/api/users" in r.json()["paths"]


# -- CSRF and origin -------------------------------------------------------------------------------------------------

async def test_csrf_token_is_bound_to_its_own_session_and_rotates_on_sign_in(env):
    async with client(env) as viewer, client(env) as operator:
        viewer_csrf = (await sign_in(viewer, "viewer")).json()["csrf_token"]
        first = await sign_in(operator, "operator")
        old_cookie, old_csrf = operator.cookies.get(accounts.COOKIE), first.json()["csrf_token"]
        r = await operator.put("/api/rack-items", json={}, headers={"X-DCIM-CSRF": viewer_csrf})
        assert r.status_code == 403 and "CSRF" in r.json()["detail"]
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            assert (await operator.request(method, "/api/rack-items", headers={"X-DCIM-CSRF": ""})).status_code == 403
        assert (await operator.put("/api/rack-items", json={})).status_code == 200
        assert (await operator.get("/api/rack-items", headers={"X-DCIM-CSRF": ""})).status_code == 200  # reads need none
        # Signing in again on the same browser replaces the session: the old cookie and old token stop working.
        second = await sign_in(operator, "operator")
        assert operator.cookies.get(accounts.COOKIE) != old_cookie and second.json()["csrf_token"] != old_csrf
        assert (await operator.put("/api/rack-items", json={}, headers={"X-DCIM-CSRF": old_csrf})).status_code == 403
        assert (await operator.put("/api/rack-items", json={})).status_code == 200
    async with client(env) as stale:
        stale.cookies.set(accounts.COOKIE, old_cookie)
        assert (await stale.get("/api/me")).status_code == 401
    assert await scalar(env, select(func.count()).select_from(UserSession).where(UserSession.user_id == "operator")) == 1


async def test_logout_needs_the_csrf_token_and_then_clears_cookie_and_session(env):
    async with client(env) as c:
        await sign_in(c, "viewer")
        token, csrf = c.cookies.get(accounts.COOKIE), c.headers.pop("X-DCIM-CSRF")
        assert (await c.post("/api/auth/logout")).status_code == 403   # a forged cross-site logout is refused
        assert (await c.get("/api/me")).status_code == 200
        r = await c.post("/api/auth/logout", headers={"X-DCIM-CSRF": csrf})
        assert r.status_code == 200
        cookie = r.headers["set-cookie"]
        assert cookie.startswith(f"{accounts.COOKIE}=") and "Max-Age=0" in cookie and "Path=/" in cookie
    async with client(env) as stale:
        stale.cookies.set(accounts.COOKIE, token)
        assert (await stale.get("/api/me")).status_code == 401
    assert await scalar(env, select(func.count()).select_from(UserSession).where(UserSession.user_id == "viewer")) == 0


def connection(scope_type="http", scheme="http", **headers):
    raw = [(b"host", b"lab.example:8000")] + [(k.replace("_", "-").encode(), v.encode()) for k, v in headers.items()]
    return HTTPConnection({"type": scope_type, "scheme": scheme, "path": "/api/x", "query_string": b"", "headers": raw,
                           "server": ("lab.example", 8000)})


@pytest.mark.parametrize("scope_type,scheme,headers,allowed", [
    ("http", "http", {}, True),                                              # non-browser client
    ("http", "http", {"sec_fetch_site": "same-origin"}, True),
    ("http", "http", {"sec_fetch_site": "none"}, True),                       # typed into the address bar
    ("http", "http", {"sec_fetch_site": "cross-site"}, False),                # browser without Origin, foreign site
    ("http", "http", {"origin": "http://lab.example:8000"}, True),
    ("http", "http", {"origin": "http://lab.example"}, False),                 # other port
    ("http", "http", {"origin": "https://lab.example:8000"}, False),           # other scheme
    ("http", "http", {"origin": "http://lab.example:8000.evil.example"}, False),
    ("http", "http", {"origin": "null"}, False),                               # sandboxed or opaque origin
    ("websocket", "ws", {"origin": "http://lab.example:8000"}, True),
    ("websocket", "wss", {"origin": "https://lab.example:8000"}, True),
    ("websocket", "ws", {"origin": "https://lab.example:8000"}, False),
])
def test_same_origin_rules(scope_type, scheme, headers, allowed):
    assert accounts.same_origin(connection(scope_type, scheme, **headers)) is allowed


async def test_cross_site_sign_in_is_refused_before_it_is_counted_or_sets_a_cookie(env):
    async with client(env) as c:
        for _ in range(12):
            r = await c.post("/api/auth/login", json={"username": "admin", "password": PASSWORD},
                             headers={"Sec-Fetch-Site": "cross-site"})
            assert r.status_code == 403 and r.json()["detail"] == "Cross-origin action rejected"
            assert "set-cookie" not in r.headers
        await sign_in(c, "admin")  # more than the per-user limit was refused, yet none of it used the budget


# -- Sessions --------------------------------------------------------------------------------------------------------

async def test_session_cookie_lifetime_matches_the_stored_expiry_and_only_a_hash_is_stored(env):
    env.settings.accounts_session_hours = 2
    async with client(env) as c:
        before = time.time()
        r = await sign_in(c, "viewer")
        after = time.time()
    cookie, token = r.headers["set-cookie"], c.cookies.get(accounts.COOKIE)
    assert "Max-Age=7200" in cookie and "HttpOnly" in cookie and "Path=/" in cookie and "SameSite=lax" in cookie
    assert "Secure" not in cookie and r.headers["cache-control"] == "no-store"
    async with env.sessions() as db:
        rows = (await db.scalars(select(UserSession).where(UserSession.user_id == "viewer"))).all()
    assert len(rows) == 1
    assert rows[0].token_hash == hashlib.sha256(token.encode()).hexdigest() and token not in rows[0].token_hash
    assert rows[0].csrf_token == r.json()["csrf_token"] != token
    assert before + 7200 <= rows[0].expires_at <= after + 7200


async def test_expired_sessions_stop_working_and_are_purged_by_the_next_sign_in(env):
    async with client(env) as viewer:
        await sign_in(viewer, "viewer")
        async with env.sessions() as db:
            await db.execute(update(UserSession).values(expires_at=time.time() + 30))
            await db.commit()
        assert (await viewer.get("/api/me")).status_code == 200
        async with env.sessions() as db:
            await db.execute(update(UserSession).values(expires_at=time.time() - 1))
            await db.commit()
        r = await viewer.get("/api/me")
        assert r.status_code == 401 and r.headers["cache-control"] == "no-store"
        assert await scalar(env, select(func.count()).select_from(UserSession)) == 1  # expired, but still stored
        async with client(env) as operator:
            await sign_in(operator, "operator")
    async with env.sessions() as db:
        assert (await db.scalars(select(UserSession.user_id))).all() == ["operator"]


async def test_a_disabled_account_is_refused_even_while_its_session_row_exists(env):
    async with client(env) as c:
        await sign_in(c, "viewer")
        async with env.sessions() as db:
            await db.execute(update(User).where(User.id == "viewer").values(enabled=False))
            await db.commit()
        assert (await c.get("/api/me")).status_code == 401
        assert await scalar(env, select(func.count()).select_from(UserSession).where(UserSession.user_id == "viewer")) == 1
        disabled, wrong = await login(c, "viewer"), await login(c, "viewer", "wrong-password")
        assert disabled.status_code == wrong.status_code == 401 and disabled.json() == wrong.json()


async def test_session_tokens_longer_than_128_characters_are_ignored(env):
    longest, too_long = "a" * 128, "b" * 129
    for token in (longest, too_long):
        await session_for(env, "viewer", token=token)
    async with client(env) as c:
        c.cookies.set(accounts.COOKIE, longest)
        assert (await c.get("/api/me")).json()["username"] == "viewer"
    async with client(env) as c:
        c.cookies.set(accounts.COOKIE, too_long)  # a matching, unexpired row exists, but the cookie is never looked up
        assert (await c.get("/api/me")).status_code == 401


async def test_temporary_password_gate_comes_before_the_role_even_for_an_admin(env):
    await add_user(env, "tempadmin", "Admin", must_change_password=True)
    async with client(env) as c:
        r = await sign_in(c, "tempadmin")
        assert r.json()["user"]["must_change_password"] is True
        assert (await c.get("/api/me")).status_code == 200
        assert (await c.put("/api/me", json={"name": "Temp Admin"})).json()["name"] == "Temp Admin"
        assert (await c.get("/api/auth/status")).json()["user"]["username"] == "tempadmin"
        assert (await c.get("/api/version")).status_code == 200
        for method, path in (("GET", "/api/users"), ("POST", "/api/users"), ("GET", "/api/rack-items"),
                             ("PUT", "/api/me/preferences"), ("PATCH", "/api/users/viewer")):
            r = await c.request(method, path, json={})
            assert r.status_code == 403 and r.json()["detail"] == "Change your temporary password in Account settings first", path
        assert (await c.post("/api/auth/logout")).status_code == 200


# -- Sign-in throttle ------------------------------------------------------------------------------------------------

async def test_login_throttle_counts_a_username_however_it_is_typed(env):
    async with client(env) as c:
        for name in ("viewer", "VIEWER", " Viewer", "viewer ", "ViEwEr") * 2:
            assert (await login(c, name, "wrong-password")).status_code == 401
        r = await login(c, "viewer")   # the right password is throttled too, so a guess gives no signal
        assert r.status_code == 429 and r.headers["retry-after"] == "300" and "five minutes" in r.json()["detail"]
        await sign_in(c, "operator")   # another account from the same address keeps its own budget


async def test_login_throttle_limits_one_address_across_usernames(env):
    async with client(env, "192.0.2.10") as c:
        for n in range(50):
            assert (await login(c, f"nobody{n}", "wrong-password")).status_code == 401
        assert (await login(c, "admin")).status_code == 429
    async with client(env, "192.0.2.11") as other:
        await sign_in(other, "admin")


async def test_login_lockout_lifts_after_five_minutes_and_hour_old_counters_are_purged(env):
    async with env.sessions() as db:
        db.add(AuthThrottle(key="stale-counter", attempts=99, window_at=time.time() - 3601))
        await db.commit()
    async with client(env) as c:
        for _ in range(10):
            assert (await login(c, "viewer", "wrong-password")).status_code == 401
        assert (await login(c, "viewer")).status_code == 429
        assert await scalar(env, select(AuthThrottle).where(AuthThrottle.key == "stale-counter")) is None
        async with env.sessions() as db:
            await db.execute(update(AuthThrottle).values(window_at=AuthThrottle.window_at - 301))
            await db.commit()
        await sign_in(c, "viewer")


async def test_unknown_and_disabled_accounts_run_the_same_password_check(env, monkeypatch):
    checked = []
    real = accounts.verify_password

    def recording(password, encoded):
        checked.append(encoded.split("$")[0])
        return real(password, encoded)
    monkeypatch.setattr(accounts, "verify_password", recording)
    await add_user(env, "gone", "Viewer", enabled=False)
    async with client(env) as c:
        replies = [await login(c, "no-such-user"), await login(c, "viewer", "wrong-password"), await login(c, "gone")]
    assert [r.status_code for r in replies] == [401, 401, 401]
    assert replies[0].json() == replies[1].json() == replies[2].json()
    assert checked == ["scrypt", "scrypt", "scrypt"]


# -- Own password ----------------------------------------------------------------------------------------------------

async def test_password_change_revokes_other_devices_only_when_it_succeeds(env):
    new = "replacement-password-1"
    async with client(env) as laptop, client(env) as phone:
        await sign_in(laptop, "operator")
        await sign_in(phone, "operator")
        r = await laptop.put("/api/me/password", json={"current_password": "wrong-password", "new_password": new})
        assert r.status_code == 400 and new not in r.text
        assert (await phone.get("/api/me")).status_code == 200
        r = await laptop.put("/api/me/password", json={"current_password": PASSWORD, "new_password": new})
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        laptop.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        assert (await laptop.put("/api/rack-items", json={})).status_code == 200
        assert (await phone.get("/api/me")).status_code == 401
    async with client(env) as c:
        assert (await login(c, "operator")).status_code == 401
        await sign_in(c, "operator", new)


@pytest.mark.xfail(strict=True, reason="BUG: a forced password change accepts the admin-issued temporary password as the "
                                       "new password; must_change_password is cleared while the admin still knows it")
async def test_forced_password_change_must_replace_the_temporary_password(env):
    async with client(env) as admin, client(env) as user:
        await sign_in(admin, "admin")
        temporary = (await admin.post("/api/users/viewer/reset-password")).json()["temporary_password"]
        assert (await sign_in(user, "viewer", temporary)).json()["user"]["must_change_password"] is True
        r = await user.put("/api/me/password", json={"current_password": temporary, "new_password": temporary})
        assert r.status_code == 400
        assert (await user.get("/api/me")).json()["must_change_password"] is True


# -- Last active admin -----------------------------------------------------------------------------------------------

def as_admin(user_id="other-admin"):
    """A request already authorized as some other Admin, so the self-protection checks do not apply."""
    current = {"user": {"id": user_id, "username": user_id, "role": "Admin"}, "csrf_token": "unused", "session_hash": "unused"}
    return Request({"type": "http", "method": "PATCH", "path": "/", "headers": [], "query_string": b"", "state": {"account": current}})


async def test_the_last_active_admin_cannot_be_demoted_disabled_or_removed(env):
    async with client(env) as admin:
        await sign_in(admin, "admin")
        for body in ({"role": "Operator"}, {"role": "Viewer"}, {"enabled": False}, {"role": "Admin", "enabled": False}):
            with pytest.raises(HTTPException) as refused:
                await accounts.change_user("initial-admin", accounts.UserUpdate(**body), as_admin())
            assert refused.value.status_code == 400 and "last active administrator" in refused.value.detail
        with pytest.raises(HTTPException) as refused:
            await accounts.delete_user("initial-admin", as_admin())
        assert refused.value.status_code == 400
        me = await admin.get("/api/me")   # unchanged, and the refused removal did not revoke its session
        assert me.status_code == 200 and me.json()["role"] == "Admin" and me.json()["enabled"] is True
        # A disabled admin is not counted and not protected.
        await add_user(env, "retired", "Admin", enabled=False)
        assert (await accounts.change_user("retired", accounts.UserUpdate(role="Viewer"), as_admin()))["role"] == "Viewer"
        assert await accounts.delete_user("retired", as_admin()) == {"ok": True}
        # With a second active admin the first can be demoted, which revokes its sessions; then the second is protected.
        await add_user(env, "second", "Admin")
        assert (await accounts.change_user("initial-admin", accounts.UserUpdate(role="Operator"), as_admin()))["role"] == "Operator"
        assert (await admin.get("/api/me")).status_code == 401
        with pytest.raises(HTTPException) as refused:
            await accounts.change_user("second", accounts.UserUpdate(enabled=False), as_admin())
        assert refused.value.status_code == 400
    assert await scalar(env, select(func.count()).select_from(User).where(User.role == "Admin", User.enabled.is_(True))) == 1


async def test_two_admins_demoting_each_other_at_once_leave_one_admin(env):
    await add_user(env, "admin2", "Admin")
    async with client(env) as first, client(env) as second:
        await sign_in(first, "admin")
        await sign_in(second, "admin2")
        results = await asyncio.gather(first.patch("/api/users/admin2", json={"role": "Viewer"}),
                                       second.patch("/api/users/initial-admin", json={"role": "Viewer"}))
    # Exactly one demotion wins. The loser is refused by the last-admin guard (400) or, when the winner committed
    # before the loser's request was authorized, because its session was revoked or its role dropped (401/403).
    codes = sorted(r.status_code for r in results)
    assert codes[0] == 200 and codes[1] in (400, 401, 403), [r.text for r in results]
    assert await scalar(env, select(func.count()).select_from(User).where(User.role == "Admin", User.enabled.is_(True))) == 1


async def test_user_changes_need_a_known_user_and_an_allowed_field(env):
    async with client(env) as admin, client(env) as viewer:
        await sign_in(admin, "admin")
        await sign_in(viewer, "viewer")
        for body in ({}, {"role": None, "enabled": None}):
            r = await admin.patch("/api/users/viewer", json=body)
            assert r.status_code == 400 and r.json()["detail"] == "No changes supplied"
        for body in ({"role": "Owner"}, {"username": "root"}, {"must_change_password": False}, {"password_hash": "x"}):
            assert (await admin.patch("/api/users/viewer", json=body)).status_code == 422, body
        assert (await admin.patch("/api/users/nobody", json={"role": "Viewer"})).status_code == 400
        assert (await admin.delete("/api/users/nobody")).status_code == 400
        assert (await admin.post("/api/users/nobody/reset-password")).status_code == 404
        me = await viewer.get("/api/me")   # no refused change revoked the target's session or touched the account
        assert me.status_code == 200 and me.json()["role"] == "Viewer" and me.json()["must_change_password"] is False


# -- First start -----------------------------------------------------------------------------------------------------

async def test_before_the_first_admin_exists_nobody_can_register_or_sign_in(bare):
    bare.settings.lab_manager_password = ""
    bare.settings.accounts_registration_enabled = True
    await accounts.bootstrap_admin()
    async with client(bare) as c:
        status = (await c.get("/api/auth/status")).json()
        assert status == {"mode": "accounts", "registration_enabled": False, "setup_required": True, "user": None, "csrf_token": None}
        r = await c.post("/api/auth/register", json={"username": "first", "name": "First", "password": PASSWORD})
        assert r.status_code == 403 and r.json()["detail"] == "An administrator must initialize accounts first"
        assert (await login(c, "admin", "")).status_code == 422
        assert (await login(c, "admin")).status_code == 401
        assert await scalar(bare, select(func.count()).select_from(User)) == 0
        bare.settings.lab_manager_password = PASSWORD
        bare.settings.accounts_admin_username = " Lab.Admin "
        await accounts.bootstrap_admin()
        status = (await c.get("/api/auth/status")).json()
        assert status["setup_required"] is False and status["registration_enabled"] is True
        user = (await sign_in(c, "lab.admin")).json()["user"]
        assert (user["role"], user["enabled"], user["must_change_password"]) == ("Admin", True, False)


async def test_restarts_never_reset_or_add_admins_and_a_bad_admin_name_refuses_to_start(env):
    new = "changed-admin-password"
    async with client(env) as c:
        await sign_in(c, "admin")
        assert (await c.put("/api/me/password", json={"current_password": PASSWORD, "new_password": new})).status_code == 200
    env.settings.accounts_admin_username = "someone-else"
    await accounts.bootstrap_admin()   # a restart with the original LAB_MANAGER_PASSWORD still in .env
    async with client(env) as c:
        assert (await login(c, "admin")).status_code == 401
        assert (await login(c, "someone-else")).status_code == 401
        await sign_in(c, "admin", new)
    assert await scalar(env, select(func.count()).select_from(User)) == 3
    async with env.sessions() as db:
        await db.execute(delete(UserSession))
        await db.execute(delete(User))
        await db.commit()
    for name in ("-admin", "ad", "admin user", "a" * 33):
        env.settings.accounts_admin_username = name
        with pytest.raises(RuntimeError, match="ACCOUNTS_ADMIN_USERNAME"):
            await accounts.bootstrap_admin()
    assert await scalar(env, select(func.count()).select_from(User)) == 0


# -- Stored preferences ----------------------------------------------------------------------------------------------

DEFAULTS = {"start_page": "dashboard", "refresh_seconds": 15, "confirm_power": True, "compact_racks": False}


@pytest.mark.parametrize("stored,changes", [
    ('{"refresh_seconds": 60, "compact_racks": true}', {"refresh_seconds": 60, "compact_racks": True}),
    ("{}", {}), ("not json", {}), ("null", {}), ("[1, 2]", {}), ('"racks"', {}),
])
async def test_stored_preferences_are_merged_over_defaults_and_bad_json_falls_back(env, stored, changes):
    async with env.sessions() as db:
        await db.execute(update(User).where(User.id == "viewer").values(preferences_json=stored))
        await db.commit()
    token, _ = await session_for(env, "viewer")
    async with client(env) as c:
        c.cookies.set(accounts.COOKIE, token)
        assert (await c.get("/api/me")).json()["preferences"] == {**DEFAULTS, **changes}
        assert (await c.get("/api/auth/status")).json()["user"]["preferences"] == {**DEFAULTS, **changes}
    assert accounts.DEFAULT_PREFS == DEFAULTS


# -- Maintenance password confirmation (confirm.py) ------------------------------------------------------------------

def json_request(body, client_ip="127.0.0.1", account=None):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}
    scope = {"type": "http", "method": "POST", "path": "/", "query_string": b"", "client": (client_ip, 40000),
             "headers": [(b"content-type", b"application/json")], "state": {"account": account}}
    return Request(scope, receive)


async def test_read_body_reason_modes_limits_and_remaining_fields():
    async def read(body, mode="optional"):
        return await confirm.read_body(json_request(body), mode)

    assert await read({"password": "pw", "reason": "  fix  ", "rewrite_hash": "abc"}) == \
        ("pw", "fix", {"reason": "  fix  ", "rewrite_hash": "abc"})
    assert (await read({"password": "pw"}))[1] == ""
    assert (await read({"password": "pw", "reason": "   "}))[1] == ""
    assert (await read({"password": "pw", "reason": 5}))[1] == ""
    assert (await read({"password": "pw", "reason": "r" * 200}))[1] == "r" * 200
    assert (await read({"password": "pw", "reason": "a\nb"}, "none"))[1] == ""   # ignored when no reason is asked for
    assert (await read({"password": "p" * 256}, "none"))[0] == "p" * 256
    for body, mode, detail in (({"password": "pw", "reason": "r" * 201}, "optional", "Reason is too long (at most 200 characters)"),
                               ({"password": "pw", "reason": "a\tb"}, "optional", "Reason contains unsupported characters"),
                               ({"password": "pw", "reason": 5}, "required", "Reason is required (1–200 characters)"),
                               ({"password": "p" * 257}, "none", "Password is too long"),
                               ({"password": ["pw"]}, "none", "Password is required"),
                               (b"null", "none", "Invalid request body")):
        with pytest.raises(HTTPException) as refused:
            await read(body, mode)
        assert (refused.value.status_code, refused.value.detail) == (400, detail)


def test_password_mode_prefers_accounts_then_the_shared_password():
    def mode(accounts_enabled, password):
        return confirm.password_mode(SimpleNamespace(accounts_enabled=accounts_enabled, lab_manager_password=password))
    assert (mode(True, ""), mode(True, "x"), mode(False, "x"), mode(False, "")) == ("account", "account", "shared", "unavailable")
    confirm.require_password_mode(SimpleNamespace(accounts_enabled=False, lab_manager_password="x"))
    with pytest.raises(HTTPException) as refused:
        confirm.require_password_mode(SimpleNamespace(accounts_enabled=False, lab_manager_password=""), "PXE needs a password")
    assert (refused.value.status_code, refused.value.detail) == (403, "PXE needs a password")


async def test_shared_password_confirmation_is_limited_per_client_address(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'confirm.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=False, lab_manager_password="shared-secret-1")
    lock, denied = asyncio.Lock(), []

    async def on_denied(by):
        denied.append(by)

    async def check(password, ip):
        async with sessions() as db:
            return await confirm.verify(json_request({}, ip), db, password, settings, lock, on_denied)
    try:
        for _ in range(confirm.FAILURE_LIMIT):
            with pytest.raises(HTTPException) as refused:
                await check("wrong-guess", "192.0.2.21")
            assert refused.value.status_code == 403 and "wrong-guess" not in refused.value.detail
        with pytest.raises(HTTPException) as refused:
            await check("shared-secret-1", "192.0.2.21")
        assert refused.value.status_code == 429 and refused.value.headers == {"Retry-After": "300"}
        assert await check("shared-secret-1", "192.0.2.22") == confirm.SHARED_BY   # another address has its own budget
        with pytest.raises(HTTPException):
            await check("wrong-guess", "192.0.2.22")
        assert denied == [confirm.SHARED_BY] * (confirm.FAILURE_LIMIT + 1)
    finally:
        await engine.dispose()


async def test_one_users_maintenance_lockout_blocks_neither_other_users_nor_sign_in(env):
    lock = asyncio.Lock()

    async def check(user_id, username, password):
        current = {"user": {"id": user_id, "username": username, "role": "Admin"}, "csrf_token": "unused", "session_hash": "unused"}
        async with env.sessions() as db:
            async def on_denied(by): pass
            return await confirm.verify(json_request({}, account=current), db, password, env.settings, lock, on_denied)

    for _ in range(confirm.FAILURE_LIMIT):
        with pytest.raises(HTTPException) as refused:
            await check("operator", "operator", "wrong-password")
        assert refused.value.status_code == 403
    with pytest.raises(HTTPException) as refused:
        await check("operator", "operator", PASSWORD)
    assert refused.value.status_code == 429
    assert await check("initial-admin", "admin", PASSWORD) == "admin"
    async with client(env) as c:
        await sign_in(c, "operator")   # the sign-in throttle is a separate namespace
