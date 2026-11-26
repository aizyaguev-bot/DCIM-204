"""PUT /api/rack-layout: the Twin's server move writes rack_slots, rack_positions and rack_overrides all or nothing."""
import json
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from app import changes, inventory_store
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


# ── rack_items: the units on a server's floor move with it, in the same all-or-nothing save ──────────────────────
ITEMS_BEFORE = {"Rack-01": [{"id": "unit-a", "name": "Shelf A", "type": "switch", "u": 5, "barcode": "BC-A",
                             "serial_number": "SN-A"},
                            {"id": "unit-b", "name": "Shelf B", "type": "storage", "u": 9}],
                "Rack-02": []}
# unit-a goes with OPT11 to Rack-02 U4. The page's copy has no barcode (a stale copy): the stored one is kept.
ITEMS_AFTER = {"Rack-01": [{"id": "unit-b", "name": "Shelf B", "type": "storage", "u": 9}],
               "Rack-02": [{"id": "unit-a", "name": "Shelf A", "type": "switch", "u": 4, "serial_number": "SN-A"}]}


@pytest.fixture
async def items(layout, monkeypatch):
    client, folder = layout
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", folder / "rack_items.json")
    inventory_store.ITEMS_FILE.write_text(json.dumps(ITEMS_BEFORE))
    seed()
    return client, folder


async def all_etags(client):
    return {**(await etags(client)), "rack_items": (await client.get("/api/rack-items")).headers["etag"]}


def with_items(tags, data=ITEMS_AFTER, **kwargs):
    return {**body(tags, **kwargs), "rack_items": {"data": data, "if_match": tags["rack_items"]}}


def snapshot_files():
    return {**{name: path_of(name).read_bytes() for name in FILES}, "rack_items": inventory_store.ITEMS_FILE.read_bytes()}


async def test_rack_items_are_saved_with_the_layout_and_checked_like_put_rack_items(items):
    client, folder = items
    r = await client.put("/api/rack-layout", json=with_items(await all_etags(client)))
    assert r.status_code == 200, r.text
    saved = json.loads(inventory_store.ITEMS_FILE.read_text())
    assert r.json()["rack_items"] == saved
    assert r.json()["revisions"] == {**{name: inventory_store.revision(AFTER[name]) for name in AFTER},
                                     "rack_items": inventory_store.revision(saved)}
    assert (await client.get("/api/rack-items")).headers["etag"] == r.json()["revisions"]["rack_items"]
    moved_unit = saved["Rack-02"][0]
    assert moved_unit["barcode"] == "BC-A", "a linked barcode is never dropped by a stale copy"
    assert [(e["action"], e["from"], e["to"], e["note"]) for e in moved_unit["tracking_history"]] == [
        ("moved", {"rack": "Rack-01", "u": 5, "position": ""}, {"rack": "Rack-02", "u": 4, "position": ""},
         inventory_store.MOVED_WITH_SERVER_NOTE)]
    assert "tracking_history" not in saved["Rack-01"][0], "a unit that stayed gets no history entry"
    for name in FILES:
        assert json.loads(path_of(name).read_text()) == AFTER[name]
    assert not list(folder.glob("*.tmp")) and not list(folder.glob(".*.tmp"))


async def test_rack_items_alone_and_the_live_sync_domains(items):
    client, _ = items
    before = changes.current()
    tags = await all_etags(client)
    r = await client.put("/api/rack-layout", json={"rack_items": {"data": ITEMS_AFTER, "if_match": tags["rack_items"]}})
    assert r.status_code == 200, r.text
    assert set(r.json()["revisions"]) == {"rack_items"}
    middle = changes.current()
    assert middle["rev"] == before["rev"] + 1
    assert {d for d in changes.DOMAINS if middle["domains"][d] != before["domains"][d]} == {"layout", "inventory"}
    r = await client.put("/api/rack-layout", json=body(await etags(client)))
    assert r.status_code == 200 and "rack_items" not in r.json()
    after = changes.current()
    assert {d for d in changes.DOMAINS if after["domains"][d] != middle["domains"][d]} == {"layout"}


@pytest.mark.parametrize("stale", ["rack_items", "rack_positions"])
async def test_a_stale_revision_of_any_part_is_409_and_nothing_is_written(items, stale):
    client, _ = items
    tags = await all_etags(client)
    if stale == "rack_items":   # another session saved the units meanwhile
        inventory_store.ITEMS_FILE.write_text(json.dumps({**ITEMS_BEFORE, "Rack-03": []}))
    else:
        path_of("rack_positions").write_text(json.dumps({"Rack-01": ["opt12", "opt11"]}))
    before, rev = snapshot_files(), changes.current()["rev"]
    r = await client.put("/api/rack-layout", json=with_items(tags))
    assert r.status_code == 409 and r.json() == {"detail": inventory_store.LAYOUT_CONFLICT}
    assert snapshot_files() == before
    assert changes.current()["rev"] == rev, "a refused save counts nothing for live sync"


@pytest.mark.parametrize("data,status,detail", [
    ({**ITEMS_AFTER, "Rack-02": [{**ITEMS_AFTER["Rack-02"][0], "u": 99}]}, 422, inventory_store.U_SLOT_INVALID),
    ({**ITEMS_AFTER, "Rack-03": [{"id": "unit-c", "u": 1, "barcode": "bc-a"}]}, 409, inventory_store.DUPLICATE_CODE),
    ({**ITEMS_AFTER, "Rack-03": [{"id": "unit-a", "u": 1}]}, 422, "Every equipment item needs a unique ID."),
    ({"Rack-01": "not a list"}, 422, "Expected racks containing equipment lists."),
])
async def test_invalid_rack_items_are_refused_before_anything_is_written(items, data, status, detail):
    client, _ = items
    tags = await all_etags(client)
    before = snapshot_files()
    r = await client.put("/api/rack-layout", json=with_items(tags, data))
    assert r.status_code == status and r.json()["detail"] == detail
    assert snapshot_files() == before


async def test_rack_items_need_their_revision(items):
    client, _ = items
    tags = await all_etags(client)
    before = snapshot_files()
    no_tag = with_items(tags)
    no_tag["rack_items"].pop("if_match")
    assert (await client.put("/api/rack-layout", json=no_tag)).status_code == 422
    empty_tag = with_items({**tags, "rack_items": ""})
    assert (await client.put("/api/rack-layout", json=empty_tag)).status_code == 428
    assert snapshot_files() == before


async def test_a_failed_rack_items_write_puts_the_layout_back(items, monkeypatch):
    client, folder = items
    tags = await all_etags(client)
    before = snapshot_files()
    real_write = inventory_store.write_json

    def failing_items_write(path, data, *args, **kwargs):
        if path == inventory_store.ITEMS_FILE:
            raise OSError("disk full")
        return real_write(path, data, *args, **kwargs)
    monkeypatch.setattr(inventory_store, "write_json", failing_items_write)
    r = await client.put("/api/rack-layout", json=with_items(tags))
    assert r.status_code == 503 and r.json()["detail"] == inventory_store.LAYOUT_SAVE_FAILED
    assert snapshot_files() == before
    assert not list(folder.glob("*.tmp")) and not list(folder.glob(".*.tmp"))


# ── port_labels: PDU outlets and KVM ports stay with their floors; a swap rewrites their labels in the same save ────
# Owner, 2026-11-10: "The location of the PDU and the KVM is static". Rack-01: floor 1 is fed by PDU-A outlet 1 and
# KVM-A port 1, floor 2 by outlet 2 and port 2. OPT11 (floor 1) and OPT12 (floor 2) swap floors: each one takes over
# the outlet and port of the floor it lands on, the units on each floor go with their server, the devices stay.
LABELS_BEFORE = {"pdu-a": {"1": "OPT11", "2": "OPT12", "3": "KVM Power", "4": "Empty"},
                 "kvm-a": {"1": "OPT11", "2": "OPT12"}}
LABELS_AFTER = {"pdu-a": {"1": "OPT12", "2": "OPT11", "3": "KVM Power", "4": "Empty"},
                "kvm-a": {"1": "OPT12", "2": "OPT11"}}
SWAP_BEFORE = {"rack_slots": {"Rack-01": {"opt11": 1, "opt12": 2, "kvm power": 3}},
               "rack_positions": {"Rack-01": ["opt11", "opt12", "empty"]},
               "rack_overrides": {"opt99": "Rack-03", "outlet 4": "Rack-01"}}
# What the page sends: the swap, with the placeholder keys an older save left there (and one more it added).
SWAP_SENT = {"rack_slots": {"Rack-01": {"opt11": 2, "opt12": 1, "kvm power": 3, "Empty": 4}},
             "rack_positions": {"Rack-01": ["opt12", "opt11", "empty", "--"], "Rack-02": "kept as it is"},
             "rack_overrides": {"opt99": "Rack-03", "outlet 4": "Rack-01", "spare": "Rack-01"}}
# What is stored: placeholder outlet labels are never servers in the layout stores.
SWAP_STORED = {"rack_slots": {"Rack-01": {"opt11": 2, "opt12": 1}},
               "rack_positions": {"Rack-01": ["opt12", "opt11"], "Rack-02": "kept as it is"},
               "rack_overrides": {"opt99": "Rack-03"}}
SWAP_ITEMS_BEFORE = {"Rack-01": [{"id": "nic-11", "name": "NIC shelf", "type": "switch", "u": 1},
                                 {"id": "disk-12", "name": "Disk tray", "type": "storage", "u": 2}]}
SWAP_ITEMS_AFTER = {"Rack-01": [{"id": "nic-11", "name": "NIC shelf", "type": "switch", "u": 2},
                                {"id": "disk-12", "name": "Disk tray", "type": "storage", "u": 1}]}


@pytest.fixture
async def floors(layout, db_session, monkeypatch):
    """Rack-01 with a simulated PDU and KVM (never contacted), the layout stores and units of the swap above."""
    from app.models import Device
    from app.routers import devices
    client, folder = layout
    monkeypatch.setattr(devices, "_BACKEND_DIR", folder)   # Locations reads the same layout files the save writes
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", folder / "rack_items.json")
    inventory_store.ITEMS_FILE.write_text(json.dumps(SWAP_ITEMS_BEFORE))
    for name, data in SWAP_BEFORE.items():
        path_of(name).write_text(json.dumps(data))
    db_session.add_all([
        Device(id="pdu-a", name="PDU-A", kind="pdu", ip="192.0.2.11", rack="Rack-01", port_count=8,
               labels_json=json.dumps(LABELS_BEFORE["pdu-a"])),
        Device(id="kvm-a", name="KVM-A", kind="kvm", ip="192.0.2.13", rack="Rack-01", port_count=4,
               labels_json=json.dumps(LABELS_BEFORE["kvm-a"])),
    ])
    await db_session.commit()
    return client, folder, db_session


async def label_tags(client):
    return {d["id"]: d["labels_revision"] for d in (await client.get("/api/devices/")).json()}


def swap_body(tags, labels_tags, sent=SWAP_SENT, labels=LABELS_AFTER, items=SWAP_ITEMS_AFTER):
    out = {name: {"data": sent[name], "if_match": tags[name]} for name in FILES}
    if items is not None:
        out["rack_items"] = {"data": items, "if_match": tags["rack_items"]}
    out["port_labels"] = {device_id: {"data": labels[device_id], "if_match": labels_tags[device_id]} for device_id in labels}
    return out


async def stored_labels(db):
    from sqlalchemy import select
    from app.models import Device
    rows = (await db.execute(select(Device).execution_options(populate_existing=True))).scalars().all()
    return {d.id: (json.loads(d.labels_json), d.rack, d.kind) for d in rows}


def moved_domains(before, after):
    return {d for d in changes.DOMAINS if after["domains"][d] != before["domains"][d]}


async def test_a_swap_moves_the_servers_their_units_and_the_floors_outlet_and_port_labels_together(floors):
    client, folder, db = floors
    before = changes.current()
    r = await client.put("/api/rack-layout", json=swap_body(await all_etags(client), await label_tags(client)))
    assert r.status_code == 200, r.text
    answer = r.json()
    assert answer["labels_revisions"] == {d: inventory_store.revision(LABELS_AFTER[d]) for d in LABELS_AFTER}
    assert answer["labels_revisions"] == await label_tags(client)
    assert answer["device_names"] == "off"   # name sync is off in tests: no PDU/KVM is ever contacted
    # Each floor keeps its outlet and port; the PDU and KVM themselves did not move.
    assert await stored_labels(db) == {"pdu-a": (LABELS_AFTER["pdu-a"], "Rack-01", "pdu"),
                                       "kvm-a": (LABELS_AFTER["kvm-a"], "Rack-01", "kvm")}
    for name in FILES:
        assert json.loads(path_of(name).read_text()) == SWAP_STORED[name]
        assert answer["revisions"][name] == inventory_store.revision(SWAP_STORED[name])
        assert (await client.get(URLS[name])).headers["etag"] == answer["revisions"][name]
    saved = json.loads(inventory_store.ITEMS_FILE.read_text())
    assert {i["id"]: i["u"] for i in saved["Rack-01"]} == {"nic-11": 2, "disk-12": 1}, "units moved with their servers"
    assert answer["rack_items"] == saved
    # Locations (and so Dashboard / Power / Consoles) show each server on the outlet and port of its new floor.
    servers = {s["name"]: s for s in (await client.get("/api/devices/locations")).json()["servers"]}
    assert {n: (s["rack"], s["slot"], [p["port"] for p in s["pdu"]], [p["port"] for p in s["kvm"]])
            for n, s in servers.items() if n != "opt99"} == {"OPT11": ("Rack-01", 2, ["2"], ["2"]),
                                                            "OPT12": ("Rack-01", 1, ["1"], ["1"])}
    after = changes.current()
    assert after["rev"] == before["rev"] + 1
    assert moved_domains(before, after) == {"layout", "inventory", "devices", "monitoring"}
    assert not list(folder.glob("*.tmp")) and not list(folder.glob(".*.tmp"))


async def test_port_labels_alone_or_without_units(floors):
    client, _, db = floors
    tags, labels_tags = await all_etags(client), await label_tags(client)
    r = await client.put("/api/rack-layout", json=swap_body(tags, labels_tags, items=None))
    assert r.status_code == 200, r.text
    assert set(r.json()["revisions"]) == set(FILES) and "rack_items" not in r.json()
    assert json.loads(inventory_store.ITEMS_FILE.read_text()) == SWAP_ITEMS_BEFORE
    # Labels alone (the layout already right): saved as PATCH /labels would save them.
    back = {"pdu-a": LABELS_BEFORE["pdu-a"]}
    r = await client.put("/api/rack-layout", json={"port_labels": {"pdu-a": {"data": back["pdu-a"],
                                                                              "if_match": (await label_tags(client))["pdu-a"]}}})
    assert r.status_code == 200, r.text
    assert r.json()["revisions"] == {} and set(r.json()["labels_revisions"]) == {"pdu-a"}
    assert (await stored_labels(db))["pdu-a"][0] == LABELS_BEFORE["pdu-a"]


@pytest.mark.parametrize("stale", ["labels", "rack_slots", "rack_items"])
async def test_a_stale_part_is_409_and_neither_labels_nor_files_change(floors, stale):
    client, _, db = floors
    tags, labels_tags = await all_etags(client), await label_tags(client)
    if stale == "labels":   # another session relabelled an outlet meanwhile
        r = await client.patch("/api/devices/kvm-a/labels", json={**LABELS_BEFORE["kvm-a"], "3": "OPT13"})
        assert r.status_code == 200, r.text
    elif stale == "rack_slots":
        path_of("rack_slots").write_text(json.dumps({"Rack-01": {"opt11": 1, "opt12": 2, "opt13": 3}}))
    else:
        inventory_store.ITEMS_FILE.write_text(json.dumps({**SWAP_ITEMS_BEFORE, "Rack-02": []}))
    files, labels, rev = snapshot_files(), await stored_labels(db), changes.current()["rev"]
    r = await client.put("/api/rack-layout", json=swap_body(tags, labels_tags))
    from app.routers import devices
    want = devices.LAYOUT_LABELS_CHANGED if stale == "labels" else inventory_store.LAYOUT_CONFLICT
    assert r.status_code == 409 and r.json() == {"detail": want}
    assert snapshot_files() == files
    assert await stored_labels(db) == labels, "nothing committed: the labels were never changed, not even briefly"
    assert changes.current()["rev"] == rev


async def test_invalid_units_are_refused_before_the_labels_are_committed(floors):
    client, _, db = floors
    tags, labels_tags = await all_etags(client), await label_tags(client)
    files, labels = snapshot_files(), await stored_labels(db)
    bad = {"Rack-01": [{**SWAP_ITEMS_AFTER["Rack-01"][0], "u": 99}, SWAP_ITEMS_AFTER["Rack-01"][1]]}
    r = await client.put("/api/rack-layout", json=swap_body(tags, labels_tags, items=bad))
    assert r.status_code == 422 and r.json()["detail"] == inventory_store.U_SLOT_INVALID
    assert snapshot_files() == files and await stored_labels(db) == labels


async def test_a_failed_layout_write_puts_the_labels_back(floors, monkeypatch):
    client, folder, db = floors
    tags, labels_tags = await all_etags(client), await label_tags(client)
    files, labels = snapshot_files(), await stored_labels(db)
    before = changes.current()
    real_write = inventory_store.write_json

    def failing_items_write(path, data, *args, **kwargs):
        if path == inventory_store.ITEMS_FILE:
            raise OSError("disk full")
        return real_write(path, data, *args, **kwargs)
    monkeypatch.setattr(inventory_store, "write_json", failing_items_write)
    r = await client.put("/api/rack-layout", json=swap_body(tags, labels_tags))
    assert r.status_code == 503 and r.json()["detail"] == inventory_store.LAYOUT_SAVE_FAILED
    assert snapshot_files() == files
    assert await stored_labels(db) == labels, "the labels committed first were put back"
    # Pages that read the labels in between reload them; the layout and units did not change.
    assert moved_domains(before, changes.current()) == {"devices", "monitoring"}
    assert not list(folder.glob("*.tmp")) and not list(folder.glob(".*.tmp"))


@pytest.mark.parametrize("port_labels,status", [
    ({}, 422),
    ({"pdu-a": {"data": LABELS_AFTER["pdu-a"]}}, 422),                                   # no labels_revision
    ({"pdu-a": {"data": ["OPT12"], "if_match": "x"}}, 422),
    ({"pdu-x": {"data": {"1": "OPT12"}, "if_match": "x"}}, 404),                          # unknown device
    ({"pdu-a": {"data": {**LABELS_AFTER["pdu-a"], "A1": "OPT12"}, "if_match": None}}, 422),  # new key: not a number
    ({"pdu-a": {"data": {**LABELS_AFTER["pdu-a"], "5": 7}, "if_match": None}}, 422),        # not text
    ({"chiller-1": {"data": {"1": "OPT12"}, "if_match": None}}, 422),                    # not a PDU or KVM
])
async def test_port_labels_follow_the_rules_of_patch_labels(floors, port_labels, status):
    from app.models import Device
    client, _, db = floors
    db.add(Device(id="chiller-1", name="Chiller", kind="chiller", ip="192.0.2.20", rack="Rack-01"))
    await db.commit()
    labels_tags = await label_tags(client)
    port_labels = {k: {**v, "if_match": labels_tags.get(k, "x")} if isinstance(v, dict) and "if_match" in v
                   and v["if_match"] is None else v for k, v in port_labels.items()}
    files, labels = snapshot_files(), await stored_labels(db)
    r = await client.put("/api/rack-layout", json={**swap_body(await all_etags(client), labels_tags),
                                                   "port_labels": port_labels})
    assert r.status_code == status, r.text
    assert snapshot_files() == files and await stored_labels(db) == labels


async def test_placeholder_outlet_labels_are_never_stored_as_servers():
    import app.main as main
    assert main._servers_only("rack_slots", SWAP_SENT["rack_slots"]) == SWAP_STORED["rack_slots"]
    assert main._servers_only("rack_positions", SWAP_SENT["rack_positions"]) == SWAP_STORED["rack_positions"]
    assert main._servers_only("rack_overrides", SWAP_SENT["rack_overrides"]) == SWAP_STORED["rack_overrides"]
    kept = {"Rack-01": {"opt11": 1, "srv-a (psu2)": 2, "Outlet A1": 3}, "Rack-02": [1]}
    assert main._servers_only("rack_slots", kept) == kept
    assert main._servers_only("rack_overrides", {"Port 2": "R", "n/a": "R", "KVM_power": "R", "pdu": "R"}) == {}
