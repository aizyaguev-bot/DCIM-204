"""SSH API and real protocol checks, exclusively against 127.0.0.1 fake servers."""
from contextlib import asynccontextmanager, contextmanager
import asyncio
import ast
import errno
import logging
from pathlib import Path
import socket as socket_module
import json
import os
import shlex
import sys
import threading
import time
from types import SimpleNamespace

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.websockets import WebSocketDisconnect

from app import accounts, ssh_store
from app.config import Settings
from app.database import Base, get_db
from app.models import Device, PingTarget, User, UserSession
from app.routers import ssh

PASSWORD = "local-ssh-test-password"
PASSWORD_HASH = accounts.hash_password(PASSWORD)


@pytest.fixture(autouse=True)
def no_system_ssh_config(tmp_path, monkeypatch):
    # Never this machine's /etc/ssh/ssh_config: tests give the system-wide config explicitly when they need one.
    monkeypatch.setattr(ssh_store, "SYSTEM_SSH_CONFIG", tmp_path / "etc-ssh" / "ssh_config")


@pytest.fixture
async def api(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'ssh-tests.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    # A fake home for "the VM account": never the real ~/.ssh of this machine (keys, config or agent).
    home = tmp_path / "vm-home"
    (home / ".ssh").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    for name in ("HOME", "USERPROFILE"):
        monkeypatch.setenv(name, str(home))
    monkeypatch.setenv("SSH_AUTH_SOCK", str(home / "no-agent.sock"))
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False,
        accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password="",
        ssh_terminal_enabled=True, ssh_allow_insecure_transport=True, ssh_idle_timeout_seconds=1800, ssh_connect_timeout_seconds=2,
        ssh_max_sessions_per_user=4, ssh_max_sessions_total=20, ssh_vm_key_dir=str(home / ".ssh"))
    monkeypatch.setattr(accounts, "AsyncSessionLocal", factory)
    monkeypatch.setattr(ssh, "AsyncSessionLocal", factory, raising=False)
    monkeypatch.setattr(ssh_store, "AsyncSessionLocal", factory, raising=False)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(ssh, "get_settings", lambda: settings)
    monkeypatch.setattr(ssh_store, "SSH_DIR", tmp_path / "private-ssh")
    monkeypatch.setattr(ssh, "_SOURCE_CACHE", {})
    async with factory() as db:
        for role in ("Viewer", "Operator", "Admin"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role,
                        password_hash=PASSWORD_HASH, created_at=time.time()))
        db.add(PingTarget(id="saved", source_key="server:local", name="Local",
                          host="127.0.0.1", source="manual"))
        await db.commit()
    # Explicit approvals and the AsyncSSH key source "vm" here (the contract these tests check against a real fake
    # SSH server); the defaults ("system", every server) have their own tests.
    ssh_store.write_config("root", {}, {"local": "127.0.0.1"}, expected_etag=ssh_store.config_etag(), auto_allow=False,
                           key_source="vm")
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(ssh.router)

    async def database():
        async with factory() as db:
            yield db

    app.dependency_overrides[get_db] = database
    try:
        yield SimpleNamespace(app=app, factory=factory, settings=settings, directory=tmp_path / "private-ssh",
                              home=home, vm_keys=home / ".ssh")
    finally:
        # Capacity tests deliberately leave reservations active. Release their
        # Windows file handles before pytest attempts temporary-directory cleanup.
        async with factory() as db:
            active = (await db.execute(select(ssh_store.SshSession.id).where(
                ssh_store.SshSession.ended_at.is_(None)))).scalars().all()
            for identifier in active:
                await ssh_store.end_session(db, identifier, "cancelled", 0, 0)
        await engine.dispose()


@contextmanager
def browser(api, role="admin"):
    with TestClient(api.app) as client:
        response = client.post("/api/auth/login", json={"username": role, "password": PASSWORD})
        assert response.status_code == 200
        client.headers["X-DCIM-CSRF"] = response.json()["csrf_token"]
        yield client


def socket_headers():
    return {"Origin": "http://testserver"}


def authenticate(socket, client):
    socket.send_json({"type": "auth", "csrf_token": client.headers["X-DCIM-CSRF"]})


def until(socket, state):
    for _ in range(30):
        message = socket.receive_json()
        if message.get("state") == state:
            return message
    pytest.fail(f"Terminal did not reach {state}")


@pytest.mark.parametrize("path,method,role", [
    ("/api/ssh/status", "GET", "Viewer"), ("/api/ssh/key", "GET", "Operator"),
    ("/api/ssh/key", "POST", "Admin"), ("/api/ssh/config", "PUT", "Admin"),
    ("/api/ssh/config", "GET", "Admin"), ("/api/ssh/hosts/local/accept", "POST", "Admin"), ("/api/ssh/sessions", "GET", "Admin"),
    ("/api/ssh/local/terminal", "GET", "Operator"), ("/api/ssh/status", "POST", "Admin"),
    ("/api/ssh-not/status", "GET", "Viewer"),
    ("/api/ssh/rack/server/terminal", "GET", "Admin"),
    ("/api/ssh/status", "HEAD", "Admin"), ("/api/ssh/key", "HEAD", "Admin"),
    ("/api/ssh/local/terminal", "POST", "Admin"), ("/api/ssh/unknown", "GET", "Admin"),
])
def test_role_contract(path, method, role):
    assert accounts.required_role(path, method) == role


def test_settings_defaults():
    settings = Settings(_env_file=None)
    assert settings.ssh_terminal_enabled is True
    assert settings.ssh_allow_insecure_transport is False
    assert settings.ssh_connect_timeout_seconds == 10
    assert settings.ssh_idle_timeout_seconds == 1800
    assert settings.ssh_max_sessions_per_user == 4
    assert settings.ssh_max_sessions_total == 20


async def test_targets_are_saved_server_identities_only(api):
    async with api.factory() as db:
        db.add_all([
            Device(id="pdu", kind="pdu", name="PDU", ip="127.0.0.1", labels_json=json.dumps(
                {"1": "OPT11 (2)", "2": "Outlet 2", "3": "bad name", "4": "blocked"})),
            Device(id="kvm", kind="kvm", name="KVM", ip="127.0.0.1", labels_json='{"1":"OPT11","2":"server-b"}'),
            PingTarget(id="override", source_key="server:opt11", name="OPT11", host="127.0.0.2"),
            PingTarget(id="untrusted", source_key="manual:other", name="Not a server", host="127.0.0.3"),
            PingTarget(id="bad", source_key="server:blocked", name="blocked", host="https://invalid.example/"),
        ])
        await db.commit()
        servers = {s["key"]: s for s in await ssh_store.known_servers(db)}
    assert set(servers) == {"local", "opt11", "server-b"}
    assert servers["opt11"]["host"] == "127.0.0.2"
    assert servers["server-b"]["host"] == "server-b"


async def test_missing_dependency_is_lazy_and_status_still_works(api, monkeypatch):
    monkeypatch.setitem(sys.modules, "asyncssh", None)
    with browser(api, "admin") as client:
        response = client.get("/api/ssh/status")
        assert response.status_code == 200
        assert response.json()["installed"] is False
        assert response.json()["key_exists"] is False
        assert response.json()["servers"][0]["host_key_known"] is False
        response = client.post("/api/ssh/key", json={"password": PASSWORD})
        assert response.status_code == 503
        assert response.json()["detail"] == "SSH support is not installed on the server"
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as socket:
            authenticate(socket, client)
            assert until(socket, "closed")["reason"] == "SSH support is not installed on the server"
    assert not (api.directory / "id_ed25519").exists()


async def test_api_roles_csrf_and_password_reconfirmation(api):
    for role in ("viewer", "operator", "admin"):
        with browser(api, role) as client:
            result = client.get("/api/ssh/status")
            assert result.status_code == 200
            if role == "viewer":
                assert "default_user" not in result.json()
                assert not {"host", "user", "approved_host"}.intersection(result.json()["servers"][0])
            else:
                assert result.json()["servers"][0]["user"] == "root"
            expected = 200 if role == "admin" else 403
            assert client.get("/api/ssh/sessions").status_code == expected
            response = client.put("/api/ssh/config", json={"default_user": "deployer", "per_server_user": {}, "targets": {}}, headers={"If-Match": ssh_store.config_etag()})
            assert response.status_code == expected
            if role == "viewer":
                assert client.get("/api/ssh/key").status_code == 403
            if role != "admin":
                assert client.post("/api/ssh/key", json={"password": PASSWORD}).status_code == 403
    with browser(api) as client:
        assert client.post("/api/ssh/key", json={"password": "wrong"}).status_code == 403
        assert client.post("/api/ssh/key", json={"password": [PASSWORD]}).status_code == 400
        assert client.post("/api/ssh/hosts/local/accept", json={"password": "wrong"}).status_code == 403
        del client.headers["X-DCIM-CSRF"]
        assert client.put("/api/ssh/config", json={"default_user": "root", "per_server_user": {}}).status_code == 403
    assert not (api.directory / "id_ed25519").exists()


@pytest.mark.parametrize("user", ["root; touch /tmp/x", "-oProxyCommand=bad", "a@host", "a b", "../root", "", "a\nroot", "x" * 33, "Root", "root$", "a.b"])
async def test_reject_unsafe_users(api, user):
    with browser(api) as client:
        response = client.put("/api/ssh/config", json={"default_user": user, "per_server_user": {}, "targets": {}}, headers={"If-Match": ssh_store.config_etag()})
        assert response.status_code == 400
        assert client.put("/api/ssh/config", json={"default_user": "root", "per_server_user": {"local": user}, "targets": {}}, headers={"If-Match": ssh_store.config_etag()}).status_code == 400


async def test_legacy_mode_cannot_expose_ssh_without_accounts(api):
    api.settings.accounts_enabled = False
    async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://testserver") as client:
        for path in ("/api/ssh/status", "/api/ssh/key", "/api/ssh/sessions"):
            result = await client.get(path)
            assert result.status_code == 403
            assert result.json()["detail"] == "SSH terminal requires user accounts"
    with TestClient(api.app) as client:
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()):
                pass
        assert error.value.code == 4403


async def test_storage_restricts_permissions_and_sanitizes_corruption(api):
    ssh_store.write_config("root", {}, {}, expected_etag=ssh_store.config_etag())
    assert (api.directory / "config.json").exists()
    if os.name != "nt":
        assert api.directory.stat().st_mode & 0o777 == 0o700
        assert (api.directory / "config.json").stat().st_mode & 0o777 == 0o600
    (api.directory / "config.json").write_text("private malformed contents", encoding="utf-8")
    with pytest.raises(HTTPException) as error:
        ssh_store.read_config()
    assert error.value.status_code == 500
    assert "private malformed" not in error.value.detail


def public_key():
    return Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH)


async def test_storage_refuses_hardlinked_private_material(api, tmp_path):
    ssh_store.read_config()
    original = tmp_path / "do-not-read"
    original.write_text("not an SSH key", encoding="ascii")
    os.link(original, api.directory / "id_ed25519")
    with pytest.raises(HTTPException) as error:
        ssh_store.key_info()
    assert error.value.status_code == 500
    assert "not an SSH key" not in error.value.detail


async def test_session_limits_are_durable_and_release_after_end(api):
    async with api.factory() as db:
        first = await ssh_store.start_session(db, "operator", "local", "127.0.0.1", max_per_user=1, max_total=2,
            user_id="operator", user_name="Operator", client_ip="127.0.0.1", connected_ip="127.0.0.1")
    async with api.factory() as db:
        with pytest.raises(HTTPException) as error:
            await ssh_store.start_session(db, "operator", "local", "127.0.0.1", max_per_user=1, max_total=2)
        assert error.value.status_code == 429
        second = await ssh_store.start_session(db, "admin", "local", "127.0.0.1", max_total=2)
    async with api.factory() as db:
        with pytest.raises(HTTPException) as error:
            await ssh_store.start_session(db, "viewer", "local", "127.0.0.1", max_total=2)
        assert error.value.status_code == 429
        await ssh_store.end_session(db, first.id, "disconnected", 3, 5)
        await ssh_store.end_session(db, second.id, "idle_timeout", 0, 0)
        assert not (api.directory / f".session-{first.id}.lock").exists()
        assert not (api.directory / f".session-{second.id}.lock").exists()
        await ssh_store.start_session(db, "operator", "local", "127.0.0.1", max_per_user=1, max_total=2)
        rows = await ssh_store.list_sessions(db)
        ended = next(row for row in rows if row["id"] == first.id)
        assert ended["bytes_in"] == 3 and ended["bytes_out"] == 5
        assert ended["ended_at"] is not None
        assert ended["user_id"] == "operator" and ended["user_name"] == "Operator"
        assert ended["connected_ip"] == ended["client_ip"] == "127.0.0.1"
        assert ended["end_reason"] == "connection_failed"  # Arbitrary prose is never retained.


async def test_sessions_list_newest_200_metadata_only(api):
    async with api.factory() as db:
        for number in range(205):
            db.add(ssh_store.SshSession(user="operator", server_key="local", host="127.0.0.1",
                started_at=float(number), ended_at=float(number + 1), end_reason="closed", bytes_in=1, bytes_out=2))
        await db.commit()
    with browser(api) as client:
        rows = client.get("/api/ssh/sessions").json()
    assert len(rows) == 200
    assert rows[0]["id"] > rows[-1]["id"]
    assert set(rows[0]) == {"id", "user", "server_key", "host", "started_at", "ended_at", "end_reason", "bytes_in", "bytes_out", "event", "user_id", "user_name", "client_ip", "connected_ip", "host_key_fingerprint", "remote_user",
                            "key_source", "key_type", "key_name"}


async def test_bridge_drains_stdout_after_stderr_eof(api):
    class Reader:
        def __init__(self, data):
            self.data = data

        async def read(self, size):
            chunk, self.data = self.data[:size], self.data[size:]
            return chunk

    class Socket:
        def __init__(self):
            self.output = ""

        async def receive(self):
            await asyncio.Future()

        async def send_json(self, message):
            await asyncio.sleep(0)
            self.output += message["data"]

    socket = Socket()
    process = SimpleNamespace(stdout=Reader(b"x" * 100000), stderr=Reader(b""))
    counts = {"in": 0, "out": 0}
    reason = await ssh.bridge(socket, process, 30, {}, counts)
    assert reason in {"SSH session ended", "closed", "remote_closed"}
    assert len(socket.output) == counts["out"] == 100000


@pytest.fixture
def library():
    return pytest.importorskip("asyncssh", reason="asyncssh==2.17.0 unavailable; fake SSH integration needs this dependency")


@contextmanager
def fake_server(client, monkeypatch, library, *, host_key=None, reject_auth=False, target_host="127.0.0.1", accept=None):
    """Real AsyncSSH listener on a random loopback port; production still requests port 22.

    `accept`: the client public keys root may sign in with (default: the Lab Manager key, when generated)."""
    events = {"resizes": [], "ptys": [], "connections": 0, "offered": [], "shells": 0, "exec": [], "subsystems": [],
              "passwords": 0, "kbdint": 0, "forwards": 0}
    if accept is None:
        try:
            accept = [ssh_store.private_key().convert_to_public()]
        except HTTPException:
            accept = []
    accepted = {key.get_fingerprint() for key in accept}
    host_key = host_key or library.generate_private_key("ssh-ed25519")

    class Session(library.SSHServerSession):
        def connection_made(self, channel):
            self.channel = channel

        def pty_requested(self, term_type, term_size, term_modes):
            events["ptys"].append((term_type, term_size))
            return True

        def shell_requested(self):
            events["shells"] += 1
            return True

        def exec_requested(self, command):
            events["exec"].append(command)
            return False

        def subsystem_requested(self, subsystem):
            events["subsystems"].append(subsystem)
            return False

        def session_started(self):
            self.channel.write("ready\n")

        def data_received(self, data, datatype):
            if data == "exit":
                self.channel.exit(0)
            elif data == "burst":
                self.channel.write("z" * 100000)
                self.channel.exit(0)
            else:
                self.channel.write(data)

        def terminal_size_changed(self, width, height, pixwidth, pixheight):
            events["resizes"].append((width, height))

    class Server(library.SSHServer):
        def begin_auth(self, username):
            return True

        def public_key_auth_supported(self):
            return True

        def validate_public_key(self, username, key):
            offered = (key.get_algorithm(), key.get_fingerprint())
            if not events["offered"] or events["offered"][-1] != offered:
                events["offered"].append(offered)
            return not reject_auth and username == "root" and key.get_fingerprint() in accepted

        def password_auth_supported(self):
            return True  # Offered by the server; the client must never use it.

        def validate_password(self, username, password):
            events["passwords"] += 1
            return False

        def kbdint_auth_supported(self):
            return True

        def get_kbdint_challenge(self, username, lang, submethods):
            events["kbdint"] += 1
            return False

        def connection_requested(self, dest_host, dest_port, orig_host, orig_port):
            events["forwards"] += 1
            return False

        def server_requested(self, listen_host, listen_port):
            events["forwards"] += 1
            return False

        def session_requested(self):
            return Session()

    async def start():
        return await library.create_server(Server, "127.0.0.1", 0, server_host_keys=[host_key], line_editor=False)

    async def local_resolution(host):
        assert host == target_host
        return "127.0.0.1"

    monkeypatch.setattr(ssh, "resolve_target", local_resolution)
    listener = client.portal.call(start)
    real_connect = library.connect
    real_pin = ssh_store.pin_host

    def nonblocking_callback_pin(*args, **kwargs):
        assert kwargs.get("blocking") is False
        return real_pin(*args, **kwargs)

    monkeypatch.setattr(ssh_store, "pin_host", nonblocking_callback_pin)

    async def connect(host, *, port, **kwargs):
        assert host == "127.0.0.1" and port == 22
        assert kwargs["known_hosts"] is not None
        assert kwargs["config"] is None and kwargs["agent_path"] is None
        assert kwargs["x509_trusted_certs"] is None and kwargs["x509_trusted_cert_paths"] is None
        # No default key loading: keys come only from the terminal's explicit offer list (its client callback).
        assert kwargs["client_keys"] is None and kwargs["agent_identities"] is None and kwargs["pkcs11_provider"] is None
        assert kwargs["public_key_auth"] is True and kwargs["preferred_auth"] == "publickey"
        assert kwargs["username"] == "root"
        for flag in ("gss_auth", "gss_kex", "password_auth", "kbdint_auth", "host_based_auth", "agent_forwarding",
                     "x11_forwarding"):
            assert kwargs[flag] is False
        assert kwargs["connect_timeout"] > 0 and kwargs["login_timeout"] > 0
        events["connections"] += 1
        return await real_connect("127.0.0.1", listener.get_port(), **kwargs)

    monkeypatch.setattr(library, "connect", connect)
    try:
        yield events
    finally:
        monkeypatch.setattr(library, "connect", real_connect)
        monkeypatch.setattr(ssh_store, "pin_host", real_pin)
        # Close on the server's own event loop: asyncio.Server is not thread-safe, and closing it from the
        # test thread raced the loop's wake-up (TypeError in Server._wakeup, seen in SSH-INT under load).
        async def stop():
            listener.close()
            await listener.wait_closed()
        client.portal.call(stop)


async def test_key_generation_rotation_and_install_instructions(api, library, monkeypatch):
    async def local_resolution(host):
        assert host == "127.0.0.1"
        return "127.0.0.1"
    monkeypatch.setattr(ssh, "resolve_target", local_resolution)
    monkeypatch.setattr(ssh, "installation_source_ip", lambda target_ip: "127.0.0.1")
    with browser(api) as client:
        first = client.post("/api/ssh/key", json={"password": PASSWORD}).json()
        same = client.post("/api/ssh/key", json={"password": PASSWORD}).json()
        assert first["fingerprint"] == same["fingerprint"]
        assert first["public_key"].startswith("ssh-ed25519 ")
        assert "ssh -p 22 " in first["install"][0]["copy_command"]
        assert "IdentitiesOnly=yes" in first["install"][0]["copy_command"]
        assert "ssh-copy-id" not in json.dumps(first)
        assert "root@127.0.0.1" in first["install"][0]["copy_command"]
        # The local key path is absolute; "~/.ssh" inside the quoted remote command is the remote account's directory.
        argv = shlex.split(first["install"][0]["copy_command"])
        assert Path(argv[argv.index("-i") + 1]).is_absolute()
        for flag in ("from=", "no-agent-forwarding", "no-port-forwarding", "no-X11-forwarding", "no-user-rc"):
            assert flag in first["install"][0]["manual"]
        assert first["public_key"].strip() in first["install"][0]["manual"]
        assert "PRIVATE KEY" not in json.dumps(first)
        assert client.post("/api/ssh/key", json={"password": PASSWORD, "rotate": True}).status_code == 428
        assert client.post("/api/ssh/key", json={"password": PASSWORD, "rotate": True, "expected_fingerprint": "SHA256:stale"}).status_code == 412
        rotated = client.post("/api/ssh/key", json={"password": PASSWORD, "rotate": True, "expected_fingerprint": first["fingerprint"]}).json()
        assert rotated["fingerprint"] != first["fingerprint"]
        assert client.get("/api/ssh/key").json()["fingerprint"] == rotated["fingerprint"]
        assert first["fingerprint"] in json.dumps(rotated["revoke"])


async def test_real_terminal_input_resize_tofu_audit_and_remote_exit(api, library, monkeypatch):
    ssh_store.generate_key()
    ambient = api.directory.parent / "ambient-home" / ".ssh"
    ambient.mkdir(parents=True)
    (ambient / "config").write_text("Host *\n  Port 65000\n  IdentityFile ambient_id\n")
    (ambient / "id_ed25519").write_text("not the application key")
    monkeypatch.setenv("HOME", str(ambient.parent))
    monkeypatch.setenv("SSH_AUTH_SOCK", str(ambient.parent / "unused-agent"))
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library) as events:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as socket:
            authenticate(socket, client)
            assert "new host key pinned SHA256:" in until(socket, "connected")["reason"]
            assert socket.receive_json()["data"] == "ready\n"
            socket.send_json({"type": "resize", "cols": 120, "rows": 40})
            socket.send_json({"type": "input", "data": "hello שלום"})
            assert socket.receive_json()["data"] == "hello שלום"
            socket.send_json({"type": "input", "data": "exit"})
            assert until(socket, "closed")["reason"]
        assert events["ptys"][0][0] == "xterm-256color"
        assert (120, 40) in events["resizes"]
        assert ssh_store.host_info("local")["host_key_known"]
    async with api.factory() as db:
        rows = await ssh_store.list_sessions(db)
    rows = [row for row in rows if row["event"] == "terminal"]
    assert len(rows) == 1 and rows[0]["ended_at"]
    assert rows[0]["bytes_in"] == len("hello שלוםexit".encode())
    assert rows[0]["bytes_out"] == len("ready\nhello שלום".encode())
    assert rows[0]["user_id"] == "operator"
    assert rows[0]["connected_ip"] == "127.0.0.1"
    assert rows[0]["host_key_fingerprint"].startswith("SHA256:")
    assert rows[0]["remote_user"] == "root"
    assert "hello" not in json.dumps(rows)


async def test_real_terminal_drains_large_final_output(api, library, monkeypatch):
    ssh_store.generate_key()
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library):
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as socket:
            authenticate(socket, client)
            until(socket, "connected")
            assert socket.receive_json()["data"] == "ready\n"
            socket.send_json({"type": "input", "data": "burst"})
            output = ""
            while True:
                message = socket.receive_json()
                if message.get("state") == "closed":
                    break
                output += message.get("data", "")
            assert output == "z" * 100000


async def test_live_session_limits_reject_before_opening_second_connection(api, library, monkeypatch):
    ssh_store.generate_key()
    api.settings.ssh_max_sessions_per_user = 1
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library) as events:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as first:
            authenticate(first, client)
            until(first, "connected")
            with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as second:
                authenticate(second, client)
                assert "limit" in until(second, "closed")["reason"]
            assert events["connections"] == 1


def test_assistant_cannot_import_ssh_modules():
    directory = Path(ssh.__file__).resolve().parents[1] / "assistant"
    for source in directory.rglob("*.py"):
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                assert not any({"ssh", "ssh_store"}.intersection(alias.name.split(".")) for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                assert not {"ssh", "ssh_store"}.intersection((node.module or "").split("."))
                assert not any(alias.name in {"ssh", "ssh_store"} for alias in node.names)
    assert logging.getLogger("asyncssh").getEffectiveLevel() >= logging.WARNING


async def test_config_skips_a_server_the_vm_cannot_resolve_instead_of_failing_the_save(api, monkeypatch):
    async def no_dns(host):
        raise HTTPException(403, "SSH target could not be resolved safely")
    monkeypatch.setattr(ssh, "resolve_target", no_dns)
    with browser(api) as client:
        etag = client.get("/api/ssh/config").headers["etag"]
        body = {"default_user": "deployer", "per_server_user": {}, "targets": {"local": "127.0.0.1"}}
        saved = client.put("/api/ssh/config", json=body, headers={"If-Match": etag})
        assert saved.status_code == 200
        data = saved.json()
        assert data["default_user"] == "deployer" and data["targets"] == {}
        assert [item["key"] for item in data["skipped"]] == ["local"]
        assert "cannot find an IP address" in data["skipped"][0]["reason"]
        assert ssh_store.read_config()["targets"] == {}
        assert not client.get("/api/ssh/status").json()["servers"][0]["approved"]


async def test_config_etag_and_explicit_target_approval(api, monkeypatch):
    async def fake_resolution(host):
        assert host == "127.0.0.1"
        return "127.0.0.1"
    monkeypatch.setattr(ssh, "resolve_target", fake_resolution)
    with browser(api) as client:
        initial = client.get("/api/ssh/config")
        assert initial.status_code == 200
        assert initial.json() == {"default_user": "root", "per_server_user": {}, "targets": {"local": "127.0.0.1"},
                                  "auto_allow": False, "key_source": "vm", "denied": [], "auto_skipped": {}, "vm_keys": [],
                                  "denied_hosts": {}, "auto_hosts": {}}
        original = initial.headers["etag"]
        body = {"default_user": "deployer", "per_server_user": {"local": "operator"}, "targets": {"local": "127.0.0.1"}}
        assert client.put("/api/ssh/config", json=body).status_code == 428
        assert client.put("/api/ssh/config", json=body, headers={"If-Match": '"stale"'}).status_code == 412
        written = client.put("/api/ssh/config", json=body, headers={"If-Match": original})
        assert written.status_code == 200 and {name: written.json()[name] for name in body} == body
        assert written.headers["etag"] != original
        assert client.put("/api/ssh/config", json=body, headers={"If-Match": original}).status_code == 412
        assert client.get("/api/ssh/status").json()["servers"][0]["user"] == "operator"
        assert client.put("/api/ssh/config", json={**body, "targets": {}}, headers={"If-Match": written.headers["etag"]}).status_code == 200
        assert not client.get("/api/ssh/status").json()["servers"][0]["approved"]
    async with api.factory() as db:
        server = await ssh.target_for(db, "local")
    with pytest.raises(HTTPException) as error:
        ssh.approved_host(server, ssh_store.read_config())
    assert error.value.status_code == 403


@pytest.mark.parametrize("change", [
    {"host": "127.0.0.1"}, {"port": 2222}, {"per_server_user": {"unlisted": "root"}},
    {"targets": {"unlisted": "local.example"}}, {"targets": {"rack/server": "local.example"}},
    {"targets": {"local": "-bad"}}, {"targets": {"local": "ssh://localhost"}},
    {"targets": {"local": "localhost:22"}}, {"targets": {"local": "a b"}},
    {"targets": {"local": "different.example"}},
])
async def test_config_rejects_freeform_host_port_or_unlisted_identity(api, change):
    with browser(api) as client:
        body = {"default_user": "root", "per_server_user": {}, "targets": {"local": "127.0.0.1"}}
        result = client.put("/api/ssh/config", json={**body, **change}, headers={"If-Match": ssh_store.config_etag()})
        assert result.status_code == 400
        assert {name: value for name, value in ssh_store.read_config().items() if name in body} == body


@pytest.mark.parametrize("kind", ["anonymous", "viewer", "cross-origin", "missing-origin", "no-csrf", "bad-csrf", "binary", "oversize"])
async def test_websocket_guards_before_loading_ssh(api, kind, monkeypatch):
    def forbidden():
        pytest.fail("Unauthorized websocket reached SSH dependency loading")
    monkeypatch.setattr(ssh_store, "load_asyncssh", forbidden)
    with browser(api, "viewer" if kind == "viewer" else "operator") as client:
        headers = socket_headers()
        if kind == "anonymous":
            client.cookies.clear()
        elif kind == "cross-origin":
            headers["Origin"] = "https://foreign.example"
        elif kind == "missing-origin":
            headers = {}
        if kind in {"anonymous", "viewer", "cross-origin", "missing-origin"}:
            with pytest.raises(WebSocketDisconnect) as error:
                with client.websocket_connect("/api/ssh/local/terminal", headers=headers):
                    pass
            assert error.value.code in {4401, 4403}
        else:
            with client.websocket_connect("/api/ssh/local/terminal", headers=headers) as sock:
                if kind == "binary":
                    sock.send_bytes(b"bad")
                elif kind == "oversize":
                    sock.send_text("x" * (ssh.MAX_MESSAGE + 1))
                else:
                    sock.send_json({"type": "input", "data": "unused", "csrf_token": "bad" if kind == "bad-csrf" else ""})
                assert "CSRF" in until(sock, "closed")["reason"]
                with pytest.raises(WebSocketDisconnect) as error:
                    sock.receive_json()
                assert error.value.code == 4403


async def test_transport_requires_explicit_optin_before_websocket_accept(api, monkeypatch):
    api.settings.ssh_allow_insecure_transport = False
    def forbidden():
        pytest.fail("Transport without opt-in reached SSH dependency loading")
    monkeypatch.setattr(ssh_store, "load_asyncssh", forbidden)
    with browser(api, "operator") as client:
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()):
                pass
        assert error.value.code == 4403
        assert "SSH_ALLOW_INSECURE_TRANSPORT" in error.value.reason


@pytest.mark.parametrize("query", ["host=127.0.0.1", "port=22", "input=whoami", "csrf_token=unused"])
async def test_terminal_refuses_connection_and_command_url_parameters(api, query, monkeypatch):
    def forbidden():
        pytest.fail("Terminal URL parameter reached SSH dependency loading")
    monkeypatch.setattr(ssh_store, "load_asyncssh", forbidden)
    with browser(api, "operator") as client:
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect(f"/api/ssh/local/terminal?{query}", headers=socket_headers()):
                pass
        assert error.value.code == 4403
        assert "URL" in error.value.reason


async def test_status_reports_transport_block_and_viewer_redaction(api):
    api.settings.ssh_allow_insecure_transport = False
    with browser(api, "viewer") as client:
        result = client.get("/api/ssh/status").json()
    assert result["available"] is False and result["transport_allowed"] is False
    assert "SSH_ALLOW_INSECURE_TRANSPORT" in result["blocked_reason"]
    assert "default_user" not in result
    assert not {"host", "user", "approved_host"}.intersection(result["servers"][0])


async def test_saved_slash_labels_map_to_slug_and_collisions_are_excluded(api):
    async with api.factory() as db:
        db.add(PingTarget(id="slash", source_key="server:rack/server", name="Slashed", host="127.0.0.1"))
        await db.commit()
        servers = await ssh_store.known_servers(db)
        slashed = next(item for item in servers if item["name"] == "Slashed")
        assert "/" not in slashed["key"] and ssh.SLUG.fullmatch(slashed["key"])
        db.add(PingTarget(id="collision", source_key="server:" + slashed["key"], name="Collision", host="127.0.0.1"))
        await db.commit()
        assert slashed["key"] not in {item["key"] for item in await ssh_store.known_servers(db)}


async def test_tofu_is_json_keyed_by_server_and_accept_uses_cas(api):
    first, changed = public_key(), public_key()
    assert ssh_store.pin_host("local", "127.0.0.1", first)
    initial = ssh_store.host_info("local")
    assert initial["host_key_known"] and not initial["confirmed"]
    assert not ssh_store.pin_host("local", "127.0.0.1", first)
    assert ssh_store.pin_host("another", "127.0.0.1", changed)
    with pytest.raises(ssh_store.HostKeyChanged):
        ssh_store.pin_host("local", "127.0.0.1", changed)
    offered = ssh_store.host_info("local")["offered_fingerprint"]
    assert offered and offered != initial["fingerprint"]
    with pytest.raises(HTTPException) as error:
        ssh_store.accept_host("local", "SHA256:stale", offered)
    assert error.value.status_code == 412
    with pytest.raises(HTTPException):
        ssh_store.accept_host("local", initial["fingerprint"], "SHA256:not-offered")
    accepted = ssh_store.accept_host("local", initial["fingerprint"], offered)
    assert accepted["fingerprint"] == offered and accepted["confirmed"]
    assert not ssh_store.pin_host("local", "127.0.0.1", changed)
    assert ssh_store.host_info("another")["host_key_known"]
    assert isinstance(json.loads((api.directory / "host_pins.json").read_text()), dict)
    assert (api.directory / ".gitignore").read_text() == "*\n"


async def test_host_accept_requires_password_and_old_and_offered_fingerprints(api):
    ssh_store.pin_host("local", "127.0.0.1", public_key())
    old = ssh_store.host_info("local")["fingerprint"]
    with pytest.raises(ssh_store.HostKeyChanged):
        ssh_store.pin_host("local", "127.0.0.1", public_key())
    new = ssh_store.host_info("local")["offered_fingerprint"]
    body = {"password": PASSWORD, "expected_fingerprint": old, "fingerprint": new}
    with browser(api) as client:
        assert client.post("/api/ssh/hosts/local/forget", json={"password": PASSWORD}).status_code in {404, 410}
        assert client.post("/api/ssh/hosts/local/accept", json={**body, "password": "wrong"}).status_code == 403
        assert client.post("/api/ssh/hosts/local/accept", json={**body, "expected_fingerprint": "SHA256:stale"}).status_code == 412
        assert client.post("/api/ssh/hosts/local/accept", json=body).status_code == 200
    assert ssh_store.host_info("local")["fingerprint"] == new


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "169.254.1.2", "fe80::1", "0.0.0.0", "::", "224.0.0.1", "ff02::1"])
async def test_resolver_refuses_unsafe_ips_without_dns_or_connections(host, monkeypatch):
    monkeypatch.setattr(ssh, "local_addresses", lambda: {"127.0.0.1", "::1"})
    with pytest.raises(HTTPException) as error:
        await ssh.resolve_target(host)
    assert error.value.status_code == 403


async def test_resolver_checks_dns_once_and_refuses_own_vm_address(monkeypatch):
    # Synthetic documentation IP; DNS is stubbed and there are no outbound sockets.
    address = "192.0.2.17"
    monkeypatch.setattr(ssh, "local_addresses", lambda: {address})
    calls = []
    async def addresses(host, port, **kwargs):
        calls.append((host, port))
        return [(socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", (address, 22))]
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", addresses)
    with pytest.raises(HTTPException) as error:
        await ssh.resolve_target("local.example")
    assert error.value.status_code == 403
    assert calls == [("local.example", 22)]


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission modes are unavailable on Windows")
async def test_storage_refuses_insecure_file_and_directory_modes(api):
    config = api.directory / "config.json"
    assert config.stat().st_mode & 0o777 == 0o600
    assert api.directory.stat().st_mode & 0o777 == 0o700
    config.chmod(0o644)
    with pytest.raises(HTTPException):
        ssh_store.read_config()
    config.chmod(0o600)
    api.directory.chmod(0o755)
    try:
        with pytest.raises(HTTPException):
            ssh_store.read_config()
    finally:
        api.directory.chmod(0o700)


async def test_storage_refuses_private_key_symlink(api, tmp_path):
    original = tmp_path / "target-file"
    original.write_text("must not be read", encoding="ascii")
    try:
        (api.directory / "id_ed25519").symlink_to(original)
    except OSError:
        pytest.skip("Creating symbolic links requires unavailable Windows privileges")
    with pytest.raises(HTTPException):
        ssh_store.key_info()
    assert original.read_text() == "must not be read"


@pytest.mark.parametrize("failure", ["authentication", "timeout", "invalid-message", "oversize-resize", "idle", "revoked", "disabled-user", "demoted", "must-change", "disconnect"])
async def test_terminal_failures_finalize_audit(api, library, monkeypatch, failure):
    ssh_store.generate_key()
    monkeypatch.setattr(ssh, "SESSION_CHECK_SECONDS", 0.02)
    if failure == "idle":
        api.settings.ssh_idle_timeout_seconds = 0.05
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library, reject_auth=failure == "authentication"):
        if failure == "timeout":
            async def stalled(*args, **kwargs):
                await asyncio.sleep(30)
            monkeypatch.setattr(library, "connect", stalled)
            api.settings.ssh_connect_timeout_seconds = 0.05
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            if failure not in {"authentication", "timeout"}:
                until(sock, "connected")
                sock.receive_json()
                if failure == "invalid-message":
                    sock.send_json({"type": "resize", "cols": True, "rows": 24})
                elif failure == "oversize-resize":
                    sock.send_json({"type": "resize", "cols": 501, "rows": 201})
                elif failure in {"revoked", "disabled-user", "demoted", "must-change"}:
                    async def revoke():
                        async with api.factory() as db:
                            if failure == "revoked":
                                await db.execute(delete(UserSession))
                            else:
                                fields = {"disabled-user": {"enabled": False}, "demoted": {"role": "Viewer"}, "must-change": {"must_change_password": True}}[failure]
                                await db.execute(update(User).where(User.id == "operator").values(**fields))
                            await db.commit()
                    client.portal.call(revoke)
            if failure != "disconnect":
                assert until(sock, "closed")["reason"]
    async with api.factory() as db:
        rows = [row for row in await ssh_store.list_sessions(db) if row["event"] == "terminal"]
    assert len(rows) == 1 and rows[0]["ended_at"]
    assert rows[0]["end_reason"] in ssh_store.END_REASONS
    assert "password" not in json.dumps(rows)


class PendingReader:
    async def read(self, size):
        await asyncio.Future()


class BridgeSocket:
    def __init__(self, messages=(), delay=0):
        self.messages = iter(messages)
        self.delay = delay
        self.output = ""

    async def receive(self):
        if self.delay:
            await asyncio.sleep(self.delay)
        try:
            message = next(self.messages)
        except StopIteration:
            await asyncio.Future()
        return {"type": "websocket.receive", "text": json.dumps(message)}

    async def send_json(self, message):
        self.output += message.get("data", "")
        await asyncio.sleep(0)


class Sink:
    def __init__(self):
        self.data = b""

    def write(self, data):
        self.data += data

    async def drain(self):
        pass


def bridge_process(stdout=None):
    return SimpleNamespace(stdin=Sink(), stdout=stdout or PendingReader(), stderr=PendingReader(),
                           change_terminal_size=lambda cols, rows: None)


async def test_remote_output_and_resizes_do_not_extend_idle_deadline(api, monkeypatch):
    class ChattyReader:
        async def read(self, size):
            await asyncio.sleep(0.001)
            return b"still writing"
    async def valid(*args):
        return True
    monkeypatch.setattr(ssh, "session_valid", valid)
    monkeypatch.setattr(ssh, "SESSION_CHECK_SECONDS", 0.01)
    sock = BridgeSocket([{"type": "resize", "cols": 80, "rows": 24}] * 30, delay=0.002)
    counts = {"in": 0, "out": 0}
    result = await asyncio.wait_for(ssh.bridge(sock, bridge_process(ChattyReader()), .03, {}, counts), .5)
    assert result == "idle_timeout"
    assert counts["in"] == 0 and counts["out"] > 0


async def test_max_lifetime_applies_despite_repeated_client_input(api, monkeypatch):
    async def valid(*args):
        return True
    monkeypatch.setattr(ssh, "session_valid", valid)
    monkeypatch.setattr(ssh, "SESSION_CHECK_SECONDS", 0.005)
    sock = BridgeSocket([{"type": "input", "data": "x"}] * 100, delay=0.002)
    counts = {"in": 0, "out": 0}
    result = await asyncio.wait_for(ssh.bridge(sock, bridge_process(), .02, {}, counts, max_seconds=.035), .5)
    assert result == "lifetime_limit" and counts["in"] > 1


async def test_session_is_revalidated_without_client_messages(api, monkeypatch):
    calls = []
    async def revoked(*args):
        calls.append(time.monotonic())
        return False
    monkeypatch.setattr(ssh, "session_valid", revoked)
    monkeypatch.setattr(ssh, "SESSION_CHECK_SECONDS", 0.01)
    result = await asyncio.wait_for(ssh.bridge(BridgeSocket(), bridge_process(), 1, {}, {"in": 0, "out": 0}), .5)
    assert result == "session_expired" and len(calls) == 1


@pytest.mark.parametrize("message", [
    {"type": "resize", "cols": True, "rows": 24}, {"type": "resize", "cols": 501, "rows": 24},
    {"type": "resize", "cols": 80, "rows": 201}, {"type": "resize", "cols": 0, "rows": 1},
    {"type": "input", "data": "x" * 65537}, {"type": "input", "data": "ok", "host": "127.0.0.1"},
    {"type": "input", "data": "ok", "port": 22},
])
async def test_bridge_rejects_invalid_sizes_inputs_and_connection_arguments(api, message):
    with pytest.raises(ValueError, match="invalid_message"):
        await ssh.bridge(BridgeSocket([message]), bridge_process(), 30, {}, {"in": 0, "out": 0})


async def test_input_bucket_caps_burst_bytes(api):
    process = bridge_process()
    counts = {"in": 0, "out": 0}
    sock = BridgeSocket([{"type": "input", "data": "x" * 65536}] * 4)
    result = await ssh.bridge(sock, process, 30, {}, counts)
    assert result == "input_rate_limit"
    assert 0 < counts["in"] <= 65536 * 2
    assert len(process.stdin.data) == counts["in"]


async def test_incremental_utf8_decoder_keeps_split_characters_and_replaces_invalid_bytes(api):
    class Chunks:
        def __init__(self, chunks):
            self.chunks = iter(chunks)

        async def read(self, size):
            return next(self.chunks, b"")
    process = bridge_process(Chunks([b"\xe2", b"\x82\xac", b"\xff"]))
    process.stderr = Chunks([])
    sock = BridgeSocket()
    counts = {"in": 0, "out": 0}
    assert await ssh.bridge(sock, process, 30, {}, counts) == "remote_closed"
    assert sock.output == "€�" and counts["out"] == 4


async def test_connection_rate_is_per_user_and_server(api):
    async with api.factory() as db:
        for _ in range(2):
            row = await ssh_store.start_session(db, "operator", "local", "127.0.0.1", max_connects_per_minute=2)
            await ssh_store.end_session(db, row.id, "remote_closed", 0, 0)
        with pytest.raises(HTTPException) as error:
            await ssh_store.start_session(db, "operator", "local", "127.0.0.1", max_connects_per_minute=2)
        assert error.value.status_code == 429 and "rate" in error.value.detail.lower()
        await ssh_store.start_session(db, "admin", "local", "127.0.0.1", max_connects_per_minute=2)
        await ssh_store.start_session(db, "operator", "other", "127.0.0.1", max_connects_per_minute=2)


async def test_abandoned_audit_reservation_does_not_consume_capacity(api):
    async with api.factory() as db:
        orphan = ssh_store.SshSession(user="operator", server_key="local", host="127.0.0.1", started_at=1.)
        db.add(orphan)
        await db.commit()
        row = await ssh_store.start_session(db, "operator", "local", "127.0.0.1", max_per_user=1, max_total=1)
        audits = await ssh_store.list_sessions(db)
        stale = next(item for item in audits if item["id"] == orphan.id)
        assert stale["end_reason"] == "service_interrupted" and stale["ended_at"]
        await ssh_store.end_session(db, row.id, "remote_closed", 0, 0)


@pytest.mark.parametrize("kind", ["anonymous-http", "anonymous-ws", "foreign-http", "foreign-ws",
    "cookie-foreign-http", "cookie-foreign-ws", "role", "csrf-http", "csrf-ws"])
async def test_round2_denials_only_persist_for_signed_in_same_origin_users(api, kind):
    role = "viewer" if kind == "role" else "admin" if kind == "csrf-http" else "operator"
    with browser(api, role) as client:
        if kind.startswith("anonymous") or kind.startswith("foreign"):
            client.cookies.clear()
        headers = {"Origin": "https://foreign.example" if "foreign" in kind else "http://testserver"}
        if kind.endswith("ws"):
            if kind == "csrf-ws":
                with client.websocket_connect("/api/ssh/local/terminal", headers=headers) as sock:
                    sock.send_json({"type": "auth", "csrf_token": "invalid"})
                    assert "CSRF" in until(sock, "closed")["reason"]
            else:
                with pytest.raises(WebSocketDisconnect):
                    with client.websocket_connect("/api/ssh/local/terminal", headers=headers):
                        pass
        elif kind == "role":
            assert client.get("/api/ssh/key", headers=headers).status_code == 403
        else:
            if kind == "csrf-http":
                del client.headers["X-DCIM-CSRF"]
            response = client.post("/api/ssh/key", json={"password": PASSWORD}, headers=headers)
            assert response.status_code in {401, 403}
    async with api.factory() as db:
        rows = (await db.execute(select(ssh_store.SshSession).where(ssh_store.SshSession.event == "denied"))).scalars().all()
    if kind in {"role", "csrf-http", "csrf-ws"}:
        assert len(rows) == 1 and rows[0].user == role and rows[0].end_reason == "denied"
    else:
        assert rows == []


async def test_round2_denial_history_cannot_evict_terminal_and_admin_history(api):
    async with api.factory() as db:
        for number in range(3):
            db.add(ssh_store.SshSession(user="operator", event="terminal", server_key="local", host="127.0.0.1",
                started_at=float(number), ended_at=float(number + 1), end_reason="remote_closed"))
        db.add(ssh_store.SshSession(user="admin", event="config_updated", server_key="", host="",
            started_at=4., ended_at=5., end_reason="admin_action"))
        for number in range(205):
            db.add(ssh_store.SshSession(user="viewer", event="denied", server_key="local", host="127.0.0.1",
                started_at=float(number + 10), ended_at=float(number + 11), end_reason="denied"))
        await db.commit()
    with browser(api) as client:
        history = client.get("/api/ssh/sessions").json()
        denials = client.get("/api/ssh/sessions?denials=true").json()
    assert len(history) == 4 and all(row["event"] != "denied" for row in history)
    assert sum(row["event"] == "terminal" for row in history) == 3
    assert len(denials) == 200 and all(row["event"] == "denied" for row in denials)


async def test_round2_revocation_read_owns_and_closes_its_transaction(api, monkeypatch):
    async with api.factory() as db:
        row = await ssh_store.start_session(db, "operator", "local", "127.0.0.1")
    captured = []
    @asynccontextmanager
    async def tracked_factory():
        async with api.factory() as read_db:
            captured.append(read_db)
            yield read_db
    monkeypatch.setattr(ssh_store, "AsyncSessionLocal", tracked_factory)
    assert await ssh_store.session_revoked(row.id) is False
    assert len(captured) == 1 and captured[0].in_transaction() is False
    async with api.factory() as db:
        await ssh_store.revoke_sessions(db)
    assert await ssh_store.session_revoked(row.id) is True
    assert len(captured) == 2 and all(db.in_transaction() is False for db in captured)


def test_round2_terminal_has_no_request_lifetime_database_dependency():
    route = next(route for route in ssh.router.routes if route.path == "/api/ssh/{key}/terminal")
    assert not route.dependant.dependencies


async def test_round2_terminal_database_contexts_close_before_ssh_io(api, library, monkeypatch):
    ssh_store.generate_key()
    captured = []
    @asynccontextmanager
    async def tracked_factory():
        async with api.factory() as short_db:
            captured.append(short_db)
            yield short_db
    monkeypatch.setattr(ssh, "AsyncSessionLocal", tracked_factory)
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library):
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            until(sock, "connected")
            assert captured
            assert all(db.in_transaction() is False for db in captured)
            sock.send_json({"type": "input", "data": "exit"})
            until(sock, "closed")
    assert all(db.in_transaction() is False for db in captured)


async def test_round2_final_audit_retries_once_using_a_fresh_session(api, monkeypatch):
    async with api.factory() as db:
        row = await ssh_store.start_session(db, "operator", "local", "127.0.0.1")
    attempts, retries = [], []
    @asynccontextmanager
    async def retry_factory():
        async with api.factory() as retry_db:
            retries.append(retry_db)
            yield retry_db
    monkeypatch.setattr(ssh_store, "AsyncSessionLocal", retry_factory)
    async with api.factory() as broken_db:
        async def failed_commit():
            attempts.append("first")
            raise SQLAlchemyError("injected audit write failure")
        monkeypatch.setattr(broken_db, "commit", failed_commit)
        assert await ssh_store.end_session(broken_db, row.id, "remote_closed", 7, 11) is True
        assert broken_db.in_transaction() is False
    assert attempts == ["first"] and len(retries) == 1
    assert retries[0] is not broken_db and retries[0].in_transaction() is False
    assert not (api.directory / f".session-{row.id}.lock").exists()
    async with api.factory() as db:
        saved = await db.get(ssh_store.SshSession, row.id)
    assert saved.ended_at and saved.bytes_in == 7 and saved.bytes_out == 11


async def test_round2_final_audit_releases_lease_after_both_writes_fail(api, monkeypatch):
    async with api.factory() as db:
        row = await ssh_store.start_session(db, "operator", "local", "127.0.0.1")
    attempts = []
    async def failed_commit():
        attempts.append("write")
        raise SQLAlchemyError("injected audit write failure")
    @asynccontextmanager
    async def broken_factory():
        async with api.factory() as retry_db:
            monkeypatch.setattr(retry_db, "commit", failed_commit)
            yield retry_db
    monkeypatch.setattr(ssh_store, "AsyncSessionLocal", broken_factory)
    async with api.factory() as broken_db:
        monkeypatch.setattr(broken_db, "commit", failed_commit)
        assert await ssh_store.end_session(broken_db, row.id, "remote_closed", 7, 11) is False
        assert broken_db.in_transaction() is False
    assert attempts == ["write", "write"]
    assert ssh_store._session_lock_key(api.directory, row.id) not in ssh_store._SESSION_LOCKS
    assert not (api.directory / f".session-{row.id}.lock").exists()


async def test_round2_websocket_still_closes_if_final_audit_raises(api, library, monkeypatch):
    ssh_store.generate_key()
    real_end = ssh_store.end_session
    finalized = []
    async def failed_finalize(*args, **kwargs):
        await real_end(*args, **kwargs)
        finalized.append(True)
        raise SQLAlchemyError("injected finalizer failure")
    with monkeypatch.context() as patch:
        patch.setattr(ssh_store, "end_session", failed_finalize)
        with browser(api, "operator") as client, fake_server(client, monkeypatch, library):
            with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
                authenticate(sock, client)
                until(sock, "connected")
                sock.send_json({"type": "input", "data": "exit"})
                assert until(sock, "closed")["reason"] == "SSH session ended"
                with pytest.raises(WebSocketDisconnect):
                    sock.receive_json()
    assert finalized == [True]


@pytest.mark.parametrize("failure", ["dns", "route"])
async def test_round2_key_instructions_remain_available_for_unresolvable_approved_targets(api, library, monkeypatch, failure):
    async def unavailable_resolution(host):
        assert host == "127.0.0.1"
        if failure == "dns":
            raise HTTPException(403, "Synthetic DNS failure")
        return "127.0.0.1"
    def unavailable_route(address):
        raise OSError("Synthetic route unavailable")
    monkeypatch.setattr(ssh, "resolve_target", unavailable_resolution)
    monkeypatch.setattr(ssh, "installation_source_ip", unavailable_route)
    with browser(api) as client:
        generated = client.post("/api/ssh/key", json={"password": PASSWORD})
        fetched = client.get("/api/ssh/key")
        assert generated.status_code == fetched.status_code == 200
        rotated = client.post("/api/ssh/key", json={"password": PASSWORD, "rotate": True,
            "expected_fingerprint": generated.json()["fingerprint"]})
    for response in (generated, fetched, rotated):
        assert response.status_code == 200
        instruction = response.json()["install"][0]
        assert instruction["source_ip"] == "<VM IP>"
        assert instruction["reason"] == "Cannot determine the VM source address for this target; verify and replace <VM IP>"
        assert 'from="<VM IP>"' in instruction["manual"]
    assert rotated.json()["fingerprint"] != generated.json()["fingerprint"]


async def test_round2_legacy_json_pins_migrate_without_changing_trust(api):
    ssh_store.pin_host("local", "127.0.0.1", public_key())
    expected = ssh_store.host_info("local")
    modern = api.directory / "host_pins.json"
    legacy = api.directory / "known_hosts"
    modern.replace(legacy)
    assert ssh_store.host_info("local") == expected
    assert modern.exists() and not legacy.exists()
    assert ssh_store.host_info("local") == expected


async def test_round2_unsafe_or_conflicting_legacy_pin_data_is_refused(api):
    ssh_store.pin_host("local", "127.0.0.1", public_key())
    legacy = api.directory / "known_hosts"
    legacy.write_text("not valid JSON", encoding="utf-8")
    with pytest.raises(HTTPException):
        ssh_store.host_info("local")
    legacy.unlink()
    assert ssh_store.host_info("local")["host_key_known"]


async def test_round2_conflicting_valid_legacy_pins_fail_closed(api):
    ssh_store.pin_host("local", "127.0.0.1", public_key())
    modern = api.directory / "host_pins.json"
    original = modern.read_bytes()
    legacy = api.directory / "known_hosts"
    legacy.write_text("{}\n", encoding="utf-8")
    if os.name != "nt":
        legacy.chmod(0o600)
    with pytest.raises(HTTPException):
        ssh_store.host_info("local")
    assert modern.read_bytes() == original and legacy.exists()


async def test_round2_identical_legacy_and_modern_pins_remove_legacy_copy(api):
    ssh_store.pin_host("local", "127.0.0.1", public_key())
    modern = api.directory / "host_pins.json"
    expected = ssh_store.host_info("local")
    legacy = api.directory / "known_hosts"
    legacy.write_bytes(modern.read_bytes())
    if os.name != "nt":
        legacy.chmod(0o600)
    assert ssh_store.host_info("local") == expected
    assert not legacy.exists()


async def test_round2_ipv6_socket_unavailable_falls_back_to_checked_ipv4(monkeypatch):
    import errno
    ipv6, ipv4 = "2001:db8::17", "192.0.2.17"
    monkeypatch.setattr(ssh, "local_addresses", lambda: {"127.0.0.1", "::1"})
    calls, probes = [], []
    async def answers(host, port, **kwargs):
        calls.append((host, port))
        return [(socket_module.AF_INET6, socket_module.SOCK_STREAM, 6, "", (ipv6, 22, 0, 0)),
                (socket_module.AF_INET, socket_module.SOCK_STREAM, 6, "", (ipv4, 22))]
    class NonlocalIPv4Probe:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def bind(self, address):
            probes.append(address)
            raise OSError(errno.EADDRNOTAVAIL, "synthetic nonlocal address")
    def sockets(family, kind, *args, **kwargs):
        assert kind == socket_module.SOCK_DGRAM
        if family == socket_module.AF_INET6:
            raise OSError(errno.EAFNOSUPPORT, "synthetic unavailable IPv6")
        assert family == socket_module.AF_INET
        return NonlocalIPv4Probe()
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", answers)
    # Replace only the router's socket reference. Replacing the global socket
    # class breaks the Windows asyncio loop's own socket type checks.
    monkeypatch.setattr(ssh, "socket", SimpleNamespace(socket=sockets,
        AF_INET=socket_module.AF_INET, AF_INET6=socket_module.AF_INET6,
        SOCK_DGRAM=socket_module.SOCK_DGRAM, SOCK_STREAM=socket_module.SOCK_STREAM))
    assert await ssh.resolve_target("local.example") == ipv4
    assert calls == [("local.example", 22)] and probes == [(ipv4, 0)]


def test_round3_approval_matches_the_current_validated_inventory_host():
    config = {"targets": {"local": "localhost"}}
    assert ssh.approved_host({"key": "local", "host": "LOCALHOST"}, config) == "localhost"
    with pytest.raises(HTTPException) as error:
        ssh.approved_host({"key": "local", "host": "127.0.0.1"}, config)
    assert error.value.status_code == 403
    assert error.value.detail == "Server address changed - an Admin must approve it again"


async def test_round3_stale_approval_blocks_connection_until_admin_reapproves(api, library, monkeypatch):
    ssh_store.generate_key()
    async with api.factory() as db:
        await db.execute(update(PingTarget).where(PingTarget.id == "saved").values(host="localhost"))
        await db.commit()
    monkeypatch.setattr(ssh, "installation_source_ip", lambda address: "127.0.0.1")
    with browser(api) as client, fake_server(client, monkeypatch, library, target_host="localhost") as events:
        server = client.get("/api/ssh/status").json()["servers"][0]
        assert not server["allowed"] and not server["approved"] and server["address_changed"]
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            assert until(sock, "closed")["reason"] == "Server address changed - an Admin must approve it again"
        assert events["connections"] == 0
        # Changing inventory must leave key management available, including S5's fallback row.
        for response in (client.get("/api/ssh/key"), client.post("/api/ssh/key", json={"password": PASSWORD})):
            assert response.status_code == 200
            instruction = response.json()["install"][0]
            assert instruction["source_ip"] == "<VM IP>"
            assert instruction["reason"] == "Server address changed - an Admin must approve it again"
        config = client.get("/api/ssh/config")
        body = {**config.json(), "targets": {"local": "localhost"}}
        assert client.put("/api/ssh/config", json=body, headers={"If-Match": config.headers["etag"]}).status_code == 200
        server = client.get("/api/ssh/status").json()["servers"][0]
        assert server["allowed"] and server["approved"] and not server["address_changed"]
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            until(sock, "connected")
            sock.send_json({"type": "input", "data": "exit"})
            until(sock, "closed")
        assert events["connections"] == 1


class FlowReader:
    def __init__(self):
        self.chunks = asyncio.Queue()
        self.started = asyncio.Event()
        self.reads = 0

    async def read(self, size):
        self.reads += 1
        self.started.set()
        return await self.chunks.get()


class FlowSocket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.output = []
        self.sending = 0
        self.max_sending = 0

    def push(self, message):
        self.messages.put_nowait(message)

    async def receive(self):
        return {"type": "websocket.receive", "text": json.dumps(await self.messages.get())}

    async def send_json(self, message):
        self.sending += 1
        self.max_sending = max(self.max_sending, self.sending)
        try:
            await asyncio.sleep(0.001)
            self.output.append(message["data"])
        finally:
            self.sending -= 1


def flow_process():
    resized = asyncio.Event()
    process = SimpleNamespace(stdin=Sink(), stdout=FlowReader(), stderr=FlowReader(),
        change_terminal_size=lambda cols, rows: resized.set())
    return process, resized


async def test_round3_pause_prevents_new_reads_and_resume_preserves_utf8_and_eof(api):
    sock, counts = FlowSocket(), {"in": 0, "out": 0}
    process, resized = flow_process()
    sock.push({"type": "pause"})
    sock.push({"type": "resize", "cols": 80, "rows": 24})
    process.stdout.chunks.put_nowait(b"\xe2")
    task = asyncio.create_task(ssh.bridge(sock, process, 1, {}, counts))
    try:
        await asyncio.wait_for(resized.wait(), .5)
        await asyncio.sleep(.02)
        assert process.stdout.reads == process.stderr.reads == 0
        assert sock.output == [] and not task.done()
        sock.push({"type": "resume"})
        async def partial_character_buffered():
            while process.stdout.reads < 2 or process.stderr.reads < 1:
                await asyncio.sleep(0)
        await asyncio.wait_for(partial_character_buffered(), .5)
        resized.clear()
        sock.push({"type": "pause"})
        sock.push({"type": "resize", "cols": 80, "rows": 24})
        await asyncio.wait_for(resized.wait(), .5)
        for chunk in (b"\x82\xac", b"\xff", b"\xe2", b""):
            process.stdout.chunks.put_nowait(chunk)
        process.stderr.chunks.put_nowait(b"")
        await asyncio.sleep(.02)
        assert process.stdout.reads == 2 and process.stderr.reads == 1
        sock.push({"type": "resume"})
        assert await asyncio.wait_for(task, .5) == "remote_closed"
        assert "".join(sock.output) == "€��" and counts["out"] == 5
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_round3_pause_bounds_inflight_chunks_and_serializes_both_streams(api):
    sock, counts = FlowSocket(), {"in": 0, "out": 0}
    process, resized = flow_process()
    task = asyncio.create_task(ssh.bridge(sock, process, 1, {}, counts))
    try:
        await asyncio.wait_for(asyncio.gather(process.stdout.started.wait(), process.stderr.started.wait()), .5)
        sock.push({"type": "pause"})
        sock.push({"type": "resize", "cols": 80, "rows": 24})
        await asyncio.wait_for(resized.wait(), .5)
        for reader, prefix in ((process.stdout, b"out"), (process.stderr, b"err")):
            for chunk in (prefix + b"1", prefix + b"2", b""):
                reader.chunks.put_nowait(chunk)
        await asyncio.sleep(.02)
        assert process.stdout.reads == process.stderr.reads == 1
        assert sock.output == [] and sock.max_sending <= 1
        sock.push({"type": "resume"})
        assert await asyncio.wait_for(task, .5) == "remote_closed"
        assert sorted(sock.output) == ["err1", "err2", "out1", "out2"]
        assert counts["out"] == 16 and sock.max_sending == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_round3_input_resize_and_session_revocation_work_while_paused(api, monkeypatch):
    sock, counts = FlowSocket(), {"in": 0, "out": 0}
    process, resized = flow_process()
    live, input_seen = True, asyncio.Event()
    class ActiveSink(Sink):
        def write(self, data):
            super().write(data)
            input_seen.set()
    process.stdin = ActiveSink()
    async def valid(*args):
        return live
    monkeypatch.setattr(ssh, "session_valid", valid)
    monkeypatch.setattr(ssh, "SESSION_CHECK_SECONDS", .01)
    sock.push({"type": "pause"})
    sock.push({"type": "resize", "cols": 100, "rows": 40})
    task = asyncio.create_task(ssh.bridge(sock, process, 1, {}, counts))
    try:
        await asyncio.wait_for(resized.wait(), .5)
        sock.push({"type": "input", "data": "hello"})
        await asyncio.wait_for(input_seen.wait(), .5)
        assert process.stdin.data == b"hello" and counts["in"] == 5
        assert process.stdout.reads == process.stderr.reads == 0
        live = False
        assert await asyncio.wait_for(task, .5) == "session_expired"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_round3_pause_and_resume_do_not_extend_client_idle_deadline(api, monkeypatch):
    sock, counts = FlowSocket(), {"in": 0, "out": 0}
    process, resized = flow_process()
    clock = [0.]
    # Keep asyncio's real scheduling clock intact and control only SSH idle time.
    monkeypatch.setattr(ssh, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    async def valid(*args):
        return True
    monkeypatch.setattr(ssh, "session_valid", valid)
    monkeypatch.setattr(ssh, "SESSION_CHECK_SECONDS", .01)
    task = asyncio.create_task(ssh.bridge(sock, process, 10, {}, counts))
    try:
        await asyncio.wait_for(asyncio.gather(process.stdout.started.wait(), process.stderr.started.wait()), .5)
        clock[0] = 9.
        for control in ("pause", "resume", "pause"):
            sock.push({"type": control})
        sock.push({"type": "resize", "cols": 80, "rows": 24})
        await asyncio.wait_for(resized.wait(), .5)
        clock[0] = 11.  # Eleven seconds since input, only two since pause/resume.
        assert await asyncio.wait_for(task, .2) == "idle_timeout"
        assert counts["in"] == 0
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("message", [{"type": "pause", "data": "x"}, {"type": "resume", "cols": 80},
    {"type": "PAUSE"}, {"type": "resume", "extra": True}, {"type": []}, {"type": {}}])
async def test_round3_pause_resume_messages_are_strict(api, message):
    with pytest.raises(ValueError, match="invalid_message"):
        await ssh.bridge(BridgeSocket([message]), bridge_process(), 30, {}, {"in": 0, "out": 0})


@pytest.mark.parametrize("operation,lock_kind", [("status", "thread"), ("reserve", "thread"),
    ("finalize", "thread"), ("status", "process")])
async def test_round3_storage_lock_contention_does_not_block_the_event_loop(api, monkeypatch, operation, lock_kind):
    held, release, attempting = threading.Event(), threading.Event(), threading.Event()
    calls, beats = [], []
    main_thread = threading.get_ident()
    reserved = None
    if operation == "finalize":
        async with api.factory() as db:
            reserved = await ssh_store.start_session(db, "operator", "local", "127.0.0.1")
    if operation == "reserve":
        real_storage = ssh_store._storage
        @contextmanager
        def observed_storage(*args, **kwargs):
            calls.append(threading.get_ident())
            attempting.set()
            with real_storage(*args, **kwargs) as directory:
                yield directory
        monkeypatch.setattr(ssh_store, "_storage", observed_storage)
    else:
        name = "read_config" if operation == "status" else "release_session_lock"
        original = getattr(ssh_store, name)
        def observed(*args, **kwargs):
            calls.append(threading.get_ident())
            attempting.set()
            return original(*args, **kwargs)
        monkeypatch.setattr(ssh_store, name, observed)
    def blocker():
        if lock_kind == "process":
            # Hold the actual msvcrt/flock file lease, without taking _LOCK.
            descriptor = ssh_store._open_lock(api.directory / ".lock")
            try:
                held.set()
                release.wait(2)
            finally:
                ssh_store._close_lock(descriptor)
        else:
            with ssh_store._LOCK:
                held.set()
                release.wait(2)  # A regressed synchronous handler can never hang this test forever.
    thread = threading.Thread(target=blocker, daemon=True)
    async def heartbeat():
        while True:
            beats.append(time.monotonic())
            await asyncio.sleep(.005)
    async def reserve_or_finalize():
        async with api.factory() as db:
            if operation == "reserve":
                return await ssh_store.start_session(db, "operator", "local", "127.0.0.1")
            return await ssh_store.end_session(db, reserved.id, "remote_closed", 0, 0)
    async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://testserver") as client:
        assert (await client.post("/api/auth/login", json={"username": "operator", "password": PASSWORD})).status_code == 200
        thread.start()
        assert await asyncio.to_thread(held.wait, 1)
        pulse = asyncio.create_task(heartbeat())
        work = asyncio.create_task(client.get("/api/ssh/status") if operation == "status" else reserve_or_finalize())
        try:
            assert await asyncio.wait_for(asyncio.to_thread(attempting.wait, 1), 1.5)
            previous = len(beats)
            await asyncio.sleep(.03)
            assert len(beats) >= previous + 2
            assert not work.done(), "The bounded lock holder released before the event loop could run"
            assert calls and all(identifier != main_thread for identifier in calls)
        finally:
            release.set()
            await asyncio.to_thread(thread.join, 1)
            pulse.cancel()
            await asyncio.gather(pulse, return_exceptions=True)
            result = await asyncio.wait_for(work, 1)
        if operation == "status":
            assert result.status_code == 200


@pytest.mark.parametrize("lock_kind", ["thread", "process"])
async def test_round3_host_key_callback_pin_refuses_busy_storage_immediately(api, lock_kind):
    held, release = threading.Event(), threading.Event()
    key = public_key()
    def blocker():
        if lock_kind == "process":
            descriptor = ssh_store._open_lock(api.directory / ".lock")
            try:
                held.set()
                release.wait(2)
            finally:
                ssh_store._close_lock(descriptor)
        else:
            with ssh_store._LOCK:
                held.set()
                release.wait(2)
    thread = threading.Thread(target=blocker, daemon=True)
    thread.start()
    assert await asyncio.to_thread(held.wait, 1)
    try:
        if lock_kind == "process":
            assert ssh_store._LOCK.acquire(blocking=False)
            ssh_store._LOCK.release()
        started = time.monotonic()
        with pytest.raises(HTTPException) as error:
            ssh_store.pin_host("local", "127.0.0.1", key, blocking=False)
        assert error.value.status_code == 503
        assert time.monotonic() - started < .2
    finally:
        release.set()
        await asyncio.to_thread(thread.join, 1)
    assert not ssh_store.host_info("local")["host_key_known"]


async def test_round3_cancelled_reservation_waits_for_worker_and_releases_its_lease(api, monkeypatch):
    requested, held, release = threading.Event(), threading.Event(), threading.Event()
    entered, worker_done = threading.Event(), threading.Event()
    identifiers, release_order = [], []
    real_reserve = ssh_store._reserve_session_lock
    real_release = ssh_store.release_session_lock
    def holder():
        if requested.wait(2):
            with ssh_store._LOCK:
                held.set()
                release.wait(2)
    def blocked_reserve(identifier):
        identifiers.append(identifier)
        requested.set()
        assert held.wait(1)
        entered.set()
        try:
            return real_reserve(identifier)
        finally:
            worker_done.set()
    def observed_release(identifier):
        release_order.append(worker_done.is_set())
        return real_release(identifier)
    monkeypatch.setattr(ssh_store, "_reserve_session_lock", blocked_reserve)
    monkeypatch.setattr(ssh_store, "release_session_lock", observed_release)
    thread = threading.Thread(target=holder, daemon=True)
    thread.start()
    async with api.factory() as db:
        task = asyncio.create_task(ssh_store.start_session(db, "operator", "local", "127.0.0.1"))
        try:
            assert await asyncio.wait_for(asyncio.to_thread(entered.wait, 1), 1.5)
            task.cancel()
            await asyncio.sleep(.02)
            assert not worker_done.is_set() and not task.done()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 1)
            assert db.in_transaction() is False
        finally:
            release.set()
            requested.set()
            if not task.done():
                task.cancel()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1.5)
            await asyncio.to_thread(thread.join, 1)
    assert worker_done.is_set() and len(identifiers) == 1
    assert release_order == [True], "Cleanup must follow the worker's completed acquisition"
    identifier = identifiers[0]
    assert ssh_store._session_lock_key(api.directory, identifier) not in ssh_store._SESSION_LOCKS
    assert not (api.directory / f".session-{identifier}.lock").exists()
    async with api.factory() as db:
        assert (await db.execute(select(ssh_store.SshSession.id))).scalars().all() == []


# ─── The VM account's own keys (key_source "vm"), "allow every server" and fixed failure reasons ─────────────────

def write_vm_key(directory, name, key=None, *, data=None):
    path = Path(directory) / name
    path.write_bytes(data if data is not None else key.export_private_key("openssh"))
    if os.name != "nt":
        path.chmod(0o600)
    return path


def key_body_lines(key):
    """Base64 lines of a private key export: none may ever appear in a response, the audit or a log."""
    return [line for line in key.export_private_key("openssh").decode().splitlines() if line and "-----" not in line]


async def terminal_rows(api):
    async with api.factory() as db:
        return [row for row in await ssh_store.list_sessions(db) if row["event"] == "terminal"]


def closed_frame(sock):
    with pytest.raises(WebSocketDisconnect) as error:
        sock.receive_json()
    return error.value


async def test_vm_account_key_signs_in_like_the_vm_shell_without_config_agent_or_commands(api, library, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(ssh_store, "_LOGGED_SKIPS", set())
    vm_key = library.generate_private_key("ssh-ed25519")
    write_vm_key(api.vm_keys, "id_ed25519", vm_key)
    # A ~/.ssh/config that would run a command or change the port if anything but IdentityFile were honoured
    # (its IdentityFile names a missing file, which is left out).
    marker = api.home / "proxycommand-ran"
    command = f"{sys.executable} -c \"open(r'{marker}', 'w').close()\""
    (api.vm_keys / "config").write_text(f"Host *\n  ProxyCommand {command}\n  Port 2222\n  IdentityFile ~/.ssh/other\n")
    api.settings.ssh_vm_key_dir = ""  # The default: ~/.ssh of the account running Lab Manager (here the fake home).
    assert ssh_store.read_config()["key_source"] == "vm"
    messages = []
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library,
                                                         accept=[vm_key.convert_to_public()]) as events:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            messages.append(until(sock, "connected"))
            assert sock.receive_json()["data"] == "ready\n"
            sock.send_json({"type": "input", "data": "exit"})
            messages.append(until(sock, "closed"))
        # Only the VM key was needed; no site key exists. Only a shell ran: no exec, subsystem, forward or password.
        assert events["offered"] == [("ssh-ed25519", vm_key.get_fingerprint())]
        assert events["connections"] == 1 and events["shells"] == 1
        assert events["exec"] == [] and events["subsystems"] == []
        assert events["passwords"] == 0 and events["kbdint"] == 0 and events["forwards"] == 0
    assert not marker.exists()
    rows = await terminal_rows(api)
    assert len(rows) == 1
    assert (rows[0]["key_source"], rows[0]["key_type"], rows[0]["key_name"]) == ("vm", "ssh-ed25519", "id_ed25519")
    assert rows[0]["end_reason"] == "remote_closed"
    with browser(api) as admin:
        config = admin.get("/api/ssh/config").json()
        texts = [json.dumps(config), admin.get("/api/ssh/sessions").text, admin.get("/api/ssh/status").text,
                 json.dumps(messages), caplog.text]
    assert config["vm_keys"] == [{"name": "id_ed25519", "type": "ssh-ed25519", "usable": True, "reason": ""}]
    for text in texts:
        assert "PRIVATE KEY" not in text
        assert str(api.home) not in text and json.dumps(str(api.home))[1:-1] not in text
        assert not any(line in text for line in key_body_lines(vm_key))


async def test_site_key_is_offered_after_the_vm_keys_the_server_refuses(api, library, monkeypatch):
    ssh_store.generate_key()
    site = ssh_store.private_key()
    ed25519, ecdsa = library.generate_private_key("ssh-ed25519"), library.generate_private_key("ecdsa-sha2-nistp256")
    write_vm_key(api.vm_keys, "id_ed25519", ed25519)
    write_vm_key(api.vm_keys, "id_ecdsa", ecdsa)
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library) as events:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            until(sock, "connected")
            assert sock.receive_json()["data"] == "ready\n"
            sock.send_json({"type": "input", "data": "exit"})
            until(sock, "closed")
        # The OpenSSH default order (id_ed25519, id_ecdsa, id_rsa), then the Lab Manager key.
        assert [fingerprint for _, fingerprint in events["offered"]] == [
            ed25519.get_fingerprint(), ecdsa.get_fingerprint(), site.get_fingerprint()]
    rows = await terminal_rows(api)
    assert (rows[0]["key_source"], rows[0]["key_type"], rows[0]["key_name"]) == ("vm", "ssh-ed25519", "lab-manager")


async def test_key_source_site_never_offers_the_vm_keys(api, library, monkeypatch):
    ssh_store.generate_key()
    site = ssh_store.private_key()
    vm_key = library.generate_private_key("ssh-ed25519")
    write_vm_key(api.vm_keys, "id_ed25519", vm_key)
    with browser(api) as admin:
        revision = admin.get("/api/ssh/status").json()["config_revision"]
        assert admin.put("/api/ssh/config", json={"key_source": "site"}).status_code == 428
        assert admin.put("/api/ssh/config", json={"key_source": "agent"}, headers={"If-Match": revision}).status_code == 400
        saved = admin.put("/api/ssh/config", json={"key_source": "site"}, headers={"If-Match": revision})
        assert saved.status_code == 200 and saved.json()["key_source"] == "site"
        assert saved.json()["targets"] == {"local": "127.0.0.1"} and saved.json()["default_user"] == "root"
        assert admin.get("/api/ssh/config").json()["key_source"] == "site"
        assert admin.get("/api/ssh/status").json()["key_source"] == "site"
    # The server only knows the VM key: with "site" Lab Manager never offers it, so the sign-in is refused.
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library,
                                                         accept=[vm_key.convert_to_public()]) as events:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            assert until(sock, "closed")["reason"] == "auth_failed"
            frame = closed_frame(sock)
            assert frame.code == 1011 and frame.reason == "auth_failed"
        assert [fingerprint for _, fingerprint in events["offered"]] == [site.get_fingerprint()]
        assert events["passwords"] == 0 and events["kbdint"] == 0
    rows = await terminal_rows(api)
    assert (rows[0]["end_reason"], rows[0]["key_source"], rows[0]["key_type"], rows[0]["key_name"]) == (
        "auth_failed", "site", "", "")
    async with api.factory() as db:
        events = [row["event"] for row in await ssh_store.list_sessions(db)]
    assert "key_source_changed" in events


def test_vm_keys_skip_encrypted_unreadable_and_invalid_files_with_a_logged_reason(tmp_path, monkeypatch, caplog):
    asyncssh = pytest.importorskip("asyncssh")
    monkeypatch.setattr(ssh_store, "_LOGGED_SKIPS", set())
    caplog.set_level(logging.DEBUG)
    folder = tmp_path / "vm-keys"
    folder.mkdir()
    usable_key = asyncssh.generate_private_key("ecdsa-sha2-nistp256")
    encrypted_key = asyncssh.generate_private_key("ssh-ed25519")
    write_vm_key(folder, "id_ecdsa", usable_key)
    write_vm_key(folder, "id_ed25519", data=encrypted_key.export_private_key("pkcs8-pem", passphrase="not-known"))
    (folder / "id_rsa").mkdir()  # Exists but cannot be read as a key file.
    report, usable = ssh_store.vm_keys(folder)
    assert report == [
        {"name": "id_ed25519", "type": "", "usable": False, "reason": ssh_store.passphrase_reason("id_ed25519")},
        {"name": "id_ecdsa", "type": "ecdsa-sha2-nistp256", "usable": True, "reason": ""},
        {"name": "id_rsa", "type": "", "usable": False, "reason": "not a regular file"},  # stat first: never opened
    ]
    assert [(name, kind) for name, kind, _ in usable] == [("id_ecdsa", "ecdsa-sha2-nistp256")]
    other = tmp_path / "other"
    other.mkdir()
    (other / "id_rsa").write_text("not a key")
    assert ssh_store.vm_key_report(other) == [
        {"name": "id_rsa", "type": "", "usable": False, "reason": "not a private key Lab Manager can read"}]
    assert ssh_store.vm_key_report(tmp_path / "missing") == []
    if os.name != "nt":
        loose = tmp_path / "loose"
        loose.mkdir()
        write_vm_key(loose, "id_rsa", asyncssh.generate_private_key("ssh-rsa")).chmod(0o644)
        assert ssh_store.vm_key_report(loose)[0]["reason"] == "readable by other users (chmod 600 it)"
    logged = caplog.text
    assert "id_ed25519" in logged and "passphrase" in logged and "id_rsa" in logged
    assert str(tmp_path) not in logged and "PRIVATE KEY" not in logged
    assert not any(line in logged for line in key_body_lines(usable_key) + key_body_lines(encrypted_key))
    # Logged once per file and reason, not on every connection.
    lines = len(caplog.records)
    ssh_store.vm_keys(folder)
    assert len(caplog.records) == lines


@pytest.mark.parametrize("source", ["vm", "site"])
async def test_no_usable_key_refuses_before_any_connection(api, library, monkeypatch, source):
    if source == "site":
        ssh_store.write_config("root", {}, {"local": "127.0.0.1"}, ssh_store.config_etag(), key_source="site")
    write_vm_key(api.vm_keys, "id_ed25519", data=b"not a key")

    async def local_resolution(host):
        return "127.0.0.1"

    async def forbidden(*args, **kwargs):
        pytest.fail("Lab Manager connected without a usable key")
    monkeypatch.setattr(ssh, "resolve_target", local_resolution)
    monkeypatch.setattr(library, "connect", forbidden)
    with browser(api, "operator") as client:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            reason = until(sock, "closed")["reason"]
    expected = ssh.NO_KEYS_REASON if source == "vm" else "SSH key has not been generated"
    assert reason == expected


async def test_allow_every_server_covers_only_the_hosts_the_admin_pass_checked(api, monkeypatch):
    (api.directory / "config.json").unlink()  # A configuration that never set auto_allow or key_source.
    config = ssh_store.read_config()
    assert config["auto_allow"] is True and config["key_source"] == "system" and config["targets"] == {}
    assert config["auto_hosts"] == {} and config["denied_hosts"] == {}
    # The Admin's "allow every server" pass (auto_hosts) still governs the AsyncSSH key sources "vm" and "site".
    ssh_store.write_config("root", {}, {}, ssh_store.config_etag(), auto_allow=True, key_source="vm")
    async with api.factory() as db:
        db.add(PingTarget(id="far", source_key="server:far", name="Far", host="far.invalid", source="manual"))
        await db.commit()
    resolved = []

    async def fake_resolution(host):
        resolved.append(host)
        if host == "far.invalid":
            raise HTTPException(403, ssh.UNRESOLVED_DETAIL)
        return host
    monkeypatch.setattr(ssh, "resolve_target", fake_resolution)

    def rows(client):
        status = client.get("/api/ssh/status").json()
        return status, {server["key"]: server for server in status["servers"]}

    async def inventory(statement):
        async with api.factory() as db:
            await db.execute(statement) if not isinstance(statement, PingTarget) else db.add(statement)
            await db.commit()

    with browser(api) as client:
        status, servers = rows(client)
        assert status["auto_allow"] is True and status["key_source"] == "vm"
        # Nothing is allowed until an Admin's first "Check addresses again" pass has seen the saved hosts.
        assert servers["local"]["approval"] == "address_changed" and servers["local"]["allowed"] is False
        assert servers["local"]["not_allowed_reason"] == ssh.AUTO_CHECK_REASON and servers["local"]["approved_host"] == ""
        assert resolved == []  # The status never resolves names.
        saved = client.put("/api/ssh/config", json={"auto_allow": True}, headers={"If-Match": status["config_revision"]})
        assert saved.status_code == 200 and saved.json()["auto_hosts"] == {"local": "127.0.0.1"}
        assert [(item["key"], item["name"], item["host"]) for item in saved.json()["skipped"]] == [("far", "Far", "far.invalid")]
        assert "cannot find an IP address for far.invalid" in saved.json()["skipped"][0]["reason"]
        assert sorted(resolved) == ["127.0.0.1", "far.invalid"]
        status, servers = rows(client)
        assert servers["far"]["approval"] == "skipped" and servers["far"]["allowed"] is False
        assert "cannot find an IP address" in servers["far"]["not_allowed_reason"]
        assert servers["local"]["approval"] == "auto" and servers["local"]["approved_host"] == "127.0.0.1"
        # A server an Operator adds later, or a saved host an Operator changes, waits for the next Admin pass.
        client.portal.call(inventory, PingTarget(id="new", source_key="server:new", name="New", host="10.20.30.40",
                                                 source="manual"))
        client.portal.call(inventory, update(PingTarget).where(PingTarget.id == "saved").values(host="10.20.30.41"))
        status, servers = rows(client)
        for key in ("new", "local"):
            assert servers[key]["approval"] == "address_changed" and servers[key]["allowed"] is False
            assert servers[key]["not_allowed_reason"] == ssh.AUTO_CHECK_REASON and servers[key]["approved_host"] == ""
        # "Check addresses again" (auto_allow sent again) captures the current saved hosts.
        saved = client.put("/api/ssh/config", json={"auto_allow": True}, headers={"If-Match": status["config_revision"]})
        assert saved.status_code == 200 and saved.json()["auto_hosts"] == {"local": "10.20.30.41", "new": "10.20.30.40"}
        status, servers = rows(client)
        assert servers["new"]["approval"] == servers["local"]["approval"] == "auto"
        assert servers["local"]["approved_host"] == "10.20.30.41"
        # An explicit "not allowed" wins, even over an approval sent in the same request; its host is captured.
        body = {"targets": {"local": "10.20.30.41"}, "denied": ["local"]}
        saved = client.put("/api/ssh/config", json=body, headers={"If-Match": status["config_revision"]})
        assert saved.status_code == 200 and saved.json()["denied"] == ["local"] and "local" not in saved.json()["targets"]
        assert saved.json()["denied_hosts"] == {"local": "10.20.30.41"}
        status, servers = rows(client)
        assert servers["local"]["approval"] == "denied" and servers["local"]["allowed"] is False
        assert servers["local"]["approved_host"] == "" and servers["local"]["not_allowed_reason"] == ssh.TURNED_OFF_REASON
        # Turning the flag off leaves only explicit approvals and forgets the pass.
        saved = client.put("/api/ssh/config", json={"auto_allow": False}, headers={"If-Match": status["config_revision"]})
        assert saved.status_code == 200 and saved.json()["auto_allow"] is False
        assert saved.json()["auto_skipped"] == {} and saved.json()["auto_hosts"] == {}
        status, servers = rows(client)
        assert servers["new"]["approval"] == "none" and servers["far"]["approval"] == "none"
        assert servers["local"]["approval"] == "denied"
        assert client.put("/api/ssh/config", json={"auto_allow": "yes"},
                          headers={"If-Match": status["config_revision"]}).status_code == 400
        # Captured hosts are never taken from a request body (an echoed GET is fine).
        echoed = {**client.get("/api/ssh/config").json(), "auto_hosts": {"new": "10.20.30.40"}, "denied_hosts": {}}
        assert client.put("/api/ssh/config", json=echoed, headers={"If-Match": status["config_revision"]}).status_code == 200
        assert ssh_store.read_config()["auto_hosts"] == {} and ssh_store.read_config()["denied_hosts"] == {"local": "10.20.30.41"}
    async with api.factory() as db:
        events = [row["event"] for row in await ssh_store.list_sessions(db)]
    assert "auto_allow_off" in events and "config_updated" in events
    # Viewer rules are unchanged: no hosts, users, key source or reasons, and no configuration access.
    with browser(api, "viewer") as viewer:
        result = viewer.get("/api/ssh/status").json()
        assert "key_source" not in result and "default_user" not in result and "config_revision" not in result
        assert not {"host", "user", "approved_host", "not_allowed_reason"}.intersection(result["servers"][0])
        assert viewer.get("/api/ssh/config").status_code == 403
        assert viewer.put("/api/ssh/config", json={"auto_allow": True}, headers={"If-Match": "x"}).status_code == 403
    with browser(api, "operator") as operator:
        assert operator.get("/api/ssh/config").status_code == 403
        assert operator.get("/api/ssh/status").json()["key_source"] == "vm"


async def test_auto_allowed_server_connects_to_its_captured_saved_host_only(api, library, monkeypatch):
    ssh_store.generate_key()
    ssh_store.write_config("root", {}, {}, ssh_store.config_etag(), auto_allow=True, auto_hosts={"local": "127.0.0.1"})
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library) as events:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            until(sock, "connected")
            assert sock.receive_json()["data"] == "ready\n"
        assert events["connections"] == 1


@pytest.mark.parametrize("case", ["new", "changed"])
async def test_uncaptured_server_never_gets_dns_vm_keys_or_a_connection(api, library, monkeypatch, case):
    write_vm_key(api.vm_keys, "id_ed25519", library.generate_private_key("ssh-ed25519"))
    captured = {} if case == "new" else {"local": "10.9.9.9"}  # "changed": the pass saw an older saved host.
    ssh_store.write_config("root", {}, {}, ssh_store.config_etag(), auto_allow=True, auto_hosts=captured)

    def forbidden(*args, **kwargs):
        pytest.fail("An uncaptured server reached DNS, the VM keys or a connection")

    async def forbidden_async(*args, **kwargs):
        forbidden()
    monkeypatch.setattr(ssh, "resolve_target", forbidden_async)
    monkeypatch.setattr(library, "connect", forbidden_async)
    monkeypatch.setattr(ssh_store, "vm_keys", forbidden)
    with browser(api, "operator") as client:
        server = client.get("/api/ssh/status").json()["servers"][0]
        assert server["approval"] == "address_changed" and server["allowed"] is False
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            assert until(sock, "closed")["reason"] == ssh.AUTO_CHECK_REASON
            assert closed_frame(sock).code == 4403
    assert await terminal_rows(api) == []


async def test_turned_off_server_cannot_be_reached_through_an_alias_with_the_same_host(api, library, monkeypatch):
    ssh_store.generate_key()
    async with api.factory() as db:
        await db.execute(update(PingTarget).where(PingTarget.id == "saved").values(host="opt106.lab"))
        await db.commit()

    async def resolution(host):
        return "10.0.0.5"
    monkeypatch.setattr(ssh, "resolve_target", resolution)
    with browser(api) as admin:
        revision = admin.get("/api/ssh/status").json()["config_revision"]
        saved = admin.put("/api/ssh/config", json={"auto_allow": True, "denied": ["local"]}, headers={"If-Match": revision})
        assert saved.status_code == 200 and saved.json()["denied_hosts"] == {"local": "opt106.lab"}
    # An Operator adds another inventory name for the same machine (case and a trailing dot do not matter).
    async with api.factory() as db:
        db.add(PingTarget(id="alias", source_key="server:opt106x", name="opt106x", host="OPT106.lab.", source="manual"))
        await db.commit()
    with browser(api) as admin:
        status = admin.get("/api/ssh/status").json()
        # Neither "Check addresses again" nor an explicit approval of the alias lifts the turned-off address.
        again = admin.put("/api/ssh/config", json={"auto_allow": True}, headers={"If-Match": status["config_revision"]})
        assert again.status_code == 200 and "opt106x" not in again.json()["auto_hosts"]
        approve = admin.put("/api/ssh/config", json={"targets": {"opt106x": "opt106.lab."}},
                            headers={"If-Match": again.headers["etag"]})
        assert approve.status_code == 200 and approve.json()["denied"] == ["local"]
        alias = next(item for item in admin.get("/api/ssh/status").json()["servers"] if item["key"] == "opt106x")
        assert alias["approval"] == "denied" and alias["allowed"] is False
        assert alias["not_allowed_reason"] == ssh.SAME_ADDRESS_REASON

    async def forbidden(*args, **kwargs):
        pytest.fail("A turned-off address was connected")
    monkeypatch.setattr(library, "connect", forbidden)
    with browser(api, "operator") as client:
        with client.websocket_connect("/api/ssh/opt106x/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            assert until(sock, "closed")["reason"] == ssh.SAME_ADDRESS_REASON
            assert closed_frame(sock).code == 4403
    assert await terminal_rows(api) == []


async def test_turned_off_address_is_refused_under_another_name(api, library, monkeypatch):
    async with api.factory() as db:
        db.add(PingTarget(id="alias", source_key="server:alias", name="Alias", host="alias.example", source="manual"))
        await db.commit()
    ssh_store.write_config("root", {}, {"alias": "alias.example"}, ssh_store.config_etag(), auto_allow=False,
                           denied=["local"], denied_hosts={"local": "127.0.0.1"})

    def forbidden(*args, **kwargs):
        pytest.fail("Keys were read for a turned-off address")
    monkeypatch.setattr(ssh_store, "vm_keys", forbidden)
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library, target_host="alias.example") as events:
        assert client.get("/api/ssh/status").json()["servers"][0]["allowed"] is True  # Alias: a different host name.
        with client.websocket_connect("/api/ssh/alias/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            assert until(sock, "closed")["reason"] == "denied"  # It resolves to the turned-off 127.0.0.1.
            assert closed_frame(sock).code == 4403
        assert events["connections"] == 0


def test_denied_host_comparison_ignores_case_trailing_dot_and_ipv4_mapping():
    config = {"denied": ["a"], "denied_hosts": {"a": "OPT106.LAB"}, "targets": {}, "auto_allow": True,
              "auto_hosts": {"b": "opt106.lab.", "c": "10.0.0.5"}}
    assert ssh.approval({"key": "b", "host": "opt106.lab."}, config)[0] == "denied"
    assert ssh.host_token("::ffff:10.0.0.5") == ssh.host_token("10.0.0.5")
    config["denied_hosts"] = {"a": "::ffff:10.0.0.5"}
    assert ssh.approval({"key": "c", "host": "10.0.0.5"}, config)[0] == "denied"
    assert ssh.approval({"key": "b", "host": "opt106.lab."}, config)[0] == "auto"


async def test_key_list_is_admin_only_bounded_cached_and_reads_own_addresses_once(api, monkeypatch):
    ssh_store.generate_key()
    async with api.factory() as db:
        db.add(PingTarget(id="b", source_key="server:b", name="B", host="198.51.100.7", source="manual"))
        await db.commit()
    ssh_store.write_config("root", {}, {"local": "127.0.0.1", "b": "198.51.100.7"}, ssh_store.config_etag(),
                           auto_allow=False)
    own_reads, routes = [], []
    monkeypatch.setattr(ssh, "local_addresses", lambda: own_reads.append(1) or {"127.0.0.1", "::1"})
    monkeypatch.setattr(ssh, "installation_source_ip", lambda address: routes.append(address) or "192.0.2.10")
    with browser(api) as admin:
        first = admin.get("/api/ssh/key")
        assert first.status_code == 200
        rows = {row["key"]: row for row in first.json()["install"]}
        assert rows["b"]["source_ip"] == "192.0.2.10" and rows["b"]["reason"] == ""
        assert rows["local"]["source_ip"] == "<VM IP>" and rows["local"]["reason"] == ssh.SOURCE_UNKNOWN_REASON
        assert own_reads == [1] and routes == ["198.51.100.7"]  # Two servers, one read of the VM's addresses.
        assert admin.get("/api/ssh/key").json()["install"] == first.json()["install"]
        assert own_reads == [1] and routes == ["198.51.100.7"]  # Served from the per-host cache.
    with browser(api, "operator") as operator:
        assert operator.get("/api/ssh/key").status_code == 403  # The full list resolves every server.
        mine = operator.get("/api/ssh/key?server=b")
        assert mine.status_code == 200 and [row["key"] for row in mine.json()["install"]] == ["b"]
        assert operator.get("/api/ssh/key?server=Bad!").status_code == 404
    # One total deadline for every lookup; a lookup that misses it is not cached.
    ssh._SOURCE_CACHE.clear()
    monkeypatch.setattr(ssh, "KEY_DEADLINE_SECONDS", 0.3)

    async def slow(host):
        await asyncio.sleep(30)
    monkeypatch.setattr(ssh, "resolve_target", slow)
    with browser(api) as admin:
        started = time.monotonic()
        late = admin.get("/api/ssh/key")
        assert time.monotonic() - started < 5
    assert late.status_code == 200
    assert {row["source_ip"] for row in late.json()["install"]} == {"<VM IP>"}
    assert ssh._SOURCE_CACHE == {}


async def test_connect_attempt_limit_runs_before_dns_keys_or_session_rows(api, library, monkeypatch):
    api.settings.ssh_max_connect_attempts_per_minute = 3
    operator = {"username": "operator", "id": "operator", "name": "Operator"}
    async with api.factory() as db:
        await ssh_store.audit_event(db, operator, "connect_failed", server_key="local", end_reason="unreachable")
        await ssh_store.audit_event(db, operator, "connect_failed", server_key="other", end_reason="unreachable")
        await ssh_store.audit_event(db, operator, "denied", end_reason="denied")
        await ssh_store.audit_event(db, {"username": "admin"}, "connect_failed", end_reason="unreachable")

    def forbidden(*args, **kwargs):
        pytest.fail("A rate-limited attempt reached DNS, the inventory, the keys or a connection")

    async def forbidden_async(*args, **kwargs):
        forbidden()
    monkeypatch.setattr(ssh, "resolve_target", forbidden_async)
    monkeypatch.setattr(ssh_store, "known_servers", forbidden_async)
    monkeypatch.setattr(ssh_store, "vm_keys", forbidden)
    monkeypatch.setattr(ssh_store, "private_key", forbidden)
    monkeypatch.setattr(ssh_store, "start_session", forbidden_async)
    monkeypatch.setattr(library, "connect", forbidden_async)
    with browser(api, "operator") as client:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            assert until(sock, "closed")["reason"] == ssh.RATE_REASON
            assert closed_frame(sock).code == 4429
    async with api.factory() as db:
        rows = await ssh_store.list_sessions(db)
        assert await ssh_store.recent_attempts(db, "operator") == 4  # The refusal itself counts as well.
        assert await ssh_store.recent_attempts(db, "admin") == 1
    assert [row for row in rows if row["event"] == "terminal"] == []


def test_vm_key_file_swapped_between_stat_and_open_is_skipped(tmp_path, monkeypatch):
    asyncssh = pytest.importorskip("asyncssh")
    monkeypatch.setattr(ssh_store, "_LOGGED_SKIPS", set())
    folder = tmp_path / "keys"
    folder.mkdir()
    write_vm_key(folder, "id_ed25519", asyncssh.generate_private_key("ssh-ed25519"))
    real_stat = os.stat

    def other_inode(path, *args, **kwargs):
        result = real_stat(path, *args, **kwargs)
        if Path(path).name != "id_ed25519":
            return result
        fields = list(result[:10])
        fields[1] = result.st_ino + 1  # st_ino: another file than the one open() then returns.
        return os.stat_result(fields)
    with monkeypatch.context() as patch:
        patch.setattr(os, "stat", other_inode)
        report, usable = ssh_store.vm_keys(folder)
    assert report == [{"name": "id_ed25519", "type": "", "usable": False,
                       "reason": "changed while Lab Manager was reading it"}]
    assert usable == []
    assert [name for name, _, _ in ssh_store.vm_keys(folder)[1]] == ["id_ed25519"]  # Unchanged file: used.


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="FIFOs are POSIX-only")
def test_vm_key_fifo_is_skipped_without_opening_it(tmp_path, monkeypatch):
    pytest.importorskip("asyncssh")
    monkeypatch.setattr(ssh_store, "_LOGGED_SKIPS", set())
    folder = tmp_path / "keys"
    folder.mkdir()
    os.mkfifo(folder / "id_ecdsa")
    assert ssh_store.vm_keys(folder)[0] == [{"name": "id_ecdsa", "type": "", "usable": False, "reason": "not a regular file"}]


# ─── IdentityFile lines of the VM account's ~/.ssh/config (and nothing else from it) ───────────────────────────────

async def test_config_identity_file_for_the_server_signs_in_and_nothing_else_in_the_config_is_used(
        api, library, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(ssh_store, "_LOGGED_SKIPS", set())
    keys = {name: library.generate_private_key("ssh-ed25519") for name in ("lab_key", "other_key", "match_key", "included_key")}
    (api.home / "keys").mkdir()
    write_vm_key(api.home / "keys", "lab_key", keys["lab_key"])  # Outside ~/.ssh: any file the config names.
    for name in ("other_key", "match_key", "included_key"):
        write_vm_key(api.vm_keys, name, keys[name])
    marker = api.home / "config-command-ran"
    command = f"{sys.executable} -c \"open(r'{marker}', 'w').close()\""
    (api.vm_keys / "included.conf").write_text("Host *\n  IdentityFile ~/.ssh/included_key\n")
    (api.vm_keys / "config").write_text(
        "Include ~/.ssh/included.conf\n"
        "IdentityFile ~/.ssh/missing_key\n"
        "Host other-server *.example.com\n  IdentityFile ~/.ssh/other_key\n"
        f"Host web-* 127.0.0.? !10.*\n  ProxyCommand {command}\n  ProxyJump jump.example.com\n"
        f"  PermitLocalCommand yes\n  LocalCommand {command}\n  Port 2222\n  User nobody\n"
        "  IdentityAgent ~/.ssh/agent.sock\n  CertificateFile ~/.ssh/other_key.pub\n  IdentityFile ~/keys/lab_key\n"
        "Match host 127.0.0.1\n  IdentityFile ~/.ssh/match_key\n")
    messages = []
    accept = [key.convert_to_public() for key in keys.values()]
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library, accept=accept) as events:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            messages.append(until(sock, "connected"))
            assert sock.receive_json()["data"] == "ready\n"
            sock.send_json({"type": "input", "data": "exit"})
            messages.append(until(sock, "closed"))
        # The Include's key (IdentityFile lines only), then the matching Host block's: never the other block's or the
        # Match block's. The first one the server accepts signs in.
        assert events["offered"] == [("ssh-ed25519", keys["included_key"].get_fingerprint())]
        assert events["connections"] == 1 and events["shells"] == 1 and events["exec"] == []
    assert not marker.exists()  # Neither ProxyCommand nor LocalCommand ran.
    rows = await terminal_rows(api)
    assert (rows[0]["key_source"], rows[0]["key_type"], rows[0]["key_name"]) == (
        "vm", "ssh-ed25519", "config:included_key")
    with browser(api) as admin:
        config = admin.get("/api/ssh/config").json()
        texts = [json.dumps(config), admin.get("/api/ssh/sessions").text, json.dumps(messages), caplog.text]
    # Admin → SSH (no server): the included file's and every Host block's keys, never a Match block's.
    assert config["vm_keys"] == [{"name": "config:included_key", "type": "ssh-ed25519", "usable": True, "reason": ""},
                                 {"name": "config:other_key", "type": "ssh-ed25519", "usable": True, "reason": ""},
                                 {"name": "config:lab_key", "type": "ssh-ed25519", "usable": True, "reason": ""}]
    for text in texts:
        assert "PRIVATE KEY" not in text and "keys/lab_key" not in text
        assert str(api.home) not in text and json.dumps(str(api.home))[1:-1] not in text
        assert not any(line in text for key in keys.values() for line in key_body_lines(key))


def test_config_identity_files_follow_host_rules_order_and_dedup_without_paths(tmp_path, monkeypatch, caplog):
    asyncssh = pytest.importorskip("asyncssh")
    monkeypatch.setattr(ssh_store, "_LOGGED_SKIPS", set())
    caplog.set_level(logging.DEBUG)
    folder = tmp_path / "home" / ".ssh"
    folder.mkdir(parents=True)
    key = asyncssh.generate_private_key("ssh-ed25519")
    for name in ("global_key", "id_rsa", "id_ed25519", "optn118_root", "negated_key", "quoted key", "match_key"):
        write_vm_key(folder, name, key)
    (folder / "config").write_text(
        "# The global section counts for every server.\n"
        "IdentityFile ~/.ssh/global_key\n"
        "Host optn118 LAB-*\n"
        "  IdentityFile %d/.ssh/id_rsa\n"       # A default file: offered here, by its own name, and not again.
        "  IdentityFile ~/.ssh/global_key\n"    # Named twice: offered once.
        "  IdentityFile ~/.ssh/%h_%r\n"
        "  IdentityFile ~/.ssh/missing\n"       # Missing: left out.
        "  IdentityFile ~/.ssh/%C_key\n"        # A token Lab Manager does not expand: listed with the reason.
        "Host * !optn118\n"
        "  IdentityFile ~/.ssh/negated_key\n"
        "HOST=OPTN1?8\n"
        "  IdentityFile=\"~/.ssh/quoted key\"\n"
        "Match all\n"
        "  IdentityFile ~/.ssh/match_key\n")
    token_row = {"name": "config:_C_key", "type": "", "usable": False, "reason": "uses a % token Lab Manager does not expand"}

    def names(target):
        report, usable = ssh_store.vm_keys(folder, target)
        assert [name for name, _, _ in usable] == [row["name"] for row in report if row["usable"]]
        return [row["name"] if row["usable"] else row for row in report]

    # By saved host (several patterns, ?, case-insensitive; the negated block is ruled out).
    assert names({"host": "optn118", "name": "Rack 3 server", "user": "root"}) == [
        "config:global_key", "id_rsa", "config:optn118_root", token_row, "config:quoted_key", "id_ed25519"]
    # By name only; %h_%r names a missing file here.
    assert names({"host": "10.0.0.5", "name": "lab-7", "user": "admin"}) == [
        "config:global_key", "id_rsa", token_row, "config:negated_key", "id_ed25519"]
    # A server no Host block names: the global section, the "every server but optn118" block and the defaults.
    assert names({"host": "10.0.0.9", "name": "Other", "user": "root"}) == [
        "config:global_key", "config:negated_key", "id_ed25519", "id_rsa"]
    # Admin → SSH (no server): every Host block, entries naming the server (%h, %r) left out, never a Match block.
    assert names(None) == ["config:global_key", "id_rsa", token_row, "config:negated_key", "config:quoted_key",
                           "id_ed25519"]
    logged = caplog.text
    assert "config:_C_key" in logged and str(tmp_path) not in logged and "PRIVATE KEY" not in logged

    # At most 16 files from the config, in its order.
    capped = tmp_path / "capped" / ".ssh"
    capped.mkdir(parents=True)
    for index in range(20):
        write_vm_key(capped, f"k{index:02}", key)
    (capped / "config").write_text("".join(f"IdentityFile ~/.ssh/k{index:02}\n" for index in range(20)))
    assert [name for name, _, _ in ssh_store.vm_keys(capped)[1]] == [f"config:k{index:02}" for index in range(16)]
    assert "more than 16" in caplog.text

    # A config that cannot be used is listed by name with the reason; the default files still work.
    unsafe = tmp_path / "unsafe" / ".ssh"
    unsafe.mkdir(parents=True)
    write_vm_key(unsafe, "id_ed25519", key)
    (unsafe / "config").mkdir()
    report, usable = ssh_store.vm_keys(unsafe, {"host": "optn118", "name": "", "user": "root"})
    assert report[0] == {"name": "config", "type": "", "usable": False, "reason": "not a regular file"}
    assert [name for name, _, _ in usable] == ["id_ed25519"]
    if os.name != "nt":
        (unsafe / "config").rmdir()
        (unsafe / "config").write_text("IdentityFile ~/.ssh/id_ed25519\n")
        (unsafe / "config").chmod(0o666)
        assert ssh_store.vm_keys(unsafe)[0][0]["reason"] == "writable by other users (chmod 600 it)"


def test_connection_failures_map_to_fixed_reason_tokens(library):
    failure = ssh.connect_failure
    assert failure(library, library.PermissionDenied("Permission denied for user root on host x"), True) == "auth_failed"
    assert failure(library, ConnectionRefusedError(errno.ECONNREFUSED, "Connect call failed"), False) == "refused"
    assert failure(library, asyncio.TimeoutError(), False) == "unreachable"
    assert failure(library, asyncio.TimeoutError(), True) == "connect_timeout"
    assert failure(library, OSError(errno.EHOSTUNREACH, "No route to host"), False) == "unreachable"
    assert failure(library, library.ConnectionLost("Connection lost"), True) == "connection_failed"
    assert failure(library, RuntimeError("library text with secrets"), True) == "connection_failed"


@pytest.mark.parametrize("case", ["auth_failed", "refused", "unreachable-route", "unreachable-dns", "denied", "host_key_changed"])
async def test_terminal_sends_fixed_failure_tokens_and_audits_them(api, library, monkeypatch, case):
    ssh_store.generate_key()
    if case == "host_key_changed":
        ssh_store.pin_host("local", "127.0.0.1", library.generate_private_key("ssh-ed25519"))
    with browser(api, "operator") as client, fake_server(client, monkeypatch, library,
                                                         accept=[] if case == "auth_failed" else None) as events:
        if case in ("refused", "unreachable-route"):
            async def failing(*args, **kwargs):
                if case == "refused":
                    raise ConnectionRefusedError(errno.ECONNREFUSED, "Connect call failed ('10.0.0.1', 22)")
                raise OSError(errno.EHOSTUNREACH, "No route to host")
            monkeypatch.setattr(library, "connect", failing)
        if case in ("unreachable-dns", "denied"):
            async def refusing(host):
                raise HTTPException(403, ssh.UNRESOLVED_DETAIL if case == "unreachable-dns" else ssh.PROHIBITED_DETAIL)
            monkeypatch.setattr(ssh, "resolve_target", refusing)
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            reason = until(sock, "closed")["reason"]
            frame = closed_frame(sock)
        token = case.split("-")[0]
        assert reason == token and frame.reason == token
        assert frame.code == {"host_key_changed": 4409, "denied": 4403}.get(token, 1011)
        assert events["shells"] == 0 and events["exec"] == []
    async with api.factory() as db:
        rows = await ssh_store.list_sessions(db)
        denials = await ssh_store.list_sessions(db, denials=True)
    terminal = [row for row in rows if row["event"] == "terminal"]
    if case in ("unreachable-dns", "denied"):
        # Refused before a session was reserved: recorded as a single event row, never a terminal session.
        assert terminal == []
        recorded = denials if case == "denied" else [row for row in rows if row["event"] == "connect_failed"]
        assert [row["end_reason"] for row in recorded] == [token]
    else:
        assert [row["end_reason"] for row in terminal] == [token]
    assert "Connect call failed" not in json.dumps(rows) and "No route" not in json.dumps(rows)


async def test_existing_session_table_gains_the_key_columns(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'old.db'}")
    try:
        async with engine.begin() as connection:
            await connection.exec_driver_sql(
                "CREATE TABLE ssh_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user VARCHAR NOT NULL, "
                "user_id VARCHAR NOT NULL, user_name VARCHAR NOT NULL, remote_user VARCHAR NOT NULL, "
                "client_ip VARCHAR NOT NULL, connected_ip VARCHAR NOT NULL, host_key_fingerprint VARCHAR NOT NULL, "
                "event VARCHAR NOT NULL, server_key VARCHAR NOT NULL, host VARCHAR NOT NULL, started_at FLOAT NOT NULL, "
                "ended_at FLOAT, end_reason VARCHAR, bytes_in INTEGER NOT NULL, bytes_out INTEGER NOT NULL)")
            await connection.exec_driver_sql(
                "INSERT INTO ssh_sessions (user, user_id, user_name, remote_user, client_ip, connected_ip, "
                "host_key_fingerprint, event, server_key, host, started_at, ended_at, end_reason, bytes_in, bytes_out) "
                "VALUES ('operator', 'operator', 'Operator', 'root', '', '', '', 'terminal', 'local', '127.0.0.1', "
                "1.0, 2.0, 'remote_closed', 1, 2)")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            rows = await ssh_store.list_sessions(db)
        assert [(row["key_source"], row["key_type"], row["key_name"]) for row in rows] == [("", "", "")]
    finally:
        await engine.dispose()


# ─── key_source "system": the VM's own ssh command in a PTY (simulated here; never a real ssh or server) ──────────

SSH_PATH = "/usr/bin/ssh"


class FakeSystem:
    """Stands in for ssh.SystemSsh: echoes input, records resizes and close; never runs a process."""

    def __init__(self, argv, env, failure=None):
        self.argv, self.env, self.failure = argv, env, failure
        self.sizes, self.closed, self.outbox = [], False, None
        self.stdin = SimpleNamespace(write=self.write, drain=self.drain)
        self.stdout = SimpleNamespace(read=self.read)
        self.stderr = ssh.EmptyReader()

    def queue(self):
        if self.outbox is None:
            self.outbox = asyncio.Queue()
            self.outbox.put_nowait(b"ready\n")
        return self.outbox

    def write(self, data):
        self.queue().put_nowait(b"" if data == b"exit" else b"echo:" + data)

    async def drain(self):
        pass

    async def read(self, size):
        return await self.queue().get()

    def change_terminal_size(self, cols, rows):
        self.sizes.append((cols, rows))

    async def ready(self, timeout):
        if self.failure:
            raise ssh.ConnectFailure(self.failure)

    async def close(self):
        self.closed = True


def system_mode(api, monkeypatch, *, failure=None, path=SSH_PATH, addresses=None, **config):
    """Key source "system" with every gate real except DNS (resolve_target/host_addresses) and the PTY layer."""
    ssh_store.write_config("root", {}, {}, ssh_store.config_etag(), key_source="system", auto_allow=False, **config)
    api.settings.ssh_allowed_networks = "10.9.8.0/24"
    monkeypatch.setattr(ssh, "_LAB_CACHE", {})
    monkeypatch.setattr(ssh, "system_ssh_path", lambda: (path, "" if path else ssh.SYSTEM_NO_CLIENT))
    answers = {"127.0.0.1": ["10.9.8.7"], **(addresses or {})}

    async def resolution(host):
        return (answers.get(host) or ["10.9.8.7"])[0]

    async def lookup(host, *, cached=True):
        return answers.get(host, [host])
    monkeypatch.setattr(ssh, "resolve_target", resolution)
    monkeypatch.setattr(ssh, "host_addresses", lookup)
    spawned = []

    async def spawn(argv, env, cols=80, rows=24):
        spawned.append(FakeSystem(argv, env, failure))
        return spawned[-1]
    monkeypatch.setattr(ssh, "spawn_system_ssh", spawn)
    return spawned


def test_system_argv_is_exact_argv_with_no_shell_prompts_or_forwarding():
    argv = ssh.system_argv(SSH_PATH, "root", "Opt106.lab", 10)
    assert argv == [SSH_PATH, "-tt", "-p", "22", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                    "-o", "ServerAliveInterval=30", "-o", "StrictHostKeyChecking=accept-new", "-o", "ForwardAgent=no",
                    "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
                    "-o", "RequestTTY=force", "-l", "root", "--", "opt106.lab"]
    assert argv[-2] == "--" and argv.count("--") == 1
    for flag in ("-A", "-X", "-Y", "-L", "-R", "-D", "-W", "-J", "-F", "-i", "ForwardAgent=yes", "ForwardX11=yes",
                 "IdentitiesOnly=yes", "IdentityAgent=none"):
        assert flag not in argv  # The account's agent and IdentityFile settings stay in force.
    assert not any(" " in item or ";" in item for item in argv[1:])
    for user in ("root; id", "-oProxyCommand=x", "a@b", "Root", ""):
        with pytest.raises(HTTPException):
            ssh.system_argv(SSH_PATH, user, "opt106", 10)
    for host in ("-oProxyCommand=x", "opt106 -v", "user@opt106", "ssh://opt106", "opt106:2222", "a;b", ""):
        with pytest.raises(HTTPException):
            ssh.system_argv(SSH_PATH, "root", host, 10)


def test_system_env_keeps_what_ssh_needs_and_drops_secrets():
    source = {"HOME": "/home/lab", "USER": "lab", "LOGNAME": "lab", "PATH": "/usr/bin", "LANG": "C.UTF-8",
              "LC_ALL": "C.UTF-8", "SSH_AUTH_SOCK": "/run/agent.sock", "KRB5CCNAME": "FILE:/tmp/krb5cc_1000",
              "TERM": "dumb", "LAB_MANAGER_MASTER_KEY": "m", "LAB_MANAGER_PASSWORD": "p", "PDU_PASSWORD": "p",
              "GITHUB_TOKEN": "t", "AWS_SECRET_ACCESS_KEY": "s", "HTTPS_PROXY": "http://proxy", "LD_PRELOAD": "x.so",
              "PYTHONPATH": "/x", "DISPLAY": ":0"}
    env = ssh.system_env(source)
    assert env == {"HOME": "/home/lab", "USER": "lab", "LOGNAME": "lab", "PATH": "/usr/bin", "LANG": "C.UTF-8",
                   "LC_ALL": "C.UTF-8", "SSH_AUTH_SOCK": "/run/agent.sock", "KRB5CCNAME": "FILE:/tmp/krb5cc_1000",
                   "TERM": "xterm-256color"}
    minimal = ssh.system_env({})
    assert minimal["TERM"] == "xterm-256color" and minimal["PATH"]


@pytest.mark.parametrize("stderr,token", [
    ("root@opt106: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).", "auth_failed"),
    ("ssh: connect to host opt106 port 22: Connection refused", "refused"),
    ("ssh: connect to host opt106 port 22: No route to host", "unreachable"),
    ("ssh: Could not resolve hostname opt106: Name or service not known", "unreachable"),
    ("ssh: connect to host opt106 port 22: Connection timed out", "unreachable"),
    ("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", "host_key_changed"),
    ("Host key verification failed.", "host_key_changed"),
    ("kex_exchange_identification: read: Connection reset by peer", "connection_failed"),
    ("", "connection_failed"),
])
def test_system_stderr_maps_to_fixed_reason_tokens(stderr, token):
    assert ssh.system_failure(stderr.encode()) == token
    assert token in ssh.TOKEN_REASONS


async def test_key_source_defaults_to_system_and_old_configs_migrate(api):
    path = api.directory / "config.json"
    path.unlink()  # Never configured: the VM's ssh command, every server.
    assert (ssh_store.read_config()["key_source"], ssh_store.read_config()["auto_allow"]) == ("system", True)
    for old in ({"key_source": "vm", "auto_allow": False}, {"key_source": "site", "auto_allow": False},
                {"auto_allow": False}, {"key_source": "vm", "auto_allow": False, "key_source_version": 1}):
        ssh_store._write(path, json.dumps({"default_user": "root", "denied": ["local"], **old}).encode())
        config = ssh_store.read_config()
        assert (config["key_source"], config["auto_allow"], config["denied"]) == ("system", True, ["local"])
    # After the migration an Admin's choice of any source stays as saved.
    for source in ("vm", "site", "system"):
        ssh_store.write_config("root", {}, {}, ssh_store.config_etag(), key_source=source, auto_allow=False)
        assert (ssh_store.read_config()["key_source"], ssh_store.read_config()["auto_allow"]) == (source, False)
        assert json.loads(path.read_text())["key_source_version"] == ssh_store.KEY_SOURCE_VERSION
    with browser(api) as admin:
        revision = admin.get("/api/ssh/config").headers["ETag"]
        bad = admin.put("/api/ssh/config", json={"key_source": "agent"}, headers={"If-Match": revision})
        assert bad.status_code == 400 and '"system"' in bad.json()["detail"]
        saved = admin.put("/api/ssh/config", json={"key_source": "vm"}, headers={"If-Match": revision})
        assert saved.status_code == 200 and saved.json()["key_source"] == "vm"
        saved = admin.put("/api/ssh/config", json={"key_source": "system"}, headers={"If-Match": saved.headers["ETag"]})
        assert saved.status_code == 200 and saved.json()["key_source"] == "system"


def test_lab_networks_are_the_24_or_64_around_literal_ips(monkeypatch):
    assert ssh.lab_network_of("10.1.2.3") == ssh.ipaddress.ip_network("10.1.2.0/24")
    assert ssh.lab_network_of("::ffff:10.1.2.3") == ssh.ipaddress.ip_network("10.1.2.0/24")
    assert ssh.lab_network_of("fd00:1:2:3::9") == ssh.ipaddress.ip_network("fd00:1:2:3::/64")
    for bad in ("opt106", "", None, "10.1.2.0/24"):
        with pytest.raises((ValueError, TypeError)):
            ssh.lab_network_of(bad)
    monkeypatch.setattr(ssh, "get_settings",
                        lambda: SimpleNamespace(ssh_allowed_networks=" 192.0.2.0/24, junk,fd01::/48,"))
    assert [str(net) for net in ssh.configured_networks()] == ["192.0.2.0/24", "fd01::/48"]


async def test_system_mode_allows_every_lab_server_with_zero_clicks(api, monkeypatch):
    async with api.factory() as db:
        db.add(Device(id="pdu1", name="PDU 1", kind="pdu", ip="10.50.0.2"))
        for key, host in (("opt1", "10.20.30.40"), ("lab", "lab-box"), ("corp", "corp-box"), ("ghost", "ghost-box"),
                          ("off", "10.20.30.41")):
            db.add(PingTarget(id=key, source_key=f"server:{key}", name=key.title(), host=host, source="manual"))
        await db.commit()
    system_mode(api, monkeypatch, denied=["off"], addresses={
        "lab-box": ["10.50.0.9"], "corp-box": ["198.51.100.7"], "ghost-box": None})
    with browser(api, "operator") as client:
        status = client.get("/api/ssh/status").json()
        servers = {server["key"]: server for server in status["servers"]}
        assert status["key_source"] == "system" and status["auto_allow"] is False
        assert set(status["system_ssh"]) == {"available", "reason"}
        # No Admin approval, pass or host-key confirmation: every lab server is allowed at its saved host.
        for key, host in (("opt1", "10.20.30.40"), ("lab", "lab-box"), ("local", "127.0.0.1")):
            assert (servers[key]["approval"], servers[key]["allowed"], servers[key]["approved_host"]) == (
                "auto", True, host)
        assert (servers["corp"]["approval"], servers["corp"]["allowed"]) == ("outside", False)
        assert servers["corp"]["not_allowed_reason"] == ssh.OUTSIDE_REASON == \
            "Outside the lab networks (add it to SSH_ALLOWED_NETWORKS)"
        assert (servers["ghost"]["approval"], servers["ghost"]["allowed"]) == ("unresolved", False)
        assert "cannot find an IP address for ghost-box" in servers["ghost"]["not_allowed_reason"]
        assert (servers["off"]["approval"], servers["off"]["not_allowed_reason"]) == ("denied", ssh.TURNED_OFF_REASON)
        # SSH_ALLOWED_NETWORKS adds a network (picked up once the 60 s cache is refreshed).
        api.settings.ssh_allowed_networks = "198.51.100.0/24"
        ssh._LAB_CACHE.clear()
        servers = {server["key"]: server for server in client.get("/api/ssh/status").json()["servers"]}
        assert servers["corp"]["approval"] == "auto" and servers["lab"]["approval"] == "auto"


async def test_system_terminal_runs_the_vm_ssh_command_and_bridges_it(api, monkeypatch):
    monkeypatch.setenv("LAB_MANAGER_MASTER_KEY", "never-to-the-child")
    monkeypatch.setenv("KRB5CCNAME", "FILE:/tmp/krb5cc_1000")
    monkeypatch.setenv("SSH_AUTH_SOCK", "/run/user/1000/agent.sock")
    spawned = system_mode(api, monkeypatch)
    with browser(api, "operator") as client:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            assert until(sock, "connected")["reason"] == ""  # No site pin notice: known_hosts governs.
            assert sock.receive_json() == {"type": "output", "data": "ready\n"}
            sock.send_json({"type": "resize", "cols": 120, "rows": 40})
            sock.send_json({"type": "input", "data": "ls\r"})
            assert sock.receive_json() == {"type": "output", "data": "echo:ls\r"}
            sock.send_json({"type": "input", "data": "exit"})
            assert until(sock, "closed")["reason"] == "SSH session ended"
    [system] = spawned
    assert system.argv == ssh.system_argv(SSH_PATH, "root", "127.0.0.1", api.settings.ssh_connect_timeout_seconds)
    assert system.env["TERM"] == "xterm-256color" and system.env["KRB5CCNAME"] == "FILE:/tmp/krb5cc_1000"
    assert system.env["SSH_AUTH_SOCK"] == "/run/user/1000/agent.sock"
    assert "LAB_MANAGER_MASTER_KEY" not in system.env
    assert system.sizes == [(120, 40)] and system.closed
    rows = await terminal_rows(api)
    assert [(row["key_source"], row["key_name"], row["key_type"], row["end_reason"]) for row in rows] == [
        ("system", "", "", "remote_closed")]
    assert rows[0]["connected_ip"] == "10.9.8.7" and rows[0]["host_key_fingerprint"] == ""


@pytest.mark.parametrize("case", ["rate", "denied", "outside", "unresolved", "prohibited", "unavailable", "viewer"])
async def test_system_gates_run_before_any_ssh_process(api, monkeypatch, case):
    lookup = {"outside": ["198.51.100.7"], "unresolved": None}.get(case, ["10.9.8.7"])
    spawned = system_mode(api, monkeypatch, path="" if case == "unavailable" else SSH_PATH,
                          denied=["local"] if case == "denied" else [], addresses={"127.0.0.1": lookup})
    if case == "rate":
        api.settings.ssh_max_connect_attempts_per_minute = 1
        async with api.factory() as db:
            await ssh_store.audit_event(db, {"username": "operator"}, "connect_failed", end_reason="unreachable")
    if case == "prohibited":
        async def prohibited(host):
            raise HTTPException(403, ssh.PROHIBITED_DETAIL)
        monkeypatch.setattr(ssh, "resolve_target", prohibited)
    expected = {"rate": (ssh.RATE_REASON, 4429), "denied": (ssh.TURNED_OFF_REASON, 4403),
                "outside": (ssh.OUTSIDE_REASON, 4403), "unresolved": ("unreachable", 1011),
                "prohibited": ("denied", 4403), "unavailable": (ssh.SYSTEM_UNAVAILABLE_REASON, 4503)}
    with browser(api, "viewer" if case == "viewer" else "operator") as client:
        if case == "viewer":
            with pytest.raises(WebSocketDisconnect) as refused:
                with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
                    sock.receive_json()
            assert refused.value.code == 4403
        else:
            with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
                authenticate(sock, client)
                reason = until(sock, "closed")["reason"]
                frame = closed_frame(sock)
            assert (reason, frame.code) == expected[case]
    assert spawned == []
    assert await terminal_rows(api) == []


class FakeStream:
    def __init__(self, data=b""):
        self.data = data

    async def read(self, size):
        data, self.data = self.data, b""
        return data


class FakeProcess:
    """An ssh child that exits with `exit_code` by itself, or only when signalled (`ignore`: signals it ignores)."""

    def __init__(self, exit_code=None, stderr=b"", ignore=()):
        self.pid, self.returncode, self.exit_code, self.ignore = 4242, None, exit_code, ignore
        self.stderr, self.signals = FakeStream(stderr), []

    def signal(self, sig):
        self.signals.append(sig)
        if sig not in self.ignore and sig != ssh.SIGWINCH and self.exit_code is None:
            self.exit_code = -sig

    async def wait(self):
        while self.exit_code is None:
            await asyncio.sleep(0.01)
        self.returncode = self.exit_code
        return self.returncode


def fake_process_group(monkeypatch, process):
    calls = []

    def killpg(pid, sig):
        calls.append((pid, sig))
        process.signal(sig)
    monkeypatch.setattr(os, "killpg", killpg, raising=False)
    return calls


@pytest.mark.parametrize("ignore_hangup", [False, True])
async def test_system_close_kills_the_process_group_and_reaps_it(monkeypatch, ignore_hangup):
    process = FakeProcess(ignore=(ssh.SIGHUP,) if ignore_hangup else ())
    calls = fake_process_group(monkeypatch, process)
    closed = []
    monkeypatch.setattr(ssh.os, "close", closed.append)
    system = ssh.SystemSsh(process, master=-1)
    system.change_terminal_size(100, 30)
    await system.close()
    await system.close()  # Idempotent.
    assert calls == [(4242, ssh.SIGWINCH), (4242, ssh.SIGHUP), (4242, ssh.SIGKILL)]
    assert process.returncode == (-ssh.SIGKILL if ignore_hangup else -ssh.SIGHUP)  # Waited for: no zombie.
    assert closed == [-1]  # The PTY master is closed once.


async def test_system_failure_before_output_is_a_fixed_token_and_stderr_is_never_sent(api, monkeypatch):
    system_mode(api, monkeypatch)
    secret = b"root@10.9.8.7: Permission denied (publickey,gssapi-with-mic). debug1: /home/lab/.ssh/id_lab"
    processes = []

    async def spawn(argv, env, cols=80, rows=24):
        processes.append(FakeProcess(exit_code=255, stderr=secret))
        system = ssh.SystemSsh(processes[-1], master=-1)
        system.stdout = FakeStream(b"")  # The PTY reached EOF without any output.
        return system
    monkeypatch.setattr(ssh, "spawn_system_ssh", spawn)
    monkeypatch.setattr(os, "killpg", lambda pid, sig: None, raising=False)
    monkeypatch.setattr(ssh.os, "close", lambda fd: None)
    messages = []
    with browser(api, "operator") as client:
        with client.websocket_connect("/api/ssh/local/terminal", headers=socket_headers()) as sock:
            authenticate(sock, client)
            messages.append(until(sock, "closed"))
            frame = closed_frame(sock)
    assert messages[-1]["reason"] == frame.reason == "auth_failed" and frame.code == 1011
    rows = await terminal_rows(api)
    assert [(row["key_source"], row["end_reason"]) for row in rows] == [("system", "auth_failed")]
    for text in (json.dumps(messages), frame.reason, json.dumps(rows)):
        assert "Permission denied" not in text and "id_lab" not in text and "debug1" not in text


@pytest.mark.skipif(os.name != "posix", reason="The system ssh PTY path is Linux-only; Windows tests mock it")
async def test_real_pty_round_trip_with_a_fake_ssh_command(tmp_path, monkeypatch):
    script = tmp_path / "ssh"
    script.write_text(f"#!{sys.executable}\n" + "\n".join([
        "import os, signal, sys",
        "if sys.argv[-1] == 'refuse.example':",
        "    sys.stderr.write('root@refuse.example: Permission denied (publickey).\\n')",
        "    sys.exit(255)",
        "def winch(*_):",
        "    cols, rows = os.get_terminal_size(0)",
        "    os.write(1, ('size:%dx%d\\n' % (cols, rows)).encode())",
        "signal.signal(signal.SIGWINCH, winch)",
        "os.write(1, ('ready %s %s\\n' % (os.environ.get('TERM'), 'LAB_SECRET' in os.environ)).encode())",
        "while True:",
        "    line = sys.stdin.readline()",
        "    if not line or line.strip() == 'exit':",
        "        break",
        "    os.write(1, ('echo:' + line.strip() + '\\n').encode())",
    ]) + "\n")
    script.chmod(0o755)
    monkeypatch.setenv("LAB_SECRET", "never-to-the-child")

    async def read_until(system, needle, seconds=10):
        text, deadline = "", time.monotonic() + seconds
        while needle not in text:
            chunk = await asyncio.wait_for(system.stdout.read(4096), max(0.1, deadline - time.monotonic()))
            assert chunk, f"EOF before {needle!r}: {text!r}"
            text += chunk.decode("utf-8", "replace")
        return text

    system = await ssh.spawn_system_ssh(ssh.system_argv(str(script), "root", "lab.example", 5), ssh.system_env())
    try:
        await system.ready(10)
        assert "ready xterm-256color False" in await read_until(system, "False")
        system.stdin.write(b"hello\r")
        await system.stdin.drain()
        await read_until(system, "echo:hello")
        system.change_terminal_size(100, 40)
        await read_until(system, "size:100x40")
    finally:
        await system.close()
    assert system.process.returncode is not None
    failing = await ssh.spawn_system_ssh(ssh.system_argv(str(script), "root", "refuse.example", 5), ssh.system_env())
    try:
        with pytest.raises(ssh.ConnectFailure) as failure:
            await failing.ready(10)
        assert failure.value.reason == "auth_failed"
    finally:
        await failing.close()
    assert failing.process.returncode == 255


def test_vm_keys_follow_the_system_ssh_config_and_its_includes_and_explain_passphrases(tmp_path, monkeypatch):
    asyncssh = pytest.importorskip("asyncssh")
    monkeypatch.setattr(ssh_store, "_LOGGED_SKIPS", set())
    home = tmp_path / "home"
    folder = home / ".ssh"
    folder.mkdir(parents=True)
    etc = tmp_path / "etc-ssh"
    (etc / "ssh_config.d").mkdir(parents=True)
    monkeypatch.setattr(ssh_store, "SYSTEM_SSH_CONFIG", etc / "ssh_config")
    developer, lab = asyncssh.generate_private_key("ssh-ed25519"), asyncssh.generate_private_key("ssh-ed25519")
    write_vm_key(folder, "developer_key", data=developer.export_private_key("pkcs8-pem", passphrase="unknown"))
    write_vm_key(folder, "lab_key", lab)
    (etc / "ssh_config").write_text("Include /etc/does-not-exist/*.conf\nInclude ssh_config.d/*.conf\n"
                                    "Host *\n  IdentityFile ~/.ssh/developer_key\n")
    (etc / "ssh_config.d" / "10-lab.conf").write_text("Host opt*\n  IdentityFile ~/.ssh/lab_key\n  ProxyCommand x\n")
    (etc / "ssh_config.d" / "skip.txt").write_text("IdentityFile ~/.ssh/never\n")
    monkeypatch.delenv("SSH_AUTH_SOCK", raising=False)
    monkeypatch.setattr(ssh_store, "agent_socket", lambda environ=None: "")
    report, usable = ssh_store.vm_keys(folder, {"host": "opt106", "name": "Opt106", "user": "root"})
    reason = ("The VM's key developer_key needs its passphrase (ssh-agent); install the Lab Manager key once "
              "(Admin \u2192 SSH) or start Lab Manager with access to the agent")
    assert report == [{"name": "config:lab_key", "type": "ssh-ed25519", "usable": True, "reason": ""},
                      {"name": "config:developer_key", "type": "", "usable": False, "reason": reason}]
    assert [(name, kind) for name, kind, _ in usable] == [("config:lab_key", "ssh-ed25519")]
    # Another server: the Host opt* block of the included file does not apply.
    assert [row["name"] for row in ssh_store.vm_keys(folder, {"host": "web1", "name": "Web1", "user": "root"})[0]] == [
        "config:developer_key"]
    # With an agent of this account the reason points to the VM's ssh command instead.
    monkeypatch.setattr(ssh_store, "agent_socket", lambda environ=None: "/run/user/1000/ssh-agent.socket")
    monkeypatch.setattr(ssh_store, "_LOGGED_SKIPS", set())
    assert "This VM's ssh command" in ssh_store.vm_keys(folder, None)[0][-1]["reason"]
    assert str(home) not in json.dumps(report)


def test_agent_socket_uses_only_a_live_socket_of_this_account(tmp_path, monkeypatch):
    assert ssh_store.agent_socket({"SSH_AUTH_SOCK": str(tmp_path / "missing.sock"), "XDG_RUNTIME_DIR": str(tmp_path)}) == ""
    env = ssh.system_env({"SSH_AUTH_SOCK": "/run/given.sock", "HOME": "/home/lab"})
    assert env["SSH_AUTH_SOCK"] == "/run/given.sock"  # Passed through as the service has it.
    monkeypatch.setattr(ssh_store, "agent_socket", lambda environ=None: "/run/user/1000/openssh_agent")
    assert ssh.system_env({"HOME": "/home/lab"})["SSH_AUTH_SOCK"] == "/run/user/1000/openssh_agent"
