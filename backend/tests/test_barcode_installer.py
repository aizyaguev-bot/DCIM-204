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
