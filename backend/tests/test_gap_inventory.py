"""Gaps in the equipment inventory and layout store tests: shared revisions, scanner edge cases, PUT /api/rack-items
validation, /api/twin-data and /api/rack-layout If-Match, and save_layouts locking and restore.

Everything runs against temporary files and an in-memory database; no device, VM or live site is contacted."""
import asyncio
from contextlib import contextmanager
from copy import deepcopy
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app import accounts, inventory_store as store
from app.database import get_db
from app.models import Device

LAYOUT_ATTRS = ("_RACK_SLOTS_FILE", "_RACK_POSITIONS_FILE", "_RACK_OVERRIDES_FILE", "_SWITCH_ASSIGN_FILE",
                "_CHILLERS_FILE", "_TWIN_DATA_FILE")
LAYOUT_URLS = {"rack_slots": "/api/rack-slots", "rack_positions": "/api/rack-positions",
               "rack_overrides": "/api/rack-overrides"}
LAYOUT_ATTR_OF = {"rack_slots": "_RACK_SLOTS_FILE", "rack_positions": "_RACK_POSITIONS_FILE",
                  "rack_overrides": "_RACK_OVERRIDES_FILE"}
SEED_ITEMS = {
    "Rack-01": [{"id": "ci-a", "name": "Switch A", "type": "switch", "serial_number": "MT00123", "u": 1,
                 "notes": "keep", "custom": {"keep": True}}],
    "Rack-02": [{"id": "ci-b", "name": "Switch B", "type": "switch", "serial_number": "MT00456", "barcode": "000222",
                 "u": 2, "shelf_position": "left"}],
}
SEED_LAYOUT = {"rack_slots": {"Rack-01": {"opt11": 1}}, "rack_positions": {"Rack-01": ["opt11"]},
               "rack_overrides": {"opt11": "Rack-01"}}
STALE = store.revision({"Rack-01": []})
CHANGED_ELSEWHERE = "Equipment changed in another session. Refresh, review its location, and try again."
DUPLICATE_CODE = "This barcode or serial number already belongs to another item."


@pytest.fixture
async def env(db_session, tmp_path, monkeypatch):
    import app.main as main
    monkeypatch.setattr(store, "ITEMS_FILE", tmp_path / "rack_items.json")
    for attr in LAYOUT_ATTRS:
        monkeypatch.setattr(main, attr, tmp_path / getattr(main, attr).name)
    settings = SimpleNamespace(accounts_enabled=False, lab_manager_password="")
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    # The deployed app's AccountAccess middleware reads its own settings; without this an ACCOUNTS_ENABLED in the
    # machine's environment or .env would turn every request below into a 401.
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "_basic_failures", {})
    store.write_items(deepcopy(SEED_ITEMS))
    db_session.add(Device(id="rack-3", name="Storage", kind="rack", ip="", rack="Rack-03"))
    await db_session.commit()

    async def override():
        yield db_session
    main.app.dependency_overrides[get_db] = override
    transport = ASGITransport(app=main.app, raise_app_exceptions=False)  # a server error is a 500 answer, as on the site
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield SimpleNamespace(client=client, folder=tmp_path, main=main, settings=settings)
    main.app.dependency_overrides.clear()


async def tag(client, url="/api/rack-items"):
    return (await client.get(url)).headers["etag"]


def layout_path(env, name):
    return getattr(env.main, LAYOUT_ATTR_OF[name])


def seed_layout(env):
    for name, data in SEED_LAYOUT.items():
        layout_path(env, name).write_text(json.dumps(data))
    return {name: layout_path(env, name).read_bytes() for name in SEED_LAYOUT}


def layout_bytes(env):
    return {name: layout_path(env, name).read_bytes() if layout_path(env, name).exists() else None
            for name in SEED_LAYOUT}


def item(data, item_id):
    return next(i for group in data.values() for i in group if i["id"] == item_id)


# ─── one revision for the scanner and DCIM; ETag chaining ────────────────────────────────────────────────────────

async def test_scanner_and_dcim_share_one_revision_and_a_put_etag_chains_into_the_next_save(env):
    c = env.client
    scan, dcim = await c.get("/api/inventory"), await c.get("/api/rack-items")
    assert scan.headers["etag"] == dcim.headers["etag"] == store.revision(SEED_ITEMS)
    data = dcim.json()
    data["Rack-01"][0]["notes"] = "first"
    first = await c.put("/api/rack-items", json=data, headers={"If-Match": scan.headers["etag"]})
    assert first.status_code == 200, first.text
    assert first.headers["etag"] == await tag(c) == await tag(c, "/api/inventory")
    data["Rack-01"][0]["notes"] = "second"
    second = await c.put("/api/rack-items", json=data, headers={"If-Match": first.headers["etag"]})
    assert second.status_code == 200, second.text
    assert item(store.read_items(), "ci-a")["notes"] == "second"
    old = await c.put("/api/rack-items", json=data, headers={"If-Match": scan.headers["etag"]})
    assert old.status_code == 409 and old.json()["detail"] == CHANGED_ELSEWHERE


SCANNER_WRITES = {
    "register": ("/api/inventory", {"code": "NEW-1", "name": "New switch", "rack": "Rack-01", "u": 3}),
    "barcode": ("/api/inventory/ci-a/barcode", {"code": "NEW-2"}),
    "move": ("/api/inventory/ci-a/location", {"rack": "Rack-02", "u": 5}),
}


@pytest.mark.parametrize("write", SCANNER_WRITES)
async def test_every_scanner_write_refuses_a_missing_or_stale_revision_before_touching_the_file(env, write):
    c = env.client
    url, body = SCANNER_WRITES[write]
    before = store.ITEMS_FILE.read_bytes()
    missing = await c.post(url, json=body)
    assert missing.status_code == 428 and missing.json()["detail"] == "Reload the equipment inventory before saving."
    stale = await c.post(url, json=body, headers={"If-Match": STALE})
    assert stale.status_code == 409 and stale.json()["detail"] == CHANGED_ELSEWHERE
    assert store.ITEMS_FILE.read_bytes() == before
    # The same request with the current revision is valid, so the refusals above came from the revision alone.
    ok = await c.post(url, json=body, headers={"If-Match": await tag(c)})
    assert ok.status_code in (200, 201), ok.text
    assert ok.headers["etag"] == await tag(c)


# ─── scanner lookups and edge cases ──────────────────────────────────────────────────────────────────────────────

async def test_unknown_item_is_404_and_duplicate_legacy_ids_are_409_without_any_write(env):
    c = env.client
    for url, body in (("/api/inventory/ci-missing/barcode", {"code": "X1"}),
                      ("/api/inventory/ci-missing/location", {"rack": "Rack-01", "u": 1})):
        r = await c.post(url, json=body, headers={"If-Match": await tag(c)})
        assert r.status_code == 404 and r.json()["detail"] == "Equipment no longer exists. Refresh the inventory."
    data = store.read_items()
    data["Rack-02"].append({"id": "ci-a", "name": "Legacy clone", "u": 7})
    store.write_items(data)
    before = store.ITEMS_FILE.read_bytes()
    listing = await c.get("/api/inventory")
    assert listing.status_code == 200 and [i["id"] for i in listing.json()["items"]].count("ci-a") == 2
    for url, body in (("/api/inventory/ci-a/barcode", {"code": "X1"}),
                      ("/api/inventory/ci-a/location", {"rack": "Rack-01", "u": 1})):
        r = await c.post(url, json=body, headers={"If-Match": await tag(c)})
        assert r.status_code == 409
        assert r.json()["detail"] == "Duplicate equipment IDs must be resolved in the inventory first."
    assert store.ITEMS_FILE.read_bytes() == before


async def test_rescanning_the_linked_barcode_writes_nothing_and_keeps_the_revision(env):
    c = env.client
    before, etag = store.ITEMS_FILE.read_bytes(), await tag(c)
    r = await c.post("/api/inventory/ci-b/barcode", json={"code": " 000222\t"}, headers={"If-Match": etag})
    assert r.status_code == 200, r.text
    assert r.json()["barcode"] == "000222" and "tracking_history" not in r.json()
    assert r.headers["etag"] == etag
    assert store.ITEMS_FILE.read_bytes() == before


async def test_a_barcode_may_repeat_the_items_own_serial_but_never_another_items_identifier(env):
    c = env.client
    before = store.ITEMS_FILE.read_bytes()
    for taken in ("mt00456", "000222", "CI-B"):   # ci-b's serial, barcode and id, in any letter case
        r = await c.post("/api/inventory/ci-a/barcode", json={"code": taken}, headers={"If-Match": await tag(c)})
        assert r.status_code == 409 and r.json()["detail"] == DUPLICATE_CODE
    assert store.ITEMS_FILE.read_bytes() == before
    own = await c.post("/api/inventory/ci-a/barcode", json={"code": "mt00123"}, headers={"If-Match": await tag(c)})
    assert own.status_code == 200, own.text
    saved = item(store.read_items(), "ci-a")
    assert (saved["barcode"], saved["serial_number"]) == ("mt00123", "MT00123")
    assert saved["tracking_history"][-1]["action"] == "barcode linked"


@pytest.mark.parametrize("code", ["abc\x7f", "\x00abc", "loc:Rack-01:1:", "Store:Main", "rack:Rack-01"])
async def test_control_characters_and_location_labels_in_any_case_are_not_equipment_barcodes(env, code):
    c = env.client
    before = store.ITEMS_FILE.read_bytes()
    linked = await c.post("/api/inventory/ci-a/barcode", json={"code": code}, headers={"If-Match": await tag(c)})
    registered = await c.post("/api/inventory", json={"code": code, "name": "X", "rack": "Rack-01", "u": 4},
                              headers={"If-Match": await tag(c)})
    assert (linked.status_code, registered.status_code) == (422, 422)
    assert store.ITEMS_FILE.read_bytes() == before


async def test_scanned_placement_is_trimmed_and_shelf_u_must_be_a_real_integer(env):
    c = env.client
    moved = await c.post("/api/inventory/ci-a/location", json={"rack": "  Rack-02 ", "u": 4, "position": "  front  "},
                         headers={"If-Match": await tag(c)})
    assert moved.status_code == 200, moved.text
    data = store.read_items()
    assert set(data) == {"Rack-01", "Rack-02"}
    saved = item(data, "ci-a")
    assert saved in data["Rack-02"] and (saved["u"], saved["shelf_position"]) == (4, "front")
    assert saved["tracking_history"][-1]["to"] == {"rack": "Rack-02", "u": 4, "position": "front"}
    before = store.ITEMS_FILE.read_bytes()
    as_text = await c.post("/api/inventory/ci-a/location", json={"rack": "Rack-01", "u": "4"},
                           headers={"If-Match": await tag(c)})
    assert as_text.status_code == 422 and store.ITEMS_FILE.read_bytes() == before
    storage = await c.post("/api/inventory/ci-a/location", json={"rack": "Storage-Main", "u": 0, "position": "   "},
                           headers={"If-Match": await tag(c)})
    assert storage.status_code == 200, storage.text
    assert item(store.read_items(), "ci-a") in store.read_items()["Storage-Main"]


async def test_a_missing_inventory_reads_empty_and_the_first_registration_creates_it(env):
    c = env.client
    store.ITEMS_FILE.unlink()
    items = await c.get("/api/rack-items")
    assert items.status_code == 200 and items.json() == {} and items.headers["etag"] == store.revision({})
    scan = await c.get("/api/inventory")
    assert scan.json()["items"] == [] and scan.json()["racks"] == ["Rack-03", "Storage-Main"]
    assert scan.json()["history_limit"] == store.HISTORY_LIMIT
    r = await c.post("/api/inventory", json={"code": "FIRST-1", "name": "First", "rack": "Rack-03", "u": 1},
                     headers={"If-Match": store.revision({})})
    assert r.status_code == 201, r.text
    data = store.read_items()
    assert list(data) == ["Rack-03"] and data["Rack-03"][0]["barcode"] == "FIRST-1"
    assert data["Rack-03"][0]["last_seen_at"] == data["Rack-03"][0]["tracking_history"][0]["at"]


@pytest.mark.parametrize("content", ["", "[]", '{"Rack-01": {"id": "ci-a"}}', '{"Rack-01": [{"name": "no id"}]}',
                                     '{"Rack-01": [{"id": ""}]}', '{"Rack-01": ["ci-a"]}'])
async def test_an_inventory_file_of_the_wrong_shape_is_503_everywhere_and_never_overwritten(env, content):
    c = env.client
    store.ITEMS_FILE.write_text(content, encoding="utf-8")
    assert (await c.get("/api/rack-items")).status_code == 503
    assert (await c.get("/api/inventory")).status_code == 503
    put = await c.put("/api/rack-items", json={}, headers={"If-Match": store.revision({})})
    move = await c.post("/api/inventory/ci-a/location", json={"rack": "Rack-01", "u": 1},
                        headers={"If-Match": store.revision({})})
    assert (put.status_code, move.status_code) == (503, 503)
    assert store.ITEMS_FILE.read_text(encoding="utf-8") == content


# ─── PUT /api/rack-items (DCIM and Twin editors) ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("payload", [
    {"   ": []},
    {"Rack-01": {"id": "ci-a"}},
    {"Rack-01": [{"name": "no id"}]},
    {"Rack-01": [{"id": 5}]},
    {"Rack-01": ["ci-a"]},
    {"Rack-01": [{"id": "ci-a"}], "Rack-02": [{"id": "ci-a"}]},
])
async def test_rack_items_put_rejects_malformed_equipment_lists_without_writing(env, payload):
    c = env.client
    before = store.ITEMS_FILE.read_bytes()
    r = await c.put("/api/rack-items", json=payload, headers={"If-Match": await tag(c)})
    assert r.status_code == 422
    assert store.ITEMS_FILE.read_bytes() == before


async def test_a_new_item_from_an_editor_cannot_bring_its_own_history_or_last_seen(env):
    c = env.client
    data = (await c.get("/api/rack-items")).json()
    data["Rack-01"].append({"id": "ci-new", "name": "New", "u": 9, "last_seen_at": "2001-01-01T00:00:00+00:00",
                            "tracking_history": [{"action": "registered", "note": "forged"}]})
    r = await c.put("/api/rack-items", json=data, headers={"If-Match": await tag(c)})
    assert r.status_code == 200, r.text
    saved = item(store.read_items(), "ci-new")
    assert saved == {"id": "ci-new", "name": "New", "u": 9}


async def test_editor_barcode_checks_only_changed_codes_and_allow_a_swap(env):
    c = env.client
    data = store.read_items()
    data["Rack-02"].append({"id": "ci-c", "name": "Legacy twin", "serial_number": "MT00123", "barcode": "000333", "u": 3})
    store.write_items(data)
    # A legacy duplicate serial (ci-a and ci-c) does not block an unrelated edit.
    data = (await c.get("/api/rack-items")).json()
    item(data, "ci-a")["notes"] = "edited"
    assert (await c.put("/api/rack-items", json=data, headers={"If-Match": await tag(c)})).status_code == 200
    # A changed code that belongs to another item is refused, in any letter case.
    for taken in ("mt00456", "CI-B"):
        data = (await c.get("/api/rack-items")).json()
        before = store.ITEMS_FILE.read_bytes()
        item(data, "ci-a")["barcode"] = taken
        r = await c.put("/api/rack-items", json=data, headers={"If-Match": await tag(c)})
        assert r.status_code == 409 and r.json()["detail"] == DUPLICATE_CODE
        assert store.ITEMS_FILE.read_bytes() == before
    # Two items exchanging their barcodes in one save is not a conflict.
    data = (await c.get("/api/rack-items")).json()
    item(data, "ci-b")["barcode"], item(data, "ci-c")["barcode"] = "000333", "000222"
    r = await c.put("/api/rack-items", json=data, headers={"If-Match": await tag(c)})
    assert r.status_code == 200, r.text
    saved = store.read_items()
    assert (item(saved, "ci-b")["barcode"], item(saved, "ci-c")["barcode"]) == ("000333", "000222")


async def test_an_editor_shelf_position_change_is_a_move_and_an_untouched_item_gets_no_history(env):
    c = env.client
    data = (await c.get("/api/rack-items")).json()
    item(data, "ci-b")["shelf_position"] = "right"
    r = await c.put("/api/rack-items", json=data, headers={"If-Match": await tag(c)})
    assert r.status_code == 200, r.text
    saved = store.read_items()
    event = item(saved, "ci-b")["tracking_history"][-1]
    assert {k: event[k] for k in ("action", "from", "to", "note")} == {
        "action": "moved", "note": "Edited in DCIM or 3D Twin",
        "from": {"rack": "Rack-02", "u": 2, "position": "left"}, "to": {"rack": "Rack-02", "u": 2, "position": "right"}}
    assert "last_seen_at" not in item(saved, "ci-b"), "an editor move is not a physical scan"
    assert item(saved, "ci-a") == SEED_ITEMS["Rack-01"][0]


async def test_hebrew_stays_readable_in_rack_items_and_lab_data(env):
    c = env.client
    data = (await c.get("/api/rack-items")).json()
    item(data, "ci-a")["notes"] = "שרת בדיקה"
    assert (await c.put("/api/rack-items", json=data, headers={"If-Match": await tag(c)})).status_code == 200
    raw = store.ITEMS_FILE.read_bytes()
    assert "שרת בדיקה".encode("utf-8") in raw and b"\\u05e9" not in raw
    twin = {"items": [{"id": "ITEM-0001", "name": "מדף עליון"}]}
    r = await c.put("/api/twin-data", json=twin)
    assert r.status_code == 200 and r.headers["etag"] == store.revision(twin)
    raw = env.main._TWIN_DATA_FILE.read_bytes()
    assert "מדף עליון".encode("utf-8") in raw and b"\\u05de" not in raw
    reread = await c.get("/api/twin-data")
    assert reread.json() == twin and reread.headers["etag"] == r.headers["etag"]


# ─── /api/twin-data and PUT /api/rack-layout ─────────────────────────────────────────────────────────────────────

async def test_twin_data_if_match_on_a_missing_file_only_accepts_the_empty_revision(env):
    c = env.client
    path = env.main._TWIN_DATA_FILE
    stale = await c.put("/api/twin-data", json={"items": []}, headers={"If-Match": store.revision({"items": []})})
    assert stale.status_code == 409 and stale.json()["detail"] == store.LAYOUT_CONFLICT
    assert not path.exists()
    first = await c.put("/api/twin-data", json={"items": []}, headers={"If-Match": store.revision({})})
    assert first.status_code == 200 and json.loads(path.read_text(encoding="utf-8")) == {"items": []}
    again = await c.put("/api/twin-data", json={"items": [{"id": "x"}]}, headers={"If-Match": store.revision({})})
    assert again.status_code == 409
    assert json.loads(path.read_text(encoding="utf-8")) == {"items": []}


async def test_rack_layout_with_an_empty_if_match_is_428_and_writes_nothing(env):
    c = env.client
    before = seed_layout(env)
    body = {name: {"data": {"changed": name}, "if_match": await tag(c, url)} for name, url in LAYOUT_URLS.items()}
    body["rack_positions"]["if_match"] = ""
    r = await c.put("/api/rack-layout", json=body)
    assert r.status_code == 428 and r.json()["detail"] == "Reload the rack layout before saving."
    assert layout_bytes(env) == before


@pytest.mark.parametrize("part", ["Rack-01", {"data": [], "if_match": "TAG"}, {"data": {}, "if_match": None},
                                  {"if_match": "TAG"}, {"data": {}, "if_match": 7}])
async def test_rack_layout_rejects_a_malformed_store_part_before_any_write(env, part):
    c = env.client
    before = seed_layout(env)
    tags = {name: await tag(c, url) for name, url in LAYOUT_URLS.items()}
    if isinstance(part, dict) and part.get("if_match") == "TAG":
        part = {**part, "if_match": tags["rack_positions"]}
    body = {"rack_slots": {"data": {"x": 1}, "if_match": tags["rack_slots"]}, "rack_positions": part}
    r = await c.put("/api/rack-layout", json=body)
    assert r.status_code == 422
    assert layout_bytes(env) == before


async def test_rack_layout_saves_only_the_named_stores_and_can_create_a_first_file(env):
    c = env.client
    positions = {"Rack-01": ["opt11", "opt12"]}
    r = await c.put("/api/rack-layout",
                    json={"rack_positions": {"data": positions, "if_match": store.revision({})}})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "revisions": {"rack_positions": store.revision(positions)}}
    assert layout_bytes(env)["rack_slots"] is None and layout_bytes(env)["rack_overrides"] is None
    reread = await c.get("/api/rack-positions")
    assert reread.json() == positions and reread.headers["etag"] == r.json()["revisions"]["rack_positions"]


async def test_rack_layout_store_that_cannot_be_read_is_503_before_any_write(env):
    c = env.client
    seed_layout(env)
    layout_path(env, "rack_positions").unlink()
    layout_path(env, "rack_positions").mkdir()   # the store path is a folder: its previous bytes cannot be kept
    readable = ("rack_slots", "rack_overrides")
    before = {n: layout_path(env, n).read_bytes() for n in readable}
    tags = {name: await tag(c, url) for name, url in LAYOUT_URLS.items()}
    body = {name: {"data": {"changed": name}, "if_match": tags[name]}
            for name in (*readable, "rack_positions")}   # the unreadable store comes last
    r = await c.put("/api/rack-layout", json=body)
    assert r.status_code == 503 and r.json()["detail"] == store.LAYOUT_SAVE_FAILED
    assert {n: layout_path(env, n).read_bytes() for n in readable} == before
    assert not list(env.folder.glob("*.tmp"))


async def test_layout_writes_need_the_site_password_when_one_is_set(env):
    c = env.client
    before = seed_layout(env)
    env.settings.lab_manager_password = "test-password"
    tags = {name: await tag(c, url) for name, url in LAYOUT_URLS.items()}   # layout reads stay public
    body = {name: {"data": {"changed": name}, "if_match": tags[name]} for name in LAYOUT_URLS}
    assert (await c.put("/api/rack-layout", json=body)).status_code == 401
    assert (await c.put("/api/twin-data", json={"items": []})).status_code == 401
    assert (await c.put("/api/rack-slots", json={})).status_code == 401
    assert layout_bytes(env) == before and not env.main._TWIN_DATA_FILE.exists()
    ok = await c.put("/api/rack-layout", json=body, auth=("lab", "test-password"))
    assert ok.status_code == 200, ok.text
    assert json.loads(layout_path(env, "rack_slots").read_text()) == {"changed": "rack_slots"}


# ─── save_layouts: locking and restore ───────────────────────────────────────────────────────────────────────────

def _layout_files(tmp_path):
    paths = {name: tmp_path / f"{name}.json" for name in ("rack_slots", "rack_positions", "rack_overrides")}
    for name, path in paths.items():
        path.write_text(json.dumps({"was": name}))
    return paths


def test_save_layouts_locks_every_store_in_path_order_before_reading_and_always_unlocks(tmp_path, monkeypatch):
    paths = _layout_files(tmp_path)
    events, real_lock, real_read = [], store.locked_file, store.read_layout

    @contextmanager
    def recording_lock(path, detail):
        with real_lock(path, detail):
            events.append(("lock", path.stem))
            try:
                yield
            finally:
                events.append(("unlock", path.stem))

    def recording_read(path, default):
        events.append(("read", path.stem))
        return real_read(path, default)
    monkeypatch.setattr(store, "locked_file", recording_lock)
    monkeypatch.setattr(store, "read_layout", recording_read)
    order = ("rack_slots", "rack_positions", "rack_overrides")   # not path order
    entries = [(n, paths[n], {"now": n}, store.revision({"was": n}), {}) for n in order]
    assert store.save_layouts(entries) == {n: store.revision({"now": n}) for n in order}
    locked = [("lock", n) for n in sorted(order)]
    assert events[:3] == locked and events[3:6] == [("read", n) for n in order]
    assert events[6:] == [("unlock", n) for n in reversed(sorted(order))]

    events.clear()
    before = {n: p.read_bytes() for n, p in paths.items()}
    stale = [(n, paths[n], {"later": n}, store.revision({"now": n}) if n != "rack_overrides" else STALE, {})
             for n in order]
    with pytest.raises(HTTPException) as refused:
        store.save_layouts(stale)
    assert refused.value.status_code == 409
    assert events[:3] == locked and events[-3:] == [("unlock", n) for n in reversed(sorted(order))]
    assert {n: p.read_bytes() for n, p in paths.items()} == before


def test_a_cancelled_save_puts_back_the_written_store_and_stays_a_cancellation(tmp_path, monkeypatch):
    paths = _layout_files(tmp_path)
    before = {n: p.read_bytes() for n, p in paths.items()}
    real_write, calls = store.write_json, []

    def cancelled_second_write(path, data, *args, **kwargs):
        calls.append(path.stem)
        if len(calls) == 2:
            raise asyncio.CancelledError()
        return real_write(path, data, *args, **kwargs)
    monkeypatch.setattr(store, "write_json", cancelled_second_write)
    entries = [(n, paths[n], {"now": n}, store.revision({"was": n}), {}) for n in ("rack_slots", "rack_positions")]
    with pytest.raises(asyncio.CancelledError):
        store.save_layouts(entries)
    assert calls == ["rack_slots", "rack_positions"]
    assert {n: p.read_bytes() for n, p in paths.items()} == before
    assert not list(tmp_path.glob("*.tmp"))
    monkeypatch.setattr(store, "write_json", real_write)   # the locks were released: the same save now succeeds
    assert store.save_layouts(entries) == {n: store.revision({"now": n}) for n in ("rack_slots", "rack_positions")}


def test_a_failed_first_write_is_a_plain_failure_even_when_put_back_breaks(tmp_path, monkeypatch):
    paths = _layout_files(tmp_path)
    before = {n: p.read_bytes() for n, p in paths.items()}

    def disk_full(*args, **kwargs):
        raise OSError("disk full")

    def read_only(path, raw):
        raise OSError("read-only")
    monkeypatch.setattr(store, "write_json", disk_full)
    monkeypatch.setattr(store, "_put_back", read_only)
    entries = [(n, paths[n], {"now": n}, store.revision({"was": n}), {}) for n in ("rack_slots", "rack_positions")]
    with pytest.raises(HTTPException) as failed:
        store.save_layouts(entries)
    # Nothing was replaced, so the message must not claim a half-saved layout.
    assert failed.value.status_code == 503 and failed.value.detail == store.LAYOUT_SAVE_FAILED
    assert {n: p.read_bytes() for n, p in paths.items()} == before


# ─── real bugs (kept as strict xfail; product code is not changed here) ─────────────────────────────────────────

@pytest.mark.xfail(strict=True, reason="BUG: a layout PUT body containing NaN/Infinity (accepted by Python's json, "
                                       "never produced by JSON.stringify) is written to the store; every later GET "
                                       "of that store then answers 500, so DCIM and the Twin can no longer load it")
@pytest.mark.parametrize("url", ["/api/rack-slots", "/api/twin-data", "/api/rack-layout"])
async def test_a_non_finite_number_never_makes_a_layout_store_unreadable(env, url):
    c = env.client
    if url == "/api/rack-layout":
        body = '{"rack_slots": {"data": {"Rack-01": {"opt11": NaN}}, "if_match": %s}}' % json.dumps(store.revision({}))
        read_url = "/api/rack-slots"
    else:
        body, read_url = '{"Rack-01": {"opt11": NaN}}', url
    await c.put(url, content=body.encode(), headers={"Content-Type": "application/json"})
    assert (await c.get(read_url)).status_code == 200


@pytest.mark.xfail(strict=True, reason="BUG: PUT /api/rack-items with an Infinity value answers 500 but has already "
                                       "replaced rack_items.json; afterwards GET /api/rack-items and the barcode "
                                       "scanner (GET /api/inventory) answer 500 until the file is repaired by hand")
async def test_a_non_finite_number_never_breaks_the_equipment_inventory(env):
    c = env.client
    before = store.ITEMS_FILE.read_bytes()
    body = '{"Rack-01": [{"id": "ci-a", "name": "Switch A", "u": Infinity}], "Rack-02": []}'
    put = await c.put("/api/rack-items", content=body.encode(),
                      headers={"Content-Type": "application/json", "If-Match": await tag(c)})
    assert put.status_code < 500 or store.ITEMS_FILE.read_bytes() == before, "a failed save must not change the file"
    assert (await c.get("/api/rack-items")).status_code == 200
    assert (await c.get("/api/inventory")).status_code == 200
