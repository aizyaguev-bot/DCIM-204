"""Explicit, account-authorized browser SSH; terminal contents are never recorded."""
import asyncio
import codecs
from contextlib import suppress
import errno
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import time

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession

from .. import accounts, confirm, ssh_store
from ..config import get_settings
from ..database import AsyncSessionLocal, get_db
from ..ping_monitor import validate_host

router = APIRouter(prefix="/api/ssh", tags=["ssh"])
logging.getLogger("asyncssh").setLevel(logging.WARNING)
MAX_INPUT = 65536
MAX_MESSAGE = MAX_INPUT * 6 + 1024
SESSION_CHECK_SECONDS = 30
USERNAME = re.compile(r"[a-z_][a-z0-9_-]{0,31}", re.ASCII)
SLUG = re.compile(r"[a-z0-9][a-z0-9_-]{0,127}", re.ASCII)
ADDRESS_CHANGED_REASON = "Server address changed - an Admin must approve it again"
INSECURE_REASON = ("SSH terminal requires SSH_ALLOW_INSECURE_TRANSPORT=true: browser terminal traffic on HTTP "
                   "is unencrypted; enable this only after accepting that risk and plan HTTPS")
REASONS = {
    "remote_closed": "SSH session ended", "browser_disconnected": "Browser disconnected",
    "idle_timeout": "Idle timeout", "session_expired": "signed_out", "lifetime_limit": "Maximum session length reached",
    "disabled": "SSH terminal is disabled", "host_key_changed": "Host key changed; an Admin must confirm the offered fingerprint",
    "connect_timeout": "SSH connection timed out", "connection_failed": "SSH connection failed",
    "invalid_message": "Invalid terminal message", "input_rate_limit": "Terminal input rate limit reached",
    "cancelled": "Terminal cancelled", "denied": "SSH action denied",
}


class AddressFamilyUnavailable(OSError):
    """A safe IPv6 DNS answer cannot be used by this host's socket stack."""


def principal(connection, role):
    if not getattr(get_settings(), "accounts_enabled", False):
        raise HTTPException(403, "SSH terminal requires user accounts")
    current = getattr(connection.state, "account", None)
    if not current:
        raise HTTPException(401, "Sign in to continue")
    user = current["user"]
    if (not user.get("enabled", True) or user.get("must_change_password") or
            accounts.ROLES.get(user.get("role"), -1) < accounts.ROLES[role]):
        raise HTTPException(403, "Your role does not allow this action")
    return current


def enabled():
    if not getattr(get_settings(), "ssh_terminal_enabled", True):
        raise HTTPException(503, REASONS["disabled"])


def username(value):
    if not isinstance(value, str) or not USERNAME.fullmatch(value):
        raise HTTPException(400, "Use a POSIX user name (at most 32 lowercase letters, digits, underscores or dashes)")
    return value


def checked_host(value):
    if not isinstance(value, str) or not value or value.startswith("-"):
        raise HTTPException(400, "Invalid SSH host")
    try:
        return validate_host(value)
    except ValueError:
        raise HTTPException(400, "Invalid SSH host") from None


def local_addresses():
    """Read the VM's interfaces locally; no packets or device probes."""
    found = {"127.0.0.1", "::1"}
    if os.name == "posix":
        import fcntl
        import struct
        with suppress(OSError):
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as interface_socket:
                for _, name in socket.if_nameindex():
                    with suppress(OSError):
                        packed = fcntl.ioctl(interface_socket.fileno(), 0x8915, struct.pack("256s", name.encode()[:15]))
                        found.add(socket.inet_ntoa(packed[20:24]))
        with suppress(OSError):
            for line in Path("/proc/net/if_inet6").read_text().splitlines():
                found.add(str(ipaddress.IPv6Address(int(line.split()[0], 16))))
    return found


def allowed_address(value, own):
    address = ipaddress.ip_address(value)
    address = getattr(address, "ipv4_mapped", None) or address
    own_ips = {ipaddress.ip_address(item) for item in own}
    if (address.is_loopback or address.is_link_local or address.is_unspecified or address.is_multicast or address in own_ips):
        raise HTTPException(403, "SSH target resolves to a prohibited address")
    # A local bind detects secondary addresses and adapters absent from hostname DNS.
    # It neither transmits a packet nor contacts the candidate server.
    family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_DGRAM) as probe:
            try:
                probe.bind((str(address), 0))
            except OSError as exc:
                if exc.errno != errno.EADDRNOTAVAIL and getattr(exc, "winerror", None) != 10049:
                    raise HTTPException(403, "SSH target could not be checked safely") from None
            else:
                raise HTTPException(403, "SSH target resolves to a prohibited address")
    except OSError as exc:
        if address.version == 6 and (exc.errno in (errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT) or
                                     getattr(exc, "winerror", None) in (10043, 10047)):
            raise AddressFamilyUnavailable() from None
        raise HTTPException(403, "SSH target could not be checked safely") from None
    return str(address)


async def resolve_target(host):
    host = checked_host(host)
    own = await asyncio.to_thread(local_addresses)
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        try:
            return allowed_address(str(literal), own)
        except AddressFamilyUnavailable:
            raise HTTPException(403, "SSH target address family is unavailable") from None
    try:
        answers = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(host, 22, type=socket.SOCK_STREAM),
                                        getattr(get_settings(), "ssh_connect_timeout_seconds", 10))
    except (OSError, asyncio.TimeoutError):
        raise HTTPException(403, "SSH target could not be resolved safely") from None
    if not answers:
        raise HTTPException(403, "SSH target could not be resolved safely")
    # Reject mixed safe/unsafe DNS answers, then connect using exactly one checked literal IP.
    addresses = []
    for answer in answers:
        try:
            addresses.append(allowed_address(answer[4][0], own))
        except AddressFamilyUnavailable:
            continue  # Only an unusable safe IPv6 answer may fall back to checked IPv4.
    if not addresses:
        raise HTTPException(403, "SSH target address family is unavailable")
    return addresses[0]


async def target_for(db, key):
    if not SLUG.fullmatch(key):
        raise HTTPException(404, "Server not found")
    server = next((s for s in await ssh_store.known_servers(db) if s["key"] == key), None)
    if server is None:
        raise HTTPException(404, "Server not found")
    return server


def user_for(server, config):
    return username(config["per_server_user"].get(server["key"], config["default_user"]))


def approved_host(server, config):
    host = config.get("targets", {}).get(server["key"])
    if not host:
        raise HTTPException(403, "An Admin must approve this SSH target first")
    host = checked_host(host)
    if host != checked_host(server["host"]):
        raise HTTPException(403, ADDRESS_CHANGED_REASON)
    return host


@router.get("/status")
async def status(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    current = principal(request, "Viewer")
    response.headers["Cache-Control"] = "no-store"
    config = await ssh_store.run_file_op(ssh_store.read_config)
    info = await ssh_store.run_file_op(ssh_store.key_info)
    operator = accounts.ROLES[current["user"]["role"]] >= accounts.ROLES["Operator"]
    servers = []
    for server in await ssh_store.known_servers(db):
        pin = await ssh_store.run_file_op(ssh_store.host_info, server["key"])
        approved = server["key"] in config.get("targets", {})
        address_changed = approved and checked_host(config["targets"][server["key"]]) != checked_host(server["host"])
        entry = {"key": server["key"], "name": server["name"], **pin,
                 "host_key": pin, "approved": approved and not address_changed,
                 "allowed": approved and not address_changed, "address_changed": bool(address_changed)}
        if operator:
            entry.update(host=server["host"], approved_host=config.get("targets", {}).get(server["key"], ""),
                         user=user_for(server, config))
        servers.append(entry)
    transport_allowed = getattr(get_settings(), "ssh_allow_insecure_transport", False)
    result = {"enabled": bool(getattr(get_settings(), "ssh_terminal_enabled", True)),
              "available": bool(getattr(get_settings(), "ssh_terminal_enabled", True) and transport_allowed),
              "transport_allowed": bool(transport_allowed), "insecure_transport_allowed": bool(transport_allowed),
              "blocked_reason": "" if transport_allowed else INSECURE_REASON,
              "installed": await ssh_store.run_file_op(ssh_store.installed),
              "key_exists": info["key_exists"], "public_key_fingerprint": info["fingerprint"], "servers": servers}
    if operator:
        result["default_user"] = config["default_user"]
    if current["user"]["role"] == "Admin":
        result["config_revision"] = ssh_store.config_etag(config)
    return result


def installation_source_ip(connected_ip=None):
    if connected_ip:
        address = ipaddress.ip_address(connected_ip)
        family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
        # UDP connect selects a local route/source without sending any datagram.
        with socket.socket(family, socket.SOCK_DGRAM) as route:
            route.connect((connected_ip, 22))
            return str(ipaddress.ip_address(route.getsockname()[0]))
    for address in sorted(local_addresses()):
        parsed = ipaddress.ip_address(address)
        if parsed.version == 4 and not (parsed.is_loopback or parsed.is_link_local or parsed.is_unspecified or parsed.is_multicast):
            return address
    return "<VM IP>"


async def public_key_response(db):
    await ssh_store.run_file_op(ssh_store.load_asyncssh)
    info = await ssh_store.run_file_op(ssh_store.key_info)
    if not info["key_exists"]:
        raise HTTPException(404, "Generate the SSH key in Admin settings first")
    config = await ssh_store.run_file_op(ssh_store.read_config)
    servers = await ssh_store.known_servers(db)
    await db.rollback()  # Inventory is plain data; DNS/route lookups must not retain its read transaction.
    install, revoke = [], []
    for server in servers:
        if server["key"] not in config.get("targets", {}):
            continue
        host = checked_host(config["targets"][server["key"]])
        row_reason = ""
        address_changed = False
        try:
            host = approved_host(server, config)
            checked_ip = await resolve_target(host)
            source_ip = await asyncio.to_thread(installation_source_ip, checked_ip)
        except (HTTPException, OSError, asyncio.TimeoutError) as error:
            source_ip = "<VM IP>"
            address_changed = isinstance(error, HTTPException) and error.detail == ADDRESS_CHANGED_REASON
            row_reason = (ADDRESS_CHANGED_REASON if address_changed else
                          "Cannot determine the VM source address for this target; verify and replace <VM IP>")
        options = f'from="{source_ip}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc'
        authorized = options + " " + info["public_key"].strip()
        destination = f"{user_for(server, config)}@{host}"
        manual = ("mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' " + shlex.quote(authorized) +
                  " >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys")
        # Both paths install the restricted line; unrestricted ssh-copy-id would bypass that policy.
        install.append({"server": server["name"], "key": server["key"], "command": manual, "manual": manual,
                        "authorized_keys": authorized, "source_ip": source_ip, "reason": row_reason,
                        "address_changed": address_changed,
                        "copy_command": "" if address_changed else "ssh -p 22 -o IdentitiesOnly=yes -i " +
                                        shlex.quote(str((Path(ssh_store.SSH_DIR) / "id_ed25519").absolute())) +
                                        " -- " + shlex.quote(destination) + " " + shlex.quote(manual)})
        for key in [info, *info.get("previous_keys", [])]:
            # Match the immutable base64 public blob, not a mutable display comment.
            blob = key["public_key"].split()[1]
            remove = ("umask 077; awk -v key=" + shlex.quote(blob) +
                      " 'index($0,key)==0' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.dcim-tmp && "
                      "mv ~/.ssh/authorized_keys.dcim-tmp ~/.ssh/authorized_keys")
            revoke.append({"server": server["name"], "fingerprint": key["fingerprint"],
                           "comment": key.get("comment", ""), "command": remove})
    return {"public_key": info["public_key"], "fingerprint": info["fingerprint"], "comment": info.get("comment", ""),
            "install": install, "revoke": revoke,
            "warning": "Install only on approved remote servers, never on this VM. Operators share the remote account; the site audit identifies each person."}


@router.get("/key")
async def get_key(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    principal(request, "Operator")
    response.headers["Cache-Control"] = "no-store"
    return await public_key_response(db)


async def event(db, connection, action, key="", host="", reason="admin_action"):
    current = getattr(connection.state, "account", None)
    if action == "denied" and (not current or not accounts.same_origin(connection)):
        return
    by = current["user"] if current else {"username": "anonymous", "id": "", "name": ""}
    await ssh_store.audit_event(db, by, action, server_key=key, host=host, end_reason=reason,
                                client_ip=connection.client.host if connection.client else "")


async def reconfirm(request, db):
    password, _, body = await confirm.read_body(request)

    async def denied(by):
        await event(db, request, "denied", reason="denied")

    await confirm.verify(request, db, password, get_settings(), confirm.confirm_lock, denied)
    return body


@router.post("/key")
async def generate_key(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    principal(request, "Admin")
    enabled()
    body = await reconfirm(request, db)
    if (set(body) - {"rotate", "expected_fingerprint", "end_sessions"} or
            type(body.get("rotate", False)) is not bool or type(body.get("end_sessions", False)) is not bool):
        raise HTTPException(400, "Invalid key request")
    if body.get("rotate") and not isinstance(body.get("expected_fingerprint"), str):
        raise HTTPException(428, "Rotation requires expected_fingerprint")
    await ssh_store.run_file_op(ssh_store.generate_key, rotate=body.get("rotate", False),
                                expected_fingerprint=body.get("expected_fingerprint"))
    if body.get("end_sessions"):
        await ssh_store.revoke_sessions(db)
    await event(db, request, "key_rotated" if body.get("rotate") else "key_generated")
    response.headers["Cache-Control"] = "no-store"
    return await public_key_response(db)


@router.get("/config")
async def get_config(request: Request, response: Response):
    principal(request, "Admin")
    config = await ssh_store.run_file_op(ssh_store.read_config)
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = ssh_store.config_etag(config)
    return config


@router.put("/config")
async def configure(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    principal(request, "Admin")
    try:
        raw = await request.body()
        body = json.loads(raw) if len(raw) <= 1048576 else None
    except ValueError:
        body = None
    if isinstance(body, dict) and "allowed" in body and "targets" not in body:
        body = {**body, "targets": body["allowed"]}
        del body["allowed"]
    if not isinstance(body, dict) or set(body) != {"default_user", "per_server_user", "targets"}:
        raise HTTPException(400, "Supply default_user, per_server_user and targets")
    default = username(body["default_user"])
    overrides, targets = body["per_server_user"], body["targets"]
    if any(not isinstance(value, dict) or len(value) > 10000 for value in (overrides, targets)):
        raise HTTPException(400, "Invalid SSH configuration")
    servers = {s["key"]: s for s in await ssh_store.known_servers(db)}
    if (set(overrides) | set(targets)) - set(servers):
        raise HTTPException(400, "Unknown server in SSH configuration")
    for value in overrides.values():
        username(value)
    # Approvals are pinned to the saved host, so the config cannot become a free-form SSRF interface.
    for key, value in targets.items():
        host = checked_host(value)
        if host != checked_host(servers[key]["host"]):
            raise HTTPException(400, "Approved SSH host must match the saved server host")
        await resolve_target(host)
        targets[key] = host
    await ssh_store.run_file_op(ssh_store.write_config, default, overrides, targets, request.headers.get("if-match"))
    await event(db, request, "config_updated")
    config = await ssh_store.run_file_op(ssh_store.read_config)
    response.headers["ETag"] = ssh_store.config_etag(config)
    response.headers["Cache-Control"] = "no-store"
    return config


@router.post("/hosts/{key}/accept")
async def accept_host(key: str, request: Request, db: AsyncSession = Depends(get_db)):
    principal(request, "Admin")
    await target_for(db, key)
    body = await reconfirm(request, db)
    if (set(body) != {"expected_fingerprint", "fingerprint"} or
            not all(isinstance(body[field], str) and len(body[field]) <= 128 for field in body)):
        raise HTTPException(400, "Supply expected_fingerprint and fingerprint")
    result = await ssh_store.run_file_op(ssh_store.accept_host, key, body["expected_fingerprint"], body["fingerprint"])
    await event(db, request, "host_key_accepted", key)
    return result


@router.post("/sessions/end")
async def end_sessions(request: Request, db: AsyncSession = Depends(get_db)):
    principal(request, "Admin")
    body = await reconfirm(request, db)
    if body:
        raise HTTPException(400, "Invalid end-sessions request")
    await ssh_store.revoke_sessions(db)
    await event(db, request, "sessions_revoked")
    return {"ok": True}


@router.get("/sessions")
async def sessions(request: Request, response: Response, denials: bool = False, db: AsyncSession = Depends(get_db)):
    principal(request, "Admin")
    response.headers["Cache-Control"] = "no-store"
    return await ssh_store.list_sessions(db, denials=denials)


async def receive_message(websocket):
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    raw = message.get("text")
    if raw is None or len(raw.encode("utf-8")) > MAX_MESSAGE:
        raise ValueError("invalid_message")
    try:
        data = json.loads(raw)
    except ValueError:
        raise ValueError("invalid_message") from None
    if not isinstance(data, dict):
        raise ValueError("invalid_message")
    return data


async def session_valid(websocket, current):
    fresh = await accounts.identity(websocket)
    return bool(fresh and fresh["session_hash"] == current["session_hash"] and
                accounts.ROLES.get(fresh["user"]["role"], -1) >= accounts.ROLES["Operator"] and
                fresh["user"].get("enabled", True) and not fresh["user"].get("must_change_password"))


async def bridge(websocket, process, idle_seconds, current, counts, *, max_seconds=3600, audit_id=None):
    last_input = started = time.monotonic()
    sending = asyncio.Lock()
    output_ready = asyncio.Event()
    output_ready.set()

    async def input_loop():
        nonlocal last_input
        tokens, checked_at, messages = MAX_INPUT * 2, time.monotonic(), []
        while True:
            message = await receive_message(websocket)
            now = time.monotonic()
            messages = [stamp for stamp in messages if now - stamp < 1]
            if len(messages) >= 100:
                return "input_rate_limit"
            messages.append(now)
            kind = message.get("type")
            if kind == "input" and isinstance(message.get("data"), str) and set(message) == {"type", "data"}:
                raw = message["data"].encode("utf-8")
                if len(raw) > MAX_INPUT:
                    raise ValueError("invalid_message")
                tokens = min(MAX_INPUT * 2, tokens + (now - checked_at) * MAX_INPUT)
                checked_at = now
                if len(raw) > tokens:
                    return "input_rate_limit"
                tokens -= len(raw)
                process.stdin.write(raw)
                await process.stdin.drain()
                counts["in"] += len(raw)
                if raw:
                    last_input = now
            elif kind in ("pause", "resume") and set(message) == {"type"}:
                async with sending:
                    if kind == "pause":
                        output_ready.clear()
                    else:
                        output_ready.set()
            elif kind == "resize" and set(message) == {"type", "cols", "rows"}:
                cols, rows = message.get("cols"), message.get("rows")
                if type(cols) is not int or type(rows) is not int or not (1 <= cols <= 500 and 1 <= rows <= 200):
                    raise ValueError("invalid_message")
                process.change_terminal_size(cols, rows)
            else:
                raise ValueError("invalid_message")

    async def output_loop(reader):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            await output_ready.wait()
            raw = await reader.read(16384)
            counts["out"] += len(raw)
            data = decoder.decode(raw, final=not raw)
            if data:
                while True:
                    await output_ready.wait()
                    async with sending:
                        if not output_ready.is_set():
                            continue
                        await websocket.send_json({"type": "output", "data": data})
                        break
            if not raw:
                return

    async def all_output():
        pumps = [asyncio.create_task(output_loop(process.stdout)), asyncio.create_task(output_loop(process.stderr))]
        try:
            await asyncio.gather(*pumps)
        finally:
            for pump in pumps:
                pump.cancel()
            await asyncio.gather(*pumps, return_exceptions=True)
        return "remote_closed"

    async def watchdog():
        checked = started
        while True:
            await asyncio.sleep(min(1, idle_seconds, max_seconds, SESSION_CHECK_SECONDS))
            now = time.monotonic()
            if now - started >= max_seconds:
                return "lifetime_limit"
            if now - last_input >= idle_seconds:
                return "idle_timeout"
            if now - checked >= min(30, SESSION_CHECK_SECONDS):
                if not await session_valid(websocket, current):
                    return "session_expired"
                if audit_id is not None and await ssh_store.session_revoked(audit_id):
                    return "session_expired"
                checked = now
            if not getattr(get_settings(), "ssh_terminal_enabled", True):
                return "disabled"

    tasks = [asyncio.create_task(input_loop()), asyncio.create_task(all_output()), asyncio.create_task(watchdog())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if task.exception():
                raise task.exception()
        return next((task.result() for task in done if task.result()), "remote_closed")
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@router.websocket("/{key}/terminal")
async def terminal(key: str, websocket: WebSocket):
    session_started = time.monotonic()
    accepted = False
    audit = connection = None
    reason, detail, code = "remote_closed", "", 1000
    connected_ip = fingerprint = ""
    counts = {"in": 0, "out": 0}
    try:
        current = principal(websocket, "Operator")
        enabled()
        if not getattr(get_settings(), "ssh_allow_insecure_transport", False):
            raise HTTPException(403, INSECURE_REASON)
        if not websocket.headers.get("origin") or not accounts.same_origin(websocket):
            raise HTTPException(403, "Cross-origin action rejected")
        if websocket.url.query:
            raise HTTPException(403, "Terminal parameters must not be supplied in the URL")
        if not await session_valid(websocket, current):
            raise HTTPException(401, "signed_out")
        await websocket.accept()
        accepted = True
        try:
            first = await asyncio.wait_for(receive_message(websocket), timeout=10)
        except (ValueError, asyncio.TimeoutError):
            raise HTTPException(403, "Refresh the page and retry (invalid CSRF token)") from None
        token = first.get("csrf_token", first.get("csrf", first.get("X-DCIM-CSRF", "")))
        if not isinstance(token, str) or not token or not secrets.compare_digest(token.encode(), current["csrf_token"].encode()):
            raise HTTPException(403, "Refresh the page and retry (invalid CSRF token)")
        library = await ssh_store.run_file_op(ssh_store.load_asyncssh)
        async with AsyncSessionLocal() as target_db:
            server = await target_for(target_db, key)
        config = await ssh_store.run_file_op(ssh_store.read_config)
        host, user = approved_host(server, config), user_for(server, config)
        connected_ip = await resolve_target(host)
        private_key = await ssh_store.run_file_op(ssh_store.private_key)
        settings = get_settings()
        if not await session_valid(websocket, current):
            raise HTTPException(401, "signed_out")
        with anyio.CancelScope(shield=True):
            async with AsyncSessionLocal() as reserve_db:
                audit = await ssh_store.start_session(reserve_db, current["user"]["username"], key, host,
                    max_per_user=getattr(settings, "ssh_max_sessions_per_user", 4), max_total=getattr(settings, "ssh_max_sessions_total", 20),
                    user_id=current["user"]["id"], user_name=current["user"]["name"], connected_ip=connected_ip,
                    remote_user=user, client_ip=websocket.client.host if websocket.client else "")
        await websocket.send_json({"type": "status", "state": "connecting", "reason": ""})
        pinned, changed, storage_errors = [], [], []

        class Client(library.SSHClient):
            def validate_host_public_key(self, ignored_host, addr, port, host_key):
                nonlocal fingerprint
                fingerprint = host_key.get_fingerprint()
                try:
                    # AsyncSSH's host-key callback is synchronous: never wait for a held storage lock here.
                    if ssh_store.pin_host(key, host, host_key, blocking=False):
                        pinned.append(fingerprint)
                    return True
                except ssh_store.HostKeyChanged:
                    changed.append(True)
                    return False
                except HTTPException as error:
                    storage_errors.append(error)
                    return False

        timeout = getattr(settings, "ssh_connect_timeout_seconds", 10)

        async def connect():
            nonlocal connection
            # Explicit args prevent ~/.ssh, ssh-agent, passwords, GSSAPI or tunnels from changing the target/auth policy.
            connection = await library.connect(connected_ip, port=22, username=user, client_keys=[private_key], client_factory=Client,
                known_hosts=library.import_known_hosts(""), server_host_key_algs="default", config=None, agent_path=None,
                x509_trusted_certs=None, x509_trusted_cert_paths=None,
                gss_auth=False, gss_kex=False, password_auth=False, kbdint_auth=False, host_based_auth=False,
                preferred_auth="publickey", agent_forwarding=False, x11_forwarding=False, connect_timeout=timeout,
                login_timeout=timeout, encoding=None, keepalive_interval=30, keepalive_count_max=3)
            return await connection.create_process(term_type="xterm-256color", term_size=(80, 24), encoding=None)

        try:
            process = await asyncio.wait_for(connect(), timeout)
        except Exception:
            if storage_errors:
                raise storage_errors[0] from None
            if changed:
                reason = "host_key_changed"
                raise HTTPException(409, REASONS[reason]) from None
            raise
        await websocket.send_json({"type": "status", "state": "connected",
            "reason": f"new host key pinned {pinned[0]} (unconfirmed; compare using the KVM console)" if pinned else ""})
        maximum = min(getattr(settings, "ssh_max_session_seconds", 3600), getattr(settings, "accounts_session_hours", 12) * 3600)
        remaining = maximum - (time.monotonic() - session_started)
        reason = "lifetime_limit" if remaining <= 0 else await bridge(
            websocket, process, getattr(settings, "ssh_idle_timeout_seconds", 1800), current, counts,
            max_seconds=remaining, audit_id=audit.id)
        if reason == "session_expired":
            code = 4401
    except HTTPException as exc:
        detail = exc.detail
        reason = "host_key_changed" if exc.status_code == 409 and reason == "host_key_changed" else "denied"
        code = {401: 4401, 403: 4403, 404: 4404, 409: 4409, 429: 4429, 503: 4503}.get(exc.status_code, 1011)
    except WebSocketDisconnect:
        reason = "browser_disconnected"
    except asyncio.TimeoutError:
        reason, code = "connect_timeout", 1011
    except ValueError:
        reason, code = "invalid_message", 4400
    except asyncio.CancelledError:
        reason = "cancelled"
        raise
    except Exception:
        reason, code = "connection_failed", 1011
    finally:
        with anyio.CancelScope(shield=True):
            # Cleanup operations are independent: an audit/storage failure must never leave the socket open.
            with suppress(Exception, asyncio.CancelledError):
                if connection is not None:
                    connection.close()
                    await asyncio.wait_for(connection.wait_closed(), 5)
            with suppress(Exception, asyncio.CancelledError):
                if audit is not None:
                    async with AsyncSessionLocal() as audit_db:
                        await ssh_store.end_session(audit_db, audit.id, reason, counts["in"], counts["out"],
                                                    connected_ip=connected_ip, host_key_fingerprint=fingerprint)
                elif (reason == "denied" and getattr(websocket.state, "account", None) and
                        accounts.same_origin(websocket)):
                    async with AsyncSessionLocal() as denial_db:
                        await event(denial_db, websocket, "denied", key if SLUG.fullmatch(key) else "", reason="denied")
            with suppress(Exception, asyncio.CancelledError):
                if audit is not None:
                    await ssh_store.run_file_op(ssh_store.release_session_lock, audit.id)
            if accepted:
                with suppress(Exception, asyncio.CancelledError):
                    await websocket.send_json({"type": "status", "state": "closed", "reason": detail or REASONS[reason]})
            with suppress(Exception, asyncio.CancelledError):
                await websocket.close(code=code, reason="signed_out" if code == 4401 else (detail or REASONS[reason])[:120])
