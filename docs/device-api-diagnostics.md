# Device management API diagnostics

Run on the Linux VM from the project directory, as the same user that runs uvicorn (so the backend's proxy environment can be read):

```sh
backend/.venv/bin/python scripts/diagnose-device-api.py --project ~/DCIM-204 --json device-diagnostics.json
backend/.venv/bin/python scripts/diagnose-device-api.py --device <id-or-ip> --parallel 6
```

Options: `--device` selects one inventory device by id or IP, `--parallel` sets the concurrent handshake round per device (1-32, default 6), `--workers` sets how many devices are checked at the same time (1-16, default 4). `--db <path>` overrides the inventory location and permits non-Linux tests. Python 3.10+ is required; the script uses only the standard library. Missing `ip`, `ping`, diagnostic tables, or inaccessible backend process environments are reported or skipped. An inaccessible backend environment means its proxy use is **unknown**, not disabled. Disabled inventory devices are included and labelled.

The report separates DNS, route, informational ICMP, three TCP connections, a fresh TLS handshake, unauthenticated `GET /`, and one concurrent handshake round. It lists timings, all DNS answers, route interface/source/gateway, TLS protocol/cipher, TCP connect and handshake times, HTTP status and first-byte timing. TCP attempts rotate over DNS answers; TLS and parallel probes use the first address that connected. A large DNS answer set may contain untested addresses. Probes use direct connections; proxy use is evaluated separately from the current and backend process environments. The script reads only proxy variables from the matching current-user uvicorn process (`app.main:app`, cwd `<project>/backend`). Proxy values show host/port with userinfo masked; NO_PROXY values are printed (they hold host names and addresses only).

NO_PROXY is evaluated with the rules of httpx 0.28, the backend's HTTP client: `*`, exact IPv4/IPv6 addresses, `localhost`, and domain suffixes (`lab.example` matches it and its subdomains, `.lab.example` only subdomains). **httpx ignores CIDR ranges** such as `10.0.0.0/8`; when such a range contains the device address the report lists it under `cidr_ignored_by_httpx`, because curl and other tools would bypass the proxy while the backend does not. List management IPs explicitly instead.

Classes and next steps:

- `ok`: direct HTTPS root responds. Authenticated management API health remains untested; inspect the stored error and application logs.
- `dns_failure`: check inventory address and resolver nameservers.
- `no_route`: check management interface, gateway and VLAN routing.
- `tcp_refused`: address answers but HTTPS port rejects connections; check service/listener and firewall reject rules.
- `tcp_timeout`: no SYN-ACK within 10 seconds; device down, wrong address, VLAN isolation or firewall drops are possible. Check network path and inventory before drawing power conclusions.
- `tcp_failure`: another socket failure; check local networking and management address.
- `tcp_slow`: TCP connects but takes longer than the app connect budget. Check network delay/loss.
- `tls_failure`: TCP answers but TLS fails or times out (10 s). Check HTTPS configuration and device load; httpx reports a slow or stuck handshake as `ConnectTimeout`.
- `tls_slow`: the TLS handshake alone takes longer than the app connect budget, so the app sees `ConnectTimeout` although the device answers. Check device load and handshake latency.
- `parallel_tls_slow`: in the concurrent round, a TCP connect or TLS handshake fails or exceeds the budget. Compare device concurrency/load with application fan-out (PDU: up to 6 requests per device).
- `http_slow`: first byte arrives after six seconds, or the response times out. Check device response load; this can cause `ReadTimeout`.
- `http_failure`: TLS answers but no valid HTTP status arrives. Check HTTPS service behavior.
- `proxied`: the backend environment (or, if the backend process was not found, the current shell) would send this device's HTTPS through a proxy, so the direct-path results do not describe what the app does; the explanation names the proxy and the direct-path class. Check HTTPS_PROXY/ALL_PROXY and add the device IP to NO_PROXY in the service configuration.
- `diagnostic_error`: the script itself failed for this device (exception type shown); other devices are still reported.

Except for `proxied`, the primary class reports the earliest failed layer before latency findings; inspect all steps for simultaneous problems. PDU connect budget is three seconds, KVM six seconds, and HTTP read budget six seconds. httpx applies the connect budget to the TCP connect and the TLS handshake separately, so each is compared on its own. Each diagnostic socket connect/handshake/read timeout is ten seconds so slower responses can be distinguished from failures. An unreachable device takes about 35 seconds (three 10-second TCP attempts plus route/ping); with the default four workers, 20 unreachable devices finish in about three minutes. Proxy evaluation follows the originally requested address, not its DNS answers. HTTP_PROXY alone does not proxy HTTPS.

**A failed management API check is not proof that servers or outlets are off.** Blocked ICMP is also not proof of failure. HTTP 401/403, redirects and other status codes demonstrate an HTTP response without establishing authenticated API health.

The database is opened with SQLite `mode=ro`; only inventory identity/location fields and latest diagnostic timestamp/reachability/detail are selected. Credential columns are never selected. Stored detail is shown only when its first sentence exactly matches one of the fixed explanations written by the monitor (for example `Connection timeout: ...`); anything else is reduced to recognized exception names, or shown as `Unrecognized stored diagnostic (hidden)`, because older raw errors may contain secrets. The only device HTTP request is unauthenticated `GET /`, without following redirects. There are no POSTs, JSON-RPC calls, outlet/power endpoints or device mutations. Network probes do create a small amount of connection traffic. The optional JSON file contains the sanitized report; it cannot overwrite the inventory DB. Exit status is zero for device failures and two for usage or database errors.
