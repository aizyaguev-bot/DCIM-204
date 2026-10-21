"""ACT-12: assistant location changes (server_swap / server_move / server_clear) end to end.

The Locations planner (routers/devices.py plan_move / apply_move / plan_clear / apply_clear) is a fake unless a test
says it uses the real planner; those tests are skipped until the planner functions exist. In-memory SQLite, a temporary
layout folder, simulated devices only: no PDU or KVM is contacted and no power is switched.
"""
import asyncio
import copy
import hashlib
import json
import secrets
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, confirm, inventory_store
from app.assistant import demo, engine
from app.assistant.actions import locations, resolve, runner, store, tools
from app.assistant.actions import router as actions
from app.assistant.actions.contracts import KIND_SPECS, ActionError, ProposalRequest
from app.assistant.actions.models import AssistantActionEvent, AssistantActionProposal
from app.assistant.contracts import Principal, Source, ToolContext, ToolResult, ToolSpec
from app.database import Base, get_db
from app.models import Device, User
from app.routers import devices

PROPOSALS = "/api/assistant/actions/proposals"
PASSWORD = "synthetic-account-secret-7c2e"
PASSWORD_HASH = hashlib.sha256(PASSWORD.encode()).hexdigest()
OPERATOR = Principal("operator", "operator", "Operator")
NOW = 1_792_300_000.0
REAL_PLANNER = hasattr(devices, "move_server") and hasattr(devices, "plan_move")

SWAP_PLAN = {
    "ok": True, "dry_run": True,
    "changes": [
        {"device_id": "pdu-05", "device_name": "PDU-05", "kind": "pdu", "port": "1", "before": "OPTN44", "after": "optn45"},
        {"device_id": "pdu-05", "device_name": "PDU-05", "kind": "pdu", "port": "2", "before": "OPTN45", "after": "OPTN44"},
        {"device_id": "kvm-2", "device_name": "KVM-2", "kind": "kvm", "port": "1", "before": "optn44", "after": "optn45"},
    ],
    "positions": [{"server": "OPTN45", "before": {"rack": "Rack-01", "slot": 7}, "after": {"rack": "Rack-01", "slot": 3}},
                  {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": "Rack-01", "slot": 7}}],
    "unplaced": [],
}
MOVE_PLAN = {**SWAP_PLAN, "changes": SWAP_PLAN["changes"][:2], "unplaced": ["OPTN44"],
             "positions": [SWAP_PLAN["positions"][0],
                           {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3},
                            "after": {"rack": None, "slot": None}}]}
CLEAR_PLAN = {"ok": True, "dry_run": True,
              "changes": [{"device_id": "pdu-05", "device_name": "PDU-05", "kind": "pdu", "port": "3",
                           "before": "optn12", "after": "Outlet 3"}],
              "positions": [{"server": "optn12", "before": {"rack": "Rack-02", "slot": 4},
                             "after": {"rack": "Rack-02", "slot": 4}}],
              "unplaced": []}


class FakePlanner:
    """routers/devices.py planner functions: records every call; apply refuses a plan that differs from `expected`."""

    def __init__(self):
        self.calls = []
        self.plans = {"move": copy.deepcopy(SWAP_PLAN), "clear": copy.deepcopy(CLEAR_PLAN)}
        self.error = None          # HTTPException raised by plan_* and apply_*
        self.apply_error = None    # HTTPException raised by apply_* only
        self.applied = []

    def _answer(self, op, dry_run):
        if self.error:
            raise self.error
        return {**copy.deepcopy(self.plans[op]), "dry_run": dry_run}

    def _apply(self, op, what, expected):
        if self.apply_error:
            raise self.apply_error
        answer = self._answer(op, False)
        if expected is not None and {k: answer[k] for k in locations.PLAN_KEYS} != expected:
            raise HTTPException(409, "The locations changed since the preview, so nothing was changed.")
        self.applied.append((op, what))
        return answer

    async def plan_move(self, db, body):
        self.calls.append(("plan_move", copy.deepcopy(body)))
        return self._answer("move", True)

    async def apply_move(self, db, body, expected=None):
        self.calls.append(("apply_move", copy.deepcopy(body)))
        return self._apply("move", copy.deepcopy(body), expected)

    async def plan_clear(self, db, server):
        self.calls.append(("plan_clear", server))
        return self._answer("clear", True)

    async def apply_clear(self, db, server, expected=None):
        self.calls.append(("apply_clear", server))
        return self._apply("clear", server, expected)


@pytest.fixture
def planner(monkeypatch):
    fake = FakePlanner()
    for name in ("plan_move", "apply_move", "plan_clear", "apply_clear"):
        monkeypatch.setattr(devices, name, getattr(fake, name), raising=False)
    return fake


@pytest.fixture
async def sessions():
    engine_ = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine_.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine_, expire_on_commit=False)
    async with factory() as db:
        db.add_all([Device(id="pdu-05", name="PDU-05", kind="pdu", ip="192.0.2.5", rack="Rack-01", port_count=8),
                    Device(id="kvm-2", name="KVM-2", kind="kvm", ip="192.0.2.6", rack="Rack-01", port_count=16),
                    Device(id="pdu-x1", name="PDU-X", kind="pdu", ip="192.0.2.7", rack="Rack-02", port_count=8),
                    Device(id="pdu-x2", name="PDU-X", kind="pdu", ip="192.0.2.8", rack="Rack-02", port_count=8)])
        await db.commit()
    yield factory
    await engine_.dispose()


def req(kind, **values):
    return ProposalRequest(kind=kind, **values)


# ---------------------------------------------------------------------------------------------------------------
# store.validate_request (per-kind fields) and the safe title (Codex ACT-R2 finding 2)
# ---------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("values", [
    {"kind": "server_swap", "server": "optn45", "target_server": "optn44"},
    {"kind": "server_move", "server": "optn45", "target_server": "optn44"},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": "7"}]},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": 7}],
     "target_rack": "Rack-02", "target_slot": 7},
    {"kind": "server_clear", "server": "optn12"},
])
def test_valid_location_requests(values):
    parsed = store.validate_request(values)
    assert parsed.kind == values["kind"]
    if parsed.target_ports:
        assert parsed.target_ports == [{"device": "PDU-05", "port": "7"}]


@pytest.mark.parametrize("values", [
    {"kind": "server_swap", "server": "optn45"},
    {"kind": "server_swap", "server": "optn45", "target_server": "  "},
    {"kind": "server_swap", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": "7"}]},
    {"kind": "server_swap", "server": "optn45", "target_server": "optn44", "target_slot": 3},
    {"kind": "server_move", "server": "optn45"},
    {"kind": "server_move", "server": "optn45", "target_server": "optn44",
     "target_ports": [{"device": "PDU-05", "port": "7"}]},
    {"kind": "server_move", "server": "optn45", "target_server": "optn44", "target_rack": "Rack-02"},
    {"kind": "server_move", "server": "optn45", "target_ports": []},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": str(n)} for n in range(1, 10)]},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": "0"}]},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": "7a"}]},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05"}]},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": "7", "x": 1}]},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU‮05", "port": "7"}]},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": "7"}], "target_slot": 0},
    {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": "7"}], "target_slot": True},
    {"kind": "server_clear", "server": "optn12", "target_server": "optn44"},
    {"kind": "server_clear", "server": "optn12", "pdu": "PDU-05"},
    {"kind": "server_clear"},
    {"kind": "server_off", "server": "optn12", "target_server": "optn44"},
    {"kind": "outlet_off", "pdu": "PDU-05", "outlet": 3, "target_ports": [{"device": "PDU-05", "port": "7"}]},
])
def test_invalid_location_requests_are_refused_before_planning(values):
    with pytest.raises(ActionError) as caught:
        store.validate_request(values)
    assert caught.value.status == 400 and caught.value.code == "invalid"


def test_titles_never_raise_for_any_kind_or_partial_request():
    assert store._title("server_swap", {"server": "optn45", "target_server": "optn44"}) == \
        "החלפת מיקום בין optn45 ל-optn44"
    assert store._title("server_swap", {"server": "optn45"}) == "החלפת מיקום בין optn45 ל-"
    for kind in KIND_SPECS:
        for request in ({}, {"server": None, "outlet": 3}, None, {"target_server": "x"}):
            assert isinstance(store._title(kind, request), str)
    assert store._title("no_such_kind", {}) == "no_such_kind"


# ---------------------------------------------------------------------------------------------------------------
# resolve.build_impact / check_drift for the location kinds (fake planner)
# ---------------------------------------------------------------------------------------------------------------
async def test_swap_preview_is_the_planner_dry_run_with_pins(sessions, planner):
    async with sessions() as db:
        impact = await resolve.build_impact(db, req("server_swap", server="optn45", target_server="optn44"),
                                            SimpleNamespace(power_protected_outlets=""), NOW)
    assert planner.calls == [("plan_move", {"server": "optn45", "target_server": "optn44", "swap": True})]
    data = impact.to_dict()
    assert data["changes"] == SWAP_PLAN["changes"] and data["positions"] == SWAP_PLAN["positions"]
    assert data["unplaced"] == [] and data["servers"] == ["OPTN45", "OPTN44"]
    assert data["targets"] == [] and data["pdus"] == [] and "pins" not in data
    assert impact.pins == {"plan": {k: SWAP_PLAN[k] for k in locations.PLAN_KEYS},
                           "body": {"server": "optn45", "target_server": "optn44", "swap": True}}


async def test_move_without_swap_warns_about_the_unplaced_server(sessions, planner):
    planner.plans["move"] = copy.deepcopy(MOVE_PLAN)
    async with sessions() as db:
        impact = await resolve.build_impact(db, req("server_move", server="server:optn45", target_server="optn44"),
                                            None, NOW)
    assert planner.calls[0][1] == {"server": "optn45", "target_server": "optn44", "swap": False}
    assert impact.unplaced == ["OPTN44"]
    assert "OPTN44 יישאר בלי מיקום: בלי שקעי PDU, בלי יציאות KVM ובלי מקום בארון." in impact.warnings_he


async def test_move_to_ports_resolves_device_names_and_never_swaps(sessions, planner):
    request = req("server_move", server="optn45", target_ports=[{"device": "PDU-05", "port": "7"},
                                                               {"device": "kvm-2", "port": "12"}],
                  target_rack="Rack-02", target_slot=7)
    async with sessions() as db:
        await resolve.build_impact(db, request, None, NOW)
    assert planner.calls[0][1] == {"server": "optn45", "swap": False, "target_rack": "Rack-02", "target_slot": 7,
                                   "target_ports": [{"device_id": "pdu-05", "port": "7"},
                                                    {"device_id": "kvm-2", "port": "12"}]}


@pytest.mark.parametrize("device,status,code", [("PDU-99", 404, "not_resolved"), ("PDU-X", 409, "ambiguous")])
async def test_unknown_or_ambiguous_port_device_is_refused_without_planning(sessions, planner, device, status, code):
    request = req("server_move", server="optn45", target_ports=[{"device": device, "port": "7"}])
    async with sessions() as db:
        with pytest.raises(ActionError) as caught:
            await resolve.build_impact(db, request, None, NOW)
    assert (caught.value.status, caught.value.code) == (status, code) and planner.calls == []


async def test_clear_uses_the_clear_planner_and_keeps_the_rack_position(sessions, planner):
    async with sessions() as db:
        impact = await resolve.build_impact(db, req("server_clear", server="optn12"), None, NOW)
    assert planner.calls == [("plan_clear", "optn12")]
    assert impact.changes == CLEAR_PLAN["changes"] and impact.servers == ["optn12"]
    assert any("המיקום בארון נשמר" in text for text in impact.warnings_he)


@pytest.mark.parametrize("status,detail,code", [
    (400, "The server and the target server are the same", "invalid"),
    (404, "Server not found on any PDU or KVM port", "not_resolved"),
    (409, "Port 7 on PDU-05 is used by OPTN44; choose it as target_server to swap", "invalid"),
    (503, "The rack layout file rack_slots.json cannot be read, so nothing was moved.", "invalid"),
])
async def test_planner_refusals_keep_their_status_and_message(sessions, planner, status, detail, code):
    planner.error = HTTPException(status, detail)
    async with sessions() as db:
        with pytest.raises(ActionError) as caught:
            await resolve.build_impact(db, req("server_swap", server="optn45", target_server="optn44"), None, NOW)
    assert (caught.value.status, caught.value.code, caught.value.message) == (status, code, detail)


async def test_nothing_to_change_is_no_targets(sessions, planner):
    planner.plans["move"] = {"ok": True, "dry_run": True, "changes": [], "unplaced": [],
                             "positions": [{"server": "optn45", "before": {"rack": "R", "slot": 1},
                                            "after": {"rack": "R", "slot": 1}}]}
    async with sessions() as db:
        with pytest.raises(ActionError) as caught:
            await resolve.build_impact(db, req("server_move", server="optn45",
                                               target_ports=[{"device": "PDU-05", "port": "1"}]), None, NOW)
    assert (caught.value.status, caught.value.code) == (409, "no_targets")


@pytest.mark.parametrize("state,details", [
    ("off", ["שקע 3 ב-PDU-05 כבר כבוי — אין מה לאתחל. כדי להדליק אותו בקש 'תדליק את שקע 3 ב-PDU-05'."]),
    ("unknown", []),   # not known to be off: no advice to power it on
])
async def test_outlet_cycle_with_nothing_on_is_no_targets_with_hebrew_advice(sessions, monkeypatch, state, details):
    """ACT-10 F2 (lead 2026-10-20): code stays no_targets; the Hebrew details say how to power it on instead."""
    status = SimpleNamespace(reachable=True, outlets=[SimpleNamespace(number=3, label="optn12", state=state)])

    async def live(dev):
        return status

    monkeypatch.setattr(resolve, "_live", live)
    async with sessions() as db:
        with pytest.raises(ActionError) as caught:
            await resolve.build_impact(db, req("outlet_cycle", pdu="PDU-05", outlet=3),
                                       SimpleNamespace(power_protected_outlets="none"), NOW)
    assert (caught.value.status, caught.value.code) == (409, "no_targets")
    assert caught.value.details == details


async def test_drift_is_any_difference_from_the_pinned_plan(sessions, planner):
    async with sessions() as db:
        impact = (await resolve.build_impact(db, req("server_swap", server="optn45", target_server="optn44"),
                                             None, NOW)).to_dict(with_pins=True)
        impact = json.loads(json.dumps(impact))   # exactly what the store keeps
        assert await resolve.check_drift(db, "server_swap", impact, None) == []
        planner.plans["move"]["changes"][0]["before"] = "optn46"
        assert await resolve.check_drift(db, "server_swap", impact, None) == ["המיקומים השתנו מאז ההצעה"]
        planner.plans["move"] = copy.deepcopy(SWAP_PLAN)
        planner.error = HTTPException(404, "Server not found on any PDU or KVM port")
        assert await resolve.check_drift(db, "server_swap", impact, None) == ["המיקומים השתנו מאז ההצעה"]
        assert await resolve.check_drift(db, "server_swap", {"pins": {}}, None) == [locations.MISSING_HE]


# ---------------------------------------------------------------------------------------------------------------
# HTTP flow: propose -> execute with {} (no password) -> applied; drift, roles, flag, CSRF
# ---------------------------------------------------------------------------------------------------------------
@pytest.fixture
async def app(sessions, planner, monkeypatch):
    settings = SimpleNamespace(
        accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
        accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=None,
        assistant_actions_enabled=True, power_protected_outlets="", assistant_action_ttl_seconds=300,
        assistant_action_cycle_off_seconds=5.0, assistant_action_restore_stagger_seconds=0.0)
    verified = []

    async def verify(*args, **kwargs):
        verified.append(args)
        raise AssertionError("a location change must never ask for a password")

    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(accounts, "verify_password", lambda password, encoded: secrets.compare_digest(
        hashlib.sha256(password.encode()).hexdigest(), encoded))
    monkeypatch.setattr(actions, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(actions, "get_settings", lambda: settings)
    monkeypatch.setattr(actions, "_background_lock", asyncio.Lock())
    monkeypatch.setattr(store, "_proposal_lock", asyncio.Lock())
    monkeypatch.setattr(confirm, "verify", verify)
    monkeypatch.setattr(runner, "start_background", lambda *a, **k: (_ for _ in ()).throw(AssertionError("inline")))
    async with sessions() as db:
        for username, role in (("viewer", "Viewer"), ("operator", "Operator"), ("other", "Operator")):
            db.add(User(id=username, username=username, name=username, role=role, password_hash=PASSWORD_HASH,
                        created_at=time.time()))
        await db.commit()
    application = FastAPI()
    application.add_middleware(accounts.AccountAccess)
    application.include_router(accounts.router)
    application.include_router(actions.router)

    async def database():
        async with sessions() as db:
            yield db

    application.dependency_overrides[get_db] = database
    application.state.sessions, application.state.settings = sessions, settings
    application.state.planner, application.state.verified = planner, verified
    return application


@asynccontextmanager
async def signed_in(application, username="operator"):
    async with AsyncClient(transport=ASGITransport(app=application), base_url="http://test") as client:
        response = await client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert response.status_code == 200, response.text
        client.headers["X-DCIM-CSRF"] = response.json()["csrf_token"]
        yield client


SWAP = {"kind": "server_swap", "server": "optn45", "target_server": "optn44", "reason": "העברתי את optn45"}


async def propose(client, body=SWAP):
    response = await client.post(PROPOSALS, json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def events_of(application, proposal_id):
    async with application.state.sessions() as db:
        rows = (await db.scalars(select(AssistantActionEvent).where(AssistantActionEvent.proposal_id == proposal_id)
                                 .order_by(AssistantActionEvent.id))).all()
        return [row.event for row in rows]


async def test_swap_is_proposed_then_applied_with_an_empty_body_and_no_password(app):
    async with signed_in(app) as client:
        proposal = await propose(client)
        assert proposal["needs_password"] is False and proposal["phrase"] is None and proposal["can_execute"] is True
        assert proposal["title_he"] == "החלפת מיקום בין optn45 ל-optn44"
        assert proposal["impact"]["changes"] == SWAP_PLAN["changes"] and "pins" not in json.dumps(proposal)
        assert proposal["progress"] == {"done": 0, "total": 3}
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert response.status_code == 200, response.text
        done = response.json()
    assert done["status"] == "succeeded"
    assert done["result"]["changes"] == SWAP_PLAN["changes"] and done["result"]["positions"] == SWAP_PLAN["positions"]
    assert done["result"]["summary_he"].startswith("השינוי נשמר: 3 שינויי תוויות ו-2 שינויי מיקום בארון.")
    assert app.state.planner.applied == [("move", {"server": "optn45", "target_server": "optn44", "swap": True})]
    assert app.state.verified == []
    assert await events_of(app, proposal["id"]) == ["proposed", "confirmed", "executing", "finished"]


@pytest.mark.parametrize("body", [b"", b"{}", b'{"password": "ignored", "phrase": "ignored"}'])
async def test_clear_executes_with_empty_or_ignored_confirmation_fields(app, body):
    async with signed_in(app) as client:
        proposal = await propose(client, {"kind": "server_clear", "server": "optn12"})
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", content=body,
                                     headers={"content-type": "application/json"})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "succeeded"
    assert app.state.planner.applied == [("clear", "optn12")] and app.state.verified == []


async def test_execute_body_allowlist_and_json_still_apply(app):
    async with signed_in(app) as client:
        proposal = await propose(client)
        for content in (b'{"target_server": "optn99"}', b"[]", b"not json"):
            response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", content=content,
                                         headers={"content-type": "application/json"})
            assert response.status_code == 400 and response.json()["code"] == "invalid", content
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", content=b"{}",
                                     headers={"content-type": "text/plain"})
        assert response.status_code == 415
    assert app.state.planner.applied == []


async def test_drift_refuses_and_writes_nothing(app):
    async with signed_in(app) as client:
        proposal = await propose(client)
        app.state.planner.plans["move"]["changes"][2]["before"] = "optn46"   # someone edited a port meanwhile
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert response.status_code == 409
        assert response.json() == {"detail": "The situation changed; review the action again", "code": "drift",
                                   "details": ["המיקומים השתנו מאז ההצעה"]}
        current = (await client.get(f"{PROPOSALS}/{proposal['id']}")).json()
        assert current["status"] == "refused"
        again = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert again.status_code == 409 and again.json()["code"] == "not_pending"
    assert app.state.planner.applied == []


async def test_a_change_between_the_drift_check_and_the_write_is_refused_by_the_planner(app):
    async with signed_in(app) as client:
        proposal = await propose(client)
        app.state.planner.apply_error = HTTPException(409, "The locations changed since the preview, so nothing "
                                                           "was changed.")
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert response.status_code == 200
        body = response.json()
    assert body["status"] == "refused" and body["result"]["changes"] == []
    assert body["result"]["summary_he"].startswith("המיקומים השתנו מאז ההצעה")
    assert await events_of(app, proposal["id"]) == ["proposed", "confirmed", "executing", "refused", "finished"]


async def test_viewer_other_users_flag_off_and_missing_csrf_are_refused(app):
    async with signed_in(app) as client:
        proposal = await propose(client)
    async with signed_in(app, "viewer") as viewer:
        assert (await viewer.post(PROPOSALS, json=SWAP)).status_code == 403
        assert (await viewer.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})).status_code == 403
    async with signed_in(app, "other") as other:
        response = await other.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert response.status_code == 404 and response.json()["code"] == "not_found"
    async with signed_in(app) as client:
        del client.headers["X-DCIM-CSRF"]
        assert (await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})).status_code == 403
        client.headers["X-DCIM-CSRF"] = "wrong"
        assert (await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})).status_code == 403
    app.state.settings.assistant_actions_enabled = False
    async with signed_in(app) as client:
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert response.status_code == 403 and response.json()["code"] == "disabled"
    assert app.state.planner.applied == [] and app.state.verified == []


async def test_shared_password_mode_never_proposes_a_location_change(sessions, planner):
    shared = SimpleNamespace(accounts_enabled=False, lab_manager_password="x", assistant_actions_enabled=True)
    with pytest.raises(ActionError) as caught:
        await store.propose(sessions, Principal(None, "shared", "Admin", True), SWAP, shared, NOW)
    assert (caught.value.status, caught.value.code) == (403, "password_mode") and planner.calls == []


async def test_history_lists_location_proposals_with_titles(app):
    async with signed_in(app) as client:
        await propose(client)
        await propose(client, {"kind": "server_clear", "server": "optn12"})
        async with app.state.sessions() as db:   # an old row written before the location fields existed
            row = AssistantActionProposal(
                id="f" * 32, created_at=time.time(), expires_at=time.time() + 60, owner_key="operator",
                created_by="operator", kind="server_swap", request_json='{"kind": "server_swap", "server": "a"}',
                impact_json="{}", status="cancelled", progress_done=0, progress_total=0, result_json="",
                batch_down_json="[]")
            db.add(row)
            await db.commit()
        response = await client.get(PROPOSALS)
        assert response.status_code == 200, response.text
        titles = [item["title_he"] for item in response.json()["items"]]
    assert "החלפת מיקום בין optn45 ל-optn44" in titles and "ניקוי השיוך של optn12 (PDU ו-KVM)" in titles
    assert "החלפת מיקום בין a ל-" in titles


async def test_execute_never_replays_a_finished_location_change(sessions, planner):
    result = await locations.execute("0" * 32, "operator", session_factory=sessions)
    assert result["changes"] == [] and planner.applied == []


# ---------------------------------------------------------------------------------------------------------------
# Model tool: intent anchor for the location kinds and the PDU scope rule (Codex ACT-R2 finding 1)
# ---------------------------------------------------------------------------------------------------------------
class FakeStore:
    def __init__(self, servers=("OPTN45", "OPTN44")):
        self.calls, self.cancelled, self.servers = [], [], list(servers)

    async def propose(self, session_factory, principal, request, settings, now, conversation_id=None):
        self.calls.append(request)
        return {"id": "a" * 32, "kind": request.kind, "status": "pending", "title_he": "t",
                "needs_password": KIND_SPECS[request.kind].needs_password, "request": request.to_dict(),
                "impact": {"servers": self.servers, "changes": SWAP_PLAN["changes"],
                           "positions": SWAP_PLAN["positions"], "unplaced": [], "counts": {"servers": 2}}}

    async def cancel(self, db, principal, proposal_id, now):
        self.cancelled.append(proposal_id)


@pytest.fixture
def fake_store(monkeypatch):
    fake = FakeStore()
    monkeypatch.setattr(tools, "store", fake)
    return fake


class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def ctx_for(message, page_context=None):
    return ToolContext(principal=OPERATOR, session_factory=_Session,
                       settings=SimpleNamespace(assistant_actions_enabled=True, accounts_enabled=True), now=NOW,
                       user_message=message, page_context=page_context or {})


async def run_tool(ctx, **args):
    spec = tools.TOOLS[0]
    return await engine.run_tool(spec, spec.name, args, ctx)


async def test_swap_needs_both_servers_in_the_message(fake_store):
    outcome = await run_tool(ctx_for("תחליף בין optn45 ל-optn44"), kind="server_swap", server="optn45",
                             target_server="optn44")
    assert isinstance(outcome, ToolResult), outcome
    assert outcome.data["next_step"] == tools.DATA_NEXT_STEP and "no password" in tools.DATA_NEXT_STEP
    view = outcome.data["proposal"]["impact"]
    assert view["counts"]["changes"] == 3 and view["counts"]["positions"] == 2
    assert view["changes"][0] == {"device_name": "PDU-05", "kind": "pdu", "port": "1", "before": "OPTN44",
                                  "after": "optn45"}
    assert "device_id" not in json.dumps(view)
    for message, missing in (("תחליף את optn45", "target server is not named"),
                             ("תחליף בין optn4 ל-optn44", "the server is not named"),
                             ("תחליף בין optn45 ל-optn444", "target server is not named")):
        outcome = await run_tool(ctx_for(message), kind="server_swap", server="optn45", target_server="optn44")
        assert missing in outcome, (message, outcome)
    assert len(fake_store.calls) == 1


async def test_the_viewed_page_never_anchors_a_location_change(fake_store):
    page = {"detail": {"kind": "server", "id": "optn12"}}
    outcome = await run_tool(ctx_for("תנקה אותו", page), kind="server_clear", server="optn12")
    assert "not_requested" in outcome and fake_store.calls == []


async def test_target_ports_devices_numbers_rack_and_slot_must_be_written(fake_store):
    fake_store.servers = ["OPTN45"]
    ports = [{"device": "PDU-05", "port": "7"}, {"device": "KVM-2", "port": "12"}]
    message = "optn45 עבר לשקע 7 ב-PDU-05 ויציאה 12 ב-KVM-2"
    assert isinstance(await run_tool(ctx_for(message), kind="server_move", server="optn45", target_ports=ports),
                      ToolResult)
    cases = (([{"device": "PDU-06", "port": "7"}], {}, "PDU or KVM is not named"),
             ([{"device": "PDU-05", "port": "8"}], {}, "outlet or port number is not written"),
             (ports, {"target_rack": "Rack-02"}, "target rack is not named"),
             (ports, {"target_slot": 9}, "target slot number is not written"))
    for target_ports, extra, missing in cases:
        outcome = await run_tool(ctx_for(message), kind="server_move", server="optn45", target_ports=target_ports,
                                 **extra)
        assert missing in outcome, (target_ports, extra, outcome)
    outcome = await run_tool(ctx_for(message + " לארון Rack-02 ביחידה 9"), kind="server_move", server="optn45",
                             target_ports=ports, target_rack="Rack-02", target_slot=9)
    assert isinstance(outcome, ToolResult), outcome
    assert len(fake_store.calls) == 2


async def test_a_wider_resolution_is_withdrawn_and_one_proposal_per_question(fake_store):
    fake_store.servers = ["OPTN45", "OPTN44", "OPTN46"]
    ctx = ctx_for("תחליף בין optn45 ל-optn44")
    outcome = await run_tool(ctx, kind="server_swap", server="optn45", target_server="optn44")
    assert "more servers than the user named" in outcome and fake_store.cancelled == ["a" * 32]
    fake_store.servers = ["OPTN45", "OPTN44"]
    assert isinstance(await run_tool(ctx, kind="server_swap", server="optn45", target_server="optn44"), ToolResult)
    outcome = await run_tool(ctx, kind="server_clear", server="optn45")
    assert "Only one action proposal" in outcome


@pytest.mark.parametrize("message,args,allowed", [
    ("turn off outlet 3 on PDU1", {"kind": "pdu_shutdown", "pdu": "PDU1"}, False),   # Codex ACT-R2 repro
    ("turn off outlet 3 on PDU1", {"kind": "outlet_off", "pdu": "PDU1", "outlet": 3}, True),
    ("כבה את שקע 3 ב-PDU1", {"kind": "pdu_shutdown", "pdu": "PDU1"}, False),
    ("תכניס את שקע 3 ב-PDU1 לתחזוקה", {"kind": "pdu_shutdown", "pdu": "PDU1"}, False),
    ("כבה את PDU1", {"kind": "pdu_shutdown", "pdu": "PDU1"}, False),
    ("restore PDU1", {"kind": "pdu_restore", "pdu": "PDU1"}, False),
    ("put PDU1 into maintenance", {"kind": "pdu_shutdown", "pdu": "PDU1"}, True),
    ("תכניס את PDU1 לתחזוקה", {"kind": "pdu_shutdown", "pdu": "PDU1"}, True),
    ("תוציא את PDU1 מתחזוקה", {"kind": "pdu_restore", "pdu": "PDU1"}, True),
    ("כבה את כל ה-PDU PDU1", {"kind": "pdu_shutdown", "pdu": "PDU1"}, True),
    ("power off the whole PDU PDU1", {"kind": "pdu_shutdown", "pdu": "PDU1"}, True),
])
async def test_pdu_actions_match_the_scope_the_user_wrote(fake_store, message, args, allowed):
    outcome = await run_tool(ctx_for(message), **args)
    if allowed:
        assert isinstance(outcome, ToolResult), outcome
    else:
        assert isinstance(outcome, str) and "not_requested" in outcome
        assert fake_store.calls == []


def test_schema_offers_the_location_fields_strictly():
    schema = tools.INPUT_SCHEMA
    assert {"target_server", "target_ports", "target_rack", "target_slot"} <= set(schema["properties"])
    ok = {"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-05", "port": "7"}]}
    assert engine.validate(schema, ok) == []
    for bad in ({**ok, "target_ports": [{"device": "PDU-05"}]}, {**ok, "target_ports": [{"device": "P", "port": 7}]},
                {**ok, "target_ports": [{"device": "P", "port": "7", "x": "1"}]}, {**ok, "target_slot": 0}):
        assert engine.validate(schema, bad), bad
    (definition,) = engine.tool_definitions([tools.TOOLS[0]])
    items = definition["input_schema"]["properties"]["target_ports"]["items"]
    assert items["additionalProperties"] is False and items["required"] == ["device", "port"]


# ---------------------------------------------------------------------------------------------------------------
# Demo responder: conservative Hebrew/English location commands
# ---------------------------------------------------------------------------------------------------------------
@pytest.fixture
def location_demo():
    calls = []
    proposal = {"id": "demo-proposal", "status": "pending", "needs_password": False,
                "impact": {"counts": {"changes": 3, "positions": 2}, "unplaced": []}}
    ctx = ToolContext(Principal("op", "operator", "Operator"), None,
                      SimpleNamespace(ping_monitor_timezone="UTC", accounts_enabled=True,
                                      assistant_actions_enabled=True), now=NOW)

    async def propose_action(ctx, **request):
        calls.append(request)
        ctx.proposals.append(proposal["id"])
        return ToolResult({"proposal": copy.deepcopy(proposal)}, [Source("assistant_action:demo-proposal", "Proposal")])

    tool = ToolSpec("propose_action", "Prepare a proposal only.", tools.INPUT_SCHEMA, "Operator", propose_action)

    async def ask(question):
        return await demo.answer(question=question, history=[], context=None, ctx=ctx, tools=[tool],
                                 reason="no_api_key")

    return SimpleNamespace(ask=ask, calls=calls, ctx=ctx, proposal=proposal)


@pytest.mark.parametrize("question,expected", [
    ("העברתי את optn45 למקום של optn44", {"kind": "server_swap", "server": "optn45", "target_server": "optn44"}),
    ("העבר את optn45 למקום של optn44", {"kind": "server_swap", "server": "optn45", "target_server": "optn44"}),
    ("העבר את optn45 למקום של optn44 בלי החלפה",
     {"kind": "server_move", "server": "optn45", "target_server": "optn44"}),
    ("optn45 עבר למקום של optn44, ללא החלפה", {"kind": "server_move", "server": "optn45", "target_server": "optn44"}),
    ("תחליף בין optn3 ל-optn8", {"kind": "server_swap", "server": "optn3", "target_server": "optn8"}),
    ("בבקשה תחליף בין השרת optn3 לשרת optn8.", {"kind": "server_swap", "server": "optn3", "target_server": "optn8"}),
    ("תחליף בין opt 3 ל-opt 8", {"kind": "server_swap", "server": "opt3", "target_server": "opt8"}),
    ("swap optn3 and optn8", {"kind": "server_swap", "server": "optn3", "target_server": "optn8"}),
    ("move optn45 to optn44's place", {"kind": "server_swap", "server": "optn45", "target_server": "optn44"}),
    ("move optn45 to the place of optn44 without swapping",
     {"kind": "server_move", "server": "optn45", "target_server": "optn44"}),
    ("optn45 עבר לשקע 7 ב-PDU-05 ויציאה 12 ב-KVM-2",
     {"kind": "server_move", "server": "optn45",
      "target_ports": [{"device": "PDU-05", "port": "7"}, {"device": "KVM-2", "port": "12"}]}),
    ("move optn45 to outlet 7 on PDU-05 and port 12 on KVM-2",
     {"kind": "server_move", "server": "optn45",
      "target_ports": [{"device": "PDU-05", "port": "7"}, {"device": "KVM-2", "port": "12"}]}),
    ("תנקה את optn12", {"kind": "server_clear", "server": "optn12"}),
    ("clear the location of optn12", {"kind": "server_clear", "server": "optn12"}),
])
async def test_location_commands_propose_exactly_what_was_written(location_demo, question, expected):
    result = await location_demo.ask(question)
    assert location_demo.calls == [expected]
    summary = result["answer"]["summary"]
    assert summary.startswith(demo.DEMO_PREFIX) and "הוכנה הצעה לשינוי מיקום" in summary
    assert "לא נדרשת סיסמה" in summary and "3 שינויי תוויות" in summary
    assert not any(claim in summary for claim in ("בוצע", "הושלם", "השינוי נשמר"))


@pytest.mark.parametrize("question", [
    "תחליף בין optn3 ל-optn8?", "תחליף בין optn3 ל-optn8 אם אפשר", "תחליף בין optn3 ל-optn8 ו-optn9",
    "תנקה את optn12 ואת optn13", "העבר את optn45 למקום של optn44 לא", "תחליף בין optn3 ל-optn3",
    "optn45 עבר לשקע 7 ב-PDU-05 ויציאה 12 ב-KVM-2 ול-U7", "swap optn3", "clear", "move optn45 somewhere",
    "optn45 עבר למקום של optn44?", "swap optn3 and optn8 unless busy",
])
async def test_unclear_location_commands_ask_without_proposing(location_demo, question):
    result = await location_demo.ask(question)
    assert location_demo.calls == [] and location_demo.ctx.proposals == []
    summary = result["answer"]["summary"]
    assert "?" in summary and "תחליף בין optn3 ל-optn8" in summary and "הוכנה הצע" not in summary


@pytest.mark.parametrize("question", [
    "אל תחליף בין optn3 ל-optn8", "don't swap optn3 and optn8", "למה optn45 עבר למקום של optn44?",
    "האם להעביר את optn45 למקום של optn44?", "what if I swap optn3 and optn8",
])
async def test_negations_and_questions_never_propose(location_demo, question):
    result = await location_demo.ask(question)
    assert location_demo.calls == [] and "הוכנה הצע" not in result["answer"]["summary"]


async def test_demo_warns_about_a_server_left_without_location(location_demo):
    location_demo.proposal["impact"]["unplaced"] = ["OPTN44"]
    result = await location_demo.ask("העבר את optn45 למקום של optn44 בלי החלפה")
    assert "OPTN44 יישאר בלי מיקום" in result["answer"]["summary"]


# ---------------------------------------------------------------------------------------------------------------
# Real planner (routers/devices.py after the v2.39.2 merge): the assistant changes exactly what Locations would
# ---------------------------------------------------------------------------------------------------------------
LAYOUT = {
    "rack_slots.json": {"Rack-01": {"optn44": 3, "optn45 (psu1)": 7}, "Rack-02": {"optn44 (psu2)": 3}},
    "rack_positions.json": {"Rack-01": ["optn45 (psu1)", "optn44", "web-1"]},
    "rack_overrides.json": {"optn45 (psu1)": "Rack-01", "other": "Rack-09"},
    "switch_assignments.json": {"optn44": {"switch": "SW1", "port": "12"},
                                "optn45 (psu1)": {"switch": "SW2", "port": "3"}},
}
LABELS = {
    "pdu-a": {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "web-1"},
    "pdu-b": {"1": "optn44 (PSU2)", "2": "OPTN45 (PSU2)", "5": "Outlet 5"},
    "kvm-a": {"1": "optn44", "2": "OPTN45"},
}


@pytest.fixture
async def lab(tmp_path, monkeypatch):
    engine_ = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine_.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine_, expire_on_commit=False)
    async with factory() as db:
        db.add_all([
            Device(id="pdu-a", name="PDU-A", kind="pdu", ip="192.0.2.11", rack="Rack-01", port_count=8,
                   labels_json=json.dumps(LABELS["pdu-a"])),
            Device(id="pdu-b", name="PDU-B", kind="pdu", ip="192.0.2.12", rack="Rack-02", port_count=8,
                   labels_json=json.dumps(LABELS["pdu-b"])),
            Device(id="kvm-a", name="KVM-A", kind="kvm", ip="192.0.2.13", rack="Rack-01", port_count=4,
                   labels_json=json.dumps(LABELS["kvm-a"]))])
        for username, role in (("operator", "Operator"), ("admin", "Admin")):
            db.add(User(id=username, username=username, name=username, role=role, password_hash=PASSWORD_HASH,
                        created_at=time.time()))
        await db.commit()
    for name, data in LAYOUT.items():
        (tmp_path / name).write_text(json.dumps(data))
    settings = SimpleNamespace(
        accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
        accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=None,
        assistant_actions_enabled=True, power_protected_outlets="", assistant_action_ttl_seconds=300)
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    monkeypatch.setattr(accounts, "AsyncSessionLocal", factory)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(accounts, "verify_password", lambda password, encoded: secrets.compare_digest(
        hashlib.sha256(password.encode()).hexdigest(), encoded))
    monkeypatch.setattr(actions, "AsyncSessionLocal", factory)
    monkeypatch.setattr(actions, "get_settings", lambda: settings)
    monkeypatch.setattr(store, "_proposal_lock", asyncio.Lock())
    application = FastAPI()
    application.add_middleware(accounts.AccountAccess)
    application.include_router(accounts.router)
    application.include_router(actions.router)
    application.include_router(devices.router)

    async def database():
        async with factory() as db:
            yield db

    application.dependency_overrides[get_db] = database
    yield SimpleNamespace(app=application, sessions=factory, folder=tmp_path)
    await engine_.dispose()


async def lab_state(lab):
    async with lab.sessions() as db:
        rows = (await db.scalars(select(Device).execution_options(populate_existing=True))).all()
        labels = {row.id: json.loads(row.labels_json) for row in rows}
    files = {p.name: p.read_bytes() for p in sorted(lab.folder.iterdir()) if p.suffix == ".json"}
    return labels, files


async def restore_state(lab, state):
    labels, files = state
    async with lab.sessions() as db:
        for row in (await db.scalars(select(Device))).all():
            row.labels_json = json.dumps(labels[row.id])
        await db.commit()
    for p in list(lab.folder.iterdir()):
        if p.suffix == ".json" and p.name not in files:
            p.unlink()
    for name, data in files.items():
        (lab.folder / name).write_bytes(data)


needs_planner = pytest.mark.skipif(not REAL_PLANNER, reason="routers/devices.py planner functions not merged yet")


@needs_planner
@pytest.mark.parametrize("request_body,endpoint_body", [
    ({"kind": "server_swap", "server": "optn45", "target_server": "optn44"},
     {"server": "optn45", "target_server": "optn44", "swap": True}),
    ({"kind": "server_move", "server": "optn45", "target_server": "optn44"},
     {"server": "optn45", "target_server": "optn44", "swap": False}),
    ({"kind": "server_move", "server": "optn45", "target_ports": [{"device": "PDU-B", "port": "6"},
                                                                  {"device": "KVM-A", "port": "4"}]},
     {"server": "optn45", "target_ports": [{"device_id": "pdu-b", "port": "6"}, {"device_id": "kvm-a", "port": "4"}],
      "swap": False}),
])
async def test_real_planner_moves_match_the_locations_endpoint_exactly(lab, request_body, endpoint_body):
    initial = await lab_state(lab)
    async with signed_in(lab.app, "admin") as admin:
        dry = await admin.post("/api/devices/move-server", json={**endpoint_body, "dry_run": True})
        assert dry.status_code == 200, dry.text
        applied = await admin.post("/api/devices/move-server", json=endpoint_body)
        assert applied.status_code == 200, applied.text
    by_endpoint = await lab_state(lab)
    await restore_state(lab, initial)
    async with signed_in(lab.app) as client:
        proposal = await propose(client, request_body)
        assert {k: proposal["impact"][k] for k in locations.PLAN_KEYS} == \
            {k: dry.json()[k] for k in locations.PLAN_KEYS}
        assert await lab_state(lab) == initial   # the preview wrote nothing
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "succeeded"
    assert await lab_state(lab) == by_endpoint


@needs_planner
async def test_real_planner_clear_matches_locations_clear_and_keeps_the_rack(lab):
    initial = await lab_state(lab)
    async with signed_in(lab.app, "admin") as admin:
        for device_id, port in (("pdu-a", "1"), ("pdu-b", "1"), ("kvm-a", "1")):
            response = await admin.patch("/api/devices/direct-label",
                                         json={"device_id": device_id, "port": port, "label": ""})
            assert response.status_code == 200, response.text
    by_locations = await lab_state(lab)
    await restore_state(lab, initial)
    async with signed_in(lab.app) as client:
        proposal = await propose(client, {"kind": "server_clear", "server": "optn44"})
        assert [(c["device_id"], c["port"], c["after"]) for c in proposal["impact"]["changes"]] == [
            ("pdu-a", "1", "Outlet 1"), ("pdu-b", "1", "Outlet 1"), ("kvm-a", "1", "Port 1")]
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert response.status_code == 200 and response.json()["status"] == "succeeded", response.text
    assert await lab_state(lab) == by_locations
    assert (await lab_state(lab))[1] == initial[1]


@needs_planner
async def test_real_planner_drift_refuses_after_a_label_edit(lab):
    async with signed_in(lab.app) as client:
        proposal = await propose(client, {"kind": "server_swap", "server": "optn45", "target_server": "optn44"})
    async with signed_in(lab.app, "admin") as admin:
        response = await admin.patch("/api/devices/direct-label",
                                     json={"device_id": "kvm-a", "port": "3", "label": "optn44 (spare)"})
        assert response.status_code == 200, response.text
    before = await lab_state(lab)
    async with signed_in(lab.app) as client:
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={})
        assert response.status_code == 409 and response.json()["code"] == "drift", response.text
    assert await lab_state(lab) == before
