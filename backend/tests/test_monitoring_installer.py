"""Exercise the installer transaction with real temporary Git repositories.

Service control and the network fetch are substituted; production is never touched.
"""
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

spec = importlib.util.spec_from_file_location("monitoring_installer", Path(__file__).resolve().parents[2] / "scripts" / "install-monitoring.py")
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
    (upstream / ".gitignore").write_text(".env\nbackend/*.db\nbackend/*.json\nbackend/.venv/\n.monitor-backups/\n.barcode-install.lock\n")
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
    monkeypatch.setattr(installer, "verify_monitoring", lambda *args, **kwargs: None)
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
    backups = list((target / ".monitor-backups").iterdir())
    assert len(backups) == 1
    assert (backups[0] / "runtime" / "backend" / "lab_manager.db").read_bytes() == b"existing database"
    assert events == ["preflight", "stop", "start"]


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


@pytest.fixture
def diverged_vm(deployment):
    target, commit, old, events = deployment
    git(target, "config", "user.email", "test@example.invalid")
    git(target, "config", "user.name", "Installer Test")
    (target / "backend" / "app" / "scan_update.py").write_text("# existing VM feature\n")
    git(target, "add", "backend/app/scan_update.py")
    git(target, "commit", "-m", "VM barcode update on another branch")
    vm_commit = git(target, "rev-parse", "HEAD")
    return target, commit, vm_commit, events


def test_diverged_vm_stops_before_preflight_or_service_changes(diverged_vm):
    target, commit, vm_commit, events = diverged_vm
    with pytest.raises(RuntimeError, match="does not include the current VM commit " + vm_commit):
        installer.install(target, commit)
    assert git(target, "rev-parse", "HEAD") == vm_commit
    assert (target / "backend" / "app" / "scan_update.py").read_text() == "# existing VM feature\n"
    assert (target / "lab-twin" / "lab-data.json").read_text() == '{"source":"live edits"}'
    assert not (target / ".monitor-backups").exists()
    assert events == []


def test_integrated_release_fast_forwards_vm_and_preserves_both_features(diverged_vm):
    target, commit, vm_commit, events = diverged_vm
    upstream = target.parent / "upstream"
    git(upstream, "fetch", str(target), vm_commit)
    git(upstream, "merge", "--no-edit", vm_commit)
    release = git(upstream, "rev-parse", "HEAD")
    installer.install(target, release)
    assert git(target, "rev-parse", "HEAD") == release
    git(target, "merge-base", "--is-ancestor", vm_commit, release)
    git(target, "merge-base", "--is-ancestor", commit, release)
    assert (target / "backend" / "app" / "scan_update.py").read_text() == "# existing VM feature\n"
    assert (target / "backend" / "app" / "main.py").read_text() == "# barcode backend\n"
    assert (target / "lab-twin" / "lab-data.json").read_text() == '{"source":"live edits"}'
    assert (target / "backend" / "lab_manager.db").read_bytes() == b"existing database"
    assert events == ["preflight", "stop", "start"]


def test_monitor_health_failure_rolls_back_before_reporting_success(deployment, monkeypatch):
    target, commit, old, events = deployment
    def fail(*args):
        raise RuntimeError("Monitoring health check failed")
    monkeypatch.setattr(installer, "verify_monitoring", fail)
    with pytest.raises(RuntimeError, match="Monitoring health"):
        installer.install(target, commit)
    assert git(target, "rev-parse", "HEAD") == old
    assert (target / "backend" / "lab_manager.db").read_bytes() == b"existing database"
    assert (target / "lab-twin" / "lab-data.json").read_text() == '{"source":"live edits"}'
    assert events == ["preflight", "stop", "start", "terminate child", "start"]


def test_failed_preflight_keeps_live_application_running(deployment, monkeypatch):
    target, commit, old, events = deployment
    def fail(*args):
        raise RuntimeError("ICMP unavailable")
    monkeypatch.setattr(installer, "smoke_test", fail)
    with pytest.raises(RuntimeError, match="ICMP unavailable"):
        installer.install(target, commit)
    assert git(target, "rev-parse", "HEAD") == old
    assert (target / "backend" / "version.txt").read_text() == "deployed-old\n"
    assert events == []


def test_health_check_uses_existing_python_without_password_in_arguments(tmp_path, monkeypatch):
    seen = []
    def output(args, **kwargs):
        seen.append((args, kwargs))
        return '{"service":"scheduled","timezone":"Asia/Jerusalem","last_started_at":"2026-09-28T00:00:00Z"}'
    monkeypatch.setattr(installer.subprocess, "check_output", output)
    interpreter = tmp_path / "backend/.venv/bin/python"
    installer.verify_monitoring(tmp_path, interpreter)
    assert seen[0][0] == [str(interpreter), "-c", installer.MONITOR_HEALTH]
    assert seen[0][1]["cwd"] == tmp_path / "backend"


@pytest.mark.parametrize("state,message", [
    ('{"service":"disabled","timezone":"Asia/Jerusalem"}', "PING_MONITOR_ENABLED"),
    ('{"service":"scheduled","timezone":"UTC"}', "PING_MONITOR_TIMEZONE"),
])
def test_wrong_monitor_configuration_is_not_reported_as_success(tmp_path, monkeypatch, state, message):
    monkeypatch.setattr(installer.subprocess, "check_output", lambda *args, **kwargs: state)
    with pytest.raises(RuntimeError, match=message):
        installer.verify_monitoring(tmp_path, tmp_path / "python")


LOCAL_LOCK = b'{"version":"local", "preserve":"exact bytes"}\r\n'


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


def test_stuck_backend_can_be_finished_only_after_project_recheck(tmp_path, monkeypatch):
    signals, checks = [], []
    monkeypatch.setattr(installer.signal, "SIGKILL", 9, raising=False)
    monkeypatch.setattr(installer.time, "sleep", lambda delay: None)
    monkeypatch.setattr(installer, "active_process", lambda pid: None if 9 in signals else "original")
    monkeypatch.setattr(installer.os, "kill", lambda pid, sig: signals.append(sig))
    monkeypatch.setattr(installer, "service_pids", lambda root: checks.append(root) or [12345])
    installer.stop_existing(12345, force=True, root=tmp_path)
    assert signals == [installer.signal.SIGTERM, 9]
    assert checks == [tmp_path]


def test_force_option_cannot_stop_a_process_outside_this_project(tmp_path, monkeypatch):
    signals = []
    monkeypatch.setattr(installer.signal, "SIGKILL", 9, raising=False)
    monkeypatch.setattr(installer.time, "sleep", lambda delay: None)
    monkeypatch.setattr(installer, "active_process", lambda pid: "original")
    monkeypatch.setattr(installer.os, "kill", lambda pid, sig: signals.append(sig))
    monkeypatch.setattr(installer, "service_pids", lambda root: [])
    with pytest.raises(RuntimeError, match="no longer matches"):
        installer.stop_existing(12345, force=True, root=tmp_path)
    assert signals == [installer.signal.SIGTERM]


def test_force_option_cannot_kill_a_pid_reused_during_project_recheck(tmp_path, monkeypatch):
    signals, state = [], {"start": "original"}
    monkeypatch.setattr(installer.signal, "SIGKILL", 9, raising=False)
    monkeypatch.setattr(installer.time, "sleep", lambda delay: None)
    monkeypatch.setattr(installer, "active_process", lambda pid: state["start"])
    monkeypatch.setattr(installer.os, "kill", lambda pid, sig: signals.append(sig))
    def recheck(root):
        state["start"] = "replacement"
        return [12345]
    monkeypatch.setattr(installer, "service_pids", recheck)
    installer.stop_existing(12345, force=True, root=tmp_path)
    assert signals == [installer.signal.SIGTERM]


def test_unstoppable_backend_still_prevents_update(tmp_path, monkeypatch):
    signals = []
    monkeypatch.setattr(installer.signal, "SIGKILL", 9, raising=False)
    monkeypatch.setattr(installer.time, "sleep", lambda delay: None)
    monkeypatch.setattr(installer, "active_process", lambda pid: "original")
    monkeypatch.setattr(installer.os, "kill", lambda pid, sig: signals.append(sig))
    monkeypatch.setattr(installer, "service_pids", lambda root: [12345])
    with pytest.raises(RuntimeError, match="could not be stopped"):
        installer.stop_existing(12345, force=True, root=tmp_path)
    assert signals == [installer.signal.SIGTERM, 9]


def test_live_snapshot_includes_committed_wal_data_without_uncommitted_writes(tmp_path):
    import sqlite3
    root, backup = tmp_path / "project", tmp_path / "backup"
    (root / "backend").mkdir(parents=True)
    backup.mkdir()
    (root / ".env").write_text("PRIVATE_CONFIGURATION=value\n")
    database = root / "backend" / "lab_manager.db"
    with sqlite3.connect(database) as live:
        live.execute("PRAGMA journal_mode=WAL")
        live.execute("CREATE TABLE equipment (serial TEXT)")
        live.execute("INSERT INTO equipment VALUES ('saved-server')")
        live.commit()
        live.execute("INSERT INTO equipment VALUES ('unfinished-write')")
        installer.snapshot_before_shutdown(root, backup)
        with sqlite3.connect(backup / "before-stop" / "backend" / "lab_manager.db") as snapshot:
            assert snapshot.execute("SELECT serial FROM equipment").fetchall() == [("saved-server",)]
            assert snapshot.execute("PRAGMA quick_check").fetchall() == [("ok",)]
        live.rollback()
    assert (backup / "before-stop" / ".env").read_text() == "PRIVATE_CONFIGURATION=value\n"


def test_failed_live_snapshot_never_signals_or_changes_the_backend(deployment):
    target, commit, old, events = deployment
    # The fixture's database is deliberately not a valid SQLite database.
    with pytest.raises(RuntimeError, match="Live database backup failed"):
        installer.install(target, commit, finish_stuck_shutdown=True)
    assert git(target, "rev-parse", "HEAD") == old
    assert (target / "backend" / "lab_manager.db").read_bytes() == b"existing database"
    assert events == ["preflight"]


def test_locked_live_backup_has_a_deadline_and_does_not_silently_continue(tmp_path, monkeypatch):
    root, backup = tmp_path / "project", tmp_path / "backup"
    (root / "backend").mkdir(parents=True)
    (root / "backend" / "lab_manager.db").touch()
    backup.mkdir()
    ticks = iter([0, 16])
    monkeypatch.setattr(installer.time, "monotonic", lambda: next(ticks))
    class Connection:
        def backup(self, target, **kwargs): kwargs["progress"](5, 1, 1)
        def close(self): pass
    monkeypatch.setattr(installer.sqlite3, "connect", lambda *args, **kwargs: Connection())
    with pytest.raises(RuntimeError, match="backup timed out"):
        installer.snapshot_before_shutdown(root, backup)


def test_force_recovery_takes_snapshot_before_stopping_and_keeps_runtime_data(deployment, monkeypatch):
    import sqlite3
    target, commit, old, events = deployment
    database = target / "backend" / "lab_manager.db"
    database.unlink()
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE equipment (serial TEXT)")
        db.execute("INSERT INTO equipment VALUES ('existing-server')")
    def stop(pid, *, force=False, root=None):
        assert force is True and root == target
        snapshots = list((target / ".monitor-backups").glob("*/before-stop/backend/lab_manager.db"))
        assert len(snapshots) == 1
        with sqlite3.connect(snapshots[0]) as snapshot:
            assert snapshot.execute("SELECT serial FROM equipment").fetchall() == [("existing-server",)]
        events.append("stop")
    monkeypatch.setattr(installer, "stop_existing", stop)
    installer.install(target, commit, finish_stuck_shutdown=True)
    assert git(target, "rev-parse", "HEAD") == commit
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT serial FROM equipment").fetchall() == [("existing-server",)]
    assert events == ["preflight", "stop", "start"]


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
    backups = list((target / ".monitor-backups").glob("*/local-source/frontend/package-lock.json"))
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


def test_account_activation_preserves_credentials_and_private_backup(deployment, monkeypatch):
    target, commit, old, events = deployment
    original = b'LAB_MANAGER_PASSWORD="existing secret"\r\nPDU_PASSWORD="keep this"\r\nACCOUNTS_ENABLED=false\r\nexport ACCOUNTS_ENABLED=false\r\n'
    (target / ".env").write_bytes(original)
    monkeypatch.setattr(installer, "check_account_activation", lambda *args: None)
    seen = []
    monkeypatch.setattr(installer, "verify_monitoring", lambda *args, **kwargs: seen.append(kwargs))
    installer.install(target, commit, enable_accounts=True)
    updated = (target / ".env").read_bytes()
    assert updated.startswith(original.split(b"ACCOUNTS_ENABLED")[0])
    assert updated.count(b"ACCOUNTS_ENABLED=") == 1
    assert updated.endswith(b"ACCOUNTS_ENABLED=true\r\n")
    assert seen == [{"expected_accounts": True}]
    assert list((target / ".monitor-backups").glob("*/runtime/.env"))[0].read_bytes() == original
    assert events == ["preflight", "stop", "start"]


@pytest.mark.parametrize("existing_env", [True, False])
def test_failed_account_activation_restores_previous_login_configuration(deployment, monkeypatch, existing_env):
    target, commit, old, events = deployment
    original = (target / ".env").read_bytes()
    if not existing_env: (target / ".env").unlink()
    monkeypatch.setattr(installer, "check_account_activation", lambda *args: None)
    def fail(*args, **kwargs): raise RuntimeError("Account health failed")
    monkeypatch.setattr(installer, "verify_monitoring", fail)
    with pytest.raises(RuntimeError, match="Account health failed"):
        installer.install(target, commit, enable_accounts=True)
    assert git(target, "rev-parse", "HEAD") == old
    if existing_env: assert (target / ".env").read_bytes() == original
    else: assert not (target / ".env").exists()
    assert (target / "backend/lab_manager.db").read_bytes() == b"existing database"
    assert events == ["preflight", "stop", "start", "terminate child", "start"]


def test_missing_bootstrap_password_aborts_before_stopping_service(deployment, monkeypatch):
    target, commit, old, events = deployment
    def fail(*args): raise RuntimeError("Set the existing LAB_MANAGER_PASSWORD")
    monkeypatch.setattr(installer, "check_account_activation", fail)
    with pytest.raises(RuntimeError, match="LAB_MANAGER_PASSWORD"):
        installer.install(target, commit, enable_accounts=True)
    assert events == []
    assert git(target, "rev-parse", "HEAD") == old


def test_shell_override_cannot_silently_disable_requested_accounts(tmp_path, monkeypatch):
    monkeypatch.setenv("ACCOUNTS_ENABLED", "false")
    with pytest.raises(RuntimeError, match="override prevents activation"):
        installer.check_account_activation(tmp_path, tmp_path / "python")


def test_account_config_change_during_installation_is_not_overwritten(tmp_path):
    saved = tmp_path / "backup/runtime/.env"
    saved.parent.mkdir(parents=True)
    saved.write_bytes(b"ACCOUNTS_ENABLED=false\n")
    (tmp_path / ".env").write_bytes(b"new user settings\n")
    with pytest.raises(RuntimeError, match="changed during installation"):
        installer.enable_account_mode(tmp_path, tmp_path / "backup")
    assert (tmp_path / ".env").read_bytes() == b"new user settings\n"


@pytest.mark.parametrize("mode,fail_http", [("legacy",False), ("accounts",False), ("accounts",True)])
def test_real_health_probe_authenticates_and_cleans_up_temporary_session(tmp_path, mode, fail_http):
    import base64
    import hashlib
    import json
    import os
    import sqlite3
    import sys
    import threading
    import time
    from http.cookies import SimpleCookie
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from app.models import User, UserSession

    database = tmp_path / "health.db"
    engine = create_engine("sqlite:///" + str(database))
    User.__table__.create(engine)
    UserSession.__table__.create(engine)
    with Session(engine) as db:
        db.add(User(id="health-admin",username="admin",name="Lab Admin",role="Admin",password_hash="unused",created_at=time.time()))
        db.commit()
    engine.dispose()
    accepted = []
    password = "test-only-health-password"
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            valid = False
            if mode == "legacy":
                expected = "Basic " + base64.b64encode((":" + password).encode()).decode()
                valid = self.headers.get("Authorization") == expected
            else:
                cookies = SimpleCookie(self.headers.get("Cookie", ""))
                cookie = cookies.get("dcim_session")
                if cookie:
                    digest = hashlib.sha256(cookie.value.encode()).hexdigest()
                    with sqlite3.connect(database) as db:
                        valid = bool(db.execute("SELECT 1 FROM user_sessions WHERE token_hash=? AND expires_at>?",(digest,time.time())).fetchone())
            if not valid or fail_http:
                self.send_response(503 if fail_http else 401); self.end_headers(); return
            accepted.append(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("ETag", '"test-inventory"')
            self.end_headers()
            self.wfile.write(json.dumps({"version":"test-version"} if self.path.endswith("/version") else {}).encode())
    server = ThreadingHTTPServer(("127.0.0.1",0),Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    environment = {**os.environ,"DATABASE_URL":"sqlite+aiosqlite:///"+str(database),
                   "ACCOUNTS_ENABLED":"true" if mode == "accounts" else "false", "LAB_MANAGER_PASSWORD":password,
                   "EMAIL_ALERTS_ENABLED":"false"}
    try:
        # The child imports the app under whatever load the machine has; only a real hang should fail here.
        result = subprocess.run([sys.executable,"-c",installer.READY_HEALTH],cwd=Path(__file__).resolve().parents[1],env=environment,
            input=json.dumps({"port":server.server_port,"expected_version":"test-version","inventory":True,"expected_accounts":mode=="accounts"}),
            capture_output=True,text=True,timeout=120)
        assert result.returncode == (1 if fail_http else 0), result.stderr
        if not fail_http:
            assert json.loads(result.stdout)["accounts_enabled"] == (mode=="accounts")
            assert accepted == ["/api/version","/api/rack-items"]
        assert password not in result.stdout + result.stderr
        with sqlite3.connect(database) as db:
            assert db.execute("SELECT count(*) FROM user_sessions").fetchone()[0] == 0
            assert db.execute("SELECT username FROM users").fetchone()[0] == "admin"
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)


# ---------------------------------------------------------------- backend requirements (pip)
# Security review M6/M7/M8. pip and the venv queries are simulated through the installer's own
# `subprocess` reference; git still runs for real. No test reaches a network.

SAVED_PROXY = "http://proxy.example.invalid:3128"
PIP_SECRET = "hunter2-test-only-secret"
ASYNCSSH_WHEEL = "asyncssh-2.17.0-py3-none-any.whl"


class FakePipProcess:
    def __init__(self, fake, argv, kwargs):
        self.fake, self.argv, self.kwargs = fake, argv, kwargs
        self.pid, self.returncode, self.killed = 4321, None, False
        self.code, self.output, self.hangs = fake.answer(argv, kwargs)

    def communicate(self, timeout=None):
        if self.hangs and not self.killed:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        self.returncode = self.code if not self.killed else -9
        return self.output, None

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = -9 if self.killed else self.code
        return self.returncode

    def kill(self):
        self.fake.events.append("pip killed")
        self.killed = True

    def poll(self):
        return self.returncode


class FakePip:
    """Stands in for the installer's `subprocess` module: answers the venv's pip and package queries."""

    def __init__(self, events):
        self.events, self.calls = events, []
        self.packages = {"fastapi": "0.115.5", "pip": "24.0", "cryptography": "43.0.3"}
        self.status = {"missing": ["asyncssh==2.17.0"], "conflicts": [], "unsupported": []}
        self.satisfied = False
        self.downloads = [ASYNCSSH_WHEEL, "cryptography-43.0.3-cp39-abi3-manylinux_2_28_x86_64.whl"]
        self.download_code, self.download_output, self.download_hangs = 0, "", False
        self.add_code = 0

    def __getattr__(self, name):
        return getattr(subprocess, name)

    def run(self, argv, **kwargs):
        if argv[0] == "git":
            return subprocess.run(argv, **kwargs)
        assert argv[1:3] == ["-I", "-c"], argv
        self.calls.append((list(argv), kwargs))
        data = self.packages if argv[3] == installer.VENV_PACKAGES else self.status
        return subprocess.CompletedProcess(argv, 0, json.dumps(data), "")

    def Popen(self, argv, **kwargs):
        assert argv[1:4] == ["-I", "-m", "pip"], argv
        self.calls.append((list(argv), kwargs))
        return FakePipProcess(self, argv, kwargs)

    def answer(self, argv, kwargs):
        args = argv[4:]
        if args[0] == "download":
            self.events.append("pip download")
            folder = Path(args[args.index("-d") + 1])
            folder.mkdir(parents=True, exist_ok=True)
            if self.download_code == 0 and not self.download_hangs:
                for name in self.downloads:
                    (folder / name).write_bytes(b"wheel")
            return self.download_code, self.download_output, self.download_hangs
        if "--no-deps" in args:
            self.events.append("pip add")
            if self.add_code == 0:
                for wheel in (Path(item).name for item in args if item.endswith(".whl")):
                    name, version = wheel.split("-")[:2]
                    self.packages[name] = version
                self.satisfied = True
            return self.add_code, "", False
        assert "--no-index" in args and "-r" in args, args
        self.events.append("pip check")
        return (0, "", False) if self.satisfied else (1, "ERROR: No matching distribution found for asyncssh\n", False)

    def pip_calls(self, kind):
        found = []
        for argv, kwargs in self.calls:
            if argv[1:4] != ["-I", "-m", "pip"]:
                continue
            args = argv[4:]
            name = "download" if args[0] == "download" else "add" if "--no-deps" in args else "check"
            if name == kind:
                found.append((argv, kwargs))
        return found


@pytest.fixture
def pip_release(deployment, monkeypatch):
    target, commit, old, events = deployment
    upstream = target.parent / "upstream"
    (upstream / "backend" / "requirements.txt").write_text("fastapi==0.115.5\nasyncssh==2.17.0\n")
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "backend requirements")
    release = git(upstream, "rev-parse", "HEAD")
    for name in installer.PIP_NETWORK_VARIABLES + ("PIP_CERT", "PIP_INDEX_URL", "REQUESTS_CA_BUNDLE"):
        monkeypatch.delenv(name, raising=False)
    fake = FakePip(events)
    monkeypatch.setattr(installer, "subprocess", fake)
    return target, release, old, events, fake


def save_cron_settings(target, environment):
    folder = target / ".monitor-backups" / "auto-update"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "state.json").write_text(json.dumps({"branch": "x", "environment": environment}))


def only_backup(target):
    backups = [path for path in (target / ".monitor-backups").iterdir() if path.name != "auto-update"]
    assert len(backups) == 1
    return backups[0]


def test_release_without_requirements_file_leaves_packages_alone(deployment, capsys):
    target, commit, old, events = deployment
    installer.install(target, commit)
    assert "no backend/requirements.txt" in capsys.readouterr().out
    assert events == ["preflight", "stop", "start"]


def test_satisfied_requirements_are_checked_locally_and_nothing_is_downloaded(pip_release, capsys):
    target, release, old, events, fake = pip_release
    fake.satisfied = True
    installer.install(target, release)
    assert events == ["pip check", "preflight", "stop", "start"]
    assert git(target, "rev-parse", "HEAD") == release
    [(argv, kwargs)] = fake.pip_calls("check")
    backup = only_backup(target)
    requirements = backup / "source" / "backend" / "requirements.txt"
    python = str(target.resolve() / "backend" / ".venv" / "bin" / "python")
    assert argv == [python, "-I", "-m", "pip", "install", "--isolated", "--disable-pip-version-check", "--no-input",
                    "-q", "--no-index", "-r", str(requirements)]
    assert requirements.read_text() == "fastapi==0.115.5\nasyncssh==2.17.0\n"
    assert kwargs["env"] is None and kwargs["cwd"] == str(backup) and kwargs["start_new_session"] is True
    assert kwargs["stdin"] == subprocess.DEVNULL and kwargs["stderr"] == subprocess.STDOUT
    assert fake.pip_calls("download") == [] and not (backup / installer.PACKAGES_BEFORE).exists()
    assert "already match backend/requirements.txt" in capsys.readouterr().out


def test_missing_package_is_added_from_fixed_index_with_saved_proxy_only_in_pips_environment(pip_release, tmp_path, capsys):
    target, release, old, events, fake = pip_release
    cafile = tmp_path / "corporate-ca.pem"
    cafile.write_text("test CA bundle")
    save_cron_settings(target, {"https_proxy": SAVED_PROXY, "no_proxy": "localhost,127.0.0.1", "PATH": "/saved/bin",
                                "SSL_CERT_FILE": str(cafile),
                                "HTTP_PROXY": "http://user:" + PIP_SECRET + "@proxy.example.invalid:8080",
                                "LAB_MANAGER_PASSWORD": PIP_SECRET})
    installer.install(target, release)
    assert events == ["pip check", "pip download", "pip add", "pip check", "preflight", "stop", "start"]
    assert git(target, "rev-parse", "HEAD") == release
    backup = only_backup(target)
    constraints = backup / installer.PACKAGES_BEFORE
    assert constraints.read_text() == "cryptography==43.0.3\nfastapi==0.115.5\npip==24.0\n"
    [(argv, kwargs)] = fake.pip_calls("download")
    wheels = backup / installer.PIP_WHEELS
    assert argv[4:] == ["download", "--isolated", "--disable-pip-version-check", "--no-input", "-q", "--only-binary=:all:",
                        "--index-url", "https://pypi.org/simple", "-c", str(constraints), "-d", str(wheels),
                        "--cert", str(cafile), "asyncssh==2.17.0"]
    assert not any(item.startswith(("--proxy", "--trusted-host", "--extra-index-url")) for item in argv)
    env = kwargs["env"]
    assert env["https_proxy"] == SAVED_PROXY and env["no_proxy"] == "localhost,127.0.0.1"
    assert "HTTP_PROXY" not in env  # a saved value that may carry credentials is never used
    assert env.get("LAB_MANAGER_PASSWORD") == os.environ.get("LAB_MANAGER_PASSWORD")  # never from the state file
    assert env.get("PATH") == os.environ.get("PATH")
    [(argv, kwargs)] = fake.pip_calls("add")
    assert argv[4:] == ["install", "--isolated", "--disable-pip-version-check", "--no-input", "-q", "--no-index", "--no-deps",
                        "--only-binary=:all:", str(wheels / ASYNCSSH_WHEEL)]  # cryptography 43.0.3 is already installed
    assert kwargs["env"] is None
    for call_argv, call_kwargs in fake.pip_calls("check"):
        assert call_kwargs["env"] is None
    assert "https_proxy" not in os.environ  # the backend never sees the proxy
    assert fake.packages["asyncssh"] == "2.17.0" and fake.packages["cryptography"] == "43.0.3"
    assert not wheels.exists()  # downloaded wheels are not kept in the backup
    out = capsys.readouterr().out
    assert "Backend Python packages added: asyncssh 2.17.0." in out
    assert "Python packages added: asyncssh (earlier package list: " + str(constraints) + ")" in out


def test_time_limits_are_applied_to_every_pip_step(pip_release, monkeypatch):
    target, release, old, events, fake = pip_release
    seen = []
    original = FakePipProcess.communicate
    def communicate(self, timeout=None):
        seen.append((self.argv[4], "--no-deps" in self.argv, timeout))
        return original(self, timeout)
    monkeypatch.setattr(FakePipProcess, "communicate", communicate)
    installer.install(target, release)
    assert seen == [("install", False, installer.PIP_CHECK_TIMEOUT), ("download", False, 600),
                    ("install", True, installer.PIP_INSTALL_TIMEOUT), ("install", False, installer.PIP_CHECK_TIMEOUT)]


def test_dry_run_guard_refuses_any_version_change_and_the_release_continues(pip_release, capsys):
    target, release, old, events, fake = pip_release
    fake.downloads = [ASYNCSSH_WHEEL, "cryptography-44.0.0-cp39-abi3-manylinux_2_28_x86_64.whl"]
    installer.install(target, release)
    assert events == ["pip check", "pip download", "preflight", "stop", "start"]
    assert git(target, "rev-parse", "HEAD") == release
    assert "asyncssh" not in fake.packages and fake.packages["cryptography"] == "43.0.3"
    out = capsys.readouterr().out
    assert "WARNING: backend Python packages were not added: the dry run would change installed packages " \
           "(cryptography 43.0.3 -> 44.0.0); nothing was installed." in out
    assert "The update continues" in out


@pytest.mark.parametrize("name", ["evil.tar.gz", "not-a-wheel.whl"])
def test_dry_run_guard_refuses_unexpected_downloads(pip_release, capsys, name):
    target, release, old, events, fake = pip_release
    fake.downloads = [ASYNCSSH_WHEEL, name]
    installer.install(target, release)
    assert "pip add" not in events and events[-3:] == ["preflight", "stop", "start"]
    assert "unexpected file" in capsys.readouterr().out


def test_failed_download_is_only_a_warning_and_hides_credentials(pip_release, capsys):
    target, release, old, events, fake = pip_release
    fake.download_code = 1
    fake.download_output = ("Looking in indexes: https://deploy:" + PIP_SECRET + "@pypi.example.invalid/simple\n"
                            "ERROR: Could not find a version that satisfies the requirement asyncssh==2.17.0\n")
    installer.install(target, release)
    assert events == ["pip check", "pip download", "preflight", "stop", "start"]
    assert git(target, "rev-parse", "HEAD") == release
    out = capsys.readouterr().out
    assert "WARNING: backend Python packages were not added: the download failed (pip exit 1)" in out
    assert "asyncssh==2.17.0" in out and "https://***@pypi.example.invalid" in out
    assert PIP_SECRET not in out
    assert PIP_SECRET not in (only_backup(target) / installer.PIP_LOG).read_text()


def test_download_time_limit_stops_pips_process_group_and_the_release_continues(pip_release, monkeypatch, capsys):
    target, release, old, events, fake = pip_release
    fake.download_hangs = True
    signals = []
    monkeypatch.setattr(installer.signal, "SIGKILL", 9, raising=False)
    monkeypatch.setattr(installer.os, "killpg", lambda pid, number: signals.append((pid, number)), raising=False)
    monkeypatch.setattr(installer, "exited_unreaped", lambda pid: True)
    installer.install(target, release)
    assert signals == [(4321, installer.signal.SIGTERM), (4321, 9)]
    assert events == ["pip check", "pip download", "preflight", "stop", "start"]
    out = capsys.readouterr().out
    assert "the download did not finish within 10 minutes" in out
    assert "stopped after 600 seconds" in (only_backup(target) / installer.PIP_LOG).read_text()


def test_failed_local_add_is_only_a_warning(pip_release, capsys):
    target, release, old, events, fake = pip_release
    fake.add_code = 1
    installer.install(target, release)
    assert events == ["pip check", "pip download", "pip add", "preflight", "stop", "start"]
    assert "adding the downloaded packages failed (pip exit 1)" in capsys.readouterr().out


def test_version_conflicts_are_reported_but_never_changed(pip_release, capsys):
    target, release, old, events, fake = pip_release
    fake.status = {"missing": [], "conflicts": [{"name": "fastapi", "installed": "0.115.5", "wanted": "==0.116.0"}],
                   "unsupported": ["-r https://reader:" + PIP_SECRET + "@example.invalid/extra.txt"]}
    installer.install(target, release)
    assert events == ["pip check", "preflight", "stop", "start"]
    out = capsys.readouterr().out
    assert "these stay as they are: fastapi 0.115.5 (release asks ==0.116.0)" in out
    assert "not plain packages are skipped" in out and PIP_SECRET not in out


def test_unreadable_venv_is_only_a_warning(pip_release, monkeypatch, capsys):
    target, release, old, events, fake = pip_release
    def broken(argv, **kwargs):
        if argv[0] == "git":
            return subprocess.run(argv, **kwargs)
        return subprocess.CompletedProcess(argv, 1, "", "Traceback")
    monkeypatch.setattr(fake, "run", broken)
    installer.install(target, release)
    assert events == ["pip check", "preflight", "stop", "start"]
    assert "cannot be read" in capsys.readouterr().out


def test_termination_signal_stops_pips_process_group_first(monkeypatch):
    stopped = []
    monkeypatch.setattr(installer, "stop_process_group", lambda process: stopped.append(process))
    before = installer.signal.getsignal(installer.signal.SIGTERM)
    process = object()
    with installer.stop_on_termination(process):
        handler = installer.signal.getsignal(installer.signal.SIGTERM)
        with pytest.raises(SystemExit):
            handler(installer.signal.SIGTERM, None)
    assert stopped == [process]
    assert installer.signal.getsignal(installer.signal.SIGTERM) == before


def test_pip_environment_prefers_own_settings_and_validates_saved_ones(tmp_path):
    cafile = tmp_path / "ca.pem"
    cafile.write_text("CA")
    save_cron_settings(tmp_path, {"https_proxy": "http://saved.example.invalid:1", "NO_PROXY": "lab.example.invalid",
                                  "all_proxy": "http://line\nbreak.example.invalid", "GIT_SSL_CAINFO": str(cafile),
                                  "PIP_INDEX_URL": "http://other.example.invalid", "http_proxy": 42})
    env, ca = installer.pip_environment(tmp_path, {"https_proxy": "http://shell.example.invalid:2"})
    assert env["https_proxy"] == "http://shell.example.invalid:2" and env["NO_PROXY"] == "lab.example.invalid"
    assert ca == str(cafile)
    for name in ("all_proxy", "PIP_INDEX_URL", "http_proxy"):
        assert name not in env
    assert installer.pip_environment(tmp_path, {"SSL_CERT_FILE": str(tmp_path / "missing.pem")})[1] is None
    (tmp_path / installer.AUTO_UPDATE_STATE).write_text("not json")
    assert installer.saved_network_settings(tmp_path) == {}
    (tmp_path / installer.AUTO_UPDATE_STATE).write_text('{"environment": ["https_proxy"]}')
    assert installer.saved_network_settings(tmp_path) == {}


def test_secret_masking_covers_urls_and_credential_proxies():
    env = {"HTTPS_PROXY": "deploy:" + PIP_SECRET + "@proxy.example.invalid:8080", "PIP_EXTRA_INDEX_URL": "x"}
    text = ("ProxyError: deploy:" + PIP_SECRET + "@proxy.example.invalid:8080\n"
            "index https://reader:" + PIP_SECRET + "@pypi.example.invalid/simple")
    masked = installer.mask_secrets(text, env)
    assert PIP_SECRET not in masked and "https://***@pypi.example.invalid/simple" in masked


def test_installer_backups_never_copy_the_ssh_key_folder(deployment, monkeypatch):
    import sqlite3
    target, commit, old, events = deployment
    monkeypatch.setattr(installer, "stop_existing", lambda pid, **kwargs: events.append("stop"))
    ssh = target / "backend" / "ssh"
    ssh.mkdir()
    files = {"id_ed25519": b"PRIVATE KEY TEST ONLY", "id_ed25519.pub": b"ssh-ed25519 AAAA dcim-204-20261021-abcdef\n",
             "known_hosts": b'{"server-a": "pinned test key"}',
             "config.json": b'{"default_user": "lab-test-user"}'}
    for name, data in files.items():
        (ssh / name).write_bytes(data)
    (target / "backend" / "lab_manager.db").unlink()
    with sqlite3.connect(target / "backend" / "lab_manager.db") as db:
        db.execute("CREATE TABLE equipment (serial TEXT)")
    installer.install(target, commit, finish_stuck_shutdown=True)  # runtime backup and live snapshot both run
    assert events == ["preflight", "stop", "start"]
    saved = list((target / ".monitor-backups").rglob("*"))
    assert [path for path in saved if path.name == "ssh" or path.name in files] == []
    assert [path for path in saved if path.is_file() and path.read_bytes() in files.values()] == []
    assert list((target / ".monitor-backups").glob("*/before-stop/backend/lab_manager.db"))
    assert {name: (ssh / name).read_bytes() for name in files} == files


def test_package_listing_runs_in_a_real_interpreter(tmp_path):
    packages = installer.venv_packages(sys.executable, tmp_path)
    assert packages["pytest"] == pytest.__version__


def test_real_requirement_status_classifies_lines_without_network(tmp_path):
    requirements = tmp_path / "requirements.txt"
    requirements.write_text("# comment\npytest  # inline comment\nzz-dcim-test-not-installed==0.0.1\npytest==0.0.1\n"
                            "zz-dcim-never ; python_version < '3'\n-r other.txt\n")
    status = installer.venv_python_json(sys.executable, tmp_path, installer.REQUIREMENT_STATUS, str(requirements))
    assert status["missing"] == ["zz-dcim-test-not-installed==0.0.1"]
    assert status["conflicts"] == [{"name": "pytest", "installed": pytest.__version__, "wanted": "==0.0.1"}]
    assert status["unsupported"] == ["-r other.txt"]


def test_real_pip_check_is_local_and_detects_missing_packages(tmp_path):
    pytest.importorskip("pip")
    present, missing = tmp_path / "present.txt", tmp_path / "missing.txt"
    present.write_text("pytest\n")
    missing.write_text("pytest\nzz-dcim-test-not-installed==0.0.1\n")
    check = ["install", *installer.PIP_OPTIONS, "--no-index", "-r"]
    assert installer.run_pip(sys.executable, check + [str(present)], tmp_path, 120)[0] == 0
    code, output = installer.run_pip(sys.executable, check + [str(missing)], tmp_path, 120)
    assert code == 1 and "zz-dcim-test-not-installed" in output
    assert (tmp_path / installer.PIP_LOG).read_text().count("$ pip install --isolated") == 2
