import sys, os, base64, secrets, asyncio, subprocess
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
TWIN_DIR = pathlib.Path(__file__).parent.parent.parent / "lab-twin"

_VERSION_FILE = pathlib.Path(__file__).parent.parent / "version.txt"
try:
    # Primary: written by deploy.sh before service restart (reliable in systemd)
    _GIT_HASH = _VERSION_FILE.read_text().strip()
except Exception:
    try:
        _GIT_HASH = subprocess.check_output(
            ["/usr/bin/git", "rev-parse", "--short", "HEAD"],
            cwd=str(pathlib.Path(__file__).parent.parent.parent),
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        _GIT_HASH = "unknown"


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
    if request.url.path == "/api/version":          # public — safe to expose git hash
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
    return {"version": _GIT_HASH}


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
        return FileResponse(str(index))
