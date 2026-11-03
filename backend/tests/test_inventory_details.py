"""A unit's serial number, part number, model and MAC are separate fields: created by a scan, filled on a later scan
without overwriting, edited in DCIM, and each serial or MAC names exactly one unit."""
import json

import pytest

from app import accounts
from app import inventory_store as store
from tests.test_inventory import headers, inventory_client  # noqa: F401  (fixture)

NEW = {"code": "MT2614X01234", "name": "MQM8790-HS2F MT2614X01234", "type": "switch", "rack": "Rack-03", "u": 2, "position": ""}
DETAILS = {"serial": " MT2614X01234 ", "part_number": "MQM8790-HS2F", "model": "QM8790", "mac": "b8-ce-f6-00-11-22"}


def stored(item_id):
    return next(item for items in store.read_items().values() for item in items if item["id"] == item_id)


async def test_scan_creates_a_unit_with_all_four_fields_cleaned(inventory_client):
    c = inventory_client
    created = await c.post("/api/inventory", json={**NEW, **DETAILS}, headers=await headers(c))
    assert created.status_code == 201
    item = created.json()
    assert (item["serial_number"], item["part_number"], item["model"], item["mac"]) == ("MT2614X01234", "MQM8790-HS2F", "QM8790", "B8:CE:F6:00:11:22")
    assert "serial" not in item
    saved = stored(item["id"])
    assert saved["mac"] == "B8:CE:F6:00:11:22" and saved["barcode"] == "MT2614X01234"
    # Any MAC spelling finds it, and so does its serial.
    for code in ("b8:ce:f6:00:11:22", "B8CEF6001122", "b8ce.f600.1122", "mt2614x01234"):
        matches = (await c.get("/api/inventory", params={"code": code})).json()["matches"]
        assert [m["id"] for m in matches] == [item["id"]], code


async def test_blank_details_are_absent_and_serial_number_is_accepted_too(inventory_client):
    c = inventory_client
    created = await c.post("/api/inventory", json={**NEW, "serial_number": "SN-1", "part_number": "  ", "model": "", "mac": None}, headers=await headers(c))
    assert created.status_code == 201
    item = stored(created.json()["id"])
    assert item["serial_number"] == "SN-1"
    assert not {"part_number", "model", "mac"} & set(item)
    plain = await c.post("/api/inventory", json={**NEW, "code": "PLAIN-1"}, headers=await headers(c))
    assert plain.status_code == 201
    assert not set(store.DETAIL_FIELDS) & set(stored(plain.json()["id"]))


@pytest.mark.parametrize("field,value", [
    ("mac", "00:11:22:33:44"), ("mac", "00:11:22-33:44:55"), ("mac", "GG:11:22:33:44:55"), ("mac", "x" * 41),
    ("serial", "S" * 201), ("part_number", "P" * 121), ("model", "M" * 121), ("model", "bad\tmodel"), ("serial", 123),
])
async def test_invalid_details_are_refused_and_nothing_is_written(inventory_client, field, value):
    c = inventory_client
    before = store.ITEMS_FILE.read_bytes()
    response = await c.post("/api/inventory", json={**NEW, field: value}, headers=await headers(c))
    assert response.status_code == 422
    assert store.ITEMS_FILE.read_bytes() == before


async def test_a_serial_or_mac_of_another_unit_is_refused_on_create(inventory_client):
    c = inventory_client
    first = await c.post("/api/inventory", json={**NEW, **DETAILS}, headers=await headers(c))
    assert first.status_code == 201
    before = store.ITEMS_FILE.read_bytes()
    same_mac = await c.post("/api/inventory", json={**NEW, "code": "OTHER-1", "mac": "B8CEF6001122"}, headers=await headers(c))
    assert same_mac.status_code == 409
    assert same_mac.json()["detail"] == store.DUPLICATE_MAC
    # The serial of an existing unit (Switch A has MT00123), with another barcode.
    same_serial = await c.post("/api/inventory", json={**NEW, "code": "OTHER-2", "serial": "mt00123"}, headers=await headers(c))
    assert same_serial.status_code == 409
    assert same_serial.json()["detail"] == store.DUPLICATE_CODE
    # A barcode equal to another unit's MAC is refused as well.
    mac_as_code = await c.post("/api/inventory", json={**NEW, "code": "B8:CE:F6:00:11:22"}, headers=await headers(c))
    assert mac_as_code.status_code == 409
    assert store.ITEMS_FILE.read_bytes() == before


async def test_scan_fill_only_adds_missing_fields_and_never_overwrites(inventory_client):
    c = inventory_client
    # Switch A already has serial MT00123; a scan carrying a different serial must not change it.
    response = await c.post("/api/inventory/ci-existing/details", headers=await headers(c),
                            json={"serial": "MT99999", "part_number": "MQM8790-HS2F", "model": "QM8790", "mac": "00:1a:2b:3c:4d:5e", "only_missing": True})
    assert response.status_code == 200
    item = response.json()
    assert (item["serial_number"], item["part_number"], item["model"], item["mac"]) == ("MT00123", "MQM8790-HS2F", "QM8790", "00:1A:2B:3C:4D:5E")
    assert item["tracking_history"][-1]["action"] == "details updated"
    assert item["notes"] == "Keep this note" and item["custom_field"] == {"keep": True}
    assert (item["rack"], item["u"]) == ("Rack-01", 1)
    # Nothing missing any more: a second fill writes nothing and keeps the revision.
    before = store.ITEMS_FILE.read_bytes()
    again = await c.post("/api/inventory/ci-existing/details", headers=await headers(c),
                         json={"part_number": "OTHER", "model": "", "only_missing": True})
    assert again.status_code == 200
    assert again.json()["part_number"] == "MQM8790-HS2F"
    assert store.ITEMS_FILE.read_bytes() == before


async def test_details_update_sets_and_clears_and_keeps_revision_rules(inventory_client):
    c = inventory_client
    stale = await headers(c)
    changed = await c.post("/api/inventory/ci-existing/details", headers=stale, json={"model": "SN2700", "mac": "001A2B3C4D5E"})
    assert changed.status_code == 200
    assert (changed.json()["model"], changed.json()["mac"]) == ("SN2700", "00:1A:2B:3C:4D:5E")
    # The old revision is refused (409), a missing one too (428); nothing changes.
    assert (await c.post("/api/inventory/ci-existing/details", headers=stale, json={"model": "X"})).status_code == 409
    assert (await c.post("/api/inventory/ci-existing/details", json={"model": "X"})).status_code == 428
    cleared = await c.post("/api/inventory/ci-existing/details", headers={"If-Match": changed.headers["etag"]}, json={"model": "", "mac": " "})
    assert cleared.status_code == 200
    assert not {"model", "mac"} & set(stored("ci-existing"))
    assert stored("ci-existing")["serial_number"] == "MT00123"
    assert (await c.post("/api/inventory/ci-missing/details", headers=await headers(c), json={"model": "X"})).status_code == 404


async def test_details_update_refuses_a_mac_or_serial_of_another_unit(inventory_client):
    c = inventory_client
    other = await c.post("/api/inventory", json={**NEW, **DETAILS}, headers=await headers(c))
    before = store.ITEMS_FILE.read_bytes()
    mac = await c.post("/api/inventory/ci-existing/details", headers=await headers(c), json={"mac": "b8:ce:f6:00:11:22", "only_missing": True})
    assert mac.status_code == 409 and mac.json()["detail"] == store.DUPLICATE_MAC
    serial = await c.post(f"/api/inventory/{other.json()['id']}/details", headers=await headers(c), json={"serial": "MT00123"})
    assert serial.status_code == 409
    assert store.ITEMS_FILE.read_bytes() == before


async def test_location_move_never_changes_the_details(inventory_client):
    c = inventory_client
    created = (await c.post("/api/inventory", json={**NEW, **DETAILS}, headers=await headers(c))).json()
    moved = await c.post(f"/api/inventory/{created['id']}/location", json={"rack": "Rack-02", "u": 3, "position": "", "model": "IGNORED", "mac": ""},
                         headers=await headers(c))
    assert moved.status_code == 200
    item = moved.json()
    assert (item["rack"], item["u"]) == ("Rack-02", 3)
    assert (item["serial_number"], item["part_number"], item["model"], item["mac"]) == ("MT2614X01234", "MQM8790-HS2F", "QM8790", "B8:CE:F6:00:11:22")


async def test_dcim_edit_saves_cleaned_details_and_refuses_bad_or_duplicate_ones(inventory_client):
    c = inventory_client
    await c.post("/api/inventory", json={**NEW, **DETAILS}, headers=await headers(c))
    response = await c.get("/api/rack-items")
    data = response.json()
    data["Rack-01"][0].update(part_number="  MSN2700  ", model="SN2700", mac="0c-42-a1-00-00-01")
    saved = await c.put("/api/rack-items", json=data, headers={"If-Match": response.headers["etag"]})
    assert saved.status_code == 200
    item = saved.json()["Rack-01"][0]
    assert (item["part_number"], item["model"], item["mac"]) == ("MSN2700", "SN2700", "0C:42:A1:00:00:01")
    assert store.read_items()["Rack-01"][0]["mac"] == "0C:42:A1:00:00:01"

    for change, status in (({"mac": "not-a-mac"}, 422), ({"model": "M" * 121}, 422), ({"serial_number": ["x"]}, 422),
                           ({"mac": "b8cef6001122"}, 409), ({"serial_number": "MT2614X01234"}, 409)):
        current = await c.get("/api/rack-items")
        edit = current.json()
        edit["Rack-01"][0].update(change)
        before = store.ITEMS_FILE.read_bytes()
        refused = await c.put("/api/rack-items", json=edit, headers={"If-Match": current.headers["etag"]})
        assert refused.status_code == status, change
        assert store.ITEMS_FILE.read_bytes() == before

    # Blanking a field removes it.
    current = await c.get("/api/rack-items")
    edit = current.json()
    edit["Rack-01"][0].update(model="", mac=None)
    cleared = await c.put("/api/rack-items", json=edit, headers={"If-Match": current.headers["etag"]})
    assert cleared.status_code == 200
    assert not {"model", "mac"} & set(store.read_items()["Rack-01"][0])


async def test_items_stored_without_or_with_legacy_details_keep_loading_and_saving(inventory_client):
    c = inventory_client
    legacy = json.loads(store.ITEMS_FILE.read_text())
    # A hand-edited legacy record: odd MAC spelling, untrimmed model. Untouched values are kept as they are.
    legacy["Rack-02"] = [{"id": "ci-legacy", "name": "Old NIC", "type": "other", "u": 2, "mac": "aa-bb-cc-dd-ee-ff", "model": " CX6 "}]
    store.ITEMS_FILE.write_text(json.dumps(legacy))
    response = await c.get("/api/rack-items")
    assert response.status_code == 200
    data = response.json()
    assert data["Rack-02"][0]["mac"] == "aa-bb-cc-dd-ee-ff"
    data["Rack-01"][0]["notes"] = "Edited"
    saved = await c.put("/api/rack-items", json=data, headers={"If-Match": response.headers["etag"]})
    assert saved.status_code == 200
    assert saved.json()["Rack-02"][0] == legacy["Rack-02"][0]
    assert "mac" not in saved.json()["Rack-01"][0]
    # The legacy MAC still identifies its unit, and still blocks a second unit with it.
    matches = (await c.get("/api/inventory", params={"code": "AA:BB:CC:DD:EE:FF"})).json()["matches"]
    assert [m["id"] for m in matches] == ["ci-legacy"]
    assert (await c.post("/api/inventory", json={**NEW, "mac": "AABBCCDDEEFF"}, headers=await headers(c))).status_code == 409


def _many_units(count, prefix="U"):
    """`count` new units that each carry a serial, a barcode and a MAC, spread over 20 racks (every value is new)."""
    racks = {}
    for n in range(count):
        racks.setdefault(f"Bulk-{n % 20:02d}", []).append({
            "id": f"{prefix}-{n}", "name": f"Server {n}", "type": "server", "u": n % 42,
            "serial_number": f"SN-{prefix}-{n:05d}", "barcode": f"BC-{prefix}-{n:05d}", "mac": f"02-00-00-00-{n >> 8:02x}-{n & 255:02x}",
        })
    return racks


async def test_whole_list_save_of_1000_new_units_checks_uniqueness_in_linear_time(inventory_client):
    """Every changed serial, barcode and MAC is checked against one identity index of the save, not a rescan of
    every unit per value: 1000 units took ~19 s with the rescan; well under a second with the index."""
    import time
    c = inventory_client
    response = await c.get("/api/rack-items")
    data = {**response.json(), **_many_units(1000)}
    started = time.perf_counter()
    saved = await c.put("/api/rack-items", json=data, headers={"If-Match": response.headers["etag"]})
    elapsed = time.perf_counter() - started
    assert saved.status_code == 200
    assert sum(len(items) for items in store.read_items().values()) == 1001
    assert elapsed < 6, f"saving 1000 units took {elapsed:.1f}s"

    # The same large save still refuses one duplicate anywhere in it, in any spelling, and writes nothing.
    for field, value, detail in (("serial_number", "bc-u-00007", store.DUPLICATE_CODE),
                                 ("barcode", "020000000309", store.DUPLICATE_CODE),
                                 ("mac", "02:00:00:00:00:2a", store.DUPLICATE_MAC)):
        current = await c.get("/api/rack-items")
        edit = current.json()
        target = next(item for item in edit["Bulk-19"] if item["id"] == "U-999")
        if field == "barcode":   # a stored barcode is never replaced by a whole-list save, so a new unit brings it
            edit["Bulk-05"].append({"id": "NEW-1", "name": "New", "type": "server", "u": 1, field: value})
        else:
            target[field] = value
        before = store.ITEMS_FILE.read_bytes()
        refused = await c.put("/api/rack-items", json=edit, headers={"If-Match": current.headers["etag"]})
        assert (refused.status_code, refused.json()["detail"]) == (409, detail), field
        assert store.ITEMS_FILE.read_bytes() == before


async def test_a_legacy_collision_does_not_block_an_unrelated_edit_but_blocks_a_new_copy(inventory_client):
    c = inventory_client
    legacy = json.loads(store.ITEMS_FILE.read_text())
    # Two hand-edited records already share a MAC (in different spellings) and a serial.
    legacy["Rack-02"] = [{"id": "old-a", "name": "A", "type": "other", "u": 2, "mac": "aa-bb-cc-dd-ee-01", "serial_number": "DUP"},
                         {"id": "old-b", "name": "B", "type": "other", "u": 3, "mac": "AABBCCDDEE01", "serial_number": "dup"}]
    store.ITEMS_FILE.write_text(json.dumps(legacy))
    response = await c.get("/api/rack-items")
    data = response.json()
    data["Rack-02"][0]["notes"] = "Unrelated edit"
    data["Rack-01"][0]["mac"] = "02:00:00:00:00:01"
    saved = await c.put("/api/rack-items", json=data, headers={"If-Match": response.headers["etag"]})
    assert saved.status_code == 200
    # A third unit taking that legacy MAC or serial is still refused.
    for change in ({"mac": "aa:bb:cc:dd:ee:01"}, {"serial_number": "Dup"}):
        current = await c.get("/api/rack-items")
        edit = current.json()
        edit["Rack-01"][0].update(change)
        refused = await c.put("/api/rack-items", json=edit, headers={"If-Match": current.headers["etag"]})
        assert refused.status_code == 409, change


def test_identity_index_answers_exactly_like_a_rescan():
    data = {"R1": [{"id": "a", "serial_number": "S1", "mac": "00-1a-2b-3c-4d-5e"}, {"id": "b", "barcode": "001A2B3C4D5E"}],
            "R2": [{"id": "c", "barcode": " Code-1 "}, {"id": "d"}]}
    index = store.identity_index(data)
    for code in ("S1", "s1", "00:1A:2B:3C:4D:5E", "001a.2b3c.4d5e", "code-1", "a", "d", "nothing", "", "  "):
        for exclude in (None, "a", "b", "c", "d"):
            outcomes = []
            for idx in (None, index):
                try:
                    store.ensure_unique(data, code, exclude, index=idx)
                    outcomes.append("ok")
                except Exception as exc:
                    outcomes.append(exc.status_code)
            assert outcomes[0] == outcomes[1], (code, exclude, outcomes)


def test_mac_normalisation():
    assert store.normalize_mac("b8:ce:f6:00:11:22") == "B8:CE:F6:00:11:22"
    assert store.normalize_mac(" B8-CE-F6-00-11-22 ") == "B8:CE:F6:00:11:22"
    assert store.normalize_mac("b8cef6001122") == "B8:CE:F6:00:11:22"
    assert store.normalize_mac("b8ce.f600.1122") == "B8:CE:F6:00:11:22"
    for bad in ("b8:ce:f6:00:11", "b8:ce-f6:00:11:22", "b8cef600112", "zz:ce:f6:00:11:22", "", None, 5):
        assert store.normalize_mac(bad) is None
    # Every spelling of a MAC is one identity key, whether it is stored as a MAC or as a barcode.
    assert store.identity_keys({"id": "x", "barcode": "B8CEF6001122"}) == {"x", "b8:ce:f6:00:11:22"}
    assert store.lookup_keys("b8-ce-f6-00-11-22") == store.lookup_keys("B8CEF6001122") == {"b8:ce:f6:00:11:22"}


async def test_a_mac_names_one_unit_in_every_spelling_as_barcode_or_mac(inventory_client):
    """The duplicate rule compares exactly as a lookup does, so a lookup never finds two units for one MAC."""
    c = inventory_client
    labelled = await c.post("/api/inventory", json={**NEW, "code": "B8CEF6001122"}, headers=await headers(c))
    assert labelled.status_code == 201
    before = store.ITEMS_FILE.read_bytes()
    # A MAC equal to another unit's 12-hex barcode is refused, as are barcodes in other spellings of it.
    for body in ({**NEW, "code": "LABEL-B", "mac": "b8:ce:f6:00:11:22"}, {**NEW, "code": "b8-ce-f6-00-11-22"},
                 {**NEW, "code": "LABEL-C", "serial": "b8ce.f600.1122"}):
        refused = await c.post("/api/inventory", json=body, headers=await headers(c))
        assert refused.status_code == 409, body
    assert store.ITEMS_FILE.read_bytes() == before
    # A unit holding a MAC refuses that MAC as another unit's barcode in any spelling.
    with_mac = await c.post("/api/inventory", json={**NEW, "code": "LABEL-X", "mac": "AA:BB:CC:DD:EE:01"}, headers=await headers(c))
    assert with_mac.status_code == 201
    before = store.ITEMS_FILE.read_bytes()
    for code in ("AA-BB-CC-DD-EE-01", "AABBCCDDEE01", "aabb.ccdd.ee01", "aa:bb:cc:dd:ee:01"):
        refused = await c.post("/api/inventory", json={**NEW, "code": code}, headers=await headers(c))
        assert refused.status_code == 409, code
    assert store.ITEMS_FILE.read_bytes() == before
    # The details endpoint follows the same rule.
    other = labelled.json()["id"]
    refused = await c.post(f"/api/inventory/{other}/details", json={"mac": "aabbccddee01"}, headers=await headers(c))
    assert refused.status_code == 409
    assert refused.json()["detail"] == store.DUPLICATE_MAC
    # Every spelling finds exactly one unit.
    for code, expected in (("B8CEF6001122", labelled), ("B8:CE:F6:00:11:22", labelled), ("aabbccddee01", with_mac)):
        found = (await c.get("/api/inventory", params={"code": code})).json()["matches"]
        assert [m["id"] for m in found] == [expected.json()["id"]], code


@pytest.mark.parametrize("path,method,role", [
    ("/api/inventory", "GET", "Viewer"),
    ("/api/inventory", "POST", "Operator"),
    ("/api/inventory/ci-1/details", "POST", "Operator"),
    ("/api/rack-items", "PUT", "Operator"),
])
def test_permissions_are_unchanged(path, method, role):
    assert accounts.required_role(path, method) == role
