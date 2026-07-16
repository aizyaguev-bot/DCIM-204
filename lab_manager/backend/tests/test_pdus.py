"""
Unit tests for PDU status caching, label overlay, and power action endpoints.

All tests mock the Raritan hardware driver so no live PDU is required.
"""
import time
from unittest.mock import AsyncMock, patch

import pytest

import app.routers.pdus as pdus_module
from app.schemas import OutletState, PduStatus

# ── Helpers ───────────────────────────────────────────────────────────────────

def make_pdu_status(device_id="dev1", outlets=None):
    return PduStatus(
        device_id=device_id,
        reachable=True,
        inlet_voltage=120.0,
        total_watts=500.0,
        outlets=outlets or [
            OutletState(number=1, label="Server-A", state="on", watts=200.0),
            OutletState(number=2, label="Server-B", state="off", watts=0.0),
        ],
    )


@pytest.fixture
async def pdu_device(client):
    r = await client.post("/api/devices/", json={
        "name": "PDU-Rack1", "kind": "pdu", "ip": "10.7.30.100",
        "model": "PX4", "rack": "R1", "port_count": 24,
    })
    return r.json()


# ── Status endpoint ───────────────────────────────────────────────────────────

async def test_pdu_status_404_for_unknown_device(client):
    r = await client.get("/api/pdus/nonexistent/status")
    assert r.status_code == 404


async def test_pdu_status_returns_fresh_cached_data(client, pdu_device):
    dev_id = pdu_device["id"]
    pdus_module._cache[dev_id] = (time.monotonic(), make_pdu_status(device_id=dev_id))
    r = await client.get(f"/api/pdus/{dev_id}/status")
    assert r.status_code == 200
    data = r.json()
    assert data["reachable"] is True
    assert data["inlet_voltage"] == 120.0


async def test_pdu_status_fresh_cache_does_not_call_driver(client, pdu_device):
    dev_id = pdu_device["id"]
    pdus_module._cache[dev_id] = (time.monotonic(), make_pdu_status(device_id=dev_id))
    with patch.object(pdus_module, "_fetch_status", AsyncMock()) as mock_fetch:
        await client.get(f"/api/pdus/{dev_id}/status")
    mock_fetch.assert_not_called()


async def test_pdu_status_applies_db_labels_to_cached_outlets(client, pdu_device):
    dev_id = pdu_device["id"]
    cached = make_pdu_status(device_id=dev_id, outlets=[
        OutletState(number=1, label="Outlet 1", state="on", watts=100.0),
    ])
    pdus_module._cache[dev_id] = (time.monotonic(), cached)
    # Save a label override in the DB
    await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "GPU-Node"})
    r = await client.get(f"/api/pdus/{dev_id}/status")
    assert r.json()["outlets"][0]["label"] == "GPU-Node"


async def test_pdu_status_first_load_calls_driver(client, pdu_device):
    dev_id = pdu_device["id"]
    mock_status = PduStatus(device_id=dev_id, reachable=False, error="timeout")
    with patch.object(pdus_module, "_fetch_status", AsyncMock(return_value=mock_status)):
        r = await client.get(f"/api/pdus/{dev_id}/status")
    assert r.status_code == 200
    assert r.json()["reachable"] is False


# ── Power action endpoint ─────────────────────────────────────────────────────

async def test_outlet_power_404_for_unknown_device(client):
    r = await client.post("/api/pdus/bad-id/outlets/1/power", json={"action": "on"})
    assert r.status_code == 404


async def test_outlet_power_invalidates_cache(client, pdu_device):
    dev_id = pdu_device["id"]
    pdus_module._cache[dev_id] = (time.monotonic(), make_pdu_status(device_id=dev_id))

    mock_driver = AsyncMock()
    mock_driver.set_outlet_state = AsyncMock(return_value=True)
    mock_driver.close = AsyncMock()

    with patch.object(pdus_module, "RaritanPduDriver", return_value=mock_driver):
        r = await client.post(f"/api/pdus/{dev_id}/outlets/1/power", json={"action": "on"})

    assert r.status_code == 200
    assert dev_id not in pdus_module._cache


# ── Background refresh helper ─────────────────────────────────────────────────

async def test_refresh_background_skips_if_already_in_progress():
    dev_id = "test-dev"
    pdus_module._refreshing.add(dev_id)
    with patch.object(pdus_module, "_fetch_status", AsyncMock()) as mock_fetch:
        await pdus_module._refresh_background(dev_id, object())
    mock_fetch.assert_not_called()
    pdus_module._refreshing.discard(dev_id)
