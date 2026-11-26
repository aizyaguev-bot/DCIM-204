"""Remote PXE install API. No endpoint accepts free keys or text; a Raritan job starts only when its console driver is installed."""
import re
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import accounts, confirm
from ..config import get_settings
from ..database import AsyncSessionLocal, get_db
from ..models import PxeJob, PxeJobEvent
from ..pxe import mapping
from ..pxe.raritan_driver import driver_ready
from ..pxe.runner import (BUSY, EVENT_LIMIT, POST_INSTALL, PRE_INSTALL, REBOOT_METHODS, TIMEOUTS, PxeRunner,
                          job_dto)
from ..pxe.sim_driver import SCENARIOS

router = APIRouter(prefix="/api/pxe", tags=["pxe"])
_runner: PxeRunner | None = None
_JOB_ID = re.compile(r"[0-9a-f]{32}")
LIST_LIMIT = 50


def get_runner() -> PxeRunner:
    global _runner
    if _runner is None:
        _runner = PxeRunner(AsyncSessionLocal, get_settings)
    return _runner


def set_runner(runner: PxeRunner | None):
    global _runner
    _runner = runner


async def _ready():
    if not get_settings().pxe_enabled:
        raise HTTPException(404, "Not found")
    await get_runner().recover()


enabled = [Depends(_ready)]


class NewJob(BaseModel):
    model_config = ConfigDict(extra="forbid")
    computer_key: str = Field(min_length=1, max_length=120)
    kvm_device_id: str | None = Field(default=None, min_length=1, max_length=120)
    kvm_port: int | None = Field(default=None, ge=1, le=4096)
    reboot_method: Literal["manual", "kvm_cad", "pdu_cycle"] = "kvm_cad"
    sim_scenario: str | None = Field(default=None, max_length=40)


class Choice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    option_id: str = Field(min_length=1, max_length=64)
    version: int


def _job_id(job_id: str) -> str:
    if not _JOB_ID.fullmatch(job_id):
        raise HTTPException(404, "Job not found")
    return job_id


def _allowlisted(settings, key: str) -> bool:
    """The one allowlist rule for list, create and start: an empty list allows every computer only in simulated mode."""
    allowed = mapping.allowlist(settings.pxe_allowed_computers)
    return key in allowed or (not allowed and settings.pxe_driver == "simulated")


async def _run_limit_reached(db: AsyncSession, settings, exclude: str | None = None) -> bool:
    """PXE_MAX_ACTIVE_JOBS for the whole server: running jobs (rebooting up to install_started) count, drafts do not.

    A read-only early answer for the list, create and start; the runner still takes its slot atomically."""
    query = select(func.count()).select_from(PxeJob).where(PxeJob.state.in_(PRE_INSTALL + POST_INSTALL))
    if exclude:
        query = query.where(PxeJob.id != exclude)
    return (await db.scalar(query) or 0) >= max(1, int(settings.pxe_max_active_jobs))


def _console_blocked() -> bool:
    settings = get_settings()
    return settings.pxe_driver != "simulated" and not driver_ready()


def _actor(request: Request) -> str:
    if get_settings().accounts_enabled:
        return accounts.account(request)["user"]["username"]
    return "lab-user"


async def _dto(db: AsyncSession, job_id: str) -> dict:
    job = await db.get(PxeJob, job_id, populate_existing=True)
    if not job:
        raise HTTPException(404, "Job not found")
    events = (await db.scalars(select(PxeJobEvent).where(PxeJobEvent.job_id == job_id)
                               .order_by(PxeJobEvent.id.desc()).limit(EVENT_LIMIT))).all()
    return job_dto(job, events, get_runner().clock())


async def _confirmed(request: Request, db: AsyncSession, job_id: str, states: tuple, action: str,
                     reason: str = "none") -> tuple[str, str, dict]:
    """Password re-confirmation before an action that reboots or installs; denials are audited on the job."""
    settings = get_settings()
    confirm.require_password_mode(settings, "Remote install actions require a configured password")
    password, text, body = await confirm.read_body(request, reason)
    job = await db.get(PxeJob, job_id, populate_existing=True)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.state not in states:
        raise HTTPException(409, "The job is not waiting for this action")
    state = job.state

    async def denied(by: str):
        db.add(PxeJobEvent(job_id=job_id, at=time.time(), from_state=state, to_state=state, actor=by,
                           action="denied", detail=action))

    by = await confirm.verify(request, db, password, settings, confirm.confirm_lock, denied)
    await db.commit()   # no open read transaction while the runner writes
    return by, text, body


@router.get("/config")
async def pxe_config():
    settings = get_settings()
    if not settings.pxe_enabled:
        return {"enabled": False}
    simulated = settings.pxe_driver == "simulated"
    return {"enabled": True, "driver": settings.pxe_driver, "available": simulated or driver_ready(),
            "password_mode": confirm.password_mode(settings), "new_repo_host": settings.pxe_new_repo_host,
            "old_repo_host": settings.pxe_old_repo_host, "reboot_methods": list(REBOOT_METHODS), "timeouts": TIMEOUTS,
            "max_active_jobs": settings.pxe_max_active_jobs, "scenarios": list(SCENARIOS) if simulated else [],
            "default_scenario": settings.pxe_sim_scenario if simulated else None}


@router.get("/computers", dependencies=enabled)
async def pxe_computers(db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    await get_runner().expire_drafts()
    computers = await mapping.computers(db)
    active = (await db.scalars(select(PxeJob).where(PxeJob.active_key.is_not(None)))).all()
    by_key = {job.active_key: job for job in active}
    busy_ports = {job.active_port_key for job in active}
    run_limit = await _run_limit_reached(db, settings)
    result = []
    for key, computer in computers.items():
        blockers = []
        job = by_key.get(key)
        if job:
            held = job.install_may_have_started and job.state in ("failed", "manual_takeover")
            blockers.append("needs_acknowledge" if held else "active_job")
        if not _allowlisted(settings, key):
            blockers.append("not_allowlisted")
        kvm = [{**k, "busy": f"{k['device_id']}:{k['port']}" in busy_ports} for k in computer["kvm"]]
        if not job and all(k["busy"] for k in kvm):
            blockers.append("kvm_port_busy")
        if not job and run_limit:                 # a computer with its own job shows that job instead
            blockers.append("run_limit")
        if settings.pxe_driver != "simulated" and not driver_ready():
            blockers.append("driver_unavailable")
        result.append({**computer, "kvm": kvm, "eligible": not blockers, "blockers": blockers,
                       "active_job_id": job.id if job else None})
    return result


@router.post("/jobs", status_code=201, dependencies=enabled)
async def pxe_create(body: NewJob, request: Request, db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    if _console_blocked():
        raise HTTPException(503, "The Raritan console driver is not available in this phase")
    confirm.require_password_mode(settings, "Remote install requires a configured password")
    computers = await mapping.computers(db)
    key = mapping.computer_key(body.computer_key)
    computer = computers.get(key) if key else None
    if not computer:
        raise HTTPException(422, "Unknown computer or no KVM port is mapped to it")
    if not _allowlisted(settings, key):
        raise HTTPException(403, "This computer is not allowed for remote install")
    try:
        kvm = mapping.resolve_kvm(computer, body.kvm_device_id, body.kvm_port)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if body.reboot_method == "pdu_cycle" and not computer["pdu"]:
        raise HTTPException(422, "No PDU outlet is mapped to this computer")
    scenario = body.sim_scenario or (settings.pxe_sim_scenario if settings.pxe_sim_scenario in SCENARIOS else "happy")
    if scenario not in SCENARIOS:
        raise HTTPException(422, "Unknown simulation scenario")
    held = await db.scalar(select(PxeJob).where(PxeJob.active_key == key))
    if held and held.install_may_have_started and held.state in ("failed", "manual_takeover"):
        raise HTTPException(409, "A previous install may have started on this computer; an Admin must acknowledge it first")
    if await _run_limit_reached(db, settings):    # no draft row that could never start
        raise HTTPException(409, BUSY)
    await db.commit()
    job_id = await get_runner().create(computer=computer, kvm=kvm, reboot_method=body.reboot_method,
                                       pdu_targets=computer["pdu"] if body.reboot_method == "pdu_cycle" else [],
                                       scenario=scenario, actor=_actor(request))
    return await _dto(db, job_id)


@router.get("/jobs", dependencies=enabled)
async def pxe_jobs(db: AsyncSession = Depends(get_db)):
    await get_runner().expire_drafts()
    jobs = (await db.scalars(select(PxeJob).order_by(PxeJob.created_at.desc()).limit(LIST_LIMIT))).all()
    now = get_runner().clock()
    return [job_dto(job, [], now) for job in jobs]


@router.get("/jobs/{job_id}", dependencies=enabled)
async def pxe_job(job_id: str, db: AsyncSession = Depends(get_db)):
    await get_runner().expire_drafts()
    return await _dto(db, _job_id(job_id))


@router.get("/jobs/{job_id}/screenshot", dependencies=enabled)
async def pxe_screenshot(job_id: str, db: AsyncSession = Depends(get_db)):
    job = await db.get(PxeJob, _job_id(job_id), populate_existing=True)
    found = get_runner().screenshot_file(job) if job else None
    if not found:
        raise HTTPException(404, "No screenshot")
    path, media = found
    return Response(path.read_bytes(), media_type=media, headers={
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})


@router.post("/jobs/{job_id}/start", dependencies=enabled)
async def pxe_start(job_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    job_id = _job_id(job_id)
    if _console_blocked():
        raise HTTPException(503, "The Raritan console driver is not available in this phase")
    # Drafts live 15 minutes: the allowlist or driver may have changed since the job was created.
    job = await db.get(PxeJob, job_id, populate_existing=True)
    if job and not _allowlisted(get_settings(), job.computer_key):
        raise HTTPException(403, "This computer is not allowed for remote install")
    # Before the password check: a start that cannot run must not cost a password attempt or log a denial.
    # An expired draft is left to the runner, which reports the expiry first (as runner.start does).
    if (job and job.state == "draft" and get_runner().clock() < job.deadline_at
            and await _run_limit_reached(db, get_settings(), exclude=job.id)):
        raise HTTPException(409, BUSY)
    by, reason, _ = await _confirmed(request, db, job_id, ("draft",), "start", reason="optional")
    await get_runner().start(job_id, by, reason)
    return await _dto(db, job_id)


@router.post("/jobs/{job_id}/refresh-screenshot", dependencies=enabled)
async def pxe_refresh(job_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    await get_runner().refresh_screenshot(_job_id(job_id), _actor(request))
    return await _dto(db, job_id)


@router.post("/jobs/{job_id}/choose-boot", dependencies=enabled)
async def pxe_choose_boot(job_id: str, body: Choice, request: Request, db: AsyncSession = Depends(get_db)):
    await get_runner().choose(_job_id(job_id), "boot", body.option_id, body.version, _actor(request))
    return await _dto(db, job_id)


@router.post("/jobs/{job_id}/choose-grub", dependencies=enabled)
async def pxe_choose_grub(job_id: str, body: Choice, request: Request, db: AsyncSession = Depends(get_db)):
    await get_runner().choose(_job_id(job_id), "grub", body.option_id, body.version, _actor(request))
    return await _dto(db, job_id)


@router.post("/jobs/{job_id}/install", dependencies=enabled)
async def pxe_install(job_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    job_id = _job_id(job_id)
    by, _, body = await _confirmed(request, db, job_id, ("ready_to_install",), "install")
    await get_runner().install(job_id, body.get("rewrite_hash"), by)
    return await _dto(db, job_id)


@router.post("/jobs/{job_id}/cancel", dependencies=enabled)
async def pxe_cancel(job_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    await get_runner().cancel(_job_id(job_id), _actor(request))
    return await _dto(db, job_id)


@router.post("/jobs/{job_id}/takeover", dependencies=enabled)
async def pxe_takeover(job_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    console = await get_runner().takeover(_job_id(job_id), _actor(request))
    return {**console, "job": await _dto(db, job_id)}


@router.post("/jobs/{job_id}/complete", dependencies=enabled)
async def pxe_complete(job_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    job_id = _job_id(job_id)
    by, _, _ = await _confirmed(request, db, job_id, ("install_started",), "complete")
    await get_runner().complete(job_id, by)
    return await _dto(db, job_id)


@router.post("/jobs/{job_id}/acknowledge", dependencies=enabled)
async def pxe_acknowledge(job_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    await get_runner().acknowledge(_job_id(job_id), _actor(request))
    return await _dto(db, job_id)
