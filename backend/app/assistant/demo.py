"""Demo responder: deterministic Hebrew answers built from REAL tool results, without a language model.

Used when the LLM is disabled, no API key is configured or the SDK is missing, and as the answer when an LLM
call fails. The question is classified with keyword rules (Hebrew + English), mapped to the same read-only tools
the model would use, and the tool data is rendered into the standard answer object. Every fact cites the source
ids the tools really returned; hypotheses come only from explicit rules (for example "server down + its PDU
outlet reported OFF"); missing data comes from the tools' caveats and non-ok sources. Every summary starts with
DEMO_PREFIX so the mode is never hidden.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import logging
import re
from typing import Any
from zoneinfo import ZoneInfo

from .contracts import ENTITY_KINDS, PRIORITIES, ToolContext, ToolResult, ToolSpec, empty_answer
from .engine import Ledger, finalize, run_tool
from .prompts import clean_context

log = logging.getLogger(__name__)

DEMO_PREFIX = "מצב הדגמה (ללא מודל שפה):"
DEMO_LABEL = "מצב הדגמה — ללא מודל שפה"
DEMO_REASON_TEXT = {
    "llm_disabled": "מודל השפה כבוי בהגדרות השרת (ASSISTANT_LLM_ENABLED=false).",
    "no_api_key": "לא הוגדר בשרת מפתח API למודל השפה (ASSISTANT_ANTHROPIC_API_KEY).",
    "sdk_missing": "ספריית anthropic אינה מותקנת בשרת (pip install -r requirements.txt).",
    "llm_auth_failed": "מפתח ה-API של מודל השפה נדחה; יש לבדוק את ASSISTANT_ANTHROPIC_API_KEY.",
    "llm_rate_limited": "שירות מודל השפה הגביל זמנית את קצב הבקשות.",
    "llm_unreachable": "לא ניתן היה להתחבר לשירות מודל השפה (רשת או proxy).",
    "llm_unavailable": "שירות מודל השפה אינו זמין כרגע.",
    "llm_rejected": "שירות מודל השפה דחה את הבקשה.",
    "llm_error": "אירעה שגיאה בקריאה למודל השפה.",
    "router_demo": "השרת קבע שהשאלה הזאת תיענה במצב הדגמה.",
}

_MAX_FACTS = 15
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
# ASCII names that contain a digit (opt207, Rack-01, pdu-rack03) or IPv4 addresses; Hebrew prefixes such as "ל-"
# or "ה" before the name are allowed.
_TOKEN = re.compile(r"(?<![A-Za-z0-9_.])(?:[A-Za-z][A-Za-z0-9_.:/-]*\d[A-Za-z0-9_.:/-]*|\d{1,3}(?:\.\d{1,3}){3})")
_RACK = re.compile(r"^rack[\s_-]*\d+$", re.IGNORECASE)
_THIS = ("הזה", "הזאת", "הזו", "this", "current")

STATUS_HE = {
    "up": "זמין", "down": "לא זמין (down)", "stale": "לא עדכני (stale)", "unknown": "לא ידוע", "error": "שגיאת בדיקה",
    "paused": "מושהה", "unconfigured": "לא מוגדר לניטור", "on": "דולק (ON)", "off": "כבוי (OFF)",
    "cycling": "באתחול", "pending": "ממתין לבדיקה ראשונה", "disabled": "מושבת", "unreachable": "לא נגיש",
    "ok": "תקין", "active": "פעיל", "idle": "ללא חיבור פעיל", "empty": "ריק", "configured": "מוגדר",
    "running": "פועל", "scheduled": "מתוזמן", "overdue": "באיחור", "not_started": "טרם התחיל",
}
SEVERITY_HE = {"high": "גבוהה", "medium": "בינונית", "low": "נמוכה", "unknown": "לא ידועה"}
PROBLEM_HE = {
    "ping_down": "השרת אינו עונה ל-ping", "ping_stale": "נתוני ה-ping אינם עדכניים",
    "ping_unknown": "מצב ה-ping אינו ידוע", "ping_error": "בדיקת ה-ping נכשלה",
    "open_ping_incident": "אירוע ping פתוח", "device_unreachable": "ממשק הניהול של ההתקן אינו נגיש",
    "device_stale": "נתוני ההתקן אינם עדכניים", "device_pending": "ההתקן ממתין לבדיקה ראשונה",
    "device_unknown": "מצב ההתקן אינו ידוע", "outlet_off": "שקע PDU מדווח ככבוי",
    "active_maintenance": "תחזוקת PDU פעילה", "alert_condition": "התראה פעילה",
    "monitor_overdue": "סבב הניטור באיחור", "monitor_error": "שגיאה בשירות הניטור",
}
KIND_WORD = {"server": "שרת", "pdu": "PDU", "kvm": "KVM", "rack": "ארון", "item": "פריט", "switch": "מתג"}
EVENT_HE = {"ping_incident": "אירוע ping", "pdu_maintenance": "פעולת תחזוקת PDU", "alert_email": "התראת דוא\"ל",
            "rack_item_move": "הזזת פריט", "tracking": "תנועת פריט"}

# (intent, keywords) - first match wins; substring match on the lower-cased question.
_RULES = (
    ("history", ("קרה בעבר", "קרתה בעבר", "קרו בעבר", "בעבר", "היסטורי", "history", "happened before",
                 "in the past", "previously")),
    ("work", ("טיוט", "תחזוק", "עבודה", "עבודות", "משימ", "maintenance", "draft", "work item", "task")),
    ("capacity", ("קיבול", "להוסיף", "הוספת", "עומס", "עמוס", "מקום פנוי", "capacity", "add a ", "add server",
                  "free shelf", "power load")),
    ("dependencies", ("מושפע", "תלוי", "תלות", "מתג", "switch", "depend", "impact", "affected")),
    ("server_status", ("לא זמין", "לא עונה", "לא מגיב", "למה", "סטטוס", "status", "unreachable", "not reachable",
                       "why ")),
    ("problems", ("נפל", "תקל", "בעי", "התרא", "לבדוק קודם", "down", "outage", "problem", "fault", "alert",
                  "broken", "failing", "check first")),
    ("capacity", ("ארון", "rack")),
)


def classify(question: str) -> str:
    """Intent of a question: history, work, capacity, dependencies, server_status, problems or overview."""
    text = f" {str(question).casefold()} "
    for intent, words in _RULES:
        if any(word in text for word in words):
            return intent
    return "overview"


def _text(value, limit: int = 160) -> str:
    text = _CONTROL.sub(" ", str(value if value is not None else "")).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _list(value) -> list:
    return value if isinstance(value, list) else []


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _epoch(value) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str) and value:
        try:
            parsed = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=_dt.timezone.utc)
        return parsed.timestamp()
    return None


def _named(kind, name) -> str:
    """"PDU Rack-01" / "שרת opt207": the kind word unless the name already contains it."""
    name = _text(name, 60)
    word = KIND_WORD.get(kind, "")
    return name if not word or word.casefold() in name.casefold() else f"{word} {name}".strip()


def _ref(kind, ident, label=None) -> dict | None:
    if kind not in ENTITY_KINDS or ident in (None, ""):
        return None
    return {"kind": kind, "id": _text(ident, 200), "label": _text(label if label not in (None, "") else ident, 200)}


class _Run:
    """One demo answer: the role-filtered tools, the evidence ledger and the notes about missing data."""

    def __init__(self, ctx: ToolContext, tools: list[ToolSpec]) -> None:
        self.ctx = ctx
        self.by_name = {spec.name: spec for spec in tools}
        self.ledger = Ledger()
        self.missing: list[str] = []
        try:
            self.tz = ZoneInfo(getattr(ctx.settings, "ping_monitor_timezone", None) or "UTC")
        except Exception:  # noqa: BLE001 - unknown zone: show UTC
            self.tz = _dt.timezone.utc

    def note(self, text: str) -> None:
        if text not in self.missing:
            self.missing.append(text)

    def has(self, name: str) -> bool:
        return name in self.by_name

    async def call(self, name: str, **candidates: Any) -> ToolResult | None:
        """Call a tool with the candidate arguments its schema declares (None values are left out)."""
        spec = self.by_name.get(name)
        if spec is None:
            self.note(f"הכלי {name} אינו זמין (לא הותקן בשרת או שאין הרשאה אליו); הנתונים שלו חסרים בתשובה.")
            return None
        props = _dict(spec.input_schema.get("properties"))
        args = {key: value for key, value in candidates.items() if value is not None and key in props}
        missing = [key for key in spec.input_schema.get("required") or [] if key not in args]
        if missing:
            self.note(f"הכלי {name} לא הופעל: חסר מידע ({', '.join(missing)}).")
            return None
        outcome = await run_tool(spec, name, args, self.ctx)
        if isinstance(outcome, ToolResult):
            self.ledger.add(outcome)
            return outcome
        self.note(f"הכלי {name} לא החזיר נתונים: {_text(outcome, 300)}")
        return None

    def when(self, value) -> str:
        epoch = _epoch(value)
        if epoch is None:
            return "זמן לא ידוע"
        local = _dt.datetime.fromtimestamp(epoch, tz=_dt.timezone.utc).astimezone(self.tz)
        delta = self.ctx.now - epoch
        if delta < 0:
            ago = ""
        elif delta < 120:
            ago = " (לפני פחות משתי דקות)"
        elif delta < 5400:
            ago = f" (לפני {int(delta // 60)} דקות)"
        elif delta < 172800:
            ago = f" (לפני {int(delta // 3600)} שעות)"
        else:
            ago = f" (לפני {int(delta // 86400)} ימים)"
        return f"{local:%Y-%m-%d %H:%M}{ago}"


def _ids(result: ToolResult | None, *preferred: str) -> list[str]:
    """Source ids of `result` to cite: the preferred ones it really returned, else its first sources."""
    if result is None:
        return []
    available = [s.id for s in result.sources if getattr(s, "id", None)]
    chosen = [p for p in dict.fromkeys(preferred) if p in available]
    return chosen or available[:3]


class _Answer:
    def __init__(self) -> None:
        self.answer = empty_answer("")
        self.summary = ""

    def fact(self, text: str, ids: list[str]) -> None:
        if ids and len(self.answer["facts"]) < _MAX_FACTS:
            self.answer["facts"].append({"text": text, "source_ids": list(dict.fromkeys(ids))})

    def hypothesis(self, text: str, support: list[str], verify: str, ids: list[str]) -> None:
        self.answer["hypotheses"].append({"text": text, "support": support, "verify": verify,
                                          "source_ids": list(dict.fromkeys(ids))})

    def check(self, text: str) -> None:
        if text not in self.answer["checks"]:
            self.answer["checks"].append(text)

    def missing(self, text: str) -> None:
        if text not in self.answer["missing_data"]:
            self.answer["missing_data"].append(text)

    def ref(self, ref: dict | None) -> None:
        if ref and ref not in self.answer["entity_refs"]:
            self.answer["entity_refs"].append(ref)

    def recommendation(self, *, title, problem, evidence, priority, next_step, missing_info, ids, refs) -> None:
        self.answer["recommendations"].append({
            "title": title, "problem": problem, "evidence": evidence,
            "priority": priority if priority in PRIORITIES else "medium", "next_step": next_step,
            "missing_info": list(missing_info), "source_ids": list(dict.fromkeys(ids)),
            "entity_refs": [r for r in refs if r]})

    def draft(self, *, title, description, refs, priority, rationale, steps) -> None:
        self.answer["work_item_drafts"].append({
            "title": title, "description": description, "entity_refs": [r for r in refs if r],
            "priority": priority if priority in PRIORITIES else "medium", "rationale": rationale,
            "steps": list(steps)})


# ---------------------------------------------------------------------------------------------------------------
# Target extraction.
# ---------------------------------------------------------------------------------------------------------------
def _tokens(question: str) -> list[str]:
    return [t.rstrip(".,:;!?/-") for t in _TOKEN.findall(str(question))]


def _target(question: str, context: dict) -> dict:
    """{"query"}: a name from the question; {"kind", "id"}: the viewed equipment; {"rack"}: a rack name."""
    text = str(question).casefold()
    tokens = _tokens(question)
    racks = [t for t in tokens if _RACK.match(t)]
    names = [t for t in tokens if not _RACK.match(t)]
    detail = _dict(context.get("detail"))
    target: dict = {}
    if racks:
        target["rack"] = racks[0]
    elif context.get("rack"):
        target["rack"] = context["rack"]
        target["rack_from_context"] = True
    uses_this = any(word in text for word in _THIS)
    if detail and (uses_this or not names):
        target.update({"kind": detail["kind"], "id": detail["id"], "from_context": True})
        if detail["kind"] == "rack" and "rack" not in target:
            target["rack"] = detail["id"]
    elif names:
        target["query"] = names[0]
    return target


async def _resolve(run: _Run, out: _Answer, query: str, prefer: tuple[str, ...]) -> dict | None:
    """Resolve a name through resolve_entity. Returns {"kind", "id", "label"} or None (ambiguity reported)."""
    if not run.has("resolve_entity"):
        return {"kind": prefer[0] if prefer else "server", "id": query, "label": query, "unresolved": True}
    result = await run.call("resolve_entity", query=query)
    if result is None:
        return {"kind": prefer[0] if prefer else "server", "id": query, "label": query, "unresolved": True}
    candidates = [c for c in _list(result.data.get("candidates")) if isinstance(c, dict) and c.get("id")]
    exact = [c for c in candidates if c.get("match") == "exact"]
    pool = exact or candidates
    preferred = [c for c in pool if c.get("kind") in prefer] or pool
    if len(preferred) == 1 or (preferred and len({(c.get("kind"), c.get("id")) for c in preferred}) == 1):
        chosen = preferred[0]
        return {"kind": chosen.get("kind"), "id": str(chosen.get("id")), "label": _text(chosen.get("label") or chosen.get("id"))}
    if not candidates:
        out.summary = f"לא נמצא בנתוני המערכת רכיב בשם \"{_text(query, 80)}\"."
        out.fact(f"חיפוש \"{_text(query, 80)}\" בנתוני המערכת לא החזיר התאמות.", _ids(result))
        out.check("ודא את שם הרכיב (כפי שהוא מופיע באתר) ושאל שוב.")
        return None
    listed = ", ".join(f"{_text(c.get('label') or c.get('id'), 40)} ({c.get('kind')})" for c in preferred[:6])
    out.summary = f"השם \"{_text(query, 80)}\" מתאים לכמה רכיבים, ולכן לא נבחר אחד מהם: {listed}."
    out.fact(f"נמצאו {len(preferred)} התאמות אפשריות לשם \"{_text(query, 80)}\": {listed}.", _ids(result))
    out.check("שאל שוב עם מזהה ייחודי (שם מלא, IP או מספר סידורי).")
    for c in preferred[:6]:
        out.ref(_ref(c.get("kind"), c.get("id"), c.get("label")))
    return None


# ---------------------------------------------------------------------------------------------------------------
# Intent handlers. Each fills `out` (an _Answer) from real tool data.
# ---------------------------------------------------------------------------------------------------------------
async def _problems(run: _Run, out: _Answer, question: str, target: dict, context: dict) -> None:
    result = await run.call("list_current_problems")
    if result is None:
        out.summary = "לא ניתן היה לקרוא את רשימת הבעיות הנוכחיות, ולכן אין תשובה מבוססת נתונים."
        out.check("בדוק במסך הניטור באתר שהשירות פועל ונסה שוב.")
        return
    problems = [p for p in _list(result.data.get("problems")) if isinstance(p, dict)]
    total = result.data.get("total") if isinstance(result.data.get("total"), int) else len(problems)
    if not problems:
        out.summary = ("לא נמצאו בעיות רשומות כרגע בנתוני הניטור. אין בכך הוכחה שהמעבדה תקינה: חלק מהרכיבים "
                       "אינם מנוטרים וחלק מהנתונים עשויים להיות לא עדכניים.")
        out.fact("רשימת הבעיות הנוכחיות שהניטור רשם ריקה.", _ids(result))
        out.check("ודא במסך הניטור שסבב הבדיקות האחרון הושלם לאחרונה.")
        out.check("זכור שאין ניטור ל-UPS, לקירור ולמתגים; בדוק אותם ידנית אם יש חשד לתקלה.")
        return
    severity = {key: sum(1 for p in problems if p.get("severity") == key) for key in SEVERITY_HE}
    parts = [f"{count} בחומרה {SEVERITY_HE[key]}" for key, count in severity.items() if count]
    out.summary = f"נמצאו {total} בעיות רשומות כרגע ({', '.join(parts)})."
    if result.data.get("truncated"):
        out.missing(f"הרשימה קוצרה ל-{len(problems)} בעיות מתוך {total}.")
    for p in problems:
        entity = _dict(p.get("entity"))
        label = _text(entity.get("label") or entity.get("id"), 60)
        kind = PROBLEM_HE.get(p.get("kind"), _text(p.get("kind"), 40))
        since = f", מאז {run.when(p.get('since_iso'))}" if p.get("since_iso") else ""
        seen = f", נצפה לאחרונה {run.when(p.get('last_seen_iso'))}" if p.get("last_seen_iso") else ""
        ids = _ids(result, str(p.get("source_id") or ""), *[str(i) for i in _list(p.get("related_source_ids"))])
        out.fact(f"{label}: {kind} (חומרה {SEVERITY_HE.get(p.get('severity'), 'לא ידועה')}{since}{seen}). "
                 f"פירוט: {_text(p.get('detail'), 140)}", ids)
        out.ref(_ref(entity.get("kind"), entity.get("id"), entity.get("label")))
    order = sorted(problems, key=lambda p: ("high", "medium", "unknown", "low").index(p.get("severity"))
                   if p.get("severity") in ("high", "medium", "unknown", "low") else 9)
    for p in order[:5]:
        entity = _dict(p.get("entity"))
        out.check(f"{_text(entity.get('label') or entity.get('id'), 60)}: "
                  f"{_check_for(p.get('kind'))} (חומרה {SEVERITY_HE.get(p.get('severity'), 'לא ידועה')})")
    # Rule-based hypotheses and specific checks for the servers that are down (outlet OFF, PDU maintenance, ...).
    for p in [p for p in order if p.get("kind") == "ping_down"][:3]:
        entity = _dict(p.get("entity"))
        await _server_findings(run, out, str(entity.get("id")), _text(entity.get("label") or entity.get("id"), 60),
                               facts=False)


def _check_for(kind) -> str:
    return {
        "ping_down": "בדוק את מסך השרת בקונסולת KVM ואת שקע ה-PDU שמזין אותו",
        "open_ping_incident": "בדוק את ציר הזמן של האירוע במסך הניטור",
        "device_unreachable": "בדוק שממשק הניהול של ההתקן מגיב ברשת ושפרטי הגישה תקינים",
        "outlet_off": "ברר מי כיבה את השקע ומדוע (יומן התחזוקה) לפני הדלקה",
        "active_maintenance": "ודא שהתחזוקה עדיין נדרשת וסיים אותה כשהעבודה הושלמה",
        "monitor_overdue": "ודא ששירות הניטור פועל",
        "monitor_error": "בדוק את שגיאת שירות הניטור",
    }.get(kind, "אמת את המצב במסך הציוד")


async def _server_findings(run: _Run, out: _Answer, server: str, label: str, facts: bool = True) -> dict | None:
    """get_server_status for one server: facts (optional), rule-based hypotheses and ordered checks."""
    result = await run.call("get_server_status", server=server)
    if result is None:
        return None
    data = result.data
    status = data.get("status")
    if status != "found":
        if facts:
            candidates = ", ".join(_text(_dict(c).get("label") or _dict(c).get("id"), 40)
                                   for c in _list(data.get("candidates"))[:6])
            out.summary = (f"השרת \"{label}\" לא נמצא בנתוני המערכת." if status == "not_found" else
                           f"השם \"{label}\" מתאים לכמה שרתים: {candidates}.")
            out.fact(out.summary, _ids(result))
            out.check("שאל שוב עם שם השרת המלא או מזהה הניטור שלו.")
        return None
    server_info = _dict(data.get("server"))
    label = _text(server_info.get("label") or label, 60)
    out.ref(_ref("server", server_info.get("id") or server, label))
    icmp = _dict(data.get("icmp"))
    icmp_status = icmp.get("status")
    pdus = [p for p in _list(data.get("pdu")) if isinstance(p, dict)]
    kvms = [k for k in _list(data.get("kvm")) if isinstance(k, dict)]
    maintenance = [m for m in _list(data.get("maintenance")) if isinstance(m, dict)]
    switches = [s for s in _list(data.get("switch_assignments")) if isinstance(s, dict)]
    icmp_ids = _ids(result, str(icmp.get("source_id") or "ping_targets"))
    if facts:
        last_up = f"; היה זמין לאחרונה {run.when(icmp.get('last_up_at'))}" if icmp.get("last_up_at") else ""
        out.fact(f"ניטור ICMP: {label} במצב {STATUS_HE.get(icmp_status, _text(icmp_status, 30))}, "
                 f"נבדק {run.when(icmp.get('checked_at'))}{last_up}.", icmp_ids)
        incident = _dict(data.get("open_incident"))
        if incident:
            out.fact(f"קיים אירוע ping פתוח מאז {run.when(incident.get('first_failed_at'))} "
                     f"(כישלון אחרון {run.when(incident.get('last_failed_at'))}).",
                     _ids(result, str(incident.get("source_id") or "ping_incidents")))
            out.ref(_ref("incident", incident.get("id"), f"אירוע ping {label}"))
        for p in pdus:
            out.fact(f"{label} מחובר ל-{_named('pdu', p.get('device_name') or p.get('device_id'))} בשקע "
                     f"{_text(p.get('port'), 10)}: {STATUS_HE.get(p.get('status'), _text(p.get('status'), 30))} "
                     f"(נבדק {run.when(p.get('checked_at'))}).",
                     _ids(result, str(p.get("source_id") or "monitor_device_snapshots")))
            out.ref(_ref("pdu", p.get("device_id"), p.get("device_name")))
        for k in kvms:
            out.fact(f"{label} מחובר ל-{_named('kvm', k.get('device_name') or k.get('device_id'))} בפורט "
                     f"{_text(k.get('port'), 10)}: {STATUS_HE.get(k.get('status'), _text(k.get('status'), 30))} "
                     f"(נבדק {run.when(k.get('checked_at'))}).",
                     _ids(result, str(k.get("source_id") or "monitor_device_snapshots")))
            out.ref(_ref("kvm", k.get("device_id"), k.get("device_name")))
        racks = [r for r in _list(data.get("rack_candidates")) if isinstance(r, dict) and r.get("rack")]
        if racks:
            out.fact(f"מיקום רשום: {', '.join(_text(r.get('rack'), 30) for r in racks[:4])}"
                     + (" (המקורות סותרים זה את זה)" if data.get("rack_conflict") else "") + ".",
                     _ids(result, *[str(r.get("source_id") or "") for r in racks]))
            out.ref(_ref("rack", racks[0].get("rack"), racks[0].get("rack")))
        for s in switches:
            out.fact(f"שיוך מתג שמור: {_text(s.get('switch'), 40)} פורט {_text(s.get('port'), 20)} "
                     "(טקסט חופשי, לא מנוטר).", _ids(result, str(s.get("source_id") or "")))
        owners = [_text(o, 40) for o in _list(data.get("owner_names")) if o]
        if owners:
            out.fact(f"אחראי רשום: {', '.join(owners)}.",
                     _ids(result, *[str(i) for i in _list(data.get("owner_source_ids"))]))
        for m in maintenance:
            out.fact(f"ה-PDU {_text(m.get('device_id'), 40)} שמזין את השרת נמצא בתחזוקה פעילה מאז "
                     f"{run.when(m.get('started_at'))}.", _ids(result, "pdu_maintenance"))
    is_down = icmp_status in ("down", "error")
    off = [p for p in pdus if p.get("status") == "off"]
    snapshot_ids = _ids(result, "monitor_device_snapshots")
    if is_down and off:
        p = off[0]
        out.hypothesis(
            f"ייתכן שהשקע {_text(p.get('port'), 10)} ב-{_named('pdu', p.get('device_name') or p.get('device_id'))} "
            f"כבוי ולכן {label} אינו זמין.",
            [f"ניטור ICMP מדווח ש-{label} אינו זמין.",
             f"ה-PDU מדווח שהשקע {_text(p.get('port'), 10)} במצב OFF (נבדק {run.when(p.get('checked_at'))})."],
            "בדוק במסך ה-PDU שהשקע אכן כבוי, ברר ביומן התחזוקה מי כיבה אותו, ורק לאחר אישור הדלק אותו "
            "וודא שה-ping חוזר.", icmp_ids + snapshot_ids)
        out.check(f"בדוק את שקע {_text(p.get('port'), 10)} ב-{_named('pdu', p.get('device_name') or p.get('device_id'))} "
                  "ואת יומן התחזוקה שלו.")
    if is_down and maintenance:
        out.hypothesis(f"ייתכן ש-{label} כבוי בגלל תחזוקת PDU פעילה.",
                       [f"ניטור ICMP מדווח ש-{label} אינו זמין.", "ה-PDU שמזין אותו רשום בתחזוקה פעילה."],
                       "בדוק ברשומת התחזוקה אילו שקעים כובו ומתי, והשווה לזמן שבו השרת הפסיק לענות.",
                       icmp_ids + _ids(result, "pdu_maintenance"))
    fresh_on = [p for p in pdus if p.get("status") == "on" and not p.get("stale")]
    if is_down and pdus and not off and len(fresh_on) == len(pdus):
        out.hypothesis(f"{label} מקבל חשמל לפי ה-PDU, ולכן ייתכן שהבעיה ברשת, במערכת ההפעלה או בחומרת השרת.",
                       [f"ניטור ICMP מדווח ש-{label} אינו זמין.", "כל שקעי ה-PDU הרשומים שלו מדווחים ON."],
                       "פתח את קונסולת ה-KVM ובדוק מה מוצג על המסך; אחר כך בדוק את כבל הרשת ואת פורט המתג.",
                       icmp_ids + snapshot_ids)
    if icmp_status in ("stale", "unknown", "paused", "unconfigured"):
        out.missing(f"מצב ה-ping של {label} הוא {STATUS_HE.get(icmp_status, icmp_status)}, ולכן אי אפשר לקבוע "
                    "מהנתונים אם השרת זמין כרגע.")
    for k in kvms[:1]:
        out.check(f"פתח את קונסולת {_named('kvm', k.get('device_name') or k.get('device_id'))} "
                  f"(פורט {_text(k.get('port'), 10)}) ובדוק מה מוצג על מסך {label}.")
    for s in switches[:1]:
        out.check(f"בדוק את כבל הרשת ואת פורט {_text(s.get('port'), 20)} במתג {_text(s.get('switch'), 40)}.")
    if is_down and not (pdus or kvms or switches):
        out.check(f"בדוק פיזית את {label}: חשמל, כבל רשת ומסך.")
    return data


async def _server_status(run: _Run, out: _Answer, question: str, target: dict, context: dict) -> None:
    kind = target.get("kind")
    if target.get("from_context") and kind in ("pdu", "kvm", "item", "rack"):
        await _device_status(run, out, kind, target["id"])
        return
    if target.get("from_context") and kind == "server":
        server, label = target["id"], target["id"]
    elif target.get("query"):
        resolved = await _resolve(run, out, target["query"], ("server",))
        if resolved is None:
            return
        if resolved.get("kind") in ("pdu", "kvm"):
            await _device_status(run, out, resolved["kind"], resolved["id"])
            return
        server, label = resolved["id"], resolved["label"]
    else:
        out.missing("לא זוהה בשאלה שם של שרת, ולכן מוצגת רשימת הבעיות הנוכחיות.")
        await _problems(run, out, question, target, context)
        return
    data = await _server_findings(run, out, server, label)
    if data is None:
        if not out.summary:
            out.summary = f"לא ניתן היה לקרוא את מצב השרת {_text(label, 60)}."
        return
    label = _text(_dict(data.get("server")).get("label") or label, 60)
    icmp = _dict(data.get("icmp"))
    state = STATUS_HE.get(icmp.get("status"), _text(icmp.get("status"), 30))
    history = await run.call("get_history", server=server, since_hours=168)
    events = [e for e in _list(history.data.get("items")) if isinstance(e, dict)] if history else []
    incidents = [e for e in events if e.get("kind") == "ping_incident"]
    if history is not None:
        out.fact(f"ב-7 הימים האחרונים נרשמו {len(incidents)} אירועי ping ו-{len(events)} אירועים בסך הכול "
                 f"הקשורים ל-{label}.", _ids(history, "ping_incidents"))
    why = ""
    if out.answer["hypotheses"]:
        why = " יש השערה אפשרית לסיבה (ראה השערות), אך היא אינה מאומתת."
    elif icmp.get("status") in ("down", "error"):
        why = " הנתונים אינם מצביעים על סיבה ודאית."
    out.summary = f"לפי ניטור ה-ping, {label} במצב {state} (נבדק {run.when(icmp.get('checked_at'))}).{why}"
    out.check(f"בדוק בהיסטוריה אם {label} נפל בעבר באותה שעה או אחרי תחזוקה.")


async def _device_status(run: _Run, out: _Answer, kind: str, ident: str) -> None:
    label = _named(kind, ident)
    problems = await run.call("list_current_problems")
    found = []
    if problems is not None:
        found = [p for p in _list(problems.data.get("problems")) if isinstance(p, dict)
                 and str(_dict(p.get("entity")).get("id")) == str(ident)]
        for p in found:
            out.fact(f"{label}: {PROBLEM_HE.get(p.get('kind'), _text(p.get('kind'), 40))} "
                     f"(חומרה {SEVERITY_HE.get(p.get('severity'), 'לא ידועה')}, נצפה {run.when(p.get('last_seen_iso'))}). "
                     f"פירוט: {_text(p.get('detail'), 140)}", _ids(problems, str(p.get("source_id") or "")))
        if not found:
            out.fact(f"לא נרשמה בעיה נוכחית עבור {label}.", _ids(problems))
    out.ref(_ref(kind, ident, ident))
    if kind in ("pdu", "kvm"):
        history = await run.call("get_history", device_id=ident, since_hours=168)
        if history is not None:
            events = [e for e in _list(history.data.get("items")) if isinstance(e, dict)]
            out.fact(f"ב-7 הימים האחרונים נרשמו {len(events)} אירועים הקשורים ל-{label}.", _ids(history))
    out.summary = (f"נמצאו {len(found)} בעיות רשומות עבור {label}." if found else
                   f"לא נרשמה בעיה נוכחית עבור {label}; אין בכך הוכחה שהוא תקין.")
    out.check(f"פתח את מסך {label} באתר ובדוק את מועד הבדיקה האחרונה.")


async def _dependencies(run: _Run, out: _Answer, question: str, target: dict, context: dict) -> None:
    text = str(question)
    kind = ident = label = None
    switch = re.search(r"(?:מתג|switch)\s+([^\s?,!]+)", text, re.IGNORECASE)
    if switch and switch.group(1) not in ("הזה", "הזאת", "this"):
        kind, ident = "switch", switch.group(1).strip(".")
    elif target.get("from_context") and target.get("kind") in ("pdu", "kvm", "server", "rack", "item"):
        kind, ident = target["kind"], target["id"]
    elif target.get("query"):
        resolved = await _resolve(run, out, target["query"], ("pdu", "kvm", "server", "rack", "item"))
        if resolved is None:
            return
        kind, ident, label = resolved["kind"], resolved["id"], resolved.get("label")
        if kind not in ("pdu", "kvm", "server", "rack", "item"):
            kind = "server"
    elif target.get("rack"):
        kind, ident = "rack", target["rack"]
    if not kind:
        out.summary = "לא זוהה בשאלה רכיב (PDU, KVM, מתג, ארון או שרת) שאת התלויות בו יש לבדוק."
        out.check("שאל שוב עם שם הרכיב, למשל: אילו שרתים מחוברים ל-PDU pdu-rack03?")
        return
    label = _text(label or ident, 60)
    named = _named(kind, label)
    result = await run.call("get_dependencies", kind=kind, id=ident)
    if result is None:
        out.summary = f"לא ניתן היה לקרוא את התלויות של {named}."
        return
    data = result.data
    servers = [s for s in _list(data.get("servers")) if isinstance(s, dict)]
    ids = _ids(result)
    if data.get("found") is False and not servers:
        out.summary = f"לא נמצאו רשומות תלות עבור {named}."
        out.fact(f"לא נמצאו בנתונים השמורים רכיבים המשויכים ל-{named}.", ids)
    else:
        names = ", ".join(_text(s.get("label") or s.get("id"), 30)
                          + (f" (פורט/שקע {_text(s.get('port'), 10)})" if s.get("port") not in (None, "") else "")
                          for s in servers[:15])
        out.summary = (f"לפי הנתונים השמורים, {len(servers)} שרתים תלויים ב-{named}."
                       " אלה שיוכים רשומים ולא בדיקה חיה.")
        if servers:
            out.fact(f"שרתים המשויכים ל-{named}: {names}.", ids)
        for key, name in (("pdus", "PDU"), ("kvms", "KVM")):
            devices = [d for d in _list(data.get(key)) if isinstance(d, dict)]
            if devices:
                out.fact(f"{name} בארון: {', '.join(_text(d.get('name') or d.get('id'), 30) for d in devices[:10])}.",
                         ids)
                for d in devices[:10]:
                    out.ref(_ref(key[:-1], d.get("id"), d.get("name")))
        for s in servers[:15]:
            out.ref(_ref("server", s.get("id"), s.get("label")))
        if data.get("redundancy_hint"):
            out.hypothesis("ייתכן שלחלק מהשרתים יש הזנת חשמל כפולה, כך שנפילת רכיב אחד לא תפיל אותם.",
                           ["השרת רשום ביותר משקע PDU אחד."],
                           "אמת פיזית את חיבורי החשמל של השרתים לפני עבודה על הרכיב.", ids)
    out.ref(_ref(kind, ident, label) if kind != "switch" else None)
    impact = await _optional(run, "analyze_impact", kind=kind, id=ident, entity_kind=kind, entity_id=ident,
                             entity={"kind": kind, "id": ident})
    if impact is not None:
        out.fact(_impact_text(impact), _ids(impact))
    out.check(f"לפני עבודה על {named}, ודא עם האחראים שהשרתים התלויים יכולים לרדת.")
    out.check("אמת פיזית את החיבורים: השיוכים בנתונים הם תוויות שמורות ולא בדיקה חיה.")


async def _optional(run: _Run, name: str, **candidates: Any) -> ToolResult | None:
    """Call an optional analysis tool only when it is available (absence is not reported as missing data)."""
    if not run.has(name):
        return None
    return await run.call(name, **candidates)


def _impact_text(result: ToolResult) -> str:
    """analyze_impact (analysis.py): the ranked affected servers, without guessing at fields it does not return."""
    ranked = [r for r in _list(result.data.get("ranked")) if isinstance(r, dict)]
    names = [_text(r.get("label") or r.get("server") or r.get("id"), 30) for r in ranked[:5]]
    names = [n for n in names if n]
    if not ranked:
        return "ניתוח ההשפעה לא מצא שרתים מושפעים בנתונים השמורים."
    return (f"ניתוח השפעה (ציון עדיפות היוריסטי, לא מדידה): {len(ranked)} שרתים מושפעים"
            + (f"; בראש הרשימה: {', '.join(names)}" if names else "") + ".")


_POWER = re.compile(r"(\d+(?:\.\d+)?)\s*(kw|קילוואט|קילו-וואט|w|watts?|וואט|ואט)(?![A-Za-z])", re.IGNORECASE)
_UNITS = re.compile(r"(?<![A-Za-z0-9-])(\d{1,2})\s*(?:u|יחידות|מדפים|מדף)(?![A-Za-z0-9])", re.IGNORECASE)
_NETWORK = ("רשת", "מתג", "network", "switch")


def capacity_request(question: str) -> dict:
    """What the user said about the new equipment: power_w, units and needs_network (only what is stated)."""
    text = str(question)
    request: dict = {}
    power = _POWER.search(text)
    if power:
        value = float(power.group(1)) * (1000 if power.group(2).casefold() in ("kw", "קילוואט", "קילו-וואט") else 1)
        if 0 < value <= 100_000:
            request["power_w"] = int(value) if value.is_integer() else value
    units = _UNITS.search(text)
    if units and 1 <= int(units.group(1)) <= 42:
        request["units"] = int(units.group(1))
    if any(word in text.casefold() for word in _NETWORK):
        request["needs_network"] = True
    return request


async def _capacity(run: _Run, out: _Answer, question: str, target: dict, context: dict) -> None:
    rack = target.get("rack")
    if not rack and target.get("query"):
        resolved = await _resolve(run, out, target["query"], ("rack", "server"))
        if resolved is None:
            return
        if resolved.get("kind") == "rack":
            rack = resolved["id"]
        else:
            await _server_status(run, out, question, {"query": resolved["id"]}, context)
            return
    if not rack:
        out.summary = "לא זוהה בשאלה ארון. ציין את שם הארון (למשל Rack-01) כדי לבדוק מקום, חשמל ותלויות."
        out.check("שאל שוב עם שם הארון.")
        return
    rack = _text(rack, 40)
    out.ref(_ref("rack", rack, rack))
    request = capacity_request(question)
    layout = await run.call("get_rack_layout", rack=rack)
    power = await run.call("get_power_and_environment", rack=rack)
    plan = await _optional(run, "plan_capacity", rack=rack, **request)
    shelves_text = "מספר המדפים בארון אינו ידוע"
    if layout is not None:
        data = layout.data
        shelf_count = data.get("shelf_count")
        confidence = _text(data.get("mapping_confidence") or "unknown", 20)
        servers = [s for s in _list(data.get("servers")) if isinstance(s, dict)]
        items = [i for i in _list(data.get("items")) if isinstance(i, dict)]
        free = data.get("free_shelves")
        if isinstance(shelf_count, int):
            shelves_text = f"לפי התאום הדיגיטלי יש בארון {shelf_count} מדפים (ביטחון המיפוי: {confidence})"
            out.fact(f"{shelves_text}.", _ids(layout, "twin"))
        out.fact(f"בארון {rack} רשומים {len(servers)} שרתים ו-{len(items)} פריטי ציוד.",
                 _ids(layout, "rack_slots", "rack_items", "devices"))
        if isinstance(free, list):
            listed = ", ".join(f"U{int(u):02d}" for u in free if isinstance(u, int)) or "אין"
            out.fact(f"מדפים פנויים לפי הנתונים: {listed} (ביטחון נמוך; U01 הוא המדף העליון).",
                     _ids(layout, "rack_slots", "twin"))
            shelves_text += f"; מדפים פנויים לפי הנתונים: {listed}"
        else:
            out.missing("אי אפשר לקבוע מדפים פנויים: חסרים מקורות מיקום או מיפוי מדפים לארון.")
        auto = [s for s in servers if s.get("auto_placed")]
        if auto:
            out.missing(f"{len(auto)} שרתים בארון מוקמו אוטומטית (ללא מיקום שמור), ולכן התפוסה אינה ודאית.")
    power_text = "אין קריאת עומס חשמל ידועה"
    utilization = None
    if power is not None:
        data = power.data
        pdus = [p for p in _list(data.get("pdus")) if isinstance(p, dict)]
        capacity = _dict(data.get("capacity"))
        assumed = capacity.get("assumed_watts_per_pdu")
        for p in pdus:
            name = _named("pdu", p.get("name") or p.get("id"))
            watts = p.get("total_watts")
            ref_ids = _ids(power, f"pdu_cache:{p.get('id')}", "monitor_device_snapshots")
            if isinstance(watts, (int, float)) and not p.get("stale"):
                complete = "" if p.get("watts_complete") else " (חלקי: לא כל השקעים מדווחים)"
                out.fact(f"{name}: עומס ידוע {watts:.0f} W{complete}, לפי קריאה שמורה מ-{run.when(p.get('cache_as_of'))}.",
                         ref_ids)
                if isinstance(assumed, (int, float)) and assumed > 0:
                    ratio = watts / assumed
                    utilization = max(utilization or 0.0, ratio)
                    out.fact(f"{name}: כ-{ratio:.0%} מ-{assumed:.0f} W - הנחה (קבוע ממשק: 16 A × 208 V), לא נתון "
                             "מוגדר של ה-PDU.", ref_ids)
            else:
                out.fact(f"{name}: אין קריאת עומס עדכנית (הקריאה חסרה, ישנה או לא אומתה).", ref_ids)
            out.ref(_ref("pdu", p.get("id"), p.get("name")))
        totals = _dict(data.get("totals"))
        if isinstance(totals.get("total_watts"), (int, float)):
            power_text = f"עומס כולל ידוע {totals['total_watts']:.0f} W (כל PDU נספר פעם אחת)"
            out.fact(f"עומס כולל ידוע בארון {rack}: {totals['total_watts']:.0f} W, כל PDU נספר פעם אחת.", _ids(power))
        elif isinstance(totals.get("known_watts"), (int, float)):
            power_text = f"עומס ידוע חלקי {totals['known_watts']:.0f} W"
        if not pdus:
            out.fact(f"לא נמצאו PDU המשויכים לארון {rack}.", _ids(power))
        thresholds = [t for t in _list(data.get("thresholds")) if isinstance(t, dict)]
        if thresholds:
            out.fact("ספי התראה מוגדרים בשרת לכניסות PDU: " + ", ".join(
                f"{_text(t.get('metric'), 12)} {_text(t.get('side'), 6)} {_text(t.get('value'), 10)} {_text(t.get('unit'), 4)}"
                for t in thresholds[:6]) + ".", _ids(power, "power_thresholds"))
    missing_info = ["משקל ומידות השרת והמדף", "נתוני קירור וטמפרטורה בארון", "פורטים פנויים במתג",
                    "דירוג החשמל האמיתי של ה-PDU (16 A הוא הנחה)"]
    if "power_w" not in request:
        missing_info.insert(1, "צריכת החשמל של השרת החדש")
    verdict = ""
    priority = "high" if utilization is not None and utilization >= 0.95 else "medium"
    if plan is not None:
        overall_text = plan.data.get("overall_text")
        if isinstance(overall_text, str) and overall_text.strip():
            verdict = _text(overall_text, 240)
            out.fact(f"הערכת כלי תכנון הקיבולת: {verdict}.", _ids(plan))
        if plan.data.get("overall") == "no":
            priority = "high"
        missing_info += [_text(m, 160) for m in _list(plan.data.get("missing_info")) if isinstance(m, str)]
        for assumption in _list(plan.data.get("assumptions"))[:5]:
            if isinstance(assumption, str):
                out.missing(f"הנחה בחישוב: {_text(assumption, 200)}")
    out.recommendation(
        title=f"בדיקת היתכנות להוספת שרת לארון {rack}",
        problem="לפני הוספת שרת יש לוודא מקום פיזי, עומס חשמל, חיבור רשת וקירור.",
        evidence=f"{shelves_text}; {power_text}." + (f" {verdict}." if verdict else ""),
        priority=priority,
        next_step="ודא פיזית שהמדף פנוי, בדוק את העומס העדכני במסך ה-PDU ואת הפורטים הפנויים במתג לפני ההתקנה.",
        missing_info=list(dict.fromkeys(missing_info)),
        ids=_ids(layout) + _ids(power) + _ids(plan), refs=[_ref("rack", rack, rack)])
    if utilization is not None and utilization >= 0.8:
        out.missing("העומס על אחד ה-PDU גבוה ביחס להנחת 16 A (סף 80% מהממשק הוא הנחה, לא סף מוגדר).")
    from_screen = " (הארון נלקח מהמסך שבו אתה צופה)" if target.get("rack_from_context") else ""
    if "power_w" in request:
        from_screen += f" (הספק הציוד החדש לפי השאלה: {request['power_w']:g} W)"
    out.summary = (f"בדיקת קיבולת לארון {rack}{from_screen}: {shelves_text}; {power_text}."
                   + (f" הערכה: {verdict}." if verdict else "")
                   + " אין בנתונים משקל, מידות, קירור או פורטים פנויים, ולכן אין כאן אישור סופי שאפשר להוסיף שרת.")
    out.check(f"ודא פיזית שיש מדף פנוי בארון {rack} ושהמשקל מתאים.")
    out.check("בדוק במסך ה-PDU את העומס העדכני ואת השקעים הפנויים.")
    out.check("ודא שיש פורט פנוי במתג וכבל מתאים.")
    out.check("ודא שהקירור בארון מספיק לציוד נוסף.")


async def _history(run: _Run, out: _Answer, question: str, target: dict, context: dict) -> None:
    server = device_id = None
    label = "המעבדה"
    if target.get("from_context") and target.get("kind") == "server":
        server = label = target["id"]
    elif target.get("from_context") and target.get("kind") in ("pdu", "kvm"):
        device_id, label = target["id"], _named(target["kind"], target["id"])
    elif target.get("query"):
        resolved = await _resolve(run, out, target["query"], ("server", "pdu", "kvm"))
        if resolved is None:
            return
        if resolved.get("kind") in ("pdu", "kvm"):
            device_id, label = resolved["id"], _named(resolved["kind"], resolved.get("label") or resolved["id"])
        else:
            server, label = resolved["id"], resolved.get("label") or resolved["id"]
    label = _text(label, 60)
    result = await run.call("get_history", server=server, device_id=device_id, since_hours=720, limit=200)
    if result is None:
        out.summary = f"לא ניתן היה לקרוא את ההיסטוריה של {label}."
        return
    data = result.data
    if data.get("status") in ("ambiguous", "not_found"):
        out.summary = f"לא ניתן היה לזהות באופן חד-משמעי את {label} בהיסטוריה."
        out.fact(out.summary, _ids(result))
        out.check("שאל שוב עם שם מלא או מזהה ייחודי.")
        return
    events = [e for e in _list(data.get("items")) if isinstance(e, dict)]
    counts: dict[str, int] = {}
    for e in events:
        counts[e.get("kind")] = counts.get(e.get("kind"), 0) + 1
    days = round((data.get("since_hours") or 720) / 24)
    if events:
        parts = ", ".join(f"{n} × {EVENT_HE.get(k, _text(k, 30))}" for k, n in counts.items())
        out.fact(f"ב-{days} הימים האחרונים נרשמו עבור {label} {len(events)} אירועים: {parts}.",
                 _ids(result, *sorted({str(e.get("source_id")) for e in events if e.get("source_id")})))
        for e in events[:8]:
            overlap = " (חופף בזמן לאירוע אחר; אין בכך קשר סיבתי)" if _list(e.get("co_occurred_with")) else ""
            out.fact(f"{run.when(e.get('at_iso'))}: {EVENT_HE.get(e.get('kind'), _text(e.get('kind'), 30))} - "
                     f"{_text(e.get('detail'), 100).rstrip('.')}{overlap}.", _ids(result, str(e.get("source_id") or "")))
        pings = counts.get("ping_incident", 0)
        out.summary = (f"כן: ב-{days} הימים האחרונים נרשמו {pings} אירועי ping עבור {label}." if pings else
                       f"ב-{days} הימים האחרונים לא נרשמו אירועי ping עבור {label}, אך נרשמו {len(events)} אירועים אחרים.")
    else:
        out.summary = (f"לא נמצאו אירועים רשומים עבור {label} ב-{days} הימים האחרונים. ייתכן שנפילות קצרות לא "
                       "נקלטו (בלילה הבדיקה כל 30 דקות) ושהיסטוריה ישנה נמחקה.")
        out.fact(f"לא נמצאו אירועים רשומים עבור {label} ב-{days} הימים האחרונים.", _ids(result))
    if data.get("truncated"):
        out.missing("רשימת האירועים קוצרה.")
    out.check("השווה את זמני האירועים לפעולות תחזוקה ולשינויים שבוצעו באותו זמן (חפיפה בזמן אינה הוכחה לסיבה).")


async def _work(run: _Run, out: _Answer, question: str, target: dict, context: dict) -> None:
    result = await run.call("list_current_problems")
    problems = [p for p in _list(result.data.get("problems")) if isinstance(p, dict)] if result else []
    selected, seen = [], set()
    ranked = sorted(problems, key=lambda p: (("high", "medium").index(p["severity"])
                                             if p.get("severity") in ("high", "medium") else 9,
                                             p.get("kind") == "open_ping_incident"))
    for p in ranked:  # one draft per equipment (an open incident and "down" for one server are one job)
        entity = _dict(p.get("entity"))
        key = _text(entity.get("label") or entity.get("id"), 60).casefold()
        if p.get("severity") in ("high", "medium") and key not in seen and len(selected) < 3:
            seen.add(key)
            selected.append(p)
    for p in selected:
        entity = _dict(p.get("entity"))
        label = _text(entity.get("label") or entity.get("id"), 60)
        kind = PROBLEM_HE.get(p.get("kind"), _text(p.get("kind"), 40))
        ref = _ref(entity.get("kind"), entity.get("id"), entity.get("label"))
        ids = _ids(result, str(p.get("source_id") or ""))
        evidence = f"{kind}; נצפה {run.when(p.get('last_seen_iso'))}; פירוט: {_text(p.get('detail'), 120)}"
        out.fact(f"{label}: {kind} (חומרה {SEVERITY_HE.get(p.get('severity'), 'לא ידועה')}).", ids)
        out.ref(ref)
        out.recommendation(title=f"טיפול ב-{label}", problem=kind, evidence=evidence,
                           priority=p.get("severity"), next_step=_check_for(p.get("kind")),
                           missing_info=["סיבת השורש אינה ידועה מהנתונים"], ids=ids, refs=[ref])
        out.draft(title=f"בדיקת {label}: {kind}", description=f"{kind}. {_text(p.get('detail'), 200)}",
                  refs=[ref], priority=p.get("severity"),
                  rationale=f"מבוסס על נתוני הניטור ({p.get('source_id') or 'ניטור'}), נצפה {run.when(p.get('last_seen_iso'))}.",
                  steps=_steps_for(p.get("kind")))
    if not selected:
        overview = await run.call("lab_status_overview")
        enabled = _dict(overview.data.get("enabled_sources")) if overview else {}
        for key, title, why in (
                ("email_alerts", "הפעלת התראות דוא\"ל", "התראות דוא\"ל כבויות, ולכן אין היסטוריית התראות ותנאי התראה."),
                ("ping_monitor", "הפעלת ניטור ping", "ניטור ה-ping כבוי, ולכן נתוני הזמינות אינם מתעדכנים.")):
            if key in enabled and not enabled[key]:
                ids = _ids(overview)
                out.fact(why, ids)
                out.recommendation(title=title, problem=why, evidence=why, priority="low",
                                   next_step="הגדר את הניטור בקובץ ההגדרות של השרת והפעל מחדש את השירות.",
                                   missing_info=[], ids=ids, refs=[])
                out.draft(title=title, description=why, refs=[], priority="low",
                          rationale="שיפור כיסוי הניטור; אין כרגע בעיות רשומות בחומרה גבוהה או בינונית.",
                          steps=["עדכן את ההגדרה בקובץ ה-.env של השרת", "הפעל מחדש את השירות",
                                 "ודא במסך הניטור שהנתונים מתעדכנים"])
    count = len(out.answer["work_item_drafts"])
    if count:
        out.summary = (f"הוכנו {count} טיוטות עבודה לעריכה. טיוטה אינה נשמרת ואינה מבוצעת עד שתאשר אותה; "
                       "שמירה דורשת הרשאת Operator.")
    else:
        out.summary = ("לא נמצאו בעיות רשומות שמצדיקות טיוטת עבודה כרגע. אין בכך הוכחה שהמעבדה תקינה; "
                       "חלק מהרכיבים אינם מנוטרים.")
    out.check("עבור על הטיוטות, ערוך אותן ושמור רק את מה שנדרש.")


def _steps_for(kind) -> list[str]:
    return {
        "ping_down": ["בדוק את מסך השרת בקונסולת KVM", "בדוק את שקע ה-PDU שמזין את השרת",
                      "בדוק את כבל הרשת ואת פורט המתג", "תעד את הממצאים ועדכן את הרשומה"],
        "device_unreachable": ["בדוק שממשק הניהול של ההתקן מגיב ברשת", "ודא שפרטי הגישה בהגדרות ההתקן תקינים",
                               "הרץ 'Check all' במסך הניטור", "תעד את הממצאים"],
        "outlet_off": ["ברר ביומן התחזוקה מי כיבה את השקע ומדוע", "החלט אם להדליק אותו מחדש",
                       "ודא שהשרת חוזר לענות ל-ping"],
        "open_ping_incident": ["בדוק את ציר הזמן של האירוע", "אמת את מצב השרת פיזית", "סגור את הטיפול לאחר התיקון"],
    }.get(kind, ["אמת את הבעיה במסך הציוד ופיזית", "תעד את הממצאים"])


async def _overview(run: _Run, out: _Answer, question: str, target: dict, context: dict) -> None:
    result = await run.call("lab_status_overview")
    if result is None:
        out.summary = "לא ניתן היה לקרוא את סקירת מצב המעבדה."
        return
    data = result.data
    monitor = _dict(data.get("monitor"))
    counts = _dict(data.get("target_counts"))
    devices = [d for d in _list(data.get("devices")) if isinstance(d, dict)]
    maintenance = _list(data.get("maintenance"))
    if monitor:
        out.fact(f"שירות הניטור: {STATUS_HE.get(monitor.get('status'), _text(monitor.get('status'), 30))}; "
                 f"סבב אחרון הושלם {run.when(monitor.get('last_completed_at'))}.", _ids(result, "ping_monitor_state"))
    if counts:
        parts = ", ".join(f"{STATUS_HE.get(k, k)}: {v}" for k, v in counts.items() if isinstance(v, int) and v)
        out.fact(f"יעדי ping ({data.get('target_total', sum(v for v in counts.values() if isinstance(v, int)))}): "
                 f"{parts or 'אין'}.", _ids(result, "ping_targets"))
    if isinstance(data.get("open_incidents"), int):
        out.fact(f"אירועי ping פתוחים: {data['open_incidents']}.", _ids(result, "ping_incidents"))
    if devices:
        tally: dict[str, int] = {}
        for d in devices:
            tally[d.get("status")] = tally.get(d.get("status"), 0) + 1
        out.fact("התקני PDU/KVM: " + ", ".join(f"{STATUS_HE.get(k, _text(k, 20))}: {v}" for k, v in tally.items()) + ".",
                 _ids(result, "monitor_device_snapshots"))
    out.fact(f"תחזוקות PDU פעילות: {len(maintenance)}.", _ids(result, "pdu_maintenance"))
    enabled = _dict(data.get("enabled_sources"))
    off = [name for name, on in enabled.items() if not on]
    if off:
        out.missing("מקורות שאינם פעילים: " + ", ".join(_text(n, 30) for n in off) + ".")
    down = counts.get("down", 0) if isinstance(counts.get("down"), int) else 0
    out.summary = (f"סקירת מצב: {counts.get('up', 0)} יעדי ping זמינים, {down} לא זמינים, "
                   f"{counts.get('stale', 0)} לא עדכניים ו-{counts.get('unknown', 0)} במצב לא ידוע. "
                   "אין בכך הוכחה לתקינות מלאה: UPS, קירור ומתגים אינם מנוטרים.")
    out.check("שאל \"מה נפל במעבדה?\" כדי לראות את הבעיות הנוכחיות לפי חומרה.")


_HANDLERS = {"problems": _problems, "server_status": _server_status, "dependencies": _dependencies,
             "capacity": _capacity, "history": _history, "work": _work, "overview": _overview}


async def answer(*, question: str, history: list[dict] | None, context: dict | None, ctx: ToolContext,
                 tools: list[ToolSpec], reason: str | None = None) -> dict:
    """Build a demo EngineResult: {"mode": "demo", "answer", "ledger", "usage": None, "demo_reason"}."""
    run = _Run(ctx, tools)
    out = _Answer()
    context = clean_context(context)
    intent = classify(question)
    target = _target(question, context)
    if not tools:
        out.summary = "אין כרגע כלים זמינים לקריאת נתוני המעבדה, ולכן אין תשובה מבוססת נתונים."
    else:
        try:
            await _HANDLERS[intent](run, out, question, target, context)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - unexpected tool data shape: keep what was already verified
            log.warning("Assistant demo responder failed while rendering %s (%s).", intent, type(exc).__name__)
            out.summary = "לא ניתן היה להשלים את תשובת ההדגמה; מוצגים רק הממצאים שנאספו עד לשגיאה."
            out.missing("חלק מנתוני הכלים הגיעו במבנה לא צפוי ולא עובדו.")
    if target.get("from_context") and tools:
        out.summary = (out.summary + f" (הרכיב נלקח מהמסך שבו אתה צופה: {target.get('kind')} "
                       f"{_text(target.get('id'), 60)}, ונבדק מחדש בכלים.)").strip()
    reason_text = reason_hebrew(reason)
    extra = [f"התשובה הופקה במצב הדגמה ללא מודל שפה. {reason_text}"]
    extra.extend(run.missing)
    result = out.answer
    result["summary"] = f"{DEMO_PREFIX} {out.summary or 'לא נמצאו נתונים רלוונטיים לשאלה.'}"
    result["missing_data"] = list(dict.fromkeys(extra + result["missing_data"]))
    return {"mode": "demo", "answer": finalize(result, run.ledger), "ledger": run.ledger.sources(),
            "usage": None, "demo_reason": reason_text}


def reason_hebrew(reason: str | None) -> str:
    """The fixed Hebrew sentence for a demo reason code; a Hebrew reason given by the router is kept (clipped)."""
    if reason in DEMO_REASON_TEXT:
        return DEMO_REASON_TEXT[reason]
    if isinstance(reason, str) and reason.strip() and not reason.isascii():
        return _text(reason, 300)
    return DEMO_REASON_TEXT["router_demo"]
