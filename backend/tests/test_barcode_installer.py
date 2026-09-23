"""Exercise the installer transaction with real temporary Git repositories.

Service control and the network fetch are substituted; production is never touched.
"""
from contextlib import nullcontext
import importlib.util
from pathlib import Path
import subprocess

import pytest

spec = importlib.util.spec_from_file_location("barcode_installer", Path(__file__).resolve().parents[2] / "scripts" / "install-barcode.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def git(root, *args):
    return subprocess.check_output(["git", "-c", "commit.gpgsign=false", "-C", str(root), *args], text=True).strip()


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    git(upstream, "init", "-b", "master")
    git(upstream, "config", "user.email", "test@example.invalid")
    git(upstream, "config", "user.name", "Installer Test")
    (upstream / "backend" / "app").mkdir(parents=True)
    (upstream / "lab-twin").mkdir()
    (upstream / "frontend").mkdir()
    (upstream / "frontend" / "package-lock.json").write_text('{"version":"original"}\n')
    (upstream / ".gitignore").write_text(".env\nbackend/*.db\nbackend/*.json\nbackend/.venv/\n.barcode-backups/\n.barcode-install.lock\n")
    (upstream / "backend" / "app" / "main.py").write_text("# original backend\n")
    (upstream / "backend" / "version.txt").write_text("old-version\n")
    (upstream / "lab-twin" / "lab-data.json").write_text('{"source":"old seed"}')
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "baseline")
    old = git(upstream, "rev-parse", "HEAD")
    target = tmp_path / "target"
    subprocess.run(["git", "clone", str(upstream), str(target)], check=True, capture_output=True)
    (upstream / "backend" / "app" / "main.py").write_text("# barcode backend\n")
    (upstream / "frontend" / "package-lock.json").write_text('{"version":"reviewed"}\n')
    (upstream / "lab-twin" / "lab-data.json").write_text('{"source":"new seed"}')
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "feature")
    commit = git(upstream, "rev-parse", "HEAD")
    (target / "backend" / ".venv" / "bin").mkdir(parents=True)
    (target / "backend" / ".venv" / "bin" / "python").write_text("fake interpreter")
    (target / ".env").write_text("example configuration")
    (target / "backend" / "lab_manager.db").write_bytes(b"existing database")
    (target / "backend" / "rack_items.json").write_text('{"Rack-01":[{"id":"existing"}]}')
    (target / "lab-twin" / "lab-data.json").write_text('{"source":"live edits"}')
    (target / "backend" / "version.txt").write_text("deployed-old\n")
    events = []
    original_git = installer.git
    def local_git(root, *args):
        if args[0] == "fetch":
            return original_git(root, "fetch", str(upstream), args[-1])
        return original_git(root, *args)
    monkeypatch.setattr(installer, "git", local_git)
    monkeypatch.setattr(installer, "install_lock", lambda root: nullcontext())
    monkeypatch.setattr(installer, "service_pids", lambda root: [12345])
    monkeypatch.setattr(installer, "port_occupied", lambda: False)
    monkeypatch.setattr(installer, "stop_existing", lambda pid: events.append("stop"))
    monkeypatch.setattr(installer, "smoke_test", lambda *args: events.append("preflight"))
    class Process:
        def poll(self): return None
        def terminate(self): events.append("terminate child")
        def wait(self, **kwargs): return 0
    def start(*args):
        events.append("start")
        return Process()
    monkeypatch.setattr(installer, "start", start)
    monkeypatch.setattr(installer, "wait_ready", lambda *args, **kwargs: None)
    return target, commit, old, events


def test_installer_preserves_inventory_env_and_live_twin(deployment):
    target, commit, old, events = deployment
    installer.install(target, commit)
    assert git(target, "rev-parse", "HEAD") == commit
    assert (target / "backend" / "app" / "main.py").read_text() == "# barcode backend\n"
    assert (target / "lab-twin" / "lab-data.json").read_text() == '{"source":"live edits"}'
    assert (target / ".env").read_text() == "example configuration"
    assert (target / "backend" / "lab_manager.db").read_bytes() == b"existing database"
    assert (target / "backend" / "rack_items.json").read_text() == '{"Rack-01":[{"id":"existing"}]}'
    assert (target / "backend" / "version.txt").read_text().strip() == commit[:7]
    backups = list((target / ".barcode-backups").iterdir())
    assert len(backups) == 1
    assert (backups[0] / "runtime" / "backend" / "lab_manager.db").read_bytes() == b"existing database"
    assert events == ["preflight", "stop", "start"]


@pytest.mark.parametrize("state,expected", [("S", "123456"), ("R", "123456"), ("Z", None), ("X", None)])
def test_process_state_distinguishes_running_from_unreaped_zombie(tmp_path, state, expected):
    process = tmp_path / "12345"
    process.mkdir()
    fields = [state] + ["0"] * 18 + ["123456"]
    (process / "stat").write_text("12345 (python ) worker) " + " ".join(fields))
    assert installer.active_process(12345, tmp_path) == expected
    assert installer.active_process(99999, tmp_path) is None


def test_unreadable_process_state_does_not_count_as_stopped(tmp_path):
    process = tmp_path / "12345"
    process.mkdir()
    (process / "stat").write_text("invalid process status")
    with pytest.raises(RuntimeError, match="process state"):
        installer.active_process(12345, tmp_path)


@pytest.mark.parametrize("final_state", [None, "different-process-start-time"])
def test_shutdown_completes_when_process_exits_or_pid_is_reused(monkeypatch, final_state):
    states = iter(["original-start-time", "original-start-time", final_state])
    signals = []
    monkeypatch.setattr(installer, "active_process", lambda pid: next(states))
    monkeypatch.setattr(installer.os, "kill", lambda pid, sig: signals.append((pid, sig)))
    monkeypatch.setattr(installer.time, "sleep", lambda delay: None)
    installer.stop_existing(12345)
    assert signals == [(12345, installer.signal.SIGTERM)]


def test_already_stopped_backend_is_not_signalled(monkeypatch):
    monkeypatch.setattr(installer, "active_process", lambda pid: None)
    monkeypatch.setattr(installer.os, "kill", lambda *args: pytest.fail("Stopped process must not be signalled"))
    installer.stop_existing(12345)


def test_backend_exit_before_signal_is_success(monkeypatch):
    monkeypatch.setattr(installer, "active_process", lambda pid: "original-start-time")
    def exited(*args):
        raise ProcessLookupError()
    monkeypatch.setattr(installer.os, "kill", exited)
    installer.stop_existing(12345)


def test_running_backend_is_not_force_killed_on_timeout(monkeypatch):
    signals = []
    monkeypatch.setattr(installer, "active_process", lambda pid: "original-start-time")
    monkeypatch.setattr(installer.os, "kill", lambda pid, sig: signals.append(sig))
    monkeypatch.setattr(installer.time, "sleep", lambda delay: None)
    with pytest.raises(RuntimeError, match="has not stopped"):
        installer.stop_existing(12345)
    assert signals == [installer.signal.SIGTERM]


@pytest.mark.parametrize("running", [True, False])
def test_shutdown_failure_recovers_only_after_old_process_exits(deployment, monkeypatch, running):
    target, commit, old, events = deployment
    def stop(pid):
        events.append("stop")
        raise RuntimeError("shutdown error")
    monkeypatch.setattr(installer, "stop_existing", stop)
    monkeypatch.setattr(installer, "active_process", lambda pid: "original-start-time" if running else None)
    with pytest.raises(RuntimeError, match="shutdown error"):
        installer.install(target, commit)
    assert git(target, "rev-parse", "HEAD") == old
    assert (target / "backend" / "version.txt").read_text() == "deployed-old\n"
    assert (target / "backend" / "rack_items.json").read_text() == '{"Rack-01":[{"id":"existing"}]}'
    assert events == ["preflight", "stop"] + ([] if running else ["start"])


def test_port_still_occupied_prevents_update_and_duplicate_start(deployment, monkeypatch):
    target, commit, old, events = deployment
    monkeypatch.setattr(installer, "port_occupied", lambda: True)
    with pytest.raises(RuntimeError, match="still occupied"):
        installer.install(target, commit)
    assert git(target, "rev-parse", "HEAD") == old
    assert (target / "lab-twin" / "lab-data.json").read_text() == '{"source":"live edits"}'
    assert events == ["preflight", "stop"]


def test_failed_startup_restores_previous_commit_and_version(deployment, monkeypatch):
    target, commit, old, events = deployment
    def readiness(*args, **kwargs):
        if kwargs.get("expected_version"):
            raise RuntimeError("Simulated startup failure")
    monkeypatch.setattr(installer, "wait_ready", readiness)
    with pytest.raises(RuntimeError, match="startup failure"):
        installer.install(target, commit)
    assert git(target, "rev-parse", "HEAD") == old
    assert (target / "backend" / "app" / "main.py").read_text() == "# original backend\n"
    assert (target / "backend" / "version.txt").read_text() == "deployed-old\n"
    assert (target / "lab-twin" / "lab-data.json").read_text() == '{"source":"live edits"}'
    assert (target / "backend" / "lab_manager.db").read_bytes() == b"existing database"
    assert events == ["preflight", "stop", "start", "terminate child", "start"]


def test_local_source_edits_abort_before_stopping_service(deployment):
    target, commit, old, events = deployment
    (target / "backend" / "app" / "main.py").write_text("# user work\n")
    with pytest.raises(RuntimeError, match="Local source edits"):
        installer.install(target, commit)
    assert git(target, "rev-parse", "HEAD") == old
    assert (target / "backend" / "app" / "main.py").read_text() == "# user work\n"
    assert events == []


LOCAL_LOCK = b'{"version":"local", "preserve":"exact bytes"}\r\n'


def test_local_lockfile_requires_explicit_backup_option(deployment):
    target, commit, old, events = deployment
    lock = target / "frontend" / "package-lock.json"
    lock.write_bytes(LOCAL_LOCK)
    with pytest.raises(RuntimeError, match="Local source edits.*frontend/package-lock.json"):
        installer.install(target, commit)
    assert lock.read_bytes() == LOCAL_LOCK
    assert git(target, "rev-parse", "HEAD") == old
    assert events == []


def test_lockfile_backup_installs_reviewed_version_and_preserves_exact_original(deployment):
    target, commit, old, events = deployment
    lock = target / "frontend" / "package-lock.json"
    lock.write_bytes(LOCAL_LOCK)
    installer.install(target, commit, backup_frontend_lock=True)
    assert git(target, "rev-parse", "HEAD") == commit
    assert lock.read_text() == '{"version":"reviewed"}\n'
    backups = list((target / ".barcode-backups").glob("*/local-source/frontend/package-lock.json"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == LOCAL_LOCK
    assert (target / "backend" / "lab_manager.db").read_bytes() == b"existing database"
    assert events == ["preflight", "stop", "start"]


@pytest.mark.parametrize("failure", ["merge", "startup"])
def test_lockfile_edits_restored_if_update_fails(deployment, monkeypatch, failure):
    target, commit, old, events = deployment
    lock = target / "frontend" / "package-lock.json"
    lock.write_bytes(LOCAL_LOCK)
    if failure == "merge":
        original_git = installer.git
        def fail_merge(root, *args):
            if args[0] == "merge":
                raise RuntimeError("Simulated merge failure")
            return original_git(root, *args)
        monkeypatch.setattr(installer, "git", fail_merge)
    else:
        def readiness(*args, **kwargs):
            if kwargs.get("expected_version"):
                raise RuntimeError("Simulated startup failure")
        monkeypatch.setattr(installer, "wait_ready", readiness)
    with pytest.raises(RuntimeError, match="Simulated"):
        installer.install(target, commit, backup_frontend_lock=True)
    assert git(target, "rev-parse", "HEAD") == old
    assert lock.read_bytes() == LOCAL_LOCK
    assert (target / "backend" / "version.txt").read_text() == "deployed-old\n"
    assert (target / "lab-twin" / "lab-data.json").read_text() == '{"source":"live edits"}'
    assert events[-1] == "start"


@pytest.mark.parametrize("conflict", ["other_source", "staged_lock", "deleted_lock"])
def test_backup_option_does_not_allow_other_local_changes(deployment, conflict):
    target, commit, old, events = deployment
    lock = target / "frontend" / "package-lock.json"
    lock.write_bytes(LOCAL_LOCK)
    if conflict == "other_source":
        (target / "backend" / "app" / "main.py").write_text("# user work\n")
        message = "Local source edits"
    elif conflict == "staged_lock":
        git(target, "add", "frontend/package-lock.json")
        message = "staged changes"
    else:
        lock.unlink()
        message = "existing regular"
    with pytest.raises(RuntimeError, match=message):
        installer.install(target, commit, backup_frontend_lock=True)
    assert git(target, "rev-parse", "HEAD") == old
    if conflict != "deleted_lock":
        assert lock.read_bytes() == LOCAL_LOCK
    assert events == []


def test_failed_lockfile_backup_leaves_service_and_source_untouched(deployment, monkeypatch):
    target, commit, old, events = deployment
    lock = target / "frontend" / "package-lock.json"
    lock.write_bytes(LOCAL_LOCK)
    original_copy = installer.shutil.copy2
    def fail_backup(source, destination, *args, **kwargs):
        if "local-source" in Path(destination).parts:
            raise OSError("Simulated backup failure")
        return original_copy(source, destination, *args, **kwargs)
    monkeypatch.setattr(installer.shutil, "copy2", fail_backup)
    with pytest.raises(OSError, match="backup failure"):
        installer.install(target, commit, backup_frontend_lock=True)
    assert git(target, "rev-parse", "HEAD") == old
    assert lock.read_bytes() == LOCAL_LOCK
    assert events == ["preflight"]


def test_new_lockfile_edits_after_backup_are_not_overwritten(deployment, monkeypatch):
    target, commit, old, events = deployment
    lock = target / "frontend" / "package-lock.json"
    lock.write_bytes(LOCAL_LOCK)
    def stop(pid):
        events.append("stop")
        lock.write_bytes(b"new user edits after backup")
    monkeypatch.setattr(installer, "stop_existing", stop)
    with pytest.raises(RuntimeError, match="changed after backup"):
        installer.install(target, commit, backup_frontend_lock=True)
    assert git(target, "rev-parse", "HEAD") == old
    assert lock.read_bytes() == b"new user edits after backup"
    assert events == ["preflight", "stop", "start"]
