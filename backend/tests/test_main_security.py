"""Legacy shared-password mode: Basic-auth failure limit, validation errors without submitted values, and shutdown."""
import asyncio
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient, BasicAuth
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import confirm
from app.database import Base, get_db
from app.models import AuthThrottle

PASSWORD = "shared-lab-secret-91c2"
SECRET = "synthetic-secret-7f3a"
RIGHT = BasicAuth("lab", PASSWORD)
WRONG = BasicAuth("lab", "wrong-" + SECRET)


@pytest.fixture
async def legacy(tmp_path, monkeypatch):
    import app.main as main
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(main, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(accounts_enabled=False, lab_manager_password=PASSWORD))
    monkeypatch.setattr(main, "_VERSION_FILE", tmp_path / "version.txt")
    monkeypatch.setattr(main, "_basic_failures", {}, raising=False)
    monkeypatch.setattr(main, "_basic_lock", asyncio.Lock(), raising=False)

    async def override():
        async with sessions() as db:
            yield db
    main.app.dependency_overrides[get_db] = override
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            yield client, sessions
    finally:
        main.app.dependency_overrides.clear()
        await engine.dispose()


async def test_wrong_basic_passwords_are_limited_per_client_address(legacy):
    import app.main as main
    client, _ = legacy
    for _ in range(confirm.FAILURE_LIMIT):
        assert (await client.get("/api/devices/", auth=WRONG)).status_code == 401
    r = await client.get("/api/devices/", auth=WRONG)
    assert r.status_code == 429 and r.headers["retry-after"] == "300"
    # Past the limit the right password waits too, so a guess gives no signal.
    r = await client.get("/api/devices/", auth=RIGHT)
    assert r.status_code == 429
    assert SECRET not in r.text and PASSWORD not in r.text
    # Public reads and the sign-in status stay available.
    assert (await client.get("/api/version")).status_code == 200
    assert (await client.get("/api/auth/status")).status_code == 200
    other = AsyncClient(transport=ASGITransport(app=main.app, client=("192.0.2.77", 5000)), base_url="http://test")
    async with other:
        assert (await other.get("/api/devices/", auth=RIGHT)).status_code == 200


async def test_right_passwords_do_not_count_toward_the_limit(legacy):
    client, _ = legacy
    for _ in range(confirm.FAILURE_LIMIT - 1):
        assert (await client.get("/api/devices/", auth=WRONG)).status_code == 401
    for _ in range(5):
        assert (await client.get("/api/devices/", auth=RIGHT)).status_code == 200
    assert (await client.get("/api/devices/", auth=WRONG)).status_code == 401
    assert (await client.get("/api/devices/", auth=WRONG)).status_code == 429


async def test_concurrent_right_passwords_after_nine_failures_get_through(legacy):
    client, _ = legacy
    for _ in range(confirm.FAILURE_LIMIT - 1):
        await client.get("/api/devices/", auth=WRONG)
    results = await asyncio.gather(*(client.get("/api/devices/", auth=RIGHT) for _ in range(5)))
    assert [r.status_code for r in results] == [200] * 5


async def test_requests_without_credentials_are_not_counted(legacy):
    client, _ = legacy
    for _ in range(confirm.FAILURE_LIMIT + 2):
        r = await client.get("/api/devices/")
        assert r.status_code == 401 and r.headers["www-authenticate"]
    assert (await client.get("/api/devices/", auth=RIGHT)).status_code == 200


async def test_the_limit_lifts_after_the_window(legacy):
    client, sessions = legacy
    for _ in range(confirm.FAILURE_LIMIT + 1):
        await client.get("/api/devices/", auth=WRONG)
    assert (await client.get("/api/devices/", auth=RIGHT)).status_code == 429
    async with sessions() as db:
        await db.execute(update(AuthThrottle).values(window_at=AuthThrottle.window_at - confirm.FAILURE_WINDOW - 1))
        await db.commit()
    assert (await client.get("/api/devices/", auth=RIGHT)).status_code == 200


async def test_validation_errors_never_echo_submitted_values(legacy):
    client, _ = legacy
    r = await client.post("/api/auth/login", json={"username": "admin", "password": SECRET * 20}, auth=RIGHT)
    assert r.status_code == 422
    assert SECRET not in r.text
    assert r.json()["detail"] and all(set(e) == {"loc", "msg", "type"} for e in r.json()["detail"])
    r = await client.post("/api/devices/", json={"name": SECRET, "kind": "pdu"}, auth=RIGHT)
    assert r.status_code == 422 and SECRET not in r.text
    assert r.json()["detail"] == [{"loc": ["body", "ip"], "msg": "Field required", "type": "missing"}]


async def test_validator_messages_are_shown_without_the_pydantic_prefix(legacy):
    client, _ = legacy
    r = await client.post("/api/auth/register", json={"username": "Bad User", "name": "Bad", "password": SECRET}, auth=RIGHT)
    assert r.status_code == 422 and SECRET not in r.text
    assert r.json()["detail"] == [{"loc": ["body", "username"], "type": "value_error",
                                   "msg": "Use 3–32 letters, digits, dots, dashes or underscores"}]


def test_only_value_error_messages_lose_the_prefix():
    import app.main as main
    error = {"loc": ("body", "name"), "msg": "Value error, Enter a device name.", "type": "value_error",
             "input": SECRET, "ctx": {"error": ValueError(SECRET)}, "url": "https://errors.pydantic.dev"}
    assert main._validation_item(error) == {"loc": ("body", "name"), "msg": "Enter a device name.", "type": "value_error"}
    assert main._validation_item({"loc": ("body",), "msg": "Value error, kept", "type": "assertion_error"})["msg"] == "Value error, kept"
    assert main._validation_item({"loc": ("body",), "msg": "Plain message", "type": "value_error"})["msg"] == "Plain message"


async def test_shutdown_closes_the_pxe_job_runner(monkeypatch):
    import app.main as main
    from app import engineers
    from app.routers import pxe

    async def nothing(*args, **kwargs):
        return None

    async def forever():
        await asyncio.Event().wait()
    for name in ("init_db", "bootstrap_admin", "_warm_cache"):
        monkeypatch.setattr(main, name, nothing)
    monkeypatch.setattr(main, "monitor_loop", forever)
    monkeypatch.setattr(main, "alert_loop", forever)
    monkeypatch.setattr(engineers, "bootstrap_engineers", nothing)
    closed = []

    class Runner:
        async def aclose(self):
            closed.append(True)
    monkeypatch.setattr(pxe, "_runner", Runner())
    async with main.lifespan(main.app):
        assert closed == []
    assert closed == [True]
    monkeypatch.setattr(pxe, "_runner", None)  # no PXE request since start: nothing to close
    async with main.lifespan(main.app):
        pass
