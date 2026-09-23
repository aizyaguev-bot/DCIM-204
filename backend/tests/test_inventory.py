"""Barcode and shelf changes must preserve existing equipment and detect stale writes."""
import asyncio
from copy import deepcopy
import json
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient, BasicAuth

from app import inventory_store as store
from app.database import get_db
from app.models import Device


@pytest.fixture
async def inventory_client(db_session, tmp_path, monkeypatch):
    import app.main as main
    monkeypatch.setattr(store, "ITEMS_FILE", tmp_path / "rack_items.json")
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(lab_manager_password="test-password"))
    store.ITEMS_FILE.write_text(json.dumps({
        "Rack-01": [{"id": "ci-existing", "name": "Switch A", "type": "switch", "serial_number": "MT00123", "u": 1, "notes": "Keep this note", "custom_field": {"keep": True}}],
        "Rack-02": [],
    }))
    db_session.add(Device(id="rack-3", name="Storage", kind="rack", ip="", rack="Rack-03"))
    await db_session.commit()

    async def override():
        yield db_session
    main.app.dependency_overrides[get_db] = override
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test", auth=BasicAuth("lab", "test-password")) as client:
        yield client
    main.app.dependency_overrides.clear()


async def headers(client):
    return {"If-Match": (await client.get("/api/inventory")).headers["etag"]}


async def test_serial_scan_is_read_only_and_exact(inventory_client):
    before = store.ITEMS_FILE.read_bytes()
    response = await inventory_client.get("/api/inventory", params={"code": " mt00123\r\n"})
    assert response.status_code == 200
    assert response.json()["matches"][0]["id"] == "ci-existing"
    assert response.json()["racks"] == ["Rack-01", "Rack-02", "Rack-03"]
    assert response.headers["cache-control"] == "no-store"
    partial = await inventory_client.get("/api/inventory", params={"code": "MT001"})
    assert partial.json()["matches"] == []
    assert store.ITEMS_FILE.read_bytes() == before


async def test_link_move_confirm_and_reload_preserve_identity(inventory_client):
    c = inventory_client
    linked = await c.post("/api/inventory/ci-existing/barcode", json={"code": "000023"}, headers=await headers(c))
    assert linked.status_code == 200
    assert linked.json()["serial_number"] == "MT00123"
    moved = await c.post("/api/inventory/ci-existing/location", json={"rack": "Rack-02", "u": 4, "position": "left / front"}, headers={"If-Match": linked.headers["etag"]})
    assert moved.status_code == 200
    item = moved.json()
    assert (item["id"], item["barcode"], item["serial_number"]) == ("ci-existing", "000023", "MT00123")
    assert item["custom_field"] == {"keep": True}
    assert item["notes"] == "Keep this note"
    assert item["tracking_history"][-1]["from"] == {"rack": "Rack-01", "u": 1, "position": ""}
    assert item["tracking_history"][-1]["to"] == {"rack": "Rack-02", "u": 4, "position": "left / front"}
    assert item["last_seen_at"]
    saved = (await c.get("/api/rack-items")).json()
    assert saved["Rack-01"] == []
    assert saved["Rack-02"][0]["id"] == "ci-existing"
    # Read afresh from disk, as a restarted server would.
    assert store.read_items() == saved
    confirmed = await c.post("/api/inventory/ci-existing/location", json={"rack": "Rack-02", "u": 4, "position": "left / front"}, headers=await headers(c))
    assert confirmed.json()["tracking_history"][-1]["action"] == "confirmed"
    assert len((await c.get("/api/inventory", params={"code": "000023"})).json()["matches"]) == 1


async def test_register_and_reject_duplicate_codes(inventory_client):
    c = inventory_client
    body = {"code": "000099", "name": "New switch", "type": "switch", "rack": "Rack-03", "u": 2, "position": "Right"}
    created = await c.post("/api/inventory", json=body, headers=await headers(c))
    assert created.status_code == 201
    assert created.json()["barcode"] == "000099"  # leading zeros are significant
    assert created.json()["tracking_history"][0]["action"] == "registered"
    duplicate = await c.post("/api/inventory", json=body, headers=await headers(c))
    assert duplicate.status_code == 409
    for code in ("mt00123", "CI-EXISTING"):
        response = await c.post("/api/inventory", json={**body, "code": code}, headers=await headers(c))
        assert response.status_code == 409


async def test_stale_clients_cannot_overwrite_a_scan_move(inventory_client):
    c = inventory_client
    old = await c.get("/api/rack-items")
    moved = await c.post("/api/inventory/ci-existing/location", json={"rack": "Rack-02", "u": 3}, headers={"If-Match": old.headers["etag"]})
    assert moved.status_code == 200
    stale = await c.put("/api/rack-items", json=old.json(), headers={"If-Match": old.headers["etag"]})
    assert stale.status_code == 409
    assert (await c.put("/api/rack-items", json=old.json())).status_code == 428
    stale_move = await c.post("/api/inventory/ci-existing/location", json={"rack": "Rack-01", "u": 2}, headers={"If-Match": old.headers["etag"]})
    assert stale_move.status_code == 409
    assert store.read_items()["Rack-02"][0]["u"] == 3


async def test_dcim_and_twin_edits_record_history_and_keep_server_fields(inventory_client):
    c = inventory_client
    await c.post("/api/inventory/ci-existing/location", json={"rack": "Rack-01", "u": 1}, headers=await headers(c))
    response = await c.get("/api/rack-items")
    data = response.json()
    before = deepcopy(data["Rack-01"][0])
    item = data["Rack-01"].pop()
    item.update(u=3, tracking_history=[], last_seen_at="forged timestamp")
    data["Rack-02"].append(item)
    result = await c.put("/api/rack-items", json=data, headers={"If-Match": response.headers["etag"]})
    assert result.status_code == 200
    saved = result.json()["Rack-02"][0]
    assert saved["last_seen_at"] == before["last_seen_at"]
    assert len(saved["tracking_history"]) == 2
    assert saved["tracking_history"][-1]["action"] == "moved"
    assert saved["tracking_history"][-1]["note"] == "Edited in DCIM or 3D Twin"


@pytest.mark.parametrize("patch", [{"u": 0}, {"u": 43}, {"u": 1.2}, {"u": True}, {"rack": "Missing"}, {"position": "x" * 81}])
async def test_invalid_location_changes_nothing(inventory_client, patch):
    c = inventory_client
    before = store.ITEMS_FILE.read_bytes()
    result = await c.post("/api/inventory/ci-existing/location", json={"rack": "Rack-01", "u": 1, **patch}, headers=await headers(c))
    assert result.status_code == 422
    assert store.ITEMS_FILE.read_bytes() == before


@pytest.mark.parametrize("code", [" ", "abc\nxyz", "LOC:Rack-01:1:", "x" * 201])
async def test_invalid_barcode_changes_nothing(inventory_client, code):
    before = store.ITEMS_FILE.read_bytes()
    result = await inventory_client.post("/api/inventory/ci-existing/barcode", json={"code": code}, headers=await headers(inventory_client))
    assert result.status_code == 422
    assert store.ITEMS_FILE.read_bytes() == before


async def test_existing_barcode_cannot_be_reassigned(inventory_client):
    c = inventory_client
    assert (await c.post("/api/inventory/ci-existing/barcode", json={"code": "one"}, headers=await headers(c))).status_code == 200
    assert (await c.post("/api/inventory/ci-existing/barcode", json={"code": "two"}, headers=await headers(c))).status_code == 409
    assert store.read_items()["Rack-01"][0]["barcode"] == "one"


async def test_ambiguous_legacy_serials_are_returned_without_mutation(inventory_client):
    data = store.read_items()
    data["Rack-02"].append({"id": "ci-second", "name": "Another switch", "serial_number": "MT00123", "u": 2})
    store.write_items(data)
    result = await inventory_client.get("/api/inventory", params={"code": "MT00123"})
    assert len(result.json()["matches"]) == 2
    assert store.read_items() == data


async def test_concurrent_moves_only_one_can_succeed(inventory_client):
    c = inventory_client
    version = await headers(c)
    results = await asyncio.gather(*[
        c.post("/api/inventory/ci-existing/location", json={"rack": "Rack-02", "u": u}, headers=version)
        for u in (2, 3)
    ])
    assert sorted(r.status_code for r in results) == [200, 409]
    assert len(store.read_items()["Rack-02"][0]["tracking_history"]) == 1


async def test_corrupt_inventory_is_never_replaced_with_empty_data(inventory_client):
    store.ITEMS_FILE.write_text("{broken")
    assert (await inventory_client.get("/api/inventory")).status_code == 503
    assert (await inventory_client.get("/api/rack-items")).status_code == 503
    result = await inventory_client.put("/api/rack-items", json={}, headers={"If-Match": store.revision({})})
    assert result.status_code == 503
    assert store.ITEMS_FILE.read_text() == "{broken"


async def test_disk_failure_reports_failure_and_keeps_original(inventory_client, monkeypatch):
    c = inventory_client
    before = store.ITEMS_FILE.read_bytes()
    version = await headers(c)
    def fail(*args):
        raise OSError("Disk full")
    monkeypatch.setattr(store.os, "replace", fail)
    result = await c.post("/api/inventory/ci-existing/location", json={"rack": "Rack-02", "u": 1}, headers=version)
    assert result.status_code == 503
    assert store.ITEMS_FILE.read_bytes() == before


async def test_scanner_and_write_endpoints_require_site_auth(inventory_client):
    c = inventory_client
    assert (await c.get("/api/inventory", auth=None)).status_code == 401
    assert (await c.get("/api/rack-items", auth=None)).status_code == 200
    before = store.ITEMS_FILE.read_bytes()
    result = await c.put("/api/rack-items", json={}, headers=await headers(c), auth=None)
    assert result.status_code == 401
    assert store.ITEMS_FILE.read_bytes() == before


def test_history_is_bounded_without_losing_latest():
    item = {}
    for n in range(120):
        store.record(item, "confirmed", None, {"u": n})
    assert len(item["tracking_history"]) == 100
    assert item["tracking_history"][-1]["to"] == {"u": 119}
