"""
Unit tests for PDU status caching, label overlay, and power action endpoints.

All tests mock the Raritan hardware driver so no live PDU is required.
"""
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

import app.routers.pdus as pdus_module
from app.monitor_links import failure_reason
from app.schemas import OutletState, PduStatus
from drivers.raritan_pdu import RaritanPduDriver

# ── Helpers ───────────────────────────────────────────────────────────────────
SECRET = "synthetic-secret-7f3a"


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


async def test_pdu_status_stale_cache_returns_current_labels(client, pdu_device, monkeypatch):
    dev_id = pdu_device["id"]
    cached = make_pdu_status(device_id=dev_id, outlets=[
        OutletState(number=1, label="Old-Name", state="on", watts=100.0),
    ])
    pdus_module._cache[dev_id] = (time.monotonic() - pdus_module._CACHE_TTL - 10, cached)
    refreshed = []

    async def refresh(device_id, dev):
        refreshed.append(device_id)
    monkeypatch.setattr(pdus_module, "_refresh_background", refresh)
    await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "GPU-Node"})
    r = await client.get(f"/api/pdus/{dev_id}/status")
    assert r.json()["outlets"][0]["label"] == "GPU-Node"
    assert refreshed == [dev_id]  # still refreshed in the background


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


async def test_outlet_power_failure_detail_is_secret_free(client, pdu_device):
    dev_id = pdu_device["id"]
    driver = RaritanPduDriver("pdu.example.invalid", "admin", SECRET)
    request = httpx.Request("POST", "https://pdu.example.invalid/model/pdu/1")
    driver._client_ctx = AsyncMock(return_value=SimpleNamespace(post=AsyncMock(
        return_value=httpx.Response(403, text=f"denied {SECRET}", request=request))))
    with patch.object(pdus_module, "RaritanPduDriver", return_value=driver):
        r = await client.post(f"/api/pdus/{dev_id}/outlets/1/power", json={"action": "on"})
    assert r.status_code == 502
    assert r.json()["detail"] == "Device API responded with HTTP 403"


async def test_outlet_power_unknown_action_is_rejected_without_echo(client, pdu_device):
    dev_id = pdu_device["id"]
    driver = RaritanPduDriver("pdu.example.invalid", "admin", SECRET)
    driver._get_outlet_rids = AsyncMock(return_value=["/outlet.0"])
    with patch.object(pdus_module, "RaritanPduDriver", return_value=driver):
        r = await client.post(f"/api/pdus/{dev_id}/outlets/1/power", json={"action": SECRET})
    assert r.status_code == 400 and SECRET not in r.text


# ── Failure classes never carry device text ───────────────────────────────────

_REQUEST = httpx.Request("POST", f"https://admin:{SECRET}@pdu.example.invalid/model/pdu/1")


def _response(status, text):
    return httpx.Response(status, text=text, request=_REQUEST)


@pytest.mark.parametrize("post,error,reason", [
    ({"return_value": _response(401, f"<html>login {SECRET}</html>")}, "HTTP 401", "authentication failed"),
    ({"return_value": _response(503, f"busy {SECRET}")}, "HTTP 503", "HTTP 5xx"),
    ({"return_value": _response(407, f"proxy {SECRET}")}, "HTTP 407", "Proxy error"),
    ({"return_value": _response(200, f"not json {SECRET}")}, "invalid response", "no usable status"),
    ({"return_value": _response(200, '{"error": {"code": 2, "message": "%s"}}' % SECRET)}, "RPC error 2", "no usable status"),
    ({"return_value": _response(200, '{"error": {"code": "%s"}}' % SECRET)}, "RPC error ?", "no usable status"),
    ({"side_effect": httpx.ConnectTimeout(SECRET)}, "ConnectTimeout", "could not establish"),
    ({"side_effect": httpx.ReadTimeout(SECRET)}, "ReadTimeout", "receiving data"),
    ({"side_effect": httpx.PoolTimeout(SECRET)}, "PoolTimeout", "local connection slot"),
    ({"side_effect": httpx.ProxyError(SECRET)}, "ProxyError", "Proxy error"),
    ({"side_effect": httpx.ConnectError(f"[Errno 111] Connection refused {SECRET}")}, "connection refused", "Connection refused"),
    ({"side_effect": httpx.ConnectError(f"[Errno -2] Name or service not known {SECRET}")}, "DNS failure", "DNS failure"),
    ({"side_effect": httpx.ConnectError(f"[Errno 113] No route to host {SECRET}")}, "network unreachable", "Network unreachable"),
    ({"side_effect": httpx.ConnectError(f"[SSL: CERTIFICATE_VERIFY_FAILED] {SECRET}")}, "TLS handshake", "TLS error"),
    ({"side_effect": httpx.ConnectError(f"https://admin:{SECRET}@pdu")}, "connection error", "Could not connect"),
])
async def test_pdu_status_error_is_fixed_class_without_secret(post, error, reason):
    driver = RaritanPduDriver("pdu.example.invalid", "admin", SECRET)
    driver._client_ctx = AsyncMock(return_value=SimpleNamespace(
        post=AsyncMock(**post), get=AsyncMock(side_effect=httpx.ConnectError(SECRET))))
    dev = SimpleNamespace(ip="pdu.example.invalid", labels_json="{}")
    with patch.object(pdus_module, "RaritanPduDriver", return_value=driver), \
         patch.object(pdus_module, "get_creds", return_value=("admin", SECRET)):
        status = await pdus_module._fetch_status("pdu", dev)
    assert not status.reachable
    assert error in status.error
    assert SECRET not in status.model_dump_json()
    explained = failure_reason(status.error)
    assert reason in explained and SECRET not in explained


async def test_sensor_debug_returns_numbers_only():
    driver = RaritanPduDriver("pdu.example.invalid", "admin", SECRET)
    request = httpx.Request("GET", f"https://admin:{SECRET}@pdu.example.invalid/port")

    async def get(url):
        return httpx.Response(200, text=f"<html>{SECRET}</html>", request=request)

    async def rpc(path, method, params=None):
        if method == "createChannel":
            raise httpx.ConnectError(f"https://proxy-user:{SECRET}@example.test")
        return [{"rid": f"/sensor/{SECRET}", "reading": {"value": 21.5, "note": SECRET}}]

    driver._client_ctx = AsyncMock(return_value=SimpleNamespace(get=get))
    driver._rpc = rpc
    result = await driver.list_sensors()
    encoded = json.dumps(result)
    assert SECRET not in encoded
    assert "proxy-user" not in encoded
    assert result["GET_port"] == {"status": 200}
    assert "Connect" in result["channel_error"] or "connection" in result["channel_error"].lower()


async def test_sensor_debug_keeps_numeric_samples_and_drops_event_text():
    driver = RaritanPduDriver("pdu.example.invalid", "admin", SECRET)
    request = httpx.Request("GET", "https://pdu.example.invalid/port")

    async def get(url):
        raise httpx.ConnectError(f"https://proxy-user:{SECRET}@example.test")

    async def rpc(path, method, params=None):
        if method == "createChannel":
            return {"rid": "/eventservice/channel-1"}
        if method == "pollEvents":
            return [{"rid": "/sensors/temp", "reading": {"value": 22, "message": SECRET}}, "not-a-sample"]
        return None

    driver._client_ctx = AsyncMock(return_value=SimpleNamespace(get=get))
    driver._rpc = rpc
    result = await driver.list_sensors()
    encoded = json.dumps(result)
    assert SECRET not in encoded
    assert result["sensors"] == [{"name": "temp", "value": 22.0}]
    assert result["GET_port"]["error"].startswith("Device API")


async def test_unexpected_exception_text_is_not_returned():
    driver = AsyncMock()
    driver.get_outlets.side_effect = KeyError(SECRET)
    dev = SimpleNamespace(ip="pdu.example.invalid", labels_json="{}")
    with patch.object(pdus_module, "RaritanPduDriver", return_value=driver), \
         patch.object(pdus_module, "get_creds", return_value=("admin", SECRET)):
        status = await pdus_module._fetch_status("pdu", dev)
    assert status.error == "Device API returned no usable status (KeyError)"
    assert "no usable status" in failure_reason(status.error)


# ── Background refresh helper ─────────────────────────────────────────────────

async def test_refresh_background_skips_if_already_in_progress():
    dev_id = "test-dev"
    pdus_module._refreshing.add(dev_id)
    with patch.object(pdus_module, "_fetch_status", AsyncMock()) as mock_fetch:
        await pdus_module._refresh_background(dev_id, object())
    mock_fetch.assert_not_called()
    pdus_module._refreshing.discard(dev_id)
