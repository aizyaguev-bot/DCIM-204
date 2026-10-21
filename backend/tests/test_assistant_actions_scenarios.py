"""Assistant actions (v2.40.0): end-to-end acceptance scenarios through the HTTP API and the chat (ACT-10).

Section letters follow .team/reports/ACT-QA-PLAN.md (A-M), adapted to the binding contract: the lead's
backend/app/assistant/actions/contracts.py (kinds, statuses, error codes, public JSON) and the security decisions in
.team/reports/ORCA-SEC-ACTIONS.md (D1 accounts mode only, D2 intent anchor, D3 rack/lab intersection, D4 safe reset,
D5 protected outlets, D6 batch restore, D7 abort, D8 audit). Where the QA plan and the contract differ, the contract
wins (for example drift ends in status "refused", the typed phrase is a 403 "phrase").

Real application modules run on a temporary SQLite file: the accounts middleware, devices, pdus, pdu_maintenance,
the assistant chat (demo mode, no language model) and the actions router/store/resolver/runner/power modules.
Hardware is a fleet of in-memory FakePdu objects patched at pdus.RaritanPduDriver; every real driver and KVM entry
point raises AssertionError("hardware"). Waits use an injected sleep that records the seconds and returns at once.
Password hashing is replaced by a fast digest (scrypt is covered by the account tests).
"""
import asyncio
import contextlib
import hashlib
import importlib
import json
import logging
import re
import secrets
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.config as config_module
import app.routers.pdu_maintenance as pm
import app.routers.pdus as pdus_module
from app import accounts, confirm, inventory_store, pdu_locks
from app.crypto import encrypt
from app.database import Base, get_db
from app.models import (AuthThrottle, Device, MonitorDeviceSnapshot, PduMaintenance, PduMaintenanceLog, PxeJob,
                        User)
from app.routers import devices, kvm_proxy, pdu_maintenance, pdus
from drivers.raritan_kvm import RaritanKvmDriver
from drivers.raritan_pdu import RaritanPduDriver
from tests.test_assistant_api import make_settings
from tests.test_pdu_maintenance import ACCOUNT_PASSWORD, SECRET, SHARED, FakePdu, signed_in

contracts = pytest.importorskip("app.assistant.actions.contracts")
models = pytest.importorskip("app.assistant.actions.models")
store = pytest.importorskip("app.assistant.actions.store")
resolve = pytest.importorskip("app.assistant.actions.resolve")
power = pytest.importorskip("app.assistant.actions.power")
runner = pytest.importorskip("app.assistant.actions.runner")
actions_router = pytest.importorskip("app.assistant.actions.router")
from app.assistant import ratelimit, registry  # noqa: E402
from app.assistant import router as assistant_router  # noqa: E402
from app.assistant.contracts import Principal, ToolContext, ToolError  # noqa: E402

pytestmark = pytest.mark.filterwarnings("ignore:LAB_MANAGER_MASTER_KEY is not set")

Proposal = models.AssistantActionProposal
Event = models.AssistantActionEvent
FINAL = tuple(contracts.FINAL_STATUSES)
B = "/api/assistant/actions"
HEX32 = re.compile(r"[0-9a-f]{32}")
CONSOLE_URL = re.compile(r"^/api/kvms/([^/?#]+)/autologin\?port=(\d+)$")
ROLE_DENIED = "Your role does not allow this action"
CSRF_DENIED = "Refresh the page and retry (invalid CSRF token)"
DRIFT = "The situation changed; review the action again"
PHRASE_ATTEMPT = "ZZ OFF 7731"          # a distinctive wrong phrase: must never be stored or echoed
LOCATION_SWAP = {"kind": "server_swap", "server": "OPT12", "target_server": "OPT13"}
LOCATION_CLEAR = {"kind": "server_clear", "server": "OPT13"}
PLANNER_FUNCTIONS = ("plan_move", "apply_move", "plan_clear", "apply_clear")
# Rack layout used by the location scenarios: OPT12 at U10 and OPT13 at U12 of R1 (both on PDU 01), OPT41 at U3 of R2.
SLOTS = {"R1": {"opt12": 10, "opt13": 12}, "R2": {"opt41": 3}}

USERS = (("viewer", "Viewer"), ("operator", "Operator"), ("operator2", "Operator"), ("admin", "Admin"),
         ("admin2", "Admin"), ("changeme", "Operator"))
# S3: pdu1..pdu3 in rack R1, pdu4..pdu6 in R2. OPT11 has two feeds (pdu1:1 and pdu2:1); pdu1:4 feeds the core switch
# and is the protected outlet; OPT12 is on two KVM ports (kvm1:2 and kvm2:3); OPT13 (pdu1:3) is off.
STATES = {
    "pdu1": {1: "on", 2: "on", 3: "off", 4: "on"},
    "pdu2": {1: "on", 2: "on", 3: "on", 4: "off"},
    "pdu3": {1: "on", 2: "on", 3: "on", 4: "on"},
    "pdu4": {1: "on", 2: "on", 3: "on", 4: "on"},
    "pdu5": {1: "on", 2: "on", 3: "off", 4: "on"},
    "pdu6": {1: "on", 2: "on", 3: "on", 4: "on"},
}
LABELS = {
    "pdu1": {"1": "OPT11 (PSU1)", "2": "OPT12", "3": "OPT13", "4": "SW-CORE"},
    "pdu2": {"1": "OPT11 (PSU2)"},
    "pdu3": {"1": "OPT31"},
    "pdu4": {"1": "OPT41"},
    "pdu5": {"1": "OPT51"},
    "pdu6": {"1": "OPT61"},
}
KVM_LABELS = {"kvm1": {"1": "OPT11", "2": "OPT12"}, "kvm2": {"3": "OPT12"}}
R1_ON_OUTLETS = [("pdu1", 1), ("pdu1", 2), ("pdu2", 1), ("pdu2", 2), ("pdu2", 3),
                 ("pdu3", 1), ("pdu3", 2), ("pdu3", 3), ("pdu3", 4)]
BASE_SETTINGS = dict(lab_manager_password=SHARED, assistant_actions_enabled=True, power_protected_outlets="pdu1:4",
                     assistant_action_ttl_seconds=300, assistant_action_cycle_off_seconds=5.0,
                     assistant_action_restore_stagger_seconds=3.0, ping_monitor_timezone="Asia/Jerusalem")


# ---------------------------------------------------------------------------------------------------------------
# S4: the fake PDU fleet
# ---------------------------------------------------------------------------------------------------------------
class FleetPdu(FakePdu):
    """One FakePdu of the fleet. Every switch is also appended to the shared fleet.calls as (device_id, outlet,
    action). hooks[outlet] (async) and gates[outlet] (asyncio.Event) run before the outlet switches."""

    def __init__(self, fleet, device_id, states):
        super().__init__(states)
        self.fleet, self.device_id = fleet, device_id
        self.hooks, self.gates = {}, {}

    async def set_outlet_state(self, number, action):
        self.fleet.calls.append((self.device_id, number, action))
        if number in self.hooks:
            await self.hooks[number]()
        if number in self.gates:
            await self.gates[number].wait()
        return await super().set_outlet_state(number, action)


class Fleet:
    """Patched at pdus.RaritanPduDriver: Fleet(ip, username, password) returns the fake PDU at that address. An
    unknown address (a moved PDU) is recorded and answers as unreachable."""

    def __init__(self):
        self.pdus, self.by_ip, self.calls, self.contacted, self.auth_ok = {}, {}, [], [], []
        self.unknown = FakePdu({}, unreachable=True)

    def add(self, device_id, ip, states):
        self.pdus[device_id] = self.by_ip[ip] = FleetPdu(self, device_id, states)
        return self.pdus[device_id]

    def __call__(self, ip, username, password):
        self.contacted.append(ip)
        self.auth_ok.append(password == SECRET)      # decrypted through get_creds; the value itself is never kept
        pdu = self.by_ip.get(ip, self.unknown)
        pdu.created += 1
        return pdu

    def __getitem__(self, device_id):
        return self.pdus[device_id]

    @property
    def created(self):
        return sum(p.created for p in self.pdus.values()) + self.unknown.created

    @property
    def reads(self):
        return sum(p.reads for p in self.pdus.values()) + self.unknown.reads


# ---------------------------------------------------------------------------------------------------------------
# Environment (S1, S2, S5, S6)
# ---------------------------------------------------------------------------------------------------------------
def _fast_hash(password: str) -> str:
    return "test-sha256$" + hashlib.sha256(str(password).encode()).hexdigest()


def _optional(name):
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as exc:
        if exc.name == name:
            return None
        raise


@pytest.fixture(autouse=True)
def reset_pdu_locks():
    # asyncio locks bind to the first loop that waits on them; each test runs on its own loop.
    pdu_locks._locks.clear()
    yield
    pdu_locks._locks.clear()


@pytest.fixture(autouse=True)
def forbid_hardware(monkeypatch):
    """S5: any path that reaches a real driver or KVM session fails the test."""
    def forbidden(*args, **kwargs):
        raise AssertionError("hardware")

    async def forbidden_async(*args, **kwargs):
        raise AssertionError("hardware")

    monkeypatch.setattr(RaritanPduDriver, "_rpc", forbidden_async)
    monkeypatch.setattr(RaritanPduDriver, "_client_ctx", forbidden_async)
    monkeypatch.setattr(RaritanKvmDriver, "_client_ctx", forbidden_async)
    monkeypatch.setattr(RaritanKvmDriver, "_session_client", forbidden)
    monkeypatch.setattr(kvm_proxy, "_login", forbidden_async)
    monkeypatch.setattr(kvm_proxy, "ensure_session", forbidden_async)


def _pdu_ports(device_id):
    labels = LABELS.get(device_id, {})
    return [{"number": n, "label": labels.get(str(n), f"Outlet {n}"), "state": state, "watts": None, "current": None,
             "voltage": None} for n, state in sorted(STATES[device_id].items())]


@asynccontextmanager
async def _environment(tmp_path, monkeypatch, **overrides):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'actions.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = make_settings(**{**BASE_SETTINGS, **overrides})
    env = SimpleNamespace(sessions=sessions, settings=settings, fleet=Fleet(), sleeps=[], sleep_gate=None,
                          responses=[], tokens=[], app=None, layout_dir=None)
    tools = _optional("app.assistant.actions.tools")
    # Every application module that imported get_settings gets these settings (pdus.py reads the protected outlets,
    # for example), except crypto, which keeps the real key so the seeded device credentials decrypt.
    original_get_settings = config_module.get_settings
    for name, module in list(sys.modules.items()):
        if (name == "app" or name.startswith("app.")) and name != "app.crypto" and module is not None \
                and getattr(module, "get_settings", None) is original_get_settings:
            monkeypatch.setattr(module, "get_settings", lambda: settings)
    patched = [m for m in (accounts, pm, assistant_router, registry, actions_router, store, resolve, runner, power,
                           tools) if m is not None]
    for module in patched:
        if hasattr(module, "get_settings"):
            monkeypatch.setattr(module, "get_settings", lambda: settings)
        if hasattr(module, "AsyncSessionLocal"):
            monkeypatch.setattr(module, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "hash_password", _fast_hash)
    monkeypatch.setattr(accounts, "verify_password",
                        lambda password, encoded: secrets.compare_digest(_fast_hash(password), str(encoded)))
    # One fresh password-check lock shared by maintenance and actions; every other module-level lock is fresh too.
    shared_lock, original = asyncio.Lock(), confirm.confirm_lock
    monkeypatch.setattr(confirm, "confirm_lock", shared_lock)
    for module in (pm, actions_router, runner, store, power, resolve, tools):
        for name, value in list(vars(module).items()) if module is not None else ():
            if value is original:
                monkeypatch.setattr(module, name, shared_lock)
            elif isinstance(value, asyncio.Lock):
                monkeypatch.setattr(module, name, asyncio.Lock())
    monkeypatch.setattr(ratelimit, "gate", ratelimit.Gate())
    monkeypatch.setattr(assistant_router, "TIMEOUT_GRACE_SECONDS", 0.0)
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", env.fleet)
    # The Locations planner reads and writes the rack layout files next to the backend: always a temporary folder here.
    env.layout_dir = tmp_path / "layouts"
    env.layout_dir.mkdir()
    monkeypatch.setattr(devices, "_BACKEND_DIR", env.layout_dir)

    # S6: the runner's waits (cycle off-time, restore stagger) go through a recording sleep.
    async def recorded_sleep(seconds):
        env.sleeps.append(seconds)
        if env.sleep_gate is not None:
            await env.sleep_gate.wait()
        await asyncio.sleep(0)

    original_execute = runner.execute

    async def execute_with_recorded_sleep(*args, **kwargs):
        kwargs["sleep"] = recorded_sleep
        return await original_execute(*args, **kwargs)

    monkeypatch.setattr(runner, "execute", execute_with_recorded_sleep)

    now = time.time()
    async with sessions() as db:
        for user_id, role in USERS:
            db.add(User(id=user_id, username=user_id, name=user_id, role=role, password_hash=_fast_hash(ACCOUNT_PASSWORD),
                        created_at=now, must_change_password=user_id == "changeme"))
        username_enc, password_enc = encrypt("admin"), encrypt(SECRET)
        for n in range(1, 7):
            device_id, ip = f"pdu{n}", f"pdu{n}.example.invalid"
            db.add(Device(id=device_id, name=f"PDU {n:02}", kind="pdu", model="PX4", ip=ip, rack="R1" if n <= 3 else "R2",
                          port_count=4, username_enc=username_enc, password_enc=password_enc,
                          labels_json=json.dumps(LABELS[device_id])))
            db.add(MonitorDeviceSnapshot(device_id=device_id, kind="pdu", ip=ip, checked_at=now, reachable=True,
                                         ports_json=json.dumps(_pdu_ports(device_id))))
            env.fleet.add(device_id, ip, STATES[device_id])
        for kvm_id, labels in KVM_LABELS.items():
            ip = f"{kvm_id}.example.invalid"
            db.add(Device(id=kvm_id, name=kvm_id.upper().replace("KVM", "KVM "), kind="kvm", model="KX III", ip=ip,
                          rack="R1", port_count=4, labels_json=json.dumps(labels)))
            db.add(MonitorDeviceSnapshot(device_id=kvm_id, kind="kvm", ip=ip, checked_at=now, reachable=True,
                                         ports_json=json.dumps([{"number": int(n), "label": label, "status": "idle",
                                                                 "status_source": "live"}
                                                                for n, label in labels.items()])))
        await db.commit()

    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    for module in (accounts, devices, pdus, pdu_maintenance, assistant_router, actions_router):
        app.include_router(module.router)

    async def _db():
        async with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = _db
    env.app = app
    try:
        yield env
    finally:
        for pdu in env.fleet.pdus.values():
            for gate in pdu.gates.values():
                gate.set()
        if env.sleep_gate is not None:
            env.sleep_gate.set()
        current = asyncio.current_task()
        pending = [task for task in asyncio.all_tasks() if task is not current and not task.done()]
        if pending:
            _, still = await asyncio.wait(pending, timeout=5)
            for task in still:
                task.cancel()
            await asyncio.gather(*still, return_exceptions=True)
        await engine.dispose()


@pytest.fixture
async def env(tmp_path, monkeypatch):
    """Accounts mode, flag on, protected outlets "pdu1:4"."""
    async with _environment(tmp_path, monkeypatch) as value:
        yield value


@pytest.fixture
async def legacy_env(request, tmp_path, monkeypatch):
    """No accounts: shared password mode (param SHARED) or no password at all (param "")."""
    password = getattr(request, "param", SHARED)
    async with _environment(tmp_path, monkeypatch, accounts_enabled=False, lab_manager_password=password) as value:
        yield value


# ---------------------------------------------------------------------------------------------------------------
# S7 helpers
# ---------------------------------------------------------------------------------------------------------------
def _keep_responses(env):
    async def keep(response):
        if response.request.url.path.startswith("/api/assistant"):
            await response.aread()
            env.responses.append(response.text)
    return keep


@asynccontextmanager
async def user(env, username):
    async with signed_in(env.app, username) as c:
        env.tokens.append(c.headers["X-DCIM-CSRF"])
        env.tokens.extend(cookie.value for cookie in c.cookies.jar if cookie.value)
        c.event_hooks = {"request": [], "response": [_keep_responses(env)]}
        yield c


@asynccontextmanager
async def anonymous(env):
    async with AsyncClient(transport=ASGITransport(app=env.app), base_url="http://test",
                           event_hooks={"request": [], "response": [_keep_responses(env)]}) as c:
        yield c


def no_secrets(value, *extra):
    text_value = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    for secret in (ACCOUNT_PASSWORD, SHARED, SECRET, *extra):
        if secret:
            assert secret not in text_value, "a secret value leaked"


def expect_error(r, status, code=None, detail=None):
    assert r.status_code == status, (r.status_code, r.text[:400])
    body = r.json()
    if code is not None:
        assert body.get("code") == code, body
    if detail is not None:
        assert body.get("detail") == detail, body
    return body


async def propose(c, **request):
    return await c.post(f"{B}/proposals", json=request)


async def created(awaitable):
    r = await awaitable
    assert r.status_code == 201, (r.status_code, r.text[:400])
    return r.json()


async def execute(c, proposal_id, password=ACCOUNT_PASSWORD, phrase=None):
    body = {"password": password}
    if phrase is not None:
        body["phrase"] = phrase
    return await c.post(f"{B}/proposals/{proposal_id}/execute", json=body)


async def cancel(c, proposal_id):
    return await c.post(f"{B}/proposals/{proposal_id}/cancel", json={})


async def get(c, proposal_id):
    r = await c.get(f"{B}/proposals/{proposal_id}")
    assert r.status_code == 200, (r.status_code, r.text[:400])
    return r.json()


async def settle(c, proposal_id, timeout=5.0):
    """Bounded poll of GET until the proposal reaches a final status."""
    deadline = time.monotonic() + timeout
    while True:
        body = await get(c, proposal_id)
        if body["status"] in FINAL:
            return body
        assert time.monotonic() < deadline, f"proposal still {body['status']} after {timeout} s"
        await asyncio.sleep(0.02)


async def until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "condition not reached in time"
        await asyncio.sleep(0.01)


async def chat(c, message):
    return await c.post("/api/assistant/chat", json={"message": message})


async def maint_shutdown(c, device_id, password=ACCOUNT_PASSWORD, reason="QA maintenance"):
    return await c.post(f"/api/pdus/{device_id}/maintenance/shutdown", json={"password": password, "reason": reason})


async def maint_restore(c, device_id, password=ACCOUNT_PASSWORD):
    return await c.post(f"/api/pdus/{device_id}/maintenance/restore", json={"password": password})


async def events(env, proposal_id):
    async with env.sessions() as db:
        rows = (await db.execute(select(Event).where(Event.proposal_id == proposal_id).order_by(Event.id))).scalars()
        return [(r.event, r.actor) for r in rows]


def names(event_list):
    return [event for event, _ in event_list]


def in_order(actual, expected):
    """expected is a subsequence of actual."""
    position = 0
    for item in actual:
        if position < len(expected) and item == expected[position]:
            position += 1
    assert position == len(expected), (actual, expected)


async def count(env, model):
    async with env.sessions() as db:
        return await db.scalar(select(func.count()).select_from(model))


async def row(env, proposal_id):
    async with env.sessions() as db:
        return await db.get(Proposal, proposal_id)


CONFIRM_KEYS = [hashlib.sha256(f"maint:user:{name}".encode()).hexdigest() for name, _ in USERS] + \
               [hashlib.sha256(b"maint:client:127.0.0.1").hexdigest()]


async def throttle_attempts(env):
    """Failed-confirmation attempts in the shared maintenance/actions budget (confirm.py keys only; sign-in
    throttling uses other keys)."""
    async with env.sessions() as db:
        return sum((await db.execute(select(AuthThrottle.attempts).where(AuthThrottle.key.in_(CONFIRM_KEYS))))
                   .scalars())


async def maintenance_rows(env):
    async with env.sessions() as db:
        return {r.device_id: r for r in (await db.execute(select(PduMaintenance))).scalars()}


async def maintenance_row(env, device_id):
    return (await maintenance_rows(env)).get(device_id)


async def set_device(env, device_id, **values):
    async with env.sessions() as db:
        await db.execute(update(Device).where(Device.id == device_id).values(**values))
        await db.commit()


async def set_expiry(env, proposal_id, expires_at):
    async with env.sessions() as db:
        await db.execute(update(Proposal).where(Proposal.id == proposal_id).values(expires_at=expires_at))
        await db.commit()


async def add_pdu(env, device_id, rack, states):
    ip = f"{device_id}.example.invalid"
    async with env.sessions() as db:
        db.add(Device(id=device_id, name=f"PDU {device_id[3:]:0>2}", kind="pdu", model="PX4", ip=ip, rack=rack,
                      port_count=len(states), username_enc=encrypt("admin"), password_enc=encrypt(SECRET)))
        await db.commit()
    env.fleet.add(device_id, ip, states)


async def dump_tables(env):
    async with env.sessions() as db:
        lines = []
        for table in ("assistant_action_proposals", "assistant_action_events"):
            lines += [str(tuple(r)) for r in (await db.execute(text(f"SELECT * FROM {table}"))).all()]
        return "\n".join(lines)


def batch_ids(proposal_row):
    """PDU ids of batch_down_json, either ["pdu1", ...] or [{"pdu_id": "pdu1", "started_at": ...}, ...] (D6)."""
    items = json.loads(proposal_row.batch_down_json or "[]")
    return sorted(item["pdu_id"] if isinstance(item, dict) else item for item in items)


def targets_of(public):
    return [(t["pdu_id"], t["outlet"], t["label"], t["state"]) for t in public["impact"]["targets"]]


def results_of(public):
    return [(t["pdu_id"], t["outlet"], t["ok"], t["state_after"]) for t in public["result"]["targets"]]


def iso_seconds(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def tools_module():
    return pytest.importorskip("app.assistant.actions.tools")


# ---------------------------------------------------------------------------------------------------------------
# A. Feature flag
# ---------------------------------------------------------------------------------------------------------------
async def test_a1_flag_off_only_config_answers(env):
    """Flag off: config answers, every other route is 403 "disabled". Execute checks the owner/existence first
    (SEC-ACT-4 order, lead decision 2026-10-20): an unknown id is 404 there; an existing own proposal is 403 (A3)."""
    env.settings.assistant_actions_enabled = False
    async with user(env, "operator") as c:
        r = await c.get(f"{B}/config")
        assert r.status_code == 200, r.text
        assert r.json()["enabled"] is False and r.json().get("can_propose") in (False, None)
        unknown = secrets.token_hex(16)
        for r in (await propose(c, kind="server_off", server="OPT12"), await c.get(f"{B}/proposals"),
                  await c.get(f"{B}/proposals/{unknown}"), await cancel(c, unknown)):
            expect_error(r, 403, "disabled", "Assistant actions are disabled on this server")
        expect_error(await execute(c, unknown), 404, "not_found")
    assert env.fleet.created == 0 and env.fleet.calls == []
    assert await count(env, Proposal) == 0 and await count(env, Event) == 0


async def test_a2_flag_off_offers_no_action_tool_to_any_role(env):
    env.settings.assistant_actions_enabled = False
    for role in ("Viewer", "Operator", "Admin"):
        tool_names = [spec.name for spec in registry.tools_for(Principal(role.lower(), role.lower(), role), env.settings)]
        assert "propose_action" not in tool_names
        assert not any("execute" in name or "confirm" in name for name in tool_names)


async def test_a2b_flag_off_chat_explains_and_proposes_nothing(env):
    tools_module()
    env.settings.assistant_actions_enabled = False
    async with user(env, "admin") as c:
        r = await chat(c, "כבה חשמל לכל המעבדה")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("action_proposals", []) == []
    assert not HEX32.search(json.dumps(body["answer"], ensure_ascii=False))
    assert "פעולות" in body["answer"]["summary"]
    assert await count(env, Proposal) == 0 and env.fleet.calls == []


async def test_a3_flag_turned_off_after_create_blocks_execute(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        env.settings.assistant_actions_enabled = False
        expect_error(await execute(c, p["id"]), 403, "disabled")
        env.settings.assistant_actions_enabled = True
        assert (await get(c, p["id"]))["status"] == "pending"
    assert env.fleet.calls == []
    assert "confirmed" not in names(await events(env, p["id"]))
    assert await throttle_attempts(env) == 0


def test_a4_settings_default_to_off(monkeypatch):
    for name in ("ASSISTANT_ACTIONS_ENABLED", "POWER_PROTECTED_OUTLETS", "ASSISTANT_ACTION_TTL_SECONDS",
                 "ASSISTANT_ACTION_CYCLE_OFF_SECONDS", "ASSISTANT_ACTION_RESTORE_STAGGER_SECONDS"):
        monkeypatch.delenv(name, raising=False)
    value = config_module.Settings(_env_file=None)
    assert value.assistant_actions_enabled is False and value.power_protected_outlets == ""
    assert value.assistant_action_ttl_seconds == 300 and value.assistant_action_cycle_off_seconds == 5.0


# ---------------------------------------------------------------------------------------------------------------
# B. Roles, modes, CSRF
# ---------------------------------------------------------------------------------------------------------------
async def test_b1_viewer_cannot_propose_list_execute_or_cancel(env):
    async with user(env, "operator") as op:
        p = await created(propose(op, kind="server_off", server="OPT12"))
    contacted = env.fleet.created
    async with user(env, "viewer") as c:
        cfg = await c.get(f"{B}/config")
        assert cfg.status_code == 200 and cfg.json()["enabled"] is True and cfg.json().get("can_propose") is False
        for request in ({"kind": "server_off", "server": "OPT12"}, {"kind": "lab_shutdown"},
                        {"kind": "open_console", "server": "OPT11"}, LOCATION_SWAP, LOCATION_CLEAR):
            expect_error(await propose(c, **request), 403, detail=ROLE_DENIED)
        for r in (await c.get(f"{B}/proposals"), await c.get(f"{B}/proposals/{p['id']}"),
                  await execute(c, p["id"]), await cancel(c, p["id"])):
            expect_error(r, 403, detail=ROLE_DENIED)
    assert env.fleet.created == contacted and env.fleet.calls == []
    assert await count(env, Proposal) == 1 and (await row(env, p["id"])).status == "pending"


async def test_b2_operator_runs_server_and_pdu_actions(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await execute(c, p["id"])
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "succeeded"
        q = await created(propose(c, kind="pdu_shutdown", pdu="pdu3"))
        r = await execute(c, q["id"])
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "succeeded"
    assert ("pdu1", 2, "off") in env.fleet.calls
    assert (await maintenance_row(env, "pdu3")).started_by == "operator"


async def test_b3_operator_cannot_request_admin_kinds_and_nothing_is_read(env):
    async with user(env, "operator") as c:
        for request in ({"kind": "rack_shutdown", "rack": "R1"}, {"kind": "lab_shutdown"},
                        {"kind": "batch_restore", "restore_of": secrets.token_hex(16)}):
            expect_error(await propose(c, **request), 403, "forbidden")
    assert env.fleet.created == 0 and await count(env, Proposal) == 0


async def test_b4_admin_demoted_after_the_proposal_cannot_execute(env):
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="lab_shutdown"))
        await set_user_role(env, "admin", "Operator")
        expect_error(await execute(c, p["id"], phrase=p["phrase"]), 403, "forbidden")
    assert env.fleet.calls == [] and await throttle_attempts(env) == 0
    assert (await row(env, p["id"])).status == "pending"


async def set_user_role(env, user_id, role):
    async with env.sessions() as db:
        await db.execute(update(User).where(User.id == user_id).values(role=role))
        await db.commit()


@pytest.mark.parametrize("legacy_env", [SHARED, ""], indirect=True, ids=["shared-password", "no-password"])
async def test_b5_b6_without_accounts_every_action_route_is_refused(legacy_env):
    """D1: shared-password and open sites never propose or run actions; only GET config answers. Execute checks
    owner/existence first (SEC-ACT-4 order): unknown id 404; an existing own pending proposal (left from before the
    site left accounts mode, inserted directly here) is 403 "password_mode" and never runs."""
    env = legacy_env
    mode = "shared" if env.settings.lab_manager_password else "unavailable"
    legacy = Principal(user_id=None, username="shared", role="Admin", legacy=True)
    now = time.time()
    stale_id = secrets.token_hex(16)
    async with env.sessions() as db:
        db.add(Proposal(id=stale_id, created_at=now, expires_at=now + 300, owner_key=store.owner_key(legacy),
                        created_by="shared", kind="server_off",
                        request_json=json.dumps({"kind": "server_off", "server": "OPT12"}),
                        impact_json=json.dumps({"targets": [], "pdus": ["pdu1"], "pins": {}}), status="pending"))
        await db.commit()
    async with anonymous(env) as c:
        cfg = await c.get(f"{B}/config")
        assert cfg.status_code == 200, cfg.text
        assert cfg.json()["password_mode"] == mode and cfg.json().get("can_propose") is False
        for request in ({"kind": "server_off", "server": "OPT12"}, {"kind": "open_console", "server": "OPT11"},
                        {"kind": "lab_shutdown"}, {"kind": "pdu_shutdown", "pdu": "pdu3"}, LOCATION_SWAP,
                        LOCATION_CLEAR):
            expect_error(await propose(c, **request), 403, "password_mode")
        unknown = secrets.token_hex(16)
        for r in (await c.get(f"{B}/proposals"), await c.get(f"{B}/proposals/{unknown}"), await cancel(c, unknown)):
            expect_error(r, 403, "password_mode")
        expect_error(await execute(c, unknown, SHARED), 404, "not_found")
        expect_error(await execute(c, stale_id, SHARED), 403, "password_mode")
    assert "propose_action" not in [spec.name for spec in registry.tools_for(legacy, env.settings)]
    assert env.fleet.created == 0 and env.fleet.calls == [] and await throttle_attempts(env) == 0
    assert await count(env, Proposal) == 1 and (await row(env, stale_id)).status == "pending"


async def test_b7_csrf_origin_and_content_type_are_enforced(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        csrf = c.headers.pop("X-DCIM-CSRF")
        expect_error(await propose(c, kind="server_off", server="OPT31"), 403, detail=CSRF_DENIED)
        expect_error(await execute(c, p["id"]), 403, detail=CSRF_DENIED)
        c.headers["X-DCIM-CSRF"] = csrf
        r = await c.post(f"{B}/proposals/{p['id']}/execute", json={"password": ACCOUNT_PASSWORD},
                         headers={"Origin": "http://evil.example"})
        expect_error(r, 403, detail="Cross-origin action rejected")
        r = await c.post(f"{B}/proposals", content=json.dumps({"kind": "server_off", "server": "OPT31"}),
                         headers={"Content-Type": "text/plain"})
        assert r.status_code == 415, r.text
        r = await c.post(f"{B}/proposals/{p['id']}/execute", content=json.dumps({"password": ACCOUNT_PASSWORD}),
                         headers={"Content-Type": "text/plain"})
        assert r.status_code == 415, r.text
        no_secrets(r.text)
    assert env.fleet.calls == [] and await throttle_attempts(env) == 0
    assert await count(env, Proposal) == 1 and (await row(env, p["id"])).status == "pending"


async def test_b8_signed_out_and_temporary_password_are_refused(env):
    async with anonymous(env) as c:
        expect_error(await propose(c, kind="server_off", server="OPT12"), 401)
        expect_error(await c.get(f"{B}/proposals"), 401)
    async with user(env, "changeme") as c:
        expect_error(await propose(c, kind="server_off", server="OPT12"), 403,
                     detail="Change your temporary password in Account settings first")
    assert env.fleet.created == 0 and await count(env, Proposal) == 0


# ---------------------------------------------------------------------------------------------------------------
# C. Proposal creation: reads, never switches
# ---------------------------------------------------------------------------------------------------------------
async def test_c1_server_off_preview_reads_both_feeds_and_switches_nothing(env):
    async with user(env, "operator") as c:
        r = await propose(c, kind="server_off", server="OPT11", reason="  rack work  ")
    assert r.status_code == 201, r.text
    p = r.json()
    assert HEX32.fullmatch(p["id"])
    assert (p["kind"], p["scope"], p["status"], p["created_by"]) == ("server_off", "server", "pending", "operator")
    assert (p["needs_password"], p["phrase"], p["background"], p["required_role"]) == (True, None, False, "Operator")
    assert abs(iso_seconds(p["expires_at"]) - iso_seconds(p["created_at"]) - 300) < 1
    assert targets_of(p) == [("pdu1", 1, "OPT11 (PSU1)", "on"), ("pdu2", 1, "OPT11 (PSU2)", "on")]
    assert p["impact"]["servers"] == ["OPT11"]
    assert (p["impact"]["counts"]["outlets"], p["impact"]["counts"]["pdus"]) == (2, 2)
    assert p["can_execute"] is True
    assert "pins" not in p["impact"] and "reason" not in p["request"] and "owner_key" not in p
    assert "example.invalid" not in r.text            # PDU addresses stay on the server
    assert env.fleet.calls == [] and env.fleet.auth_ok and all(env.fleet.auth_ok)
    assert await events(env, p["id"]) == [("proposed", "operator")]


@pytest.mark.parametrize("body", [
    {"kind": "outlet_off", "pdu": "pdu1", "outlet": 0},
    {"kind": "outlet_off", "pdu": "pdu1", "outlet": -1},
    {"kind": "outlet_off", "pdu": "pdu1", "outlet": "2"},
    {"kind": "outlet_off", "pdu": "pdu1", "outlet": 2.5},
    {"kind": "outlet_off", "pdu": "pdu1", "outlet": True},
    {"kind": "reboot", "server": "OPT12"},
    {"kind": "server_off", "server": "OPT12", "action": "reboot"},
    {"kind": "server_off", "server": "OPT12", "expires_at": "2099-01-01T00:00:00Z"},
    {"kind": "server_off", "server": "OPT12", "password": SECRET},
    {"kind": "server_off", "server": "OPT12‮"},
    {"kind": "server_off"},
    ["server_off"],
    "server_off",
], ids=["outlet-0", "outlet-negative", "outlet-string", "outlet-float", "outlet-bool", "kind-unknown",
        "extra-action", "client-expiry", "password-field", "bidi-control", "missing-target", "list-body", "string-body"])
async def test_c2_invalid_requests_are_400_before_any_device_contact(env, body):
    async with user(env, "operator") as c:
        r = await c.post(f"{B}/proposals", json=body)
    expect_error(r, 400, "invalid")
    no_secrets(r.text)
    assert env.fleet.created == 0 and await count(env, Proposal) == 0


async def test_c2b_unknown_pdu_kvm_id_out_of_range_outlet_and_oversized_body(env):
    async with user(env, "operator") as c:
        expect_error(await propose(c, kind="outlet_off", pdu="pdu1", outlet=5), 400, "invalid")
        expect_error(await propose(c, kind="outlet_off", pdu="pdu99", outlet=1), 404, "not_resolved")
        expect_error(await propose(c, kind="outlet_off", pdu="kvm1", outlet=1), 404, "not_resolved")
        expect_error(await propose(c, kind="pdu_shutdown", pdu="kvm1"), 404, "not_resolved")
        big = await c.post(f"{B}/proposals", json={"kind": "server_off", "server": "OPT12", "reason": "x" * 20000})
        assert big.status_code in (400, 413), big.text
    assert env.fleet.calls == [] and await count(env, Proposal) == 0


async def test_c3_server_lookup_is_exact_case_insensitive_and_never_guesses(env):
    async with user(env, "operator") as c:
        expect_error(await propose(c, kind="server_off", server="OPT99"), 404, "not_resolved")
        expect_error(await propose(c, kind="server_off", server="Outlet 3"), 404)
        upper = await created(propose(c, kind="server_off", server="OPT11"))
        lower = await created(propose(c, kind="server_off", server="opt11"))
        assert targets_of(lower) == targets_of(upper)
    await set_device(env, "pdu2", enabled=False)
    async with user(env, "operator2") as c:
        expect_error(await propose(c, kind="server_off", server="OPT11"), 409, "invalid")   # lead decision (b)
        env.fleet["pdu1"].unreachable = True
        expect_error(await propose(c, kind="server_on", server="OPT12"), 409, "invalid")
    assert env.fleet.calls == []


async def test_c4_maintenance_blocks_new_on_cycle_and_shutdown_proposals(env):
    async with user(env, "operator") as c:
        r = await maint_shutdown(c, "pdu1")
        assert r.status_code == 200, r.text
        env.fleet.calls.clear()
        for request in ({"kind": "server_on", "server": "OPT13"}, {"kind": "server_cycle", "server": "OPT12"},
                        {"kind": "outlet_on", "pdu": "pdu1", "outlet": 3}, {"kind": "pdu_shutdown", "pdu": "pdu1"}):
            expect_error(await propose(c, **request), 409)
    assert env.fleet.calls == [] and await count(env, Proposal) == 0


async def test_c5_rack_preview_lists_on_off_and_protected_and_switches_nothing(env):
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
    assert (p["phrase"], p["required_role"], p["background"], p["needs_password"]) == ("R1 OFF", "Admin", True, True)
    assert p["impact"]["pdus"] == ["pdu1", "pdu2", "pdu3"]
    assert sorted((t["pdu_id"], t["outlet"]) for t in p["impact"]["targets"]) == R1_ON_OUTLETS
    excluded = {(e["pdu_id"], e["outlet"]): e["reason"] for e in p["impact"]["excluded"]}
    assert excluded[("pdu1", 4)] == "protected"
    assert excluded[("pdu1", 3)] == "already_off" and excluded[("pdu2", 4)] == "already_off"
    assert not any(e["pdu_id"] in ("pdu4", "pdu5", "pdu6") for e in p["impact"]["excluded"])
    assert env.fleet.calls == []


@pytest.mark.parametrize("value", ["", "   ", "pdu1:x", "pdu1", "pdu9:1", "pdu1:9", "pdu1:0", "PDU 01:4,pdu9:2",
                                   "pdu1:4,,"])
async def test_c6_rack_and_lab_are_refused_until_the_protected_list_is_valid(env, value):
    env.settings.power_protected_outlets = value
    async with user(env, "admin") as c:
        for request in ({"kind": "rack_shutdown", "rack": "R1"}, {"kind": "lab_shutdown"}):
            expect_error(await propose(c, **request), 409, "protected_unset")
    assert env.fleet.calls == [] and await count(env, Proposal) == 0


@pytest.mark.parametrize("value,kept", [("none", []), ("NONE", []), ("PDU 01:4", [("pdu1", 4)]),
                                        (" pdu1:4 , pdu1:4 ", [("pdu1", 4)])])
async def test_c6b_valid_protected_lists(env, value, kept):
    """power_protection.parse: "none" acknowledges an empty list, exact names resolve, spaces are trimmed."""
    env.settings.power_protected_outlets = value
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
    assert [(e["pdu_id"], e["outlet"]) for e in p["impact"]["excluded"] if e["reason"] == "protected"] == kept
    assert (("pdu1", 4) in [(t["pdu_id"], t["outlet"]) for t in p["impact"]["targets"]]) is (not kept)


async def test_c6c_single_target_on_a_protected_outlet_is_refused(env):
    async with user(env, "operator") as c:
        for request in ({"kind": "outlet_off", "pdu": "pdu1", "outlet": 4},
                        {"kind": "outlet_cycle", "pdu": "pdu1", "outlet": 4},
                        {"kind": "outlet_on", "pdu": "pdu1", "outlet": 4},
                        {"kind": "server_off", "server": "SW-CORE"}):
            expect_error(await propose(c, **request), 409, "protected")
    assert env.fleet.calls == [] and await count(env, Proposal) == 0


async def test_c8_lab_preview_lists_skipped_pdus_with_reasons(env):
    async with user(env, "operator") as op:
        assert (await maint_shutdown(op, "pdu6")).status_code == 200
    await set_device(env, "pdu4", enabled=False)
    env.fleet["pdu5"].unreachable = True
    env.fleet.calls.clear()
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="lab_shutdown"))
    assert p["phrase"] == "LAB OFF"
    whole = {e["pdu_id"]: e["reason"] for e in p["impact"]["excluded"] if e["outlet"] is None}
    assert whole == {"pdu4": "disabled", "pdu5": "unreachable", "pdu6": "maintenance"}
    assert p["impact"]["pdus"] == ["pdu1", "pdu2", "pdu3"]
    assert p["impact"]["counts"]["outlets"] == len(p["impact"]["targets"]) == 9
    assert env.fleet.calls == [] and env.fleet["pdu4"].created == 0   # a disabled PDU is never contacted


# ---------------------------------------------------------------------------------------------------------------
# D. Lifecycle: owner, expiry, replay, race
# ---------------------------------------------------------------------------------------------------------------
async def test_d1_other_users_get_the_same_404_as_an_unknown_id(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
    unknown = secrets.token_hex(16)
    for name in ("operator2", "admin"):
        async with user(env, name) as c:
            for call in (lambda pid: execute(c, pid, password="wrong-password"), lambda pid: cancel(c, pid)):
                theirs, missing = await call(p["id"]), await call(unknown)
                assert theirs.status_code == missing.status_code == 404, (theirs.text, missing.text)
                assert theirs.json() == missing.json()
            if name == "operator2":
                theirs, missing = await c.get(f"{B}/proposals/{p['id']}"), await c.get(f"{B}/proposals/{unknown}")
                assert theirs.status_code == missing.status_code == 404 and theirs.content == missing.content
                assert all(item["id"] != p["id"] for item in (await c.get(f"{B}/proposals")).json()["items"])
    assert env.fleet.calls == [] and (await row(env, p["id"])).status == "pending"
    assert await throttle_attempts(env) == 0          # the owner check comes before the password


async def test_d3_expired_proposal_is_410_and_never_runs(env):
    async with user(env, "operator") as c:
        fresh = await created(propose(c, kind="server_off", server="OPT12"))
        old = await created(propose(c, kind="server_on", server="OPT13"))
        await set_expiry(env, fresh["id"], time.time() + 2)        # about to expire: still valid
        r = await execute(c, fresh["id"])
        assert r.status_code == 200, r.text
        await set_expiry(env, old["id"], time.time() - 1)
        expect_error(await execute(c, old["id"]), 410, "expired")
        assert (await get(c, old["id"]))["status"] == "expired"
        expect_error(await execute(c, old["id"]), 410, "expired")
        expect_error(await cancel(c, old["id"]), 410, "expired")
    assert ("pdu1", 3, "on") not in env.fleet.calls
    assert "expired" in names(await events(env, old["id"]))
    assert await throttle_attempts(env) == 0


async def test_d4_second_execute_is_409_and_switches_nothing(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        assert (await execute(c, p["id"])).status_code == 200
        calls = list(env.fleet.calls)
        expect_error(await execute(c, p["id"]), 409, "not_pending")
    assert env.fleet.calls == calls == [("pdu1", 2, "off")]


async def test_d5_two_concurrent_executes_run_once(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT11"))
        first, second = await asyncio.gather(execute(c, p["id"]), execute(c, p["id"]))
    assert sorted([first.status_code, second.status_code]) == [200, 409], (first.text, second.text)
    assert sorted(env.fleet.calls) == [("pdu1", 1, "off"), ("pdu2", 1, "off")]
    event_names = names(await events(env, p["id"]))
    assert event_names.count("confirmed") == 1 and event_names.count("finished") == 1


async def test_d6_cancel_is_final_and_races_safely_with_execute(env):
    async with user(env, "operator") as c:
        a = await created(propose(c, kind="server_off", server="OPT12"))
        r = await cancel(c, a["id"])
        assert r.status_code == 200 and r.json()["status"] == "cancelled", r.text
        expect_error(await execute(c, a["id"]), 409, "not_pending")
        expect_error(await cancel(c, a["id"]), 409, "not_pending")
        assert "cancelled" in names(await events(env, a["id"]))

        b = await created(propose(c, kind="server_off", server="OPT12"))
        ran, stopped = await asyncio.gather(execute(c, b["id"]), cancel(c, b["id"]))
        assert sorted([ran.status_code, stopped.status_code]) == [200, 409], (ran.text, stopped.text)
        final = await get(c, b["id"])
        if ran.status_code == 200:
            assert final["status"] == "succeeded" and env.fleet.calls == [("pdu1", 2, "off")]
        else:
            assert final["status"] == "cancelled" and env.fleet.calls == []

        done = await created(propose(c, kind="server_off", server="OPT31"))
        assert (await execute(c, done["id"])).status_code == 200
        expect_error(await cancel(c, done["id"]), 409, "not_pending")


async def test_d7_wrong_password_keeps_the_proposal_pending(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await execute(c, p["id"], password="wrong-password-for-d7")
        expect_error(r, 403, "password", "Password is incorrect")
        assert "wrong-password-for-d7" not in r.text
        assert (await get(c, p["id"]))["status"] == "pending"
        r = await execute(c, p["id"])
        assert r.status_code == 200 and r.json()["status"] == "succeeded", r.text
    in_order(names(await events(env, p["id"])), ["proposed", "denied", "confirmed", "finished"])


async def test_d8_listing_is_own_newest_first_and_secret_free(env):
    async with user(env, "operator2") as other:
        await created(propose(other, kind="server_off", server="OPT61"))
    async with user(env, "operator") as c:
        ids = []
        for server in ("OPT12", "OPT31", "OPT41"):
            ids.append((await created(propose(c, kind="server_off", server=server)))["id"])
            await asyncio.sleep(0.01)
        await set_expiry(env, ids[0], time.time() - 1)
        r = await c.get(f"{B}/proposals?limit=20")
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        assert [item["id"] for item in items] == list(reversed(ids))
        assert all(item["created_by"] == "operator" for item in items)
        assert items[-1]["can_execute"] is False and items[-1]["status"] in ("pending", "expired")
        for item in items:
            assert "pins" not in item["impact"] and "owner_key" not in item and '"password"' not in json.dumps(item)
        assert len((await c.get(f"{B}/proposals?limit=2")).json()["items"]) == 2
        no_secrets(r.text)
        assert "example.invalid" not in r.text


async def test_d9_pending_proposals_are_capped_per_user(env):
    """SEC-ACT-14: at most 3 pending per user and at most 1 pending rack/lab per user; the newest is refused."""
    async with user(env, "operator") as c:
        for server in ("OPT12", "OPT31", "OPT41"):
            await created(propose(c, kind="server_off", server=server))
        expect_error(await propose(c, kind="server_off", server="OPT51"), 409, "busy")
    async with user(env, "admin") as c:
        await created(propose(c, kind="lab_shutdown"))
        expect_error(await propose(c, kind="rack_shutdown", rack="R2"), 409, "busy")


# ---------------------------------------------------------------------------------------------------------------
# E. Password and throttle
# ---------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("body,detail", [
    ({}, "Password is required"), ({"password": ""}, "Password is required"),
    ({"password": 12345}, "Password is required"), ({"password": None}, "Password is required"),
    ({"password": "p" * 300}, "Password is too long"),
], ids=["missing", "empty", "number", "null", "too-long"])
async def test_e1_missing_or_malformed_password_is_400_without_an_attempt(env, body, detail):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await c.post(f"{B}/proposals/{p['id']}/execute", json=body)
    expect_error(r, 400, detail=detail)
    assert "12345" not in r.text and "ppppp" not in r.text
    assert await throttle_attempts(env) == 0 and env.fleet.calls == []


async def test_e1b_execute_body_cannot_carry_targets_or_parameters(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        for extra in ({"targets": [{"pdu_id": "pdu1", "outlet": 4}]}, {"kind": "lab_shutdown"}, {"outlet": 4},
                      {"expires_at": time.time() + 3600}):
            r = await c.post(f"{B}/proposals/{p['id']}/execute", json={"password": ACCOUNT_PASSWORD, **extra})
            expect_error(r, 400)
            no_secrets(r.text)
        assert await throttle_attempts(env) == 0 and env.fleet.calls == []
        assert (await execute(c, p["id"])).status_code == 200
    assert env.fleet.calls == [("pdu1", 2, "off")]          # parameters come only from the stored proposal


async def test_e2_wrong_password_is_403_audited_and_touches_no_device(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        contacted = env.fleet.created
        r = await execute(c, p["id"], password="wrong-" + SECRET)
    expect_error(r, 403, "password", "Password is incorrect")
    no_secrets(r.text)
    assert env.fleet.created == contacted and env.fleet.calls == []
    assert await events(env, p["id"]) == [("proposed", "operator"), ("denied", "operator")]


async def test_e3_ten_failures_throttle_even_the_correct_password(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        statuses = [(await execute(c, p["id"], password="wrong")).status_code for _ in range(10)]
        assert statuses == [403] * 10
        r = await execute(c, p["id"], password="wrong")
        body = expect_error(r, 429, "throttled", "Too many attempts. Try again in five minutes.")
        assert r.headers["retry-after"] == "300", body
        r = await execute(c, p["id"])
        expect_error(r, 429, "throttled")
        assert (await get(c, p["id"]))["status"] == "pending"
    assert env.fleet.calls == []
    assert "throttled" in names(await events(env, p["id"]))


async def test_e4_maintenance_and_actions_share_one_failure_budget(env):
    async with user(env, "operator") as c:
        for _ in range(9):
            assert (await maint_shutdown(c, "pdu3", password="wrong")).status_code == 403
        p = await created(propose(c, kind="server_off", server="OPT12"))
        expect_error(await execute(c, p["id"], password="wrong"), 403, "password")
        expect_error(await execute(c, p["id"]), 429, "throttled")
    assert env.fleet.calls == []


async def test_e4b_successful_confirmations_never_consume_the_budget(env):
    async with user(env, "operator") as c:
        for kind in ("server_off", "server_on") * 3:
            p = await created(propose(c, kind=kind, server="OPT12"))
            r = await execute(c, p["id"])
            assert r.status_code == 200 and r.json()["status"] == "succeeded", r.text
    assert await throttle_attempts(env) == 0


async def test_e5_the_shared_password_is_not_an_operators_password(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        expect_error(await execute(c, p["id"], password=SHARED), 403, "password")
    assert env.fleet.calls == []


# ---------------------------------------------------------------------------------------------------------------
# F. Drift: 409 "drift", status "refused", nothing switched
# ---------------------------------------------------------------------------------------------------------------
async def expect_drift(env, c, proposal_id, phrase=None):
    rows_before = sorted(await maintenance_rows(env))
    calls_before = list(env.fleet.calls)
    body = expect_error(await execute(c, proposal_id, phrase=phrase), 409, "drift", DRIFT)
    assert body["details"], body                            # Hebrew reasons for the card
    assert env.fleet.calls == calls_before
    assert sorted(await maintenance_rows(env)) == rows_before
    assert (await get(c, proposal_id))["status"] == "refused"
    assert "refused" in names(await events(env, proposal_id))
    return body


async def test_f1_a_label_change_after_the_proposal_is_drift(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await c.patch("/api/devices/pdu1/labels", json={**LABELS["pdu1"], "2": "OPT99"},
                          headers={"If-Match": inventory_store.revision(LABELS["pdu1"])})
        assert r.status_code == 200, r.text
        await expect_drift(env, c, p["id"])


async def test_f2_an_outlet_switched_elsewhere_is_drift_for_single_targets(env):
    async with user(env, "operator") as c:
        on = await created(propose(c, kind="server_on", server="OPT13"))       # pdu1:3 is off now
        off = await created(propose(c, kind="server_off", server="OPT12"))     # pdu1:2 is on now
        env.fleet["pdu1"].states.update({3: "on", 2: "off"})                    # someone switched both by hand
        await expect_drift(env, c, on["id"])
        await expect_drift(env, c, off["id"])


async def test_f2b_rack_shutdown_switches_only_outlets_on_then_and_now(env):
    """D3: rack/lab switch only (on at proposal) ∩ (on now); an outlet that came on is left on and reported."""
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
        env.fleet["pdu1"].states[3] = "on"        # off at proposal time: not shown in the card, so it stays on
        env.fleet["pdu3"].states[1] = "off"       # on at proposal time, off now: nothing to switch
        r = await execute(c, p["id"], phrase="R1 OFF")
        assert r.status_code == 202, r.text
        final = await settle(c, p["id"])
    assert final["status"] in ("succeeded", "partial"), final["status"]
    assert ("pdu1", 3, "off") not in env.fleet.calls and env.fleet["pdu1"].states[3] == "on"
    assert ("pdu3", 1, "off") not in env.fleet.calls and ("pdu1", 4, "off") not in env.fleet.calls
    assert {("pdu1", 1, "off"), ("pdu1", 2, "off"), ("pdu3", 2, "off")} <= set(env.fleet.calls)
    assert json.loads((await maintenance_row(env, "pdu1")).outlets_off_json) == [1, 2]
    assert "not_included" in json.dumps(final["result"]) or "not_included" in json.dumps(final["impact"])


@pytest.mark.parametrize("request_body", [
    {"kind": "server_off", "server": "OPT12"}, {"kind": "server_on", "server": "OPT13"},
    {"kind": "server_cycle", "server": "OPT12"}, {"kind": "outlet_off", "pdu": "pdu1", "outlet": 2},
], ids=["server_off", "server_on", "server_cycle", "outlet_off"])
async def test_f3_maintenance_started_after_the_proposal_is_drift(env, request_body):
    async with user(env, "operator") as c:
        p = await created(propose(c, **request_body))
        assert (await maint_shutdown(c, "pdu1")).status_code == 200
        await expect_drift(env, c, p["id"])


async def test_f3b_rack_drift_when_a_member_pdu_enters_maintenance(env):
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
        assert (await maint_shutdown(c, "pdu2")).status_code == 200
        await expect_drift(env, c, p["id"], phrase="R1 OFF")


@pytest.mark.parametrize("change", ["disabled", "address", "deleted"])
async def test_f4_a_disabled_moved_or_deleted_pdu_is_drift_and_never_contacted(env, change):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
    if change == "disabled":
        await set_device(env, "pdu1", enabled=False)
    elif change == "address":
        async with user(env, "admin") as admin:
            r = await admin.put("/api/devices/pdu1", json={"name": "PDU 01", "kind": "pdu", "ip": "moved.example.invalid",
                                                           "model": "PX4", "rack": "R1", "port_count": 4})
            assert r.status_code == 200, r.text
    else:
        async with env.sessions() as db:
            await db.execute(delete(Device).where(Device.id == "pdu1"))
            await db.commit()
    contacted = len(env.fleet.contacted)
    async with user(env, "operator") as c:
        await expect_drift(env, c, p["id"])
    assert env.fleet.contacted[contacted:] == [] and "moved.example.invalid" not in env.fleet.contacted


async def test_f5_lab_drift_when_the_set_of_pdus_changes(env):
    async with user(env, "admin") as c:
        lab = await created(propose(c, kind="lab_shutdown"))
        await add_pdu(env, "pdu7", rack="R2", states={1: "on", 2: "on"})
        await expect_drift(env, c, lab["id"], phrase="LAB OFF")
        rack = await created(propose(c, kind="rack_shutdown", rack="R2"))
        async with env.sessions() as db:
            await db.execute(delete(Device).where(Device.id == "pdu6"))
            await db.commit()
        await expect_drift(env, c, rack["id"], phrase="R2 OFF")


async def test_f6_a_maintenance_commit_while_execute_waits_for_the_lock_never_lets_on_through(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_on", server="OPT13"))
        async with pdu_locks.maintenance_lock("pdu1"):
            task = asyncio.create_task(execute(c, p["id"]))
            await asyncio.sleep(0.3)
            assert not task.done(), task.result().text if task.done() else ""
            async with env.sessions() as db:
                db.add(PduMaintenance(device_id="pdu1", started_at=time.time(), started_by="operator", reason="Concurrent",
                                      outlets_off_json="[1, 2]", failed_json="[]"))
                await db.commit()
        r = await asyncio.wait_for(task, 5)
    assert ("pdu1", 3, "on") not in env.fleet.calls and env.fleet["pdu1"].states[3] == "off"
    assert r.status_code == 409 or (r.status_code == 200 and r.json()["status"] in ("failed", "refused")), r.text


async def test_f7_refused_is_terminal_even_after_the_change_is_reverted(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        await set_device(env, "pdu1", enabled=False)
        await expect_drift(env, c, p["id"])
        await set_device(env, "pdu1", enabled=True)
        expect_error(await execute(c, p["id"]), 409, "not_pending")
    assert env.fleet.calls == []


# ---------------------------------------------------------------------------------------------------------------
# G. Single-target execution
# ---------------------------------------------------------------------------------------------------------------
async def test_g1_server_off_switches_through_the_seam_and_verifies_by_reread(env, monkeypatch):
    plain_calls = []
    monkeypatch.setattr(pdus_module, "outlet_power", lambda *args, **kwargs: plain_calls.append(args))
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        pdus_module._cache["pdu1"] = (time.monotonic(), object())
        r = await execute(c, p["id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "succeeded" and body["can_execute"] is False
    assert env.fleet.calls == [("pdu1", 2, "off")]
    assert results_of(body) == [("pdu1", 2, True, "off")]
    assert "pdu1" not in pdus_module._cache and plain_calls == []
    event_list = await events(env, p["id"])
    in_order(names(event_list), ["proposed", "confirmed", "target", "finished"])
    assert {actor for _, actor in event_list} == {"operator"}
    assert all(env.fleet.auth_ok)


async def test_g2_server_on_switches_an_off_outlet_on(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_on", server="OPT13"))
        r = await execute(c, p["id"])
    assert r.status_code == 200 and r.json()["status"] == "succeeded", r.text
    assert env.fleet.calls == [("pdu1", 3, "on")] and results_of(r.json()) == [("pdu1", 3, True, "on")]


async def test_g3_server_cycle_turns_every_feed_off_before_any_on_under_the_pdu_lock(env):
    held = []

    def probe(device_id):
        return lambda: held.append((device_id, pdu_locks._locks[device_id].locked()))

    env.fleet["pdu1"].side_effects[1] = probe("pdu1")
    env.fleet["pdu2"].side_effects[1] = probe("pdu2")
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_cycle", server="OPT11", then_console=True))
        r = await execute(c, p["id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "succeeded"
    assert env.fleet.calls == [("pdu1", 1, "off"), ("pdu2", 1, "off"), ("pdu1", 1, "on"), ("pdu2", 1, "on")]
    assert env.sleeps == [5.0]
    assert len(held) == 4 and all(locked for _, locked in held), held
    urls = [console["console_url"] for console in body["result"]["consoles"]]
    assert urls == ["/api/kvms/kvm1/autologin?port=1"] and CONSOLE_URL.match(urls[0])


async def test_g4_a_cycle_that_cannot_switch_a_feed_off_restores_power_and_fails(env):
    env.fleet["pdu2"].fail = {1}
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_cycle", server="OPT11"))
        r = await execute(c, p["id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "failed"
    assert env.fleet.calls[:2] == [("pdu1", 1, "off"), ("pdu2", 1, "off")] and ("pdu1", 1, "on") in env.fleet.calls
    assert env.fleet["pdu1"].states[1] == "on" and env.fleet["pdu2"].states[1] == "on"
    assert env.sleeps == []                                     # the off-wait never started
    assert all(not ok for _, _, ok, _ in results_of(body))
    assert any(t["pdu_id"] == "pdu2" and t["error"] for t in body["result"]["targets"])
    assert "finished" in names(await events(env, p["id"]))


async def test_g4b_a_cycle_leaves_a_feed_that_was_off_off(env):
    """Lead decision (a) / D4: a feed off at proposal time is never switched on by a reset."""
    env.fleet["pdu2"].states[1] = "off"
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_cycle", server="OPT11"))
        r = await execute(c, p["id"])
    assert r.status_code == 200, r.text
    assert ("pdu1", 1, "off") in env.fleet.calls and ("pdu1", 1, "on") in env.fleet.calls
    assert ("pdu2", 1, "on") not in env.fleet.calls and env.fleet["pdu2"].states[1] == "off"
    assert env.fleet["pdu1"].states[1] == "on"


async def test_g4c_a_cycle_is_refused_when_every_feed_is_already_off(env):
    """Lead decision 2026-10-20: 409 "no_targets", and the Hebrew details tell the user to power the server on."""
    env.fleet["pdu1"].states[1] = env.fleet["pdu2"].states[1] = "off"
    async with user(env, "operator") as c:
        body = expect_error(await propose(c, kind="server_cycle", server="OPT11"), 409, "no_targets")
    assert re.search(r"הדלק|הדלקה|הדליק", " ".join(body["details"])), body
    assert env.fleet.calls == [] and await count(env, Proposal) == 0


async def test_g5_a_lost_response_is_verified_by_reread(env):
    env.fleet["pdu1"].lost = {2}
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await execute(c, p["id"])
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "succeeded" and results_of(r.json()) == [("pdu1", 2, True, "off")]
    no_secrets(r.text)
    no_secrets(await dump_tables(env))


async def test_g6_a_lost_response_without_a_reread_is_never_reported_done(env):
    pdu = env.fleet["pdu1"]
    pdu.lost = {2}
    pdu.side_effects[2] = lambda: setattr(pdu, "unreachable", True)
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await execute(c, p["id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] != "succeeded" and results_of(body) == [("pdu1", 2, False, "unknown")]
    assert body["result"]["targets"][0]["error"]
    no_secrets(r.text)
    no_secrets(await dump_tables(env))


async def test_g7_an_ignored_command_fails_by_reread(env):
    env.fleet["pdu1"].ignore = {2}
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await execute(c, p["id"])
    assert r.status_code == 200 and r.json()["status"] == "failed", r.text
    assert results_of(r.json()) == [("pdu1", 2, False, "on")]


async def test_g8_a_plain_outlet_request_waits_for_the_assistant_switch_and_its_reread(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        plain = []

        def race():
            env.fleet["pdu1"].side_effects.pop(2)
            plain.append(asyncio.ensure_future(c.post("/api/pdus/pdu1/outlets/2/power", json={"action": "on"})))

        env.fleet["pdu1"].side_effects[2] = race
        r = await execute(c, p["id"])
        assert r.status_code == 200 and results_of(r.json()) == [("pdu1", 2, True, "off")], r.text
        other = await asyncio.wait_for(plain[0], 5)
    assert other.status_code == 200, other.text
    assert env.fleet.calls == [("pdu1", 2, "off"), ("pdu1", 2, "on")]


async def test_g8b_a_maintenance_shutdown_racing_server_on_never_leaves_power_on(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_on", server="OPT13"))
        shut, ran = await asyncio.gather(maint_shutdown(c, "pdu1"), execute(c, p["id"]))
    assert shut.status_code == 200, shut.text
    assert ran.status_code in (200, 409), ran.text
    assert await maintenance_row(env, "pdu1") is not None
    assert env.fleet["pdu1"].states[3] == "off"
    calls = env.fleet.calls
    last_off = max(i for i, call in enumerate(calls) if call[0] == "pdu1" and call[2] == "off")
    assert ("pdu1", 3, "on") not in calls[last_off + 1:]


# ---------------------------------------------------------------------------------------------------------------
# H. PDU, rack and lab shutdown
# ---------------------------------------------------------------------------------------------------------------
async def test_h1_operator_pdu_shutdown_matches_the_maintenance_column(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="pdu_shutdown", pdu="pdu1"))
        r = await execute(c, p["id"])
        assert r.status_code == 200 and r.json()["status"] == "succeeded", r.text
        maintenance = await maintenance_row(env, "pdu1")
        assert json.loads(maintenance.outlets_off_json) == [1, 2] and maintenance.started_by == "operator"
        assert sorted(env.fleet.calls) == [("pdu1", 1, "off"), ("pdu1", 2, "off")]
        listing = (await c.get("/api/pdus/maintenance")).json()
        assert "pdu1" in listing["pdus"]
        assert (listing["log"][0]["action"], listing["log"][0]["by"]) == ("shutdown", "operator")
        r = await maint_restore(c, "pdu1")
        assert r.status_code == 200 and r.json()["state"] is None, r.text
    assert env.fleet["pdu1"].states == {1: "on", 2: "on", 3: "off", 4: "on"}


async def test_h2_admin_rack_shutdown_runs_in_the_background_and_records_the_batch(env):
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
        r = await execute(c, p["id"], phrase="R1 OFF")
        assert r.status_code == 202, r.text
        assert r.json()["status"] == "executing"
        final = await settle(c, p["id"])
    assert final["status"] == "succeeded", final
    assert final["progress"] == {"done": 3, "total": 3} and final["can_restore"] is True
    rows = await maintenance_rows(env)
    assert set(rows) == {"pdu1", "pdu2", "pdu3"} and {r.started_by for r in rows.values()} == {"admin"}
    assert json.loads(rows["pdu1"].outlets_off_json) == [1, 2]
    calls = env.fleet.calls
    assert sorted((d, n) for d, n, _ in calls) == R1_ON_OUTLETS and {a for _, _, a in calls} == {"off"}
    order = [d for d, _, _ in calls]
    assert order == sorted(order)                                   # one PDU at a time
    assert batch_ids(await row(env, p["id"])) == ["pdu1", "pdu2", "pdu3"]
    assert names(await events(env, p["id"])).count("pdu") == 3


@pytest.mark.parametrize("phrase", [None, "", "r1 off", "R1  OFF", "R1 OFF.", "LAB OFF", "R1‏OFF", PHRASE_ATTEMPT],
                         ids=["missing", "empty", "lower", "inner-space", "dot", "other-phrase", "rlm", "random"])
async def test_h3_a_wrong_phrase_is_refused_before_the_password_is_checked(env, phrase):
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
        r = await execute(c, p["id"], password="wrong-password", phrase=phrase)   # wrong password: phrase is first
        expect_error(r, 403, "phrase")
        assert PHRASE_ATTEMPT not in r.text
        assert (await get(c, p["id"]))["status"] == "pending"
    assert await throttle_attempts(env) == 0 and env.fleet.calls == []
    assert PHRASE_ATTEMPT not in await dump_tables(env)


async def test_h3b_the_exact_phrase_with_outer_whitespace_is_accepted(env):
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
        r = await execute(c, p["id"], phrase="  R1 OFF \t")
        assert r.status_code == 202, r.text
        assert (await settle(c, p["id"]))["status"] == "succeeded"


async def test_h4_progress_is_visible_while_the_job_runs(env):
    gate = asyncio.Event()
    env.fleet["pdu2"].gates[1] = gate
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
        assert (await execute(c, p["id"], phrase="R1 OFF")).status_code == 202
        await until(lambda: ("pdu2", 1, "off") in env.fleet.calls)
        middle = await get(c, p["id"])
        assert middle["status"] == "executing" and middle["can_execute"] is False
        assert middle["progress"] == {"done": 1, "total": 3}
        gate.set()
        final = await settle(c, p["id"])
    assert final["status"] == "succeeded" and final["progress"]["done"] == 3


async def test_h5_a_partial_lab_shutdown_processes_every_pdu_and_keeps_every_row(env):
    env.fleet["pdu4"].fail = {1, 3}
    env.fleet["pdu5"].ignore = {2}
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="lab_shutdown"))
        assert (await execute(c, p["id"], phrase="LAB OFF")).status_code == 202
        final = await settle(c, p["id"])
    assert final["status"] == "partial", final
    results = {item["pdu_id"]: item for item in final["result"]["pdus"]}
    assert set(results) == {f"pdu{n}" for n in range(1, 7)}
    assert results["pdu4"]["ok"] is False and results["pdu4"]["failed"] == [1, 3]
    assert results["pdu5"]["ok"] is False and results["pdu5"]["failed"] == [2]
    assert all(results[f"pdu{n}"]["ok"] for n in (1, 2, 3, 6))
    assert set(await maintenance_rows(env)) == {f"pdu{n}" for n in range(1, 7)}
    assert final["can_restore"] is True


async def test_h6_a_pdu_already_in_maintenance_is_neither_switched_nor_adopted(env):
    async with user(env, "operator") as op:
        assert (await maint_shutdown(op, "pdu6")).status_code == 200
    before = await maintenance_row(env, "pdu6")
    env.fleet.calls.clear()
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="lab_shutdown"))
        assert (await execute(c, p["id"], phrase="LAB OFF")).status_code == 202
        assert (await settle(c, p["id"]))["status"] == "succeeded"
    after = await maintenance_row(env, "pdu6")
    assert (after.started_by, after.started_at, after.outlets_off_json) == \
           (before.started_by, before.started_at, before.outlets_off_json)
    assert not any(d == "pdu6" for d, _, _ in env.fleet.calls)
    assert "pdu6" not in batch_ids(await row(env, p["id"]))


async def test_h7_one_background_job_at_a_time(env):
    gate = asyncio.Event()
    env.fleet["pdu2"].gates[1] = gate
    async with user(env, "admin") as a, user(env, "admin2") as b:
        lab = await created(propose(a, kind="lab_shutdown"))
        rack = await created(propose(b, kind="rack_shutdown", rack="R2"))
        assert (await execute(a, lab["id"], phrase="LAB OFF")).status_code == 202
        await until(lambda: ("pdu2", 1, "off") in env.fleet.calls)
        body = expect_error(await execute(b, rack["id"], phrase="R2 OFF"), 409)
        assert body["code"] in ("busy", "drift"), body
        async with user(env, "operator") as op:
            expect_error(await propose(op, kind="server_on", server="OPT13"), 409)   # pdu1 is in the running batch
        gate.set()
        final = await settle(a, lab["id"])
        assert final["status"] == "succeeded", final
        assert (await get(b, rack["id"]))["status"] in ("pending", "refused")
    assert "pdu" not in names(await events(env, rack["id"]))


async def test_h8_the_job_outlives_the_request_and_another_client_sees_the_result(env):
    gate = asyncio.Event()
    env.fleet["pdu3"].gates[1] = gate
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
        assert (await execute(c, p["id"], phrase="R1 OFF")).status_code == 202
    gate.set()                                                      # the first browser is gone
    async with user(env, "admin") as other:
        assert (await settle(other, p["id"]))["status"] == "succeeded"


async def test_h8b_a_restart_mid_job_marks_it_interrupted_and_keeps_the_batch_restorable(env):
    gate = asyncio.Event()
    env.fleet["pdu2"].gates[1] = gate
    async with user(env, "admin") as c:
        p = await created(propose(c, kind="rack_shutdown", rack="R1"))
        before = set(asyncio.all_tasks())
        assert (await execute(c, p["id"], phrase="R1 OFF")).status_code == 202
        await until(lambda: ("pdu2", 1, "off") in env.fleet.calls)
        job = set(asyncio.all_tasks()) - before - {asyncio.current_task()}
        for task in job:                                            # the process stops mid-job
            task.cancel()
        await asyncio.gather(*job, return_exceptions=True)
        # A hard stop leaves "executing" (startup recovery marks it); a cancelled task may mark itself first.
        assert (await row(env, p["id"])).status in ("executing", "interrupted")
        await runner.recover_interrupted(env.sessions)
        final = await get(c, p["id"])
        assert final["status"] == "interrupted" and final["can_restore"] is True
        assert "interrupted" in names(await events(env, p["id"]))
        assert {"pdu1", "pdu2"} <= set(await maintenance_rows(env))
        restore = await created(propose(c, kind="batch_restore", restore_of=p["id"]))
        assert set(restore["impact"]["pdus"]) == {"pdu1", "pdu2"} and restore["phrase"] == "R1 ON"


async def test_h8c_a_restart_during_a_cycle_turns_the_pending_outlets_back_on(env, monkeypatch):
    """D4: the pending-on list is persisted before the first off; recovery switches those outlets back on."""
    env.sleep_gate = asyncio.Event()                                # the off-wait never ends: the process dies there
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_cycle", server="OPT12"))
        task = asyncio.create_task(execute(c, p["id"]))
        await until(lambda: env.fleet["pdu1"].states[2] == "off" and env.sleeps)
        # A new process starts: its PDU lock registry is empty (the dead process held the old locks).
        monkeypatch.setattr(pdu_locks, "_locks", {})
        assert await asyncio.wait_for(runner.recover_interrupted(env.sessions), 10) == 1
        assert env.fleet["pdu1"].states[2] == "on" and ("pdu1", 2, "on") in env.fleet.calls
        assert (await get(c, p["id"]))["status"] == "interrupted"
        task.cancel()
        with contextlib.suppress(BaseException):
            await task


async def test_h9_a_lab_job_and_single_actions_finish_without_deadlock(env):
    async with user(env, "operator") as op, user(env, "admin") as ad:
        single = await created(propose(op, kind="server_off", server="OPT41"))
        lab = await created(propose(ad, kind="lab_shutdown"))
        started, done = await asyncio.wait_for(
            asyncio.gather(execute(ad, lab["id"], phrase="LAB OFF"), execute(op, single["id"])), 10)
        assert started.status_code in (202, 409) and done.status_code in (200, 409), (started.text, done.text)
        if started.status_code == 202:
            assert (await asyncio.wait_for(settle(ad, lab["id"], timeout=10), 12))["status"] in FINAL


# ---------------------------------------------------------------------------------------------------------------
# I. Batch restore
# ---------------------------------------------------------------------------------------------------------------
async def run_batch(env, c, kind="lab_shutdown", rack=None):
    request = {"kind": kind, **({"rack": rack} if rack else {})}
    p = await created(propose(c, **request))
    r = await execute(c, p["id"], phrase=p["phrase"])
    assert r.status_code == 202, r.text
    final = await settle(c, p["id"])
    return p, final


async def test_i1_batch_restore_turns_on_exactly_what_the_batch_turned_off(env):
    async with user(env, "operator") as op:
        assert (await maint_shutdown(op, "pdu6")).status_code == 200
    pdu6_before = await maintenance_row(env, "pdu6")
    async with user(env, "admin") as c:
        lab, final = await run_batch(env, c)
        assert final["status"] == "succeeded"
        off_lists = {d: json.loads(r.outlets_off_json) for d, r in (await maintenance_rows(env)).items() if d != "pdu6"}
        assert off_lists["pdu1"] == [1, 2]
        expected = sorted((d, n) for d, numbers in off_lists.items() for n in numbers)
        env.fleet.calls.clear()
        env.sleeps.clear()
        restore = await created(propose(c, kind="batch_restore", restore_of=lab["id"]))
        assert (restore["phrase"], restore["required_role"], restore["restore_of"]) == ("LAB ON", "Admin", lab["id"])
        assert sorted(restore["impact"]["pdus"]) == ["pdu1", "pdu2", "pdu3", "pdu4", "pdu5"]
        assert sorted((t["pdu_id"], t["outlet"]) for t in restore["impact"]["targets"]) == expected
        assert (await execute(c, restore["id"], phrase="LAB ON")).status_code == 202
        assert (await settle(c, restore["id"]))["status"] == "succeeded"
        assert (await get(c, lab["id"]))["can_restore"] is False
    calls = env.fleet.calls
    assert {a for _, _, a in calls} == {"on"} and sorted((d, n) for d, n, _ in calls) == expected
    assert ("pdu1", 3, "on") not in calls and ("pdu1", 4, "on") not in calls and env.fleet["pdu1"].states[3] == "off"
    order = [d for d, _, _ in calls]
    assert order == sorted(order)                                   # one PDU at a time
    assert env.sleeps == [3.0] * 4                                  # the stagger between five PDUs
    rows = await maintenance_rows(env)
    assert set(rows) == {"pdu6"} and rows["pdu6"].started_at == pdu6_before.started_at


async def test_i2_a_partial_restore_keeps_the_failed_outlets_and_a_second_restore_finishes(env):
    async with user(env, "admin") as c:
        lab, final = await run_batch(env, c)
        assert final["status"] == "succeeded"
        env.fleet["pdu4"].ignore = {2}
        first = await created(propose(c, kind="batch_restore", restore_of=lab["id"]))
        assert (await execute(c, first["id"], phrase="LAB ON")).status_code == 202
        assert (await settle(c, first["id"]))["status"] == "partial"
        rows = await maintenance_rows(env)
        assert set(rows) == {"pdu4"} and json.loads(rows["pdu4"].outlets_off_json) == [2]
        assert (await get(c, lab["id"]))["can_restore"] is True
        env.fleet["pdu4"].ignore = set()
        env.fleet.calls.clear()
        second = await created(propose(c, kind="batch_restore", restore_of=lab["id"]))
        assert second["impact"]["pdus"] == ["pdu4"]
        assert [(t["pdu_id"], t["outlet"]) for t in second["impact"]["targets"]] == [("pdu4", 2)]
        assert (await execute(c, second["id"], phrase="LAB ON")).status_code == 202
        assert (await settle(c, second["id"]))["status"] == "succeeded"
    assert env.fleet.calls == [("pdu4", 2, "on")] and await maintenance_rows(env) == {}


async def test_i3_nothing_left_to_restore_is_409(env):
    async with user(env, "admin") as c:
        rack, _ = await run_batch(env, c, "rack_shutdown", "R1")
        restore = await created(propose(c, kind="batch_restore", restore_of=rack["id"]))
        assert (await execute(c, restore["id"], phrase="R1 ON")).status_code == 202
        assert (await settle(c, restore["id"]))["status"] == "succeeded"
        expect_error(await propose(c, kind="batch_restore", restore_of=rack["id"]), 409)
        expect_error(await execute(c, restore["id"], phrase="R1 ON"), 409, "not_pending")


async def test_i4_restore_skips_pdus_restored_by_hand_and_refuses_after_a_late_manual_restore(env):
    async with user(env, "admin") as c:
        rack, final = await run_batch(env, c, "rack_shutdown", "R1")
        assert final["status"] == "succeeded"
        assert (await maint_restore(c, "pdu2")).status_code == 200
        restore = await created(propose(c, kind="batch_restore", restore_of=rack["id"]))
        assert sorted(restore["impact"]["pdus"]) == ["pdu1", "pdu3"]
        assert (await maint_restore(c, "pdu3")).status_code == 200
        await expect_drift(env, c, restore["id"], phrase="R1 ON")


async def test_i6_restore_roles_follow_the_shutdown(env):
    async with user(env, "operator") as op:
        shutdown = await created(propose(op, kind="pdu_shutdown", pdu="pdu3"))
        assert (await execute(op, shutdown["id"])).status_code == 200
        back = await created(propose(op, kind="pdu_restore", pdu="pdu3"))
        r = await execute(op, back["id"])
        assert r.status_code == 200 and r.json()["status"] == "succeeded", r.text
        assert await maintenance_row(env, "pdu3") is None
    async with user(env, "admin") as ad:
        lab, _ = await run_batch(env, ad, "rack_shutdown", "R2")
    async with user(env, "operator") as op:
        expect_error(await propose(op, kind="batch_restore", restore_of=lab["id"]), 403, "forbidden")


# ---------------------------------------------------------------------------------------------------------------
# J. Open console
# ---------------------------------------------------------------------------------------------------------------
async def test_j1_open_console_is_ready_without_a_password_and_contacts_nothing(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="open_console", server="OPT11"))
    assert (p["status"], p["needs_password"], p["can_execute"]) == ("ready", False, False)
    consoles = [(x["kvm_id"], x["port"], x["console_url"]) for x in p["impact"]["consoles"]]
    assert consoles == [("kvm1", 1, "/api/kvms/kvm1/autologin?port=1")]
    assert CONSOLE_URL.match(consoles[0][2])
    assert env.fleet.created == 0
    assert await events(env, p["id"]) == [("proposed", "operator")]


async def test_j2_a_server_on_two_kvm_ports_lists_both_and_never_guesses(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="open_console", server="OPT12"))
    assert sorted((x["kvm_id"], x["port"]) for x in p["impact"]["consoles"]) == [("kvm1", 2), ("kvm2", 3)]


async def test_j3_no_kvm_mapping_is_404_and_device_ids_are_url_encoded(env):
    async with env.sessions() as db:
        db.add(Device(id="kvm a/b", name="KVM AB", kind="kvm", model="KX III", ip="kvmab.example.invalid", rack="R1",
                      port_count=4, labels_json=json.dumps({"1": "OPT31"})))
        await db.commit()
    async with user(env, "operator") as c:
        expect_error(await propose(c, kind="open_console", server="OPT13"), 404, "not_resolved")
        p = await created(propose(c, kind="open_console", server="OPT31"))
    assert [x["console_url"] for x in p["impact"]["consoles"]] == ["/api/kvms/kvm%20a%2Fb/autologin?port=1"]


async def test_j4_viewer_cannot_open_and_a_console_proposal_has_nothing_to_execute(env):
    async with user(env, "viewer") as c:
        expect_error(await propose(c, kind="open_console", server="OPT11"), 403, detail=ROLE_DENIED)
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="open_console", server="OPT11"))
        expect_error(await execute(c, p["id"]), 409, "not_pending")
    assert env.fleet.calls == [] and await throttle_attempts(env) == 0


async def test_j5_a_pxe_job_holding_the_console_port_is_a_warning(env):
    now = time.time()
    async with env.sessions() as db:
        db.add(PxeJob(id="job-qa", computer_key="server:opt11", computer_name="OPT11", kvm_device_id="kvm1", kvm_port=1,
                      reboot_method="manual", driver="simulated", state="waiting_boot_menu", state_entered_at=now,
                      deadline_at=now + 600, created_by="operator", created_at=now, updated_at=now,
                      active_port_key="kvm1:1"))
        await db.commit()
    async with user(env, "operator") as c:
        console = await created(propose(c, kind="open_console", server="OPT11"))
        cycle = await created(propose(c, kind="server_cycle", server="OPT11"))
    assert console["impact"]["warnings_he"] and cycle["impact"]["warnings_he"]


# ---------------------------------------------------------------------------------------------------------------
# K. Audit and secrets
# ---------------------------------------------------------------------------------------------------------------
async def test_k2_the_audit_and_the_maintenance_row_are_committed_before_the_switch(env):
    seen = {}
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))

        async def probe_power():
            seen["power"] = names(await events(env, p["id"]))

        env.fleet["pdu1"].hooks[2] = probe_power
        assert (await execute(c, p["id"])).status_code == 200
        q = await created(propose(c, kind="pdu_shutdown", pdu="pdu3"))

        async def probe_maintenance():
            seen["row"] = await maintenance_row(env, "pdu3")
            seen["maintenance"] = names(await events(env, q["id"]))

        env.fleet["pdu3"].hooks[1] = probe_maintenance
        assert (await execute(c, q["id"])).status_code == 200
    assert "confirmed" in seen["power"] and "confirmed" in seen["maintenance"]
    assert seen["row"] is not None and seen["row"].started_by == "operator"


async def test_k2b_an_unexpected_driver_error_still_finishes_the_audit(env):
    async def crash():
        raise RuntimeError("driver crashed " + SECRET)

    env.fleet["pdu1"].hooks[2] = crash
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await execute(c, p["id"])
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "failed" and results_of(r.json())[0][2] is False
    assert "finished" in names(await events(env, p["id"]))
    no_secrets(r.text)
    no_secrets(await dump_tables(env))


async def test_k3_no_secret_reaches_responses_rows_or_logs(env, caplog):
    caplog.set_level(logging.DEBUG, logger="app")
    caplog.set_level(logging.DEBUG, logger="drivers")
    env.fleet["pdu1"].lost = {2}
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12", reason="maintenance window"))
        await execute(c, p["id"], password="wrong-" + SECRET)
        assert (await execute(c, p["id"])).status_code == 200
        await c.get(f"{B}/proposals")
        await get(c, p["id"])
        await c.get(f"{B}/config")
    async with user(env, "admin") as c:
        lab = await created(propose(c, kind="lab_shutdown"))
        await execute(c, lab["id"], phrase=PHRASE_ATTEMPT)
        assert (await execute(c, lab["id"], phrase="LAB OFF")).status_code == 202
        await settle(c, lab["id"])
    dump = await dump_tables(env)
    assert env.responses
    for value in env.responses + [dump, caplog.text]:
        no_secrets(value, *env.tokens)
        assert PHRASE_ATTEMPT not in value
    for value in env.responses:
        assert "example.invalid" not in value                       # device addresses stay on the server
    async with env.sessions() as db:
        columns = [r[1] for r in (await db.execute(text("PRAGMA table_info(assistant_action_proposals)"))).all()]
    assert not any("password" in column for column in columns)


async def test_k4_the_action_audit_and_the_maintenance_log_prune_independently(env, monkeypatch):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        assert (await maint_shutdown(c, "pdu3")).status_code == 200
    async with env.sessions() as db:
        for _ in range(600):
            await store.add_event(db, p["id"], "operator", "denied", {"reason": "password"})
        await db.commit()
    assert await count(env, PduMaintenanceLog) == 1
    assert "proposed" in names(await events(env, p["id"]))         # denials never push out the history
    monkeypatch.setattr(pm, "LOG_KEEP", 2)
    async with user(env, "operator") as c:
        for _ in range(3):
            assert (await maint_shutdown(c, "pdu4", password="wrong")).status_code == 403
    assert await count(env, PduMaintenanceLog) == 2
    assert await count(env, Event) >= 601


async def test_k5_events_and_details_are_private_to_the_owner(env):
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        assert (await get(c, p["id"]))["id"] == p["id"]
    async with user(env, "operator2") as c:
        expect_error(await c.get(f"{B}/proposals/{p['id']}"), 404, "not_found")


# ---------------------------------------------------------------------------------------------------------------
# L. Demo mode and the model boundary (flag on, protected outlets configured)
# ---------------------------------------------------------------------------------------------------------------
async def test_l1_lab_off_in_chat_prepares_one_card_for_admin_and_explains_for_operator(env):
    tools_module()
    async with user(env, "admin") as c:
        r = await chat(c, "כבה חשמל לכל המעבדה")
        assert r.status_code == 200, r.text
        cards = r.json()["action_proposals"]
        assert [(x["kind"], x["status"], x["phrase"]) for x in cards] == [("lab_shutdown", "pending", "LAB OFF")]
        assert HEX32.fullmatch(cards[0]["id"])
    async with user(env, "operator") as c:
        r = await chat(c, "כבה חשמל לכל המעבדה")
        assert r.status_code == 200, r.text
        assert r.json()["action_proposals"] == []
        assert re.search(r"Admin|הרשא", r.json()["answer"]["summary"]), r.json()["answer"]["summary"]
    assert env.fleet.calls == [] and await count(env, Proposal) == 1


async def test_l2_reset_and_kvm_prepares_a_cycle_with_a_console_follow_up(env):
    tools_module()
    async with user(env, "operator") as c:
        r = await chat(c, "תעשה ריסט לשרת OPT11 ותפתח KVM")
    assert r.status_code == 200, r.text
    cards = r.json()["action_proposals"]
    assert len(cards) == 1 and cards[0]["kind"] == "server_cycle" and cards[0]["request"]["then_console"] is True
    assert sorted((t["pdu_id"], t["outlet"]) for t in cards[0]["impact"]["targets"]) == [("pdu1", 1), ("pdu2", 1)]
    assert [x["console_url"] for x in cards[0]["impact"]["consoles"]] == ["/api/kvms/kvm1/autologin?port=1"]
    assert "בוצע" not in r.json()["answer"]["summary"]              # never claims it was done
    assert env.fleet.calls == []


async def test_l3_restore_in_chat_targets_the_latest_restorable_batch(env):
    tools_module()
    async with user(env, "admin") as c:
        r = await chat(c, "תחזיר חשמל")
        assert r.status_code == 200 and r.json()["action_proposals"] == [], r.text
        assert await count(env, Proposal) == 0
        rack, final = await run_batch(env, c, "rack_shutdown", "R1")
        assert final["status"] == "succeeded"
        r = await chat(c, "תחזיר חשמל")
        assert r.status_code == 200, r.text
        cards = r.json()["action_proposals"]
        assert [(x["kind"], x["restore_of"], x["phrase"]) for x in cards] == [("batch_restore", rack["id"], "R1 ON")]


@pytest.mark.parametrize("message", ["אל תכבה את המעבדה", "מה נפל במעבדה?", "מה יקרה אם אכבה את R1?",
                                     "כבה את OPT11 ואת OPT12"],
                         ids=["negation", "status-question", "what-if", "two-targets"])
async def test_l4_negations_questions_and_double_targets_never_create_a_proposal(env, message):
    tools_module()
    async with user(env, "admin") as c:
        r = await chat(c, message)
    assert r.status_code == 200, r.text
    assert r.json()["action_proposals"] == []
    assert await count(env, Proposal) == 0 and env.fleet.calls == []


async def test_l5_the_chat_cannot_confirm_and_no_tool_executes(env):
    tools_module()
    tool_names = [spec.name for spec in registry.tools_for(Principal("admin", "admin", "Admin"), env.settings)]
    assert "propose_action" in tool_names
    assert not any("execute" in name or "confirm" in name for name in tool_names)
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_off", server="OPT12"))
        r = await chat(c, f"אשר את {p['id']} סיסמה {ACCOUNT_PASSWORD}")
        assert r.status_code == 200, r.text
        assert (await get(c, p["id"]))["status"] == "pending"
    assert env.fleet.calls == []


async def test_l6_a_chat_proposal_is_private_to_its_owner(env):
    tools_module()
    async with user(env, "operator") as c:
        r = await chat(c, "כבה את OPT12")
        assert r.status_code == 200, r.text
        cards = r.json()["action_proposals"]
        assert [x["kind"] for x in cards] == ["server_off"]
    async with user(env, "operator2") as c:
        expect_error(await c.get(f"{B}/proposals/{cards[0]['id']}"), 404)
        expect_error(await execute(c, cards[0]["id"]), 404)
    assert env.fleet.calls == []


async def test_l7_the_tool_refuses_targets_the_user_did_not_write(env):
    """D2 intent anchor at the tool boundary: only this turn's user text (or page) decides the target."""
    tools = tools_module()
    spec = next(s for s in tools.TOOLS if s.name == "propose_action")

    def context(user_id, role, message):
        return ToolContext(principal=Principal(user_id, user_id, role), session_factory=env.sessions,
                           settings=env.settings, now=time.time(), user_message=message)

    refused = [("operator", "Operator", "כבה את OPT12", {"kind": "server_off", "server": "OPT11"}),
               ("admin", "Admin", "כבה את OPT12", {"kind": "lab_shutdown"}),
               ("admin", "Admin", "כבה את ארון R2", {"kind": "rack_shutdown", "rack": "R1"}),
               ("operator", "Operator", "כבה את pdu1", {"kind": "outlet_off", "pdu": "pdu1", "outlet": 2})]
    for user_id, role, message, args in refused:
        try:
            result = await spec.func(context(user_id, role, message), **args)
        except ToolError:
            continue
        assert "id" not in json.dumps(result.data), (message, args)
    assert await count(env, Proposal) == 0
    ctx = context("operator", "Operator", "כבה את OPT12")
    result = await spec.func(ctx, kind="server_off", server="OPT12")
    assert result.data["executed"] is False and len(ctx.proposals) == 1
    assert await count(env, Proposal) == 1 and env.fleet.calls == []


# ---------------------------------------------------------------------------------------------------------------
# M. Regression of the existing power endpoints
# ---------------------------------------------------------------------------------------------------------------
async def test_m2_plain_outlet_and_manual_maintenance_endpoints_keep_their_responses(env):
    async with user(env, "operator") as c:
        r = await c.post("/api/pdus/pdu1/outlets/2/power", json={"action": "off"})
        assert r.status_code == 200 and r.json() == {"ok": True, "outlet": 2, "action": "off"}, r.text
        r = await maint_shutdown(c, "pdu3")
        assert r.status_code == 200, r.text
        assert r.json()["state"]["outlets_off"] == [1, 2, 3, 4] and r.json()["state"]["started_by"] == "operator"
        r = await maint_restore(c, "pdu3")
        assert r.status_code == 200 and r.json()["state"] is None, r.text
    assert await count(env, Event) == 0 and await count(env, Proposal) == 0


async def test_m2b_existing_endpoints_never_switch_a_protected_outlet(env):
    """D5 / SEC-ACT-20: the plain outlet endpoint refuses off/cycle of a protected outlet; maintenance excludes it."""
    async with user(env, "operator") as c:
        for action in ("off", "cycle"):
            r = await c.post("/api/pdus/pdu1/outlets/4/power", json={"action": action})
            assert r.status_code == 409, (action, r.text)
        r = await maint_shutdown(c, "pdu1")
        assert r.status_code == 200, r.text
        assert 4 not in r.json()["state"]["outlets_off"]
    assert not any(call[:2] == ("pdu1", 4) for call in env.fleet.calls) and env.fleet["pdu1"].states[4] == "on"


# ---------------------------------------------------------------------------------------------------------------
# N. Location changes (server_swap / server_move / server_clear): data kinds, no password (D9), the real Locations
#    planner of routers/devices.py, never a PDU/KVM contact and never a power change
# ---------------------------------------------------------------------------------------------------------------
@pytest.fixture
def real_planner():
    missing = [name for name in PLANNER_FUNCTIONS if not callable(getattr(devices, name, None))]
    if missing:
        pytest.skip("routers/devices.py has no " + ", ".join(missing) + " yet (ACT-12)")


def seed_layout(env, slots=SLOTS):
    (env.layout_dir / "rack_slots.json").write_text(json.dumps(slots), encoding="utf-8")


def read_layout(env, name="rack_slots.json"):
    path = env.layout_dir / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


async def labels_of(env, device_id):
    async with env.sessions() as db:
        return json.loads((await db.get(Device, device_id, populate_existing=True)).labels_json or "{}")


def changes_of(public):
    return sorted((c["device_id"], c["port"], c["before"], c["after"]) for c in public["impact"]["changes"])


def positions_of(public, key="impact"):
    rows = public[key]["positions"]
    return {row["server"]: ((row["before"]["rack"], row["before"]["slot"]), (row["after"]["rack"], row["after"]["slot"]))
            for row in rows}


async def confirm_data(c, proposal_id, body=None):
    return await c.post(f"{B}/proposals/{proposal_id}/execute", json={} if body is None else body)


SWAP_CHANGES = sorted([("kvm1", "2", "OPT12", "OPT13"), ("kvm2", "3", "OPT12", "OPT13"),
                       ("pdu1", "2", "OPT12", "OPT13"), ("pdu1", "3", "OPT13", "OPT12")])


@pytest.mark.parametrize("body", [
    {"kind": "server_swap", "server": "OPT12"},
    {"kind": "server_swap", "server": "OPT12", "target_ports": [{"device": "pdu3", "port": "4"}]},
    {"kind": "server_move", "server": "OPT12", "target_server": "OPT13",
     "target_ports": [{"device": "pdu3", "port": "4"}]},
    {"kind": "server_move", "server": "OPT12", "target_server": "OPT13", "target_slot": 3},
    {"kind": "server_move", "server": "OPT12"},
    {"kind": "server_move", "server": "OPT12", "target_ports": [{"device": "pdu3", "port": str(n)} for n in range(1, 10)]},
    {"kind": "server_clear", "server": "OPT12", "target_server": "OPT13"},
    {"kind": "server_off", "server": "OPT12", "target_server": "OPT13"},
    {"kind": "server_swap", "server": "OPT12", "target_server": "OPT13", "pdu": "pdu1"},
    {"kind": "server_swap", "server": "OPT12", "target_server": "OPT13‮"},
], ids=["swap-no-target", "swap-with-ports", "move-target-and-ports", "move-target-and-slot", "move-no-target",
        "move-nine-ports", "clear-with-target", "power-kind-with-target", "swap-with-pdu", "bidi-target"])
async def test_n0_location_requests_are_validated_before_anything_is_planned(env, body):
    async with user(env, "operator") as c:
        r = await c.post(f"{B}/proposals", json=body)
    expect_error(r, 400, "invalid")
    assert await count(env, Proposal) == 0 and env.fleet.created == 0


async def test_n1_swap_previews_every_change_and_runs_on_one_click_without_a_password(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        r = await propose(c, **LOCATION_SWAP)
        assert r.status_code == 201, r.text
        p = r.json()
        assert (p["kind"], p["status"], p["needs_password"], p["phrase"], p["background"]) == \
               ("server_swap", "pending", False, None, False)
        assert p["can_execute"] is True and "pins" not in p["impact"]
        assert changes_of(p) == SWAP_CHANGES
        assert positions_of(p) == {"OPT12": (("R1", 10), ("R1", 12)), "OPT13": (("R1", 12), ("R1", 10))}
        assert p["impact"]["unplaced"] == []
        assert (await labels_of(env, "pdu1")) == LABELS["pdu1"] and read_layout(env) == SLOTS   # the preview wrote nothing
        r = await confirm_data(c, p["id"])
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "succeeded"
        expect_error(await confirm_data(c, p["id"]), 409, "not_pending")
    assert (await labels_of(env, "pdu1"))["2"] == "OPT13" and (await labels_of(env, "pdu1"))["3"] == "OPT12"
    assert (await labels_of(env, "kvm1"))["2"] == "OPT13" and (await labels_of(env, "kvm2"))["3"] == "OPT13"
    assert read_layout(env)["R1"] == {"opt13": 10, "opt12": 12}
    in_order(names(await events(env, p["id"])), ["proposed", "confirmed", "finished"])
    assert env.fleet.created == 0 and env.fleet.calls == [] and await throttle_attempts(env) == 0
    no_secrets(r.text)


async def test_n1b_two_concurrent_confirmations_swap_once(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        p = await created(propose(c, **LOCATION_SWAP))
        first, second = await asyncio.gather(confirm_data(c, p["id"]), confirm_data(c, p["id"]))
    assert sorted([first.status_code, second.status_code]) == [200, 409], (first.text, second.text)
    assert (await labels_of(env, "pdu1"))["2"] == "OPT13"           # swapped exactly once, never swapped back
    assert read_layout(env)["R1"] == {"opt13": 10, "opt12": 12}


async def test_n1c_a_location_confirmation_body_is_still_allowlisted(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        p = await created(propose(c, **LOCATION_SWAP))
        for extra in ({"target_server": "OPT31"}, {"changes": []}, {"kind": "server_clear"}):
            expect_error(await confirm_data(c, p["id"], extra), 400, "invalid")
        assert (await get(c, p["id"]))["status"] == "pending"
        assert (await labels_of(env, "pdu1")) == LABELS["pdu1"]


async def test_n2_move_to_empty_ports_with_a_new_rack_slot(env, real_planner):
    seed_layout(env)
    request = {"kind": "server_move", "server": "OPT13", "target_ports": [{"device": "PDU 03", "port": "4"}],
               "target_rack": "R2", "target_slot": 5}
    async with user(env, "operator") as c:
        p = await created(propose(c, **request))
        assert changes_of(p) == [("pdu1", "3", "OPT13", "Outlet 3"), ("pdu3", "4", None, "OPT13")]
        assert positions_of(p) == {"OPT13": (("R1", 12), ("R2", 5))}
        r = await confirm_data(c, p["id"])
        assert r.status_code == 200 and r.json()["status"] == "succeeded", r.text
    assert (await labels_of(env, "pdu1"))["3"] == "Outlet 3" and (await labels_of(env, "pdu3"))["4"] == "OPT13"
    assert read_layout(env)["R2"]["opt13"] == 5 and read_layout(env, "rack_overrides.json").get("opt13") == "R2"
    assert env.fleet.created == 0 and env.fleet.calls == []


async def test_n3_a_port_used_by_another_server_is_refused_never_swapped(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        body = expect_error(await propose(c, kind="server_move", server="OPT13",
                                          target_ports=[{"device": "pdu3", "port": "1"}]), 409)
    assert "OPT31" in body["detail"]
    assert await count(env, Proposal) == 0 and (await labels_of(env, "pdu3")) == LABELS["pdu3"]
    assert read_layout(env) == SLOTS


async def test_n4_taking_another_servers_place_without_swap_warns_who_is_left_unplaced(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        p = await created(propose(c, kind="server_move", server="OPT12", target_server="OPT13"))
    assert p["impact"]["unplaced"] == ["OPT13"]
    assert any("OPT13" in text for text in p["impact"]["warnings_he"]), p["impact"]["warnings_he"]
    assert ("pdu1", "2", "OPT12", "Outlet 2") in changes_of(p) and ("pdu1", "3", "OPT13", "OPT12") in changes_of(p)
    assert (await labels_of(env, "pdu1")) == LABELS["pdu1"] and read_layout(env) == SLOTS


async def test_n5_clear_resets_the_port_names_and_keeps_the_rack_position(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        p = await created(propose(c, **LOCATION_CLEAR))
        assert changes_of(p) == [("pdu1", "3", "OPT13", "Outlet 3")]
        assert positions_of(p) == {"OPT13": (("R1", 12), ("R1", 12))}
        assert any("נשמר" in text for text in p["impact"]["warnings_he"]), p["impact"]["warnings_he"]
        r = await confirm_data(c, p["id"])
        assert r.status_code == 200 and r.json()["status"] == "succeeded", r.text
    assert (await labels_of(env, "pdu1"))["3"] == "Outlet 3" and read_layout(env) == SLOTS
    assert env.fleet.created == 0 and env.fleet.calls == []


async def test_n6_any_change_after_the_preview_is_drift_and_nothing_is_written(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        swap = await created(propose(c, **LOCATION_SWAP))
        clear = await created(propose(c, kind="server_clear", server="OPT12"))
        r = await c.patch("/api/devices/pdu1/labels", json={**LABELS["pdu1"], "3": "OPT99"},
                          headers={"If-Match": inventory_store.revision(LABELS["pdu1"])})
        assert r.status_code == 200, r.text
        await expect_drift(env, c, swap["id"])
        assert (await labels_of(env, "pdu1"))["2"] == "OPT12" and read_layout(env) == SLOTS
        seed_layout(env, {"R1": {"opt12": 15, "opt13": 12}, "R2": {"opt41": 3}})   # someone moved OPT12 meanwhile
        await expect_drift(env, c, clear["id"])
        assert (await labels_of(env, "pdu1"))["2"] == "OPT12"
    assert env.fleet.created == 0


async def test_n7_owner_role_and_mode_rules_apply_to_location_changes(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        p = await created(propose(c, **LOCATION_SWAP))
    async with user(env, "operator2") as other:
        expect_error(await confirm_data(other, p["id"]), 404, "not_found")
    async with user(env, "viewer") as viewer:
        expect_error(await confirm_data(viewer, p["id"]), 403, detail=ROLE_DENIED)
    env.settings.assistant_actions_enabled = False
    async with user(env, "operator") as c:
        expect_error(await confirm_data(c, p["id"]), 403, "disabled")
    env.settings.assistant_actions_enabled = True
    assert (await row(env, p["id"])).status == "pending" and (await labels_of(env, "pdu1")) == LABELS["pdu1"]


async def test_n8_unknown_servers_are_refused_with_candidates(env, real_planner):
    seed_layout(env)
    async with user(env, "operator") as c:
        expect_error(await propose(c, kind="server_swap", server="OPT12", target_server="OPT99"), 404, "not_resolved")
        expect_error(await propose(c, kind="server_clear", server="OPT98"), 404, "not_resolved")
        expect_error(await propose(c, kind="server_swap", server="OPT12", target_server="opt12"), 400)
    assert await count(env, Proposal) == 0


async def test_n9_chat_prepares_location_cards_and_changes_nothing_until_confirmed(env, real_planner):
    tools_module()
    seed_layout(env)
    async with user(env, "operator") as c:
        r = await chat(c, "תחליף בין OPT12 ל-OPT13")
        assert r.status_code == 200, r.text
        cards = r.json()["action_proposals"]
        assert [(x["kind"], x["needs_password"], x["request"]["target_server"]) for x in cards] == \
               [("server_swap", False, "OPT13")]
        assert changes_of(cards[0]) == SWAP_CHANGES
        r = await chat(c, "תנקה את OPT13")
        assert [x["kind"] for x in r.json()["action_proposals"]] == ["server_clear"]
        r = await chat(c, "תחליף בין OPT12 ל-OPT31?")
        assert r.json()["action_proposals"] == []                   # a question never prepares a change
    assert (await labels_of(env, "pdu1")) == LABELS["pdu1"] and read_layout(env) == SLOTS
    assert await count(env, Proposal) == 2 and env.fleet.created == 0
