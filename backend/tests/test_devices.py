"""Unit tests for /api/devices/ CRUD endpoints and credential helpers."""
import pytest

from app.crypto import encrypt
from app.models import Device
from app.routers.devices import get_creds

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
