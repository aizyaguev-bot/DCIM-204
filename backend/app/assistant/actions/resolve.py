"""Read-only action previews and the private snapshots used to refuse drift."""
from __future__ import annotations

import difflib
import json
import math
import time
import unicodedata
from urllib.parse import quote
from zoneinfo import ZoneInfo

from sqlalchemy import select

from ... import inventory_store, monitor_links, power_protection
from ...models import Device, MonitorDeviceSnapshot, PduMaintenance, PingTarget, PingTargetName, PxeJob
from ...ping_monitor import server_identity
from ...routers import kvms, pdus
from .contracts import DATA_KINDS, ActionError, Console, Excluded, Impact, KIND_SPECS, ProposalRequest, Target
from .models import AssistantActionProposal


def _protected(settings, devices):
    try:
        protection = power_protection.parse(getattr(settings, "power_protected_outlets", ""),
                                            [d for d in devices if d.kind == "pdu"])
    except (TypeError, ValueError, OverflowError):
        return None, ["הגדרת השקעים המוגנים אינה תקינה; יש לתקן אותה לפני פעולה."]
    warnings = ["הגדרת השקעים המוגנים אינה תקינה או מפנה ל־PDU לא מוכר; יש לתקן אותה לפני פעולה."] if protection.errors else []
    return (set(protection.outlets) if protection.usable else None), warnings


def _clean(value):
    return "".join(c for c in str(value) if unicodedata.category(c) not in ("Cc", "Cf", "Cs", "Zl", "Zp"))


def _display(impact):
    # Hardware identifiers stay exact. Refuse an unsafe id rather than redirecting it by cleaning it.
    ids = impact.pdus + [t.pdu_id for t in impact.targets] + [e.pdu_id for e in impact.excluded]
    ids += [c.kvm_id for c in impact.consoles]
    if any(_clean(value) != value for value in ids):
        raise ActionError(409, "invalid", "A device identifier contains unsafe display characters")
    for item in impact.targets:
        for name in ("pdu_name", "rack", "label", "server"):
            setattr(item, name, _clean(getattr(item, name)))
    for item in impact.excluded:
        for name in ("pdu_name", "rack", "label"):
            setattr(item, name, _clean(getattr(item, name)))
    for item in impact.consoles:
        item.kvm_name, item.label = _clean(item.kvm_name), _clean(item.label)
    impact.servers = [_clean(name) for name in impact.servers]
    impact.warnings_he = list(dict.fromkeys(_clean(warning) for warning in impact.warnings_he))
    return impact


def protected_outlets(settings, devices) -> set[tuple[str, int]] | None:
    """None means unconfigured/invalid; 'none' explicitly acknowledges no protection."""
    return _protected(settings, devices)[0]


async def _devices(db):
    return list((await db.scalars(select(Device).where(Device.kind.in_(("pdu", "kvm")))
                                 .order_by(Device.name, Device.id)
                                 .execution_options(populate_existing=True))).all())


async def _labels(db, devices):
    snapshots = {s.device_id: s for s in (await db.scalars(
        select(MonitorDeviceSnapshot).execution_options(populate_existing=True))).all()}
    labels = {}
    for dev in devices:
        snapshot = snapshots.get(dev.id)
        observed = {}
        if snapshot and (snapshot.kind, snapshot.ip) == (dev.kind, dev.ip):
            observed = {str(p["number"]): p["label"] for p in json.loads(snapshot.ports_json)}
        observed.update(dev.labels)
        labels[dev.id] = observed
    return labels


async def _index(db, settings, now):
    return await monitor_links.connection_index(
        db, ZoneInfo(getattr(settings, "ping_monitor_timezone", "Asia/Jerusalem")), now)


def _identity(label):
    identity = server_identity(label)
    return identity[1] if identity else ""


async def _server(db, query, index, labels):
    if not isinstance(query, str) or not query.strip():
        raise ActionError(400, "invalid", "A server name is required")
    query = query.strip().removeprefix("server:")
    identity = server_identity(query)
    key = identity[0] if identity else ""
    names = {}
    for ports in labels.values():
        for label in ports.values():
            canonical = server_identity(label)
            if canonical and "server:" + canonical[0] in index:
                names.setdefault(canonical[0], canonical[1])
    aliases = {name: {name} for name in names}
    overrides = {r.target_id: r.override for r in (await db.scalars(select(PingTargetName))).all()}
    for target in (await db.scalars(select(PingTarget))).all():
        canonical = server_identity(target.source_key.removeprefix("server:")
                                    if target.source_key.startswith("server:") else target.name)
        if not canonical:
            continue
        target_key = canonical[0]
        names.setdefault(target_key, canonical[1])
        for label in (target.id, target.name, overrides.get(target.id, "")):
            alias = server_identity(label)
            if alias:
                aliases.setdefault(alias[0], set()).add(target_key)
        aliases.setdefault(target_key, set()).add(target_key)
    exact = aliases.get(key, set())
    if len(exact) > 1:
        raise ActionError(409, "ambiguous", "Several servers match; use an exact server name",
                          [_clean(names[name]) for name in sorted(exact)[:5]])
    if exact:
        resolved = next(iter(exact))
        return resolved, names[resolved]
    # Partial names may explain ambiguity, but can never select a power target.
    matches = [name for name in names if key and key in name]
    if len(matches) > 1:
        raise ActionError(409, "ambiguous", "Several servers match; use an exact server name",
                          [_clean(names[name]) for name in sorted(matches)[:5]])
    closest = difflib.get_close_matches(key, sorted(names), n=5, cutoff=0)
    raise ActionError(404, "not_resolved", "Server was not resolved", [_clean(names[name]) for name in closest])


def _console_entries(server, index, devices, labels):
    identity = server_identity(server)
    entries = index.get("server:" + identity[0], {}).get("kvm", []) if identity else []
    by_id = {dev.id: dev for dev in devices if dev.kind == "kvm" and dev.enabled}
    result, seen = [], set()
    for entry in entries:
        dev = by_id.get(entry["device_id"])
        try:
            port = int(entry["port"])
        except (TypeError, ValueError):
            continue
        if not dev or port < 1 or (dev.id, port) in seen:
            continue
        seen.add((dev.id, port))
        result.append(Console(dev.id, dev.name, port, labels[dev.id].get(str(port), server),
                              f"/api/kvms/{quote(dev.id, safe='')}/autologin?port={port}"))
    return result


async def consoles_for(db, server: str) -> list[Console]:
    """Return all exact mapped consoles, without contacting a KVM or choosing a port."""
    devices = await _devices(db)
    labels = await _labels(db, devices)
    # Console mapping is independent of observation freshness and needs no live KVM read.
    index = await monitor_links.connection_index(db, ZoneInfo("UTC"), time.time())
    return _display(Impact(consoles=_console_entries(server, index, devices, labels))).consoles


def _pdu(query, devices):
    if not isinstance(query, str) or not query.strip():
        raise ActionError(400, "invalid", "A PDU id or exact name is required")
    query = query.strip()
    devices = [dev for dev in devices if dev.kind == "pdu"]
    matches = [dev for dev in devices if dev.id == query]
    if not matches:
        matches = [dev for dev in devices if dev.name == query]
    if len(matches) > 1:
        raise ActionError(409, "ambiguous", "Several PDUs have this name; use a PDU id",
                          [_clean(dev.name) for dev in matches[:5]])
    if not matches:
        raise ActionError(404, "not_resolved", "PDU was not resolved")
    return matches[0]


async def _live(dev):
    try:
        status = await pdus._fetch_status(dev.id, dev)
    except Exception:
        return None
    return status if status.reachable and status.outlets else None


def _pin(dev, maintenance, status):
    return {"labels_rev": inventory_store.revision(dev.labels), "ip": dev.ip,
            "enabled": bool(dev.enabled), "maintenance": maintenance is not None,
            "on": sorted(o.number for o in status.outlets if o.state == "on"),
            "known": sorted(o.number for o in status.outlets if o.state in ("on", "off")),
            "states": {str(o.number): o.state for o in status.outlets},
            "maintenance_started_at": maintenance.started_at if maintenance else None}


def _target(dev, outlet):
    # A stale learned label must not mask a label that was removed on the device.
    label = dev.labels.get(str(outlet.number), outlet.label)
    return Target(dev.id, dev.name, dev.rack, outlet.number, label, _identity(label), outlet.state)


def _exclude(impact, dev, reason, outlet=None, label=""):
    impact.excluded.append(Excluded(dev.id, dev.name, dev.rack, outlet, label, reason))


def _restore_numbers(row):
    try:
        numbers = json.loads(row.outlets_off_json or "[]")
        if not isinstance(numbers, list) or any(type(n) is not int or n < 1 for n in numbers):
            raise ValueError
        return sorted(set(numbers))
    except (TypeError, ValueError):
        raise ActionError(409, "invalid", "The maintenance restore list is invalid") from None


async def _pxe_held(db, server_names, consoles):
    keys = {i[0] for name in server_names if (i := server_identity(name))}
    ports = {f"{c.kvm_id}:{c.port}" for c in consoles}
    jobs = (await db.scalars(select(PxeJob).where(
        PxeJob.active_key.is_not(None) | PxeJob.active_port_key.is_not(None)))).all()
    return any((job.active_key or "").removeprefix("server:").casefold() in keys or job.active_port_key in ports
               for job in jobs)


async def _warnings(db, impact, server_names, consoles):
    if any(kvms._in_use.get(c.kvm_id, {}).get(c.port, 0) > time.monotonic() for c in consoles):
        impact.warnings_he.append("קונסולת KVM של שרת ביעד מסומנת כעת בשימוש; ייתכן שמישהו עובד עליו.")
    if await _pxe_held(db, server_names, consoles):
        impact.warnings_he.append("שרת ביעד מוחזק בידי עבודת PXE פעילה; שינוי חשמל עלול להפסיק את ההתקנה.")


async def build_impact(db, req: ProposalRequest, settings, now: float) -> Impact:
    spec = KIND_SPECS.get(req.kind)
    if spec is None:
        raise ActionError(400, "invalid", "Unknown action kind")
    if req.kind in DATA_KINDS:
        # Location changes switch no power: no PDU is read and protected outlets do not apply.
        from . import locations
        return await locations.build_impact(db, req)
    devices = await _devices(db)
    by_id = {dev.id: dev for dev in devices}
    labels = await _labels(db, devices)
    protected, warnings = _protected(settings, devices)
    if (spec.needs_protected and protected is None) or (warnings and spec.switch != "none"):
        raise ActionError(409, "protected_unset", "Protected outlets are not configured (POWER_PROTECTED_OUTLETS)")
    protected = protected or set()
    impact = Impact(warnings_he=warnings)
    index = None
    selected, wanted, server_names = [], {}, []
    batch = req.kind in ("rack_shutdown", "lab_shutdown")
    restore = spec.switch == "maintenance_on"

    if spec.scope == "server":
        index = await _index(db, settings, now)
        key, name = await _server(db, req.server, index, labels)
        server_names = [name]
        impact.consoles = await consoles_for(db, name) if req.then_console or req.kind == "open_console" else []
        if req.kind == "open_console":
            if not impact.consoles:
                raise ActionError(404, "not_resolved", "No KVM port is mapped to this server", [_clean(name)])
            await _warnings(db, impact, server_names, impact.consoles)
            return _display(impact)
        for entry in index.get("server:" + key, {}).get("pdu", []):
            dev = by_id[entry["device_id"]]
            try:
                number = int(entry["port"])
            except (TypeError, ValueError):
                raise ActionError(409, "invalid", "A mapped outlet number is invalid") from None
            if dev.id not in wanted:
                selected.append(dev)
                wanted[dev.id] = set()
            wanted[dev.id].add(number)
        if not selected:
            raise ActionError(404, "not_resolved", "No PDU outlet is mapped to this server", [_clean(name)])
    elif spec.scope in ("outlet", "pdu"):
        selected = [_pdu(req.pdu, devices)]
        if spec.scope == "outlet":
            if type(req.outlet) is not int or req.outlet < 1:
                raise ActionError(400, "invalid", "Outlet number must be a positive integer")
            wanted[selected[0].id] = {req.outlet}
    elif batch:
        if req.kind == "rack_shutdown" and (not isinstance(req.rack, str) or not req.rack.strip()):
            raise ActionError(400, "invalid", "A rack name is required")
        selected = [dev for dev in devices if dev.kind == "pdu" and (
            req.kind == "lab_shutdown" or dev.rack == req.rack)]
        if req.kind == "lab_shutdown":
            impact.warnings_he.append("המעבדה כולה תכבה מלבד השקעים המוגנים")
    elif req.kind == "batch_restore":
        source = await db.get(AssistantActionProposal, req.restore_of, populate_existing=True) if req.restore_of else None
        if (not source or source.kind not in ("rack_shutdown", "lab_shutdown") or
                source.status not in ("succeeded", "partial", "failed", "interrupted")):
            raise ActionError(409, "invalid", "Restore requires an executed rack or lab shutdown")
        try:
            entries = json.loads(source.batch_down_json or "[]")
            original = json.loads(source.request_json)
            if not isinstance(entries, list) or not entries:
                raise ValueError
            generations = {}
            for entry in entries:
                if (not isinstance(entry, dict) or not isinstance(entry.get("pdu_id"), str) or
                        type(entry.get("started_at")) not in (int, float) or not math.isfinite(entry["started_at"])):
                    raise ValueError
                if entry["pdu_id"] in generations and generations[entry["pdu_id"]] != entry["started_at"]:
                    raise ValueError
                generations[entry["pdu_id"]] = entry["started_at"]
            # ProposalRequest has no separate scope-name field; pin it in rack for the restore phrase.
            req.rack = None if source.kind == "lab_shutdown" else original["rack"]
            if source.kind == "rack_shutdown" and (not isinstance(req.rack, str) or not req.rack):
                raise ValueError
        except (KeyError, TypeError, ValueError):
            raise ActionError(409, "no_targets", "Nothing to restore for this batch") from None
        for device_id, started_at in generations.items():
            dev = by_id.get(device_id)
            if not dev or dev.kind != "pdu":
                raise ActionError(409, "invalid", "A PDU in the restore batch is no longer available")
            row = await db.get(PduMaintenance, dev.id, populate_existing=True)
            if not row or row.started_at != started_at:
                _exclude(impact, dev, "not_in_batch")
                continue
            selected.append(dev)

    for dev in selected:
        maintenance = await db.get(PduMaintenance, dev.id, populate_existing=True)
        if req.kind == "batch_restore" and (not maintenance or maintenance.started_at != generations[dev.id]):
            _exclude(impact, dev, "not_in_batch")
            continue
        if batch and (not dev.enabled or maintenance):
            _exclude(impact, dev, "disabled" if not dev.enabled else "maintenance")
            continue
        if not dev.enabled:
            raise ActionError(409, "invalid", "A target PDU is disabled", [_clean(dev.name)])
        status = await _live(dev)
        if status is None:
            if batch:
                _exclude(impact, dev, "unreachable")
                continue
            raise ActionError(409, "invalid", "A target PDU is unreachable", [_clean(dev.name)])
        outlets = {o.number: o for o in status.outlets}
        if any(pdu_id == dev.id and number not in outlets for pdu_id, number in protected):
            raise ActionError(409, "protected_unset", "A protected outlet is missing from the live PDU status")
        # Device.port_count and cached snapshots never establish an outlet's existence.
        if dev.id in wanted and not wanted[dev.id] <= outlets.keys():
            raise ActionError(400, "invalid", "Outlet number is outside the live PDU outlet range")
        if restore:
            if not maintenance:
                raise ActionError(409, "invalid", "PDU is not in maintenance mode")
            numbers = set(_restore_numbers(maintenance))
            if not numbers <= outlets.keys():
                raise ActionError(409, "invalid", "A restore outlet is missing from the live PDU status")
        elif maintenance:
            raise ActionError(409, "invalid", "A target PDU is already in maintenance mode", [_clean(dev.name)])
        elif spec.switch == "maintenance_off":
            numbers = set(outlets)
        else:
            numbers = wanted[dev.id]

        targets = []
        for number in sorted(numbers):
            outlet = outlets[number]
            target = _target(dev, outlet)
            if (dev.id, number) in protected:
                if spec.switch != "maintenance_off":
                    raise ActionError(409, "protected", "Outlet is protected", [_clean(dev.name), str(number)])
                _exclude(impact, dev, "protected", number, target.label)
                continue
            if spec.switch in ("maintenance_off", "cycle") and outlet.state != "on":
                _exclude(impact, dev, "already_off" if outlet.state == "off" else "unknown_state", number, target.label)
                if spec.switch == "cycle" and outlet.state == "off":
                    impact.warnings_he.append(f"שקע {number} ב־{dev.name} כבוי ויישאר כבוי גם לאחר הריסט.")
            else:
                targets.append(target)
            if outlet.state not in ("on", "off"):
                impact.warnings_he.append(f"מצב שקע {number} ב־{dev.name} אינו ידוע בוודאות.")
            identity = server_identity(target.label)
            if spec.scope == "server" and (not identity or identity[0] != key):
                raise ActionError(409, "ambiguous", "A live outlet label no longer matches the server", [_clean(dev.name)])
        if not targets and spec.switch not in ("cycle", "maintenance_on"):
            continue
        impact.targets.extend(targets)
        impact.pdus.append(dev.id)
        pin = _pin(dev, maintenance, status)
        # Pin live labels too: observed labels can change without a saved-label revision.
        pinned_numbers = numbers if spec.switch == "cycle" else {t.outlet for t in targets}
        pin["target_labels"] = {str(number): _target(dev, outlets[number]).label for number in pinned_numbers}
        if restore:
            pin["outlets_off"] = _restore_numbers(maintenance)
        if batch:
            pin["scope"] = {"rack": req.rack if req.kind == "rack_shutdown" else None,
                            "pdus": sorted(d.id for d in selected)}
        if spec.scope == "server":
            pin["server_key"] = key
            pin["server_feeds"] = sorted([device_id, number] for device_id, numbers in wanted.items() for number in numbers)
        impact.pins[dev.id] = pin

    if not impact.pdus or (not impact.targets and not restore):
        raise ActionError(409, "no_targets", "No actionable PDU outlets remain in this scope")
    canonical = {}
    for target in impact.targets:
        identity = server_identity(target.label)
        if identity:
            canonical.setdefault(identity[0], identity[1])
    impact.servers = sorted(canonical.values(), key=str.casefold)
    # Warn on every affected server even when the console is not part of the requested result.
    warning_consoles = []
    if index is None:
        index = await _index(db, settings, now)
    for name in impact.servers:
        warning_consoles.extend(_console_entries(name, index, devices, labels))
    if req.then_console and not impact.consoles:
        impact.consoles = warning_consoles
        if not impact.consoles:
            impact.warnings_he.append("לא נמצא מיפוי KVM ליעדים; לא ניתן יהיה להציע פתיחת קונסולה בסיום.")
    await _warnings(db, impact, impact.servers, warning_consoles)
    return _display(impact)


async def check_drift(db, kind: str, impact: dict, settings) -> list[str]:
    """Return fixed, secret-free Hebrew reasons; no switching and no cached status reads."""
    if kind == "open_console":
        return []
    if kind in DATA_KINDS:
        from . import locations
        return await locations.check_drift(db, kind, impact)
    pins = impact.get("pins")
    if not isinstance(pins, dict) or not pins or set(impact.get("pdus", [])) != set(pins):
        return ["חסרה תמונת מצב פרטית של יעדי הפעולה; יש ליצור הצעה חדשה."]
    devices = await _devices(db)
    labels = await _labels(db, devices)
    by_id = {dev.id: dev for dev in devices if dev.kind == "pdu"}
    protected, warnings = _protected(settings, devices)
    reasons = []
    if (KIND_SPECS.get(kind) and KIND_SPECS[kind].needs_protected and protected is None) or warnings:
        reasons.append("הגדרת השקעים המוגנים חסרה או אינה תקינה.")
    for device_id, pin in pins.items():
        dev = by_id.get(device_id)
        if not dev:
            reasons.append("PDU שהיה ביעד הוסר או שסוגו השתנה.")
            continue
        maintenance = await db.get(PduMaintenance, device_id, populate_existing=True)
        fields = ((inventory_store.revision(dev.labels) != pin.get("labels_rev"), "תוויות השקעים השתנו"),
                  (dev.ip != pin.get("ip"), "כתובת ההתקן השתנתה"),
                  (bool(dev.enabled) != pin.get("enabled"), "מצב ההפעלה של ההתקן השתנה"),
                  ((maintenance is not None) != pin.get("maintenance"), "מצב התחזוקה השתנה"),
                  (maintenance is not None and maintenance.started_at != pin.get("maintenance_started_at"),
                   "רשומת התחזוקה הוחלפה"))
        changed = [message for condition, message in fields if condition]
        reasons.extend(f"{dev.name}: {message}." for message in changed)
        if "scope" in pin:
            scope = pin["scope"]
            current = sorted(d.id for d in devices if d.kind == "pdu" and (
                scope["rack"] is None or d.rack == scope["rack"]))
            if current != scope["pdus"]:
                reasons.append("רשימת יחידות ה־PDU בהיקף הפעולה השתנתה.")
        if "outlets_off" in pin and maintenance:
            try:
                restore_changed = _restore_numbers(maintenance) != pin["outlets_off"]
            except ActionError:
                restore_changed = True
            if restore_changed:
                reasons.append(f"{dev.name}: רשימת השקעים להחזרה מתחזוקה השתנתה.")
        # Never contact a redirected/disabled device just to confirm already established drift.
        if changed:
            continue
        status = await _live(dev)
        if status is None:
            reasons.append(f"{dev.name}: לא ניתן לקרוא את מצב השקעים כעת.")
            continue
        fresh = _pin(dev, maintenance, status)
        if kind not in ("rack_shutdown", "lab_shutdown") and fresh["known"] != pin.get("known"):
            reasons.append(f"{dev.name}: זמינות מצב השקעים השתנתה.")
        if kind not in ("rack_shutdown", "lab_shutdown") and fresh["states"] != pin.get("states"):
            reasons.append(f"{dev.name}: מצב החשמל השתנה מאז ההצעה.")
        outlets = {o.number: o for o in status.outlets}
        for target in (t for t in impact.get("targets", []) if t.get("pdu_id") == device_id):
            number = target["outlet"]
            if protected and (device_id, number) in protected:
                reasons.append(f"{dev.name}: שקע ביעד מוגדר כעת כמוגן.")
            outlet = outlets.get(number)
            if not outlet:
                reasons.append(f"{dev.name}: שקע שהיה ביעד חסר בקריאה החיה.")
            elif _target(dev, outlet).label != pin.get("target_labels", {}).get(str(number), target["label"]):
                reasons.append(f"{dev.name}: תווית חיה של שקע ביעד השתנתה.")
        for number, label in pin.get("target_labels", {}).items():
            outlet = outlets.get(int(number))
            if outlet and _target(dev, outlet).label != label:
                reasons.append(f"{dev.name}: תווית חיה של שקע ביעד השתנתה.")
    server_names = [label for pin in pins.values() for label in pin.get("target_labels", {}).values()]
    index = await _index(db, settings, time.time())
    for pin in pins.values():
        if "server_feeds" in pin:
            feeds = index.get("server:" + pin["server_key"], {}).get("pdu", [])
            current_feeds = sorted([feed["device_id"], int(feed["port"])] for feed in feeds)
            if current_feeds != pin["server_feeds"]:
                reasons.append("מיפוי הזנות החשמל של השרת השתנה; יש לבדוק מחדש את כל ההזנות.")
    consoles = [c for name in server_names for c in _console_entries(name, index, devices, labels)]
    if await _pxe_held(db, server_names, consoles):
        reasons.append("שרת ביעד מוחזק בידי עבודת PXE פעילה; הפעולה לא תבוצע.")
    return list(dict.fromkeys(_clean(reason) for reason in reasons))
