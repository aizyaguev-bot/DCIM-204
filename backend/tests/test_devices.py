"""Unit tests for /api/devices/ CRUD endpoints and credential helpers."""
import asyncio
import json

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import inventory_store
from app.crypto import encrypt
from app.database import Base, get_db
from app.models import Device
from app.routers import devices
from app.routers.devices import get_creds

LABELS_CONFLICT = "Port labels on this device were changed in another session. Reload and try again."

# ── Fixtures ─────────────────────────────────────────────────────────────────

_KVM_PAYLOAD = {"name": "KVM-1", "kind": "kvm", "ip": "10.0.0.1",
                "model": "KX III", "rack": "R1", "port_count": 8}

_PDU_PAYLOAD = {"name": "PDU-1", "kind": "pdu", "ip": "10.0.0.2",
                "model": "PX4", "rack": "R1", "port_count": 24}


async def _create(client, payload):
    r = await client.post("/api/devices/", json=payload)
    assert r.status_code == 201
    return r.json()


# ── List ──────────────────────────────────────────────────────────────────────

async def test_list_devices_empty(client):
    r = await client.get("/api/devices/")
    assert r.status_code == 200
    assert r.json() == []


async def test_list_devices_returns_created(client):
    await _create(client, _KVM_PAYLOAD)
    r = await client.get("/api/devices/")
    assert len(r.json()) == 1
    assert r.json()[0]["name"] == "KVM-1"


async def test_list_devices_ordered_by_rack_then_name(client):
    for name, rack in [("Z-node", "R2"), ("A-node", "R2"), ("Solo", "R1")]:
        await _create(client, {"name": name, "kind": "pdu", "ip": "1.1.1.1", "rack": rack})
    names = [d["name"] for d in (await client.get("/api/devices/")).json()]
    assert names == ["Solo", "A-node", "Z-node"]


# ── Create ────────────────────────────────────────────────────────────────────

async def test_create_device_returns_201(client):
    r = await client.post("/api/devices/", json=_KVM_PAYLOAD)
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "KVM-1"
    assert body["kind"] == "kvm"
    assert body["enabled"] is True
    assert "id" in body


async def test_create_device_credentials_not_in_response(client):
    payload = {**_KVM_PAYLOAD, "username": "admin", "password": "s3cr3t"}
    body = (await client.post("/api/devices/", json=payload)).json()
    assert "password" not in body
    assert "username" not in body
    assert "password_enc" not in body
    assert "username_enc" not in body


# ── Update ────────────────────────────────────────────────────────────────────

async def test_update_device(client):
    dev_id = (await _create(client, _KVM_PAYLOAD))["id"]
    r = await client.put(f"/api/devices/{dev_id}",
                         json={**_KVM_PAYLOAD, "name": "KVM-renamed", "ip": "10.9.9.9"})
    assert r.status_code == 200
    assert r.json()["name"] == "KVM-renamed"
    assert r.json()["ip"] == "10.9.9.9"


async def test_update_device_not_found(client):
    r = await client.put("/api/devices/no-such-id", json=_KVM_PAYLOAD)
    assert r.status_code == 404


@pytest.mark.parametrize("ip", ["10.7.30.137", "0.0.0.0", "2001:db8::10", "fe80::1", "pdu.example.invalid",
                                "kvm-01", "PDU-Rack-01.lab.example.", ""])
async def test_device_addresses_used_today_still_validate(client, ip):
    r = await client.post("/api/devices/", json={**_PDU_PAYLOAD, "ip": ip})
    assert r.status_code == 201, r.text
    r = await client.put(f"/api/devices/{r.json()['id']}", json={**_PDU_PAYLOAD, "ip": ip, "rack": "R2"})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("ip", ["http://10.0.0.5", "https://pdu.example.invalid", "10.0.0.5:443", "10.0.0.5/admin",
                                "pdu.example.invalid/x", " 10.0.0.5", "10.0.0.5 ", "pdu one", "'10.0.0.5'",
                                '10.0.0.5";alert(1);//', "fe80::1%eth0", "[fe80::1]", "-pdu", "a" * 254])
async def test_device_address_must_be_one_ip_or_host_name(client, ip):
    assert (await client.post("/api/devices/", json={**_PDU_PAYLOAD, "ip": ip})).status_code == 422
    dev_id = (await _create(client, _PDU_PAYLOAD))["id"]
    assert (await client.put(f"/api/devices/{dev_id}", json={**_PDU_PAYLOAD, "ip": ip})).status_code == 422
    assert [d["ip"] for d in (await client.get("/api/devices/")).json()] == [_PDU_PAYLOAD["ip"]]


async def test_an_unchanged_saved_address_does_not_block_other_edits(client, db_session):
    db_session.add(Device(id="legacy", name="Old rack", kind="rack", ip="TBD rack", rack="Rack-09"))
    await db_session.commit()
    body = {"name": "Old rack", "kind": "rack", "ip": "TBD rack", "rack": "Rack-10"}
    r = await client.put("/api/devices/legacy", json=body)
    assert r.status_code == 200 and r.json()["rack"] == "Rack-10"
    assert (await client.put("/api/devices/legacy", json={**body, "ip": "TBD rack 2"})).status_code == 422


# ── Labels ────────────────────────────────────────────────────────────────────

async def test_update_labels(client):
    dev_id = (await _create(client, _KVM_PAYLOAD))["id"]
    r = await client.patch(f"/api/devices/{dev_id}/labels",
                           json={"1": "Server-A", "2": "Server-B"})
    assert r.status_code == 200
    assert r.json()["ok"] is True


async def test_update_labels_strips_empty_values(client):
    dev_id = (await _create(client, _KVM_PAYLOAD))["id"]
    # Empty string values should be excluded (the PATCH handler filters them out)
    r = await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "Keep", "2": ""})
    assert r.status_code == 200


async def test_update_labels_not_found(client):
    r = await client.patch("/api/devices/bad-id/labels", json={"1": "X"})
    assert r.status_code == 404


async def _labels(client, dev_id):
    return next(d for d in (await client.get("/api/devices/")).json() if d["id"] == dev_id)


async def test_devices_carry_a_labels_revision(client):
    dev_id = (await _create(client, _PDU_PAYLOAD))["id"]
    assert (await _labels(client, dev_id))["labels_revision"] == inventory_store.revision({})
    await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "OPT11", "2": ""})
    dev = await _labels(client, dev_id)
    assert dev["labels"] == {"1": "OPT11"} and dev["labels_revision"] == inventory_store.revision({"1": "OPT11"})


async def test_labels_save_with_the_current_revision_returns_the_new_one(client):
    dev_id = (await _create(client, _PDU_PAYLOAD))["id"]
    revision = (await _labels(client, dev_id))["labels_revision"]
    r = await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "OPT11"}, headers={"If-Match": revision})
    assert r.status_code == 200, r.text
    assert r.json()["labels_revision"] == inventory_store.revision({"1": "OPT11"})
    assert r.json()["labels_revision"] == (await _labels(client, dev_id))["labels_revision"]


async def test_labels_save_with_a_stale_revision_is_409_and_changes_nothing(client):
    pdu = (await _create(client, _PDU_PAYLOAD))["id"]
    kvm = (await _create(client, _KVM_PAYLOAD))["id"]
    stale = (await _labels(client, pdu))["labels_revision"]
    await client.patch(f"/api/devices/{pdu}/labels", json={"1": "OPT11"})
    await client.patch(f"/api/devices/{kvm}/labels", json={"4": "OPT11"})
    r = await client.patch(f"/api/devices/{pdu}/labels", json={"1": "OPT12"}, headers={"If-Match": stale})
    assert r.status_code == 409 and r.json() == {"detail": LABELS_CONFLICT}
    assert (await _labels(client, pdu))["labels"] == {"1": "OPT11"}
    assert (await _labels(client, kvm))["labels"] == {"4": "OPT11"}  # no rename cascade either


@pytest.mark.parametrize("value", [5, None, ["OPT11"], {"name": "OPT11"}, True])
async def test_label_values_must_be_text(client, value):
    dev_id = (await _create(client, _PDU_PAYLOAD))["id"]
    await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "OPT11"})
    r = await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "OPT11", "2": value})
    assert r.status_code == 422
    assert (await _labels(client, dev_id))["labels"] == {"1": "OPT11"}


async def test_label_keys_must_be_port_numbers_unless_already_saved(client):
    dev_id = (await _create(client, _PDU_PAYLOAD))["id"]
    r = await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "OPT11", "A1": "OPT12"})
    assert r.status_code == 422
    assert (await _labels(client, dev_id))["labels"] == {}
    # A key saved earlier through the single-port endpoint keeps round-tripping with the full map.
    await client.patch("/api/devices/direct-label", json={"device_id": dev_id, "port": "A1", "label": "Legacy"})
    r = await client.patch(f"/api/devices/{dev_id}/labels", json={"1": "OPT11", "A1": "Legacy"})
    assert r.status_code == 200, r.text
    assert (await _labels(client, dev_id))["labels"] == {"1": "OPT11", "A1": "Legacy"}


async def test_concurrent_label_saves_with_one_revision_cannot_both_win(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'labels.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        db.add(Device(id="pdu1", name="PDU", kind="pdu", ip="192.0.2.1", labels_json=json.dumps({"1": "OPT11"})))
        await db.commit()
    monkeypatch.setattr(devices, "_labels_lock", asyncio.Lock(), raising=False)
    app = FastAPI()
    app.include_router(devices.router)

    async def per_request():
        async with sessions() as db:
            yield db
    app.dependency_overrides[get_db] = per_request
    # Each request waits briefly after reading, so unserialized saves both read the old labels.
    read, both_read, original = [], asyncio.Event(), devices._get_or_404

    async def slow_read(device_id, db):
        dev = await original(device_id, db)
        read.append(device_id)
        if len(read) == 2:
            both_read.set()
        try:
            await asyncio.wait_for(both_read.wait(), 0.3)
        except asyncio.TimeoutError:
            pass
        return dev
    monkeypatch.setattr(devices, "_get_or_404", slow_read)
    revision = inventory_store.revision({"1": "OPT11"})
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        first, second = await asyncio.gather(
            c.patch("/api/devices/pdu1/labels", json={"1": "OPT11", "2": "OPT12"}, headers={"If-Match": revision}),
            c.patch("/api/devices/pdu1/labels", json={"1": "OPT11", "3": "OPT13"}, headers={"If-Match": revision}))
    assert sorted([first.status_code, second.status_code]) == [200, 409]
    winner = {"1": "OPT11", "2": "OPT12"} if first.status_code == 200 else {"1": "OPT11", "3": "OPT13"}
    async with sessions() as db:
        assert (await db.get(Device, "pdu1")).labels == winner
    await engine.dispose()


# ── Delete ────────────────────────────────────────────────────────────────────

async def test_delete_device(client):
    dev_id = (await _create(client, _PDU_PAYLOAD))["id"]
    r = await client.delete(f"/api/devices/{dev_id}")
    assert r.status_code == 204
    ids = [d["id"] for d in (await client.get("/api/devices/")).json()]
    assert dev_id not in ids


async def test_delete_device_not_found(client):
    r = await client.delete("/api/devices/no-such-id")
    assert r.status_code == 404


# ── Credential helpers (pure unit — no HTTP) ──────────────────────────────────

def test_get_creds_decrypts_correctly():
    dev = Device(id="x", name="x", kind="kvm", ip="1.2.3.4",
                 username_enc=encrypt("admin"),
                 password_enc=encrypt("P@ssw0rd!"))
    username, password = get_creds(dev)
    assert username == "admin"
    assert password == "P@ssw0rd!"


def test_get_creds_empty_stored_fields():
    dev = Device(id="x", name="x", kind="kvm", ip="1.2.3.4",
                 username_enc="", password_enc="")
    username, password = get_creds(dev)
    assert username == ""
    assert password == ""
