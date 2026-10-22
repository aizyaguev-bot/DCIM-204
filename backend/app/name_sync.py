"""Write site port names to the PDUs/KVMs themselves: names only, never power or any other device setting.

A label save queues the ports whose saved label changed (queue()). A background worker per device writes each name
through the driver, reads it back and records pending | synced | failed | skipped with a fixed, secret-free reason
(DeviceNameSync). The Device names panel compares live (live_compare()) and pushes explicit ports (push()).

Safety (NS-SEC): the mode fails closed (unknown value or a site without any sign-in -> off); one writer per device
(asyncio lock in-process, DB lease across processes, the PDU maintenance lock around each port); a result is
recorded only for the revision it wrote; a refused sign-in or an unreachable device stops the batch; nothing pending is
replayed after a restart. Nothing here returns, stores or prints addresses, credentials, device responses or exception
text: driver errors map to an allow-list of fixed reasons; the only log line per batch is the device's site name and
counts. DEVICE_NAME_SYNC: auto (default) | manual (no automatic push; the panel still writes) | off (no device writes).
"""
import asyncio
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import or_, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from . import confirm
from .config import get_settings
from .database import AsyncSessionLocal
from .models import Device, DeviceNameSync, DeviceNameSyncLease
from .pdu_locks import maintenance_lock
from drivers import raritan_kvm, raritan_pdu
from drivers.raritan_kvm import RaritanKvmAuthError, RaritanKvmDriver, RaritanKvmError
from drivers.raritan_pdu import RaritanPduDriver, RaritanPduError

# Fixed reasons (the only texts stored in DeviceNameSync.reason or returned for a port).
UNREACHABLE = "Device unreachable — retry later"
AUTH_FAILED = "Device API authentication failed"
OFF = "Device name sync is off"
DISABLED = "Device is disabled; names are not written to it"
REMOVED = "Device was removed"
NO_PORTS = "This device type has no port names"
NO_SUCH_PORT = "The device has no such port"
MISMATCH = "The device kept a different name"
INVALID_NAMES = "Device API returned invalid port names"
INVALID_NAME = "Device API returned an invalid name"
WRITE_FAILED = "The device did not accept the name"
READ_FAILED = "The port names on the device could not be read"
CREDENTIALS = "Saved device credentials cannot be read"
BAD_ADDRESS = "The saved device address is not valid"
NO_DRIVER = "The device driver could not be started"
UNSUPPORTED = "Port names cannot be written to this device"
KVM_DEFAULT = "Default port name: nothing is written to this KVM"
NO_SITE_NAME = "No site name is saved for this port; the device keeps its own name"
OUT_OF_RANGE = "Port is outside this device's port count"
TWO_LABELS = "Port has two site labels"
BAD_CHARS = "Name has characters the device cannot store"
OTHER_SETTINGS = "Other outlet settings changed during the write — check the PDU"
DEVICE_CHANGED = "Device settings changed during the write — retry"
RESTARTED = "Interrupted by a restart — retry"
INTERNAL = "Internal error — retry"
CHANGED_AGAIN = "Changed again during the write; queued"
BUSY = "Names are being written to this device by another worker; retry shortly"
TOO_MANY = "Too many ports changed at once to write automatically; use Device names on the PDU/KVM page"
PLACEHOLDER_RENAME = "A default port name was renamed; use Device names on the PDU/KVM page"
NOTHING_CHANGED = "No port name changed"

PORT_KINDS = ("pdu", "kvm")
READ_TIMEOUT = 8.0          # the panel's live compare (the drivers' own request timeouts are 6 s)
WRITE_TIMEOUT = 30.0        # one port: read settings, write, read back
READ_CACHE_SECONDS = 5.0    # one live read per device per 5 s, shared by every panel open at the time
LEASE_SECONDS = 120.0
LEASE_POLL_SECONDS = 1.0
PUSH_LEASE_WAIT = 10.0
QUEUE_SUPPORT_TIMEOUT = 1.0  # a save asks a KVM driver whether it can write names at all, never longer than this
MAX_AUTO_DEVICES = 8        # a save touching more is not pushed automatically (Device names panel instead)
MAX_AUTO_PORTS = 48
MAX_LISTED_PORTS = 512
NAME_SHOWN_MAX = 128
_KVM_NAME_MAX = 32          # used only until the KVM driver defines NAME_MAX
_PLACEHOLDER = re.compile(r"(?:outlet|port)\s*\d+", re.I)
_ALLOWED = frozenset(chr(c) for c in range(0x20, 0x7F)) - frozenset("'\"\\<>&`")
_TRANSPORT = ("Device API connection", "Device API request timeout", "Device API DNS failure",
              "Device API network unreachable", "Device API proxy error", "Device API TLS handshake error")
_KNOWN = tuple(re.compile(p) for p in (
    r"Device refused the name \(code -?\d{1,9}\)", r"Name is too long for this device \(max \d{1,4}\)",
    r"Device API responded with HTTP \d{3}", r"RPC error (?:-?\d{1,9}|\?)", re.escape(BAD_CHARS),
    r"Device API returned (?:an invalid response|invalid outlet settings|an invalid name-write result)",
    r"Port names cannot be written to this KVM yet", re.escape(INVALID_NAMES),
    r"Device API returned an invalid resource identifier", r"Outlet names cannot be written to this PDU yet"))
# The driver's own spelling of OTHER_SETTINGS (stored and shown as OTHER_SETTINGS).
_OTHER_SETTINGS_TEXTS = {OTHER_SETTINGS, OTHER_SETTINGS.replace("—", "-"),
                         str(getattr(raritan_pdu, "_OTHER_SETTINGS_CHANGED", OTHER_SETTINGS))}
_OWNER = f"{os.getpid()}-{uuid.uuid4().hex[:12]}"

# Injectable for tests (conftest sets mode off, no database, no driver).
_session_factory = AsyncSessionLocal

_tasks: set[asyncio.Task] = set()                  # strong references to running workers and the late sweep
_workers: set[asyncio.Task] = set()                # the workers alone (drain)
_locks: dict[str, asyncio.Lock] = {}               # one writer per device in this process
_reads: dict[str, tuple[float, tuple, asyncio.Future]] = {}   # S1: shared live reads
_warned: set[str] = set()


class NameRefused(ValueError):
    """A site label the device cannot store; the port fails without any write."""


class ExpectedMismatch(Exception):
    """A port's site name changed since the panel's compare."""


class Busy(Exception):
    """Another process holds this device's write lease."""


# ── Mode ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def effective_mode(settings) -> str:
    """auto | manual | off. Fails closed: an unknown value is off (one warning), and so is a site with no sign-in
    at all (no accounts and no shared password), where anyone on the network could make the site write to devices."""
    raw = getattr(settings, "device_name_sync", "auto")
    value = str(raw if raw is not None else "").strip().lower()
    if value not in ("auto", "manual", "off"):
        if value not in _warned:
            _warned.add(value)
            _say("name-sync: DEVICE_NAME_SYNC has an unknown value; device name writes are off")
        return "off"
    if value != "off" and confirm.password_mode(settings) == "unavailable":
        return "off"
    return value


def mode() -> str:
    return effective_mode(get_settings())


# ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _say(line: str) -> None:
    print(clean_text(line, 300), file=sys.stderr, flush=True)


def clean_text(value, limit: int = NAME_SHOWN_MAX) -> str:
    """Printable characters only (no control characters), at most `limit`."""
    return "".join(ch for ch in str(value) if ch.isprintable())[:limit]


def port_key(port) -> str | None:
    """A numbered port as its plain number ("05" -> "5"); None for anything else (a device only has numbered ports)."""
    port = str(port).strip() if isinstance(port, (str, int)) and not isinstance(port, bool) else ""
    if 0 < len(port) <= 4 and port.isascii() and port.isdigit() and int(port) > 0:
        return str(int(port))
    return None


def in_range(dev, port: str) -> bool:
    return 1 <= int(port) <= min(dev.port_count or 0, MAX_LISTED_PORTS)


def saved_labels(dev) -> dict:
    try:
        labels = json.loads(dev.labels_json or "{}")
    except ValueError:
        return {}
    return labels if isinstance(labels, dict) else {}


def site_labels(dev) -> tuple[dict[str, str], set[str]]:
    """(numbered port -> saved label, ports with two different saved labels such as "5" and "05"). Legacy
    non-numeric keys are never part of it."""
    found, conflicts = {}, set()
    for key, label in saved_labels(dev).items():
        port = port_key(key)
        if port is None or not isinstance(label, str):
            continue
        if port in found and found[port].strip() != label.strip():
            conflicts.add(port)
        if port not in found or key == port:
            found[port] = label
    return found, conflicts


def name_max(dev) -> int:
    value = getattr(raritan_pdu if dev.kind == "pdu" else raritan_kvm, "NAME_MAX", None)
    return value if isinstance(value, int) and value > 0 else _KVM_NAME_MAX


def device_value(dev, label) -> str | None:
    """The name to write for a site label; None = write nothing. A placeholder ("Outlet N" / "Port N") or empty label
    means the device default: "" for a PDU (it then shows its own default name); a KVM gets nothing (no invented
    value). Raises NameRefused for characters outside printable ASCII (or ' " \\ < > & `) or over the device's limit;
    a name is never truncated."""
    text = label.strip() if isinstance(label, str) else ""
    if not text or _PLACEHOLDER.fullmatch(text):
        return "" if dev.kind == "pdu" else None
    if any(ch not in _ALLOWED for ch in text):
        raise NameRefused(BAD_CHARS)
    limit = name_max(dev)
    if len(text) > limit:
        raise NameRefused(f"Name is too long for this device (max {limit})")
    return text


def plan(dev, port: str, labels: dict, conflicts: set) -> tuple[str, str, str]:
    """(desired, status, reason) for one port: "pending" = write `desired`; otherwise no write, with the reason."""
    if not in_range(dev, port):
        return "", "skipped", OUT_OF_RANGE
    if port in conflicts:
        return "", "failed", TWO_LABELS
    label = labels.get(port)
    if label is None:
        return "", "skipped", NO_SITE_NAME
    try:
        value = device_value(dev, label)
    except NameRefused as exc:
        return clean_text(label.strip()), "failed", str(exc)
    if value is None:
        return "", "skipped", KVM_DEFAULT
    return value, "pending", ""


def current_writes(dev, ports) -> dict[str, str | None]:
    """port -> the name a push would write now (None: not writable). The panel's `expected` must match it."""
    labels, conflicts = site_labels(dev)
    out = {}
    for port in ports:
        desired, status, _ = plan(dev, port, labels, conflicts)
        out[port] = desired if status == "pending" else None
    return out


def row_out(row) -> dict:
    return {"status": row.status, "desired": row.desired, "reason": row.reason,
            "updated_at": row.updated_at, "synced_at": row.synced_at}


def _identity(dev) -> tuple:
    return dev.ip, dev.kind, bool(dev.enabled), dev.username_enc, dev.password_enc


def _valid_address(ip) -> bool:
    from .ping_monitor import validate_host
    try:
        return isinstance(ip, str) and ip == ip.strip() and bool(validate_host(ip))
    except ValueError:
        return False


def _creds(dev) -> tuple[str, str]:
    from .routers.devices import get_creds   # devices imports this module
    return get_creds(dev)


def _make_driver(dev, username: str, password: str):
    if dev.kind == "pdu":
        return RaritanPduDriver(dev.ip, username, password)
    return RaritanKvmDriver(dev.ip, username, password, model=dev.model)


_driver_factory = _make_driver   # injectable for tests


async def _close(driver) -> None:
    try:
        await driver.close()
    except Exception:
        pass


def failure(exc: BaseException, generic: str = WRITE_FAILED) -> tuple[str, bool]:
    """(fixed reason, stop the device's batch). Only allow-listed driver texts pass; anything else is `generic`.
    An unreachable device, a refused sign-in (account lockout) or other outlet settings changing stop the batch."""
    if isinstance(exc, (asyncio.TimeoutError, httpx.TransportError, OSError)):
        return UNREACHABLE, True
    if isinstance(exc, RaritanKvmAuthError):
        return AUTH_FAILED, True
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return (AUTH_FAILED, True) if code in (401, 403) else (f"Device API responded with HTTP {code}", False)
    if isinstance(exc, (RaritanPduError, RaritanKvmError)):
        text = " ".join(str(exc).split())
        if text.startswith(_TRANSPORT):
            return UNREACHABLE, True
        if re.fullmatch(r"(?:Device API responded with )?HTTP 40[13]", text) or text == AUTH_FAILED:
            return AUTH_FAILED, True
        if text in _OTHER_SETTINGS_TEXTS:
            return OTHER_SETTINGS, True
        if re.fullmatch(r"Outlet (?:number is out of range|\d{1,4} out of range \(max \d{1,4}\))", text):
            return NO_SUCH_PORT, False
        if any(p.fullmatch(text) for p in _KNOWN):
            return text, False
    return generic, False


def _support_reasons() -> set[str]:
    """The drivers' own fixed "not supported" texts; any other text from name_support() shows as UNSUPPORTED."""
    reasons = {UNSUPPORTED}
    for module in (raritan_pdu, raritan_kvm):
        candidates = [getattr(module, name, None) for name in ("_NAME_UNSUPPORTED", "NAME_UNSUPPORTED", "_INVALID_RID")]
        extra = getattr(module, "NAME_SUPPORT_REASONS", ())
        candidates += list(extra) if isinstance(extra, (tuple, list, set, frozenset)) else []
        reasons.update(r for r in candidates if isinstance(r, str))
    return reasons


async def _support(driver) -> tuple[bool, str]:
    """Only a method the driver positively identified may write. A driver without name_support (the current PDU
    driver) writes through its own fixed method and refuses an unrecognised settings shape itself."""
    probe = getattr(driver, "name_support", None)
    if probe is None:
        return True, ""
    result = await probe()
    if isinstance(result, tuple) and len(result) == 2 and result[0] is True:
        return True, ""
    reason = result[1] if isinstance(result, tuple) and len(result) == 2 else ""
    return False, reason if reason in _support_reasons() else UNSUPPORTED


async def _read_names(dev, driver) -> dict[int, str]:
    raw = await (driver.get_outlet_names() if dev.kind == "pdu" else driver.get_port_names())
    if not isinstance(raw, dict):
        raise RaritanPduError(INVALID_NAMES)
    return {n: name for n, name in raw.items()
            if isinstance(n, int) and not isinstance(n, bool) and 0 < n <= 9999 and isinstance(name, str)}


async def _write(dev, driver, number: int, name: str):
    if dev.kind == "pdu":
        return await driver.set_outlet_name(number, name)
    return await driver.set_port_name(number, name)


def _invalidate(device_id: str) -> None:
    """After a name changed on the device: the next compare and status poll read it again (S3)."""
    _reads.pop(device_id, None)
    from .routers import kvms, pdus
    pdus._cache.pop(device_id, None)
    kvms._cache.pop(device_id, None)


# ── Queue ────────────────────────────────────────────────────────────────────────────────────────────────────────


def not_queued(reason: str) -> dict:
    """The "device_names" answer of a save that is deliberately not pushed automatically."""
    current = mode()
    return {"device_names": current} if current != "auto" else {"device_names": "manual", "device_names_reason": reason}


async def queue(device_ports: dict) -> dict:
    """After a successful, committed label save: mark the changed ports pending and start the device workers.
    Returns the response fields: {"device_names": "queued" | "not_sent" | "manual" | "off"}. "queued" only when at
    least one port is really pending; "not_sent" (nothing to write: every changed name refused, a KVM without a write
    method, a disabled device, no port changed) and "manual" (too large a save) come with "device_names_reason", the
    first fixed reason. Never raises into the request."""
    current = mode()
    if current != "auto":
        return {"device_names": current}
    wanted = {}
    for device_id, ports in (device_ports or {}).items():
        keys = {k for k in (port_key(p) for p in ports or ()) if k}
        if isinstance(device_id, str) and keys:
            wanted[device_id] = keys
    if len(wanted) > MAX_AUTO_DEVICES or sum(map(len, wanted.values())) > MAX_AUTO_PORTS:
        _say(f"name-sync: a save changed {sum(map(len, wanted.values()))} ports on {len(wanted)} devices; "
             "not written automatically")
        return {"device_names": "manual", "device_names_reason": TOO_MANY}
    try:
        waiting, reason = await _enqueue(wanted, check_support=True) if wanted else ([], NOTHING_CHANGED)
    except Exception as exc:
        _say(f"name-sync: could not queue names ({type(exc).__name__})")
        return {"device_names": "not_sent", "device_names_reason": INTERNAL}
    for device_id in waiting:
        _start(device_id)
    if waiting:
        return {"device_names": "queued"}
    return {"device_names": "not_sent", "device_names_reason": reason or NOTHING_CHANGED}


async def _quick_unsupported(dev) -> str | None:
    """A KVM whose driver positively reports no name-write method: its reason. Unknown (any error, or no answer
    within QUEUE_SUPPORT_TIMEOUT) is None, and the worker checks again before writing."""
    if not _valid_address(dev.ip):
        return None
    try:
        username, password = _creds(dev)
        driver = _driver_factory(dev, username, password)
    except Exception:
        return None
    try:
        supported, why = await asyncio.wait_for(_support(driver), QUEUE_SUPPORT_TIMEOUT)
        return None if supported else why
    except Exception:
        return None
    finally:
        await _close(driver)


async def _enqueue(wanted: dict[str, set[str]], expected: dict | None = None,
                   check_support: bool = False) -> tuple[list[str], str]:
    """Upsert one row per port from the label saved now (a later queue for the same port wins: revision + 1). Ports
    outside 1..port_count are never queued. A refused name fails here, a KVM default is skipped here, both without
    any device write; with check_support (a save) so are a disabled device and a KVM without a write method. With
    `expected` (a push) nothing is written unless every port still plans that name.
    Returns (the devices that have pending rows, the first reason a changed port is not written)."""
    now, waiting, reasons = _now(), [], []
    async with _session_factory() as db:
        found = {d.id: d for d in (await db.execute(select(Device).where(Device.id.in_(list(wanted))))).scalars()}
        found = [found[i] for i in wanted if i in found and found[i].kind in PORT_KINDS]
        unsupported = {}
        if check_support:
            kvms = [d for d in found if d.kind == "kvm" and d.enabled]
            answers = await asyncio.gather(*(_quick_unsupported(d) for d in kvms))
            unsupported = {d.id: why for d, why in zip(kvms, answers) if why}
        for dev in found:
            labels, conflicts = site_labels(dev)
            ports = sorted(wanted[dev.id], key=int)
            reasons += [OUT_OF_RANGE for p in ports if not in_range(dev, p)]
            planned = {p: plan(dev, p, labels, conflicts) for p in ports if in_range(dev, p)}
            if expected is not None and any((d if s == "pending" else None) != expected.get(p)
                                            for p, (d, s, _) in planned.items()):
                raise ExpectedMismatch()
            if check_support:
                override = DISABLED if not dev.enabled else unsupported.get(dev.id)
                if override:
                    planned = {p: (d, "skipped", override) if s == "pending" else (d, s, r)
                               for p, (d, s, r) in planned.items()}
            reasons += [r for _, s, r in planned.values() if s != "pending"]
            for port, (desired, status, reason) in planned.items():
                stmt = sqlite_insert(DeviceNameSync).values(device_id=dev.id, port=port, desired=desired, status=status,
                                                            reason=reason, attempts=0, updated_at=now, revision=1)
                await db.execute(stmt.on_conflict_do_update(
                    index_elements=["device_id", "port"],
                    set_={"desired": desired, "status": status, "reason": reason, "updated_at": now,
                          "revision": DeviceNameSync.revision + 1}))
            if any(s == "pending" for _, s, _ in planned.values()):
                waiting.append(dev.id)
        await db.commit()
    return waiting, (reasons[0] if reasons else "")


def _lock(device_id: str) -> asyncio.Lock:
    return _locks.setdefault(device_id, asyncio.Lock())


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task


def _start(device_id: str) -> None:
    """Always a new task: it exits only when the database has no pending row for the device."""
    task = _spawn(_worker(device_id))
    _workers.add(task)
    task.add_done_callback(_workers.discard)


async def _has_pending(device_id: str) -> bool:
    async with _session_factory() as db:
        return await db.scalar(select(DeviceNameSync.id).where(
            DeviceNameSync.device_id == device_id, DeviceNameSync.status == "pending").limit(1)) is not None


async def _worker(device_id: str) -> None:
    """Writes the device's pending ports until none is left. No automatic retry of failed ports."""
    stalled = 0
    try:
        while True:
            async with _lock(device_id):
                if not await _has_pending(device_id):
                    return
                if await _acquire(device_id):
                    try:
                        outcome = await _run_batch(device_id, None)
                    finally:
                        await _release(device_id)
                    if any(r["status"] != "pending" for r in outcome.values()):
                        stalled = 0
                        continue
                    stalled += 1   # nothing could be recorded (e.g. the database stays locked): never spin
                    if stalled >= 5:
                        _say("name-sync: names stay pending after repeated attempts; the next save or restart settles them")
                        return
            await asyncio.sleep(LEASE_POLL_SECONDS)   # another process holds the lease, or a short pause after a stall
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        _say(f"name-sync: worker stopped ({type(exc).__name__})")


# ── Lease ────────────────────────────────────────────────────────────────────────────────────────────────────────


async def _acquire(device_id: str) -> bool:
    now = time.time()
    async with _session_factory() as db:
        stmt = sqlite_insert(DeviceNameSyncLease).values(device_id=device_id, owner=_OWNER, until=now + LEASE_SECONDS)
        result = await db.execute(stmt.on_conflict_do_update(
            index_elements=["device_id"], set_={"owner": _OWNER, "until": now + LEASE_SECONDS},
            where=or_(DeviceNameSyncLease.until <= now, DeviceNameSyncLease.owner == _OWNER)))
        await db.commit()
        return result.rowcount == 1


async def _renew(device_id: str) -> bool:
    async with _session_factory() as db:
        result = await db.execute(update(DeviceNameSyncLease).where(
            DeviceNameSyncLease.device_id == device_id, DeviceNameSyncLease.owner == _OWNER,
        ).values(until=time.time() + LEASE_SECONDS))
        await db.commit()
        return result.rowcount == 1


async def _release(device_id: str) -> None:
    try:
        async with _session_factory() as db:
            await db.execute(update(DeviceNameSyncLease).where(
                DeviceNameSyncLease.device_id == device_id, DeviceNameSyncLease.owner == _OWNER,
            ).values(owner="", until=0))
            await db.commit()
    except Exception as exc:
        _say(f"name-sync: could not release a device lease ({type(exc).__name__}); it will expire")


# ── One batch ────────────────────────────────────────────────────────────────────────────────────────────────────


async def _run_batch(device_id: str, ports: set[str] | None) -> dict[str, dict]:
    """The device's pending rows (only `ports` when given), one port at a time; the caller holds the device lock and
    lease. Whatever is still pending of this batch afterwards (an unexpected error) becomes failed "Internal error —
    retry", or "Interrupted by a restart — retry" on shutdown."""
    async with _session_factory() as db:
        rows = (await db.execute(select(DeviceNameSync).where(
            DeviceNameSync.device_id == device_id, DeviceNameSync.status == "pending"))).scalars().all()
    rows = sorted((r for r in rows if ports is None or r.port in ports), key=lambda r: int(r.port))
    if not rows:
        return {}
    outcome: dict[str, dict] = {}
    leftover_reason = INTERNAL
    try:
        await _batch(device_id, rows, outcome)
    except asyncio.CancelledError:
        leftover_reason = RESTARTED
        raise
    except Exception as exc:
        _say(f"name-sync: internal error ({type(exc).__name__})")
    finally:
        leftovers = [r for r in rows if r.port not in outcome]
        if leftovers:
            try:
                await _record_rest(device_id, leftovers, "failed", leftover_reason, outcome)
            except Exception as exc:
                _say(f"name-sync: could not record a result ({type(exc).__name__})")
    return outcome


async def _record(device_id: str, row_port: str, desired: str, revision: int, result: dict, outcome: dict) -> None:
    """Compare-and-set: only the revision that was written gets this result; a newer queue stays pending."""
    now = _now()
    values = {"status": result["status"], "reason": result["reason"], "updated_at": now}
    if result["status"] == "synced":
        values["synced_at"] = now
    if result.get("counted"):
        values["attempts"] = DeviceNameSync.attempts + 1
    async with _session_factory() as db:
        done = await db.execute(update(DeviceNameSync).where(
            DeviceNameSync.device_id == device_id, DeviceNameSync.port == row_port, DeviceNameSync.status == "pending",
            DeviceNameSync.desired == desired, DeviceNameSync.revision == revision).values(**values))
        await db.commit()
    outcome[row_port] = result if done.rowcount == 1 else {**result, "status": "pending", "reason": CHANGED_AGAIN}


async def _record_rest(device_id: str, rows, status: str, reason: str, outcome: dict, counted: bool = False) -> None:
    for row in rows:
        await _record(device_id, row.port, row.desired, row.revision,
                      {"status": status, "reason": reason, "device": None, "counted": counted}, outcome)


async def _current(device_id: str, port: str):
    async with _session_factory() as db:
        dev = await db.scalar(select(Device).where(Device.id == device_id).execution_options(populate_existing=True))
        row = await db.scalar(select(DeviceNameSync).where(DeviceNameSync.device_id == device_id,
                                                           DeviceNameSync.port == port))
    return dev, row


async def _batch(device_id: str, rows: list, outcome: dict) -> None:
    async with _session_factory() as db:
        dev = await db.get(Device, device_id)
    reason = (REMOVED if dev is None else OFF if mode() == "off" else DISABLED if not dev.enabled
              else NO_PORTS if dev.kind not in PORT_KINDS else None)
    if reason:   # never contacted
        await _record_rest(device_id, rows, "skipped", reason, outcome)
        return _summary(dev, outcome)
    if not _valid_address(dev.ip):
        await _record_rest(device_id, rows, "failed", BAD_ADDRESS, outcome)
        return _summary(dev, outcome)
    try:
        username, password = _creds(dev)
    except Exception:
        await _record_rest(device_id, rows, "failed", CREDENTIALS, outcome)
        return _summary(dev, outcome)
    try:
        driver = _driver_factory(dev, username, password)
    except Exception:
        await _record_rest(device_id, rows, "failed", NO_DRIVER, outcome)
        return _summary(dev, outcome)
    try:
        try:
            supported, why = await asyncio.wait_for(_support(driver), READ_TIMEOUT)
            if not supported:
                await _record_rest(device_id, rows, "skipped", why, outcome)
                return _summary(dev, outcome)
            names = await asyncio.wait_for(_read_names(dev, driver), WRITE_TIMEOUT)
        except Exception as exc:
            await _record_rest(device_id, rows, "failed", failure(exc, READ_FAILED)[0], outcome, counted=True)
            return _summary(dev, outcome)
        for index, start_row in enumerate(rows):
            port = start_row.port
            async with maintenance_lock(device_id):
                if not await _renew(device_id):   # the lease moved to another process: it continues from here
                    for row in rows[index:]:
                        outcome[row.port] = {"status": "pending", "reason": BUSY, "device": None}
                    break
                current, row = await _current(device_id, port)
                if current is None or _identity(current) != _identity(dev):
                    await _record_rest(device_id, rows[index:], "failed", DEVICE_CHANGED, outcome)
                    break
                if row is None or row.status != "pending":
                    outcome[port] = {"status": row.status if row else "skipped", "reason": row.reason if row else "",
                                     "device": None}
                    continue
                want, revision, number = row.desired, row.revision, int(port)   # desired read just before writing
                if number not in names:
                    result = {"status": "failed", "reason": NO_SUCH_PORT, "device": None, "counted": True}
                elif names[number] == want:
                    result = {"status": "synced", "reason": "", "device": want, "counted": True}
                else:
                    try:
                        stored = await asyncio.wait_for(_write(dev, driver, number, want), WRITE_TIMEOUT)
                    except Exception as exc:
                        reason, stop = failure(exc)
                        await _record(device_id, port, want, revision,
                                      {"status": "failed", "reason": reason, "device": None, "counted": True}, outcome)
                        if stop:
                            await _record_rest(device_id, rows[index + 1:], "failed", reason, outcome)
                            break
                        continue
                    if not isinstance(stored, str):
                        result = {"status": "failed", "reason": INVALID_NAME, "device": None, "counted": True}
                    else:
                        names[number] = stored
                        _invalidate(device_id)
                        shown = clean_text(stored)
                        result = ({"status": "synced", "reason": "", "device": shown, "counted": True} if stored == want
                                  else {"status": "failed", "reason": MISMATCH, "device": shown, "counted": True})
                await _record(device_id, port, want, revision, result, outcome)
    finally:
        await _close(driver)
    _summary(dev, outcome)


def _summary(dev, outcome: dict) -> None:
    counts = {s: sum(1 for r in outcome.values() if r["status"] == s) for s in ("synced", "failed", "skipped")}
    name = clean_text(dev.name if dev is not None else "removed device", 80)
    line = f"name-sync: {name} {counts['synced']} synced, {counts['failed']} failed"
    _say(line + (f", {counts['skipped']} skipped" if counts["skipped"] else ""))


# ── Panel: live compare and push ─────────────────────────────────────────────────────────────────────────────────


async def _read_live(dev) -> dict:
    """One read of support + names. Never raises; errors are fixed reasons."""
    out = {"checked": False, "supported": dev.kind == "pdu", "reason": "", "reachable": False, "error": "", "names": {},
           "read_at": _now()}
    if not _valid_address(dev.ip):
        out["error"] = BAD_ADDRESS
        return out
    try:
        username, password = _creds(dev)
    except Exception:
        out["error"] = CREDENTIALS
        return out
    try:
        driver = _driver_factory(dev, username, password)
    except Exception:
        out["error"] = NO_DRIVER
        return out

    async def read():
        out["supported"], out["reason"] = await _support(driver)
        out["checked"] = True
        out["names"] = await _read_names(dev, driver)

    try:
        await asyncio.wait_for(read(), READ_TIMEOUT)
        out["reachable"] = True
    except Exception as exc:
        out["error"] = failure(exc, READ_FAILED)[0]
    finally:
        await _close(driver)
    return out


async def _shared_read(dev) -> dict:
    """S1: at most one live read per device per READ_CACHE_SECONDS, shared by concurrent panels."""
    key = (_identity(dev), dev.model)
    entry = _reads.get(dev.id)
    if entry and entry[1] == key and (not entry[2].done() or time.monotonic() - entry[0] < READ_CACHE_SECONDS):
        return await asyncio.shield(entry[2])
    future = asyncio.ensure_future(_read_live(dev))
    _reads[dev.id] = (time.monotonic(), key, future)
    return await asyncio.shield(future)


async def live_compare(dev, sync_rows: dict[str, dict]) -> dict:
    """GET /api/devices/{id}/device-names: the site name and the name on the device per port. Reads only; a
    disabled device is not contacted."""
    body = {"device_id": dev.id, "kind": dev.kind, "mode": mode(), "supported": False, "reason": DISABLED,
            "reachable": False, "error": "", "ports": []}
    read = {"checked": False, "names": {}}
    if dev.enabled:
        read = await _shared_read(dev)
        body.update(supported=read["supported"], reason=read["reason"], reachable=read["reachable"], error=read["error"])
    names = read["names"] if body["reachable"] else {}
    labels, conflicts = site_labels(dev)
    numbers = set(range(1, min(dev.port_count or 0, MAX_LISTED_PORTS) + 1))
    numbers |= {int(p) for p in labels} | set(names)
    for number in sorted(numbers):
        port = str(number)
        desired, status, reason = plan(dev, port, labels, conflicts)
        write = desired if status == "pending" else None
        on_device = names.get(number) if body["reachable"] else None
        if not body["supported"] and (read["checked"] or not dev.enabled):
            state = "not_writable"
        elif write is None:
            state = "not_writable"
        elif on_device is None:
            state = "unknown"
        else:
            state = "in_sync" if on_device == write else "differs"
        site = labels.get(port)
        body["ports"].append({"port": port, "site": clean_text(site, 256) if site is not None else "",
                              "device": clean_text(on_device) if on_device is not None else None,
                              "write": write, "state": state, "reason": reason, "sync": sync_rows.get(port)})
    settled = {p["port"]: p["write"] for p in body["ports"]
               if p["state"] == "in_sync" and p["sync"] and p["sync"]["status"] in ("failed", "pending")}
    if settled and body["reachable"]:
        try:
            fixed = await _settle(dev.id, settled, read.get("read_at", ""))
        except Exception as exc:
            _say(f"name-sync: could not record a compare result ({type(exc).__name__})")
            fixed = {}
        for entry in body["ports"]:
            entry["sync"] = fixed.get(entry["port"], entry["sync"])
    return body


async def _settle(device_id: str, matches: dict[str, str], read_at: str) -> dict[str, dict]:
    """A live read shows the device already holds the name a failed row (or a pending row no worker is writing) wants:
    record it synced. Compare-and-set on status, desired and revision; only rows last changed before that read
    started, so an older shared read never settles a newer save."""
    busy = _lock(device_id).locked()
    stamp, fixed = _now(), {}
    async with _session_factory() as db:
        lease = await db.get(DeviceNameSyncLease, device_id)
        leased = lease is not None and lease.until > time.time()
        found = (await db.execute(select(DeviceNameSync).where(
            DeviceNameSync.device_id == device_id, DeviceNameSync.port.in_(list(matches))))).scalars().all()
        for row in found:
            if row.status not in ("failed", "pending") or row.desired != matches[row.port] or row.updated_at > read_at:
                continue
            if row.status == "pending" and (busy or leased):
                continue   # a worker is on it
            done = await db.execute(update(DeviceNameSync).where(
                DeviceNameSync.device_id == device_id, DeviceNameSync.port == row.port,
                DeviceNameSync.status == row.status, DeviceNameSync.desired == row.desired,
                DeviceNameSync.revision == row.revision).values(status="synced", reason="", synced_at=stamp,
                                                                updated_at=stamp))
            if done.rowcount == 1:
                fixed[row.port] = {"status": "synced", "desired": row.desired, "reason": "", "updated_at": stamp,
                                   "synced_at": stamp}
        await db.commit()
    return fixed


async def push(device_id: str, ports: set[str], expected: dict[str, str | None]) -> list[dict]:
    """The panel's "Write names to device" for exactly `ports`, awaited, with the same plan and worker code as the
    automatic push. Raises ExpectedMismatch (a site name changed since the compare) or Busy (another process)."""
    lock, deadline = _lock(device_id), time.monotonic() + PUSH_LEASE_WAIT
    try:   # a background batch may be writing this device: answer "busy" instead of holding the request
        await asyncio.wait_for(lock.acquire(), PUSH_LEASE_WAIT)
    except asyncio.TimeoutError:
        raise Busy() from None
    try:
        while not await _acquire(device_id):
            if time.monotonic() >= deadline:
                raise Busy()
            await asyncio.sleep(LEASE_POLL_SECONDS)
        try:
            await _enqueue({device_id: ports}, expected=expected)
            outcome = await _run_batch(device_id, ports)
        finally:
            await _release(device_id)
    finally:
        lock.release()
    async with _session_factory() as db:
        rows = {r.port: r for r in (await db.execute(select(DeviceNameSync).where(
            DeviceNameSync.device_id == device_id, DeviceNameSync.port.in_(list(ports))))).scalars()}
    results = []
    for port in sorted(ports, key=int):
        row, done = rows.get(port), outcome.get(port)
        if done is not None:
            results.append({"port": port, "status": done["status"], "device": done.get("device"), "reason": done["reason"]})
        else:
            results.append({"port": port, "status": row.status if row else "skipped", "device": None,
                            "reason": row.reason if row else NO_SITE_NAME})
    return results


# ── Lifecycle ────────────────────────────────────────────────────────────────────────────────────────────────────


async def _sweep(reason: str, older_than: float = 0.0) -> None:
    """Pending rows that no live lease covers (and, with older_than, that waited that long) become failed: nothing
    is replayed after a restart."""
    now = time.time()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=older_than)).isoformat(timespec="microseconds")
    async with _session_factory() as db:
        await db.execute(update(DeviceNameSyncLease).where(DeviceNameSyncLease.owner == _OWNER).values(owner="", until=0))
        live = select(DeviceNameSyncLease.device_id).where(DeviceNameSyncLease.until > now)
        stale = update(DeviceNameSync).where(DeviceNameSync.status == "pending", DeviceNameSync.device_id.not_in(live))
        if older_than:
            stale = stale.where(DeviceNameSync.updated_at <= cutoff)
        await db.execute(stale.values(status="failed", reason=reason, updated_at=_now()))
        await db.commit()


async def _late_sweep() -> None:
    """A process that died holding a lease leaves it live for up to LEASE_SECONDS; its rows are swept after that."""
    await asyncio.sleep(LEASE_SECONDS + 5)
    try:
        await _sweep(RESTARTED, older_than=LEASE_SECONDS)
    except Exception as exc:
        _say(f"name-sync: could not check unfinished names ({type(exc).__name__})")


async def start() -> None:
    """App startup: unfinished names from before a restart become failed "Interrupted by a restart — retry"."""
    try:
        await _sweep(RESTARTED)
    except Exception as exc:
        _say(f"name-sync: could not check unfinished names ({type(exc).__name__})")
    _spawn(_late_sweep())


async def drain() -> None:
    """Wait until every background worker has finished (tests)."""
    while _workers:
        await asyncio.gather(*list(_workers), return_exceptions=True)


async def stop() -> None:
    """App shutdown: cancel the workers; what they left pending becomes failed "Interrupted by a restart — retry"."""
    tasks = list(_tasks)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    try:
        await _sweep(RESTARTED)
    except Exception as exc:
        _say(f"name-sync: could not record unfinished names ({type(exc).__name__})")
    reset_state()


def reset_state() -> None:
    """Forget in-process state (tests: each test has its own event loop and database)."""
    _tasks.clear()
    _workers.clear()
    _locks.clear()
    _reads.clear()
    _warned.clear()
