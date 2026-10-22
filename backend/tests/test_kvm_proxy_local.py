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
    assert proxy.ASSET_SEGMENT.startswith("~")
    assert not location.netloc and location.path == f"/api/kvms/test/proxy/{proxy.ASSET_SEGMENT}/jsclient/Client.asp"
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
    assert f'/api/kvms/test/proxy/{proxy.ASSET_SEGMENT}/jsclient/app.js' in r.text
    for name in ["content-encoding","set-cookie","x-frame-options","content-security-policy","etag"]:
        assert name not in r.headers
    assert int(r.headers["content-length"]) == len(r.content) and r.headers["cache-control"] == "no-store"
    assert recorded[0]["headers"]["Cookie"] == "pp_session_id=secret-cookie"
    assert "site-cookie" not in str(recorded)


async def test_rewritten_scripts_are_never_cached_and_the_asset_segment_never_reaches_the_device(kvm, monkeypatch):
    recorded = []
    class Upstream:
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        async def request(self,**kwargs):
            recorded.append(kwargs)
            return httpx.Response(200,content=b"var a=\"<a href='/a'>a</a>\";",headers={
                "content-type":"text/javascript; charset=UTF-8","last-modified":"Fri Apr 30 00:33:41 2021",
                "expires":"Thu, 01 Jan 2037 00:00:00 GMT","etag":"old","cache-control":"max-age=86400"})
    monkeypatch.setattr(proxy.httpx,"AsyncClient",lambda **kwargs:Upstream())
    validators = {"If-Modified-Since":"Fri Apr 30 00:33:41 2021","If-None-Match":"old","If-Range":"old","Range":"bytes=0-25"}
    async with AsyncClient(transport=ASGITransport(app=kvm.app),base_url="http://test") as c:
        fresh = await c.get(f"/api/kvms/test/proxy/{proxy.ASSET_SEGMENT}/js/jquery.min.js?v=1",headers=validators)
        legacy = await c.get("/api/kvms/test/proxy/js/jquery.min.js",headers=validators)
    assert [call["url"] for call in recorded] == ["https://192.0.2.15/js/jquery.min.js?v=1","https://192.0.2.15/js/jquery.min.js"]
    for call in recorded:
        assert not {name.lower() for name in call["headers"]} & {"if-modified-since","if-none-match","if-range","range"}
    for r in (fresh, legacy):
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        assert not {"last-modified","expires","etag"} & set(r.headers)
        assert f"href='/api/kvms/test/proxy/{proxy.ASSET_SEGMENT}/a'" in r.text
    assert proxy._norm_location("/home.asp","192.0.2.15","test") == f"/api/kvms/test/proxy/{proxy.ASSET_SEGMENT}/home.asp"


def test_injected_websocket_urls_are_proxied_once_and_keep_subprotocols():
    node = shutil.which("node")
    assert node, "Node.js is needed to test the real injected browser script"
    prefix = f"/api/kvms/test/proxy/{proxy.ASSET_SEGMENT}"
    js = proxy._override_script("192.0.2.15",prefix,"/api/kvms/test/proxy")
    js = js.removeprefix("<script>\n").removesuffix("</script>")
    urls = ['wss://192.0.2.15/stream?q=1','/api/kvms/test/proxy/ws/stream?q=1','ws://ftlab:8000/api/kvms/test/proxy/ws/stream?q=1',
            '/stream?q=1',f'{prefix}/stream?q=1','/api/kvms/test/proxy/stream?q=1']
    harness = '''
const calls=[];const location={protocol:'http:',host:'ftlab:8000',origin:'http://ftlab:8000',href:'http://ftlab:8000/api/kvms/test/proxy/~r2/jsclient/Client.asp'};
global.window={location,WebSocket:function(u,p){calls.push([u,p]);},fetch:()=>{}};
global.XMLHttpRequest=function(){};XMLHttpRequest.prototype.open=function(){};global.setInterval=function(){};
'''+js+'''
for(const u of '''+json.dumps(urls)+''')new window.WebSocket(u,['binary']);
console.log(JSON.stringify(calls));
'''
    result = subprocess.run([node,"-e",harness],capture_output=True,text=True,check=True,timeout=10)
    calls = json.loads(result.stdout)
    assert calls == [["ws://ftlab:8000/api/kvms/test/proxy/ws/stream?q=1",["binary"]]]*len(urls)


def test_injected_hint_explains_no_video_until_the_kvm_reports_a_picture():
    node = shutil.which("node")
    assert node, "Node.js is needed to test the real injected browser script"
    js = proxy._override_script("192.0.2.15","/p/~r2","/p")
    js = js.removeprefix("<script>\n").removesuffix("</script>")
    harness = '''
const location={protocol:'http:',host:'h',origin:'http://h',href:'http://h/p/~r2/jsclient/Client.asp'};
global.window={location,WebSocket:function(){},fetch:()=>{}};
global.XMLHttpRequest=function(){};XMLHttpRequest.prototype.open=function(){};
let tick;global.setInterval=f=>{tick=f;};
const status={textContent:'Desktop Size is'};const shown=[];
const el=()=>({style:{},children:[],setAttribute(){},appendChild(c){this.children.push(c);}});
global.document={querySelector:s=>s==='#status-size p'?status:null,createElement:el,body:{appendChild:n=>shown.push(n)}};
'''+js+'''
const states=[];
for(let i=0;i<4;i++){tick();states.push(shown.length?shown[0].style.display:'none');}
status.textContent='Desktop Size is 640x480';tick();states.push(shown[0].style.display);
console.log(JSON.stringify({states,text:shown[0].textContent}));
'''
    out = json.loads(subprocess.run([node,"-e",harness],capture_output=True,text=True,check=True,timeout=10).stdout)
    assert out["states"] == ["none","none","none","block","none"]
    assert "asleep" in out["text"] and "Move the mouse" in out["text"]


def test_rewrite_keeps_quotes_so_scripts_stay_valid():
    jquery = 'a.innerHTML="  <link/><table></table><a href=\'/a\'>a</a><input type=\'checkbox\'/>";var s=\'wss://192.0.2.15/x\';'
    out = proxy._rewrite(jquery, "k1", "192.0.2.15")
    p = f"/api/kvms/k1/proxy/{proxy.ASSET_SEGMENT}"
    assert out == (f'a.innerHTML="  <link/><table></table><a href=\'{p}/a\'>a</a><input type=\'checkbox\'/>";'
                   'var s=\'/api/kvms/k1/proxy/ws/x\';')
    html = '<img src="/img/a.png"><a href=\'https://192.0.2.15/home.asp\'>h</a><script src="/api/x.js"></script>'
    assert proxy._rewrite(html, "k1", "192.0.2.15") == (
        f'<img src="{p}/img/a.png"><a href=\'{p}/home.asp\'>h</a><script src="/api/x.js"></script>')
    node = shutil.which("node")
    assert node, "Node.js is needed to syntax-check the rewritten script"
    subprocess.run([node, "-e", f"new Function({json.dumps(out)})"], check=True, capture_output=True, timeout=10)


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
