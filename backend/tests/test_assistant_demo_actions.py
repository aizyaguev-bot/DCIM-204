"""Demo action routing through fake tools only; no LLM, database or device traffic."""
import copy
import json
from types import SimpleNamespace

import pytest

from app.assistant import demo
from app.assistant.contracts import Principal, Source, ToolContext, ToolError, ToolResult, ToolSpec


@pytest.fixture
def action_demo():
    calls = []
    proposal = {
        "id": "demo-proposal", "status": "pending", "needs_password": True,
        "impact": {"counts": {"servers": 3, "pdus": 2, "outlets": 6, "excluded": 4}},
    }
    ctx = ToolContext(Principal("admin-id", "admin", "Admin"), None,
                      SimpleNamespace(ping_monitor_timezone="UTC", accounts_enabled=True,
                                      assistant_actions_enabled=True), now=1_792_300_000)

    async def propose_action(ctx, **request):
        calls.append(request)
        ctx.proposals.append(proposal["id"])
        return ToolResult({"proposal": copy.deepcopy(proposal)},
                          [Source("assistant_action:demo-proposal", "Action proposal")])

    properties = {key: {"type": "string"} for key in ("kind", "server", "pdu", "rack", "restore_of", "reason")}
    properties.update({"outlet": {"type": "integer"}, "then_console": {"type": "boolean"}})
    tool = ToolSpec("propose_action", "Prepare a proposal only.",
                    {"type": "object", "properties": properties, "required": ["kind"],
                     "additionalProperties": False}, "Operator", propose_action)

    async def ask(question, *, tools=None, context=None):
        return await demo.answer(question=question, history=[], context=context, ctx=ctx,
                                 tools=[tool] if tools is None else tools, reason="no_api_key")

    return SimpleNamespace(ask=ask, calls=calls, ctx=ctx, tool=tool, proposal=proposal)


@pytest.mark.parametrize("question,expected", [
    ("כבה חשמל לכל המעבדה", {"kind": "lab_shutdown"}),
    ("תוריד מתח לכל המעבדה", {"kind": "lab_shutdown"}),
    ("lab-wide power off", {"kind": "lab_shutdown"}),
    ("ENTIRE LAB POWER OFF", {"kind": "lab_shutdown"}),
    ("Please power off the whole lab", {"kind": "lab_shutdown"}),
    ("power off all the lab", {"kind": "lab_shutdown"}),
    ("כבה את ארון Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}),
    ("power off rack Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}),
    ("כבה את Rack-01", {"kind": "rack_shutdown", "rack": "Rack-01"}),
    ("תעשה ריסט לשרת OPT11 ותפתח KVM", {"kind": "server_cycle", "server": "OPT11", "then_console": True}),
    ("reset OPT11 and open kvm", {"kind": "server_cycle", "server": "OPT11", "then_console": True}),
    ("ReSeT opt 11 and OPEN KVM", {"kind": "server_cycle", "server": "OPT11", "then_console": True}),
    ("כבה את OPT11", {"kind": "server_off", "server": "OPT11"}),
    ("בבקשה כבה את opt 11", {"kind": "server_off", "server": "OPT11"}),
    ("power off OPT11", {"kind": "server_off", "server": "OPT11"}),
    ("turn off server zeus", {"kind": "server_off", "server": "zeus"}),
    ("reset zeus and open KVM for zeus", {"kind": "server_cycle", "server": "zeus", "then_console": True}),
    ("תדליק את OPT11", {"kind": "server_on", "server": "OPT11"}),
    ("turn on OPT11", {"kind": "server_on", "server": "OPT11"}),
    ("Please switch on opt 11", {"kind": "server_on", "server": "OPT11"}),
    ("reset OPT11", {"kind": "server_cycle", "server": "OPT11"}),
    ("reset opt 11.", {"kind": "server_cycle", "server": "OPT11"}),
    ("אתחל את שרת OPT11", {"kind": "server_cycle", "server": "OPT11"}),
    ("תפתח לי KVM של OPT11", {"kind": "open_console", "server": "OPT11"}),
    ("open KVM for opt 11", {"kind": "open_console", "server": "OPT11"}),
    ("תחזיר חשמל", {"kind": "batch_restore", "restore_of": "latest"}),
    ("החזר את המעבדה", {"kind": "batch_restore", "restore_of": "latest"}),
    ("restore lab power", {"kind": "batch_restore", "restore_of": "latest"}),
    ("תכניס את pdu-rack01 לתחזוקה", {"kind": "pdu_shutdown", "pdu": "pdu-rack01"}),
    ("put PDU-RACK01 into maintenance", {"kind": "pdu_shutdown", "pdu": "PDU-RACK01"}),
])
async def test_commands_call_the_same_proposal_tool(action_demo, question, expected):
    result = await action_demo.ask(question)
    assert action_demo.calls == [expected]
    assert action_demo.ctx.proposals == ["demo-proposal"]
    summary = result["answer"]["summary"]
    assert result["mode"] == "demo" and summary.startswith(demo.DEMO_PREFIX)
    assert "הוכנה הצע" in summary
    assert "כרטיס" in summary
    assert "3 שרתים" in summary and "2 PDU" in summary and "6 שקעים" in summary and "4 החרגות" in summary
    if expected["kind"] != "open_console":
        assert "סיסמה" in summary
    assert result["ledger"][0].id == "assistant_action:demo-proposal"
    assert result["answer"]["facts"][0]["source_ids"] == ["assistant_action:demo-proposal"]
    assert not any(claim in summary for claim in ("בוצעה", "בוצע בהצלחה", "החשמל כובה", "השרת אותחל", "הקונסול נפתח"))


@pytest.mark.parametrize("question", [
    "כבה", "כבה את השרת", "כבה את הארון", "reset and open KVM", "open KVM",
    "reset OPT11 and OPT12", "כבה את OPT11 או OPT12", "כבה את opt 11 ואת OPT12",
    "כבה את OPT11 ותדליק את OPT12", "כבה ותדליק את OPT11", "reset OPT11 and power off OPT11",
    "כבה את ארון Rack-01 ואת Rack-02", "כבה את OPT11 בארון Rack-01", "כבה חשמל לכל המעבדה חוץ מ-OPT11",
    "כבה את OPT11 בלי OPT12", "reset rack Rack-01", "תכניס את השרת לתחזוקה",
    "תכניס את OPT11 לתחזוקה", "כבה את pdu-rack01", "open OPT11", "restore power to OPT11",
    "כבה את המעבדה חוץ מהשרת", "כבה את OPT11 אם הוא תקוע", "power off some lab servers",
    "reset OPT11 or open KVM", "open KVM for OPT11 then reset OPT11", "turn off server zeus and odin",
    "כבה את השרת של המעבדה", "power off the lab server", "reset server zeus and open KVM for odin",
    "reset OPT11 and open KVM for odin", "reset OPT11/OPT12",
    "power off server Rack-01", "כבה שרת Rack-01", "כבה את המעבדה", "lab power off", "LAB POWER OFF",
    "כבה את OPT11 בתנאי שהוא תקוע", "כבה את OPT11 כשהוא תקוע",
    "תעשה ריסט לשרת OPT11 ותפתח KVM של זאוס", "reset OPT11 12", "כבה את OPT11 ושרת 12",
])
async def test_ambiguous_actions_ask_without_proposing_even_with_viewed_context(action_demo, question):
    result = await action_demo.ask(question, context={"detail": {"kind": "server", "id": "OPT99"}, "rack": "Rack-99"})
    assert action_demo.calls == [] and action_demo.ctx.proposals == []
    summary = result["answer"]["summary"]
    assert "?" in summary and any("א" <= c <= "ת" for c in summary)
    assert "הוכנה הצע" not in summary


@pytest.mark.parametrize("question", ["כבה חשמל לכל המעבדה", "reset OPT11", "open KVM OPT11", "תחזיר חשמל"])
@pytest.mark.parametrize("role", ["Viewer", "Operator", "Admin"])
async def test_missing_tool_explains_flag_or_operator_requirement_in_hebrew(action_demo, question, role):
    action_demo.ctx.principal = Principal("user-id", "user", role)
    result = await action_demo.ask(question, tools=[])
    summary = result["answer"]["summary"]
    assert "כבויות" in summary and "Operator" in summary
    assert action_demo.calls == [] and action_demo.ctx.proposals == []
    assert "הוכנה הצע" not in summary


async def test_viewer_cannot_use_an_unfiltered_action_tool(action_demo):
    action_demo.ctx.principal = Principal("viewer-id", "viewer", "Viewer")
    result = await action_demo.ask("כבה את OPT11")
    assert action_demo.calls == [] and "Operator" in result["answer"]["summary"]


@pytest.mark.parametrize("accounts_enabled,legacy", [(False, False), (False, True), (True, True), (None, False)])
async def test_accounts_mode_is_required_even_with_a_tool(action_demo, accounts_enabled, legacy):
    if accounts_enabled is None:
        del action_demo.ctx.settings.accounts_enabled
    else:
        action_demo.ctx.settings.accounts_enabled = accounts_enabled
    action_demo.ctx.principal = Principal(None, "shared-user", "Admin", legacy=legacy)
    result = await action_demo.ask("כבה את OPT11")
    assert action_demo.calls == [] and action_demo.ctx.proposals == []
    assert "חשבונות משתמשים" in result["answer"]["summary"]


@pytest.mark.parametrize("enabled", [False, None])
async def test_flag_is_checked_with_missing_simple_namespace_settings(action_demo, enabled):
    if enabled is None:
        del action_demo.ctx.settings.assistant_actions_enabled
    else:
        action_demo.ctx.settings.assistant_actions_enabled = enabled
    result = await action_demo.ask("reset OPT11")
    assert action_demo.calls == [] and "כבויות" in result["answer"]["summary"]


@pytest.mark.parametrize("question", [
    "למה opt11 כבה?", "אל תכבה את opt12, רק את opt11", "מה יקרה אם אכבה את rack 3?",
    "כבה את OPT11?", "reset OPT11?", "כבה את OPT11 אם הוא תקוע", "what if I reset OPT11",
    "don't reset OPT11", "reset OPT11 not OPT12", "Could you switch on opt 11?",
    "do not reset OPT11", "כבה את OPT11 או את OPT12", "can you power off OPT11",
])
async def test_security_act_19_requires_an_unqualified_command(action_demo, question):
    result = await action_demo.ask(question, context={"rack": "Rack-99", "detail": {"kind": "server", "id": "OPT99"}})
    assert action_demo.calls == [] and action_demo.ctx.proposals == []
    summary = result["answer"]["summary"]
    assert "כדי לפעול, כתוב" in summary and "השקעים וההחרגות" in summary
    assert "הוכנה הצע" not in summary


@pytest.mark.parametrize("question", [
    "למה OPT11 כבוי?", "מה המצב של OPT11?", "האם הכיבוי של OPT11 קרה בעבר?",
    "מה יקרה אם נכבה את כל המעבדה?", "אל תכבה את OPT11", "do not reset OPT11",
    "why did OPT11 reset?", "show history of open KVM for OPT11", "הכן טיוטת עבודה לתחזוקה",
    "אפשר להוסיף שרת 800W לארון Rack-01?",
])
async def test_read_only_questions_and_negations_do_not_propose(action_demo, question):
    result = await action_demo.ask(question)
    assert action_demo.calls == [] and action_demo.ctx.proposals == []
    assert "הוכנה הצע" not in result["answer"]["summary"]


async def test_open_console_ready_is_a_click_without_password_or_power_claim(action_demo):
    action_demo.proposal.update(status="ready", needs_password=False)
    result = await action_demo.ask("תפתח לי KVM של OPT11")
    summary = result["answer"]["summary"]
    assert "בלחיצה" in summary and "סיסמה" not in summary
    assert "נפתח" not in summary and "אשר" not in summary


async def test_background_shutdown_requires_phrase_and_password_in_card(action_demo):
    action_demo.proposal["phrase"] = "LAB OFF"
    result = await action_demo.ask("כבה חשמל לכל המעבדה")
    assert "צירוף האישור" in result["answer"]["summary"]
    assert "סיסמה" in result["answer"]["summary"]


@pytest.mark.parametrize("data", [
    {}, {"code": "forbidden"}, {"proposal": {"id": "bad", "status": "succeeded"}},
    {"error": {"code": "ambiguous", "details": ["OPT11", "OPT12"]}},
])
async def test_tool_error_never_claims_a_proposal_or_execution(action_demo, data):
    async def invalid(ctx, **request):
        return ToolResult(data)

    tool = ToolSpec("propose_action", "Fake error", action_demo.tool.input_schema, "Operator", invalid)
    result = await action_demo.ask("כבה את OPT11", tools=[tool])
    summary = result["answer"]["summary"]
    assert "הוכנה הצע" not in summary and "בוצעה" not in summary
    if data.get("error"):
        assert "?" in summary


async def test_tool_exception_is_not_echoed_and_does_not_claim_success(action_demo):
    async def denied(ctx, **request):
        raise ToolError("Action proposal is unavailable.")

    tool = ToolSpec("propose_action", "Fake denial", action_demo.tool.input_schema, "Operator", denied)
    result = await action_demo.ask("כבה את OPT11", tools=[tool])
    assert "לא ניתן" in result["answer"]["summary"]
    assert "?" in result["answer"]["summary"]
    assert "הוכנה הצע" not in result["answer"]["summary"]


async def test_direct_public_proposal_and_missing_counts_are_handled(action_demo):
    async def direct(ctx, **request):
        return ToolResult({"id": "proposal", "status": "pending", "impact": {}})

    tool = ToolSpec("propose_action", "Direct result", action_demo.tool.input_schema, "Operator", direct)
    result = await action_demo.ask("reset OPT11", tools=[tool])
    assert "הוכנה הצע" in result["answer"]["summary"]
    assert "0 שקעים" not in result["answer"]["summary"]
    assert any("ספירת ההשפעה חסרה" in note for note in result["answer"]["missing_data"])


async def test_impact_counts_fall_back_to_actual_lists_without_inventing_servers(action_demo):
    action_demo.proposal["impact"] = {"targets": [{}, {}], "pdus": ["pdu-id"], "excluded": []}
    result = await action_demo.ask("כבה את OPT11")
    summary = result["answer"]["summary"]
    assert "2 שקעים" in summary and "1 PDU" in summary and "0 החרגות" in summary
    assert "שרתים" not in summary


async def test_explicit_target_wins_over_screen_and_history_is_not_used_for_restore(action_demo):
    context = {"detail": {"kind": "server", "id": "OPT99"}, "rack": "Rack-99"}
    await action_demo.ask("reset OPT11 and open KVM", context=context)
    assert action_demo.calls == [{"kind": "server_cycle", "server": "OPT11", "then_console": True}]
    assert "מהמסך" not in (await action_demo.ask("תחזיר חשמל", context=context))["answer"]["summary"]
    assert action_demo.calls[-1] == {"kind": "batch_restore", "restore_of": "latest"}


async def test_proposal_result_secrets_are_redacted_by_the_shared_tool_path(action_demo):
    secret = "a-fake-secret-value"

    async def with_secret(ctx, **request):
        return ToolResult({"proposal": copy.deepcopy(action_demo.proposal), "password": secret},
                          [Source("proposal-source", "Action proposal", note="password=" + secret)])

    tool = ToolSpec("propose_action", "Fake redaction", action_demo.tool.input_schema, "Operator", with_secret)
    result = await action_demo.ask("reset OPT11", tools=[tool])
    serializable = {**result, "ledger": [source.to_dict() for source in result["ledger"]]}
    assert secret not in json.dumps(serializable, ensure_ascii=False)
