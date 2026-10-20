"""Execute confirmed actions, persisting progress and the maintenance restore path."""
from __future__ import annotations

import asyncio
import json
import math
import time
from contextlib import contextmanager

from sqlalchemy import event, select
from sqlalchemy.orm.util import identity_key

from ...models import Device, PduMaintenance
from ... import power_protection
from .contracts import ActionError, KIND_SPECS, PduResult, Target, TargetResult
from .models import AssistantActionEvent, AssistantActionProposal

BATCH_LOCK = asyncio.Lock()
_MAINTENANCE_LOCK = asyncio.Lock()
_tasks: set[asyncio.Task] = set()
EXECUTION_ERROR = "Action execution failed"
_SUMMARIES = {
    "succeeded": "הפעולה הושלמה בהצלחה.",
    "partial": "הפעולה הושלמה חלקית. יש לבדוק את התוצאות לפני ניסיון נוסף.",
    "failed": "הפעולה נכשלה. יש לבדוק את התוצאות לפני ניסיון נוסף.",
    "interrupted": "הפעולה נקטעה בעקבות הפעלה מחדש של השרת. רכיבים שבתחזוקה עדיין ניתנים לשחזור.",
}


class _AbortJob(Exception):
    def __init__(self, reason, outcome):
        self.reason, self.outcome = reason, outcome


class _GenerationChanged(Exception):
    pass


def _batch_entries(row):
    entries = json.loads(row.batch_down_json or "[]")
    if not isinstance(entries, list) or any(
            not isinstance(item, dict) or not isinstance(item.get("pdu_id"), str)
            or type(item.get("started_at")) not in (int, float) or not math.isfinite(item["started_at"])
            for item in entries):
        raise ValueError("Invalid maintenance generations")
    generations = {}
    for item in entries:
        if item["pdu_id"] in generations and generations[item["pdu_id"]] != item["started_at"]:
            raise ValueError("Conflicting maintenance generations")
        generations[item["pdu_id"]] = item["started_at"]
    return entries


def _batch_change(row, pdu_id: str, started_at, *, down: bool) -> None:
    if type(started_at) not in (int, float) or not math.isfinite(started_at):
        raise ValueError("Missing maintenance generation")
    entries = _batch_entries(row)
    entries = [item for item in entries if not (
        item["pdu_id"] == pdu_id and (down or item["started_at"] == started_at))]
    if down:
        entries.append({"pdu_id": pdu_id, "started_at": started_at})
    row.batch_down_json = json.dumps(entries)


@contextmanager
def _track_maintenance(db, batches, pdu_id: str, *, down: bool, expected_started_at=None):
    """Pair the restore list with ACT-3's maintenance insert/delete in the same commit.

    Maintenance commits before contacting the device. Waiting for its return would
    lose the batch association if the process stopped during the device operation.
    The listener belongs only to this short-lived session and does no device I/O.
    """
    def before_flush(session, flush_context, instances):
        if not down and expected_started_at is not None:
            current = session.identity_map.get(identity_key(PduMaintenance, (pdu_id,)))
            if current is None or current.started_at != expected_started_at:
                # ACT-3 flushes its audit entry under the PDU lock, before any
                # hardware call. Recheck its freshly loaded maintenance row here.
                raise _GenerationChanged()
        rows = session.new if down else session.deleted
        for row in rows:
            if isinstance(row, PduMaintenance) and row.device_id == pdu_id:
                for batch in batches:
                    _batch_change(batch, pdu_id, row.started_at, down=down)

    event.listen(db.sync_session, "before_flush", before_flush)
    try:
        yield
    finally:
        event.remove(db.sync_session, "before_flush", before_flush)


async def _record(session_factory, proposal_id, by, event_name, detail, done, total, result=None):
    from . import store

    async with session_factory() as db:
        await store.add_event(db, proposal_id, by, event_name, detail)
        if result is not None:
            row = await db.get(AssistantActionProposal, proposal_id)
            row.result_json = json.dumps(result)
        await store.set_progress(db, proposal_id, done, total)
        await db.commit()


async def _ensure_executing_event(db, proposal_id, by):
    from . import store

    existing = await db.scalar(select(AssistantActionEvent.id).where(
        AssistantActionEvent.proposal_id == proposal_id, AssistantActionEvent.event == "executing").limit(1))
    if existing is None:
        await store.add_event(db, proposal_id, by, "executing", {})


def _clear_pending(result, outcome):
    if outcome.state_after == "on":
        result["pending_on"] = [item for item in result.get("pending_on", [])
                                if (item["pdu_id"], item["outlet"]) != (outcome.pdu_id, outcome.outlet)]


def _pending_targets(row, result):
    pending = result.get("pending_on")
    if not isinstance(pending, list):
        return []
    wanted = {(item["pdu_id"], item["outlet"]) for item in pending
              if isinstance(item, dict) and isinstance(item.get("pdu_id"), str)
              and type(item.get("outlet")) is int}
    impact = json.loads(row.impact_json or "{}")
    return [Target(**item) for item in impact.get("targets", [])
            if item.get("state") == "on" and (item.get("pdu_id"), item.get("outlet")) in wanted]


def _pins_refused(outcome):
    # ACT-2 returns this fixed failure class, also inside an aborted cycle error.
    return not outcome.ok and "PDU changed since the proposal" in outcome.error


async def _finish(session_factory, proposal_id, by, status, result):
    from . import store

    async with session_factory() as db:
        event_name = "interrupted" if status == "interrupted" else "finished"
        await store.add_event(db, proposal_id, by, event_name, {"status": status})
        await store.finish(db, proposal_id, status, result)
        await db.commit()


async def _abort(session_factory, proposal_id, by, result, reason, pdu_id, name):
    from . import store

    result["aborted"] = {"reason": reason, "pdu_id": pdu_id, "pdu_name": name}
    async with session_factory() as db:
        await store.add_event(db, proposal_id, by, "aborted", result["aborted"])
        row = await db.get(AssistantActionProposal, proposal_id)
        row.result_json = json.dumps(result)
        await db.commit()


def _pdu_result(pdu_id, name, payload, *, down):
    results = payload.get("results", [])
    switched = {item["outlet"] for item in results if item.get("ok") is True}
    failed = {item["outlet"] for item in results if item.get("ok") is not True}
    state = payload.get("state")
    if state:
        failed.update(state.get("failed", []))
    switched -= failed
    complete = state is not None if down else state is None
    ok = not failed and complete
    outcome = PduResult(pdu_id, name, ok, sorted(switched), sorted(failed),
                        "" if ok else "PDU maintenance state could not be verified")
    outcome.not_included = list(payload.get("not_included", []))
    return outcome


def _pdu_dict(outcome):
    return {**outcome.to_dict(), "not_included": list(getattr(outcome, "not_included", []))}


async def _probe_reachable(db, pdu_id):
    """Distinguish an outlet failure from a lost maintenance verification read."""
    from ...routers import pdus

    try:
        async with pdus.locked_pdu(pdu_id, db) as device:
            return bool((await pdus._fetch_status(pdu_id, device)).reachable)
    except Exception:
        return False


async def _maintenance_one(session_factory, proposal_id, by, pdu_id, name, request, impact, *, down, settings=None):
    # Inline PDU restores may share a shutdown proposal with a background job.
    # Serialize read/modify/write of its restore list across all maintenance kinds.
    async with _MAINTENANCE_LOCK:
        if settings is not None and not getattr(settings, "assistant_actions_enabled", False):
            raise _AbortJob("flag_off", PduResult(pdu_id, name, False, error="Assistant actions are disabled"))
        return await _maintenance_one_locked(session_factory, proposal_id, by, pdu_id, name, request, impact,
                                             down=down, settings=settings)


async def _maintenance_one_locked(session_factory, proposal_id, by, pdu_id, name, request, impact, *, down, settings):
    from ...routers import pdu_maintenance as maintenance

    async with session_factory() as db:
        proposal = await db.get(AssistantActionProposal, proposal_id)
        current = await db.get(PduMaintenance, pdu_id, populate_existing=True) if not down else None
        expected_started_at = current.started_at if current is not None else None
        if not down and (current is None or (
                "maintenance_started_at" in impact.get("pins", {}).get(pdu_id, {}) and
                expected_started_at != impact["pins"][pdu_id]["maintenance_started_at"])):
            raise _AbortJob("drift", PduResult(pdu_id, name, False, error="PDU maintenance session changed"))
        batch = proposal
        batches = [proposal] if down else []
        if not down and proposal.restore_of:
            batch = await db.get(AssistantActionProposal, proposal.restore_of)
            batches = [batch] if batch is not None else []
        elif not down:
            # A single-PDU restore also clears its old shutdown association, so
            # a later maintenance session cannot be adopted by that old batch.
            candidates = (await db.scalars(select(AssistantActionProposal).where(
                AssistantActionProposal.kind.in_(("rack_shutdown", "lab_shutdown", "pdu_shutdown")),
                AssistantActionProposal.batch_down_json != "[]"))).all()
            batches = []
            for item in candidates:
                try:
                    entries = _batch_entries(item)
                except (ValueError, TypeError):
                    continue  # Legacy batches never establish ownership of this maintenance session.
                if any(entry["pdu_id"] == pdu_id and entry["started_at"] == expected_started_at for entry in entries):
                    batches.append(item)
        if not down and proposal.kind == "batch_restore":
            entries = _batch_entries(batch) if batch is not None else []
            if (batch is None or batch.kind not in ("rack_shutdown", "lab_shutdown") or current is None
                    or not any(entry["pdu_id"] == pdu_id and entry["started_at"] == current.started_at
                               for entry in entries)):
                raise _AbortJob("drift", PduResult(pdu_id, name, False, error="PDU is not in the shutdown batch"))
        if batch is None:
            raise ValueError("Missing shutdown proposal")
        # A fresh session per PDU keeps no transaction open during the stagger.
        try:
            with _track_maintenance(db, batches, pdu_id, down=down, expected_started_at=expected_started_at):
                if down:
                    protection = await power_protection.load(db, settings)
                    if protection.errors or (proposal.kind in ("rack_shutdown", "lab_shutdown") and not protection.usable):
                        raise _AbortJob("error", PduResult(pdu_id, name, False,
                                                          error="Protected outlets configuration is invalid"))
                    exclude = protection.for_pdu(pdu_id) | frozenset(
                        item["outlet"] for item in impact.get("excluded", [])
                        if item["pdu_id"] == pdu_id and item.get("reason") == "protected"
                        and item.get("outlet") is not None)
                    expected = frozenset(impact.get("pins", {}).get(pdu_id, {}).get("on", []))
                    payload = await maintenance.shutdown_pdu(db, pdu_id, by, request.get("reason", ""),
                                                             exclude=exclude, expected_on=expected,
                                                             expected_pins=impact.get("pins", {}).get(pdu_id, {}))
                else:
                    payload = await maintenance.restore_pdu(
                        db, pdu_id, by, expected_pins=impact.get("pins", {}).get(pdu_id, {}))
            # Also honour the returned state (including injected implementations).
            # Failed/partial shutdowns still belong to this proposal's restore list.
            for item in batches:
                await db.refresh(item)
                if down and payload.get("state") is not None:
                    _batch_change(item, pdu_id, payload["state"]["started_at"], down=True)
                elif not down and payload.get("state") is None:
                    _batch_change(item, pdu_id, expected_started_at, down=False)
            await db.commit()
            outcome = _pdu_result(pdu_id, name, payload, down=down)
            unavailable = payload.get("unreachable") is True or payload.get("reachable") is False
            if not outcome.ok and "reachable" not in payload and "unreachable" not in payload:
                unavailable = not await _probe_reachable(db, pdu_id)
            if unavailable:
                outcome.ok = False
                outcome.error = "PDU is unavailable"
                raise _AbortJob("unreachable", outcome)
            return outcome
        except Exception as exc:
            await db.rollback()
            if isinstance(exc, _AbortJob):
                raise
            if isinstance(exc, _GenerationChanged):
                raise _AbortJob("drift", PduResult(pdu_id, name, False,
                                                   error="PDU maintenance session changed")) from None
            errors = (("MaintenanceDrift", "PDU state changed"),
                      ("MaintenanceConflict", "PDU maintenance conflict"),
                      ("MaintenanceUnavailable", "PDU is unavailable"))
            for class_name, message in errors:
                error_type = getattr(maintenance, class_name, None)
                if error_type is not None and isinstance(exc, error_type):
                    if class_name == "MaintenanceUnavailable":
                        raise _AbortJob("unreachable", PduResult(pdu_id, name, False, error=message)) from None
                    if class_name == "MaintenanceDrift":
                        raise _AbortJob("drift", PduResult(pdu_id, name, False, error=message)) from None
                    return PduResult(pdu_id, name, False, error=message)
            raise


def _status(targets, pdus):
    outcomes = targets + pdus
    if outcomes and all(item["ok"] for item in outcomes):
        return "succeeded"
    if any(item["ok"] for item in outcomes) or any(item["switched"] for item in pdus):
        return "partial"
    return "failed"


async def execute(proposal_id: str, by: str, *, session_factory, settings, sleep=asyncio.sleep) -> dict:
    """Run an already claimed proposal. Never let a device exception escape a task.

    Returns the stored result; the HTTP handler reloads the row for public JSON.
    Confirmation, ownership, drift and batch admission are checked by the router.
    """
    result = {"targets": [], "pdus": [], "consoles": [], "summary_he": _SUMMARIES["failed"]}
    try:
        from . import store

        async with session_factory() as db:
            row = await db.get(AssistantActionProposal, proposal_id)
            if row is None or row.status != "executing":
                return result  # Never replay a completed, cancelled or unclaimed action.
            kind = row.kind
            request = json.loads(row.request_json or "{}")
            impact = json.loads(row.impact_json or "{}")
            spec = KIND_SPECS[kind]
            targets = [Target(**item) for item in impact.get("targets", [])]
            pdu_ids = list(dict.fromkeys(impact.get("pdus", [])))
            names = {item["pdu_id"]: item["pdu_name"]
                     for item in impact.get("targets", []) + impact.get("excluded", [])}
            if spec.switch in ("maintenance_off", "maintenance_on"):
                for pdu_id in pdu_ids:
                    if pdu_id not in names:
                        device = await db.get(Device, pdu_id)
                        names[pdu_id] = device.name if device else pdu_id
            total = len(pdu_ids) if spec.switch.startswith("maintenance_") else len(targets)
            if spec.switch == "cycle":
                result["pending_on"] = [target.to_dict() for target in targets if target.state == "on"]
                result["pending_on_at"] = time.time()
                row.result_json = json.dumps(result)
            await _ensure_executing_event(db, proposal_id, by)
            await store.set_progress(db, proposal_id, 0, total)
            await db.commit()

        if spec.switch in ("off", "on", "cycle"):
            from . import power

            expected = {(target.pdu_id, target.outlet) for target in targets}
            seen = set()

            async def on_result(outcome):
                data = outcome.to_dict()
                key = data["pdu_id"], data["outlet"]
                if key not in expected or key in seen:
                    return
                seen.add(key)
                result["targets"].append(data)
                if spec.switch == "cycle":
                    _clear_pending(result, outcome)
                    if outcome.error == "PDU changed since the proposal":
                        # ACT-2's exact error is a preflight refusal before any
                        # off. Errors after an attempted off carry an abort prefix.
                        result["pending_on"] = []
                detail = {key: data[key] for key in ("pdu_id", "outlet", "ok", "state_after")}
                await _record(session_factory, proposal_id, by, "target", detail, len(seen), total, result)
                if _pins_refused(outcome):
                    raise _AbortJob("drift", PduResult(outcome.pdu_id, names.get(outcome.pdu_id, outcome.pdu_id),
                                                       False, error="PDU state changed"))

            try:
                if spec.switch == "cycle":
                    outcomes = await power.cycle(session_factory, targets, by,
                                                 off_seconds=getattr(settings, "assistant_action_cycle_off_seconds", 5.0),
                                                 sleep=sleep, on_result=on_result, pins=impact.get("pins", {}))
                else:
                    outcomes = await power.switch(session_factory, targets, spec.switch, by, on_result=on_result,
                                                  pins=impact.get("pins", {}))
                # Callbacks give live progress; the return list must not count twice.
                for outcome in outcomes:
                    await on_result(outcome)
                for target in targets:
                    if (target.pdu_id, target.outlet) not in seen:
                        await on_result(TargetResult(target.pdu_id, target.outlet, False, "unknown",
                                                     "Outlet state could not be verified"))
            except _AbortJob as exc:
                await _abort(session_factory, proposal_id, by, result, "drift",
                             exc.outcome.pdu_id, exc.outcome.pdu_name)
            except ActionError as exc:
                if exc.code != "drift":
                    raise
                target = next((item for item in targets if (item.pdu_id, item.outlet) not in seen), targets[0])
                await _abort(session_factory, proposal_id, by, result, "drift", target.pdu_id, target.pdu_name)
            if (spec.switch == "cycle" and request.get("then_console") and not result.get("aborted")
                    and _status(result["targets"], []) == "succeeded"):
                from . import resolve

                servers = impact.get("servers", []) or [t.server for t in targets if t.server]
                server = next(iter(servers), request.get("server"))
                if server:
                    async with session_factory() as db:
                        consoles = await resolve.consoles_for(db, server)
                        result["consoles"] = [console.to_dict() for console in consoles]
        elif spec.switch in ("maintenance_off", "maintenance_on"):
            down = spec.switch == "maintenance_off"
            for index, pdu_id in enumerate(pdu_ids):
                if not down and index:
                    await sleep(getattr(settings, "assistant_action_restore_stagger_seconds", 3.0))
                try:
                    outcome = await _maintenance_one(session_factory, proposal_id, by, pdu_id, names[pdu_id],
                                                     request, impact, down=down, settings=settings)
                except _AbortJob as exc:
                    if exc.reason != "flag_off":
                        result["pdus"].append(_pdu_dict(exc.outcome))
                        await _record(session_factory, proposal_id, by, "pdu", {"pdu_id": pdu_id, "ok": False},
                                      index + 1, total, result)
                    await _abort(session_factory, proposal_id, by, result, exc.reason, pdu_id, names[pdu_id])
                    break
                except Exception:
                    result["pdus"].append(_pdu_dict(PduResult(pdu_id, names[pdu_id], False, error=EXECUTION_ERROR)))
                    await _record(session_factory, proposal_id, by, "pdu", {"pdu_id": pdu_id, "ok": False},
                                  index + 1, total, result)
                    await _abort(session_factory, proposal_id, by, result, "error", pdu_id, names[pdu_id])
                    break
                result["pdus"].append(_pdu_dict(outcome))
                detail = {"pdu_id": pdu_id, "ok": outcome.ok, "switched": outcome.switched,
                          "failed": outcome.failed, "not_included": getattr(outcome, "not_included", [])}
                await _record(session_factory, proposal_id, by, "pdu", detail, index + 1, total, result)
        elif spec.switch == "none":
            result["consoles"] = impact.get("consoles", [])

        status = "succeeded" if spec.switch == "none" else _status(result["targets"], result["pdus"])
        if result.get("aborted"):
            status = "partial" if status in ("succeeded", "partial") else "failed"
        result["summary_he"] = _SUMMARIES[status]
        await _finish(session_factory, proposal_id, by, status, result)
    except (Exception, asyncio.CancelledError) as exc:
        # Exception messages may contain addresses, passwords or response bodies.
        status = "interrupted" if isinstance(exc, asyncio.CancelledError) else "failed"
        result["summary_he"] = (_SUMMARIES[status] if status == "interrupted" else
                                "הפעולה נכשלה עקב שגיאה פנימית. רכיבים שבתחזוקה עדיין ניתנים לשחזור.")
        try:
            await _finish(session_factory, proposal_id, by, status, result)
        except (Exception, asyncio.CancelledError):
            # An unavailable database cannot be audited now; startup recovery
            # handles the still-executing row once persistence is available.
            pass
    return result


def start_background(proposal_id, by, *, session_factory, settings) -> None:
    async def run():
        async with BATCH_LOCK:
            await execute(proposal_id, by, session_factory=session_factory, settings=settings)

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def recover_interrupted(session_factory) -> int:
    """Restore recent cycle journals, never resume shutdowns, then mark interrupted."""
    from . import power

    async with session_factory() as db:
        candidates = (await db.scalars(select(AssistantActionProposal).where(
            AssistantActionProposal.status.in_(("executing", "interrupted", "failed", "partial"))))).all()
    rows = []
    for row in candidates:
        if row.status == "executing":
            rows.append(row)
        elif row.kind in ("server_cycle", "outlet_cycle"):
            try:
                journal = json.loads(row.result_json or "{}")
                started_at = journal.get("pending_on_at", row.confirmed_at)
                if (_pending_targets(row, journal) and type(started_at) in (int, float)
                        and math.isfinite(started_at) and 0 <= time.time() - started_at < 600):
                    rows.append(row)
            except (ValueError, TypeError, AttributeError):
                pass
    for row in rows:
        result = {"targets": [], "pdus": [], "consoles": []}
        try:
            if row.result_json:
                result = json.loads(row.result_json)
                if not isinstance(result, dict):
                    raise ValueError("Invalid recovery journal")
            started_at = result.get("pending_on_at", row.confirmed_at)
            recent = (type(started_at) in (int, float) and math.isfinite(started_at)
                      and 0 <= time.time() - started_at < 600)
            if row.kind in ("server_cycle", "outlet_cycle") and result.get("pending_on") and recent:
                impact = json.loads(row.impact_json or "{}")
                targets = _pending_targets(row, result)
                wanted = {(target.pdu_id, target.outlet) for target in targets}
                result["pending_on"] = [target.to_dict() for target in targets]
                result["recovery_targets"] = []
                seen = set()

                async def on_result(outcome):
                    key = outcome.pdu_id, outcome.outlet
                    if key not in wanted or key in seen:
                        return
                    seen.add(key)
                    result["recovery_targets"].append(outcome.to_dict())
                    _clear_pending(result, outcome)
                    await _record(session_factory, row.id, "system", "target",
                                  {"pdu_id": outcome.pdu_id, "outlet": outcome.outlet,
                                   "ok": outcome.ok, "state_after": outcome.state_after, "recovery": True},
                                  row.progress_done, row.progress_total, result)
                    if _pins_refused(outcome):
                        name = next(target.pdu_name for target in targets if target.pdu_id == outcome.pdu_id)
                        await _abort(session_factory, row.id, "system", result, "drift", outcome.pdu_id, name)
                        raise _AbortJob("drift", PduResult(outcome.pdu_id, name, False, error="PDU state changed"))

                if targets:
                    async with session_factory() as db:
                        await _ensure_executing_event(db, row.id, "system")
                        await db.commit()
                    outcomes = await power.switch(session_factory, targets, "on", "system", on_result=on_result,
                                                  pins=impact.get("pins", {}))
                    for outcome in outcomes:
                        await on_result(outcome)
        except _AbortJob:
            pass
        except (Exception, asyncio.CancelledError):
            if not isinstance(result, dict):
                result = {"targets": [], "pdus": [], "consoles": []}
            result["recovery_error"] = EXECUTION_ERROR
        result["summary_he"] = _SUMMARIES["interrupted"]
        await _finish(session_factory, row.id, "system", "interrupted", result)
    return len(rows)
