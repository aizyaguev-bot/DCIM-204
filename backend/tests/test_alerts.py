"""Durable alert confirmation, recovery, SMTP retry and invalid sensor handling."""
import asyncio
import time
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app import alerts, ping_monitor
from app.config import Settings
from app.database import Base
from app.models import AlertCondition, AlertEmail, Device, PingSample, PingTarget
from app.schemas import InletReading, PduStatus
from drivers.raritan_pdu import RaritanPduDriver, RaritanPduError


@pytest.fixture
async def lab(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'alerts.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    settings = Settings(_env_file=None, email_alerts_enabled=True, email_alerts_minute_probes=True,
                        smtp_host="mail.example.test", email_alerts_from="dcim@example.test")
    monkeypatch.setattr(alerts, "get_settings", lambda: settings)
    monkeypatch.setattr(ping_monitor.inventory_store, "ITEMS_FILE", tmp_path / "items.json")
    async with factory() as db:
        db.add(PingTarget(id="one", name="OPT1", source_key="server:opt1", host="192.0.2.1", revision=0))
        await db.commit()
    await alerts.ensure_worker(factory)
    yield factory, settings
    await engine.dispose()


async def network(factory, stamp, status="down", minute=True):
    async with factory() as db:
        target = await db.get(PingTarget, "one")
        await alerts.observe_network(db, target, ping_monitor.ProbeResult(status, detail="test observation"), stamp, minute=minute)
        await db.commit()


async def emails(factory):
    async with factory() as db:
        return (await db.execute(select(AlertEmail).order_by(AlertEmail.created_at))).scalars().all()


async def test_short_outage_no_email_and_strict_five_minutes(lab):
    factory, _ = lab
    for stamp in range(1000, 1301, 60):
        await network(factory, stamp)
    assert not await emails(factory), "Exactly five minutes is not more than five minutes"
    await network(factory, 1360)
    await network(factory, 1420)
    assert len(await emails(factory)) == 1
    await network(factory, 1480, "up")
    await network(factory, 1540, "up")
    rows = await emails(factory)
    assert len(rows) == 2 and "recovered" in rows[1].subject
    assert rows[0].recipient == "aizyaguev@nvidia.com"
    assert "360 seconds" in rows[0].body


@pytest.mark.parametrize("interruption", ["error", "gap", "address"])
async def test_confirmation_does_not_count_unknown_time_or_old_address(lab, interruption):
    factory, _ = lab
    for stamp in range(1000, 1241, 60):
        await network(factory, stamp)
    if interruption == "error":
        await network(factory, 1300, "error")
    elif interruption == "address":
        async with factory() as db:
            t = await db.get(PingTarget, "one")
            t.host, t.revision = "192.0.2.2", 1
            await db.commit()
    await network(factory, 2000 if interruption == "gap" else 1360)
    assert not await emails(factory)


async def test_unknown_does_not_report_recovery_and_episode_survives_restart(lab):
    factory, _ = lab
    for stamp in range(1000, 1421, 60):
        await network(factory, stamp)
    await network(factory, 1500, "error")
    await alerts.ensure_worker(factory)  # Reopening state must not re-send the episode.
    await network(factory, 4000)
    assert len(await emails(factory)) == 1
    await network(factory, 4060, "up")
    assert len(await emails(factory)) == 2


async def test_disabled_and_selected_observation_cadence(lab):
    factory, settings = lab
    settings.email_alerts_enabled = False
    for stamp in range(1000, 1500, 60):
        await network(factory, stamp)
    assert not await emails(factory)
    settings.email_alerts_enabled = True
    await network(factory, 1600, minute=False)
    async with factory() as db:
        assert await db.get(AlertCondition, "network:one") is None


async def test_scheduled_night_checks_can_alert_but_detection_is_delayed(lab):
    from datetime import datetime
    factory, settings = lab
    settings.email_alerts_minute_probes = False
    base = datetime.fromisoformat("2026-09-30T22:00:00+03:00").timestamp()
    await network(factory, base, minute=False)
    await network(factory, base + 1800, minute=False)
    assert len(await emails(factory)) == 1


async def test_power_unknown_not_zero_all_inlets_and_one_message_per_episode(lab):
    factory, settings = lab
    settings.email_voltage_min, settings.email_watts_max = 200, 1000
    device = Device(id="pdu", name="PDU test", kind="pdu", ip="192.0.2.10", rack="R1")
    async def power(stamp, voltage=None, watts=None):
        result = PduStatus(device_id="pdu", reachable=True, inlet_readings=[
            InletReading(number=1), InletReading(number=2, voltage=voltage, watts=watts)])
        async with factory() as db:
            await alerts.observe_power(db, device, result, stamp)
            await db.commit()
    await power(1000)
    assert not await emails(factory)
    await power(1100, voltage=0, watts=1100)
    await power(1200, voltage=0, watts=1200)
    rows = await emails(factory)
    assert len(rows) == 2 and all("inlet 2" in r.subject for r in rows)
    await power(1300)
    assert len(await emails(factory)) == 2
    await power(1400, voltage=230, watts=900)
    assert len(await emails(factory)) == 4


async def test_worker_lease_and_delivery_retry_are_durable(lab):
    factory, settings = lab
    for stamp in range(1000, 1421, 60):
        await network(factory, stamp)
    async with factory() as db:
        assert await alerts.claim_worker(db, "worker", time.time())
    async with factory() as db:
        assert not await alerts.claim_worker(db, "other", time.time())
    failing = Mock(side_effect=OSError("secret password should not be saved"))
    await alerts.deliver("worker", factory, failing)
    row = (await emails(factory))[0]
    assert row.sent_at is None and row.attempts == 1 and row.error == "OSError"
    accepted = Mock()
    await alerts.deliver("worker", factory, accepted)
    accepted.assert_not_called()
    async with factory() as db:
        (await db.get(AlertEmail, row.id)).next_attempt_at = 0
        await db.commit()
    await alerts.deliver("worker", factory, accepted)
    await alerts.deliver("worker", factory, accepted)
    accepted.assert_called_once()
    assert (await emails(factory))[0].sent_at is not None


async def test_minute_round_rechecks_pause_and_does_not_change_scheduled_history(lab):
    factory, _ = lab
    async with factory() as db:
        assert await alerts.claim_worker(db, "worker", time.time())
    async def probe(host):
        async with factory() as db:
            (await db.get(PingTarget, "one")).enabled = False
            await db.commit()
        return ping_monitor.ProbeResult("down")
    await alerts.network_round("worker", factory, probe)
    async with factory() as db:
        assert await db.get(AlertCondition, "network:one") is None
        assert (await db.execute(select(PingSample))).scalars().all() == []


async def test_cancelled_round_reaps_probes(lab):
    factory, _ = lab
    async with factory() as db:
        await alerts.claim_worker(db, "worker", time.time())
    started, stopped = asyncio.Event(), asyncio.Event()
    async def probe(host):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    task = asyncio.create_task(alerts.network_round("worker", factory, probe))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped.is_set()


def test_smtp_transport_uses_tls_and_stable_message_id(monkeypatch):
    settings = Settings(_env_file=None, smtp_host="mail.example.test", smtp_username="account",
                        smtp_password="secret", email_alerts_from="dcim@example.test")
    connection = Mock()
    connection.__enter__ = Mock(return_value=connection)
    connection.__exit__ = Mock(return_value=False)
    smtp = Mock(return_value=connection)
    monkeypatch.setattr(alerts.smtplib, "SMTP", smtp)
    row = AlertEmail(id="abc", recipient="aizyaguev@nvidia.com", subject="Test", body="Body", created_at=1000)
    alerts.send_email(row, settings)
    connection.starttls.assert_called_once()
    connection.login.assert_called_once_with("account", "secret")
    args, kwargs = connection.send_message.call_args
    assert args[0]["Message-ID"] == "<dcim-abc@example.test>"
    assert kwargs["to_addrs"] == ["aizyaguev@nvidia.com"]
    assert "secret" not in repr(settings)


def test_configuration_rejects_bad_bounds_and_header_injection():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, email_voltage_min=240, email_voltage_max=220)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, email_watts_max=float("nan"))
    settings = Settings(_env_file=None, email_alerts_to="a@b.com\r\nBcc: bad@b.com")
    assert any("Recipient" in p for p in alerts.mail_problems(settings))
    settings.smtp_security, settings.smtp_username = "plain", "account"
    assert "SMTP authentication requires TLS" in alerts.mail_problems(settings)


async def test_driver_only_exposes_valid_available_finite_inlet_readings(monkeypatch):
    driver = RaritanPduDriver("192.0.2.10", "user", "password")
    monkeypatch.setattr(driver, "_get_inlet_rids", AsyncMock(return_value=["first", "second"]))
    async def rpc(rid, method):
        if method == "getSensors":
            return {"voltage": {"rid": rid+"/v"}, "current": {"rid": rid+"/a"}, "activePower": {"rid": rid+"/w"}}
        if rid == "first/v":
            return {"value": 0, "valid": False, "available": True}
        if rid.endswith("/a"):
            return {"value": 5, "valid": True, "available": False}
        if rid.endswith("/w"):
            raise RaritanPduError("unavailable")
        return {"value": 230, "valid": True, "available": True}
    monkeypatch.setattr(driver, "_rpc", rpc)
    try:
        result = await driver.get_inlet()
        assert result["readings"][0]["voltage"] is None
        assert result["readings"][1] == {"number":2, "voltage":230, "current":None, "watts":None}
    finally:
        await driver.close()
