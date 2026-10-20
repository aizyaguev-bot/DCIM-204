"""Shared contracts for the lab assistant: tool interface, evidence sources and the answer format.

Every module in this package builds on these types. Changing a field here is a contract change owned by the
lead; workers add fields only through the lead. Nothing in this module touches the database or the network.
"""
from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

ROLE_ORDER = {"Viewer": 0, "Operator": 1, "Admin": 2}
SourceStatus = Literal["ok", "stale", "missing", "unavailable", "disabled"]
SOURCE_STATUSES = ("ok", "stale", "missing", "unavailable", "disabled")


@dataclass(frozen=True)
class Principal:
    """Who is asking. In legacy (shared-password) mode there is no user: user_id is None and role is "Admin"."""
    user_id: str | None
    username: str
    role: str  # Viewer | Operator | Admin
    legacy: bool = False

    def allows(self, required: str) -> bool:
        return ROLE_ORDER.get(self.role, -1) >= ROLE_ORDER.get(required, 99)


@dataclass
class Source:
    """One place a fact came from. `id` is stable and unique inside one answer (e.g. "ping_targets:opt207")."""
    id: str
    name: str                    # short human label, English, e.g. "Ping monitor"
    ref: str = ""                # entity id / file name / table name the data belongs to
    as_of: str | None = None     # ISO-8601 UTC of the data itself (not of the tool call); None when unknown
    age_s: float | None = None   # seconds between as_of and the tool call; None when unknown
    status: SourceStatus = "ok"
    note: str = ""               # why stale/missing/unavailable/disabled, plain English, no secrets

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "ref": self.ref, "as_of": self.as_of, "age_s": self.age_s,
                "status": self.status, "note": self.note}


@dataclass
class ToolResult:
    """What every tool returns. `data` must be JSON-serialisable and must never contain credentials,
    password hashes, session tokens, user e-mail addresses or the alert recipient address."""
    data: dict[str, Any]
    sources: list[Source] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)   # e.g. "Email alerts are disabled: no alert history exists"

    def to_dict(self) -> dict:
        return {"data": self.data, "sources": [s.to_dict() for s in self.sources], "caveats": list(self.caveats)}


@dataclass
class ToolContext:
    """Passed to every tool call. Tools open their own short DB sessions through `session_factory`
    (an async_sessionmaker) and close them before returning. `now` is epoch seconds for the whole request."""
    principal: Principal
    session_factory: Any = field(repr=False)
    settings: Any = field(repr=False)    # holds plain-text device passwords: never repr/log/dump it; read attributes by name
    now: float = 0.0
    project_root: Any = field(default=None, repr=False)   # pathlib.Path of the repository root (read-only files)
    conversation_id: str | None = None
    # Ids of action proposals created by tools in this request (actions/tools.py appends; the chat router returns
    # their public JSON as `action_proposals`). Only server code writes it; the model never supplies an id here.
    proposals: list[str] = field(default_factory=list, repr=False)
    # Intent anchor for action proposals (ORCA-SEC-ACTIONS D2): this turn's own user text and validated page context
    # ({"detail": ..., "rack": ...}). Set by the chat router; never taken from tool data or model output.
    user_message: str = field(default="", repr=False)
    page_context: dict = field(default_factory=dict, repr=False)


ToolFunc = Callable[..., Awaitable[ToolResult]]   # async def tool(ctx: ToolContext, **args) -> ToolResult


@dataclass(frozen=True)
class ToolSpec:
    """A read-only tool the model (or the demo responder) may call."""
    name: str                    # snake_case, unique across the package
    description: str             # English, for the model: what it returns and when to use it
    input_schema: dict           # JSON Schema, "type": "object", "additionalProperties": false, "required": [...]
    required_role: str           # Viewer | Operator | Admin — mirror of the equivalent GET endpoint's role
    func: ToolFunc


class ToolError(Exception):
    """Raised by a tool for a bad argument or an unavailable source. The message is shown to the model and the
    user, so it must be plain English without secrets, internal addresses or stack traces."""


# Every rule below runs in linear time on any input length (no nested unbounded quantifiers, no rescanning), and a
# detected secret value is always removed whole, whatever its length or the spacing around its separator.
_SCHEME = re.compile(r"(?i)\b[a-z][a-z0-9+.-]{0,30}://")
_CREDENTIAL_KEY = re.compile(r"(?i)password|passwd|pwd|username|api[_ -]?key|token|session[_ -]?hash|secret")
_EMAIL_LOCAL = frozenset(".!#$%&'*+/=?^`{|}~-_")
_SIMPLE = (
    (re.compile(r"(?i)\b(?:Basic|Bearer)\s+\S+"), "[redacted credential]"),
    (re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}"), "[redacted key]"),
)


def _is_word(ch: str) -> bool:
    return ch.isalnum() or ch in "_-"


def _redact_userinfo(value: str) -> str:
    """scheme://user[:pass]@host -> scheme://[redacted]@host, for any userinfo length."""
    out, pos = [], 0
    for m in _SCHEME.finditer(value):
        if m.start() < pos:
            continue
        start = m.end()
        end = start
        while end < len(value) and not value[end].isspace() and value[end] != "/":  # a password may hold '?' or '#'
            end += 1
        at = value.rfind("@", start, end)
        if at > start:
            out += [value[pos:start], "[redacted]"]
            pos = at
    out.append(value[pos:])
    return "".join(out)


def _redact_credentials(value: str) -> str:
    """<...key...>[quote] [spaces] (= or :) [spaces] <value> -> [redacted credential], the whole value removed."""
    out, pos, skip, n = [], 0, 0, len(value)
    for m in _CREDENTIAL_KEY.finditer(value):
        if m.start() < max(pos, skip):
            continue
        start = m.start()
        while start > pos and _is_word(value[start - 1]):
            start -= 1
        if start > pos and value[start - 1] in "\"'":
            start -= 1
        j = m.end()
        while j < n and _is_word(value[j]):
            j += 1
        if j < n and value[j] in "\"'":
            j += 1
        while j < n and value[j].isspace():
            j += 1
        if j >= n or value[j] not in ":=":
            skip = j  # this word has no separator: later keywords inside it are not rescanned
            continue
        j += 1
        while j < n and value[j].isspace():
            j += 1
        if j < n and value[j] in "\"'":
            close = value.find(value[j], j + 1)
            end = n if close == -1 else close + 1
        else:
            end = j
            while end < n and not value[end].isspace() and value[end] not in ",;":
                end += 1
        if end == j:
            skip = j  # empty value: nothing to remove, and the word already walked over is not rescanned
            continue
        out += [value[pos:start], "[redacted credential]"]
        pos = end
    out.append(value[pos:])
    return "".join(out)


def _redact_emails(value: str) -> str:
    """local@domain -> [redacted email], the whole address: any number of labels, dotted or not (root@server1)."""
    out, pos, n = [], 0, len(value)
    at = value.find("@")
    while at != -1:
        start = at
        while start > pos and (value[start - 1].isalnum() or value[start - 1] in _EMAIL_LOCAL):
            start -= 1
        end = at + 1
        while end < n and (value[end].isalnum() or value[end] in "_.-"):
            end += 1
        while end > at + 1 and value[end - 1] in ".-":
            end -= 1
        if start < at and end > at + 1:
            out += [value[pos:start], "[redacted email]"]
            pos = end
        at = value.find("@", max(at + 1, pos))
    out.append(value[pos:])
    return "".join(out)


def redact_text(value: str) -> str:
    """Remove credential-looking fragments (key=value secrets, URL userinfo, e-mail addresses, Basic/Bearer tokens,
    API keys) from one untrusted string. The single shared rule for every tool result that reaches the model."""
    value = _redact_userinfo(value)
    value = _redact_credentials(value)
    value = _redact_emails(value)
    for pattern, replacement in _SIMPLE:
        value = pattern.sub(replacement, value)
    return value


def redact_tree(value: Any) -> Any:
    """redact_text applied to every string (dict keys included) inside nested dicts/lists/tuples."""
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {redact_text(k) if isinstance(k, str) else k: redact_tree(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_tree(v) for v in value]
    return value


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return _dt.datetime.fromtimestamp(float(ts), tz=_dt.timezone.utc).replace(microsecond=0).isoformat()


def age(ts: float | None, now: float) -> float | None:
    if ts is None:
        return None
    return max(0.0, round(float(now) - float(ts), 1))


# ---------------------------------------------------------------------------------------------------------------
# Answer format. The engine (LLM or demo) produces this object; the router adds `sources` from the evidence ledger
# (only sources really returned by tools in this request) and drops any source_id that is not in the ledger.
# Text fields are Hebrew for the owner; ids, names, IPs and units stay as in the data.
# ---------------------------------------------------------------------------------------------------------------
PRIORITIES = ("high", "medium", "low")
ENTITY_KINDS = ("server", "pdu", "kvm", "rack", "item", "incident", "maintenance", "work_item")

_ENTITY_REF = {
    "type": "object", "additionalProperties": False,
    "required": ["kind", "id", "label"],
    "properties": {"kind": {"type": "string", "enum": list(ENTITY_KINDS)},
                   "id": {"type": "string"}, "label": {"type": "string"}},
}
_SOURCE_IDS = {"type": "array", "items": {"type": "string"}}

WORK_ITEM_DRAFT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["title", "description", "entity_refs", "priority", "rationale", "steps"],
    "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
        "entity_refs": {"type": "array", "items": _ENTITY_REF},
        "priority": {"type": "string", "enum": list(PRIORITIES)},
        "rationale": {"type": "string"},
        "steps": {"type": "array", "items": {"type": "string"}},
    },
}

ANSWER_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["summary", "facts", "hypotheses", "recommendations", "checks", "missing_data",
                 "entity_refs", "work_item_drafts"],
    "properties": {
        "summary": {"type": "string"},                       # 1-4 sentences, Hebrew
        "facts": {"type": "array", "items": {               # observed, each backed by sources
            "type": "object", "additionalProperties": False, "required": ["text", "source_ids"],
            "properties": {"text": {"type": "string"}, "source_ids": _SOURCE_IDS}}},
        "hypotheses": {"type": "array", "items": {          # possible causes: support + how to verify
            "type": "object", "additionalProperties": False,
            "required": ["text", "support", "verify", "source_ids"],
            "properties": {"text": {"type": "string"}, "support": {"type": "array", "items": {"type": "string"}},
                           "verify": {"type": "string"}, "source_ids": _SOURCE_IDS}}},
        "recommendations": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["title", "problem", "evidence", "priority", "next_step", "missing_info", "source_ids",
                         "entity_refs"],
            "properties": {"title": {"type": "string"}, "problem": {"type": "string"},
                           "evidence": {"type": "string"}, "priority": {"type": "string", "enum": list(PRIORITIES)},
                           "next_step": {"type": "string"},
                           "missing_info": {"type": "array", "items": {"type": "string"}},
                           "source_ids": _SOURCE_IDS, "entity_refs": {"type": "array", "items": _ENTITY_REF}}}},
        "checks": {"type": "array", "items": {"type": "string"}},          # ordered: what to check first
        "missing_data": {"type": "array", "items": {"type": "string"}},    # data the system does not have
        "entity_refs": {"type": "array", "items": _ENTITY_REF},           # for links to site records
        "work_item_drafts": {"type": "array", "items": WORK_ITEM_DRAFT_SCHEMA},
    },
}

AnswerMode = Literal["llm", "demo"]


def empty_answer(summary: str) -> dict:
    return {"summary": summary, "facts": [], "hypotheses": [], "recommendations": [], "checks": [],
            "missing_data": [], "entity_refs": [], "work_item_drafts": []}
