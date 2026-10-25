"""Gap tests for remote PXE install: validation and refusal paths not covered by test_pxe_*.

Everything runs against the simulated console, fake drivers and an in-test database. No KVM, PDU,
computer, VM or live site is contacted.
"""
import json
import shutil
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

import app.routers.kvms as kvms_module
import app.routers.pdus as pdus_module
import tests.test_pxe_api as A
import tests.test_pxe_sim as S
from app.models import Device, PxeJob, PxeRunSlot
from app.pxe import mapping, parsers, raritan_driver
from app.pxe.rewrite import RewriteError, key_hosts, rewrite_install_urls
from app.pxe.runner import JobDevice, PxeRunner, edit_keys, job_dto
from app.pxe.screen import ScreenDriverError, ScreenText, Text
from app.pxe.sim_driver import LOCAL, RESCUE
from app.routers import pxe as pxe_router
from tests.test_pxe_api import api  # noqa: F401  (fixture)
from tests.test_pxe_sim import env  # noqa: F401  (fixture)

SHARED = A.SHARED
NEW = S.NEW


async def _jobs(api):
    async with api.sessions() as db:
        return (await db.scalars(select(PxeJob))).all()


async def _row(api, job_id):
    async with api.sessions() as db:
        return await db.get(PxeJob, job_id)


async def _actions(api, job_id):
    return [e.action for e in await A.events(api, job_id)]


def _sim(api, job_id):
    return api.runner.device(job_id).machine


# -- request validation ----------------------------------------------------------

async def test_new_job_body_bounds_are_rejected_without_creating_a_job(api):
    bad_bodies = [
        {"computer_key": ""},
        {"computer_key": "O" * 121},
        {"computer_key": "OPT11", "kvm_port": 0, "kvm_device_id": "kvm1"},
        {"computer_key": "OPT11", "kvm_port": 4097, "kvm_device_id": "kvm1"},
        {"computer_key": "OPT11", "kvm_device_id": "", "kvm_port": 1},
        {"computer_key": "OPT11", "sim_scenario": "h" * 41},
        {"computer_key": "OPT11", "kvm_port": 1},                     # a port without its KVM unit
        {"computer_key": "OPT11", "reboot_method": "Manual"},          # methods are case-sensitive literals
        {"computer_key": "OPT11", "keys": ["F12"]},
    ]
    for body in bad_bodies:
        r = await api.c.post("/api/pxe/jobs", json=body)
        assert r.status_code == 422, (body, r.text)
    assert await _jobs(api) == []


async def test_choice_body_validation_sends_no_key(api):
    job_id = await A.started(api)
    job = await A.get_job(api, job_id)
    option = A.pick(job["options"], lambda o: o["recommended"])
    sim = _sim(api, job_id)
    keys_before = list(sim.keys)
    for body in ({"option_id": option["id"], "version": job["version"], "extra": 1},
                 {"option_id": "", "version": job["version"]},
                 {"option_id": "o" * 65, "version": job["version"]},
                 {"option_id": option["id"]},
                 {"option_id": option["id"], "version": "latest"}):
        r = await A.post(api, job_id, "choose-boot", body)
        assert r.status_code == 422, (body, r.text)
    after = await A.get_job(api, job_id)
    assert after["state"] == "waiting_for_choice" and after["version"] == job["version"]
    assert sim.keys == keys_before and "Enter" not in sim.keys


async def test_password_body_must_be_a_json_object(api):
    job_id = (await A.create(api)).json()["id"]
    url = f"/api/pxe/jobs/{job_id}/start"
    for kwargs in ({"content": b"password=" + SHARED.encode(), "headers": {"content-type": "application/json"}},
                   {"json": [SHARED]}, {"json": SHARED}, {}):
        r = await api.c.post(url, **kwargs)
        assert r.status_code == 400 and r.json()["detail"] == "Invalid request body", r.text
        assert SHARED not in r.text
    assert (await A.get_job(api, job_id))["state"] == "draft"
    assert "denied" not in await _actions(api, job_id)


async def test_job_and_state_are_checked_before_the_password_and_do_not_use_the_throttle(api):
    job_id = (await A.create(api)).json()["id"]
    wrong = {"password": "wrong-password"}
    for _ in range(4):
        assert (await A.post(api, "f" * 32, "start", wrong)).status_code == 404
        assert (await A.post(api, job_id, "install", wrong)).status_code == 409
        assert (await A.post(api, job_id, "complete", wrong)).status_code == 409
    # 12 wrong passwords above, more than the limit of 10, but none was checked, so nothing is throttled.
    assert "denied" not in await _actions(api, job_id)
    r = await A.post(api, job_id, "start", {"password": SHARED})
    assert r.status_code == 200 and r.json()["state"] == "rebooting"


async def test_start_install_and_complete_refuse_without_a_configured_password(api):
    job_id = (await A.create(api)).json()["id"]
    api.settings.lab_manager_password = ""
    for action in ("start", "install", "complete"):
        r = await A.post(api, job_id, action, {"password": SHARED})
        assert r.status_code == 403, (action, r.text)
        assert r.json()["detail"] == "Remote install actions require a configured password"
    assert (await A.get_job(api, job_id))["state"] == "draft"
    assert set(await _actions(api, job_id)) == {"create"}


async def test_install_rejects_a_reviewed_hash_that_is_not_the_exact_string(api):
    job_id = await A.to_ready(api)
    job = await A.get_job(api, job_id)
    good = job["rewrite"]["hash"]
    for bad in (12345, [good], {"hash": good}, good.upper(), None):
        r = await A.post(api, job_id, "install", {"password": SHARED, "rewrite_hash": bad})
        assert r.status_code == 409, (bad, r.text)
    row = await _row(api, job_id)
    assert row.state == "ready_to_install" and row.install_sent_at is None and not row.install_may_have_started
    assert "Ctrl+X" not in _sim(api, job_id).keys
    assert "install_sent" not in await _actions(api, job_id)


# -- screenshots ----------------------------------------------------------------

async def test_screenshot_refusals_and_safe_headers(api):
    draft_id = (await A.create(api, computer_key="Optn87", kvm_device_id="kvm2", kvm_port=1)).json()["id"]
    r = await api.c.get(f"/api/pxe/jobs/{draft_id}/screenshot")
    assert r.status_code == 404 and r.json()["detail"] == "No screenshot"
    assert (await api.c.get(f"/api/pxe/jobs/{'e' * 32}/screenshot")).status_code == 404
    assert (await api.c.get(f"/api/pxe/jobs/{'A' * 32}/screenshot")).json()["detail"] == "Job not found"
    assert (await api.c.get(f"/api/pxe/jobs/{'a' * 31}/screenshot")).status_code == 404

    job_id = await A.started(api)
    shot = await api.c.get(f"/api/pxe/jobs/{job_id}/screenshot")
    assert shot.status_code == 200
    assert shot.headers["x-content-type-options"] == "nosniff"
    assert shot.headers["content-security-policy"] == "default-src 'none'; style-src 'unsafe-inline'"
    shutil.rmtree(api.runner.screens_dir / job_id)                       # pruned or deleted on disk
    r = await api.c.get(f"/api/pxe/jobs/{job_id}/screenshot")
    assert r.status_code == 404 and r.json()["detail"] == "No screenshot"


async def test_refresh_screenshot_failure_is_502_and_keeps_the_sequence(api):
    job_id = await A.started(api)
    seq = (await A.get_job(api, job_id))["screenshot_seq"]
    assert seq > 0
    screen = api.runner.device(job_id).screen

    async def jpeg():
        return b"\xff\xd8\xff", "image/jpeg"                              # not a type the API serves

    screen.screenshot = jpeg
    r = await A.post(api, job_id, "refresh-screenshot")
    assert r.status_code == 502 and r.json()["detail"] == "KVM console session failed"
    assert (await A.get_job(api, job_id))["screenshot_seq"] == seq
    assert not [p for p in (api.runner.screens_dir / job_id).iterdir() if p.suffix not in (".svg", ".png")]
    again = await A.post(api, job_id, "refresh-screenshot")
    assert again.status_code == 429 and again.headers["retry-after"] == "2"
    assert "refresh_screenshot" not in await _actions(api, job_id)


# -- configuration and driver gates -------------------------------------------------

async def test_unknown_default_scenario_falls_back_to_happy_and_raritan_hides_scenarios(api, monkeypatch):
    api.settings.pxe_sim_scenario = "bogus"
    r = await A.create(api)
    assert r.status_code == 201 and r.json()["sim_scenario"] == "happy"
    api.settings.pxe_sim_scenario = "missed_f12"
    r = await A.create(api, computer_key="Optn87", kvm_device_id="kvm2", kvm_port=1)
    assert r.status_code == 201 and r.json()["sim_scenario"] == "missed_f12"
    r = await A.create(api, computer_key="Optn84", kvm_device_id="kvm1", kvm_port=2, sim_scenario="no_pxe_entry")
    assert r.status_code == 201 and r.json()["sim_scenario"] == "no_pxe_entry"

    monkeypatch.setattr(pxe_router, "driver_ready", lambda: False)
    api.settings.pxe_driver = "raritan"
    config = (await api.c.get("/api/pxe/config")).json()
    assert config["available"] is False and config["scenarios"] == [] and config["default_scenario"] is None


async def test_a_raritan_draft_never_falls_back_to_the_simulator(api, monkeypatch):
    monkeypatch.setattr(pxe_router, "driver_ready", lambda: True)
    monkeypatch.setattr(raritan_driver, "driver_ready", lambda: False)   # the runner's own check; no browser
    api.settings.pxe_driver, api.settings.pxe_allowed_computers = "raritan", "OPT11"
    created = await A.create(api)
    assert created.status_code == 201 and created.json()["driver"] == "raritan"
    job_id = created.json()["id"]
    api.settings.pxe_driver = "simulated"                                 # the server is switched back
    r = await A.post(api, job_id, "start", {"password": SHARED})
    assert r.status_code == 503 and r.json()["detail"] == "The Raritan console driver is not available in this phase"
    row = await _row(api, job_id)
    assert row.state == "draft" and row.driver == "raritan" and row.lease_owner == ""
    assert api.runner.device(job_id) is None
    async with api.sessions() as db:
        assert (await db.scalars(select(PxeRunSlot))).all() == []
    assert "start" not in await _actions(api, job_id)


async def test_console_open_failure_on_start_keeps_the_draft_and_releases_the_lease(api):
    original = api.runner.factory

    class BrokenScreen:
        async def open(self):
            raise ScreenDriverError("login rejected for admin:hunter2@192.0.2.20")

        async def close(self):
            pass

    api.runner.factory = lambda job: JobDevice(BrokenScreen())
    job_id = (await A.create(api)).json()["id"]
    r = await A.post(api, job_id, "start", {"password": SHARED})
    assert r.status_code == 502 and r.json()["detail"] == "KVM console session failed"
    assert "hunter2" not in r.text and "192.0.2.20" not in r.text
    row = await _row(api, job_id)
    assert row.state == "draft" and row.lease_owner == "" and row.lease_until == 0
    async with api.sessions() as db:
        assert (await db.scalars(select(PxeRunSlot))).all() == []

    api.runner.factory = original                                          # the console works again
    r = await A.post(api, job_id, "start", {"password": SHARED})
    assert r.status_code == 200 and r.json()["state"] == "rebooting"


# -- actions refused by state ---------------------------------------------------------

async def test_draft_and_closed_jobs_refuse_console_actions(api):
    job_id = (await A.create(api)).json()["id"]
    choice = {"option_id": "o0-deadbeef", "version": 1}
    expected = {"refresh-screenshot": "No console session for this job",
                "takeover": "This job cannot be taken over",
                "acknowledge": "Nothing to acknowledge for this job",
                "choose-boot": "The job is not waiting for this action",
                "choose-grub": "The job is not waiting for this action"}
    for action, detail in expected.items():
        r = await A.post(api, job_id, action, choice if action.startswith("choose") else None)
        assert r.status_code == 409 and r.json()["detail"] == detail, (action, r.text)
    assert (await A.get_job(api, job_id))["state"] == "draft"

    assert (await A.post(api, job_id, "cancel")).status_code == 200
    for action in ("refresh-screenshot", "takeover", "acknowledge"):
        assert (await A.post(api, job_id, action)).status_code == 409, action
    assert (await A.post(api, job_id, "start", {"password": SHARED})).status_code == 409
    assert set(await _actions(api, job_id)) == {"create", "cancel"}


async def test_expired_draft_is_cancelled_by_the_listing_and_frees_the_computer(api):
    job_id = (await A.create(api)).json()["id"]
    api.clock.advance(901)
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert computers["opt11"]["eligible"] and computers["opt11"]["active_job_id"] is None
    job = await A.get_job(api, job_id)
    assert job["state"] == "cancelled" and job["error_code"] == "draft_expired"
    assert job["deadline_at"] is None and not job["can"]["start"] and not job["can"]["cancel"]
    assert (await A.post(api, job_id, "start", {"password": SHARED})).status_code == 409
    assert (await A.create(api)).status_code == 201


# -- computers from live labels --------------------------------------------------------

async def test_relabelled_kvm_port_stays_busy_while_a_job_holds_it(api):
    job_id = (await A.create(api)).json()["id"]
    async with api.sessions() as db:
        kvm = await db.get(Device, "kvm1")
        kvm.labels_json = json.dumps({"1": "OPT77", "2": "Optn84", "3": "Optn84 (2)"})
        await db.commit()
    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert "opt11" not in computers                                       # no KVM port carries OPT11 now
    opt77 = computers["opt77"]
    assert opt77["blockers"] == ["kvm_port_busy"] and not opt77["eligible"] and opt77["active_job_id"] is None
    assert opt77["kvm"] == [{"device_id": "kvm1", "device_name": "KVM 01", "model": "KX III", "port": 1, "busy": True}]
    r = await A.create(api, computer_key="OPT77")
    assert r.status_code == 409 and r.json()["detail"] == "Another install is active on this computer or KVM port"
    assert [j.id for j in await _jobs(api)] == [job_id]


async def test_live_cached_labels_add_ports_and_outlets_but_stored_labels_win(api):
    async with api.sessions() as db:
        db.add(Device(id="kvm4", name="KVM 04", kind="kvm", model="KX III", ip="192.0.2.24", rack="", port_count=8,
                      labels_json=json.dumps({"1": "OPT44", "x": "OPT45", "0": "OPT46"})))
        db.add(Device(id="pdu2", name="PDU 02", kind="pdu", model="PX4", ip="192.0.2.2", rack="R7", port_count=8,
                      labels_json=json.dumps({"2": "OPT44"})))
        await db.commit()
    now = time.monotonic()
    port = lambda number, label: SimpleNamespace(number=number, label=label)   # noqa: E731
    kvms_module._cache["kvm2"] = (now, SimpleNamespace(ports=[port(1, "OPT77"), port(2, "OPT42")]))
    kvms_module._cache["kvm9"] = (now, SimpleNamespace(ports=[port(2, "OPT98")]))      # a disabled KVM
    pdus_module._cache["pdu1"] = (now, SimpleNamespace(outlets=[port(7, "OPT42"), port(1, "OPT77")]))

    computers = {c["key"]: c for c in (await api.c.get("/api/pxe/computers")).json()}
    assert [(k["device_id"], k["port"]) for k in computers["opt42"]["kvm"]] == [("kvm2", 2)]
    assert computers["opt42"]["pdu"] == [{"device_id": "pdu1", "device_name": "PDU 01", "outlet": 7}]
    assert [(k["device_id"], k["port"]) for k in computers["optn87"]["kvm"]] == [("kvm2", 1), ("kvm3", 4)]
    assert "opt77" not in computers and "opt98" not in computers         # stored labels win; disabled ignored
    assert "opt45" not in computers and "opt46" not in computers         # non-numeric and port 0 are skipped
    assert computers["opt44"]["rack"] == "R7"                            # KVM without a rack: the PDU's rack

    r = await A.create(api, computer_key="OPT42", reboot_method="pdu_cycle")
    assert r.status_code == 201, r.text
    assert r.json()["pdu_targets"] == [{"device_id": "pdu1", "device_name": "PDU 01", "outlet": 7}]


def test_allowlist_accepts_every_documented_separator_and_canonical_names():
    assert mapping.allowlist("OPT11;optn84(SSD),\tOptn87\nOPT99 ;; ,") == {"opt11", "optn84", "optn87", "opt99"}
    assert mapping.allowlist("") == set() and mapping.allowlist(None) == set() and mapping.allowlist(" ,;\n") == set()
    assert mapping.allowlist("Outlet3,Port12") == set()


# -- runner refusals on the simulated console --------------------------------------------

@pytest.mark.parametrize("setting,value,code", [
    ("pxe_old_repo_host", "oldrepo", "unexpected_host"),       # the menu points to a host nobody configured
    ("pxe_new_repo_host", "WebRepo", "invalid_configuration"),  # old and new host are the same name
    ("pxe_new_repo_host", "bad host", "invalid_configuration"),
    ("pxe_old_repo_host", "-webrepo", "invalid_configuration"),
])
async def test_repository_host_problems_discard_the_edit_without_typing(env, setting, value, code):
    job_id, state = await S.started(env)
    assert state == "waiting_for_choice"
    sim = S.machine(env, job_id)
    assert await S.choose_boot(env, job_id) == "waiting_for_grub_choice"
    setattr(env.settings, setting, value)
    assert await S.choose_grub(env, job_id) == "failed"
    job, _ = await S.load(env, job_id)
    assert job.error_code == code and job.failed_step == "updating_urls"
    assert sim.keys[-1] == "Esc" and sim.phase == "grub" and sim.booted is None
    assert not any(isinstance(k, Text) for k in sim.keys) and "Ctrl+X" not in sim.keys
    assert not job.install_may_have_started and job.active_key is None


async def test_grub_menu_without_an_install_entry_fails_without_blocking(env):
    job_id, _ = await S.started(env)
    sim = S.machine(env, job_id)
    sim.grub_entries = [e for e in sim.grub_entries if e[0] in (LOCAL, RESCUE)]
    assert await S.choose_boot(env, job_id) == "failed"
    job, _ = await S.load(env, job_id)
    assert job.error_code == "no_install_entry" and job.failed_step == "waiting_for_grub"
    assert not any(o["selectable"] for o in json.loads(job.grub_options_json))
    assert sim.countdown_end is None and sim.booted is None and "e" not in sim.keys
    assert not job.install_may_have_started and job.active_key is None


async def test_installed_system_login_during_grub_wait_fails_without_blocking(env):
    job_id, _ = await S.started(env)
    job, _ = await S.load(env, job_id)
    option = S.pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
    await env.runner.choose(job_id, "boot", option["id"], job.version, "tester")
    sim = S.machine(env, job_id)
    sim.phase, sim.phase_at = "os", env.clock()            # the entry that booted was the installed system
    assert await S.drive(env, job_id) == "failed"
    job, _ = await S.load(env, job_id)
    assert job.error_code == "grub_countdown_expired" and job.failed_step == "waiting_for_grub"
    assert not job.install_may_have_started and job.active_key is None
    assert await S.new_job(env)


async def test_login_instead_of_installer_keeps_the_computer_blocked(env):
    job_id = await S.to_ready(env)
    job, _ = await S.load(env, job_id)
    await env.runner.install(job_id, job.rewrite_hash, "tester")
    sim = S.machine(env, job_id)
    sim.phase, sim.phase_at = "os", env.clock()
    assert await S.drive(env, job_id) == "failed"
    job, _ = await S.load(env, job_id)
    assert job.error_code == "installer_not_started" and job.failed_step == "installing"
    assert job.install_may_have_started and job.active_key == "opt11"
    with pytest.raises(HTTPException) as exc:
        await S.new_job(env)
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        await env.runner.install(job_id, job.rewrite_hash, "tester")
    assert exc.value.status_code == 409 and sim.keys.count("Ctrl+X") == 1
    await env.runner.acknowledge(job_id, "admin")
    assert await S.new_job(env)


async def test_console_failure_reconnects_once_then_stops(env):
    job_id = await S.new_job(env)
    await env.runner.start(job_id, "tester", "")
    assert await env.runner.step(job_id) is not None        # manual reboot requested; no screen read yet
    screen = env.runner.device(job_id).screen
    reads = []

    async def lost():
        reads.append(1)
        raise ScreenDriverError("KVM session disconnected")

    screen.read_text = lost
    assert await env.runner.step(job_id) is not None        # first failure: reopen once
    job, events = await S.load(env, job_id)
    assert job.state == "rebooting" and [e.action for e in events].count("reconnected") == 1
    assert await env.runner.step(job_id) is None            # second failure: stop
    job, events = await S.load(env, job_id)
    assert job.state == "failed" and job.error_code == "kvm_disconnected" and job.failed_step == "rebooting"
    assert [e.action for e in events].count("reconnected") == 1 and len(reads) == 2
    assert not job.install_may_have_started and job.active_key is None and env.runner.device(job_id) is None


async def test_unexpected_automation_error_stops_the_job_without_leaking_it(env):
    job_id = await S.new_job(env, method="kvm_cad")
    await env.runner.start(job_id, "tester", "")
    screen = env.runner.device(job_id).screen

    async def boom(_seq):
        raise RuntimeError("driver bug near admin:hunter2@192.0.2.20")

    screen.send_keys = boom
    await env.runner._loop(job_id)                          # the background task body; returns after the failure
    job, events = await S.load(env, job_id)
    assert job.state == "failed" and job.error_code == "internal_error" and job.failed_step == "rebooting"
    stored = job.error_detail + "".join(e.detail for e in events)
    assert "hunter2" not in stored and "192.0.2.20" not in stored
    assert env.runner.device(job_id) is None and job.active_key is None


async def test_restart_while_waiting_for_grub_keeps_the_computer_blocked(env):
    job_id, _ = await S.started(env)
    job, _ = await S.load(env, job_id)
    option = S.pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
    await env.runner.choose(job_id, "boot", option["id"], job.version, "tester")
    assert (await S.load(env, job_id))[0].state == "waiting_for_grub"
    await env.runner.aclose()                               # the server process stops
    env.clock.advance(31)                                   # and its lease runs out
    restarted = PxeRunner(env.sessions, lambda: env.settings, clock=env.clock, tick=0.5,
                          screens_dir=env.tmp / "screens", autostart=False)
    try:
        await restarted.recover(force=True)
        job, _ = await S.load(env, job_id)
        assert job.state == "failed" and job.error_code == "interrupted" and job.failed_step == "waiting_for_grub"
        assert job.install_may_have_started and job.active_key == "opt11"
        with pytest.raises(HTTPException) as exc:
            await S.new_job(env)
        assert exc.value.status_code == 409
        await restarted.acknowledge(job_id, "admin")
        assert await S.new_job(env)
    finally:
        await restarted.aclose()


async def test_cancel_while_waiting_for_grub_must_not_release_the_computer(env):
    job_id, _ = await S.started(env)
    sim = S.machine(env, job_id)
    install = next(i for i, e in enumerate(sim.grub_entries) if e[0].startswith("Install"))
    sim.grub_entries.insert(0, sim.grub_entries.pop(install))   # the menu's default entry is an install profile
    job, _ = await S.load(env, job_id)
    option = S.pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
    await env.runner.choose(job_id, "boot", option["id"], job.version, "tester")
    try:
        await env.runner.cancel(job_id, "tester")
    except HTTPException as exc:                            # refusing the cancel is an acceptable fix too
        assert exc.status_code == 409
    env.clock.advance(30)
    sim.screen()
    assert sim.booted and any("inst.repo=" in line for line in sim.booted)   # the GRUB countdown booted it
    with pytest.raises(HTTPException) as exc:
        await S.new_job(env)                                # a new install on the same computer must wait
    assert exc.value.status_code == 409


async def test_takeover_while_waiting_for_grub_keeps_the_computer_until_an_admin_acknowledges(env):
    job_id, _ = await S.started(env)
    job, _ = await S.load(env, job_id)
    option = S.pick(json.loads(job.boot_options_json), lambda o: o["recommended"])
    await env.runner.choose(job_id, "boot", option["id"], job.version, "tester")
    job, _ = await S.load(env, job_id)
    assert job.state == "waiting_for_grub" and job_dto(job, [], env.clock())["can"]["cancel"] is False
    await env.runner.takeover(job_id, "tester")
    job, _ = await S.load(env, job_id)
    assert job.state == "manual_takeover" and job.install_may_have_started and job.active_key == "opt11"
    with pytest.raises(HTTPException) as exc:
        await S.new_job(env)
    assert exc.value.status_code == 409
    await env.runner.acknowledge(job_id, "admin")
    assert await S.new_job(env)


# -- pure building blocks ------------------------------------------------------------------

def test_edit_keys_refuse_hosts_on_different_editor_lines():
    lines = ["setparams 'x'", "linuxefi /v inst.repo=http://webrepo/a", "inst.ks=http://webrepo/k"]
    text = "\n".join(lines)
    first = text.index("webrepo")
    second = text.index("webrepo", first + 1)
    changes = [{"key": "inst.repo", "start": first, "end": first + 7},
               {"key": "inst.ks", "start": second, "end": second + 7}]
    with pytest.raises(RewriteError) as exc:
        edit_keys(lines, changes, NEW)
    assert exc.value.code == "unsupported_layout"
    end = len(lines[0]) + 1 + len(lines[1])                 # a span that runs past the end of its line
    with pytest.raises(RewriteError) as exc:
        edit_keys(lines, [{"key": "inst.repo", "start": end - 3, "end": end + 2}], NEW)
    assert exc.value.code == "unsupported_layout"


ENTRY = "linuxefi /v inst.ks=http://webrepo/k inst.repo=http://webrepo/r"


@pytest.mark.parametrize("old", ["", "-webrepo", ".webrepo", "web/repo", "web repo", "webrepo:80", None])
def test_invalid_old_repository_host_is_refused(old):
    with pytest.raises(ValueError, match="Invalid old repository host"):
        rewrite_install_urls(ENTRY, old, NEW)


@pytest.mark.parametrize("text,code", [
    ("linux /v inst.ks=http://webrepo/k inst.repo=\"http://webrepo/a", "unbalanced_quote"),
    ("linux /v inst.ks=http://webrepo/k inst.repo=\"", "unbalanced_quote"),
    ("linux /v inst.ks=http://webrepo/k inst.repo=http:///os", "unsupported_scheme"),
    ("linux /v inst.ks=http://webrepo/k inst.repo=", "unsupported_scheme"),
    ("linux /v inst.ks=http://webrepo/k inst.repo=http://:8080/os", "unsupported_scheme"),
    ("linux /v inst.ks=https://u@webrepo/k inst.repo=http://webrepo/a", "credentials_in_url"),
])
def test_rewrite_refusals_are_exact_and_shared_with_key_hosts(text, code):
    for call in (lambda: rewrite_install_urls(text, "webrepo", NEW), lambda: key_hosts(text)):
        with pytest.raises(RewriteError) as exc:
            call()
        assert exc.value.code == code


def _job(**overrides):
    values = dict(id="d" * 32, computer_key="opt11", computer_name="OPT11", kvm_device_id="kvm1", kvm_port=1,
                  pdu_targets_json="[]", reboot_method="kvm_cad", driver="simulated", sim_scenario="happy",
                  state="draft", state_entered_at=100.0, deadline_at=1000.0, version=3, boot_options_json="[]",
                  boot_choice="", grub_options_json="[]", grub_choice="", original_cmdline="", new_cmdline="",
                  rewrite_changes_json="{}", rewrite_hash="", install_sent_at=None, install_may_have_started=False,
                  completion_signal="", failed_step="", error_code="", error_detail="", active_key="opt11",
                  active_port_key="kvm1:1", lease_owner="", lease_until=0.0, screenshot_seq=0, created_by="t",
                  created_at=100.0, updated_at=100.0)
    values.update(overrides)
    return PxeJob(**values)


def test_action_flags_never_offer_a_second_install_or_a_cancel_after_ctrl_x():
    dto = job_dto(_job(state="draft", deadline_at=1000.0), [], now=1000.0)    # deadline reached, not yet swept
    assert dto["can"]["start"] is False and dto["can"]["cancel"] is True

    sent = job_dto(_job(state="ready_to_install", install_sent_at=500.0, install_may_have_started=True,
                        rewrite_hash="h" * 32), [], now=600.0)
    assert sent["can"]["install"] is False and sent["can"]["cancel"] is False and sent["can"]["takeover"] is True

    held = job_dto(_job(state="failed", install_may_have_started=True, error_code="installer_error"), [], now=600.0)
    assert held["needs_acknowledge"] and held["can"]["acknowledge"] and held["deadline_at"] is None
    assert not held["can"]["cancel"] and not held["can"]["refresh_screenshot"] and held["options_kind"] is None

    released = job_dto(_job(state="failed", install_may_have_started=True, active_key=None), [], now=600.0)
    assert not released["needs_acknowledge"] and not released["can"]["acknowledge"]
    taken = job_dto(_job(state="manual_takeover", install_may_have_started=True), [], now=600.0)
    assert taken["needs_acknowledge"] and not taken["can"]["takeover"] and not taken["can"]["cancel"]

    boot = [{"id": "o0-aa", "label": "UEFI: IPv4 X", "selectable": True, "highlighted": True, "recommended": True}]
    grub = [{"id": "o0-bb", "label": "Install X", "selectable": True, "highlighted": True, "recommended": False}]
    waiting = job_dto(_job(state="waiting_for_choice", boot_options_json=json.dumps(boot),
                           grub_options_json=json.dumps(grub)), [], now=600.0)
    assert waiting["options_kind"] == "boot" and waiting["options"] == boot and waiting["rewrite"] is None


def _screen(lines, highlight=None):
    return ScreenText(lines, highlight, 80, 25, 1.0, "test")


def test_menu_parsers_refuse_untrusted_layouts_and_only_offer_install_entries():
    labels = ["UEFI: IPv4 Realtek USB GbE", "UEFI: IPv6 Intel I219", "UEFI: IPv4 Intel I219", "Windows Boot Manager",
              "WLAN Card", "UEFI: PXE Network Boot"]
    options = parsers.boot_options(parsers.Menu(labels, 0, 1))
    assert [o["label"] for o in options if o["recommended"]] == ["UEFI: IPv4 Intel I219"]
    assert [o["selectable"] for o in options] == [True, True, True, False, False, True]
    usb_only = parsers.boot_options(parsers.Menu(["Windows Boot Manager", "UEFI: IPv4 Realtek USB GbE"], 0, 1))
    assert [o["recommended"] for o in usb_only] == [False, True]
    assert not any(o["recommended"] for o in parsers.boot_options(parsers.Menu(["UEFI: IPv6 Intel"], 0, 1)))
    assert parsers.option_id(0, "same") != parsers.option_id(1, "same")

    grub = parsers.grub_options(parsers.Menu(["Boot from local disk", "Memory test (memtest86+)", "Troubleshooting -->",
                                              "Rescue a Rocky Linux system", "Install Rocky Linux 9.4"], 4, 2))
    assert [o["selectable"] for o in grub] == [False, False, False, False, True]
    assert not any(o["recommended"] for o in grub)

    gap = _screen(["Please select boot device:", "  UEFI: IPv4 Intel", "", "  Windows Boot Manager", "ENTER to select"], 1)
    assert parsers.detect_boot_menu(gap) is None                          # two blocks are not one trusted menu
    empty = _screen(["Please select boot device:", "ENTER to select boot device"])
    assert parsers.detect_boot_menu(empty) is None
    menu = _screen(["Please select boot device:", "  UEFI: IPv4 Intel", "", "ESC/F12 to boot normally, ENTER to select"], 1)
    assert parsers.detect_boot_menu(menu).options == ["UEFI: IPv4 Intel"] and not parsers.detect_post(menu)
    grub_no_footer = _screen(["GNU GRUB  version 2.06", " Install Rocky Linux 9.4"], 1)
    assert parsers.detect_grub_menu(grub_no_footer) is None and parsers.detect_grub_editor(grub_no_footer) is None
