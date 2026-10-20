"""Owner-bound, single-use action proposals and their bounded audit trail."""
from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import fields, replace
from datetime import datetime, timezone

from sqlalchemy import delete, func, select, update

from ... import confirm
from .contracts import (DATA_KINDS, EVENTS, FINAL_STATUSES, KIND_SPECS, PHRASES, ActionError, Impact,
                        ProposalRequest)
from .models import AssistantActionEvent, AssistantActionProposal

# Lead security decision D8 supersedes the initial count-only retention contract.
EVENT_KEEP = 2000  # denied/throttled events only; executions retain their full year of history
EVENT_RETENTION_SECONDS = 365 * 86400
_proposal_lock = asyncio.Lock()
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ud800-\udfff]")
_REQUEST_FIELDS = frozenset(f.name for f in fields(ProposalRequest))
_TEXT_FIELDS = ("server", "pdu", "rack", "restore_of", "reason", "target_server", "target_rack")
_DATA_FIELDS = ("target_server", "target_ports", "target_rack", "target_slot")
MAX_TARGET_PORTS = 8
_PORT_NUMBER = re.compile(r"[0-9]{1,3}")
_TITLE_FIELDS = ("server", "pdu", "outlet", "rack", "target_server")


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _load(value, default):
    try:
        return json.loads(value) if value else default
    except (TypeError, ValueError):
        return default


def _target_ports(value) -> list[dict]:
    """[{"device": PDU/KVM id or exact name, "port": "<n>"}], 1..8 entries; the port number is normalised to text."""
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_TARGET_PORTS:
        raise ActionError(400, "invalid", "Target ports must be a list of 1 to 8 ports")
    ports = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"device", "port"}:
            raise ActionError(400, "invalid", "Each target port needs a device and a port")
        device, port = item["device"], item["port"]
        if not isinstance(device, str) or not device.strip() or len(device) > 100 or CONTROL.search(device):
            raise ActionError(400, "invalid", "Invalid target port device")
        if type(port) is int:
            port = str(port)
        if not isinstance(port, str) or not _PORT_NUMBER.fullmatch(port.strip()) or int(port) < 1:
            raise ActionError(400, "invalid", "A target port must be a number from 1 to 999")
        entry = {"device": device.strip(), "port": str(int(port))}
        if entry not in ports:
            ports.append(entry)
    return ports


def _check_data_fields(kind: str, data: dict) -> None:
    """Location fields belong to the location kinds, in exactly the combinations contracts.DATA_KINDS describes."""
    if kind not in DATA_KINDS:
        if any(data.get(name) is not None for name in _DATA_FIELDS):
            raise ActionError(400, "invalid", "Location fields belong to location changes only")
        return
    if any(data.get(name) not in (None, "") for name in ("pdu", "outlet", "rack", "restore_of")):
        raise ActionError(400, "invalid", "A location change takes a server and its new location only")
    target = data.get("target_server") is not None
    ports = data.get("target_ports") is not None
    placement = data.get("target_rack") is not None or data.get("target_slot") is not None
    if kind == "server_swap":
        valid = target and not ports and not placement
    elif kind == "server_move":
        valid = target != ports and not (target and placement)
    else:   # server_clear
        valid = not (target or ports or placement)
    if not valid:
        raise ActionError(400, "invalid", {
            "server_swap": "A swap needs target_server only",
            "server_move": "A move needs either target_server or target_ports (rack and slot only with ports)",
            "server_clear": "Clearing a server takes no target"}[kind])


def validate_request(value) -> ProposalRequest:
    """Parse manually so rejected input, including accidental credentials, is never echoed."""
    if isinstance(value, ProposalRequest):
        value = value.to_dict()
    if not isinstance(value, dict) or set(value) - _REQUEST_FIELDS:
        raise ActionError(400, "invalid", "Invalid proposal request")
    kind = value.get("kind")
    if not isinstance(kind, str) or kind not in KIND_SPECS:
        raise ActionError(400, "invalid", "Invalid action kind")
    data = dict(value)
    for name in _TEXT_FIELDS:
        text = data.get(name, "" if name == "reason" else None)
        if text is None and name != "reason":
            continue
        if not isinstance(text, str) or len(text) > (200 if name == "reason" else 100) or CONTROL.search(text):
            raise ActionError(400, "invalid", "Invalid proposal text")
        data[name] = text.strip()
        if name in ("target_server", "target_rack") and not data[name]:
            data[name] = None
    outlet = data.get("outlet")
    if outlet is not None and (type(outlet) is not int or not 1 <= outlet <= 64):
        raise ActionError(400, "invalid", "Outlet must be an integer from 1 to 64")
    slot = data.get("target_slot")
    if slot is not None and (type(slot) is not int or not 1 <= slot <= 999):
        raise ActionError(400, "invalid", "Target slot must be an integer from 1 to 999")
    if data.get("target_ports") is not None:
        data["target_ports"] = _target_ports(data["target_ports"])
    if "then_console" in data and type(data["then_console"]) is not bool:
        raise ActionError(400, "invalid", "Invalid console option")
    if data.get("then_console") and kind not in ("server_cycle", "outlet_cycle"):
        raise ActionError(400, "invalid", "Console follow-up requires a power cycle")
    scope = KIND_SPECS[kind].scope
    required = {"server": ("server",), "outlet": ("pdu", "outlet"), "pdu": ("pdu",),
                "rack": ("rack",), "batch": ("restore_of",)}.get(scope, ())
    if any(not data.get(name) for name in required):
        raise ActionError(400, "invalid", "The action target is required")
    _check_data_fields(kind, data)
    return ProposalRequest(**data)


def owner_key(principal) -> str:
    if principal.user_id and not principal.legacy:
        return str(principal.user_id)
    return "shared:" + principal.username


class _Blank(dict):
    def __missing__(self, key):
        return ""


def _title(kind: str, request: dict) -> str:
    """The Hebrew title from the KIND_SPECS template. Every placeholder always has a value (a missing field is
    blank), so an old or partial row can never break listing the history."""
    request = request if isinstance(request, dict) else {}
    values = _Blank({name: "" if request.get(name) is None else str(request.get(name)) for name in _TITLE_FIELDS})
    try:
        values["title"] = KIND_SPECS["rack_shutdown" if values["rack"] else "lab_shutdown"].title_he.format_map(values)
        return KIND_SPECS[kind].title_he.format_map(values)
    except (KeyError, IndexError, ValueError, AttributeError, TypeError):
        return str(kind)


async def add_event(db, proposal_id, actor, event, detail: dict) -> None:
    """Join the caller's transaction; event details never include confirmation input."""
    if event not in EVENTS:
        raise ValueError("Unknown action event")
    # Restrict keys even for internal callers: confirmation bodies must never become audit data.
    def clean(value):
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items()
                    if (key == "phrase_ok" and type(item) is bool) or
                    not re.search(r"password|passwd|credential|token|secret|phrase|owner_key|pins|\bip\b",
                                  str(key), re.IGNORECASE)}
        if isinstance(value, (list, tuple)):
            return [clean(item) for item in value]
        return value

    now = time.time()
    db.add(AssistantActionEvent(at=now, proposal_id=proposal_id, actor=actor,
                                event=event, detail_json=_dump(clean(detail))))
    await db.flush()
    await db.execute(delete(AssistantActionEvent).where(AssistantActionEvent.at < now - EVENT_RETENTION_SECONDS)
                     .execution_options(synchronize_session=False))
    noise = AssistantActionEvent.event.in_(("denied", "throttled"))
    cutoff = (select(AssistantActionEvent.id).where(noise).order_by(AssistantActionEvent.id.desc())
              .offset(EVENT_KEEP - 1).limit(1).scalar_subquery())
    await db.execute(delete(AssistantActionEvent).where(noise, AssistantActionEvent.id < cutoff)
                     .execution_options(synchronize_session=False))


async def create(db, principal, req, impact: Impact, settings, now, conversation_id=None):
    req = validate_request(req)
    spec = KIND_SPECS[req.kind]
    phrase = None
    if req.kind == "batch_restore":
        source = await get_for(db, principal, req.restore_of)
        if source is None or source.kind not in ("rack_shutdown", "lab_shutdown"):
            raise ActionError(404, "not_found", "Action proposal not found")
        source_request = _load(source.request_json, {})
        req = replace(req, rack=source_request.get("rack") if source.kind == "rack_shutdown" else None)
    if spec.needs_phrase:
        phrase = PHRASES[req.kind].format(rack=req.rack or "", scope=req.rack or "LAB")
    row = AssistantActionProposal(
        id=uuid.uuid4().hex, created_at=now, expires_at=now + getattr(settings, "assistant_action_ttl_seconds", 300),
        owner_key=owner_key(principal), created_by=principal.username, conversation_id=conversation_id,
        kind=req.kind, request_json=_dump(req.to_dict()), impact_json=_dump(impact.to_dict(with_pins=True)),
        phrase=phrase, status="ready" if req.kind == "open_console" else "pending", restore_of=req.restore_of,
        progress_done=0, progress_total=(len(impact.changes) if req.kind in DATA_KINDS else
                                       len(impact.pdus) if spec.background else len(impact.targets)),
        result_json=_dump({"targets": [], "pdus": [], "consoles": [c.to_dict() for c in impact.consoles],
                           "summary_he": "הקונסולות מוכנות לפתיחה."}) if req.kind == "open_console" else "",
        finished_at=now if req.kind == "open_console" else None, batch_down_json="[]")
    db.add(row)
    await add_event(db, row.id, principal.username, "proposed", {"kind": req.kind})
    await db.commit()
    await db.refresh(row)
    return row


async def get_for(db, principal, proposal_id):
    statement = select(AssistantActionProposal).where(AssistantActionProposal.id == proposal_id)
    if not principal.allows("Admin"):
        statement = statement.where(AssistantActionProposal.owner_key == owner_key(principal))
    return (await db.execute(statement.execution_options(populate_existing=True))).scalar_one_or_none()


async def list_for(db, principal, limit=20):
    statement = select(AssistantActionProposal)
    if not principal.allows("Admin"):
        statement = statement.where(AssistantActionProposal.owner_key == owner_key(principal))
    statement = statement.order_by(AssistantActionProposal.created_at.desc(), AssistantActionProposal.id.desc())
    result = await db.scalars(statement.limit(max(1, min(int(limit), 100)))
                              .execution_options(populate_existing=True))
    return list(result.all())


async def _claim_failure(db, principal, proposal_id, now):
    row = (await db.execute(select(AssistantActionProposal).where(
        AssistantActionProposal.id == proposal_id, AssistantActionProposal.owner_key == owner_key(principal))
        .execution_options(populate_existing=True))).scalar_one_or_none()
    if row is None:
        raise ActionError(404, "not_found", "Action proposal not found")
    if row.status == "expired" or (row.status == "pending" and row.expires_at <= now):
        changed = await db.execute(update(AssistantActionProposal).where(
            AssistantActionProposal.id == proposal_id, AssistantActionProposal.status == "pending",
            AssistantActionProposal.expires_at <= now).values(status="expired", finished_at=now))
        if changed.rowcount:
            await add_event(db, proposal_id, principal.username, "expired", {})
        await db.commit()
        raise ActionError(410, "expired", "Action proposal has expired")
    raise ActionError(409, "not_pending", "Action proposal is no longer pending")


async def claim(db, principal, proposal_id, now):
    result = await db.execute(update(AssistantActionProposal).where(
        AssistantActionProposal.id == proposal_id, AssistantActionProposal.status == "pending",
        AssistantActionProposal.owner_key == owner_key(principal), AssistantActionProposal.expires_at > now)
        .values(status="executing", confirmed_at=now, confirmed_by=principal.username))
    if result.rowcount != 1:
        await _claim_failure(db, principal, proposal_id, now)
    await add_event(db, proposal_id, principal.username, "confirmed", {})
    await add_event(db, proposal_id, principal.username, "executing", {})
    await db.commit()
    return await get_for(db, principal, proposal_id)


async def require_pending(db, principal, row, now):
    """Preflight before authentication; claim repeats the authoritative atomic check later."""
    if row.status != "pending" or row.expires_at <= now:
        await _claim_failure(db, principal, row.id, now)


async def cancel(db, principal, proposal_id, now):
    result = await db.execute(update(AssistantActionProposal).where(
        AssistantActionProposal.id == proposal_id, AssistantActionProposal.status == "pending",
        AssistantActionProposal.owner_key == owner_key(principal), AssistantActionProposal.expires_at > now)
        .values(status="cancelled", finished_at=now))
    if result.rowcount != 1:
        await _claim_failure(db, principal, proposal_id, now)
    await add_event(db, proposal_id, principal.username, "cancelled", {})
    await db.commit()
    return await get_for(db, principal, proposal_id)


async def set_progress(db, proposal_id, done, total) -> None:
    await db.execute(update(AssistantActionProposal).where(AssistantActionProposal.id == proposal_id)
                     .values(progress_done=done, progress_total=total))
    await db.commit()


async def finish(db, proposal_id, status, result: dict) -> None:
    if status not in FINAL_STATUSES:
        raise ValueError("Invalid final action status")
    await db.execute(update(AssistantActionProposal).where(AssistantActionProposal.id == proposal_id)
                     .values(status=status, result_json=_dump(result), finished_at=time.time()))
    await db.commit()


def _iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def to_public(row, principal) -> dict:
    spec = KIND_SPECS[row.kind]
    request = _load(row.request_json, {})
    request.pop("reason", None)
    impact = _load(row.impact_json, {})
    impact.pop("pins", None)
    now = time.time()
    return {
        "id": row.id, "kind": row.kind, "scope": spec.scope, "title_he": _title(row.kind, request),
        "status": row.status, "created_at": _iso(row.created_at), "expires_at": _iso(row.expires_at),
        "created_by": row.created_by, "required_role": spec.required_role, "needs_password": spec.needs_password,
        "expires_in_s": max(0, row.expires_at - now),
        "phrase": row.phrase, "background": spec.background, "request": request, "impact": impact,
        "progress": {"done": row.progress_done, "total": row.progress_total},
        "result": _load(row.result_json, None), "restore_of": row.restore_of,
        "can_restore": bool(row.kind in ("rack_shutdown", "lab_shutdown") and
                            row.status in ("succeeded", "partial", "failed", "interrupted") and
                            _load(row.batch_down_json, []) and principal.allows("Admin")),
        "can_execute": bool(row.status == "pending" and row.expires_at > now and
                            row.owner_key == owner_key(principal) and principal.allows(spec.required_role) and
                            not (spec.accounts_only and principal.legacy)),
    }


async def propose(session_factory, principal, req, settings, now, conversation_id=None) -> dict:
    from . import resolve

    if not getattr(settings, "assistant_actions_enabled", False):
        raise ActionError(403, "disabled", "Assistant actions are disabled on this server")
    req = validate_request(req)
    spec = KIND_SPECS[req.kind]
    if not principal.allows(spec.required_role):
        raise ActionError(403, "forbidden", "Your role does not allow this action")
    mode = confirm.password_mode(settings)
    if spec.accounts_only and mode != "account":
        raise ActionError(403, "password_mode", "This action requires accounts mode")
    if spec.needs_password and mode == "unavailable":
        raise ActionError(403, "password_mode", "Actions require a configured password")
    async with _proposal_lock, session_factory() as db:
        # Keep old proposal rows bounded without deleting their separately retained audit events.
        await db.execute(delete(AssistantActionProposal).where(
            AssistantActionProposal.status.in_(("pending", "expired")),
            AssistantActionProposal.expires_at < now - 30 * 86400))
        pending = (AssistantActionProposal.owner_key == owner_key(principal),
                   AssistantActionProposal.status == "pending", AssistantActionProposal.expires_at > now)
        count = await db.scalar(select(func.count()).select_from(AssistantActionProposal).where(*pending))
        bulk_kinds = [kind for kind, kind_spec in KIND_SPECS.items() if kind_spec.background]
        has_bulk = spec.background and await db.scalar(select(AssistantActionProposal.id).where(
            *pending, AssistantActionProposal.kind.in_(bulk_kinds)).limit(1))
        if req.kind != "open_console" and (count >= 3 or has_bulk):
            raise ActionError(409, "busy", "Too many pending action proposals")
        impact = await resolve.build_impact(db, req, settings, now)
        row = await create(db, principal, req, impact, settings, now, conversation_id)
        return to_public(row, principal)
