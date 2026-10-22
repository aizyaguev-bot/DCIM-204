"""
Raritan Dominion KVM driver.

Supports two device generations:
  KX III / KX IV: REST API at /api/v1/ (newer firmware).
                  Falls back to static port list on older firmware.
  LX II:          No REST API. Returns static port list + direct launch link.

SSL verification disabled for lab self-signed certs.
"""

import re
import httpx
from typing import Optional

TIMEOUT = httpx.Timeout(6.0, connect=6.0, read=6.0)

AUTH_FAILED = "Device API authentication failed"
_NAME_UNSUPPORTED = "Port names cannot be written to this KVM yet"


class RaritanKvmError(Exception):
    pass


class RaritanKvmAuthError(RaritanKvmError):
    pass


def _rejected(resp: httpx.Response) -> bool:
    """The device answered but refused the saved credentials."""
    return resp.status_code in (401, 403) or (resp.status_code == 200 and _is_login_page(resp.text))


def _is_login_page(text: str) -> bool:
    lowered = text.lower()
    return "action_login" in lowered or bool(re.search(r"<input[^>]+type\s*=\s*[\"']?password", lowered))


class RaritanKvmDriver:
    def __init__(self, ip: str, username: str, password: str, model: str = "KX III"):
        self.ip = ip
        self.base_url = f"https://{ip}"
        self.username = username
        self.password = password
        self.model = model
        self._client: httpx.AsyncClient | None = None
        # Set by get_ports() when the device answered but rejected the credentials.
        self.auth_error: Optional[str] = None

    async def _client_ctx(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                auth=(self.username, self.password),
                verify=False,
                timeout=TIMEOUT,
                follow_redirects=True,
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def ping(self) -> bool:
        """Keep the legacy boolean check; probe() preserves failure details."""
        return await self.probe() is None

    async def probe(self) -> Optional[str]:
        """Return a safe failure class, or None for a usable HTTP response.

        Never return exception text: it may contain credentials, request URLs,
        or response bodies. Authentication at the root is firmware dependent,
        so ordinary 4xx responses still establish reachability as before.
        """
        try:
            client = await self._client_ctx()
            resp = await client.get(f"{self.base_url}/")
            if resp.status_code >= 500:
                return f"Device API responded with HTTP {resp.status_code}"
            if resp.status_code == 407:
                return "Device API proxy error (HTTP 407)"
            return None
        except Exception as exc:
            return classify_error(exc)

    async def get_ports(self, port_count: int = 0) -> list[dict]:
        """
        Returns list of { number, label, status } for all KVM ports.
        KX III: REST API first. LX II / fallback: scrape sidebar.asp so that
        ports without a configured target are marked 'empty' automatically.

        When every sign-in method is refused, sets self.auth_error. KX III then
        returns no ports; LX II keeps its designed static list.
        """
        self.auth_error = None
        lx = "LX" in self.model
        basic_rejected = False
        if not lx:
            try:
                return await self._get_ports_rest()
            except RaritanKvmAuthError:
                basic_rejected = True
            except RaritanKvmError:
                pass
        # LX II (and KX III older firmware): scrape sidebar.asp
        try:
            return await self._get_ports_sidebar(port_count, basic_rejected=basic_rejected)
        except RaritanKvmAuthError:
            self.auth_error = AUTH_FAILED
            if not lx:
                return []
        except Exception:
            pass
        # Final fallback: static list (can't distinguish empty from idle)
        return [{"number": i + 1, "label": f"Port {i + 1}", "status": "idle", "status_source": "unknown"}
                for i in range(port_count)]

    async def name_support(self) -> tuple[bool, str]:
        """No port-name write method has been positively identified yet."""
        return False, _NAME_UNSUPPORTED

    async def get_port_names(self) -> dict[int, str]:
        """Return only names tied to explicit physical ports by the REST API.

        Sidebar and static discovery synthesize labels, so they cannot establish
        the name stored on the device. Failed or unknown responses stay unknown.
        """
        if self.auth_error or not isinstance(self.model, str) or "LX" in self.model:
            return {}
        try:
            client = await self._client_ctx()
            resp = await client.get(f"{self.base_url}/api/v1/targets")
            if resp.status_code in (401, 403):
                self.auth_error = AUTH_FAILED
                return {}
            if resp.status_code != 200:
                return {}

            data = resp.json()
            if isinstance(data, list):
                targets = data
            elif isinstance(data, dict):
                targets = data.get("targets", data.get("list"))
            else:
                return {}
            if not isinstance(targets, list):
                return {}

            names = {}
            for target in targets:
                if not isinstance(target, dict):
                    continue
                raw_number = target.get("portNumber")
                if type(raw_number) is int:
                    number = raw_number
                elif isinstance(raw_number, str) and re.fullmatch(r"[0-9]+", raw_number):
                    number = int(raw_number)
                else:
                    continue
                name = target.get("name")
                if number <= 0 or not isinstance(name, str):
                    continue
                if re.fullmatch(r"Port [0-9]+", name.strip()):
                    continue
                names[number] = name
            return names
        except Exception:
            # Do not return exception text or device bodies, or guess via fallback.
            return {}

    async def set_port_name(self, port_number: int, name: str) -> str:
        """Refuse writes until a supported firmware method is implemented."""
        raise RaritanKvmError(_NAME_UNSUPPORTED)

    def _session_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(verify=False, follow_redirects=True, timeout=TIMEOUT)

    async def _get_ports_sidebar(self, port_count: int, basic_rejected: bool = False) -> list[dict]:
        """
        Scrape sidebar.asp to find which port numbers have targets configured.
        Tries HTTP Basic auth first; falls back to form-POST session auth.
        Configured ports → 'idle', unconfigured ports → 'empty'.
        Raises RaritanKvmAuthError as soon as the form sign-in is refused too,
        so a wrong password costs no further requests.
        """
        def _extract_configured(text: str) -> set[int]:
            nums: set[int] = set()
            for m in re.finditer(r"J\('PortId','[^']+'\).*?J\('PortNumber',(\d+)\)", text):
                n = int(m.group(1))
                if n > 0:
                    nums.add(n)
            return nums

        def _build(configured: set[int]) -> list[dict]:
            return [
                {"number": i + 1, "label": f"Port {i + 1}",
                 "status": "idle" if (i + 1) in configured else "empty", "status_source": "configured"}
                for i in range(port_count)
            ]

        # Attempt 1: Basic auth (works on most KX III / LX II firmware).
        # Skipped when the REST API already refused the same Basic credentials.
        if not basic_rejected:
            client = await self._client_ctx()
            resp = await client.get(f"{self.base_url}/sidebar.asp")
            if resp.status_code == 200 and not _is_login_page(resp.text):
                nums = _extract_configured(resp.text)
                if nums:
                    return _build(nums)

        # Attempt 2: form-POST session auth (needed on some LX II firmware)
        async with self._session_client() as sc:
            login = await sc.post(
                f"{self.base_url}/auth.asp",
                params={"client": "javascript"},
                data={
                    "login": self.username, "password": self.password,
                    "PIN": "", "is_dotnet": "0", "is_javafree": "0",
                    "is_standalone_client": "0",
                    "is_javascript_kvm_client": "1",
                    "is_javascript_rsc_client": "1",
                    "action_login": "Login",
                },
            )
            # A login page with a session cookie may still be a working session;
            # sidebar.asp below decides that case.
            if login.status_code in (401, 403) or (_rejected(login) and not sc.cookies):
                raise RaritanKvmAuthError("sign-in refused")
            resp2 = await sc.get(f"{self.base_url}/sidebar.asp")
            if _rejected(resp2):
                raise RaritanKvmAuthError("sign-in refused")
            if resp2.status_code == 200:
                nums = _extract_configured(resp2.text)
                if nums:
                    return _build(nums)

        raise RaritanKvmError("sidebar.asp: no configured ports found")

    async def _get_ports_rest(self) -> list[dict]:
        """KX III newer firmware: REST API at /api/v1/targets."""
        client = await self._client_ctx()
        resp = await client.get(f"{self.base_url}/api/v1/targets")
        if resp.status_code in (401, 403):
            raise RaritanKvmAuthError(f"HTTP {resp.status_code}")
        if resp.status_code != 200:
            raise RaritanKvmError(f"HTTP {resp.status_code}")
        data = resp.json()
        targets = data if isinstance(data, list) else data.get("targets", data.get("list", []))
        ports = []
        for i, t in enumerate(targets):
            label = t.get("name", t.get("label", t.get("targetName", f"Port {i+1}")))
            raw_status = t.get("connectionStatus", t.get("status", t.get("state")))
            status = _parse_kvm_status(raw_status)
            raw_number = t.get("portNumber", t.get("number"))
            number = int(raw_number) if str(raw_number).isdigit() and int(raw_number) > 0 else i + 1
            # An inferred row number or an undocumented state cannot establish
            # the health of a particular physical port.
            known = raw_status is not None and str(raw_status).strip().lower() in {
                "connected", "active", "in-use", "inuse", "1", "true", "busy",
                "idle", "available", "up", "online", "free", "ready",
                "empty", "none", "no-target", "notarget", "0", "false",
                "disconnected", "down", "not-connected", "not connected",
                "unavailable", "not available", "notconfigured", "not configured", "not_configured",
            }
            numbered = str(raw_number).isdigit() and int(raw_number) > 0
            ports.append({"number": number, "label": label, "status": status,
                          "status_source": "live" if numbered and known else "unknown"})
        return ports

    def get_viewer_url(self, port_number: int) -> dict:
        """
        Returns { embed_url, launch_url, can_embed }.
        KX III / LX II: use the HTML5 viewer at /html5/ (requires one-time browser login).
        """
        base = self.base_url
        embed_url = f"{base}/html5/"
        launch_url = f"{base}/html5/"
        return {"embed_url": embed_url, "launch_url": launch_url, "can_embed": True}

    async def get_session_token(self) -> Optional[str]:
        """Logs in via REST API and returns a session token (KX III newer firmware only)."""
        client = await self._client_ctx()
        try:
            resp = await client.post(
                f"{self.base_url}/api/v1/auth/login",
                json={"username": self.username, "password": self.password},
            )
            if resp.status_code == 200:
                return resp.json().get("token")
        except Exception:
            pass
        return None


def classify_error(exc: Exception) -> str:
    """Map a request failure to a fixed failure class without its message text."""
    if isinstance(exc, httpx.ConnectTimeout):
        return "Device API connection timeout (ConnectTimeout)"
    if isinstance(exc, httpx.TimeoutException):
        return f"Device API request timeout ({type(exc).__name__})"
    if isinstance(exc, httpx.ProxyError):
        return "Device API proxy error (ProxyError)"
    if isinstance(exc, httpx.RequestError):
        text = str(exc).lower()
        if any(token in text for token in (
            "name or service not known", "nodename nor servname", "getaddrinfo",
            "temporary failure in name resolution",
        )):
            return "Device API DNS failure (getaddrinfo)"
        if "connection refused" in text or re.search(r"\berrno\s+111\b", text):
            return "Device API connection refused"
        if any(token in text for token in ("no route to host", "network is unreachable")) or re.search(r"\berrno\s+(?:113|101)\b", text):
            return "Device API network unreachable"
        if any(token in text for token in ("ssl", "certificate", "handshake")):
            return "Device API TLS handshake error"
        return "Device API connection error"
    return "Device API probe failed"


def _parse_kvm_status(raw) -> str:
    if raw is None or raw == "":
        return "idle"
    s = str(raw).lower().strip()
    if s in ("connected", "active", "in-use", "inuse", "1", "true", "busy"):
        return "active"
    if s in ("empty", "none", "no-target", "notarget", "0", "false",
             "disconnected", "down", "not-connected", "not connected",
             "unavailable", "not available", "notconfigured",
             "not configured", "not_configured"):
        return "empty"
    return "idle"
