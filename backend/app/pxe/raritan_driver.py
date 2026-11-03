"""Raritan KVM console for a remote install: the JavaScript client, then OCR of its canvas.

Keys are the allowlist in screen.py. A job is not started unless a browser and a screen reader
can both be imported. Nothing in this module logs credentials, session ids or device addresses.
"""
import asyncio
import json
import logging
import re
import shutil
from urllib.parse import urlencode

import httpx
from sqlalchemy import select

from ..crypto import decrypt
from ..models import Device, PduMaintenance
from ..pdu_locks import maintenance_lock
from .screen import ScreenDriverError, ScreenText, Text, validate_keys

log = logging.getLogger(__name__)

KEY_NAMES = {
    "F12": "F12", "Up": "ArrowUp", "Down": "ArrowDown", "Left": "ArrowLeft", "Right": "ArrowRight",
    "Enter": "Enter", "Esc": "Escape", "e": "e", "Ctrl+A": "Control+a", "Ctrl+E": "Control+e",
    "Ctrl+K": "Control+k", "Ctrl+X": "Control+x", "Delete": "Delete", "Backspace": "Backspace",
    "Home": "Home", "End": "End", "Ctrl+Alt+Delete": "Control+Alt+Delete",
}
_HOST = re.compile(r"[0-9A-Za-z._:-]+")
_SESSION = re.compile(r"SESSION_ID[\"\s:]+([\"'])([0-9a-f]{40,})\1")
_PORT = re.compile(r"J\('PortId','([^']+)'\).*?J\('PortNumber',(\d+)\)")
ROWS = 25
COLS = 80
OFF_SECONDS = 5.0


def console_backend_available() -> bool:
    try:
        import playwright.async_api  # noqa: F401
    except ImportError:
        return False
    return True


def screen_reader_available() -> bool:
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return False
    if shutil.which("tesseract"):
        return True
    try:
        import rapidocr_onnxruntime  # noqa: F401
    except ImportError:
        return False
    return True


def driver_ready() -> bool:
    """True only when a real console can be opened and its picture can be read back as text."""
    return console_backend_available() and screen_reader_available()


def parse_sidebar(html: str) -> tuple[str | None, dict[int, str]]:
    session = _SESSION.search(html or "")
    ports = {}
    for match in _PORT.finditer(html or ""):
        number = int(match.group(2))
        if number > 0:
            ports[number] = match.group(1)
    return (session.group(2) if session else None), ports


def client_url(ip: str, session_id: str, port: int, port_id: str | None) -> str:
    if not _HOST.fullmatch(ip or ""):
        raise ScreenDriverError("KVM console session failed")
    query = {"sessionId": session_id, "portNo": str(port)}
    if port_id:
        query["portId"] = port_id
    return f"https://{ip}/jsclient/Client.asp#{urlencode(query)}"


def screen_from_observations(observations, *, image_blank: bool, rows: int = ROWS) -> ScreenText:
    """Place OCR words on a fixed text grid. An unreadable picture is low confidence, not a blank screen."""
    if not observations:
        return ScreenText([""] * rows, None, COLS, rows, 1.0 if image_blank else 0.0, "ocr")
    lines = [""] * rows
    scores = []
    highlight = None
    best_bg = -1
    for item in sorted(observations, key=lambda obs: (obs["row"], obs["cx"])):
        row = min(rows - 1, max(0, int(item["row"])))
        text = str(item["text"]).replace("\n", " ").strip()
        if text:
            lines[row] = (lines[row] + " " + text).strip()
        scores.append(float(item["score"]))
        bg = item.get("bg")
        if isinstance(bg, (int, float)) and bg > best_bg:
            best_bg = bg
            highlight = row if bg >= 170 else highlight
    if best_bg < 170:
        highlight = None
    return ScreenText(lines, highlight, COLS, rows, min(scores) if scores else 0.0, "ocr")


def highlight_row_from_image(image) -> int | None:
    """The inverse-video menu row, if one band is clearly lighter than the rest of the picture."""
    gray = image.convert("L")
    width, height = gray.size
    if width < 1 or height < ROWS:
        return None
    pixels = gray.tobytes()
    row_h = height / ROWS
    fractions = []
    for row in range(ROWS):
        y0 = int(row * row_h)
        y1 = min(height, max(y0 + 1, int((row + 1) * row_h)))
        light = total = 0
        for y in range(y0, y1, 2):
            start = y * width
            for x in range(0, width, 3):
                total += 1
                if pixels[start + x] > 160:
                    light += 1
        fractions.append(light / total if total else 0)
    best = max(range(ROWS), key=lambda index: fractions[index])
    median = sorted(fractions)[len(fractions) // 2]
    if fractions[best] >= 0.35 and fractions[best] >= median + 0.15:
        return best
    return None


def image_is_blank(image) -> bool:
    gray = image.convert("L")
    low, high = gray.getextrema()
    return high - low < 12


def _background(image, left, top, right, bottom) -> int:
    gray = image.convert("L")
    width, height = gray.size
    left, top = max(0, int(left)), max(0, int(top))
    right, bottom = min(width, int(right)), min(height, int(bottom))
    if right <= left or bottom <= top:
        return 0
    crop = gray.crop((left, top, right, bottom)).resize((1, 1))
    return int(crop.getpixel((0, 0)))


def _observations_from_boxes(image, boxes) -> list[dict]:
    height = image.size[1] or 1
    row_h = height / ROWS
    observations = []
    for box in boxes:
        cy = box["cy"]
        observations.append({**box, "row": min(ROWS - 1, max(0, int(cy / row_h))),
                             "bg": _background(image, box["left"], box["top"], box["right"], box["bottom"])})
    return observations


def _read_rapidocr(image):
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
    engine = getattr(_read_rapidocr, "engine", None)
    if engine is None:
        engine = RapidOCR()
        _read_rapidocr.engine = engine
    result, _elapsed = engine(np.array(image.convert("RGB")))
    boxes = []
    for item in result or []:
        points, text, score = item[0], str(item[1]), float(item[2])
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        boxes.append({"text": text, "score": score, "cx": sum(xs) / len(xs), "cy": sum(ys) / len(ys),
                      "left": min(xs), "top": min(ys), "right": max(xs), "bottom": max(ys)})
    return _observations_from_boxes(image, boxes)


def _read_tesseract(image) -> list[dict]:
    import io
    import subprocess
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    try:
        proc = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "6", "tsv"], input=buffer.getvalue(),
                              capture_output=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ScreenDriverError("KVM console session failed") from None
    if proc.returncode != 0:
        raise ScreenDriverError("KVM console session failed")
    boxes = []
    for line in proc.stdout.decode("utf-8", errors="replace").splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 12 or parts[0] != "5":
            continue
        try:
            conf = float(parts[10])
            left, top, width, height = (int(float(parts[i])) for i in range(6, 10))
        except ValueError:
            continue
        text = parts[11].strip()
        if conf < 0 or not text:
            continue
        boxes.append({"text": text, "score": conf / 100, "cx": left + width / 2, "cy": top + height / 2,
                      "left": left, "top": top, "right": left + width, "bottom": top + height})
    return _observations_from_boxes(image, boxes)


def read_screen(png: bytes) -> ScreenText:
    try:
        from PIL import Image
        import io
        image = Image.open(io.BytesIO(png))
        image.load()
    except Exception:
        raise ScreenDriverError("KVM console session failed") from None
    blank = image_is_blank(image)
    if shutil.which("tesseract"):
        observations = _read_tesseract(image)
    else:
        try:
            observations = _read_rapidocr(image)
        except ScreenDriverError:
            raise
        except Exception:
            raise ScreenDriverError("KVM console session failed") from None
    screen = screen_from_observations(observations, image_blank=blank)
    return screen._replace(highlight_row=highlight_row_from_image(image))


class RaritanPower:
    """Turns the computer's mapped outlets off, then back on. A failure while off restores power."""

    def __init__(self, job, sessions, *, switch=None, sleep=None, maintenance=None, off_seconds: float = OFF_SECONDS):
        self.targets = json.loads(job.pdu_targets_json or "[]")
        self.sessions = sessions
        self.switch = switch or self._switch
        self.sleep = sleep or asyncio.sleep
        self.maintenance = maintenance or self._in_maintenance
        self.off_seconds = off_seconds

    async def _in_maintenance(self, device_id: str) -> bool:
        async with maintenance_lock(device_id):
            async with self.sessions() as db:
                return await db.get(PduMaintenance, device_id) is not None

    async def _switch(self, device_id: str, outlet: int, action: str):
        from drivers.raritan_pdu import RaritanPduDriver, safe_error
        async with maintenance_lock(device_id):
            async with self.sessions() as db:
                dev = await db.get(Device, device_id)
                if action == "on" and await db.get(PduMaintenance, device_id):
                    raise ScreenDriverError("PDU is in maintenance mode")
                if not dev or dev.kind != "pdu" or not dev.enabled:
                    raise ScreenDriverError("PDU outlet is not available")
                username = decrypt(dev.username_enc) if dev.username_enc else ""
                password = decrypt(dev.password_enc) if dev.password_enc else ""
                ip = dev.ip
            # The switch stays under the lock so an "on" cannot land after a maintenance shutdown.
            driver = RaritanPduDriver(ip, username, password)
            try:
                await driver.set_outlet_state(outlet, action)
            except Exception as exc:
                raise ScreenDriverError(safe_error(exc)) from None
            finally:
                await driver.close()

    async def cycle(self):
        if not self.targets:
            raise ScreenDriverError("No PDU outlet is mapped to this computer")
        for target in self.targets:
            if await self.maintenance(target["device_id"]):
                raise ScreenDriverError("PDU is in maintenance mode")
        restored = []

        async def restore() -> bool:
            failed = False
            for target in restored:
                try:
                    await self.switch(target["device_id"], int(target["outlet"]), "on")
                except Exception:
                    failed = True
            return failed

        try:
            for target in self.targets:
                await self.switch(target["device_id"], int(target["outlet"]), "off")
                restored.append(target)
            await self.sleep(self.off_seconds)
        except Exception:
            if await restore():
                raise ScreenDriverError("PDU power could not be restored") from None
            raise
        if await restore():
            raise ScreenDriverError("PDU power could not be restored")


class PlaywrightKvmConsole:
    """Opens the same JavaScript KVM client the console button uses, and types into its canvas."""

    def __init__(self, url: str, cookies: list[dict]):
        self.url = url
        self.cookies = cookies
        self._playwright = None
        self._browser = None
        self._page = None

    @classmethod
    async def connect(cls, sessions, job):
        if not driver_ready():
            from .runner import DriverUnavailable
            raise DriverUnavailable("The Raritan console driver is not available in this phase")
        async with sessions() as db:
            dev = await db.scalar(select(Device).where(Device.id == job.kvm_device_id))
            if not dev or dev.kind != "kvm" or not dev.enabled:
                raise ScreenDriverError("KVM console session failed")
            username = decrypt(dev.username_enc) if dev.username_enc else ""
            password = decrypt(dev.password_enc) if dev.password_enc else ""
            ip, port, device_id = dev.ip, job.kvm_port, dev.id
        try:
            async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=20) as client:
                await client.post(f"https://{ip}/auth.asp", params={"client": "javascript"}, data={
                    "login": username, "password": password, "PIN": "", "is_dotnet": "0", "is_javafree": "0",
                    "is_standalone_client": "0", "is_javascript_kvm_client": "1", "is_javascript_rsc_client": "1",
                    "action_login": "Login",
                })
                if not client.cookies:
                    raise ScreenDriverError("KVM console session failed")
                sidebar = await client.get(f"https://{ip}/sidebar.asp")
                session_id, ports = parse_sidebar(sidebar.text)
                if not session_id:
                    raise ScreenDriverError("KVM console session failed")
                cookies = [{"name": name, "value": value, "url": f"https://{ip}/"} for name, value in client.cookies.items()]
        except ScreenDriverError:
            log.warning("PXE KVM %s: console login failed", device_id)
            raise
        except Exception as exc:
            log.warning("PXE KVM %s: console login failed (%s)", device_id, type(exc).__name__)
            raise ScreenDriverError("KVM console session failed") from None
        return cls(client_url(ip, session_id, port, ports.get(port)), cookies)

    async def open(self):
        from playwright.async_api import async_playwright
        self._playwright = await async_playwright().start()
        try:
            self._browser = await self._playwright.chromium.launch(headless=True)
            context = await self._browser.new_context(ignore_https_errors=True)
            if self.cookies:
                await context.add_cookies(self.cookies)
            self._page = await context.new_page()
            await self._page.goto(self.url, wait_until="domcontentloaded", timeout=25000)
            canvas = self._page.locator("canvas").first
            await canvas.wait_for(state="visible", timeout=20000)
            await canvas.click(timeout=5000)
        except Exception as exc:
            await self.close()
            log.warning("PXE console page failed (%s)", type(exc).__name__)
            raise ScreenDriverError("KVM console session failed") from None

    async def close(self):
        browser, playwright = self._browser, self._playwright
        self._browser = self._page = self._playwright = None
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass
        if playwright is not None:
            try:
                await playwright.stop()
            except Exception:
                pass

    async def screenshot_png(self) -> bytes:
        if self._page is None:
            raise ScreenDriverError("KVM session is not open")
        try:
            return await self._page.locator("canvas").first.screenshot(type="png")
        except Exception:
            raise ScreenDriverError("KVM console session failed") from None

    async def send_keys(self, seq):
        if self._page is None:
            raise ScreenDriverError("KVM session is not open")
        keys = validate_keys(seq)
        try:
            for key in keys:
                if isinstance(key, Text):
                    await self._page.keyboard.type(str(key), delay=30)
                else:
                    await self._page.keyboard.press(KEY_NAMES[key])
                await self._page.wait_for_timeout(40)
        except Exception:
            raise ScreenDriverError("KVM console session failed") from None


class RaritanScreenDriver:
    def __init__(self, job, sessions, backend=None, reader=None):
        self.job = job
        self.sessions = sessions
        self.backend = backend
        self.reader = reader or read_screen
        self._open = False

    async def open(self):
        if self.backend is None:
            self.backend = await PlaywrightKvmConsole.connect(self.sessions, self.job)
        await self.backend.open()
        self._open = True

    async def close(self):
        self._open = False
        if self.backend is not None:
            await self.backend.close()

    async def screenshot(self) -> tuple[bytes, str]:
        if not self._open:
            raise ScreenDriverError("KVM session is not open")
        data = await self.backend.screenshot_png()
        if not isinstance(data, (bytes, bytearray)) or not data:
            raise ScreenDriverError("KVM console session failed")
        return bytes(data), "image/png"

    async def send_keys(self, seq):
        if not self._open:
            raise ScreenDriverError("KVM session is not open")
        await self.backend.send_keys(validate_keys(seq))

    async def read_text(self) -> ScreenText:
        data, _media = await self.screenshot()
        try:
            screen = self.reader(data)
        except ScreenDriverError:
            raise
        except Exception:
            raise ScreenDriverError("KVM console session failed") from None
        if not isinstance(screen, ScreenText):
            raise ScreenDriverError("KVM console session failed")
        return screen
