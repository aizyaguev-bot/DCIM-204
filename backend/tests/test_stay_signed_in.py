"""'Keep me signed in': a kept session lasts ACCOUNTS_REMEMBER_DAYS and slides while used (renewed at most hourly);
an unchecked sign-in keeps the ACCOUNTS_SESSION_HOURS session; every way of ending a session still ends a kept one."""
import asyncio
import re
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, ssh_store
from app.database import Base
from app.models import UserSession
from app.routers import ssh
from tests.test_accounts import PASSWORD, client, setup  # noqa: F401  (setup is a fixture)
from tests.test_ssh import PASSWORD as SSH_PASSWORD, api, authenticate, fake_server, library, socket_headers, until  # noqa: F401

HOUR = 3600
DAY = 86400
YEAR = 365 * DAY


@pytest.fixture
def clock(setup, monkeypatch):
    """accounts' own clock, so a year can pass in a test."""
    setup.settings.accounts_remember_days = 365
    state = SimpleNamespace(now=time.time())
    monkeypatch.setattr(accounts, "time", SimpleNamespace(time=lambda: state.now))
    return state


def session_cookies(response):
    return [value for value in response.headers.get_list("set-cookie") if value.startswith(accounts.COOKIE + "=")]


def max_age(cookie):
    return int(re.search(r"Max-Age=(-?\d+)", cookie, re.I).group(1))


async def login(c, username="admin", password=PASSWORD, **extra):
    r = await c.post("/api/auth/login", json={"username": username, "password": password, **extra})
    assert r.status_code == 200, r.text
    c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
    return r


async def rows(setup, user_id="initial-admin"):
    async with setup.sessions() as db:
        return (await db.scalars(select(UserSession).where(UserSession.user_id == user_id))).all()


def update_counter(setup):
    engine = setup.sessions.kw["bind"].sync_engine
    seen = []

    def count(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("UPDATE USER_SESSIONS"): seen.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    return seen


async def test_kept_session_outlives_session_hours_and_slides_while_used(setup, clock):
    async with client(setup) as c:
        r = await login(c, remember=True)
        [cookie] = session_cookies(r)
        assert max_age(cookie) == YEAR
        [row] = await rows(setup)
        assert row.remember and row.renewed_at == clock.now and row.expires_at == clock.now + YEAR

        clock.now += 13 * HOUR   # past ACCOUNTS_SESSION_HOURS (12)
        r = await c.get("/api/rack-items")
        assert r.status_code == 200
        [cookie] = session_cookies(r)
        assert max_age(cookie) == YEAR and r.headers["cache-control"] == "private"
        [row] = await rows(setup)
        assert row.renewed_at == clock.now and row.expires_at == clock.now + YEAR

        clock.now += 364 * DAY   # unused for most of a year: still signed in, and renewed again
        assert (await c.get("/api/me")).status_code == 200
        clock.now += 364 * DAY
        assert (await c.get("/api/me")).status_code == 200

        clock.now += YEAR        # a full year without any use ends it
        r = await c.get("/api/me")
        assert r.status_code == 401 and not session_cookies(r)


@pytest.mark.parametrize("extra", [{}, {"remember": False}])
async def test_unchecked_sign_in_keeps_the_short_session(setup, clock, extra):
    async with client(setup) as c:
        r = await login(c, **extra)
        [cookie] = session_cookies(r)
        assert max_age(cookie) == 12 * HOUR
        [row] = await rows(setup)
        assert not row.remember and row.expires_at == clock.now + 12 * HOUR
        expires = row.expires_at

        clock.now += 11 * HOUR
        r = await c.get("/api/rack-items")
        assert r.status_code == 200 and not session_cookies(r)
        [row] = await rows(setup)
        assert row.expires_at == expires   # never extended

        clock.now += HOUR
        assert (await c.get("/api/rack-items")).status_code == 401


async def test_renewal_is_written_at_most_once_an_hour(setup, clock):
    async with client(setup) as c:
        await login(c, remember=True)
        [row] = await rows(setup)
        issued = row.renewed_at
        updates = update_counter(setup)

        clock.now += HOUR - 1
        for _ in range(3):
            r = await c.get("/api/rack-items")
            assert r.status_code == 200 and not session_cookies(r)
        assert updates == []
        assert (await rows(setup))[0].renewed_at == issued

        clock.now += 1
        r = await c.get("/api/rack-items")
        assert max_age(session_cookies(r)[0]) == YEAR
        assert len(updates) == 1 and (await rows(setup))[0].renewed_at == clock.now
        renewed = clock.now

        clock.now += 30 * 60
        for _ in range(3):
            assert not session_cookies(await c.get("/api/rack-items"))
        assert len(updates) == 1 and (await rows(setup))[0].renewed_at == renewed

        # Requests arriving together: one renews, the others see it and leave the row alone.
        clock.now += HOUR
        responses = await asyncio.gather(*(c.get("/api/rack-items") for _ in range(6)))
        assert all(r.status_code == 200 for r in responses)
        assert sum(len(session_cookies(r)) for r in responses) == 1
        [row] = await rows(setup)
        assert row.renewed_at == clock.now and row.expires_at == clock.now + YEAR


async def test_a_failed_renewal_write_never_fails_the_request(setup, clock, monkeypatch):
    """A database that cannot take the renewal write (locked past its timeout, disk full, read-only) must not turn
    every kept session's requests into 500s: renewal is best effort and is not retried on every request."""
    from sqlalchemy.exc import OperationalError
    factory = accounts.AsyncSessionLocal
    commits = []

    def failing():
        session = factory()

        async def commit():
            commits.append(clock.now)
            raise OperationalError("UPDATE user_sessions", {}, Exception("database is locked"))
        session.commit = commit
        return session

    async with client(setup) as c:
        await login(c, remember=True)
        [row] = await rows(setup)
        issued = (row.renewed_at, row.expires_at)
        clock.now += 13 * HOUR   # due for renewal
        monkeypatch.setattr(accounts, "AsyncSessionLocal", failing)
        r = await c.get("/api/rack-items")
        assert r.status_code == 200 and not session_cookies(r)
        assert len(commits) == 1
        for _ in range(3):   # not retried on every request while the database is failing
            r = await c.get("/api/rack-items")
            assert r.status_code == 200 and not session_cookies(r)
        assert len(commits) == 1
        monkeypatch.setattr(accounts, "AsyncSessionLocal", factory)
        [row] = await rows(setup)
        assert (row.renewed_at, row.expires_at) == issued   # nothing half-written

        clock.now += accounts.RENEW_RETRY_SECONDS   # the database recovered: the next request renews
        r = await c.get("/api/rack-items")
        assert r.status_code == 200 and max_age(session_cookies(r)[0]) == YEAR
        [row] = await rows(setup)
        assert row.renewed_at == clock.now and row.expires_at == clock.now + YEAR


async def test_admin_ends_a_users_sessions_without_changing_the_account(setup, clock):
    async with client(setup) as admin, client(setup) as tv, client(setup) as laptop, client(setup) as other:
        await login(admin, remember=True)
        await login(tv, "viewer", remember=True)
        await login(laptop, "viewer")
        await login(other, "operator", remember=True)
        # Only an Admin may, with the CSRF header, and not on themselves.
        assert (await tv.post("/api/users/operator/end-sessions")).status_code == 403
        assert (await other.post("/api/users/viewer/end-sessions")).status_code == 403
        csrf = admin.headers.pop("X-DCIM-CSRF")
        assert (await admin.post("/api/users/viewer/end-sessions")).status_code == 403
        admin.headers["X-DCIM-CSRF"] = csrf
        assert (await admin.post("/api/users/initial-admin/end-sessions")).status_code == 400
        assert (await admin.post("/api/users/nobody/end-sessions")).status_code == 404
        assert len(await rows(setup, "viewer")) == 2

        r = await admin.post("/api/users/viewer/end-sessions")
        assert r.status_code == 200 and r.json() == {"ended": 2}
        assert (await tv.get("/api/me")).status_code == 401
        assert (await laptop.get("/api/me")).status_code == 401
        assert await rows(setup, "viewer") == []
        assert (await other.get("/api/me")).status_code == 200   # other users keep their sessions
        assert (await admin.get("/api/me")).status_code == 200
        async with setup.sessions() as db:   # the account itself is unchanged and can sign in again
            viewer = await db.get(accounts.User, "viewer")
            assert viewer.enabled and viewer.role == "Viewer" and not viewer.must_change_password
        await login(tv, "viewer", remember=True)
        assert (await tv.get("/api/me")).status_code == 200


async def test_sign_out_other_browsers_keeps_this_one(setup, clock):
    async with client(setup) as here, client(setup) as tv, client(setup) as laptop, client(setup) as admin:
        await login(here, "viewer", remember=True)
        await login(tv, "viewer", remember=True)
        await login(laptop, "viewer")
        await login(admin, remember=True)
        csrf = here.headers.pop("X-DCIM-CSRF")
        assert (await here.post("/api/me/end-other-sessions")).status_code == 403   # CSRF still required
        here.headers["X-DCIM-CSRF"] = csrf
        r = await here.post("/api/me/end-other-sessions")
        assert r.status_code == 200 and r.json() == {"ended": 2}
        assert (await here.get("/api/me")).status_code == 200
        assert (await tv.get("/api/me")).status_code == 401
        assert (await laptop.get("/api/me")).status_code == 401
        assert (await admin.get("/api/me")).status_code == 200   # another account is untouched
        [row] = await rows(setup, "viewer")
        assert row.remember
        r = await here.post("/api/me/end-other-sessions")
        assert r.status_code == 200 and r.json() == {"ended": 0}


async def test_renewal_never_puts_back_a_cookie_whose_session_ended_meanwhile(setup, clock, monkeypatch):
    """A slow request that won the renewal must not answer with the old token after this browser signed out, changed
    its password or signed in again while it was running: the browser would hold a dead cookie."""
    from sqlalchemy import delete
    original = accounts.renew

    async def renew_then_session_ends(current):
        seconds = await original(current)
        async with setup.sessions() as db:   # e.g. sign-out in another tab while this request waits on a device
            await db.execute(delete(UserSession).where(UserSession.token_hash == current["session_hash"]))
            await db.commit()
        return seconds

    async with client(setup) as c:
        await login(c, remember=True)
        clock.now += 2 * HOUR
        monkeypatch.setattr(accounts, "renew", renew_then_session_ends)
        r = await c.get("/api/rack-items")
        assert r.status_code == 200 and not session_cookies(r)
        monkeypatch.setattr(accounts, "renew", original)
        assert (await c.get("/api/me")).status_code == 401

    async with client(setup) as c:   # control: with the row still there the renewal cookie is sent
        await login(c, remember=True)
        clock.now += 2 * HOUR
        r = await c.get("/api/rack-items")
        assert r.status_code == 200 and max_age(session_cookies(r)[0]) == YEAR


async def test_remember_is_accepted_only_by_sign_in_and_sign_up(setup, clock):
    async with client(setup) as c:
        await login(c, remember=True)
        new = {"name": "TV", "username": "lab-display", "password": "a-long-password", "role": "Viewer"}
        r = await c.post("/api/users", json={**new, "remember": True})
        assert r.status_code == 422 and "remember" in r.text
        r = await c.post("/api/users", json=new)
        assert r.status_code in (200, 201), r.text
    async with client(setup) as tv:
        await login(tv, "lab-display", "a-long-password", remember=True)
        assert (await tv.get("/api/me")).status_code in (200, 403)


async def test_password_change_ends_other_kept_sessions_and_keeps_this_browser_kept(setup, clock):
    async with client(setup) as here, client(setup) as elsewhere, client(setup) as short:
        await login(here, remember=True)
        await login(elsewhere, remember=True)
        await login(short)
        old = here.cookies.get(accounts.COOKIE)
        clock.now += 2 * HOUR
        r = await here.put("/api/me/password", json={"current_password": PASSWORD, "new_password": "replacement-password"})
        assert r.status_code == 200
        [cookie] = session_cookies(r)   # only the new session's cookie, no renewal of the old one
        assert max_age(cookie) == YEAR and here.cookies.get(accounts.COOKIE) != old
        here.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        assert (await here.get("/api/me")).status_code == 200
        assert (await elsewhere.get("/api/me")).status_code == 401
        assert (await short.get("/api/me")).status_code == 401
        async with client(setup) as stale:
            stale.cookies.set(accounts.COOKIE, old)
            assert (await stale.get("/api/me")).status_code == 401
        [row] = await rows(setup)
        assert row.remember

    async with client(setup) as unchecked:   # an unchecked browser stays unchecked after its password change
        await login(unchecked, password="replacement-password")
        r = await unchecked.put("/api/me/password", json={"current_password": "replacement-password", "new_password": "another-password-1"})
        assert r.status_code == 200 and max_age(session_cookies(r)[0]) == 12 * HOUR


@pytest.mark.parametrize("action", ["logout", "disable", "role", "reset-password", "delete"])
async def test_sign_out_and_admin_changes_end_a_kept_session_at_once(setup, clock, action):
    async with client(setup) as admin, client(setup) as viewer:
        await login(admin, remember=True)
        await login(viewer, "viewer", remember=True)
        clock.now += 13 * HOUR   # both sessions are past the short lifetime and due for renewal
        assert (await admin.get("/api/me")).status_code == 200
        if action == "logout":
            r = await viewer.post("/api/auth/logout")
            assert r.status_code == 200
            [cookie] = session_cookies(r)   # the sign-out clears the cookie; no renewal is added beside it
            assert max_age(cookie) == 0
        elif action == "disable":
            assert (await admin.patch("/api/users/viewer", json={"enabled": False})).status_code == 200
        elif action == "role":
            assert (await admin.patch("/api/users/viewer", json={"role": "Operator"})).status_code == 200
        elif action == "reset-password":
            assert (await admin.post("/api/users/viewer/reset-password")).status_code == 200
        else:
            assert (await admin.delete("/api/users/viewer")).status_code == 200
        r = await viewer.get("/api/me")
        assert r.status_code == 401 and not session_cookies(r)
        assert await rows(setup, "viewer") == []


@pytest.mark.parametrize("https, secure_setting", [(False, False), (False, True), (True, False)])
async def test_cookie_attributes_and_csrf_token_survive_renewal(setup, clock, https, secure_setting):
    setup.settings.accounts_secure_cookie = secure_setting
    base = "https://test" if https else "http://test"
    async with AsyncClient(transport=ASGITransport(app=setup.app), base_url=base) as c:
        r = await login(c, remember=True)
        csrf = r.json()["csrf_token"]
        [issued] = session_cookies(r)
        token = c.cookies.get(accounts.COOKIE)
        assert ("Secure" in issued) == (https or secure_setting)
        # Sent by hand: an HTTP client never sends a Secure cookie back, whatever the server does with it.
        c.cookies.clear()
        c.headers["Cookie"] = f"{accounts.COOKIE}={token}"
        clock.now += 2 * HOUR
        r = await c.get("/api/auth/status")
        assert r.json()["csrf_token"] == csrf
        for cookie in session_cookies(r):
            assert cookie.startswith(f"{accounts.COOKIE}={token};")   # same name, same token
            assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
            assert ("Secure" in cookie) == (https or secure_setting)
            assert max_age(cookie) == YEAR
        assert len(session_cookies(r)) == 1 and r.headers["cache-control"] == "no-store"
        # The CSRF token is the one sign-in gave: writes keep working with it, and still need it.
        assert (await c.post("/api/rack-items", json={})).status_code == 200
        assert (await c.post("/api/rack-items", json={}, headers={"X-DCIM-CSRF": "wrong"})).status_code == 403


async def test_existing_session_table_gains_the_columns_in_place(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'old.db'}")
    async with engine.begin() as conn:
        await conn.exec_driver_sql("CREATE TABLE user_sessions (token_hash VARCHAR PRIMARY KEY, user_id VARCHAR, "
                                   "csrf_token VARCHAR, expires_at FLOAT)")
        await conn.exec_driver_sql("INSERT INTO user_sessions VALUES ('old', 'initial-admin', 'csrf', 1e12)")
    for _ in range(2):   # the upgrade runs on every start and is idempotent
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    async with engine.connect() as conn:
        columns = {row[1] for row in (await conn.execute(text("PRAGMA table_info(user_sessions)"))).all()}
    assert {"remember", "renewed_at"} <= columns
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        old = await db.get(UserSession, "old")
        assert old.remember is False and old.renewed_at == 0 and old.expires_at == 1e12   # a session from before stays short
    await engine.dispose()


async def test_ssh_terminal_keeps_its_own_cap_for_a_kept_session(api, library, monkeypatch):
    api.settings.accounts_remember_days = 365
    api.settings.ssh_max_session_seconds = 10 ** 9   # only ACCOUNTS_SESSION_HOURS caps the terminal here
    ssh_store.generate_key()
    seen = {}

    async def bridge(websocket, process, idle_seconds, current, counts, *, max_seconds=3600, audit_id=None):
        seen["max_seconds"] = max_seconds
        return "remote_closed"

    monkeypatch.setattr(ssh, "bridge", bridge)
    with TestClient(api.app) as c:
        r = c.post("/api/auth/login", json={"username": "operator", "password": SSH_PASSWORD, "remember": True})
        assert r.status_code == 200 and max_age(session_cookies(r)[0]) == YEAR
        c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        with fake_server(c, monkeypatch, library):
            with c.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as socket:
                authenticate(socket, c)
                until(socket, "connected")
                until(socket, "closed")
    assert 12 * HOUR - 300 <= seen["max_seconds"] <= 12 * HOUR
