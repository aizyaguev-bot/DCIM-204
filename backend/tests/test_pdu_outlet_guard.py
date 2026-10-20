"""Plain outlet power (Power page) guards added with assistant actions (ORCA-SEC-ACTIONS D5 / SEC-ACT-20):
validation before any device contact, disabled PDUs, protected outlets and unreadable credentials."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import app.routers.pdus as pdus_module


@pytest.fixture
async def pdu_device(client):
    r = await client.post("/api/devices/", json={
        "name": "PDU-Guard", "kind": "pdu", "ip": "192.0.2.40", "model": "PX4", "rack": "R1", "port_count": 24,
    })
    return r.json()


def _driver():
    driver = AsyncMock()
    driver.set_outlet_state = AsyncMock(return_value=True)
    driver.close = AsyncMock()
    return driver


async def _post(client, dev_id, outlet, action, *, protected="", driver=None):
    settings = SimpleNamespace(power_protected_outlets=protected)
    driver = driver or _driver()
    with patch.object(pdus_module, "RaritanPduDriver", return_value=driver) as factory, \
            patch.object(pdus_module, "get_settings", return_value=settings):
        r = await client.post(f"/api/pdus/{dev_id}/outlets/{outlet}/power", json={"action": action})
    return r, factory, driver


async def test_unknown_action_and_bad_outlet_never_reach_the_device(client, pdu_device):
    r, factory, _ = await _post(client, pdu_device["id"], 1, "explode")
    assert r.status_code == 400 and not factory.called
    r, factory, _ = await _post(client, pdu_device["id"], 0, "on")
    assert r.status_code == 400 and not factory.called


async def test_protected_outlet_cannot_be_switched_off_or_cycled(client, pdu_device):
    dev_id = pdu_device["id"]
    for action in ("off", "cycle"):
        r, factory, _ = await _post(client, dev_id, 3, action, protected=f"{dev_id}:3")
        assert r.status_code == 409 and "protected" in r.json()["detail"]
        assert not factory.called
    r, factory, driver = await _post(client, dev_id, 3, "on", protected=f"{dev_id}:3")
    assert r.status_code == 200 and driver.set_outlet_state.await_count == 1
    r, factory, driver = await _post(client, dev_id, 4, "off", protected=f"{dev_id}:3")
    assert r.status_code == 200 and driver.set_outlet_state.await_count == 1


async def test_disabled_pdu_is_refused(client, pdu_device, db_session):
    from app.models import Device

    dev = await db_session.get(Device, pdu_device["id"])
    dev.enabled = False
    await db_session.commit()
    r, factory, _ = await _post(client, pdu_device["id"], 1, "on")
    assert r.status_code == 409 and not factory.called


async def test_unreadable_credentials_are_a_fixed_502(client, pdu_device):
    with patch.object(pdus_module, "get_creds", side_effect=ValueError("bad token secret-x")):
        r, factory, _ = await _post(client, pdu_device["id"], 1, "on")
    assert r.status_code == 502 and "secret-x" not in r.text and not factory.called
