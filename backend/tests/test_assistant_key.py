"""The assistant's Anthropic API key set from the Admin page: /api/assistant/key and keystore.py.

No network and no real key: every key here is a made-up string in the right shape, the `anthropic` module is a fake
(keystore.load_sdk / engine.load_sdk are replaced) except where only the installed SDK's exception classes and client
constructor are used, which send nothing. Every database is a temporary SQLite file.
"""
import asyncio
import logging
import time
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, confirm, crypto
from app.assistant import engine, keystore, ratelimit
from app.assistant import router as assistant
from app.assistant.contracts import Principal, ToolContext
from app.database import Base
from app.models import AssistantSetting, User

PASSWORD = "assistant-key-test-password-1"
SITE_KEY = "sk-ant-api03-SITEkeyMARKER0123456789abcdefghijklmnop_-QRST"
SITE_KEY_2 = "sk-ant-api03-SECONDsiteKEY9876543210zyxwvutsrqponm_-WXYZ"
ENV_KEY = "sk-ant-api03-ENVkeyFROMdotenv0123456789abcdefghijk_-ENV9"
KEY_PATH = "/api/assistant/key"


def key_parts(key):
    """The key and pieces of it that must never be shown (anything beyond the last-4 hint)."""
    return [key, key[:-4], key[7:27], key[-12:-4]]


# ---------------------------------------------------------------------------------------------------------------
# Fake anthropic module
# ---------------------------------------------------------------------------------------------------------------
class FakeStatusError(Exception):
    status_code = 500

    def __init__(self, message="upstream error", status_code=None):
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


class FakeAuthError(FakeStatusError):
    status_code = 401


class FakePermissionError(FakeStatusError):
    status_code = 403


class FakeRateLimitError(FakeStatusError):
    status_code = 429


class FakeConnectionError(Exception):
    pass


class FakeTimeoutError(FakeConnectionError):
    pass


class FakeSDK:
    """Stands in for the `anthropic` module: records every client and what it was built with."""
    AuthenticationError = FakeAuthError
    PermissionDeniedError = FakePermissionError
    RateLimitError = FakeRateLimitError
    APIStatusError = FakeStatusError
    APIConnectionError = FakeConnectionError
    APITimeoutError = FakeTimeoutError

    def __init__(self):
        self.clients = []
        self.list_error = None       # raised by models.list
        self.list_delay = 0.0
        self.stream_error = FakeAuthError("rejected by fake")   # raised by beta.messages.stream (engine path)
        sdk = self

        class AsyncAnthropic:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.closed = False
                self.list_calls = []
                sdk.clients.append(self)
                client = self

                class Models:
                    async def list(self, **params):
                        client.list_calls.append(params)
                        if sdk.list_delay:
                            await asyncio.sleep(sdk.list_delay)
                        if sdk.list_error is not None:
                            raise sdk.list_error
                        return SimpleNamespace(data=[SimpleNamespace(id="claude-test")])

                class Messages:
                    def stream(self, **params):
                        raise sdk.stream_error

                self.models = Models()
                self.beta = SimpleNamespace(messages=Messages())

            async def close(self):
                self.closed = True

        self.AsyncAnthropic = AsyncAnthropic

    @property
    def keys(self):
        return [client.kwargs.get("api_key") for client in self.clients]


class FakeEngine:
    """engine.answer_question stand-in: records the settings it got and answers "llm" only when they carry a key."""

    def __init__(self):
        self.seen = []

    async def __call__(self, *, question, history, context, ctx, tools, mode=None, demo_reason=None):
        self.seen.append(ctx.settings)
        key = ctx.settings.assistant_anthropic_api_key
        llm = mode != "demo" and bool(ctx.settings.assistant_llm_enabled and key)
        return {"mode": "llm" if llm else "demo",
                "answer": {"summary": "תשובה", "facts": [], "hypotheses": [], "recommendations": [], "checks": [],
                           "missing_data": [], "entity_refs": [], "work_item_drafts": []},
                "ledger": [], "usage": None, "demo_reason": None if llm else "no_api_key"}


# ---------------------------------------------------------------------------------------------------------------
# Fixture: an accounts-mode app with the assistant router, a temporary database and a real master key
# ---------------------------------------------------------------------------------------------------------------
def make_settings(**overrides):
    values = dict(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                  accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD,
                  lab_manager_master_key=Fernet.generate_key().decode(), ping_monitor_enabled=False,
                  email_alerts_enabled=False, pxe_enabled=False, pdu_password="pdu-secret-1",
                  kvm_password="kvm-secret-2", smtp_password=SecretStr("smtp-secret-4"),
                  email_alerts_to="alerts-recipient@example.com", assistant_enabled=True,
                  assistant_llm_enabled=True, assistant_anthropic_api_key=None, assistant_model="claude-opus-5-5",
                  assistant_timeout_seconds=30, assistant_per_minute=50, assistant_per_hour=500,
                  assistant_max_chars=2000, assistant_concurrency=4, assistant_daily_limit=300,
                  assistant_allow_open_llm=False, assistant_actions_enabled=False, ping_monitor_timezone="UTC")
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture
async def env(tmp_path, monkeypatch):
    db_engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'assistant-key.db'}")
    async with db_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(db_engine, expire_on_commit=False)
    settings = make_settings()
    fake_engine = FakeEngine()
    sdk = FakeSDK()
    for module in (accounts, assistant):
        monkeypatch.setattr(module, "AsyncSessionLocal", sessions)
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(crypto, "get_settings", lambda: settings)
    monkeypatch.setattr(assistant, "TIMEOUT_GRACE_SECONDS", 0.0)
    monkeypatch.setattr(assistant, "_load_engine", lambda: fake_engine)
    monkeypatch.setattr(assistant, "_load_tools", lambda principal: [])
    monkeypatch.setattr(assistant, "_anthropic_available", lambda: True)
    monkeypatch.setattr(ratelimit, "gate", ratelimit.Gate())
    monkeypatch.setattr(keystore, "load_sdk", lambda: sdk)
    monkeypatch.setattr(engine, "load_sdk", lambda: sdk)
    keystore.invalidate()
    await accounts.bootstrap_admin()
    password_hash = accounts.hash_password(PASSWORD)
    async with sessions() as db:
        for user_id, role in (("viewer", "Viewer"), ("operator", "Operator"), ("admin2", "Admin")):
            db.add(User(id=user_id, username=user_id, name=user_id, role=role, password_hash=password_hash,
                        created_at=time.time()))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(assistant.router)
    yield SimpleNamespace(app=app, sessions=sessions, settings=settings, fake_engine=fake_engine, sdk=sdk)
    keystore.invalidate()
    await db_engine.dispose()


def client(env):
    return AsyncClient(transport=ASGITransport(app=env.app), base_url="http://test")


async def sign_in(c, username="admin"):
    r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]


async def put_key(c, key=SITE_KEY, password=PASSWORD, test=True, **extra):
    return await c.put(KEY_PATH, json={"key": key, "password": password, "test": test, **extra})


async def delete_key(c, password=PASSWORD):
    return await c.request("DELETE", KEY_PATH, json={"password": password})


async def rows(env):
    async with env.sessions() as db:
        return (await db.execute(select(AssistantSetting))).scalars().all()


async def ask(c):
    return await c.post("/api/assistant/chat", json={"message": "מה המצב?"})


# ---------------------------------------------------------------------------------------------------------------
# Roles, CSRF, origin
# ---------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "POST", "PATCH"])
def test_required_role_is_admin_for_every_method(method):
    assert accounts.required_role(KEY_PATH, method) == "Admin"
    assert accounts.required_role("/api/assistant/status", "GET") == "Viewer"   # neighbours unchanged
    assert accounts.required_role("/api/assistant/chat", "POST") == "Viewer"


@pytest.mark.parametrize("username", ["viewer", "operator"])
async def test_viewer_and_operator_are_refused_even_for_reads(env, username):
    async with client(env) as c:
        await sign_in(c, username)
        for response in (await c.get(KEY_PATH), await c.head(KEY_PATH), await put_key(c), await delete_key(c)):
            assert response.status_code == 403
        assert "Your role does not allow this action" in (await c.get(KEY_PATH)).text
    assert await rows(env) == [] and env.sdk.clients == []


async def test_admin_reads_status_and_signed_out_is_401(env):
    async with client(env) as c:
        assert (await c.get(KEY_PATH)).status_code == 401
        await sign_in(c, "admin")
        r = await c.get(KEY_PATH)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        assert r.json() == {"source": "none", "hint": None, "set_by": None, "set_at": None,
                            "master_key_configured": True, "mode": "demo",
                            "reason": assistant.KEY_REASONS["no_api_key"], "reason_code": "no_api_key",
                            "stored_key_unreadable": False}


async def test_writes_need_the_csrf_header_and_same_origin(env):
    async with client(env) as c:
        await sign_in(c, "admin")
        token = c.headers.pop("X-DCIM-CSRF")
        for response in (await put_key(c), await delete_key(c)):
            assert response.status_code == 403 and "CSRF" in response.text
        c.headers["X-DCIM-CSRF"] = token
        cross = await c.put(KEY_PATH, json={"key": SITE_KEY, "password": PASSWORD},
                            headers={"Origin": "http://evil.example"})
        assert cross.status_code == 403 and "Cross-origin" in cross.text
        not_json = await c.put(KEY_PATH, content=b"key=x", headers={"Content-Type": "application/x-www-form-urlencoded"})
        assert not_json.status_code == 415
    assert await rows(env) == [] and env.sdk.clients == []


# ---------------------------------------------------------------------------------------------------------------
# Password, throttle, format, master key, test failure
# ---------------------------------------------------------------------------------------------------------------
async def test_wrong_password_is_403_then_throttled(env):
    async with client(env) as c:
        await sign_in(c, "admin")
        r = await put_key(c, password="wrong-password")
        assert r.status_code == 403 and r.json()["detail"] == "Password is incorrect"
        assert (await delete_key(c, password="wrong-password")).status_code == 403
        for _ in range(confirm.FAILURE_LIMIT - 2):
            assert (await put_key(c, password="wrong-password")).status_code == 403
        throttled = await put_key(c, password="wrong-password")
        assert throttled.status_code == 429 and throttled.headers["retry-after"] == "300"
        assert (await put_key(c)).status_code == 429   # even the right password waits out the window
        assert (await delete_key(c)).status_code == 429
        missing = await c.put(KEY_PATH, json={"key": SITE_KEY})
        assert missing.status_code == 400 and missing.json()["detail"] == "Password is required"
    assert await rows(env) == [] and env.sdk.clients == []   # the key was never tested or stored


@pytest.mark.parametrize("bad", [
    "not-a-key-SECRETMARKER-0123456789abcdef",
    "sk-ant-short",
    "sk-ant-api03-has spaces inside SECRETMARKER0123456789",
    "sk-ant-api03-" + "SECRETMARKER" * 20,          # longer than the 200-character body
    "sk-ant-api03-SECRETMARKER0123456789\nabc",
    "SK-ANT-API03-SECRETMARKER0123456789ABCDEF",
])
async def test_bad_format_is_422_and_never_echoed(env, bad):
    async with client(env) as c:
        await sign_in(c, "admin")
        r = await put_key(c, key=bad)
        assert r.status_code == 422 and r.json() == {"detail": assistant.KEY_MSG_FORMAT}
        assert "SECRETMARKER" not in r.text and "short" not in r.text
    assert await rows(env) == [] and env.sdk.clients == []


async def test_malformed_bodies_never_echo_input(env):
    async with client(env) as c:
        await sign_in(c, "admin")
        cases = [
            await c.put(KEY_PATH, json={"key": ["sk-ant-SECRETMARKER"], "password": PASSWORD}),
            await c.put(KEY_PATH, json={"key": 1234567890, "password": PASSWORD}),
            await c.put(KEY_PATH, content=b'{"key": "sk-ant-SECRETMARKER", "password": ',
                        headers={"Content-Type": "application/json"}),
            await c.put(KEY_PATH, json=["sk-ant-SECRETMARKER"]),
            await c.put(KEY_PATH, json={"key": SITE_KEY, "password": PASSWORD, "test": "SECRETMARKER"}),
            await c.put(KEY_PATH, json={"key": SITE_KEY, "password": "x" * 300}),
        ]
        assert [r.status_code for r in cases] == [422, 422, 400, 400, 400, 400]
        for r in cases:
            assert "SECRETMARKER" not in r.text and SITE_KEY not in r.text and "xxxx" not in r.text
    assert await rows(env) == []


@pytest.mark.parametrize("master", ["", "   ", "not-a-fernet-key"])
async def test_master_key_unset_or_invalid_is_409(env, master):
    env.settings.lab_manager_master_key = master
    async with client(env) as c:
        await sign_in(c, "admin")
        assert (await c.get(KEY_PATH)).json()["master_key_configured"] is False
        r = await put_key(c)
        assert r.status_code == 409 and r.json() == {"detail": assistant.KEY_MSG_MASTER}
    assert await rows(env) == [] and env.sdk.clients == []


@pytest.mark.parametrize("error,reason", [
    (FakeAuthError("invalid x-api-key"), keystore.REASON_REJECTED),
    (FakePermissionError("forbidden"), keystore.REASON_NO_ACCESS),
    (FakeConnectionError("proxy refused"), keystore.REASON_UNREACHABLE),
    (FakeStatusError("overloaded", status_code=529), keystore.REASON_API_ERROR),
])
async def test_failed_test_is_422_with_the_fixed_reason_and_nothing_is_stored(env, error, reason):
    env.sdk.list_error = error
    async with client(env) as c:
        await sign_in(c, "admin")
        r = await put_key(c)
        assert r.status_code == 422 and r.json() == {"detail": reason}
        assert SITE_KEY[-4:] not in r.text
        assert (await c.get(KEY_PATH)).json()["source"] == "none"
    assert await rows(env) == []
    assert env.sdk.keys == [SITE_KEY] and env.sdk.clients[0].closed


async def test_missing_sdk_fails_the_test_but_test_false_stores(env, monkeypatch):
    monkeypatch.setattr(keystore, "load_sdk", lambda: None)
    async with client(env) as c:
        await sign_in(c, "admin")
        r = await put_key(c)
        assert r.status_code == 422 and r.json() == {"detail": keystore.REASON_NO_SDK}
        assert await rows(env) == []
        saved = await put_key(c, test=False)
        assert saved.status_code == 200 and saved.json() == {"ok": True, "source": "site", "hint": "…" + SITE_KEY[-4:],
                                                               "test": None}


# ---------------------------------------------------------------------------------------------------------------
# Success, storage, hint only, no leaks
# ---------------------------------------------------------------------------------------------------------------
async def test_success_stores_ciphertext_and_shows_only_the_hint(env, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    texts = []
    async with client(env) as c:
        await sign_in(c, "admin")
        r = await put_key(c, key="  " + SITE_KEY + "  ")
        texts.append(r.text)
        assert r.status_code == 200
        assert r.json() == {"ok": True, "source": "site", "hint": "…" + SITE_KEY[-4:],
                            "test": {"ok": True, "reason": keystore.REASON_OK}}
        client_kwargs = env.sdk.clients[0].kwargs
        assert client_kwargs == {"api_key": SITE_KEY, "base_url": "https://api.anthropic.com",
                                 "timeout": keystore.TEST_TIMEOUT_SECONDS, "max_retries": 0}
        assert env.sdk.clients[0].list_calls == [{"limit": 1}] and env.sdk.clients[0].closed

        [row] = await rows(env)
        assert row.name == "anthropic_api_key" and row.value_enc != SITE_KEY and SITE_KEY not in row.value_enc
        assert crypto.decrypt(row.value_enc) == SITE_KEY
        assert Fernet(env.settings.lab_manager_master_key.encode()).decrypt(row.value_enc.encode()).decode() == SITE_KEY
        assert row.hint == "…" + SITE_KEY[-4:] and row.set_by == "admin" and row.revision == 1
        assert row.set_at.endswith("+00:00") and row.set_at[:4].isdigit()

        state = await c.get(KEY_PATH)
        texts.append(state.text)
        assert state.json() == {"source": "site", "hint": "…" + SITE_KEY[-4:], "set_by": "admin",
                                "set_at": row.set_at, "master_key_configured": True, "mode": "llm", "reason": None,
                                "reason_code": None, "stored_key_unreadable": False}
        texts.append((await c.get("/api/assistant/status")).text)

        await sign_in(c, "admin2")
        replaced = await put_key(c, key=SITE_KEY_2, test=False)
        texts.append(replaced.text)
        assert replaced.json()["hint"] == "…" + SITE_KEY_2[-4:] and replaced.json()["test"] is None
        [row] = await rows(env)
        assert row.revision == 2 and row.set_by == "admin2" and crypto.decrypt(row.value_enc) == SITE_KEY_2
        texts.append((await c.get(KEY_PATH)).text)
        removed = await delete_key(c)
        texts.append(removed.text)
        assert removed.json() == {"ok": True, "removed": True, "source": "none", "hint": None, "mode": "demo",
                                  "reason": assistant.KEY_REASONS["no_api_key"]}
        again = await delete_key(c)
        assert again.status_code == 200 and again.json()["removed"] is False
    captured = capsys.readouterr()
    assert captured.err.count("assistant key set by admin\n") == 1
    assert captured.err.count("assistant key set by admin2\n") == 1
    assert captured.err.count("assistant key removed by admin2\n") == 1
    for secret in key_parts(SITE_KEY) + key_parts(SITE_KEY_2):
        for text in texts + [captured.out, captured.err, caplog.text]:
            assert secret not in text


async def test_key_never_appears_in_any_response_or_log(env, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    env.settings.assistant_anthropic_api_key = SecretStr(ENV_KEY)
    texts = []
    async with client(env) as c:
        await sign_in(c, "admin")
        for call in (lambda: put_key(c, password="wrong"), lambda: put_key(c), lambda: c.get(KEY_PATH),
                     lambda: c.get("/api/assistant/status"), lambda: ask(c), lambda: delete_key(c, "wrong"),
                     lambda: delete_key(c), lambda: c.get(KEY_PATH)):
            r = await call()
            texts.append(r.text + repr(dict(r.headers)))
        env.sdk.list_error = FakeAuthError(f"invalid x-api-key {SITE_KEY}")   # even if an SDK message held the key
        r = await put_key(c, key=SITE_KEY_2)
        texts.append(r.text)
        assert r.status_code == 422
    captured = capsys.readouterr()
    assert repr(env.fake_engine.seen[0]).find(SITE_KEY) == -1 and str(env.fake_engine.seen[0]).find(SITE_KEY) == -1
    for secret in key_parts(SITE_KEY) + key_parts(SITE_KEY_2) + key_parts(ENV_KEY):
        for text in texts + [captured.out, captured.err, caplog.text]:
            assert secret not in text


# ---------------------------------------------------------------------------------------------------------------
# Precedence, fallback and live mode changes
# ---------------------------------------------------------------------------------------------------------------
async def test_site_key_takes_precedence_and_delete_falls_back_to_env(env):
    env.settings.assistant_anthropic_api_key = SecretStr(ENV_KEY)
    async with client(env) as c:
        await sign_in(c, "admin")
        state = (await c.get(KEY_PATH)).json()
        assert state["source"] == "env" and state["hint"] == "…" + ENV_KEY[-4:] and state["mode"] == "llm"
        assert state["set_by"] is None and state["set_at"] is None
        assert (await ask(c)).json()["mode"] == "llm"
        assert env.fake_engine.seen[-1].assistant_anthropic_api_key.get_secret_value() == ENV_KEY

        assert (await put_key(c)).status_code == 200
        assert (await c.get(KEY_PATH)).json()["source"] == "site"
        assert (await ask(c)).json()["mode"] == "llm"
        seen = env.fake_engine.seen[-1]
        assert seen.assistant_anthropic_api_key.get_secret_value() == SITE_KEY and seen.assistant_key_source == "site"
        assert engine._api_key(seen) == SITE_KEY

        removed = await delete_key(c)
        assert removed.json()["source"] == "env" and removed.json()["hint"] == "…" + ENV_KEY[-4:]
        assert (await ask(c)).json()["mode"] == "llm"
        assert env.fake_engine.seen[-1].assistant_anthropic_api_key.get_secret_value() == ENV_KEY
    assert env.settings.assistant_anthropic_api_key.get_secret_value() == ENV_KEY   # settings were never written


async def test_mode_turns_llm_after_put_and_demo_after_delete_without_restart(env):
    async with client(env) as admin, client(env) as viewer:
        await sign_in(admin, "admin")
        await sign_in(viewer, "viewer")
        status = (await viewer.get("/api/assistant/status")).json()
        assert status["mode"] == "demo" and status["demo_reason_code"] == "no_api_key"
        assert "Admin → AI assistant" in status["demo_reason"] and "ASSISTANT_ANTHROPIC_API_KEY" in status["demo_reason"]
        assert (await ask(viewer)).json()["mode"] == "demo"

        assert (await put_key(admin)).status_code == 200
        assert (await viewer.get("/api/assistant/status")).json()["mode"] == "llm"
        assert (await ask(viewer)).json()["mode"] == "llm"

        assert (await delete_key(admin)).status_code == 200
        status = (await viewer.get("/api/assistant/status")).json()
        assert status["mode"] == "demo" and status["demo_reason_code"] == "no_api_key"
        assert (await ask(viewer)).json()["mode"] == "demo"


async def test_other_workers_pick_up_a_change_within_the_cache_ttl(env, monkeypatch):
    """Another uvicorn worker's write does not invalidate this process's cache; the 5 s TTL does."""
    clock = [1000.0]
    monkeypatch.setattr(keystore, "_clock", lambda: clock[0])
    async with env.sessions() as db:
        await keystore.store(db, SITE_KEY, "admin")
    async with env.sessions() as db:
        assert await keystore.load(db) == SITE_KEY
    async with env.sessions() as db:   # "another worker" replaces the key without touching this process's cache
        await db.execute(update(AssistantSetting).values(value_enc=crypto.encrypt(SITE_KEY_2)))
        await db.commit()
    clock[0] += keystore.KEY_CACHE_SECONDS - 0.5
    async with env.sessions() as db:
        assert await keystore.load(db) == SITE_KEY
    clock[0] += 1.0
    async with env.sessions() as db:
        assert await keystore.load(db) == SITE_KEY_2
    assert keystore.KEY_CACHE_SECONDS <= 5


async def test_unreadable_stored_key_falls_back_and_is_reported(env):
    async with client(env) as c:
        await sign_in(c, "admin")
        assert (await put_key(c)).status_code == 200
        env.settings.lab_manager_master_key = Fernet.generate_key().decode()   # master key replaced on the VM
        keystore.invalidate()
        state = (await c.get(KEY_PATH)).json()
        assert state["source"] == "none" and state["stored_key_unreadable"] is True and state["mode"] == "demo"
        assert (await ask(c)).json()["mode"] == "demo"


async def test_legacy_shared_password_mode(env):
    env.settings.accounts_enabled = False
    async with client(env) as c:
        assert (await c.get(KEY_PATH)).status_code == 200
        assert (await put_key(c, password="wrong")).status_code == 403
        cross = await c.put(KEY_PATH, json={"key": SITE_KEY, "password": PASSWORD},
                            headers={"Origin": "http://evil.example"})
        assert cross.status_code == 403
        r = await put_key(c)
        assert r.status_code == 200 and r.json()["source"] == "site"
        [row] = await rows(env)
        assert row.set_by == confirm.SHARED_BY
        env.settings.lab_manager_password = ""   # an open site cannot change the key at all
        assert (await put_key(c)).json() == {"detail": assistant.KEY_MSG_NO_PASSWORD}
        assert (await delete_key(c)).status_code == 403


# ---------------------------------------------------------------------------------------------------------------
# The engine's client gets the effective key
# ---------------------------------------------------------------------------------------------------------------
async def test_engine_client_receives_the_site_key_through_the_chat_router(env, monkeypatch):
    monkeypatch.setattr(assistant, "_load_engine", lambda: engine.answer_question)
    env.settings.assistant_anthropic_api_key = SecretStr(ENV_KEY)
    async with client(env) as c:
        await sign_in(c, "admin")
        assert (await put_key(c, test=False)).status_code == 200
        r = await ask(c)
        assert r.status_code == 200 and r.json()["mode"] == "demo"   # the fake API rejects; the engine falls back
        assert env.sdk.keys == [SITE_KEY]
        assert env.sdk.clients[0].kwargs["base_url"] == engine.API_BASE_URL
        assert (await delete_key(c)).status_code == 200
        assert (await ask(c)).status_code == 200
        assert env.sdk.keys == [SITE_KEY, ENV_KEY]


async def test_engine_resolves_the_site_key_for_other_callers(env):
    async with env.sessions() as db:
        await keystore.store(db, SITE_KEY, "admin")
    ctx = ToolContext(principal=Principal("u1", "tester", "Viewer"), session_factory=env.sessions,
                      settings=make_settings(), now=time.time())
    result = await engine.answer_question(question="מה המצב?", history=[], context={}, ctx=ctx, tools=[])
    assert result["mode"] == "demo" and env.sdk.keys == [SITE_KEY]
    assert ctx.settings.assistant_key_source == "site"
    # A router-forced demo answer and demo-only settings never resolve or use a key.
    demo_ctx = ToolContext(principal=Principal("u1", "tester", "Viewer"), session_factory=env.sessions,
                           settings=assistant.DemoOnlySettings(make_settings(), "open_site"), now=time.time())
    await engine.answer_question(question="מה המצב?", history=[], context={}, ctx=demo_ctx, tools=[])
    assert demo_ctx.settings.assistant_anthropic_api_key is None and len(env.sdk.clients) == 1
    # Without a session factory (engine unit tests) the settings are left as they are.
    bare = ToolContext(principal=Principal("u1", "tester", "Viewer"), session_factory=None,
                       settings=make_settings(assistant_anthropic_api_key=SecretStr(ENV_KEY)), now=time.time())
    await engine.resolve_key(bare)
    assert not isinstance(bare.settings, keystore.KeyedSettings)
    assert engine.default_client_factory(keystore.with_key(make_settings(), SITE_KEY), env.sdk).kwargs["api_key"] \
        == SITE_KEY


# ---------------------------------------------------------------------------------------------------------------
# keystore unit tests
# ---------------------------------------------------------------------------------------------------------------
def test_validate_format_hint_and_master_key():
    assert keystore.validate_format(SITE_KEY) and keystore.validate_format("  " + SITE_KEY + "\n")
    assert keystore.validate_format("sk-ant-" + "a" * 20) and not keystore.validate_format("sk-ant-" + "a" * 19)
    assert keystore.validate_format("sk-ant-" + "a" * 200) and not keystore.validate_format("sk-ant-" + "a" * 201)
    for bad in (None, 123, "", "sk-ant-", "sk-ant-abc def ghi jkl mno pqr", "sk-ant-aaaaaaaaaaaaaaaaaaaa!", "sk-" + "a" * 30):
        assert not keystore.validate_format(bad)
    assert keystore.hint(SITE_KEY) == "…QRST" and keystore.hint("") is None and keystore.hint(None) is None
    assert keystore.master_key_configured(SimpleNamespace(lab_manager_master_key=Fernet.generate_key().decode()))
    for value in ("", "  ", "short", None):
        assert not keystore.master_key_configured(SimpleNamespace(lab_manager_master_key=value))
    view = keystore.with_key(SimpleNamespace(assistant_anthropic_api_key=SecretStr(ENV_KEY), x=1), None)
    assert view.assistant_key_source == "env" and view.x == 1 and ENV_KEY not in repr(view) + str(view)
    with pytest.raises(AttributeError):
        view.x = 2
    assert keystore.with_key(view, SITE_KEY).assistant_key_source == "site"
    assert keystore.with_key(SimpleNamespace(assistant_anthropic_api_key=SecretStr("  ")), "").assistant_key_source \
        == "none"


@pytest.mark.parametrize("error,expected", [
    (None, (True, keystore.REASON_OK)),
    (FakeAuthError("bad key"), (False, keystore.REASON_REJECTED)),
    (FakePermissionError("no access"), (False, keystore.REASON_NO_ACCESS)),
    (FakeConnectionError("connection refused"), (False, keystore.REASON_UNREACHABLE)),
    (FakeTimeoutError("timed out"), (False, keystore.REASON_UNREACHABLE)),
    (OSError("network unreachable"), (False, keystore.REASON_UNREACHABLE)),
    (FakeRateLimitError("slow down"), (True, keystore.REASON_RATE_LIMITED)),
    (FakeStatusError("server error", status_code=500), (False, keystore.REASON_API_ERROR)),
    (ValueError("something odd"), (False, keystore.REASON_API_ERROR)),
])
async def test_test_key_maps_results_to_fixed_reasons(monkeypatch, error, expected):
    sdk = FakeSDK()
    sdk.list_error = error
    monkeypatch.setattr(keystore, "load_sdk", lambda: sdk)
    assert await keystore.test_key(SITE_KEY) == expected
    assert sdk.keys == [SITE_KEY] and sdk.clients[0].closed and sdk.clients[0].list_calls == [{"limit": 1}]


async def test_test_key_times_out_and_reports_a_missing_sdk(monkeypatch):
    sdk = FakeSDK()
    sdk.list_delay = 5.0
    monkeypatch.setattr(keystore, "load_sdk", lambda: sdk)
    monkeypatch.setattr(keystore, "TEST_TIMEOUT_SECONDS", 0.05)
    assert await keystore.test_key(SITE_KEY) == (False, keystore.REASON_UNREACHABLE)
    monkeypatch.setattr(keystore, "load_sdk", lambda: None)
    assert await keystore.test_key(SITE_KEY) == (False, keystore.REASON_NO_SDK)


def test_classify_with_the_installed_sdk_exception_classes():
    """The real `anthropic` exception classes (constructed locally; nothing is sent)."""
    anthropic = pytest.importorskip("anthropic")
    try:
        import httpx2 as http   # the HTTP library this SDK version builds on
    except ImportError:
        import httpx as http
    request = http.Request("GET", "https://api.anthropic.com/v1/models")

    def status_error(cls, code):
        return cls("error", response=http.Response(code, request=request), body=None)

    assert keystore.classify(anthropic, status_error(anthropic.AuthenticationError, 401)) == (False, keystore.REASON_REJECTED)
    assert keystore.classify(anthropic, status_error(anthropic.PermissionDeniedError, 403)) == \
        (False, keystore.REASON_NO_ACCESS)
    assert keystore.classify(anthropic, status_error(anthropic.RateLimitError, 429)) == \
        (True, keystore.REASON_RATE_LIMITED)
    assert keystore.classify(anthropic, status_error(anthropic.InternalServerError, 500)) == \
        (False, keystore.REASON_API_ERROR)
    assert keystore.classify(anthropic, anthropic.APIConnectionError(request=request)) == \
        (False, keystore.REASON_UNREACHABLE)
    assert keystore.classify(anthropic, anthropic.APITimeoutError(request=request)) == \
        (False, keystore.REASON_UNREACHABLE)
    # The smallest authenticated call exists on the installed async client (constructing it sends nothing).
    sdk_client = anthropic.AsyncAnthropic(api_key=SITE_KEY, base_url=keystore.API_BASE_URL, max_retries=0)
    assert callable(sdk_client.models.list)


async def test_store_counts_revisions_and_remove_reports_absence(env):
    async with env.sessions() as db:
        first = await keystore.store(db, SITE_KEY, "admin")
        second = await keystore.store(db, SITE_KEY_2, "admin2")
        assert (first["revision"], second["revision"]) == (1, 2)
        assert await db.scalar(select(func.count()).select_from(AssistantSetting)) == 1
        info = await keystore.info(db)
        assert info == {"hint": "…" + SITE_KEY_2[-4:], "set_by": "admin2", "set_at": second["set_at"], "revision": 2,
                        "readable": True}
        assert await keystore.remove(db) is True and await keystore.remove(db) is False
        assert await keystore.info(db) is None and await keystore.load(db) is None
