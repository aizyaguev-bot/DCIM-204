"""Exercise the installer transaction with real temporary Git repositories.

Service control and the network fetch are substituted; production is never touched.
"""
from contextlib import nullcontext
import importlib.util
from pathlib import Path
import subprocess

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
        result = subprocess.run([sys.executable,"-c",installer.READY_HEALTH],cwd=Path(__file__).resolve().parents[1],env=environment,
            input=json.dumps({"port":server.server_port,"expected_version":"test-version","inventory":True,"expected_accounts":mode=="accounts"}),
            capture_output=True,text=True,timeout=15)
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
