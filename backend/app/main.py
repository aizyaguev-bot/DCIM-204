import sys, os, base64, secrets, asyncio, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from contextlib import asynccontextmanager
import pathlib

from .database import init_db, AsyncSessionLocal
from .models import Device
from .routers import devices, pdus, kvms, kvm_proxy
from .config import get_settings
from sqlalchemy import select

FRONTEND_DIST = pathlib.Path(__file__).parent.parent.parent / "frontend" / "dist"

_VERSION_FILE        = pathlib.Path(__file__).parent.parent / "version.txt"
_CHANGELOG_FILE      = pathlib.Path(__file__).parent.parent.parent / "CHANGELOG.md"
_RACK_POSITIONS_FILE = pathlib.Path(__file__).parent.parent / "rack_positions.json"
_RACK_SLOTS_FILE     = pathlib.Path(__file__).parent.parent / "rack_slots.json"
_SWITCH_ASSIGN_FILE  = pathlib.Path(__file__).parent.parent / "switch_assignments.json"
_RACK_ITEMS_FILE     = pathlib.Path(__file__).parent.parent / "rack_items.json"
_RACK_OVERRIDES_FILE = pathlib.Path(__file__).parent.parent / "rack_overrides.json"
_OPT_OWNERS_FILE     = pathlib.Path(__file__).parent.parent / "opt_owners.json"


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
    asyncio.create_task(_warm_cache())
    yield


app = FastAPI(title="Lab Manager", lifespan=lifespan)

@app.middleware("http")
async def basic_auth(request: Request, call_next):
    password = get_settings().lab_manager_password
    if not password:
        return await call_next(request)
    if request.url.path in ("/api/version", "/api/changelog", "/api/rack-positions", "/api/rack-slots", "/api/switch-assignments", "/api/rack-items", "/api/rack-overrides", "/api/opt-owners"):  # public endpoints
        return await call_next(request)
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Basic "):
        try:
            decoded = base64.b64decode(auth[6:]).decode()
            _, provided = decoded.split(":", 1)
            if secrets.compare_digest(provided, password):
                return await call_next(request)
        except Exception:
            pass
    return Response(
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Lab Manager"'},
        content="Unauthorized",
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(devices.router)
app.include_router(pdus.router)
app.include_router(kvms.router)
app.include_router(kvm_proxy.router)


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


@app.get("/api/rack-positions")
async def get_rack_positions():
    try:
        return json.loads(_RACK_POSITIONS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


@app.put("/api/rack-positions")
async def save_rack_positions(payload: dict):
    try:
        _RACK_POSITIONS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/rack-slots")
async def get_rack_slots():
    try:
        return json.loads(_RACK_SLOTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

@app.put("/api/rack-slots")
async def save_rack_slots(payload: dict):
    try:
        _RACK_SLOTS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/switch-assignments")
async def get_switch_assignments():
    try:
        return json.loads(_SWITCH_ASSIGN_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

@app.put("/api/switch-assignments")
async def save_switch_assignments(payload: dict):
    try:
        _SWITCH_ASSIGN_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/rack-items")
async def get_rack_items():
    try:
        return json.loads(_RACK_ITEMS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

@app.put("/api/rack-items")
async def save_rack_items(payload: dict):
    try:
        _RACK_ITEMS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/rack-overrides")
async def get_rack_overrides():
    try:
        return json.loads(_RACK_OVERRIDES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

@app.put("/api/rack-overrides")
async def save_rack_overrides(payload: dict):
    try:
        _RACK_OVERRIDES_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/opt-owners")
async def get_opt_owners():
    try:
        return json.loads(_OPT_OWNERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

@app.put("/api/opt-owners")
async def save_opt_owners(payload: dict):
    try:
        _OPT_OWNERS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True}


# Serve built React frontend if it exists
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        index = FRONTEND_DIST / "index.html"
        return FileResponse(str(index), headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
