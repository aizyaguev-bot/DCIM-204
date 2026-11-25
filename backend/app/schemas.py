from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, computed_field
from typing import Optional

from .inventory_store import revision

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

class DevicePatch(BaseModel):
    """PATCH /api/devices/{id} (Edit details / Correct rack). Every field is optional; a field left out is unchanged.
    kind is accepted only to refuse it with a clear 422 (a device's kind cannot change); other unknown fields are 422."""
    model_config = ConfigDict(extra="forbid")
    name: Optional[StrictStr] = None
    ip: Optional[StrictStr] = None
    username: Optional[StrictStr] = None
    password: Optional[StrictStr] = None
    model: Optional[StrictStr] = None
    port_count: Optional[StrictInt] = Field(default=None, ge=0, le=512)
    notes: Optional[StrictStr] = None
    enabled: Optional[StrictBool] = None
    rack: Optional[StrictStr] = None
    kind: Optional[StrictStr] = None
    confirm_name: Optional[StrictStr] = None
    plan_revision: Optional[StrictStr] = None

class DeviceOut(DeviceBase):
    id: str
    enabled: bool
    labels: dict = {}       # parsed from Device.labels_json via the ORM property

    model_config = {"from_attributes": True}

    @computed_field
    @property
    def labels_revision(self) -> str:
        """Optional If-Match value for PATCH /api/devices/{id}/labels."""
        return revision(self.labels)

class OutletState(BaseModel):
    number: int
    label: str
    state: str          # "on" | "off" | "unknown"
    watts: float | None = None
    current: float | None = None
    voltage: float | None = None

class InletReading(BaseModel):
    number: int
    voltage: float | None = None
    current: float | None = None
    watts: float | None = None


class PduStatus(BaseModel):
    device_id: str
    reachable: bool
    inlet_voltage: float | None = None
    total_watts: float | None = None
    watts_complete: bool = False
    outlets: list[OutletState] = []
    inlet_readings: list[InletReading] = []
    error: Optional[str] = None
    temperature: Optional[float] = None
    humidity: Optional[float] = None
    leak_detected: Optional[bool] = None

class KvmPort(BaseModel):
    number: int
    label: str
    status: str         # "active" | "idle" | "empty"
    in_use: bool = False  # our tracking overlay (dismissible)
    status_source: str = "unknown"  # live | configured | unknown

class KvmStatus(BaseModel):
    device_id: str
    reachable: bool
    ports: list[KvmPort] = []
    error: Optional[str] = None

class PowerAction(BaseModel):
    action: str         # "on" | "off" | "cycle"
