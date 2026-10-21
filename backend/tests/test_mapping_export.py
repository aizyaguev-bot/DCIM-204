"""Connection exports use saved inventory, caches and the Locations view's rack layout, never live hardware."""
import csv
import io
import json
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event

from app import accounts, engineers, inventory_store
from app.database import get_db
from app.models import AssetOwner, Device, Engineer, PingTarget
from app.routers import devices, kvms, mapping_export, pdus
from app.schemas import KvmPort, KvmStatus, OutletState, PduStatus


PATHS = ("/api/devices/connections", "/api/devices/connections.csv")
HEADERS = ["Server", "Rack", "U slot", "Server IP", "Owner", "Ping", "PDU outlets", "KVM ports"]


@pytest.fixture
async def export_client(db_session, monkeypatch, tmp_path):
    # Rack layout files and the equipment list are read from a private folder, never the real backend folder.
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    settings = SimpleNamespace(accounts_enabled=True)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(engineers, "legacy_owners", lambda: {})

    async def identity(connection):
        role = connection.headers.get("x-test-role")
        if role is None:
            return None
        return {"user": {"role": role, "must_change_password": False}, "csrf_token": "unused"}

    monkeypatch.setattr(accounts, "identity", identity)

    def no_hardware(*args, **kwargs):
        pytest.fail("A read-only connection export attempted to contact a device")

    for module, driver in ((pdus, "RaritanPduDriver"), (kvms, "RaritanKvmDriver")):
        for name in ("_fetch_status", "_refresh_background", "get_creds", driver):
            monkeypatch.setattr(module, name, no_hardware)

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
    return Device(id=device_id, name=kwargs.pop("name", device_id), kind=kind,
                  ip=kwargs.pop("ip", "192.0.2.10"), labels_json=json.dumps(labels),
                  username_enc="synthetic-user-ciphertext", password_enc="synthetic-password-ciphertext",
                  **kwargs)


def csv_rows(response):
    assert response.content.startswith(b"\xef\xbb\xbf")
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("role,expected", [("Viewer", 403), ("Operator", 200), ("Admin", 200)])
async def test_both_exports_enforce_operator_role(export_client, path, role, expected):
    response = await export_client.get(path, headers={"X-Test-Role": role})
    assert response.status_code == expected


async def test_both_exports_require_a_session(export_client):
    export_client.headers.pop("X-Test-Role")
    for path in PATHS:
        assert (await export_client.get(path)).status_code == 401


def test_connections_role_rule_matches_only_the_two_export_paths():
    for path in PATHS:
        assert accounts.required_role(path, "GET") == "Operator"
    for path in ("/api/devices/connections-extra", "/api/devices/connections.csv.bak",
                 "/api/devices/connections/child", "/api/devices/not-connections"):
        assert accounts.required_role(path, "GET") == "Viewer"


async def test_empty_export_has_timestamp_headers_and_download_name(export_client):
    before = datetime.now(timezone.utc)
    response = await export_client.get(PATHS[0])
    assert response.status_code == 200
    result = response.json()
    assert result["servers"] == []
    generated = datetime.fromisoformat(result["generated_at"].replace("Z", "+00:00"))
    assert before <= generated <= datetime.now(timezone.utc)
    assert generated.utcoffset().total_seconds() == 0
    assert response.headers["cache-control"] == "no-store"

    response = await export_client.get(PATHS[1])
    assert response.status_code == 200
    assert csv_rows(response) == [HEADERS]
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["cache-control"] == "no-store"
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert f"lab-connections-{datetime.now(timezone.utc).date().isoformat()}.csv" in disposition


async def test_dual_feeds_group_with_kvm_ping_and_directory_owner(export_client, db_session):
    db_session.add_all([
        device("pdu-b", "pdu", {"13": "opt2 (PSU B)"}, name="PDU-10", rack="PDU rack B", ip="192.0.2.12"),
        device("pdu-a", "pdu", {"2": "OPT2 (PSU A)", "5": "198.51.100.8"},
               name="PDU-2", rack="PDU rack A", ip="192.0.2.11"),
        device("kvm", "kvm", {"12": "opt2", "3": "standalone"}, name="KVM-2", ip="192.0.2.13"),
        device("ignored", "other", {"1": "not-a-pdu-or-kvm"}),
        PingTarget(id="target", source_key="server:opt2", name="Monitor display override",
                   host="198.51.100.2", rack="Server rack", status="up"),
        PingTarget(id="unconnected", source_key="server:unconnected", name="Unconnected server",
                   host="198.51.100.9", rack="Unused rack", status="down"),
        PingTarget(id="wrong-source", source_key="device:kvm", name="standalone",
                   host="198.51.100.10", rack="Wrong source rack", status="up"),
        Engineer(id="owner", name="Engineer One", name_key="engineer one"),
        AssetOwner(asset_key="opt2", engineer_id="owner"),
        AssetOwner(asset_key="standalone", engineer_id=None, legacy_name="Legacy owner"),
    ])
    await db_session.commit()
    pdus._cache["pdu-a"] = (-10**12, PduStatus(device_id="pdu-a", reachable=True, outlets=[
        OutletState(number=2, label="stale label", state="on"),
    ]))

    response = await export_client.get(PATHS[0])
    assert response.status_code == 200
    result = response.json()
    servers = {server["key"]: server for server in result["servers"]}
    # A server known only from its ping monitor (no PDU/KVM port) is listed too, as on the Locations page.
    assert set(servers) == {"opt2", "standalone", "198.51.100.8", "unconnected"}
    server = servers["opt2"]
    assert server["name"].casefold() == "opt2"
    # The rack is where the Locations page shows the server (no layout files: its first PDU's rack), not the
    # monitor's own rack field.
    assert {key: server[key] for key in ("key", "server_ip", "rack", "slot", "owner", "ping_status")} == {
        "key": "opt2", "server_ip": "198.51.100.2", "rack": "PDU rack A", "slot": None,
        "owner": "Engineer One", "ping_status": "up",
    }
    assert server["pdu"] == [
        {"device_id": "pdu-a", "device_name": "PDU-2", "device_ip": "192.0.2.11", "rack": "PDU rack A",
         "port": 2, "label": "OPT2 (PSU A)", "state": "on"},
        {"device_id": "pdu-b", "device_name": "PDU-10", "device_ip": "192.0.2.12", "rack": "PDU rack B",
         "port": 13, "label": "opt2 (PSU B)", "state": "unknown"},
    ]
    assert server["kvm"] == [
        {"device_id": "kvm", "device_name": "KVM-2", "device_ip": "192.0.2.13", "port": 12, "label": "opt2"},
    ]
    assert servers["standalone"]["pdu"] == []
    assert servers["standalone"]["owner"] == "Legacy owner"
    for key, rack in (("standalone", ""), ("198.51.100.8", "PDU rack A")):
        assert (servers[key]["server_ip"], servers[key]["rack"], servers[key]["ping_status"]) == ("", rack, "unknown")
    assert {key: servers["unconnected"][key] for key in ("server_ip", "rack", "slot", "ping_status", "pdu", "kvm")} == {
        "server_ip": "198.51.100.9", "rack": "", "slot": None, "ping_status": "down", "pdu": [], "kvm": [],
    }

    csv_response = await export_client.get(PATHS[1])
    rows = csv_rows(csv_response)
    assert rows[0] == HEADERS
    assert len(rows) == 5
    row = next(row for row in rows[1:] if row[0].casefold() == "opt2")
    assert row == [server["name"], "PDU rack A", "", "198.51.100.2", "Engineer One", "up",
                   "PDU-2 (192.0.2.11) #2; PDU-10 (192.0.2.12) #13", "KVM-2 (192.0.2.13) #12"]
    assert next(row for row in rows[1:] if row[0] == "unconnected") == [
        "unconnected", "", "", "198.51.100.9", "", "down", "", ""]
    for text in (response.text, csv_response.text):
        assert "synthetic-user-ciphertext" not in text
        assert "synthetic-password-ciphertext" not in text
        assert "username_enc" not in text and "password_enc" not in text


async def test_natural_sort_compares_full_server_names(export_client, db_session):
    labels = {str(index): name for index, name in enumerate(
        ("optn10", "opt10", "server10", "optn2", "opt2", "server2", "optn1", "opt1"), 1)}
    db_session.add(device("pdu", "pdu", labels))
    await db_session.commit()
    response = await export_client.get(PATHS[0])
    assert [server["name"] for server in response.json()["servers"]] == [
        "opt1", "opt2", "opt10", "optn1", "optn2", "optn10", "server2", "server10",
    ]


async def test_saved_labels_override_old_caches_without_writes_or_refresh(export_client, db_session):
    db_session.add_all([
        device("pdu", "pdu", {"1": "OPT5 (saved)", "2": "", "9": "saved-only", "11": "Outlet 11"}),
        device("kvm", "kvm", {"1": "OPT5", "2": "", "7": "Port 7"}),
    ])
    await db_session.commit()
    pdus._cache["pdu"] = (-10**12, PduStatus(device_id="pdu", reachable=False, outlets=[
        OutletState(number=1, label="wrong-pdu-name", state="off"),
        OutletState(number=2, label="blanked-pdu-name", state="on"),
        OutletState(number=3, label="cache-only", state="on"),
        OutletState(number=4, label="Outlet 4", state="on"),
    ]))
    kvms._cache["kvm"] = (-10**12, KvmStatus(device_id="kvm", reachable=False, ports=[
        KvmPort(number=1, label="wrong-kvm-name", status="active"),
        KvmPort(number=2, label="blanked-kvm-name", status="active"),
        KvmPort(number=3, label="cache-only", status="idle"),
        KvmPort(number=4, label="Port 4", status="empty"),
    ]))
    cache_before = deepcopy((pdus._cache, kvms._cache))
    statements = []

    def record_query(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    engine = db_session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", record_query)
    try:
        response = await export_client.get(PATHS[0])
        csv_response = await export_client.get(PATHS[1])
    finally:
        event.remove(engine, "before_cursor_execute", record_query)
    assert response.status_code == csv_response.status_code == 200
    assert statements and all(statement.lstrip().upper().startswith("SELECT") for statement in statements)
    assert (pdus._cache, kvms._cache) == cache_before
    assert not pdus._refreshing and not kvms._refreshing
    servers = {server["key"]: server for server in response.json()["servers"]}
    assert set(servers) == {"opt5", "cache-only", "saved-only"}
    assert servers["opt5"]["pdu"][0]["label"] == "OPT5 (saved)"
    assert servers["opt5"]["pdu"][0]["state"] == "off"
    assert servers["opt5"]["kvm"][0]["label"] == "OPT5"
    assert servers["saved-only"]["pdu"][0]["state"] == "unknown"
    assert servers["cache-only"]["pdu"][0]["port"] == 3
    assert servers["cache-only"]["pdu"][0]["state"] == "on"
    assert servers["cache-only"]["kvm"][0]["port"] == 3


async def test_odd_saved_port_keys_remain_exportable(export_client, db_session):
    db_session.add(device("pdu", "pdu", {"aux": "manual-port", "10": "numbered-port", "2": None}))
    await db_session.commit()
    response = await export_client.get(PATHS[0])
    assert response.status_code == 200
    servers = {server["key"]: server for server in response.json()["servers"]}
    assert servers["manual-port"]["pdu"][0]["port"] == "aux"
    assert servers["numbered-port"]["pdu"][0]["port"] == 10


@pytest.mark.parametrize("trigger", ["=", "+", "-", "@", "\t", "\r"])
async def test_csv_neutralizes_formula_prefixes_in_every_column(export_client, monkeypatch, trigger):
    value = trigger + 'payload,"\u05e9\u05dc\u05d5\u05dd"\nnext line'

    async def summary(db):
        return {"generated_at": "2026-10-20T12:34:56+00:00", "servers": [{
            "key": "test", "name": value, "server_ip": value, "rack": value, "slot": value, "owner": value,
            "ping_status": value,
            "pdu": [{"device_name": value, "device_ip": "192.0.2.11", "port": 13}],
            "kvm": [{"device_name": value, "device_ip": "192.0.2.12", "port": 12}],
        }]}

    monkeypatch.setattr(mapping_export, "connection_summary", summary)
    response = await export_client.get(PATHS[1])
    assert response.status_code == 200
    rows = csv_rows(response)
    assert rows == [HEADERS, ["'" + value] * 6 + [
        "'" + value + " (192.0.2.11) #13", "'" + value + " (192.0.2.12) #12",
    ]]
    assert "lab-connections-2026-10-20.csv" in response.headers["content-disposition"]


async def test_csv_preserves_quotes_unicode_and_empty_connections(export_client, db_session):
    name = 'Server, "\u05e9\u05dc\u05d5\u05dd"'
    owner = 'Engineer, "One"\nSecond line'
    db_session.add_all([
        device("pdu", "pdu", {"3": name}, name='PDU, "East"'),
        AssetOwner(asset_key=name.casefold(), engineer_id=None, legacy_name=owner),
    ])
    await db_session.commit()
    response = await export_client.get(PATHS[1])
    assert response.status_code == 200
    assert csv_rows(response) == [HEADERS, [
        name, "", "", "", owner, "unknown", 'PDU, "East" (192.0.2.10) #3', "",
    ]]


async def test_rack_and_u_slot_match_locations_and_servers_without_ports_are_listed(export_client, db_session, tmp_path):
    (tmp_path / "rack_slots.json").write_text(json.dumps(
        {"Rack-01": {"optn44": 3, "optn45 (psu1)": 7}, "Rack-07": {"opt99": 12}}))
    (tmp_path / "rack_overrides.json").write_text(json.dumps({"optn45 (psu1)": "Rack-01"}))
    db_session.add_all([
        device("pdu", "pdu", {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "Outlet 3"},
               name="PDU-A", rack="Rack-02", ip="192.0.2.11", port_count=8),
        device("kvm", "kvm", {"4": "optn45"}, name="KVM-A", rack="Rack-01", ip="192.0.2.12", port_count=8),
        PingTarget(id="t46", source_key="server:optn46", name="OPTN46", host="198.51.100.46", status="up"),
    ])
    await db_session.commit()

    response = await export_client.get(PATHS[0])
    assert response.status_code == 200
    servers = {server["key"]: server for server in response.json()["servers"]}
    # opt99 is only in rack_slots.json and optn46 only has a ping monitor: both are exported with no ports.
    assert set(servers) == {"optn44", "optn45", "opt99", "optn46"}
    assert (servers["optn45"]["rack"], servers["optn45"]["slot"]) == ("Rack-01", 7)   # rack override + its U
    assert (servers["optn44"]["rack"], servers["optn44"]["slot"]) == ("Rack-02", None)  # first PDU's rack
    assert {key: servers["opt99"][key] for key in ("name", "rack", "slot", "pdu", "kvm")} == {
        "name": "opt99", "rack": "Rack-07", "slot": 12, "pdu": [], "kvm": []}
    assert {key: servers["optn46"][key] for key in ("name", "rack", "slot", "server_ip", "ping_status", "pdu", "kvm")} == {
        "name": "OPTN46", "rack": "", "slot": None, "server_ip": "198.51.100.46", "ping_status": "up",
        "pdu": [], "kvm": []}
    # Same servers, names, racks and slots as GET /api/devices/locations (the export reuses that code).
    located = {place["key"]: place for place in (await devices.server_locations(db_session))["servers"]}
    assert set(located) == set(servers)
    for key, server in servers.items():
        assert (server["name"], server["rack"], server["slot"]) == (
            located[key]["name"], located[key]["rack"] or "", located[key]["slot"])

    rows = csv_rows(await export_client.get(PATHS[1]))
    assert rows[0] == HEADERS
    by_name = {row[0]: row for row in rows[1:]}
    assert set(by_name) == {"OPTN44", "OPTN45", "opt99", "OPTN46"}
    assert by_name["opt99"] == ["opt99", "Rack-07", "12", "", "", "unknown", "", ""]
    assert by_name["OPTN46"] == ["OPTN46", "", "", "198.51.100.46", "", "up", "", ""]
    assert by_name["OPTN45"] == ["OPTN45", "Rack-01", "7", "", "", "unknown", "PDU-A (192.0.2.11) #2",
                                 "KVM-A (192.0.2.12) #4"]
    assert by_name["OPTN44"][:3] == ["OPTN44", "Rack-02", ""]
