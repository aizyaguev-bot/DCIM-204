"""Raritan console helpers. No test opens a KVM, a PDU or a browser."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

import drivers.raritan_pdu as raritan_pdu
from app import pdu_locks
from app.database import Base
from app.models import Device
from app.pxe.raritan_driver import (
    KEY_NAMES, RaritanPower, RaritanScreenDriver, client_url, highlight_row_from_image, image_is_blank,
    parse_sidebar, screen_from_observations,
)
from app.pxe.runner import DriverUnavailable, default_factory
from app.pxe.screen import KEYS, ScreenDriverError, ScreenText, Text
from tests.test_pxe_sim import fast_engine


def test_every_allowed_key_has_a_browser_name():
    assert set(KEY_NAMES) == set(KEYS)


def test_sidebar_session_and_port_map():
    html = """SESSION_ID: 'abcdef0123456789abcdef0123456789abcdef01'
        J('PortId','P_1').J('PortNumber',1) J('PortId','P_4').J('PortNumber',4)"""
    # The live sidebar uses a semicolon between calls; the parser accepts either spacing.
    html = html.replace(").", ");")
    session, ports = parse_sidebar(html)
    assert session == "abcdef0123456789abcdef0123456789abcdef01"
    assert ports == {1: "P_1", 4: "P_4"}
    assert parse_sidebar("login page") == (None, {})


def test_client_url_keeps_the_session_in_the_fragment_and_rejects_a_bad_host():
    url = client_url("192.0.2.20", "a" * 40, 3, "P 3")
    assert url.startswith("https://192.0.2.20/jsclient/Client.asp#")
    assert "portNo=3" in url and "portId=P+3" in url
    with pytest.raises(ScreenDriverError):
        client_url("192.0.2.20/auth.asp", "a" * 40, 1, None)


def test_ocr_grid_places_words_and_ignores_a_dark_picture_that_returned_no_text():
    screen = screen_from_observations(
        [{"text": "GNU GRUB version 2.06", "score": 0.97, "row": 1, "cx": 10, "bg": 20},
         {"text": "Install Rocky", "score": 0.91, "row": 3, "cx": 4, "bg": 210}],
        image_blank=False)
    assert screen.lines[1] == "GNU GRUB version 2.06"
    assert screen.lines[3] == "Install Rocky"
    assert screen.highlight_row == 3 and screen.confidence == 0.91
    blank = screen_from_observations([], image_blank=True)
    unread = screen_from_observations([], image_blank=False)
    assert blank.confidence == 1 and not any(blank.lines)
    assert unread.confidence == 0


def test_highlight_row_is_the_light_band():
    pytest.importorskip("PIL")
    from PIL import Image
    image = Image.new("L", (90, 250), 0)
    for y in range(30, 40):
        for x in range(90):
            image.putpixel((x, y), 240)
    assert highlight_row_from_image(image) == 3
    assert image_is_blank(Image.new("L", (90, 250), 8))
    noisy = Image.new("L", (90, 250), 0)
    noisy.putpixel((0, 0), 255)
    assert highlight_row_from_image(noisy) is None
    assert not image_is_blank(noisy)


def test_factory_refuses_a_raritan_job_until_the_console_reader_exists():
    factory = default_factory(lambda: None, lambda: 0, None)
    with pytest.raises(DriverUnavailable):
        factory(SimpleNamespace(driver="raritan"))


def _power(targets, switch, maintenance=None, slept=None):
    job = SimpleNamespace(pdu_targets_json=json.dumps(targets))

    async def sleep(seconds):
        slept.append(seconds)

    return RaritanPower(job, None, switch=switch, sleep=sleep, maintenance=maintenance or _no,
                        off_seconds=5)


async def _no(_device_id):
    return False


async def test_power_cycle_turns_outlets_back_on_and_refuses_maintenance():
    calls = []

    async def switch(device_id, outlet, action):
        calls.append((device_id, outlet, action))

    slept = []
    await _power([{"device_id": "pdu1", "outlet": 2}, {"device_id": "pdu1", "outlet": 5}], switch, slept=slept).cycle()
    assert calls == [("pdu1", 2, "off"), ("pdu1", 5, "off"), ("pdu1", 2, "on"), ("pdu1", 5, "on")]
    assert slept == [5]

    calls.clear()

    async def maintained(_device_id):
        return True

    with pytest.raises(ScreenDriverError, match="maintenance"):
        await _power([{"device_id": "pdu1", "outlet": 2}], switch, maintenance=maintained, slept=[]).cycle()
    assert calls == []


async def test_power_cycle_restores_outlets_when_the_off_or_on_fails():
    calls = []

    async def off_fails(device_id, outlet, action):
        calls.append((outlet, action))
        if action == "off" and outlet == 5:
            raise ScreenDriverError("PDU outlet did not change")

    with pytest.raises(ScreenDriverError, match="did not change"):
        await _power([{"device_id": "pdu1", "outlet": 2}, {"device_id": "pdu1", "outlet": 5}], off_fails, slept=[]).cycle()
    assert calls == [(2, "off"), (5, "off"), (2, "on")]

    calls.clear()

    async def on_fails(device_id, outlet, action):
        calls.append(action)
        if action == "on":
            raise RuntimeError("outlet rejected")

    with pytest.raises(ScreenDriverError, match="could not be restored"):
        await _power([{"device_id": "pdu1", "outlet": 2}], on_fails, slept=[]).cycle()
    assert calls == ["off", "on"]


async def test_power_on_keeps_the_maintenance_lock_until_the_outlet_has_switched(tmp_path, monkeypatch):
    engine = fast_engine(tmp_path / "power.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        db.add(Device(id="pdu1", name="PDU 01", kind="pdu", model="PX4", ip="192.0.2.1", rack="R1", port_count=8))
        await db.commit()
    switched, seen_by_shutdown = [], []

    class Driver:
        def __init__(self, ip, username, password):
            pass

        async def set_outlet_state(self, outlet, action):
            await asyncio.sleep(0)                      # the request is still on the wire
            switched.append((outlet, action))

        async def close(self):
            pass

    async def shutdown():                               # a maintenance shutdown reads the outlets once it holds the lock
        async with pdu_locks.maintenance_lock("pdu1"):
            seen_by_shutdown.append(list(switched))

    monkeypatch.setattr(raritan_pdu, "RaritanPduDriver", Driver)
    monkeypatch.setattr(pdu_locks, "_locks", {})
    power = RaritanPower(SimpleNamespace(pdu_targets_json="[]"), sessions)
    try:
        async with pdu_locks.maintenance_lock("pdu1"):
            tasks = [asyncio.create_task(power._switch("pdu1", 2, "on"))]
            await asyncio.sleep(0)
            tasks.append(asyncio.create_task(shutdown()))
            await asyncio.sleep(0)
        await asyncio.gather(*tasks)
    finally:
        await engine.dispose()
    assert switched == [(2, "on")]
    assert seen_by_shutdown == [[(2, "on")]]


async def test_screen_driver_reads_only_an_open_console_and_sends_allowlisted_keys():
    sent = []

    class Backend:
        def __init__(self):
            self.opened = False

        async def open(self):
            self.opened = True

        async def close(self):
            self.opened = False

        async def screenshot_png(self):
            return b"png"

        async def send_keys(self, seq):
            sent.extend(seq)

    driver = RaritanScreenDriver(None, None, backend=Backend(), reader=lambda _data: ScreenText(["menu"], 0, 80, 25, 0.95, "ocr"))
    with pytest.raises(ScreenDriverError):
        await driver.send_keys(["Enter"])
    await driver.open()
    await driver.send_keys(["Enter", Text("192.168.136.101")])
    assert sent == ["Enter", "192.168.136.101"]
    assert (await driver.read_text()).lines == ["menu"]
    assert (await driver.screenshot())[1] == "image/png"
    with pytest.raises(ValueError):
        await driver.send_keys(["rm -rf"])
    await driver.close()
    with pytest.raises(ScreenDriverError):
        await driver.read_text()
