"""Computers derived from live KVM port and PDU outlet labels, keyed by the canonical server identity."""
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Device
from ..ping_monitor import server_identity


def computer_key(name: str) -> str | None:
    identity = server_identity(name)
    return identity[0] if identity else None


def allowlist(value: str) -> set[str]:
    return {key for part in re.split(r"[\s,;]+", value or "") if part and (key := computer_key(part))}


def _labels(dev: Device) -> dict[str, str]:
    from ..routers import kvms, pdus
    labels = dict(dev.labels)
    cached = (pdus._cache if dev.kind == "pdu" else kvms._cache).get(dev.id)
    if cached:
        for entry in (cached[1].outlets if dev.kind == "pdu" else cached[1].ports):
            labels.setdefault(str(entry.number), entry.label)
    return labels


async def computers(db: AsyncSession) -> dict[str, dict]:
    """{key: {key, name, rack, kvm:[...], pdu:[...]}} for every identity with at least one KVM port."""
    devices = (await db.scalars(select(Device).where(Device.enabled.is_(True), Device.kind.in_(("kvm", "pdu")))
                                .order_by(Device.name, Device.id))).all()
    found: dict[str, dict] = {}
    for dev in devices:
        for number, label in _labels(dev).items():
            try:
                port = int(number)
            except (TypeError, ValueError):
                continue
            identity = server_identity(label)
            if not identity or port < 1:
                continue
            key, canonical, _ = identity
            entry = found.setdefault(key, {"key": key, "name": canonical, "rack": "", "kvm": [], "pdu": []})
            if dev.kind == "kvm":
                entry["kvm"].append({"device_id": dev.id, "device_name": dev.name, "model": dev.model, "port": port})
                entry["rack"] = entry["rack"] or dev.rack
            else:
                entry["pdu"].append({"device_id": dev.id, "device_name": dev.name, "outlet": port})
    result = {}
    for key in sorted(found):
        entry = found[key]
        if not entry["kvm"]:
            continue
        entry["kvm"].sort(key=lambda k: (k["device_name"], k["device_id"], k["port"]))
        entry["pdu"].sort(key=lambda p: (p["device_name"], p["device_id"], p["outlet"]))
        if not entry["rack"] and entry["pdu"]:
            entry["rack"] = next((d.rack for d in devices if d.id == entry["pdu"][0]["device_id"]), "")
        result[key] = entry
    return result


def resolve_kvm(computer: dict, kvm_device_id: str | None, kvm_port: int | None) -> dict:
    """The single KVM port of a computer, or the explicitly chosen one; ValueError when ambiguous or invalid."""
    options = computer["kvm"]
    if kvm_device_id is None and kvm_port is None:
        if len(options) != 1:
            raise ValueError("This computer is connected to more than one KVM port; choose one")
        return options[0]
    match = [k for k in options if k["device_id"] == kvm_device_id and k["port"] == kvm_port]
    if not match:
        raise ValueError("The chosen KVM port is not mapped to this computer")
    return match[0]
