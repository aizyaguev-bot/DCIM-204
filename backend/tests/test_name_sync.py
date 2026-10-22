"""NS-2: site port names written to the PDUs/KVMs themselves (app side).

Every device here is a database row with a fake driver (the real driver signatures); no PDU or KVM is contacted and
the real lab_manager.db is never opened."""
import asyncio
import json
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts, inventory_store, name_sync
from app.crypto import encrypt
from app.database import Base, get_db
from app.models import Device, DeviceNameSync, DeviceNameSyncLease, User
from app.routers import device_names, devices
from app.routers import pdus as pdus_module
from drivers.raritan_pdu import RaritanPduError

PRIVATE = "PRIVATE_TEXT 10.9.8.7 hunter2 /model/outlet/3"
KVM_REASON = "Port names cannot be written to this KVM yet"
PASSWORD = "test-password-123"

LABELS = {
    "pdu-a": {"1": "optn44", "2": "optn45 (PSU1)", "3": "web-1"},
    "pdu-b": {"1": "optn44 (PSU2)", "5": "Outlet 5"},
    "kvm-a": {"1": "optn44", "2": "optn45"},
    "pdu-off": {"1": "optn60"},
}


class FakePdu:
    """RaritanPduDriver's name methods (NS-1 signatures) over an in-memory outlet list."""

    def __init__(self, names, fail_get=None, fail_set=None, store=None, hook=None):
        self.names, self.writes, self.closed = dict(names), [], 0
        self.fail_get, self.fail_set, self.store, self.hook = fail_get, fail_set, store, hook

    async def get_outlet_names(self) -> dict[int, str]:
        if self.fail_get:
            raise self.fail_get
        return dict(self.names)

    async def set_outlet_name(self, outlet_number: int, name: str) -> str:
        self.writes.append((outlet_number, name))
        failure = self.fail_set.get(outlet_number) if isinstance(self.fail_set, dict) else self.fail_set
        if failure:
            raise failure
        if self.hook:
            await self.hook(outlet_number, name)
        self.names[outlet_number] = self.store(name) if self.store else name
        return self.names[outlet_number]

    async def close(self):
        self.closed += 1


class FakeKvm:
    """RaritanKvmDriver's name methods while no write method is identified (NS-1 contract)."""

    def __init__(self, names, support=(False, KVM_REASON)):
        self.names, self.support, self.writes = dict(names), support, []

    async def name_support(self) -> tuple[bool, str]:
        return self.support

    async def get_port_names(self) -> dict[int, str]:
        return dict(self.names)

    async def set_port_name(self, port_number: int, name: str) -> str:
        self.writes.append((port_number, name))
        raise AssertionError("a KVM port name must never be written")

    async def close(self):
        pass


def lab_devices():
    creds = {"username_enc": encrypt("admin"), "password_enc": encrypt("secret-pw")}
    return [
        Device(id="pdu-a", name="PDU-A", kind="pdu", ip="192.0.2.11", rack="Rack-01", port_count=8,
               labels_json=json.dumps(LABELS["pdu-a"]), **creds),
        Device(id="pdu-b", name="PDU-B", kind="pdu", ip="192.0.2.12", rack="Rack-02", port_count=8,
               labels_json=json.dumps(LABELS["pdu-b"]), **creds),
        Device(id="kvm-a", name="KVM-A", kind="kvm", ip="192.0.2.13", rack="Rack-01", port_count=4,
               labels_json=json.dumps(LABELS["kvm-a"]), **creds),
        Device(id="pdu-off", name="PDU-OFF", kind="pdu", ip="192.0.2.14", rack="Rack-03", port_count=4, enabled=False,
               labels_json=json.dumps(LABELS["pdu-off"]), **creds),
    ]


def fake_drivers():
    return {
        "pdu-a": FakePdu({1: "optn44", 2: "optn45 (PSU1)", 3: "web-1", **{n: "" for n in range(4, 9)}}),
        "pdu-b": FakePdu({1: "optn44 (PSU2)", **{n: "" for n in range(2, 9)}}),
        "kvm-a": FakeKvm({1: "optn44", 2: "srv-old", 3: "Port 3", 4: "Port 4"}),
        "pdu-off": FakePdu({1: ""}),
    }


@pytest.fixture
async def env(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'names.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    state = SimpleNamespace(mode="auto", drivers=fake_drivers(), made=[], calls=[])

    def factory(dev, username, password):
        assert (username, password) == ("admin", "secret-pw")
        state.made.append(dev.id)
        return state.drivers[dev.id]

    real_queue = name_sync.queue

    async def spy(device_ports):
        state.calls.append({k: set(v) for k, v in device_ports.items() if v})
        return await real_queue(device_ports)

    monkeypatch.setattr(name_sync, "_session_factory", sessions)
    monkeypatch.setattr(name_sync, "_driver_factory", factory)
    monkeypatch.setattr(name_sync, "mode", lambda: state.mode)
    monkeypatch.setattr(name_sync, "queue", spy)
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    async with sessions() as db:
        db.add_all(lab_devices())
        await db.commit()

    app = FastAPI()
    app.include_router(device_names.router)
    app.include_router(devices.router)

    async def _db():
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_db] = _db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield SimpleNamespace(client=client, sessions=sessions, state=state, app=app, folder=tmp_path)
        await name_sync.drain()
    await engine.dispose()


async def rows(env, device_id=None):
    async with env.sessions() as db:
        query = select(DeviceNameSync)
        if device_id:
            query = query.where(DeviceNameSync.device_id == device_id)
        return {(r.device_id, r.port): r for r in (await db.execute(query)).scalars()}


async def set_labels(env, device_id, labels):
    async with env.sessions() as db:
        dev = await db.get(Device, device_id)
        dev.labels_json = json.dumps(labels)
        await db.commit()


async def patch_labels(env, device_id, labels):
    r = await env.client.patch(f"/api/devices/{device_id}/labels", json=labels)
    assert r.status_code == 200, r.text
    await name_sync.drain()
    return r


def summary(r):
    return {(k[1], v.status, v.reason) for k, v in r.items()}


# ── The four write paths ─────────────────────────────────────────────────────────────────────────────────────────


async def test_label_patch_queues_exactly_the_changed_ports_and_clears_to_the_pdu_default(env):
    r = await patch_labels(env, "pdu-a", {"1": "optn44", "2": "optn46", "3": ""})
    assert r.json()["device_names"] == "queued"
    assert env.state.calls == [{"pdu-a": {"2", "3"}}]
    saved = await rows(env)
    assert set(saved) == {("pdu-a", "2"), ("pdu-a", "3")}
    assert (saved["pdu-a", "2"].status, saved["pdu-a", "2"].desired) == ("synced", "optn46")
    # "Outlet 3" (the site's cleared name) means the device default: an empty name on the PDU.
    assert (saved["pdu-a", "3"].status, saved["pdu-a", "3"].desired) == ("synced", "")
    assert saved["pdu-a", "2"].synced_at and saved["pdu-a", "2"].attempts == 1
    assert env.state.drivers["pdu-a"].writes == [(2, "optn46"), (3, "")]


async def test_direct_label_queues_its_one_port_and_an_unchanged_label_queues_nothing(env):
    r = await env.client.patch("/api/devices/direct-label", json={"device_id": "pdu-b", "port": "5", "label": "optn77"})
    assert r.json() == {"ok": True, "device_names": "queued"}
    r = await env.client.patch("/api/devices/direct-label", json={"device_id": "pdu-b", "port": "1", "label": "optn44 (PSU2)"})
    assert r.json() == {"ok": True, "device_names": "not_sent", "device_names_reason": name_sync.NOTHING_CHANGED}
    await name_sync.drain()
    assert env.state.calls == [{"pdu-b": {"5"}}, {}]
    assert summary(await rows(env)) == {("5", "synced", "")}
    assert env.state.drivers["pdu-b"].writes == [(5, "optn77")]


async def test_rename_opt_queues_the_renamed_ports_and_never_writes_the_kvm(env):
    r = await env.client.post("/api/devices/rename-opt", json={"old_name": "OPTN44", "new_name": "optn99"})
    assert r.status_code == 200, r.text
    assert r.json()["device_names"] == "queued"
    await name_sync.drain()
    assert env.state.calls == [{"pdu-a": {"1"}, "kvm-a": {"1"}}]
    saved = await rows(env)
    assert saved["pdu-a", "1"].status == "synced" and env.state.drivers["pdu-a"].writes == [(1, "optn99")]
    assert (saved["kvm-a", "1"].status, saved["kvm-a", "1"].reason) == ("skipped", KVM_REASON)
    assert env.state.drivers["kvm-a"].writes == []


async def test_rename_of_a_default_port_name_is_not_pushed(env):
    r = await env.client.post("/api/devices/rename-opt", json={"old_name": "Outlet 5", "new_name": "optn55"})
    assert r.status_code == 200, r.text
    assert r.json()["device_names"] == "manual"
    assert r.json()["device_names_reason"] == name_sync.PLACEHOLDER_RENAME
    assert env.state.calls == [] and await rows(env) == {}


async def test_move_server_queues_after_the_layout_files_and_never_on_dry_run(env):
    body = {"server": "web-1", "target_ports": [{"device_id": "pdu-b", "port": "6"}]}
    preview = await env.client.post("/api/devices/move-server", json={**body, "dry_run": True})
    assert preview.status_code == 200, preview.text
    assert "device_names" not in preview.json() and env.state.calls == []
    applied = await env.client.post("/api/devices/move-server", json=body)
    assert applied.status_code == 200, applied.text
    assert applied.json()["device_names"] == "queued"
    await name_sync.drain()
    assert env.state.calls == [{"pdu-a": {"3"}, "pdu-b": {"6"}}]
    assert env.state.drivers["pdu-a"].writes == [(3, "")]
    assert env.state.drivers["pdu-b"].writes == [(6, "web-1")]
    assert (env.folder / "rack_overrides.json").exists()   # the layout files were written before the queue


async def test_a_failed_and_restored_move_queues_nothing(env, monkeypatch):
    def broken(path, data):
        raise OSError("disk full")

    monkeypatch.setattr(inventory_store, "write_json", broken)
    r = await env.client.post("/api/devices/move-server",
                              json={"server": "web-1", "target_ports": [{"device_id": "pdu-b", "port": "6"}]})
    assert r.status_code == 503, r.text
    await name_sync.drain()
    assert env.state.calls == [] and await rows(env) == {}
    assert env.state.made == []


# ── What is written ──────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("label,expected", [
    ("Outlet 5", ""), ("  port 12 ", ""), ("", ""), ("   ", ""), (None, ""), ("optn45 (PSU1)", "optn45 (PSU1)"),
    ("  optn45  ", "optn45")])
def test_device_value_for_a_pdu(label, expected):
    assert name_sync.device_value(SimpleNamespace(kind="pdu"), label) == expected


def test_device_value_for_a_kvm_never_invents_a_default():
    kvm = SimpleNamespace(kind="kvm")
    assert name_sync.device_value(kvm, "Port 3") is None and name_sync.device_value(kvm, "") is None
    assert name_sync.device_value(kvm, "optn45") == "optn45"


@pytest.mark.parametrize("label", ["optn\n45", "a\x00b", "<script>", "a'b", "café", "א", 'a"b', "a&b", "a`b"])
async def test_a_name_the_device_cannot_store_fails_without_a_write(env, label):
    await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "4": label})
    assert summary(await rows(env)) == {("4", "failed", name_sync.BAD_CHARS)}
    assert env.state.made == [] and env.state.drivers["pdu-a"].writes == []


async def test_a_too_long_name_fails_without_a_write_and_is_never_truncated(env):
    limit = name_sync.name_max(SimpleNamespace(kind="pdu"))
    await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "4": "x" * (limit + 1), "5": "y" * limit})
    saved = await rows(env)
    assert (saved["pdu-a", "4"].status, saved["pdu-a", "4"].reason) == (
        "failed", f"Name is too long for this device (max {limit})")
    assert env.state.drivers["pdu-a"].writes == [(5, "y" * limit)]


async def test_two_saved_labels_for_one_port_fail_and_out_of_range_ports_are_never_queued(env):
    await set_labels(env, "pdu-a", {**LABELS["pdu-a"], "05": "optn70", "A1": "old-legacy"})
    await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "05": "optn70", "5": "optn71", "9": "optn72", "A1": "legacy"})
    assert summary(await rows(env)) == {("5", "failed", name_sync.TWO_LABELS)}
    assert env.state.drivers["pdu-a"].writes == []


# ── Modes ────────────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("raw,expected", [
    ("auto", "auto"), (" Manual ", "manual"), ("OFF", "off"), ("off ", "off"), ("false", "off"), ("x", "off"),
    ("", "off"), (None, "off")])
def test_mode_fails_closed(raw, expected, capsys):
    settings = SimpleNamespace(device_name_sync=raw, accounts_enabled=True, lab_manager_password="")
    assert name_sync.effective_mode(settings) == expected
    assert name_sync.effective_mode(settings) == expected
    warnings = capsys.readouterr().err.count("unknown value")
    assert warnings == (0 if (raw or "").strip().lower() in ("auto", "manual", "off") else 1)


def test_a_site_without_any_sign_in_never_writes_to_devices():
    open_site = SimpleNamespace(device_name_sync="auto", accounts_enabled=False, lab_manager_password="")
    assert name_sync.effective_mode(open_site) == "off"
    shared = SimpleNamespace(device_name_sync="auto", accounts_enabled=False, lab_manager_password="pw")
    assert name_sync.effective_mode(shared) == "auto"


async def test_mode_off_writes_nothing_and_push_is_409(env):
    env.state.mode = "off"
    r = await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "optn46"})
    assert r.json()["device_names"] == "off"
    assert await rows(env) == {} and env.state.made == []
    r = await env.client.post("/api/devices/pdu-a/device-names/push", json={"ports": ["2"], "expected": {"2": "optn46"}})
    assert r.status_code == 409 and env.state.made == []


async def test_mode_manual_queues_nothing_but_the_panel_push_writes(env):
    env.state.mode = "manual"
    r = await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "optn46"})
    assert r.json()["device_names"] == "manual" and await rows(env) == {} and env.state.made == []
    r = await env.client.post("/api/devices/pdu-a/device-names/push", json={"ports": ["2"], "expected": {"2": "optn46"}})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "results": [{"port": "2", "status": "synced", "device": "optn46", "reason": ""}]}
    assert env.state.drivers["pdu-a"].writes == [(2, "optn46")]


async def test_a_save_touching_too_many_ports_is_not_pushed_automatically(env):
    async with env.sessions() as db:
        db.add(Device(id="pdu-big", name="PDU-BIG", kind="pdu", ip="192.0.2.20", port_count=60))
        await db.commit()
    r = await patch_labels(env, "pdu-big", {str(n): f"srv{n}" for n in range(1, 50)})
    assert r.json()["device_names"] == "manual" and r.json()["device_names_reason"] == name_sync.TOO_MANY
    assert await rows(env) == {}


# ── Devices that must not be written ─────────────────────────────────────────────────────────────────────────────


async def test_a_disabled_device_is_never_contacted(env):
    r = await env.client.patch("/api/devices/direct-label", json={"device_id": "pdu-off", "port": "1", "label": "optn61"})
    assert r.status_code == 200
    assert r.json()["device_names"] == "not_sent" and r.json()["device_names_reason"] == name_sync.DISABLED
    await name_sync.drain()
    assert summary(await rows(env)) == {("1", "skipped", name_sync.DISABLED)}
    r = await env.client.post("/api/devices/pdu-off/device-names/push", json={"ports": ["1"], "expected": {"1": "optn61"}})
    assert r.status_code == 409
    body = (await env.client.get("/api/devices/pdu-off/device-names")).json()
    assert body["supported"] is False and body["reason"] == name_sync.DISABLED and body["reachable"] is False
    assert {p["state"] for p in body["ports"]} == {"not_writable"}
    assert env.state.made == []


async def test_a_kvm_without_an_identified_write_method_is_never_written(env):
    body = (await env.client.get("/api/devices/kvm-a/device-names")).json()
    assert body["supported"] is False and body["reason"] == KVM_REASON and body["reachable"] is True
    assert {p["state"] for p in body["ports"]} == {"not_writable"}
    r = await env.client.post("/api/devices/kvm-a/device-names/push", json={"ports": ["2"], "expected": {"2": "optn45"}})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": False, "results": [{"port": "2", "status": "skipped", "device": None, "reason": KVM_REASON}]}
    assert env.state.drivers["kvm-a"].writes == []


async def test_an_unknown_support_reason_is_never_shown(env):
    env.state.drivers["kvm-a"].support = (False, PRIVATE)
    body = (await env.client.get("/api/devices/kvm-a/device-names")).json()
    assert body["reason"] == name_sync.UNSUPPORTED and PRIVATE not in json.dumps(body)


async def test_unreadable_credentials_and_a_bad_address_fail_without_contact(env):
    async with env.sessions() as db:
        db.add(Device(id="pdu-key", name="PDU-KEY", kind="pdu", ip="192.0.2.30", port_count=4, password_enc="not-a-token"))
        db.add(Device(id="pdu-addr", name="PDU-ADDR", kind="pdu", ip="https://x/", port_count=4))
        await db.commit()
    for device_id in ("pdu-key", "pdu-addr"):
        await env.client.patch("/api/devices/direct-label", json={"device_id": device_id, "port": "1", "label": "optn1"})
    await name_sync.drain()
    assert summary(await rows(env, "pdu-key")) == {("1", "failed", name_sync.CREDENTIALS)}
    assert summary(await rows(env, "pdu-addr")) == {("1", "failed", name_sync.BAD_ADDRESS)}
    assert env.state.made == []


# ── Failures ─────────────────────────────────────────────────────────────────────────────────────────────────────


async def test_an_unreachable_device_fails_the_rest_with_the_fixed_reason(env, capsys):
    fake = env.state.drivers["pdu-a"]
    fake.fail_set = RaritanPduError("Device API connection timeout (ConnectTimeout): " + PRIVATE)
    await patch_labels(env, "pdu-a", {"1": "optn44", "2": "n2", "3": "n3", "4": "n4"})
    assert summary(await rows(env)) == {(p, "failed", name_sync.UNREACHABLE) for p in ("2", "3", "4")}
    assert fake.writes == [(2, "n2")]   # the batch stops at the first unreachable write
    err = capsys.readouterr().err
    assert "name-sync: PDU-A 0 synced, 3 failed" in err
    assert PRIVATE not in err and "192.0.2" not in err


async def test_an_unreachable_device_on_the_first_read_is_written_nothing(env):
    fake = env.state.drivers["pdu-a"]
    fake.fail_get = httpx.ConnectError(PRIVATE)
    await patch_labels(env, "pdu-a", {"1": "optn44", "2": "n2", "3": "n3"})
    assert summary(await rows(env)) == {(p, "failed", name_sync.UNREACHABLE) for p in ("2", "3")}
    assert fake.writes == []


async def test_a_refused_sign_in_stops_the_batch(env):
    fake = env.state.drivers["pdu-a"]
    fake.fail_set = RaritanPduError("Device API responded with HTTP 401")
    await patch_labels(env, "pdu-a", {"1": "optn44", "2": "n2", "3": "n3"})
    assert summary(await rows(env)) == {(p, "failed", name_sync.AUTH_FAILED) for p in ("2", "3")}
    assert fake.writes == [(2, "n2")]


async def test_an_unknown_driver_error_is_a_fixed_reason_and_the_batch_goes_on(env):
    fake = env.state.drivers["pdu-a"]
    fake.fail_set = {2: RaritanPduError(PRIVATE)}
    await patch_labels(env, "pdu-a", {"1": "optn44", "2": "n2", "3": "n3"})
    assert summary(await rows(env)) == {("2", "failed", name_sync.WRITE_FAILED), ("3", "synced", "")}


async def test_a_read_back_mismatch_fails(env):
    fake = env.state.drivers["pdu-a"]
    fake.store = str.upper
    await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "n2"})
    assert summary(await rows(env)) == {("2", "failed", name_sync.MISMATCH)}
    r = await env.client.post("/api/devices/pdu-a/device-names/push", json={"ports": ["2"], "expected": {"2": "n2"}})
    assert r.json() == {"ok": False, "results": [{"port": "2", "status": "failed", "device": "N2", "reason": name_sync.MISMATCH}]}


async def test_an_internal_error_leaves_nothing_pending(env, monkeypatch, capsys):
    def boom(device_id):
        raise RuntimeError(PRIVATE)

    monkeypatch.setattr(name_sync, "_invalidate", boom)
    await patch_labels(env, "pdu-a", {"1": "optn44", "2": "n2", "3": "n3"})
    assert summary(await rows(env)) == {(p, "failed", name_sync.INTERNAL) for p in ("2", "3")}
    err = capsys.readouterr().err
    assert "internal error (RuntimeError)" in err and PRIVATE not in err


async def test_no_private_text_reaches_responses_database_or_logs(env, capsys):
    env.state.drivers["pdu-a"].names[4] = "ab\x1b[31m\ncd" + "y" * 300
    env.state.drivers["pdu-a"].fail_set = {2: RaritanPduError(PRIVATE)}
    await patch_labels(env, "pdu-a", {"1": "optn44", "2": "n2", "3": "n3"})
    body = (await env.client.get("/api/devices/pdu-a/device-names")).json()
    port4 = next(p for p in body["ports"] if p["port"] == "4")
    assert port4["device"] == ("ab[31mcd" + "y" * 300)[:128]
    status = (await env.client.get("/api/devices/name-sync/status")).json()
    stored = [(r.desired, r.reason) for r in (await rows(env)).values()]
    for text in (json.dumps(body), json.dumps(status), json.dumps(stored), capsys.readouterr().err):
        assert PRIVATE not in text and "hunter2" not in text and "192.0.2" not in text


# ── Concurrency ──────────────────────────────────────────────────────────────────────────────────────────────────


async def test_a_later_save_of_the_same_port_wins(env):
    async def later_save(number, name):
        if name == "first":
            await set_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "second"})
            await name_sync.queue({"pdu-a": {"2"}})

    env.state.drivers["pdu-a"].hook = later_save
    await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "first"})
    saved = await rows(env)
    assert (saved["pdu-a", "2"].status, saved["pdu-a", "2"].desired) == ("synced", "second")
    assert env.state.drivers["pdu-a"].writes == [(2, "first"), (2, "second")]


async def test_a_device_changed_during_the_batch_stops_it(env):
    async def move_device(number, name):
        async with env.sessions() as db:
            (await db.get(Device, "pdu-a")).ip = "192.0.2.99"
            await db.commit()

    env.state.drivers["pdu-a"].hook = move_device
    await patch_labels(env, "pdu-a", {"1": "optn44", "2": "n2", "3": "n3"})
    assert summary(await rows(env)) == {("2", "synced", ""), ("3", "failed", name_sync.DEVICE_CHANGED)}
    assert env.state.drivers["pdu-a"].writes == [(2, "n2")]


async def test_another_process_lease_blocks_writes_until_it_expires(env, monkeypatch):
    monkeypatch.setattr(name_sync, "LEASE_POLL_SECONDS", 0.02)
    monkeypatch.setattr(name_sync, "PUSH_LEASE_WAIT", 0.05)
    async with env.sessions() as db:
        db.add(DeviceNameSyncLease(device_id="pdu-a", owner="other-process", until=time.time() + 2.0))
        await db.commit()
    r = await env.client.post("/api/devices/pdu-a/device-names/push", json={"ports": ["1"], "expected": {"1": "optn44"}})
    assert r.status_code == 409 and r.json()["detail"] == name_sync.BUSY
    await env.client.patch("/api/devices/pdu-a/labels", json={**LABELS["pdu-a"], "2": "n2"})
    await asyncio.sleep(0.3)
    assert env.state.drivers["pdu-a"].writes == []
    await name_sync.drain()
    assert env.state.drivers["pdu-a"].writes == [(2, "n2")]
    async with env.sessions() as db:
        assert (await db.get(DeviceNameSyncLease, "pdu-a")).owner == ""   # released


async def test_startup_fails_unfinished_names_instead_of_replaying_them(env, monkeypatch):
    async def no_late_sweep():
        return None

    monkeypatch.setattr(name_sync, "_late_sweep", no_late_sweep)
    async with env.sessions() as db:
        for device_id in ("pdu-a", "pdu-b"):
            db.add(DeviceNameSync(device_id=device_id, port="2", desired="n2", status="pending", updated_at="x", revision=1))
        db.add(DeviceNameSyncLease(device_id="pdu-b", owner="other-process", until=time.time() + 60))
        await db.commit()
    await name_sync.start()
    saved = await rows(env)
    assert (saved["pdu-a", "2"].status, saved["pdu-a", "2"].reason) == ("failed", name_sync.RESTARTED)
    assert saved["pdu-b", "2"].status == "pending"   # another live process still owns that device
    assert env.state.made == []
    await name_sync.stop()


async def test_label_patch_in_auto_with_the_default_test_driver_contacts_nothing(env, monkeypatch):
    sent = []

    async def no_network(self, request):
        sent.append(request.url.host)
        raise AssertionError("no device may be contacted")

    def raising_factory(*args, **kwargs):
        raise AssertionError("name_sync tried to contact a PDU/KVM in a test")

    # Every real driver request goes through the default transport (the test client uses ASGITransport).
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", no_network)
    monkeypatch.setattr(name_sync, "_driver_factory", raising_factory)
    await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "n2"})
    assert summary(await rows(env)) == {("2", "failed", name_sync.NO_DRIVER)}
    assert sent == []


# ── Status, compare and push ─────────────────────────────────────────────────────────────────────────────────────


async def test_status_reads_the_database_only(env):
    await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "optn46"})
    made = list(env.state.made)
    r = await env.client.get("/api/devices/name-sync/status", params=[("device_id", "pdu-a"), ("device_id", "nope")])
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "auto" and body["devices"]["nope"] == {}
    assert set(body["devices"]["pdu-a"]["2"]) == {"status", "desired", "reason", "updated_at", "synced_at"}
    assert body["devices"]["pdu-a"]["2"]["status"] == "synced"
    assert (await env.client.get("/api/devices/name-sync/status")).json()["devices"].keys() == {"pdu-a"}
    assert env.state.made == made


async def test_compare_states(env):
    await set_labels(env, "pdu-a", {"1": "optn44", "2": "optn46", "5": "Outlet 5", "6": "x" * 65, "7": "a<b"})
    body = (await env.client.get("/api/devices/pdu-a/device-names")).json()
    assert {k: body[k] for k in ("device_id", "kind", "mode", "supported", "reason", "reachable", "error")} == {
        "device_id": "pdu-a", "kind": "pdu", "mode": "auto", "supported": True, "reason": "", "reachable": True,
        "error": ""}
    ports = {p["port"]: p for p in body["ports"]}
    assert list(ports) == [str(n) for n in range(1, 9)]
    assert {k: (p["state"], p["write"]) for k, p in ports.items()} == {
        "1": ("in_sync", "optn44"), "2": ("differs", "optn46"), "3": ("not_writable", None),
        "4": ("not_writable", None), "5": ("in_sync", ""), "6": ("not_writable", None), "7": ("not_writable", None),
        "8": ("not_writable", None)}
    assert ports["2"]["device"] == "optn45 (PSU1)" and ports["2"]["site"] == "optn46" and ports["2"]["sync"] is None
    assert ports["3"]["reason"] == name_sync.NO_SITE_NAME and ports["3"]["device"] == "web-1"   # never wiped
    assert ports["6"]["reason"].startswith("Name is too long") and ports["7"]["reason"] == name_sync.BAD_CHARS


async def test_compare_of_an_unreachable_device_is_unknown_and_reads_are_shared(env):
    env.state.drivers["pdu-a"].fail_get = httpx.ConnectTimeout(PRIVATE)
    first = (await env.client.get("/api/devices/pdu-a/device-names")).json()
    second = (await env.client.get("/api/devices/pdu-a/device-names")).json()
    assert first == second and env.state.made == ["pdu-a"]   # one live read per device per 5 s
    assert first["reachable"] is False and first["error"] == name_sync.UNREACHABLE
    states = {p["port"]: p["state"] for p in first["ports"]}
    assert states["1"] == "unknown" and states["4"] == "not_writable"
    assert PRIVATE not in json.dumps(first)


async def test_push_validates_ports_and_expected_names(env):
    url = "/api/devices/pdu-a/device-names/push"
    await set_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "optn46"})
    for body in ({}, {"ports": []}, {"ports": ["2"]}, {"ports": ["2"], "expected": {}}, {"ports": ["9"], "expected": {"9": "a"}},
                 {"ports": ["A1"], "expected": {"A1": "a"}}, {"ports": "2", "expected": {"2": "optn46"}}):
        r = await env.client.post(url, json=body)
        assert r.status_code == 422, (body, r.text)
    r = await env.client.post(url, json={"ports": ["2"], "expected": {"2": "optn45"}})
    assert r.status_code == 409   # the site name changed since the compare
    r = await env.client.post(url, json={"ports": ["2"], "expected": {"2": "optn46"}},
                              headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    assert (await env.client.post("/api/devices/nope/device-names/push",
                                  json={"ports": ["1"], "expected": {"1": "x"}})).status_code == 404
    assert env.state.made == []
    r = await env.client.post(url, json={"ports": ["02"], "expected": {"2": "optn46"}}, headers={"Origin": "http://test"})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert env.state.drivers["pdu-a"].writes == [(2, "optn46")]


async def test_a_synced_write_refreshes_the_status_cache(env):
    pdus_module._cache["pdu-a"] = (0.0, object())
    await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "n2"})
    assert "pdu-a" not in pdus_module._cache


# ── Roles ────────────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("path,method,role", [
    ("/api/devices/name-sync/status", "GET", "Viewer"),
    ("/api/devices/pdu-a/device-names", "GET", "Operator"),
    ("/api/devices/pdu-a/device-names/push", "POST", "Operator"),
    ("/api/devices/pdu-a", "PUT", "Admin"), ("/api/devices/pdu-a", "DELETE", "Admin"),
    ("/api/devices/pdu-a/labels", "PATCH", "Operator"), ("/api/devices/locations", "GET", "Viewer"),
])
def test_required_roles(path, method, role):
    assert accounts.required_role(path, method) == role


async def test_roles_and_csrf_through_the_middleware(env, monkeypatch):
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", env.sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    async with env.sessions() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role,
                        password_hash=accounts.hash_password(PASSWORD), created_at=time.time()))
        await db.commit()
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(device_names.router)
    app.dependency_overrides = env.app.dependency_overrides
    await set_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "optn46"})
    push = ("/api/devices/pdu-a/device-names/push", {"ports": ["2"], "expected": {"2": "optn46"}})
    for username, can_operate in (("viewer", False), ("operator", True)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
            assert r.status_code == 200, r.text
            csrf = r.json()["csrf_token"]
            assert (await c.get("/api/devices/name-sync/status")).status_code == 200
            assert (await c.get("/api/devices/pdu-a/device-names")).status_code == (200 if can_operate else 403)
            assert (await c.post(push[0], json=push[1], headers={"X-DCIM-CSRF": csrf})).status_code == (
                200 if can_operate else 403)
            if can_operate:
                assert (await c.post(push[0], json=push[1])).status_code == 403   # no CSRF token
                assert (await c.post(push[0], json=push[1], headers={"X-DCIM-CSRF": csrf,
                                                                     "Origin": "http://evil.example"})).status_code == 403
    assert env.state.drivers["pdu-a"].writes == [(2, "optn46")]


def test_the_name_routes_come_before_the_device_id_routes():
    from app.main import app
    paths = [getattr(route, "path", "") for route in app.routes]
    assert paths.index("/api/devices/name-sync/status") < paths.index("/api/devices/{device_id}")


@pytest.mark.parametrize("error,reason,stop", [
    (RaritanPduError("Other outlet settings changed during the write - check the PDU"), name_sync.OTHER_SETTINGS, True),
    (RaritanPduError(name_sync.OTHER_SETTINGS), name_sync.OTHER_SETTINGS, True),
    (RaritanPduError("Device API connection timeout (ConnectTimeout): the VM could not connect"), name_sync.UNREACHABLE, True),
    (RaritanPduError("Device API request timeout (ReadTimeout)"), name_sync.UNREACHABLE, True),
    (RaritanPduError("Device API responded with HTTP 403"), name_sync.AUTH_FAILED, True),
    (httpx.ReadTimeout(PRIVATE), name_sync.UNREACHABLE, True),
    (asyncio.TimeoutError(), name_sync.UNREACHABLE, True),
    (RaritanPduError("Device refused the name (code 1)"), "Device refused the name (code 1)", False),
    (RaritanPduError("Device API returned an invalid resource identifier"),
     "Device API returned an invalid resource identifier", False),
    (RaritanPduError("Outlet 9 out of range (max 8)"), name_sync.NO_SUCH_PORT, False),
    (RaritanPduError("Device API responded with HTTP 500"), "Device API responded with HTTP 500", False),
    (RaritanPduError(PRIVATE), name_sync.WRITE_FAILED, False),
    (RuntimeError(PRIVATE), name_sync.WRITE_FAILED, False),
])
def test_driver_failures_map_to_fixed_reasons(error, reason, stop):
    assert name_sync.failure(error) == (reason, stop)


async def test_a_push_behind_a_running_batch_answers_busy_instead_of_hanging(env, monkeypatch):
    monkeypatch.setattr(name_sync, "PUSH_LEASE_WAIT", 0.05)
    await set_labels(env, "pdu-a", {**LABELS["pdu-a"], "2": "optn46"})
    lock = name_sync._lock("pdu-a")
    await lock.acquire()   # a background batch of this process is writing the device
    try:
        r = await env.client.post("/api/devices/pdu-a/device-names/push",
                                  json={"ports": ["2"], "expected": {"2": "optn46"}})
        assert r.status_code == 409 and r.json()["detail"] == name_sync.BUSY
    finally:
        lock.release()
    assert env.state.drivers["pdu-a"].writes == []
    r = await env.client.post("/api/devices/pdu-a/device-names/push", json={"ports": ["2"], "expected": {"2": "optn46"}})
    assert r.status_code == 200 and r.json()["ok"] is True


# ── "queued" only when something is really pending (NS-QA 1) ──────────────────────────────────────────────────────


@pytest.mark.parametrize("label,reason", [("a'b", name_sync.BAD_CHARS),
                                          ("x" * 65, "Name is too long for this device (max 64)")])
async def test_a_pdu_save_whose_every_name_is_refused_is_not_sent(env, label, reason):
    r = await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "4": label})
    assert {k: r.json()[k] for k in ("device_names", "device_names_reason")} == {
        "device_names": "not_sent", "device_names_reason": reason}
    assert summary(await rows(env)) == {("4", "failed", reason)} and env.state.made == []


async def test_a_kvm_save_is_not_sent_while_the_kvm_cannot_write_names(env):
    r = await env.client.patch("/api/devices/direct-label", json={"device_id": "kvm-a", "port": "3", "label": "optn50"})
    assert r.json() == {"ok": True, "device_names": "not_sent", "device_names_reason": KVM_REASON}
    await name_sync.drain()
    saved = await rows(env)
    assert (saved["kvm-a", "3"].status, saved["kvm-a", "3"].reason, saved["kvm-a", "3"].desired) == (
        "skipped", KVM_REASON, "optn50")
    assert env.state.drivers["kvm-a"].writes == []


async def test_a_save_with_one_valid_and_one_refused_name_is_queued(env):
    r = await patch_labels(env, "pdu-a", {**LABELS["pdu-a"], "4": "a'b", "5": "ok5"})
    assert r.json()["device_names"] == "queued" and "device_names_reason" not in r.json()
    assert summary(await rows(env)) == {("4", "failed", name_sync.BAD_CHARS), ("5", "synced", "")}
    assert env.state.drivers["pdu-a"].writes == [(5, "ok5")]


# ── A live compare settles a row whose name is already on the device (NS-QA 2) ──────────────────────────────────


async def test_a_compare_settles_failed_and_orphaned_pending_rows_that_already_match(env):
    await set_labels(env, "pdu-a", {"1": "optn44", "2": "n2", "3": "n3", "5": "n5"})
    fake = env.state.drivers["pdu-a"]
    fake.names.update({2: "n2", 5: "n5"})   # 3 still shows "web-1"
    before = "2026-01-01T00:00:00.000000+00:00"
    async with env.sessions() as db:
        for port, status, reason in (("2", "failed", name_sync.OTHER_SETTINGS), ("3", "failed", name_sync.UNREACHABLE),
                                     ("5", "pending", "")):
            db.add(DeviceNameSync(device_id="pdu-a", port=port, desired="n" + port, status=status, reason=reason,
                                  updated_at=before, revision=3))
        await db.commit()
    lock = name_sync._lock("pdu-a")
    await lock.acquire()   # a worker of this process is on the device: its pending row is left alone
    try:
        body = (await env.client.get("/api/devices/pdu-a/device-names")).json()
    finally:
        lock.release()
    sync = {p["port"]: p["sync"] for p in body["ports"]}
    assert sync["2"]["status"] == "synced" and sync["2"]["reason"] == "" and sync["2"]["synced_at"]
    assert sync["3"]["status"] == "failed" and sync["5"]["status"] == "pending"
    body = (await env.client.get("/api/devices/pdu-a/device-names")).json()   # no worker any more
    assert next(p for p in body["ports"] if p["port"] == "5")["sync"]["status"] == "synced"
    saved = await rows(env)
    assert summary(saved) == {("2", "synced", ""), ("3", "failed", name_sync.UNREACHABLE), ("5", "synced", "")}
    assert saved["pdu-a", "2"].revision == 3 and saved["pdu-a", "2"].synced_at
    assert fake.writes == []   # settled from the read alone


async def test_an_older_read_never_settles_a_newer_save(env):
    async with env.sessions() as db:
        db.add(DeviceNameSync(device_id="pdu-a", port="2", desired="n2", status="failed", reason=name_sync.UNREACHABLE,
                              updated_at="2026-06-01T00:00:00.000000+00:00", revision=1))
        await db.commit()
    assert await name_sync._settle("pdu-a", {"2": "n2"}, "2026-05-01T00:00:00.000000+00:00") == {}
    assert await name_sync._settle("pdu-a", {"2": "other"}, "2026-07-01T00:00:00.000000+00:00") == {}
    assert summary(await rows(env)) == {("2", "failed", name_sync.UNREACHABLE)}
    fixed = await name_sync._settle("pdu-a", {"2": "n2"}, "2026-07-01T00:00:00.000000+00:00")
    assert fixed["2"]["status"] == "synced"
