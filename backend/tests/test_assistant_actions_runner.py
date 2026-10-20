"""Runner contract tests: in-memory persistence and fake action modules only."""
import asyncio
import importlib
import json
import sys
import time
from types import ModuleType, SimpleNamespace

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.assistant.actions as actions
from app.assistant.actions import runner
from app.assistant.actions.contracts import Console, TargetResult
from app.assistant.actions.models import AssistantActionEvent, AssistantActionProposal
from app.models import Device, PduMaintenance, PduMaintenanceLog
from app.routers import pdu_maintenance
from app import power_protection

SECRET = "synthetic-private-error-value"


class MaintenanceConflict(Exception):
    pass


class MaintenanceDrift(Exception):
    pass


class MaintenanceUnavailable(Exception):
    pass


@pytest.fixture
def sessions(db_session):
    return async_sessionmaker(db_session.bind, expire_on_commit=False)


@pytest.fixture
def fake(monkeypatch):
    try:
        real_store = importlib.import_module("app.assistant.actions.store")
    except ModuleNotFoundError:
        real_store = None
    state = SimpleNamespace(calls=[], progress=[], sleeps=[], observed_batches=[], payloads={}, errors={},
                            power_results=None, callbacks=True, duplicates=False, power_error=None,
                            after_commit_error=None, before_commit_error=None, console_servers=[],
                            real_store=real_store,
                            real_protection_load=power_protection.load,
                            real_shutdown=getattr(pdu_maintenance, "shutdown_pdu", None),
                            real_restore=getattr(pdu_maintenance, "restore_pdu", None))
    store = ModuleType("app.assistant.actions.store")

    async def add_event(db, proposal_id, actor, event, detail):
        db.add(AssistantActionEvent(at=time.time(), proposal_id=proposal_id, actor=actor,
                                    event=event, detail_json=json.dumps(detail)))
        await db.flush()

    async def set_progress(db, proposal_id, done, total):
        state.progress.append((proposal_id, done, total))
        await db.execute(update(AssistantActionProposal).where(AssistantActionProposal.id == proposal_id)
                         .values(progress_done=done, progress_total=total))

    async def finish(db, proposal_id, status, result):
        await db.execute(update(AssistantActionProposal).where(AssistantActionProposal.id == proposal_id)
                         .values(status=status, result_json=json.dumps(result), finished_at=time.time()))

    store.add_event, store.set_progress, store.finish = add_event, set_progress, finish
    power = ModuleType("app.assistant.actions.power")

    async def power_run(targets, expected, on_result):
        results = state.power_results
        if results is None:
            results = [TargetResult(t.pdu_id, t.outlet, True,
                                    ("on" if t.state == "on" else "off") if expected == "cycle" else expected)
                       for t in targets]
        if state.callbacks:
            for result in results:
                await on_result(result)
                if state.duplicates:
                    await on_result(result)
                if state.power_error:
                    raise state.power_error
        if state.power_error:
            raise state.power_error
        return results

    async def switch(session_factory, targets, action, by, on_result=None):
        state.calls.append(("switch", action, by, targets))
        return await power_run(targets, action, on_result)

    async def cycle(session_factory, targets, by, *, off_seconds, sleep, on_result=None):
        state.calls.append(("cycle", off_seconds, by, targets))
        await sleep(off_seconds)
        return await power_run(targets, "cycle", on_result)

    power.switch, power.cycle = switch, cycle
    resolve = ModuleType("app.assistant.actions.resolve")

    async def consoles_for(db, server):
        state.console_servers.append(server)
        return [Console("kvm-one", "KVM", 3, server, "/api/kvms/kvm-one/autologin?port=3")]

    resolve.consoles_for = consoles_for
    for name, module in (("store", store), ("power", power), ("resolve", resolve)):
        monkeypatch.setitem(sys.modules, f"app.assistant.actions.{name}", module)
        monkeypatch.setattr(actions, name, module, raising=False)
    for error_type in (MaintenanceConflict, MaintenanceDrift, MaintenanceUnavailable):
        monkeypatch.setattr(pdu_maintenance, error_type.__name__, error_type, raising=False)

    async def remember_batches(db):
        rows = (await db.scalars(select(AssistantActionProposal))).all()
        state.observed_batches.append({row.id: json.loads(row.batch_down_json) for row in rows})

    async def shutdown_pdu(db, device_id, by, reason, *, exclude, expected_on):
        state.calls.append(("shutdown", device_id, by, reason, exclude, expected_on))
        if device_id in state.errors:
            raise state.errors[device_id]
        if await db.get(PduMaintenance, device_id):
            raise MaintenanceConflict(SECRET)
        payload = state.payloads.get(device_id, {
            "state": {"outlets_off": [1], "failed": []}, "results": [{"outlet": 1, "ok": True}]})
        value = payload["state"]
        value.setdefault("started_at", 1.0)
        db.add(PduMaintenance(device_id=device_id, started_at=value["started_at"], started_by=by, reason=reason,
                              outlets_off_json=json.dumps(value["outlets_off"]),
                              failed_json=json.dumps(value["failed"])))
        if state.before_commit_error:
            await db.flush()
            raise state.before_commit_error
        await db.commit()
        await remember_batches(db)
        if state.after_commit_error:
            raise state.after_commit_error
        return payload

    async def restore_pdu(db, device_id, by):
        state.calls.append(("restore", device_id, by))
        if device_id in state.errors:
            raise state.errors[device_id]
        row = await db.get(PduMaintenance, device_id)
        if row is None:
            raise MaintenanceConflict(SECRET)
        payload = state.payloads.get(device_id, {"state": None, "results": [{"outlet": 1, "ok": True}]})
        if payload["state"] is None:
            await db.delete(row)
        else:
            row.outlets_off_json = row.failed_json = json.dumps(payload["state"]["failed"])
        await db.commit()
        await remember_batches(db)
        if state.after_commit_error:
            raise state.after_commit_error
        return payload

    monkeypatch.setattr(pdu_maintenance, "shutdown_pdu", shutdown_pdu, raising=False)
    monkeypatch.setattr(pdu_maintenance, "restore_pdu", restore_pdu, raising=False)
    monkeypatch.setattr(runner, "BATCH_LOCK", asyncio.Lock())
    monkeypatch.setattr(runner, "_MAINTENANCE_LOCK", asyncio.Lock())

    async def protection_load(db, settings):
        return power_protection.Protection(configured=True)

    monkeypatch.setattr(power_protection, "load", protection_load)

    async def reachable(db, pdu_id):
        return True

    state.real_probe = runner._probe_reachable
    monkeypatch.setattr(runner, "_probe_reachable", reachable)

    async def sleep(seconds):
        state.sleeps.append(seconds)

    state.sleep = sleep
    return state


@pytest.fixture
def settings():
    return SimpleNamespace(assistant_actions_enabled=True, power_protected_outlets="none",
                           assistant_action_cycle_off_seconds=5.5,
                           assistant_action_restore_stagger_seconds=2.5)


def impact(pdus=("pdu-one", "pdu-two")):
    return {"pdus": list(pdus), "targets": [
        {"pdu_id": pdu_id, "pdu_name": pdu_id.upper(), "rack": "R1", "outlet": index,
         "label": "SERVER1", "server": "SERVER1", "state": "on"}
        for index, pdu_id in enumerate(pdus, 1)],
        "excluded": [], "servers": ["SERVER1"],
        "pins": {pdu_id: {"on": [1, 2, 3], "ip": SECRET} for pdu_id in pdus}}


@pytest.fixture
def proposal(sessions):
    counter = 0

    async def create(kind, *, snapshot=None, request=None, restore_of=None, status="executing", down=()):
        nonlocal counter
        counter += 1
        proposal_id = f"proposal-{counter}"
        async with sessions() as db:
            db.add(AssistantActionProposal(
                id=proposal_id, created_at=time.time(), expires_at=time.time() + 300,
                owner_key="operator-id", created_by="operator", kind=kind, status=status,
                request_json=json.dumps(request or {"kind": kind, "reason": "Planned work"}),
                impact_json=json.dumps(impact() if snapshot is None else snapshot), restore_of=restore_of,
                batch_down_json=json.dumps([item if isinstance(item, dict) else
                                           {"pdu_id": item, "started_at": 1.0} for item in down])))
            await db.commit()
        return proposal_id

    return create


def batch_ids(value):
    entries = json.loads(value) if isinstance(value, str) else value
    assert all(isinstance(item, dict) and set(item) == {"pdu_id", "started_at"} for item in entries)
    return [item["pdu_id"] for item in entries]


async def read(sessions, proposal_id):
    async with sessions() as db:
        row = await db.get(AssistantActionProposal, proposal_id)
        events = (await db.scalars(select(AssistantActionEvent).where(
            AssistantActionEvent.proposal_id == proposal_id).order_by(AssistantActionEvent.id))).all()
        return row, events


async def run(proposal_id, sessions, settings, fake):
    return await runner.execute(proposal_id, "operator", session_factory=sessions, settings=settings, sleep=fake.sleep)


async def seed_maintenance(sessions, *ids):
    async with sessions() as db:
        for pdu_id in ids:
            db.add(PduMaintenance(device_id=pdu_id, started_at=1, started_by="operator", reason="Planned work",
                                  outlets_off_json="[1]", failed_json="[]"))
        await db.commit()


@pytest.mark.parametrize("kind,action", [("server_off", "off"), ("server_on", "on"),
                                         ("outlet_off", "off"), ("outlet_on", "on")])
async def test_power_kinds_audit_and_progress(kind, action, sessions, proposal, settings, fake):
    pid = await proposal(kind)
    result = await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == "succeeded" and row.finished_at
    assert fake.calls[0][:3] == ("switch", action, "operator")
    assert [t["state_after"] for t in result["targets"]] == [action, action]
    assert json.loads(row.result_json) == result
    assert fake.progress == [(pid, 0, 2), (pid, 1, 2), (pid, 2, 2)]
    assert [e.event for e in events] == ["executing", "target", "target", "finished"]
    assert {e.actor for e in events} == {"operator"}
    assert SECRET not in json.dumps(result) + "".join(e.detail_json for e in events)


@pytest.mark.parametrize("kind", ["server_cycle", "outlet_cycle"])
async def test_cycle_console_uses_canonical_server(kind, sessions, proposal, settings, fake):
    pid = await proposal(kind, request={"kind": kind, "then_console": True, "server": None})
    result = await run(pid, sessions, settings, fake)
    assert fake.calls[0][:3] == ("cycle", 5.5, "operator")
    assert fake.sleeps == [5.5]
    assert fake.console_servers == ["SERVER1"]
    assert result["consoles"][0]["console_url"] == "/api/kvms/kvm-one/autologin?port=3"
    assert (await read(sessions, pid))[0].status == "succeeded"


@pytest.mark.parametrize("results,status", [
    ([TargetResult("pdu-one", 1, True, "on"), TargetResult("pdu-two", 2, False, "off")], "partial"),
    ([TargetResult("pdu-one", 1, False, "unknown"), TargetResult("pdu-two", 2, False, "off")], "failed"),
])
async def test_unverified_power_is_not_success(results, status, sessions, proposal, settings, fake):
    fake.power_results = results
    pid = await proposal("server_cycle", request={"then_console": True})
    result = await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == status
    assert not result["consoles"] and not fake.console_servers


@pytest.mark.parametrize("callbacks", [True, False])
async def test_callback_and_return_results_count_once(callbacks, sessions, proposal, settings, fake):
    fake.callbacks, fake.duplicates = callbacks, True
    pid = await proposal("server_on")
    result = await run(pid, sessions, settings, fake)
    assert len(result["targets"]) == 2
    assert fake.progress == [(pid, 0, 2), (pid, 1, 2), (pid, 2, 2)]


async def test_missing_power_result_fails_that_target(sessions, proposal, settings, fake):
    fake.power_results = [TargetResult("pdu-one", 1, True, "on")]
    pid = await proposal("server_on")
    result = await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == "partial"
    assert result["targets"][1]["ok"] is False and result["targets"][1]["state_after"] == "unknown"
    assert fake.progress[-1] == (pid, 2, 2)


@pytest.mark.parametrize("kind", ["pdu_shutdown", "rack_shutdown", "lab_shutdown"])
async def test_shutdown_pins_protection_and_atomic_batch(kind, sessions, proposal, settings, fake):
    snapshot = impact()
    snapshot["excluded"] = [
        {"pdu_id": "pdu-one", "pdu_name": "PDU-ONE", "outlet": 3, "reason": "protected"},
        {"pdu_id": "pdu-one", "pdu_name": "PDU-ONE", "outlet": 2, "reason": "already_off"},
        {"pdu_id": "pdu-two", "pdu_name": "PDU-TWO", "outlet": 8, "reason": "protected"}]
    pid = await proposal(kind, snapshot=snapshot)
    result = await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == "succeeded" and all(item["ok"] for item in result["pdus"])
    assert fake.calls == [
        ("shutdown", "pdu-one", "operator", "Planned work", frozenset({3}), frozenset({1, 2, 3})),
        ("shutdown", "pdu-two", "operator", "Planned work", frozenset({8}), frozenset({1, 2, 3}))]
    assert batch_ids(row.batch_down_json) == ["pdu-one", "pdu-two"]
    assert batch_ids(fake.observed_batches[0][pid]) == ["pdu-one"]
    assert batch_ids(fake.observed_batches[1][pid]) == ["pdu-one", "pdu-two"]
    assert fake.progress == [(pid, 0, 2), (pid, 1, 2), (pid, 2, 2)]
    assert [e.event for e in events] == ["executing", "pdu", "pdu", "finished"] and not fake.sleeps


@pytest.mark.parametrize("success", [True, False])
async def test_partial_shutdown_is_restorable(success, sessions, proposal, settings, fake):
    fake.payloads["pdu-one"] = {
        "state": {"outlets_off": [1, 2], "failed": [2] if success else [1, 2]},
        "results": [{"outlet": 1, "ok": success}, {"outlet": 2, "ok": False}]}
    pid = await proposal("pdu_shutdown", snapshot=impact(("pdu-one",)))
    result = await run(pid, sessions, settings, fake)
    row, _ = await read(sessions, pid)
    assert row.status == ("partial" if success else "failed")
    assert result["pdus"][0]["ok"] is False
    assert batch_ids(row.batch_down_json) == ["pdu-one"]


@pytest.mark.parametrize("error_type", [MaintenanceConflict, MaintenanceDrift])
async def test_expected_maintenance_failures_continue(error_type, sessions, proposal, settings, fake):
    fake.errors["pdu-one"] = error_type(SECRET)
    pid = await proposal("lab_shutdown")
    result = await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == "partial"
    assert batch_ids(row.batch_down_json) == ["pdu-two"]
    assert len(result["pdus"]) == 2 and fake.progress[-1] == (pid, 2, 2)
    assert SECRET not in json.dumps(result) + "".join(e.detail_json for e in events)


async def test_does_not_adopt_existing_maintenance(sessions, proposal, settings, fake):
    await seed_maintenance(sessions, "pdu-one")
    pid = await proposal("lab_shutdown")
    await run(pid, sessions, settings, fake)
    row, _ = await read(sessions, pid)
    assert batch_ids(row.batch_down_json) == ["pdu-two"]


@pytest.mark.parametrize("kind", ["pdu_restore", "batch_restore"])
async def test_restore_removes_only_original_members_with_stagger(kind, sessions, proposal, settings, fake):
    original = await proposal("lab_shutdown", status="partial", down=("pdu-one", "pdu-two", "pdu-other"))
    unrelated = await proposal("rack_shutdown", status="succeeded", down=("pdu-unrelated",))
    await seed_maintenance(sessions, "pdu-one", "pdu-two", "pdu-other", "pdu-unrelated")
    pid = await proposal(kind, restore_of=original)
    result = await run(pid, sessions, settings, fake)
    assert fake.calls == [("restore", "pdu-one", "operator"), ("restore", "pdu-two", "operator")]
    assert fake.sleeps == [2.5]
    assert (await read(sessions, pid))[0].status == "succeeded"
    assert batch_ids((await read(sessions, original))[0].batch_down_json) == ["pdu-other"]
    assert batch_ids((await read(sessions, unrelated))[0].batch_down_json) == ["pdu-unrelated"]
    assert batch_ids(fake.observed_batches[0][original]) == ["pdu-two", "pdu-other"]
    assert all(item["ok"] for item in result["pdus"])


async def test_single_restore_has_no_stagger(sessions, proposal, settings, fake):
    await seed_maintenance(sessions, "pdu-one")
    pid = await proposal("pdu_restore", snapshot=impact(("pdu-one",)))
    await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == "succeeded" and not fake.sleeps


async def test_single_restore_clears_original_batch_without_restore_of(sessions, proposal, settings, fake):
    original = await proposal("rack_shutdown", status="partial", down=("pdu-one", "pdu-two"))
    await seed_maintenance(sessions, "pdu-one", "pdu-two")
    pid = await proposal("pdu_restore", snapshot=impact(("pdu-one",)))
    await run(pid, sessions, settings, fake)
    assert batch_ids((await read(sessions, original))[0].batch_down_json) == ["pdu-two"]
    assert batch_ids(fake.observed_batches[0][original]) == ["pdu-two"]
    # A new, independent maintenance session must not be adopted by the old batch.
    await seed_maintenance(sessions, "pdu-one")
    fake.calls.clear()
    stale = await proposal("batch_restore", restore_of=original, snapshot=impact(("pdu-one",)))
    await run(stale, sessions, settings, fake)
    assert not fake.calls and (await read(sessions, stale))[0].status == "failed"


async def test_concurrent_single_restores_preserve_batch_updates(monkeypatch, sessions, proposal, fake):
    original = await proposal("rack_shutdown", status="partial", down=("pdu-one", "pdu-two"))
    await seed_maintenance(sessions, "pdu-one", "pdu-two")
    first = await proposal("pdu_restore", snapshot=impact(("pdu-one",)))
    second = await proposal("pdu_restore", snapshot=impact(("pdu-two",)))
    entered, second_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    restore = pdu_maintenance.restore_pdu

    async def slow_restore(db, pdu_id, by):
        if pdu_id == "pdu-one":
            entered.set()
            await release.wait()
        else:
            second_entered.set()
        return await restore(db, pdu_id, by)

    monkeypatch.setattr(pdu_maintenance, "restore_pdu", slow_restore)
    first_task = asyncio.create_task(runner._maintenance_one(
        sessions, first, "operator", "pdu-one", "PDU-ONE", {}, impact(("pdu-one",)), down=False))
    await asyncio.wait_for(entered.wait(), 1)
    second_task = asyncio.create_task(runner._maintenance_one(
        sessions, second, "operator", "pdu-two", "PDU-TWO", {}, impact(("pdu-two",)), down=False))
    try:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(second_entered.wait(), 0.05)
    finally:
        release.set()
        outcomes = await asyncio.wait_for(asyncio.gather(first_task, second_task), 2)
    assert all(outcome.ok for outcome in outcomes)
    assert batch_ids((await read(sessions, original))[0].batch_down_json) == []


async def test_partial_restore_stays_retryable(sessions, proposal, settings, fake):
    original = await proposal("rack_shutdown", status="partial", down=("pdu-one", "pdu-two"))
    await seed_maintenance(sessions, "pdu-one", "pdu-two")
    fake.payloads["pdu-two"] = {"state": {"failed": [2]},
                                "results": [{"outlet": 1, "ok": True}, {"outlet": 2, "ok": False}]}
    pid = await proposal("batch_restore", restore_of=original)
    await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == "partial"
    assert batch_ids((await read(sessions, original))[0].batch_down_json) == ["pdu-two"]
    fake.payloads.clear()
    retry = await proposal("batch_restore", restore_of=original, snapshot=impact(("pdu-two",)))
    await run(retry, sessions, settings, fake)
    assert (await read(sessions, retry))[0].status == "succeeded"
    assert batch_ids((await read(sessions, original))[0].batch_down_json) == []


async def test_restore_rejects_pdu_outside_batch(sessions, proposal, settings, fake):
    original = await proposal("lab_shutdown", status="partial", down=("pdu-one",))
    await seed_maintenance(sessions, "pdu-one", "pdu-two")
    pid = await proposal("batch_restore", restore_of=original)
    result = await run(pid, sessions, settings, fake)
    assert fake.calls == [("restore", "pdu-one", "operator")]
    assert result["pdus"][1]["error"] == "PDU is not in the shutdown batch"
    async with sessions() as db:
        assert await db.get(PduMaintenance, "pdu-two") is not None


async def test_unexpected_power_error_is_fixed_and_preserves_progress(sessions, proposal, settings, fake):
    fake.power_error = RuntimeError(SECRET)
    pid = await proposal("server_on")
    result = await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == "failed" and len(result["targets"]) == 1
    assert row.progress_done == 1 and events[-1].event == "finished"
    assert SECRET not in row.result_json + "".join(e.detail_json for e in events)


async def test_cancelled_cycle_is_interrupted_and_audited(sessions, proposal, settings, fake):
    fake.power_error = asyncio.CancelledError()
    pid = await proposal("server_cycle")
    result = await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == "interrupted" and row.finished_at
    assert len(result["targets"]) == 1 and events[-1].event == "interrupted"


async def test_cancelled_shutdown_retains_restore_path(sessions, proposal, settings, fake):
    fake.after_commit_error = asyncio.CancelledError()
    pid = await proposal("lab_shutdown")
    await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == "interrupted" and batch_ids(row.batch_down_json) == ["pdu-one"]
    assert events[-1].event == "interrupted"


async def test_exception_after_shutdown_commit_keeps_batch(sessions, proposal, settings, fake):
    fake.after_commit_error = RuntimeError(SECRET)
    pid = await proposal("lab_shutdown")
    await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == "failed" and batch_ids(row.batch_down_json) == ["pdu-one"]
    assert batch_ids(fake.observed_batches[0][pid]) == ["pdu-one"]
    assert len(fake.calls) == 1 and events[-1].event == "finished"
    assert SECRET not in row.result_json + "".join(e.detail_json for e in events)


async def test_shutdown_rollback_does_not_adopt_pdu(sessions, proposal, settings, fake):
    fake.before_commit_error = RuntimeError(SECRET)
    pid = await proposal("lab_shutdown")
    await run(pid, sessions, settings, fake)
    row, _ = await read(sessions, pid)
    assert row.status == "failed" and batch_ids(row.batch_down_json) == []
    async with sessions() as db:
        assert await db.get(PduMaintenance, "pdu-one") is None


async def test_exception_after_restore_commit_keeps_member_removed(sessions, proposal, settings, fake):
    original = await proposal("lab_shutdown", status="partial", down=("pdu-one", "pdu-two"))
    await seed_maintenance(sessions, "pdu-one", "pdu-two")
    fake.after_commit_error = RuntimeError(SECRET)
    pid = await proposal("batch_restore", restore_of=original)
    await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == "failed"
    assert batch_ids((await read(sessions, original))[0].batch_down_json) == ["pdu-two"]
    assert batch_ids(fake.observed_batches[0][original]) == ["pdu-two"]


async def test_open_console_never_switches(sessions, proposal, settings, fake):
    snapshot = impact(())
    snapshot["consoles"] = [{"kvm_id": "kvm", "port": 1, "console_url": "/api/kvms/kvm/autologin?port=1"}]
    pid = await proposal("open_console", snapshot=snapshot)
    result = await run(pid, sessions, settings, fake)
    assert result["consoles"] == snapshot["consoles"] and not fake.calls
    assert (await read(sessions, pid))[0].status == "succeeded"


@pytest.mark.parametrize("status", ["pending", "cancelled", "succeeded", "interrupted", "ready"])
async def test_unclaimed_or_final_proposals_do_not_run(status, sessions, proposal, settings, fake):
    pid = await proposal("server_off", status=status)
    await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == status and not fake.calls
    assert (await read(sessions, pid))[1] == []


async def test_missing_proposal_does_not_run(sessions, settings, fake):
    await run("missing", sessions, settings, fake)
    assert not fake.calls


async def test_finish_database_failure_does_not_escape(monkeypatch, sessions, proposal, settings, fake):
    async def broken(*args):
        raise RuntimeError(SECRET)

    monkeypatch.setattr(runner, "_finish", broken)
    pid = await proposal("server_on")
    result = await run(pid, sessions, settings, fake)
    assert SECRET not in json.dumps(result)
    assert (await read(sessions, pid))[0].status == "executing"


async def test_recovery_marks_only_executing_and_preserves_restore_path(sessions, proposal, fake):
    first = await proposal("lab_shutdown", down=("pdu-one",))
    second = await proposal("server_on")
    done = await proposal("server_off", status="succeeded")
    pending = await proposal("server_off", status="pending")
    assert await runner.recover_interrupted(sessions) == 2
    assert await runner.recover_interrupted(sessions) == 0
    for pid in (first, second):
        row, events = await read(sessions, pid)
        assert row.status == "interrupted" and row.finished_at
        assert [(e.event, e.actor) for e in events] == [("interrupted", "system")]
    assert batch_ids((await read(sessions, first))[0].batch_down_json) == ["pdu-one"]
    assert (await read(sessions, done))[0].status == "succeeded"
    assert (await read(sessions, pending))[0].status == "pending"
    assert not fake.calls


@pytest.mark.parametrize("lost_response", [False, True])
async def test_real_store_and_maintenance_with_fake_driver(
        lost_response, monkeypatch, sessions, proposal, settings, fake):
    if fake.real_store is None or fake.real_shutdown is None or fake.real_restore is None:
        pytest.skip("ACT-3/ACT-5 modules have not landed yet")
    from app import pdu_locks
    from app.routers import pdus
    from tests.test_pdu_maintenance import FakePdu

    monkeypatch.setattr(actions, "store", fake.real_store)
    monkeypatch.setitem(sys.modules, "app.assistant.actions.store", fake.real_store)
    monkeypatch.setattr(pdu_maintenance, "shutdown_pdu", fake.real_shutdown)
    monkeypatch.setattr(pdu_maintenance, "restore_pdu", fake.real_restore)
    driver = FakePdu({1: "on", 2: "off", 3: "on"})
    if lost_response:
        driver.lost = {1}
    monkeypatch.setattr(pdus, "RaritanPduDriver", driver)
    monkeypatch.setattr(pdus, "get_creds", lambda dev: ("fake-user", "fake-password"))
    pdu_locks._locks.clear()
    async with sessions() as db:
        db.add(Device(id="pdu-one", name="PDU-ONE", kind="pdu", ip="pdu.example.invalid", port_count=3))
        await db.commit()
    snapshot = impact(("pdu-one",))
    snapshot["excluded"] = [{"pdu_id": "pdu-one", "pdu_name": "PDU-ONE", "outlet": 3,
                              "reason": "protected"}]
    original = await proposal("lab_shutdown", snapshot=snapshot)
    await run(original, sessions, settings, fake)
    row, events = await read(sessions, original)
    assert row.status == "succeeded" and batch_ids(row.batch_down_json) == ["pdu-one"]
    assert [e.event for e in events] == ["executing", "pdu", "finished"]
    assert driver.calls == [(1, "off")] and driver.states[3] == "on"
    restore = await proposal("batch_restore", restore_of=original, snapshot=snapshot)
    await run(restore, sessions, settings, fake)
    assert (await read(sessions, restore))[0].status == "succeeded"
    assert batch_ids((await read(sessions, original))[0].batch_down_json) == []
    assert driver.calls == [(1, "off"), (1, "on")]
    async with sessions() as db:
        assert await db.get(PduMaintenance, "pdu-one") is None
        logs = (await db.scalars(select(PduMaintenanceLog).order_by(PduMaintenanceLog.id))).all()
        assert [(entry.action, entry.by) for entry in logs] == [("shutdown", "operator"), ("restore", "operator")]
    pdu_locks._locks.clear()


async def test_recovery_with_real_store(monkeypatch, sessions, proposal, fake):
    if fake.real_store is None:
        pytest.skip("ACT-5 store has not landed yet")
    monkeypatch.setattr(actions, "store", fake.real_store)
    monkeypatch.setitem(sys.modules, "app.assistant.actions.store", fake.real_store)
    pid = await proposal("lab_shutdown", down=("pdu-one",))
    assert await runner.recover_interrupted(sessions) == 1
    row, events = await read(sessions, pid)
    assert row.status == "interrupted" and batch_ids(row.batch_down_json) == ["pdu-one"]
    assert [e.event for e in events] == ["interrupted"]


@pytest.mark.parametrize("operation", ["execute", "recover"])
async def test_final_audit_is_present_at_real_store_commit(
        operation, monkeypatch, sessions, proposal, settings, fake):
    if fake.real_store is None:
        pytest.skip("ACT-5 store has not landed yet")
    monkeypatch.setattr(actions, "store", fake.real_store)
    monkeypatch.setitem(sys.modules, "app.assistant.actions.store", fake.real_store)
    real_finish = fake.real_store.finish
    committed_events = []

    async def finish(db, proposal_id, status, result):
        await real_finish(db, proposal_id, status, result)
        # Observe the commit boundary, rather than the runner's later return.
        async with sessions() as observer:
            names = (await observer.scalars(select(AssistantActionEvent.event).where(
                AssistantActionEvent.proposal_id == proposal_id))).all()
            committed_events.append(list(names))

    monkeypatch.setattr(fake.real_store, "finish", finish)
    pid = await proposal("server_on")
    if operation == "execute":
        await run(pid, sessions, settings, fake)
        assert (await read(sessions, pid))[0].status == "succeeded"
        assert committed_events == [["executing", "target", "target", "finished"]]
    else:
        assert await runner.recover_interrupted(sessions) == 1
        assert committed_events == [["interrupted"]]


async def test_background_tasks_are_retained_serialized_and_discarded(monkeypatch, sessions, settings, fake):
    entered, release = asyncio.Event(), asyncio.Event()
    order = []

    async def execute(pid, by, **kwargs):
        order.append((pid, "start", runner.BATCH_LOCK.locked()))
        entered.set()
        await release.wait()
        order.append((pid, "end", runner.BATCH_LOCK.locked()))

    monkeypatch.setattr(runner, "execute", execute)
    runner.start_background("first", "operator", session_factory=sessions, settings=settings)
    runner.start_background("second", "operator", session_factory=sessions, settings=settings)
    tasks = list(runner._tasks)
    try:
        await asyncio.wait_for(entered.wait(), 1)
        await asyncio.sleep(0)
        assert len(tasks) == 2 and order == [("first", "start", True)]
    finally:
        release.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 1)
    await asyncio.sleep(0)
    assert order == [("first", "start", True), ("first", "end", True),
                     ("second", "start", True), ("second", "end", True)]
    assert not runner._tasks and not runner.BATCH_LOCK.locked()


async def save_journal(sessions, pid, result, *, confirmed_at=None):
    async with sessions() as db:
        row = await db.get(AssistantActionProposal, pid)
        row.result_json = json.dumps(result)
        row.confirmed_at = confirmed_at
        await db.commit()


async def test_cycle_journal_and_executing_event_precede_first_hardware(
        monkeypatch, sessions, proposal, settings, fake):
    snapshot = impact()
    snapshot["targets"][1]["state"] = "off"
    pid = await proposal("server_cycle", snapshot=snapshot)
    cycle = actions.power.cycle

    async def inspect(*args, **kwargs):
        row, events = await read(sessions, pid)
        journal = json.loads(row.result_json)
        assert journal["pending_on"] == [snapshot["targets"][0]]
        assert journal["pending_on_at"] <= time.time()
        assert [e.event for e in events] == ["executing"]
        return await cycle(*args, **kwargs)

    monkeypatch.setattr(actions.power, "cycle", inspect)
    result = await run(pid, sessions, settings, fake)
    assert result["pending_on"] == []
    assert [target["state_after"] for target in result["targets"]] == ["on", "off"]


async def test_cycle_clears_verified_on_even_when_cycle_failed(sessions, proposal, settings, fake):
    fake.power_results = [TargetResult("pdu-one", 1, False, "on"),
                          TargetResult("pdu-two", 2, False, "unknown")]
    pid = await proposal("server_cycle")
    result = await run(pid, sessions, settings, fake)
    assert [(item["pdu_id"], item["outlet"]) for item in result["pending_on"]] == [("pdu-two", 2)]
    assert (await read(sessions, pid))[0].status == "failed"


@pytest.mark.parametrize("age,restore", [(0, True), (599.9, True), (600, False), (600.1, False),
                                        (-1, False), (None, False), (float("nan"), False), (float("inf"), False)])
async def test_cycle_recovery_age_and_original_on_targets(
        age, restore, monkeypatch, sessions, proposal, fake):
    now = 1000.0
    monkeypatch.setattr(runner, "time", SimpleNamespace(time=lambda: now))
    snapshot = impact()
    snapshot["targets"][1]["state"] = "off"
    pid = await proposal("server_cycle", snapshot=snapshot)
    journal = {"targets": [], "pdus": [], "consoles": [],
               "pending_on_at": None if age is None else now - age,
               "pending_on": snapshot["targets"] + [{"pdu_id": "foreign", "outlet": 8}]}
    await save_journal(sessions, pid, journal)
    assert await runner.recover_interrupted(sessions) == 1
    row, _ = await read(sessions, pid)
    assert row.status == "interrupted"
    if restore:
        assert len(fake.calls) == 1 and fake.calls[0][:3] == ("switch", "on", "system")
        assert [(t.pdu_id, t.outlet) for t in fake.calls[0][3]] == [("pdu-one", 1)]
        assert json.loads(row.result_json)["pending_on"] == []
    else:
        assert not fake.calls
    assert await runner.recover_interrupted(sessions) == 0


async def test_recovery_uses_confirmation_time_when_journal_has_no_timestamp(
        monkeypatch, sessions, proposal, fake):
    monkeypatch.setattr(runner, "time", SimpleNamespace(time=lambda: 1000.0))
    pid = await proposal("server_cycle", snapshot=impact(("pdu-one",)))
    await save_journal(sessions, pid, {"pending_on": impact(("pdu-one",))["targets"]}, confirmed_at=999.0)
    assert await runner.recover_interrupted(sessions) == 1
    assert fake.calls[0][:3] == ("switch", "on", "system")


async def test_recovery_journal_is_updated_before_finish_and_retries_only_pending(
        monkeypatch, sessions, proposal, fake):
    pid = await proposal("server_cycle")
    await save_journal(sessions, pid, {"pending_on_at": time.time(), "pending_on": impact()["targets"]})
    fake.power_results = [TargetResult("pdu-one", 1, True, "on"),
                          TargetResult("pdu-two", 2, False, "unknown")]
    finish = runner._finish

    async def crash(*args):
        raise RuntimeError(SECRET)

    monkeypatch.setattr(runner, "_finish", crash)
    with pytest.raises(RuntimeError):
        await runner.recover_interrupted(sessions)
    row, _ = await read(sessions, pid)
    assert row.status == "executing"
    assert [item["pdu_id"] for item in json.loads(row.result_json)["pending_on"]] == ["pdu-two"]
    monkeypatch.setattr(runner, "_finish", finish)
    fake.power_results = None
    await runner.recover_interrupted(sessions)
    assert [(t.pdu_id, t.outlet) for t in fake.calls[1][3]] == [("pdu-two", 2)]
    assert json.loads((await read(sessions, pid))[0].result_json)["pending_on"] == []


@pytest.mark.parametrize("kind", ["lab_shutdown", "server_on"])
async def test_recovery_never_uses_pending_journal_for_other_kinds(kind, sessions, proposal, fake):
    pid = await proposal(kind)
    await save_journal(sessions, pid, {"pending_on_at": time.time(), "pending_on": impact()["targets"]})
    await runner.recover_interrupted(sessions)
    assert not fake.calls


async def test_recovery_power_error_is_fixed_and_other_rows_are_recovered(sessions, proposal, fake):
    first = await proposal("server_cycle")
    second = await proposal("server_off")
    await save_journal(sessions, first, {"pending_on_at": time.time(), "pending_on": impact()["targets"]})
    fake.power_error = RuntimeError(SECRET)
    assert await runner.recover_interrupted(sessions) == 2
    assert (await read(sessions, first))[0].status == "interrupted"
    assert (await read(sessions, second))[0].status == "interrupted"
    assert SECRET not in (await read(sessions, first))[0].result_json


async def test_shutdown_batch_uses_returned_generation_atomically(sessions, proposal, settings, fake):
    fake.payloads["pdu-one"] = {"state": {"started_at": 1234.567, "outlets_off": [1], "failed": []},
                                "results": [{"outlet": 1, "ok": True}], "not_included": [2, 3]}
    pid = await proposal("lab_shutdown", snapshot=impact(("pdu-one",)))
    result = await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    expected = [{"pdu_id": "pdu-one", "started_at": 1234.567}]
    assert json.loads(row.batch_down_json) == expected
    assert fake.observed_batches[0][pid] == expected
    assert result["pdus"][0]["not_included"] == [2, 3]
    assert json.loads(next(e.detail_json for e in events if e.event == "pdu"))["not_included"] == [2, 3]


@pytest.mark.parametrize("legacy", [True, False])
async def test_restore_rejects_legacy_or_replaced_maintenance_generation(
        legacy, sessions, proposal, settings, fake):
    original = await proposal("lab_shutdown", status="partial", down=("pdu-one",))
    await seed_maintenance(sessions, "pdu-one")
    async with sessions() as db:
        if legacy:
            row = await db.get(AssistantActionProposal, original)
            row.batch_down_json = '["pdu-one"]'
        else:
            row = await db.get(PduMaintenance, "pdu-one")
            row.started_at = 2.0
        await db.commit()
    pid = await proposal("batch_restore", restore_of=original, snapshot=impact(("pdu-one",)))
    await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == "failed" and not fake.calls
    async with sessions() as db:
        assert await db.get(PduMaintenance, "pdu-one") is not None


async def test_restore_rechecks_generation_inside_maintenance_audit_flush(
        monkeypatch, sessions, proposal, settings, fake):
    original = await proposal("lab_shutdown", status="partial", down=("pdu-one",))
    await seed_maintenance(sessions, "pdu-one")
    pid = await proposal("batch_restore", restore_of=original, snapshot=impact(("pdu-one",)))
    switched = []

    async def replace_before_lock(db, device_id, by):
        await db.execute(update(PduMaintenance).where(PduMaintenance.device_id == device_id)
                         .values(started_at=2.0).execution_options(synchronize_session=False))
        await db.commit()
        await db.get(PduMaintenance, device_id, populate_existing=True)
        db.add(PduMaintenanceLog(at=time.time(), device_id=device_id, action="restore", by=by,
                                 reason="", ok=0, failed=0))
        await db.flush()  # ACT-3 does this under the PDU lock before its switch.
        switched.append(device_id)
        return {"state": None, "results": []}

    monkeypatch.setattr(pdu_maintenance, "restore_pdu", replace_before_lock)
    await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == "failed" and not switched
    assert json.loads((await read(sessions, original))[0].batch_down_json) == [
        {"pdu_id": "pdu-one", "started_at": 1.0}]


@pytest.mark.parametrize("failed_index", [0, 1])
async def test_unavailable_pdu_aborts_and_remaining_pdus_are_untouched(
        failed_index, sessions, proposal, settings, fake):
    ids = ("pdu-one", "pdu-two", "pdu-three")
    failed_id = ids[failed_index]
    fake.errors[failed_id] = MaintenanceUnavailable(SECRET)
    pid = await proposal("lab_shutdown", snapshot=impact(ids))
    result = await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == ("failed" if failed_index == 0 else "partial")
    assert [call[1] for call in fake.calls] == list(ids[:failed_index + 1])
    assert result["aborted"] == {"reason": "unreachable", "pdu_id": failed_id, "pdu_name": failed_id.upper()}
    assert [e.event for e in events].count("aborted") == 1
    assert batch_ids(row.batch_down_json) == list(ids[:failed_index])
    assert row.progress_done == failed_index + 1 and row.progress_total == 3
    async with sessions() as db:
        assert await db.get(PduMaintenance, "pdu-three") is None
    assert SECRET not in row.result_json + "".join(e.detail_json for e in events)


@pytest.mark.parametrize("indicator", [{"unreachable": True}, {"reachable": False}])
async def test_unreachable_shutdown_payload_also_aborts(indicator, sessions, proposal, settings, fake):
    fake.payloads["pdu-one"] = {"state": {"outlets_off": [1], "failed": [1]},
                                "results": [{"outlet": 1, "ok": False}], **indicator}
    pid = await proposal("lab_shutdown")
    result = await run(pid, sessions, settings, fake)
    assert result["aborted"]["reason"] == "unreachable" and len(fake.calls) == 1
    assert batch_ids((await read(sessions, pid))[0].batch_down_json) == ["pdu-one"]


async def test_flag_off_after_current_pdu_stops_next_pdu(monkeypatch, sessions, proposal, settings, fake):
    shutdown = pdu_maintenance.shutdown_pdu

    async def disable(*args, **kwargs):
        payload = await shutdown(*args, **kwargs)
        settings.assistant_actions_enabled = False
        return payload

    monkeypatch.setattr(pdu_maintenance, "shutdown_pdu", disable)
    pid = await proposal("lab_shutdown")
    result = await run(pid, sessions, settings, fake)
    row, events = await read(sessions, pid)
    assert row.status == "partial" and row.progress_done == 1
    assert len(fake.calls) == 1 and result["aborted"]["reason"] == "flag_off"
    assert result["aborted"]["pdu_id"] == "pdu-two" and events[-2].event == "aborted"


async def test_flag_off_during_restore_stagger_stops_next_pdu(sessions, proposal, settings, fake):
    original = await proposal("lab_shutdown", status="partial", down=("pdu-one", "pdu-two"))
    await seed_maintenance(sessions, "pdu-one", "pdu-two")
    pid = await proposal("batch_restore", restore_of=original)

    async def disable(seconds):
        fake.sleeps.append(seconds)
        settings.assistant_actions_enabled = False

    result = await runner.execute(pid, "operator", session_factory=sessions, settings=settings, sleep=disable)
    assert result["aborted"]["reason"] == "flag_off" and fake.sleeps == [2.5]
    assert fake.calls == [("restore", "pdu-one", "operator")]
    assert batch_ids((await read(sessions, original))[0].batch_down_json) == ["pdu-two"]


@pytest.mark.parametrize("raw,aborted,exclude", [("pdu-one:1", False, {1}), ("missing:1", True, set()),
                                               ("", True, set())])
async def test_runner_loads_shared_protection_module(
        raw, aborted, exclude, monkeypatch, sessions, proposal, settings, fake):
    monkeypatch.setattr(power_protection, "load", fake.real_protection_load)
    settings.power_protected_outlets = raw
    async with sessions() as db:
        db.add(Device(id="pdu-one", name="PDU-ONE", kind="pdu", ip="pdu.example.invalid", port_count=4))
        await db.commit()
    pid = await proposal("lab_shutdown", snapshot=impact(("pdu-one",)))
    result = await run(pid, sessions, settings, fake)
    if aborted:
        assert result["aborted"]["reason"] == "error" and not fake.calls
    else:
        assert fake.calls[0][4] == frozenset(exclude)


async def test_minimal_settings_use_defaults(sessions, proposal, fake):
    settings = SimpleNamespace(assistant_actions_enabled=True)
    pid = await proposal("server_cycle")
    await run(pid, sessions, settings, fake)
    assert fake.calls[0][:2] == ("cycle", 5.0)
    missing_flag = await proposal("lab_shutdown")
    result = await run(missing_flag, sessions, SimpleNamespace(), fake)
    assert result["aborted"]["reason"] == "flag_off"


async def test_interrupted_cycle_retries_unverified_pending_on_next_startup(sessions, proposal, fake):
    pid = await proposal("server_cycle", snapshot=impact(("pdu-one",)))
    await save_journal(sessions, pid, {"pending_on_at": time.time(),
                                     "pending_on": impact(("pdu-one",))["targets"]})
    fake.power_results = [TargetResult("pdu-one", 1, False, "unknown")]
    assert await runner.recover_interrupted(sessions) == 1
    assert (await read(sessions, pid))[0].status == "interrupted"
    assert json.loads((await read(sessions, pid))[0].result_json)["pending_on"]
    fake.power_results = None
    assert await runner.recover_interrupted(sessions) == 1
    assert json.loads((await read(sessions, pid))[0].result_json)["pending_on"] == []
    assert await runner.recover_interrupted(sessions) == 0


async def test_single_restore_refuses_replaced_pinned_generation(sessions, proposal, settings, fake):
    await seed_maintenance(sessions, "pdu-one")
    snapshot = impact(("pdu-one",))
    snapshot["pins"]["pdu-one"]["maintenance_started_at"] = 0.5
    pid = await proposal("pdu_restore", snapshot=snapshot)
    await run(pid, sessions, settings, fake)
    assert (await read(sessions, pid))[0].status == "failed" and not fake.calls


async def test_real_maintenance_lost_verification_aborts_remaining_pdus(
        monkeypatch, sessions, proposal, settings, fake):
    from app import pdu_locks
    from app.routers import pdus
    from tests.test_pdu_maintenance import FakePdu

    monkeypatch.setattr(pdu_maintenance, "shutdown_pdu", fake.real_shutdown)
    monkeypatch.setattr(runner, "_probe_reachable", fake.real_probe)
    driver = FakePdu({1: "on"})
    driver.side_effects[1] = lambda: setattr(driver, "unreachable", True)
    monkeypatch.setattr(pdus, "RaritanPduDriver", driver)
    monkeypatch.setattr(pdus, "get_creds", lambda dev: ("fake-user", "fake-password"))
    pdu_locks._locks.clear()
    async with sessions() as db:
        for pdu_id in ("pdu-one", "pdu-two"):
            db.add(Device(id=pdu_id, name=pdu_id.upper(), kind="pdu", ip="pdu.example.invalid", port_count=1))
        await db.commit()
    pid = await proposal("lab_shutdown")
    result = await run(pid, sessions, settings, fake)
    assert result["aborted"] == {"reason": "unreachable", "pdu_id": "pdu-one", "pdu_name": "PDU-ONE"}
    assert driver.calls == [(1, "off")]
    async with sessions() as db:
        assert await db.get(PduMaintenance, "pdu-one") is not None
        assert await db.get(PduMaintenance, "pdu-two") is None
    assert batch_ids((await read(sessions, pid))[0].batch_down_json) == ["pdu-one"]
    pdu_locks._locks.clear()
