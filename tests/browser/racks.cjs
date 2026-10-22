// DCIM Racks view on the isolated fixture (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1):
// RACK-1 stale equipment panel after a 409, RACK-2 U validation, RACK-3 equipment reload, RACK-4 phone width,
// RACK-5 non-server labels, LOC-3 Main storage shelves, CONN-4 auto-placed shelves. Every change it makes is undone.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin=process.env.DCIM_PREVIEW_URL||'http://127.0.0.1:8770';
const PASSWORD='test-password-123';
const ITEM='ci-b08-rack1', SPARE='ci-b08-spare';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const errors=[],passed=[];let cleanup=null;
 async function session(username,viewport={width:1440,height:1000}){
  const c=await browser.newContext({viewport});
  // What's new opens over the page in a fresh profile; it is not under test here.
  await c.addInitScript(()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const login=await c.request.post(origin+'/api/auth/login',{data:{username,password:PASSWORD}});
  assert.equal(login.status(),200,`${username} login`);
  return {c,csrf:(await login.json()).csrf_token};
 }
 try{
  const admin=await session('admin'),operator=await session('operator');
  assert.equal((await(await admin.c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
  // ── API helpers (the operator is "another session") ──
  const headers=(api,etag)=>({...(etag?{'If-Match':etag}:{}),'X-DCIM-CSRF':api.csrf});
  async function items(){const r=await operator.c.request.get(origin+'/api/rack-items');return{data:await r.json(),etag:r.headers()['etag']};}
  async function putItems(mutate){const {data,etag}=await items();mutate(data);const r=await operator.c.request.put(origin+'/api/rack-items',{data,headers:headers(operator,etag)});assert.equal(r.status(),200,await r.text());}
  async function scan(path,body){const g=await operator.c.request.get(origin+'/api/inventory');const r=await operator.c.request.post(origin+'/api/inventory'+path,{data:body,headers:headers(operator,g.headers()['etag'])});assert.equal(r.status(),200,await r.text());}
  async function putLayout(path,mutate){const g=await operator.c.request.get(origin+path);const data=await g.json();mutate(data);const r=await operator.c.request.put(origin+path,{data,headers:headers(operator,g.headers()['etag'])});assert.equal(r.status(),200,await r.text());}
  async function labels(pdu,map){const r=await operator.c.request.patch(origin+`/api/devices/${pdu}/labels`,{data:map,headers:headers(operator)});assert.equal(r.status(),200,await r.text());}
  const find=(data,id)=>{for(const [rack,list] of Object.entries(data))for(const item of list)if(item.id===id)return{rack,item};return null;};
  const moved=item=>(item.tracking_history||[]).filter(e=>e.action==='moved').length;

  // This suite's own equipment: removed first (a fresh record has no movement history), and again at the end.
  const dropOwn=d=>{for(const rack of Object.keys(d))d[rack]=d[rack].filter(i=>i.id!==ITEM&&i.id!==SPARE);};
  cleanup=()=>putItems(dropOwn);
  await putItems(dropOwn);
  await putItems(d=>{d['Rack-05']=[...(d['Rack-05']||[]),{id:ITEM,name:'B08 Switch',type:'switch',u:3,notes:'before'}];});

  const page=await admin.c.newPage();page.on('pageerror',e=>errors.push(e.message));
  const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());d.accept().catch(()=>{});});
  const puts=[];page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/api/rack-items'))puts.push(r.url());});
  const card=rack=>page.locator(`[data-rack-id="${rack}"]`);
  const cell=name=>page.locator(`.equipment-cell[aria-label="View ${name}"]`);
  await page.goto(origin+'/?tab=racks');
  await cell('B08 Switch').waitFor();
  await page.locator('button.edit-toggle').click();
  assert.equal(await page.locator('button.edit-toggle').getAttribute('aria-pressed'),'true');

  // ── RACK-1: the open panel saves only its own changes, and is refreshed after a 409 ──
  const panel=page.locator('div.fixed.inset-0.z-50.flex.justify-end');
  await cell('B08 Switch').locator('.equipment-type').click();
  await panel.getByText('Save changes').waitFor();
  const save=panel.getByRole('button',{name:/Save changes|Saved/});
  let before=puts.length;
  await save.click();await panel.getByText('No changes to save.').waitFor();await page.waitForTimeout(300);
  assert.equal(puts.length,before,'An unchanged panel must not save');
  await scan(`/${ITEM}/barcode`,{code:'B08-BC-1'});
  await scan(`/${ITEM}/location`,{rack:'Rack-05',u:4,position:'L'});
  const scanned=find((await items()).data,ITEM).item;assert.equal(moved(scanned),1);
  const historyBefore=scanned.tracking_history.length;
  await panel.locator('textarea').fill('after B08');
  let answer=page.waitForResponse(r=>r.url().endsWith('/api/rack-items')&&r.request().method()==='PUT');
  await save.click();
  assert.equal((await answer).status(),409,'The stale panel save is refused');
  await panel.getByText('Barcode:').waitFor();
  assert.match(await panel.innerText(),/Barcode: B08-BC-1/);
  assert.match(await panel.innerText(),/Rack-05 · U4/);
  assert.match(await panel.innerText(),/Position: L/);
  assert.equal(await panel.locator('textarea').inputValue(),'after B08','The edit made before the conflict is kept');
  assert.equal(await panel.locator('input[aria-label="U slot"]').inputValue(),'4');
  assert.ok(await panel.getByRole('status').filter({hasText:'changed in another session'}).isVisible());
  assert.ok(dialogs.some(m=>/changed in another session/.test(m)),dialogs.join(' | '));
  answer=page.waitForResponse(r=>r.url().endsWith('/api/rack-items')&&r.request().method()==='PUT');
  await save.click();
  assert.equal((await answer).status(),200);
  await panel.getByText('Saved').waitFor();
  let saved=find((await items()).data,ITEM);
  assert.equal(saved.rack,'Rack-05');assert.equal(saved.item.barcode,'B08-BC-1');assert.equal(saved.item.u,4);
  assert.equal(saved.item.shelf_position,'L');assert.equal(saved.item.notes,'after B08');
  assert.equal(saved.item.tracking_history.length,historyBefore,'The save adds no movement event');assert.equal(moved(saved.item),1);
  passed.push('RACK-1 409 refreshes the panel; the next save keeps barcode, U and position');

  // ── RACK-2: U must be a whole number from 0 to 42 ──
  const uInput=panel.locator('input[aria-label="U slot"]');
  before=puts.length;
  for(const bad of ['-1','43','1.5']){
   await uInput.fill(bad);
   await panel.getByRole('alert').filter({hasText:'U slot must be a whole number from 0 to 42.'}).waitFor();
   assert.equal(await uInput.getAttribute('aria-invalid'),'true');
   assert.equal(await save.isDisabled(),true);
   await uInput.press('Enter');
  }
  await page.waitForTimeout(400);assert.equal(puts.length,before,'An invalid U is never sent');
  await uInput.fill('4');assert.equal(await panel.getByRole('alert').count(),0);
  await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
  await card('Rack-05').locator('.rack-card-name').click();
  await page.getByRole('button',{name:'All racks'}).waitFor();
  await page.getByRole('button',{name:'Equipment',exact:true}).click();
  const modal=page.locator('div.fixed.inset-0.z-50').filter({hasText:'Add Equipment — Rack-05'});
  await modal.locator('input[placeholder="e.g. SW-Lab-01"]').fill('B08 bad U');
  await modal.locator('input[aria-label="U slot"]').fill('-1');
  await modal.getByRole('alert').filter({hasText:'U slot must be a whole number from 0 to 42.'}).waitFor();
  assert.equal(await modal.getByRole('button',{name:'Add',exact:true}).isDisabled(),true);
  await modal.locator('input[placeholder="e.g. SW-Lab-01"]').press('Enter');
  await modal.locator('input[aria-label="U slot"]').fill('99');await modal.locator('input[aria-label="U slot"]').press('Enter');
  await page.waitForTimeout(400);assert.equal(puts.length,before,'Add with an invalid U sends nothing');
  await modal.locator('input[aria-label="U slot"]').fill('42');
  assert.equal(await modal.getByRole('button',{name:'Add',exact:true}).isDisabled(),false);
  await page.keyboard.press('Escape');await modal.waitFor({state:'detached'});
  await page.getByRole('button',{name:'All racks'}).click();
  passed.push('RACK-2 U -1 / 43 / 1.5 / 99 shows an error and sends nothing');

  // ── RACK-3: equipment moved elsewhere shows up without a page reload ──
  const shelf=(rack,u,name)=>card(rack).locator(`[data-u-slot="${u}"] .equipment-cell[aria-label="View ${name}"]`);
  await scan(`/${ITEM}/location`,{rack:'Rack-05',u:6,position:''});
  const t0=Date.now();await shelf('Rack-05',6,'B08 Switch').waitFor({timeout:20000});
  const pollMs=Date.now()-t0;
  const nav=label=>page.locator('nav[aria-label="Main navigation"] button',{hasText:new RegExp(`^${label}$`)}).click();
  await nav('Power');await page.getByText('Amperage per PDU').waitFor();
  await scan(`/${ITEM}/location`,{rack:'Rack-05',u:7,position:''});
  await nav('Racks');
  await shelf('Rack-05',7,'B08 Switch').waitFor({timeout:4000});
  passed.push(`RACK-3 scan move shown after ${Math.round(pollMs/1000)} s and right after Power -> Racks`);

  // ── RACK-1: the open item was deleted in another session: the 409 closes its panel and reloads resume ──
  if(await page.locator('button.edit-toggle').getAttribute('aria-pressed')!=='true')await page.locator('button.edit-toggle').click();
  await cell('B08 Switch').locator('.equipment-type').click();
  await panel.getByText('Save changes').waitFor();
  await putItems(dropOwn);
  await panel.locator('textarea').fill('deleted meanwhile');
  answer=page.waitForResponse(r=>r.url().endsWith('/api/rack-items')&&r.request().method()==='PUT');
  await save.click();
  assert.equal((await answer).status(),409);
  await panel.waitFor({state:'detached',timeout:4000});
  await putItems(d=>{d['Rack-05']=[...(d['Rack-05']||[]),{id:ITEM,name:'B08 Switch',type:'switch',u:3,notes:'back'}];});
  await shelf('Rack-05',3,'B08 Switch').waitFor({timeout:20000});
  passed.push('RACK-1 item deleted elsewhere: the 409 closes its panel and equipment reloads resume');

  // ── RACK-5: an outlet renamed to "empty" is not an OPT anywhere ──
  const kpi=async()=>{const t=await page.locator('.rack-kpi',{has:page.locator('span',{hasText:/^Servers on$/})}).locator('strong').innerText();const [on,all]=t.split('/').map(Number);return{on,all};};
  const meta=rack=>card(rack).locator('.rack-meta span').first().innerText();
  assert.equal(await meta('Rack-06'),'4 OPTs');
  const k0=await kpi();
  await labels('pdu6',{'1':'OPT61','2':'OPT62','3':'OPT63','4':'empty'});
  try{
   await page.reload();await card('Rack-06').waitFor();
   await page.waitForFunction(()=>document.querySelector('[data-rack-id="Rack-06"] .rack-meta span')?.textContent==='3 OPTs');
   await page.waitForFunction(k=>{const el=[...document.querySelectorAll('.rack-kpi')].find(e=>e.querySelector('span')?.textContent==='Servers on');return el&&el.querySelector('strong').textContent===`${k.on-1}/${k.all-1}`;},k0);
   assert.equal(await card('Rack-06').locator('.server-cell[data-server="empty"]').count(),0);
   await card('Rack-06').locator('.rack-card-name').click();
   // the rack detail's figures line says the same
   await page.locator('#rack-detail-title').waitFor();
   assert.equal(await page.locator('.rack-detail .rack-meta span').first().innerText(),'3 OPTs');
   await page.getByRole('button',{name:'All racks'}).click();
  }finally{await labels('pdu6',{'1':'OPT61','2':'OPT62','3':'OPT63','4':'OPT64'});}
  passed.push('RACK-5 "empty" label: 3 OPTs on the card and in the detail, KPI down by 1/1');

  // ── LOC-3 + CONN-4: Main storage shelves, auto-placed shelves ──
  // Earlier suites on a reused fixture may have pinned or moved OPTs: remember what is there and put it back after.
  const layout=async path=>(await operator.c.request.get(origin+path)).json();
  const kept={overrides:await layout('/api/rack-overrides'),slots:await layout('/api/rack-slots'),order:await layout('/api/rack-positions')};
  const RACK01=['opt11','opt12','opt13','opt14'];
  const restore=(d,key,value)=>{if(value===undefined)delete d[key];else d[key]=value;};
  // Rack-01 gets the shared auto-U vector (C7): only OPT13 saved at U7, no shelf order, no OPT moved away.
  await putLayout('/api/rack-overrides',d=>{d.opt63='Storage-Main';d.opt72='Storage-Main';RACK01.forEach(id=>delete d[id]);});
  await putLayout('/api/rack-slots',d=>{d['Storage-Main']={...(d['Storage-Main']||{}),opt72:3};delete d['Storage-Main'].opt63;d['Rack-01']={opt13:7};});
  await putLayout('/api/rack-positions',d=>{delete d['Rack-01'];});
  await putItems(d=>{d['Storage-Main']=[...(d['Storage-Main']||[]).filter(i=>i.id!==SPARE),{id:SPARE,name:'Spare',type:'other',u:0}];});
  try{
   await page.reload();
   const storage=card('Storage-Main');
   await storage.locator('.server-cell[data-server="OPT72"]').waitFor();
   assert.deepEqual(await storage.locator('[data-u-slot]').evaluateAll(els=>els.map(e=>e.dataset.uSlot)),['1','3','0']);
   assert.equal(await storage.locator('.shelf-empty').count(),0);
   assert.equal(await storage.locator('[data-u-slot="3"] .server-cell[data-server="OPT72"]').count(),1);
   assert.equal(await storage.locator('[data-u-slot="1"] .server-cell[data-server="OPT63"]').count(),1);
   assert.equal(await storage.locator('[data-u-slot="0"] .equipment-cell[aria-label="View Spare"]').count(),1);
   passed.push('LOC-3 Main storage draws OPT63 (U1), OPT72 (U3) and Spare, no empty shelves');
   assert.equal(await storage.locator('.shelf-row[data-auto]').count(),1);
   assert.equal(await storage.locator('[data-u-slot="1"][data-auto]').count(),1);
   const autoIndex=storage.locator('[data-u-slot="1"] .shelf-index');
   assert.match(await autoIndex.getAttribute('title'),/^Auto-placed — no saved U/);
   // Auto-placed shelf numbers are italic at full contrast (no opacity on text, RACKS-UI-SPEC §14).
   assert.deepEqual(await autoIndex.evaluate(e=>{const s=getComputedStyle(e);return[s.opacity,s.fontStyle];}),['1','italic']);
   assert.deepEqual(await storage.locator('[data-u-slot="3"] .shelf-index').evaluate(e=>{const s=getComputedStyle(e);return[s.opacity,s.fontStyle,e.title];}),['1','normal','Shelf 3']);
   // Rack-01 (C7 vector): OPT11, OPT12 and OPT14 are auto-placed on U1-U3 and marked; OPT13 is saved at U7 and is not.
   const rack01=card('Rack-01');
   const shelves01=await rack01.locator('.shelf-row').evaluateAll(els=>els.map(e=>[e.dataset.uSlot,e.hasAttribute('data-auto'),
     [...e.querySelectorAll('.server-cell')].map(c=>c.dataset.server)]).filter(r=>r[2].length));
   assert.deepEqual(shelves01,[['1',true,['OPT11']],['2',true,['OPT12']],['3',true,['OPT14']],['7',false,['OPT13']]]);
   // the rack detail table says the same (by U: servers before equipment, rack level last)
   await rack01.locator('.rack-card-name').click();await page.getByRole('button',{name:'All racks'}).waitFor();
   const uCells=await page.locator('tbody tr').evaluateAll(rows=>rows.filter(r=>r.cells[2]?.textContent==='OPT').map(r=>[r.cells[1].textContent.trim(),r.cells[0].textContent.trim()]));
   assert.deepEqual(uCells,[['OPT11','U1 (auto)'],['OPT12','U2 (auto)'],['OPT14','U3 (auto)'],['OPT13','U7']]);
   await page.getByRole('button',{name:'All racks'}).click();
   passed.push('CONN-4 auto-placed shelves marked (Main storage 1 of 2, Rack-01 U1-U3 of the C7 vector, not the saved U7)');
  }finally{
   await putLayout('/api/rack-overrides',d=>{['opt63','opt72',...RACK01].forEach(id=>restore(d,id,kept.overrides[id]));});
   await putLayout('/api/rack-positions',d=>{restore(d,'Rack-01',kept.order['Rack-01']);});
   await putLayout('/api/rack-slots',d=>{restore(d,'Storage-Main',kept.slots['Storage-Main']);restore(d,'Rack-01',kept.slots['Rack-01']);});
   await putItems(d=>{d['Storage-Main']=(d['Storage-Main']||[]).filter(i=>i.id!==SPARE);});
  }

  // ── RACK-4: the rack detail fits a 375 px phone, with Edit off and on ──
  const phone=await admin.c.newPage();phone.on('pageerror',e=>errors.push(e.message));
  await phone.setViewportSize({width:375,height:812});
  await phone.goto(origin+'/?tab=racks&rack=Rack-05');
  await phone.getByRole('button',{name:'All racks'}).waitFor();await phone.waitForTimeout(300);
  const width=()=>phone.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth));
  assert.equal(await width(),375,'Edit off');
  await phone.locator('button.edit-toggle').click();
  await phone.getByRole('button',{name:'Equipment',exact:true}).waitFor();await phone.waitForTimeout(300);
  assert.equal(await width(),375,'Edit on');
  const inside=async locator=>{const b=await locator.boundingBox();assert.ok(b,'visible');assert.ok(b.x>=0&&b.x+b.width<=375,`${b.x}+${b.width} within 375`);};
  await phone.locator('.equipment-cell[aria-label="View B08 Switch"] .equipment-type').click();
  const phonePanel=phone.locator('div.fixed.inset-0.z-50.flex.justify-end');
  await phonePanel.getByText('Save changes').waitFor();
  await inside(phonePanel.getByRole('button',{name:'Close'}));
  await inside(phonePanel.getByRole('button',{name:'Move',exact:true}));
  assert.equal(await width(),375,'Equipment panel open');
  await phone.keyboard.press('Escape');await phonePanel.waitFor({state:'detached'});
  await phone.locator('[data-rack-id="Rack-05"] button.server-open[aria-label="View OPT51"]').click();
  await phonePanel.getByText('Remove from DCIM').waitFor();
  await inside(phonePanel.getByRole('button',{name:'Close'}));
  await phone.keyboard.press('Escape');
  passed.push('RACK-4 rack detail at 375 px: no page scroll with Edit off and on; Close and Move inside the screen');

  await cleanup();cleanup=null;
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed,dialogs,errors}));
 }finally{if(cleanup)await cleanup().catch(()=>{});await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
