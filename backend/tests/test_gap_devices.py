"""Gap tests for app/routers/devices.py: port labels (full map and single port), sync-map, rename-opt, move-server
(swap / clear / dry-run / restore paths), locations and credential edits.

Every PDU and KVM is a simulated database row; device-reported names come only from the in-memory status caches.
No device, VM or live site is contacted. Layout files, the owners file and the equipment list live in tmp_path."""
import asyncio
import json
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

import app.main as main
from app import inventory_store
from app.database import get_db
from app.engineers import owner_map
from app.models import AssetOwner, Device, Engineer, PingTarget
from app.routers import devices
from app.routers import pdus as pdus_module
from app.routers.devices import get_creds
from app.schemas import OutletState, PduStatus

LAYOUT = {
    "rack_slots.json": {"Rack-01": {"optn44": 3, "optn45 (psu1)": 7}, "Rack-02": {"optn44 (psu2)": 3}},
    "rack_positions.json": {"Rack-01": ["optn45 (psu1)", "optn44", "web-1"]},
    "rack_overrides.json": {"optn45 (psu1)": "Rack-01", "other": "Rack-09"},
    "switch_assignments.json": {"optn44": {"switch": "SW1", "port": "12"}, "optn45 (psu1)": {"switch": "SW2", "port": "3"}},
}
LABELS = {
    "pdu-a": {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "web-1"},
    "pdu-b": {"1": "optn44 (PSU2)", "2": "OPTN45 (PSU2)", "5": "Outlet 5"},
    "kvm-a": {"1": "optn44", "2": "OPTN45"},
}
LABELS_CONFLICT = "Port labels on this device were changed in another session. Reload and try again."


def lab_devices():
    return [
        Device(id="pdu-a", name="PDU-A", kind="pdu", ip="192.0.2.11", rack="Rack-01", port_count=8,
               labels_json=json.dumps(LABELS["pdu-a"])),
        Device(id="pdu-b", name="PDU-B", kind="pdu", ip="192.0.2.12", rack="Rack-02", port_count=8,
               labels_json=json.dumps(LABELS["pdu-b"])),
        Device(id="kvm-a", name="KVM-A", kind="kvm", ip="192.0.2.13", rack="Rack-01", port_count=4,
               labels_json=json.dumps(LABELS["kvm-a"])),
        Device(id="rack-x", name="Rack X", kind="rack", ip="192.0.2.14", rack="Rack-03"),
    ]


def write_layout(folder, layout=LAYOUT):
    for name, data in layout.items():
        (folder / name).write_text(json.dumps(data))


def read_layout(folder, skip=()):
    return {name: json.loads((folder / name).read_text()) for name in LAYOUT
            if name not in skip and (folder / name).exists()}


def snapshot(folder):
    """Every non-lock file in the folder, byte for byte."""
    return {p.name: p.read_bytes() for p in sorted(folder.iterdir()) if p.is_file() and p.suffix != ".lock"}


async def saved_labels(db):
    rows = (await db.execute(select(Device).execution_options(populate_existing=True))).scalars().all()
    return {d.id: json.loads(d.labels_json) for d in rows if d.kind != "rack"}


async def raw_labels(db, device_id):
    dev = await db.scalar(select(Device).where(Device.id == device_id).execution_options(populate_existing=True))
    return dev.labels_json


async def monitors_and_owners(db):
    targets = (await db.execute(select(PingTarget).execution_options(populate_existing=True))).scalars().all()
    owners = (await db.execute(select(AssetOwner).execution_options(populate_existing=True))).scalars().all()
    return (sorted((t.id, t.source_key, t.name, t.host, t.revision) for t in targets),
            sorted((o.asset_key, o.engineer_id or "", o.legacy_name) for o in owners))


def cache_pdu(device_id, outlets):
    """A status as the PDU reported it, in the in-memory cache only (no device is contacted)."""
    pdus_module._cache[device_id] = (time.monotonic(), PduStatus(device_id=device_id, reachable=True, outlets=[
        OutletState(number=n, label=label, state="on") for n, label in outlets.items()]))


@pytest.fixture
async def lab(client, db_session, tmp_path, monkeypatch):
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    monkeypatch.setattr(main, "_OPT_OWNERS_FILE", tmp_path / "opt_owners.json")
    db_session.add_all(lab_devices())
    db_session.add(PingTarget(id="t45", source_key="server:optn45", name="OPTN45", host="optn45"))
    db_session.add(AssetOwner(asset_key="optn45", legacy_name="Roy"))
    await db_session.commit()
    write_layout(tmp_path)
    return SimpleNamespace(client=client, db=db_session, folder=tmp_path)


async def move(lab, **body):
    return await lab.client.post("/api/devices/move-server", json=body)


async def rename(lab, old_name, new_name):
    return await lab.client.post("/api/devices/rename-opt", json={"old_name": old_name, "new_name": new_name})


async def device_row(lab, device_id):
    return next(d for d in (await lab.client.get("/api/devices/")).json() if d["id"] == device_id)


def fail_layout_writes(monkeypatch, numbers):
    """inventory_store.write_json raises OSError on the given 1-based call numbers (the move's writes and restores)."""
    real_write, calls = inventory_store.write_json, []

    def write_json(path, data, *args, **kwargs):
        calls.append(path.name)
        if len(calls) in numbers:
            raise OSError("disk full")
        return real_write(path, data, *args, **kwargs)
    monkeypatch.setattr(inventory_store, "write_json", write_json)
    return calls


# ── PATCH /{id}/labels ─────────────────────────────────────────────────────────────────────────────────────────

async def test_label_port_keys_must_be_ascii_numbers_and_a_removed_legacy_key_is_dropped(lab):
    # Unicode digits pass str.isdigit() but are not port numbers; nothing of the map may be saved.
    for key in ("²", "١", " 1", "1a", "-1"):
        r = await lab.client.patch("/api/devices/pdu-a/labels", json={**LABELS["pdu-a"], key: "OPTN46"})
        assert r.status_code == 422 and r.json()["detail"] == "Port keys must be numbers", key
    assert (await saved_labels(lab.db))["pdu-a"] == LABELS["pdu-a"]
    # A legacy non-numeric key that the editor leaves out is removed, never turned into an "Outlet A1" server name.
    dev = await lab.db.get(Device, "pdu-b")
    dev.labels_json = json.dumps({**LABELS["pdu-b"], "A1": "Legacy"})
    await lab.db.commit()
    r = await lab.client.patch("/api/devices/pdu-b/labels", json=LABELS["pdu-b"])
    assert r.status_code == 200, r.text
    assert (await saved_labels(lab.db))["pdu-b"] == LABELS["pdu-b"]
    assert r.json()["labels_revision"] == inventory_store.revision(LABELS["pdu-b"])


async def test_a_move_and_a_direct_label_write_invalidate_only_the_changed_devices_if_match(lab):
    stale = (await device_row(lab, "pdu-a"))["labels_revision"]
    kvm_revision = (await device_row(lab, "kvm-a"))["labels_revision"]
    r = await lab.client.patch("/api/devices/direct-label", json={"device_id": "pdu-a", "port": "4", "label": "optn46"})
    assert r.status_code == 200, r.text
    r = await lab.client.patch("/api/devices/pdu-a/labels", json={**LABELS["pdu-a"], "5": "x"}, headers={"If-Match": stale})
    assert r.status_code == 409 and r.json()["detail"] == LABELS_CONFLICT
    assert (await saved_labels(lab.db))["pdu-a"] == {**LABELS["pdu-a"], "4": "optn46"}

    # A move rewrites PDU-A's labels: an editor holding the revision from before the move must reload.
    stale = (await device_row(lab, "pdu-a"))["labels_revision"]
    r = await move(lab, server="optn46", target_ports=[{"device_id": "pdu-a", "port": "6"}])
    assert r.status_code == 200, r.text
    r = await lab.client.patch("/api/devices/pdu-a/labels", json={**LABELS["pdu-a"], "4": "optn46"},
                               headers={"If-Match": stale})
    assert r.status_code == 409
    moved = {**LABELS["pdu-a"], "4": "Outlet 4", "6": "optn46"}
    assert (await saved_labels(lab.db))["pdu-a"] == moved
    # KVM-A was not part of either write: its editor's revision is still valid.
    r = await lab.client.patch("/api/devices/kvm-a/labels", json={**LABELS["kvm-a"], "3": "optn48"},
                               headers={"If-Match": kvm_revision})
    assert r.status_code == 200, r.text
    fresh = (await device_row(lab, "pdu-a"))["labels_revision"]
    assert fresh == inventory_store.revision(moved)
    r = await lab.client.patch("/api/devices/pdu-a/labels", json={**moved, "7": "optn49"}, headers={"If-Match": fresh})
    assert r.status_code == 200 and r.json()["labels_revision"] == (await device_row(lab, "pdu-a"))["labels_revision"]


# ── PATCH /direct-label ────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("body,status", [
    ({}, 400),
    ({"device_id": "pdu-a"}, 400),
    ({"port": "4", "label": "optn46"}, 400),
    ({"device_id": "pdu-a", "port": "   ", "label": "optn46"}, 400),
    ({"device_id": "missing", "port": "4", "label": "optn46"}, 404),
])
async def test_direct_label_requires_a_known_device_and_a_port(lab, body, status):
    files = snapshot(lab.folder)
    r = await lab.client.patch("/api/devices/direct-label", json=body)
    assert r.status_code == status, r.text
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files


async def test_direct_label_trims_text_accepts_a_numeric_port_and_changes_only_that_port(lab):
    files, people = snapshot(lab.folder), await monitors_and_owners(lab.db)
    url = "/api/devices/direct-label"
    assert (await lab.client.patch(url, json={"device_id": "pdu-a", "port": 4, "label": "  OPTN46  "})).status_code == 200
    # A whitespace-only label is a clear: the numbered port keeps the default name for its kind.
    assert (await lab.client.patch(url, json={"device_id": "pdu-a", "port": " 3 ", "label": "   "})).status_code == 200
    assert (await lab.client.patch(url, json={"device_id": "kvm-a", "port": "2", "label": "\t"})).status_code == 200
    labels = await saved_labels(lab.db)
    assert labels["pdu-a"] == {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "Outlet 3", "4": "OPTN46"}
    assert labels["kvm-a"] == {"1": "optn44", "2": "Port 2"}
    assert labels["pdu-b"] == LABELS["pdu-b"]
    # No cascade: layout files, monitors and owners stay as they were.
    assert snapshot(lab.folder) == files and await monitors_and_owners(lab.db) == people


async def test_direct_label_expected_is_checked_against_the_saved_label_before_the_device_name(lab):
    url = "/api/devices/direct-label"
    cache_pdu("pdu-a", {1: "hw-one", 4: "hw-four"})
    # Outlet 1 has a saved label: the device's own name, a blank or the default name were never shown for it.
    for shown in ("hw-one", "", "Outlet 1", "OPTN4"):
        r = await lab.client.patch(url, json={"device_id": "pdu-a", "port": "1", "label": "", "expected": shown})
        assert r.status_code == 409, shown
    assert (await saved_labels(lab.db))["pdu-a"] == LABELS["pdu-a"]
    r = await lab.client.patch(url, json={"device_id": "pdu-a", "port": "1", "label": "optn46", "expected": "OPTN44"})
    assert r.status_code == 200 and (await saved_labels(lab.db))["pdu-a"]["1"] == "optn46"
    # Outlet 4 has nothing saved: the name the PDU reports is what the page showed; another name is refused.
    r = await lab.client.patch(url, json={"device_id": "pdu-a", "port": "4", "label": "optn47", "expected": "hw-other"})
    assert r.status_code == 409
    r = await lab.client.patch(url, json={"device_id": "pdu-a", "port": "4", "label": "optn47", "expected": " hw-four "})
    assert r.status_code == 200 and (await saved_labels(lab.db))["pdu-a"]["4"] == "optn47"


async def test_a_non_text_label_or_name_is_refused_not_a_server_error(lab):
    app = FastAPI()
    app.include_router(devices.router)

    async def same_session():
        yield lab.db
    app.dependency_overrides[get_db] = same_session
    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as c:
        label = await c.patch("/api/devices/direct-label", json={"device_id": "pdu-a", "port": "4", "label": 5})
        renamed = await c.post("/api/devices/rename-opt", json={"old_name": ["web-1"], "new_name": "web-2"})
    assert (label.status_code, renamed.status_code) == (400, 400)
    assert await saved_labels(lab.db) == LABELS


# ── GET /sync-map ──────────────────────────────────────────────────────────────────────────────────────────────

async def test_sync_map_groups_labels_case_insensitively_by_device_kind(client, db_session):
    db_session.add_all([
        Device(id="p1", name="PDU-1", kind="pdu", ip="192.0.2.21", labels_json=json.dumps({"1": "OPT11", "2": "", "3": "beta"})),
        Device(id="k1", name="KVM-1", kind="kvm", ip="192.0.2.22", labels_json=json.dumps({"4": "opt11", "5": "Alpha"})),
        Device(id="p2", name="PDU-2", kind="pdu", ip="192.0.2.23", labels_json=""),
    ])
    await db_session.commit()
    r = await client.get("/api/devices/sync-map")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [e["opt_name"].lower() for e in body] == ["alpha", "beta", "opt11"]   # sorted, blank label skipped
    alpha, beta, opt11 = body
    assert (alpha["opt_name"], alpha["pdus"], alpha["kvms"]) == (
        "Alpha", [], [{"device_id": "k1", "device_name": "KVM-1", "port": "5"}])
    assert (beta["opt_name"], beta["pdus"], beta["kvms"]) == (
        "beta", [{"device_id": "p1", "device_name": "PDU-1", "port": "3"}], [])
    # OPT11 and opt11 are one server, linked across the PDU and the KVM.
    assert opt11["pdus"] == [{"device_id": "p1", "device_name": "PDU-1", "port": "1"}]
    assert opt11["kvms"] == [{"device_id": "k1", "device_name": "KVM-1", "port": "4"}]
    assert "192.0.2" not in r.text


# ── POST /rename-opt ───────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("body,detail", [
    ({}, "old_name and new_name required"),
    ({"old_name": "web-1"}, "old_name and new_name required"),
    ({"old_name": "   ", "new_name": "web-2"}, "old_name and new_name required"),
    ({"old_name": "OPTN44", "new_name": " optn44 "}, "Names are identical"),
])
async def test_rename_opt_validates_both_names(lab, body, detail):
    files, people = snapshot(lab.folder), await monitors_and_owners(lab.db)
    r = await lab.client.post("/api/devices/rename-opt", json=body)
    assert r.status_code == 400 and r.json()["detail"] == detail
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files
    assert await monitors_and_owners(lab.db) == people


@pytest.mark.parametrize("new_name,detail", [
    ("OPTN45", "OPTN45 already exists — use Locations to swap or move"),                    # ports + monitor
    ("optn99", "This server name already has an owner. Choose a different name."),            # owner row
    ("optn98 (PSU1)", "This server name already has an owner. Choose a different name."),     # legacy owners file
])
async def test_rename_opt_refuses_a_name_that_already_has_a_monitor_or_owner(lab, new_name, detail):
    lab.db.add(AssetOwner(asset_key="optn99", legacy_name="Dana"))
    await lab.db.commit()
    (lab.folder / "opt_owners.json").write_text(json.dumps({"optn98": "Avi"}))
    files, people = snapshot(lab.folder), await monitors_and_owners(lab.db)
    r = await rename(lab, "web-1", new_name)
    assert r.status_code == 409 and r.json()["detail"] == detail
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files
    assert await monitors_and_owners(lab.db) == people


async def test_rename_opt_carries_monitor_owner_labels_and_every_layout_file(lab):
    layout = json.loads(json.dumps(LAYOUT))
    layout["rack_slots.json"]["Rack-01"]["web-1"] = 9
    layout["rack_overrides.json"]["web-1"] = "Rack-01"
    layout["switch_assignments.json"]["web-1"] = {"switch": "SW3", "port": "1"}
    write_layout(lab.folder, layout)
    lab.db.add(Engineer(id="e1", name="Dana Levi", name_key="dana levi", active=True))
    lab.db.add(AssetOwner(asset_key="web-1", engineer_id="e1"))
    lab.db.add(PingTarget(id="tw", source_key="server:web-1", name="web-1", host="web-1", revision=4))
    await lab.db.commit()

    r = await rename(lab, "WEB-1", "web-2")   # matched without regard to case
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "updated_devices": ["PDU-A"], "device_names": "off",   # name sync is off in tests
                        "labels_revisions": {"pdu-a": inventory_store.revision({**LABELS["pdu-a"], "3": "web-2"})}}
    assert await saved_labels(lab.db) == {**LABELS, "pdu-a": {**LABELS["pdu-a"], "3": "web-2"}}
    targets, owners = await monitors_and_owners(lab.db)
    # Same monitor id and host; a new revision so a probe still in flight for the old name is ignored.
    assert targets == [("t45", "server:optn45", "OPTN45", "optn45", 0), ("tw", "server:web-2", "web-2", "web-1", 5)]
    # The engineer moves to the new key; the old key keeps an empty tombstone so no fallback brings it back.
    assert owners == [("optn45", "", "Roy"), ("web-1", "", ""), ("web-2", "e1", "")]
    assert await owner_map(lab.db) == {"optn45": "Roy", "web-2": "Dana Levi"}
    assert read_layout(lab.folder) == {
        "rack_slots.json": {"Rack-01": {"optn44": 3, "optn45 (psu1)": 7, "web-2": 9}, "Rack-02": {"optn44 (psu2)": 3}},
        "rack_positions.json": {"Rack-01": ["optn45 (psu1)", "optn44", "web-2"]},
        "rack_overrides.json": {"optn45 (psu1)": "Rack-01", "other": "Rack-09", "web-2": "Rack-01"},
        "switch_assignments.json": {**LAYOUT["switch_assignments.json"], "web-2": {"switch": "SW3", "port": "1"}},
    }
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert "web-1" not in rows and (rows["web-2"]["rack"], rows["web-2"]["slot"]) == ("Rack-01", 9)
    assert not list(lab.folder.glob("*.tmp"))


async def test_rename_opt_leaves_an_unreadable_layout_file_untouched(lab):
    (lab.folder / "rack_slots.json").write_text("{not json")
    r = await rename(lab, "web-1", "web-2")
    assert r.status_code == 200, r.text
    assert (lab.folder / "rack_slots.json").read_text() == "{not json"
    positions = read_layout(lab.folder, skip={"rack_slots.json"})["rack_positions.json"]
    assert positions == {"Rack-01": ["optn45 (psu1)", "optn44", "web-2"]}
    assert json.loads(await raw_labels(lab.db, "pdu-a"))["3"] == "web-2"


async def test_rename_opt_of_one_feed_renames_the_whole_server(lab):
    r = await rename(lab, "OPTN45 (PSU1)", "OPTN47 (PSU1)")
    assert r.status_code == 200, r.text
    assert await owner_map(lab.db) == {"optn47": "Roy"}
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert "optn45" not in rows
    assert [(p["device_id"], p["label"]) for p in rows["optn47"]["pdu"] + rows["optn47"]["kvm"]] == [
        ("pdu-a", "OPTN47 (PSU1)"), ("pdu-b", "OPTN47 (PSU2)"), ("kvm-a", "OPTN47")]


async def test_rename_opt_of_a_default_port_name_does_not_relabel_other_devices(lab):
    r = await lab.client.patch("/api/devices/direct-label", json={"device_id": "pdu-a", "port": "5", "label": ""})
    assert r.status_code == 200 and (await saved_labels(lab.db))["pdu-a"]["5"] == "Outlet 5"
    r = await rename(lab, "Outlet 5", "optn50")
    assert r.status_code < 500
    labels = await saved_labels(lab.db)
    assert (labels["pdu-a"]["5"], labels["pdu-b"]["5"]) == ("Outlet 5", "Outlet 5")


# ── POST /move-server: planning ────────────────────────────────────────────────────────────────────────────────

async def test_swap_of_a_dual_feed_opt_with_a_plain_name_server_drops_the_feed_suffix(lab):
    # "web-1 (PSU2)" would be a different server than web-1, so the PSU2 outlet gets the plain name.
    r = await move(lab, server="optn44", target_server="web-1")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(c["device_id"], c["port"], c["before"], c["after"]) for c in body["changes"]] == [
        ("pdu-a", "1", "OPTN44", "web-1"), ("pdu-a", "3", "web-1", "OPTN44"),
        ("pdu-b", "1", "optn44 (PSU2)", "web-1"), ("kvm-a", "1", "optn44", "web-1")]
    assert await saved_labels(lab.db) == {
        "pdu-a": {"1": "web-1", "2": "OPTN45 (PSU1)", "3": "OPTN44"},
        "pdu-b": {"1": "web-1", "2": "OPTN45 (PSU2)", "5": "Outlet 5"},
        "kvm-a": {"1": "web-1", "2": "OPTN45"},
    }
    # Sweep B01 contract C6 (a75b67b, devices.py move_server -> _with_auto_pins): the automatic U numbers in the racks
    # involved are pinned first and the preview carries the U, so web-1 shows its automatic U1 and OPTN44 takes it;
    # OPTN45's PSU2 outlet keeps its automatic U1 in Rack-02.
    assert body["positions"] == [
        {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": "Rack-01", "slot": 1}},
        {"server": "web-1", "before": {"rack": "Rack-01", "slot": 1}, "after": {"rack": "Rack-01", "slot": 3}}]
    assert read_layout(lab.folder) == {
        "rack_slots.json": {"Rack-01": {"web-1": 3, "optn45 (psu1)": 7, "optn44": 1},
                            "Rack-02": {"web-1": 3, "optn45 (psu2)": 1}},
        "rack_positions.json": {"Rack-01": ["optn45 (psu1)", "web-1", "optn44"]},
        "rack_overrides.json": LAYOUT["rack_overrides.json"],
        "switch_assignments.json": {"web-1": {"switch": "SW1", "port": "12"}, "optn45 (psu1)": {"switch": "SW2", "port": "3"}},
    }


async def test_a_server_known_only_by_its_monitor_needs_a_rack_for_a_slot_and_can_take_a_swap(lab):
    lab.db.add(PingTarget(id="t77", source_key="server:optn77", name="OPTN77", host="optn77"))
    await lab.db.commit()
    files = snapshot(lab.folder)
    r = await move(lab, server="optn77", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_slot=4)
    assert r.status_code == 400 and r.json()["detail"] == "Choose a rack for the slot"
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files

    people = await monitors_and_owners(lab.db)
    r = await move(lab, server="optn45", target_server="OPTN77", swap=True)
    assert r.status_code == 200, r.text
    # OPTN77 takes every port of OPTN45 (feed suffixes kept) and its layout entries; OPTN45 keeps only its monitor.
    assert await saved_labels(lab.db) == {
        "pdu-a": {"1": "OPTN44", "2": "OPTN77 (PSU1)", "3": "web-1"},
        "pdu-b": {"1": "optn44 (PSU2)", "2": "OPTN77 (PSU2)", "5": "Outlet 5"},
        "kvm-a": {"1": "optn44", "2": "OPTN77"},
    }
    assert r.json()["positions"] == [
        {"server": "OPTN45", "before": {"rack": "Rack-01", "slot": 7}, "after": {"rack": None, "slot": None}},
        {"server": "OPTN77", "before": {"rack": None, "slot": None}, "after": {"rack": "Rack-01", "slot": 7}}]
    layout = read_layout(lab.folder)
    # Sweep B01 contract C6 (a75b67b, devices.py move_server -> _with_auto_pins): web-1's automatic U1 in Rack-01 and
    # the automatic U1 of the PSU2 outlet in Rack-02 are pinned before the swap renames that outlet's id.
    assert layout["rack_slots.json"] == {"Rack-01": {"optn44": 3, "optn77 (psu1)": 7, "web-1": 1},
                                         "Rack-02": {"optn44 (psu2)": 3, "optn77 (psu2)": 1}}
    assert layout["switch_assignments.json"]["optn77 (psu1)"] == {"switch": "SW2", "port": "3"}
    assert await monitors_and_owners(lab.db) == people     # monitors and owners follow the server, not the location
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert (rows["optn45"]["rack"], rows["optn45"]["pdu"], rows["optn45"]["kvm"]) == (None, [], [])
    assert (rows["optn77"]["rack"], rows["optn77"]["slot"]) == ("Rack-01", 7)


async def test_moving_to_ports_with_only_a_rack_drops_the_old_slot_and_keeps_the_switch_port(lab):
    r = await move(lab, server="optn44", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="  Rack-05  ")
    assert r.status_code == 200, r.text
    assert r.json()["positions"] == [
        {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": "Rack-05", "slot": None}}]
    assert await saved_labels(lab.db) == {
        "pdu-a": {"1": "Outlet 1", "2": "OPTN45 (PSU1)", "3": "web-1", "4": "OPTN44"},
        "pdu-b": {"1": "Outlet 1", "2": "OPTN45 (PSU2)", "5": "Outlet 5"},
        "kvm-a": {"1": "Port 1", "2": "OPTN45"},
    }
    # Sweep B01 contract C6 (a75b67b, devices.py move_server -> _with_auto_pins): the automatic U numbers of the
    # neighbours in the racks OPTN44 leaves (web-1 in Rack-01, OPTN45's PSU2 outlet in Rack-02) are pinned.
    assert read_layout(lab.folder) == {
        "rack_slots.json": {"Rack-01": {"optn45 (psu1)": 7, "web-1": 1}, "Rack-02": {"optn45 (psu2)": 1}},
        "rack_positions.json": {"Rack-01": ["optn45 (psu1)", "web-1"]},
        "rack_overrides.json": {**LAYOUT["rack_overrides.json"], "optn44": "Rack-05"},
        "switch_assignments.json": LAYOUT["switch_assignments.json"],
    }
    body = (await lab.client.get("/api/devices/locations")).json()
    rows = {s["key"]: s for s in body["servers"]}
    assert (rows["optn44"]["rack"], rows["optn44"]["slot"]) == ("Rack-05", None)
    assert "Rack-05" in body["racks"]


@pytest.mark.parametrize("extra", [
    {"target_slot": 1000},
    {"target_slot": True},
    {"target_slot": 3.0},
    {"target_rack": 5},
    {"target_rack": "R" * 201},
    {"target_ports": [{"device_id": "pdu-a", "port": True}]},
    {"target_ports": [{"device_id": "pdu-a", "port": "-1"}]},
    {"target_ports": {"device_id": "pdu-a", "port": "4"}},
    {"server": 5},
    {"target_ports": None, "target_server": "Outlet 3"},
])
async def test_more_invalid_move_inputs_are_refused_and_write_nothing(lab, extra):
    files = snapshot(lab.folder)
    body = {"server": "web-1", "target_ports": [{"device_id": "pdu-a", "port": "4"}], **extra}
    r = await move(lab, **body)
    assert r.status_code == 400, r.text
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files


@pytest.mark.parametrize("raw", ["{broken", '["OPTN44"]'])
async def test_unreadable_saved_labels_block_only_moves_that_change_that_device(lab, raw):
    dev = await lab.db.get(Device, "pdu-b")
    dev.labels_json = raw
    await lab.db.commit()
    files = snapshot(lab.folder)
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-b", "port": "7"}])
    assert r.status_code == 503
    assert r.json()["detail"] == "The saved port labels of PDU-B cannot be read, so nothing was moved."
    assert await raw_labels(lab.db, "pdu-b") == raw and snapshot(lab.folder) == files
    assert json.loads(await raw_labels(lab.db, "pdu-a")) == LABELS["pdu-a"]
    assert (await lab.client.get("/api/devices/locations")).status_code == 200
    # A move that leaves PDU-B alone goes ahead and never rewrites its unreadable labels.
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 200, r.text
    assert await raw_labels(lab.db, "pdu-b") == raw
    assert json.loads(await raw_labels(lab.db, "pdu-a")) == {"1": "OPTN45", "2": "OPTN44 (PSU1)", "3": "web-1"}
    assert json.loads(await raw_labels(lab.db, "kvm-a")) == {"1": "OPTN45", "2": "OPTN44"}


# ── POST /move-server: failure and restore paths ───────────────────────────────────────────────────────────────

async def test_a_layout_file_created_by_a_failed_move_is_removed_again(lab, monkeypatch):
    (lab.folder / "rack_overrides.json").unlink()
    before = read_layout(lab.folder)
    calls = fail_layout_writes(monkeypatch, {2})
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="Rack-02", target_slot=1)
    assert r.status_code == 503 and r.json()["detail"] == devices._MOVE_FAILED
    # rack_overrides.json was created by write 1; it is deleted (not written back as {}), rack_positions is restored.
    assert calls == ["rack_overrides.json", "rack_positions.json", "rack_positions.json"]
    assert not (lab.folder / "rack_overrides.json").exists()
    assert read_layout(lab.folder) == before
    assert await saved_labels(lab.db) == LABELS
    assert not list(lab.folder.glob("*.tmp"))


@pytest.mark.parametrize("failing,expected", [
    ({1}, devices._MOVE_HALF_SAVED),
    ({2, 3}, devices._MOVE_NOT_RESTORED.format(files="rack_overrides.json")
     + " The port labels could not be put back either."),
])
async def test_labels_that_cannot_be_put_back_are_reported_honestly(lab, monkeypatch, failing, expected):
    before = read_layout(lab.folder)
    real_commit, commits = lab.db.commit, []

    async def commit():
        commits.append(1)
        if len(commits) > 1:
            raise RuntimeError("disk I/O error")
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", commit)
    fail_layout_writes(monkeypatch, failing)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 503 and r.json()["detail"] == expected
    assert len(commits) == 2                              # the labels commit, then the failed revert
    assert "disk" not in r.text and str(lab.folder) not in r.text
    # The first commit stays: the answer must not claim that nothing changed.
    assert (await saved_labels(lab.db))["pdu-a"] == {"1": "OPTN45", "2": "OPTN44 (PSU1)", "3": "web-1"}
    after = read_layout(lab.folder)
    assert after["rack_positions.json"] == before["rack_positions.json"]
    assert (after["rack_overrides.json"] == before["rack_overrides.json"]) is (failing == {1})


async def test_a_layout_file_corrupted_during_the_commit_refuses_the_move_and_puts_labels_back(lab, monkeypatch):
    path, real_commit, commits = lab.folder / "rack_positions.json", lab.db.commit, []

    async def commit():
        commits.append(1)
        if len(commits) == 1:
            path.write_text("[1, 2")          # another writer leaves the file unreadable while the labels commit
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 503
    assert r.json()["detail"] == "The rack layout file rack_positions.json cannot be read, so nothing was moved."
    assert len(commits) == 2 and await saved_labels(lab.db) == LABELS
    assert path.read_text() == "[1, 2"
    assert read_layout(lab.folder, skip={"rack_positions.json"}) == {
        k: v for k, v in LAYOUT.items() if k != "rack_positions.json"}
    # The layout locks were released: a listing still works.
    assert (await lab.client.get("/api/devices/locations")).status_code == 200


async def test_a_concurrent_save_that_makes_the_move_impossible_is_reported_as_a_layout_change(lab, monkeypatch):
    path, real_commit, commits = lab.folder / "rack_slots.json", lab.db.commit, []
    other = {**LAYOUT["rack_slots.json"], "Rack-05": ["kept"]}

    async def commit():
        commits.append(1)
        if len(commits) == 1:
            await asyncio.to_thread(inventory_store.save_layout, path, other, None, {})
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="Rack-05", target_slot=2)
    assert r.status_code == 409 and r.json()["detail"] == devices._LAYOUT_CHANGED
    assert len(commits) == 2 and await saved_labels(lab.db) == LABELS
    assert json.loads(path.read_text()) == other          # only the other session's save
    assert read_layout(lab.folder, skip={"rack_slots.json"}) == {
        k: v for k, v in LAYOUT.items() if k != "rack_slots.json"}


# ── GET /locations ─────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value,slot", [
    (3, 3), ("12", 12), (" 7 ", 7), ("0012", 12), (3.0, 3), (9999, 9999),
    (3.5, None), (True, None), (0, None), (-2, None), (10000, None), ("12345", None), ("", None), ("U4", None),
])
async def test_locations_reads_rack_slot_values_strictly(lab, value, slot):
    (lab.folder / "rack_slots.json").write_text(json.dumps({"Rack-01": {"optn44": value}}))
    r = await lab.client.get("/api/devices/locations")
    assert r.status_code == 200, r.text
    row = next(s for s in r.json()["servers"] if s["key"] == "optn44")
    assert (row["rack"], row["slot"]) == ("Rack-01", slot)


async def test_locations_caps_empty_ports_names_monitor_only_servers_and_survives_a_bad_equipment_list(lab):
    dev = await lab.db.get(Device, "kvm-a")
    dev.port_count = 10 ** 6
    lab.db.add(PingTarget(id="t78", source_key="server:optn78", name="Bench box", host="optn78"))
    lab.db.add(PingTarget(id="m1", source_key="manual:192.0.2.80", name="optn80", host="192.0.2.80"))
    await lab.db.commit()
    (lab.folder / "rack_items.json").write_text("{oops")
    r = await lab.client.get("/api/devices/locations")
    assert r.status_code == 200, r.text
    body = r.json()
    # At most 512 ports are listed per device (ports 1 and 2 are used).
    assert [p["port"] for p in body["empty_ports"]["kvm"]] == [str(n) for n in range(3, 513)]
    rows = {s["key"]: s for s in body["servers"]}
    # A monitor whose name is another identity is listed under its key; a non-server monitor is not a server.
    assert (rows["optn78"]["name"], rows["optn78"]["rack"], rows["optn78"]["pdu"]) == ("optn78", None, [])
    assert "optn80" not in rows and "bench box" not in rows
    assert body["racks"] == ["Rack-01", "Rack-02", "Rack-03", "Rack-09"]   # the unreadable equipment list adds none


# ── PUT /{id}: credentials ─────────────────────────────────────────────────────────────────────────────────────

async def test_device_edit_without_credentials_keeps_the_saved_ones_encrypted(client, db_session):
    body = {"name": "KVM-9", "kind": "kvm", "ip": "192.0.2.50", "model": "KX III", "rack": "R1", "port_count": 8}
    r = await client.post("/api/devices/", json={**body, "username": "admin", "password": "s3cr3t-pw"})
    assert r.status_code == 201
    dev_id = r.json()["id"]

    async def stored():
        return await db_session.scalar(select(Device).where(Device.id == dev_id).execution_options(populate_existing=True))
    row = await stored()
    assert "admin" not in row.username_enc and "s3cr3t-pw" not in row.password_enc
    assert get_creds(row) == ("admin", "s3cr3t-pw")
    r = await client.put(f"/api/devices/{dev_id}", json={**body, "notes": "moved to R2", "rack": "R2"})
    assert r.status_code == 200 and r.json()["rack"] == "R2"
    assert "s3cr3t-pw" not in r.text and "password" not in r.json()
    assert get_creds(await stored()) == ("admin", "s3cr3t-pw")
    r = await client.put(f"/api/devices/{dev_id}", json={**body, "password": "n3w-pass"})
    assert r.status_code == 200
    row = await stored()
    assert get_creds(row) == ("admin", "n3w-pass") and "n3w-pass" not in row.password_enc
