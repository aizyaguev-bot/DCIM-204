"""
Gap tests for the PDU router (app/routers/pdus.py) and the Raritan PDU driver
(drivers/raritan_pdu.py): status cache lifecycle, outlet power guard, unknown
readings, fixed error classes and per-PDU request limits.

The PDU is simulated with httpx.MockTransport speaking Raritan JSON-RPC. No
test opens a socket, contacts a device, the VM or the live site.
"""
import asyncio
import base64
import json
import time

import httpx
import pytest

import app.routers.pdus as pdus_module
import drivers.raritan_pdu as raritan_pdu
from app.models import Device, PduMaintenance
from app.schemas import OutletState, PduStatus
from drivers.raritan_pdu import PDU_PATH, RaritanPduDriver, RaritanPduError, safe_error

SECRET = "synthetic-secret-91c4"
_REAL_ASYNC_CLIENT = httpx.AsyncClient


# ── Simulated Raritan PDU ─────────────────────────────────────────────────────

class FakePdu:
    """A Raritan JSON-RPC PDU behind httpx.MockTransport. Records every call."""

    def __init__(self, outlets=3, inlets=1, delay=0.0):
        self.power = {n: 1 for n in range(1, outlets + 1)}     # outlet -> powerState
        self.cycling = set()
        self.names = {n: f"device-name-{n}" for n in range(1, outlets + 1)}
        self.inlets = inlets
        self.readings: dict[str, object] = {}                   # sensor rid -> getReading _ret_
        for n in range(1, outlets + 1):
            self.readings[f"/outlet.{n - 1}/activePower"] = {"value": 100.0 * n, "valid": True, "available": True}
            self.readings[f"/outlet.{n - 1}/current"] = {"value": 0.5 * n, "valid": True, "available": True}
            self.readings[f"/outlet.{n - 1}/voltage"] = {"value": 230.0, "valid": True, "available": True}
        for n in range(inlets):
            self.readings[f"/inlet.{n}/voltage"] = {"value": 231.0 + n, "valid": True, "available": True}
            self.readings[f"/inlet.{n}/current"] = {"value": 4.0, "valid": True, "available": True}
            self.readings[f"/inlet.{n}/activePower"] = {"value": 900.0, "valid": True, "available": True}
        self.port_get = httpx.Response(404)
        self.channel = {"rid": "/eventservice/channel-7"}
        self.events: list = []
        self.subscribe_error = False
        self.overrides: dict[tuple[str, str], object] = {}      # (path, method) -> _ret_ or httpx.Response
        self.calls: list[tuple[str, str, object]] = []
        self.requests: list[httpx.Request] = []
        self.delay = delay
        self.inflight = 0
        self.peak = 0

    def transport(self):
        return httpx.MockTransport(self.handler)

    def switch_calls(self):
        return [c for c in self.calls if c[1] in ("setPowerState", "cyclePowerState")]

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "GET":
            return self.port_get
        payload = json.loads(request.content)
        path, method, params = request.url.path, payload["method"], payload["params"]
        self.calls.append((path, method, params))
        self.inflight += 1
        self.peak = max(self.peak, self.inflight)
        try:
            await asyncio.sleep(self.delay)
            ret = self._answer(path, method, params)
        finally:
            self.inflight -= 1
        if isinstance(ret, httpx.Response):
            return ret
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"_ret_": ret}})

    def _answer(self, path, method, params):
        if (path, method) in self.overrides:
            return self.overrides[(path, method)]
        if path == PDU_PATH and method == "getOutlets":
            return [{"rid": f"/outlet.{n - 1}"} for n in self.power]
        if path == PDU_PATH and method == "getInlets":
            return [{"rid": f"/inlet.{n}"} for n in range(self.inlets)]
        if path == "/eventservice" and method == "createChannel":
            return self.channel
        if path.startswith("/eventservice/channel"):
            if method == "subscribe":
                if self.subscribe_error:
                    return httpx.Response(500, text=f"subscribe failed {SECRET}")
                return 0
            if method == "pollEvents":
                return self.events
        if method == "getReading":
            return self.readings.get(path)
        if method == "getSensors":
            return {s: {"rid": f"{path}/{s}"} for s in ("activePower", "current", "voltage")}
        if path.startswith("/outlet."):
            number = int(path.rsplit(".", 1)[1]) + 1
            if method == "getState":
                return {"powerState": self.power[number], "cycleInProgress": number in self.cycling}
            if method == "getSettings":
                return {"name": self.names[number]}
            if method == "setPowerState":
                self.power[number] = params["pstate"]
                return 0
            if method == "cyclePowerState":
                return 0
        return httpx.Response(404)


def attach(driver: RaritanPduDriver, fake: FakePdu) -> RaritanPduDriver:
    """Give a real driver a client whose transport is the simulated PDU."""
    driver._client = _REAL_ASYNC_CLIENT(transport=fake.transport(), auth=driver.auth)
    return driver


def driver_factory(fakes, built):
    """Stands in for RaritanPduDriver in the router: real driver, simulated device chosen by address."""
    def make(ip, username, password):
        driver = attach(RaritanPduDriver(ip, username, password), fakes[ip] if isinstance(fakes, dict) else fakes)
        built.append({"ip": ip, "username": username, "password": password, "driver": driver})
        return driver
    return make


PDU_BODY = {"name": "PDU-Gap", "kind": "pdu", "ip": "192.0.2.10", "model": "PX4", "rack": "R9", "port_count": 3}


@pytest.fixture
async def pdu(client):
    r = await client.post("/api/devices/", json=PDU_BODY)
    assert r.status_code == 201, r.text
    return r.json()


def cached_status(dev_id, labels=("cached-1", "cached-2"), watts=50.0):
    return PduStatus(device_id=dev_id, reachable=True, inlet_voltage=229.0, total_watts=watts * len(labels),
                     watts_complete=True,
                     outlets=[OutletState(number=n, label=l, state="on", watts=watts) for n, l in enumerate(labels, 1)])


# ── Status endpoint and cache ─────────────────────────────────────────────────

async def test_status_and_power_reject_a_kvm_id_without_building_a_driver(client, monkeypatch):
    r = await client.post("/api/devices/", json={**PDU_BODY, "name": "KVM-Gap", "kind": "kvm"})
    kvm_id = r.json()["id"]
    built = []
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(FakePdu(), built))
    assert (await client.get(f"/api/pdus/{kvm_id}/status")).status_code == 404
    assert (await client.post(f"/api/pdus/{kvm_id}/outlets/1/power", json={"action": "off"})).status_code == 404
    assert (await client.get(f"/api/pdus/{kvm_id}/sensors-debug")).status_code == 404
    assert built == [] and kvm_id not in pdus_module._cache


async def test_first_load_reads_the_simulated_pdu_and_caches_the_result(client, pdu, monkeypatch):
    fake, built = FakePdu(outlets=2), []
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    first = await client.get(f"/api/pdus/{pdu['id']}/status")
    calls_after_first = len(fake.calls)
    second = await client.get(f"/api/pdus/{pdu['id']}/status")
    body = first.json()
    assert body["reachable"] is True
    assert [(o["number"], o["label"], o["state"], o["watts"]) for o in body["outlets"]] == [
        (1, "device-name-1", "on", 100.0), (2, "device-name-2", "on", 200.0)]
    assert body["total_watts"] == 300.0 and body["watts_complete"] is True
    assert body["inlet_voltage"] == 231.0
    assert second.json() == body
    assert len(fake.calls) == calls_after_first        # the second read came from the cache
    assert len(built) == 1 and built[0]["driver"]._client.is_closed


async def test_unreachable_first_load_is_cached_for_the_ttl(client, pdu, monkeypatch):
    fake, built = FakePdu(), []
    fake.overrides[(PDU_PATH, "getOutlets")] = httpx.Response(503, text=f"busy {SECRET}")
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    first = (await client.get(f"/api/pdus/{pdu['id']}/status")).json()
    second = (await client.get(f"/api/pdus/{pdu['id']}/status")).json()
    assert first["reachable"] is False and first["error"] == "Device API responded with HTTP 503"
    assert second == first and len(built) == 1          # no second device read inside the TTL
    assert SECRET not in json.dumps(first)


async def test_stale_cache_is_served_then_replaced_by_the_background_refresh(client, pdu, monkeypatch):
    dev_id = pdu["id"]
    stale_at = time.monotonic() - pdus_module._CACHE_TTL - 1
    pdus_module._cache[dev_id] = (stale_at, cached_status(dev_id, labels=("old-1", "old-2")))
    fake, built = FakePdu(outlets=2), []
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))

    served = (await client.get(f"/api/pdus/{dev_id}/status")).json()
    assert [o["label"] for o in served["outlets"]] == ["old-1", "old-2"]   # instant answer, no wait on the PDU

    fetched_at, refreshed = pdus_module._cache[dev_id]
    assert fetched_at > stale_at and time.monotonic() - fetched_at < pdus_module._CACHE_TTL
    assert [o.label for o in refreshed.outlets] == ["device-name-1", "device-name-2"]
    assert dev_id not in pdus_module._refreshing and len(built) == 1
    after = (await client.get(f"/api/pdus/{dev_id}/status")).json()
    assert [o["label"] for o in after["outlets"]] == ["device-name-1", "device-name-2"]
    assert len(built) == 1                              # the refreshed entry is fresh again


async def test_label_overlay_keeps_device_names_and_never_rewrites_the_cache(client, pdu):
    dev_id = pdu["id"]
    pdus_module._cache[dev_id] = (time.monotonic(), cached_status(dev_id, labels=("pdu-own-1", "pdu-own-2")))
    r = await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "GPU-Node-7"})
    assert r.status_code == 200
    body = (await client.get(f"/api/pdus/{dev_id}/status")).json()
    assert [o["label"] for o in body["outlets"]] == ["GPU-Node-7", "pdu-own-2"]
    assert [o.label for o in pdus_module._cache[dev_id][1].outlets] == ["pdu-own-1", "pdu-own-2"]


async def test_fetch_status_applies_saved_labels_and_passes_env_and_inlet_readings(monkeypatch):
    fake = FakePdu(outlets=3, inlets=2)
    fake.port_get = httpx.Response(200, json={"temperature": 24.46, "humidity": 41.04, "leakDetected": 0})
    dev = Device(id="p1", name="p", kind="pdu", ip="192.0.2.30", labels_json=json.dumps({"2": "OPT-22", "9": "ghost"}))
    built = []
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    status = await pdus_module._fetch_status("p1", dev)
    assert status.reachable is True
    assert [o.label for o in status.outlets] == ["device-name-1", "OPT-22", "device-name-3"]   # no ghost outlet 9
    assert (status.temperature, status.humidity, status.leak_detected) == (24.5, 41.0, False)
    assert [(i.number, i.voltage) for i in status.inlet_readings] == [(1, 231.0), (2, 232.0)]
    assert status.inlet_voltage == 231.0                # the display value is the first inlet
    assert built[0]["driver"]._client.is_closed


async def test_refresh_background_releases_the_in_progress_flag_after_a_crash(monkeypatch):
    async def boom(device_id, dev):
        raise RuntimeError("decryption failed")
    monkeypatch.setattr(pdus_module, "_fetch_status", boom)
    with pytest.raises(RuntimeError):
        await pdus_module._refresh_background("crashy", object())
    assert "crashy" not in pdus_module._refreshing and "crashy" not in pdus_module._cache

    async def ok(device_id, dev):
        return PduStatus(device_id=device_id, reachable=True)
    monkeypatch.setattr(pdus_module, "_fetch_status", ok)
    await pdus_module._refresh_background("crashy", object())   # a later refresh is not skipped forever
    assert pdus_module._cache["crashy"][1].reachable is True


# ── Outlet power ──────────────────────────────────────────────────────────────

async def test_power_uses_device_address_and_decrypted_credentials(client, monkeypatch):
    r = await client.post("/api/devices/", json={**PDU_BODY, "username": "pdu-admin", "password": SECRET})
    assert SECRET not in r.text
    dev_id = r.json()["id"]
    fake, built = FakePdu(), []
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    r = await client.post(f"/api/pdus/{dev_id}/outlets/3/power", json={"action": "off"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "outlet": 3, "action": "off"}
    assert [(b["ip"], b["username"], b["password"]) for b in built] == [("192.0.2.10", "pdu-admin", SECRET)]
    assert fake.switch_calls() == [("/outlet.2", "setPowerState", {"pstate": 0})] and fake.power[3] == 0
    assert built[0]["driver"]._client.is_closed


@pytest.mark.parametrize("action,expected", [
    ("on", ("/outlet.1", "setPowerState", {"pstate": 1})),
    ("off", ("/outlet.1", "setPowerState", {"pstate": 0})),
    ("cycle", ("/outlet.1", "cyclePowerState", {})),
])
async def test_each_action_sends_exactly_one_matching_rpc_to_the_one_based_outlet(action, expected):
    fake = FakePdu()
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        assert await driver.set_outlet_state(2, action) is True
    finally:
        await driver.close()
    assert fake.switch_calls() == [expected]


@pytest.mark.parametrize("outlet", [0, 4, -1])
async def test_out_of_range_outlet_never_switches_any_outlet(client, pdu, monkeypatch, outlet):
    # Outlet 0 must not wrap around to the last outlet through Python's negative indexing.
    fake, built = FakePdu(outlets=3), []
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    r = await client.post(f"/api/pdus/{pdu['id']}/outlets/{outlet}/power", json={"action": "off"})
    assert r.status_code == 502
    assert r.json()["detail"] == f"Outlet {outlet} out of range (max 3)"
    assert fake.switch_calls() == [] and fake.power == {1: 1, 2: 1, 3: 1}
    assert built[0]["driver"]._client.is_closed


@pytest.mark.parametrize("action", ["ON", "Cycle", " on", "on ", "power-on"])
async def test_action_spellings_cannot_slip_past_the_maintenance_guard(client, pdu, monkeypatch, db_session, action):
    db_session.add(PduMaintenance(device_id=pdu["id"], started_at=time.time(), started_by="test",
                                  outlets_off_json="[1, 2, 3]", failed_json="[]"))
    await db_session.commit()
    fake, built = FakePdu(), []
    fake.power = {1: 0, 2: 0, 3: 0}
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    r = await client.post(f"/api/pdus/{pdu['id']}/outlets/1/power", json={"action": action})
    assert r.status_code == 400
    assert r.json()["detail"] == "Unknown action; use on, off or cycle"
    assert fake.switch_calls() == [] and fake.power == {1: 0, 2: 0, 3: 0}


async def test_malformed_power_requests_are_422_and_never_reach_the_pdu(client, pdu, monkeypatch):
    fake, built = FakePdu(), []
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    for path, body in ((f"/api/pdus/{pdu['id']}/outlets/1/power", {}),
                       (f"/api/pdus/{pdu['id']}/outlets/one/power", {"action": "off"})):
        assert (await client.post(path, json=body)).status_code == 422
    assert built == [] and fake.calls == []


async def test_power_switch_invalidates_only_that_pdus_cache(client, pdu, monkeypatch):
    other = (await client.post("/api/devices/", json={**PDU_BODY, "name": "PDU-Other", "ip": "192.0.2.11"})).json()
    pdus_module._cache[pdu["id"]] = (time.monotonic(), cached_status(pdu["id"]))
    pdus_module._cache[other["id"]] = (time.monotonic(), cached_status(other["id"]))
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(FakePdu(), []))
    r = await client.post(f"/api/pdus/{pdu['id']}/outlets/1/power", json={"action": "cycle"})
    assert r.status_code == 200
    assert pdu["id"] not in pdus_module._cache and other["id"] in pdus_module._cache


async def test_failed_switch_reports_fixed_class_and_closes_the_connection(client, pdu, monkeypatch):
    fake, built = FakePdu(), []
    fake.overrides[("/outlet.0", "setPowerState")] = httpx.Response(
        200, json={"error": {"code": 7, "message": f"denied for {SECRET}"}})
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    r = await client.post(f"/api/pdus/{pdu['id']}/outlets/1/power", json={"action": "off"})
    assert r.status_code == 502 and r.json()["detail"] == "RPC error 7"
    assert SECRET not in r.text
    assert built[0]["driver"]._client.is_closed


# ── Sensors debug endpoint ────────────────────────────────────────────────────

async def test_sensors_debug_endpoint_returns_numeric_samples_only(client, pdu, monkeypatch):
    fake, built = FakePdu(), []
    fake.port_get = httpx.Response(401, text=f"<html>{SECRET}</html>")
    fake.subscribe_error = True
    fake.events = [{"rid": "/sensors/externalsensor.temperature", "reading": {"value": 23.5, "note": SECRET}},
                   {"rid": f"/sensors/{SECRET}-text", "reading": {"value": "warm"}}]
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, built))
    r = await client.get(f"/api/pdus/{pdu['id']}/sensors-debug")
    assert r.status_code == 200 and SECRET not in r.text
    body = r.json()
    assert body["GET_port"] == {"status": 401}
    assert body["channel"] == "/eventservice/channel-7"
    assert body["subscribe_none"] == body["subscribe_list"] == body["subscribe_object"] == "Device API responded with HTTP 500"
    assert body["sensors"] == [{"name": "externalsensor.temperature", "value": 23.5}]
    assert built[0]["driver"]._client.is_closed


async def test_sensors_debug_endpoint_maps_driver_failures_to_502_without_text(client, pdu, monkeypatch):
    closed = []

    class Exploding:
        def __init__(self, *args):
            pass

        async def list_sensors(self):
            raise httpx.ConnectError(f"[Errno 111] Connection refused https://admin:{SECRET}@pdu")

        async def close(self):
            closed.append(True)

    monkeypatch.setattr(pdus_module, "RaritanPduDriver", Exploding)
    r = await client.get(f"/api/pdus/{pdu['id']}/sensors-debug")
    assert r.status_code == 502 and r.json()["detail"] == "Device API connection refused"
    assert SECRET not in r.text and closed == [True]


# ── Driver: transport, RPC envelope and error classes ─────────────────────────

async def test_rpc_sends_jsonrpc_envelope_over_https_with_basic_auth(monkeypatch):
    fake, created = FakePdu(), []

    def client_factory(**kwargs):
        created.append(kwargs)
        return _REAL_ASYNC_CLIENT(transport=fake.transport(), **kwargs)

    monkeypatch.setattr(raritan_pdu.httpx, "AsyncClient", client_factory)
    driver = RaritanPduDriver("192.0.2.40", "pdu-user", SECRET)
    try:
        assert await driver._rpc(PDU_PATH, "getOutlets") == [{"rid": "/outlet.0"}, {"rid": "/outlet.1"}, {"rid": "/outlet.2"}]
        await driver._rpc("/outlet.0", "setPowerState", {"pstate": 0})
    finally:
        await driver.close()
    first, second = fake.requests
    assert str(first.url) == "https://192.0.2.40/model/pdu/1" and first.method == "POST"
    assert json.loads(first.content) == {"jsonrpc": "2.0", "method": "getOutlets", "params": [], "id": 1}
    assert json.loads(second.content)["params"] == {"pstate": 0}
    expected = "Basic " + base64.b64encode(f"pdu-user:{SECRET}".encode()).decode()
    assert first.headers["authorization"] == expected
    assert len(created) == 1                            # one connection pool per driver, reused across calls
    assert created[0]["timeout"].read == raritan_pdu.TIMEOUT


@pytest.mark.parametrize("response,expected", [
    (httpx.Response(200, json=[1, 2, 3]), "Device API returned an invalid response"),
    (httpx.Response(200, json="text"), "Device API returned an invalid response"),
    (httpx.Response(200, json={"error": f"plain {SECRET}"}), "RPC error ?"),
    (httpx.Response(200, json={"error": {"message": SECRET}}), "RPC error ?"),
    (httpx.Response(500, text=SECRET), "Device API responded with HTTP 500"),
])
async def test_rpc_failure_shapes_map_to_fixed_classes(response, expected):
    fake = FakePdu()
    fake.overrides[(PDU_PATH, "getMetaData")] = response
    driver = attach(RaritanPduDriver("192.0.2.10", "u", SECRET), fake)
    try:
        with pytest.raises(RaritanPduError) as info:
            await driver._rpc(PDU_PATH, "getMetaData")
        assert await driver.ping() is False
    finally:
        await driver.close()
    assert str(info.value) == expected and SECRET not in str(info.value)


@pytest.mark.parametrize("body,expected", [
    ({"result": {"_ret_": 5}}, 5),
    ({"result": {"other": 5}}, None),
    ({"result": "not-an-object"}, None),
    ({}, None),
])
async def test_rpc_returns_ret_or_none(body, expected):
    fake = FakePdu()
    fake.overrides[(PDU_PATH, "getMetaData")] = httpx.Response(200, json=body)
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        assert await driver._rpc(PDU_PATH, "getMetaData") == expected
        assert await driver.ping() is True
    finally:
        await driver.close()


def test_safe_error_never_returns_foreign_exception_text():
    assert safe_error(RaritanPduError("Device API responded with HTTP 401")) == "Device API responded with HTTP 401"
    assert safe_error(httpx.ReadTimeout(SECRET)) == "Device API request timeout (ReadTimeout)"
    assert safe_error(httpx.ConnectError(f"https://u:{SECRET}@x")) == "Device API connection error"
    assert safe_error(ValueError(SECRET)) == "Device API returned no usable status (ValueError)"


async def test_outlet_rids_are_discovered_once_per_driver():
    fake = FakePdu()
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        await driver.get_outlets()
        await driver.get_outlets()
        await driver.set_outlet_state(1, "off")
    finally:
        await driver.close()
    assert [c for c in fake.calls if c[1] == "getOutlets"] == [(PDU_PATH, "getOutlets", [])]


async def test_requests_to_one_pdu_never_exceed_the_concurrency_limit():
    fake = FakePdu(outlets=12, delay=0.01)
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        outlets = await driver.get_outlets()
    finally:
        await driver.close()
    assert [o["number"] for o in outlets] == list(range(1, 13))
    assert fake.peak == raritan_pdu.MAX_CONCURRENT     # parallel, but capped per PDU


# ── Driver: outlet state, names and readings ──────────────────────────────────

@pytest.mark.parametrize("state,expected", [
    ({"powerState": 0}, "off"),
    ({"powerState": 0, "cycleInProgress": True}, "cycling"),
    ({"powerState": 1, "cycleInProgress": True}, "on"),
    ({"powerState": 2}, "unknown"),
    ({"cycleInProgress": True}, "cycling"),
])
async def test_outlet_power_state_mapping(state, expected):
    fake = FakePdu(outlets=1)
    fake.overrides[("/outlet.0", "getState")] = state
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        (outlet,) = await driver.get_outlets()
    finally:
        await driver.close()
    assert outlet["state"] == expected
    assert outlet["watts"] == 100.0                     # readings are still reported whatever the state


async def test_outlet_name_fallback_and_reading_rounding():
    fake = FakePdu(outlets=2)
    fake.names[2] = ""
    fake.readings["/outlet.0/activePower"] = {"value": 123.456, "valid": True, "available": True}
    fake.readings["/outlet.0/current"] = {"value": 1.23456, "valid": True, "available": True}
    fake.readings["/outlet.0/voltage"] = {"value": 229.96, "valid": True, "available": True}
    fake.readings["/outlet.1/activePower"] = [42]       # malformed reading -> unknown, not a crash
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        first, second = await driver.get_outlets()
    finally:
        await driver.close()
    assert (first["watts"], first["current"], first["voltage"]) == (123.5, 1.23, 230.0)
    assert second["label"] == "Outlet 2" and second["state"] == "on"
    assert second["watts"] is None and second["current"] == 1.0


async def test_failed_inlet_does_not_hide_the_next_inlet_and_display_stays_first():
    fake = FakePdu(inlets=2)
    fake.overrides[("/inlet.0", "getSensors")] = httpx.Response(503)
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        inlet = await driver.get_inlet()
    finally:
        await driver.close()
    assert inlet["readings"] == [
        {"number": 1, "voltage": None, "current": None, "watts": None},
        {"number": 2, "voltage": 232.0, "current": 4.0, "watts": 900.0},
    ]
    assert inlet["voltage"] is None and inlet["watts"] is None   # first inlet unknown, never borrowed from inlet 2


async def test_pdu_without_inlets_reports_unknown_inlet_values():
    fake = FakePdu(inlets=0)
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        inlet = await driver.get_inlet()
    finally:
        await driver.close()
    assert inlet == {"voltage": None, "current": None, "watts": None, "readings": []}


@pytest.mark.xfail(strict=True, reason=(
    "BUG: RaritanPduDriver.get_inlet only catches RaritanPduError/ValueError/TypeError/KeyError; a non-object "
    "getReading/getSensors result (e.g. a bare number) raises AttributeError, so _fetch_status marks the whole "
    "PDU unreachable and hides every outlet, instead of leaving that one inlet reading unknown as outlets do."))
async def test_malformed_inlet_reading_leaves_only_that_reading_unknown(monkeypatch):
    fake = FakePdu(outlets=2)
    fake.readings["/inlet.0/voltage"] = 231.0           # bare number instead of a Reading object
    dev = Device(id="p2", name="p", kind="pdu", ip="192.0.2.31", labels_json="{}")
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory(fake, []))
    status = await pdus_module._fetch_status("p2", dev)
    assert status.reachable is True, status.error
    assert [o.state for o in status.outlets] == ["on", "on"]
    assert status.inlet_voltage is None and status.inlet_readings[0].current == 4.0


# ── Driver: environment sensors ───────────────────────────────────────────────

async def test_env_sensors_fall_back_to_the_event_channel_and_keep_first_values():
    fake = FakePdu()
    fake.port_get = httpx.Response(200, json={"unrelated": 1})   # nothing usable on the port path
    fake.subscribe_error = True                                  # subscribe failures are tolerated
    fake.events = [
        {"rid": "/sensors/externalsensor.Temperature", "reading": {"value": 21.04}},
        {"rid": "/sensors/externalsensor.temperature2", "reading": {"value": 99.0}},
        {"rid": "/sensors/externalsensor.Humidity", "reading": {"value": "n/a"}},
        {"rid": "/sensors/externalsensor.relativeHumidity", "reading": {"value": 55.55}},
        {"rid": "/sensors/externalsensor.WaterDetection", "value": 1},
        "noise",
    ]
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        env = await driver.get_env_sensors()
    finally:
        await driver.close()
    assert env == {"temperature": 21.0, "humidity": 55.5, "leak_detected": True}
    subscribe_params = [c[2] for c in fake.calls if c[1] == "subscribe"]
    assert subscribe_params == [[], [], {}]             # None is sent as the JSON-RPC default []


async def test_env_sensors_are_empty_when_the_pdu_has_none():
    fake = FakePdu()
    fake.channel = None                                  # createChannel returns nothing usable
    driver = attach(RaritanPduDriver("192.0.2.10", "u", "p"), fake)
    try:
        env = await driver.get_env_sensors()
    finally:
        await driver.close()
    assert env == {}
    assert not [c for c in fake.calls if c[1] in ("subscribe", "pollEvents")]


# ── Cache across an address change ────────────────────────────────────────────

@pytest.mark.xfail(strict=True, reason=(
    "BUG: the PDU status cache is keyed by device id only and is not dropped when the device address changes; "
    "after PUT /api/devices/{id} moves a PDU to a new IP, /api/pdus/{id}/status keeps returning the previous "
    "PDU's outlets and states (fresh for 20 s, then once more while refreshing) next to power buttons that "
    "now switch the new PDU."))
async def test_address_change_does_not_serve_the_previous_pdus_outlets(client, pdu, monkeypatch):
    dev_id = pdu["id"]
    old, new, built = FakePdu(outlets=2), FakePdu(outlets=2), []
    new.names = {1: "new-pdu-1", 2: "new-pdu-2"}
    new.power = {1: 0, 2: 0}
    monkeypatch.setattr(pdus_module, "RaritanPduDriver", driver_factory({"192.0.2.10": old, "192.0.2.20": new}, built))
    before = (await client.get(f"/api/pdus/{dev_id}/status")).json()
    assert [o["label"] for o in before["outlets"]] == ["device-name-1", "device-name-2"]

    r = await client.put(f"/api/devices/{dev_id}", json={**PDU_BODY, "ip": "192.0.2.20"})
    assert r.status_code == 200 and r.json()["ip"] == "192.0.2.20"
    after = (await client.get(f"/api/pdus/{dev_id}/status")).json()
    assert [(o["label"], o["state"]) for o in after["outlets"]] == [("new-pdu-1", "off"), ("new-pdu-2", "off")]
