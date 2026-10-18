"""Shared contracts for the lab assistant: tool interface, evidence sources and the answer format.

Every module in this package builds on these types. Changing a field here is a contract change owned by the
lead; workers add fields only through the lead. Nothing in this module touches the database or the network.
"""
from __future__ import annotations

import datetime as _dt
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
    session_factory: Any
    settings: Any
    now: float
    project_root: Any = None     # pathlib.Path of the repository root (for read-only data/doc files)


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
