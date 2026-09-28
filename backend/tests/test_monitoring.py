"""Monitor schedule, durable observations, safe probes and authenticated API."""
import asyncio
from datetime import datetime
import json
import time
from unittest.mock import AsyncMock, Mock
from zoneinfo import ZoneInfo

import pytest
from httpx import ASGITransport, AsyncClient, BasicAuth
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import ping_monitor as monitor
from app.database import Base, get_db
from app.models import Device, PingIncident, PingMonitorState, PingSample, PingTarget
from app.routers import monitoring
from app.schemas import OutletState, PduStatus


def stamp(value):
    return datetime.fromisoformat(value).timestamp()


@pytest.mark.parametrize("current,expected,interval", [
    ("2026-09-28T06:30:00+03:00", "2026-09-28T07:00:00+03:00", 30),
    ("2026-09-28T06:59:59+03:00", "2026-09-28T07:00:00+03:00", 30),
    ("2026-09-28T07:00:00+03:00", "2026-09-28T07:05:00+03:00", 5),
    ("2026-09-28T12:12:01+03:00", "2026-09-28T12:15:00+03:00", 5),
    ("2026-09-28T19:55:00+03:00", "2026-09-28T20:00:00+03:00", 5),
    ("2026-09-28T20:00:00+03:00", "2026-09-28T20:30:00+03:00", 30),
    ("2026-09-28T23:59:59+03:00", "2026-09-29T00:00:00+03:00", 30),
    ("2026-12-01T06:59:00+02:00", "2026-12-01T07:00:00+02:00", 30),
    ("2026-03-27T01:59:59+02:00", "2026-03-27T03:00:00+03:00", 30),
    ("2026-10-25T01:59:59+03:00", "2026-10-25T01:00:00+02:00", 30),
])
def test_schedule_boundaries_and_dst(current, expected, interval):
    zone = ZoneInfo("Asia/Jerusalem")
    assert monitor.next_slot(stamp(current), zone) == stamp(expected)
    assert monitor.interval_minutes(stamp(current), zone) == interval


@pytest.mark.parametrize("host", ["-n", "--help", "$(whoami)", "a; echo yes", "http://example.com", "a b", "a\nb", "a:80", ".", "::1%eth0"])
def test_invalid_addresses(host):
    with pytest.raises(ValueError):
        monitor.validate_host(host)


def test_valid_addresses():
    for host in ("opt133", "lab-2.example.test", "10.7.1.23", "2001:db8::1", "::1"):
        assert monitor.validate_host(host) == host


@pytest.fixture
async def monitor_db(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'monitor.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(monitor.inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    await monitor.ensure_state(factory)
    yield factory
    await engine.dispose()


async def test_discovery_deduplicates_servers_and_never_uses_pdu_ip(monitor_db):
    from app.routers import pdus
    monitor.inventory_store.ITEMS_FILE.write_text(json.dumps({"Rack-3": [
        {"id": "pc1", "name": "Opt133", "type": "computer", "ip": "10.0.0.133"},
        {"id": "pc2", "name": "Build server", "type": "computer"},
        {"id": "sw", "name": "Switch", "type": "switch", "ip": "10.0.0.1"},
    ]}))
    async with monitor_db() as db:
        db.add_all([
            Device(id="pdu", name="PDU", kind="pdu", ip="10.1.1.1", rack="Rack-1", labels_json=json.dumps({"1": "Opt133", "2": "Optn84 (2)", "3": "Outlet 3", "4": "Opt (unlabeled)"})),
            Device(id="kvm", name="KVM", kind="kvm", ip="10.1.1.2", labels_json=json.dumps({"1": "OPT133", "2": "Optn84", "3": "Port 3"})),
        ])
        await db.commit()
        pdus._cache["pdu"] = (time.monotonic(), PduStatus(device_id="pdu", reachable=True, outlets=[
            OutletState(number=1, label="OLD-NAME", state="on"),
            OutletState(number=9, label="LiveOnly", state="off"),
        ]))
        await monitor.discover_targets(db)
        targets = {t.name: t for t in (await db.execute(select(PingTarget))).scalars()}
        assert len(targets) == 5
        assert targets["Optn84"].host == "optn84"
        assert targets["Opt133"].host == "10.0.0.133"
        assert targets["Build server"].host == ""
        assert targets["Opt (unlabeled)"].host == ""
        assert targets["LiveOnly"].host == "liveonly"
        assert not any(t.host in ("10.1.1.1", "10.1.1.2") for t in targets.values())
        targets["Opt133"].host = "10.0.0.99"
        targets["Opt133"].enabled = False
        await db.commit()
        await monitor.discover_targets(db)
        assert targets["Opt133"].host == "10.0.0.99"
        assert targets["Opt133"].enabled is False


async def seed_target(factory):
    async with factory() as db:
        db.add(PingTarget(id="one", source_key="server:opt1", name="Opt1", host="opt1"))
        await db.commit()


async def test_incident_survives_new_sessions_and_errors_are_not_recoveries(monitor_db):
    await seed_target(monitor_db)
    for at, status in [(1000, "up"), (1300, "down"), (1600, "down"), (1700, "error"), (1900, "up")]:
        async with monitor_db() as db:
            await monitor.record_result(db, "one", 0, "opt1", monitor.ProbeResult(status), at)
            await db.commit()
    async with monitor_db() as db:
        incident = (await db.execute(select(PingIncident))).scalar_one()
        assert (incident.first_failed_at, incident.last_failed_at, incident.ended_at) == (1300, 1600, 1900)
        assert incident.failed_checks == 2
        assert incident.previous_up_at == 1000
        assert incident.end_reason == "recovered"
        assert await db.scalar(select(func.count()).select_from(PingSample)) == 5
        target = await db.get(PingTarget, "one")
        assert target.status == "up" and target.last_up_at == 1900


async def test_initial_probe_error_does_not_invent_outage(monitor_db):
    await seed_target(monitor_db)
    async with monitor_db() as db:
        await monitor.record_result(db, "one", 0, "opt1", monitor.ProbeResult("error", detail="DNS failed"), 1000)
        await db.commit()
        assert await db.scalar(select(func.count()).select_from(PingIncident)) == 0


async def test_lease_prevents_overlapping_workers_and_recovers_after_crash(monitor_db):
    zone = ZoneInfo("Asia/Jerusalem")
    now = time.time()
    async def claim(owner, at):
        async with monitor_db() as db:
            return await monitor.claim_round(db, owner, at, zone)
    claimed = await asyncio.gather(claim("a", now), claim("b", now))
    assert sorted(claimed) == [False, True]
    assert not await claim("c", now + 1)
    # The next due slot after a crashed process is claimable after lease expiration.
    assert await claim("c", max(now + 121, monitor.next_slot(now, zone)))


async def test_round_probes_only_enabled_configured_targets_and_prunes_history(monitor_db):
    await seed_target(monitor_db)
    async with monitor_db() as db:
        db.add_all([
            PingTarget(id="paused", source_key="paused", name="Paused", host="paused", enabled=False),
            PingTarget(id="missing", source_key="missing", name="Missing", host=""),
            PingSample(target_id="one", host="opt1", checked_at=1, status="up"),
        ])
        await db.commit()
        assert await monitor.claim_round(db, "worker", time.time(), ZoneInfo("Asia/Jerusalem"))
    probe = AsyncMock(return_value=monitor.ProbeResult("up", 2.5))
    await monitor.run_round("worker", monitor_db, probe)
    probe.assert_awaited_once_with("opt1")
    async with monitor_db() as db:
        samples = (await db.execute(select(PingSample))).scalars().all()
        assert len(samples) == 1 and samples[0].rtt_ms == 2.5


@pytest.fixture
async def monitor_client(monitor_db, monkeypatch):
    import app.main as main
    from app.config import Settings
    settings = Settings(lab_manager_password="test-monitor-password")
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(monitoring, "get_settings", lambda: settings)
    async def db_dependency():
        async with monitor_db() as db:
            yield db
    main.app.dependency_overrides[get_db] = db_dependency
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test", auth=BasicAuth("lab", "test-monitor-password")) as client:
        yield client
    main.app.dependency_overrides.clear()


async def test_api_config_history_auth_and_csv(monitor_client, monitor_db):
    client = monitor_client
    assert (await client.get("/api/monitoring", auth=None)).status_code == 401
    created = await client.post("/api/monitoring/targets", json={"name": "Opt1", "host": "OPT1", "rack": "A"})
    assert created.status_code == 201
    target = created.json()
    assert target["host"] == "opt1"
    assert (await client.post("/api/monitoring/targets", json={"name": "opt1", "host": "10.0.0.1"})).status_code == 409
    assert (await client.put(f"/api/monitoring/targets/{target['id']}", json={"host": "-n 100", "enabled": True, "revision": 0})).status_code == 422
    async with monitor_db() as db:
        await monitor.record_result(db, target["id"], 0, "opt1", monitor.ProbeResult("down"), time.time())
        await db.commit()
    events = (await client.get("/api/monitoring/incidents")).json()
    assert len(events) == 1 and events[0]["ended_at"] is None
    edited = await client.put(f"/api/monitoring/targets/{target['id']}", json={"host": "10.0.0.1", "enabled": True, "revision": 0})
    assert edited.status_code == 200 and edited.json()["checked_at"] is None
    assert (await client.put(f"/api/monitoring/targets/{target['id']}", json={"host": "old", "enabled": True, "revision": 0})).status_code == 409
    # Late response from the previous address must not corrupt the new target.
    async with monitor_db() as db:
        await monitor.record_result(db, target["id"], 0, "opt1", monitor.ProbeResult("up"), time.time())
        await db.commit()
    history = (await client.get(f"/api/monitoring/targets/{target['id']}/history")).json()
    assert len(history) == 1 and history[0]["status"] == "down"
    assert (await client.get("/api/monitoring/incidents")).json()[0]["end_reason"] == "address_changed"
    csv = await client.get("/api/monitoring/incidents.csv")
    assert csv.status_code == 200 and "Opt1,opt1,A" in csv.text
    summary = (await client.get("/api/monitoring")).json()
    assert summary["timezone"] == "Asia/Jerusalem"
    assert summary["targets"][0]["status"] == "pending"
    assert (await client.post("/api/monitoring/check")).status_code == 202


async def test_pause_closes_incident_without_claiming_recovery(monitor_client, monitor_db):
    await seed_target(monitor_db)
    async with monitor_db() as db:
        await monitor.record_result(db, "one", 0, "opt1", monitor.ProbeResult("down"), time.time())
        await db.commit()
    response = await monitor_client.put("/api/monitoring/targets/one", json={"host": "opt1", "enabled": False, "revision": 0})
    assert response.json()["status"] == "paused"
    incidents = (await monitor_client.get("/api/monitoring/incidents")).json()
    assert incidents[0]["end_reason"] == "paused"


async def test_stale_status_does_not_present_old_success_as_current(monitor_client, monitor_db):
    await seed_target(monitor_db)
    async with monitor_db() as db:
        await monitor.record_result(db, "one", 0, "opt1", monitor.ProbeResult("up"), time.time() - 3600)
        await db.commit()
    response = (await monitor_client.get("/api/monitoring")).json()
    assert response["targets"][0]["status"] == "stale"
    assert response["targets"][0]["last_result"] == "up"


async def test_manual_check_cannot_overlap_active_round(monitor_client, monitor_db):
    async with monitor_db() as db:
        assert await monitor.claim_round(db, "worker", time.time(), ZoneInfo("Asia/Jerusalem"))
    assert (await monitor_client.post("/api/monitoring/check")).status_code == 409


@pytest.mark.parametrize("status,expected", [(0, "up"), (11010, "down"), (11003, "down")])
async def test_windows_icmp_status_not_process_exit_code(monkeypatch, status, expected):
    process = AsyncMock()
    process.returncode = 0
    process.communicate.return_value = (json.dumps({"status": status, "rtt": 4}).encode(), b"")
    create = AsyncMock(return_value=process)
    monkeypatch.setattr(monitor.asyncio, "create_subprocess_exec", create)
    monkeypatch.setattr(monitor, "IS_WINDOWS", True)
    result = await monitor.ping("opt1")
    assert result.status == expected
    assert (result.rtt_ms == 4) == (expected == "up")
    assert create.call_args.kwargs["env"]["LAB_MANAGER_PING_HOST"] == "opt1"
    assert "opt1" not in create.call_args.args[-1]


async def test_missing_ping_is_monitor_error(monkeypatch):
    monkeypatch.setattr(monitor.asyncio, "create_subprocess_exec", AsyncMock(side_effect=FileNotFoundError("ping missing")))
    assert (await monitor.ping("opt1")).status == "error"


@pytest.mark.parametrize("code,output,expected", [
    (0, b"64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=1.25 ms", "up"),
    (1, b"1 packets transmitted, 0 received", "down"),
    (2, b"ping: opt1: Name or service not known", "error"),
])
async def test_linux_ping(monkeypatch, code, output, expected):
    process = Mock(returncode=code)
    process.communicate = AsyncMock(return_value=(output, b""))
    create = AsyncMock(return_value=process)
    monkeypatch.setattr(monitor, "IS_WINDOWS", False)
    monkeypatch.setattr(monitor.asyncio, "create_subprocess_exec", create)
    result = await monitor.ping("opt1")
    assert result.status == expected
    if expected == "up":
        assert result.rtt_ms == 1.25
    assert create.call_args.args == ("ping", "-n", "-c", "1", "-W", "3", "opt1")


async def test_cancelled_probe_reaps_child(monkeypatch):
    waiting = asyncio.Event()
    async def communicate():
        waiting.set()
        await asyncio.Event().wait()
    process = Mock(returncode=None)
    process.communicate = AsyncMock(side_effect=communicate)
    def killed():
        process.returncode = -1
        process.communicate.side_effect = None
        process.communicate.return_value = (b"", b"")
    process.kill.side_effect = killed
    monkeypatch.setattr(monitor.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    task = asyncio.create_task(monitor.ping("opt1"))
    await asyncio.wait_for(waiting.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    process.kill.assert_called_once()


async def test_background_loop_records_completion_and_releases_lease(monitor_db, monkeypatch):
    ran = asyncio.Event()
    async def round(owner, factory):
        ran.set()
    monkeypatch.setattr(monitor, "run_round", round)
    task = asyncio.create_task(monitor.monitor_loop(monitor_db))
    try:
        await asyncio.wait_for(ran.wait(), 2)
        for _ in range(100):
            async with monitor_db() as db:
                state = await db.get(PingMonitorState, 1)
                if state.last_completed_at and state.lease_until == 0:
                    break
            await asyncio.sleep(0.01)
        assert state.last_completed_at is not None and state.lease_until == 0
        assert state.next_run_at > state.last_started_at
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
