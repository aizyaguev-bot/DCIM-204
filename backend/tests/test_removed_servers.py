"""Removed servers (Admin → Removed servers, "Remove from lab" in the server details).

Permissions through the real accounts middleware, the preview and what a removal cleans, restore, the key rule
(removal is by server identity and stops hiding when the name appears on another port), and the If-Match /
plan_revision / put-back concurrency rules. Every PDU and KVM is a simulated database row; nothing contacts a device.
Layout files, rack items, the store and the legacy owners file live in tmp_path."""
import hashlib
import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.main as main
from app import accounts, inventory_store, ping_monitor
from app.database import Base, get_db
from app.engineers import owner_map
from app.models import AssetOwner, Device, PingIncident, PingTarget, User
from app.routers import devices, removed_servers

PASSWORD = "test-password-123"
_REAL_SCRYPT = hashlib.scrypt


class CheapHashlib:
    """hashlib with a low-cost scrypt (as test_gap_accounts): the real account code, in milliseconds per sign-in."""
    sha256 = staticmethod(hashlib.sha256)

    @staticmethod
    def scrypt(password, *, salt, n, r, p, dklen, maxmem=0):
        return _REAL_SCRYPT(password, salt=salt, n=16, r=1, p=1, dklen=dklen)
LABELS = {
    "pdu-a": {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "web-1", "4": "optn4"},
    "pdu-b": {"1": "OPTN45 (PSU2)", "2": "optn450"},
    "kvm-a": {"2": "OPTN45"},
}
LAYOUT = {
    "rack_slots.json": {"Rack-01": {"optn45 (psu1)": 2}, "Rack-02": {"optn450": 1}},
    "rack_positions.json": {"Rack-01": ["optn45 (psu1)", "optn44"]},
    "rack_overrides.json": {"optn45 (psu1)": "Rack-01", "other": "Rack-09"},
    "switch_assignments.json": {"optn45 (psu1)": {"switch": "SW2", "port": "3"}, "optn44": {"switch": "SW1", "port": "12"}},
}
ITEMS = {"Rack-01": [{"id": "u1", "name": "Switch under test", "type": "switch", "u": 2},
                     {"id": "u2", "name": "Cable", "type": "other", "u": 5}]}


def lab_devices():
    return [
        Device(id="pdu-a", name="PDU-A", kind="pdu", ip="192.0.2.11", rack="Rack-01", port_count=8,
               labels_json=json.dumps(LABELS["pdu-a"])),
        Device(id="pdu-b", name="PDU-B", kind="pdu", ip="192.0.2.12", rack="Rack-02", port_count=8,
               labels_json=json.dumps(LABELS["pdu-b"])),
        Device(id="kvm-a", name="KVM-A", kind="kvm", ip="192.0.2.13", rack="Rack-01", port_count=4,
               labels_json=json.dumps(LABELS["kvm-a"])),
    ]


@pytest.fixture
async def lab(tmp_path, monkeypatch):
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    monkeypatch.setattr(main, "_OPT_OWNERS_FILE", tmp_path / "opt_owners.json")
    (tmp_path / "opt_owners.json").write_text(json.dumps({"optn45 (psu1)": "Dana", "optn44": "Eli"}))
    (tmp_path / "rack_items.json").write_text(json.dumps(ITEMS))
    for name, data in LAYOUT.items():
        (tmp_path / name).write_text(json.dumps(data))
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'removed.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", factory)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(removed_servers, "get_settings", lambda: settings)
    monkeypatch.setattr(accounts, "hashlib", CheapHashlib)
    await accounts.bootstrap_admin()
    async with factory() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role, created_at=time.time(),
                        password_hash=accounts.hash_password(PASSWORD)))
        db.add_all(lab_devices())
        db.add(PingTarget(id="t45", source_key="server:optn45", name="OPTN45", host="optn45"))
        db.add(PingTarget(id="t44", source_key="server:optn44", name="OPTN44", host="optn44"))
        db.add(PingIncident(target_id="t45", host="optn45", first_failed_at=1.0, last_failed_at=2.0))
        db.add(AssetOwner(asset_key="optn45", legacy_name="Roy"))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(removed_servers.router)

    async def dependency():
        async with factory() as db:
            yield db
    app.dependency_overrides[get_db] = dependency
    yield SimpleNamespace(app=app, factory=factory, folder=tmp_path)
    await engine.dispose()


def client(lab):
    return AsyncClient(transport=ASGITransport(app=lab.app), base_url="http://test")


@asynccontextmanager
async def signed_in(lab, username="admin"):
    async with client(lab) as c:
        r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert r.status_code == 200, r.text
        c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
        yield c


def snapshot(folder):
    return {p.name: p.read_bytes() for p in sorted(folder.iterdir())
            if p.is_file() and p.suffix == ".json"}


async def db_state(lab):
    async with lab.factory() as db:
        targets = sorted((t.id, t.enabled, t.revision) for t in (await db.execute(select(PingTarget))).scalars())
        owners = await owner_map(db)
        incidents = sorted((i.target_id, i.ended_at is None) for i in (await db.execute(select(PingIncident))).scalars())
        labels = {d.id: json.loads(d.labels_json) for d in (await db.execute(select(Device))).scalars()}
    return targets, owners, incidents, labels


def layout(lab):
    return {name: json.loads((lab.folder / name).read_text()) for name in LAYOUT}


async def etag(c):
    r = await c.get("/api/removed-servers")
    assert r.status_code == 200, r.text
    return r.headers["etag"]


async def remove(c, name="OPTN45 (PSU1)", **extra):
    preview = await c.post("/api/removed-servers", json={"name": name, "dry_run": True})
    assert preview.status_code == 200, preview.text
    return await c.post("/api/removed-servers", headers={"If-Match": await etag(c)},
                        json={"name": name, "plan_revision": preview.json()["plan_revision"], **extra})


async def test_preview_names_what_is_cleaned_and_kept_and_writes_nothing(lab):
    files, before = snapshot(lab.folder), await db_state(lab)
    async with signed_in(lab) as c:
        r = await c.post("/api/removed-servers", json={"name": "OPTN45 (PSU1)", "dry_run": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["dry_run"], body["key"], body["name"]) == (True, "optn45", "OPTN45")
    assert [(p["device_id"], p["port"], p["label"]) for p in body["ports"]] == [
        ("pdu-a", "2", "OPTN45 (PSU1)"), ("pdu-b", "1", "OPTN45 (PSU2)"), ("kvm-a", "2", "OPTN45")]
    assert "ports_ids" not in body
    assert body["position"] == {"rack": "Rack-01", "slot": 2}
    assert body["layout"] == [
        {"file": "rack_overrides.json", "rack": "Rack-01", "id": "optn45 (psu1)"},
        {"file": "rack_positions.json", "rack": "Rack-01", "id": "optn45 (psu1)"},
        {"file": "rack_slots.json", "rack": "Rack-01", "id": "optn45 (psu1)", "slot": 2},
        {"file": "switch_assignments.json", "rack": None, "id": "optn45 (psu1)"},
    ]
    # Freeing U2 would move the automatically placed servers of Rack-01 up: they are pinned where they are.
    assert body["pins"] == [{"rack": "Rack-01", "id": "optn4", "slot": 3}, {"rack": "Rack-01", "id": "optn44", "slot": 1},
                            {"rack": "Rack-01", "id": "web-1", "slot": 4}]
    assert body["owner"] == {"keys": ["optn45", "optn45 (psu1)"], "name": "Roy"}
    assert body["monitor"] == {"id": "t45", "name": "OPTN45", "host": "optn45", "enabled": True}
    assert body["units_kept"] == [{"id": "u1", "name": "Switch under test"}]
    assert snapshot(lab.folder) == files and await db_state(lab) == before


async def test_remove_cleans_dcim_data_keeps_units_and_labels_and_hides_the_server(lab):
    targets, owners, incidents, labels = await db_state(lab)
    items = (lab.folder / "rack_items.json").read_bytes()
    async with signed_in(lab) as c:
        old = await etag(c)
        r = await remove(c, reason="  Returned to\nvendor  ")
        assert r.status_code == 200, r.text
        assert r.headers["etag"] == r.json()["revision"] != old
        removed = r.json()["removed"]
        assert (removed["key"], removed["name"], removed["active"], removed["reason"], removed["removed_by"]) == \
            ("optn45", "OPTN45", True, "Returned to vendor", "admin")
        assert removed["monitor_paused"] is True and removed["new_ports"] == []
        listing = (await c.get("/api/removed-servers")).json()
    assert listing["hidden"] == ["optn45"]
    assert [(e["action"], e["key"], e["by"], e["reason"]) for e in listing["log"]] == [
        ("removed", "optn45", "admin", "Returned to vendor")]
    assert layout(lab) == {
        "rack_slots.json": {"Rack-01": {"optn4": 3, "optn44": 1, "web-1": 4}, "Rack-02": {"optn450": 1}},
        "rack_positions.json": {"Rack-01": ["optn44"]},
        "rack_overrides.json": {"other": "Rack-09"},
        "switch_assignments.json": {"optn44": {"switch": "SW1", "port": "12"}},
    }
    after_targets, after_owners, after_incidents, after_labels = await db_state(lab)
    assert after_labels == labels                                    # nothing is written to a PDU or KVM label
    assert (lab.folder / "rack_items.json").read_bytes() == items    # units on its shelf stay in the rack
    assert after_targets == [("t44", True, 0), ("t45", False, 1)]    # paused, kept with its history
    assert after_incidents == [("t45", False)]                       # its open incident is closed
    assert "optn45" not in after_owners and "optn45 (psu1)" not in after_owners and after_owners["optn44"] == "Eli"
    # The rack view numbering now skips it: the other servers keep the U they had.
    units = devices._dcim_units(lab_devices(), LABELS, layout(lab))
    assert units["Rack-01"] == {"optn44": (1, False), "optn4": (3, False), "web-1": (4, False)}
    assert "Rack-02" in units and "optn45 (psu2)" not in units["Rack-02"]


async def test_restore_brings_it_back_resumes_the_monitor_and_not_the_placement(lab):
    async with signed_in(lab) as c:
        assert (await remove(c)).status_code == 200
        cleaned = layout(lab)
        r = await c.post("/api/removed-servers/restore", json={"key": "optn45"}, headers={"If-Match": await etag(c)})
        assert r.status_code == 200, r.text
        assert r.json()["monitor_resumed"] is True and r.json()["name"] == "OPTN45"
        listing = (await c.get("/api/removed-servers")).json()
        assert listing["servers"] == [] and listing["hidden"] == []
        assert [e["action"] for e in listing["log"]] == ["restored", "removed"]
        again = await c.post("/api/removed-servers/restore", json={"key": "optn45"}, headers={"If-Match": await etag(c)})
        assert again.status_code == 404
    targets, owners, _, _ = await db_state(lab)
    assert targets == [("t44", True, 0), ("t45", True, 2)]
    assert layout(lab) == cleaned and "optn45" not in owners


async def test_a_monitor_paused_before_removal_stays_paused_after_restore(lab):
    async with lab.factory() as db:
        (await db.get(PingTarget, "t45")).enabled = False
        await db.commit()
    async with signed_in(lab) as c:
        assert (await remove(c)).status_code == 200
        r = await c.post("/api/removed-servers/restore", json={"key": "optn45"}, headers={"If-Match": await etag(c)})
    assert r.json()["monitor_resumed"] is False
    assert (await db_state(lab))[0] == [("t44", True, 0), ("t45", False, 0)]


@pytest.mark.parametrize("username", ["viewer", "operator"])
async def test_operators_and_viewers_cannot_remove_or_restore_and_do_not_see_who_or_why(lab, username):
    async with signed_in(lab) as admin:
        assert (await remove(admin, reason="gone")).status_code == 200
    files, before = snapshot(lab.folder), await db_state(lab)
    async with signed_in(lab, username) as c:
        tag = await etag(c)
        for body in ({"name": "OPTN44", "dry_run": True}, {"name": "OPTN44"}):
            r = await c.post("/api/removed-servers", headers={"If-Match": tag}, json=body)
            assert r.status_code == 403
        assert (await c.post("/api/removed-servers/restore", json={"key": "optn45"}, headers={"If-Match": tag})).status_code == 403
        listing = (await c.get("/api/removed-servers")).json()
    assert listing["hidden"] == ["optn45"] and "log" not in listing
    assert "removed_by" not in listing["servers"][0] and "reason" not in listing["servers"][0]
    assert snapshot(lab.folder) == files and await db_state(lab) == before


async def test_signed_out_requests_are_refused(lab):
    async with client(lab) as c:
        assert (await c.get("/api/removed-servers")).status_code == 401


async def test_if_match_and_plan_revision_are_required_to_be_current(lab):
    files, before = snapshot(lab.folder), await db_state(lab)
    async with signed_in(lab) as c:
        preview = (await c.post("/api/removed-servers", json={"name": "OPTN45", "dry_run": True})).json()
        tag = await etag(c)
        body = {"name": "OPTN45", "plan_revision": preview["plan_revision"]}
        assert (await c.post("/api/removed-servers", json=body)).status_code == 428
        assert (await c.post("/api/removed-servers", json=body, headers={"If-Match": '"stale"'})).status_code == 409
        # Another session pins a server meanwhile: the preview is out of date.
        slots = json.loads((lab.folder / "rack_slots.json").read_text())
        slots["Rack-01"]["web-1"] = 9
        (lab.folder / "rack_slots.json").write_text(json.dumps(slots))
        files["rack_slots.json"] = (lab.folder / "rack_slots.json").read_bytes()
        r = await c.post("/api/removed-servers", json=body, headers={"If-Match": tag})
        assert r.status_code == 409 and "preview again" in r.json()["detail"]
        assert (await c.post("/api/removed-servers/restore", json={"key": "optn45"})).status_code == 428
    assert snapshot(lab.folder) == files and await db_state(lab) == before


async def test_a_layout_file_changed_during_the_write_writes_nothing(lab, monkeypatch):
    files, before = snapshot(lab.folder), await db_state(lab)
    real = inventory_store.save_layouts

    def racing(entries):
        # Another writer saves rack_overrides.json between the plan and the write.
        (lab.folder / "rack_overrides.json").write_text(json.dumps({"other": "Rack-08"}))
        return real(entries)
    monkeypatch.setattr(inventory_store, "save_layouts", racing)
    async with signed_in(lab) as c:
        r = await c.post("/api/removed-servers", headers={"If-Match": await etag(c)}, json={"name": "OPTN45"})
    assert r.status_code == 409
    files["rack_overrides.json"] = (lab.folder / "rack_overrides.json").read_bytes()
    assert snapshot(lab.folder) == files and await db_state(lab) == before


async def test_a_failed_database_commit_puts_the_files_back(lab, monkeypatch):
    files, before = snapshot(lab.folder), await db_state(lab)

    async def broken(self):
        raise RuntimeError("disk full")
    async with signed_in(lab) as c:
        tag = await etag(c)
        with monkeypatch.context() as patch:
            patch.setattr(AsyncSession, "commit", broken)
            r = await c.post("/api/removed-servers", headers={"If-Match": tag}, json={"name": "OPTN45"})
    assert r.status_code == 503
    after = {name: json.loads(raw) for name, raw in snapshot(lab.folder).items()}
    assert after.pop("removed_servers.json") == {"servers": {}, "log": []}
    assert after == {name: json.loads(raw) for name, raw in files.items()}
    assert await db_state(lab) == before


async def test_names_that_are_no_server_unknown_or_already_removed(lab):
    async with signed_in(lab) as c:
        tag = await etag(c)
        assert (await c.post("/api/removed-servers", json={"name": "Outlet 5", "dry_run": True})).status_code == 400
        assert (await c.post("/api/removed-servers", json={"name": "Empty", "dry_run": True})).status_code == 400
        assert (await c.post("/api/removed-servers", json={"name": "", "dry_run": True})).status_code == 400
        assert (await c.post("/api/removed-servers", json={"name": "OPT999", "dry_run": True})).status_code == 404
        assert (await c.post("/api/removed-servers", json={"name": "OPTN44", "reason": "x" * 301,
                                                            "dry_run": True})).status_code == 400
        assert (await remove(c)).status_code == 200
        r = await c.post("/api/removed-servers", json={"name": "optn45 (psu2)", "dry_run": True})
        assert r.status_code == 409 and "already removed" in r.json()["detail"]
        assert tag != await etag(c)


async def test_removal_is_by_identity_and_never_hides_a_similar_or_renamed_server(lab):
    async with signed_in(lab) as c:
        assert (await remove(c)).status_code == 200
        # optn4 and optn450 share a prefix with optn45 and stay; so does the server it is renamed to.
        async with lab.factory() as db:
            hidden = await removed_servers.hidden_keys(db)
            dev = await db.get(Device, "pdu-a")
            dev.labels_json = json.dumps({**LABELS["pdu-a"], "2": "OPTN46 (PSU1)"})
            await db.commit()
            assert hidden == {"optn45"}
            assert await removed_servers.hidden_keys(db) == {"optn45"}   # the other ports still carry OPTN45
        assert (await c.get("/api/removed-servers")).json()["hidden"] == ["optn45"]


async def test_the_name_written_on_another_port_later_is_shown_again(lab):
    async with signed_in(lab) as c:
        assert (await remove(c)).status_code == 200
        async with lab.factory() as db:
            dev = await db.get(Device, "pdu-b")
            dev.labels_json = json.dumps({**LABELS["pdu-b"], "7": "OPTN45"})   # a new machine reuses the name
            await db.commit()
        listing = (await c.get("/api/removed-servers")).json()
        assert listing["hidden"] == []
        assert listing["servers"][0]["active"] is False and listing["servers"][0]["new_ports"] == ["pdu-b:7"]
        # Removing it again records the new port too, so it is hidden again.
        assert (await remove(c)).status_code == 200
        assert (await c.get("/api/removed-servers")).json()["hidden"] == ["optn45"]
        # The monitor the first removal paused still resumes on restore.
        r = await c.post("/api/removed-servers/restore", json={"key": "optn45"}, headers={"If-Match": await etag(c)})
        assert r.json()["monitor_resumed"] is True
    assert ("t45", True, 2) in (await db_state(lab))[0]


async def test_no_monitor_is_created_for_a_removed_server(lab, monkeypatch):
    async with signed_in(lab) as c:
        assert (await remove(c, name="OPTN44")).status_code == 200
    async with lab.factory() as db:
        await db.delete(await db.get(PingTarget, "t44"))
        await db.commit()
        await ping_monitor.discover_targets(db)
        keys = {t.source_key for t in (await db.execute(select(PingTarget))).scalars()}
    assert "server:optn44" not in keys and "server:optn45" in keys and "server:web-1" in keys


async def test_a_key_with_a_slash_is_removed_and_restored(lab):
    # A label may hold "/" ("OPTN44/45"): restore takes the key in the body, so no URL routing gets in the way.
    async with lab.factory() as db:
        dev = await db.get(Device, "pdu-b")
        dev.labels_json = json.dumps({**LABELS["pdu-b"], "5": "OPTN44/45"})
        await db.commit()
    async with signed_in(lab) as c:
        assert (await remove(c, name="OPTN44/45")).status_code == 200
        assert (await c.get("/api/removed-servers")).json()["hidden"] == ["optn44/45"]
        r = await c.post("/api/removed-servers/restore", json={"key": "optn44/45"}, headers={"If-Match": await etag(c)})
        assert r.status_code == 200, r.text
        assert r.json()["key"] == "optn44/45"
        assert (await c.get("/api/removed-servers")).json()["hidden"] == []
        tag = await etag(c)
        for body in ({}, {"key": ""}, {"key": 5}):
            assert (await c.post("/api/removed-servers/restore", json=body, headers={"If-Match": tag})).status_code == 400


async def test_a_restore_against_a_list_changed_since_it_was_shown_is_refused(lab):
    # Admin A shows the list; admin B restores the server and removes it again: A's Restore carries the ETag A saw.
    async with signed_in(lab) as a:
        assert (await remove(a)).status_code == 200
        shown = await etag(a)
        async with signed_in(lab) as b:
            assert (await b.post("/api/removed-servers/restore", json={"key": "optn45"},
                                 headers={"If-Match": await etag(b)})).status_code == 200
            assert (await remove(b, reason="again")).status_code == 200
        files = snapshot(lab.folder)
        r = await a.post("/api/removed-servers/restore", json={"key": "optn45"}, headers={"If-Match": shown})
        assert r.status_code == 409 and "another session" in r.json()["detail"]
    assert snapshot(lab.folder) == files


async def test_hidden_names_give_pages_the_lower_case_spelling_of_a_casefolded_key(lab):
    # Python casefolds ("STRASSE", "Straße" -> "strasse"); JavaScript only lower-cases ("straße"). The list names the
    # lower-cased spellings so a page hides the same server the backend hides, and nothing else.
    async with lab.factory() as db:
        dev = await db.get(Device, "pdu-b")
        dev.labels_json = json.dumps({**LABELS["pdu-b"], "5": "Straße", "6": "strasse-2"})
        await db.commit()
    async with signed_in(lab) as c:
        assert (await remove(c, name="Straße")).status_code == 200
        listing = (await c.get("/api/removed-servers")).json()
    assert listing["hidden"] == ["strasse"] and listing["hidden_names"] == ["straße"]
    async with signed_in(lab) as c:
        assert (await remove(c)).status_code == 200   # an ASCII name adds no extra spelling
        assert (await c.get("/api/removed-servers")).json()["hidden_names"] == ["straße"]


async def test_an_unreadable_store_hides_nothing_and_is_never_overwritten(lab):
    (lab.folder / "removed_servers.json").write_text("{not json")
    async with signed_in(lab) as c:
        assert (await c.get("/api/removed-servers")).json()["hidden"] == []
        r = await c.post("/api/removed-servers", headers={"If-Match": await etag(c)}, json={"name": "OPTN45"})
        assert r.status_code == 503
    assert (lab.folder / "removed_servers.json").read_text() == "{not json"
