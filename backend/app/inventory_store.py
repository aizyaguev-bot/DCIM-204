"""Atomic, versioned access to the existing DCIM rack equipment inventory."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile

from fastapi import HTTPException

ITEMS_FILE = Path(__file__).resolve().parent.parent / "rack_items.json"
HISTORY_LIMIT = 100
TRACKING_FIELDS = ("tracking_history", "last_seen_at")
MAX_U = 42
U_SLOT_INVALID = "U slot must be a whole number from 0 to 42."
LAYOUT_CONFLICT = "This layout was changed in another session. Reload and try again."
LAYOUT_SAVE_FAILED = "The layout could not be saved. Please retry."
NOT_FINITE = "Numbers must be finite (no NaN or Infinity). Nothing was saved."


def reject_non_finite(payload):
    """422 for a NaN or Infinity anywhere in `payload`: Python's json accepts them (JSON.stringify never sends them),
    and once stored every later GET of that store would be a 500. Saves call this before taking any lock."""
    pending = [payload]
    while pending:
        value = pending.pop()
        if isinstance(value, float) and not math.isfinite(value):
            raise HTTPException(422, NOT_FINITE)
        if isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)


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
def locked_file(path, detail):
    """Also serialize writers across uvicorn workers on the Linux deployment. The lock file sits next to `path`."""
    try:
        with path.with_suffix(".lock").open("a+b") as lock:
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
                yield
            finally:
                if os.name == "nt":
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock, fcntl.LOCK_UN)
    except OSError as exc:
        raise HTTPException(503, detail) from exc


@contextmanager
def locked_items():
    with locked_file(ITEMS_FILE, "Equipment inventory could not be saved. Please retry."):
        yield read_items()


def write_json(path, data, prefix=None, ensure_ascii=True):
    """Atomic: a temporary file in the same folder replaces `path`."""
    filename = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=prefix or f".{path.stem}-", suffix=".tmp", encoding="utf-8", delete=False) as out:
            filename = out.name
            json.dump(data, out, indent=2, ensure_ascii=ensure_ascii)
            out.flush()
            os.fsync(out.fileno())
        os.replace(filename, path)
    finally:
        if filename and os.path.exists(filename):
            os.unlink(filename)


def write_items(data):
    write_json(ITEMS_FILE, data, prefix=".rack-items-", ensure_ascii=False)


def read_layout(path, default):
    """A missing or unreadable layout file reads as the store's empty value, as before."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_layout(path, payload, expected, default, ensure_ascii=True):
    """If-Match is optional, so old kiosk pages keep saving; a stale revision leaves the file untouched."""
    reject_non_finite(payload)
    with locked_file(path, LAYOUT_SAVE_FAILED):
        if expected and expected != revision(read_layout(path, default)):
            raise HTTPException(409, LAYOUT_CONFLICT)
        write_json(path, payload, ensure_ascii=ensure_ascii)
    return revision(payload)


def location(rack, item):
    return {"rack": rack, "u": item.get("u"), "position": item.get("shelf_position", "")}


# What a scanned unit label says about the unit, kept as separate fields of the item. `serial_number` is the stored
# name of the serial (the API also accepts "serial"). A missing or blank value is simply absent from the item.
DETAIL_FIELDS = ("serial_number", "part_number", "model", "mac")
DETAIL_LIMITS = {"serial_number": 200, "part_number": 120, "model": 120, "mac": 40}
DETAIL_LABELS = {"serial_number": "Serial number", "part_number": "Part number", "model": "Model", "mac": "MAC address"}
MAC_INVALID = "MAC address must be six pairs of hex digits, like 00:1A:2B:3C:4D:5E."
DUPLICATE_CODE = "This barcode or serial number already belongs to another item."
DUPLICATE_MAC = "This MAC address already belongs to another item."
_MAC_FORMS = (
    re.compile(r"([0-9A-Fa-f]{2})([:-])([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})"),
    re.compile(r"([0-9A-Fa-f]{12})"),
    re.compile(r"([0-9A-Fa-f]{4})\.([0-9A-Fa-f]{4})\.([0-9A-Fa-f]{4})"),
)


def normalize_mac(value):
    """'00-1a-2b-3c-4d-5e', '001A2B3C4D5E' or '001a.2b3c.4d5e' -> '00:1A:2B:3C:4D:5E'; anything else -> None."""
    text = value.strip() if isinstance(value, str) else ""
    for form in _MAC_FORMS:
        match = form.fullmatch(text)
        if match:
            digits = "".join(g for g in match.groups() if g not in (":", "-")).upper()
            return ":".join(digits[i:i + 2] for i in range(0, 12, 2))
    return None


def clean_detail(field, value):
    """One detail value as it is stored: trimmed text, '' when blank (= absent). Raises ValueError with a sentence."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{DETAIL_LABELS[field]} must be text.")
    value = value.strip()
    if not value:
        return ""
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"{DETAIL_LABELS[field]} cannot contain control characters.")
    if field == "mac":
        mac = normalize_mac(value)
        if mac is None:
            raise ValueError(MAC_INVALID)
        return mac
    if len(value) > DETAIL_LIMITS[field]:
        raise ValueError(f"{DETAIL_LABELS[field]} can be at most {DETAIL_LIMITS[field]} characters.")
    return value


def mac_key(value):
    """The lookup key of a MAC: its normalised form, so any separator style finds the unit."""
    mac = normalize_mac(value)
    if mac:
        return mac.casefold()
    return str(value or "").strip().casefold() if isinstance(value, str) else ""


def identifiers(item):
    """Every value that names exactly one unit, as text to search by: its id, serial, barcode and MAC."""
    return ({str(item.get(key) or "").strip().casefold() for key in ("id", "serial_number", "barcode")} | {mac_key(item.get("mac"))}) - {""}


def identity_key(value):
    """The one comparable form of an identifier: anything that reads as a MAC in any spelling becomes its
    normalised MAC, so 'B8CEF6001122', 'b8-ce-f6-00-11-22' and 'B8:CE:F6:00:11:22' are the same identifier."""
    text = str(value or "").strip()
    return (normalize_mac(text) or text).casefold()


def identity_keys(item):
    """The identity keys of a unit (id, serial, barcode, MAC). Lookup and the duplicate rule both use these."""
    return {identity_key(item.get(key)) for key in ("id", "serial_number", "barcode", "mac")} - {""}


def lookup_keys(code):
    """A scanned or typed code as lookup keys, compared with `identity_keys` (00-1A-... finds 00:1A:... and 001A...)."""
    return {identity_key(code)} - {""}


def identity_index(data):
    """{identity key: ids of the units that have it} for every unit in `data`, each unit's keys normalised once.
    A whole-list save builds this once and checks each changed unit against it instead of rescanning every unit."""
    index = {}
    for items in data.values():
        for item in items:
            for key in identity_keys(item):
                index.setdefault(key, set()).add(item["id"])
    return index


def ensure_unique(data, code, exclude_id=None, detail=DUPLICATE_CODE, index=None):
    """`code` must not be an identity of another unit, compared exactly as a lookup compares it.
    `index` (from `identity_index(data)`) answers the same question without rescanning `data`."""
    key = identity_key(code)
    if not key:
        return
    if index is not None:
        taken = any(owner != exclude_id for owner in index.get(key, ()))
    else:
        taken = any(key in identity_keys(item) and item["id"] != exclude_id for items in data.values() for item in items)
    if taken:
        raise HTTPException(409, detail)


def ensure_unique_details(data, item, exclude_id=None, fields=DETAIL_FIELDS):
    """The serial and the MAC of `item` (for the `fields` given) must not name another unit."""
    if "serial_number" in fields and item.get("serial_number"):
        ensure_unique(data, str(item["serial_number"]), exclude_id)
    if "mac" in fields and item.get("mac"):
        ensure_unique(data, mac_key(item["mac"]), exclude_id, DUPLICATE_MAC)


def apply_details(item, values):
    """Set the cleaned `values` ({field: text}) on `item`; '' removes the field. Returns the fields that changed."""
    changed = []
    for field, value in values.items():
        if value:
            if item.get(field) != value:
                item[field] = value
                changed.append(field)
        elif field in item:
            del item[field]
            changed.append(field)
    return changed


def record(item, action, before, after, note=""):
    event = {"at": datetime.now(timezone.utc).isoformat(), "action": action, "from": before, "to": after, "note": note}
    item["tracking_history"] = [*item.get("tracking_history", []), event][-HISTORY_LIMIT:]
    return event


def valid_u(value):
    """A U slot is a JSON whole number 0..MAX_U; booleans, floats, strings and null are not."""
    return type(value) is int and 0 <= value <= MAX_U


def _same_u(old, item):
    # Type-strict: JSON 1.0 or true must not pass as an unchanged legacy 1.
    a, b = old.get("u"), item.get("u")
    return type(a) is type(b) and a == b


def replace_items(payload, expected):
    """Existing DCIM/Twin editors participate in version checks and movement history.

    Refusal order: revision (428/409), then shape, U slot and unit details (422), then barcode/serial/MAC
    uniqueness (409).
    Nothing is written when any of them fails. A NaN or Infinity anywhere is 422 before the lock is taken."""
    reject_non_finite(payload)
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
                # New items and changed U values must be valid; an untouched legacy value is kept as it is.
                _, old = previous.get(item["id"], (None, None))
                if not valid_u(item.get("u")) and (old is None or not _same_u(old, item)):
                    raise HTTPException(422, U_SLOT_INVALID)
                # Like the scanner's link step, a whole-list save never drops or replaces a linked barcode:
                # a stale DCIM/Twin copy that omits, blanks or changes it keeps the stored one. Restored here,
                # before any uniqueness check, so a new item cannot take that barcode in the same save.
                if old is not None and old.get("barcode") and item.get("barcode") != old["barcode"]:
                    item["barcode"] = old["barcode"]
                # Serial, part number, model and MAC: a new or changed value is cleaned (trimmed, MAC as 00:1A:...,
                # blank = absent); an untouched legacy value is kept exactly as it is.
                for field in DETAIL_FIELDS:
                    if old is None or item.get(field) != old.get(field):
                        try:
                            value = clean_detail(field, item.get(field))
                        except ValueError as exc:
                            raise HTTPException(422, str(exc)) from exc
                        if value:
                            item[field] = value
                        else:
                            item.pop(field, None)
        # Identity keys are final from here on (only tracking fields change below), so one index of the whole
        # list serves every changed unit's check: O(n) instead of a rescan of every unit per changed value.
        # Only changed values are checked, so a legacy collision does not block an unrelated edit.
        index = None
        for rack, items in incoming.items():
            for item in items:
                old_rack, old = previous.get(item["id"], (None, {}))
                for field in TRACKING_FIELDS:
                    item.pop(field, None)
                    if field in old:
                        item[field] = deepcopy(old[field])
                checks = [(str(item[field]), DUPLICATE_CODE) for field in ("barcode", "serial_number")
                          if item.get(field) != old.get(field) and item.get(field)]
                if item.get("mac") != old.get("mac") and item.get("mac"):
                    checks.append((mac_key(item["mac"]), DUPLICATE_MAC))
                for code, detail in checks:
                    if index is None:
                        index = identity_index(incoming)
                    ensure_unique(incoming, code, item["id"], detail, index)
                if old and location(old_rack, old) != location(rack, item):
                    record(item, "moved", location(old_rack, old), location(rack, item), "Edited in DCIM or 3D Twin")
        write_items(incoming)
        return incoming


# ─── several layout stores in one step (server moves from the Digital Twin) ───────────────────────────────────────
LAYOUT_NOT_RESTORED = ("The rack layout was only partly saved and could not be fully restored ({files}). "
                       "Reload and check the rack positions.")


def _put_back(path, raw):
    """Restore a file's exact previous bytes (None: the file did not exist)."""
    if raw is None:
        path.unlink(missing_ok=True)
        return
    filename = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent, prefix=f".{path.stem}-", suffix=".tmp", delete=False) as out:
            filename = out.name
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.replace(filename, path)
    finally:
        if filename and os.path.exists(filename):
            os.unlink(filename)


def _holds_bytes(path, raw):
    try:
        return path.read_bytes() == raw
    except FileNotFoundError:
        return raw is None
    except OSError:
        return False


def save_layouts(entries):
    """Write several layout stores together or not at all. `entries`: [(name, path, payload, expected, default)].

    Every file lock is taken first, always in one order (by path). Every If-Match revision is then checked before
    anything is written: one stale or missing revision means nothing is written (409 / 428). If a write fails, each
    file already written is put back to its exact previous bytes while the locks are still held, so no other writer
    can see or save the half-written layout. Synchronous on purpose: nothing awaits while the locks are held."""
    from contextlib import ExitStack
    for _, _, payload, _, _ in entries:
        reject_non_finite(payload)
    with ExitStack() as locks:
        for _, path, *_ in sorted(entries, key=lambda e: str(e[1])):
            locks.enter_context(locked_file(path, LAYOUT_SAVE_FAILED))
        previous = {}
        for name, path, _, expected, default in entries:
            if not expected:
                raise HTTPException(428, "Reload the rack layout before saving.")
            if expected != revision(read_layout(path, default)):
                raise HTTPException(409, LAYOUT_CONFLICT)
            try:
                previous[name] = path.read_bytes()
            except FileNotFoundError:
                previous[name] = None
            except OSError as exc:
                raise HTTPException(503, LAYOUT_SAVE_FAILED) from exc
        written = []
        try:
            for name, path, payload, _, _ in entries:
                written.append((name, path))
                write_json(path, payload)
        except BaseException as exc:
            unrestored = []
            for name, path in written:
                try:
                    _put_back(path, previous[name])
                except Exception:
                    pass
                if not _holds_bytes(path, previous[name]):
                    unrestored.append(name)
            if not isinstance(exc, Exception):
                raise
            if unrestored:
                raise HTTPException(503, LAYOUT_NOT_RESTORED.format(files=", ".join(unrestored))) from exc
            raise HTTPException(503, LAYOUT_SAVE_FAILED) from exc
    return {name: revision(payload) for name, _, payload, _, _ in entries}


# ─── versioned layout store: cooling units keep their previous documents (history + restore) ──────────────────────
VERSIONS_LIMIT = 20
STORE_UNREADABLE = "The cooling units file cannot be read, so it was not changed. No changes were saved."
HISTORY_UNREADABLE = "The cooling unit history cannot be read."
UNKNOWN_VERSION = "This cooling unit version is not in the history any more. Reload the history and try again."
UNITS_KEPT = "Cooling units cannot be deleted. Move the unit to another rack or leave it unassigned instead."


def history_path(path):
    """chillers.json -> chillers_history.json, in the same folder (also a backend/*.json runtime file)."""
    return path.with_name(f"{path.stem}_history.json")


def _read_store(path, default):
    """(document, existed). Missing reads as `default`; a file that exists but cannot be read or parsed is 503,
    so a save never replaces data it could not keep in the history."""
    try:
        return json.loads(path.read_text(encoding="utf-8")), True
    except FileNotFoundError:
        return deepcopy(default), False
    except (OSError, ValueError) as exc:
        raise HTTPException(503, STORE_UNREADABLE) from exc


def _valid_history(data):
    return (isinstance(data, dict) and isinstance(data.get("last_revision"), int)
            and isinstance(data.get("versions"), list)
            and all(isinstance(v, dict) and isinstance(v.get("revision"), int) for v in data["versions"]))


def read_history(path):
    """The stored history of `path` ({"last_revision", "versions": oldest first}); missing is empty, unreadable is 503."""
    try:
        data = json.loads(history_path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"last_revision": 0, "versions": []}
    except (OSError, ValueError) as exc:
        raise HTTPException(503, HISTORY_UNREADABLE) from exc
    if not _valid_history(data):
        raise HTTPException(503, HISTORY_UNREADABLE)
    return data


def _history_for_write(path):
    """A write never stops because of a damaged history: the unreadable file is renamed (never deleted) to
    <name>.unreadable-<UTC time>.json, still a backend/*.json runtime file the installer backs up, and a new history starts."""
    try:
        return read_history(path)
    except HTTPException:
        broken = history_path(path)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        os.replace(broken, broken.with_name(f"{broken.stem}.unreadable-{stamp}.json"))
        return {"last_revision": 0, "versions": []}


def _units(document):
    units = document.get("units") if isinstance(document, dict) else None
    return [u for u in units if isinstance(u, dict)] if isinstance(units, list) else []


def _removed_units(before, after):
    kept = {u.get("id") for u in _units(after)}
    return [{key: unit.get(key) for key in ("id", "name", "rack", "u")}
            for unit in _units(before) if unit.get("id") not in kept]


def _prune(versions, limit=VERSIONS_LIMIT):
    """Keep at most `limit` versions. A version that a later save removed units from is dropped last, so a unit that
    disappeared stays restorable through many ordinary moves; only then does the oldest version go."""
    versions = list(versions)
    while len(versions) > limit:
        plain = next((i for i, v in enumerate(versions) if not v.get("removed")), 0)
        versions.pop(plain)
    return versions


def _places(document):
    return [{key: unit.get(key) for key in ("id", "name", "rack", "u")} for unit in _units(document)]


def public_version(version):
    """A history entry without its stored document. `places` lists each unit of that document ({id, name, rack, u}),
    so a page can show what changed between versions and which units a restore keeps."""
    public = {key: deepcopy(version[key]) for key in ("revision", "at", "by", "units", "action", "removed", "restored_from")
              if key in version}
    if "document" in version:
        public["places"] = _places(version["document"])
    return public


def _commit_version(path, current, existed, payload, by, action, restored_from=None):
    """Called with the store's lock held. The replaced document goes into the history file first, so it is on disk
    before the store changes; if the store write then fails, the history file gets its exact previous bytes back."""
    if not existed or revision(current) == revision(payload):
        write_json(path, payload)  # nothing to keep: no previous file, or the same document again
        return
    history = _history_for_write(path)
    number = history["last_revision"] + 1
    version = {"revision": number, "at": datetime.now(timezone.utc).isoformat(), "by": by, "action": action,
               "units": len(_units(current)), "removed": _removed_units(current, payload), "document": current}
    if restored_from is not None:
        version["restored_from"] = restored_from
    target = history_path(path)
    try:
        previous = target.read_bytes()
    except FileNotFoundError:
        previous = None
    write_json(target, {"last_revision": number, "versions": _prune([*history["versions"], version])})
    try:
        write_json(path, payload)
    except BaseException:
        try:
            _put_back(target, previous)
        except Exception:
            pass
        raise


def _dropped_units(current, payload):
    """The units of `current` (with an id) that `payload` leaves out."""
    kept = {u.get("id") for u in _units(payload)}
    return [unit for unit in _units(current) if unit.get("id") is not None and unit.get("id") not in kept]


def save_versioned(path, payload, expected, default, by=None):
    """save_layout with history: If-Match stays optional (409 when stale); the document it replaces is kept.
    Units are never deleted: a payload that leaves out a unit id of the current document is 422 and changes nothing
    (422, not 409, because the pages retry a 409 once)."""
    reject_non_finite(payload)
    with locked_file(path, LAYOUT_SAVE_FAILED):
        current, existed = _read_store(path, default)
        if expected and expected != revision(current):
            raise HTTPException(409, LAYOUT_CONFLICT)
        dropped = _dropped_units(current, payload) if existed else []
        if dropped:
            names = ", ".join(str(u.get("name") or u.get("id")) for u in dropped[:5])
            more = f" and {len(dropped) - 5} more" if len(dropped) > 5 else ""
            raise HTTPException(422, f"{UNITS_KEPT} Left out: {names}{more}.")
        _commit_version(path, current, existed, payload, by, "save")
    return revision(payload)


def restore_version(path, number, expected, default, by=None):
    """Write history version `number` as the current document (merged with merge_restore, so units added since are
    kept); the document it replaces becomes a new version. Needs the current revision (428 without, 409 when stale);
    404 for a revision the history does not hold."""
    with locked_file(path, LAYOUT_SAVE_FAILED):
        current, existed = _read_store(path, default)
        if not expected:
            raise HTTPException(428, "Reload the cooling units before restoring a version.")
        if expected != revision(current):
            raise HTTPException(409, LAYOUT_CONFLICT)
        version = next((v for v in read_history(path)["versions"] if v["revision"] == number), None)
        if version is None or "document" not in version:
            raise HTTPException(404, UNKNOWN_VERSION)
        document = merge_restore(version["document"], current)
        _commit_version(path, current, existed, document, by, "restore", restored_from=number)
    return document, revision(document)


def merge_restore(version_document, current):
    """A restore never deletes a unit: the version's document (its units, places, extra fields and connections) plus
    every current unit the version does not hold, kept where it is now."""
    document = deepcopy(version_document) if isinstance(version_document, dict) else {}
    units = document.get("units") if isinstance(document.get("units"), list) else []
    known = {u.get("id") for u in units if isinstance(u, dict) and u.get("id") is not None}
    added = [deepcopy(u) for u in _units(current) if u.get("id") is not None and u.get("id") not in known]
    document["units"] = [*units, *added]
    return document
