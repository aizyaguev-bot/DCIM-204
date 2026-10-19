"""VM auto-update: decisions, installer arguments, crontab handling and secrecy.

No network, no real crontab, no real installer: the script's subprocess module, the
downloads, the locks, the clock and the local backend probe are all substituted.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vm = load("vm_auto_update", "vm-auto-update.py")
lab_service = load("lab_service_for_auto_update", "lab-service.py")

OLD = "a" * 40
NEW = "b" * 40
NEWER = "c" * 40
SECRET = "fake-secret-value-7f3a91"
T0 = datetime(2026, 10, 18, 12, 0, 0, tzinfo=timezone.utc)
BUSY = b"Installation stopped: Another installation is already running\n"


class FakeProcess:
    def __init__(self, fake, argv, kwargs):
        self.fake, self.argv, self.kwargs = fake, argv, kwargs
        self.pid = 4242
        self.returncode = None
        fake.processes[self.pid] = (self.pid, "55555")
        kwargs["stdout"].write(fake.installer_output)
        kwargs["stdout"].flush()

    def wait(self, timeout=None):
        if self.fake.during_wait:
            self.fake.during_wait(self)
        if self.fake.installer_hangs:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        self.fake.processes.pop(self.pid, None)
        self.returncode = self.fake.installer_code
        if self.returncode == 0 and self.fake.installer_moves_head:
            self.fake.head = self.argv[2]
        return self.returncode


class FakeSubprocess:
    """Answers git, crontab, lab-service status/start and runs a pretend installer."""
    PIPE = subprocess.PIPE
    DEVNULL = subprocess.DEVNULL
    STDOUT = subprocess.STDOUT
    TimeoutExpired = subprocess.TimeoutExpired
    CalledProcessError = subprocess.CalledProcessError
    SubprocessError = subprocess.SubprocessError
    CompletedProcess = subprocess.CompletedProcess

    def __init__(self):
        self.calls = []
        self.head = OLD
        self.remote = {"refs/heads/" + vm.DEFAULT_BRANCH: NEW}
        self.ls_remote_stdout = None
        self.ls_remote_error = None
        self.ancestor = False
        self.crontab = None
        self.crontab_writes = 0
        self.crontab_reads = 0
        self.change_on_read = {}
        self.git_version = "git version 2.34.1"
        self.status = {"monitoring": {"accounts_enabled": False}, "inventory": {"tables": {}}}
        self.status_code = 0
        self.restart = (0, "started\n")
        self.installer_code = 0
        self.installer_moves_head = True
        self.installer_hangs = False
        self.installer_output = b"Fetching the reviewed update\nInstalled\n"
        self.get_url = vm.REPOSITORY
        self.processes = {}  # pid -> (process group, start time), as read from /proc
        self.during_wait = None

    def run(self, argv, **kwargs):
        argv = [str(item) for item in argv]
        self.calls.append((argv, kwargs))

        def done(code=0, out="", err=""):
            return subprocess.CompletedProcess(argv, code, out, err)

        if argv[:2] == ["crontab", "-l"]:
            self.crontab_reads += 1
            if self.crontab_reads in self.change_on_read:
                self.crontab = self.change_on_read[self.crontab_reads]
            return done(1, err="no crontab for tester\n") if self.crontab is None else done(out=self.crontab)
        if argv[:2] == ["crontab", "-"]:
            self.crontab = kwargs["input"]
            self.crontab_writes += 1
            return done()
        if argv[:2] == ["git", "--version"]:
            return done(out=self.git_version + "\n")
        if argv[0] == "git" and "--get-url" in argv:
            return done(out=self.get_url + "\n")
        if argv[0] == "git" and "ls-remote" in argv:
            if self.ls_remote_error:
                return done(self.ls_remote_error[0], err=self.ls_remote_error[1])
            if self.ls_remote_stdout is not None:
                return done(out=self.ls_remote_stdout)
            ref = argv[-1]
            return done(out=(self.remote[ref] + "\t" + ref + "\n") if ref in self.remote else "")
        if argv[0] == "git" and argv[3:] == ["rev-parse", "HEAD"]:
            return done(out=self.head + "\n")
        if argv[0] == "git" and argv[3:5] == ["merge-base", "--is-ancestor"]:
            return done(0 if self.ancestor else 1)
        if argv[1].endswith("lab-service.py") and argv[-1] == "start":
            return done(self.restart[0], out=self.restart[1])
        if argv[1].endswith("lab-service.py") and argv[-2:] == ["status", "--json"]:
            return done(self.status_code, out=json.dumps(self.status, indent=2))
        raise AssertionError("unexpected command: " + " ".join(argv))

    def Popen(self, argv, **kwargs):
        argv = [str(item) for item in argv]
        self.calls.append((argv, kwargs))
        return FakeProcess(self, argv, kwargs)

    def commands(self):
        return [argv for argv, _ in self.calls]

    def installers(self):
        return [(argv, kwargs) for argv, kwargs in self.calls
                if argv[0] != "download" and argv[1:2] and argv[1].endswith("install-monitoring.py")]

    def find(self, predicate):
        return [(argv, kwargs) for argv, kwargs in self.calls if predicate(argv)]


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    root = (tmp_path / "DCIM-204").resolve()
    (root / ".git").mkdir(parents=True)
    (root / "backend" / ".venv" / "bin").mkdir(parents=True)
    (root / "backend" / ".venv" / "bin" / "python").write_text("fake interpreter")
    (root / "backend" / "version.txt").write_text("aaaaaaa\n")
    (root / "scripts").mkdir()
    (root / "scripts" / "vm-auto-update.py").write_text("# installed copy\n")
    (root / "scripts" / "lab-service.py").write_text("# installed copy\n")
    for name in list(os.environ):
        if vm.APP_SETTING.fullmatch(name) or vm.network_variable(name) or name in vm.NETWORK_VARIABLES:
            monkeypatch.delenv(name, raising=False)
    fake = FakeSubprocess()
    clock = SimpleNamespace(now=T0)
    backend = SimpleNamespace(answers=[True])
    lock = SimpleNamespace(held=False, status_held=None)
    stops, downloads = [], []

    def answers():
        return backend.answers.pop(0) if len(backend.answers) > 1 else backend.answers[0]

    @contextmanager
    def fake_lock(directory, touch=True):
        if lock.held:
            yield False
            return
        if touch:
            (directory / "run.lock").touch()
        yield True

    def fake_fetch(commit, name, destination, opener):
        downloads.append((commit, name))
        fake.calls.append((["download", name], {}))
        vm.write_private(destination, "# " + name + " for " + commit + "\n")
        return destination

    monkeypatch.setattr(vm, "subprocess", fake)
    monkeypatch.setattr(vm, "utcnow", lambda: clock.now)
    monkeypatch.setattr(vm, "is_linux", lambda: True)
    monkeypatch.setattr(vm, "effective_uid", lambda: 1000)
    monkeypatch.setattr(vm, "owner_uid", lambda root: 1000)
    monkeypatch.setattr(vm, "free_bytes", lambda root: 50 * 1024 ** 3)
    monkeypatch.setattr(vm, "uptime_seconds", lambda: 3600.0)
    monkeypatch.setattr(vm, "backend_answers", answers)
    monkeypatch.setattr(vm, "run_lock", fake_lock)
    monkeypatch.setattr(vm, "lock_held", lambda directory: lock.status_held)
    monkeypatch.setattr(vm, "stop_group", lambda process: stops.append(process.pid) or True)
    monkeypatch.setattr(vm, "read_stat", lambda pid: ("S",) + fake.processes[pid] if pid in fake.processes else None)
    monkeypatch.setattr(vm, "signal", SimpleNamespace(SIGTERM=15, SIGKILL=9))
    monkeypatch.setattr(vm, "pause", lambda seconds: None)
    # Any signal sent by a run is recorded; across runs there must never be one.
    monkeypatch.setattr(vm.os, "killpg", lambda pgid, sig: stops.append(("killpg", pgid, sig)), raising=False)
    monkeypatch.setattr(vm.os, "kill", lambda pid, sig: stops.append(("kill", pid, sig)), raising=False)
    monkeypatch.setattr(vm, "fetch", fake_fetch)
    monkeypatch.setattr(vm, "download_opener", lambda saved: object())
    return SimpleNamespace(root=root, fake=fake, clock=clock, backend=backend, lock=lock, stops=stops,
                           downloads=downloads, directory=root / ".monitor-backups" / "auto-update")


def main(ctx, *args):
    return vm.main(["--project", str(ctx.root), *args])


def state(ctx):
    return json.loads((ctx.directory / "state.json").read_text(encoding="utf-8"))


def attempt_files(ctx):
    return sorted(path.name for path in ctx.directory.iterdir() if vm.ATTEMPT_FILE.fullmatch(path.name) and path.is_file())


def lower(mapping):
    """Environment names compared case-insensitively (Windows upper-cases them)."""
    return {name.lower(): value for name, value in mapping.items()}


def later(ctx, **delta):
    ctx.clock.now = ctx.clock.now + timedelta(**delta)


# ---------------------------------------------------------------- decisions

def test_same_commit_is_quiet_and_writes_state_at_most_hourly(ctx, capsys):
    ctx.fake.head = NEW
    assert main(ctx, "run") == 0
    assert capsys.readouterr() == ("", "")
    first = (ctx.directory / "state.json").read_bytes()
    assert state(ctx)["last_result"] == "up-to-date" and state(ctx)["last_check"] == vm.stamp(T0)
    later(ctx, minutes=10)
    assert main(ctx, "run") == 0
    assert (ctx.directory / "state.json").read_bytes() == first
    later(ctx, minutes=55)
    assert main(ctx, "run") == 0
    assert state(ctx)["last_check"] == vm.stamp(T0 + timedelta(minutes=65))
    assert capsys.readouterr() == ("", "")
    assert ctx.fake.installers() == [] and ctx.downloads == []


def test_commit_already_contained_in_head_installs_nothing(ctx, capsys):
    ctx.fake.ancestor = True
    assert main(ctx, "run") == 0
    assert state(ctx)["last_result"] == "up-to-date"
    assert ctx.fake.installers() == [] and ctx.downloads == []
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("accounts", [False, True])
def test_new_commit_runs_the_commits_installer_with_the_runbook_arguments(ctx, capsys, accounts):
    ctx.fake.status = {"monitoring": {"service": "scheduled", "accounts_enabled": accounts}, "inventory": {}}
    assert main(ctx, "run") == 0
    order = [argv[1] if argv[0] == "download" else argv[-1] for argv in ctx.fake.commands()
             if argv[0] == "download" or argv[1].endswith(("lab-service.py", "install-monitoring.py"))]
    assert order == ["install-monitoring.py", "lab-service.py", "--json", "--finish-stuck-shutdown"]
    (status_argv, status_kwargs), = ctx.fake.find(lambda argv: argv[-2:] == ["status", "--json"])
    (argv, kwargs), = ctx.fake.installers()
    python = str(ctx.root / "backend" / ".venv" / "bin" / "python")
    workspace = Path(argv[1]).parent
    assert status_argv == [python, str(workspace / "lab-service.py"), "--project", str(ctx.root), "status", "--json"]
    expected = [python, str(workspace / "install-monitoring.py"), NEW, "--project", str(ctx.root), "--backup-frontend-lock"]
    expected += ["--enable-accounts"] if accounts else []
    assert argv == expected + ["--finish-stuck-shutdown"]
    assert kwargs["cwd"] == str(ctx.root) and kwargs["start_new_session"] is True
    assert kwargs["stdin"] == subprocess.DEVNULL and kwargs["stderr"] == subprocess.STDOUT
    assert status_kwargs["timeout"] == vm.STATUS_TIMEOUT
    assert not workspace.exists()  # private download folder removed
    saved = state(ctx)
    assert saved["deployed_commit"] == NEW and saved["last_result"] == "installed"
    assert saved["last_install"]["result"] == "installed" and "attempt" not in saved and "failure" not in saved
    log, snapshot = ctx.directory / saved["last_install"]["log"], ctx.directory / saved["last_install"]["log"].replace(".log", "-before.json")
    assert "Installed" in log.read_text() and json.loads(snapshot.read_text()) == ctx.fake.status
    out = capsys.readouterr().out
    assert "installing " + NEW[:12] in out and "installed " + NEW[:12] in out
    assert "accounts_enabled" not in out  # the snapshot is never printed


@pytest.mark.parametrize("data", [
    {"accounts_enabled": True},
    {"monitoring": {"accounts_enabled": "true"}},
    {"monitoring": None, "boot": {"foreign": ['"accounts_enabled": true']}},
    {"monitoring": [{"accounts_enabled": True}]},
    ["accounts_enabled"],
    None,
])
def test_accounts_flag_comes_only_from_monitoring_accounts_enabled_true(data):
    assert vm.accounts_enabled(data) is False
    assert vm.accounts_enabled({"monitoring": {"accounts_enabled": True}}) is True


def test_failed_status_check_installs_without_enable_accounts(ctx):
    ctx.fake.status = {"monitoring": {"accounts_enabled": True}}
    ctx.fake.status_code = 1
    assert main(ctx, "run") == 0
    (argv, _), = ctx.fake.installers()
    assert "--enable-accounts" not in argv
    assert "keeps the current login mode" in (ctx.directory / state(ctx)["last_install"]["log"]).read_text()


def test_lock_held_by_another_run_is_silent_and_changes_nothing(ctx, capsys):
    ctx.lock.held = True
    assert main(ctx, "run") == 0
    assert capsys.readouterr() == ("", "")
    assert not (ctx.directory / "state.json").exists()
    assert ctx.fake.calls == []


def test_failed_commit_retries_after_30_minutes_at_most_three_times_and_newer_commit_resets(ctx, capsys):
    ctx.fake.installer_code = 1
    assert main(ctx, "run") == 1
    failure = state(ctx)["failure"]
    assert failure["commit"] == NEW and failure["attempts"] == 1 and failure["result"] == "failed"
    assert failure["retry_after"] == vm.stamp(T0 + timedelta(minutes=30))
    assert "attempt 1/3" in capsys.readouterr().out
    later(ctx, minutes=10)
    assert main(ctx, "run") == 0 and len(ctx.fake.installers()) == 1
    assert state(ctx)["last_result"] == "waiting-retry" and capsys.readouterr().out == ""
    later(ctx, minutes=21)
    assert main(ctx, "run") == 1 and len(ctx.fake.installers()) == 2
    later(ctx, minutes=31)
    assert main(ctx, "run") == 1 and len(ctx.fake.installers()) == 3
    assert "attempt 3/3; skipped until a newer commit appears" in capsys.readouterr().out
    later(ctx, hours=5)
    assert main(ctx, "run") == 0 and len(ctx.fake.installers()) == 3
    assert state(ctx)["last_result"] == "skipped" and capsys.readouterr().out == ""
    ctx.fake.remote["refs/heads/" + vm.DEFAULT_BRANCH] = NEWER
    ctx.fake.installer_code = 0
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0 and len(ctx.fake.installers()) == 4
    assert ctx.fake.installers()[-1][0][2] == NEWER
    assert "failure" not in state(ctx) and state(ctx)["deployed_commit"] == NEWER


def test_interrupted_attempt_is_counted_once_and_then_waits(ctx, capsys):
    ctx.directory.mkdir(parents=True)
    vm.save_state(ctx.directory, {"attempt": {"commit": NEW, "started": vm.stamp(T0 - timedelta(minutes=5)),
                                              "log": "x.log", "backend_up": False}})
    assert main(ctx, "run") == 0
    saved = state(ctx)
    assert "attempt" not in saved and saved["failure"]["result"] == "interrupted" and saved["failure"]["attempts"] == 1
    assert saved["last_result"] == "waiting-retry" and ctx.fake.installers() == []
    assert "did not finish" in capsys.readouterr().out


def test_installer_timeout_stops_its_process_group_and_counts_as_failure(ctx):
    ctx.fake.installer_hangs = True
    assert main(ctx, "run") == 1
    assert ctx.stops == [4242]
    assert state(ctx)["failure"]["result"] == "timeout"
    assert "did not finish within 25 minutes" in (ctx.directory / state(ctx)["last_install"]["log"]).read_text()


def test_github_error_is_printed_once_with_credentials_masked(ctx, capsys):
    ctx.fake.ls_remote_error = (128, "fatal: unable to access 'https://user:" + SECRET + "@github.com/x.git/': Could not resolve host\n")
    assert main(ctx, "run") == 1
    out = capsys.readouterr().out
    assert out.count("cannot check for updates") == 1 and SECRET not in out and "***@" in out
    later(ctx, minutes=2)
    assert main(ctx, "run") == 1
    assert capsys.readouterr().out == ""
    assert state(ctx)["last_result"] == "check-error" and SECRET not in (ctx.directory / "state.json").read_text()
    ctx.fake.ls_remote_error = None
    ctx.fake.head = NEW
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0
    assert "last_error" not in state(ctx) and capsys.readouterr().out == ""


def test_low_disk_pauses_with_one_line_and_busy_installer_is_not_counted(ctx, capsys, monkeypatch):
    monkeypatch.setattr(vm, "free_bytes", lambda root: 100 * 1024 * 1024)
    assert main(ctx, "run") == 0
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0
    assert capsys.readouterr().out.count("paused: less than 1 GiB free") == 1
    assert ctx.fake.installers() == [] and ctx.downloads == [] and "failure" not in state(ctx)
    assert state(ctx)["last_result"] == "low-disk"
    monkeypatch.setattr(vm, "free_bytes", lambda root: 50 * 1024 ** 3)
    ctx.fake.installer_code, ctx.fake.installer_output = 1, BUSY
    capsys.readouterr()
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0
    saved = state(ctx)
    assert saved["last_result"] == "busy" and "failure" not in saved
    assert saved["busy_until"] == vm.stamp(ctx.clock.now + timedelta(minutes=10))
    later(ctx, minutes=4)
    assert main(ctx, "run") == 0 and len(ctx.fake.installers()) == 1  # still backing off
    later(ctx, minutes=7)
    assert main(ctx, "run") == 0 and len(ctx.fake.installers()) == 2  # busy again: not counted
    assert "failure" not in state(ctx)
    assert capsys.readouterr().out.count("another installation was running") == 1
    ctx.fake.installer_code, ctx.fake.installer_output = 0, b"Installed\n"
    later(ctx, minutes=11)
    assert main(ctx, "run") == 0 and len(ctx.fake.installers()) == 3
    assert state(ctx)["deployed_commit"] == NEW and "busy_until" not in state(ctx)


def test_no_attempt_in_the_first_five_minutes_after_boot(ctx, capsys, monkeypatch):
    monkeypatch.setattr(vm, "uptime_seconds", lambda: 120.0)
    assert main(ctx, "run") == 0
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0
    assert capsys.readouterr().out.count("started less than 5 minutes ago") == 1
    assert ctx.fake.calls == [] and state(ctx)["last_result"] == "booting" and "failure" not in state(ctx)
    monkeypatch.setattr(vm, "uptime_seconds", lambda: 301.0)
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0 and len(ctx.fake.installers()) == 1


@pytest.mark.parametrize("hang", [False, True])
def test_failed_or_killed_attempt_restarts_a_site_that_was_up(ctx, capsys, monkeypatch, hang):
    monkeypatch.setenv("https_proxy", "http://proxy.example:3128")
    ctx.fake.installer_code, ctx.fake.installer_hangs = 1, hang
    ctx.backend.answers = [True, False]  # up before the attempt, down afterwards
    assert main(ctx, "run") == 1
    (argv, kwargs), = ctx.fake.find(lambda argv: argv[-1] == "start")
    assert argv == [str(ctx.root / "backend" / ".venv" / "bin" / "python"), str(ctx.root / "scripts" / "lab-service.py"),
                    "--project", str(ctx.root), "start"]
    assert kwargs["timeout"] == vm.RESTART_TIMEOUT and not any(name.lower().endswith("_proxy") for name in kwargs["env"])
    restart = state(ctx)["restart"]
    assert restart["result"] == "ok: started" and restart["after"] == ("timeout" if hang else "failed")
    assert "lab-service start: ok: started" in capsys.readouterr().out


def test_no_restart_when_the_site_was_down_before_or_is_still_up(ctx):
    ctx.fake.installer_code = 1
    ctx.backend.answers = [False]
    assert main(ctx, "run") == 1
    ctx.fake.remote["refs/heads/" + vm.DEFAULT_BRANCH] = NEWER
    ctx.backend.answers = [True]
    later(ctx, minutes=2)
    assert main(ctx, "run") == 1
    assert ctx.fake.find(lambda argv: argv[-1] == "start") == [] and "restart" not in state(ctx)


def test_interrupted_attempt_restarts_a_site_that_was_up(ctx):
    ctx.directory.mkdir(parents=True)
    vm.save_state(ctx.directory, {"attempt": {"commit": NEW, "started": vm.stamp(T0), "log": "x.log", "backend_up": True}})
    ctx.backend.answers = [False]
    assert main(ctx, "run") == 0
    assert len(ctx.fake.find(lambda argv: argv[-1] == "start")) == 1
    assert state(ctx)["restart"]["after"] == "interrupted"


@pytest.mark.parametrize("restart_works", [True, False])
def test_installer_stopped_after_moving_head_is_not_up_to_date_until_verified(ctx, capsys, restart_works):
    ctx.directory.mkdir(parents=True)
    vm.save_state(ctx.directory, {"attempt": {"commit": NEW, "started": vm.stamp(T0 - timedelta(minutes=3)),
                                              "log": "x.log", "backend_up": True}})
    ctx.fake.head = NEW  # the installer fast-forwarded, then its run died before the site was verified
    if restart_works:
        ctx.backend.answers = [False, True]
    else:
        ctx.fake.restart = (1, "port 8000 is held by another process\n")
        ctx.backend.answers = [False]
    assert main(ctx, "run") == 0
    saved = state(ctx)
    assert saved["last_result"] == "waiting-retry" and saved["failure"]["commit"] == NEW
    assert saved["failure"]["result"] == "interrupted" and saved["deployed_commit"] == NEW
    assert saved["restart"]["result"] == ("ok: started" if restart_works else
                                          "failed (exit 1): port 8000 is held by another process")
    later(ctx, minutes=10)
    assert main(ctx, "run") == 0
    assert state(ctx)["last_result"] == "waiting-retry" and state(ctx)["failure"]["commit"] == NEW
    assert ctx.fake.installers() == []
    later(ctx, minutes=21)
    ctx.backend.answers = [restart_works, True]  # the installer starts the site, so it answers afterwards
    assert main(ctx, "run") == 0
    (argv, _), = ctx.fake.installers()
    assert argv[2] == NEW
    saved = state(ctx)
    assert saved["last_result"] == "installed" and "failure" not in saved
    assert "running the installer again for " + NEW[:12] in capsys.readouterr().out


def test_success_needs_the_site_that_was_up_to_answer_again(ctx):
    ctx.backend.answers = [True, False, False]  # up before; down after the installer; still down
    assert main(ctx, "run") == 1
    saved = state(ctx)
    assert saved["failure"]["result"] == "site-down" and saved["failure"]["commit"] == NEW
    assert saved["last_result"] == "failed" and len(ctx.fake.find(lambda argv: argv[-1] == "start")) == 1
    later(ctx, minutes=31)
    ctx.backend.answers = [True]
    assert main(ctx, "run") == 0  # HEAD == NEW but unverified: the installer runs again and succeeds
    assert len(ctx.fake.installers()) == 2 and "failure" not in state(ctx)


def test_attempt_marker_records_the_installer_identity_and_deadline(ctx):
    seen = []
    ctx.fake.during_wait = lambda process: seen.append(state(ctx)["attempt"])
    assert main(ctx, "run") == 0
    assert seen == [{"commit": NEW, "started": vm.stamp(T0), "log": "20261018T120000Z-" + NEW[:8] + ".log",
                     "backend_up": True, "site_required": True, "installer_pid": 4242, "installer_start": "55555",
                     "deadline": vm.stamp(T0 + timedelta(minutes=25))}]
    assert "attempt" not in state(ctx)


def orphan_marker(ctx, deadline):
    ctx.directory.mkdir(parents=True)
    vm.save_state(ctx.directory, {"attempt": {"commit": NEW, "started": vm.stamp(T0 - timedelta(minutes=20)), "log": "x.log",
                                              "backend_up": True, "installer_pid": 777, "installer_start": "9001",
                                              "deadline": vm.stamp(deadline)}})


def test_an_installer_still_running_within_its_limit_is_left_alone(ctx, capsys):
    orphan_marker(ctx, T0 + timedelta(minutes=5))
    ctx.fake.processes[777] = (777, "9001")
    assert main(ctx, "run") == 0
    assert ctx.fake.calls == [] and ctx.stops == [] and capsys.readouterr().out == ""
    saved = state(ctx)
    assert saved["attempt"]["installer_pid"] == 777 and saved["last_result"] == "installing" and "failure" not in saved


def test_a_late_installer_from_a_stopped_run_is_reported_never_signalled(ctx, capsys):
    deadline = T0 - timedelta(minutes=12)
    orphan_marker(ctx, deadline)
    ctx.fake.processes[777] = (777, "9001")
    assert main(ctx, "run") == 0
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0
    out = capsys.readouterr().out
    assert out.count("(pid 777) is still running, past its 25-minute limit since " + vm.stamp(deadline)) == 1
    assert "not stopped automatically" in out
    assert ctx.stops == [] and ctx.fake.calls == []
    saved = state(ctx)
    assert saved["last_result"] == "installer-late" and saved["attempt"]["installer_pid"] == 777 and "failure" not in saved
    assert main(ctx, "status", "--json") == 0
    assert json.loads(capsys.readouterr().out)["installer"] == {
        "pid": 777, "start": "9001", "running": True, "deadline": vm.stamp(deadline), "late_minutes": 14}
    assert main(ctx, "status") == 0
    assert "installer: pid 777, start 9001, running, 14 minutes past its 25-minute limit" in capsys.readouterr().out
    del ctx.fake.processes[777]  # the installer finally exits: the attempt is settled, the site restarted
    ctx.backend.answers = [False]
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0
    saved = state(ctx)
    assert "attempt" not in saved and saved["failure"]["result"] == "interrupted" and saved["failure"]["needs_site"] is True
    assert saved["restart"]["after"] == "interrupted" and len(ctx.fake.find(lambda argv: argv[-1] == "start")) == 1
    assert ctx.stops == []


@pytest.mark.parametrize("processes", [{}, {777: (777, "1234")}])  # gone, or the PID reused by a later process
def test_a_vanished_or_reused_installer_pid_is_treated_as_gone(ctx, processes):
    orphan_marker(ctx, T0 - timedelta(minutes=1))
    ctx.fake.processes.update(processes)
    assert main(ctx, "run") == 0
    assert ctx.stops == [] and "attempt" not in state(ctx) and state(ctx)["failure"]["result"] == "interrupted"


@pytest.mark.parametrize("leader_exits_on_term", [True, False])
def test_same_run_timeout_signals_the_group_before_reaping_the_leader(monkeypatch, leader_exits_on_term):
    events = []
    monkeypatch.setattr(vm, "signal", SimpleNamespace(SIGTERM=15, SIGKILL=9))
    monkeypatch.setattr(vm, "pause", lambda seconds: events.append(("pause",)))
    monkeypatch.setattr(vm.os, "killpg", lambda pgid, sig: events.append(("killpg", pgid, sig)), raising=False)
    monkeypatch.setattr(vm, "child_exited", lambda pid: events.append(("check", pid)) or leader_exits_on_term)
    process = SimpleNamespace(pid=4242, wait=lambda timeout=None: events.append(("reap", timeout)))
    assert vm.stop_group(process) is True
    assert [event for event in events if event[0] == "killpg"] == [("killpg", 4242, 15), ("killpg", 4242, 9)]
    assert events[-1] == ("reap", vm.STOP_GRACE) and events.count(("reap", vm.STOP_GRACE)) == 1
    assert events.count(("pause",)) == (0 if leader_exits_on_term else vm.STOP_GRACE * 4)


def test_same_run_timeout_with_the_group_already_gone_still_reaps(monkeypatch):
    events = []

    def killpg(pgid, sig):
        raise ProcessLookupError

    monkeypatch.setattr(vm, "signal", SimpleNamespace(SIGTERM=15, SIGKILL=9))
    monkeypatch.setattr(vm.os, "killpg", killpg, raising=False)
    process = SimpleNamespace(pid=4242, wait=lambda timeout=None: events.append(("reap", timeout)))
    assert vm.stop_group(process) is True
    assert events == [("reap", vm.STOP_GRACE)]


def test_same_run_timeout_reports_a_leader_that_survives_kill(monkeypatch):
    sent = []

    def wait(timeout=None):
        raise subprocess.TimeoutExpired("installer", timeout)

    monkeypatch.setattr(vm, "signal", SimpleNamespace(SIGTERM=15, SIGKILL=9))
    monkeypatch.setattr(vm, "pause", lambda seconds: None)
    monkeypatch.setattr(vm, "child_exited", lambda pid: False)
    monkeypatch.setattr(vm.os, "killpg", lambda pgid, sig: sent.append(sig), raising=False)
    assert vm.stop_group(SimpleNamespace(pid=4242, wait=wait)) is False
    assert sent == [15, 9]


def test_an_installer_that_survives_kill_keeps_its_marker_until_it_is_gone(ctx, capsys, monkeypatch):
    monkeypatch.setattr(vm, "stop_group", lambda process: ctx.stops.append(process.pid) and False)
    ctx.fake.installer_hangs = True
    ctx.fake.during_wait = lambda process: later(ctx, minutes=26)  # the installer runs past its 25-minute limit
    ctx.backend.answers = [True, False]
    assert main(ctx, "run") == 1
    saved = state(ctx)
    assert saved["attempt"]["installer_pid"] == 4242 and saved["attempt"]["counted"] is True
    assert saved["last_result"] == "installer-late" and saved["failure"]["result"] == "timeout"
    assert saved["failure"]["attempts"] == 1 and ctx.stops == [4242]
    assert capsys.readouterr().out.count("did not exit even after KILL") == 1
    log = (ctx.directory / saved["attempt"]["log"]).read_text()
    assert "has not exited (pid 4242)" in log
    later(ctx, minutes=2)
    assert main(ctx, "run") == 0  # still alive: reported quietly, never signalled, lock released
    assert capsys.readouterr().out == "" and state(ctx)["last_result"] == "installer-late" and ctx.stops == [4242]
    assert main(ctx, "status", "--json") == 0
    installer = json.loads(capsys.readouterr().out)["installer"]
    assert installer["pid"] == 4242 and installer["running"] is True and installer["late_minutes"] == 3
    del ctx.fake.processes[4242]  # it finally exits
    ctx.backend.answers = [False]
    later(ctx, minutes=2)
    starts = len(ctx.fake.find(lambda argv: argv[-1] == "start"))
    assert main(ctx, "run") == 0
    saved = state(ctx)
    assert "attempt" not in saved and saved["failure"]["attempts"] == 1 and saved["failure"]["result"] == "timeout"
    assert len(ctx.fake.find(lambda argv: argv[-1] == "start")) == starts + 1 and saved["restart"]["after"] == "timeout"
    assert "that survived its timeout has exited" in capsys.readouterr().out
    assert ctx.stops == [4242] and saved["last_result"] == "waiting-retry"


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="process groups and waitid are Linux-only")
def test_real_same_run_timeout_kills_a_group_member_that_ignores_term():
    code = ("import subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import signal, time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); print(1, flush=True); time.sleep(60)'],"
            " stdout=subprocess.PIPE, text=True)\n"
            "child.stdout.readline()\n"
            "print(child.pid, flush=True)\n"
            "time.sleep(60)\n")
    leader = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True, start_new_session=True)
    member = int(leader.stdout.readline())
    vm.stop_group(leader)
    assert leader.returncode is not None
    for _ in range(50):
        if vm.process_start(member) is None:
            break
        time.sleep(0.1)
    assert vm.process_start(member) is None


def test_a_retry_after_site_down_still_needs_the_site_to_answer(ctx):
    ctx.backend.answers = [True, False, False]  # up before; down after the installer; still down after the restart
    assert main(ctx, "run") == 1
    assert state(ctx)["failure"]["needs_site"] is True
    later(ctx, minutes=31)
    ctx.backend.answers = [False]  # the retry starts while the site is down, and it stays down
    assert main(ctx, "run") == 1
    saved = state(ctx)
    assert saved["failure"]["result"] == "site-down" and saved["failure"]["attempts"] == 2 and saved["last_result"] == "failed"
    later(ctx, minutes=31)
    ctx.backend.answers = [False, True]  # down when the retry starts, answering after the installer
    assert main(ctx, "run") == 0
    assert "failure" not in state(ctx) and state(ctx)["last_result"] == "installed"


def test_process_start_reads_proc_only_on_linux():
    value = vm.process_start(os.getpid())
    assert (value is not None) == sys.platform.startswith("linux")
    assert vm.process_start(-5) is None


def test_non_utf8_state_file_is_quarantined_not_fatal(ctx):
    ctx.directory.mkdir(parents=True)
    (ctx.directory / "state.json").write_bytes(b"\xff\xfe{\x00garbage")
    assert main(ctx, "status", "--json") == 0
    ctx.fake.head = NEW
    assert main(ctx, "run") == 0
    assert list(ctx.directory.glob("state.json.bad-*")) and state(ctx)["last_result"] == "up-to-date"


def test_ls_remote_runs_outside_the_checkout_and_refuses_url_rewrites(ctx, capsys):
    ctx.fake.head = NEW
    assert main(ctx, "run") == 0
    (url_argv, url_kwargs), (ls_argv, ls_kwargs) = ctx.fake.find(lambda argv: "ls-remote" in argv)
    tls = ["git", "-c", "http.sslVerify=true", "-c", "http." + vm.REPOSITORY + ".sslVerify=true", "ls-remote"]
    assert url_argv == tls + ["--get-url", vm.REPOSITORY] and url_kwargs["cwd"] == "/" and url_kwargs["timeout"] == 30
    assert ls_argv == tls + [vm.REPOSITORY, "refs/heads/" + vm.DEFAULT_BRANCH] and ls_kwargs["cwd"] == "/"
    ctx.fake.head = OLD
    ctx.fake.get_url = "https://mirror.example/DCIM-204.git"
    later(ctx, minutes=2)
    assert main(ctx, "run") == 1
    assert "git configuration rewrites the repository URL" in capsys.readouterr().out
    assert ctx.downloads == [] and ctx.fake.installers() == [] and state(ctx)["last_result"] == "check-error"


def test_a_commented_out_line_is_not_installed(ctx, capsys):
    line = vm.cron_line(ctx.root, vm.DEFAULT_BRANCH)
    ctx.fake.crontab = "# " + line + "\n"
    assert main(ctx, "status", "--json") == 0
    assert json.loads(capsys.readouterr().out)["installed"] is False
    assert main(ctx, "install") == 0
    assert ctx.fake.crontab == line + "\n"


# ---------------------------------------------------------------- environment and secrecy

def test_saved_network_settings_reach_only_ls_remote_and_git_config(ctx, tmp_path, monkeypatch, capsys):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ca = tmp_path / "ca.pem"
    ca.write_text("certificate")
    monkeypatch.setenv("PATH", os.pathsep.join([str(bin_dir), "", ".", "relative" + os.sep + "bin", str(tmp_path / "missing")]))
    monkeypatch.setenv("https_proxy", "http://proxy.example:3128")
    monkeypatch.setenv("no_proxy", "localhost,127.0.0.1")
    monkeypatch.setenv("SSL_CERT_FILE", str(ca))
    monkeypatch.setenv("HTTP_PROXY", "http://user:" + SECRET + "@proxy.example:3128")
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(ca))
    monkeypatch.setenv("GIT_SSL_NO_VERIFY", "1")
    assert main(ctx, "install") == 0
    out = capsys.readouterr().out
    assert "not saved (the value may contain credentials): HTTP_PROXY" in out and SECRET not in out
    saved = lower(state(ctx)["environment"])
    assert saved == {"path": str(bin_dir), "https_proxy": "http://proxy.example:3128", "no_proxy": "localhost,127.0.0.1",
                     "ssl_cert_file": str(ca)}
    for name in ("https_proxy", "no_proxy", "SSL_CERT_FILE", "HTTP_PROXY"):
        monkeypatch.delenv(name)  # the cron job starts without them
    assert main(ctx, "run") == 0
    (ls_argv, ls_kwargs), = [call for call in ctx.fake.find(lambda argv: "ls-remote" in argv)][-1:]
    assert ls_argv[:3] == ["git", "-c", "http.sslVerify=true"] and ls_argv[-2] == vm.REPOSITORY
    assert lower(ls_kwargs["env"])["https_proxy"] == "http://proxy.example:3128" and "git_ssl_no_verify" not in lower(ls_kwargs["env"])
    (_, kwargs), = ctx.fake.installers()
    env = kwargs["env"]
    assert not [name for name in env if name.upper().endswith("_PROXY") or name.upper().startswith("SSL_CERT_")
                or name.upper() in ("REQUESTS_CA_BUNDLE", "GIT_SSL_NO_VERIFY")]
    assert env["PATH"] == str(bin_dir) and env["GIT_TERMINAL_PROMPT"] == "0"
    assert [(env["GIT_CONFIG_KEY_" + str(i)], env["GIT_CONFIG_VALUE_" + str(i)]) for i in range(int(env["GIT_CONFIG_COUNT"]))] == [
        ("http.proxy", "http://proxy.example:3128"), ("http.sslCAInfo", str(ca))]
    for argv, kwargs in ctx.fake.find(lambda argv: argv[0] != "download" and "ls-remote" not in argv):
        if "env" in kwargs:
            assert not any(name.upper().endswith("_PROXY") for name in kwargs["env"]), argv


def test_git_older_than_2_31_refuses_proxy_settings_before_any_change(ctx, monkeypatch, capsys):
    ctx.fake.git_version = "git version 2.25.1"
    monkeypatch.setenv("https_proxy", "http://proxy.example:3128")
    assert main(ctx, "install") == 1
    assert "2.31" in capsys.readouterr().err and ctx.fake.crontab_writes == 0
    monkeypatch.delenv("https_proxy")
    assert main(ctx, "install") == 0 and ctx.fake.crontab_writes == 1


def test_git_too_old_at_run_time_is_reported_once_and_installs_nothing(ctx, capsys):
    ctx.directory.mkdir(parents=True)
    vm.save_state(ctx.directory, {"environment": {"https_proxy": "http://proxy.example:3128"}})
    ctx.fake.git_version = "git version 2.25.1"
    for _ in range(3):
        assert main(ctx, "run") == 1
        later(ctx, minutes=2)
    assert capsys.readouterr().out.count("2.31") == 1
    assert ctx.fake.installers() == [] and ctx.downloads == [] and state(ctx)["last_result"] == "check-error"


@pytest.mark.parametrize("where", ["shell", "crontab"])
def test_install_refuses_application_settings_outside_env_file(ctx, monkeypatch, capsys, where):
    if where == "shell":
        monkeypatch.setenv("LAB_MANAGER_PASSWORD", SECRET)
        monkeypatch.setenv("smtp_password", SECRET)
    else:
        ctx.fake.crontab = "MAILTO=\"\"\nACCOUNTS_ENABLED=true\n 0 1 * * * /usr/bin/true\n"
    assert main(ctx, "install") == 1
    err = capsys.readouterr().err
    assert "Move them into .env" in err and SECRET not in err
    assert ("lab_manager_password, smtp_password" if where == "shell" else "accounts_enabled") in err.lower()
    assert ctx.fake.crontab_writes == 0 and not (ctx.directory / "state.json").exists()


def test_no_secret_reaches_output_logs_state_or_argv(ctx, monkeypatch, capsys):
    monkeypatch.setenv("DCIM_FAKE_TOKEN", SECRET)
    monkeypatch.setenv("https_proxy", "http://user:" + SECRET + "@proxy.example:3128")
    ctx.fake.crontab = "0 3 * * * /usr/bin/true\n"
    assert main(ctx, "install") == 0
    monkeypatch.setenv("SMTP_PASSWORD", SECRET)  # present at run time only; inherited, never written
    ctx.fake.installer_code = 1
    ctx.backend.answers = [True, False]
    assert main(ctx, "run") == 1
    ctx.fake.installer_code = 0
    ctx.backend.answers = [True]  # the restart brought the site back
    later(ctx, minutes=31)
    assert main(ctx, "run") == 0
    assert main(ctx, "status", "--json") == 0
    assert main(ctx, "status") == 0
    captured = capsys.readouterr()
    assert SECRET not in captured.out + captured.err
    for path in (ctx.root / ".monitor-backups").rglob("*"):
        if path.is_file():
            assert SECRET not in path.read_text(encoding="utf-8", errors="replace"), path
    assert all(SECRET not in item for argv in ctx.fake.commands() for item in argv)
    assert "https_proxy" not in lower(state(ctx)["environment"])


# ---------------------------------------------------------------- crontab

def foreign_jobs(root):
    return ('MAILTO=""\n'
            "0 2 * * * tar czf /backup/dcim.tgz " + str(root) + "/backend/lab_manager.db\n"
            "# keep this comment\n"
            + lab_service.boot_command(root) + "\n")


def test_install_adds_one_line_keeps_other_lines_and_is_idempotent(ctx, capsys):
    jobs = foreign_jobs(ctx.root)
    ctx.fake.crontab = jobs
    assert main(ctx, "install") == 0
    text = ctx.fake.crontab
    line = vm.cron_line(ctx.root, vm.DEFAULT_BRANCH)
    assert text == jobs + line + "\n"
    assert lab_service.foreign_boot_lines(text, ctx.root) == []
    assert lab_service.remove_managed(text).count(vm.MARK) == 1
    out = capsys.readouterr().out
    for label in ("auto-update installed", "branch: " + vm.DEFAULT_BRANCH, "deployed commit: " + OLD,
                  "latest branch commit: " + NEW, "logs: " + str(ctx.directory)):
        assert label in out
    backups = list((ctx.root / ".monitor-backups").glob("*-crontab-*/crontab.txt"))
    assert [path.read_text() for path in backups] == [jobs]
    assert main(ctx, "install") == 0
    assert ctx.fake.crontab == text and ctx.fake.crontab_writes == 1
    assert "already installed" in capsys.readouterr().out
    assert state(ctx)["branch"] == vm.DEFAULT_BRANCH


def test_install_replaces_an_old_auto_update_line(ctx):
    ctx.fake.crontab = "*/5 * * * * old command " + vm.MARK + "\n0 1 * * * /usr/bin/true\n"
    assert main(ctx, "--branch", "release/next", "install") == 0
    assert ctx.fake.crontab == "0 1 * * * /usr/bin/true\n" + vm.cron_line(ctx.root, "release/next") + "\n"
    assert main(ctx, "status", "--json") == 0  # the installed branch is the default from now on
    assert state(ctx)["branch"] == "release/next"


def test_remove_deletes_only_its_own_line(ctx, capsys):
    jobs = foreign_jobs(ctx.root)
    ctx.fake.crontab = jobs + vm.cron_line(ctx.root, vm.DEFAULT_BRANCH) + "\n"
    assert main(ctx, "remove") == 0
    assert ctx.fake.crontab == jobs
    assert lab_service.MANAGED_MARK in ctx.fake.crontab
    assert main(ctx, "remove") == 0
    assert "not installed" in capsys.readouterr().out and ctx.fake.crontab_writes == 1


def test_crontab_changed_meanwhile_or_running_update_blocks_the_write(ctx, capsys):
    ctx.fake.crontab = "0 1 * * * /usr/bin/true\n"
    ctx.fake.change_on_read = {2: "0 1 * * * /usr/bin/true\n30 2 * * * /usr/bin/other\n"}
    assert main(ctx, "install") == 1
    assert "changed while this command ran" in capsys.readouterr().err and ctx.fake.crontab_writes == 0
    ctx.lock.held = True
    assert main(ctx, "install") == 1 and main(ctx, "remove") == 1
    assert "in progress" in capsys.readouterr().err and ctx.fake.crontab_writes == 0


def test_cron_line_arguments_are_the_frozen_run_interface(ctx):
    line = vm.cron_line(ctx.root, vm.DEFAULT_BRANCH)
    assert line.startswith("*/2 * * * * ") and line.endswith(" 2>&1 " + vm.MARK)
    tokens = shlex.split(line.split(None, 5)[5])
    script = tokens.index(str(ctx.root / "scripts" / "vm-auto-update.py"))
    args = tokens[script + 1:tokens.index(">>")]
    assert args == ["--project", str(ctx.root), "--branch=" + vm.DEFAULT_BRANCH, "run"]
    parsed = vm.build_parser().parse_args(args)
    assert (parsed.project, parsed.branch, parsed.command) == (str(ctx.root), vm.DEFAULT_BRANCH, "run")
    assert tokens[tokens.index(">>") + 1] == str(ctx.directory / "cron.log")
    assert not lab_service.starts_backend(line.split(None, 5)[5], ctx.root)


def test_cron_line_refuses_percent(tmp_path):
    with pytest.raises(vm.UpdateError):
        vm.cron_line(tmp_path / "a%b", vm.DEFAULT_BRANCH)
    with pytest.raises(vm.UpdateError):
        vm.cron_line(tmp_path, "x\ny")


@pytest.mark.parametrize("name,valid", [
    ("feat/lab-manager-v3-accounts", True), ("main", True), ("release/2.38", True), ("A7asaf-cloud/ops_1", True),
    ("", False), ("-x", False), ("/x", False), (".x", False), ("x/", False), ("a..b", False), ("a//b", False),
    ("x.lock", False), ("a b", False), ("a;b", False), ("$(id)", False), ("x%y", False), ("a" * 201, False),
])
def test_branch_names(name, valid):
    assert vm.valid_branch(name) is valid


def test_invalid_branch_is_rejected_by_the_parser(ctx):
    with pytest.raises(SystemExit) as error:
        main(ctx, "--branch", "x;id", "run")
    assert error.value.code == 2


@pytest.mark.parametrize("stdout,expected", [
    (NEW + "\trefs/heads/x/refs/heads/main\n" + NEWER + "\trefs/heads/main\n", NEWER),
    (NEW + "\trefs/heads/main\n" + NEWER + "\trefs/heads/main\n", None),
    ("not-a-sha\trefs/heads/main\n", None),
    (NEW + "\trefs/heads/other\n", None),
    ("", None),
])
def test_ls_remote_accepts_exactly_one_exact_ref(ctx, stdout, expected):
    ctx.fake.ls_remote_stdout = stdout
    if expected:
        assert vm.remote_commit("main", {}) == expected
    else:
        with pytest.raises(vm.UpdateError):
            vm.remote_commit("main", {})


# ---------------------------------------------------------------- files and state

def test_attempt_logs_keep_the_newest_twenty_and_only_own_files(ctx):
    ctx.directory.mkdir(parents=True)
    for index in range(25):
        name = "20261001T0000" + str(index).zfill(2) + "Z-" + "0123456" + str(index % 10)
        (ctx.directory / (name + ".log")).write_text("old")
        (ctx.directory / (name + "-before.json")).write_text("{}")
    keep = ["notes.txt", "20261001T000000Z-zzzzzzzz.log", "cron.log", "cron.log.1"]
    for name in keep:
        (ctx.directory / name).write_text("keep")
    (ctx.directory / "20261001T000001Z-00000000.log").mkdir()
    assert main(ctx, "run") == 0
    groups = sorted({vm.ATTEMPT_FILE.fullmatch(name).group(1) for name in attempt_files(ctx)})
    assert len(groups) == 20
    assert groups[-1].endswith(NEW[:8]) and groups[0] == "20261001T000006Z-01234566"
    assert all((ctx.directory / name).exists() for name in keep)
    assert (ctx.directory / "20261001T000001Z-00000000.log").is_dir()


def test_retention_never_follows_or_removes_symlinks(ctx, tmp_path):
    ctx.directory.mkdir(parents=True)
    outside = tmp_path / "outside.log"
    outside.write_text("not ours")
    link = ctx.directory / "20200101T000000Z-00000000.log"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symbolic links are not available here")
    vm.prune_attempts(ctx.directory, keep=0)
    assert link.is_symlink() and outside.read_text() == "not ours"


def test_state_tolerates_unknown_keys_and_quarantines_a_corrupt_file(ctx):
    ctx.directory.mkdir(parents=True)
    (ctx.directory / "state.json").write_text("{not json")
    ctx.fake.head = NEW
    assert main(ctx, "run") == 0
    assert list(ctx.directory.glob("state.json.bad-*")) and state(ctx)["last_result"] == "up-to-date"
    vm.save_state(ctx.directory, {"failure": "garbage", "attempt": 5, "last_install": [], "future": {"x": 1},
                                  "environment": {"LD_PRELOAD": "/tmp/x.so", "PATH": "relative", "https_proxy": "http://a@b"}})
    ctx.fake.head = OLD
    assert main(ctx, "run") == 0
    assert state(ctx)["deployed_commit"] == NEW and state(ctx)["future"] == {"x": 1}
    (_, kwargs), = ctx.fake.installers()
    assert kwargs["env"].get("LD_PRELOAD") != "/tmp/x.so" and kwargs["env"].get("PATH") == os.environ.get("PATH")
    assert vm.load_saved(state(ctx)) == {}


def test_state_file_records_the_last_install(ctx):
    assert main(ctx, "run") == 0
    saved = state(ctx)
    assert saved["branch"] == vm.DEFAULT_BRANCH and saved["project"] == str(ctx.root)
    assert saved["remote_commit"] == NEW and saved["deployed_commit"] == NEW
    install = saved["last_install"]
    assert install["commit"] == NEW and install["result"] == "installed" and install["started"] == vm.stamp(T0)
    assert install["log"] == "20261018T120000Z-" + NEW[:8] + ".log"


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="POSIX permissions")
def test_private_permissions_on_linux(ctx):
    (ctx.root / ".monitor-backups").mkdir(mode=0o755)
    assert main(ctx, "run") == 0
    for directory in (ctx.root / ".monitor-backups", ctx.directory):
        assert directory.stat().st_mode & 0o777 == 0o700
    for path in ctx.directory.iterdir():
        if path.is_file() and path.name != "run.lock":
            assert path.stat().st_mode & 0o777 == 0o600, path.name


def test_write_private_never_overwrites(tmp_path):
    target = vm.write_private(tmp_path / "file.txt", "one")
    with pytest.raises(FileExistsError):
        vm.write_private(target, "two")
    assert target.read_text() == "one"


# ---------------------------------------------------------------- status and command line

def test_status_json_reports_progress_failure_space_and_saved_names(ctx, capsys, monkeypatch):
    monkeypatch.setenv("https_proxy", "http://proxy.example:3128")
    assert main(ctx, "install") == 0
    ctx.fake.installer_code = 1
    assert main(ctx, "run") == 1
    backup = ctx.root / ".monitor-backups" / "20261001-000000-000000-abc1234"
    backup.mkdir()
    (backup / "source.tar").write_bytes(b"x" * 1000)
    lock = ctx.directory / "run.lock"
    old = (T0 - timedelta(minutes=40)).timestamp()
    os.utime(lock, (old, old))
    ctx.lock.status_held = True
    capsys.readouterr()
    assert main(ctx, "status", "--json") == 0
    data = json.loads(capsys.readouterr().out)
    assert data["installed"] is True and data["branch"] == vm.DEFAULT_BRANCH
    assert data["deployed_commit"] == OLD and data["remote_commit"] == NEW
    assert data["failure"]["attempts"] == 1 and data["failure"]["skipped"] is False and data["failure"]["max_attempts"] == 3
    assert data["running"] == {"since": vm.stamp(T0 - timedelta(minutes=40)), "stuck": True}
    names = [name.lower() for name in data["saved_variables"]]
    assert "https_proxy" in names and set(names) <= {"https_proxy", "path"} and "proxy.example" not in json.dumps(data)
    assert data["backups"]["bytes"] >= 1000 and data["backups"]["count"] >= 2  # installer backup + crontab backup
    assert data["paused_low_disk"] is False and data["disk_free_bytes"] == 50 * 1024 ** 3
    assert data["newest_attempt_log"].endswith(NEW[:8] + ".log")
    assert main(ctx, "status") == 0
    text = capsys.readouterr().out
    assert "update running since" in text and "longer than 30 minutes" in text
    assert "failed commit: " + NEW in text and "saved variables: https_proxy" in text.lower()


def test_root_and_foreign_accounts_are_refused(ctx, monkeypatch, capsys):
    monkeypatch.setattr(vm, "effective_uid", lambda: 0)
    for command in ("install", "remove", "run"):
        assert main(ctx, command) == 1
    assert "as root" in capsys.readouterr().err
    monkeypatch.setattr(vm, "effective_uid", lambda: 1001)
    assert main(ctx, "run") == 1
    assert "owns" in capsys.readouterr().err
    assert ctx.fake.calls == []


def test_help_exits_zero_and_install_remove_run_refuse_outside_linux(ctx, monkeypatch, capsys):
    result = subprocess.run([sys.executable, str(SCRIPTS / "vm-auto-update.py"), "--help"], capture_output=True, text=True,
                            timeout=60)
    assert result.returncode == 0 and "install" in result.stdout
    monkeypatch.setattr(vm, "is_linux", lambda: False)
    for command in ("install", "remove", "run"):
        with pytest.raises(SystemExit) as error:
            main(ctx, command)
        assert error.value.code == 2
    assert "only inside the Linux VM" in capsys.readouterr().err
    assert ctx.fake.calls == []
    assert main(ctx, "status") == 0


# ---------------------------------------------------------------- downloads

class Response:
    def __init__(self, url, data, status=200):
        self.url, self.data, self.status = url, data, status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def geturl(self):
        return self.url

    def read(self, size):
        return self.data[:size]


class Opener:
    def __init__(self, response):
        self.response, self.requests = response, []

    def open(self, request, timeout):
        self.requests.append((request.full_url, timeout))
        return self.response(request.full_url) if callable(self.response) else self.response


def test_fetch_accepts_only_the_exact_url_with_status_200_and_a_size_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(vm, "pause", lambda seconds: None)
    url = vm.RAW_PREFIX + NEW + "/scripts/lab-service.py"
    opener = Opener(lambda requested: Response(requested, b"print('ok')\n"))
    saved = vm.fetch(NEW, "lab-service.py", tmp_path / "ok.py", opener)
    assert saved.read_text() == "print('ok')\n" and opener.requests == [(url, vm.DOWNLOAD_TIMEOUT)]
    cases = [(Response(url.replace(NEW, NEWER), b"x = 1\n"), "exact commit URL"),
             (Response(url, b"x = 1\n", status=203), "HTTP status 203"),
             (Response(url, b"#" * (vm.DOWNLOAD_CAP + 1)), "larger than 2 MiB"),
             (Response(url, b"<html>not python"), "lab-service.py")]
    for index, (response, message) in enumerate(cases):
        opener = Opener(response)
        with pytest.raises(vm.UpdateError) as error:
            vm.fetch(NEW, "lab-service.py", tmp_path / (str(index) + ".py"), opener)
        assert message in str(error.value) and len(opener.requests) == vm.DOWNLOAD_TRIES
        assert not (tmp_path / (str(index) + ".py")).exists()
    with pytest.raises(vm.UpdateError):
        vm.fetch("HEAD", "lab-service.py", tmp_path / "x.py", opener)
    with pytest.raises(vm.UpdateError):
        vm.fetch(NEW, "../../.env", tmp_path / "y.py", opener)


def test_downloads_refuse_every_redirect_and_use_only_the_saved_proxy(monkeypatch):
    monkeypatch.setenv("https_proxy", "http://environment-proxy.example:1")  # must be ignored
    with pytest.raises(vm.UpdateError):
        vm.NoRedirects().redirect_request(None, None, 302, "Found", {}, vm.RAW_PREFIX + NEW + "/scripts/lab-service.py")

    def proxies(saved):
        handlers = vm.download_opener(saved).handlers
        return [handler.proxies for handler in handlers if isinstance(handler, vm.urllib.request.ProxyHandler)]

    # An empty ProxyHandler registers no proxy, and it still replaces urllib's environment-based default.
    assert proxies({}) == []
    assert proxies({"https_proxy": "http://proxy.example:3128"}) == [{"https": "http://proxy.example:3128"}]
    assert proxies({"https_proxy": "http://proxy.example:3128", "no_proxy": ".githubusercontent.com"}) == []


# ---------------------------------------------------------------- real git, real locks

def test_deployed_commit_and_containment_with_a_real_local_repository(tmp_path):
    def git(*args):
        return subprocess.check_output(["git", "-c", "commit.gpgsign=false", "-C", str(tmp_path), *args], text=True).strip()
    git("init", "-q")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Auto Update Test")
    (tmp_path / "a.txt").write_text("one")
    git("add", "a.txt")
    git("commit", "-q", "-m", "one")
    first = git("rev-parse", "HEAD")
    (tmp_path / "a.txt").write_text("two")
    git("commit", "-q", "-am", "two")
    second = git("rev-parse", "HEAD")
    assert vm.deployed_commit(tmp_path) == second
    assert vm.contains(tmp_path, first, second) is True
    assert vm.contains(tmp_path, second, first) is False
    assert vm.contains(tmp_path, NEW, second) is False  # a commit not fetched yet is never "contained"


def test_cron_log_rotates_above_one_mebibyte(tmp_path):
    (tmp_path / "cron.log").write_bytes(b"x" * 10)
    vm.rotate_cron_log(tmp_path)
    assert (tmp_path / "cron.log").exists() and not (tmp_path / "cron.log.1").exists()
    (tmp_path / "cron.log").write_bytes(b"x" * (vm.CRON_LOG_MAX + 1))
    vm.rotate_cron_log(tmp_path)
    assert not (tmp_path / "cron.log").exists() and (tmp_path / "cron.log.1").stat().st_size == vm.CRON_LOG_MAX + 1


def test_local_probes_without_touching_the_real_backend_port():
    import socket
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        assert vm.backend_answers(port) is True
    assert vm.backend_answers(port) is False
    uptime = vm.uptime_seconds()
    assert uptime is None if not sys.platform.startswith("linux") else uptime > 0


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="fcntl.flock is Linux-only")
def test_real_run_lock_is_exclusive(tmp_path):
    with vm.run_lock(tmp_path) as first:
        with vm.run_lock(tmp_path) as second:
            assert first is True and second is False
            assert vm.lock_held(tmp_path) is True
    assert vm.lock_held(tmp_path) is False
