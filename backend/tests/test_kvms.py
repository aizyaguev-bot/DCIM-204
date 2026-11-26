"""
Unit tests for KVM status caching, in-use tracking overlay, and auto-clear logic.

All tests mock the Raritan hardware driver so no live KVM is required.
Integration tests against real KVMs live in test_kvm_regression.py.
"""
import re
import time
import httpx
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import app.routers.kvms as kvms_module
from app.routers.kvms import _IN_USE_TTL, _apply_overlays
from app.schemas import KvmPort, KvmStatus

# ── Helpers ───────────────────────────────────────────────────────────────────

def make_port(number=1, label="Server-A", status="idle", in_use=False):
    return KvmPort(number=number, label=label, status=status, in_use=in_use)


def lease(expires_at, key="a" * 32):
    """One console lease on a port: { lease: expires_at (monotonic) }."""
    return {key: expires_at}


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
    kvms_module._in_use["dev1"] = {1: lease(time.monotonic() + 3600)}
    result = _apply_overlays("dev1", status, {})
    assert result.ports[0].in_use is True


def test_apply_overlays_ignores_expired_in_use_entry():
    status = make_status([make_port(number=1, status="idle")])
    kvms_module._in_use["dev1"] = {1: lease(time.monotonic() - 1)}  # already expired
    result = _apply_overlays("dev1", status, {})
    assert result.ports[0].in_use is False


def test_apply_overlays_applies_label_override():
    status = make_status([make_port(number=2, label="", status="idle")])
    result = _apply_overlays("dev1", status, {"2": "build-node"})
    assert result.ports[0].label == "build-node"


def test_apply_overlays_in_use_and_label_together():
    status = make_status([make_port(number=3, label="", status="idle")])
    kvms_module._in_use["dev1"] = {3: lease(time.monotonic() + 3600)}
    result = _apply_overlays("dev1", status, {"3": "gpu-server"})
    assert result.ports[0].label == "gpu-server"
    assert result.ports[0].in_use is True


def test_apply_overlays_only_marks_tracked_port_not_all():
    ports = [make_port(number=1), make_port(number=2)]
    status = make_status(ports)
    kvms_module._in_use["dev1"] = {1: lease(time.monotonic() + 3600)}
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
    body = r.json()
    assert body["ok"] is True and body["sessions"] == 1
    assert re.fullmatch(r"[0-9a-f]{32}", body["lease"])


async def test_mark_port_in_use_records_future_expiry(client, kvm_device):
    dev_id = kvm_device["id"]
    r = await client.post(f"/api/kvms/{dev_id}/ports/2/mark-in-use")
    expiry = kvms_module._in_use[dev_id][2][r.json()["lease"]]
    # Expiry should be ~4 hours from now
    assert expiry > time.monotonic() + 3600


async def test_mark_device_free_clears_all_markers(client, kvm_device):
    dev_id = kvm_device["id"]
    kvms_module._in_use[dev_id] = {
        1: lease(time.monotonic() + 3600),
        2: lease(time.monotonic() + 3600),
    }
    r = await client.post(f"/api/kvms/{dev_id}/mark-free")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert dev_id not in kvms_module._in_use


async def test_mark_free_on_device_with_no_markers_does_not_crash(client, kvm_device):
    dev_id = kvm_device["id"]
    r = await client.post(f"/api/kvms/{dev_id}/mark-free")
    assert r.status_code == 200


# ── Per-console leases (KVM-1: one console closing must not free a shared port) ─

def _port_in_use(dev_id, number=1):
    status = make_status([make_port(number=number, status="idle")], device_id=dev_id)
    return _apply_overlays(dev_id, status, {}).ports[0].in_use


async def _launch(client, dev_id, port=1):
    r = await client.post(f"/api/kvms/{dev_id}/ports/{port}/mark-in-use")
    assert r.status_code == 200
    return r.json()


async def _close(client, dev_id, port=1, **kwargs):
    return await client.post(f"/api/kvms/{dev_id}/ports/{port}/mark-free", **kwargs)


async def test_two_consoles_on_one_port_stay_in_use_until_both_close(client, kvm_device):
    dev_id = kvm_device["id"]
    first, second = await _launch(client, dev_id), await _launch(client, dev_id)
    assert first["lease"] != second["lease"]
    assert (first["sessions"], second["sessions"]) == (1, 2)

    r = await _close(client, dev_id, json={"lease": first["lease"]})
    assert r.status_code == 200 and r.json() == {"ok": True, "sessions": 1}
    assert _port_in_use(dev_id) is True
    assert list(kvms_module._in_use[dev_id][1]) == [second["lease"]]

    r = await _close(client, dev_id, json={"lease": second["lease"]})
    assert r.json() == {"ok": True, "sessions": 0}
    assert _port_in_use(dev_id) is False
    assert dev_id not in kvms_module._in_use


async def test_status_endpoint_reports_in_use_until_last_console_closes(client, kvm_device):
    dev_id = kvm_device["id"]
    kvms_module._cache[dev_id] = (time.monotonic(), make_status([make_port(number=1)], device_id=dev_id))
    first, second = await _launch(client, dev_id), await _launch(client, dev_id)
    await _close(client, dev_id, json={"lease": first["lease"]})
    assert (await client.get(f"/api/kvms/{dev_id}/status")).json()["ports"][0]["in_use"] is True
    await _close(client, dev_id, json={"lease": second["lease"]})
    assert (await client.get(f"/api/kvms/{dev_id}/status")).json()["ports"][0]["in_use"] is False


async def test_unknown_lease_is_a_no_op(client, kvm_device):
    dev_id = kvm_device["id"]
    live = await _launch(client, dev_id)
    r = await _close(client, dev_id, json={"lease": "f" * 32})
    assert r.status_code == 200 and r.json() == {"ok": True, "sessions": 1}
    assert list(kvms_module._in_use[dev_id][1]) == [live["lease"]]


async def test_lease_only_frees_its_own_port(client, kvm_device):
    dev_id = kvm_device["id"]
    on_one, on_two = await _launch(client, dev_id, 1), await _launch(client, dev_id, 2)
    r = await _close(client, dev_id, 2, json={"lease": on_one["lease"]})
    assert r.json() == {"ok": True, "sessions": 1}
    assert set(kvms_module._in_use[dev_id]) == {1, 2}
    assert list(kvms_module._in_use[dev_id][2]) == [on_two["lease"]]


async def test_expired_lease_is_a_no_op_for_the_live_one(client, kvm_device):
    dev_id = kvm_device["id"]
    now = time.monotonic()
    kvms_module._in_use[dev_id] = {1: {"a" * 32: now - 1, "b" * 32: now + 3600}}
    r = await _close(client, dev_id, json={"lease": "a" * 32})
    assert r.status_code == 200 and r.json() == {"ok": True, "sessions": 1}
    assert list(kvms_module._in_use[dev_id][1]) == ["b" * 32]


async def test_mark_free_without_body_removes_only_the_oldest_lease(client, kvm_device):
    dev_id = kvm_device["id"]
    now = time.monotonic()
    kvms_module._in_use[dev_id] = {1: {"b" * 32: now + 3000, "a" * 32: now + 2000}}
    r = await _close(client, dev_id)
    assert r.status_code == 200 and r.json() == {"ok": True, "sessions": 1}
    assert list(kvms_module._in_use[dev_id][1]) == ["b" * 32]  # the newer console stays
    r = await _close(client, dev_id)
    assert r.json() == {"ok": True, "sessions": 0}
    assert dev_id not in kvms_module._in_use


@pytest.mark.parametrize("kwargs", [
    {"json": {}},
    {"json": {"lease": None}},
    {"content": b"", "headers": {"Content-Type": "application/json"}},
    {"content": b"null", "headers": {"Content-Type": "application/json"}},
])
async def test_mark_free_with_no_lease_in_body_removes_the_oldest(client, kvm_device, kwargs):
    dev_id = kvm_device["id"]
    first, second = await _launch(client, dev_id), await _launch(client, dev_id)
    r = await _close(client, dev_id, **kwargs)
    assert r.status_code == 200 and r.json() == {"ok": True, "sessions": 1}
    assert list(kvms_module._in_use[dev_id][1]) == [second["lease"]]


async def test_mark_free_reads_a_lease_sent_without_json_content_type(client, kvm_device):
    """A plain fetch/keepalive on page close may send the JSON as text/plain."""
    dev_id = kvm_device["id"]
    first, second = await _launch(client, dev_id), await _launch(client, dev_id)
    r = await _close(client, dev_id, content=f'{{"lease":"{second["lease"].upper()}"}}'.encode(),
                     headers={"Content-Type": "text/plain;charset=UTF-8"})
    assert r.status_code == 200 and r.json() == {"ok": True, "sessions": 1}
    assert list(kvms_module._in_use[dev_id][1]) == [first["lease"]]


@pytest.mark.parametrize("content", [
    b"not json", b'{"lease": "xyz"}', b'{"lease": 5}', b'{"lease": ""}',
    ('{"lease": "%s"}' % ("a" * 65)).encode(), b'["a"]', b'"a"', b"\xff\xfe",
    b"[" * 250 + b"]" * 250,                              # deeply nested, under the size cap
    ('{"lease": "%s", "x": "%s"}' % ("a" * 32, "y" * 600)).encode(),  # over the size cap
])
async def test_mark_free_rejects_a_malformed_lease_without_freeing(client, kvm_device, content):
    dev_id = kvm_device["id"]
    await _launch(client, dev_id)
    r = await _close(client, dev_id, content=content, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert len(kvms_module._in_use[dev_id][1]) == 1


async def test_mark_free_ignores_a_lease_in_the_query_string(client, kvm_device):
    """The lease travels only in the body; a query parameter is not a lease."""
    dev_id = kvm_device["id"]
    first, second = await _launch(client, dev_id), await _launch(client, dev_id)
    r = await client.post(f"/api/kvms/{dev_id}/ports/1/mark-free?lease={second['lease']}")
    assert r.json() == {"ok": True, "sessions": 1}
    assert list(kvms_module._in_use[dev_id][1]) == [second["lease"]]  # oldest removed instead


async def test_mark_free_on_unmarked_port_is_ok(client, kvm_device):
    r = await _close(client, kvm_device["id"], json={"lease": "a" * 32})
    assert r.status_code == 200 and r.json() == {"ok": True, "sessions": 0}
    r = await _close(client, kvm_device["id"])
    assert r.json() == {"ok": True, "sessions": 0}


async def test_mark_free_handler_accepts_direct_calls():
    kvms_module._in_use["dev1"] = {1: {"a" * 32: time.monotonic() + 60, "b" * 32: time.monotonic() + 90}}
    assert await kvms_module.mark_port_free("dev1", 1, body={"lease": "b" * 32}) == {"ok": True, "sessions": 1}
    assert await kvms_module.mark_port_free("dev1", 1, body=None) == {"ok": True, "sessions": 0}
    assert "dev1" not in kvms_module._in_use


def test_one_expired_and_one_live_lease_keeps_port_in_use():
    now = time.monotonic()
    kvms_module._in_use["dev1"] = {1: {"a" * 32: now - 1, "b" * 32: now + 3600}}
    assert _port_in_use("dev1") is True
    kvms_module._in_use["dev1"] = {1: {"a" * 32: now - 2, "b" * 32: now - 1}}
    assert _port_in_use("dev1") is False


async def test_expired_leases_are_not_counted_as_sessions(client, kvm_device):
    dev_id = kvm_device["id"]
    kvms_module._in_use[dev_id] = {1: lease(time.monotonic() - 1)}
    body = await _launch(client, dev_id)
    assert body["sessions"] == 1
    assert list(kvms_module._in_use[dev_id][1]) == [body["lease"]]


async def test_leases_per_port_are_bounded(client, kvm_device, monkeypatch):
    monkeypatch.setattr(kvms_module, "_MAX_LEASES_PER_PORT", 3)
    dev_id = kvm_device["id"]
    launched = [(await _launch(client, dev_id))["lease"] for _ in range(4)]
    assert list(kvms_module._in_use[dev_id][1]) == launched[1:]


async def test_device_wide_mark_free_clears_every_lease(client, kvm_device):
    dev_id = kvm_device["id"]
    for port in (1, 1, 2, 3):
        await _launch(client, dev_id, port)
    r = await client.post(f"/api/kvms/{dev_id}/mark-free")
    assert r.json() == {"ok": True}
    assert dev_id not in kvms_module._in_use
    assert _port_in_use(dev_id) is False


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
    kvms_module._in_use[dev_id] = {1: lease(time.monotonic() + 3600)}
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
    """Port marked >2 min ago and live status says not active → cleared."""
    dev_id = "test-dev"
    # Simulate marked 3 minutes ago: exp = now + TTL - 180
    kvms_module._in_use[dev_id] = {1: lease(time.monotonic() + _IN_USE_TTL - 180)}

    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="idle", status_source="live"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())

    assert 1 not in kvms_module._in_use.get(dev_id, {})


async def test_auto_clear_keeps_recently_marked_port():
    """Port marked <2 min ago → NOT cleared even if not active (grace period)."""
    dev_id = "test-dev"
    # Marked 30 seconds ago: exp = now + TTL - 30
    kvms_module._in_use[dev_id] = {1: lease(time.monotonic() + _IN_USE_TTL - 30)}

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
    kvms_module._in_use[dev_id] = {1: lease(time.monotonic() + _IN_USE_TTL - 600)}

    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="active"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())

    assert 1 in kvms_module._in_use.get(dev_id, {})


async def test_auto_clear_waits_for_grace_period_of_newest_lease():
    """An old idle console must not clear a port where a new console just started."""
    dev_id = "test-dev"
    now = time.monotonic()
    kvms_module._in_use[dev_id] = {1: {
        "a" * 32: now + _IN_USE_TTL - 600,  # opened 10 minutes ago
        "b" * 32: now + _IN_USE_TTL - 30,   # opened 30 seconds ago
    }}
    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="idle", status_source="live"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())
    assert set(kvms_module._in_use[dev_id][1]) == {"a" * 32, "b" * 32}


async def test_auto_clear_drops_every_lease_once_newest_is_past_grace(monkeypatch):
    dev_id = "test-dev"
    clock = [5000.0]
    monkeypatch.setattr(kvms_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    kvms_module._in_use[dev_id] = {
        1: {"a" * 32: clock[0] + _IN_USE_TTL - 600, "b" * 32: clock[0] + _IN_USE_TTL - 119},
        2: {"c" * 32: clock[0] + _IN_USE_TTL - 600},
    }
    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="idle", status_source="live"),
        KvmPort(number=2, label="", status="active", status_source="live"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())
            assert len(kvms_module._in_use[dev_id][1]) == 2  # newest is 119 s old
            clock[0] += 1
            await kvms_module._refresh_background(dev_id, object())
    assert 1 not in kvms_module._in_use[dev_id]   # both leases dropped at 120 s
    assert 2 in kvms_module._in_use[dev_id]       # still active, kept


async def test_auto_clear_removes_empty_device_entry():
    dev_id = "test-dev"
    kvms_module._in_use[dev_id] = {1: lease(time.monotonic() + _IN_USE_TTL - 600)}
    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="idle", status_source="live"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())
    assert dev_id not in kvms_module._in_use


@pytest.mark.parametrize("status,source", [
    ("idle", "configured"),   # LX II / KX III sidebar.asp
    ("empty", "configured"),
    ("idle", "unknown"),      # static fallback or unnumbered REST row
])
async def test_auto_clear_keeps_mark_when_status_is_not_live(status, source):
    """Sidebar/static ports never report 'active'; the manual mark must survive."""
    dev_id = "test-dev"
    kvms_module._in_use[dev_id] = {1: lease(time.monotonic() + _IN_USE_TTL - 600)}
    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status=status, status_source=source),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())
    assert 1 in kvms_module._in_use[dev_id]


async def test_auto_clear_keeps_mark_for_port_missing_from_live_status():
    dev_id = "test-dev"
    kvms_module._in_use[dev_id] = {5: lease(time.monotonic() + _IN_USE_TTL - 600)}
    fresh = KvmStatus(device_id=dev_id, reachable=True, ports=[
        KvmPort(number=1, label="", status="idle", status_source="live"),
    ])
    with patch.object(kvms_module, "_fetch_status", AsyncMock(return_value=fresh)):
        with patch.object(kvms_module, "ensure_session", AsyncMock()):
            await kvms_module._refresh_background(dev_id, object())
    assert 5 in kvms_module._in_use[dev_id]


def _sidebar_html(*ports):
    return "".join(f"J('PortId','P{n}') x J('PortNumber',{n})\n" for n in ports)


@pytest.mark.parametrize("model,routes", [
    ("LX II", {"/sidebar.asp": (200, _sidebar_html(1, 2))}),
    ("KX III", {"/api/v1/targets": (404, ""), "/sidebar.asp": (200, _sidebar_html(1, 2))}),
    ("LX II", {"/sidebar.asp": (500, "")}),  # static fallback
])
async def test_in_use_mark_survives_refreshes_from_sidebar_and_static_ports(monkeypatch, model, routes):
    """End to end through the driver: an open console on a sidebar/static KVM stays IN USE."""
    def transport(request):
        code, body = routes.get(request.url.path, (200, ""))
        return httpx.Response(code, text=body)

    clock = [1000.0]
    monkeypatch.setattr(kvms_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))

    def make_driver(*args, **kwargs):
        driver = RaritanKvmDriver("example.invalid", "u", "p", model=model)
        driver._client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        driver._session_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(transport))
        return driver

    monkeypatch.setattr(kvms_module, "RaritanKvmDriver", make_driver)
    monkeypatch.setattr(kvms_module, "get_creds", lambda dev: ("u", "p"))
    monkeypatch.setattr(kvms_module, "ensure_session", AsyncMock())
    dev = SimpleNamespace(id="kvm-sb", ip="example.invalid", model=model, port_count=4, labels_json="{}")

    marked = await kvms_module.mark_port_in_use(dev.id, 1)
    await kvms_module._refresh_background(dev.id, dev)
    clock[0] += 121
    await kvms_module._refresh_background(dev.id, dev)
    clock[0] += 3600
    await kvms_module._refresh_background(dev.id, dev)

    status = kvms_module._cache[dev.id][1]
    assert status.reachable and status.error is None
    assert all(p.status_source != "live" for p in status.ports)
    assert [p.number for p in _apply_overlays(dev.id, status, {}).ports if p.in_use] == [1]

    await kvms_module.mark_port_free(dev.id, 1, body={"lease": marked["lease"]})
    assert not any(p.in_use for p in _apply_overlays(dev.id, status, {}).ports)
    # The handler still works when called directly with no body.
    await kvms_module.mark_port_in_use(dev.id, 1)
    await kvms_module.mark_port_free(dev.id, 1)
    assert not any(p.in_use for p in _apply_overlays(dev.id, status, {}).ports)


# ── Wrong credentials ────────────────────────────────────────────────────────

LOGIN_PAGE = '<form action="auth.asp"><input type="password" name="password"><input name="action_login"></form>'


def _auth_driver(model, handler, seen):
    def transport(request):
        seen.append(f"{request.method} {request.url.path}")
        return handler(request)
    driver = RaritanKvmDriver("example.invalid", "secret-user", "secret-password", model=model)
    driver._client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    driver._session_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(transport))
    return driver


@pytest.mark.parametrize("model,code,expected_requests,static_ports", [
    ("KX III", 401, ["GET /", "GET /api/v1/targets", "POST /auth.asp"], False),
    ("KX III", 403, ["GET /", "GET /api/v1/targets", "POST /auth.asp"], False),
    ("LX II", 401, ["GET /", "GET /sidebar.asp", "POST /auth.asp"], True),
    ("LX II", 403, ["GET /", "GET /sidebar.asp", "POST /auth.asp"], True),
])
async def test_wrong_credentials_report_auth_failure_and_stop_early(monkeypatch, model, code, expected_requests, static_ports):
    seen = []
    driver = _auth_driver(model, lambda r: httpx.Response(code, text="secret-password response-body"), seen)
    monkeypatch.setattr(kvms_module, "RaritanKvmDriver", lambda *args, **kwargs: driver)
    monkeypatch.setattr(kvms_module, "get_creds", lambda dev: ("secret-user", "secret-password"))
    status = await kvms_module._fetch_status("kvm-auth", SimpleNamespace(
        ip="example.invalid", model=model, port_count=4, labels_json="{}"))

    assert status.reachable is True
    assert status.error == "Device API authentication failed"
    assert seen == expected_requests
    if static_ports:  # LX II designed static list, never presented as live
        assert [p.number for p in status.ports] == [1, 2, 3, 4]
        assert all(p.status_source == "unknown" for p in status.ports)
    else:
        assert status.ports == []
    assert all(t not in status.error for t in ("secret-user", "secret-password", "response-body", "https://"))
    assert driver._client.is_closed


@pytest.mark.parametrize("model", ["KX III", "LX II"])
async def test_login_page_instead_of_data_is_an_auth_failure(monkeypatch, model):
    seen = []
    def handler(request):
        if request.url.path == "/":
            return httpx.Response(200, text=LOGIN_PAGE)
        if request.url.path == "/api/v1/targets":
            return httpx.Response(404)
        return httpx.Response(200, text=LOGIN_PAGE)
    driver = _auth_driver(model, handler, seen)
    assert await driver.probe() is None
    ports = await driver.get_ports(port_count=2)
    await driver.close()
    assert driver.auth_error == "Device API authentication failed"
    assert seen[-1] == "POST /auth.asp"
    assert ports == ([] if model == "KX III" else [
        {"number": n, "label": f"Port {n}", "status": "idle", "status_source": "unknown"} for n in (1, 2)])


async def test_form_login_with_cookie_then_login_page_sidebar_is_auth_failure():
    seen = []
    def handler(request):
        if request.url.path == "/auth.asp":
            return httpx.Response(200, text=LOGIN_PAGE, headers={"set-cookie": "pre=1; Path=/"})
        if request.url.path == "/sidebar.asp" and request.headers.get("cookie"):
            return httpx.Response(200, text=LOGIN_PAGE)
        return httpx.Response(401)
    driver = _auth_driver("LX II", handler, seen)
    await driver.get_ports(port_count=2)
    await driver.close()
    assert driver.auth_error == "Device API authentication failed"
    assert seen == ["GET /sidebar.asp", "POST /auth.asp", "GET /sidebar.asp"]


async def test_form_login_success_after_basic_rejection_is_healthy():
    """LX II firmware that refuses Basic auth but accepts the form sign-in."""
    def handler(request):
        if request.url.path == "/auth.asp":
            return httpx.Response(200, text="<html>home</html>", headers={"set-cookie": "SID=1; Path=/"})
        if request.url.path == "/sidebar.asp" and request.headers.get("cookie"):
            return httpx.Response(200, text=_sidebar_html(2))
        return httpx.Response(401)
    driver = _auth_driver("LX II", handler, [])
    ports = await driver.get_ports(port_count=3)
    await driver.close()
    assert driver.auth_error is None
    assert [(p["number"], p["status"], p["status_source"]) for p in ports] == [
        (1, "empty", "configured"), (2, "idle", "configured"), (3, "empty", "configured")]


async def test_kx3_rest_rejection_with_working_form_login_is_healthy():
    def handler(request):
        if request.url.path == "/auth.asp":
            return httpx.Response(200, text="<html>home</html>", headers={"set-cookie": "SID=1; Path=/"})
        if request.url.path == "/sidebar.asp" and request.headers.get("cookie"):
            return httpx.Response(200, text=_sidebar_html(1))
        return httpx.Response(401)
    seen = []
    driver = _auth_driver("KX III", handler, seen)
    ports = await driver.get_ports(port_count=2)
    await driver.close()
    assert driver.auth_error is None
    assert "GET /sidebar.asp" in seen and seen.count("GET /sidebar.asp") == 1  # Basic attempt skipped
    assert [p["status"] for p in ports] == ["idle", "empty"]


async def test_auth_error_cleared_on_next_successful_read():
    responses = {"code": 401}
    def handler(request):
        if request.url.path == "/api/v1/targets" and responses["code"] == 200:
            return httpx.Response(200, json=[{"portNumber": 1, "name": "srv", "status": "idle"}])
        return httpx.Response(responses["code"])
    driver = _auth_driver("KX III", handler, [])
    assert await driver.get_ports(port_count=1) == [] and driver.auth_error
    responses["code"] = 200
    ports = await driver.get_ports(port_count=1)
    await driver.close()
    assert driver.auth_error is None and ports[0]["status_source"] == "live"


# ── _parse_kvm_status — driver-level status normalisation ────────────────────

from drivers.raritan_kvm import RaritanKvmDriver, _parse_kvm_status

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


@pytest.mark.parametrize("exception,expected", [
    (httpx.ConnectTimeout(""), "ConnectTimeout"),
    (httpx.ReadTimeout(""), "ReadTimeout"),
    (httpx.WriteTimeout(""), "WriteTimeout"),
    (httpx.PoolTimeout(""), "PoolTimeout"),
    (httpx.ConnectError("[Errno 111] Connection refused"), "connection refused"),
    (httpx.ConnectError("[Errno -2] Name or service not known"), "DNS failure"),
    (httpx.ConnectError("nodename nor servname provided, or not known"), "DNS failure"),
    (httpx.ConnectError("getaddrinfo failed"), "DNS failure"),
    (httpx.ConnectError("Temporary failure in name resolution"), "DNS failure"),
    (httpx.ConnectError("[Errno 111]"), "connection refused"),
    (httpx.ConnectError("[Errno 113] No route to host"), "network unreachable"),
    (httpx.ConnectError("[Errno 101] Network is unreachable"), "network unreachable"),
    (httpx.ConnectError("[Errno 113]"), "network unreachable"),
    (httpx.ConnectError("[Errno 101]"), "network unreachable"),
    (httpx.ConnectError("SSL CERTIFICATE_VERIFY_FAILED"), "TLS handshake"),
    (httpx.ProxyError(""), "ProxyError"),
    (httpx.ConnectError("unknown failure"), "connection error"),
    (RuntimeError("unknown failure"), "probe failed"),
])
async def test_kvm_probe_and_status_preserve_safe_failure_class(monkeypatch, exception, expected):
    unsafe = " https://secret-user:secret-password@example.invalid/private response-body"
    exception.args = (str(exception) + unsafe,)
    def transport(request):
        raise exception
    driver = RaritanKvmDriver("example.invalid", "secret-user", "secret-password")
    driver._client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    try:
        reason = await driver.probe()
        assert expected in reason
        assert await driver.ping() is False
        monkeypatch.setattr(kvms_module, "RaritanKvmDriver", lambda *args, **kwargs: driver)
        monkeypatch.setattr(kvms_module, "get_creds", lambda dev: ("secret-user", "secret-password"))
        driver.get_ports = AsyncMock()
        status = await kvms_module._fetch_status("probe-kvm", SimpleNamespace(ip="example.invalid", model="KX III"))
        assert not status.reachable and status.error == reason
        driver.get_ports.assert_not_awaited()
        assert driver._client.is_closed
        assert all(token not in status.error for token in ("secret-user", "secret-password", "https://", "response-body"))
    finally:
        await driver.close()


@pytest.mark.parametrize("code,expected", [(200, None), (401, None), (404, None), (407, "HTTP 407"), (503, "HTTP 503")])
async def test_kvm_probe_http_status_and_boolean_compatibility(monkeypatch, code, expected):
    driver = RaritanKvmDriver("example.invalid", "", "")
    driver._client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(code, text="secret-password response-body")))
    try:
        reason = await driver.probe()
        assert reason is None if expected is None else expected in reason
        assert await driver.ping() is (expected is None)
        if expected:
            monkeypatch.setattr(kvms_module, "RaritanKvmDriver", lambda *args, **kwargs: driver)
            monkeypatch.setattr(kvms_module, "get_creds", lambda dev: ("", ""))
            status = await kvms_module._fetch_status("probe-kvm", SimpleNamespace(ip="example.invalid", model="KX III"))
            assert not status.reachable and status.error == reason
            assert "response-body" not in status.error and "secret-password" not in status.error
    finally:
        await driver.close()


async def test_kvm_port_read_failure_after_probe_keeps_failure_class(monkeypatch):
    from app import monitor_links
    def transport(request):
        if request.url.path == "/":
            return httpx.Response(200)
        raise httpx.ReadTimeout("https://secret-user:secret-password@example.invalid response-body")
    driver = RaritanKvmDriver("example.invalid", "secret-user", "secret-password")
    driver._client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    monkeypatch.setattr(kvms_module, "RaritanKvmDriver", lambda *args, **kwargs: driver)
    monkeypatch.setattr(kvms_module, "get_creds", lambda dev: ("secret-user", "secret-password"))
    status = await kvms_module._fetch_status("probe-kvm", SimpleNamespace(
        ip="example.invalid", model="KX III", port_count=2, labels_json="{}"))
    assert not status.reachable
    assert status.error == "Device API request timeout (ReadTimeout)"
    assert "receiving data" in monitor_links.failure_reason(status.error)


async def test_kvm_client_keeps_six_second_connect_and_read_timeouts():
    driver = RaritanKvmDriver("example.invalid", "", "")
    try:
        client = await driver._client_ctx()
        assert client.timeout.connect == client.timeout.read == 6.0
        assert client.timeout.write == client.timeout.pool == 6.0
    finally:
        await driver.close()
