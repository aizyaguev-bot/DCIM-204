"""No hardware: sign-in redirect, proxied assets and binary/text tunnel lifecycle."""
import asyncio
import gzip
import json
import shutil
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.database import get_db
from app.routers import kvm_proxy as proxy


@pytest.fixture
def kvm(monkeypatch):
    dev = SimpleNamespace(id="test",kind="kvm",ip="192.0.2.15")
    monkeypatch.setattr(proxy,"_get_device",AsyncMock(return_value=dev))
    monkeypatch.setattr(proxy,"_sessions",{})
    monkeypatch.setattr(proxy,"_port_ids",{})
    async def login(id, dev, client): proxy._sessions[id] = "pp_session_id=secret-cookie"
    monkeypatch.setattr(proxy,"_login",login)
    monkeypatch.setattr(proxy,"_get_kvm_session_info",AsyncMock(return_value={"session_id":"a"*40,"port_ids":{2:"port & two"}}))
    app = FastAPI(); app.include_router(proxy.router)
    async def db(): yield None
    app.dependency_overrides[get_db] = db
    return SimpleNamespace(app=app, dev=dev)


async def test_autologin_uses_same_origin_without_certificate_interstitial(kvm):
    async with AsyncClient(transport=ASGITransport(app=kvm.app),base_url="http://test") as c:
        r = await c.get("/api/kvms/test/autologin?port=2")
    assert r.status_code == 302
    location = urlsplit(r.headers["location"])
    assert not location.netloc and location.path == "/api/kvms/test/proxy/jsclient/Client.asp"
    assert parse_qs(location.fragment) == {"sessionId":["a"*40],"portNo":["2"],"portId":["port & two"]}
    assert "no-store" in r.headers["cache-control"] and r.headers["referrer-policy"] == "no-referrer"
    assert "Certificate" not in r.text


async def test_failed_login_is_explicit_not_a_certificate_warning(kvm, monkeypatch):
    monkeypatch.setattr(proxy,"_get_kvm_session_info",AsyncMock(return_value={"session_id":None,"port_ids":{}}))
    async with AsyncClient(transport=ASGITransport(app=kvm.app),base_url="http://test") as c:
        r = await c.get("/api/kvms/test/autologin")
    assert r.status_code == 502 and "permissions" in r.text
    assert "secret-cookie" not in r.text


async def test_html_rewrite_removes_compression_headers_and_keeps_device_cookie_on_server(kvm, monkeypatch):
    recorded = []
    html = b'<html><head></head><body><script src="/jsclient/app.js"></script></body></html>'
    class Upstream:
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        async def request(self,**kwargs):
            recorded.append(kwargs)
            return httpx.Response(200,content=gzip.compress(html),headers={
                "content-type":"text/html","content-encoding":"gzip","content-length":"10",
                "x-frame-options":"deny","content-security-policy":"frame-ancestors 'none'",
                "set-cookie":"pp_session_id=secret-cookie","etag":"old"})
    monkeypatch.setattr(proxy.httpx,"AsyncClient",lambda **kwargs:Upstream())
    async with AsyncClient(transport=ASGITransport(app=kvm.app),base_url="http://test") as c:
        r = await c.get("/api/kvms/test/proxy/jsclient/Client.asp",headers={"Cookie":"site-cookie=private"})
    assert r.status_code == 200 and "window.WebSocket" in r.text
    assert '/api/kvms/test/proxy/jsclient/app.js' in r.text
    for name in ["content-encoding","set-cookie","x-frame-options","content-security-policy","etag"]:
        assert name not in r.headers
    assert int(r.headers["content-length"]) == len(r.content)
    assert recorded[0]["headers"]["Cookie"] == "pp_session_id=secret-cookie"
    assert "site-cookie" not in str(recorded)


def test_injected_websocket_urls_are_proxied_once_and_keep_subprotocols():
    node = shutil.which("node")
    assert node, "Node.js is needed to test the real injected browser script"
    js = (proxy._OVERRIDE_TMPL % {"kvm_ip":"192.0.2.15","proxy":"/api/kvms/test/proxy"})
    js = js.removeprefix("<script>\n").removesuffix("</script>")
    harness = '''
const calls=[];const location={protocol:'http:',host:'ftlab:8000',origin:'http://ftlab:8000',href:'http://ftlab:8000/api/kvms/test/proxy/jsclient/Client.asp'};
global.window={location,WebSocket:function(u,p){calls.push([u,p]);},fetch:()=>{}};
global.XMLHttpRequest=function(){};XMLHttpRequest.prototype.open=function(){};
'''+js+'''
for(const u of ['wss://192.0.2.15/stream?q=1','/api/kvms/test/proxy/ws/stream?q=1','ws://ftlab:8000/api/kvms/test/proxy/ws/stream?q=1','/stream?q=1'])new window.WebSocket(u,['binary']);
console.log(JSON.stringify(calls));
'''
    result = subprocess.run([node,"-e",harness],capture_output=True,text=True,check=True,timeout=10)
    calls = json.loads(result.stdout)
    assert calls == [["ws://ftlab:8000/api/kvms/test/proxy/ws/stream?q=1",["binary"]]]*4


async def test_ws_relays_binary_and_text_and_cancels_when_client_disconnects(kvm, monkeypatch):
    proxy._sessions["test"] = "pp_session_id=secret-cookie"
    sent_to_device=[];sent_to_browser=[];options={};complete=asyncio.Event();cancelled=asyncio.Event()
    class Upstream:
        subprotocol="binary"
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        async def send(self,data): sent_to_device.append(data)
        def __aiter__(self): return self.messages()
        async def messages(self):
            try:
                yield b"video"; yield "status"
                complete.set()
                await asyncio.Event().wait()
            finally: cancelled.set()
    def connect(url,**kwargs): options.update(url=url,**kwargs);return Upstream()
    monkeypatch.setattr(proxy.websockets,"connect",connect)
    class Browser:
        headers={"sec-websocket-protocol":"binary, other"};url=SimpleNamespace(query="port=2")
        messages=iter([{"type":"websocket.receive","bytes":b"keyboard"},{"type":"websocket.receive","text":"mouse"}])
        async def accept(self,subprotocol=None): options["selected"] = subprotocol
        async def receive(self):
            try: return next(self.messages)
            except StopIteration:
                await complete.wait();return {"type":"websocket.disconnect"}
        async def send_bytes(self,data): sent_to_browser.append(data)
        async def send_text(self,data): sent_to_browser.append(data)
        async def close(self,code): options["closed"] = code
    await asyncio.wait_for(proxy.kvm_proxy_ws("test","stream",Browser(),None),timeout=2)
    assert sent_to_device == [b"keyboard","mouse"] and sent_to_browser == [b"video","status"]
    assert options["url"] == "wss://192.0.2.15/stream?port=2"
    assert options["origin"] == "https://192.0.2.15" and options["selected"] == "binary"
    assert options["closed"] == 1000 and cancelled.is_set()
