import json
from datetime import datetime
from sqlalchemy import String, Integer, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base


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
        try:
            return json.loads(self.labels_json or "{}")
        except Exception:
            return {}


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String, default="")
    avatar_url: Mapped[str] = mapped_column(String, default="")
    google_id: Mapped[str] = mapped_column(String, default="")
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class OtpCode(Base):
    __tablename__ = "otp_codes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str] = mapped_column(String, nullable=False, index=True)
    code: Mapped[str] = mapped_column(String, nullable=False)   # SHA-256 hash
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    token: Mapped[str] = mapped_column(String, nullable=False, index=True)  # SHA-256 hash
    device_info: Mapped[str] = mapped_column(String, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
