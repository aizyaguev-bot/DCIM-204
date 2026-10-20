"""The sole HTTP execution gate: stored targets, current role, password and drift check."""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
import unicodedata

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import select, update

from ... import confirm, power_protection
from ...config import get_settings
from ...database import AsyncSessionLocal, get_db
from ..principal import principal_for
from ..router import _guard_write, _legacy_client
from . import resolve, runner, store
from .contracts import KIND_SPECS, ActionError
from .models import AssistantActionProposal

_background_lock = asyncio.Lock()
MAX_BODY_BYTES = 4096


class ActionRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def guarded(request):
            try:
                response = await handler(request)
            except ActionError as exc:
                response = JSONResponse(exc.to_dict(), status_code=exc.status)
            except HTTPException as exc:
                code = {400: "invalid", 403: "forbidden", 429: "throttled"}.get(exc.status_code, "invalid")
                if exc.detail == "Password is incorrect":
                    code = "password"
                response = JSONResponse(ActionError(exc.status_code, code, str(exc.detail)).to_dict(),
                                        status_code=exc.status_code, headers=exc.headers)
            response.headers["Cache-Control"] = "no-store"
            return response

        return guarded


router = APIRouter(prefix="/api/assistant/actions", tags=["assistant actions"], route_class=ActionRoute,
                   dependencies=[Depends(_legacy_client)])


def _enabled(settings=None):
    if settings is None:
        settings = get_settings()
    if not getattr(settings, "assistant_actions_enabled", False):
        raise ActionError(403, "disabled", "Assistant actions are disabled on this server")
    return settings


def _operator(request, settings):
    if confirm.password_mode(settings) != "account":
        raise ActionError(403, "password_mode", "Assistant actions require accounts mode")
    principal = principal_for(request, settings)
    if not principal.allows("Operator"):
        raise ActionError(403, "forbidden", "Your role does not allow this action")
    return principal


async def _body_limit(request):
    # No validation error may carry the supplied JSON back to the client.
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isascii() or not declared.isdigit() or
                                 len(declared) > 10 or int(declared) > MAX_BODY_BYTES):
        raise ActionError(400, "invalid", "Invalid request body")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise ActionError(400, "invalid", "Invalid request body")
        chunks.append(chunk)
    # Starlette's JSON/read_body helpers can safely reuse this bounded body.
    request._body = b"".join(chunks)


def _valid_id(proposal_id):
    if not re.fullmatch(r"[0-9a-f]{32}", proposal_id):
        raise ActionError(404, "not_found", "Action proposal not found")


async def _owned(db, principal, proposal_id):
    _valid_id(proposal_id)
    row = await store.get_for(db, principal, proposal_id)
    if row is None or row.owner_key != store.owner_key(principal):
        raise ActionError(404, "not_found", "Action proposal not found")
    return row


@router.get("/config")
async def config(request: Request, db=Depends(get_db)):
    settings = get_settings()
    principal = principal_for(request, settings)
    enabled = bool(getattr(settings, "assistant_actions_enabled", False))
    available = enabled and confirm.password_mode(settings) == "account"
    protection = await power_protection.load(db, settings)
    return {"enabled": enabled, "password_mode": confirm.password_mode(settings),
            "protected_configured": protection.usable,
            "can_propose": available and principal.allows("Operator"),
            "can_admin": available and principal.allows("Admin")}


@router.post("/proposals", status_code=201)
async def propose(request: Request):
    settings = _enabled()
    principal = _operator(request, settings)
    _guard_write(request, settings)
    await _body_limit(request)
    try:
        body = await request.json()
    except ValueError:
        raise ActionError(400, "invalid", "Invalid request body") from None
    req = store.validate_request(body)
    return await store.propose(AsyncSessionLocal, principal, req, settings, time.time())


@router.get("/proposals")
async def proposals(request: Request, db=Depends(get_db)):
    settings = _enabled()
    principal = _operator(request, settings)
    try:
        limit = int(request.query_params.get("limit", "20"))
    except ValueError:
        raise ActionError(400, "invalid", "Invalid proposal limit") from None
    if not 1 <= limit <= 100:
        raise ActionError(400, "invalid", "Proposal limit must be from 1 to 100")
    rows = await store.list_for(db, principal, limit)
    return {"items": [store.to_public(row, principal) for row in rows]}


@router.get("/proposals/{proposal_id}")
async def proposal(proposal_id: str, request: Request, db=Depends(get_db)):
    settings = _enabled()
    principal = _operator(request, settings)
    _valid_id(proposal_id)
    row = await store.get_for(db, principal, proposal_id)
    if row is None:
        raise ActionError(404, "not_found", "Action proposal not found")
    return store.to_public(row, principal)


@router.post("/proposals/{proposal_id}/cancel")
async def cancel(proposal_id: str, request: Request, db=Depends(get_db)):
    settings = _enabled()
    principal = _operator(request, settings)
    _guard_write(request, settings)
    _valid_id(proposal_id)
    row = await store.cancel(db, principal, proposal_id, time.time())
    return store.to_public(row, principal)


async def _admit(db, principal, row, settings, by):
    """For batches the caller holds _background_lock through claim and task scheduling."""
    row = await store.claim(db, principal, row.id, time.time())
    impact = json.loads(row.impact_json)
    try:
        drift = await resolve.check_drift(db, row.kind, impact, settings)
    except ActionError:
        await store.add_event(db, row.id, by, "refused", {"reason": "drift_check"})
        await store.finish(db, row.id, "refused", {"summary_he": "לא ניתן היה לאמת את ההשפעה מחדש."})
        raise
    if drift:
        await store.add_event(db, row.id, by, "refused", {"reason": "drift"})
        await store.finish(db, row.id, "refused", {"summary_he": "המצב השתנה; יש לבקש הצעה חדשה."})
        raise ActionError(409, "drift", "The situation changed; review the action again", drift)
    if KIND_SPECS[row.kind].background:
        background_kinds = [kind for kind, spec in KIND_SPECS.items() if spec.background]
        active = await db.scalar(select(AssistantActionProposal.id).where(
            AssistantActionProposal.status == "executing", AssistantActionProposal.id != row.id,
            AssistantActionProposal.kind.in_(background_kinds)).limit(1))
        if active is not None:
            # This request changed no hardware. Keep the same preview available for a fresh confirmation later.
            await db.execute(update(AssistantActionProposal).where(AssistantActionProposal.id == row.id,
                AssistantActionProposal.status == "executing").values(status="pending", confirmed_at=None,
                                                                        confirmed_by=None))
            await store.add_event(db, row.id, by, "refused", {"reason": "busy"})
            await db.commit()
            raise ActionError(409, "busy", "Another background action is executing")
        # Release any read transaction before the job opens its own session.
        await db.commit()
        runner.start_background(row.id, by, session_factory=AsyncSessionLocal, settings=settings)
        return JSONResponse(store.to_public(row, principal), status_code=202)
    await db.commit()
    await runner.execute(row.id, by, session_factory=AsyncSessionLocal, settings=settings)
    return store.to_public(await _owned(db, principal, row.id), principal)


@router.post("/proposals/{proposal_id}/execute")
async def execute(proposal_id: str, request: Request, db=Depends(get_db)):
    settings = get_settings()
    principal = principal_for(request, settings)
    row = await _owned(db, principal, proposal_id)
    await store.require_pending(db, principal, row, time.time())
    _enabled(settings)
    spec = KIND_SPECS[row.kind]
    if spec.accounts_only and confirm.password_mode(settings) != "account":
        raise ActionError(403, "password_mode", "This action requires accounts mode")
    if not principal.allows(spec.required_role):
        raise ActionError(403, "forbidden", "Your role does not allow this action")
    try:
        confirm.require_password_mode(settings, "Actions require a configured password")
    except HTTPException:
        raise ActionError(403, "password_mode", "Actions require a configured password") from None
    _guard_write(request, settings)
    await _body_limit(request)
    try:
        body = await request.json()
    except ValueError:
        raise ActionError(400, "invalid", "Invalid request body") from None
    if not isinstance(body, dict) or set(body) - {"password", "phrase"}:
        raise ActionError(400, "invalid", "Invalid execution request")
    supplied_phrase = body.get("phrase")
    try:
        phrase_ok = isinstance(supplied_phrase, str) and secrets.compare_digest(
            unicodedata.normalize("NFC", supplied_phrase).strip().encode(),
            unicodedata.normalize("NFC", row.phrase or "").encode())
    except UnicodeError:
        raise ActionError(400, "invalid", "Invalid confirmation phrase") from None
    if spec.needs_phrase and not phrase_ok:
        await store.add_event(db, row.id, principal.username, "denied", {"reason": "phrase", "phrase_ok": False})
        await db.commit()
        raise ActionError(403, "phrase", "Confirmation phrase does not match")
    password, _, _ = await confirm.read_body(request, "none")
    try:
        password.encode()
    except UnicodeError:
        raise ActionError(400, "invalid", "Invalid password encoding") from None

    async def denied(by):
        await store.add_event(db, row.id, by, "denied", {"reason": "password"})

    try:
        by = await confirm.verify(request, db, password, settings, confirm.confirm_lock, on_denied=denied)
    except HTTPException as exc:
        if exc.status_code == 429:
            await store.add_event(db, row.id, principal.username, "throttled", {})
            await db.commit()
        raise
    if spec.background:
        async with _background_lock:
            return await _admit(db, principal, row, settings, by)
    return await _admit(db, principal, row, settings, by)
