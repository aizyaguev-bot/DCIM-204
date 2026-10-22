"""PUT /api/rack-layout: the Twin's server move writes rack_slots, rack_positions and rack_overrides all or nothing."""
import json
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from app import inventory_store
from app.database import get_db

FILES = {"rack_slots": "_RACK_SLOTS_FILE", "rack_positions": "_RACK_POSITIONS_FILE", "rack_overrides": "_RACK_OVERRIDES_FILE"}
URLS = {"rack_slots": "/api/rack-slots", "rack_positions": "/api/rack-positions", "rack_overrides": "/api/rack-overrides"}
BEFORE = {"rack_slots": {"Rack-01": {"opt11": 1, "opt12": 2}},
          "rack_positions": {"Rack-01": ["opt11", "opt12"]},
          "rack_overrides": {"opt99": "Rack-03"}}
# OPT11 moves to Rack-02 U4; OPT12 stays at U2 (pinned)
AFTER = {"rack_slots": {"Rack-01": {"opt12": 2}, "Rack-02": {"opt11": 4}},
         "rack_positions": {"Rack-01": ["opt12"], "Rack-02": ["opt11"]},
         "rack_overrides": {"opt99": "Rack-03", "opt11": "Rack-02"}}


@pytest.fixture
async def layout(db_session, tmp_path, monkeypatch):
    import app.main as main
    for attr in FILES.values():
        monkeypatch.setattr(main, attr, tmp_path / getattr(main, attr).name)
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(accounts_enabled=False, lab_manager_password=""))

    async def override():
        yield db_session
    main.app.dependency_overrides[get_db] = override
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        yield client, tmp_path
    main.app.dependency_overrides.clear()


def path_of(name):
    import app.main as main
    return getattr(main, FILES[name])


def seed():
    for name, data in BEFORE.items():
        path_of(name).write_text(json.dumps(data))
    return {name: path_of(name).read_bytes() for name in FILES}


async def etags(client):
    return {name: (await client.get(url)).headers["etag"] for name, url in URLS.items()}


def body(tags, data=AFTER, order=("rack_overrides", "rack_slots", "rack_positions")):
    return {name: {"data": data[name], "if_match": tags[name]} for name in order}


async def test_all_three_stores_are_saved_and_return_their_new_etags(layout):
    client, folder = layout
    seed()
    r = await client.put("/api/rack-layout", json=body(await etags(client)))
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "revisions": {name: inventory_store.revision(AFTER[name]) for name in AFTER}}
    for name, url in URLS.items():
        assert json.loads(path_of(name).read_text()) == AFTER[name]
        assert (await client.get(url)).headers["etag"] == r.json()["revisions"][name]
    assert not list(folder.glob("*.tmp"))


async def test_one_stale_revision_is_409_and_nothing_is_written(layout):
    client, _ = layout
    seed()
    tags = await etags(client)
    path_of("rack_positions").write_text(json.dumps({"Rack-01": ["opt12", "opt11"]}))   # another session reordered
    before = {name: path_of(name).read_bytes() for name in FILES}
    r = await client.put("/api/rack-layout", json=body(tags))
    assert r.status_code == 409 and r.json() == {"detail": inventory_store.LAYOUT_CONFLICT}
    assert {name: path_of(name).read_bytes() for name in FILES} == before


async def test_a_missing_revision_or_unknown_store_is_refused_before_any_write(layout):
    client, _ = layout
    before = seed()
    tags = await etags(client)
    no_tag = body(tags)
    no_tag["rack_slots"].pop("if_match")
    assert (await client.put("/api/rack-layout", json=no_tag)).status_code == 422
    assert (await client.put("/api/rack-layout", json={**body(tags), "switch_assignments": {"data": {}, "if_match": tags["rack_slots"]}})).status_code == 422
    assert (await client.put("/api/rack-layout", json={})).status_code == 422
    assert {name: path_of(name).read_bytes() for name in FILES} == before


async def test_a_failure_on_the_second_file_restores_the_first(layout, monkeypatch):
    client, folder = layout
    before = seed()
    path_of("rack_positions").unlink()   # a store that did not exist yet must not exist afterwards either
    before["rack_positions"] = None
    tags = await etags(client)
    real_write = inventory_store.write_json
    calls = []

    def failing_second_write(path, data, *args, **kwargs):
        calls.append(path.name)
        if len(calls) == 2:
            raise OSError("disk full")
        return real_write(path, data, *args, **kwargs)
    monkeypatch.setattr(inventory_store, "write_json", failing_second_write)
    r = await client.put("/api/rack-layout", json=body(tags, order=("rack_positions", "rack_slots", "rack_overrides")))
    assert r.status_code == 503 and r.json()["detail"] == inventory_store.LAYOUT_SAVE_FAILED
    assert calls == [path_of("rack_positions").name, path_of("rack_slots").name]
    assert not path_of("rack_positions").exists(), "the first store (new file) was removed again"
    assert path_of("rack_slots").read_bytes() == before["rack_slots"]
    assert path_of("rack_overrides").read_bytes() == before["rack_overrides"]
    assert not list(folder.glob("*.tmp"))


async def test_a_file_that_cannot_be_put_back_is_named(layout, monkeypatch):
    client, _ = layout
    seed()
    tags = await etags(client)
    real_write = inventory_store.write_json
    calls = []

    def failing_second_write(path, data, *args, **kwargs):
        calls.append(path.name)
        if len(calls) == 2:
            raise OSError("disk full")
        return real_write(path, data, *args, **kwargs)

    def broken_put_back(path, raw):
        raise OSError("read-only")
    monkeypatch.setattr(inventory_store, "write_json", failing_second_write)
    monkeypatch.setattr(inventory_store, "_put_back", broken_put_back)
    r = await client.put("/api/rack-layout", json=body(tags))
    assert r.status_code == 503
    assert r.json()["detail"] == inventory_store.LAYOUT_NOT_RESTORED.format(files="rack_overrides")
