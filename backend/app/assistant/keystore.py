"""The Anthropic API key an Admin sets on the site (/api/assistant/key), and the effective key every reader uses.

Storage: one row in `assistant_settings` ("anthropic_api_key") holding `crypto.encrypt(key)` (Fernet under
LAB_MANAGER_MASTER_KEY), "…" + the last 4 characters as a hint, who set it and when. The key is never logged,
returned or put in an error message; only the hint leaves this module.

Effective key: a site-stored key takes precedence over ASSISTANT_ANTHROPIC_API_KEY from .env. `load` keeps the
decrypted site key in a per-process cache for KEY_CACHE_SECONDS and `invalidate` clears it on every write, so a
change reaches every uvicorn worker within that time without a restart. `resolve`/`with_key` give the router and the
engine a read-only settings view whose `assistant_anthropic_api_key` is the effective key.

`test_key` makes the smallest authenticated call the installed SDK offers (`models.list(limit=1)`) with a 15 s
budget, through the service's own HTTPS_PROXY/NO_PROXY environment (the SDK's default HTTP client honours them),
and answers with fixed reason texts only.
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import re
import time

from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from .. import crypto
from ..models import AssistantSetting
from .contracts import iso

log = logging.getLogger(__name__)

KEY_NAME = "anthropic_api_key"
KEY_PATTERN = re.compile(r"sk-ant-[A-Za-z0-9_-]{20,200}")
KEY_CACHE_SECONDS = 5.0
TEST_TIMEOUT_SECONDS = 15.0
API_BASE_URL = "https://api.anthropic.com"   # explicit, like the engine: ANTHROPIC_BASE_URL is not honoured
HINT_PREFIX = "…"

# test_key reasons (fixed texts; never exception text).
REASON_OK = "Key works"
REASON_REJECTED = "The key was rejected (invalid or revoked)"
REASON_NO_ACCESS = "The key has no access to the API"
REASON_UNREACHABLE = "Could not reach the Anthropic API from the VM (network or proxy)"
REASON_RATE_LIMITED = "Anthropic API rate limit — the key itself works"
REASON_NO_SDK = "The anthropic package is not installed on the VM"
REASON_API_ERROR = "The Anthropic API returned an error; try again later"

_cache: dict = {"expires": 0.0, "value": None}


def _clock() -> float:
    return time.monotonic()


# ---------------------------------------------------------------------------------------------------------------
# Format, hint and master key
# ---------------------------------------------------------------------------------------------------------------
def validate_format(key) -> bool:
    """True for an Anthropic API key shape: ^sk-ant-[A-Za-z0-9_-]{20,200}$ after strip."""
    return isinstance(key, str) and KEY_PATTERN.fullmatch(key.strip()) is not None


def hint(key: str | None) -> str | None:
    """"…" + the last 4 characters; None without a key."""
    key = (key or "").strip()
    return HINT_PREFIX + key[-4:] if key else None


def env_key(settings) -> str:
    """ASSISTANT_ANTHROPIC_API_KEY from .env (stripped), or ""."""
    secret = getattr(settings, "assistant_anthropic_api_key", None)
    if secret is None:
        return ""
    value = secret.get_secret_value() if hasattr(secret, "get_secret_value") else secret
    return value.strip() if isinstance(value, str) else ""


def master_key_configured(settings) -> bool:
    """True when LAB_MANAGER_MASTER_KEY is set to a usable Fernet key (crypto.py would otherwise fall back to its
    insecure development key, which must never protect the API key)."""
    raw = getattr(settings, "lab_manager_master_key", "") or ""
    if hasattr(raw, "get_secret_value"):
        raw = raw.get_secret_value()
    if not isinstance(raw, str) or not raw.strip():
        return False
    try:
        Fernet(raw.encode())
    except (ValueError, TypeError):
        return False
    return True


# ---------------------------------------------------------------------------------------------------------------
# Storage and the process cache
# ---------------------------------------------------------------------------------------------------------------
def invalidate() -> None:
    """Forget the cached site key (called on every write in this process)."""
    _cache.update(expires=0.0, value=None)


async def _row(db) -> AssistantSetting | None:
    return (await db.execute(select(AssistantSetting).where(AssistantSetting.name == KEY_NAME))).scalar_one_or_none()


def _decrypt(row) -> str | None:
    if row is None or not row.value_enc:
        return None
    try:
        return crypto.decrypt(row.value_enc).strip() or None
    except Exception as exc:  # noqa: BLE001 - wrong/changed master key or damaged value; never echo it
        log.warning("assistant key: the stored key cannot be decrypted with LAB_MANAGER_MASTER_KEY (%s)",
                    type(exc).__name__)
        return None


async def load(db) -> str | None:
    """The decrypted site key, or None (none stored, unreadable, or the table cannot be read: the .env key then
    applies). Cached per process for KEY_CACHE_SECONDS; a database error is not cached."""
    now = _clock()
    if _cache["expires"] > now:
        return _cache["value"]
    try:
        row = await _row(db)
    except SQLAlchemyError as exc:
        log.warning("assistant key: the stored key could not be read (%s); using the .env key", type(exc).__name__)
        return None
    value = _decrypt(row)
    _cache.update(expires=now + KEY_CACHE_SECONDS, value=value)
    return value


async def info(db) -> dict | None:
    """Public facts about the stored key (never the key): hint, set_by, set_at, revision and whether it decrypts.
    Raises SQLAlchemyError for the caller to map."""
    row = await _row(db)
    if row is None:
        return None
    return {"hint": row.hint or None, "set_by": row.set_by or None, "set_at": row.set_at or None,
            "revision": int(row.revision or 0), "readable": _decrypt(row) is not None}


async def store(db, key: str, username: str) -> dict:
    """Encrypts and stores the key (insert or replace, revision + 1). The caller has checked the format, the master
    key and the user's password. Returns the public facts {hint, set_by, set_at, revision}."""
    key = key.strip()
    values = {"value_enc": crypto.encrypt(key), "hint": hint(key), "set_by": username, "set_at": iso(time.time())}
    revision = None
    if await _row(db) is None:
        db.add(AssistantSetting(name=KEY_NAME, revision=1, **values))
        try:
            await db.commit()
            revision = 1
        except IntegrityError:   # stored at the same moment by another request: replace that one
            await db.rollback()
    if revision is None:
        revision = (await db.execute(
            update(AssistantSetting).where(AssistantSetting.name == KEY_NAME)
            .values(revision=AssistantSetting.revision + 1, **values).returning(AssistantSetting.revision)
        )).scalar_one_or_none()
        await db.commit()
        if revision is None:
            raise RuntimeError("the key row disappeared while it was being replaced")
    invalidate()
    return {"hint": values["hint"], "set_by": username, "set_at": values["set_at"], "revision": int(revision)}


async def remove(db) -> bool:
    """Deletes the stored key; True when there was one."""
    result = await db.execute(delete(AssistantSetting).where(AssistantSetting.name == KEY_NAME))
    await db.commit()
    invalidate()
    return bool(result.rowcount)


# ---------------------------------------------------------------------------------------------------------------
# The effective key as a settings view
# ---------------------------------------------------------------------------------------------------------------
class KeyedSettings:
    """Read-only view of the settings in which `assistant_anthropic_api_key` is the effective key (site key, else the
    .env key) and `assistant_key_source` is "site", "env" or "none". Every other attribute is the real setting."""
    __slots__ = ("_base", "_key", "assistant_key_source")

    def __init__(self, base, key: str, source: str):
        object.__setattr__(self, "_base", base)
        object.__setattr__(self, "_key", key)
        object.__setattr__(self, "assistant_key_source", source)

    def __getattr__(self, name):
        if name == "assistant_anthropic_api_key":
            key = object.__getattribute__(self, "_key")
            return SecretStr(key) if key else None
        return getattr(object.__getattribute__(self, "_base"), name)

    def __setattr__(self, name, value):
        raise AttributeError("assistant settings are read-only")

    def __repr__(self):
        return f"<assistant settings: key source {object.__getattribute__(self, 'assistant_key_source')}>"

    __str__ = __repr__


def with_key(settings, site_key: str | None) -> KeyedSettings:
    """The settings view for this site key (None/"" = no site key: the .env key applies)."""
    if isinstance(settings, KeyedSettings):
        settings = object.__getattribute__(settings, "_base")
    site_key = (site_key or "").strip()
    if site_key:
        return KeyedSettings(settings, site_key, "site")
    env = env_key(settings)
    return KeyedSettings(settings, env, "env" if env else "none")


async def resolve(settings, session_factory) -> KeyedSettings:
    """with_key(settings, <site key loaded through session_factory>); any database failure falls back to .env."""
    site = None
    try:
        async with session_factory() as db:
            site = await load(db)
    except SQLAlchemyError as exc:
        log.warning("assistant key: the stored key could not be read (%s); using the .env key", type(exc).__name__)
    return with_key(settings, site)


# ---------------------------------------------------------------------------------------------------------------
# Testing a key against the API
# ---------------------------------------------------------------------------------------------------------------
def load_sdk():
    """The installed `anthropic` module, or None (tests replace this with a fake module)."""
    try:
        return importlib.import_module("anthropic")
    except Exception:  # noqa: BLE001 - not installed or broken
        return None


def _is(sdk, exc: BaseException, name: str) -> bool:
    cls = getattr(sdk, name, None)
    return isinstance(cls, type) and isinstance(exc, cls)


def classify(sdk, exc: BaseException) -> tuple[bool, str]:
    """(ok, fixed reason) for an exception raised by the test call."""
    status = getattr(exc, "status_code", None)
    if _is(sdk, exc, "AuthenticationError") or status == 401:
        return False, REASON_REJECTED
    if _is(sdk, exc, "PermissionDeniedError") or status == 403:
        return False, REASON_NO_ACCESS
    if _is(sdk, exc, "RateLimitError") or status == 429:
        return True, REASON_RATE_LIMITED
    if _is(sdk, exc, "APIConnectionError") or isinstance(exc, (asyncio.TimeoutError, OSError)):   # incl. timeouts
        return False, REASON_UNREACHABLE
    return False, REASON_API_ERROR


async def test_key(key: str, settings=None) -> tuple[bool, str]:
    """(ok, reason): one authenticated `models.list(limit=1)` call, no retries, at most TEST_TIMEOUT_SECONDS.
    A rate-limit answer counts as ok (the key authenticated). Only exception class names are ever logged."""
    sdk = load_sdk()
    if sdk is None:
        return False, REASON_NO_SDK
    client = None
    try:
        client = sdk.AsyncAnthropic(api_key=key.strip(), base_url=API_BASE_URL, timeout=TEST_TIMEOUT_SECONDS,
                                    max_retries=0)

        async def call():
            return await client.models.list(limit=1)

        await asyncio.wait_for(call(), timeout=TEST_TIMEOUT_SECONDS)
        return True, REASON_OK
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - mapped to fixed reasons; never echo the message
        ok, reason = classify(sdk, exc)
        log.info("assistant key test: %s (%s)", "ok" if ok else "failed", type(exc).__name__)
        return ok, reason
    finally:
        close = getattr(client, "close", None) if client is not None else None
        if close is not None:
            try:
                result = close()
                if inspect.isawaitable(result):
                    await result
            except Exception:  # noqa: BLE001
                pass


test_key.__test__ = False   # not a pytest test when imported into a test module


__all__ = [
    "KEY_CACHE_SECONDS", "KEY_NAME", "KeyedSettings", "REASON_API_ERROR", "REASON_NO_ACCESS", "REASON_NO_SDK",
    "REASON_OK", "REASON_RATE_LIMITED", "REASON_REJECTED", "REASON_UNREACHABLE", "TEST_TIMEOUT_SECONDS", "classify",
    "env_key", "hint", "info", "invalidate", "load", "load_sdk", "master_key_configured", "remove", "resolve",
    "store", "test_key", "validate_format", "with_key",
]
