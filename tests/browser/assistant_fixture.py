"""Isolated preview server for the lab assistant (browser checks and manual demos).

Reuses tests/browser/preview-server.py (temporary database and JSON stores, fake PDUs/KVMs, hardware calls blocked)
and adds an active fault the assistant can explain:

* OPT11 is down with an open ping incident, and outlet 1 of PDU 01 (which feeds OPT11) is reported OFF;
* PDU 07 is unreachable and its OPT71-OPT74 are down (from the base preview data);
* the ping monitor is shown as enabled and fresh, but no monitor loop runs: a heartbeat only refreshes the stored
  timestamps, so nothing is ever pinged and no device is contacted;
* the assistant answers in its labelled demo mode (no language model, no API key, no network).

Usage, from the repository root (accounts mode with admin/viewer/operator, password test-password-123):

    python tests/browser/assistant_fixture.py 8791
    DCIM_PREVIEW_DIST=<built frontend folder> python tests/browser/assistant_fixture.py 8791

The server binds to 127.0.0.1 only and refuses port 8000. Stop it with Ctrl+C; the temporary folders it prints
(ISOLATED_PREVIEW_DATA=..., ASSISTANT_PROJECT_ROOT=...) can then be deleted.
"""
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
DEFAULT_PORT = 8791
HEARTBEAT_SECONDS = 30

# Environment for the base preview, set before it imports the application.
os.environ.setdefault('DCIM_TEST_ACCOUNTS', '1')
os.environ.pop('ASSISTANT_ANTHROPIC_API_KEY', None)      # never a real key in the fixture
os.environ['ASSISTANT_LLM_ENABLED'] = 'false'             # labelled demo mode, no network
os.environ['ASSISTANT_ENABLED'] = 'true'
os.environ.setdefault('ASSISTANT_PER_MINUTE', '30')       # browser checks ask several questions per user

_spec = importlib.util.spec_from_file_location('dcim_preview_server', HERE / 'preview-server.py')
preview = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(preview)

from sqlalchemy import select, update  # noqa: E402  (the preview put backend/ on sys.path)

from app.assistant import router as assistant_router  # noqa: E402
from app.assistant import tools_layout  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.database import AsyncSessionLocal  # noqa: E402
from app.models import MonitorDeviceSnapshot, PingIncident, PingMonitorState, PingTarget  # noqa: E402
from app.routers import pdus  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

# The assistant reads the monitor's stored observations; with the monitor marked disabled every observation would
# show as "paused". Mark it enabled for reads only (no monitor loop is started by the preview lifespan).
os.environ['PING_MONITOR_ENABLED'] = 'true'
get_settings.cache_clear()
assert get_settings().ping_monitor_enabled and not get_settings().assistant_anthropic_api_key

main = preview.main
DOWN_SERVER, DOWN_TARGET, FEED_PDU, FEED_OUTLET = 'OPT11', 't11', 'pdu1', 1


def _link_dir(target: Path, link: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError:
        if os.name != 'nt':
            raise
        import _winapi   # a directory junction needs no extra privilege on Windows
        _winapi.CreateJunction(str(target), str(link))


# The router hands the tools a project root; some tools read <root>/backend/*.json and <root>/lab-twin/lab-data.json
# from it, others read the application's configured paths. On the VM both are the same files. Here the preview keeps
# its stores in one temporary folder, so a separate temporary root links backend/ and lab-twin/ to that folder (no
# link ever points into the repository) and holds copies of the allowlisted documents for search_docs.
PROJECT_ROOT = Path(tempfile.mkdtemp(prefix='dcim-assistant-root-'))
_link_dir(preview.data, PROJECT_ROOT / 'backend')
_link_dir(preview.data, PROJECT_ROOT / 'lab-twin')
for _relative in getattr(tools_layout, '_DOCS', ('CHANGELOG.md',)):
    _source = preview.root / _relative
    if _source.is_file():
        (PROJECT_ROOT / _relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_source, PROJECT_ROOT / _relative)
assistant_router.PROJECT_ROOT = PROJECT_ROOT


@main.app.middleware('http')
async def assistant_fixture_boundary(request, call_next):
    """A manual "Check now" would send real ICMP probes to lab host names: refused, like every hardware action."""
    if request.url.path.startswith('/api/monitoring') and request.method not in ('GET', 'HEAD', 'OPTIONS'):
        return JSONResponse({'detail': 'Monitoring actions are disabled in the assistant fixture.'}, status_code=409)
    return await call_next(request)


async def _seed_fault():
    now = time.time()
    # The fake PDU driver reports outlet 1 of PDU 01 as OFF from now on (status page, snapshot and cache agree).
    preview.power_states[('192.0.2.1', FEED_OUTLET)] = 'off'
    async with AsyncSessionLocal() as db:
        db.add(PingMonitorState(id=1, next_run_at=now + 240, last_started_at=now - 5, last_completed_at=now,
                                lease_until=0, error=''))
        await db.execute(update(PingTarget).where(PingTarget.id == DOWN_TARGET).values(
            status='down', rtt_ms=None, detail='100% packet loss', checked_at=now, last_up_at=now - 1870))
        db.add(PingIncident(target_id=DOWN_TARGET, host=DOWN_SERVER.lower(), previous_up_at=now - 1870,
                            first_failed_at=now - 1800, last_failed_at=now, failed_checks=7))
        snapshot = await db.get(MonitorDeviceSnapshot, FEED_PDU)
        ports = json.loads(snapshot.ports_json)
        for port in ports:
            if port.get('number') == FEED_OUTLET:
                port.update(state='off', watts=0)
        snapshot.ports_json = json.dumps(ports)
        snapshot.checked_at = now
        await db.commit()
        devices = (await db.execute(select(preview.Device).where(preview.Device.kind == 'pdu'))).scalars().all()
    # Readings the PDU pages would show (fake driver only), so capacity answers have loads to work with.
    for device in devices:
        pdus._cache[device.id] = (time.monotonic(), await preview.pdu_status(device.id, device))


async def _heartbeat():
    """Keeps the stored observations fresh, as the real monitor would, without probing anything."""
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        now = time.time()
        try:
            async with AsyncSessionLocal() as db:
                await db.execute(update(PingTarget).values(checked_at=now))
                await db.execute(update(MonitorDeviceSnapshot).values(checked_at=now))
                await db.execute(update(PingMonitorState).where(PingMonitorState.id == 1).values(
                    last_started_at=now - 5, last_completed_at=now, next_run_at=now + 240))
                await db.execute(update(PingIncident).where(PingIncident.ended_at.is_(None)).values(last_failed_at=now))
                await db.commit()
        except Exception as exc:  # noqa: BLE001 - a busy database skips one beat
            print(f'heartbeat skipped ({type(exc).__name__})', flush=True)


_base_lifespan = main.app.router.lifespan_context


@asynccontextmanager
async def lifespan(app):
    async with _base_lifespan(app):
        await _seed_fault()
        beat = asyncio.create_task(_heartbeat()) if os.environ.get('ASSISTANT_FIXTURE_HEARTBEAT', '1') == '1' else None
        print(f'ASSISTANT_PROJECT_ROOT={PROJECT_ROOT}', flush=True)
        print('ASSISTANT_FIXTURE_READY demo mode, active fault on OPT11 (outlet 1 of PDU 01 OFF)', flush=True)
        try:
            yield
        finally:
            if beat:
                beat.cancel()
                await asyncio.gather(beat, return_exceptions=True)


main.app.router.lifespan_context = lifespan

if __name__ == '__main__':
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    if port == 8000:
        raise SystemExit('Port 8000 is reserved for the real site; choose another port.')
    uvicorn.run(main.app, host='127.0.0.1', port=port, access_log=False)
