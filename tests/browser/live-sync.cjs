// Live sync and "everything moves with the server" (the owner's rules, 2026-11-10). Two browser contexts: context 1
// (Admin) makes the changes on Racks in Edit mode, context 2 (Operator) only watches its open pages (Racks, Dashboard,
// Server health, the lab display and the 3D twin tab), which must show each change within LIVE_MS of the save, without
// a reload, while an open edit form keeps what was typed in it.
//
// The PDU outlet and KVM port belong to the FLOOR: a server that lands on a floor takes over that floor's outlet and
// port (the labels are rewritten; the PDU and KVM devices never move), and the units on the floor it leaves go with it.
// On Racks (one-place WP-5) a drag opens the server's window on its move dialog and a click opens the window; the dialog
// saves with units_follow (the server moves the units), and each step closes the window before the next drag.
// Checks: (1) a swap inside Rack-01 that takes a floor's units along: the dialog previews the PDU / KVM label changes
// and "Moves with it: Switch 01", ONE POST /api/devices/move-server with units_follow (no rack_items), no other write;
// PDU outlet and KVM port labels swapped, the Dashboard PDU card shows each server on its new floor's outlet, PDU / KVM
// devices and the 3D twin data unchanged; (2) the same with "Move the units on this floor with the server" cleared: the
// units stay; (3) a swap between racks (Racks, Dashboard, Server health Rack column); (4) Move to… onto an empty
// storage shelf from the server's window: "Which PDU outlet feeds shelf 9?" keeps its outlet by default (Racks, Server
// health, lab display); (5) a move onto an empty floor whose PDU outlet is labelled "empty": that outlet is chosen, the
// KVM port stays, and an "empty" key in rack_slots is cleaned out; (5b) a change elsewhere between the preview and
// Confirm: 409, nothing at all was written (the units travel in the refused request), the dialog stays open and
// previews again; (6) a unit move and an owner change, and the twin
// iframe message; (7) an open unit window in context 2 keeps its typed text; (8) a swap made in the server window (no Edit
// mode) and its Undo show on context 2's Racks and Dashboard. Everything is undone and checked.
//
// Fixture: tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1 (run_suite.sh sets it); needs the backend change
// feed (GET /api/changes) and the monitor's current rack. Only fixture data is touched; no live site or hardware.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin=process.env.DCIM_PREVIEW_URL||'http://127.0.0.1:8930';
const PASSWORD='test-password-123';
const LIVE_MS=Number(process.env.LIVE_MS||4000);
const TWIN_MS=Number(process.env.TWIN_MS||8000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const errors=[],passed=[],cleanups=[],timings={};
 async function session(username){
  const c=await browser.newContext({viewport:{width:1440,height:900}});
  await c.addInitScript(()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const login=await c.request.post(origin+'/api/auth/login',{data:{username,password:PASSWORD}});
  assert.equal(login.status(),200,`${username} login`);
  return {c,csrf:(await login.json()).csrf_token,username};
 }
 async function open(s,url,{width=1440,height=900,ready='[data-rack-id]'}={}){
  const p=await s.c.newPage();
  await p.setViewportSize({width,height});
  p.on('pageerror',e=>errors.push(`${s.username} ${url}: ${e.message}`));
  p.on('dialog',d=>{errors.push(`native dialog: ${d.message()}`);d.dismiss().catch(()=>{});});
  await p.goto(origin+url);
  if(ready)await p.locator(ready).first().waitFor({timeout:30000});
  // A marker that only a reload or a navigation would lose.
  await p.evaluate(()=>{window.__liveMarker='kept';});
  return p;
 }
 const kept=async p=>p.evaluate(()=>window.__liveMarker==='kept');
 // Polls check() until it is true; the time counts from `since` (the moment the change was saved).
 async function within(label,since,check,ms=LIVE_MS){
  for(;;){
   if(await check().catch(()=>false)){const took=Date.now()-since;timings[label]=took;return took;}
   if(Date.now()-since>ms+3000)assert.fail(`${label}: not shown within ${ms} ms`);
   await sleep(100);
  }
 }
 const fast=(label,took)=>assert.ok(took<=LIVE_MS,`${label}: shown after ${took} ms (limit ${LIVE_MS} ms)`);
 const card=(p,rack)=>p.locator(`.racks-grid [data-rack-id="${rack}"]`);
 const serverAt=(p,rack,u,name)=>card(p,rack).locator(`[data-u-slot="${u}"] .server-cell[data-server="${name}"]`).count().then(n=>n>0);
 const unitAt=(p,rack,u,id)=>card(p,rack).locator(`[data-u-slot="${u}"] .equipment-cell[data-item-id="${id}"]`).count().then(n=>n>0);
 const editToggle=p=>p.locator('button.edit-toggle');
 async function setEdit(p,on){if((await editToggle(p).getAttribute('aria-pressed')==='true')!==on)await editToggle(p).click();await p.waitForFunction(v=>document.querySelector('button.edit-toggle')?.getAttribute('aria-pressed')===String(v),on);}
 async function drag(p,from,to){
  await from.scrollIntoViewIfNeeded();await sleep(150);
  const a=await from.boundingBox();
  await p.mouse.move(a.x+a.width/2,a.y+a.height/2);await p.mouse.down();
  await p.mouse.move(a.x+a.width/2+12,a.y+a.height/2+12,{steps:4});
  const b=await to.boundingBox();await p.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:15});
  await sleep(250);await p.mouse.up();
 }
 const grip=(p,rack,name)=>card(p,rack).locator(`.server-cell[data-server="${name}"] .shelf-grip`);
 const cell=(p,rack,name)=>card(p,rack).locator(`.server-cell[data-server="${name}"]`);
 // What the page writes: every PUT /api/rack-layout (its parts) and every applied (not dry-run) move-server.
 function writes(p){
  const w={layout:[],moves:[]};
  p.on('request',r=>{
   if(r.method()==='PUT'&&r.url().endsWith('/api/rack-layout'))w.layout.push(Object.keys(JSON.parse(r.postData()||'{}')).sort());
   if(r.method()==='POST'&&r.url().endsWith('/api/devices/move-server')){const b=JSON.parse(r.postData()||'{}');if(!b.dry_run)w.moves.push(b);}
  });
  return w;
 }
 const applied=p=>p.waitForResponse(r=>r.url().endsWith('/api/devices/move-server')&&r.request().method()==='POST'&&!JSON.parse(r.request().postData()||'{}').dry_run,{timeout:20000});
 const moveDialog=p=>p.locator('[data-dialog="server-move"]');
 // The server window a click or a drag opened: closed with its × before the next step (the page behind is inert).
 async function closeWindow(p){const win=p.locator('[data-window]');if(await win.count()){await win.locator('.lab-window-close').click();await win.waitFor({state:'detached'});}}
 // The dialog's preview (the server's dry run) is shown and Confirm is enabled.
 async function previewed(dlg){
  await dlg.locator('[data-list="places"]').waitFor({timeout:15000});
  await dlg.locator('[data-action="confirm-move"]:not([disabled])').waitFor({timeout:15000});
  return dlg.locator('[data-move-preview]').innerText();
 }
 let verify=null;   // checks that the fixture is back as it was (set once the original is read)

 try{
  const s1=await session('admin'),s2=await session('operator');
  assert.equal((await(await s1.c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA','fixture marker');
  const feed=await s1.c.request.get(origin+'/api/changes');
  assert.equal(feed.status(),200,'GET /api/changes (the backend change feed) must exist');
  assert.ok(Number.isFinite((await feed.json()).rev),'the change feed answers {rev, domains}');
  const H=(s,etag)=>({...(etag?{'If-Match':etag}:{}),'X-DCIM-CSRF':s.csrf});
  async function get(path){const r=await s1.c.request.get(origin+path);assert.equal(r.status(),200,path);return{data:await r.json(),etag:r.headers()['etag']};}
  async function put(path,mutate){const {data,etag}=await get(path);const r=await s1.c.request.put(origin+path,{data:mutate(structuredClone(data)),headers:H(s1,etag)});assert.equal(r.status(),200,`${path}: ${await r.text()}`);return Date.now();}
  const devicesNow=async()=>(await get('/api/devices/')).data;
  const labelsOf=async id=>((await devicesNow()).find(d=>d.id===id)||{}).labels||{};
  async function setLabels(id,map){const r=await s1.c.request.patch(origin+`/api/devices/${id}/labels`,{data:map,headers:H(s1)});assert.equal(r.status(),200,await r.text());return Date.now();}
  const findItem=(doc,id)=>{for(const [rack,list] of Object.entries(doc))for(const item of list||[])if(item.id===id)return{rack,item};return null;};
  const STORES=['/api/rack-slots','/api/rack-positions','/api/rack-overrides','/api/switch-assignments'];
  const strip=doc=>JSON.parse(JSON.stringify(doc,(k,v)=>k==='tracking_history'||k==='last_seen_at'?undefined:v));
  // Where every PDU and KVM is (never changed by a server move) and the 3D twin's data (never written by one).
  const placesOfDevices=async()=>(await devicesNow()).filter(d=>d.kind==='pdu'||d.kind==='kvm').map(d=>({id:d.id,rack:d.rack,notes:d.notes||'',name:d.name})).sort((a,b)=>a.id.localeCompare(b.id));
  const twinText=async()=>{const r=await s1.c.request.get(origin+'/twin/lab-data.json');assert.equal(r.status(),200);return r.text();};
  // Each server's ports and place as the server sees them (saved labels and the names the KVM reports).
  const locations=async()=>(await get('/api/devices/locations')).data;
  const portsOf=(loc,name)=>{const row=loc.servers.find(s=>s.name===name);return row?{rack:row.rack,pdu:row.pdu.map(p=>`${p.device_id}:${p.port}`),kvm:row.kvm.map(p=>`${p.device_id}:${p.port}`)}:null;};

  // ── the fixture as it was, put back at the end ──
  const PDUS=['pdu1','pdu2','pdu3','pdu4','pdu5','pdu6','pdu7'];
  const original={items:(await get('/api/rack-items')).data,owners:(await get('/api/opt-owners')).data,labels:{},devices:await placesOfDevices(),twin:await twinText()};
  for(const path of STORES)original[path]=(await get(path)).data;
  for(const id of PDUS)original.labels[id]=await labelsOf(id);
  const kvmOriginal=await labelsOf('kvm1');
  const sameDevices=async what=>assert.deepEqual(await placesOfDevices(),original.devices,`${what}: no PDU or KVM moved`);
  const sameTwin=async what=>assert.equal(await twinText(),original.twin,`${what}: the 3D twin data was not written`);
  verify=async()=>{
   for(const [id,map] of Object.entries(original.labels))assert.deepEqual(await labelsOf(id),map,`${id} labels restored`);
   for(const path of STORES)assert.deepEqual((await get(path)).data,original[path],`${path} restored`);
   assert.deepEqual(strip((await get('/api/rack-items')).data),strip(original.items),'rack items restored');
   assert.deepEqual((await get('/api/opt-owners')).data,original.owners,'owners restored');
   const loc=await locations();
   for(const name of Object.keys(original.ports))assert.deepEqual(portsOf(loc,name),original.ports[name],`${name} ports and place restored`);
   await sameDevices('end');
  };
  cleanups.push(async()=>{
   for(const [id,map] of Object.entries(original.labels))if(JSON.stringify(await labelsOf(id))!==JSON.stringify(map))await setLabels(id,map);
   // The KVM: every port its own reported name again (a move saved those names on the ports it rewrote).
   if(JSON.stringify(await labelsOf('kvm1'))!==JSON.stringify(kvmOriginal))await setLabels('kvm1',{...kvmOriginal,1:'OPT11',2:'OPT12',3:'OPT13',4:'OPT14'});
   for(const path of STORES)await put(path,()=>original[path]);
   await put('/api/rack-items',()=>original.items);
   const owners=(await get('/api/opt-owners')).data;
   for(const key of Object.keys(owners))if(!(key in original.owners)){const r=await s1.c.request.put(origin+`/api/opt-owners/${encodeURIComponent(key)}`,{data:{engineer_id:null},headers:H(s1)});assert.equal(r.status(),200,await r.text());}
  });

  // ── context 2 (Operator): the pages that watch (they also read every PDU / KVM, so the KVM's port names are known) ──
  const racks2=await open(s2,'/?tab=racks',{height:1300});
  const dash2=await open(s2,'/?tab=dashboard',{ready:'section.device-card[aria-label="PDU 03"] .pdu-outlet-cell'});
  const health2=await open(s2,'/?tab=monitoring',{ready:'button[aria-label="View history for OPT14"]'});
  const display2=await open(s2,'/?tab=display',{width:1920,height:1080,ready:'[data-rack="Rack-07"]'});
  for(const p of [racks2,dash2,health2,display2])assert.equal(await p.evaluate(()=>document.visibilityState),'visible','every watching page is visible (the feed polls only then)');
  await dash2.locator('section.device-card[aria-label="KVM 01"]').first().waitFor({timeout:30000}).catch(()=>{});
  original.ports={};
  {const loc=await locations();for(const name of ['OPT11','OPT12','OPT13','OPT14','OPT21','OPT31','OPT33','OPT71','OPT74'])original.ports[name]=portsOf(loc,name);}
  assert.deepEqual(original.ports.OPT12,{rack:'Rack-01',pdu:['pdu1:2'],kvm:['kvm1:2']},'start: OPT12 on PDU 01 outlet 2 and KVM 01 port 2');
  // ── context 1 (Admin): Racks in Edit mode, tall enough for Rack-01 and Rack-02 side by side ──
  const p1=await open(s1,'/?tab=racks',{height:1300});
  await setEdit(p1,true);
  const w=writes(p1);
  for(const [u,name] of [[1,'OPT11'],[2,'OPT12'],[3,'OPT13'],[4,'OPT14']])assert.ok(await serverAt(racks2,'Rack-01',u,name),`start: ${name} on Rack-01 floor ${u}`);
  assert.ok(await unitAt(racks2,'Rack-01',2,'ci-1'),'start: Switch 01 on Rack-01 floor 2');
  const outlets=(p,pdu)=>p.locator(`section.device-card[aria-label="${pdu}"] .pdu-outlet-cell`).evaluateAll(els=>els.map(e=>e.innerText.trim()));
  const rackOf=name=>health2.locator('tr',{has:health2.locator(`button[aria-label="View history for ${name}"]`)}).locator('td').nth(1).innerText();

  // ── 1. a swap inside Rack-01 that takes a floor's units along; the outlets and KVM ports stay with the floors ──
  {
   await drag(p1,grip(p1,'Rack-01','OPT12'),cell(p1,'Rack-01','OPT14'));
   await p1.locator('[data-window="server"] h2.lab-window-name',{hasText:'OPT12'}).waitFor();
   const dlg=moveDialog(p1);await dlg.waitFor();
   assert.match(await dlg.locator('h2').innerText(),/^Swap OPT12 and OPT14$/);
   assert.equal(await dlg.getByLabel('Move the units on this floor with the server').isChecked(),true,'checked by default');
   const plan=await previewed(dlg);
   assert.match(await dlg.locator('[data-units-follow]').innerText(),/Moves with it: Switch 01/);
   for(const line of ['PDU 01 outlet 2: OPT12 → OPT14','PDU 01 outlet 4: OPT14 → OPT12','KVM 01 port 2: OPT12 → OPT14','KVM 01 port 4: OPT14 → OPT12'])assert.ok(plan.includes(line),`the preview lists "${line}":\n${plan}`);
   const before={layout:w.layout.length,moves:w.moves.length};
   const done=applied(p1);
   await dlg.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);const t=Date.now();
   await dlg.waitFor({state:'detached'});await closeWindow(p1);
   assert.deepEqual(w.layout.slice(before.layout),[],'no PUT /api/rack-layout: the units travel in the move itself');
   assert.equal(w.moves.length-before.moves,1,'one move-server for the servers, their ports and the units');
   const sent=w.moves.at(-1);
   assert.deepEqual(sent,{server:'OPT12',target_server:'OPT14',swap:true,units_follow:true,dry_run:false,plan_revision:sent.plan_revision});
   assert.ok(sent.plan_revision,'the preview\'s plan revision');
   const pdu1=await labelsOf('pdu1');
   assert.deepEqual([pdu1['2'],pdu1['4']],['OPT14','OPT12'],'PDU 01 outlets 2 and 4 swapped names');
   const loc=await locations();
   assert.deepEqual(portsOf(loc,'OPT12'),{rack:'Rack-01',pdu:['pdu1:4'],kvm:['kvm1:4']},'OPT12 takes floor 4\'s outlet and KVM port');
   assert.deepEqual(portsOf(loc,'OPT14'),{rack:'Rack-01',pdu:['pdu1:2'],kvm:['kvm1:2']},'OPT14 takes floor 2\'s outlet and KVM port');
   const where=findItem((await get('/api/rack-items')).data,'ci-1');
   assert.deepEqual([where.rack,where.item.u],['Rack-01',4],'Switch 01 is on floor 4 with OPT12');
   await sameDevices('swap inside Rack-01');await sameTwin('swap inside Rack-01');
   fast('swap inside a rack (Racks)',await within('swap inside a rack (Racks)',t,async()=>await serverAt(racks2,'Rack-01',4,'OPT12')&&await unitAt(racks2,'Rack-01',4,'ci-1')&&await serverAt(racks2,'Rack-01',2,'OPT14')));
   fast('swap inside a rack (Dashboard)',await within('swap inside a rack (Dashboard)',t,async()=>JSON.stringify(await outlets(dash2,'PDU 01'))===JSON.stringify(['OPT11','OPT14','OPT13','OPT12'])));
   passed.push('1 drag OPT12 onto OPT14 (Rack-01) opens OPT12\'s window: the dialog previews PDU 01 outlets 2/4 and KVM 01 ports 2/4 and "Moves with it: Switch 01" (box checked); ONE move-server with units_follow (no rack_items), no rack-layout request; labels and KVM ports swapped, Switch 01 on floor 4, no PDU/KVM moved, twin data untouched; context 2 Racks and the Dashboard PDU 01 card follow');
  }

  // ── 2. the same with the box cleared: the servers swap (with their floors' outlets), the units stay ──
  {
   await drag(p1,grip(p1,'Rack-01','OPT11'),cell(p1,'Rack-01','OPT12'));
   const dlg=moveDialog(p1);await dlg.waitFor();
   assert.match(await dlg.locator('h2').innerText(),/^Swap OPT11 and OPT12$/);
   await previewed(dlg);
   assert.match(await dlg.locator('[data-units-follow]').innerText(),/Moves with OPT12: Switch 01/);
   await dlg.getByLabel('Move the units on this floor with the server').uncheck();
   await previewed(dlg);
   const before=w.layout.length,done=applied(p1);
   await dlg.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);const t=Date.now();
   await dlg.waitFor({state:'detached'});await closeWindow(p1);
   assert.equal(w.layout.length,before,'no units: no rack-layout request');
   assert.equal('rack_items' in w.moves.at(-1),false,'no units in the move either');
   assert.equal(w.moves.at(-1).units_follow,false,'units_follow false: the units stay');
   assert.equal(findItem((await get('/api/rack-items')).data,'ci-1').item.u,4,'Switch 01 stayed on floor 4');
   const pdu1=await labelsOf('pdu1');
   assert.deepEqual([pdu1['1'],pdu1['4']],['OPT12','OPT11']);
   fast('units stay with the box cleared',await within('units stay with the box cleared',t,async()=>await serverAt(racks2,'Rack-01',1,'OPT12')&&await serverAt(racks2,'Rack-01',4,'OPT11')&&await unitAt(racks2,'Rack-01',4,'ci-1')));
   passed.push('2 the same with "Move the units on this floor with the server" cleared: OPT11 and OPT12 swap floors and outlets, Switch 01 stays on floor 4, no rack-layout request');
  }

  // ── 3. a swap between racks (drag OPT14 onto OPT21): Racks, the Dashboard and the Server health Rack column ──
  {
   await drag(p1,grip(p1,'Rack-01','OPT14'),cell(p1,'Rack-02','OPT21'));
   const dlg=moveDialog(p1);await dlg.waitFor();
   assert.match(await dlg.locator('h2').innerText(),/^Swap OPT14 and OPT21$/);
   const plan=await previewed(dlg);
   for(const line of ['PDU 01 outlet 2: OPT14 → OPT21','PDU 02 outlet 1: OPT21 → OPT14'])assert.ok(plan.includes(line),`the preview lists "${line}":\n${plan}`);
   const done=applied(p1);
   await dlg.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);const t=Date.now();
   await dlg.waitFor({state:'detached'});await closeWindow(p1);
   assert.equal((await labelsOf('pdu2'))['1'],'OPT14');assert.equal((await labelsOf('pdu1'))['2'],'OPT21');
   await sameDevices('swap between racks');
   fast('swap between racks (Racks)',await within('swap between racks (Racks)',t,async()=>await serverAt(racks2,'Rack-02',1,'OPT14')&&await serverAt(racks2,'Rack-01',2,'OPT21')));
   fast('swap between racks (Dashboard)',await within('swap between racks (Dashboard)',t,async()=>(await outlets(dash2,'PDU 02'))[0]==='OPT14'&&(await outlets(dash2,'PDU 01'))[1]==='OPT21'));
   fast('swap between racks (Server health)',await within('swap between racks (Server health)',t,async()=>(await rackOf('OPT14'))==='Rack-02'&&(await rackOf('OPT21'))==='Rack-01'));
   passed.push('3 drag OPT14 (Rack-01) onto OPT21 (Rack-02): each takes the other\'s outlet (PDU 01 #2 / PDU 02 #1); context 2 Racks, Dashboard and the Server health Rack column follow');
  }

  // ── 4. Move to rack from the server's panel onto an empty storage shelf: its outlet stays (the default) ──
  {
   const shownBefore=await display2.locator('[data-rack="Rack-01"] .ld-rack-servers').innerText();
   await cell(p1,'Rack-01','OPT13').locator('button.server-open').click();
   const side=p1.locator('[data-window="server"]');await side.locator('h2.lab-window-name',{hasText:'OPT13'}).waitFor();
   await side.locator('[data-action="move-to"]').click();
   const dlg=moveDialog(p1);await dlg.waitFor();
   await dlg.getByLabel('Rack',{exact:true}).selectOption('Storage shelf');
   await dlg.getByLabel('Shelf',{exact:true}).selectOption('9');
   assert.match(await dlg.locator('h2').innerText(),/^Move OPT13$/,'an empty shelf: a move, not a swap');
   const ask=dlg.locator('[data-floor-outlet]');
   assert.equal(await ask.locator('legend').innerText(),'Which PDU outlet feeds shelf 9?');
   assert.equal(await ask.locator('select').inputValue(),'keep','default: keep its current outlet');
   assert.match(await ask.locator('select option:checked').innerText(),/^Keep PDU 01 · outlet 3$/);
   const plan=await previewed(dlg);
   assert.match(plan,/OPT13: Rack-01 · floor 3 → Storage shelf · shelf 9/);
   const done=applied(p1);
   await dlg.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);const t=Date.now();
   await dlg.waitFor({state:'detached'});await closeWindow(p1);
   assert.deepEqual(portsOf(await locations(),'OPT13'),{rack:'Storage shelf',pdu:['pdu1:3'],kvm:['kvm1:3']},'it keeps PDU 01 outlet 3 and KVM 01 port 3');
   await sameDevices('move to a storage shelf');
   fast('Move to rack (Racks)',await within('Move to rack (Racks)',t,async()=>await serverAt(racks2,'Storage shelf',9,'OPT13')));
   fast('Move to rack (Server health)',await within('Move to rack (Server health)',t,async()=>(await rackOf('OPT13'))==='Storage shelf'));
   fast('Move to rack (lab display)',await within('Move to rack (lab display)',t,async()=>/^3\s*\/\s*3/.test(await display2.locator('[data-rack="Rack-01"] .ld-rack-servers').innerText())));
   passed.push(`4 OPT13's window: Move to… "Storage shelf", shelf 9: "Which PDU outlet feeds shelf 9?" keeps PDU 01 outlet 3 by default; context 2 Racks, the Server health Rack column and the lab display (Rack-01 "${shownBefore.replace(/\s+/g,' ')}" -> 3 / 3 on) follow`);
  }

  // ── 5. onto an empty floor whose outlet the PDU labels "empty": that outlet feeds it; an "empty" key is cleaned ──
  {
   await setLabels('pdu7',{...original.labels.pdu7,4:'empty'});   // Rack-07 floor 4 is empty now
   await put('/api/rack-slots',d=>({...d,'Rack-07':{...(d['Rack-07']||{}),empty:4}}));   // old data: a placeholder as a server
   await within('Rack-07 floor 4 empty (context 1)',Date.now(),async()=>(await card(p1,'Rack-07').locator('.server-cell[data-server="OPT74"]').count())===0,LIVE_MS);
   // A window opened again first shows the lab data of the last one: wait for its fresh read of the server list.
   const fresh=p1.waitForResponse(r=>r.url().endsWith('/api/devices/locations')&&r.request().method()==='GET');
   await card(p1,'Storage shelf').locator('.server-cell[data-server="OPT13"] button.server-open').click();
   const side=p1.locator('[data-window="server"]');await side.locator('h2.lab-window-name',{hasText:'OPT13'}).waitFor();
   await fresh;await sleep(300);
   await side.locator('[data-action="move-to"]').click();
   const dlg=moveDialog(p1);await dlg.waitFor();
   await dlg.getByLabel('Rack',{exact:true}).selectOption('Rack-07');
   assert.equal(await dlg.getByLabel('Floor',{exact:true}).inputValue(),'4','the first free floor');
   const ask=dlg.locator('[data-floor-outlet]');
   await ask.locator('select:not([disabled])').waitFor();
   assert.equal(await ask.locator('select').inputValue(),'pdu7:4','the outlet labelled "empty" for floor 4 is chosen');
   assert.match(await ask.innerText(),/Preselected: PDU 07 outlet 4 is labelled “empty” and has this floor's number\. Choose another outlet if a different one feeds it\./);
   const plan=await previewed(dlg);
   assert.ok(plan.includes('PDU 07 outlet 4: empty → OPT13'),plan);
   const done=applied(p1);
   await dlg.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);const t=Date.now();
   await dlg.waitFor({state:'detached'});await closeWindow(p1);
   assert.deepEqual(portsOf(await locations(),'OPT13'),{rack:'Rack-07',pdu:['pdu7:4'],kvm:['kvm1:3']},'PDU 07 outlet 4 feeds it; its KVM port stays');
   assert.equal((await labelsOf('pdu1'))['3'],'Outlet 3','its old outlet is free');
   let slots;for(let i=0;i<30;i++){slots=(await get('/api/rack-slots')).data;if(!('empty' in (slots['Rack-07']||{})))break;await sleep(150);}
   assert.equal('empty' in (slots['Rack-07']||{}),false,`the "empty" key left rack_slots (${JSON.stringify(slots['Rack-07'])})`);
   await sameDevices('move onto an empty floor');await sameTwin('every move');
   fast('move onto an empty floor (Racks)',await within('move onto an empty floor (Racks)',t,async()=>await serverAt(racks2,'Rack-07',4,'OPT13')));
   passed.push('5 OPT13 to Rack-07 floor 4 (its PDU outlet labelled "empty"): the dialog chooses PDU 07 outlet 4 and says why, the KVM port stays, PDU 01 outlet 3 is free, the stale "empty" rack_slots key is cleaned; context 2 Racks follows');
  }

  // ── 5b. a change elsewhere between the preview and Confirm: nothing is left half done, the dialog stays open ──
  {
   await drag(p1,grip(p1,'Rack-01','OPT11'),cell(p1,'Rack-01','OPT12'));
   const dlg=moveDialog(p1);await dlg.waitFor();
   assert.match(await dlg.locator('h2').innerText(),/^Swap OPT11 and OPT12$/);
   // This tab hears of the other change only through the refused save (its change feed is held for this step).
   await p1.route('**/api/changes',r=>r.fulfill({status:503,contentType:'application/json',body:'{}'}));
   const plan=await previewed(dlg);
   assert.match(await dlg.locator('[data-units-follow]').innerText(),/Moves with it: Switch 01/);
   assert.ok(plan.includes('KVM 01 port 1: OPT12 → OPT11'),plan);
   // The page's periodic device reload (App: every refresh_seconds) would also preview the latest before Confirm:
   // held from here until the refused save, so Confirm sends the preview made before the change elsewhere.
   let open;const gate=new Promise(r=>{open=r;});const deviceList=u=>u.pathname==='/api/devices/';
   await p1.route(deviceList,async r=>{await gate;await r.continue().catch(()=>{});});
   await setLabels('kvm1',{...(await labelsOf('kvm1')),1:'Port 1'});   // OPT12 loses its KVM port elsewhere
   const before={layout:w.layout.length,pdu1:await labelsOf('pdu1')};
   let done=applied(p1);
   await dlg.locator('[data-action="confirm-move"]').click();
   const refused=(await done).status();open();await p1.unroute(deviceList);
   assert.equal(refused,409,'the server refuses a plan that changed since the preview');
   await dlg.getByRole('alert').filter({hasText:'changed in another session meanwhile, so nothing was saved'}).waitFor();
   assert.deepEqual(w.layout.slice(before.layout),[],'no other write: the units travelled in the refused move');
   assert.equal(findItem((await get('/api/rack-items')).data,'ci-1').item.u,4,'Switch 01 never left floor 4');
   assert.deepEqual(await labelsOf('pdu1'),before.pdu1,'no PDU label changed');
   assert.equal(await dlg.getByLabel('Move the units on this floor with the server').isChecked(),true,'the choice is kept');
   assert.match(await dlg.locator('h2').innerText(),/^Swap OPT11 and OPT12$/,'the dialog stays open on the same swap');
   await p1.unroute('**/api/changes');
   await within('the dialog previews the latest',Date.now(),async()=>{const text=await dlg.locator('[data-move-preview]').innerText();return !text.includes('KVM 01 port 1')&&text.includes('KVM 01 port 4: OPT11 → OPT12');},8000);
   await dlg.locator('[data-action="confirm-move"]:not([disabled])').waitFor();
   done=applied(p1);
   await dlg.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);const t=Date.now();
   await dlg.waitFor({state:'detached'});await closeWindow(p1);
   assert.equal(findItem((await get('/api/rack-items')).data,'ci-1').item.u,1,'Switch 01 went to floor 1 with OPT11');
   assert.deepEqual(portsOf(await locations(),'OPT11'),{rack:'Rack-01',pdu:['pdu1:1'],kvm:[]},'OPT11 takes floor 1\'s outlet (its KVM port was cleared elsewhere)');
   fast('swap after a refused save (Racks)',await within('swap after a refused save (Racks)',t,async()=>await serverAt(racks2,'Rack-01',1,'OPT11')&&await unitAt(racks2,'Rack-01',1,'ci-1')&&await serverAt(racks2,'Rack-01',4,'OPT12')));
   passed.push('5b a KVM label changed elsewhere between the preview and Confirm: 409 and nothing written (Switch 01 never left floor 4, no label changed), the dialog stays open with its choice and previews the latest; the second Confirm swaps OPT11 and OPT12 with Switch 01');
  }

  // ── 6. a unit move and an owner change; the 3D twin tab is told about every change ──
  {
   const twin2=await open(s2,'/?tab=twin',{ready:'iframe[title="3D Digital Twin"]'});
   let frame;for(let i=0;i<100&&!(frame=twin2.frames().find(f=>f.url().includes('/twin/')));i++)await sleep(100);
   assert.ok(frame,'the twin iframe loaded');
   await frame.waitForLoadState('domcontentloaded');
   await frame.evaluate(()=>{window.__liveMsgs=[];addEventListener('message',e=>{if(e.origin===location.origin)window.__liveMsgs.push(e.data);});});
   const t=await put('/api/rack-items',doc=>{const f=findItem(doc,'ci-5');f.item.u=3;return doc;});
   fast('unit move (Racks)',await within('unit move (Racks)',t,()=>unitAt(racks2,'Rack-05',3,'ci-5')));
   // The twin page draws WebGL in the same thread as the App page around it (software rendering here), which delays
   // that page's timers: the forward gets its own limit (TWIN_MS); what the twin does with it is the twin's own check.
   const twinTook=await within('unit move (3D twin message)',t,()=>frame.evaluate(()=>window.__liveMsgs.some(m=>m?.type==='twin:data-changed'&&m.domains?.includes('inventory'))),TWIN_MS);
   assert.ok(twinTook<=TWIN_MS,`the twin iframe got the change after ${twinTook} ms (limit ${TWIN_MS} ms)`);
   const engineers=(await get('/api/engineers')).data;
   let person=engineers.find(e=>e.active);
   if(!person){const r=await s1.c.request.post(origin+'/api/engineers',{data:{name:'Live sync QA'},headers:H(s1)});assert.equal(r.status(),201);person=await r.json();
    cleanups.push(async()=>{await s1.c.request.put(origin+`/api/engineers/${person.id}`,{data:{name:person.name,active:false},headers:H(s1)});});}
   const r=await s1.c.request.put(origin+'/api/opt-owners/opt52',{data:{engineer_id:person.id},headers:H(s1)});
   assert.equal(r.status(),200,await r.text());const t2=Date.now();
   fast('owner change (Racks)',await within('owner change (Racks)',t2,async()=>(await card(racks2,'Rack-05').locator('.server-cell[data-server="OPT52"] [data-fact="owner"]').innerText())===person.name));
   await twin2.close();
   passed.push(`6 a unit move (Switch 05 to floor 3) and an owner change (OPT52 -> ${person.name}) show in context 2; the twin iframe gets {type: "twin:data-changed", domains}`);
  }

  // ── 7. an open unit window in context 2 keeps what is typed when a change arrives (Racks' unit click opens it) ──
  {
   const unit=card(racks2,'Rack-06').locator('.equipment-cell[data-item-id="ci-6"]');
   if(!(await unit.isVisible()))await unit.evaluate(e=>e.closest('.floor-more:not([data-open])')?.querySelector(':scope > .floor-more-toggle')?.click());
   await unit.click();
   const side=racks2.locator('[data-window="unit"]');await side.locator('#unit-form-notes').waitFor();
   const notesBefore=await side.locator('#unit-form-notes').inputValue();
   await side.locator('#unit-form-notes').fill('typed in context 2');
   const t=await put('/api/rack-items',doc=>{findItem(doc,'ci-6').item.serial_number='LIVE-SN-6';return doc;});
   fast('unit window keeps typed text',await within('unit window keeps typed text',t,async()=>/changed in another session/.test(await side.innerText())&&(await side.locator('#unit-form-serial_number').inputValue())==='LIVE-SN-6'));
   assert.equal(await side.locator('#unit-form-notes').inputValue(),'typed in context 2','the typed notes are kept');
   await side.locator('#unit-form-notes').fill(notesBefore);   // leave without changing anything
   await closeWindow(racks2);
   passed.push('7 context 2: the open unit window (opened from its Racks slot) shows the new serial saved in another session and keeps its typed notes, saying "changed in another session"');
  }

  // ── 8. the server window (one place for every server change): a swap and its Undo reach context 2 ──
  {
   const w1=await open(s1,'/?tab=dashboard&srv=opt31',{ready:'[data-window="server"] [data-section="place"]'});
   const win=w1.locator('[data-window="server"]');
   await win.getByRole('button',{name:'Swap with…'}).click();
   const dlg=moveDialog(w1);await dlg.waitFor();
   await dlg.getByRole('combobox').fill('OPT33');
   await dlg.getByRole('option').first().waitFor();
   await dlg.getByRole('combobox').press('Enter');
   const plan=await previewed(dlg);
   assert.ok(plan.includes('PDU 03 outlet 1: OPT31 → OPT33')&&plan.includes('PDU 03 outlet 3: OPT33 → OPT31'),plan);
   let done=applied(w1);
   await dlg.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);let t=Date.now();
   await dlg.waitFor({state:'detached'});
   fast('window swap (Racks)',await within('window swap (Racks)',t,async()=>await serverAt(racks2,'Rack-03',3,'OPT31')&&await serverAt(racks2,'Rack-03',1,'OPT33')));
   fast('window swap (Dashboard)',await within('window swap (Dashboard)',t,async()=>JSON.stringify(await outlets(dash2,'PDU 03'))===JSON.stringify(['OPT33','OPT32','OPT31','OPT34'])));
   const toast=w1.locator('.lab-toast',{hasText:'OPT31 and OPT33 swapped places.'});await toast.waitFor();
   done=applied(w1);
   await toast.getByRole('button',{name:'Undo'}).click();
   assert.equal((await done).status(),200);t=Date.now();
   fast('window Undo (Racks)',await within('window Undo (Racks)',t,async()=>await serverAt(racks2,'Rack-03',1,'OPT31')&&await serverAt(racks2,'Rack-03',3,'OPT33')));
   fast('window Undo (Dashboard)',await within('window Undo (Dashboard)',t,async()=>JSON.stringify(await outlets(dash2,'PDU 03'))===JSON.stringify(['OPT31','OPT32','OPT33','OPT34'])));
   const loc=await locations();
   for(const name of ['OPT31','OPT33'])assert.deepEqual(portsOf(loc,name),original.ports[name],`${name} back on its ports after Undo`);
   await sameDevices('window swap and Undo');
   await w1.close();
   passed.push(`8 the server window (Dashboard, no Edit mode): OPT31 › Swap with › "OPT33" previews PDU 03 outlets 1/3; Swap and the toast's Undo each show on context 2's Racks and Dashboard PDU 03 card within the limit; no PDU/KVM moved`);
  }

  for(const p of [racks2,dash2,health2,display2])assert.ok(await kept(p),'context 2 pages were never reloaded');
  await setEdit(p1,false);
  assert.equal(errors.length,0,errors.join('\n'));
 }finally{
  for(const c of cleanups.reverse())await c().catch(e=>{console.error('cleanup',e.message);process.exitCode=1;});
  // ── the fixture is as it was ──
  try{if(verify){await verify();passed.push('fixture restored (PDU labels, KVM ports, rack slots / positions / overrides, switch ports, rack items, owners; no PDU / KVM moved)');}}
  catch(e){console.error('fixture not restored:',e.message);process.exitCode=1;}
  console.log(JSON.stringify({passed,timings},null,1));
  // A page that drew the 3D twin can keep the browser from closing: give it 15 s, then leave anyway.
  await Promise.race([browser.close(),sleep(15000)]);
 }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>process.exit());
