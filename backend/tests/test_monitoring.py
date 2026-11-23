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

from app import changes, ping_monitor as monitor
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


async def test_a_lab_servers_monitor_shows_the_rack_the_server_is_in_now(monitor_client, monitor_db, tmp_path, monkeypatch):
    """Targets and incidents (list and CSV) show a lab server's current rack: its rack override, else its PDU's rack,
    else its equipment unit's rack. A monitor of a server that is not in the lab keeps its stored rack. The stored copy
    is never rewritten by a read."""
    from app.routers import devices
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    client = monitor_client
    monitor.inventory_store.ITEMS_FILE.write_text(json.dumps({"Rack-05": [{"id": "s23", "type": "server", "name": "OPT23"}]}))
    async with monitor_db() as db:
        db.add(Device(id="pdu1", name="PDU-1", kind="pdu", ip="192.0.2.10", rack="Rack-01", port_count=8,
                      labels_json=json.dumps({"1": "OPT21 (PSU1)", "2": "OPT22"})))
        db.add_all([PingTarget(id="t21", source_key="server:opt21", name="OPT21", host="opt21", rack="Rack-01"),
                    PingTarget(id="t22", source_key="server:opt22", name="OPT22", host="opt22", rack="Old", source="manual"),
                    PingTarget(id="t23", source_key="server:opt23", name="OPT23", host="opt23", rack="Rack-01"),
                    PingTarget(id="t99", source_key="server:bench-box", name="bench-box", host="10.0.0.9", rack="Bench",
                               source="manual")])
        db.add(PingIncident(target_id="t21", host="opt21", first_failed_at=time.time() - 60, last_failed_at=time.time()))
        await db.commit()

    async def shown():
        targets = {t["id"]: t["rack"] for t in (await client.get("/api/monitoring")).json()["targets"]}
        incidents = {i["target_id"]: i["rack"] for i in (await client.get("/api/monitoring/incidents")).json()}
        return targets, incidents

    assert await shown() == ({"t21": "Rack-01", "t22": "Rack-01", "t23": "Rack-05", "t99": "Bench"}, {"t21": "Rack-01"})
    # The Racks page moves OPT21 (DCIM keys it by the lower-cased port label): every list follows at once.
    (tmp_path / "rack_overrides.json").write_text(json.dumps({"opt21 (psu1)": "Rack-07"}))
    assert await shown() == ({"t21": "Rack-07", "t22": "Rack-01", "t23": "Rack-05", "t99": "Bench"}, {"t21": "Rack-07"})
    assert "OPT21,opt21,Rack-07" in (await client.get("/api/monitoring/incidents.csv")).text
    edited = await client.put("/api/monitoring/targets/t21", json={"host": "opt21", "enabled": True, "revision": 0})
    assert edited.status_code == 200 and edited.json()["rack"] == "Rack-07"
    async with monitor_db() as db:
        assert (await db.get(PingTarget, "t21")).rack == "Rack-01"
    # The PDU moves to another rack: its servers (without an override) follow it.
    (tmp_path / "rack_overrides.json").write_text("{}")
    async with monitor_db() as db:
        (await db.get(Device, "pdu1")).rack = "Rack-09"
        await db.commit()
    assert (await shown())[0] == {"t21": "Rack-09", "t22": "Rack-09", "t23": "Rack-05", "t99": "Bench"}


async def test_a_finished_round_counts_for_live_sync(monitor_db, monkeypatch):
    ran = asyncio.Event()

    async def round(owner, factory):
        ran.set()
    monkeypatch.setattr(monitor, "run_round", round)
    task = asyncio.create_task(monitor.monitor_loop(monitor_db))
    try:
        await asyncio.wait_for(ran.wait(), 2)
        for _ in range(200):
            if changes.current()["domains"]["monitoring"]:
                break
            await asyncio.sleep(0.01)
        assert changes.current()["domains"]["monitoring"] == changes.current()["rev"] == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("name,expected", [
    ("OptXXX", None), ("OPTXX", None), ("optnxxx", None), ("OPT-XXX", None), (" optx ", None), ("empty", None),
    ("KVM Power", None), ("Outlet 3", None),
    ("OPT174", ("opt174", "OPT174", "opt174")), ("Optn45", ("optn45", "Optn45", "optn45")),
    # A digit makes it a server name: "OPTX1" is not a placeholder.
    ("OPTX1", ("optx1", "OPTX1", "optx1")), ("OPTN44 (PSU2)", ("optn44", "OPTN44", "optn44")),
])
def test_placeholder_names_are_not_servers(name, expected):
    assert monitor.server_identity(name) == expected


@pytest.mark.parametrize("email_alerts", [True, False])
async def test_discovery_deletes_placeholder_monitors_with_their_history(monitor_db, monkeypatch, email_alerts):
    """The live Lab Display showed "empty: ping probe error": monitors imported for placeholder labels before the rule
    covered them stayed forever. Discovery deletes them (inventory monitors only) with every row that names them."""
    from app import alerts
    from app.config import Settings
    from app.models import AlertCondition, AlertEmail, PingTargetName
    settings = Settings(_env_file=None, email_alerts_enabled=email_alerts, smtp_host="mail.example.test",
                        email_alerts_from="dcim@example.test")
    monkeypatch.setattr(alerts, "get_settings", lambda: settings)
    async with monitor_db() as db:
        db.add(Device(id="pdu-prune", name="PDU 06", kind="pdu", ip="10.1.1.6", rack="Rack-06",
                      labels_json=json.dumps({"1": "empty", "2": "KVM Power", "3": "OptXXX", "4": "OPT61"})))
        db.add_all([
            PingTarget(id="ghost-empty", source_key="server:empty", name="empty", host="empty", rack="Rack-06", status="error"),
            PingTarget(id="ghost-kvm", source_key="server:kvm power", name="KVM Power", host="", rack="Rack-05"),
            PingTarget(id="ghost-optx", source_key="server:optxxx", name="OptXXX", host="optxxx", rack="Rack-01", status="down"),
            PingTarget(id="manual", source_key="server:optxx", name="OPTXX", host="192.0.2.9", source="manual"),
            PingTarget(id="real", source_key="server:opt61", name="OPT61", host="opt61", rack="Rack-06"),
            PingTarget(id="legacy", source_key="legacy", name="--", host=""),   # no "server:" key: not discovery's
        ])
        await db.flush()
        db.add_all([
            PingSample(target_id="ghost-optx", host="optxxx", checked_at=1000, status="down"),
            PingSample(target_id="ghost-empty", host="empty", checked_at=1000, status="error"),
            PingSample(target_id="real", host="opt61", checked_at=1000, status="down"),
            PingIncident(target_id="ghost-optx", host="optxxx", first_failed_at=900, last_failed_at=1000),
            PingIncident(target_id="ghost-optx", host="optxxx", first_failed_at=100, last_failed_at=200, ended_at=300,
                         end_reason="recovered"),
            PingIncident(target_id="real", host="opt61", first_failed_at=900, last_failed_at=1000),
            PingIncident(target_id="manual", host="192.0.2.9", first_failed_at=900, last_failed_at=1000),
            PingTargetName(target_id="ghost-kvm", override="KVM feed"),
            PingTargetName(target_id="real", override="OPT61 build"),
            AlertCondition(key="network:ghost-optx", configuration="[]", started_at=900, checked_at=1000, notified=True),
            AlertCondition(key="network:ghost-empty", configuration="[]", started_at=None, checked_at=1000, notified=False),
            AlertCondition(key="network:real", configuration="[]", started_at=900, checked_at=1000, notified=True),
            AlertCondition(key="network:manual", configuration="[]", started_at=900, checked_at=1000, notified=True),
        ])
        await db.commit()

    async def rows(model):
        async with monitor_db() as db:
            return (await db.execute(select(model))).scalars().all()

    before = changes.current()["rev"]
    async with monitor_db() as db:
        await monitor.discover_targets(db)
    assert sorted(t.id for t in await rows(PingTarget)) == ["legacy", "manual", "real"]
    assert sorted(s.target_id for s in await rows(PingSample)) == ["real"]
    incidents = await rows(PingIncident)
    assert sorted(i.target_id for i in incidents) == ["manual", "real"]
    assert all(i.ended_at is None for i in incidents), "real and manual incidents are untouched"
    assert [(n.target_id, n.override) for n in await rows(PingTargetName)] == [("real", "OPT61 build")]
    assert sorted(c.key for c in await rows(AlertCondition)) == ["network:manual", "network:real"]
    mails = await rows(AlertEmail)
    if email_alerts:
        # The failure email sent for OptXXX is closed honestly: no "[DCIM recovered]" (no reply was observed).
        assert [(m.condition_key, m.subject) for m in mails] == [("network:ghost-optx", "[DCIM closed] OptXXX: network reachability")]
        assert "No recovery was observed" in mails[0].body and "placeholder" in mails[0].body
    else:
        assert mails == []
    # Open pages are told: the monitoring domain moved.
    after = changes.current()
    assert after["rev"] == before + 1 and after["domains"]["monitoring"] == after["rev"]

    # Idempotent: nothing is left to delete, nothing more is counted or sent, and no monitor is created again.
    async with monitor_db() as db:
        await monitor.discover_targets(db)
    assert sorted(t.id for t in await rows(PingTarget)) == ["legacy", "manual", "real"]
    assert len(await rows(AlertEmail)) == (1 if email_alerts else 0)
    assert changes.current()["rev"] == after["rev"]


async def test_a_round_never_probes_a_placeholder_monitor(monitor_db):
    async with monitor_db() as db:
        db.add_all([
            PingTarget(id="ghost", source_key="server:optxxx", name="OptXXX", host="optxxx"),
            PingTarget(id="one", source_key="server:opt1", name="Opt1", host="opt1"),
        ])
        await db.commit()
        assert await monitor.claim_round(db, "worker", time.time(), ZoneInfo("Asia/Jerusalem"))
    probe = AsyncMock(return_value=monitor.ProbeResult("up", 1.0))
    await monitor.run_round("worker", monitor_db, probe)
    probe.assert_awaited_once_with("opt1")
    async with monitor_db() as db:
        assert await db.get(PingTarget, "ghost") is None
