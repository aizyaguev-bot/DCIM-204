"""Explicit, account-authorized browser SSH; terminal contents are never recorded."""
import asyncio
import codecs
from contextlib import suppress
import contextvars
import errno
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import struct
import time
try:
    import fcntl
    import termios
except ImportError:  # Windows development machines: the "system" PTY path is Linux-only (tests mock it).
    fcntl = termios = None

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import accounts, confirm, ssh_store
from ..config import get_settings
from ..database import AsyncSessionLocal, get_db
from ..models import Device
from ..ping_monitor import validate_host

router = APIRouter(prefix="/api/ssh", tags=["ssh"])
logging.getLogger("asyncssh").setLevel(logging.WARNING)
MAX_INPUT = 65536
MAX_MESSAGE = MAX_INPUT * 6 + 1024
SESSION_CHECK_SECONDS = 30
USERNAME = re.compile(r"[a-z_][a-z0-9_-]{0,31}", re.ASCII)
SLUG = re.compile(r"[a-z0-9][a-z0-9_-]{0,127}", re.ASCII)
ADDRESS_CHANGED_REASON = "Server address changed - an Admin must approve it again"
NOT_APPROVED_REASON = "An Admin must approve this SSH target first"
TURNED_OFF_REASON = "SSH is not allowed for this server: an Admin turned it off"
SAME_ADDRESS_REASON = ("SSH is not allowed for this server: an Admin turned SSH off for another server with the "
                       "same address")
AUTO_CHECK_REASON = ("This server is new or its address changed since an Admin last checked the addresses - "
                     "an Admin must press \"Check addresses again\" in Admin -> SSH")
RATE_REASON = "SSH connection rate limit reached"
SOURCE_UNKNOWN_REASON = "Cannot determine the VM source address for this target; verify and replace <VM IP>"
KEY_DEADLINE_SECONDS = 15     # GET /api/ssh/key: total time for every per-server address/route lookup.
SOURCE_CACHE_SECONDS = 120    # Per-host install source address (or its failure), reused across requests.
SOURCE_CACHE_MAX = 4096
_SOURCE_CACHE: dict = {}
# The VM's own addresses, read once per request (GET /api/ssh/key) instead of once per resolved host.
_OWN_ADDRESSES = contextvars.ContextVar("ssh_own_addresses", default=None)
UNRESOLVED_DETAIL = "SSH target could not be resolved safely"
PROHIBITED_DETAIL = "SSH target resolves to a prohibited address"
NO_KEYS_REASON = ("No SSH key is available: the VM account has no usable key in ~/.ssh and the Lab Manager key "
                  "has not been generated")
CHECK_CONCURRENCY = 8         # Parallel DNS/address checks when many servers are evaluated at once.
UNREACHABLE_ERRNOS = {getattr(errno, name) for name in ("EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EHOSTDOWN", "ENETDOWN")
                      if hasattr(errno, name)}
UNREACHABLE_WINERRORS = {121, 1231, 1232, 10050, 10051, 10060, 10064, 10065}
# Connection failures sent to the browser as these bare tokens (the page turns them into sentences) and audited as-is.
TOKEN_REASONS = frozenset({"unreachable", "refused", "auth_failed", "host_key_changed", "connect_timeout",
                           "connection_failed"})
INSECURE_REASON = ("SSH terminal requires SSH_ALLOW_INSECURE_TRANSPORT=true: browser terminal traffic on HTTP "
                   "is unencrypted; enable this only after accepting that risk and plan HTTPS")
REASONS = {
    "remote_closed": "SSH session ended", "browser_disconnected": "Browser disconnected",
    "idle_timeout": "Idle timeout", "session_expired": "signed_out", "lifetime_limit": "Maximum session length reached",
    "disabled": "SSH terminal is disabled", "host_key_changed": "Host key changed; an Admin must confirm the offered fingerprint",
    "connect_timeout": "SSH connection timed out", "connection_failed": "SSH connection failed",
    "invalid_message": "Invalid terminal message", "input_rate_limit": "Terminal input rate limit reached",
    "cancelled": "Terminal cancelled", "denied": "SSH action denied",
    "unreachable": "unreachable", "refused": "refused", "auth_failed": "auth_failed",
}


class ConnectFailure(Exception):
    """An SSH connection attempt failed for a fixed reason in TOKEN_REASONS; never carries library text."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


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
    own = _OWN_ADDRESSES.get()
    if own is None:
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


def server_in(servers, key):
    if not SLUG.fullmatch(key):
        raise HTTPException(404, "Server not found")
    server = next((s for s in servers if s["key"] == key), None)
    if server is None:
        raise HTTPException(404, "Server not found")
    return server


async def target_for(db, key):
    if not SLUG.fullmatch(key):
        raise HTTPException(404, "Server not found")
    return server_in(await ssh_store.known_servers(db), key)


def host_token(host):
    """Comparison form of a host: case-folded, without a trailing dot; IPs canonical (IPv4-mapped -> IPv4)."""
    value = str(host or "").strip().casefold().rstrip(".")
    try:
        address = ipaddress.ip_address(value.strip("[]"))
    except ValueError:
        return value
    return str(getattr(address, "ipv4_mapped", None) or address)


def denied_host_list(config, servers=()):
    """Hosts SSH is turned off for: the host captured when an Admin turned each server off, plus the current
    saved host of every turned-off server (an Operator may since have changed it)."""
    hosts = dict.fromkeys(config.get("denied_hosts", {}).values())
    denied = set(config.get("denied", ()))
    for server in servers:
        if server["key"] in denied and server.get("host"):
            hosts.setdefault(server["host"], None)
    return list(hosts)


def blocked_hosts(config, servers=()):
    return {host_token(host) for host in denied_host_list(config, servers)}


def user_for(server, config):
    return username(config["per_server_user"].get(server["key"], config["default_user"]))


ALLOWED_STATES = ("explicit", "auto")


def approval(server, config, blocked=None):
    """Return (state, host, reason) for one known server.

    state: "explicit" (an Admin approved it for its saved host), "auto" (the Admin's last "allow every server"
    pass checked and allowed exactly this saved host), "denied" (an Admin turned it off, or turned off another
    server with the same address; wins over everything), "skipped" (that pass could not use its saved host),
    "address_changed" (approved for, or checked with, an older host; or new since the pass) or "none". Only
    explicit/auto may connect, and always to the host returned here: the server's saved host. Connect still
    resolves and checks the address. `blocked`: blocked_hosts(config, servers) when the caller has the list."""
    key = server["key"]
    if key in config.get("denied", ()):
        return "denied", "", TURNED_OFF_REASON
    try:
        saved = checked_host(server["host"])
    except HTTPException:
        return "none", "", "Invalid SSH host"
    if host_token(saved) in (blocked_hosts(config) if blocked is None else blocked):
        return "denied", "", SAME_ADDRESS_REASON
    if config.get("key_source") == "system":
        # Zero clicks: every known server, at its saved host. The lab-network guard (lab_state) still applies.
        return "auto", saved, ""
    host = config.get("targets", {}).get(key)
    if host and checked_host(host) == saved:
        return "explicit", saved, ""
    if config.get("auto_allow"):
        # Operators can add servers and change saved hosts: "every server" means the hosts the Admin's pass saw.
        captured = config.get("auto_hosts", {}).get(key)
        if captured and host_token(captured) == host_token(saved):
            return "auto", saved, ""
        skipped = config.get("auto_skipped", {}).get(key)
        if skipped and skipped.get("host") == saved:
            return "skipped", "", skip_text(skipped.get("reason"), saved)
        return "address_changed", "", AUTO_CHECK_REASON
    if not host:
        return "none", "", NOT_APPROVED_REASON
    return "address_changed", "", ADDRESS_CHANGED_REASON


def approved_host(server, config, blocked=None):
    state, host, reason = approval(server, config, blocked)
    if state not in ALLOWED_STATES:
        raise HTTPException(403, reason)
    return host


# --- Lab networks: where key_source "system" may connect without an Admin click ---------------------------------
OUTSIDE_REASON = "Outside the lab networks (add it to SSH_ALLOWED_NETWORKS)"
LAB_CACHE_SECONDS = 60
LAB_CACHE_MAX = 4096
STATUS_LAB_DEADLINE = 4      # Seconds GET /api/ssh/status waits for lab-network lookups.
_LAB_CACHE: dict = {}         # "networks" -> (expires, frozenset); ("host", token) -> (expires, addresses or None)


def lab_network_of(value):
    """The /24 (IPv4) or /64 (IPv6) around one literal IP address; ValueError for anything else."""
    address = ipaddress.ip_address(str(value or "").strip())
    address = getattr(address, "ipv4_mapped", None) or address
    return ipaddress.ip_network(f"{address}/{24 if address.version == 4 else 64}", strict=False)


def configured_networks():
    """SSH_ALLOWED_NETWORKS: comma-separated CIDRs; entries that are not networks are ignored."""
    found = []
    for item in str(getattr(get_settings(), "ssh_allowed_networks", "") or "").split(","):
        with suppress(ValueError):
            if item.strip():
                found.append(ipaddress.ip_network(item.strip(), strict=False))
    return found


async def lab_networks(db):
    """The lab networks: around every saved PDU/KVM address (Admin-managed devices), plus SSH_ALLOWED_NETWORKS.
    Ping Monitor targets do not count: an Operator can add those, and must not be able to widen where the VM's own
    SSH credentials are used. Cached for LAB_CACHE_SECONDS."""
    now = time.monotonic()
    cached = _LAB_CACHE.get("networks")
    if cached and cached[0] > now:
        return cached[1]
    found = set(configured_networks())
    for (address,) in (await db.execute(select(Device.ip).where(Device.kind.in_(("pdu", "kvm"))))).all():
        with suppress(ValueError, TypeError):
            found.add(lab_network_of(address))
    value = frozenset(found)
    _LAB_CACHE["networks"] = (now + LAB_CACHE_SECONDS, value)
    return value


async def host_addresses(host, *, cached=True):
    """Every address `host` resolves to (canonical), or None when the VM cannot resolve it. Cached briefly."""
    token = ("host", host_token(host))
    now = time.monotonic()
    hit = _LAB_CACHE.get(token) if cached else None
    if hit and hit[0] > now:
        return hit[1]
    try:
        addresses = [canonical_ip(host)]
    except ValueError:
        try:
            answers = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(host, 22, type=socket.SOCK_STREAM),
                                            min(5, getattr(get_settings(), "ssh_connect_timeout_seconds", 10)))
            addresses = sorted({canonical_ip(answer[4][0]) for answer in answers}) or None
        except (OSError, asyncio.TimeoutError, UnicodeError, ValueError):
            addresses = None
    if len(_LAB_CACHE) >= LAB_CACHE_MAX:
        _LAB_CACHE.clear()
    _LAB_CACHE[token] = (now + LAB_CACHE_SECONDS, addresses)
    return addresses


async def lab_state(host, networks, *, cached=True):
    """None when every address of `host` is inside the lab networks, else "outside" or "unresolved"."""
    addresses = await host_addresses(host, cached=cached)
    if not addresses:
        return "unresolved"
    for value in addresses:
        address = ipaddress.ip_address(value)
        if not any(address.version == network.version and address in network for network in networks):
            return "outside"
    return None


def lab_reason(code, host):
    return OUTSIDE_REASON if code == "outside" else skip_text("unresolved", host)


async def limited(items, worker):
    """Run worker over items with bounded concurrency, keeping their order."""
    semaphore = asyncio.Semaphore(CHECK_CONCURRENCY)

    async def run(item):
        async with semaphore:
            return await worker(item)
    return await asyncio.gather(*(run(item) for item in items))


@router.get("/status")
async def status(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    current = principal(request, "Viewer")
    response.headers["Cache-Control"] = "no-store"
    config = await ssh_store.run_file_op(ssh_store.read_config)
    info = await ssh_store.run_file_op(ssh_store.key_info)
    operator = accounts.ROLES[current["user"]["role"]] >= accounts.ROLES["Operator"]
    servers = []
    known = await ssh_store.known_servers(db)
    blocked = blocked_hosts(config, known)
    states = {server["key"]: approval(server, config, blocked) for server in known}
    if config["key_source"] == "system":
        networks = await lab_networks(db)
        await db.rollback()  # DNS lookups below must not hold the inventory read transaction.
        checks = [(key, host) for key, (state, host, _) in states.items() if state in ALLOWED_STATES]
        lookups = asyncio.ensure_future(limited(checks, lambda item: lab_state(item[1], networks)))
        try:
            # Slow DNS never holds the page: unfinished lookups keep filling the cache for the next status, and a
            # terminal always checks the lab networks again with a fresh lookup before it connects.
            codes = await asyncio.wait_for(asyncio.shield(lookups), STATUS_LAB_DEADLINE)
        except asyncio.TimeoutError:
            codes = [None] * len(checks)
        for (key, host), code in zip(checks, codes):
            if code:
                states[key] = (code, "", lab_reason(code, host))
    for server in known:
        pin = await ssh_store.run_file_op(ssh_store.host_info, server["key"])
        state, host, reason = states[server["key"]]
        allowed = state in ALLOWED_STATES
        entry = {"key": server["key"], "name": server["name"], **pin,
                 "host_key": pin, "approved": allowed, "allowed": allowed, "approval": state,
                 "address_changed": state == "address_changed"}
        if operator:
            # approved_host is the host a connection would use: the approval, or the saved host when auto-allowed.
            entry.update(host=server["host"], approved_host=host or config.get("targets", {}).get(server["key"], ""),
                         user=user_for(server, config), not_allowed_reason=reason)
        servers.append(entry)
    transport_allowed = getattr(get_settings(), "ssh_allow_insecure_transport", False)
    result = {"enabled": bool(getattr(get_settings(), "ssh_terminal_enabled", True)),
              "available": bool(getattr(get_settings(), "ssh_terminal_enabled", True) and transport_allowed),
              "transport_allowed": bool(transport_allowed), "insecure_transport_allowed": bool(transport_allowed),
              "blocked_reason": "" if transport_allowed else INSECURE_REASON,
              "installed": await ssh_store.run_file_op(ssh_store.installed),
              "key_exists": info["key_exists"], "public_key_fingerprint": info["fingerprint"],
              "auto_allow": bool(config.get("auto_allow")), "servers": servers}
    if operator:
        result["default_user"] = config["default_user"]
        result["key_source"] = config["key_source"]
        # Whether "system" (the VM's own ssh command) can run here; the reason is a fixed sentence.
        result["system_ssh"] = system_ssh_state()
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


async def public_key_response(db, only=None):
    """Public key plus restricted install/revoke commands for every server SSH may reach (or just `only`)."""
    await ssh_store.run_file_op(ssh_store.load_asyncssh)
    info = await ssh_store.run_file_op(ssh_store.key_info)
    if not info["key_exists"]:
        raise HTTPException(404, "Generate the SSH key in Admin settings first")
    config = await ssh_store.run_file_op(ssh_store.read_config)
    servers = await ssh_store.known_servers(db)
    await db.rollback()  # Inventory is plain data; DNS/route lookups must not retain its read transaction.
    rows = []
    blocked = blocked_hosts(config, servers)
    for server in servers:
        if only is not None and server["key"] != only:
            continue
        state, host, reason = approval(server, config, blocked)
        if state == "address_changed":
            moved = config["targets"].get(server["key"]) or server["host"]
            rows.append((server, checked_host(moved), reason))
        elif state in ALLOWED_STATES:
            rows.append((server, host, ""))
    sources = await install_sources(rows)
    install, revoke = [], []
    for (server, host, moved_reason), (source_ip, row_reason) in zip(rows, sources):
        address_changed = bool(moved_reason)
        options =f'from="{source_ip}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc'
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


async def install_sources(rows):
    """[(source_ip, reason)] for public_key_response rows: route lookups run in parallel under one total deadline,
    reuse a per-host cache and read the VM's own addresses at most once for the whole request."""
    results = [None] * len(rows)
    now = time.monotonic()
    pending = []
    for index, (server, host, moved_reason) in enumerate(rows):
        cached = _SOURCE_CACHE.get(host)
        if moved_reason:
            results[index] = ("<VM IP>", moved_reason)
        elif cached and cached[0] > now:
            results[index] = cached[1]
        else:
            pending.append((index, host))
    if pending:
        own = _OWN_ADDRESSES.set(await asyncio.to_thread(local_addresses))
        semaphore = asyncio.Semaphore(CHECK_CONCURRENCY)

        async def lookup(index, host):
            async with semaphore:
                try:
                    value = (await asyncio.to_thread(installation_source_ip, await resolve_target(host)), "")
                except (HTTPException, OSError, asyncio.TimeoutError):
                    value = ("<VM IP>", SOURCE_UNKNOWN_REASON)
            if len(_SOURCE_CACHE) >= SOURCE_CACHE_MAX:
                _SOURCE_CACHE.clear()
            _SOURCE_CACHE[host] = (time.monotonic() + SOURCE_CACHE_SECONDS, value)
            results[index] = value

        try:
            tasks = [asyncio.ensure_future(lookup(index, host)) for index, host in pending]  # Copy the context.
        finally:
            _OWN_ADDRESSES.reset(own)
        done, late = await asyncio.wait(tasks, timeout=KEY_DEADLINE_SECONDS)
        for task in late:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    # A lookup that missed the deadline gets the same "verify and replace <VM IP>" row (not cached).
    return [value or ("<VM IP>", SOURCE_UNKNOWN_REASON) for value in results]


@router.get("/key")
async def get_key(request: Request, response: Response, server: str | None = None, db: AsyncSession = Depends(get_db)):
    """`?server=<key>` limits install/revoke rows to that server (the terminal page shows only its own command).
    The full list, which resolves every server, is Admin-only."""
    principal(request, "Operator" if server is not None else "Admin")
    if server is not None and not SLUG.fullmatch(server):
        raise HTTPException(404, "Server not found")
    response.headers["Cache-Control"] = "no-store"
    return await public_key_response(db, only=server)


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


def vm_key_dir():
    """Where the VM account's own keys live: ~/.ssh of the account running Lab Manager unless overridden."""
    return getattr(get_settings(), "ssh_vm_key_dir", "") or None


async def config_response(config, response):
    """The stored configuration plus vm_keys (file names, key types, fixed reasons). The ETag covers only the
    stored configuration, so the computed vm_keys never make an If-Match stale."""
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = ssh_store.config_etag(config)
    return {**config, "vm_keys": await ssh_store.run_file_op(ssh_store.vm_key_report, vm_key_dir())}


@router.get("/config")
async def get_config(request: Request, response: Response):
    principal(request, "Admin")
    config = await ssh_store.run_file_op(ssh_store.read_config)
    return await config_response(config, response)


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
    if isinstance(body, dict):
        # Computed, read-only fields may come back when a client echoes GET /config; they are never taken from it.
        body = {name: value for name, value in body.items()
                if name not in ("auto_skipped", "skipped", "vm_keys", "auto_hosts", "denied_hosts")}
    fields = {"default_user", "per_server_user", "targets", "auto_allow", "denied", "key_source"}
    if not isinstance(body, dict) or not body or set(body) - fields:
        raise HTTPException(400, "Supply default_user, per_server_user, targets, denied, auto_allow or key_source")
    # Fields left out keep their saved values, so "Allow every server with an address" can send only auto_allow
    # and the key switch only key_source.
    expected = request.headers.get("if-match")
    current = await ssh_store.run_file_op(ssh_store.read_config)
    if expected is None:
        raise HTTPException(428, "SSH configuration precondition is required")
    if expected != ssh_store.config_etag(current):
        raise HTTPException(412, "SSH configuration has changed")
    default = username(body.get("default_user", current["default_user"]))
    overrides = body.get("per_server_user", current["per_server_user"])
    targets = body["targets"] if "targets" in body else dict(current["targets"])
    if any(not isinstance(value, dict) or len(value) > 10000 for value in (overrides, targets)):
        raise HTTPException(400, "Invalid SSH configuration")
    auto_allow = body.get("auto_allow", current["auto_allow"])
    if type(auto_allow) is not bool:
        raise HTTPException(400, "auto_allow must be true or false")
    key_source = body.get("key_source", current["key_source"])
    if not isinstance(key_source, str) or key_source not in ssh_store.KEY_SOURCES:
        raise HTTPException(400, 'key_source must be "system", "vm" or "site"')
    denied = body.get("denied", current["denied"])
    if (not isinstance(denied, list) or len(denied) > 10000 or
            not all(isinstance(key, str) and SLUG.fullmatch(key) for key in denied)):
        raise HTTPException(400, "denied must be a list of server keys")
    servers = {s["key"]: s for s in await ssh_store.known_servers(db)}
    await db.rollback()  # DNS checks below must not hold the inventory read transaction.
    supplied = {name: body[name] for name in ("per_server_user", "targets") if name in body}
    if "denied" in body:
        supplied["denied"] = dict.fromkeys(denied)
    # Only what this request supplies must name known servers; saved entries of a removed server stay inert.
    if set().union(*supplied.values()) - set(servers):
        raise HTTPException(400, "Unknown server in SSH configuration")
    for value in overrides.values():
        username(value)
    denied = set(denied)
    if "targets" in body:
        if "denied" not in body:
            denied -= set(targets)  # Approving a server again lifts an earlier "not allowed".
        # Approvals are pinned to the saved host, so the config cannot become a free-form SSRF interface.
        for key, value in targets.items():
            host = checked_host(value)
            if host != checked_host(servers[key]["host"]):
                raise HTTPException(400, "Approved SSH host must match the saved server host")
            targets[key] = host
    targets = {key: host for key, host in targets.items() if key not in denied}
    # The saved host of each server turned off now; an earlier capture is kept (the address the Admin turned off).
    denied_hosts = {}
    for key in sorted(denied):
        captured = current["denied_hosts"].get(key)
        if captured is None and key in servers:
            with suppress(HTTPException):
                captured = checked_host(servers[key]["host"])
        if captured:
            denied_hosts[key] = captured
    blocked = blocked_hosts({"denied": sorted(denied), "denied_hosts": denied_hosts}, servers.values())
    # Hosts to check now: newly supplied approvals and, when "allow every server" is (re)applied, every saved
    # server that is not turned off. Unresolvable ones are skipped with a reason instead of failing the save.
    checks = dict(targets) if "targets" in body else {}
    invalid, candidates = [], []
    auto_pass = "auto_allow" in body and auto_allow
    if auto_pass:
        for key, server in servers.items():
            if key in denied:
                continue
            try:
                host = checked_host(server["host"])
            except HTTPException:
                invalid.append(key)  # approval() never allows a server whose saved host is not a valid SSH host.
                continue
            if host_token(host) in blocked:
                continue  # Another server with this address is turned off.
            checks.setdefault(key, host)
            candidates.append(key)
    failures = dict(zip(checks, await limited(list(checks.values()), check_failure)))
    skipped = [{"key": key, "name": servers[key]["name"], "host": checks[key], "reason": skip_text(code, checks[key])}
               for key, code in failures.items() if code]
    skipped += [{"key": key, "name": servers[key]["name"], "host": servers[key]["host"],
                 "reason": skip_text("unchecked", servers[key]["host"])} for key in invalid]
    for item in skipped:
        targets.pop(item["key"], None)
    if auto_pass:
        auto_skipped = {key: {"host": checks[key], "reason": code} for key, code in failures.items() if code}
        # Exactly the saved hosts this pass checked: a server added or re-addressed later waits for the next pass.
        auto_hosts = {key: checks[key] for key in candidates if not failures.get(key)}
    else:
        auto_skipped = auto_hosts = None if auto_allow else {}  # None keeps the last pass while the flag stays on.
    await ssh_store.run_file_op(ssh_store.write_config, default, overrides, targets, expected,
                                auto_allow=auto_allow, denied=sorted(denied), auto_skipped=auto_skipped,
                                key_source=key_source, denied_hosts=denied_hosts, auto_hosts=auto_hosts)
    actions = []
    if auto_allow != current["auto_allow"]:
        actions.append("auto_allow_on" if auto_allow else "auto_allow_off")
    if key_source != current["key_source"]:
        actions.append("key_source_changed")
    if not actions or set(body) & {"default_user", "per_server_user", "targets", "denied"}:
        actions.append("config_updated")
    for action in actions:
        await event(db, request, action)
    config = await ssh_store.run_file_op(ssh_store.read_config)
    result = await config_response(config, response)
    return {**result, "skipped": skipped} if skipped else result


async def check_failure(host):
    """None when the host resolves to a usable address now, else a fixed skip code (no resolver output)."""
    try:
        await resolve_target(host)
        return None
    except HTTPException as error:
        return skip_code(error.detail)
    except (OSError, asyncio.TimeoutError):
        return "unchecked"


def skip_code(detail):
    return {UNRESOLVED_DETAIL: "unresolved", PROHIBITED_DETAIL: "prohibited"}.get(detail, "unchecked")


def skip_text(code, host):
    """Owner-facing reason a server was left unapproved; fixed texts only (no resolver output)."""
    if code == "unresolved":
        return (f"The VM cannot find an IP address for {host}. Give this server its IP address in Ping Monitor "
                "(or fix its name in DNS), then approve it again.")
    if code == "prohibited":
        return f"{host} points to a loopback, link-local, multicast or VM address, which SSH may not use."
    return f"{host} could not be checked as a safe SSH target from the VM."


def skip_reason(detail, host):
    return skip_text(skip_code(detail), host)


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


def client_keys_for(key_source, directory=None, target=None):
    """[(name, key type, key)] in offer order: with "vm" the VM account's own keys as its `ssh` would offer them to
    `target` ({"host", "name", "user"}: the IdentityFile keys its ~/.ssh/config names for that server, then the
    default files), then the Lab Manager key; with "site" only the Lab Manager key. Key objects stay in memory for
    this one connection; names are file names ("id_ed25519", "config:id_lab") or "lab-manager", never paths."""
    offers = list(ssh_store.vm_keys(directory, target)[1]) if key_source == "vm" else []
    try:
        site = ssh_store.private_key()
    except HTTPException as error:
        if error.status_code != 409 or key_source != "vm":
            raise
        if not offers:
            raise HTTPException(409, NO_KEYS_REASON) from None
    else:
        offers.append((ssh_store.SITE_KEY_NAME, ssh_store.key_type_of(site), site))
    return offers


def connect_failure(library, error, reached):
    """Map a connection error to a fixed reason; the library's own text is never shown or stored."""
    if isinstance(error, library.PermissionDenied):
        return "auth_failed"
    if isinstance(error, ConnectionRefusedError):
        return "refused"
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return "connect_timeout" if reached else "unreachable"
    if isinstance(error, OSError) and (error.errno in UNREACHABLE_ERRNOS or
                                       getattr(error, "winerror", None) in UNREACHABLE_WINERRORS):
        return "unreachable"
    return "connection_failed"


def canonical_ip(value):
    address = ipaddress.ip_address(str(value).split("%")[0])
    return str(getattr(address, "ipv4_mapped", None) or address)


async def denied_addresses(hosts):
    """Every address the turned-off hosts resolve to now (lookups that fail are left out)."""
    timeout = min(5, getattr(get_settings(), "ssh_connect_timeout_seconds", 10))

    async def lookup(host):
        try:
            return {canonical_ip(host)}
        except ValueError:
            pass
        try:
            answers = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(host, 22, type=socket.SOCK_STREAM), timeout)
        except (OSError, asyncio.TimeoutError, UnicodeError):
            return set()
        found = set()
        for answer in answers:
            with suppress(ValueError):
                found.add(canonical_ip(answer[4][0]))
        return found
    return set().union(*await limited(list(hosts), lookup)) if hosts else set()


async def connect_target(host):
    """resolve_target for a live connection: a name the VM cannot resolve is "unreachable" and a prohibited
    address is "denied", as fixed reason tokens; other refusals keep their site sentence."""
    try:
        return await resolve_target(host)
    except HTTPException as error:
        if error.detail == UNRESOLVED_DETAIL:
            raise ConnectFailure("unreachable") from None
        if error.detail == PROHIBITED_DETAIL:
            raise HTTPException(403, "denied") from None
        raise


# ─── key_source "system": the VM's own OpenSSH client in a PTY ────────────────────────────────────────────────────
SYSTEM_UNAVAILABLE_REASON = ("The VM's ssh command is not available - an Admin can choose another key source in "
                             "Admin -> SSH")
SYSTEM_NOT_LINUX = "The VM's ssh command can be used only when Lab Manager runs on Linux"
SYSTEM_NO_CLIENT = "This VM has no ssh command - install the OpenSSH client on the VM"
SYSTEM_BAD_CLIENT = "SSH_CLIENT_PATH does not name an executable ssh command"
# The service environment the ssh child keeps: what the account's own `ssh` needs to find its config, keys, agent
# and Kerberos tickets. Everything else (Lab Manager secrets, tokens, passwords, proxies) is left out.
SYSTEM_ENV_KEEP = ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LANGUAGE", "TZ", "SHELL", "SSH_AUTH_SOCK",
                   "KRB5CCNAME", "KRB5_CONFIG", "XDG_RUNTIME_DIR")
SYSTEM_ENV_SENSITIVE = re.compile(r"PASS|SECRET|TOKEN|CREDENTIAL|PRIVATE|_KEY|COOKIE|SESSION|MASTER", re.I)
SYSTEM_STDERR_LIMIT = 65536
# Signal numbers by name; the POSIX values stand in on Windows, where this path never runs (tests mock it).
SIGHUP, SIGKILL, SIGWINCH = (getattr(signal, name, number)
                              for name, number in (("SIGHUP", 1), ("SIGKILL", 9), ("SIGWINCH", 28)))
SYSTEM_READY_GRACE = 30       # Seconds past ConnectTimeout to wait for the first output before showing the terminal.
# OpenSSH client messages (stderr, exit status 255) -> fixed reason tokens. The text itself never leaves this module.
SYSTEM_FAILURES = (
    ("host_key_changed", ("REMOTE HOST IDENTIFICATION HAS CHANGED", "Host key verification failed")),
    ("auth_failed", ("Permission denied",)),
    ("refused", ("Connection refused",)),
    ("connect_timeout", ("timed out during banner exchange",)),
    ("unreachable", ("No route to host", "Could not resolve hostname", "Connection timed out",
                     "Network is unreachable", "Name or service not known")),
)


def system_ssh_path():
    """(path, "") for the OpenSSH client the "system" source runs, or ("", fixed reason) when it cannot run here."""
    if os.name != "posix" or fcntl is None or not hasattr(os, "openpty"):
        return "", SYSTEM_NOT_LINUX
    configured = getattr(get_settings(), "ssh_client_path", "") or ""
    if configured:
        path = Path(configured)
        if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
            return "", SYSTEM_BAD_CLIENT
        return str(path), ""
    found = shutil.which("ssh")
    return (found, "") if found else ("", SYSTEM_NO_CLIENT)


def system_ssh_state():
    path, reason = system_ssh_path()
    return {"available": bool(path), "reason": reason}


def system_argv(ssh_path, user, host, timeout, address=None):
    """The exact argv of the account's own `ssh`: no shell, never prompts (BatchMode), no forwarding of any kind,
    port 22, the validated user and the approved saved host after "--". `address` is the IP the lab-network check
    passed: HostName pins the connection to it (no second DNS lookup, no HostName from the account's SSH config),
    while the account's Host blocks still match the saved name (keys, agent). No proxy, and no shared background
    connection (ControlMaster) that would outlive the terminal."""
    user, host = username(user), checked_host(host)
    if not host or host.startswith("-"):
        raise HTTPException(400, "Invalid SSH host")
    pinned = []
    if address is not None:
        pinned = ["-o", f"HostName={ipaddress.ip_address(str(address))}"]
    return [ssh_path, "-tt", "-p", "22", *pinned, "-o", "BatchMode=yes", "-o", f"ConnectTimeout={int(timeout)}",
            "-o", "ServerAliveInterval=30", "-o", "StrictHostKeyChecking=accept-new", "-o", "ForwardAgent=no",
            "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
            "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "ControlMaster=no", "-o", "ControlPath=none",
            "-o", "ControlPersist=no", "-o", "RequestTTY=force", "-l", user, "--", host]


def system_env(source=None):
    """The ssh child's environment: the kept service variables (and LC_*), never anything that looks secret."""
    source = os.environ if source is None else source
    env = {name: value for name, value in source.items()
           if (name in SYSTEM_ENV_KEEP or name.startswith("LC_")) and not SYSTEM_ENV_SENSITIVE.search(name)}
    if "SSH_AUTH_SOCK" not in env:
        # A service has no login session: use this account's own running ssh-agent when there is one, as the shell would.
        found = ssh_store.agent_socket(source)
        if found:
            env["SSH_AUTH_SOCK"] = found
    env.setdefault("PATH", os.defpath)
    with suppress(RuntimeError, KeyError):
        env.setdefault("HOME", str(Path.home()))
    env["TERM"] = "xterm-256color"
    return env


def system_failure(stderr):
    """Fixed reason token for an ssh that exited with status 255 before the session started."""
    text = stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else str(stderr or "")
    for token, patterns in SYSTEM_FAILURES:
        if any(pattern.lower() in text.lower() for pattern in patterns):
            return token
    return "connection_failed"


class EmptyReader:
    """Local ssh diagnostics never reach the terminal: the bridge's stderr stream is always empty."""

    async def read(self, size):
        return b""


class PtyReader:
    """Non-blocking reads from the PTY master; EOF when the slave side is gone (EIO) or the ssh process exited."""

    def __init__(self, fd, exited):
        self.fd, self.exited, self.pending = fd, exited, b""

    async def read(self, size):
        if self.pending:
            data, self.pending = self.pending[:size], self.pending[size:]
            return data
        loop = asyncio.get_running_loop()
        while True:
            try:
                return os.read(self.fd, size)
            except (BlockingIOError, InterruptedError):
                if self.exited.is_set():
                    return b""
            except OSError as error:
                if error.errno in (errno.EIO, errno.EBADF):
                    return b""
                raise
            ready = loop.create_future()
            loop.add_reader(self.fd, lambda: ready.done() or ready.set_result(None))
            waiter = asyncio.ensure_future(self.exited.wait())
            try:
                await asyncio.wait({ready, waiter}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                loop.remove_reader(self.fd)
                waiter.cancel()
                ready.cancel()


class PtyWriter:
    """Terminal input into the PTY master; a full PTY buffer waits (input is already rate limited)."""

    def __init__(self, fd):
        self.fd, self.buffer = fd, bytearray()

    def write(self, data):
        self.buffer += data

    async def drain(self):
        loop = asyncio.get_running_loop()
        while self.buffer:
            try:
                del self.buffer[:os.write(self.fd, self.buffer)]
                continue
            except (BlockingIOError, InterruptedError):
                pass
            except OSError as error:
                if error.errno in (errno.EIO, errno.EBADF):
                    self.buffer.clear()  # ssh is gone; the output side reports the end.
                    return
                raise
            ready = loop.create_future()
            loop.add_writer(self.fd, lambda: ready.done() or ready.set_result(None))
            try:
                await ready
            finally:
                loop.remove_writer(self.fd)


class SystemSsh:
    """The VM's OpenSSH client in its own session and process group, behind the interface bridge() uses."""

    def __init__(self, process, master):
        self.process, self.master = process, master
        self.exited = asyncio.Event()
        self.stdin, self.stdout, self.stderr = PtyWriter(master), PtyReader(master, self.exited), EmptyReader()
        self.diagnostics = bytearray()
        self._waiter = asyncio.ensure_future(self._wait())
        self._collector = asyncio.ensure_future(self._collect())
        self._closed = False

    async def _wait(self):
        try:
            return await self.process.wait()
        finally:
            self.exited.set()

    async def _collect(self):
        # Kept in memory only for system_failure(); bounded, never logged, never sent.
        while self.process.stderr is not None:
            chunk = await self.process.stderr.read(16384)
            if not chunk:
                return
            room = SYSTEM_STDERR_LIMIT - len(self.diagnostics)
            if room > 0:
                self.diagnostics += chunk[:room]

    def change_terminal_size(self, cols, rows):
        with suppress(OSError, AttributeError):
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        with suppress(OSError):
            os.killpg(self.process.pid, SIGWINCH)

    async def ready(self, timeout):
        """Wait for the first terminal output (the session started) or the end of ssh. Raises ConnectFailure with a
        fixed token when ssh gave up before any output with status 255; otherwise the terminal opens."""
        try:
            first = await asyncio.wait_for(self.stdout.read(16384), timeout)
        except asyncio.TimeoutError:
            return  # Still running and silent: open the terminal; idle/lifetime limits still apply.
        if first:
            self.stdout.pending = first + self.stdout.pending
            return
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(self._waiter), 5)
        with suppress(asyncio.TimeoutError, Exception):
            await asyncio.wait_for(asyncio.shield(self._collector), 1)
        if self.process.returncode == 255:
            raise ConnectFailure(system_failure(bytes(self.diagnostics)))

    async def close(self):
        """SIGHUP to the whole process group, then SIGKILL; always reaped (no zombie); the PTY master closed."""
        if self._closed:
            return
        self._closed = True
        try:
            with suppress(ProcessLookupError, PermissionError):
                os.killpg(self.process.pid, SIGHUP)
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(self._waiter), 2)
            with suppress(ProcessLookupError, PermissionError):
                os.killpg(self.process.pid, SIGKILL)  # Stragglers too (ProxyCommand, ControlPersist).
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(self._waiter), 5)
        finally:
            self._collector.cancel()
            with suppress(OSError):
                os.close(self.master)


async def spawn_system_ssh(argv, env, cols=80, rows=24):
    """Start argv (never a shell) on a new PTY in its own session; stderr is a private pipe for system_failure()."""
    master, slave = os.openpty()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.set_blocking(master, False)
        process = await asyncio.create_subprocess_exec(
            *argv, stdin=slave, stdout=slave, stderr=asyncio.subprocess.PIPE, env=env, start_new_session=True,
            close_fds=True)
    except BaseException:
        os.close(master)
        raise
    finally:
        os.close(slave)
    return SystemSsh(process, master)


@router.websocket("/{key}/terminal")
async def terminal(key: str, websocket: WebSocket):
    session_started = time.monotonic()
    accepted = False
    audit = connection = system = None
    reason, detail, code = "remote_closed", "", 1000
    connected_ip = fingerprint = ""
    counts = {"in": 0, "out": 0}
    signed_in = []   # [(name, key type)] of the key the server accepted
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
        # Per-user attempt limit before any DNS lookup, key file read or session row: sessions, failed
        # connections and denials of the last minute, on every server.
        async with AsyncSessionLocal() as rate_db:
            attempts = await ssh_store.recent_attempts(rate_db, current["user"]["username"])
        if attempts >= getattr(get_settings(), "ssh_max_connect_attempts_per_minute", 12):
            raise HTTPException(429, RATE_REASON)
        async with AsyncSessionLocal() as target_db:
            known = await ssh_store.known_servers(target_db)
            networks = await lab_networks(target_db)
        server = server_in(known, key)
        config = await ssh_store.run_file_op(ssh_store.read_config)
        # Only explicit approvals and hosts captured by the Admin's pass get here (and so the VM account's keys).
        host, user = approved_host(server, config, blocked_hosts(config, known)), user_for(server, config)
        key_source = config["key_source"]
        # "system" runs the VM's own ssh command; the other sources sign in with AsyncSSH and our key list.
        library = None if key_source == "system" else await ssh_store.run_file_op(ssh_store.load_asyncssh)
        connected_ip = await connect_target(host)
        if canonical_ip(connected_ip) in await denied_addresses(denied_host_list(config, known)):
            raise HTTPException(403, "denied")  # Another name for an address an Admin turned SSH off for.
        if key_source == "system":
            # No Admin click in this mode: every resolved address must be inside the lab networks (fresh lookup).
            outside = await lab_state(host, networks, cached=False)
            pinned = ipaddress.ip_address(canonical_ip(connected_ip))
            if outside == "outside" or not any(pinned.version == network.version and pinned in network
                                                for network in networks):
                raise HTTPException(403, OUTSIDE_REASON)
            if outside:
                raise ConnectFailure("unreachable")
            ssh_path, _ = system_ssh_path()
            if not ssh_path:
                raise HTTPException(503, SYSTEM_UNAVAILABLE_REASON)
            # The saved host string goes to ssh (after "--"), pinned to the address checked above.
            argv = system_argv(ssh_path, user, host, getattr(get_settings(), "ssh_connect_timeout_seconds", 10), pinned)
        else:
            offers = await ssh_store.run_file_op(client_keys_for, key_source, vm_key_dir(),
                                                 {"host": host, "name": server["name"], "user": user})
        settings = get_settings()
        if not await session_valid(websocket, current):
            raise HTTPException(401, "signed_out")
        with anyio.CancelScope(shield=True):
            async with AsyncSessionLocal() as reserve_db:
                audit = await ssh_store.start_session(reserve_db, current["user"]["username"], key, host,
                    max_per_user=getattr(settings, "ssh_max_sessions_per_user", 4), max_total=getattr(settings, "ssh_max_sessions_total", 20),
                    user_id=current["user"]["id"], user_name=current["user"]["name"], connected_ip=connected_ip,
                    remote_user=user, client_ip=websocket.client.host if websocket.client else "", key_source=key_source)
        await websocket.send_json({"type": "status", "state": "connecting", "reason": ""})
        if key_source == "system":
            timeout = getattr(settings, "ssh_connect_timeout_seconds", 10)
            try:
                system = await spawn_system_ssh(argv, system_env())
            except OSError:
                raise ConnectFailure("connection_failed") from None
            # Known hosts, keys, agent and Kerberos are the VM account's own; nothing from ssh's stderr is sent.
            await system.ready(timeout + SYSTEM_READY_GRACE)
            process = system
            await websocket.send_json({"type": "status", "state": "connected", "reason": ""})
        else:
            pinned, changed, storage_errors, reached, tried = [], [], [], [], []

            class Client(library.SSHClient):
                def connection_made(self, conn):
                    reached.append(True)  # TCP is up: a later timeout is not "unreachable".

                def public_key_auth_requested(self):
                    # The only source of client keys (client_keys=None): our explicit list, one per call, in order.
                    if len(tried) >= len(offers):
                        return None
                    tried.append(offers[len(tried)])
                    return tried[-1][2]

                def auth_completed(self):
                    if tried:
                        signed_in.append(tried[-1][:2])

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
                # Explicit args keep AsyncSSH's own ~/.ssh/config handling (ProxyCommand, Port, HostName...), the ssh-agent,
                # default key loading, passwords, GSSAPI and tunnels out of the target/auth policy. client_keys=None stops
                # AsyncSSH loading ~/.ssh itself; Client.public_key_auth_requested offers exactly `offers` (ssh_store.vm_keys
                # reads only the config's IdentityFile lines), in order.
                connection = await library.connect(connected_ip, port=22, username=user, client_keys=None, client_factory=Client,
                    known_hosts=library.import_known_hosts(""), server_host_key_algs="default", config=None, agent_path=None,
                    agent_identities=None, pkcs11_provider=None, x509_trusted_certs=None, x509_trusted_cert_paths=None,
                    public_key_auth=True, gss_auth=False, gss_kex=False, password_auth=False, kbdint_auth=False,
                    host_based_auth=False, preferred_auth="publickey", agent_forwarding=False, x11_forwarding=False,
                    connect_timeout=timeout, login_timeout=timeout, encoding=None, keepalive_interval=30, keepalive_count_max=3)
                # No command: the account's login shell only. Lab Manager never runs or writes anything on the server.
                return await connection.create_process(term_type="xterm-256color", term_size=(80, 24), encoding=None)

            try:
                process = await asyncio.wait_for(connect(), timeout)
            except Exception as error:
                if storage_errors:
                    raise storage_errors[0] from None
                raise ConnectFailure("host_key_changed" if changed else connect_failure(library, error, bool(reached))) from None
            await websocket.send_json({"type": "status", "state": "connected",
                "reason": f"new host key pinned {pinned[0]} (unconfirmed; compare using the KVM console)" if pinned else ""})
        maximum = min(getattr(settings, "ssh_max_session_seconds", 3600), getattr(settings, "accounts_session_hours", 12) * 3600)
        remaining = maximum - (time.monotonic() - session_started)
        reason = "lifetime_limit" if remaining <= 0 else await bridge(
            websocket, process, getattr(settings, "ssh_idle_timeout_seconds", 1800), current, counts,
            max_seconds=remaining, audit_id=audit.id)
        if reason == "session_expired":
            code = 4401
    except ConnectFailure as failure:
        reason = failure.reason
        code = 4409 if reason == "host_key_changed" else 1011
    except HTTPException as exc:
        detail, reason = exc.detail, "denied"
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
                if system is not None:
                    await asyncio.wait_for(system.close(), 10)
            with suppress(Exception, asyncio.CancelledError):
                if audit is not None:
                    async with AsyncSessionLocal() as audit_db:
                        await ssh_store.end_session(audit_db, audit.id, reason, counts["in"], counts["out"],
                                                    connected_ip=connected_ip, host_key_fingerprint=fingerprint,
                                                    key_name=signed_in[0][0] if signed_in else "",
                                                    key_type=signed_in[0][1] if signed_in else "")
                elif (reason in ("denied", "unreachable") and getattr(websocket.state, "account", None) and
                        accounts.same_origin(websocket)):
                    async with AsyncSessionLocal() as denial_db:
                        # A refused request, or a target the VM could not resolve before any session was reserved.
                        await event(denial_db, websocket, "denied" if reason == "denied" else "connect_failed",
                                    key if SLUG.fullmatch(key) else "", reason=reason)
            with suppress(Exception, asyncio.CancelledError):
                if audit is not None:
                    await ssh_store.run_file_op(ssh_store.release_session_lock, audit.id)
            # Connection failures go out as bare tokens (unreachable, refused, auth_failed, host_key_changed...);
            # site refusals as their fixed sentence. Library/exception text never reaches the browser.
            final = reason if reason in TOKEN_REASONS else (detail or REASONS[reason])
            if accepted:
                with suppress(Exception, asyncio.CancelledError):
                    await websocket.send_json({"type": "status", "state": "closed", "reason": final})
            with suppress(Exception, asyncio.CancelledError):
                await websocket.close(code=code, reason="signed_out" if code == 4401 else final[:120])
