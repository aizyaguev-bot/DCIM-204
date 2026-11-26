"""PXE runner state machine against the simulated computer, on a virtual clock (no device is contacted)."""
import asyncio
import json
import os
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models import PxeJob, PxeJobEvent, PxeRunSlot
from app.pxe import parsers
from app.pxe.runner import LABELS, TIMEOUTS, PxeRunner, prune_screens
from app.pxe.screen import ScreenDriverError, ScreenText, Text, render_svg, validate_keys
from app.pxe.sim_driver import BOOT_ENTRIES, SCENARIOS, SimulatedMachine

NEW = "192.168.136.101"


class Clock:
    def __init__(self): self.t = 1_800_000_000.0
    def __call__(self): return self.t
    def advance(self, dt): self.t += dt


def make_settings(**overrides):
    values = dict(pxe_old_repo_host="webrepo", pxe_new_repo_host=NEW, pxe_sim_time_scale=0.25, pxe_tick_seconds=0.5,
                  pxe_driver="simulated", pxe_max_active_jobs=1)
    values.update(overrides)
    return SimpleNamespace(**values)


def fast_engine(path):
    """File database (several sessions run concurrently) without fsync, for test speed only."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")

    @event.listens_for(engine.sync_engine, "connect")
    def _pragmas(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.execute("PRAGMA journal_mode=MEMORY")
        cursor.close()
    return engine


@pytest.fixture
async def env(tmp_path):
    engine = fast_engine(tmp_path / "pxe.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings, clock = make_settings(), Clock()
    runner = PxeRunner(sessions, lambda: settings, clock=clock, tick=0.5, screens_dir=tmp_path / "screens", autostart=False)
    yield SimpleNamespace(runner=runner, clock=clock, sessions=sessions, settings=settings, tmp=tmp_path)
    await runner.aclose()
    await engine.dispose()


async def new_job(env, scenario="happy", method="manual", key="opt11", port=1):
    return await env.runner.create(computer={"key": key, "name": key.upper()}, kvm={"device_id": "kvm1", "port": port},
                                   reboot_method=method, pdu_targets=[], scenario=scenario, actor="tester")


async def load(env, job_id):
    async with env.sessions() as db:
        job = await db.get(PxeJob, job_id)
        events = (await db.scalars(select(PxeJobEvent).where(PxeJobEvent.job_id == job_id).order_by(PxeJobEvent.id))).all()
        return job, events


async def drive(env, job_id, **kw):
    return await env.runner.drive(job_id, env.clock.advance, **kw)


async def started(env, scenario="happy", method="manual", **kw):
    job_id = await new_job(env, scenario, method, **kw)
    await env.runner.start(job_id, "tester", "test")
    return job_id, await drive(env, job_id)


def pick(options, predicate):
    return next(o for o in options if predicate(o))


async def choose_boot(env, job_id, option=None):
    job, _ = await load(env, job_id)
    options = json.loads(job.boot_options_json)
    option = option or pick(options, lambda o: o["recommended"])
    await env.runner.choose(job_id, "boot", option["id"], job.version, "tester")
    return await drive(env, job_id)


async def choose_grub(env, job_id, title="Install Rocky Linux 9.4"):
    job, _ = await load(env, job_id)
    option = pick(json.loads(job.grub_options_json), lambda o: o["label"] == title)
    await env.runner.choose(job_id, "grub", option["id"], job.version, "tester")
    return await drive(env, job_id)


async def to_ready(env, scenario="happy", method="manual"):
    job_id, state = await started(env, scenario, method)
    assert state == "waiting_for_choice"
    assert await choose_boot(env, job_id) == "waiting_for_grub_choice"
    assert await choose_grub(env, job_id) == "ready_to_install"
    return job_id


def machine(env, job_id) -> SimulatedMachine:
    return env.runner.device(job_id).machine


# -- happy path ----------------------------------------------------------

@pytest.mark.parametrize("method", ["manual", "kvm_cad", "pdu_cycle"])
async def test_happy_path_end_to_end(env, method):
    job_id, state = await started(env, "happy", method)
    assert state == "waiting_for_choice"
    sim = machine(env, job_id)
    if method == "kvm_cad":
        assert "Ctrl+Alt+Delete" in sim.keys
    if method == "pdu_cycle":
        assert sim.power_cycles == 1
    job, _ = await load(env, job_id)
    options = json.loads(job.boot_options_json)
    assert {o["label"] for o in options} == set(BOOT_ENTRIES)
    assert [o["label"] for o in options] == sim.boot_entries      # order read from screen, not assumed
    recommended = [o for o in options if o["recommended"]]
    assert [o["label"] for o in recommended] == ["UEFI: IPv4 Intel(R) Ethernet Connection I219-LM"]
    assert not pick(options, lambda o: o["label"] == "Windows Boot Manager")["selectable"]

    assert await choose_boot(env, job_id) == "waiting_for_grub_choice"
    job, _ = await load(env, job_id)
    grub = json.loads(job.grub_options_json)
    assert grub[0]["label"] == "Boot from local drive" and not grub[0]["selectable"]
    assert sim.countdown_end is None                               # countdown stopped with Up
    assert "Right" not in sim.keys and sim.keys.count("Enter") == 1

    assert await choose_grub(env, job_id) == "ready_to_install"
    job, _ = await load(env, job_id)
    assert [c["key"] for c in json.loads(job.rewrite_changes_json)["changes"]] == ["inst.repo", "inst.ks"]
    assert "POSTFILE=http://webrepo/post/lab-post.sh" in job.new_cmdline
    assert job.new_cmdline.count(NEW) == 2 and "initrdefi /images/rocky94/initrd.img" in job.new_cmdline
    assert sim.buffer == job.new_cmdline.split("\n") and sim.booted is None

    await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert await drive(env, job_id, until=("install_started",)) == "install_started"
    job, _ = await load(env, job_id)
    assert job.install_may_have_started and job.install_sent_at and job.active_key == "opt11"
    linux = next(line for line in sim.booted if line.startswith("linuxefi"))
    assert f"inst.repo=http://{NEW}/rocky/9.4/BaseOS/x86_64/os" in linux and f"inst.ks=http://{NEW}/ks/rocky94-lab.cfg" in linux

    assert await drive(env, job_id) == "completed"
    job, events = await load(env, job_id)
    assert job.completion_signal == "installed_os_booted" and job.active_key is None and job.active_port_key is None
    states = [e.to_state for e in events if e.from_state != e.to_state]
    assert states == ["draft", "rebooting", "waiting_for_menu", "waiting_for_choice", "waiting_for_grub",
                      "waiting_for_grub_choice", "updating_urls", "ready_to_install", "installing", "install_started", "completed"]
    sent = next(e for e in events if e.action == "install_sent")
    assert sent.id < next(e for e in events if e.to_state == "installing" and e.from_state == "ready_to_install").id
    shots = list((env.tmp / "screens" / job_id).iterdir())
    assert shots and all(p.suffix == ".svg" for p in shots)
    assert env.runner.device(job_id) is None


async def test_completion_never_on_installer_start_alone(env):
    job_id = await to_ready(env)
    job, _ = await load(env, job_id)
    await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert await drive(env, job_id, until=("install_started",)) == "install_started"
    machine(env, job_id).scale = 1000                              # the install now takes a very long time
    for _ in range(20):
        await env.runner.step(job_id)
        env.clock.advance(1)
    assert (await load(env, job_id))[0].state == "install_started"
    await env.runner.complete(job_id, "tester")
    job, _ = await load(env, job_id)
    assert job.state == "completed" and job.completion_signal == "manual" and job.active_key is None


# -- failure scenarios -----------------------------------------------------

async def test_missed_f12(env):
    job_id, state = await started(env, "missed_f12")
    job, _ = await load(env, job_id)
    assert state == "failed" and job.error_code == "boot_menu_timeout" and job.failed_step == "waiting_for_menu"
    assert job.active_key is None and not job.install_may_have_started and job.screenshot_seq > 0


async def test_no_pxe_entry(env):
    job_id, state = await started(env, "no_pxe_entry")
    job, _ = await load(env, job_id)
    assert state == "failed" and job.error_code == "no_pxe_entry"
    assert not any(o["selectable"] for o in json.loads(job.boot_options_json))


async def test_countdown_expires(env):
    job_id, _ = await started(env, "countdown_expires")
    assert await choose_boot(env, job_id) == "failed"
    job, _ = await load(env, job_id)
    assert job.error_code == "grub_countdown_expired" and job.failed_step == "waiting_for_grub"
    assert not job.install_may_have_started and job.active_key is None


async def test_grub_password(env):
    job_id, _ = await started(env, "grub_password")
    sim = machine(env, job_id)
    assert await choose_boot(env, job_id) == "waiting_for_grub_choice"
    assert await choose_grub(env, job_id) == "failed"
    job, _ = await load(env, job_id)
    assert job.error_code == "grub_password" and sim.phase == "grub" and sim.keys[-1] == "Esc"


@pytest.mark.parametrize("scenario,code", [("missing_inst_ks", "missing_key"), ("duplicate_inst_repo", "ambiguous_key")])
async def test_rewrite_errors_discard_edit(env, scenario, code):
    job_id, _ = await started(env, scenario)
    sim = machine(env, job_id)
    assert await choose_boot(env, job_id) == "waiting_for_grub_choice"
    assert await choose_grub(env, job_id) == "failed"
    job, _ = await load(env, job_id)
    assert job.error_code == code and job.failed_step == "updating_urls"
    assert sim.phase == "grub" and sim.booted is None and not any(isinstance(k, Text) for k in sim.keys)


async def test_ocr_noise_never_acts_on_low_confidence_reads(env):
    job_id = await to_ready(env, "ocr_noise")
    sim = machine(env, job_id)
    job, _ = await load(env, job_id)
    assert "lntel" not in job.boot_options_json and "Intel" in job.boot_options_json
    await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert await drive(env, job_id) == "completed"
    assert sim.reads > 10


async def test_kvm_disconnect(env):
    job_id, _ = await started(env, "kvm_disconnect")
    assert await choose_boot(env, job_id) == "failed"
    job, events = await load(env, job_id)
    assert job.error_code == "kvm_disconnected" and job.failed_step == "waiting_for_grub"
    # the GRUB countdown kept running unseen, so an install entry may have booted: Admin must acknowledge
    assert job.install_may_have_started and job.active_key == "opt11"
    assert "reconnected" not in [e.action for e in events]


async def test_installer_error_keeps_computer_blocked_until_acknowledged(env):
    job_id = await to_ready(env, "installer_error")
    job, _ = await load(env, job_id)
    await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert await drive(env, job_id) == "failed"
    job, _ = await load(env, job_id)
    assert job.error_code == "installer_error" and job.install_may_have_started and job.active_key == "opt11"
    with pytest.raises(HTTPException) as exc:
        await new_job(env)
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        await env.runner.cancel(job_id, "tester")
    assert exc.value.status_code == 409
    await env.runner.acknowledge(job_id, "admin")
    assert (await load(env, job_id))[0].active_key is None
    assert await new_job(env)


def test_every_scenario_is_covered():
    covered = {"happy", "missed_f12", "no_pxe_entry", "countdown_expires", "grub_password", "missing_inst_ks",
               "duplicate_inst_repo", "ocr_noise", "kvm_disconnect", "installer_error"}
    assert covered == set(SCENARIOS)


# -- safety rules -------------------------------------------------------------

async def test_user_timeout(env):
    job_id, state = await started(env)
    assert state == "waiting_for_choice"
    env.clock.advance(601)
    assert await env.runner.step(job_id) is None
    job, _ = await load(env, job_id)
    assert job.state == "failed" and job.error_code == "user_timeout" and job.active_key is None


async def test_ready_to_install_timeout_discards_edit(env):
    job_id = await to_ready(env)
    sim = machine(env, job_id)
    env.clock.advance(901)
    await env.runner.step(job_id)
    job, _ = await load(env, job_id)
    assert job.error_code == "user_timeout" and sim.phase == "grub" and "Ctrl+X" not in sim.keys


async def test_reboot_timeout(env):
    job_id = await new_job(env)
    await env.runner.start(job_id, "tester", "")
    machine(env, job_id).reboot_at = None                    # nobody reboots the computer
    for _ in range(3):
        assert await env.runner.step(job_id) is not None
        env.clock.advance(0.5)
    env.clock.advance(180)
    assert await env.runner.step(job_id) is None
    job, _ = await load(env, job_id)
    assert job.state == "failed" and job.error_code == "reboot_timeout" and job.failed_step == "rebooting"


async def test_pdu_cycle_failure_stops_the_job_instead_of_waiting_for_a_restart(env):
    simulated = env.runner.factory

    class BrokenPower:
        async def cycle(self):
            raise ScreenDriverError("PDU is in maintenance mode")

    def factory(job):
        device = simulated(job)
        device.power = BrokenPower()
        return device

    env.runner.factory = factory
    job_id = await new_job(env, method="pdu_cycle")
    await env.runner.start(job_id, "tester", "")
    started_at = env.clock()
    assert await drive(env, job_id) == "failed"
    job, events = await load(env, job_id)
    assert job.error_code == "power_cycle_failed" and job.failed_step == "rebooting"
    assert "maintenance" in job.error_detail and env.clock() - started_at < TIMEOUTS["rebooting"]
    assert "reconnected" not in [e.action for e in events] and job.active_key is None


async def test_rewrite_verify_failure_discards_edit(env):
    job_id, _ = await started(env)
    sim = machine(env, job_id)
    assert await choose_boot(env, job_id) == "waiting_for_grub_choice"
    sim.faults.add("drop_last_char")                          # a keystroke is lost while typing
    assert await choose_grub(env, job_id) == "failed"
    job, _ = await load(env, job_id)
    assert job.error_code == "rewrite_verify" and sim.phase == "grub" and sim.booted is None


async def test_install_blocked_when_screen_changed(env):
    job_id = await to_ready(env)
    sim = machine(env, job_id)
    sim.buffer[1] += " rd.break"                              # someone typed on the console
    job, _ = await load(env, job_id)
    with pytest.raises(HTTPException) as exc:
        await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert exc.value.status_code == 409
    job, events = await load(env, job_id)
    assert job.state == "ready_to_install" and job.install_sent_at is None and "Ctrl+X" not in sim.keys
    assert events[-1].action == "install_blocked"


async def test_install_rejects_wrong_hash(env):
    job_id = await to_ready(env)
    with pytest.raises(HTTPException) as exc:
        await env.runner.install(job_id, "0" * 32, "tester")
    assert exc.value.status_code == 409 and "Ctrl+X" not in machine(env, job_id).keys


async def test_install_flag_is_persisted_before_ctrl_x(env):
    job_id = await to_ready(env)
    device = env.runner.device(job_id)
    original, seen = device.screen.send_keys, []

    async def spy(seq):
        if "Ctrl+X" in seq:
            async with env.sessions() as db:
                row = await db.get(PxeJob, job_id)
                seen.append((row.install_sent_at, row.install_may_have_started, row.state))
        await original(seq)

    device.screen.send_keys = spy
    job, _ = await load(env, job_id)
    await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert len(seen) == 1 and seen[0][0] is not None and seen[0][1] is True and seen[0][2] == "ready_to_install"


async def test_install_send_failure_never_retries(env):
    job_id = await to_ready(env)
    device = env.runner.device(job_id)
    calls = []

    async def broken(seq):
        calls.append(seq)
        from app.pxe.screen import ScreenDriverError
        raise ScreenDriverError("KVM session disconnected")

    device.screen.send_keys = broken
    job, _ = await load(env, job_id)
    with pytest.raises(HTTPException) as exc:
        await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert exc.value.status_code == 502 and calls == [["Ctrl+X"]]
    job, _ = await load(env, job_id)
    assert job.state == "failed" and job.error_code == "install_send_failed" and job.install_may_have_started
    assert job.active_key == "opt11"


async def test_cancel_before_install_discards_edit_and_releases(env):
    job_id = await to_ready(env)
    sim = machine(env, job_id)
    await env.runner.cancel(job_id, "tester")
    job, _ = await load(env, job_id)
    assert job.state == "cancelled" and job.active_key is None and sim.phase == "grub" and sim.keys[-1] == "Esc"
    assert env.runner.device(job_id) is None


async def test_cancel_after_install_is_conflict_and_takeover_works(env):
    job_id = await to_ready(env)
    job, _ = await load(env, job_id)
    await env.runner.install(job_id, job.rewrite_hash, "tester")
    with pytest.raises(HTTPException) as exc:
        await env.runner.cancel(job_id, "tester")
    assert exc.value.status_code == 409
    assert await env.runner.takeover(job_id, "tester") == {"console_url": None, "simulated": True}
    job, _ = await load(env, job_id)
    assert job.state == "manual_takeover" and job.active_key == "opt11" and env.runner.device(job_id) is None
    await env.runner.acknowledge(job_id, "admin")
    assert (await load(env, job_id))[0].active_key is None


async def test_stale_version_unknown_and_unselectable_options(env):
    job_id, _ = await started(env)
    job, _ = await load(env, job_id)
    options = json.loads(job.boot_options_json)
    good = pick(options, lambda o: o["recommended"])
    windows = pick(options, lambda o: o["label"] == "Windows Boot Manager")
    for option_id, version, status in ((good["id"], job.version - 1, 409), ("o0-deadbeef", job.version, 422),
                                       (windows["id"], job.version, 422)):
        with pytest.raises(HTTPException) as exc:
            await env.runner.choose(job_id, "boot", option_id, version, "tester")
        assert exc.value.status_code == status
    with pytest.raises(HTTPException) as exc:
        await env.runner.choose(job_id, "grub", good["id"], job.version, "tester")
    assert exc.value.status_code == 409
    assert "Enter" not in machine(env, job_id).keys


async def test_menu_changed_on_screen_requires_new_review(env):
    job_id, _ = await started(env)
    sim = machine(env, job_id)
    job, _ = await load(env, job_id)
    good = pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
    sim.boot_entries.reverse()
    with pytest.raises(HTTPException) as exc:
        await env.runner.choose(job_id, "boot", good["id"], job.version, "tester")
    assert exc.value.status_code == 409
    fresh, _ = await load(env, job_id)
    assert fresh.version == job.version + 1 and [o["label"] for o in json.loads(fresh.boot_options_json)] == sim.boot_entries
    assert "Enter" not in sim.keys
    assert await choose_boot(env, job_id) == "waiting_for_grub_choice"


async def test_highlight_mismatch_never_presses_enter(env):
    job_id, _ = await started(env)
    sim = machine(env, job_id)
    job, _ = await load(env, job_id)
    options = json.loads(job.boot_options_json)
    target = next(o for o in options if o["selectable"] and not o["highlighted"])
    original = sim.press
    sim.press = lambda key: None if key in ("Up", "Down") else original(key)   # arrow keys are lost
    with pytest.raises(HTTPException) as exc:
        await env.runner.choose(job_id, "boot", target["id"], job.version, "tester")
    assert exc.value.status_code == 409 and "Enter" not in sim.keys
    assert (await load(env, job_id))[0].state == "waiting_for_choice"


async def test_one_active_job_per_computer_and_port_and_global_limit(env):
    first = await new_job(env)
    for kwargs in ({"key": "opt11", "port": 2}, {"key": "opt12", "port": 1}):
        with pytest.raises(HTTPException) as exc:
            await new_job(env, **kwargs)
        assert exc.value.status_code == 409
    second = await new_job(env, key="opt12", port=2)
    await env.runner.start(first, "tester", "")
    with pytest.raises(HTTPException) as exc:
        await env.runner.start(second, "tester", "")
    assert exc.value.status_code == 409
    await env.runner.cancel(first, "tester")
    await env.runner.start(second, "tester", "")


def second_server(env, owner="server-b"):
    """Another server instance on the same database (own owner id, locks and console sessions)."""
    return PxeRunner(env.sessions, lambda: env.settings, clock=env.clock, tick=0.5,
                     screens_dir=env.tmp / "screens", autostart=False, owner=owner)


def on_read(env, job_id, action):
    """Runs `action` once, on the next console read of this job (between the runner's read and its next key)."""
    screen = env.runner.device(job_id).screen
    original, fired = screen.read_text, []

    async def hooked():
        if not fired:
            fired.append(True)
            await action()
        return await original()

    screen.read_text = hooked
    return fired


async def test_cancel_on_other_server_before_ctrl_x_sends_nothing(env):
    job_id = await to_ready(env)
    sim, other = machine(env, job_id), second_server(env)
    job, _ = await load(env, job_id)
    fired = on_read(env, job_id, lambda: other.cancel(job_id, "operator-b"))
    with pytest.raises(HTTPException) as exc:
        await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert fired and exc.value.status_code == 409
    job, events = await load(env, job_id)
    assert job.state == "cancelled" and job.install_sent_at is None and job.active_key is None
    assert "Ctrl+X" not in sim.keys and sim.booted is None
    assert "install_sent" not in [e.action for e in events]


async def test_cancel_on_other_server_between_steps_stops_the_runner(env):
    job_id = await new_job(env)
    await env.runner.start(job_id, "tester", "")
    sim, other = machine(env, job_id), second_server(env)
    sent_at_cancel = []

    async def cancel_elsewhere():
        await other.cancel(job_id, "operator-b")
        sent_at_cancel.append(len(sim.keys))

    assert await env.runner.step(job_id) is not None       # manual reboot requested
    env.clock.advance(0.6)                                 # the computer is restarting now
    on_read(env, job_id, cancel_elsewhere)
    assert await env.runner.step(job_id) is not None       # restart seen; F12 would be next
    assert sent_at_cancel and sim.phase in ("shutdown", "post")
    assert await env.runner.step(job_id) is None
    assert len(sim.keys) == sent_at_cancel[0] and "F12" not in sim.keys
    assert (await load(env, job_id))[0].state == "cancelled" and env.runner.device(job_id) is None


async def test_takeover_on_other_server_stops_monitoring(env):
    job_id = await to_ready(env)
    job, _ = await load(env, job_id)
    await env.runner.install(job_id, job.rewrite_hash, "tester")
    sim = machine(env, job_id)
    keys = len(sim.keys)
    assert await second_server(env).takeover(job_id, "operator-b") == {"console_url": None, "simulated": True}
    assert await env.runner.step(job_id) is None
    job, _ = await load(env, job_id)
    assert job.state == "manual_takeover" and job.active_key == "opt11" and len(sim.keys) == keys
    assert env.runner.device(job_id) is None


async def test_lost_lease_blocks_keys(env):
    job_id, _ = await started(env)
    sim = machine(env, job_id)
    async with env.sessions() as db:                       # another worker claimed the lease
        row = await db.get(PxeJob, job_id)
        row.lease_owner, row.lease_until = "server-b", env.clock() + 30
        await db.commit()
    job, _ = await load(env, job_id)
    option = pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
    with pytest.raises(HTTPException) as exc:
        await env.runner.choose(job_id, "boot", option["id"], job.version, "tester")
    assert exc.value.status_code == 409 and "Enter" not in sim.keys


async def test_real_driver_takeover_returns_console_url(env):
    async with env.sessions() as db:
        db.add(PxeJob(id="c" * 32, computer_key="opt13", computer_name="OPT13", kvm_device_id="kvm 2", kvm_port=3,
                      reboot_method="kvm_cad", driver="raritan", state="failed", state_entered_at=env.clock(),
                      deadline_at=env.clock(), created_by="tester", created_at=env.clock(), updated_at=env.clock()))
        await db.commit()
    assert await env.runner.takeover("c" * 32, "tester") == {"console_url": "/api/kvms/kvm%202/autologin?port=3",
                                                             "simulated": False}


async def test_choice_after_deadline_expires_without_keys(env):
    job_id, _ = await started(env)
    sim = machine(env, job_id)
    keys = len(sim.keys)
    job, _ = await load(env, job_id)
    option = pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
    env.clock.advance(601)                                 # the runner did not step in between
    with pytest.raises(HTTPException) as exc:
        await env.runner.choose(job_id, "boot", option["id"], job.version, "tester")
    assert exc.value.status_code == 409 and len(sim.keys) == keys
    job, _ = await load(env, job_id)
    assert job.state == "failed" and job.error_code == "user_timeout" and job.active_key is None


async def test_install_after_deadline_discards_edit_without_ctrl_x(env):
    job_id = await to_ready(env)
    sim = machine(env, job_id)
    job, _ = await load(env, job_id)
    env.clock.advance(901)
    with pytest.raises(HTTPException) as exc:
        await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert exc.value.status_code == 409 and "Ctrl+X" not in sim.keys and sim.keys[-1] == "Esc" and sim.phase == "grub"
    job, _ = await load(env, job_id)
    assert job.state == "failed" and job.error_code == "user_timeout" and job.install_sent_at is None


async def test_deadline_passing_during_install_check_blocks_ctrl_x(env):
    job_id = await to_ready(env)
    sim = machine(env, job_id)
    job, _ = await load(env, job_id)

    async def slow_read():
        env.clock.advance(901)                             # the screen read took past the deadline

    on_read(env, job_id, slow_read)
    with pytest.raises(HTTPException) as exc:
        await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert exc.value.status_code == 409 and "Ctrl+X" not in sim.keys and sim.keys[-1] == "Esc"
    assert (await load(env, job_id))[0].error_code == "user_timeout"


async def test_global_limit_is_atomic_across_servers(env):
    first, second = await new_job(env), await new_job(env, key="opt12", port=2)
    other = second_server(env)
    results = await asyncio.gather(env.runner.start(first, "tester", ""), other.start(second, "tester", ""),
                                   return_exceptions=True)
    failures = [r for r in results if isinstance(r, Exception)]
    assert len(failures) == 1 and isinstance(failures[0], HTTPException) and failures[0].status_code == 409
    async with env.sessions() as db:
        states = sorted([(await db.get(PxeJob, first)).state, (await db.get(PxeJob, second)).state])
        slots = (await db.scalars(select(PxeRunSlot))).all()
    assert states == ["draft", "rebooting"] and len(slots) == 1
    loser = second if results[0] is None else first
    winner = first if loser == second else second
    assert (env.runner if loser == first else other).device(loser) is None
    await (env.runner if winner == first else other).cancel(winner, "tester")
    async with env.sessions() as db:
        assert (await db.scalars(select(PxeRunSlot))).all() == []
    await (env.runner if loser == first else other).start(loser, "tester", "")
    await other.aclose()


async def test_installer_error_right_after_countdown_needs_acknowledge(env):
    job_id, _ = await started(env)
    job, _ = await load(env, job_id)
    option = pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
    await env.runner.choose(job_id, "boot", option["id"], job.version, "tester")
    machine(env, job_id).phase = "install_error"          # sampling missed the GRUB menu and the kernel screen
    assert await drive(env, job_id) == "failed"
    job, _ = await load(env, job_id)
    assert job.error_code == "grub_countdown_expired" and job.failed_step == "waiting_for_grub"
    assert job.install_may_have_started and job.active_key == "opt11" and job.install_sent_at is None
    with pytest.raises(HTTPException):
        await new_job(env)
    await env.runner.acknowledge(job_id, "admin")
    assert await new_job(env)


async def test_old_os_login_without_installer_reboot_never_completes(env):
    job_id = await to_ready(env)
    job, _ = await load(env, job_id)
    await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert await drive(env, job_id, until=("install_started",)) == "install_started"
    sim = machine(env, job_id)
    sim.phase = "os"                                       # the old system's login, no reboot seen since the installer
    for _ in range(20):
        assert await env.runner.step(job_id) is not None
        env.clock.advance(0.5)
    job, events = await load(env, job_id)
    assert job.state == "install_started" and "installer_reboot" not in [e.action for e in events]
    sim.phase, sim.phase_at = "installing", env.clock()   # the installer runs on and reboots into the new system
    assert await drive(env, job_id) == "completed"
    job, events = await load(env, job_id)
    actions = [e.action for e in events]
    assert job.completion_signal == "installed_os_booted"
    assert actions.index("installer_reboot") < max(i for i, e in enumerate(events) if e.to_state == "completed")


async def test_draft_expires(env):
    job_id = await new_job(env)
    env.clock.advance(901)
    with pytest.raises(HTTPException) as exc:
        await env.runner.start(job_id, "tester", "")
    assert exc.value.status_code == 409
    job, _ = await load(env, job_id)
    assert job.state == "cancelled" and job.error_code == "draft_expired" and job.active_key is None


async def test_restart_fails_pre_install_and_monitors_post_install(env):
    waiting, _ = await started(env)
    async with env.sessions() as db:                       # a second job already past Ctrl+X
        row = PxeJob(id="b" * 32, computer_key="opt12", computer_name="OPT12", kvm_device_id="kvm1", kvm_port=2,
                     reboot_method="manual", driver="simulated", state="installing", state_entered_at=env.clock(),
                     deadline_at=env.clock() + 300, install_sent_at=env.clock(), install_may_have_started=True,
                     active_key="opt12", active_port_key="kvm1:2", lease_owner="old-process", lease_until=env.clock() + 30,
                     created_by="tester", created_at=env.clock(), updated_at=env.clock())
        db.add(row)
        await db.commit()
    restarted = PxeRunner(env.sessions, lambda: env.settings, clock=env.clock, tick=0.5,
                          screens_dir=env.tmp / "screens", autostart=False)
    await restarted.recover(force=True)                     # leases still valid: another worker owns both jobs
    assert (await load(env, waiting))[0].state == "waiting_for_choice"
    assert (await load(env, "b" * 32))[1] == []
    await env.runner.aclose()                               # the first process is gone
    env.clock.advance(31)                                   # and its leases expired
    await restarted.recover(force=True)
    job, _ = await load(env, waiting)
    assert job.state == "failed" and job.error_code == "interrupted" and job.active_key is None
    post, events = await load(env, "b" * 32)
    assert post.state == "installing" and events[-1].action == "passive_monitor"
    assert await restarted.step("b" * 32) is not None
    env.clock.advance(300)
    assert await restarted.step("b" * 32) is None
    post, _ = await load(env, "b" * 32)
    assert post.state == "failed" and post.error_code == "installer_timeout" and post.active_key == "opt12"
    await restarted.aclose()


async def test_background_tasks_run_the_flow_in_real_time(tmp_path):
    engine = fast_engine(tmp_path / "bg.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    settings = make_settings(pxe_sim_time_scale=0.05)
    runner = PxeRunner(sessions, lambda: settings, tick=0.01, screens_dir=tmp_path / "s")

    async def wait_for(job_id, *states):
        for _ in range(1000):
            async with sessions() as db:
                job = await db.get(PxeJob, job_id)
            if job.state in states:
                return job
            await asyncio.sleep(0.01)
        raise AssertionError(job.state)

    try:
        job_id = await runner.create(computer={"key": "opt11", "name": "OPT11"}, kvm={"device_id": "kvm1", "port": 1},
                                     reboot_method="kvm_cad", pdu_targets=[], scenario="happy", actor="tester")
        await runner.start(job_id, "tester", "")
        job = await wait_for(job_id, "waiting_for_choice", "failed")
        assert job.state == "waiting_for_choice", job.error_code
        option = pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
        await runner.choose(job_id, "boot", option["id"], job.version, "tester")
        job = await wait_for(job_id, "waiting_for_grub_choice", "failed")
        option = pick(json.loads(job.grub_options_json), lambda o: o["selectable"])
        await runner.choose(job_id, "grub", option["id"], job.version, "tester")
        job = await wait_for(job_id, "ready_to_install", "failed")
        await runner.install(job_id, job.rewrite_hash, "tester")
        job = await wait_for(job_id, "completed", "failed")
        assert job.state == "completed"
    finally:
        await runner.aclose()
        await engine.dispose()


# -- building blocks -----------------------------------------------------------

def test_key_allowlist():
    assert validate_keys(["F12", "Ctrl+X", Text("192.168.136.101")]) == ["F12", "Ctrl+X", "192.168.136.101"]
    for bad in (["Tab"], ["a"], ["Ctrl+C"], ["F12", "rm -rf"], [1]):
        with pytest.raises(ValueError):
            validate_keys(bad)
    for bad in ("a b", "host/x", "", "x;y", "é"):
        with pytest.raises(ValueError):
            Text(bad)


def test_svg_is_escaped():
    svg = render_svg(ScreenText(['<script>alert("x")</script> & \x07'], 0, 80, 1, 1.0, "test")).decode()
    assert "<script>" not in svg and "&lt;script&gt;" in svg and "&amp;" in svg and "&quot;" in svg


def test_screens_older_than_seven_days_are_pruned(tmp_path):
    old_dir, new_dir = tmp_path / ("a" * 32), tmp_path / ("b" * 32)
    old_dir.mkdir(), new_dir.mkdir()
    old, new = old_dir / "00001.svg", new_dir / "00001.svg"
    old.write_text("x"), new.write_text("y")
    stamp = time.time() - 8 * 86400
    os.utime(old, (stamp, stamp))
    prune_screens(tmp_path)
    assert not old_dir.exists() and new.exists()


def test_parsers_do_not_assume_order():
    sim = SimulatedMachine("seed-a", clock=Clock())
    other = SimulatedMachine("seed-b", clock=Clock())
    assert sim.boot_entries != other.boot_entries or sim.grub_entries != other.grub_entries
    for machine_ in (sim, other):
        machine_.phase = "boot_menu"
        menu = parsers.detect_boot_menu(machine_.screen())
        assert menu.options == machine_.boot_entries and menu.options[menu.highlight].startswith("UEFI: IPv4 Intel")


def test_hebrew_labels():
    assert LABELS["rebooting"] == "מאתחל" and LABELS["waiting_for_menu"] == LABELS["waiting_for_grub"] == "ממתין לתפריט"
    assert LABELS["waiting_for_choice"] == LABELS["waiting_for_grub_choice"] == "ממתין לבחירה"
    assert LABELS["updating_urls"] == "מעדכן כתובות" and LABELS["installing"] == LABELS["install_started"] == "מתקין"
    assert LABELS["completed"] == "ההתקנה הושלמה"
    assert all(LABELS.get(s) for s in ("failed", "cancelled", "manual_takeover", "draft", "ready_to_install"))
