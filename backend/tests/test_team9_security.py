"""TEAM9 wave 2 security fixes: live KVM tests stay opt-in, proxied KVM requests and pages, CSRF bytes,
Twin inventory access and the bulk owner replace. No network and no hardware: guards and mock transports only."""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import accounts
from app.database import Base, get_db
from app.models import User
from app.routers import kvm_proxy as proxy

BACKEND = Path(__file__).resolve().parent.parent
PASSWORD = "test-password-123"

# Loaded with -p into the child pytest before the module is imported: every name lookup or
# connection attempt is logged and refused, so nothing leaves the process.
NET_GUARD = """
import os, socket
def _refuse(*args, **kwargs):
    with open(os.environ["TEAM9_NETGUARD_LOG"], "a", encoding="utf-8") as log: log.write(repr(args[:2]) + "\\n")
    raise OSError("network access is blocked by the test guard")
socket.getaddrinfo = socket.create_connection = socket.gethostbyname = socket.gethostbyname_ex = socket.gethostbyaddr = _refuse
"""


def run_live_module(tmp_path, live=None, url=None):
    (tmp_path / "team9_netguard.py").write_text(NET_GUARD, encoding="utf-8")
    log = tmp_path / "connections.log"
    env = {k: v for k, v in os.environ.items()
           if k not in ("DCIM_LIVE_KVM_TESTS", "DCIM_TEST_BASE_URL") and not k.lower().endswith("_proxy")}
    env.update(NO_PROXY="*", TEAM9_NETGUARD_LOG=str(log),
               PYTHONPATH=os.pathsep.join(filter(None, [str(tmp_path), os.environ.get("PYTHONPATH")])))
    env.update({k: v for k, v in (("DCIM_LIVE_KVM_TESTS", live), ("DCIM_TEST_BASE_URL", url)) if v is not None})
    run = subprocess.run([sys.executable, "-m", "pytest", "tests/test_kvm_regression.py", "-q", "--noconftest",
                          "-p", "no:cacheprovider", "-p", "team9_netguard"],
                         cwd=BACKEND, env=env, capture_output=True, text=True, timeout=300)
    assert run.returncode == 0, run.stdout + run.stderr
    return run.stdout.strip().splitlines()[-1], (log.read_text(encoding="utf-8").splitlines() if log.exists() else [])


@pytest.mark.parametrize("live,url", [(None, None), ("1", None), (None, "http://192.0.2.10:9")])
def test_live_kvm_tests_skip_without_any_connection_unless_opted_in(tmp_path, live, url):
    summary, connections = run_live_module(tmp_path, live, url)
    assert "skipped" in summary and not re.search(r"passed|failed|error", summary), summary
    assert connections == []


def test_opted_in_live_kvm_tests_contact_only_the_explicit_address(tmp_path):
    summary, connections = run_live_module(tmp_path, "1", "http://192.0.2.10:9")
    assert "skipped" in summary, summary  # the guard refuses the connection, so the server fixture skips
    assert connections and all("192.0.2.10" in c for c in connections)


@pytest.fixture
def kvm(monkeypatch):
    """The real proxy route in front of a recording mock device."""
    state = SimpleNamespace(dev=SimpleNamespace(id="test", kind="kvm", ip="192.0.2.15"), requests=[],
                            page=("application/octet-stream", b"ok"))
    monkeypatch.setattr(proxy, "_get_device", AsyncMock(return_value=state.dev))
    monkeypatch.setattr(proxy, "_sessions", {"test": "pp_session_id=device-cookie"})
    monkeypatch.setattr(proxy, "_port_ids", {})
    monkeypatch.setattr(proxy, "_login", AsyncMock(side_effect=AssertionError("the device session is pre-seeded")))

    def device(request):
        state.requests.append(request)
        return httpx.Response(200, content=state.page[1], headers={"content-type": state.page[0]})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(proxy.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(device), **kw))
    state.app = FastAPI()
    state.app.include_router(proxy.router)

    async def no_db(): yield None
    state.app.dependency_overrides[get_db] = no_db
    return state


async def test_proxy_does_not_forward_site_credentials_or_forwarding_headers(kvm):
    site_only = {"Authorization": "Basic dXNlcjpzaGFyZWQtcGFzc3dvcmQ=", "Proxy-Authorization": "Basic cHJveHk6dGVzdA==",
                 "X-DCIM-CSRF": "csrf-token", "Forwarded": "for=198.51.100.7;proto=https", "X-Forwarded-For": "198.51.100.7",
                 "X-Forwarded-Proto": "https", "X-Forwarded-Host": "lab.example", "X-Forwarded-Port": "443"}
    async with AsyncClient(transport=ASGITransport(app=kvm.app), base_url="http://test") as c:
        r = await c.post("/api/kvms/test/proxy/jsclient/action.asp?x=1", content=b"payload",
                         headers={**site_only, "X-Requested-With": "XMLHttpRequest", "Cookie": "dcim_session=site-session"})
    assert r.status_code == 200 and len(kvm.requests) == 1
    sent = kvm.requests[0]
    assert str(sent.url) == "https://192.0.2.15/jsclient/action.asp?x=1" and sent.content == b"payload"
    assert [name for name in site_only if name in sent.headers] == []
    assert sent.headers["x-requested-with"] == "XMLHttpRequest" and sent.headers["cookie"] == "pp_session_id=device-cookie"


QUOTE_ADDRESS = '192.0.2.15/x"+(globalThis.pwned=1)+"'
TAG_ADDRESS = "192.0.2.15/</script><script>globalThis.pwned=1</script>"
HARNESS = """
const location={protocol:'http:',host:'ftlab:8000',origin:'http://ftlab:8000',href:'http://ftlab:8000/api/kvms/test/proxy/jsclient/Client.asp'};
global.window={location,WebSocket:function(){},fetch:()=>{}};
global.XMLHttpRequest=function(){};XMLHttpRequest.prototype.open=function(){};
global.setInterval=function(){};  // the injected "no picture" hint polls; a real timer would keep Node running
"""


async def proxied_page(kvm, address):
    kvm.dev.ip = address
    kvm.page = ("text/html", b"<html><head></head><body>console</body></html>")
    async with AsyncClient(transport=ASGITransport(app=kvm.app), base_url="http://test") as c:
        r = await c.get("/api/kvms/test/proxy/jsclient/Client.asp")
    assert r.status_code == 200
    return r.text


async def test_a_quote_in_the_device_address_stays_inside_the_injected_string(kvm, tmp_path):
    script = (await proxied_page(kvm, QUOTE_ADDRESS)).split("<script>", 1)[1].split("</script>", 1)[0]
    node = shutil.which("node")
    assert node, "Node.js is needed to run the injected browser script"
    harness = tmp_path / "injected.js"
    harness.write_text(HARNESS + script + "\nconsole.log(JSON.stringify({host:window.location.hostname,pwned:globalThis.pwned===1}));",
                       encoding="utf-8")
    result = subprocess.run([node, str(harness)], capture_output=True, text=True, check=True, timeout=60)
    assert json.loads(result.stdout) == {"host": QUOTE_ADDRESS, "pwned": False}


async def test_a_device_address_cannot_close_the_injected_script_element(kvm):
    page = (await proxied_page(kvm, TAG_ADDRESS)).lower()
    assert page.count("<script") == 1 and page.count("</script") == 1


TWIN_FILES = {"index.html": "<html>twin</html>", "app.js": "boot();", "styles.css": "body{}", "floorplan.svg": "<svg/>",
              "vendor/three.min.js": "var THREE={};", "lab-data.json": '{"items":[{"serial_number":"SN-TEST-1"}]}',
              "CLAUDE.md": "notes"}


@pytest.fixture
async def site(tmp_path, monkeypatch):
    """Accounts middleware in front of a catch-all API and a /twin static folder, on a temporary user database."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'users.db'}")
    async with engine.begin() as conn: await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False, accounts_admin_username="admin",
                               accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password=PASSWORD)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", sessions)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    await accounts.bootstrap_admin()
    password_hash = accounts.hash_password(PASSWORD)
    async with sessions() as db:
        for role in ("Viewer", "Operator"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role, password_hash=password_hash, created_at=time.time()))
        await db.commit()
    twin = tmp_path / "twin"
    (twin / "vendor").mkdir(parents=True)
    for name, text in TWIN_FILES.items():
        (twin / name).write_text(text, encoding="utf-8")
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)

    @app.api_route("/api/{path:path}", methods=["GET", "PUT", "POST", "PATCH", "DELETE"])
    async def action(path: str): return {"ok": True}

    app.mount("/twin", StaticFiles(directory=str(twin), html=True), name="twin")
    yield SimpleNamespace(app=app, settings=settings)
    await engine.dispose()


def client(app, **transport): return AsyncClient(transport=ASGITransport(app=app, **transport), base_url="http://test")


async def sign_in(c, username):
    r = await c.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    c.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]


async def raw_get(app, path):
    """Sends the path exactly as given (httpx drops '.' and '..' segments) and returns the status or the error type."""
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
             "path": path, "raw_path": path.encode(), "root_path": "", "query_string": b"",
             "headers": [(b"host", b"test")], "client": ("127.0.0.1", 50000), "server": ("test", 80)}
    sent = []

    async def receive(): return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message): sent.append(message)

    try:
        await app(scope, receive, send)
    except Exception as exc:
        return type(exc).__name__
    return next(m["status"] for m in sent if m["type"] == "http.response.start")


async def test_non_ascii_csrf_header_is_refused_not_a_server_error(site):
    async with client(site.app, raise_app_exceptions=False) as c:
        await sign_in(c, "operator")
        r = await c.put("/api/rack-items", json={}, headers={"X-DCIM-CSRF": b"\xe9"})
        assert r.status_code == 403 and "CSRF" in r.json()["detail"]
        assert (await c.put("/api/rack-items", json={})).status_code == 200


TWIN_PRIVATE = ["/twin/lab-data.json", "/twin/lab-data.json/", "/twin//lab-data.json", "/twin/./lab-data.json",
                "/twin/vendor/../lab-data.json", "/twin/LAB-DATA.JSON", "/twin/lab-data.json.", "/twin/lab-data.json::$DATA",
                "/twin/LAB-DA~1.JSO", "/twin/CLAUDE.md"]
TWIN_PUBLIC = ["/twin/", "/twin/index.html", "/twin/app.js", "/twin/styles.css", "/twin/floorplan.svg", "/twin/vendor/three.min.js"]


async def test_twin_inventory_needs_a_session_while_twin_assets_stay_public(site):
    assert {p: await raw_get(site.app, p) for p in TWIN_PRIVATE} == {p: 401 for p in TWIN_PRIVATE}
    assert {p: await raw_get(site.app, p) for p in TWIN_PUBLIC} == {p: 200 for p in TWIN_PUBLIC}
    async with client(site.app) as c:
        assert (await c.head("/twin/lab-data.json")).status_code == 401
        await sign_in(c, "viewer")
        r = await c.get("/twin/lab-data.json")
        assert r.status_code == 200 and r.json()["items"][0]["serial_number"] == "SN-TEST-1"


async def test_twin_inventory_stays_open_in_legacy_mode(site):
    site.settings.accounts_enabled = False
    assert await raw_get(site.app, "/twin/lab-data.json") == 200


@pytest.mark.parametrize("username,bulk,single", [("viewer", 403, 403), ("operator", 403, 200), ("admin", 200, 200)])
async def test_bulk_owner_replace_is_admin_only(site, username, bulk, single):
    async with client(site.app) as c:
        await sign_in(c, username)
        assert (await c.put("/api/opt-owners", json={})).status_code == bulk
        assert (await c.put("/api/opt-owners/", json={})).status_code == bulk
        assert (await c.put("/api/opt-owners/opt11", json={"engineer_id": None})).status_code == single
        assert (await c.put("/api/opt-owners/item:7", json={"engineer_id": None})).status_code == single
        assert (await c.get("/api/opt-owners")).status_code == 200
