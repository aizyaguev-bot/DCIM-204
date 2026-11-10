"""Isolated real FastAPI + temporary database/inventory, with hardware drivers replaced."""
import asyncio
from contextlib import asynccontextmanager
import copy
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

root = Path(__file__).resolve().parents[2]
data = Path(tempfile.mkdtemp(prefix='dcim-redesign-', ))
os.environ.update(DATABASE_URL=f'sqlite+aiosqlite:///{data / "preview.db"}', LAB_MANAGER_PASSWORD='',
                  PING_MONITOR_ENABLED='false', EMAIL_ALERTS_ENABLED='false')
# Remote PXE install runs against the simulated console only, with fast simulated timings.
for key, value in (('PXE_ENABLED', 'true'), ('PXE_DRIVER', 'simulated'), ('PXE_TICK_SECONDS', '0.25'),
                   ('PXE_SIM_TIME_SCALE', '0.3'), ('PXE_SIM_SCENARIO', 'happy')):
    os.environ.setdefault(key, value)
os.environ['PXE_DRIVER'] = 'simulated'
account_test = os.environ.get('DCIM_TEST_ACCOUNTS') == '1'
os.environ['ACCOUNTS_ENABLED'] = 'true' if account_test else 'false'
if account_test:
    os.environ['LAB_MANAGER_PASSWORD'] = 'test-password-123'
# Device name sync (site port names -> PDU/KVM): DCIM_FAKE_NAME_DEVICES=1 writes them to in-memory fake devices below
# (the real backend decides everything else; DEVICE_NAME_SYNC=auto). Without the flag it stays off, as before.
fake_names = os.environ.get('DCIM_FAKE_NAME_DEVICES') == '1'
os.environ['DEVICE_NAME_SYNC'] = 'auto' if fake_names else 'off'
sys.path.insert(0, str(root / 'backend'))
from app import main, inventory_store, name_sync
from app.database import init_db, AsyncSessionLocal
from app.models import Device, PingTarget, MonitorDeviceSnapshot
from sqlalchemy import select
from app.routers import pdus, kvms, pxe, devices, kvm_proxy
from app.pxe.runner import PxeRunner
from app.config import get_settings
from app.schemas import PduStatus, OutletState, InletReading, KvmStatus, KvmPort
from drivers import raritan_kvm, raritan_pdu
from drivers.raritan_kvm import RaritanKvmDriver, RaritanKvmError
from drivers.raritan_pdu import RaritanPduDriver, RaritanPduError
import httpx
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.routing import Route

import shutil
shutil.copy2(main.TWIN_DIR / 'lab-data.json', data / 'lab-data.json')
main.TWIN_DIR = data
# main binds the twin data path and the /twin static mount at import time; saves must never reach the tracked file.
main._TWIN_DATA_FILE = data / 'lab-data.json'

for name in ('_RACK_POSITIONS_FILE', '_RACK_SLOTS_FILE', '_SWITCH_ASSIGN_FILE', '_RACK_OVERRIDES_FILE', '_OPT_OWNERS_FILE', '_CHILLERS_FILE'):
    setattr(main, name, data / getattr(main, name).name)
devices._BACKEND_DIR = data
inventory_store.ITEMS_FILE = data / 'rack_items.json'
main._VERSION_FILE = data / 'version.txt'
main._VERSION_FILE.write_text('LOCAL PREVIEW - TEST DATA')
items = {f'Rack-{n:02}':[{'id':f'ci-{n}','name':f'Switch {n:02}', 'type':'switch', 'serial_number':f'TEST-{n:03}', 'barcode':f'TEST-{n:03}', 'u':2, 'notes':'Fixture only'}] for n in range(1,8)}
items['Storage-Main'] = []
items['Storage shelf'] = [{'id':'storage-fixture','name':'Spare switch','type':'switch','serial_number':'STORAGE-QA-001','u':0}]
inventory_store.ITEMS_FILE.write_text(json.dumps(items))
main._OPT_OWNERS_FILE.write_text(json.dumps({'opt11':'Fixture owner', 'opt21':'Hardware team'}))
main._CHILLERS_FILE.write_text(json.dumps({'units':[{'id':f'ch{n}', 'name':'Cooling', 'rack':f'Rack-{n:02}', 'u':3} for n in range(1,8)], 'connections':[]}))
power_states = {}

async def pdu_status(device_id, dev):
    n = int(device_id.removeprefix('pdu')) if device_id.startswith('pdu') else 1
    online = n != 7
    def label(i):
        if not fake_names:
            return f'OPT{n}{i}'
        # As the real status read: a saved site label wins, else the name stored on the (fake) PDU or its default.
        saved = json.loads(dev.labels_json or '{}').get(str(i))
        return saved if saved is not None else (stored_names(name_device(dev)).get(i) or f'Outlet {i}')
    outlets = [OutletState(number=i, label=label(i), state=power_states.get((dev.ip,i), 'on') if online else 'unknown', watts=(70+n*20+i*10) if online else 0) for i in range(1,5)]
    return PduStatus(device_id=device_id, reachable=online, inlet_voltage=230 if online else 0, total_watts=sum(o.watts for o in outlets), outlets=outlets,
                     inlet_readings=[InletReading(number=1, voltage=230, current=sum(o.watts for o in outlets)/230, watts=sum(o.watts for o in outlets))] if online else [], error=None if online else 'Fixture: PDU unavailable')

async def kvm_status(device_id, dev):
    return KvmStatus(device_id=device_id, reachable=True, ports=[KvmPort(number=i,label=f'OPT1{i}',status='active' if i==1 else 'idle',status_source='live') for i in range(1,5)])

async def fake_power(self, number, action):
    power_states[(self.ip,number)] = 'off' if action == 'off' else 'on'
    return True

class FakePdu:
    def __init__(self, ip, *args): self.ip = ip
    set_outlet_state = fake_power
    async def close(self): pass

# ── Fake devices for device name sync (DCIM_FAKE_NAME_DEVICES=1) ─────────────────────────────────────────────────
# Each fixture PDU is an in-memory Xerus JSON-RPC device (one outlet per site port, the seeded names stored on it;
# "" = the PDU's own default name). The real RaritanPduDriver talks to it through an httpx mock transport, so its own
# discovery, settings checks, read-modify-write and read-back all run. The KVM's firmware has no known rename method.
# Fixture-only switches: POST /__fixture/name-devices/<id>; GET /__fixture/name-devices shows every fake device.
name_devices = {}
name_device_ips = {}
NAME_DEVICE_MODES = ('ok', 'unreachable', 'settings_changed')
XERUS_OUTLET_TYPE = 'pdumodel.Outlet:3.0.3'

def outlet_rid(number):
    return f'/tfwopaque/{XERUS_OUTLET_TYPE}/outlet.{number - 1}'

def xerus_outlet_settings(name, number):
    """pdumodel.Outlet_3_0_3.Settings as a Xerus PDU returns it (startupState 3 = PDU default)."""
    return {'name': name, 'startupState': 3, 'usePduCycleDelay': True, 'cycleDelay': 10, 'nonCritical': False,
            'sequenceDelay': 200 + number}

def name_device(dev):
    if dev.id not in name_devices:
        labels = json.loads(dev.labels_json or '{}')
        state = {'kind': dev.kind, 'mode': 'unreachable' if dev.id == 'pdu7' else 'ok',
                 'delay': float(os.environ.get('DCIM_FAKE_NAME_DELAY', '0.2')),
                 'writes': [], 'refused': [], 'forbidden': [], 'clobbered': [], 'reads': 0}
        if dev.kind == 'pdu':
            state['outlets'] = {i: xerus_outlet_settings(labels.get(str(i), ''), i) for i in range(1, (dev.port_count or 0) + 1)}
        else:
            state['names'] = {}
        name_devices[dev.id] = state
        name_device_ips[dev.ip] = dev.id
    return name_devices[dev.id]

def stored_names(state):
    return {i: s['name'] for i, s in state['outlets'].items()} if 'outlets' in state else dict(state['names'])

def fake_state_out(state):
    return {**state, 'names': stored_names(state)}

async def xerus_rpc(request):
    """The JSON-RPC calls the name driver may make: getOutlets, getSettings, setSettings. Anything else (power!) is
    refused with an RPC error and logged under "forbidden"; a setSettings that changes another setting under "clobbered"."""
    state = name_devices.get(name_device_ips.get(request.url.host))
    if state is None or state['kind'] != 'pdu' or state['mode'] == 'unreachable':
        raise httpx.ConnectError('[Errno 111] Connection refused', request=request)
    call = json.loads(request.content or b'{}')
    method, params, path, outlets = call.get('method'), call.get('params'), request.url.path, state['outlets']
    answer = lambda value: httpx.Response(200, json={'jsonrpc': '2.0', 'id': call.get('id'), 'result': {'_ret_': value}})
    if path == raritan_pdu.PDU_PATH and method == 'getOutlets':
        return answer([{'rid': outlet_rid(i), 'type': XERUS_OUTLET_TYPE} for i in sorted(outlets)])
    number = next((i for i in outlets if outlet_rid(i) == path), None)
    if number is not None and method == 'getSettings':
        state['reads'] += 1
        return answer(copy.deepcopy(outlets[number]))
    if number is not None and method == 'setSettings':
        await asyncio.sleep(state['delay'])
        new, old = (params or {}).get('settings') if isinstance(params, dict) else None, outlets[number]
        if not isinstance(new, dict) or set(new) != set(old) or any(type(new[k]) is not type(old[k]) for k in old) \
                or len(new['name']) > raritan_pdu.NAME_MAX:
            state['refused'].append([number, 'invalid settings'])
            return answer(1)   # Xerus: 1 = invalid parameters
        moved = sorted(k for k in old if k != 'name' and new[k] != old[k])
        if moved:
            state['clobbered'].append([number, moved])
        stored = copy.deepcopy(new)
        if state['mode'] == 'settings_changed':   # another setting moved on the device during the write
            stored['cycleDelay'] = old['cycleDelay'] + 1
        outlets[number] = stored
        state['writes'].append([number, stored['name']])
        return answer(0)
    state['forbidden'].append([path, method])
    return httpx.Response(200, json={'jsonrpc': '2.0', 'id': call.get('id'), 'error': {'code': -32601, 'message': 'fixture'}})

class XerusHttpx:
    """raritan_pdu's httpx: every client it builds talks to the fake Xerus devices above, never to a network."""
    def __getattr__(self, name):
        return getattr(httpx, name)
    @staticmethod
    def AsyncClient(*args, **kwargs):
        kwargs.pop('verify', None)
        kwargs['transport'] = httpx.MockTransport(xerus_rpc)
        return httpx.AsyncClient(*args, **kwargs)

class FakeXerusPdu(RaritanPduDriver):
    """The real driver code; the preview forbids _rpc/_client_ctx on the base class below, this subclass keeps them."""
    _rpc = RaritanPduDriver._rpc
    _client_ctx = RaritanPduDriver._client_ctx

class FakeNameKvm:
    """A KVM whose rename method is not recognised: never written."""
    def __init__(self, dev): self.state = name_device(dev)
    async def name_support(self): return False, raritan_kvm._NAME_UNSUPPORTED
    async def get_port_names(self):
        self.state['reads'] += 1
        return dict(self.state['names'])
    async def set_port_name(self, port_number, name):
        self.state['refused'].append([port_number, 'unsupported'])
        raise RaritanKvmError(raritan_kvm._NAME_UNSUPPORTED)
    async def close(self): pass

def fake_name_driver(dev, username, password):
    if dev.kind == 'pdu':
        name_device(dev)
        return FakeXerusPdu(dev.ip, username, password)
    return FakeNameKvm(dev)

def forbidden_name_driver(dev, username, password):
    raise RuntimeError('Real hardware access forbidden in isolated preview')

if fake_names:
    raritan_pdu.httpx = XerusHttpx()
name_sync._driver_factory = fake_name_driver if fake_names else forbidden_name_driver

async def fixture_name_devices(request):
    """GET: every fake name device. POST {names:{port:name}, mode, delay, clear_log}: change one behind the site's back.
    A POST also forgets the site's shared 5 s live read of that device (as if 5 s had passed)."""
    if request.method == 'GET':
        return JSONResponse({key: fake_state_out(state) for key, state in name_devices.items()})
    device_id = request.path_params['device_id']
    async with AsyncSessionLocal() as db:
        dev = await db.get(Device, device_id)
    if dev is None or dev.kind not in ('pdu', 'kvm'):
        return JSONResponse({'detail': 'no such fixture device'}, status_code=404)
    state, body = name_device(dev), await request.json()
    for port, value in (body.get('names') or {}).items():
        if 'outlets' in state:
            state['outlets'][int(port)]['name'] = value
        else:
            state['names'][int(port)] = value
    if body.get('mode') is not None:
        if body['mode'] not in NAME_DEVICE_MODES:
            return JSONResponse({'detail': 'mode must be one of ' + ', '.join(NAME_DEVICE_MODES)}, status_code=422)
        state['mode'] = body['mode']
    if body.get('delay') is not None:
        state['delay'] = float(body['delay'])
    if body.get('clear_log'):
        for log in ('writes', 'refused', 'forbidden', 'clobbered'):
            state[log].clear()
    name_sync._reads.pop(device_id, None)
    return JSONResponse(fake_state_out(state))

async def forbidden_rpc(*args, **kwargs):
    raise RuntimeError('Real hardware access forbidden in isolated preview')

def forbidden_client(*args, **kwargs):
    raise RuntimeError('Real hardware access forbidden in isolated preview')

RaritanPduDriver._rpc = forbidden_rpc
RaritanPduDriver._client_ctx = forbidden_rpc
RaritanKvmDriver._client_ctx = forbidden_rpc
RaritanKvmDriver._session_client = forbidden_client
# WebSocket requests bypass the HTTP boundary middleware below.
kvm_proxy.ensure_session = forbidden_rpc
kvm_proxy._login = forbidden_rpc
pdus.RaritanPduDriver = FakePdu
pdus._fetch_status = pdu_status
kvms._fetch_status = kvm_status
async def no_session(*args, **kwargs):
    pass
kvms.ensure_session = no_session
pxe.set_runner(PxeRunner(AsyncSessionLocal, get_settings, screens_dir=data / 'pxe_screens'))

# Maintenance switches outlets only through FakePdu / pdu_status above.
PDU_MAINTENANCE = re.compile(r'/api/pdus/maintenance|/api/pdus/[^/]+/maintenance/(shutdown|restore)')

async def preview_lab_data(request):
    return FileResponse(data / 'lab-data.json', headers={'Cache-Control': 'no-cache'})

# A route, not middleware: the accounts middleware must still decide who may read the inventory.
main.app.router.routes.insert(0, Route('/twin/lab-data.json', preview_lab_data, methods=['GET']))
if fake_names:   # outside /api: fixture switches only, never part of the product API
    main.app.router.routes.insert(0, Route('/__fixture/name-devices', fixture_name_devices, methods=['GET']))
    main.app.router.routes.insert(0, Route('/__fixture/name-devices/{device_id}', fixture_name_devices, methods=['POST']))

@main.app.middleware('http')
async def preview_hardware_boundary(request, call_next):
    path = request.url.path
    if path.startswith('/api/kvms/') and path.endswith('/autologin'):
        return HTMLResponse('<html><body style="background:#111;color:#ddd;font-family:Arial;padding:32px"><h2>Console preview</h2><p>This is a test device. No live KVM connection is opened.</p></body></html>')
    if path.startswith('/api/kvms/') and not path.endswith(('/status', '/mark-in-use', '/mark-free')):
        return JSONResponse({'detail':'Hardware access is disabled in the isolated preview.'}, status_code=409)
    if path.startswith('/api/pdus/') and not path.endswith(('/status', '/power')) and not PDU_MAINTENANCE.fullmatch(path):
        return JSONResponse({'detail':'Hardware access is disabled in the isolated preview.'}, status_code=409)
    return await call_next(request)

@asynccontextmanager
async def lifespan(app):
    await init_db()
    from app.engineers import bootstrap_engineers
    await bootstrap_engineers()
    if account_test:
        from app.accounts import bootstrap_admin, hash_password
        from app.models import User
        await bootstrap_admin()
        async with AsyncSessionLocal() as db:
            for role in ['Viewer', 'Operator']:
                db.add(User(id=role.lower(),username=role.lower(),name=role,role=role,password_hash=hash_password('test-password-123'),created_at=time.time()))
            await db.commit()
    async with AsyncSessionLocal() as db:
        db.add(Device(id='storage-rack',name='Storage rack',kind='rack',model='Storage',ip='0.0.0.0',rack='Storage shelf'))
        db.add(Device(id='compute-rack6',name='Compute-Rack-06',kind='rack',model='Compute',ip='0.0.0.0',rack='Rack-06'))
        db.add(Device(id='compute-rack7',name='Compute-Rack-07',kind='rack',model='Compute',ip='0.0.0.0',rack='Rack-07'))
        for n in range(1,8):
            dev = Device(id=f'pdu{n}',name=f'PDU {n:02}',kind='pdu',model='PX4',ip=f'192.0.2.{n}',rack=f'Rack-{n:02}',port_count=4,labels_json=json.dumps({str(i):f'OPT{n}{i}' for i in range(1,5)}))
            db.add(dev)
            status = await pdu_status(dev.id, dev)
            db.add(MonitorDeviceSnapshot(device_id=dev.id,kind='pdu',ip=dev.ip,checked_at=time.time(),reachable=status.reachable,ports_json=json.dumps([o.model_dump() for o in status.outlets])))
            for i in range(1,5):
                db.add(PingTarget(id=f't{n}{i}',source_key=f'server:opt{n}{i}',name=f'OPT{n}{i}',host=f'opt{n}{i}',rack=dev.rack,checked_at=time.time(),status='up' if n!=7 else 'down',rtt_ms=1.2 if n!=7 else None))
        db.add(Device(id='kvm1',name='KVM 01',kind='kvm',model='KX III',ip='192.0.2.20',rack='Rack-01',port_count=4,labels_json=json.dumps({'1':'OPT11'})))
        db.add(MonitorDeviceSnapshot(device_id='kvm1',kind='kvm',ip='192.0.2.20',checked_at=time.time(),reachable=True,ports_json=json.dumps([{'number':1,'label':'OPT11','status':'active','status_source':'live'}])))
        await db.commit()
    if fake_names:   # the fake devices start with the seeded site names stored on them
        async with AsyncSessionLocal() as db:
            for dev in (await db.execute(select(Device).where(Device.kind.in_(('pdu', 'kvm'))))).scalars():
                name_device(dev)
    await name_sync.start()
    print(f'ISOLATED_PREVIEW_DATA={data}', flush=True)
    if fake_names:
        print(f'FAKE_NAME_DEVICES=1 DEVICE_NAME_SYNC={name_sync.mode()}', flush=True)
    try:
        yield
    finally:
        await name_sync.stop()

main.app.router.lifespan_context = lifespan

# Preview a frontend build from a temporary folder without touching frontend/dist.
preview_dist = os.environ.get('DCIM_PREVIEW_DIST')
if preview_dist:
    from starlette.routing import Mount
    from starlette.staticfiles import StaticFiles
    main.FRONTEND_DIST = Path(preview_dist)
    routes = main.app.router.routes
    for index, route in enumerate(routes):
        if isinstance(route, Mount) and route.path == '/assets':
            routes[index] = Mount('/assets', app=StaticFiles(directory=str(main.FRONTEND_DIST / 'assets')), name='assets')
    print(f'PREVIEW_DIST={main.FRONTEND_DIST}', flush=True)

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(main.app, host='127.0.0.1', port=int(sys.argv[1]) if len(sys.argv)>1 else 8766, access_log=False)
