import sys, os, base64, secrets, asyncio, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import FastAPI, Request, HTTPException, Header, Depends
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from contextlib import asynccontextmanager
import pathlib

from .database import init_db, AsyncSessionLocal, get_db
from .models import Device
from .routers import devices, pdus, pdu_maintenance, kvms, kvm_proxy, inventory, monitoring, pxe
from .ping_monitor import monitor_loop
from .alerts import alert_loop
from .accounts import AccountAccess, bootstrap_admin, router as accounts_router
from . import confirm, inventory_store
from .config import get_settings
from sqlalchemy import select

FRONTEND_DIST = pathlib.Path(__file__).parent.parent.parent / "frontend" / "dist"
TWIN_DIR = pathlib.Path(__file__).parent.parent.parent / "lab-twin"

_VERSION_FILE        = pathlib.Path(__file__).parent.parent / "version.txt"
_CHANGELOG_FILE      = pathlib.Path(__file__).parent.parent.parent / "CHANGELOG.md"
_RACK_POSITIONS_FILE = pathlib.Path(__file__).parent.parent / "rack_positions.json"
_RACK_SLOTS_FILE     = pathlib.Path(__file__).parent.parent / "rack_slots.json"
_SWITCH_ASSIGN_FILE  = pathlib.Path(__file__).parent.parent / "switch_assignments.json"
_RACK_OVERRIDES_FILE = pathlib.Path(__file__).parent.parent / "rack_overrides.json"
_OPT_OWNERS_FILE     = pathlib.Path(__file__).parent.parent / "opt_owners.json"
_CHILLERS_FILE       = pathlib.Path(__file__).parent.parent / "chillers.json"


async def _warm_cache():
    """Pre-fetch all device statuses on startup so first page load is instant."""
    await asyncio.sleep(2)          # let DB settle
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Device))
        devs = result.scalars().all()
    tasks = []
    for dev in devs:
        if dev.kind == "pdu":
            tasks.append(pdus._refresh_background(dev.id, dev))
        elif dev.kind == "kvm":
            tasks.append(kvms._refresh_background(dev.id, dev))
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    from .engineers import bootstrap_engineers
    await bootstrap_engineers()
    await bootstrap_admin()
    warmup = asyncio.create_task(_warm_cache())
    monitor = asyncio.create_task(monitor_loop())
    alerts = asyncio.create_task(alert_loop())
    try:
        yield
    finally:
        warmup.cancel()
        monitor.cancel()
        alerts.cancel()
        await asyncio.gather(warmup, monitor, alerts, return_exceptions=True)
        if pxe._runner is not None:
            await pxe._runner.aclose()  # stops PXE job loops and closes their consoles


app = FastAPI(title="Lab Manager", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    """No `input` or `ctx`: a submitted value, such as a password, is never echoed back."""
    errors = [{key: error[key] for key in ("loc", "msg", "type") if key in error} for error in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


_basic_failures: dict[str, float] = {}  # client address -> time of its last wrong Basic password
_basic_lock = asyncio.Lock()            # one throttled check at a time, so pending attempts never count for each other


def _basic_password_ok(auth: str, password: str) -> bool:
    try:
        decoded = base64.b64decode(auth[6:]).decode()
        _, provided = decoded.split(":", 1)
        return secrets.compare_digest(provided, password)
    except Exception:
        return False


async def _basic_throttle(peer: str, valid: bool):
    """The maintenance password throttle's table, limit and window, per client address; a right password is refunded."""
    async with _basic_lock, AsyncSessionLocal() as db:
        try:
            digest = await confirm.reserve_attempt(db, "basic:client:" + peer)
        except HTTPException as exc:
            return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)
        if valid:
            await confirm.refund_attempt(db, digest)
    return None


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if get_settings().accounts_enabled or request.url.path == "/api/auth/status":
        return await call_next(request)
    password = get_settings().lab_manager_password
    if not password:
        return await call_next(request)
    if request.method in ("GET", "HEAD") and request.url.path in ("/api/version", "/api/changelog", "/api/rack-positions", "/api/rack-slots", "/api/switch-assignments", "/api/rack-items", "/api/rack-overrides", "/api/opt-owners", "/api/chillers"):  # public reads
        return await call_next(request)
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Basic "):
        valid = _basic_password_ok(auth, password)
        peer = request.client.host if request.client else "unknown"
        now = time.monotonic()
        for key in [k for k, at in _basic_failures.items() if now - at >= confirm.FAILURE_WINDOW]:
            del _basic_failures[key]
        if not valid:
            _basic_failures[peer] = now  # marked before any await, so a concurrent right guess is throttled as well
        # Only addresses with a recent wrong password go through the throttle table.
        denied = await _basic_throttle(peer, valid) if peer in _basic_failures else None
        if denied:
            return denied
        if valid:
            return await call_next(request)
    return Response(
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Lab Manager"'},
        content="Unauthorized",
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=[] if get_settings().accounts_enabled else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["ETag"],
)
app.add_middleware(AccountAccess)

app.include_router(devices.router)
app.include_router(pdus.router)
app.include_router(pdu_maintenance.router)
app.include_router(kvms.router)
app.include_router(kvm_proxy.router)
app.include_router(inventory.router)
app.include_router(monitoring.router)
app.include_router(pxe.router)
app.include_router(accounts_router)
from . import engineers
app.include_router(engineers.router)


@app.get("/api/version")
async def get_version():
    try:
        version = _VERSION_FILE.read_text().strip()
    except Exception:
        version = "unknown"
    return {"version": version}


@app.get("/api/changelog")
async def get_changelog():
    try:
        text = _CHANGELOG_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        text = "Changelog not found."
    return {"changelog": text}


def _get_layout(path, default, response: Response):
    data = inventory_store.read_layout(path, default)
    response.headers["ETag"] = inventory_store.revision(data)
    response.headers["Cache-Control"] = "no-store"
    return data


def _save_layout(path, default, payload: dict, if_match: str | None, response: Response):
    response.headers["ETag"] = inventory_store.save_layout(path, payload, if_match, default)
    return {"ok": True}


@app.get("/api/rack-positions")
async def get_rack_positions(response: Response):
    return _get_layout(_RACK_POSITIONS_FILE, {}, response)


@app.put("/api/rack-positions")
async def save_rack_positions(payload: dict, response: Response, if_match: str | None = Header(default=None)):
    return _save_layout(_RACK_POSITIONS_FILE, {}, payload, if_match, response)


@app.get("/api/rack-slots")
async def get_rack_slots(response: Response):
    return _get_layout(_RACK_SLOTS_FILE, {}, response)

@app.put("/api/rack-slots")
async def save_rack_slots(payload: dict, response: Response, if_match: str | None = Header(default=None)):
    return _save_layout(_RACK_SLOTS_FILE, {}, payload, if_match, response)


@app.get("/api/switch-assignments")
async def get_switch_assignments(response: Response):
    return _get_layout(_SWITCH_ASSIGN_FILE, {}, response)

@app.put("/api/switch-assignments")
async def save_switch_assignments(payload: dict, response: Response, if_match: str | None = Header(default=None)):
    return _save_layout(_SWITCH_ASSIGN_FILE, {}, payload, if_match, response)


@app.get("/api/rack-items")
async def get_rack_items(response: Response):
    data = inventory_store.read_items()
    response.headers["ETag"] = inventory_store.revision(data)
    response.headers["Cache-Control"] = "no-store"
    return data

@app.put("/api/rack-items")
async def save_rack_items(payload: dict, response: Response, if_match: str | None = Header(default=None)):
    saved = inventory_store.replace_items(payload, if_match)
    response.headers["ETag"] = inventory_store.revision(saved)
    return saved


@app.get("/api/rack-overrides")
async def get_rack_overrides(response: Response):
    return _get_layout(_RACK_OVERRIDES_FILE, {}, response)

@app.put("/api/rack-overrides")
async def save_rack_overrides(payload: dict, response: Response, if_match: str | None = Header(default=None)):
    return _save_layout(_RACK_OVERRIDES_FILE, {}, payload, if_match, response)


@app.get("/api/opt-owners")
async def get_opt_owners(db=Depends(get_db)):
    return await engineers.owner_map(db)

@app.put("/api/opt-owners")
async def save_opt_owners(payload: dict, db=Depends(get_db)):
    return await engineers.replace_legacy_owners(payload, db)


@app.get("/api/chillers")
async def get_chillers(response: Response):
    return _get_layout(_CHILLERS_FILE, {"units": [], "connections": []}, response)

@app.put("/api/chillers")
async def save_chillers(payload: dict, response: Response, if_match: str | None = Header(default=None)):
    return _save_layout(_CHILLERS_FILE, {"units": [], "connections": []}, payload, if_match, response)


_TWIN_DATA_FILE = TWIN_DIR / "lab-data.json"

@app.get("/api/twin-data")
async def get_twin_data():
    """Digital twin inventory (lab-twin/lab-data.json)."""
    try:
        return json.loads(_TWIN_DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

@app.put("/api/twin-data")
async def save_twin_data(payload: dict):
    """Save edits made inside the twin (items, shelves, rack mapping)."""
    _TWIN_DATA_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"ok": True}


# Serve built React frontend if it exists
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")
    if TWIN_DIR.exists():
        app.mount("/twin", StaticFiles(directory=str(TWIN_DIR), html=True), name="twin")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        index = FRONTEND_DIST / "index.html"
        return FileResponse(str(index), headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
