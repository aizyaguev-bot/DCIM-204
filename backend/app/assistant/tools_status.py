"""Read-only monitoring tools. All text returned from storage is untrusted data.

Severity: a current ICMP down observation with an open incident is high; a
device management API failure or ICMP down without an incident is medium.
Stale, pending and unknown observations
are unknown, never OK. Maintenance is low; an outlet reported off is medium
(it does not establish a server failure). Temporal overlap establishes no cause.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sys
import unicodedata
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.exc import OperationalError

from .. import inventory_store
from ..models import (
    AlertCondition, AlertEmail, AssetOwner, Device, Engineer, MonitorDeviceError,
    MonitorDeviceSnapshot, PduMaintenance, PduMaintenanceLog, PingIncident,
    PingMonitorState, PingSample, PingTarget, PingTargetName,
)
from ..ping_monitor import interval_minutes, next_slot, server_identity
from .contracts import Source, ToolContext, ToolError, ToolResult, ToolSpec, age, iso


_CAVEATS = [
    "UPS telemetry is not monitored.",
    "Cooling/chillers telemetry is not monitored (placement is not telemetry).",
    "Switch/link state is not monitored; saved switch assignments are topology only.",
    "Absence of recorded problems is not evidence that the lab is healthy.",
]
_FILES = {
    "rack_items": ("backend/rack_items.json", None),
    "rack_positions": ("backend/rack_positions.json", "_RACK_POSITIONS_FILE"),
    "rack_slots": ("backend/rack_slots.json", "_RACK_SLOTS_FILE"),
    "switch_assignments": ("backend/switch_assignments.json", "_SWITCH_ASSIGN_FILE"),
    "rack_overrides": ("backend/rack_overrides.json", "_RACK_OVERRIDES_FILE"),
    "opt_owners": ("backend/opt_owners.json", "_OPT_OWNERS_FILE"),
    "chillers": ("backend/chillers.json", "_CHILLERS_FILE"),
    "twin": ("lab-twin/lab-data.json", "_TWIN_DATA_FILE"),
}
# Select only the fields needed by the tools. Never select alert bodies,
# recipients, credential columns, or serialized alert configurations.
# Minimal explicit DeviceOut fields; labels_json backs DeviceOut.labels. Do not
# pass ORM Device objects to joins that would select credential columns.
_DEVICE_FIELDS = "id name kind ip rack labels_json enabled"
_FIELDS = {
    Device: _DEVICE_FIELDS,
    PingTarget: "id source_key name host rack source enabled status checked_at last_up_at rtt_ms detail",
    PingTargetName: "target_id override",
    PingIncident: "id target_id host previous_up_at first_failed_at last_failed_at ended_at end_reason failed_checks",
    PingSample: "id target_id checked_at status rtt_ms detail",
    PingMonitorState: "id next_run_at last_started_at last_completed_at lease_until error",
    MonitorDeviceSnapshot: "device_id kind ip checked_at reachable ports_json",
    MonitorDeviceError: "device_id checked_at detail",
    PduMaintenance: "device_id started_at started_by reason outlets_off_json failed_json",
    PduMaintenanceLog: "id at device_id action by reason ok failed",
    AlertCondition: "key started_at checked_at",
    AlertEmail: "subject created_at sent_at",
    Engineer: "id name",
    AssetOwner: "asset_key engineer_id legacy_name",
}
_TIMES = {
    PingTarget: "checked_at", PingSample: "checked_at", PingIncident: "last_failed_at",
    PingMonitorState: "last_completed_at", MonitorDeviceSnapshot: "checked_at",
    MonitorDeviceError: "checked_at", PduMaintenance: "started_at", PduMaintenanceLog: "at",
    AlertCondition: "checked_at", AlertEmail: "created_at",
}
_EMAIL = re.compile(r"[\w.!#$%&'*+/=?^`{|}~+-]+@[\w.-]+", re.UNICODE)
_SECRET = re.compile(
    r"(?<!\w)[\"']?[A-Za-z0-9_-]*(?:password|passwd|pwd|username|api[_ -]?key|token|session[_ -]?hash|secret)"
    r"[A-Za-z0-9_-]*[\"']?\s*[=:]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)", re.IGNORECASE,
)
_PRIVATE_KEY = re.compile(r"(?:.*(?:password|passwd|token|api[_ -]?key|secret|session[_ -]?hash).*|username_enc|email|recipient|body)", re.IGNORECASE)
_MAX_LIST = 200
_MAX_ARGUMENT = 120
_BIDI = frozenset("\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")


def _text(value):
    value = "".join(c for c in str(value) if c not in _BIDI and not unicodedata.category(c).startswith("C"))
    value = _EMAIL.sub("[redacted email]", value)
    value = _SECRET.sub("[redacted credential]", value)
    value = re.sub(r"\bBearer\s+\S+", "[redacted token]", value, flags=re.IGNORECASE)
    value = re.sub(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}", "[redacted key]", value)
    value = re.sub(r"(https?://)[^/\s]+@", r"\1[redacted]@", value, flags=re.IGNORECASE)
    return value[:300]


def _safe(value):
    if isinstance(value, str):
        return _text(value)
    if isinstance(value, dict):
        return {_text(k): _safe(v) for k, v in value.items() if not _PRIVATE_KEY.fullmatch(str(k))}
    if isinstance(value, (list, tuple)):
        return [_safe(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _cap_lists(value):
    """Bound every returned list, including nested relationships and summaries."""
    if isinstance(value, list):
        result, clipped = [], len(value) > _MAX_LIST
        for child in value[:_MAX_LIST]:
            limited, nested = _cap_lists(child)
            result.append(limited)
            clipped |= nested
        return result, clipped
    if isinstance(value, dict):
        result, clipped = {}, False
        for key, child in value.items():
            result[key], nested = _cap_lists(child)
            clipped |= nested
        if clipped:
            result["truncated"] = True
        return result, clipped
    return value, False


def _epoch(value):
    try:
        if isinstance(value, str):
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return dt.replace(tzinfo=timezone.utc).timestamp() if dt.tzinfo is None else dt.timestamp()
        number = float(value)
        # Validate the value through the common normalizer as well.
        if math.isfinite(number):
            iso(number)
            return number
    except (ValueError, TypeError, OverflowError, OSError):
        pass
    return None


def _iso(value):
    return iso(_epoch(value))


def _key(value):
    identity = server_identity(value)
    return identity[0] if identity else ""


def _decode(value, expected):
    try:
        result = json.loads(value)
        return result if isinstance(result, expected) else expected()
    except (ValueError, TypeError):
        return expected()


def _ports(value):
    """Only well-formed observed ports can establish a current device state."""
    try:
        ports = json.loads(value)
        if isinstance(ports, list) and all(isinstance(p, dict) and isinstance(p.get("number"), (str, int))
                                           and isinstance(p.get("label"), str) for p in ports):
            return ports
    except (ValueError, TypeError):
        pass
    return None


class _Evidence:
    def __init__(self, ctx):
        self.ctx = ctx
        self.sources = {}
        self.caveats = list(_CAVEATS)
        if not getattr(ctx.settings, "email_alerts_enabled", False):
            self.caveats.append("Email alerts disabled: alert conditions and email history are not monitored.")
        if not getattr(ctx.settings, "ping_monitor_enabled", False):
            self.caveats.append("Ping monitor disabled: persisted ICMP and device observations do not refresh.")

    def add(self, source_id, name, *, ref=None, timestamp=None, status="ok", note=""):
        ts = _epoch(timestamp)
        source = Source(source_id, name, ref or source_id, iso(ts), age(ts, self.ctx.now), status, note)
        self.sources[source_id] = source
        return source

    def flag(self, source_id, status, note):
        source = self.sources.get(source_id)
        if source and source.status not in ("unavailable", "missing", "disabled"):
            source.status, source.note = status, note

    def result(self, data):
        sources = [Source(**_safe(s.to_dict())) for s in self.sources.values()]
        caveats = self.caveats + [f"{s.name}: {s.note}" for s in sources if s.status != "ok"]
        data, clipped = _cap_lists(_safe(data))
        caveats = list(dict.fromkeys(_safe(caveats)))
        clipped |= len(sources) > _MAX_LIST or len(caveats) > _MAX_LIST
        data["truncated"] = bool(data.get("truncated", False) or clipped)
        if data["truncated"]:
            caveats.insert(0, "Results are truncated; lists contain at most 200 entries. Additional evidence may exist.")
        return ToolResult(data, sources[:_MAX_LIST], caveats[:_MAX_LIST])


def _guard(ctx):
    if not ctx.principal.allows("Viewer"):
        raise ToolError("Viewer permission is required.")


def _zone(ctx, ev):
    try:
        return ZoneInfo(getattr(ctx.settings, "ping_monitor_timezone", "Asia/Jerusalem"))
    except (ValueError, KeyError):
        ev.caveats.append("Monitoring timezone unavailable; freshness is unknown.")
        return None


def _stale(ts, ctx, tz):
    return ts is None or tz is None or ts > ctx.now or ctx.now > next_slot(ts, tz) + 120


async def _rows(ctx, ev, model, *, where=(), order=(), limit=None):
    fields = _FIELDS[model].split()
    query = select(*(getattr(model, field) for field in fields)).where(*where).order_by(*order)
    if limit is not None:
        query = query.limit(limit)
    source_id = model.__tablename__
    try:
        async with ctx.session_factory() as session:
            rows = [dict(row) for row in (await session.execute(query)).mappings()]
    except OperationalError:
        ev.add(source_id, source_id, status="unavailable", note="Source temporarily unavailable; no health conclusion is possible.")
        return []
    time_field = _TIMES.get(model)
    times = [_epoch(r.get(time_field)) for r in rows] if time_field else []
    times = [ts for ts in times if ts is not None]
    ev.add(source_id, source_id, timestamp=min(times) if times else None,
           note="Oldest included observation; individual rows carry their own times." if times else "No update time recorded; empty rows do not establish health.")
    return rows


def _file_path(ctx, name):
    relative, constant = _FILES[name]
    if ctx.project_root is not None:
        return Path(ctx.project_root) / relative
    # Do not import main: importing it can initialize the application. When it
    # is already loaded, honor its configured/monkeypatched runtime paths.
    main = sys.modules.get("app.main")
    if constant and main is not None and hasattr(main, constant):
        return Path(getattr(main, constant))
    if name == "rack_items":
        return Path(inventory_store.ITEMS_FILE)
    return Path(__file__).resolve().parents[3] / relative


def _valid_file(name, data):
    if not isinstance(data, dict):
        return False
    if name == "rack_items":
        return all(isinstance(items, list) and all(isinstance(item, dict) and isinstance(item.get("id"), str)
                   and item["id"] and all(item.get(key) is None or isinstance(item[key], str)
                   for key in ("name", "type", "owner", "last_seen_at"))
                   for item in items) for items in data.values())
    if name in ("rack_overrides", "opt_owners"):
        return all(isinstance(v, str) for v in data.values())
    if name == "rack_positions":
        return all(isinstance(v, list) and all(isinstance(key, str) for key in v) for v in data.values())
    if name in ("rack_slots", "switch_assignments"):
        return all(isinstance(v, dict) for v in data.values())
    if name == "twin":
        return all(isinstance(data.get(k, []), list) and all(isinstance(v, dict) for v in data.get(k, []))
                   for k in ("setups", "items"))
    if name == "chillers":
        return isinstance(data.get("units", []), list)
    return True


def _files(ctx, ev, names=None):
    result = {}
    for name in names or _FILES:
        path = _file_path(ctx, name)
        filename = Path(_FILES[name][0]).name
        source_id = "file:" + filename
        try:
            if not path.exists():
                ev.add(source_id, filename, ref=filename, status="missing", note="Data file is missing; no data inferred.")
                result[name] = {}
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            if not _valid_file(name, data):
                raise ValueError("Invalid shape")
        except (OSError, ValueError, UnicodeError):
            ev.add(source_id, filename, ref=filename, status="unavailable", note="Data file could not be parsed or read.")
            result[name] = {}
            continue
        ev.add(source_id, filename, ref=filename, note="Data update time is not recorded; file modification time is not a measurement time.")
        result[name] = data
    return result


def _target(target, ctx, tz, names):
    # Same precedence as routers.monitoring.target_view, using request time.
    status = target["status"]
    if not target["enabled"]:
        status = "paused"
    elif not target["host"]:
        status = "unconfigured"
    elif target["checked_at"] is None or tz is None:
        status = "unknown"
    elif _stale(target["checked_at"], ctx, tz):
        status = "stale"
    elif not getattr(ctx.settings, "ping_monitor_enabled", False):
        status = "paused"
    if status not in ("up", "down", "error", "stale", "paused", "unconfigured"):
        status = "unknown"
    return {
        "id": target["id"], "name": names.get(target["id"]) or target["name"],
        "status": status, "last_result": target["status"], "checked_at": _iso(target["checked_at"]),
        "last_up_at": _iso(target["last_up_at"]), "rtt_ms": target["rtt_ms"],
        "detail": target["detail"], "source_id": "ping_targets",
    }


def _monitor(ctx, ev, states):
    enabled = bool(getattr(ctx.settings, "ping_monitor_enabled", False))
    state = next((s for s in states if s["id"] == 1), None)
    status = "not_started"
    if not enabled:
        status = "disabled"
        ev.flag("ping_monitor_state", "disabled", "Ping monitor is disabled.")
    elif state:
        status = "running" if state["lease_until"] > ctx.now else "overdue" if state["next_run_at"] < ctx.now - 60 else "scheduled"
        if state["error"]:
            status = "error"
        if status in ("overdue", "error"):
            ev.flag("ping_monitor_state", "stale" if status == "overdue" else "unavailable", "Monitor is " + status + ".")
    elif ev.sources["ping_monitor_state"].status == "ok":
        ev.flag("ping_monitor_state", "missing", "Monitor has not recorded service state.")
    if enabled and ev.sources["ping_monitor_state"].status == "unavailable":
        status = "error" if state and state["error"] else "unknown"
    return {
        "enabled": enabled, "status": status,
        "last_started_at": _iso(state["last_started_at"]) if state else None,
        "last_completed_at": _iso(state["last_completed_at"]) if state else None,
        "next_run_at": _iso(state["next_run_at"]) if state and enabled else None,
        "error": state["error"] if state else "", "source_id": "ping_monitor_state",
    }


def _maintenance(row):
    return {
        "device_id": row["device_id"], "started_at": _iso(row["started_at"]),
        "started_by": row["started_by"], "reason": row["reason"],
        "outlets_off": [n for n in _decode(row["outlets_off_json"], list) if isinstance(n, int) and not isinstance(n, bool)],
        "failed": [n for n in _decode(row["failed_json"], list) if isinstance(n, int) and not isinstance(n, bool)],
        "source_id": "pdu_maintenance",
    }


def _device_views(ctx, ev, devices, snapshots, diagnostics, tz):
    snapshot_map = {s["device_id"]: s for s in snapshots}
    errors = {e["device_id"]: e for e in diagnostics}
    result = []
    for device in devices:
        if device["kind"] not in ("pdu", "kvm"):
            continue
        snap = snapshot_map.get(device["id"])
        if snap and (snap["kind"], snap["ip"]) != (device["kind"], device["ip"]):
            snap = None
        status = "unknown"
        if not device["enabled"]:
            status = "disabled"
        elif snap is None:
            status = "pending"
        elif _stale(snap["checked_at"], ctx, tz):
            status = "stale"
        elif not snap["reachable"]:
            status = "unreachable"
        elif _ports(snap["ports_json"]) is None:
            status = "unknown"
            ev.flag("monitor_device_snapshots", "unavailable", "Some saved port observations have an invalid format.")
        elif not getattr(ctx.settings, "ping_monitor_enabled", False):
            status = "paused"
        else:
            status = "ok"
        if status == "stale":
            ev.flag("monitor_device_snapshots", "stale", "At least one device observation is overdue or has a future timestamp.")
        error = errors.get(device["id"])
        detail = error["detail"] if error and snap and error["checked_at"] == snap["checked_at"] else ""
        result.append({
            "device_id": device["id"], "kind": device["kind"], "label": device["name"],
            "status": status, "reachable": snap["reachable"] if snap else None,
            "checked_at": _iso(snap["checked_at"]) if snap else None,
            "age_s": age(snap["checked_at"], ctx.now) if snap else None,
            "detail": detail, "detail_source_id": "monitor_device_errors" if detail else None,
            "source_id": "monitor_device_snapshots",
        })
    return result


async def _current(ctx):
    _guard(ctx)
    ev = _Evidence(ctx)
    tz = _zone(ctx, ev)
    data = {}
    for model in (PingMonitorState, PingTarget, PingTargetName, PingIncident, Device,
                  MonitorDeviceSnapshot, MonitorDeviceError, PduMaintenance):
        where = (PingIncident.ended_at.is_(None),) if model is PingIncident else ()
        data[model] = await _rows(ctx, ev, model, where=where)
    names = {n["target_id"]: n["override"] for n in data[PingTargetName]}
    targets = [_target(t, ctx, tz, names) for t in data[PingTarget]]
    if any(t["status"] in ("stale", "unknown", "error") for t in targets):
        ev.flag("ping_targets", "stale", "Some targets have stale or unknown observations.")
    views = _device_views(ctx, ev, data[Device], data[MonitorDeviceSnapshot], data[MonitorDeviceError], tz)
    monitor = _monitor(ctx, ev, data[PingMonitorState])
    return ev, tz, data, targets, views, monitor


async def lab_status_overview(ctx: ToolContext) -> ToolResult:
    ev, tz, rows, targets, devices, monitor = await _current(ctx)
    _files(ctx, ev)
    counts = {key: 0 for key in ("up", "down", "error", "unknown", "stale", "paused", "unconfigured")}
    counts.update(Counter(t["status"] for t in targets))
    return ev.result({
        "monitor": {**monitor, "interval_minutes": interval_minutes(ctx.now, tz) if tz else None},
        "target_counts": counts, "target_total": len(targets), "open_incidents": len(rows[PingIncident]),
        "devices": devices, "maintenance": [_maintenance(r) for r in rows[PduMaintenance]],
        "enabled_sources": {
            "ping_monitor": bool(getattr(ctx.settings, "ping_monitor_enabled", False)),
            "email_alerts": bool(getattr(ctx.settings, "email_alerts_enabled", False)),
            "pxe": bool(getattr(ctx.settings, "pxe_enabled", False)),
            "accounts": bool(getattr(ctx.settings, "accounts_enabled", False)),
        },
        "accounts_mode": "individual" if getattr(ctx.settings, "accounts_enabled", False) else "legacy_shared",
        "data_files": {s.ref: s.status for s in ev.sources.values() if s.id.startswith("file:")},
    })


def _bounded(value, maximum, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ToolError(name + " must be an integer.")
    return max(1, min(value, maximum))


def _argument(value, name):
    if not isinstance(value, str):
        raise ToolError(name + " must be a nonempty string.")
    value = _text(value).strip()[:_MAX_ARGUMENT]
    if not value:
        raise ToolError(name + " must be a nonempty string.")
    return value


async def list_current_problems(ctx: ToolContext, limit: int = 50) -> ToolResult:
    limit = _bounded(limit, _MAX_LIST, "limit")
    ev, tz, rows, targets, devices, monitor = await _current(ctx)
    problems = []

    def add(kind, severity, entity_kind, entity_id, label, since, last, detail, source_id, **extra):
        problems.append({"kind": kind, "severity": severity,
                         "entity": {"kind": entity_kind, "id": str(entity_id), "label": label},
                         "since_iso": _iso(since), "last_seen_iso": _iso(last), "detail": detail,
                         "source_id": source_id, **extra})

    incidents = {}
    for incident in rows[PingIncident]:
        incidents.setdefault(incident["target_id"], []).append(incident)
    target_map = {t["id"]: t for t in targets}
    for target in targets:
        if target["status"] not in ("down", "error", "stale", "unknown"):
            continue
        active = incidents.get(target["id"], [])
        incident = min(active, key=lambda r: r["first_failed_at"]) if active else None
        add("ping_" + target["status"], "high" if target["status"] == "down" and active else
            "medium" if target["status"] == "down" else "unknown", "server", target["id"], target["name"],
            incident["first_failed_at"] if incident else None,
            incident["last_failed_at"] if incident else target["checked_at"],
            target["detail"] or "ICMP observation is " + target["status"] + ".", "ping_targets",
            incident_ids=[i["id"] for i in active],
            related_source_ids=["ping_incidents"] if active else [])
    for incident in rows[PingIncident]:
        target = target_map.get(incident["target_id"])
        add("open_ping_incident", "high" if target and target["status"] == "down" else "unknown",
            "incident", incident["id"], target["name"] if target else incident["target_id"],
            incident["first_failed_at"], incident["last_failed_at"], "Recorded ICMP incident remains open.",
            "ping_incidents", target_id=incident["target_id"])
    for device in devices:
        if device["status"] in ("unreachable", "stale", "pending", "unknown"):
            add("device_" + device["status"], "medium" if device["status"] == "unreachable" else "unknown",
                device["kind"], device["device_id"], device["label"], None, device["checked_at"],
                device["detail"] or "Device observation is " + device["status"] + ".", device["source_id"],
                related_source_ids=["monitor_device_errors"] if device["detail"] else [])
    device_map = {d["device_id"]: d for d in devices}
    for snap in rows[MonitorDeviceSnapshot]:
        device = device_map.get(snap["device_id"])
        if not device or device["kind"] != "pdu" or device["status"] != "ok":
            continue
        for port in _decode(snap["ports_json"], list):
            if isinstance(port, dict) and port.get("state") == "off" and not port.get("missing"):
                number = port.get("number")
                if not isinstance(number, (str, int)):
                    continue
                add("outlet_off", "medium", "pdu", snap["device_id"], device["label"], None,
                    snap["checked_at"], "PDU reports outlet " + str(number) + " OFF; server availability is unverified.",
                    "monitor_device_snapshots", outlet=str(number))
    for row in rows[PduMaintenance]:
        add("active_maintenance", "low", "pdu", row["device_id"], row["device_id"], row["started_at"],
            None, row["reason"] or "PDU maintenance is active.", "pdu_maintenance", maintenance=_maintenance(row))
    if getattr(ctx.settings, "email_alerts_enabled", False):
        conditions = await _rows(ctx, ev, AlertCondition, where=(AlertCondition.started_at.is_not(None),))
        for row in conditions:
            stale = _stale(row["checked_at"], ctx, tz)
            add("alert_condition", "unknown" if stale else "medium", "incident", row["key"], row["key"],
                row["started_at"], row["checked_at"], "Recorded alert condition" + (" (observation is stale)." if stale else "."),
                "alert_conditions")
            if stale:
                ev.flag("alert_conditions", "stale", "Some recorded alert conditions are stale.")
    else:
        ev.add("alert_conditions", "Alert conditions", status="disabled", note="Email alerts disabled; not monitored.")
    if monitor["status"] in ("overdue", "error"):
        add("monitor_" + monitor["status"], "unknown", "monitor", "ping", "Ping monitor",
            monitor["next_run_at"] if monitor["status"] == "overdue" else None, monitor["last_completed_at"],
            monitor["error"] or "Monitor round is overdue.", "ping_monitor_state")
    rank = {"high": 0, "medium": 1, "unknown": 2, "low": 3}
    problems.sort(key=lambda p: (rank[p["severity"]], p["entity"]["id"], p["kind"]))
    return ev.result({"problems": problems[:limit], "total": len(problems), "limit": limit,
                      "truncated": len(problems) > limit})


def _server_records(targets, overrides, devices, snapshots, files):
    records = []
    for target in targets:
        key = target["source_key"].removeprefix("server:") if target["source_key"].startswith("server:") else _key(target["name"])
        records.append({"id": target["id"], "key": key, "label": overrides.get(target["id"]) or target["name"],
                        "target": target, "aliases": {key, target["name"].casefold(), overrides.get(target["id"], "").casefold()}})
    labels = [label for values in _device_labels(devices, snapshots).values() for label in values]
    for items in files.get("rack_items", {}).values():
        labels.extend(i.get("name", "") for i in items if i.get("type") in ("computer", "server"))
    for item in files.get("twin", {}).get("items", []):
        if item.get("type") in ("opt", "computer", "server"):
            labels.append(item.get("name", ""))
    for label in labels:
        if not isinstance(label, str) or not _key(label):
            continue
        key = _key(label)
        matching = [r for r in records if r["key"] == key]
        if not matching:
            matching = [{"id": "server:" + key, "key": key, "label": label, "target": None, "aliases": {key}}]
            records.extend(matching)
        for record in matching:
            record["aliases"].add(label.strip().casefold())
    return records


def _device_labels(devices, snapshots):
    """Current saved labels override matching learned ports, as in connection_index."""
    observed = {s["device_id"]: s for s in snapshots}
    result = {}
    for device in devices:
        if device["kind"] not in ("pdu", "kvm"):
            continue
        result[device["id"]] = list(_port_labels(device, observed.get(device["id"])).values())
    return result


def _port_labels(device, snap):
    labels = {}
    if snap and (snap["kind"], snap["ip"]) == (device["kind"], device["ip"]):
        labels.update({str(p["number"]): p["label"] for p in _ports(snap["ports_json"]) or []})
    labels.update({str(number): label for number, label in _decode(device["labels_json"], dict).items()
                   if isinstance(label, str)})
    return labels


def _resolve(server, records):
    query = _argument(server, "server").casefold()
    exact_id = [r for r in records if r["id"].casefold() == query]
    if exact_id:
        return exact_id
    query = query.removeprefix("server:")
    exact = [r for r in records if query in r["aliases"]]
    return exact or [r for r in records if r["key"] == _key(query)]


def _public_server(record):
    return {key: record[key] for key in ("id", "key", "label")}


def _connections(ev, devices, snapshots, views):
    """Mirror connection_index with only already selected, credential-free data.

    The shared helper selects whole Device ORM rows. This projection preserves
    its state/freshness rules without ever reading those credential columns.
    """
    result = {}
    observed = {s["device_id"]: s for s in snapshots}
    states = {v["device_id"]: v for v in views}
    unavailable = ev.sources["monitor_device_snapshots"].status == "unavailable"
    for device in devices:
        if device["kind"] not in ("pdu", "kvm"):
            continue
        saved = _decode(device["labels_json"], dict)
        snap = observed.get(device["id"])
        if snap and (snap["kind"], snap["ip"]) != (device["kind"], device["ip"]):
            snap = None
        ports = {str(p["number"]): p for p in _ports(snap["ports_json"]) or []} if snap else {}
        view = states.get(device["id"], {})
        for number, label in _port_labels(device, snap).items():
            key = _key(label)
            if not key:
                continue
            state = view.get("status", "unknown")
            status = {"unreachable": "error", "ok": "unknown"}.get(state, state)
            detail = view.get("detail") or "Device observation is " + state + "."
            port = ports.get(number)
            if unavailable and state not in ("disabled", "stale", "paused", "pending"):
                status, detail = "unknown", "Saved association only; port state is unavailable."
            elif state == "ok" and port and not port.get("missing"):
                status, detail = _port_status(device["kind"], port)
            elif state == "ok":
                detail = "Device responded, but this port's live state is unavailable."
            result.setdefault("server:" + key, {"pdu": [], "kvm": []})[device["kind"]].append({
                "device_id": device["id"], "device_name": device["name"], "port": str(number),
                "status": status, "checked_at": snap["checked_at"] if snap else None,
                "detail": detail, "source_id": "devices" if number in saved and (unavailable or not snap) else "monitor_device_snapshots",
            })
    return result


def _port_status(kind, port):
    if kind == "pdu":
        status = port.get("state")
        if status in ("on", "off", "cycling"):
            return status, "PDU reports outlet " + status.upper() + "; server availability is unverified."
    elif port.get("status_source") == "live":
        status = port.get("status")
        if status in ("active", "idle", "empty"):
            return status, "KVM reports port " + status + "; a console session was not tested."
    elif port.get("status_source") == "configured":
        status = "empty" if port.get("status") == "empty" else "configured"
        return status, "KVM configuration only; live console health is unverified."
    return "unknown", "Device responded, but this port's live state is unavailable."


async def _owners(ctx, ev, files):
    # Mirror engineers.owner_map's names-only merge against the already validated
    # JSON, so an unreadable inventory file cannot discard independent DB owners.
    result = dict(files.get("opt_owners", {}))
    for items in files.get("rack_items", {}).values():
        for item in items:
            if isinstance(item.get("owner"), str) and item["owner"]:
                result.setdefault("item:" + item["id"], item["owner"])
    people = {p["id"]: p["name"] for p in await _rows(ctx, ev, Engineer)}
    assignments = await _rows(ctx, ev, AssetOwner)
    for assignment in assignments:
        name = people.get(assignment["engineer_id"], assignment["legacy_name"])
        if name:
            result[assignment["asset_key"]] = name
        else:
            result.pop(assignment["asset_key"], None)
    return result


def _rack_candidates(record, files, devices, pdu):
    aliases = record["aliases"] | {record["key"]}
    candidates = []

    def add(rack, source_id, **extra):
        if isinstance(rack, str) and rack.strip():
            value = {"rack": rack, "source_id": source_id, **extra}
            if value not in candidates:
                candidates.append(value)

    for key, rack in files.get("rack_overrides", {}).items():
        if key.casefold() in aliases or _key(key) == record["key"]:
            add(rack, "file:rack_overrides.json", key=key)
    linked_ids = {p["device_id"] for p in pdu}
    for device in devices:
        if device["kind"] != "pdu":
            continue
        labels = _decode(device["labels_json"], dict)
        if device["id"] in linked_ids or any(_key(label) == record["key"] for label in labels.values()):
            add(device["rack"], "devices", device_id=device["id"])
    for rack, items in files.get("rack_items", {}).items():
        for item in items:
            if item.get("type") in ("computer", "server") and _key(item.get("name")) == record["key"]:
                add(rack, "file:rack_items.json", item_id=item["id"])
    twin = files.get("twin", {})
    setups = {s.get("id"): s for s in twin.get("setups", []) if isinstance(s.get("id"), str)}
    for item in twin.get("items", []):
        if _key(item.get("name")) != record["key"]:
            continue
        setup_id = item.get("setup") or item.get("setupId")
        setup = setups.get(setup_id) if isinstance(setup_id, str) else None
        if setup:
            add(setup.get("dcimRack"), "file:lab-data.json", setup_id=setup.get("id"),
                confidence=_scalar(setup.get("dcimMappingConfidence", "unknown")))
    return candidates


async def get_server_status(ctx: ToolContext, server: str) -> ToolResult:
    _guard(ctx)
    server = _argument(server, "server")
    ev, tz, rows, targets, device_views, _ = await _current(ctx)
    files = _files(ctx, ev)
    overrides = {n["target_id"]: n["override"] for n in rows[PingTargetName]}
    records = _server_records(rows[PingTarget], overrides, rows[Device], rows[MonitorDeviceSnapshot], files)
    candidates = _resolve(server, records)
    if len(candidates) != 1:
        return ev.result({"status": "ambiguous" if candidates else "not_found",
                          "candidates": [_public_server(r) for r in candidates]})
    record = candidates[0]
    target = record["target"]
    icmp = next((t for t in targets if target and t["id"] == target["id"]), None)
    if icmp is None:
        icmp = {"status": "unconfigured", "checked_at": None, "last_up_at": None, "rtt_ms": None,
                "source_id": "ping_targets", "detail": "No ping target is configured for this server."}
        ev.caveats.append("Server has no ICMP monitoring target; availability is unknown.")
    samples = await _rows(ctx, ev, PingSample, where=(PingSample.target_id == target["id"],),
                          order=(PingSample.checked_at.desc(), PingSample.id.desc()), limit=20) if target else []
    for sample in samples:
        sample["checked_at"] = _iso(sample["checked_at"])
        sample["source_id"] = "ping_samples"
    active = [i for i in rows[PingIncident] if target and i["target_id"] == target["id"]]
    incident = _incident(min(active, key=lambda r: r["first_failed_at"])) if active else None
    connections = _connections(ev, rows[Device], rows[MonitorDeviceSnapshot], device_views).get(
        "server:" + record["key"], {"pdu": [], "kvm": []})
    device_states = {d["device_id"]: d for d in device_views}
    output = {"pdu": [], "kvm": []}
    for kind in output:
        for connection in connections[kind]:
            state = device_states.get(connection["device_id"], {})
            output[kind].append({
                "device_id": connection["device_id"], "device_name": connection["device_name"],
                "port": connection["port"], "status": _connection_status(connection["status"], state),
                "stale": state.get("status") == "stale", "checked_at": _iso(connection["checked_at"]),
                "age_s": age(_epoch(connection["checked_at"]), ctx.now), "detail": connection["detail"],
                "source_id": connection.get("source_id", "monitor_device_snapshots"),
            })
    racks = _rack_candidates(record, files, rows[Device], output["pdu"])
    owners = await _owners(ctx, ev, files)
    aliases = record["aliases"] | {record["key"]}
    owner_keys = aliases | {"item:" + item["id"].casefold() for items in files["rack_items"].values() for item in items
                            if item.get("type") in ("server", "computer") and _key(item.get("name")) == record["key"]}
    owner_names = list(dict.fromkeys(value for key, value in owners.items()
                                    if key.casefold().removeprefix("server:") in owner_keys
                                    or _key(key.removeprefix("server:")) == record["key"]))
    switches = [{"key": key, "switch": _scalar(value.get("switch")), "port": _scalar(value.get("port")),
                 "source_id": "file:switch_assignments.json"}
                for key, value in files.get("switch_assignments", {}).items()
                if key.casefold() in aliases or _key(key) == record["key"]]
    feeds = {p["device_id"] for p in output["pdu"]}
    maintenance = [_maintenance(m) for m in rows[PduMaintenance] if m["device_id"] in feeds]
    if len({r["rack"] for r in racks}) > 1:
        ev.caveats.append("Rack sources conflict; candidates are ordered override, PDU, server inventory, twin. Verify location.")
    return ev.result({"status": "found", "server": _public_server(record), "icmp": icmp,
                      "open_incident": incident, "samples": samples, **output,
                      "rack_candidates": racks, "rack_conflict": len({r["rack"] for r in racks}) > 1,
                      "owner_names": owner_names, "owner_source_ids": ["engineers", "asset_owners", "file:opt_owners.json", "file:rack_items.json"],
                      "switch_assignments": switches, "maintenance": maintenance})


def _incident(row):
    return {**{k: v for k, v in row.items() if not k.endswith("_at")},
            **{k: _iso(v) for k, v in row.items() if k.endswith("_at")}, "source_id": "ping_incidents"}


def _connection_status(status, state):
    # The shared index does not account for a disabled monitor or future stamps.
    effective = state.get("status")
    if effective in ("paused", "stale", "unknown"):
        return effective
    return status


async def get_history(ctx: ToolContext, server: str | None = None, device_id: str | None = None,
                      since_hours: int = 168, limit: int = 100) -> ToolResult:
    _guard(ctx)
    hours, limit = _bounded(since_hours, 2160, "since_hours"), _bounded(limit, _MAX_LIST, "limit")
    server = _argument(server, "server") if server is not None else None
    device_id = _argument(device_id, "device_id") if device_id is not None else None
    ev = _Evidence(ctx)
    start = ctx.now - hours * 3600
    files = _files(ctx, ev, ("rack_items",))
    targets = await _rows(ctx, ev, PingTarget)
    names = await _rows(ctx, ev, PingTargetName)
    devices = await _rows(ctx, ev, Device)
    snapshots = await _rows(ctx, ev, MonitorDeviceSnapshot)
    selected = None
    record = None
    records = _server_records(targets, {n["target_id"]: n["override"] for n in names}, devices, snapshots, files)
    if server is not None:
        candidates = _resolve(server, records)
        if len(candidates) != 1:
            return ev.result({"status": "ambiguous" if candidates else "not_found",
                              "candidates": [_public_server(r) for r in candidates], "items": [], "since_hours": hours,
                              "since_iso": iso(start), "until_iso": iso(ctx.now), "limit": limit, "truncated": False,
                              "ping_samples_summary": []})
        record = candidates[0]
        selected = {record["target"]["id"]} if record["target"] else set()
    device_labels = _device_labels(devices, snapshots)
    linked_devices = None
    if record:
        linked_devices = {device for device, labels in device_labels.items() if any(_key(label) == record["key"] for label in labels)}
    if device_id is not None:
        linked_keys = {_key(label) for label in device_labels.get(device_id, [])}
        linked_targets = {r["target"]["id"] for r in records if r["key"] in linked_keys and r["target"]}
        selected = linked_targets if selected is None else selected & linked_targets
        linked_devices = {device_id} if linked_devices is None else linked_devices & {device_id}
    incident_where = [PingIncident.first_failed_at <= ctx.now,
                      or_(PingIncident.ended_at.is_(None), PingIncident.ended_at >= start)]
    if selected is not None:
        incident_where.append(PingIncident.target_id.in_(selected))
    incidents = await _rows(ctx, ev, PingIncident, where=incident_where,
                            order=(PingIncident.first_failed_at.desc(), PingIncident.id.desc()), limit=limit + 1)
    log_where = [PduMaintenanceLog.at >= start, PduMaintenanceLog.at <= ctx.now]
    if linked_devices is not None:
        log_where.append(PduMaintenanceLog.device_id.in_(linked_devices))
    logs = await _rows(ctx, ev, PduMaintenanceLog, where=log_where,
                       order=(PduMaintenanceLog.at.desc(), PduMaintenanceLog.id.desc()), limit=limit + 1)
    events = []

    def event(event_id, kind, ts, end, detail, source_id, **extra):
        events.append({"id": event_id, "kind": kind, "at_iso": iso(ts), "source_id": source_id,
                       "detail": detail, "co_occurred_with": [], "_start": ts, "_end": end, **extra})

    for incident in incidents:
        event("ping_incident:" + str(incident["id"]), "ping_incident", incident["first_failed_at"],
              incident["ended_at"] if incident["ended_at"] is not None else ctx.now,
              "Recorded ICMP incident; temporal overlap does not establish a cause.", "ping_incidents", incident=_incident(incident))
    for row in logs:
        event("maintenance:" + str(row["id"]), "pdu_maintenance", row["at"], row["at"], row["reason"], "pdu_maintenance_log",
              device_id=row["device_id"], action=row["action"], by=row["by"], ok=row["ok"], failed=row["failed"])
    summaries = await _sample_summary(ctx, ev, start, selected)
    emails = []
    if getattr(ctx.settings, "email_alerts_enabled", False):
        email_where = [or_((AlertEmail.created_at >= start) & (AlertEmail.created_at <= ctx.now),
                          (AlertEmail.sent_at >= start) & (AlertEmail.sent_at <= ctx.now))]
        if selected is not None or linked_devices is not None:
            conditions = [AlertEmail.condition_key == "network:" + target for target in selected or ()]
            for dev in linked_devices or ():
                conditions.extend((AlertEmail.condition_key == "device-api:" + dev,
                                   AlertEmail.condition_key.startswith("power:" + dev + ":", autoescape=True)))
            email_where.append(or_(*conditions) if conditions else AlertEmail.id.in_([]))
        emails = await _rows(ctx, ev, AlertEmail, where=email_where,
                             order=(func.coalesce(AlertEmail.sent_at, AlertEmail.created_at).desc(), AlertEmail.id.desc()), limit=limit + 1)
        for index, row in enumerate(emails):
            at = row["sent_at"] if row["sent_at"] is not None and start <= row["sent_at"] <= ctx.now else row["created_at"]
            event("alert_email:" + str(index), "alert_email", at, at, "Alert email subject only.",
                  "alert_emails", subject=row["subject"], created_at=iso(row["created_at"]), sent_at=_iso(row["sent_at"]))
    else:
        ev.add("alert_emails", "Alert emails", status="disabled", note="Email alerts disabled; stored history is not queried.")
    for items in files["rack_items"].values():
        for item in items:
            if record and _key(item.get("name")) != record["key"]:
                continue
            if device_id is not None and item["id"] != device_id:
                continue
            history = item.get("tracking_history", [])
            if not isinstance(history, list):
                ev.flag("file:rack_items.json", "unavailable", "Some item tracking history has an invalid format.")
                continue
            for index, move in enumerate(history):
                if not isinstance(move, dict):
                    continue
                at = _epoch(move.get("at"))
                if at is not None and start <= at <= ctx.now:
                    event("rack_move:" + item["id"] + ":" + str(index), "rack_item_move", at, at,
                          str(_scalar(move.get("note")) or ""), "file:rack_items.json", item_id=item["id"],
                          action=_scalar(move.get("action")), **{"from": _location(move.get("from")), "to": _location(move.get("to"))})
    events.sort(key=lambda e: (-e["_start"], e["id"]))
    truncated = len(events) > limit or any(len(rows) > limit for rows in (incidents, logs, emails))
    events = events[:limit]
    for index, left in enumerate(events):
        for right in events[index + 1:]:
            if max(left["_start"], right["_start"]) <= min(left["_end"], right["_end"]):
                left["co_occurred_with"].append(right["id"])
                right["co_occurred_with"].append(left["id"])
    for entry in events:
        entry.pop("_start")
        entry.pop("_end")
    ev.caveats.append("Co-occurred events overlap in recorded time only; no causal relationship is established. History retention may be shorter than the requested window.")
    return ev.result({"items": events, "ping_samples_summary": summaries, "since_hours": hours,
                      "since_iso": iso(start), "until_iso": iso(ctx.now), "limit": limit, "truncated": truncated})


def _location(value):
    if not isinstance(value, dict):
        return None
    return {key: value.get(key) for key in ("rack", "u", "position") if isinstance(value.get(key), (str, int, float, type(None)))}


def _scalar(value):
    return value if isinstance(value, (str, int, float, bool, type(None))) else None


async def _sample_summary(ctx, ev, start, selected):
    query = select(PingSample.target_id, PingSample.status, func.count().label("count"),
                   func.min(PingSample.checked_at).label("first_at"), func.max(PingSample.checked_at).label("last_at"),
                   func.avg(PingSample.rtt_ms).label("mean_rtt_ms")).where(
                       PingSample.checked_at >= start, PingSample.checked_at <= ctx.now)
    if selected is not None:
        query = query.where(PingSample.target_id.in_(selected))
    query = query.group_by(PingSample.target_id, PingSample.status).order_by(PingSample.target_id, PingSample.status)
    try:
        async with ctx.session_factory() as session:
            rows = [dict(r) for r in (await session.execute(query)).mappings()]
    except OperationalError:
        ev.add("ping_samples", "Ping samples", status="unavailable", note="Sample history temporarily unavailable.")
        return []
    ev.add("ping_samples", "Ping samples", timestamp=max((r["last_at"] for r in rows), default=None),
           note="Summary of retained samples in the requested window; samples are not continuous availability measurements.")
    return [{"target_id": r["target_id"], "status": r["status"], "count": r["count"],
             "first_at": iso(r["first_at"]), "last_at": iso(r["last_at"]), "mean_rtt_ms": r["mean_rtt_ms"],
             "source_id": "ping_samples"} for r in rows]


TOOLS: list[ToolSpec] = [
    ToolSpec("lab_status_overview", "Read recorded monitor service state, target counts including stale/paused/unconfigured, open incidents, device snapshot freshness, active PDU maintenance, enabled features and missing/corrupt runtime files. No hardware is contacted. Unmonitored UPS, cooling and switch telemetry are always caveated.",
             {"type": "object", "additionalProperties": False, "properties": {}, "required": []}, "Viewer", lab_status_overview),
    ToolSpec("list_current_problems", "List recorded current problems with severity, entity, first/last observation time and evidence source. Current down plus open incident is high; device API failure is medium; stale/unknown is unknown. OFF outlets and maintenance do not establish server failure. Empty results never establish health.",
             {"type": "object", "additionalProperties": False, "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}}, "required": []}, "Viewer", list_current_problems),
    ToolSpec("get_server_status", "Resolve an exact server label, canonical key or ping-target id without guessing ambiguous names. Read ICMP state and last 20 samples, open incident, recorded PDU/KVM connections with freshness, ordered rack evidence/conflicts, owner names, switch assignments and feeding-PDU maintenance. Does not test the server or its console.",
             {"type": "object", "additionalProperties": False, "properties": {"server": {"type": "string", "minLength": 1, "maxLength": 120}}, "required": ["server"]}, "Viewer", get_server_status),
    ToolSpec("get_history", "Read retained ping incidents overlapping the window, ping sample summaries, PDU maintenance logs, enabled alert email subjects/timestamps only and rack-item tracking events. Optional server/device filters restrict evidence to known associations. Events sort newest first; overlapping events are co-occurred only, never causal. Window is capped at 2160 hours (90 days).",
             {"type": "object", "additionalProperties": False, "properties": {
                 "server": {"type": ["string", "null"], "minLength": 1, "maxLength": 120},
                 "device_id": {"type": ["string", "null"], "minLength": 1, "maxLength": 120},
                 "since_hours": {"type": "integer", "minimum": 1, "maximum": 2160, "default": 168},
                 "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100}}, "required": []}, "Viewer", get_history),
]
