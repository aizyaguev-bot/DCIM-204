"""Location changes proposed by the assistant (contracts.DATA_KINDS: server_swap, server_move, server_clear).

The planner is the same one Admin -> Locations uses (routers/devices.py move-server, plus its clear-location
variant): the proposal pins its exact dry-run answer, execution re-plans and applies only an unchanged plan (drift =
any difference). No power is switched and no PDU or KVM is contacted; only saved port labels and the rack layout files
change. Called by resolve.build_impact / resolve.check_drift and by runner.execute (switch == "data").

Planner interface (routers/devices.py, imported lazily so this module never imports the HTTP routers at load time):
  async def plan_move(db, body: dict) -> dict                    # the move-server dry-run answer
  async def apply_move(db, body: dict, expected=None) -> dict    # same answer; refuses (409) when the plan differs
  async def plan_clear(db, server: str) -> dict                  # every port of the server -> "Outlet N"/"Port N"
  async def apply_clear(db, server: str, expected=None) -> dict
  Each raises fastapi.HTTPException 400/404/409/503 on refusal (the same messages as the endpoint).
"""
from __future__ import annotations

import asyncio
import difflib
import json
import logging
import unicodedata

from fastapi import HTTPException
from sqlalchemy import select

from ...models import Device
from ...ping_monitor import server_identity
from .contracts import DATA_KINDS, ActionError, Impact

log = logging.getLogger(__name__)

PLAN_KEYS = ("changes", "positions", "unplaced")
DRIFT_HE = "המיקומים השתנו מאז ההצעה"
MISSING_HE = "חסרה תמונת מצב פרטית של השינוי; יש ליצור הצעה חדשה."
_CODES = {400: "invalid", 404: "not_resolved", 409: "invalid", 503: "invalid"}
_SUMMARY_REFUSED = "המיקומים השתנו מאז ההצעה, ולכן לא בוצע שום שינוי. יש לבקש הצעה חדשה."
_SUMMARY_UNSAVED = "השינוי לא נשמר ולא בוצע שום שינוי. אפשר לנסות שוב."
_SUMMARY_ERROR = "הפעולה נכשלה עקב שגיאה פנימית. יש לבדוק את המיקומים לפני ניסיון נוסף."
_SUMMARY_SAVED = "השינוי נשמר. יש לבדוק את המיקומים במסך Locations."
_SUMMARY_INTERRUPTED = "הפעולה נקטעה. יש לבדוק את המיקומים לפני ניסיון נוסף."


def _planner():
    from ...routers import devices
    return devices


def _clean(value):
    if value is None:
        return None
    return "".join(c for c in str(value) if unicodedata.category(c) not in ("Cc", "Cf", "Cs", "Zl", "Zp"))


def _error(exc: HTTPException) -> ActionError:
    """The endpoint's refusal as an ActionError with the same (secret-free, English) message."""
    status = exc.status_code if exc.status_code in _CODES else 409
    detail = exc.detail if isinstance(exc.detail, str) and exc.detail else "The location change was refused"
    return ActionError(status, _CODES[status], detail)


def plan_of(response) -> dict:
    """{changes, positions, unplaced} of a planner answer, as plain JSON (exactly what a stored pin reads back as)."""
    if not isinstance(response, dict) or not all(isinstance(response.get(key), list) for key in PLAN_KEYS):
        raise ActionError(503, "invalid", "The location planner returned no plan")
    return json.loads(json.dumps({key: response[key] for key in PLAN_KEYS}))


def _server_text(value) -> str:
    text = value.strip() if isinstance(value, str) else ""
    return text[7:].strip() if text.casefold().startswith("server:") else text


async def _port_devices(db) -> list[Device]:
    return list((await db.scalars(select(Device).where(Device.kind.in_(("pdu", "kvm")))
                                 .order_by(Device.name, Device.id)
                                 .execution_options(populate_existing=True))).all())


def _device(query: str, devices: list[Device]) -> Device:
    """A PDU/KVM by exact id, else exact name, else a unique case-insensitive id/name; never a partial match."""
    folded = query.casefold()
    for match in (lambda d: d.id == query, lambda d: d.name == query,
                  lambda d: d.id.casefold() == folded or (d.name or "").casefold() == folded):
        found = [dev for dev in devices if match(dev)]
        if len(found) > 1:
            raise ActionError(409, "ambiguous", "Several PDUs or KVMs have this name; use the device id",
                              [_clean(dev.name) for dev in found[:5]])
        if found:
            return found[0]
    names = sorted({dev.name for dev in devices if dev.name})
    raise ActionError(404, "not_resolved", "PDU or KVM was not resolved",
                      [_clean(name) for name in difflib.get_close_matches(query, names, n=5, cutoff=0.5)])


async def request_body(db, req) -> dict:
    """The planner body for a validated location request (device names resolved to ids, never guessed)."""
    server = _server_text(req.server)
    if req.kind == "server_clear":
        return {"server": server}
    if req.target_server is not None:
        return {"server": server, "target_server": _server_text(req.target_server), "swap": req.kind == "server_swap"}
    devices = await _port_devices(db)
    ports = []
    for item in req.target_ports or []:
        entry = {"device_id": _device(item["device"], devices).id, "port": str(item["port"])}
        if entry not in ports:
            ports.append(entry)
    # server_move never swaps: an occupied slot or port is refused by the planner instead.
    body = {"server": server, "target_ports": ports, "swap": False}
    if req.target_rack is not None:
        body["target_rack"] = req.target_rack
    if req.target_slot is not None:
        body["target_slot"] = req.target_slot
    return body


async def plan(db, kind: str, body: dict) -> dict:
    devices = _planner()
    try:
        if kind == "server_clear":
            response = await devices.plan_clear(db, body["server"])
        else:
            response = await devices.plan_move(db, dict(body))
    except HTTPException as exc:
        raise _error(exc) from None
    return plan_of(response)


async def _candidates(db, body: dict) -> list[str]:
    """Known server names close to a name the planner did not find (from saved labels; nothing is contacted)."""
    names = {}
    for dev in await _port_devices(db):
        for label in dev.labels.values():
            found = server_identity(label) if isinstance(label, str) else None
            if found:
                names.setdefault(found[0], found[1])
    close = []
    for value in (body.get("server"), body.get("target_server")):
        found = server_identity(value) if isinstance(value, str) else None
        if found and found[0] not in names:
            close.extend(difflib.get_close_matches(found[0], sorted(names), n=5, cutoff=0.6))
    return [_clean(names[key]) for key in dict.fromkeys(close)][:5]


def _shown_place(value) -> dict:
    value = value if isinstance(value, dict) else {}
    slot = value.get("slot")
    return {"rack": _clean(value.get("rack")), "slot": slot if type(slot) is int else None}


def _shown(plan_: dict) -> dict:
    """Display copy of a plan: device ids must already be safe; names and labels lose control/bidi characters."""
    changes = []
    for item in plan_["changes"]:
        if not isinstance(item, dict) or not isinstance(item.get("device_id"), str) or \
                _clean(item["device_id"]) != item["device_id"]:
            raise ActionError(409, "invalid", "A device identifier contains unsafe display characters")
        changes.append({"device_id": item["device_id"], "device_name": _clean(item.get("device_name")),
                        "kind": _clean(item.get("kind")), "port": _clean(item.get("port")),
                        "before": _clean(item.get("before")), "after": _clean(item.get("after"))})
    positions = [{"server": _clean(item.get("server")), "before": _shown_place(item.get("before")),
                  "after": _shown_place(item.get("after"))}
                 for item in plan_["positions"] if isinstance(item, dict)]
    unplaced = [_clean(name) for name in plan_["unplaced"] if isinstance(name, str)]
    return {"changes": changes, "positions": positions, "unplaced": unplaced}


def _moved(positions: list[dict]) -> list[dict]:
    return [item for item in positions if item["before"] != item["after"]]


def _warnings(kind: str, shown: dict) -> list[str]:
    warnings = [f"{name} יישאר בלי מיקום: בלי שקעי PDU, בלי יציאות KVM ובלי מקום בארון." for name in shown["unplaced"]]
    for item in shown["positions"]:
        if item["after"]["rack"] is None and item["before"]["rack"] is not None and item["server"] not in shown["unplaced"]:
            warnings.append(f"{item['server']} יישאר בלי ארון.")
    if kind == "server_clear":
        warnings.append("המיקום בארון נשמר; רק שמות השקעים והיציאות של השרת יחזרו לשם ברירת המחדל.")
    return list(dict.fromkeys(warnings))


async def build_impact(db, req) -> Impact:
    """The exact Locations preview of a location request. Raises ActionError (400/404/409/503)."""
    from . import store

    req = store.validate_request(req)
    if req.kind not in DATA_KINDS:
        raise ActionError(400, "invalid", "Not a location change")
    body = await request_body(db, req)
    try:
        planned = await plan(db, req.kind, body)
    except ActionError as exc:
        if exc.status == 404 and not exc.details:
            exc.details = await _candidates(db, body)
        raise
    shown = _shown(planned)
    if not shown["changes"] and not _moved(shown["positions"]):
        raise ActionError(409, "no_targets", "Nothing would change: the server is already in that location")
    servers = list(dict.fromkeys(item["server"] for item in shown["positions"] if item["server"]))
    return Impact(servers=servers, warnings_he=_warnings(req.kind, shown), changes=shown["changes"],
                  positions=shown["positions"], unplaced=shown["unplaced"],
                  pins={"plan": planned, "body": body})


async def check_drift(db, kind: str, impact: dict) -> list[str]:
    """Re-plan the pinned body: any difference from the pinned plan (or a refusal) is drift."""
    pins = impact.get("pins") if isinstance(impact, dict) else None
    planned = pins.get("plan") if isinstance(pins, dict) else None
    body = pins.get("body") if isinstance(pins, dict) else None
    if (kind not in DATA_KINDS or not isinstance(planned, dict) or not isinstance(body, dict)
            or not isinstance(body.get("server"), str)):
        return [MISSING_HE]
    try:
        fresh = await plan(db, kind, body)
    except ActionError:
        return [DRIFT_HE]
    return [] if fresh == planned else [DRIFT_HE]


def _done_summary(shown: dict) -> str:
    moved = len(_moved(shown["positions"]))
    text = f"השינוי נשמר: {len(shown['changes'])} שינויי תוויות"
    text += f" ו-{moved} שינויי מיקום בארון." if moved else "."
    if shown["unplaced"]:
        text += " נשארו בלי מיקום: " + ", ".join(shown["unplaced"]) + "."
    return text + " לא בוצע שום שינוי חשמל."


async def _finish(session_factory, proposal_id, by, status, result, refused_reason=None):
    from . import store

    async with session_factory() as db:
        if refused_reason:
            await store.add_event(db, proposal_id, by, "refused", {"reason": refused_reason})
        await store.add_event(db, proposal_id, by, "interrupted" if status == "interrupted" else "finished",
                              {"status": status, "changes": len(result.get("changes", []))})
        if status == "succeeded":
            await store.set_progress(db, proposal_id, len(result["changes"]), len(result["changes"]))
        await store.finish(db, proposal_id, status, result)
        await db.commit()


async def execute(proposal_id: str, by: str, *, session_factory, settings=None) -> dict:
    """Apply an already claimed location proposal inline. Never raises; the stored result is returned.

    The planner applies the pinned body only when its fresh plan equals the pinned plan (under the label writer lock
    and the layout file locks); any refusal there means the situation changed and nothing was written."""
    from .models import AssistantActionProposal

    result = {"targets": [], "pdus": [], "consoles": [], "changes": [], "positions": [], "unplaced": [],
              "summary_he": _SUMMARY_ERROR}
    status, refused, saved = "failed", None, False
    try:
        async with session_factory() as db:
            row = await db.get(AssistantActionProposal, proposal_id, populate_existing=True)
            if row is None or row.status != "executing" or row.kind not in DATA_KINDS:
                return result   # never replay a completed, cancelled or unclaimed proposal
            kind = row.kind
            impact = json.loads(row.impact_json or "{}")
        pins = impact.get("pins") if isinstance(impact, dict) else None
        planned = pins.get("plan") if isinstance(pins, dict) else None
        body = pins.get("body") if isinstance(pins, dict) else None
        if not isinstance(planned, dict) or not isinstance(body, dict) or not isinstance(body.get("server"), str):
            status, refused, result["summary_he"] = "refused", "drift", _SUMMARY_REFUSED
        else:
            devices = _planner()
            async with session_factory() as db:
                try:
                    if kind == "server_clear":
                        applied = await devices.apply_clear(db, body["server"], expected=planned)
                    else:
                        applied = await devices.apply_move(db, dict(body), expected=planned)
                except HTTPException as exc:
                    result["error"] = _error(exc).message
                    if exc.status_code >= 500:
                        result["summary_he"] = _SUMMARY_UNSAVED
                    else:
                        status, refused, result["summary_he"] = "refused", "drift", _SUMMARY_REFUSED
                else:
                    saved = True
                    result.update(_shown(plan_of(applied)))
                    result["summary_he"] = _done_summary(result)
                    status = "succeeded"
    except (Exception, asyncio.CancelledError) as exc:
        # Exception text may contain paths or data; only the class name is logged.
        log.warning("Assistant location change %s did not complete (%s).", proposal_id, type(exc).__name__)
        if saved:   # the planner committed; only building the display copy failed
            status, result["summary_he"] = "succeeded", _SUMMARY_SAVED
        else:
            status = "interrupted" if isinstance(exc, asyncio.CancelledError) else "failed"
            result["summary_he"] = _SUMMARY_INTERRUPTED if status == "interrupted" else _SUMMARY_ERROR
    try:
        await _finish(session_factory, proposal_id, by, status, result, refused)
    except (Exception, asyncio.CancelledError) as exc:
        # Startup recovery marks a still-executing row interrupted once the database is available again.
        log.warning("Assistant location change %s could not be recorded (%s).", proposal_id, type(exc).__name__)
    return result
