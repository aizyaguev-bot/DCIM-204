"""Layout stores: optional ETag / If-Match, atomic writes, 503 on a failed write, and the rename cascade."""
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from app import inventory_store
from app.database import get_db
from app.models import Device

STORES = {
    "/api/rack-positions": ("_RACK_POSITIONS_FILE", {}),
    "/api/rack-slots": ("_RACK_SLOTS_FILE", {}),
    "/api/switch-assignments": ("_SWITCH_ASSIGN_FILE", {}),
    "/api/rack-overrides": ("_RACK_OVERRIDES_FILE", {}),
    "/api/chillers": ("_CHILLERS_FILE", {"units": [], "connections": []}),
    "/api/twin-data": ("_TWIN_DATA_FILE", {}),
}
CONFLICT = "This layout was changed in another session. Reload and try again."
SAVED = {"Rack-01": {"opt11": 2}, "units": [{"id": "ch1", "rack": "Rack-01"}]}


@pytest.fixture
async def layout(db_session, tmp_path, monkeypatch):
    import app.main as main
    from app.routers import devices
    for attr, _ in STORES.values():
        monkeypatch.setattr(main, attr, tmp_path / getattr(main, attr).name)
    monkeypatch.setattr(main, "_OPT_OWNERS_FILE", tmp_path / "opt_owners.json")
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(accounts_enabled=False, lab_manager_password=""))

    async def override():
        yield db_session
    main.app.dependency_overrides[get_db] = override
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        yield client, tmp_path
    main.app.dependency_overrides.clear()


def store_file(url):
    import app.main as main
    return getattr(main, STORES[url][0])


@pytest.mark.parametrize("url", STORES)
async def test_get_adds_etag_and_no_store_and_keeps_the_body(layout, url):
    client, _ = layout
    empty = STORES[url][1]
    r = await client.get(url)
    assert r.status_code == 200 and r.json() == empty
    assert r.headers["etag"] == inventory_store.revision(empty)
    assert r.headers["cache-control"] == "no-store"
    store_file(url).write_text(json.dumps(SAVED))
    r = await client.get(url)
    assert r.json() == SAVED and r.headers["etag"] == inventory_store.revision(SAVED)


@pytest.mark.parametrize("url", STORES)
async def test_put_with_the_current_etag_saves_and_returns_the_new_one(layout, url):
    client, folder = layout
    store_file(url).write_text(json.dumps(SAVED))
    etag = (await client.get(url)).headers["etag"]
    body = {"Rack-02": {"opt12": 3}}
    r = await client.put(url, json=body, headers={"If-Match": etag})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert r.headers["etag"] == inventory_store.revision(body)
    assert json.loads(store_file(url).read_text()) == body
    assert (await client.get(url)).headers["etag"] == r.headers["etag"]
    # Any lock, temporary or history file stays next to its store (the preview fixture redirects stores to a temp folder).
    beside = {store_file(url).name, store_file(url).with_suffix(".lock").name, inventory_store.history_path(store_file(url)).name}
    assert {p.name for p in folder.iterdir()} <= beside


@pytest.mark.parametrize("url", STORES)
async def test_put_with_a_stale_etag_is_409_and_leaves_the_file_untouched(layout, url):
    client, _ = layout
    stale = (await client.get(url)).headers["etag"]
    store_file(url).write_text(json.dumps(SAVED))
    before = store_file(url).read_bytes()
    r = await client.put(url, json={"Rack-01": {}}, headers={"If-Match": stale})
    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    assert store_file(url).read_bytes() == before


@pytest.mark.parametrize("url", STORES)
async def test_put_without_if_match_still_saves_for_old_pages(layout, url):
    client, _ = layout
    store_file(url).write_text(json.dumps(SAVED))
    body = {"Rack-03": ["opt31"]}
    r = await client.put(url, json=body)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert r.headers["etag"] == inventory_store.revision(body)
    assert json.loads(store_file(url).read_text()) == body


@pytest.mark.parametrize("url", STORES)
async def test_a_failed_write_is_503_never_ok(layout, url):
    client, folder = layout
    store_file(url).mkdir()  # the store path is a folder, so the file cannot be replaced
    r = await client.put(url, json={"Rack-01": {}})
    assert r.status_code == 503 and r.json()["detail"]
    assert not list(folder.glob("*.tmp"))


async def test_writes_replace_the_file_from_a_temporary_file_in_the_same_folder(layout, monkeypatch):
    client, folder = layout
    replaced = []
    real_replace = os.replace

    def recording_replace(src, dst):
        replaced.append((Path(src), Path(dst)))
        return real_replace(src, dst)
    monkeypatch.setattr(inventory_store.os, "replace", recording_replace)
    r = await client.put("/api/rack-slots", json={"Rack-01": {"opt11": 4}})
    assert r.status_code == 200
    target = store_file("/api/rack-slots")
    assert len(replaced) == 1 and replaced[0][1] == target and replaced[0][0].parent == folder
    assert replaced[0][0] != target and not replaced[0][0].exists()


async def test_rename_cascade_renames_rack_override_keys_and_invalidates_stale_pages(layout, db_session):
    client, folder = layout
    db_session.add(Device(id="pdu1", name="PDU 01", kind="pdu", ip="192.0.2.1", rack="Rack-01",
                          labels_json=json.dumps({"1": "OPT11"})))
    await db_session.commit()
    (folder / "rack_overrides.json").write_text(json.dumps({"opt11": "Rack-02", "opt12": "Rack-03"}))
    (folder / "rack_slots.json").write_text(json.dumps({"Rack-02": {"opt11": 4}}))
    stale = (await client.get("/api/rack-overrides")).headers["etag"]

    r = await client.post("/api/devices/rename-opt", json={"old_name": "OPT11", "new_name": "OPT19"})
    assert r.status_code == 200, r.text
    assert json.loads((folder / "rack_overrides.json").read_text()) == {"opt19": "Rack-02", "opt12": "Rack-03"}
    assert json.loads((folder / "rack_slots.json").read_text()) == {"Rack-02": {"opt19": 4}}
    # A page that loaded the overrides before the rename reloads instead of restoring the old key.
    r = await client.put("/api/rack-overrides", json={"opt11": "Rack-02", "opt12": "Rack-03"}, headers={"If-Match": stale})
    assert r.status_code == 409

    # Editing one port label is not a rename: rack positions stay with the server they belong to (v2.39.1).
    r = await client.patch("/api/devices/pdu1/labels", json={"1": "OPT20"})
    assert r.status_code == 200, r.text
    assert r.json()["synced"] == []
    assert json.loads((folder / "rack_overrides.json").read_text()) == {"opt19": "Rack-02", "opt12": "Rack-03"}
    assert json.loads((folder / "rack_slots.json").read_text()) == {"Rack-02": {"opt19": 4}}
    assert not list(folder.glob("*.tmp"))
