"""Protected PDU outlets: outlets that bulk power actions never switch (the VM host, network switches, KVMs).

POWER_PROTECTED_OUTLETS is "<PDU device id or exact name>:<outlet>[,...]" or the literal "none" (an explicit statement that
nothing needs protection). An empty setting means "not configured": rack-wide and lab-wide actions are refused. Any entry that
does not parse, names no existing PDU, or names an outlet out of range makes the whole list invalid (stale), because a silently
ignored entry could be the outlet that feeds the site itself.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Protection:
    configured: bool                     # False when the setting is empty
    outlets: frozenset = frozenset()     # {(pdu_device_id, outlet_number)}
    errors: tuple = ()                   # English, one per bad entry; non-empty means the list is not usable

    @property
    def usable(self) -> bool:
        return self.configured and not self.errors

    def is_protected(self, pdu_id: str, outlet: int) -> bool:
        return (pdu_id, int(outlet)) in self.outlets

    def for_pdu(self, pdu_id: str) -> frozenset:
        return frozenset(n for d, n in self.outlets if d == pdu_id)


def parse(raw: str | None, pdus) -> Protection:
    """pdus: iterable of objects with .id, .name and optionally .port_count (Device rows with kind 'pdu' work)."""
    text = (raw or "").strip()
    if not text:
        return Protection(configured=False)
    if text.lower() == "none":
        return Protection(configured=True)
    by_id = {}
    by_name = {}
    for dev in pdus:
        by_id[str(dev.id)] = dev
        by_name.setdefault(str(getattr(dev, "name", "") or ""), []).append(dev)
    outlets, errors = set(), []
    for index, entry in enumerate(part.strip() for part in text.split(",")):
        if not entry:
            errors.append(f"Entry {index + 1} is empty")   # ",," must never read as an empty (= unprotected) list
            continue
        ref, sep, number = entry.rpartition(":")
        if not sep or not ref.strip() or not number.strip().isdigit():
            errors.append(f"Entry {index + 1} is not '<PDU>:<outlet>'")
            continue
        ref, outlet = ref.strip(), int(number.strip())
        dev = by_id.get(ref)
        if dev is None:
            named = by_name.get(ref, [])
            if len(named) != 1:
                errors.append(f"Entry {index + 1} names {'no' if not named else 'more than one'} PDU")
                continue
            dev = named[0]
        count = getattr(dev, "port_count", None)
        if outlet < 1 or (isinstance(count, int) and count > 0 and outlet > count):
            errors.append(f"Entry {index + 1} names an outlet out of range")
            continue
        outlets.add((str(dev.id), outlet))
    return Protection(configured=True, outlets=frozenset(outlets), errors=tuple(errors))


async def load(db, settings) -> Protection:
    """Parse the setting against the PDUs in the database."""
    from sqlalchemy import select

    from .models import Device

    rows = (await db.execute(select(Device).where(Device.kind == "pdu"))).scalars().all()
    return parse(getattr(settings, "power_protected_outlets", ""), rows)
