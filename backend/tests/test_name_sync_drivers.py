"""Device name operations stay offline and change no other device settings."""
import copy
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from drivers.raritan_kvm import AUTH_FAILED, RaritanKvmDriver, RaritanKvmError
from drivers.raritan_pdu import NAME_MAX, PDU_PATH, RaritanPduDriver, RaritanPduError, safe_error


OUTLET_RIDS = ["/outlet.0", "/outlet.1"]
PRIVATE_TEXT = "synthetic-private-device-text"
KVM_UNSUPPORTED = "Port names cannot be written to this KVM yet"
OUTLET_TYPE = "pdumodel.Outlet:3.0.3"
CHARACTER_ERROR = "Name has characters the device cannot store"
SETTINGS_ERROR = "Unsupported outlet settings format"
SETTINGS_CHANGED = "Other outlet settings changed during the write - check the PDU"


def _result(value):
    return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"_ret_": value}})


def _outlets(rids=OUTLET_RIDS):
    return [{"rid": rid, "type": OUTLET_TYPE} for rid in rids]


def _settings(name="server-A", **extra):
    return {"name": name, "startupState": 1, "usePduCycleDelay": False,
            "cycleDelay": 12, "nonCritical": False, "sequenceDelay": 7, **extra}


def _changed_settings(original, change):
    changed = copy.deepcopy(original)
    if change == "name":
        changed["name"] = "edited-on-device"
    elif change == "cycleDelay":
        changed["cycleDelay"] = 20
    elif change == "value":
        changed["onDelay"] = 8
    elif change == "type":
        changed["onDelay"] = True
    elif change == "added":
        changed["futureFirmwareSetting"] = 12
    elif change == "removed":
        del changed["onDelay"]
    elif change == "nested":
        changed["loadShedding"]["priority"] = 4
    elif change == "nested-added":
        changed["loadShedding"]["futureFirmwareSetting"] = 12
    else:
        del changed["loadShedding"]["enabled"]
    return changed


def _invalid_required_settings():
    invalid = []
    for field in _settings():
        missing = _settings()
        del missing[field]
        invalid.append(pytest.param(missing, id=f"missing-{field}"))
    for field, value in [
        ("name", None), ("name", 12),
        ("startupState", True), ("startupState", 1.0),
        ("usePduCycleDelay", 0), ("usePduCycleDelay", "false"),
        ("cycleDelay", False), ("cycleDelay", 12.0),
        ("nonCritical", 1), ("nonCritical", "false"),
        ("sequenceDelay", True), ("sequenceDelay", 7.0),
    ]:
        invalid.append(pytest.param(_settings(**{field: value}), id=f"wrong-{field}-{type(value).__name__}"))
    return invalid


@pytest.fixture
async def pdu_factory():
    drivers = []

    def make(handler):
        def names_only(request):
            assert request.method == "POST"
            assert json.loads(request.content)["method"] in {"getOutlets", "getSettings", "setSettings"}
            return handler(request)

        driver = RaritanPduDriver("pdu.example.invalid", "test-user", "test-password")
        driver._client = httpx.AsyncClient(transport=httpx.MockTransport(names_only), follow_redirects=True)
        drivers.append(driver)
        return driver

    yield make
    for driver in drivers:
        await driver.close()


@pytest.fixture
async def kvm_factory():
    drivers = []

    def make(handler, model="KX III"):
        driver = RaritanKvmDriver("kvm.example.invalid", "test-user", "test-password", model=model)
        driver._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        drivers.append(driver)
        return driver

    yield make
    for driver in drivers:
        await driver.close()


async def test_get_outlet_names_preserves_raw_names_and_empty_default(pdu_factory):
    calls = []
    names = {OUTLET_RIDS[0]: "  server-A  ", OUTLET_RIDS[1]: ""}

    def device(request):
        payload = json.loads(request.content)
        calls.append((request.url.path, payload["method"]))
        if request.url.path == PDU_PATH and payload["method"] == "getOutlets":
            return _result(_outlets())
        assert payload["method"] == "getSettings"
        return _result(_settings(names[request.url.path], onDelay=9))

    assert await pdu_factory(device).get_outlet_names() == {1: "  server-A  ", 2: ""}
    assert calls[0] == (PDU_PATH, "getOutlets")
    assert sorted(calls[1:]) == [(rid, "getSettings") for rid in OUTLET_RIDS]


@pytest.mark.parametrize("desired,stored", [
    ("server-B", "stored-by-device"), ("", ""), ("x" * NAME_MAX, "x" * NAME_MAX),
    ("  server-B  ", "server-B"), ("  " + "x" * NAME_MAX + "  ", "x" * NAME_MAX),
])
async def test_set_outlet_name_preserves_full_settings_and_returns_readback(pdu_factory, desired, stored):
    original = _settings(onDelay=7, offDelay=4,
                         loadShedding={"enabled": False, "priority": 3},
                         futureFirmwareField=["keep", {"value": 17}])
    calls = []
    reads = 0

    def device(request):
        nonlocal reads
        payload = json.loads(request.content)
        calls.append((request.url.path, payload["method"], payload["params"]))
        if payload["method"] == "getOutlets":
            return _result(_outlets())
        assert request.url.path == OUTLET_RIDS[1]
        if payload["method"] == "getSettings":
            reads += 1
            return _result(original if reads <= 2 else {**original, "name": stored})
        assert payload["method"] == "setSettings"
        return _result(0)

    assert await pdu_factory(device).set_outlet_name(2, desired) == stored
    expected = copy.deepcopy(original)
    expected["name"] = desired.strip()
    assert calls == [
        (PDU_PATH, "getOutlets", []),
        (OUTLET_RIDS[1], "getSettings", []),
        (OUTLET_RIDS[1], "getSettings", []),
        (OUTLET_RIDS[1], "setSettings", {"settings": expected}),
        (OUTLET_RIDS[1], "getSettings", []),
    ]


@pytest.mark.parametrize("number", [0, -1, True, False, 1.5, "1", None])
async def test_set_outlet_name_rejects_invalid_one_indexed_number(number):
    driver = RaritanPduDriver("pdu.example.invalid", "test-user", "test-password")
    driver._rpc = AsyncMock()
    with pytest.raises(RaritanPduError):
        await driver.set_outlet_name(number, "server-A")
    driver._rpc.assert_not_awaited()


async def test_set_outlet_name_rejects_number_beyond_discovered_outlets(pdu_factory):
    methods = []

    def device(request):
        method = json.loads(request.content)["method"]
        methods.append(method)
        assert method == "getOutlets"
        return _result(_outlets())

    with pytest.raises(RaritanPduError):
        await pdu_factory(device).set_outlet_name(3, "server-A")
    assert methods == ["getOutlets"]


async def test_set_outlet_name_rejects_overlength_without_writing():
    driver = RaritanPduDriver("pdu.example.invalid", "test-user", "test-password")
    driver._rpc = AsyncMock()
    desired = PRIVATE_TEXT + "x" * (NAME_MAX + 1 - len(PRIVATE_TEXT))
    with pytest.raises(RaritanPduError) as caught:
        await driver.set_outlet_name(1, desired)
    assert PRIVATE_TEXT not in safe_error(caught.value)
    assert safe_error(caught.value) == CHARACTER_ERROR
    driver._rpc.assert_not_awaited()


@pytest.mark.parametrize("settings", [None, [], {}, {"name": None}, {"name": 12}, PRIVATE_TEXT])
@pytest.mark.parametrize("operation", ["read", "write", "support"])
async def test_malformed_settings_are_safe_and_never_written(pdu_factory, settings, operation):
    methods = []

    def device(request):
        payload = json.loads(request.content)
        methods.append(payload["method"])
        if payload["method"] == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        assert payload["method"] == "getSettings"
        return _result(settings)

    driver = pdu_factory(device)
    if operation == "support":
        assert await driver.name_support() == (False, SETTINGS_ERROR)
    else:
        with pytest.raises(RaritanPduError) as caught:
            if operation == "read":
                await driver.get_outlet_names()
            else:
                await driver.set_outlet_name(1, "server-A")
        assert safe_error(caught.value) == SETTINGS_ERROR
    assert methods == ["getOutlets", "getSettings"]


@pytest.mark.parametrize("settings", _invalid_required_settings())
@pytest.mark.parametrize("operation", ["read", "write", "support"])
async def test_required_outlet_settings_have_exact_json_types(pdu_factory, settings, operation):
    methods = []

    def device(request):
        method = json.loads(request.content)["method"]
        methods.append(method)
        if method == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        assert method == "getSettings"
        return _result(settings)

    driver = pdu_factory(device)
    if operation == "support":
        assert await driver.name_support() == (False, SETTINGS_ERROR)
    else:
        with pytest.raises(RaritanPduError) as caught:
            if operation == "read":
                await driver.get_outlet_names()
            else:
                await driver.set_outlet_name(1, "server-B")
        assert safe_error(caught.value) == SETTINGS_ERROR
    assert methods == ["getOutlets", "getSettings"]


@pytest.mark.parametrize("change", ["cycleDelay", "name", "value", "type", "added", "removed", "nested", "nested-added", "nested-removed"])
async def test_outlet_change_between_two_prewrite_reads_prevents_write(pdu_factory, change):
    original = _settings(onDelay=1, loadShedding={"enabled": False, "priority": 3})
    changed = _changed_settings(original, change)
    methods = []

    def device(request):
        method = json.loads(request.content)["method"]
        methods.append(method)
        if method == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        assert method == "getSettings"
        return _result(original if methods.count("getSettings") == 1 else changed)

    with pytest.raises(RaritanPduError) as caught:
        await pdu_factory(device).set_outlet_name(1, "server-B")
    assert safe_error(caught.value) == SETTINGS_CHANGED
    assert methods == ["getOutlets", "getSettings", "getSettings"]


@pytest.mark.parametrize("settings", _invalid_required_settings())
@pytest.mark.parametrize("stage", ["second", "postwrite"])
async def test_invalid_required_fields_in_later_reads_fail_closed(pdu_factory, settings, stage):
    methods = []

    def device(request):
        method = json.loads(request.content)["method"]
        methods.append(method)
        if method == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        if method == "getSettings":
            bad_read = 2 if stage == "second" else 3
            return _result(settings if methods.count("getSettings") == bad_read else _settings())
        assert method == "setSettings" and stage == "postwrite"
        return _result(0)

    with pytest.raises(RaritanPduError) as caught:
        await pdu_factory(device).set_outlet_name(1, "server-B")
    # A dict change takes precedence over format errors on subsequent reads.
    # Only an invalid name alone survives the post-write non-name comparison.
    invalid_name_only = json.dumps({key: value for key, value in settings.items() if key != "name"}, sort_keys=True) == json.dumps({
        key: value for key, value in _settings().items() if key != "name"}, sort_keys=True)
    expected = SETTINGS_ERROR if stage == "postwrite" and invalid_name_only else SETTINGS_CHANGED
    assert safe_error(caught.value) == expected
    expected_methods = ["getOutlets", "getSettings", "getSettings"]
    if stage == "postwrite":
        expected_methods += ["setSettings", "getSettings"]
    assert methods == expected_methods


async def test_non_object_second_settings_read_never_writes(pdu_factory):
    methods = []

    def device(request):
        method = json.loads(request.content)["method"]
        methods.append(method)
        if method == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        assert method == "getSettings"
        return _result(_settings() if methods.count("getSettings") == 1 else None)

    with pytest.raises(RaritanPduError) as caught:
        await pdu_factory(device).set_outlet_name(1, "server-B")
    assert safe_error(caught.value) == SETTINGS_ERROR
    assert methods == ["getOutlets", "getSettings", "getSettings"]


@pytest.mark.parametrize("code", [1, 2, -1])
async def test_set_outlet_name_device_refusal_uses_safe_integer_code(pdu_factory, code):
    methods = []

    def device(request):
        payload = json.loads(request.content)
        methods.append(payload["method"])
        if payload["method"] == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        if payload["method"] == "getSettings":
            return _result(_settings(PRIVATE_TEXT, onDelay=7))
        assert payload["method"] == "setSettings"
        return _result(code)

    with pytest.raises(RaritanPduError) as caught:
        await pdu_factory(device).set_outlet_name(1, "server-A")
    assert safe_error(caught.value) == f"Device refused the name (code {code})"
    assert methods == ["getOutlets", "getSettings", "getSettings", "setSettings"]


@pytest.mark.parametrize("desired", [
    "\n", "\x00", "server\nname", "server\rname", "\tserver", "server\x7f",
    "<script>", "a'b", 'a"b', "a\\b", "a>b", "a&b", "a`b", "\u00e9", "\u05d0",
    "x" * (NAME_MAX + 1),
])
async def test_unsafe_names_are_refused_before_any_request(desired):
    driver = RaritanPduDriver("pdu.example.invalid", "test-user", "test-password")
    driver._rpc = AsyncMock()
    driver._client_ctx = AsyncMock(side_effect=AssertionError("Unexpected device contact"))
    with pytest.raises(RaritanPduError) as caught:
        await driver.set_outlet_name(1, desired)
    assert safe_error(caught.value) == CHARACTER_ERROR
    driver._rpc.assert_not_awaited()
    driver._client_ctx.assert_not_awaited()


@pytest.mark.parametrize("current,desired", [("server-A", "server-A"), ("server-A", "  server-A  "), ("", "")])
async def test_matching_outlet_name_never_writes_settings(pdu_factory, current, desired):
    methods = []

    def device(request):
        method = json.loads(request.content)["method"]
        methods.append(method)
        if method == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        assert method == "getSettings"
        return _result(_settings(current, onDelay=7))

    assert await pdu_factory(device).set_outlet_name(1, desired) == current
    assert methods == ["getOutlets", "getSettings"]


@pytest.mark.parametrize("change", ["cycleDelay", "value", "type", "added", "removed", "nested", "nested-added", "nested-removed"])
async def test_name_write_detects_every_non_name_settings_change(pdu_factory, change):
    original = _settings(onDelay=1, loadShedding={"enabled": False, "priority": 3})
    changed = _changed_settings(original, change)
    changed["name"] = "server-B"
    methods = []

    def device(request):
        payload = json.loads(request.content)
        method = payload["method"]
        methods.append(method)
        if method == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        if method == "getSettings":
            return _result(original if methods.count("getSettings") <= 2 else changed)
        assert method == "setSettings"
        assert payload["params"] == {"settings": {**original, "name": "server-B"}}
        return _result(0)

    with pytest.raises(RaritanPduError) as caught:
        await pdu_factory(device).set_outlet_name(1, "server-B")
    assert safe_error(caught.value) == SETTINGS_CHANGED
    assert methods == ["getOutlets", "getSettings", "getSettings", "setSettings", "getSettings"]


async def test_name_writes_read_fresh_settings_for_each_port_and_each_write(pdu_factory):
    settings = {OUTLET_RIDS[0]: _settings("old-1", onDelay=1),
                OUTLET_RIDS[1]: _settings("old-2", onDelay=2)}
    operations = []

    def device(request):
        payload = json.loads(request.content)
        method = payload["method"]
        rid = request.url.path
        if method == "getOutlets":
            return _result(_outlets())
        operations.append((rid, method))
        if method == "getSettings":
            return _result(copy.deepcopy(settings[rid]))
        assert method == "setSettings"
        written = payload["params"]["settings"]
        assert {key: value for key, value in written.items() if key != "name"} == {
            key: value for key, value in settings[rid].items() if key != "name"}
        settings[rid] = copy.deepcopy(written)
        return _result(0)

    driver = pdu_factory(device)
    assert await driver.set_outlet_name(1, "new-1") == "new-1"
    settings[OUTLET_RIDS[1]]["onDelay"] = 20
    assert await driver.set_outlet_name(2, "new-2") == "new-2"
    settings[OUTLET_RIDS[0]]["onDelay"] = 10
    assert await driver.set_outlet_name(1, "newer-1") == "newer-1"
    assert operations == [(rid, method) for rid in (OUTLET_RIDS[0], OUTLET_RIDS[1], OUTLET_RIDS[0])
                          for method in ("getSettings", "getSettings", "setSettings", "getSettings")]


async def test_pdu_name_support_requires_known_typed_outlets(pdu_factory):
    calls = []

    def device(request):
        method = json.loads(request.content)["method"]
        calls.append((request.url.path, method))
        if method == "getOutlets":
            return _result(_outlets())
        assert method == "getSettings"
        return _result(_settings())

    driver = pdu_factory(device)
    assert await driver.name_support() == (True, "")
    assert await driver.name_support() == (True, "")
    assert calls == [(path, method) for _ in range(2) for path, method in [
        (PDU_PATH, "getOutlets"), (OUTLET_RIDS[0], "getSettings"), (OUTLET_RIDS[1], "getSettings")]]


async def test_name_support_revalidates_settings_for_every_outlet(pdu_factory):
    settings = {rid: _settings() for rid in OUTLET_RIDS}
    calls = []

    def device(request):
        method = json.loads(request.content)["method"]
        calls.append((request.url.path, method))
        if method == "getOutlets":
            return _result(_outlets())
        assert method == "getSettings"
        return _result(settings[request.url.path])

    driver = pdu_factory(device)
    assert await driver.name_support() == (True, "")
    settings[OUTLET_RIDS[1]]["startupState"] = True
    assert await driver.name_support() == (False, SETTINGS_ERROR)
    assert calls == [(path, method) for _ in range(2) for path, method in [
        (PDU_PATH, "getOutlets"), (OUTLET_RIDS[0], "getSettings"), (OUTLET_RIDS[1], "getSettings")]]


@pytest.mark.parametrize("outlet", [
    {"rid": OUTLET_RIDS[0]},
    {"rid": OUTLET_RIDS[0], "type": None},
    {"rid": OUTLET_RIDS[0], "type": "pdumodel.Outlet:2.0.0"},
    {"rid": OUTLET_RIDS[0], "type": "pdumodel.Outlet:99.0.0"},
    {"rid": OUTLET_RIDS[0], "type": "pdumodel.Inlet:3.0.3"},
    {"rid": OUTLET_RIDS[0], "type": PRIVATE_TEXT},
    {"rid": "/outlet.0@other-host.invalid", "type": "unknown"},
])
async def test_unknown_outlet_types_are_unsupported_without_settings_or_writes(pdu_factory, outlet):
    methods = []

    def device(request):
        method = json.loads(request.content)["method"]
        methods.append(method)
        assert method == "getOutlets"
        return _result([outlet])

    driver = pdu_factory(device)
    supported, reason = await driver.name_support()
    assert supported is False
    assert isinstance(reason, str) and reason and PRIVATE_TEXT not in reason
    with pytest.raises(RaritanPduError) as caught:
        await driver.set_outlet_name(1, "server-A")
    assert PRIVATE_TEXT not in safe_error(caught.value)
    assert methods and set(methods) == {"getOutlets"}


@pytest.mark.parametrize("rid", [
    "/outlet.0@other-host.invalid", "/outlet.0\r", "/outlet.0\n", "/outlet.0?query=1",
    "/outlet.0#fragment", "/outlet 0", "https://other-host.invalid/outlet.0",
])
async def test_invalid_outlet_rids_never_receive_requests(pdu_factory, rid):
    paths = []

    def device(request):
        paths.append(request.url.path)
        assert request.url.path == PDU_PATH
        assert json.loads(request.content)["method"] == "getOutlets"
        return _result([{"rid": rid, "type": OUTLET_TYPE}])

    driver = pdu_factory(device)
    supported, reason = await driver.name_support()
    assert supported is False and reason
    with pytest.raises(RaritanPduError):
        await driver.set_outlet_name(1, "server-A")
    assert paths and set(paths) == {PDU_PATH}


async def test_name_write_never_follows_307_redirect_with_redirecting_client(pdu_factory):
    requests = []

    def device(request):
        payload = json.loads(request.content)
        requests.append((request.url.host, request.url.path, payload["method"]))
        assert request.url.host == "pdu.example.invalid"
        if payload["method"] == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        if payload["method"] == "getSettings":
            return _result(_settings(onDelay=7))
        assert payload["method"] == "setSettings"
        return httpx.Response(307, headers={"Location": "https://other-host.invalid/redirected"})

    with pytest.raises(RaritanPduError) as caught:
        await pdu_factory(device).set_outlet_name(1, "server-B")
    assert safe_error(caught.value) == "Device API responded with HTTP 307"
    assert requests == [("pdu.example.invalid", PDU_PATH, "getOutlets"),
                        ("pdu.example.invalid", OUTLET_RIDS[0], "getSettings"),
                        ("pdu.example.invalid", OUTLET_RIDS[0], "getSettings"),
                        ("pdu.example.invalid", OUTLET_RIDS[0], "setSettings")]


@pytest.mark.parametrize("result", [None, False, True, "0", PRIVATE_TEXT, {}, []])
async def test_set_outlet_name_requires_confirmed_success_result(pdu_factory, result):
    methods = []

    def device(request):
        payload = json.loads(request.content)
        methods.append(payload["method"])
        if payload["method"] == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        if payload["method"] == "getSettings":
            return _result(_settings())
        assert payload["method"] == "setSettings"
        return _result(result)

    with pytest.raises(RaritanPduError) as caught:
        await pdu_factory(device).set_outlet_name(1, "server-B")
    assert PRIVATE_TEXT not in safe_error(caught.value)
    assert methods == ["getOutlets", "getSettings", "getSettings", "setSettings"]


async def test_set_outlet_name_rejects_malformed_readback(pdu_factory):
    methods = []

    def device(request):
        payload = json.loads(request.content)
        methods.append(payload["method"])
        if payload["method"] == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        if payload["method"] == "getSettings":
            return _result(_settings() if methods.count("getSettings") <= 2 else {})
        assert payload["method"] == "setSettings"
        return _result(0)

    with pytest.raises(RaritanPduError):
        await pdu_factory(device).set_outlet_name(1, "server-B")
    assert methods == ["getOutlets", "getSettings", "getSettings", "setSettings", "getSettings"]


@pytest.mark.parametrize("failure,expected", [
    ("http", "Device API responded with HTTP 403"),
    ("rpc", "RPC error 17"),
    ("connection", "Device API connection error"),
])
async def test_name_write_failures_do_not_expose_device_or_exception_text(pdu_factory, failure, expected):
    methods = []

    def device(request):
        payload = json.loads(request.content)
        methods.append(payload["method"])
        if payload["method"] == "getOutlets":
            return _result(_outlets(OUTLET_RIDS[:1]))
        if payload["method"] == "getSettings":
            return _result(_settings())
        assert payload["method"] == "setSettings"
        if failure == "http":
            return httpx.Response(403, text=PRIVATE_TEXT)
        if failure == "rpc":
            return httpx.Response(200, json={"error": {"code": 17, "message": PRIVATE_TEXT}})
        raise httpx.ConnectError(PRIVATE_TEXT, request=request)

    with pytest.raises(RaritanPduError) as caught:
        await pdu_factory(device).set_outlet_name(1, "server-B")
    assert safe_error(caught.value) == expected
    assert methods == ["getOutlets", "getSettings", "getSettings", "setSettings"]


@pytest.mark.parametrize("model", ["KX III", "KX IV", "LX II", "unknown"])
async def test_kvm_names_remain_unsupported_without_device_contact(model):
    driver = RaritanKvmDriver("kvm.example.invalid", "test-user", "test-password", model=model)
    driver._client_ctx = AsyncMock(side_effect=AssertionError("Unexpected device contact"))
    driver.get_ports = AsyncMock(side_effect=AssertionError("Unexpected port read"))
    assert await driver.name_support() == (False, KVM_UNSUPPORTED)
    with pytest.raises(RaritanKvmError) as caught:
        await driver.set_port_name(1, "server-A")
    assert str(caught.value) == KVM_UNSUPPORTED
    driver._client_ctx.assert_not_awaited()
    driver.get_ports.assert_not_awaited()


@pytest.mark.parametrize("container", ["array", "targets", "list"])
async def test_kvm_names_require_real_rest_names_and_explicit_port_numbers(kvm_factory, container):
    rows = [
        {"portNumber": 7, "name": "  server-A  "},
        {"portNumber": "2", "name": ""},
        {"portNumber": "09", "name": "server-9"},
        {"portNumber": 12, "name": "Port rack-A"},
        {"number": 13, "name": "number-alias"},
        {"name": "inferred-row-number"},
        {"portNumber": 14},
        {"portNumber": 15, "name": None},
        {"portNumber": 16, "name": {"private": PRIVATE_TEXT}},
        {"portNumber": 17, "label": "label-alias"},
        {"portNumber": 18, "targetName": "target-alias"},
        {"portNumber": 19, "name": "Port 19"},
        {"portNumber": 20, "name": "  Port 20  "},
        {"portNumber": True, "name": "boolean-number"},
        {"portNumber": 1.0, "name": "float-number"},
        {"portNumber": 0, "name": "zero-number"},
        {"portNumber": -1, "name": "negative-number"},
        {"portNumber": "\u0661", "name": "unicode-digit-number"},
        None, PRIVATE_TEXT,
    ]
    paths = []

    def device(request):
        paths.append(request.url.path)
        assert request.method == "GET" and request.url.path == "/api/v1/targets"
        return httpx.Response(200, json=rows if container == "array" else {container: rows})

    driver = kvm_factory(device)
    driver.get_ports = AsyncMock(side_effect=AssertionError("Legacy port discovery is not name evidence"))
    assert await driver.get_port_names() == {7: "  server-A  ", 2: "", 9: "server-9", 12: "Port rack-A"}
    assert paths == ["/api/v1/targets"]
    driver.get_ports.assert_not_awaited()


async def test_kvm_names_never_use_sidebar_or_static_fallback(kvm_factory):
    paths = []

    def device(request):
        paths.append(request.url.path)
        assert request.method == "GET" and request.url.path == "/api/v1/targets"
        return httpx.Response(404, text=PRIVATE_TEXT)

    driver = kvm_factory(device)
    driver.get_ports = AsyncMock(return_value=[{"number": 1, "label": "Port 1"}])
    assert await driver.get_port_names() == {}
    assert paths == ["/api/v1/targets"]
    driver.get_ports.assert_not_awaited()


@pytest.mark.parametrize("status", [401, 403])
async def test_kvm_names_remember_authentication_failure_without_retry(kvm_factory, status):
    paths = []

    def device(request):
        paths.append(request.url.path)
        assert request.method == "GET" and request.url.path == "/api/v1/targets"
        return httpx.Response(status, text=PRIVATE_TEXT)

    driver = kvm_factory(device)
    assert await driver.get_port_names() == {}
    assert driver.auth_error == AUTH_FAILED
    assert await driver.get_port_names() == {}
    assert paths == ["/api/v1/targets"]


async def test_kvm_names_do_not_contact_device_with_prior_authentication_error():
    driver = RaritanKvmDriver("kvm.example.invalid", "test-user", "test-password")
    driver.auth_error = AUTH_FAILED
    driver._client_ctx = AsyncMock(side_effect=AssertionError("Unexpected device contact"))
    assert await driver.get_port_names() == {}
    driver._client_ctx.assert_not_awaited()


@pytest.mark.parametrize("model", ["LX II", None, 12, {}, []])
async def test_lx_or_invalid_model_kvm_names_stay_unknown_without_static_discovery(model):
    driver = RaritanKvmDriver("kvm.example.invalid", "test-user", "test-password", model=model)
    driver._client_ctx = AsyncMock(side_effect=AssertionError("Unexpected device contact"))
    driver.get_ports = AsyncMock(return_value=[{"number": 1, "label": "Port 1"}])
    assert await driver.get_port_names() == {}
    driver._client_ctx.assert_not_awaited()
    driver.get_ports.assert_not_awaited()


@pytest.mark.parametrize("data", [None, {}, {"targets": None}, {"targets": {}}, {"list": PRIVATE_TEXT}, PRIVATE_TEXT])
async def test_malformed_kvm_rest_names_stay_unknown(kvm_factory, data):
    paths = []

    def device(request):
        paths.append(request.url.path)
        assert request.method == "GET" and request.url.path == "/api/v1/targets"
        return httpx.Response(200, json=data)

    assert await kvm_factory(device).get_port_names() == {}
    assert paths == ["/api/v1/targets"]
