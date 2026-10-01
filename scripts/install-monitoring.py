#!/usr/bin/env python3
"""Install a reviewed Lab Manager release using the Linux VM's existing venv.

No sudo, package installation, database seeding, or remote Git write is performed.
The checkout must be clean except for live twin data and the deployment version.
Use --backup-frontend-lock to preserve a locally modified npm lockfile in the
backup and install the reviewed lockfile alongside the prebuilt frontend.
Use --enable-accounts to activate real users with the existing login password.
Use --finish-stuck-shutdown to back up live SQLite data and finish stopping this
project's backend if it does not exit after a normal shutdown request.
"""
import argparse
from contextlib import closing, contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import secrets
import signal
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from http.cookiejar import CookieJar

REPOSITORY = "https://github.com/aizyaguev-bot/DCIM-204.git"
LIVE_TRACKED = {"lab-twin/lab-data.json", "backend/version.txt"}
FRONTEND_LOCK = "frontend/package-lock.json"

# Read credentials in the application environment without exposing them in argv,
# stdout, shell history or logs. The only HTTP destination is the local backend.
AUTHENTICATED_HEALTH = r'''
import asyncio, base64, hashlib, json, secrets, time, urllib.request
from app.config import get_settings

async def authenticated_health(check):
    settings = get_settings()
    headers, digest = {}, None
    accounts = getattr(settings, "accounts_enabled", False)
    if accounts:
        from sqlalchemy import select, delete
        from app.database import AsyncSessionLocal, engine
        from app.models import User, UserSession
        # This local OS-level health check never prints a cookie or changes users.
        # Its short-lived session is deleted even if an HTTP check fails.
        async with AsyncSessionLocal() as db:
            user = await db.scalar(select(User).where(User.enabled.is_(True), User.role == "Admin", User.must_change_password.is_(False)))
            if not user: raise RuntimeError("No active administrator is ready for account sign-in")
            token = secrets.token_urlsafe(32)
            digest = hashlib.sha256(token.encode()).hexdigest()
            db.add(UserSession(token_hash=digest, user_id=user.id, csrf_token=secrets.token_urlsafe(32), expires_at=time.time()+60))
            await db.commit()
        headers["Cookie"] = "dcim_session=" + token
    elif settings.lab_manager_password:
        token = base64.b64encode((":" + settings.lab_manager_password).encode()).decode()
        headers["Authorization"] = "Basic " + token
    try:
        return check(headers, accounts)
    finally:
        if digest:
            async with AsyncSessionLocal() as db:
                await db.execute(delete(UserSession).where(UserSession.token_hash == digest))
                await db.commit()
            await engine.dispose()
'''

MONITOR_HEALTH = AUTHENTICATED_HEALTH + r'''
def check(headers, accounts):
    request = urllib.request.Request("http://127.0.0.1:8000/api/monitoring", headers=headers)
    with urllib.request.urlopen(request, timeout=5) as response:
        data = json.load(response)
    return {**{key: data.get(key) for key in ("service", "timezone", "last_started_at", "error")}, "accounts_enabled": accounts}
print(json.dumps(asyncio.run(authenticated_health(check))))
'''

READY_HEALTH = AUTHENTICATED_HEALTH + r'''
import sys
options = json.load(sys.stdin)
def check(headers, accounts):
    base = "http://127.0.0.1:" + str(options["port"])
    request = urllib.request.Request(base + "/api/version", headers=headers)
    with urllib.request.urlopen(request, timeout=3) as response:
        version = json.load(response).get("version")
    if options.get("expected_version") is not None and version != options["expected_version"]:
        raise RuntimeError("Another application is answering on the selected port")
    request = urllib.request.Request(base + "/api/rack-items", headers=headers)
    with urllib.request.urlopen(request, timeout=3) as response:
        if options.get("inventory") and not response.headers.get("ETag"):
            raise RuntimeError("The inventory update is not active")
        json.load(response)
    if options.get("expected_accounts") is not None and accounts != options["expected_accounts"]:
        raise RuntimeError("The requested account mode is not active")
    return {"version": version, "accounts_enabled": accounts}
print(json.dumps(asyncio.run(authenticated_health(check))))
'''

ACCOUNT_PREFLIGHT = r'''
import json
from app.config import get_settings
settings = get_settings()
print(json.dumps({"has_password":bool(settings.lab_manager_password), "accounts_enabled":getattr(settings, "accounts_enabled", False)}))
'''

PROBE_ENVIRONMENT = r'''
import asyncio
from zoneinfo import ZoneInfo
from app.ping_monitor import ping
ZoneInfo("Asia/Jerusalem")
result = asyncio.run(ping("127.0.0.1"))
if result.status != "up":
    raise SystemExit("Local ICMP preflight failed: " + result.detail)
print("Local ICMP and Israel timezone checks passed")
'''


def verify_monitoring(root, python, expected_accounts=None):
    last = "Monitoring has not started yet"
    for _ in range(20):
        try:
            data = json.loads(subprocess.check_output(
                [str(python), "-c", MONITOR_HEALTH], cwd=root / "backend",
                text=True, stderr=subprocess.PIPE, timeout=10,
            ))
            if expected_accounts is not None and data.get("accounts_enabled") != expected_accounts:
                raise RuntimeError("The requested account mode is not active")
            if data.get("timezone") != "Asia/Jerusalem":
                raise RuntimeError("PING_MONITOR_TIMEZONE must be Asia/Jerusalem for the requested schedule")
            if data.get("service") == "disabled":
                raise RuntimeError("PING_MONITOR_ENABLED is false in the application configuration")
            if data.get("service") in ("scheduled", "running") and data.get("last_started_at"):
                return
            last = data.get("error") or data.get("service") or last
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
            last = "The authenticated monitoring health check failed"
        time.sleep(.5)
    raise RuntimeError("Ping Monitor did not become healthy: " + last)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def file_set(root, *args):
    return set(filter(None, git(root, *args).splitlines()))


def safe_extract(archive, destination):
    destination = destination.resolve()
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            target = (destination / member.name).resolve()
            if destination not in target.parents or not (member.isdir() or member.isfile()):
                raise RuntimeError("Unexpected path in the source archive")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as incoming, target.open("wb") as out:
                    shutil.copyfileobj(incoming, out)


def wait_ready(port, process=None, expected_version=None, inventory=False, root=None, python=None, env=None, expected_accounts=None):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError("The backend exited during startup")
        try:
            if root is not None:
                subprocess.check_output([str(python), "-c", READY_HEALTH], cwd=root / "backend", env=env,
                    input=json.dumps({"port":port, "expected_version":expected_version, "inventory":inventory, "expected_accounts":expected_accounts}),
                    text=True, stderr=subprocess.PIPE, timeout=12)
                return
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=1) as r:
                version = json.load(r).get("version")
            if expected_version is not None and version != expected_version:
                raise RuntimeError("Another application is answering on the selected port")
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/rack-items", timeout=1) as r:
                if inventory and not r.headers.get("ETag"):
                    raise RuntimeError("The inventory update is not active")
                json.load(r)
            return
        except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            time.sleep(.5)
    raise RuntimeError("The backend did not become ready within 30 seconds")


def start(root, python, log_path, port=8000, env=None):
    with log_path.open("ab") as log:
        return subprocess.Popen(
            [str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1" if env else "0.0.0.0", "--port", str(port),
             "--timeout-graceful-shutdown", "10"],
            cwd=root / "backend", stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True, env=env,
        )


def smoke_test(source, python, backup, enable_accounts=False):
    # All checks happen against the extracted source before stopping the live app.
    env = {**os.environ, "DATABASE_URL": "sqlite+aiosqlite:///:memory:", "LAB_MANAGER_PASSWORD": "",
           "PING_MONITOR_ENABLED": "true", "PING_MONITOR_TIMEZONE": "Asia/Jerusalem",
           "ACCOUNTS_ENABLED": "false", "ACCOUNTS_REGISTRATION_ENABLED": "false", "EMAIL_ALERTS_ENABLED": "false"}
    probe = subprocess.run([str(python), "-c", PROBE_ENVIRONMENT], cwd=source / "backend",
                           env=env, text=True, capture_output=True, timeout=20)
    if probe.returncode:
        raise RuntimeError("VM preflight failed before any service was stopped. Check the existing venv dependencies, "
                           "system ping utility and ICMP permissions.\n" + (probe.stderr or probe.stdout)[-2000:])
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    process = start(source, python, backup / "preflight.log", port, env)
    try:
        wait_ready(port, process=process, inventory=True)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/inventory", timeout=3) as response:
            if json.load(response).get("items") != []:
                raise RuntimeError("Preflight must use an empty test inventory")
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/monitoring", timeout=3) as response:
            monitoring = json.load(response)
        if monitoring.get("timezone") != "Asia/Jerusalem" or monitoring.get("targets") != []:
            raise RuntimeError("Ping Monitor preflight failed its timezone or isolated inventory check")
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=3) as response:
            html = response.read().decode()
        assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
        if not assets:
            raise RuntimeError("The reviewed commit has no built frontend")
        for asset in assets:
            urllib.request.urlopen(f"http://127.0.0.1:{port}{asset}", timeout=3).close()
        if enable_accounts:
            process.terminate()
            process.wait(timeout=8)
            env.update(ACCOUNTS_ENABLED="true", LAB_MANAGER_PASSWORD=secrets.token_urlsafe(24),
                       ACCOUNTS_SECURE_COOKIE="false", DATABASE_URL="sqlite+aiosqlite:///" + str(backup / "preflight-accounts.db"))
            process = start(source, python, backup / "preflight-accounts.log", port, env)
            wait_ready(port, process=process, inventory=True, root=source, python=python, env=env, expected_accounts=True)
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
            credentials = {"username":env.get("ACCOUNTS_ADMIN_USERNAME", "admin"), "password":env["LAB_MANAGER_PASSWORD"]}
            request = urllib.request.Request(f"http://127.0.0.1:{port}/api/auth/login", data=json.dumps(credentials).encode(),
                                             headers={"Content-Type":"application/json"})
            with opener.open(request, timeout=5) as response:
                account = json.load(response)
            if account.get("user", {}).get("role") != "Admin":
                raise RuntimeError("Account preflight did not initialize an administrator")
            with opener.open(f"http://127.0.0.1:{port}/api/users", timeout=3) as response:
                if len(json.load(response)) != 1:
                    raise RuntimeError("Account preflight must use only an isolated administrator")
            request = urllib.request.Request(f"http://127.0.0.1:{port}/api/auth/logout", method="POST",
                                             headers={"X-DCIM-CSRF":account["csrf_token"]})
            opener.open(request, timeout=3).close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()  # Only the isolated child started above.
            process.wait()


def service_pids(root, proc_root=Path("/proc")):
    expected_cwd = (root / "backend").resolve()
    matches = []
    for proc in proc_root.iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid != os.getuid() or (proc / "cwd").resolve() != expected_cwd:
                continue
            command = (proc / "cmdline").read_bytes().decode().strip("\0").split("\0")
            if "uvicorn" not in command or "app.main:app" not in command:
                continue
            if "--port" in command and command[command.index("--port") + 1] != "8000":
                continue
            matches.append(int(proc.name))
        except (OSError, IndexError):
            continue
    return matches


def active_process(pid, proc_root=Path("/proc")):
    """Return a live process's start time; an unreaped zombie is already stopped."""
    try:
        stat = (proc_root / str(pid) / "stat").read_text()
    except (FileNotFoundError, ProcessLookupError):
        return None
    try:
        # The executable name in parentheses can itself contain spaces or ')'.
        fields = stat.rsplit(")", 1)[1].split()
        state, started = fields[0], fields[19]  # /proc stat fields 3 and 22.
    except IndexError as exc:
        raise RuntimeError("Cannot determine the backend process state") from exc
    return None if state in {"Z", "X", "x"} else started


def port_occupied(port=8000):
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def stop_existing(pid, *, force=False, root=None):
    started = active_process(pid)
    if started is None:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(80):
        if active_process(pid) != started:
            return  # Exited, zombie, or a different process now has this PID.
        time.sleep(.25)
    if active_process(pid) == started:
        if not force:
            raise RuntimeError("The old backend has not stopped; no application files were changed. "
                               "Use --finish-stuck-shutdown to take a live database backup and finish stopping this project's backend")
        # Recheck ownership, directory, command and process identity after waiting.
        # A reused PID or another project's process must never receive SIGKILL.
        if root is None or pid not in service_pids(root):
            raise RuntimeError("The stuck process no longer matches this project; it was not force-stopped")
        if active_process(pid) != started:
            return
        print("Finishing shutdown of the verified project backend; a live database snapshot was saved before stopping…", flush=True)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        for _ in range(40):
            if active_process(pid) != started:
                return
            time.sleep(.25)
        raise RuntimeError("The verified backend could not be stopped; no application files were changed")


def snapshot_before_shutdown(root, backup):
    """Save a coherent SQLite snapshot while the old application is still alive."""
    destination = backup / "before-stop"
    destination.mkdir(mode=0o700)
    runtime = [root / ".env", root / "backend" / "version.txt", root / "lab-twin" / "lab-data.json"]
    runtime += list((root / "backend").glob("*.json"))
    for path in runtime:
        if path.is_file():
            saved = destination / path.relative_to(root)
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, saved)
    for path in (root / "backend").glob("*.db"):
        if not path.is_file() or path.is_symlink():
            raise RuntimeError("Live database backup requires a regular SQLite database file")
        saved = destination / path.relative_to(root)
        saved.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + 15
        def progress(status, remaining, total):
            if time.monotonic() >= deadline:
                raise RuntimeError("Live database backup timed out; the running backend was not stopped")
        try:
            with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)) as source:
                with closing(sqlite3.connect(saved)) as target:
                    source.backup(target, pages=256, progress=progress, sleep=.05)
                    if target.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                        raise RuntimeError("The live database snapshot failed its integrity check")
        except sqlite3.Error as exc:
            raise RuntimeError("Live database backup failed; the running backend was not stopped") from exc
    print("Live data snapshot saved to: " + str(destination), flush=True)


def restore_live(root, backup):
    for relative in LIVE_TRACKED:
        saved = backup / "runtime" / relative
        if saved.exists():
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(saved, target)


def check_account_activation(root, python):
    if (root / ".env").is_symlink():
        raise RuntimeError("Account activation requires a regular project .env file")
    override = os.environ.get("ACCOUNTS_ENABLED")
    if override is not None and override.strip().lower() not in {"true", "1", "yes", "on"}:
        raise RuntimeError("The shell's ACCOUNTS_ENABLED override prevents activation; unset it before installing")
    result = json.loads(subprocess.check_output([str(python), "-c", ACCOUNT_PREFLIGHT], cwd=root / "backend", text=True, stderr=subprocess.PIPE, timeout=10))
    if not result["accounts_enabled"] and not result["has_password"]:
        raise RuntimeError("Set the existing LAB_MANAGER_PASSWORD before enabling accounts; no default password is created")


def enable_account_mode(root, backup):
    path = root / ".env"
    saved = backup / "runtime" / ".env"
    original = saved.read_bytes() if saved.exists() else b""
    if (path.read_bytes() if path.exists() else b"") != original:
        raise RuntimeError("The .env changed during installation; account settings were left untouched")
    lines = original.decode("utf-8").splitlines(keepends=True)
    newline = "\r\n" if b"\r\n" in original else "\n"
    lines = [line for line in lines if not re.match(r"\s*(?:export\s+)?ACCOUNTS_ENABLED\s*=", line)]
    text = "".join(lines)
    if text and not text.endswith(("\n", "\r")): text += newline
    contents = (text + "ACCOUNTS_ENABLED=true" + newline).encode("utf-8")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, prefix=".env-install-", delete=False) as out:
            temporary = Path(out.name)
            out.write(contents)
        if path.exists(): shutil.copymode(path, temporary)
        else: os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists(): temporary.unlink()


@contextmanager
def install_lock(root):
    import fcntl
    # Share the existing deployment lock so barcode and monitor updates cannot overlap.
    with (root / ".barcode-install.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another installation is already running") from exc
        yield


def install(root, commit, backup_frontend_lock=False, enable_accounts=False, finish_stuck_shutdown=False):
    root = root.resolve()
    if Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise RuntimeError("Choose the DCIM-204 Git repository itself")
    python = root / "backend" / ".venv" / "bin" / "python"
    if not python.exists():
        raise RuntimeError("The existing backend/.venv/bin/python was not found")
    with install_lock(root):
        old = git(root, "rev-parse", "HEAD")
        if file_set(root, "diff", "--cached", "--name-only"):
            raise RuntimeError("There are staged changes. Commit or unstage them before installing.")
        dirty = file_set(root, "diff", "--name-only", "HEAD") - LIVE_TRACKED
        local_source = {FRONTEND_LOCK} & dirty if backup_frontend_lock else set()
        dirty -= local_source
        if dirty:
            raise RuntimeError("Local source edits need review before installing: " + ", ".join(sorted(dirty)))
        if enable_accounts:
            check_account_activation(root, python)
        for relative in local_source:
            path = root / relative
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("Only an existing regular frontend/package-lock.json can be backed up")
        print("Fetching the reviewed update…", flush=True)
        git(root, "fetch", REPOSITORY, commit)
        try:
            git(root, "merge-base", "--is-ancestor", old, commit)
        except subprocess.CalledProcessError as exc:
            if exc.returncode != 1:
                raise
            raise RuntimeError(
                "The update does not include the current VM commit " + old + ". "
                "Use a release that includes this version; no application files were changed "
                "and the running service was not stopped."
            ) from exc
        changed = file_set(root, "diff", "--name-only", old, commit)
        protected = {".env", "backend/lab_manager.db"}
        protected.update(p.relative_to(root).as_posix() for p in (root / "backend").glob("*.json"))
        if changed & protected:
            raise RuntimeError("This update changes runtime data files; installation stopped for review")
        untracked = file_set(root, "ls-files", "--others", "--exclude-standard")
        collisions = (untracked & changed) - LIVE_TRACKED
        if collisions:
            raise RuntimeError("Untracked files would be replaced: " + ", ".join(sorted(collisions)))
        pids = service_pids(root)
        if len(pids) > 1:
            raise RuntimeError("Multiple matching backends found; choose the running service manually")
        occupied = port_occupied()
        if occupied and not pids:
            raise RuntimeError("Port 8000 belongs to a process outside this project; it was left running")

        backup = root / ".monitor-backups" / (datetime.now().strftime("%Y%m%d-%H%M%S-%f") + "-" + commit[:7])
        backup.mkdir(parents=True, mode=0o700)
        os.chmod(backup.parent, 0o700)
        os.chmod(backup, 0o700)
        (backup / "previous-commit.txt").write_text(old + "\n")
        archive = backup / "source.tar"
        with archive.open("wb") as out:
            subprocess.run(["git", "-C", str(root), "archive", commit], stdout=out, check=True)
        source = backup / "source"
        source.mkdir()
        safe_extract(archive, source)
        print("Checking startup with the VM's Python environment…", flush=True)
        smoke_test(source, python, backup, enable_accounts)
        for relative in local_source:
            path = root / relative
            original = path.read_bytes()
            saved = backup / "local-source" / relative
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, saved)
            if saved.read_bytes() != original or path.read_bytes() != original:
                raise RuntimeError("The local lockfile changed during backup; installation stopped")
            print("Local npm lockfile saved to: " + str(saved), flush=True)
        print("Preflight passed. Saving the current inventory and updating…", flush=True)
        if finish_stuck_shutdown and pids:
            snapshot_before_shutdown(root, backup)

        stopped = False
        stop_attempted = False
        updated = False
        new_process = None
        cleared_source = set()
        accounts_config_changed = False
        try:
            if pids:
                stop_attempted = True
                if finish_stuck_shutdown:
                    stop_existing(pids[0], force=True, root=root)
                else:
                    stop_existing(pids[0])
                stopped = True
            if port_occupied():
                raise RuntimeError("Port 8000 is still occupied; no application files were changed")
            runtime = [root / ".env", root / "backend" / "version.txt", root / "lab-twin" / "lab-data.json"]
            runtime += list((root / "backend").glob("*.json")) + list((root / "backend").glob("*.db*"))
            for path in runtime:
                if path.is_file():
                    saved = backup / "runtime" / path.relative_to(root)
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(path, saved)
            for relative in LIVE_TRACKED:
                if relative in untracked and (root / relative).exists() and relative in changed:
                    (root / relative).unlink()  # Its verified copy is in the private backup above.
                elif relative in file_set(root, "diff", "--name-only", "HEAD"):
                    git(root, "checkout", "--", relative)
            for relative in local_source:
                if (root / relative).read_bytes() != (backup / "local-source" / relative).read_bytes():
                    raise RuntimeError("The local lockfile changed after backup; installation stopped")
                cleared_source.add(relative)
                git(root, "checkout", "--", relative)
            git(root, "merge", "--ff-only", "--no-edit", commit)
            updated = True
            restore_live(root, backup)
            (root / "backend" / "version.txt").write_text(commit[:7] + "\n")
            if enable_accounts:
                enable_account_mode(root, backup)
                accounts_config_changed = True
            new_process = start(root, python, root / "backend" / "server.log")
            wait_ready(8000, new_process, expected_version=commit[:7], inventory=True, root=root, python=python,
                       expected_accounts=True if enable_accounts else None)
            if enable_accounts: verify_monitoring(root, python, expected_accounts=True)
            else: verify_monitoring(root, python)
        except Exception:
            if new_process is not None and new_process.poll() is None:
                new_process.terminate()
                new_process.wait(timeout=10)
            if updated:
                # Roll back only our fast-forward, with all original edits/data backed up.
                unexpected = file_set(root, "diff", "--name-only", "HEAD") - LIVE_TRACKED
                if unexpected:
                    raise RuntimeError("New local source edits prevent automatic rollback. Backup: " + str(backup))
                git(root, "reset", "--hard", old)
            restore_live(root, backup)
            if accounts_config_changed:
                saved = backup / "runtime" / ".env"
                if saved.exists(): shutil.copy2(saved, root / ".env")
                else: (root / ".env").unlink(missing_ok=True)
            for relative in cleared_source:
                shutil.copy2(backup / "local-source" / relative, root / relative)
            # A shutdown can finish as an error is raised. Recover the old site
            # in that case too, without starting a second server on an occupied port.
            if stop_attempted and not stopped:
                stopped = active_process(pids[0]) is None
            if stopped and not port_occupied():
                previous = start(root, python, root / "backend" / "server.log")
                wait_ready(8000, previous, root=root, python=python)
            print("Update failed. Original source and live twin data restored. Backup: " + str(backup), file=sys.stderr)
            raise
        print("Installed " + commit[:7] + ". Inventory preserved. Backup: " + str(backup))
        print("Open the site with ?tab=dashboard and refresh existing DCIM / 3D Twin tabs.")
        if enable_accounts:
            print("Accounts enabled. First administrator: ACCOUNTS_ADMIN_USERNAME (admin by default), using the existing site password.")
        print("Ping Monitor: every 5 minutes 07:00-20:00; every 30 minutes overnight; Asia/Jerusalem.")
        print("Check imported server names/IPs in Ping Monitor. DNS and lab reachability need verification there.")
        print("The backend is running in the background. VM boot startup remains unchanged.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit", help="Reviewed full Git commit SHA")
    parser.add_argument("--project", type=Path, default=Path.home() / "DCIM-204")
    parser.add_argument(
        "--backup-frontend-lock", action="store_true",
        help="Back up local frontend/package-lock.json edits and replace them with the reviewed version",
    )
    parser.add_argument("--enable-accounts", action="store_true", help="Enable real users after testing account-mode startup; preserve existing credentials and back up .env")
    parser.add_argument("--finish-stuck-shutdown", action="store_true", help="Take a live database snapshot and finish stopping only this project's backend if graceful shutdown times out")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Run this installer inside the Linux VM")
    if sys.version_info < (3, 10):
        parser.error("Use the application's backend/.venv/bin/python (Python 3.10+), not the old system Python")
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        parser.error("Pass a full 40-character commit SHA")
    install(args.project, args.commit, backup_frontend_lock=args.backup_frontend_lock, enable_accounts=args.enable_accounts,
            finish_stuck_shutdown=args.finish_stuck_shutdown)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print("Installation stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
