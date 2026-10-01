"""Isolated real FastAPI + temporary database/inventory, with hardware drivers replaced."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import time

root = Path(__file__).resolve().parents[2]
data = Path(tempfile.mkdtemp(prefix='dcim-redesign-', ))
os.environ.update(DATABASE_URL=f'sqlite+aiosqlite:///{data / "preview.db"}', LAB_MANAGER_PASSWORD='',
                  PING_MONITOR_ENABLED='false', EMAIL_ALERTS_ENABLED='false')
account_test = os.environ.get('DCIM_TEST_ACCOUNTS') == '1'
os.environ['ACCOUNTS_ENABLED'] = 'true' if account_test else 'false'
if account_test:
    os.environ['LAB_MANAGER_PASSWORD'] = 'test-password-123'
sys.path.insert(0, str(root / 'backend'))
from app import main, inventory_store
from app.database import init_db, AsyncSessionLocal
from app.models import Device, PingTarget, MonitorDeviceSnapshot
from app.routers import pdus, kvms
from app.schemas import PduStatus, OutletState, InletReading, KvmStatus, KvmPort
from drivers.raritan_kvm import RaritanKvmDriver
from drivers.raritan_pdu import RaritanPduDriver
from fastapi.responses import HTMLResponse, JSONResponse

import shutil
shutil.copy2(main.TWIN_DIR / 'lab-data.json', data / 'lab-data.json')
main.TWIN_DIR = data

for name in ('_RACK_POSITIONS_FILE', '_RACK_SLOTS_FILE', '_SWITCH_ASSIGN_FILE', '_RACK_OVERRIDES_FILE', '_OPT_OWNERS_FILE', '_CHILLERS_FILE'):
    setattr(main, name, data / getattr(main, name).name)
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
    outlets = [OutletState(number=i, label=f'OPT{n}{i}', state=power_states.get((dev.ip,i), 'on') if online else 'unknown', watts=(70+n*20+i*10) if online else 0) for i in range(1,5)]
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

async def forbidden_rpc(*args, **kwargs):
    raise RuntimeError('Real hardware access forbidden in isolated preview')

RaritanPduDriver._rpc = forbidden_rpc
RaritanKvmDriver._get_client = forbidden_rpc
pdus.RaritanPduDriver = FakePdu
pdus._fetch_status = pdu_status
kvms._fetch_status = kvm_status
async def no_session(*args, **kwargs):
    pass
kvms.ensure_session = no_session

@main.app.middleware('http')
async def preview_hardware_boundary(request, call_next):
    path = request.url.path
    if path.startswith('/api/kvms/') and path.endswith('/autologin'):
        return HTMLResponse('<html><body style="background:#111;color:#ddd;font-family:Arial;padding:32px"><h2>Console preview</h2><p>This is a test device. No live KVM connection is opened.</p></body></html>')
    if path.startswith('/api/kvms/') and not path.endswith(('/status', '/mark-in-use', '/mark-free')):
        return JSONResponse({'detail':'Hardware access is disabled in the isolated preview.'}, status_code=409)
    if path.startswith('/api/pdus/') and not path.endswith(('/status', '/power')):
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
    print(f'ISOLATED_PREVIEW_DATA={data}', flush=True)
    yield

main.app.router.lifespan_context = lifespan
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(main.app, host='127.0.0.1', port=int(sys.argv[1]) if len(sys.argv)>1 else 8766, access_log=False)
