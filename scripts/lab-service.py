#!/usr/bin/env python3
"""Start, restart and inspect the single Lab Manager backend on the Linux VM.

The installer lock is shared with scripts/install-monitoring.py, so a boot-time
start cannot create a second process while an install or restart is in progress.
"""
import argparse
import importlib.util
import json
import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

MANAGED_MARK = "# DCIM-204 lab-service boot (managed)"
ROOT = Path(__file__).resolve().parents[1]


def installer():
    path = Path(__file__).resolve().parent / "install-monitoring.py"
    spec = importlib.util.spec_from_file_location("monitoring_installer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def project_dir(value):
    return Path(value or ROOT).resolve()


def python_for(root):
    return root / "backend" / ".venv" / "bin" / "python"


def boot_command(root):
    root = Path(root)
    python = python_for(root)
    script = root / "scripts" / "lab-service.py"
    return (
        f"@reboot sleep 45 && cd {root} && {python} {script} --project {root} start "
        f">> {root / 'backend' / 'boot.log'} 2>&1 {MANAGED_MARK}"
    )


START_SCRIPTS = {"start.sh", "start.bat", "dev.bat", "deploy.sh"}
WRAPPERS = {"nohup", "exec", "setsid", "env", "nice", "ionice", "timeout", "stdbuf", "chronic", "command", "time",
            "sudo", "sh", "bash", "dash", "zsh"}


def _expand(token, cwd, home, specifiers=False):
    if specifiers:
        token = token.replace("%h", str(home))
    for prefix in ("${HOME}", "$HOME", "~"):
        if token == prefix or token.startswith(prefix + "/"):
            token = str(home) + token[len(prefix):]
            break
    path = Path(token)
    if not path.is_absolute():
        path = Path(cwd) / path
    return os.path.normcase(os.path.normpath(str(path)))


def _inside(path, directory):
    return path == directory or path.startswith(directory.rstrip(os.sep) + os.sep)


def _tokens(segment):
    return [token.strip("\"'()") for token in re.findall(r"\"[^\"]*\"|'[^']*'|\S+", segment)]


def starts_backend(command, root, cwd=None, home=None, specifiers=False):
    """True only when a shell command line starts this project's backend.

    Recognized: uvicorn app.main:app run inside this project, this project's start.sh /
    start.bat / dev.bat / deploy.sh, or this project's lab-service.py start/restart.
    Backups and other jobs that merely mention the project path are not backend starts."""
    home = Path(home) if home else Path.home()
    root_path = os.path.normcase(os.path.normpath(str(root)))
    cwd = _expand(str(cwd or home), home, home, specifiers)
    for segment in re.split(r"&&|\|\||;|\||(?<![<>&])&(?![>&])", command):
        tokens = [token for token in _tokens(segment) if token]
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if re.fullmatch(r"[A-Za-z_]\w*=.*", token):
                index += 1
            elif Path(token).name in WRAPPERS:
                index += 1
                while index < len(tokens) and re.fullmatch(r"-\S*|\d+[smhd]?", tokens[index]):
                    index += 1
            else:
                break
        if index >= len(tokens):
            continue
        program, args = tokens[index], tokens[index + 1:]
        name = Path(program).name
        if name == "cd":
            cwd = _expand(args[0], cwd, home, specifiers) if args else _expand(str(home), cwd, home)
            continue
        module = None
        if name.startswith("python"):
            rest = list(args)
            program = None
            while rest:
                option = rest.pop(0)
                if option == "-m" and rest:
                    module = rest.pop(0)
                    break
                if not option.startswith("-"):
                    program = option
                    break
            args = rest
            if program is None and module is None:
                continue
        if module == "uvicorn" or (program and "uvicorn" in Path(program).name):
            if "app.main:app" not in args:
                continue
            paths = [cwd] + [_expand(value, cwd, home, specifiers)
                             for value in (arg.split("=", 1)[-1] for arg in [program or ""] + args)
                             if value and ("/" in value or "\\" in value or value.startswith(("~", "$")))]
            if any(_inside(path, root_path) for path in paths):
                return True
            continue
        if not program:
            continue
        resolved = _expand(program, cwd, home, specifiers)
        name = Path(program).name
        if name in START_SCRIPTS and os.path.dirname(resolved) == root_path:
            return True
        if (name == "lab-service.py" and os.path.dirname(resolved) == os.path.join(root_path, "scripts")
                and any(arg in ("start", "restart") for arg in args)):
            return True
    return False


def _cron_command(line):
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or re.match(r"[A-Za-z_]\w*\s*=", stripped):
        return None
    if stripped.startswith("@"):
        parts = stripped.split(None, 1)
    else:
        parts = stripped.split(None, 5)
        parts = parts[5:] if len(parts) == 6 else []
    return parts[-1] if parts and len(parts[-1]) else None


def foreign_boot_lines(crontab_text, root, home=None):
    """Crontab lines (any schedule) other than ours that start this project's backend.

    Other jobs for this project (backups, status checks etc.) are not boot mechanisms."""
    found = []
    for line in crontab_text.splitlines():
        command = _cron_command(line)
        if command is None or MANAGED_MARK in line:
            continue
        if starts_backend(command.split("%", 1)[0], root, home=home):
            found.append(line.strip())
    return found


def apply_crontab(text, root, replace=False):
    """Return (new_text, blockers). Blockers are non-crontab mechanisms or foreign lines left in place."""
    lines = text.splitlines()
    foreign = foreign_boot_lines(text, root)
    managed = boot_command(root)
    if foreign and not replace:
        return text if text.endswith("\n") or not text else text, foreign
    kept = []
    for line in lines:
        if MANAGED_MARK in line:
            continue
        if replace and line.strip() and not line.strip().startswith("#") and line.strip() in foreign:
            kept.append("# disabled by lab-service --replace " + line)
            continue
        kept.append(line)
    if kept and kept[-1] != "":
        kept.append("")
    kept.append(managed)
    return "\n".join(kept).rstrip() + "\n", []


def remove_managed(text):
    lines = [line for line in text.splitlines() if MANAGED_MARK not in line]
    body = "\n".join(lines).strip()
    return (body + "\n") if body else ""


def _entry_starts_backend(text, root, home, commands, directory_key, default_cwd, specifiers):
    """systemd unit / desktop entry whose Exec command starts this project's backend."""
    cwd = default_cwd
    execs = []
    for line in text.splitlines():
        key, sep, value = line.strip().partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        if key == directory_key and value:
            cwd = value.lstrip("-") or cwd
        elif key in commands and value:
            execs.append(value.lstrip("@-:+!"))
    return any(starts_backend(command, root, cwd=cwd, home=home, specifiers=specifiers) for command in execs)


def scan_other_boot(root, home=None, system_units=Path("/etc/systemd/system")):
    """Return sanitized descriptions of boot mechanisms outside the user crontab."""
    home = Path(home) if home else Path.home()
    found = []
    services = ("ExecStart", "ExecStartPre", "ExecStartPost")
    for label, unit_dir, default_cwd in (("systemd unit", Path(system_units), "/"),
                                         ("user systemd unit", home / ".config" / "systemd" / "user", home)):
        if not unit_dir.is_dir():
            continue
        for path in sorted(unit_dir.glob("*.service")):
            try:
                text = path.read_text(errors="replace")
            except OSError:
                continue
            if _entry_starts_backend(text, root, home, services, "WorkingDirectory", default_cwd, True):
                found.append(f"{label} {path.name} starts this project's backend")
    autostart = home / ".config" / "autostart"
    if autostart.is_dir():
        for path in sorted(autostart.iterdir()):
            try:
                text = path.read_text(errors="replace")
            except OSError:
                continue
            if _entry_starts_backend(text, root, home, ("Exec",), "Path", home, False):
                found.append(f"autostart entry {path.name} starts this project's backend")
    return found


def read_crontab():
    try:
        result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise RuntimeError("crontab is not installed") from exc
    if result.returncode == 0:
        return result.stdout
    err = (result.stderr or "") + (result.stdout or "")
    if result.returncode == 1 and "no crontab" in err.lower():
        return ""
    if "not found" in err.lower() or result.returncode == 127:
        raise RuntimeError("crontab is not installed")
    raise RuntimeError("Could not read the user crontab")


def write_crontab(text):
    subprocess.run(["crontab", "-"], input=text, text=True, check=True)


def backup_crontab(root, text):
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    destination = root / ".monitor-backups" / f"{stamp}-crontab"
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(destination, 0o700)
    saved = destination / "crontab.txt"
    saved.write_text(text)
    os.chmod(saved, 0o600)
    return destination


def inventory_counts(root):
    counts = {"tables": {}, "json": {}}
    for path in sorted((root / "backend").glob("*.db")):
        if not path.is_file() or path.is_symlink():
            continue
        uri = path.resolve().as_uri() + "?mode=ro"
        with sqlite3.connect(uri, uri=True) as connection:
            tables = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            for name in tables:
                quoted = '"' + name.replace('"', '""') + '"'
                counts["tables"][f"{path.name}:{name}"] = connection.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
    json_paths = list((root / "backend").glob("*.json"))
    twin = root / "lab-twin" / "lab-data.json"
    if twin.is_file():
        json_paths.append(twin)
    for path in json_paths:
        if path.is_symlink() or not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            counts["json"][str(path.relative_to(root))] = None
            continue
        if isinstance(data, list):
            count = len(data)
        elif isinstance(data, dict) and isinstance(data.get("items"), list):
            count = len(data["items"])
        elif isinstance(data, dict):
            count = len(data)
        else:
            count = None
        counts["json"][str(path.relative_to(root)).replace("\\", "/")] = count
    return counts


def _local_json(root, snippet):
    python = python_for(root)
    if not python.is_file():
        return None
    try:
        return json.loads(subprocess.check_output(
            [str(python), "-c", snippet], cwd=root / "backend", text=True, stderr=subprocess.DEVNULL, timeout=12,
        ))
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
        return None


def collect_status(root):
    tool = installer()
    root = project_dir(root)
    pids = []
    try:
        pids = tool.service_pids(root)
    except OSError:
        pids = []
    version_file = root / "backend" / "version.txt"
    try:
        crontab = read_crontab()
        boot = {"installed": MANAGED_MARK in crontab, "foreign": foreign_boot_lines(crontab, root) + scan_other_boot(root)}
    except RuntimeError as exc:
        boot = {"installed": None, "error": str(exc), "foreign": scan_other_boot(root)}
    head = None
    try:
        head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        head = None
    monitoring = _local_json(root, tool.MONITOR_HEALTH)
    alerts = _local_json(root, tool.AUTHENTICATED_HEALTH + r'''
def check(headers, accounts):
    request = urllib.request.Request("http://127.0.0.1:8000/api/monitoring", headers=headers)
    with urllib.request.urlopen(request, timeout=5) as response:
        data = json.load(response)
    alerts = data.get("email_alerts") or {}
    return {"email_alerts": {key: alerts.get(key) for key in ("enabled", "ready", "problems", "minute_probes", "power_rules", "worker", "pending", "recent")}}
print(json.dumps(asyncio.run(authenticated_health(check))))
''')
    version = _local_json(root, tool.AUTHENTICATED_HEALTH + r'''
def check(headers, accounts):
    request = urllib.request.Request("http://127.0.0.1:8000/api/version", headers=headers)
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)
print(json.dumps(asyncio.run(authenticated_health(check))))
''')
    return {
        "project": str(root),
        "pids": pids,
        "port_8000_open": tool.port_occupied(8000),
        "version_file": version_file.read_text(encoding="utf-8").strip() if version_file.is_file() else None,
        "api_version": (version or {}).get("version"),
        "git_head": head,
        "monitoring": monitoring,
        "email_alerts": (alerts or {}).get("email_alerts"),
        "boot": boot,
        "inventory": inventory_counts(root),
    }


def _locked_start(root, tool):
    pids = tool.service_pids(root)
    if pids:
        print(f"already running ({len(pids)} process)")
        return 0
    if tool.port_occupied(8000):
        print("port 8000 is held by another process")
        return 1
    python = python_for(root)
    log_path = root / "backend" / "server.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = tool.start(root, python, log_path)
    tool.wait_ready(8000, process=process, root=root, python=python)
    tool.verify_monitoring(root, python)
    print("started")
    return 0


@contextmanager
def _guard(root, tool):
    try:
        with tool.install_lock(root):
            yield
    except RuntimeError as exc:
        if "Another installation is already running" in str(exc):
            print("installation in progress, not starting")
            raise SystemExit(0) from exc
        raise


def cmd_start(root):
    root = project_dir(root)
    tool = installer()
    try:
        with _guard(root, tool):
            return _locked_start(root, tool)
    except SystemExit as exc:
        return int(exc.code)


def cmd_restart(root, finish_stuck_shutdown=False):
    root = project_dir(root)
    tool = installer()
    try:
        with _guard(root, tool):
            pids = tool.service_pids(root)
            if len(pids) > 1:
                print("refusing to restart: more than one project backend is running")
                return 1
            if len(pids) == 1:
                if finish_stuck_shutdown:
                    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                    backup = root / ".monitor-backups" / f"{stamp}-restart"
                    backup.mkdir(mode=0o700, parents=True)
                    tool.snapshot_before_shutdown(root, backup)
                    tool.stop_existing(pids[0], force=True, root=root)
                else:
                    tool.stop_existing(pids[0], force=False, root=root)
            return _locked_start(root, tool)
    except SystemExit as exc:
        return int(exc.code)


def cmd_install_boot(root, replace=False):
    root = project_dir(root)
    try:
        current = read_crontab()
    except RuntimeError as exc:
        print(str(exc))
        return 4
    others = scan_other_boot(root)
    foreign = foreign_boot_lines(current, root)
    if others or (foreign and not replace):
        for item in others + foreign:
            print(item)
        print("Another boot mechanism already starts this project; no crontab line was added")
        return 3
    if replace and (foreign or MANAGED_MARK in current):
        backup_crontab(root, current)
    updated, blockers = apply_crontab(current, root, replace=replace)
    if blockers:
        for item in blockers:
            print(item)
        return 3
    if updated == (current if current.endswith("\n") or not current else current + "\n") or updated.strip() == current.strip():
        if MANAGED_MARK in current:
            print("boot start already registered")
            return 0
    write_crontab(updated)
    print("boot start registered")
    return 0


def cmd_remove_boot(root):
    root = project_dir(root)
    try:
        current = read_crontab()
    except RuntimeError as exc:
        print(str(exc))
        return 4
    if MANAGED_MARK not in current:
        print("no managed boot line")
        return 0
    backup_crontab(root, current)
    write_crontab(remove_managed(current))
    print("managed boot line removed")
    return 0


def cmd_status(root, as_json=False):
    data = collect_status(root)
    if as_json:
        print(json.dumps(data, indent=2, default=str))
    else:
        print(f"project: {data['project']}")
        print(f"pids: {data['pids'] or 'none'}")
        print(f"port 8000 open: {data['port_8000_open']}")
        print(f"version file: {data['version_file']}")
        print(f"api version: {data['api_version']}")
        print(f"git HEAD: {data['git_head']}")
        print(f"monitoring: {json.dumps(data['monitoring'], default=str)}")
        print(f"email alerts: {json.dumps(data['email_alerts'], default=str)}")
        print(f"boot: {json.dumps(data['boot'], default=str)}")
        print(f"inventory: {json.dumps(data['inventory'], default=str)}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Manage the single Lab Manager backend on this VM")
    parser.add_argument("--project", default=str(ROOT))
    sub = parser.add_subparsers(dest="command", required=True)
    status = sub.add_parser("status")
    status.add_argument("--json", action="store_true")
    sub.add_parser("start")
    restart = sub.add_parser("restart")
    restart.add_argument("--finish-stuck-shutdown", action="store_true")
    boot = sub.add_parser("install-boot")
    boot.add_argument("--replace", action="store_true")
    sub.add_parser("remove-boot")
    args = parser.parse_args(argv)
    if args.command == "status":
        return cmd_status(args.project, args.json)
    if args.command == "start":
        return cmd_start(args.project)
    if args.command == "restart":
        return cmd_restart(args.project, args.finish_stuck_shutdown)
    if args.command == "install-boot":
        return cmd_install_boot(args.project, args.replace)
    if args.command == "remove-boot":
        return cmd_remove_boot(args.project)
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
