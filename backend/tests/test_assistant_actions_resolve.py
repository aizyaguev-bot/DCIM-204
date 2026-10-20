"""Action previews never switch hardware; every live PDU read uses the driver fake."""
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import delete, update

from app import inventory_store
from app.assistant.actions import resolve
from app.assistant.actions.contracts import ActionError, ProposalRequest
from app.assistant.actions.models import AssistantActionProposal
from app.models import Device, MonitorDeviceSnapshot, PduMaintenance, PingTarget, PingTargetName, PxeJob
from app.routers import kvms, pdus
from tests.test_pdu_maintenance import FakePdu, SECRET

NOW = 1_800_000_000.0


def device(device_id, kind="pdu", labels=None, **kwargs):
    values = dict(id=device_id, name=device_id.upper(), kind=kind, ip=f"{device_id}.example.invalid",
                  rack="R1", port_count=64, enabled=True, labels_json=json.dumps(labels or {}),
                  username_enc=SECRET, password_enc=SECRET)
    values.update(kwargs)
    return Device(**values)


def maintenance(device_id, outlets=(1,)):
    return PduMaintenance(device_id=device_id, started_at=NOW, started_by="operator",
                          outlets_off_json=json.dumps(list(outlets)), failed_json="[4]")


@pytest.fixture
async def lab(db_session, monkeypatch):
    devices = [device("pdu1", labels={"1": "OPT11 (feed A)", "2": "OPT12", "3": "OPT13", "4": "SW-CORE"}),
               device("pdu2", labels={"1": "OPT11 (feed B)", "2": "OPT14"}),
               device("pdu3", labels={"1": "OPT15"}, rack="R2"),
               device("kvm a/b", "kvm", {"1": "OPT11", "2": "OPT12"}),
               device("kvm2", "kvm", {"3": "OPT11"})]
    db_session.add_all(devices)
    await db_session.commit()
    fakes = {"pdu1": FakePdu({1: "on", 2: "on", 3: "off", 4: "on"}),
             "pdu2": FakePdu({1: "off", 2: "on"}), "pdu3": FakePdu({1: "on"})}
    by_address = {d.ip: fakes[d.id] for d in devices if d.kind == "pdu"}

    def driver(ip, username, password):
        return by_address[ip](ip, username, password)

    monkeypatch.setattr(pdus, "RaritanPduDriver", driver)
    monkeypatch.setattr(pdus, "get_creds", lambda dev: (SECRET, SECRET))
    forbidden_kvm = AsyncMock(side_effect=AssertionError("KVM hardware must not be contacted"))
    monkeypatch.setattr(kvms, "_fetch_status", forbidden_kvm)
    value = SimpleNamespace(db=db_session, devices={d.id: d for d in devices}, fakes=fakes,
                            settings=SimpleNamespace(power_protected_outlets="none", ping_monitor_timezone="UTC"),
                            forbidden_kvm=forbidden_kvm)
    yield value
    assert not any(fake.calls for fake in fakes.values()), "A resolver must never switch an outlet"
    forbidden_kvm.assert_not_called()


async def impact(lab, kind, **kwargs):
    return await resolve.build_impact(lab.db, ProposalRequest(kind, **kwargs), lab.settings, NOW)


async def source(lab, kind="rack_shutdown", status="succeeded", ids=("pdu1", "pdu2")):
    row = AssistantActionProposal(id="batch", created_at=NOW, expires_at=NOW + 300,
                                  owner_key="user", created_by="admin", kind=kind, status=status,
                                  request_json=json.dumps({"rack": "R1"} if kind == "rack_shutdown" else {}),
                                  batch_down_json=json.dumps([{"pdu_id": item, "started_at": NOW} for item in ids]))
    lab.db.add(row)
    await lab.db.commit()
    return row


@pytest.mark.parametrize("kind", ["server_off", "server_on", "server_cycle"])
async def test_every_server_kind_resolves_all_feeds_and_live_states(lab, kind):
    preview = await impact(lab, kind, server="  opt11 (PSU1)  ", then_console=kind == "server_cycle")
    expected = [("pdu1", 1, "on")] if kind == "server_cycle" else [("pdu1", 1, "on"), ("pdu2", 1, "off")]
    assert [(t.pdu_id, t.outlet, t.state) for t in preview.targets] == expected
    if kind == "server_cycle":
        assert any(e.pdu_id == "pdu2" and e.reason == "already_off" for e in preview.excluded)
        assert any("יישאר כבוי" in warning for warning in preview.warnings_he)
    assert preview.servers == ["OPT11"]
    assert preview.pdus == ["pdu1", "pdu2"]
    assert preview.pins["pdu1"]["labels_rev"] == inventory_store.revision(lab.devices["pdu1"].labels)
    assert preview.pins["pdu1"]["on"] == [1, 2, 4]
    assert preview.pins["pdu1"]["known"] == [1, 2, 3, 4]
    assert len(preview.consoles) == (2 if kind == "server_cycle" else 0)


@pytest.mark.parametrize("kind", ["outlet_off", "outlet_on", "outlet_cycle"])
@pytest.mark.parametrize("pdu", ["pdu1", "PDU1"])
async def test_every_outlet_kind_accepts_id_or_exact_name(lab, kind, pdu):
    if kind == "outlet_cycle":
        lab.fakes["pdu1"].states[3] = "on"
    preview = await impact(lab, kind, pdu=pdu, outlet=3, then_console=kind == "outlet_cycle")
    assert [(t.pdu_id, t.outlet, t.state) for t in preview.targets] == [("pdu1", 3, "on" if kind == "outlet_cycle" else "off")]
    if kind == "outlet_cycle":
        assert any("KVM" in warning for warning in preview.warnings_he)


async def test_console_lists_all_ports_and_encodes_id_without_pdu_reads(lab):
    preview = await impact(lab, "open_console", server="OPT11")
    assert [c.console_url for c in preview.consoles] == [
        "/api/kvms/kvm%20a%2Fb/autologin?port=1", "/api/kvms/kvm2/autologin?port=3"]
    assert preview.targets == preview.pdus == []
    assert all(fake.reads == 0 for fake in lab.fakes.values())
    assert await resolve.consoles_for(lab.db, "missing") == []


async def test_outlet_cycle_offers_mapped_console(lab):
    preview = await impact(lab, "outlet_cycle", pdu="pdu1", outlet=1, then_console=True)
    assert len(preview.consoles) == 2


@pytest.mark.parametrize("query,status,code", [("unknown-host", 404, "not_resolved"),
                                               ("OPT1", 409, "ambiguous"), ("OPT15x", 404, "not_resolved")])
async def test_server_resolution_never_selects_partial_or_unknown_names(lab, query, status, code):
    with pytest.raises(ActionError) as caught:
        await impact(lab, "server_off", server=query)
    assert (caught.value.status, caught.value.code) == (status, code)
    assert 1 <= len(caught.value.details) <= 5
    assert all(fake.reads == 0 for fake in lab.fakes.values())


async def test_exact_alias_resolution_and_conflicting_aliases(lab):
    lab.db.add_all([PingTarget(id="ping11", source_key="server:opt11", name="OPT11"),
                    PingTarget(id="ping12", source_key="server:opt12", name="OPT12"),
                    PingTargetName(target_id="ping11", override="build-server")])
    await lab.db.commit()
    assert len((await impact(lab, "server_off", server="build-server")).targets) == 2
    lab.db.add(PingTargetName(target_id="ping12", override="build-server"))
    await lab.db.commit()
    with pytest.raises(ActionError) as caught:
        await impact(lab, "server_off", server="build-server")
    assert caught.value.code == "ambiguous" and sorted(caught.value.details) == ["OPT11", "OPT12"]


@pytest.mark.parametrize("kind,kwargs", [("open_console", {"server": "OPT13"}),
                                       ("outlet_off", {"pdu": "missing", "outlet": 1})])
async def test_missing_console_or_pdu(lab, kind, kwargs):
    with pytest.raises(ActionError) as caught:
        await impact(lab, kind, **kwargs)
    assert caught.value.status == 404 and caught.value.code == "not_resolved"


@pytest.mark.parametrize("number", [True, False, 0, -1, "1", None, 99, 2])
async def test_outlet_range_uses_live_membership_and_rejects_bool(lab, number):
    lab.fakes["pdu1"].hidden = {2}
    with pytest.raises(ActionError) as caught:
        await impact(lab, "outlet_off", pdu="pdu1", outlet=number)
    assert caught.value.status == 400 and caught.value.code == "invalid"


@pytest.mark.parametrize("setting,expected", [("", None), ("  ", None), ("none", set()), (" NONE ", set()),
                                              ("pdu1:1,PDU2:2,pdu1:1", {("pdu1", 1), ("pdu2", 2)}),
                                              ("unlisted:9", None), ("bad", None), ("pdu1:0", None),
                                              ("pdu1:-1", None), ("pdu1:2,", None)])
async def test_protected_parsing(lab, setting, expected):
    lab.settings.power_protected_outlets = setting
    assert resolve.protected_outlets(lab.settings, lab.devices.values()) == expected


async def test_unknown_or_ambiguous_protection_is_refused_and_console_warns(lab):
    lab.devices["pdu2"].name = "PDU1"
    await lab.db.commit()
    lab.settings.power_protected_outlets = "PDU1:1,unknown-pdu:1"
    assert resolve.protected_outlets(lab.settings, lab.devices.values()) is None
    with pytest.raises(ActionError) as caught:
        await impact(lab, "lab_shutdown")
    assert caught.value.code == "protected_unset"
    preview = await impact(lab, "open_console", server="OPT11")
    assert preview.warnings_he
    lab.settings.power_protected_outlets = "none"
    with pytest.raises(ActionError) as caught:
        await impact(lab, "outlet_off", pdu="PDU1", outlet=2)
    assert caught.value.code == "ambiguous"


@pytest.mark.parametrize("kind,kwargs", [("pdu_shutdown", {"pdu": "pdu1"}),
                                       ("rack_shutdown", {"rack": "R1"}), ("lab_shutdown", {})])
async def test_maintenance_shutdown_kinds_only_target_on_unprotected_outlets(lab, kind, kwargs):
    lab.settings.power_protected_outlets = "pdu1:4"
    preview = await impact(lab, kind, **kwargs)
    assert ("pdu1", 4) not in {(t.pdu_id, t.outlet) for t in preview.targets}
    assert all(t.state == "on" for t in preview.targets)
    assert any(e.reason == "protected" and e.outlet == 4 for e in preview.excluded)
    assert any(e.reason == "already_off" and e.outlet == 3 for e in preview.excluded)
    assert ("pdu3" in preview.pdus) == (kind == "lab_shutdown")
    if kind == "lab_shutdown":
        assert "המעבדה כולה תכבה מלבד השקעים המוגנים" in preview.warnings_he


@pytest.mark.parametrize("kind,kwargs", [("pdu_shutdown", {"pdu": "pdu1"}),
                                       ("rack_shutdown", {"rack": "R1"}), ("lab_shutdown", {})])
async def test_shutdown_requires_explicit_protection_configuration(lab, kind, kwargs):
    lab.settings.power_protected_outlets = ""
    with pytest.raises(ActionError) as caught:
        await impact(lab, kind, **kwargs)
    assert caught.value.code == "protected_unset"
    assert all(fake.reads == 0 for fake in lab.fakes.values())


@pytest.mark.parametrize("kind,kwargs", [("server_cycle", {"server": "OPT11"}),
                                       ("outlet_off", {"pdu": "pdu1", "outlet": 1})])
async def test_direct_actions_cannot_switch_a_protected_feed(lab, kind, kwargs):
    lab.settings.power_protected_outlets = "pdu1:1"
    with pytest.raises(ActionError) as caught:
        await impact(lab, kind, **kwargs)
    assert caught.value.status == 409 and caught.value.code == "protected"


@pytest.mark.parametrize("reason", ["disabled", "maintenance", "unreachable"])
async def test_batch_excludes_whole_unavailable_pdus(lab, reason):
    if reason == "disabled":
        lab.devices["pdu1"].enabled = False
    elif reason == "maintenance":
        lab.db.add(maintenance("pdu1"))
    else:
        lab.fakes["pdu1"].unreachable = True
    await lab.db.commit()
    preview = await impact(lab, "lab_shutdown")
    assert "pdu1" not in preview.pdus and "pdu1" not in preview.pins
    assert any(e.pdu_id == "pdu1" and e.outlet is None and e.reason == reason for e in preview.excluded)


async def test_unknown_states_are_excluded_for_shutdown_and_warn_for_direct_actions(lab):
    lab.fakes["pdu1"].states[2] = "unknown"
    preview = await impact(lab, "pdu_shutdown", pdu="pdu1")
    assert any(e.reason == "unknown_state" and e.outlet == 2 for e in preview.excluded)
    assert preview.warnings_he
    direct = await impact(lab, "outlet_off", pdu="pdu1", outlet=2)
    assert direct.targets[0].state == "unknown" and direct.warnings_he


@pytest.mark.parametrize("kind,kwargs", [("rack_shutdown", {"rack": "absent"}), ("lab_shutdown", {})])
async def test_no_actionable_targets(lab, kind, kwargs):
    for fake in lab.fakes.values():
        fake.states = {number: "off" for number in fake.states}
    with pytest.raises(ActionError) as caught:
        await impact(lab, kind, **kwargs)
    assert caught.value.status == 409 and caught.value.code == "no_targets"


async def test_pdu_restore_uses_exact_maintenance_restore_list(lab):
    lab.db.add(maintenance("pdu1", (1, 3)))
    await lab.db.commit()
    preview = await impact(lab, "pdu_restore", pdu="pdu1")
    assert [t.outlet for t in preview.targets] == [1, 3]
    assert preview.pins["pdu1"]["maintenance"] is True
    assert preview.pins["pdu1"]["outlets_off"] == [1, 3]


async def test_pdu_restore_without_maintenance_is_refused(lab):
    with pytest.raises(ActionError) as caught:
        await impact(lab, "pdu_restore", pdu="pdu1")
    assert caught.value.status == 409 and caught.value.code == "invalid"


@pytest.mark.parametrize("kind,scope", [("rack_shutdown", "R1"), ("lab_shutdown", None)])
async def test_batch_restore_exact_pdus_and_scope(lab, kind, scope):
    await source(lab, kind)
    lab.db.add_all([maintenance("pdu1", (1, 3)), maintenance("pdu3", (1,))])
    await lab.db.commit()
    req = ProposalRequest("batch_restore", restore_of="batch")
    preview = await resolve.build_impact(lab.db, req, lab.settings, NOW)
    assert [(t.pdu_id, t.outlet) for t in preview.targets] == [("pdu1", 1), ("pdu1", 3)]
    assert preview.pdus == ["pdu1"] and req.rack == scope
    assert any(e.pdu_id == "pdu2" and e.reason == "not_in_batch" for e in preview.excluded)


@pytest.mark.parametrize("status", ["pending", "executing", "cancelled", "refused", "ready"])
async def test_restore_rejects_an_unexecuted_batch(lab, status):
    await source(lab, status=status)
    lab.db.add(maintenance("pdu1"))
    await lab.db.commit()
    with pytest.raises(ActionError) as caught:
        await impact(lab, "batch_restore", restore_of="batch")
    assert caught.value.code == "invalid"


async def test_restore_empty_or_manually_restored_batch_has_no_targets(lab):
    row = await source(lab)
    with pytest.raises(ActionError) as caught:
        await impact(lab, "batch_restore", restore_of="batch")
    assert caught.value.code == "no_targets"
    row.batch_down_json = "[]"
    await lab.db.commit()
    with pytest.raises(ActionError) as caught:
        await impact(lab, "batch_restore", restore_of="batch")
    assert caught.value.code == "no_targets"


async def test_kvm_and_pxe_warnings_use_active_keys_and_monotonic_ttl(lab):
    kvms._in_use["kvm a/b"] = {1: time.monotonic() + 60}
    lab.db.add(PxeJob(id="job", computer_key="opt11", computer_name="OPT11", kvm_device_id="kvm a/b",
                      kvm_port=1, reboot_method="manual", driver="simulated", state="failed",
                      state_entered_at=NOW, deadline_at=NOW, active_key="opt11", active_port_key="kvm a/b:1",
                      created_by="operator", created_at=NOW, updated_at=NOW))
    await lab.db.commit()
    for kind in ("server_off", "open_console", "lab_shutdown"):
        preview = await impact(lab, kind, **({"server": "OPT11"} if kind != "lab_shutdown" else {}))
        assert any("בשימוש" in warning for warning in preview.warnings_he)
        assert any("PXE" in warning for warning in preview.warnings_he)


async def test_expired_in_use_marker_does_not_warn(lab):
    kvms._in_use["kvm a/b"] = {1: time.monotonic() - 1}
    assert not (await impact(lab, "open_console", server="OPT11")).warnings_he


async def test_saved_labels_override_snapshot_and_stale_status_cache(lab):
    dev = lab.devices["pdu1"]
    lab.db.add(MonitorDeviceSnapshot(device_id=dev.id, kind="pdu", ip=dev.ip, checked_at=NOW,
                                    reachable=True, ports_json=json.dumps([{"number": 1, "label": "OPT99", "state": "off"}])))
    await lab.db.commit()
    pdus._cache[dev.id] = (time.monotonic(), object())
    assert len((await impact(lab, "server_off", server="OPT11")).targets) == 2


@pytest.mark.parametrize("change", ["labels", "ip", "enabled", "maintenance", "missing",
                                    "unreachable", "removed", "scope"])
async def test_drift_refuses_changed_live_or_inventory_state(lab, change):
    preview = await impact(lab, "rack_shutdown", rack="R1")
    before_reads = lab.fakes["pdu1"].reads
    if change == "labels":
        await lab.db.execute(update(Device).where(Device.id == "pdu1").values(labels_json='{"1":"OPT99"}')
                            .execution_options(synchronize_session=False))
    elif change == "ip":
        await lab.db.execute(update(Device).where(Device.id == "pdu1").values(ip="changed.example.invalid")
                            .execution_options(synchronize_session=False))
    elif change == "enabled":
        lab.devices["pdu1"].enabled = False
    elif change == "maintenance":
        lab.db.add(maintenance("pdu1"))
    elif change == "missing":
        lab.fakes["pdu1"].hidden = {1}
    elif change == "unknown":
        lab.fakes["pdu1"].states[1] = "unknown"
    elif change == "unreachable":
        lab.fakes["pdu1"].unreachable = True
    elif change == "removed":
        await lab.db.execute(delete(Device).where(Device.id == "pdu1"))
    elif change == "scope":
        lab.db.add(device("new-pdu"))
    await lab.db.commit()
    reasons = await resolve.check_drift(lab.db, "rack_shutdown", preview.to_dict(with_pins=True), lab.settings)
    assert reasons
    assert all("changed.example.invalid" not in reason and SECRET not in reason for reason in reasons)
    if change in ("ip", "labels", "enabled", "maintenance"):
        assert lab.fakes["pdu1"].reads == before_reads


async def test_unchanged_pins_pass_but_single_action_refuses_any_power_change(lab):
    preview = await impact(lab, "server_off", server="OPT11")
    assert await resolve.check_drift(lab.db, "server_off", preview.to_dict(with_pins=True), lab.settings) == []
    lab.fakes["pdu1"].states[1] = "off"
    assert await resolve.check_drift(lab.db, "server_off", preview.to_dict(with_pins=True), lab.settings)


async def test_restore_list_change_and_protection_change_are_drift(lab):
    row = maintenance("pdu1", (1, 3))
    lab.db.add(row)
    await lab.db.commit()
    preview = await impact(lab, "pdu_restore", pdu="pdu1")
    row.outlets_off_json = "[1]"
    await lab.db.commit()
    assert await resolve.check_drift(lab.db, "pdu_restore", preview.to_dict(with_pins=True), lab.settings)
    row.outlets_off_json = "[1,3]"
    await lab.db.commit()
    lab.settings.power_protected_outlets = "pdu1:1"
    assert await resolve.check_drift(lab.db, "pdu_restore", preview.to_dict(with_pins=True), lab.settings)


async def test_missing_private_pins_is_drift_but_console_needs_none(lab):
    assert await resolve.check_drift(lab.db, "server_off", {}, lab.settings)
    assert await resolve.check_drift(lab.db, "open_console", {}, lab.settings) == []


async def test_public_impact_and_errors_never_expose_private_fields(lab, caplog):
    preview = await impact(lab, "server_cycle", server="OPT11", then_console=True)
    public = json.dumps(preview.to_dict(), ensure_ascii=False)
    assert "pins" not in public and SECRET not in public
    assert all(dev.ip not in public for dev in lab.devices.values())
    assert "username_enc" not in public and "password_enc" not in public
    assert preview.to_dict(with_pins=True)["pins"]["pdu1"]["ip"] == lab.devices["pdu1"].ip
    lab.fakes["pdu1"].unreachable = True
    with pytest.raises(ActionError) as caught:
        await impact(lab, "outlet_off", pdu="pdu1", outlet=1)
    rendered = json.dumps(caught.value.to_dict()) + caplog.text
    assert SECRET not in rendered and all(dev.ip not in rendered for dev in lab.devices.values())


@pytest.mark.parametrize("kind,kwargs", [("server_cycle", {"server": "OPT11"}),
                                       ("outlet_cycle", {"pdu": "pdu1", "outlet": 1})])
async def test_cycle_refuses_when_every_feed_is_off(lab, kind, kwargs):
    lab.fakes["pdu1"].states[1] = "off"
    with pytest.raises(ActionError) as caught:
        await impact(lab, kind, **kwargs)
    assert caught.value.code == "no_targets"


@pytest.mark.parametrize("kind", ["server_off", "server_on", "server_cycle"])
async def test_disabled_or_missing_feed_never_yields_a_partial_server_proposal(lab, kind):
    lab.devices["pdu2"].enabled = False
    await lab.db.commit()
    with pytest.raises(ActionError) as caught:
        await impact(lab, kind, server="OPT11")
    assert caught.value.code == "invalid"
    lab.devices["pdu2"].enabled = True
    await lab.db.commit()
    lab.fakes["pdu2"].hidden = {1}
    with pytest.raises(ActionError) as caught:
        await impact(lab, kind, server="OPT11")
    assert caught.value.code == "invalid"


@pytest.mark.parametrize("kind,kwargs", [("server_off", {"server": "OPT11"}),
                                       ("server_on", {"server": "OPT11"}),
                                       ("server_cycle", {"server": "OPT11"}),
                                       ("outlet_off", {"pdu": "pdu1", "outlet": 1}),
                                       ("outlet_on", {"pdu": "pdu1", "outlet": 1}),
                                       ("outlet_cycle", {"pdu": "pdu1", "outlet": 1}),
                                       ("pdu_shutdown", {"pdu": "pdu1"})])
@pytest.mark.parametrize("new_state", ["off", "unknown"])
async def test_single_actions_refuse_both_lost_power_and_unknown_state(lab, kind, kwargs, new_state):
    preview = await impact(lab, kind, **kwargs)
    lab.fakes["pdu1"].states[1] = new_state
    assert await resolve.check_drift(lab.db, kind, preview.to_dict(with_pins=True), lab.settings)


@pytest.mark.parametrize("kind,kwargs", [("rack_shutdown", {"rack": "R1"}), ("lab_shutdown", {})])
async def test_batch_state_changes_are_left_for_intersection_execution(lab, kind, kwargs):
    preview = await impact(lab, kind, **kwargs)
    lab.fakes["pdu1"].states.update({1: "off", 2: "unknown", 3: "on"})
    assert await resolve.check_drift(lab.db, kind, preview.to_dict(with_pins=True), lab.settings) == []
    # A drift read must not widen the stored preview to the newly powered outlet.
    assert ("pdu1", 3) not in {(t.pdu_id, t.outlet) for t in preview.targets}


async def test_batch_generation_mismatch_is_never_adopted(lab):
    await source(lab)
    later = maintenance("pdu1", (1,))
    later.started_at = NOW + 1
    lab.db.add_all([later, maintenance("pdu2", (1,))])
    await lab.db.commit()
    preview = await impact(lab, "batch_restore", restore_of="batch")
    assert preview.pdus == ["pdu2"]
    assert any(e.pdu_id == "pdu1" and e.reason == "not_in_batch" for e in preview.excluded)
    second = await lab.db.get(PduMaintenance, "pdu2")
    second.started_at += 1
    await lab.db.commit()
    assert await resolve.check_drift(lab.db, "batch_restore", preview.to_dict(with_pins=True), lab.settings)


async def test_unversioned_legacy_batch_is_refused(lab):
    row = await source(lab)
    row.batch_down_json = '["pdu1"]'
    lab.db.add(maintenance("pdu1"))
    await lab.db.commit()
    with pytest.raises(ActionError) as caught:
        await impact(lab, "batch_restore", restore_of="batch")
    assert caught.value.code == "no_targets"


@pytest.mark.parametrize("hold", ["computer", "port"])
async def test_active_pxe_is_drift_even_when_the_job_state_is_failed(lab, hold):
    preview = await impact(lab, "server_off", server="OPT11")
    lab.db.add(PxeJob(id="held", computer_key="opt11", computer_name="OPT11", kvm_device_id="kvm a/b",
                      kvm_port=1, reboot_method="manual", driver="simulated", state="failed",
                      state_entered_at=NOW, deadline_at=NOW, created_by="operator", created_at=NOW, updated_at=NOW,
                      active_key="opt11" if hold == "computer" else None,
                      active_port_key="kvm a/b:1" if hold == "port" else None))
    await lab.db.commit()
    reasons = await resolve.check_drift(lab.db, "server_off", preview.to_dict(with_pins=True), lab.settings)
    assert any("PXE" in reason for reason in reasons)


async def test_unsafe_display_characters_are_stripped_but_private_labels_stay_exact(lab):
    lab.devices["pdu1"].name = "PDU\u202e1\n"
    lab.devices["pdu1"].rack = "R\u20661\x01"
    lab.devices["pdu1"].labels_json = json.dumps({"1": "OPT\u202e11\x00"})
    lab.devices["kvm a/b"].name = "KVM\u202e\n"
    await lab.db.commit()
    preview = await impact(lab, "outlet_off", pdu="pdu1", outlet=1)
    public = json.dumps(preview.to_dict(), ensure_ascii=False)
    assert all(token not in public for token in ("\u202e", "\u2066", "\\n", "\\u0000", "\\u0001"))
    assert preview.targets[0].label == "OPT11"
    assert preview.pins["pdu1"]["target_labels"]["1"] == "OPT\u202e11\x00"
    assert await resolve.check_drift(lab.db, "outlet_off", preview.to_dict(with_pins=True), lab.settings) == []


@pytest.mark.parametrize("replacement", ["OPT99", "Outlet 1", ""])
async def test_live_label_change_without_saved_label_revision_is_refused(lab, monkeypatch, replacement):
    dev = lab.devices["pdu1"]
    dev.labels_json = "{}"
    lab.db.add(MonitorDeviceSnapshot(device_id=dev.id, kind="pdu", ip=dev.ip, checked_at=NOW,
                                    reachable=True, ports_json=json.dumps([{"number": 1, "label": "OPT11"}])))
    await lab.db.commit()
    original = lab.fakes["pdu1"].get_outlets
    current_label = "OPT11"

    async def labelled_outlets():
        rows = await original()
        rows[0]["label"] = current_label
        return rows

    monkeypatch.setattr(lab.fakes["pdu1"], "get_outlets", labelled_outlets)
    preview = await impact(lab, "server_off", server="OPT11")
    current_label = replacement
    assert await resolve.check_drift(lab.db, "server_off", preview.to_dict(with_pins=True), lab.settings)
    with pytest.raises(ActionError) as caught:
        await impact(lab, "server_off", server="OPT11")
    assert caught.value.code == "ambiguous"


async def test_protected_outlet_missing_in_live_status_refuses_shutdown(lab):
    lab.settings.power_protected_outlets = "pdu1:50"
    with pytest.raises(ActionError) as caught:
        await impact(lab, "lab_shutdown")
    assert caught.value.code == "protected_unset"


async def test_new_feed_after_proposal_is_drift(lab):
    preview = await impact(lab, "server_off", server="OPT11")
    lab.devices["pdu3"].labels_json = '{"1":"OPT11 (third feed)"}'
    await lab.db.commit()
    assert await resolve.check_drift(lab.db, "server_off", preview.to_dict(with_pins=True), lab.settings)


async def test_nondecimal_digit_in_protection_fails_closed(lab):
    lab.settings.power_protected_outlets = "pdu1:²"
    assert resolve.protected_outlets(lab.settings, lab.devices.values()) is None
    with pytest.raises(ActionError) as caught:
        await impact(lab, "lab_shutdown")
    assert caught.value.code == "protected_unset"


@pytest.mark.parametrize("kind", ["pdu_restore", "batch_restore"])
async def test_empty_maintenance_restore_list_still_allows_leaving_maintenance(lab, kind):
    lab.db.add(maintenance("pdu1", ()))
    await lab.db.commit()
    if kind == "batch_restore":
        await source(lab, ids=("pdu1",))
    preview = await impact(lab, kind, **({"pdu": "pdu1"} if kind == "pdu_restore" else {"restore_of": "batch"}))
    assert preview.targets == [] and preview.pdus == ["pdu1"]
    assert preview.pins["pdu1"]["outlets_off"] == []
    assert await resolve.check_drift(lab.db, kind, preview.to_dict(with_pins=True), lab.settings) == []


async def test_generation_replaced_during_preview_is_not_adopted(lab, monkeypatch):
    await source(lab, ids=("pdu1",))
    lab.db.add(maintenance("pdu1"))
    await lab.db.commit()
    get = lab.db.get
    calls = 0

    async def replace_on_second_read(model, key, **kwargs):
        nonlocal calls
        row = await get(model, key, **kwargs)
        if model is PduMaintenance and key == "pdu1":
            calls += 1
            if calls == 2:
                row.started_at = NOW + 1
                await lab.db.commit()
        return row

    monkeypatch.setattr(lab.db, "get", replace_on_second_read)
    with pytest.raises(ActionError) as caught:
        await impact(lab, "batch_restore", restore_of="batch")
    assert caught.value.code == "no_targets"


