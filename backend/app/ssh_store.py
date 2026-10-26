"""Private SSH material, trusted inventory targets, and session metadata.

Importing this module never requires asyncssh. Private keys and terminal traffic
are deliberately absent from the audit model and public metadata helpers.
"""
from contextlib import contextmanager, suppress
from datetime import datetime, timezone
import asyncio
import base64
import glob
import errno
import hashlib
import importlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import threading
import time

import anyio

from fastapi import HTTPException
from sqlalchemy import Float, Integer, String, case, event as sa_event, func, insert, inspect as sa_inspect, literal, select, update
from sqlalchemy.orm import Mapped, mapped_column

from .database import AsyncSessionLocal, Base
from .models import Device, PingTarget
from .ping_monitor import server_identity, validate_host


SSH_DIR = Path(__file__).resolve().parents[1] / "ssh"
_LOCK = threading.RLock()
_LOCK_STATE = threading.local()
_SESSION_MUTEX = threading.Lock()
LOCK_TIMEOUT_SECONDS = 2.0
_SESSION_LOCKS: dict[tuple[str, int], int] = {}
_USER = re.compile(r"[a-z_][a-z0-9_-]{0,31}")
_SERVER_KEY = re.compile(r"[a-z0-9][a-z0-9_-]{0,127}")
END_REASONS = frozenset({"remote_closed", "browser_disconnected", "idle_timeout", "session_expired",
                         "lifetime_limit", "disabled", "host_key_changed", "connect_timeout",
                         "connection_failed", "invalid_message", "input_rate_limit", "cancelled",
                         "service_interrupted", "admin_action", "denied",
                         # Fixed connection-failure reasons shared by the terminal and the audit log.
                         "unreachable", "refused", "auth_failed"})
# How a terminal signs in: "system" = the VM's own OpenSSH `ssh` command in a PTY, exactly as the account running
# Lab Manager would type it (its ~/.ssh/config, agent, Kerberos tickets and known_hosts); "vm" = the VM account's own
# key files, then the site key; "site" = only the site key.
KEY_SOURCES = ("system", "vm", "site")
DEFAULT_KEY_SOURCE = "system"
# Stored with every configuration written since "system" exists. A configuration without it predates "system" and
# is read as "system" with every server allowed; an Admin can still choose "vm" or "site" again, which then stays.
KEY_SOURCE_VERSION = 2
# The VM account's default identity files, in the order OpenSSH offers them. Only file names ever leave this module.
VM_KEY_NAMES = ("id_ed25519", "id_ecdsa", "id_rsa")
SITE_KEY_NAME = "lab-manager"
MAX_VM_KEY_BYTES = 64 * 1024
_KEY_TYPE = re.compile(r"[a-z0-9@._+-]{1,64}")
_KEY_NAMES = frozenset({*VM_KEY_NAMES, SITE_KEY_NAME})
# ~/.ssh/config is read for its IdentityFile lines only: "config:<file name>" names such a key, never its path.
VM_CONFIG_NAME = "config"
# The system-wide client config, read after ~/.ssh/config the way ssh reads it (IdentityFile and Include only).
SYSTEM_SSH_CONFIG = Path("/etc/ssh/ssh_config")
MAX_INCLUDE_DEPTH = 8
MAX_CONFIG_FILES = 32
# Where an ssh-agent of this account usually listens when the service environment has no SSH_AUTH_SOCK.
AGENT_RUNTIME_NAMES = ("ssh-agent.socket", "openssh_agent", "ssh-agent", "keyring/ssh", "gcr/ssh",
                       "gnupg/S.gpg-agent.ssh")
MAX_VM_CONFIG_BYTES = 256 * 1024
MAX_CONFIG_KEYS = 16
_CONFIG_KEY_NAME = re.compile(r"config:[A-Za-z0-9@._+-]{1,57}")
_logger = logging.getLogger(__name__)
_LOGGED_SKIPS: set = set()
# Why an "allow every server" pass left a server out; the owner-facing text is built from the code.
SKIP_CODES = frozenset({"unresolved", "prohibited", "unchecked"})
_UNAVAILABLE = "SSH support is not installed on the server"


async def run_file_op(function, *args, **kwargs):
    """Keep storage waits off-loop and finish mutations before propagating cancellation."""
    operation = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(operation)
    except asyncio.CancelledError:
        with anyio.CancelScope(shield=True):
            while not operation.done():
                try:
                    await asyncio.shield(operation)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            with suppress(Exception, asyncio.CancelledError):
                operation.result()
        raise


class HostKeyChanged(Exception):
    """The observed key differs from an existing pin; never contains key data."""


class SshSession(Base):
    __tablename__ = "ssh_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user: Mapped[str] = mapped_column(String, index=True)
    user_id: Mapped[str] = mapped_column(String, default="")
    user_name: Mapped[str] = mapped_column(String, default="")
    remote_user: Mapped[str] = mapped_column(String, default="")
    client_ip: Mapped[str] = mapped_column(String, default="")
    connected_ip: Mapped[str] = mapped_column(String, default="")
    host_key_fingerprint: Mapped[str] = mapped_column(String, default="")
    event: Mapped[str] = mapped_column(String, default="terminal", index=True)
    server_key: Mapped[str] = mapped_column(String)
    host: Mapped[str] = mapped_column(String)
    started_at: Mapped[float] = mapped_column(Float, index=True)
    ended_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    end_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    bytes_in: Mapped[int] = mapped_column(Integer, default=0)
    bytes_out: Mapped[int] = mapped_column(Integer, default=0)
    # Which keys were offered ("vm"/"site"), and the type and file name of the key that signed in (never key material).
    key_source: Mapped[str] = mapped_column(String, default="", server_default="")
    key_type: Mapped[str] = mapped_column(String, default="", server_default="")
    key_name: Mapped[str] = mapped_column(String, default="", server_default="")


_ADDED_COLUMNS = ("key_source", "key_type", "key_name")


@sa_event.listens_for(Base.metadata, "after_create")
def _add_missing_columns(target, connection, **kwargs):
    """create_all never alters an existing table: add columns newer releases introduced, in place."""
    inspector = sa_inspect(connection)
    if not inspector.has_table(SshSession.__tablename__):
        return
    columns = {column["name"] for column in inspector.get_columns(SshSession.__tablename__)}
    for name in _ADDED_COLUMNS:  # Fixed identifiers only; nothing user-supplied reaches this DDL.
        if name not in columns:
            connection.exec_driver_sql(f"ALTER TABLE ssh_sessions ADD COLUMN {name} VARCHAR DEFAULT '' NOT NULL")


def load_asyncssh():
    try:
        logging.getLogger("asyncssh").setLevel(logging.WARNING)
        return importlib.import_module("asyncssh")
    except ImportError:
        raise HTTPException(status_code=503, detail=_UNAVAILABLE) from None


def installed() -> bool:
    try:
        load_asyncssh()
        return True
    except HTTPException:
        return False


def _not_link(info):
    # Windows junctions/reparse points require a separate check from S_ISLNK.
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise OSError("Unsafe SSH storage")


def _ensure_dir() -> Path:
    directory = Path(SSH_DIR)
    try:
        info = directory.lstat()
    except FileNotFoundError:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.lstat()
    _not_link(info)
    if not stat.S_ISDIR(info.st_mode):
        raise OSError("Unsafe SSH storage")
    if os.name != "nt" and stat.S_IMODE(info.st_mode) != 0o700:
        raise OSError("Unsafe SSH storage permissions")
    return directory


def _file_info(path: Path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    _not_link(info)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise OSError("Unsafe SSH storage")
    if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
        raise OSError("Unsafe SSH storage permissions")
    return info


def _read(path: Path) -> bytes | None:
    before = _file_info(path)
    if before is None:
        return None
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags)
    try:
        actual = os.fstat(descriptor)
        _not_link(actual)
        if (actual.st_dev, actual.st_ino) != (before.st_dev, before.st_ino):
            raise OSError("Unsafe SSH storage")
        if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1:
            raise OSError("Unsafe SSH storage")
        if os.name != "nt" and stat.S_IMODE(actual.st_mode) & 0o077:
            raise OSError("Unsafe SSH storage permissions")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            result = stream.read(1024 * 1024 + 1)
        if len(result) > 1024 * 1024:
            raise OSError("Invalid SSH storage")
        return result
    finally:
        os.close(descriptor)


def _write(path: Path, data: bytes):
    _file_info(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".ssh-", dir=path.parent)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        _file_info(path)
        os.replace(temporary, path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)


def _open_lock(path: Path, *, blocking: bool = True, deadline=None):
    """Open and acquire a validated advisory lock, or return None if busy."""
    before = _file_info(path)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        actual = os.fstat(descriptor)
        _not_link(actual)
        if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1:
            raise OSError("Unsafe SSH storage")
        if before is not None and (actual.st_dev, actual.st_ino) != (before.st_dev, before.st_ino):
            raise OSError("Unsafe SSH storage")
        if os.name != "nt" and stat.S_IMODE(actual.st_mode) & 0o077:
            raise OSError("Unsafe SSH storage permissions")
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS if deadline is None else deadline
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    if actual.st_size == 0:
                        os.write(descriptor, b"\0")
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                busy = (exc.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK) or
                        getattr(exc, "winerror", None) in (32, 33, 36))
                if not busy:
                    raise
                if not blocking:
                    os.close(descriptor)
                    return None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise HTTPException(503, "SSH storage is busy; retry shortly") from None
                time.sleep(min(0.01, remaining))
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _close_lock(descriptor):
    try:
        if os.name == "nt":
            import msvcrt
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


@contextmanager
def _process_lock(directory, *, blocking=True, deadline=None):
    descriptor = _open_lock(directory / ".lock", blocking=blocking, deadline=deadline)
    if descriptor is None:
        raise HTTPException(503, "SSH storage is busy; retry shortly")
    try:
        yield
    finally:
        _close_lock(descriptor)


def _session_lock_key(directory: Path, session_id: int):
    if not isinstance(session_id, int) or session_id < 1:
        raise ValueError("Invalid session ID")
    return str(directory.absolute()), session_id


def _acquire_session_lock(directory: Path, session_id: int) -> bool:
    key = _session_lock_key(directory, session_id)
    with _SESSION_MUTEX:
        if key in _SESSION_LOCKS:
            return False
    descriptor = _open_lock(directory / f".session-{session_id}.lock", blocking=False)
    if descriptor is None:
        return False
    with _SESSION_MUTEX:
        _SESSION_LOCKS[key] = descriptor
    return True


def _release_session_lock(directory: Path, session_id: int):
    key = _session_lock_key(directory, session_id)
    with _SESSION_MUTEX:
        descriptor = _SESSION_LOCKS.pop(key, None)
    if descriptor is not None:
        try:
            owned = os.fstat(descriptor)
        finally:
            _close_lock(descriptor)
        # Every acquire/release runs under the permanent .lock, so no
        # contender can hold an old inode while this filename is removed.
        path = directory / f".session-{session_id}.lock"
        current = _file_info(path)
        if current is not None:
            if (owned.st_dev, owned.st_ino) != (current.st_dev, current.st_ino):
                raise OSError("Unsafe SSH session lock")
            path.unlink()


def release_session_lock(session_id: int):
    """Always drop our OS lease; remove only a safely re-locked idle file."""
    try:
        key = _session_lock_key(Path(SSH_DIR), session_id)
    except Exception:
        return
    with _SESSION_MUTEX:
        descriptor = _SESSION_LOCKS.pop(key, None)
    if descriptor is None:
        return
    owned = None
    try:
        owned = os.fstat(descriptor)
    except Exception:
        pass
    finally:
        try:
            _close_lock(descriptor)
        except Exception:
            pass
    try:
        with _storage() as directory:
            path = directory / f".session-{session_id}.lock"
            current = _file_info(path)
            if owned is None or current is None or (owned.st_dev, owned.st_ino) != (current.st_dev, current.st_ino):
                return
            # Recheck under the permanent global lock before removing a released inode.
            probe = _open_lock(path, blocking=False)
            if probe is not None:
                _close_lock(probe)
                path.unlink()
    except Exception:
        pass  # Storage failure can prevent deletion; our descriptor is already closed.


@contextmanager
def _storage(*, blocking=True):
    deadline = time.monotonic() + (LOCK_TIMEOUT_SECONDS if blocking else 0)
    if not _LOCK.acquire(timeout=max(0, deadline - time.monotonic())):
        raise HTTPException(503, "SSH storage is busy; retry shortly")
    try:
        try:
            directory = _ensure_dir()
            if getattr(_LOCK_STATE, "depth", 0):
                # Key generation returns key_info() while still holding the lock.
                yield directory
            else:
                with _process_lock(directory, blocking=blocking, deadline=deadline):
                    _LOCK_STATE.depth = 1
                    try:
                        # Runtime material must remain excluded even when the
                        # checkout's root .gitignore predates SSH support.
                        if _read(directory / ".gitignore") != b"*\n":
                            _write(directory / ".gitignore", b"*\n")
                        yield directory
                    finally:
                        _LOCK_STATE.depth = 0
        except (OSError, ValueError, UnicodeError):
            # A malformed key or path must not leak its contents through errors.
            raise HTTPException(status_code=500, detail="SSH storage is unavailable") from None
    finally:
        _LOCK.release()


def _public_text(key) -> str:
    value = key.export_public_key("openssh") if hasattr(key, "export_public_key") else key
    if isinstance(value, bytes):
        value = value.decode("ascii")
    fields = str(value).strip().split()
    if len(fields) < 2:
        raise ValueError("Invalid public key")
    base64.b64decode(fields[1], validate=True)
    return fields[0] + " " + fields[1]


def _fingerprint(public: str) -> str:
    blob = base64.b64decode(public.split()[1], validate=True)
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")


def _history(directory: Path) -> list[dict]:
    raw = _read(directory / "key_history.json")
    history = json.loads(raw) if raw else []
    if not isinstance(history, list):
        raise ValueError("Invalid SSH key history")
    result = []
    for item in history:
        if not isinstance(item, dict):
            raise ValueError("Invalid SSH key history")
        public = _public_text(item.get("public_key", ""))
        comment = str(item.get("comment", ""))
        if comment and not re.fullmatch(r"dcim-204-[0-9]{8}-[0-9a-f]{6}", comment):
            raise ValueError("Invalid SSH key comment")
        result.append({"public_key": public + (" " + comment if comment else ""),
                       "fingerprint": _fingerprint(public), "comment": comment})
    return result


def key_info() -> dict:
    with _storage() as directory:
        exists = _read(directory / "id_ed25519") is not None
        public = _read(directory / "id_ed25519.pub") if exists else None
        text = _public_text(public) if public else ""
        fields = public.decode("ascii").strip().split(maxsplit=2) if public else []
        comment = fields[2] if len(fields) > 2 else ""
        if comment and not re.fullmatch(r"dcim-204-[0-9]{8}-[0-9a-f]{6}", comment):
            raise ValueError("Invalid SSH key comment")
        fingerprint = _fingerprint(text) if text else ""
        history = [entry for entry in _history(directory) if entry["fingerprint"] != fingerprint]
        return {"key_exists": exists, "public_key": text + (" " + comment if comment else ""),
                "fingerprint": fingerprint, "comment": comment, "previous_keys": history}


def revoked_keys() -> list[dict]:
    return key_info()["previous_keys"]


def _json_bytes(value) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def generate_key(rotate: bool = False, expected_fingerprint: str | None = None) -> dict:
    asyncssh = load_asyncssh()
    with _storage() as directory:
        path = directory / "id_ed25519"
        previous = _read(path)
        current = key_info()
        if rotate:
            if expected_fingerprint is None:
                raise HTTPException(status_code=428, detail="SSH key fingerprint is required")
            if not previous:
                raise HTTPException(status_code=409, detail="SSH key has not been generated")
            if expected_fingerprint != current["fingerprint"]:
                raise HTTPException(status_code=412, detail="SSH key has changed")
        if previous is None or rotate:
            key = asyncssh.generate_private_key("ssh-ed25519")
            comment = "dcim-204-" + datetime.now(timezone.utc).strftime("%Y%m%d") + "-" + secrets.token_hex(3)
            if rotate and current["public_key"]:
                history = _history(directory)
                if not any(entry["fingerprint"] == current["fingerprint"] for entry in history):
                    history.append({name: current[name] for name in ("public_key", "fingerprint", "comment")})
                    # Record the revocation identity before replacement; readers
                    # hide any history entry that still matches the active key.
                    _write(directory / "key_history.json", _json_bytes(history))
            _write(path, key.export_private_key("openssh"))
        else:
            key = asyncssh.import_private_key(previous)
            comment = current["comment"] or (
                "dcim-204-" + datetime.now(timezone.utc).strftime("%Y%m%d") + "-" + secrets.token_hex(3))
        _write(directory / "id_ed25519.pub", (_public_text(key) + " " + comment + "\n").encode("ascii"))
        return key_info()


def private_key():
    """Return a parsed key for connection setup, never for an API response."""
    asyncssh = load_asyncssh()
    with _storage() as directory:
        data = _read(directory / "id_ed25519")
        if data is None:
            raise HTTPException(status_code=409, detail="SSH key has not been generated")
        return asyncssh.import_private_key(data)


def _vm_key_dir(directory) -> Path:
    # The account running Lab Manager: the same ~/.ssh its own `ssh root@server` uses. Of ~/.ssh/config only the
    # IdentityFile lines are read (_config_identities); nothing else in it has any effect.
    return Path(directory) if directory else Path.home() / ".ssh"


def _skip(name: str, reason: str, what: str = "VM SSH key") -> dict:
    if (name, reason) not in _LOGGED_SKIPS:  # Once per file and reason; the file name only, never its path or content.
        _LOGGED_SKIPS.add((name, reason))
        _logger.warning("%s %s is not used: %s", what, name, reason)
    return {"name": name, "type": "", "usable": False, "reason": reason}


def _read_vm_file(path: Path, limit: int, unsafe, too_large: str):
    """(bytes, "") for a file of the VM account; (None, fixed reason) when it is skipped; (None, None) when missing.

    stat first (following a symlink like ssh does), so a FIFO, device or directory is never opened; the open file
    must be the one stat saw; `unsafe(info)` gives a refusal reason for its owner or mode, or ""."""
    try:
        before = os.stat(path)
    except FileNotFoundError:
        return None, None
    except (OSError, ValueError):
        return None, "not readable by the account running Lab Manager"
    if not stat.S_ISREG(before.st_mode):
        return None, "not a regular file"
    try:
        # O_NONBLOCK: a file swapped for a FIFO between stat and open cannot hang the worker.
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino):
                return None, "changed while Lab Manager was reading it"
            reason = unsafe(info)
            if reason:
                return None, reason
            data = stream.read(limit + 1)
    except FileNotFoundError:
        return None, None
    except (OSError, ValueError):
        return None, "not readable by the account running Lab Manager"
    if len(data) > limit:
        return None, too_large
    return data, ""


def _key_mode(info) -> str:
    if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
        return "readable by other users (chmod 600 it)"  # OpenSSH ignores such a key too ("UNPROTECTED PRIVATE KEY FILE").
    return ""


def _config_mode(info) -> str:
    # OpenSSH refuses such a config too ("Bad owner or permissions on ~/.ssh/config").
    if os.name != "nt" and info.st_uid not in (os.getuid(), 0):
        return "owned by another account"
    if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o022:
        return "writable by other users (chmod 600 it)"
    return ""


def _own_socket(path) -> bool:
    try:
        info = os.stat(path)
    except (OSError, ValueError):
        return False
    return stat.S_ISSOCK(info.st_mode) and (os.name == "nt" or info.st_uid == os.getuid())


def agent_socket(environ=None) -> str:
    """The ssh-agent socket of the account running Lab Manager: SSH_AUTH_SOCK when it names a live socket, else
    the first socket of this account in the usual places (systemd/desktop runtime folder, /tmp/ssh-*/agent.*,
    newest first). "" when there is none. Only sockets owned by this account are ever used."""
    environ = os.environ if environ is None else environ
    configured = environ.get("SSH_AUTH_SOCK", "")
    if configured and _own_socket(configured):
        return configured
    if os.name != "posix":
        return ""
    runtime = environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    candidates = [str(Path(runtime) / name) for name in AGENT_RUNTIME_NAMES]
    with suppress(OSError):
        found = glob.glob("/tmp/ssh-*/agent.*")[:64]
        candidates += sorted(found, key=lambda item: os.stat(item).st_mtime if os.path.exists(item) else 0,
                             reverse=True)
    return next((path for path in candidates if _own_socket(path)), "")


def passphrase_reason(name: str) -> str:
    base = name.split(":", 1)[-1]
    if agent_socket():
        return (f"protected by a passphrase; the ssh-agent may hold {base} - choose \"This VM's ssh command\" in "
                "Admin \u2192 SSH to use it")
    return (f"The VM's key {base} needs its passphrase (ssh-agent); install the Lab Manager key once "
            "(Admin \u2192 SSH) or start Lab Manager with access to the agent")


def _load_vm_key(asyncssh, path: Path, name: str):
    """(report row or None, key or None) for one identity file; reasons are fixed texts, never library output."""
    data, reason = _read_vm_file(path, MAX_VM_KEY_BYTES, _key_mode, "too large to be a private key")
    if data is None:
        return (None if reason is None else _skip(name, reason)), None
    encrypted, key = b"ENCRYPTED" in data, None
    if not encrypted:
        try:
            key = asyncssh.import_private_key(data)  # Never with a passphrase: encrypted keys are skipped.
        except Exception as error:
            encrypted = "passphrase" in str(error).lower()
    del data
    if encrypted:
        return _skip(name, passphrase_reason(name)), None
    if key is None:
        return _skip(name, "not a private key Lab Manager can read"), None
    return {"name": name, "type": key_type_of(key), "usable": True, "reason": ""}, key


def key_type_of(key) -> str:
    try:
        value = key.get_algorithm()
        value = value.decode("ascii") if isinstance(value, bytes) else str(value)
    except Exception:
        return ""
    return value if _KEY_TYPE.fullmatch(value) else ""


_CONFIG_LINE = re.compile(r"\s*([^\s=]+)\s*=?\s*(.*)", re.DOTALL)


def _config_words(line: str) -> list[str]:
    """One ssh_config line split the way OpenSSH does: the keyword (optionally followed by "="), then arguments
    with "..."/'...' quoting and \\" \\' \\\\ escapes; "#" outside quotes starts a comment. [] for a blank,
    comment or unterminated-quote line."""
    match = _CONFIG_LINE.match(line)
    if not match or match[1].startswith("#"):
        return []
    rest, words, word, quote, started, index = match[2], [match[1]], [], "", False, 0
    while index < len(rest):
        char, following = rest[index], rest[index + 1:index + 2]
        if char == "\\" and following and (following in "'\"\\" or (not quote and following == " ")):
            word.append(following)
            started, index = True, index + 2
            continue
        if not quote and char in " \t":
            if started:
                words.append("".join(word))
                word, started = [], False
        elif not quote and char == "#" and not started:
            break
        elif not quote and char in "'\"":
            quote, started = char, True
        elif quote and char == quote:
            quote = ""
        else:
            word.append(char)
            started = True
        index += 1
    if quote:
        return []
    if started:
        words.append("".join(word))
    return words


def _wildcard_match(pattern: str, text: str) -> bool:
    """`*` and `?` only, case-insensitive; no regex, so an inventory name cannot make it backtrack (O(len*len))."""
    pattern, text = re.sub(r"\*+", "*", pattern.lower()), text.lower()
    if len(pattern) - pattern.count("*") > len(text):
        return False  # Exact: more characters to match than the text has.
    p = t = 0
    star, mark = -1, 0
    while t < len(text):
        if p < len(pattern) and pattern[p] in ("?", text[t]) and pattern[p] != "*":
            p, t = p + 1, t + 1
        elif p < len(pattern) and pattern[p] == "*":
            star, mark, p = p, t, p + 1
        elif star >= 0:
            mark += 1
            p, t = star + 1, mark
        else:
            return False
    return all(char == "*" for char in pattern[p:])


def _host_line_matches(patterns, names) -> bool:
    """OpenSSH's `Host` rule (*, ?, !negation, several patterns, case-insensitive) against every name the target
    is known by: a negated pattern that matches any of them rules the block out; otherwise any matching plain
    pattern brings it in."""
    matched = False
    for pattern in patterns:
        negated = pattern.startswith("!")
        if any(_wildcard_match(pattern[1:] if negated else pattern, name) for name in names):
            if negated:
                return False
            matched = True
    return matched


def _local_user():
    try:
        import getpass
        return getpass.getuser() or None
    except Exception:
        return None


def _expand_identity(value: str, home: Path, target: dict | None):
    """(path, "") for one IdentityFile value, expanded the way ssh does but minimally: ~/, %d, %u, %h, %r and %%.
    (None, fixed reason) for anything else (other % tokens, ${VAR}, ~user, a relative path); (None, "") when the
    entry names no file ("none"), or names the server (%h, %r) and no server is given."""
    if value.lower() == "none":
        return None, ""
    if "${" in value:
        return None, "uses ${...}, which Lab Manager does not expand"
    if value == "~" or value.startswith("~/"):
        value = str(home) + value[1:]
    elif value.startswith("~"):
        return None, "uses ~user, which Lab Manager does not expand"
    tokens = {"%": "%", "d": str(home), "u": _local_user(),
              "h": (target or {}).get("host") or None, "r": (target or {}).get("user") or None}
    parts, index = [], 0
    while index < len(value):
        if value[index] != "%":
            parts.append(value[index])
            index += 1
            continue
        token = value[index + 1:index + 2]
        if not tokens.get(token):
            if target is None and token in ("h", "r"):
                return None, ""  # Depends on the server: checked when a terminal to it opens.
            return None, "uses a % token Lab Manager does not expand"
        parts.append(tokens[token])
        index += 2
    path = Path("".join(parts))
    if not path.is_absolute():
        return None, "not an absolute path"
    return path, ""


def _config_key_name(value: str) -> str:
    """The name of an IdentityFile entry, "config:<file name>": the base name only (never a folder), safe characters."""
    base = re.split(r"[\\/]", value.rstrip("\\/"))[-1]
    return "config:" + (re.sub(r"[^A-Za-z0-9@._+-]", "_", base)[:57] or "key")


def _same_file(path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def _config_values(path: Path, label: str, base: Path, home: Path, names, active: bool, depth: int, budget: list):
    """IdentityFile values (and report rows for unusable files) of one ssh config file, in file order. Include is
    followed for IdentityFile lines only (relative to `base`, ~/ expanded, globs sorted), at most MAX_INCLUDE_DEPTH
    deep and MAX_CONFIG_FILES files in all; an Include inside an inactive Host block is not followed."""
    if budget[0] <= 0:
        return []
    budget[0] -= 1
    data, reason = _read_vm_file(path, MAX_VM_CONFIG_BYTES, _config_mode, "too large to be an SSH config")
    if data is None:
        return [] if reason is None else [_skip(label, reason, "VM SSH")]
    values = []
    for line in data.decode("utf-8", "replace").splitlines():
        words = _config_words(line)
        keyword = words[0].lower() if words else ""
        if keyword == "host":
            active = names is None or _host_line_matches(words[1:], names)
        elif keyword == "match":
            active = False
        elif keyword == "identityfile" and active and len(words) == 2:
            values.append(words[1])
        elif keyword == "include" and active and depth < MAX_INCLUDE_DEPTH:
            for pattern in words[1:]:
                if "%" in pattern or "${" in pattern or (pattern.startswith("~") and not pattern.startswith("~/")):
                    continue
                pattern = str(home) + pattern[1:] if pattern.startswith("~/") else pattern
                pattern = pattern if Path(pattern).is_absolute() else str(base / pattern)
                for included in sorted(glob.glob(pattern))[:MAX_CONFIG_FILES]:
                    values += _config_values(Path(included), Path(included).name[:64] or "include", base, home,
                                             names, active, depth + 1, budget)
    del data
    return values


def _config_identities(folder: Path, target: dict | None) -> list:
    """The IdentityFile entries that apply to `target` ({"host", "name", "user"}), in the order ssh reads them:
    <folder>/config, then the system-wide /etc/ssh/ssh_config (each with the files their Include lines name); each
    key file once, at most MAX_CONFIG_KEYS: a path to load or a report row for an entry that cannot be used.

    Lines before the first Host count for every server; a Host block counts when its patterns match the target's
    saved host or name; Match blocks never count. Every other directive (ProxyCommand, ProxyJump, LocalCommand,
    IdentityAgent, CertificateFile, Port, User, HostName...) is ignored: never run or used.
    Without a target (Admin → SSH) every Host block counts and entries naming the server (%h, %r) are left out."""
    names = None if target is None else [  # A saved host is at most 253 characters; longer names are not matched.
        value for value in (str(target.get(field) or "").strip() for field in ("host", "name")) if 0 < len(value) <= 255]
    budget = [MAX_CONFIG_FILES]
    values = _config_values(folder / VM_CONFIG_NAME, VM_CONFIG_NAME, folder, folder.parent, names, True, 0, budget)
    values += _config_values(SYSTEM_SSH_CONFIG, SYSTEM_SSH_CONFIG.name, SYSTEM_SSH_CONFIG.parent, folder.parent,
                             names, True, 0, budget)
    entries, seen = [], set()
    for value in values:
        if isinstance(value, dict):
            entries.append(value)
            continue
        path, reason = _expand_identity(value, folder.parent, target)
        if path is None and not reason:
            continue
        same = _same_file(path) if path is not None else "\0" + value
        if same in seen:
            continue
        if len(seen) >= MAX_CONFIG_KEYS:
            _skip(VM_CONFIG_NAME, f"names more than {MAX_CONFIG_KEYS} key files; the rest are not used", "VM SSH")
            break
        seen.add(same)
        entries.append(path if path is not None else _skip(_config_key_name(value), reason))
    return entries


def vm_keys(directory=None, target=None) -> tuple[list[dict], list]:
    """The VM account's own private keys: (report rows, [(name, type, key), ...] usable, in offer order).

    In the order the VM account's `ssh` offers them: the IdentityFile keys its ~/.ssh/config names for `target`
    (see _config_identities; named "config:<file name>"), then ~/.ssh/id_ed25519, id_ecdsa and id_rsa unless the
    config already named them. The agent and every other file are ignored. Report rows hold file names, key types
    and fixed reasons only, never a path. Missing files are left out."""
    asyncssh = load_asyncssh()
    folder = _vm_key_dir(directory)
    defaults = {_same_file(folder / name): name for name in VM_KEY_NAMES}
    candidates = [entry if isinstance(entry, dict) else
                  (defaults.get(_same_file(entry)) or _config_key_name(str(entry)), entry)
                  for entry in _config_identities(folder, target)]
    named = {_same_file(entry[1]) for entry in candidates if isinstance(entry, tuple)}
    candidates += [(name, folder / name) for name in VM_KEY_NAMES if _same_file(folder / name) not in named]
    report, usable = [], []
    for entry in candidates:
        if isinstance(entry, dict):
            report.append(entry)
            continue
        name, path = entry
        row, key = _load_vm_key(asyncssh, path, name)
        if row is None:
            continue
        report.append(row)
        if key is not None:
            usable.append((name, row["type"], key))
    return report, usable


def vm_key_report(directory=None) -> list[dict]:
    try:
        return vm_keys(directory)[0]
    except HTTPException:
        return []  # asyncssh missing: the status already says SSH is not installed.


def _valid_user(value) -> bool:
    return isinstance(value, str) and _USER.fullmatch(value) is not None


def _server_key(value: str) -> str:
    if not isinstance(value, str) or _SERVER_KEY.fullmatch(value) is None:
        raise HTTPException(status_code=422, detail="Invalid SSH server key")
    return value


def _slug(value: str) -> str:
    return value if _SERVER_KEY.fullmatch(value) else "s-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def _host(value: str) -> str:
    try:
        result = validate_host(value)
        if result:
            return result
    except (ValueError, TypeError, AttributeError):
        pass
    raise HTTPException(status_code=422, detail="Invalid SSH host")


def _config(directory: Path) -> dict:
    raw = _read(directory / "config.json")
    config = json.loads(raw) if raw else {}
    if not isinstance(config, dict):
        raise ValueError("Invalid SSH configuration")
    default = config.get("default_user", "root")
    overrides = config.get("per_server_user", {})
    targets = config.get("targets", {})
    if not _valid_user(default) or not isinstance(overrides, dict) or not isinstance(targets, dict):
        raise ValueError("Invalid SSH configuration")
    if not all(isinstance(key, str) and _SERVER_KEY.fullmatch(key) and _valid_user(value)
               for key, value in overrides.items()):
        raise ValueError("Invalid SSH configuration")
    approved = {}
    for key, host in targets.items():
        if not isinstance(key, str) or not _SERVER_KEY.fullmatch(key):
            raise ValueError("Invalid SSH configuration")
        approved[key] = _host(host)
    # Owner decision: a configuration that never set these allows every server and signs in like the VM's ssh.
    auto_allow = config.get("auto_allow", True)
    key_source = config.get("key_source", DEFAULT_KEY_SOURCE)
    if config.get("key_source_version") != KEY_SOURCE_VERSION:
        # Migration (owner decision): every configuration saved before "system" existed moves to the VM's own ssh
        # command with every lab server allowed; turned-off servers stay turned off.
        key_source, auto_allow = "system", True
    if type(auto_allow) is not bool or key_source not in KEY_SOURCES:
        raise ValueError("Invalid SSH configuration")
    return {"default_user": default, "per_server_user": overrides, "targets": approved, "auto_allow": auto_allow,
            "key_source": key_source, "denied": _denied(config.get("denied", []), ValueError),
            "denied_hosts": _host_map(config.get("denied_hosts", {}), ValueError),
            "auto_hosts": _host_map(config.get("auto_hosts", {}), ValueError),
            "auto_skipped": _auto_skipped(config.get("auto_skipped", {}), ValueError)}


def _host_map(value, error) -> dict:
    """{server key: host}: denied_hosts (the saved host of each server an Admin turned off, captured then) and
    auto_hosts (the saved hosts the Admin's last "allow every server" pass checked and allowed)."""
    if not isinstance(value, dict) or len(value) > 10000:
        raise error("Invalid SSH configuration")
    result = {}
    for key, host in value.items():
        if not isinstance(key, str) or not _SERVER_KEY.fullmatch(key):
            raise error("Invalid SSH configuration")
        try:
            result[key] = _host(host)
        except HTTPException:
            raise error("Invalid SSH configuration") from None
    return result


def _denied(value, error) -> list:
    """Servers an Admin explicitly turned SSH off for; this wins over every approval."""
    if not isinstance(value, list) or len(value) > 10000 or not all(
            isinstance(key, str) and _SERVER_KEY.fullmatch(key) for key in value):
        raise error("Invalid SSH configuration")
    return sorted(set(value))


def _auto_skipped(value, error) -> dict:
    """Servers the last "allow every server" pass left out, pinned to the saved host that failed its check."""
    if not isinstance(value, dict) or len(value) > 10000:
        raise error("Invalid SSH configuration")
    result = {}
    for key, item in value.items():
        if (not isinstance(key, str) or not _SERVER_KEY.fullmatch(key) or not isinstance(item, dict) or
                set(item) != {"host", "reason"} or item["reason"] not in SKIP_CODES):
            raise error("Invalid SSH configuration")
        try:
            result[key] = {"host": _host(item["host"]), "reason": item["reason"]}
        except HTTPException:
            raise error("Invalid SSH configuration") from None
    return result


def _etag(config: dict) -> str:
    return '"' + hashlib.sha256(_json_bytes(config)).hexdigest() + '"'


def read_config() -> dict:
    with _storage() as directory:
        return _config(directory)


def config_etag(config: dict | None = None) -> str:
    if config is not None:
        return _etag(config)
    with _storage() as directory:
        return _etag(_config(directory))


def _invalid_config(message):
    return HTTPException(status_code=422, detail="Invalid SSH configuration")


def write_config(default_user: str, per_server_user: dict, targets: dict,
                 expected_etag: str | None, *, auto_allow: bool | None = None,
                 denied: list | None = None, auto_skipped: dict | None = None, key_source: str | None = None,
                 denied_hosts: dict | None = None, auto_hosts: dict | None = None):
    """Replace the configuration if it still matches expected_etag; None keeps that stored field."""
    if expected_etag is None:
        raise HTTPException(status_code=428, detail="SSH configuration precondition is required")
    if not _valid_user(default_user) or not isinstance(per_server_user, dict) or not all(
        isinstance(key, str) and _SERVER_KEY.fullmatch(key) and _valid_user(value)
        for key, value in per_server_user.items()
    ):
        raise HTTPException(status_code=422, detail="Invalid SSH user")
    if not isinstance(targets, dict):
        raise HTTPException(status_code=422, detail="Invalid SSH targets")
    if auto_allow is not None and type(auto_allow) is not bool:
        raise HTTPException(status_code=422, detail="Invalid SSH configuration")
    if key_source is not None and key_source not in KEY_SOURCES:
        raise HTTPException(status_code=422, detail="Invalid SSH configuration")
    approved = {_server_key(key): _host(host) for key, host in targets.items()}
    denied = None if denied is None else _denied(denied, _invalid_config)
    auto_skipped = None if auto_skipped is None else _auto_skipped(auto_skipped, _invalid_config)
    denied_hosts = None if denied_hosts is None else _host_map(denied_hosts, _invalid_config)
    auto_hosts = None if auto_hosts is None else _host_map(auto_hosts, _invalid_config)
    with _storage() as directory:
        stored = _config(directory)
        if expected_etag != _etag(stored):
            raise HTTPException(status_code=412, detail="SSH configuration has changed")
        config = {"default_user": default_user, "per_server_user": dict(per_server_user), "targets": approved,
                  "auto_allow": stored["auto_allow"] if auto_allow is None else auto_allow,
                  "key_source": stored["key_source"] if key_source is None else key_source,
                  "denied": stored["denied"] if denied is None else denied,
                  "denied_hosts": stored["denied_hosts"] if denied_hosts is None else denied_hosts,
                  "auto_hosts": stored["auto_hosts"] if auto_hosts is None else auto_hosts,
                  "auto_skipped": stored["auto_skipped"] if auto_skipped is None else auto_skipped}
        # An explicit "not allowed" always wins over an approval of the same server.
        config["targets"] = {key: host for key, host in approved.items() if key not in config["denied"]}
        config["denied_hosts"] = {key: host for key, host in config["denied_hosts"].items() if key in config["denied"]}
        if not config["auto_allow"]:
            config["auto_skipped"], config["auto_hosts"] = {}, {}
        _write(directory / "config.json", _json_bytes({**config, "key_source_version": KEY_SOURCE_VERSION}))
    return config


def _decode_pins(raw: bytes | None) -> dict:
    pins = json.loads(raw) if raw is not None else {}
    if not isinstance(pins, dict):
        raise ValueError("Invalid SSH host pins")
    for server_key, pin in pins.items():
        if not isinstance(server_key, str) or not _SERVER_KEY.fullmatch(server_key) or not isinstance(pin, dict):
            raise ValueError("Invalid SSH host pin")
        try:
            _host(pin.get("host"))
        except HTTPException:
            raise ValueError("Invalid SSH host pin") from None
        public = _public_text(pin.get("public_key", ""))
        if pin.get("fingerprint") != _fingerprint(public) or not isinstance(pin.get("confirmed"), bool):
            raise ValueError("Invalid SSH host pin")
        offered = pin.get("offered_public_key", "")
        if offered and pin.get("offered_fingerprint") != _fingerprint(_public_text(offered)):
            raise ValueError("Invalid SSH offered host pin")
        if not offered and pin.get("offered_fingerprint"):
            raise ValueError("Invalid SSH offered host pin")
    return pins


def _pins(directory: Path) -> dict:
    path = directory / "host_pins.json"
    legacy = directory / "known_hosts"
    raw, old_raw = _read(path), _read(legacy)
    pins = _decode_pins(raw)
    if old_raw is not None:
        # Only the previous JSON representation is eligible for migration.
        # Invalid/unsafe legacy data always fails closed, even if new pins exist.
        old_pins = _decode_pins(old_raw)
        if raw is None:
            _file_info(legacy)
            if _file_info(path) is not None:
                raise OSError("SSH host pins changed during migration")
            os.replace(legacy, path)
            pins = old_pins
        else:
            if pins != old_pins:
                raise ValueError("Conflicting SSH host pin files")
            _file_info(legacy)
            legacy.unlink()
    return pins


def _host_info(pin: dict | None) -> dict:
    return {"fingerprint": pin["fingerprint"] if pin else "",
            "confirmed": bool(pin and pin["confirmed"]),
            "offered_fingerprint": pin.get("offered_fingerprint", "") if pin else "",
            "host_key_known": pin is not None}


def host_info(server_key: str) -> dict:
    server_key = _server_key(server_key)
    with _storage() as directory:
        return _host_info(_pins(directory).get(server_key))


def known_host(server_key: str) -> bool:
    return host_info(server_key)["host_key_known"]


def pin_host(server_key: str, host: str, key, *, blocking: bool = True) -> bool:
    """Pin by server identity, recording a changed offer without trusting it."""
    server_key, host = _server_key(server_key), _host(host)
    with _storage(blocking=blocking) as directory:
        public = _public_text(key)
        fingerprint = _fingerprint(public)
        pins = _pins(directory)
        pin = pins.get(server_key)
        if pin is not None:
            if public != pin["public_key"]:
                pin.update(host=host, offered_public_key=public, offered_fingerprint=fingerprint)
                _write(directory / "host_pins.json", _json_bytes(pins))
                raise HostKeyChanged("SSH host key changed")
            if pin["host"] != host:
                pin["host"] = host
                _write(directory / "host_pins.json", _json_bytes(pins))
            return False
        pins[server_key] = {"host": host, "public_key": public, "fingerprint": fingerprint,
                            "confirmed": False, "offered_public_key": "", "offered_fingerprint": ""}
        _write(directory / "host_pins.json", _json_bytes(pins))
        return True


def accept_host(server_key: str, expected_fingerprint: str | None, fingerprint: str) -> dict:
    server_key = _server_key(server_key)
    if expected_fingerprint is None:
        raise HTTPException(status_code=428, detail="SSH host fingerprint precondition is required")
    with _storage() as directory:
        pins = _pins(directory)
        pin = pins.get(server_key)
        if pin is None:
            raise HTTPException(status_code=404, detail="SSH host key has not been observed")
        if expected_fingerprint != pin["fingerprint"]:
            raise HTTPException(status_code=412, detail="SSH host key has changed")
        if fingerprint == pin["fingerprint"]:
            pass
        elif fingerprint and fingerprint == pin.get("offered_fingerprint"):
            pin["public_key"] = pin["offered_public_key"]
            pin["fingerprint"] = fingerprint
        else:
            raise HTTPException(status_code=409, detail="SSH fingerprint is no longer offered")
        pin.update(confirmed=True, offered_public_key="", offered_fingerprint="")
        _write(directory / "host_pins.json", _json_bytes(pins))
        return _host_info(pin)


async def known_servers(db) -> list[dict]:
    """Resolve only saved server identities; never probe or consult live caches."""
    found = {}
    devices = (await db.execute(select(Device).order_by(Device.id))).scalars().all()
    for device in devices:
        if device.kind not in ("pdu", "kvm"):
            continue
        labels = device.labels
        if not isinstance(labels, dict):
            continue
        for label in labels.values():
            identity = server_identity(label)
            if identity and identity[2]:
                key, name, host = identity
                found.setdefault(key, {"key": key, "name": name, "host": host})
    targets = (await db.execute(select(PingTarget).order_by(PingTarget.id))).scalars().all()
    for target in targets:
        if not target.source_key.startswith("server:"):
            continue
        key = target.source_key[len("server:"):]
        if not key:
            continue
        identity = server_identity(target.name)
        name = identity[1] if identity else str(target.name or "").strip()
        try:
            # An invalid explicit override is excluded, never silently replaced
            # by a same-named device label or another destination.
            host = validate_host(target.host) if target.host else (identity[2] if identity else "")
        except (ValueError, TypeError, AttributeError):
            host = ""
        if not host:
            found.pop(key, None)
            continue
        found[key] = {"key": key, "name": name, "host": host}
    slugs, collisions = {}, set()
    for raw_key, item in found.items():
        slug = _slug(raw_key)
        if slug in slugs:
            collisions.add(slug)
        else:
            slugs[slug] = {**item, "key": slug}
    # Never let a deliberately colliding label inherit an approved identity.
    return sorted((item for slug, item in slugs.items() if slug not in collisions),
                  key=lambda item: (item["name"].casefold(), item["key"]))


def _orphaned_sessions(active_ids):
    interrupted = []
    with _storage() as directory:
        for session_id in active_ids:
            if _acquire_session_lock(directory, session_id):
                interrupted.append(session_id)
                _release_session_lock(directory, session_id)
    return interrupted


def _reserve_session_lock(session_id):
    with _storage() as directory:
        return _acquire_session_lock(directory, session_id)


async def start_session(db, user: str, server_key: str, host: str, *,
                        max_per_user: int = 4, max_total: int = 20,
                        max_connects_per_minute: int = 6, user_id: str = "",
                        user_name: str = "", client_ip: str = "", connected_ip: str = "",
                        host_key_fingerprint: str = "", remote_user: str = "",
                        key_source: str = "") -> SshSession:
    """Reserve capacity and the connection rate in one conditional DB insert."""
    server_key = _server_key(server_key)
    host = _host(host)
    active = (SshSession.ended_at.is_(None)) & (SshSession.event == "terminal")
    active_ids = (await db.execute(select(SshSession.id).where(active))).scalars().all()
    # OS locks disappear on process death, unlike durable audit rows.
    interrupted = await run_file_op(_orphaned_sessions, active_ids)
    if interrupted:
        await db.execute(update(SshSession).where(
            SshSession.id.in_(interrupted), active,
        ).values(ended_at=time.time(), end_reason="service_interrupted"))
    total = select(func.count()).select_from(SshSession).where(active).scalar_subquery()
    user_count = select(func.count()).select_from(SshSession).where(
        active, SshSession.user == user,
    ).scalar_subquery()
    started_at = time.time()
    recent_filter = (SshSession.user == user, SshSession.server_key == server_key,
                     SshSession.event == "terminal", SshSession.started_at > started_at - 60)
    recent = select(func.count()).select_from(SshSession).where(*recent_filter).scalar_subquery()
    fields = {"user": user, "user_id": user_id, "user_name": user_name, "remote_user": remote_user, "client_ip": client_ip,
              "connected_ip": connected_ip, "host_key_fingerprint": host_key_fingerprint,
              "event": "terminal", "server_key": server_key, "host": host, "started_at": started_at,
              "ended_at": None, "end_reason": None, "bytes_in": 0, "bytes_out": 0,
              "key_source": key_source if key_source in KEY_SOURCES else "", "key_type": "", "key_name": ""}
    values = select(*(literal(value) for value in fields.values())).where(
        total < max(0, int(max_total)), user_count < max(0, int(max_per_user)),
        recent < max(0, int(max_connects_per_minute)),
    )
    statement = insert(SshSession).from_select(list(fields), values).returning(SshSession.id)
    session_id = None
    leased = False
    try:
        session_id = (await db.execute(statement)).scalar_one_or_none()
        if session_id is None:
            attempts = (await db.execute(select(func.count()).select_from(SshSession).where(
                *recent_filter))).scalar_one()
            reason = ("SSH connection rate limit reached" if attempts >= max(0, int(max_connects_per_minute))
                      else "SSH session limit reached")
            raise HTTPException(status_code=429, detail=reason)
        leased = await run_file_op(_reserve_session_lock, session_id)
        if not leased:
            raise HTTPException(status_code=503, detail="SSH session reservation is unavailable")
        await db.commit()
        # No await follows commit: cancellation cannot lose the returned audit
        # identifier between a successful commit and the caller's assignment.
        return SshSession(id=session_id, **fields)
    except BaseException:
        try:
            await db.rollback()
        finally:
            if session_id is not None:
                await run_file_op(release_session_lock, session_id)
        raise


ATTEMPT_EVENTS = ("terminal", "connect_failed", "denied")


async def recent_attempts(db, user: str, seconds: float = 60) -> int:
    """Terminal sessions, failed connections and denials of `user` in the last `seconds` (any server)."""
    since = time.time() - seconds
    return (await db.execute(select(func.count()).select_from(SshSession).where(
        SshSession.user == user, SshSession.event.in_(ATTEMPT_EVENTS), SshSession.started_at > since))).scalar_one()


def _reason(value: str) -> str:
    return value if value in END_REASONS else "connection_failed"


async def _save_session_end(db, statement):
    try:
        await db.execute(statement)
        await db.commit()
    except BaseException:
        try:
            await db.rollback()
        except Exception:
            pass
        raise


async def end_session(db, session_id: int, reason: str, bytes_in: int, bytes_out: int, *,
                      connected_ip: str | None = None, host_key_fingerprint: str | None = None,
                      key_type: str | None = None, key_name: str | None = None) -> bool:
    """Try the caller's session, retry once in a fresh session, always release."""
    try:
        count_in, count_out = max(0, int(bytes_in)), max(0, int(bytes_out))
        values = {"ended_at": case((SshSession.ended_at.is_(None), time.time()), else_=SshSession.ended_at),
                  "end_reason": case((SshSession.end_reason == "session_expired", "session_expired"),
                                     (SshSession.ended_at.is_(None), _reason(reason)), else_=SshSession.end_reason),
                  "bytes_in": case((SshSession.bytes_in < count_in, count_in), else_=SshSession.bytes_in),
                  "bytes_out": case((SshSession.bytes_out < count_out, count_out), else_=SshSession.bytes_out)}
        if connected_ip is not None:
            values["connected_ip"] = connected_ip
        if host_key_fingerprint is not None:
            values["host_key_fingerprint"] = host_key_fingerprint
        if key_type is not None:
            values["key_type"] = key_type if _KEY_TYPE.fullmatch(key_type) else ""
        if key_name is not None:
            values["key_name"] = key_name if key_name in _KEY_NAMES or _CONFIG_KEY_NAME.fullmatch(key_name) else ""
        statement = update(SshSession).where(
            SshSession.id == session_id,
            (SshSession.ended_at.is_(None)) | (SshSession.end_reason == "session_expired"),
        ).values(**values)
        try:
            await _save_session_end(db, statement)
        except Exception:
            try:
                async with AsyncSessionLocal() as retry_db:
                    await _save_session_end(retry_db, statement)
            except Exception:
                return False
        return True
    finally:
        # Retain the lease throughout both attempts so orphan reconciliation
        # cannot close the row before the final traffic metadata is written.
        await run_file_op(release_session_lock, session_id)


async def revoke_sessions(db):
    await db.execute(update(SshSession).where(
        SshSession.event == "terminal", SshSession.ended_at.is_(None),
    ).values(end_reason="session_expired"))
    await db.commit()


async def session_revoked(session_id: int) -> bool:
    async with AsyncSessionLocal() as db:
        try:
            result = (await db.execute(select(SshSession.id, SshSession.ended_at, SshSession.end_reason).where(
                SshSession.id == session_id,
            ))).first()
        finally:
            await db.rollback()
    return result is None or result.ended_at is not None or result.end_reason == "session_expired"


async def audit_event(db, by, event: str, server_key: str = "", host: str = "",
                      end_reason: str = "admin_action", *, client_ip: str = ""):
    principal = by if isinstance(by, dict) else {"username": str(by)}
    if isinstance(principal.get("user"), dict):
        principal = {**principal, **principal["user"]}
    event = event if re.fullmatch(r"[a-z][a-z0-9_]{0,63}", event) else "denied"
    now = time.time()
    db.add(SshSession(user=str(principal.get("username", "")),
                      user_id=str(principal.get("id", "")),
                      user_name=str(principal.get("name", "")),
                      client_ip=client_ip or str(principal.get("client_ip", "")),
                      connected_ip="", host_key_fingerprint="", event=event,
                      server_key=server_key, host=host, started_at=now, ended_at=now,
                      end_reason=_reason(end_reason), bytes_in=0, bytes_out=0))
    await db.commit()


def _iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None


async def list_sessions(db, *, denials: bool = False) -> list[dict]:
    event_filter = SshSession.event == "denied" if denials else SshSession.event != "denied"
    rows = (await db.execute(select(SshSession).where(event_filter).order_by(
        SshSession.started_at.desc(), SshSession.id.desc(),
    ).limit(200))).scalars().all()
    return [{"id": row.id, "user": row.user, "user_id": row.user_id, "user_name": row.user_name,
             "remote_user": row.remote_user,
             "client_ip": row.client_ip, "connected_ip": row.connected_ip,
             "host_key_fingerprint": row.host_key_fingerprint, "event": row.event,
             "server_key": row.server_key, "host": row.host, "started_at": _iso(row.started_at),
             "ended_at": _iso(row.ended_at), "end_reason": row.end_reason,
             "bytes_in": row.bytes_in, "bytes_out": row.bytes_out,
             "key_source": row.key_source or "", "key_type": row.key_type or "", "key_name": row.key_name or ""}
            for row in rows]
