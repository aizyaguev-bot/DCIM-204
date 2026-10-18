"""Remote PXE install API over the simulated console; no KVM, PDU or computer is contacted."""
import asyncio
import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import accounts, confirm
from app.database import Base, get_db
from app.models import Device, PxeJob, PxeJobEvent, User
from app.pxe.runner import JobDevice, PxeRunner
from app.routers import pxe as pxe_router
from tests.test_pxe_sim import NEW, Clock, fast_engine

SHARED = "shared-pxe-secret-4b1d"
ACCOUNT_PASSWORD = "operator-pxe-secret-77aa"


def settings_for(**overrides):
    values = dict(pxe_enabled=True, pxe_driver="simulated", pxe_old_repo_host="webrepo", pxe_new_repo_host=NEW,
                  pxe_allowed_computers="", pxe_max_active_jobs=1, pxe_tick_seconds=0.5, pxe_sim_time_scale=0.25,
                  pxe_sim_scenario="happy", accounts_enabled=False, accounts_registration_enabled=False,
                  accounts_admin_username="admin", accounts_session_hours=12, accounts_secure_cookie=False,
                  lab_manager_password=SHARED)
    values.update(overrides)
    return SimpleNamespace(**values)


def seed(db):
    db.add(Device(id="kvm1", name="KVM 01", kind="kvm", model="KX III", ip="192.0.2.20", rack="R1", port_count=8,
                  labels_json=json.dumps({"1": "OPT11", "2": "Optn84", "3": "Optn84 (2)", "4": "Port 4"})))
    db.add(Device(id="kvm2", name="KVM 02", kind="kvm", model="LX II", ip="192.0.2.21", rack="R2", port_count=8,
                  labels_json=json.dumps({"1": "Optn87"})))
    db.add(Device(id="kvm3", name="KVM 03", kind="kvm", model="KX III", ip="192.0.2.22", rack="R3", port_count=8,
                  labels_json=json.dumps({"4": "optn87"})))
    db.add(Device(id="kvm9", name="KVM 09", kind="kvm", model="KX III", ip="192.0.2.29", rack="R9", port_count=8,
                  enabled=False, labels_json=json.dumps({"1": "OPT99"})))
    db.add(Device(id="pdu1", name="PDU 01", kind="pdu", model="PX4", ip="192.0.2.1", rack="R1", port_count=8,
                  labels_json=json.dumps({"1": "OPT11", "2": "Optn84 (2)", "3": "Outlet 3", "5": "OPT55"})))


@pytest.fixture
async def api(tmp_path, monkeypatch):
    engine = fast_engine(tmp_path / "api.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings, clock = settings_for(), Clock()
    monkeypatch.setattr(pxe_router, "get_settings", lambda: settings)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(confirm, "confirm_lock", asyncio.Lock())
    runner = PxeRunner(sessions, lambda: settings, clock=clock, tick=0.5, screens_dir=tmp_path / "screens", autostart=False)
    pxe_router.set_runner(runner)
    async with sessions() as db:
        seed(db)
        await db.commit()
    app = FastAPI()
    app.include_router(pxe_router.router)

    async def _db():
        async with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = _db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield SimpleNamespace(c=client, runner=runner, clock=clock, settings=settings, sessions=sessions, app=app)
    await runner.aclose()
    pxe_router.set_runner(None)
    await engine.dispose()


async def drive(api, job_id, **kw):
    return await api.runner.drive(job_id, api.clock.advance, **kw)


async def create(api, **body):
    return await api.c.post("/api/pxe/jobs", json={"computer_key": "OPT11", **body})


async def post(api, job_id, action, body=None):
    return await api.c.post(f"/api/pxe/jobs/{job_id}/{action}", json=body if body is not None else {})


async def get_job(api, job_id):
    r = await api.c.get(f"/api/pxe/jobs/{job_id}")
    assert r.status_code == 200, r.text
    return r.json()


async def events(api, job_id):
    async with api.sessions() as db:
        return (await db.scalars(select(PxeJobEvent).where(PxeJobEvent.job_id == job_id).order_by(PxeJobEvent.id))).all()


def pick(options, predicate):
    return next(o for o in options if predicate(o))


async def started(api, **body):
    r = await create(api, **body)
    assert r.status_code == 201, r.text
    job_id = r.json()["id"]
    r = await post(api, job_id, "start", {"password": SHARED, "reason": "Reinstall lab PC"})
    assert r.status_code == 200, r.text
    await drive(api, job_id)
    return job_id


async def to_ready(api, **body):
    job_id = await started(api, **body)
    job = await get_job(api, job_id)
    option = pick(job["options"], lambda o: o["recommended"])
    assert (await post(api, job_id, "choose-boot", {"option_id": option["id"], "version": job["version"]})).status_code == 200
    await drive(api, job_id)
    job = await get_job(api, job_id)
    option = pick(job["options"], lambda o: o["label"] == "Install Rocky Linux 9.4")
    assert (await post(api, job_id, "choose-grub", {"option_id": option["id"], "version": job["version"]})).status_code == 200
    await drive(api, job_id)
    return job_id


async def test_disabled_hides_everything_except_config(api):
    api.settings.pxe_enabled = False
    assert (await api.c.get("/api/pxe/config")).json() == {"enabled": False}
    for method, path in (("GET", "/api/pxe/computers"), ("GET", "/api/pxe/jobs"), ("POST", "/api/pxe/jobs"),
                         ("GET", "/api/pxe/jobs/" + "a" * 32), ("POST", f"/api/pxe/jobs/{'a' * 32}/start")):
        assert (await api.c.request(method, path, json={})).status_code == 404


async def test_config(api):
    body = (await api.c.get("/api/pxe/config")).json()
    assert body["enabled"] and body["driver"] == "simulated" and body["password_mode"] == "shared"
    assert body["new_repo_host"] == NEW and body["reboot_methods"] == ["kvm_cad", "manual", "pdu_cycle"]
    assert body["timeouts"]["rebooting"] == 180 and "happy" in body["scenarios"]
    assert SHARED not in json.dumps(body)


async def test_computers_from_live_labels_with_canonical_keys(api):
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert set(computers) == {"opt11", "optn84", "optn87"}                # PDU-only and disabled devices are not listed
    assert computers["opt11"]["kvm"] == [{"device_id": "kvm1", "device_name": "KVM 01", "model": "KX III", "port": 1, "busy": False}]
    assert computers["opt11"]["pdu"] == [{"device_id": "pdu1", "device_name": "PDU 01", "outlet": 1}]
    assert [(k["device_id"], k["port"]) for k in computers["optn84"]["kvm"]] == [("kvm1", 2), ("kvm1", 3)]
    assert [(k["device_id"], k["port"]) for k in computers["optn87"]["kvm"]] == [("kvm2", 1), ("kvm3", 4)]
    assert computers["optn84"]["name"] == "Optn84" and computers["opt11"]["rack"] == "R1"
    assert all(c["eligible"] and c["blockers"] == [] and c["active_job_id"] is None for c in computers.values())
    assert "192.0.2" not in json.dumps(computers)


async def test_create_validation(api):
    assert (await create(api, computer_key="Optn84")).status_code == 422                       # ambiguous KVM port
    assert (await create(api, computer_key="Optn87")).status_code == 422
    assert (await create(api, computer_key="Optn84", kvm_device_id="kvm2", kvm_port=1)).status_code == 422
    assert (await create(api, computer_key="Optn84", kvm_device_id="kvm1")).status_code == 422
    assert (await create(api, computer_key="Nope1")).status_code == 422
    assert (await create(api, computer_key="OPT99")).status_code == 422                        # disabled KVM
    assert (await create(api, computer_key="Optn87", kvm_device_id="kvm2", kvm_port=1, reboot_method="pdu_cycle")).status_code == 422
    assert (await create(api, reboot_method="power_button")).status_code == 422
    assert (await create(api, sim_scenario="explode")).status_code == 422
    assert (await create(api, keys=["F12"])).status_code == 422                                # no free keys
    r = await create(api, computer_key="Optn84 (2)", kvm_device_id="kvm1", kvm_port=3)
    assert r.status_code == 201 and r.json()["state"] == "draft" and r.json()["state_label"] == "טיוטה"
    assert r.json()["computer_key"] == "optn84" and r.json()["kvm_port"] == 3 and r.json()["can"]["start"]
    assert (await create(api, computer_key="optn84", kvm_device_id="kvm1", kvm_port=2)).status_code == 409
    assert (await create(api, reboot_method="pdu_cycle")).status_code == 201
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert computers["optn84"]["blockers"] == ["active_job"] and not computers["optn84"]["eligible"]
    assert [k["busy"] for k in computers["optn84"]["kvm"]] == [False, True]


async def test_allowlist_password_mode_and_raritan_gates(api):
    api.settings.pxe_allowed_computers = "Optn84, OPT55"
    assert (await create(api)).status_code == 403
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert computers["opt11"]["blockers"] == ["not_allowlisted"] and computers["optn84"]["eligible"]
    api.settings.pxe_allowed_computers = ""
    api.settings.lab_manager_password = ""
    assert (await api.c.get("/api/pxe/config")).json()["password_mode"] == "unavailable"
    assert (await create(api)).status_code == 403
    api.settings.lab_manager_password = SHARED
    r = await create(api)
    job_id = r.json()["id"]
    api.settings.pxe_driver = "raritan"
    assert (await create(api, computer_key="optn87", kvm_device_id="kvm2", kvm_port=1)).status_code == 503
    assert (await post(api, job_id, "start", {"password": SHARED})).status_code == 503
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert {"not_allowlisted", "driver_unavailable"} <= set(computers["optn87"]["blockers"])
    assert (await api.c.get("/api/pxe/config")).json()["available"] is False


async def test_full_flow_through_the_api(api):
    r = await create(api)
    job_id = r.json()["id"]
    r = await post(api, job_id, "start", {"password": "wrong-" + SHARED, "reason": "x"})
    assert r.status_code == 403 and SHARED not in r.text
    r = await post(api, job_id, "start", {"password": SHARED, "reason": "Reinstall lab PC"})
    assert r.status_code == 200 and r.json()["state"] == "rebooting" and r.json()["state_label"] == "מאתחל"
    assert (await post(api, job_id, "start", {"password": SHARED})).status_code == 409
    assert await drive(api, job_id) == "waiting_for_choice"

    job = await get_job(api, job_id)
    assert job["state_label"] == "ממתין לבחירה" and job["options_kind"] == "boot" and len(job["options"]) == 6
    assert job["can"]["choose_boot"] and not job["can"]["install"] and job["deadline_at"] > api.clock()
    option = pick(job["options"], lambda o: o["recommended"])
    stale = await post(api, job_id, "choose-boot", {"option_id": option["id"], "version": job["version"] - 1})
    assert stale.status_code == 409
    assert (await post(api, job_id, "choose-grub", {"option_id": option["id"], "version": job["version"]})).status_code == 409
    assert (await post(api, job_id, "choose-boot", {"option_id": option["id"], "version": job["version"]})).status_code == 200
    assert await drive(api, job_id) == "waiting_for_grub_choice"

    job = await get_job(api, job_id)
    assert job["options_kind"] == "grub" and job["boot_choice"] == option["label"]
    grub = pick(job["options"], lambda o: o["label"] == "Install RHEL 9.4 (kickstart)")
    assert (await post(api, job_id, "choose-grub", {"option_id": grub["id"], "version": job["version"]})).status_code == 200
    assert (await get_job(api, job_id))["state_label"] == "מעדכן כתובות"
    assert await drive(api, job_id) == "ready_to_install"

    job = await get_job(api, job_id)
    rewrite = job["rewrite"]
    assert job["state_label"] == "מוכן להתקנה" and job["can"]["install"] and job["can"]["cancel"]
    assert "inst.repo=http://webrepo/" in rewrite["line_before"] and f"inst.repo=http://{NEW}/" in rewrite["line_after"]
    assert [c["key"] for c in rewrite["changes"]] == ["inst.repo", "inst.ks"] and rewrite["warnings"][0]["key"] == "POSTFILE"
    assert (await post(api, job_id, "install", {"password": SHARED, "rewrite_hash": "0" * 32})).status_code == 409
    assert (await post(api, job_id, "install", {"password": SHARED})).status_code == 409
    r = await post(api, job_id, "install", {"password": SHARED, "rewrite_hash": rewrite["hash"]})
    assert r.status_code == 200 and r.json()["state"] == "installing" and r.json()["state_label"] == "מתקין"
    assert r.json()["install_may_have_started"] and not r.json()["can"]["cancel"]
    assert (await post(api, job_id, "cancel")).status_code == 409
    assert await drive(api, job_id, until=("install_started",)) == "install_started"

    assert (await post(api, job_id, "complete", {"password": "nope"})).status_code == 403
    r = await post(api, job_id, "complete", {"password": SHARED})
    assert r.status_code == 200 and r.json()["state"] == "completed" and r.json()["state_label"] == "ההתקנה הושלמה"
    assert r.json()["completion_signal"] == "manual"

    shot = await api.c.get(f"/api/pxe/jobs/{job_id}/screenshot")
    assert shot.status_code == 200 and shot.headers["content-type"].startswith("image/svg+xml")
    assert shot.headers["cache-control"] == "no-store" and b"<svg" in shot.content
    listing = (await api.c.get("/api/pxe/jobs")).json()
    assert [j["id"] for j in listing] == [job_id] and listing[0]["state"] == "completed"
    detail = await get_job(api, job_id)
    assert 0 < len(detail["events"]) <= 50
    audit = await events(api, job_id)
    actions = [e.action for e in audit]
    for action in ("create", "denied", "start", "choose_boot", "choose_grub", "install_sent", "install", "complete"):
        assert action in actions
    assert next(e for e in audit if e.action == "start").actor == "shared-password"
    everything = json.dumps(detail) + json.dumps(listing) + "".join(e.detail + e.actor for e in audit)
    assert SHARED not in everything and "192.0.2.20" not in everything


async def test_password_body_validation_and_throttle(api):
    job_id = (await create(api)).json()["id"]
    for body in ({}, {"password": ""}, {"password": 5}, {"password": "x" * 300}, {"password": SHARED, "reason": "a\nb"},
                 {"password": SHARED, "reason": "r" * 201}):
        r = await post(api, job_id, "start", body)
        assert r.status_code == 400 and SHARED not in r.text
    for _ in range(confirm.FAILURE_LIMIT):
        assert (await post(api, job_id, "start", {"password": "wrong"})).status_code == 403
    r = await post(api, job_id, "start", {"password": SHARED})
    assert r.status_code == 429 and r.headers["retry-after"] == "300"
    assert (await get_job(api, job_id))["state"] == "draft"
    assert (await post(api, "f" * 32, "start", {"password": SHARED})).status_code in (404, 429)
    assert (await api.c.get("/api/pxe/jobs/not-a-job")).status_code == 404


async def test_cancel_takeover_refresh_and_acknowledge(api):
    job_id = await to_ready(api)
    r = await post(api, job_id, "refresh-screenshot")
    assert r.status_code == 200 and r.json()["screenshot_available"]
    assert (await post(api, job_id, "refresh-screenshot")).status_code == 429
    r = await post(api, job_id, "cancel")
    assert r.status_code == 200 and r.json()["state"] == "cancelled" and r.json()["state_label"] == "בוטל"
    assert (await post(api, job_id, "cancel")).status_code == 409
    assert (await post(api, job_id, "acknowledge")).status_code == 409

    job_id = await to_ready(api)
    job = await get_job(api, job_id)
    await post(api, job_id, "install", {"password": SHARED, "rewrite_hash": job["rewrite"]["hash"]})
    r = await post(api, job_id, "takeover")
    assert r.status_code == 200 and r.json()["console_url"] is None and r.json()["simulated"] is True
    job = r.json()["job"]
    assert job["state"] == "manual_takeover" and job["needs_acknowledge"] and job["can"]["acknowledge"]
    assert (await create(api)).status_code == 409
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert computers["opt11"]["blockers"] == ["needs_acknowledge"] and computers["opt11"]["active_job_id"] == job_id
    r = await post(api, job_id, "acknowledge")
    assert r.status_code == 200 and not r.json()["needs_acknowledge"]
    assert (await create(api)).status_code == 201


async def test_failure_scenario_through_the_api(api):
    job_id = await started(api, sim_scenario="missed_f12")
    job = await get_job(api, job_id)
    assert job["state"] == "failed" and job["error_code"] == "boot_menu_timeout" and job["failed_step"] == "waiting_for_menu"
    assert job["can"]["takeover"] and job["screenshot_available"] and job["state_label"] == "נכשל"
    r = await post(api, job_id, "takeover")
    assert r.status_code == 200 and r.json()["job"]["state"] == "failed"
    assert r.json()["console_url"] is None and r.json()["simulated"] is True


def test_required_roles():
    for method in ("GET", "POST"):
        for path in ("/api/pxe/config", "/api/pxe/computers", "/api/pxe/jobs", "/api/pxe/jobs/x", "/api/pxe/jobs/x/screenshot",
                     "/api/pxe/jobs/x/start", "/api/pxe/jobs/x/takeover"):
            assert accounts.required_role(path, method) == "Operator"
    assert accounts.required_role("/api/pxe/jobs/x/acknowledge", "POST") == "Admin"
    assert accounts.required_role("/api/pxevil", "GET") == "Viewer"


# -- accounts mode -----------------------------------------------------------

@asynccontextmanager
async def signed_in(app, username):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/auth/login", json={"username": username, "password": ACCOUNT_PASSWORD})
        assert r.status_code == 200, r.text
        client.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        yield client


async def test_accounts_mode_roles_and_own_password(api):
    api.settings.accounts_enabled = True
    password_hash = accounts.hash_password(ACCOUNT_PASSWORD)
    async with api.sessions() as db:
        for role in ("Viewer", "Operator", "Admin"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role, password_hash=password_hash,
                        created_at=time.time()))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(pxe_router.router)
    app.dependency_overrides = api.app.dependency_overrides
    async with signed_in(app, "viewer") as viewer:
        for path in ("/api/pxe/config", "/api/pxe/computers", "/api/pxe/jobs"):
            assert (await viewer.get(path)).status_code == 403
    async with signed_in(app, "operator") as operator:
        assert (await operator.get("/api/pxe/config")).json()["password_mode"] == "account"
        job_id = (await operator.post("/api/pxe/jobs", json={"computer_key": "OPT11"})).json()["id"]
        assert (await operator.post(f"/api/pxe/jobs/{job_id}/start", json={"password": SHARED})).status_code == 403
        r = await operator.post(f"/api/pxe/jobs/{job_id}/start", json={"password": ACCOUNT_PASSWORD})
        assert r.status_code == 200 and r.json()["created_by"] == "operator"
        r = await operator.post(f"/api/pxe/jobs/{job_id}/takeover")
        assert r.status_code == 200 and r.json()["job"]["state"] == "manual_takeover"
        async with api.sessions() as db:
            row = await db.get(PxeJob, job_id)
            row.state, row.install_may_have_started, row.active_key = "failed", True, "opt11"
            await db.commit()
        assert (await operator.post(f"/api/pxe/jobs/{job_id}/acknowledge")).status_code == 403
    async with signed_in(app, "admin") as admin:
        r = await admin.post(f"/api/pxe/jobs/{job_id}/acknowledge")
        assert r.status_code == 200 and not r.json()["needs_acknowledge"]
    audit = await events(api, job_id)
    assert [e.actor for e in audit if e.action in ("denied", "start", "takeover", "acknowledge")] == \
           ["operator", "operator", "operator", "admin"]


async def test_raritan_mode_drives_an_installed_console_and_keeps_the_allowlist(api, monkeypatch):
    monkeypatch.setattr(pxe_router, "driver_ready", lambda: True)
    sent = []

    class Screen:
        async def open(self):
            sent.append("open")

        async def close(self):
            sent.append("close")

        async def screenshot(self):
            return b"\x89PNG", "image/png"

        async def send_keys(self, seq):
            sent.extend(seq)

        async def read_text(self):
            from app.pxe.screen import ScreenText
            return ScreenText([" "], None, 80, 25, 1.0, "test")

    class Power:
        async def cycle(self):
            sent.append("cycle")

    api.runner.factory = lambda job: JobDevice(Screen(), Power(), None, completion_signal=False)
    api.settings.pxe_allowed_computers = "OPT11"
    api.settings.pxe_driver = "raritan"
    blocked = await create(api, computer_key="Optn87", kvm_device_id="kvm2", kvm_port=1)
    assert blocked.status_code == 403
    created = await create(api)
    assert created.status_code == 201, created.text
    job = created.json()
    assert job["driver"] == "raritan"
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert "driver_unavailable" not in computers["opt11"]["blockers"]
    assert computers["optn87"]["blockers"] == ["not_allowlisted"]
    assert (await api.c.get("/api/pxe/config")).json()["available"] is True
    started_job = await post(api, job["id"], "start", {"password": SHARED, "reason": "Reinstall lab PC"})
    assert started_job.status_code == 200 and started_job.json()["state"] == "rebooting"
    assert await api.runner.step(job["id"]) is not None
    assert sent == ["open", "Ctrl+Alt+Delete"] and "cycle" not in sent
    takeover = await post(api, job["id"], "takeover")
    assert takeover.status_code == 200
    assert takeover.json()["simulated"] is False
    assert takeover.json()["console_url"] == "/api/kvms/kvm1/autologin?port=1"
    assert sent[-1] == "close"


async def test_raritan_mode_with_an_empty_allowlist_creates_no_job(api, monkeypatch):
    monkeypatch.setattr(pxe_router, "driver_ready", lambda: True)
    api.settings.pxe_driver = "raritan"
    api.settings.pxe_allowed_computers = ""
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert computers["opt11"]["blockers"] == ["not_allowlisted"]
    r = await create(api)
    assert r.status_code == 403 and r.json()["detail"] == "This computer is not allowed for remote install"
    async with api.sessions() as db:
        assert (await db.scalars(select(PxeJob))).all() == []


@pytest.mark.parametrize("driver,allowlist,allowed", [
    ("simulated", "", True), ("simulated", "opt11", True), ("simulated", "Optn84", False),
    ("raritan", "", False), ("raritan", "OPT11, Optn84", True), ("raritan", "Optn84;OPT55", False)])
async def test_list_create_and_start_apply_one_allowlist_rule(api, monkeypatch, driver, allowlist, allowed):
    monkeypatch.setattr(pxe_router, "driver_ready", lambda: True)
    job_id = (await create(api)).json()["id"]    # a simulated OPT11 draft, made while every computer was allowed
    api.settings.pxe_driver, api.settings.pxe_allowed_computers = driver, allowlist
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert ("not_allowlisted" in computers["opt11"]["blockers"]) is not allowed
    assert (await create(api)).status_code == (409 if allowed else 403)
    r = await post(api, job_id, "start", {"password": SHARED})
    if allowed:
        assert r.status_code == 200, r.text
    else:
        assert r.status_code == 403 and r.json()["detail"] == "This computer is not allowed for remote install"
        assert (await get_job(api, job_id))["state"] == "draft"
