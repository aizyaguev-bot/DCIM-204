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
from typing import Any, Callable

from . import prompts
from .contracts import (
    ANSWER_SCHEMA, ROLE_ORDER, SOURCE_STATUSES, Source, ToolContext, ToolError, ToolResult, ToolSpec, empty_answer,
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
# Fine-grained (eager) tool-input streaming stays off: tool inputs here are tiny, we do not render the stream,
# and keeping it off keeps the server-side strict-schema validation of tool inputs.
EAGER_INPUT_STREAMING = False

_STATUS_RANK = {status: rank for rank, status in enumerate(("ok", "stale", "disabled", "missing", "unavailable"))}
_STATUS_HE = {"stale": "נתונים לא עדכניים", "missing": "מקור חסר", "unavailable": "מקור לא זמין",
              "disabled": "מקור מושבת"}
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
    secret = getattr(settings, "assistant_anthropic_api_key", None)
    if secret is None:
        return ""
    value = secret.get_secret_value() if hasattr(secret, "get_secret_value") else secret
    return value.strip() if isinstance(value, str) else ""


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
            if source.status not in _STATUS_RANK:
                source = dataclasses.replace(source, status="unavailable",
                                             note=source.note or "The tool reported an unknown source status.")
            elif source.status != "ok" and not (source.note or "").strip():
                # Plan decision 4: a non-ok source is never listed without saying why.
                source = dataclasses.replace(source, note=_DEFAULT_NOTES[source.status])
            current = self._sources.get(source.id)
            self._sources[source.id] = source if current is None else _merge(current, source)
        for caveat in result.caveats or []:
            if isinstance(caveat, str) and caveat.strip() and caveat not in self.caveats:
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
                detail = f" - {source.note}" if source.note else ""
                notes.append(f"{label}: {source.name} ({source.ref or source.id}){detail}")
        notes.extend(f"הסתייגות מהנתונים: {caveat}" for caveat in self.caveats)
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
    """Ground an answer against the ledger and surface the ledger's gaps in missing_data."""
    return ground_answer(answer, ledger.ids(), list(extra_missing or []) + ledger.missing_notes())


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
def tool_envelope(name: str, result: ToolResult) -> str:
    """The tool_result content sent to the model: JSON marked as untrusted data, at most ~MAX_RESULT_CHARS."""
    payload = {"untrusted_data": True, "tool": name, "result": result.to_dict()}
    text = json.dumps(payload, ensure_ascii=False, default=str)
    if len(text) <= MAX_RESULT_CHARS:
        return text
    body = result.to_dict()
    data_text = json.dumps(body["data"], ensure_ascii=False, default=str)
    head = {"untrusted_data": True, "tool": name, "truncated": True,
            "note": (f"The result exceeded {MAX_RESULT_CHARS} characters. sources and caveats are complete; "
                     "data_prefix is the start of the data JSON and is incomplete. Call the tool again with "
                     "narrower arguments if the missing part matters, and mention the truncation."),
            "result": {"sources": body["sources"], "caveats": body["caveats"], "data_prefix": ""}}
    room = max(1_000, MAX_RESULT_CHARS - len(json.dumps(head, ensure_ascii=False, default=str)))
    head["result"]["data_prefix"] = data_text[:room]
    return json.dumps(head, ensure_ascii=False, default=str)


async def run_tool(spec: ToolSpec | None, name: str, args, ctx: ToolContext) -> ToolResult | str:
    """Run one tool after the role and argument checks. Returns the ToolResult or a plain error message."""
    safe_name = _clip(str(name), 80)
    if spec is None:
        return f"Unknown tool or tool not permitted for this user: {safe_name}."
    if not ctx.principal.allows(spec.required_role):
        return f"Tool {safe_name} requires the {spec.required_role} role."
    if not isinstance(args, dict):
        return "Tool input must be a JSON object."
    errors = validate(spec.input_schema, args)
    if errors:
        return "Invalid arguments: " + "; ".join(errors[:5])
    try:
        result = await spec.func(ctx, **args)
    except ToolError as exc:
        return _clip(str(exc) or "The tool could not read its data source.", 500)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - a broken tool must not break the answer; never echo its message
        log.warning("Assistant tool %s failed (%s).", spec.name, type(exc).__name__)
        return TOOL_INTERNAL_ERROR
    if not isinstance(result, ToolResult):
        log.warning("Assistant tool %s returned an invalid result type.", spec.name)
        return TOOL_INTERNAL_ERROR
    return result


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
        content = tool_envelope(block.name, outcome)
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
    remaining = budget - (loop.time() - started)
    if remaining <= 0.5:
        raise asyncio.TimeoutError()
    return await asyncio.wait_for(
        demo.answer(question=question, history=history, context=context, ctx=ctx, tools=tools, reason=reason),
        timeout=remaining)


__all__ = [
    "EAGER_INPUT_STREAMING", "EFFORT", "Ledger", "MAX_RESULT_CHARS", "MAX_TOOL_ROUNDS", "SOURCE_STATUSES",
    "allowed_tools", "answer_question", "client_factory", "default_client_factory", "finalize", "ground_answer",
    "history_messages", "llm_status", "load_sdk", "parse_answer", "run_tool", "safe_answer", "strict_schema",
    "tool_definitions", "tool_envelope", "validate",
]
