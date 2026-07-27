"""
Raritan DPC PDU G4 driver — JSON-RPC 2.0 over HTTPS with Basic auth.

Discovered API (reverse-engineered from Angular bundle):
  PDU object:    POST https://{ip}/model/pdu/1
  Outlet object: POST https://{ip}/tfwopaque/pdumodel.Outlet:3.0.3/outlet.{n}  (0-indexed)
  Inlet object:  POST https://{ip}/tfwopaque/pdumodel.Inlet:3.0.3/inlet.{n}    (0-indexed)
  Sensor object: POST https://{ip}<sensor_rid>  (rid returned by getSensors)

  setPowerState params: {"pstate": 1}  (1=on, 0=off)
  cyclePowerState params: {}
"""

import asyncio
import httpx
from typing import Any

TIMEOUT = 6.0
PDU_PATH = "/model/pdu/1"
MAX_CONCURRENT = 6  # max simultaneous connections to one PDU


class RaritanPduError(Exception):
    pass


class RaritanPduDriver:
    def __init__(self, ip: str, username: str, password: str):
        self.base_url = f"https://{ip}"
        self.auth = (username, password)
        self._client: httpx.AsyncClient | None = None
        self._outlet_rids: list[str] | None = None
        self._inlet_rids: list[str] | None = None
        self._sem = asyncio.Semaphore(MAX_CONCURRENT)

    async def _client_ctx(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                auth=self.auth,
                verify=False,
                timeout=httpx.Timeout(connect=3.0, read=TIMEOUT, write=3.0, pool=1.0),
                follow_redirects=True,
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def _rpc(self, rid_path: str, method: str, params: Any = None) -> Any:
        """POST a JSON-RPC 2.0 call to the given path, return result._ret_ or raise."""
        client = await self._client_ctx()
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params if params is not None else [],
            "id": 1,
        }
        try:
            async with self._sem:
                resp = await client.post(f"{self.base_url}{rid_path}", json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RaritanPduError(f"HTTP {e.response.status_code}: {e.response.text[:200]}")
        except httpx.RequestError as e:
            raise RaritanPduError(f"Connection error: {e}")

        data = resp.json()
        if "error" in data:
            code = data["error"].get("code", "?")
            msg = data["error"].get("message", "")
            raise RaritanPduError(f"RPC error {code}: {msg}")
        return data.get("result", {}).get("_ret_")

    # ------------------------------------------------------------------
    # Internal: discover and cache RIDs
    # ------------------------------------------------------------------

    async def _get_outlet_rids(self) -> list[str]:
        if self._outlet_rids is None:
            outlets = await self._rpc(PDU_PATH, "getOutlets")
            self._outlet_rids = [o["rid"] for o in (outlets or [])]
        return self._outlet_rids

    async def _get_inlet_rids(self) -> list[str]:
        if self._inlet_rids is None:
            inlets = await self._rpc(PDU_PATH, "getInlets")
            self._inlet_rids = [i["rid"] for i in (inlets or [])]
        return self._inlet_rids

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def ping(self) -> bool:
        try:
            await self._rpc(PDU_PATH, "getMetaData")
            return True
        except Exception:
            return False

    async def get_outlets(self) -> list[dict]:
        """Returns a list of outlet dicts: {number, label, state, watts, current, voltage}."""
        rids = await self._get_outlet_rids()
        tasks = [self._get_one_outlet(idx, rid) for idx, rid in enumerate(rids)]
        return await asyncio.gather(*tasks)

    async def _get_one_outlet(self, idx: int, rid: str) -> dict:
        outlet_num = idx + 1
        try:
            state_data, settings_data, sensors = await asyncio.gather(
                self._rpc(rid, "getState"),
                self._rpc(rid, "getSettings"),
                self._rpc(rid, "getSensors"),
            )
            power_state = (state_data or {}).get("powerState", 0)
            cycle_in_progress = (state_data or {}).get("cycleInProgress", False)
            state = "on" if power_state == 1 else ("cycling" if cycle_in_progress else "off")
            name = (settings_data or {}).get("name", "") or f"Outlet {outlet_num}"

            async def _read(sname: str):
                sinfo = (sensors or {}).get(sname)
                if sinfo and sinfo.get("rid"):
                    try:
                        r = await self._rpc(sinfo["rid"], "getReading")
                        return (r or {}).get("value")
                    except Exception:
                        pass
                return None

            p, c, v = await asyncio.gather(
                _read("activePower"),
                _read("current"),
                _read("voltage"),
            )
            return {
                "number": outlet_num,
                "label": name,
                "state": state,
                "watts":   round(float(p), 1) if p is not None else 0.0,
                "current": round(float(c), 2) if c is not None else 0.0,
                "voltage": round(float(v), 1) if v is not None else 0.0,
            }
        except Exception:
            return {
                "number": outlet_num,
                "label": f"Outlet {outlet_num}",
                "state": "unknown",
                "watts": 0.0,
                "current": 0.0,
                "voltage": 0.0,
            }

    async def set_outlet_state(self, outlet_number: int, action: str) -> bool:
        """
        outlet_number: 1-indexed (as displayed in the UI)
        action: "on" | "off" | "cycle"
        """
        rids = await self._get_outlet_rids()
        idx = outlet_number - 1
        if idx < 0 or idx >= len(rids):
            raise RaritanPduError(f"Outlet {outlet_number} out of range (max {len(rids)})")

        rid = rids[idx]
        if action == "on":
            await self._rpc(rid, "setPowerState", {"pstate": 1})
        elif action == "off":
            await self._rpc(rid, "setPowerState", {"pstate": 0})
        elif action == "cycle":
            await self._rpc(rid, "cyclePowerState", {})
        else:
            raise ValueError(f"Unknown action: {action}")
        return True

    async def get_inlet(self) -> dict:
        """Returns inlet voltage/current/power summary."""
        inlet_rids = await self._get_inlet_rids()
        if not inlet_rids:
            return {"voltage": 0.0, "current": 0.0, "watts": 0.0}

        inlet_rid = inlet_rids[0]
        result = {"voltage": 0.0, "current": 0.0, "watts": 0.0}
        try:
            sensors = await self._rpc(inlet_rid, "getSensors")
            if not sensors:
                return result
            for sname, metric in [("activePower", "watts"), ("current", "current"), ("voltage", "voltage")]:
                sinfo = sensors.get(sname)
                if sinfo and sinfo.get("rid"):
                    reading = await self._rpc(sinfo["rid"], "getReading")
                    val = (reading or {}).get("value")
                    if val is not None:
                        result[metric] = round(float(val), 2 if metric == "current" else 1)
        except RaritanPduError:
            pass
        return result
