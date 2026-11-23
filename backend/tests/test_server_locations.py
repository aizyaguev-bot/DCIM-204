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

from app import accounts, inventory_store, name_sync
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
    assert r.json() == {"ok": True, "synced": [], "labels_revision": inventory_store.revision({**LABELS["pdu-a"], "1": "optn45"}),
                        "device_names": "off"}
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
    # The U numbers the DCIM view gave by itself in the racks involved are pinned first (web-1 at U1 in Rack-01, the
    # PSU2 outlet of OPTN45 at U1 in Rack-02), so every outlet keeps its U and only the names swap.
    assert read_layout(lab.folder) == {
        "rack_slots.json": {"Rack-01": {"optn45": 3, "optn44 (psu1)": 7, "web-1": 1},
                            "Rack-02": {"optn45 (psu2)": 3, "optn44 (psu2)": 1}},
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
    # Back where they were; the automatic U numbers the first swap pinned stay pinned.
    assert read_layout(lab.folder) == {**files, "rack_slots.json": {
        "Rack-01": {"optn44": 3, "optn45 (psu1)": 7, "web-1": 1}, "Rack-02": {"optn44 (psu2)": 3, "optn45 (psu2)": 1}}}


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
        "rack_slots.json": {"Rack-01": {"optn45": 3, "web-1": 1}, "Rack-02": {"optn45 (psu2)": 3}},
        "rack_positions.json": {"Rack-01": ["optn45", "web-1"]},
        "rack_overrides.json": {"other": "Rack-09"},
        "switch_assignments.json": {"optn45": {"switch": "SW1", "port": "12"}},
    }
    assert await monitors_and_owners(lab.db) == people
    keys = [s["key"] for s in (await lab.client.get("/api/devices/locations")).json()["servers"]]
    # OPTN44 has no port, layout entry or monitor left; web-1 now lists at its pinned U1, before OPTN45 at U3.
    assert keys == ["web-1", "optn45", "other"]


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
    # The preview carries the U the DCIM view shows for web-1 (automatic U1); Rack-02's automatic U1 is pinned.
    assert body["positions"] == [
        {"server": "web-1", "before": {"rack": "Rack-01", "slot": 1}, "after": {"rack": "Rack-02", "slot": 9}}]
    layout = read_layout(lab.folder)
    assert layout["rack_slots.json"] == {**LAYOUT["rack_slots.json"],
                                         "Rack-02": {"optn44 (psu2)": 3, "optn45 (psu2)": 1, "web-1": 9}}
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
    # Its layout ids still match a label it keeps; only web-1's automatic U in its rack is pinned.
    assert read_layout(lab.folder) == {**LAYOUT, "rack_slots.json": {**LAYOUT["rack_slots.json"],
                                                                     "Rack-01": {"optn44": 3, "optn45 (psu1)": 7, "web-1": 1}}}


OCCUPIED_U3 = ("U3 in Rack-01 is used by OPTN44. Choose OPTN44 as the target to swap the two servers (their outlets "
               "and KVM ports swap too), or choose an empty slot.")


async def test_target_slot_occupied_is_409_with_or_without_swap_and_writes_nothing(lab):
    # PDU outlets and KVM ports belong to the floor (owner, 2026-11-10). Swapping positions only would leave OPTN44 on
    # web-1's old floor with the outlet and KVM labels of the floor it left, so a move to ports takes an empty slot only.
    write_units(lab)   # Switch 01 on OPTN44's floor U3
    files, people = snapshot(lab.folder, locks=True), await monitors_and_owners(lab.db)
    body = dict(server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="Rack-01", target_slot=3)
    for swap in (True, False):
        for dry_run in (True, False):
            r = await move(lab, **body, swap=swap, dry_run=dry_run, units_follow=True)
            assert r.status_code == 409, r.text
            assert r.json()["detail"] == OCCUPIED_U3
            # Nothing written: port labels, layout files, the units, the change counter, not even a lock file.
            assert await saved_labels(lab.db) == LABELS
            assert snapshot(lab.folder, locks=True) == files
            assert await monitors_and_owners(lab.db) == people
    # The same slot given as the rack's own (no rack chosen) is refused the same way.
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_slot=3)
    assert r.status_code == 409 and r.json()["detail"] == OCCUPIED_U3
    assert await saved_labels(lab.db) == LABELS and snapshot(lab.folder, locks=True) == files


async def test_the_occupied_slot_is_taken_by_swapping_with_its_server_and_each_floor_keeps_its_ports(lab):
    # What the 409 above points to: the swap with OPTN44 gives web-1 U3 with U3's outlets and KVM port, and OPTN44
    # web-1's U1 with web-1's outlet. Every outlet and port names the server now on its floor.
    write_units(lab)
    dry = await move(lab, server="web-1", target_server="OPTN44", swap=True, units_follow=True, dry_run=True)
    assert dry.status_code == 200, dry.text
    assert dry.json()["positions"] == [
        {"server": "web-1", "before": {"rack": "Rack-01", "slot": 1}, "after": {"rack": "Rack-01", "slot": 3}},
        {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": "Rack-01", "slot": 1}}]
    r = await move(lab, server="web-1", target_server="OPTN44", swap=True, units_follow=True,
                   plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 200, r.text
    assert await saved_labels(lab.db) == {
        "pdu-a": {"1": "web-1", "2": "OPTN45 (PSU1)", "3": "OPTN44"},
        "pdu-b": {"1": "web-1", "2": "OPTN45 (PSU2)", "5": "Outlet 5"},   # a feed suffix is kept for OPT names only
        "kvm-a": {"1": "web-1", "2": "OPTN45"}}
    # The unit on U3 moves with OPTN44 to U1.
    saved = json.loads((lab.folder / "rack_items.json").read_text(encoding="utf-8"))
    assert sorted((i["id"], i["u"]) for i in saved["Rack-01"]) == [("u1", 1), ("u2", 7), ("u3", 5)]


async def test_target_slot_alone_uses_the_current_rack(lab):
    r = await move(lab, server="optn45", target_ports=[{"device_id": "pdu-a", "port": "2"}], target_slot=5)
    assert r.status_code == 200, r.text
    assert r.json()["positions"][0]["after"] == {"rack": "Rack-01", "slot": 5}
    assert read_layout(lab.folder)["rack_slots.json"]["Rack-01"] == {"optn44": 3, "optn45 (psu1)": 5, "web-1": 1}


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
    # optn46 keeps the rack of its old PDU (Rack-02). "Legacy" showed at the automatic U1 of Rack-02, which the move
    # pinned, so the rack layout still lists it there without a port, like any server with a saved U.
    assert keys == ["optn44", "optn45", "web-1", "legacy", "optn46", "other"]


async def test_dry_run_returns_the_same_answer_and_writes_nothing(lab):
    files, people = snapshot(lab.folder, locks=True), await monitors_and_owners(lab.db)
    for body in (dict(server="optn45", target_server="optn44"), dict(server="optn45", target_server="optn44", swap=False),
                 dict(server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="Rack-01",
                      target_slot=5)):
        preview = await move(lab, **body, dry_run=True)
        assert preview.status_code == 200, preview.text
        assert preview.json()["dry_run"] is True and preview.json()["changes"]
        assert await saved_labels(lab.db) == LABELS
        assert snapshot(lab.folder, locks=True) == files  # not even a lock file
        assert await monitors_and_owners(lab.db) == people
    applied = await move(lab, **body)
    assert {**preview.json(), "dry_run": False, "device_names": "off"} == applied.json()


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
        payload = {**json.loads(path.read_text()), "Rack-07": {"opt70": 1}}
        seen["etag"] = await asyncio.wait_for(
            asyncio.to_thread(inventory_store.save_layout, path, payload, None, {}), timeout=5)
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 200, r.text
    slots = json.loads(path.read_text())
    assert seen["etag"] and slots["Rack-07"] == {"opt70": 1}
    assert slots["Rack-01"] == SWAPPED_SLOTS


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
    assert read_layout(lab.folder)["rack_slots.json"] == {"Rack-01": {"optn44": 3, "web-1": 1},
                                                          "Rack-02": {"optn44 (psu2)": 3, "optn45": 4}}


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
        assert read_layout(lab.folder)["rack_slots.json"]["Rack-01"] == SWAPPED_SLOTS
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
    assert accounts.required_role("/api/devices/clear-server", "POST") == "Operator"
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


@pytest.mark.parametrize("username,status", [("viewer", 403), ("operator", 200), ("admin", 200)])
async def test_only_operators_and_admins_clear_a_server(accounts_lab, username, status):
    async with AsyncClient(transport=ASGITransport(app=accounts_lab), base_url="http://test") as c:
        r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert r.status_code == 200, r.text
        c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        for dry_run in (True, False):
            r = await c.post("/api/devices/clear-server", json={"server": "web-1", "dry_run": dry_run})
            assert r.status_code == status, r.text
        rows = {s["key"]: s for s in (await c.get("/api/devices/locations")).json()["servers"]}
        assert rows["web-1"]["pdu"] == ([] if status == 200 else [
            {"device_id": "pdu-a", "device_name": "PDU-A", "port": "3", "label": "web-1"}])


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

SWAPPED_SLOTS = {"optn45": 3, "optn44 (psu1)": 7, "web-1": 1}  # web-1's automatic U1 is pinned by the swap


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
        payload = {**json.loads(path.read_text()), "Rack-07": {"opt70": 1}}
        await asyncio.wait_for(asyncio.to_thread(inventory_store.save_layout, path, payload, None, {}), timeout=5)
        raise RuntimeError("disk I/O error")
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 503 and r.json()["detail"] == devices._MOVE_FAILED
    assert json.loads(path.read_text()) == {**LAYOUT["rack_slots.json"], "Rack-07": {"opt70": 1}}
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
                    other.put("/api/rack-slots", json={**slots, "Rack-07": {"opt70": 1}}), timeout=5)
        await real_commit()
    monkeypatch.setattr(lab.db, "commit", commit)
    r = await move(lab, server="optn45", target_server="optn44")
    assert r.status_code == 200, r.text
    assert seen["put"].status_code == 200, seen["put"].text
    slots = json.loads((lab.folder / "rack_slots.json").read_text())
    assert slots["Rack-07"] == {"opt70": 1} and slots["Rack-01"] == SWAPPED_SLOTS   # both saves are there
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


# ── SWEEP-2395 LOC-1 / LOC-2 / LOC-4: the U numbers the DCIM view gives by itself, the position kept by a clear ─────

def pdu_row(device_id, rack, names):
    """A simulated PDU row whose outlets 1..n carry `names`."""
    return Device(id=device_id, name=device_id.upper(), kind="pdu", ip="", rack=rack, port_count=8,
                  labels_json=json.dumps({str(n): name for n, name in enumerate(names, 1)}))


def dcim_u(rows, layouts):
    """rack -> {DCIM id: U} as the DCIM rack view (DcimView.jsx buildRackRows) numbers these rows."""
    full = {fname: {} for fname in devices._LAYOUT_FILES}
    full.update(layouts)
    units = devices._dcim_units(rows, {d.id: d.labels for d in rows}, full)
    return {rack: {i: u for i, (u, _) in entries.items()} for rack, entries in units.items()}


def test_auto_u_parity_vector_shared_with_the_rack_rows_test():
    # The same vector frontend/src/__tests__/rack-rows.test.js asserts for buildRackRows (contract C7).
    rows = [pdu_row("pdu-1", "Rack-01", ["OPT11", "OPT12", "OPT13", "OPT14"]),
            pdu_row("pdu-5", "Rack-05", ["OPT51", "OPT52", "OPT53", "OPT54"])]
    assert dcim_u(rows, {"rack_slots.json": {"Rack-01": {"opt13": 7}}}) == {
        "Rack-01": {"opt11": 1, "opt12": 2, "opt14": 3, "opt13": 7},
        "Rack-05": {"opt51": 1, "opt52": 2, "opt53": 3, "opt54": 4}}
    # A rack override draws the label in that rack, where it takes its place in name order.
    assert dcim_u(rows, {"rack_overrides.json": {"opt12": "Rack-05"}})["Rack-05"] == {
        "opt12": 1, "opt51": 2, "opt52": 3, "opt53": 4, "opt54": 5}


def test_auto_u_follows_build_rack_rows_for_placeholders_order_and_slots():
    # The rack-rows.test.js cases: placeholder labels never take a U; rack order and saved slots decide first.
    rows = [pdu_row("pdu-7", "Rack-07", ["empty", "OPT71", "OPT72", "OPT73", "OPT74"])]
    assert dcim_u(rows, {}) == {"Rack-07": {"opt71": 1, "opt72": 2, "opt73": 3, "opt74": 4}}
    rows = [pdu_row("pdu-1", "Rack-01", ["KVM Power", "OPT1", "PDU", "--", "n/a", " Free ", "SPARE", "kvm_power"]),
            pdu_row("pdu-2", "Rack-01", ["OPT2", "empty box", "Outlet 3", "port 4", "  "])]
    assert dcim_u(rows, {}) == {"Rack-01": {"empty box": 1, "opt1": 2, "opt2": 3}}
    rows = [pdu_row("pdu-1", "Rack-01", ["empty", "OPT1", "OPT2", "OPT3"])]
    assert dcim_u(rows, {"rack_positions.json": {"Rack-01": ["opt3", "empty", "opt1", "opt2"]},
                         "rack_slots.json": {"Rack-01": {"opt2": 1}}}) == {"Rack-01": {"opt2": 1, "opt3": 2, "opt1": 3}}
    # Saved values count as JavaScript Number() reads them; a null slot is no slot.
    rows = [pdu_row("pdu-1", "Rack-01", ["OPT1", "OPT2", "OPT3", "OPT4"])]
    assert dcim_u(rows, {"rack_slots.json": {"Rack-01": {"opt1": "2", "opt2": True, "opt3": None}}}) == {
        "Rack-01": {"opt1": 2, "opt2": 1, "opt3": 3, "opt4": 4}}


def test_the_non_server_label_rule_is_the_dcim_views_byte_for_byte():
    import pathlib
    import re
    source = pathlib.Path(devices.__file__).resolve().parents[3] / "frontend" / "src" / "pages" / "DcimView.jsx"
    if not source.exists():
        pytest.skip("frontend source not present")
    found = re.search(r"const NON_SERVER_LABEL = /(.+)/([a-z]*);", source.read_text(encoding="utf-8"))
    assert found and found[1] == devices._NON_SERVER_LABEL.pattern and found[2] == "i"


def test_names_sort_like_locale_compare():
    # Node's localeCompare order (ICU, en-US) for these names: the DCIM view sorts servers without a rack order so.
    expected = ["_x", "-x", "@x", "~x", "1x", "a b", "a_b", "a-b", "a.b", "a(b)", "a1", "A1", "a10", "a1b", "a9", "ab",
                "aB", "Ab", "AB", "e", "é", "f", "Opt_3", "OPT11", "opt12", "optn44", "optn44 (psu1)",
                "OPTN44 (PSU2)", "web-1", "x;", "x:", "z", "Z"]
    assert sorted(reversed(expected), key=devices._locale_key) == expected


def test_pinning_copies_the_layouts():
    layouts = {fname: {} for fname in devices._LAYOUT_FILES}
    layouts["rack_slots.json"] = {"Rack-05": {"opt53": 9}, "Rack-06": ["malformed"]}
    auto = {"Rack-05": {"opt51": 1, "opt52": 2}, "Rack-06": {"opt61": 1}, "Rack-07": {"opt71": 1}}
    pinned = devices._with_auto_pins(layouts, auto, {"Rack-05", "Rack-06"}, skip={"opt52"})
    assert pinned["rack_slots.json"] == {"Rack-05": {"opt53": 9, "opt51": 1}, "Rack-06": ["malformed"]}
    assert layouts["rack_slots.json"] == {"Rack-05": {"opt53": 9}, "Rack-06": ["malformed"]}


@pytest.fixture
async def auto_lab(client, db_session, tmp_path, monkeypatch):
    """Racks numbered only by the DCIM view itself: no rack layout file exists."""
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    db_session.add_all([pdu_row("pdu-4", "Rack-04", ["OPT41", "OPT42", "OPT43", "OPT44"]),
                        pdu_row("pdu-5", "Rack-05", ["OPT51", "OPT52", "OPT53", "OPT54"]),
                        pdu_row("pdu-7", "Rack-07", ["OPT71", "OPT72", "OPT73"])])
    await db_session.commit()
    return SimpleNamespace(client=client, db=db_session, folder=tmp_path)


async def dcim_view(lab):
    """rack -> {DCIM id: U} as the DCIM rack view shows the saved labels and layout files now."""
    rows = (await lab.db.execute(select(Device).execution_options(populate_existing=True))).scalars().all()
    layouts, _ = devices._read_layouts(strict=True)
    return {rack: {i: u for i, (u, _) in entries.items()}
            for rack, entries in devices._dcim_units(rows, {d.id: d.labels for d in rows}, layouts).items()}


async def test_a_swap_keeps_every_automatic_u_in_both_racks(auto_lab):
    before = await dcim_view(auto_lab)
    assert before == {"Rack-04": {"opt41": 1, "opt42": 2, "opt43": 3, "opt44": 4},
                      "Rack-05": {"opt51": 1, "opt52": 2, "opt53": 3, "opt54": 4},
                      "Rack-07": {"opt71": 1, "opt72": 2, "opt73": 3}}
    preview = await move(auto_lab, server="OPT52", target_server="OPT71", dry_run=True)
    assert preview.status_code == 200, preview.text
    # The preview shows the U the DCIM view shows, not "no slot".
    assert preview.json()["positions"] == [
        {"server": "OPT52", "before": {"rack": "Rack-05", "slot": 2}, "after": {"rack": "Rack-07", "slot": 1}},
        {"server": "OPT71", "before": {"rack": "Rack-07", "slot": 1}, "after": {"rack": "Rack-05", "slot": 2}}]
    assert not list(auto_lab.folder.glob("*.json"))
    r = await move(auto_lab, server="OPT52", target_server="OPT71", plan_revision=preview.json()["plan_revision"])
    assert r.status_code == 200, r.text
    assert read_layout(auto_lab.folder) == {"rack_slots.json": {
        "Rack-05": {"opt51": 1, "opt71": 2, "opt53": 3, "opt54": 4}, "Rack-07": {"opt52": 1, "opt72": 2, "opt73": 3}}}
    # Before the fix OPT71 sorted after OPT54 in Rack-05, so OPT53 and OPT54 each moved up a U.
    assert await dcim_view(auto_lab) == {"Rack-04": before["Rack-04"],
                                         "Rack-05": {"opt51": 1, "opt71": 2, "opt53": 3, "opt54": 4},
                                         "Rack-07": {"opt52": 1, "opt72": 2, "opt73": 3}}


async def test_a_slot_shown_by_an_automatic_u_is_occupied_and_the_server_swap_takes_it(auto_lab):
    body = dict(server="OPT73", target_ports=[{"device_id": "pdu-4", "port": "6"}], target_rack="Rack-04", target_slot=2)
    for swap in (False, True):
        r = await move(auto_lab, **body, swap=swap)
        assert r.status_code == 409, r.text
        assert r.json()["detail"].startswith("U2 in Rack-04 is used by OPT42. Choose OPT42 as the target to swap")
        assert not list(auto_lab.folder.glob("*.json"))
    before = await dcim_view(auto_lab)
    r = await move(auto_lab, server="OPT73", target_server="OPT42")
    assert r.status_code == 200, r.text
    assert r.json()["positions"] == [
        {"server": "OPT73", "before": {"rack": "Rack-07", "slot": 3}, "after": {"rack": "Rack-04", "slot": 2}},
        {"server": "OPT42", "before": {"rack": "Rack-04", "slot": 2}, "after": {"rack": "Rack-07", "slot": 3}}]
    # OPT41, OPT43 and OPT44 stay at U1, U3 and U4; OPT42 takes OPT73's U3 in Rack-07.
    assert await dcim_view(auto_lab) == {"Rack-04": {"opt41": 1, "opt73": 2, "opt43": 3, "opt44": 4},
                                         "Rack-05": before["Rack-05"],
                                         "Rack-07": {"opt71": 1, "opt72": 2, "opt42": 3}}
    # Each floor keeps its outlet: U2's in Rack-04 now names OPT73, U3's in Rack-07 OPT42.
    labels = await saved_labels(auto_lab.db)
    assert (labels["pdu-4"]["2"], labels["pdu-7"]["3"]) == ("OPT73", "OPT42")


async def test_moving_within_its_own_rack_without_a_slot_keeps_the_u(lab):
    # LOC-4: the Locations dialog sends the current rack and a blank slot.
    r = await move(lab, server="optn45", target_ports=[{"device_id": "pdu-a", "port": "2"}], target_rack="Rack-01")
    assert r.status_code == 200, r.text
    assert r.json()["positions"] == [
        {"server": "OPTN45", "before": {"rack": "Rack-01", "slot": 7}, "after": {"rack": "Rack-01", "slot": 7}}]
    assert read_layout(lab.folder)["rack_slots.json"]["Rack-01"]["optn45 (psu1)"] == 7
    # Another rack without a slot gives no U there yet.
    r = await move(lab, server="optn45", target_ports=[{"device_id": "pdu-a", "port": "2"}], target_rack="Rack-02",
                   dry_run=True)
    assert r.status_code == 200, r.text
    assert r.json()["positions"][0]["after"] == {"rack": "Rack-02", "slot": None}


async def test_kept_position_is_where_a_cleared_server_stays(lab):
    # LOC-2: OPTN44 has a saved U (rack_slots), OPTN45 a rack override and a U, web-1 only a rack order entry, and
    # opt60 only an outlet on PDU-B (its rack comes from that PDU, which a clear takes away). opt60 has a ping monitor,
    # so it stays listed once cleared.
    dev = await lab.db.get(Device, "pdu-b")
    dev.labels_json = json.dumps({**LABELS["pdu-b"], "6": "opt60"})
    lab.db.add(PingTarget(id="t60", source_key="server:opt60", name="opt60", host="opt60"))
    await lab.db.commit()
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    kept = {key: rows[key]["kept_position"] for key in ("optn44", "optn45", "web-1", "opt60", "other")}
    assert kept == {"optn44": {"rack": "Rack-01", "slot": 3}, "optn45": {"rack": "Rack-01", "slot": 7},
                    "web-1": {"rack": "Rack-01", "slot": None}, "opt60": {"rack": None, "slot": None},
                    "other": {"rack": "Rack-09", "slot": None}}
    assert (rows["opt60"]["rack"], rows["opt60"]["slot"]) == ("Rack-02", None)
    for key in ("optn44", "optn45", "web-1", "opt60"):
        for kind in ("pdu", "kvm"):
            for port in rows[key][kind]:
                r = await lab.client.patch("/api/devices/direct-label", json={
                    "device_id": port["device_id"], "port": port["port"], "label": "", "expected": port["label"]})
                assert r.status_code == 200, r.text
    after = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    for key, position in kept.items():
        assert {"rack": after[key]["rack"], "slot": after[key]["slot"]} == position, key
        assert after[key]["kept_position"] == position, key
        assert (after[key]["pdu"], after[key]["kvm"]) == ([], []), key


# ── 8. The units on a floor move with its server in the same step (POST /move-server "rack_items") ──────────────────

UNITS = {"Rack-01": [{"id": "u1", "name": "Switch 01", "u": 3}, {"id": "u2", "name": "Disk shelf", "u": 7},
                     {"id": "u3", "name": "Spare", "u": 5}]}
SWAPPED_UNITS = {"Rack-01": [{"id": "u1", "name": "Switch 01", "u": 7}, {"id": "u2", "name": "Disk shelf", "u": 3},
                             {"id": "u3", "name": "Spare", "u": 5}]}


def write_units(lab, data=UNITS):
    (lab.folder / "rack_items.json").write_text(json.dumps(data))
    return inventory_store.revision(data)


async def test_a_swap_moves_the_floor_units_with_the_servers_in_the_same_step(lab):
    etag = write_units(lab)
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True,
                   rack_items={"data": SWAPPED_UNITS, "if_match": etag})
    assert r.status_code == 200, r.text
    body = r.json()
    saved = json.loads((lab.folder / "rack_items.json").read_text(encoding="utf-8"))
    assert [(i["id"], i["u"]) for i in saved["Rack-01"]] == [("u1", 7), ("u2", 3), ("u3", 5)]
    history = {i["id"]: i.get("tracking_history", []) for i in saved["Rack-01"]}
    assert [(e["action"], e["from"]["u"], e["to"]["u"], e["note"]) for e in history["u1"]] == [
        ("moved", 3, 7, inventory_store.MOVED_WITH_SERVER_NOTE)]
    assert history["u3"] == []   # a unit that stays has no new history
    assert body["rack_items"] == saved
    assert body["revisions"] == {"rack_items": inventory_store.revision(saved)}
    # The outlets and ports stayed with the floors: each server took over the other's.
    labels = await saved_labels(lab.db)
    assert labels["pdu-a"]["1"] == "OPTN45" and labels["kvm-a"] == {"1": "OPTN45", "2": "OPTN44"}
    assert read_layout(lab.folder)["rack_slots.json"]["Rack-01"]["optn45"] == 3
    # A dry run ignores the units (and their shape): it writes nothing.
    files = snapshot(lab.folder)
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True, rack_items="not checked")
    assert r.status_code == 200 and "rack_items" not in r.json() and snapshot(lab.folder) == files


async def test_stale_or_invalid_units_refuse_the_whole_move_and_write_nothing(lab):
    etag = write_units(lab)
    files, labels = snapshot(lab.folder), await saved_labels(lab.db)
    stale = await move(lab, server="optn45", target_server="OPTN44", swap=True,
                       rack_items={"data": SWAPPED_UNITS, "if_match": inventory_store.revision({"other": []})})
    assert stale.status_code == 409 and stale.json()["detail"] == devices._ITEMS_CHANGED
    bad_u = {"Rack-01": [{**UNITS["Rack-01"][0], "u": 99}, *UNITS["Rack-01"][1:]]}
    invalid = await move(lab, server="optn45", target_server="OPTN44", swap=True,
                         rack_items={"data": bad_u, "if_match": etag})
    assert invalid.status_code == 422, invalid.text
    for shape in ({"data": SWAPPED_UNITS}, {"data": [], "if_match": etag}, "units"):
        r = await move(lab, server="optn45", target_server="OPTN44", swap=True, rack_items=shape)
        assert r.status_code == 400 and r.json()["detail"] == devices._ITEMS_NEED
    assert snapshot(lab.folder) == files
    assert await saved_labels(lab.db) == labels


async def test_units_changed_while_the_labels_commit_undo_the_labels(lab, monkeypatch):
    etag = write_units(lab)
    files, labels = read_layout(lab.folder), await saved_labels(lab.db)
    real_read, real_write = devices._read_layouts, devices._write_layouts

    def another_session_moves_a_unit(strict):
        # Read again under the locks by _write_layouts, after the labels were committed.
        (lab.folder / "rack_items.json").write_text(json.dumps({"Rack-01": UNITS["Rack-01"][:2]}))
        return real_read(strict)

    def write(*args, **kwargs):
        monkeypatch.setattr(devices, "_read_layouts", another_session_moves_a_unit)
        try:
            return real_write(*args, **kwargs)
        finally:
            monkeypatch.setattr(devices, "_read_layouts", real_read)
    monkeypatch.setattr(devices, "_write_layouts", write)
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True,
                   rack_items={"data": SWAPPED_UNITS, "if_match": etag})
    assert r.status_code == 409 and r.json()["detail"] == devices._ITEMS_CHANGED
    assert await saved_labels(lab.db) == labels
    assert read_layout(lab.folder) == files


async def test_a_failed_unit_write_puts_back_the_layout_and_the_labels(lab, monkeypatch):
    etag = write_units(lab)
    units_before = (lab.folder / "rack_items.json").read_bytes()
    files, labels = read_layout(lab.folder), await saved_labels(lab.db)

    def broken(data):
        (lab.folder / "rack_items.json").write_text("{half")
        raise OSError("disk full")
    monkeypatch.setattr(inventory_store, "write_items", broken)
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True,
                   rack_items={"data": SWAPPED_UNITS, "if_match": etag})
    assert r.status_code == 503, r.text
    assert (lab.folder / "rack_items.json").read_bytes() == units_before
    assert read_layout(lab.folder) == files
    assert await saved_labels(lab.db) == labels
    assert not list(lab.folder.glob("*.tmp"))


async def test_a_move_leaves_placeholder_outlet_labels_out_of_the_position_stores(lab):
    layout = {**LAYOUT,
              "rack_slots.json": {"Rack-01": {**LAYOUT["rack_slots.json"]["Rack-01"], "empty": 2, "kvm power": 4},
                                  "Rack-02": LAYOUT["rack_slots.json"]["Rack-02"]},
              "rack_positions.json": {"Rack-01": [*LAYOUT["rack_positions.json"]["Rack-01"], "Outlet 4", "spare"]},
              "rack_overrides.json": {**LAYOUT["rack_overrides.json"], "Empty": "Rack-01"}}
    write_layout(lab.folder, layout)
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True)
    assert r.status_code == 200, r.text
    saved = read_layout(lab.folder)
    assert not {"empty", "kvm power"} & set(saved["rack_slots.json"]["Rack-01"])
    assert saved["rack_slots.json"]["Rack-01"]["optn45"] == 3
    assert saved["rack_positions.json"]["Rack-01"] == ["optn44 (psu1)", "optn45", "web-1"]
    assert saved["rack_overrides.json"] == {"optn44 (psu1)": "Rack-01", "other": "Rack-09"}


# ── 9. Ports named only on the KVM/PDU itself, and the units that follow without rack_items (QA 2026-11-10) ──────────

from app.models import MonitorDeviceSnapshot  # noqa: E402
from app.routers import kvms as kvms_module  # noqa: E402
from app.schemas import KvmPort, KvmStatus  # noqa: E402


async def kvm_names_only_on_the_device(lab, observed=True, cache="down"):
    """kvm-a keeps only port 1 saved; OPTN45's port 2 is named on the KVM itself. cache: "down" (its last read failed:
    no port list), "up" (it answers with its own names) or None (nothing read it since the start)."""
    kvm = await lab.db.get(Device, "kvm-a")
    kvm.labels_json = json.dumps({"1": "optn44"})
    ports = [{"number": 1, "label": "optn44"}, {"number": 2, "label": "OPTN45"}, {"number": 3, "label": "Port 3"},
             {"number": 4, "label": "Port 4"}]
    if observed:
        lab.db.add(MonitorDeviceSnapshot(device_id="kvm-a", kind="kvm", ip="192.0.2.13", checked_at=time.time(),
                                         reachable=cache == "up", ports_json=json.dumps(ports)))
    await lab.db.commit()
    if cache == "down":
        kvms_module._cache["kvm-a"] = (time.monotonic(), KvmStatus(device_id="kvm-a", reachable=False, error="timeout"))
    elif cache == "up":
        kvms_module._cache["kvm-a"] = (time.monotonic(), KvmStatus(device_id="kvm-a", reachable=True, ports=[
            KvmPort(number=p["number"], label=p["label"], status="idle") for p in ports]))
    # The PDUs answer (their outlets are known), so only the KVM can be unchecked here.
    for pdu in ("pdu-a", "pdu-b"):
        pdus_module._cache[pdu] = (time.monotonic(), PduStatus(device_id=pdu, reachable=True, outlets=[
            OutletState(number=n, label=f"Outlet {n}", state="on") for n in range(1, 9)]))


@pytest.mark.parametrize("cache", ["down", None])
async def test_a_kvm_that_does_not_answer_still_moves_its_ports_from_its_last_check(lab, cache):
    await kvm_names_only_on_the_device(lab, cache=cache)
    row = next(s for s in (await lab.client.get("/api/devices/locations")).json()["servers"] if s["key"] == "optn45")
    assert [(p["device_id"], p["port"]) for p in row["kvm"]] == [("kvm-a", "2")]   # Locations sees the same port
    dry = await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True)
    assert dry.status_code == 200, dry.text
    assert "unchecked" not in dry.json()
    kvm_changes = [(c["port"], c["before"], c["after"]) for c in dry.json()["changes"] if c["device_id"] == "kvm-a"]
    assert kvm_changes == [("1", "optn44", "OPTN45"), ("2", "OPTN45", "OPTN44")]
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True, plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 200, r.text
    # Saved in Lab Manager, so the KVM's own (old) names never put a server back on the floor it left.
    assert (await saved_labels(lab.db))["kvm-a"] == {"1": "OPTN45", "2": "OPTN44"}


async def test_unknown_kvm_port_names_are_reported_as_unchecked(lab):
    await kvm_names_only_on_the_device(lab, observed=False, cache=None)
    dry = await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True)
    assert dry.status_code == 200, dry.text
    assert dry.json()["unchecked"] == [{"device_id": "kvm-a", "device_name": "KVM-A", "kind": "kvm", "ports": ["2", "3", "4"]}]
    assert [c["device_id"] for c in dry.json()["changes"]].count("kvm-a") == 1   # only its saved port 1 is known
    # Once the KVM answers, its names count and nothing is unchecked any more; a preview made before is refused.
    kvms_module._cache["kvm-a"] = (time.monotonic(), KvmStatus(device_id="kvm-a", reachable=True, ports=[
        KvmPort(number=1, label="optn44", status="idle"), KvmPort(number=2, label="OPTN45", status="idle"),
        KvmPort(number=3, label="Port 3", status="idle"), KvmPort(number=4, label="Port 4", status="idle")]))
    stale = await move(lab, server="optn45", target_server="OPTN44", swap=True, plan_revision=dry.json()["plan_revision"])
    assert stale.status_code == 409
    fresh = await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True)
    assert "unchecked" not in fresh.json()
    assert [(c["port"], c["after"]) for c in fresh.json()["changes"] if c["device_id"] == "kvm-a"] == [
        ("1", "OPTN45"), ("2", "OPTN44")]
    # A device of another rack is not this move's concern; a fully labelled one is never unchecked.
    kvms_module._cache.clear()
    kvm = await lab.db.get(Device, "kvm-a")
    kvm.rack = "Rack-05"
    await lab.db.commit()
    assert "unchecked" not in (await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True)).json()
    kvm.rack, kvm.labels_json = "Rack-01", json.dumps({"1": "optn44", "2": "OPTN45", "3": "Port 3", "4": "Port 4"})
    await lab.db.commit()
    assert "unchecked" not in (await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True)).json()


async def test_a_snapshot_of_another_address_is_not_used(lab):
    await kvm_names_only_on_the_device(lab, cache="down")
    kvm = await lab.db.get(Device, "kvm-a")
    kvm.ip = "192.0.2.99"
    await lab.db.commit()
    dry = (await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True)).json()
    assert dry["unchecked"][0]["device_id"] == "kvm-a"


async def test_units_follow_moves_the_floor_units_without_rack_items(lab):
    etag = write_units(lab)
    dry = await move(lab, server="optn45", target_server="OPTN44", swap=True, units_follow=True, dry_run=True)
    assert dry.status_code == 200, dry.text
    assert dry.json()["units"] == [
        {"server": "OPTN45", "from": {"rack": "Rack-01", "slot": 7}, "to": {"rack": "Rack-01", "slot": 3},
         "units": [{"id": "u2", "name": "Disk shelf"}]},
        {"server": "OPTN44", "from": {"rack": "Rack-01", "slot": 3}, "to": {"rack": "Rack-01", "slot": 7},
         "units": [{"id": "u1", "name": "Switch 01"}]}]
    assert (lab.folder / "rack_items.json").read_text() == json.dumps(UNITS)   # a preview writes nothing
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True, units_follow=True,
                   plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 200, r.text
    saved = json.loads((lab.folder / "rack_items.json").read_text(encoding="utf-8"))
    assert sorted((i["id"], i["u"]) for i in saved["Rack-01"]) == [("u1", 7), ("u2", 3), ("u3", 5)]
    moved = {i["id"]: i.get("tracking_history", []) for i in saved["Rack-01"]}
    assert [(e["action"], e["note"]) for e in moved["u1"]] == [("moved", inventory_store.MOVED_WITH_SERVER_NOTE)]
    assert moved["u3"] == []
    assert r.json()["revisions"] == {"rack_items": inventory_store.revision(saved)} != {"rack_items": etag}
    assert (await saved_labels(lab.db))["kvm-a"] == {"1": "OPTN45", "2": "OPTN44"}


async def test_units_follow_refusals_and_a_unit_changed_since_the_preview(lab):
    write_units(lab)
    files, labels = snapshot(lab.folder), await saved_labels(lab.db)
    for body in ({"units_follow": "yes"}, {"units_follow": True, "rack_items": {"data": UNITS, "if_match": '"x"'}}):
        r = await move(lab, server="optn45", target_server="OPTN44", swap=True, **body)
        assert r.status_code == 400, r.text
    dry = await move(lab, server="optn45", target_server="OPTN44", swap=True, units_follow=True, dry_run=True)
    # Another session moves a unit onto floor 7 after the preview: the plan changed, nothing is written.
    write_units(lab, {"Rack-01": [*UNITS["Rack-01"], {"id": "u4", "name": "New", "u": 7}]})
    files = snapshot(lab.folder)
    r = await move(lab, server="optn45", target_server="OPTN44", swap=True, units_follow=True,
                   plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 409
    assert snapshot(lab.folder) == files and await saved_labels(lab.db) == labels


async def test_units_follow_keeps_the_units_of_a_shared_floor_and_moves_none_without_a_floor(lab):
    write_units(lab)
    layout = {**LAYOUT, "rack_slots.json": {**LAYOUT["rack_slots.json"],
                                            "Rack-01": {**LAYOUT["rack_slots.json"]["Rack-01"], "web-1": 7}}}
    write_layout(lab.folder, layout)
    dry = await move(lab, server="optn45", target_server="OPTN44", swap=True, units_follow=True, dry_run=True)
    assert dry.status_code == 200, dry.text
    # web-1 stays on floor 7, so floor 7's units stay too; floor 3's units go with OPTN44.
    assert [(m["server"], [u["id"] for u in m["units"]]) for m in dry.json()["units"]] == [("OPTN44", ["u1"])]
    # Ports only: nobody changes floor, so no unit moves (and the plan has no "units").
    ports = await move(lab, server="optn45", target_ports=[{"device_id": "pdu-a", "port": "6"}], swap=False,
                       units_follow=True, dry_run=True)
    assert ports.status_code == 200, ports.text
    assert "units" not in ports.json()


# ── One server window (WP-B): /locations floors and flags, removed servers, the switch in a move plan, clear-server
#    and the rack a move to ports names ──────────────────────────────────────────────────────────────────────────────

REMOVED_TEXT = "{} was removed from the lab. Restore it first (Inventory › Removed)."


def write_removed(folder, key, name, ports):
    """removed_servers.json with one server removed while the ports `ports` ("device_id:port") carried its name."""
    (folder / "removed_servers.json").write_text(json.dumps(
        {"servers": {key: {"key": key, "name": name, "removed_at": 1.0, "ports_ids": ports}}, "log": []}))


async def location_rows(lab):
    r = await lab.client.get("/api/devices/locations")
    assert r.status_code == 200, r.text
    return {s["key"]: s for s in r.json()["servers"]}


async def clear(lab, **body):
    return await lab.client.post("/api/devices/clear-server", json=body)


async def test_locations_rows_give_the_dcim_ids_the_drawn_floor_and_the_removed_flag(lab):
    rows = await location_rows(lab)
    assert {k: (r["dcim_ids"], r["drawn"], r["removed"]) for k, r in rows.items()} == {
        "optn44": (["optn44", "optn44 (psu2)"], {"rack": "Rack-01", "u": 3, "auto": False}, False),
        "optn45": (["optn45 (psu1)", "optn45 (psu2)", "optn45"], {"rack": "Rack-01", "u": 7, "auto": False}, False),
        "web-1": (["web-1"], {"rack": "Rack-01", "u": 1, "auto": True}, False),     # the next free U, numbered by DCIM
        "other": (["other"], None, False)}       # known only from rack_overrides.json: not drawn on Racks
    # The fields the pages read before are unchanged.
    assert (rows["optn44"]["rack"], rows["optn44"]["slot"], rows["optn44"]["kept_position"]) == (
        "Rack-01", 3, {"rack": "Rack-01", "slot": 3})
    # A U that is no number (DCIM reads NaN) is drawn without a U, and the answer is still JSON.
    layout = {**LAYOUT, "rack_slots.json": {**LAYOUT["rack_slots.json"],
                                            "Rack-01": {**LAYOUT["rack_slots.json"]["Rack-01"], "web-1": "x"}}}
    write_layout(lab.folder, layout)
    assert (await location_rows(lab))["web-1"]["drawn"] == {"rack": "Rack-01", "u": None, "auto": False}
    # A removed server is flagged and is not drawn (it takes no U); the others are as they were.
    write_layout(lab.folder)
    write_removed(lab.folder, "web-1", "web-1", ["pdu-a:3"])
    after = await location_rows(lab)
    assert (after["web-1"]["removed"], after["web-1"]["drawn"]) == (True, None)
    assert {k: r for k, r in after.items() if k != "web-1"} == {k: r for k, r in rows.items() if k != "web-1"}


async def test_a_removed_server_is_never_moved_swapped_with_or_cleared(lab):
    write_removed(lab.folder, "web-1", "web-1", ["pdu-a:3"])
    files, labels = snapshot(lab.folder), await saved_labels(lab.db)
    for body in ({"server": "web-1", "target_ports": [{"device_id": "pdu-a", "port": "4"}]},
                 {"server": "WEB-1", "target_server": "optn44"},
                 {"server": "optn44", "target_server": "web-1", "swap": True},
                 {"server": "optn44", "target_server": "web-1", "swap": False}):
        for dry_run in (True, False):
            r = await move(lab, **body, dry_run=dry_run)
            assert r.status_code == 409 and r.json()["detail"] == REMOVED_TEXT.format("web-1"), (body, r.text)
        r = await move(lab, **body, units_follow=True)
        assert r.status_code == 409, r.text
    for dry_run in (True, False):
        r = await clear(lab, server="web-1", dry_run=dry_run)
        assert r.status_code == 409 and r.json()["detail"] == REMOVED_TEXT.format("web-1"), r.text
    assert snapshot(lab.folder) == files and await saved_labels(lab.db) == labels
    # Its name written on another port (a new machine that reuses the name) shows it again: then it moves as any server.
    r = await lab.client.patch("/api/devices/direct-label", json={"device_id": "pdu-b", "port": "6", "label": "web-1"})
    assert r.status_code == 200, r.text
    assert (await location_rows(lab))["web-1"]["removed"] is False
    assert (await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], dry_run=True)).status_code == 200
    assert (await clear(lab, server="web-1", dry_run=True)).status_code == 200


async def test_the_move_plan_lists_each_servers_switch_port_before_and_after(lab):
    swap = await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True)
    assert swap.status_code == 200, swap.text
    # The switch_assignments.json entries follow the layout ids, so they stay with the floor as the outlets do.
    assert swap.json()["switch"] == [
        {"server": "OPTN45", "before": {"switch": "SW2", "port": "3"}, "after": {"switch": "SW1", "port": "12"}},
        {"server": "OPTN44", "before": {"switch": "SW1", "port": "12"}, "after": {"switch": "SW2", "port": "3"}}]
    take = await move(lab, server="optn45", target_server="OPTN44", swap=False, dry_run=True)
    assert take.json()["switch"] == [
        {"server": "OPTN45", "before": {"switch": "SW2", "port": "3"}, "after": {"switch": "SW1", "port": "12"}},
        {"server": "OPTN44", "before": {"switch": "SW1", "port": "12"}, "after": None}]
    ports = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], dry_run=True)
    assert ports.json()["switch"] == [{"server": "web-1", "before": None, "after": None}]
    # The switch is part of the plan: a switch port changed in another session since the preview refuses the Apply.
    layout = {**LAYOUT, "switch_assignments.json": {**LAYOUT["switch_assignments.json"], "optn44": {"switch": "SW7", "port": 1}}}
    write_layout(lab.folder, layout)
    stale = await move(lab, server="optn45", target_server="OPTN44", swap=True, plan_revision=swap.json()["plan_revision"])
    assert stale.status_code == 409 and stale.json()["detail"] == "Changed since the preview. Preview again."
    assert await saved_labels(lab.db) == LABELS and read_layout(lab.folder) == layout
    fresh = await move(lab, server="optn45", target_server="OPTN44", swap=True, dry_run=True)
    assert fresh.json()["switch"][0]["after"] == {"switch": "SW7", "port": "1"}
    applied = await move(lab, server="optn45", target_server="OPTN44", swap=True, plan_revision=fresh.json()["plan_revision"])
    assert applied.status_code == 200, applied.text
    assert applied.json()["switch"] == fresh.json()["switch"]
    assert read_layout(lab.folder)["switch_assignments.json"] == {
        "optn45": {"switch": "SW7", "port": 1}, "optn44 (psu1)": {"switch": "SW2", "port": "3"}}


async def test_clear_server_previews_then_clears_every_port_and_keeps_the_rack_place(lab, monkeypatch):
    queued = []

    async def spy(device_ports):
        queued.append({k: set(v) for k, v in device_ports.items()})
        return {"device_names": "queued"}
    monkeypatch.setattr(name_sync, "queue", spy)
    files, people = snapshot(lab.folder), await monitors_and_owners(lab.db)
    dry = await clear(lab, server="optn44 (psu2)", dry_run=True)
    assert dry.status_code == 200, dry.text
    plan = dry.json()
    assert [(c["device_id"], c["port"], c["before"], c["after"]) for c in plan["changes"]] == [
        ("pdu-a", "1", "OPTN44", "Outlet 1"), ("pdu-b", "1", "optn44 (PSU2)", "Outlet 1"), ("kvm-a", "1", "optn44", "Port 1")]
    assert plan["positions"] == [
        {"server": "OPTN44", "before": {"rack": "Rack-01", "slot": 3}, "after": {"rack": "Rack-01", "slot": 3}}]
    assert (plan["ok"], plan["dry_run"], plan["unplaced"], "device_names" in plan) == (True, True, [], False)
    assert queued == [] and await saved_labels(lab.db) == LABELS and snapshot(lab.folder) == files
    r = await clear(lab, server="OPTN44", plan_revision=plan["plan_revision"])
    assert r.status_code == 200, r.text
    assert r.json() == {**plan, "dry_run": False, "device_names": "queued"}
    assert queued == [{"pdu-a": {"1"}, "pdu-b": {"1"}, "kvm-a": {"1"}}]     # the device names follow, once
    assert await saved_labels(lab.db) == {"pdu-a": {**LABELS["pdu-a"], "1": "Outlet 1"},
                                          "pdu-b": {**LABELS["pdu-b"], "1": "Outlet 1"},
                                          "kvm-a": {**LABELS["kvm-a"], "1": "Port 1"}}
    # No layout file is written: the server is no longer drawn on Racks and keeps its saved place for a later move.
    assert snapshot(lab.folder) == files and await monitors_and_owners(lab.db) == people
    row = (await location_rows(lab))["optn44"]
    assert (row["pdu"], row["kvm"], row["drawn"], row["kept_position"]) == ([], [], None, {"rack": "Rack-01", "slot": 3})


async def test_clear_server_refuses_a_stale_preview_bad_bodies_and_servers_on_no_port(lab):
    dry = await clear(lab, server="optn45", dry_run=True)
    assert dry.status_code == 200, dry.text
    # Another session names one more port after OPTN45 since the preview.
    r = await lab.client.patch("/api/devices/direct-label", json={"device_id": "pdu-a", "port": "6", "label": "OPTN45 (PSU3)"})
    assert r.status_code == 200, r.text
    labels, files = await saved_labels(lab.db), snapshot(lab.folder)
    r = await clear(lab, server="optn45", plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 409 and r.json()["detail"] == "Changed since the preview. Preview again."
    for body, status in (({"server": "optn45", "dry_run": "yes"}, 400), ({"server": "optn45", "plan_revision": 5}, 400),
                         ({}, 400), ({"server": "Outlet 5"}, 400), ({"server": "Empty"}, 400), ({"server": "x" * 201}, 400),
                         ({"server": "optn99"}, 404), ({"server": "other"}, 404)):
        r = await clear(lab, **body)
        assert r.status_code == status, (body, r.text)
    assert await saved_labels(lab.db) == labels and snapshot(lab.folder) == files


async def test_a_move_to_ports_names_a_known_rack_in_any_case_and_never_creates_one(lab):
    port = [{"device_id": "pdu-a", "port": "4"}]
    r = await move(lab, server="web-1", target_ports=port, target_rack=" rack-02 ", target_slot=4, dry_run=True)
    assert r.status_code == 200 and r.json()["positions"][0]["after"] == {"rack": "Rack-02", "slot": 4}, r.text
    # A rack only the layout files name (rack_overrides.json: Rack-09) and a rack of the equipment list count too.
    r = await move(lab, server="web-1", target_ports=port, target_rack="RACK-09", dry_run=True)
    assert r.status_code == 200 and r.json()["positions"][0]["after"] == {"rack": "Rack-09", "slot": None}, r.text
    (lab.folder / "rack_items.json").write_text(json.dumps({"Storage": []}))
    r = await move(lab, server="web-1", target_ports=port, target_rack="storage", dry_run=True)
    assert r.status_code == 200 and r.json()["positions"][0]["after"]["rack"] == "Storage", r.text
    # A rack the lab does not know is refused: a move never creates a rack that no page draws.
    files, labels = snapshot(lab.folder), await saved_labels(lab.db)
    for dry_run in (True, False):
        r = await move(lab, server="web-1", target_ports=port, target_rack="rack-05", target_slot=2, dry_run=dry_run)
        assert r.status_code == 409 and r.json()["detail"] == "There is no rack named rack-05. Choose one of the lab's racks."
    assert snapshot(lab.folder) == files and await saved_labels(lab.db) == labels
    # Applied: the server lands in Rack-02 as the lab spells it.
    r = await move(lab, server="web-1", target_ports=port, target_rack="rack-02", target_slot=4)
    assert r.status_code == 200, r.text
    assert read_layout(lab.folder)["rack_overrides.json"]["web-1"] == "Rack-02"
    body = (await lab.client.get("/api/devices/locations")).json()
    assert "rack-02" not in body["racks"]
    assert {s["key"]: (s["rack"], s["slot"]) for s in body["servers"]}["web-1"] == ("Rack-02", 4)
    # Two racks whose names differ only in case: an exact name is taken, any other spelling is refused.
    lab.db.add(Device(id="rack-y", name="Rack Y", kind="rack", ip="192.0.2.15", rack="RACK-02"))
    await lab.db.commit()
    r = await move(lab, server="web-1", target_ports=port, target_rack="rack-02", dry_run=True)
    assert r.status_code == 409 and r.json()["detail"] == (
        "Several racks are named rack-02 with different capitals (RACK-02, Rack-02). Choose one of them exactly.")
    r = await move(lab, server="web-1", target_ports=port, target_rack="RACK-02", dry_run=True)
    assert r.status_code == 200 and r.json()["positions"][0]["after"]["rack"] == "RACK-02", r.text


async def add_web_2(lab):
    """web-2 on PDU-A outlet 4: drawn in Rack-01 right after web-1, both numbered automatically (U1 and U2)."""
    r = await lab.client.patch("/api/devices/direct-label", json={"device_id": "pdu-a", "port": "4", "label": "web-2"})
    assert r.status_code == 200, r.text
    rows = await location_rows(lab)
    assert (rows["web-1"]["drawn"], rows["web-2"]["drawn"]) == (
        {"rack": "Rack-01", "u": 1, "auto": True}, {"rack": "Rack-01", "u": 2, "auto": True})


async def test_clearing_an_automatically_numbered_server_pins_the_servers_drawn_after_it(lab):
    await add_web_2(lab)
    files = snapshot(lab.folder)
    dry = await clear(lab, server="web-1", dry_run=True)
    assert dry.status_code == 200, dry.text
    # Freeing web-1's U1 would move web-2 to floor 1, whose outlet is not its own: web-2's U2 is pinned instead.
    assert dry.json()["pins"] == [{"rack": "Rack-01", "id": "web-2", "slot": 2}]
    assert snapshot(lab.folder) == files
    r = await clear(lab, server="web-1", plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 200, r.text
    assert r.json()["pins"] == dry.json()["pins"]
    layout = read_layout(lab.folder)
    assert layout == {**LAYOUT, "rack_slots.json": {**LAYOUT["rack_slots.json"],
                                                    "Rack-01": {**LAYOUT["rack_slots.json"]["Rack-01"], "web-2": 2}}}
    rows = await location_rows(lab)
    assert rows["web-2"]["drawn"] == {"rack": "Rack-01", "u": 2, "auto": False}
    assert (rows["web-1"]["pdu"], rows["web-1"]["drawn"], rows["web-1"]["kept_position"]) == (
        [], None, {"rack": "Rack-01", "slot": None})
    # A pinned server (optn44, U3) frees a U no automatic number takes: nothing is pinned and no layout file is written.
    files = snapshot(lab.folder)
    plain = await clear(lab, server="optn44", dry_run=True)
    assert plain.status_code == 200 and "pins" not in plain.json(), plain.text
    r = await clear(lab, server="optn44", plan_revision=plain.json()["plan_revision"])
    assert r.status_code == 200 and snapshot(lab.folder) == files, r.text


async def test_clear_pins_are_checked_again_never_overwrite_an_unreadable_file_and_go_back_on_a_failed_save(
        lab, monkeypatch):
    await add_web_2(lab)
    dry = await clear(lab, server="web-1", dry_run=True)
    # Another session pins web-2 at U5 since the preview: the plan (its pins) changed, nothing is written.
    moved = {**LAYOUT, "rack_slots.json": {**LAYOUT["rack_slots.json"],
                                           "Rack-01": {**LAYOUT["rack_slots.json"]["Rack-01"], "web-2": 5}}}
    write_layout(lab.folder, moved)
    labels = await saved_labels(lab.db)
    r = await clear(lab, server="web-1", plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 409 and r.json()["detail"] == "Changed since the preview. Preview again."
    assert await saved_labels(lab.db) == labels and read_layout(lab.folder) == moved
    # rack_slots.json cannot be read: the preview numbers every server automatically, and the Apply never overwrites
    # the file.
    write_layout(lab.folder)
    (lab.folder / "rack_slots.json").write_text("{not json")
    dry = await clear(lab, server="web-1", dry_run=True)
    assert dry.status_code == 200 and dry.json()["pins"], dry.text
    r = await clear(lab, server="web-1", plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 503 and r.json()["detail"] == "A rack layout file cannot be read, so nothing was changed."
    assert (lab.folder / "rack_slots.json").read_text() == "{not json" and await saved_labels(lab.db) == labels
    # The labels cannot be saved: the pins written just before are taken back.
    write_layout(lab.folder)
    dry = await clear(lab, server="web-1", dry_run=True)

    async def failed_commit(db):
        return RuntimeError("database is locked"), False
    monkeypatch.setattr(devices, "_finish_commit", failed_commit)
    r = await clear(lab, server="web-1", plan_revision=dry.json()["plan_revision"])
    assert r.status_code == 503 and r.json()["detail"] == devices._CLEAR_FAILED
    assert read_layout(lab.folder) == LAYOUT and await saved_labels(lab.db) == labels


async def test_main_storage_is_always_a_rack_a_move_to_ports_may_name(lab):
    # No device and no equipment list names Storage-Main yet; it is a rack all the same (routers/inventory.py).
    r = await move(lab, server="web-1", target_ports=[{"device_id": "pdu-a", "port": "4"}], target_rack="storage-main",
                   target_slot=2, dry_run=True)
    assert r.status_code == 200 and r.json()["positions"][0]["after"] == {"rack": "Storage-Main", "slot": 2}, r.text
