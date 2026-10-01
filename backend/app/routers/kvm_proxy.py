"""
Transparent reverse proxy for KVM devices.

Strips X-Frame-Options / Content-Security-Policy frame-ancestors so the
device UI can be embedded in an iframe served from our own origin.

Flow:
  iframe src="/api/kvms/{id}/proxy/home.asp"
    -> backend fetches https://{kvm_ip}/home.asp  (with session cookie)
    -> strips X-Frame-Options / CSP
    -> rewrites all URLs to go through this proxy
    -> returns content to browser

Session management:
  First request triggers a form POST to /auth.asp?client=javascript.
  The resulting cookie is stored per-device_id and reused until it expires.
  On 302-to-auth we invalidate and re-auth once.

WebSocket:
  JS in the viewer does new WebSocket("wss://10.7.30.49/...").
  URL rewriting changes these to ws://localhost:8000/api/kvms/{id}/proxy/ws/...
  FastAPI's WebSocket endpoint tunnels them through to the device.
"""

import asyncio, re, ssl, logging, html, inspect
from urllib.parse import urlencode
import httpx
import websockets
from fastapi import APIRouter, Request, Response, WebSocket, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models import Device
from ..crypto import decrypt

log = logging.getLogger(__name__)
router = APIRouter()

# Per-device session cookies (key = device_id, value = cookie string)
_sessions: dict[str, str] = {}
# Pre-cached portId map per device (port_number → portId string)
_port_ids: dict[str, dict[int, str]] = {}

STRIP_RESP_HEADERS = frozenset({
    "x-frame-options",
    "content-security-policy",
    "transfer-encoding",
    "connection",
    "keep-alive",
})

# SSL context that ignores self-signed certs
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_device(device_id: str, db: AsyncSession) -> Device:
    result = await db.execute(select(Device).where(Device.id == device_id))
    dev = result.scalar_one_or_none()
    if not dev or dev.kind != "kvm":
        raise HTTPException(404, "KVM not found")
    return dev


async def _login(device_id: str, dev: Device, client: httpx.AsyncClient) -> None:
    """POST credentials to the KVM auth form and cache the session cookie."""
    username = decrypt(dev.username_enc)
    password = decrypt(dev.password_enc)
    try:
        resp = await client.post(
            f"https://{dev.ip}/auth.asp",
            params={"client": "javascript"},
            data={
                "login": username,
                "password": password,
                "PIN": "",
                "is_dotnet": "0",
                "is_javafree": "0",
                "is_standalone_client": "0",
                "is_javascript_kvm_client": "1",
                "is_javascript_rsc_client": "1",
                "action_login": "Login",
            },
            follow_redirects=True,
        )
        cookies = "; ".join(f"{k}={v}" for k, v in client.cookies.items())
        if cookies:
            _sessions[device_id] = cookies
            log.info("KVM %s: authenticated", device_id)
        else:
            log.warning("KVM %s: login response %s, no cookies set", device_id, resp.status_code)
    except Exception as e:
        log.warning("KVM %s: login failed (%s)", device_id, type(e).__name__)


def _norm_location(location: str, dev_ip: str, device_id: str) -> str:
    """Rewrite a redirect Location header to point through our proxy."""
    proxy = f"/api/kvms/{device_id}/proxy"
    # Strip explicit :443 port (HTTPS default)
    loc = location.replace(f"https://{dev_ip}:443/", f"https://{dev_ip}/")
    loc = loc.replace(f"http://{dev_ip}:80/", f"http://{dev_ip}/")
    # Replace absolute device URLs
    loc = loc.replace(f"https://{dev_ip}/", f"{proxy}/")
    loc = loc.replace(f"http://{dev_ip}/", f"{proxy}/")
    # Root-relative paths not already through proxy
    if loc.startswith("/") and not loc.startswith("/api/"):
        loc = f"{proxy}{loc}"
    return loc


# Injected into every HTML page served through the proxy.
# 1. Overrides location.hostname/host/origin so jsclient uses KVM IP for URL construction.
# 2. Intercepts ALL WebSocket connections not already going to our proxy path.
# 3. Intercepts fetch/XHR requests targeting the KVM IP.
_OVERRIDE_TMPL = (
    '<script>\n'
    '(function(){\n'
    '  var KI="%(kvm_ip)s",P="%(proxy)s",O=window.location;\n'
    '  try{Object.defineProperty(window,"location",{configurable:true,get:function(){\n'
    '    return new Proxy(O,{get:function(t,p){\n'
    '      if(p==="hostname"||p==="host")return KI;\n'
    '      if(p==="origin")return "https://"+KI;\n'
    '      if(p==="protocol")return "https:";\n'
    '      var v=t[p];return typeof v==="function"?v.bind(t):v;\n'
    '    }});\n'
    '  }})}catch(e){}\n'
    '  var _W=window.WebSocket;\n'
    '  var _pws=(O.protocol==="https:"?"wss":"ws")+"://"+O.host+P+"/ws";\n'
    '  window.WebSocket=function PW(u,p){\n'
    '    var a=new URL(String(u),O.href),path=a.pathname+a.search;\n'
    '    if(path.indexOf(P+"/ws/")===0)u=_pws+path.slice((P+"/ws").length);\n'
    '    else{if(path.indexOf(P+"/")===0)path=path.slice(P.length);u=_pws+path;}\n'
    '    return p!==undefined?new _W(u,p):new _W(u);\n'
    '  };\n'
    '  window.WebSocket.prototype=_W.prototype;\n'
    '  ["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k,i){window.WebSocket[k]=i;});\n'
    '  var _kiRe=new RegExp("^https?://"+KI.split(".").join("\\\\."));\n'
    '  var _f=window.fetch;\n'
    '  window.fetch=function(r,o){\n'
    '    if(typeof r==="string"&&_kiRe.test(r))r=O.origin+P+r.replace(/^https?:\\/\\/[^\\/]*/,"");\n'
    '    return _f.call(this,r,o);\n'
    '  };\n'
    '  var _x=XMLHttpRequest.prototype.open;\n'
    '  XMLHttpRequest.prototype.open=function(m,u){\n'
    '    if(typeof u==="string"&&_kiRe.test(u))u=O.origin+P+u.replace(/^https?:\\/\\/[^\\/]*/,"");\n'
    '    return _x.apply(this,[m,u].concat([].slice.call(arguments,2)));\n'
    '  };\n'
    '})();\n'
    '</script>'
)


def _rewrite(text: str, device_id: str, dev_ip: str, inject_head: str = "") -> str:
    """Rewrite all URLs that reference the KVM device to go through our proxy."""
    proxy = f"/api/kvms/{device_id}/proxy"

    # Inject override script right after <head>
    if inject_head:
        text = re.sub(r'<head\b[^>]*>', lambda m: m.group(0) + inject_head, text, count=1, flags=re.IGNORECASE)

    # Normalize :443 in absolute URLs
    text = text.replace(f"https://{dev_ip}:443/", f"https://{dev_ip}/")

    # Absolute https://ip/... URLs in HTML attributes (href, src, action, frame src)
    text = re.sub(
        rf'(href|src|action|data-src)=["\']https?://{re.escape(dev_ip)}(/[^"\']*)["\']',
        lambda m: f'{m.group(1)}="{proxy}{m.group(2)}"',
        text,
    )
    # Root-relative paths /some/path in HTML attributes
    text = re.sub(
        r'(href|src|action|data-src)=["\'](/(?!api/)[^"\']*)["\']',
        lambda m: f'{m.group(1)}="{proxy}{m.group(2)}"',
        text,
    )
    # WebSocket URLs in JS
    text = re.sub(
        rf'["\']wss?://{re.escape(dev_ip)}(/[^"\']*)["\']',
        lambda m: f'"{proxy}/ws{m.group(1)}"',
        text,
    )
    # JS strings with absolute paths for known KVM paths
    text = re.sub(
        r'(["\'`])(/(?!api/)(?:auth|html5|dom_kvm|kvm|jsclient|home|sidebar|menu)[^"\'`]*)\1',
        lambda m: f'{m.group(1)}{proxy}{m.group(2)}{m.group(1)}',
        text,
    )
    return text


# ---------------------------------------------------------------------------
# Session warm-up (called as a background task from the status endpoint)
# ---------------------------------------------------------------------------

async def ensure_session(device_id: str, dev) -> None:
    """Establish a KVM session and pre-cache portIds so console-url is instant."""
    if device_id not in _sessions:
        async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=20) as client:
            await _login(device_id, dev, client)
    if device_id in _sessions and device_id not in _port_ids:
        info = await _get_kvm_session_info(device_id, dev, _sessions[device_id])
        _port_ids[device_id] = info["port_ids"]
        log.info("KVM %s: cached %d portIds", device_id, len(_port_ids[device_id]))


# ---------------------------------------------------------------------------
# Auto-login redirect page
# ---------------------------------------------------------------------------

async def _get_kvm_session_info(device_id: str, dev, cookie_str: str) -> dict:
    """
    Fetch sidebar.asp to extract the KVM-level SESSION_ID and port ID map.
    Returns {"session_id": "...", "port_ids": {port_number: portId_string}}.
    """
    async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=20) as client:
        resp = await client.get(
            f"https://{dev.ip}/sidebar.asp",
            headers={"Cookie": cookie_str},
        )
        src = resp.text

    session_id = None
    m = re.search(r'SESSION_ID["\s:]+(["\'])([0-9a-f]{40,})\1', src)
    if m:
        session_id = m.group(2)

    # Parse portId per port number: J('PortId','P_...'), J('PortNumber',N)
    port_ids: dict[int, str] = {}
    for entry in re.finditer(
        r"J\('PortId','([^']+)'\).*?J\('PortNumber',(\d+)\)", src
    ):
        pid, pnum = entry.group(1), int(entry.group(2))
        if pnum > 0:
            port_ids[pnum] = pid

    return {"session_id": session_id, "port_ids": port_ids}


@router.get("/api/kvms/{device_id}/console-url", include_in_schema=False)
async def kvm_console_url(
    device_id: str,
    port: int | None = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Returns a jsclient URL. Uses pp_session_id (the web session cookie) as the
    hash sessionId — jsclient reads getHashValue("sessionId") first, so no
    browser cookie needs to be set.
    """
    dev = await _get_device(device_id, db)

    if device_id not in _sessions:
        async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=20) as client:
            await _login(device_id, dev, client)

    cookie_str = _sessions.get(device_id, "")

    # Extract pp_session_id — this is what jsclient uses for auth
    session_id = None
    m = re.search(r'pp_session_id=([^;]+)', cookie_str)
    if m:
        session_id = m.group(1).strip()

    # Use pre-cached portIds if available; fall back to sidebar.asp fetch
    if device_id in _port_ids:
        port_ids = _port_ids[device_id]
    else:
        info = await _get_kvm_session_info(device_id, dev, cookie_str)
        port_ids = info["port_ids"]
        _port_ids[device_id] = port_ids

    fragment_parts = []
    if session_id:
        fragment_parts.append(f"sessionId={session_id}")
    if port:
        port_id = port_ids.get(port)
        if port_id:
            fragment_parts.append(f"portId={port_id}")
        fragment_parts.append(f"portNo={port}")

    # Serve jsclient through our proxy so all traffic comes from the VM's IP
    # (which matches the authenticated session), not the user's browser IP.
    url = f"/api/kvms/{device_id}/proxy/jsclient/Client.asp"
    if fragment_parts:
        url += "#" + "&".join(fragment_parts)

    log.info("KVM %s: console URL prepared", device_id)
    return {"url": url}


@router.get("/api/kvms/{device_id}/autologin", include_in_schema=False)
async def kvm_autologin(
    device_id: str,
    port: int | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Authenticate on the server and open the viewer through the same-origin proxy."""
    dev = await _get_device(device_id, db)

    # Always force a fresh login so the SESSION_ID is guaranteed valid.
    # Reusing a cached/expired session causes 0x10000001 (permission denied)
    # because sidebar.asp returns the login page and SESSION_ID is not found.
    _sessions.pop(device_id, None)
    _port_ids.pop(device_id, None)
    async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=20) as client:
        await _login(device_id, dev, client)

    cookie_str = _sessions.get(device_id, "")
    if not cookie_str:
        raise HTTPException(502, "KVM sign-in failed. Check VM connectivity and saved credentials.")
    try:
        info = await _get_kvm_session_info(device_id, dev, cookie_str)
    except httpx.HTTPError as exc:
        raise HTTPException(502, "The KVM did not return console session details. Check VM connectivity and the device service.") from exc
    session_id = info.get("session_id")
    port_ids   = info.get("port_ids", {})
    _port_ids[device_id] = port_ids

    if not session_id:
        raise HTTPException(502, "KVM sign-in did not establish a console session. Check the saved credentials and KVM permissions.")
    fragment = {"sessionId":session_id}
    if port:
        fragment["portNo"] = port
        if port_ids.get(port): fragment["portId"] = port_ids[port]
    # HTTP assets and WS traffic share the site's origin. The browser never has
    # to visit the device's self-signed HTTPS endpoint or trust its certificate.
    destination = f"/api/kvms/{device_id}/proxy/jsclient/Client.asp#" + urlencode(fragment)
    return RedirectResponse(destination, status_code=302,
                            headers={"Cache-Control":"no-store", "Referrer-Policy":"no-referrer"})


# ---------------------------------------------------------------------------
# HTTP proxy
# ---------------------------------------------------------------------------

@router.api_route(
    "/api/kvms/{device_id}/proxy/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
async def kvm_proxy(
    device_id: str,
    path: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    dev = await _get_device(device_id, db)

    target = f"https://{dev.ip}/{path}"
    if request.url.query:
        target += f"?{request.url.query}"

    async with httpx.AsyncClient(verify=False, follow_redirects=False, timeout=20) as client:
        # Ensure we have a session
        if device_id not in _sessions:
            await _login(device_id, dev, client)

        fwd_headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in ("host", "connection", "transfer-encoding", "cookie")
        }
        if device_id in _sessions:
            fwd_headers["Cookie"] = _sessions[device_id]

        body = await request.body()

        resp = await client.request(
            method=request.method,
            url=target,
            headers=fwd_headers,
            content=body or None,
        )

        # If redirected to auth, invalidate session, re-login and retry once
        location = resp.headers.get("location", "")
        if resp.status_code in (301, 302, 307, 308) and "auth.asp" in location:
            _sessions.pop(device_id, None)
            await _login(device_id, dev, client)
            if device_id in _sessions:
                fwd_headers["Cookie"] = _sessions[device_id]
            resp = await client.request(
                method=request.method,
                url=target,
                headers=fwd_headers,
                content=body or None,
            )
            # Update location from the retried response
            location = resp.headers.get("location", "")

        # If still a redirect (after auth or to any other page), rewrite Location
        if resp.status_code in (301, 302, 307, 308):
            new_loc = _norm_location(location, dev.ip, device_id)
            resp_headers = {
                k: v for k, v in resp.headers.items()
                if k.lower() not in STRIP_RESP_HEADERS
            }
            resp_headers["location"] = new_loc
            resp_headers.pop("set-cookie", None)
            return Response(status_code=resp.status_code, headers=resp_headers)

        # Build clean response headers (strip X-Frame-Options, CSP, Set-Cookie)
        resp_headers = {
            k: v for k, v in resp.headers.items()
            if k.lower() not in STRIP_RESP_HEADERS and k.lower() not in {"set-cookie", "content-encoding", "content-length"}
        }

        ct = resp.headers.get("content-type", "")
        content = resp.content

        # Rewrite URLs in HTML, JS, and CSS
        if content and ("text/html" in ct or "javascript" in ct or "text/css" in ct):
            try:
                text = content.decode("utf-8", errors="replace")
                inject = ""
                if "text/html" in ct:
                    inject = _OVERRIDE_TMPL % {
                        "kvm_ip": dev.ip,
                        "proxy": f"/api/kvms/{device_id}/proxy",
                    }
                text = _rewrite(text, device_id, dev.ip, inject_head=inject)
                content = text.encode("utf-8")
                resp_headers.pop("etag", None)
                if "text/html" in ct:
                    resp_headers["cache-control"] = "no-store"
                resp_headers.pop("content-length", None)
                resp_headers.pop("Content-Length", None)
            except Exception:
                pass

        return Response(
            content=content,
            status_code=resp.status_code,
            headers=resp_headers,
            media_type=ct or None,
        )


# ---------------------------------------------------------------------------
# WebSocket proxy
# ---------------------------------------------------------------------------

@router.websocket("/api/kvms/{device_id}/proxy/ws/{path:path}")
async def kvm_proxy_ws(
    device_id: str,
    path: str,
    websocket: WebSocket,
    db: AsyncSession = Depends(get_db),
):
    dev = await _get_device(device_id, db)

    proto_header = websocket.headers.get("sec-websocket-protocol", "")
    subprotocols = [s.strip() for s in proto_header.split(",") if s.strip()]
    target_ws = f"wss://{dev.ip}/{path}"
    if websocket.url.query: target_ws += f"?{websocket.url.query}"
    accepted = False
    try:
        if device_id not in _sessions:
            await ensure_session(device_id, dev)
        headers = [("Cookie", _sessions[device_id])] if device_id in _sessions else []
        # Uvicorn allows different websockets versions; support their header API.
        header_option = "additional_headers" if "additional_headers" in inspect.signature(websockets.connect).parameters else "extra_headers"
        async with websockets.connect(target_ws, ssl=_ssl_ctx, origin=f"https://{dev.ip}",
                                      subprotocols=subprotocols or None, ping_interval=None,
                                      open_timeout=15, close_timeout=5, max_size=None,
                                      **{header_option:headers}) as upstream:
            await websocket.accept(subprotocol=upstream.subprotocol)
            accepted = True
            async def to_device():
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect": return
                    if message.get("bytes") is not None: await upstream.send(message["bytes"])
                    elif message.get("text") is not None: await upstream.send(message["text"])
            async def to_client():
                async for message in upstream:
                    if isinstance(message, bytes): await websocket.send_bytes(message)
                    else: await websocket.send_text(message)
            tasks = [asyncio.create_task(to_device()), asyncio.create_task(to_client())]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except Exception as exc:
        # Session cookies and sessionId URLs must not be written to logs.
        log.warning("KVM %s: console tunnel failed (%s)", device_id, type(exc).__name__)
    finally:
        try: await websocket.close(code=1000 if accepted else 1011)
        except Exception: pass
