"""Tables for assistant actions. New tables only: the app uses create_all without migrations, so existing tables
(pdu_maintenance, pdu_maintenance_log) are never altered. Imported by store.py, which the API router imports, so
the tables exist before create_all runs."""
from __future__ import annotations

from sqlalchemy import Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ...database import Base


class AssistantActionProposal(Base):
    __tablename__ = "assistant_action_proposals"
    id: Mapped[str] = mapped_column(String, primary_key=True)             # uuid4 hex
    created_at: Mapped[float] = mapped_column(Float, index=True)
    expires_at: Mapped[float] = mapped_column(Float)
    owner_key: Mapped[str] = mapped_column(String, index=True)            # store.owner_key(principal)
    created_by: Mapped[str] = mapped_column(String)                       # username for display and audit
    conversation_id: Mapped[str | None] = mapped_column(String, nullable=True)
    kind: Mapped[str] = mapped_column(String)
    request_json: Mapped[str] = mapped_column(String, default="{}")       # ProposalRequest.to_dict()
    impact_json: Mapped[str] = mapped_column(String, default="{}")        # Impact.to_dict(with_pins=True)
    phrase: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, index=True, default="pending")
    restore_of: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    confirmed_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    confirmed_by: Mapped[str | None] = mapped_column(String, nullable=True)
    finished_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    progress_done: Mapped[int] = mapped_column(Integer, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, default=0)
    result_json: Mapped[str] = mapped_column(String, default="")           # {"targets", "pdus", "consoles", ...}
    # PDU ids this proposal put into maintenance and that are still there (rack/lab shutdown); batch_restore and
    # can_restore read it, the runner updates it after a restore.
    batch_down_json: Mapped[str] = mapped_column(String, default="[]")


class AssistantActionEvent(Base):
    """Append-only audit trail. Never holds a password, a phrase attempt, credentials or device addresses."""
    __tablename__ = "assistant_action_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[float] = mapped_column(Float, index=True)
    proposal_id: Mapped[str] = mapped_column(String, index=True)
    actor: Mapped[str] = mapped_column(String)          # username, "shared-password", or "system"
    event: Mapped[str] = mapped_column(String)          # contracts.EVENTS
    detail_json: Mapped[str] = mapped_column(String, default="{}")
