"""Live sync (app/changes.py): GET /api/changes and the change counter that every successful write under /api/ bumps.

Covers the counter file (atomic, locked, shared by every worker, cheap cached reads), the ChangeFeed middleware (the
reviewed domains of every write route in app.main, excluded paths, refused writes, multi-domain writes, note() and
unchanged()), a failed bump never failing the write, and access: Viewer with accounts, the site password without.
Temporary folders and in-process ASGI clients only (conftest keeps the counter in its own temporary folder): no device,
VM, live site or network.
"""
import asyncio
import hashlib
import json
import re
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient, BasicAuth
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, changes, inventory_store
from app.database import Base, get_db
from app.models import Device, User

PASSWORD = "changes-test-password-1"
_REAL_SCRYPT = hashlib.scrypt


def moved(before, after):
    """The domains whose counters differ between two answers."""
    return {name for name in changes.DOMAINS if after["domains"][name] != before["domains"][name]}


def stub_app(status=200):
    """ChangeFeed around a catch-all /api route answering `status` (or raising for /api/crash)."""
    app = FastAPI()
    app.add_middleware(changes.ChangeFeed)
    app.include_router(changes.router)

    @app.api_route("/api/crash", methods=["POST"])
    async def crash():
        raise RuntimeError("synthetic failure")

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def anything(path: str):
        if status >= 400:
            raise HTTPException(status, "refused")
        return {"ok": True}

    @app.post("/outside")
    async def outside():
        return {"ok": True}
    return app


def client_for(app, **kwargs):
    return AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test", **kwargs)


# ── The counter file ────────────────────────────────────────────────────────────────────────────────────────────────

def test_before_any_change_every_counter_is_zero():
    assert changes.current() == {"rev": 0, "domains": {name: 0 for name in changes.DOMAINS}, "at": None}
    assert not changes.changes_file().exists()


def test_a_bump_counts_once_and_stamps_each_domain_with_the_new_rev():
    first = changes.bump(["layout"])
    assert first["rev"] == 1 and first["domains"]["layout"] == 1 and first["at"]
    second = changes.bump(["owners", "monitoring", "not-a-domain"])
    assert second["rev"] == 2
    assert {name: value for name, value in second["domains"].items() if value} == {
        "layout": 1, "owners": 2, "monitoring": 2, "other": 2}
    assert changes.current() == second
    assert json.loads(changes.changes_file().read_text()) == second
    assert not list(changes.changes_file().parent.glob("*.tmp"))


def test_by_default_the_counter_sits_next_to_the_equipment_list(tmp_path, monkeypatch):
    monkeypatch.setattr(changes, "FILE", None)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    assert changes.changes_file() == tmp_path / "changes.json"
    changes.bump(["twin"])
    assert sorted(p.name for p in tmp_path.iterdir()) == ["changes.json", "changes.lock"]
    assert changes.current()["domains"]["twin"] == 1


def test_a_damaged_counter_reads_as_zero_and_the_next_bump_repairs_it():
    changes.changes_file().write_text("{broken")
    assert changes.current()["rev"] == 0
    assert changes.bump(["power"])["rev"] == 1
    changes.changes_file().write_text(json.dumps({"rev": 5, "domains": {"layout": 9, "power": "x", "twin": 4}}))
    assert changes.current() == {"rev": 5, "domains": {**{n: 0 for n in changes.DOMAINS}, "twin": 4}, "at": None}


def test_reads_are_cached_by_the_file_and_see_every_other_workers_bump(monkeypatch):
    loads = []
    real_load = changes._load

    def counting(path):
        loads.append(path)
        return real_load(path)
    monkeypatch.setattr(changes, "_load", counting)
    monkeypatch.setattr(changes, "READ_CACHE_SECONDS", 60.0)
    changes.bump(["layout"])
    loads.clear()
    assert [changes.current()["rev"] for _ in range(5)] == [1] * 5
    assert len(loads) == 1, "an unchanged file is read once, then answered from the cache"
    # Another uvicorn worker writes the file (this process never counted it): the next read sees it.
    other = {"rev": 7, "domains": {**{n: 0 for n in changes.DOMAINS}, "inventory": 7}, "at": "2026-11-10T00:00:00+00:00"}
    changes._write(changes.changes_file(), other)
    assert changes.current() == other and len(loads) == 2
    # Process memory is never the truth: a fresh process (no cache) answers the same.
    monkeypatch.setattr(changes, "_cache", None)
    assert changes.current() == other


def test_concurrent_bumps_never_lose_a_count():
    errors = []

    def worker():
        try:
            for _ in range(5):
                changes.bump(["layout"])
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert changes.current()["rev"] == 20 and changes.current()["domains"]["layout"] == 20


def test_a_failed_bump_is_logged_once_without_details_and_never_raises(monkeypatch, caplog):
    real_lock = changes._locked_file

    def broken_lock(path, detail):
        raise HTTPException(503, detail)
    monkeypatch.setattr(changes, "_locked_file", broken_lock)
    with caplog.at_level("WARNING", logger="app.changes"):
        assert changes.bump_quietly(["layout"]) is None
        assert changes.bump_quietly(["layout"]) is None
    warnings = [r for r in caplog.records if r.name == "app.changes"]
    assert len(warnings) == 1 and "HTTPException" in warnings[0].getMessage()
    assert str(changes.changes_file().parent) not in warnings[0].getMessage()
    monkeypatch.setattr(changes, "_locked_file", real_lock)
    assert changes.bump_quietly(["layout"])["rev"] == 1 and changes._warned is False


def test_a_lock_that_could_not_be_taken_is_tried_again_and_counts_once(monkeypatch):
    """Windows: msvcrt gives up on a contended lock after about 10 s (QA 2026-11-10 lost 3 of 900 bumps that way)."""
    real_lock, tries = changes._locked_file, []

    def busy_twice(path, detail):
        tries.append(path)
        if len(tries) <= 2:
            raise HTTPException(503, detail)   # as locked_file answers OSError 36 "Resource deadlock avoided"
        return real_lock(path, detail)
    monkeypatch.setattr(changes, "_locked_file", busy_twice)
    assert changes.bump(["layout"])["rev"] == 1 and len(tries) == 3
    assert changes.current()["rev"] == 1


def test_a_failure_after_the_lock_was_taken_is_never_counted_twice(monkeypatch):
    calls = []

    def broken_write(path, data):
        calls.append(data["rev"])
        raise OSError("disk full")
    monkeypatch.setattr(changes, "_write", broken_write)
    with pytest.raises(HTTPException):
        changes.bump(["layout"])
    assert calls == [1] and changes.current()["rev"] == 0


async def test_record_bumps_off_the_event_loop():
    await changes.record(("monitoring",))
    await changes.record(())
    assert changes.current()["rev"] == 1 and changes.current()["domains"]["monitoring"] == 1


# ── ChangeFeed: what counts, when ───────────────────────────────────────────────────────────────────────────────────

def concrete(template):
    path = re.sub(r"\{[^}:]+:path\}", "jsclient/page.asp", template)
    return re.sub(r"\{[^}]+\}", "x1", path)


SERVER_FOLLOWS = {"devices", "monitoring"}
# The reviewed domains of every write route in app.main (changes.py documents the same table).
WRITE_DOMAINS = {
    # Server places.
    "PUT /api/rack-slots": {"layout"}, "PUT /api/rack-positions": {"layout"}, "PUT /api/rack-overrides": {"layout"},
    "PUT /api/switch-assignments": {"layout"}, "PUT /api/rack-layout": {"layout"},
    # Units, scans, serial details, cooling units.
    "PUT /api/rack-items": {"inventory"}, "POST /api/inventory": {"inventory"},
    "POST /api/inventory/{item_id}/barcode": {"inventory"}, "POST /api/inventory/{item_id}/location": {"inventory"},
    "POST /api/inventory/{item_id}/details": {"inventory"}, "POST /api/inventory/serial-details": {"inventory"},
    "PUT /api/chillers": {"inventory"}, "POST /api/chillers/restore": {"inventory"},
    # Owners and engineers.
    "PUT /api/opt-owners": {"owners"}, "PUT /api/opt-owners/{asset_key:path}": {"owners"},
    "POST /api/engineers": {"owners"}, "PUT /api/engineers/{engineer_id}": {"owners"},
    # Devices and port labels (a monitor's name and rack follow the labels); renames and moves carry more.
    "POST /api/devices/": SERVER_FOLLOWS, "PUT /api/devices/{device_id}": SERVER_FOLLOWS,
    "DELETE /api/devices/{device_id}": SERVER_FOLLOWS, "PATCH /api/devices/{device_id}": SERVER_FOLLOWS,
    "PATCH /api/devices/{device_id}/labels": SERVER_FOLLOWS,
    "PATCH /api/devices/direct-label": SERVER_FOLLOWS, "POST /api/devices/{device_id}/device-names/push": SERVER_FOLLOWS,
    "POST /api/devices/rename-opt": {"devices", "layout", "owners", "monitoring"},
    "POST /api/devices/move-server": {"devices", "layout", "monitoring"},
    # Clearing a server's location rewrites only port labels (its rack layout entries are kept).
    "POST /api/devices/clear-server": SERVER_FOLLOWS,
    "POST /api/kvms/{device_id}/ports/{port}/mark-in-use": {"devices"},
    "POST /api/kvms/{device_id}/ports/{port}/mark-free": {"devices"}, "POST /api/kvms/{device_id}/mark-free": {"devices"},
    # Removed servers: their rack entries, owner and monitor change with them.
    "POST /api/removed-servers": {"removed", "layout", "owners", "monitoring"},
    "POST /api/removed-servers/restore": {"removed", "layout", "owners", "monitoring"},
    # Delete and restore can touch every store; the Deleted list's own write (Delete forever) only itself.
    "POST /api/lab/delete": {"devices", "layout", "inventory", "owners", "removed", "monitoring", "twin", "power"},
    "POST /api/lab/restore": {"devices", "layout", "inventory", "owners", "removed", "monitoring", "twin", "power"},
    "DELETE /api/lab/deleted/{batch_id}": {"removed"},
    "POST /api/monitoring/check": {"monitoring"}, "POST /api/monitoring/targets": {"monitoring"},
    "PUT /api/monitoring/targets/{target_id}": {"monitoring"},
    "PUT /api/twin-data": {"twin"},
    "POST /api/pdus/{device_id}/outlets/{outlet_number}/power": {"power"},
    "POST /api/pdus/{device_id}/maintenance/shutdown": {"power"}, "POST /api/pdus/{device_id}/maintenance/restore": {"power"},
    # Never: sign-in, the webpe heartbeat and the KVM's own web client.
    "POST /api/auth/login": set(), "POST /api/auth/register": set(), "POST /api/auth/logout": set(),
    "PUT /api/inventory/webpe-status": set(),
    **{f"{m} /api/kvms/{{device_id}}/proxy/{{path:path}}": set() for m in ("POST", "PUT", "DELETE")},
    # Everything else is "other".
    **{key: {"other"} for key in (
        "PUT /api/me", "PUT /api/me/preferences", "PUT /api/me/password", "POST /api/me/end-other-sessions",
        "POST /api/users", "PATCH /api/users/{user_id}", "DELETE /api/users/{user_id}",
        "POST /api/users/{user_id}/end-sessions", "POST /api/users/{user_id}/reset-password",
        "POST /api/pxe/jobs", *(f"POST /api/pxe/jobs/{{job_id}}/{a}" for a in (
            "start", "refresh-screenshot", "choose-boot", "choose-grub", "install", "cancel", "takeover", "complete",
            "acknowledge")),
        "POST /api/ssh/key", "PUT /api/ssh/config", "POST /api/ssh/hosts/{key}/accept", "POST /api/ssh/sessions/end",
        "POST /api/assistant/chat", "DELETE /api/assistant/conversations/{conversation_id}",
        "POST /api/assistant/work-items", "PATCH /api/assistant/work-items/{item_id}", "PUT /api/assistant/key",
        "DELETE /api/assistant/key", "POST /api/assistant/actions/proposals",
        "POST /api/assistant/actions/proposals/{proposal_id}/cancel",
        "POST /api/assistant/actions/proposals/{proposal_id}/execute")},
}


def test_every_write_route_in_main_has_its_reviewed_domains():
    import app.main as main
    actual = {}
    for route in main.app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api"):
            for method in route.methods & changes.WRITE_METHODS:
                actual[f"{method} {route.path}"] = set(changes.domains_for(concrete(route.path)))
    assert sorted(set(actual) - set(WRITE_DOMAINS)) == [], "a new write route needs reviewed live sync domains"
    assert sorted(set(WRITE_DOMAINS) - set(actual)) == [], "a reviewed write route no longer exists in app.main"
    assert {key: value for key, value in actual.items() if value != WRITE_DOMAINS[key]} == {}
    assert all(set(domains) <= set(changes.DOMAINS) for _, domains in changes.RULES)


def test_the_feed_is_the_outermost_middleware_of_the_site():
    """It sees the final status of every request: refusals of the account and password checks never count."""
    import app.main as main
    assert main.app.user_middleware[0].cls is changes.ChangeFeed
    assert {m.cls for m in main.app.user_middleware[1:]} >= {accounts.AccountAccess}


async def test_a_successful_write_counts_its_domains_once():
    async with client_for(stub_app()) as c:
        for method, path, want in (("PUT", "/api/rack-slots", {"layout"}), ("POST", "/api/devices/", SERVER_FOLLOWS),
                                   ("DELETE", "/api/users/u1", {"other"}), ("PATCH", "/api/devices/direct-label", SERVER_FOLLOWS),
                                   ("POST", "/api/removed-servers", {"removed", "layout", "owners", "monitoring"}),
                                   ("POST", "/api/devices/rename-opt", {"devices", "layout", "owners", "monitoring"}),
                                   ("PUT", "/api/twin-data/", {"twin"})):
            before = (await c.get("/api/changes")).json()
            assert (await c.request(method, path)).status_code == 200
            after = (await c.get("/api/changes")).json()
            assert after["rev"] == before["rev"] + 1 and moved(before, after) == want, path


async def test_reads_excluded_paths_and_other_sites_never_count():
    async with client_for(stub_app()) as c:
        for method, path in (("GET", "/api/rack-slots"), ("GET", "/api/monitoring"), ("POST", "/api/auth/login"),
                             ("POST", "/api/auth/logout"), ("PUT", "/api/inventory/webpe-status"), ("POST", "/api/changes"),
                             ("POST", "/api/version"), ("POST", "/api/kvms/k1/proxy/jsclient/Client.asp"),
                             ("PUT", "/api/kvms/k1/proxy"), ("POST", "/outside")):
            assert (await c.request(method, path)).status_code == 200, path
        assert (await c.get("/api/changes")).json()["rev"] == 0


@pytest.mark.parametrize("status", [401, 403, 404, 409, 422, 428, 503])
async def test_a_refused_write_counts_nothing(status):
    async with client_for(stub_app(status)) as c:
        assert (await c.put("/api/rack-slots", json={})).status_code == status
        assert (await c.get("/api/changes")).json()["rev"] == 0


async def test_a_crashed_write_counts_nothing():
    async with client_for(stub_app()) as c:
        assert (await c.post("/api/crash")).status_code == 500
        assert (await c.get("/api/changes")).json()["rev"] == 0


async def test_the_count_is_made_before_the_answer_starts():
    """The writing tab polls right after the answer: the bump must already be in the file then."""
    seen = []

    async def send(message):
        if message["type"] == "http.response.start":
            seen.append((message["status"], changes.current()["rev"]))

    messages = [{"type": "http.request", "body": b"{}", "more_body": False}]

    async def receive():
        return messages.pop(0) if messages else {"type": "http.disconnect"}
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "PUT", "scheme": "http",
             "path": "/api/rack-slots", "raw_path": b"/api/rack-slots", "root_path": "", "query_string": b"",
             "headers": [(b"content-type", b"application/json")], "client": ("127.0.0.1", 1), "server": ("test", 80)}
    await stub_app()(scope, receive, send)
    assert seen == [(200, 1)]


async def test_handlers_add_domains_or_say_that_nothing_was_written():
    app = FastAPI()
    app.add_middleware(changes.ChangeFeed)

    @app.put("/api/rack-layout")
    async def with_items():
        changes.note("inventory")
        return {"ok": True}

    @app.post("/api/devices/move-server")
    def preview():   # a sync handler runs in a worker thread: the note still reaches the middleware
        changes.unchanged()
        return {"ok": True}

    @app.post("/api/removed-servers")
    async def preview_with_note():
        changes.unchanged()
        changes.note("power")
        return {"ok": True}

    @app.put("/api/rack-slots")
    async def refused_after_note():
        changes.note("inventory")
        raise HTTPException(409, "stale")

    async with client_for(app) as c:
        expected = (("PUT", "/api/rack-layout", 200, {"layout", "inventory"}), ("POST", "/api/devices/move-server", 200, set()),
                    ("POST", "/api/removed-servers", 200, {"power"}), ("PUT", "/api/rack-slots", 409, set()))
        for method, path, status, want in expected:
            before = changes.current()
            assert (await c.request(method, path)).status_code == status
            assert moved(before, changes.current()) == want, path
    changes.note("layout")    # outside a request: nothing to note, nothing breaks
    changes.unchanged()


# ── The real site ───────────────────────────────────────────────────────────────────────────────────────────────────

SITE_FILES = ("_RACK_POSITIONS_FILE", "_RACK_SLOTS_FILE", "_SWITCH_ASSIGN_FILE", "_RACK_OVERRIDES_FILE", "_CHILLERS_FILE",
              "_TWIN_DATA_FILE")


@pytest.fixture
async def site(db_session, tmp_path, monkeypatch):
    """app.main with every store in tmp_path, no accounts and no site password."""
    import app.main as main
    from app.routers import devices
    for attr in SITE_FILES:
        monkeypatch.setattr(main, attr, tmp_path / getattr(main, attr).name)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    settings = SimpleNamespace(accounts_enabled=False, lab_manager_password="")
    monkeypatch.setattr(main, "get_settings", lambda: settings)

    async def database():
        yield db_session
    main.app.dependency_overrides[get_db] = database
    async with client_for(main.app) as c:
        c.settings, c.folder = settings, tmp_path
        yield c
    main.app.dependency_overrides.clear()


async def test_get_changes_is_never_cached(site):
    r = await site.get("/api/changes")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert r.json() == {"rev": 0, "domains": {name: 0 for name in changes.DOMAINS}, "at": None}


async def test_site_writes_count_their_domains_and_refusals_count_nothing(site):
    async def step(method, path, want, status=200, **kwargs):
        before = (await site.get("/api/changes")).json()
        r = await site.request(method, path, **kwargs)
        assert r.status_code in (status if isinstance(status, tuple) else (status,)), r.text
        after = (await site.get("/api/changes")).json()
        assert moved(before, after) == want, path
        assert after["rev"] == before["rev"] + (1 if want else 0)
        return r

    await step("PUT", "/api/rack-slots", {"layout"}, json={"Rack-01": {"opt11": 1}})
    await step("PUT", "/api/rack-overrides", {"layout"}, json={"opt11": "Rack-02"})
    await step("PUT", "/api/twin-data", {"twin"}, json={"racks": []})
    await step("PUT", "/api/chillers", {"inventory"}, json={"units": [], "connections": []})
    etag = (await site.get("/api/rack-items")).headers["etag"]
    await step("PUT", "/api/rack-items", {"inventory"}, json={"Rack-01": [{"id": "u1", "u": 3}]}, headers={"If-Match": etag})
    # Refused: missing / stale revisions, an invalid unit, an unknown route.
    await step("PUT", "/api/rack-items", set(), status=428, json={})
    await step("PUT", "/api/rack-items", set(), status=409, json={}, headers={"If-Match": etag})
    stale = {"rack_slots": {"data": {}, "if_match": inventory_store.revision({"other": 1})}}
    await step("PUT", "/api/rack-layout", set(), status=409, json=stale)
    await step("PUT", "/api/rack-layout", set(), status=422, json={})
    await step("POST", "/api/no-such-route", set(), status=(404, 405))
    await step("GET", "/api/rack-slots", set())   # a read never counts


async def test_previews_count_nothing_and_the_applied_move_counts_server_places(site, db_session):
    db_session.add(Device(id="pdu1", name="PDU-1", kind="pdu", ip="192.0.2.1", rack="Rack-01", port_count=8,
                          labels_json=json.dumps({"1": "OPT11", "2": "OPT12"})))
    await db_session.commit()
    swap = {"server": "OPT11", "target_server": "OPT12", "swap": True}
    preview = await site.post("/api/devices/move-server", json={**swap, "dry_run": True})
    assert preview.status_code == 200, preview.text
    renamed = await site.post("/api/devices/rename-opt", json={"old_name": "OPT11", "new_name": "OPT13", "dry_run": True})
    assert renamed.status_code == 200, renamed.text
    assert changes.current()["rev"] == 0
    applied = await site.post("/api/devices/move-server", json={**swap, "plan_revision": preview.json()["plan_revision"]})
    assert applied.status_code == 200, applied.text
    after = changes.current()
    assert after["rev"] == 1 and moved(changes._empty(), after) == {"devices", "layout", "monitoring"}
    # The units on the floors moving with the servers in the same step count as inventory too.
    etag = (await site.get("/api/rack-items")).headers["etag"]
    preview = await site.post("/api/devices/move-server", json={**swap, "dry_run": True})
    units = await site.post("/api/devices/move-server", json={**swap, "plan_revision": preview.json()["plan_revision"],
                                                              "rack_items": {"data": {"Rack-01": []}, "if_match": etag}})
    assert units.status_code == 200, units.text
    assert moved(after, changes.current()) == {"devices", "layout", "monitoring", "inventory"}


async def test_a_cleared_server_counts_devices_and_monitoring_and_its_preview_counts_nothing(site, db_session):
    # OPT11..OPT13 have automatic U numbers 1..3 in Rack-01.
    db_session.add(Device(id="pdu1", name="PDU-1", kind="pdu", ip="192.0.2.1", rack="Rack-01", port_count=8,
                          labels_json=json.dumps({"1": "OPT11", "2": "OPT12", "3": "OPT13"})))
    await db_session.commit()
    preview = await site.post("/api/devices/clear-server", json={"server": "OPT13", "dry_run": True})
    assert preview.status_code == 200 and "pins" not in preview.json(), preview.text
    assert changes.current()["rev"] == 0
    applied = await site.post("/api/devices/clear-server",
                              json={"server": "OPT13", "plan_revision": preview.json()["plan_revision"]})
    assert applied.status_code == 200, applied.text
    after = changes.current()
    assert after["rev"] == 1 and moved(changes._empty(), after) == {"devices", "monitoring"}
    # A stale preview is refused and counts nothing.
    stale = await site.post("/api/devices/clear-server",
                            json={"server": "OPT12", "plan_revision": preview.json()["plan_revision"]})
    assert stale.status_code == 409 and changes.current()["rev"] == 1
    # Clearing OPT11 pins OPT12 at U2 (rack_slots.json), so the layout counts too.
    preview = await site.post("/api/devices/clear-server", json={"server": "OPT11", "dry_run": True})
    assert preview.json()["pins"] == [{"rack": "Rack-01", "id": "opt12", "slot": 2}], preview.text
    applied = await site.post("/api/devices/clear-server",
                              json={"server": "OPT11", "plan_revision": preview.json()["plan_revision"]})
    assert applied.status_code == 200, applied.text
    assert changes.current()["rev"] == 2 and moved(after, changes.current()) == {"devices", "monitoring", "layout"}


async def test_a_failed_count_never_fails_the_write(site, monkeypatch, caplog):
    def broken_lock(path, detail):
        raise HTTPException(503, detail)
    monkeypatch.setattr(changes, "_locked_file", broken_lock)
    with caplog.at_level("WARNING", logger="app.changes"):
        for value in (1, 2):
            r = await site.put("/api/rack-slots", json={"Rack-01": {"opt11": value}})
            assert r.status_code == 200, r.text
    assert json.loads((site.folder / "rack_slots.json").read_text()) == {"Rack-01": {"opt11": 2}}
    assert len([r for r in caplog.records if r.name == "app.changes"]) == 1
    assert (await site.get("/api/changes")).json()["rev"] == 0


async def test_with_a_site_password_the_counter_needs_it_like_every_other_read(site):
    site.settings.lab_manager_password = PASSWORD
    assert (await site.get("/api/changes")).status_code == 401
    assert (await site.get("/api/changes", auth=BasicAuth("lab", PASSWORD))).status_code == 200
    assert (await site.put("/api/rack-slots", json={})).status_code == 401
    assert (await site.put("/api/rack-slots", json={}, auth=BasicAuth("lab", PASSWORD))).status_code == 200
    assert (await site.get("/api/changes", auth=BasicAuth("lab", PASSWORD))).json()["domains"]["layout"] == 1


# ── Accounts: Viewer reads, CSRF and roles still decide every write ─────────────────────────────────────────────────

class CheapHashlib:
    """hashlib with a low-cost scrypt for accounts (the real hash code, in milliseconds)."""
    sha256 = staticmethod(hashlib.sha256)

    @staticmethod
    def scrypt(password, *, salt, n, r, p, dklen, maxmem=0):
        return _REAL_SCRYPT(password, salt=salt, n=16, r=1, p=1, dklen=dklen)


@pytest.fixture
async def accounts_site(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'changes-accounts.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(accounts, "hashlib", CheapHashlib)
    async with sessions() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role, created_at=time.time(),
                        password_hash=accounts.hash_password(PASSWORD)))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.add_middleware(changes.ChangeFeed)   # as in app.main: outermost
    app.include_router(accounts.router)
    app.include_router(changes.router)

    @app.put("/api/rack-slots")
    async def save():
        return {"ok": True}
    yield app
    await engine.dispose()


async def signed_in(app, username):
    c = client_for(app)
    r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return c, r.json()["csrf_token"]


async def test_with_accounts_every_signed_in_role_reads_and_only_allowed_writes_count(accounts_site):
    async with client_for(accounts_site) as anonymous:
        r = await anonymous.get("/api/changes")
        assert r.status_code == 401 and "rev" not in r.text
    viewer, viewer_csrf = await signed_in(accounts_site, "viewer")
    operator, operator_csrf = await signed_in(accounts_site, "operator")
    try:
        r = await viewer.get("/api/changes")
        assert r.status_code == 200 and r.json()["rev"] == 0, "signing in counts nothing"
        assert r.headers["cache-control"] == "no-store"
        assert (await viewer.put("/api/rack-slots", json={}, headers={"X-DCIM-CSRF": viewer_csrf})).status_code == 403
        assert (await operator.put("/api/rack-slots", json={})).status_code == 403   # no CSRF token
        assert (await operator.put("/api/rack-slots", json={}, headers={"X-DCIM-CSRF": operator_csrf,
                                                                        "Origin": "http://elsewhere"})).status_code == 403
        assert (await viewer.get("/api/changes")).json()["rev"] == 0
        assert (await operator.put("/api/rack-slots", json={}, headers={"X-DCIM-CSRF": operator_csrf})).status_code == 200
        assert (await viewer.get("/api/changes")).json()["domains"]["layout"] == 1
        assert (await operator.post("/api/auth/logout", headers={"X-DCIM-CSRF": operator_csrf})).status_code == 200
        assert (await viewer.get("/api/changes")).json()["rev"] == 1
    finally:
        await viewer.aclose()
        await operator.aclose()
    assert accounts.required_role("/api/changes", "GET") == "Viewer"
