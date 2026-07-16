"""
Unit tests for KVM status caching, in-use tracking overlay, and auto-clear logic.

All tests mock the Raritan hardware driver so no live KVM is required.
Integration tests against real KVMs live in test_kvm_regression.py.
"""
import time
from unittest.mock import AsyncMock, patch

import app.routers.kvms as kvms_module
from app.routers.kvms import _IN_USE_TTL, _apply_overlays
from app.schemas import KvmPort, KvmStatus

# ── Helpers ───────────────────────────────────────────────────────────────────

def make_port(number=1, label="Server-A", status="idle", in_use=False):
    return KvmPort(number=number, label=label, status=status, in_use=in_use)


def make_status(ports=None, device_id="dev1", reachable=True):
    return KvmStatus(
        device_id=device_id,
        reachable=reachable,
        ports=ports or [make_port()],
    )


# Shared fixture: a KVM device in the in-memory DB
import pytest

@pytest.fixture
async def kvm_device(client):
    r = await client.post("/api/devices/", json={
        "name": "KVM-Unit-1", "kind": "kvm", "ip": "10.7.30.49",
        "model": "KX III", "rack": "R1", "port_count": 8,
    })
    return r.json()


# ── _apply_overlays — pure logic, no I/O ─────────────────────────────────────

def test_apply_overlays_unchanged_when_nothing_to_apply():
    status = make_status()
    result = _apply_overlays("dev1", status, {})
    assert result is status  # same object — no copy made


def test_apply_overlays_sets_in_use_for_tracked_port():
    status = make_status([make_port(number=1, status="idle")])
    kvms_module._in_use["dev1"] = {1: time.monotonic() + 3600}
    result = _apply_overlays("dev1", status, {})
    assert result.ports[0].in_use is True


def test_apply_overlays_ignores_expired_in_use_entry():
    status = make_status([make_port(number=1, status="idle")])
    kvms_module._in_use["dev1"] = {1: time.monotonic() - 1}  # already expired
    result = _apply_overlays("dev1", status, {})
    assert result.ports[0].in_use is False


def test_apply_overlays_applies_label_override():
    status = make_status([make_port(number=2, label="", status="idle")])
    result = _apply_overlays("dev1", status, {"2": "build-node"})
    assert result.ports[0].label == "build-node"


def test_apply_overlays_in_use_and_label_together():
    status = make_status([make_port(number=3, label="", status="idle")])
    kvms_module._in_use["dev1"] = {3: time.monotonic() + 3600}
    result = _apply_overlays("dev1", status, {"3": "gpu-server"})
    assert result.ports[0].label == "gpu-server"
    assert result.ports[0].in_use is True


def test_apply_overlays_only_marks_tracked_port_not_all():
    ports = [make_port(number=1), make_port(number=2)]
    status = make_status(ports)
    kvms_module._in_use["dev1"] = {1: time.monotonic() + 3600}
    result = _apply_overlays("dev1", status, {})
    assert result.ports[0].in_use is True   # port 1 — tracked
    assert result.ports[1].in_use is False  # port 2 — not tracked


def test_apply_overlays_multiple_label_overrides():
    ports = [make_port(number=1, label="old"), make_port(number=2, label="old")]
    status = make_status(ports)
    result = _apply_overlays("dev1", status, {"1": "first", "2": "second"})
    assert result.ports[0].label == "first"
    assert result.ports[1].label == "second"


# ── In-use tracking endpoints ─────────────────────────────────────────────────

async def test_mark_port_in_use_returns_ok(client, kvm_device):
    dev_id = kvm_device["id"]
    r = await client.post(f"/api/kvms/{dev_id}/ports/1/mark-in-use")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


async def test_mark_port_in_use_records_future_expiry(client, kvm_device):
    dev_id = kvm_device["id"]
    await client.post(f"/api/kvms/{dev_id}/ports/2/mark-in-use")
    expiry = kvms_module._in_use[dev_id][2]
    # Expiry should be ~4 hours from now
    assert expiry > time.monotonic() + 3600


async def test_mark_device_free_clears_all_markers(client, kvm_device):
    dev_id = kvm_device["id"]
    kvms_module._in_use[dev_id] = {
        1: time.monotonic() + 3600,
        2: time.monotonic() + 3600,
    }
    r = await client.post(f"/api/kvms/{dev_id}/mark-free")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert dev_id not in kvms_module._in_use


async def test_mark_free_on_device_with_no_markers_does_not_crash(client, kvm_device):
    dev_id = kvm_device["id"]
    r = await client.post(f"/api/kvms/{dev_id}/mark-free")
    assert r.status_code == 200


# ── Status endpoint ───────────────────────────────────────────────────────────

async def test_kvm_status_404_for_unknown_device(client):
    r = await client.get("/api/kvms/nonexistent/status")
    assert r.status_code == 404


async def test_kvm_status_returns_fresh_cached_data(client, kvm_device):
    dev_id = kvm_device["id"]
    cached = make_status(
        [make_port(number=1, label="GPU-Server", status="active")],
        device_id=dev_id,
    )
    kvms_module._cache[dev_id] = (time.monotonic(), cached)
    r = await client.get(f"/api/kvms/{dev_id}/status")
    assert r.status_code == 200
    assert r.json()["ports"][0]["label"] == "GPU-Server"


async def test_kvm_status_fresh_cache_applies_in_use_overlay(client, kvm_device):
    dev_id = kvm_device["id"]
    cached = make_status([make_port(number=1, status="idle")], device_id=dev_id)
    kvms_module._cache[dev_id] = (time.monotonic(), cached)
    kvms_module._in_use[dev_id] = {1: time.monotonic() + 3600}
    r = await client.get(f"/api/kvms/{dev_id}/status")
    assert r.json()["ports"][0]["in_use"] is True


async def test_kvm_status_first_load_calls_driver(client, kvm_device):
    dev_id = kvm_device["id"]
    mock_status = make_status(reachable=False, device_id=dev_id)
    mock_status = KvmStatus(device_id=dev_id, reachable=False, error="timeout")
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=mock_status)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            r = await client.get(f"/api/kvms/{dev_id}/status")
    assert r.status_code == 200
    assert r.json()["reachable"] is False


# ── Viewer URL ────────────────────────────────────────────────────────────────

async def test_viewer_url_returns_embed_and_launch(client, kvm_device):
    dev_id = kvm_device["id"]
    r = await client.get(f"/api/kvms/{dev_id}/ports/1/viewer")
    assert r.status_code == 200
    data = r.json()
    assert "embed_url" in data
    assert "launch_url" in data
    assert data["can_embed"] is True


async def test_viewer_url_contains_device_ip(client, kvm_device):
    dev_id = kvm_device["id"]
    r = await client.get(f"/api/kvms/{dev_id}/ports/3/viewer")
    assert "10.7.30.49" in r.json()["launch_url"]


async def test_viewer_url_404_for_unknown_device(client):
    r = await client.get("/api/kvms/bad-id/ports/1/viewer")
    assert r.status_code == 404


# ── Auto-clear logic (tested by calling _refresh_background directly) ─────────

async def test_auto_clear_removes_old_inactive_port():
    """Port marked >2 min ago and not active → cleared."""
    dev_id = "test-dev"
    # Simulate marked 3 minutes ago: exp = now + TTL - 180
    kvms_module._in_use[dev_id] = {1: time.monotonic() + _IN_USE_TTL - 180}

    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="idle"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())

    assert 1 not in kvms_module._in_use.get(dev_id, {})


async def test_auto_clear_keeps_recently_marked_port():
    """Port marked <2 min ago → NOT cleared even if not active (grace period)."""
    dev_id = "test-dev"
    # Marked 30 seconds ago: exp = now + TTL - 30
    kvms_module._in_use[dev_id] = {1: time.monotonic() + _IN_USE_TTL - 30}

    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="idle"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())

    assert 1 in kvms_module._in_use.get(dev_id, {})


async def test_auto_clear_keeps_still_active_port():
    """Port marked long ago but still active → NOT cleared."""
    dev_id = "test-dev"
    # Marked 10 minutes ago
    kvms_module._in_use[dev_id] = {1: time.monotonic() + _IN_USE_TTL - 600}

    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="active"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())

    assert 1 in kvms_module._in_use.get(dev_id, {})


# ── _parse_kvm_status — driver-level status normalisation ────────────────────

from drivers.raritan_kvm import _parse_kvm_status

@pytest.mark.parametrize("raw,expected", [
    # Active / in-use
    ("connected",       "active"),
    ("active",          "active"),
    ("in-use",          "active"),
    ("1",               "active"),
    ("true",            "active"),
    ("busy",            "active"),
    # Idle (has device, nobody using it)
    ("idle",            "idle"),
    ("available",       "idle"),    # Raritan KX III REST: port ready to connect
    # Empty — Raritan REST API / hardware values
    ("notConfigured",   "empty"),   # KX III: port has no target configured
    ("not configured",  "empty"),
    ("0",               "empty"),
    ("disconnected",    "empty"),
    ("down",            "empty"),
    ("unavailable",     "empty"),
    # Edge cases
    ("",                "idle"),
    (None,              "idle"),
    ("CONNECTED",       "active"),  # case-insensitive
    ("NotConfigured",   "empty"),
])
def test_parse_kvm_status(raw, expected):
    assert _parse_kvm_status(raw) == expected
