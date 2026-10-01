"""Read-only PDU/KVM observations and server-to-port associations."""
import asyncio
import json
import time

from sqlalchemy import select

from .models import Device, MonitorDeviceSnapshot, MonitorDeviceError
from .ping_monitor import CONCURRENCY, iso, next_slot, server_identity


def _configuration(device):
    return device.kind, device.ip, device.username_enc, device.password_enc, device.enabled


async def refresh_devices(session_factory):
    from .routers import pdus, kvms
    async with session_factory() as db:
        devices = (await db.execute(select(Device).where(
            Device.kind.in_(("pdu", "kvm")), Device.enabled.is_(True),
        ))).scalars().all()
    gate = asyncio.Semaphore(CONCURRENCY)

    async def fetch(device):
        router = pdus if device.kind == "pdu" else kvms
        async with gate:
            try:
                budget = 45 if device.kind == "pdu" else 20
                result = await asyncio.wait_for(router._fetch_status(device.id, device), timeout=budget)
                reason = failure_reason(getattr(result,"error", "")) if not result.reachable else ""
            except asyncio.TimeoutError:
                reason = f"Device status timed out after {budget} seconds. Check device load and VM network access."
                result = None
            except Exception as exc:
                reason = failure_reason(str(exc))
                result = None  # Never reuse a successful cache entry after a failed check.
            return device, result, time.time(), reason

    tasks = [asyncio.create_task(fetch(device)) for device in devices]
    try:
        # Network requests are bounded and parallel; SQLite writes are serialized.
        for task in asyncio.as_completed(tasks):
            device, result, checked_at, reason = await task
            async with session_factory() as db:
                current = await db.get(Device, device.id)
                if not current or _configuration(current) != _configuration(device):
                    continue  # Ignore results for a removed/reconfigured device.
                snapshot = await db.get(MonitorDeviceSnapshot, device.id)
                if snapshot and snapshot.checked_at > checked_at:
                    continue
                if result is not None:
                    router = pdus if device.kind == "pdu" else kvms
                    router._cache[device.id] = (time.monotonic(), result)
                previous = json.loads(snapshot.ports_json) if snapshot and (snapshot.kind, snapshot.ip) == (device.kind, device.ip) else []
                reachable = bool(result and result.reachable)
                # Retain learned port associations across failures, including labels
                # discovered on the device rather than configured in Lab Manager.
                ports = {p["number"]: {**p, "missing": True} for p in previous}
                if reachable:
                    entries = result.outlets if device.kind == "pdu" else result.ports
                    for entry in entries:
                        port = entry.model_dump()
                        if not server_identity(port["label"]) and entry.number in ports:
                            port["label"] = ports[entry.number]["label"]
                        ports[entry.number] = port
                if not snapshot:
                    snapshot = MonitorDeviceSnapshot(device_id=device.id)
                    db.add(snapshot)
                snapshot.kind, snapshot.ip = device.kind, device.ip
                snapshot.checked_at, snapshot.reachable = checked_at, reachable
                snapshot.ports_json = json.dumps(list(ports.values()))
                diagnostic = await db.get(MonitorDeviceError, device.id)
                if not diagnostic:
                    diagnostic = MonitorDeviceError(device_id=device.id)
                    db.add(diagnostic)
                diagnostic.checked_at, diagnostic.detail = checked_at, reason
                from .alerts import observe_device_api
                await observe_device_api(db, current, reachable, reason, checked_at)
                if device.kind == "pdu":
                    from .alerts import observe_power
                    await observe_power(db, current, result, checked_at)
                await db.commit()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def connection_index(db, tz, now):
    """Join all matching outlets/ports, without rack-based or fuzzy guesses."""
    devices = (await db.execute(select(Device).where(Device.kind.in_(("pdu", "kvm")))
                                .order_by(Device.name, Device.id))).scalars().all()
    snapshots = {s.device_id: s for s in (await db.execute(select(MonitorDeviceSnapshot))).scalars()}
    diagnostics = {d.device_id:d for d in (await db.execute(select(MonitorDeviceError))).scalars()}
    index = {}
    for device in devices:
        snapshot = snapshots.get(device.id)
        if snapshot and (snapshot.kind, snapshot.ip) != (device.kind, device.ip):
            snapshot = None
        ports = {str(p["number"]): p for p in json.loads(snapshot.ports_json)} if snapshot else {}
        labels = {number: port["label"] for number, port in ports.items()}
        labels.update(device.labels)  # Current saved labels override observed labels.
        for number, label in sorted(labels.items(), key=lambda pair: str(pair[0])):
            identity = server_identity(label)
            if not identity:
                continue
            port = ports.get(str(number))
            status, detail = "unknown", "Device responded, but this port's live state is unavailable."
            if not device.enabled:
                status, detail = "disabled", "Device monitoring is disabled."
            elif not snapshot:
                status, detail = "pending", "Awaiting the first scheduled device check."
            elif now > next_slot(snapshot.checked_at, tz) + 120:
                status, detail = "stale", "The last observation is overdue. Run Check all now to refresh."
            elif not snapshot.reachable:
                status, detail = "error", "Device check failed. Network, credentials or device API may be unavailable."
                diagnostic = diagnostics.get(device.id)
                if diagnostic and diagnostic.checked_at == snapshot.checked_at and diagnostic.detail:
                    detail = diagnostic.detail
            elif port and not port.get("missing"):
                if device.kind == "pdu":
                    status = port.get("state", "unknown")
                    detail = {"on": "PDU responded and reports this outlet ON.",
                              "off": "PDU responded and reports this outlet OFF.",
                              "cycling": "PDU reports a power cycle in progress."}.get(status, detail)
                    if status not in {"on", "off", "cycling"}:
                        status = "unknown"
                elif port.get("status_source") == "live":
                    status = port.get("status", "unknown")
                    detail = {"active": "KVM reports an active port connection.",
                              "idle": "KVM reports this port idle; a working console session was not tested.",
                              "empty": "KVM reports no available target on this port."}.get(status, detail)
                    if status not in {"active", "idle", "empty"}:
                        status = "unknown"
                elif port.get("status_source") == "configured":
                    status = "configured" if port.get("status") != "empty" else "empty"
                    detail = "KVM responded; its configuration lists this port, but live console health is unverified." if status == "configured" else "KVM configuration does not list a target on this port."
            connection = {
                "device_id": device.id, "device_name": device.name, "device_ip": device.ip,
                "port": str(number), "status": status, "detail": detail,
                "checked_at": iso(snapshot.checked_at) if snapshot else None,
                "device_reachable": snapshot.reachable if snapshot and status not in {"stale", "disabled", "pending"} else None,
            }
            index.setdefault("server:" + identity[0], {"pdu": [], "kvm": []})[device.kind].append(connection)
    return index


def failure_reason(message):
    """Explain the failure without storing device response bodies or credentials."""
    lowered = str(message or "").lower()
    if "401" in lowered or "403" in lowered or "auth" in lowered:
        return "Device authentication failed. Check the saved username, password and permissions."
    if "connecttimeout" in lowered or "connection timeout" in lowered:
        return "Connection timeout: the VM could not establish a connection to the device API. Check the address, HTTPS access and network."
    if "readtimeout" in lowered:
        return "Device API request timeout: receiving data from the device took too long. Check device load and network stability."
    if "pooltimeout" in lowered:
        return "Device API request timeout: a local connection slot was not available in time. This does not establish a device outage."
    if "timeout" in lowered or "timed out" in lowered:
        return "The device API did not respond before its request timeout."
    if "connection" in lowered or "connect" in lowered or "unreachable" in lowered:
        return "Could not connect to the device API from the VM. Check the address and network."
    return "The device API returned no usable status. Check the device service and configuration."
