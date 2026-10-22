"""Durable server ICMP monitoring, independent of open browser sessions."""
import asyncio
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
import ipaddress
import json
import logging
import math
import os
from pathlib import Path
import re
import subprocess
import time
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from . import inventory_store
from .config import get_settings
from .database import AsyncSessionLocal
from .models import Device, PingIncident, PingMonitorState, PingSample, PingTarget

log = logging.getLogger(__name__)
LEASE_SECONDS = 120
SAMPLE_DAYS = 30
INCIDENT_DAYS = 90
CONCURRENCY = 8
IS_WINDOWS = os.name == "nt"


def validate_host(value: str) -> str:
    """Accept one IP or DNS hostname, never URLs, options or shell expressions."""
    value = value.strip()
    if not value:
        return ""
    try:
        # Scoped IPv6 addresses are intentionally not accepted.
        if "%" not in value:
            return str(ipaddress.ip_address(value))
    except ValueError:
        pass
    if len(value) > 253 or not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", part)
                                   for part in value.rstrip(".").split(".")):
        raise ValueError("Enter a single IP address or DNS hostname (without http://, ports or spaces).")
    return value.lower()


def interval_minutes(now: float, zone: ZoneInfo) -> int:
    hour = datetime.fromtimestamp(now, zone).hour
    return 5 if 7 <= hour < 20 else 30


def next_slot(now: float, zone: ZoneInfo) -> float:
    # Walk UTC minutes: local DST gaps/repeated hours cannot create invalid times.
    candidate = (math.floor(now / 60) + 1) * 60
    for _ in range(61):
        local = datetime.fromtimestamp(candidate, zone)
        if local.minute % interval_minutes(candidate, zone) == 0:
            return candidate
        candidate += 60
    raise RuntimeError("No monitoring slot found")


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None


def server_identity(name):
    name = str(name or "").strip()
    if not name or re.fullmatch(r"(?:outlet|port)\s*\d+", name, re.I):
        return None
    # Multiple power feeds and descriptive suffixes refer to the same OPT host.
    match = re.fullmatch(r"(optn?\d+)(?:\s*\([^)]*\))?", name, re.I)
    canonical = match[1] if match else name
    try:
        host = validate_host(canonical)
    except ValueError:
        host = ""
    return canonical.casefold(), canonical, host


async def inventory_sources(db):
    """Read current server identities without writing targets or probing hardware."""
    from .routers import pdus, kvms
    devices = (await db.execute(select(Device).order_by(Device.id))).scalars().all()
    found = {}
    for dev in devices:
        if dev.kind not in ("pdu", "kvm"):
            continue
        labels = dict(dev.labels)
        cached = (pdus._cache if dev.kind == "pdu" else kvms._cache).get(dev.id)
        if cached:
            entries = cached[1].outlets if dev.kind == "pdu" else cached[1].ports
            for entry in entries:
                labels.setdefault(str(entry.number), entry.label)
        for name in labels.values():
            identity = server_identity(name)
            if identity:
                key, canonical, host = identity
                found.setdefault(key, (canonical, host, dev.rack))
    for rack, items in inventory_store.read_items().items():
        for item in items:
            if item.get("type") not in ("computer", "server"):
                continue
            identity = server_identity(item.get("name"))
            if identity:
                key, name, host = identity
                explicit = item.get("ip") or item.get("hostname")
                if explicit:
                    try:
                        host = validate_host(str(explicit))
                    except ValueError:
                        host = ""
                found[key] = (name, host, rack)
    return found


async def discover_targets(db):
    """Import current inventory while preserving addresses, pause and history."""
    found = await inventory_sources(db)
    existing = {t.source_key: t for t in (await db.execute(select(PingTarget))).scalars()}
    for key, (name, host, rack) in found.items():
        source_key = "server:" + key
        if source_key not in existing:
            try:
                async with db.begin_nested():
                    db.add(PingTarget(id=uuid4().hex, source_key=source_key, name=name, host=host, rack=rack))
                    await db.flush()
            except IntegrityError:
                pass  # A manual add of this server won the race.
        elif existing[source_key].source == "inventory":
            # Preserve explicit host overrides, pause settings and historical identity.
            existing[source_key].rack = rack
            existing[source_key].name = name
    await db.commit()


async def refresh_device_labels(session_factory):
    """Check device/port states and labels even when no dashboard is open."""
    from .monitor_links import refresh_devices
    await refresh_devices(session_factory)


@dataclass(frozen=True)
class ProbeResult:
    status: str
    rtt_ms: float | None = None
    detail: str = ""


# .NET returns numeric ICMP status and RTT without depending on Windows locale.
# The host is an environment value, never interpolated into executable code.
WINDOWS_PROBE = r"""
$p = New-Object System.Net.NetworkInformation.Ping
try {
  $r = $p.Send($env:LAB_MANAGER_PING_HOST, 3000)
  @{ status = [int]$r.Status; rtt = $r.RoundtripTime } | ConvertTo-Json -Compress
} catch {
  @{ error = 'DNS resolution or local ICMP probe failed' } | ConvertTo-Json -Compress
} finally { $p.Dispose() }
"""


async def ping(host: str) -> ProbeResult:
    try:
        host = validate_host(host)
        if not host:
            return ProbeResult("error", detail="No IP address or hostname configured")
    except ValueError as exc:
        return ProbeResult("error", detail=str(exc))
    env = {**os.environ, "LC_ALL": "C", "LAB_MANAGER_PING_HOST": host}
    windows = IS_WINDOWS
    if windows:
        executable = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe")
        args = [executable, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE]
    else:
        args = ["ping", "-n", "-c", "1", "-W", "3", host]
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
            **({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)} if windows else {}),
        )
        output, error = await asyncio.wait_for(process.communicate(), timeout=10)
        text = output.decode(errors="replace")
        if windows:
            data = json.loads(text)
            if "error" in data:
                return ProbeResult("error", detail=data["error"])
            if data["status"] == 0:
                return ProbeResult("up", float(data["rtt"]))
            return ProbeResult("down", detail=f"No ICMP echo reply (status {data['status']})")
        if process.returncode == 0:
            match = re.search(r"time[=<]([\d.]+)\s*ms", text)
            return ProbeResult("up", float(match[1]) if match else None)
        detail = (error.decode(errors="replace") or text).strip()[-400:]
        return ProbeResult("down" if process.returncode == 1 else "error", detail=detail or "ICMP probe failed")
    except asyncio.TimeoutError:
        return ProbeResult("error", detail="Probe exceeded 10 seconds (including DNS/process startup)")
    except (OSError, ValueError, KeyError) as exc:
        return ProbeResult("error", detail=f"Local ping probe failed: {exc}"[:400])
    finally:
        if process is not None and process.returncode is None:
            with suppress(ProcessLookupError):
                process.kill()
            await process.communicate()


async def close_incident(db, target_id, now, reason):
    await db.execute(update(PingIncident).where(
        PingIncident.target_id == target_id, PingIncident.ended_at.is_(None),
    ).values(ended_at=now, end_reason=reason))


async def record_result(db, target_id, revision, host, result, checked_at):
    # An edit/pause during a probe must not attach its result to a changed host.
    locked = await db.execute(update(PingTarget).where(
        PingTarget.id == target_id, PingTarget.revision == revision,
        PingTarget.host == host, PingTarget.enabled.is_(True),
    ).values(status=result.status).execution_options(synchronize_session=False))
    if locked.rowcount != 1:
        return
    target = await db.get(PingTarget, target_id, populate_existing=True)
    if not target or not target.enabled or target.revision != revision or target.host != host:
        return
    db.add(PingSample(target_id=target.id, host=host, checked_at=checked_at,
                      status=result.status, rtt_ms=result.rtt_ms, detail=result.detail))
    incident = (await db.execute(select(PingIncident).where(
        PingIncident.target_id == target.id, PingIncident.ended_at.is_(None),
    ))).scalar_one_or_none()
    if result.status == "down":
        if incident:
            incident.last_failed_at = checked_at
            incident.failed_checks += 1
        else:
            db.add(PingIncident(target_id=target.id, host=host, previous_up_at=target.last_up_at,
                                first_failed_at=checked_at, last_failed_at=checked_at))
    elif result.status == "up":
        if incident:
            incident.ended_at, incident.end_reason = checked_at, "recovered"
        target.last_up_at = checked_at
    # Local/DNS errors do not invent an outage or a recovery.
    target.checked_at, target.status = checked_at, result.status
    target.rtt_ms, target.detail = result.rtt_ms, result.detail
    from .alerts import observe_network
    await observe_network(db, target, result, checked_at)


async def ensure_state(session_factory=AsyncSessionLocal):
    async with session_factory() as db:
        if await db.get(PingMonitorState, 1) is None:
            db.add(PingMonitorState(id=1, next_run_at=time.time()))
            try:
                await db.commit()
            except IntegrityError:  # Another worker created the singleton.
                await db.rollback()


async def claim_round(db, owner, now, zone):
    result = await db.execute(update(PingMonitorState).where(
        PingMonitorState.id == 1, PingMonitorState.next_run_at <= now,
        PingMonitorState.lease_until <= now,
    ).values(lease_owner=owner, lease_until=now + LEASE_SECONDS, last_started_at=now,
             next_run_at=next_slot(now, zone), error=""))
    await db.commit()
    return result.rowcount == 1


async def _renew_lease(owner, session_factory):
    while True:
        await asyncio.sleep(15)
        async with session_factory() as db:
            result = await db.execute(update(PingMonitorState).where(
                PingMonitorState.id == 1, PingMonitorState.lease_owner == owner,
            ).values(lease_until=time.time() + LEASE_SECONDS))
            await db.commit()
            if result.rowcount != 1:
                raise RuntimeError("Monitor lease was lost")


async def run_round(owner, session_factory=AsyncSessionLocal, probe=ping):
    await refresh_device_labels(session_factory)
    async with session_factory() as db:
        await discover_targets(db)
        targets = (await db.execute(select(PingTarget).where(
            PingTarget.enabled.is_(True), PingTarget.host != "",
        ))).scalars().all()
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def check(target):
        async with semaphore:
            result = await probe(target.host)
            return target, result, time.time()

    # Network work is parallel; DB writes are serialized to avoid SQLite lock storms.
    tasks = [asyncio.create_task(check(t)) for t in targets]
    try:
        for task in asyncio.as_completed(tasks):
            target, result, checked_at = await task
            async with session_factory() as db:
                state = await db.get(PingMonitorState, 1)
                if state.lease_owner != owner or state.lease_until <= time.time():
                    raise RuntimeError("Monitor lease expired")
                await record_result(db, target.id, target.revision, target.host, result, checked_at)
                await db.commit()
        async with session_factory() as db:
            await db.execute(delete(PingSample).where(PingSample.checked_at < time.time() - SAMPLE_DAYS * 86400))
            await db.execute(delete(PingIncident).where(PingIncident.ended_at < time.time() - INCIDENT_DAYS * 86400))
            await db.commit()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def monitor_loop(session_factory=AsyncSessionLocal):
    settings = get_settings()
    if not settings.ping_monitor_enabled:
        return
    try:
        zone = ZoneInfo(settings.ping_monitor_timezone)
    except (ValueError, KeyError):
        log.exception("Invalid PING_MONITOR_TIMEZONE; ping monitoring cannot start")
        return
    owner = uuid4().hex
    while True:
        renewal = work = None
        claimed = False
        try:
            await ensure_state(session_factory)
            async with session_factory() as db:
                claimed = await claim_round(db, owner, time.time(), zone)
            if claimed:
                renewal = asyncio.create_task(_renew_lease(owner, session_factory))
                work = asyncio.create_task(run_round(owner, session_factory))
                done, _ = await asyncio.wait((work, renewal), return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                async with session_factory() as db:
                    await db.execute(update(PingMonitorState).where(
                        PingMonitorState.id == 1, PingMonitorState.lease_owner == owner,
                    ).values(last_completed_at=time.time(), error=""))
                    await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("Ping monitoring round failed")
            if claimed:
                try:
                    async with session_factory() as db:
                        await db.execute(update(PingMonitorState).where(
                            PingMonitorState.id == 1, PingMonitorState.lease_owner == owner,
                        ).values(error=str(exc)[:400]))
                        await db.commit()
                except Exception:
                    log.exception("Could not save monitoring error; retrying next loop")
        finally:
            for task in (work, renewal):
                if task:
                    task.cancel()
            await asyncio.gather(*(t for t in (work, renewal) if t), return_exceptions=True)
            if claimed:
                try:
                    async with session_factory() as db:
                        await db.execute(update(PingMonitorState).where(
                            PingMonitorState.id == 1, PingMonitorState.lease_owner == owner,
                        ).values(lease_until=0, lease_owner=""))
                        await db.commit()
                except Exception:
                    log.exception("Could not release monitoring lease; it will expire")
        await asyncio.sleep(5)
