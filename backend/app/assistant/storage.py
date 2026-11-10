"""Assistant tables (new tables only, created by create_all) and the queries the router uses.

Conversations and messages are private to their owner key (a user id, or "legacy-shared" in shared-password mode):
every read, update and delete here filters on that key. Work items are shared by the team.
Callers pass short-lived AsyncSessions and commit through the helpers below.
"""
from __future__ import annotations

import datetime as _dt
import json
import re
import uuid

from sqlalchemy import Float, ForeignKey, Integer, String, case, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .contracts import iso

MAX_MESSAGES = 200            # per conversation; the oldest are pruned
MAX_CONVERSATIONS = 50        # per owner; the least recently used are removed
IDLE_SECONDS = 90 * 86400     # conversations untouched this long are removed
CONVERSATION_LIST_LIMIT = 50
WORK_ITEM_LIST_LIMIT = 200
WORK_ITEM_STATUSES = ("saved", "done", "cancelled")
ID_PATTERN = re.compile(r"[0-9a-f]{32}")


class WorkItemConflict(Exception):
    """The item changed since the caller read it ("stale") or is already done/cancelled ("closed")."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def new_id() -> str:
    return uuid.uuid4().hex


def valid_id(value) -> bool:
    return isinstance(value, str) and ID_PATTERN.fullmatch(value) is not None


class AssistantConversation(Base):
    __tablename__ = "assistant_conversations"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_key: Mapped[str] = mapped_column(String, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    created_at: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[float] = mapped_column(Float, index=True)


class AssistantMessage(Base):
    __tablename__ = "assistant_messages"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("assistant_conversations.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer, default=0)          # order inside the conversation
    role: Mapped[str] = mapped_column(String)                     # user | assistant
    text: Mapped[str] = mapped_column(String, default="")
    answer_json: Mapped[str | None] = mapped_column(String, nullable=True)
    sources_json: Mapped[str | None] = mapped_column(String, nullable=True)
    mode: Mapped[str | None] = mapped_column(String, nullable=True)  # llm | demo (assistant messages)
    demo_reason: Mapped[str | None] = mapped_column(String, nullable=True)  # Hebrew, demo answers only
    created_at: Mapped[float] = mapped_column(Float)


class AssistantWorkItem(Base):
    __tablename__ = "assistant_work_items"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_key: Mapped[str] = mapped_column(String, index=True)     # creator key
    created_by: Mapped[str] = mapped_column(String, default="")  # creator username, for display
    title: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(String, default="")
    entity_refs_json: Mapped[str] = mapped_column(String, default="[]")
    priority: Mapped[str] = mapped_column(String, default="medium")
    rationale: Mapped[str] = mapped_column(String, default="")
    steps_json: Mapped[str] = mapped_column(String, default="[]")
    status: Mapped[str] = mapped_column(String, default="saved", index=True)
    conversation_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[float] = mapped_column(Float, index=True)
    updated_by: Mapped[str] = mapped_column(String, default="")


class AssistantRate(Base):
    __tablename__ = "assistant_rate"
    key: Mapped[str] = mapped_column(String, primary_key=True)    # sha256 of the window name and client key
    window_start: Mapped[float] = mapped_column(Float, index=True)
    count: Mapped[int] = mapped_column(Integer)


def _loads(text, default):
    if not text:
        return default
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return default
    return value if isinstance(value, type(default)) else default


def _dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------------------------------------------
async def get_conversation(db: AsyncSession, conversation_id: str, owner: str) -> AssistantConversation | None:
    if not valid_id(conversation_id):
        return None
    return await db.scalar(select(AssistantConversation).where(
        AssistantConversation.id == conversation_id, AssistantConversation.user_key == owner))


async def list_conversations(db: AsyncSession, owner: str) -> list[dict]:
    counts = (select(AssistantMessage.conversation_id, func.count().label("n"))
              .group_by(AssistantMessage.conversation_id).subquery())
    rows = (await db.execute(
        select(AssistantConversation, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.conversation_id == AssistantConversation.id)
        .where(AssistantConversation.user_key == owner)
        .order_by(AssistantConversation.updated_at.desc())
        .limit(CONVERSATION_LIST_LIMIT))).all()
    return [{"id": conv.id, "title": conv.title, "created_at": iso(conv.created_at), "updated_at": iso(conv.updated_at),
             "message_count": int(count)} for conv, count in rows]


async def conversation_messages(db: AsyncSession, conversation_id: str, owner: str) -> list[dict] | None:
    """All messages of an owned conversation, oldest first; None when it is not the caller's (or does not exist)."""
    if await get_conversation(db, conversation_id, owner) is None:
        return None
    rows = (await db.scalars(select(AssistantMessage).where(AssistantMessage.conversation_id == conversation_id)
                             .order_by(AssistantMessage.seq, AssistantMessage.created_at))).all()
    return [message_dto(row) for row in rows]


async def recent_history(db: AsyncSession, conversation_id: str, owner: str, limit: int) -> list[dict] | None:
    """The last `limit` messages for the engine, oldest first: {"role", "text"} plus "answer" for assistant turns."""
    if await get_conversation(db, conversation_id, owner) is None:
        return None
    rows = (await db.scalars(select(AssistantMessage).where(AssistantMessage.conversation_id == conversation_id)
                             .order_by(AssistantMessage.seq.desc(), AssistantMessage.created_at.desc())
                             .limit(limit))).all()
    history = []
    for row in reversed(rows):
        turn = {"role": row.role, "text": row.text}
        if row.role == "assistant":
            turn["answer"] = _loads(row.answer_json, {})
            turn["mode"] = row.mode
        history.append(turn)
    return history


def message_dto(row: AssistantMessage) -> dict:
    out = {"id": row.id, "role": row.role, "text": row.text, "created_at": iso(row.created_at)}
    if row.role == "assistant":
        out["answer"] = _loads(row.answer_json, {})
        out["sources"] = _loads(row.sources_json, [])
        out["mode"] = row.mode
        out["demo_reason"] = row.demo_reason
    return out


async def delete_conversation(db: AsyncSession, conversation_id: str, owner: str) -> bool:
    if await get_conversation(db, conversation_id, owner) is None:
        return False
    await db.execute(delete(AssistantMessage).where(AssistantMessage.conversation_id == conversation_id))
    await db.execute(delete(AssistantConversation).where(AssistantConversation.id == conversation_id,
                                                         AssistantConversation.user_key == owner))
    await db.commit()
    return True


async def _remove_conversations(db: AsyncSession, ids_query) -> None:
    ids = list((await db.scalars(ids_query)).all())
    if ids:
        await db.execute(delete(AssistantMessage).where(AssistantMessage.conversation_id.in_(ids)))
        await db.execute(delete(AssistantConversation).where(AssistantConversation.id.in_(ids)))


async def store_turn(db: AsyncSession, *, conversation_id: str | None, owner: str, title: str, question: str,
                     answer: dict, sources: list[dict], mode: str, now: float,
                     demo_reason: str | None = None) -> tuple[str, str] | None:
    """Stores the question and the answer as two messages (creating the conversation when needed) and applies the
    retention rules: conversations idle for IDLE_SECONDS are removed (all owners), an owner keeps at most
    MAX_CONVERSATIONS conversations and a conversation at most MAX_MESSAGES messages (oldest removed first).
    Returns (conversation_id, assistant_message_id), or None if the conversation is gone."""
    await _remove_conversations(db, select(AssistantConversation.id)
                                .where(AssistantConversation.updated_at < now - IDLE_SECONDS))
    if conversation_id:
        conv = await get_conversation(db, conversation_id, owner)
        if conv is None:
            await db.commit()
            return None
        conv.updated_at = now
    else:
        conv = AssistantConversation(id=new_id(), user_key=owner, title=title, created_at=now, updated_at=now)
        db.add(conv)
        await db.flush()
        await _remove_conversations(db, select(AssistantConversation.id)
                                    .where(AssistantConversation.user_key == owner)
                                    .order_by(AssistantConversation.updated_at.desc(), AssistantConversation.created_at.desc())
                                    .offset(MAX_CONVERSATIONS))
    last = await db.scalar(select(func.max(AssistantMessage.seq)).where(AssistantMessage.conversation_id == conv.id))
    seq = int(last or 0)
    answer_id = new_id()
    db.add(AssistantMessage(id=new_id(), conversation_id=conv.id, seq=seq + 1, role="user", text=question,
                            created_at=now))
    db.add(AssistantMessage(id=answer_id, conversation_id=conv.id, seq=seq + 2, role="assistant",
                            text=str(answer.get("summary", "")), answer_json=_dumps(answer),
                            sources_json=_dumps(sources), mode=mode, demo_reason=demo_reason, created_at=now))
    await db.flush()
    total = await db.scalar(select(func.count()).select_from(AssistantMessage)
                            .where(AssistantMessage.conversation_id == conv.id))
    excess = int(total or 0) - MAX_MESSAGES
    if excess > 0:
        oldest = (select(AssistantMessage.id).where(AssistantMessage.conversation_id == conv.id)
                  .order_by(AssistantMessage.seq, AssistantMessage.created_at).limit(excess))
        await db.execute(delete(AssistantMessage).where(AssistantMessage.id.in_(oldest)))
    await db.commit()
    return conv.id, answer_id


# ---------------------------------------------------------------------------------------------------------------
# Work items (team-wide; created and updated by Operators through the router only)
# ---------------------------------------------------------------------------------------------------------------
def item_time(ts: float) -> str:
    """Work item timestamps keep milliseconds: `updated_at` is also the optimistic-concurrency token."""
    return _dt.datetime.fromtimestamp(float(ts), tz=_dt.timezone.utc).isoformat(timespec="milliseconds")


def work_item_dto(row: AssistantWorkItem) -> dict:
    return {"id": row.id, "title": row.title, "description": row.description,
            "entity_refs": _loads(row.entity_refs_json, []), "priority": row.priority, "rationale": row.rationale,
            "steps": _loads(row.steps_json, []), "status": row.status, "created_by": row.created_by,
            "created_at": item_time(row.created_at), "updated_at": item_time(row.updated_at),
            "updated_by": row.updated_by, "conversation_id": row.conversation_id}


async def list_work_items(db: AsyncSession, status: str | None = None) -> tuple[list[dict], bool]:
    """Open ("saved") items first, then the rest, each newest change first; at most WORK_ITEM_LIST_LIMIT.
    Returns (items, truncated) where truncated means more items exist than were returned."""
    query = select(AssistantWorkItem)
    if status:
        query = query.where(AssistantWorkItem.status == status)
    open_first = case((AssistantWorkItem.status == "saved", 0), else_=1)
    rows = (await db.scalars(query.order_by(open_first, AssistantWorkItem.updated_at.desc(), AssistantWorkItem.id)
                             .limit(WORK_ITEM_LIST_LIMIT + 1))).all()
    return [work_item_dto(row) for row in rows[:WORK_ITEM_LIST_LIMIT]], len(rows) > WORK_ITEM_LIST_LIMIT


async def create_work_item(db: AsyncSession, *, draft: dict, owner: str, username: str,
                           conversation_id: str | None, now: float) -> dict:
    row = AssistantWorkItem(id=new_id(), user_key=owner, created_by=username, title=draft["title"],
                            description=draft["description"], entity_refs_json=_dumps(draft["entity_refs"]),
                            priority=draft["priority"], rationale=draft["rationale"], steps_json=_dumps(draft["steps"]),
                            status="saved", conversation_id=conversation_id, created_at=now, updated_at=now,
                            updated_by=username)
    db.add(row)
    await db.commit()
    return work_item_dto(row)


async def update_work_item(db: AsyncSession, item_id: str, changes: dict, username: str, now: float,
                           expected_updated_at: str) -> dict | None:
    """Applies already-validated `changes` (status/title/description/priority/steps) when the item is still "saved"
    and still has `expected_updated_at`. None when it does not exist; WorkItemConflict otherwise. The final UPDATE
    is conditional on the stored timestamp, so two concurrent editors cannot both succeed."""
    if not valid_id(item_id):
        return None
    row = await db.get(AssistantWorkItem, item_id)
    if row is None:
        return None
    if item_time(row.updated_at) != expected_updated_at:
        raise WorkItemConflict("stale")
    if row.status != "saved":   # allowed transitions: saved -> saved | done | cancelled; closed items are final
        raise WorkItemConflict("closed")
    values = {key: value for key, value in changes.items() if key in ("status", "title", "description", "priority")}
    if "steps" in changes:
        values["steps_json"] = _dumps(changes["steps"])
    previous = row.updated_at
    values.update(updated_at=max(now, previous + 0.001), updated_by=username)
    result = await db.execute(update(AssistantWorkItem)
                              .where(AssistantWorkItem.id == item_id, AssistantWorkItem.updated_at == previous)
                              .values(**values))
    if result.rowcount != 1:
        await db.rollback()
        raise WorkItemConflict("stale")
    await db.commit()
    row = await db.get(AssistantWorkItem, item_id, populate_existing=True)
    return work_item_dto(row)
