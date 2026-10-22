"""SSH API and real protocol checks, exclusively against 127.0.0.1 fake servers."""
from contextlib import asynccontextmanager, contextmanager
import asyncio
import ast
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


@pytest.fixture
async def api(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'ssh-tests.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    settings = SimpleNamespace(accounts_enabled=True, accounts_registration_enabled=False,
        accounts_session_hours=12, accounts_secure_cookie=False, lab_manager_password="",
        ssh_terminal_enabled=True, ssh_allow_insecure_transport=True, ssh_idle_timeout_seconds=1800, ssh_connect_timeout_seconds=2,
        ssh_max_sessions_per_user=4, ssh_max_sessions_total=20)
    monkeypatch.setattr(accounts, "AsyncSessionLocal", factory)
    monkeypatch.setattr(ssh, "AsyncSessionLocal", factory, raising=False)
    monkeypatch.setattr(ssh_store, "AsyncSessionLocal", factory, raising=False)
    monkeypatch.setattr(accounts, "get_settings", lambda: settings)
    monkeypatch.setattr(ssh, "get_settings", lambda: settings)
    monkeypatch.setattr(ssh_store, "SSH_DIR", tmp_path / "private-ssh")
    async with factory() as db:
        for role in ("Viewer", "Operator", "Admin"):
            db.add(User(id=role.lower(), username=role.lower(), name=role, role=role,
                        password_hash=PASSWORD_HASH, created_at=time.time()))
        db.add(PingTarget(id="saved", source_key="server:local", name="Local",
                          host="127.0.0.1", source="manual"))
        await db.commit()
    ssh_store.write_config("root", {}, {"local": "127.0.0.1"}, expected_etag=ssh_store.config_etag())
    app = FastAPI()
    app.add_middleware(accounts.AccountAccess)
    app.include_router(accounts.router)
    app.include_router(ssh.router)

    async def database():
        async with factory() as db:
            yield db

    app.dependency_overrides[get_db] = database
    try:
        yield SimpleNamespace(app=app, factory=factory, settings=settings, directory=tmp_path / "private-ssh")
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
    assert set(rows[0]) == {"id", "user", "server_key", "host", "started_at", "ended_at", "end_reason", "bytes_in", "bytes_out", "event", "user_id", "user_name", "client_ip", "connected_ip", "host_key_fingerprint", "remote_user"}


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
def fake_server(client, monkeypatch, library, *, host_key=None, reject_auth=False, target_host="127.0.0.1"):
    """Real AsyncSSH listener on a random loopback port; production still requests port 22."""
    events = {"resizes": [], "ptys": [], "connections": 0}
    expected_key = ssh_store.private_key().convert_to_public()
    host_key = host_key or library.generate_private_key("ssh-ed25519")

    class Session(library.SSHServerSession):
        def connection_made(self, channel):
            self.channel = channel

        def pty_requested(self, term_type, term_size, term_modes):
            events["ptys"].append((term_type, term_size))
            return True

        def shell_requested(self):
            return True

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
            return not reject_auth and username == "root" and key == expected_key

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
        assert kwargs["client_keys"] == [ssh_store.private_key()]
        assert kwargs["username"] == "root"
        for flag in ("gss_auth", "gss_kex", "password_auth", "kbdint_auth", "host_based_auth", "agent_forwarding"):
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
        listener.close()
        client.portal.call(listener.wait_closed)


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


async def test_config_etag_and_explicit_target_approval(api, monkeypatch):
    async def fake_resolution(host):
        assert host == "127.0.0.1"
        return "127.0.0.1"
    monkeypatch.setattr(ssh, "resolve_target", fake_resolution)
    with browser(api) as client:
        initial = client.get("/api/ssh/config")
        assert initial.status_code == 200
        assert initial.json() == {"default_user": "root", "per_server_user": {}, "targets": {"local": "127.0.0.1"}}
        original = initial.headers["etag"]
        body = {"default_user": "deployer", "per_server_user": {"local": "operator"}, "targets": {"local": "127.0.0.1"}}
        assert client.put("/api/ssh/config", json=body).status_code == 428
        assert client.put("/api/ssh/config", json=body, headers={"If-Match": '"stale"'}).status_code == 412
        written = client.put("/api/ssh/config", json=body, headers={"If-Match": original})
        assert written.status_code == 200 and written.json() == body
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
        assert ssh_store.read_config() == body


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
