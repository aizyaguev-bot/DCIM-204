"""Read-only status evidence must preserve failures, uncertainty and provenance."""
from __future__ import annotations

import ast
import datetime as dt
import json
import unicodedata
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.assistant import tools_status
from app.assistant.contracts import Principal, ToolContext, ToolError, age, iso
from app.models import (
    AlertCondition, AlertEmail, AssetOwner, Device, Engineer, MonitorDeviceError,
    MonitorDeviceSnapshot, PduMaintenance, PduMaintenanceLog, PingIncident,
    PingMonitorState, PingSample, PingTarget,
)


NOW = dt.datetime(2026, 10, 18, 10, tzinfo=dt.timezone.utc).timestamp()
DAY = 24 * 60 * 60


def write_json(ctx, name, value):
    path = ctx.project_root / "backend" / name
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


@pytest.fixture
async def status_lab(db_session, tmp_path, monkeypatch):
    """Use conftest's in-memory DB, separate short tool sessions and fake files."""
    settings = SimpleNamespace(
        ping_monitor_enabled=True, email_alerts_enabled=False, pxe_enabled=False,
        accounts_enabled=True, ping_monitor_timezone="UTC",
    )
    ctx = ToolContext(
        principal=Principal(user_id="viewer-test", username="viewer", role="Viewer"),
        session_factory=async_sessionmaker(db_session.bind, expire_on_commit=False),
        settings=settings, now=NOW, project_root=tmp_path,
    )
    (tmp_path / "backend").mkdir()
    (tmp_path / "lab-twin").mkdir()
    for filename in (
        "rack_items.json", "rack_positions.json", "rack_slots.json",
        "switch_assignments.json", "rack_overrides.json", "opt_owners.json",
    ):
        write_json(ctx, filename, {})
    write_json(ctx, "chillers.json", {"units": [], "connections": []})
    (tmp_path / "lab-twin" / "lab-data.json").write_text(
        json.dumps({"meta": {"generated": iso(NOW)}, "setups": [], "items": [], "shelves": []}),
        encoding="utf-8",
    )
    # Legacy owner_map and inventory readers must also remain inside this fixture.
    from app import engineers, inventory_store
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "backend" / "rack_items.json")
    monkeypatch.setattr(
        engineers, "legacy_owners",
        lambda: json.loads((tmp_path / "backend" / "opt_owners.json").read_text(encoding="utf-8")),
    )
    db_session.add(PingMonitorState(
        id=1, next_run_at=NOW + 60, last_started_at=NOW - 30, last_completed_at=NOW - 20,
    ))
    await db_session.commit()
    return ctx, db_session


def target(id="target-84", *, name="Opt84", key="server:opt84", **kwargs):
    values = dict(
        id=id, source_key=key, name=name, host="192.0.2.84", status="up",
        checked_at=NOW - 10, last_up_at=NOW - 10, rtt_ms=1.5,
    )
    values.update(kwargs)
    return PingTarget(**values)


def pdu(id="pdu-test", *, name="Fixture PDU", label="Opt84", **kwargs):
    values = dict(
        id=id, name=name, kind="pdu", ip="192.0.2.20", rack="Rack-PDU",
        labels_json=json.dumps({"1": label}),
    )
    values.update(kwargs)
    return Device(**values)


def snapshot(device, *, checked_at=NOW - 10, reachable=True, state="on", **kwargs):
    values = dict(
        device_id=device.id, kind=device.kind, ip=device.ip, checked_at=checked_at,
        reachable=reachable,
        ports_json=json.dumps([{"number": 1, "label": device.labels["1"], "state": state}]),
    )
    values.update(kwargs)
    return MonitorDeviceSnapshot(**values)


def source_ids(result):
    ids = [source.id for source in result.sources]
    assert len(ids) == len(set(ids)), "Evidence ids must be unique in one result"
    return set(ids)


def assert_json_safe(result):
    payload = result.to_dict()
    json.dumps(payload, allow_nan=False)

    def walk(value):
        if isinstance(value, str):
            assert len(value) <= 300
            assert not any(unicodedata.category(char).startswith("C") for char in value)
        elif isinstance(value, dict):
            for key, child in value.items():
                assert isinstance(key, str)
                walk(key)
                walk(child)
        elif isinstance(value, list):
            assert len(value) <= 200
            for child in value:
                walk(child)

    walk(payload)


async def test_active_failure_is_high_severity_with_incident_times_and_source(status_lab):
    ctx, db = status_lab
    down = target(status="down", checked_at=NOW - 10, last_up_at=NOW - 600)
    db.add(down)
    await db.flush()
    db.add(PingIncident(
        target_id=down.id, host=down.host, previous_up_at=NOW - 600,
        first_failed_at=NOW - 300, last_failed_at=NOW - 10, failed_checks=4,
    ))
    await db.commit()

    result = await tools_status.list_current_problems(ctx)
    matches = [problem for problem in result.data["problems"]
               if problem["severity"] == "high" and problem["since_iso"] == iso(NOW - 300)]
    assert matches
    assert any(problem["last_seen_iso"] == iso(NOW - 10) for problem in matches)
    evidence = source_ids(result)
    assert all(problem["source_id"] in evidence for problem in result.data["problems"])
    assert result.data["total"] >= len(matches)
    for problem in matches:
        assert set(("kind", "severity", "entity", "since_iso", "last_seen_iso", "detail", "source_id")) <= problem.keys()
        assert set(("kind", "id", "label")) <= problem["entity"].keys()


async def test_healthy_observations_still_report_unmonitored_categories(status_lab):
    ctx, db = status_lab
    db.add(target())
    await db.commit()

    problems = await tools_status.list_current_problems(ctx)
    overview = await tools_status.lab_status_overview(ctx)
    assert problems.data["problems"] == []
    assert overview.data["target_counts"]["up"] == 1
    assert overview.data["open_incidents"] == 0
    assert overview.data["enabled_sources"]["email_alerts"] is False
    for result in (problems, overview):
        text = " ".join(result.caveats).casefold()
        assert all(word in text for word in ("alert", "ups", "cool", "switch"))


async def test_target_counts_preserve_stale_paused_and_unconfigured_states(status_lab):
    ctx, db = status_lab
    db.add_all([
        target("up", key="manual:up"),
        target("stale", key="manual:stale", checked_at=NOW - 7200),
        target("paused", key="manual:paused", enabled=False, status="down"),
        target("unconfigured", key="manual:unconfigured", host="", status="down"),
        target("error", key="manual:error", status="error"),
    ])
    await db.commit()

    result = await tools_status.lab_status_overview(ctx)
    for status in ("up", "stale", "paused", "unconfigured", "error"):
        assert result.data["target_counts"][status] == 1


async def test_stale_snapshot_never_exposes_old_outlet_success(status_lab):
    ctx, db = status_lab
    device = pdu()
    db.add_all([target(), device, snapshot(device, checked_at=NOW - 2 * 60 * 60)])
    await db.commit()

    overview = await tools_status.lab_status_overview(ctx)
    status = await tools_status.get_server_status(ctx, server="opt84")
    problems = await tools_status.list_current_problems(ctx)
    assert next(row for row in overview.data["devices"] if row["device_id"] == device.id)["status"] == "stale"
    assert status.data["pdu"][0]["status"] == "stale"
    assert status.data["pdu"][0]["checked_at"] == iso(NOW - 2 * 60 * 60)
    matching = [problem for problem in problems.data["problems"] if problem["entity"]["id"] == device.id]
    assert matching and all(problem["severity"] == "unknown" for problem in matching)
    assert any(source.status == "stale" and source.age_s == age(NOW - 2 * 60 * 60, NOW)
               for source in overview.sources)


@pytest.mark.parametrize("content,expected", [(None, "missing"), ("{invalid-json", "unavailable")])
async def test_runtime_file_failure_is_evidence_and_does_not_hide_table_data(status_lab, content, expected):
    ctx, db = status_lab
    db.add(target())
    await db.commit()
    path = ctx.project_root / "backend" / "rack_items.json"
    if content is None:
        path.unlink()
    else:
        path.write_text(content, encoding="utf-8")

    result = await tools_status.lab_status_overview(ctx)
    assert result.data["data_files"]["rack_items.json"] == expected
    assert result.data["target_counts"]["up"] == 1
    assert any(source.status == expected and "rack_items.json" in (source.id + source.ref)
               for source in result.sources)


async def test_saved_rack_positions_accept_the_runtime_ordered_label_array_format(status_lab):
    ctx, _ = status_lab
    write_json(ctx, "rack_positions.json", {"Rack-A": ["opt84", "opt85 (2)"]})

    result = await tools_status.lab_status_overview(ctx)
    assert result.data["data_files"]["rack_positions.json"] == "ok"


async def test_ambiguous_name_returns_candidates_and_exact_id_resolves(status_lab):
    ctx, db = status_lab
    db.add_all([
        target("candidate-a", name="Duplicate", key="manual:a"),
        target("candidate-b", name="Duplicate", key="manual:b", host="192.0.2.85"),
    ])
    await db.commit()

    ambiguous = await tools_status.get_server_status(ctx, server="Duplicate")
    exact = await tools_status.get_server_status(ctx, server="candidate-a")
    assert ambiguous.data["status"] == "ambiguous"
    assert {candidate["id"] for candidate in ambiguous.data["candidates"]} == {"candidate-a", "candidate-b"}
    assert exact.data["status"] == "found" and exact.data["server"]["id"] == "candidate-a"


@pytest.mark.parametrize("query", ["Opt84 (2)", "opt84", "target-84"])
async def test_server_identity_joins_full_label_and_canonical_layout_keys(status_lab, query):
    ctx, db = status_lab
    device = pdu(label="Opt84 (2)")
    db.add_all([
        target(name="Opt84 (2)"), device, snapshot(device),
        Engineer(id="engineer-test", name="Fixture Owner", name_key="fixture owner"),
        AssetOwner(asset_key="opt84 (2)", engineer_id="engineer-test"),
        PduMaintenance(device_id=device.id, started_at=NOW - 600, started_by="Fixture Operator",
                       reason="Routine test", outlets_off_json="[1]"),
    ])
    await db.commit()
    write_json(ctx, "rack_overrides.json", {"opt84 (2)": "Rack-Override"})
    write_json(ctx, "switch_assignments.json", {"opt84 (2)": {"switch": "Fixture Switch", "port": "7"}})
    write_json(ctx, "rack_items.json", {
        "Rack-Inventory": [{"id": "item-84", "type": "computer", "name": "Opt84 (2)", "u": 1}],
    })

    result = await tools_status.get_server_status(ctx, server=query)
    assert result.data["status"] == "found"
    assert result.data["server"]["key"] == "opt84"
    assert result.data["icmp"]["status"] == "up"
    assert result.data["pdu"][0]["device_id"] == device.id
    racks = result.data["rack_candidates"]
    assert [row["rack"] for row in racks[:3]] == ["Rack-Override", "Rack-PDU", "Rack-Inventory"]
    assert result.data["rack_conflict"] is True
    evidence = source_ids(result)
    assert all(row["source_id"] in evidence for row in racks)
    assert "Fixture Owner" in result.data["owner_names"]
    assert any(row["switch"] == "Fixture Switch" and str(row["port"]) == "7"
               for row in result.data["switch_assignments"])
    assert any(row["device_id"] == device.id for row in result.data["maintenance"])


async def test_saved_suffix_layout_keys_join_current_canonical_labels(status_lab):
    ctx, db = status_lab
    device = pdu()
    db.add_all([target(), device, snapshot(device)])
    await db.commit()
    write_json(ctx, "rack_overrides.json", {"opt84 (2)": "Rack-Saved-Suffix"})
    write_json(ctx, "switch_assignments.json", {"opt84 (2)": {"switch": "Saved Suffix Switch", "port": "9"}})
    write_json(ctx, "opt_owners.json", {"opt84 (2)": "Saved Suffix Owner"})

    result = await tools_status.get_server_status(ctx, server="opt84")
    assert result.data["status"] == "found"
    assert result.data["rack_candidates"][0]["rack"] == "Rack-Saved-Suffix"
    assert any(row["switch"] == "Saved Suffix Switch" and str(row["port"]) == "9"
               for row in result.data["switch_assignments"])
    assert result.data["owner_names"] == ["Saved Suffix Owner"]


async def test_twin_rack_uses_item_setup_and_preserves_mapping_confidence(status_lab):
    ctx, db = status_lab
    db.add(target())
    await db.commit()
    (ctx.project_root / "lab-twin" / "lab-data.json").write_text(json.dumps({
        "setups": [{"id": "SETUP-FIXTURE", "dcimRack": "Rack-Twin", "dcimMappingConfidence": "low"}],
        "items": [{"id": "TWIN-84", "type": "opt", "name": "Opt84", "setup": "SETUP-FIXTURE"}],
    }), encoding="utf-8")

    result = await tools_status.get_server_status(ctx, server="opt84")
    candidate = next(row for row in result.data["rack_candidates"] if row["rack"] == "Rack-Twin")
    assert candidate["setup_id"] == "SETUP-FIXTURE"
    assert candidate["confidence"] == "low"
    assert candidate["source_id"] in source_ids(result)


@pytest.mark.parametrize("changed", [{"ip": "192.0.2.99"}, {"kind": "kvm"}])
async def test_snapshot_configuration_mismatch_discards_old_success(status_lab, changed):
    ctx, db = status_lab
    device = pdu()
    db.add_all([target(), device, snapshot(device, **changed)])
    await db.commit()

    overview = await tools_status.lab_status_overview(ctx)
    server = await tools_status.get_server_status(ctx, server="opt84")
    observed = next(row for row in overview.data["devices"] if row["device_id"] == device.id)
    assert observed["status"] == "pending" and observed["checked_at"] is None
    assert server.data["pdu"][0]["status"] == "pending"
    assert server.data["pdu"][0]["checked_at"] is None


async def test_corrupt_snapshot_preserves_configured_feed_without_reporting_success(status_lab):
    ctx, db = status_lab
    device = pdu()
    db.add_all([
        target(), device, snapshot(device, ports_json="{invalid-json"),
        PduMaintenance(device_id=device.id, started_at=NOW - 600, started_by="Fixture Operator"),
    ])
    await db.commit()

    overview = await tools_status.lab_status_overview(ctx)
    server = await tools_status.get_server_status(ctx, server="opt84")
    assert next(row for row in overview.data["devices"] if row["device_id"] == device.id)["status"] == "unknown"
    assert server.data["pdu"][0]["device_id"] == device.id
    assert server.data["pdu"][0]["status"] == "unknown"
    assert any(row["device_id"] == device.id for row in server.data["maintenance"])
    assert any(source.status == "unavailable" and source.id == "monitor_device_snapshots" for source in server.sources)


async def test_unrelated_corrupt_snapshot_preserves_valid_learned_feed_and_maintenance(status_lab):
    ctx, db = status_lab
    learned = pdu("pdu-learned", labels_json="{}")
    corrupt = pdu("pdu-corrupt", label="Opt85")
    db.add_all([
        target(), learned, corrupt,
        MonitorDeviceSnapshot(
            device_id=learned.id, kind=learned.kind, ip=learned.ip, checked_at=NOW - 10,
            reachable=True, ports_json=json.dumps([{"number": 1, "label": "Opt84", "state": "on"}]),
        ),
        snapshot(corrupt, ports_json="{invalid-json"),
        PduMaintenance(device_id=learned.id, started_at=NOW - 600, started_by="Fixture Operator"),
    ])
    await db.commit()

    result = await tools_status.get_server_status(ctx, server="opt84")
    assert result.data["status"] == "found"
    assert [row["device_id"] for row in result.data["pdu"]] == [learned.id]
    assert result.data["pdu"][0]["status"] == "unknown"
    assert [row["device_id"] for row in result.data["maintenance"]] == [learned.id]
    assert any(source.id == "monitor_device_snapshots" and source.status == "unavailable" for source in result.sources)


async def test_server_owner_includes_matching_inventory_item_assignment(status_lab):
    ctx, db = status_lab
    db.add_all([
        target(),
        Engineer(id="item-engineer", name="Fixture Item Owner", name_key="fixture item owner"),
        AssetOwner(asset_key="item:item-84", engineer_id="item-engineer"),
    ])
    await db.commit()
    write_json(ctx, "rack_items.json", {"Rack-Inventory": [{
        "id": "item-84", "type": "computer", "name": "Opt84", "owner": "Legacy Item Owner",
    }]})

    result = await tools_status.get_server_status(ctx, server="opt84")
    assert result.data["owner_names"] == ["Fixture Item Owner"]


@pytest.mark.parametrize("disabled", ["device", "monitor"])
async def test_disabled_monitor_or_device_never_reports_fresh_api_success(status_lab, disabled):
    ctx, db = status_lab
    device = pdu(enabled=disabled != "device")
    if disabled == "monitor":
        ctx.settings.ping_monitor_enabled = False
    db.add_all([target(), device, snapshot(device)])
    await db.commit()

    overview = await tools_status.lab_status_overview(ctx)
    server = await tools_status.get_server_status(ctx, server="opt84")
    expected = "disabled" if disabled == "device" else "paused"
    assert next(row for row in overview.data["devices"] if row["device_id"] == device.id)["status"] == expected
    assert server.data["pdu"][0]["status"] == expected
    if disabled == "monitor":
        assert overview.data["monitor"]["status"] == "disabled"
        assert server.data["icmp"]["status"] == "paused"
        assert any(source.id == "ping_monitor_state" and source.status == "disabled" for source in overview.sources)


async def test_future_observation_timestamps_cannot_establish_current_health(status_lab):
    ctx, db = status_lab
    device = pdu()
    db.add_all([target(checked_at=NOW + 600), device, snapshot(device, checked_at=NOW + 600)])
    await db.commit()

    overview = await tools_status.lab_status_overview(ctx)
    server = await tools_status.get_server_status(ctx, server="opt84")
    assert overview.data["target_counts"]["up"] == 0
    assert next(row for row in overview.data["devices"] if row["device_id"] == device.id)["status"] != "ok"
    assert server.data["icmp"]["status"] != "up"
    assert server.data["pdu"][0]["status"] != "on"


async def test_server_samples_are_the_latest_twenty_in_time_order(status_lab):
    ctx, db = status_lab
    server = target()
    db.add(server)
    await db.flush()
    db.add_all([PingSample(target_id=server.id, host=server.host, checked_at=NOW - offset,
                           status="up", rtt_ms=float(offset)) for offset in range(1, 26)])
    await db.commit()

    result = await tools_status.get_server_status(ctx, server=server.id)
    samples = result.data["samples"]
    assert len(samples) == 20
    assert [row["checked_at"] for row in samples] == [iso(NOW - offset) for offset in range(1, 21)]


@pytest.mark.parametrize("error,next_run,expected", [("", NOW - 120, "overdue"), ("Fixture monitor error", NOW + 60, "error")])
async def test_monitor_overdue_or_error_is_a_current_problem(status_lab, error, next_run, expected):
    ctx, db = status_lab
    state = await db.get(PingMonitorState, 1)
    state.error, state.next_run_at = error, next_run
    await db.commit()

    overview = await tools_status.lab_status_overview(ctx)
    problems = await tools_status.list_current_problems(ctx)
    assert overview.data["monitor"]["status"] == expected
    assert any(row["kind"] == "monitor_" + expected for row in problems.data["problems"])


async def test_recent_device_api_error_is_medium_and_diagnostic_is_preserved(status_lab):
    ctx, db = status_lab
    device = pdu()
    db.add_all([
        device, snapshot(device, reachable=False),
        MonitorDeviceError(device_id=device.id, checked_at=NOW - 10, detail="Device API request timeout"),
    ])
    await db.commit()

    result = await tools_status.list_current_problems(ctx)
    matching = [row for row in result.data["problems"] if row["entity"]["id"] == device.id]
    assert any(row["severity"] == "medium" and "timeout" in row["detail"].casefold() for row in matching)


async def test_history_caps_window_keeps_overlapping_incident_and_labels_only_cooccurrence(status_lab):
    ctx, db = status_lab
    ctx.settings.email_alerts_enabled = True
    server = target()
    device = pdu()
    db.add_all([server, device])
    await db.flush()
    db.add_all([
        PingIncident(target_id=server.id, host=server.host, first_failed_at=NOW - 91 * DAY,
                     last_failed_at=NOW - 500, ended_at=NOW - 400, failed_checks=10),
        PingIncident(target_id=server.id, host=server.host, first_failed_at=NOW - 92 * DAY,
                     last_failed_at=NOW - 91 * DAY, ended_at=NOW - 91 * DAY, end_reason="outside-window"),
        PingSample(target_id=server.id, host=server.host, checked_at=NOW - 700, status="down"),
        PingSample(target_id=server.id, host=server.host, checked_at=NOW - 300, status="up", rtt_ms=2.0),
        PduMaintenanceLog(at=NOW - 600, device_id=device.id, action="shutdown", by="Fixture Operator"),
        PduMaintenanceLog(at=NOW - 91 * DAY, device_id=device.id, action="restore", by="outside-window"),
        AlertEmail(id="email-test", condition_key="network:" + server.id, created_at=NOW - 550,
                   recipient="recipient@example.invalid", subject="Fixture alert subject", body="forbidden-body",
                   next_attempt_at=NOW - 550, sent_at=NOW - 540),
    ])
    await db.commit()
    write_json(ctx, "rack_items.json", {"Rack-Inventory": [{
        "id": "item-84", "type": "computer", "name": "Opt84", "tracking_history": [
            {"at": iso(NOW - 575), "action": "move", "from": {"rack": "Rack-A"}, "to": {"rack": "Rack-B"}},
            {"at": iso(NOW - 91 * DAY), "action": "outside-window"},
        ],
    }]})

    result = await tools_status.get_history(ctx, since_hours=99999)
    assert result.data["since_hours"] == 2160
    assert result.data["since_iso"] == iso(NOW - 90 * DAY)
    assert result.data["until_iso"] == iso(NOW)
    items = result.data["items"]
    assert items
    stamps = [item["at_iso"] for item in items]
    assert stamps in (sorted(stamps), sorted(stamps, reverse=True))
    assert any("incident" in item["kind"] for item in items)
    assert any("maintenance" in item["kind"] for item in items)
    assert result.data["ping_samples_summary"]
    ids = {item["id"] for item in items}
    assert any(item["co_occurred_with"] for item in items)
    for item in items:
        assert set(item["co_occurred_with"]) <= ids - {item["id"]}
    serialised = json.dumps(result.to_dict())
    assert "outside-window" not in serialised
    assert "Fixture alert subject" in serialised
    assert "recipient@example.invalid" not in serialised and "forbidden-body" not in serialised
    assert not any(key in item for item in items for key in ("caused_by", "causes", "root_cause"))


async def test_disabled_alerts_do_not_expose_stored_conditions_or_email_history(status_lab):
    ctx, db = status_lab
    db.add_all([
        AlertCondition(key="network:old", configuration="{}", started_at=NOW - 60, checked_at=NOW - 10),
        AlertEmail(id="disabled-email", condition_key="network:old", created_at=NOW - 30,
                   recipient="recipient@example.invalid", subject="Disabled stored email marker", body="body marker",
                   next_attempt_at=NOW - 30),
    ])
    await db.commit()

    problems = await tools_status.list_current_problems(ctx)
    history = await tools_status.get_history(ctx)
    assert problems.data["problems"] == []
    assert "Disabled stored email marker" not in json.dumps(history.to_dict())
    assert "alert" in " ".join(history.caveats).casefold()


@pytest.mark.parametrize("filters", [{"server": "opt84"}, {"device_id": "pdu-a"}])
async def test_history_filters_incidents_samples_maintenance_and_alerts_by_known_links(status_lab, filters):
    ctx, db = status_lab
    ctx.settings.email_alerts_enabled = True
    first, second = target(), target("target-85", name="Opt85", key="server:opt85", host="192.0.2.85")
    db.add_all([first, second, pdu("pdu-a"), pdu("pdu-b", label="Opt85")])
    await db.flush()
    for server, device_id in ((first, "pdu-a"), (second, "pdu-b")):
        db.add_all([
            PingIncident(target_id=server.id, host=server.host, first_failed_at=NOW - 600,
                         last_failed_at=NOW - 500, ended_at=NOW - 400),
            PingSample(target_id=server.id, host=server.host, checked_at=NOW - 500, status="down"),
            PduMaintenanceLog(at=NOW - 550, device_id=device_id, action="shutdown", by="Fixture Operator"),
            AlertEmail(id="network-" + server.id, condition_key="network:" + server.id, created_at=NOW - 500,
                       recipient="recipient@example.invalid", subject="Network " + server.id, body="Excluded body",
                       next_attempt_at=NOW - 500),
            AlertEmail(id="power-" + device_id, condition_key="power:" + device_id + ":1:watts:max", created_at=NOW - 450,
                       recipient="recipient@example.invalid", subject="Power " + device_id, body="Excluded body",
                       next_attempt_at=NOW - 450),
        ])
    await db.commit()

    result = await tools_status.get_history(ctx, **filters)
    serialised = json.dumps(result.to_dict())
    assert "target-84" in serialised and "pdu-a" in serialised
    assert "target-85" not in serialised and "pdu-b" not in serialised
    assert {row["target_id"] for row in result.data["ping_samples_summary"]} == {first.id}
    assert {row["kind"] for row in result.data["items"]} >= {"ping_incident", "pdu_maintenance", "alert_email"}


async def test_history_limit_keeps_newest_event_across_sources(status_lab):
    ctx, db = status_lab
    ctx.settings.email_alerts_enabled = True
    db.add_all([
        PduMaintenanceLog(at=NOW - 10, device_id="pdu-test", action="shutdown", by="Fixture Operator"),
        AlertEmail(id="newest-event", condition_key="device-api:pdu-test", created_at=NOW - 5,
                   recipient="recipient@example.invalid", subject="Newest subject", body="Excluded body",
                   next_attempt_at=NOW - 5),
    ])
    await db.commit()

    result = await tools_status.get_history(ctx, limit=1)
    assert len(result.data["items"]) == 1
    assert result.data["items"][0]["subject"] == "Newest subject"
    assert result.data["items"][0]["at_iso"] == iso(NOW - 5)
    assert result.data["items"][0]["co_occurred_with"] == []
    assert result.data["truncated"] is True and result.data["limit"] == 1


async def test_email_sent_in_window_is_included_even_when_created_before_window(status_lab):
    ctx, db = status_lab
    ctx.settings.email_alerts_enabled = True
    db.add(AlertEmail(
        id="delayed-email", condition_key="device-api:pdu-test", created_at=NOW - 2 * DAY,
        recipient="recipient@example.invalid", subject="Delayed delivery subject", body="Excluded body",
        next_attempt_at=NOW - 2 * DAY, sent_at=NOW - 10,
    ))
    await db.commit()

    result = await tools_status.get_history(ctx, since_hours=1)
    event = next(row for row in result.data["items"] if row["kind"] == "alert_email")
    assert event["subject"] == "Delayed delivery subject"
    assert event["at_iso"] == event["sent_at"] == iso(NOW - 10)
    assert event["created_at"] == iso(NOW - 2 * DAY)
    assert "Excluded body" not in json.dumps(result.to_dict())


async def test_limit_is_applied_after_total_problem_count(status_lab):
    ctx, db = status_lab
    db.add_all([target("fault-" + str(index), name="Opt" + str(index), key="server:opt" + str(index), status="error")
                for index in range(3)])
    await db.commit()

    result = await tools_status.list_current_problems(ctx, limit=1)
    assert len(result.data["problems"]) == 1
    assert result.data["total"] == 3
    assert result.data["limit"] == 1 and result.data["truncated"] is True
    assert result.data["problems"][0]["severity"] == "unknown"


async def test_all_tools_exclude_credentials_emails_and_sanitise_untrusted_text(status_lab):
    ctx, db = status_lab
    ctx.settings.email_alerts_enabled = True
    device = pdu(
        username_enc="encrypted-user-marker", password_enc="encrypted-password-marker",
        name="Fixture PDU\x00" + "x" * 400,
        notes="password=note-secret-marker\nowner@example.invalid",
    )
    db.add_all([
        target(status="error", detail="password=target-secret-marker\r\n" + "x" * 400),
        device, snapshot(device, reachable=False),
        MonitorDeviceError(device_id=device.id, checked_at=NOW - 10,
                           detail="token=diagnostic-secret-marker\tcontact owner@example.invalid"),
        PduMaintenance(device_id=device.id, started_at=NOW - 600, started_by="owner@example.invalid",
                       reason="password=maintenance-secret-marker\n" + "x" * 400),
        PduMaintenanceLog(at=NOW - 500, device_id=device.id, action="shutdown", by="owner@example.invalid",
                          reason="password=log-secret-marker"),
        AlertEmail(id="secret-email", condition_key="network:target-84", created_at=NOW - 400,
                   recipient="recipient@example.invalid", subject="password=subject-secret-marker\x00owner@example.invalid",
                   body="forbidden-email-body-marker", next_attempt_at=NOW - 400),
    ])
    await db.commit()
    write_json(ctx, "opt_owners.json", {"opt84": "Fixture Owner owner@example.invalid"})

    results = [
        await tools_status.lab_status_overview(ctx),
        await tools_status.list_current_problems(ctx),
        await tools_status.get_server_status(ctx, server="opt84"),
        await tools_status.get_history(ctx),
    ]
    for result in results:
        assert_json_safe(result)
        serialised = json.dumps(result.to_dict()).casefold()
        for forbidden in (
            "encrypted-user-marker", "encrypted-password-marker", "note-secret-marker",
            "target-secret-marker", "diagnostic-secret-marker", "maintenance-secret-marker",
            "log-secret-marker", "subject-secret-marker", "forbidden-email-body-marker", "@example.invalid",
            "username_enc", "password_enc",
        ):
            assert forbidden not in serialised


async def test_operational_error_becomes_unavailable_source_without_exception_details(status_lab):
    ctx, _ = status_lab

    class UnavailableSession:
        async def __aenter__(self):
            raise OperationalError("private-query-marker", {}, Exception("private-db-error-marker"))

        async def __aexit__(self, *args):
            return False

    ctx.session_factory = UnavailableSession
    result = await tools_status.lab_status_overview(ctx)
    assert any(source.status == "unavailable" for source in result.sources)
    serialised = json.dumps(result.to_dict())
    assert "private-query-marker" not in serialised and "private-db-error-marker" not in serialised
    assert result.data["data_files"]["rack_items.json"] == "ok"


@pytest.mark.parametrize("name,args", [
    ("lab_status_overview", {}), ("list_current_problems", {}),
    ("get_server_status", {"server": "opt84"}), ("get_history", {}),
])
async def test_direct_tool_calls_reject_principals_without_viewer_permission(status_lab, name, args):
    ctx, _ = status_lab
    ctx.principal = Principal(user_id="denied-test", username="denied", role="NoAccess")

    def forbidden_session():
        raise AssertionError("A rejected principal must not open a database session")

    ctx.session_factory = forbidden_session
    with pytest.raises(ToolError, match="Viewer"):
        await getattr(tools_status, name)(ctx, **args)


async def test_tools_are_viewer_read_only_and_do_not_contact_hardware(status_lab, monkeypatch):
    ctx, _ = status_lab
    from app import ping_monitor
    from app.routers import kvm_proxy, kvms, pdus

    forbidden_calls = []
    for module, name in (
        (pdus, "_fetch_status"), (kvms, "_fetch_status"),
        (ping_monitor, "discover_targets"), (kvm_proxy, "ensure_session"), (kvms, "ensure_session"),
    ):
        forbidden = AsyncMock(side_effect=AssertionError("Hardware access is forbidden"))
        monkeypatch.setattr(module, name, forbidden)
        forbidden_calls.append(forbidden)
    assert {tool.name for tool in tools_status.TOOLS} == {
        "lab_status_overview", "list_current_problems", "get_server_status", "get_history",
    }
    for tool in tools_status.TOOLS:
        assert tool.required_role == "Viewer"
        assert tool.description.strip()
        assert tool.input_schema["type"] == "object"
        assert tool.input_schema["additionalProperties"] is False
    for call in (
        tools_status.lab_status_overview(ctx), tools_status.list_current_problems(ctx),
        tools_status.get_server_status(ctx, server="missing-server"), tools_status.get_history(ctx),
    ):
        assert_json_safe(await call)
    assert all(call.await_count == 0 for call in forbidden_calls)


async def test_every_tool_uses_only_explicit_public_settings_and_never_serialises_secrets(status_lab):
    ctx, db = status_lab
    device = pdu()
    db.add_all([target(), device, snapshot(device)])
    await db.commit()
    secret_names = (
        "pdu_password", "kvm_password", "lab_manager_master_key", "lab_manager_password",
        "smtp_password", "email_alerts_to", "assistant_anthropic_api_key",
    )
    secrets = {name: "settings-secret-marker-" + str(index) for index, name in enumerate(secret_names)}
    public = {
        "ping_monitor_enabled": True, "email_alerts_enabled": True, "pxe_enabled": True,
        "accounts_enabled": True, "ping_monitor_timezone": "UTC",
    }

    class GuardedSettings:
        __slots__ = ("_values",)

        def __init__(self):
            object.__setattr__(self, "_values", {**public, **secrets})

        def __getattribute__(self, name):
            if name in public:
                return object.__getattribute__(self, "_values")[name]
            raise AssertionError("Settings may be read only by explicit public attribute names")

        def __dir__(self):
            raise AssertionError("Settings enumeration is forbidden")

        def __iter__(self):
            raise AssertionError("Settings serialization is forbidden")

        def __repr__(self):
            raise AssertionError("Settings serialization is forbidden")

        __str__ = __repr__

    ctx.settings = GuardedSettings()
    results = [
        await tools_status.lab_status_overview(ctx),
        await tools_status.list_current_problems(ctx),
        await tools_status.get_server_status(ctx, server="opt84"),
        await tools_status.get_history(ctx),
    ]
    for result in results:
        assert_json_safe(result)
        serialised = json.dumps(result.to_dict())
        assert all(marker not in serialised for marker in secrets.values())


@pytest.mark.parametrize("name,args,key,expected", [
    ("list_current_problems", {"limit": -9}, "limit", 1),
    ("list_current_problems", {"limit": 0}, "limit", 1),
    ("list_current_problems", {"limit": 99999}, "limit", 200),
    ("get_history", {"limit": -9}, "limit", 1),
    ("get_history", {"limit": 0}, "limit", 1),
    ("get_history", {"limit": 99999}, "limit", 200),
    ("get_history", {"since_hours": -9}, "since_hours", 1),
    ("get_history", {"since_hours": 0}, "since_hours", 1),
    ("get_history", {"since_hours": 99999}, "since_hours", 2160),
])
async def test_numeric_arguments_are_clamped_in_code(status_lab, name, args, key, expected):
    ctx, _ = status_lab
    result = await getattr(tools_status, name)(ctx, **args)
    assert result.data[key] == expected


@pytest.mark.parametrize("name,argument", [
    ("list_current_problems", "limit"), ("get_history", "limit"), ("get_history", "since_hours"),
])
@pytest.mark.parametrize("value", [True, False, 1.5, "2", None])
async def test_numeric_arguments_reject_booleans_and_nonintegers(status_lab, name, argument, value):
    ctx, _ = status_lab
    with pytest.raises(ToolError):
        await getattr(tools_status, name)(ctx, **{argument: value})


async def test_user_string_arguments_are_sanitised_and_capped_before_resolution_or_query(status_lab):
    ctx, db = status_lab
    server_id, device_id = "s" * 120, "d" * 120
    server = target(server_id)
    device = pdu(device_id)
    db.add_all([server, device, snapshot(device)])
    await db.flush()
    db.add_all([
        PingSample(target_id=server_id, host=server.host, checked_at=NOW - 20, status="up"),
        PduMaintenanceLog(at=NOW - 10, device_id=device_id, action="shutdown", by="Fixture Operator"),
    ])
    await db.commit()
    dirty_server = "\u200f" + server_id[:60] + "\x00" + server_id[60:] + "\u202eignored-suffix"
    dirty_device = "\u200e" + device_id[:60] + "\u2066" + device_id[60:] + "\u2069ignored-suffix"

    status = await tools_status.get_server_status(ctx, server=dirty_server)
    by_server = await tools_status.get_history(ctx, server=dirty_server)
    by_device = await tools_status.get_history(ctx, device_id=dirty_device)
    assert status.data["status"] == "found" and status.data["server"]["id"] == server_id
    assert {row["target_id"] for row in by_server.data["ping_samples_summary"]} == {server_id}
    assert any(row.get("device_id") == device_id for row in by_device.data["items"])
    for result in (status, by_server, by_device):
        assert "ignored-suffix" not in json.dumps(result.to_dict())
        assert_json_safe(result)


async def test_sql_projections_exclude_credentials_and_history_aggregates_all_samples(status_lab):
    ctx, db = status_lab
    ctx.settings.email_alerts_enabled = True
    server, device = target(), pdu(username_enc="sql-user-secret", password_enc="sql-password-secret")
    db.add_all([server, device, snapshot(device)])
    await db.flush()
    db.add_all([PingSample(target_id=server.id, host=server.host, checked_at=NOW - offset, status="up")
                for offset in range(1, 32)])
    db.add(AlertEmail(
        id="projection-email", condition_key="network:" + server.id, created_at=NOW - 10,
        recipient="projection@example.invalid", subject="Projection-safe subject", body="sql-body-secret",
        next_attempt_at=NOW - 10,
    ))
    await db.commit()
    selects = []

    def capture(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().lower().startswith("select"):
            selects.append((statement.lower(), context.compiled.statement))

    engine = db.bind.sync_engine
    event.listen(engine, "before_cursor_execute", capture)
    try:
        await tools_status.lab_status_overview(ctx)
        await tools_status.list_current_problems(ctx)
        status = await tools_status.get_server_status(ctx, server="opt84")
        history = await tools_status.get_history(ctx)
    finally:
        event.remove(engine, "before_cursor_execute", capture)

    assert len(status.data["samples"]) == 20
    assert sum(row["count"] for row in history.data["ping_samples_summary"]) == 31
    assert any("from devices" in sql for sql, _ in selects)
    assert any("from alert_emails" in sql for sql, _ in selects)
    device_columns = {"id", "name", "kind", "model", "ip", "rack", "port_count", "notes", "enabled", "labels_json"}
    email_columns = {"subject", "created_at", "sent_at"}
    for sql, query in selects:
        assert not any(forbidden in sql for forbidden in (
            "username_enc", "password_enc", "alert_emails.body", "alert_emails.recipient",
            "alert_emails.error", "alert_conditions.configuration", "from users", "from user_sessions", "from auth_throttles",
        ))
        for column in query.selected_columns:
            table = getattr(getattr(column, "table", None), "name", None)
            if table == "devices":
                assert column.name in device_columns
            elif table == "alert_emails":
                assert column.name in email_columns
        if "from ping_samples" in sql and "group by" not in sql:
            assert query._limit_clause is not None and query._limit_clause.value <= 20
    module_ast = ast.parse(Path(tools_status.__file__).read_text(encoding="utf-8"))
    imported = [alias.name for node in ast.walk(module_ast) if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names]
    assert not {"User", "UserSession", "AuthThrottle", "get_runner"} & set(imported)
    assert not any("pxe.runner" in name for name in imported)


async def test_every_result_removes_explicit_bidi_formatting_characters(status_lab):
    ctx, db = status_lab
    ctx.settings.email_alerts_enabled = True
    bidi = "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
    device = pdu(name="PDU" + bidi + "Label")
    db.add_all([
        target(detail="Observation" + bidi + "detail", status="error"), device, snapshot(device),
        PduMaintenance(device_id=device.id, started_at=NOW - 600, started_by="Operator" + bidi,
                       reason="Maintenance" + bidi + "reason"),
        PduMaintenanceLog(at=NOW - 500, device_id=device.id, action="shutdown", by="Operator" + bidi),
        AlertEmail(id="bidi-email", condition_key="network:target-84", created_at=NOW - 400,
                   recipient="recipient@example.invalid", subject="Alert" + bidi + "subject", body="Excluded",
                   next_attempt_at=NOW - 400),
    ])
    await db.commit()
    write_json(ctx, "rack_overrides.json", {"opt84": "Rack" + bidi + "A"})
    write_json(ctx, "switch_assignments.json", {"opt84": {"switch": "Switch" + bidi + "A", "port": "1"}})
    write_json(ctx, "opt_owners.json", {"opt84": "Fixture" + bidi + "Owner"})
    results = [
        await tools_status.lab_status_overview(ctx), await tools_status.list_current_problems(ctx),
        await tools_status.get_server_status(ctx, server="opt84"), await tools_status.get_history(ctx),
    ]
    for result in results:
        assert_json_safe(result)
        rendered = json.dumps(result.to_dict(), ensure_ascii=False)
        assert not any(char in rendered for char in bidi)


async def test_large_results_cap_every_list_and_surface_truncation(status_lab):
    ctx, db = status_lab
    count = 205
    servers = [target("candidate-" + str(index), name="Shared Name", key="manual:" + str(index), status="error")
               for index in range(count)]
    devices = [pdu("pdu-" + str(index), rack="Rack-" + str(index)) for index in range(count)]
    db.add_all([target(), *servers, *devices, *(snapshot(device) for device in devices)])
    await db.flush()
    for index, device in enumerate(devices):
        db.add_all([
            PduMaintenance(device_id=device.id, started_at=NOW - 600, started_by="Fixture Operator",
                           outlets_off_json=json.dumps(list(range(1, 206))) if index == 0 else "[1]"),
            PduMaintenanceLog(at=NOW - DAY - index - 1, device_id=device.id, action="shutdown", by="Fixture Operator"),
            PingSample(target_id=servers[index].id, host=servers[index].host, checked_at=NOW - 20, status="up"),
            PingSample(target_id=servers[index].id, host=servers[index].host, checked_at=NOW - 10, status="up"),
        ])
    await db.commit()
    keys = ["opt84 (" + str(index) + ")" for index in range(count)]
    write_json(ctx, "rack_overrides.json", {key: "Saved-Rack-" + str(index) for index, key in enumerate(keys)})
    write_json(ctx, "switch_assignments.json", {key: {"switch": "Switch-" + str(index), "port": str(index)}
                                               for index, key in enumerate(keys)})
    write_json(ctx, "opt_owners.json", {key: "Owner-" + str(index) for index, key in enumerate(keys)})

    overview = await tools_status.lab_status_overview(ctx)
    problems = await tools_status.list_current_problems(ctx, limit=200)
    candidates = await tools_status.get_server_status(ctx, server="Shared Name")
    status = await tools_status.get_server_status(ctx, server="opt84")
    history = await tools_status.get_history(ctx, limit=200)
    summary_only = await tools_status.get_history(ctx, since_hours=1, limit=200)
    assert len(overview.data["devices"]) == len(overview.data["maintenance"]) == 200
    assert len(problems.data["problems"]) == 200 and problems.data["total"] > 200
    assert candidates.data["status"] == "ambiguous" and len(candidates.data["candidates"]) == 200
    for field in ("pdu", "maintenance", "rack_candidates", "owner_names", "switch_assignments"):
        assert len(status.data[field]) == 200
    assert len(history.data["items"]) == len(history.data["ping_samples_summary"]) == 200
    assert all(row["count"] == 2 for row in history.data["ping_samples_summary"])
    assert summary_only.data["items"] == [] and len(summary_only.data["ping_samples_summary"]) == 200
    for result in (overview, problems, candidates, status, history, summary_only):
        assert result.data["truncated"] is True
        assert_json_safe(result)


async def test_nested_list_clipping_sets_root_truncation_even_with_one_record(status_lab):
    ctx, db = status_lab
    device = pdu()
    db.add_all([
        device, snapshot(device),
        PduMaintenance(device_id=device.id, started_at=NOW - 600, started_by="Fixture Operator",
                       outlets_off_json=json.dumps(list(range(1, 206)))),
    ])
    await db.commit()

    result = await tools_status.lab_status_overview(ctx)
    assert len(result.data["maintenance"]) == 1
    assert len(result.data["maintenance"][0]["outlets_off"]) == 200
    assert result.data["truncated"] is True
    assert_json_safe(result)
