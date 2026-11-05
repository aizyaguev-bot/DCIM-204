"""Serial numbers out (export) and looked-up details back in (by serial number): matched like a scan, applied all
together or not at all, with the inventory revision and the unit's history."""
import csv
import io
import json

import pytest

from app import inventory_store as store
from tests.test_inventory import headers, inventory_client  # noqa: F401  (fixture)

URL = "/api/inventory/serial-details"
UNITS = {
    "Rack-01": [
        {"id": "u-generic", "name": "Unit", "type": "other", "serial_number": "MT2614X00001", "u": 3, "notes": "keep", "custom": {"a": 1}},
        {"id": "u-named", "name": "Core switch left", "type": "switch", "serial_number": "MT2614X00002", "part_number": "OLD-PN", "u": 4},
        {"id": "u-code-name", "name": "MT2614X00003", "type": "other", "serial_number": "MT2614X00003", "u": 5},
        {"id": "u-no-code", "name": "Patch panel", "type": "patchpanel", "u": 6},
    ],
    "Rack-02": [
        {"id": "u-barcode", "name": "000777", "type": "other", "barcode": "000777", "u": 1, "shelf_position": "left"},
        {"id": "u-dup-1", "name": "Dup one", "type": "other", "serial_number": "DUP-1", "u": 2},
        {"id": "u-dup-2", "name": "Dup two", "type": "other", "barcode": "dup-1", "u": 3},
        {"id": "u-cable", "name": "=cmd()", "type": "cable", "serial_number": "-CABLE-9", "u": 0},
    ],
}


@pytest.fixture
async def client(inventory_client):
    store.ITEMS_FILE.write_text(json.dumps(UNITS), encoding="utf-8")
    return inventory_client


def unit(item_id):
    return next(item for items in store.read_items().values() for item in items if item["id"] == item_id)


def by_serial(body):
    return {entry["serial"]: entry for entry in body["results"]}


async def test_export_lists_every_unit_with_a_serial_or_barcode_switches_first(client):
    response = await client.get("/api/inventory/serials")
    assert response.status_code == 200
    assert response.headers["etag"] == store.revision(store.read_items())
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["lookup_as"] == "switch"
    serials = [(row["serial"], row["barcode"]) for row in body["items"]]
    # Switches first; the unit with neither a serial nor a barcode is not listed.
    assert serials[0] == ("MT2614X00002", "")
    assert ("", "000777") in serials and ("MT2614X00001", "") in serials
    assert len(serials) == 7
    row = next(row for row in body["items"] if row["barcode"] == "000777")
    assert row == {"serial": "", "barcode": "000777", "name": "000777", "type": "other", "part_number": "", "model": "",
                   "rack": "Rack-02", "u": 1, "position": "left", "place": "Rack-02 · U1 · left", "lookup_as": "switch"}


async def test_csv_export_has_a_header_and_neutralises_formulas(client):
    response = await client.get("/api/inventory/serials.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "serial-numbers.csv" in response.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(response.text.lstrip("﻿"))))
    assert rows[0] == ["serial", "barcode", "name", "type", "part_number", "model", "rack", "u", "position", "place", "lookup_as"]
    assert rows[1][0] == "MT2614X00002" and rows[1][-1] == "switch"
    cable = next(row for row in rows if row[3] == "cable")
    assert cable[0] == "'-CABLE-9" and cable[2] == "'=cmd()"
    assert len(rows) == 8


async def test_dry_run_reports_without_writing_and_needs_no_if_match(client):
    before = store.ITEMS_FILE.read_bytes()
    response = await client.post(URL, json={"dry_run": True, "items": [
        {"serial": " mt2614x00001 ", "name": "Spectrum SN2700 switch", "part_number": "MSN2700-CS2F", "type": "switch"},
        {"serial": "NOPE-1", "name": "x"},
    ]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dry_run"] is True
    assert body["counts"] == {"updated": 1, "unchanged": 0, "not_found": 1, "ambiguous": 0}
    entry = body["results"][0]
    assert (entry["serial"], entry["status"]) == ("mt2614x00001", "updated")
    assert entry["unit"]["id"] == "u-generic"
    assert entry["changes"] == {"part_number": {"before": "", "after": "MSN2700-CS2F"},
                                "name": {"before": "Unit", "after": "Spectrum SN2700 switch"},
                                "type": {"before": "other", "after": "switch"}}
    assert body["results"][1]["status"] == "not_found"
    assert store.ITEMS_FILE.read_bytes() == before
    assert response.headers["etag"] == store.revision(store.read_items())


async def test_apply_sets_part_number_generic_name_switch_type_and_history(client):
    c = client
    response = await c.post(URL, headers=await headers(c), json={"items": [
        {"serial": "MT2614X00001", "name": "Spectrum SN2700 switch", "part_number": "MSN2700-CS2F", "model": "SN2700", "type": "Switch", "source": "webpe SN analysis"},
        {"serial": "MT2614X00002", "name": "Quantum-2 QM9700", "part_number": "MQM9700-NS2F"},
        {"serial": "MT2614X00003", "name": "Quantum QM8700", "type": "switch"},
    ]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["counts"]["updated"] == 3
    first = unit("u-generic")
    assert (first["name"], first["type"], first["part_number"], first["model"]) == ("Spectrum SN2700 switch", "switch", "MSN2700-CS2F", "SN2700")
    assert (first["notes"], first["custom"], first["u"]) == ("keep", {"a": 1}, 3)
    event = first["tracking_history"][-1]
    assert event["action"] == "details updated"
    assert event["note"].startswith("Details from webpe SN analysis: ")
    assert "Part number" in event["note"] and "Name" in event["note"] and "Type" in event["note"]
    assert event["from"] == event["to"] == {"rack": "Rack-01", "u": 3, "position": ""}
    # A real name is kept (and said so); its different part number is replaced and reported.
    named = unit("u-named")
    assert named["name"] == "Core switch left" and named["part_number"] == "MQM9700-NS2F"
    entry = by_serial(body)["MT2614X00002"]
    assert entry["changes"] == {"part_number": {"before": "OLD-PN", "after": "MQM9700-NS2F"}}
    assert "overwrite" in entry["name_kept"]
    # A name equal to the unit's own serial is not a real name.
    assert unit("u-code-name")["name"] == "Quantum QM8700" and unit("u-code-name")["type"] == "switch"
    assert response.headers["etag"] == store.revision(store.read_items())


async def test_overwrite_replaces_a_real_name_and_a_repeat_is_unchanged(client):
    c = client
    row = {"serial": "MT2614X00002", "name": "Quantum-2 QM9700", "part_number": "MQM9700-NS2F", "model": "QM9700"}
    kept = await c.post(URL, headers=await headers(c), json={"items": [row]})
    assert unit("u-named")["name"] == "Core switch left"
    replaced = await c.post(URL, headers={"If-Match": kept.headers["etag"]}, json={"items": [row], "overwrite": True})
    assert replaced.json()["results"][0]["changes"] == {"name": {"before": "Core switch left", "after": "Quantum-2 QM9700"}}
    assert unit("u-named")["name"] == "Quantum-2 QM9700"
    before = store.ITEMS_FILE.read_bytes()
    again = await c.post(URL, headers={"If-Match": replaced.headers["etag"]}, json={"items": [row], "overwrite": True})
    assert again.json()["results"][0]["status"] == "unchanged"
    assert again.json()["counts"]["unchanged"] == 1
    assert store.ITEMS_FILE.read_bytes() == before


async def test_a_unit_without_serial_is_matched_by_barcode_and_gets_it_as_serial(client):
    c = client
    response = await c.post(URL, headers=await headers(c), json={"items": [{"serial": "000777", "name": "ConnectX-7 NIC", "part_number": "MCX75310AAS-NEAT"}]})
    entry = response.json()["results"][0]
    assert entry["status"] == "updated"
    assert entry["changes"]["serial_number"] == {"before": "", "after": "000777"}
    item = unit("u-barcode")
    assert (item["serial_number"], item["barcode"], item["name"], item["type"]) == ("000777", "000777", "ConnectX-7 NIC", "other")
    assert item["shelf_position"] == "left"


async def test_ambiguous_and_repeated_serials_are_reported_and_not_applied(client):
    c = client
    response = await c.post(URL, headers=await headers(c), json={"items": [
        {"serial": "dup-1", "part_number": "P1"},
        {"serial": "MT2614X00001", "part_number": "P2"},
        {"serial": "mt2614x00001", "part_number": "P3"},
        {"serial": "MT2614X00003", "part_number": "P4"},
    ]})
    assert response.status_code == 200
    body = response.json()
    statuses = [entry["status"] for entry in body["results"]]
    assert statuses == ["ambiguous", "ambiguous", "ambiguous", "updated"]
    assert {u["id"] for u in body["results"][0]["units"]} == {"u-dup-1", "u-dup-2"}
    assert "more than once" in body["results"][1]["detail"]
    assert "part_number" not in unit("u-generic") and "part_number" not in unit("u-dup-1")
    assert unit("u-code-name")["part_number"] == "P4"


async def test_stale_or_missing_revision_writes_nothing(client):
    c = client
    stale = (await c.get("/api/inventory/serials")).headers["etag"]
    await c.post(URL, headers={"If-Match": stale}, json={"items": [{"serial": "MT2614X00003", "part_number": "P4"}]})
    before = store.ITEMS_FILE.read_bytes()
    row = {"items": [{"serial": "MT2614X00001", "part_number": "P9"}]}
    assert (await c.post(URL, headers={"If-Match": stale}, json=row)).status_code == 409
    assert (await c.post(URL, json=row)).status_code == 428
    # A dry run with a stale If-Match is refused too, so the preview never describes another revision.
    assert (await c.post(URL, headers={"If-Match": stale}, json={**row, "dry_run": True})).status_code == 409
    assert store.ITEMS_FILE.read_bytes() == before


async def test_a_refused_row_leaves_every_unit_unchanged(client):
    c = client
    data = store.read_items()
    # Another unit's MAC equals the barcode that would become u-barcode's serial: the whole request is refused.
    data["Rack-01"][0]["mac"] = "00:07:77:00:07:77"
    data["Rack-02"][0]["barcode"] = "000777000777"
    data["Rack-02"][0]["name"] = "Unit"
    store.write_items(data)
    before = store.ITEMS_FILE.read_bytes()
    response = await c.post(URL, headers=await headers(c), json={"items": [
        {"serial": "MT2614X00003", "part_number": "P4"},
        {"serial": "000777000777", "name": "Something"},
    ]})
    assert response.status_code == 409
    assert store.ITEMS_FILE.read_bytes() == before


@pytest.mark.parametrize("payload", [
    {"items": []},
    {"items": [{"serial": "  "}]},
    {"items": [{"serial": "A\tB"}]},
    {"items": [{"serial": "S" * 201}]},
    {"items": [{"serial": "S1", "part_number": "P" * 121}]},
    {"items": [{"serial": "S1", "model": "bad\x07"}]},
    {"items": [{"serial": "S1", "name": "bad\x00name"}]},
    {"items": [{"name": "no serial"}]},
])
async def test_invalid_rows_are_refused(client, payload):
    before = store.ITEMS_FILE.read_bytes()
    response = await client.post(URL, headers=await headers(client), json=payload)
    assert response.status_code == 422
    assert store.ITEMS_FILE.read_bytes() == before


async def test_long_descriptions_are_cut_and_whitespace_is_collapsed(client):
    c = client
    response = await c.post(URL, headers=await headers(c), json={"items": [{"serial": "MT2614X00001", "name": "  NVIDIA \t Spectrum " + "x" * 300}]})
    assert response.status_code == 200
    name = unit("u-generic")["name"]
    assert name.startswith("NVIDIA Spectrum x") and len(name) == 160


async def test_only_switch_types_change_the_type(client):
    c = client
    response = await c.post(URL, headers=await headers(c), json={"items": [
        {"serial": "MT2614X00001", "type": "Cable"},
        {"serial": "MT2614X00003", "type": "Ethernet Switch"},
    ]})
    results = response.json()["results"]
    assert results[0]["status"] == "unchanged" and unit("u-generic")["type"] == "other"
    assert results[1]["changes"] == {"type": {"before": "other", "after": "switch"}}


async def test_mark_switch_changes_only_units_of_a_generic_type(client):
    c = client
    data = store.read_items()
    data["Rack-02"].append({"id": "u-pdu", "name": "PDU A", "type": "pdu", "serial_number": "PDU-SN-1", "u": 30})
    store.write_items(data)
    rows = [{"serial": "MT2614X00001", "part_number": "MSN2700-CS2F"}, {"serial": "PDU-SN-1", "part_number": "PX3-5190"},
            {"serial": "-CABLE-9", "part_number": "MCP1600-C001"}, {"serial": "MT2614X00003", "part_number": "P4", "type": "Cable"}]
    preview = await c.post(URL, json={"items": rows, "mark_switch": True, "dry_run": True})
    assert preview.status_code == 200 and preview.json()["mark_switch"] is True
    results = by_serial(preview.json())
    assert results["MT2614X00001"]["changes"]["type"] == {"before": "other", "after": "switch"}
    # A PDU or a cable keeps its type; a row's own non-switch type is not overridden by mark_switch.
    assert "type" not in results["PDU-SN-1"]["changes"] and "type" not in results["-CABLE-9"]["changes"]
    assert "type" not in results["MT2614X00003"]["changes"]
    applied = await c.post(URL, headers={"If-Match": preview.headers["etag"]}, json={"items": rows, "mark_switch": True})
    assert applied.status_code == 200
    assert [unit(i)["type"] for i in ("u-generic", "u-pdu", "u-cable", "u-code-name")] == ["switch", "pdu", "cable", "other"]
    # Without mark_switch a row without a type never changes the type.
    unit_rows = [{"serial": "000777", "part_number": "X1"}]
    plain = await c.post(URL, json={"items": unit_rows, "dry_run": True})
    assert "type" not in plain.json()["results"][0]["changes"]


async def test_a_unit_is_found_by_its_barcode_even_when_it_has_a_serial(client):
    c = client
    data = store.read_items()
    data["Rack-01"].append({"id": "u-both", "name": "Unit", "type": "other", "serial_number": "S3", "barcode": "BC3", "u": 9})
    store.write_items(data)
    response = await c.post(URL, headers=await headers(c), json={"items": [{"serial": "bc3", "part_number": "PN-3"}]})
    entry = response.json()["results"][0]
    assert entry["status"] == "updated" and entry["unit"]["id"] == "u-both"
    # Its serial number stays; only the part number changes.
    assert entry["changes"] == {"part_number": {"before": "", "after": "PN-3"}}
    assert (unit("u-both")["serial_number"], unit("u-both")["part_number"]) == ("S3", "PN-3")


@pytest.mark.parametrize("value, expected", [
    ("switch", True), ("Switches", True), ("Ethernet Switch", True), ("Switch system", True), ("InfiniBand switch (managed)", True),
    ("non-switch thing", False), ("switchgear", False), ("switch-like", False), ("Cable", False), ("", False), (None, False),
])
def test_is_switch(value, expected):
    from app.routers.serial_details import is_switch
    assert is_switch(value) is expected
