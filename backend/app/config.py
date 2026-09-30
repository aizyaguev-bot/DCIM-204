from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache
from typing import Literal
from pydantic import Field, SecretStr, model_validator
import pathlib

# .env lives in the project root (one level above backend/)
_ENV_FILE = pathlib.Path(__file__).parent.parent.parent / ".env"

class Settings(BaseSettings):
    pdu_username: str = "ftlab"
    pdu_password: str = ""
    kvm_username: str = "admin"
    kvm_password: str = ""
    lab_manager_master_key: str = ""
    lab_manager_password: str = ""          # shared team password; empty = no auth
    accounts_enabled: bool = False
    accounts_registration_enabled: bool = False
    accounts_admin_username: str = "admin"
    accounts_session_hours: int = Field(default=12, ge=1, le=168)
    accounts_secure_cookie: bool = False   # enable behind HTTPS; the existing VM uses HTTP
    ping_monitor_enabled: bool = True
    ping_monitor_timezone: str = "Asia/Jerusalem"
    email_alerts_enabled: bool = False
    email_alerts_to: str = "aizyaguev@nvidia.com"
    email_alerts_from: str = ""
    smtp_host: str = ""
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_security: Literal["starttls", "ssl", "plain"] = "starttls"
    smtp_username: str = ""
    smtp_password: SecretStr = SecretStr("")
    # Opt-in: additional ICMP probes; does not change scheduled history checks.
    email_alerts_minute_probes: bool = False
    email_voltage_min: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    email_voltage_max: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    email_current_min: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    email_current_max: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    email_watts_min: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    email_watts_max: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    database_url: str = f"sqlite+aiosqlite:///{pathlib.Path(__file__).parent.parent / 'lab_manager.db'}"

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="after")
    def ordered_thresholds(self):
        for metric in ("voltage", "current", "watts"):
            lower, upper = (getattr(self, f"email_{metric}_{side}") for side in ("min", "max"))
            if lower is not None and upper is not None and lower >= upper:
                raise ValueError(f"email_{metric}_min must be less than email_{metric}_max")
        return self

@lru_cache
def get_settings() -> Settings:
    return Settings()
