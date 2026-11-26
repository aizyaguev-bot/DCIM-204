"""Service control and boot registration without touching a running backend."""
from contextlib import contextmanager
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("lab_service", Path(__file__).resolve().parents[2] / "scripts" / "lab-service.py")
lab_service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab_service)


class Tool:
    def __init__(self):
        self.pids = []
        self.port = False
        self.started = 0
        self.stopped = []
        self.lock_held = False

    def service_pids(self, root):
        return list(self.pids)

    def port_occupied(self, port=8000):
        return self.port

    def start(self, root, python, log_path, port=8000, env=None):
        self.started += 1
        return object()

    def wait_ready(self, *args, **kwargs):
        return None

    def verify_monitoring(self, root, python):
        return None

    def stop_existing(self, pid, force=False, root=None):
        self.stopped.append((pid, force))

    def snapshot_before_shutdown(self, root, backup):
        (backup / "snap").write_text("ok")

    @contextmanager
    def install_lock(self, root):
        if self.lock_held:
            raise RuntimeError("Another installation is already running")
        yield


@pytest.fixture
def tool(monkeypatch):
    fake = Tool()
    monkeypatch.setattr(lab_service, "installer", lambda: fake)
    return fake


def test_start_is_idempotent_when_already_running(tmp_path, tool, capsys):
    tool.pids = [42]
    assert lab_service.cmd_start(tmp_path) == 0
    assert tool.started == 0
    assert "already running" in capsys.readouterr().out


def test_start_waits_when_install_lock_is_held(tmp_path, tool, capsys):
    tool.lock_held = True
    assert lab_service.cmd_start(tmp_path) == 0
    assert tool.started == 0
    assert "installation in progress" in capsys.readouterr().out


def test_start_refuses_foreign_port(tmp_path, tool, capsys):
    tool.port = True
    assert lab_service.cmd_start(tmp_path) == 1
    assert tool.started == 0
    assert "another process" in capsys.readouterr().out


def test_restart_refuses_multiple_processes(tmp_path, tool):
    tool.pids = [1, 2]
    assert lab_service.cmd_restart(tmp_path) == 1
    assert tool.stopped == []


def test_boot_line_is_idempotent_and_foreign_lines_block(tmp_path, monkeypatch):
    store = {"text": ""}
    monkeypatch.setattr(lab_service, "read_crontab", lambda: store["text"])
    monkeypatch.setattr(lab_service, "write_crontab", lambda text: store.__setitem__("text", text))
    monkeypatch.setattr(lab_service, "scan_other_boot", lambda root: [])
    assert lab_service.cmd_install_boot(tmp_path) == 0
    first = store["text"]
    assert lab_service.MANAGED_MARK in first
    assert lab_service.cmd_install_boot(tmp_path) == 0
    assert store["text"] == first

    store["text"] = f"@reboot {tmp_path}/start.sh\n"
    assert lab_service.cmd_install_boot(tmp_path) == 3
    assert lab_service.MANAGED_MARK not in store["text"]
    assert lab_service.cmd_install_boot(tmp_path, replace=True) == 0
    assert "disabled by lab-service --replace" in store["text"]
    assert lab_service.MANAGED_MARK in store["text"]
    assert any(path.is_dir() for path in (tmp_path / ".monitor-backups").glob("*-crontab"))


def test_boot_command_arguments_are_accepted_by_the_parser(tmp_path, monkeypatch):
    line = lab_service.boot_command(tmp_path)
    script = str(tmp_path / "scripts" / "lab-service.py")
    argv = line.split(script, 1)[1].split(">>", 1)[0].split()
    started = []

    def fake_start(project):
        started.append(project)
        return 0

    monkeypatch.setattr(lab_service, "cmd_start", fake_start)
    assert lab_service.main(argv) == 0
    assert started == [str(tmp_path)]


def fake_crontab(monkeypatch, text):
    store = {"text": text, "writes": 0}

    def write(updated):
        store["text"] = updated
        store["writes"] += 1

    monkeypatch.setattr(lab_service, "read_crontab", lambda: store["text"])
    monkeypatch.setattr(lab_service, "write_crontab", write)
    monkeypatch.setattr(lab_service, "scan_other_boot", lambda root: [])
    return store


def unrelated_jobs(root):
    python = lab_service.python_for(root)
    return (
        'MAILTO=""\n'
        f"0 2 * * * cd {root} && tar czf /backup/dcim.tgz backend/lab_manager.db\n"
        f"@reboot {root}/scripts/backup.sh >> /tmp/backup.log 2>&1\n"
        f"30 * * * * {python} {root}/scripts/lab-service.py --project {root} status --json >> /tmp/s.log\n"
        f"0 3 * * * cp {root}/deploy.sh {root}/start.bat /backup/\n"
        f"*/5 * * * * grep -c uvicorn {root}/backend/server.log > /tmp/count\n"
        "@reboot cd /srv/other && .venv/bin/uvicorn app.main:app --port 9000\n"
    )


def test_unrelated_project_jobs_are_not_boot_mechanisms(tmp_path, monkeypatch):
    root = lab_service.project_dir(tmp_path)
    jobs = unrelated_jobs(root)
    assert lab_service.foreign_boot_lines(jobs, root) == []
    store = fake_crontab(monkeypatch, jobs)
    assert lab_service.cmd_install_boot(root) == 0
    assert store["text"].startswith(jobs)
    assert store["text"][len(jobs):].strip() == lab_service.boot_command(root)


def test_replace_disables_only_backend_start_lines_and_backs_up_first(tmp_path, monkeypatch):
    root = lab_service.project_dir(tmp_path)
    jobs = unrelated_jobs(root)
    start = f"@reboot cd {root}/backend && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000"
    periodic = f"*/10 * * * * cd {root} && ./start.sh"
    store = fake_crontab(monkeypatch, jobs + start + "\n" + periodic + "\n")
    assert lab_service.foreign_boot_lines(store["text"], root) == [start, periodic]
    assert lab_service.cmd_install_boot(root) == 3
    assert store["writes"] == 0
    original = store["text"]
    assert lab_service.cmd_install_boot(root, replace=True) == 0
    lines = store["text"].splitlines()
    assert lines[:len(jobs.splitlines())] == jobs.splitlines()
    assert "# disabled by lab-service --replace " + start in lines
    assert "# disabled by lab-service --replace " + periodic in lines
    assert lines.count(lab_service.boot_command(root)) == 1
    backups = list((root / ".monitor-backups").glob("*-crontab/crontab.txt"))
    assert [path.read_text() for path in backups] == [original]


@pytest.mark.parametrize("template,expected", [
    ("cd {root} && ./start.sh", True),
    ("bash -c 'cd {root} && ./start.sh >> backend/boot.log 2>&1'", True),
    ("nohup {root}/start.sh >/dev/null 2>&1 &", True),
    ("sleep 30; sh {root}/deploy.sh", True),
    ("cd {root} && start.bat", True),
    ("cd {root}/backend && {root}/backend/.venv/bin/python -m uvicorn app.main:app --port 8000", True),
    ("{root}/backend/.venv/bin/uvicorn app.main:app --app-dir={root}/backend", True),
    ("cd ~/{name}/backend && .venv/bin/uvicorn app.main:app", True),
    ("cd $HOME/{name} && ./dev.bat", True),
    ("{root}/backend/.venv/bin/python {root}/scripts/lab-service.py --project {root} start", True),
    ("{root}/backend/.venv/bin/python {root}/scripts/lab-service.py --project {root} status --json", False),
    ("cd {root} && tar czf /backup/x.tgz .", False),
    ("cp {root}/start.sh /backup/", False),
    ("{root}/scripts/backup.sh", False),
    ("grep uvicorn {root}/backend/server.log", False),
    ("cd /srv/other && uvicorn app.main:app", False),
    ("cd {root}/backend && .venv/bin/uvicorn other:app", False),
    ("/srv/other/start.sh", False),
    ("cd {root}/scripts && ./start.sh", False),
])
def test_only_commands_that_start_this_backend_are_recognized(tmp_path, template, expected):
    root = lab_service.project_dir(tmp_path)
    command = template.format(root=root, name=root.name)
    assert lab_service.starts_backend(command, root, home=root.parent) is expected


def test_systemd_and_autostart_need_a_backend_start_not_just_the_path(tmp_path):
    root = lab_service.project_dir(tmp_path / "DCIM-204")
    home = root.parent
    system = tmp_path / "system"
    user = home / ".config" / "systemd" / "user"
    autostart = home / ".config" / "autostart"
    for directory in (system, user, autostart):
        directory.mkdir(parents=True)
    (system / "lab-manager.service").write_text(
        f"[Service]\nWorkingDirectory={root}/backend\nExecStart={root}/backend/.venv/bin/uvicorn app.main:app\n")
    (system / "lab-backup.service").write_text(
        f"[Service]\nWorkingDirectory={root}\nExecStart=/usr/bin/tar czf /backup/dcim.tgz {root}\n")
    (user / "lab.service").write_text("[Service]\nExecStart=-/bin/sh -c '%h/DCIM-204/start.sh'\n")
    (user / "viewer.service").write_text(f"[Service]\nExecStart=/usr/bin/less {root}/backend/server.log\n")
    (autostart / "lab.desktop").write_text(f"[Desktop Entry]\nPath={root}\nExec=./start.sh\n")
    (autostart / "docs.desktop").write_text(f"[Desktop Entry]\nExec=xdg-open {root}/docs/vm-runbook.md\n")
    assert lab_service.scan_other_boot(root, home=home, system_units=system) == [
        "systemd unit lab-manager.service starts this project's backend",
        "user systemd unit lab.service starts this project's backend",
        "autostart entry lab.desktop starts this project's backend",
    ]


def test_remove_boot_keeps_unrelated_lines(tmp_path, monkeypatch):
    kept = "0 * * * * /usr/bin/true\n"
    monkeypatch.setattr(lab_service, "read_crontab", lambda: kept + lab_service.boot_command(tmp_path) + "\n")
    written = {}
    monkeypatch.setattr(lab_service, "write_crontab", lambda text: written.__setitem__("text", text))
    assert lab_service.cmd_remove_boot(tmp_path) == 0
    assert lab_service.MANAGED_MARK not in written["text"]
    assert "/usr/bin/true" in written["text"]
