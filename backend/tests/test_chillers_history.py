"""Cooling units (chillers.json): every save keeps the document it replaces, a version can be restored, nothing is lost."""
import json
import time
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, inventory_store
from app.database import Base
from app.models import User

CONFLICT = "This layout was changed in another session. Reload and try again."
RACK04 = [{"id": "ch-Rack-04-1", "name": "Chiller-1", "rack": "Rack-04", "u": 3, "model": "CW-7"},
          {"id": "ch-Rack-04-2", "name": "Chiller-2", "rack": "Rack-04", "u": 3}]
OTHER = [{"id": "ch-Rack-05-1", "name": "Chiller-1", "rack": "Rack-05", "u": None},
         {"id": "ch-spare", "name": "Spare", "rack": None, "u": None}]
CONNECTIONS = [{"from": "ch-Rack-04-1", "to": "Rack-04", "legacy": True}]
DOC = {"units": RACK04 + OTHER, "connections": CONNECTIONS, "note": "kept"}


def doc(units):
    return {**DOC, "units": units}


@pytest.fixture
async def chillers(tmp_path, monkeypatch):
    import app.main as main
    monkeypatch.setattr(main, "_CHILLERS_FILE", tmp_path / "chillers.json")
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(accounts_enabled=False, lab_manager_password=""))
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        yield SimpleNamespace(client=client, file=tmp_path / "chillers.json", history=tmp_path / "chillers_history.json",
                              folder=tmp_path)


async def etag(client):
    return (await client.get("/api/chillers")).headers["etag"]


async def put(client, body, tag=None):
    return await client.put("/api/chillers", json=body, headers={"If-Match": tag} if tag else {})


async def history(client):
    r = await client.get("/api/chillers/history")
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    return r.json()["versions"]


async def test_a_save_keeps_the_document_it_replaces_newest_first(chillers):
    c = chillers.client
    chillers.file.write_text(json.dumps(DOC))
    assert await history(c) == []
    moved = doc([{**RACK04[0], "rack": "Rack-05", "u": 2}, RACK04[1], *OTHER])
    r = await put(c, moved, await etag(c))
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert r.headers["etag"] == inventory_store.revision(moved) == await etag(c)
    taken_off = doc([RACK04[0] | {"rack": "Rack-05", "u": None}, RACK04[1], *OTHER])
    assert (await put(c, taken_off, await etag(c))).status_code == 200

    versions = await history(c)
    assert [v["revision"] for v in versions] == [2, 1]
    assert [v["units"] for v in versions] == [4, 4]
    assert all(v["by"] is None and v["action"] == "save" and v["removed"] == [] and v["at"] for v in versions)
    assert all("document" not in v for v in versions)  # the list stays light; restore uses the stored document
    stored = json.loads(chillers.history.read_text())
    assert [v["document"] for v in stored["versions"]] == [DOC, moved]
    assert stored["last_revision"] == 2


async def test_a_save_that_drops_units_still_works_and_the_history_names_and_restores_them(chillers):
    c = chillers.client
    chillers.file.write_text(json.dumps(DOC))
    without = doc(OTHER)  # an old page sends the units without the two Rack-04 chillers
    r = await put(c, without, await etag(c))
    assert r.status_code == 200 and json.loads(chillers.file.read_text()) == without
    [version] = await history(c)
    assert version["revision"] == 1 and version["units"] == 4
    assert version["removed"] == [{"id": "ch-Rack-04-1", "name": "Chiller-1", "rack": "Rack-04", "u": 3},
                                  {"id": "ch-Rack-04-2", "name": "Chiller-2", "rack": "Rack-04", "u": 3}]

    current = await etag(c)
    r = await c.post("/api/chillers/restore", json={"revision": 1}, headers={"If-Match": current})
    assert r.status_code == 200, r.text
    assert r.json() == DOC  # extra unit fields, top-level keys and legacy connections come back verbatim
    assert r.headers["etag"] == inventory_store.revision(DOC) == await etag(c)
    assert json.loads(chillers.file.read_text()) == DOC

    # The restore is itself a version: the document it replaced can be brought back (undo the restore).
    versions = await history(c)
    assert [(v["revision"], v["action"], v.get("restored_from"), v["units"]) for v in versions] == [
        (2, "restore", 1, 2), (1, "save", None, 4)]
    assert versions[0]["removed"] == []
    r = await c.post("/api/chillers/restore", json={"revision": 2}, headers={"If-Match": r.headers["etag"]})
    assert r.status_code == 200 and r.json() == without


async def test_restore_needs_the_current_etag_and_a_known_revision_and_changes_nothing_otherwise(chillers):
    c = chillers.client
    chillers.file.write_text(json.dumps(DOC))
    stale = await etag(c)
    assert (await put(c, doc(OTHER), stale)).status_code == 200
    before = chillers.file.read_bytes(), chillers.history.read_bytes()

    r = await c.post("/api/chillers/restore", json={"revision": 1}, headers={"If-Match": stale})
    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    r = await c.post("/api/chillers/restore", json={"revision": 1})
    assert r.status_code == 428
    r = await c.post("/api/chillers/restore", json={"revision": 99}, headers={"If-Match": await etag(c)})
    assert r.status_code == 404 and "not in the history" in r.json()["detail"]
    for body in ({"revision": "1"}, {"revision": 0}, {"revision": True}, {}, {"revision": 1, "extra": 1}):
        r = await c.post("/api/chillers/restore", json=body, headers={"If-Match": await etag(c)})
        assert r.status_code == 422, body
    assert (chillers.file.read_bytes(), chillers.history.read_bytes()) == before


async def test_put_keeps_the_layout_store_contract(chillers):
    c = chillers.client
    chillers.file.write_text(json.dumps(DOC))
    stale = await etag(c)
    assert (await put(c, doc(RACK04), stale)).status_code == 200
    before = chillers.file.read_bytes(), chillers.history.read_bytes()
    r = await put(c, doc([]), stale)
    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    assert (chillers.file.read_bytes(), chillers.history.read_bytes()) == before
    # If-Match stays optional for old pages, and a save without it is kept in the history as well.
    r = await put(c, doc(OTHER))
    assert r.status_code == 200 and r.headers["etag"] == inventory_store.revision(doc(OTHER))
    assert [v["revision"] for v in await history(c)] == [2, 1]


async def test_saving_the_same_document_or_a_first_file_adds_no_version(chillers):
    c = chillers.client
    assert (await put(c, DOC, await etag(c))).status_code == 200  # no previous file: nothing to keep
    assert not chillers.history.exists()
    assert (await put(c, DOC, await etag(c))).status_code == 200  # unchanged document
    assert await history(c) == []


async def test_history_keeps_twenty_versions_and_keeps_removals_longest(chillers):
    c = chillers.client
    chillers.file.write_text(json.dumps(DOC))
    assert (await put(c, doc(OTHER))).status_code == 200  # version 1: the two Rack-04 units were removed
    for n in range(2, 27):  # 25 ordinary moves
        assert (await put(c, doc([{**OTHER[0], "u": n % 40 + 1}, OTHER[1]]))).status_code == 200
    versions = await history(c)
    assert len(versions) == inventory_store.VERSIONS_LIMIT == 20
    numbers = [v["revision"] for v in versions]
    assert numbers[:19] == list(range(26, 7, -1)) and numbers[19] == 1  # oldest plain versions went first
    assert versions[-1]["removed"] and versions[-1]["units"] == 4
    current = await etag(c)
    r = await c.post("/api/chillers/restore", json={"revision": 1}, headers={"If-Match": current})
    assert r.status_code == 200 and r.json() == DOC
    assert (await history(c))[0]["revision"] == 27  # numbers never repeat after pruning


def test_prune_drops_the_oldest_when_every_version_removed_units():
    versions = [{"revision": n, "removed": [{"id": f"u{n}"}]} for n in range(1, 23)]
    assert [v["revision"] for v in inventory_store._prune(versions)] == list(range(3, 23))


async def test_an_unreadable_chillers_file_is_never_overwritten(chillers):
    c = chillers.client
    chillers.file.write_text('{"units": [ broken')
    raw = chillers.file.read_bytes()
    r = await put(c, doc([]))
    assert r.status_code == 503 and "cannot be read" in r.json()["detail"]
    r = await c.post("/api/chillers/restore", json={"revision": 1}, headers={"If-Match": await etag(c)})
    assert r.status_code == 503
    assert chillers.file.read_bytes() == raw and not chillers.history.exists()
    assert not list(chillers.folder.glob("*.tmp"))


async def test_a_failed_store_write_puts_the_history_back(chillers, monkeypatch):
    c = chillers.client
    chillers.file.write_text(json.dumps(DOC))
    assert (await put(c, doc(OTHER))).status_code == 200
    before = chillers.file.read_bytes(), chillers.history.read_bytes()
    real = inventory_store.write_json

    def failing(path, data, *args, **kwargs):
        if path == chillers.file:
            raise OSError("disk full")
        return real(path, data, *args, **kwargs)
    monkeypatch.setattr(inventory_store, "write_json", failing)
    r = await put(c, doc(RACK04))
    assert r.status_code == 503 and r.json()["detail"]
    r = await c.post("/api/chillers/restore", json={"revision": 1}, headers={"If-Match": await etag(c)})
    assert r.status_code == 503
    assert (chillers.file.read_bytes(), chillers.history.read_bytes()) == before
    assert not list(chillers.folder.glob("*.tmp"))


async def test_a_damaged_history_is_set_aside_not_lost_and_saving_continues(chillers):
    c = chillers.client
    chillers.file.write_text(json.dumps(DOC))
    chillers.history.write_text("not json")
    r = await c.get("/api/chillers/history")
    assert r.status_code == 503
    assert (await put(c, doc(OTHER))).status_code == 200
    [aside] = chillers.folder.glob("chillers_history.unreadable-*.json")
    assert aside.read_text() == "not json"
    assert [(v["revision"], v["units"]) for v in await history(c)] == [(1, 4)]


# ─── accounts: Operator reads the history (it names users) and restores; the saving account is recorded ─────────────
PASSWORD = "test-password-123"


@pytest.fixture
async def signed(tmp_path, monkeypatch):
    import app.main as main
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'users.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "_CHILLERS_FILE", tmp_path / "chillers.json")
    password_hash = accounts.hash_password(PASSWORD)
    async with sessions() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role, password_hash=password_hash,
                        created_at=time.time()))
        await db.commit()

    async def client(username):
        c = AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test")
        r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert r.status_code == 200, r.text
        c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        return c
    (tmp_path / "chillers.json").write_text(json.dumps(DOC))
    yield client
    await engine.dispose()


async def test_operator_history_and_restore_record_the_username_viewer_is_refused(signed):
    viewer, operator = await signed("viewer"), await signed("operator")
    try:
        assert (await viewer.get("/api/chillers")).status_code == 200  # the document itself stays a Viewer read
        assert (await viewer.get("/api/chillers/history")).status_code == 403
        assert (await viewer.post("/api/chillers/restore", json={"revision": 1},
                                  headers={"If-Match": await etag(viewer)})).status_code == 403
        assert (await put(viewer, doc(OTHER))).status_code == 403

        assert (await put(operator, doc(OTHER), await etag(operator))).status_code == 200
        [version] = await history(operator)
        assert version["by"] == "operator" and version["units"] == 4
        r = await operator.post("/api/chillers/restore", json={"revision": 1}, headers={"If-Match": await etag(operator)})
        assert r.status_code == 200 and r.json() == DOC
        assert [(v["revision"], v["by"], v["action"]) for v in await history(operator)] == [
            (2, "operator", "restore"), (1, "operator", "save")]
    finally:
        await viewer.aclose()
        await operator.aclose()


@pytest.mark.parametrize("path,method,role", [
    ("/api/chillers/history", "GET", "Operator"), ("/api/chillers/history", "HEAD", "Operator"),
    ("/api/chillers/restore", "POST", "Operator"),
    ("/api/chillers", "GET", "Viewer"), ("/api/chillers", "PUT", "Operator"),
])
def test_cooling_history_roles(path, method, role):
    assert accounts.required_role(path, method) == role
