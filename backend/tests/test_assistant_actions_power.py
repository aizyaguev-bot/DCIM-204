"""Confirmed power actions use fake hardware and the real shared PDU lock/read-back."""
import asyncio
import json
from contextlib import AsyncExitStack, asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import crypto, inventory_store, pdu_locks
from app.assistant.actions import power
from app.assistant.actions.contracts import Target
from app.models import Device, PduMaintenance, PduMaintenanceLog
from app.routers import pdus as pdus_module
from app.routers import pdu_maintenance as maintenance_module
from drivers.raritan_pdu import RaritanPduDriver
from tests.test_pdu_maintenance import FakePdu, SECRET


BY = "operator"


def target(pdu="pdu1", outlet=1):
    return Target(pdu, pdu.upper(), "R1", outlet, "OPT11", "OPT11", "on")


class TrackedPdu(FakePdu):
    def __init__(self, device_id, calls):
        super().__init__({1: "on", 2: "off", 3: "on", 4: "on"})
        self.device_id = device_id
        self.fleet_calls = calls
        self.closed = 0

    async def set_outlet_state(self, number, action):
        self.fleet_calls.append((self.device_id, number, action))
        return await super().set_outlet_state(number, action)

    async def close(self):
        self.closed += 1


@pytest.fixture(autouse=True)
def isolate_locks_and_forbid_hardware(monkeypatch):
    pdu_locks._locks.clear()

    async def forbidden(*args, **kwargs):
        raise AssertionError("Real hardware is forbidden")

    monkeypatch.setattr(RaritanPduDriver, "_rpc", forbidden)
    monkeypatch.setattr(RaritanPduDriver, "_client_ctx", forbidden)
    yield
    pdu_locks._locks.clear()


@pytest.fixture
def settings(monkeypatch):
    value = SimpleNamespace()
    monkeypatch.setattr(power, "get_settings", lambda: value)
    return value


@pytest.fixture
async def sessions(db_session, monkeypatch, settings):
    crypto_settings = SimpleNamespace(lab_manager_master_key=Fernet.generate_key().decode())
    monkeypatch.setattr(crypto, "get_settings", lambda: crypto_settings)
    for device_id, kind in (("pdu1", "pdu"), ("pdu2", "pdu"), ("kvm1", "kvm")):
        db_session.add(Device(id=device_id, name=device_id.upper(), kind=kind,
                              ip=device_id + ".example.invalid", rack="R1", port_count=4,
                              username_enc=crypto.encrypt("synthetic-user"),
                              password_enc=crypto.encrypt(SECRET)))
    await db_session.commit()
    return async_sessionmaker(db_session.bind, expire_on_commit=False)


@pytest.fixture
def fleet(monkeypatch):
    calls = []
    drivers = {device_id: TrackedPdu(device_id, calls) for device_id in ("pdu1", "pdu2")}
    credentials = []

    def factory(ip, username, password):
        assert ip in {"pdu1.example.invalid", "pdu2.example.invalid"}
        credentials.append((username, password))
        return drivers[ip.split(".")[0]](ip, username, password)

    monkeypatch.setattr(pdus_module, "RaritanPduDriver", factory)
    return SimpleNamespace(drivers=drivers, calls=calls, credentials=credentials)


async def maintenance(sessions, device_id):
    async with sessions() as db:
        db.add(PduMaintenance(device_id=device_id, started_at=1, started_by=BY, reason="Testing"))
        await db.commit()


async def approved_pins(sessions):
    async with sessions() as db:
        devices = (await db.scalars(select(Device).where(Device.kind == "pdu"))).all()
        return {dev.id: {"ip": dev.ip, "enabled": dev.enabled,
                         "labels_rev": inventory_store.revision(dev.labels)} for dev in devices}


def no_secrets(results):
    encoded = json.dumps([r.to_dict() for r in results])
    assert SECRET not in encoded
    assert "synthetic-user" not in encoded
    assert ".example.invalid" not in encoded


@pytest.mark.parametrize("action", ["on", "off"])
async def test_switch_groups_by_pdu_verifies_and_reports_without_db_writes(sessions, fleet, action):
    targets = [target(), target("pdu2"), target(outlet=2)]
    reported = []

    async def on_result(result):
        reported.append(result)

    for pdu_id in fleet.drivers:
        pdus_module._cache[pdu_id] = (0, object())
    results = await power.switch(sessions, targets, action, BY, on_result)
    assert fleet.calls == [("pdu1", 1, action), ("pdu1", 2, action), ("pdu2", 1, action)]
    assert reported == results
    assert all(r.ok and r.state_after == action and r.error == "" for r in results)
    assert pdus_module._cache == {}
    assert all(d.created == d.closed == 2 and d.reads == 1 for d in fleet.drivers.values())
    assert fleet.credentials == [("synthetic-user", SECRET)] * 4
    async with sessions() as db:
        assert await db.scalar(select(func.count()).select_from(PduMaintenance)) == 0
        assert await db.scalar(select(func.count()).select_from(PduMaintenanceLog)) == 0
    no_secrets(results)


@pytest.mark.parametrize("action", ["on", "off"])
async def test_lost_response_is_success_only_after_live_verification(sessions, fleet, action):
    driver = fleet.drivers["pdu1"]
    driver.lost.add(1)
    results = await power.switch(sessions, [target()], action, BY)
    assert results[0].ok and results[0].state_after == action and not results[0].error
    assert driver.reads == 1 and driver.closed == 2
    no_secrets(results)


@pytest.mark.parametrize("action,initial", [("on", "off"), ("off", "on")])
async def test_accepted_command_with_mismatched_readback_fails(sessions, fleet, action, initial):
    driver = fleet.drivers["pdu1"]
    driver.states[1] = initial
    driver.ignore.add(1)
    result = (await power.switch(sessions, [target()], action, BY))[0]
    assert not result.ok and result.state_after == initial and result.error


@pytest.mark.parametrize("state", ["unknown", "cycling", SECRET])
async def test_unconfirmed_states_never_count_as_success(sessions, fleet, state):
    driver = fleet.drivers["pdu1"]
    driver.states[1] = state
    driver.ignore.add(1)
    results = await power.switch(sessions, [target()], "off", BY)
    assert not results[0].ok
    assert results[0].state_after == (state if state == "cycling" else "unknown")
    no_secrets(results)


async def test_missing_outlet_in_live_readback_fails(sessions, fleet):
    fleet.drivers["pdu1"].hidden.add(1)
    result = (await power.switch(sessions, [target()], "off", BY))[0]
    assert not result.ok and result.state_after == "unknown"


async def test_unreachable_readback_fails_even_when_switch_acted(sessions, fleet):
    driver = fleet.drivers["pdu1"]
    driver.side_effects[1] = lambda: setattr(driver, "unreachable", True)
    results = await power.switch(sessions, [target()], "off", BY)
    assert driver.states[1] == "off"
    assert not results[0].ok and results[0].state_after == "unknown"
    no_secrets(results)


async def test_false_command_response_can_still_be_verified_success(sessions, fleet, monkeypatch):
    driver = fleet.drivers["pdu1"]

    async def switch(number, action):
        driver.states[number] = action
        return False

    monkeypatch.setattr(driver, "set_outlet_state", switch)
    assert (await power.switch(sessions, [target()], "off", BY))[0].ok


@pytest.mark.parametrize("action,allowed", [("on", False), ("off", True)])
async def test_maintenance_blocks_on_but_allows_off(sessions, fleet, action, allowed):
    await maintenance(sessions, "pdu1")
    results = await power.switch(sessions, [target()], action, BY)
    assert results[0].ok is allowed
    assert bool(fleet.calls) is allowed
    if not allowed:
        assert results[0].error == "PDU is in maintenance mode"
        assert fleet.drivers["pdu1"].created == 0


@pytest.mark.parametrize("pdu_id", ["pdu1", "kvm1", "missing"])
async def test_disabled_wrong_kind_and_missing_devices_are_refused(sessions, fleet, pdu_id):
    async with sessions() as db:
        await db.execute(update(Device).where(Device.id == "pdu1").values(enabled=False))
        await db.commit()
    results = await power.switch(sessions, [target(pdu_id)], "off", BY)
    assert not results[0].ok and results[0].error
    assert fleet.calls == [] and fleet.credentials == []


@pytest.mark.parametrize("outlet", [0, -1, 5, True, "1"])
async def test_outlet_range_is_checked_before_device_contact(sessions, fleet, outlet):
    results = await power.switch(sessions, [target(outlet=outlet)], "off", BY)
    assert results[0].error == "Outlet is out of range"
    assert not results[0].ok and fleet.calls == [] and fleet.credentials == []


async def test_unknown_action_never_contacts_device_or_echoes_input(sessions, fleet):
    results = await power.switch(sessions, [target()], SECRET, BY)
    assert not results[0].ok and not fleet.credentials
    no_secrets(results)


async def test_actual_decrypt_failure_is_safe_and_never_constructs_driver(sessions, fleet):
    async with sessions() as db:
        await db.execute(update(Device).where(Device.id == "pdu1").values(password_enc=SECRET))
        await db.commit()
    results = await power.switch(sessions, [target()], "off", BY)
    assert not results[0].ok and results[0].error == "PDU credentials could not be decrypted"
    assert fleet.credentials == [] and fleet.calls == []
    no_secrets(results)


@pytest.mark.parametrize("stage", ["credentials", "constructor", "command", "readback"])
async def test_exception_text_is_never_returned(sessions, fleet, monkeypatch, stage, caplog):
    caplog.set_level("DEBUG")

    def fail(*args):
        raise RuntimeError("https://synthetic-user:" + SECRET + "@pdu1.example.invalid")

    async def async_fail(*args):
        fail()

    if stage == "credentials":
        monkeypatch.setattr(pdus_module, "get_creds", fail)
    elif stage == "constructor":
        monkeypatch.setattr(pdus_module, "RaritanPduDriver", fail)
    elif stage == "command":
        monkeypatch.setattr(fleet.drivers["pdu1"], "set_outlet_state", async_fail)
    else:
        monkeypatch.setattr(pdus_module, "_fetch_status", async_fail)
    results = await power.switch(sessions, [target()], "off", BY)
    assert not results[0].ok
    assert results[0].error == ("PDU credentials could not be decrypted" if stage == "credentials"
                                 else "Device API returned no usable status (RuntimeError)")
    no_secrets(results)
    assert SECRET not in caplog.text and "synthetic-user" not in caplog.text


async def test_close_failure_still_allows_live_verification(sessions, fleet, monkeypatch):
    driver = fleet.drivers["pdu1"]
    original_close = driver.close

    async def close():
        await original_close()
        if driver.closed == 1:
            raise RuntimeError(SECRET)

    monkeypatch.setattr(driver, "close", close)
    results = await power.switch(sessions, [target()], "off", BY)
    assert results[0].ok and driver.closed == 2
    no_secrets(results)


@pytest.mark.parametrize("outlet,ok", [(1, True), (5, False)])
async def test_unspecified_port_count_uses_live_outlet_numbers(sessions, fleet, outlet, ok):
    async with sessions() as db:
        await db.execute(update(Device).where(Device.id == "pdu1").values(port_count=0))
        await db.commit()
    result = (await power.switch(sessions, [target(outlet=outlet)], "off", BY))[0]
    assert result.ok is ok
    assert fleet.calls == ([("pdu1", 1, "off")] if ok else [])
    assert fleet.drivers["pdu1"].closed == fleet.drivers["pdu1"].created


async def test_maintenance_waits_until_close_and_live_verification_finish(sessions, fleet, monkeypatch):
    read_started, release_read = asyncio.Event(), asyncio.Event()
    maintenance_waiting, acquired = asyncio.Event(), asyncio.Event()
    fetch = pdus_module._fetch_status

    async def blocked_read(*args):
        assert fleet.drivers["pdu1"].closed == 1
        read_started.set()
        await release_read.wait()
        return await fetch(*args)

    monkeypatch.setattr(pdus_module, "_fetch_status", blocked_read)

    async def concurrent_maintenance():
        async with sessions() as db:
            maintenance_waiting.set()
            async with pdus_module.locked_pdu("pdu1", db):
                acquired.set()
                assert fleet.drivers["pdu1"].closed == 2
                assert fleet.drivers["pdu1"].states[1] == "off"

    switching = asyncio.create_task(power.switch(sessions, [target()], "off", BY))
    waiting = None
    try:
        await asyncio.wait_for(read_started.wait(), 5)
        waiting = asyncio.create_task(concurrent_maintenance())
        await asyncio.wait_for(maintenance_waiting.wait(), 5)
        await asyncio.sleep(0)
        assert not acquired.is_set()
    finally:
        release_read.set()
        results = await switching
        if waiting is not None:
            await waiting
    assert results[0].ok and acquired.is_set()


async def test_device_is_reread_after_waiting_for_lock(sessions, fleet, monkeypatch):
    checked = asyncio.Event()
    get_pdu = pdus_module._get_pdu_or_404

    async def signal_checked(*args):
        dev = await get_pdu(*args)
        checked.set()
        return dev

    monkeypatch.setattr(pdus_module, "_get_pdu_or_404", signal_checked)
    async with pdu_locks.maintenance_lock("pdu1"):
        switching = asyncio.create_task(power.switch(sessions, [target()], "on", BY))
        await asyncio.wait_for(checked.wait(), 5)
        async with sessions() as db:
            await db.execute(update(Device).where(Device.id == "pdu1").values(enabled=False))
            await db.commit()
    results = await switching
    assert not results[0].ok and results[0].error == "PDU is disabled"
    assert fleet.calls == []


async def test_cycle_all_feeds_off_then_wait_then_on_and_final_callbacks(sessions, fleet):
    targets = [target(), target("pdu2"), target(outlet=2)]
    targets[2].state = "off"
    active = targets[:2]
    reported, waits = [], []

    async def sleep(seconds):
        waits.append(seconds)
        assert fleet.calls == [(t.pdu_id, t.outlet, "off") for t in active]
        assert all(fleet.drivers[t.pdu_id].states[t.outlet] == "off" for t in targets)

    async def on_result(result):
        assert all(fleet.drivers[t.pdu_id].states[t.outlet] == t.state for t in targets)
        reported.append(result)

    results = await power.cycle(sessions, targets, BY, off_seconds=3.5, sleep=sleep, on_result=on_result)
    assert waits == [3.5] and reported == results and len(results) == len(targets)
    assert all(r.ok and r.state_after == t.state and not r.error for r, t in zip(results, targets))
    assert fleet.calls == [(t.pdu_id, t.outlet, "off") for t in active] + [
        (t.pdu_id, t.outlet, "on") for t in active]


@pytest.mark.parametrize("reason", ["maintenance", "disabled", "missing", "range"])
async def test_cycle_checks_all_feeds_before_first_off(sessions, fleet, reason):
    second = target("pdu2")
    if reason == "maintenance":
        await maintenance(sessions, "pdu2")
    elif reason == "disabled":
        async with sessions() as db:
            await db.execute(update(Device).where(Device.id == "pdu2").values(enabled=False))
            await db.commit()
    elif reason == "missing":
        second.pdu_id = "missing"
    else:
        second.outlet = 5
    results = await power.cycle(sessions, [target(), second], BY, off_seconds=0)
    assert all(not r.ok for r in results) and fleet.calls == [] and fleet.credentials == []


async def test_cycle_off_failure_stops_and_restores_without_waiting(sessions, fleet):
    fleet.drivers["pdu2"].fail.add(1)
    waits, reported = [], []

    async def sleep(seconds):
        waits.append(seconds)

    async def on_result(result):
        reported.append(result)

    results = await power.cycle(sessions, [target(), target("pdu2"), target(outlet=3)], BY,
                                off_seconds=7, sleep=sleep, on_result=on_result)
    assert fleet.calls == [("pdu1", 1, "off"), ("pdu2", 1, "off"),
                           ("pdu1", 1, "on"), ("pdu2", 1, "on")]
    assert waits == [] and len(reported) == 3 and reported == results
    assert all(not r.ok for r in results)
    assert [r.state_after for r in results] == ["on", "on", "on"]
    no_secrets(results)


async def test_cycle_lost_responses_are_verified_in_both_phases(sessions, fleet):
    fleet.drivers["pdu1"].lost.add(1)

    async def sleep(seconds):
        pass

    result = (await power.cycle(sessions, [target()], BY, off_seconds=2, sleep=sleep))[0]
    assert result.ok and result.state_after == "on" and result.error == ""
    assert fleet.drivers["pdu1"].reads == 2


async def test_cycle_recovers_feed_when_off_happened_but_readback_failed(sessions, fleet):
    driver = fleet.drivers["pdu1"]
    driver.lost.add(1)
    driver.side_effects[1] = lambda: setattr(driver, "unreachable", len(driver.calls) == 1)
    result = (await power.cycle(sessions, [target()], BY, off_seconds=0))[0]
    assert fleet.calls == [("pdu1", 1, "off"), ("pdu1", 1, "on")]
    assert driver.states[1] == "on" and result.state_after == "on" and not result.ok
    no_secrets([result])


async def test_cycle_restore_continues_after_one_recovery_failure(sessions, fleet, monkeypatch):
    driver = fleet.drivers["pdu1"]
    original_switch = driver.set_outlet_state
    fleet.drivers["pdu2"].fail.add(1)

    async def fail_one_restore(number, action):
        if number == 1 and action == "on":
            fleet.calls.append(("pdu1", number, action))
            raise httpx.ReadTimeout(SECRET)
        return await original_switch(number, action)

    monkeypatch.setattr(driver, "set_outlet_state", fail_one_restore)
    results = await power.cycle(sessions, [target(), target(outlet=3), target("pdu2")], BY, off_seconds=0)
    assert ("pdu1", 3, "on") in fleet.calls and driver.states[3] == "on"
    assert all(not r.ok for r in results)
    assert results[0].state_after == "off" and "could not be restored" in results[0].error
    assert results[1].state_after == "on"
    no_secrets(results)


async def test_cycle_on_failure_reports_verified_partial_result(sessions, fleet):
    async def sleep(seconds):
        fleet.drivers["pdu1"].ignore.add(1)

    results = await power.cycle(sessions, [target(), target("pdu2")], BY, off_seconds=5, sleep=sleep)
    assert not results[0].ok and results[0].state_after == "off"
    assert results[1].ok and results[1].state_after == "on"


@pytest.mark.parametrize("device_id", ["pdu1", "pdu2"])
@pytest.mark.parametrize("cancel", [False, True])
async def test_maintenance_waits_for_cycle_and_retains_its_restore_path(sessions, fleet, device_id, cancel):
    sleep_started, release_sleep, maintenance_waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def sleep(seconds):
        sleep_started.set()
        await release_sleep.wait()

    async def shutdown():
        async with sessions() as db:
            maintenance_waiting.set()
            return await maintenance_module.shutdown_pdu(db, device_id, BY, "Queued maintenance")

    cycling = asyncio.create_task(power.cycle(sessions, [target("pdu2"), target()], BY,
                                               off_seconds=5, sleep=sleep))
    queued = None
    try:
        await asyncio.wait_for(sleep_started.wait(), 5)
        queued = asyncio.create_task(shutdown())
        await asyncio.wait_for(maintenance_waiting.wait(), 5)
        await asyncio.sleep(0)
        assert not queued.done()
        assert all(pdu_locks.maintenance_lock(pdu_id).locked() for pdu_id in fleet.drivers)
        assert all(driver.states[1] == "off" for driver in fleet.drivers.values())
    finally:
        if cancel:
            cycling.cancel()
            with pytest.raises(asyncio.CancelledError):
                await cycling
        else:
            release_sleep.set()
            results = await cycling
            assert all(result.ok and result.state_after == "on" for result in results)
        shutdown_result = await queued if queued is not None else None
    assert shutdown_result is not None and 1 in shutdown_result["state"]["outlets_off"]
    assert fleet.calls[:4] == [("pdu2", 1, "off"), ("pdu1", 1, "off"),
                              ("pdu2", 1, "on"), ("pdu1", 1, "on")]
    async with sessions() as db:
        restored = await maintenance_module.restore_pdu(db, device_id, BY)
    assert restored["state"] is None and fleet.drivers[device_id].states[1] == "on"


@pytest.mark.parametrize("cancel", [False, True])
async def test_cycle_wait_exception_restores_all_feeds(sessions, fleet, cancel):
    async def sleep(seconds):
        if cancel:
            raise asyncio.CancelledError
        raise RuntimeError(SECRET)

    reported = []

    async def on_result(result):
        reported.append(result)

    if cancel:
        with pytest.raises(asyncio.CancelledError):
            await power.cycle(sessions, [target(), target("pdu2")], BY,
                              off_seconds=5, sleep=sleep, on_result=on_result)
    else:
        await power.cycle(sessions, [target(), target("pdu2")], BY,
                          off_seconds=5, sleep=sleep, on_result=on_result)
    assert all(d.states[1] == "on" for d in fleet.drivers.values())
    assert len(reported) == 2 and all(not r.ok and r.state_after == "on" for r in reported)
    no_secrets(reported)


@pytest.mark.parametrize("seconds", [-1, float("nan"), float("inf"), SECRET])
async def test_invalid_cycle_delay_never_switches(sessions, fleet, seconds):
    results = await power.cycle(sessions, [target()], BY, off_seconds=seconds)
    assert not results[0].ok and not fleet.credentials
    no_secrets(results)


async def test_empty_targets_are_noop(sessions, fleet):
    assert await power.switch(sessions, [], "off", BY) == []
    assert await power.cycle(sessions, [], BY, off_seconds=0) == []
    assert fleet.calls == []


@pytest.mark.parametrize("action", ["on", "off"])
@pytest.mark.parametrize("reference", ["pdu1", "PDU1"])
async def test_protected_outlet_is_refused_defensively(sessions, fleet, settings, action, reference):
    settings.power_protected_outlets = reference + ":1"
    results = await power.switch(sessions, [target()], action, BY)
    assert not results[0].ok and results[0].error == "Outlet is protected"
    assert fleet.credentials == [] and fleet.calls == []


async def test_protection_does_not_block_other_outlets(sessions, fleet, settings):
    settings.power_protected_outlets = "pdu1:1"
    results = await power.switch(sessions, [target(), target(outlet=3)], "off", BY)
    assert not results[0].ok and results[0].error == "Outlet is protected"
    assert results[1].ok and results[1].state_after == "off"
    assert fleet.calls == [("pdu1", 3, "off")]


async def test_invalid_protection_setting_fails_closed_without_echo(sessions, fleet, settings):
    settings.power_protected_outlets = SECRET
    results = await power.switch(sessions, [target()], "off", BY)
    assert not results[0].ok and results[0].error == "Protected outlets configuration is invalid"
    assert not fleet.credentials
    no_secrets(results)


async def test_cycle_checks_protection_for_all_targets_before_first_off(sessions, fleet, settings):
    settings.power_protected_outlets = "pdu2:1"
    results = await power.cycle(sessions, [target(), target("pdu2")], BY, off_seconds=0)
    assert all(not r.ok for r in results) and results[1].error == "Outlet is protected"
    assert fleet.calls == [] and fleet.credentials == []


async def test_cycle_preserves_off_feed_even_when_active_feed_fails(sessions, fleet):
    fleet.drivers["pdu2"].fail.add(1)
    off = target(outlet=2)
    off.state = "off"
    results = await power.cycle(sessions, [target("pdu2"), off], BY, off_seconds=0)
    assert all(not r.ok for r in results)
    assert results[1].state_after == "off"
    assert fleet.drivers["pdu1"].states[2] == "off"
    assert all(device_id != "pdu1" for device_id, _, _ in fleet.calls)


async def test_cycle_all_off_is_refused_and_live_verified_without_switching(sessions, fleet):
    off = target(outlet=2)
    off.state = "off"
    results = await power.cycle(sessions, [off], BY, off_seconds=0)
    assert not results[0].ok and results[0].state_after == "off"
    assert results[0].error == "All target outlets are already off"
    assert fleet.calls == [] and fleet.drivers["pdu1"].reads == 1


@pytest.mark.parametrize("state", ["cycling", "unknown"])
async def test_cycle_refuses_unknown_proposal_state_before_switching(sessions, fleet, state):
    unknown = target()
    unknown.state = state
    results = await power.cycle(sessions, [unknown], BY, off_seconds=0)
    assert not results[0].ok and results[0].error == "Outlet state is not known"
    assert fleet.credentials == [] and fleet.calls == []


async def test_cycle_cancelled_during_on_completes_every_attempted_feed(sessions, fleet, monkeypatch):
    driver = fleet.drivers["pdu1"]
    original_switch = driver.set_outlet_state
    on_started, release_on = asyncio.Event(), asyncio.Event()
    reported = []

    async def blocked_on(number, action):
        if action == "on":
            on_started.set()
            await release_on.wait()
        return await original_switch(number, action)

    async def sleep(seconds):
        pass

    async def on_result(result):
        reported.append(result)

    monkeypatch.setattr(driver, "set_outlet_state", blocked_on)
    cycling = asyncio.create_task(power.cycle(sessions, [target(), target("pdu2")], BY,
                                               off_seconds=0, sleep=sleep, on_result=on_result))
    try:
        await asyncio.wait_for(on_started.wait(), 5)
        cycling.cancel()
        await asyncio.sleep(0)
        cycling.cancel()
        await asyncio.sleep(0)
        assert not cycling.done()
    finally:
        release_on.set()
        with pytest.raises(asyncio.CancelledError):
            await cycling
    assert fleet.calls == [("pdu1", 1, "off"), ("pdu2", 1, "off"),
                           ("pdu1", 1, "on"), ("pdu2", 1, "on")]
    assert len(reported) == 2 and all(not r.ok and r.state_after == "on" for r in reported)


async def test_cycle_cancelled_during_lost_off_response_restores_attempted_only(sessions, fleet, monkeypatch):
    driver = fleet.drivers["pdu1"]
    original_switch = driver.set_outlet_state
    off_started = asyncio.Event()
    reported = []

    async def lost_off_response(number, action):
        result = await original_switch(number, action)
        if action == "off":
            off_started.set()
            await asyncio.Event().wait()
        return result

    async def on_result(result):
        reported.append(result)

    monkeypatch.setattr(driver, "set_outlet_state", lost_off_response)
    cycling = asyncio.create_task(power.cycle(sessions, [target(), target("pdu2")], BY,
                                               off_seconds=0, on_result=on_result))
    await asyncio.wait_for(off_started.wait(), 5)
    cycling.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cycling
    assert fleet.calls == [("pdu1", 1, "off"), ("pdu1", 1, "on")]
    assert all(d.states[1] == "on" for d in fleet.drivers.values())
    assert len(reported) == 2 and all(not r.ok and r.state_after == "on" for r in reported)


async def test_cycle_cancellation_during_callback_finishes_all_reporting(sessions, fleet):
    callback_started, release_callback = asyncio.Event(), asyncio.Event()
    reported = []

    async def sleep(seconds):
        pass

    async def on_result(result):
        reported.append(result)
        if len(reported) == 1:
            callback_started.set()
            await release_callback.wait()

    cycling = asyncio.create_task(power.cycle(sessions, [target(), target("pdu2")], BY,
                                               off_seconds=0, sleep=sleep, on_result=on_result))
    try:
        await asyncio.wait_for(callback_started.wait(), 5)
        cycling.cancel()
        await asyncio.sleep(0)
        assert not cycling.done()
    finally:
        release_callback.set()
        with pytest.raises(asyncio.CancelledError):
            await cycling
    assert len(reported) == 2 and all(r.ok and r.state_after == "on" for r in reported)


@pytest.mark.parametrize("action", ["on", "off", "cycle"])
async def test_matching_approved_pins_allow_power_action(sessions, fleet, action):
    pins = await approved_pins(sessions)
    if action == "cycle":
        results = await power.cycle(sessions, [target()], BY, off_seconds=0, pins=pins)
    else:
        results = await power.switch(sessions, [target()], action, BY, pins=pins)
    assert results[0].ok and results[0].state_after == ("on" if action == "cycle" else action)


@pytest.mark.parametrize("action", ["on", "off"])
@pytest.mark.parametrize("change", [{"ip": "pdu2.example.invalid"}, {"enabled": False},
                                    {"labels_json": '{"1":"OPT99"}'}])
async def test_switch_rechecks_pins_after_waiting_for_lock(sessions, fleet, monkeypatch, action, change):
    pins = await approved_pins(sessions)
    waiting = asyncio.Event()
    get_pdu = pdus_module._get_pdu_or_404
    reported = []

    async def signal_checked(*args):
        dev = await get_pdu(*args)
        waiting.set()
        return dev

    async def on_result(result):
        reported.append(result)

    monkeypatch.setattr(pdus_module, "_get_pdu_or_404", signal_checked)
    async with pdu_locks.maintenance_lock("pdu1"):
        switching = asyncio.create_task(power.switch(sessions, [target()], action, BY,
                                                      on_result=on_result, pins=pins))
        await asyncio.wait_for(waiting.wait(), 5)
        async with sessions() as db:
            await db.execute(update(Device).where(Device.id == "pdu1").values(**change))
            await db.commit()
    results = await switching
    assert reported == results
    assert not results[0].ok and results[0].error == "PDU changed since the proposal"
    assert fleet.calls == [] and fleet.credentials == []
    assert fleet.drivers["pdu2"].states[1] == "on"


@pytest.mark.parametrize("change", [{"ip": "pdu1.example.invalid"}, {"enabled": False},
                                    {"labels_json": '{"1":"OPT99"}'}])
async def test_cycle_checks_pins_after_all_locks_acquired(sessions, fleet, monkeypatch, change):
    pins = await approved_pins(sessions)
    waiting = asyncio.Event()

    @asynccontextmanager
    async def tracked_lock(device_id):
        if device_id == "pdu2":
            waiting.set()
        async with pdu_locks.maintenance_lock(device_id):
            yield

    monkeypatch.setattr(power, "maintenance_lock", tracked_lock)
    async with pdu_locks.maintenance_lock("pdu2"):
        cycling = asyncio.create_task(power.cycle(sessions, [target("pdu2"), target()], BY,
                                                   off_seconds=0, pins=pins))
        await asyncio.wait_for(waiting.wait(), 5)
        assert pdu_locks.maintenance_lock("pdu1").locked()
        async with sessions() as db:
            await db.execute(update(Device).where(Device.id == "pdu2").values(**change))
            await db.commit()
    results = await cycling
    assert all(not result.ok for result in results)
    assert results[0].error == "PDU changed since the proposal"
    assert fleet.calls == [] and fleet.credentials == []
    assert all(not pdu_locks.maintenance_lock(pdu_id).locked() for pdu_id in fleet.drivers)


@pytest.mark.parametrize("action", ["off", "cycle"])
@pytest.mark.parametrize("pins", [{}, {"pdu1": {}}, {"pdu1": {"ip": "pdu1.example.invalid"}}])
async def test_missing_supplied_pins_fail_closed(sessions, fleet, action, pins):
    if action == "cycle":
        results = await power.cycle(sessions, [target()], BY, off_seconds=0, pins=pins)
    else:
        results = await power.switch(sessions, [target()], action, BY, pins=pins)
    assert not results[0].ok and results[0].error == "PDU changed since the proposal"
    assert fleet.calls == [] and fleet.credentials == []


async def test_switch_checks_pins_again_before_each_pdu(sessions, fleet):
    pins = await approved_pins(sessions)

    async def on_result(result):
        if result.pdu_id == "pdu1":
            async with sessions() as db:
                await db.execute(update(Device).where(Device.id == "pdu2").values(ip="pdu1.example.invalid"))
                await db.commit()

    results = await power.switch(sessions, [target(), target("pdu2")], "off", BY,
                                  on_result=on_result, pins=pins)
    assert results[0].ok and not results[1].ok
    assert results[1].error == "PDU changed since the proposal"
    assert fleet.calls == [("pdu1", 1, "off")]


async def test_cycle_acquires_sorted_unique_locks_without_internal_relocking(sessions, fleet, monkeypatch):
    acquisitions = []
    readback = pdus_module._fetch_status

    @asynccontextmanager
    async def tracked_lock(device_id):
        acquisitions.append(device_id)
        async with pdu_locks.maintenance_lock(device_id):
            yield

    @asynccontextmanager
    async def forbidden_relock(*args):
        raise AssertionError("Cycle helpers must not re-lock")
        yield

    async def locked_readback(*args):
        assert all(pdu_locks.maintenance_lock(pdu_id).locked() for pdu_id in fleet.drivers)
        return await readback(*args)

    async def sleep(seconds):
        assert acquisitions == ["pdu1", "pdu2"]
        assert all(pdu_locks.maintenance_lock(pdu_id).locked() for pdu_id in fleet.drivers)

    async def on_result(result):
        assert all(not pdu_locks.maintenance_lock(pdu_id).locked() for pdu_id in fleet.drivers)
        async with AsyncExitStack() as stack:
            for pdu_id in sorted(fleet.drivers):
                await stack.enter_async_context(pdu_locks.maintenance_lock(pdu_id))

    monkeypatch.setattr(power, "maintenance_lock", tracked_lock)
    monkeypatch.setattr(pdus_module, "locked_pdu", forbidden_relock)
    monkeypatch.setattr(pdus_module, "_fetch_status", locked_readback)
    results = await asyncio.wait_for(power.cycle(sessions, [target("pdu2"), target(), target("pdu2", 3)],
                                                 BY, off_seconds=0, sleep=sleep, on_result=on_result), 5)
    assert all(result.ok for result in results) and acquisitions == ["pdu1", "pdu2"]


async def test_cycle_cancelled_while_acquiring_locks_releases_earlier_locks(sessions, fleet, monkeypatch):
    waiting = asyncio.Event()

    @asynccontextmanager
    async def tracked_lock(device_id):
        if device_id == "pdu2":
            waiting.set()
        async with pdu_locks.maintenance_lock(device_id):
            yield

    monkeypatch.setattr(power, "maintenance_lock", tracked_lock)
    async with pdu_locks.maintenance_lock("pdu2"):
        cycling = asyncio.create_task(power.cycle(sessions, [target("pdu2"), target()], BY, off_seconds=0))
        await asyncio.wait_for(waiting.wait(), 5)
        assert pdu_locks.maintenance_lock("pdu1").locked()
        cycling.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cycling
        assert not pdu_locks.maintenance_lock("pdu1").locked()
        assert pdu_locks.maintenance_lock("pdu2").locked()
    assert fleet.calls == [] and fleet.credentials == []


async def test_reversed_overlapping_cycles_complete_without_deadlock(sessions, fleet):
    async def sleep(seconds):
        await asyncio.sleep(0)

    results = await asyncio.wait_for(asyncio.gather(
        power.cycle(sessions, [target("pdu2"), target()], BY, off_seconds=0, sleep=sleep),
        power.cycle(sessions, [target(), target("pdu2")], BY, off_seconds=0, sleep=sleep),
    ), 5)
    assert all(result.ok for cycle_results in results for result in cycle_results)
    assert all(driver.states[1] == "on" for driver in fleet.drivers.values())
    assert all(not pdu_locks.maintenance_lock(pdu_id).locked() for pdu_id in fleet.drivers)


async def test_label_edit_during_cycle_cannot_prevent_attempted_feed_recovery(sessions, fleet):
    pins = await approved_pins(sessions)

    async def sleep(seconds):
        # Label editing currently has no PDU lock. Recovery must use the endpoint
        # snapshot approved before off, rather than abandon the feed after editing.
        async with sessions() as db:
            await db.execute(update(Device).where(Device.id == "pdu1").values(labels_json='{"1":"OPT99"}'))
            await db.commit()

    results = await power.cycle(sessions, [target()], BY, off_seconds=0, sleep=sleep, pins=pins)
    assert results[0].ok and results[0].state_after == "on"
    assert fleet.calls == [("pdu1", 1, "off"), ("pdu1", 1, "on")]


@pytest.mark.parametrize("change", ["delete", "rename"])
async def test_unrelated_protection_drift_cannot_prevent_cycle_recovery(sessions, fleet, settings, change):
    settings.power_protected_outlets = "PDU2:1"
    pins = await approved_pins(sessions)

    async def sleep(seconds):
        async with sessions() as db:
            if change == "delete":
                await db.execute(delete(Device).where(Device.id == "pdu2"))
            else:
                await db.execute(update(Device).where(Device.id == "pdu2").values(name="Renamed PDU"))
            await db.commit()

    results = await power.cycle(sessions, [target()], BY, off_seconds=0, sleep=sleep, pins=pins)
    assert results[0].ok and results[0].state_after == "on"
    assert fleet.calls == [("pdu1", 1, "off"), ("pdu1", 1, "on")]
    assert fleet.drivers["pdu1"].states[1] == "on"
