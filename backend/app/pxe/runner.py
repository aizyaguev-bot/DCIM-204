"""PXE job state machine: one asyncio task per job, DB lease, injectable clock and console driver factory.

Only this module touches a job's console. User actions run under the same per-job lock as automatic steps.
Every write is a conditional update on the (state, version) that was read, plus the lease owner for the
worker that drives the console; keys are sent only inside such a write, so a job that was cancelled, taken
over or claimed elsewhere never receives another keystroke from this worker.
"""
import asyncio
import json
import logging
import pathlib
import re
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from ..models import PxeJob, PxeJobEvent, PxeRunSlot
from . import parsers, rewrite
from .screen import ScreenDriverError, Text
from .sim_driver import TIMINGS, SimulatedMachine, SimulatedPower, SimulatedScreenDriver

log = logging.getLogger(__name__)

SCREENS_DIR = pathlib.Path(__file__).resolve().parents[2] / "pxe_screens"
TERMINAL = ("completed", "failed", "cancelled", "manual_takeover")
PRE_INSTALL = ("rebooting", "waiting_for_menu", "waiting_for_choice", "waiting_for_grub", "waiting_for_grub_choice",
               "updating_urls", "ready_to_install")
POST_INSTALL = ("installing", "install_started")
USER_STATES = ("draft", "waiting_for_choice", "waiting_for_grub_choice", "ready_to_install")
EDITING = ("updating_urls", "ready_to_install")          # a GRUB edit is on screen; Esc discards it
MAY_START = ("waiting_for_grub",) + POST_INSTALL         # an install entry may boot without further keys
REBOOT_METHODS = ("kvm_cad", "manual", "pdu_cycle")
TIMEOUTS = {"draft": 900, "rebooting": 180, "waiting_for_menu": 120, "waiting_for_choice": 600, "waiting_for_grub": 180,
            "waiting_for_grub_choice": 600, "updating_urls": 120, "ready_to_install": 900, "installing": 300,
            "install_started": 4 * 3600}
TIMEOUT_CODES = {"rebooting": "reboot_timeout", "waiting_for_menu": "boot_menu_timeout", "waiting_for_choice": "user_timeout",
                 "waiting_for_grub": "grub_timeout", "waiting_for_grub_choice": "user_timeout",
                 "updating_urls": "rewrite_timeout", "ready_to_install": "user_timeout", "installing": "installer_timeout",
                 "install_started": "completion_timeout"}
LABELS = {"draft": "טיוטה", "rebooting": "מאתחל", "waiting_for_menu": "ממתין לתפריט", "waiting_for_choice": "ממתין לבחירה",
          "waiting_for_grub": "ממתין לתפריט", "waiting_for_grub_choice": "ממתין לבחירה", "updating_urls": "מעדכן כתובות",
          "ready_to_install": "מוכן להתקנה", "installing": "מתקין", "install_started": "מתקין",
          "completed": "ההתקנה הושלמה", "failed": "נכשל", "cancelled": "בוטל", "manual_takeover": "הועבר לטיפול ידני"}
LEASE_SECONDS = 30
EVENT_KEEP = 200
EVENT_LIMIT = 50
SCREEN_KEEP = 50
SCREEN_MAX_AGE = 7 * 86400
MIN_CONFIDENCE = 0.9
READ_ATTEMPTS = 3
F12_INTERVAL = 0.5
USER_POLL = 5.0
REFRESH_INTERVAL = 2.0
BUSY = "Another remote install is running; wait until it finishes"
SIMULATED_NO_CONSOLE = "A simulated job has no console to open"
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


@dataclass
class JobDevice:
    screen: object
    power: object | None = None
    machine: SimulatedMachine | None = None
    completion_signal: bool = False      # the driver can recognise the installed OS booting


class DriverUnavailable(Exception):
    pass


class Superseded(Exception):
    """The job row changed under this worker (cancelled, taken over, claimed elsewhere); nothing may be sent."""


class Expired(Exception):
    """The step deadline passed before a key could be sent."""


def simulated_factory(settings_fn, clock):
    def factory(job: PxeJob) -> JobDevice:
        settings = settings_fn()
        if job.driver != "simulated":
            raise DriverUnavailable("The Raritan console driver is not available in this phase")
        machine = SimulatedMachine(job.id, job.sim_scenario or "happy", clock, hostname=job.computer_name.lower(),
                                   old_host=settings.pxe_old_repo_host, new_host=settings.pxe_new_repo_host,
                                   time_scale=settings.pxe_sim_time_scale)
        if job.reboot_method == "manual":
            machine.schedule_reboot(TIMINGS["manual"])   # the simulated person reboots the computer
        return JobDevice(SimulatedScreenDriver(machine), SimulatedPower(machine), machine, completion_signal=True)
    return factory


def default_factory(settings_fn, clock, sessions):
    """Simulated jobs stay on the fake console. A Raritan job needs a browser and a screen reader."""
    simulated = simulated_factory(settings_fn, clock)

    def factory(job: PxeJob) -> JobDevice:
        if job.driver == "simulated":
            return simulated(job)
        if job.driver == "raritan":
            from . import raritan_driver
            if not raritan_driver.driver_ready():
                raise DriverUnavailable("The Raritan console driver is not available in this phase")
            return JobDevice(raritan_driver.RaritanScreenDriver(job, sessions), raritan_driver.RaritanPower(job, sessions),
                             None, completion_signal=True)
        raise DriverUnavailable("The Raritan console driver is not available in this phase")
    return factory


def _bounded(text: str, limit: int = 500) -> str:
    return _CONTROL.sub(" ", str(text or ""))[:limit]


def linux_line(text: str) -> str:
    return next((line for line in (text or "").split("\n") if rewrite._LINUX.match(line)), "")


def edit_keys(lines: list[str], changes: list[dict], new_host: str) -> list:
    """Keystrokes for a targeted host edit in the GRUB editor, right to left; cursor starts anywhere."""
    if not changes:
        return []
    starts, pos = [], 0
    for line in lines:
        starts.append(pos)
        pos += len(line) + 1
    keys, row, current = [], None, None
    for change in sorted(changes, key=lambda c: c["start"], reverse=True):
        index = max(i for i, s in enumerate(starts) if s <= change["start"])
        col_s, col_e = change["start"] - starts[index], change["end"] - starts[index]
        if col_e > len(lines[index]) or (row is not None and index != row):
            raise rewrite.RewriteError("unsupported_layout", "A host spans more than one editor line")
        if row is None:
            row, current = index, lines[index]
            keys += ["Up"] * (len(lines) + 2) + ["Down"] * index
        from_home, from_end = col_s, len(current) - col_e
        if from_home <= from_end:
            keys += ["Ctrl+A"] + ["Right"] * col_s + ["Delete"] * (col_e - col_s)
        else:
            keys += ["Ctrl+E"] + ["Left"] * from_end + ["Backspace"] * (col_e - col_s)
        keys.append(Text(new_host))
        current = current[:col_s] + new_host + current[col_e:]
    return keys


def _write_shot(folder: pathlib.Path, name: str, data: bytes):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(data)
    shots = sorted(p for p in folder.iterdir() if p.is_file())
    for old in shots[:-SCREEN_KEEP]:
        old.unlink(missing_ok=True)


def prune_screens(root: pathlib.Path, max_age: float = SCREEN_MAX_AGE):
    """Deletes screenshots older than max_age (file time) and empty job folders."""
    if not root.is_dir():
        return
    cutoff = time.time() - max_age
    for folder in root.iterdir():
        if not folder.is_dir():
            continue
        for shot in folder.iterdir():
            try:
                if shot.is_file() and shot.stat().st_mtime < cutoff:
                    shot.unlink()
            except OSError:
                pass
        try:
            next(folder.iterdir())
        except StopIteration:
            folder.rmdir()
        except OSError:
            pass


def can(job: PxeJob, now: float) -> dict:
    state = job.state
    holds = job.active_key is not None
    return {
        "start": state == "draft" and now < job.deadline_at,
        "choose_boot": state == "waiting_for_choice",
        "choose_grub": state == "waiting_for_grub_choice",
        "install": state == "ready_to_install" and job.install_sent_at is None,
        "cancel": (state == "draft" or state in PRE_INSTALL) and job.install_sent_at is None,
        # After a failure only a real console is left to open; a simulated job has none.
        "takeover": state in PRE_INSTALL or state in POST_INSTALL or (state == "failed" and job.driver != "simulated"),
        "complete": state == "install_started",
        "acknowledge": state in ("failed", "manual_takeover") and job.install_may_have_started and holds,
        "refresh_screenshot": state in PRE_INSTALL or state in POST_INSTALL,
    }


def event_dto(event: PxeJobEvent) -> dict:
    return {"at": event.at, "from_state": event.from_state, "to_state": event.to_state, "actor": event.actor,
            "action": event.action, "detail": event.detail, "screenshot_ref": event.screenshot_ref}


def job_dto(job: PxeJob, events: list[PxeJobEvent], now: float) -> dict:
    boot = json.loads(job.boot_options_json or "[]")
    grub = json.loads(job.grub_options_json or "[]")
    kind = "grub" if job.state == "waiting_for_grub_choice" else "boot" if job.state == "waiting_for_choice" else None
    details = json.loads(job.rewrite_changes_json or "{}")
    rewritten = None
    if job.rewrite_hash:
        rewritten = {"before": job.original_cmdline, "after": job.new_cmdline,
                     "line_before": linux_line(job.original_cmdline), "line_after": linux_line(job.new_cmdline),
                     "changes": details.get("changes", []), "warnings": details.get("warnings", []), "hash": job.rewrite_hash}
    return {
        "id": job.id, "computer_key": job.computer_key, "computer_name": job.computer_name,
        "kvm_device_id": job.kvm_device_id, "kvm_port": job.kvm_port, "pdu_targets": json.loads(job.pdu_targets_json or "[]"),
        "reboot_method": job.reboot_method, "driver": job.driver, "sim_scenario": job.sim_scenario or None,
        "state": job.state, "state_label": LABELS.get(job.state, job.state), "state_entered_at": job.state_entered_at,
        "deadline_at": None if job.state in TERMINAL else job.deadline_at, "version": job.version,
        "options_kind": kind, "options": grub if kind == "grub" else boot if kind == "boot" else [],
        "choice": job.grub_choice if kind == "grub" else job.boot_choice if kind == "boot" else None,
        "boot_options": boot, "boot_choice": job.boot_choice or None, "grub_options": grub, "grub_choice": job.grub_choice or None,
        "rewrite": rewritten, "install_sent_at": job.install_sent_at, "install_may_have_started": job.install_may_have_started,
        "completion_signal": job.completion_signal or None, "failed_step": job.failed_step or None,
        "error_code": job.error_code or None, "error_detail": job.error_detail or None,
        "needs_acknowledge": job.install_may_have_started and job.active_key is not None and job.state in ("failed", "manual_takeover"),
        "can": can(job, now), "screenshot_available": job.screenshot_seq > 0, "screenshot_seq": job.screenshot_seq,
        "created_by": job.created_by, "created_at": job.created_at, "updated_at": job.updated_at,
        "events": [event_dto(e) for e in events],
    }


class PxeRunner:
    def __init__(self, sessions, settings_fn, *, factory=None, clock=time.time, tick: float | None = None,
                 screens_dir: pathlib.Path = SCREENS_DIR, autostart: bool = True, owner: str | None = None):
        self.sessions, self.settings_fn, self.clock = sessions, settings_fn, clock
        self.factory = factory or default_factory(settings_fn, clock, sessions)
        self._tick = tick
        self.screens_dir = pathlib.Path(screens_dir)
        self.autostart = autostart
        self.owner = owner or uuid.uuid4().hex
        self._devices: dict[str, JobDevice] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._wake: dict[str, asyncio.Event] = {}
        self._mem: dict[str, dict] = {}
        self._refreshed: dict[str, float] = {}
        self._recovered_at: float | None = None
        self._pruned_at = 0.0

    @property
    def tick(self) -> float:
        return self._tick if self._tick is not None else self.settings_fn().pxe_tick_seconds

    def lock(self, job_id: str) -> asyncio.Lock:
        return self._locks.setdefault(job_id, asyncio.Lock())

    def device(self, job_id: str) -> JobDevice | None:
        return self._devices.get(job_id)

    # -- persistence helpers ---------------------------------------------
    @staticmethod
    def _mark(job: PxeJob, owned: bool) -> PxeJob:
        """Remembers the row version that later writes are conditional on; owned writes also need the lease."""
        job._pxe_base, job._pxe_owned, job._pxe_guarded = (job.state, job.version), owned, False
        return job

    async def _get(self, db, job_id: str, owned: bool) -> PxeJob | None:
        job = await db.get(PxeJob, job_id, populate_existing=True)
        return self._mark(job, owned) if job else None

    async def _load(self, db, job_id: str, owned: bool = False) -> PxeJob:
        job = await self._get(db, job_id, owned)
        if not job:
            raise HTTPException(404, "Job not found")
        return job

    async def _guard(self, db, job: PxeJob):
        """Opens the write transaction with a conditional update on the row that was read.

        Until the commit no other worker can change the row, so keys sent meanwhile act on that state.
        Raises Superseded (after rolling back) when the state, version or lease owner changed."""
        if job._pxe_guarded:
            return
        state, version = job._pxe_base
        job_id = job.id
        where = [PxeJob.id == job_id, PxeJob.state == state, PxeJob.version == version]
        values = {"version": PxeJob.version}
        if job._pxe_owned:
            where.append(PxeJob.lease_owner == self.owner)
            values = {"lease_until": self.clock() + LEASE_SECONDS}
        with db.no_autoflush:
            result = await db.execute(update(PxeJob).where(*where).values(**values)
                                      .execution_options(synchronize_session=False))
        if not result.rowcount:
            await db.rollback()                 # expires `job`; callers must not read it afterwards
            raise Superseded(job_id)
        job._pxe_guarded = True

    async def _commit(self, db, job: PxeJob):
        await self._guard(db, job)
        await db.commit()
        self._mark(job, job._pxe_owned)

    async def _send(self, db, job: PxeJob, device: JobDevice, keys: list):
        """Sends keys only before the step deadline and while this worker owns the unchanged row."""
        if self.clock() >= job.deadline_at:
            raise Expired(job.id)
        await self._guard(db, job)
        try:
            await device.screen.send_keys(keys)
        finally:
            await self._commit(db, job)

    @asynccontextmanager
    async def _action(self, job_id: str):
        async with self.lock(job_id), self.sessions() as db:
            try:
                yield db
            except Superseded:
                raise HTTPException(409, "The job was changed by another action; refresh and try again") from None

    async def _event(self, db, job: PxeJob, action: str, actor: str = "runner", detail: str = "",
                     from_state: str | None = None, to_state: str | None = None, shot: str = ""):
        await self._guard(db, job)
        db.add(PxeJobEvent(job_id=job.id, at=self.clock(), from_state=job.state if from_state is None else from_state,
                           to_state=job.state if to_state is None else to_state, actor=_bounded(actor, 64),
                           action=action, detail=_bounded(detail), screenshot_ref=shot))
        await db.flush()
        cutoff = (select(PxeJobEvent.id).where(PxeJobEvent.job_id == job.id).order_by(PxeJobEvent.id.desc())
                  .offset(EVENT_KEEP - 1).limit(1).scalar_subquery())
        await db.execute(delete(PxeJobEvent).where(PxeJobEvent.job_id == job.id, PxeJobEvent.id < cutoff)
                         .execution_options(synchronize_session=False))

    async def _claim(self, db, job: PxeJob) -> bool:
        now = self.clock()
        free = (PxeJob.lease_owner == self.owner) | (PxeJob.lease_owner == "") | (PxeJob.lease_until < now)
        result = await db.execute(update(PxeJob).where(PxeJob.id == job.id, free)
                                  .values(lease_owner=self.owner, lease_until=now + LEASE_SECONDS)
                                  .execution_options(synchronize_session=False))
        if not result.rowcount:
            return False
        job.lease_owner, job.lease_until = self.owner, now + LEASE_SECONDS
        return True

    async def _drop_lease(self, db, job_id: str):
        await db.rollback()
        await db.execute(update(PxeJob).where(PxeJob.id == job_id, PxeJob.lease_owner == self.owner)
                         .values(lease_owner="", lease_until=0).execution_options(synchronize_session=False))
        await db.commit()

    async def _running_count(self, db, exclude: str) -> int:
        return await db.scalar(select(func.count()).select_from(PxeJob).where(
            PxeJob.state.in_(PRE_INSTALL + POST_INSTALL), PxeJob.id != exclude)) or 0

    async def _take_slot(self, db, job: PxeJob) -> bool:
        """Global limit inside the guarded write: slot rows have a unique key, so two starts cannot share one."""
        limit = max(1, int(self.settings_fn().pxe_max_active_jobs))
        running = select(PxeJob.id).where(PxeJob.state.in_(PRE_INSTALL + POST_INSTALL))
        await db.execute(delete(PxeRunSlot).where(PxeRunSlot.job_id.not_in(running))
                         .execution_options(synchronize_session=False))
        taken = set((await db.scalars(select(PxeRunSlot.slot))).all())
        free = next((s for s in range(limit) if s not in taken), None)
        if free is None or len(taken) >= limit or await self._running_count(db, job.id) >= limit:
            return False
        db.add(PxeRunSlot(slot=free, job_id=job.id))
        try:
            await db.flush()
        except IntegrityError:
            return False
        return True

    async def _screenshot(self, job: PxeJob) -> str:
        device = self._devices.get(job.id)
        if not device:
            return ""
        try:
            data, media = await device.screen.screenshot()
        except Exception:
            return ""
        ext = {"image/svg+xml": "svg", "image/png": "png"}.get(media)
        if not ext:
            return ""
        job.screenshot_seq += 1
        name = f"{job.screenshot_seq:05d}.{ext}"
        await asyncio.to_thread(_write_shot, self.screens_dir / job.id, name, data)
        if time.monotonic() - self._pruned_at > 3600:
            self._pruned_at = time.monotonic()
            await asyncio.to_thread(prune_screens, self.screens_dir)
        return name

    def screenshot_file(self, job: PxeJob) -> tuple[pathlib.Path, str] | None:
        if job.screenshot_seq < 1:
            return None
        for ext, media in (("svg", "image/svg+xml"), ("png", "image/png")):
            path = self.screens_dir / job.id / f"{job.screenshot_seq:05d}.{ext}"
            if path.is_file():
                return path, media
        return None

    async def _transition(self, db, job: PxeJob, to: str, actor: str = "runner", action: str = "transition",
                          detail: str = "", shot: bool = True):
        await self._guard(db, job)
        now, origin = self.clock(), job.state
        job.state, job.state_entered_at, job.updated_at = to, now, now
        job.deadline_at = now + TIMEOUTS.get(to, 0)
        job.version += 1
        if to in TERMINAL:
            if to == "completed" or not job.install_may_have_started:
                job.active_key = job.active_port_key = None
            job.lease_owner, job.lease_until = "", 0
        ref = await self._screenshot(job) if shot else ""
        await self._event(db, job, action, actor, detail, origin, to, ref)
        if to in TERMINAL:
            await db.execute(delete(PxeRunSlot).where(PxeRunSlot.job_id == job.id)
                             .execution_options(synchronize_session=False))
        await self._commit(db, job)

    async def _fail(self, db, job: PxeJob, code: str, detail: str, esc: bool = False, actor: str = "runner",
                    may_start: bool | None = None):
        """Stops the job. Unless proven otherwise, a failure once an install entry could boot keeps the computer
        blocked (install_may_have_started) until an Admin acknowledges it."""
        await self._guard(db, job)
        device = self._devices.get(job.id)
        if esc and device:
            try:
                await device.screen.send_keys(["Esc"])      # discard GRUB edits
            except Exception:
                pass
        if may_start is None:
            may_start = job.install_sent_at is not None or job.state in MAY_START
        if may_start:
            job.install_may_have_started = True
        job.failed_step, job.error_code, job.error_detail = job.state, code, _bounded(detail)
        await self._transition(db, job, "failed", actor, "failed", f"{code}: {detail}")
        await self._close_device(job.id)

    async def _expire(self, db, job: PxeJob, detail: str = ""):
        await self._fail(db, job, TIMEOUT_CODES[job.state], detail or f"Timed out in state {job.state}",
                         esc=job.state in EDITING)

    async def _close_device(self, job_id: str):
        device = self._devices.pop(job_id, None)
        self._mem.pop(job_id, None)
        if device:
            try:
                await device.screen.close()
            except Exception:
                pass

    async def _read(self, device: JobDevice):
        """A screen read with enough confidence to act on, or None; low-confidence reads are never used."""
        for _ in range(READ_ATTEMPTS):
            screen = await device.screen.read_text()
            if screen.confidence >= MIN_CONFIDENCE:
                return screen
        return None

    # -- task management -------------------------------------------------
    def spawn(self, job_id: str):
        if not self.autostart:
            return
        task = self._tasks.get(job_id)
        if task and not task.done():
            return
        self._tasks[job_id] = asyncio.create_task(self._loop(job_id))

    def wake(self, job_id: str):
        event = self._wake.get(job_id)
        if event:
            event.set()

    async def _loop(self, job_id: str):
        event = self._wake.setdefault(job_id, asyncio.Event())
        try:
            while True:
                try:
                    delay = await self.step(job_id)
                except Exception:
                    log.exception("PXE runner step failed for job %s", job_id)
                    await self._fail_unexpected(job_id)
                    return
                if delay is None:
                    return
                try:
                    await asyncio.wait_for(event.wait(), timeout=max(delay, 0.01))
                except asyncio.TimeoutError:
                    pass
                event.clear()
        finally:
            self._wake.pop(job_id, None)

    async def _fail_unexpected(self, job_id: str):
        try:
            async with self.lock(job_id), self.sessions() as db:
                job = await self._get(db, job_id, owned=True)
                if job and job.state not in TERMINAL and job.state != "draft":
                    await self._fail(db, job, "internal_error", "Unexpected automation error; the job was stopped")
        except Exception:
            log.exception("PXE runner could not record the failure of job %s", job_id)
        await self._close_device(job_id)

    async def aclose(self):
        for task in list(self._tasks.values()):
            task.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._tasks.clear()
        for job_id in list(self._devices):
            await self._close_device(job_id)

    async def recover(self, force: bool = False):
        """Jobs without a live owner: before install → failed:interrupted; after install → passive monitor."""
        now = self.clock()
        if not force and self._recovered_at is not None and now - self._recovered_at < 10:
            return
        self._recovered_at = now
        if force or self._pruned_at == 0.0:
            self._pruned_at = time.monotonic()
            await asyncio.to_thread(prune_screens, self.screens_dir)
        async with self.sessions() as db:
            ids = (await db.scalars(select(PxeJob.id).where(PxeJob.state.in_(PRE_INSTALL + POST_INSTALL),
                                                            PxeJob.lease_until < now))).all()
        for job_id in ids:
            task = self._tasks.get(job_id)
            if job_id in self._devices or (task and not task.done()):
                continue
            async with self.lock(job_id), self.sessions() as db:
                job = await self._get(db, job_id, owned=True)
                if not job or job.state in TERMINAL or not await self._claim(db, job):
                    continue
                try:
                    if job.state in PRE_INSTALL:
                        await self._fail(db, job, "interrupted", "The server restarted before the install was sent; the job never resumes")
                        continue
                    await self._event(db, job, "passive_monitor", detail="Server restarted; no console monitoring, deadline only")
                    await self._commit(db, job)
                except Superseded:
                    continue
            self.spawn(job_id)

    async def expire_drafts(self):
        now = self.clock()
        async with self.sessions() as db:
            ids = (await db.scalars(select(PxeJob.id).where(PxeJob.state == "draft", PxeJob.deadline_at <= now))).all()
        for job_id in ids:
            async with self.lock(job_id), self.sessions() as db:
                job = await self._get(db, job_id, owned=False)
                if job and job.state == "draft" and job.deadline_at <= self.clock():
                    job.error_code, job.error_detail = "draft_expired", "The job was not started in time"
                    try:
                        await self._transition(db, job, "cancelled", action="expired", shot=False)
                    except Superseded:
                        pass

    # -- automatic steps -------------------------------------------------
    async def step(self, job_id: str) -> float | None:
        """One unit of automation; returns the delay until the next step, or None when the task should stop."""
        async with self.lock(job_id), self.sessions() as db:
            job = await self._get(db, job_id, owned=True)
            if not job or job.state in TERMINAL or job.state == "draft":
                await self._close_device(job_id)          # closed elsewhere: stop without touching the console
                return None
            if job.lease_owner != self.owner or job.lease_until - self.clock() < LEASE_SECONDS / 2:
                if not await self._claim(db, job):
                    return LEASE_SECONDS / 2
                await db.commit()
            try:
                return await self._step(db, job)
            except Superseded:
                return self.tick                          # the next step re-reads the row; no key was sent

    async def _step(self, db, job: PxeJob) -> float | None:
        now, device = self.clock(), self._devices.get(job.id)
        if device is None:
            if job.state in PRE_INSTALL:
                await self._fail(db, job, "interrupted", "The console session was lost before the install was sent")
                return None
            if now >= job.deadline_at:
                await self._fail(db, job, TIMEOUT_CODES[job.state], "No completion was confirmed in time (console not monitored)")
                return None
            return min(USER_POLL, max(job.deadline_at - now, 0.01))
        if now >= job.deadline_at:
            await self._expire(db, job)
            return None
        try:
            return await getattr(self, "_on_" + job.state)(db, job, device)
        except ScreenDriverError:
            return await self._driver_failed(db, job, device)
        except Expired:
            await self._expire(db, job)
            return None

    async def _driver_failed(self, db, job: PxeJob, device: JobDevice):
        mem = self._mem.setdefault(job.id, {})
        if not mem.get("reopened"):
            mem["reopened"] = True
            try:
                await device.screen.close()
                await device.screen.open()
                reopened = True
            except Exception:
                reopened = False
            if reopened:
                await self._event(db, job, "reconnected", detail="Console session reopened once")
                await self._commit(db, job)
                return self.tick
        await self._fail(db, job, "kvm_disconnected", "The KVM console session failed")
        return None

    def _user_wait(self, job: PxeJob) -> float:
        return min(USER_POLL, max(job.deadline_at - self.clock(), 0.01))

    async def _on_waiting_for_choice(self, db, job, device):
        return self._user_wait(job)

    _on_waiting_for_grub_choice = _on_waiting_for_choice
    _on_ready_to_install = _on_waiting_for_choice

    async def _send_f12(self, db, job, device: JobDevice, mem: dict):
        await self._send(db, job, device, ["F12"])
        mem["last_f12"] = self.clock()

    async def _on_rebooting(self, db, job, device):
        mem = self._mem.setdefault(job.id, {})
        if not mem.get("reboot_sent"):
            mem["reboot_sent"] = True
            if job.reboot_method == "kvm_cad":
                await self._send(db, job, device, ["Ctrl+Alt+Delete"])
                detail = "Ctrl+Alt+Delete sent through the KVM"
            elif job.reboot_method == "pdu_cycle":
                await self._guard(db, job)
                try:
                    await device.power.cycle()
                except ScreenDriverError as exc:
                    # A PDU failure is not a console failure: reopening the console would not reboot the computer.
                    await self._fail(db, job, "power_cycle_failed", f"PDU power cycle failed: {exc}")
                    return None
                detail = "PDU outlet power cycle" + (" (simulated)" if device.machine else "")
            else:
                detail = "Waiting for the computer to be rebooted manually"
            await self._event(db, job, "reboot", detail=detail)
            await self._commit(db, job)
            return self.tick
        screen = await self._read(device)
        if screen and (parsers.is_blank(screen) or parsers.detect_post(screen) or parsers.detect_boot_menu(screen)):
            await self._send_f12(db, job, device, mem)
            await self._transition(db, job, "waiting_for_menu", detail="Restart detected; sending F12")
            return min(self.tick, F12_INTERVAL)
        return self.tick

    async def _on_waiting_for_menu(self, db, job, device):
        mem = self._mem.setdefault(job.id, {})
        screen = await self._read(device)
        if screen:
            menu = parsers.detect_boot_menu(screen)
            if menu:
                options = parsers.boot_options(menu)
                job.boot_options_json = json.dumps(options)
                if not any(o["selectable"] for o in options):
                    await self._fail(db, job, "no_pxe_entry", "The boot menu has no network boot entry")
                    return None
                await self._transition(db, job, "waiting_for_choice", detail=f"Boot menu with {len(options)} entries")
                return self._user_wait(job)
            if parsers.detect_os_login(screen):
                await self._fail(db, job, "boot_menu_timeout", "The operating system started; F12 was not received in time")
                return None
        if self.clock() - mem.get("last_f12", 0) >= F12_INTERVAL:
            await self._send_f12(db, job, device, mem)
        return min(self.tick, F12_INTERVAL)

    async def _on_waiting_for_grub(self, db, job, device):
        screen = await self._read(device)
        if not screen:
            return self.tick
        menu = parsers.detect_grub_menu(screen)
        if menu:
            if menu.countdown is not None:
                await self._send(db, job, device, ["Up"])     # stops the countdown; Right/Enter would boot
                screen = await self._read(device)
                menu = parsers.detect_grub_menu(screen) if screen else None
                if not menu or menu.countdown is not None:
                    return self.tick
            options = parsers.grub_options(menu)
            job.grub_options_json = json.dumps(options)
            if not any(o["selectable"] for o in options):
                await self._fail(db, job, "no_install_entry", "The GRUB menu has no install entry", may_start=False)
                return None
            await self._transition(db, job, "waiting_for_grub_choice", detail=f"GRUB menu with {len(options)} entries; countdown stopped")
            return self._user_wait(job)
        if parsers.detect_kernel_boot(screen) or parsers.detect_installer(screen):
            await self._fail(db, job, "grub_countdown_expired", "The GRUB countdown expired and an entry started booting",
                             may_start=True)
            return None
        if parsers.detect_installer_error(screen):
            await self._fail(db, job, "grub_countdown_expired",
                             "The GRUB countdown expired and a booted entry stopped with an installer error", may_start=True)
            return None
        if parsers.detect_os_login(screen):
            await self._fail(db, job, "grub_countdown_expired", "The GRUB countdown expired and the installed system booted",
                             may_start=False)
            return None
        return self.tick

    async def _on_updating_urls(self, db, job, device):
        mem = self._mem.setdefault(job.id, {})
        if mem.get("edit_sent"):
            await self._fail(db, job, "rewrite_verify", "The edit was interrupted; edits were discarded", esc=True)
            return None
        screen = await self._read(device)
        if not screen:
            return self.tick
        if parsers.detect_grub_auth(screen):
            await self._fail(db, job, "grub_password", "GRUB requires a superuser password to edit entries", esc=True)
            return None
        editor = parsers.detect_grub_editor(screen)
        if not editor:
            return self.tick
        settings = self.settings_fn()
        old, new = settings.pxe_old_repo_host, settings.pxe_new_repo_host
        before = "\n".join(editor.lines)
        try:
            result = rewrite.rewrite_install_urls(before, old, new)
            hosts = rewrite.key_hosts(result.text)
            if any(host.casefold() != new.casefold() for host in hosts.values()):
                raise rewrite.RewriteError("unexpected_host", "inst.repo or inst.ks points to an unexpected host")
            keys = edit_keys(editor.lines, result.changes, new)
        except rewrite.RewriteError as exc:
            await self._fail(db, job, exc.code, exc.detail, esc=True)
            return None
        except ValueError:
            await self._fail(db, job, "invalid_configuration", "The repository host settings are invalid", esc=True)
            return None
        mem["edit_sent"] = True
        if keys:
            await self._send(db, job, device, keys)
        screen = await self._read(device)
        edited = parsers.detect_grub_editor(screen) if screen else None
        expected = result.text.split("\n")
        verified = edited is not None and edited.lines == expected
        if verified:
            try:
                after_hosts = rewrite.key_hosts("\n".join(edited.lines))
                verified = all(h.casefold() == new.casefold() and h.casefold() != old.casefold() for h in after_hosts.values())
            except rewrite.RewriteError:
                verified = False
        if not verified:
            await self._fail(db, job, "rewrite_verify", "The edited entry on screen does not match the expected text; edits were discarded", esc=True)
            return None
        mem.pop("edit_sent", None)
        job.original_cmdline, job.new_cmdline = before, result.text
        job.rewrite_changes_json = json.dumps({"changes": result.changes, "warnings": result.warnings})
        job.rewrite_hash = rewrite.rewrite_hash(before, result.text)
        await self._transition(db, job, "ready_to_install", detail=f"{len(result.changes)} host change(s) verified on screen")
        return self._user_wait(job)

    async def _on_installing(self, db, job, device):
        screen = await self._read(device)
        if not screen:
            return self.tick
        if parsers.detect_installer(screen):
            await self._transition(db, job, "install_started", detail="Installer start detected")
        elif parsers.detect_installer_error(screen):
            await self._fail(db, job, "installer_error", "The installer did not start (emergency shell)")
            return None
        elif parsers.detect_os_login(screen):
            await self._fail(db, job, "installer_not_started", "The computer booted an operating system instead of the installer")
            return None
        return self.tick

    async def _on_install_started(self, db, job, device):
        """Completed only by a login screen seen after the installer's own reboot (blank screen or POST)."""
        if not device.completion_signal:
            return max(self.tick, 1.0)
        mem = self._mem.setdefault(job.id, {})
        screen = await self._read(device)
        if not screen:
            return self.tick
        if parsers.detect_installer_error(screen):
            await self._fail(db, job, "installer_error", "The installer stopped with an error")
            return None
        if not mem.get("rebooted"):
            if parsers.is_blank(screen) or parsers.detect_post(screen):
                mem["rebooted"] = True
                await self._event(db, job, "installer_reboot", detail="The installer restarted the computer")
                await self._commit(db, job)
            return self.tick
        if parsers.detect_os_login(screen):
            job.completion_signal = "installed_os_booted"
            await self._transition(db, job, "completed", detail="The installed operating system booted after the installer reboot")
            await self._close_device(job.id)
            return None
        return self.tick

    # -- user actions ----------------------------------------------------
    async def create(self, *, computer: dict, kvm: dict, reboot_method: str, pdu_targets: list, scenario: str, actor: str) -> str:
        await self.expire_drafts()
        settings = self.settings_fn()
        now = self.clock()
        job = PxeJob(id=uuid.uuid4().hex, computer_key=computer["key"], computer_name=computer["name"],
                     kvm_device_id=kvm["device_id"], kvm_port=kvm["port"], pdu_targets_json=json.dumps(pdu_targets),
                     reboot_method=reboot_method, driver=settings.pxe_driver, sim_scenario=scenario, state="draft",
                     state_entered_at=now, deadline_at=now + TIMEOUTS["draft"], version=1,
                     active_key=computer["key"], active_port_key=f"{kvm['device_id']}:{kvm['port']}",
                     created_by=actor, created_at=now, updated_at=now)
        async with self.sessions() as db:
            db.add(job)
            try:
                await db.flush()
            except IntegrityError:
                await db.rollback()
                raise HTTPException(409, "Another install is active on this computer or KVM port")
            self._mark(job, owned=False)
            job._pxe_guarded = True                    # a new row: nobody else can have changed it
            await self._event(db, job, "create", actor, f"Reboot method: {reboot_method}", "", "draft")
            await db.commit()
        return job.id

    async def start(self, job_id: str, actor: str, reason: str):
        async with self._action(job_id) as db:
            job = await self._load(db, job_id)
            if job.state != "draft":
                raise HTTPException(409, "The job was already started or closed")
            if self.clock() >= job.deadline_at:
                job.error_code, job.error_detail = "draft_expired", "The job was not started in time"
                await self._transition(db, job, "cancelled", action="expired", shot=False)
                raise HTTPException(409, "The job expired; create a new one")
            if await self._running_count(db, job.id) >= max(1, int(self.settings_fn().pxe_max_active_jobs)):
                raise HTTPException(409, BUSY)                # fast path; re-checked atomically below
            if not await self._claim(db, job):
                raise HTTPException(409, "The job is handled by another server worker")
            await db.commit()
            job._pxe_owned = True
            try:
                device = self.factory(job)
                await device.screen.open()
            except DriverUnavailable as exc:
                await self._drop_lease(db, job_id)
                raise HTTPException(503, str(exc))
            except ScreenDriverError:
                await self._drop_lease(db, job_id)
                raise HTTPException(502, "KVM console session failed")
            try:
                await self._guard(db, job)
                if not await self._take_slot(db, job):
                    raise HTTPException(409, BUSY)
            except (HTTPException, Superseded):
                try:
                    await device.screen.close()
                except Exception:
                    pass
                await self._drop_lease(db, job_id)
                raise
            self._devices[job.id], self._mem[job.id] = device, {}
            await self._transition(db, job, "rebooting", actor, "start", reason or "Started")
        self.spawn(job_id)

    async def _locked_job(self, db, job_id: str, state: str, version: int | None = None) -> tuple[PxeJob, JobDevice]:
        job = await self._load(db, job_id, owned=True)
        if job.state != state:
            raise HTTPException(409, "The job is not waiting for this action")
        if version is not None and version != job.version:
            raise HTTPException(409, "The job changed; refresh and try again")
        device = self._devices.get(job_id)
        if not device:
            raise HTTPException(409, "No console session for this job on this server")
        if not await self._claim(db, job):
            raise HTTPException(409, "The job is handled by another server worker")
        await db.commit()
        if self.clock() >= job.deadline_at:
            await self._expire(db, job, "The time to confirm this step expired")
            raise HTTPException(409, "The time for this step expired; the job was stopped")
        return job, device

    async def choose(self, job_id: str, kind: str, option_id: str, version: int, actor: str):
        boot = kind == "boot"
        async with self._action(job_id) as db:
            job, device = await self._locked_job(db, job_id, "waiting_for_choice" if boot else "waiting_for_grub_choice", version)
            options = json.loads((job.boot_options_json if boot else job.grub_options_json) or "[]")
            target = next((i for i, o in enumerate(options) if o["id"] == option_id), None)
            if target is None:
                raise HTTPException(422, "Unknown option for the current screen")
            if not options[target]["selectable"]:
                raise HTTPException(422, "This entry cannot be chosen for a network install")
            try:
                await self._select(db, job, device, options, target, boot, actor)
            except ScreenDriverError:
                await self._fail(db, job, "kvm_disconnected", "The KVM console session failed")
                raise HTTPException(502, "KVM console session failed")
            except Expired:
                await self._expire(db, job, "The time to confirm this step expired")
                raise HTTPException(409, "The time for this step expired; the job was stopped")
        self.wake(job_id)

    async def _select(self, db, job, device, options, target, boot, actor):
        detect = parsers.detect_boot_menu if boot else parsers.detect_grub_menu
        build = parsers.boot_options if boot else parsers.grub_options
        column = "boot_options_json" if boot else "grub_options_json"
        label = options[target]["label"]

        async def refresh(menu, action, detail):
            await self._guard(db, job)
            setattr(job, column, json.dumps(build(menu)))
            job.version += 1
            job.updated_at = self.clock()
            await self._event(db, job, action, actor, detail)
            await self._commit(db, job)

        screen = await self._read(device)
        menu = detect(screen) if screen else None
        if not menu or menu.options != [o["label"] for o in options] or menu.highlight is None:
            if menu:
                await refresh(menu, "menu_changed", "The menu on screen changed before the choice")
            raise HTTPException(409, "The menu on screen changed; review the options again")
        delta = target - menu.highlight
        if delta:
            await self._send(db, job, device, ["Down"] * delta if delta > 0 else ["Up"] * -delta)
        screen = await self._read(device)
        menu = detect(screen) if screen else None
        if not menu or menu.highlight != target or menu.options[target] != label:
            if menu:
                await refresh(menu, "highlight_mismatch", f"Highlight did not reach '{label}'; nothing was selected")
            raise HTTPException(409, "Highlight verification failed; nothing was selected")
        if boot:
            await self._send(db, job, device, ["Enter"])
            job.boot_choice = label
            await self._transition(db, job, "waiting_for_grub", actor, "choose_boot", label)
            return
        await self._send(db, job, device, ["e"])
        job.grub_choice = label
        screen = await self._read(device)
        if screen and parsers.detect_grub_auth(screen):
            await self._event(db, job, "choose_grub", actor, label)
            await self._fail(db, job, "grub_password", "GRUB requires a superuser password to edit entries", esc=True)
            return
        await self._transition(db, job, "updating_urls", actor, "choose_grub", label)

    async def install(self, job_id: str, reviewed_hash: str, actor: str):
        expired = "The time for this step expired; the job was stopped"
        async with self._action(job_id) as db:
            job, device = await self._locked_job(db, job_id, "ready_to_install")
            if job.install_sent_at is not None:
                raise HTTPException(409, "The install was already sent")
            if not isinstance(reviewed_hash, str) or reviewed_hash != job.rewrite_hash:
                raise HTTPException(409, "The reviewed change does not match the current one; refresh and review again")
            try:
                screen = await self._read(device)
            except ScreenDriverError:
                await self._fail(db, job, "kvm_disconnected", "The KVM console session failed")
                raise HTTPException(502, "KVM console session failed")
            editor = parsers.detect_grub_editor(screen) if screen else None
            if not editor or "\n".join(editor.lines) != job.new_cmdline:
                await self._event(db, job, "install_blocked", actor, "The screen no longer shows the reviewed edit")
                await self._commit(db, job)
                raise HTTPException(409, "The screen changed since the review; nothing was sent")
            if self.clock() >= job.deadline_at:
                await self._expire(db, job, "The time to confirm the install expired")
                raise HTTPException(409, expired)
            # The flag is committed with a new version before Ctrl+X, so a crash after the key still blocks the
            # computer and a concurrent cancel fails on the version. Ctrl+X then goes out inside a second guarded
            # write on that version. From here on there is no retry or cancel.
            await self._guard(db, job)
            job.install_sent_at, job.install_may_have_started, job.updated_at = self.clock(), True, self.clock()
            job.version += 1
            await self._event(db, job, "install_sent", actor, "Ctrl+X sent to boot the edited entry")
            await self._commit(db, job)
            await self._guard(db, job)
            try:
                await device.screen.send_keys(["Ctrl+X"])
                sent = True
            except ScreenDriverError:
                sent = False
            await self._commit(db, job)
            if not sent:
                await self._fail(db, job, "install_send_failed", "Sending Ctrl+X failed; the install may have started")
                raise HTTPException(502, "KVM console session failed; the install may have started")
            await self._transition(db, job, "installing", actor, "install", "Booting the installer")
        self.wake(job_id)

    async def cancel(self, job_id: str, actor: str):
        async with self._action(job_id) as db:
            job = await self._load(db, job_id)
            if job.install_sent_at is not None or job.state in POST_INSTALL:
                raise HTTPException(409, "The install was already sent; use manual takeover instead")
            if job.state != "draft" and job.state not in PRE_INSTALL:
                raise HTTPException(409, "The job is already closed")
            await self._guard(db, job)
            device = self._devices.get(job_id)
            if device and job.state in EDITING:
                try:
                    await device.screen.send_keys(["Esc"])
                except Exception:
                    pass
            await self._transition(db, job, "cancelled", actor, "cancel", "Cancelled by the user")
            await self._close_device(job_id)
        self.wake(job_id)

    async def takeover(self, job_id: str, actor: str) -> dict:
        """Stops automation; a simulated job has no real console, so no console URL is returned for it."""
        async with self._action(job_id) as db:
            job = await self._load(db, job_id)
            if job.state in PRE_INSTALL or job.state in POST_INSTALL:
                await self._transition(db, job, "manual_takeover", actor, "takeover", "Automation stopped for manual control")
            elif job.state == "failed":
                if job.driver == "simulated":           # refused before anything is logged
                    raise HTTPException(409, SIMULATED_NO_CONSOLE)
                await self._event(db, job, "takeover", actor, "Console opened after a failure")
                await self._commit(db, job)
            else:
                raise HTTPException(409, "This job cannot be taken over")
            await self._close_device(job_id)
            simulated = job.driver == "simulated"
            url = None if simulated else f"/api/kvms/{quote(job.kvm_device_id, safe='')}/autologin?port={job.kvm_port}"
        self.wake(job_id)
        return {"console_url": url, "simulated": simulated}

    async def complete(self, job_id: str, actor: str):
        async with self._action(job_id) as db:
            job = await self._load(db, job_id)
            if job.state != "install_started":
                raise HTTPException(409, "Only a started install can be marked as completed")
            job.completion_signal = "manual"
            await self._transition(db, job, "completed", actor, "complete", "Completion confirmed by the user")
            await self._close_device(job_id)
        self.wake(job_id)

    async def acknowledge(self, job_id: str, actor: str):
        async with self._action(job_id) as db:
            job = await self._load(db, job_id)
            if job.state not in ("failed", "manual_takeover") or not job.install_may_have_started or job.active_key is None:
                raise HTTPException(409, "Nothing to acknowledge for this job")
            await self._guard(db, job)
            job.active_key = job.active_port_key = None
            job.version += 1
            job.updated_at = self.clock()
            await self._event(db, job, "acknowledge", actor, "Computer released for new installs")
            await self._commit(db, job)

    async def refresh_screenshot(self, job_id: str, actor: str):
        async with self._action(job_id) as db:
            job = await self._load(db, job_id)
            device = self._devices.get(job_id)
            if not device or job.state in TERMINAL:
                raise HTTPException(409, "No console session for this job")
            last = self._refreshed.get(job_id)
            if last is not None and time.monotonic() - last < REFRESH_INTERVAL:
                raise HTTPException(429, "Screenshots can be refreshed every 2 seconds", headers={"Retry-After": "2"})
            self._refreshed[job_id] = time.monotonic()
            await self._guard(db, job)
            ref = await self._screenshot(job)
            if not ref:
                await db.rollback()
                raise HTTPException(502, "KVM console session failed")
            await self._event(db, job, "refresh_screenshot", actor, shot=ref)
            await self._commit(db, job)

    async def drive(self, job_id: str, advance, until=(), max_steps: int = 5000) -> str:
        """Test/fixture helper: steps on a virtual clock until a user, terminal or `until` state."""
        for _ in range(max_steps):
            async with self.sessions() as db:
                state = (await db.get(PxeJob, job_id)).state
            if state in TERMINAL or state in USER_STATES or state in until:
                return state
            delay = await self.step(job_id)
            if delay is not None:
                advance(delay)
        raise RuntimeError("PXE job did not settle")
