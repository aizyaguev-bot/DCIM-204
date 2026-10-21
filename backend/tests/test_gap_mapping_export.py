"""Gap tests for the connections export (app/routers/mapping_export.py).

test_mapping_export.py already covers the role matrix on a hand-built app, the formula prefixes on a monkeypatched
summary, quotes/Hebrew round trips and Locations parity. These tests add what it leaves open: formula payloads that
arrive through real saved inventory (labels, device names, racks, engineer names), values that must NOT be altered,
the raw UTF-8/BOM/CRLF byte layout, Hebrew natural ordering, empty and unreadable inventory, path variants of the
role rule, temporary-password accounts, and the role rule on the deployed app object (app.main).
No test contacts a device, the VM or the live site: hardware entry points fail the test if called.
"""
import csv
import io
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app import accounts, engineers, inventory_store
from app.database import get_db
from app.models import AssetOwner, Device, Engineer, PingTarget
from app.routers import devices, kvms, mapping_export, pdus
from app.schemas import KvmPort, KvmStatus, OutletState, PduStatus

JSON_PATH, CSV_PATH = "/api/devices/connections", "/api/devices/connections.csv"
PATHS = (JSON_PATH, CSV_PATH)
HEADERS = ["Server", "Rack", "U slot", "Server IP", "Owner", "Ping", "PDU outlets", "KVM ports"]
BOM = b"\xef\xbb\xbf"
HEADER_LINE = b"Server,Rack,U slot,Server IP,Owner,Ping,PDU outlets,KVM ports\r\n"


def _isolate(monkeypatch, tmp_path):
    """Private layout/equipment files, accounts on, a header-driven test identity and no hardware access."""
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    settings = SimpleNamespace(accounts_enabled=True)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(engineers, "legacy_owners", lambda: {})

    async def identity(connection):
        role = connection.headers.get("x-test-role")
        if role is None:
            return None
        must_change = connection.headers.get("x-test-must-change") == "1"
        return {"user": {"role": role, "must_change_password": must_change}, "csrf_token": "unused"}

    monkeypatch.setattr(accounts, "identity", identity)

    def no_hardware(*args, **kwargs):
        pytest.fail("A read-only connection export attempted to contact a device")

    for module, driver in ((pdus, "RaritanPduDriver"), (kvms, "RaritanKvmDriver")):
        for name in ("_fetch_status", "_refresh_background", "get_creds", driver):
            monkeypatch.setattr(module, name, no_hardware)
    return settings


@pytest.fixture
async def export_client(db_session, monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(mapping_export.router)

    async def dependency():
        yield db_session

    app.dependency_overrides[get_db] = dependency
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test",
                           headers={"X-Test-Role": "Operator"}) as client:
        yield client


def device(device_id, kind, labels, **kwargs):
    labels_json = labels if isinstance(labels, str) else json.dumps(labels)
    return Device(id=device_id, name=kwargs.pop("name", device_id), kind=kind,
                  ip=kwargs.pop("ip", "192.0.2.10"), labels_json=labels_json,
                  username_enc="synthetic-user-ciphertext", password_enc="synthetic-password-ciphertext",
                  **kwargs)


def csv_rows(response):
    assert response.content.startswith(BOM)
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


# --- Formula injection -------------------------------------------------------------------------------------------

async def test_formula_payloads_saved_in_inventory_are_neutralized_in_csv_but_raw_in_json(export_client, db_session):
    """The existing prefix test replaces connection_summary; here the payloads come from real saved records:
    a port label (server name), a PDU rack, PDU/KVM device names and an engineer name."""
    label = '=HYPERLINK("http://example.invalid/x","open")'
    key = label.casefold()
    owner = "=cmd|' /C calc'!A0"
    db_session.add_all([
        device("pdu", "pdu", {"1": label}, name="-PDU-7", rack="@Rack", ip="192.0.2.21"),
        device("kvm", "kvm", {"2": label}, name="+KVM-3", ip="192.0.2.22"),
        Engineer(id="e1", name=owner, name_key=owner.casefold()),
        AssetOwner(asset_key=key, engineer_id="e1"),
        PingTarget(id="t1", source_key="server:" + key, name=label, host="198.51.100.7", status="up"),
    ])
    await db_session.commit()

    rows = csv_rows(await export_client.get(CSV_PATH))
    assert rows == [HEADERS, [
        "'" + label, "'@Rack", "", "198.51.100.7", "'" + owner, "up",
        "'-PDU-7 (192.0.2.21) #1", "'+KVM-3 (192.0.2.22) #2",
    ]]

    # The JSON export is data for the UI, not a spreadsheet: it keeps the saved values unchanged.
    server, = (await export_client.get(JSON_PATH)).json()["servers"]
    assert (server["name"], server["rack"], server["owner"]) == (label, "@Rack", owner)
    assert server["pdu"][0]["device_name"] == "-PDU-7"
    assert server["kvm"][0]["device_name"] == "+KVM-3"


async def test_csv_does_not_alter_safe_values_with_symbols_after_the_first_character(export_client, db_session):
    """Only a leading trigger is neutralized: hyphens, '=', '@' and '+' inside a value, and a value that already
    starts with an apostrophe, are exported exactly as saved (no extra apostrophe)."""
    db_session.add_all([
        device("pdu", "pdu", {"1": "srv-1", "2": "'quoted", "3": "a=b", "4": "x@lab"},
               name="PDU-A+1", rack="Rack-01", ip="192.0.2.31"),
        Engineer(id="e1", name="Dana-Lee O'Neil", name_key="dana-lee o'neil"),
        AssetOwner(asset_key="srv-1", engineer_id="e1"),
    ])
    await db_session.commit()
    rows = csv_rows(await export_client.get(CSV_PATH))
    assert rows[1:] == [
        ["'quoted", "Rack-01", "", "", "", "unknown", "PDU-A+1 (192.0.2.31) #2", ""],
        ["a=b", "Rack-01", "", "", "", "unknown", "PDU-A+1 (192.0.2.31) #3", ""],
        ["srv-1", "Rack-01", "", "", "Dana-Lee O'Neil", "unknown", "PDU-A+1 (192.0.2.31) #1", ""],
        ["x@lab", "Rack-01", "", "", "", "unknown", "PDU-A+1 (192.0.2.31) #4", ""],
    ]


@pytest.mark.parametrize("value,expected", [
    (None, ""),                 # a missing U slot is an empty cell, not "None"
    (0, "0"),                   # falsy numbers are kept
    (12, "12"),
    (-3, "'-3"),                # a negative number starts with "-" and is neutralized like any other value
    ("", ""),
    ("=", "'="),
    ("'=SUM(A1)", "'=SUM(A1)"),  # already text for a spreadsheet: not double-prefixed
    ("\r\n=1+1", "'\r\n=1+1"),
    ("ש=1", "ש=1"),    # Hebrew first letter: no prefix
])
def test_csv_cell_values(value, expected):
    assert mapping_export.csv_cell(value) == expected


# --- Encoding, BOM and line layout --------------------------------------------------------------------------------

async def test_csv_bytes_are_utf8_with_one_bom_crlf_rows_and_lf_inside_quoted_cells(export_client, db_session):
    name, owner = "שרת-בדיקה", "מהנדסת\nראשית"
    db_session.add_all([
        device("pdu", "pdu", {"5": name}, name="PDU-H", ip="192.0.2.41"),
        AssetOwner(asset_key=name.casefold(), engineer_id=None, legacy_name=owner),
    ])
    await db_session.commit()
    response = await export_client.get(CSV_PATH)
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    content = response.content
    # Exactly one BOM, at the very start, so Excel opens Hebrew as UTF-8 (not the Windows-1255 code page).
    assert content.startswith(BOM + HEADER_LINE)
    assert content.count(BOM) == 1
    assert name.encode("utf-8") in content
    # Rows end with CRLF; a line break inside a value stays a bare LF inside its quoted cell.
    assert content.endswith(b"\r\n")
    assert content.count(b"\r\n") == 2
    assert ('"' + owner + '"').encode("utf-8") in content
    assert csv_rows(response) == [HEADERS, [name, "", "", "", owner, "unknown", "PDU-H (192.0.2.41) #5", ""]]


async def test_hebrew_server_names_sort_naturally_after_latin_names(export_client, db_session):
    names = ["שרת10", "שרת2", "שרת1", "opt3"]
    db_session.add(device("pdu", "pdu", {str(index): name for index, name in enumerate(names, 1)}))
    await db_session.commit()
    expected = ["opt3", "שרת1", "שרת2", "שרת10"]
    assert [server["name"] for server in (await export_client.get(JSON_PATH)).json()["servers"]] == expected
    assert [row[0] for row in csv_rows(await export_client.get(CSV_PATH))[1:]] == expected


async def test_ports_of_one_server_on_one_device_are_listed_in_natural_order(export_client, db_session):
    db_session.add(device("pdu", "pdu", {"10": "opt4 (PSU B)", "aux": "OPT4", "9": "opt4 (PSU A)"},
                          name="PDU-N", ip="192.0.2.51"))
    await db_session.commit()
    server, = (await export_client.get(JSON_PATH)).json()["servers"]
    assert [entry["port"] for entry in server["pdu"]] == [9, 10, "aux"]
    row = csv_rows(await export_client.get(CSV_PATH))[1]
    assert row[0] == "opt4"
    assert row[6] == "PDU-N (192.0.2.51) #9; PDU-N (192.0.2.51) #10; PDU-N (192.0.2.51) #aux"


# --- Empty and unreadable inventory -------------------------------------------------------------------------------

async def test_inventory_without_server_names_exports_only_the_header(export_client, db_session):
    db_session.add_all([
        device("pdu", "pdu", {"1": "Outlet 1", "2": "", "3": "   ", "4": None, "5": 7, "6": "OUTLET  6"}),
        device("kvm", "kvm", {"1": "Port 1", "2": "port 2"}),
    ])
    await db_session.commit()
    pdus._cache["pdu"] = (-10**12, PduStatus(device_id="pdu", reachable=True, outlets=[
        OutletState(number=7, label="Outlet 7", state="on")]))
    kvms._cache["kvm"] = (-10**12, KvmStatus(device_id="kvm", reachable=True, ports=[
        KvmPort(number=3, label="", status="empty")]))
    response = await export_client.get(JSON_PATH)
    assert response.status_code == 200 and response.json()["servers"] == []
    response = await export_client.get(CSV_PATH)
    assert response.status_code == 200
    assert response.content == BOM + HEADER_LINE


async def test_unreadable_saved_labels_do_not_break_the_export(export_client, db_session):
    db_session.add_all([
        device("broken", "pdu", "{not json", name="PDU-1"),
        device("listed", "pdu", '["opt90"]', name="PDU-2"),
        device("null", "kvm", "null", name="KVM-1"),
        device("text", "kvm", '"opt91"', name="KVM-2"),
        device("good", "pdu", {"2": "opt3"}, name="PDU-3", ip="192.0.2.61"),
    ])
    await db_session.commit()
    # The PDU whose saved labels are a JSON list still contributes the name its status cache reports.
    pdus._cache["listed"] = (-10**12, PduStatus(device_id="listed", reachable=True, outlets=[
        OutletState(number=1, label="opt4", state="off")]))
    response = await export_client.get(JSON_PATH)
    assert response.status_code == 200
    servers = {server["key"]: server for server in response.json()["servers"]}
    assert set(servers) == {"opt3", "opt4"}
    assert servers["opt4"]["pdu"] == [{"device_id": "listed", "device_name": "PDU-2", "device_ip": "192.0.2.10",
                                       "port": 1, "label": "opt4", "rack": "", "state": "off"}]
    rows = csv_rows(await export_client.get(CSV_PATH))
    assert [row[0] for row in rows[1:]] == ["opt3", "opt4"]


async def test_status_caches_without_a_matching_device_add_no_servers(export_client, db_session):
    db_session.add(device("kvm-1", "kvm", {}, name="KVM-1"))
    await db_session.commit()
    # A cache left behind by a deleted device, and a PDU-shaped cache under a KVM's id, are both ignored.
    pdus._cache["deleted-pdu"] = (-10**12, PduStatus(device_id="deleted-pdu", reachable=True, outlets=[
        OutletState(number=1, label="opt70", state="on")]))
    pdus._cache["kvm-1"] = (-10**12, PduStatus(device_id="kvm-1", reachable=True, outlets=[
        OutletState(number=2, label="opt71", state="on")]))
    kvms._cache["deleted-kvm"] = (-10**12, KvmStatus(device_id="deleted-kvm", reachable=True, ports=[
        KvmPort(number=1, label="opt72", status="active")]))
    assert (await export_client.get(JSON_PATH)).json()["servers"] == []
    assert csv_rows(await export_client.get(CSV_PATH)) == [HEADERS]


# --- Role restriction ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("method,path", [
    ("GET", "/api/devices/connections/"),
    ("GET", "/api/devices/connections.csv/"),
    ("GET", "/api/devices/connections.csv//"),
    ("GET", "/api/devices/connections.csv?download=1"),
    ("GET", "/api/devices/connections?format=csv"),
    ("HEAD", "/api/devices/connections.csv"),
    ("HEAD", "/api/devices/connections"),
])
async def test_viewer_is_refused_on_path_variants_and_head(export_client, db_session, method, path):
    db_session.add(device("pdu", "pdu", {"1": "opt1"}))
    await db_session.commit()
    response = await export_client.request(method, path, headers={"X-Test-Role": "Viewer"})
    assert response.status_code == 403
    assert response.headers["cache-control"] == "no-store"
    assert b"opt1" not in response.content


async def test_operator_query_string_still_gets_the_export(export_client, db_session):
    db_session.add(device("pdu", "pdu", {"1": "opt1"}))
    await db_session.commit()
    response = await export_client.get(CSV_PATH + "?download=1")
    assert response.status_code == 200
    assert csv_rows(response)[1][0] == "opt1"


@pytest.mark.parametrize("role", ["Operator", "Admin"])
async def test_temporary_password_accounts_cannot_export(export_client, db_session, role):
    db_session.add(device("pdu", "pdu", {"1": "opt1"}))
    await db_session.commit()
    for path in PATHS:
        response = await export_client.get(path, headers={"X-Test-Role": role, "X-Test-Must-Change": "1"})
        assert response.status_code == 403
        assert response.json() == {"detail": "Change your temporary password in Account settings first"}
        assert b"opt1" not in response.content


async def test_refused_exports_return_only_the_reason_and_no_inventory(export_client, db_session):
    db_session.add_all([
        device("pdu", "pdu", {"1": "opt1"}, name="PDU-Secret", ip="192.0.2.99"),
        AssetOwner(asset_key="opt1", engineer_id=None, legacy_name="Owner Name"),
    ])
    await db_session.commit()
    for path in PATHS:
        viewer = await export_client.get(path, headers={"X-Test-Role": "Viewer"})
        assert (viewer.status_code, viewer.json()) == (403, {"detail": "Your role does not allow this action"})
        assert viewer.headers["content-type"] == "application/json"
        assert "content-disposition" not in viewer.headers
        role = export_client.headers.pop("X-Test-Role")
        try:
            anonymous = await export_client.get(path)
        finally:
            export_client.headers["X-Test-Role"] = role
        assert "x-test-role" not in anonymous.request.headers
        assert (anonymous.status_code, anonymous.json()) == (401, {"detail": "Sign in to continue"})
        for response in (viewer, anonymous):
            for secret in (b"opt1", b"PDU-Secret", b"192.0.2.99", b"Owner Name"):
                assert secret not in response.content


@pytest.fixture
async def main_app_client(db_session, monkeypatch, tmp_path):
    """The deployed FastAPI object (app.main.app) with its real middleware stack and router order."""
    import app.main as main
    settings = _isolate(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "get_settings", lambda: settings)

    async def dependency():
        yield db_session

    main.app.dependency_overrides[get_db] = dependency
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            yield client
    finally:
        main.app.dependency_overrides.pop(get_db, None)


async def test_deployed_app_enforces_operator_role_on_both_exports(main_app_client, db_session):
    db_session.add(device("pdu", "pdu", {"3": "opt8"}, name="PDU-M", ip="192.0.2.71"))
    await db_session.commit()
    for path in PATHS:
        assert (await main_app_client.get(path)).status_code == 401
        assert (await main_app_client.get(path, headers={"X-Test-Role": "Viewer"})).status_code == 403
    operator = {"X-Test-Role": "Operator"}
    server, = (await main_app_client.get(JSON_PATH, headers=operator)).json()["servers"]
    assert (server["key"], server["pdu"][0]["port"]) == ("opt8", 3)
    response = await main_app_client.get(CSV_PATH, headers=operator)
    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith("attachment; filename=lab-connections-")
    assert csv_rows(response) == [HEADERS, ["opt8", "", "", "", "", "unknown", "PDU-M (192.0.2.71) #3", ""]]


# --- Known bug ----------------------------------------------------------------------------------------------------

@pytest.mark.xfail(strict=True, raises=ValueError, reason=(
    "BUG: mapping_export converts digit runs with plain int() (port keys in connection_summary and every digit "
    "run in natural_key). Python 3.11+ refuses int() of more than 4300 digits, so one saved port key or label "
    "with such a run (PATCH /api/devices/{id}/labels accepts any all-digit key and any label text) makes both "
    "exports fail with a server error, while GET /api/devices/locations still lists the same data "
    "(devices._short_number caps int() at 9 digits for this reason)."))
@pytest.mark.parametrize("labels", [
    {"1" * 4301: "opt1"},           # an all-digit port key
    {"1": "opt" + "1" * 4301},      # a server name with a long digit run
], ids=["port-key", "server-name"])
async def test_huge_digit_runs_in_saved_labels_do_not_break_the_export(export_client, db_session, labels):
    db_session.add_all([device("pdu", "pdu", labels), device("other", "pdu", {"1": "opt2"}, name="PDU-2")])
    await db_session.commit()
    response = await export_client.get(JSON_PATH)
    assert response.status_code == 200
    assert "opt2" in {server["key"] for server in response.json()["servers"]}
    assert (await export_client.get(CSV_PATH)).status_code == 200
