#!/usr/bin/env python3
"""Read-only, credential-free device management connectivity diagnostic (Python 3.10+)."""
import argparse
import ast
from concurrent.futures import ThreadPoolExecutor
import errno
from functools import lru_cache
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import ssl
import statistics
import subprocess
import sys
import time
from urllib.parse import urlsplit

TIMEOUT = 10.0
PROXY_NAMES = {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
NOTICE = "A failed management API check is not proof that servers or outlets are off."
MONITOR_LINKS = Path(__file__).resolve().parents[1] / "backend" / "app" / "monitor_links.py"
_API_PATH = " This describes the management API path from the VM, not server power."
# Copy of every backend/app/monitor_links.py::failure_reason result, used when the backend
# source cannot be read (kept identical by tests).
FALLBACK_MONITOR_SENTENCES = (
    "Proxy error: the VM could not access the device management API through its proxy. Check proxy access and authentication." + _API_PATH,
    "Device authentication failed. Check the saved username, password and permissions.",
    "Connection timeout: the VM could not establish a connection to the device API. The connect phase includes the TLS handshake, so a slow handshake can also cause this. Check the address, HTTPS access and network." + _API_PATH,
    "Device API request timeout: receiving data from the device took too long. Check device load and network stability.",
    "Device API request timeout: a local connection slot was not available in time. This does not establish a device outage.",
    "The device API did not respond before its request timeout.",
    "DNS failure: the VM could not resolve the device management API address. Check the hostname and VM DNS configuration." + _API_PATH,
    "Connection refused: the device management API connection from the VM was refused. Check the HTTPS service, port and firewall rules." + _API_PATH,
    "Network unreachable: the VM has no usable network path to the device management API. Check routing and network access." + _API_PATH,
    "TLS error: the VM could not complete a secure connection to the device management API. Check TLS configuration and certificates." + _API_PATH,
    "Device management API responded with HTTP 5xx to the VM. Check the device service and load." + _API_PATH,
    "Could not connect to the device API from the VM. Check the address and network.",
    "The device API returned no usable status. Check the device service and configuration.",
)
STATUS_TIMEOUT = re.compile(r"Device status timed out after (\d{1,4}) seconds\.")
STATUS_TIMEOUT_SENTENCE = "Device status timed out after {} seconds. Check device load and VM network access."
UNRECOGNIZED_DETAIL = "Unrecognized stored diagnostic (hidden)"
LEGACY_EXCEPTION_CLASSES = ("ConnectTimeout", "ReadTimeout", "ConnectError", "PoolTimeout",
                            "HTTPStatusError", "SSLError", "TimeoutError", "ConnectionRefusedError")


def failure_sentences_from_source(source):
    """Every string failure_reason() can return, read from its source without importing the backend."""
    tree = ast.parse(source)
    function = next(node for node in tree.body
                    if isinstance(node, ast.FunctionDef) and node.name == "failure_reason")
    names = {node.targets[0].id: node.value.value for node in ast.walk(function)
             if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
             and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)}

    def value(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name) and node.id in names:
            return names[node.id]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return value(node.left) + value(node.right)
        raise ValueError("failure_reason returns a non-constant value")

    sentences = tuple(value(node.value) for node in ast.walk(function) if isinstance(node, ast.Return))
    if not sentences:
        raise ValueError("failure_reason has no return value")
    return sentences


@lru_cache(maxsize=None)
def monitor_sentences(path=MONITOR_LINKS):
    try:
        found = failure_sentences_from_source(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, SyntaxError, ValueError, StopIteration):
        found = ()
    return tuple(dict.fromkeys(found + FALLBACK_MONITOR_SENTENCES))


def _first_sentence(text):
    return re.match(r"[^.]*\.?", text).group(0)


def elapsed(start):
    return round((time.perf_counter() - start) * 1000, 2)


def open_database(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def read_devices(connection, selector=None):
    sql = "SELECT id,name,kind,ip,enabled,rack FROM devices WHERE kind IN ('pdu','kvm')"
    params = ()
    if selector:
        sql += " AND (id=? OR ip=?)"
        params = (selector, selector)
    devices = [dict(row) for row in connection.execute(sql + " ORDER BY id", params)]
    for device in devices:
        device["last_error"] = None
        device["last_snapshot"] = None
        for table, columns, key in (
            ("monitor_device_errors", "checked_at,detail", "last_error"),
            ("monitor_device_snapshots", "checked_at,reachable", "last_snapshot"),
        ):
            try:
                row = connection.execute(
                    f"SELECT {columns} FROM {table} WHERE device_id=? ORDER BY checked_at DESC LIMIT 1",
                    (device["id"],),
                ).fetchone()
                if row:
                    value = dict(row)
                    if "detail" in value:
                        value["detail"] = safe_detail(value["detail"])
                    device[key] = value
            except sqlite3.OperationalError as exc:
                if "no such table" not in str(exc):
                    raise
    return devices


def safe_detail(detail):
    # Stored detail may come from older versions that kept authenticated URLs, tokens or
    # response bodies. The result is always one of our own constants, never stored text.
    detail = (detail or "").strip()
    if not detail:
        return ""
    first = _first_sentence(detail)
    for sentence in monitor_sentences():
        if first == _first_sentence(sentence):
            return sentence
    timeout = STATUS_TIMEOUT.fullmatch(first)
    if timeout:
        return STATUS_TIMEOUT_SENTENCE.format(int(timeout.group(1)))
    classes = [name for name in LEGACY_EXCEPTION_CLASSES if re.search(rf"\b{name}\b", detail)]
    return ", ".join(classes) or UNRECOGNIZED_DETAIL


def proxy_environment(environment):
    # Lowercase takes precedence as in urllib/httpx. CGI HTTP_PROXY is ignored.
    result = {}
    for key, value in environment.items():
        if key.lower() in PROXY_NAMES and value:
            result[key.lower()] = value
    for key, value in environment.items():
        if key in PROXY_NAMES:
            result[key] = value
    if "REQUEST_METHOD" in environment and "http_proxy" not in environment:
        result.pop("http_proxy", None)
    return {key: value for key, value in result.items() if value}


def mask_proxy(value):
    try:
        parsed = urlsplit(value if "://" in value else "//" + value)
        host = parsed.hostname
        if not host:
            return "<invalid proxy URL>"
        host = f"[{host}]" if ":" in host else host
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return f"{parsed.scheme + '://' if parsed.scheme else ''}{'***@' if '@' in parsed.netloc else ''}{host}:{port}"
    except ValueError:
        return "<invalid proxy URL>"


def _host_pattern_matches(host, pattern):
    if pattern.startswith("*."):
        return host.endswith(pattern[1:])
    if pattern.startswith("*"):
        return host == pattern[1:] or host.endswith("." + pattern[1:])
    return host == pattern


def _ip_entry(token):
    try:
        return ipaddress.ip_address(token.split("/")[0].strip("[]"))
    except ValueError:
        return None


def bypass_proxy(host, no_proxy):
    """NO_PROXY as httpx 0.28 (the backend's client) evaluates it for https://<host>/.

    httpx matches '*', exact IP and localhost entries and domain suffixes; it does NOT
    honour CIDR ranges (10.0.0.0/8 only matches the address 10.0.0.0), unlike curl.
    """
    host = host.strip("[]").lower().rstrip(".")
    for token in (entry.strip().lower() for entry in no_proxy.split(",")):
        if not token:
            continue
        if token == "*":
            return True
        if "://" in token:
            try:
                parsed = urlsplit(token)
                port = parsed.port
            except ValueError:
                continue
            if (parsed.scheme in ("https", "all") and port in (None, 443)
                    and _host_pattern_matches(host, (parsed.hostname or "").rstrip("."))):
                return True
        elif _ip_entry(token) is not None:
            if host == str(_ip_entry(token)):
                return True
        elif token == "localhost":
            if host == token:
                return True
        elif _host_pattern_matches(host, "*" + token.rstrip(".")):
            return True
    return False


def cidr_ignored(host, no_proxy):
    """CIDR NO_PROXY entries that contain the address but are ignored by httpx."""
    address = _ip_entry(host)
    ignored = []
    for token in (entry.strip() for entry in no_proxy.split(",")):
        if address is None or "/" not in token or "://" in token:
            continue
        try:
            network = ipaddress.ip_network(token.strip("[]"), strict=False)
        except ValueError:
            continue
        if address in network and address != network.network_address:
            ignored.append(token)
    return ignored


def proxy_report(environment, host):
    effective = proxy_environment(environment)
    proxy = effective.get("https_proxy") or effective.get("all_proxy")
    no_proxy = effective.get("no_proxy", "")
    bypassed = bypass_proxy(host, no_proxy)
    return {
        "variables": {key: (("<configured>" if "@" in value else value) if key.lower() == "no_proxy"
                            else mask_proxy(value))
                      for key, value in environment.items() if key.lower() in PROXY_NAMES},
        "bypassed": bypassed,
        "would_proxy": bool(proxy) and not bypassed,
        "proxy": mask_proxy(proxy) if proxy else None,
        "cidr_ignored_by_httpx": cidr_ignored(host, no_proxy) if proxy and not bypassed else [],
    }


def backend_environments(project):
    found = []
    if not sys.platform.startswith("linux"):
        return found
    backend = (Path(project) / "backend").resolve()
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid != os.getuid() or (process / "cwd").resolve() != backend:
                continue
            command = (process / "cmdline").read_bytes().split(b"\0")
            if b"app.main:app" not in command or not any(b"uvicorn" in arg for arg in command):
                continue
            environment = {}
            for entry in (process / "environ").read_bytes().split(b"\0"):
                key, sep, value = entry.partition(b"=")
                name = key.decode(errors="replace")
                if sep and (name.lower() in PROXY_NAMES or name == "REQUEST_METHOD"):
                    environment[name] = value.decode(errors="replace")
            found.append({"pid": int(process.name), "environment": environment})
        except (OSError, RuntimeError):
            continue
    return found


def nameservers():
    try:
        return [line.split()[1] for line in Path("/etc/resolv.conf").read_text().splitlines()
                if line.split() and line.split()[0] == "nameserver" and len(line.split()) > 1]
    except OSError:
        return []


def command_step(command):
    start = time.perf_counter()
    if not sys.platform.startswith("linux") or not shutil.which(command[0]):
        return {"outcome": "skipped", "ms": elapsed(start)}
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5, check=False)
        step = {"outcome": "ok" if result.returncode == 0 else "failed", "ms": elapsed(start)}
        if command[0] == "ip":
            words = result.stdout.split()
            for field in ("dev", "src", "via"):
                if field in words and words.index(field) + 1 < len(words):
                    step[field] = words[words.index(field) + 1]
            if "unreachable" in result.stdout or "Network is unreachable" in result.stderr:
                step["outcome"] = "no_route"
        return step
    except (OSError, subprocess.TimeoutExpired):
        return {"outcome": "failed", "ms": elapsed(start)}


def failure(exc):
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return "timeout"
    if getattr(exc, "errno", None) == errno.ECONNREFUSED:
        return "refused"
    if getattr(exc, "errno", None) in (errno.EHOSTUNREACH, errno.ENETUNREACH):
        return "no_route"
    return "failed"


def connect(endpoint):
    family, socktype, proto, _, sockaddr = endpoint
    sock = socket.socket(family, socktype, proto)
    sock.settimeout(TIMEOUT)
    try:
        sock.connect(sockaddr)
        return sock
    except BaseException:
        sock.close()
        raise


def tls_connection(endpoint, host):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    start = time.perf_counter()
    raw = connect(endpoint)
    tcp_ms = elapsed(start)
    try:
        wrapped = context.wrap_socket(raw, server_hostname=host, do_handshake_on_connect=False)
        handshake_start = time.perf_counter()
        try:
            wrapped.do_handshake()
            return wrapped, {"outcome": "ok", "ms": elapsed(start), "tcp_ms": tcp_ms,
                             "handshake_ms": elapsed(handshake_start),
                             "protocol": wrapped.version(), "cipher": wrapped.cipher()[0]}
        except BaseException:
            wrapped.close()
            raise
    except BaseException:
        raw.close()
        raise


def http_step(sock, host):
    start = time.perf_counter()
    ttfb = None
    try:
        authority = f"[{host}]" if ":" in host else host
        sock.sendall(f"GET / HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n".encode("ascii"))
        data = sock.recv(1)
        ttfb = elapsed(start)
        if not data:
            return {"outcome": "failed", "ms": elapsed(start), "ttfb_ms": ttfb}
        # Only retain the status code. Never read or print the response body/headers.
        deadline = start + TIMEOUT
        while b"\n" not in data and len(data) < 4096:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                raise TimeoutError
            sock.settimeout(remaining)
            chunk = sock.recv(1)
            if not chunk:
                break
            data += chunk
        match = re.match(rb"HTTP/\d\.\d ([0-9]{3})(?: |\r|\n)", data)
        return {"outcome": "ok" if match else "failed", "ms": elapsed(start),
                "ttfb_ms": ttfb, "status": int(match.group(1)) if match else None}
    except (OSError, ValueError, UnicodeError) as exc:
        return {"outcome": failure(exc), "ms": elapsed(start), "ttfb_ms": ttfb}


def parallel_step(endpoint, host, count, budget_ms):
    start = time.perf_counter()
    def probe(_):
        probe_start = time.perf_counter()
        try:
            sock, result = tls_connection(endpoint, host)
            sock.close()
            return result
        except OSError as exc:
            return {"outcome": failure(exc), "ms": elapsed(probe_start)}
    with ThreadPoolExecutor(max_workers=count) as pool:
        attempts = list(pool.map(probe, range(count)))
    times = [attempt["ms"] for attempt in attempts if attempt["outcome"] == "ok"]
    # httpx applies the connect timeout to the TCP connect and to the TLS handshake separately.
    phases = [max(attempt["tcp_ms"], attempt["handshake_ms"]) for attempt in attempts
              if attempt["outcome"] == "ok"]
    return {"outcome": "ok" if len(times) == count else "failed", "ms": elapsed(start),
            "attempts": attempts, "min_ms": min(times) if times else None,
            "median_ms": statistics.median(times) if times else None,
            "max_ms": max(times) if times else None,
            "exceeded_3s": sum(phase > 3000 for phase in phases),
            "exceeded_budget": sum(phase > budget_ms for phase in phases),
            "failed": count - len(times)}


def classify(result):
    code, explanation = classify_direct(result)
    result["direct_classification"] = code
    proxy = result["steps"]["proxy"]
    reports = proxy["backend"] or ([proxy["current"]] if "current" in proxy else [])
    proxied = [report for report in reports if report["would_proxy"]]
    if proxied:
        source = "Backend" if proxy["backend"] else "Current shell (backend process not found)"
        note = ""
        if any(report.get("cidr_ignored_by_httpx") for report in proxied):
            note = " NO_PROXY has a matching CIDR range, but httpx ignores CIDR entries; list the IP."
        return "proxied", (f"{source} environment sends this device's HTTPS through proxy "
                           f"{proxied[0].get('proxy')}, so the app does not use the direct path tested here "
                           f"(direct path: {code}).{note}")
    return code, explanation


def classify_direct(result):
    steps = result["steps"]
    budget = result.get("connect_budget_ms", 3000)
    if steps["address"]["outcome"] != "ok":
        return "dns_failure", "Address cannot be resolved; check inventory and DNS."
    tcp = steps["tcp"]
    if tcp["outcome"] != "ok":
        code = {"refused": "tcp_refused", "no_route": "no_route", "timeout": "tcp_timeout"}.get(tcp["outcome"], "tcp_failure")
        explanation = {
            "tcp_refused": "TCP connection rejected; check management HTTPS service and firewall rejects.",
            "no_route": "No route to management address; check interface, gateway and VLAN.",
            "tcp_timeout": "No SYN-ACK within 10s; possible device down, wrong IP, VLAN or firewall drop.",
            "tcp_failure": "TCP connection failed; check management address and host networking.",
        }[code]
        return code, explanation
    if steps["tls"]["outcome"] != "ok":
        return "tls_failure", "TCP answers but TLS fails or times out; app ConnectTimeout can include TLS."
    if any(a["outcome"] == "ok" and a["ms"] > budget for a in tcp["attempts"]):
        return "tcp_slow", f"TCP answers but exceeds the app's {budget / 1000:g}s connect budget."
    if steps["tls"].get("handshake_ms", steps["tls"]["ms"]) > budget:
        return "tls_slow", (f"TLS handshake exceeds the app's {budget / 1000:g}s connect budget; "
                            "httpx reports this as ConnectTimeout although the device answers.")
    if steps["parallel"].get("failed") or steps["parallel"].get("exceeded_budget"):
        return "parallel_tls_slow", "Concurrent TCP+TLS handshakes fail or exceed the connect budget."
    http = steps["http"]
    if http["outcome"] == "timeout" or (http.get("ttfb_ms") or 0) > 6000:
        return "http_slow", "HTTP response exceeds the 6s read budget; can cause ReadTimeout."
    if http["outcome"] != "ok":
        return "http_failure", "TLS answers but the root page gives no valid HTTP status."
    return "ok", "Direct unauthenticated HTTPS root responds; authenticated API health is untested."


def diagnose(device, parallel=6, backend=None, environment=None, port=443):
    result = {"device": device, "connect_budget_ms": 3000 if device["kind"] == "pdu" else 6000,
              "port": port, "steps": {}}
    steps = result["steps"]
    host = device["ip"]
    start = time.perf_counter()
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = False
    try:
        # Reject URL/userinfo/control characters rather than reflecting them in network requests.
        if not host or any(c in host for c in "\r\n/@"):
            raise socket.gaierror
        endpoints = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not endpoints:
            raise socket.gaierror
        steps["address"] = {"outcome": "ok", "ms": elapsed(start), "literal_ip": literal,
                            "addresses": list(dict.fromkeys(e[4][0] for e in endpoints))}
    except (OSError, UnicodeError):
        endpoints = []
        steps["address"] = {"outcome": "failed", "ms": elapsed(start), "literal_ip": literal, "addresses": []}
    proxy_start = time.perf_counter()
    steps["proxy"] = {"outcome": "ok", "ms": 0,
                      "current": proxy_report(os.environ if environment is None else environment, host),
                      "backend": [{"pid": p["pid"], **proxy_report(p["environment"], host)} for p in (backend or [])],
                      "backend_status": "found" if backend else "unknown (not found or inaccessible)"}
    steps["proxy"]["ms"] = elapsed(proxy_start)
    for name in ("route", "icmp", "tcp", "tls", "http", "parallel"):
        steps[name] = {"outcome": "skipped", "ms": 0}
    if endpoints:
        addr = endpoints[0][4][0]
        steps["route"] = command_step(["ip", "route", "get", addr])
        steps["icmp"] = command_step(["ping", "-c", "1", "-W", "2", addr])
        attempts = []
        successful = None
        start = time.perf_counter()
        for index in range(3):
            endpoint = endpoints[index % len(endpoints)]
            attempt_start = time.perf_counter()
            try:
                sock = connect(endpoint)
                sock.close()
                successful = successful or endpoint
                outcome = "ok"
            except OSError as exc:
                outcome = failure(exc)
            attempts.append({"outcome": outcome, "ms": elapsed(attempt_start), "address": endpoint[4][0]})
        steps["tcp"] = {"outcome": "ok" if successful else attempts[-1]["outcome"],
                        "ms": elapsed(start), "attempts": attempts}
        if successful:
            start = time.perf_counter()
            try:
                sock, steps["tls"] = tls_connection(successful, host)
                with sock:
                    steps["http"] = http_step(sock, host)
            except OSError as exc:
                steps["tls"] = {"outcome": failure(exc), "ms": elapsed(start)}
            steps["parallel"] = parallel_step(successful, host, parallel, result["connect_budget_ms"])
    result["classification"], result["explanation"] = classify(result)
    return result


def diagnose_safely(device, parallel=6, backend=None):
    try:
        return diagnose(device, parallel, backend)
    except Exception as exc:  # One unexpected failure must not hide the other devices.
        return {"device": device, "steps": {}, "classification": "diagnostic_error",
                "explanation": f"The diagnostic itself failed ({type(exc).__name__}); other devices are unaffected."}


def display(report):
    print(NOTICE)
    print("Nameservers: " + (", ".join(report["nameservers"]) or "unavailable"))
    for result in report["devices"]:
        device = result["device"]
        print(f"\n{device['id']}  {device['name']}  {device['kind']}  {device['ip']}  enabled={device['enabled']} rack={device['rack']}")
        print(f"{'STEP':<12} {'OUTCOME':<14} {'TIME (ms)':>12}  DETAILS")
        for name, step in result["steps"].items():
            details = {k: v for k, v in step.items() if k not in ("outcome", "ms")}
            print(f"{name:<12} {step['outcome']:<14} {step['ms']:>12.2f}  {json.dumps(details)}")
        print(f"Last error: {json.dumps(device['last_error'])}; last snapshot: {json.dumps(device['last_snapshot'])}")
        print(f"{result['classification']}: {result['explanation']}")
    counts = {}
    for result in report["devices"]:
        counts[result["classification"]] = counts.get(result["classification"], 0) + 1
    print("\nSummary: " + (", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "no matching PDU/KVM devices"))
    print("ICMP is informational; blocked ping does not mean the device is down.")
    print("Proxy evaluation uses the requested hostname/IP with httpx NO_PROXY rules (CIDR ranges are not honoured).")
    print("PDU connect budget: 3s; KVM connect budget: 6s (applied to TCP connect and TLS handshake separately); "
          "HTTP read budget: 6s.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--db", type=Path, help="Override database path (also permits non-Linux testing)")
    parser.add_argument("--json", type=Path, help="Write full sanitized diagnostic report")
    parser.add_argument("--device", help="Select inventory device by id or IP")
    parser.add_argument("--parallel", type=int, default=6, help="Concurrent handshake probes, 1-32 (default 6)")
    parser.add_argument("--workers", type=int, default=4,
                        help="Devices checked at the same time, 1-16 (default 4); an unreachable device takes ~35s")
    args = parser.parse_args(argv)
    if not 1 <= args.parallel <= 32:
        parser.error("--parallel must be between 1 and 32")
    if not 1 <= args.workers <= 16:
        parser.error("--workers must be between 1 and 16")
    if not sys.platform.startswith("linux") and args.db is None:
        parser.error("On non-Linux systems specify --db for testing")
    try:
        connection = open_database(args.db or args.project / "backend" / "lab_manager.db")
        try:
            devices = read_devices(connection, args.device)
        finally:
            connection.close()
    except (sqlite3.Error, OSError, ValueError):
        print("Database error: cannot open/read the inventory database read-only; check path and schema.", file=sys.stderr)
        return 2
    backend = backend_environments(args.project)
    print(f"Checking {len(devices)} PDU/KVM device(s), {args.workers} at a time...", file=sys.stderr, flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(lambda device: diagnose_safely(device, args.parallel, backend), devices))
    report = {"notice": NOTICE, "nameservers": nameservers(), "devices": results}
    display(report)
    if args.json:
        try:
            # Never allow the report destination to overwrite the input inventory.
            db_path = (args.db or args.project / "backend" / "lab_manager.db").resolve()
            if args.json.resolve() == db_path or (args.json.exists() and os.path.samefile(args.json, db_path)):
                print("JSON output refused: destination is the inventory database.", file=sys.stderr)
            else:
                args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        except OSError:
            print("Could not write JSON report; diagnostic results are available above.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
