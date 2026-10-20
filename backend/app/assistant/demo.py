"""Demo responder: deterministic Hebrew answers built from REAL tool results, without a language model.

Used when the LLM is disabled, no API key is configured or the SDK is missing, and as the answer when an LLM
call fails. The question is classified with keyword rules (Hebrew + English), mapped to the same tools the model
would use, and the tool data is rendered into the standard answer object. Actions only create proposals for the
user to confirm in the card; this responder never executes them. Every fact cites the source
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
MAINTENANCE_ACTION_HE = {"shutdown": "כיבוי שקעים לתחזוקה", "restore": "החזרת שקעים מתחזוקה",
                         "denied": "בקשת תחזוקה שנדחתה"}
DIMENSION_HE = {"space": "מקום", "power": "חשמל", "cooling": "קירור", "network": "רשת", "redundancy": "יתירות",
                "weight": "משקל", "cabling": "כבילה"}
# Detail strings the tools emit as fixed templates (no extra information beyond the problem kind/status fields).
_TEMPLATE_DETAILS = {
    "Recorded ICMP incident remains open.", "PDU maintenance is active.", "Monitor round is overdue.",
    "Recorded alert condition.", "Recorded alert condition (observation is stale).",
    "Recorded ICMP incident; temporal overlap does not establish a cause.", "Alert email subject only.",
}

# (intent, keywords) - first match wins; substring match on the lower-cased question.
_RULES = (
    ("history", ("קרה בעבר", "קרתה בעבר", "קרו בעבר", "בעבר", "היסטורי", "history", "happened before",
                 "in the past", "previously")),
    ("work", ("טיוט", "תחזוק", "עבודה", "עבודות", "משימ", "maintenance", "draft", "work item", "task")),
    ("capacity", ("קיבול", "להוסיף", "הוספת", "עומס", "עמוס", "מקום פנוי", "capacity", "add a ", "add server",
                  "free shelf", "power load")),
    # "מה המצב של <equipment>?" (the panel's first example for the viewed equipment) -> that equipment's status.
    ("entity_status", ("מה המצב של", "מה מצב ה", "מה מצבו", "מה מצבה", "מה קורה עם", "status of", "state of",
                       "how is ")),
    ("dependencies", ("מושפע", "תלוי", "תלות", "מתג", "switch", "depend", "impact", "affected")),
    ("server_status", ("לא זמין", "לא עונה", "לא מגיב", "למה", "סטטוס", "status", "unreachable", "not reachable",
                       "why ")),
    ("problems", ("נפל", "תקל", "בעי", "התרא", "לבדוק קודם", "down", "outage", "problem", "fault", "alert",
                  "broken", "failing", "check first")),
    ("capacity", ("ארון", "rack")),
)


def classify(question: str) -> str:
    """Intent of a question: history, work, capacity, entity_status, dependencies, server_status, problems or
    overview."""
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


# ---------------------------------------------------------------------------------------------------------------
# Hebrew wording for the tools' detail strings: chosen from the structured kind/status fields, never by parsing the
# free text. Operator-entered text is quoted after "פירוט:"; an English tool/device message that has no Hebrew
# template is kept verbatim after "פירוט טכני:".
# ---------------------------------------------------------------------------------------------------------------
def problem_text(problem: dict) -> tuple[str, str | None, str | None]:
    """(Hebrew description, quoted operator text, technical English detail) for a list_current_problems entry."""
    kind = str(problem.get("kind") or "")
    detail = _text(problem.get("detail"), 140)
    status = kind.split("_", 1)[1] if "_" in kind else ""
    hebrew = PROBLEM_HE.get(kind) or f"בעיה רשומה ({_text(kind, 40)})"
    quoted = technical = None
    if kind == "outlet_off" and problem.get("outlet") not in (None, ""):
        hebrew = (f"ה-PDU מדווח שהשקע {_text(problem.get('outlet'), 10)} כבוי (OFF); לא ידוע אם השרת שמחובר אליו "
                  "זמין")
    elif kind == "active_maintenance":
        quoted = detail if detail and detail not in _TEMPLATE_DETAILS else None
    elif kind.startswith("ping_"):
        technical = detail if detail and detail != f"ICMP observation is {status}." else None
    elif kind.startswith("device_"):
        technical = detail if detail and detail != f"Device observation is {status}." else None
    elif detail and detail not in _TEMPLATE_DETAILS:
        technical = detail
    return hebrew, quoted, technical


def detail_suffix(quoted: str | None, technical: str | None) -> str:
    parts = []
    if quoted:
        parts.append(f"פירוט: \"{quoted.rstrip('.')}\".")
    if technical:
        parts.append(f"פירוט טכני: {technical}")
    return (" " + " ".join(parts)) if parts else ""


def event_text(event: dict) -> str:
    """Hebrew wording for a get_history event, from its kind/action fields."""
    kind = event.get("kind")
    detail = _text(event.get("detail"), 120)
    if kind == "ping_incident":
        return "אירוע ping (השרת לא ענה לבדיקות)"
    if kind == "pdu_maintenance":
        text = MAINTENANCE_ACTION_HE.get(event.get("action"), "פעולת תחזוקת PDU")
        if event.get("device_id"):
            text += f" ב-{_named('pdu', event.get('device_id'))}"
        return text + (f". פירוט: \"{detail.rstrip('.')}\"" if detail else "")
    if kind == "alert_email":
        subject = _text(event.get("subject"), 120)
        return "התראת דוא\"ל" + (f". נושא: \"{subject}\"" if subject else "")
    if kind == "rack_item_move":
        item = _text(event.get("item_id"), 60)
        return "הזזת פריט" + (f" {item}" if item else "") + (f". הערה: \"{detail.rstrip('.')}\"" if detail else "")
    base = EVENT_HE.get(kind) or f"אירוע ({_text(kind, 30)})"
    return base + (f". פירוט טכני: {detail}" if detail and detail not in _TEMPLATE_DETAILS else "")


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
        self.context_used: str | None = None   # set only by a handler that really answered about the viewed item

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


# Action commands deliberately use their own parser: _target chooses the first match and may use the viewed
# equipment, which is useful for read-only questions but would guess the scope of a power action.
_ACTION_WORDS = {
    "off": r"כבה|תכבה|כבו|תוריד\s+(?:את\s+)?(?:החשמל|חשמל|מתח)|נתק\s+(?:את\s+)?(?:החשמל|חשמל|מתח)|turn\s+off|switch\s+off|power\s+off|shut\s*down",
    "on": r"הדלק|תדליק|הדליקו|turn\s+on|switch\s+on|power\s+on",
    "cycle": r"אתחל|תאתחל|ריסט|(?:תעשה|עשה|תבצע|בצע)\s+(?:ריסט|אתחול)|reset|reboot|restart",
    "console": r"פתח|תפתח|open|launch",
    "restore": r"החזר|תחזיר|restore",
    "maintenance": r"הכנס|תכניס|put|enter",
}
_ACTION_PATTERNS = {kind: re.compile(r"(?<!\w)(?:ו)?(?:" + words + r")(?!\w)", re.IGNORECASE)
                    for kind, words in _ACTION_WORDS.items()}
_ACTION_START = re.compile(r"^(?:(?:please|בבקשה|אנא)\s+)+", re.IGNORECASE)
_ACTION_OPT = re.compile(r"(?<![A-Za-z0-9_.-])opt\s*(\d+)(?![A-Za-z0-9_-]|\.[A-Za-z0-9_])", re.IGNORECASE)
_ACTION_CONSOLE = re.compile(r"(?<!\w)(?:kvm|console|קונסול)(?!\w)", re.IGNORECASE)
_ACTION_LAB = re.compile(r"(?<!\w)(?:לכל\s+)?(?:המעבדה|המעבדות|מעבדה|למעבדה|lab|laboratory)(?!\w)", re.IGNORECASE)
_ACTION_LAB_WIDE = ("כל המעבדה", "כל המעבדות", "lab-wide", "whole lab", "entire lab", "all the lab")
_ACTION_QUALIFIER = re.compile(
    r"(?<!\w)(?:אל|לא|בלי|ללא|אם|אולי|או|חוץ|פרט|מלבד|חלק|don't|dont|not|do\s+not|never|without|except|if|unless|or|some)(?!\w)",
    re.IGNORECASE)
_ACTION_FILLER = frozenset(("turn switch power off on shut down shutdown reset reboot restart open launch "
                            "restore put enter lab laboratory rack pdu server servers kvm console maintenance "
                            "the a an all whole entire to for of into in at and then it me my please now").split())
_ACTION_HE_FILLER = frozenset(("את לי של לשרת השרת שרת ארון הארון לכל כל המעבדה המעבדות מעבדה "
                               "חשמל החשמל מתח לתחזוקה תחזוקה קונסול הקונסול קונסולת עבור ל ו ב").split())
_ACTION_CLARIFY = "איזו פעולה לבצע ועל איזה יעד בדיוק? ציין שרת אחד, PDU אחד, ארון אחד או את כל המעבדה."
_ACTION_GUIDANCE = ("פעולת חשמל עשויה להשפיע על כל הזנות החשמל של היעד; רשימת השקעים וההחרגות המדויקת תוצג "
                    "בכרטיס לפני אישור. כדי לפעול, כתוב פקודה מפורשת, למשל: 'כבה את OPT11' או 'כבה חשמל לכל המעבדה'.")


def _action_request(question: str) -> tuple[dict | None, str | None]:
    """(request, clarification), or (None, None) for the existing read-only responder.

    Only direct commands are proposals. Multiple targets, conflicting verbs and partial/negated scopes require
    clarification. Resolution, permissions and impact remain the responsibility of propose_action.
    """
    text = _ACTION_OPT.sub(lambda m: "OPT" + m.group(1), str(question).strip())
    text = _ACTION_START.sub("", text).strip()
    matches = {kind: list(pattern.finditer(text)) for kind, pattern in _ACTION_PATTERNS.items()}
    kinds = {kind for kind, found in matches.items() if found}
    lab_off = re.match(r"^(?:(?:whole|entire)\s+lab|lab-wide|lab|laboratory)\s+(?:power\s+off|shutdown)(?!\w)",
                       text, re.IGNORECASE)
    starts_command = any(found and found[0].start() == 0 for found in matches.values()) or lab_off
    if not starts_command:
        if kinds or re.search(r"אכבה|נכבה|לכבות|כיבוי|מה יקרה|what\s+if", text, re.IGNORECASE):
            return None, "נדרשת פקודה מפורשת בתחילת ההודעה כדי להכין הצעה."
        return None, None
    if any(mark in text for mark in ("?", "؟", "？")) or _ACTION_QUALIFIER.search(text):
        return None, _ACTION_CLARIFY
    if not kinds or any(len(found) > 1 for found in matches.values()):
        return None, _ACTION_CLARIFY
    if len(kinds) > 1 and kinds != {"cycle", "console"}:
        return None, _ACTION_CLARIFY
    if kinds != {"cycle", "console"} and re.search(r"(?<!\w)(?:and|גם|וגם|ואת)(?!\w)", text, re.IGNORECASE):
        return None, _ACTION_CLARIFY
    if kinds == {"cycle", "console"} and matches["console"][0].start() < matches["cycle"][0].start():
        return None, _ACTION_CLARIFY

    # Include bare ASCII names too, so a second target such as "open KVM for odin" cannot be ignored just
    # because it contains no digit. Unknown extra words conservatively make the command ambiguous.
    scan_text = re.sub(r"\blab-wide\b", "lab", text, flags=re.IGNORECASE)
    words = re.findall(r"(?<![A-Za-z0-9_.-])[A-Za-z][A-Za-z0-9_.-]*", scan_text)
    tokens = _tokens(scan_text) + [word.rstrip(".") for word in words if word.casefold() not in _ACTION_FILLER]
    # Preserve names as typed except for the explicitly supported opt 11 -> OPT11 normalization.
    originals = {t.casefold(): t for t in tokens}
    names = list(originals)
    remaining = text
    for pattern in _ACTION_PATTERNS.values():
        remaining = pattern.sub(" ", remaining)
    for token in originals.values():
        remaining = re.sub(re.escape(token), " ", remaining, flags=re.IGNORECASE)
    # Unknown Hebrew words can be an extra target or a condition. Do not silently discard them, or standalone
    # numbers (e.g. a second server abbreviated as "12"). Names already removed above are resolved by the tool.
    if (any(word not in _ACTION_HE_FILLER for word in re.findall(r"[א-ת]+", remaining))
            or re.search(r"\d", remaining)):
        return None, _ACTION_CLARIFY
    lab = bool(_ACTION_LAB.search(text))
    rack = bool(re.search(r"(?<!\w)(?:ארון|rack)(?!\w)", text, re.IGNORECASE))
    pdu = bool(re.search(r"(?<!\w)pdu(?:\b|[-_])", text, re.IGNORECASE))
    if len(names) > 1 or (lab and (names or rack or pdu)):
        return None, _ACTION_CLARIFY
    if lab and re.search(r"(?<!\w)(?:ה?שרת|לשרת|servers?)(?!\w)", text, re.IGNORECASE):
        return None, _ACTION_CLARIFY
    name = originals[names[0]] if names else None
    rack = rack or bool(name and _RACK.fullmatch(name))
    if rack and re.search(r"(?<!\w)(?:ה?שרת|לשרת|servers?)(?!\w)", text, re.IGNORECASE):
        return None, _ACTION_CLARIFY

    if kinds == {"restore"}:
        if names or rack or pdu or not (lab or re.search(r"חשמל|מתח|power", text, re.IGNORECASE)):
            return None, "לאיזו פעולת כיבוי להחזיר חשמל? כדי להחזיר את הכיבוי האחרון שלך, בקש 'תחזיר חשמל'."
        return {"kind": "batch_restore", "restore_of": "latest"}, None
    if kinds == {"maintenance"}:
        if not name or not pdu or not re.search(r"תחזוק|maintenance", text, re.IGNORECASE):
            return None, "איזה PDU להכניס לתחזוקה? ציין את השם המלא שלו."
        return {"kind": "pdu_shutdown", "pdu": name}, None
    if kinds == {"off"} and lab:
        if not any(phrase in text.casefold() for phrase in _ACTION_LAB_WIDE):
            return None, "האם הכוונה לכל המעבדה? ציין במפורש את היקף הכיבוי."
        return {"kind": "lab_shutdown"}, None
    if kinds == {"off"} and rack and name and not pdu:
        return {"kind": "rack_shutdown", "rack": name}, None
    if not name or lab or rack or pdu:
        return None, _ACTION_CLARIFY
    if "console" in kinds and not _ACTION_CONSOLE.search(text):
        return None, "האם לפתוח קונסולת KVM? ציין את שם השרת המלא."
    if kinds == {"console"}:
        return {"kind": "open_console", "server": name}, None
    if "cycle" in kinds:
        request = {"kind": "server_cycle", "server": name}
        if "console" in kinds:
            request["then_console"] = True
        return request, None
    return {"kind": "server_" + next(iter(kinds)), "server": name}, None


async def _propose_action(run: _Run, out: _Answer, request: dict) -> None:
    if (getattr(run.ctx.settings, "accounts_enabled", False) is not True or run.ctx.principal.legacy):
        out.summary = "פעולות העוזר זמינות רק במצב חשבונות משתמשים, עם הרשאת Operator לפחות."
        return
    if (getattr(run.ctx.settings, "assistant_actions_enabled", False) is not True
            or not run.has("propose_action") or not run.ctx.principal.allows("Operator")):
        out.summary = "פעולות העוזר כבויות בשרת או שאינן זמינות לך; יצירת הצעה דורשת הרשאת Operator לפחות."
        return
    result = await run.call("propose_action", **request)
    if result is None:
        out.summary = ("לא ניתן היה להכין הצעת פעולה. מהו השם המלא והייחודי של היעד המבוקש? "
                       "בדוק גם את ההרשאות ואת זמינות הפעולות.")
        return
    data = result.data
    error = _dict(data.get("error")) or data
    if error.get("code") == "ambiguous" or error.get("status") == "ambiguous":
        out.summary = "נמצאו כמה יעדים אפשריים. מהו השם המלא והייחודי של היעד המבוקש?"
        return
    proposal = _dict(data.get("proposal")) or data
    if not proposal.get("id") or proposal.get("status") not in ("pending", "ready"):
        out.summary = "לא התקבלה הצעה זמינה לאישור. בדוק את פרטי הבקשה ונסה שוב."
        return
    impact = _dict(proposal.get("impact"))
    counts = _dict(impact.get("counts"))
    parts = []
    for key, label in (("servers", "שרתים"), ("pdus", "PDU"), ("outlets", "שקעים"), ("excluded", "החרגות")):
        count = counts.get(key)
        if count is None and isinstance(impact.get(key if key != "outlets" else "targets"), list):
            count = len(impact[key if key != "outlets" else "targets"])
        if type(count) is int and count >= 0:
            parts.append(f"{count} {label}")
    if request["kind"] == "open_console":
        out.summary = "הוכנה הצעה לפתיחת KVM. פתח את הקונסול בלחיצה על הכפתור בכרטיס."
    else:
        out.summary = "הוכנה הצעת פעולה. כדי לבצע אותה, בדוק את ההשפעה ואשר בכרטיס באמצעות הסיסמה."
        if proposal.get("phrase"):
            out.summary += " יש להקליד גם את צירוף האישור שמוצג בכרטיס."
        if request.get("then_console"):
            out.summary += " לאחר אישור וביצוע הריסט, אפשר יהיה לפתוח KVM בלחיצה בכרטיס."
    if parts:
        scope = "היקף ההצעה: " + ", ".join(parts) + "."
        out.summary += " " + scope
        out.fact(scope, _ids(result))
    else:
        out.missing("ספירת ההשפעה חסרה בתוצאת הכלי; בדוק את רשימת היעדים בכרטיס לפני האישור.")


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
        hebrew, quoted, technical = problem_text(p)
        since = f", מאז {run.when(p.get('since_iso'))}" if p.get("since_iso") else ""
        seen = f", נצפה לאחרונה {run.when(p.get('last_seen_iso'))}" if p.get("last_seen_iso") else ""
        ids = _ids(result, str(p.get("source_id") or ""), *[str(i) for i in _list(p.get("related_source_ids"))])
        out.fact(f"{label}: {hebrew} (חומרה {SEVERITY_HE.get(p.get('severity'), 'לא ידועה')}{since}{seen})."
                 + detail_suffix(quoted, technical), ids)
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
        out.context_used = _named(kind, target["id"])
        await _entity_report(run, out, kind, target["id"], target["id"])
        return
    if target.get("from_context") and kind == "server":
        server, label = target["id"], target["id"]
        out.context_used = _named("server", server)
    elif target.get("query"):
        resolved = await _resolve(run, out, target["query"], ("server",))
        if resolved is None:
            return
        if resolved.get("kind") in ("pdu", "kvm", "rack", "item"):
            await _entity_report(run, out, resolved["kind"], resolved["id"], resolved.get("label"))
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
            hebrew, quoted, technical = problem_text(p)
            out.fact(f"{label}: {hebrew} (חומרה {SEVERITY_HE.get(p.get('severity'), 'לא ידועה')}, נצפה "
                     f"{run.when(p.get('last_seen_iso'))})." + detail_suffix(quoted, technical),
                     _ids(problems, str(p.get("source_id") or "")))
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
    mentions_switch = re.search(r"מתג|switch", text, re.IGNORECASE) is not None
    if switch and switch.group(1).casefold() not in ("הזה", "הזאת", "this"):
        kind, ident = "switch", switch.group(1).strip(".")
    elif target.get("from_context") and target.get("kind") in ("pdu", "kvm", "server", "rack", "item") \
            and not mentions_switch:
        kind, ident = target["kind"], target["id"]
        out.context_used = _named(kind, ident)
    elif target.get("query"):
        resolved = await _resolve(run, out, target["query"], ("pdu", "kvm", "server", "rack", "item"))
        if resolved is None:
            return
        kind, ident, label = resolved["kind"], resolved["id"], resolved.get("label")
        if kind not in ("pdu", "kvm", "server", "rack", "item"):
            kind = "server"
    elif target.get("rack") and not mentions_switch:
        kind, ident = "rack", target["rack"]
    if not kind and mentions_switch:
        await _list_switches(run, out)   # "which components are affected by a switch failure?" without a name
        return
    if not kind:
        out.summary = "לא זוהה בשאלה רכיב (PDU, KVM, מתג, ארון או שרת) שאת התלויות בו יש לבדוק."
        out.check("שאל שוב עם שם הרכיב, למשל: אילו שרתים מחוברים ל-PDU pdu-rack03?")
        return
    await _dependency_report(run, out, kind, ident, label)


async def _dependency_report(run: _Run, out: _Answer, kind: str, ident: str, label: str | None = None) -> None:
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


_MAX_RACKS = 10
_MAX_SWITCHES = 6


def _rack_key(name: str):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", name)]


async def known_racks(run: _Run) -> tuple[list[str], bool]:
    """Rack names known to the system (racks with PDUs, plus rack names returned by resolve_entity for "rack"),
    capped at _MAX_RACKS. Returns (racks, truncated)."""
    racks: set[str] = set()
    power = await run.call("get_power_and_environment")
    for pdu in _list(power.data.get("pdus")) if power else []:
        if isinstance(pdu, dict):
            for rack in [pdu.get("rack"), *_list(pdu.get("shared_racks"))]:
                if isinstance(rack, str) and rack.strip():
                    racks.add(_text(rack, 40))
    found = await _optional(run, "resolve_entity", query="rack")
    for candidate in _list(found.data.get("candidates")) if found else []:
        if isinstance(candidate, dict) and candidate.get("kind") == "rack" and candidate.get("id"):
            racks.add(_text(candidate["id"], 40))
    ordered = sorted(racks, key=_rack_key)
    return ordered[:_MAX_RACKS], len(ordered) > _MAX_RACKS


async def _list_switches(run: _Run, out: _Answer) -> None:
    """No switch named: list the switches known from saved server assignments with their dependent servers."""
    racks, truncated = await known_racks(run)
    switches: dict[str, list[str]] = {}
    evidence: list[str] = []
    for rack in racks:
        deps = await run.call("get_dependencies", kind="rack", id=rack)
        if deps is None:
            continue
        evidence += _ids(deps)
        for connection in _list(deps.data.get("connections")):
            if isinstance(connection, dict) and connection.get("kind") == "switch" and connection.get("switch"):
                switches.setdefault(_text(connection["switch"], 40), [])
    if not switches:
        out.summary = ("לא צוין מתג בשאלה, ובנתונים השמורים לא נמצאו שיוכי מתגים לשרתים בארונות הידועים. "
                       "אין במערכת מלאי מתגים או מצב קישורים.")
        if evidence:
            out.fact(f"לא נמצאו שיוכי מתגים בשרתים של הארונות: {', '.join(racks)}.", evidence)
        out.check("אם ידוע לך שם המתג, שאל: אילו רכיבים מושפעים מתקלה במתג <שם המתג>?")
        return
    names = sorted(switches, key=_rack_key)
    for name in names[:_MAX_SWITCHES]:
        result = await run.call("get_dependencies", kind="switch", id=name)
        servers = [s for s in _list(result.data.get("servers")) if isinstance(s, dict)] if result else []
        listed = ", ".join(_text(s.get("label") or s.get("id"), 30)
                           + (f" (פורט {_text(s.get('port'), 20)})" if s.get("port") not in (None, "") else "")
                           for s in servers[:10])
        switches[name] = [_text(s.get("label") or s.get("id"), 30) for s in servers]
        if result is not None:
            out.fact(f"מתג {name}: {len(servers)} שרתים משויכים" + (f" - {listed}" if listed else "") + ".",
                     _ids(result))
            for s in servers[:10]:
                out.ref(_ref("server", s.get("id"), s.get("label")))
    summary_list = ", ".join(f"{name} ({len(switches[name])} שרתים)" for name in names[:_MAX_SWITCHES])
    out.summary = (f"לא צוין מתג בשאלה, ולכן מוצגים המתגים שמופיעים בשיוכי השרתים: {summary_list}. "
                   "תקלה במתג עלולה להשפיע על השרתים המשויכים אליו; השיוכים הם טקסט חופשי ולא בדיקה חיה.")
    if len(names) > _MAX_SWITCHES:
        out.missing(f"מוצגים {_MAX_SWITCHES} מתגים מתוך {len(names)}.")
    if truncated:
        out.missing(f"נבדקו {_MAX_RACKS} הארונות הראשונים בלבד.")
    out.missing("רשימת המתגים נבנתה משיוכי השרתים בארונות הידועים; אין במערכת מלאי מתגים, מצב קישורים או VLAN.")
    out.check(f"כדי לצמצם, שאל על מתג מסוים, למשל: אילו רכיבים מושפעים מתקלה במתג {names[0]}?")
    out.check("לפני עבודה על מתג, אמת פיזית אילו שרתים מחוברים אליו.")


async def _entity_report(run: _Run, out: _Answer, kind: str, ident: str, label: str | None = None) -> None:
    """Status of one known piece of equipment."""
    if kind in ("pdu", "kvm"):
        await _device_report(run, out, kind, ident, label)
    elif kind == "rack":
        await _rack_status(run, out, ident)
    elif kind == "switch":
        await _dependency_report(run, out, "switch", ident, label)
    elif kind == "server":
        await _server_status(run, out, "", {"query": ident}, {})
    else:
        await _device_status(run, out, kind, ident)


async def _device_report(run: _Run, out: _Answer, kind: str, ident: str, label: str | None = None) -> None:
    """A PDU or KVM: last scheduled observation, outlets (PDU), load and environment (PDU, cache only), current
    problems, dependent servers and recent maintenance. Nothing is refreshed and no device is contacted."""
    named = _named(kind, label or ident)
    bits: list[str] = []
    power = None
    outlets: list[dict] = []
    off: list[dict] = []
    if kind == "pdu":
        power = await run.call("get_power_and_environment", pdu_id=ident)
        entry = next((p for p in _list(power.data.get("pdus")) if isinstance(p, dict)
                      and str(p.get("id")) == str(ident)), None) if power else None
        if power is not None and entry is None:
            out.fact(f"לא נמצא PDU עם המזהה {_text(ident, 60)} בנתוני החשמל השמורים.", _ids(power))
        if entry:
            named = _named("pdu", entry.get("name") or label or ident)
            snapshot_ids = _ids(power, f"snapshot:{ident}", "monitor_device_snapshots")
            reachable = entry.get("reachable")
            reach = ("ה-PDU הגיב" if reachable is True else "ה-PDU לא הגיב" if reachable is False
                     else "אין תוצאת בדיקה")
            stale = " (הנתונים לא עדכניים)" if entry.get("snapshot_stale") else ""
            when = run.when(entry.get("checked_at"))
            out.fact(f"{named}: בבדיקה המתוזמנת האחרונה ({when}) {reach}{stale}.", snapshot_ids)
            bits.append(f"{reach} בבדיקה המתוזמנת האחרונה ({when}){stale}")
            outlets = [o for o in _list(entry.get("outlets")) if isinstance(o, dict)]
            off = [o for o in outlets if o.get("state") == "off" and not o.get("missing")]
            if outlets:
                on = sum(1 for o in outlets if o.get("state") == "on")
                other = len(outlets) - on - len(off)
                listing = ", ".join(_text(o.get("number"), 6) + (f" ({_text(o.get('label'), 30)})" if o.get("label") else "")
                                    for o in off[:10])
                out.fact(f"שקעים לפי הבדיקה האחרונה: {on} דולקים (ON), {len(off)} כבויים (OFF)"
                         + (f", {other} במצב לא ידוע" if other else "") + (f". כבויים: {listing}" if off else "") + ".",
                         snapshot_ids)
                bits.append(f"{len(off)} שקעים כבויים (OFF): {listing}" if off else "אין שקעים כבויים לפי הבדיקה")
            watts = entry.get("total_watts")
            cache_ids = _ids(power, f"pdu_cache:{ident}")
            if isinstance(watts, (int, float)) and not entry.get("stale"):
                out.fact(f"{named}: עומס ידוע {watts:.0f} W לפי קריאה שמורה מ-{run.when(entry.get('cache_as_of'))}.",
                         cache_ids)
                bits.append(f"עומס ידוע {watts:.0f} W")
            else:
                out.fact(f"{named}: אין קריאת עומס עדכנית (הקריאה חסרה, ישנה או לא אומתה).", cache_ids)
            environment = []
            if isinstance(entry.get("temperature"), (int, float)):
                environment.append(f"טמפרטורה {entry['temperature']:g}°C")
            if isinstance(entry.get("humidity"), (int, float)):
                environment.append(f"לחות {entry['humidity']:g}%")
            if isinstance(entry.get("leak_detected"), bool):
                environment.append("זוהתה נזילה" if entry["leak_detected"] else "לא זוהתה נזילה")
            if environment:
                out.fact(f"חיישני הסביבה של {named} (קריאה שמורה, מיקום החיישן לא רשום): {', '.join(environment)}.",
                         cache_ids)
            rack = entry.get("rack")
            if isinstance(rack, str) and rack:
                shared = [r for r in _list(entry.get("shared_racks")) if isinstance(r, str)]
                out.fact(f"{named} רשום בארון {_text(rack, 40)}"
                         + (f" ומשותף גם לארון {', '.join(_text(r, 40) for r in shared)}" if shared else "") + ".",
                         _ids(power, "devices"))
                out.ref(_ref("rack", rack, rack))
    else:
        overview = await run.call("lab_status_overview")
        view = next((d for d in _list(overview.data.get("devices")) if isinstance(d, dict)
                     and str(d.get("device_id")) == str(ident)), None) if overview else None
        if view:
            named = _named(kind, view.get("label") or label or ident)
            status = view.get("status")
            when = run.when(view.get("checked_at"))
            detail = _text(view.get("detail"), 140)
            technical = detail if detail and detail != f"Device observation is {status}." else None
            out.fact(f"{named}: לפי הבדיקה המתוזמנת האחרונה ({when}) המצב {STATUS_HE.get(status, _text(status, 30))}."
                     + detail_suffix(None, technical), _ids(overview, str(view.get("source_id") or ""),
                                                            "monitor_device_snapshots"))
            bits.append(f"מצב {STATUS_HE.get(status, _text(status, 30))} בבדיקה המתוזמנת האחרונה ({when})")
        elif overview is not None:
            out.fact(f"לא נמצא {named} ברשימת ההתקנים המנוטרים.", _ids(overview))
    out.ref(_ref(kind, ident, label or named))
    if out.context_used:
        out.context_used = named   # the device's real name once the tools returned it
    problems = await run.call("list_current_problems")
    all_problems = [p for p in _list(problems.data.get("problems")) if isinstance(p, dict)] if problems else []
    found = [p for p in all_problems if str(_dict(p.get("entity")).get("id")) == str(ident)]
    for p in found:
        hebrew, quoted, technical = problem_text(p)
        out.fact(f"{named}: {hebrew} (חומרה {SEVERITY_HE.get(p.get('severity'), 'לא ידועה')}, נצפה "
                 f"{run.when(p.get('last_seen_iso'))})." + detail_suffix(quoted, technical),
                 _ids(problems, str(p.get("source_id") or "")))
    if problems is not None and not found:
        out.fact(f"לא נרשמה בעיה נוכחית עבור {named}.", _ids(problems))
    deps = await run.call("get_dependencies", kind=kind, id=ident)
    servers = [s for s in _list(deps.data.get("servers")) if isinstance(s, dict)] if deps else []
    if servers:
        port_word = "שקע" if kind == "pdu" else "פורט"
        out.fact(f"שרתים המחוברים ל-{named} לפי השיוכים השמורים: "
                 + ", ".join(_text(s.get("label") or s.get("id"), 30)
                             + (f" ({port_word} {_text(s.get('port'), 10)})" if s.get("port") not in (None, "") else "")
                             for s in servers[:12]) + ".", _ids(deps))
    down = {_text(_dict(p.get("entity")).get("label"), 60).casefold(): p for p in all_problems
            if p.get("kind") == "ping_down"}
    for outlet in off:
        server = down.get(_text(outlet.get("label"), 60).casefold())
        if server is not None:
            name = _text(outlet.get("label"), 60)
            out.hypothesis(f"ייתכן ש-{name} אינו זמין כי השקע {_text(outlet.get('number'), 6)} ב-{named} כבוי.",
                           [f"ניטור ICMP מדווח ש-{name} אינו זמין.",
                            f"ה-PDU מדווח שהשקע {_text(outlet.get('number'), 6)} במצב OFF."],
                           "ברר ביומן התחזוקה מי כיבה את השקע ומדוע, ורק לאחר אישור הדלק אותו וודא שה-ping חוזר.",
                           _ids(problems, "ping_targets") + _ids(power if kind == "pdu" else None,
                                                                   f"snapshot:{ident}", "monitor_device_snapshots"))
    history = await run.call("get_history", device_id=ident, since_hours=168)
    if history is not None:
        events = [e for e in _list(history.data.get("items")) if isinstance(e, dict)]
        maintenance = [e for e in events if e.get("kind") == "pdu_maintenance"]
        out.fact(f"ב-7 הימים האחרונים נרשמו {len(events)} אירועים הקשורים ל-{named}"
                 + (f", מהם {len(maintenance)} פעולות תחזוקה" if maintenance else "") + ".", _ids(history))
        for event in maintenance[:3]:
            out.fact(f"{run.when(event.get('at_iso'))}: {event_text(event)}.",
                     _ids(history, str(event.get("source_id") or "")))
    bits.append(f"{len(found)} בעיות רשומות כרגע" if found else "אין בעיה רשומה כרגע (אין בכך הוכחה שהוא תקין)")
    out.summary = (f"{named}: " + "; ".join(bits) + ". הנתונים מהבדיקה המתוזמנת האחרונה ומהקריאות השמורות; "
                   "לא בוצעה עכשיו פנייה להתקן.")
    if off:
        numbers = ', '.join(_text(o.get('number'), 6) for o in off[:5])
        out.check(f"ברר ביומן התחזוקה מדוע שקע {numbers} כבוי לפני שמדליקים אותו." if len(off) == 1 else
                  f"ברר ביומן התחזוקה מדוע שקעים {numbers} כבויים לפני שמדליקים אותם.")
    out.check(f"פתח את מסך {named} באתר כדי לראות קריאה עדכנית.")


async def _rack_status(run: _Run, out: _Answer, rack: str) -> None:
    rack = _text(rack, 40)
    out.ref(_ref("rack", rack, rack))
    deps = await run.call("get_dependencies", kind="rack", id=rack)
    if deps is None:
        out.summary = f"לא ניתן היה לקרוא את נתוני ארון {rack}."
        return
    data = deps.data
    pdus = [d for d in _list(data.get("pdus")) if isinstance(d, dict)]
    kvms = [d for d in _list(data.get("kvms")) if isinstance(d, dict)]
    servers = [s for s in _list(data.get("servers")) if isinstance(s, dict)]
    items = [i for i in _list(data.get("items")) if isinstance(i, dict)]
    out.fact(f"בארון {rack} רשומים {len(pdus)} PDU, {len(kvms)} KVM, {len(servers)} שרתים ו-{len(items)} פריטי ציוד.",
             _ids(deps))
    for d in pdus + kvms:
        out.ref(_ref(d.get("kind") or ("pdu" if d in pdus else "kvm"), d.get("id"), d.get("name")))
    ids_in_rack = {str(d.get("id")) for d in pdus + kvms}
    labels = set()
    for s in servers:
        labels.add(_text(s.get("label"), 60).casefold())
        labels.update(_text(a, 60).casefold() for a in _list(s.get("aliases")))
    problems = await run.call("list_current_problems")
    relevant = [p for p in (_list(problems.data.get("problems")) if problems else []) if isinstance(p, dict)
                and (str(_dict(p.get("entity")).get("id")) in ids_in_rack
                     or _text(_dict(p.get("entity")).get("label"), 60).casefold() in labels)]
    for p in relevant[:8]:
        entity = _dict(p.get("entity"))
        hebrew, quoted, technical = problem_text(p)
        out.fact(f"{_text(entity.get('label') or entity.get('id'), 60)}: {hebrew} (חומרה "
                 f"{SEVERITY_HE.get(p.get('severity'), 'לא ידועה')})." + detail_suffix(quoted, technical),
                 _ids(problems, str(p.get("source_id") or "")))
    if problems is not None and not relevant:
        out.fact(f"לא נרשמו בעיות נוכחיות לרכיבים של ארון {rack}.", _ids(problems))
    out.summary = (f"ארון {rack}: {len(pdus)} PDU, {len(kvms)} KVM ו-{len(servers)} שרתים רשומים; "
                   + (f"{len(relevant)} בעיות רשומות כרגע." if relevant else
                      "אין בעיות רשומות כרגע (אין בכך הוכחה שהכול תקין)."))
    out.check(f"לבדיקת מקום וחשמל שאל: האם אפשר להוסיף שרת לארון {rack}?")


_STATUS_PHRASE = re.compile(r"(?:מה\s+(?:המצב|מצב)\s+של|מה\s+מצב|מה\s+מצבו|מה\s+מצבה|מה\s+קורה\s+עם|status\s+of|"
                            r"state\s+of|how\s+is)\s+(.+)", re.IGNORECASE)
_KIND_HINTS = {"שרת": "server", "השרת": "server", "server": "server", "ארון": "rack", "הארון": "rack",
               "rack": "rack", "מתג": "switch", "המתג": "switch", "switch": "switch", "pdu": "pdu", "kvm": "kvm",
               "פריט": "item", "הפריט": "item"}
_HEBREW = re.compile(r"[֐-׿]")


def status_phrase(question: str) -> tuple[str, str | None, bool, bool]:
    """From "מה המצב של <phrase>?": (Latin-script name, kind hint, refers to the viewed item, is a page)."""
    match = _STATUS_PHRASE.search(str(question))
    if not match:
        return "", None, False, False
    residual, hint, this, page = [], None, False, False
    for word in match.group(1).split():
        word = re.sub(r"^ה-?(?=[A-Za-z])", "", word).strip(" ?!.,;:\"'")
        low = word.casefold()
        hint = hint or _KIND_HINTS.get(low)
        this = this or low in _THIS
        page = page or low in ("עמוד", "העמוד", "page")
        if word and not _HEBREW.search(word):
            residual.append(word)
    return " ".join(residual), hint, this, page


async def _entity_status(run: _Run, out: _Answer, question: str, target: dict, context: dict) -> None:
    """"מה המצב של <equipment>?": answer about that equipment (named, or the one being viewed)."""
    name, hint, this, page = status_phrase(question)
    detail = _dict(context.get("detail"))
    if page and not name:
        await _overview(run, out, question, target, context)
        return
    if this and detail and hint in (None, detail.get("kind")):
        out.context_used = _named(detail["kind"], detail["id"])
        await _entity_report(run, out, detail["kind"], detail["id"], detail["id"])
        return
    if hint == "switch" and name:
        await _dependency_report(run, out, "switch", name, name)
        return
    if name:
        prefer = (hint,) if hint else ("pdu", "kvm", "server", "rack", "item")
        resolved = await _resolve(run, out, name, prefer)
        if resolved is None:
            return   # not found / ambiguous is already reported
        await _entity_report(run, out, resolved["kind"], resolved["id"], resolved.get("label"))
        return
    if detail and not this:
        out.context_used = _named(detail["kind"], detail["id"])
        await _entity_report(run, out, detail["kind"], detail["id"], detail["id"])
        return
    if this:
        out.missing("השאלה מתייחסת לרכיב \"הזה\", אך לא נשלח מהמסך רכיב נצפה; מוצגת סקירה כללית.")
    await _overview(run, out, question, target, context)


async def _capacity_all(run: _Run, out: _Answer, question: str, request: dict) -> None:
    """"Where can I add a server?" without a rack: plan_capacity over the known racks, ranked by verdict."""
    racks, truncated = await known_racks(run)
    if not racks:
        out.summary = "לא צוין ארון, ולא נמצאו בנתונים ארונות ידועים לבדיקה."
        out.check("שאל שוב עם שם הארון (למשל Rack-01).")
        return
    if not run.has("plan_capacity"):
        out.summary = (f"לא צוין ארון. ארונות ידועים: {', '.join(racks)}. כלי תכנון הקיבולת אינו זמין, ולכן ציין ארון "
                       "כדי לבדוק מקום וחשמל.")
        out.check(f"שאל: האם אפשר להוסיף שרת לארון {racks[0]}?")
        return
    plans = []
    for rack in racks:
        result = await run.call("plan_capacity", rack=rack, **request)
        if result is not None:
            plans.append((rack, result))
    if not plans:
        out.summary = "לא ניתן היה להעריך קיבולת לאף אחד מהארונות הידועים."
        return
    order = {"yes": 0, "conditional": 1, "no": 2}

    def rank(entry):
        verdicts = _dict(entry[1].data.get("verdicts"))
        values = list(verdicts.values())
        return (order.get(entry[1].data.get("overall"), 3), values.count("over"),
                values.count("unknown") + values.count("tight"), _rack_key(entry[0]))

    plans.sort(key=rank)
    for rack, result in plans:
        verdicts = _dict(result.data.get("verdicts"))
        unknown = [DIMENSION_HE.get(d, _text(d, 20)) for d, v in verdicts.items() if v == "unknown"]
        over = [DIMENSION_HE.get(d, _text(d, 20)) for d, v in verdicts.items() if v == "over"]
        text = _text(result.data.get("overall_text") or result.data.get("overall") or "אין הערכה", 200)
        out.fact(f"ארון {rack}: {text}" + (f" (חריגה: {', '.join(over)})" if over else "")
                 + (f" (לא ידוע: {', '.join(unknown)})" if unknown else "") + ".", _ids(result))
        out.ref(_ref("rack", rack, rack))
    best_rack, best = plans[0]
    best_text = _text(best.data.get("overall_text") or best.data.get("overall") or "אין הערכה", 200)
    counts = {key: sum(1 for _, r in plans if r.data.get("overall") == key) for key in order}
    out.recommendation(
        title=f"מועמד ראשון להוספת שרת: ארון {best_rack}",
        problem="צריך לבחור ארון להוספת שרת חדש.",
        evidence=f"{best_text}. דירוג לפי הערכת כלי תכנון הקיבולת בכל הארונות הידועים.",
        priority="medium",
        next_step=f"שאל שאלה ממוקדת על ארון {best_rack} ואמת פיזית מקום, חשמל, רשת וקירור לפני ההתקנה.",
        missing_info=[_text(m, 160) for m in _list(best.data.get("missing_info")) if isinstance(m, str)][:8],
        ids=_ids(best), refs=[_ref("rack", best_rack, best_rack)])
    power_note = f" (הספק הציוד החדש לפי השאלה: {request['power_w']:g} W)" if "power_w" in request else ""
    out.summary = (f"לא צוין ארון, ולכן נבדקו {len(plans)} ארונות ידועים{power_note}: {counts['yes']} ללא הסתייגות, "
                   f"{counts['conditional']} מותנים ו-{counts['no']} לא מומלצים. המועמד הראשון לפי הנתונים: ארון "
                   f"{best_rack} - {best_text}. זה דירוג לפי הנתונים הקיימים ולא אישור סופי.")
    if truncated:
        out.missing(f"נבדקו {_MAX_RACKS} הארונות הראשונים בלבד.")
    out.check(f"שאל על הארון המועמד: האם אפשר להוסיף שרת לארון {best_rack}?")
    out.check("ודא פיזית מקום, משקל, קירור ופורט פנוי במתג לפני ההתקנה.")


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
    text = str(question).casefold()
    any_rack = any(word in text for word in ("איפה", "באיזה ארון", "לאיזה ארון", "where", "which rack"))
    if any_rack and target.get("rack_from_context"):
        rack = None   # "where can I add ...?" asks across racks, not about the rack on screen
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
        await _capacity_all(run, out, question, capacity_request(question))
        return
    if target.get("rack_from_context"):
        out.context_used = _named("rack", rack)
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
    from_screen = ""
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
        out.context_used = _named("server", server)
    elif target.get("from_context") and target.get("kind") in ("pdu", "kvm"):
        device_id, label = target["id"], _named(target["kind"], target["id"])
        out.context_used = label
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
            out.fact(f"{run.when(e.get('at_iso'))}: {event_text(e)}{overlap}.",
                     _ids(result, str(e.get("source_id") or "")))
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
        hebrew, quoted, technical = problem_text(p)
        ref = _ref(entity.get("kind"), entity.get("id"), entity.get("label"))
        ids = _ids(result, str(p.get("source_id") or ""))
        evidence = f"{hebrew}; נצפה {run.when(p.get('last_seen_iso'))}." + detail_suffix(quoted, technical)
        out.fact(f"{label}: {hebrew} (חומרה {SEVERITY_HE.get(p.get('severity'), 'לא ידועה')}).", ids)
        out.ref(ref)
        out.recommendation(title=f"טיפול ב-{label}", problem=kind, evidence=evidence,
                           priority=p.get("severity"), next_step=_check_for(p.get("kind")),
                           missing_info=["סיבת השורש אינה ידועה מהנתונים"], ids=ids, refs=[ref])
        out.draft(title=f"בדיקת {label}: {kind}", description=f"{hebrew}." + detail_suffix(quoted, technical),
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
        names = {"ping_monitor": "ניטור ping", "email_alerts": "התראות דוא\"ל", "pxe": "התקנות PXE",
                 "accounts": "חשבונות משתמשים"}
        out.missing("מקורות שאינם פעילים: " + ", ".join(names.get(n, _text(n, 30)) for n in off) + ".")
    down = counts.get("down", 0) if isinstance(counts.get("down"), int) else 0
    out.summary = (f"סקירת מצב: {counts.get('up', 0)} יעדי ping זמינים, {down} לא זמינים, "
                   f"{counts.get('stale', 0)} לא עדכניים ו-{counts.get('unknown', 0)} במצב לא ידוע. "
                   "אין בכך הוכחה לתקינות מלאה: UPS, קירור ומתגים אינם מנוטרים.")
    out.check("שאל \"מה נפל במעבדה?\" כדי לראות את הבעיות הנוכחיות לפי חומרה.")


_HANDLERS = {"problems": _problems, "server_status": _server_status, "dependencies": _dependencies,
             "entity_status": _entity_status,
             "capacity": _capacity, "history": _history, "work": _work, "overview": _overview}


async def answer(*, question: str, history: list[dict] | None, context: dict | None, ctx: ToolContext,
                 tools: list[ToolSpec], reason: str | None = None) -> dict:
    """Build a demo EngineResult: {"mode": "demo", "answer", "ledger", "usage": None, "demo_reason"}."""
    run = _Run(ctx, tools)
    out = _Answer()
    context = clean_context(context)
    intent = classify(question)
    target = _target(question, context)
    action, clarification = _action_request(question)
    if clarification:
        out.summary = clarification + " " + _ACTION_GUIDANCE
    elif not tools and action is None:
        out.summary = "אין כרגע כלים זמינים לקריאת נתוני המעבדה, ולכן אין תשובה מבוססת נתונים."
    else:
        try:
            if action is not None:
                await _propose_action(run, out, action)
            else:
                await _HANDLERS[intent](run, out, question, target, context)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - unexpected tool data shape: keep what was already verified
            log.warning("Assistant demo responder failed while rendering %s (%s).", intent, type(exc).__name__)
            out.summary = "לא ניתן היה להשלים את תשובת ההדגמה; מוצגים רק הממצאים שנאספו עד לשגיאה."
            out.missing("חלק מנתוני הכלים הגיעו במבנה לא צפוי ולא עובדו.")
    if out.context_used:
        # Only when the handler really answered about the viewed equipment; never claims a live re-check.
        out.summary = (out.summary + f" (התשובה מתייחסת לרכיב מהמסך שבו אתה צופה: {out.context_used}.)").strip()
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
