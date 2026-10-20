"""PDU switching for confirmed actions; only a live read-back proves success."""
from __future__ import annotations

import asyncio
import math

from fastapi import HTTPException

from ... import power_protection
from ...config import get_settings
from ...models import PduMaintenance
from ...routers import pdus
from drivers.raritan_pdu import safe_error
from .contracts import Target, TargetResult


def _groups(targets: list[Target]) -> dict[str, list[Target]]:
    groups: dict[str, list[Target]] = {}
    for target in targets:
        groups.setdefault(target.pdu_id, []).append(target)
    return groups


def _failed(targets: list[Target], error: str) -> list[TargetResult]:
    return [TargetResult(t.pdu_id, t.outlet, False, "unknown", error) for t in targets]


async def _refusal(db, dev, action: str) -> str:
    if not dev.enabled:
        return "PDU is disabled"
    if action == "on" and await db.get(PduMaintenance, dev.id, populate_existing=True):
        return "PDU is in maintenance mode"
    return ""


def _valid_outlet(target: Target, port_count: int) -> bool:
    return (type(target.outlet) is int and target.outlet > 0
            and (port_count <= 0 or target.outlet <= port_count))


async def _target_errors(db, dev, targets: list[Target]) -> dict[int, str]:
    protection = await power_protection.load(db, get_settings())
    errors = {}
    for target in targets:
        if not _valid_outlet(target, dev.port_count):
            errors[target.outlet] = "Outlet is out of range"
        elif protection.errors:
            errors[target.outlet] = "Protected outlets configuration is invalid"
        elif protection.is_protected(dev.id, target.outlet):
            errors[target.outlet] = "Outlet is protected"
    return errors


async def _readback(device_id, dev):
    try:
        status = await pdus._fetch_status(device_id, dev)
        states = {o.number: o.state for o in status.outlets} if status.reachable else {}
        return {n: state if state in ("on", "off", "cycling", "unknown") else "unknown"
                for n, state in states.items()}, "PDU status could not be verified"
    except Exception as exc:
        return {}, safe_error(exc)


async def _switch_pdu(session_factory, targets: list[Target], action: str) -> list[TargetResult]:
    device_id = targets[0].pdu_id
    try:
        async with session_factory() as db:
            async with pdus.locked_pdu(device_id, db) as dev:
                refusal = await _refusal(db, dev, action)
                if refusal:
                    return _failed(targets, refusal)
                errors = await _target_errors(db, dev, targets)
                valid = [t for t in targets if t.outlet not in errors]
                if not valid:
                    return [TargetResult(device_id, t.outlet, False, "unknown", errors[t.outlet])
                            for t in targets]

                # Use the router's decryption and driver seams, including in the live re-read.
                try:
                    username, password = pdus.get_creds(dev)
                except Exception:
                    return _failed(targets, "PDU credentials could not be decrypted")
                driver = pdus.RaritanPduDriver(dev.ip, username, password)
                attempted = False
                try:
                    if dev.port_count <= 0:
                        known = {o["number"] for o in await driver.get_outlets()}
                        for target in valid:
                            if target.outlet not in known:
                                errors[target.outlet] = "Outlet is out of range"
                    for target in valid:
                        if target.outlet in errors:
                            continue
                        attempted = True
                        try:
                            if not await driver.set_outlet_state(target.outlet, action):
                                errors[target.outlet] = "PDU did not confirm the power command"
                        except Exception as exc:
                            errors[target.outlet] = safe_error(exc)
                finally:
                    pdus._cache.pop(device_id, None)
                    try:
                        await driver.close()
                    except Exception:
                        # A close failure says nothing about whether the outlet changed.
                        pass

                if not attempted:
                    return _failed(targets, "Outlet is out of range")
                states, read_error = await _readback(device_id, dev)

                results = []
                for target in targets:
                    state = states.get(target.outlet, "unknown")
                    valid_outlet = target in valid and errors.get(target.outlet) != "Outlet is out of range"
                    ok = valid_outlet and state == action
                    error = "" if ok else errors.get(target.outlet) or (
                        read_error if state == "unknown" else "Outlet did not reach the requested state")
                    results.append(TargetResult(device_id, target.outlet, ok, state, error))
                return results
    except HTTPException:
        return _failed(targets, "PDU not found")
    except Exception as exc:
        return _failed(targets, safe_error(exc))


async def _report(results: list[TargetResult], on_result) -> list[TargetResult]:
    if on_result is not None:
        for result in results:
            await on_result(result)
    return results


async def switch(session_factory, targets: list[Target], action: str, by: str,
                 on_result=None) -> list[TargetResult]:
    """Switch each PDU under its maintenance lock; the caller owns auditing as ``by``."""
    if action not in ("on", "off"):
        return await _report(_failed(targets, "Unknown action; use on or off"), on_result)
    results = []
    for group in _groups(targets).values():
        group_results = await _switch_pdu(session_factory, group, action)
        results.extend(await _report(group_results, on_result))
    return results


async def _cycle_preflight(session_factory, targets: list[Target]) -> dict[tuple[str, int], str]:
    """Check all feeds before the first off, as RaritanPower.cycle does."""
    errors = {}
    for group in _groups(targets).values():
        try:
            async with session_factory() as db:
                async with pdus.locked_pdu(group[0].pdu_id, db) as dev:
                    refusal = await _refusal(db, dev, "on")
                    target_errors = await _target_errors(db, dev, group)
                    for target in group:
                        error = refusal or target_errors.get(target.outlet, "")
                        if error:
                            errors[target.pdu_id, target.outlet] = error
        except HTTPException:
            errors.update({(t.pdu_id, t.outlet): "PDU not found" for t in group})
        except Exception as exc:
            errors.update({(t.pdu_id, t.outlet): safe_error(exc) for t in group})
    return errors


async def _verify_targets(session_factory, targets: list[Target], expected: str) -> list[TargetResult]:
    results = []
    for device_id, group in _groups(targets).items():
        try:
            async with session_factory() as db:
                async with pdus.locked_pdu(device_id, db) as dev:
                    states, read_error = await _readback(device_id, dev)
                    pdus._cache.pop(device_id, None)
                    for target in group:
                        state = states.get(target.outlet, "unknown")
                        error = "" if state == expected else (read_error if state == "unknown"
                                                               else "Outlet did not remain in the expected state")
                        results.append(TargetResult(device_id, target.outlet, state == expected, state, error))
        except HTTPException:
            results.extend(_failed(group, "PDU not found"))
        except Exception as exc:
            results.extend(_failed(group, safe_error(exc)))
    return results


async def _shielded(operation):
    """Finish recovery or final reporting before propagating caller cancellation."""
    task = asyncio.create_task(operation)
    cancelled = False
    while True:
        try:
            return await asyncio.shield(task), cancelled
        except asyncio.CancelledError:
            if task.cancelled():
                raise
            cancelled = True


async def cycle(session_factory, targets: list[Target], by: str, *, off_seconds: float,
                sleep=asyncio.sleep, on_result=None) -> list[TargetResult]:
    """Cycle feeds that were on; always restore every attempted feed in ``finally``.

    Callbacks describe final cycle outcomes once per target, so audit/progress never
    mistake an intermediate off for a completed cycle.
    """
    if not targets:
        return []
    if type(off_seconds) not in (int, float) or not math.isfinite(off_seconds) or off_seconds < 0:
        return await _report(_failed(targets, "Invalid power cycle delay"), on_result)
    errors = await _cycle_preflight(session_factory, targets)
    for target in targets:
        if target.state not in ("on", "off"):
            errors[target.pdu_id, target.outlet] = "Outlet state is not known"
    if errors:
        results = [TargetResult(t.pdu_id, t.outlet, False, "unknown",
                                errors.get((t.pdu_id, t.outlet), "Power cycle was not started"))
                   for t in targets]
        return await _report(results, on_result)

    active = [t for t in targets if t.state == "on"]
    stays_off = [t for t in targets if t.state == "off"]
    if not active:
        results = await _verify_targets(session_factory, stays_off, "off")
        for result in results:
            result.ok = False
            result.error = "All target outlets are already off"
        return await _report(results, on_result)

    attempted = []
    failure = ""
    cancelled = False
    try:
        for target in active:
            attempted.append(target)
            result = (await switch(session_factory, [target], "off", by))[0]
            if not result.ok:
                failure = result.error
                break
        if not failure:
            await sleep(off_seconds)
    except asyncio.CancelledError:
        failure = "Power cycle was cancelled"
        cancelled = True
    except Exception as exc:
        failure = safe_error(exc)
    finally:
        # The failed off may have acted even when its response or live read was lost.
        # Never add outlets outside the attempted list, and never abandon recovery
        # because the caller is cancelled (including cancellation during on).
        restore_results, restore_cancelled = await _shielded(switch(session_factory, attempted, "on", by))
        cancelled = cancelled or restore_cancelled
    if cancelled and not failure:
        failure = "Power cycle was cancelled"

    async def finish_results():
        restored = {(r.pdu_id, r.outlet): r for r in restore_results}
        restored.update({(r.pdu_id, r.outlet): r
                         for r in await _verify_targets(session_factory, stays_off, "off")})
        unattempted = [t for t in active if t not in attempted]
        restored.update({(r.pdu_id, r.outlet): r
                         for r in await _verify_targets(session_factory, unattempted, "on")})
        results = []
        for target in targets:
            key = target.pdu_id, target.outlet
            result = restored.get(key)
            state = result.state_after if result is not None else "unknown"
            if not failure and result is not None:
                results.append(result)
                continue
            if result is not None and not result.ok:
                error = "Power cycle aborted; power could not be restored: " + restored[key].error
            else:
                error = "Power cycle aborted: " + failure
            results.append(TargetResult(target.pdu_id, target.outlet, False, state, error))
        return await _report(results, on_result)

    results, final_cancelled = await _shielded(finish_results())
    if cancelled or final_cancelled:
        raise asyncio.CancelledError
    return results
