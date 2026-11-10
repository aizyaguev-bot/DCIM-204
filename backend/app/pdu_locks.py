"""Per-device lock shared by PDU maintenance, outlet switching and device edits (single-process registry)."""
import asyncio

_locks: dict[str, asyncio.Lock] = {}


def maintenance_lock(device_id: str) -> asyncio.Lock:
    return _locks.setdefault(device_id, asyncio.Lock())
