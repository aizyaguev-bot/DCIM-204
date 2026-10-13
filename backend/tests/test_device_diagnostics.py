"""Connectivity tests use loopback only; inventory DB and process data are synthetic."""
import importlib.util
from contextlib import closing
import json
from pathlib import Path
import socket
import socketserver
import sqlite3
import ssl
import tempfile
import threading

import pytest

spec = importlib.util.spec_from_file_location(
    "device_diagnostics", Path(__file__).resolve().parents[2] / "scripts" / "diagnose-device-api.py")
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)


@pytest.fixture
def tmp_path():
    # Do not depend on a shared pytest-of-user directory from another sandbox.
    with tempfile.TemporaryDirectory(prefix="dcim-device-api-") as directory:
        yield Path(directory)


def write_test_certificate(certificate, key):
    """Self-signed loopback certificate generated per test run."""
    from datetime import datetime, timedelta, timezone
    import ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    private_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(private_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([
                x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .sign(private_key, hashes.SHA256()))
    certificate.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key.write_bytes(private_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


def healthy_result():
    return {"connect_budget_ms": 3000, "steps": {
        "address": {"outcome": "ok"},
        "tcp": {"outcome": "ok", "attempts": [{"outcome": "ok", "ms": 10}]},
        "tls": {"outcome": "ok", "ms": 20},
        "http": {"outcome": "ok", "ttfb_ms": 30},
        "parallel": {"outcome": "ok", "exceeded_budget": 0, "failed": 0},
        "proxy": {"backend": [{"would_proxy": False}]},
    }}


@pytest.mark.parametrize("expected,step,changes", [
    ("ok", "http", {}),
    ("dns_failure", "address", {"outcome": "failed"}),
    ("no_route", "tcp", {"outcome": "no_route"}),
    ("tcp_refused", "tcp", {"outcome": "refused"}),
    ("tcp_timeout", "tcp", {"outcome": "timeout"}),
    ("tcp_failure", "tcp", {"outcome": "failed"}),
    ("tcp_slow", "tcp", {"attempts": [{"outcome": "ok", "ms": 3100}]}),
    ("tls_failure", "tls", {"outcome": "failed"}),
    ("tls_failure", "tls", {"outcome": "timeout", "ms": 10000}),
    ("tls_slow", "tls", {"ms": 3200, "handshake_ms": 3100}),
    ("ok", "tls", {"ms": 4000, "tcp_ms": 2000, "handshake_ms": 2000}),
    ("parallel_tls_slow", "parallel", {"exceeded_budget": 1}),
    ("parallel_tls_slow", "parallel", {"failed": 1}),
    ("http_slow", "http", {"ttfb_ms": 6100}),
    ("http_slow", "http", {"outcome": "timeout", "ttfb_ms": None}),
    ("http_failure", "http", {"outcome": "failed"}),
    ("proxied", "proxy", {"backend": [{"would_proxy": True}]}),
])
def test_classifications(expected, step, changes):
    result = healthy_result()
    result["steps"][step].update(changes)
    assert diag.classify(result)[0] == expected
    assert diag.classify(result)[1]


def test_kvm_budget_is_six_seconds():
    result = healthy_result()
    result["connect_budget_ms"] = 6000
    result["steps"]["tls"]["ms"] = 5000
    assert diag.classify(result)[0] == "ok"


def test_proxied_takes_precedence_over_direct_path_result():
    result = healthy_result()
    result["steps"]["tcp"]["outcome"] = "timeout"
    result["steps"]["proxy"]["backend"] = [{"would_proxy": True, "proxy": "http://***@proxy:3128",
                                            "cidr_ignored_by_httpx": ["10.0.0.0/8"]}]
    code, explanation = diag.classify(result)
    assert code == "proxied" and result["direct_classification"] == "tcp_timeout"
    assert "http://***@proxy:3128" in explanation and "tcp_timeout" in explanation
    assert "CIDR" in explanation


def test_current_shell_proxy_is_used_only_when_backend_is_not_found():
    result = healthy_result()
    result["steps"]["proxy"] = {"backend": [], "current": {"would_proxy": True, "proxy": "proxy:3128"}}
    code, explanation = diag.classify(result)
    assert code == "proxied" and "backend process not found" in explanation
    result["steps"]["proxy"]["backend"] = [{"would_proxy": False}]
    assert diag.classify(result)[0] == "ok"


NO_PROXY_CASES = [
    ("10.0.0.1", "10.0.0.1", True),
    ("10.0.0.2", "10.0.0.1", False),
    ("pdu.lab.example", ".lab.example", True),
    ("lab.example", ".lab.example", False),
    ("lab.example", "lab.example", True),
    ("pdu.lab.example", "lab.example", True),
    ("otherlab.example", "lab.example", False),
    ("PDU.Lab.Example", "lab.example", True),
    ("10.2.3.4", "10.0.0.0/8", False),
    ("10.0.0.0", "10.0.0.0/8", True),
    ("192.168.1.1", "10.0.0.0/8", False),
    ("2001:db8::1", "2001:db8::1", True),
    ("2001:db9::1", "2001:db8::1", False),
    ("localhost", "localhost", True),
    ("anything", "*", True),
    ("10.0.0.1", "https://10.0.0.1", True),
    ("10.0.0.1", "http://10.0.0.1", False),
    ("pdu.lab.example", " localhost, .lab.example ", True),
    ("10.0.0.1", "", False),
]


@pytest.mark.parametrize("host,bypass,expected", NO_PROXY_CASES)
def test_no_proxy_follows_httpx(host, bypass, expected):
    assert diag.bypass_proxy(host, bypass) is expected


@pytest.mark.parametrize("host,bypass,expected", NO_PROXY_CASES)
def test_no_proxy_cases_match_installed_httpx(monkeypatch, host, bypass, expected):
    httpx = pytest.importorskip("httpx")
    from httpx._utils import URLPattern, get_environment_proxies
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "REQUEST_METHOD"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")
    monkeypatch.setenv("NO_PROXY", bypass)
    monkeypatch.setattr("httpx._utils.getproxies", lambda: {
        "https": "http://proxy.example:3128", "no": bypass})
    mounts = get_environment_proxies()
    url = httpx.URL(f"https://[{host}]/" if ":" in host else f"https://{host}/")
    patterns = sorted((URLPattern(key), value) for key, value in mounts.items())
    proxy = next((value for pattern, value in patterns if pattern.matches(url)), None)
    assert (proxy is None) is expected


def test_cidr_entries_ignored_by_httpx_are_reported():
    environment = {"HTTPS_PROXY": "http://proxy:3128", "NO_PROXY": "localhost,10.0.0.0/8,192.168.0.0/16"}
    report = diag.proxy_report(environment, "10.1.2.3")
    assert report["would_proxy"] is True
    assert report["cidr_ignored_by_httpx"] == ["10.0.0.0/8"]
    assert report["variables"]["NO_PROXY"] == "localhost,10.0.0.0/8,192.168.0.0/16"
    environment["NO_PROXY"] += ",10.1.2.3"
    report = diag.proxy_report(environment, "10.1.2.3")
    assert report["would_proxy"] is False and report["cidr_ignored_by_httpx"] == []


@pytest.mark.parametrize("value,expected", [
    ("http://alice:secret@proxy.example:8080/private?token=secret", "http://***@proxy.example:8080"),
    ("https://alice@proxy.example", "https://***@proxy.example:443"),
    ("proxy.example:3128", "proxy.example:3128"),
    ("http://user:secret@[::1]:8080", "http://***@[::1]:8080"),
    ("http://proxy.example:bad", "<invalid proxy URL>"),
])
def test_mask_proxy(value, expected):
    assert diag.mask_proxy(value) == expected


def test_proxy_environment():
    environment = {"HTTPS_PROXY": "http://user:secret@proxy:3128", "NO_PROXY": "10.1.2.3"}
    assert diag.proxy_report(environment, "10.1.2.3")["would_proxy"] is False
    report = diag.proxy_report(environment, "192.168.1.1")
    assert report["would_proxy"] is True
    assert "secret" not in json.dumps(report)
    environment["https_proxy"] = ""
    assert diag.proxy_report(environment, "192.168.1.1")["would_proxy"] is False


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "inventory.db"
    connection = sqlite3.connect(path)
    connection.executescript("""
        CREATE TABLE devices (id TEXT, name TEXT, kind TEXT, ip TEXT, enabled INTEGER,
                              rack TEXT, username_enc TEXT, password_enc TEXT);
        INSERT INTO devices VALUES ('test', 'Loopback', 'pdu', '127.0.0.1', 1, 'rack', 'user-secret', 'password-secret');
        INSERT INTO devices VALUES ('server', 'Server', 'server', '127.0.0.1', 1, 'rack', '', '');
    """)
    connection.close()
    return path


def test_database_readonly_and_allowlisted_columns(database):
    connection = diag.open_database(database)
    queries = []
    connection.set_trace_callback(queries.append)
    devices = diag.read_devices(connection)
    assert len(devices) == 1
    assert diag.read_devices(connection, "test") == devices
    assert diag.read_devices(connection, "127.0.0.1") == devices
    assert diag.read_devices(connection, "absent") == []
    with pytest.raises(sqlite3.OperationalError, match="readonly"):
        connection.execute("INSERT INTO devices (id) VALUES ('write')")
    connection.close()
    assert all("username_enc" not in query and "password_enc" not in query for query in queries)
    assert "secret" not in json.dumps(devices)


def test_last_diagnostics_are_sanitized(database):
    connection = sqlite3.connect(database)
    connection.executescript("""
        CREATE TABLE monitor_device_errors (device_id TEXT, checked_at REAL, detail TEXT);
        INSERT INTO monitor_device_errors VALUES ('test', 1, 'ReadTimeout');
        INSERT INTO monitor_device_errors VALUES ('test', 2, 'ConnectTimeout https://user:password-secret@lab?token=token-secret');
        CREATE TABLE monitor_device_snapshots (device_id TEXT, checked_at REAL, reachable INTEGER);
        INSERT INTO monitor_device_snapshots VALUES ('test', 2, 0);
    """)
    connection.close()
    with closing(diag.open_database(database)) as connection:
        device = diag.read_devices(connection)[0]
    assert device["last_error"] == {"checked_at": 2, "detail": "ConnectTimeout"}
    assert device["last_snapshot"] == {"checked_at": 2, "reachable": 0}
    assert "secret" not in json.dumps(device)


CONNECT_TIMEOUT = next(s for s in diag.FALLBACK_MONITOR_SENTENCES if s.startswith("Connection timeout:"))


@pytest.mark.parametrize("detail,expected", [
    (CONNECT_TIMEOUT, CONNECT_TIMEOUT),
    ("Connection timeout: the VM could not establish a connection to the device API. password synthetic-secret.",
     CONNECT_TIMEOUT),
    ("Device status timed out after 45 seconds. Check device load and VM network access.",
     "Device status timed out after 45 seconds. Check device load and VM network access."),
    ("Device status timed out after 45 seconds. token synthetic-secret",
     "Device status timed out after 45 seconds. Check device load and VM network access."),
    ("Connection timeout: password synthetic-secret.", "Unrecognized stored diagnostic (hidden)"),
    ("Device authentication failed: password synthetic-secret", "Unrecognized stored diagnostic (hidden)"),
    ("Device status timed out after 45 seconds synthetic-secret.", "Unrecognized stored diagnostic (hidden)"),
    ("DNS failure: token=secret/abc", "Unrecognized stored diagnostic (hidden)"),
    ("Connection timeout https://user:password-secret@lab", "Unrecognized stored diagnostic (hidden)"),
    ("ConnectTimeout https://user:password-secret@lab ConnectTimeout ReadTimeout", "ConnectTimeout, ReadTimeout"),
    ("", ""),
])
def test_stored_diagnostic_maps_to_fixed_text_only(detail, expected):
    assert diag.safe_detail(detail) == expected
    assert "secret" not in diag.safe_detail(detail)


@pytest.mark.parametrize("message", [
    "HTTP 401", "ProxyError", "ConnectTimeout", "ReadTimeout", "PoolTimeout", "timed out",
    "Name or service not known", "Connection refused", "No route to host", "SSL error",
    "HTTP 503", "connect failed", "invalid response",
])
def test_every_monitor_failure_sentence_is_recognized(message):
    from app.monitor_links import failure_reason
    reason = failure_reason(message)
    assert reason in diag.monitor_sentences()
    assert diag.safe_detail(reason) == reason


def test_sentences_are_read_from_backend_source_and_fallback_matches_it():
    from app import monitor_links
    extracted = diag.failure_sentences_from_source(Path(monitor_links.__file__).read_text(encoding="utf-8"))
    assert Path(monitor_links.__file__).resolve() == diag.MONITOR_LINKS
    assert set(extracted) == set(diag.FALLBACK_MONITOR_SENTENCES)
    assert len({diag._first_sentence(sentence) for sentence in extracted}) == len(extracted)


def test_fallback_is_used_when_backend_source_is_missing_or_dynamic(tmp_path):
    assert diag.monitor_sentences(tmp_path / "missing.py") == diag.FALLBACK_MONITOR_SENTENCES
    dynamic = tmp_path / "monitor_links.py"
    dynamic.write_text("def failure_reason(message):\n    return f'error {message}'\n", encoding="utf-8")
    assert diag.monitor_sentences(dynamic) == diag.FALLBACK_MONITOR_SENTENCES
    extra = tmp_path / "extra.py"
    extra.write_text("def failure_reason(message):\n    suffix = ' More.'\n    return 'New class.' + suffix\n",
                     encoding="utf-8")
    assert diag.monitor_sentences(extra)[0] == "New class. More."


@pytest.fixture
def tls_server(tmp_path):
    certificate = tmp_path / "test-cert.pem"
    key = tmp_path / "test-key.pem"
    write_test_certificate(certificate, key)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)
    requests = []

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            try:
                self.request.settimeout(3)
                with context.wrap_socket(self.request, server_side=True) as sock:
                    data = b""
                    while b"\r\n\r\n" not in data:
                        chunk = sock.recv(1024)
                        if not chunk:
                            return
                        data += chunk
                    requests.append(data)
                    sock.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except (OSError, ssl.SSLError):
                pass  # Raw TCP probes close without a TLS handshake by design.

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], requests
    server.shutdown()
    server.server_close()
    thread.join()


def test_local_tls_cli_end_to_end(database, tls_server, tmp_path, monkeypatch, capsys):
    port, requests = tls_server
    original = socket.getaddrinfo

    def loopback_only(host, requested_port, **kwargs):
        assert host == "127.0.0.1"
        return original(host, port, **kwargs)

    monkeypatch.setattr(diag.socket, "getaddrinfo", loopback_only)
    monkeypatch.setattr(diag, "command_step", lambda command: {"outcome": "skipped", "ms": 0})
    monkeypatch.setattr(diag, "backend_environments", lambda project: [])
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)
    output = tmp_path / "result.json"
    assert diag.main(["--db", str(database), "--parallel", "6", "--json", str(output)]) == 0
    report = json.loads(output.read_text())
    result = report["devices"][0]
    assert result["classification"] == "ok"
    assert result["steps"]["http"]["status"] == 200
    assert len(result["steps"]["tcp"]["attempts"]) == 3
    assert len(result["steps"]["parallel"]["attempts"]) == 6
    assert result["steps"]["tls"]["protocol"].startswith("TLS")
    assert requests == [b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"]
    assert "secret" not in output.read_text()
    assert "not proof that servers or outlets are off" in capsys.readouterr().out


def test_refused_port_skips_tls_and_parallel(database, monkeypatch):
    # Keep a bound, non-listening port reserved to avoid a port allocation race.
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        with closing(diag.open_database(database)) as connection:
            device = diag.read_devices(connection)[0]
        monkeypatch.setattr(diag, "command_step", lambda command: {"outcome": "skipped", "ms": 0})
        result = diag.diagnose(device, environment={}, port=reserved.getsockname()[1])
    assert result["classification"] == "tcp_refused"
    assert len(result["steps"]["tcp"]["attempts"]) == 3
    assert result["steps"]["parallel"]["outcome"] == "skipped"
    assert result["steps"]["tls"]["outcome"] == "skipped"


def test_json_cannot_overwrite_inventory(database, monkeypatch, capsys):
    monkeypatch.setattr(diag, "backend_environments", lambda project: [])
    before = database.read_bytes()
    assert diag.main(["--db", str(database), "--device", "absent", "--json", str(database)]) == 0
    assert database.read_bytes() == before
    assert "destination is the inventory" in capsys.readouterr().err


def test_database_error_exit(tmp_path):
    assert diag.main(["--db", str(tmp_path / "missing.db")]) == 2


def test_unexpected_device_failure_is_reported_and_exit_is_zero(database, monkeypatch, capsys):
    monkeypatch.setattr(diag, "backend_environments", lambda project: [])
    def broken(*args, **kwargs):
        raise RuntimeError("https://user:password-secret@lab")
    monkeypatch.setattr(diag, "diagnose", broken)
    assert diag.main(["--db", str(database), "--workers", "2"]) == 0
    out = capsys.readouterr().out
    assert "diagnostic_error" in out and "RuntimeError" in out and "secret" not in out


def test_devices_are_checked_concurrently(database, monkeypatch, capsys):
    connection = sqlite3.connect(database)
    connection.executemany("INSERT INTO devices VALUES (?, ?, 'kvm', '127.0.0.1', 1, 'rack', '', '')",
                           [(f"kvm{i}", f"KVM {i}") for i in range(4)])
    connection.commit()
    connection.close()
    monkeypatch.setattr(diag, "backend_environments", lambda project: [])
    barrier = threading.Barrier(4, timeout=5)
    def slow(device, parallel=6, backend=None):
        if device["id"].startswith("kvm"):
            barrier.wait()
        return {"device": device, "steps": {}, "classification": "ok", "explanation": "test"}
    monkeypatch.setattr(diag, "diagnose", slow)
    assert diag.main(["--db", str(database), "--workers", "4"]) == 0
    out = capsys.readouterr().out
    assert "diagnostic_error" not in out and "Summary: ok=5" in out


@pytest.mark.parametrize("argument", [["--workers", "0"], ["--workers", "17"], ["--parallel", "0"]])
def test_out_of_range_concurrency_is_a_usage_error(database, argument):
    with pytest.raises(SystemExit) as error:
        diag.main(["--db", str(database), *argument])
    assert error.value.code == 2
