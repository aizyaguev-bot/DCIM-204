"""
PDU maintenance shutdown/restore with server-side password re-confirmation.

The Raritan driver is replaced by an in-memory fake; no PDU is contacted.
"""
import asyncio, time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.routers.pdu_maintenance as pm
import app.routers.pdus as pdus_module
from app import accounts, pdu_locks
from app.database import Base, get_db
from app.models import AuthThrottle, Device, PduMaintenance, PduMaintenanceLog, User
from app.routers import devices, pdus, pdu_maintenance
from drivers.raritan_pdu import RaritanPduError

SHARED = "shared-lab-secret-91c2"
ACCOUNT_PASSWORD = "operator-own-secret-55d0"
SECRET = "synthetic-secret-7f3a"
SHUTDOWN = "/api/pdus/{}/maintenance/shutdown"
RESTORE = "/api/pdus/{}/maintenance/restore"


class FakePdu:
    def __init__(self, states, fail=(), unreachable=False):
        self.states = dict(states)
        self.fail = set(fail)
        self.unreachable = unreachable
        self.ignore = set()        # commands accepted but the outlet does not change
        self.lost = set()          # outlet switches, then the response is lost
        self.side_effects = {}     # outlet number -> callable run when it is switched
        self.hidden = set()        # outlets omitted from status reads
        self.calls = []
        self.reads = 0
        self.created = 0

    def __call__(self, ip, username, password):
        self.created += 1
        return self

    async def get_outlets(self):
        self.reads += 1
        if self.unreachable: raise httpx.ConnectTimeout(SECRET)
        return [{"number": n, "label": f"Outlet {n}", "state": s, "watts": None, "current": None, "voltage": None}
                for n, s in sorted(self.states.items()) if n not in self.hidden]

    async def get_inlet(self): return {}

    async def get_env_sensors(self): return {}

    async def set_outlet_state(self, number, action):
        if action not in ("on", "off", "cycle"): raise ValueError(action)
        self.calls.append((number, action))
        if number in self.fail: raise RaritanPduError("Device API responded with HTTP 503")
        if number in self.side_effects: self.side_effects[number]()
        if number not in self.ignore: self.states[number] = "off" if action == "off" else "on"
        if number in self.lost: raise httpx.ReadTimeout(SECRET)
        return True

    async def close(self): pass


@pytest.fixture(autouse=True)
def clear_maintenance_state(monkeypatch):
    # asyncio locks bind to the first event loop that waits on them; each test runs on its own loop.
    pdu_locks._locks.clear()
    monkeypatch.setattr(pm, "_confirm_lock", asyncio.Lock())
    yield
    pdu_locks._locks.clear()


@pytest.fixture
def settings(monkeypatch):
    value = SimpleNamespace(accounts_enabled=False, lab_manager_password=SHARED)
    monkeypatch.setattr(pm, "get_settings", lambda: value)
    return value


@pytest.fixture
async def mclient(db_session, settings):
    app = FastAPI()
    for module in (devices, pdus, pdu_maintenance): app.include_router(module.router)

    async def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def pdu_id(mclient):
    r = await mclient.post("/api/devices/", json={"name": "PDU-M", "kind": "pdu", "ip": "pdu.example.invalid",
                                                  "model": "PX4", "rack": "R1", "port_count": 4})
    return r.json()["id"]


@pytest.fixture
def fake(monkeypatch):
    driver = FakePdu({1: "on", 2: "off", 3: "on", 4: "on"})
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver)
    return driver


async def shutdown(c, dev_id, password=SHARED, reason="Rack rewiring"):
    return await c.post(SHUTDOWN.format(dev_id), json={"password": password, "reason": reason})


async def restore(c, dev_id, password=SHARED):
    return await c.post(RESTORE.format(dev_id), json={"password": password})


async def test_wrong_password_is_denied_logged_and_never_switches(mclient, pdu_id, fake):
    r = await shutdown(mclient, pdu_id, password="wrong-" + SECRET)
    assert r.status_code == 403 and r.json()["detail"] == "Password is incorrect"
    assert SECRET not in r.text and SHARED not in r.text
    assert fake.created == 0 and fake.reads == 0 and fake.calls == []
    listing = (await mclient.get("/api/pdus/maintenance")).json()
    assert listing["password_mode"] == "shared" and listing["pdus"] == {}
    assert [(e["action"], e["device_id"], e["by"], e["reason"]) for e in listing["log"]] == [("denied", pdu_id, "shared-password", "shutdown")]
    assert SECRET not in str(listing) and SHARED not in str(listing)


async def test_shutdown_switches_off_only_on_outlets_and_persists_restore_list(mclient, pdu_id, fake):
    pdus_module._cache[pdu_id] = (time.monotonic(), object())
    r = await shutdown(mclient, pdu_id, reason="  Rack rewiring  ")
    assert r.status_code == 200, r.text
    body = r.json()
    assert fake.calls == [(1, "off"), (3, "off"), (4, "off")]
    assert body["results"] == [{"outlet": 1, "ok": True}, {"outlet": 3, "ok": True}, {"outlet": 4, "ok": True}]
    state = body["state"]
    assert state["device_id"] == pdu_id and state["outlets_off"] == [1, 3, 4] and state["failed"] == []
    assert state["started_by"] == "shared-password" and state["reason"] == "Rack rewiring"
    assert isinstance(state["started_at"], float)
    assert pdu_id not in pdus_module._cache
    assert SHARED not in r.text
    listing = (await mclient.get("/api/pdus/maintenance")).json()
    assert listing["pdus"] == {pdu_id: state}
    entry = listing["log"][0]
    assert {k: entry[k] for k in ("action", "by", "reason", "ok", "failed")} == \
           {"action": "shutdown", "by": "shared-password", "reason": "Rack rewiring", "ok": 3, "failed": 0}


async def test_restore_turns_on_only_saved_outlets_and_clears_state(mclient, pdu_id, fake):
    await shutdown(mclient, pdu_id)
    fake.calls.clear()
    r = await restore(mclient, pdu_id)
    assert r.status_code == 200, r.text
    assert r.json() == {"state": None, "results": [{"outlet": n, "ok": True} for n in (1, 3, 4)]}
    assert fake.calls == [(1, "on"), (3, "on"), (4, "on")]
    assert fake.states[2] == "off"
    listing = (await mclient.get("/api/pdus/maintenance")).json()
    assert listing["pdus"] == {}
    assert [e["action"] for e in listing["log"]] == ["restore", "shutdown"]
    assert listing["log"][0]["reason"] == "Rack rewiring" and listing["log"][0]["ok"] == 3


async def test_double_shutdown_and_restore_without_maintenance_conflict(mclient, pdu_id, fake):
    r = await restore(mclient, pdu_id)
    assert r.status_code == 409 and r.json()["detail"] == "PDU is not in maintenance mode"
    assert (await shutdown(mclient, pdu_id)).status_code == 200
    fake.calls.clear()
    r = await shutdown(mclient, pdu_id)
    assert r.status_code == 409 and r.json()["detail"] == "PDU is already in maintenance mode"
    assert fake.calls == []


async def test_outlet_on_and_cycle_blocked_during_maintenance_but_off_allowed(mclient, pdu_id, fake):
    power = f"/api/pdus/{pdu_id}/outlets/2/power"
    await shutdown(mclient, pdu_id)
    fake.calls.clear()
    for action in ("on", "cycle"):
        r = await mclient.post(power, json={"action": action})
        assert r.status_code == 409
        assert r.json()["detail"] == "PDU is in maintenance mode; restore it first"
    assert fake.calls == []
    assert (await mclient.post(power, json={"action": "off"})).status_code == 200
    assert fake.calls == [(2, "off")]
    await restore(mclient, pdu_id)
    assert (await mclient.post(power, json={"action": "on"})).status_code == 200


async def test_partial_failures_keep_state_with_failed_list(mclient, pdu_id, fake):
    fake.fail = {3}
    r = await shutdown(mclient, pdu_id)
    assert r.status_code == 200
    assert r.json()["state"]["outlets_off"] == [1, 3, 4] and r.json()["state"]["failed"] == [3]
    assert {"outlet": 3, "ok": False} in r.json()["results"]
    assert (await mclient.get("/api/pdus/maintenance")).json()["log"][0]["failed"] == 1

    fake.fail = {4}
    fake.calls.clear()
    r = await restore(mclient, pdu_id)
    assert r.status_code == 200
    assert fake.calls == [(1, "on"), (3, "on"), (4, "on")]
    assert r.json()["state"]["failed"] == [4] and r.json()["state"]["outlets_off"] == [4]
    assert (await mclient.get("/api/pdus/maintenance")).json()["pdus"][pdu_id]["failed"] == [4]

    fake.fail = set()
    fake.calls.clear()
    r = await restore(mclient, pdu_id)
    assert r.json()["state"] is None and fake.calls == [(4, "on")]


async def test_unknown_or_cycling_outlets_are_reported_failed_and_never_restored(mclient, pdu_id, fake):
    fake.states = {1: "on", 2: "unknown", 3: "cycling"}
    r = await shutdown(mclient, pdu_id)
    assert r.json()["state"]["outlets_off"] == [1] and r.json()["state"]["failed"] == [2, 3]
    assert fake.calls == [(1, "off")]
    fake.calls.clear()
    await restore(mclient, pdu_id)
    assert fake.calls == [(1, "on")]


async def test_unreachable_pdu_before_switching_is_502_without_state(mclient, pdu_id, fake):
    fake.unreachable = True
    r = await shutdown(mclient, pdu_id)
    assert r.status_code == 502 and "ConnectTimeout" in r.json()["detail"]
    assert SECRET not in r.text and SHARED not in r.text
    assert fake.calls == []
    listing = (await mclient.get("/api/pdus/maintenance")).json()
    assert listing["pdus"] == {} and listing["log"] == []

    fake.unreachable = False
    fake.states = {1: "unknown", 2: "unknown"}
    r = await shutdown(mclient, pdu_id)
    assert r.status_code == 502 and fake.calls == []
    assert (await mclient.get("/api/pdus/maintenance")).json()["pdus"] == {}


async def test_no_password_configured_is_unavailable(mclient, pdu_id, fake, settings):
    settings.lab_manager_password = ""
    assert (await mclient.get("/api/pdus/maintenance")).json()["password_mode"] == "unavailable"
    for r in (await shutdown(mclient, pdu_id, password="anything"), await restore(mclient, pdu_id, password="anything")):
        assert r.status_code == 403 and r.json()["detail"] == "Maintenance actions require a configured password"
    assert fake.created == 0


async def test_invalid_bodies_are_rejected_without_echo(mclient, pdu_id, fake):
    url = SHUTDOWN.format(pdu_id)
    long_password = SECRET * 20
    cases = [
        {"password": long_password, "reason": "x"},
        {"password": SECRET, "reason": "   "},
        {"password": SECRET, "reason": "r" * 201},
        {"password": SECRET},
        {"password": 12345, "reason": "x"},
        {"reason": "x"},
        [SECRET],
        SECRET,
    ]
    for body in cases:
        r = await mclient.post(url, json=body)
        assert r.status_code == 400, (body, r.text)
        assert SECRET not in r.text and "12345" not in r.text
    r = await mclient.post(url, content=b"{" + SECRET.encode(), headers={"content-type": "application/json"})
    assert r.status_code == 400 and SECRET not in r.text
    r = await mclient.post(RESTORE.format(pdu_id), json={"password": long_password})
    assert r.status_code == 400 and SECRET not in r.text
    assert fake.created == 0
    assert (await mclient.get("/api/pdus/maintenance")).json()["log"] == []


async def test_shared_password_failures_are_throttled(mclient, pdu_id, fake):
    for _ in range(pm.FAILURE_LIMIT):
        assert (await shutdown(mclient, pdu_id, password="wrong")).status_code == 403
    r = await shutdown(mclient, pdu_id)
    assert r.status_code == 429 and r.headers["retry-after"] == "300"
    assert fake.created == 0


async def test_shared_password_successes_do_not_consume_budget(mclient, pdu_id, fake):
    for _ in range(pm.FAILURE_LIMIT + 2):
        assert (await shutdown(mclient, pdu_id)).status_code == 200
        assert (await restore(mclient, pdu_id)).status_code == 200


async def test_reason_with_control_characters_is_rejected(mclient, pdu_id, fake):
    for reason in ("a\x00b", "line\nbreak", "tab\there", "del\x7f", "\x1b[31mred"):
        r = await shutdown(mclient, pdu_id, reason=reason)
        assert r.status_code == 400 and r.json()["detail"] == "Reason contains unsupported characters"
        assert SHARED not in r.text
    assert fake.created == 0


async def test_post_switch_reread_reports_outlets_still_powered(mclient, pdu_id, fake):
    fake.ignore = {4}                                          # device accepts "off" but stays on
    fake.side_effects = {1: lambda: fake.states.update({2: "on"})}  # another worker powers outlet 2 meanwhile
    r = await shutdown(mclient, pdu_id)
    state = r.json()["state"]
    assert state["outlets_off"] == [1, 3, 4] and state["failed"] == [2, 4]
    assert r.json()["results"] == [{"outlet": 1, "ok": True}, {"outlet": 2, "ok": False},
                                   {"outlet": 3, "ok": True}, {"outlet": 4, "ok": False}]
    entry = (await mclient.get("/api/pdus/maintenance")).json()["log"][0]
    assert (entry["ok"], entry["failed"]) == (2, 2)

    fake.ignore, fake.side_effects = {3}, {}                   # "on" accepted but outlet 3 stays off
    r = await restore(mclient, pdu_id)
    assert r.json()["state"]["failed"] == [3] and r.json()["state"]["outlets_off"] == [3]
    assert {"outlet": 3, "ok": False} in r.json()["results"]


async def test_lost_switch_response_keeps_outlet_in_restore_list(mclient, pdu_id, fake):
    fake.lost = {3}                                            # outlet 3 turns off but the reply never arrives
    r = await shutdown(mclient, pdu_id)
    state = r.json()["state"]
    assert state["outlets_off"] == [1, 3, 4] and state["failed"] == []
    assert r.json()["results"] == [{"outlet": n, "ok": True} for n in (1, 3, 4)]
    assert fake.states[3] == "off" and SECRET not in r.text

    fake.lost, fake.calls = set(), []
    r = await restore(mclient, pdu_id)
    assert r.json()["state"] is None
    assert fake.calls == [(1, "on"), (3, "on"), (4, "on")] and fake.states[3] == "on"


async def test_restore_without_verification_read_keeps_state(mclient, pdu_id, fake):
    await shutdown(mclient, pdu_id)
    fake.unreachable, fake.calls = True, []                   # switching works, the verification read fails
    r = await restore(mclient, pdu_id)
    assert r.status_code == 200, r.text
    assert fake.calls == [(1, "on"), (3, "on"), (4, "on")]
    state = r.json()["state"]
    assert state is not None and state["outlets_off"] == [1, 3, 4] and state["failed"] == [1, 3, 4]
    assert r.json()["results"] == [{"outlet": n, "ok": False} for n in (1, 3, 4)]
    assert SECRET not in r.text
    listing = (await mclient.get("/api/pdus/maintenance")).json()
    assert listing["pdus"][pdu_id]["outlets_off"] == [1, 3, 4]
    assert (listing["log"][0]["action"], listing["log"][0]["ok"], listing["log"][0]["failed"]) == ("restore", 0, 3)

    fake.unreachable = False
    assert (await restore(mclient, pdu_id)).json()["state"] is None


async def test_outlets_missing_from_verification_read_are_not_restored(mclient, pdu_id, fake):
    await shutdown(mclient, pdu_id)
    fake.fail, fake.hidden = {1, 3, 4}, {1, 2, 3, 4}            # switching fails and the re-read lists no outlets
    r = await restore(mclient, pdu_id)
    assert r.status_code == 200, r.text
    assert r.json()["state"]["outlets_off"] == [1, 3, 4]
    assert r.json()["results"] == [{"outlet": n, "ok": False} for n in (1, 3, 4)]
    assert fake.states[1] == fake.states[3] == fake.states[4] == "off"

    fake.fail, fake.hidden = set(), set()
    assert (await restore(mclient, pdu_id)).json()["state"] is None


async def test_outlets_missing_from_shutdown_reread_are_reported_failed(mclient, pdu_id, fake):
    fake.side_effects = {1: lambda: fake.hidden.add(3)}
    r = await shutdown(mclient, pdu_id)
    assert r.status_code == 200, r.text
    assert r.json()["state"]["failed"] == [3]
    assert r.json()["state"]["outlets_off"] == [1, 3, 4]


def _maintenance_row(device_id):
    return PduMaintenance(device_id=device_id, started_at=time.time(), started_by=pm.SHARED_BY, reason="Concurrent",
                          outlets_off_json="[1, 3, 4]", failed_json="[]")


async def test_outlet_on_waits_for_shutdown_lock_then_conflicts(mclient, pdu_id, fake, db_session):
    async with pdu_locks.maintenance_lock(pdu_id):           # a shutdown is in progress
        task = asyncio.create_task(mclient.post(f"/api/pdus/{pdu_id}/outlets/2/power", json={"action": "on"}))
        await asyncio.sleep(0.2)
        assert not task.done() and fake.calls == []
        db_session.add(_maintenance_row(pdu_id))             # the shutdown commits its state
        await db_session.commit()
    r = await task
    assert r.status_code == 409
    assert r.json()["detail"] == "PDU is in maintenance mode; restore it first"
    assert fake.calls == [] and fake.states[2] == "off"


async def test_address_change_waits_for_shutdown_lock_then_conflicts(mclient, pdu_id, fake, db_session):
    url = f"/api/devices/{pdu_id}"
    base = {"name": "PDU-M", "kind": "pdu", "ip": "pdu.example.invalid", "model": "PX4", "rack": "R1", "port_count": 4}
    async with pdu_locks.maintenance_lock(pdu_id):
        task = asyncio.create_task(mclient.put(url, json={**base, "ip": "other.example.invalid"}))
        await asyncio.sleep(0.2)
        assert not task.done()
        db_session.add(_maintenance_row(pdu_id))
        await db_session.commit()
    r = await task
    assert r.status_code == 409 and r.json()["detail"] == "PDU is in maintenance mode; restore it first"
    dev = await db_session.scalar(select(Device).where(Device.id == pdu_id).execution_options(populate_existing=True))
    assert dev.ip == "pdu.example.invalid"

    async with pdu_locks.maintenance_lock(pdu_id):
        task = asyncio.create_task(mclient.delete(url))
        await asyncio.sleep(0.2)
        assert not task.done()
    assert (await task).status_code == 409


async def test_maintenance_uses_address_read_inside_the_lock(mclient, pdu_id, fake, db_session, monkeypatch):
    addresses = []

    def driver(ip, username, password):
        addresses.append(ip)
        return fake(ip, username, password)

    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver)
    async with pdu_locks.maintenance_lock(pdu_id):           # an address change commits while shutdown waits
        task = asyncio.create_task(shutdown(mclient, pdu_id))
        await asyncio.sleep(0.2)
        assert not task.done()
        # Bypasses the identity map, like a commit from another request's session.
        await db_session.execute(update(Device).where(Device.id == pdu_id).values(ip="moved.example.invalid")
                                 .execution_options(synchronize_session=False))
        await db_session.commit()
    assert (await task).status_code == 200
    assert addresses and set(addresses) == {"moved.example.invalid"}


async def test_attempts_over_the_limit_are_refunded(mclient, pdu_id, fake, db_session):
    for _ in range(pm.FAILURE_LIMIT):
        assert (await shutdown(mclient, pdu_id, password="wrong")).status_code == 403
    for _ in range(3):
        assert (await shutdown(mclient, pdu_id)).status_code == 429
    rows = (await db_session.scalars(select(AuthThrottle).execution_options(populate_existing=True))).all()
    assert [row.attempts for row in rows] == [pm.FAILURE_LIMIT]


async def test_audit_rows_exist_even_if_switching_raises(mclient, pdu_id, fake, monkeypatch):
    async def explode(*args): raise RuntimeError("switching crashed")
    monkeypatch.setattr(pm, "_switch", explode)
    with pytest.raises(RuntimeError):
        await shutdown(mclient, pdu_id)
    listing = (await mclient.get("/api/pdus/maintenance")).json()
    assert listing["pdus"][pdu_id]["outlets_off"] == [1, 3, 4]
    assert [(e["action"], e["ok"], e["failed"]) for e in listing["log"]] == [("shutdown", 0, 0)]
    with pytest.raises(RuntimeError):
        await restore(mclient, pdu_id)
    listing = (await mclient.get("/api/pdus/maintenance")).json()
    assert pdu_id in listing["pdus"]
    assert [(e["action"], e["ok"], e["failed"]) for e in listing["log"]] == [("restore", 0, 0), ("shutdown", 0, 0)]


async def test_log_is_pruned_to_newest_rows(mclient, pdu_id, fake, monkeypatch, db_session):
    monkeypatch.setattr(pm, "LOG_KEEP", 5)
    for _ in range(7):
        await shutdown(mclient, pdu_id, password="wrong")
    assert (await db_session.scalar(select(func.count()).select_from(PduMaintenanceLog))) == 5
    assert (await shutdown(mclient, pdu_id)).status_code == 200
    ids = (await db_session.scalars(select(PduMaintenanceLog.id).order_by(PduMaintenanceLog.id))).all()
    assert len(ids) == 5 and ids == list(range(ids[0], ids[0] + 5))
    assert (await mclient.get("/api/pdus/maintenance")).json()["log"][0]["action"] == "shutdown"


async def test_device_address_kind_change_and_delete_blocked_during_maintenance(mclient, pdu_id, fake):
    url = f"/api/devices/{pdu_id}"
    base = {"name": "PDU-M", "kind": "pdu", "ip": "pdu.example.invalid", "model": "PX4", "rack": "R1", "port_count": 4}
    await shutdown(mclient, pdu_id)
    for change in ({"ip": "other.example.invalid"}, {"kind": "kvm"}):
        r = await mclient.put(url, json={**base, **change})
        assert r.status_code == 409 and r.json()["detail"] == "PDU is in maintenance mode; restore it first"
    r = await mclient.delete(url)
    assert r.status_code == 409 and r.json()["detail"] == "PDU is in maintenance mode; restore it first"
    assert (await mclient.put(url, json={**base, "name": "PDU-M renamed"})).status_code == 200
    assert (await mclient.patch(f"{url}/labels", json={"1": "GPU-Node"})).status_code == 200
    await restore(mclient, pdu_id)
    assert (await mclient.put(url, json={**base, "ip": "other.example.invalid"})).status_code == 200
    assert (await mclient.delete(url)).status_code == 204


async def test_unknown_pdu_is_404(mclient, fake):
    assert (await shutdown(mclient, "missing")).status_code == 404
    assert (await restore(mclient, "missing")).status_code == 404


# -- Accounts mode -----------------------------------------------------------

@pytest.fixture
async def accounts_app(tmp_path, monkeypatch, fake):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'maintenance.db'}")
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    value = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                            accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=SHARED)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: value)
    monkeypatch.setattr(pm, "get_settings", lambda: value)
    password_hash = accounts.hash_password(ACCOUNT_PASSWORD)
    async with sessions() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role, password_hash=password_hash, created_at=time.time()))
        for n in range(1, 7):
            db.add(Device(id=f"pdu{n}", name=f"PDU {n:02}", kind="pdu", ip=f"pdu{n}.example.invalid", rack="R1", port_count=4))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    for router in (accounts.router, pdus.router, pdu_maintenance.router): app.include_router(router)

    async def _db():
        async with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = _db
    yield app
    await engine.dispose()


@asynccontextmanager
async def signed_in(app, username):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post("/api/auth/login", json={"username": username, "password": ACCOUNT_PASSWORD})
        assert r.status_code == 200, r.text
        c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        yield c


async def test_accounts_mode_uses_own_password_not_shared(accounts_app, fake):
    async with signed_in(accounts_app, "operator") as c:
        assert (await c.get("/api/pdus/maintenance")).json()["password_mode"] == "account"
        r = await shutdown(c, "pdu1", password=SHARED)
        assert r.status_code == 403 and fake.calls == []
        r = await shutdown(c, "pdu1", password=ACCOUNT_PASSWORD)
        assert r.status_code == 200 and r.json()["state"]["started_by"] == "operator"
        assert ACCOUNT_PASSWORD not in r.text
        r = await restore(c, "pdu1", password=ACCOUNT_PASSWORD)
        assert r.status_code == 200 and r.json()["state"] is None
        log = (await c.get("/api/pdus/maintenance")).json()["log"]
        assert [(e["action"], e["by"]) for e in log] == [("restore", "operator"), ("shutdown", "operator"), ("denied", "operator")]


async def test_accounts_mode_viewer_is_read_only(accounts_app, fake):
    async with signed_in(accounts_app, "viewer") as c:
        assert (await c.get("/api/pdus/maintenance")).status_code == 200
        for r in (await shutdown(c, "pdu1", password=ACCOUNT_PASSWORD), await restore(c, "pdu1", password=ACCOUNT_PASSWORD)):
            assert r.status_code == 403 and r.json()["detail"] == "Your role does not allow this action"
    assert fake.created == 0


async def test_accounts_mode_throttles_repeated_failures(accounts_app, fake):
    async with signed_in(accounts_app, "operator") as c:
        statuses = [(await shutdown(c, "pdu1", password="wrong")).status_code for _ in range(11)]
        assert statuses == [403] * 10 + [429]
        r = await shutdown(c, "pdu1", password=ACCOUNT_PASSWORD)
        assert r.status_code == 429
    assert fake.created == 0


async def test_concurrent_correct_passwords_after_nine_failures_are_not_throttled(accounts_app, fake):
    async with signed_in(accounts_app, "operator") as c:
        for _ in range(pm.FAILURE_LIMIT - 1):
            assert (await shutdown(c, "pdu1", password="wrong")).status_code == 403
        first, second = await asyncio.gather(shutdown(c, "pdu1", password=ACCOUNT_PASSWORD),
                                             shutdown(c, "pdu2", password=ACCOUNT_PASSWORD))
        assert (first.status_code, second.status_code) == (200, 200), (first.text, second.text)
        # The counter is back at nine: one more failure reaches the limit, the next attempt is throttled.
        assert (await shutdown(c, "pdu3", password="wrong")).status_code == 403
        assert (await shutdown(c, "pdu3", password=ACCOUNT_PASSWORD)).status_code == 429


async def test_failed_logins_do_not_block_maintenance(accounts_app, fake):
    async with signed_in(accounts_app, "operator") as c:
        assert (await shutdown(c, "pdu1", password=ACCOUNT_PASSWORD)).status_code == 200
        async with AsyncClient(transport=ASGITransport(app=accounts_app), base_url="http://test") as other:
            logins = [(await other.post("/api/auth/login", json={"username": "operator", "password": "wrong"})).status_code
                      for _ in range(11)]
        assert logins[-1] == 429
        assert (await restore(c, "pdu1", password=ACCOUNT_PASSWORD)).status_code == 200


async def test_successful_actions_do_not_consume_budget(accounts_app, fake):
    async with signed_in(accounts_app, "operator") as c:
        for n in range(1, 7):
            assert (await shutdown(c, f"pdu{n}", password=ACCOUNT_PASSWORD)).status_code == 200
            assert (await restore(c, f"pdu{n}", password=ACCOUNT_PASSWORD)).status_code == 200
