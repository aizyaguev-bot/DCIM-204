"""HF-2391: a port label edit changes only that device; servers move or swap locations only through /move-server.

All devices are simulated database rows; no PDU or KVM is contacted."""
import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, inventory_store
from app.database import Base, get_db
from app.models import AssetOwner, Device, PingTarget, User
from app.routers import devices
from app.routers import pdus as pdus_module
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


def read_layout(folder):
    return {name: json.loads((folder / name).read_text()) for name in LAYOUT if (folder / name).exists()}


def snapshot(folder, locks=False):
    """File contents in the folder; the layout stores' empty *.lock files only when asked (a refused write may take
    the per-file locks, as the layout PUT endpoints do)."""
    return {p.name: p.read_bytes() for p in sorted(folder.iterdir())
            if p.is_file() and (locks or p.suffix != ".lock")}


async def saved_labels(db):
    rows = (await db.execute(select(Device).execution_options(populate_existing=True))).scalars().all()
    return {d.id: json.loads(d.labels_json) for d in rows if d.kind != "rack"}


@pytest.fixture
async def lab(client, db_session, tmp_path, monkeypatch):
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    db_session.add_all(lab_devices())
    db_session.add(PingTarget(id="t45", source_key="server:optn45", name="OPTN45", host="optn45"))
    db_session.add(AssetOwner(asset_key="optn45", legacy_name="Roy"))
    await db_session.commit()
    write_layout(tmp_path)
    return SimpleNamespace(client=client, db=db_session, folder=tmp_path)


async def move(lab, **body):
    return await lab.client.post("/api/devices/move-server", json=body)


async def monitors_and_owners(db):
    targets = (await db.execute(select(PingTarget).execution_options(populate_existing=True))).scalars().all()
    owners = (await db.execute(select(AssetOwner).execution_options(populate_existing=True))).scalars().all()
    return ([(t.id, t.source_key, t.name, t.revision) for t in targets],
            [(o.asset_key, o.engineer_id, o.legacy_name) for o in owners])


# ── 1. PATCH labels never cascades ──────────────────────────────────────────────────────────────────────────────

async def test_label_edit_changes_only_that_device_not_monitors_owners_or_layout(lab):
    files, people = snapshot(lab.folder), await monitors_and_owners(lab.db)
    revision = inventory_store.revision(LABELS["pdu-a"])
    # The owner's incident: writing optn45 on the port that held OPTN44 must not turn OPTN44 into optn45 everywhere.
    r = await lab.client.patch("/api/devices/pdu-a/labels", json={**LABELS["pdu-a"], "1": "optn45"},
                               headers={"If-Match": revision})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "synced": [], "labels_revision": inventory_store.revision({**LABELS["pdu-a"], "1": "optn45"})}
    labels = await saved_labels(lab.db)
    assert labels["pdu-a"] == {**LABELS["pdu-a"], "1": "optn45"}
    assert labels["pdu-b"] == LABELS["pdu-b"] and labels["kvm-a"] == LABELS["kvm-a"]
    assert snapshot(lab.folder) == files
    assert await monitors_and_owners(lab.db) == people
    # The stale revision is still refused and the labels writer still validates.
    r = await lab.client.patch("/api/devices/pdu-a/labels", json={"1": "x"}, headers={"If-Match": revision})
    assert r.status_code == 409


# ── 2. GET /locations ──────────────────────────────────────────────────────────────────────────────────────────

async def test_locations_lists_each_server_with_rack_slot_ports_and_empty_ports(lab):
    (lab.folder / "rack_items.json").write_text(json.dumps({"Storage": []}))
    r = await lab.client.get("/api/devices/locations")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(s["key"], s["name"], s["rack"], s["slot"]) for s in body["servers"]] == [
        ("optn44", "OPTN44", "Rack-01", 3), ("optn45", "OPTN45", "Rack-01", 7), ("web-1", "web-1", "Rack-01", None),
        ("other", "other", "Rack-09", None)]  # known only from rack_overrides.json: listed with no ports
    optn44 = body["servers"][0]
    assert optn44["pdu"] == [{"device_id": "pdu-a", "device_name": "PDU-A", "port": "1", "label": "OPTN44"},
                             {"device_id": "pdu-b", "device_name": "PDU-B", "port": "1", "label": "optn44 (PSU2)"}]
    assert optn44["kvm"] == [{"device_id": "kvm-a", "device_name": "KVM-A", "port": "1", "label": "optn44"}]
    empty = body["empty_ports"]
    assert [(p["device_id"], p["port"]) for p in empty["kvm"]] == [("kvm-a", "3"), ("kvm-a", "4")]
    # A default "Outlet 5" label is an empty outlet.
    assert [(p["device_id"], p["port"]) for p in empty["pdu"]] == \
        [("pdu-a", str(n)) for n in range(4, 9)] + [("pdu-b", str(n)) for n in range(3, 9)]
    assert body["racks"] == ["Rack-01", "Rack-02", "Rack-03", "Rack-09", "Storage"]
    assert "192.0.2" not in r.text and "password" not in r.text


async def test_locations_without_layout_files_uses_the_pdu_rack(lab):
    for name in LAYOUT:
        (lab.folder / name).unlink()
    (lab.folder / "rack_slots.json").write_text("{not json")
    body = (await lab.client.get("/api/devices/locations")).json()
    assert [(s["name"], s["rack"], s["slot"]) for s in body["servers"]] == [
        ("OPTN44", "Rack-01", None), ("OPTN45", "Rack-01", None), ("web-1", "Rack-01", None)]


# ── 3. POST /move-server ───────────────────────────────────────────────────────────────────────────────────────

async def test_swap_with_dual_feeds_keeps_port_suffixes_and_swaps_every_layout_file(lab):
    people = await monitors_and_owners(lab.db)
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["dry_run"] is False and body["unplaced"] == []
    assert await saved_labels(lab.db) == {
        "pdu-a": {"1": "OPTN45", "2": "OPTN44 (PSU1)", "3": "web-1"},
        "pdu-b": {"1": "OPTN45 (PSU2)", "2": "OPTN44 (PSU2)", "5": "Outlet 5"},
        "kvm-a": {"1": "OPTN45", "2": "OPTN44"},
    }
    assert [(c["device_id"], c["kind"], c["port"], c["before"], c["after"]) for c in body["changes"]] == [
        ("pdu-a", "pdu", "1", "OPTN44", "OPTN45"), ("pdu-a", "pdu", "2", "OPTN45 (PSU1)", "OPTN44 (PSU1)"),
        ("pdu-b", "pdu", "1", "optn44 (PSU2)", "OPTN45 (PSU2)"), ("pdu-b", "pdu", "2", "OPTN45 (PSU2)", "OPTN44 (PSU2)"),
        ("kvm-a", "kvm", "1", "optn44", "OPTN45"), ("kvm-a", "kvm", "2", "OPTN45", "OPTN44")]
    assert body["positions"] == [
        {"server": "OPTN45", "before": {"rack": "Rack-01", "slot": 7}, "after": {"rack": "Rack-01", "slot": 3}},
        {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": "Rack-01", "slot": 7}}]
    assert read_layout(lab.folder) == {
        "rack_slots.json": {"Rack-01": {"optn45": 3, "optn44 (psu1)": 7}, "Rack-02": {"optn45 (psu2)": 3}},
        "rack_positions.json": {"Rack-01": ["optn44 (psu1)", "optn45", "web-1"]},
        "rack_overrides.json": {"optn44 (psu1)": "Rack-01", "other": "Rack-09"},
        "switch_assignments.json": {"optn45": {"switch": "SW1", "port": "12"}, "optn44 (psu1)": {"switch": "SW2", "port": "3"}},
    }
    # Monitors and owners follow the server, not the location.
    assert await monitors_and_owners(lab.db) == people
    assert not list(lab.folder.glob("*.tmp"))
    assert "192.0.2" not in r.text
    # The listing agrees: each server now sits where the other was.
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert (rows["optn45"]["rack"], rows["optn45"]["slot"]) == ("Rack-01", 3)
    assert (rows["optn44"]["rack"], rows["optn44"]["slot"]) == ("Rack-01", 7)
    assert [p["port"] for p in rows["optn45"]["kvm"]] == ["1"]


async def test_swap_is_reversible(lab):
    files = read_layout(lab.folder)
    assert (await move(lab, server="optn45", target_server="optn44")).status_code == 200
    assert (await move(lab, server="optn45", target_server="optn44")).status_code == 200
    assert await saved_labels(lab.db) == {
        "pdu-a": {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "web-1"},
        "pdu-b": {"1": "OPTN44 (PSU2)", "2": "OPTN45 (PSU2)", "5": "Outlet 5"},  # display name as first written
        "kvm-a": {"1": "OPTN44", "2": "OPTN45"},
    }
    assert read_layout(lab.folder) == files


async def test_move_without_swap_takes_over_the_target_location_and_unplaces_the_target(lab):
    people = await monitors_and_owners(lab.db)
    r = await move(lab, server="optn45", target_server="optn44", swap=False)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unplaced"] == ["OPTN44"]
    assert await saved_labels(lab.db) == {
        "pdu-a": {"1": "OPTN45", "2": "Outlet 2", "3": "web-1"},
        "pdu-b": {"1": "OPTN45 (PSU2)", "2": "Outlet 2", "5": "Outlet 5"},
        "kvm-a": {"1": "OPTN45", "2": "Port 2"},
    }
    assert ("pdu-a", "2", "OPTN45 (PSU1)", "Outlet 2") in [(c["device_id"], c["port"], c["before"], c["after"]) for c in body["changes"]]
    assert body["positions"] == [
        {"server": "OPTN45", "before": {"rack": "Rack-01", "slot": 7}, "after": {"rack": "Rack-01", "slot": 3}},
        {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": None, "slot": None}}]
    assert read_layout(lab.folder) == {
        "rack_slots.json": {"Rack-01": {"optn45": 3}, "Rack-02": {"optn45 (psu2)": 3}},
        "rack_positions.json": {"Rack-01": ["optn45", "web-1"]},
        "rack_overrides.json": {"other": "Rack-09"},
        "switch_assignments.json": {"optn45": {"switch": "SW1", "port": "12"}},
    }
    assert await monitors_and_owners(lab.db) == people
    keys = [s["key"] for s in (await lab.client.get("/api/devices/locations")).json()["servers"]]
    assert keys == ["optn45", "web-1", "other"]  # OPTN44 has no port, layout entry or monitor left


async def test_target_ports_occupied_by_another_server_is_409_and_changes_nothing(lab):
    files = snapshot(lab.folder)
    r = await move(lab, server="optn45", target_ports=[{"device_id": "pdu-a", "port": "4"}, {"device_id": "pdu-a", "port": "1"}])
    assert r.status_code == 409
    assert r.json()["detail"] == "Port 1 on PDU-A is used by OPTN44. Choose OPTN44 as the target to swap."
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files


async def test_target_ports_empty_moves_ports_and_sets_rack_and_slot(lab):
    people = await monitors_and_owners(lab.db)
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-b", "port": 5}, {"device_id": "kvm-a", "port": "3"}],
                   target_rack="Rack-02", target_slot=9, swap=False)
    assert r.status_code == 200, r.text
    body = r.json()
    labels = await saved_labels(lab.db)
    assert labels["pdu-a"] == {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "Outlet 3"}
    assert labels["pdu-b"] == {**LABELS["pdu-b"], "5": "web-1"}
    assert labels["kvm-a"] == {**LABELS["kvm-a"], "3": "web-1"}
    assert [(c["device_id"], c["port"], c["before"], c["after"]) for c in body["changes"]] == [
        ("pdu-a", "3", "web-1", "Outlet 3"), ("pdu-b", "5", "Outlet 5", "web-1"), ("kvm-a", "3", None, "web-1")]
    assert body["positions"] == [
        {"server": "web-1", "before": {"rack": "Rack-01", "slot": None}, "after": {"rack": "Rack-02", "slot": 9}}]
    layout = read_layout(lab.folder)
    assert layout["rack_slots.json"] == {**LAYOUT["rack_slots.json"], "Rack-02": {"optn44 (psu2)": 3, "web-1": 9}}
    assert layout["rack_positions.json"] == {"Rack-01": ["optn45 (psu1)", "optn44"]}
    assert layout["rack_overrides.json"] == {**LAYOUT["rack_overrides.json"], "web-1": "Rack-02"}
    assert layout["switch_assignments.json"] == LAYOUT["switch_assignments.json"]
    assert await monitors_and_owners(lab.db) == people


async def test_target_ports_keep_own_ports_and_carry_position_ids_to_the_new_label(lab):
    # OPTN45 keeps its PSU1 outlet and gives up PSU2 and the KVM port for an empty outlet.
    r = await move(lab, server="optn45", target_ports=[{"device_id": "pdu-a", "port": "2"}, {"device_id": "pdu-a", "port": "6"}])
    assert r.status_code == 200, r.text
    labels = await saved_labels(lab.db)
    assert labels["pdu-a"] == {**LABELS["pdu-a"], "6": "OPTN45"}
    assert labels["pdu-b"] == {"1": "optn44 (PSU2)", "2": "Outlet 2", "5": "Outlet 5"}
    assert labels["kvm-a"] == {"1": "optn44", "2": "Port 2"}
    assert r.json()["positions"] == [
        {"server": "OPTN45", "before": {"rack": "Rack-01", "slot": 7}, "after": {"rack": "Rack-01", "slot": 7}}]
    assert read_layout(lab.folder) == LAYOUT  # its layout ids still match a label it keeps


async def test_target_slot_occupied_is_409_unless_swap_which_swaps_positions_only(lab):
    files = snapshot(lab.folder)
    body = dict(server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="Rack-01", target_slot=3)
    r = await move(lab, **body, swap=False)
    assert r.status_code == 409 and r.json()["detail"].startswith("U3 in Rack-01 is used by OPTN44")
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files

    r = await move(lab, **body, swap=True)
    assert r.status_code == 200, r.text
    assert r.json()["positions"] == [
        {"server": "web-1", "before": {"rack": "Rack-01", "slot": None}, "after": {"rack": "Rack-01", "slot": 3}},
        {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": "Rack-01", "slot": None}}]
    labels = await saved_labels(lab.db)
    # Only web-1's own ports moved; OPTN44 keeps every port label.
    assert labels["pdu-a"] == {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "Outlet 3", "4": "web-1"}
    assert labels["pdu-b"] == LABELS["pdu-b"] and labels["kvm-a"] == LABELS["kvm-a"]
    layout = read_layout(lab.folder)
    assert layout["rack_slots.json"] == {"Rack-01": {"optn45 (psu1)": 7, "web-1": 3}, "Rack-02": {}}
    assert layout["rack_overrides.json"] == {**LAYOUT["rack_overrides.json"], "web-1": "Rack-01",
                                             "optn44": "Rack-01", "optn44 (psu2)": "Rack-01"}
    assert layout["switch_assignments.json"] == LAYOUT["switch_assignments.json"]


async def test_target_slot_alone_uses_the_current_rack(lab):
    r = await move(lab, server="optn45", target_ports=[{"device_id": "pdu-a", "port": "2"}], target_slot=5)
    assert r.status_code == 200, r.text
    assert r.json()["positions"][0]["after"] == {"rack": "Rack-01", "slot": 5}
    assert read_layout(lab.folder)["rack_slots.json"]["Rack-01"] == {"optn44": 3, "optn45 (psu1)": 5}


async def test_cleared_ports_store_the_default_name_and_list_as_empty(lab):
    # The default name hides any name saved on the PDU/KVM itself, which would otherwise show through again.
    for device_id, port, placeholder in (("pdu-a", "3", "Outlet 3"), ("kvm-a", "2", "Port 2")):
        r = await lab.client.patch("/api/devices/direct-label", json={"device_id": device_id, "port": port, "label": ""})
        assert r.status_code == 200, r.text
        assert (await saved_labels(lab.db))[device_id][port] == placeholder
    body = (await lab.client.get("/api/devices/locations")).json()
    assert ("pdu-a", "3") in [(p["device_id"], p["port"]) for p in body["empty_ports"]["pdu"]]
    assert ("kvm-a", "2") in [(p["device_id"], p["port"]) for p in body["empty_ports"]["kvm"]]
    assert [s["key"] for s in body["servers"]] == ["optn44", "optn45", "web-1", "other"]
    assert [p["port"] for p in body["servers"][1]["kvm"]] == []
    assert (body["servers"][2]["pdu"], body["servers"][2]["kvm"]) == ([], [])  # web-1 lost its only port
    # A placeholder port is a free move target.
    r = await move(lab, server="optn45", target_ports=[{"device_id": "kvm-a", "port": "2"}, {"device_id": "pdu-a", "port": "2"}],
                   dry_run=True)
    assert r.status_code == 200, r.text
    assert ("kvm-a", "2", "Port 2", "OPTN45") in [(c["device_id"], c["port"], c["before"], c["after"]) for c in r.json()["changes"]]


async def test_a_cleared_legacy_port_key_is_removed_not_turned_into_a_server(lab):
    # "Outlet A1" would read as a server name, so a non-numeric legacy key is removed instead.
    dev = await lab.db.get(Device, "pdu-b")
    dev.labels_json = json.dumps({**LABELS["pdu-b"], "A1": "optn46", "A2": "Legacy"})
    await lab.db.commit()
    r = await move(lab, server="optn46", target_ports=[{"device_id": "pdu-a", "port": "4"}])
    assert r.status_code == 200, r.text
    assert ("pdu-b", "A1", "optn46", None) in [(c["device_id"], c["port"], c["before"], c["after"]) for c in r.json()["changes"]]
    r = await lab.client.patch("/api/devices/direct-label", json={"device_id": "pdu-b", "port": "A2", "label": ""})
    assert r.status_code == 200, r.text
    assert (await saved_labels(lab.db))["pdu-b"] == LABELS["pdu-b"]
    keys = [s["key"] for s in (await lab.client.get("/api/devices/locations")).json()["servers"]]
    assert keys == ["optn44", "optn45", "web-1", "optn46", "other"]  # optn46 keeps the rack of its old PDU (Rack-02)


async def test_dry_run_returns_the_same_answer_and_writes_nothing(lab):
    files, people = snapshot(lab.folder, locks=True), await monitors_and_owners(lab.db)
    for body in (dict(server="optn45", target_server="optn44"), dict(server="optn45", target_server="optn44", swap=False),
                 dict(server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="Rack-01",
                      target_slot=3, swap=True)):
        preview = await move(lab, **body, dry_run=True)
        assert preview.status_code == 200, preview.text
        assert preview.json()["dry_run"] is True and preview.json()["changes"]
        assert await saved_labels(lab.db) == LABELS
        assert snapshot(lab.folder, locks=True) == files  # not even a lock file
        assert await monitors_and_owners(lab.db) == people
    applied = await move(lab, **body)
    assert {**preview.json(), "dry_run": False} == applied.json()


@pytest.mark.parametrize("body,status", [
    ({}, 400),
    ({"server": "Outlet 3", "target_server": "optn44"}, 400),
    ({"server": "optn45"}, 400),
    ({"server": "optn45", "target_server": "optn44", "target_ports": [{"device_id": "pdu-a", "port": "4"}]}, 400),
    ({"server": "optn45", "target_server": ""}, 400),
    ({"server": "OPTN45 (PSU2)", "target_server": "optn45"}, 400),
    ({"server": "optn45", "target_server": "optn44", "target_rack": "Rack-02"}, 400),
    ({"server": "optn45", "target_server": "optn44", "swap": "yes"}, 400),
    ({"server": "optn45", "target_server": "optn44", "dry_run": "no"}, 400),
    ({"server": "optn45", "target_ports": []}, 400),
    ({"server": "optn45", "target_ports": ["pdu-a:4"]}, 400),
    ({"server": "optn45", "target_ports": [{"device_id": "pdu-a", "port": "99"}]}, 400),
    ({"server": "optn45", "target_ports": [{"device_id": "pdu-a", "port": "4"}], "target_slot": 0}, 400),
    ({"server": "optn45", "target_ports": [{"device_id": "pdu-a", "port": "4"}], "target_slot": "3"}, 400),
    ({"server": "optn45", "target_ports": [{"device_id": "pdu-a", "port": "4"}], "target_rack": " "}, 400),
    ({"server": "optn99", "target_server": "optn44"}, 404),
    ({"server": "optn45", "target_server": "optn99"}, 404),
    ({"server": "optn45", "target_ports": [{"device_id": "rack-x", "port": "1"}]}, 404),
    ({"server": "optn45", "target_ports": [{"device_id": "missing", "port": "1"}]}, 404),
    ({"server": "optn45", "target_ports": [{"device_id": "kvm-a", "port": "1"}]}, 409),
])
async def test_invalid_moves_are_refused_and_write_nothing(lab, body, status):
    files = snapshot(lab.folder)
    r = await move(lab, **body)
    assert r.status_code == status, r.text
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files


async def test_unreadable_layout_file_stops_a_move(lab):
    (lab.folder / "rack_overrides.json").write_text("[1, 2")
    files = snapshot(lab.folder)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 503 and "rack_overrides.json" in r.json()["detail"]
    assert await saved_labels(lab.db) == LABELS
    assert snapshot(lab.folder) == files


async def test_a_malformed_rack_entry_is_not_replaced(lab):
    (lab.folder / "rack_slots.json").write_text(json.dumps({**LAYOUT["rack_slots.json"], "Rack-05": ["kept"]}))
    files = snapshot(lab.folder)
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="Rack-05", target_slot=2)
    assert r.status_code == 503 and "Rack-05" in r.json()["detail"]
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files
    assert (await lab.client.get("/api/devices/locations")).status_code == 200


async def test_a_failed_database_commit_restores_the_layout_files(lab, monkeypatch):
    (lab.folder / "rack_overrides.json").unlink()  # created by the move, removed again on failure
    before = read_layout(lab.folder)
    monkeypatch.setattr(lab.db, "commit", AsyncMock(side_effect=RuntimeError("disk I/O error")))
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="Rack-02", target_slot=1)
    assert r.status_code == 503 and r.json()["detail"] == devices._MOVE_FAILED
    assert read_layout(lab.folder) == before and not (lab.folder / "rack_overrides.json").exists()
    assert await saved_labels(lab.db) == LABELS
    assert not list(lab.folder.glob("*.tmp"))


# ── v2.39.2 review fixes ────────────────────────────────────────────────────────────────────────────────────────

def cache_pdu(device_id, outlets):
    """A status as the PDU reported it, in the in-memory cache only (no device is contacted)."""
    pdus_module._cache[device_id] = (time.time(), PduStatus(device_id=device_id, reachable=True, outlets=[
        OutletState(number=n, label=label, state="on") for n, label in outlets.items()]))


async def test_label_editor_keeps_the_default_name_for_a_removed_or_emptied_port(lab):
    # The PDU editor sends "" and DCIM's remove/move deletes the key: both keep the default name, so a name saved on
    # the device itself cannot come back. A port that never had a saved label stays absent.
    r = await lab.client.patch("/api/devices/pdu-a/labels", json={"1": "OPTN44", "2": "", "6": ""})
    assert r.status_code == 200, r.text
    expected = {"1": "OPTN44", "2": "Outlet 2", "3": "Outlet 3"}
    assert (await saved_labels(lab.db))["pdu-a"] == expected
    assert r.json()["labels_revision"] == inventory_store.revision(expected)
    r = await lab.client.patch("/api/devices/kvm-a/labels", json={"1": "optn44"})
    assert r.status_code == 200 and (await saved_labels(lab.db))["kvm-a"] == {"1": "optn44", "2": "Port 2"}


async def test_a_layout_save_while_the_move_commits_is_not_blocked(lab, monkeypatch):
    # Codex HF-R1 #1: the move must not hold the layout file locks while it awaits the database.
    real_commit, seen = lab.db.commit, {}
    path = lab.folder / "rack_slots.json"

    async def commit():
        payload = {**json.loads(path.read_text()), "Rack-07": {"spare": 1}}
        seen["etag"] = await asyncio.wait_for(
            asyncio.to_thread(inventory_store.save_layout, path, payload, None, {}), timeout=5)
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 200, r.text
    slots = json.loads(path.read_text())
    assert seen["etag"] and slots["Rack-07"] == {"spare": 1}
    assert slots["Rack-01"] == {"optn45": 3, "optn44 (psu1)": 7}


async def test_clear_with_expected_refuses_a_port_changed_in_another_session(lab):
    url = "/api/devices/direct-label"
    # Two pages show OPTN44 on PDU-A outlet 1; the first writes optn46 there, the second then clears what it saw.
    r = await lab.client.patch(url, json={"device_id": "pdu-a", "port": "1", "label": "optn46", "expected": "OPTN44"})
    assert r.status_code == 200, r.text
    r = await lab.client.patch(url, json={"device_id": "pdu-a", "port": "1", "label": "", "expected": "OPTN44"})
    assert r.status_code == 409 and r.json()["detail"] == "This port changed in another session. Reload and try again."
    assert (await saved_labels(lab.db))["pdu-a"]["1"] == "optn46"
    # Whatever the page showed is accepted: the saved label, then the saved default name.
    r = await lab.client.patch(url, json={"device_id": "pdu-a", "port": "1", "label": "", "expected": " optn46 "})
    assert r.status_code == 200 and (await saved_labels(lab.db))["pdu-a"]["1"] == "Outlet 1"
    r = await lab.client.patch(url, json={"device_id": "pdu-a", "port": "1", "label": "x1", "expected": "Outlet 1"})
    assert r.status_code == 200
    # With nothing saved: the name the PDU reports itself, blank, or the default name.
    cache_pdu("pdu-b", {7: "hw-name"})
    for port, shown in (("7", "hw-name"), ("8", ""), ("4", "Outlet 4")):
        r = await lab.client.patch(url, json={"device_id": "pdu-b", "port": port, "label": "", "expected": shown})
        assert r.status_code == 200, (port, r.text)
    labels = (await saved_labels(lab.db))["pdu-b"]
    assert (labels["7"], labels["8"], labels["4"]) == ("Outlet 7", "Outlet 8", "Outlet 4")
    # Old callers without expected keep working; a non-text expected is refused.
    assert (await lab.client.patch(url, json={"device_id": "kvm-a", "port": "2", "label": ""})).status_code == 200
    r = await lab.client.patch(url, json={"device_id": "kvm-a", "port": "1", "label": "", "expected": 5})
    assert r.status_code == 400


async def test_dual_feed_layout_entries_that_differ_are_not_merged_silently(lab):
    # Codex HF-R1 #3: moving to a plain-name port turns "optn45 (psu1)" and "optn45 (psu2)" into one id "optn45".
    layout = json.loads(json.dumps(LAYOUT))
    layout["switch_assignments.json"]["optn45 (psu2)"] = {"switch": "SW9", "port": "9"}
    write_layout(lab.folder, layout)
    files = snapshot(lab.folder)
    body = dict(server="optn45", target_ports=[{"device_id": "pdu-a", "port": "6"}])
    r = await move(lab, **body)
    assert r.status_code == 409, r.text
    assert "switch assignments" in r.json()["detail"] and "optn45 (psu2)" in r.json()["detail"]
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files
    # Equal values merge into the one id.
    layout["switch_assignments.json"]["optn45 (psu2)"] = dict(layout["switch_assignments.json"]["optn45 (psu1)"])
    write_layout(lab.folder, layout)
    r = await move(lab, **body)
    assert r.status_code == 200, r.text
    assert read_layout(lab.folder)["switch_assignments.json"] == {
        "optn44": {"switch": "SW1", "port": "12"}, "optn45": {"switch": "SW2", "port": "3"}}


async def test_differing_dual_feed_slots_do_not_block_a_move_that_sets_the_rack(lab):
    layout = json.loads(json.dumps(LAYOUT))
    layout["rack_slots.json"]["Rack-01"]["optn45 (psu2)"] = 8
    write_layout(lab.folder, layout)
    body = dict(server="optn45", target_ports=[{"device_id": "pdu-a", "port": "6"}])
    r = await move(lab, **body, dry_run=True)
    assert r.status_code == 409 and "rack slots" in r.json()["detail"]
    r = await move(lab, **body, target_rack="Rack-02", target_slot=4)
    assert r.status_code == 200, r.text
    assert r.json()["positions"][0]["after"] == {"rack": "Rack-02", "slot": 4}
    assert read_layout(lab.folder)["rack_slots.json"] == {"Rack-01": {"optn44": 3}, "Rack-02": {"optn44 (psu2)": 3, "optn45": 4}}


async def test_numbered_ports_are_normalised(lab):
    # Codex HF-R1 #4: "01" and "1" are the same outlet.
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "01"}])
    assert r.status_code == 409 and r.json()["detail"].startswith("Port 1 on PDU-A is used by OPTN44")
    dev = await lab.db.get(Device, "pdu-b")
    dev.labels_json = json.dumps({**LABELS["pdu-b"], "07": "optn46"})
    await lab.db.commit()
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-b", "port": "7"}])
    assert r.status_code == 409 and r.json()["detail"].startswith("Port 7 on PDU-B is used by optn46")
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "0004"}, {"device_id": "pdu-a", "port": 4}])
    assert r.status_code == 200, r.text
    assert (await saved_labels(lab.db))["pdu-a"] == {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "Outlet 3", "4": "web-1"}


async def test_apply_is_refused_when_the_plan_changed_since_the_preview(lab):
    body = dict(server="optn45", target_server="optn44")
    preview = (await move(lab, **body, dry_run=True)).json()
    assert isinstance(preview["plan_revision"], str) and preview["plan_revision"]
    # Another session relabels a port of the target server between preview and Apply.
    r = await lab.client.patch("/api/devices/direct-label", json={"device_id": "kvm-a", "port": "1", "label": "optn44 (KVM)"})
    assert r.status_code == 200
    labels, files = await saved_labels(lab.db), snapshot(lab.folder)
    r = await move(lab, **body, plan_revision=preview["plan_revision"])
    assert r.status_code == 409 and r.json()["detail"] == "Changed since the preview. Preview again."
    assert await saved_labels(lab.db) == labels and snapshot(lab.folder) == files
    fresh = (await move(lab, **body, dry_run=True)).json()
    assert fresh["plan_revision"] != preview["plan_revision"]
    r = await move(lab, **body, plan_revision=fresh["plan_revision"])
    assert r.status_code == 200, r.text
    assert r.json()["plan_revision"] == fresh["plan_revision"] and r.json()["changes"] == fresh["changes"]


async def test_names_reported_by_the_device_itself_count_as_occupied_and_move_with_the_server(lab):
    cache_pdu("pdu-a", {1: "ignored-hw-name", 4: "optn46", 5: "Outlet 5"})
    cache_pdu("pdu-b", {6: "optn45"})
    body = (await lab.client.get("/api/devices/locations")).json()
    empty = [(p["device_id"], p["port"]) for p in body["empty_ports"]["pdu"]]
    assert ("pdu-a", "4") not in empty and ("pdu-b", "6") not in empty and ("pdu-a", "5") in empty
    rows = {s["key"]: s for s in body["servers"]}
    assert [(p["device_id"], p["port"]) for p in rows["optn46"]["pdu"]] == [("pdu-a", "4")]
    assert [(p["device_id"], p["port"]) for p in rows["optn45"]["pdu"]] == [("pdu-a", "2"), ("pdu-b", "2"), ("pdu-b", "6")]
    assert rows["optn44"]["pdu"][0]["label"] == "OPTN44"  # a saved label wins over the device's own name
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}])
    assert r.status_code == 409 and "optn46" in r.json()["detail"]
    # OPTN45 keeps only its PSU1 outlet: the outlet carrying its device-reported name is cleared with a saved default
    # name; device names the move leaves alone are not written.
    r = await move(lab, server="optn45", target_ports=[{"device_id": "pdu-a", "port": "2"}])
    assert r.status_code == 200, r.text
    changes = [(c["device_id"], c["port"], c["before"], c["after"]) for c in r.json()["changes"]]
    assert ("pdu-b", "6", "optn45", "Outlet 6") in changes
    labels = await saved_labels(lab.db)
    assert labels["pdu-b"] == {"1": "optn44 (PSU2)", "2": "Outlet 2", "5": "Outlet 5", "6": "Outlet 6"}
    assert labels["pdu-a"] == LABELS["pdu-a"]


async def test_bounds_on_ports_names_and_layout_numbers(lab):
    files = snapshot(lab.folder)
    for body in (dict(server="optn45", target_ports=[{"device_id": "pdu-a", "port": str(n)} for n in range(1, 66)]),
                 dict(server="optn45", target_ports=[{"device_id": "pdu-a", "port": "00004"}]),
                 dict(server="optn45", target_ports=[{"device_id": "pdu-a", "port": "9" * 5000}]),
                 dict(server="x" * 300, target_server="optn44"),
                 dict(server="optn45", target_server="optn44", plan_revision=5)):
        r = await move(lab, **body)
        assert r.status_code == 400, r.text
        assert len(r.text) < 300
    assert snapshot(lab.folder) == files
    # A device with no port count accepts only ports it already has.
    dev = await lab.db.get(Device, "kvm-a")
    dev.port_count = 0
    await lab.db.commit()
    assert (await move(lab, server="web-1", target_ports=[{"device_id": "kvm-a", "port": "3"}])).status_code == 400
    assert (await move(lab, server="web-1", target_ports=[{"device_id": "kvm-a", "port": "1"}])).status_code == 409
    # Huge digit strings in saved keys or layout files are ignored, not converted.
    dev = await lab.db.get(Device, "pdu-b")
    dev.labels_json = json.dumps({**LABELS["pdu-b"], "9" * 5000: "optn47"})
    await lab.db.commit()
    (lab.folder / "rack_slots.json").write_text(json.dumps({"Rack-01": {"optn44": "9" * 5000}}))
    r = await lab.client.get("/api/devices/locations")
    assert r.status_code == 200
    assert {s["key"]: s["slot"] for s in r.json()["servers"]}["optn44"] is None


@pytest.mark.parametrize("commit_fails", [False, True])
async def test_a_request_cancelled_during_the_commit_keeps_files_and_labels_consistent(lab, monkeypatch, commit_fails):
    started, release, real_commit = asyncio.Event(), asyncio.Event(), lab.db.commit

    async def slow_commit():
        started.set()
        await release.wait()
        if commit_fails:
            raise RuntimeError("disk I/O error")
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", slow_commit)
    before = read_layout(lab.folder)
    request = asyncio.create_task(move(lab, server="optn45", target_server="optn44"))
    await asyncio.wait_for(started.wait(), 5)
    request.cancel()
    await asyncio.sleep(0.05)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(request, 10)
    if commit_fails:  # nothing saved: the files are put back
        assert read_layout(lab.folder) == before
        assert await saved_labels(lab.db) == LABELS
    else:  # saved before the caller went away: the files stay moved with the labels
        assert read_layout(lab.folder)["rack_slots.json"]["Rack-01"] == {"optn45": 3, "optn44 (psu1)": 7}
        assert (await saved_labels(lab.db))["pdu-a"]["1"] == "OPTN45"


# ── UX-LOC walkthrough fixes ─────────────────────────────────────────────────────────────────────────────────────

async def test_moving_to_ports_alone_keeps_the_rack_and_slot(lab):
    # OPTN44 sits in Rack-01 at U3. Its new outlet is on PDU-B, which hangs in Rack-02: the server must not follow it.
    r = await move(lab, server="optn44", target_ports=[{"device_id": "pdu-b", "port": "7"}])
    assert r.status_code == 200, r.text
    assert r.json()["positions"] == [
        {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": "Rack-01", "slot": 3}}]
    layout = read_layout(lab.folder)
    assert layout["rack_overrides.json"]["optn44"] == "Rack-01" and layout["rack_slots.json"]["Rack-01"]["optn44"] == 3
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert (rows["optn44"]["rack"], rows["optn44"]["slot"]) == ("Rack-01", 3)
    assert [(p["device_id"], p["port"]) for p in rows["optn44"]["pdu"]] == [("pdu-b", "7")]


async def test_servers_without_ports_stay_listed_and_can_be_moved_to_ports(lab):
    lab.db.add(PingTarget(id="t77", source_key="server:optn77", name="OPTN77", host="optn77"))
    await lab.db.commit()
    layout = json.loads(json.dumps(LAYOUT))
    layout["rack_slots.json"]["Rack-02"]["optn88 (psu1)"] = 5
    write_layout(lab.folder, layout)
    # Clear location of web-1 (its only port): its rack order entry keeps it listed.
    r = await lab.client.patch("/api/devices/direct-label",
                               json={"device_id": "pdu-a", "port": "3", "label": "", "expected": "web-1"})
    assert r.status_code == 200, r.text
    servers = (await lab.client.get("/api/devices/locations")).json()["servers"]
    rows = {s["key"]: (s["name"], s["rack"], s["slot"], s["pdu"], s["kvm"]) for s in servers}
    assert rows["optn77"] == ("OPTN77", None, None, [], [])  # only a ping monitor knows it
    assert rows["optn88"] == ("optn88", "Rack-02", 5, [], [])  # only rack_slots.json knows it
    assert rows["web-1"] == ("web-1", "Rack-01", None, [], [])
    assert servers[-1]["key"] == "optn77"  # unplaced servers sort last
    # A server with no ports moves to empty ports and keeps its rack and U.
    r = await move(lab, server="optn88", target_ports=[{"device_id": "pdu-a", "port": "4"}, {"device_id": "kvm-a", "port": "3"}])
    assert r.status_code == 200, r.text
    assert r.json()["positions"] == [
        {"server": "optn88", "before": {"rack": "Rack-02", "slot": 5}, "after": {"rack": "Rack-02", "slot": 5}}]
    r = await move(lab, server="OPTN77", target_ports=[{"device_id": "pdu-a", "port": "5"}])
    assert r.status_code == 200, r.text
    labels = await saved_labels(lab.db)
    assert (labels["pdu-a"]["4"], labels["kvm-a"]["3"], labels["pdu-a"]["5"]) == ("optn88", "optn88", "OPTN77")
    # A server left without a location by a move stays listed (here through its monitor).
    r = await move(lab, server="optn44", target_server="optn45", swap=False)
    assert r.status_code == 200 and r.json()["unplaced"] == ["OPTN45"]
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert (rows["optn45"]["rack"], rows["optn45"]["pdu"], rows["optn45"]["kvm"]) == (None, [], [])


# ── Roles in accounts mode ───────────────────────────────────────────────────────────────────────────────────────

def test_required_roles_for_the_new_paths():
    assert accounts.required_role("/api/devices/locations", "GET") == "Viewer"
    assert accounts.required_role("/api/devices/move-server", "POST") == "Operator"
    assert accounts.required_role("/api/devices/rename-opt", "POST") == "Operator"
    assert accounts.required_role("/api/devices/pdu-a", "PUT") == "Admin"
    assert accounts.required_role("/api/devices/move-server-x", "POST") == "Admin"


PASSWORD = "test-password-123"


@pytest.fixture
async def accounts_lab(tmp_path, monkeypatch):
    from fastapi import FastAPI
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'locations.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    await accounts.bootstrap_admin()
    async with sessions() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role,
                        password_hash=accounts.hash_password(PASSWORD), created_at=time.time()))
        db.add_all(lab_devices())
        await db.commit()
    write_layout(tmp_path)
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(devices.router)

    async def dependency():
        async with sessions() as db:
            yield db
    app.dependency_overrides[get_db] = dependency
    yield app
    await engine.dispose()


@pytest.mark.parametrize("username,move_status", [("viewer", 403), ("operator", 200), ("admin", 200)])
async def test_viewer_reads_locations_and_operator_moves(accounts_lab, username, move_status):
    async with AsyncClient(transport=ASGITransport(app=accounts_lab), base_url="http://test") as c:
        assert (await c.get("/api/devices/locations")).status_code == 401
        r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert r.status_code == 200, r.text
        c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        r = await c.get("/api/devices/locations")
        assert r.status_code == 200 and len(r.json()["servers"]) == 4
        for dry_run in (True, False):
            r = await c.post("/api/devices/move-server", json={"server": "optn45", "target_server": "optn44", "dry_run": dry_run})
            assert r.status_code == move_status, r.text
        # Adding or editing a device stays Admin-only.
        assert (await c.put("/api/devices/pdu-a", json={})).status_code == (422 if username == "admin" else 403)


# ── Codex HF-R2: labels are committed first, then the layout files are written all-or-nothing ────────────────────

SWAPPED_SLOTS = {"optn45": 3, "optn44 (psu1)": 7}


def fail_on_layout_write(monkeypatch, number, error):
    """inventory_store.write_json raises `error` on the move's `number`-th layout file write; later writes (the
    restore) go through."""
    real_write, calls = inventory_store.write_json, []

    def write_json(path, data, *args, **kwargs):
        calls.append(path.name)
        if len(calls) == number:
            raise error
        return real_write(path, data, *args, **kwargs)
    monkeypatch.setattr(inventory_store, "write_json", write_json)
    return calls


async def test_a_failed_second_layout_write_restores_the_first_file_and_the_labels(lab, monkeypatch):
    before = read_layout(lab.folder)
    calls = fail_on_layout_write(monkeypatch, 2, OSError("disk full"))
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 503 and r.json()["detail"] == devices._MOVE_FAILED
    # The first file was written, then put back (third write), under the same locks.
    assert calls[:3] == ["rack_overrides.json", "rack_positions.json", "rack_overrides.json"]
    assert read_layout(lab.folder) == before
    assert await saved_labels(lab.db) == LABELS          # the label commit was undone by a second commit
    assert not list(lab.folder.glob("*.tmp"))
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert (rows["optn44"]["slot"], rows["optn45"]["slot"]) == (3, 7)


class Interrupted(BaseException):
    """Stands for KeyboardInterrupt / SystemExit: not an Exception."""


@pytest.mark.parametrize("error", [Interrupted, KeyboardInterrupt, asyncio.CancelledError])
async def test_an_interrupt_during_the_file_writes_restores_files_and_labels_and_is_passed_on(lab, monkeypatch, error):
    before = read_layout(lab.folder)
    fail_on_layout_write(monkeypatch, 2, error())
    with pytest.raises(error):
        # Called directly: a BaseException leaving an ASGI app is not turned into a response.
        await devices.move_server({"server": "optn45", "target_server": "optn44"}, lab.db, None)
    assert read_layout(lab.folder) == before
    assert await saved_labels(lab.db) == LABELS


async def test_a_failed_label_commit_writes_no_layout_file_and_keeps_a_concurrent_save(lab, monkeypatch):
    # Codex HF-R2 P1: another page saves rack slots while the move commits, then the commit fails. Nothing of the
    # move may stay behind (no swapped slots), and the other page's save is kept.
    path = lab.folder / "rack_slots.json"

    async def commit():
        payload = {**json.loads(path.read_text()), "Rack-07": {"spare": 1}}
        await asyncio.wait_for(asyncio.to_thread(inventory_store.save_layout, path, payload, None, {}), timeout=5)
        raise RuntimeError("disk I/O error")
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 503 and r.json()["detail"] == devices._MOVE_FAILED
    assert json.loads(path.read_text()) == {**LAYOUT["rack_slots.json"], "Rack-07": {"spare": 1}}
    assert {k: v for k, v in read_layout(lab.folder).items() if k != "rack_slots.json"} == {
        k: v for k, v in LAYOUT.items() if k != "rack_slots.json"}
    assert await saved_labels(lab.db) == LABELS


async def test_a_layout_put_during_the_move_completes_and_is_kept(lab, monkeypatch):
    # The real PUT /api/rack-slots (it takes the same file lock synchronously) runs while the move commits its labels.
    import app.main as main
    monkeypatch.setattr(main, "_RACK_SLOTS_FILE", lab.folder / "rack_slots.json")
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(accounts_enabled=False, lab_manager_password=""))
    real_commit, seen = lab.db.commit, {}

    async def commit():
        if "put" not in seen:
            slots = json.loads((lab.folder / "rack_slots.json").read_text())
            async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as other:
                seen["put"] = await asyncio.wait_for(
                    other.put("/api/rack-slots", json={**slots, "Rack-07": {"spare": 1}}), timeout=5)
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 200, r.text
    assert seen["put"].status_code == 200, seen["put"].text
    slots = json.loads((lab.folder / "rack_slots.json").read_text())
    assert slots["Rack-07"] == {"spare": 1} and slots["Rack-01"] == SWAPPED_SLOTS   # both saves are there
    assert (await saved_labels(lab.db))["pdu-a"]["1"] == "OPTN45"


async def test_a_concurrent_save_that_changes_the_move_is_refused_and_undone(lab, monkeypatch):
    # Another page moves OPTN44 to U5 while the move commits: the previewed swap is no longer what would happen.
    path, real_commit, calls = lab.folder / "rack_slots.json", lab.db.commit, []

    async def commit():
        calls.append(1)
        if len(calls) == 1:
            slots = json.loads(path.read_text())
            slots["Rack-01"]["optn44"] = 5
            await asyncio.to_thread(inventory_store.save_layout, path, slots, None, {})
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 409 and r.json()["detail"] == devices._LAYOUT_CHANGED
    assert len(calls) == 2                                   # labels committed, then put back
    assert await saved_labels(lab.db) == LABELS
    assert json.loads(path.read_text())["Rack-01"] == {"optn44": 5, "optn45 (psu1)": 7}   # only the other save
    assert read_layout(lab.folder)["rack_overrides.json"] == LAYOUT["rack_overrides.json"]


async def test_a_save_from_another_worker_waits_for_the_move_writes_and_then_sees_them(lab, monkeypatch):
    # Another uvicorn worker (a thread here) saves rack slots with the revision it read before the move, while the
    # move holds the file locks. It waits, then gets 409 against the moved file: no deadlock, no lost update.
    import threading
    path = lab.folder / "rack_slots.json"
    stale = inventory_store.revision(json.loads(path.read_text()))
    real_write, outcome, workers = inventory_store.write_json, {}, []

    def other_worker():
        try:
            outcome["etag"] = inventory_store.save_layout(path, {"Rack-09": {}}, stale, {})
        except Exception as exc:  # HTTPException 409 expected
            outcome["error"] = exc

    def write_json(target, data, *args, **kwargs):
        if not workers:
            workers.append(threading.Thread(target=other_worker))
            workers[0].start()
        return real_write(target, data, *args, **kwargs)
    monkeypatch.setattr(inventory_store, "write_json", write_json)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 200, r.text
    workers[0].join(timeout=15)
    assert not workers[0].is_alive()
    assert getattr(outcome.get("error"), "status_code", None) == 409
    assert json.loads(path.read_text())["Rack-01"] == SWAPPED_SLOTS


# ── Codex HF-R3: an honest answer when a restore fails; a clear of a device-reported name sticks ────────────────────

def fail_layout_writes(monkeypatch, numbers):
    """inventory_store.write_json raises OSError on the given call numbers (1-based), counting the move's layout
    writes and its restores."""
    real_write, calls = inventory_store.write_json, []

    def write_json(path, data, *args, **kwargs):
        calls.append(path.name)
        if len(calls) in numbers:
            raise OSError("disk full")
        return real_write(path, data, *args, **kwargs)
    monkeypatch.setattr(inventory_store, "write_json", write_json)
    return calls


async def test_a_failed_restore_is_reported_and_the_labels_still_go_back(lab, monkeypatch):
    before = read_layout(lab.folder)
    # Write 2 (rack_positions) fails, then write 3, putting rack_overrides back, fails too.
    calls = fail_layout_writes(monkeypatch, {2, 3})
    r = await move(lab, server="optn45", target_server="optn44")
    assert calls[:4] == ["rack_overrides.json", "rack_positions.json", "rack_overrides.json", "rack_positions.json"]
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail == devices._MOVE_NOT_RESTORED.format(files="rack_overrides.json")
    assert "No changes were made" not in detail
    assert not any(text in detail for text in ("\\", "/", "disk full", str(lab.folder)))   # no paths, no error text
    assert await saved_labels(lab.db) == LABELS                                             # labels still reverted
    after = read_layout(lab.folder)
    assert after["rack_overrides.json"] != before["rack_overrides.json"]                    # really left moved
    assert {k: v for k, v in after.items() if k != "rack_overrides.json"} == {
        k: v for k, v in before.items() if k != "rack_overrides.json"}


async def test_a_failed_restore_of_the_untouched_failing_file_still_counts_as_no_change(lab, monkeypatch):
    before = read_layout(lab.folder)
    # Write 2 (rack_positions) fails and leaves the file as it was; putting it back (write 4) fails too: harmless.
    calls = fail_layout_writes(monkeypatch, {2, 4})
    r = await move(lab, server="optn45", target_server="optn44")
    assert calls[:4] == ["rack_overrides.json", "rack_positions.json", "rack_overrides.json", "rack_positions.json"]
    assert r.status_code == 503 and r.json()["detail"] == devices._MOVE_FAILED
    assert read_layout(lab.folder) == before and await saved_labels(lab.db) == LABELS


async def test_clearing_a_port_named_only_by_the_device_keeps_the_default_name(lab):
    from app.routers import kvms as kvms_module
    from app.schemas import KvmPort, KvmStatus
    # PDU-A outlets 4-6 have nothing saved; the PDU itself reports OPTN99, OPTN98 and its default name.
    cache_pdu("pdu-a", {4: "OPTN99", 5: "OPTN98", 6: "Outlet 6"})
    r = await lab.client.patch("/api/devices/pdu-a/labels", json={**LABELS["pdu-a"], "4": "", "6": ""})
    assert r.status_code == 200, r.text
    # 4 is stored as the default name so OPTN99 no longer shows; 5 was not sent and 6 reports only the default.
    assert (await saved_labels(lab.db))["pdu-a"] == {**LABELS["pdu-a"], "4": "Outlet 4"}
    rows = {s["key"] for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert "optn99" not in rows and "optn98" in rows
    kvms_module._cache["kvm-a"] = (time.time(), KvmStatus(device_id="kvm-a", reachable=True, ports=[
        KvmPort(number=3, label="OPTN97", status="active")]))
    r = await lab.client.patch("/api/devices/kvm-a/labels", json={**LABELS["kvm-a"], "3": ""})
    assert r.status_code == 200, r.text
    assert (await saved_labels(lab.db))["kvm-a"] == {**LABELS["kvm-a"], "3": "Port 3"}
