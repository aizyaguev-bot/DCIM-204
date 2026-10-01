import json
from sqlalchemy import String, Integer, Boolean, Float, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base

class Engineer(Base):
    __tablename__ = "engineers"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    name_key: Mapped[str] = mapped_column(String, unique=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class AssetOwner(Base):
    __tablename__ = "asset_owners"
    asset_key: Mapped[str] = mapped_column(String, primary_key=True)
    engineer_id: Mapped[str | None] = mapped_column(ForeignKey("engineers.id"), nullable=True)
    legacy_name: Mapped[str] = mapped_column(String, default="")


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    username: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[str] = mapped_column(String, default="")
    role: Mapped[str] = mapped_column(String, default="Viewer")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    password_hash: Mapped[str] = mapped_column(String)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    preferences_json: Mapped[str] = mapped_column(String, default="{}")
    created_at: Mapped[float] = mapped_column(Float)
    last_login_at: Mapped[float | None] = mapped_column(Float, nullable=True)


class UserSession(Base):
    __tablename__ = "user_sessions"
    token_hash: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    csrf_token: Mapped[str] = mapped_column(String)
    expires_at: Mapped[float] = mapped_column(Float, index=True)


class AuthThrottle(Base):
    __tablename__ = "auth_throttles"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    attempts: Mapped[int] = mapped_column(Integer)
    window_at: Mapped[float] = mapped_column(Float)

class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)   # "pdu" | "kvm"
    model: Mapped[str] = mapped_column(String, default="")
    ip: Mapped[str] = mapped_column(String, nullable=False)
    rack: Mapped[str] = mapped_column(String, default="")
    port_count: Mapped[int] = mapped_column(Integer, default=0)
    username_enc: Mapped[str] = mapped_column(String, default="")
    password_enc: Mapped[str] = mapped_column(String, default="")
    labels_json: Mapped[str] = mapped_column(String, default="{}")  # JSON: {"port_number": "label"}
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str] = mapped_column(String, default="")

    @property
    def labels(self) -> dict:
        """Parsed labels dict, always safe to read (returns {} on any error)."""
        try:
            return json.loads(self.labels_json or "{}")
        except Exception:
            return {}


class PingTarget(Base):
    __tablename__ = "ping_targets"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    source_key: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String)
    host: Mapped[str] = mapped_column(String, default="")
    rack: Mapped[str] = mapped_column(String, default="")
    source: Mapped[str] = mapped_column(String, default="inventory")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String, default="pending")
    checked_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_up_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    rtt_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    detail: Mapped[str] = mapped_column(String, default="")


class PingSample(Base):
    __tablename__ = "ping_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[str] = mapped_column(ForeignKey("ping_targets.id"), index=True)
    host: Mapped[str] = mapped_column(String)
    checked_at: Mapped[float] = mapped_column(Float, index=True)
    status: Mapped[str] = mapped_column(String)
    rtt_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    detail: Mapped[str] = mapped_column(String, default="")


class PingTargetName(Base):
    __tablename__ = "ping_target_names"
    target_id: Mapped[str] = mapped_column(ForeignKey("ping_targets.id"), primary_key=True)
    override: Mapped[str] = mapped_column(String, default="")


class MonitorDeviceError(Base):
    __tablename__ = "monitor_device_errors"
    device_id: Mapped[str] = mapped_column(String, primary_key=True)
    checked_at: Mapped[float] = mapped_column(Float)
    detail: Mapped[str] = mapped_column(String, default="")


class PingIncident(Base):
    __tablename__ = "ping_incidents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[str] = mapped_column(ForeignKey("ping_targets.id"), index=True)
    host: Mapped[str] = mapped_column(String)
    previous_up_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    first_failed_at: Mapped[float] = mapped_column(Float, index=True)
    last_failed_at: Mapped[float] = mapped_column(Float)
    ended_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    end_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    failed_checks: Mapped[int] = mapped_column(Integer, default=1)


class PingMonitorState(Base):
    __tablename__ = "ping_monitor_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    next_run_at: Mapped[float] = mapped_column(Float)
    last_started_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_completed_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    lease_owner: Mapped[str] = mapped_column(String, default="")
    lease_until: Mapped[float] = mapped_column(Float, default=0)
    error: Mapped[str] = mapped_column(String, default="")


class MonitorDeviceSnapshot(Base):
    """Latest scheduled device observation, shared across API workers/restarts."""
    __tablename__ = "monitor_device_snapshots"

    device_id: Mapped[str] = mapped_column(String, primary_key=True)
    kind: Mapped[str] = mapped_column(String)
    ip: Mapped[str] = mapped_column(String)
    checked_at: Mapped[float] = mapped_column(Float)
    reachable: Mapped[bool] = mapped_column(Boolean)
    ports_json: Mapped[str] = mapped_column(String, default="[]")


class AlertCondition(Base):
    """One durable state per server or inlet threshold; no changes to existing tables."""
    __tablename__ = "alert_conditions"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    configuration: Mapped[str] = mapped_column(String)
    started_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    checked_at: Mapped[float] = mapped_column(Float)
    notified: Mapped[bool] = mapped_column(Boolean, default=False)


class AlertEmail(Base):
    __tablename__ = "alert_emails"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    condition_key: Mapped[str] = mapped_column(String, index=True)
    created_at: Mapped[float] = mapped_column(Float, index=True)
    recipient: Mapped[str] = mapped_column(String)
    subject: Mapped[str] = mapped_column(String)
    body: Mapped[str] = mapped_column(String)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[float] = mapped_column(Float)
    sent_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str] = mapped_column(String, default="")


class AlertWorkerState(Base):
    __tablename__ = "alert_worker_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lease_owner: Mapped[str] = mapped_column(String, default="")
    lease_until: Mapped[float] = mapped_column(Float, default=0)
    next_probe_at: Mapped[float] = mapped_column(Float, default=0)
    last_completed_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str] = mapped_column(String, default="")
