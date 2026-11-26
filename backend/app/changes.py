"""Live data sync (owner's rule, 2026-11-10): a change made anywhere shows on every open screen within seconds.

The server keeps one change counter per data domain and bumps it after every successful write under /api/. Pages
read it with GET /api/changes every 2 s (frontend/src/api/changes.js) and reload what the moved domains feed.

GET /api/changes -> 200 {"rev": int, "domains": {name: int}, "at": iso | null}, Cache-Control: no-store. Viewer role
with accounts on; with accounts off it needs the site password like every other GET (it is not a public read).
`rev` goes up by one per bump. Each domain holds the `rev` of its last change (0: not changed since the counter file
was started). `at` is the time of the last bump (null before the first one). A lower `rev` than before means the
counter file was started again: clients then reload everything (changedDomains in changes.js).

Storage: changes.json next to inventory_store.ITEMS_FILE (backend/ on a deployment; a test's temporary folder when the
test moves ITEMS_FILE; FILE overrides both). A bump reads, counts and replaces the file (temporary file + os.replace)
under inventory_store.locked_file (changes.lock beside it), so every uvicorn worker shares one counter: the file is the
truth, never process memory. A read is cached by the file's identity, modification time and size, for at most
READ_CACHE_SECONDS, so the 2 s poll of every open page costs one stat(). A missing or damaged file reads as rev 0.

What bumps: ChangeFeed (the outermost middleware of app.main) counts a POST, PUT, PATCH or DELETE under /api/ that
answers 2xx, once its handler has finished and just before the answer starts, so the writing tab's own poll right after
the answer sees it; a refused, failed or crashed write (any other status, or an exception) counts nothing. A handler can
add domains with note() (PUT /api/rack-layout adds inventory for rack_items, devices + monitoring for port_labels)
or say that it wrote nothing with unchanged() (dry runs and previews). Writes made outside an HTTP request call
record(): assistant actions (also the ones that run in the background), finished ping monitor rounds, device name sync
batches and a rack layout save that had to put its port labels back. A failed bump is logged once (until a bump works
again) and never fails the write it counts.

DOMAIN TABLE (RULES; the first matching rule wins; the path without its trailing "/"):
  never      /api/auth/*, /api/changes, /api/inventory/webpe-status (the webpe heartbeat, every 20 s), /api/version,
             /api/kvms/{id}/proxy/* (the KVM's own web client, any method: device traffic, not Lab Manager data)
  layout     PUT /api/rack-slots, /api/rack-positions, /api/rack-overrides, /api/switch-assignments,
             PUT /api/rack-layout (+ inventory when it carried rack_items, + devices + monitoring when it carried
                  port_labels: a swap rewrites the floors' outlet and port labels)
  inventory  PUT /api/rack-items; POST /api/inventory, /api/inventory/{id}/barcode|location|details (Scan & Track),
             POST /api/inventory/serial-details (webpe / serial lookup; a dry run counts nothing);
             PUT /api/chillers, POST /api/chillers/restore
  owners     PUT /api/opt-owners, PUT /api/opt-owners/{asset_key}, POST /api/engineers, PUT /api/engineers/{id}
  devices    POST /api/devices/rename-opt -> devices + layout + owners + monitoring (the name, rack ids, owner and
                  monitor follow the server; a dry run counts nothing)
             POST /api/devices/move-server -> devices + layout + monitoring (a dry run counts nothing; + inventory
                  when units moved with their servers: rack_items, or units_follow from Locations / the assistant)
             POST /api/devices/, PUT|DELETE /api/devices/{id}, PATCH /api/devices/{id}/labels,
             PATCH /api/devices/direct-label, POST /api/devices/{id}/device-names/push -> devices + monitoring (port
                  labels name the servers; a monitor's name and rack follow them)
             POST /api/kvms/{id}/ports/{port}/mark-in-use|mark-free, POST /api/kvms/{id}/mark-free (IN USE marker)
  removed    POST /api/removed-servers, POST /api/removed-servers/restore -> removed + layout + owners + monitoring
             (a removal cleans the server's rack entries and owner and pauses its monitor; a dry run counts nothing)
             POST /api/lab/delete, POST /api/lab/restore -> devices + layout + inventory + owners + removed +
                  monitoring + twin + power (one delete can touch every store; a dry run counts nothing);
             DELETE /api/lab/deleted/{batch_id} (Delete forever) -> removed
  monitoring POST /api/monitoring/targets, PUT /api/monitoring/targets/{id}, POST /api/monitoring/check
  twin       PUT /api/twin-data
  power      POST /api/pdus/{id}/outlets/{n}/power, POST /api/pdus/{id}/maintenance/shutdown|restore
  other      every other write under /api/: users and own account (/api/users*, /api/me*), PXE (/api/pxe/*), SSH
             (/api/ssh/*), the lab assistant (/api/assistant/*, including action proposals)
Outside HTTP (record()): assistant actions, when they finish: power switching and PDU maintenance -> power; location
changes (server swap, move, clear) -> devices + layout + monitoring. Ping monitor round finished -> monitoring.
Monitors of placeholder labels deleted by discovery (ping_monitor.discover_targets) -> monitoring.
Device name sync batch written -> devices.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import time
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from . import inventory_store

log = logging.getLogger(__name__)

DOMAINS = ("layout", "inventory", "owners", "devices", "removed", "monitoring", "twin", "power", "other")
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
FILE = None                 # a path overrides the default place (tests); None: changes.json next to ITEMS_FILE
READ_CACHE_SECONDS = 1.0    # a cached read is also re-read after this long (a coarse file clock cannot hide a bump)
SAVE_FAILED = "The change counter could not be saved."
LOCK_ATTEMPTS = 3           # Windows only matters: msvcrt's lock gives up after about 10 s under heavy write load

RULES = tuple((re.compile(pattern), domains) for pattern, domains in (
    (r"/api/(auth(/.*)?|changes|inventory/webpe-status|version|kvms/[^/]+/proxy(/.*)?)", ()),
    (r"/api/(rack-slots|rack-positions|rack-overrides|switch-assignments|rack-layout)", ("layout",)),
    (r"/api/(rack-items|inventory(/.*)?|chillers(/.*)?)", ("inventory",)),
    (r"/api/(opt-owners|engineers)(/.*)?", ("owners",)),
    (r"/api/devices/rename-opt", ("devices", "layout", "owners", "monitoring")),
    (r"/api/devices/move-server", ("devices", "layout", "monitoring")),
    (r"/api/devices(/.*)?", ("devices", "monitoring")),
    (r"/api/kvms(/.*)?", ("devices",)),
    (r"/api/removed-servers(/.*)?", ("removed", "layout", "owners", "monitoring")),
    (r"/api/lab/(delete|restore)", ("devices", "layout", "inventory", "owners", "removed", "monitoring", "twin", "power")),
    (r"/api/lab/deleted(/.*)?", ("removed",)),
    (r"/api/monitoring(/.*)?", ("monitoring",)),
    (r"/api/twin-data", ("twin",)),
    (r"/api/pdus(/.*)?", ("power",)),
    (r"/api(/.*)?", ("other",)),
))

# Domains of the writes made outside an HTTP request: assistant actions by their switch kind.
ACTION_DOMAINS = {"off": ("power",), "on": ("power",), "cycle": ("power",), "maintenance_off": ("power",),
                  "maintenance_on": ("power",), "data": ("devices", "layout", "monitoring")}

# Captured at import: a test that replaces os.replace or inventory_store.locked_file for the store it checks must
# not see (or break) the counter's own write that follows every successful request.
_replace = os.replace
_locked_file = inventory_store.locked_file
_cache = None               # ((path, inode, mtime_ns, size), monotonic time read, answer)
_warned = False


def domains_for(path: str) -> tuple:
    """The domains a successful write to `path` changes; () for a path that never counts (and for non-API paths)."""
    path = path.rstrip("/") or "/"
    for pattern, domains in RULES:
        if pattern.fullmatch(path):
            return domains
    return ()


def changes_file() -> Path:
    return Path(FILE) if FILE else inventory_store.ITEMS_FILE.with_name("changes.json")


def _empty() -> dict:
    return {"rev": 0, "domains": {name: 0 for name in DOMAINS}, "at": None}


def _parse(raw: bytes) -> dict:
    """The stored counter as GET answers it; a damaged or foreign file is the empty counter."""
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        return _empty()
    rev = data.get("rev") if isinstance(data, dict) else None
    if type(rev) is not int or rev < 0:
        return _empty()
    stored = data.get("domains") if isinstance(data.get("domains"), dict) else {}
    domains = {}
    for name in DOMAINS:
        value = stored.get(name)
        domains[name] = value if type(value) is int and 0 <= value <= rev else 0
    return {"rev": rev, "domains": domains, "at": data["at"] if isinstance(data.get("at"), str) else None}


def _copy(answer: dict) -> dict:
    return {"rev": answer["rev"], "domains": dict(answer["domains"]), "at": answer["at"]}


def _load(path: Path) -> bytes:
    return path.read_bytes()


def current() -> dict:
    """The counter now (GET /api/changes). A stat() per call; the file is read again only when it changed."""
    global _cache
    path = changes_file()
    name = str(path)
    cached = _cache if _cache and _cache[0][0] == name else None
    try:
        info = path.stat()
    except FileNotFoundError:
        return _empty()
    except OSError:
        return _copy(cached[2]) if cached else _empty()
    key = (name, info.st_ino, info.st_mtime_ns, info.st_size)
    now = time.monotonic()
    if cached and cached[0] == key and now - cached[1] < READ_CACHE_SECONDS:
        return _copy(cached[2])
    try:
        answer = _parse(_load(path))
    except FileNotFoundError:
        return _empty()
    except OSError:
        # Windows: the file is being replaced at this moment. The last answer is still right for this poll.
        return _copy(cached[2]) if cached else _empty()
    _cache = (key, now, answer)
    return _copy(answer)


def _write(path: Path, data: dict) -> None:
    """Atomic: a temporary file in the same folder replaces `path`. No fsync: a counter lost in a power cut only
    makes every page reload once (rev goes back), it never shows wrong data."""
    filename = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".changes-", suffix=".tmp",
                                         encoding="utf-8", delete=False) as out:
            filename = out.name
            json.dump(data, out)
        for attempt in range(5):
            try:
                _replace(filename, path)
                break
            except PermissionError:
                # Windows refuses to replace a file that a poll is reading at this very moment.
                if attempt == 4:
                    raise
                time.sleep(0.02)
    finally:
        if filename and os.path.exists(filename):
            os.unlink(filename)


def bump(domains) -> dict:
    """Count one change of `domains` (an unknown name counts as "other"): rev + 1, and each domain gets the new rev.
    Returns the new counter. Raises on failure (bump_quietly and record never do)."""
    wanted = {name if name in DOMAINS else "other" for name in domains}
    if not wanted:
        return current()
    path = changes_file()
    for attempt in range(1, LOCK_ATTEMPTS + 1):
        locked = False
        try:
            with _locked_file(path, SAVE_FAILED):
                locked = True
                try:
                    state = _parse(_load(path))
                except FileNotFoundError:
                    state = _empty()
                state["rev"] += 1
                for name in wanted:
                    state["domains"][name] = state["rev"]
                state["at"] = datetime.now(timezone.utc).isoformat()
                _write(path, state)
            return state
        except Exception:
            # Only a lock that could not be taken is tried again: nothing was read or written then, so the change is
            # counted exactly once. (On Windows msvcrt gives up after about 10 s when many writers queue for the lock,
            # which lost a few bumps under load: QA 2026-11-10. flock on Linux waits as long as it takes.)
            if locked or attempt == LOCK_ATTEMPTS:
                raise
    raise AssertionError("unreachable")


def bump_quietly(domains):
    """bump(), but a failure is only logged (once, until a bump works again): a change is never refused for it."""
    global _warned
    try:
        state = bump(domains)
    except Exception as exc:  # noqa: BLE001 - the counter must never break the write it counts
        if not _warned:
            _warned = True
            # Class name only: an OSError text can hold a server path.
            log.warning("Live sync: the change counter could not be updated (%s); open pages show this change on "
                        "their next reload.", type(exc).__name__)
        return None
    _warned = False
    return state


async def record(domains) -> None:
    """For writes made outside an HTTP write (background jobs) and by ChangeFeed: bump `domains` off the event loop.
    Never raises for a failed bump (a cancellation still propagates; the bump then finishes in its thread)."""
    domains = tuple(domains or ())
    if domains:
        try:
            await asyncio.to_thread(bump_quietly, domains)
        except Exception:  # noqa: BLE001 - no thread left (shutting down): the pages' next reload shows the change
            pass


class _Pending:
    """What the handler of one write request said about it (note / unchanged)."""
    __slots__ = ("extra", "skip", "counted")

    def __init__(self):
        self.extra, self.skip, self.counted = set(), False, False


_request: ContextVar = ContextVar("dcim_change_request", default=None)


def note(*domains) -> None:
    """Inside a write request: these domains changed too (counted with the path's own when the write succeeds)."""
    pending = _request.get()
    if pending is not None:
        pending.extra.update(domains)


def unchanged() -> None:
    """Inside a write request: nothing was written (a dry run or preview), so the path's domains are not counted;
    domains given to note() still are."""
    pending = _request.get()
    if pending is not None:
        pending.skip = True


class ChangeFeed:
    """ASGI middleware, added last in app.main so it is the outermost of the app's own: it sees the final status of
    every request (the account and password checks' refusals included) and every handler, the assistant's action
    endpoints too. The bump runs when the answer starts, after the handler and its dependencies have finished."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in WRITE_METHODS:
            return await self.app(scope, receive, send)
        domains = domains_for(scope.get("path", ""))
        if not domains:
            return await self.app(scope, receive, send)
        pending = _Pending()
        token = _request.set(pending)

        async def answer(message):
            if message["type"] == "http.response.start" and not pending.counted:
                pending.counted = True
                if 200 <= message.get("status", 500) < 300:
                    await record(pending.extra | (set() if pending.skip else set(domains)))
            await send(message)

        try:
            await self.app(scope, receive, answer)
        finally:
            _request.reset(token)


router = APIRouter(prefix="/api", tags=["live sync"])


@router.get("/changes")
async def get_changes():
    """The change counters (see the module docstring). Cheap: pages poll it every 2 s."""
    return JSONResponse(current(), headers={"Cache-Control": "no-store"})
