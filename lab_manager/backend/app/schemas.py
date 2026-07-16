from pydantic import BaseModel
from typing import Optional

class DeviceBase(BaseModel):
    name: str
    kind: str
    model: str = ""
    ip: str
    rack: str = ""
    port_count: int = 0
    notes: str = ""

class DeviceCreate(DeviceBase):
    username: str = ""
    password: str = ""

class DeviceOut(DeviceBase):
    id: str
    enabled: bool
    labels: dict = {}       # parsed from Device.labels_json via the ORM property

    model_config = {"from_attributes": True}

class OutletState(BaseModel):
    number: int
    label: str
    state: str          # "on" | "off" | "unknown"
    watts: float = 0.0
    current: float = 0.0
    voltage: float = 0.0

class PduStatus(BaseModel):
    device_id: str
    reachable: bool
    inlet_voltage: float = 0.0
    total_watts: float = 0.0
    outlets: list[OutletState] = []
    error: Optional[str] = None

class KvmPort(BaseModel):
    number: int
    label: str
    status: str         # "active" | "idle" | "empty"
    in_use: bool = False  # our tracking overlay (dismissible)

class KvmStatus(BaseModel):
    device_id: str
    reachable: bool
    ports: list[KvmPort] = []
    error: Optional[str] = None

class PowerAction(BaseModel):
    action: str         # "on" | "off" | "cycle"
