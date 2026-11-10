"""The automatic webpe lookup's heartbeat: the laptop tool (tools/webpe-sync/sync.cjs --watch) reports after every check
(PUT, Operator and up, with the CSRF header) and the site reads whether it runs (GET, Viewer and up)."""
from datetime import datetime, timedelta, timezone
import json
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, inventory_store as store
from app.database import Base
from app.models import User
from app.routers import serial_details
from tests.test_inventory import inventory_client  # noqa: F401  (fixture)

URL = "/api/inventory/webpe-status"
REPORT = {"last_check": "2026-11-09T10:05:00.000Z", "last_lookup": "2026-11-09T10:04:58Z", "looked_up_today": 3, "pending": 1,
          "last_error": None, "version": "webpe-sync 2.0", "interval": 20}


async def test_no_report_yet_reads_as_not_running(inventory_client):
    response = await inventory_client.get(URL)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["active"] is False and body["last_check"] is None and body["seen_at"] is None
    assert body["interval"] == 20 and body["looked_up_today"] is None


async def test_a_report_is_stored_and_read_back_as_active(inventory_client):
    put = await inventory_client.put(URL, json=REPORT)
    assert put.status_code == 200, put.text
    body = (await inventory_client.get(URL)).json()
    assert body["active"] is True
    assert body["last_check"] == "2026-11-09T10:05:00Z" and body["last_lookup"] == "2026-11-09T10:04:58Z"
    assert (body["looked_up_today"], body["pending"], body["last_error"], body["version"], body["interval"]) == (3, 1, None, "webpe-sync 2.0", 20)
    seen = datetime.fromisoformat(body["seen_at"].replace("Z", "+00:00"))
    assert abs((datetime.now(timezone.utc) - seen).total_seconds()) < 30
    # Stored next to the inventory, atomically (no temporary file is left behind); the inventory itself is untouched.
    path = store.ITEMS_FILE.parent / "webpe_status.json"
    assert json.loads(path.read_text(encoding="utf-8"))["looked_up_today"] == 3
    assert not list(path.parent.glob(".webpe-status-*"))
    assert "webpe" not in store.ITEMS_FILE.read_text(encoding="utf-8")


async def test_a_sign_in_problem_is_reported(inventory_client):
    put = await inventory_client.put(URL, json={**REPORT, "last_error": "webpe sign-in needed: sign in to webpe in the lab Edge window"})
    assert put.status_code == 200
    assert (await inventory_client.get(URL)).json()["last_error"].startswith("webpe sign-in needed")


def test_active_means_a_report_within_three_intervals():
    now = datetime(2026, 11, 9, 10, 0, tzinfo=timezone.utc)
    seen = lambda seconds: {"seen_at": (now - timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z"), "interval": 20}
    assert serial_details.webpe_status_view(seen(59), now)["active"] is True
    assert serial_details.webpe_status_view(seen(61), now)["active"] is False
    assert serial_details.webpe_status_view({**seen(100), "interval": 60}, now)["active"] is True
    # A broken or hand-edited file never breaks the read.
    assert serial_details.webpe_status_view({"seen_at": "yesterday", "interval": "x"}, now) == {
        **{field: None for field in serial_details.WEBPE_STATUS_FIELDS}, "seen_at": "yesterday", "interval": 20, "active": False}
    assert serial_details.webpe_status_view({"seen_at": "2026-11-09T09:59:30"}, now)["active"] is False


async def test_an_unreadable_status_file_reads_as_no_report(inventory_client):
    (store.ITEMS_FILE.parent / "webpe_status.json").write_text("{not json", encoding="utf-8")
    response = await inventory_client.get(URL)
    assert response.status_code == 200 and response.json()["active"] is False


@pytest.mark.parametrize("change", [
    {"looked_up_today": -1}, {"pending": 10_000_000}, {"interval": 0}, {"interval": 3601}, {"looked_up_today": "many"},
    {"last_error": "x" * 201}, {"last_error": "line\nbreak"}, {"version": "v" * 41}, {"last_check": "not a time"},
    {"token": "secret"},
])
async def test_wrong_sizes_and_types_are_refused(inventory_client, change):
    response = await inventory_client.put(URL, json={**REPORT, **change})
    assert response.status_code == 422
    assert not (store.ITEMS_FILE.parent / "webpe_status.json").exists()


PASSWORD = "test-password-123"


@pytest.fixture
async def accounts_app(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'users.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(store, "ITEMS_FILE", tmp_path / "rack_items.json")
    await accounts.bootstrap_admin()
    async with sessions() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role, password_hash=accounts.hash_password(PASSWORD), created_at=time.time()))
        await db.commit()
    from app.main import validation_error
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(serial_details.router)
    yield app
    await engine.dispose()


async def signed_in(app, username):
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    response = await client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert response.status_code == 200
    return client, response.json()["csrf_token"]


async def test_roles_and_csrf(accounts_app):
    anonymous = AsyncClient(transport=ASGITransport(app=accounts_app), base_url="http://test")
    assert (await anonymous.get(URL)).status_code == 401
    assert (await anonymous.put(URL, json=REPORT)).status_code == 401

    viewer, viewer_csrf = await signed_in(accounts_app, "viewer")
    assert (await viewer.get(URL)).status_code == 200
    assert (await viewer.put(URL, json=REPORT, headers={"X-DCIM-CSRF": viewer_csrf})).status_code == 403

    operator, csrf = await signed_in(accounts_app, "operator")
    assert (await operator.put(URL, json=REPORT)).status_code == 403   # no CSRF header
    assert (await operator.put(URL, json=REPORT, headers={"X-DCIM-CSRF": "wrong"})).status_code == 403
    assert not (store.ITEMS_FILE.parent / "webpe_status.json").exists()
    saved = await operator.put(URL, json=REPORT, headers={"X-DCIM-CSRF": csrf})
    assert saved.status_code == 200 and saved.json()["active"] is True
    assert (await viewer.get(URL)).json()["looked_up_today"] == 3
    for client in (anonymous, viewer, operator):
        await client.aclose()
