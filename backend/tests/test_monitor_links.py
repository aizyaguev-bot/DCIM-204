"""Server associations must not turn missing, stale or inferred states green."""
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import pytest
from httpx import ASGITransport, AsyncClient, BasicAuth
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import monitor_links, ping_monitor
from app.database import Base, get_db
from app.models import Device, MonitorDeviceSnapshot, PingTarget
from app.routers import monitoring, pdus, kvms
from app.schemas import KvmPort, KvmStatus, OutletState, PduStatus
from drivers.raritan_kvm import RaritanKvmDriver


@pytest.fixture
async def lab(tmp_path, monkeypatch):
    import app.main as main
    from app.config import Settings
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'links.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(ping_monitor.inventory_store, "ITEMS_FILE", tmp_path / "items.json")
    monkeypatch.setattr(pdus, "_cache", {})
    monkeypatch.setattr(kvms, "_cache", {})
    settings = Settings(lab_manager_password="test-links")
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(monitoring, "get_settings", lambda: settings)
    async def dependency():
        async with factory() as db:
            yield db
    main.app.dependency_overrides[get_db] = dependency
    async with factory() as db:
        db.add(PingTarget(id="target", source_key="server:optn84", name="Optn84", host="10.0.0.84"))
        await db.commit()
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test", auth=BasicAuth("", "test-links")) as client:
            yield factory, client
    finally:
        main.app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


def device(id, kind="pdu", labels=None, **kwargs):
    return Device(id=id, name=id.upper(), kind=kind, ip="10.1.1." + str(len(id)),
                  labels_json=json.dumps(labels or {}), **kwargs)


async def add_devices(factory, *devices):
    async with factory() as db:
        db.add_all(devices)
        await db.commit()


async def target_view(client):
    response = await client.get("/api/monitoring")
    assert response.status_code == 200
    return response.json()["targets"][0]


async def test_multiple_power_feeds_and_live_kvm_are_persisted_and_joined_by_name(lab, monkeypatch):
    factory, client = lab
    await add_devices(factory, device("pdu-a", labels={"2": "OPTN84"}),
                      device("pdu-b", labels={"7": "Optn84 (2)"}),
                      device("kvm", "kvm", {"9": "optn84"}),
                      device("unrelated", labels={"2": "optn85"}))
    async def pdu_status(id, dev):
        number, state = (7, "off") if id == "pdu-b" else (2, "on")
        return PduStatus(device_id=id, reachable=True, outlets=[OutletState(number=number, label="Wrong cached label", state=state)])
    monkeypatch.setattr(pdus, "_fetch_status", pdu_status)
    monkeypatch.setattr(kvms, "_fetch_status", AsyncMock(return_value=KvmStatus(device_id="kvm", reachable=True, ports=[
        KvmPort(number=9, label="Port 9", status="active", status_source="live"),
    ])))
    await monitor_links.refresh_devices(factory)
    # Another worker/restart has empty in-memory caches but the same DB.
    pdus._cache.clear()
    kvms._cache.clear()
    target = await target_view(client)
    assert [(p["device_id"], p["port"], p["status"]) for p in target["pdu"]] == [("pdu-a", "2", "on"), ("pdu-b", "7", "off")]
    assert target["kvm"][0]["status"] == "active"
    assert all(p["checked_at"] and p["device_reachable"] for p in target["pdu"])
    assert target["host"] == "10.0.0.84"
    assert "password" not in json.dumps(target)


@pytest.mark.parametrize("failure", ["exception", "unreachable"])
async def test_failed_check_retains_live_only_association_but_never_old_success(lab, monkeypatch, failure):
    factory, client = lab
    await add_devices(factory, device("pdu"))
    fetch = AsyncMock(return_value=PduStatus(device_id="pdu", reachable=True, outlets=[
        OutletState(number=3, label="Optn84 (SSD)", state="on"),
    ]))
    monkeypatch.setattr(pdus, "_fetch_status", fetch)
    await monitor_links.refresh_devices(factory)
    assert (await target_view(client))["pdu"][0]["status"] == "on"
    if failure == "exception":
        fetch.side_effect = TimeoutError("test timeout")
    else:
        fetch.return_value = PduStatus(device_id="pdu", reachable=False, error="test credentials rejected")
    await monitor_links.refresh_devices(factory)
    connection = (await target_view(client))["pdu"][0]
    assert connection["port"] == "3" and connection["status"] == "error"
    assert connection["device_reachable"] is False


async def test_stale_disabled_and_reconfigured_devices_cannot_show_green(lab, monkeypatch):
    factory, client = lab
    await add_devices(factory, device("pdu", labels={"1": "Optn84"}))
    monkeypatch.setattr(pdus, "_fetch_status", AsyncMock(return_value=PduStatus(device_id="pdu", reachable=True, outlets=[
        OutletState(number=1, label="Optn84", state="on"),
    ])))
    await monitor_links.refresh_devices(factory)
    async with factory() as db:
        snapshot = await db.get(MonitorDeviceSnapshot, "pdu")
        now = ping_monitor.next_slot(snapshot.checked_at, ZoneInfo("Asia/Jerusalem")) + 121
    monkeypatch.setattr(monitoring.time, "time", lambda: now)
    connection = (await target_view(client))["pdu"][0]
    assert connection["status"] == "stale" and connection["device_reachable"] is None
    async with factory() as db:
        dev = await db.get(Device, "pdu")
        dev.enabled = False
        await db.commit()
    assert (await target_view(client))["pdu"][0]["status"] == "disabled"
    async with factory() as db:
        dev = await db.get(Device, "pdu")
        dev.enabled, dev.ip = True, "10.2.2.2"
        await db.commit()
    connection = (await target_view(client))["pdu"][0]
    assert connection["status"] == "pending" and connection["checked_at"] is None


@pytest.mark.parametrize("source,raw,expected", [
    ("live", "idle", "idle"), ("live", "empty", "empty"),
    ("configured", "idle", "configured"), ("configured", "empty", "empty"),
    ("unknown", "idle", "unknown"), ("unknown", "active", "unknown"),
])
async def test_kvm_live_state_is_distinct_from_configuration_or_fallback(lab, monkeypatch, source, raw, expected):
    factory, client = lab
    await add_devices(factory, device("kvm", "kvm", {"1": "Optn84"}))
    monkeypatch.setattr(kvms, "_fetch_status", AsyncMock(return_value=KvmStatus(device_id="kvm", reachable=True, ports=[
        KvmPort(number=1, label="Optn84", status=raw, status_source=source),
    ])))
    await monitor_links.refresh_devices(factory)
    target = await target_view(client)
    assert target["kvm"][0]["status"] == expected
    assert target["pdu"] == []


async def test_missing_port_and_label_changes_do_not_reuse_success(lab, monkeypatch):
    factory, client = lab
    await add_devices(factory, device("pdu", labels={"1": "Optn84"}))
    fetch = AsyncMock(return_value=PduStatus(device_id="pdu", reachable=True, outlets=[OutletState(number=1, label="Optn84", state="on")]))
    monkeypatch.setattr(pdus, "_fetch_status", fetch)
    await monitor_links.refresh_devices(factory)
    fetch.return_value = PduStatus(device_id="pdu", reachable=True, outlets=[])
    await monitor_links.refresh_devices(factory)
    assert (await target_view(client))["pdu"][0]["status"] == "unknown"
    async with factory() as db:
        dev = await db.get(Device, "pdu")
        dev.labels_json = json.dumps({"1": "DifferentServer"})
        await db.commit()
    assert (await target_view(client))["pdu"] == []


async def test_polling_skips_disabled_devices_and_ignores_in_flight_config_changes(lab, monkeypatch):
    factory, client = lab
    await add_devices(factory, device("pdu", labels={"1": "Optn84"}), device("disabled", enabled=False))
    async def fetch(id, dev):
        assert id == "pdu"
        async with factory() as db:
            current = await db.get(Device, id)
            current.ip = "10.9.9.9"
            await db.commit()
        return PduStatus(device_id=id, reachable=True, outlets=[OutletState(number=1, label="Optn84", state="on")])
    monkeypatch.setattr(pdus, "_fetch_status", fetch)
    await monitor_links.refresh_devices(factory)
    async with factory() as db:
        assert (await db.execute(select(MonitorDeviceSnapshot))).scalars().all() == []
    assert "pdu" not in pdus._cache
    assert (await target_view(client))["pdu"][0]["status"] == "pending"


@pytest.mark.parametrize("raw,expected,source", [
    ("active", "active", "live"), ("idle", "idle", "live"),
    (0, "empty", "live"), (False, "empty", "live"),
    (None, "idle", "unknown"), ("new-undocumented-state", "idle", "unknown"),
])
async def test_kvm_rest_uses_explicit_port_number_and_flags_unknown_states(monkeypatch, raw, expected, source):
    driver = RaritanKvmDriver("example.invalid", "", "")
    response = SimpleNamespace(status_code=200, json=lambda: [{"portNumber": 9, "name": "Optn84", "connectionStatus": raw}])
    monkeypatch.setattr(driver, "_client_ctx", AsyncMock(return_value=SimpleNamespace(get=AsyncMock(return_value=response))))
    ports = await driver._get_ports_rest()
    assert ports == [{"number": 9, "label": "Optn84", "status": expected, "status_source": source}]


async def test_kvm_rest_guessed_number_and_static_fallback_are_unverified(monkeypatch):
    driver = RaritanKvmDriver("example.invalid", "", "", model="LX II")
    response = SimpleNamespace(status_code=200, json=lambda: [{"name": "Optn84", "status": "active"}])
    monkeypatch.setattr(driver, "_client_ctx", AsyncMock(return_value=SimpleNamespace(get=AsyncMock(return_value=response))))
    assert (await driver._get_ports_rest())[0]["status_source"] == "unknown"
    monkeypatch.setattr(driver, "_get_ports_sidebar", AsyncMock(side_effect=RuntimeError("offline")))
    ports = await driver.get_ports(2)
    assert len(ports) == 2 and all(p["status_source"] == "unknown" for p in ports)


async def test_kvm_sidebar_reports_configuration_not_live_health(monkeypatch):
    driver = RaritanKvmDriver("example.invalid", "", "", model="LX II")
    response = SimpleNamespace(status_code=200, text="J('PortId','target');J('PortNumber',2)")
    monkeypatch.setattr(driver, "_client_ctx", AsyncMock(return_value=SimpleNamespace(get=AsyncMock(return_value=response))))
    ports = await driver._get_ports_sidebar(2)
    assert [(p["status"], p["status_source"]) for p in ports] == [("empty", "configured"), ("idle", "configured")]


async def test_scheduled_round_records_ping_and_device_observations_without_a_browser(lab, monkeypatch):
    factory, client = lab
    await add_devices(factory, device("pdu", labels={"1": "Optn84"}))
    fetch = AsyncMock(return_value=PduStatus(device_id="pdu", reachable=True, outlets=[
        OutletState(number=1, label="Optn84", state="off"),
    ]))
    monkeypatch.setattr(pdus, "_fetch_status", fetch)
    await ping_monitor.ensure_state(factory)
    async with factory() as db:
        assert await ping_monitor.claim_round(db, "test-worker", time.time(), ZoneInfo("Asia/Jerusalem"))
    probe = AsyncMock(return_value=ping_monitor.ProbeResult("up", 1.5))
    await ping_monitor.run_round("test-worker", factory, probe)
    fetch.assert_awaited_once()
    probe.assert_awaited_once_with("10.0.0.84")
    target = await target_view(client)
    assert target["status"] == "up" and target["pdu"][0]["status"] == "off"


async def test_additive_upgrade_preserves_existing_monitor_and_device_data(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'upgrade.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        old_tables = [table for table in Base.metadata.sorted_tables if table.name != "monitor_device_snapshots"]
        async with engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=old_tables))
        async with factory() as db:
            db.add(device("existing"))
            db.add(PingTarget(id="existing", source_key="server:existing", name="Existing", host="10.0.0.10", status="up", checked_at=1000))
            await db.commit()
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with factory() as db:
            assert (await db.get(PingTarget, "existing")).checked_at == 1000
            assert (await db.get(Device, "existing")).name == "EXISTING"
            assert (await db.execute(select(MonitorDeviceSnapshot))).scalars().all() == []
    finally:
        await engine.dispose()
