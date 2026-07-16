import json
from sqlalchemy import String, Integer, Boolean
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
        """Parsed labels dict, always safe to read (returns {} on any error)."""
        try:
            return json.loads(self.labels_json or "{}")
        except Exception:
            return {}
