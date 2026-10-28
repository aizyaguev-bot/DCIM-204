"""Assistant action API and persistence, using in-memory data and no hardware calls."""
import asyncio
import hashlib
import json
import secrets
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import AsyncAdaptedQueuePool

from app import accounts, confirm
from app.assistant.actions import router as actions, store
from app.assistant.actions.contracts import (ActionError, Console, Impact, ProposalRequest, Target)
from app.assistant.actions.models import AssistantActionEvent, AssistantActionProposal
from app.assistant.contracts import Principal
from app.database import Base, get_db
from app.models import AuthThrottle, User

ROOT = "/api/assistant/actions"
PROPOSALS = ROOT + "/proposals"
ACCOUNT_PASSWORD = "synthetic-account-secret-a51d"
SHARED_PASSWORD = "synthetic-shared-secret-f36a"
WRONG_PASSWORD = "synthetic-wrong-password-b92a"
WRONG_PHRASE = "synthetic-wrong-phrase-c17b"
PRIVATE_REASON = "synthetic-private-reason-d41c"
PASSWORD_HASH = hashlib.sha256(ACCOUNT_PASSWORD.encode()).hexdigest()


def principal(username="operator", role="Operator"):
    return Principal(user_id=username, username=username, role=role)


def impact():
    return Impact(
        targets=[Target("pdu-a", "PDU A", "R1", 1, "NODE1 PSU1", "NODE1", "on")],
        pdus=["pdu-a"], servers=["NODE1"],
        consoles=[Console("kvm-a", "KVM A", 1, "NODE1", "/api/kvms/kvm-a/autologin?port=1")],
        pins={"pdu-a": {"labels_rev": "private-revision", "ip": "pdu.example.invalid",
                         "enabled": True, "maintenance": False, "on": [1], "known": [1]}},
    )


@pytest.fixture
async def accounts_app(monkeypatch):
    # Keep the entire test database in memory: no production DB or worktree DB file is opened.
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(
        accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
        accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=SHARED_PASSWORD,
        assistant_actions_enabled=True, power_protected_outlets="none", assistant_action_ttl_seconds=300,
        assistant_action_cycle_off_seconds=5.0, assistant_action_restore_stagger_seconds=0.0,
    )
    calls = SimpleNamespace(build=[], drift=[], execute=[], background=[], drift_reasons=[])

    async def build_impact(db, req, settings, now):
        calls.build.append(req.to_dict())
        return impact()

    async def check_drift(db, kind, value, settings):
        calls.drift.append((kind, value))
        return list(calls.drift_reasons)

    async def execute(proposal_id, by, *, session_factory, settings, **kwargs):
        async with session_factory() as db:
            row = await db.get(AssistantActionProposal, proposal_id)
            calls.execute.append((proposal_id, by, json.loads(row.request_json)))
            await store.finish(db, proposal_id, "succeeded", {
                "targets": [{"pdu_id": "pdu-a", "outlet": 1, "ok": True, "state_after": "off", "error": ""}],
                "pdus": [], "consoles": [], "summary_he": "Done",
            })
            row = await db.get(AssistantActionProposal, proposal_id, populate_existing=True)
            return store.to_public(row, principal(row.created_by, "Admin"))

    def start_background(proposal_id, by, *, session_factory, settings):
        calls.background.append((proposal_id, by))

    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    # Scrypt itself is covered by account tests. Keep the real session/password-confirmation flow fast here.
    monkeypatch.setattr(accounts, "verify_password", lambda password, encoded: secrets.compare_digest(
        hashlib.sha256(password.encode()).hexdigest(), encoded))
    monkeypatch.setattr(actions, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(actions, "get_settings", lambda: settings)
    monkeypatch.setattr(actions.resolve, "build_impact", build_impact)
    monkeypatch.setattr(actions.resolve, "check_drift", check_drift)
    monkeypatch.setattr(actions.runner, "execute", execute)
    monkeypatch.setattr(actions.runner, "start_background", start_background)
    monkeypatch.setattr(actions, "_background_lock", asyncio.Lock())
    monkeypatch.setattr(store, "_proposal_lock", asyncio.Lock())
    monkeypatch.setattr(confirm, "confirm_lock", asyncio.Lock())

    async with sessions() as db:
        for username, role in (("viewer", "Viewer"), ("operator", "Operator"),
                               ("other", "Operator"), ("admin", "Admin"), ("admin2", "Admin")):
            db.add(User(id=username, username=username, name=username, role=role,
                        password_hash=PASSWORD_HASH, created_at=time.time()))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(actions.router)

    async def database():
        async with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = database
    app.state.sessions = sessions
    app.state.settings = settings
    app.state.calls = calls
    yield app
    await engine.dispose()


@asynccontextmanager
async def signed_in(app, username="operator"):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/auth/login", json={"username": username, "password": ACCOUNT_PASSWORD})
        assert response.status_code == 200, response.text
        client.headers["X-DCIM-CSRF"] = response.json()["csrf_token"]
        yield client


async def propose(client, kind="outlet_off", **values):
    body = {"kind": kind, "reason": PRIVATE_REASON}
    if kind.startswith("outlet_"):
        body.update(pdu="pdu-a", outlet=1)
    elif kind.startswith("server_") or kind == "open_console":
        body["server"] = "NODE1"
    elif kind.startswith("pdu_"):
        body["pdu"] = "pdu-a"
    elif kind == "rack_shutdown":
        body["rack"] = "R1"
    body.update(values)
    response = await client.post(PROPOSALS, json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def seed(app, username="operator", role="Operator", kind="outlet_off", **values):
    who = principal(username, role) if app.state.settings.accounts_enabled else Principal(None, "shared", "Admin", True)
    body = {"kind": kind, "pdu": "pdu-a", "outlet": 1, "rack": "R1", "reason": PRIVATE_REASON, **values}
    req = ProposalRequest(**body)
    async with app.state.sessions() as db:
        row = await store.create(db, who, req, impact(), app.state.settings, time.time())
        return store.to_public(row, who)


async def execute(client, proposal, password=ACCOUNT_PASSWORD, **values):
    return await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={"password": password, **values})


async def events(app, proposal_id=None):
    async with app.state.sessions() as db:
        query = select(AssistantActionEvent).order_by(AssistantActionEvent.id)
        if proposal_id is not None:
            query = query.where(AssistantActionEvent.proposal_id == proposal_id)
        return (await db.scalars(query)).all()


async def attempts(app, username="admin"):
    digest = hashlib.sha256(("maint:user:" + username).encode()).hexdigest()
    async with app.state.sessions() as db:
        row = await db.get(AuthThrottle, digest)
        return row.attempts if row else 0


def error(response, status, code):
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"detail", "code", "details"}
    assert body["code"] == code
    assert isinstance(body["detail"], str) and isinstance(body["details"], list)


def no_private(data):
    text = data if isinstance(data, str) else json.dumps(data)
    for value in (ACCOUNT_PASSWORD, SHARED_PASSWORD, WRONG_PASSWORD, WRONG_PHRASE, PRIVATE_REASON,
                  "private-revision", "pdu.example.invalid", '"owner_key"', '"pins"'):
        assert value not in text


async def test_config_reports_viewer_operator_and_admin_capabilities(accounts_app):
    for username, can_propose, can_admin in (("viewer", False, False), ("operator", True, False), ("admin", True, True)):
        async with signed_in(accounts_app, username) as client:
            response = await client.get(ROOT + "/config")
            assert response.status_code == 200
            assert response.json() == {"enabled": True, "password_mode": "account", "protected_configured": True,
                                       "can_propose": can_propose, "can_admin": can_admin}
            no_private(response.text)
    accounts_app.state.settings.power_protected_outlets = ""
    async with signed_in(accounts_app) as client:
        assert (await client.get(ROOT + "/config")).json()["protected_configured"] is False


async def test_disabled_flag_blocks_all_action_endpoints_except_config(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        accounts_app.state.settings.assistant_actions_enabled = False
        urls = [PROPOSALS, f"{PROPOSALS}/{proposal['id']}"]
        responses = [await client.get(url) for url in urls]
        responses.extend([
            await client.post(PROPOSALS, json={"kind": "outlet_off", "pdu": "pdu-a", "outlet": 1}),
            await execute(client, proposal), await client.post(f"{PROPOSALS}/{proposal['id']}/cancel", json={}),
        ])
        for response in responses:
            error(response, 403, "disabled")
        config = await client.get(ROOT + "/config")
        assert config.status_code == 200 and config.json()["enabled"] is False
    assert len(accounts_app.state.calls.build) == 1
    assert not accounts_app.state.calls.execute and not accounts_app.state.calls.background


async def test_viewer_cannot_read_proposals_or_mutate_actions(accounts_app):
    proposal = await seed(accounts_app, "viewer", "Viewer")
    async with signed_in(accounts_app, "viewer") as client:
        responses = [await client.get(PROPOSALS), await client.get(f"{PROPOSALS}/{proposal['id']}"),
                     await client.post(PROPOSALS, json={"kind": "lab_shutdown"}),
                     await execute(client, proposal), await client.post(f"{PROPOSALS}/{proposal['id']}/cancel", json={})]
        assert all(response.status_code == 403 for response in responses)
    assert not accounts_app.state.calls.build and not accounts_app.state.calls.execute


async def test_execute_checks_kind_role_even_for_an_owned_proposal(accounts_app):
    proposal = await seed(accounts_app, kind="lab_shutdown")
    async with signed_in(accounts_app) as client:
        error(await execute(client, proposal, phrase="LAB OFF"), 403, "forbidden")
        error(await client.post(PROPOSALS, json={"kind": "lab_shutdown"}), 403, "forbidden")
    assert await attempts(accounts_app, "operator") == 0
    assert not accounts_app.state.calls.drift and not accounts_app.state.calls.background


async def test_wrong_phrase_is_audited_without_consuming_password_attempts(accounts_app):
    async with signed_in(accounts_app, "admin") as client:
        proposal = await propose(client, "lab_shutdown")
        for _ in range(confirm.FAILURE_LIMIT + 1):
            response = await execute(client, proposal, password=WRONG_PASSWORD, phrase=WRONG_PHRASE)
            error(response, 403, "phrase")
            no_private(response.text)
        assert await attempts(accounts_app) == 0
        rows = await events(accounts_app, proposal["id"])
        denials = [row for row in rows if row.event == "denied"]
        assert len(denials) == confirm.FAILURE_LIMIT + 1
        assert all(json.loads(row.detail_json).get("reason") == "phrase" for row in denials)
        for row in rows:
            no_private(row.detail_json)
        response = await execute(client, proposal, phrase="LAB OFF")
        assert response.status_code == 202, response.text
    assert accounts_app.state.calls.background == [(proposal["id"], "admin")]


async def test_wrong_password_is_audited_then_own_password_succeeds(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        response = await execute(client, proposal, password=WRONG_PASSWORD)
        assert response.status_code == 403 and response.json()["detail"] == "Password is incorrect"
        error(response, 403, "password")
        assert set(response.json()) == {"detail", "code", "details"}
        no_private(response.text)
        assert await attempts(accounts_app, "operator") == 1
        rows = await events(accounts_app, proposal["id"])
        assert any(row.event == "denied" and row.actor == "operator" for row in rows)
        response = await execute(client, proposal)
        assert response.status_code == 200 and response.json()["status"] == "succeeded"
        no_private(response.text)
    assert await attempts(accounts_app, "operator") == 1
    for row in await events(accounts_app, proposal["id"]):
        no_private(row.detail_json)


async def test_repeated_bad_passwords_are_throttled_without_executing(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        for _ in range(confirm.FAILURE_LIMIT):
            assert (await execute(client, proposal, password=WRONG_PASSWORD)).status_code == 403
        for _ in range(2):
            response = await execute(client, proposal)
            assert response.status_code == 429 and response.headers["retry-after"] == "300"
            error(response, 429, "throttled")
            no_private(response.text)
    assert await attempts(accounts_app, "operator") == confirm.FAILURE_LIMIT
    assert sum(row.event == "throttled" for row in await events(accounts_app, proposal["id"])) == 2
    assert not accounts_app.state.calls.execute and not accounts_app.state.calls.drift


async def test_other_owner_is_hidden_and_admin_cannot_execute_it(accounts_app):
    async with signed_in(accounts_app) as owner:
        proposal = await propose(owner)
    async with signed_in(accounts_app, "other") as client:
        error(await client.get(f"{PROPOSALS}/{proposal['id']}"), 404, "not_found")
        error(await execute(client, proposal), 404, "not_found")
        error(await client.post(f"{PROPOSALS}/{proposal['id']}/cancel", json={}), 404, "not_found")
    async with signed_in(accounts_app, "admin") as client:
        assert (await client.get(f"{PROPOSALS}/{proposal['id']}")).status_code == 200
        error(await execute(client, proposal), 404, "not_found")
    assert not accounts_app.state.calls.execute


async def test_missing_proposals_use_consistent_not_found_responses(accounts_app):
    proposal = {"id": "0" * 32}
    async with signed_in(accounts_app) as client:
        error(await client.get(f"{PROPOSALS}/{proposal['id']}"), 404, "not_found")
        error(await execute(client, proposal), 404, "not_found")
        error(await client.post(f"{PROPOSALS}/{proposal['id']}/cancel", json={}), 404, "not_found")


async def test_successful_proposal_cannot_be_replayed(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        assert (await execute(client, proposal)).status_code == 200
        error(await execute(client, proposal), 409, "not_pending")
    assert len(accounts_app.state.calls.execute) == 1


async def test_expired_proposal_is_marked_and_audited_without_execution(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        async with accounts_app.state.sessions() as db:
            await db.execute(update(AssistantActionProposal).where(AssistantActionProposal.id == proposal["id"])
                             .values(expires_at=time.time() - 1))
            await db.commit()
        error(await execute(client, proposal), 410, "expired")
        error(await execute(client, proposal), 410, "expired")
        public = (await client.get(f"{PROPOSALS}/{proposal['id']}")).json()
        assert public["status"] == "expired" and public["can_execute"] is False
    assert sum(row.event == "expired" for row in await events(accounts_app, proposal["id"])) == 1
    assert not accounts_app.state.calls.execute and not accounts_app.state.calls.drift
    assert await attempts(accounts_app, "operator") == 0


async def test_drift_refuses_the_claim_and_never_calls_runner(accounts_app):
    accounts_app.state.calls.drift_reasons = ["Target labels changed"]
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        response = await execute(client, proposal)
        error(response, 409, "drift")
        assert response.json()["details"] == ["Target labels changed"]
        public = (await client.get(f"{PROPOSALS}/{proposal['id']}")).json()
        assert public["status"] == "refused" and public["can_execute"] is False
    assert not accounts_app.state.calls.execute and not accounts_app.state.calls.background
    assert any(row.event == "refused" for row in await events(accounts_app, proposal["id"]))


async def test_background_kind_returns_executing_and_starts_once(accounts_app):
    async with signed_in(accounts_app, "admin") as client:
        proposal = await propose(client, "rack_shutdown")
        assert proposal["phrase"] == "R1 OFF" and proposal["background"] is True
        response = await execute(client, proposal, phrase="R1 OFF")
        assert response.status_code == 202 and response.json()["status"] == "executing"
        error(await execute(client, proposal, phrase="R1 OFF"), 409, "not_pending")
    assert accounts_app.state.calls.background == [(proposal["id"], "admin")]
    assert not accounts_app.state.calls.execute


async def test_second_background_job_is_busy(accounts_app):
    async with signed_in(accounts_app, "admin") as client:
        first = await propose(client, "lab_shutdown")
        assert (await execute(client, first, phrase="LAB OFF")).status_code == 202
        second = await propose(client, "rack_shutdown")
        error(await execute(client, second, phrase="R1 OFF"), 409, "busy")
    assert accounts_app.state.calls.background == [(first["id"], "admin")]


@pytest.mark.parametrize("kind", ["rack_shutdown", "lab_shutdown", "batch_restore"])
async def test_shared_password_mode_refuses_batch_actions(accounts_app, kind):
    accounts_app.state.settings.accounts_enabled = False
    values = {}
    if kind == "batch_restore":
        source = await seed(accounts_app, "admin", "Admin", kind="lab_shutdown")
        values["restore_of"] = source["id"]
    proposal = await seed(accounts_app, "admin", "Admin", kind=kind, **values)
    async with AsyncClient(transport=ASGITransport(app=accounts_app), base_url="http://test") as client:
        response = await execute(client, proposal, password=SHARED_PASSWORD, phrase=proposal["phrase"])
        error(response, 403, "password_mode")
    assert not accounts_app.state.calls.drift and not accounts_app.state.calls.background


async def test_unconfigured_password_mode_refuses_inline_execution(accounts_app):
    accounts_app.state.settings.accounts_enabled = False
    accounts_app.state.settings.lab_manager_password = ""
    proposal = await seed(accounts_app)
    async with AsyncClient(transport=ASGITransport(app=accounts_app), base_url="http://test") as client:
        error(await execute(client, proposal), 403, "password_mode")
    assert not accounts_app.state.calls.drift and not accounts_app.state.calls.execute


async def test_missing_csrf_blocks_all_writes(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        del client.headers["X-DCIM-CSRF"]
        assert (await client.get(f"{PROPOSALS}/{proposal['id']}")).status_code == 200
        responses = [await execute(client, proposal), await client.post(f"{PROPOSALS}/{proposal['id']}/cancel", json={}),
                     await client.post(PROPOSALS, json={"kind": "outlet_off", "pdu": "pdu-a", "outlet": 1})]
        assert all(response.status_code == 403 and "CSRF" in response.json()["detail"] for response in responses)
    assert len(accounts_app.state.calls.build) == 1 and not accounts_app.state.calls.execute


async def test_proposals_are_parsed_by_hand_and_never_echo_invalid_values(accounts_app):
    # Invalid values must fail before resolving or contacting any target.
    invalid = [None, [], "untrusted-input", {}, {"kind": "unknown-kind"}, {"kind": 42}]
    valid = {"kind": "outlet_off", "pdu": "pdu-a", "outlet": 1}
    invalid.extend([{**valid, "outlet": value} for value in (0, 65, True, "1", 1.5)])
    for field in ("server", "pdu", "rack", "restore_of"):
        invalid.extend([{**valid, field: value} for value in ("x" * 101, "bad\x00value", "\ud800", 17)])
    invalid.extend([{**valid, "reason": value} for value in ("x" * 201, "line\nbreak", "\ud800", 17)])
    invalid.append({**valid, "then_console": "true"})
    async with signed_in(accounts_app) as client:
        for body in invalid:
            response = await client.post(PROPOSALS, content=json.dumps(body), headers={"Content-Type": "application/json"})
            error(response, 400, "invalid")
            assert "untrusted-input" not in response.text and "unknown-kind" not in response.text
        response = await client.post(PROPOSALS, content=b"{untrusted-input", headers={"Content-Type": "application/json"})
        error(response, 400, "invalid")
    assert not accounts_app.state.calls.build


async def test_execute_body_validation_never_uses_pydantic_or_echoes_secrets(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        url = f"{PROPOSALS}/{proposal['id']}/execute"
        for body in (None, [], WRONG_PASSWORD, {}, {"password": 123}, {"password": ""},
                     {"password": ACCOUNT_PASSWORD * 20}):
            response = await client.post(url, content=json.dumps(body), headers={"Content-Type": "application/json"})
            error(response, 400, "invalid")
            no_private(response.text)
        response = await client.post(url, content=("{" + ACCOUNT_PASSWORD).encode(),
                                     headers={"Content-Type": "application/json"})
        error(response, 400, "invalid")
        no_private(response.text)
    assert not accounts_app.state.calls.execute and not accounts_app.state.calls.drift


async def test_execute_rejects_extra_parameters_and_hides_server_only_fields(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client, "outlet_cycle", then_console=True)
        no_private(proposal)
        response = await execute(client, proposal, kind="lab_shutdown", pdu="different", outlet=64,
                                 phrase=WRONG_PHRASE, reason=WRONG_PASSWORD, then_console=False)
        error(response, 400, "invalid")
        no_private(response.text)
        public = (await client.get(f"{PROPOSALS}/{proposal['id']}")).json()
        assert public["status"] == "pending" and not accounts_app.state.calls.execute
        no_private(public)
        response = await execute(client, proposal)
        assert response.status_code == 200
        no_private(response.text)
        no_private((await client.get(PROPOSALS)).text)
    request = accounts_app.state.calls.execute[0][2]
    assert request["kind"] == "outlet_cycle" and request["pdu"] == "pdu-a" and request["outlet"] == 1
    assert request["then_console"] is True and request["reason"] == PRIVATE_REASON
    for row in await events(accounts_app, proposal["id"]):
        no_private(row.detail_json)


async def test_pending_proposal_can_be_cancelled_and_cannot_execute_afterward(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/cancel", json={})
        assert response.status_code == 200 and response.json()["status"] == "cancelled"
        assert response.json()["can_execute"] is False
        error(await execute(client, proposal), 409, "not_pending")
    assert any(row.event == "cancelled" for row in await events(accounts_app, proposal["id"]))
    assert not accounts_app.state.calls.execute


async def test_open_console_proposal_is_ready_and_has_nothing_to_execute(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client, "open_console")
        assert proposal["status"] == "ready" and proposal["can_execute"] is False
        assert proposal["needs_password"] is False and proposal["phrase"] is None
        assert proposal["impact"]["consoles"][0]["console_url"] == "/api/kvms/kvm-a/autologin?port=1"
        no_private(proposal)
        error(await client.post(f"{PROPOSALS}/{proposal['id']}/execute", json={}), 409, "not_pending")
    assert not accounts_app.state.calls.execute


async def test_list_is_owner_scoped_and_admin_can_see_all_with_limit(accounts_app):
    async with signed_in(accounts_app) as owner:
        first = await propose(owner)
        second = await propose(owner, "outlet_on")
    async with signed_in(accounts_app, "other") as other:
        third = await propose(other)
        items = (await other.get(PROPOSALS)).json()["items"]
        assert [item["id"] for item in items] == [third["id"]]
    async with signed_in(accounts_app) as owner:
        items = (await owner.get(PROPOSALS)).json()["items"]
        assert {item["id"] for item in items} == {first["id"], second["id"]}
        assert len((await owner.get(PROPOSALS + "?limit=1")).json()["items"]) == 1
    async with signed_in(accounts_app, "admin") as admin:
        items = (await admin.get(PROPOSALS)).json()["items"]
        assert {item["id"] for item in items} == {first["id"], second["id"], third["id"]}
        assert len((await admin.get(PROPOSALS + "?limit=2")).json()["items"]) == 2
        no_private(items)


async def test_store_claim_is_owner_only_and_single_use(accounts_app):
    proposal = await seed(accounts_app)
    async with accounts_app.state.sessions() as db:
        for who in (principal("other"), principal("admin", "Admin")):
            with pytest.raises(ActionError) as failure:
                await store.claim(db, who, proposal["id"], time.time())
            assert (failure.value.status, failure.value.code) == (404, "not_found")
        row = await store.claim(db, principal(), proposal["id"], time.time())
        assert row.status == "executing" and row.confirmed_by == "operator"
        with pytest.raises(ActionError) as failure:
            await store.claim(db, principal(), proposal["id"], time.time())
        assert (failure.value.status, failure.value.code) == (409, "not_pending")


async def test_concurrent_claims_admit_exactly_one_execution(accounts_app):
    # StaticPool lets simultaneous sessions share a transaction; queue checkouts so one rollback cannot undo another claim.
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=AsyncAdaptedQueuePool,
                                 pool_size=1, max_overflow=0)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as db:
            row = await store.create(db, principal(), ProposalRequest("outlet_off", pdu="pdu-a", outlet=1),
                                     impact(), accounts_app.state.settings, time.time())
            proposal_id = row.id

        async def claim():
            async with sessions() as db:
                try:
                    row = await store.claim(db, principal(), proposal_id, time.time())
                    return row.status
                except ActionError as failure:
                    return failure.code

        results = await asyncio.gather(claim(), claim())
        assert sorted(results) == ["executing", "not_pending"]
        async with sessions() as db:
            assert await db.scalar(select(func.count()).select_from(AssistantActionEvent).where(
                AssistantActionEvent.proposal_id == proposal_id, AssistantActionEvent.event == "confirmed")) == 1
    finally:
        await engine.dispose()


async def test_concurrent_background_requests_admit_only_one_and_leave_other_pending(accounts_app):
    async with signed_in(accounts_app, "admin") as client:
        first = await propose(client, "lab_shutdown")
        async with signed_in(accounts_app, "admin2") as other:
            second = await propose(other, "rack_shutdown")
            responses = await asyncio.gather(execute(client, first, phrase="LAB OFF"),
                                             execute(other, second, phrase="R1 OFF"))
        assert sorted(response.status_code for response in responses) == [202, 409]
        rejected = next(response for response in responses if response.status_code == 409)
        error(rejected, 409, "busy")
        items = (await client.get(PROPOSALS)).json()["items"]
        assert sorted(item["status"] for item in items) == ["executing", "pending"]
        pending = next(item for item in items if item["status"] == "pending")
        async with signed_in(accounts_app, pending["created_by"]) as owner:
            assert (await owner.get(f"{PROPOSALS}/{pending['id']}")).json()["can_execute"] is True
    assert len(accounts_app.state.calls.background) == 1 and not accounts_app.state.calls.execute


async def test_store_public_capabilities_reflect_role_owner_expiry_and_restore_state(accounts_app):
    proposal = await seed(accounts_app, "admin", "Admin", "lab_shutdown")
    async with accounts_app.state.sessions() as db:
        row = await db.get(AssistantActionProposal, proposal["id"])
        assert store.to_public(row, principal("admin", "Admin"))["can_execute"] is True
        assert store.to_public(row, principal("other"))["can_execute"] is False
        assert store.to_public(row, principal("viewer", "Viewer"))["can_execute"] is False
        row.expires_at = time.time() - 1
        assert store.to_public(row, principal("admin", "Admin"))["can_execute"] is False
        row.status, row.batch_down_json = "partial", '["pdu-a"]'
        public = store.to_public(row, principal("admin", "Admin"))
        assert public["can_restore"] is True
        no_private(public)
        row.batch_down_json = "[]"
        assert store.to_public(row, principal("admin", "Admin"))["can_restore"] is False


async def test_store_denial_cap_never_pushes_out_execution_history(accounts_app, monkeypatch):
    monkeypatch.setattr(store, "EVENT_KEEP", 5)
    proposal = await seed(accounts_app)
    async with accounts_app.state.sessions() as db:
        await store.add_event(db, proposal["id"], "operator", "executing", {"kept": True})
        for number in range(8):
            await store.add_event(db, proposal["id"], "operator", "denied" if number % 2 else "throttled", {"number": number})
        await db.commit()
        assert await db.scalar(select(func.count()).select_from(AssistantActionEvent)) == 7
    rows = await events(accounts_app, proposal["id"])
    assert [row.event for row in rows[:2]] == ["proposed", "executing"]
    assert [json.loads(row.detail_json)["number"] for row in rows[2:]] == [3, 4, 5, 6, 7]


async def test_store_progress_and_finish_are_persisted_in_fresh_sessions(accounts_app):
    proposal = await seed(accounts_app)
    async with accounts_app.state.sessions() as db:
        await store.claim(db, principal(), proposal["id"], time.time())
        await store.set_progress(db, proposal["id"], 1, 2)
    async with accounts_app.state.sessions() as db:
        row = await db.get(AssistantActionProposal, proposal["id"])
        assert store.to_public(row, principal())["progress"] == {"done": 1, "total": 2}
        await store.finish(db, proposal["id"], "partial", {"summary_he": "One target failed"})
    async with accounts_app.state.sessions() as db:
        row = await db.get(AssistantActionProposal, proposal["id"])
        assert row.status == "partial" and row.finished_at is not None
        assert store.to_public(row, principal())["result"] == {"summary_he": "One target failed"}


def test_store_owner_keys_separate_account_and_shared_principals():
    assert store.owner_key(principal()) == "operator"
    assert store.owner_key(Principal(None, "shared", "Admin", True)) == "shared:shared"


@pytest.mark.parametrize("shared_password", [SHARED_PASSWORD, ""])
async def test_shared_and_open_modes_refuse_every_action_route(accounts_app, shared_password):
    accounts_app.state.settings.accounts_enabled = False
    accounts_app.state.settings.lab_manager_password = shared_password
    proposal = await seed(accounts_app)
    async with AsyncClient(transport=ASGITransport(app=accounts_app), base_url="http://test") as client:
        responses = [await client.get(PROPOSALS), await client.get(f"{PROPOSALS}/{proposal['id']}"),
                     await client.post(PROPOSALS, json={"kind": "open_console", "server": "NODE1"}),
                     await execute(client, proposal),
                     await client.post(f"{PROPOSALS}/{proposal['id']}/cancel", json={})]
        for response in responses:
            error(response, 403, "password_mode")
        response = await client.get(ROOT + "/config")
        assert response.status_code == 200
        assert response.json()["password_mode"] == ("shared" if shared_password else "unavailable")
        assert response.json()["can_propose"] is False and response.json()["can_admin"] is False
    assert not accounts_app.state.calls.build and not accounts_app.state.calls.execute


async def test_accounts_confirmation_never_accepts_the_shared_password(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        error(await execute(client, proposal, password=SHARED_PASSWORD), 403, "password")
        assert (await execute(client, proposal)).status_code == 200
    assert len(accounts_app.state.calls.execute) == 1


async def test_write_guard_requires_json_and_blocks_cross_origin(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        for url in (PROPOSALS, f"{PROPOSALS}/{proposal['id']}/execute", f"{PROPOSALS}/{proposal['id']}/cancel"):
            response = await client.post(url, content=ACCOUNT_PASSWORD, headers={"Content-Type": "text/plain"})
            assert response.status_code == 415
            assert set(response.json()) == {"detail", "code", "details"}
            assert response.headers["cache-control"] == "no-store"
            no_private(response.text)
        response = await client.post(f"{PROPOSALS}/{proposal['id']}/execute",
                                     json={"password": ACCOUNT_PASSWORD}, headers={"Origin": "https://other.example.invalid"})
        assert response.status_code == 403
    assert not accounts_app.state.calls.execute and not accounts_app.state.calls.drift


async def test_invalid_proposal_ids_are_hidden_before_password_verification(accounts_app):
    async with signed_in(accounts_app) as client:
        for proposal_id in ("short", "A" * 32, "g" * 32, "0" * 31):
            proposal = {"id": proposal_id}
            error(await client.get(f"{PROPOSALS}/{proposal_id}"), 404, "not_found")
            error(await execute(client, proposal, password=WRONG_PASSWORD), 404, "not_found")
            error(await client.post(f"{PROPOSALS}/{proposal_id}/cancel", json={}), 404, "not_found")
    assert await attempts(accounts_app, "operator") == 0


async def test_proposal_quota_is_per_user_and_cancel_releases_a_slot(accounts_app):
    async with signed_in(accounts_app) as client:
        proposals = [await propose(client) for _ in range(3)]
        error(await client.post(PROPOSALS, json={"kind": "outlet_off", "pdu": "pdu-a", "outlet": 1}), 409, "busy")
        async with signed_in(accounts_app, "other") as other:
            await propose(other)
        assert (await client.post(f"{PROPOSALS}/{proposals[0]['id']}/cancel", json={})).status_code == 200
        await propose(client)


async def test_only_one_bulk_proposal_can_be_pending_per_user(accounts_app):
    async with signed_in(accounts_app, "admin") as client:
        await propose(client, "lab_shutdown")
        error(await client.post(PROPOSALS, json={"kind": "rack_shutdown", "rack": "R1"}), 409, "busy")
        async with signed_in(accounts_app, "admin2") as other:
            await propose(other, "rack_shutdown")


async def test_get_does_not_mutate_an_expired_pending_proposal(accounts_app):
    proposal = await seed(accounts_app)
    async with accounts_app.state.sessions() as db:
        await db.execute(update(AssistantActionProposal).where(AssistantActionProposal.id == proposal["id"])
                         .values(expires_at=time.time() - 1))
        await db.commit()
    before = len(await events(accounts_app, proposal["id"]))
    async with signed_in(accounts_app) as client:
        response = await client.get(f"{PROPOSALS}/{proposal['id']}")
        assert response.status_code == 200 and response.json()["status"] == "pending"
        assert response.json()["can_execute"] is False and response.json()["expires_in_s"] == 0
        assert (await client.get(PROPOSALS)).status_code == 200
    assert len(await events(accounts_app, proposal["id"])) == before
    async with accounts_app.state.sessions() as db:
        assert (await db.get(AssistantActionProposal, proposal["id"])).status == "pending"


async def test_audit_retention_keeps_one_year_and_removes_older_rows(accounts_app):
    proposal = await seed(accounts_app)
    now = time.time()
    async with accounts_app.state.sessions() as db:
        for at, actor in ((now - 366 * 86400, "old"), (now - 364 * 86400, "retained")):
            db.add(AssistantActionEvent(at=at, proposal_id=proposal["id"], actor=actor,
                                       event="finished", detail_json="{}"))
        await db.commit()
        await store.add_event(db, proposal["id"], "operator", "confirmed", {})
        await db.commit()
    rows = await events(accounts_app, proposal["id"])
    assert "old" not in [row.actor for row in rows] and "retained" in [row.actor for row in rows]


async def test_stale_expired_proposals_are_purged_without_deleting_their_events(accounts_app):
    proposal = await seed(accounts_app)
    async with accounts_app.state.sessions() as db:
        await db.execute(update(AssistantActionProposal).where(AssistantActionProposal.id == proposal["id"])
                         .values(expires_at=time.time() - 31 * 86400, status="expired"))
        await db.commit()
    async with signed_in(accounts_app) as client:
        await propose(client)
        error(await client.get(f"{PROPOSALS}/{proposal['id']}"), 404, "not_found")
    assert any(row.event == "proposed" for row in await events(accounts_app, proposal["id"]))


async def test_response_and_audit_logs_never_expose_confirmation_secrets(accounts_app, caplog):
    caplog.set_level("INFO")
    async with signed_in(accounts_app, "admin") as client:
        proposal = await propose(client, "lab_shutdown")
        wrong_phrase = await execute(client, proposal, phrase=WRONG_PHRASE)
        wrong_password = await execute(client, proposal, password=WRONG_PASSWORD, phrase="LAB OFF")
        accepted = await execute(client, proposal, phrase="LAB OFF")
        for response in (wrong_phrase, wrong_password, accepted):
            no_private(response.text)
            assert response.headers["cache-control"] == "no-store"
    no_private(caplog.text)
    for row in await events(accounts_app, proposal["id"]):
        no_private(row.detail_json)


async def test_phrase_is_checked_before_missing_password_without_consuming_an_attempt(accounts_app):
    async with signed_in(accounts_app, "admin") as client:
        proposal = await propose(client, "lab_shutdown")
        url = f"{PROPOSALS}/{proposal['id']}/execute"
        error(await client.post(url, json={"phrase": WRONG_PHRASE}), 403, "phrase")
        error(await client.post(url, json={"phrase": "LAB OFF"}), 400, "invalid")
    assert await attempts(accounts_app) == 0
    assert sum(row.event == "denied" for row in await events(accounts_app, proposal["id"])) == 1
    assert not accounts_app.state.calls.background


async def test_confirmation_phrase_is_normalized_and_stripped(accounts_app):
    async with signed_in(accounts_app, "admin") as client:
        proposal = await propose(client, "rack_shutdown", rack="Caf\u00e9")
        response = await execute(client, proposal, phrase="  Cafe\u0301 OFF  ")
        assert response.status_code == 202, response.text
    assert accounts_app.state.calls.background == [(proposal["id"], "admin")]


async def test_unpaired_surrogates_are_rejected_without_password_attempts(accounts_app):
    async with signed_in(accounts_app, "admin") as client:
        proposal = await propose(client, "lab_shutdown")
        url = f"{PROPOSALS}/{proposal['id']}/execute"
        for body in ({"password": ACCOUNT_PASSWORD, "phrase": "\ud800"},
                     {"password": "\ud800", "phrase": "LAB OFF"}):
            response = await client.post(url, content=json.dumps(body), headers={"Content-Type": "application/json"})
            error(response, 400, "invalid")
            no_private(response.text)
    assert await attempts(accounts_app) == 0
    assert not accounts_app.state.calls.drift and not accounts_app.state.calls.background


async def test_execute_checks_owner_and_status_before_flag_or_password(accounts_app):
    async with signed_in(accounts_app) as owner:
        proposal = await propose(owner)
        accounts_app.state.settings.assistant_actions_enabled = False
        async with signed_in(accounts_app, "other") as other:
            error(await execute(other, proposal, password=WRONG_PASSWORD), 404, "not_found")
        error(await owner.post(f"{PROPOSALS}/{'0' * 32}/execute", json={}), 404, "not_found")
        accounts_app.state.settings.assistant_actions_enabled = True
        assert (await execute(owner, proposal)).status_code == 200
        accounts_app.state.settings.assistant_actions_enabled = False
        error(await owner.post(f"{PROPOSALS}/{proposal['id']}/execute", json={}), 409, "not_pending")
    assert await attempts(accounts_app, "operator") == 0 and await attempts(accounts_app, "other") == 0


async def test_declared_and_streaming_oversized_bodies_are_rejected_before_confirmation(accounts_app):
    async with signed_in(accounts_app) as client:
        proposal = await propose(client)
        for url in (PROPOSALS, f"{PROPOSALS}/{proposal['id']}/execute"):
            response = await client.post(url, content=ACCOUNT_PASSWORD + "x" * actions.MAX_BODY_BYTES,
                                         headers={"Content-Type": "application/json"})
            error(response, 400, "invalid")
            no_private(response.text)
            response = await client.post(url, content="{}", headers={"Content-Type": "application/json",
                                                                     "Content-Length": "NaN"})
            error(response, 400, "invalid")

            async def chunks():
                yield b"{" + b"x" * 2048
                yield b"x" * 2048

            response = await client.post(url, content=chunks(), headers={"Content-Type": "application/json"})
            error(response, 400, "invalid")
    assert await attempts(accounts_app, "operator") == 0
    assert len(accounts_app.state.calls.build) == 1 and not accounts_app.state.calls.execute
