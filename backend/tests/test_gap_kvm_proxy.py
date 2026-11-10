"""Gaps in app/routers/kvm_proxy.py coverage: device session reuse and the auth.asp re-login,
redirect rewriting, proxy path handling, request/response headers, HTML/JS/CSS rewriting,
console-url / autologin / ensure_session and the WebSocket tunnel's failure paths.

No hardware and no network: every device call goes to an httpx.MockTransport or a fake
websockets.connect, and the routes run in-process through ASGITransport."""
import asyncio
import gzip
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.crypto import encrypt
from app.database import get_db
from app.models import Device
from app.routers import kvm_proxy as proxy

IP = "192.0.2.15"
PREFIX = f"/api/kvms/test/proxy/{proxy.ASSET_SEGMENT}"
DEVICE_PASSWORD = "device-pass-123"
SID = "0123456789abcdef0123456789abcdef01234567"
SIDEBAR = (f'{{"SESSION_ID":"{SID}"}}\n'
           "J('PortId','P_zero'),J('PortName','unused'),J('PortNumber',0)\n"
           "J('PortId','P_one'),J('PortName','srv-a'),J('PortNumber',1)\n"
           "J('PortId','P_seven'),J('PortName','srv-b'),J('PortNumber',7)\n")


def ok(content=b"ok", ctype="application/octet-stream", **headers):
    return httpx.Response(200, content=content, headers={"content-type": ctype, **headers})


def login_ok(cookie="pp_session_id=fresh"):
    return httpx.Response(200, content=b"<html>welcome</html>", headers={"content-type": "text/html", "set-cookie": f"{cookie}; Path=/"})


def login_rejected():
    return httpx.Response(200, content=b"<form action='auth.asp'></form>", headers={"content-type": "text/html"})


@pytest.fixture
def kvm(monkeypatch):
    """Real proxy routes and helpers in front of a recording mock device (state.handler answers each request)."""
    state = SimpleNamespace(
        dev=SimpleNamespace(id="test", kind="kvm", ip=IP, username_enc=encrypt("admin"), password_enc=encrypt(DEVICE_PASSWORD)),
        requests=[], handler=lambda request: ok())
    monkeypatch.setattr(proxy, "_get_device", AsyncMock(return_value=state.dev))
    monkeypatch.setattr(proxy, "_sessions", {})
    monkeypatch.setattr(proxy, "_port_ids", {})

    def device(request):
        state.requests.append(request)
        return state.handler(request)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(proxy.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(device), **kw))
    state.app = FastAPI()
    state.app.include_router(proxy.router)

    async def no_db(): yield None
    state.app.dependency_overrides[get_db] = no_db
    state.seen = lambda: [f"{r.method} {r.url.path}" for r in state.requests]
    return state


def browser(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ---------------------------------------------------------------------------
# Device session handling and the auth.asp re-login
# ---------------------------------------------------------------------------

async def test_auth_redirect_relogs_in_and_replays_the_same_request_once_with_the_new_cookie(kvm):
    proxy._sessions["test"] = "pp_session_id=stale"

    def device(request):
        if request.url.path == "/auth.asp":
            return login_ok("pp_session_id=fresh")
        if request.headers.get("cookie") == "pp_session_id=stale":
            return httpx.Response(302, headers={"location": f"https://{IP}/auth.asp?client=javascript"})
        return ok(b"done")
    kvm.handler = device
    async with browser(kvm.app) as c:
        r = await c.post("/api/kvms/test/proxy/jsclient/action.asp?op=1", content=b"cmd=power")
    assert r.status_code == 200 and r.content == b"done"
    assert kvm.seen() == ["POST /jsclient/action.asp", "POST /auth.asp", "POST /jsclient/action.asp"]
    first, login, retry = kvm.requests
    assert login.url.params["client"] == "javascript"
    form = parse_qs(login.content.decode())
    assert form["login"] == ["admin"] and form["password"] == [DEVICE_PASSWORD] and form["is_javascript_kvm_client"] == ["1"]
    assert retry.content == first.content == b"cmd=power" and str(retry.url) == f"https://{IP}/jsclient/action.asp?op=1"
    assert retry.headers["cookie"] == "pp_session_id=fresh" and proxy._sessions["test"] == "pp_session_id=fresh"


async def test_failed_relogin_retries_only_once_and_sends_the_browser_to_the_proxied_login_page(kvm):
    proxy._sessions["test"] = "pp_session_id=stale"

    def device(request):
        if request.url.path == "/auth.asp":
            return login_rejected()
        return httpx.Response(302, headers={"location": f"https://{IP}:443/auth.asp"})
    kvm.handler = device
    async with browser(kvm.app) as c:
        r = await c.get("/api/kvms/test/proxy/home.asp")
    assert kvm.seen() == ["GET /home.asp", "POST /auth.asp", "GET /home.asp"]
    assert r.status_code == 302 and r.headers["location"] == f"{PREFIX}/auth.asp"
    assert "test" not in proxy._sessions


async def test_without_a_device_session_neither_a_cookie_nor_the_site_host_reaches_the_device(kvm):
    kvm.handler = lambda request: login_rejected() if request.url.path == "/auth.asp" else ok()
    async with browser(kvm.app) as c:
        r = await c.get("/api/kvms/test/proxy/home.asp", headers={"Cookie": "dcim_session=site-session"})
    assert r.status_code == 200 and kvm.seen() == ["POST /auth.asp", "GET /home.asp"]
    sent = kvm.requests[-1]
    assert "cookie" not in sent.headers and sent.headers["host"] == IP


async def test_device_session_is_created_on_first_use_and_reused_afterwards(kvm):
    kvm.handler = lambda request: login_ok("pp_session_id=fresh") if request.url.path == "/auth.asp" else ok()
    async with browser(kvm.app) as c:
        assert (await c.get("/api/kvms/test/proxy/a.asp")).status_code == 200
        assert (await c.get("/api/kvms/test/proxy/b.asp")).status_code == 200
    assert kvm.seen() == ["POST /auth.asp", "GET /a.asp", "GET /b.asp"]
    assert [r.headers["cookie"] for r in kvm.requests[1:]] == ["pp_session_id=fresh"] * 2


# ---------------------------------------------------------------------------
# Redirects
# ---------------------------------------------------------------------------

async def test_other_redirects_are_rewritten_without_relogin_and_without_device_cookie_or_frame_headers(kvm):
    proxy._sessions["test"] = "pp_session_id=s"
    kvm.handler = lambda request: httpx.Response(302, headers={
        "location": f"https://{IP}:443/home.asp?x=1", "set-cookie": "pp_session_id=other; Path=/",
        "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'"})
    async with browser(kvm.app) as c:
        r = await c.get(f"{PREFIX}/index.asp")
    assert r.status_code == 302 and r.headers["location"] == f"{PREFIX}/home.asp?x=1"
    assert not {"set-cookie", "x-frame-options", "content-security-policy"} & set(r.headers)
    assert kvm.seen() == ["GET /index.asp"] and proxy._sessions["test"] == "pp_session_id=s"


@pytest.mark.parametrize("location,expected", [
    (f"https://{IP}/a.asp", f"{PREFIX}/a.asp"),
    (f"http://{IP}:80/a.asp?b=1", f"{PREFIX}/a.asp?b=1"),
    ("/a.asp", f"{PREFIX}/a.asp"),
    (f"{PREFIX}/a.asp", f"{PREFIX}/a.asp"),          # already through the proxy: not prefixed twice
    ("a.asp", "a.asp"),                              # relative: the browser resolves it under the proxy
    ("https://192.0.2.150/a.asp", "https://192.0.2.150/a.asp"),  # a different host sharing the address prefix
])
def test_redirect_location_normalisation(location, expected):
    assert proxy._norm_location(location, IP, "test") == expected


# A device redirect with a body must not keep the device's Content-Length while the proxy sends
# an empty body (uvicorn/h11 would abort the response).
async def test_a_redirect_with_a_body_declares_a_content_length_that_matches_what_is_sent(kvm):
    proxy._sessions["test"] = "pp_session_id=s"
    kvm.handler = lambda request: httpx.Response(302, content=b"<html>Moved</html>", headers={"location": "/home.asp"})
    async with browser(kvm.app) as c:
        r = await c.get(f"{PREFIX}/index.asp")
    assert r.status_code == 302 and r.headers["location"] == f"{PREFIX}/home.asp"
    assert int(r.headers.get("content-length", "0")) == len(r.content)


# A 303 See Other is a redirect too; its absolute device Location must stay inside the proxy.
async def test_a_see_other_redirect_also_stays_inside_the_proxy(kvm):
    proxy._sessions["test"] = "pp_session_id=s"
    kvm.handler = lambda request: httpx.Response(303, headers={"location": f"https://{IP}/home.asp"})
    async with browser(kvm.app) as c:
        r = await c.post(f"{PREFIX}/settings.asp", content=b"a=1")
    assert r.status_code == 303 and r.headers["location"] == f"{PREFIX}/home.asp"


# ---------------------------------------------------------------------------
# Proxy path handling
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path,device_url", [
    ("~r1/js/app.js", f"https://{IP}/js/app.js"),          # an older asset segment is removed as well
    ("~r2", f"https://{IP}/"),                             # the bare segment maps to the device root
    ("js/~r2/app.js", f"https://{IP}/js/~r2/app.js"),      # only a leading segment is stripped
    ("~r2/cgi/q.asp?a=1&b=%2F&c=%20", f"https://{IP}/cgi/q.asp?a=1&b=%2F&c=%20"),  # query reaches the device verbatim
])
async def test_proxy_path_that_reaches_the_device(kvm, path, device_url):
    proxy._sessions["test"] = "pp_session_id=s"
    async with browser(kvm.app) as c:
        r = await c.get(f"/api/kvms/test/proxy/{path}")
    assert r.status_code == 200 and [str(q.url) for q in kvm.requests] == [device_url]


async def test_unknown_or_non_kvm_devices_are_404_before_any_device_contact(db_session, monkeypatch):
    db_session.add(Device(id="p1", name="PDU 1", kind="pdu", ip="192.0.2.30",
                          username_enc=encrypt("admin"), password_enc=encrypt(DEVICE_PASSWORD)))
    await db_session.commit()
    monkeypatch.setattr(proxy, "_sessions", {})
    monkeypatch.setattr(proxy, "_port_ids", {})
    monkeypatch.setattr(proxy.httpx, "AsyncClient", lambda **kw: pytest.fail("no device may be contacted"))
    app = FastAPI()
    app.include_router(proxy.router)

    async def db(): yield db_session
    app.dependency_overrides[get_db] = db
    async with browser(app) as c:
        for device_id in ("p1", "missing"):
            for path in ("proxy/home.asp", "console-url", "autologin?port=1"):
                r = await c.get(f"/api/kvms/{device_id}/{path}")
                assert r.status_code == 404 and r.json() == {"detail": "KVM not found"}, (device_id, path)
    assert proxy._sessions == {} and proxy._port_ids == {}


# ---------------------------------------------------------------------------
# Response headers and content rewriting (frame headers / CSP)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("ctype,body", [
    ("image/png", b'\x89PNG\r\n\x1a\n<img src="/home.asp">\x00\xff'),
    ("application/json", b'{"next":"/auth.asp","ws":"wss://192.0.2.15/x"}'),
])
async def test_non_text_responses_pass_through_byte_for_byte_and_keep_cache_validators(kvm, ctype, body):
    proxy._sessions["test"] = "pp_session_id=s"
    kvm.handler = lambda request: ok(gzip.compress(body), ctype, **{
        "content-encoding": "gzip", "etag": '"v1"', "cache-control": "max-age=600", "connection": "keep-alive",
        "keep-alive": "timeout=5", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'",
        "set-cookie": "pp_session_id=leak"})
    async with browser(kvm.app) as c:
        r = await c.get(f"{PREFIX}/asset")
    assert r.status_code == 200 and r.content == body and r.headers["content-type"] == ctype
    assert r.headers["etag"] == '"v1"' and r.headers["cache-control"] == "max-age=600"
    assert int(r.headers["content-length"]) == len(body)
    assert not {"content-encoding", "connection", "keep-alive", "x-frame-options", "content-security-policy",
                "set-cookie"} & set(r.headers)


async def test_html_override_is_injected_once_right_after_the_real_head_element(kvm):
    proxy._sessions["test"] = "pp_session_id=s"
    page = b'<!DOCTYPE html><HTML><HEAD lang="en"><title>t</title></HEAD><body><header id="h">top</header></body></HTML>'
    fragment = b'<header class="bar">Ports</header><table><tr><td>1</td></tr></table>'  # an XHR-loaded partial
    kvm.handler = lambda request: ok(fragment if request.url.path == "/ports.asp" else page, "text/html; charset=utf-8")
    async with browser(kvm.app) as c:
        r = await c.get(f"{PREFIX}/home.asp")
        partial = await c.get(f"{PREFIX}/ports.asp")
    assert r.text.count("<script>") == 1 and '<HEAD lang="en"><script>' in r.text
    assert '<header id="h">top</header>' in r.text and r.text.endswith("</HTML>")
    assert partial.content == fragment


async def test_scripts_are_rewritten_but_never_receive_the_html_override(kvm):
    proxy._sessions["test"] = "pp_session_id=s"
    js = ('document.write("<head></head>");var a="/auth.asp?x=1";var k=`/kvm/port`;'
          'var o="/other/x";var api="/api/v1/ports";')
    kvm.handler = lambda request: ok(js.encode(), "application/javascript", etag='"js1"')
    async with browser(kvm.app) as c:
        r = await c.get(f"{PREFIX}/js/app.js")
    assert r.text == (f'document.write("<head></head>");var a="{PREFIX}/auth.asp?x=1";var k=`{PREFIX}/kvm/port`;'
                      'var o="/other/x";var api="/api/v1/ports";')
    assert r.headers["cache-control"] == "no-store" and "etag" not in r.headers


def test_rewrite_handles_default_port_plain_http_and_leaves_a_neighbouring_host_alone():
    page = (f'<a href="https://{IP}:443/a.asp">a</a><img src="http://{IP}/b.png">'
            '<form action="https://192.0.2.150/c"></form>'
            f'<script>var w="wss://{IP}/ws/x";var n="wss://192.0.2.150/y";</script>')
    assert proxy._rewrite(page, "test", IP) == (
        f'<a href="{PREFIX}/a.asp">a</a><img src="{PREFIX}/b.png">'
        '<form action="https://192.0.2.150/c"></form>'
        '<script>var w="/api/kvms/test/proxy/ws/ws/x";var n="wss://192.0.2.150/y";</script>')


# Root-relative CSS url(...) images/fonts must resolve through the proxy, not the site origin.
async def test_root_relative_css_urls_go_through_the_proxy(kvm):
    proxy._sessions["test"] = "pp_session_id=s"
    kvm.handler = lambda request: ok(b".logo{background:url(/images/logo.png)}", "text/css")
    async with browser(kvm.app) as c:
        r = await c.get(f"{PREFIX}/css/main.css")
    assert r.text == f".logo{{background:url({PREFIX}/images/logo.png)}}"


# Rewriting must decode and re-encode in the device's declared charset, so non-ASCII text of
# ISO-8859-1 pages survives.
async def test_a_latin1_page_keeps_its_characters(kvm):
    proxy._sessions["test"] = "pp_session_id=s"
    kvm.handler = lambda request: ok("<html><head></head><body>Café réseau</body></html>".encode("latin-1"),
                                     "text/html; charset=ISO-8859-1")
    async with browser(kvm.app) as c:
        r = await c.get(f"{PREFIX}/home.asp")
    assert "Café réseau" in r.text


# ---------------------------------------------------------------------------
# Session info, console-url, autologin and warm-up
# ---------------------------------------------------------------------------

async def test_session_info_reads_the_session_id_and_skips_port_zero(kvm):
    kvm.handler = lambda request: ok(SIDEBAR.encode(), "text/html")
    info = await proxy._get_kvm_session_info("test", kvm.dev, "pp_session_id=s1")
    assert info == {"session_id": SID, "port_ids": {1: "P_one", 7: "P_seven"}}
    assert [str(r.url) for r in kvm.requests] == [f"https://{IP}/sidebar.asp"]
    assert kvm.requests[0].headers["cookie"] == "pp_session_id=s1"
    kvm.handler = lambda request: ok(b'{"SESSION_ID":"abc123"}', "text/html")
    assert (await proxy._get_kvm_session_info("test", kvm.dev, "pp_session_id=s1"))["session_id"] is None


async def test_console_url_uses_pp_session_id_and_cached_ports_without_contacting_the_device(kvm):
    proxy._sessions["test"] = "lang=en; pp_session_id=XYZ ; theme=dark"
    proxy._port_ids["test"] = {3: "P_3"}
    async with browser(kvm.app) as c:
        known = (await c.get("/api/kvms/test/console-url?port=3")).json()
        unknown = (await c.get("/api/kvms/test/console-url?port=4")).json()
    assert known == {"url": f"{PREFIX}/jsclient/Client.asp#sessionId=XYZ&portId=P_3&portNo=3"}
    assert unknown == {"url": f"{PREFIX}/jsclient/Client.asp#sessionId=XYZ&portNo=4"}
    assert kvm.requests == []


async def test_console_url_without_a_device_session_has_no_session_id(kvm):
    kvm.handler = lambda request: login_rejected()
    async with browser(kvm.app) as c:
        bare = (await c.get("/api/kvms/test/console-url")).json()
        port = (await c.get("/api/kvms/test/console-url?port=2")).json()
    assert bare == {"url": f"{PREFIX}/jsclient/Client.asp"}
    assert port == {"url": f"{PREFIX}/jsclient/Client.asp#portNo=2"}
    assert "test" not in proxy._sessions and proxy._port_ids["test"] == {}


async def test_autologin_discards_the_cached_session_and_ports(kvm):
    proxy._sessions["test"] = "pp_session_id=old"
    proxy._port_ids["test"] = {1: "P_OLD"}

    def device(request):
        if request.url.path == "/auth.asp":
            return login_ok("pp_session_id=new")
        fresh = request.headers.get("cookie") == "pp_session_id=new"
        return ok(SIDEBAR.replace("P_one", "P_NEW").encode() if fresh else b"<form action='auth.asp'>", "text/html")
    kvm.handler = device
    async with browser(kvm.app) as c:
        r = await c.get("/api/kvms/test/autologin?port=1")
    assert r.status_code == 302
    assert parse_qs(urlsplit(r.headers["location"]).fragment) == {"sessionId": [SID], "portNo": ["1"], "portId": ["P_NEW"]}
    assert kvm.seen() == ["POST /auth.asp", "GET /sidebar.asp"]
    assert proxy._sessions["test"] == "pp_session_id=new" and proxy._port_ids["test"] == {1: "P_NEW", 7: "P_seven"}


def _sidebar_unreachable(request):
    if request.url.path == "/auth.asp":
        return login_ok("pp_session_id=secret-cookie")
    raise httpx.ConnectError("sidebar down for pp_session_id=secret-cookie", request=request)


@pytest.mark.parametrize("handler,message,seen", [
    (lambda request: login_rejected(), "sign-in failed", ["POST /auth.asp"]),
    (_sidebar_unreachable, "did not return console session details", ["POST /auth.asp", "GET /sidebar.asp"]),
])
async def test_autologin_failures_are_explicit_502s_without_secrets_or_stale_session_reuse(kvm, handler, message, seen):
    proxy._sessions["test"] = "pp_session_id=stale"   # a cached session must never stand in for a failed fresh sign-in
    proxy._port_ids["test"] = {1: "P_OLD"}
    kvm.handler = handler
    async with browser(kvm.app) as c:
        r = await c.get("/api/kvms/test/autologin?port=1")
    assert r.status_code == 502 and message in r.json()["detail"]
    assert kvm.seen() == seen and "secret-cookie" not in r.text and DEVICE_PASSWORD not in r.text
    assert "stale" not in str(proxy._sessions) and "test" not in proxy._port_ids


@pytest.mark.parametrize("session,ports,seen,expected_ports", [
    (None, None, ["POST /auth.asp"], None),                           # sign-in failed: no sidebar fetch, nothing cached
    ("pp_session_id=s", None, ["GET /sidebar.asp"], {1: "P_one", 7: "P_seven"}),  # live session: no new sign-in
    ("pp_session_id=s", {2: "P_2"}, [], {2: "P_2"}),                  # fully warm: the device is not contacted
])
async def test_ensure_session_only_does_the_missing_work(kvm, session, ports, seen, expected_ports):
    if session: proxy._sessions["test"] = session
    if ports: proxy._port_ids["test"] = ports
    kvm.handler = lambda request: login_rejected() if request.url.path == "/auth.asp" else ok(SIDEBAR.encode(), "text/html")
    await proxy.ensure_session("test", kvm.dev)
    assert kvm.seen() == seen and proxy._port_ids.get("test") == expected_ports
    assert proxy._sessions.get("test") == session


async def test_device_login_logs_never_contain_the_password_or_session_cookie(kvm, caplog):
    caplog.set_level(logging.DEBUG, logger=proxy.log.name)
    kvm.handler = lambda request: login_ok("pp_session_id=topsecretcookie")
    async with proxy.httpx.AsyncClient() as client:
        await proxy._login("test", kvm.dev, client)
    assert proxy._sessions["test"] == "pp_session_id=topsecretcookie"

    def broken(request): raise httpx.ConnectError(f"refused admin:{DEVICE_PASSWORD}", request=request)
    kvm.handler = broken
    del proxy._sessions["test"]
    async with proxy.httpx.AsyncClient() as client:
        await proxy._login("test", kvm.dev, client)
    assert "test" not in proxy._sessions
    assert [r.getMessage() for r in caplog.records if r.name == proxy.log.name] == ["KVM test: authenticated", "KVM test: login failed (ConnectError)"]
    assert DEVICE_PASSWORD not in caplog.text and "topsecretcookie" not in caplog.text


# ---------------------------------------------------------------------------
# WebSocket tunnel
# ---------------------------------------------------------------------------

class FakeBrowserSocket:
    def __init__(self, query="", protocols=""):
        self.headers = {"sec-websocket-protocol": protocols} if protocols else {}
        self.url = SimpleNamespace(query=query)
        self.accepted, self.closed, self.received, self.receive_cancelled = [], [], [], False

    async def accept(self, subprotocol=None): self.accepted.append(subprotocol)

    async def receive(self):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.receive_cancelled = True
            raise

    async def send_bytes(self, data): self.received.append(data)
    async def send_text(self, data): self.received.append(data)
    async def close(self, code): self.closed.append(code)


def headers_of(options):
    return options.get("additional_headers", options.get("extra_headers"))


async def test_ws_upstream_failure_closes_1011_and_keeps_session_secrets_out_of_logs(kvm, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger=proxy.log.name)
    proxy._sessions["test"] = "pp_session_id=secret-cookie"
    options = {}

    def connect(url, **kwargs):
        options.update(url=url, **kwargs)
        raise OSError(f"cannot reach {url} with {headers_of(kwargs)}")
    monkeypatch.setattr(proxy.websockets, "connect", connect)
    socket = FakeBrowserSocket(query="sessionId=secret-sid")
    await asyncio.wait_for(proxy.kvm_proxy_ws("test", "kvm/stream", socket, None), timeout=2)
    assert socket.accepted == [] and socket.closed == [1011]
    assert options["url"] == f"wss://{IP}/kvm/stream?sessionId=secret-sid" and options["subprotocols"] is None
    assert headers_of(options) == [("Cookie", "pp_session_id=secret-cookie")]
    assert [r.getMessage() for r in caplog.records if r.name == proxy.log.name] == ["KVM test: console tunnel failed (OSError)"]
    assert "secret-cookie" not in caplog.text and "secret-sid" not in caplog.text


async def test_ws_without_a_session_signs_in_first_and_ends_cleanly_when_the_device_closes(kvm, monkeypatch):
    kvm.handler = lambda request: login_ok("pp_session_id=fresh") if request.url.path == "/auth.asp" else ok(SIDEBAR.encode(), "text/html")
    options = {}

    class Upstream:
        subprotocol = None
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def send(self, data): raise AssertionError("the browser sent nothing")
        def __aiter__(self): return self.frames()
        async def frames(self): yield b"frame"

    def connect(url, **kwargs):
        options.update(url=url, **kwargs)
        return Upstream()
    monkeypatch.setattr(proxy.websockets, "connect", connect)
    socket = FakeBrowserSocket()
    await asyncio.wait_for(proxy.kvm_proxy_ws("test", "kvm/stream", socket, None), timeout=2)
    assert kvm.seen() == ["POST /auth.asp", "GET /sidebar.asp"]
    assert headers_of(options) == [("Cookie", "pp_session_id=fresh")] and proxy._port_ids["test"] == {1: "P_one", 7: "P_seven"}
    assert socket.accepted == [None] and socket.received == [b"frame"]
    assert socket.closed == [1000] and socket.receive_cancelled
