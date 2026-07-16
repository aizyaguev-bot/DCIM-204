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

TIMEOUT = 6.0


class RaritanKvmError(Exception):
    pass


class RaritanKvmDriver:
    def __init__(self, ip: str, username: str, password: str, model: str = "KX III"):
        self.ip = ip
        self.base_url = f"https://{ip}"
        self.username = username
        self.password = password
        self.model = model
        self._client: httpx.AsyncClient | None = None

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
        """Returns True if the KVM is reachable (any HTTP response)."""
        try:
            client = await self._client_ctx()
            resp = await client.get(f"{self.base_url}/")
            return resp.status_code < 500
        except Exception:
            return False

    async def get_ports(self, port_count: int = 0) -> list[dict]:
        """
        Returns list of { number, label, status } for all KVM ports.
        KX III: REST API first. LX II / fallback: scrape sidebar.asp so that
        ports without a configured target are marked 'empty' automatically.
        """
        if "LX" not in self.model:
            try:
                return await self._get_ports_rest()
            except RaritanKvmError:
                pass
        # LX II (and KX III older firmware): scrape sidebar.asp
        try:
            return await self._get_ports_sidebar(port_count)
        except Exception:
            pass
        # Final fallback: static list (can't distinguish empty from idle)
        return [{"number": i + 1, "label": f"Port {i + 1}", "status": "idle"}
                for i in range(port_count)]

    async def _get_ports_sidebar(self, port_count: int) -> list[dict]:
        """
        Scrape sidebar.asp to find which port numbers have targets configured.
        Tries HTTP Basic auth first; falls back to form-POST session auth.
        Configured ports → 'idle', unconfigured ports → 'empty'.
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
                 "status": "idle" if (i + 1) in configured else "empty"}
                for i in range(port_count)
            ]

        # Attempt 1: Basic auth (works on most KX III / LX II firmware)
        client = await self._client_ctx()
        resp = await client.get(f"{self.base_url}/sidebar.asp")
        if resp.status_code == 200:
            nums = _extract_configured(resp.text)
            if nums:
                return _build(nums)

        # Attempt 2: form-POST session auth (needed on some LX II firmware)
        async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=TIMEOUT) as sc:
            await sc.post(
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
            resp2 = await sc.get(f"{self.base_url}/sidebar.asp")
            if resp2.status_code == 200:
                nums = _extract_configured(resp2.text)
                if nums:
                    return _build(nums)

        raise RaritanKvmError("sidebar.asp: no configured ports found")

    async def _get_ports_rest(self) -> list[dict]:
        """KX III newer firmware: REST API at /api/v1/targets."""
        client = await self._client_ctx()
        resp = await client.get(f"{self.base_url}/api/v1/targets")
        if resp.status_code != 200:
            raise RaritanKvmError(f"HTTP {resp.status_code}")
        data = resp.json()
        targets = data if isinstance(data, list) else data.get("targets", data.get("list", []))
        ports = []
        for i, t in enumerate(targets):
            label = t.get("name", t.get("label", t.get("targetName", f"Port {i+1}")))
            raw_status = t.get("connectionStatus", t.get("status", t.get("state", "idle")))
            status = _parse_kvm_status(raw_status)
            ports.append({"number": i + 1, "label": label, "status": status})
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


def _parse_kvm_status(raw) -> str:
    if not raw:
        return "idle"
    s = str(raw).lower().strip()
    if s in ("connected", "active", "in-use", "inuse", "1", "true", "busy"):
        return "active"
    if s in ("empty", "none", "no-target", "notarget", "0",
             "disconnected", "down", "not-connected", "not connected",
             "unavailable", "not available", "notconfigured",
             "not configured", "not_configured"):
        return "empty"
    return "idle"
