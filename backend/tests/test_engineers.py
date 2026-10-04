"""Directory, owner preservation and real role/CSRF checks on isolated data."""
import json
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Depends
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, engineers
from app.database import Base, get_db
from app.models import AssetOwner, Engineer, User


@pytest.fixture
async def directory(tmp_path, monkeypatch):
    import app.main as main
    saved = tmp_path / "opt_owners.json"
    saved.write_text(json.dumps({"opt11":"Roy Mendelson", "opt12":"Existing unknown owner"}))
    monkeypatch.setattr(main, "_OPT_OWNERS_FILE", saved)
    from app import inventory_store
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'directory.db'}")
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(engineers, "AsyncSessionLocal", factory)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", factory)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False,
        accounts_admin_username="admin", accounts_session_hours=12, accounts_secure_cookie=False,
        lab_manager_password="test-password-123")
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    await accounts.bootstrap_admin()
    await engineers.bootstrap_engineers()
    async with factory() as db:
        for role in ["Viewer", "Operator"]:
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role,
                password_hash=accounts.hash_password(settings.lab_manager_password), created_at=time.time()))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(engineers.router)
    async def dependency():
        async with factory() as db: yield db
    app.dependency_overrides[get_db] = dependency
    @app.get("/api/opt-owners")
    async def owners(db=Depends(get_db)): return await engineers.owner_map(db)
    yield SimpleNamespace(app=app, factory=factory, saved=saved)
    await engine.dispose()


async def login(c, role="admin"):
    r = await c.post("/api/auth/login", json={"username":role,"password":"test-password-123"})
    assert r.status_code == 200
    c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]


def client(d): return AsyncClient(transport=ASGITransport(app=d.app),base_url="http://test")


async def test_seed_idempotent_and_preserves_unknown_legacy_owner(directory):
    before = directory.saved.read_bytes()
    await engineers.bootstrap_engineers()
    async with directory.factory() as db:
        people = (await db.execute(select(Engineer))).scalars().all()
        assert {p.name for p in people} == set(engineers.INITIAL_NAMES)
        assert len(people) == 10
        assert await engineers.owner_map(db) == {"opt11":"Roy Mendelson", "opt12":"Existing unknown owner"}
    assert directory.saved.read_bytes() == before


async def test_assign_rename_disable_and_unassign_do_not_erase_other_owners(directory):
    async with client(directory) as c:
        await login(c)
        roy = next(p for p in (await c.get("/api/engineers")).json() if p["name"] == "Roy Mendelson")
        r = await c.put("/api/opt-owners/item:custom",json={"engineer_id":roy["id"]})
        assert r.status_code == 200 and r.json()["opt12"] == "Existing unknown owner"
        r = await c.put(f"/api/engineers/{roy['id']}",json={"name":"Roy Updated","active":False})
        assert r.status_code == 200
        owners = (await c.get("/api/opt-owners")).json()
        assert owners["opt11"] == owners["item:custom"] == "Roy Updated"
        assert (await c.put("/api/opt-owners/opt13",json={"engineer_id":roy["id"]})).status_code == 409
        assert (await c.put("/api/opt-owners/opt11",json={"engineer_id":None})).status_code == 200
        assert "opt11" not in (await c.get("/api/opt-owners")).json()
        await engineers.bootstrap_engineers()
        assert "opt11" not in (await c.get("/api/opt-owners")).json()
        assert json.loads(directory.saved.read_text())["opt11"] == "Roy Mendelson"


@pytest.mark.parametrize("role,assignment,manage",[("viewer",403,403),("operator",200,403),("admin",200,201)])
async def test_engineer_roles_and_csrf(directory, role, assignment, manage):
    async with client(directory) as c:
        assert (await c.get("/api/engineers")).status_code == 401
        await login(c,role)
        p = (await c.get("/api/engineers")).json()[0]
        assert (await c.put("/api/opt-owners/opt13",json={"engineer_id":p["id"]})).status_code == assignment
        assert (await c.post("/api/engineers",json={"name":"New Engineer"})).status_code == manage
        if role == "admin":
            c.headers.pop("X-DCIM-CSRF")
            assert (await c.post("/api/engineers",json={"name":"Forged"})).status_code == 403


async def test_directory_duplicates_validation_and_corrupt_legacy_data(directory):
    async with client(directory) as c:
        await login(c)
        assert (await c.post("/api/engineers",json={"name":"  roy   MENDELSON "})).status_code == 409
        assert (await c.post("/api/engineers",json={"name":"  "})).status_code == 422
        assert (await c.put("/api/opt-owners/opt11",json={"engineer_id":"unknown"})).status_code == 409
        directory.saved.write_text("invalid JSON")
        assert (await c.get("/api/opt-owners")).status_code == 503
        assert directory.saved.read_text() == "invalid JSON"
