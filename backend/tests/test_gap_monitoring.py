"""Regression tests for monitoring behaviour the other suites do not cover.

Scope: app/ping_monitor.py, app/routers/monitoring.py, app/alerts.py, app/monitor_links.py.
Only fake transports are used: subprocesses, device status fetches and SMTP are replaced in-process.
"""
import asyncio
import csv
import hashlib
import io
import json
import re
import smtplib
import time
from unittest.mock import AsyncMock, Mock
from zoneinfo import ZoneInfo

import pytest
from httpx import ASGITransport, AsyncClient, BasicAuth
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, alerts, monitor_links, ping_monitor
from app.config import Settings
from app.database import Base, get_db
from app.models import (AlertCondition, AlertEmail, AlertWorkerState, Device, MonitorDeviceError,
                        MonitorDeviceSnapshot, PingIncident, PingMonitorState, PingSample, PingTarget)
from app.routers import kvms, monitoring, pdus
from app.schemas import InletReading, KvmPort, KvmStatus, OutletState, PduStatus

PASSWORD = "gap-monitor-password"
ZONE = ZoneInfo("Asia/Jerusalem")
DAY = 86400


# ---------------------------------------------------------------- fixtures / helpers

@pytest.fixture
async def factory(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'gap.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(ping_monitor.inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
def settings(monkeypatch):
    """One deterministic settings object (no .env, no machine environment) shared by every module under test."""
    for field in Settings.model_fields:      # e.g. ACCOUNTS_ENABLED or EMAIL_CURRENT_MAX set on a dev box or the VM
        monkeypatch.delenv(field.upper(), raising=False)
    value = Settings(_env_file=None, lab_manager_password=PASSWORD, email_alerts_enabled=True,
                     email_alerts_minute_probes=True, smtp_host="mail.example.test",
                     email_alerts_from="dcim@example.test")
    for module in (accounts, alerts, monitoring, ping_monitor):   # accounts: the deployed app's AccountAccess middleware
        monkeypatch.setattr(module, "get_settings", lambda: value)
    return value


@pytest.fixture
async def api(factory, settings, monkeypatch):
    import app.main as main
    monkeypatch.setattr(main, "get_settings", lambda: settings)

    async def dependency():
        async with factory() as db:
            yield db
    main.app.dependency_overrides[get_db] = dependency
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test",
                               auth=BasicAuth("lab", PASSWORD)) as client:
            yield client
    finally:
        main.app.dependency_overrides.pop(get_db, None)


async def add(factory, *rows):
    async with factory() as db:
        db.add_all(rows)
        await db.commit()


async def record(factory, target_id, host, status, at, revision=0):
    async with factory() as db:
        await ping_monitor.record_result(db, target_id, revision, host, ping_monitor.ProbeResult(status), at)
        await db.commit()


async def network(factory, stamp, status="down", target_id="one"):
    async with factory() as db:
        target = await db.get(PingTarget, target_id)
        await alerts.observe_network(db, target, ping_monitor.ProbeResult(status, detail="gap test"), stamp, minute=True)
        await db.commit()


async def emails(factory):
    async with factory() as db:
        return (await db.execute(select(AlertEmail).order_by(AlertEmail.created_at, AlertEmail.id))).scalars().all()


async def first_target(client):
    response = await client.get("/api/monitoring")
    assert response.status_code == 200, response.text
    return response.json()["targets"][0]


def fake_smtp_connection():
    connection = Mock()
    connection.__enter__ = Mock(return_value=connection)
    connection.__exit__ = Mock(return_value=False)
    return connection


# ---------------------------------------------------------------- server identity / discovery

@pytest.mark.parametrize("label,expected", [
    ("Outlet3", None),
    ("PORT 12", None),
    ("  outlet 7 ", None),
    ("", None),
    (None, None),
    ("  Opt5 (PSU B) ", ("opt5", "Opt5", "opt5")),
    ("OPTN84(2)", ("optn84", "OPTN84", "optn84")),
    ("10.0.0.5", ("10.0.0.5", "10.0.0.5", "10.0.0.5")),
    ("Build Server", ("build server", "Build Server", "")),
    ("opt_1", ("opt_1", "opt_1", "")),
    ("Opt7.Lab.Example", ("opt7.lab.example", "Opt7.Lab.Example", "opt7.lab.example")),
    ("שרת בדיקה", ("שרת בדיקה", "שרת בדיקה", "")),
])
def test_server_identity_key_display_name_and_pingable_host(label, expected):
    """Default port labels are not servers; feed suffixes collapse; only valid DNS/IP names become hosts."""
    assert ping_monitor.server_identity(label) == expected


def test_placeholder_outlet_labels_are_not_monitored_servers():
    placeholders = ["Empty", "SPARE", " Free ", "PDU", "KVM Power", "kvm_power", "n/a", "--"]
    assert {label: ping_monitor.server_identity(label) for label in placeholders} == dict.fromkeys(placeholders)


async def test_discovery_uses_kvm_cache_and_inventory_hostname_but_never_rewrites_manual_targets(factory):
    items = ping_monitor.inventory_store.ITEMS_FILE
    items.write_text(json.dumps({"Rack-5": [
        {"id": "a", "name": "Opt8", "type": "server", "hostname": "Opt8.Lab.Example"},
        {"id": "b", "name": "Opt9", "type": "computer", "ip": "http://10.0.0.9"},
        {"id": "c", "name": "Opt5", "type": "server", "ip": "10.9.9.5"},
    ]}))
    await add(factory,
              Device(id="pdu", name="PDU", kind="pdu", ip="10.1.1.1", rack="Rack-1", labels_json=json.dumps({"1": "Opt8"})),
              Device(id="kvm", name="KVM", kind="kvm", ip="10.1.1.2", rack="Rack-2", labels_json="{}"),
              PingTarget(id="manual", source_key="server:opt5", name="Opt5 bench", host="10.0.0.5", rack="Bench", source="manual"))
    kvms._cache["kvm"] = (time.monotonic(), KvmStatus(device_id="kvm", reachable=True, ports=[
        KvmPort(number=4, label="Opt12 (console)", status="idle")]))
    async with factory() as db:
        found = await ping_monitor.inventory_sources(db)
        # The inventory entry wins over the PDU label for rack and address.
        assert found["opt8"] == ("Opt8", "opt8.lab.example", "Rack-5")
        # An invalid explicit address is not replaced by a guess derived from the name.
        assert found["opt9"] == ("Opt9", "", "Rack-5")
        # Labels learned only from a KVM status cache are servers in that KVM's rack.
        assert found["opt12"] == ("Opt12", "opt12", "Rack-2")
        await ping_monitor.discover_targets(db)
        targets = {t.source_key: t for t in (await db.execute(select(PingTarget))).scalars()}
    assert set(targets) == {"server:opt5", "server:opt8", "server:opt9", "server:opt12"}
    manual = targets["server:opt5"]
    assert (manual.id, manual.name, manual.host, manual.rack, manual.source) == ("manual", "Opt5 bench", "10.0.0.5", "Bench", "manual")

    # Moving/renaming the server in the inventory updates the same target, never a new one.
    original_id = targets["server:opt8"].id
    items.write_text(json.dumps({"Rack-6": [{"id": "a", "name": "OPT8", "type": "server"}],
                                 "Rack-5": [{"id": "c", "name": "Opt5", "type": "server", "ip": "10.9.9.5"}]}))
    async with factory() as db:
        await ping_monitor.discover_targets(db)
    async with factory() as db:
        moved = (await db.execute(select(PingTarget).where(PingTarget.source_key == "server:opt8"))).scalar_one()
        manual = await db.get(PingTarget, "manual")
    assert (moved.id, moved.name, moved.rack) == (original_id, "OPT8", "Rack-6")
    assert (manual.name, manual.rack, manual.host) == ("Opt5 bench", "Bench", "10.0.0.5")


# ---------------------------------------------------------------- ICMP probe

@pytest.mark.parametrize("host,detail", [
    ("", "No IP address or hostname configured"),
    ("   ", "No IP address or hostname configured"),
    ("-c 100 10.0.0.1", "single IP address"),
    ("opt1;reboot", "single IP address"),
    ("http://opt1", "single IP address"),
])
async def test_probe_refuses_unusable_addresses_without_starting_a_process(monkeypatch, host, detail):
    spawn = AsyncMock()
    monkeypatch.setattr(ping_monitor.asyncio, "create_subprocess_exec", spawn)
    result = await ping_monitor.ping(host)
    assert result.status == "error" and detail in result.detail
    spawn.assert_not_called()


@pytest.mark.parametrize("windows,code,stdout,stderr,status,rtt,detail", [
    (False, 0, b"64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time<1 ms", b"", "up", 1.0, ""),
    (False, 0, b"1 packets transmitted, 1 received", b"", "up", None, ""),
    (False, 1, b"", b"", "down", None, re.escape("ICMP probe failed")),
    (False, 1, b"x" * 1000 + b"END", b"", "down", None, "x{397}END"),
    (False, 2, b"noise", b"ping: opt1: Temporary failure in name resolution\n", "error", None,
     re.escape("ping: opt1: Temporary failure in name resolution")),
    (True, 0, b'{"error":"DNS resolution or local ICMP probe failed"}', b"", "error", None,
     re.escape("DNS resolution or local ICMP probe failed")),
    (True, 0, b"", b"", "error", None, "Local ping probe failed: .+"),
    (True, 0, b'{"rtt": 3}', b"", "error", None, "Local ping probe failed: .+"),
])
async def test_probe_output_classification(monkeypatch, windows, code, stdout, stderr, status, rtt, detail):
    """Local/DNS failures are errors (never outages); output is bounded and the host is normalized."""
    process = Mock(returncode=code)
    process.communicate = AsyncMock(return_value=(stdout, stderr))
    spawn = AsyncMock(return_value=process)
    monkeypatch.setattr(ping_monitor, "IS_WINDOWS", windows)
    monkeypatch.setattr(ping_monitor.asyncio, "create_subprocess_exec", spawn)
    result = await ping_monitor.ping("OPT1")
    assert (result.status, result.rtt_ms) == (status, rtt)
    assert re.fullmatch(detail, result.detail, re.S), result.detail
    assert len(result.detail) <= 400
    env = spawn.call_args.kwargs["env"]
    assert env["LAB_MANAGER_PING_HOST"] == "opt1"
    if not windows:
        assert spawn.call_args.args[-1] == "opt1" and env["LC_ALL"] == "C"


async def test_probe_timeout_kills_and_reaps_the_child(monkeypatch):
    released = asyncio.Event()
    process = Mock(returncode=None)

    async def communicate():
        await released.wait()
        return b"", b""
    process.communicate = communicate

    def kill():
        process.returncode = -9
        released.set()
    process.kill = Mock(side_effect=kill)
    monkeypatch.setattr(ping_monitor, "IS_WINDOWS", False)
    monkeypatch.setattr(ping_monitor.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    budgets, real_wait_for = [], asyncio.wait_for

    async def short_wait(awaitable, timeout):
        budgets.append(timeout)
        return await real_wait_for(awaitable, 0.05)
    monkeypatch.setattr(ping_monitor.asyncio, "wait_for", short_wait)
    async with asyncio.timeout(5):
        result = await ping_monitor.ping("opt1")
    assert budgets == [10]
    assert result.status == "error" and "exceeded 10 seconds" in result.detail
    process.kill.assert_called_once()
    assert process.returncode == -9


# ---------------------------------------------------------------- incidents and scheduled rounds

async def test_new_outage_after_recovery_is_a_new_incident_and_paused_results_are_discarded(factory, settings):
    await add(factory, PingTarget(id="one", source_key="server:opt1", name="Opt1", host="opt1"),
              PingTarget(id="paused", source_key="server:opt2", name="Opt2", host="opt2", enabled=False))
    # The local probe error at 1450 is a newer check than the success at 1300, but not a success.
    for at, status in [(1000, "down"), (1300, "up"), (1450, "error"), (1600, "down"), (1900, "down")]:
        await record(factory, "one", "opt1", status, at)
    await record(factory, "paused", "opt2", "down", 2000)
    async with factory() as db:
        incidents = (await db.execute(select(PingIncident).order_by(PingIncident.first_failed_at))).scalars().all()
        target = await db.get(PingTarget, "one")
        paused = await db.get(PingTarget, "paused")
        paused_samples = await db.scalar(select(func.count()).select_from(PingSample).where(PingSample.target_id == "paused"))
    assert [(i.target_id, i.previous_up_at, i.first_failed_at, i.last_failed_at, i.ended_at, i.end_reason, i.failed_checks)
            for i in incidents] == [
        ("one", None, 1000, 1000, 1300, "recovered", 1),  # never seen up before: no invented last success
        ("one", 1300, 1600, 1900, None, None, 2),
    ]
    assert (target.status, target.last_up_at, target.checked_at) == ("down", 1300, 1900)
    assert (paused.status, paused.checked_at, paused_samples) == ("pending", None, 0)


async def test_round_writes_nothing_after_another_worker_takes_the_lease(factory, settings):
    await add(factory, PingTarget(id="one", source_key="server:opt1", name="Opt1", host="opt1"))
    await ping_monitor.ensure_state(factory)
    async with factory() as db:
        assert await ping_monitor.claim_round(db, "me", time.time(), ZONE)

    async def probe(host):
        async with factory() as db:
            await db.execute(update(PingMonitorState).values(lease_owner="other", lease_until=time.time() + 120))
            await db.commit()
        return ping_monitor.ProbeResult("down")
    with pytest.raises(RuntimeError, match="lease expired"):
        await ping_monitor.run_round("me", factory, probe)
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(PingSample)) == 0
        assert await db.scalar(select(func.count()).select_from(PingIncident)) == 0
        assert (await db.get(PingTarget, "one")).status == "pending"


async def test_round_prunes_only_expired_history_and_keeps_open_incidents(factory, settings):
    now = time.time()
    await add(factory,
              PingTarget(id="one", source_key="server:opt1", name="Opt1", host="opt1", enabled=False),
              PingIncident(target_id="one", host="opt1", first_failed_at=now - 95 * DAY, last_failed_at=now - 95 * DAY,
                           ended_at=now - 91 * DAY, end_reason="recovered"),
              PingIncident(target_id="one", host="opt1", first_failed_at=now - 90 * DAY, last_failed_at=now - 90 * DAY,
                           ended_at=now - 89 * DAY, end_reason="recovered"),
              PingIncident(target_id="one", host="opt1", first_failed_at=now - 200 * DAY, last_failed_at=now - DAY),
              PingSample(target_id="one", host="opt1", checked_at=now - 31 * DAY, status="up"),
              PingSample(target_id="one", host="opt1", checked_at=now - 29 * DAY, status="down"))
    probe = AsyncMock()
    await ping_monitor.run_round("worker", factory, probe)
    probe.assert_not_awaited()
    async with factory() as db:
        kept = (await db.execute(select(PingIncident).order_by(PingIncident.first_failed_at))).scalars().all()
        samples = (await db.execute(select(PingSample))).scalars().all()
    assert [(round((now - i.first_failed_at) / DAY), i.ended_at is None) for i in kept] == [(200, True), (90, False)]
    assert [s.status for s in samples] == ["down"]


async def test_loop_saves_round_failure_and_releases_lease(factory, settings, monkeypatch):
    await ping_monitor.ensure_state(factory)

    async def failing_round(owner, session_factory):
        raise RuntimeError("probe backend exploded " + "x" * 600)
    monkeypatch.setattr(ping_monitor, "run_round", failing_round)
    task = asyncio.create_task(ping_monitor.monitor_loop(factory))
    try:
        deadline = time.monotonic() + 15        # generous: only a hung loop should reach it, not a slow machine
        while True:
            async with factory() as db:
                state = await db.get(PingMonitorState, 1)
            if (state.error and state.lease_until == 0) or time.monotonic() > deadline:
                break
            await asyncio.sleep(0.01)
        assert state.error.startswith("probe backend exploded") and len(state.error) == 400
        assert (state.lease_owner, state.lease_until, state.last_completed_at) == ("", 0, None)
        assert state.last_started_at is not None and state.next_run_at > state.last_started_at
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("change", [{"ping_monitor_enabled": False}, {"ping_monitor_timezone": "Mars/Olympus_Mons"}])
async def test_loop_never_claims_a_round_when_disabled_or_timezone_invalid(factory, settings, monkeypatch, change):
    for key, value in change.items():
        setattr(settings, key, value)
    await ping_monitor.ensure_state(factory)
    round_runner = AsyncMock()
    monkeypatch.setattr(ping_monitor, "run_round", round_runner)
    assert await asyncio.wait_for(ping_monitor.monitor_loop(factory), 2) is None
    round_runner.assert_not_awaited()
    async with factory() as db:
        state = await db.get(PingMonitorState, 1)
    assert (state.last_started_at, state.lease_owner, state.lease_until) == (None, "", 0)


# ---------------------------------------------------------------- monitoring API

@pytest.mark.parametrize("case,expected", [
    ("disabled", "disabled"), ("missing", "not_started"), ("error", "error"),
    ("running", "running"), ("overdue", "overdue"), ("scheduled", "scheduled"),
])
async def test_overview_reports_scheduler_state(api, factory, settings, case, expected):
    now = time.time()
    if case != "missing":
        await ping_monitor.ensure_state(factory)
        async with factory() as db:
            state = await db.get(PingMonitorState, 1)
            state.next_run_at, state.lease_until = now + 200, 0
            if case == "error":  # A recorded error wins even while a lease is held.
                state.error, state.lease_until = "Monitor lease was lost", now + 100
            elif case == "running":
                state.lease_until = now + 100
            elif case == "overdue":
                state.next_run_at = now - 120
            await db.commit()
    if case == "disabled":
        settings.ping_monitor_enabled = False
    body = (await api.get("/api/monitoring")).json()
    assert body["service"] == expected
    assert (body["next_run_at"] is None) == (case in ("disabled", "missing"))
    assert body["error"] == ("Monitor lease was lost" if case == "error" else "")
    if case == "disabled":
        assert "Ping monitoring is disabled" in body["email_alerts"]["problems"]
        assert body["email_alerts"]["ready"] is False


async def test_paused_and_unconfigured_targets_never_show_their_last_result(api, factory, settings):
    await add(factory,
              PingTarget(id="paused", source_key="server:a", name="A", host="opt-a", enabled=False, status="up",
                         checked_at=time.time(), last_up_at=1000),
              PingTarget(id="blank", source_key="server:b", name="B", host="", status="up"),
              PingTarget(id="both", source_key="server:c", name="C", host="", enabled=False))
    targets = {t["id"]: t for t in (await api.get("/api/monitoring")).json()["targets"]}
    assert {key: (t["status"], t["last_result"]) for key, t in targets.items()} == {
        "paused": ("paused", "up"), "blank": ("unconfigured", "up"), "both": ("paused", "pending")}
    resumed = await api.put("/api/monitoring/targets/paused", json={"host": "opt-a", "enabled": True, "revision": 0})
    assert resumed.status_code == 200
    body = resumed.json()
    # Resuming must not present the pre-pause observation as current, but keeps the last known success.
    assert (body["status"], body["checked_at"], body["revision"]) == ("pending", None, 1)
    assert body["last_up_at"] == ping_monitor.iso(1000)


async def test_api_refuses_port_labels_unknown_servers_bad_limits_and_unavailable_checks(api, factory, settings):
    for name in ("Outlet 4", "port12"):
        response = await api.post("/api/monitoring/targets", json={"name": name, "host": "10.0.0.4"})
        assert response.status_code == 422 and "default port label" in response.json()["detail"]
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(PingTarget)) == 0
    missing = await api.put("/api/monitoring/targets/nope", json={"host": "10.0.0.4", "enabled": True, "revision": 0})
    assert (missing.status_code, missing.json()["detail"]) == (404, "Server not found")
    assert (await api.get("/api/monitoring/targets/nope/history")).status_code == 404
    for limit in (0, 2001):
        assert (await api.get(f"/api/monitoring/incidents?limit={limit}")).status_code == 422
    not_started = await api.post("/api/monitoring/check")
    assert not_started.status_code == 503 and "not started" in not_started.json()["detail"]
    settings.ping_monitor_enabled = False
    disabled = await api.post("/api/monitoring/check")
    assert disabled.status_code == 409 and "disabled" in disabled.json()["detail"]


async def test_incident_filter_order_open_duration_and_history(api, factory, settings):
    await add(factory, PingTarget(id="a", source_key="server:a", name="A", host="opt-a", source="manual"),
              PingTarget(id="b", source_key="server:b", name="B", host="opt-b", source="manual"))
    for target, host, status, at in [("a", "opt-a", "down", 1000), ("a", "opt-a", "down", 1300),
                                     ("b", "opt-b", "down", 2000), ("b", "opt-b", "up", 2600)]:
        await record(factory, target, host, status, at)
    everything = (await api.get("/api/monitoring/incidents")).json()
    assert [i["target_id"] for i in everything] == ["b", "a"]  # newest outage first
    only_a = (await api.get("/api/monitoring/incidents?target_id=a")).json()
    assert len(only_a) == 1
    assert {k: only_a[0][k] for k in ("name", "ended_at", "end_reason", "failed_checks", "observed_seconds", "previous_up_at")} == {
        "name": "A", "ended_at": None, "end_reason": None, "failed_checks": 2, "observed_seconds": 300, "previous_up_at": None}
    only_b = (await api.get("/api/monitoring/incidents?target_id=b")).json()
    assert (only_b[0]["observed_seconds"], only_b[0]["end_reason"]) == (600, "recovered")
    assert [i["target_id"] for i in (await api.get("/api/monitoring/incidents?limit=1")).json()] == ["b"]
    history = (await api.get("/api/monitoring/targets/a/history")).json()
    assert [(h["checked_at"], h["status"], h["host"]) for h in history] == [
        (ping_monitor.iso(1300), "down", "opt-a"), (ping_monitor.iso(1000), "down", "opt-a")]
    assert [h["checked_at"] for h in (await api.get("/api/monitoring/targets/a/history?limit=1")).json()] == [ping_monitor.iso(1300)]


async def test_incident_csv_neutralizes_spreadsheet_formulas(api, factory, settings):
    formula = '=HYPERLINK("http://evil.example","x")'
    created = {}
    for name, host, rack in [(formula, "10.0.0.7", "+Rack 1"), ("@SUM(A1)", "10.0.0.8", "-2"), ("Opt-9", "10.0.0.9", "Rack 9")]:
        response = await api.post("/api/monitoring/targets", json={"name": name, "host": host, "rack": rack})
        assert response.status_code == 201, response.text
        created[host] = response.json()["id"]
    for host, target_id in created.items():
        await record(factory, target_id, host, "down", time.time())
    response = await api.get("/api/monitoring/incidents.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["cache-control"] == "no-store"
    assert 'attachment; filename="ping-incidents.csv"' == response.headers["content-disposition"]
    assert response.content.startswith(b"\xef\xbb\xbf")  # UTF-8 BOM so Excel keeps Hebrew names readable
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert rows[0][:3] == ["name", "host", "rack"]
    by_host = {row[1]: row for row in rows[1:]}
    assert by_host["10.0.0.7"][:3] == ["'" + formula, "10.0.0.7", "'+Rack 1"]
    assert by_host["10.0.0.8"][:3] == ["'@SUM(A1)", "10.0.0.8", "'-2"]
    assert by_host["10.0.0.9"][:3] == ["Opt-9", "10.0.0.9", "Rack 9"]  # inner '-' is harmless and untouched
    assert all(row[8] == "1" for row in rows[1:])  # failed_checks stays numeric


# ---------------------------------------------------------------- device observations / links

async def test_pdu_cycling_and_unknown_states_and_reset_device_labels_keep_the_server_link(api, factory, settings, monkeypatch):
    await add(factory, PingTarget(id="t", source_key="server:optn84", name="Optn84", host="10.0.0.84"),
              Device(id="pdu", name="PDU", kind="pdu", ip="10.1.1.1", labels_json="{}"))
    fetch = AsyncMock(return_value=PduStatus(device_id="pdu", reachable=True, outlets=[
        OutletState(number=1, label="Optn84", state="cycling"),
        OutletState(number=2, label="Optn84 (B)", state="flapping"),
    ]))
    monkeypatch.setattr(pdus, "_fetch_status", fetch)
    await monitor_links.refresh_devices(factory)
    links = (await first_target(api))["pdu"]
    assert [(p["port"], p["status"], p["detail"]) for p in links] == [
        ("1", "cycling", "PDU reports a power cycle in progress."),
        ("2", "unknown", "Device responded, but this port's live state is unavailable."),
    ]
    # The PDU was reset to factory outlet names: the learned server stays linked with the new live state.
    fetch.return_value = PduStatus(device_id="pdu", reachable=True, outlets=[
        OutletState(number=1, label="Outlet 1", state="off"),
        OutletState(number=2, label="Outlet 2", state="on"),
        OutletState(number=3, label="Outlet 3", state="on"),
    ])
    await monitor_links.refresh_devices(factory)
    links = (await first_target(api))["pdu"]
    assert [(p["port"], p["status"], p["device_reachable"]) for p in links] == [("1", "off", True), ("2", "on", True)]


async def test_unexpected_device_exception_is_explained_safely_and_counts_as_api_failure(api, factory, settings, monkeypatch):
    await add(factory, PingTarget(id="t", source_key="server:optn84", name="Optn84", host="10.0.0.84"),
              Device(id="pdu", name="PDU", kind="pdu", ip="10.1.1.3", labels_json=json.dumps({"1": "Optn84"})))

    async def boom(device_id, device):
        raise RuntimeError("401 Unauthorized https://admin:hunter2@10.1.1.3/rpc body=<secret-body>")
    monkeypatch.setattr(pdus, "_fetch_status", boom)
    await monitor_links.refresh_devices(factory)
    target = await first_target(api)
    link = target["pdu"][0]
    assert (link["status"], link["device_reachable"]) == ("error", False)
    assert link["detail"] == "Device authentication failed. Check the saved username, password and permissions."
    assert "hunter2" not in json.dumps(target) and "secret-body" not in json.dumps(target)
    assert "pdu" not in pdus._cache  # a failed check never seeds the shared status cache
    async with factory() as db:
        snapshot = await db.get(MonitorDeviceSnapshot, "pdu")
        diagnostic = await db.get(MonitorDeviceError, "pdu")
        condition = await db.get(AlertCondition, "device-api:pdu")
    assert snapshot.reachable is False and "hunter2" not in diagnostic.detail
    assert condition.started_at == condition.checked_at == snapshot.checked_at
    assert condition.notified is False and "hunter2" not in condition.configuration


# ---------------------------------------------------------------- alert confirmation / dedup

async def test_late_or_repeated_observations_never_duplicate_alerts_or_fake_recovery(factory, settings):
    await add(factory, PingTarget(id="one", source_key="server:opt1", name="OPT1", host="192.0.2.1"))
    for stamp in range(1000, 1421, 60):
        await network(factory, stamp)
    assert len(await emails(factory)) == 1
    await network(factory, 1420, "up")  # same instant as the last failure: ignored
    await network(factory, 1400, "up")  # older than the last observation: ignored
    await network(factory, 1480, "down")  # still the same episode
    assert len(await emails(factory)) == 1
    await network(factory, 1540, "up")
    await network(factory, 1540, "up")
    rows = await emails(factory)
    assert [("recovered" in r.subject) for r in rows] == [False, True]
    assert "First failed observation: " + alerts.local_time(1000) in rows[1].body
    async with factory() as db:
        state = await db.get(AlertCondition, "network:one")
    assert (state.notified, state.started_at, state.checked_at) == (False, None, 1540)


async def test_alert_subject_is_one_bounded_header_without_injection(factory, settings, monkeypatch):
    name = "Opt1\r\nBcc: attacker@example.test\r\n" + "x" * 400
    await add(factory, PingTarget(id="one", source_key="server:evil", name=name, host="192.0.2.5"))
    for stamp in range(1000, 1361, 60):
        await network(factory, stamp)
    (row,) = await emails(factory)
    assert "\r" not in row.subject and "\n" not in row.subject and len(row.subject) <= 240
    assert row.subject.startswith("[DCIM alert] Opt1 Bcc: attacker@example.test xxx")
    connection = fake_smtp_connection()
    monkeypatch.setattr(alerts.smtplib, "SMTP", Mock(return_value=connection))
    alerts.send_email(row, settings)
    message = connection.send_message.call_args.args[0]
    assert message["Bcc"] is None and message.get_all("To") == [settings.email_alerts_to]
    assert connection.send_message.call_args.kwargs["to_addrs"] == [settings.email_alerts_to]
    connection.login.assert_not_called()  # no username configured: never send empty credentials


async def test_delivery_keeps_order_during_backoff_and_caps_retry_delay(factory, settings):
    await alerts.ensure_worker(factory)
    async with factory() as db:
        assert await alerts.claim_worker(db, "w", time.time())
        alerts.enqueue(db, "network:one", "[DCIM alert] OPT1 down", "body", 1000, settings)
        alerts.enqueue(db, "network:one", "[DCIM recovered] OPT1 up", "body", 2000, settings)
        await db.commit()
    failing = Mock(side_effect=smtplib.SMTPServerDisconnected("relay said password=hunter2"))

    async def fail_once(attempts_before):
        async with factory() as db:
            alert = (await db.execute(select(AlertEmail).order_by(AlertEmail.created_at))).scalars().first()
            alert.attempts, alert.next_attempt_at = attempts_before, 0
            await db.commit()
        before = time.time()
        await alerts.deliver("w", factory, failing)
        after = time.time()
        alert, recovery = await emails(factory)
        assert alert.error == "SMTPServerDisconnected" and "hunter2" not in alert.error
        assert recovery.attempts == 0 and recovery.sent_at is None
        return alert.attempts, (alert.next_attempt_at - before, alert.next_attempt_at - after)

    attempts, (high, low) = await fail_once(0)
    assert attempts == 1 and low <= 30 <= high
    accepted = Mock()
    await alerts.deliver("w", factory, accepted)
    accepted.assert_not_called()  # the recovery never overtakes its pending alert
    attempts, (high, low) = await fail_once(1)
    assert attempts == 2 and low <= 60 <= high
    attempts, (high, low) = await fail_once(7)
    assert attempts == 8 and low <= 1800 <= high  # 30 * 2**6 = 1920 is capped at 30 minutes
    async with factory() as db:
        await db.execute(update(AlertEmail).values(next_attempt_at=0))
        await db.commit()
    await alerts.deliver("w", factory, accepted)
    assert [c.args[0].subject for c in accepted.call_args_list] == ["[DCIM alert] OPT1 down", "[DCIM recovered] OPT1 up"]
    assert all(row.sent_at is not None for row in await emails(factory))


@pytest.mark.parametrize("state,expected", [
    (None, "not_running"),
    ({"error": "OSError", "lease_until": 60}, "error"),
    ({"lease_until": 60}, "running"),
    ({"last_completed_at": -30}, "healthy"),
    ({"last_completed_at": -120}, "not_running"),
])
async def test_alert_worker_health_comes_from_durable_state(factory, settings, state, expected):
    now = time.time()
    if state is not None:
        await add(factory, AlertWorkerState(
            id=1, error=state.get("error", ""), lease_until=now + state["lease_until"] if "lease_until" in state else 0,
            last_completed_at=now + state["last_completed_at"] if "last_completed_at" in state else None))
    async with factory() as db:
        assert (await alerts.overview(db, settings))["worker"] == expected


async def test_alert_overview_rules_pending_recent_and_invalid_mail_blocks_delivery(factory, settings):
    settings.email_voltage_min, settings.email_watts_max = 200, 2500
    await alerts.ensure_worker(factory)
    async with factory() as db:
        assert await alerts.claim_worker(db, "w", time.time())
        for n in range(12):
            alerts.enqueue(db, f"k{n}", f"subject {n}", "body", 1000 + n, settings)
        await db.commit()
        await db.execute(update(AlertEmail).where(AlertEmail.created_at < 1003).values(sent_at=5000))
        await db.commit()
        view = await alerts.overview(db, settings)
    assert view["ready"] is True and view["problems"] == []
    assert view["power_rules"] == [{"metric": "voltage", "side": "min", "value": 200, "unit": "V"},
                                   {"metric": "watts", "side": "max", "value": 2500, "unit": "W"}]
    assert view["pending"] == 9
    assert [r["subject"] for r in view["recent"]] == [f"subject {n}" for n in range(11, 1, -1)]
    settings.smtp_host = "mail example.test"
    settings.smtp_security, settings.smtp_username = "plain", "relay-user"
    sender = Mock()
    await alerts.deliver("w", factory, sender)
    sender.assert_not_called()
    async with factory() as db:
        view = await alerts.overview(db, settings)
        attempted = await db.scalar(select(func.count()).select_from(AlertEmail).where(AlertEmail.attempts > 0))
    assert view["ready"] is False and attempted == 0
    assert {"SMTP host is missing or invalid", "SMTP authentication requires TLS"} <= set(view["problems"])


@pytest.mark.parametrize("minute_probes", [True, False])
async def test_worker_tick_purges_only_old_sent_mail_and_marks_completion(factory, settings, monkeypatch, minute_probes):
    settings.email_alerts_minute_probes = minute_probes
    rounds = AsyncMock()
    monkeypatch.setattr(alerts, "network_round", rounds)
    now = time.time()
    await alerts.ensure_worker(factory)
    async with factory() as db:
        state = await db.get(AlertWorkerState, 1)
        state.error, state.next_probe_at = "OSError", 0
        db.add_all([
            AlertEmail(id="old-sent", condition_key="k", created_at=now - 100 * DAY, recipient="a@example.test",
                       subject="s", body="b", next_attempt_at=0, sent_at=now - 91 * DAY),
            AlertEmail(id="recent-sent", condition_key="k", created_at=now - 89 * DAY, recipient="a@example.test",
                       subject="s", body="b", next_attempt_at=0, sent_at=now - 89 * DAY),
            AlertEmail(id="old-unsent", condition_key="k", created_at=now - 100 * DAY, recipient="a@example.test",
                       subject="s", body="b", next_attempt_at=now + 3600),
        ])
        await db.commit()
        assert await alerts.claim_worker(db, "w", now)
    await alerts.worker_tick("w", factory)
    async with factory() as db:
        remaining = {row.id for row in (await db.execute(select(AlertEmail))).scalars()}
        state = await db.get(AlertWorkerState, 1)
    assert remaining == {"recent-sent", "old-unsent"}  # unsent alerts are never purged
    assert state.error == "" and state.last_completed_at >= now
    if minute_probes:
        rounds.assert_awaited_once_with("w", factory)
        assert now + 59 <= state.next_probe_at <= time.time() + 60
    else:
        rounds.assert_not_awaited()
        assert state.next_probe_at == 0


async def test_power_limits_are_strict_and_unreachable_pdu_is_not_an_observation(factory, settings):
    settings.email_voltage_min, settings.email_watts_max = 200, 1000
    device = Device(id="pdu", name="PDU A", kind="pdu", ip="192.0.2.20", rack="R2")

    async def power(stamp, reachable=True, **reading):
        result = PduStatus(device_id="pdu", reachable=reachable, inlet_readings=[InletReading(number=1, **reading)] if reachable else [])
        async with factory() as db:
            await alerts.observe_power(db, device, result, stamp)
            await db.commit()
    await power(1000, voltage=200, watts=1000)  # exactly at the limits
    assert not await emails(factory)
    await power(1100, reachable=False)
    async with factory() as db:
        assert (await db.get(AlertCondition, "power:pdu:1:voltage:min")).checked_at == 1000
    await power(1200, voltage=199.5, watts=1000.5)
    rows = await emails(factory)
    assert sorted(r.subject for r in rows) == ["[DCIM alert] PDU A: inlet 1 voltage min", "[DCIM alert] PDU A: inlet 1 watts max"]
    voltage = next(r for r in rows if "voltage" in r.subject)
    assert "Measured: 199.5 V" in voltage.body and "Configured min: 200 V" in voltage.body


async def test_device_api_alert_state_does_not_reveal_the_shared_device_password(factory, settings):
    settings.pdu_username, settings.pdu_password = "ftlab", "Summer2024!"
    device = Device(id="pdu", name="PDU", kind="pdu", ip="192.0.2.30")  # no per-device credentials
    await add(factory, device)
    async with factory() as db:
        await alerts.observe_device_api(db, await db.get(Device, "pdu"), False, "Connection refused", 1000)
        await db.commit()
        configuration = (await db.get(AlertCondition, "device-api:pdu")).configuration
    assert "Summer2024!" not in configuration  # not stored in clear text
    wordlist = ["admin", "password", "raritan", "Summer2024!", "Winter2025!"]
    recovered = [word for word in wordlist
                 if hashlib.sha256(json.dumps(["", "", "ftlab", word]).encode()).hexdigest() in configuration]
    assert recovered == []


async def test_a_deploy_upgrades_the_old_device_api_fingerprint_without_a_repeat_alert_or_a_lost_recovery(factory, settings):
    """A state saved by the old code (unsalted SHA-256 of the same credentials) keeps its episode after the upgrade."""
    settings.pdu_username, settings.pdu_password = "ftlab", "Summer2024!"
    await add(factory, Device(id="pdu", name="PDU", kind="pdu", ip="192.0.2.30"))
    async with factory() as db:
        device = await db.get(Device, "pdu")
        credentials = json.dumps([device.username_enc, device.password_enc, "ftlab", "Summer2024!"])
    legacy = json.dumps(["pdu", "192.0.2.30", hashlib.sha256(credentials.encode()).hexdigest()])
    await add(factory, AlertCondition(key="device-api:pdu", configuration=legacy, started_at=1000, checked_at=1300,
                                      notified=True))

    async def observe(stamp, reachable):
        async with factory() as db:
            await alerts.observe_device_api(db, await db.get(Device, "pdu"), reachable, "Connection refused", stamp)
            await db.commit()
            return await db.get(AlertCondition, "device-api:pdu")
    state = await observe(1360, False)  # the same outage, observed by the upgraded code
    assert state.configuration != legacy and "Summer2024!" not in state.configuration
    assert (state.started_at, state.notified) == (1000, True) and await emails(factory) == []
    state = await observe(1420, True)
    assert [row.subject for row in await emails(factory)] == ["[DCIM recovered] PDU: PDU API availability"]
    assert state.notified is False
    upgraded = state.configuration
    settings.pdu_password = "Winter2025!"  # a real credential change still changes the stored fingerprint
    state = await observe(1480, True)
    assert state.configuration not in (upgraded, legacy) and "Winter2025!" not in state.configuration
