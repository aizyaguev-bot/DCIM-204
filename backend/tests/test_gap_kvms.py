"""
Gap tests for the KVM status router (app/routers/kvms.py) and the Raritan KVM
driver (drivers/raritan_kvm.py): cache/refresh paths, in-use overlay lifetime,
label overlays from the inventory, port parsing fallbacks and sign-in requests.

No real device is contacted: every HTTP exchange goes through httpx.MockTransport
and the router's driver/session helpers are monkeypatched.
"""
import base64
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs

import httpx
import pytest

import app.routers.kvms as kvms_module
import drivers.raritan_kvm as raritan_kvm
from app.models import Device
from app.routers.kvms import _CACHE_TTL, _IN_USE_TTL, _apply_overlays
from app.schemas import KvmPort, KvmStatus
from drivers.raritan_kvm import AUTH_FAILED, RaritanKvmDriver, _is_login_page

KVM_IP = "192.0.2.49"   # TEST-NET-1: never a real lab KVM, even if a path were left unmocked
SIDEBAR_PORT_1 = "J('PortId','P1') x J('PortNumber',1)\n"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _status(device_id, *ports, reachable=True, error=None):
    return KvmStatus(device_id=device_id, reachable=reachable, error=error, ports=list(ports))


def _port(number, label="", status="idle", source="live"):
    return KvmPort(number=number, label=label, status=status, status_source=source)


def _mock_driver(model, handler, seen=None, username="u", password="p"):
    """A real driver whose Basic and form-session clients talk to a fake device."""
    def transport(request):
        if seen is not None:
            seen.append(f"{request.method} {request.url.path}")
        return handler(request)
    driver = RaritanKvmDriver("example.invalid", username, password, model=model)
    driver._client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    driver._session_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(transport))
    return driver


def _fake_clock(monkeypatch, start=10_000.0):
    clock = [start]
    monkeypatch.setattr(kvms_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    return clock


@pytest.fixture
async def kvm(client):
    r = await client.post("/api/devices/", json={
        "name": "KVM-Gap-1", "kind": "kvm", "ip": KVM_IP,
        "model": "KX III", "rack": "R1", "port_count": 4,
        "username": "kvm-admin", "password": "kvm-s3cret",
    })
    assert r.status_code == 201
    return r.json()


# ── Status endpoint: cache paths ──────────────────────────────────────────────

async def test_first_status_load_caches_result_and_starts_console_session(client, kvm, monkeypatch):
    dev_id = kvm["id"]
    fetched = _status(dev_id, _port(1, "srv-a", "active"))
    fetch = AsyncMock(return_value=fetched)
    session = AsyncMock()
    monkeypatch.setattr(kvms_module, "_fetch_status", fetch)
    monkeypatch.setattr(kvms_module, "ensure_session", session)

    first = await client.get(f"/api/kvms/{dev_id}/status")
    second = await client.get(f"/api/kvms/{dev_id}/status")

    assert first.status_code == second.status_code == 200
    assert first.json()["ports"][0]["label"] == "srv-a"
    assert second.json() == first.json()
    fetch.assert_awaited_once()                     # second read served from cache
    assert kvms_module._cache[dev_id][1] is fetched
    session.assert_awaited_once()                   # console session warmed in the background
    assert session.await_args.args[0] == dev_id
    assert session.await_args.args[1].id == dev_id


async def test_stale_cache_is_served_immediately_and_refreshed_in_background(client, kvm, monkeypatch):
    dev_id = kvm["id"]
    clock = _fake_clock(monkeypatch)
    old = _status(dev_id, _port(1, "srv-a", "active"))
    kvms_module._cache[dev_id] = (clock[0] - _CACHE_TTL - 1, old)
    new = _status(dev_id, _port(1, "srv-a", "idle"))
    fetch = AsyncMock(return_value=new)
    session = AsyncMock()
    monkeypatch.setattr(kvms_module, "_fetch_status", fetch)
    monkeypatch.setattr(kvms_module, "ensure_session", session)

    r = await client.get(f"/api/kvms/{dev_id}/status")

    assert r.status_code == 200
    assert r.json()["ports"][0]["status"] == "active"   # caller is not blocked on the device
    fetch.assert_awaited_once()
    assert kvms_module._cache[dev_id] == (clock[0], new)  # background refresh stored the new reading
    session.assert_awaited_once()
    assert dev_id not in kvms_module._refreshing


async def test_background_refresh_is_skipped_while_one_is_already_running(monkeypatch):
    dev_id = "kvm-busy"
    before = (1.0, _status(dev_id, _port(1)))
    kvms_module._cache[dev_id] = before
    kvms_module._refreshing.add(dev_id)
    fetch = AsyncMock()
    session = AsyncMock()
    monkeypatch.setattr(kvms_module, "_fetch_status", fetch)
    monkeypatch.setattr(kvms_module, "ensure_session", session)

    await kvms_module._refresh_background(dev_id, SimpleNamespace())

    fetch.assert_not_awaited()
    session.assert_not_awaited()
    assert kvms_module._cache[dev_id] is before
    assert dev_id in kvms_module._refreshing  # the running refresh still owns the guard


async def test_background_refresh_releases_guard_when_session_setup_fails(monkeypatch):
    dev_id = "kvm-session-fail"
    fresh = _status(dev_id, _port(1, "srv", "idle"))
    monkeypatch.setattr(kvms_module, "_fetch_status", AsyncMock(return_value=fresh))
    monkeypatch.setattr(kvms_module, "ensure_session", AsyncMock(side_effect=httpx.ConnectError("down")))

    with pytest.raises(httpx.ConnectError):
        await kvms_module._refresh_background(dev_id, SimpleNamespace())

    assert dev_id not in kvms_module._refreshing  # later refreshes are not blocked forever
    assert kvms_module._cache[dev_id][1] is fresh  # the reading itself was still stored


# ── In-use markers: auto-clear and lifetime ───────────────────────────────────

@pytest.mark.parametrize("ports", [
    [],                                   # what _fetch_status returns for an offline KVM
    [_port(1, status="idle", source="live")],  # even a stale "not active" port list must not count
])
async def test_unreachable_refresh_never_clears_in_use_marks(monkeypatch, ports):
    dev_id = "kvm-offline"
    kvms_module._in_use[dev_id] = {1: time.monotonic() + _IN_USE_TTL - 600}  # marked 10 min ago
    offline = KvmStatus(device_id=dev_id, reachable=False, ports=ports, error="Device API connection refused")
    monkeypatch.setattr(kvms_module, "_fetch_status", AsyncMock(return_value=offline))
    monkeypatch.setattr(kvms_module, "ensure_session", AsyncMock())

    await kvms_module._refresh_background(dev_id, SimpleNamespace())

    assert 1 in kvms_module._in_use[dev_id]
    assert kvms_module._cache[dev_id][1] is offline


async def test_auto_clear_drops_only_live_ports_that_are_not_active(monkeypatch):
    dev_id = "kvm-mixed"
    marked_long_ago = time.monotonic() + _IN_USE_TTL - 600
    kvms_module._in_use[dev_id] = {1: marked_long_ago, 2: marked_long_ago, 3: marked_long_ago}
    fresh = _status(dev_id, _port(1, status="empty"), _port(2, status="active"), _port(3, status="idle"))
    monkeypatch.setattr(kvms_module, "_fetch_status", AsyncMock(return_value=fresh))
    monkeypatch.setattr(kvms_module, "ensure_session", AsyncMock())

    await kvms_module._refresh_background(dev_id, SimpleNamespace())

    assert set(kvms_module._in_use[dev_id]) == {2}


async def test_in_use_mark_lasts_four_hours_and_remarking_extends_it(client, kvm, monkeypatch):
    dev_id = kvm["id"]
    clock = _fake_clock(monkeypatch)
    kvms_module._cache[dev_id] = (clock[0], _status(dev_id, _port(1, "srv")))

    async def port1_in_use():
        kvms_module._cache[dev_id] = (clock[0], kvms_module._cache[dev_id][1])  # keep cache fresh
        return (await client.get(f"/api/kvms/{dev_id}/status")).json()["ports"][0]["in_use"]

    await client.post(f"/api/kvms/{dev_id}/ports/1/mark-in-use")
    clock[0] += _IN_USE_TTL - 60
    assert await port1_in_use() is True
    await client.post(f"/api/kvms/{dev_id}/ports/1/mark-in-use")  # console still open: re-mark
    clock[0] += 120                                              # past the first mark's expiry
    assert await port1_in_use() is True
    clock[0] += _IN_USE_TTL
    assert await port1_in_use() is False


async def test_mark_free_for_one_port_keeps_other_ports_in_use(client, kvm):
    dev_id = kvm["id"]
    kvms_module._cache[dev_id] = (time.monotonic(), _status(dev_id, _port(1), _port(2), _port(3)))
    await client.post(f"/api/kvms/{dev_id}/ports/1/mark-in-use")
    await client.post(f"/api/kvms/{dev_id}/ports/2/mark-in-use")

    r = await client.post(f"/api/kvms/{dev_id}/ports/1/mark-free")
    assert r.status_code == 200 and r.json() == {"ok": True}

    ports = (await client.get(f"/api/kvms/{dev_id}/status")).json()["ports"]
    assert [p["number"] for p in ports if p["in_use"]] == [2]


async def test_overlay_never_mutates_cached_status_and_free_takes_effect_at_once(client, kvm):
    dev_id = kvm["id"]
    cached = _status(dev_id, _port(1, "srv"))
    kvms_module._cache[dev_id] = (time.monotonic(), cached)
    await client.post(f"/api/kvms/{dev_id}/ports/1/mark-in-use")

    assert (await client.get(f"/api/kvms/{dev_id}/status")).json()["ports"][0]["in_use"] is True
    assert cached.ports[0].in_use is False  # overlay was applied to a copy

    await client.post(f"/api/kvms/{dev_id}/mark-free")
    assert (await client.get(f"/api/kvms/{dev_id}/status")).json()["ports"][0]["in_use"] is False


def test_in_use_marks_are_per_device_and_never_invent_ports():
    now = time.monotonic()
    kvms_module._in_use["kvm-a"] = {1: now + 3600, 9: now + 3600}
    a = _apply_overlays("kvm-a", _status("kvm-a", _port(1), _port(2)), {})
    b = _apply_overlays("kvm-b", _status("kvm-b", _port(1), _port(2)), {})

    assert [(p.number, p.in_use) for p in a.ports] == [(1, True), (2, False)]  # no phantom port 9
    assert [(p.number, p.in_use) for p in b.ports] == [(1, False), (2, False)]


# ── Inventory labels on the status endpoint ───────────────────────────────────

async def test_label_edits_and_clears_show_on_cached_status_without_device_refresh(client, kvm, monkeypatch):
    dev_id = kvm["id"]
    kvms_module._cache[dev_id] = (time.monotonic(), _status(dev_id, _port(1, "name-on-kvm"), _port(2, "other")))
    fetch = AsyncMock()
    monkeypatch.setattr(kvms_module, "_fetch_status", fetch)

    r = await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "build-node"})
    assert r.status_code == 200
    ports = (await client.get(f"/api/kvms/{dev_id}/status")).json()["ports"]
    assert [p["label"] for p in ports] == ["build-node", "other"]

    # Clearing must not bring back the name the KVM itself reports.
    r = await client.patch(f"/api/devices/{dev_id}/labels", json={"1": ""})
    assert r.status_code == 200
    ports = (await client.get(f"/api/kvms/{dev_id}/status")).json()["ports"]
    assert [p["label"] for p in ports] == ["Port 1", "other"]
    fetch.assert_not_awaited()


async def test_fetch_status_uses_decrypted_credentials_and_inventory_labels_win(client, kvm, db_session, monkeypatch):
    dev_id = kvm["id"]
    await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "db-label"})
    dev = await db_session.get(Device, dev_id)
    assert "kvm-s3cret" not in dev.password_enc and "kvm-admin" not in dev.username_enc

    created = []

    def handler(request):
        if request.url.path == "/api/v1/targets":
            return httpx.Response(200, json=[
                {"portNumber": 1, "name": "name-on-kvm", "status": "active"},
                {"portNumber": 2, "name": "srv-2", "status": "idle"},
            ])
        return httpx.Response(200, text="<html>ok</html>")

    def make_driver(ip, username, password, model="KX III"):
        created.append((ip, username, password, model))
        return _mock_driver(model, handler, username=username, password=password)

    monkeypatch.setattr(kvms_module, "RaritanKvmDriver", make_driver)
    status = await kvms_module._fetch_status(dev_id, dev)

    assert created == [(KVM_IP, "kvm-admin", "kvm-s3cret", "KX III")]
    assert status.reachable is True and status.error is None
    assert [(p.number, p.label, p.status, p.status_source) for p in status.ports] == [
        (1, "db-label", "active", "live"), (2, "srv-2", "idle", "live")]


# ── 404s and viewer URLs ──────────────────────────────────────────────────────

async def test_kvm_endpoints_reject_a_pdu_device_id(client):
    r = await client.post("/api/devices/", json={
        "name": "PDU-Gap", "kind": "pdu", "ip": "192.0.2.50", "model": "PX3", "rack": "R1", "port_count": 8,
    })
    pdu_id = r.json()["id"]
    assert (await client.get(f"/api/kvms/{pdu_id}/status")).status_code == 404
    assert (await client.get(f"/api/kvms/{pdu_id}/ports/1/viewer")).status_code == 404
    assert pdu_id not in kvms_module._cache


async def test_viewer_embeds_through_same_origin_proxy_for_every_port(client, kvm):
    dev_id = kvm["id"]
    expected = {
        "embed_url": f"/api/kvms/{dev_id}/proxy/home.asp",
        "launch_url": f"https://{KVM_IP}/home.asp",
        "can_embed": True,
    }
    for port in (1, 4):
        r = await client.get(f"/api/kvms/{dev_id}/ports/{port}/viewer")
        assert r.status_code == 200
        assert r.json() == expected


# ── Driver: REST parsing and fallbacks ────────────────────────────────────────

@pytest.mark.parametrize("payload", [
    {"targets": [
        {"portNumber": 1, "label": "by-label", "state": "busy"},
        {"portNumber": 2, "targetName": "by-target-name", "status": "notConfigured"},
        {"portNumber": 3, "connectionStatus": "available"},
    ]},
    {"list": [
        {"number": 1, "label": "by-label", "state": "busy"},
        {"number": 2, "targetName": "by-target-name", "status": "notConfigured"},
        {"number": 3, "connectionStatus": "available"},
    ]},
])
async def test_rest_accepts_wrapped_target_lists_and_alternate_field_names(payload):
    seen = []
    driver = _mock_driver("KX III", lambda r: httpx.Response(200, json=payload), seen)
    ports = await driver.get_ports(port_count=3)
    await driver.close()

    assert ports == [
        {"number": 1, "label": "by-label", "status": "active", "status_source": "live"},
        {"number": 2, "label": "by-target-name", "status": "empty", "status_source": "live"},
        {"number": 3, "label": "Port 3", "status": "idle", "status_source": "live"},
    ]
    assert driver.auth_error is None
    assert seen == ["GET /api/v1/targets"]  # no sidebar scraping when REST works


async def test_rest_server_error_falls_back_to_basic_sidebar_without_form_login():
    seen = []

    def handler(request):
        if request.url.path == "/api/v1/targets":
            return httpx.Response(500, text="internal error")
        if request.url.path == "/sidebar.asp":
            return httpx.Response(200, text=SIDEBAR_PORT_1)
        return httpx.Response(404)

    driver = _mock_driver("KX III", handler, seen)
    ports = await driver.get_ports(port_count=2)
    await driver.close()

    assert seen == ["GET /api/v1/targets", "GET /sidebar.asp"]  # Basic sidebar not skipped after a 500
    assert driver.auth_error is None
    assert [(p["number"], p["status"], p["status_source"]) for p in ports] == [
        (1, "idle", "configured"), (2, "empty", "configured")]


async def test_kx3_without_rest_or_configured_ports_uses_static_list_without_auth_error():
    seen = []

    def handler(request):
        if request.url.path == "/api/v1/targets":
            return httpx.Response(404)
        if request.url.path == "/auth.asp":
            return httpx.Response(200, text="<html>home</html>", headers={"set-cookie": "SID=1; Path=/"})
        if request.url.path == "/sidebar.asp":
            return httpx.Response(200, text="<html>no targets configured</html>")
        return httpx.Response(404)

    driver = _mock_driver("KX III", handler, seen)
    ports = await driver.get_ports(port_count=3)
    await driver.close()

    assert seen == ["GET /api/v1/targets", "GET /sidebar.asp", "POST /auth.asp", "GET /sidebar.asp"]
    assert driver.auth_error is None
    assert ports == [{"number": n, "label": f"Port {n}", "status": "idle", "status_source": "unknown"}
                     for n in (1, 2, 3)]


async def test_real_clients_send_basic_auth_follow_redirects_and_post_form_login(monkeypatch):
    """Exercise the driver's own client construction (not test-injected clients)."""
    requests = []
    real_client = httpx.AsyncClient

    def handler(request):
        requests.append(request)
        path = request.url.path
        if path == "/api/v1/targets":
            return httpx.Response(302, headers={"location": "/api/v1/targets/"})
        if path == "/api/v1/targets/":
            return httpx.Response(200, json=[{"portNumber": 1, "name": "srv", "status": "idle"}])
        if path == "/auth.asp":
            return httpx.Response(200, text="<html>home</html>", headers={"set-cookie": "SID=1; Path=/"})
        return httpx.Response(404)

    monkeypatch.setattr(raritan_kvm.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))

    driver = RaritanKvmDriver("example.invalid", "kvm-user", "kvm-pass", model="KX III")
    try:
        ports = await driver.get_ports(port_count=1)
        assert ports == [{"number": 1, "label": "srv", "status": "idle", "status_source": "live"}]
        expected_basic = "Basic " + base64.b64encode(b"kvm-user:kvm-pass").decode()
        assert [r.headers.get("authorization") for r in requests] == [expected_basic, expected_basic]
        assert all(r.url.scheme == "https" for r in requests)

        requests.clear()
        with pytest.raises(raritan_kvm.RaritanKvmError):
            await driver._get_ports_sidebar(2, basic_rejected=True)  # form login only
        login = requests[0]
        assert login.method == "POST" and login.url.path == "/auth.asp"
        assert login.url.params["client"] == "javascript"
        form = {k: v[0] for k, v in parse_qs(login.content.decode(), keep_blank_values=True).items()}
        assert form["login"] == "kvm-user" and form["password"] == "kvm-pass"
        assert form["action_login"] == "Login" and form["is_javascript_kvm_client"] == "1"
        assert "authorization" not in login.headers  # credentials only in the form body
    finally:
        await driver.close()


@pytest.mark.parametrize("html,expected", [
    ("<input type='password' name='pw'>", True),
    ('<INPUT NAME="pw" TYPE = "PASSWORD">', True),
    ("<input class=x type=password>", True),
    ('<form><button name="action_login">Go</button></form>', True),
    ("<p>Change your password in User Management</p>", False),
    ("<input type='text' name='password'>", False),
])
def test_login_page_detection(html, expected):
    assert _is_login_page(html) is expected


# ── Driver: session token and client lifecycle ───────────────────────────────

async def test_session_token_login_posts_json_and_tolerates_failures():
    bodies = []
    mode = {"value": "ok"}

    def handler(request):
        bodies.append((request.method, request.url.path, json.loads(request.content)))
        if mode["value"] == "boom":
            raise httpx.ConnectError("refused")
        if mode["value"] == "denied":
            return httpx.Response(401, json={"token": "must-not-be-used"})
        return httpx.Response(200, json={"token": "tok-123"})

    driver = RaritanKvmDriver("example.invalid", "kvm-user", "kvm-pass")
    driver._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        assert await driver.get_session_token() == "tok-123"
        assert bodies[0] == ("POST", "/api/v1/auth/login", {"username": "kvm-user", "password": "kvm-pass"})
        mode["value"] = "denied"
        assert await driver.get_session_token() is None
        mode["value"] = "boom"
        assert await driver.get_session_token() is None
    finally:
        await driver.close()


async def test_driver_reopens_its_client_after_close_and_close_is_idempotent():
    driver = RaritanKvmDriver("example.invalid", "", "")
    first = await driver._client_ctx()
    assert await driver._client_ctx() is first  # reused while open
    await driver.close()
    await driver.close()                         # second close is harmless
    assert first.is_closed
    second = await driver._client_ctx()
    try:
        assert second is not first and not second.is_closed
        assert second.follow_redirects is True
    finally:
        await driver.close()


# ── Real bugs (kept as strict xfail; product code not changed here) ──────────

@pytest.mark.xfail(strict=True, reason=(
    "BUG: KX III whose /api/v1/targets answers HTTP 200 with HTML (older firmware without the "
    "REST API, or a redirect to a page) raises JSONDecodeError out of get_ports(); the sidebar "
    "fallback is never tried and the reachable KVM is reported unreachable as 'Device API probe failed'"))
async def test_rest_html_answer_falls_back_to_sidebar_instead_of_marking_kvm_unreachable(monkeypatch):
    def handler(request):
        if request.url.path == "/api/v1/targets":
            return httpx.Response(200, text="<html><body>Dominion KX III</body></html>")
        if request.url.path == "/sidebar.asp":
            return httpx.Response(200, text=SIDEBAR_PORT_1)
        return httpx.Response(200, text="<html>ok</html>")

    driver = _mock_driver("KX III", handler)
    monkeypatch.setattr(kvms_module, "RaritanKvmDriver", lambda *a, **kw: driver)
    monkeypatch.setattr(kvms_module, "get_creds", lambda dev: ("u", "p"))
    status = await kvms_module._fetch_status("kvm-old-fw", SimpleNamespace(
        ip="example.invalid", model="KX III", port_count=2, labels_json="{}"))

    assert status.reachable is True and status.error is None
    assert [(p.number, p.status, p.status_source) for p in status.ports] == [
        (1, "idle", "configured"), (2, "empty", "configured")]


@pytest.mark.xfail(strict=True, reason=(
    "BUG: a single REST target with \"name\": null makes KvmPort(label=None) fail validation in "
    "_fetch_status, so the whole reachable KVM is reported unreachable ('Device API probe failed') "
    "and the other ports' live state is lost"))
async def test_rest_target_without_a_name_does_not_hide_the_whole_kvm(monkeypatch):
    def handler(request):
        if request.url.path == "/api/v1/targets":
            return httpx.Response(200, json=[
                {"portNumber": 1, "name": None, "status": "notConfigured"},
                {"portNumber": 2, "name": "srv-2", "status": "active"},
            ])
        return httpx.Response(200, text="<html>ok</html>")

    driver = _mock_driver("KX III", handler)
    monkeypatch.setattr(kvms_module, "RaritanKvmDriver", lambda *a, **kw: driver)
    monkeypatch.setattr(kvms_module, "get_creds", lambda dev: ("u", "p"))
    status = await kvms_module._fetch_status("kvm-unnamed", SimpleNamespace(
        ip="example.invalid", model="KX III", port_count=2, labels_json="{}"))

    assert status.reachable is True and status.error is None
    assert isinstance(status.ports[0].label, str)
    assert (status.ports[1].number, status.ports[1].label, status.ports[1].status) == (2, "srv-2", "active")
