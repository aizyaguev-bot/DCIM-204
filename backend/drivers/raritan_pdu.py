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
import copy
import json
import math
import re
import httpx
from typing import Any

from .raritan_kvm import classify_error

TIMEOUT = 6.0
PDU_PATH = "/model/pdu/1"
MAX_CONCURRENT = 6  # max simultaneous connections to one PDU
# PX-Series/Xerus 4.0.20 User Guide, p. 170: outlet names allow 64 characters.
# https://cdn1.raritan.com/download/pdu-g2/4.0.20/PDU_G2_UG_A2_4.0.20.pdf
NAME_MAX = 64
_RID = re.compile(r"/[A-Za-z0-9._:/-]+")
# This is the Outlet API major discovered on the supported Xerus devices above.
# Unknown API majors need review before their settings may be replayed.
_OUTLET_TYPE = re.compile(r"pdumodel\.Outlet:3(?:\.[0-9]+){0,2}")
_NAME_UNSUPPORTED = "Outlet names cannot be written to this PDU yet"
_INVALID_RID = "Device API returned an invalid resource identifier"
_INVALID_NAME = "Name has characters the device cannot store"
_UNSUPPORTED_SETTINGS = "Unsupported outlet settings format"
_OTHER_SETTINGS_CHANGED = "Other outlet settings changed during the write - check the PDU"
_FORBIDDEN_NAME_CHARS = frozenset("'\"\\<>&`")
# Required JSON types for the identified Outlet API major 3; unknown fields stay
# intact. StartupState is an IDL enum represented as a JSON integer.
# https://help.servertech.com/json-rpc/4.0.20/Outlet_8idl_source.html
_OUTLET_SETTINGS_TYPES = {
    "name": str,
    "startupState": int,
    "usePduCycleDelay": bool,
    "cycleDelay": int,
    "nonCritical": bool,
    "sequenceDelay": int,
}


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
        if not isinstance(rid_path, str) or _RID.fullmatch(rid_path) is None:
            raise RaritanPduError(_INVALID_RID)
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
                # A redirect must never replay a settings write at another path.
                options = {"follow_redirects": False} if method == "setSettings" else {}
                resp = await client.post(f"{self.base_url}{rid_path}", json=payload, **options)
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

    async def _get_outlet_settings(self, rid: str, *, validate: bool = True) -> dict:
        settings = await self._rpc(rid, "getSettings")
        if not isinstance(settings, dict) or (validate and any(
            type(settings.get(key)) is not expected for key, expected in _OUTLET_SETTINGS_TYPES.items()
        )):
            # An unrecognised response must never become a guessed settings write.
            raise RaritanPduError(_UNSUPPORTED_SETTINGS)
        return settings

    async def _get_name_outlet_rids(self) -> list[str]:
        """Fresh discovery for names; legacy status caches cannot authorize writes."""
        outlets = await self._rpc(PDU_PATH, "getOutlets")
        if not isinstance(outlets, list) or not outlets:
            raise RaritanPduError(_NAME_UNSUPPORTED)
        rids = []
        for outlet in outlets:
            if not isinstance(outlet, dict):
                raise RaritanPduError(_NAME_UNSUPPORTED)
            rid = outlet.get("rid")
            if not isinstance(rid, str) or _RID.fullmatch(rid) is None:
                raise RaritanPduError(_INVALID_RID)
            outlet_type = outlet.get("type")
            if not isinstance(outlet_type, str) or _OUTLET_TYPE.fullmatch(outlet_type) is None:
                raise RaritanPduError(_NAME_UNSUPPORTED)
            rids.append(rid)
        if len(set(rids)) != len(rids):
            raise RaritanPduError(_NAME_UNSUPPORTED)
        return rids

    async def name_support(self) -> tuple[bool, str]:
        """Require known Outlet types, safe RIDs and complete, typed settings."""
        try:
            rids = await self._get_name_outlet_rids()
            for rid in rids:
                await self._get_outlet_settings(rid)
        except RaritanPduError as exc:
            if str(exc) in (_NAME_UNSUPPORTED, _INVALID_RID, _UNSUPPORTED_SETTINGS):
                return False, str(exc)
            raise
        return True, ""

    async def get_outlet_names(self) -> dict[int, str]:
        """Read raw names only; an empty name means the device's default label."""
        rids = await self._get_name_outlet_rids()
        settings = await asyncio.gather(*(self._get_outlet_settings(rid) for rid in rids))
        return {number: value["name"] for number, value in enumerate(settings, 1)}

    async def set_outlet_name(self, outlet_number: int, name: str) -> str:
        """Change only the name in the current settings, then return its read-back.

        Xerus Outlet.setSettings takes the complete Settings struct and returns
        an integer status (0 = success, 1 = invalid parameters).

        Read twice and refuse any observed change before writing from the second
        snapshot. Xerus has no compare-and-set: a residual millisecond-scale
        window (longer if requests are delayed) remains between the second read
        and the write. A concurrent change in that window can be overwritten
        without detection by the read-back; this guard does not provide atomicity.
        """
        if type(outlet_number) is not int or outlet_number < 1:
            raise RaritanPduError("Outlet number is out of range")
        if not isinstance(name, str) or any(not 0x20 <= ord(char) <= 0x7E for char in name):
            # Check before stripping so a control-only input cannot clear a name.
            raise RaritanPduError(_INVALID_NAME)
        name = name.strip()
        if len(name) > NAME_MAX or any(char in _FORBIDDEN_NAME_CHARS for char in name):
            raise RaritanPduError(_INVALID_NAME)

        rids = await self._get_name_outlet_rids()
        if outlet_number > len(rids):
            raise RaritanPduError(f"Outlet {outlet_number} out of range (max {len(rids)})")
        rid = rids[outlet_number - 1]
        settings = await self._get_outlet_settings(rid)
        if settings["name"] == name:
            return name
        first = json.dumps(settings, sort_keys=True)
        settings = await self._get_outlet_settings(rid, validate=False)
        if json.dumps(settings, sort_keys=True) != first:
            raise RaritanPduError(_OTHER_SETTINGS_CHANGED)
        # Preserve a value/type-sensitive snapshot, including nested and unknown
        # fields, from the second read. Equality with the validated first snapshot
        # also establishes the second snapshot's format. No settings are cached
        # or reused for another port.
        before = json.dumps({key: value for key, value in settings.items() if key != "name"}, sort_keys=True)
        updated = copy.deepcopy(settings)
        updated["name"] = name
        result = await self._rpc(rid, "setSettings", {"settings": updated})
        if type(result) is not int:
            raise RaritanPduError("Device API returned an invalid name-write result")
        if result != 0:
            raise RaritanPduError(f"Device refused the name (code {result})")
        stored = await self._get_outlet_settings(rid, validate=False)
        after = json.dumps({key: value for key, value in stored.items() if key != "name"}, sort_keys=True)
        if after != before:
            raise RaritanPduError(_OTHER_SETTINGS_CHANGED)
        if not isinstance(stored.get("name"), str):
            raise RaritanPduError(_UNSUPPORTED_SETTINGS)
        return stored["name"]

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
