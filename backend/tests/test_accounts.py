import hashlib
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts
from app.database import Base
from app.models import User, UserSession

PASSWORD = "test-password-123"


@pytest.fixture
async def setup(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'users.db'}")
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    await accounts.bootstrap_admin()
    password_hash = accounts.hash_password(PASSWORD)
    async with sessions() as db:
        for role in ["Viewer", "Operator"]:
            db.add(User(id=role.lower(),username=role.lower(),name=role,role=role,password_hash=password_hash,created_at=time.time()))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.state.actions = []
    @app.api_route("/api/{path:path}", methods=["GET","PUT","POST","PATCH","DELETE"])
    async def action(path: str):
        app.state.actions.append(path)
        return {"ok":True}
    @app.websocket("/api/kvms/d1/proxy/ws/test")
    async def ws(socket: WebSocket):
        await socket.accept()
        await socket.send_json({"ok":True})
        await socket.close()
    yield SimpleNamespace(app=app,sessions=sessions,settings=settings)
    await engine.dispose()


def client(setup): return AsyncClient(transport=ASGITransport(app=setup.app),base_url="http://test")


async def sign_in(c, username="admin", password=PASSWORD):
    r = await c.post("/api/auth/login",json={"username":username,"password":password})
    assert r.status_code == 200, r.text
    c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
    return r


async def test_bootstrap_login_cookie_logout_and_expiry(setup):
    await accounts.bootstrap_admin()
    async with client(setup) as c:
        assert (await c.get("/api/rack-items")).status_code == 401
        assert (await c.get("/api/rack-items",auth=("admin",PASSWORD))).status_code == 401
        r = await sign_in(c)
        assert "HttpOnly" in r.headers["set-cookie"] and "SameSite=lax" in r.headers["set-cookie"]
        assert "password" not in r.text.replace("must_change_password", "")
        assert (await c.get("/api/rack-items")).status_code == 200
        assert (await c.post("/api/auth/logout")).status_code == 200
        assert (await c.get("/api/rack-items")).status_code == 401
        await sign_in(c)
        async with setup.sessions() as db:
            await db.execute(update(UserSession).values(expires_at=time.time()-1)); await db.commit()
        assert (await c.get("/api/rack-items")).status_code == 401


@pytest.mark.parametrize("username,expected", [("viewer",403),("operator",200),("admin",200)])
async def test_role_protects_writes_and_console_gets(setup, username, expected):
    async with client(setup) as c:
        await sign_in(c,username)
        for path in ["/api/rack-items","/api/pdus/p1/outlets/1/power","/api/monitoring/check"]:
            assert (await c.post(path,json={})).status_code == expected
        for path in ["/api/kvms/k1/autologin","/api/kvms/k1/console-url","/api/kvms/k1/ports/1/viewer","/api/kvms/k1/proxy/home.asp"]:
            assert (await c.get(path)).status_code == expected
        assert (await c.get("/api/kvms/k1/status")).status_code == 200
        assert (await c.post("/api/devices/",json={})).status_code == (200 if username=="admin" else 403)
        assert (await c.get("/api/users")).status_code == (200 if username=="admin" else 403)
        assert (await c.patch("/api/devices/k1/labels",json={})).status_code == expected


async def test_csrf_origin_and_forged_registration_role(setup):
    async with client(setup) as c:
        r = await c.post("/api/auth/login",json={"username":"admin","password":PASSWORD},headers={"Origin":"https://evil.example"})
        assert r.status_code == 403
        await sign_in(c)
        assert (await c.put("/api/rack-items",json={},headers={"X-DCIM-CSRF":"wrong"})).status_code == 403
        assert (await c.put("/api/rack-items",json={},headers={"Origin":"http://test.evil.example"})).status_code == 403
        assert (await c.put("/api/rack-items",json={},headers={"Origin":"http://test"})).status_code == 200
        setup.settings.accounts_registration_enabled=True
        assert (await c.post("/api/auth/register",json={"username":"newuser","name":"New","password":PASSWORD,"role":"Admin"})).status_code == 422


async def test_create_user_temporary_password_profile_preferences_and_session_rotation(setup):
    async with client(setup) as admin, client(setup) as newcomer:
        await sign_in(admin)
        body={"username":"NEW.User","name":"New User","password":PASSWORD,"role":"Operator"}
        created = await admin.post("/api/users",json=body)
        assert created.status_code == 201
        assert created.json()["username"] == "new.user"
        assert (await admin.post("/api/users",json=body)).status_code == 409
        login = await sign_in(newcomer,"new.user")
        old_cookie = newcomer.cookies.get(accounts.COOKIE)
        assert login.json()["user"]["must_change_password"]
        assert (await newcomer.get("/api/rack-items")).status_code == 403
        r = await newcomer.put("/api/me/password",json={"current_password":PASSWORD,"new_password":"replacement-password"})
        assert r.status_code == 200 and not r.json()["user"]["must_change_password"]
        newcomer.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        assert newcomer.cookies.get(accounts.COOKIE) != old_cookie
        assert (await newcomer.get("/api/rack-items")).status_code == 200
        assert (await newcomer.put("/api/me",json={"name":"Updated","email":"example@nvidia.com"})).json()["name"] == "Updated"
        prefs={"start_page":"racks","refresh_seconds":30,"confirm_power":False,"compact_racks":True}
        assert (await newcomer.put("/api/me/preferences",json=prefs)).json()["preferences"] == prefs
        assert (await newcomer.put("/api/me/preferences",json={**prefs,"refresh_seconds":1})).status_code == 422
        assert (await newcomer.put("/api/me",json={"name":"Updated","role":"Admin"})).status_code == 422
        async with client(setup) as stale:
            stale.cookies.set(accounts.COOKIE,old_cookie)
            assert (await stale.get("/api/me")).status_code == 401


async def test_disable_role_change_reset_delete_revoke_sessions(setup):
    async with client(setup) as admin, client(setup) as viewer:
        await sign_in(admin)
        await sign_in(viewer,"viewer")
        assert (await admin.patch("/api/users/viewer",json={"enabled":False})).status_code == 200
        assert (await viewer.get("/api/me")).status_code == 401
        assert (await viewer.post("/api/auth/login",json={"username":"viewer","password":PASSWORD})).status_code == 401
        await admin.patch("/api/users/viewer",json={"enabled":True})
        await sign_in(viewer,"viewer")
        assert (await admin.patch("/api/users/viewer",json={"role":"Operator"})).status_code == 200
        assert (await viewer.get("/api/me")).status_code == 401
        await sign_in(viewer,"viewer")
        reset=await admin.post("/api/users/viewer/reset-password")
        assert reset.status_code==200
        assert (await viewer.get("/api/me")).status_code == 401
        await sign_in(viewer,"viewer",reset.json()["temporary_password"])
        assert (await admin.delete("/api/users/viewer")).status_code == 200
        assert (await viewer.get("/api/me")).status_code == 401
        assert all("password_hash" not in u for u in (await admin.get("/api/users")).json())


async def test_self_protection_and_independent_last_admin_guard(setup):
    async with client(setup) as c:
        r = await sign_in(c)
        me=r.json()["user"]["id"]
        assert (await c.patch(f"/api/users/{me}",json={"role":"Viewer"})).status_code == 400
        assert (await c.delete(f"/api/users/{me}")).status_code == 400
        assert (await c.post(f"/api/users/{me}/reset-password")).status_code == 400


async def test_registration_opt_in_and_viewer_only(setup):
    async with client(setup) as c:
        body={"username":"reader","name":"Reader","password":PASSWORD}
        assert (await c.post("/api/auth/register",json=body)).status_code==403
        setup.settings.accounts_registration_enabled=True
        r=await c.post("/api/auth/register",json=body)
        assert r.status_code==201 and r.json()["user"]["role"]=="Viewer"
        assert (await c.get("/api/users")).status_code==403
        assert (await c.post("/api/auth/register",json={**body,"username":"READER"})).status_code==409


async def test_password_hash_throttle_and_secure_cookie(setup):
    encoded=accounts.hash_password(PASSWORD)
    assert PASSWORD not in encoded and encoded != accounts.hash_password(PASSWORD)
    assert accounts.verify_password(PASSWORD,encoded)
    assert not accounts.verify_password("wrong",encoded)
    async with client(setup) as c:
        for _ in range(10):
            assert (await c.post("/api/auth/login",json={"username":"unknown","password":"wrong"})).status_code==401
        assert (await c.post("/api/auth/login",json={"username":"unknown","password":"wrong"})).status_code==429
        setup.settings.accounts_secure_cookie=True
        r=await sign_in(c)
        assert "Secure" in r.headers["set-cookie"]


async def test_websocket_role_and_origin_are_checked(setup):
    async with client(setup) as c:
        await sign_in(c,"viewer")
        token=c.cookies.get(accounts.COOKIE)
    with TestClient(setup.app) as browser:
        for headers in [{},{"Cookie":f"{accounts.COOKIE}={token}"}]:
            with pytest.raises(Exception) as error:
                with browser.websocket_connect("/api/kvms/d1/proxy/ws/test",headers=headers): pass
            assert getattr(error.value,"code",None) in (4401,4403)
    async with client(setup) as c:
        await sign_in(c,"operator")
        token=c.cookies.get(accounts.COOKIE)
    with TestClient(setup.app) as browser:
        headers={"Cookie":f"{accounts.COOKIE}={token}","Origin":"https://evil.example"}
        with pytest.raises(Exception) as error:
            with browser.websocket_connect("/api/kvms/d1/proxy/ws/test",headers=headers): pass
        assert getattr(error.value,"code",None)==4403
        with browser.websocket_connect("/api/kvms/d1/proxy/ws/test",headers={"Cookie":f"{accounts.COOKIE}={token}"}) as socket:
            assert socket.receive_json()=={"ok":True}
