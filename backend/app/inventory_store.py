"""Atomic, versioned access to the existing DCIM rack equipment inventory."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile

from fastapi import HTTPException

ITEMS_FILE = Path(__file__).resolve().parent.parent / "rack_items.json"
HISTORY_LIMIT = 100
TRACKING_FIELDS = ("tracking_history", "last_seen_at")


def read_items():
    try:
        data = json.loads(ITEMS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise HTTPException(503, "Equipment inventory cannot be read. No changes were saved.") from exc
    if not isinstance(data, dict) or any(not isinstance(v, list) for v in data.values()):
        raise HTTPException(503, "Equipment inventory has an invalid format. No changes were saved.")
    if any(not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] for items in data.values() for item in items):
        raise HTTPException(503, "Equipment inventory contains an invalid item. No changes were saved.")
    return data


def revision(data):
    content = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return '"' + hashlib.sha256(content.encode()).hexdigest() + '"'


def check_revision(data, expected):
    if not expected:
        raise HTTPException(428, "Reload the equipment inventory before saving.")
    if expected != revision(data):
        raise HTTPException(409, "Equipment changed in another session. Refresh, review its location, and try again.")


@contextmanager
def locked_items():
    """Also serialize writers across uvicorn workers on the Linux deployment."""
    try:
        with ITEMS_FILE.with_suffix(".lock").open("a+b") as lock:
            if os.name == "nt":
                import msvcrt
                if lock.tell() == 0:
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield read_items()
            finally:
                if os.name == "nt":
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock, fcntl.LOCK_UN)
    except OSError as exc:
        raise HTTPException(503, "Equipment inventory could not be saved. Please retry.") from exc


def write_items(data):
    filename = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=ITEMS_FILE.parent, prefix=".rack-items-", suffix=".tmp", encoding="utf-8", delete=False) as out:
            filename = out.name
            json.dump(data, out, indent=2, ensure_ascii=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(filename, ITEMS_FILE)
    finally:
        if filename and os.path.exists(filename):
            os.unlink(filename)


def location(rack, item):
    return {"rack": rack, "u": item.get("u"), "position": item.get("shelf_position", "")}


def identifiers(item):
    return {str(item.get(key) or "").strip().casefold() for key in ("id", "serial_number", "barcode")} - {""}


def ensure_unique(data, code, exclude_id=None):
    key = code.strip().casefold()
    if key and any(key in identifiers(item) and item["id"] != exclude_id for items in data.values() for item in items):
        raise HTTPException(409, "This barcode or serial number already belongs to another item.")


def record(item, action, before, after, note=""):
    event = {"at": datetime.now(timezone.utc).isoformat(), "action": action, "from": before, "to": after, "note": note}
    item["tracking_history"] = [*item.get("tracking_history", []), event][-HISTORY_LIMIT:]
    return event


def replace_items(payload, expected):
    """Existing DCIM/Twin editors participate in version checks and movement history."""
    with locked_items() as current:
        check_revision(current, expected)
        incoming = deepcopy(payload)
        previous = {item["id"]: (rack, item) for rack, items in current.items() for item in items}
        seen = set()
        # Validate the complete shape before uniqueness checks inspect other racks.
        for rack, items in incoming.items():
            if not isinstance(rack, str) or not rack.strip() or not isinstance(items, list):
                raise HTTPException(422, "Expected racks containing equipment lists.")
            for item in items:
                if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or item["id"] in seen:
                    raise HTTPException(422, "Every equipment item needs a unique ID.")
                seen.add(item["id"])
        for rack, items in incoming.items():
            for item in items:
                old_rack, old = previous.get(item["id"], (None, {}))
                for field in TRACKING_FIELDS:
                    item.pop(field, None)
                    if field in old:
                        item[field] = deepcopy(old[field])
                for field in ("barcode", "serial_number"):
                    if item.get(field) != old.get(field) and item.get(field):
                        ensure_unique(incoming, str(item[field]), item["id"])
                if old and location(old_rack, old) != location(rack, item):
                    record(item, "moved", location(old_rack, old), location(rack, item), "Edited in DCIM or 3D Twin")
        write_items(incoming)
        return incoming
