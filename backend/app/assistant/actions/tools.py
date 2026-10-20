"""Model tool `propose_action` (ACT-6): prepares an action proposal; it never executes anything.

The tool stores a short-lived, owner-bound proposal through store.propose (targets resolved and the involved PDUs
read live by resolve.build_impact). Only POST /api/assistant/actions/proposals/{id}/execute runs a proposal, after
the signed-in user re-enters their password in the proposal card. The new id is appended to `ctx.proposals`; the
chat router returns the public JSON of exactly those ids (owner-checked) as `action_proposals`, so an id written by
the model in its answer text never reaches the card.

Offered only when ASSISTANT_ACTIONS_ENABLED is true, the site runs in accounts mode (ORCA-SEC-ACTIONS D1) and the
user is an Operator or Admin (registry.py). The tool re-checks the flag, the mode and the role each kind needs; the
store repeats them. Intent anchor (D2): the target must be named in this turn's own user message (or be the page the
user is viewing), a lab-wide shutdown needs an explicit lab-wide phrase, the scope is never wider than written, and
at most one proposal is prepared per question. The demo responder (demo.py) calls the same tool, so the same rules
apply to it.
"""
from __future__ import annotations

import logging
import re
import time

from ... import confirm
from ..contracts import Source, ToolContext, ToolError, ToolResult, ToolSpec, iso
from . import store
from .contracts import KIND_SPECS, ActionError, ProposalRequest

log = logging.getLogger(__name__)

MAX_PROPOSALS_PER_REQUEST = 1   # ORCA-SEC-ACTIONS D2 / SEC-ACT-14: one proposal per question
# D2: a lab-wide shutdown is proposed only when this turn's user message contains one of these (case-insensitive).
LAB_WIDE_PHRASES = ("כל המעבדה", "כל המעבדות", "lab-wide", "whole lab", "entire lab", "all the lab")
LATEST = "latest"
RESTORABLE_KINDS = ("rack_shutdown", "lab_shutdown")
TEXT_CHARS = 100
REASON_CHARS = 200
MAX_DETAILS = 8
DETAIL_CHARS = 120
LIST_CAP = 50
# Control characters, LRM/RLM and bidi embeddings/overrides/isolates: removed from the free-text reason.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]")
_PROPOSAL_ID = re.compile(r"[0-9a-f]{32}")
# Latin/digit runs of a message; runs joined only by spaces or - _ . : / form one chunk ("opt 11", "Rack-01").
_CHUNK = re.compile(r"[0-9a-z]+(?:[\s._:/-]+[0-9a-z]+)*")
_CHUNK_SEP = re.compile(r"[\s._:/-]+")
_FEED_SUFFIX = re.compile(r"\s*\([^)]*\)\s*$")   # "OPT11 (PSU2)" names the server OPT11
# In-flight reservations on the ToolContext: the engine runs the tool calls of one turn concurrently, so the
# per-request cap is reserved synchronously (before the first await) instead of counted after the fact.
_SLOTS_ATTR = "_action_proposal_slots"

NEXT_STEP = ("Nothing was executed. The proposal card is shown to the user under your answer. Tell the user in "
             "Hebrew what the proposal will do (the impact counts, servers, excluded outlets and warnings), that "
             "nothing happens until they review it and confirm in the card with their own password, and, when "
             "`phrase` is set, that they must type that exact phrase in the card. Never say the action was done.")


def actions_enabled(settings) -> bool:
    """ASSISTANT_ACTIONS_ENABLED and accounts mode (D1), read with getattr. Fail closed: anything but a real True
    flag in accounts mode (missing attributes, None settings, an unreadable object) is off."""
    try:
        return (getattr(settings, "assistant_actions_enabled", False) is True
                and getattr(settings, "accounts_enabled", False) is True
                and confirm.password_mode(settings) == "account")
    except Exception:  # noqa: BLE001 - an unreadable settings object means "off"
        return False


def _slots(ctx: ToolContext) -> int:
    return int(getattr(ctx, _SLOTS_ATTR, 0) or 0)


def _text(value) -> str | None:
    if value is None:
        return None
    text = value.strip() if isinstance(value, str) else value
    return text or None


def _reason(value) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", _CONTROL.sub(" ", value)).strip()[:REASON_CHARS]


def _error_text(exc: ActionError) -> str:
    """English message for the model plus the Hebrew details (candidate names, drift reasons) as data."""
    message = str(exc.message or "The action could not be proposed").rstrip(".")
    text = f"No proposal was prepared ({exc.code}): {message}."
    details = [_reason(item)[:DETAIL_CHARS] for item in exc.details[:MAX_DETAILS] if isinstance(item, str)]
    details = [item for item in details if item]
    if details:
        text += " Details: " + "; ".join(details)
    return text


# ---------------------------------------------------------------------------------------------------------------
# Intent anchor (ORCA-SEC-ACTIONS D2). Only this turn's user text and the router-validated page context count; tool
# results, conversation history and the model's own words never widen what the user asked for.
# ---------------------------------------------------------------------------------------------------------------
def _squash(value) -> str:
    return re.sub(r"[^0-9a-z]", "", str(value or "").casefold())


def mentions(message, name) -> bool:
    """True when `name` (its letters and digits, case-insensitive) is written in `message` as whole words: "OPT11"
    matches "opt11", "opt 11" and "לOPT11" but not "opt111"; "Rack-01" matches "rack 01" but not "rack 1"."""
    target = _squash(name)
    if not target or not isinstance(message, str):
        return False
    for chunk in _CHUNK.finditer(message.casefold()):
        parts = [part for part in _CHUNK_SEP.split(chunk.group(0)) if part]
        for start in range(len(parts)):
            joined = ""
            for part in parts[start:]:
                joined += part
                if joined == target:
                    return True
                if len(joined) >= len(target):
                    break
    return False


def _context_is(ctx: ToolContext, kinds: tuple[str, ...], name) -> bool:
    """The validated page context of this turn names this entity (detail {kind, id}, or the rack)."""
    context = getattr(ctx, "page_context", None)
    context = context if isinstance(context, dict) else {}
    target = _squash(name)
    if not target:
        return False
    detail = context.get("detail") if isinstance(context.get("detail"), dict) else {}
    if detail.get("kind") in kinds and _squash(detail.get("id")) == target:
        return True
    return "rack" in kinds and _squash(context.get("rack")) == target


def _anchored(ctx: ToolContext, kinds: tuple[str, ...], name) -> bool:
    return mentions(getattr(ctx, "user_message", "") or "", name) or _context_is(ctx, kinds, name)


def _server_names(value) -> list[str]:
    text = str(value or "").strip()
    bare = text[7:] if text.casefold().startswith("server:") else text
    return [name for name in dict.fromkeys((text, bare, _FEED_SUFFIX.sub("", bare))) if name]


def lab_wide(message) -> bool:
    text = re.sub(r"\s+", " ", message.casefold()) if isinstance(message, str) else ""
    return any(phrase in text for phrase in LAB_WIDE_PHRASES)


def _not_requested(what: str, hebrew: str) -> ToolError:
    return ToolError(f"No proposal was prepared (not_requested): {what} Ask the user to write the exact target in "
                     f"their own request. Details: {hebrew}")


def check_anchor(ctx: ToolContext, request: ProposalRequest) -> None:
    """Before anything is resolved: the request's target must be what the user wrote in this turn (or the page)."""
    scope = KIND_SPECS[request.kind].scope
    if scope == "server":
        if not any(_anchored(ctx, ("server",), name) for name in _server_names(request.server)):
            raise _not_requested("the server is not named in the user's own message of this turn.",
                                 "שם השרת לא מופיע בבקשה שלך. כתוב במפורש את שם השרת המלא.")
    elif scope in ("pdu", "outlet"):
        if not _anchored(ctx, ("pdu",), request.pdu):
            raise _not_requested("the PDU is not named in the user's own message of this turn.",
                                 "שם ה-PDU לא מופיע בבקשה שלך. כתוב במפורש את שם ה-PDU.")
        message = getattr(ctx, "user_message", "") or ""
        # A missing outlet number is left to the store's request validation (400 invalid, nothing read).
        if (scope == "outlet" and type(request.outlet) is int
                and not re.search(rf"(?<![0-9]){request.outlet}(?![0-9])", message)):
            raise _not_requested("the outlet number is not written in the user's own message of this turn.",
                                 "מספר השקע לא מופיע בבקשה שלך. כתוב במפורש את מספר השקע.")
    elif scope == "rack":
        if not _anchored(ctx, ("rack",), request.rack):
            raise _not_requested("the rack is not named in the user's own message of this turn.",
                                 "שם הארון לא מופיע בבקשה שלך. כתוב במפורש את שם הארון.")
    elif scope == "lab":
        if not lab_wide(getattr(ctx, "user_message", "")):
            raise _not_requested("a lab-wide shutdown needs an explicit lab-wide request in the user's own message.",
                                 "כיבוי של כל המעבדה דורש בקשה מפורשת, למשל: כבה חשמל לכל המעבדה.")
    # batch: the scope is fixed by an executed rack/lab shutdown (store and resolver check it; Admin, typed phrase).


def check_resolved(ctx: ToolContext, kind: str, public: dict) -> None:
    """After resolution: one named server never widens to several, and the resolved server identity itself must be
    in the user's message or the viewed page (an alias the user wrote is not enough)."""
    if KIND_SPECS[kind].scope != "server":
        return
    impact = public.get("impact") if isinstance(public.get("impact"), dict) else {}
    servers = [name for name in impact.get("servers") or [] if isinstance(name, str) and name]
    if len(servers) > 1:
        raise _not_requested("the server name resolved to more than one server.",
                             "שם השרת מתאים ליותר משרת אחד. כתוב שם שרת מדויק.")
    if servers and not _anchored(ctx, ("server",), servers[0]):
        raise _not_requested(f"the name resolved to server {servers[0]}, which the user did not write.",
                             f"השם שכתבת מתאים לשרת {servers[0]}. כדי לפעול עליו, כתוב את שמו במפורש.")


async def _withdraw(ctx: ToolContext, proposal_id: str) -> None:
    """Cancel a proposal this tool just created but must not show (best effort, logged by class name only)."""
    try:
        async with ctx.session_factory() as db:
            await store.cancel(db, ctx.principal, proposal_id, time.time())
    except Exception as exc:  # noqa: BLE001
        log.warning("assistant actions: a refused proposal could not be withdrawn (%s)", type(exc).__name__)


async def latest_restorable(session_factory, principal) -> str | None:
    """The id of the newest executed rack/lab shutdown that can still be restored (can_restore), or None.

    Any Admin may restore any executed batch (D6); batch_restore itself requires Admin."""
    async with session_factory() as db:
        rows = await store.list_for(db, principal, limit=100)
        candidates = [row for row in rows if getattr(row, "kind", None) in RESTORABLE_KINDS
                      and store.to_public(row, principal).get("can_restore") is True]
    if not candidates:
        return None
    return max(candidates, key=lambda row: float(getattr(row, "created_at", 0) or 0)).id


def model_view(public: dict) -> dict:
    """Only server-built fields the model needs: no owner name, no request echo, no outlet-by-outlet lists. The
    Hebrew title is the store's KIND_SPECS template, never model text."""
    impact = public.get("impact") if isinstance(public.get("impact"), dict) else {}
    excluded = [item for item in impact.get("excluded") or [] if isinstance(item, dict)]
    by_reason: dict[str, int] = {}
    for item in excluded:
        reason = str(item.get("reason") or "unknown")
        by_reason[reason] = by_reason.get(reason, 0) + 1
    skipped_pdus = sorted({str(item.get("pdu_name") or item.get("pdu_id") or "") for item in excluded
                           if item.get("outlet") is None} - {""})
    counts = impact.get("counts") if isinstance(impact.get("counts"), dict) else {}
    return {
        "id": public.get("id"),
        "kind": public.get("kind"),
        "title_he": public.get("title_he"),
        "status": public.get("status"),
        "expires_at": public.get("expires_at"),
        "required_role": public.get("required_role"),
        "needs_password": public.get("needs_password"),
        "phrase": public.get("phrase"),
        "can_execute": public.get("can_execute"),
        "impact": {
            "counts": {**{key: value for key, value in counts.items() if type(value) is int},
                       "consoles": len(impact.get("consoles") or [])},
            "servers": [str(name) for name in (impact.get("servers") or [])[:LIST_CAP]],
            "excluded": {"total": len(excluded), "by_reason": by_reason, "skipped_pdus": skipped_pdus[:LIST_CAP]},
            "warnings_he": [str(text) for text in (impact.get("warnings_he") or [])[:LIST_CAP]],
        },
    }


async def propose_action(ctx: ToolContext, kind: str, server: str | None = None, pdu: str | None = None,
                         outlet: int | None = None, rack: str | None = None, restore_of: str | None = None,
                         then_console: bool = False, reason: str = "") -> ToolResult:
    if not actions_enabled(ctx.settings) or ctx.principal.legacy:
        raise ToolError("Assistant actions are turned off on this server or need accounts mode; no proposal was "
                        "prepared.")
    if not isinstance(kind, str) or kind not in KIND_SPECS:
        raise ToolError("Unknown action kind; use one of: " + ", ".join(KIND_SPECS) + ".")
    spec = KIND_SPECS[kind]
    if not ctx.principal.allows(spec.required_role):
        raise ToolError(f"No proposal was prepared (forbidden): {kind} requires the {spec.required_role} role. "
                        f"Details: הפעולה דורשת הרשאת {spec.required_role}.")
    if len(ctx.proposals) + _slots(ctx) >= MAX_PROPOSALS_PER_REQUEST:
        raise ToolError("Only one action proposal can be prepared per question and one was already prepared; no "
                        "further proposal was prepared. Ask the user to confirm or cancel the card shown first and "
                        "then to ask for the next action.")
    setattr(ctx, _SLOTS_ATTR, _slots(ctx) + 1)
    try:
        if kind == "batch_restore":
            wanted = _text(restore_of)
            if wanted is None or (isinstance(wanted, str) and wanted.casefold() == LATEST):
                wanted = await latest_restorable(ctx.session_factory, ctx.principal)
                if wanted is None:
                    raise ToolError("No proposal was prepared (not_found): there is no executed rack or lab "
                                    "shutdown that can still be restored. Details: לא נמצא כיבוי ארון או מעבדה "
                                    "שבוצע ושעדיין אפשר להחזיר ממנו חשמל.")
            elif not (isinstance(wanted, str) and _PROPOSAL_ID.fullmatch(wanted)):
                raise ToolError("No proposal was prepared (invalid): restore_of must be \"latest\" or a proposal id "
                                "returned by this tool.")
        else:
            wanted = None   # restore_of belongs to batch_restore only
        request = ProposalRequest(kind=kind, server=_text(server), pdu=_text(pdu), outlet=outlet, rack=_text(rack),
                                  restore_of=wanted, then_console=then_console is True, reason=_reason(reason))
        check_anchor(ctx, request)
        public = await store.propose(ctx.session_factory, ctx.principal, request, ctx.settings, ctx.now,
                                     ctx.conversation_id)
        proposal_id = public.get("id") if isinstance(public, dict) else None
        if not isinstance(proposal_id, str) or not proposal_id:
            raise ToolError("The proposal could not be prepared.")
        try:
            check_resolved(ctx, kind, public)
        except ToolError:
            await _withdraw(ctx, proposal_id)
            raise
    except ActionError as exc:
        raise ToolError(_error_text(exc)) from None
    finally:
        setattr(ctx, _SLOTS_ATTR, max(0, _slots(ctx) - 1))
    if proposal_id not in ctx.proposals:
        ctx.proposals.append(proposal_id)
    source = Source(id=f"action_proposal:{proposal_id}", name="Action proposal (targets and PDU states read live)",
                    ref=proposal_id, as_of=iso(time.time()), age_s=0.0)
    return ToolResult(data={"proposal": model_view(public), "executed": False, "next_step": NEXT_STEP},
                      sources=[source])


_KIND_HELP = ("server_off / server_on / server_cycle / open_console need `server`; outlet_off / outlet_on / "
              "outlet_cycle need `pdu` and `outlet`; pdu_shutdown / pdu_restore (maintenance) need `pdu`; "
              "rack_shutdown needs `rack`; lab_shutdown needs nothing else but only when the user explicitly asked "
              "for the whole lab; batch_restore powers back exactly what an executed rack/lab shutdown turned off "
              "and takes `restore_of`.")

INPUT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["kind"],
    "properties": {
        "kind": {"type": "string", "enum": list(KIND_SPECS), "description": _KIND_HELP},
        "server": {"type": "string", "minLength": 1, "maxLength": TEXT_CHARS,
                   "description": "Server name exactly as the user wrote it in this message (e.g. OPT11). Resolved "
                                  "by the server from PDU outlet labels; an unknown or ambiguous name is refused, "
                                  "never guessed."},
        "pdu": {"type": "string", "minLength": 1, "maxLength": TEXT_CHARS,
                "description": "PDU device id or exact device name, as the user wrote it."},
        "outlet": {"type": "integer", "minimum": 1, "maximum": 64,
                   "description": "1-based outlet number, as the user wrote it."},
        "rack": {"type": "string", "minLength": 1, "maxLength": TEXT_CHARS,
                 "description": "Rack name exactly as the user wrote it (e.g. Rack-01)."},
        "restore_of": {"type": "string", "minLength": 1, "maxLength": TEXT_CHARS,
                       "description": "batch_restore only: \"latest\" (the newest executed rack/lab shutdown that "
                                      "can still be restored) or a proposal id this tool returned earlier."},
        "then_console": {"type": "boolean",
                         "description": "server_cycle / outlet_cycle only: offer the server's KVM console after a "
                                        "successful reset (\"reset and open KVM\")."},
        "reason": {"type": "string", "maxLength": REASON_CHARS,
                   "description": "The user's request in their own words, for the audit trail."},
    },
}

DESCRIPTION = (
    "Prepare a PROPOSAL for a power or console action: switch a server's outlets off, on or power-cycle them "
    "(all feeds), switch one PDU outlet, put a PDU into maintenance or restore it, shut down a whole rack or the "
    "whole lab (protected outlets stay on), restore what an executed rack/lab shutdown turned off, or list a "
    "server's KVM consoles. This tool NEVER executes anything and never switches power: it resolves the targets, "
    "reads the involved PDUs and stores a short-lived proposal. The signed-in user reviews the exact impact in a "
    "card under your answer and confirms there with their own password (rack, lab and restore actions also need "
    "an exact typed phrase); you never see or ask for passwords. Call it at most once per question. Only targets "
    "the user named in their own message of this turn (or the page they are viewing) are accepted, and a lab-wide "
    "shutdown needs an explicit lab-wide request. Returns the proposal id, Hebrew title, status, required role, "
    "typed phrase and an impact summary (outlet, PDU and server counts, servers, excluded outlets by reason, "
    "skipped PDUs, warnings). Refusals (target not requested, unknown or ambiguous server, missing role, actions "
    "off) come back as errors to explain to the user."
)

TOOLS = [ToolSpec("propose_action", DESCRIPTION, INPUT_SCHEMA, "Operator", propose_action)]
