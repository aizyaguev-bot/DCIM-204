#!/usr/bin/env python3
"""Install a reviewed commit on the existing Linux VM, using its existing venv.

No sudo, package installation, database seeding, or remote Git write is performed.
The checkout must be clean except for live twin data and the deployment version.
Use --backup-frontend-lock to preserve a locally modified npm lockfile in the
backup and install the reviewed lockfile alongside the prebuilt frontend.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request

REPOSITORY = "https://github.com/aizyaguev-bot/DCIM-204.git"
LIVE_TRACKED = {"lab-twin/lab-data.json", "backend/version.txt"}
FRONTEND_LOCK = "frontend/package-lock.json"


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


def wait_ready(port, process=None, expected_version=None, inventory=False):
    for _ in range(40):
        if process is not None and process.poll() is not None:
            raise RuntimeError("The backend exited during startup")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=1) as r:
                version = json.load(r).get("version")
            if expected_version is not None and version != expected_version:
                raise RuntimeError("Another application is answering on the selected port")
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/rack-items", timeout=1) as r:
                if inventory and not r.headers.get("ETag"):
                    raise RuntimeError("The inventory update is not active")
                json.load(r)
            return
        except (OSError, ValueError):
            time.sleep(.5)
    raise RuntimeError("The backend did not become ready within 20 seconds")


def start(root, python, log_path, port=8000, env=None):
    with log_path.open("ab") as log:
        return subprocess.Popen(
            [str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1" if env else "0.0.0.0", "--port", str(port)],
            cwd=root / "backend", stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True, env=env,
        )


def smoke_test(source, python, backup):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    env = {**os.environ, "DATABASE_URL": "sqlite+aiosqlite:///:memory:", "LAB_MANAGER_PASSWORD": ""}
    process = start(source, python, backup / "preflight.log", port, env)
    try:
        wait_ready(port, process=process, inventory=True)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/inventory", timeout=3) as response:
            if json.load(response).get("items") != []:
                raise RuntimeError("Preflight must use an empty test inventory")
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=3) as response:
            html = response.read().decode()
        assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
        if not assets:
            raise RuntimeError("The reviewed commit has no built frontend")
        for asset in assets:
            urllib.request.urlopen(f"http://127.0.0.1:{port}{asset}", timeout=3).close()
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


def stop_existing(pid):
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
        raise RuntimeError("The old backend has not stopped; no application files were changed")


def restore_live(root, backup):
    for relative in LIVE_TRACKED:
        saved = backup / "runtime" / relative
        if saved.exists():
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(saved, target)


@contextmanager
def install_lock(root):
    import fcntl
    with (root / ".barcode-install.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another installation is already running") from exc
        yield


def install(root, commit, backup_frontend_lock=False):
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
        for relative in local_source:
            path = root / relative
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("Only an existing regular frontend/package-lock.json can be backed up")
        print("Fetching the reviewed update…", flush=True)
        git(root, "fetch", REPOSITORY, commit)
        git(root, "merge-base", "--is-ancestor", old, commit)
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

        backup = root / ".barcode-backups" / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + commit[:7])
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
        smoke_test(source, python, backup)
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

        stopped = False
        stop_attempted = False
        updated = False
        new_process = None
        cleared_source = set()
        try:
            if pids:
                stop_attempted = True
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
            new_process = start(root, python, root / "backend" / "server.log")
            wait_ready(8000, new_process, expected_version=commit[:7], inventory=True)
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
            for relative in cleared_source:
                shutil.copy2(backup / "local-source" / relative, root / relative)
            # A shutdown can finish as an error is raised. Recover the old site
            # in that case too, without starting a second server on an occupied port.
            if stop_attempted and not stopped:
                stopped = active_process(pids[0]) is None
            if stopped and not port_occupied():
                previous = start(root, python, root / "backend" / "server.log")
                wait_ready(8000, previous)
            print("Update failed. Original source and live twin data restored. Backup: " + str(backup), file=sys.stderr)
            raise
        print("Installed " + commit[:7] + ". Inventory preserved. Backup: " + str(backup))
        print("Open the site with ?tab=scan and refresh existing DCIM / 3D Twin tabs.")
        print("The backend is running in the background. VM boot startup remains unchanged.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit", help="Reviewed full Git commit SHA")
    parser.add_argument("--project", type=Path, default=Path.home() / "DCIM-204")
    parser.add_argument(
        "--backup-frontend-lock", action="store_true",
        help="Back up local frontend/package-lock.json edits and replace them with the reviewed version",
    )
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Run this installer inside the Linux VM")
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        parser.error("Pass a full 40-character commit SHA")
    install(args.project, args.commit, backup_frontend_lock=args.backup_frontend_lock)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print("Installation stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
