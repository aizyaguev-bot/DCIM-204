"""/api/assistant: questions about the lab, the asker's own conversations, the assistant status and team work items.

Nothing here touches equipment. The engine (LLM or the clearly labelled demo responder) reads lab data only through
read-only tools; the router's own writes are limited to the assistant tables. The router decides the answer mode
(SEC-AI-3 open site, SEC-AI-9 daily cap) before the engine runs. Message text and answers are never logged at INFO,
error bodies are fixed strings, and no setting other than the model name and the public limits is ever returned.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import logging
import pathlib
import re
import time
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, ValidationError
from sqlalchemy.exc import SQLAlchemyError

from .. import accounts, confirm, inventory_store
from ..config import get_settings
from ..database import AsyncSessionLocal
from . import ratelimit, storage
from .contracts import (ENTITY_KINDS, PRIORITIES, SOURCE_STATUSES, WORK_ITEM_DRAFT_SCHEMA, Source, ToolContext,
                        empty_answer)
from .principal import client_key, ensure_client, principal_for, user_key

log = logging.getLogger(__name__)

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[3]
HISTORY_TURNS = 12                 # messages handed to the engine as conversation history
TIMEOUT_GRACE_SECONDS = 5.0        # the engine keeps its own budget; the router stops it only after this grace
MAX_BODY_BYTES = 64 * 1024
# Page context (SEC-AI-6): only known tabs and kinds, and short plain ids; anything else is dropped, not echoed.
CONTEXT_TABS = ("dashboard", "racks", "inventory", "power", "consoles", "pxe", "scan", "monitoring", "twin", "admin",
                "changelog", "account")
CONTEXT_KINDS = ("pdu", "kvm", "server", "item", "rack")
CONTEXT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}")
DEMO_LABEL = "מצב הדגמה — ללא מודל שפה"
UNVERIFIED = "לא אומת: "
SOURCE_DOWN = "מקור הנתונים חסר או לא זמין: "
BAD_SOURCE_STATUSES = ("missing", "unavailable", "disabled")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# Answer size caps (the engine output is shown in the panel and stored; SEC-AI-15).
SUMMARY_CHARS = 4000
TEXT_CHARS = 2000
LIST_ITEMS = 50
MAX_SOURCES = 100
MAX_ANSWER_BYTES = 64 * 1024
# Work item caps (SEC-AI-14; a saved item is shown to the whole team).
TITLE_CHARS, DESCRIPTION_CHARS, RATIONALE_CHARS = 200, 4000, 2000
STEP_CHARS, MAX_STEPS = 500, 20
MAX_REFS, REF_ID_CHARS, REF_LABEL_CHARS = 20, 120, 200
WORK_ITEM_FIELDS = tuple(WORK_ITEM_DRAFT_SCHEMA["properties"])
# Rejected in work items: control characters (newline/tab allowed in multi-line fields) and bidi overrides/isolates.
BAD_SINGLE_LINE = re.compile(r"[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]")
BAD_MULTI_LINE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f‪-‮⁦-⁩]")

# Hebrew messages shown in the assistant panel. Fixed strings: no internals, no settings values, no echoed input.
MSG_DISABLED = "סוכן ה-AI כבוי בהגדרות השרת."
MSG_NEED_JSON = "יש לשלוח את הבקשה בפורמט JSON."
MSG_BAD_BODY = "גוף הבקשה אינו תקין."
MSG_TOO_BIG = "הבקשה גדולה מדי."
MSG_EMPTY = "יש לכתוב שאלה."
MSG_NO_CONVERSATION = "השיחה לא נמצאה."
MSG_NO_WORK_ITEM = "המשימה לא נמצאה."
MSG_CROSS_ORIGIN = "בקשה ממקור חיצוני נדחתה."
MSG_TIMEOUT = "הסוכן לא הספיק לענות בזמן. נסו שוב או צמצמו את השאלה."
MSG_ENGINE = "הסוכן אינו זמין כרגע. נסו שוב בעוד מספר דקות."
MSG_DB_BUSY = "מאגר הנתונים עסוק כרגע. נסו שוב בעוד רגע."
MSG_OPERATOR = "נדרשת הרשאת Operator כדי לשמור או לעדכן משימה."
MSG_CONFIRM = "יש לאשר במפורש את שמירת המשימה."
MSG_STALE = "המשימה עודכנה על ידי משתמש אחר. טענו אותה מחדש ונסו שוב."
MSG_CLOSED = "המשימה כבר סומנה כבוצעה או בוטלה ואינה ניתנת לעריכה."
MSG_RATE = {
    "minute": "הגעתם למגבלת השאלות לדקה. נסו שוב בעוד {n} שניות.",
    "hour": "הגעתם למגבלת השאלות לשעה. נסו שוב בעוד {n} שניות.",
    "in_flight": "כבר יש שאלות שלכם בטיפול. המתינו לתשובה ונסו שוב.",
    "busy": "הסוכן עמוס כרגע. נסו שוב בעוד {n} שניות.",
}
DEMO_REASONS = {
    "assistant_disabled": "סוכן ה-AI כבוי בהגדרות השרת (ASSISTANT_ENABLED=false).",
    "llm_disabled": "מודל השפה כבוי בהגדרות השרת (ASSISTANT_LLM_ENABLED=false).",
    "no_api_key": "לא הוגדר בשרת מפתח API למודל השפה (ASSISTANT_ANTHROPIC_API_KEY).",
    "sdk_missing": "חבילת anthropic אינה מותקנת בשרת (יש להתקין את backend/requirements.txt).",
    "open_site": ("האתר פתוח ללא חשבונות משתמש וללא סיסמה משותפת, ולכן מודל השפה אינו מופעל "
                  "(ASSISTANT_ALLOW_OPEN_LLM=false)."),
    "daily_limit": "נוצלה המכסה היומית של שאלות למודל השפה (ASSISTANT_DAILY_LIMIT); עד לחידושה התשובות במצב הדגמה.",
    "llm_auth_failed": "מפתח ה-API של מודל השפה נדחה; יש לבדוק את ASSISTANT_ANTHROPIC_API_KEY.",
    "llm_rate_limited": "שירות מודל השפה הגביל זמנית את קצב הבקשות.",
    "llm_unreachable": "לא ניתן היה להתחבר לשירות מודל השפה (רשת או proxy).",
    "llm_unavailable": "שירות מודל השפה אינו זמין כרגע.",
    "llm_rejected": "שירות מודל השפה דחה את הבקשה.",
    "llm_error": "אירעה שגיאה בקריאה למודל השפה.",
}
DEMO_REASON_FALLBACK = "מודל השפה לא היה זמין לשאלה זו, ולכן התשובה נבנתה במצב הדגמה."
EGRESS_NOTE = ("במצב מודל שפה, השאלה ונתוני המעבדה ששימשו לתשובה (שמות ציוד, כתובות IP לניהול, תוויות, שמות בעלים, "
               "סיבות תחזוקה, מספרים סידוריים, נושאי התראות וקטעי תיעוד) נשלחים לעיבוד בשירות Anthropic. "
               "סיסמאות, מפתחות וכתובות דוא\"ל אינם נשלחים, וגם זהות המשתמש השואל אינה נשלחת.")


def _fail(status: int, detail: str, headers: dict | None = None) -> HTTPException:
    return HTTPException(status, detail, headers={"Cache-Control": "no-store", **(headers or {})})


def _no_store(response: Response):
    response.headers["Cache-Control"] = "no-store"


def _legacy_client(request: Request, response: Response):
    """Legacy mode: conversations are private per browser (assistant client cookie); see principal.py."""
    if not getattr(get_settings(), "accounts_enabled", False):
        ensure_client(request, response)


router = APIRouter(prefix="/api/assistant", tags=["assistant"],
                   dependencies=[Depends(_no_store), Depends(_legacy_client)])


# ---------------------------------------------------------------------------------------------------------------
# Mode and status
# ---------------------------------------------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _anthropic_available() -> bool:
    try:
        importlib.import_module("anthropic")
        return True
    except Exception:   # not installed or broken: demo mode
        return False


def _has_key(settings) -> bool:
    key = getattr(settings, "assistant_anthropic_api_key", None)
    if key is None:
        return False
    secret = key.get_secret_value() if hasattr(key, "get_secret_value") else str(key)
    return bool(secret.strip())


def mode_for(settings) -> tuple[str, str | None]:
    """("llm", None) only when the LLM is enabled, a key is configured, the site is not open to anyone (SEC-AI-3)
    and the anthropic package imports; otherwise ("demo", <reason code in DEMO_REASONS>). Never reveals the key."""
    if not getattr(settings, "assistant_enabled", True):
        return "demo", "assistant_disabled"
    if not getattr(settings, "assistant_llm_enabled", True):
        return "demo", "llm_disabled"
    if not _has_key(settings):
        return "demo", "no_api_key"
    if confirm.password_mode(settings) == "unavailable" and not getattr(settings, "assistant_allow_open_llm", False):
        return "demo", "open_site"
    if not _anthropic_available():
        return "demo", "sdk_missing"
    return "llm", None


def reason_text(reason) -> str:
    """Hebrew text for a demo reason code (router or engine); free text is used only when it is Hebrew."""
    if isinstance(reason, str):
        if reason in DEMO_REASONS:
            return DEMO_REASONS[reason]
        if re.search(r"[֐-׿]", reason):
            return _clean(reason, 300)
    return DEMO_REASON_FALLBACK


class DemoOnlySettings:
    """Read-only view of the settings handed to the engine when the router decided on demo mode: the LLM switch
    reads as off and the API key as absent, so the engine answers from the data-grounded demo responder.
    `assistant_demo_reason` carries the router's reason code. Every other attribute is the real setting."""
    __slots__ = ("_base", "assistant_demo_reason")

    def __init__(self, base, reason: str | None):
        object.__setattr__(self, "_base", base)
        object.__setattr__(self, "assistant_demo_reason", reason)

    def __getattr__(self, name):
        if name == "assistant_llm_enabled":
            return False
        if name == "assistant_anthropic_api_key":
            return None
        return getattr(object.__getattribute__(self, "_base"), name)

    def __setattr__(self, name, value):
        raise AttributeError("assistant settings are read-only")

    def __repr__(self):
        return "<assistant settings: demo only>"


def _status_sources(settings) -> list[dict]:
    def flag(name, enabled, off_note):
        return {"name": name, "status": "ok" if enabled else "disabled", "note": "" if enabled else off_note}

    sources = [
        flag("Ping monitor", getattr(settings, "ping_monitor_enabled", False),
             "Ping monitoring is turned off: server reachability and PDU/KVM snapshots do not refresh."),
        flag("Email alerts", getattr(settings, "email_alerts_enabled", False),
             "Email alerts are turned off: no alert conditions or alert history are recorded."),
        flag("PXE jobs", getattr(settings, "pxe_enabled", False), "Remote PXE installs are turned off."),
        flag("User accounts", getattr(settings, "accounts_enabled", False),
             "Shared-password mode: assistant conversations are kept per browser, not per person."),
    ]
    backend = PROJECT_ROOT / "backend"
    for name, path in (("Equipment inventory", inventory_store.ITEMS_FILE),
                       ("Rack overrides", backend / "rack_overrides.json"),
                       ("Rack slots", backend / "rack_slots.json"),
                       ("Switch assignments", backend / "switch_assignments.json"),
                       ("Chillers", backend / "chillers.json"),
                       ("Digital twin data", PROJECT_ROOT / "lab-twin" / "lab-data.json")):
        exists = pathlib.Path(path).exists()
        sources.append({"name": name, "status": "ok" if exists else "missing",
                        "note": "" if exists else "The data file does not exist on the server yet."})
    sources += [
        {"name": "UPS telemetry", "status": "missing", "note": "No UPS is connected to the system."},
        {"name": "Cooling telemetry", "status": "missing",
         "note": "Only PDU environment sensors, when present; no chiller or room sensor readings."},
        {"name": "Switch and link inventory", "status": "missing",
         "note": "Switches are free-text names on server assignments; no port, link or VLAN data."},
    ]
    return sources


@router.get("/status")
async def assistant_status():
    settings = get_settings()
    mode, reason = mode_for(settings)
    if mode == "llm":
        try:
            used = await ratelimit.daily_used(AsyncSessionLocal, time.time())
        except SQLAlchemyError:
            used = 0
        if used >= settings.assistant_daily_limit:
            mode, reason = "demo", "daily_limit"
    return {"enabled": bool(getattr(settings, "assistant_enabled", True)), "mode": mode,
            "demo_reason": reason_text(reason) if mode == "demo" else None, "demo_reason_code": reason,
            "model": settings.assistant_model,
            "limits": {"per_minute": settings.assistant_per_minute, "per_hour": settings.assistant_per_hour,
                       "max_chars": settings.assistant_max_chars},
            "legacy_shared_history": False,   # legacy mode keeps conversations per browser (client cookie)
            "egress_note": EGRESS_NOTE,
            "sources": _status_sources(settings)}


# ---------------------------------------------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------------------------------------------
def _enabled_settings():
    settings = get_settings()
    if not getattr(settings, "assistant_enabled", True):
        raise _fail(503, MSG_DISABLED)
    return settings


def _guard_write(request: Request, settings):
    """Every unsafe assistant route (SEC-AI-5): JSON content type in every mode (415 otherwise). Legacy mode has no
    CSRF token and a permissive CORS policy, so there the request must also come from the site itself. Accounts
    mode: the middleware already checked origin, session, role and the CSRF header."""
    if not getattr(settings, "accounts_enabled", False) and not accounts.same_origin(request):
        raise _fail(403, MSG_CROSS_ORIGIN)
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type != "application/json":
        raise _fail(415, MSG_NEED_JSON)


async def _json_body(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise _fail(413, MSG_TOO_BIG)
    try:
        body = json.loads(raw)
    except ValueError:
        raise _fail(400, MSG_BAD_BODY) from None
    if not isinstance(body, dict):
        raise _fail(400, MSG_BAD_BODY)
    return body


@asynccontextmanager
async def _session():
    """A short DB session; any database error becomes a fixed 503 instead of a stack trace."""
    try:
        async with AsyncSessionLocal() as db:
            yield db
    except SQLAlchemyError:
        log.warning("assistant: database temporarily unavailable")
        raise _fail(503, MSG_DB_BUSY) from None


def _clean(value, limit: int | None = None, multiline: bool = True) -> str:
    text = CONTROL.sub("", value if isinstance(value, str) else ("" if value is None else str(value)))
    if not multiline:
        text = re.sub(r"\s+", " ", text)
    text = text.strip()
    return text[:limit] if limit else text


def _context_id(value) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        if CONTEXT_ID.fullmatch(value):
            return value
    return None


def context_from(value) -> dict:
    """{tab?, rack?, detail?: {kind, id}} keeping only valid fields (SEC-AI-6): a known tab, a known detail kind and
    ids matching CONTEXT_ID. The context is only a hint; tools still check permissions and resolve ids themselves."""
    if not isinstance(value, dict):
        return {}
    out = {}
    if value.get("tab") in CONTEXT_TABS:
        out["tab"] = value["tab"]
    rack = _context_id(value.get("rack"))
    if rack:
        out["rack"] = rack
    detail = value.get("detail")
    if isinstance(detail, dict) and detail.get("kind") in CONTEXT_KINDS:
        detail_id = _context_id(detail.get("id"))
        if detail_id:
            out["detail"] = {"kind": detail["kind"], "id": detail_id}
    return out


def _rate_error(limited: ratelimit.RateLimited) -> HTTPException:
    message = MSG_RATE.get(limited.reason, MSG_RATE["busy"]).format(n=limited.retry_after)
    return _fail(429, message, headers={"Retry-After": str(limited.retry_after)})


# ---------------------------------------------------------------------------------------------------------------
# Work item request bodies (SEC-AI-14): unknown fields rejected, confirm must be literally true, caps, no control
# characters. Validation errors become a fixed 400 that names only known fields.
# ---------------------------------------------------------------------------------------------------------------
def _single_line(value):
    if value is None:
        return value
    if BAD_SINGLE_LINE.search(value):
        raise ValueError("control characters are not allowed")
    return value.strip()


def _multi_line(value):
    if value is None:
        return value
    if BAD_MULTI_LINE.search(value):
        raise ValueError("control characters are not allowed")
    return value.strip()


def _exactly_true(value):
    if value is not True:
        raise ValueError("confirm must be true")
    return value


def _present(value):
    if not value:
        raise ValueError("value is required")
    return value


def _steps(value):
    return None if value is None else [step for step in value if step]


Title = Annotated[str, Field(max_length=TITLE_CHARS), AfterValidator(_single_line), AfterValidator(_present)]
Step = Annotated[str, Field(max_length=STEP_CHARS), AfterValidator(_multi_line)]
Steps = Annotated[list[Step], Field(max_length=MAX_STEPS), AfterValidator(_steps)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EntityRefIn(_Strict):
    kind: Literal[ENTITY_KINDS]
    id: Annotated[str, Field(max_length=REF_ID_CHARS), AfterValidator(_single_line), AfterValidator(_present)]
    label: Annotated[str, Field(max_length=REF_LABEL_CHARS), AfterValidator(_single_line)]


class DraftIn(_Strict):
    title: Title
    description: Annotated[str, Field(max_length=DESCRIPTION_CHARS), AfterValidator(_multi_line)]
    entity_refs: list[EntityRefIn] = Field(max_length=MAX_REFS)
    priority: Literal[PRIORITIES]
    rationale: Annotated[str, Field(max_length=RATIONALE_CHARS), AfterValidator(_multi_line)]
    steps: Steps


class SaveWorkItemIn(_Strict):
    draft: DraftIn
    conversation_id: Annotated[str, Field(max_length=64)] | None = None
    confirm: Annotated[Literal[True], BeforeValidator(_exactly_true)]


class PatchWorkItemIn(_Strict):
    """PATCH allowlist: status, title, description, priority, steps. `expected_updated_at` is the item's
    `updated_at` as last read (optimistic concurrency; a mismatch is 409)."""
    expected_updated_at: Annotated[str, Field(min_length=1, max_length=40)]
    status: Literal[storage.WORK_ITEM_STATUSES] | None = None
    title: Title | None = None
    description: Annotated[str, Field(max_length=DESCRIPTION_CHARS), AfterValidator(_multi_line)] | None = None
    priority: Literal[PRIORITIES] | None = None
    steps: Steps | None = None
    confirm: Annotated[Literal[True], BeforeValidator(_exactly_true)] | None = None


_KNOWN_FIELDS = ({"draft", "conversation_id", "confirm", "expected_updated_at", "status"} | set(WORK_ITEM_FIELDS)
                 | {"kind", "id", "label"})


def _invalid(prefix: str, error: ValidationError) -> HTTPException:
    """A fixed 400 naming only known fields (never an unknown key or a submitted value)."""
    names, unknown = [], False
    for item in error.errors():
        if item.get("type") == "extra_forbidden":
            unknown = True
            continue
        parts = []
        for part in item.get("loc", ()):
            if isinstance(part, int):
                parts.append(f"[{part}]")
            elif part in _KNOWN_FIELDS:
                parts.append(("." if parts else "") + part)
            else:
                break
        name = "".join(parts)
        if name and name not in names:
            names.append(name)
    detail = prefix + (": " + ", ".join(names[:6]) if names else "")
    if unknown:
        detail += " (נשלחו שדות שאינם מוכרים)"
    return _fail(400, detail)


# ---------------------------------------------------------------------------------------------------------------
# Engine result: normalisation and the evidence-ledger rule (SEC-AI-8)
# ---------------------------------------------------------------------------------------------------------------
def schema_errors(value, schema: dict, path: str = "draft") -> list[str]:
    """A small subset of JSON Schema (object/array/string, required, enum, additionalProperties)."""
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return [f"{path}: expected an object"]
        errors = [f"{path}.{key}: required" for key in schema.get("required", []) if key not in value]
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False and set(value) - set(properties):
            errors.append(f"{path}: unknown fields")
        for key, sub in properties.items():
            if key in value:
                errors += schema_errors(value[key], sub, f"{path}.{key}")
        return errors
    if kind == "array":
        if not isinstance(value, list):
            return [f"{path}: expected a list"]
        errors = []
        for index, item in enumerate(value):
            errors += schema_errors(item, schema.get("items", {}), f"{path}[{index}]")
        return errors
    if kind == "string":
        if not isinstance(value, str):
            return [f"{path}: expected text"]
        if "enum" in schema and value not in schema["enum"]:
            return [f"{path}: must be one of {', '.join(schema['enum'])}"]
    return []


def _field(result, name, default=None):
    if isinstance(result, dict):
        return result.get(name, default)
    return getattr(result, name, default)


def _list(value, limit: int = LIST_ITEMS) -> list:
    return value[:limit] if isinstance(value, list) else []


def _texts(values, limit: int = TEXT_CHARS) -> list[str]:
    return [text for text in (_clean(value, limit) for value in _list(values) if isinstance(value, str)) if text]


def _ids(values) -> list[str]:
    out = []
    for value in _list(values, MAX_SOURCES):
        if isinstance(value, str) and value not in out:
            out.append(value)
    return out


def _refs(values, limit: int = LIST_ITEMS) -> list[dict]:
    out = []
    for ref in _list(values, limit):
        if (isinstance(ref, dict) and ref.get("kind") in ENTITY_KINDS and isinstance(ref.get("id"), str)
                and _clean(ref["id"])):
            out.append({"kind": ref["kind"], "id": _clean(ref["id"], REF_ID_CHARS, False),
                        "label": _clean(ref.get("label") if isinstance(ref.get("label"), str) else ref["id"],
                                        REF_LABEL_CHARS, False)})
    return out


def _suggested_draft(raw) -> dict | None:
    """An engine-suggested draft: schema-valid, then cut to the work item caps (it is only a suggestion; the user
    edits it and the save request is validated strictly)."""
    if schema_errors(raw, WORK_ITEM_DRAFT_SCHEMA):
        return None
    title = _clean(raw["title"], TITLE_CHARS, False)
    if not title:
        return None
    return {"title": title, "description": _clean(raw["description"], DESCRIPTION_CHARS),
            "entity_refs": _refs(raw["entity_refs"], MAX_REFS), "priority": raw["priority"],
            "rationale": _clean(raw["rationale"], RATIONALE_CHARS),
            "steps": [step for step in (_clean(s, STEP_CHARS) for s in raw["steps"][:MAX_STEPS]) if step]}


def normalize_ledger(raw) -> list[dict]:
    """The evidence ledger as plain dicts, de-duplicated by id (first occurrence wins), at most MAX_SOURCES."""
    out, seen = [], set()
    for item in raw if isinstance(raw, (list, tuple)) else []:
        data = item.to_dict() if isinstance(item, Source) else item
        if not isinstance(data, dict):
            continue
        source_id = data.get("id")
        if not isinstance(source_id, str) or not source_id.strip() or len(source_id) > 200 or source_id in seen:
            continue
        seen.add(source_id)
        age_s = data.get("age_s")
        out.append({"id": source_id, "name": _clean(data.get("name"), 200, False) or source_id,
                    "ref": _clean(data.get("ref"), 200, False),
                    "as_of": data.get("as_of") if isinstance(data.get("as_of"), str) else None,
                    "age_s": float(age_s) if isinstance(age_s, (int, float)) and not isinstance(age_s, bool) else None,
                    "status": data.get("status") if data.get("status") in SOURCE_STATUSES else "unavailable",
                    "note": _clean(data.get("note"), 500)})
        if len(out) >= MAX_SOURCES:
            break
    return out


def normalize_answer(raw) -> dict:
    """Coerces the engine's answer to ANSWER_SCHEMA: drops malformed entries, caps sizes, strips control characters."""
    if not isinstance(raw, dict):
        raise ValueError("answer is not an object")
    answer = empty_answer(_clean(raw.get("summary"), SUMMARY_CHARS))
    for fact in _list(raw.get("facts")):
        if isinstance(fact, dict) and _clean(fact.get("text")):
            answer["facts"].append({"text": _clean(fact["text"], TEXT_CHARS), "source_ids": _ids(fact.get("source_ids"))})
    for item in _list(raw.get("hypotheses")):
        if isinstance(item, dict) and _clean(item.get("text")):
            answer["hypotheses"].append({"text": _clean(item["text"], TEXT_CHARS), "support": _texts(item.get("support")),
                                         "verify": _clean(item.get("verify"), TEXT_CHARS),
                                         "source_ids": _ids(item.get("source_ids"))})
    for item in _list(raw.get("recommendations")):
        if isinstance(item, dict) and _clean(item.get("title")):
            answer["recommendations"].append({
                "title": _clean(item["title"], 300, False), "problem": _clean(item.get("problem"), TEXT_CHARS),
                "evidence": _clean(item.get("evidence"), TEXT_CHARS),
                "priority": item.get("priority") if item.get("priority") in PRIORITIES else "medium",
                "next_step": _clean(item.get("next_step"), TEXT_CHARS), "missing_info": _texts(item.get("missing_info")),
                "source_ids": _ids(item.get("source_ids")), "entity_refs": _refs(item.get("entity_refs"))})
    answer["checks"] = _texts(raw.get("checks"))
    answer["missing_data"] = _texts(raw.get("missing_data"))
    answer["entity_refs"] = _refs(raw.get("entity_refs"))
    for draft in _list(raw.get("work_item_drafts"), 10):
        suggested = _suggested_draft(draft)
        if suggested:   # invalid suggestions are dropped; the user can still ask again
            answer["work_item_drafts"].append(suggested)
    return answer


def apply_evidence(answer: dict, sources: list[dict]) -> dict:
    """Evidence-ledger rule (SEC-AI-8, SEC-AI-20): every source_ids array keeps only ids really returned by tools in
    this request. A fact left without any source is not shown as a fact: it moves to missing_data as "לא אומת: …".
    A fact whose remaining sources are all missing/unavailable/disabled is tagged. A recommendation left without
    sources is marked "לא אומת" in its evidence."""
    status = {source["id"]: source["status"] for source in sources}
    facts = []
    for fact in answer["facts"]:
        kept = [source_id for source_id in fact["source_ids"] if source_id in status]
        if not kept:
            answer["missing_data"].append(UNVERIFIED + fact["text"])
            continue
        text = fact["text"]
        if all(status[source_id] in BAD_SOURCE_STATUSES for source_id in kept) and not text.startswith(SOURCE_DOWN):
            text = SOURCE_DOWN + text
        facts.append({"text": text, "source_ids": kept})
    answer["facts"] = facts
    for item in answer["hypotheses"]:
        item["source_ids"] = [source_id for source_id in item["source_ids"] if source_id in status]
    for item in answer["recommendations"]:
        item["source_ids"] = [source_id for source_id in item["source_ids"] if source_id in status]
        if not item["source_ids"] and not item["evidence"].startswith(UNVERIFIED):
            item["evidence"] = UNVERIFIED + (item["evidence"] or "אין מקור נתונים תומך.")
    return answer


def _size(value) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def fit_answer(answer: dict, limit: int = MAX_ANSWER_BYTES) -> dict:
    """Keeps a stored answer under `limit` bytes (SEC-AI-15) by halving its largest list; says so in missing_data."""
    if _size(answer) <= limit:
        return answer
    keys = ("facts", "hypotheses", "recommendations", "checks", "missing_data", "entity_refs", "work_item_drafts")
    while _size(answer) > limit - 512:
        candidates = [key for key in keys if answer[key]]
        if not candidates:
            answer["summary"] = answer["summary"][:1000]
            break
        key = max(candidates, key=lambda name: _size(answer[name]))
        answer[key] = answer[key][:len(answer[key]) // 2]
    answer["missing_data"].append("התשובה קוצרה כי הייתה ארוכה מדי.")
    return answer


def _usage(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    usage = {key: raw[key] for key in ("input_tokens", "output_tokens")
             if isinstance(raw.get(key), int) and not isinstance(raw.get(key), bool)}
    return usage or None


def _load_engine():
    """The engine entry point (AI-4), imported lazily so the router never imports the LLM SDK itself."""
    return importlib.import_module(".engine", __package__).answer_question


def _load_tools(principal) -> list:
    return list(importlib.import_module(".registry", __package__).tools_for(principal))


async def _admit(client: str, settings) -> tuple[str, str | None]:
    """Counts the question (per client) and, for an LLM answer, the global daily cap — both before the engine runs.
    Fails closed: a database error is a 503 and the engine is not called."""
    now = time.time()
    try:
        await ratelimit.consume(AsyncSessionLocal, client, per_minute=settings.assistant_per_minute,
                                per_hour=settings.assistant_per_hour, now=now)
        mode, reason = mode_for(settings)
        if mode == "llm" and not await ratelimit.consume_daily(AsyncSessionLocal, settings.assistant_daily_limit, now):
            mode, reason = "demo", "daily_limit"
    except SQLAlchemyError:
        log.warning("assistant: rate-limit table temporarily unavailable")
        raise _fail(503, MSG_DB_BUSY) from None
    return mode, reason


async def _ask(principal, settings, mode: str, reason: str | None, message: str, history: list,
               context: dict) -> dict:
    # A router-decided demo answer is forced twice: by the engine's mode/demo_reason arguments and by a settings
    # view in which the LLM is off and no key exists (defence in depth; an engine answering "llm" anyway is refused).
    engine_settings = settings if mode == "llm" else DemoOnlySettings(settings, reason)
    ctx = ToolContext(principal=principal, session_factory=AsyncSessionLocal, settings=engine_settings,
                      now=time.time(), project_root=PROJECT_ROOT)
    try:
        answer_question = _load_engine()
        tools = _load_tools(principal)
        forced = {} if mode == "llm" else {"mode": "demo", "demo_reason": reason_text(reason)}
        result = await asyncio.wait_for(
            answer_question(question=message, history=history, context=context, ctx=ctx, tools=tools, **forced),
            timeout=float(settings.assistant_timeout_seconds) + TIMEOUT_GRACE_SECONDS)
        answer = normalize_answer(_field(result, "answer"))
        result_mode = _field(result, "mode")
        if mode == "demo" and result_mode == "llm":
            raise RuntimeError("engine ignored the demo-only decision")
    except HTTPException:
        raise
    except (asyncio.TimeoutError, TimeoutError):
        log.warning("assistant: question timed out")
        raise _fail(504, MSG_TIMEOUT) from None
    except Exception as exc:   # never echo internals (could include request ids, proxy URLs or SDK details)
        log.warning("assistant: engine failed (%s)", type(exc).__name__)
        raise _fail(503, MSG_ENGINE) from None
    sources = normalize_ledger(_field(result, "ledger"))
    answer = fit_answer(apply_evidence(answer, sources))
    result_mode = "llm" if result_mode == "llm" else "demo"
    demo_reason = None
    if result_mode == "demo":
        demo_reason = reason_text(reason if mode == "demo" else _field(result, "demo_reason"))
        if "מצב הדגמה" not in answer["summary"]:
            answer["summary"] = f"{DEMO_LABEL}. {answer['summary']}".strip()
    return {"mode": result_mode, "answer": answer, "sources": sources, "usage": _usage(_field(result, "usage")),
            "demo_reason": demo_reason}


# ---------------------------------------------------------------------------------------------------------------
# Chat and conversations (private to the asker)
# ---------------------------------------------------------------------------------------------------------------
@router.post("/chat")
async def chat(request: Request):
    settings = _enabled_settings()
    principal = principal_for(request, settings)
    _guard_write(request, settings)
    body = await _json_body(request)
    message = _clean(body.get("message")) if isinstance(body.get("message"), str) else ""
    if not message:
        raise _fail(400, MSG_EMPTY)
    if len(message) > settings.assistant_max_chars:
        raise _fail(400, f"השאלה ארוכה מדי (עד {settings.assistant_max_chars} תווים).")
    conversation_id = body.get("conversation_id") or None
    if conversation_id is not None and not isinstance(conversation_id, str):
        raise _fail(400, MSG_BAD_BODY)
    context = context_from(body.get("context"))
    owner = user_key(principal, request)
    history: list = []
    if conversation_id:   # SEC-AI-2: ownership first, before any counter or the engine
        async with _session() as db:
            history = await storage.recent_history(db, conversation_id, owner, HISTORY_TURNS)
        if history is None:
            raise _fail(404, MSG_NO_CONVERSATION)

    client = client_key(request, principal)
    started = time.monotonic()
    try:
        async with ratelimit.gate.slot(client, settings.assistant_concurrency):
            mode, reason = await _admit(client, settings)
            outcome = await _ask(principal, settings, mode, reason, message, history, context)
    except ratelimit.RateLimited as limited:
        raise _rate_error(limited) from None

    async with _session() as db:
        stored = await storage.store_turn(db, conversation_id=conversation_id, owner=owner,
                                          title=_clean(message.splitlines()[0], 80, False), question=message,
                                          answer=outcome["answer"], sources=outcome["sources"],
                                          mode=outcome["mode"], demo_reason=outcome["demo_reason"],
                                          now=time.time())
    if stored is None:   # deleted while the question was being answered
        raise _fail(404, MSG_NO_CONVERSATION)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    log.info("assistant: answered mode=%s sources=%d elapsed_ms=%d", outcome["mode"], len(outcome["sources"]),
             elapsed_ms)
    response = {"conversation_id": stored[0], "message_id": stored[1], "mode": outcome["mode"],
                "answer": outcome["answer"], "sources": outcome["sources"], "elapsed_ms": elapsed_ms,
                "demo_reason": outcome["demo_reason"]}
    if outcome["usage"]:
        response["usage"] = outcome["usage"]
    return response


@router.get("/conversations")
async def conversations(request: Request):
    settings = _enabled_settings()
    owner = user_key(principal_for(request, settings), request)
    async with _session() as db:
        return await storage.list_conversations(db, owner)


@router.get("/conversations/{conversation_id}")
async def conversation(conversation_id: str, request: Request):
    settings = _enabled_settings()
    owner = user_key(principal_for(request, settings), request)
    async with _session() as db:
        messages = await storage.conversation_messages(db, conversation_id, owner)
    if messages is None:
        raise _fail(404, MSG_NO_CONVERSATION)
    return messages


@router.delete("/conversations/{conversation_id}")
async def reset_conversation(conversation_id: str, request: Request):
    settings = _enabled_settings()
    principal = principal_for(request, settings)
    _guard_write(request, settings)
    async with _session() as db:
        deleted = await storage.delete_conversation(db, conversation_id, user_key(principal, request))
    if not deleted:
        raise _fail(404, MSG_NO_CONVERSATION)
    return {"ok": True}


# ---------------------------------------------------------------------------------------------------------------
# Work items (team-wide). The LLM never saves anything: only a user's explicit, confirmed request does.
# ---------------------------------------------------------------------------------------------------------------
def _operator(request: Request, settings):
    principal = principal_for(request, settings)
    _guard_write(request, settings)
    if not principal.allows("Operator"):   # the middleware enforces this too; repeated for defence in depth
        raise _fail(403, MSG_OPERATOR)
    return principal


@router.get("/work-items")
async def work_items(request: Request, status: str | None = None):
    settings = _enabled_settings()
    principal_for(request, settings)
    if status is not None and status not in storage.WORK_ITEM_STATUSES:
        raise _fail(400, MSG_BAD_BODY)
    async with _session() as db:
        return await storage.list_work_items(db, status)


@router.post("/work-items", status_code=201)
async def save_work_item(request: Request):
    settings = _enabled_settings()
    principal = _operator(request, settings)
    body = await _json_body(request)
    if body.get("confirm") is not True:
        raise _fail(400, MSG_CONFIRM)
    try:
        payload = SaveWorkItemIn.model_validate(body)
    except ValidationError as error:
        raise _invalid("טיוטת המשימה אינה תקינה", error) from None
    owner = user_key(principal, request)
    async with _session() as db:
        if payload.conversation_id and await storage.get_conversation(db, payload.conversation_id, owner) is None:
            raise _fail(404, MSG_NO_CONVERSATION)   # SEC-AI-2: a draft can only point at the caller's conversation
        return await storage.create_work_item(db, draft=payload.draft.model_dump(), owner=owner,
                                              username=principal.username,
                                              conversation_id=payload.conversation_id or None, now=time.time())


@router.patch("/work-items/{item_id}")
async def update_work_item(item_id: str, request: Request):
    settings = _enabled_settings()
    principal = _operator(request, settings)
    body = await _json_body(request)
    try:
        payload = PatchWorkItemIn.model_validate(body)
    except ValidationError as error:
        raise _invalid("עדכון המשימה אינו תקין", error) from None
    changes = payload.model_dump(exclude_none=True, exclude={"expected_updated_at", "confirm"})
    if not changes:
        raise _fail(400, MSG_BAD_BODY)
    try:
        async with _session() as db:
            item = await storage.update_work_item(db, item_id, changes, principal.username, time.time(),
                                                  payload.expected_updated_at)
    except storage.WorkItemConflict as conflict:
        raise _fail(409, MSG_CLOSED if conflict.reason == "closed" else MSG_STALE) from None
    if item is None:
        raise _fail(404, MSG_NO_WORK_ITEM)
    return item
