"""Codex ACT-CX-FINAL regressions (v2.40.0): B1 cycle drift under the PDU locks, B2 a failed verification read stops
a batch, S1 a rack named only as a location is not a rack shutdown, S2 outlet numbers come from outlet words.

Simulated PDUs only (the ACT-10 scenario fleet and the maintenance FakePdu); nothing is contacted or switched for real.
"""
import asyncio
import time

import pytest

from app import pdu_locks
from app.assistant.actions import tools
from app.assistant.contracts import Principal, ToolContext, ToolResult
from app.routers import pdu_maintenance as pm
from tests.test_assistant_actions_data import FakeStore, _Session, run_tool
from tests.test_assistant_actions_scenarios import (  # noqa: F401  (fixtures and autouse fixtures)
    created, env, execute, forbid_hardware, propose, reset_pdu_locks, row, settle, user,
)
from tests.test_pdu_maintenance import clear_maintenance_state, fake, mclient, pdu_id, settings  # noqa: F401

NOW = 1_792_300_000.0


# ---------------------------------------------------------------------------------------------------------------
# B1: the outlet changed while the cycle waited for the PDU lock -> refused, nothing switched, never turned on
# ---------------------------------------------------------------------------------------------------------------
async def test_b1_cycle_is_refused_when_the_outlet_went_off_while_waiting_for_the_lock(env):
    async with user(env, "operator") as c:
        proposal = await created(propose(c, kind="outlet_cycle", pdu="pdu1", outlet=2))
        lock = pdu_locks.maintenance_lock("pdu1")
        await lock.acquire()
        try:
            task = asyncio.create_task(execute(c, proposal["id"]))
            deadline = time.monotonic() + 10
            # The runner journals pending_on right before power.cycle waits for the lock.
            while "pending_on" not in ((await row(env, proposal["id"])).result_json or ""):
                assert time.monotonic() < deadline and not task.done(), "the cycle never reached the PDU lock"
                await asyncio.sleep(0.02)
            env.fleet["pdu1"].states[2] = "off"   # someone switched the outlet off meanwhile
        finally:
            lock.release()
        response = await task
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "refused", body
    assert [t["error"] for t in body["result"]["targets"]] == ["PDU changed since the proposal"]
    assert env.fleet.calls == [] and env.fleet["pdu1"].states[2] == "off"
    assert body["result"]["pending_on"] == []


# ---------------------------------------------------------------------------------------------------------------
# B2: a failed verification read counts as unreachable even when every target was already off (D7)
# ---------------------------------------------------------------------------------------------------------------
async def test_b2_shutdown_reports_a_failed_verification_read_as_unreachable(db_session, pdu_id, fake, monkeypatch):
    fake.states.update({1: "off", 3: "off", 4: "off"})

    async def unreadable(device_id, dev, expected, targets=()):
        return None

    monkeypatch.setattr(pm, "_not_in_state", unreadable)
    result = await pm.shutdown_pdu(db_session, pdu_id, "operator", "Rack rewiring")
    assert fake.calls == [] and result["results"] == []
    assert result["reachable"] is False


async def test_b2_batch_stops_before_the_next_pdu_when_verification_fails(env, monkeypatch):
    original = pm._not_in_state

    async def unreadable_pdu1(device_id, dev, expected, targets=()):
        if device_id == "pdu1":
            return None
        return await original(device_id, dev, expected, targets)

    monkeypatch.setattr(pm, "_not_in_state", unreadable_pdu1)
    async with user(env, "admin") as c:
        proposal = await created(propose(c, kind="rack_shutdown", rack="R1"))
        assert proposal["impact"]["pdus"][0] == "pdu1" and len(proposal["impact"]["pdus"]) > 1
        env.fleet["pdu1"].states.update({1: "off", 2: "off"})   # nothing left to switch on pdu1
        response = await execute(c, proposal["id"], phrase="R1 OFF")
        assert response.status_code == 202, response.text
        final = await settle(c, proposal["id"])
    assert final["result"]["aborted"]["reason"] == "unreachable", final["result"]
    assert final["result"]["aborted"]["pdu_id"] == "pdu1"
    later = set(proposal["impact"]["pdus"][1:])
    assert not any(device in later for device, _, _ in env.fleet.calls), env.fleet.calls
    assert final["status"] == "failed"


# ---------------------------------------------------------------------------------------------------------------
# S1 / S2: the model tool's intent anchor
# ---------------------------------------------------------------------------------------------------------------
@pytest.fixture
def fake_store(monkeypatch):
    fake_ = FakeStore(servers=["OPT11"])
    monkeypatch.setattr(tools, "store", fake_)
    return fake_


def admin_ctx(message):
    return ToolContext(principal=Principal("adm", "admin", "Admin"), session_factory=_Session,
                       settings=type("S", (), {"assistant_actions_enabled": True, "accounts_enabled": True})(),
                       now=NOW, user_message=message)


@pytest.mark.parametrize("message,args,allowed", [
    ("Turn off OPT11 in Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}, False),   # Codex repro
    ("Turn off OPT11 in Rack-01", {"kind": "server_off", "server": "OPT11"}, True),
    ("כבה את OPT11 בארון Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}, False),
    ("כבה את OPT11 ב-Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}, False),
    ("כבה את ארון Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}, True),
    ("power off rack Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}, True),
    ("turn off the servers in Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}, True),
    ("Switch off outlet 1 on PDU-2", {"kind": "outlet_off", "pdu": "PDU-2", "outlet": 2}, False),   # Codex repro
    ("Switch off outlet 1 on PDU-2", {"kind": "outlet_off", "pdu": "PDU-2", "outlet": 1}, True),
    ("כבה את שקע 3 ב-PDU-12", {"kind": "outlet_off", "pdu": "PDU-12", "outlet": 12}, False),
    ("כבה את שקע 3 ב-PDU-12", {"kind": "outlet_off", "pdu": "PDU-12", "outlet": 3}, True),
    ("כבה את PDU-3", {"kind": "outlet_off", "pdu": "PDU-3", "outlet": 3}, False),
])
async def test_s1_s2_the_anchor_follows_the_scope_the_user_wrote(fake_store, message, args, allowed):
    outcome = await run_tool(admin_ctx(message), **args)
    if allowed:
        assert isinstance(outcome, ToolResult), outcome
    else:
        assert isinstance(outcome, str) and "not_requested" in outcome, outcome
        assert fake_store.calls == []
