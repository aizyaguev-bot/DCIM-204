"""Unknown electrical readings must never become measured zeros."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.routers import pdus
from app.schemas import OutletState, PduStatus
from drivers.raritan_pdu import RaritanPduDriver, RaritanPduError


@pytest.mark.parametrize("reading,expected", [
    ({"value": 0, "valid": True, "available": True}, 0),
    ({"value": 12}, 12),
    ({"value": 12, "valid": False, "available": True}, None),
    ({"value": 12, "valid": True, "available": False}, None),
    ({"value": 12, "valid": True}, None),
    ({"value": float("nan"), "valid": True, "available": True}, None),
    ({"value": float("inf")}, None),
    ({"value": "bad"}, None),
    ({}, None),
])
async def test_outlet_reading_validation(reading, expected):
    driver = RaritanPduDriver("test", "user", "password")
    async def rpc(rid, method):
        if method == "getState":
            return {"powerState": 1}
        if method == "getSettings":
            return {}
        if method == "getSensors":
            return {"activePower": {"rid": "/power"}}
        return reading
    driver._rpc = rpc
    outlet = await driver._get_one_outlet(0, "/outlet")
    assert outlet["watts"] == expected
    assert outlet["current"] is None
    assert outlet["voltage"] is None
    assert outlet["state"] == "on"


async def test_missing_outlet_sensors_and_state():
    driver = RaritanPduDriver("test", "user", "password")
    driver._rpc = AsyncMock(return_value={})
    outlet = await driver._get_one_outlet(0, "/outlet")
    assert outlet["state"] == "unknown"
    assert all(outlet[key] is None for key in ("watts", "current", "voltage"))


async def test_exception_outlet_is_unknown():
    driver = RaritanPduDriver("test", "user", "password")
    driver._rpc = AsyncMock(side_effect=RaritanPduError("unreachable"))
    outlet = await driver._get_one_outlet(0, "/outlet")
    assert outlet["state"] == "unknown"
    assert all(outlet[key] is None for key in ("watts", "current", "voltage"))


async def test_missing_inlet_display_fields_are_null():
    driver = RaritanPduDriver("test", "user", "password")
    driver._get_inlet_rids = AsyncMock(return_value=["/inlet"])
    driver._rpc = AsyncMock(return_value={})
    inlet = await driver.get_inlet()
    assert all(inlet[key] is None for key in ("watts", "current", "voltage"))


@pytest.mark.parametrize("values,total,complete", [
    ([None, None], None, False), ([100, None], 100, False),
    ([0, 100], 100, True), ([0, 0], 0, True), ([], None, False),
])
async def test_totals_exclude_unknown(values, total, complete):
    driver = AsyncMock()
    driver.get_outlets.return_value = [
        {"number": n, "label": "test", "state": "on", "watts": value}
        for n, value in enumerate(values, 1)
    ]
    driver.get_inlet.return_value = {"voltage": None, "readings": []}
    driver.get_env_sensors.return_value = {}
    dev = SimpleNamespace(ip="test", labels_json="{}")
    with patch.object(pdus, "RaritanPduDriver", return_value=driver), patch.object(pdus, "get_creds", return_value=("u", "p")):
        status = await pdus._fetch_status("test", dev)
    assert status.reachable
    assert status.total_watts == total
    assert status.watts_complete is complete
    assert status.inlet_voltage is None
    driver.close.assert_awaited_once()


async def test_unreachable_status_has_no_readings():
    driver = AsyncMock()
    driver.get_outlets.side_effect = RaritanPduError("unreachable")
    dev = SimpleNamespace(ip="test", labels_json="{}")
    with patch.object(pdus, "RaritanPduDriver", return_value=driver), patch.object(pdus, "get_creds", return_value=("u", "p")):
        status = await pdus._fetch_status("test", dev)
    assert not status.reachable
    assert status.total_watts is None
    assert status.inlet_voltage is None
    assert not status.watts_complete
    assert status.outlets == status.inlet_readings == []


def test_nullable_schema_defaults():
    outlet = OutletState(number=1, label="test", state="unknown")
    assert outlet.watts is outlet.voltage is outlet.current is None
    status = PduStatus(device_id="test", reachable=False)
    assert status.total_watts is status.inlet_voltage is None
