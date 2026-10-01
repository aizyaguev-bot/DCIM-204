from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache
import pathlib

_ENV_FILE = pathlib.Path(__file__).parent.parent.parent / ".env"

class Settings(BaseSettings):
    # ── existing device credentials ──────────────────────────────────────────
    pdu_username: str = "ftlab"
    pdu_password: str = ""
    kvm_username: str = "admin"
    kvm_password: str = ""
    lab_manager_master_key: str = ""
    lab_manager_password: str = ""
    database_url: str = f"sqlite+aiosqlite:///{pathlib.Path(__file__).parent.parent / 'lab_manager.db'}"

    # ── JWT ──────────────────────────────────────────────────────────────────
    jwt_secret: str = ""
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 30

    # ── Google OAuth ──────────────────────────────────────────────────────────
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:8000/auth/google/callback"

    # ── SMTP ──────────────────────────────────────────────────────────────────
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_pass: str = ""
    from_email: str = ""

    # ── Frontend ──────────────────────────────────────────────────────────────
    frontend_url: str = "http://localhost:5173"

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
