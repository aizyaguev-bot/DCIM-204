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
    ssh_terminal_enabled: bool = True
    ssh_allow_insecure_transport: bool = False
    ssh_connect_timeout_seconds: int = Field(default=10, ge=1, le=120)
    ssh_idle_timeout_seconds: int = Field(default=1800, ge=1)
    ssh_max_session_seconds: int = Field(default=3600, ge=1)
    ssh_max_sessions_per_user: int = Field(default=4, ge=1, le=100)
    ssh_max_sessions_total: int = Field(default=20, ge=1, le=1000)
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
    # Remote PXE install. raritan opens a KVM console only when the browser and screen reader are installed.
    pxe_enabled: bool = False
    pxe_driver: Literal["simulated", "raritan"] = "simulated"
    pxe_old_repo_host: str = "webrepo"
    pxe_new_repo_host: str = "192.168.136.101"
    pxe_allowed_computers: str = ""        # comma-separated; required in raritan mode
    pxe_max_active_jobs: int = Field(default=1, ge=1, le=8)
    pxe_tick_seconds: float = Field(default=0.5, gt=0, le=5)
    pxe_sim_time_scale: float = Field(default=1.0, gt=0, le=10)
    pxe_sim_scenario: str = "happy"
    # Port names written to the PDUs/KVMs themselves: auto (after each label save) | manual (panel only) | off.
    device_name_sync: str = "auto"
    # Lab assistant (read-only). Without a key, or with the LLM turned off, it answers in a clearly labelled demo mode.
    assistant_enabled: bool = True
    assistant_llm_enabled: bool = True
    assistant_anthropic_api_key: SecretStr | None = None   # server .env only; never sent to the browser or logged
    assistant_model: str = "claude-opus-5-5"
    assistant_timeout_seconds: int = Field(default=90, ge=5, le=600)
    assistant_per_minute: int = Field(default=6, ge=1, le=600)
    assistant_per_hour: int = Field(default=60, ge=1, le=10000)
    assistant_max_chars: int = Field(default=2000, ge=1, le=20000)
    assistant_concurrency: int = Field(default=4, ge=1, le=64)
    assistant_daily_limit: int = Field(default=300, ge=1, le=100000)   # language-model questions per day, all users
    assistant_allow_open_llm: bool = False   # allow the LLM on a site with no accounts and no shared password
    # Assistant actions: the assistant proposes, the user confirms with a password, the server runs. Off by default.
    assistant_actions_enabled: bool = False
    # Outlets rack-wide and lab-wide actions always keep on (the VM host, network switches, KVMs):
    # "<PDU id or name>:<outlet>[,...]". "none" = nothing to protect. Empty = rack/lab-wide actions are refused.
    power_protected_outlets: str = ""
    assistant_action_ttl_seconds: int = Field(default=300, ge=30, le=3600)
    assistant_action_cycle_off_seconds: float = Field(default=5.0, ge=1, le=60)
    assistant_action_restore_stagger_seconds: float = Field(default=3.0, ge=0, le=60)
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
