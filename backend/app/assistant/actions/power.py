"""PDU switching for confirmed actions; only a live read-back proves success."""
from __future__ import annotations

import asyncio
import math
from contextlib import AsyncExitStack

from fastapi import HTTPException

from ... import inventory_store, power_protection
from ...config import get_settings
from ...models import PduMaintenance
from ...pdu_locks import maintenance_lock
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


async def _target_errors(db, dev, targets: list[Target], *, protection_checked=False) -> dict[int, str]:
    protection = None if protection_checked else await power_protection.load(db, get_settings())
    errors = {}
    for target in targets:
        if not _valid_outlet(target, dev.port_count):
            errors[target.outlet] = "Outlet is out of range"
        elif protection is not None and protection.errors:
            errors[target.outlet] = "Protected outlets configuration is invalid"
        elif protection is not None and protection.is_protected(dev.id, target.outlet):
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


def _pins_changed(dev, pins) -> bool:
    if pins is None:
        return False
    pin = pins.get(dev.id)
    return (not isinstance(pin, dict) or pin.get("ip") != dev.ip
            or pin.get("enabled") != dev.enabled
            or pin.get("labels_rev") != inventory_store.revision(dev.labels))


async def _switch_locked(db, dev, targets: list[Target], action: str, pins=None, *,
                         protection_checked=False) -> list[TargetResult]:
    """Switch using a device verified under the caller's lock; never acquire a lock."""
    device_id = dev.id
    if _pins_changed(dev, pins):
        return _failed(targets, "PDU changed since the proposal")
    refusal = await _refusal(db, dev, action)
    if refusal:
        return _failed(targets, refusal)
    errors = await _target_errors(db, dev, targets, protection_checked=protection_checked)
    valid = [t for t in targets if t.outlet not in errors]
    if not valid:
        return [TargetResult(device_id, t.outlet, False, "unknown", errors[t.outlet]) for t in targets]

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


async def _switch_pdu(session_factory, targets: list[Target], action: str, pins=None) -> list[TargetResult]:
    try:
        async with session_factory() as db:
            async with pdus.locked_pdu(targets[0].pdu_id, db) as dev:
                return await _switch_locked(db, dev, targets, action, pins)
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
                 on_result=None, *, pins=None) -> list[TargetResult]:
    """Switch each PDU under its maintenance lock; the caller owns auditing as ``by``."""
    if action not in ("on", "off"):
        return await _report(_failed(targets, "Unknown action; use on or off"), on_result)
    results = []
    for group in _groups(targets).values():
        group_results = await _switch_pdu(session_factory, group, action, pins)
        results.extend(await _report(group_results, on_result))
    return results


async def _cycle_preflight_locked(session_factory, targets: list[Target], pins):
    """Read and pin snapshots after ALL cycle locks are held; close every session."""
    errors = {}
    devices = {}
    for group in _groups(targets).values():
        try:
            async with session_factory() as db:
                dev = await pdus._get_pdu_or_404(group[0].pdu_id, db)
                devices[dev.id] = dev
                refusal = ("PDU changed since the proposal" if _pins_changed(dev, pins)
                           else await _refusal(db, dev, "on"))
                target_errors = await _target_errors(db, dev, group)
                for target in group:
                    error = refusal or target_errors.get(target.outlet, "")
                    if error:
                        errors[target.pdu_id, target.outlet] = error
        except HTTPException:
            errors.update({(t.pdu_id, t.outlet): "PDU not found" for t in group})
        except Exception as exc:
            errors.update({(t.pdu_id, t.outlet): safe_error(exc) for t in group})
    if errors or any(t.state not in ("on", "off") for t in targets) or not any(t.state == "on" for t in targets):
        # Already refused (no PDU is contacted), refused below as "Outlet state is not known", or nothing to switch.
        return devices, errors
    # D3 under every lock (Codex ACT-CX-FINAL B1): each outlet must still be as proposed. A feed switched off (or on)
    # while this job waited for the locks is drift: nothing is switched, so the cycle never turns such a feed on.
    for device_id, group in _groups(targets).items():
        try:
            states, read_error = await _readback(device_id, devices[device_id])
        except Exception as exc:
            states, read_error = {}, safe_error(exc)
        for target in group:
            if not states:
                errors[target.pdu_id, target.outlet] = read_error
            elif states.get(target.outlet) != target.state:
                errors[target.pdu_id, target.outlet] = "PDU changed since the proposal"
    return devices, errors


async def _cycle_switch_locked(session_factory, devices, targets: list[Target], action: str, pins):
    results = []
    for device_id, group in _groups(targets).items():
        try:
            async with session_factory() as db:
                # Every cycle target passed protection under all locks before off.
                # Unrelated inventory edits must not invalidate that approval and
                # strand a feed during finally recovery.
                results.extend(await _switch_locked(db, devices[device_id], group, action, pins,
                                                      protection_checked=True))
        except Exception as exc:
            results.extend(_failed(group, safe_error(exc)))
    return results


async def _verify_targets_locked(session_factory, devices, targets: list[Target], expected: str):
    results = []
    for device_id, group in _groups(targets).items():
        try:
            states, read_error = await _readback(device_id, devices[device_id])
            pdus._cache.pop(device_id, None)
            for target in group:
                state = states.get(target.outlet, "unknown")
                error = "" if state == expected else (read_error if state == "unknown"
                                                       else "Outlet did not remain in the expected state")
                results.append(TargetResult(device_id, target.outlet, state == expected, state, error))
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


async def _cycle_locked(session_factory, targets, *, off_seconds, sleep, pins):
    devices, errors = await _cycle_preflight_locked(session_factory, targets, pins)
    for target in targets:
        if target.state not in ("on", "off"):
            errors[target.pdu_id, target.outlet] = "Outlet state is not known"
    if errors:
        results = [TargetResult(t.pdu_id, t.outlet, False, "unknown",
                                errors.get((t.pdu_id, t.outlet), "Power cycle was not started"))
                   for t in targets]
        return results, False

    active = [t for t in targets if t.state == "on"]
    stays_off = [t for t in targets if t.state == "off"]
    if not active:
        results = await _verify_targets_locked(session_factory, devices, stays_off, "off")
        for result in results:
            result.ok = False
            result.error = "All target outlets are already off"
        return results, False

    attempted = []
    failure = ""
    cancelled = False
    try:
        for target in active:
            attempted.append(target)
            result = (await _cycle_switch_locked(session_factory, devices, [target], "off", pins))[0]
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
        # Reuse the snapshots verified after acquiring every lock. Address/enabled
        # edits are blocked by those locks; an unlocked label edit must not prevent
        # restoring the same approved endpoints after they have been turned off.
        restore_results, restore_cancelled = await _shielded(
            _cycle_switch_locked(session_factory, devices, attempted, "on", pins))
        cancelled = cancelled or restore_cancelled
    if cancelled and not failure:
        failure = "Power cycle was cancelled"

    async def finish_results():
        restored = {(r.pdu_id, r.outlet): r for r in restore_results}
        restored.update({(r.pdu_id, r.outlet): r
                         for r in await _verify_targets_locked(session_factory, devices, stays_off, "off")})
        unattempted = [t for t in active if t not in attempted]
        restored.update({(r.pdu_id, r.outlet): r
                         for r in await _verify_targets_locked(session_factory, devices, unattempted, "on")})
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
        return results

    results, final_cancelled = await _shielded(finish_results())
    return results, cancelled or final_cancelled


async def cycle(session_factory, targets: list[Target], by: str, *, off_seconds: float,
                sleep=asyncio.sleep, on_result=None, pins=None) -> list[TargetResult]:
    """Hold all involved PDU locks across off/wait/on and shield attempted-feed recovery.

    The fixed lock order also applies to feeds that stay off. Internal helpers do
    not re-lock. Final callbacks run once per target after releasing every lock.
    """
    if not targets:
        return []
    if type(off_seconds) not in (int, float) or not math.isfinite(off_seconds) or off_seconds < 0:
        return await _report(_failed(targets, "Invalid power cycle delay"), on_result)
    async with AsyncExitStack() as locks:
        for device_id in sorted(_groups(targets)):
            await locks.enter_async_context(maintenance_lock(device_id))
        results, cancelled = await _cycle_locked(session_factory, targets, off_seconds=off_seconds,
                                                sleep=sleep, pins=pins)
    _, report_cancelled = await _shielded(_report(results, on_result))
    if cancelled or report_cancelled:
        raise asyncio.CancelledError
    return results
