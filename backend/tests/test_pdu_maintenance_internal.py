"""Confirmed maintenance internals, using the existing in-memory PDU and HTTP fixtures."""
import asyncio
import json
import time

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import confirm, pdu_locks
from app.models import PduMaintenance, PduMaintenanceLog
from app.routers import pdu_maintenance as pm, pdus as pdus_module
from tests.test_pdu_maintenance import (
    clear_maintenance_state, fake, mclient, pdu_id, restore, settings, shutdown,
)


@pytest.mark.parametrize("protected_state", ["on", "unknown", "cycling"])
async def test_excluded_outlets_are_never_switched_restored_or_reported_failed(
    db_session, pdu_id, fake, protected_state,
):
    fake.states[4] = protected_state
    pdus_module._cache[pdu_id] = (time.monotonic(), object())

    result = await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring",
                                   exclude=frozenset({4}), expected_on=frozenset({1, 3}))

    assert fake.calls == [(1, "off"), (3, "off")]
    assert fake.states[4] == protected_state
    assert result["state"]["outlets_off"] == [1, 3]
    assert result["state"]["failed"] == []
    assert result["state"]["started_by"] == "operator"
    assert result["state"]["reason"] == "Rack rewiring"
    assert result["results"] == [{"outlet": 1, "ok": True}, {"outlet": 3, "ok": True}]
    assert result["protected"] == [4] and result["not_included"] == []
    assert pdu_id not in pdus_module._cache
    entry = await db_session.scalar(select(PduMaintenanceLog))
    assert (entry.action, entry.by, entry.ok, entry.failed) == ("shutdown", "operator", 2, 0)

    fake.calls.clear()
    pdus_module._cache[pdu_id] = (time.monotonic(), object())
    result = await pm.restore_pdu(db_session, pdu_id, "restorer")
    assert result == {"state": None, "results": [{"outlet": 1, "ok": True}, {"outlet": 3, "ok": True}]}
    assert fake.calls == [(1, "on"), (3, "on")]
    assert fake.states[2] == "off" and fake.states[4] == protected_state
    assert pdu_id not in pdus_module._cache


@pytest.mark.parametrize("expected_on", [frozenset(), frozenset({1, 3})])
async def test_newly_powered_outlets_stay_on_and_are_not_included(db_session, pdu_id, fake, expected_on):
    result = await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring", expected_on=expected_on)

    powered = sorted(expected_on)
    skipped = {1, 3, 4} - expected_on
    assert fake.calls == [(n, "off") for n in powered]
    assert all(fake.states[n] == "on" for n in skipped)
    assert result["not_included"] == sorted(skipped) and result["protected"] == []
    assert result["state"]["outlets_off"] == powered and result["state"]["failed"] == []
    assert result["results"] == [{"outlet": n, "ok": True} for n in powered]
    row = await db_session.get(PduMaintenance, pdu_id)
    assert json.loads(row.outlets_off_json) == powered
    entry = await db_session.scalar(select(PduMaintenanceLog))
    assert (entry.ok, entry.failed) == (len(powered), 0)
    assert not pdu_locks.maintenance_lock(pdu_id).locked()

    fake.calls.clear()
    restored = await pm.restore_pdu(db_session, pdu_id, "operator")
    assert restored["state"] is None
    assert fake.calls == [(n, "on") for n in powered]
    assert all(fake.states[n] == "on" for n in skipped)


async def test_expected_on_allows_outlets_that_have_turned_off(db_session, pdu_id, fake):
    fake.states[3] = "off"
    result = await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring",
                                   exclude=frozenset({4}), expected_on=frozenset({1, 3}))
    assert fake.calls == [(1, "off")]
    assert result["state"]["outlets_off"] == [1] and result["state"]["failed"] == []


async def test_protected_and_not_included_outlets_are_distinct_and_do_not_count_as_failures(db_session, pdu_id, fake):
    fake.states[2] = "on"
    result = await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring",
                                   exclude=frozenset({4}), expected_on=frozenset({1}))
    assert fake.calls == [(1, "off")]
    assert result["protected"] == [4] and result["not_included"] == [2, 3]
    assert result["state"]["outlets_off"] == [1] and result["state"]["failed"] == []
    assert result["results"] == [{"outlet": 1, "ok": True}]
    assert all(fake.states[n] == "on" for n in (2, 3, 4))
    entry = await db_session.scalar(select(PduMaintenanceLog))
    assert (entry.ok, entry.failed) == (1, 0)


async def test_empty_expected_on_allows_only_protected_outlets_to_remain_on(db_session, pdu_id, fake):
    result = await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring",
                                   exclude=frozenset({1, 3, 4}), expected_on=frozenset())
    assert fake.calls == [] and result["results"] == []
    assert result["state"]["outlets_off"] == [] and result["state"]["failed"] == []
    assert result["protected"] == [1, 3, 4] and result["not_included"] == []
    assert fake.states == {1: "on", 2: "off", 3: "on", 4: "on"}
    reads = fake.reads
    assert await pm.restore_pdu(db_session, pdu_id, "operator") == {"state": None, "results": []}
    assert fake.calls == [] and fake.reads == reads


async def test_internal_conflicts_raise_without_reading_or_switching(db_session, pdu_id, fake):
    with pytest.raises(pm.MaintenanceConflict, match="PDU is not in maintenance mode"):
        await pm.restore_pdu(db_session, pdu_id, "operator")
    assert fake.created == 0 and fake.calls == []
    assert await db_session.scalar(select(func.count()).select_from(PduMaintenanceLog)) == 0

    await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring")
    fake.calls.clear()
    reads = fake.reads
    with pytest.raises(pm.MaintenanceConflict, match="PDU is already in maintenance mode"):
        await pm.shutdown_pdu(db_session, pdu_id, "other-operator", "Other work")
    assert fake.calls == [] and fake.reads == reads
    assert await db_session.scalar(select(func.count()).select_from(PduMaintenanceLog)) == 1
    row = await db_session.get(PduMaintenance, pdu_id)
    assert (row.started_by, row.reason) == ("operator", "Rack rewiring")


@pytest.mark.parametrize("states,unreachable,message", [
    ({1: "on"}, True, "ConnectTimeout"),
    ({}, False, "Device API returned no usable outlet states"),
    ({1: "unknown", 2: "cycling"}, False, "Device API returned no usable outlet states"),
])
async def test_unavailable_live_state_raises_without_writing(db_session, pdu_id, fake, states, unreachable, message):
    fake.states, fake.unreachable = states, unreachable
    with pytest.raises(pm.MaintenanceUnavailable, match=message):
        await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring")
    assert fake.calls == []
    assert await db_session.get(PduMaintenance, pdu_id) is None
    assert await db_session.scalar(select(func.count()).select_from(PduMaintenanceLog)) == 0


async def test_partial_restore_keeps_only_unverified_targets_for_retry(db_session, pdu_id, fake):
    await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring")
    fake.ignore, fake.calls = {3}, []

    result = await pm.restore_pdu(db_session, pdu_id, "restorer")
    assert fake.calls == [(1, "on"), (3, "on"), (4, "on")]
    assert result["state"]["outlets_off"] == result["state"]["failed"] == [3]
    assert result["results"] == [{"outlet": 1, "ok": True}, {"outlet": 3, "ok": False}, {"outlet": 4, "ok": True}]
    entry = await db_session.scalar(select(PduMaintenanceLog).order_by(PduMaintenanceLog.id.desc()))
    assert (entry.action, entry.by, entry.reason, entry.ok, entry.failed) == ("restore", "restorer", "Rack rewiring", 2, 1)

    fake.ignore, fake.calls = set(), []
    assert await pm.restore_pdu(db_session, pdu_id, "retrying-operator") == {
        "state": None, "results": [{"outlet": 3, "ok": True}],
    }
    assert fake.calls == [(3, "on")] and fake.states[2] == "off"
    assert await db_session.get(PduMaintenance, pdu_id) is None


@pytest.mark.parametrize("via_http", [False, True])
@pytest.mark.parametrize("unknown", [False, True])
async def test_lost_shutdown_verification_marks_every_attempt_unverified_and_keeps_restore_list(
    db_session, mclient, pdu_id, fake, settings, via_http, unknown,
):
    if unknown:
        fake.states[2] = "unknown"
    fake.side_effects = {1: lambda: setattr(fake, "unreachable", True)}
    pdus_module._cache[pdu_id] = (time.monotonic(), object())

    if via_http:
        settings.power_protected_outlets = "PDU-M:4"
        response = await shutdown(mclient, pdu_id)
        assert response.status_code == 200, response.text
        result = response.json()
    else:
        result = await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring",
                                       expected_on=frozenset({1, 3}))

    failed = [1, 2, 3] if unknown else [1, 3]
    assert fake.reads == 2 and fake.calls == [(1, "off"), (3, "off")]
    assert fake.states[4] == "on"
    assert result["state"]["outlets_off"] == [1, 3]
    assert result["state"]["failed"] == failed
    assert result["results"] == [{"outlet": n, "ok": False} for n in failed]
    assert result["protected"] == ([4] if via_http else [])
    assert result["not_included"] == ([] if via_http else [4])
    assert pdu_id not in pdus_module._cache
    row = await db_session.get(PduMaintenance, pdu_id)
    assert row is not None and json.loads(row.outlets_off_json) == [1, 3]
    entry = await db_session.scalar(select(PduMaintenanceLog))
    assert (entry.action, entry.ok, entry.failed) == ("shutdown", 0, len(failed))

    fake.unreachable, fake.side_effects, fake.calls = False, {}, []
    restored = await pm.restore_pdu(db_session, pdu_id, "operator")
    assert restored["state"] is None and fake.calls == [(1, "on"), (3, "on")]
    assert fake.states[2] == ("unknown" if unknown else "off") and fake.states[4] == "on"


@pytest.mark.parametrize("operation", ["shutdown", "restore"])
async def test_audit_and_restore_list_are_committed_before_switching(db_session, pdu_id, fake, monkeypatch, operation):
    if operation == "restore":
        await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring")
    sessions = async_sessionmaker(db_session.bind, expire_on_commit=False)
    switch = pm._switch
    observed = []

    async def check_committed(dev, numbers, action):
        assert pdu_locks.maintenance_lock(pdu_id).locked()
        assert not db_session.in_transaction()
        async with sessions() as observer:
            row = await observer.get(PduMaintenance, pdu_id)
            assert row is not None and json.loads(row.outlets_off_json) == [1, 3, 4]
            entry = await observer.scalar(select(PduMaintenanceLog).order_by(PduMaintenanceLog.id.desc()))
            assert (entry.action, entry.by, entry.reason, entry.ok, entry.failed) == (
                operation, "confirmed-operator", "Rack rewiring", 0, 0,
            )
        observed.append((list(numbers), action))
        return await switch(dev, numbers, action)

    monkeypatch.setattr(pm, "_switch", check_committed)
    if operation == "shutdown":
        await pm.shutdown_pdu(db_session, pdu_id, "confirmed-operator", "Rack rewiring")
    else:
        await pm.restore_pdu(db_session, pdu_id, "confirmed-operator")
    assert observed == [([1, 3, 4], "off" if operation == "shutdown" else "on")]
    assert not pdu_locks.maintenance_lock(pdu_id).locked()


async def test_http_conflicts_still_precede_password_confirmation(mclient, pdu_id, fake):
    response = await restore(mclient, pdu_id, password="wrong")
    assert response.status_code == 409 and response.json()["detail"] == "PDU is not in maintenance mode"
    assert (await mclient.get("/api/pdus/maintenance")).json()["log"] == []
    assert (await shutdown(mclient, pdu_id)).status_code == 200
    fake.calls.clear()

    response = await shutdown(mclient, pdu_id, password="wrong")
    assert response.status_code == 409 and response.json()["detail"] == "PDU is already in maintenance mode"
    assert fake.calls == []
    assert [entry["action"] for entry in (await mclient.get("/api/pdus/maintenance")).json()["log"]] == ["shutdown"]


@pytest.mark.parametrize("reference", ["id", "name"])
async def test_http_shutdown_honors_configured_protection(mclient, pdu_id, fake, settings, reference):
    settings.power_protected_outlets = (pdu_id if reference == "id" else "PDU-M") + ":4"
    response = await shutdown(mclient, pdu_id)
    assert response.status_code == 200, response.text
    assert response.json()["state"]["outlets_off"] == [1, 3]
    assert response.json()["state"]["failed"] == []
    assert response.json()["protected"] == [4] and response.json()["not_included"] == []
    assert fake.calls == [(1, "off"), (3, "off")] and fake.states[4] == "on"

    fake.calls.clear()
    response = await restore(mclient, pdu_id)
    assert response.status_code == 200 and response.json()["state"] is None
    assert fake.calls == [(1, "on"), (3, "on")] and fake.states[4] == "on"


@pytest.mark.parametrize("protection", ["missing-pdu:4", "PDU-M:99", "PDU-M:invalid", ",,", "PDU-M:4,,"])
async def test_http_shutdown_refuses_invalid_protection_without_switch_or_write(
    mclient, pdu_id, fake, settings, protection,
):
    settings.power_protected_outlets = protection
    response = await shutdown(mclient, pdu_id)
    assert response.status_code == 409
    assert response.json()["detail"] == "Protected outlets configuration is invalid"
    assert fake.created == 0 and fake.calls == []
    listing = (await mclient.get("/api/pdus/maintenance")).json()
    assert listing["pdus"] == {} and listing["log"] == []


@pytest.mark.parametrize("operation", ["shutdown", "restore"])
async def test_http_confirmation_uses_the_current_shared_lock(mclient, pdu_id, fake, monkeypatch, operation):
    if operation == "restore":
        assert (await shutdown(mclient, pdu_id)).status_code == 200
    current_lock = asyncio.Lock()
    monkeypatch.setattr(confirm, "confirm_lock", current_lock)
    reserve = confirm.reserve_attempt
    observed = []

    async def check_locked(db, key):
        assert current_lock.locked()
        observed.append(key)
        return await reserve(db, key)

    monkeypatch.setattr(confirm, "reserve_attempt", check_locked)
    response = await (shutdown(mclient, pdu_id) if operation == "shutdown" else restore(mclient, pdu_id))
    assert response.status_code == 200, response.text
    assert len(observed) == 1 and not current_lock.locked()
