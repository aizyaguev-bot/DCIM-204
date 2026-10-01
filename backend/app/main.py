import sys, os, base64, secrets, asyncio, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, JSONResponse
from contextlib import asynccontextmanager
import pathlib

from .database import init_db, AsyncSessionLocal
from .models import Device
from .routers import devices, pdus, kvms, kvm_proxy
from .auth.router import router as auth_router
from .auth.utils import decode_access_token
from .config import get_settings
from sqlalchemy import select

FRONTEND_DIST = pathlib.Path(__file__).parent.parent.parent / "frontend" / "dist"

_VERSION_FILE        = pathlib.Path(__file__).parent.parent / "version.txt"
_CHANGELOG_FILE      = pathlib.Path(__file__).parent.parent.parent.parent / "CHANGELOG.md"
_RACK_POSITIONS_FILE = pathlib.Path(__file__).parent.parent / "rack_positions.json"
_RACK_SLOTS_FILE     = pathlib.Path(__file__).parent.parent / "rack_slots.json"
_SWITCH_ASSIGN_FILE  = pathlib.Path(__file__).parent.parent / "switch_assignments.json"
_RACK_ITEMS_FILE     = pathlib.Path(__file__).parent.parent / "rack_items.json"

_AUTH_EXEMPT = ("/api/version", "/api/changelog")


async def _warm_cache():
    await asyncio.sleep(2)
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

# ── CORS ──────────────────────────────────────────────────────────────────────
_settings = get_settings()
_cors_origins = [_settings.frontend_url] if _settings.frontend_url else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Basic auth (team password gate, optional) ─────────────────────────────────
@app.middleware("http")
async def basic_auth(request: Request, call_next):
    password = get_settings().lab_manager_password
    if not password:
        return await call_next(request)

    path = request.url.path
    if path.startswith("/auth/") or path in _AUTH_EXEMPT:
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


# ── JWT auth middleware (enabled only when JWT_SECRET is set) ─────────────────
@app.middleware("http")
async def jwt_auth(request: Request, call_next):
    settings = get_settings()
    if not settings.jwt_secret:
        return await call_next(request)

    path = request.url.path

    # Auth routes and public API are always accessible
    if path.startswith("/auth/") or path in _AUTH_EXEMPT:
        return await call_next(request)

    # Only gate /api/ routes
    if not path.startswith("/api/"):
        return await call_next(request)

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)

    try:
        payload = decode_access_token(auth[7:])
        request.state.user_id = payload.get("sub")
        request.state.user_email = payload.get("email")
    except Exception:
        return JSONResponse({"detail": "Invalid or expired token"}, status_code=401)

    return await call_next(request)


# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth_router)
app.include_router(devices.router)
app.include_router(pdus.router)
app.include_router(kvms.router)
app.include_router(kvm_proxy.router)


# ── Misc API endpoints ────────────────────────────────────────────────────────
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


# ── Serve React SPA ───────────────────────────────────────────────────────────
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("auth/"):
            raise HTTPException(status_code=404, detail="Not found")
        index = FRONTEND_DIST / "index.html"
        return FileResponse(str(index), headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
