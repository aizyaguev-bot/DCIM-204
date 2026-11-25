"""Delete and restore for every lab item (v2 spec section D: POST /api/lab/delete, GET /api/lab/deleted,
POST /api/lab/restore, DELETE /api/lab/deleted/{batch_id}).

Through the real accounts middleware and the live sync counter: every kind's plan, options and blockers, evidence,
freeing a server's outlets and KVM port and restoring them (a port that changed since is listed, not overwritten),
alerts closed with one "[DCIM closed]" email (never a "[DCIM recovered]"), lab-data.json written with its Hebrew
readable, the cooling unit history version, the 90-day purge, Delete forever, stale and missing plan revisions, per-kind
roles, the change domains, the unit drop guard, and the lock order. Every PDU and KVM is a database row; nothing contacts
a device. All files live in tmp_path."""
import ast
import json
import pathlib
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.config as config
import app.main as main
from app import accounts, alerts, changes, inventory_store, lab_trash
from app.database import Base, get_db
from app.engineers import owner_map
from app.models import (AlertCondition, AlertEmail, AssetOwner, Device, MonitorDeviceSnapshot, PingIncident, PingTarget,
                        PduMaintenance, PxeJob, User)
from app.routers import devices, lab_delete, removed_servers
from tests.test_removed_servers import CheapHashlib

PASSWORD = "test-password-123"
HEBREW = "ארון כלים"
LABELS = {
    "pdu-a": {"1": "OPT11", "2": "OPT12 (PSU1)", "3": "web-1", "4": "OPT14"},
    "pdu-b": {"1": "OPT12 (PSU2)", "2": "OPT21"},
    "pdu-c": {"1": "OPT31", "2": "OPT32"},
    "kvm-a": {"1": "OPT11", "2": "OPT13"},
}
TWIN = {
    "meta": {"title": HEBREW},
    "zones": [{"id": "Z01", "name": "Zone"}],
    "structure": {"walls": [{"id": "WALL-L"}]},
    "storage": [{"id": "STORAGE-01", "name": "Grey cabinet", "notes": HEBREW}],
    "setups": [{"id": "SETUP-001", "name": "Rack L1", "dcimRack": "Rack-01"},
               {"id": "SETUP-003", "name": "Rack L3", "dcimRack": "Rack-03"},
               {"id": "SETUP-009", "name": "Bench rack"}],
    "shelves": [{"id": f"SHELF-3{n}", "setup": "SETUP-003", "level": n} for n in range(1, 5)],
    "items": [
        {"id": "ITEM-PC", "type": "pdu", "name": "PDU-C", "setup": "SETUP-003", "dcim": {"deviceId": "pdu-rack03"}},
        {"id": "ITEM-O11", "type": "opt", "name": "OPT11", "setup": "SETUP-001", "dcim": {"optKey": "opt11"}},
        {"id": "ITEM-T3", "type": "equip-switch", "name": "Tray 3", "setup": "SETUP-003", "shelf": "SHELF-34"},
        {"id": "ITEM-C3", "type": "chiller", "name": "Cooling 3", "setup": "SETUP-003"},
        {"id": "ITEM-CART", "type": "cart", "name": "Blue cart", "notes": HEBREW},
        {"id": "ITEM-IN", "type": "misc", "name": "Spare chassis", "storage": "STORAGE-01"},
        {"id": "ITEM-B9", "type": "misc", "name": "On the bench rack", "setup": "SETUP-009"},
    ],
    "dcim": {"pdus": [{"id": "pdu-rack03", "name": "PDU-C"}, {"id": "pdu-rack01", "name": "PDU-A"}],
             "optOwners": {"opt11": "Dana", "opt99": "Eli"}, "rackSlots": {"Rack-01": {"opt11": 1, "opt99": 2}}},
}
ITEMS = {
    "Rack-01": [{"id": "u1", "name": "Switch 01", "type": "switch", "u": 1, "barcode": "BC-1"},
                {"id": "u-pc", "name": "OPT300", "type": "computer", "u": 3}],
    "Rack-03": [{"id": "u3", "name": "Tray 3", "type": "other", "u": 1, "serial_number": "SN-3",
                 "tracking_history": [{"at": "2026-01-01T00:00:00+00:00", "action": "scanned", "from": None, "to": "x", "note": ""}],
                 "last_seen_at": "2026-01-01T00:00:00+00:00"}],
    "Storage-Main": [],
}
CHILLERS = {"units": [{"id": "ch1", "name": "Cooling 1", "rack": "Rack-01", "u": 3},
                      {"id": "ch3", "name": "Cooling 3", "rack": "Rack-03", "u": 3}],
            "connections": [{"from": "ch3", "to": "Rack-03"}]}
SLOTS = {"Rack-01": {"opt12 (psu1)": 2}, "Rack-03": {"opt31": 1}}


def settings_for(protected=""):
    return SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                           accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD,
                           power_protected_outlets=protected, email_alerts_to="alerts@example.test",
                           email_alerts_enabled=False)


@pytest.fixture
async def lab(tmp_path, monkeypatch):
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    monkeypatch.setattr(main, "_OPT_OWNERS_FILE", tmp_path / "opt_owners.json")
    monkeypatch.setattr(main, "_CHILLERS_FILE", tmp_path / "chillers.json")
    monkeypatch.setattr(main, "_TWIN_DATA_FILE", tmp_path / "twin" / "lab-data.json")
    (tmp_path / "twin").mkdir()
    (tmp_path / "twin" / "lab-data.json").write_text(json.dumps(TWIN, ensure_ascii=False, indent=2), encoding="utf-8")
    (tmp_path / "opt_owners.json").write_text(json.dumps({"opt11": "Dana", "opt13": "Roy"}))
    (tmp_path / "rack_items.json").write_text(json.dumps(ITEMS))
    (tmp_path / "chillers.json").write_text(json.dumps(CHILLERS))
    (tmp_path / "rack_slots.json").write_text(json.dumps(SLOTS))
    (tmp_path / "switch_assignments.json").write_text(json.dumps({"opt11": {"switch": "SW1", "port": "1"}}))
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'lab.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    state = SimpleNamespace(settings=settings_for())
    getter = lambda: state.settings   # noqa: E731
    for module in (accounts, removed_servers, alerts, config):
        monkeypatch.setattr(module, "get_settings", getter)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", factory)
    monkeypatch.setattr(accounts, "hashlib", CheapHashlib)
    await accounts.bootstrap_admin()
    now = time.time()
    async with factory() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role, created_at=now,
                        password_hash=accounts.hash_password(PASSWORD)))
        for dev_id, name, kind, rack, n in (("pdu-a", "PDU-A", "pdu", "Rack-01", 11), ("pdu-b", "PDU-B", "pdu", "Rack-02", 12),
                                            ("pdu-c", "PDU-C", "pdu", "Rack-03", 13), ("kvm-a", "KVM-A", "kvm", "Rack-01", 14)):
            db.add(Device(id=dev_id, name=name, kind=kind, ip=f"192.0.2.{n}", rack=rack, port_count=8, model="PX",
                          username_enc="enc-user", password_enc="enc-secret", labels_json=json.dumps(LABELS[dev_id])))
        db.add(Device(id="rack-3", name="Compute-Rack-03", kind="rack", ip="0.0.0.0", rack="Rack-03"))
        # PDU-A answers and draws (evidence); PDU-C never answered (no evidence) and has a notified alert.
        db.add(MonitorDeviceSnapshot(device_id="pdu-a", kind="pdu", ip="192.0.2.11", checked_at=now, reachable=True,
                                     ports_json=json.dumps([{"number": 1, "state": "on", "watts": 120.0},
                                                            {"number": 2, "state": "on", "watts": 3.0}])))
        db.add(MonitorDeviceSnapshot(device_id="pdu-c", kind="pdu", ip="192.0.2.13", checked_at=now - 600, reachable=False))
        db.add(AlertCondition(key="device-api:pdu-c", configuration="[]", started_at=now - 7200, checked_at=now - 60, notified=True))
        db.add(AlertEmail(id="mail-pdu-c", condition_key="device-api:pdu-c", created_at=now - 5000, recipient="a@example.test",
                          subject="[DCIM alert] PDU-C: PDU API availability", body="down", next_attempt_at=now - 5000,
                          sent_at=now - 4990))
        db.add(AlertCondition(key="power:pdu-c:1:watts:max", configuration="[]", checked_at=now, notified=False))
        for key, name, status, up in (("opt11", "OPT11", "up", now - 60), ("opt12", "OPT12", "down", None),
                                      ("opt21", "OPT21", "down", None), ("opt31", "OPT31", "down", None),
                                      ("opt32", "OPT32", "down", None), ("optn85", "optn85", "down", None),
                                      ("opt300", "OPT300", "down", None)):
            db.add(PingTarget(id="t-" + key, source_key="server:" + key, name=name, host=key, status=status,
                              checked_at=now, last_up_at=up))
        db.add(AlertCondition(key="network:t-opt12", configuration="[]", started_at=now - 900, checked_at=now, notified=True))
        db.add(AlertEmail(id="mail-opt12", condition_key="network:t-opt12", created_at=now - 800, recipient="a@example.test",
                          subject="[DCIM alert] OPT12: network reachability", body="down", next_attempt_at=now - 800))
        db.add(PingIncident(target_id="t-opt12", host="opt12", first_failed_at=now - 900, last_failed_at=now - 60))
        db.add(AssetOwner(asset_key="item:u3", legacy_name="Tray owner"))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.add_middleware(changes.ChangeFeed)
    app.include_router(accounts.router)
    app.include_router(removed_servers.router)
    app.include_router(devices.router)
    app.include_router(lab_delete.router)
    app.add_api_route("/api/rack-items", main.save_rack_items, methods=["PUT"])
    app.add_api_route("/api/rack-items", main.get_rack_items, methods=["GET"])

    async def dependency():
        async with factory() as db:
            yield db
    app.dependency_overrides[get_db] = dependency
    yield SimpleNamespace(app=app, factory=factory, folder=tmp_path, state=state)
    await engine.dispose()


@asynccontextmanager
async def signed_in(lab, username="admin"):
    async with AsyncClient(transport=ASGITransport(app=lab.app), base_url="http://test") as c:
        r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert r.status_code == 200, r.text
        c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        yield c


async def preview(c, targets, options=None, status=200):
    r = await c.post("/api/lab/delete", json={"targets": targets, "options": options or {}, "dry_run": True})
    assert r.status_code == status, r.text
    return r.json()


async def delete(c, targets, options=None, reason=None, status=200):
    plan = await preview(c, targets, options)
    r = await c.post("/api/lab/delete", json={"targets": targets, "options": options or {}, "reason": reason,
                                              "plan_revision": plan["plan_revision"]})
    assert r.status_code == status, r.text
    return r.json()


async def restore(c, batch, entries=None, status=200):
    g = await c.get("/api/lab/deleted")
    assert g.status_code == 200, g.text
    body = {"batch": batch, **({"entries": entries} if entries is not None else {})}
    plan = await c.post("/api/lab/restore", json={**body, "dry_run": True})
    assert plan.status_code == 200, plan.text
    r = await c.post("/api/lab/restore", headers={"If-Match": g.headers["etag"]},
                     json={**body, "plan_revision": plan.json()["plan_revision"]})
    assert r.status_code == status, r.text
    return plan.json(), r.json()


def texts(plan, group):
    return [row["text"] for row in plan["consequences"][group]]


def files(lab):
    return {p.name: p.read_bytes() for p in sorted(lab.folder.rglob("*.json"))}


async def labels(lab):
    async with lab.factory() as db:
        return {d.id: json.loads(d.labels_json or "{}") for d in (await db.execute(select(Device))).scalars()}


async def target(lab, key):
    async with lab.factory() as db:
        return await db.scalar(select(PingTarget).where(PingTarget.source_key == "server:" + key))


def twin(lab):
    return json.loads((lab.folder / "twin" / "lab-data.json").read_text(encoding="utf-8"))


# ── preview ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async def test_a_preview_writes_nothing_counts_nothing_and_lists_every_group(lab):
    before, counter = files(lab), changes.current()["rev"]
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "device", "id": "pdu-c"}])
    assert files(lab) == before and changes.current()["rev"] == counter
    assert plan["dry_run"] is True and plan["blockers"] == []
    assert plan["items"] == [{"kind": "device", "id": "pdu-c", "name": "PDU-C", "evidence": [],
                              "info": [plan["items"][0]["info"][0]]}]
    assert plan["items"][0]["info"][0].startswith("Unreachable since ")
    assert set(plan["consequences"]) == set(lab_trash.CONSEQUENCES)
    # OPT31 and OPT32 are only on PDU-C and never answered: deleted with it. Its 3D record and dcim seed go too.
    assert {r["key"] for r in plan["consequences"]["servers_deleted"]} == {"opt31", "opt32"}
    assert texts(plan, "twin_deleted") == ["PDU-C (ITEM-PC): 3D record of PDU-C"]
    assert [r["title"] for r in plan["consequences"]["alerts_closed"]] == ["PDU-C: PDU API availability"]
    assert plan["screens"] == ["Racks", "Manage", "Dashboard / Power", "Lab display (TV)", "3D twin", "Ping Monitor"]
    assert set(plan) >= {"plan_revision", "targets", "items", "consequences", "blockers", "screens", "options"}


async def test_evidence_server_device_unit(lab):
    async with signed_in(lab) as c:
        server = await preview(c, [{"kind": "server", "id": "OPT11"}])
        device = await preview(c, [{"kind": "device", "id": "pdu-a"}])
        unit = await preview(c, [{"kind": "unit", "id": "u3"}])
    assert server["items"][0]["evidence"] == ["Answered ping in the last 24 hours", "PDU-A · outlet 1 is on, drawing 120 W"]
    assert device["items"][0]["evidence"] == ["Answers now", "Feeds 1 server drawing 0.1 kW"]
    assert unit["items"][0]["evidence"] == []   # last seen long ago
    # A device with evidence keeps its servers that still answer, and says where they end up.
    kept = {r["key"]: r for r in device["consequences"]["servers_kept"]}
    assert kept["opt11"]["why"].startswith("still on KVM-A")
    assert kept["opt12"]["why"].startswith("still on PDU-B")
    # OPT14 and web-1 (a server name too) are only on PDU-A and show no sign of life: deleted with it.
    assert {r["key"] for r in device["consequences"]["servers_deleted"]} == {"opt14", "web-1"}


async def test_a_server_that_still_answers_is_kept_when_its_only_device_goes(lab):
    async with lab.factory() as db:
        t = await db.get(PingTarget, "t-opt31")
        t.status, t.last_up_at = "up", time.time()
        await db.commit()
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "device", "id": "pdu-c"}])
    kept = {r["key"]: r for r in plan["consequences"]["servers_kept"]}
    assert kept["opt31"]["why"] == "still answers"
    assert kept["opt31"]["goes"] == "stays on Rack-03"   # its rack_slots entry keeps it on Rack-03
    assert {r["key"] for r in plan["consequences"]["servers_deleted"]} == {"opt32"}
    async with signed_in(lab) as c:
        off = await preview(c, [{"kind": "device", "id": "pdu-c"}], {"orphan_servers": False})
    assert off["consequences"]["servers_deleted"] == []
    assert {r["key"] for r in off["consequences"]["servers_kept"]} == {"opt31", "opt32"}


# ── server: free and restore (B6) ────────────────────────────────────────────────────────────────────────────────────
async def test_deleting_a_server_frees_its_ports_hides_it_and_restore_puts_them_back(lab):
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "server", "id": "OPT12 (PSU1)"}])
        assert plan["items"][0]["id"] == "opt12" and plan["items"][0]["name"] == "OPT12"
        assert texts(plan, "ports_freed") == ["PDU-A · outlet 2: OPT12 (PSU1) → Outlet 2", "PDU-B · outlet 1: OPT12 (PSU2) → Outlet 1"]
        assert [r["key"] for r in plan["consequences"]["monitors_paused"]] == ["opt12"]
        assert [r["title"] for r in plan["consequences"]["alerts_closed"]] == ["OPT12: network reachability"]
        done = await delete(c, [{"kind": "server", "id": "OPT12 (PSU1)"}], reason="Gone")
        batch = done["batch"]["id"]
        assert done["batch"]["entries"] == [{"kind": "server", "id": "opt12", "name": "OPT12"}]
        now = await labels(lab)
        assert now["pdu-a"]["2"] == "Outlet 2" and now["pdu-b"]["1"] == "Outlet 1"
        assert (await target(lab, "opt12")).enabled is False
        listed = (await c.get("/api/removed-servers")).json()
        assert "opt12" in listed["hidden"]
        slots = json.loads((lab.folder / "rack_slots.json").read_text())
        assert "opt12 (psu1)" not in slots.get("Rack-01", {})
        # Somebody puts another server on PDU-B outlet 1 meanwhile: that port is listed, not overwritten.
        r = await c.patch("/api/devices/direct-label", json={"device_id": "pdu-b", "port": "1", "label": "OPT99"})
        assert r.status_code == 200, r.text
        plan, done = await restore(c, batch)
    assert texts(plan, "ports_restored") == ["PDU-A · outlet 2 → OPT12 (PSU1)"]
    assert texts(plan, "ports_not_restored") == ["PDU-B · outlet 1 now says OPT99 — not restored"]
    assert texts(plan, "servers_restored") == ["OPT12"]
    assert texts(plan, "monitors_resumed") == ["OPT12: ping monitor resumes"]
    now = await labels(lab)
    assert now["pdu-a"]["2"] == "OPT12 (PSU1)" and now["pdu-b"]["1"] == "OPT99"
    async with signed_in(lab) as c:
        assert "opt12" not in (await c.get("/api/removed-servers")).json()["hidden"]
        listed = (await c.get("/api/lab/deleted")).json()["batches"][0]
    assert listed["entries"][0]["restored_at"] and listed["entries"][0]["restorable"] is False


async def test_the_owners_note_names_the_owner_of_every_feed(lab):
    (lab.folder / "opt_owners.json").write_text(json.dumps({"OPT12 (PSU1)": "Ann", "OPT12 (PSU2)": "Ben", "opt11": "Dana"}))
    async with signed_in(lab) as c:
        assert texts(await preview(c, [{"kind": "server", "id": "opt12"}]), "owners") == ["OPT12: owners Ann and Ben removed"]
        assert texts(await preview(c, [{"kind": "server", "id": "opt11"}]), "owners") == ["OPT11: owner Dana removed"]


async def test_keep_labels_floor_units_and_twin_records_options(lab):
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "server", "id": "opt11"}], {"keep_labels": True, "floor_units": True})
        assert plan["consequences"]["ports_freed"] == []
        assert texts(plan, "twin_deleted") == ["OPT11 (ITEM-O11): 3D record of OPT11"]
        off = await preview(c, [{"kind": "server", "id": "opt11"}], {"twin_records": False})
        assert off["consequences"]["twin_deleted"] == []
        done = await delete(c, [{"kind": "server", "id": "opt11"}], {"keep_labels": True})
    assert (await labels(lab))["pdu-a"]["1"] == "OPT11"   # the name stays on the outlet; the server is hidden
    doc = twin(lab)
    assert "ITEM-O11" not in {i["id"] for i in doc["items"]}
    assert "opt11" not in doc["dcim"]["optOwners"] and "opt11" not in doc["dcim"]["rackSlots"]["Rack-01"]
    async with signed_in(lab) as c:
        await restore(c, done["batch"]["id"])
    doc = twin(lab)
    assert doc["items"] == TWIN["items"] and doc["dcim"] == TWIN["dcim"]


async def test_server_blockers(lab):
    async with lab.factory() as db:
        db.add(PxeJob(id="job1", computer_key="opt13", computer_name="OPT13", kvm_device_id="kvm-a", kvm_port=2,
                      pdu_targets_json=json.dumps([{"device_id": "pdu-b", "outlet": 2}]), reboot_method="pdu_cycle",
                      driver="simulated", state="install_started", state_entered_at=1, deadline_at=1, active_key="opt13",
                      active_port_key="kvm-a:2", created_by="admin", created_at=1, updated_at=1))
        await db.commit()
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "server", "id": "OPT13"}, {"kind": "server", "id": "Outlet 3"},
                                 {"kind": "server", "id": "OPT404"}])
        codes = {(b["id"], b["code"]): b["text"] for b in plan["blockers"]}
        assert codes[("opt13", "pxe")] == "Remote install is running on OPT13; finish or cancel it first."
        assert ("Outlet 3", "not-server") in codes and ("opt404", "missing") in codes
        kvm = await preview(c, [{"kind": "device", "id": "kvm-a"}])
        # the held console port, and OPT13 (only on KVM-A, so deleted with it) whose install is running
        assert sorted((b["kind"], b["code"]) for b in kvm["blockers"]) == [("device", "pxe"), ("server", "pxe")]
        pdu = await preview(c, [{"kind": "device", "id": "pdu-b"}])
        assert [b["code"] for b in pdu["blockers"]] == ["pxe"]
        r = await c.post("/api/lab/delete", json={"targets": [{"kind": "server", "id": "OPT13"}],
                                                  "plan_revision": plan["plan_revision"]})
        assert r.status_code == 409
        await delete(c, [{"kind": "server", "id": "OPT21"}])
        again = await preview(c, [{"kind": "server", "id": "OPT21"}])
        assert [(b["code"], b["text"]) for b in again["blockers"]] == [
            ("removed", "OPT21 is already deleted: no outlet, KVM port or 3D record names it any more.")]


# ── a server removed before the Deleted list existed (Remove from lab) ───────────────────────────────────────────────
async def old_remove(c, name):
    """Today's Remove from lab (POST /api/removed-servers): the server is hidden, its names stay on its ports."""
    plan = await c.post("/api/removed-servers", json={"name": name, "dry_run": True})
    assert plan.status_code == 200, plan.text
    etag = (await c.get("/api/removed-servers")).headers["etag"]
    r = await c.post("/api/removed-servers", headers={"If-Match": etag},
                     json={"name": name, "plan_revision": plan.json()["plan_revision"]})
    assert r.status_code == 200, r.text


async def test_a_server_removed_earlier_is_deleted_its_names_and_3d_record_go_and_it_stays_removed(lab):
    """The real-site case (optn144): removed with Remove from lab, its name still on a PDU outlet and a KVM port and its
    3D record still there. Delete frees both ports, deletes the 3D record, keeps the removal and the paused monitor;
    Restore of the batch writes the names and the 3D record back and it stays removed."""
    async with signed_in(lab) as c:
        await old_remove(c, "OPT11")
        removed_before = json.loads((lab.folder / "removed_servers.json").read_text())["servers"]["opt11"]
        now = await labels(lab)
        assert now["pdu-a"]["1"] == "OPT11" and now["kvm-a"]["1"] == "OPT11"
        plan = await preview(c, [{"kind": "server", "id": "opt11"}])
        assert plan["blockers"] == []
        assert texts(plan, "ports_freed") == ["KVM-A · port 1: OPT11 → Port 1", "PDU-A · outlet 1: OPT11 → Outlet 1"]
        assert texts(plan, "twin_deleted") == ["OPT11 (ITEM-O11): 3D record of OPT11"]
        assert plan["consequences"]["monitors_paused"] == []   # the removal paused it already
        assert texts(plan, "notes") == ["OPT11 was removed from the lab before; it stays removed and its monitor stays paused"]
        # With 3D records kept, the names on its ports are still something to delete; with both kept, nothing is.
        kept = await preview(c, [{"kind": "server", "id": "opt11"}], {"twin_records": False, "keep_labels": True})
        assert [b["text"] for b in kept["blockers"]] == [
            "Nothing to delete: OPT11 is already removed, and its name stays on its ports (the option to keep its name is "
            "on) and its 3D record stays (the option to delete 3D records is off)."]
        before_log = len(json.loads((lab.folder / "removed_servers.json").read_text())["log"])
        done = await delete(c, [{"kind": "server", "id": "opt11"}])
        assert done["batch"]["entries"] == [{"kind": "server", "id": "opt11", "name": "OPT11"}]
        now = await labels(lab)
        assert now["pdu-a"]["1"] == "Outlet 1" and now["kvm-a"]["1"] == "Port 1"
        assert "ITEM-O11" not in {i["id"] for i in twin(lab)["items"]} and "opt11" not in twin(lab)["dcim"]["optOwners"]
        store = json.loads((lab.folder / "removed_servers.json").read_text())
        assert store["servers"]["opt11"] == removed_before and len(store["log"]) == before_log   # the removal is kept
        assert "opt11" in (await c.get("/api/removed-servers")).json()["hidden"]
        assert (await target(lab, "opt11")).enabled is False
        listed = (await c.get("/api/lab/deleted")).json()["batches"][0]
        assert listed["entries"][0]["restorable"] is True
        # Deleting it again finds nothing left to delete.
        again = await preview(c, [{"kind": "server", "id": "opt11"}])
        assert [b["code"] for b in again["blockers"]] == ["removed"]
        plan, done = await restore(c, done["batch"]["id"])
        assert texts(plan, "ports_restored") == ["KVM-A · port 1 → OPT11", "PDU-A · outlet 1 → OPT11"]
        assert texts(plan, "servers_restored") == []
        assert texts(plan, "notes") == ["OPT11 stays removed from the lab, as it was before this delete; Restore… in its "
                                        "window shows it again"]
        now = await labels(lab)
        assert now["pdu-a"]["1"] == "OPT11" and now["kvm-a"]["1"] == "OPT11"
        assert twin(lab)["items"] == TWIN["items"] and twin(lab)["dcim"] == TWIN["dcim"]
        assert "opt11" in (await c.get("/api/removed-servers")).json()["hidden"]
        assert (await target(lab, "opt11")).enabled is False
        # The old Restore still brings it back, with its names (they are on its recorded ports again).
        etag = (await c.get("/api/removed-servers")).headers["etag"]
        r = await c.post("/api/removed-servers/restore", headers={"If-Match": etag}, json={"key": "opt11"})
        assert r.status_code == 200, r.text
        assert "opt11" not in (await c.get("/api/removed-servers")).json()["hidden"]


async def test_a_removed_server_whose_monitor_runs_again_is_paused_and_its_open_alert_closed(lab):
    async with signed_in(lab) as c:
        await old_remove(c, "OPT12 (PSU1)")
    async with lab.factory() as db:
        t = await db.get(PingTarget, "t-opt12")
        t.enabled = True   # someone switched it on again in Ping Monitor
        state = await db.get(AlertCondition, "network:t-opt12")
        if state is None:   # the removal closed the fixture's alert: a new one opened since
            db.add(AlertCondition(key="network:t-opt12", configuration="[]", started_at=time.time() - 900,
                                  checked_at=time.time(), notified=True))
        db.add(AlertEmail(id="mail-opt12-again", condition_key="network:t-opt12", created_at=time.time(),
                          recipient="a@example.test", subject="[DCIM alert] OPT12: network reachability", body="down",
                          next_attempt_at=time.time()))
        await db.commit()
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "server", "id": "opt12"}], {"keep_labels": True})
        assert plan["blockers"] == [] and plan["consequences"]["ports_freed"] == []
        assert texts(plan, "monitors_paused") == ["OPT12: ping monitor paused (history kept)"]
        assert [r["title"] for r in plan["consequences"]["alerts_closed"]] == ["OPT12: network reachability"]
        done = await delete(c, [{"kind": "server", "id": "opt12"}], {"keep_labels": True})
        assert (await labels(lab))["pdu-a"]["2"] == "OPT12 (PSU1)"   # kept on purpose
        assert (await target(lab, "opt12")).enabled is False
        async with lab.factory() as db:
            assert await db.get(AlertCondition, "network:t-opt12") is None
            subjects = [m.subject for m in (await db.execute(select(AlertEmail).where(
                AlertEmail.condition_key == "network:t-opt12").order_by(AlertEmail.created_at))).scalars()]
        assert subjects[-1] == "[DCIM closed] OPT12: network reachability"
        # With its names kept and nothing else left, a second delete has nothing to do.
        again = await preview(c, [{"kind": "server", "id": "opt12"}], {"keep_labels": True})
        assert [(b["code"], b["text"]) for b in again["blockers"]] == [
            ("removed", "Nothing to delete: OPT12 is already removed, and its name stays on its ports (the option to keep "
                        "its name is on).")]
        # Without the option, the names it holds are what goes.
        freed = await preview(c, [{"kind": "server", "id": "opt12"}])
        assert freed["blockers"] == [] and len(freed["consequences"]["ports_freed"]) == 2
        plan, _ = await restore(c, done["batch"]["id"])
        assert texts(plan, "monitors_resumed") == ["OPT12: ping monitor resumes"]
    assert (await target(lab, "opt12")).enabled is True   # as it was before the delete
    async with signed_in(lab) as c:
        assert "opt12" in (await c.get("/api/removed-servers")).json()["hidden"]


async def test_monitoring_marks_the_monitors_of_removed_servers(lab):
    from sqlalchemy import delete as sql_delete
    from app.routers import monitoring
    lab.app.include_router(monitoring.router)
    async with lab.factory() as db:   # this lab's snapshots carry outlet states only; Ping Monitor's join reads labels
        await db.execute(sql_delete(MonitorDeviceSnapshot))
        await db.commit()
    async with signed_in(lab) as c:
        await old_remove(c, "OPT11")
        await delete(c, [{"kind": "server", "id": "OPT21"}])
        r = await c.get("/api/monitoring")
    assert r.status_code == 200, r.text
    removed = {t["server_key"]: t["removed"] for t in r.json()["targets"]}
    assert removed["opt11"] is True and removed["opt21"] is True
    assert removed["opt12"] is False and removed["optn85"] is False


# ── devices ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async def test_device_blockers_maintenance_protected_and_rack_row(lab):
    lab.state.settings = settings_for("PDU-A:4")
    async with lab.factory() as db:
        db.add(PduMaintenance(device_id="pdu-b", started_at=1, started_by="admin", outlets_off_json="[1]"))
        await db.commit()
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "device", "id": "pdu-a"}, {"kind": "device", "id": "pdu-b"},
                                 {"kind": "device", "id": "rack-3"}])
    blockers = {(b["id"], b["code"]): b["text"] for b in plan["blockers"]}
    assert blockers[("pdu-a", "protected")] == ("Remove PDU-A from POWER_PROTECTED_OUTLETS in the server settings first; "
                                                "deleting it would make the list invalid and block every Off and Cycle.")
    assert blockers[("pdu-b", "maintenance")] == "PDU-B is in maintenance mode; restore it first."
    assert blockers[("rack-3", "rack-row")] == "Compute-Rack-03 is a rack: delete the rack Rack-03 instead (its rack window)."


async def test_deleting_a_pdu_removes_its_rows_closes_alerts_and_restore_brings_it_back(lab):
    async with signed_in(lab) as c:
        done = await delete(c, [{"kind": "device", "id": "pdu-c"}])
        assert (await c.get("/api/devices/")).json() and "pdu-c" not in {d["id"] for d in (await c.get("/api/devices/")).json()}
    async with lab.factory() as db:
        assert await db.get(MonitorDeviceSnapshot, "pdu-c") is None
        assert (await db.execute(select(AlertCondition).where(AlertCondition.key.like("%pdu-c%")))).scalars().all() == []
        mails = (await db.execute(select(AlertEmail).where(AlertEmail.condition_key == "device-api:pdu-c")
                                  .order_by(AlertEmail.created_at))).scalars().all()
    # One closing email, never a recovery: the lab display reads this subject as "closed".
    assert [m.subject for m in mails] == ["[DCIM alert] PDU-C: PDU API availability", "[DCIM closed] PDU-C: PDU API availability"]
    assert mails[1].body.startswith("Deleted from the lab by admin; no longer checked.") and "No recovery" in mails[1].body
    assert mails[1].recipient == "alerts@example.test"
    for key in ("opt31", "opt32"):
        assert (await target(lab, key)).enabled is False
    doc = twin(lab)
    assert "ITEM-PC" not in {i["id"] for i in doc["items"]} and doc["dcim"]["pdus"] == [{"id": "pdu-rack01", "name": "PDU-A"}]
    stored = json.loads((lab.folder / "deleted.json").read_text())
    snap = stored["batches"][0]["entries"][0]["snapshot"]["devices"][0]
    assert snap["password_enc"] == "enc-secret"   # kept encrypted as stored
    async with signed_in(lab) as c:
        listing = (await c.get("/api/lab/deleted")).json()
        assert "snapshot" not in json.dumps(listing) and "enc-secret" not in json.dumps(listing)
        plan, _ = await restore(c, done["batch"]["id"])
        assert texts(plan, "devices_restored") == ["PDU-C (PDU)"]
        assert set(texts(plan, "servers_restored")) == {"OPT31", "OPT32"}
    async with lab.factory() as db:
        dev = await db.get(Device, "pdu-c")
        assert (dev.name, dev.ip, dev.rack, dev.port_count, dev.password_enc) == ("PDU-C", "192.0.2.13", "Rack-03", 8, "enc-secret")
        assert json.loads(dev.labels_json) == LABELS["pdu-c"]
        # The alert stays closed: nothing is restored for it.
        assert await db.get(AlertCondition, "device-api:pdu-c") is None
    assert "ITEM-PC" in {i["id"] for i in twin(lab)["items"]}


async def test_restore_is_refused_when_the_id_name_or_address_is_taken_again(lab):
    async with signed_in(lab) as c:
        done = await delete(c, [{"kind": "device", "id": "pdu-c"}])
        r = await c.post("/api/devices/", json={"name": "pdu-c ", "kind": "pdu", "ip": "192.0.2.99", "rack": "Rack-03"})
        assert r.status_code == 201, r.text
        plan = (await c.post("/api/lab/restore", json={"batch": done["batch"]["id"], "dry_run": True})).json()
        assert [b["code"] for b in plan["blockers"]] == ["name-taken"]
        listed = (await c.get("/api/lab/deleted")).json()["batches"][0]["entries"][0]
        assert listed["restorable"] is True   # the cheap listing check looks at ids; the preview names the conflict


# ── rack ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async def test_deleting_a_rack_moves_units_to_storage_unassigns_cooling_drops_its_frame_and_restores(lab):
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "rack", "id": "Rack-03"}, {"kind": "unit", "id": "u3"}])
        assert [t["id"] for t in plan["targets"]] == ["Rack-03"]   # the unit on the rack merges into it
        assert texts(plan, "notes") == ["u3 goes with rack Rack-03"]
        assert texts(plan, "devices_deleted") == ["PDU-C (PDU on Rack-03)"]
        assert texts(plan, "units_moved") == ["Tray 3: Rack-03 · floor 1 → Storage-Main"]
        assert texts(plan, "cooling_unassigned") == ["Cooling 3 is taken off Rack-03"]
        assert "SETUP-003" in {r["key"] for r in plan["consequences"]["twin_deleted"]}
        storage = await preview(c, [{"kind": "rack", "id": "Storage-Main"}])
        assert [b["code"] for b in storage["blockers"]] == ["storage"]
        done = await delete(c, [{"kind": "rack", "id": "Rack-03"}])
    items = json.loads((lab.folder / "rack_items.json").read_text())
    assert "Rack-03" not in items and [u["id"] for u in items["Storage-Main"]] == ["u3"]
    assert items["Storage-Main"][0]["tracking_history"][-1]["note"] == "Moved to Storage-Main: rack Rack-03 deleted"
    chillers = json.loads((lab.folder / "chillers.json").read_text())
    assert {u["id"]: u["rack"] for u in chillers["units"]} == {"ch1": "Rack-01", "ch3": ""}
    history = json.loads((lab.folder / "chillers_history.json").read_text())
    assert history["versions"][-1]["action"] == "deleted" and history["versions"][-1]["by"] == "admin"
    doc = twin(lab)
    assert "SETUP-003" not in {s["id"] for s in doc["setups"]} and not any(s["setup"] == "SETUP-003" for s in doc["shelves"])
    assert "Rack-03" not in json.loads((lab.folder / "rack_slots.json").read_text())
    async with signed_in(lab) as c:
        await restore(c, done["batch"]["id"])
    items = json.loads((lab.folder / "rack_items.json").read_text())
    assert [u["id"] for u in items["Rack-03"]] == ["u3"] and items["Rack-03"][0]["u"] == 1 and items["Storage-Main"] == []
    assert {u["id"]: u["rack"] for u in json.loads((lab.folder / "chillers.json").read_text())["units"]} == \
        {"ch1": "Rack-01", "ch3": "Rack-03"}
    assert json.loads((lab.folder / "chillers_history.json").read_text())["versions"][-1]["action"] == "restored"
    assert twin(lab)["setups"] == TWIN["setups"] and twin(lab)["shelves"] == TWIN["shelves"]
    assert json.loads((lab.folder / "rack_slots.json").read_text())["Rack-03"] == {"opt31": 1}


async def test_rack_options_delete_units_and_keep_the_frame(lab):
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "rack", "id": "Rack-03"}], {"rack_units": "delete", "twin_frame": False})
    assert texts(plan, "units_deleted") == ["Tray 3 (on Rack-03)"]
    assert texts(plan, "setups_unmapped") == ["3D frame Rack L3 is no longer mapped to Rack-03"]


# ── units, cooling, 3D-only ──────────────────────────────────────────────────────────────────────────────────────────
async def test_an_operator_deletes_and_restores_a_unit_with_its_history_and_owner(lab):
    async with signed_in(lab, "operator") as c:
        plan = await preview(c, [{"kind": "unit", "id": "u-pc"}])
        assert texts(plan, "notes") == ["OPT300 stays in Ping Monitor; an Admin can delete it"]
        done = await delete(c, [{"kind": "unit", "id": "u3"}])
        assert texts(done, "twin_deleted") == ["Tray 3 (ITEM-T3): 3D record of Tray 3"]
        assert texts(done, "owners") == ["Tray 3: owner Tray owner removed"]
        items = json.loads((lab.folder / "rack_items.json").read_text())
        assert "Rack-03" not in items   # its last unit: the empty rack key is dropped
        async with lab.factory() as db:
            assert (await owner_map(db)).get("item:u3") in (None, "")
        await restore(c, done["batch"]["id"])
    unit = json.loads((lab.folder / "rack_items.json").read_text())["Rack-03"][0]
    assert unit["tracking_history"] == ITEMS["Rack-03"][0]["tracking_history"] and unit["last_seen_at"]
    async with lab.factory() as db:
        assert (await owner_map(db))["item:u3"] == "Tray owner"


async def test_an_admin_deleting_a_pinged_computer_unit_also_removes_its_server(lab):
    async with signed_in(lab) as c:
        plan = await preview(c, [{"kind": "unit", "id": "u-pc"}])
        assert texts(plan, "servers_deleted") == ["OPT300 (it is only pinged; unit OPT300)"]
        off = await preview(c, [{"kind": "unit", "id": "u-pc"}], {"unit_server": False})
        assert off["consequences"]["servers_deleted"] == []
        done = await delete(c, [{"kind": "unit", "id": "u-pc"}])
        assert "opt300" in (await c.get("/api/removed-servers")).json()["hidden"]
    # The unit is an Operator kind, but its entry also brings back the server an Admin deleted with it: Admin only.
    async with signed_in(lab, "operator") as c:
        entry = (await c.get("/api/lab/deleted")).json()["batches"][0]["entries"][0]
        assert (entry["kind"], entry["restorable"]) == ("unit", False)
        assert entry["why_not"] == "Only an Admin can restore it: it also brings back server OPT300."
        r = await c.post("/api/lab/restore", json={"batch": done["batch"]["id"], "dry_run": True})
        assert r.status_code == 403 and r.json()["detail"] == entry["why_not"]
        assert "opt300" in (await c.get("/api/removed-servers")).json()["hidden"]
    async with signed_in(lab) as c:
        assert (await c.get("/api/lab/deleted")).json()["batches"][0]["entries"][0]["restorable"] is True
        plan, _ = await restore(c, done["batch"]["id"])
        assert texts(plan, "servers_restored") == ["OPT300"]
        assert "opt300" not in (await c.get("/api/removed-servers")).json()["hidden"]


async def test_a_unit_restore_is_refused_when_its_serial_is_used_again(lab):
    async with signed_in(lab, "operator") as c:
        done = await delete(c, [{"kind": "unit", "id": "u3"}])
        g = await c.get("/api/rack-items")
        data = g.json()
        data["Rack-01"].append({"id": "u-new", "name": "New tray", "type": "other", "u": 2, "serial_number": "SN-3"})
        r = await c.put("/api/rack-items", json=data, headers={"If-Match": g.headers["etag"]})
        assert r.status_code == 200, r.text
        plan = (await c.post("/api/lab/restore", json={"batch": done["batch"]["id"], "dry_run": True})).json()
    assert [b["code"] for b in plan["blockers"]] == ["unit-taken"]


async def test_a_cooling_unit_is_deleted_as_a_versioned_write_and_restored(lab):
    async with signed_in(lab) as c:
        done = await delete(c, [{"kind": "cooling", "id": "ch3"}])
        doc = json.loads((lab.folder / "chillers.json").read_text())
        assert [u["id"] for u in doc["units"]] == ["ch1"] and doc["connections"] == []
        assert "ITEM-C3" not in {i["id"] for i in twin(lab)["items"]}
        version = json.loads((lab.folder / "chillers_history.json").read_text())["versions"][-1]
        assert version["action"] == "deleted" and version["removed"][0]["id"] == "ch3"
        await restore(c, done["batch"]["id"])
    assert json.loads((lab.folder / "chillers.json").read_text()) == CHILLERS


async def test_3d_only_records_and_their_blockers(lab):
    async with signed_in(lab, "operator") as c:
        linked = await preview(c, [{"kind": "twin", "id": "ITEM-O11"}, {"kind": "twin", "id": "SETUP-001"},
                                   {"kind": "twin", "id": "ITEM-GONE"}])
        texts_ = {b["id"]: b["text"] for b in linked["blockers"]}
        assert texts_["ITEM-O11"] == "Delete OPT11 itself; its 3D record goes with it."
        assert texts_["SETUP-001"] == "Delete Rack-01 itself (rack window); its 3D frame can go with it."
        assert texts_["ITEM-GONE"] == "ITEM-GONE is not in the 3D data any more."
        for fixed in ("Z01", "WALL-L", "SHELF-31"):
            r = await c.post("/api/lab/delete", json={"targets": [{"kind": "twin", "id": fixed}], "dry_run": True})
            assert r.status_code == 400 and r.json()["detail"].startswith("Not deletable")
        unplace = await preview(c, [{"kind": "twin", "id": "STORAGE-01"}], {"twin_contents": False})
        assert texts(unplace, "twin_unplaced") == ["Spare chassis becomes unplaced in 3D"]
        done = await delete(c, [{"kind": "twin", "id": "STORAGE-01"}, {"kind": "twin", "id": "ITEM-CART"},
                                {"kind": "twin", "id": "SETUP-009"}])
        assert {r["key"] for r in done["consequences"]["twin_deleted"]} == {"STORAGE-01", "ITEM-IN", "ITEM-CART", "SETUP-009", "ITEM-B9"}
        raw = (lab.folder / "twin" / "lab-data.json").read_text(encoding="utf-8")
        assert HEBREW in raw and "\\u05" not in raw   # Hebrew stays readable (ensure_ascii=False)
        await restore(c, done["batch"]["id"])
    assert twin(lab) == TWIN


async def test_the_patched_twin_data_file_is_the_one_written(lab, tmp_path):
    real = pathlib.Path(main.TWIN_DIR) / "lab-data.json"
    before = real.read_bytes() if real.exists() else None
    async with signed_in(lab, "operator") as c:
        await delete(c, [{"kind": "twin", "id": "ITEM-CART"}])
    assert (real.read_bytes() if real.exists() else None) == before
    assert "ITEM-CART" not in {i["id"] for i in twin(lab)["items"]}


# ── roles, revisions, the list ───────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("kind,ident", [("server", "opt11"), ("device", "pdu-c"), ("rack", "Rack-03"), ("cooling", "ch3")])
async def test_operators_cannot_delete_admin_kinds(lab, kind, ident):
    async with signed_in(lab, "operator") as c:
        r = await c.post("/api/lab/delete", json={"targets": [{"kind": kind, "id": ident}], "dry_run": True})
    assert r.status_code == 403 and r.json()["detail"] == lab_trash.ADMIN_ONLY


async def test_viewers_get_403_and_operators_restore_only_their_kinds(lab):
    async with signed_in(lab, "viewer") as c:
        for method, path in (("post", "/api/lab/delete"), ("get", "/api/lab/deleted"), ("post", "/api/lab/restore")):
            r = await getattr(c, method)(path, **({"json": {}} if method == "post" else {}))
            assert r.status_code == 403, path
    async with signed_in(lab) as c:
        done = await delete(c, [{"kind": "device", "id": "pdu-c"}])
    async with signed_in(lab, "operator") as c:
        r = await c.post("/api/lab/restore", json={"batch": done["batch"]["id"], "dry_run": True})
        assert r.status_code == 403 and r.json()["detail"] == lab_trash.ADMIN_ONLY_RESTORE
        r = await c.delete(f"/api/lab/deleted/{done['batch']['id']}")
        assert r.status_code == 403
        listed = (await c.get("/api/lab/deleted")).json()["batches"][0]
        assert "by" not in listed and "reason" not in listed
    async with signed_in(lab) as c:
        listed = (await c.get("/api/lab/deleted")).json()["batches"][0]
        assert listed["by"] == "admin"


async def test_stale_and_missing_plan_revisions(lab):
    async with signed_in(lab) as c:
        target_ = [{"kind": "device", "id": "pdu-c"}]
        r = await c.post("/api/lab/delete", json={"targets": target_})
        assert r.status_code == 428
        plan = await preview(c, target_)
        r = await c.patch("/api/devices/direct-label", json={"device_id": "pdu-c", "port": "3", "label": "OPT33"})
        assert r.status_code == 200
        r = await c.post("/api/lab/delete", json={"targets": target_, "plan_revision": plan["plan_revision"]})
        assert r.status_code == 409 and r.json()["detail"] == lab_trash.PLAN_CHANGED
        done = await delete(c, target_)
        r = await c.post("/api/lab/restore", json={"batch": done["batch"]["id"]})
        assert r.status_code == 428
        plan = (await c.post("/api/lab/restore", json={"batch": done["batch"]["id"], "dry_run": True})).json()
        r = await c.post("/api/lab/restore", headers={"If-Match": '"stale"'},
                         json={"batch": done["batch"]["id"], "plan_revision": plan["plan_revision"]})
        assert r.status_code == 409 and r.json()["detail"] == lab_trash.STALE
        r = await c.post("/api/lab/restore", headers={"If-Match": (await c.get("/api/lab/deleted")).headers["etag"]},
                         json={"batch": done["batch"]["id"]})
        assert r.status_code == 428


async def test_the_90_day_purge_and_delete_forever(lab):
    old = {"id": "old", "at": time.time() - 91 * 86400, "by": "admin", "reason": "", "entries": []}
    recent = {"id": "recent", "at": time.time() - 89 * 86400, "by": "admin", "reason": "", "entries": []}
    (lab.folder / "deleted.json").write_text(json.dumps({"batches": [old, recent]}))
    async with signed_in(lab, "operator") as c:
        assert [b["id"] for b in (await c.get("/api/lab/deleted")).json()["batches"]] == ["recent"]
        await delete(c, [{"kind": "twin", "id": "ITEM-CART"}])
    stored = [b["id"] for b in json.loads((lab.folder / "deleted.json").read_text())["batches"]]
    assert "old" not in stored and "recent" in stored   # purged on the write
    async with signed_in(lab) as c:
        r = await c.delete("/api/lab/deleted/recent")
        assert r.status_code == 200, r.text
        assert (await c.delete("/api/lab/deleted/recent")).status_code == 404
        r = await c.post("/api/lab/restore", json={"batch": "recent", "dry_run": True})
        assert r.status_code == 404


async def test_change_domains_of_delete_restore_and_none_for_a_dry_run(lab):
    async with signed_in(lab, "operator") as c:
        before = changes.current()
        await preview(c, [{"kind": "twin", "id": "ITEM-CART"}])
        assert changes.current()["rev"] == before["rev"]
        done = await delete(c, [{"kind": "twin", "id": "ITEM-CART"}])
        after = changes.current()
        bumped = {d for d, rev in after["domains"].items() if rev > before["domains"][d]}
        assert bumped == {"devices", "layout", "inventory", "owners", "removed", "monitoring", "twin", "power"}
        await restore(c, done["batch"]["id"])
        assert changes.current()["rev"] > after["rev"]


async def test_a_failed_commit_puts_every_file_back(lab, monkeypatch):
    before = files(lab)
    original = lab_trash.commit_or_put_back

    async def failing(db, written):
        async def broken():
            raise RuntimeError("disk full")
        monkeypatch.setattr(db, "commit", broken)
        return await original(db, written)
    monkeypatch.setattr(lab_trash, "commit_or_put_back", failing)
    async with signed_in(lab) as c:
        r = await c.post("/api/lab/delete", json={"targets": [{"kind": "rack", "id": "Rack-03"}], "dry_run": True})
        r = await c.post("/api/lab/delete", json={"targets": [{"kind": "rack", "id": "Rack-03"}],
                                                  "plan_revision": r.json()["plan_revision"]})
    assert r.status_code == 503
    assert files(lab) == before
    assert set(await labels(lab)) == {"pdu-a", "pdu-b", "pdu-c", "kvm-a", "rack-3"}


# ── the unit drop guard (v2 spec D.5) ────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("guard", [False, True])
async def test_the_unit_drop_guard(lab, monkeypatch, guard):
    monkeypatch.setattr(inventory_store, "UNIT_DROP_GUARD", guard)
    async with signed_in(lab, "operator") as c:
        g = await c.get("/api/rack-items")
        data = g.json()
        data["Rack-01"] = [u for u in data["Rack-01"] if u["id"] != "u1"]
        r = await c.put("/api/rack-items", json=data, headers={"If-Match": g.headers["etag"]})
        if guard:
            assert r.status_code == 422 and r.json()["detail"] == inventory_store.UNITS_DROPPED
        else:
            assert r.status_code == 200, r.text
        # The delete path may drop the units it deletes, with the guard on or off.
        await delete(c, [{"kind": "unit", "id": "u-pc"}])
    assert "u-pc" not in {u["id"] for u in json.loads((lab.folder / "rack_items.json").read_text()).get("Rack-01", [])}


def test_the_guard_refuses_a_dropped_unit_in_every_whole_list_save(monkeypatch):
    monkeypatch.setattr(inventory_store, "UNIT_DROP_GUARD", True)
    current = {"R": [{"id": "a", "u": 1}, {"id": "b", "u": 2}]}
    with pytest.raises(Exception) as caught:
        inventory_store.checked_items(current, {"R": [{"id": "a", "u": 1}]})
    assert getattr(caught.value, "status_code", None) == 422
    assert inventory_store.checked_items(current, {"R": [{"id": "a", "u": 1}]}, allow_drop={"b"}) == {"R": [{"id": "a", "u": 1}]}
    monkeypatch.setattr(inventory_store, "UNIT_DROP_GUARD", False)
    assert inventory_store.checked_items(current, {"R": [{"id": "a", "u": 1}]}) == {"R": [{"id": "a", "u": 1}]}


# ── the lock order ───────────────────────────────────────────────────────────────────────────────────────────────────
def test_no_code_takes_the_labels_lock_inside_a_maintenance_lock():
    """Lock order: devices._labels_lock, then maintenance_lock(id), then devices._address_lock. A source check: no
    `async with` that takes a maintenance lock (or a PDU locked through it) has a labels lock inside it."""
    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    maintenance = ("maintenance_lock", "locked_pdu", "_locked_device", "_locked")
    labels = ("_labels_lock", "_one_label_writer")
    found = []
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncWith):
                continue
            outer = " ".join(ast.unparse(item.context_expr) for item in node.items)
            if not any(name in outer for name in maintenance):
                continue
            inner = " ".join(ast.unparse(n) for n in node.body)
            if any(name in inner for name in labels):
                found.append(f"{path.name}:{node.lineno}")
    assert found == []
