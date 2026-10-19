"""Analysis tools for the lab assistant: failure impact, capacity planning, event correlation and problem priority.

Design
------
* Pure functions over plain dicts (the ``data`` of the status/layout tools) do all of the reasoning. They never
  touch the database, files, devices or the network, and they are unit-tested with fixture dicts.
* Thin async ToolSpec wrappers call the data tools *by name* through ``app.assistant.tools_status`` and
  ``app.assistant.tools_layout`` (imported lazily, so this module imports even while those are missing), then merge
  the sources and caveats of every tool they called into their own ToolResult. No sources are invented here: every
  source in a result comes from a data tool (or marks a data tool that could not be read as "unavailable").
* Bounded work (SEC-AI-10): each analysis tool makes a fixed number of data-tool calls (TOOL_CALLS) - never one per
  problem or per server. Fan-out for many entities comes from ONE short read-only session (read_topology:
  monitor_links.connection_index + owner names), the same recorded data GET /api/monitoring shows a Viewer.
* Everything is read-only. Nothing here operates equipment, refreshes devices or writes anything.
* Output is built from an explicit allowlist of fields; addresses, hosts, credentials and e-mail addresses from the
  underlying data are never copied. Text shown to the owner (reasons, missing information, notes) is Hebrew.

Priority score (shared by analyze_impact and prioritize_problems) - a transparent heuristic, not a measurement::

    score = clamp(0..100, severity + scope + service - redundancy)

    severity    the worst observed state. A recorded problem uses its severity: high = 40, medium = 25,
                unknown (stale / pending / no observation) = 20, low = 10. A server without a recorded problem uses its
                own status: down = 40, unknown or stale = 20, no status data = 10, no problem reported (not proof of
                health) = 5, up = 0.
    scope       5 points per affected server, at most 30, times the effect weight (KVM = 0.5 because losing a KVM
                affects console access only; PDU, switch, rack and server = 1.0).
    service     +15 when at least one affected server has a registered owner (owner present = in use). No owner means
                "use unknown", never "not in use".
    redundancy  only for feed failures (PDU, switch): -15 when every affected server has a possible alternative feed,
                -7 when only some do. Redundancy is a hint ("possible"), never verified: feed A/B and UPS topology are not
                stored. Two outlets on the same PDU are not redundancy against that PDU, and a server that is down now
                never counts as protected (its alternative feed evidently did not keep it up).
    priority    high >= 60, medium >= 30, otherwise low.
"""
from __future__ import annotations

import datetime as _dt
import importlib
import logging
import math
import re
from typing import Any

from .contracts import Source, ToolContext, ToolError, ToolResult, ToolSpec, age, iso, redact_text, redact_tree

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------------------------------------------
NON_CAUSAL_NOTE = "קישור בזמן אינו הוכחה לקשר סיבתי"
NO_PROBLEMS_NOTE = "לא דווחו בעיות במקורות המנוטרים. היעדר תקלות או התראות אינו הוכחה שהמעבדה תקינה."
REDUNDANCY_NOTE = ("יתירות היא רמז בלבד (\"ייתכן\") ולא אומתה: הזנות A/B וטופולוגיית UPS אינן שמורות במערכת. "
                   "שני שקעים באותו PDU אינם יתירות מפני תקלה באותו PDU.")

CORRELATION_WINDOW_S = 600          # events whose start times are within 10 minutes are grouped
DEFAULT_HISTORY_HOURS = 168
MAX_HISTORY_HOURS = 2160            # 90 days, same cap as get_history
HISTORY_LIMIT = 200
PROBLEMS_LIMIT = 200
MAX_LIST = 50
MAX_EVENTS_OUT = 100
MAX_FAILURE_CAVEATS = 5
TEXT_CAP = 300

PROBLEM_POINTS = {"high": 40, "medium": 25, "unknown": 20, "low": 10}
STATUS_POINTS = {"down": 40, "problem": 25, "unknown": 20, "no_data": 10, "not_reported": 5, "up": 0}
SCOPE_PER_SERVER = 5
SCOPE_CAP = 30
SERVICE_POINTS = 15
REDUNDANCY_ALL_POINTS = 15
REDUNDANCY_SOME_POINTS = 7
EFFECT_WEIGHT = {"kvm": 0.5}
FEED_KINDS = frozenset({"pdu", "switch"})
IMPACT_KINDS = ("pdu", "kvm", "switch", "rack", "server", "item")
EFFECT = {"pdu": "power", "kvm": "console", "switch": "network", "rack": "rack", "server": "server",
          "item": "equipment item"}

PRIORITY_FORMULA = (
    "score = clamp(0..100, severity + scope + service - redundancy). severity: recorded problem high 40, medium 25, "
    "unknown 20, low 10; server without a problem: down 40, unknown/stale 20, no status data 10, no problem reported 5, "
    "up 0. scope: 5 per affected server (max 30) x effect weight (KVM 0.5, others 1.0). service: +15 when an affected "
    "server has a registered owner (in use). redundancy (PDU/switch failures only): -15 if every affected server has a "
    "possible alternative feed, -7 if some do (never verified; servers that are down now never count). priority: "
    "high >= 60, medium >= 30, else low.")

# Capacity: only EMAIL_{CURRENT,WATTS}_MAX are configured server-side; every other number is a labelled UI constant.
UI_RATED_AMPS = 16.0
UI_VOLTAGE = 208.0
UI_POWER_ASSUMPTION = "assumption: 16 A / 208 V UI constant"
LOAD_TIGHT_RATIO = 0.8
LOAD_ASSUMPTION = "assumption: 80% load warning (UI constant)"
TEMP_TIGHT_C = 27.0
TEMP_OVER_C = 30.0
TEMP_ASSUMPTION = "assumption: 27 / 30 °C UI constant (lab twin); no temperature threshold is configured"
UI_POWER_ASSUMPTION_HE = "הנחה: 16 A / 208 V לכל PDU — קבוע ממשק, לא סף מוגדר בשרת (16 A / 208 V UI constant)"
LOAD_ASSUMPTION_HE = "הנחה: עומס מעל 80% נחשב צר — קבוע ממשק"
TEMP_ASSUMPTION_HE = "הנחה: 27 / 30 °C כספי טמפרטורה — קבוע ממשק בתאום הדיגיטלי; אין סף טמפרטורה מוגדר בשרת"
READING_FRESH_S = 3600              # cached PDU readings older than this are treated as stale
VERDICTS = ("ok", "tight", "over", "unknown")
DIMENSIONS = ("space", "power", "cooling", "network", "redundancy", "weight", "cabling")
_DIMENSION_HE = {"space": "מקום", "power": "חשמל", "cooling": "קירור", "network": "רשת", "redundancy": "יתירות",
                 "weight": "משקל", "cabling": "כבילה"}

_TOOL_MODULES = {
    "lab_status_overview": "tools_status", "list_current_problems": "tools_status",
    "get_server_status": "tools_status", "get_history": "tools_status",
    "resolve_entity": "tools_layout", "get_dependencies": "tools_layout",
    "get_power_and_environment": "tools_layout", "get_rack_layout": "tools_layout", "search_docs": "tools_layout",
}

# Every data tool each analysis tool may call (a fixed, bounded number of calls - never one per problem or server).
# "topology" is this module's own single read-only session (monitor_links.connection_index + owner names), the same
# data GET /api/monitoring and GET /api/engineers expose to a Viewer. Tests assert that each analysis tool's role is
# at least the role of every tool it calls.
TOOL_CALLS = {
    "analyze_impact": ("get_dependencies", "list_current_problems", "get_server_status", "topology"),
    "plan_capacity": ("get_rack_layout", "get_power_and_environment", "get_dependencies"),
    "correlate_events": ("get_history",),
    "prioritize_problems": ("list_current_problems", "topology"),
}
TOPOLOGY_ROLE = "Viewer"
TOPOLOGY_SOURCE_ID = "analysis:connection_index"
OWNERS_SOURCE_ID = "analysis:asset_owners"

_STATUS_HE = {"down": "לא זמין", "problem": "תקלה פעילה", "unknown": "מצב לא ידוע או נתונים ישנים",
              "no_data": "אין נתוני מצב", "not_reported": "לא דווחה תקלה (אינו הוכחה לתקינות)",
              "up": "זמין בבדיקה האחרונה"}
_SEVERITY_HE = {"high": "חומרה גבוהה", "medium": "חומרה בינונית", "unknown": "חומרה לא ידועה (נתונים ישנים או חסרים)",
                "low": "חומרה נמוכה"}
_STATUS_ORDER = {"down": 0, "problem": 1, "unknown": 2, "no_data": 3, "not_reported": 4, "up": 5}
_SERVER_KINDS = frozenset({"server", "opt", "host", "ping_target"})
_DEVICE_KINDS = frozenset({"pdu", "kvm", "device"})
_SKIP_KEYS = frozenset({"entity", "target", "candidates", "query", "sources", "caveats", "source_ids", "aliases",
                        "rack_candidates", "pdus", "kvms"})
_FEED_STATES = frozenset({"on", "off", "cycling"})
_UP = frozenset({"up", "ok", "online", "reachable", "alive"})
_DOWN = frozenset({"down", "offline", "unreachable", "failed"})
_SOURCE_RANK = {"ok": 0, "disabled": 1, "stale": 2, "missing": 3, "unavailable": 4}

_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]")   # control + bidi overrides
# URL userinfo left behind when an upstream tool redacted "pass@host" as an e-mail first: "https://admin:[redacted…]"
_USERINFO_REMNANT = re.compile(r"(?i)(https?://)[^\s/@]*\[redacted[^\]]*\]")
_OPT = re.compile(r"(optn?\d+)(?:\s*\([^)]*\))?", re.I)
_DEFAULT_PORT_LABEL = re.compile(r"(?:outlet|port)?\s*\d*", re.I)


# --------------------------------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------------------------------
def _text(value: Any, cap: int = TEXT_CAP) -> str:
    """Untrusted text from data: control/bidi characters removed, credentials, URL userinfo and e-mail addresses
    redacted with the shared contracts.redact_text rule (before capping, so a cut can never expose a secret)."""
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return ""
    text = redact_text(_CTRL.sub(" ", str(value)).strip())
    return _USERINFO_REMNANT.sub(r"\1[redacted]@", text)[:cap]


def _num(value: Any) -> float | None:
    """A finite number or None. None means unknown - it is never treated as 0."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _pick(data: Any, *paths: str) -> Any:
    """First non-None value found at one of the dotted paths."""
    for path in paths:
        current = data
        for part in path.split("."):
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                current = None
                break
        if current is not None:
            return current
    return None


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(value, digits)


def _fmt(value: float | None) -> str:
    if value is None:
        return "?"
    return str(int(value)) if float(value).is_integer() else f"{value:.1f}"


def to_epoch(value: Any) -> float | None:
    """ISO-8601 string (with or without zone; naive = UTC) or epoch seconds -> epoch seconds, else None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
        return number if math.isfinite(number) else None
    except ValueError:
        pass
    try:
        parsed = _dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.timestamp()


def _iso_of(value: Any) -> str | None:
    epoch = to_epoch(value)
    try:
        return iso(epoch)
    except (OverflowError, OSError, ValueError):
        return None


def canonical_key(value: Any) -> str:
    """Server identity like ping_monitor.server_identity: "Optn84 (2)" -> "optn84"; other names casefolded."""
    text = _text(value, 200)
    if text.lower().startswith("server:"):
        text = text[7:].strip()
    match = _OPT.fullmatch(text)
    return (match[1] if match else text).casefold()


def entity_keys(*values: Any) -> set[str]:
    """Every key an entity may be known by: full lowercased label and canonical server identity (critic §2.1)."""
    keys: set[str] = set()
    for value in values:
        text = _text(value, 200)
        if not text:
            continue
        keys.add(text.casefold())
        keys.add(canonical_key(text))
    keys.discard("")
    return keys


def _owner_present(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, dict):
        return any(_owner_present(value.get(k)) for k in ("name", "label", "owner", "engineer"))
    if isinstance(value, (list, tuple)):
        return any(_owner_present(v) for v in value)
    return False


def _owner_of(node: Any) -> bool:
    return _owner_present(_pick(node, "owner_names", "owner", "owners"))


# --------------------------------------------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------------------------------------------
def score_entity(*, kind: str, severities: list[str] | tuple = (), statuses: list[str] | tuple = (),
                 affected_count: int = 0, in_use: list[bool | None] | tuple = (),
                 redundancy: list[str] | tuple = ()) -> dict:
    """Priority score with Hebrew reasons. See the module docstring for the formula.

    severities  severities of recorded problems ("high"/"medium"/"unknown"/"low")
    statuses    statuses of affected servers that have no recorded problem ("down"/"unknown"/"no_data"/...)
    redundancy  per affected server: "possible" | "none_known" | "unknown" | "not_applicable"
    """
    kind = (kind or "").lower()
    reasons: list[str] = []
    severity, label = 0, None
    for value in severities:
        points = PROBLEM_POINTS.get(value, PROBLEM_POINTS["unknown"])
        if label is None or points > severity:
            severity, label = points, _SEVERITY_HE.get(value, _SEVERITY_HE["unknown"])
    for value in statuses:
        points = STATUS_POINTS.get(value, STATUS_POINTS["no_data"])
        if label is None or points > severity:
            severity, label = points, _STATUS_HE.get(value, _STATUS_HE["no_data"])
    reasons.append(f"חומרה: {label or 'אין מידע על חומרה'} (+{severity})")

    weight = EFFECT_WEIGHT.get(kind, 1.0)
    count = max(0, int(affected_count or 0))
    scope = int(min(SCOPE_CAP, SCOPE_PER_SERVER * count) * weight + 0.5)   # round half up
    scope_text = f"היקף: {count} שרתים מושפעים (+{scope})"
    if weight != 1.0:
        scope_text += " — משקל מופחת: תקלת KVM פוגעת בגישת קונסולה בלבד"
    reasons.append(scope_text)

    if any(flag is True for flag in in_use):
        service = SERVICE_POINTS
        reasons.append(f"השפעה על שירות: לפחות לשרת מושפע אחד יש בעלים רשום, כלומר הוא בשימוש (+{SERVICE_POINTS})")
    else:
        service = 0
        reasons.append("השפעה על שירות: לא ידועה — אין בעלים רשום לשרתים המושפעים (+0)")

    discount = 0
    hints = list(redundancy)
    if kind in FEED_KINDS and hints:
        possible = sum(1 for h in hints if h == "possible")
        if all(h == "down" for h in hints):
            reasons.append("יתירות: השרת אינו זמין כעת, ולכן הזנה חלופית אפשרית אינה מורידה את העדיפות (0)")
        elif possible and possible == len(hints):
            discount = REDUNDANCY_ALL_POINTS
            reasons.append(f"יתירות: לכל השרתים המושפעים ייתכן מקור הזנה נוסף — לא מאומת (−{discount})")
        elif possible:
            discount = REDUNDANCY_SOME_POINTS
            reasons.append(f"יתירות: ל-{possible} מתוך {len(hints)} שרתים ייתכן מקור הזנה נוסף — לא מאומת (−{discount})")
        else:
            reasons.append("יתירות: לא נמצא מקור הזנה חלופי ידוע (0)")
    elif kind in FEED_KINDS:
        reasons.append("יתירות: אין שרתים מושפעים ידועים לבדיקה (0)")
    else:
        reasons.append("יתירות: אינה מורידה עדיפות לסוג רכיב זה (0)")

    score = max(0, min(100, severity + scope + service - discount))
    priority = "high" if score >= 60 else "medium" if score >= 30 else "low"
    return {"score": score, "priority": priority, "reasons": reasons,
            "components": {"severity": severity, "scope": scope, "service": service, "redundancy": -discount}}


# --------------------------------------------------------------------------------------------------------------
# Normalising the data of other tools
# --------------------------------------------------------------------------------------------------------------
def normalize_problems(data: Any) -> list[dict]:
    """list_current_problems data -> problems with {kind, severity, entity{kind,id,label}, since_iso, ...}."""
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = data.get("problems") or data.get("items") or []
    else:
        rows = []
    problems = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        entity = row.get("entity") if isinstance(row.get("entity"), dict) else {}
        severity = _text(row.get("severity"), 20).lower() or "unknown"
        if severity not in PROBLEM_POINTS:
            severity = "unknown"
        entity_id = _text(entity.get("id") if entity.get("id") is not None else row.get("entity_id"), 200)
        problems.append({
            "kind": _text(row.get("kind") or row.get("type") or "problem", 60),
            "severity": severity,
            "entity": {"kind": _text(entity.get("kind") or row.get("entity_kind") or "unknown", 30).lower(),
                       "id": entity_id,
                       "label": _text(entity.get("label") or entity.get("name") or row.get("label") or entity_id, 120)},
            "since_iso": _iso_of(row.get("since_iso", row.get("since"))),
            "last_seen_iso": _iso_of(row.get("last_seen_iso", row.get("last_seen"))),
            "detail": _text(row.get("detail")),
            "source_id": _text(row.get("source_id"), 120) or None,
            "related_source_ids": [_text(s, 120) for s in row.get("related_source_ids") or [] if _text(s, 120)],
            "target_id": _text(row.get("target_id"), 200) or None,
            "outlet": _text(row.get("outlet"), 20) or None,
            "outlets": _problem_outlets(row),
        })
    return problems


def _problem_outlets(row: dict) -> list[str] | None:
    """Outlets a problem is limited to (outlet OFF, maintenance outlets), or None when it concerns the whole device."""
    outlet = _text(row.get("outlet"), 20)
    if outlet:
        return [outlet]
    maintenance = row.get("maintenance")
    if isinstance(maintenance, dict) and isinstance(maintenance.get("outlets_off"), list):
        return [_text(n, 20) for n in maintenance["outlets_off"] if isinstance(n, (int, str)) and
                not isinstance(n, bool)][:64]
    return None


def problem_status(problem: dict) -> str:
    """Server status implied by a recorded problem: down | unknown | problem."""
    kind, severity = problem["kind"].lower(), problem["severity"]
    if "down" in kind or severity == "high":
        return "down"
    if severity == "unknown" or any(word in kind for word in ("stale", "error", "unknown", "pending")):
        return "unknown"
    return "problem"


def problem_group_key(problem: dict, index: int = 0) -> str:
    """One key per real-world entity, so a down target, its open incident and its alert condition rank together."""
    entity = problem["entity"]
    kind, entity_id = entity["kind"], entity["id"]
    if kind == "incident":
        if problem.get("target_id"):
            return "server:" + problem["target_id"].casefold()
        prefix, _, rest = entity_id.partition(":")
        if prefix == "network" and rest:
            return "server:" + rest.casefold()
        if prefix in ("device-api", "power") and rest:
            return "device:" + rest.split(":", 1)[0].casefold()
    if kind in _SERVER_KINDS and entity_id:
        return "server:" + entity_id.casefold()
    if kind in _DEVICE_KINDS and entity_id:
        return "device:" + entity_id.casefold()
    if entity_id:
        return f"{kind}:{entity_id.casefold()}"
    return f"{problem['kind'].casefold()}:#{index}"


def _problem_server_keys(problem: dict) -> set[str]:
    """Keys of the server a problem is about (empty when it is not about a server)."""
    entity = problem["entity"]
    if entity["kind"] in _SERVER_KINDS:
        return entity_keys(entity["label"], entity["id"])
    if entity["kind"] == "incident" and (problem.get("target_id") or entity["id"].startswith("network:")):
        return entity_keys(entity["label"])
    return set()


def _problem_view(problem: dict) -> dict:
    return {k: problem[k] for k in ("kind", "severity", "since_iso", "last_seen_iso", "detail", "source_id", "outlet")}


def collect_dependents(data: Any, *, target_kind: str = "", target_id: str = "") -> tuple[list[dict], list[dict]]:
    """Affected servers and items in get_dependencies data, de-duplicated by server identity.

    Servers are recognised by ``kind: server``, ``server_key``, a ``server`` string/object, or string lists under
    ``servers``. For a server target the server itself is excluded (it is the target, not a dependent).
    """
    servers: list[dict] = []
    items: dict[str, dict] = {}
    exclude = entity_keys(target_id) if target_kind in _SERVER_KINDS else set()

    def server_entry(server_id: Any, label: Any) -> dict | None:
        sid, text = _text(server_id, 120), _text(label, 120)
        keys = entity_keys(sid, text)
        if not keys or (exclude and keys & exclude):
            return None
        for entry in servers:
            if entry["_keys"] & keys:
                entry["_keys"] |= keys
                return entry
        entry = {"kind": "server", "id": canonical_key(sid or text), "label": text or sid, "via": [], "feed_states": [],
                 "in_use": None, "hint": False, "_feeds": set(), "_keys": set(keys)}
        servers.append(entry)
        return entry

    def note(entry: dict, node: Any, via: str | None) -> None:
        if via and via not in entry["via"] and len(entry["via"]) < 8:
            entry["via"].append(via)
        if not isinstance(node, dict):
            return
        if _owner_of(node):
            entry["in_use"] = True
        hint = node.get("redundancy_hint")
        if hint is True or (isinstance(hint, str) and hint.strip()) or (isinstance(hint, (list, dict)) and hint):
            entry["hint"] = True
        state = _text(node.get("state") or node.get("outlet_state"), 20).lower()
        if state in _FEED_STATES and state not in entry["feed_states"]:
            entry["feed_states"].append(state)
        if _text(node.get("kind"), 20).lower() == "pdu" and node.get("device_id") is not None:
            entry["_feeds"].add(_text(node.get("device_id"), 120).casefold())
        for key in ("feeds", "power_feeds", "pdu_outlets", "pdu"):
            value = node.get(key)
            for feed in value if isinstance(value, list) else [value] if isinstance(value, (dict, str)) else []:
                if isinstance(feed, dict):
                    feed_id = feed.get("device_id", feed.get("pdu_id", feed.get("id")))
                    if feed_id is not None:
                        entry["_feeds"].add(_text(feed_id, 120).casefold())
                elif isinstance(feed, str) and feed.strip():
                    entry["_feeds"].add(_text(feed, 120).casefold())

    def via_of(node: dict, parent_key: str, inherited: str | None) -> str | None:
        node_kind = _text(node.get("kind"), 20).lower()
        device = _text(node.get("device_name") or node.get("pdu_name") or node.get("kvm_name")
                       or (node.get("switch") if node_kind == "switch" else None), 60)
        outlet = node.get("outlet")
        if isinstance(outlet, (str, int)) and not isinstance(outlet, bool) and str(outlet).strip():
            return f"{device} outlet {_text(outlet, 20)}".strip()
        port = node.get("port")
        if device and isinstance(port, (str, int)) and not isinstance(port, bool) and str(port).strip():
            return f"{device} {'outlet' if node_kind == 'pdu' else 'port'} {_text(port, 20)}"
        if parent_key in ("outlets", "ports"):
            number = node.get("number")
            if isinstance(number, (str, int)) and not isinstance(number, bool):
                return f"{'outlet' if parent_key == 'outlets' else 'port'} {_text(number, 20)}"
        return inherited

    def walk(node: Any, parent_key: str, via: str | None, depth: int) -> None:
        if depth > 8:
            return
        if isinstance(node, list):
            for value in node:
                if isinstance(value, str) and parent_key in ("servers", "affected_servers", "server_keys", "affected"):
                    entry = server_entry(value, value)
                    if entry:
                        note(entry, None, via)
                else:
                    walk(value, parent_key, via, depth + 1)
            return
        if not isinstance(node, dict):
            return
        here = via_of(node, parent_key, via)
        kind = _text(node.get("kind"), 20).lower()
        entry = None
        if kind in _SERVER_KINDS:
            entry = server_entry(node.get("server_key") or node.get("key") or node.get("id") or node.get("label"),
                                 node.get("label") or node.get("name"))
        elif kind == "item" or (parent_key == "items" and "type" in node):
            item_id = _text(node.get("id") or node.get("name"), 120)
            if item_id and item_id not in items and len(items) < MAX_LIST:
                items[item_id] = {"kind": "item", "id": item_id, "label": _text(node.get("name") or item_id, 120),
                                  "type": _text(node.get("type"), 40) or None}
        elif isinstance(node.get("server_key"), str) or isinstance(node.get("server"), str):
            server_id = node["server_key"] if isinstance(node.get("server_key"), str) else node["server"]
            entry = server_entry(server_id, node.get("server_label") or node.get("label") or server_id)
        elif isinstance(node.get("server"), dict):
            inner = node["server"]
            entry = server_entry(inner.get("server_key") or inner.get("key") or inner.get("id") or inner.get("label"),
                                 inner.get("label") or inner.get("name"))
            if entry:
                note(entry, inner, here)
        elif parent_key in ("outlets", "ports") and isinstance(node.get("label"), str) and "servers" not in node:
            if not _DEFAULT_PORT_LABEL.fullmatch(node["label"].strip()):
                entry = server_entry(node["label"], node["label"])
        if entry:
            note(entry, node, here)
        for key, value in node.items():
            if key in _SKIP_KEYS or (key == "server" and isinstance(value, dict)):
                continue
            if isinstance(value, (dict, list)):
                walk(value, key, here, depth + 1)

    walk(data, "", None, 0)
    return servers, list(items.values())


def server_status_summary(data: Any) -> dict:
    """get_server_status data -> {status: up|down|unknown|None, in_use, pdu_ids, ambiguous, maintenance}."""
    if not isinstance(data, dict):
        return {"status": None, "in_use": None, "pdu_ids": set(), "ambiguous": False, "maintenance": False}
    top = _text(data.get("status"), 30).lower()
    if top in ("ambiguous", "not_found"):
        return {"status": None, "in_use": None, "pdu_ids": set(), "ambiguous": top == "ambiguous",
                "not_found": top == "not_found", "maintenance": False}
    raw = _pick(data, "icmp.status", "ping.status", "target.status", "icmp_status", "ping_status")
    if raw is None and top not in ("", "found"):
        raw = top
    text = _text(raw, 30).lower()
    status = "up" if text in _UP else "down" if text in _DOWN else ("unknown" if text else None)
    feeds = _pick(data, "pdu", "connections.pdu", "pdu_outlets", "power.outlets") or []
    pdu_ids = set()
    for feed in feeds if isinstance(feeds, list) else []:
        if isinstance(feed, dict):
            feed_id = feed.get("device_id", feed.get("pdu_id", feed.get("id")))
            if feed_id is not None:
                pdu_ids.add(_text(feed_id, 120).casefold())
    return {"status": status, "in_use": True if _owner_of(data) else None, "pdu_ids": pdu_ids,
            "ambiguous": False, "maintenance": bool(data.get("maintenance"))}


def _redundancy(entry: dict, target_kind: str, target_keys: set[str], status_pdu_ids: set[str] | None) -> str:
    """possible | none_known | unknown | not_applicable for one affected server."""
    if target_kind == "pdu":
        known = set(status_pdu_ids or set()) | entry["_feeds"]
        if known - target_keys:
            return "possible"
        if status_pdu_ids:
            return "none_known"
        return "unknown"
    if target_kind == "switch":
        return "unknown"        # alternative switch links are not stored
    if target_kind == "server":
        feeds = set(status_pdu_ids or set()) | entry["_feeds"]
        return "possible" if len(feeds) > 1 or entry["hint"] else "unknown"
    return "not_applicable"


# --------------------------------------------------------------------------------------------------------------
# Topology: ONE short read-only session over recorded port associations and owner names (no per-item fan-out)
# --------------------------------------------------------------------------------------------------------------
def build_topology(index: Any, owner_rows: Any = ()) -> dict:
    """monitor_links.connection_index output + (asset_key, owner name) rows -> lookup tables.

    servers     {canonical key: {"key", "pdu": [connection], "kvm": [connection]}}
    devices     {device id casefolded: {"id", "kind", "name", "servers": [{"key", "port", "status"}]}}
    owner_keys  every key of a server asset that has a registered owner (names are not kept)
    Device addresses present in the index are never copied.
    """
    servers: dict[str, dict] = {}
    devices: dict[str, dict] = {}
    newest = None
    stale = 0
    for raw_key, connections in (index.items() if isinstance(index, dict) else ()):
        key = canonical_key(raw_key)
        if not key or not isinstance(connections, dict):
            continue
        entry = servers.setdefault(key, {"key": key, "pdu": [], "kvm": []})
        for kind in ("pdu", "kvm"):
            for connection in connections.get(kind) or []:
                if not isinstance(connection, dict) or connection.get("device_id") is None:
                    continue
                device_id = _text(connection["device_id"], 120)
                checked = to_epoch(connection.get("checked_at"))
                status = _text(connection.get("status"), 20).lower() or "unknown"
                view = {"device_id": device_id, "device_name": _text(connection.get("device_name"), 120),
                        "port": _text(connection.get("port"), 20), "status": status, "checked_at": _iso_of(checked)}
                entry[kind].append(view)
                device = devices.setdefault(device_id.casefold(), {"id": device_id, "kind": kind,
                                                                   "name": view["device_name"], "servers": []})
                device["servers"].append({"key": key, "port": view["port"], "status": status})
                if checked is not None:
                    newest = checked if newest is None else max(newest, checked)
                stale += status == "stale"
    owner_keys: set[str] = set()
    for row in owner_rows or ():
        try:
            asset_key, name = row[0], row[1]
        except (TypeError, IndexError, KeyError):
            continue
        if isinstance(asset_key, str) and not asset_key.startswith("item:") and _text(name):
            owner_keys |= entity_keys(asset_key)
    return {"servers": servers, "devices": devices, "owner_keys": owner_keys, "newest_checked_at": newest,
            "stale_connections": stale}


def _topology_server(topology: dict | None, keys: set[str]) -> dict | None:
    servers = (topology or {}).get("servers") or {}
    return next((servers[k] for k in keys if k in servers), None)


def _registered_owner(topology: dict | None, keys: set[str]) -> bool | None:
    """True when an owner is registered; None (unknown) otherwise - never False."""
    return True if topology and keys & topology.get("owner_keys", set()) else None


async def read_topology(ctx: ToolContext) -> tuple[dict | None, list[Source]]:
    """One short read-only DB session: monitor_links.connection_index plus owner names.

    This is the same recorded data GET /api/monitoring and GET /api/engineers show a Viewer. It never contacts a
    device, never refreshes a cache and never writes. Database errors make the source "unavailable".
    """
    from zoneinfo import ZoneInfo

    from sqlalchemy import select
    from sqlalchemy.exc import SQLAlchemyError

    from .. import monitor_links
    from ..models import AssetOwner, Engineer

    zone_name = getattr(ctx.settings, "ping_monitor_timezone", None) if ctx.settings is not None else None
    try:
        zone = ZoneInfo(zone_name if isinstance(zone_name, str) and zone_name.strip() else "Asia/Jerusalem")
    except Exception:  # noqa: BLE001 - an invalid zone only changes the stale rule's slot alignment
        zone = ZoneInfo("UTC")

    def unavailable(note: str) -> tuple[None, list[Source]]:
        return None, [Source(id=TOPOLOGY_SOURCE_ID, name="Recorded PDU/KVM port associations",
                             ref="monitor_device_snapshots", status="unavailable", note=note),
                      Source(id=OWNERS_SOURCE_ID, name="Owner assignments (names only)", ref="asset_owners",
                             status="unavailable", note=note)]

    try:
        async with ctx.session_factory() as session:
            index = await monitor_links.connection_index(session, zone, ctx.now)
            rows = (await session.execute(
                select(AssetOwner.asset_key, AssetOwner.legacy_name, Engineer.name)
                .outerjoin(Engineer, Engineer.id == AssetOwner.engineer_id))).all()
    except SQLAlchemyError:
        return unavailable("Recorded associations are temporarily unavailable.")
    except (ValueError, TypeError, KeyError, AttributeError):
        return unavailable("Recorded port observations have an invalid format.")
    except Exception as exc:  # noqa: BLE001 - never leak internals; the analysis continues without topology
        log.warning("Assistant topology read failed (%s).", type(exc).__name__)
        return unavailable("Recorded associations could not be read.")
    topology = build_topology(index, [(key, name or legacy) for key, legacy, name in rows])
    newest = topology["newest_checked_at"]
    stale = topology["stale_connections"]
    return topology, [
        Source(id=TOPOLOGY_SOURCE_ID, name="Recorded PDU/KVM port associations", ref="monitor_device_snapshots",
               as_of=_iso_of(newest), age_s=age(newest, ctx.now), status="stale" if stale else "ok",
               note=(f"{stale} associations have overdue observations. " if stale else "")
               + "Saved labels and the latest scheduled device checks; no device was contacted."),
        Source(id=OWNERS_SOURCE_ID, name="Owner assignments (names only)", ref="asset_owners",
               note="Database owner assignments; an owner is read as 'in use'. Users are not linked to engineers."),
    ]


# --------------------------------------------------------------------------------------------------------------
# 1. Impact analysis
# --------------------------------------------------------------------------------------------------------------
def _server_target_entry(entity_id: str, deps: dict) -> dict:
    servers = deps.get("servers") if isinstance(deps.get("servers"), list) else []
    first = servers[0] if servers and isinstance(servers[0], dict) else {}
    server_id = canonical_key(first.get("server_key") or first.get("id") or entity_id)
    label = _text(first.get("label") or entity_id, 120)
    entry = {"kind": "server", "id": server_id, "label": label, "via": [], "feed_states": [],
             "in_use": True if (_owner_of(first) or _owner_of(deps)) else None, "hint": bool(deps.get("redundancy_hint")),
             "_feeds": set(), "_keys": entity_keys(server_id, label, entity_id)}
    for connection in deps.get("connections") or []:
        if not isinstance(connection, dict) or _text(connection.get("kind"), 20).lower() != "pdu":
            continue
        if connection.get("device_id") is not None:
            entry["_feeds"].add(_text(connection["device_id"], 120).casefold())
        port = _text(connection.get("port"), 20)
        via = f"{_text(connection.get('device_name'), 60)} outlet {port}".strip()
        if port and via not in entry["via"]:
            entry["via"].append(via)
        state = _text(connection.get("state"), 20).lower()
        if state in _FEED_STATES and state not in entry["feed_states"]:
            entry["feed_states"].append(state)
    return entry


def analyze_impact_data(kind: str, entity_id: str, dependencies: Any, problems: list[dict] | None = None,
                        topology: dict | None = None, server_status: Any = None, *,
                        dependency_source_ids: list[str] | tuple = (), problem_source_ids: list[str] | tuple = (),
                        topology_source_ids: list[str] | tuple = (), status_source_ids: list[str] | tuple = ()) -> dict:
    """Impact of a failure of one PDU / KVM / switch / rack / server.

    dependencies   get_dependencies data for (kind, entity_id) - who depends on the entity
    problems       normalize_problems(list_current_problems data), or None when that tool could not be read
    topology       build_topology(...) from the single read_topology session (alternative feeds, owners), or None
    server_status  get_server_status data, only for a server target
    """
    kind = (kind or "").lower()
    deps = dependencies if isinstance(dependencies, dict) else {}
    target_label = _text(_pick(deps, "entity.label", "entity.name") or entity_id, 120)
    target_keys = entity_keys(entity_id, target_label)
    if kind == "server":
        entry = _server_target_entry(entity_id, deps)
        target_keys |= entry["_keys"]
        servers, items = [entry], []
    else:
        servers, items = collect_dependents(deps, target_kind=kind, target_id=entity_id)
    summary = server_status_summary(server_status) if kind == "server" and server_status is not None else None

    target_problems: list[dict] = []
    server_problem_index: list[tuple[set[str], dict]] = []
    for problem in problems or []:
        keys = _problem_server_keys(problem)
        if keys:
            server_problem_index.append((keys, problem))
            continue
        ent = problem["entity"]
        same_kind = ent["kind"] == kind or (kind in ("pdu", "kvm") and ent["kind"] in _DEVICE_KINDS)
        if same_kind and entity_keys(ent["id"], ent["label"]) & target_keys:
            target_problems.append(problem)
        elif kind in ("pdu", "kvm") and ent["kind"] == "incident" and ent["id"].startswith(("device-api:", "power:")) \
                and ent["id"].split(":", 2)[1].casefold() in target_keys:
            target_problems.append(problem)

    outlet_off = {o for p in target_problems if "off" in p["kind"].lower() for o in p.get("outlets") or []}
    severities: list[str] = [p["severity"] for p in target_problems]
    plain_statuses: list[str] = []
    ranked: list[dict] = []
    counts = {"affected": len(servers), "down": 0, "problem": 0, "unknown": 0, "up": 0, "not_reported": 0,
              "no_data": 0}
    matched_topology = 0
    for entry in servers:
        matched = [p for keys, p in server_problem_index if keys & entry["_keys"]]
        topo = _topology_server(topology, entry["_keys"])
        source_ids: list[str] = []
        pdu_ids: set[str] | None = None
        if topo is not None:
            matched_topology += 1
            pdu_ids = {c["device_id"].casefold() for c in topo["pdu"]}
            source_ids.extend(topology_source_ids)
            if kind in ("pdu", "rack") and any(c["status"] == "off" and (kind == "rack" or c["device_id"].casefold()
                                                                         in target_keys) for c in topo["pdu"]):
                if "off" not in entry["feed_states"]:
                    entry["feed_states"].append("off")
        if _registered_owner(topology, entry["_keys"]):
            entry["in_use"] = True
        if summary is not None:
            source_ids.extend(status_source_ids)
            if summary["in_use"]:
                entry["in_use"] = True
            pdu_ids = (pdu_ids or set()) | summary["pdu_ids"]
        if matched:
            status = min((problem_status(p) for p in matched), key=lambda s: _STATUS_ORDER[s])
            status_source = "list_current_problems"
            item_severities, item_statuses = [p["severity"] for p in matched], []
            source_ids.extend(s for p in matched for s in [p.get("source_id"), *p.get("related_source_ids", [])] if s)
        elif summary is not None and summary["status"]:
            status, status_source = summary["status"], "get_server_status"
            item_severities, item_statuses = [], [status]
        elif problems is not None:
            status, status_source = "not_reported", "list_current_problems"
            item_severities, item_statuses = [], [status]
        else:
            status, status_source = "no_data", None
            item_severities, item_statuses = [], [status]
        counts[status] = counts.get(status, 0) + 1
        severities.extend(item_severities)
        plain_statuses.extend(item_statuses)
        redundancy = _redundancy(entry, kind, target_keys, pdu_ids)
        entry["redundancy"] = redundancy
        # An alternative feed did not keep a server that is down now, so it never lowers that server's priority.
        entry["_scored_redundancy"] = "down" if status == "down" else redundancy
        scored = score_entity(kind=kind, severities=item_severities, statuses=item_statuses, affected_count=1,
                              in_use=[entry["in_use"]],
                              redundancy=[entry["_scored_redundancy"]] if kind in FEED_KINDS else [])
        reasons = list(scored["reasons"])
        via_ports = {v.rsplit(" ", 1)[-1] for v in entry["via"]}
        if "off" in entry["feed_states"] or (outlet_off & via_ports):
            reasons.append("השערה: PDU מדווח שקע כבוי עבור שרת זה — יש לאמת את מצב השקע בדף ה-PDU לפני כל פעולה")
        if summary and summary.get("maintenance"):
            reasons.append("PDU שמזין שרת זה נמצא בתחזוקה פעילה")
        ranked.append({
            "kind": "server", "id": entry["id"], "label": entry["label"], "via": entry["via"],
            "status": status, "status_text": _STATUS_HE.get(status, status), "status_source": status_source,
            "in_use": entry["in_use"], "redundancy": redundancy, "problems": [_problem_view(p) for p in matched][:5],
            "score": scored["score"], "priority": scored["priority"], "reasons": reasons,
            "source_ids": list(dict.fromkeys([*source_ids, *dependency_source_ids])),
        })
    ranked.sort(key=lambda r: (-r["score"], _STATUS_ORDER.get(r["status"], 9), r["label"].casefold()))
    for index, row in enumerate(ranked, 1):
        row["rank"] = index

    impact = score_entity(kind=kind, severities=severities, statuses=plain_statuses, affected_count=len(servers),
                          in_use=[s["in_use"] for s in servers],
                          redundancy=[s["_scored_redundancy"] for s in servers] if kind in FEED_KINDS else [])
    found = deps.get("found")
    notes = []
    if found is False:
        notes.append("הרכיב לא נמצא בטופולוגיה השמורה; ייתכן שהמזהה שגוי. מומלץ לאתר אותו קודם (resolve_entity).")
    if summary is not None and summary["status"] is None:
        notes.append("השרת לא זוהה באופן חד-ערכי בניטור; מצבו הנוכחי לא נקרא.")
    if not servers and kind != "server":
        notes.append("לא נמצאו שרתים תלויים ברכיב זה בנתונים השמורים; זה אינו מוכיח שאין תלויות.")
    if problems is None:
        notes.append("רשימת התקלות הנוכחיות לא הייתה זמינה; מצב השרתים חלקי.")
    if topology is None:
        notes.append("שיוכי השקעים והבעלים לא היו זמינים; יתירות ושימוש בשירות לא נבדקו.")
    if kind == "kvm":
        notes.append("תקלת KVM פוגעת בגישת קונסולה מרחוק, לא בהפעלת השרתים עצמם.")
    if kind == "switch":
        notes.append("נתוני המתג הם טקסט חופשי משיוכי מתג; מצב הקישורים אינו מנוטר.")
    if kind == "rack":
        notes.append("ניתוח ארון מניח תקלה בכל הציוד בארון; זה תרחיש חסם עליון ולא תחזית.")
    return {
        "target": {"kind": kind, "id": _text(entity_id, 120), "label": target_label},
        "effect": EFFECT.get(kind, kind),
        "found": found if isinstance(found, bool) else None,
        "target_problems": [_problem_view(p) for p in target_problems][:MAX_LIST],
        "counts": counts,
        "topology_matched": matched_topology,
        "impact": {**impact, "source_ids": list(dict.fromkeys([*dependency_source_ids, *problem_source_ids,
                                                                *(topology_source_ids if topology else ())]))},
        "ranked": ranked[:MAX_LIST],
        "affected_items": items[:MAX_LIST],
        "truncated": len(ranked) > MAX_LIST,
        "redundancy_note": REDUNDANCY_NOTE,
        "notes": notes,
        "formula": PRIORITY_FORMULA,
    }


# --------------------------------------------------------------------------------------------------------------
# 2. Capacity planning
# --------------------------------------------------------------------------------------------------------------
def parse_thresholds(raw: Any) -> dict[tuple[str, str], float]:
    """Configured inlet limits -> {(metric, side): value}. Entries marked as assumptions are ignored."""
    rules: dict[tuple[str, str], float] = {}

    def add(metric: Any, side: Any, value: Any) -> None:
        metric, side, number = _text(metric, 20).lower(), _text(side, 10).lower(), _num(value)
        if metric in ("voltage", "current", "watts") and side in ("min", "max") and number is not None:
            rules.setdefault((metric, side), number)

    def walk(node: Any, depth: int) -> None:
        if depth > 4:
            return
        if isinstance(node, (list, tuple)):
            if len(node) == 3 and all(not isinstance(v, (dict, list)) for v in node):
                add(*node)
                return
            for value in node:
                walk(value, depth + 1)
        elif isinstance(node, dict):
            origin = " ".join(_text(node.get(k), 80) for k in ("source", "kind", "origin", "type")).lower()
            if "assum" in origin or "ui" in origin.split():
                return
            if "metric" in node:
                add(node.get("metric"), node.get("side"), node.get("value", node.get("limit")))
                return
            for key, value in node.items():
                match = re.fullmatch(r"(voltage|current|watts)_(min|max)", str(key).lower())
                if match:
                    add(match[1], match[2], value)
                elif str(key).lower() in ("voltage", "current", "watts") and isinstance(value, dict):
                    for side in ("min", "max"):
                        add(key, side, value.get(side))
                elif isinstance(value, (dict, list)) and str(key).lower() != "assumption":
                    walk(value, depth + 1)

    walk(raw, 0)
    return rules


def normalize_pdus(power: Any, rack: str | None = None) -> list[dict]:
    """PDUs of get_power_and_environment data, de-duplicated by PDU id (a shared PDU is counted once)."""
    rows = _pick(power, "pdus", "devices") or []
    if isinstance(rows, dict):
        rows = [dict(v, id=v.get("id", k)) for k, v in rows.items() if isinstance(v, dict)]
    result: list[dict] = []
    seen: set[str] = set()
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        pdu_id = _text(_pick(row, "id", "pdu_id", "device_id", "name"), 120)
        if not pdu_id or pdu_id.casefold() in seen:
            continue
        seen.add(pdu_id.casefold())
        live = next((row[k] for k in ("live", "cache", "readings") if isinstance(row.get(k), dict)), {})

        def first(*keys: str) -> Any:
            value = _pick(row, *keys)
            return value if value is not None else _pick(live, *keys)

        inlets = []
        for inlet in first("inlet_readings", "inlets") or []:
            if isinstance(inlet, dict):
                inlets.append({"number": _text(inlet.get("number", inlet.get("inlet")), 20) or None,
                               "current": _num(inlet.get("current")), "voltage": _num(inlet.get("voltage")),
                               "watts": _num(_pick(inlet, "watts", "active_power", "power_w"))})
        age_s = _num(first("cache_age_s", "live_age_s", "age_s", "readings_age_s"))
        reachable = first("cache_reachable", "reachable")
        stale_reasons = []
        if any(v is True for v in (row.get("stale"), live.get("stale"), row.get("live_stale"))) or \
                _text(row.get("status") or live.get("status"), 20).lower() == "stale":
            stale_reasons.append("flagged stale by the data source")
        if reachable is False:
            stale_reasons.append("PDU unreachable")
        if age_s is not None and age_s > READING_FRESH_S:
            stale_reasons.append(f"older than {READING_FRESH_S // 60} minutes")
        environment = first("environment", "env", "sensors")
        environment = environment if isinstance(environment, dict) else {}
        temperature = _num(_pick(environment, "temperature", "temperature_c"))
        if temperature is None:
            temperature = _num(first("temperature", "temperature_c"))
        env_age = _num(_pick(environment, "age_s"))
        env_stale = bool(stale_reasons) or environment.get("stale") is True
        shared_racks = [r for r in (row.get("shared_racks") or []) if isinstance(r, str)]
        own_rack = _text(row.get("rack"), 80) or None
        shared = bool(shared_racks) or row.get("shared") is True or \
            bool(rack and own_rack and own_rack.casefold() != rack.casefold())
        outlets = first("outlets") or []
        unlabeled = None
        if isinstance(outlets, list) and outlets:
            unlabeled = sum(1 for o in outlets if isinstance(o, dict) and
                            _DEFAULT_PORT_LABEL.fullmatch(_text(o.get("label"), 60)))
        result.append({
            "id": pdu_id, "name": _text(row.get("name") or pdu_id, 120), "rack": own_rack, "shared": shared,
            "shared_racks": shared_racks[:10], "reachable": reachable if isinstance(reachable, bool) else None,
            "stale": bool(stale_reasons), "stale_reasons": stale_reasons, "age_s": age_s,
            "as_of": _iso_of(first("cache_as_of", "as_of", "checked_at")),
            "inlets": inlets, "total_watts": _num(first("total_watts")),
            "watts_complete": first("watts_complete") is True,
            "temperature": temperature, "env_age_s": env_age if env_age is not None else age_s,
            "env_stale": env_stale, "unlabeled_outlets": unlabeled,
        })
    return result


def _evaluate_pdu(pdu: dict, rules: dict, power_w: float | None) -> dict:
    """Headroom of one PDU on its limiting basis. Unknown or stale readings never produce "ok"."""
    inlets = pdu["inlets"]
    volts = [i["voltage"] for i in inlets if i["voltage"] is not None and i["voltage"] > 0]
    voltage = sum(volts) / len(volts) if volts else None
    v_eff = voltage if voltage else UI_VOLTAGE
    load_w, load_source = None, None
    if inlets and all(i["watts"] is not None for i in inlets):
        load_w, load_source = sum(i["watts"] for i in inlets), "inlet readings"
    elif pdu["watts_complete"] and pdu["total_watts"] is not None:
        load_w, load_source = pdu["total_watts"], "sum of outlet readings"
    if inlets and all(i["current"] is not None for i in inlets):
        load_a, amps_estimated = sum(i["current"] for i in inlets), False
    elif load_w is not None:
        load_a, amps_estimated = load_w / v_eff, True
    else:
        load_a, amps_estimated = None, False

    reasons: list[str] = []
    current_max, watts_max = rules.get(("current", "max")), rules.get(("watts", "max"))
    if current_max is not None:
        threshold_source = "configured: EMAIL_CURRENT_MAX per inlet"
        currents = [i["current"] for i in inlets]
        used_w = max(currents) * v_eff if currents and all(c is not None for c in currents) else None
        limit_w = current_max * v_eff
        basis = f"הזרם במבוא העמוס ביותר מול הסף המוגדר {_fmt(current_max)} A"
    elif watts_max is not None:
        threshold_source = "configured: EMAIL_WATTS_MAX per inlet"
        watts = [i["watts"] for i in inlets]
        used_w = max(watts) if watts and all(w is not None for w in watts) else None
        limit_w = watts_max
        basis = f"ההספק במבוא העמוס ביותר מול הסף המוגדר {_fmt(watts_max)} W"
    else:
        threshold_source = UI_POWER_ASSUMPTION
        used_w = load_a * v_eff if load_a is not None else None
        limit_w = UI_RATED_AMPS * v_eff
        basis = "עומס ה-PDU מול 16 A (הנחה: קבוע ממשק, לא סף מוגדר)"

    headroom_w = ratio_now = ratio_after = None
    if pdu["stale"]:
        verdict = "unknown"
        reasons.append("קריאות ה-PDU ישנות או לא זמינות (" + ", ".join(pdu["stale_reasons"]) + ") — לא ניתן לקבוע מרווח")
    elif used_w is None:
        verdict = "unknown"
        reasons.append("אין קריאת עומס מלאה מה-PDU (ערך חסר אינו 0) — לא ניתן לקבוע מרווח")
    else:
        headroom_w = limit_w - used_w
        ratio_now = used_w / limit_w if limit_w else None
        if power_w is not None and limit_w:
            ratio_after = (used_w + power_w) / limit_w
        ratio = ratio_after if ratio_after is not None else ratio_now
        if ratio is None:
            verdict = "unknown"
        elif ratio > 1.0:
            verdict = "over"
        elif ratio > LOAD_TIGHT_RATIO:
            verdict = "tight"
        elif power_w is None:
            verdict = "unknown"
        else:
            verdict = "ok"
        reasons.append(f"{basis}: בשימוש כ-{_fmt(used_w)} W מתוך {_fmt(limit_w)} W, מרווח כ-{_fmt(headroom_w)} W")
        if power_w is not None:
            reasons.append(f"אחרי הוספת {_fmt(power_w)} W העומס יהיה כ-{_fmt(ratio_after * 100 if ratio_after is not None else None)}%")
        if voltage is None:
            reasons.append("המתח לא נמדד — הנחה 208 V (קבוע ממשק)")
        if amps_estimated and current_max is None and watts_max is None:
            reasons.append("הזרם חושב מההספק ולא נמדד ישירות")
    if pdu["shared"]:
        reasons.append("PDU משותף עם ארון אחר: העומס כולל ציוד מארונות אחרים ונספר פעם אחת בלבד")
    return {
        "id": pdu["id"], "name": pdu["name"], "rack": pdu["rack"], "shared": pdu["shared"],
        "reachable": pdu["reachable"], "stale": pdu["stale"], "age_s": pdu["age_s"], "as_of": pdu["as_of"],
        "load_w": _round(load_w), "load_source": load_source, "load_a": _round(load_a, 2),
        "voltage": _round(voltage), "voltage_assumed": voltage is None,
        "limit_w": _round(limit_w), "used_w_on_limit_basis": _round(used_w), "headroom_w": _round(headroom_w),
        "load_ratio_now": _round(ratio_now, 3), "load_ratio_after": _round(ratio_after, 3),
        "verdict": verdict, "threshold_source": threshold_source,
        "unlabeled_outlets_hint": pdu["unlabeled_outlets"], "reasons": reasons,
    }


def _collect_switches(*datasets: Any) -> dict[str, int]:
    """Free-text switch names -> number of distinct servers assigned to them (presence only)."""
    servers_by_switch: dict[str, set[str]] = {}

    def walk(node: Any, depth: int) -> None:
        if depth > 8:
            return
        if isinstance(node, list):
            for value in node:
                walk(value, depth + 1)
        elif isinstance(node, dict):
            name = node.get("switch") if isinstance(node.get("switch"), str) else node.get("switch_name")
            if isinstance(name, str) and name.strip():
                server = _text(node.get("server_key") or node.get("key") or node.get("label") or "?", 120).casefold()
                servers_by_switch.setdefault(_text(name, 80), set()).add(server)
            for key, value in node.items():
                if key not in ("candidates", "sources", "caveats") and isinstance(value, (dict, list)):
                    walk(value, depth + 1)

    for data in datasets:
        walk(data, 0)
    return {name: len(members) for name, members in sorted(servers_by_switch.items())}


def _dimension(verdict: str, reasons: list[str], source_ids: list[str] | tuple = (), confidence: str = "low",
               **extra: Any) -> dict:
    return {"verdict": verdict, "confidence": confidence, "reasons": reasons,
            "source_ids": list(dict.fromkeys(source_ids)), **extra}


def plan_capacity_data(rack: str, *, layout: Any = None, power: Any = None, dependencies: Any = None,
                       power_w: float | None = None, units: int | None = None, needs_network: bool | None = None,
                       thresholds: dict[tuple[str, str], float] | None = None,
                       source_ids: dict[str, list[str]] | None = None) -> dict:
    """Can equipment be added to `rack`? One verdict per dimension (ok | tight | over | unknown) plus missing info.

    The overall answer is "yes" only when every dimension is "ok"; any "over" -> "no"; otherwise "conditional".
    Because the system stores no weight or cabling data, the overall answer is in practice never a plain "yes".
    """
    ids = source_ids or {}
    layout_ids, power_ids, dep_ids = ids.get("layout", []), ids.get("power", []), ids.get("dependencies", [])
    missing: list[str] = []
    assumptions: list[str] = []
    dims: dict[str, dict] = {}

    # Space -------------------------------------------------------------------------------------------------
    need = units if isinstance(units, int) and not isinstance(units, bool) and units > 0 else 1
    if units is None:
        assumptions.append("הנחה: נדרש מקום אחד (מדף אחד) כי לא צוין מספר יחידות")
    if not isinstance(layout, dict):
        dims["space"] = _dimension("unknown", ["נתוני פריסת הארון לא זמינים"], layout_ids)
        missing.append("פריסת הארון ומדפים פנויים")
    else:
        raw = _pick(layout, "free_shelves", "free_positions", "free_slots", "space.free_shelves")
        confidence = _text(_pick(layout, "free_shelves_confidence", "mapping_confidence", "confidence") or "low", 20).lower()
        free_list = None
        if isinstance(raw, dict):
            free_count = _num(raw.get("count"))
            free_list = raw.get("shelves") or raw.get("positions")
        elif isinstance(raw, list):
            free_count, free_list = float(len(raw)), raw
        else:
            free_count = _num(raw)
        shelf_count = _num(_pick(layout, "shelf_count", "shelves_count"))
        if free_count is None:
            dims["space"] = _dimension("unknown", ["מספר המדפים הפנויים לא ידוע (מקורות מיקום חסרים או מיפוי לא חד-ערכי)"],
                                       layout_ids, shelf_count=shelf_count, needed=need)
            missing.append("מדפים פנויים בארון (מיפוי מלא של מיקומי הציוד)")
        else:
            free = int(free_count)
            verdict = "over" if free < need else "tight" if free == need else "ok"
            reasons = [f"מדפים פנויים לפי מודל התאום: {free} (נדרשים {need}); רמת ביטחון במיפוי: {confidence}",
                       "U כאן הוא מספר מדף מלמעלה, לא יחידת U תקנית; אין נתוני גובה או עומק לציוד"]
            dims["space"] = _dimension(verdict, reasons, layout_ids, confidence=confidence if confidence else "low",
                                       free_shelves=[_text(v, 20) for v in (free_list or [])][:MAX_LIST],
                                       free_count=free, shelf_count=shelf_count, needed=need)
            if confidence != "high":
                missing.append("אימות פיזי של המקום הפנוי בארון (מיפוי התאום ברמת ביטחון נמוכה)")

    # Power -------------------------------------------------------------------------------------------------
    pdus = normalize_pdus(power, rack)
    rules = dict(thresholds or {})
    if not rules:
        rules = parse_thresholds(_pick(power, "thresholds", "power_rules", "configured_thresholds"))
    evaluated = [_evaluate_pdu(p, rules, power_w) for p in pdus]
    known_loads = [p["load_w"] for p in evaluated if p["load_w"] is not None and not p["stale"]]
    rack_total = round(sum(known_loads), 1) if known_loads else None
    total_complete = bool(evaluated) and len(known_loads) == len(evaluated)
    threshold_sources = sorted({p["threshold_source"] for p in evaluated})
    if UI_POWER_ASSUMPTION in threshold_sources or not rules:
        assumptions.append(UI_POWER_ASSUMPTION_HE)
    assumptions.append(LOAD_ASSUMPTION_HE)
    verdicts = [p["verdict"] for p in evaluated]
    best = max((p for p in evaluated if p["verdict"] == "ok"), key=lambda p: p["headroom_w"] or 0, default=None)
    if not evaluated:
        power_verdict, power_reasons = "unknown", ["לא נמצא PDU המשויך לארון (כולל PDU משותף)"]
        missing.append("שיוך PDU לארון וקריאות עומס")
    elif power_w is None:
        power_verdict = "over" if verdicts and all(v == "over" for v in verdicts) else "unknown"
        power_reasons = ["לא צוינה צריכת ההספק של הציוד החדש — לא ניתן לקבוע אם יש מספיק מרווח"]
        missing.append("צריכת ההספק של הציוד החדש (W)")
    elif best is not None:
        power_verdict = "ok"
        power_reasons = [f"ל-PDU {best['name']} יש מרווח מספיק לפי הקריאה האחרונה"]
    elif "unknown" in verdicts:
        power_verdict = "unknown"
        power_reasons = ["אין PDU עם קריאת עומס עדכנית ומלאה שמאשרת מרווח מספיק"]
    elif "tight" in verdicts:
        power_verdict, power_reasons = "tight", ["הוספת הציוד תעלה את העומס מעל 80% בכל PDU ידוע"]
    else:
        power_verdict, power_reasons = "over", ["הוספת הציוד תחרוג מהמגבלה בכל PDU ידוע"]
    if evaluated and any(p["verdict"] == "unknown" for p in evaluated):
        missing.append("קריאות עומס עדכניות ומלאות לכל ה-PDU של הארון")
    power_reasons.append(
        "סך העומס הידוע בארון: " + (f"{_fmt(rack_total)} W" if rack_total is not None else "לא ידוע")
        + ("" if total_complete else " (חלקי — חלק מהקריאות חסרות או ישנות)")
        + "; כל PDU נספר פעם אחת לפי מזהה, וקריאות מבוא אינן מחוברות לסכום השקעים")
    dims["power"] = _dimension(power_verdict, power_reasons, power_ids, pdus=evaluated,
                               rack_total_w=rack_total, rack_total_complete=total_complete,
                               threshold_source=threshold_sources[0] if len(threshold_sources) == 1 else threshold_sources,
                               requested_w=power_w, load_rule=LOAD_ASSUMPTION)

    # Cooling -----------------------------------------------------------------------------------------------
    fresh = [(p["temperature"], p) for p in pdus if p["temperature"] is not None and not p["env_stale"]
             and p["env_age_s"] is not None and p["env_age_s"] <= READING_FRESH_S]
    chillers = [c for c in (_pick(power, "chillers") or []) if isinstance(c, dict)]
    chiller_names = [_text(c.get("name") or c.get("id"), 60) for c in chillers
                     if not c.get("rack") or _text(c.get("rack"), 80).casefold() == (rack or "").casefold()]
    if not fresh:
        cooling_reasons = ["אין נתוני קירור: אין קריאת טמפרטורה עדכנית מחיישני ה-PDU, ואין טלמטריית קירור במערכת"]
        dims["cooling"] = _dimension("unknown", cooling_reasons, power_ids, chillers=chiller_names[:10])
        missing.append("נתוני קירור/טמפרטורה עדכניים לארון")
    else:
        hottest, source_pdu = max(fresh, key=lambda pair: pair[0])
        verdict = "over" if hottest > TEMP_OVER_C else "tight" if hottest > TEMP_TIGHT_C else "ok"
        cooling_reasons = [f"הטמפרטורה הגבוהה בחיישני ה-PDU: {_fmt(hottest)} °C ({source_pdu['name']}, לפני "
                           f"{_fmt(source_pdu['env_age_s'])} שניות)",
                           "חיישן PDU בלבד — אין מדידת קיבולת קירור או זרימת אוויר"]
        dims["cooling"] = _dimension(verdict, cooling_reasons, power_ids, max_temperature_c=hottest,
                                     chillers=chiller_names[:10], threshold_source=TEMP_ASSUMPTION)
        assumptions.append(TEMP_ASSUMPTION_HE)
        missing.append("קיבולת הקירור של הארון (קיימים רק חיישני טמפרטורה של PDU)")
    if chiller_names:
        dims["cooling"]["reasons"].append("מזגנים/צ'ילרים משויכים: " + ", ".join(chiller_names[:5])
                                          + " (מיקום בלבד, ללא טלמטריה)")

    # Network -----------------------------------------------------------------------------------------------
    if needs_network is False:
        dims["network"] = _dimension("ok", ["לא נדרש חיבור רשת לפי הבקשה"], (), confidence="high")
    else:
        if needs_network is None:
            assumptions.append("הנחה: הציוד צריך חיבור רשת (לא צוין)")
        switches = _collect_switches(dependencies, layout)
        if switches:
            listed = ", ".join(f"{name} ({count} שרתים)" for name, count in list(switches.items())[:5])
            network_reasons = [f"שיוכי מתג קיימים בארון: {listed}",
                               "זמינות פורטים, VLAN ומצב קישורים אינם נשמרים במערכת"]
        else:
            network_reasons = ["אין שיוכי מתג לשרתי הארון במערכת"]
        dims["network"] = _dimension("unknown", network_reasons, [*dep_ids, *layout_ids], switches=switches)
        missing.append("פורטים פנויים במתג וחיבור רשת לארון")

    # Redundancy --------------------------------------------------------------------------------------------
    pdu_ids = {p["id"].casefold() for p in pdus}
    for entry in _pick(dependencies, "pdus") or []:
        if isinstance(entry, dict) and entry.get("id") is not None:
            pdu_ids.add(_text(entry["id"], 120).casefold())
    feeds = len(pdu_ids)
    if feeds >= 2:
        dims["redundancy"] = _dimension("ok", [f"{feeds} יחידות PDU זמינות לארון (כולל משותפות) — ייתכן חיבור כפול",
                                               "הזנות A/B ו-UPS אינן מתועדות במערכת; היתירות לא אומתה"],
                                        [*power_ids, *dep_ids], pdu_count=feeds)
        missing.append("אימות הזנות A/B ו-UPS עבור ה-PDU של הארון")
    elif feeds == 1:
        dims["redundancy"] = _dimension("tight", ["PDU יחיד לארון — אין מקור הזנה חלופי ידוע"],
                                        [*power_ids, *dep_ids], pdu_count=1)
    else:
        dims["redundancy"] = _dimension("unknown", ["לא נמצא PDU לארון, לכן אין מידע על יתירות"],
                                        [*power_ids, *dep_ids], pdu_count=0)

    # Weight and cabling: not stored anywhere ------------------------------------------------------------------
    dims["weight"] = _dimension("unknown", ["אין נתוני משקל במערכת"], ())
    missing.append("משקל הציוד והעומס המותר על המדף והארון")
    dims["cabling"] = _dimension("unknown", ["אין נתוני כבילה במערכת"], ())
    missing.append("תוואי כבילה ואורכי כבלים")

    all_verdicts = {name: dims[name]["verdict"] for name in DIMENSIONS}
    over = [name for name, v in all_verdicts.items() if v == "over"]
    open_dims = [name for name, v in all_verdicts.items() if v in ("unknown", "tight")]
    if over:
        overall = "no"
        overall_text = "לא מומלץ בתנאים הנוכחיים: חריגה בממדים: " + ", ".join(_DIMENSION_HE[n] for n in over)
    elif open_dims:
        overall = "conditional"
        overall_text = ("מותנה — אין אישור מלא: חסר מידע או שהמרווח צר בממדים: " + ", ".join(_DIMENSION_HE[n] for n in open_dims))
    else:
        overall = "yes"
        overall_text = "כל הממדים שנבדקו תקינים לפי הנתונים הקיימים"
    return {
        "rack": _text(rack, 80),
        "request": {"power_w": power_w, "units": units, "needs_network": needs_network},
        "overall": overall, "overall_text": overall_text,
        "verdicts": all_verdicts,
        "dimensions": {name: dims[name] for name in DIMENSIONS},
        "missing_info": list(dict.fromkeys(missing)),
        "assumptions": list(dict.fromkeys(assumptions)),
    }


# --------------------------------------------------------------------------------------------------------------
# 3. Event correlation
# --------------------------------------------------------------------------------------------------------------
_EVENT_TIME_KEYS = ("at_iso", "time_iso", "start_iso", "since_iso", "first_failed_at", "started_at", "at", "time",
                    "timestamp", "created_at", "ts")
_EVENT_LIST_KEYS = (("incidents", "ping_incident"), ("maintenance", "pdu_maintenance"),
                    ("maintenance_log", "pdu_maintenance"), ("alert_emails", "alert_email"),
                    ("moves", "rack_item_move"), ("rack_item_moves", "rack_item_move"))


def normalize_events(history: Any) -> tuple[list[dict], int]:
    """get_history data -> (events sorted oldest first, number of events without a usable time)."""
    rows: list[tuple[str | None, Any]] = []
    if isinstance(history, dict):
        for key in ("items", "events", "timeline"):
            if isinstance(history.get(key), list) and history[key]:
                rows = [(None, e) for e in history[key]]
                break
        if not rows:
            for key, default_kind in _EVENT_LIST_KEYS:
                if isinstance(history.get(key), list):
                    rows.extend((default_kind, e) for e in history[key])
    elif isinstance(history, list):
        rows = [(None, e) for e in history]
    events: list[dict] = []
    undated = 0
    used_ids: set[str] = set()
    for index, (default_kind, row) in enumerate(rows):
        if not isinstance(row, dict):
            continue
        stamp = None
        for key in _EVENT_TIME_KEYS:
            stamp = to_epoch(row.get(key))
            if stamp is not None:
                break
        if stamp is None and isinstance(row.get("incident"), dict):
            stamp = to_epoch(row["incident"].get("first_failed_at"))
        if stamp is None:
            undated += 1
            continue
        kind = _text(row.get("kind") or row.get("type") or default_kind or "event", 40)
        incident = row.get("incident") if isinstance(row.get("incident"), dict) else {}
        entity = row.get("entity") if isinstance(row.get("entity"), dict) else {}
        entity_id = _text(entity.get("id") or row.get("server") or row.get("target_id") or incident.get("target_id")
                          or row.get("device_id") or row.get("item_id"), 120)
        entity_label = _text(entity.get("label") or row.get("server_label") or row.get("label") or entity_id, 120)
        action = _text(row.get("action") or row.get("event"), 40)
        label = _text(row.get("title") or row.get("subject") or row.get("summary") or row.get("detail") or kind, 160)
        event_id = _text(row.get("id") or row.get("event_id"), 120) or f"event:{index + 1}"
        while event_id in used_ids:
            event_id += "+"
        used_ids.add(event_id)
        events.append({"id": event_id, "kind": kind, "action": action or None, "t": stamp, "at_iso": iso(stamp),
                       "entity": {"id": entity_id, "label": entity_label} if entity_id or entity_label else None,
                       "label": label, "source_id": _text(row.get("source_id"), 120) or None})
    events.sort(key=lambda e: (e["t"], e["id"]))
    return events, undated


def _period_text(hours: float) -> str:
    if hours < 24:
        return f"ב-{_fmt(hours)} שעות"
    days = hours / 24
    return "ביום אחד" if days == 1 else f"ב-{_fmt(round(days, 1))} ימים"


def recurrence_text(count: int, hours: float) -> str:
    """'קרה N פעמים ב-X ימים' (the window, not the span between occurrences)."""
    return f"קרה פעם אחת {_period_text(hours)}" if count == 1 else f"קרה {count} פעמים {_period_text(hours)}"


def correlate_events_data(history: Any, *, since_hours: float = DEFAULT_HISTORY_HOURS, now: float | None = None,
                          focus_history: Any = None, window_s: int = CORRELATION_WINDOW_S) -> dict:
    """Group events whose start times are within ±window_s of a neighbour and count recurrences.

    Groups are chained: an event joins the current group when it starts at most `window_s` after the previous event
    of that group. Every group is labelled co_occurred with the explicit non-causal sentence. With `focus_history`
    (the server/device-filtered history) only groups containing a focus event are returned and recurrences are
    counted for the focus events only.
    """
    hours = float(max(1, min(MAX_HISTORY_HOURS, since_hours)))
    events, undated = normalize_events(history)
    focus_ids: set[str] = set()
    if focus_history is not None:
        focus_events, focus_undated = normalize_events(focus_history)
        undated += focus_undated
        known = {(e["id"], e["t"]) for e in events}
        for event in focus_events:
            focus_ids.add(event["id"])
            if (event["id"], event["t"]) not in known:
                events.append(event)
        events.sort(key=lambda e: (e["t"], e["id"]))
    outside = 0
    if now is not None:
        start = float(now) - hours * 3600
        kept = [e for e in events if start <= e["t"] <= float(now) + 60]
        outside = len(events) - len(kept)
        events = kept

    for event in events:
        event["co_occurred_with"] = [o["id"] for o in events
                                     if o is not event and abs(o["t"] - event["t"]) <= window_s][:20]
    groups: list[list[dict]] = []
    current: list[dict] = []
    for event in events:
        if current and event["t"] - current[-1]["t"] <= window_s:
            current.append(event)
        else:
            if len(current) > 1:
                groups.append(current)
            current = [event]
    if len(current) > 1:
        groups.append(current)
    if focus_ids:
        groups = [g for g in groups if any(e["id"] in focus_ids for e in g)]

    group_views = []
    for number, group in enumerate(groups, 1):
        entities = list(dict.fromkeys(e["entity"]["label"] for e in group if e["entity"] and e["entity"]["label"]))
        group_views.append({
            "id": f"group:{number}", "co_occurred": True, "note": NON_CAUSAL_NOTE,
            "start_iso": group[0]["at_iso"], "end_iso": group[-1]["at_iso"],
            "span_s": round(group[-1]["t"] - group[0]["t"], 1), "event_ids": [e["id"] for e in group],
            "kinds": sorted({e["kind"] for e in group}), "entities": entities[:20],
            "events": [{k: e[k] for k in ("id", "kind", "action", "at_iso", "entity", "label", "source_id")}
                       for e in group[:20]],
            "source_ids": list(dict.fromkeys(e["source_id"] for e in group if e["source_id"])),
        })

    counted = [e for e in events if not focus_ids or e["id"] in focus_ids]
    signatures: dict[tuple, list[dict]] = {}
    for event in counted:
        entity_key = canonical_key(event["entity"]["id"] or event["entity"]["label"]) if event["entity"] else ""
        signature = (event["kind"].casefold(), (event["action"] or "").casefold(),
                     entity_key or event["label"].casefold())
        signatures.setdefault(signature, []).append(event)
    recurrence = []
    for members in signatures.values():
        first = members[0]
        recurrence.append({
            "kind": first["kind"], "action": first["action"], "entity": first["entity"],
            "label": first["label"], "count": len(members), "recurring": len(members) > 1,
            "text": recurrence_text(len(members), hours), "first_iso": members[0]["at_iso"],
            "last_iso": members[-1]["at_iso"],
            "source_ids": list(dict.fromkeys(e["source_id"] for e in members if e["source_id"])),
        })
    recurrence.sort(key=lambda r: (-r["count"], r["kind"], r["label"]))
    notes = [NON_CAUSAL_NOTE]
    if not events:
        notes.append("לא נמצאו אירועים בחלון הזמן בנתונים השמורים; זה אינו מוכיח שלא היו תקלות "
                     "(ניטור הלילה כל 30 דקות עלול לפספס תקלות קצרות).")
    return {
        "window": {"since_hours": hours, "window_s": window_s,
                   "rule": "events whose start times are within 10 minutes of the previous event are grouped"},
        "focus": bool(focus_ids) or focus_history is not None,
        "events_count": len(events), "undated_count": undated, "outside_window_count": outside,
        "groups": group_views[:MAX_LIST],
        "recurrence": recurrence[:MAX_LIST],
        "events": [{k: e[k] for k in ("id", "kind", "action", "at_iso", "entity", "label", "source_id",
                                       "co_occurred_with")} | {"focus": e["id"] in focus_ids}
                   for e in sorted(events, key=lambda e: -e["t"])[:MAX_EVENTS_OUT]],
        "truncated": len(events) > MAX_EVENTS_OUT or len(group_views) > MAX_LIST,
        "causality_note": NON_CAUSAL_NOTE,
        "notes": notes,
    }


# --------------------------------------------------------------------------------------------------------------
# 4. Problem prioritisation
# --------------------------------------------------------------------------------------------------------------
def group_problems(problems: list[dict]) -> dict[str, dict]:
    """Problems grouped per real-world entity (see problem_group_key)."""
    groups: dict[str, dict] = {}
    concrete_kinds = _SERVER_KINDS | {"pdu", "kvm"}
    for index, problem in enumerate(problems):
        key = problem_group_key(problem, index)
        group = groups.setdefault(key, {"key": key, "entity": None, "problems": []})
        group["problems"].append(problem)
        entity = problem["entity"]
        if group["entity"] is not None and (group["entity"]["kind"] in concrete_kinds
                                            or entity["kind"] not in concrete_kinds):
            continue
        if entity["kind"] in concrete_kinds:
            group["entity"] = dict(entity)
        elif key.startswith("server:"):
            group["entity"] = {"kind": "server", "id": key[7:], "label": entity["label"]}
        elif key.startswith("device:"):
            group["entity"] = {"kind": "device", "id": key[7:], "label": entity["label"]}
        else:
            group["entity"] = dict(entity)
    return groups


def prioritize_problems_data(problems: list[dict], topology: dict | None = None,
                             topology_source_ids: list[str] | tuple = ()) -> dict:
    """Current problems ranked with the shared priority score (module docstring).

    Fan-out comes from one topology pass (build_topology): PDU/KVM -> servers on its outlets/ports, server -> its
    PDU feeds, owner present -> in use. Without topology the scope of device problems is 0 and says so.
    """
    ranked = []
    down_keys: set[str] = set()
    for item in problems:
        if problem_status(item) == "down":
            down_keys |= _problem_server_keys(item)
    for _key, group in group_problems(problems).items():
        entity = group["entity"] or {"kind": "unknown", "id": "", "label": ""}
        kind = entity["kind"]
        severities = [p["severity"] for p in group["problems"]]
        notes: list[str] = []
        affected_labels: list[str] = []
        affected, in_use, redundancy = 0, [], []
        used_topology = False
        if kind in _SERVER_KINDS:
            affected, affected_labels = 1, [entity["label"]]
            in_use = [_registered_owner(topology, entity_keys(entity["label"], entity["id"]))]
            used_topology = topology is not None
            if topology is None:
                notes.append("בעלים לא נבדקו (שיוכי הבעלים לא היו זמינים)")
        elif kind in _DEVICE_KINDS and topology is not None:
            used_topology = True
            device = (topology.get("devices") or {}).get(entity["id"].casefold())
            if device is None:
                notes.append("לא נמצאו שרתים משויכים לשקעים או לפורטים של רכיב זה")
            else:
                kind = device["kind"] if kind == "device" else kind
                scoped = [p.get("outlets") for p in group["problems"]]
                if scoped and all(o is not None for o in scoped):   # only specific outlets are affected
                    ports = {o for outlets in scoped for o in outlets}
                    members = [s for s in device["servers"] if s["port"] in ports]
                    notes.append("ההיקף מוגבל לשקעים שדווחו: " + (", ".join(sorted(ports)) if ports else "אין"))
                else:
                    members = device["servers"]
                keys = list(dict.fromkeys(s["key"] for s in members))
                affected, affected_labels = len(keys), keys
                in_use = [_registered_owner(topology, {k}) for k in keys]
                if kind == "pdu":
                    own = entity["id"].casefold()
                    for k in keys:
                        feeds = {c["device_id"].casefold() for c in topology["servers"].get(k, {}).get("pdu", [])}
                        redundancy.append("down" if k in down_keys else "possible" if feeds - {own} else "none_known")
        elif kind in _DEVICE_KINDS:
            notes.append("התלויות לא נבדקו (שיוכי השקעים לא היו זמינים)")
        scored = score_entity(kind=kind, severities=severities, affected_count=affected, in_use=in_use,
                              redundancy=redundancy)
        since = [t for t in (to_epoch(p["since_iso"]) for p in group["problems"]) if t is not None]
        source_ids = [s for p in group["problems"] for s in [p.get("source_id"), *p.get("related_source_ids", [])] if s]
        if used_topology:
            source_ids.extend(topology_source_ids)
        ranked.append({
            "entity": {"kind": kind, "id": entity["id"], "label": entity["label"]},
            "severity": max(severities, key=lambda s: PROBLEM_POINTS.get(s, 0)) if severities else "unknown",
            "problems": [_problem_view(p) for p in group["problems"]][:10],
            "affected_count": affected, "affected": affected_labels[:10],
            "score": scored["score"], "priority": scored["priority"], "reasons": scored["reasons"] + notes,
            "since_iso": _iso_of(min(since)) if since else None,
            "source_ids": list(dict.fromkeys(source_ids)),
            "_since": min(since) if since else math.inf,
            "_severity": max((PROBLEM_POINTS.get(s, 0) for s in severities), default=0),
        })
    ranked.sort(key=lambda r: (-r["score"], -r["_severity"], r["_since"], r["entity"]["label"].casefold()))
    for index, row in enumerate(ranked, 1):
        row["rank"] = index
        row.pop("_since")
        row.pop("_severity")
    return {
        "ranked": ranked[:MAX_LIST], "count": len(ranked), "truncated": len(ranked) > MAX_LIST,
        "formula": PRIORITY_FORMULA, "redundancy_note": REDUNDANCY_NOTE,
        "note": NO_PROBLEMS_NOTE if not ranked else
        "הדירוג מבוסס על הבעיות המתועדות בלבד; רכיבים שאינם מנוטרים (UPS, קירור, מתגים) אינם מופיעים בו.",
    }


# --------------------------------------------------------------------------------------------------------------
# Calling the data tools
# --------------------------------------------------------------------------------------------------------------
def _as_source(value: Any) -> Source | None:
    if isinstance(value, Source):
        return value
    if isinstance(value, dict) and value.get("id"):
        status = value.get("status") if value.get("status") in _SOURCE_RANK else "ok"
        return Source(id=_text(value["id"], 200), name=_text(value.get("name") or value["id"], 120),
                      ref=_text(value.get("ref"), 200), as_of=_iso_of(value.get("as_of")), age_s=_num(value.get("age_s")),
                      status=status, note=_text(value.get("note")))
    return None


def _as_result(value: Any) -> ToolResult:
    if isinstance(value, ToolResult):
        return value
    if isinstance(value, dict):
        data = value.get("data") if isinstance(value.get("data"), dict) else value
        sources = [s for s in (_as_source(v) for v in value.get("sources") or []) if s]
        caveats = [_text(c) for c in value.get("caveats") or [] if _text(c)]
        return ToolResult(data=data, sources=sources, caveats=caveats)
    raise ToolError("A data tool returned an unexpected result.")


class _Evidence:
    """Sources and caveats of every data tool called; a repeated source id keeps its worst status."""

    def __init__(self) -> None:
        self.sources: dict[str, Source] = {}
        self.caveats: list[str] = []
        self.failures = 0

    def add(self, result: ToolResult) -> list[str]:
        ids = []
        for source in result.sources:
            known = self.sources.get(source.id)
            if known is None or _SOURCE_RANK.get(source.status, 0) > _SOURCE_RANK.get(known.status, 0):
                self.sources[source.id] = source
            ids.append(source.id)
        for caveat in result.caveats:
            self.caveat(caveat)
        return list(dict.fromkeys(ids))

    def caveat(self, text: str) -> None:
        if text and text not in self.caveats:
            self.caveats.append(text)

    def failure(self, name: str, message: str) -> None:
        self.failures += 1
        source_id = f"tool:{name}"
        if source_id not in self.sources:
            self.sources[source_id] = Source(id=source_id, name=f"{name} (data tool)", ref=name, status="unavailable",
                                             note=_text(message, 200))
        if self.failures <= MAX_FAILURE_CAVEATS:
            self.caveat(f"{name} could not be read: {_text(message, 200)}")
        elif self.failures == MAX_FAILURE_CAVEATS + 1:
            self.caveat("Further data tool failures were omitted.")

    def result(self, data: dict) -> ToolResult:
        """The only exit of every analysis tool: data, sources and caveats all pass the shared redaction."""
        sources = [Source(id=_text(s.id, 200), name=_text(s.name, 120), ref=_text(s.ref, 200), as_of=_iso_of(s.as_of),
                          age_s=_num(s.age_s), status=s.status if s.status in _SOURCE_RANK else "unavailable",
                          note=_text(s.note)) for s in self.sources.values()]
        caveats = [_text(c, 500) for c in self.caveats]
        return ToolResult(data=redact_tree(data), sources=sources, caveats=list(dict.fromkeys(c for c in caveats if c)))


def _find_tool(ctx: ToolContext, name: str):
    module_name = _TOOL_MODULES[name]
    try:
        module = importlib.import_module(f".{module_name}", __package__)
    except Exception as exc:  # noqa: BLE001 - a missing or broken data module is "unavailable", not a crash
        log.info("Assistant data module %s is not available (%s).", module_name, type(exc).__name__)
        raise ToolError(f"The {name} data tool is not available.") from None
    func, role = None, "Viewer"
    for spec in getattr(module, "TOOLS", None) or ():
        if getattr(spec, "name", None) == name:
            func, role = spec.func, getattr(spec, "required_role", "Viewer")
            break
    if func is None and callable(getattr(module, name, None)):
        func = getattr(module, name)
    if func is None:
        raise ToolError(f"The {name} data tool is not available.")
    principal = getattr(ctx, "principal", None)
    if principal is not None and not principal.allows(role):
        raise ToolError(f"The {name} data tool requires the {role} role.")
    return func


async def _call(ctx: ToolContext, name: str, **args: Any) -> ToolResult:
    """Call a data tool by name; ToolError propagates (used for the primary data of a tool)."""
    func = _find_tool(ctx, name)
    return _as_result(await func(ctx, **{k: v for k, v in args.items() if v is not None}))


async def _try(ctx: ToolContext, ev: _Evidence, name: str, **args: Any) -> ToolResult | None:
    """Call a secondary data tool; a failure becomes an "unavailable" source plus a caveat."""
    try:
        result = await _call(ctx, name, **args)
    except ToolError as exc:
        ev.failure(name, str(exc))
        return None
    except Exception as exc:  # noqa: BLE001 - never leak internals of a failing data tool
        log.warning("Assistant data tool %s failed (%s).", name, type(exc).__name__)
        ev.failure(name, "the data tool failed unexpectedly")
        return None
    ev.add(result)
    return result


def _ids(result: ToolResult | None) -> list[str]:
    return list(dict.fromkeys(s.id for s in result.sources)) if result else []


def _arg_text(value: Any, name: str, cap: int = 300) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > cap:
        raise ToolError(f"{name} must be a nonempty string of at most {cap} characters.")
    return value.strip()


# --------------------------------------------------------------------------------------------------------------
# Tool wrappers
# --------------------------------------------------------------------------------------------------------------
async def analyze_impact(ctx: ToolContext, kind: str, id: str) -> ToolResult:  # noqa: A002 - tool argument name
    """Which servers/items a failure of (kind, id) affects, which are down/unknown now, and a ranked priority.

    Bounded work: one get_dependencies call, one list_current_problems call, one topology session and - only for a
    server target - one get_server_status call. Never one call per affected server.
    """
    kind = _arg_text(kind, "kind", 20).lower()
    if kind not in IMPACT_KINDS:
        raise ToolError("kind must be pdu, kvm, switch, rack, server or item.")
    entity_id = _arg_text(id, "id", 120)
    ev = _Evidence()
    dependencies = await _call(ctx, "get_dependencies", kind=kind, id=entity_id)
    dep_ids = ev.add(dependencies)
    problems_result = await _try(ctx, ev, "list_current_problems", limit=PROBLEMS_LIMIT)
    problems = normalize_problems(problems_result.data) if problems_result else None
    topology, topology_sources = await read_topology(ctx)
    ev.add(ToolResult(data={}, sources=topology_sources))
    status_result = await _try(ctx, ev, "get_server_status", server=entity_id) if kind == "server" else None
    ev.caveat("Priority scores are a documented heuristic, not a measurement; redundancy is a hint, never verified.")
    data = analyze_impact_data(kind, entity_id, dependencies.data, problems, topology,
                               status_result.data if status_result else None,
                               dependency_source_ids=dep_ids, problem_source_ids=_ids(problems_result),
                               topology_source_ids=[s.id for s in topology_sources], status_source_ids=_ids(status_result))
    return ev.result(data)


async def plan_capacity(ctx: ToolContext, rack: str, power_w: float | None = None, units: int | None = None,
                        needs_network: bool | None = None) -> ToolResult:
    """Space, power, cooling, network, redundancy, weight and cabling verdicts for adding equipment to a rack."""
    rack = _arg_text(rack, "rack", 120)
    if power_w is not None:
        power_w = _num(power_w)
        if power_w is None or power_w < 0 or power_w > 100000:
            raise ToolError("power_w must be a number of watts between 0 and 100000.")
    if units is not None and (isinstance(units, bool) or not isinstance(units, int) or not 1 <= units <= 42):
        raise ToolError("units must be an integer between 1 and 42.")
    if needs_network is not None and not isinstance(needs_network, bool):
        raise ToolError("needs_network must be true or false.")
    ev = _Evidence()
    layout = await _try(ctx, ev, "get_rack_layout", rack=rack)
    power = await _try(ctx, ev, "get_power_and_environment", rack=rack)
    dependencies = await _try(ctx, ev, "get_dependencies", kind="rack", id=rack)
    if layout is None and power is None and dependencies is None:
        raise ToolError("No data could be read for this rack, so capacity cannot be assessed. "
                        "Check the rack name with resolve_entity.")
    thresholds = parse_thresholds(_pick(power.data, "thresholds")) if power else {}
    if not thresholds and ctx.settings is not None:
        try:
            from .. import alerts
            thresholds = {(metric, side): float(value) for metric, side, value in alerts.power_rules(ctx.settings)}
        except Exception:  # noqa: BLE001 - thresholds are optional; the UI assumption is labelled instead
            thresholds = {}
    ev.caveat("Capacity verdicts use the latest cached readings only; no device was contacted and no load is predicted.")
    data = plan_capacity_data(
        rack, layout=layout.data if layout else None, power=power.data if power else None,
        dependencies=dependencies.data if dependencies else None, power_w=power_w, units=units,
        needs_network=needs_network, thresholds=thresholds,
        source_ids={"layout": _ids(layout), "power": _ids(power), "dependencies": _ids(dependencies)})
    return ev.result(data)


async def correlate_events(ctx: ToolContext, server: str | None = None, device_id: str | None = None,
                           since_hours: int = DEFAULT_HISTORY_HOURS) -> ToolResult:
    """Events that co-occurred within ±10 minutes and how often each kind of event recurred."""
    if server is not None:
        server = _arg_text(server, "server", 120)
    if device_id is not None:
        device_id = _arg_text(device_id, "device_id", 120)
    if isinstance(since_hours, bool) or not isinstance(since_hours, (int, float)) or not math.isfinite(since_hours):
        raise ToolError("since_hours must be a positive integer.")
    hours = int(max(1, min(MAX_HISTORY_HOURS, since_hours)))
    ev = _Evidence()
    focus = None
    if server or device_id:
        focus = await _call_history(ctx, server=server, device_id=device_id, since_hours=hours)
        ev.add(focus)
        if _text(focus.data.get("status"), 20).lower() in ("ambiguous", "not_found"):
            candidates = [{k: _text(c.get(k), 120) for k in ("id", "key", "label")}
                          for c in focus.data.get("candidates") or [] if isinstance(c, dict)][:10]
            return ev.result({"status": _text(focus.data.get("status"), 20).lower(), "candidates": candidates,
                              "groups": [], "recurrence": [], "causality_note": NON_CAUSAL_NOTE,
                              "notes": ["המזהה לא זוהה באופן חד-ערכי; יש לבחור אחד מהמועמדים."]})
        overall = None
        try:
            overall = await _call_history(ctx, since_hours=hours)
            ev.add(overall)
        except ToolError as exc:
            ev.failure("get_history", str(exc))
        history = overall.data if overall else {}
    else:
        overall = await _call_history(ctx, since_hours=hours)
        ev.add(overall)
        history = overall.data
    data = correlate_events_data(history, since_hours=hours, now=ctx.now,
                                 focus_history=focus.data if focus else None)
    if (focus and focus.data.get("truncated")) or (isinstance(history, dict) and history.get("truncated")):
        ev.caveat("History was truncated by the data tool limit; older events in the window may be missing.")
    ev.caveat("Co-occurrence is time proximity only and never establishes a cause.")
    return ev.result(data)


async def _call_history(ctx: ToolContext, **args: Any) -> ToolResult:
    try:
        return await _call(ctx, "get_history", limit=HISTORY_LIMIT, **args)
    except ToolError:
        return await _call(ctx, "get_history", **args)


async def prioritize_problems(ctx: ToolContext) -> ToolResult:
    """All current problems, ordered by the documented priority score with reasons.

    Bounded work: one list_current_problems call and one topology session for every problem's fan-out.
    """
    ev = _Evidence()
    result = await _call(ctx, "list_current_problems", limit=PROBLEMS_LIMIT)
    ev.add(result)
    problems = normalize_problems(result.data)
    topology, topology_sources = (None, []) if not problems else await read_topology(ctx)
    ev.add(ToolResult(data={}, sources=topology_sources))
    if isinstance(result.data, dict) and result.data.get("truncated"):
        ev.caveat("The problem list was truncated by the data tool limit; lower-severity problems may be missing.")
    ev.caveat("Priority scores are a documented heuristic, not a measurement; absence of problems is not proof of health.")
    return ev.result(prioritize_problems_data(problems, topology, [s.id for s in topology_sources]))


def _schema(properties: dict, required: list[str] | tuple = ()) -> dict:
    return {"type": "object", "additionalProperties": False, "properties": properties, "required": list(required)}


TOOLS: list[ToolSpec] = [
    ToolSpec(
        "analyze_impact",
        "Blast-radius analysis for a failure of one PDU, KVM, switch (free-text switch name), rack, server or rack "
        "item. Combines stored dependencies, current recorded problems and recorded port associations/owners (one "
        "read) and returns the "
        "affected servers/items, which are currently down/unknown, possible redundancy (a hint, never verified), and "
        "`ranked` servers with a heuristic priority score and Hebrew reasons (formula included). Use after "
        "resolve_entity when the id is not exact. Read-only; no device is contacted.",
        _schema({"kind": {"type": "string", "enum": list(IMPACT_KINDS),
                          "description": "Entity kind whose failure is analysed."},
                 "id": {"type": "string",
                        "description": "PDU/KVM device id, switch name, rack name, server label/key or item id."}},
                ["kind", "id"]),
        "Viewer", analyze_impact),
    ToolSpec(
        "plan_capacity",
        "Assess adding equipment to a rack. Returns a verdict per dimension (space, power, cooling, network, "
        "redundancy, weight, cabling) as ok | tight | over | unknown with Hebrew reasons, the missing information "
        "and the assumptions used, and an overall answer yes | conditional | no (never yes while any dimension is "
        "unknown). Power headroom is per PDU de-duplicated by id, from cached readings only; configured inlet limits "
        "are used when set, otherwise the labelled 16 A / 208 V UI assumption. Shelf space has low confidence.",
        _schema({"rack": {"type": "string", "description": "Rack name, e.g. Rack-01."},
                 "power_w": {"type": "number", "description": "Expected power draw of the new equipment in watts."},
                 "units": {"type": "integer", "description": "Shelf positions needed (U here is a shelf index), 1-42."},
                 "needs_network": {"type": "boolean", "description": "Whether the equipment needs a switch connection."}},
                ["rack"]),
        "Viewer", plan_capacity),
    ToolSpec(
        "correlate_events",
        "Correlate recorded history (ping incidents, PDU maintenance, alert email subjects, rack item moves) in a "
        "window: groups events whose start times are within 10 minutes of each other (labelled co_occurred with the "
        "sentence that time correlation is not causation) and counts recurrences per event kind and entity "
        "(Hebrew text 'קרה N פעמים ב-X ימים'). Optional server or device filter focuses the analysis while still "
        "showing co-occurring lab events. since_hours defaults to 168 and is capped at 2160.",
        _schema({"server": {"type": "string", "description": "Server label, canonical key or ping-target id."},
                 "device_id": {"type": "string", "description": "PDU or KVM device id."},
                 "since_hours": {"type": "integer", "description": "Window length in hours (1-2160, default 168)."}}),
        "Viewer", correlate_events),
    ToolSpec(
        "prioritize_problems",
        "Rank every current recorded problem (grouped per entity) by the same heuristic priority score as "
        "analyze_impact: severity, number of affected servers from stored dependencies, service impact (registered "
        "owner = in use) and possible redundancy. Returns the ordered list with reasons and source ids. An empty "
        "list is never proof that the lab is healthy.",
        _schema({}),
        "Viewer", prioritize_problems),
]
