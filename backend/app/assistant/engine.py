"""Answer engine: a Claude tool loop over the read-only lab tools, with a data-grounded demo fallback.

Entry point (contract, see AI-ASSISTANT-PLAN.md):
    answer_question(*, question, history, context, ctx, tools) -> EngineResult
    EngineResult = {"mode": "llm"|"demo", "answer": <ANSWER_SCHEMA dict>, "ledger": [Source], "usage": dict|None,
                    "demo_reason": str|None}

LLM path (official `anthropic` SDK, async client): model `settings.assistant_model`, adaptive thinking, effort
"medium", streaming through `client.beta.messages.stream(...)` + `get_final_message()`, the server-side refusal
fallback (`fallbacks="default"`, beta `server-side-fallback-2026-07-01`), structured output in ANSWER_SCHEMA
(`output_config.format`), strict tools, a manual tool loop (max 8 rounds) with per-tool role checks, and an
evidence ledger of every source a tool really returned. The whole LLM path runs under
`asyncio.wait_for(settings.assistant_timeout_seconds)`; a timeout raises `asyncio.TimeoutError` for the router.

Demo path (`demo.py`): used when the LLM is disabled, no API key is configured or the SDK cannot be imported,
and as the answer when an LLM call fails. The router never imports `anthropic`.

Secrets: the API key is read only when the client is built and is never logged or put in an answer; failures
are logged by exception class name only.
"""
from __future__ import annotations

import asyncio
import copy
import dataclasses
import inspect
import json
import logging
import time
from typing import Any, Callable

from . import prompts
from .contracts import (
    ANSWER_SCHEMA, ROLE_ORDER, SOURCE_STATUSES, Source, ToolContext, ToolError, ToolResult, ToolSpec, empty_answer,
    redact_text, redact_tree,
)

log = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 8                 # tool-execution rounds per question; one more request then must answer
MAX_CALLS_PER_ROUND = 6             # tool calls executed from one assistant turn (the rest get is_error)
MAX_CALLS_PER_QUESTION = 24         # tool calls executed per question
MAX_RESULT_CHARS = 30_000           # per tool result sent to the model
MAX_RESULT_CHARS_PER_QUESTION = 120_000   # all tool results of one question; then tool use stops
MAX_TOKENS = 32_000                 # explicit on every request (thinking + answer); the wall-clock budget bounds the rest
EFFORT = "medium"
HISTORY_TURNS = 12
HISTORY_CHARS = 4_000
API_BASE_URL = "https://api.anthropic.com"   # explicit: an ANTHROPIC_BASE_URL in the environment is not honoured
SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01"
TOOL_INTERNAL_ERROR = "tool failed (internal error)"
WITHDRAW_SECONDS = 2.0             # cap for cancelling a failed LLM answer's action proposals before the demo fallback
# Fine-grained (eager) tool-input streaming stays off: tool inputs here are tiny, we do not render the stream,
# and keeping it off keeps the server-side strict-schema validation of tool inputs.
EAGER_INPUT_STREAMING = False

_STATUS_RANK = {status: rank for rank, status in enumerate(("ok", "stale", "disabled", "missing", "unavailable"))}
_STATUS_HE = {"stale": "נתונים לא עדכניים", "missing": "מקור חסר", "unavailable": "מקור לא זמין",
              "disabled": "מקור מושבת"}
# Hebrew wording for the fixed caveat sentences the tools emit (exact match only; anything else is shown verbatim
# as a technical detail). Shown to the owner in missing_data.
CAVEAT_HE = {
    "UPS telemetry is not monitored.": "אין ניטור של UPS.",
    "Cooling/chillers telemetry is not monitored (placement is not telemetry).":
        "אין ניטור של קירור וצ'ילרים (מיקום הצ'ילרים אינו מדידה).",
    "Switch/link state is not monitored; saved switch assignments are topology only.":
        "מצב מתגים וקישורים אינו מנוטר; שיוכי המתגים השמורים הם טופולוגיה בלבד.",
    "Absence of recorded problems is not evidence that the lab is healthy.":
        "היעדר בעיות רשומות אינו הוכחה שהמעבדה תקינה.",
    "Email alerts disabled: alert conditions and email history are not monitored.":
        "התראות הדוא\"ל כבויות: אין תנאי התראה ואין היסטוריית התראות.",
    "Ping monitor disabled: persisted ICMP and device observations do not refresh.":
        "ניטור ה-ping כבוי: תצפיות ה-ICMP וההתקנים השמורות אינן מתעדכנות.",
    "Monitoring timezone unavailable; freshness is unknown.":
        "אזור הזמן של הניטור אינו זמין, ולכן לא ידוע עד כמה הנתונים עדכניים.",
    "Server has no ICMP monitoring target; availability is unknown.":
        "לשרת אין יעד ניטור ICMP, ולכן הזמינות שלו אינה ידועה.",
    "Rack sources conflict; candidates are ordered override, PDU, server inventory, twin. Verify location.":
        "מקורות המיקום סותרים (סדר העדיפות: קביעה ידנית, PDU, מלאי שרתים, תאום דיגיטלי); יש לאמת את המיקום.",
    "Co-occurred events overlap in recorded time only; no causal relationship is established. History retention "
    "may be shorter than the requested window.":
        "אירועים חופפים חופפים בזמן בלבד ואין בכך קשר סיבתי; ייתכן שההיסטוריה נשמרת לתקופה קצרה מהחלון שנבדק.",
    "Switch assignments are free text; switch inventory, link state and service dependencies are unavailable.":
        "שיוכי המתגים הם טקסט חופשי; אין מלאי מתגים, מצב קישורים או תלויות שירותים.",
    "Feed A/B and UPS topology are not recorded. Multiple outlets do not establish independent power feeds.":
        "הזנות A/B וטופולוגיית UPS אינן רשומות; כמה שקעים אינם מוכיחים הזנות חשמל בלתי תלויות.",
    "Labels and stored associations are untrusted configuration, not verified physical cabling.":
        "תוויות ושיוכים שמורים הם הגדרות שלא אומתו, לא כבילה פיזית שנבדקה.",
    "Candidate matches are not a confirmed selection; ask for a unique identifier when ambiguous.":
        "התאמות לשם אינן בחירה מאושרת; כשיש כמה התאמות יש לציין מזהה ייחודי.",
    "No UPS telemetry, cooling telemetry or power history is available.":
        "אין נתוני UPS, נתוני קירור או היסטוריית צריכת חשמל.",
    "Chillers describe placement only. PDU environmental sensor location is not recorded.":
        "נתוני הצ'ילרים מתארים מיקום בלבד; מיקום חיישני הסביבה של ה-PDU אינו רשום.",
    "Unknown or stale watts do not establish rack load or available capacity.":
        "קריאות הספק לא ידועות או ישנות אינן קובעות עומס ארון או קיבולת פנויה.",
    "Shared PDUs are counted once by device id; loads across rack queries must not be added.":
        "PDU משותף נספר פעם אחת לפי המזהה שלו; אין לחבר עומסים בין בדיקות של ארונות שונים.",
    "U is a shelf index from the top, not a standard rack-unit height.":
        "U הוא מספר מדף מלמעלה, לא יחידת גובה סטנדרטית של ארון.",
    "Free shelves and automatic placement have low confidence; verify the physical rack mapping.":
        "מדפים פנויים ומיקום אוטומטי הם ברמת ביטחון נמוכה; יש לאמת את מיפוי הארון בפועל.",
    "Free shelves are unknown when required inventory or placement sources are missing or unavailable.":
        "כשמקורות המלאי או המיקום חסרים, המדפים הפנויים אינם ידועים.",
    "Item weight, height and depth are unavailable; shelf space is not proof equipment fits.":
        "אין נתוני משקל, גובה ועומק; מדף פנוי אינו הוכחה שהציוד ייכנס.",
    "Priority scores are a documented heuristic, not a measurement; redundancy is a hint, never verified.":
        "ציוני העדיפות הם היוריסטיקה מתועדת ולא מדידה; יתירות היא רמז בלבד ולא אומתה.",
    "Priority scores are a documented heuristic, not a measurement; absence of problems is not proof of health.":
        "ציוני העדיפות הם היוריסטיקה מתועדת ולא מדידה; היעדר בעיות אינו הוכחה לתקינות.",
    "Capacity verdicts use the latest cached readings only; no device was contacted and no load is predicted.":
        "הערכות הקיבולת מבוססות על הקריאות השמורות האחרונות בלבד; לא בוצעה פנייה להתקן ואין חיזוי עומס.",
    "Results were truncated; omitted entries must not be treated as absent.":
        "התוצאות קוצרו; רשומות שהושמטו אינן בהכרח חסרות.",
}
_DEFAULT_NOTES = {
    "stale": "The data is older than its expected refresh interval.",
    "missing": "The data source has no data (file or record missing).",
    "unavailable": "The data source could not be read.",
    "disabled": "This data source is turned off in the server settings.",
}

# Process-wide: set to False when the API rejects the server-side fallback parameters (logged once).
_server_fallback = {"enabled": True}


# ---------------------------------------------------------------------------------------------------------------
# SDK loading, mode selection and the client factory (tests replace `client_factory`).
# ---------------------------------------------------------------------------------------------------------------
def load_sdk():
    """The `anthropic` module, or None when it is not installed or fails to import."""
    try:
        import anthropic  # noqa: PLC0415 - optional dependency, imported lazily
    except Exception:  # noqa: BLE001
        return None
    return anthropic


def _api_key(settings) -> str:
    """The key on these settings. Once `resolve_key` (or the router) has run, ctx.settings is a keystore.KeyedSettings
    view and this is the effective key: the one an Admin stored on the site, else ASSISTANT_ANTHROPIC_API_KEY."""
    secret = getattr(settings, "assistant_anthropic_api_key", None)
    if secret is None:
        return ""
    value = secret.get_secret_value() if hasattr(secret, "get_secret_value") else secret
    return value.strip() if isinstance(value, str) else ""


async def resolve_key(ctx: ToolContext) -> None:
    """Key resolution: puts the effective key on ctx.settings (keystore.resolve; site-stored key > .env key, read
    again within keystore.KEY_CACHE_SECONDS of a change, no restart). The chat router hands over settings that are
    already resolved; this covers any other caller that has a session factory. Demo-only settings (LLM switched off)
    are never given a key. A failure keeps the settings as they are (the .env key)."""
    settings = ctx.settings
    if (ctx.session_factory is None or getattr(settings, "assistant_key_source", None) is not None
            or not getattr(settings, "assistant_llm_enabled", True)):
        return
    try:
        from . import keystore  # noqa: PLC0415 - keystore imports the models; keep engine imports light
        ctx.settings = await keystore.resolve(settings, ctx.session_factory)
    except Exception as exc:  # noqa: BLE001
        log.warning("Assistant API key resolution failed (%s); using the .env key.", type(exc).__name__)


def llm_status(settings, sdk_loader: Callable[[], Any] | None = None) -> tuple[str, str | None]:
    """("llm", None) when a language-model answer can be attempted, else ("demo", <reason code>).

    Reason codes: llm_disabled, no_api_key, sdk_missing (text for each: demo.DEMO_REASON_TEXT)."""
    if not getattr(settings, "assistant_llm_enabled", True):
        return "demo", "llm_disabled"
    if not _api_key(settings):
        return "demo", "no_api_key"
    if (sdk_loader or load_sdk)() is None:
        return "demo", "sdk_missing"
    return "llm", None


def default_client_factory(settings, sdk):
    """A fresh AsyncAnthropic client for one question (closed by the engine afterwards): explicit key and base URL,
    the SDK's default HTTP client (TLS verification on; HTTPS_PROXY/NO_PROXY from the environment are honoured)."""
    timeout = float(getattr(settings, "assistant_timeout_seconds", 90) or 90)
    return sdk.AsyncAnthropic(api_key=_api_key(settings), base_url=API_BASE_URL, timeout=timeout, max_retries=2)


client_factory: Callable[[Any, Any], Any] = default_client_factory


# ---------------------------------------------------------------------------------------------------------------
# Minimal JSON-schema validation (the subset used by ANSWER_SCHEMA and the tool input schemas).
# ---------------------------------------------------------------------------------------------------------------
_JSON_TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}


def _is_type(value, name: str) -> bool:
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    expected = _JSON_TYPES.get(name)
    return True if expected is None else isinstance(value, expected)


def validate(schema: dict, value, path: str = "$") -> list[str]:
    """Errors for `value` against `schema` (type, enum, properties, required, additionalProperties, items and
    numeric/length bounds). An empty list means valid."""
    if not isinstance(schema, dict):
        return []
    errors: list[str] = []
    types = schema.get("type")
    if types is not None:
        names = types if isinstance(types, list) else [types]
        if not any(_is_type(value, name) for name in names):
            return [f"{path}: expected {' or '.join(map(str, names))}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {schema['enum']}")
    if isinstance(value, dict):
        props = schema.get("properties") or {}
        for key in schema.get("required") or []:
            if key not in value:
                errors.append(f"{path}.{key}: required")
        if schema.get("additionalProperties") is False:
            errors.extend(f"{path}.{key}: not allowed" for key in value if key not in props)
        for key, sub in props.items():
            if key in value:
                errors.extend(validate(sub, value[key], f"{path}.{key}"))
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            errors.extend(validate(schema["items"], item, f"{path}[{index}]"))
    if _is_type(value, "number"):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: must be <= {schema['maximum']}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: must have at least {schema['minLength']} characters")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: must have at most {schema['maxLength']} characters")
    return errors


# ---------------------------------------------------------------------------------------------------------------
# Tool definitions for the API (strict tool use).
# ---------------------------------------------------------------------------------------------------------------
# Keywords structured outputs / strict tools do not support: removed from the schema sent to the API, described
# in the property's description instead, and still enforced locally by `validate` before a tool runs.
_UNSUPPORTED_KEYWORDS = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
                         "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "default")


def _hint(schema: dict) -> str:
    parts = []
    if "minimum" in schema or "maximum" in schema:
        parts.append(f"range {schema.get('minimum', '')}..{schema.get('maximum', '')}")
    if "minLength" in schema or "maxLength" in schema:
        parts.append(f"length {schema.get('minLength', 0)}..{schema.get('maxLength', '')}")
    if "default" in schema:
        parts.append("default " + json.dumps(schema["default"], ensure_ascii=False))
    return "; ".join(parts)


def strict_schema(schema: dict) -> dict:
    """A copy of a tool input schema that strict tool use accepts."""
    if not isinstance(schema, dict):
        return schema
    result = {}
    hint = _hint(schema)
    for key, value in schema.items():
        if key in _UNSUPPORTED_KEYWORDS:
            continue
        if key == "properties" and isinstance(value, dict):
            result[key] = {name: strict_schema(sub) for name, sub in value.items()}
        elif key in ("items", "additionalItems") and isinstance(value, dict):
            result[key] = strict_schema(value)
        elif key in ("anyOf", "allOf", "oneOf") and isinstance(value, list):
            result[key] = [strict_schema(sub) for sub in value]
        else:
            result[key] = copy.deepcopy(value)
    if hint:
        result["description"] = (str(result.get("description", "")).rstrip() + f" ({hint})").strip()
    types = result.get("type")
    if types == "object" or (isinstance(types, list) and "object" in types):
        result["additionalProperties"] = False
        result.setdefault("properties", {})
        result.setdefault("required", [])
    return result


def tool_definitions(tools: list[ToolSpec]) -> list[dict]:
    """API tool definitions, sorted by name so the prompt prefix is byte-stable for caching."""
    definitions = []
    for spec in sorted(tools, key=lambda s: s.name):
        definition = {"name": spec.name, "description": spec.description,
                      "input_schema": strict_schema(spec.input_schema), "strict": True}
        if EAGER_INPUT_STREAMING:
            definition["eager_input_streaming"] = True
        definitions.append(definition)
    return definitions


# ---------------------------------------------------------------------------------------------------------------
# Evidence ledger and answer grounding (shared with demo.py).
# ---------------------------------------------------------------------------------------------------------------
def _older(a: Source, b: Source) -> tuple[str | None, float | None]:
    """(as_of, age_s) of the older observation of two sources with the same id (unknown counts as oldest)."""
    if a.as_of is None or b.as_of is None:
        return None, None
    if a.as_of <= b.as_of:   # ISO-8601 UTC strings of the same form sort chronologically
        return a.as_of, a.age_s
    return b.as_of, b.age_s


def _merge(current: Source, new: Source) -> Source:
    worse = new if _STATUS_RANK.get(new.status, 9) > _STATUS_RANK.get(current.status, 9) else current
    as_of, age_s = _older(current, new)
    return Source(id=current.id, name=current.name, ref=current.ref, as_of=as_of, age_s=age_s, status=worse.status,
                  note=worse.note or current.note or new.note)


def _redacted(value) -> str:
    """A redacted string field; anything that is not a string becomes empty (never str() of an unknown object)."""
    return redact_text(value) if isinstance(value, str) else ""


class Ledger:
    """Every source an executed tool really returned in this request (and was shown to the model), deduplicated
    by id: a duplicate keeps the worse status and the older as_of. Plus the tools' caveats in first-seen order."""

    def __init__(self) -> None:
        self._sources: dict[str, Source] = {}
        self.caveats: list[str] = []

    def add(self, result: ToolResult) -> None:
        for source in result.sources or []:
            if not isinstance(source, Source) or not isinstance(source.id, str) or not source.id:
                continue
            # Defense in depth: results from run_tool are already redacted; this also covers direct callers.
            source = dataclasses.replace(source, id=redact_text(source.id), name=_redacted(source.name),
                                         ref=_redacted(source.ref), note=_redacted(source.note))
            if source.status not in _STATUS_RANK:
                source = dataclasses.replace(source, status="unavailable",
                                             note=source.note or "The tool reported an unknown source status.")
            elif source.status != "ok" and not (source.note or "").strip():
                # Plan decision 4: a non-ok source is never listed without saying why.
                source = dataclasses.replace(source, note=_DEFAULT_NOTES[source.status])
            current = self._sources.get(source.id)
            self._sources[source.id] = source if current is None else _merge(current, source)
        for caveat in result.caveats or []:
            caveat = redact_text(caveat) if isinstance(caveat, str) else None
            if caveat and caveat.strip() and caveat not in self.caveats:
                self.caveats.append(caveat)

    def ids(self) -> set[str]:
        return set(self._sources)

    def sources(self) -> list[Source]:
        return list(self._sources.values())

    def missing_notes(self) -> list[str]:
        """Hebrew-labelled lines for every non-ok source and every caveat (for missing_data)."""
        notes = []
        for source in self._sources.values():
            if source.status != "ok":
                label = _STATUS_HE.get(source.status, source.status)
                detail = f". פירוט טכני: {source.note}" if source.note else ""
                notes.append(f"{label}: {source.name} ({source.ref or source.id}){detail}")
        for caveat in self.caveats:
            hebrew = CAVEAT_HE.get(caveat)
            notes.append(f"הסתייגות: {hebrew}" if hebrew else f"הסתייגות (פירוט טכני): {caveat}")
        return notes


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


UNVERIFIED_PREFIX = "לא אומת: "


def ground_answer(answer: dict, ledger_ids: set[str], extra_missing: list[str] | None = None) -> dict:
    """Enforce the evidence rules on a schema-valid answer: drop source ids that are not in the ledger, move facts
    left without a source to missing_data as "לא אומת: …" (SEC-AI-20), and add `extra_missing` (deduplicated).
    Idempotent, so the router may apply its own evidence filter on top."""
    answer = copy.deepcopy(answer)
    facts, missing = [], list(answer.get("missing_data", []))
    for fact in answer.get("facts", []):
        ids = [i for i in dict.fromkeys(fact.get("source_ids", [])) if i in ledger_ids]
        if ids:
            facts.append({**fact, "source_ids": ids})
        elif fact.get("text"):
            missing.append(UNVERIFIED_PREFIX + fact["text"])
    answer["facts"] = facts
    for key in ("hypotheses", "recommendations"):
        answer[key] = [{**item, "source_ids": [i for i in dict.fromkeys(item.get("source_ids", []))
                                               if i in ledger_ids]}
                       for item in answer.get(key, [])]
    missing.extend(extra_missing or [])
    answer["missing_data"] = [note for note in dict.fromkeys(missing) if note]
    return answer


def finalize(answer: dict, ledger: Ledger, extra_missing: list[str] | None = None) -> dict:
    """Ground an answer against the ledger and surface the ledger's gaps in missing_data; the final text passes
    contracts.redact_tree as the last layer (LLM and demo answers alike)."""
    return redact_tree(ground_answer(answer, ledger.ids(), list(extra_missing or []) + ledger.missing_notes()))


def safe_answer(summary: str, missing: list[str] | None = None) -> dict:
    answer = empty_answer(summary)
    answer["missing_data"] = list(missing or [])
    return answer


def parse_answer(text: str) -> tuple[dict | None, str | None]:
    """(answer, None) when `text` is JSON matching ANSWER_SCHEMA, else (None, problem)."""
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None, "not_json"
    errors = validate(ANSWER_SCHEMA, value)
    if errors:
        return None, "schema: " + "; ".join(errors[:5])
    return value, None


# ---------------------------------------------------------------------------------------------------------------
# Tool execution.
# ---------------------------------------------------------------------------------------------------------------
def _reject(value):
    """json.dumps `default`: refuse anything that is not plain JSON. The message never contains str(value)."""
    raise TypeError(f"{type(value).__name__} is not JSON-serialisable")


def dumps_strict(value) -> str:
    """JSON for the model: plain JSON types only (no default=str, no NaN/Infinity)."""
    return json.dumps(value, ensure_ascii=False, default=_reject, allow_nan=False)


_SERIALISATION_ERRORS = (TypeError, ValueError, OverflowError, RecursionError)


def _source_from(value: dict) -> Source | None:
    """Rebuild a Source from its redacted, JSON-validated dict (all values are JSON primitives here)."""
    if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not value["id"]:
        return None

    def text(key):
        item = value.get(key)
        return item if isinstance(item, str) else ("" if item is None else json.dumps(item))

    as_of = value.get("as_of") if isinstance(value.get("as_of"), str) else None
    age_s = value.get("age_s")
    age_s = float(age_s) if isinstance(age_s, (int, float)) and not isinstance(age_s, bool) else None
    status = value.get("status") if value.get("status") in SOURCE_STATUSES else "unavailable"
    return Source(id=value["id"], name=text("name"), ref=text("ref"), as_of=as_of, age_s=age_s, status=status,
                  note=text("note"))


def sanitize_result(result: ToolResult) -> ToolResult:
    """The single gate between a tool and everything downstream (model envelope, ledger, demo text): a copy with
    contracts.redact_tree applied to data, sources and caveats (dict keys included), validated as strict JSON.
    Raises TypeError/ValueError when the result is not plain JSON (the caller turns that into a generic error)."""
    raw = {"data": result.data,
           "sources": [s.to_dict() if isinstance(s, Source) else s for s in (result.sources or [])],
           "caveats": list(result.caveats or [])}
    clean = redact_tree(raw)
    dumps_strict(clean)
    if not isinstance(clean["data"], dict):
        raise TypeError("tool data must be a JSON object")
    sources = [s for s in (_source_from(v) for v in clean["sources"]) if s is not None]
    caveats = [c for c in clean["caveats"] if isinstance(c, str)]
    return ToolResult(data=clean["data"], sources=sources, caveats=caveats)


def tool_envelope(name: str, result: ToolResult) -> str:
    """The tool_result content sent to the model: redacted strict JSON marked as untrusted data, at most
    ~MAX_RESULT_CHARS. Raises TypeError/ValueError for non-JSON content (never serialised with str())."""
    body = redact_tree(result.to_dict())
    tool = redact_text(str(name))
    text = dumps_strict({"untrusted_data": True, "tool": tool, "result": body})
    if len(text) <= MAX_RESULT_CHARS:
        return text
    data_text = dumps_strict(body["data"])
    head = {"untrusted_data": True, "tool": tool, "truncated": True,
            "note": (f"The result exceeded {MAX_RESULT_CHARS} characters. sources and caveats are complete; "
                     "data_prefix is the start of the data JSON and is incomplete. Call the tool again with "
                     "narrower arguments if the missing part matters, and mention the truncation."),
            "result": {"sources": body["sources"], "caveats": body["caveats"], "data_prefix": ""}}
    room = max(1_000, MAX_RESULT_CHARS - len(dumps_strict(head)))
    head["result"]["data_prefix"] = data_text[:room]
    return dumps_strict(head)


async def run_tool(spec: ToolSpec | None, name: str, args, ctx: ToolContext) -> ToolResult | str:
    """Run one tool after the role and argument checks. Returns the sanitised ToolResult (see sanitize_result) or a
    plain, redacted error message."""
    safe_name = redact_text(_clip(str(name), 80))
    if spec is None:
        return f"Unknown tool or tool not permitted for this user: {safe_name}."
    if not ctx.principal.allows(spec.required_role):
        return f"Tool {safe_name} requires the {spec.required_role} role."
    if not isinstance(args, dict):
        return "Tool input must be a JSON object."
    errors = validate(spec.input_schema, args)
    if errors:
        return redact_text("Invalid arguments: " + "; ".join(errors[:5]))
    try:
        result = await spec.func(ctx, **args)
    except ToolError as exc:
        return redact_text(_clip(str(exc) or "The tool could not read its data source.", 500))
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - a broken tool must not break the answer; never echo its message
        log.warning("Assistant tool %s failed (%s).", spec.name, type(exc).__name__)
        return TOOL_INTERNAL_ERROR
    if not isinstance(result, ToolResult):
        log.warning("Assistant tool %s returned an invalid result type.", spec.name)
        return TOOL_INTERNAL_ERROR
    try:
        return sanitize_result(result)
    except _SERIALISATION_ERRORS as exc:
        log.warning("Assistant tool %s returned data that is not plain JSON (%s).", spec.name, type(exc).__name__)
        return TOOL_INTERNAL_ERROR


class Budget:
    """Per-question tool budget: calls per round, calls per question and total characters of tool results."""

    def __init__(self) -> None:
        self.calls = 0
        self.chars = 0

    @property
    def exhausted(self) -> bool:
        return self.calls >= MAX_CALLS_PER_QUESTION or self.chars >= MAX_RESULT_CHARS_PER_QUESTION


def _error(block, message: str) -> dict:
    return {"type": "tool_result", "tool_use_id": block.id, "content": message, "is_error": True}


async def _execute_tool_uses(blocks: list, by_name: dict[str, ToolSpec], ctx: ToolContext, ledger: Ledger,
                             budget: Budget) -> list[dict]:
    """Execute the tool_use blocks of one assistant turn concurrently, within the budget; one tool_result per
    block, in order, all for one user message. Only tools from the principal-filtered `by_name` can run. Sources
    enter the ledger only for results that are actually sent to the model."""
    room = max(0, min(MAX_CALLS_PER_ROUND, MAX_CALLS_PER_QUESTION - budget.calls))
    if budget.chars >= MAX_RESULT_CHARS_PER_QUESTION:
        room = 0
    runnable = blocks[:room]
    budget.calls += len(runnable)
    outcomes = await asyncio.gather(*(run_tool(by_name.get(b.name), b.name, b.input, ctx) for b in runnable))
    results = []
    for block, outcome in zip(runnable, outcomes):
        if not isinstance(outcome, ToolResult):
            results.append(_error(block, outcome))
            continue
        try:
            content = tool_envelope(block.name, outcome)
        except _SERIALISATION_ERRORS as exc:   # sanitize_result already validated it; never fall back to str()
            log.warning("Assistant tool %s result could not be serialised (%s).", block.name, type(exc).__name__)
            results.append(_error(block, TOOL_INTERNAL_ERROR))
            continue
        if budget.chars + len(content) > MAX_RESULT_CHARS_PER_QUESTION:
            budget.chars = MAX_RESULT_CHARS_PER_QUESTION
            results.append(_error(block, f"Tool result budget for this question is exhausted (about "
                                         f"{MAX_RESULT_CHARS_PER_QUESTION} characters); answer with the data "
                                         "already returned."))
            continue
        budget.chars += len(content)
        ledger.add(outcome)
        results.append({"type": "tool_result", "tool_use_id": block.id, "content": content})
    skipped = (f"Not executed: the tool budget allows at most {MAX_CALLS_PER_ROUND} calls per turn, "
               f"{MAX_CALLS_PER_QUESTION} calls and about {MAX_RESULT_CHARS_PER_QUESTION} characters of results per "
               "question.")
    results.extend(_error(block, skipped) for block in blocks[room:])
    return results


# ---------------------------------------------------------------------------------------------------------------
# Conversation building.
# ---------------------------------------------------------------------------------------------------------------
def _history_text(item: dict) -> str | None:
    if item.get("role") == "user":
        text = item.get("text") if isinstance(item.get("text"), str) else item.get("content")
        return text if isinstance(text, str) else None
    answer = item.get("answer")   # assistant: the earlier answer's summary only, never stored tool data
    if isinstance(answer, dict) and isinstance(answer.get("summary"), str):
        return answer["summary"]
    text = item.get("text")
    return text if isinstance(text, str) else None


def history_messages(history: list[dict] | None) -> list[dict]:
    """Earlier turns as plain text: the user's earlier questions and the assistant's earlier summaries only (no
    facts, sources, tool data or thinking blocks are replayed)."""
    messages = []
    for item in list(history or [])[-HISTORY_TURNS:]:
        if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"):
            continue
        text = _history_text(item)
        if not isinstance(text, str) or not text.strip():
            continue
        messages.append({"role": item["role"], "content": _clip(text.strip(), HISTORY_CHARS)})
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    return messages


def _block_type(block) -> str | None:
    return getattr(block, "type", None) if not isinstance(block, dict) else block.get("type")


def echo_content(content: list) -> list:
    """Assistant content to append to the history. After a mid-output server-side fallback, the declined model's
    thinking/tool blocks before the last `fallback` block are omitted (skill: refusal section, echo rules)."""
    content = list(content or [])
    marks = [i for i, block in enumerate(content) if _block_type(block) == "fallback"]
    if not marks:
        return content
    last = marks[-1]
    dropped = {"thinking", "redacted_thinking", "tool_use", "server_tool_use"}
    return [b for i, b in enumerate(content) if i > last or _block_type(b) not in dropped]


class _Usage:
    def __init__(self) -> None:
        self.data = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
                     "cache_creation_input_tokens": 0, "requests": 0, "tool_rounds": 0, "tool_calls": 0,
                     "model": None, "fallback_used": False}

    def add(self, message) -> None:
        self.data["requests"] += 1
        self.data["model"] = getattr(message, "model", None) or self.data["model"]
        usage = getattr(message, "usage", None)
        for key in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            value = getattr(usage, key, None) if usage is not None else None
            if isinstance(value, int):
                self.data[key] += value
        iterations = getattr(usage, "iterations", None) if usage is not None else None
        if any(getattr(entry, "type", None) == "fallback_message" for entry in iterations or []):
            self.data["fallback_used"] = True


# ---------------------------------------------------------------------------------------------------------------
# The LLM tool loop.
# ---------------------------------------------------------------------------------------------------------------
def _request_params(settings, system, messages, tools_defs, final_round: bool, with_fallback: bool) -> dict:
    params = {
        "model": getattr(settings, "assistant_model", None) or "claude-opus-5-5",
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": messages,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": EFFORT, "format": {"type": "json_schema", "schema": ANSWER_SCHEMA}},
        "cache_control": {"type": "ephemeral"},
    }
    if tools_defs:
        params["tools"] = tools_defs
        if final_round:
            params["tool_choice"] = {"type": "none"}
    if with_fallback:
        params["betas"] = [SERVER_FALLBACK_BETA]
        params["fallbacks"] = "default"
    return params


async def _create(client, sdk, params_factory, first_request: bool):
    """One streamed request -> final message. If the server-side fallback parameters are rejected (400) on the
    first request, retry once without them and stop sending them for the rest of the process."""
    use_fallback = _server_fallback["enabled"]
    try:
        async with client.beta.messages.stream(**params_factory(use_fallback)) as stream:
            return await stream.get_final_message()
    except Exception as exc:
        bad_request = getattr(sdk, "BadRequestError", None) if sdk is not None else None
        if not (use_fallback and first_request and bad_request is not None and isinstance(exc, bad_request)):
            raise
    async with client.beta.messages.stream(**params_factory(False)) as stream:
        message = await stream.get_final_message()
    _server_fallback["enabled"] = False
    log.warning("The API rejected the server-side refusal fallback parameters; continuing without them.")
    return message


def _refusal_answer(message) -> dict:
    details = getattr(message, "stop_details", None)
    category = getattr(details, "category", None) if details is not None else None
    note = "מודל השפה סירב לענות (stop_reason=refusal" + (f", קטגוריה: {category}" if category else "") + ")."
    return safe_answer(
        "מודל השפה לא השיב על השאלה הזאת: הבקשה נחסמה על ידי מנגנוני הבטיחות של ספק המודל. לא נוצרה תשובה "
        "ולא בוצעה שום פעולה. נסה לנסח את השאלה מחדש, למשל לשאול על רכיב או אירוע מסוים במעבדה.", [note])


async def _answer_llm(*, sdk, question: str, history, context, ctx: ToolContext, tools: list[ToolSpec]) -> dict:
    client = client_factory(ctx.settings, sdk)
    try:
        return await _tool_loop(client, sdk, question=question, history=history, context=context, ctx=ctx,
                                tools=tools)
    finally:
        close = getattr(client, "close", None)
        if client_factory is default_client_factory and close is not None and inspect.iscoroutinefunction(close):
            try:
                await close()
            except Exception:  # noqa: BLE001
                pass


async def _tool_loop(client, sdk, *, question, history, context, ctx: ToolContext, tools: list[ToolSpec]) -> dict:
    by_name = {spec.name: spec for spec in tools}
    tools_defs = tool_definitions(tools)
    system = [{"type": "text", "text": prompts.SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
    user_turn = prompts.build_user_turn(question, context, ctx.now,
                                        getattr(ctx.settings, "ping_monitor_timezone", None))
    messages = history_messages(history) + [{"role": "user", "content": user_turn}]
    ledger, usage, budget = Ledger(), _Usage(), Budget()
    force_final = False

    def result(answer: dict, extra_missing: list[str] | None = None) -> dict:
        return {"mode": "llm", "answer": finalize(answer, ledger, extra_missing), "ledger": ledger.sources(),
                "usage": usage.data, "demo_reason": None}

    for round_no in range(MAX_TOOL_ROUNDS + 1):
        final_round = force_final or round_no == MAX_TOOL_ROUNDS
        message = await _create(
            client, sdk,
            lambda with_fallback: _request_params(ctx.settings, system, messages, tools_defs, final_round,
                                                  with_fallback),
            first_request=round_no == 0)
        usage.add(message)
        stop = getattr(message, "stop_reason", None)
        if stop == "refusal":
            log.info("Assistant answer was refused by the model's safeguards.")
            return result(_refusal_answer(message))
        content = echo_content(getattr(message, "content", None) or [])
        if stop == "pause_turn":
            messages.append({"role": "assistant", "content": content})
            continue
        tool_uses = [b for b in content if _block_type(b) == "tool_use"]
        if tool_uses:
            if stop == "max_tokens":
                return result(safe_answer(
                    "התשובה נקטעה לפני שהושלמה (מגבלת אורך). נסה לשאול שאלה ממוקדת יותר.",
                    ["מודל השפה הגיע למגבלת האורך באמצע בקשת נתונים; הבקשה לא בוצעה."]))
            if final_round:
                return result(safe_answer(
                    "לא התקבלה תשובה סופית: מודל השפה ביקש נתונים נוספים אחרי שמכסת הכלים לשאלה הסתיימה. "
                    "נסה לשאול שאלה ממוקדת יותר.",
                    [f"הוגעה מכסת הכלים לשאלה אחת ({MAX_TOOL_ROUNDS} סבבים, {MAX_CALLS_PER_QUESTION} קריאות, "
                     f"כ-{MAX_RESULT_CHARS_PER_QUESTION} תווים)."]))
            messages.append({"role": "assistant", "content": content})
            tool_results = await _execute_tool_uses(tool_uses, by_name, ctx, ledger, budget)
            usage.data["tool_rounds"] += 1
            usage.data["tool_calls"] = budget.calls
            if round_no + 1 == MAX_TOOL_ROUNDS or budget.exhausted:
                force_final = True
                tool_results.append({"type": "text", "text": prompts.FINAL_ROUND_INSTRUCTION})
            messages.append({"role": "user", "content": tool_results})
            continue
        text = "".join(getattr(b, "text", "") or "" for b in content if _block_type(b) == "text").strip()
        answer, problem = parse_answer(text) if stop != "max_tokens" else (None, "truncated")
        if answer is None:
            log.warning("Assistant model output was not a valid answer object (%s).", (problem or "")[:120])
            shown = _clip(text, 3_000) if text else "מודל השפה לא החזיר תשובה תקינה."
            return result(safe_answer(
                "התשובה לא התקבלה במבנה הנדרש ולכן מוצגת כפי שהיא, ללא אימות מול מקורות: " + shown
                if text else shown,
                ["פלט מודל השפה לא תאם את מבנה התשובה הנדרש" + (" (נקטע במגבלת האורך)" if problem == "truncated"
                                                                else "") + "; העובדות לא אומתו."]))
        return result(answer)
    raise AssertionError("unreachable")  # pragma: no cover


# ---------------------------------------------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------------------------------------------
def _failure_reason(sdk, exc: Exception) -> str:
    def is_(name: str) -> bool:
        cls = getattr(sdk, name, None) if sdk is not None else None
        return isinstance(cls, type) and isinstance(exc, cls)

    if is_("AuthenticationError") or is_("PermissionDeniedError"):
        return "llm_auth_failed"
    if is_("RateLimitError"):
        return "llm_rate_limited"
    if is_("APIConnectionError"):  # includes APITimeoutError
        return "llm_unreachable"
    if is_("APIStatusError"):
        status = getattr(exc, "status_code", 0) or 0
        return "llm_unavailable" if status >= 500 else "llm_rejected"
    return "llm_error"


async def _cancel_proposals(ctx: ToolContext, ids: list[str]) -> None:
    from .actions import store  # noqa: PLC0415 - lazy: the engine works without the actions package

    async with ctx.session_factory() as db:
        for proposal_id in ids:
            try:
                await store.cancel(db, ctx.principal, proposal_id, time.time())
            except Exception as exc:  # noqa: BLE001 - e.g. no longer pending; never echo the message
                log.warning("Assistant could not cancel an abandoned action proposal (%s).", type(exc).__name__)


async def withdraw_proposals(ctx: ToolContext) -> None:
    """An LLM answer that failed is discarded and the demo responder answers with the same ctx. The action proposals
    the failed answer's tool calls prepared would stay pending and unseen next to the fallback's own proposal, so
    they are cancelled (store.cancel, own short session, at most WITHDRAW_SECONDS) and ctx.proposals is cleared.
    Best effort: failures are logged by exception class only."""
    proposals = getattr(ctx, "proposals", None)
    if not isinstance(proposals, list) or not proposals:
        return
    ids = [value for value in dict.fromkeys(proposals) if isinstance(value, str) and value]
    proposals.clear()
    if not ids:
        return
    try:
        await asyncio.wait_for(_cancel_proposals(ctx, ids), timeout=WITHDRAW_SECONDS)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - includes the timeout
        log.warning("Assistant could not withdraw abandoned action proposals (%s).", type(exc).__name__)


def allowed_tools(tools: list[ToolSpec], ctx: ToolContext) -> list[ToolSpec]:
    """Defense in depth: only valid specs the principal's role allows, first declaration of each name."""
    result, seen = [], set()
    for spec in tools or []:
        if (isinstance(spec, ToolSpec) and spec.name not in seen and spec.required_role in ROLE_ORDER
                and ctx.principal.allows(spec.required_role)):
            seen.add(spec.name)
            result.append(spec)
    return result


async def answer_question(*, question: str, history: list[dict], context: dict, ctx: ToolContext,
                          tools: list[ToolSpec], mode: str | None = None, demo_reason: str | None = None) -> dict:
    """Answer one question. Returns {"mode", "answer", "ledger", "usage", "demo_reason"}; demo_reason is a fixed
    Hebrew sentence (never exception text) when mode is "demo".

    `mode="demo"` (with an optional Hebrew `demo_reason`) lets the router force the demo responder, e.g. for
    legacy mode without a site password or the daily LLM cap; any other value lets the engine decide.
    Raises asyncio.TimeoutError when the answer does not finish within settings.assistant_timeout_seconds."""
    from . import demo  # noqa: PLC0415 - demo imports this module

    tools = allowed_tools(tools, ctx)
    budget = float(getattr(ctx.settings, "assistant_timeout_seconds", 90) or 90)
    if mode != "demo":
        await resolve_key(ctx)
    engine_mode, reason = llm_status(ctx.settings)
    if mode == "demo":
        engine_mode = "demo"
        reason = demo_reason if isinstance(demo_reason, str) and demo_reason.strip() else "router_demo"
    if engine_mode != "llm":
        return await asyncio.wait_for(
            demo.answer(question=question, history=history, context=context, ctx=ctx, tools=tools, reason=reason),
            timeout=budget)
    sdk = load_sdk()
    loop = asyncio.get_running_loop()
    started = loop.time()
    try:
        return await asyncio.wait_for(
            _answer_llm(sdk=sdk, question=question, history=history, context=context, ctx=ctx, tools=tools),
            timeout=budget)
    except asyncio.TimeoutError:
        log.warning("Assistant answer exceeded the %.0f s budget.", budget)
        raise
    except Exception as exc:  # noqa: BLE001 - any LLM failure falls back to the data-grounded demo answer
        reason = _failure_reason(sdk, exc)
        status = getattr(exc, "status_code", None)
        request_id = getattr(exc, "request_id", None)
        log.warning("Assistant LLM call failed (%s%s%s); answering in demo mode.", type(exc).__name__,
                    f", HTTP {status}" if isinstance(status, int) else "",
                    f", request_id {request_id}" if isinstance(request_id, str) and request_id.isprintable()
                    and len(request_id) <= 64 else "")
    await withdraw_proposals(ctx)
    remaining = budget - (loop.time() - started)
    if remaining <= 0.5:
        raise asyncio.TimeoutError()
    return await asyncio.wait_for(
        demo.answer(question=question, history=history, context=context, ctx=ctx, tools=tools, reason=reason),
        timeout=remaining)


__all__ = [
    "EAGER_INPUT_STREAMING", "EFFORT", "Ledger", "MAX_RESULT_CHARS", "MAX_TOOL_ROUNDS", "SOURCE_STATUSES",
    "allowed_tools", "answer_question", "client_factory", "default_client_factory", "finalize", "ground_answer",
    "history_messages", "llm_status", "load_sdk", "parse_answer", "resolve_key", "run_tool", "safe_answer",
    "strict_schema",
    "tool_definitions", "tool_envelope", "validate",
]
