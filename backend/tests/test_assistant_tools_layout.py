"""Read-only layout tools use isolated stores, observations and cache entries only."""
from contextlib import asynccontextmanager
import json
from pathlib import Path
import time
from types import SimpleNamespace
import unicodedata

import pytest
from sqlalchemy.exc import SQLAlchemyError

from app import inventory_store
from app.assistant import tools_layout
from app.assistant.contracts import Principal, Source, ToolContext, ToolResult
from app.models import AssetOwner, Device, Engineer, MonitorDeviceSnapshot, PingTarget, User
from app.routers import kvms, pdus
from app.schemas import InletReading, PduStatus


STORE_NAMES = {
    "items": "rack_items.json",
    "positions": "rack_positions.json",
    "slots": "rack_slots.json",
    "switches": "switch_assignments.json",
    "overrides": "rack_overrides.json",
    "owners": "opt_owners.json",
    "chillers": "chillers.json",
    "twin": "lab-data.json",
}


@pytest.fixture
async def lab(db_session, tmp_path, monkeypatch):
    import app.main as main

    files = {key: tmp_path / filename for key, filename in STORE_NAMES.items()}
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", files["items"])
    for attr, key in (
        ("_RACK_POSITIONS_FILE", "positions"),
        ("_RACK_SLOTS_FILE", "slots"),
        ("_SWITCH_ASSIGN_FILE", "switches"),
        ("_RACK_OVERRIDES_FILE", "overrides"),
        ("_OPT_OWNERS_FILE", "owners"),
        ("_CHILLERS_FILE", "chillers"),
        ("_TWIN_DATA_FILE", "twin"),
    ):
        monkeypatch.setattr(main, attr, files[key])

    def save(key, value):
        files[key].write_text(json.dumps(value), encoding="utf-8")

    for key in files:
        save(key, {"units": [], "connections": []} if key == "chillers" else {})

    @asynccontextmanager
    async def session_factory():
        yield db_session

    def forbidden(*args, **kwargs):
        raise AssertionError("Assistant tools must never contact a device")

    monkeypatch.setattr(pdus, "_fetch_status", forbidden)
    monkeypatch.setattr(kvms, "_fetch_status", forbidden)
    settings = SimpleNamespace(
        ping_monitor_enabled=True,
        ping_monitor_timezone="Asia/Jerusalem",
        email_alerts_enabled=False,
        email_voltage_min=None,
        email_voltage_max=240.0,
        email_current_min=None,
        email_current_max=12.0,
        email_watts_min=None,
        email_watts_max=2400.0,
        email_alerts_to="recipient-marker@example.invalid",
    )
    ctx = ToolContext(
        principal=Principal(user_id="viewer", username="viewer", role="Viewer"),
        session_factory=session_factory,
        settings=settings,
        now=time.time(),
        project_root=tmp_path,
    )
    return SimpleNamespace(ctx=ctx, db=db_session, files=files, save=save, root=tmp_path)


def device(device_id, labels=None, *, kind="pdu", rack="Rack-01", **kwargs):
    return Device(
        id=device_id, name=kwargs.pop("name", device_id), kind=kind,
        ip=kwargs.pop("ip", "192.0.2.10"), rack=rack,
        labels_json=json.dumps(labels or {}), **kwargs,
    )


def snapshot(device_id, checked_at, *, reachable=True, ports=None):
    return MonitorDeviceSnapshot(
        device_id=device_id, kind="pdu", ip="192.0.2.10",
        checked_at=checked_at, reachable=reachable,
        ports_json=json.dumps(ports or []),
    )


def assert_result(result):
    assert isinstance(result, ToolResult)
    assert result.sources and all(isinstance(source, Source) for source in result.sources)
    json.dumps(result.to_dict())


def test_registry_has_exactly_five_viewer_tools_with_closed_inputs():
    expected = {
        "resolve_entity", "get_dependencies", "get_power_and_environment",
        "get_rack_layout", "search_docs",
    }
    assert len(tools_layout.TOOLS) == len(expected)
    assert {tool.name for tool in tools_layout.TOOLS} == expected
    for tool in tools_layout.TOOLS:
        assert tool.required_role == "Viewer"
        assert tool.description
        assert tool.input_schema["type"] == "object"
        assert tool.input_schema["additionalProperties"] is False


async def test_pdu_dependencies_keep_each_outlet_and_redundancy_is_only_a_hint(lab):
    lab.db.add(device("pdu-a", {"1": "OPT11", "2": "OPT12", "3": "OPT11 (2)"}))
    await lab.db.commit()

    result = await tools_layout.get_dependencies(lab.ctx, kind="pdu", id="pdu-a")

    assert_result(result)
    assert {(row["server_key"], str(row["port"])) for row in result.data["servers"]} == {
        ("opt11", "1"), ("opt12", "2"), ("opt11", "3"),
    }
    assert result.data["redundancy_hint"] == "possible redundant feed — not verified"
    assert any("UPS" in caveat or "A/B" in caveat for caveat in result.caveats)


async def test_server_dependencies_join_full_layout_key_and_canonical_monitor_key(lab):
    lab.db.add_all([
        device("pdu-a", {"1": "Optn84 (2)"}),
        device("pdu-b", {"2": "Optn84"}),
        device("kvm-a", {"7": "Optn84"}, kind="kvm", rack="Rack-02"),
    ])
    await lab.db.commit()
    lab.save("switches", {"optn84 (2)": {"switch": "test-switch", "port": "Ethernet1/2"}})
    lab.save("overrides", {"optn84 (2)": "Rack-03"})

    result = await tools_layout.get_dependencies(lab.ctx, kind="server", id="optn84")

    assert_result(result)
    connections = result.data["connections"]
    assert {row["kind"] for row in connections} >= {"pdu", "kvm", "switch"}
    assert len([row for row in connections if row["kind"] == "pdu"]) == 2
    assert "test-switch" in json.dumps(connections)
    assert "Rack-03" in json.dumps(result.data)
    assert result.data["redundancy_hint"] == "possible redundant feed — not verified"


async def test_kvm_and_switch_dependencies_report_matching_ports(lab):
    lab.db.add(device("kvm-a", {"1": "OPT11", "2": "OPT12"}, kind="kvm"))
    await lab.db.commit()
    lab.save("switches", {
        "opt11": {"switch": "test-switch", "port": "1"},
        "opt12": {"switch": "test-switch", "port": "2"},
        "opt13": {"switch": "other-switch", "port": "3"},
    })

    kvm_result = await tools_layout.get_dependencies(lab.ctx, kind="kvm", id="kvm-a")
    switch_result = await tools_layout.get_dependencies(lab.ctx, kind="switch", id="test-switch")

    for result in (kvm_result, switch_result):
        assert_result(result)
        assert {(row["server_key"], str(row["port"])) for row in result.data["servers"]} == {
            ("opt11", "1"), ("opt12", "2"),
        }
    assert any("free text" in caveat.lower() or "free-text" in caveat.lower()
               for caveat in switch_result.caveats)


async def test_missing_switch_store_is_explicit_evidence(lab):
    lab.files["switches"].unlink()

    result = await tools_layout.get_dependencies(lab.ctx, kind="switch", id="unknown-switch")

    assert_result(result)
    assert any(source.status == "missing" and "switch" in (source.id + source.ref).lower()
               for source in result.sources)


async def test_old_snapshot_or_status_cache_labels_do_not_attach_to_reconfigured_device(lab):
    lab.db.add(device("pdu-a", {"1": "OPT11"}))
    old_snapshot = snapshot("pdu-a", lab.ctx.now - 10, ports=[{
        "number": 2, "label": "OPT99", "state": "on",
    }])
    old_snapshot.ip = "192.0.2.99"
    lab.db.add(old_snapshot)
    await lab.db.commit()
    pdus._cache["pdu-a"] = (time.monotonic(), PduStatus(
        device_id="pdu-a", reachable=True,
        outlets=[{"number": 3, "label": "OPT88", "state": "on"}],
    ))

    result = await tools_layout.get_dependencies(lab.ctx, kind="pdu", id="pdu-a")

    assert_result(result)
    assert {(row["server_key"], str(row["port"])) for row in result.data["servers"]} == {("opt11", "1")}
    assert any(source.id == "snapshot:pdu-a" and source.status == "missing" for source in result.sources)


async def test_corrupt_inventory_and_layout_are_unavailable_not_empty(lab):
    lab.files["items"].write_text("{broken", encoding="utf-8")
    lab.files["switches"].write_text("{broken", encoding="utf-8")

    result = await tools_layout.get_dependencies(lab.ctx, kind="rack", id="Rack-01")

    assert_result(result)
    assert any(source.status == "unavailable" and "rack_items" in (source.id + source.ref)
               for source in result.sources)
    assert any(source.status == "unavailable" and "switch" in (source.id + source.ref)
               for source in result.sources)


async def test_rack_power_deduplicates_shared_pdu_and_does_not_add_inlet_watts(lab):
    lab.db.add(device("pdu-a", rack="Rack-01", notes="shared:Rack-01,shared:Rack-02"))
    lab.db.add(snapshot("pdu-a", lab.ctx.now - 10, ports=[{
        "number": 1, "label": "OPT11", "state": "on", "watts": 250.0,
    }]))
    await lab.db.commit()
    pdus._cache["pdu-a"] = (time.monotonic(), PduStatus(
        device_id="pdu-a", reachable=True, total_watts=250.0, watts_complete=True,
        inlet_readings=[InletReading(number=1, watts=250.0, voltage=208.0, current=1.2)],
        temperature=24.0, humidity=40.0, leak_detected=False,
    ))
    lab.save("chillers", {"units": [{"id": "chiller-a", "rack": "Rack-01"}], "connections": []})

    own = await tools_layout.get_power_and_environment(lab.ctx, rack="Rack-01")
    shared = await tools_layout.get_power_and_environment(lab.ctx, rack="Rack-02")

    for result in (own, shared):
        assert_result(result)
        assert result.data["totals"]["pdu_ids"] == ["pdu-a"]
        assert result.data["totals"]["total_watts"] == 250.0
        assert result.data["totals"]["watts_complete"] is True
        assert len(result.data["pdus"]) == 1
        assert result.data["capacity"]["assumption"] == "16 A / 208 V UI constant"
    row = own.data["pdus"][0]
    assert row["temperature"] == 24.0 and row["humidity"] == 40.0
    assert row["leak_detected"] is False and row["stale"] is False
    assert row["checked_at"] and row["cache_as_of"]
    assert own.data["thresholds"]
    assert "chiller-a" in json.dumps(own.data["chillers"])


async def test_unknown_watts_remain_null_without_contacting_devices(lab):
    lab.db.add_all([device("pdu-known"), device("pdu-unknown")])
    await lab.db.commit()
    pdus._cache["pdu-known"] = (time.monotonic(), PduStatus(
        device_id="pdu-known", reachable=True, total_watts=100.0, watts_complete=True,
    ))

    result = await tools_layout.get_power_and_environment(lab.ctx, rack="Rack-01")

    assert_result(result)
    rows = {row["id"]: row for row in result.data["pdus"]}
    assert rows["pdu-unknown"]["total_watts"] is None
    assert rows["pdu-unknown"]["watts_complete"] is False
    assert result.data["totals"]["total_watts"] is None
    assert result.data["totals"]["watts_complete"] is False


@pytest.mark.parametrize("reachable,cache_age", [(True, 90), (False, 0)])
async def test_power_cache_is_stale_when_older_than_snapshot_or_unreachable(lab, reachable, cache_age):
    lab.db.add(device("pdu-a"))
    lab.db.add(snapshot("pdu-a", lab.ctx.now - 10, reachable=reachable))
    await lab.db.commit()
    pdus._cache["pdu-a"] = (time.monotonic() - cache_age, PduStatus(
        device_id="pdu-a", reachable=True, total_watts=300.0, watts_complete=True,
    ))

    result = await tools_layout.get_power_and_environment(lab.ctx, pdu_id="pdu-a")

    assert_result(result)
    assert result.data["pdus"][0]["stale"] is True
    assert result.data["totals"]["total_watts"] is None
    assert result.data["totals"]["watts_complete"] is False
    assert any(source.status == "stale" for source in result.sources)


async def test_resolve_returns_all_ambiguous_candidates_and_caps_at_ten(lab):
    lab.db.add_all([device("pdu-a", name="duplicate"), device("kvm-a", kind="kvm", name="duplicate")])
    await lab.db.commit()

    result = await tools_layout.resolve_entity(lab.ctx, query="duplicate")

    assert_result(result)
    assert result.data["ambiguous"] is True
    assert {(row["kind"], row["id"]) for row in result.data["candidates"]} == {
        ("pdu", "pdu-a"), ("kvm", "kvm-a"),
    }
    assert all(row["match"] == "exact" for row in result.data["candidates"])
    lab.db.add_all([device(f"extra-{number}", name=f"duplicate {number}") for number in range(15)])
    await lab.db.commit()
    capped = await tools_layout.resolve_entity(lab.ctx, query="duplicate")
    assert len(capped.data["candidates"]) <= 10
    assert capped.data["ambiguous"] is True


@pytest.mark.parametrize("query,kind,entity_id", [
    ("SERIAL-55", "item", "item-a"),
    ("BARCODE-55", "item", "item-a"),
    ("192.0.2.21", "server", "opt11"),
    ("Rack-03", "rack", "Rack-03"),
])
async def test_resolve_matches_inventory_identifiers_ping_hosts_and_racks(lab, query, kind, entity_id):
    lab.save("items", {"Rack-03": [{
        "id": "item-a", "name": "Test switch", "type": "switch",
        "serial_number": "SERIAL-55", "barcode": "BARCODE-55",
    }]})
    lab.db.add(PingTarget(
        id="target-opt11", source_key="opt11", name="OPT11", host="192.0.2.21", rack="Rack-03",
    ))
    await lab.db.commit()

    result = await tools_layout.resolve_entity(lab.ctx, query=query)

    assert_result(result)
    assert any(row["kind"] == kind and row["id"] == entity_id and row["match"] == "exact"
               for row in result.data["candidates"])


async def test_layout_uses_twin_shelves_top_index_and_owner_names(lab):
    lab.db.add(device("pdu-a", {"1": "OPT11"}))
    lab.db.add(Engineer(id="engineer-a", name="Test Owner", name_key="test owner"))
    lab.db.add(AssetOwner(asset_key="item:item-a", engineer_id="engineer-a"))
    await lab.db.commit()
    lab.save("items", {"Rack-01": [{
        "id": "item-a", "name": "Test switch", "type": "switch", "u": 1,
        "shelf_position": "left", "serial_number": "SN-1", "last_seen_at": "2026-01-01T00:00:00Z",
    }, {"id": "item-unplaced", "name": "Unplaced item", "type": "computer"}]})
    lab.save("slots", {"Rack-01": {"opt11": 2}})
    lab.save("positions", {"Rack-01": ["opt11"]})
    lab.save("twin", {"setups": [{
        "id": "setup-a", "dcimRack": "Rack-01", "dcimMappingConfidence": "low",
        "shelves": ["shelf-1", "shelf-2", "shelf-3"],
    }]})

    result = await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01")

    assert_result(result)
    assert result.data["shelf_count"] == 3
    assert result.data["mapping_confidence"] == "low"
    assert result.data["free_shelves_confidence"] == "low"
    assert result.data["free_shelves"] == [3]
    items = {row["id"]: row for row in result.data["items"]}
    assert items["item-a"]["u"] == 1
    assert items["item-a"]["shelf_position"] == "left"
    assert "Test Owner" in json.dumps(items["item-a"])
    assert items["item-unplaced"]["unplaced"] is True
    assert any("top" in caveat.lower() and "shelf" in caveat.lower() for caveat in result.caveats)
    assert any("weight" in caveat.lower() or "height" in caveat.lower() for caveat in result.caveats)


def twin_server():
    return {
        "setups": [{
            "id": "setup-a", "dcimRack": "Rack-01", "dcimMappingConfidence": "low",
            "shelves": ["shelf-low", "shelf-high"],
        }],
        "shelves": [
            {"id": "shelf-low", "setup": "setup-a", "level": 1},
            {"id": "shelf-high", "setup": "setup-a", "level": 2},
        ],
        "items": [{
            "id": "twin-opt99", "type": "opt", "setup": "setup-a", "shelf": "shelf-low",
            "dcim": {"optKey": "opt99"},
        }],
    }


async def test_twin_only_server_uses_bottom_shelf_as_u2_instead_of_auto_placement(lab):
    lab.save("twin", twin_server())

    result = await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01")

    assert_result(result)
    server = next(row for row in result.data["servers"] if row["server_key"] == "opt99")
    assert server["u"] == 2
    assert server["auto_placed"] is False
    assert server["placement_source"] == "twin"
    assert result.data["free_shelves"] == [1]


async def test_twin_provenance_and_conflicting_pdu_rack_survive_resolve_and_dependencies(lab):
    lab.save("twin", twin_server())
    lab.db.add(device("pdu-a", {"1": "OPT99"}, rack="Rack-02"))
    await lab.db.commit()

    resolved = await tools_layout.resolve_entity(lab.ctx, query="opt99")
    dependencies = await tools_layout.get_dependencies(lab.ctx, kind="server", id="opt99")

    server = next(row for row in resolved.data["candidates"]
                  if row["kind"] == "server" and row["id"] == "opt99")
    for row in (server, dependencies.data):
        candidates = row["rack_candidates"]
        assert {candidate["rack"] for candidate in candidates} >= {"Rack-01", "Rack-02"}
        assert any(candidate["rack"] == "Rack-01" and candidate["source"] == "twin"
                   for candidate in candidates)
    assert server["rack_conflict"] is True


@pytest.mark.parametrize("recorded_u,expected_u,unplaced", [(3, 3, False), (None, 0, True)])
async def test_inventory_server_uses_recorded_shelf_or_stays_unplaced(lab, recorded_u, expected_u, unplaced):
    lab.save("items", {"Rack-01": [{
        "id": "computer-a", "name": "OPT11", "type": "computer", "u": recorded_u,
    }]})
    lab.save("twin", {"setups": [{
        "id": "setup-a", "dcimRack": "Rack-01", "dcimMappingConfidence": "low",
        "shelves": ["shelf-1", "shelf-2", "shelf-3"],
    }]})

    result = await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01")

    server = next(row for row in result.data["servers"] if row["server_key"] == "opt11")
    assert server["u"] == expected_u
    assert server["unplaced"] is unplaced
    assert server["auto_placed"] is False
    assert server["placement_source"] == "rack_items"
    assert result.data["free_shelves"] == ([1, 2, 3] if unplaced else [1, 2])


async def test_missing_inventory_makes_free_shelves_unknown(lab):
    lab.save("twin", twin_server())
    lab.files["items"].unlink()

    result = await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01")

    assert result.data["shelf_count"] == 2
    assert result.data["free_shelves"] is None
    assert result.data["placement_sources_complete"] is False
    assert any(source.id == "rack_items" and source.status == "missing" for source in result.sources)


async def test_cleared_owner_does_not_restore_legacy_or_inventory_owner(lab):
    lab.db.add(AssetOwner(asset_key="item:item-a", engineer_id=None, legacy_name=""))
    await lab.db.commit()
    lab.save("items", {"Rack-01": [{
        "id": "item-a", "name": "Safe item", "type": "switch", "owner": "Inventory Owner",
    }]})
    lab.save("owners", {"item:item-a": "Legacy Owner"})

    result = await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01")

    assert result.data["items"][0]["owner"] is None


async def test_docs_only_search_allowlist_and_mark_bounded_snippets_untrusted(lab):
    docs = lab.root / "docs"
    docs.mkdir()
    (docs / "ai-team").mkdir()
    (docs / "ping-monitoring.md").write_text("# Ping guide\n\nneedle " + "x" * 1200, encoding="utf-8")
    (docs / "ai-team" / "private.md").write_text("needle PRIVATE-AI-TEAM", encoding="utf-8")
    (docs / "not-allowed.md").write_text("needle NOT-ALLOWLISTED", encoding="utf-8")

    result = await tools_layout.search_docs(lab.ctx, query="needle", limit=5)

    assert_result(result)
    assert len(result.data["matches"]) == 1
    row = result.data["matches"][0]
    assert row["file"] == "docs/ping-monitoring.md"
    assert "Ping guide" in row["heading"]
    assert row["untrusted_text"] is True and len(row["snippet"]) <= 600
    output = json.dumps(result.to_dict())
    assert all(marker not in output for marker in ("PRIVATE-AI-TEAM", "NOT-ALLOWLISTED"))
    traversal = await tools_layout.search_docs(lab.ctx, query="../.env", limit=5)
    assert not traversal.data["matches"]


@pytest.mark.parametrize("credential", [
    "SMTP_PASSWORD=" + "q" * 180 + "credential-tail-marker",
    '{"password": "' + "q" * 180 + 'credential-tail-marker"}',
    "Basic " + "q" * 180 + "credential-tail-marker",
    "https://credential-tail-marker:password-tail-marker@host.invalid",
])
async def test_doc_credentials_are_redacted_before_snippet_clipping(lab, credential):
    docs = lab.root / "docs"
    docs.mkdir()
    (docs / "email-alerts.md").write_text(
        "# Test owner private-owner@example.invalid\n" + credential + " needle documented behavior\n",
        encoding="utf-8",
    )

    result = await tools_layout.search_docs(lab.ctx, query="needle")

    assert result.data["matches"]
    output = json.dumps(result.to_dict())
    assert "needle" in output
    assert "credential-tail-marker" not in output
    assert "password-tail-marker" not in output
    assert "private-owner@example.invalid" not in output


@pytest.mark.parametrize("target_kind", ["outside", "ai-team"])
async def test_docs_refuse_allowlisted_symlink_to_disallowed_target(lab, target_kind, monkeypatch):
    docs = lab.root / "docs"
    docs.mkdir()
    if target_kind == "ai-team":
        (docs / "ai-team").mkdir()
        target = docs / "ai-team" / "private.md"
    else:
        target = lab.root.parent / "outside-doc.txt"
    target.write_text("needle DISALLOWED-SYMLINK", encoding="utf-8")
    link = docs / "ping-monitoring.md"
    try:
        link.symlink_to(target)
    except OSError:
        # Exercise exactly the resolver boundary when Windows denies actual symlinks.
        link.write_text(target.read_text(encoding="utf-8"), encoding="utf-8")
        original_resolve = Path.resolve

        def redirected_resolve(path, *args, **kwargs):
            return original_resolve(target if path == link else path, *args, **kwargs)

        monkeypatch.setattr(Path, "resolve", redirected_resolve)

    result = await tools_layout.search_docs(lab.ctx, query="needle")

    assert not result.data["matches"]
    assert "DISALLOWED-SYMLINK" not in json.dumps(result.to_dict())
    assert any(source.ref == "docs/ping-monitoring.md" and source.status == "unavailable"
               for source in result.sources)


@pytest.mark.parametrize("store,value,source_name", [
    ("items", {"Rack-01": [{"id": "item-a", "type": ["bad"]}]}, "rack_items"),
    ("switches", {"opt11": {"switch": ["bad"], "port": 1}}, "switch_assignments"),
    ("slots", {"Rack-01": {"opt11": {"bad": 2}}}, "rack_slots"),
    ("positions", {"Rack-01": {"opt11": "right"}}, "rack_positions"),
])
async def test_malformed_nested_store_values_are_explicitly_unavailable(lab, store, value, source_name):
    lab.save(store, value)

    if store == "switches":
        result = await tools_layout.get_dependencies(lab.ctx, kind="server", id="opt11")
    else:
        result = await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01")

    assert_result(result)
    assert any(source.id == source_name and source.status == "unavailable" for source in result.sources)


async def test_database_failure_is_unavailable_evidence_without_exception_details(lab):
    @asynccontextmanager
    async def unavailable_session():
        raise SQLAlchemyError("sensitive-database-marker")
        yield  # Make the failing factory an async context manager.

    lab.ctx.session_factory = unavailable_session

    results = [
        await tools_layout.resolve_entity(lab.ctx, query="opt11"),
        await tools_layout.get_power_and_environment(lab.ctx, rack="Rack-01"),
        await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01"),
    ]

    for result in results:
        assert_result(result)
        assert any(source.status == "unavailable" for source in result.sources)
        assert "sensitive-database-marker" not in json.dumps(result.to_dict())


async def test_untrusted_labels_and_notes_are_bounded_and_control_characters_removed(lab):
    lab.db.add(device("pdu-a", {"1": "OPT11"},
                      name="PDU\x00\x01" + "z" * 600,
                      notes="note\u202e\x1b" + "n" * 600))
    await lab.db.commit()
    lab.save("items", {"Rack-01": [{
        "id": "item-a", "name": "item\x00" + "x" * 600, "type": "switch",
    }]})

    results = [
        await tools_layout.resolve_entity(lab.ctx, query="pdu-a"),
        await tools_layout.get_dependencies(lab.ctx, kind="rack", id="Rack-01"),
        await tools_layout.get_power_and_environment(lab.ctx, rack="Rack-01"),
        await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01"),
    ]

    def assert_clean(value):
        if isinstance(value, str):
            assert len(value) <= 300
            assert not any(unicodedata.category(character).startswith("C") for character in value)
        elif isinstance(value, dict):
            for key, child in value.items():
                assert_clean(key)
                assert_clean(child)
        elif isinstance(value, list):
            for child in value:
                assert_clean(child)

    for result in results:
        assert_clean(result.data)


async def test_tools_never_serialize_device_credentials_user_secrets_or_extra_inventory_fields(lab):
    lab.db.add(device(
        "pdu-a", {"1": "OPT11"}, username_enc="encrypted-user-marker", password_enc="encrypted-pass-marker",
    ))
    lab.db.add(User(
        id="other-user", username="other", name="Other", email="private-user@example.invalid",
        password_hash="password-hash-marker", created_at=lab.ctx.now,
    ))
    await lab.db.commit()
    lab.save("items", {"Rack-01": [{
        "id": "item-a", "name": "Safe item", "type": "switch",
        "password": "inventory-pass-marker", "token": "inventory-token-marker",
    }]})
    pdus._cache["pdu-a"] = (time.monotonic(), PduStatus(
        device_id="pdu-a", reachable=False, error="cache-password-marker",
    ))

    results = [
        await tools_layout.resolve_entity(lab.ctx, query="pdu-a"),
        await tools_layout.get_dependencies(lab.ctx, kind="pdu", id="pdu-a"),
        await tools_layout.get_dependencies(lab.ctx, kind="rack", id="Rack-01"),
        await tools_layout.get_power_and_environment(lab.ctx, rack="Rack-01"),
        await tools_layout.get_rack_layout(lab.ctx, rack="Rack-01"),
    ]

    output = json.dumps([result.to_dict() for result in results])
    for forbidden in (
        "username_enc", "password_enc", "encrypted-user-marker", "encrypted-pass-marker",
        "private-user@example.invalid", "password-hash-marker", "recipient-marker@example.invalid",
        "inventory-pass-marker", "inventory-token-marker", "cache-password-marker",
    ):
        assert forbidden not in output
