"""
Raritan DPC PDU G4 driver — JSON-RPC 2.0 over HTTPS with Basic auth.

Discovered API (reverse-engineered from Angular bundle):
  PDU object:    POST https://{ip}/model/pdu/1
  Outlet object: POST https://{ip}/tfwopaque/pdumodel.Outlet:3.0.3/outlet.{n}  (0-indexed)
  Inlet object:  POST https://{ip}/tfwopaque/pdumodel.Inlet:3.0.3/inlet.{n}    (0-indexed)
  Sensor object: POST https://{ip}<sensor_rid>  (rid returned by getSensors)
  Event channel: POST https://{ip}/eventservice  createChannel → channel RID
                 POST https://{ip}/eventservice/channel-{id}  subscribe / pollEvents

  setPowerState params: {"pstate": 1}  (1=on, 0=off)
  cyclePowerState params: {}
"""

import asyncio
import math
import httpx
from typing import Any

from .raritan_kvm import classify_error

TIMEOUT = 6.0
PDU_PATH = "/model/pdu/1"
MAX_CONCURRENT = 6  # max simultaneous connections to one PDU


class RaritanPduError(Exception):
    pass


def safe_error(exc: Exception) -> str:
    """Driver errors are fixed failure classes; other exception text is never returned."""
    if isinstance(exc, RaritanPduError):
        return str(exc)
    if isinstance(exc, httpx.HTTPError):
        return classify_error(exc)
    return f"Device API returned no usable status ({type(exc).__name__})"


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
        # Error texts are fixed failure classes: device response bodies, RPC
        # messages and httpx exception text may carry URLs or credentials.
        try:
            async with self._sem:
                resp = await client.post(f"{self.base_url}{rid_path}", json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RaritanPduError(f"Device API responded with HTTP {e.response.status_code}") from None
        except httpx.ConnectTimeout as e:
            raise RaritanPduError("Device API connection timeout (ConnectTimeout): the VM could not connect to the PDU HTTPS API") from e
        except httpx.TimeoutException as e:
            raise RaritanPduError(f"Device API request timeout ({type(e).__name__})") from e
        except httpx.RequestError as e:
            raise RaritanPduError(classify_error(e)) from None

        try:
            data = resp.json()
        except ValueError:
            raise RaritanPduError("Device API returned an invalid response") from None
        if not isinstance(data, dict):
            raise RaritanPduError("Device API returned an invalid response")
        if "error" in data:
            error = data["error"] if isinstance(data["error"], dict) else {}
            code = error.get("code")
            raise RaritanPduError(f"RPC error {code if isinstance(code, int) else '?'}")
        result = data.get("result")
        return result.get("_ret_") if isinstance(result, dict) else None

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
            power_state = (state_data or {}).get("powerState")
            cycle_in_progress = (state_data or {}).get("cycleInProgress", False)
            state = "on" if power_state == 1 else ("cycling" if cycle_in_progress else "off" if power_state == 0 else "unknown")
            name = (settings_data or {}).get("name", "") or f"Outlet {outlet_num}"

            async def _read(sname: str):
                sinfo = (sensors or {}).get(sname)
                if sinfo and sinfo.get("rid"):
                    try:
                        r = await self._rpc(sinfo["rid"], "getReading")
                        if not isinstance(r, dict):
                            return None
                        if any(key in r for key in ("valid", "available")) and not (r.get("valid") is True and r.get("available") is True):
                            return None
                        value = float(r["value"])
                        return value if math.isfinite(value) else None
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
                "watts":   round(float(p), 1) if p is not None else None,
                "current": round(float(c), 2) if c is not None else None,
                "voltage": round(float(v), 1) if v is not None else None,
            }
        except Exception:
            return {
                "number": outlet_num,
                "label": f"Outlet {outlet_num}",
                "state": "unknown",
                "watts": None,
                "current": None,
                "voltage": None,
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
        """Returns PDU environmental sensors.
        Tries: 1) GET on port path, 2) channel pollEvents, 3) silent fail."""
        result: dict = {}
        try:
            client = await self._client_ctx()
            PORT_PATH = "/tfwopaque/portsmodel.Port:2.0.4/portsensor0"

            # Strategy 1: HTTP GET on the port path — may return full device state
            try:
                resp = await client.get(f"{self.base_url}{PORT_PATH}")
                if resp.status_code == 200:
                    data = resp.json()
                    result = self._parse_env_from_dict(data)
                    if result:
                        return result
            except Exception:
                pass

            # Strategy 2: Create channel, poll without subscribing (initial dump)
            try:
                ch = await self._rpc("/eventservice", "createChannel")
                ch_rid = (ch or {}).get("rid") if isinstance(ch, dict) else None
                if ch_rid:
                    # Try subscribe with no params (listen to everything)
                    for params in (None, [], {}):
                        try:
                            await self._rpc(ch_rid, "subscribe", params)
                        except Exception:
                            pass
                    events = await self._rpc(ch_rid, "pollEvents") or []
                    result = self._parse_env_from_events(events)
            except Exception:
                pass
        except Exception:
            pass
        return result

    def _parse_env_from_events(self, events: list) -> dict:
        result: dict = {}
        TEMP_KEYS = {"temperature", "temp"}
        HUM_KEYS  = {"humidity", "relativehumidity", "rh"}
        LEAK_KEYS = {"leakdetector", "leak", "waterdetection", "flood"}
        for ev in (events if isinstance(events, list) else []):
            if not isinstance(ev, dict):
                continue
            rid_lower = str(ev.get("rid", "")).lower()
            reading = ev.get("reading") or ev
            val = reading.get("value") if isinstance(reading, dict) else None
            if val is None:
                continue
            try:
                if result.get("temperature") is None and any(k in rid_lower for k in TEMP_KEYS):
                    result["temperature"] = round(float(val), 1)
                elif result.get("humidity") is None and any(k in rid_lower for k in HUM_KEYS):
                    result["humidity"] = round(float(val), 1)
                elif result.get("leak_detected") is None and any(k in rid_lower for k in LEAK_KEYS):
                    result["leak_detected"] = int(val) > 0
            except Exception:
                continue
        return result

    def _parse_env_from_dict(self, data: dict) -> dict:
        result: dict = {}
        if not isinstance(data, dict):
            return result
        for key, val in data.items():
            k = key.lower()
            try:
                if "temperature" in k or "temp" in k:
                    result["temperature"] = round(float(val), 1)
                elif "humidity" in k or "rh" in k:
                    result["humidity"] = round(float(val), 1)
                elif "leak" in k or "flood" in k or "water" in k:
                    result["leak_detected"] = bool(val)
            except Exception:
                continue
        return result

    @staticmethod
    def _sensor_samples(events) -> list[dict]:
        """Keep numeric samples only. Event text and response bodies stay on the device."""
        samples = []
        if not isinstance(events, list):
            return samples
        for event in events:
            if not isinstance(event, dict):
                continue
            reading = event.get("reading") if isinstance(event.get("reading"), dict) else event
            if not isinstance(reading, dict):
                continue
            try:
                value = float(reading.get("value"))
            except (TypeError, ValueError):
                continue
            if not math.isfinite(value):
                continue
            name = str(event.get("rid") or "").rsplit("/", 1)[-1][:80]
            samples.append({"name": name, "value": value})
        return samples

    async def list_sensors(self) -> dict:
        """Debug: status code and numeric sensor samples. No response bodies or exception text."""
        out: dict = {}
        client = await self._client_ctx()
        PORT_PATH = "/tfwopaque/portsmodel.Port:2.0.4/portsensor0"

        try:
            resp = await client.get(f"{self.base_url}{PORT_PATH}")
            out["GET_port"] = {"status": resp.status_code}
        except Exception as exc:
            out["GET_port"] = {"error": safe_error(exc)}

        try:
            ch = await self._rpc("/eventservice", "createChannel")
            ch_rid = (ch or {}).get("rid") if isinstance(ch, dict) else None
            out["channel"] = ch_rid if isinstance(ch_rid, str) else None
            if isinstance(ch_rid, str):
                for params in (None, [], {}):
                    label = "none" if params is None else "list" if params == [] else "object"
                    try:
                        await self._rpc(ch_rid, "subscribe", params)
                        out[f"subscribe_{label}"] = "ok"
                    except Exception as exc:
                        out[f"subscribe_{label}"] = safe_error(exc)
                out["sensors"] = self._sensor_samples(await self._rpc(ch_rid, "pollEvents"))
        except Exception as exc:
            out["channel_error"] = safe_error(exc)

        return out

    async def get_inlet(self) -> dict:
        """Read all inlets; missing/invalid sensor readings stay unknown for alerts."""
        inlet_rids = await self._get_inlet_rids()

        async def read_inlet(number, inlet_rid):
            result = {"number": number, "voltage": None, "current": None, "watts": None}
            try:
                sensors = await self._rpc(inlet_rid, "getSensors") or {}
            except RaritanPduError:
                return result
            for sname, metric in [("activePower", "watts"), ("current", "current"), ("voltage", "voltage")]:
                sinfo = sensors.get(sname)
                if sinfo and sinfo.get("rid"):
                    try:
                        reading = await self._rpc(sinfo["rid"], "getReading") or {}
                        # NumericSensor.Reading.valid / available are documented by Xerus.
                        if reading.get("valid") is True and reading.get("available") is True:
                            value = float(reading["value"])
                            if math.isfinite(value):
                                result[metric] = value
                    except (RaritanPduError, ValueError, TypeError, KeyError):
                        pass  # One unavailable sensor must not hide the others.
            return result

        readings = await asyncio.gather(*(read_inlet(n, rid) for n, rid in enumerate(inlet_rids, 1)))
        first = readings[0] if readings else {}
        # Display fields and alert readings both preserve unknown values.
        return {**{key: first.get(key) for key in ("voltage", "current", "watts")}, "readings": readings}
