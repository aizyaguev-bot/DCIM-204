"""Analysis tools: impact, capacity, correlation and priority.

Pure functions are tested with fixture dicts shaped like the real tools_status / tools_layout output; the wrappers are
tested with fake data-tool modules (call counts, merged sources, failures) and once end to end against the real data
tools on an in-memory database with seeded secrets. No device, network or LLM is ever contacted.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
import json
import sys
import time
import types
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.assistant import analysis
from app.assistant.contracts import ROLE_ORDER, Principal, Source, ToolContext, ToolError, ToolResult, ToolSpec, iso

NOW = 1_792_000_000.0          # fixed epoch for the pure-function tests
MIN = 60
DAY = 24 * 3600


def viewer_ctx(now=NOW, settings=None, session_factory=None):
    return ToolContext(principal=Principal(user_id="u-1", username="viewer", role="Viewer"),
                       session_factory=session_factory, settings=settings, now=now)


def connection(device_id, server_key, port, state="on", kind="pdu"):
    return {"kind": kind, "device_id": device_id, "device_name": device_id.upper(), "server_key": server_key,
            "label": server_key.capitalize(), "port": str(port), "state": state, "status_source": None,
            "missing": False, "stale": False, "checked_at": iso(NOW - 30)}


def pdu_dependencies(device_id="pdu-a", servers=("opt11", "opt12", "opt13"), redundancy_hint=None):
    """Shaped like tools_layout.get_dependencies(kind="pdu") output (host/aliases included, as the real tool does)."""
    rows = []
    for port, key in enumerate(servers, 1):
        conn = connection(device_id, key, port)
        rows.append({"id": key, "server_key": key, "label": key.capitalize(), "aliases": [key],
                     "rack_candidates": [{"rack": "Rack-01", "source": "pdu", "priority": 1}],
                     "host": "198.51.100.9", "rack": "Rack-01", "rack_conflict": False, "port": str(port),
                     "connection": conn})
    return {"entity": {"kind": "pdu", "id": device_id}, "servers": rows,
            "connections": [r["connection"] for r in rows], "pdus": [], "kvms": [], "items": [],
            "redundancy_hint": redundancy_hint, "found": True}


def index(feeds):
    """connection_index-shaped dict: feeds = {server_key: [(device_id, port, status), ...]}."""
    result = {}
    for key, rows in feeds.items():
        result["server:" + key] = {"pdu": [{"device_id": d, "device_name": d.upper(), "device_ip": "198.51.100.1",
                                            "port": str(p), "status": s, "detail": "", "checked_at": iso(NOW - 30),
                                            "device_reachable": True} for d, p, s in rows], "kvm": []}
    return result


def problem(kind, severity, entity_kind, entity_id, label, source_id="ping_targets", **extra):
    return {"kind": kind, "severity": severity, "entity": {"kind": entity_kind, "id": entity_id, "label": label},
            "since_iso": iso(NOW - 600), "last_seen_iso": iso(NOW - 30), "detail": "x", "source_id": source_id, **extra}


DOWN_OPT11 = problem("ping_down", "high", "server", "t-11", "Opt11", related_source_ids=["ping_incidents"],
                     incident_ids=[7])


# ----------------------------------------------------------------------------------------------------------------
# Impact
# ----------------------------------------------------------------------------------------------------------------
def test_impact_of_pdu_feeding_three_servers_with_one_down():
    topology = analysis.build_topology(index({k: [("pdu-a", n, "on")] for n, k in
                                              enumerate(("opt11", "opt12", "opt13"), 1)}))
    data = analysis.analyze_impact_data("pdu", "pdu-a", pdu_dependencies(),
                                        analysis.normalize_problems({"problems": [DOWN_OPT11]}), topology,
                                        dependency_source_ids=["devices"], problem_source_ids=["ping_targets"],
                                        topology_source_ids=[analysis.TOPOLOGY_SOURCE_ID])

    assert data["counts"]["affected"] == 3
    assert data["counts"]["down"] == 1 and data["counts"]["not_reported"] == 2
    assert [r["id"] for r in data["ranked"]][0] == "opt11"
    top = data["ranked"][0]
    assert top["status"] == "down" and top["status_source"] == "list_current_problems"
    assert {"ping_targets", "ping_incidents", analysis.TOPOLOGY_SOURCE_ID} <= set(top["source_ids"])
    assert all(r["redundancy"] == "none_known" for r in data["ranked"])
    # severity 40 (high problem) + scope 3*5 + service 0 - redundancy 0
    assert data["impact"]["score"] == 55 and data["impact"]["priority"] == "medium"
    assert data["impact"]["components"] == {"severity": 40, "scope": 15, "service": 0, "redundancy": 0}
    assert any(reason.startswith("חומרה") for reason in data["impact"]["reasons"])
    assert data["formula"] == analysis.PRIORITY_FORMULA
    # Servers without a recorded problem are "not reported", never "up"/healthy.
    assert {r["status"] for r in data["ranked"][1:]} == {"not_reported"}


def test_possible_redundancy_lowers_priority_and_is_never_certain():
    unreachable = analysis.normalize_problems({"problems": [
        problem("device_unreachable", "medium", "pdu", "pdu-a", "PDU A", "monitor_device_snapshots")]})
    single = analysis.build_topology(index({"opt11": [("pdu-a", 1, "on")], "opt12": [("pdu-a", 2, "on")],
                                            "opt13": [("pdu-a", 3, "on")]}))
    some = analysis.build_topology(index({"opt11": [("pdu-a", 1, "on"), ("pdu-b", 4, "on")],
                                          "opt12": [("pdu-a", 2, "on")], "opt13": [("pdu-a", 3, "on")]}))
    every = analysis.build_topology(index({k: [("pdu-a", 1, "on"), ("pdu-b", 9, "on")]
                                           for k in ("opt11", "opt12", "opt13")}))
    scores = [analysis.analyze_impact_data("pdu", "pdu-a", pdu_dependencies(), unreachable, t)["impact"]["score"]
              for t in (single, some, every)]
    assert scores == [40, 33, 25]                       # 25 + 15 - 0 / 7 / 15
    data = analysis.analyze_impact_data("pdu", "pdu-a", pdu_dependencies(), unreachable, every)
    assert {r["redundancy"] for r in data["ranked"]} == {"possible"}
    assert "לא מאומת" in " ".join(data["impact"]["reasons"])
    assert "לא אומתה" in data["redundancy_note"]
    # A server that is down now is never "protected": only 2 of 3 count, and its own score gets no discount.
    with_down = analysis.analyze_impact_data("pdu", "pdu-a", pdu_dependencies(),
                                             analysis.normalize_problems({"problems": [DOWN_OPT11]}), every)
    assert with_down["impact"]["components"]["redundancy"] == -analysis.REDUNDANCY_SOME_POINTS
    top = with_down["ranked"][0]
    assert top["id"] == "opt11" and top["redundancy"] == "possible" and top["score"] == 45
    assert any("אינו זמין כעת" in r for r in top["reasons"])


def test_two_outlets_on_the_same_pdu_are_not_redundancy_against_that_pdu():
    deps = pdu_dependencies(servers=("opt11", "opt11"), redundancy_hint="possible redundant feed — not verified")
    topology = analysis.build_topology(index({"opt11": [("pdu-a", 1, "on"), ("pdu-a", 2, "on")]}))
    data = analysis.analyze_impact_data("pdu", "pdu-a", deps, [], topology)
    assert data["counts"]["affected"] == 1
    assert data["ranked"][0]["redundancy"] == "none_known"
    assert data["impact"]["components"]["redundancy"] == 0


def test_registered_owner_counts_as_service_impact_and_outlet_off_is_only_a_hypothesis():
    topology = analysis.build_topology(index({"opt11": [("pdu-a", 1, "on")], "opt12": [("pdu-a", 2, "off")],
                                              "opt13": [("pdu-a", 3, "on")]}),
                                       [("Opt12 (2)", "Dana"), ("item:abc", "Item Owner"), ("opt13", "")])
    data = analysis.analyze_impact_data("pdu", "pdu-a", pdu_dependencies(), [], topology)
    by_id = {r["id"]: r for r in data["ranked"]}
    assert by_id["opt12"]["in_use"] is True
    assert by_id["opt13"]["in_use"] is None and by_id["opt11"]["in_use"] is None   # unknown, never False
    assert data["impact"]["components"]["service"] == analysis.SERVICE_POINTS
    assert any(reason.startswith("השערה") for reason in by_id["opt12"]["reasons"])
    assert not any(reason.startswith("השערה") for reason in by_id["opt11"]["reasons"])


def test_kvm_scope_has_half_weight_and_switch_redundancy_is_unknown():
    deps = {"entity": {"kind": "kvm", "id": "kvm-a"}, "servers": [
        {"id": "opt11", "server_key": "opt11", "label": "Opt11", "port": "1",
         "connection": connection("kvm-a", "opt11", 1, kind="kvm")},
        {"id": "opt12", "server_key": "opt12", "label": "Opt12", "port": "2",
         "connection": connection("kvm-a", "opt12", 2, kind="kvm")}], "found": True}
    data = analysis.analyze_impact_data("kvm", "kvm-a", deps, [])
    assert data["impact"]["components"]["scope"] == 5            # 2 servers * 5 * 0.5
    assert data["effect"] == "console"
    switch = {"entity": {"kind": "switch", "id": "sw-1"}, "servers": [{"server_key": "opt11", "label": "Opt11"}],
              "connections": [{"kind": "switch", "server_key": "opt11", "switch": "sw-1", "port": "7"}]}
    data = analysis.analyze_impact_data("switch", "sw-1", switch, [], None)
    assert data["ranked"][0]["redundancy"] == "unknown"
    assert data["ranked"][0]["via"] == ["sw-1 port 7"]
    assert data["ranked"][0]["status"] == "not_reported"
    assert any("לא היו זמינים" in note for note in data["notes"])   # topology unavailable is said explicitly


def test_server_target_uses_its_status_and_no_problem_list_means_no_data():
    deps = {"entity": {"kind": "server", "id": "optn84"}, "servers": [
        {"id": "optn84", "server_key": "optn84", "label": "Optn84"}],
        "connections": [connection("pdu-a", "optn84", 1), connection("pdu-b", "optn84", 2)],
        "redundancy_hint": None, "found": True}
    status = {"status": "found", "server": {"id": "t-84", "key": "optn84", "label": "Optn84"},
              "icmp": {"status": "up"}, "pdu": [{"device_id": "pdu-a"}, {"device_id": "pdu-b"}],
              "owner_names": ["Dana"]}
    data = analysis.analyze_impact_data("server", "Optn84 (2)", deps, [], None, status, status_source_ids=["ping_targets"])
    row = data["ranked"][0]
    assert row["status"] == "up" and row["in_use"] is True and row["redundancy"] == "possible"
    assert data["impact"]["components"]["redundancy"] == 0       # no discount for a server's own outage
    assert data["ranked"][0]["via"] == ["PDU-A outlet 1", "PDU-B outlet 2"]
    unknown = analysis.analyze_impact_data("server", "optn84", deps, None, None, None)
    assert unknown["ranked"][0]["status"] == "no_data"
    ambiguous = analysis.analyze_impact_data("server", "opt", deps, [], None, {"status": "ambiguous", "candidates": []})
    assert any("חד-ערכי" in note for note in ambiguous["notes"])


def test_item_impact_lists_the_item_and_the_server_it_is():
    deps = {"entity": {"kind": "item", "id": "item-7"}, "servers": [{"id": "opt20", "server_key": "opt20",
                                                                      "label": "Opt20", "host": "198.51.100.20"}],
            "connections": [connection("pdu-a", "opt20", 5)],
            "items": [{"id": "item-7", "name": "Opt20", "type": "computer", "u": 3, "rack": "Rack-01"}], "found": True}
    data = analysis.analyze_impact_data("item", "item-7", deps, [], None)
    assert data["effect"] == "equipment item" and [r["id"] for r in data["ranked"]] == ["opt20"]
    assert data["affected_items"] == [{"kind": "item", "id": "item-7", "label": "Opt20", "type": "computer"}]
    assert "198.51.100.20" not in json.dumps(data)


def test_device_problems_attach_to_the_target_not_to_servers():
    problems = analysis.normalize_problems({"problems": [
        problem("device_unreachable", "medium", "pdu", "pdu-a", "PDU A", "monitor_device_snapshots"),
        problem("outlet_off", "medium", "pdu", "pdu-a", "PDU A", "monitor_device_snapshots", outlet="2"),
        problem("alert_condition", "medium", "incident", "power:pdu-a:1:current:max", "power:pdu-a:1:current:max",
                "alert_conditions"),
        problem("device_unreachable", "medium", "pdu", "pdu-z", "PDU Z", "monitor_device_snapshots")]})
    data = analysis.analyze_impact_data("pdu", "pdu-a", pdu_dependencies(), problems, None)
    assert {p["kind"] for p in data["target_problems"]} == {"device_unreachable", "outlet_off", "alert_condition"}
    by_id = {r["id"]: r for r in data["ranked"]}
    assert any(reason.startswith("השערה") for reason in by_id["opt12"]["reasons"])   # outlet 2 reported off


# ----------------------------------------------------------------------------------------------------------------
# Capacity
# ----------------------------------------------------------------------------------------------------------------
def power_entry(pdu_id, *, rack="Rack-01", shared_racks=(), total=None, complete=False, inlets=(), stale=False,
                age_s=60.0, temperature=None, outlets=()):
    """Shaped like one tools_layout.get_power_and_environment entry (ip included, as the real tool does)."""
    return {"id": pdu_id, "name": pdu_id.upper(), "kind": "pdu", "model": "", "ip": "198.51.100.40", "rack": rack,
            "port_count": 8, "enabled": True, "shared_racks": list(shared_racks), "outlets": list(outlets),
            "checked_at": iso(NOW - 60), "reachable": True, "snapshot_stale": False, "total_watts": total,
            "watts_complete": complete, "inlet_voltage": None, "inlet_readings": list(inlets),
            "temperature": temperature, "humidity": None, "leak_detected": None, "cache_as_of": iso(NOW - age_s),
            "cache_age_s": age_s, "stale": stale, "cache_reachable": True}


def inlet(current=None, voltage=None, watts=None, number=1):
    return {"number": number, "voltage": voltage, "current": current, "watts": watts}


def power_data(pdus, thresholds=(), chillers=()):
    return {"rack": "Rack-01", "pdu_id": None, "pdus": list(pdus), "totals": {}, "thresholds": list(thresholds),
            "capacity": {"assumption": "16 A / 208 V UI constant", "rated_amps_per_pdu": 16, "assumed_voltage": 208},
            "chillers": list(chillers)}


LAYOUT = {"rack": "Rack-01", "items": [], "servers": [], "shelf_count": 4, "mapping_confidence": "low",
          "free_shelves": [3, 4], "free_shelves_confidence": "low"}


def test_capacity_counts_a_shared_pdu_once_and_never_adds_totals_to_inlet_readings():
    pdus = [power_entry("pdu-a", total=900.0, complete=True, inlets=[inlet(4.8, 208.0, 1000.0)]),
            power_entry("pdu-a", total=900.0, complete=True, inlets=[inlet(4.8, 208.0, 1000.0)]),
            power_entry("pdu-b", rack="Rack-02", shared_racks=["Rack-01"], total=500.0, complete=True)]
    data = analysis.plan_capacity_data("Rack-01", layout=LAYOUT, power=power_data(pdus), power_w=300)
    power = data["dimensions"]["power"]
    assert [p["id"] for p in power["pdus"]] == ["pdu-a", "pdu-b"]
    assert power["pdus"][0]["load_w"] == 1000.0 and power["pdus"][0]["load_source"] == "inlet readings"
    assert power["pdus"][1]["shared"] is True
    assert power["rack_total_w"] == 1500.0 and power["rack_total_complete"] is True
    assert data["dimensions"]["redundancy"]["pdu_count"] == 2
    assert power["verdict"] == "ok"
    assert power["threshold_source"] == analysis.UI_POWER_ASSUMPTION
    assert analysis.UI_POWER_ASSUMPTION_HE in data["assumptions"]
    assert power["load_rule"] == analysis.LOAD_ASSUMPTION
    assert any("משותף" in r for r in power["pdus"][1]["reasons"])


def test_unknown_watts_give_unknown_power_never_ok():
    pdus = [power_entry("pdu-a", total=None, complete=False, inlets=[]),
            power_entry("pdu-b", total=400.0, complete=False, inlets=[inlet(None, 208.0, None)])]
    data = analysis.plan_capacity_data("Rack-01", layout=LAYOUT, power=power_data(pdus), power_w=200, units=1)
    power = data["dimensions"]["power"]
    assert [p["verdict"] for p in power["pdus"]] == ["unknown", "unknown"]
    assert power["verdict"] == "unknown"
    assert power["rack_total_w"] is None and power["rack_total_complete"] is False
    assert data["overall"] == "conditional"
    assert any("קריאות עומס" in m for m in data["missing_info"])


def test_stale_or_old_readings_are_unknown():
    stale = power_entry("pdu-a", total=100.0, complete=True, inlets=[inlet(0.5, 208.0, 100.0)], stale=True)
    old = power_entry("pdu-b", total=100.0, complete=True, inlets=[inlet(0.5, 208.0, 100.0)],
                      age_s=analysis.READING_FRESH_S + 1)
    data = analysis.plan_capacity_data("Rack-01", layout=LAYOUT, power=power_data([stale, old]), power_w=100)
    assert [p["verdict"] for p in data["dimensions"]["power"]["pdus"]] == ["unknown", "unknown"]
    assert data["dimensions"]["power"]["verdict"] == "unknown"


def test_no_temperature_means_cooling_unknown_with_missing_info():
    pdus = [power_entry("pdu-a", total=500.0, complete=True, inlets=[inlet(2.4, 208.0, 500.0)])]
    data = analysis.plan_capacity_data("Rack-01", layout=LAYOUT, power=power_data(pdus, chillers=[
        {"id": "ch-1", "name": "Chiller 1", "rack": "Rack-01", "u": None}]), power_w=100)
    cooling = data["dimensions"]["cooling"]
    assert cooling["verdict"] == "unknown"
    assert any("אין נתוני קירור" in r for r in cooling["reasons"])
    assert any("Chiller 1" in r and "ללא טלמטריה" in r for r in cooling["reasons"])
    assert any("נתוני קירור" in m for m in data["missing_info"])
    fresh = [power_entry("pdu-a", total=500.0, complete=True, inlets=[inlet(2.4, 208.0, 500.0)], temperature=28.5)]
    warm = analysis.plan_capacity_data("Rack-01", layout=LAYOUT, power=power_data(fresh), power_w=100)
    assert warm["dimensions"]["cooling"]["verdict"] == "tight"
    assert analysis.TEMP_ASSUMPTION_HE in warm["assumptions"]
    assert warm["dimensions"]["cooling"]["threshold_source"] == analysis.TEMP_ASSUMPTION
    stale_temp = [power_entry("pdu-a", temperature=22.0, stale=True)]
    assert analysis.plan_capacity_data("Rack-01", power=power_data(stale_temp))["dimensions"]["cooling"]["verdict"] \
        == "unknown"


def test_capacity_is_never_a_plain_yes_and_over_means_no():
    pdus = [power_entry("pdu-a", total=500.0, complete=True, inlets=[inlet(2.4, 208.0, 500.0)], temperature=22.0),
            power_entry("pdu-b", total=500.0, complete=True, inlets=[inlet(2.4, 208.0, 500.0)])]
    data = analysis.plan_capacity_data("Rack-01", layout=LAYOUT, power=power_data(pdus), power_w=100, units=1,
                                       needs_network=False)
    verdicts = data["verdicts"]
    assert {verdicts[k] for k in ("space", "power", "cooling", "network", "redundancy")} == {"ok"}
    assert verdicts["weight"] == "unknown" and verdicts["cabling"] == "unknown"
    assert data["overall"] == "conditional"
    assert set(data["dimensions"]) == set(analysis.DIMENSIONS)
    assert all(d["verdict"] in analysis.VERDICTS for d in data["dimensions"].values())
    # Configured per-inlet current limit: 11 A of 12 A at 208 V + 500 W exceeds it.
    hot = [power_entry("pdu-a", total=2288.0, complete=True, inlets=[inlet(11.0, 208.0, 2288.0)])]
    over = analysis.plan_capacity_data("Rack-01", layout=LAYOUT, power=power_data(hot, thresholds=[
        {"metric": "current", "side": "max", "value": 12.0, "unit": "A"}]), power_w=500)
    assert over["dimensions"]["power"]["verdict"] == "over"
    assert over["dimensions"]["power"]["threshold_source"] == "configured: EMAIL_CURRENT_MAX per inlet"
    assert over["overall"] == "no"
    without_power = analysis.plan_capacity_data("Rack-01", layout=LAYOUT, power=power_data(pdus))
    assert without_power["dimensions"]["power"]["verdict"] == "unknown"
    assert any("(W)" in m for m in without_power["missing_info"])


def test_space_network_and_redundancy_verdicts():
    def space(units, layout=LAYOUT):
        return analysis.plan_capacity_data("Rack-01", layout=layout, units=units)["dimensions"]["space"]
    assert space(1)["verdict"] == "ok" and space(1)["confidence"] == "low"
    assert space(2)["verdict"] == "tight"
    assert space(3)["verdict"] == "over"
    assert space(1, {**LAYOUT, "free_shelves": None})["verdict"] == "unknown"
    assert analysis.plan_capacity_data("Rack-01")["dimensions"]["space"]["verdict"] == "unknown"
    deps = {"entity": {"kind": "rack", "id": "Rack-01"}, "pdus": [{"id": "pdu-a", "kind": "pdu"}],
            "connections": [{"kind": "switch", "server_key": "opt11", "switch": "sw-1", "port": "1"},
                            {"kind": "switch", "server_key": "opt12", "switch": "sw-1", "port": "2"}]}
    data = analysis.plan_capacity_data("Rack-01", dependencies=deps)
    assert data["dimensions"]["network"]["verdict"] == "unknown"
    assert data["dimensions"]["network"]["switches"] == {"sw-1": 2}
    assert data["dimensions"]["redundancy"]["verdict"] == "tight"
    assert any("רשת" in a for a in data["assumptions"])           # needs_network not given -> labelled assumption


def test_parse_thresholds_accepts_configured_rules_and_ignores_assumptions():
    rules = analysis.parse_thresholds([{"metric": "current", "side": "max", "value": 12.0, "unit": "A"},
                                       ("watts", "max", 2400), {"source": "assumption", "current_max": 16}])
    assert rules == {("current", "max"): 12.0, ("watts", "max"): 2400.0}
    assert analysis.parse_thresholds({"assumption": "16 A / 208 V UI constant", "rated_amps_per_pdu": 16}) == {}


# ----------------------------------------------------------------------------------------------------------------
# Correlation
# ----------------------------------------------------------------------------------------------------------------
def history_item(event_id, kind, at, **extra):
    return {"id": event_id, "kind": kind, "at_iso": iso(at), "source_id": extra.pop("source_id", "ping_incidents"),
            "detail": extra.pop("detail", "x"), "co_occurred_with": [], **extra}


def test_correlation_window_groups_and_states_that_time_is_not_cause():
    history = {"items": [
        history_item("ping_incident:1", "ping_incident", NOW - 2 * DAY, incident={"target_id": "t-11"}),
        history_item("maintenance:5", "pdu_maintenance", NOW - 2 * DAY + 5 * MIN, device_id="pdu-a",
                     action="shutdown", source_id="pdu_maintenance_log"),
        history_item("ping_incident:2", "ping_incident", NOW - 2 * DAY + 40 * MIN, incident={"target_id": "t-12"}),
        history_item("ping_incident:3", "ping_incident", NOW - DAY, incident={"target_id": "t-13"}),
        history_item("maintenance:6", "pdu_maintenance", NOW - DAY + 11 * MIN, device_id="pdu-b", action="shutdown",
                     source_id="pdu_maintenance_log")]}
    data = analysis.correlate_events_data(history, since_hours=168, now=NOW)
    assert analysis.NON_CAUSAL_NOTE == "קישור בזמן אינו הוכחה לקשר סיבתי"
    assert len(data["groups"]) == 1
    group = data["groups"][0]
    assert group["event_ids"] == ["ping_incident:1", "maintenance:5"]
    assert group["co_occurred"] is True and group["note"] == analysis.NON_CAUSAL_NOTE
    assert group["source_ids"] == ["ping_incidents", "pdu_maintenance_log"]
    assert data["causality_note"] == analysis.NON_CAUSAL_NOTE
    assert analysis.NON_CAUSAL_NOTE in data["notes"]
    events = {e["id"]: e for e in data["events"]}
    assert events["ping_incident:1"]["co_occurred_with"] == ["maintenance:5"]
    assert events["maintenance:6"]["co_occurred_with"] == []       # 11 minutes apart: outside the window


def test_recurrence_counts_occurrences_in_the_window():
    items = [history_item(f"ping_incident:{n}", "ping_incident", NOW - n * DAY, incident={"target_id": "t-84"})
             for n in (1, 3, 5)]
    items.append(history_item("ping_incident:9", "ping_incident", NOW - 9 * DAY, incident={"target_id": "t-84"}))
    items.append(history_item("maintenance:1", "pdu_maintenance", NOW - 2 * DAY, device_id="pdu-a", action="shutdown"))
    data = analysis.correlate_events_data({"items": items}, since_hours=168, now=NOW)
    top = data["recurrence"][0]
    assert top["count"] == 3 and top["recurring"] is True
    assert top["text"] == "קרה 3 פעמים ב-7 ימים"
    assert data["outside_window_count"] == 1
    assert analysis.recurrence_text(1, 24) == "קרה פעם אחת ביום אחד"
    assert analysis.recurrence_text(2, 12) == "קרה 2 פעמים ב-12 שעות"


def test_focus_history_keeps_only_groups_with_the_focus_entity():
    focus = {"items": [history_item("ping_incident:1", "ping_incident", NOW - DAY, incident={"target_id": "t-11"})]}
    overall = {"items": [
        history_item("ping_incident:1", "ping_incident", NOW - DAY, incident={"target_id": "t-11"}),
        history_item("maintenance:2", "pdu_maintenance", NOW - DAY + 3 * MIN, device_id="pdu-a", action="shutdown"),
        history_item("ping_incident:3", "ping_incident", NOW - 2 * DAY, incident={"target_id": "t-12"}),
        history_item("maintenance:4", "pdu_maintenance", NOW - 2 * DAY + 2 * MIN, device_id="pdu-b",
                     action="shutdown"),
        {"id": "undated", "kind": "rack_item_move"}]}
    data = analysis.correlate_events_data(overall, since_hours=168, now=NOW, focus_history=focus)
    assert [g["event_ids"] for g in data["groups"]] == [["ping_incident:1", "maintenance:2"]]
    assert [r["count"] for r in data["recurrence"]] == [1]
    assert data["undated_count"] == 1
    empty = analysis.correlate_events_data({"items": []}, since_hours=24, now=NOW)
    assert empty["groups"] == [] and any("אינו מוכיח" in n for n in empty["notes"])


# ----------------------------------------------------------------------------------------------------------------
# Prioritisation
# ----------------------------------------------------------------------------------------------------------------
def test_prioritize_groups_per_entity_and_orders_by_score():
    problems = analysis.normalize_problems({"problems": [
        problem("active_maintenance", "low", "pdu", "pdu-m", "pdu-m", "pdu_maintenance"),
        problem("device_unreachable", "medium", "pdu", "pdu-a", "PDU A", "monitor_device_snapshots"),
        DOWN_OPT11,
        problem("open_ping_incident", "high", "incident", "7", "Opt11", "ping_incidents", target_id="t-11"),
        problem("monitor_overdue", "unknown", "monitor", "ping", "Ping monitor", "ping_monitor_state")]})
    topology = analysis.build_topology(index({"opt11": [("pdu-a", 1, "on"), ("pdu-b", 1, "on")],
                                              "opt12": [("pdu-a", 2, "on")], "opt13": [("pdu-a", 3, "on")]}),
                                       [("opt11", "Dana")])
    data = analysis.prioritize_problems_data(problems, topology, [analysis.TOPOLOGY_SOURCE_ID])
    order = [(r["entity"]["kind"], r["entity"]["id"]) for r in data["ranked"]]
    # opt11: 40 + 5 + 15 (owner) = 60 (high); pdu-a: 25 + 15 + 15 (opt11 owned) - 0 (opt11 is on pdu-b too, but it
    # is down now, so it is not protected) = 55; monitor: 20; maintenance on pdu-m without known servers: 10
    assert order == [("server", "t-11"), ("pdu", "pdu-a"), ("monitor", "ping"), ("pdu", "pdu-m")]
    assert [r["score"] for r in data["ranked"]] == [60, 55, 20, 10]
    assert data["ranked"][0]["priority"] == "high" and len(data["ranked"][0]["problems"]) == 2
    assert {"ping_targets", "ping_incidents", analysis.TOPOLOGY_SOURCE_ID} <= set(data["ranked"][0]["source_ids"])
    assert data["ranked"][1]["affected_count"] == 3 and data["ranked"][1]["rank"] == 2
    assert data["count"] == 4 and data["formula"] == analysis.PRIORITY_FORMULA


def test_outlet_specific_problems_only_count_servers_on_those_outlets():
    topology = analysis.build_topology(index({"opt11": [("pdu-a", 1, "on")], "opt12": [("pdu-a", 2, "off")],
                                              "opt13": [("pdu-a", 3, "on")]}))
    outlet = analysis.normalize_problems({"problems": [
        problem("outlet_off", "medium", "pdu", "pdu-a", "PDU A", "monitor_device_snapshots", outlet="2")]})
    maintenance = analysis.normalize_problems({"problems": [
        problem("active_maintenance", "low", "pdu", "pdu-a", "pdu-a", "pdu_maintenance",
                maintenance={"outlets_off": [1, 3], "started_by": "x", "reason": "y"})]})
    unreachable = analysis.normalize_problems({"problems": [
        problem("device_unreachable", "medium", "pdu", "pdu-a", "PDU A", "monitor_device_snapshots")]})
    assert analysis.prioritize_problems_data(outlet, topology)["ranked"][0]["affected"] == ["opt12"]
    assert analysis.prioritize_problems_data(maintenance, topology)["ranked"][0]["affected"] == ["opt11", "opt13"]
    assert analysis.prioritize_problems_data(unreachable, topology)["ranked"][0]["affected_count"] == 3
    assert analysis.score_entity(kind="kvm", affected_count=1)["components"]["scope"] == 3   # 2.5 rounds up


def test_prioritize_without_problems_never_claims_health_and_without_topology_says_so():
    assert analysis.prioritize_problems_data([])["note"] == analysis.NO_PROBLEMS_NOTE
    problems = analysis.normalize_problems({"problems": [
        problem("device_unreachable", "medium", "pdu", "pdu-a", "PDU A", "monitor_device_snapshots")]})
    row = analysis.prioritize_problems_data(problems, None)["ranked"][0]
    assert row["affected_count"] == 0 and any("לא נבדקו" in r for r in row["reasons"])


# ----------------------------------------------------------------------------------------------------------------
# Wrappers with fake data-tool modules
# ----------------------------------------------------------------------------------------------------------------
class FakeTools:
    def __init__(self, monkeypatch, responses, roles=None):
        self.calls = []
        self.responses = responses
        roles = roles or {}
        for module, names in (("tools_status", ("lab_status_overview", "list_current_problems", "get_server_status",
                                                "get_history")),
                              ("tools_layout", ("resolve_entity", "get_dependencies", "get_power_and_environment",
                                                "get_rack_layout", "search_docs"))):
            fake = types.ModuleType(f"app.assistant.{module}")
            fake.TOOLS = [ToolSpec(name, "fake", {"type": "object", "additionalProperties": False, "properties": {}},
                                   roles.get(name, "Viewer"), self._make(name)) for name in names]
            monkeypatch.setitem(sys.modules, f"app.assistant.{module}", fake)

        async def fake_topology(ctx):
            self.calls.append(("topology", {}))
            topo = responses.get("topology")
            return topo, [Source(id=analysis.TOPOLOGY_SOURCE_ID, name="Recorded PDU/KVM port associations",
                                 status="ok" if topo else "unavailable")]
        monkeypatch.setattr(analysis, "read_topology", fake_topology)

    def _make(self, name):
        async def tool(ctx, **args):
            self.calls.append((name, args))
            response = self.responses.get(name)
            if isinstance(response, Exception):
                raise response
            if callable(response):
                return response(**args)
            if response is None:
                raise ToolError(f"{name} has no fixture")
            return response
        return tool

    def count(self, name):
        return sum(1 for called, _ in self.calls if called == name)


def result(data, *source_ids, status="ok", caveats=()):
    return ToolResult(data=data, sources=[Source(id=s, name=s, status=status) for s in source_ids],
                      caveats=list(caveats))


async def test_analyze_impact_merges_sources_and_makes_a_bounded_number_of_calls(monkeypatch):
    many = [f"opt{n}" for n in range(100, 130)]
    deps = pdu_dependencies(servers=many)
    fake = FakeTools(monkeypatch, {
        "get_dependencies": result(deps, "devices", "monitor_device_snapshots",
                                   caveats=["Switch data is free text.", "Shared caveat."]),
        "list_current_problems": result({"problems": [problem("ping_down", "high", "server", "t-100", "Opt100")]},
                                        "ping_targets", "monitor_device_snapshots", status="stale",
                                        caveats=["Shared caveat.", "UPS telemetry is not monitored."]),
        "topology": analysis.build_topology(index({k: [("pdu-a", 1, "on")] for k in many})),
    })
    out = await analysis.analyze_impact(viewer_ctx(), kind="pdu", id="pdu-a")

    assert fake.count("get_dependencies") == 1 and fake.count("list_current_problems") == 1
    assert fake.count("topology") == 1 and fake.count("get_server_status") == 0
    ids = [s.id for s in out.sources]
    assert ids == ["devices", "monitor_device_snapshots", "ping_targets", analysis.TOPOLOGY_SOURCE_ID]
    assert {s.id: s.status for s in out.sources}["monitor_device_snapshots"] == "stale"   # worst status kept
    assert out.caveats.count("Shared caveat.") == 1 and "UPS telemetry is not monitored." in out.caveats
    assert out.data["counts"]["affected"] == 30 and out.data["ranked"][0]["id"] == "opt100"
    json.dumps(out.to_dict(), ensure_ascii=False)


async def test_analyze_impact_server_target_reads_status_once(monkeypatch):
    deps = {"entity": {"kind": "server", "id": "opt84"}, "servers": [{"server_key": "opt84", "label": "Opt84"}],
            "connections": [connection("pdu-a", "opt84", 1)], "found": True}
    fake = FakeTools(monkeypatch, {
        "get_dependencies": result(deps, "devices"),
        "list_current_problems": result({"problems": []}, "ping_targets"),
        "get_server_status": result({"status": "found", "icmp": {"status": "down"}, "pdu": [{"device_id": "pdu-a"}],
                                     "owner_names": []}, "ping_targets", "ping_samples"),
        "topology": None,
    })
    out = await analysis.analyze_impact(viewer_ctx(), kind="server", id="opt84")
    assert fake.count("get_server_status") == 1
    assert ("get_server_status", {"server": "opt84"}) in fake.calls
    assert out.data["ranked"][0]["status"] == "down"
    assert {s.id: s.status for s in out.sources}[analysis.TOPOLOGY_SOURCE_ID] == "unavailable"


async def test_failed_secondary_tool_becomes_an_unavailable_source_and_primary_failure_raises(monkeypatch):
    fake = FakeTools(monkeypatch, {
        "get_dependencies": result(pdu_dependencies(), "devices"),
        "list_current_problems": RuntimeError("internal path C:/secret/db.sqlite3 password=hunter2"),
        "topology": None,
    })
    out = await analysis.analyze_impact(viewer_ctx(), kind="pdu", id="pdu-a")
    failed = {s.id: s for s in out.sources}["tool:list_current_problems"]
    assert failed.status == "unavailable"
    serialised = json.dumps(out.to_dict(), ensure_ascii=False)
    assert "hunter2" not in serialised and "secret/db" not in serialised
    assert out.data["counts"]["no_data"] == 3                        # no problem list -> no data, not healthy
    assert fake.count("list_current_problems") == 1

    fake.responses["get_dependencies"] = ToolError("kind must be pdu, kvm, switch, rack, server or item.")
    with pytest.raises(ToolError):
        await analysis.analyze_impact(viewer_ctx(), kind="pdu", id="pdu-a")


async def test_missing_data_module_is_reported_not_crashed(monkeypatch):
    monkeypatch.setitem(sys.modules, "app.assistant.tools_status", None)   # import fails
    monkeypatch.setitem(sys.modules, "app.assistant.tools_layout", None)
    with pytest.raises(ToolError, match="not available"):
        await analysis.prioritize_problems(viewer_ctx())
    with pytest.raises(ToolError, match="capacity cannot be assessed"):
        await analysis.plan_capacity(viewer_ctx(), rack="Rack-01")


async def test_prioritize_uses_one_topology_pass_for_fifty_problems(monkeypatch):
    problems = [problem("device_unreachable", "medium", "pdu", f"pdu-{n}", f"PDU {n}", "monitor_device_snapshots")
                for n in range(50)]
    fake = FakeTools(monkeypatch, {
        "list_current_problems": result({"problems": problems, "total": 50, "truncated": False}, "monitor_device_snapshots"),
        "topology": analysis.build_topology(index({"opt11": [("pdu-3", 1, "on")]})),
    })
    out = await analysis.prioritize_problems(viewer_ctx())
    assert fake.count("list_current_problems") == 1 and fake.count("topology") == 1
    assert fake.count("get_dependencies") == 0 and fake.count("get_server_status") == 0
    assert out.data["ranked"][0]["entity"]["id"] == "pdu-3"
    assert ("list_current_problems", {"limit": analysis.PROBLEMS_LIMIT}) in fake.calls


async def test_plan_capacity_wrapper_merges_three_tools(monkeypatch):
    fake = FakeTools(monkeypatch, {
        "get_rack_layout": result(LAYOUT, "rack_items", "twin"),
        "get_power_and_environment": result(power_data([power_entry(
            "pdu-a", total=500.0, complete=True, inlets=[inlet(2.4, 208.0, 500.0)])]), "devices", "pdu_cache:pdu-a"),
        "get_dependencies": ToolError("Rack lookup failed."),
        "topology": None,
    })
    out = await analysis.plan_capacity(viewer_ctx(), rack="Rack-01", power_w=150.5, units=1)
    assert [c for c, _ in fake.calls] == ["get_rack_layout", "get_power_and_environment", "get_dependencies"]
    ids = {s.id: s.status for s in out.sources}
    assert ids["rack_items"] == "ok" and ids["pdu_cache:pdu-a"] == "ok" and ids["tool:get_dependencies"] == "unavailable"
    assert out.data["dimensions"]["power"]["source_ids"] == ["devices", "pdu_cache:pdu-a"]
    assert out.data["dimensions"]["space"]["source_ids"] == ["rack_items", "twin"]
    assert out.data["overall"] == "conditional"


async def test_correlate_wrapper_focus_ambiguity_and_window_cap(monkeypatch):
    def history(**args):
        if args.get("server") == "opt":
            return result({"status": "ambiguous", "candidates": [{"id": "t-1", "key": "opt1", "label": "Opt1",
                                                                  "host": "198.51.100.5"}], "items": []}, "ping_targets")
        return result({"items": [history_item("ping_incident:1", "ping_incident", NOW - DAY)],
                       "truncated": True}, "ping_incidents", "pdu_maintenance_log")
    fake = FakeTools(monkeypatch, {"get_history": history})
    ambiguous = await analysis.correlate_events(viewer_ctx(), server="opt")
    assert ambiguous.data["status"] == "ambiguous" and ambiguous.data["candidates"][0]["key"] == "opt1"
    assert "198.51.100.5" not in json.dumps(ambiguous.to_dict())
    out = await analysis.correlate_events(viewer_ctx(), server="opt84", since_hours=10_000)
    assert [args.get("since_hours") for _, args in fake.calls[-2:]] == [analysis.MAX_HISTORY_HOURS] * 2
    assert out.data["window"]["since_hours"] == analysis.MAX_HISTORY_HOURS
    assert any("truncated" in c for c in out.caveats)


async def test_topology_read_failure_is_an_unavailable_source_without_details():
    from sqlalchemy.exc import OperationalError

    @asynccontextmanager
    async def broken():
        raise OperationalError("SELECT secret-query-marker", {}, Exception("db-path-marker"))
        yield  # pragma: no cover

    topology, sources = await analysis.read_topology(viewer_ctx(session_factory=broken))
    assert topology is None
    assert {s.id: s.status for s in sources} == {analysis.TOPOLOGY_SOURCE_ID: "unavailable",
                                                 analysis.OWNERS_SOURCE_ID: "unavailable"}
    text = json.dumps([s.to_dict() for s in sources])
    assert "secret-query-marker" not in text and "db-path-marker" not in text


async def test_invalid_arguments_are_tool_errors():
    ctx = viewer_ctx()
    for call in (analysis.analyze_impact(ctx, kind="ups", id="x"), analysis.analyze_impact(ctx, kind="pdu", id=" "),
                 analysis.plan_capacity(ctx, rack="Rack-01", power_w=-5),
                 analysis.plan_capacity(ctx, rack="Rack-01", units=0),
                 analysis.plan_capacity(ctx, rack="Rack-01", needs_network="yes"),
                 analysis.correlate_events(ctx, since_hours=True)):
        with pytest.raises(ToolError):
            await call


async def test_data_tool_requiring_a_higher_role_is_refused(monkeypatch):
    FakeTools(monkeypatch, {"get_history": result({"items": []}, "ping_incidents")},
              roles={"get_history": "Operator"})
    with pytest.raises(ToolError, match="requires the Operator role"):
        await analysis.correlate_events(viewer_ctx())


# ----------------------------------------------------------------------------------------------------------------
# Tool declarations and roles
# ----------------------------------------------------------------------------------------------------------------
def test_tool_specs_are_viewer_read_only_and_closed():
    assert [t.name for t in analysis.TOOLS] == ["analyze_impact", "plan_capacity", "correlate_events",
                                                "prioritize_problems"]
    for spec in analysis.TOOLS:
        assert spec.required_role == "Viewer" and spec.description
        schema = spec.input_schema
        assert schema["type"] == "object" and schema["additionalProperties"] is False
        assert set(schema["required"]) <= set(schema["properties"])
        assert "minimum" not in json.dumps(schema) and "maximum" not in json.dumps(schema)
    assert set(analysis.TOOL_CALLS) == {t.name for t in analysis.TOOLS}


def test_each_analysis_tool_role_covers_every_tool_it_calls():
    from app.assistant import tools_layout, tools_status
    data_roles = {spec.name: spec.required_role for spec in [*tools_status.TOOLS, *tools_layout.TOOLS]}
    data_roles["topology"] = analysis.TOPOLOGY_ROLE
    for spec in analysis.TOOLS:
        for called in analysis.TOOL_CALLS[spec.name]:
            assert called in data_roles, called
            assert ROLE_ORDER[spec.required_role] >= ROLE_ORDER[data_roles[called]], (spec.name, called)
    assert set(analysis._TOOL_MODULES) == set(data_roles) - {"topology"}


# ----------------------------------------------------------------------------------------------------------------
# End to end against the real data tools, with seeded secrets
# ----------------------------------------------------------------------------------------------------------------
SECRET_SETTINGS = {
    "pdu_password": "pdu-pass-marker-ai5", "kvm_password": "kvm-pass-marker-ai5",
    "lab_manager_master_key": "master-key-marker-ai5", "lab_manager_password": "lab-pass-marker-ai5",
    "smtp_password": "smtp-pass-marker-ai5", "smtp_username": "smtp-user-marker-ai5",
    "email_alerts_to": "recipient-marker-ai5@example.invalid",
    "assistant_anthropic_api_key": "sk-ant-api-marker-ai5-0123456789",
}
DEVICE_SECRETS = ("user-enc-marker-ai5", "pass-enc-marker-ai5", "notes-marker-ai5")
DEVICE_IP = "198.51.100.77"


@pytest.fixture
async def real_lab(db_session, tmp_path, monkeypatch):
    import app.main as main
    from app import engineers, inventory_store
    from app.models import (AssetOwner, Device, MonitorDeviceSnapshot, PduMaintenanceLog, PingIncident,
                            PingMonitorState, PingTarget)
    from app.routers import kvms, pdus
    from app.schemas import InletReading, PduStatus

    now = time.time()
    backend, twin_dir = tmp_path / "backend", tmp_path / "lab-twin"
    backend.mkdir()
    twin_dir.mkdir()
    files = {"rack_items.json": {"Rack-01": [{"id": "item-1", "name": "Spare switch", "type": "switch", "u": 2}]},
             "rack_positions.json": {}, "rack_slots.json": {}, "rack_overrides.json": {},
             "switch_assignments.json": {"opt11": {"switch": "sw-1", "port": "1"}},
             "opt_owners.json": {}, "chillers.json": {"units": [], "connections": []}}
    for name, value in files.items():
        (backend / name).write_text(json.dumps(value), encoding="utf-8")
    (twin_dir / "lab-data.json").write_text(json.dumps({"setups": [], "items": [], "shelves": []}), encoding="utf-8")
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", backend / "rack_items.json")
    for attr, name in (("_RACK_POSITIONS_FILE", "rack_positions.json"), ("_RACK_SLOTS_FILE", "rack_slots.json"),
                       ("_SWITCH_ASSIGN_FILE", "switch_assignments.json"),
                       ("_RACK_OVERRIDES_FILE", "rack_overrides.json"), ("_OPT_OWNERS_FILE", "opt_owners.json"),
                       ("_CHILLERS_FILE", "chillers.json")):
        monkeypatch.setattr(main, attr, backend / name)
    monkeypatch.setattr(main, "_TWIN_DATA_FILE", twin_dir / "lab-data.json")
    monkeypatch.setattr(engineers, "legacy_owners", lambda: {})

    def forbidden(*args, **kwargs):
        raise AssertionError("analysis tools must never contact a device")
    monkeypatch.setattr(pdus, "_fetch_status", forbidden)
    monkeypatch.setattr(kvms, "_fetch_status", forbidden)

    secret = dict(username_enc=DEVICE_SECRETS[0], password_enc=DEVICE_SECRETS[1],
                  notes="password=" + DEVICE_SECRETS[2])
    db_session.add_all([
        Device(id="pdu-a", name="PDU A", kind="pdu", ip=DEVICE_IP, rack="Rack-01",
               labels_json=json.dumps({"1": "Opt11", "2": "Opt12", "3": "Opt13"}), **secret),
        Device(id="pdu-b", name="PDU B", kind="pdu", ip="198.51.100.78", rack="Rack-01",
               labels_json=json.dumps({"4": "Opt11"}), **secret),
        Device(id="kvm-a", name="KVM A", kind="kvm", ip="198.51.100.79", rack="Rack-01",
               labels_json=json.dumps({"1": "Opt11"}), **secret),
        MonitorDeviceSnapshot(device_id="pdu-a", kind="pdu", ip=DEVICE_IP, checked_at=now - 10, reachable=True,
                              ports_json=json.dumps([{"number": 1, "label": "Opt11", "state": "on"},
                                                     {"number": 2, "label": "Opt12", "state": "off"},
                                                     {"number": 3, "label": "Opt13", "state": "on"}])),
        PingMonitorState(id=1, next_run_at=now + 60, last_started_at=now - 30, last_completed_at=now - 20),
        PingTarget(id="t-11", source_key="server:opt11", name="Opt11", host="198.51.100.11", status="down",
                   checked_at=now - 10, last_up_at=now - 3600),
        PingTarget(id="t-12", source_key="server:opt12", name="Opt12", host="198.51.100.12", status="up",
                   checked_at=now - 10, last_up_at=now - 10, rtt_ms=1.0),
        PingIncident(id=1, target_id="t-11", host="198.51.100.11", first_failed_at=now - 600,
                     last_failed_at=now - 10, failed_checks=5),
        PduMaintenanceLog(id=1, at=now - 300, device_id="pdu-a", action="shutdown", by="operator",
                          reason="password=" + DEVICE_SECRETS[2]),
        AssetOwner(asset_key="opt12", engineer_id=None, legacy_name="Dana"),
    ])
    await db_session.commit()
    pdus._cache["pdu-a"] = (time.monotonic(), PduStatus(
        device_id="pdu-a", reachable=True, total_watts=1200.0, watts_complete=True, inlet_voltage=208.0,
        inlet_readings=[InletReading(number=1, voltage=208.0, current=5.8, watts=1200.0)], temperature=24.0))
    settings = SimpleNamespace(
        ping_monitor_enabled=True, ping_monitor_timezone="UTC", email_alerts_enabled=False, pxe_enabled=False,
        accounts_enabled=True, email_voltage_min=None, email_voltage_max=None, email_current_min=None,
        email_current_max=12.0, email_watts_min=None, email_watts_max=None, **SECRET_SETTINGS)
    return ToolContext(principal=Principal(user_id="u-1", username="viewer", role="Viewer"),
                       session_factory=async_sessionmaker(db_session.bind, expire_on_commit=False),
                       settings=settings, now=now, project_root=tmp_path)


async def test_real_data_tools_end_to_end_without_secrets_or_addresses(real_lab):
    ctx = real_lab
    results = {
        "impact": await analysis.analyze_impact(ctx, kind="pdu", id="pdu-a"),
        "server": await analysis.analyze_impact(ctx, kind="server", id="Opt11"),
        "item": await analysis.analyze_impact(ctx, kind="item", id="item-1"),
        "rack": await analysis.analyze_impact(ctx, kind="rack", id="Rack-01"),
        "capacity": await analysis.plan_capacity(ctx, rack="Rack-01", power_w=300, units=1),
        "history": await analysis.correlate_events(ctx, server="Opt11", since_hours=24),
        "priority": await analysis.prioritize_problems(ctx),
    }
    for name, out in results.items():
        assert isinstance(out, ToolResult) and out.sources, name
        serialised = json.dumps(out.to_dict(), ensure_ascii=False)
        for marker in (*SECRET_SETTINGS.values(), *DEVICE_SECRETS, "username_enc", "password_enc", "@example.invalid"):
            assert marker not in serialised, (name, marker)
        assert DEVICE_IP not in json.dumps(out.data), name

    impact = results["impact"].data
    assert impact["counts"]["affected"] == 3 and impact["counts"]["down"] == 1
    assert impact["ranked"][0]["id"] == "opt11" and impact["ranked"][0]["status"] == "down"
    by_id = {r["id"]: r for r in impact["ranked"]}
    assert by_id["opt11"]["redundancy"] == "possible"               # also on pdu-b
    assert by_id["opt12"]["in_use"] is True                          # owner registered
    assert any(reason.startswith("השערה") for reason in by_id["opt12"]["reasons"])   # outlet 2 OFF
    assert analysis.TOPOLOGY_SOURCE_ID in {s.id for s in results["impact"].sources}

    assert results["server"].data["ranked"][0]["status"] == "down"
    assert [i["id"] for i in results["item"].data["affected_items"]] == ["item-1"]
    assert results["rack"].data["counts"]["affected"] == 3

    capacity = results["capacity"].data
    power = capacity["dimensions"]["power"]
    assert [p["id"] for p in power["pdus"]] == ["pdu-a", "pdu-b"]
    assert power["pdus"][0]["threshold_source"] == "configured: EMAIL_CURRENT_MAX per inlet"
    assert power["pdus"][1]["verdict"] == "unknown"                  # no cached reading for pdu-b
    assert capacity["dimensions"]["cooling"]["verdict"] in ("ok", "unknown")
    assert capacity["dimensions"]["weight"]["verdict"] == "unknown" and capacity["overall"] in ("conditional", "no")
    assert capacity["dimensions"]["network"]["switches"] == {"sw-1": 1}

    history = results["history"].data
    assert history["causality_note"] == analysis.NON_CAUSAL_NOTE
    assert any(set(g["kinds"]) == {"ping_incident", "pdu_maintenance"} for g in history["groups"])

    priority = results["priority"].data
    first = priority["ranked"][0]
    assert first["entity"]["label"] == "Opt11" and first["severity"] == "high" and len(first["problems"]) == 2
    pdu_row = next(r for r in priority["ranked"] if r["entity"]["id"] == "pdu-a")
    assert pdu_row["affected_count"] == 1 and pdu_row["affected"] == ["opt12"]      # outlet 2 only


# ----------------------------------------------------------------------------------------------------------------
# Regression (R2 review, v2.39.0): credentials inside port labels / server keys must never leave an analysis tool
# ----------------------------------------------------------------------------------------------------------------
SECRET_LABELS = {"1": "opt31 password=hunter2", "2": "https://admin:hunter3@lab.example/opt32",
                 "3": "owner.secret@example.org", "4": "Opt33 token=tok-marker-xyz"}
SECRET_BITS = ("hunter2", "hunter3", "admin:", "owner.secret@example.org", "tok-marker-xyz")


def assert_no_secret_bits(value, where=""):
    text = json.dumps(value, ensure_ascii=False)
    for bit in SECRET_BITS:
        assert bit not in text, (where, bit)


def test_prioritize_affected_path_redacts_credentials_in_topology_keys():
    topology = analysis.build_topology(
        index({label: [("pdu-s", port, "error")] for port, label in SECRET_LABELS.items()}),
        [("opt31 password=hunter2", "Owner"), ("owner.secret@example.org", "Owner")])
    problems = analysis.normalize_problems({"problems": [
        problem("device_unreachable", "medium", "pdu", "pdu-s", "PDU S password=hunter2", "monitor_device_snapshots")]})
    data = analysis.prioritize_problems_data(problems, topology, [analysis.TOPOLOGY_SOURCE_ID])
    row = data["ranked"][0]
    assert row["affected_count"] == 4 and len(row["affected"]) == 4      # the reviewed `affected` path ran
    assert any("[redacted" in label for label in row["affected"])
    assert row["score"] > analysis.PROBLEM_POINTS["medium"] + 15        # owners still matched after redaction
    assert_no_secret_bits(data, "prioritize_problems_data")
    impact = analysis.analyze_impact_data("pdu", "pdu-s", {"servers": [{"server_key": k, "label": k}
                                                                       for k in SECRET_LABELS.values()]},
                                          problems, topology)
    assert impact["counts"]["affected"] == 4
    assert_no_secret_bits(impact, "analyze_impact_data")


async def test_every_wrapper_redacts_data_sources_and_caveats_from_data_tools(monkeypatch):
    secret_note = "login https://admin:hunter3@lab.example failed; password=hunter2"
    deps = {"entity": {"kind": "pdu", "id": "pdu-s"}, "found": True,
            "servers": [{"server_key": k, "label": k, "port": p,
                         "connection": {"kind": "pdu", "device_id": "pdu-s", "device_name": "PDU S token=tok-marker-xyz",
                                        "server_key": k, "port": p, "state": "off"}}
                        for p, k in SECRET_LABELS.items()],
            "connections": [{"kind": "switch", "server_key": "opt31 password=hunter2",
                             "switch": "sw owner.secret@example.org", "port": "1"}],
            "pdus": [{"id": "pdu-s", "kind": "pdu"}]}
    leaky = dict(sources=[Source(id="devices", name="Devices", note=secret_note, status="stale")],
                 caveats=[secret_note, "token=tok-marker-xyz"])
    FakeTools(monkeypatch, {
        "get_dependencies": ToolResult(data=deps, **leaky),
        "list_current_problems": ToolResult(data={"problems": [
            problem("outlet_off", "medium", "pdu", "pdu-s", "PDU S", "monitor_device_snapshots", outlet="1",
                    detail="password=hunter2")]}, **leaky),
        "get_server_status": ToolResult(data={"status": "found", "icmp": {"status": "down"},
                                              "owner_names": ["owner.secret@example.org"]}, **leaky),
        "get_rack_layout": ToolResult(data={**LAYOUT, "free_shelves": ["password=hunter2"]}, **leaky),
        "get_power_and_environment": ToolResult(data=power_data(
            [power_entry("pdu-s", total=100.0, complete=True, inlets=[inlet(0.5, 208.0, 100.0)])],
            chillers=[{"id": "c", "name": "Chiller token=tok-marker-xyz", "rack": "Rack-09"}]), **leaky),
        "get_history": ToolResult(data={"items": [
            history_item("e1", "pdu_maintenance", NOW - DAY, device_id="pdu-s", detail=secret_note,
                         action="password=hunter2"),
            history_item("e2", "ping_incident", NOW - DAY + 60, detail="owner.secret@example.org")]}, **leaky),
        "topology": analysis.build_topology(index({k: [("pdu-s", p, "on")] for p, k in SECRET_LABELS.items()})),
    })
    ctx = viewer_ctx()
    outputs = {
        "impact": await analysis.analyze_impact(ctx, kind="pdu", id="pdu-s"),
        "server": await analysis.analyze_impact(ctx, kind="server", id="opt31 password=hunter2"),
        "capacity": await analysis.plan_capacity(ctx, rack="Rack-09", power_w=50),
        "history": await analysis.correlate_events(ctx, device_id="pdu-s"),
        "priority": await analysis.prioritize_problems(ctx),
    }
    for name, out in outputs.items():
        assert_no_secret_bits(out.to_dict(), name)
        assert any("[redacted" in c for c in out.caveats), name
    assert outputs["impact"].data["counts"]["affected"] == 4
    assert outputs["priority"].data["ranked"][0]["affected_count"] == 1        # outlet 1 only, label redacted
    assert "[redacted" in outputs["priority"].data["ranked"][0]["affected"][0]


async def test_real_data_tools_never_return_credentials_from_port_labels(real_lab):
    from app.models import Device, MonitorDeviceSnapshot, PduMaintenanceLog

    ctx = real_lab
    async with ctx.session_factory() as session:
        session.add_all([
            Device(id="pdu-s", name="PDU S", kind="pdu", ip="198.51.100.90", rack="Rack-09",
                   labels_json=json.dumps(SECRET_LABELS)),
            MonitorDeviceSnapshot(device_id="pdu-s", kind="pdu", ip="198.51.100.90", checked_at=ctx.now - 10,
                                  reachable=False, ports_json="[]"),
            PduMaintenanceLog(id=2, at=ctx.now - 200, device_id="pdu-s", action="shutdown", by="operator",
                              reason="see https://admin:hunter3@lab.example/ops password=hunter2"),
        ])
        await session.commit()
    outputs = {
        "priority": await analysis.prioritize_problems(ctx),
        "impact": await analysis.analyze_impact(ctx, kind="pdu", id="pdu-s"),
        "rack": await analysis.analyze_impact(ctx, kind="rack", id="Rack-09"),
        "server": await analysis.analyze_impact(ctx, kind="server", id="opt31 password=hunter2"),
        "capacity": await analysis.plan_capacity(ctx, rack="Rack-09", power_w=100),
        "history": await analysis.correlate_events(ctx, device_id="pdu-s", since_hours=24),
    }
    for name, out in outputs.items():
        assert_no_secret_bits(out.to_dict(), name)
    row = next(r for r in outputs["priority"].data["ranked"] if r["entity"]["id"] == "pdu-s")
    assert row["affected_count"] == 4 and len(row["affected"]) == 4      # through the reviewed `affected` path
    assert outputs["impact"].data["counts"]["affected"] == 4
