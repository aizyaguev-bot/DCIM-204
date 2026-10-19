#!/usr/bin/env python3
"""Install every new commit of the deployment branch on the Linux VM automatically.

  install   add one marked crontab line that runs `run` every 2 minutes
  remove    delete only that line (state and logs are kept)
  status    show the deployed commit, the branch commit and the last result
  run       check once; install a newer branch commit (this is the cron job)

`run` reproduces the manual runbook for each new commit: it downloads that commit's
scripts/lab-service.py and scripts/install-monitoring.py, reads the account mode from
`lab-service.py status --json` and runs the installer with --enable-accounts only
when accounts are enabled now. Trust boundary: whoever can push to the branch on
github.com/aizyaguev-bot/DCIM-204 runs code on this VM. State and logs live in
<project>/.monitor-backups/auto-update/. Nothing is printed or stored from the
environment, .env or credentials. Run it with backend/.venv/bin/python.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# Fixed origin: no option, environment variable or state key can change these, and the
# checkout's own `origin` remote is never used.
REPOSITORY = "https://github.com/aizyaguev-bot/DCIM-204.git"
RAW_PREFIX = "https://raw.githubusercontent.com/aizyaguev-bot/DCIM-204/"
DEFAULT_BRANCH = "feat/lab-manager-v3-accounts"
MARK = "# DCIM-204 auto-update (managed)"
ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ("install-monitoring.py", "lab-service.py")
SHA = re.compile(r"[0-9a-f]{40}")
BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}")
ATTEMPT_FILE = re.compile(r"(\d{8}T\d{6}Z-[0-9a-f]{8})(?:\.log|-before\.json)")
APP_SETTING = re.compile(r"LAB_MANAGER_\w*|ACCOUNTS_\w*|DATABASE_URL|PDU_\w*|KVM_\w*|SMTP_\w*|EMAIL_\w*|PING_MONITOR_\w*",
                         re.IGNORECASE)
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
FILE_STAMP = "%Y%m%dT%H%M%SZ"
RETRY_AFTER = timedelta(minutes=30)
MAX_ATTEMPTS = 3
KEEP_ATTEMPTS = 20
HEARTBEAT = timedelta(hours=1)
STUCK_AFTER = timedelta(minutes=30)
MIN_UPTIME = 300
LS_REMOTE_TIMEOUT = 60
LOCAL_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 30
STATUS_TIMEOUT = 180
RESTART_TIMEOUT = 120
INSTALL_TIMEOUT = 25 * 60
STOP_GRACE = 30
DOWNLOAD_TRIES = 3
DOWNLOAD_PAUSE = 5
DOWNLOAD_CAP = 2 * 1024 * 1024
MIN_FREE = 1024 ** 3
CRON_LOG_MAX = 1024 * 1024
GIT_CONFIG_ENV = (2, 31)
BUSY_MESSAGE = "Another installation is already running"
BUSY_WAIT = timedelta(minutes=10)
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
# Saved by `install` so the cron job reaches GitHub like the interactive shell. They are used
# only for this tool's own ls-remote and downloads, and reach the installer's git fetch only as
# git configuration: the installer and the backend it starts never see proxy or CA variables.
# A value containing "@" may carry credentials: it is never saved, only its name is printed.
PROXY_VARIABLES = ("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "http_proxy", "HTTP_PROXY")
NETWORK_VARIABLES = PROXY_VARIABLES + ("no_proxy", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
                                       "GIT_SSL_CAINFO", "GIT_SSL_CAPATH")
SAVED_VARIABLES = ("PATH",) + NETWORK_VARIABLES
STRIPPED_VARIABLES = ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_NO_VERIFY", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH",
                      "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS")


class UpdateError(RuntimeError):
    pass


# ---------------------------------------------------------------- basics

def is_linux():
    return sys.platform.startswith("linux")


def utcnow():
    return datetime.now(timezone.utc).replace(microsecond=0)


def stamp(moment):
    return moment.strftime(TIME_FORMAT)


def parse_time(value):
    try:
        return datetime.strptime(value, TIME_FORMAT).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def pause(seconds):
    time.sleep(seconds)


def valid_branch(name):
    return (isinstance(name, str) and BRANCH.fullmatch(name) is not None and ".." not in name and "//" not in name
            and not name.endswith(("/", ".lock")))


def project_dir(value):
    return Path(value or ROOT).resolve()


def python_for(root):
    return root / "backend" / ".venv" / "bin" / "python"


def state_dir(root):
    return root / ".monitor-backups" / "auto-update"


def clean(text, limit=200):
    """The last line of a tool message, with any user:password@ in URLs masked."""
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    line = lines[-1] if lines else ""
    line = re.sub(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]*@", r"\1***@", line)
    return line[:limit]


def private_dir(path):
    path.mkdir(mode=0o700, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise UpdateError(str(path) + " must be a real directory")
    os.chmod(path, 0o700)
    return path


def ensure_state_dir(root):
    private_dir(root / ".monitor-backups")
    directory = private_dir(state_dir(root))
    for name in ("cron.log", "cron.log.1"):
        path = directory / name
        if path.is_file() and not path.is_symlink():
            os.chmod(path, 0o600)
    return directory


def write_private(path, data):
    """Create a new 0600 file; never follow a link or overwrite an existing file."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(data)
    return path


def say(out, text):
    print(stamp(utcnow()) + " " + text, file=out, flush=True)


def effective_uid():
    return os.geteuid()


def owner_uid(root):
    return os.stat(root / ".git").st_uid


def check_user(root):
    """Refuse root and any account other than the checkout's owner."""
    uid = effective_uid()
    if uid == 0:
        raise UpdateError("Do not run the auto-update as root; use the account that owns the checkout")
    try:
        owner = owner_uid(root)
    except OSError as exc:
        raise UpdateError("Not a DCIM-204 checkout (no .git): " + str(root)) from exc
    if uid != owner:
        raise UpdateError("Run this as the account that owns " + str(root))


# ---------------------------------------------------------------- state

def load_state(directory, quarantine=False):
    """The saved state; a corrupt file is moved aside (when quarantine) and defaults are used."""
    path = directory / "state.json"
    try:
        raw = path.read_bytes()
    except OSError:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:  # also UnicodeDecodeError: a non-UTF-8 file is corrupt, not fatal
        data = None
    if isinstance(data, dict):
        return data
    if quarantine:
        try:
            os.replace(path, directory / ("state.json.bad-" + utcnow().strftime(FILE_STAMP)))
        except OSError:
            pass
    return {}


def save_state(directory, state):
    fd, temporary = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=str(directory))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(state, out, indent=2, sort_keys=True)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, directory / "state.json")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def persist(directory, state, before, now):
    """Write the state only when something changed, or as the hourly heartbeat."""
    def material(data):
        return {key: value for key, value in data.items() if key != "last_check"}
    last = parse_time(before.get("last_check"))
    if material(state) == material(before) and last is not None and timedelta(0) <= now - last < HEARTBEAT:
        return False
    state["last_check"] = stamp(now)
    save_state(directory, state)
    return True


def attempts_of(failure):
    try:
        return int(failure.get("attempts") or 0)
    except (AttributeError, TypeError, ValueError):
        return MAX_ATTEMPTS


def record_failure(state, commit, result, log_name, when, needs_site=False):
    """Count a failed attempt. needs_site (the site ran before, or an attempt left it down) sticks to the commit."""
    failure = state.get("failure")
    attempts, needs_site = 1, bool(needs_site)
    if isinstance(failure, dict) and failure.get("commit") == commit:
        attempts = attempts_of(failure) + 1
        needs_site = needs_site or failure.get("needs_site") is True
    state["failure"] = {"commit": commit, "attempts": attempts, "result": result, "log": log_name,
                        "finished": stamp(when), "retry_after": stamp(when + RETRY_AFTER), "needs_site": needs_site}
    return state["failure"]


# ---------------------------------------------------------------- environment

def unsafe_value(value):
    return any(mark in value for mark in ("@", "\n", "\r", "\0"))


def clean_path(value):
    """Only absolute, existing directories (never "", "." or relative entries)."""
    entries = []
    for entry in value.split(os.pathsep):
        if entry and os.path.isabs(entry) and os.path.isdir(entry) and entry not in entries:
            entries.append(entry)
    return os.pathsep.join(entries)


def saved_environment(environ=None):
    """PATH and credential-free network settings to save; names of the values that were skipped."""
    environ = os.environ if environ is None else environ
    saved, skipped = {}, []
    for name, value in sorted(environ.items()):
        if name not in SAVED_VARIABLES or not value:
            continue
        if unsafe_value(value):
            skipped.append(name)
            continue
        if name == "PATH":
            value = clean_path(value)
            if not value:
                continue
        saved[name] = value
    return saved, skipped


def load_saved(state):
    """The saved variables, re-checked against the allowlist and the credential rule."""
    raw = state.get("environment")
    if not isinstance(raw, dict):
        return {}
    saved = {}
    for name in SAVED_VARIABLES:
        value = raw.get(name)
        if isinstance(value, str) and value and not unsafe_value(value):
            if name == "PATH":
                value = clean_path(value)
            if value:
                saved[name] = value
    return saved


def network_variable(name):
    upper = name.upper()
    return (upper.endswith("_PROXY") or upper.startswith("SSL_CERT_") or upper in STRIPPED_VARIABLES
            or upper.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")))


def child_env(saved):
    """Environment for local commands, the installer and the backend: no proxy or CA variables."""
    env = {name: value for name, value in os.environ.items() if not network_variable(name)}
    if saved.get("PATH"):
        env["PATH"] = saved["PATH"]
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def ls_remote_env(saved):
    env = child_env(saved)
    for name in NETWORK_VARIABLES:
        if name in saved:
            env[name] = saved[name]
    return env


def proxy_for(saved, host):
    proxy = next((saved[name] for name in PROXY_VARIABLES if saved.get(name)), None)
    bypass = saved.get("no_proxy") or saved.get("NO_PROXY")
    if proxy and bypass and urllib.request.proxy_bypass_environment(host, {"no": bypass}):
        return None
    return proxy


def git_config_entries(saved):
    entries = []
    proxy = proxy_for(saved, "github.com")
    if proxy:
        entries.append(("http.proxy", proxy))
    cainfo = saved.get("GIT_SSL_CAINFO") or saved.get("SSL_CERT_FILE")
    if cainfo:
        entries.append(("http.sslCAInfo", cainfo))
    capath = saved.get("GIT_SSL_CAPATH") or saved.get("SSL_CERT_DIR")
    if capath:
        entries.append(("http.sslCAPath", capath))
    return entries


def git_version(env):
    try:
        result = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=LOCAL_TIMEOUT,
                                stdin=subprocess.DEVNULL, env=env)
    except (OSError, subprocess.SubprocessError):
        return (0, 0)
    match = re.search(r"(\d+)\.(\d+)", result.stdout or "")
    return (int(match.group(1)), int(match.group(2))) if match else (0, 0)


def installer_env(saved):
    """child_env plus the saved proxy/CA settings as git-only configuration (git >= 2.31)."""
    env = child_env(saved)
    entries = git_config_entries(saved)
    if entries:
        version = git_version(env)
        if version < GIT_CONFIG_ENV:
            raise UpdateError("git " + ".".join(str(part) for part in GIT_CONFIG_ENV) + " or newer is needed to pass "
                              "the saved proxy/CA settings to the installer only through git (found "
                              + ".".join(str(part) for part in version) + ")")
        env["GIT_CONFIG_COUNT"] = str(len(entries))
        for index, (key, value) in enumerate(entries):
            env["GIT_CONFIG_KEY_" + str(index)] = key
            env["GIT_CONFIG_VALUE_" + str(index)] = value
    return env


def shell_settings(environ, crontab_text):
    """Names of application settings that live in the shell or crontab instead of .env."""
    names = {name for name in environ if APP_SETTING.fullmatch(name)}
    for line in crontab_text.splitlines():
        match = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if match and APP_SETTING.fullmatch(match.group(1)):
            names.add(match.group(1))
    return sorted(names)


# ---------------------------------------------------------------- crontab

def cron_line(root, branch):
    directory = state_dir(root)
    script = root / "scripts" / "vm-auto-update.py"
    log = directory / "cron.log"
    parts = ["*/2 * * * *", "cd", shlex.quote(str(root)), "&&", "mkdir", "-p", shlex.quote(str(directory)), "&&",
             shlex.quote(str(python_for(root))), shlex.quote(str(script)), "--project", shlex.quote(str(root)),
             "--branch=" + shlex.quote(branch), "run", ">>", shlex.quote(str(log)), "2>&1", MARK]
    line = " ".join(parts)
    # cron turns % into a newline; a line break or NUL would split or cut the entry.
    if any(mark in line for mark in ("%", "\n", "\r", "\0")):
        raise UpdateError("The project path or branch contains %, a line break or NUL, which cron cannot run safely")
    return line


def read_crontab():
    try:
        result = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=LOCAL_TIMEOUT,
                                stdin=subprocess.DEVNULL)
    except FileNotFoundError as exc:
        raise UpdateError("crontab is not installed") from exc
    except UnicodeDecodeError as exc:
        raise UpdateError("The user crontab is not valid text; nothing was changed") from exc
    if result.returncode == 0:
        return result.stdout
    message = ((result.stderr or "") + (result.stdout or "")).lower()
    if result.returncode == 1 and "no crontab" in message:
        return ""
    if "not found" in message or result.returncode == 127:
        raise UpdateError("crontab is not installed")
    raise UpdateError("Could not read the user crontab")


def write_crontab(text):
    result = subprocess.run(["crontab", "-"], input=text, capture_output=True, text=True, timeout=LOCAL_TIMEOUT)
    if result.returncode != 0:
        raise UpdateError("crontab rejected the new table: " + (clean(result.stderr) or "exit " + str(result.returncode)))


def replace_crontab(expected, updated):
    """Write only if nobody changed the crontab since it was read."""
    if read_crontab() != expected:
        raise UpdateError("The crontab changed while this command ran; nothing was written. Run the command again.")
    write_crontab(updated)


def backup_crontab(root, text):
    parent = private_dir(root / ".monitor-backups")
    folder = Path(tempfile.mkdtemp(prefix=utcnow().strftime(FILE_STAMP) + "-crontab-", dir=str(parent)))
    os.chmod(folder, 0o700)
    write_private(folder / "crontab.txt", text)
    return folder


def active_marked(lines):
    """Marked lines that cron would run (a commented-out copy does not count)."""
    return [line for line in lines if MARK in line and not line.lstrip().startswith("#")]


def without_marked(lines):
    kept = [line for line in lines if MARK not in line]
    while kept and not kept[-1].strip():
        kept.pop()
    return kept


# ---------------------------------------------------------------- git

def remote_commit(branch, saved, timeout=LS_REMOTE_TIMEOUT):
    """The branch commit from a TLS-verified ls-remote of the fixed repository."""
    if not valid_branch(branch):
        raise UpdateError("invalid branch name")
    ref = "refs/heads/" + branch
    # cwd "/" keeps any repository-local git configuration out; the second -c wins over a
    # URL-specific http.<url>.sslVerify=false; --get-url exposes url.<x>.insteadOf rewrites.
    git = ["git", "-c", "http.sslVerify=true", "-c", "http." + REPOSITORY + ".sslVerify=true", "ls-remote"]
    env = ls_remote_env(saved)
    try:
        url = subprocess.run(git + ["--get-url", REPOSITORY], capture_output=True, text=True, timeout=LOCAL_TIMEOUT,
                             stdin=subprocess.DEVNULL, env=env, cwd="/")
        if url.returncode != 0:
            raise UpdateError("git ls-remote --get-url failed (exit " + str(url.returncode) + ")")
        if url.stdout.strip() != REPOSITORY:
            raise UpdateError("git configuration rewrites the repository URL")
        result = subprocess.run(git + [REPOSITORY, ref], capture_output=True, text=True, timeout=timeout,
                                stdin=subprocess.DEVNULL, env=env, cwd="/")
    except FileNotFoundError as exc:
        raise UpdateError("git is not installed or not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise UpdateError("git ls-remote timed out") from exc
    if result.returncode != 0:
        raise UpdateError("git ls-remote failed: " + (clean(result.stderr) or "exit " + str(result.returncode)))
    lines = (line.split() for line in result.stdout.splitlines())
    exact = [fields for fields in lines if len(fields) == 2 and fields[1] == ref]
    if not exact:
        raise UpdateError("the branch " + branch + " was not found on GitHub")
    if len(exact) != 1 or not SHA.fullmatch(exact[0][0]):
        raise UpdateError("unexpected answer from git ls-remote")
    return exact[0][0]


def deployed_commit(root, saved=None):
    try:
        result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True,
                                timeout=LOCAL_TIMEOUT, stdin=subprocess.DEVNULL, env=child_env(saved or {}))
    except (OSError, subprocess.SubprocessError) as exc:
        raise UpdateError("cannot read the deployed commit") from exc
    value = (result.stdout or "").strip()
    if result.returncode != 0 or not SHA.fullmatch(value):
        raise UpdateError("cannot read the deployed commit")
    return value


def contains(root, commit, head, saved=None):
    """True when commit is already part of head (the installer never moves back)."""
    try:
        result = subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", commit, head],
                                capture_output=True, text=True, timeout=LOCAL_TIMEOUT, stdin=subprocess.DEVNULL,
                                env=child_env(saved or {}))
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


# ---------------------------------------------------------------- locks and system

@contextmanager
def run_lock(directory, touch=True):
    """Yield True with the exclusive run lock held, or False when another run holds it."""
    import fcntl
    path = directory / "run.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        if touch:
            os.utime(path)  # its mtime is the "last run" shown by status
        yield True
    finally:
        os.close(fd)


def lock_held(directory):
    """True while a run holds the lock; None where this cannot be checked."""
    if not is_linux():
        return None
    import fcntl
    path = directory / "run.lock"
    if not path.is_file():
        return False
    fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def free_bytes(root):
    return shutil.disk_usage(str(root)).free


def uptime_seconds():
    try:
        with open("/proc/uptime", encoding="ascii") as source:
            return float(source.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def backend_answers(port=8000):
    """True when something accepts connections on the backend port of this VM."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def read_stat(pid):
    """(state, process group, start time) from /proc/<pid>/stat fields 3, 5 and 22, or None."""
    try:
        stat = Path("/proc/" + str(int(pid)) + "/stat").read_text(encoding="ascii", errors="replace")
        fields = stat.rsplit(")", 1)[1].split()
        return fields[0], int(fields[2]), fields[19]
    except (OSError, ValueError, IndexError):
        return None


def process_start(pid):
    """Start time of a live process, or None (gone, zombie, not Linux). PID plus start time identify a process."""
    stat = read_stat(pid)
    return None if stat is None or stat[0] in ("Z", "X", "x") else stat[2]


def child_exited(pid):
    """True once our own child has exited, without reaping it, so its PID and group ID stay reserved."""
    try:
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return True


def stop_group(process):
    """Our own installer ran past its time limit: TERM, then KILL, its whole process group, and reap the leader
    only afterwards, so the group ID cannot be reused while it is signalled. Never used across runs.
    Returns False when the leader still has not exited (for example stuck in uninterruptible I/O)."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
        for _ in range(STOP_GRACE * 4):
            if child_exited(process.pid):
                break
            pause(0.25)
        os.killpg(process.pid, signal.SIGKILL)  # members that ignored TERM or outlived the leader
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=STOP_GRACE)
    except subprocess.TimeoutExpired:
        return False
    return True


def rotate_cron_log(directory):
    path = directory / "cron.log"
    try:
        if not path.is_symlink() and path.stat().st_size > CRON_LOG_MAX:
            os.replace(path, directory / "cron.log.1")
    except OSError:
        pass


def prune_attempts(directory, keep=KEEP_ATTEMPTS):
    """Keep the newest attempts; touch only this tool's own regular files in its folder."""
    groups = {}
    for path in directory.iterdir():
        match = ATTEMPT_FILE.fullmatch(path.name)
        if match and not path.is_symlink() and path.is_file():
            groups.setdefault(match.group(1), []).append(path)
    for key in sorted(groups, reverse=True)[keep:]:
        for path in groups[key]:
            try:
                path.unlink()
            except OSError:
                pass


def restart_backend(root, saved):
    """Start the site through the checkout's lab-service.py, which re-checks PID and port under the installer lock."""
    python = python_for(root)
    script = root / "scripts" / "lab-service.py"
    if not python.is_file() or not script.is_file():
        return "not possible: backend/.venv/bin/python or scripts/lab-service.py is missing"
    try:
        result = subprocess.run([str(python), str(script), "--project", str(root), "start"], cwd=str(root),
                                capture_output=True, text=True, timeout=RESTART_TIMEOUT, stdin=subprocess.DEVNULL,
                                env=child_env(saved))
    except subprocess.TimeoutExpired:
        return "timeout after " + str(RESTART_TIMEOUT) + " s"
    except OSError as exc:
        return "could not run lab-service.py: " + type(exc).__name__
    detail = clean(result.stdout) or clean(result.stderr)
    return ("ok" if result.returncode == 0 else "failed (exit " + str(result.returncode) + ")") + (": " + detail if detail else "")


def recover_site(root, saved, state, commit, after, out):
    """After a failed, timed-out or killed attempt: restart the site if it ran before and nothing answers now."""
    if backend_answers():
        return
    result = restart_backend(root, saved)
    state["restart"] = {"at": stamp(utcnow()), "after": after, "commit": commit, "result": result}
    say(out, "the site was down after the " + after + " attempt for " + commit[:12] + "; lab-service start: " + result)


# ---------------------------------------------------------------- download

class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise UpdateError("the download was redirected (HTTP " + str(code) + "); only the exact commit URL is accepted")


def download_opener(saved):
    """Verified TLS, the saved proxy (if any) and no redirects; process proxy variables are ignored."""
    proxy = proxy_for(saved, "raw.githubusercontent.com")
    context = ssl.create_default_context(cafile=saved.get("SSL_CERT_FILE") or saved.get("GIT_SSL_CAINFO"),
                                         capath=saved.get("SSL_CERT_DIR") or saved.get("GIT_SSL_CAPATH"))
    return urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy} if proxy else {}),
                                       urllib.request.HTTPSHandler(context=context), NoRedirects())


def fetch(commit, name, destination, opener):
    """Download scripts/<name> of exactly this commit (HTTP 200, same URL, 2 MiB cap, 3 tries)."""
    if not SHA.fullmatch(commit) or name not in SCRIPTS:
        raise UpdateError("refusing an unexpected download")
    url = RAW_PREFIX + commit + "/scripts/" + name
    last = "no response"
    for attempt in range(DOWNLOAD_TRIES):
        if attempt:
            pause(DOWNLOAD_PAUSE)
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "dcim-vm-auto-update"})
            with opener.open(request, timeout=DOWNLOAD_TIMEOUT) as response:
                status = getattr(response, "status", None)
                if status != 200:
                    raise UpdateError("unexpected HTTP status " + str(status))
                if response.geturl() != url:
                    raise UpdateError("the download left the exact commit URL")
                data = response.read(DOWNLOAD_CAP + 1)
            if len(data) > DOWNLOAD_CAP:
                raise UpdateError(name + " is larger than 2 MiB")
            compile(data.decode("utf-8"), name, "exec")
            return write_private(destination, data)
        except urllib.error.HTTPError as exc:
            last = "HTTP " + str(exc.code)
        except (OSError, UpdateError, ValueError, SyntaxError, http.client.HTTPException) as exc:
            last = clean(str(exc)) or type(exc).__name__
    raise UpdateError("could not download " + name + " for " + commit[:12] + ": " + last)


# ---------------------------------------------------------------- one install attempt

def note(log, text):
    log.write((stamp(utcnow()) + " [auto-update] " + text + "\n").encode("utf-8"))
    log.flush()


def accounts_enabled(data):
    """True only when monitoring.accounts_enabled is exactly true; anything else keeps the current mode."""
    monitoring = data.get("monitoring") if isinstance(data, dict) else None
    return isinstance(monitoring, dict) and monitoring.get("accounts_enabled") is True


def read_accounts(root, python, tool, snapshot, log, env):
    """Save `lab-service.py status --json` as the private before-snapshot and return the accounts flag."""
    keep = "installing without --enable-accounts, which keeps the current login mode"
    try:
        result = subprocess.run([str(python), str(tool), "--project", str(root), "status", "--json"], cwd=str(root),
                                capture_output=True, text=True, timeout=STATUS_TIMEOUT, stdin=subprocess.DEVNULL,
                                env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        note(log, "status check could not run (" + type(exc).__name__ + "); " + keep)
        return False
    if result.stdout:
        write_private(snapshot, result.stdout)  # never printed or copied into state.json / cron.log
    try:
        data = json.loads(result.stdout or "")
    except ValueError:
        data = None
    if result.returncode != 0 or data is None:
        note(log, "status check failed (exit " + str(result.returncode) + "); " + keep)
        return False
    flag = accounts_enabled(data)
    note(log, "status saved to " + snapshot.name + "; accounts enabled now: " + ("yes" if flag else "no"))
    return flag


def installer_args(python, tool, commit, root, accounts):
    argv = [str(python), str(tool), commit, "--project", str(root), "--backup-frontend-lock"]
    if accounts:
        argv.append("--enable-accounts")
    argv.append("--finish-stuck-shutdown")
    return argv


def attempt_install(root, branch, commit, directory, name, saved, env, started=None, survived=None):
    """Download, read the account mode and run the commit's installer. Returns the result word."""
    log_path = directory / (name + ".log")
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    with os.fdopen(fd, "ab") as log:
        note(log, "branch " + branch + ", commit " + commit)
        workspace = Path(tempfile.mkdtemp(prefix="dcim-auto-update-"))  # created 0700
        try:
            return install_from(root, commit, directory, name, saved, env, log, log_path, workspace, started, survived)
        finally:
            shutil.rmtree(str(workspace), ignore_errors=True)


def install_from(root, commit, directory, name, saved, env, log, log_path, workspace, started=None, survived=None):
    python = python_for(root)
    try:
        opener = download_opener(saved)
        tools = {script: fetch(commit, script, workspace / script, opener) for script in SCRIPTS}
    except (UpdateError, OSError, ssl.SSLError) as exc:
        note(log, clean(str(exc)) or type(exc).__name__)
        return "download-failed"
    note(log, "downloaded " + ", ".join(SCRIPTS) + " for this commit")
    if not python.is_file():
        note(log, "backend/.venv/bin/python was not found")
        return "failed"
    accounts = read_accounts(root, python, tools["lab-service.py"], directory / (name + "-before.json"), log, env)
    argv = installer_args(python, tools["install-monitoring.py"], commit, root, accounts)
    note(log, "running install-monitoring.py " + " ".join(argv[2:]))
    try:
        process = subprocess.Popen(argv, cwd=str(root), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True, env=env)
    except OSError as exc:
        note(log, "the installer could not start: " + type(exc).__name__)
        return "failed"
    if started is not None:
        started(process.pid)  # recorded so a later run can recognise it if this run stops
    try:
        code = process.wait(timeout=INSTALL_TIMEOUT)
    except subprocess.TimeoutExpired:
        late = "the installer did not finish within " + str(INSTALL_TIMEOUT // 60) + " minutes; "
        if stop_group(process):
            note(log, late + "its process group was stopped (TERM, then KILL)")
        else:
            note(log, late + "TERM and KILL were sent to its process group, but it has not exited (pid "
                 + str(process.pid) + "); later runs report it until it is gone")
            if survived is not None:
                survived()
        return "timeout"
    try:
        head = deployed_commit(root, saved)
    except UpdateError:
        head = None
    note(log, "installer exit code " + str(code) + "; deployed commit now " + str(head))
    if code == 0 and head == commit:
        return "installed"
    if code != 0 and BUSY_MESSAGE in log_path.read_text(encoding="utf-8", errors="replace"):
        return "busy"
    return "failed"


# ---------------------------------------------------------------- commands

def installer_running(marker):
    """True while the marker's installer is verifiably the same live process (PID and /proc start time)."""
    pid, start = marker.get("installer_pid"), marker.get("installer_start")
    return isinstance(pid, int) and pid > 1 and isinstance(start, str) and process_start(pid) == start


def settle_attempt(root, saved, state, marker, now, out):
    """Close the books on an attempt whose run stopped. While its installer is still running, nothing is signalled
    from another run: the marker stays and "installing" (or "installer-late" past its deadline) is returned for the
    owner to see in status. Once that process is gone the attempt is settled and None is returned."""
    commit = str(marker.get("commit", ""))
    if installer_running(marker):
        deadline = parse_time(marker.get("deadline"))
        if deadline is None or now < deadline:
            return "installing"
        if marker.get("late_reported") is not True:
            marker["late_reported"] = True
            say(out, "the installer for " + commit[:12] + " (pid " + str(marker["installer_pid"]) + ") is still running, past its "
                + str(INSTALL_TIMEOUT // 60) + "-minute limit since " + stamp(deadline)
                + "; it is not stopped automatically - see status and the newest attempt log")
        return "installer-late"
    state.pop("attempt", None)
    if not SHA.fullmatch(commit):
        return None
    needs_site = marker.get("backend_up") is True or marker.get("site_required") is True
    if marker.get("counted") is True:  # it survived KILL; its timeout was counted when that happened
        say(out, "the installer for " + commit[:12] + " that survived its timeout has exited")
        if needs_site:
            recover_site(root, saved, state, commit, "timeout", out)
        return None
    failure = record_failure(state, commit, "interrupted", marker.get("log"), now, needs_site)
    say(out, "the install of " + commit[:12] + " did not finish (the run was stopped); attempt "
        + str(failure["attempts"]) + "/" + str(MAX_ATTEMPTS))
    if needs_site:
        recover_site(root, saved, state, commit, "interrupted", out)
    return None


def locked_run(root, branch, directory, out):
    now = utcnow()
    state = load_state(directory, quarantine=True)
    before = json.loads(json.dumps(state))
    saved = load_saved(state)
    state["branch"] = branch
    state["project"] = str(root)

    uptime = uptime_seconds()
    if uptime is not None and uptime < MIN_UPTIME:
        # Leave the boot-time start of the site alone; nothing is counted.
        if state.get("last_result") != "booting":
            say(out, "the VM started less than " + str(MIN_UPTIME // 60) + " minutes ago; waiting")
        state["last_result"] = "booting"
        persist(directory, state, before, now)
        return 0

    marker = state.get("attempt")
    if isinstance(marker, dict):
        waiting = settle_attempt(root, saved, state, marker, now, out)
        if waiting:
            state["last_result"] = waiting  # the earlier installer still runs; it is never signalled from here
            persist(directory, state, before, now)
            return 0
    else:
        state.pop("attempt", None)
    if not isinstance(state.get("failure"), dict):
        state.pop("failure", None)

    previous_error = state.pop("last_error", None)  # each error is printed once, until it changes or clears

    def check_error(message):
        if previous_error != message:
            say(out, message)
        state.update(last_result="check-error", last_error=message)
        persist(directory, state, before, now)
        return 1

    try:
        remote = remote_commit(branch, saved)
        head = deployed_commit(root, saved)
    except UpdateError as exc:
        return check_error("cannot check for updates: " + str(exc))
    state.update(remote_commit=remote, deployed_commit=head)

    failure = state.get("failure")
    if remote == head or contains(root, remote, head, saved):
        # A failed commit that is checked out (its installer stopped after moving HEAD) is not verified:
        # keep the failure and run its installer again instead of calling it up to date.
        if not (failure and failure.get("commit") == head):
            state["last_result"] = "up-to-date"
            state.pop("failure", None)
            persist(directory, state, before, now)
            return 0
        target = head
    else:
        target = remote
    if failure and failure.get("commit") != target:
        state.pop("failure")  # a newer commit resets the attempt count
        failure = None
    if failure:
        if attempts_of(failure) >= MAX_ATTEMPTS:
            state["last_result"] = "skipped"
            persist(directory, state, before, now)
            return 0
        retry = parse_time(failure.get("retry_after"))
        if retry is not None and now < retry:
            state["last_result"] = "waiting-retry"
            persist(directory, state, before, now)
            return 0

    busy_until = parse_time(state.get("busy_until"))
    if busy_until is not None and now < busy_until:
        state["last_result"] = "busy"
        persist(directory, state, before, now)
        return 0
    state.pop("busy_until", None)
    if free_bytes(root) < MIN_FREE:
        if state.get("last_result") != "low-disk":
            say(out, "paused: less than 1 GiB free on the project disk; waiting before installing " + target[:12])
        state["last_result"] = "low-disk"
        persist(directory, state, before, now)
        return 0
    try:
        env = installer_env(saved)
    except UpdateError as exc:
        return check_error(str(exc))

    was_up = backend_answers()
    # A site that ran before the first attempt for this commit (or that an attempt left down) must answer again.
    must_answer = was_up or (failure is not None and failure.get("needs_site") is True)
    name = now.strftime(FILE_STAMP) + "-" + target[:8]
    state["attempt"] = {"commit": target, "started": stamp(now), "log": name + ".log", "backend_up": was_up,
                        "site_required": must_answer}
    state["last_result"] = "installing"
    state["last_check"] = stamp(now)
    save_state(directory, state)
    if target == head:
        say(out, "running the installer again for " + target[:12] + ", which is checked out but was not verified; log "
            + name + ".log")
    else:
        say(out, "installing " + target[:12] + " (deployed " + head[:12] + "); log " + name + ".log")

    def started(pid):
        state["attempt"].update(installer_pid=pid, installer_start=process_start(pid),
                                deadline=stamp(utcnow() + timedelta(seconds=INSTALL_TIMEOUT)))
        save_state(directory, state)

    survivors = []
    result = attempt_install(root, branch, target, directory, name, saved, env, started,
                             survived=lambda: survivors.append(True))
    if result == "installed" and must_answer and not backend_answers():
        result = "site-down"  # success also needs the site that was up before to answer again

    finished = utcnow()
    marker = state.pop("attempt", None)
    state["last_install"] = {"commit": target, "result": result, "started": stamp(now), "finished": stamp(finished),
                             "log": name + ".log"}
    if result == "installed":
        state.update(deployed_commit=target, last_result="installed")
        state.pop("failure", None)
        say(out, "installed " + target[:12])
    elif result == "busy":
        state.update(last_result="busy", busy_until=stamp(finished + BUSY_WAIT))  # not counted as a failure
        if before.get("last_result") != "busy":
            say(out, "another installation was running; " + target[:12] + " will be tried again in 10 minutes")
    else:
        failure = record_failure(state, target, result, name + ".log", finished, must_answer)
        state["last_result"] = "failed"
        if failure["attempts"] >= MAX_ATTEMPTS:
            plan = "skipped until a newer commit appears"
        else:
            plan = "retry after " + failure["retry_after"]
        say(out, "install of " + target[:12] + " failed (" + result + "), attempt " + str(failure["attempts"]) + "/"
            + str(MAX_ATTEMPTS) + "; " + plan + "; log " + name + ".log")
        if must_answer:
            recover_site(root, saved, state, target, result, out)
    if survivors and isinstance(marker, dict):
        # The installer outlived TERM and KILL: keep its marker so status names it and later runs report it
        # (never signal it) until it is gone; its timeout is already counted above.
        marker.update(counted=True, late_reported=True)
        state.update(attempt=marker, last_result="installer-late")
        say(out, "the installer for " + target[:12] + " (pid " + str(marker.get("installer_pid"))
            + ") did not exit even after KILL; status reports it until it is gone, and it is not signalled again")
    prune_attempts(directory)
    state["last_check"] = stamp(utcnow())
    save_state(directory, state)
    return 0 if result in ("installed", "busy") else 1


def cmd_run(root, branch, out=None):
    out = sys.stdout if out is None else out
    directory = ensure_state_dir(root)
    with run_lock(directory) as acquired:
        if not acquired:
            return 0  # another run is working; stay silent
        rotate_cron_log(directory)
        return locked_run(root, branch, directory, out)


def cmd_install(root, branch, out=None):
    out = sys.stdout if out is None else out
    missing = [label for label, path in ((".git", root / ".git"), ("backend/.venv/bin/python", python_for(root)),
                                         ("scripts/vm-auto-update.py", root / "scripts" / "vm-auto-update.py"))
               if not path.exists()]
    if missing:
        raise UpdateError("Not a deployed DCIM-204 checkout; missing: " + ", ".join(missing))
    line = cron_line(root, branch)
    directory = ensure_state_dir(root)
    with run_lock(directory, touch=False) as acquired:
        if not acquired:
            raise UpdateError("An update run is in progress; try again in a few minutes")
        current = read_crontab()
        names = shell_settings(os.environ, current)
        if names:
            raise UpdateError("These application settings are set in the shell or the crontab, where the cron job "
                              "would not see them: " + ", ".join(names) + ". Move them into .env, then run install again.")
        environment, skipped = saved_environment()
        installer_env(environment)  # refuses before any change when git cannot take the settings
        lines = current.splitlines()
        changed = [item for item in lines if MARK in item] != [line]
        if changed:
            backup_crontab(root, current)
            replace_crontab(current, "\n".join(without_marked(lines) + [line]) + "\n")
            if [item for item in read_crontab().splitlines() if MARK in item] != [line]:
                raise UpdateError("The crontab did not keep the auto-update line")
        state = load_state(directory, quarantine=True)
        if changed or not state.get("installed_at"):
            state["installed_at"] = stamp(utcnow())
        state.update(branch=branch, project=str(root), environment=environment)
        save_state(directory, state)
    try:
        deployed = deployed_commit(root, environment)
    except UpdateError as exc:
        deployed = "unknown (" + str(exc) + ")"
    try:
        latest = remote_commit(branch, environment)
    except UpdateError as exc:
        latest = "unreachable (" + str(exc) + ")"
    print(("auto-update installed" if changed else "auto-update already installed") + ": checks every 2 minutes", file=out)
    print("branch: " + branch, file=out)
    print("deployed commit: " + deployed, file=out)
    print("latest branch commit: " + latest, file=out)
    print("logs: " + str(directory), file=out)
    print("saved for the cron job: " + (", ".join(sorted(environment)) or "nothing"), file=out)
    if skipped:
        print("not saved (the value may contain credentials): " + ", ".join(skipped), file=out)
    return 0


def cmd_remove(root, out=None):
    out = sys.stdout if out is None else out
    directory = ensure_state_dir(root)
    with run_lock(directory, touch=False) as acquired:
        if not acquired:
            raise UpdateError("An update run is in progress; try again in a few minutes")
        current = read_crontab()
        lines = current.splitlines()
        if not any(MARK in line for line in lines):
            print("auto-update is not installed; crontab unchanged", file=out)
            return 0
        backup_crontab(root, current)
        kept = without_marked(lines)
        replace_crontab(current, ("\n".join(kept) + "\n") if kept else "")
    print("auto-update removed; state and logs kept in " + str(directory), file=out)
    return 0


def backups_summary(root):
    """Installer and crontab backup folders in .monitor-backups (never deleted automatically)."""
    count = size = 0
    parent = root / ".monitor-backups"
    if not parent.is_dir():
        return {"count": 0, "bytes": 0}
    for entry in parent.iterdir():
        if entry.name == "auto-update" or entry.is_symlink() or not entry.is_dir():
            continue
        count += 1
        for folder, _, files in os.walk(entry):
            for item in files:
                try:
                    size += os.lstat(os.path.join(folder, item)).st_size
                except OSError:
                    pass
    return {"count": count, "bytes": size}


def collect_status(root, branch=None, check_remote=True):
    directory = state_dir(root)
    state = load_state(directory)
    saved = load_saved(state)
    branch = branch or state.get("branch") or DEFAULT_BRANCH
    try:
        installed, crontab_error = bool(active_marked(read_crontab().splitlines())), None
    except (UpdateError, OSError, subprocess.SubprocessError) as exc:
        installed, crontab_error = None, clean(str(exc))
    try:
        deployed = deployed_commit(root, saved)
    except UpdateError:
        deployed = None
    remote = remote_error = None
    if check_remote:
        try:
            remote = remote_commit(branch, saved, timeout=20)
        except UpdateError as exc:
            remote_error = str(exc)
    lock = directory / "run.lock"
    last_run = None
    if lock.is_file():
        last_run = stamp(datetime.fromtimestamp(int(lock.stat().st_mtime), timezone.utc))
    running = None
    if last_run and lock_held(directory):
        running = {"since": last_run, "stuck": utcnow() - parse_time(last_run) > STUCK_AFTER}
    failure = state.get("failure") if isinstance(state.get("failure"), dict) else None
    if failure:
        failure = dict(failure, max_attempts=MAX_ATTEMPTS, skipped=attempts_of(failure) >= MAX_ATTEMPTS)
    logs = sorted(path.name for path in directory.glob("*.log") if ATTEMPT_FILE.fullmatch(path.name)) if directory.is_dir() else []
    try:
        version = (root / "backend" / "version.txt").read_text(encoding="utf-8").strip()
    except OSError:
        version = None
    try:
        disk_free = free_bytes(root)
    except OSError:
        disk_free = None
    attempt = state.get("attempt") if isinstance(state.get("attempt"), dict) else None
    installer = None
    if attempt and isinstance(attempt.get("installer_pid"), int):
        deadline = parse_time(attempt.get("deadline"))
        late = deadline is not None and utcnow() > deadline
        installer = {"pid": attempt["installer_pid"], "start": attempt.get("installer_start"),
                     "running": installer_running(attempt), "deadline": attempt.get("deadline"),
                     "late_minutes": int((utcnow() - deadline).total_seconds() // 60) if late else 0}
    return {
        "installed": installed,
        "crontab_error": crontab_error,
        "project": str(root),
        "branch": branch,
        "deployed_commit": deployed,
        "version_file": version,
        "remote_commit": remote,
        "remote_error": remote_error,
        "running": running,
        "last_run": last_run,
        "last_check": state.get("last_check"),
        "last_result": state.get("last_result"),
        "last_error": state.get("last_error"),
        "paused_low_disk": state.get("last_result") == "low-disk",
        "failure": failure,
        "attempt": attempt,
        "installer": installer,
        "last_install": state.get("last_install") if isinstance(state.get("last_install"), dict) else None,
        "restart": state.get("restart") if isinstance(state.get("restart"), dict) else None,
        "saved_variables": sorted(saved),
        "disk_free_bytes": disk_free,
        "backups": backups_summary(root),
        "log_dir": str(directory),
        "cron_log": str(directory / "cron.log"),
        "newest_attempt_log": str(directory / logs[-1]) if logs else None,
    }


def mib(value):
    return "unknown" if value is None else str(round(value / 1024 / 1024)) + " MiB"


def cmd_status(root, branch=None, as_json=False, out=None):
    out = sys.stdout if out is None else out
    data = collect_status(root, branch)
    if as_json:
        print(json.dumps(data, indent=2, sort_keys=True), file=out)
        return 0
    installed = {True: "installed (every 2 minutes)", False: "not installed", None: "unknown"}[data["installed"]]
    if data["crontab_error"]:
        installed += " (" + data["crontab_error"] + ")"
    rows = [("auto-update", installed), ("branch", data["branch"]), ("deployed commit", data["deployed_commit"]),
            ("version file", data["version_file"]),
            ("latest branch commit", data["remote_commit"] or "unreachable (" + str(data["remote_error"]) + ")")]
    if data["running"]:
        rows.append(("update running since", data["running"]["since"]
                     + (" - longer than 30 minutes, check the newest attempt log" if data["running"]["stuck"] else "")))
    rows += [("last run", data["last_run"]), ("last check", data["last_check"]), ("last result", data["last_result"])]
    if data["paused_low_disk"]:
        rows.append(("paused", "low disk (less than 1 GiB free)"))
    if data["last_error"]:
        rows.append(("last error", data["last_error"]))
    failure = data["failure"]
    if failure:
        plan = "skipped until a newer commit" if failure["skipped"] else "retry after " + str(failure.get("retry_after"))
        rows.append(("failed commit", str(failure.get("commit")) + " (" + str(failure.get("result")) + ", attempt "
                     + str(failure.get("attempts")) + "/" + str(MAX_ATTEMPTS) + "; " + plan + ")"))
    if data["attempt"]:
        rows.append(("install attempt", str(data["attempt"].get("commit")) + " started " + str(data["attempt"].get("started"))))
    installer = data["installer"]
    if installer:
        detail = "pid " + str(installer["pid"]) + ", start " + str(installer["start"]) + ", "
        detail += "running" if installer["running"] else "not running"
        if installer["running"] and installer["late_minutes"]:
            detail += ", " + str(installer["late_minutes"]) + " minutes past its " + str(INSTALL_TIMEOUT // 60) \
                + "-minute limit (not stopped automatically; stop it by hand if needed)"
        rows.append(("installer", detail))
    if data["last_install"]:
        last = data["last_install"]
        rows.append(("last install", str(last.get("commit")) + " " + str(last.get("result")) + " at " + str(last.get("finished"))))
    if data["restart"]:
        rows.append(("last site restart", str(data["restart"].get("at")) + ": " + str(data["restart"].get("result"))))
    rows += [("saved variables", ", ".join(data["saved_variables"]) or "none"),
             ("disk free", mib(data["disk_free_bytes"])),
             ("backup folders", str(data["backups"]["count"]) + " (" + mib(data["backups"]["bytes"]) + ")"),
             ("log folder", data["log_dir"]), ("cron log", data["cron_log"]),
             ("newest attempt log", data["newest_attempt_log"])]
    for label, value in rows:
        print(label + ": " + ("none" if value is None else str(value)), file=out)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # Frozen interface: installed crontab lines call `--project <root> --branch=<branch> run`.
    # Every future version must keep accepting exactly these arguments.
    parser.add_argument("--project", default=str(ROOT), help="DCIM-204 checkout (default: this script's repository)")
    parser.add_argument("--branch", default=None,
                        help="branch to follow (default: the installed one, else " + DEFAULT_BRANCH + ")")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install", help="add the crontab line (every 2 minutes); idempotent")
    sub.add_parser("remove", help="remove only the auto-update crontab line")
    status = sub.add_parser("status", help="show the deployed and latest commit and the last result")
    status.add_argument("--json", action="store_true")
    sub.add_parser("run", help="check once and install a newer commit (the cron job)")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command != "status" and not is_linux():
        parser.error(args.command + " works only inside the Linux VM")
    if sys.version_info < (3, 10):
        parser.error("Use the application's backend/.venv/bin/python (Python 3.10+)")
    root = project_dir(args.project)
    branch = args.branch or load_state(state_dir(root)).get("branch") or DEFAULT_BRANCH
    if not valid_branch(branch):
        parser.error("invalid branch name")
    try:
        if args.command == "status":
            return cmd_status(root, branch, args.json)
        check_user(root)
        if args.command == "install":
            return cmd_install(root, branch)
        if args.command == "remove":
            return cmd_remove(root)
        return cmd_run(root, branch)
    except (UpdateError, OSError, subprocess.SubprocessError) as error:
        print("auto-update: " + (clean(str(error), 300) or type(error).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
