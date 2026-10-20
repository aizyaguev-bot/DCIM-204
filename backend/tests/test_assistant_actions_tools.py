"""ACT-6: the model tool `propose_action`, its registry gate, the intent anchor (ORCA-SEC-ACTIONS D1/D2), the chat
`action_proposals` ledger, the LLM-to-demo fallback and the prompt.

The proposal store (ACT-5) is a fake unless a test says otherwise; resolve.build_impact (ACT-1) is always a fake.
No device is contacted, no LLM is called, every database is a temporary SQLite file.
"""
import asyncio
import json
import sys
import time
import types
import uuid
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts
from app.assistant import demo, engine, prompts, ratelimit, registry
from app.assistant import router as assistant
from app.assistant.actions import tools
from app.assistant.actions.contracts import KIND_SPECS, ActionError, Impact, ProposalRequest, Target
from app.assistant.contracts import Principal, ToolContext, ToolResult, empty_answer
from app.database import Base
from app.models import User

NOW = 1_760_000_000.0
PASSWORD = "assistant-actions-test-password-1"
INJECTED_ID = "0123456789abcdef0123456789abcdef"
RLO = chr(0x202E)   # right-to-left override (kept out of the source as a literal)
OPERATOR = Principal("op-1", "operator", "Operator")
ADMIN = Principal("adm-1", "admin", "Admin")
ADMIN2 = Principal("adm-2", "admin2", "Admin")
VIEWER = Principal("view-1", "viewer", "Viewer")
LEGACY = Principal(None, "shared", "Admin", legacy=True)
ON = SimpleNamespace(assistant_actions_enabled=True, accounts_enabled=True)


# ---------------------------------------------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------------------------------------------
class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def fake_sessions():
    return _Session()


def public_for(row) -> dict:
    """Shape of store.to_public (contracts.py), including fields the model must not receive."""
    return {
        "id": row.id, "kind": row.kind, "scope": KIND_SPECS[row.kind].scope, "title_he": "ריסט חשמל לשרת OPT11",
        "status": row.status, "created_at": "2026-10-20T10:00:00Z", "expires_at": "2026-10-20T10:05:00Z",
        "created_by": row.created_by, "required_role": KIND_SPECS[row.kind].required_role, "needs_password": True,
        "phrase": "LAB OFF" if row.kind == "lab_shutdown" else None, "background": False,
        "request": {"kind": row.kind, "server": "OPT11"},
        "impact": {
            "targets": [{"pdu_id": "pdu-1", "pdu_name": "PDU-A", "rack": "Rack-01", "outlet": 3, "label": "OPT11",
                         "server": "OPT11", "state": "on"}],
            "excluded": [{"pdu_id": "pdu-1", "pdu_name": "PDU-A", "rack": "Rack-01", "outlet": 7, "label": "SW1",
                          "reason": "protected"},
                         {"pdu_id": "pdu-2", "pdu_name": "PDU-B", "rack": "Rack-01", "outlet": None, "label": "",
                          "reason": "maintenance"}],
            "pdus": ["pdu-1"], "servers": list(row.servers), "consoles": [],
            "warnings_he": ["השרת נמצא בהתקנת PXE."],
            "counts": {"outlets": 1, "pdus": 1, "servers": len(row.servers), "excluded": 2}},
        "progress": {"done": 0, "total": 1}, "result": None, "restore_of": row.restore_of,
        "can_restore": bool(row.restorable), "can_execute": row.status == "pending",
    }


class FakeStore:
    """The store.py functions the tool and the chat router use (signatures from actions/contracts.py)."""

    def __init__(self):
        self.rows: dict[str, SimpleNamespace] = {}
        self.calls: list[SimpleNamespace] = []
        self.cancelled: list[str] = []
        self.error: Exception | None = None
        self.delay = 0.0
        self.resolved_servers: list[str] | None = None   # None: the request's server, as the resolver would

    def owner_key(self, principal) -> str:
        return principal.user_id if principal.user_id and not principal.legacy else "shared:" + principal.username

    def add(self, principal, kind, *, created_at=NOW, status="pending", restorable=False, restore_of=None,
            conversation_id=None, servers=()):
        row = SimpleNamespace(id=uuid.uuid4().hex, owner_key=self.owner_key(principal), kind=kind,
                              created_at=created_at, status=status, restorable=restorable, restore_of=restore_of,
                              created_by=principal.username, conversation_id=conversation_id, servers=list(servers))
        self.rows[row.id] = row
        return row

    async def propose(self, session_factory, principal, req, settings, now, conversation_id=None):
        self.calls.append(SimpleNamespace(session_factory=session_factory, principal=principal, req=req,
                                          settings=settings, now=now, conversation_id=conversation_id))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        servers = self.resolved_servers
        if servers is None:
            servers = [req.server.upper()] if req.server and KIND_SPECS[req.kind].switch != "none" else []
        row = self.add(principal, req.kind, created_at=now, restore_of=req.restore_of,
                       conversation_id=conversation_id, servers=servers)
        return self.to_public(row, principal)

    async def get_for(self, db, principal, proposal_id):
        row = self.rows.get(proposal_id)
        if row is None or (row.owner_key != self.owner_key(principal) and not principal.allows("Admin")):
            return None
        return row

    async def list_for(self, db, principal, limit=20):
        rows = [row for row in self.rows.values()
                if principal.allows("Admin") or row.owner_key == self.owner_key(principal)]
        return sorted(rows, key=lambda row: row.created_at, reverse=True)[:limit]

    async def cancel(self, db, principal, proposal_id, now):
        self.cancelled.append(proposal_id)
        self.rows[proposal_id].status = "cancelled"
        return self.rows[proposal_id]

    def to_public(self, row, principal):
        return public_for(row)


@pytest.fixture
def store(monkeypatch):
    fake = FakeStore()
    monkeypatch.setattr(tools, "store", fake)
    return fake


def make_ctx(message="תעשה ריסט לשרת OPT11 ותפתח KVM", principal=OPERATOR, settings=ON, conversation_id=None,
             page_context=None):
    return ToolContext(principal=principal, session_factory=fake_sessions, settings=settings, now=NOW,
                       conversation_id=conversation_id, user_message=message, page_context=page_context or {})


SPEC = tools.TOOLS[0]


async def run(ctx, **args):
    """Through engine.run_tool: the same role, schema and sanitising gate the model and the demo responder use."""
    return await engine.run_tool(SPEC, SPEC.name, args, ctx)


# ---------------------------------------------------------------------------------------------------------------
# Registry gate (D1): flag + accounts mode + Operator
# ---------------------------------------------------------------------------------------------------------------
def names(principal, settings):
    return [spec.name for spec in registry.tools_for(principal, settings)]


def test_tool_is_offered_only_with_the_flag_in_accounts_mode_to_operator_or_admin(monkeypatch):
    monkeypatch.setattr(registry, "TOOL_MODULES", ())
    assert names(OPERATOR, ON) == ["propose_action"]
    assert names(ADMIN, ON) == ["propose_action"]
    assert names(VIEWER, ON) == []
    assert names(LEGACY, ON) == []   # shared-password principal: never
    assert names(OPERATOR, SimpleNamespace(assistant_actions_enabled=False, accounts_enabled=True)) == []
    shared = SimpleNamespace(assistant_actions_enabled=True, accounts_enabled=False, lab_manager_password="x")
    assert names(ADMIN, shared) == [] and names(OPERATOR, shared) == []
    # Fail closed: no settings, missing attributes or truthy non-bool values all mean "off".
    assert names(OPERATOR, None) == [] and registry.tools_for(OPERATOR) == []
    assert names(OPERATOR, SimpleNamespace()) == []
    assert names(OPERATOR, SimpleNamespace(assistant_actions_enabled="true", accounts_enabled=True)) == []
    assert names(OPERATOR, SimpleNamespace(assistant_actions_enabled=True, accounts_enabled=1)) == []
    assert registry.all_tools() == []


def test_read_only_tools_are_unchanged_and_a_broken_action_module_is_skipped(monkeypatch):
    read_only = [spec.name for spec in registry.all_tools()]
    assert "propose_action" not in read_only
    assert [spec.name for spec in registry.all_tools(ON)] == read_only + ["propose_action"]
    assert [spec.name for spec in registry.tools_for(VIEWER, ON)] == [
        spec.name for spec in registry.tools_for(VIEWER, None)]
    broken = types.ModuleType("app.assistant.broken_actions")   # no TOOLS list
    monkeypatch.setitem(sys.modules, "app.assistant.broken_actions", broken)
    monkeypatch.setattr(registry, "ACTION_TOOL_MODULES", ("broken_actions", "actions.not_written_yet"))
    assert [spec.name for spec in registry.all_tools(ON)] == read_only


def test_schema_is_strict_closed_and_lists_every_kind():
    schema = SPEC.input_schema
    assert SPEC.name == "propose_action" and SPEC.required_role == "Operator"
    assert "execute" not in SPEC.name and "confirm" not in SPEC.name
    assert schema["type"] == "object" and schema["additionalProperties"] is False and schema["required"] == ["kind"]
    assert set(schema["properties"]) == {"kind", "server", "pdu", "outlet", "rack", "restore_of", "then_console",
                                         "reason"}
    assert schema["properties"]["kind"]["enum"] == list(KIND_SPECS)
    assert "NEVER executes" in SPEC.description and "at most once per question" in SPEC.description
    (definition,) = engine.tool_definitions([SPEC])
    assert definition["strict"] is True and definition["input_schema"]["additionalProperties"] is False
    dumped = json.dumps(definition["input_schema"])
    for keyword in ("minLength", "maxLength", "\"minimum\"", "\"maximum\""):
        assert keyword not in dumped
    assert engine.validate(schema, {"kind": "server_cycle", "server": "OPT11", "then_console": True}) == []
    for bad in ({}, {"kind": "format_disk"}, {"kind": "server_off", "password": "x"},
                {"kind": "outlet_off", "pdu": "pdu-1", "outlet": 0}, {"kind": "outlet_off", "pdu": "p", "outlet": 65},
                {"kind": "outlet_off", "pdu": "p", "outlet": "3"}, {"kind": "server_off", "server": ""},
                {"kind": "server_off", "server": "x" * 101}, {"kind": "server_off", "then_console": "yes"}):
        assert engine.validate(schema, bad), bad


async def test_invalid_arguments_never_reach_the_store(store):
    ctx = make_ctx()
    outcome = await run(ctx, kind="server_off", server="OPT11", id=INJECTED_ID)
    assert isinstance(outcome, str) and "Invalid arguments" in outcome
    assert store.calls == [] and ctx.proposals == []


async def test_viewer_legacy_flag_off_and_shared_mode_fail_closed_inside_the_tool(store):
    assert "requires the Operator role" in await run(make_ctx(principal=VIEWER), kind="server_off", server="OPT11")
    for ctx in (make_ctx(principal=LEGACY), make_ctx(settings=SimpleNamespace(assistant_actions_enabled=False,
                                                                              accounts_enabled=True)),
                make_ctx(settings=SimpleNamespace(assistant_actions_enabled=True, accounts_enabled=False,
                                                  lab_manager_password="x"))):
        outcome = await run(ctx, kind="server_off", server="OPT11")
        assert isinstance(outcome, str) and "turned off on this server or need accounts mode" in outcome
    assert store.calls == []


async def test_the_role_each_kind_needs_is_checked_before_the_store(store):
    outcome = await run(make_ctx("כבה חשמל לכל המעבדה"), kind="lab_shutdown")
    assert outcome == ("No proposal was prepared (forbidden): lab_shutdown requires the Admin role. "
                       "Details: הפעולה דורשת הרשאת Admin.")
    assert store.calls == []


# ---------------------------------------------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------------------------------------------
async def test_proposes_through_the_store_and_returns_only_server_built_fields(store):
    ctx = make_ctx(conversation_id="c" * 32)
    outcome = await run(ctx, kind="server_cycle", server=" OPT11 ", then_console=True,
                        reason=f"תעשה ריסט\nל-OPT11{RLO} ותפתח KVM")
    assert isinstance(outcome, ToolResult), outcome
    (call,) = store.calls
    assert call.req == ProposalRequest(kind="server_cycle", server="OPT11", then_console=True,
                                       reason="תעשה ריסט ל-OPT11 ותפתח KVM")
    assert (call.principal, call.now, call.conversation_id) == (OPERATOR, NOW, "c" * 32)
    assert call.session_factory is fake_sessions and call.settings is ctx.settings
    proposal_id = outcome.data["proposal"]["id"]
    assert ctx.proposals == [proposal_id] and store.cancelled == []
    assert outcome.data["executed"] is False and "Never say the action was done" in outcome.data["next_step"]
    view = outcome.data["proposal"]
    assert set(view) == {"id", "kind", "title_he", "status", "expires_at", "required_role", "needs_password",
                         "phrase", "can_execute", "impact"}
    assert (view["kind"], view["status"], view["required_role"], view["phrase"]) == ("server_cycle", "pending",
                                                                                     "Operator", None)
    assert view["impact"] == {"counts": {"outlets": 1, "pdus": 1, "servers": 1, "excluded": 2, "consoles": 0},
                              "servers": ["OPT11"],
                              "excluded": {"total": 2, "by_reason": {"protected": 1, "maintenance": 1},
                                           "skipped_pdus": ["PDU-B"]},
                              "warnings_he": ["השרת נמצא בהתקנת PXE."]}
    assert [s.id for s in outcome.sources] == [f"action_proposal:{proposal_id}"]
    envelope = engine.tool_envelope(SPEC.name, outcome)
    for hidden in ("created_by", "operator", "\"request\"", "\"targets\"", "SW1", "can_restore", "\"reason\""):
        assert hidden not in envelope


async def test_restore_of_belongs_to_batch_restore_only_and_empty_text_is_dropped(store):
    ctx = make_ctx("תכניס את pdu-1 לתחזוקה")
    outcome = await run(ctx, kind="pdu_shutdown", pdu="pdu-1", restore_of=INJECTED_ID, rack="  ", reason="")
    assert isinstance(outcome, ToolResult), outcome
    assert store.calls[0].req == ProposalRequest(kind="pdu_shutdown", pdu="pdu-1")


async def test_action_error_becomes_a_tool_error_with_hebrew_details(store):
    store.error = ActionError(409, "ambiguous", "Server name matches several servers",
                              ["OPT11-A (Rack-01)", "OPT11-B (Rack-02)"])
    ctx = make_ctx("כבה את OPT11")
    outcome = await run(ctx, kind="server_off", server="OPT11")
    assert outcome == ("No proposal was prepared (ambiguous): Server name matches several servers. "
                       "Details: OPT11-A (Rack-01); OPT11-B (Rack-02)")
    assert ctx.proposals == [] and tools._slots(ctx) == 0
    store.error = ActionError(409, "protected_unset", "Protected outlets are not configured (POWER_PROTECTED_OUTLETS)")
    outcome = await run(make_ctx("כבה חשמל לכל המעבדה", principal=ADMIN), kind="lab_shutdown")
    assert outcome.startswith("No proposal was prepared (protected_unset): Protected outlets are not configured")


async def test_unexpected_store_failure_is_a_generic_error(store, caplog):
    store.error = RuntimeError("database at 10.1.2.3 password=hunter2")   # never echoed
    outcome = await run(make_ctx("כבה את OPT11"), kind="server_off", server="OPT11")
    assert outcome == engine.TOOL_INTERNAL_ERROR
    assert "hunter2" not in caplog.text and "10.1.2.3" not in caplog.text


async def test_one_proposal_per_question_even_when_called_concurrently(store):
    store.delay = 0.01
    ctx = make_ctx("כבה את OPT1, OPT2 ו-OPT3")
    outcomes = await asyncio.gather(*(run(ctx, kind="server_off", server=f"OPT{n}") for n in (1, 2, 3)))
    assert [isinstance(o, ToolResult) for o in outcomes] == [True, False, False]
    assert all("Only one action proposal can be prepared per question" in o for o in outcomes[1:])
    assert len(store.calls) == 1 and len(ctx.proposals) == 1 and tools._slots(ctx) == 0
    assert (await run(ctx, kind="server_on", server="OPT2")).startswith("Only one action proposal")


async def test_failed_proposals_do_not_use_up_the_question(store):
    ctx = make_ctx("כבה את OPT11")
    store.error = ActionError(404, "not_resolved", "Server was not resolved")
    for _ in range(3):
        assert "not_resolved" in await run(ctx, kind="server_off", server="OPT11")
    store.error = None
    assert isinstance(await run(ctx, kind="server_off", server="OPT11"), ToolResult)


# ---------------------------------------------------------------------------------------------------------------
# Intent anchor (D2)
# ---------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("message, name, expected", [
    ("תעשה ריסט לשרת OPT11 ותפתח KVM", "OPT11", True),
    ("reset opt 11 please", "OPT11", True),
    ("כבה לOPT11", "opt11", True),
    ("כבה את OPT11 (PSU2)", "OPT11", True),
    ("כבה את OPT111", "OPT11", False),
    ("כבה את OPT1", "OPT11", False),
    ("כבה את OPT11", "OPT1", False),
    ("כבה את ארון rack 01", "Rack-01", True),
    ("כבה את ארון rack 1", "Rack-01", False),
    ("כבה את ארון Rack-012", "Rack-01", False),
    ("כבה את OPT11", "", False),
])
def test_mentions_matches_whole_names_only(message, name, expected):
    assert tools.mentions(message, name) is expected


async def test_a_server_the_user_did_not_write_is_refused_before_the_store(store):
    assert isinstance(await run(make_ctx("כבה את OPT12"), kind="server_off", server="OPT12"), ToolResult)
    ctx = make_ctx("למה OPT11 לא מגיב?")   # a name from tool data (labels, notes) is not the user's request
    outcome = await run(ctx, kind="server_off", server="OPT13")
    assert outcome.startswith("No proposal was prepared (not_requested): the server is not named")
    assert "שם השרת לא מופיע בבקשה שלך" in outcome
    assert len(store.calls) == 1 and ctx.proposals == []


async def test_the_viewed_page_anchors_a_server_pdu_or_rack(store):
    ctx = make_ctx("תעשה לו ריסט", page_context={"detail": {"kind": "server", "id": "opt207"}})
    assert isinstance(await run(ctx, kind="server_cycle", server="OPT207"), ToolResult)
    ctx = make_ctx("תכניס לתחזוקה", page_context={"detail": {"kind": "pdu", "id": "pdu-7"}})
    assert isinstance(await run(ctx, kind="pdu_shutdown", pdu="pdu-7"), ToolResult)
    ctx = make_ctx("כבה את כל הארון", principal=ADMIN, page_context={"rack": "Rack-03"})
    assert isinstance(await run(ctx, kind="rack_shutdown", rack="Rack-03"), ToolResult)
    ctx = make_ctx("תעשה לו ריסט", page_context={"detail": {"kind": "pdu", "id": "opt207"}})   # wrong kind
    assert "not_requested" in await run(ctx, kind="server_cycle", server="OPT207")
    assert len(store.calls) == 3


async def test_outlet_needs_the_pdu_and_the_outlet_number_in_the_message(store):
    assert isinstance(await run(make_ctx("כבה שקע 3 ב-pdu-1"), kind="outlet_off", pdu="pdu-1", outlet=3),
                      ToolResult)
    outcome = await run(make_ctx("כבה שקע 13 ב-pdu-1"), kind="outlet_off", pdu="pdu-1", outlet=3)
    assert "outlet number is not written" in outcome
    outcome = await run(make_ctx("כבה שקע 3"), kind="outlet_off", pdu="pdu-1", outlet=3)
    assert "the PDU is not named" in outcome
    assert len(store.calls) == 1


async def test_scope_is_never_wider_than_written(store):
    admin = dict(principal=ADMIN)
    outcome = await run(make_ctx("כבה את OPT11", **admin), kind="rack_shutdown", rack="Rack-01")
    assert "the rack is not named" in outcome and "שם הארון לא מופיע" in outcome
    for message in ("כבה את OPT11", "כבה את המעבדה של OPT11", "lab power off", "כבה את Rack-01"):
        outcome = await run(make_ctx(message, **admin), kind="lab_shutdown")
        assert "lab-wide shutdown needs an explicit lab-wide request" in outcome, message
    assert store.calls == []
    for message in ("כבה חשמל לכל המעבדה", "תוריד מתח לכל  המעבדה", "Whole Lab power off now", "LAB-WIDE shutdown"):
        assert isinstance(await run(make_ctx(message, **admin), kind="lab_shutdown"), ToolResult), message
    assert isinstance(await run(make_ctx("כבה את ארון Rack-01", **admin), kind="rack_shutdown", rack="Rack-01"),
                      ToolResult)


async def test_a_resolved_server_the_user_did_not_write_is_withdrawn(store):
    store.resolved_servers = ["OPT11"]          # "gpu-box" is an alias of OPT11 on the server
    ctx = make_ctx("כבה את gpu-box")
    outcome = await run(ctx, kind="server_off", server="gpu-box")
    assert "resolved to server OPT11, which the user did not write" in outcome
    assert "כתוב את שמו במפורש" in outcome
    assert store.cancelled == list(store.rows) and ctx.proposals == []
    assert tools._slots(ctx) == 0
    store.resolved_servers = ["OPT11", "OPT12"]  # one name must never widen to several servers
    ctx = make_ctx("כבה את OPT11")
    outcome = await run(ctx, kind="server_off", server="OPT11")
    assert "resolved to more than one server" in outcome and len(store.cancelled) == 2 and ctx.proposals == []


# ---------------------------------------------------------------------------------------------------------------
# restore_of = "latest" (ACT-7 sends exactly {"kind": "batch_restore", "restore_of": "latest"})
# ---------------------------------------------------------------------------------------------------------------
async def test_latest_restore_picks_the_newest_restorable_shutdown_of_any_admin(store):
    store.add(ADMIN, "lab_shutdown", created_at=NOW - 300, status="succeeded", restorable=True)
    store.add(ADMIN, "rack_shutdown", created_at=NOW - 100, status="partial", restorable=True)
    newest = store.add(ADMIN2, "lab_shutdown", created_at=NOW - 60, status="succeeded", restorable=True)
    store.add(ADMIN, "rack_shutdown", created_at=NOW - 50, status="pending")                   # not restorable
    store.add(ADMIN, "server_off", created_at=NOW - 40, status="succeeded", restorable=True)   # wrong kind
    ctx = make_ctx("תחזיר חשמל", principal=ADMIN)
    assert isinstance(await run(ctx, kind="batch_restore", restore_of="latest"), ToolResult)
    assert isinstance(await run(make_ctx("תחזיר חשמל", principal=ADMIN), kind="batch_restore", restore_of="LATEST"),
                      ToolResult)
    assert isinstance(await run(make_ctx("תחזיר חשמל", principal=ADMIN), kind="batch_restore"), ToolResult)
    assert [call.req.restore_of for call in store.calls] == [newest.id] * 3


async def test_latest_restore_without_a_candidate_bad_ids_and_operators_are_refused(store):
    ctx = make_ctx("תחזיר חשמל", principal=ADMIN)
    outcome = await run(ctx, kind="batch_restore", restore_of="latest")
    assert outcome.startswith("No proposal was prepared (not_found)") and "לא נמצא כיבוי" in outcome
    outcome = await run(ctx, kind="batch_restore", restore_of="../../etc")
    assert "restore_of must be \"latest\" or a proposal id" in outcome
    assert "requires the Admin role" in await run(make_ctx("תחזיר חשמל"), kind="batch_restore", restore_of="latest")
    assert store.calls == [] and ctx.proposals == []
    assert isinstance(await run(ctx, kind="batch_restore", restore_of=INJECTED_ID), ToolResult)
    assert store.calls[0].req.restore_of == INJECTED_ID   # the store checks the kind and status of an explicit id


# ---------------------------------------------------------------------------------------------------------------
# Engine: an LLM failure falls back to demo with the same ctx; the failed answer's proposals are cancelled first
# ---------------------------------------------------------------------------------------------------------------
class _LlmStream:
    def __init__(self, item):
        self.item = item

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_final_message(self):
        if isinstance(self.item, BaseException):
            raise self.item
        return self.item


class FakeLLM:
    """AsyncAnthropic-like client: plays `script` in order (an exception item is raised by that request)."""

    def __init__(self, script):
        self.script, self.calls = list(script), []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self.stream))

    def stream(self, **params):
        self.calls.append(params)
        return _LlmStream(self.script.pop(0))


ENGINE_ON = SimpleNamespace(assistant_actions_enabled=True, accounts_enabled=True, assistant_timeout_seconds=30)


def llm_proposes_then_fails(monkeypatch, args):
    """A fake LLM that calls propose_action in round 1, then fails on the next request."""
    use = SimpleNamespace(type="tool_use", id="toolu_1", name="propose_action", input=args)
    client = FakeLLM([SimpleNamespace(content=[use], stop_reason="tool_use", model="claude-opus-5-5", usage=None),
                      RuntimeError("stream broke at 10.1.2.3 password=hunter2")])
    monkeypatch.setattr(engine, "llm_status", lambda settings: ("llm", None))
    monkeypatch.setattr(engine, "load_sdk", lambda: SimpleNamespace())
    monkeypatch.setattr(engine, "client_factory", lambda settings, sdk: client)
    return client


async def test_llm_failure_cancels_its_proposal_before_the_demo_fallback(store, monkeypatch):
    from app.assistant.actions import store as store_module   # engine imports it lazily
    monkeypatch.setattr(store_module, "cancel", store.cancel)
    client = llm_proposes_then_fails(monkeypatch, {"kind": "server_off", "server": "OPT11"})
    seen = {}

    async def fallback(*, ctx, tools, **_):   # the demo responder proposes again with the same ctx
        seen["at_start"] = list(ctx.proposals)
        seen["outcome"] = await engine.run_tool(tools[0], "propose_action", {"kind": "server_off", "server": "OPT11"},
                                                ctx)
        return {"mode": "demo", "answer": empty_answer("מצב הדגמה"), "ledger": [], "usage": None,
                "demo_reason": "llm_error"}

    monkeypatch.setattr(demo, "answer", fallback)
    ctx = make_ctx("כבה את OPT11", settings=ENGINE_ON)
    result = await engine.answer_question(question="כבה את OPT11", history=[], context={}, ctx=ctx, tools=[SPEC])
    assert result["mode"] == "demo" and len(client.calls) == 2
    llm_id, demo_id = list(store.rows)          # the LLM's proposal, then the fallback's
    assert len(store.calls) == 2
    assert store.cancelled == [llm_id] and store.rows[llm_id].status == "cancelled"
    assert seen["at_start"] == [] and isinstance(seen["outcome"], ToolResult)
    assert ctx.proposals == [demo_id] and store.rows[demo_id].status == "pending"   # exactly one pending


async def test_cancel_failure_during_the_fallback_is_logged_by_class_only(store, monkeypatch, caplog):
    from app.assistant.actions import store as store_module

    async def broken_cancel(db, principal, proposal_id, now):
        raise RuntimeError("database at 10.9.9.9 password=hunter2")

    monkeypatch.setattr(store_module, "cancel", broken_cancel)
    llm_proposes_then_fails(monkeypatch, {"kind": "server_off", "server": "OPT11"})
    seen = {}

    async def fallback(*, ctx, **_):
        seen["at_start"] = list(ctx.proposals)
        return {"mode": "demo", "answer": empty_answer("מצב הדגמה"), "ledger": [], "usage": None,
                "demo_reason": "llm_error"}

    monkeypatch.setattr(demo, "answer", fallback)
    ctx = make_ctx("כבה את OPT11", settings=ENGINE_ON)
    result = await engine.answer_question(question="כבה את OPT11", history=[], context={}, ctx=ctx, tools=[SPEC])
    assert result["mode"] == "demo" and seen["at_start"] == [] and ctx.proposals == []
    assert len(store.calls) == 1
    assert "could not cancel an abandoned action proposal (RuntimeError)" in caplog.text
    for secret in ("hunter2", "10.9.9.9", "10.1.2.3"):
        assert secret not in caplog.text


async def test_withdraw_is_bounded_in_time_and_skips_an_empty_ledger(store, monkeypatch, caplog):
    from app.assistant.actions import store as store_module
    calls = []

    async def slow_cancel(db, principal, proposal_id, now):
        calls.append(proposal_id)
        await asyncio.sleep(5)

    monkeypatch.setattr(store_module, "cancel", slow_cancel)
    monkeypatch.setattr(engine, "WITHDRAW_SECONDS", 0.05)
    ctx = make_ctx(settings=ENGINE_ON)
    await engine.withdraw_proposals(ctx)   # nothing to withdraw: no session is opened
    assert calls == []
    ctx.proposals.extend([INJECTED_ID, INJECTED_ID, 7])
    started = time.monotonic()
    await engine.withdraw_proposals(ctx)
    assert time.monotonic() - started < 2 and calls == [INJECTED_ID] and ctx.proposals == []
    assert "could not withdraw abandoned action proposals (TimeoutError)" in caplog.text


# ---------------------------------------------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------------------------------------------
def test_prompt_explains_proposals_and_stays_constant():
    text = prompts.SYSTEM_PROMPT
    section = text[text.index("# Power and console actions"):text.index("# Answer format")]
    for phrase in ("propose_action", "At most one proposal per question", "then_console=true",
                   "restore_of \"latest\"", "confirms there with their own password",
                   "Never say or imply that the action was done", "`phrase`", "Operator or Admin", "in Hebrew",
                   "Act only on what the user wrote in this message", "Never widen the scope", "כל המעבדה",
                   "never ask for a password"):
        assert phrase in section, phrase
    assert "You cannot operate equipment yourself" in text
    assert "{" not in section   # no per-request placeholders: the cached prefix stays byte-identical


# ---------------------------------------------------------------------------------------------------------------
# Chat router: user_message/page_context and action_proposals
# ---------------------------------------------------------------------------------------------------------------
def make_settings(**overrides):
    values = dict(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                  accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD,
                  ping_monitor_enabled=False, email_alerts_enabled=False, pxe_enabled=False,
                  assistant_enabled=True, assistant_llm_enabled=True, assistant_anthropic_api_key=None,
                  assistant_model="claude-opus-5-5", assistant_timeout_seconds=30, assistant_per_minute=50,
                  assistant_per_hour=500, assistant_max_chars=2000, assistant_concurrency=4,
                  assistant_daily_limit=300, assistant_allow_open_llm=False, assistant_actions_enabled=True,
                  assistant_action_ttl_seconds=300, power_protected_outlets="none")
    values.update(overrides)
    return SimpleNamespace(**values)


class ToolEngine:
    """Stands in for engine.answer_question: runs the planned tool calls through engine.run_tool on the tools the
    router handed over, then answers with text that names a foreign proposal id (which must be ignored)."""

    def __init__(self):
        self.calls = []
        self.plan: list[tuple[str, dict]] = []
        self.outcomes = []
        self.tamper = None

    async def __call__(self, *, question, history, context, ctx, tools, mode=None, demo_reason=None):
        self.calls.append(SimpleNamespace(ctx=ctx, tools=[t.name for t in tools]))
        by_name = {t.name: t for t in tools}
        for name, args in self.plan:
            self.outcomes.append(await engine.run_tool(by_name.get(name), name, args, ctx))
        if self.tamper:
            self.tamper(ctx)
        answer = empty_answer(f"הוכנה הצעה {INJECTED_ID}. יש לאשר בכרטיס עם הסיסמה.")
        answer["entity_refs"] = [{"kind": "server", "id": INJECTED_ID, "label": INJECTED_ID}]
        return {"mode": "demo", "answer": answer, "ledger": [], "usage": None, "demo_reason": "no_api_key",
                "action_proposals": [{"id": INJECTED_ID, "status": "succeeded"}], "proposals": [INJECTED_ID]}


@pytest.fixture
async def chat_env(tmp_path, monkeypatch):
    db_engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'assistant-actions.db'}")
    async with db_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(db_engine, expire_on_commit=False)
    settings = make_settings()
    fake_engine = ToolEngine()
    fake_store = FakeStore()
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(assistant, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(assistant, "get_settings", lambda: settings)
    monkeypatch.setattr(assistant, "_load_engine", lambda: fake_engine)
    monkeypatch.setattr(assistant, "_anthropic_available", lambda: True)
    monkeypatch.setattr(assistant, "_action_store", lambda: fake_store)
    monkeypatch.setattr(tools, "store", fake_store)
    monkeypatch.setattr(registry, "TOOL_MODULES", ())   # only the action tool: keeps the test about it
    monkeypatch.setattr(ratelimit, "gate", ratelimit.Gate())
    password_hash = accounts.hash_password(PASSWORD)
    async with sessions() as db:
        for user_id, role in (("viewer", "Viewer"), ("operator", "Operator"), ("operator2", "Operator"),
                              ("boss", "Admin")):
            db.add(User(id=user_id, username=user_id, name=user_id, role=role, password_hash=password_hash,
                        created_at=time.time()))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(assistant.router)
    yield SimpleNamespace(app=app, sessions=sessions, settings=settings, engine=fake_engine, store=fake_store,
                          monkeypatch=monkeypatch)
    await db_engine.dispose()


def http(env):
    return AsyncClient(transport=ASGITransport(app=env.app), base_url="http://test")


async def sign_in(c, username):
    r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]


async def ask(c, message="תעשה ריסט לשרת OPT11 ותפתח KVM", **extra):
    return await c.post("/api/assistant/chat", json={"message": message, **extra})


async def test_chat_returns_the_proposal_created_in_this_request_only(chat_env):
    chat_env.engine.plan = [("propose_action", {"kind": "server_cycle", "server": "OPT11", "then_console": True})]
    async with http(chat_env) as c:
        await sign_in(c, "operator")
        r = await ask(c, context={"tab": "racks", "rack": "Rack-03", "detail": {"kind": "server", "id": "opt207"}})
        assert r.status_code == 200, r.text
        data = r.json()
        call = chat_env.engine.calls[0]
        assert call.tools == ["propose_action"] and call.ctx.conversation_id is None
        assert call.ctx.user_message == "תעשה ריסט לשרת OPT11 ותפתח KVM"
        assert call.ctx.page_context == {"tab": "racks", "rack": "Rack-03", "detail": {"kind": "server", "id": "opt207"}}
        (proposal,) = data["action_proposals"]
        assert proposal["id"] == call.ctx.proposals[0] and proposal["id"] != INJECTED_ID
        assert proposal["kind"] == "server_cycle" and proposal["status"] == "pending"
        assert chat_env.store.calls[0].req.then_console is True

        # Follow-up in the same conversation: the anchor is this turn's text, the conversation id reaches the store.
        chat_env.engine.plan = [("propose_action", {"kind": "server_on", "server": "OPT11"})]
        r = await ask(c, "ותדליק אותו", conversation_id=data["conversation_id"])
        assert r.status_code == 200 and r.json()["action_proposals"] == []
        assert "not_requested" in chat_env.engine.outcomes[-1]
        chat_env.engine.plan = [("propose_action", {"kind": "server_on", "server": "OPT12"})]
        r = await ask(c, "ותדליק את OPT12", conversation_id=data["conversation_id"])
        assert r.status_code == 200, r.text
        assert chat_env.store.calls[-1].conversation_id == data["conversation_id"]
        assert [p["kind"] for p in r.json()["action_proposals"]] == ["server_on"]

        # No proposal in this request: an empty list, never the earlier ones.
        chat_env.engine.plan = []
        r = await ask(c, "מה המצב?", conversation_id=data["conversation_id"])
        assert r.status_code == 200 and r.json()["action_proposals"] == []


async def test_ids_planted_in_the_tool_context_still_pass_the_owner_check(chat_env):
    foreign = chat_env.store.add(Principal("operator2", "operator2", "Operator"), "lab_shutdown")
    own_old = chat_env.store.add(Principal("operator", "operator", "Operator"), "server_off")

    def tamper(ctx):   # a buggy engine or demo path writing ids it did not create
        ctx.proposals.extend([foreign.id, INJECTED_ID, 42])

    chat_env.engine.tamper = tamper
    async with http(chat_env) as c:
        await sign_in(c, "operator")
        r = await ask(c, "כבה את המעבדה")
        assert r.status_code == 200, r.text
        assert r.json()["action_proposals"] == []
        chat_env.engine.tamper = lambda ctx: ctx.proposals.extend([own_old.id, own_old.id])
        r = await ask(c, "כבה את OPT11")
        assert [p["id"] for p in r.json()["action_proposals"]] == [own_old.id]


async def test_viewer_shared_mode_and_flag_off_get_no_tool_and_no_proposals(chat_env):
    chat_env.engine.plan = [("propose_action", {"kind": "server_off", "server": "OPT11"})]
    async with http(chat_env) as c:
        await sign_in(c, "viewer")
        r = await ask(c, "כבה את OPT11")
        assert r.status_code == 200, r.text
        assert chat_env.engine.calls[-1].tools == [] and r.json()["action_proposals"] == []
        assert "not permitted" in chat_env.engine.outcomes[-1]
    chat_env.monkeypatch.setattr(chat_env.settings, "assistant_actions_enabled", False)
    chat_env.engine.tamper = lambda ctx: ctx.proposals.append(
        chat_env.store.add(Principal("operator", "operator", "Operator"), "server_off").id)
    async with http(chat_env) as c:
        await sign_in(c, "operator")
        r = await ask(c, "כבה את OPT11")
        assert r.status_code == 200, r.text
        assert chat_env.engine.calls[-1].tools == [] and r.json()["action_proposals"] == []
    assert chat_env.store.calls == []


async def test_store_failure_while_loading_keeps_the_answer(chat_env, caplog):
    chat_env.engine.plan = [("propose_action", {"kind": "server_off", "server": "OPT11"})]

    async def broken(db, principal, proposal_id):
        raise RuntimeError("secret detail password=hunter2")

    chat_env.monkeypatch.setattr(chat_env.store, "get_for", broken)
    async with http(chat_env) as c:
        await sign_in(c, "operator")
        r = await ask(c, "כבה את OPT11")
    assert r.status_code == 200 and r.json()["action_proposals"] == []
    assert "hunter2" not in caplog.text and "RuntimeError" in caplog.text


# ---------------------------------------------------------------------------------------------------------------
# Integration with the real store (ACT-5): only resolve.build_impact is faked.
# ---------------------------------------------------------------------------------------------------------------
async def test_real_store_round_trip_through_the_chat(chat_env, monkeypatch):
    from app.assistant import actions as actions_package
    real_store = pytest.importorskip("app.assistant.actions.store")
    from app.assistant.actions.models import AssistantActionProposal

    async def build_impact(db, req, settings, now):
        return Impact(targets=[Target("pdu-1", "PDU-A", "Rack-01", 3, "OPT11", "OPT11", "on")], pdus=["pdu-1"],
                      servers=["OPT11"], pins={"pdu-1": {"labels_rev": "r1", "ip": "10.9.8.7", "enabled": True,
                                                         "maintenance": False, "on": [3], "known": [3]}})

    fake_resolve = types.ModuleType("app.assistant.actions.resolve")
    fake_resolve.build_impact = build_impact
    monkeypatch.setitem(sys.modules, "app.assistant.actions.resolve", fake_resolve)
    monkeypatch.setattr(actions_package, "resolve", fake_resolve, raising=False)
    monkeypatch.setattr(tools, "store", real_store)
    monkeypatch.setattr(assistant, "_action_store", lambda: real_store)
    chat_env.engine.plan = [("propose_action", {"kind": "server_cycle", "server": "OPT11", "then_console": True,
                                                "reason": "ריסט ל-OPT11"})]
    async with http(chat_env) as c:
        await sign_in(c, "operator")
        r = await ask(c)
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(chat_env.engine.outcomes[-1], ToolResult), chat_env.engine.outcomes[-1]
        envelope = engine.tool_envelope("propose_action", chat_env.engine.outcomes[-1])
        (proposal,) = data["action_proposals"]
        assert proposal["kind"] == "server_cycle" and proposal["status"] == "pending"
        assert proposal["can_execute"] is True and "pins" not in proposal["impact"]
        assert "reason" not in proposal["request"]
        assert "10.9.8.7" not in r.text and "10.9.8.7" not in envelope
        assert "created_by" not in envelope and "\"operator\"" not in envelope
        r2 = await ask(c, "ותעשה שוב ריסט ל-OPT11", conversation_id=data["conversation_id"])
        assert r2.status_code == 200, r2.text
        assert len(r2.json()["action_proposals"]) == 1
    async with chat_env.sessions() as db:
        rows = (await db.scalars(select(AssistantActionProposal).order_by(AssistantActionProposal.created_at))).all()
    assert [row.conversation_id for row in rows] == [None, data["conversation_id"]]
    assert all(row.owner_key == "operator" for row in rows)
