"""PATCH /api/devices/{id} (v2 spec D.6): Edit details and Correct rack, with a dry run, a plan_revision, blockers and
the typed device name for a rack change; plus the device-write guards of D.5 (POST kind, PUT kind lock, unique names,
the retired DELETE). Simulated database rows only; nothing contacts a device."""
import json
from types import SimpleNamespace

import pytest

import app.config as config
from app.models import Device, PduMaintenance
from app.routers import devices, kvms, pdus

PDU_LABELS = {str(n): f"OPT{n}" for n in (1, 2)} | {"17": "OPT117", "24": "OPT124", "5": "Outlet 5"}


@pytest.fixture
def settings(monkeypatch, tmp_path):
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)   # layout files and the removed list: empty
    state = SimpleNamespace(power_protected_outlets="")
    monkeypatch.setattr(config, "get_settings", lambda: state)
    return state


@pytest.fixture
async def lab(db_session, settings):
    db_session.add_all([
        Device(id="pdu1", name="PDU 01", kind="pdu", ip="192.0.2.1", rack="Rack-01", port_count=24, model="PX3",
               username_enc="u", password_enc="p", labels_json=json.dumps(PDU_LABELS)),
        Device(id="pdu2", name="PDU 02", kind="pdu", ip="192.0.2.2", rack="Rack-02", port_count=8, labels_json="{}"),
        Device(id="kvm1", name="KVM 01", kind="kvm", ip="192.0.2.20", rack="Rack-01", port_count=16,
               labels_json=json.dumps({"1": "OPT1", "3": "OPT90"})),
        Device(id="rack1", name="Rack-01", kind="rack", ip="0.0.0.0", rack="Rack-01"),
    ])
    await db_session.commit()
    return db_session


async def patch(client, device_id, body, status=200):
    preview = await client.patch(f"/api/devices/{device_id}?dry_run=true", json=body)
    assert preview.status_code == 200, preview.text
    plan = preview.json()
    r = await client.patch(f"/api/devices/{device_id}", json={**body, "plan_revision": plan["plan_revision"]})
    assert r.status_code == status, r.text
    return plan, r.json()


async def test_a_dry_run_lists_the_changes_and_an_apply_needs_its_revision(client, lab):
    body = {"name": "PDU 01 A", "ip": "192.0.2.11", "model": "PX4", "notes": "moved", "username": "", "password": "new"}
    preview = await client.patch("/api/devices/pdu1?dry_run=true", json=body)
    plan = preview.json()
    assert plan["dry_run"] is True and plan["blockers"] == [] and plan["servers_moving"] == []
    assert [(c["field"], c["after"]) for c in plan["changes"]] == [
        ("name", "PDU 01 A"), ("ip", "192.0.2.11"), ("model", "PX4"), ("notes", "moved"), ("password", "changed")]
    r = await client.patch("/api/devices/pdu1", json=body)
    assert r.status_code == 428
    r = await client.patch("/api/devices/pdu1", json={**body, "plan_revision": '"stale"'})
    assert r.status_code == 409
    pdus._cache["pdu1"] = (0, object())
    r = await client.patch("/api/devices/pdu1", json={**body, "plan_revision": plan["plan_revision"]})
    assert r.status_code == 200, r.text
    device = r.json()["device"]
    assert (device["name"], device["ip"], device["model"], device["notes"]) == ("PDU 01 A", "192.0.2.11", "PX4", "moved")
    assert "pdu1" not in pdus._cache   # a status read from the old address is never shown again
    row = await lab.get(Device, "pdu1", populate_existing=True)
    assert row.username_enc == "u" and row.password_enc not in ("", "p")   # blank user kept, password re-encrypted


async def test_fields_that_are_refused(client, lab):
    r = await client.patch("/api/devices/pdu1?dry_run=true", json={"kind": "kvm"})
    assert r.status_code == 422 and r.json()["detail"] == devices.KIND_LOCKED
    r = await client.patch("/api/devices/pdu1?dry_run=true", json={"rack": "Rack-02", "notes": "x"})
    assert r.status_code == 422 and r.json()["detail"] == devices.RACK_ALONE
    r = await client.patch("/api/devices/pdu1?dry_run=true", json={"name": "  "})
    assert r.status_code == 422
    r = await client.patch("/api/devices/pdu1?dry_run=true", json={"ip": "http://x"})
    assert r.status_code == 422
    r = await client.patch("/api/devices/pdu1?dry_run=true", json={"surprise": 1})
    assert r.status_code == 422
    r = await client.patch("/api/devices/nope?dry_run=true", json={"notes": "x"})
    assert r.status_code == 404


async def test_name_and_address_blockers(client, lab):
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"name": " pdu  02 "})).json()
    assert preview["blockers"] == ["pdu  02 is already the name of another PDU. Choose a different name."]
    r = await client.patch("/api/devices/pdu1", json={"name": " pdu  02 ", "plan_revision": preview["plan_revision"]})
    assert r.status_code == 409
    # The KVM may share the name of a PDU: names are unique per kind.
    await patch(client, "kvm1", {"name": "PDU 02"})
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"ip": "192.0.2.2"})).json()
    assert preview["blockers"] == ["PDU 02 (PDU) already uses this address. Each PDU or KVM needs its own address."]
    lab.add(PduMaintenance(device_id="pdu1", started_at=1, started_by="admin", outlets_off_json="[]"))
    await lab.commit()
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"ip": "192.0.2.9"})).json()
    assert preview["blockers"] == ["PDU is in maintenance mode; restore it first"]


async def test_a_legacy_duplicate_name_does_not_block_an_unrelated_edit(client, lab):
    lab.add(Device(id="pdu3", name="PDU 02", kind="pdu", ip="192.0.2.3", rack="Rack-03"))
    await lab.commit()
    plan, done = await patch(client, "pdu3", {"notes": "legacy duplicate", "enabled": False})
    assert plan["blockers"] == [] and done["device"]["enabled"] is False


async def test_protected_outlets_block_a_rename_by_name_and_a_shorter_outlet_count(client, lab, settings):
    settings.power_protected_outlets = "PDU 01:4"
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"name": "PDU 1"})).json()
    assert len(preview["blockers"]) == 1 and preview["blockers"][0].startswith("POWER_PROTECTED_OUTLETS names PDU 01 by its name")
    settings.power_protected_outlets = "pdu1:4"
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"name": "PDU 1"})).json()
    assert preview["blockers"] == []   # named by id: a rename keeps the list valid


async def test_an_outlet_count_below_named_or_protected_outlets_is_blocked(client, lab, settings):
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"port_count": 16})).json()
    assert preview["blockers"] == ["Outlets 17, 24 still carry names; clear them first."]
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"port_count": 20})).json()
    assert preview["blockers"] == ["Outlet 24 still carries a name; clear it first."]
    settings.power_protected_outlets = "pdu1:20"
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"port_count": 30})).json()
    assert preview["blockers"] == []
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"port_count": 19})).json()
    assert preview["blockers"][-1] == "POWER_PROTECTED_OUTLETS names outlet 20 of PDU 01; change that setting first."
    # 0 means "read from the PDU later": never blocked.
    assert (await client.patch("/api/devices/pdu1?dry_run=true", json={"port_count": 0})).json()["blockers"] == []
    settings.power_protected_outlets = ""
    plan, done = await patch(client, "pdu2", {"port_count": 24})
    assert done["device"]["port_count"] == 24


async def test_correct_rack_lists_the_servers_that_move_and_needs_the_typed_name(client, lab):
    preview = (await client.patch("/api/devices/pdu1?dry_run=true", json={"rack": "Rack-05"})).json()
    moving = {s["key"]: (s["from"], s["to"]) for s in preview["servers_moving"]}
    assert moving["opt1"] == ("Rack-01", "Rack-05") and moving["opt117"] == ("Rack-01", "Rack-05")
    assert "opt90" not in moving   # on the KVM only
    r = await client.patch("/api/devices/pdu1", json={"rack": "Rack-05", "plan_revision": preview["plan_revision"]})
    assert r.status_code == 422 and r.json()["detail"] == devices.CONFIRM_NAME
    r = await client.patch("/api/devices/pdu1", json={"rack": "Rack-05", "confirm_name": "PDU 01",
                                                      "plan_revision": preview["plan_revision"]})
    assert r.status_code == 200 and r.json()["device"]["rack"] == "Rack-05"
    # A KVM moves its KVM-only servers (their rack falls back to the KVM's).
    preview = (await client.patch("/api/devices/kvm1?dry_run=true", json={"rack": "Rack-07"})).json()
    assert {s["key"]: s["to"] for s in preview["servers_moving"]} == {"opt90": "Rack-07"}
    # A device with no named port and no moving server needs no typed name.
    plan, done = await patch(client, "pdu2", {"rack": "Rack-09"})
    assert plan["servers_moving"] == [] and done["device"]["rack"] == "Rack-09"


async def test_kvm_caches_are_dropped_when_its_credentials_change(client, lab):
    kvms._cache["kvm1"] = (0, object())
    await patch(client, "kvm1", {"username": "admin"})
    assert "kvm1" not in kvms._cache


# ── D.5 guards on the other device writes ───────────────────────────────────────────────────────────────────────────
async def test_create_needs_a_known_kind_and_a_free_name(client, lab):
    r = await client.post("/api/devices/", json={"name": "UPS", "kind": "ups", "ip": "192.0.2.50"})
    assert r.status_code == 422 and r.json()["detail"] == devices.KIND_INVALID
    r = await client.post("/api/devices/", json={"name": " pdu 01", "kind": "pdu", "ip": "192.0.2.51"})
    assert r.status_code == 409 and r.json()["detail"] == "pdu 01 is already the name of another PDU. Choose a different name."
    r = await client.post("/api/devices/", json={"name": "PDU 01", "kind": "kvm", "ip": "192.0.2.52"})
    assert r.status_code == 201


async def test_put_keeps_the_kind_and_checks_a_changed_name(client, lab):
    body = {"name": "PDU 01", "kind": "pdu", "ip": "192.0.2.1", "rack": "Rack-01", "port_count": 24}
    r = await client.put("/api/devices/pdu1", json={**body, "kind": "kvm"})
    assert r.status_code == 422 and r.json()["detail"] == devices.KIND_LOCKED
    r = await client.put("/api/devices/pdu1", json={**body, "name": "PDU 02"})
    assert r.status_code == 409
    r = await client.put("/api/devices/rack1", json={"name": "Rack-01", "kind": "rack", "ip": "0.0.0.0", "rack": "Rack-01X"})
    assert r.status_code == 200 and r.json()["rack"] == "Rack-01X"   # Edit rack's rename still works


async def test_the_retired_delete_answers_409_and_deletes_nothing(client, lab):
    r = await client.delete("/api/devices/pdu2")
    assert r.status_code == 409 and r.json()["detail"] == devices.DELETE_MOVED
    assert await lab.get(Device, "pdu2", populate_existing=True) is not None
