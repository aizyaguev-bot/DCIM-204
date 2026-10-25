"""
Regression tests for behaviour of PDU maintenance, the per-PDU lock registry and the engineer/owner
directory that the existing suites do not pin down.

Every PDU is an in-memory fake (no device, VM or live site is contacted); each test gets its own SQLite file
so concurrent requests use separate sessions, like the real server.
"""
import asyncio
import hashlib
import json
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import Depends, FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.routers.pdu_maintenance as pm
import app.routers.pdus as pdus_module
from app import accounts, confirm, engineers, inventory_store, pdu_locks
from app.database import Base, get_db
from app.models import AssetOwner, AuthThrottle, Device, Engineer, PduMaintenanceLog, User
from app.routers import devices, pdu_maintenance, pdus
from drivers.raritan_pdu import RaritanPduError

SHARED = "gap-shared-secret-4b7e"
SECRET = "gap-transport-secret-0c19"          # carried by fake transport exceptions; must never be echoed
CRED_USER = "gap-pdu-user"
CRED_PASSWORD = "gap-pdu-cred-secret-8d2a"
ACCOUNT_PASSWORD = "gap-operator-secret-61f3"
SHUTDOWN = "/api/pdus/{}/maintenance/shutdown"
RESTORE = "/api/pdus/{}/maintenance/restore"
DEFAULT_STATES = {1: "on", 2: "off", 3: "on", 4: "on"}


# -- Simulated PDUs -------------------------------------------------------------------------------------------

class FakePdu:
    def __init__(self, states):
        self.states = dict(states)
        self.fail = set()            # switch commands rejected by the device
        self.lost = set()            # outlet switches, then the response is lost
        self.side_effects = {}       # outlet number -> callable run when it is switched
        self.unreachable = False     # status reads time out
        self.calls = []
        self.reads = 0
        self.closed = 0

    async def get_outlets(self):
        self.reads += 1
        if self.unreachable: raise httpx.ConnectTimeout(SECRET)
        return [{"number": n, "label": f"Outlet {n}", "state": s, "watts": None, "current": None, "voltage": None}
                for n, s in sorted(self.states.items())]

    async def get_inlet(self): return {}

    async def get_env_sensors(self): return {}

    async def set_outlet_state(self, number, action):
        if action not in ("on", "off", "cycle"): raise ValueError(action)
        self.calls.append((number, action))
        if number in self.fail: raise RaritanPduError("Device API responded with HTTP 503")
        if number in self.side_effects: self.side_effects[number]()
        self.states[number] = "off" if action == "off" else "on"
        if number in self.lost: raise httpx.ReadTimeout(SECRET)
        return True

    async def close(self): self.closed += 1


class Fleet:
    """Stands in for RaritanPduDriver: one fake per address, recording every connection it hands out."""
    def __init__(self):
        self.pdus = {}
        self.opened = []

    def add(self, ip, states=DEFAULT_STATES):
        self.pdus[ip] = FakePdu(states)
        return self.pdus[ip]

    def __call__(self, ip, username, password):
        self.opened.append((ip, username, password))
        return self.pdus[ip]

    def closed(self):
        return sum(p.closed for p in self.pdus.values())


@pytest.fixture
async def env(tmp_path, monkeypatch):
    # asyncio locks bind to the loop that first waits on them; each test runs on its own loop.
    pdu_locks._locks.clear()
    monkeypatch.setattr(pm, "_confirm_lock", asyncio.Lock())
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'gap-maintenance.db'}")
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=False, lab_manager_password=SHARED)
    monkeypatch.setattr(pm, "get_settings", lambda: settings)
    fleet = Fleet()
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", fleet)
    async with sessions() as db:
        for name in ("a", "b", "c"):
            fleet.add(f"pdu-{name}.example.invalid")
            db.add(Device(id=f"pdu-{name}", name=f"PDU {name.upper()}", kind="pdu", ip=f"pdu-{name}.example.invalid",
                          rack="R1", port_count=4))
        db.add(Device(id="kvm-1", name="KVM 1", kind="kvm", ip="kvm-1.example.invalid", rack="R1", port_count=8))
        await db.commit()
    app = FastAPI()
    for module in (devices, pdus, pdu_maintenance): app.include_router(module.router)

    async def per_request_session():
        async with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = per_request_session

    def client(host="127.0.0.1"):
        return AsyncClient(transport=ASGITransport(app=app, client=(host, 40000)), base_url="http://test")

    yield SimpleNamespace(app=app, sessions=sessions, settings=settings, fleet=fleet, client=client,
                          pdu=lambda name: fleet.pdus[f"pdu-{name}.example.invalid"])
    pdu_locks._locks.clear()
    await engine.dispose()


async def shutdown(c, dev_id, password=SHARED, reason="Rack rewiring"):
    return await c.post(SHUTDOWN.format(dev_id), json={"password": password, "reason": reason})


async def restore(c, dev_id, password=SHARED, **extra):
    return await c.post(RESTORE.format(dev_id), json={"password": password, **extra})


async def listing(c):
    r = await c.get("/api/pdus/maintenance")
    assert r.status_code == 200
    return r.json()


async def throttle_rows(env):
    async with env.sessions() as db:
        return (await db.scalars(select(AuthThrottle))).all()


# -- Per-PDU lock registry ------------------------------------------------------------------------------------

async def test_lock_held_for_one_pdu_does_not_block_another(env):
    assert pdu_locks.maintenance_lock("pdu-a") is pdu_locks.maintenance_lock("pdu-a")
    assert pdu_locks.maintenance_lock("pdu-a") is not pdu_locks.maintenance_lock("pdu-b")
    async with env.client() as c:
        async with pdu_locks.maintenance_lock("pdu-a"):           # e.g. an outlet switch on PDU A is in progress
            r = await asyncio.wait_for(shutdown(c, "pdu-b"), timeout=10)
            assert r.status_code == 200, r.text
            waiting = asyncio.create_task(shutdown(c, "pdu-a"))
            await asyncio.sleep(0.2)
            assert not waiting.done() and env.pdu("a").calls == []
        r = await asyncio.wait_for(waiting, timeout=10)
        assert r.status_code == 200, r.text
        assert env.pdu("a").calls == [(1, "off"), (3, "off"), (4, "off")]


async def test_unknown_and_non_pdu_ids_get_404_and_no_lock_entry(env):
    async with env.client() as c:
        for dev_id in ("missing", "kvm-1"):
            for r in (await shutdown(c, dev_id), await restore(c, dev_id),
                      await c.post(f"/api/pdus/{dev_id}/outlets/1/power", json={"action": "on"})):
                assert r.status_code == 404 and r.json()["detail"] == "PDU not found"
        assert pdu_locks._locks == {} and env.fleet.opened == []
        assert (await listing(c))["log"] == []
        assert (await shutdown(c, "pdu-a")).status_code == 200
    assert set(pdu_locks._locks) == {"pdu-a"}


async def test_lock_is_released_after_every_error_path(env, monkeypatch):
    lock = pdu_locks.maintenance_lock("pdu-a")
    async with env.client() as c:
        assert (await shutdown(c, "pdu-a", password="wrong")).status_code == 403
        assert not lock.locked()
        env.pdu("a").unreachable = True
        assert (await shutdown(c, "pdu-a")).status_code == 502
        assert not lock.locked()
        env.pdu("a").unreachable = False
        assert (await shutdown(c, "pdu-a")).status_code == 200
        assert (await shutdown(c, "pdu-a")).status_code == 409
        assert not lock.locked()

        original, crashes = pm._switch, [RuntimeError("switching crashed")]

        async def crash_once(*args):
            if crashes: raise crashes.pop()
            return await original(*args)

        monkeypatch.setattr(pm, "_switch", crash_once)
        with pytest.raises(RuntimeError):
            await restore(c, "pdu-a")
        assert not lock.locked()
        r = await asyncio.wait_for(restore(c, "pdu-a"), timeout=10)
        assert r.status_code == 200 and r.json()["state"] is None


async def test_concurrent_shutdowns_switch_once_and_the_second_conflicts(env):
    async with env.client() as c:
        first, second = await asyncio.gather(shutdown(c, "pdu-a", reason="First"), shutdown(c, "pdu-a", reason="Second"))
        assert sorted((first.status_code, second.status_code)) == [200, 409], (first.text, second.text)
        loser = first if first.status_code == 409 else second
        assert loser.json()["detail"] == "PDU is already in maintenance mode"
        assert env.pdu("a").calls == [(1, "off"), (3, "off"), (4, "off")]
        data = await listing(c)
        assert data["pdus"]["pdu-a"]["outlets_off"] == [1, 3, 4]
        assert [e["action"] for e in data["log"]] == ["shutdown"]


# -- Shutdown and restore edge cases --------------------------------------------------------------------------

async def test_shutdown_with_every_outlet_already_off_then_restore_touches_nothing(env):
    pdu = env.pdu("a")
    pdu.states = {1: "off", 2: "off"}
    async with env.client() as c:
        r = await shutdown(c, "pdu-a")
        assert r.status_code == 200, r.text
        assert r.json()["results"] == []
        assert (r.json()["state"]["outlets_off"], r.json()["state"]["failed"]) == ([], [])
        assert pdu.calls == []
        opened = len(env.fleet.opened)
        r = await restore(c, "pdu-a")
        assert r.status_code == 200 and r.json() == {"state": None, "results": []}
        assert len(env.fleet.opened) == opened and pdu.calls == []  # nothing to switch, nothing to re-read
        data = await listing(c)
        assert data["pdus"] == {}
        assert [(e["action"], e["ok"], e["failed"]) for e in data["log"]] == [("restore", 0, 0), ("shutdown", 0, 0)]


async def test_reachable_pdu_without_outlets_is_502_and_records_nothing(env):
    env.pdu("a").states = {}
    async with env.client() as c:
        r = await shutdown(c, "pdu-a")
        assert r.status_code == 502 and r.json()["detail"] == "Device API returned no usable outlet states"
        data = await listing(c)
        assert data["pdus"] == {} and data["log"] == []


async def test_shutdown_without_verification_read_falls_back_to_switch_results(env):
    pdu = env.pdu("a")
    pdu.states = {1: "on", 2: "cycling", 3: "on", 4: "on"}
    pdu.fail, pdu.lost = {3}, {4}
    pdu.side_effects = {1: lambda: setattr(pdu, "unreachable", True)}   # the PDU stops answering mid-shutdown
    async with env.client() as c:
        r = await shutdown(c, "pdu-a")
        assert r.status_code == 200, r.text
        state = r.json()["state"]
        # Rejected (3), lost (4) and cycling (2) outlets all count as failed; every powered outlet stays restorable.
        assert state["outlets_off"] == [1, 3, 4] and state["failed"] == [2, 3, 4]
        assert r.json()["results"] == [{"outlet": 1, "ok": True}, {"outlet": 2, "ok": False},
                                       {"outlet": 3, "ok": False}, {"outlet": 4, "ok": False}]
        assert SECRET not in r.text
        entry = (await listing(c))["log"][0]
        assert (entry["action"], entry["ok"], entry["failed"]) == ("shutdown", 1, 3)

        pdu.fail, pdu.lost, pdu.side_effects, pdu.unreachable, pdu.calls = set(), set(), {}, False, []
        r = await restore(c, "pdu-a")
        assert r.status_code == 200 and r.json()["state"] is None
        assert pdu.calls == [(1, "on"), (3, "on"), (4, "on")]
        assert pdu.states[4] == "on" and pdu.states[2] == "cycling"     # the cycling outlet is never touched


async def test_driver_gets_decrypted_credentials_and_every_connection_is_closed(env):
    ip = "pdu-creds.example.invalid"
    pdu = env.fleet.add(ip)
    async with env.client() as c:
        r = await c.post("/api/devices/", json={"name": "PDU-CREDS", "kind": "pdu", "ip": ip, "model": "PX4", "rack": "R2",
                                                "port_count": 4, "username": CRED_USER, "password": CRED_PASSWORD})
        assert r.status_code == 201, r.text
        dev_id = r.json()["id"]
        async with env.sessions() as db:
            stored = await db.get(Device, dev_id)
            assert CRED_PASSWORD not in stored.password_enc and CRED_USER not in stored.username_enc
        pdu.unreachable = True
        bodies = [await shutdown(c, dev_id)]
        assert bodies[0].status_code == 502
        pdu.unreachable, pdu.fail = False, {1}                          # a switch error must not leak the session
        bodies.append(await shutdown(c, dev_id))
        pdu.fail = set()
        bodies.append(await restore(c, dev_id))
        assert [r.status_code for r in bodies] == [502, 200, 200]
        bodies.append(await c.get("/api/pdus/maintenance"))
    assert env.fleet.opened and set(env.fleet.opened) == {(ip, CRED_USER, CRED_PASSWORD)}
    assert env.fleet.closed() == len(env.fleet.opened)
    for r in bodies:
        assert CRED_PASSWORD not in r.text and SECRET not in r.text and SHARED not in r.text


async def test_restore_logs_the_original_reason_and_ignores_a_body_reason(env):
    async with env.client() as c:
        assert (await shutdown(c, "pdu-a", reason="Swap PSU")).status_code == 200
        r = await restore(c, "pdu-a", reason="ignored\x00reason")       # restore takes no reason, so none is parsed
        assert r.status_code == 200 and r.json()["state"] is None
        log = (await listing(c))["log"]
        assert [(e["action"], e["reason"]) for e in log] == [("restore", "Swap PSU"), ("shutdown", "Swap PSU")]


async def test_denied_restore_is_logged_and_keeps_state_cache_and_outlets(env):
    async with env.client() as c:
        assert (await shutdown(c, "pdu-a")).status_code == 200
        env.pdu("a").calls.clear()
        cached = (time.monotonic(), object())
        pdus_module._cache["pdu-a"] = cached
        r = await restore(c, "pdu-a", password="wrong-" + SECRET)
        assert r.status_code == 403 and r.json()["detail"] == "Password is incorrect" and SECRET not in r.text
        assert env.pdu("a").calls == [] and pdus_module._cache["pdu-a"] is cached
        data = await listing(c)
        assert data["pdus"]["pdu-a"]["outlets_off"] == [1, 3, 4]
        assert {k: data["log"][0][k] for k in ("action", "device_id", "by", "reason", "ok", "failed")} == \
               {"action": "denied", "device_id": "pdu-a", "by": "shared-password", "reason": "restore", "ok": 0, "failed": 0}
        assert SECRET not in json.dumps(data)

        r = await restore(c, "pdu-a")
        assert r.status_code == 200 and "pdu-a" not in pdus_module._cache   # a real restore invalidates the cache


async def test_state_conflicts_are_checked_before_the_password_and_cost_no_attempt(env):
    async with env.client() as c:
        r = await restore(c, "pdu-a", password="wrong")
        assert r.status_code == 409 and r.json()["detail"] == "PDU is not in maintenance mode"
        assert await throttle_rows(env) == [] and (await listing(c))["log"] == []
        assert (await shutdown(c, "pdu-a")).status_code == 200
        r = await shutdown(c, "pdu-a", password="wrong")
        assert r.status_code == 409 and r.json()["detail"] == "PDU is already in maintenance mode"
        assert [row.attempts for row in await throttle_rows(env)] == [0]
        assert [e["action"] for e in (await listing(c))["log"]] == ["shutdown"]


# -- Password re-confirmation and throttle --------------------------------------------------------------------

async def test_password_and_reason_boundaries(env):
    async with env.client() as c:
        for padded in (f" {SHARED}", f"{SHARED} ", f"{SHARED}\n"):           # passwords are never trimmed
            r = await shutdown(c, "pdu-a", password=padded)
            assert r.status_code == 403 and r.json()["detail"] == "Password is incorrect"
        assert env.pdu("a").calls == []
        env.settings.lab_manager_password = "p" * pm.MAX_PASSWORD
        r = await shutdown(c, "pdu-a", password="")
        assert r.status_code == 400 and r.json()["detail"] == "Password is required"
        r = await c.post(SHUTDOWN.format("pdu-a"), json={"password": "p" * pm.MAX_PASSWORD, "reason": 123})
        assert r.status_code == 400 and r.json()["detail"] == f"Reason is required (1–{pm.MAX_REASON} characters)"
        r = await shutdown(c, "pdu-a", password="p" * pm.MAX_PASSWORD, reason="  " + "r" * pm.MAX_REASON + "  ")
        assert r.status_code == 200, r.text
        assert r.json()["state"]["reason"] == "r" * pm.MAX_REASON
        assert [e["action"] for e in (await listing(c))["log"]] == ["shutdown", "denied", "denied", "denied"]


async def test_shared_throttle_is_per_client_address_and_stores_only_a_digest(env):
    async with env.client("10.0.0.1") as attacker, env.client("10.0.0.2") as operator:
        for _ in range(pm.FAILURE_LIMIT):
            assert (await shutdown(attacker, "pdu-a", password="wrong")).status_code == 403
        r = await shutdown(attacker, "pdu-a")
        assert r.status_code == 429 and r.headers["retry-after"] == "300"
        r = await shutdown(operator, "pdu-a")
        assert r.status_code == 200, r.text
    rows = {row.key: row.attempts for row in await throttle_rows(env)}
    digest = lambda host: hashlib.sha256(f"maint:client:{host}".encode()).hexdigest()
    assert rows == {digest("10.0.0.1"): pm.FAILURE_LIMIT, digest("10.0.0.2"): 0}
    assert env.pdu("a").calls == [(1, "off"), (3, "off"), (4, "off")]


async def test_shared_throttle_budget_spans_pdus_and_actions(env):
    async with env.client() as c:
        assert (await shutdown(c, "pdu-b")).status_code == 200          # successes are refunded
        for _ in range(pm.FAILURE_LIMIT):
            assert (await shutdown(c, "pdu-a", password="wrong")).status_code == 403
        assert (await shutdown(c, "pdu-c")).status_code == 429          # another PDU does not reset the budget
        assert (await restore(c, "pdu-b")).status_code == 429           # nor does another action
        data = await listing(c)
        assert set(data["pdus"]) == {"pdu-b"}
        assert env.pdu("c").calls == [] and env.pdu("b").calls == [(1, "off"), (3, "off"), (4, "off")]


async def test_throttle_window_expiry_restores_the_budget(env):
    async with env.client() as c:
        for _ in range(pm.FAILURE_LIMIT):
            assert (await shutdown(c, "pdu-a", password="wrong")).status_code == 403
        assert (await shutdown(c, "pdu-a")).status_code == 429
        async with env.sessions() as db:                                # the five-minute window has passed
            await db.execute(update(AuthThrottle).values(window_at=time.time() - pm.FAILURE_WINDOW - 5))
            await db.commit()
        r = await shutdown(c, "pdu-a")
        assert r.status_code == 200, r.text
        assert [row.attempts for row in await throttle_rows(env)] == [0]
        assert (await shutdown(c, "pdu-b", password="wrong")).status_code == 403   # a fresh window, not the old count


# -- Audit log ------------------------------------------------------------------------------------------------

async def test_listing_returns_newest_entries_up_to_the_limit_across_pdus(env, monkeypatch):
    monkeypatch.setattr(pm, "LOG_LIMIT", 3)
    async with env.client() as c:
        for dev_id in ("pdu-a", "pdu-b", "pdu-a", "pdu-b"):
            assert (await shutdown(c, dev_id, password="wrong")).status_code == 403
        assert (await shutdown(c, "pdu-c", reason="Fan swap")).status_code == 200
        data = await listing(c)
        assert [(e["action"], e["device_id"]) for e in data["log"]] == [("shutdown", "pdu-c"), ("denied", "pdu-b"),
                                                                        ("denied", "pdu-a")]
        assert [e["at"] for e in data["log"]] == sorted((e["at"] for e in data["log"]), reverse=True)
        assert set(data["pdus"]) == {"pdu-c"}
        assert (await shutdown(c, "pdu-a")).status_code == 200
        assert set((await listing(c))["pdus"]) == {"pdu-a", "pdu-c"}
    async with env.sessions() as db:
        assert await db.scalar(select(func.count()).select_from(PduMaintenanceLog)) == 6   # the limit is display-only


async def test_log_pruning_is_global_and_never_drops_active_maintenance(env, monkeypatch):
    monkeypatch.setattr(pm, "LOG_KEEP", 3)
    async with env.client() as c:
        assert (await shutdown(c, "pdu-a", reason="Long job")).status_code == 200
        for _ in range(3):
            assert (await shutdown(c, "pdu-b", password="wrong")).status_code == 403
        async with env.sessions() as db:
            rows = (await db.scalars(select(PduMaintenanceLog).order_by(PduMaintenanceLog.id))).all()
        assert [(row.action, row.device_id) for row in rows] == [("denied", "pdu-b")] * 3
        data = await listing(c)
        assert data["pdus"]["pdu-a"]["reason"] == "Long job"
        r = await restore(c, "pdu-a")
        assert r.status_code == 200 and r.json()["state"] is None
        log = (await listing(c))["log"]
        assert len(log) == 3 and (log[0]["action"], log[0]["device_id"], log[0]["reason"]) == ("restore", "pdu-a", "Long job")


# -- Accounts mode --------------------------------------------------------------------------------------------

async def test_account_mode_throttle_is_per_user(tmp_path, monkeypatch):
    pdu_locks._locks.clear()
    monkeypatch.setattr(pm, "_confirm_lock", asyncio.Lock())
    monkeypatch.setattr(confirm, "FAILURE_LIMIT", 2)                   # fewer slow scrypt checks, same rule
    fleet = Fleet()
    fleet.add("pdu-x.example.invalid")
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", fleet)
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'gap-accounts.db'}")
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    value = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                            accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=SHARED)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: value)
    monkeypatch.setattr(pm, "get_settings", lambda: value)
    password_hash = accounts.hash_password(ACCOUNT_PASSWORD)
    async with sessions() as db:
        for username in ("alice", "bruno"):
            db.add(User(id=username, username=username, name=username.title(), role="Operator",
                        password_hash=password_hash, created_at=time.time()))
        db.add(Device(id="pdu-x", name="PDU X", kind="pdu", ip="pdu-x.example.invalid", rack="R1", port_count=4))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    for router in (accounts.router, pdus.router, pdu_maintenance.router): app.include_router(router)

    async def per_request_session():
        async with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = per_request_session

    async def signed_in(username):
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        r = await c.post("/api/auth/login", json={"username": username, "password": ACCOUNT_PASSWORD})
        assert r.status_code == 200, r.text
        c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        return c

    alice, bruno = await signed_in("alice"), await signed_in("bruno")
    try:
        # Both users share one client address, so only a per-user key keeps Bruno's budget intact.
        for _ in range(confirm.FAILURE_LIMIT):
            assert (await shutdown(alice, "pdu-x", password="wrong")).status_code == 403
        assert (await shutdown(alice, "pdu-x", password=ACCOUNT_PASSWORD)).status_code == 429
        r = await shutdown(bruno, "pdu-x", password=ACCOUNT_PASSWORD)
        assert r.status_code == 200, r.text
        assert r.json()["state"]["started_by"] == "bruno" and ACCOUNT_PASSWORD not in r.text
        async with sessions() as db:
            rows = {row.key: row.attempts for row in (await db.scalars(select(AuthThrottle))).all()}
        maint = lambda name: hashlib.sha256(f"maint:user:{name}".encode()).hexdigest()
        assert rows[maint("alice")] == confirm.FAILURE_LIMIT and rows[maint("bruno")] == 0
        log = (await alice.get("/api/pdus/maintenance")).json()["log"]
        assert [e["by"] for e in log] == ["bruno"] + ["alice"] * confirm.FAILURE_LIMIT
    finally:
        await alice.aclose()
        await bruno.aclose()
        pdu_locks._locks.clear()
        await engine.dispose()


# -- Engineer directory and owner rules -----------------------------------------------------------------------

@pytest.fixture
async def people(tmp_path, monkeypatch):
    import app.main as main
    saved = tmp_path / "opt_owners.json"
    items = tmp_path / "rack_items.json"
    monkeypatch.setattr(main, "_OPT_OWNERS_FILE", saved)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", items)
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'gap-people.db'}")
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(engineers, "AsyncSessionLocal", factory)
    app = FastAPI()
    app.include_router(engineers.router)

    async def dependency():
        async with factory() as db: yield db

    app.dependency_overrides[get_db] = dependency

    @app.get("/api/opt-owners")
    async def owners(db=Depends(get_db)): return await engineers.owner_map(db)

    app.put("/api/opt-owners")(main.save_opt_owners)
    yield SimpleNamespace(app=app, factory=factory, saved=saved, items=items,
                          client=lambda: AsyncClient(transport=ASGITransport(app=app), base_url="http://test"))
    await engine.dispose()


async def engineer_id(c, name):
    return next(p["id"] for p in (await c.get("/api/engineers")).json() if p["name"] == name)


async def test_bootstrap_links_legacy_and_inventory_owners_by_normalised_name(people):
    people.saved.write_text(json.dumps({"opt11": "  roy   MENDELSON ", "opt12": "Unknown Person", "item:srv3": "Eden Levi"}))
    people.items.write_text(json.dumps({"R1": [{"id": "srv1", "owner": "ADAM  cohen"}, {"id": "srv2", "owner": "Someone Else"},
                                               {"id": "srv3", "owner": "Liran Cohen"}, {"id": "srv4", "owner": ""},
                                               {"id": "srv5"}]}))
    before = people.saved.read_bytes(), people.items.read_bytes()
    await engineers.bootstrap_engineers()
    async with people.client() as c:
        assert (await c.get("/api/opt-owners")).json() == {
            "opt11": "Roy Mendelson", "opt12": "Unknown Person", "item:srv3": "Eden Levi",  # the owners file wins
            "item:srv1": "Adam Cohen", "item:srv2": "Someone Else"}
        roy, adam = await engineer_id(c, "Roy Mendelson"), await engineer_id(c, "Adam Cohen")
        async with people.factory() as db:
            rows = {row.asset_key: (row.engineer_id, row.legacy_name) for row in (await db.scalars(select(AssetOwner))).all()}
        assert rows["opt11"] == (roy, "") and rows["item:srv1"] == (adam, "")
        assert rows["opt12"] == (None, "Unknown Person") and "item:srv4" not in rows and "item:srv5" not in rows
        assert (await c.put(f"/api/engineers/{roy}", json={"name": "Roy M."})).status_code == 200
        assert (await c.get("/api/opt-owners")).json()["opt11"] == "Roy M."
    assert (people.saved.read_bytes(), people.items.read_bytes()) == before


@pytest.mark.parametrize("owners,items,detail", [
    ('["not", "a", "map"]', None, "Saved owner data has an invalid format; it was left unchanged"),
    ('{"opt1": 5}', None, "Saved owner data has an invalid format; it was left unchanged"),
    ('{"opt1": "Roy Mendelson"}', '{"R1": [{"owner": "Adam Cohen"}]}',
     "Equipment inventory contains an invalid item. No changes were saved."),
])
async def test_bootstrap_with_unreadable_owner_sources_seeds_nothing_until_repaired(people, owners, items, detail):
    people.saved.write_text(owners)
    if items: people.items.write_text(items)
    with pytest.raises(HTTPException) as failure:
        await engineers.bootstrap_engineers()
    assert failure.value.status_code == 503 and failure.value.detail == detail
    async with people.factory() as db:
        assert await db.scalar(select(func.count()).select_from(Engineer)) == 0
        assert await db.scalar(select(func.count()).select_from(AssetOwner)) == 0
    assert people.saved.read_text() == owners
    people.saved.write_text(json.dumps({"opt1": "roy mendelson"}))
    people.items.unlink(missing_ok=True)
    await engineers.bootstrap_engineers()                              # a later start imports the repaired data
    async with people.factory() as db:
        assert await db.scalar(select(func.count()).select_from(Engineer)) == len(engineers.INITIAL_NAMES)
        assert await engineers.owner_map(db) == {"opt1": "Roy Mendelson"}


async def test_engineer_names_are_normalised_and_validated(people):
    await engineers.bootstrap_engineers()
    assert engineers.name_key("Straße") == engineers.name_key("STRASSE")
    assert engineers.name_key("Ｒｏｙ　Ｍｅｎｄｅｌｓｏｎ") == engineers.name_key("roy mendelson")
    async with people.client() as c:
        assert (await c.post("/api/engineers", json={"name": "Ｒｏｙ　Ｍｅｎｄｅｌｓｏｎ"})).status_code == 409
        assert (await c.post("/api/engineers", json={"name": "Straße"})).status_code == 201
        assert (await c.post("/api/engineers", json={"name": "STRASSE"})).status_code == 409
        for body in ({"name": "Roy​Mendelson"}, {"name": "Bell\x07Ringer"}, {"name": "x" * 121},
                     {"name": "Extra Field", "team": "lab"}, {"name": ""}):
            assert (await c.post("/api/engineers", json=body)).status_code == 422, body
        r = await c.post("/api/engineers", json={"name": "  Dana \n\t  Levi  "})
        assert r.status_code == 201 and r.json()["name"] == "Dana Levi" and r.json()["active"] is True
        r = await c.post("/api/engineers", json={"name": "y" * 120})
        assert r.status_code == 201
        names = [p["name"] for p in (await c.get("/api/engineers")).json()]
        assert "Roy​Mendelson" not in names and "Extra Field" not in names
        assert names == sorted(names, key=engineers.name_key)          # listed case-insensitively
        assert len(names) == len(engineers.INITIAL_NAMES) + 3


async def test_edit_engineer_conflicts_missing_and_case_only_rename(people):
    await engineers.bootstrap_engineers()
    async with people.client() as c:
        r = await c.put("/api/engineers/does-not-exist", json={"name": "Nobody"})
        assert r.status_code == 404 and r.json()["detail"] == "Engineer not found"
        adam = await engineer_id(c, "Adam Cohen")
        assert (await c.put("/api/opt-owners/opt20", json={"engineer_id": adam})).status_code == 200
        r = await c.put(f"/api/engineers/{adam}", json={"name": "  roy  mendelson "})
        assert r.status_code == 409 and r.json()["detail"] == "Another engineer already uses this name"
        listed = {p["id"]: p["name"] for p in (await c.get("/api/engineers")).json()}
        assert listed[adam] == "Adam Cohen" and "Roy Mendelson" in listed.values()
        assert (await c.get("/api/opt-owners")).json()["opt20"] == "Adam Cohen"
        r = await c.put(f"/api/engineers/{adam}", json={"name": "ADAM cohen"})
        assert r.status_code == 200 and r.json() == {"id": adam, "name": "ADAM cohen", "active": True}
        assert (await c.get("/api/opt-owners")).json()["opt20"] == "ADAM cohen"


async def test_inactive_engineer_cannot_be_assigned_until_reactivated(people):
    await engineers.bootstrap_engineers()
    async with people.client() as c:
        r = await c.post("/api/engineers", json={"name": "Temp Tech", "active": False})
        assert r.status_code == 201 and r.json()["active"] is False
        temp = r.json()["id"]
        r = await c.put("/api/opt-owners/opt20", json={"engineer_id": temp})
        assert r.status_code == 409 and r.json()["detail"] == "Choose an active engineer from the list"
        assert "opt20" not in (await c.get("/api/opt-owners")).json()
        assert (await c.put(f"/api/engineers/{temp}", json={"name": "Temp Tech", "active": True})).status_code == 200
        r = await c.put("/api/opt-owners/opt20", json={"engineer_id": temp})
        assert r.status_code == 200 and r.json()["opt20"] == "Temp Tech"


async def test_owner_assignment_asset_key_rules(people):
    await engineers.bootstrap_engineers()
    async with people.client() as c:
        eden = await engineer_id(c, "Eden Levi")
        for key in ("%20%20", "k" * 201):
            r = await c.put(f"/api/opt-owners/{key}", json={"engineer_id": eden})
            assert r.status_code == 422 and r.json()["detail"] == "Invalid asset"
        assert (await c.put("/api/opt-owners/item:x", json={"engineer_id": "e" * 65})).status_code == 422
        assert (await c.put("/api/opt-owners/item:x", json={"engineer_id": eden, "note": "x"})).status_code == 422
        r = await c.put(f"/api/opt-owners/{'k' * 200}", json={"engineer_id": eden})
        assert r.status_code == 200 and r.json()["k" * 200] == "Eden Levi"
        r = await c.put("/api/opt-owners/item:rack/1", json={"engineer_id": eden})   # keys may contain slashes
        assert r.status_code == 200 and r.json()["item:rack/1"] == "Eden Levi"
        r = await c.put("/api/opt-owners/item:rack/1", json={"engineer_id": ""})     # empty id unassigns like null
        assert r.status_code == 200 and "item:rack/1" not in r.json() and r.json()["k" * 200] == "Eden Levi"
    async with people.factory() as db:
        assert " " * 2 not in {row.asset_key for row in (await db.scalars(select(AssetOwner))).all()}


async def test_bulk_owner_replace_links_by_normalised_name_and_clears_missing_assets(people):
    people.saved.write_text(json.dumps({"opt11": "Roy Mendelson", "opt12": "Existing unknown owner"}))
    await engineers.bootstrap_engineers()
    before = people.saved.read_bytes()
    async with people.client() as c:
        for payload in ({"opt11": 5}, {"opt11": "x" * 121}):
            r = await c.put("/api/opt-owners", json=payload)
            assert r.status_code == 422 and r.json()["detail"] == "Owner names must be text up to 120 characters"
        assert (await c.get("/api/opt-owners")).json() == {"opt11": "Roy Mendelson", "opt12": "Existing unknown owner"}
        r = await c.put("/api/opt-owners", json={"opt11": "  adam   COHEN ", "opt13": " Somebody New ", "opt14": "   "})
        assert r.status_code == 200 and r.json() == {"ok": True}
        # The canonical engineer name replaces the typed text; assets left out of the list (opt12) are cleared.
        assert (await c.get("/api/opt-owners")).json() == {"opt11": "Adam Cohen", "opt13": "Somebody New"}
        adam = await engineer_id(c, "Adam Cohen")
        assert (await c.put(f"/api/engineers/{adam}", json={"name": "Adam C."})).status_code == 200
        assert (await c.get("/api/opt-owners")).json() == {"opt11": "Adam C.", "opt13": "Somebody New"}
    assert people.saved.read_bytes() == before                           # the legacy file itself is never rewritten
