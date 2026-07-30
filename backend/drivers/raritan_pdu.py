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

    async def get_env_sensors(self) -> dict:
        """Returns PDU-level environmental sensors: temperature (°C), humidity (%), leak_detected (bool).
        Uses keyword matching — never raises, returns empty dict on any failure."""
        result: dict = {}
        try:
            sensors = await self._rpc(PDU_PATH, "getSensors")
            if not sensors or not isinstance(sensors, dict):
                return result

            TEMP_KEYS = {"temperature", "temp", "ambienttemperature", "inlettemperature"}
            HUM_KEYS  = {"humidity", "relativehumidity", "rh"}
            LEAK_KEYS = {"leakdetector", "leak", "waterdetection", "flood"}

            temp_rid = hum_rid = leak_rid = None
            for name, sinfo in sensors.items():
                if not isinstance(sinfo, dict) or not sinfo.get("rid"):
                    continue
                lname = name.lower()
                if temp_rid is None and any(k in lname for k in TEMP_KEYS):
                    temp_rid = sinfo["rid"]
                elif hum_rid is None and any(k in lname for k in HUM_KEYS):
                    hum_rid = sinfo["rid"]
                elif leak_rid is None and any(k in lname for k in LEAK_KEYS):
                    leak_rid = sinfo["rid"]

            async def _safe_read(rid):
                if not rid:
                    return None
                try:
                    r = await self._rpc(rid, "getReading")
                    return r if isinstance(r, dict) else None
                except Exception:
                    return None

            temp_r = await _safe_read(temp_rid)
            hum_r  = await _safe_read(hum_rid)
            leak_r = await _safe_read(leak_rid)

            if temp_r and temp_r.get("value") is not None:
                result["temperature"] = round(float(temp_r["value"]), 1)
            if hum_r and hum_r.get("value") is not None:
                result["humidity"] = round(float(hum_r["value"]), 1)
            if leak_r and leak_r.get("value") is not None:
                result["leak_detected"] = int(leak_r["value"]) > 0
        except Exception:
            pass
        return result

    async def _get_peripheral_sensor_rids(self) -> list[dict]:
        """Walk PDU → getSensorPorts → port → getConnectedDevice → getSensors.
        Returns list of {name, rid} for every readable environmental sensor."""
        found = []
        try:
            ports = await self._rpc(PDU_PATH, "getSensorPorts")
            if not ports:
                return found
            for port in (ports if isinstance(ports, list) else []):
                port_rid = port.get("rid") if isinstance(port, dict) else port
                if not port_rid:
                    continue
                try:
                    # Try getConnectedDevice on the port
                    dev = await self._rpc(port_rid, "getConnectedDevice")
                    dev_rid = (dev or {}).get("rid") if isinstance(dev, dict) else dev
                    if dev_rid:
                        sensors = await self._rpc(dev_rid, "getSensors")
                        if isinstance(sensors, dict):
                            for sname, sinfo in sensors.items():
                                if isinstance(sinfo, dict) and sinfo.get("rid"):
                                    found.append({"name": sname, "rid": sinfo["rid"]})
                        continue
                except Exception:
                    pass
                # Fallback: try getSensors directly on the port
                try:
                    sensors = await self._rpc(port_rid, "getSensors")
                    if isinstance(sensors, dict):
                        for sname, sinfo in sensors.items():
                            if isinstance(sinfo, dict) and sinfo.get("rid"):
                                found.append({"name": sname, "rid": sinfo["rid"]})
                except Exception:
                    pass
        except Exception:
            pass
        return found

    async def get_env_sensors(self) -> dict:
        """Returns PDU-level environmental sensors via sensor ports → connected device."""
        result: dict = {}
        try:
            sensor_list = await self._get_peripheral_sensor_rids()

            TEMP_KEYS = {"temperature", "temp"}
            HUM_KEYS  = {"humidity", "relativehumidity", "rh"}
            LEAK_KEYS = {"leakdetector", "leak", "waterdetection", "flood"}

            temp_rid = hum_rid = leak_rid = None
            for s in sensor_list:
                lname = s["name"].lower()
                if temp_rid is None and any(k in lname for k in TEMP_KEYS):
                    temp_rid = s["rid"]
                elif hum_rid is None and any(k in lname for k in HUM_KEYS):
                    hum_rid = s["rid"]
                elif leak_rid is None and any(k in lname for k in LEAK_KEYS):
                    leak_rid = s["rid"]

            async def _safe_read(rid):
                if not rid:
                    return None
                try:
                    r = await self._rpc(rid, "getReading")
                    return r if isinstance(r, dict) else None
                except Exception:
                    return None

            temp_r = await _safe_read(temp_rid)
            hum_r  = await _safe_read(hum_rid)
            leak_r = await _safe_read(leak_rid)

            if temp_r and temp_r.get("value") is not None:
                result["temperature"] = round(float(temp_r["value"]), 1)
            if hum_r and hum_r.get("value") is not None:
                result["humidity"] = round(float(hum_r["value"]), 1)
            if leak_r and leak_r.get("value") is not None:
                result["leak_detected"] = int(leak_r["value"]) > 0
        except Exception:
            pass
        return result

    async def list_sensors(self) -> dict:
        """Debug: try eventservice channel for peripheral sensor discovery."""
        out: dict = {}
        client = await self._client_ctx()

        # 1. Try to create/open a channel via eventservice
        for method in ("newChannel", "createChannel", "openChannel", "open"):
            try:
                r = await self._rpc("/eventservice", method)
                if r is not None:
                    out[f"evtsvc.{method}"] = r
            except Exception as e:
                out[f"evtsvc.{method}"] = str(e)

        # 2. Try calling subscribe/getReadings on eventservice directly
        for method in ("subscribe", "getReadings", "getSensorReadings",
                       "getPeripheralReadings", "getAllReadings"):
            try:
                r = await self._rpc("/eventservice", method)
                if r is not None:
                    out[f"evtsvc.{method}"] = r
            except Exception as e:
                out[f"evtsvc.{method}"] = str(e)

        # 3. Try pollEvents on a new channel with a generated ID
        import random
        chan_id = random.randint(100000000, 999999999)
        chan_url = f"/eventservice/channel-{chan_id}"
        for method in ("pollEvents", "subscribe", "getReadings", "getAll"):
            try:
                r = await self._rpc(chan_url, method)
                if r is not None:
                    out[f"chan.{method}"] = r
            except Exception as e:
                out[f"chan.{method}"] = str(e)

        return out


        # From debug we know: port = portsensor0, chain position 1
        # Try calling getReading on guessed sensor RIDs
        # Pattern: /tfwopaque/{SensorClass}:{version}/{instanceName}
        # Known working pattern from PDU.getSensors: PDU0PowerSupplyStatus0
        # Try same PDU0 prefix for port sensors
        candidate_rids = [
            "/tfwopaque/sensors.NumericSensor:4.0.7/PDU0Port0Temperature0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/PDU0Port0Humidity0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/PDU0PortSensor0Temperature0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/PDU0PortSensor0Humidity0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/PDU0ExternalSensor0Temperature0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/PDU0ExternalSensor0Humidity0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/PDU0Peripheral0Temperature0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/PDU0Peripheral0Humidity0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/portsensor0package0temperature0",
            "/tfwopaque/sensors.NumericSensor:4.0.7/portsensor0package0humidity0",
        ]

        for rid in candidate_rids:
            try:
                r = await self._rpc(rid, "getReading")
                if r is not None:
                    out[rid] = r
            except Exception as e:
                out[rid] = str(e)

        # Also try getMetaData on port chain sub-paths
        for suffix in ("chain0", "package0", "device0", "peripheral0"):
            rid = f"/tfwopaque/portsmodel.Port:2.0.4/portsensor0/{suffix}"
            try:
                r = await self._rpc(rid, "getMetaData")
                if r:
                    out[f"sub:{suffix}"] = r
            except Exception as e:
                if "RPC error" in str(e):
                    out[f"sub:{suffix}"] = str(e)

        # Try more methods on the port directly
        port_rid = "/tfwopaque/portsmodel.Port:2.0.4/portsensor0"
        for m in ("getChain", "getDeviceChain", "getPackages", "getChainedDevices",
                   "getPeripherals", "getConnectedChain", "getConnectedPeripheral",
                   "getPortDevice", "getAttachedDevices", "getState", "getReadings"):
            try:
                r = await self._rpc(port_rid, m)
                if r is not None:
                    out[f"port.{m}"] = r
            except Exception as e:
                if "RPC error" in str(e):
                    out[f"port.{m}"] = str(e)

        return out

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
