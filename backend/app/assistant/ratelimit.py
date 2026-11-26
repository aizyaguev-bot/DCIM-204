"""Assistant limits: question counters in the database (they survive a restart) and in-process concurrency.

Counters are fixed windows in `assistant_rate`: per client key (a user id, or the client address in legacy mode) one
per minute and one per hour, plus one global counter of language-model questions per day. A rejected question is
rolled back, so it does not use up the quota. Concurrency is non-blocking: at most PER_CLIENT_IN_FLIGHT questions per
client and `assistant_concurrency` for the whole process; anything beyond that is refused at once (429), never queued.
Every database error propagates to the caller, which fails closed (503).
"""
from __future__ import annotations

import hashlib
import math
from contextlib import asynccontextmanager

from sqlalchemy import case, delete, select, update
from sqlalchemy.exc import IntegrityError

from .storage import AssistantRate

PER_CLIENT_IN_FLIGHT = 2
BUSY_RETRY_SECONDS = 10
DAY_SECONDS = 86400
KEEP_ROWS_SECONDS = DAY_SECONDS + 3600   # older than the longest window: expired, removed on the next count
DAILY_KEY = "llm-day:global"


class RateLimited(Exception):
    """Raised when a limit is reached; the router turns it into 429 with Retry-After."""

    def __init__(self, retry_after: int, reason: str):
        super().__init__(reason)
        self.retry_after = max(1, int(retry_after))
        self.reason = reason   # "minute" | "hour" | "in_flight" | "busy"


def _digest(window: str, client: str) -> str:
    return hashlib.sha256(f"assistant:{window}:{client}".encode()).hexdigest()


async def _count(db, key: str, window: int, now: float) -> tuple[int, float]:
    expired = AssistantRate.window_start <= now - window
    statement = (update(AssistantRate).where(AssistantRate.key == key)
                 .values(count=case((expired, 1), else_=AssistantRate.count + 1),
                         window_start=case((expired, now), else_=AssistantRate.window_start))
                 .returning(AssistantRate.count, AssistantRate.window_start))
    row = (await db.execute(statement)).first()
    if row is not None:
        return int(row[0]), float(row[1])
    db.add(AssistantRate(key=key, window_start=now, count=1))
    await db.flush()
    return 1, now


async def _counted(session_factory, windows, now: float) -> RateLimited | None:
    """Counts one hit in every (key, window_seconds, limit, reason) in one write transaction. When any window is
    over its limit, nothing is counted and the RateLimited with the longest wait is returned."""
    for attempt in range(2):
        async with session_factory() as db:
            try:
                # The delete opens the write transaction, so concurrent questions are serialised by SQLite.
                await db.execute(delete(AssistantRate).where(AssistantRate.window_start < now - KEEP_ROWS_SECONDS))
                blocked: RateLimited | None = None
                for key, window, limit, reason in windows:
                    count, start = await _count(db, key, window, now)
                    if count > limit:
                        wait = math.ceil(start + window - now)
                        if blocked is None or wait > blocked.retry_after:
                            blocked = RateLimited(wait, reason)
                if blocked is not None:
                    await db.rollback()
                    return blocked
                await db.commit()
                return None
            except IntegrityError:
                await db.rollback()   # another request inserted the same key first; count again
                if attempt:
                    raise
    return None


async def consume(session_factory, client: str, *, per_minute: int, per_hour: int, now: float) -> None:
    """Counts one question for `client`; raises RateLimited (and counts nothing) when a window is already full."""
    blocked = await _counted(session_factory, ((_digest("minute", client), 60, per_minute, "minute"),
                                               (_digest("hour", client), 3600, per_hour, "hour")), now)
    if blocked is not None:
        raise blocked


async def consume_daily(session_factory, limit: int, now: float) -> bool:
    """Counts one language-model question in the global daily window. False (nothing counted) when the cap is used
    up; the router then answers in demo mode instead."""
    return await _counted(session_factory, ((_digest("day", DAILY_KEY), DAY_SECONDS, limit, "day"),), now) is None


async def daily_used(session_factory, now: float) -> int:
    """Language-model questions counted in the current daily window (read only)."""
    async with session_factory() as db:
        row = (await db.execute(select(AssistantRate.count, AssistantRate.window_start)
                                .where(AssistantRate.key == _digest("day", DAILY_KEY)))).first()
    if row is None or row[1] <= now - DAY_SECONDS:
        return 0
    return int(row[0])


class Gate:
    """In-process, non-blocking concurrency: plain counters (no await between check and update), released in
    `finally` whatever happens to the question."""

    def __init__(self):
        self.active = 0
        self._per_client: dict[str, int] = {}

    def in_flight(self, client: str) -> int:
        return self._per_client.get(client, 0)

    @asynccontextmanager
    async def slot(self, client: str, total: int):
        if self._per_client.get(client, 0) >= PER_CLIENT_IN_FLIGHT:
            raise RateLimited(BUSY_RETRY_SECONDS, "in_flight")
        if self.active >= max(1, int(total)):
            raise RateLimited(BUSY_RETRY_SECONDS, "busy")
        self._per_client[client] = self._per_client.get(client, 0) + 1
        self.active += 1
        try:
            yield
        finally:
            self.active = max(0, self.active - 1)
            left = self._per_client.get(client, 1) - 1
            if left > 0:
                self._per_client[client] = left
            else:
                self._per_client.pop(client, None)


gate = Gate()
