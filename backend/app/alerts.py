"""Observed incidents and a durable SMTP outbox. No device control operations."""
import asyncio
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formatdate
import hashlib
import json
import logging
import math
import re
import smtplib
import ssl
import time
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from .config import get_settings
from .database import AsyncSessionLocal
from .models import AlertCondition, AlertEmail, AlertWorkerState, PingTarget

log = logging.getLogger(__name__)
UNITS = {"voltage": "V", "current": "A", "watts": "W"}


def mail_problems(settings):
    problems = []
    for field, label in (("email_alerts_to", "Recipient"), ("email_alerts_from", "Sender")):
        if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", getattr(settings, field)):
            problems.append(f"{label} email address is missing or invalid")
    if not settings.smtp_host.strip() or any(c.isspace() for c in settings.smtp_host):
        problems.append("SMTP host is missing or invalid")
    if settings.smtp_security == "plain" and settings.smtp_username:
        problems.append("SMTP authentication requires TLS")
    return problems


def power_rules(settings):
    return [(metric, side, value) for metric in UNITS for side in ("min", "max")
            if (value := getattr(settings, f"email_{metric}_{side}")) is not None]


def local_time(stamp):
    return datetime.fromtimestamp(stamp, ZoneInfo("Asia/Jerusalem")).isoformat(timespec="seconds")


def enqueue(db, key, subject, body, now, settings):
    db.add(AlertEmail(id=uuid4().hex, condition_key=key, created_at=now,
                      recipient=settings.email_alerts_to, subject=" ".join(subject.split())[:240],
                      body=body, next_attempt_at=now))


async def observe(db, *, key, configuration, failed, now, max_gap, delay, title, detail, settings):
    """None means unknown, never recovery. Call within the observation's transaction."""
    state = await db.get(AlertCondition, key)
    if state and now <= state.checked_at:
        return
    if not state:
        state = AlertCondition(key=key, configuration=configuration, checked_at=now, notified=False)
        db.add(state)
    if state.configuration != configuration:
        state.configuration, state.started_at, state.notified = configuration, None, False
    # A monitoring gap cannot contribute unobserved time to confirmation.
    if now - state.checked_at > max_gap and not state.notified:
        state.started_at = None
    state.checked_at = now
    if failed is None:
        if not state.notified:
            state.started_at = None
        return
    if not failed:
        if state.notified:
            enqueue(db, key, f"[DCIM recovered] {title}",
                    f"{detail}\nRecovery observed: {local_time(now)}\n"
                    f"First failed observation: {local_time(state.started_at)}\n"
                    "This is an observation at check time, not proof of continuous availability.", now, settings)
        state.started_at, state.notified = None, False
    else:
        if state.started_at is None:
            state.started_at = now
        if not state.notified and (delay == 0 or now - state.started_at > delay):
            enqueue(db, key, f"[DCIM alert] {title}",
                    f"{detail}\nFirst failed observation: {local_time(state.started_at)}\n"
                    f"Latest failed observation: {local_time(now)}\n"
                    f"Observed failure window: {int(now - state.started_at)} seconds.\n"
                    "Checks are discrete observations. Delivery may be delayed if the VM or mail relay is offline.", now, settings)
            state.notified = True


async def observe_network(db, target, result, now, *, minute=False):
    settings = get_settings()
    if not settings.email_alerts_enabled or minute != settings.email_alerts_minute_probes:
        return
    from .ping_monitor import next_slot
    previous = await db.get(AlertCondition, "network:" + target.id)
    gap = 150 if minute else (next_slot(previous.checked_at, ZoneInfo(settings.ping_monitor_timezone))
                              - previous.checked_at + 120 if previous else 1920)
    await observe(db, key="network:" + target.id,
                  configuration=json.dumps([target.host, target.revision, minute]),
                  failed={"up": False, "down": True}.get(result.status), now=now, max_gap=gap,
                  delay=300, title=f"{target.name}: network reachability",
                  detail=f"Server: {target.name}\nAddress: {target.host}\nRack: {target.rack or 'Unassigned'}\n"
                         f"ICMP result: {result.status}. {result.detail}", settings=settings)


async def observe_device_api(db, device, reachable, detail, now):
    """A failed API check is distinct from a server outage or an outlet being off."""
    settings = get_settings()
    if not settings.email_alerts_enabled or not device.enabled:
        return
    from .ping_monitor import next_slot
    key = "device-api:" + device.id
    previous = await db.get(AlertCondition, key)
    gap = (next_slot(previous.checked_at, ZoneInfo(settings.ping_monitor_timezone))
           - previous.checked_at + 120 if previous else 1920)
    # Credential changes reset confirmation without copying secrets to alert tables.
    credentials = json.dumps([
        device.username_enc, device.password_enc,
        getattr(settings, device.kind + "_username"), getattr(settings, device.kind + "_password"),
    ])
    configuration = json.dumps([device.kind, device.ip, hashlib.sha256(credentials.encode()).hexdigest()])
    await observe(db, key=key, configuration=configuration, failed=not reachable,
                  now=now, max_gap=gap, delay=300,
                  title=f"{device.name}: {device.kind.upper()} API availability",
                  detail=f"Device: {device.name}\nType: {device.kind.upper()}\nAddress: {device.ip}\n"
                         f"Rack: {device.rack or 'Unassigned'}\n"
                         f"API check: {'responding' if reachable else detail}\n"
                         "This describes device management API access, not server power or console health.",
                  settings=settings)


async def observe_power(db, device, result, now):
    settings = get_settings()
    if not settings.email_alerts_enabled or not result or not result.reachable:
        return
    for inlet in result.inlet_readings:
        for metric, side, limit in power_rules(settings):
            value = getattr(inlet, metric)
            valid = value is not None and math.isfinite(value)
            await observe(db, key=f"power:{device.id}:{inlet.number}:{metric}:{side}",
                          configuration=json.dumps([device.ip, limit]),
                          failed=(value < limit if side == "min" else value > limit) if valid else None,
                          now=now, max_gap=math.inf, delay=0,
                          title=f"{device.name}: inlet {inlet.number} {metric} {side}",
                          detail=f"PDU: {device.name}\nAddress: {device.ip}\nRack: {device.rack}\n"
                                 f"Inlet: {inlet.number}\nMeasured: {value} {UNITS[metric]}\n"
                                 f"Configured {side}: {limit} {UNITS[metric]}", settings=settings)


def send_email(row, settings):
    """Runs off the event loop; certificate validation is always enabled for TLS."""
    message = EmailMessage()
    message["From"], message["To"] = settings.email_alerts_from, row.recipient
    message["Subject"] = row.subject
    message["Date"] = formatdate(row.created_at, localtime=False, usegmt=True)
    message["Message-ID"] = f"<dcim-{row.id}@{settings.email_alerts_from.split('@')[-1]}>"
    message.set_content(row.body)
    kwargs = {"host": settings.smtp_host, "port": settings.smtp_port, "timeout": 15}
    if settings.smtp_security == "ssl":
        connection = smtplib.SMTP_SSL(**kwargs, context=ssl.create_default_context())
    else:
        connection = smtplib.SMTP(**kwargs)
    with connection as smtp:
        if settings.smtp_security == "starttls":
            smtp.starttls(context=ssl.create_default_context())
        if settings.smtp_username:
            smtp.login(settings.smtp_username, settings.smtp_password.get_secret_value())
        smtp.send_message(message, from_addr=settings.email_alerts_from, to_addrs=[row.recipient])


async def ensure_worker(factory):
    async with factory() as db:
        if not await db.get(AlertWorkerState, 1):
            db.add(AlertWorkerState(id=1))
            try:
                await db.commit()
            except IntegrityError:
                await db.rollback()


async def claim_worker(db, owner, now):
    result = await db.execute(update(AlertWorkerState).where(
        AlertWorkerState.id == 1, AlertWorkerState.lease_until <= now,
    ).values(lease_owner=owner, lease_until=now + 120))
    await db.commit()
    return result.rowcount == 1


async def own_lease(db, owner):
    # Take the SQLite write lock before checking state/recording observations.
    result = await db.execute(update(AlertWorkerState).where(
        AlertWorkerState.id == 1, AlertWorkerState.lease_owner == owner,
        AlertWorkerState.lease_until > time.time(),
    ).values(lease_until=time.time() + 120))
    if result.rowcount != 1:
        raise RuntimeError("Alert worker lease lost")


async def renew(owner, factory):
    while True:
        await asyncio.sleep(15)
        async with factory() as db:
            await own_lease(db, owner)
            await db.commit()


async def network_round(owner, factory, probe=None):
    from .ping_monitor import discover_targets, ping
    probe = probe or ping
    async with factory() as db:
        await own_lease(db, owner)
        await discover_targets(db)
        targets = (await db.execute(select(PingTarget).where(PingTarget.enabled.is_(True), PingTarget.host != ""))).scalars().all()
        await db.commit()
    gate = asyncio.Semaphore(8)

    async def check(target):
        async with gate:
            return target, await probe(target.host), time.time()

    tasks = [asyncio.create_task(check(t)) for t in targets]
    try:
        for task in asyncio.as_completed(tasks):
            target, result, now = await task
            async with factory() as db:
                await own_lease(db, owner)
                current = await db.get(PingTarget, target.id)
                if current and current.enabled and (current.host, current.revision) == (target.host, target.revision):
                    await observe_network(db, current, result, now, minute=True)
                await db.commit()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def deliver(owner, factory, sender=send_email):
    settings = get_settings()
    if not settings.email_alerts_enabled or mail_problems(settings):
        return
    for _ in range(10):
        async with factory() as db:
            await own_lease(db, owner)
            # Oldest first: never send a recovery before its pending failure email.
            row = (await db.execute(select(AlertEmail).where(AlertEmail.sent_at.is_(None))
                                   .order_by(AlertEmail.created_at, AlertEmail.id).limit(1))).scalar_one_or_none()
            if row is None or row.next_attempt_at > time.time():
                await db.commit()
                return
            await db.commit()
        error = ""
        try:
            await asyncio.to_thread(sender, row, settings)
        except Exception as exc:
            # SMTP replies may contain credentials or infrastructure details.
            error = type(exc).__name__
        async with factory() as db:
            await own_lease(db, owner)
            saved = await db.get(AlertEmail, row.id)
            saved.attempts += 1
            saved.error = error
            if error:
                saved.next_attempt_at = time.time() + min(1800, 30 * 2 ** min(saved.attempts - 1, 6))
            else:
                saved.sent_at = time.time()
            await db.commit()
        if error:
            return


async def worker_tick(owner, factory):
    settings = get_settings()
    async with factory() as db:
        await own_lease(db, owner)
        state = await db.get(AlertWorkerState, 1)
        due = settings.email_alerts_minute_probes and state.next_probe_at <= time.time()
        if due:
            state.next_probe_at = time.time() + 60
        await db.commit()
    if due:
        await network_round(owner, factory)
    await deliver(owner, factory)
    async with factory() as db:
        await own_lease(db, owner)
        await db.execute(delete(AlertEmail).where(AlertEmail.sent_at < time.time() - 90 * 86400))
        state = await db.get(AlertWorkerState, 1)
        state.last_completed_at, state.error = time.time(), ""
        await db.commit()


async def alert_loop(factory=AsyncSessionLocal):
    if not get_settings().email_alerts_enabled or not get_settings().ping_monitor_enabled:
        return
    owner = uuid4().hex
    while True:
        claimed, completed, tasks = False, False, []
        try:
            await ensure_worker(factory)
            async with factory() as db:
                claimed = await claim_worker(db, owner, time.time())
            if claimed:
                tasks = [asyncio.create_task(worker_tick(owner, factory)), asyncio.create_task(renew(owner, factory))]
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                completed = tasks[0] in done
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("Alert worker failed: %s", type(exc).__name__)
            if claimed:
                try:
                    async with factory() as db:
                        await db.execute(update(AlertWorkerState).where(AlertWorkerState.lease_owner == owner)
                                         .values(error=type(exc).__name__))
                        await db.commit()
                except Exception:
                    log.error("Could not save alert worker error; retrying")
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if claimed and completed:
                try:
                    async with factory() as db:
                        await db.execute(update(AlertWorkerState).where(AlertWorkerState.lease_owner == owner)
                                         .values(lease_owner="", lease_until=0))
                        await db.commit()
                except Exception:
                    log.error("Could not release alert worker lease; it will expire")
        await asyncio.sleep(5)


async def overview(db, settings):
    now = time.time()
    state = await db.get(AlertWorkerState, 1)
    pending = await db.scalar(select(func.count()).select_from(AlertEmail).where(AlertEmail.sent_at.is_(None)))
    latest = (await db.execute(select(AlertEmail).order_by(AlertEmail.created_at.desc()).limit(10))).scalars().all()
    problems = mail_problems(settings)
    if not settings.ping_monitor_enabled:
        problems.append("Ping monitoring is disabled")
    return {
        "enabled": settings.email_alerts_enabled, "recipient": settings.email_alerts_to,
        "ready": settings.email_alerts_enabled and not problems,
        "problems": problems, "minute_probes": settings.email_alerts_minute_probes,
        "power_rules": [{"metric": metric, "side": side, "value": value, "unit": UNITS[metric]}
                        for metric, side, value in power_rules(settings)],
        "worker": "error" if state and state.error else "running" if state and state.lease_until > now
                  else "healthy" if state and state.last_completed_at and now - state.last_completed_at < 90 else "not_running",
        "pending": pending,
        "recent": [{"id": row.id, "subject": row.subject, "created_at": datetime.fromtimestamp(row.created_at, timezone.utc).isoformat(),
                    "sent_at": datetime.fromtimestamp(row.sent_at, timezone.utc).isoformat() if row.sent_at else None,
                    "attempts": row.attempts, "error": row.error} for row in latest],
    }
