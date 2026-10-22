// Racks page v4 (RACKS-UI-SPEC §16.4) on the isolated fixture (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1,
// optionally POWER_PROTECTED_OUTLETS=pdu1:4): layout and overflow, row states, search and filters, ON/OFF outside
// Edit mode with the in-app confirmation, cooling units (place, move, take off a shelf, undo), keyboard and focus,
// text size and contrast, right-to-left names and the assistant launcher. Every change it makes is undone.
// Only fixture data is touched; no live site or hardware. RACKS_UI_ONLY=1,4 runs some sections only.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const origin=process.env.DCIM_PREVIEW_URL||'http://127.0.0.1:8951';
const SHOTS=process.env.DCIM_QA_SCREENSHOT_DIR||path.join(os.tmpdir(),'racks-v4');
const ONLY=(process.env.RACKS_UI_ONLY||'').split(',').filter(Boolean);
const run=n=>!ONLY.length||ONLY.includes(String(n));
const PASSWORD='test-password-123';
const EXTRA=[
 {id:'ch4b',name:'Chiller-2',rack:'Rack-04',u:3},          // two units on one shelf
 {id:'ch4c',name:'Chiller-3',rack:'Rack-04',u:null},       // in the rack, not on a shelf (the owner's case)
 {id:'ch-free',name:'צ׳ילר נייד',rack:null,u:null},        // unassigned, Hebrew name
 {id:'ch-lost',name:'Chiller-9',rack:'Rack-99',u:2},       // rack not found
];
fs.mkdirSync(SHOTS,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const errors=[],passed=[],cleanups=[];
 let nativeDialogs=0;
 async function session(username){
  const c=await browser.newContext({viewport:{width:1440,height:900}});
  await c.addInitScript(()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const login=await c.request.post(origin+'/api/auth/login',{data:{username,password:PASSWORD}});
  assert.equal(login.status(),200,`${username} login`);
  return {c,csrf:(await login.json()).csrf_token,username};
 }
 async function open(s,{width=1440,height=900,url='/?tab=racks',wait=true,fresh=true}={}){
  const p=await s.c.newPage();
  await p.setViewportSize({width,height});
  p.on('pageerror',e=>errors.push(`${s.username}: ${e.message}`));
  p.on('dialog',d=>{nativeDialogs++;d.dismiss().catch(()=>{});});
  await p.goto(origin+url);
  // Each check starts like a new viewer: no remembered cards, panel, empty shelves or detail view.
  if(fresh&&await p.evaluate(()=>{const keys=Object.keys(localStorage).filter(k=>k.startsWith('dcim.racks.'));keys.forEach(k=>localStorage.removeItem(k));return keys.length;}))await p.reload();
  if(wait){await p.locator('[data-rack-id]').first().waitFor({timeout:20000});await settled(p);}
  return p;
 }
 // Every PDU has reported (no row is still "Reading…").
 const settled=p=>p.waitForFunction(()=>document.querySelector('[data-rack-id], #rack-detail-title')&&!document.querySelector('[data-state="loading"]')&&!document.querySelector('.rack-kpis[aria-busy]'),null,{timeout:20000});
 const shot=(p,name)=>p.screenshot({path:path.join(SHOTS,`${name}.png`)});
 const width=p=>p.evaluate(()=>({scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),inner:innerWidth}));
 async function noOverflow(p,label){
  const w=await width(p);if(w.scroll<=w.inner)return;
  const wide=await p.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>innerWidth+0.5&&!e.closest('.app-tabs,.app-subnav,.racks-jump');}).slice(0,5).map(e=>`${e.tagName}.${String(e.className).slice(0,40)}@${Math.round(e.getBoundingClientRect().right)}`));
  assert.fail(`${label}: page is ${w.scroll}px wide in a ${w.inner}px window (${wide.join(', ')})`);
 }
 const editToggle=p=>p.locator('button.edit-toggle');
 async function setEdit(p,on){if((await editToggle(p).getAttribute('aria-pressed')==='true')!==on)await editToggle(p).click();await p.waitForFunction(v=>document.querySelector('button.edit-toggle')?.getAttribute('aria-pressed')===String(v),on);}
 const card=(p,rack)=>p.locator(`[data-rack-id="${rack}"]`);
 const visibleRacks=p=>p.locator('.racks-grid > [data-rack-id]').evaluateAll(els=>els.map(e=>e.dataset.rackId));
 async function openPanel(p){if(!(await p.locator('#cooling-panel').isVisible()))await p.locator('.racks-cooling-toggle').first().click();await p.locator('#cooling-panel').waitFor();}

 try{
  const admin=await session('admin'),operator=await session('operator'),viewer=await session('viewer');
  assert.equal((await(await admin.c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA','fixture marker');
  const H=(s,etag)=>({...(etag?{'If-Match':etag}:{}),'X-DCIM-CSRF':s.csrf});
  async function chillers(){const r=await admin.c.request.get(origin+'/api/chillers');return{data:await r.json(),etag:r.headers()['etag']};}
  async function putChillers(mutate){const {data,etag}=await chillers();const next=mutate(structuredClone(data));const r=await admin.c.request.put(origin+'/api/chillers',{data:next,headers:H(admin,etag)});return r;}
  const unitOf=async id=>(await chillers()).data.units.find(u=>u.id===id);
  // The saved place of a unit (the page shows a move before its save finishes, so this waits for the server).
  async function expectUnit(id,want,msg){let got;for(let i=0;i<40;i++){const u=await unitOf(id);got={rack:u?.rack??null,u:u?.u??null};if(got.rack===want.rack&&got.u===want.u)return;await sleep(150);}assert.deepEqual(got,want,msg);}
  async function labels(pdu){const r=await admin.c.request.get(origin+'/api/devices/');return (await r.json()).find(d=>d.id===pdu).labels||{};}
  async function setLabels(pdu,map){const r=await admin.c.request.patch(origin+`/api/devices/${pdu}/labels`,{data:map,headers:H(admin)});assert.equal(r.status(),200,await r.text());}
  async function power(pdu,n,action){const r=await admin.c.request.post(origin+`/api/pdus/${pdu}/outlets/${n}/power`,{data:{action},headers:H(admin)});return r.status();}

  // ── setup: the extra cooling units of RACKS-UI-SPEC §16.3 (kept, never deleted; reset to these places) ──
  const original=(await chillers()).data;
  const resetUnits=d=>{d.units=(d.units||[]).filter(u=>!EXTRA.some(x=>x.id===u.id));for(const x of EXTRA)d.units.push({...x});
   for(const u of d.units){const o=(original.units||[]).find(x=>x.id===u.id);if(o&&!EXTRA.some(x=>x.id===u.id)){u.rack=o.rack;u.u=o.u;u.name=o.name;}}return d;};
  assert.equal((await putChillers(resetUnits)).status(),200,'cooling setup');
  cleanups.push(async()=>{
   // Units are never deleted: put the original document back if the server allows it, else keep the extra units in place.
   const r=await putChillers(()=>structuredClone(original));
   if(r.status()!==200)await putChillers(resetUnits);
  });
  const unitCount=async()=>(await chillers()).data.units.length;
  const UNITS=await unitCount();

  // ── 1. layout and overflow ──
  if(run(1)){
   const p=await open(operator);
   assert.equal(await p.locator('[data-rack-id]').count(),9,'9 racks');
   for(const t of await p.locator('[data-rack-id]').evaluateAll(els=>els.map(e=>e.querySelector('.rack-meta span')?.textContent)))assert.match(t,/^\d+ OPTs$/);
   const gap=card(p,'Rack-01').locator('.shelf-gap[data-from="5"][data-to="8"]');
   assert.equal(await gap.count(),1,'Rack-01 folds shelves 05-08');
   assert.equal(await gap.innerText(),'05–08 · empty');
   await p.getByRole('button',{name:'Empty shelves'}).click();
   assert.equal(await card(p,'Rack-01').locator('.shelf-empty').count(),4,'Empty shelves shows 05-08');
   await p.getByRole('button',{name:'Empty shelves'}).click();
   assert.equal(await card(p,'Rack-01').locator('.shelf-empty').count(),0);
   await noOverflow(p,'overview 1440');
   await shot(p,'op-grid-1440');
   await p.evaluate(()=>window.scrollTo(0,2000));await sleep(200);
   const box=await p.locator('.racks-toolbar').boundingBox();
   assert.ok(box&&box.y<=0.5,`toolbar stays at the top (${box&&box.y})`);
   await p.close();
   for(const [w,h] of [[390,844],[375,812]]){
    const m=await open(operator,{width:w,height:h});
    await noOverflow(m,`overview ${w}`);
    assert.equal(await m.locator('[data-rack-id][data-collapsed]').count(),9,'phones start with collapsed cards');
    assert.match(await card(m,'Rack-07').locator('.rack-attention').innerText(),/No reading from PDU 07/);
    if(w===375)await shot(m,'op-grid-375');
    await m.getByRole('button',{name:'Expand all'}).click();
    await noOverflow(m,`overview expanded ${w}`);
    if(w===375){await card(m,'Rack-01').scrollIntoViewIfNeeded();await shot(m,'op-grid-375-expanded');}
    await setEdit(m,true);await noOverflow(m,`overview Edit ${w}`);
    await openPanel(m);
    await noOverflow(m,`cooling panel ${w}`);
    await m.locator('#cooling-panel li[data-unit-id="ch4c"] button').click();
    await m.locator('[role="dialog"][data-dialog="cooling"]').waitFor();await noOverflow(m,`cooling dialog ${w}`);
    await m.keyboard.press('Escape');await setEdit(m,false);
    await m.goto(origin+'/?tab=racks&rack=Rack-04');await m.locator('#rack-detail-title').waitFor();await settled(m);
    assert.equal(await m.locator('.racks-segment button[aria-pressed="true"]').innerText(),'List','phones open the detail on the List');
    await noOverflow(m,`detail list ${w}`);
    if(w===390)await shot(m,'detail-rack04-phone-list');
    await m.getByRole('button',{name:'Diagram',exact:true}).click();await card(m,'Rack-04').waitFor();
    await noOverflow(m,`detail diagram ${w}`);
    if(w===390)await shot(m,'detail-rack04-phone-diagram');
    await m.getByRole('button',{name:'List',exact:true}).click();
    await m.locator('.detail-item[data-server="OPT41"] [role="switch"]').click();
    await m.locator('[role="alertdialog"]').waitFor();await noOverflow(m,`power dialog ${w}`);
    await m.getByRole('button',{name:'Cancel'}).click();
    await m.close();
   }
   passed.push('1 layout: 9 racks, "N OPTs" first, 05-08 folded, Empty shelves, sticky toolbar, no page scroll at 1440/390/375 (grid, Edit, panel, dialogs, detail)');
  }

  // ── 2. states ──
  if(run(2)){
   const p=await open(operator);
   const r7=card(p,'Rack-07');
   assert.equal(await r7.getAttribute('data-status'),'offline');
   const states=await r7.locator('.server-cell').evaluateAll(els=>els.map(e=>[e.dataset.state,e.querySelector('.server-state').textContent]));
   assert.ok(states.length===4&&states.every(([s,w])=>s==='unreachable'&&w==='No reading'),JSON.stringify(states));
   for(const t of await r7.locator('.power-toggle').evaluateAll(els=>els.map(e=>[e.getAttribute('aria-disabled'),e.title])))
    {assert.equal(t[0],'true');assert.match(t[1],/unreachable/);}
   await r7.scrollIntoViewIfNeeded();await r7.screenshot({path:path.join(SHOTS,'rack07-offline.png')});
   // maintenance: pdu2 shut down through the API (fixture password), restored in finally
   const shut=await admin.c.request.post(origin+'/api/pdus/pdu2/maintenance/shutdown',{data:{password:PASSWORD,reason:'racks-ui QA'},headers:H(admin)});
   assert.equal(shut.status(),200,await shut.text());
   try{
    await p.reload();await settled(p);
    const r2=card(p,'Rack-02');
    await p.waitForFunction(()=>document.querySelector('[data-rack-id="Rack-02"]')?.hasAttribute('data-maintenance'));
    assert.ok(await r2.locator('.server-cell[data-maintenance] .maint-badge').count()>=4,'rows show Maintenance');
    const on=r2.getByRole('switch',{name:'Power OPT21'});
    await p.waitForFunction(()=>document.querySelector('[data-server="OPT21"]')?.dataset.state==='off');
    assert.equal(await on.getAttribute('aria-disabled'),'true','On is blocked');
    assert.equal(await on.getAttribute('data-blocked'),'maintenance');
    await r2.scrollIntoViewIfNeeded();await r2.screenshot({path:path.join(SHOTS,'rack02-maintenance.png')});
   }finally{
    const back=await admin.c.request.post(origin+'/api/pdus/pdu2/maintenance/restore',{data:{password:PASSWORD},headers:H(admin)});
    assert.equal(back.status(),200,await back.text());
   }
   await p.close();
   // loading: PDU readings held back 3 s; the summary never says 0/28
   const l=await operator.c.newPage();l.on('pageerror',e=>errors.push(e.message));
   await l.route('**/api/pdus/*/status',async r=>{await sleep(3000);await r.continue().catch(()=>{});});
   await l.goto(origin+'/?tab=racks');
   await l.locator('.server-cell[data-state="loading"]').first().waitFor();
   assert.match(await l.locator('.rack-kpis').innerText(),/Reading PDUs…/);
   assert.equal(await l.locator('.rack-kpis').getAttribute('aria-busy'),'true');
   await shot(l,'loading');
   const seen=new Set();
   for(let i=0;i<20&&await l.locator('.server-cell[data-state="loading"]').count();i++){seen.add(await l.locator('.rack-kpi[data-kpi="servers"] strong').innerText());await sleep(150);}
   assert.ok(![...seen].some(t=>/^0\/\d+$/.test(t)),`never 0/N while loading (${[...seen].join(', ')})`);
   await l.close();
   // a failed layout load: a banner per store with Retry; nothing can be added on top of a failed cooling load
   const e=await operator.c.newPage();e.on('pageerror',x=>errors.push(x.message));
   const fail=r=>r.fulfill({status:500,contentType:'application/json',body:'{"detail":"fixture failure"}'});
   await e.route(/\/api\/chillers$/,fail);await e.route(/\/api\/rack-items$/,fail);
   await e.goto(origin+'/?tab=racks');
   await e.locator('.racks-banner[data-store="items"]').waitFor();await e.locator('.racks-banner[data-store="cooling"]').waitFor();
   assert.equal(await e.locator('.racks-banner[role="alert"]').count(),2);
   assert.match(await e.locator('.racks-banner[data-store="items"]').innerText(),/Equipment could not load \(HTTP 500\)/);
   await setEdit(e,true);
   await openPanel(e);
   assert.match(await e.locator('#cooling-panel').innerText(),/Cooling units could not load/);
   assert.equal(await e.getByRole('button',{name:/Add cooling unit/}).count(),0,'no Add on a failed load');
   await shot(e,'load-error-banners');
   await e.unroute(/\/api\/chillers$/);await e.unroute(/\/api\/rack-items$/);
   await e.locator('.racks-banner[data-store="cooling"]').getByRole('button',{name:'Retry'}).click();
   await e.waitForFunction(()=>!document.querySelector('.racks-banner'));
   await setEdit(e,false);await e.close();
   passed.push('2 states: Rack-07 offline (No reading, switch blocked "unreachable"), Rack-02 maintenance (badge, On blocked), loading (Reading PDUs…, never 0/N), load errors (2 banners, Retry clears, no Add)');
  }

  // ── 3. search and filter ──
  if(run(3)){
   const p=await open(operator);
   const search=p.getByRole('searchbox',{name:/Find server/});
   await search.fill('OPT43');
   await p.waitForFunction(()=>document.querySelectorAll('.racks-grid > [data-rack-id]').length===1);
   assert.deepEqual(await visibleRacks(p),['Rack-04']);
   assert.equal(await p.locator('.server-cell[data-server="OPT43"][data-match]').count(),1);
   assert.equal(await p.locator('.racks-count').innerText(),'1 match in 1 rack');
   await shot(p,'search-opt43');
   await search.press('Enter');
   await p.waitForFunction(()=>document.activeElement?.matches('button.server-open[aria-label="View OPT43"]'));
   await search.focus();await search.press('Escape');
   await p.waitForFunction(()=>document.querySelectorAll('.racks-grid > [data-rack-id]').length===9);
   await search.fill('Switch 04');
   await p.locator('.equipment-cell[aria-label="View Switch 04"][data-match]').waitFor();
   await search.fill('צ׳ילר');
   await p.locator('#cooling-panel li[data-unit-id="ch-free"][data-match]').waitFor();
   await search.fill('');
   await p.locator('.racks-filter').getByRole('button',{name:/^No reading/}).click();
   await p.waitForFunction(()=>document.querySelectorAll('.racks-grid > [data-rack-id]').length===1);
   assert.deepEqual(await visibleRacks(p),['Rack-07']);
   await shot(p,'filter-noreading');
   await p.locator('.racks-filter').getByRole('button',{name:/^All/}).click();
   await setEdit(p,true);
   for(const v of await p.locator('.racks-filter button').evaluateAll(els=>els.map(e=>e.getAttribute('aria-disabled'))))assert.equal(v,'true');
   await setEdit(p,false);await p.close();
   passed.push('3 search/filter: OPT43 (1 rack, match, Enter focuses it, Escape), Switch 04, Hebrew cooling name in the panel, No reading -> Rack-07, filters off in Edit');
  }

  // ── 4. power with Edit off ──
  if(run(4)){
   const v=await open(viewer);
   assert.equal(await v.locator('.power-toggle').count(),0,'Viewer: no power control');
   await shot(v,'viewer-grid-1440');
   await v.setViewportSize({width:375,height:812});await v.getByRole('button',{name:'Expand all'}).click();await card(v,'Rack-01').scrollIntoViewIfNeeded();
   assert.equal(await v.locator('.power-toggle').count(),0);await shot(v,'viewer-grid-375');await v.close();
   const p=await open(operator);
   const posts=[];p.on('request',r=>{if(r.method()==='POST'&&/\/api\/pdus\/[^/]+\/outlets\/\d+\/power$/.test(r.url()))posts.push({url:r.url().slice(origin.length),body:r.postData()});});
   const sw=name=>p.getByRole('switch',{name:`Power ${name}`});
   const dialog=p.locator('[role="alertdialog"]');
   assert.equal(await sw('OPT12').getAttribute('aria-checked'),'true');
   await sw('OPT12').click();await dialog.waitFor();
   assert.equal(await dialog.locator('h2').innerText(),'Power off OPT12?');
   assert.match(await dialog.innerText(),/PDU 01 · outlet 2/);
   assert.equal(await p.evaluate(()=>document.activeElement?.textContent),'Cancel','Cancel has focus');
   await shot(p,'power-confirm-off');
   await dialog.getByRole('button',{name:'Cancel'}).click();await dialog.waitFor({state:'detached'});
   await sleep(300);assert.equal(posts.length,0,'Cancel sends nothing');
   assert.equal(await p.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Power OPT12','focus back on the switch');
   try{
    await sw('OPT12').click();await dialog.waitFor();
    await dialog.getByRole('button',{name:'Power off',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.deepEqual(posts,[{url:'/api/pdus/pdu1/outlets/2/power',body:'{"action":"off"}'}]);
    await p.waitForFunction(()=>document.querySelector('.server-cell[data-server="OPT12"]')?.dataset.state==='off');
    assert.equal(await p.locator('.server-cell[data-server="OPT12"] .server-state').innerText(),'OFF');
    assert.match(await p.locator('.toast').innerText(),/OPT12 is off \(PDU 01 · outlet 2\)/);
    await sw('OPT12').click();await dialog.waitFor();
    assert.equal(await dialog.locator('h2').innerText(),'Power on OPT12?','On asks too (confirm_power defaults to true)');
    await dialog.getByRole('button',{name:'Power on',exact:true}).dblclick();await dialog.waitFor({state:'detached'});
    await sleep(400);assert.equal(posts.length,2,'a double click switches once');
    await p.waitForFunction(()=>document.querySelector('.server-cell[data-server="OPT12"]')?.dataset.state==='on');
   }finally{await power('pdu1',2,'on');}
   // OPT14 is protected on the fixture (POWER_PROTECTED_OUTLETS=pdu1:4): blocked up front, or the 409 shows in the dialog
   const protectedFixture=(await(await admin.c.request.get(origin+'/api/pdus/maintenance')).json());
   if(protectedFixture.protection){
    assert.equal(await sw('OPT14').getAttribute('aria-disabled'),'true');assert.match(await sw('OPT14').getAttribute('title'),/protected/);
   }else{
    posts.length=0;
    await sw('OPT14').click();await dialog.waitFor();
    await dialog.getByRole('button',{name:'Power off',exact:true}).click();
    await dialog.getByText('Some outlets were not switched').waitFor();
    const text=await dialog.innerText();
    if(/protected/.test(text)){
     assert.equal(await p.evaluate(()=>document.activeElement?.textContent),'Some outlets were not switched');
     await shot(p,'power-result-error');
     await dialog.getByRole('button',{name:'Close'}).click();
     assert.equal(await p.locator('.server-cell[data-server="OPT14"]').getAttribute('data-state'),'on','the state does not change');
    }else{await dialog.getByRole('button',{name:'Close'}).click();await power('pdu1',4,'on');console.warn('fixture started without POWER_PROTECTED_OUTLETS=pdu1:4');}
   }
   // a server on two PDUs (PSU1/PSU2): one group, whole server by default, "Only this feed" switches one outlet
   const l1=await labels('pdu1'),l2=await labels('pdu2');
   try{
    await setLabels('pdu1',{...l1,'3':'OPT99 (PSU1)'});await setLabels('pdu2',{...l2,'3':'OPT99 (PSU2)'});
    await p.reload();await settled(p);
    posts.length=0;
    await sw('OPT99 (PSU1)').click();await dialog.waitFor();
    assert.equal((await dialog.locator('.power-feeds .power-feed').count()),2,'two feeds listed');
    assert.equal(await dialog.getByRole('radio',{name:/Whole server \(2 feeds\)/}).isChecked(),true);
    await shot(p,'power-two-feeds');
    await dialog.getByRole('button',{name:'Power off',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.equal(posts.length,2,'whole server: 2 outlets');
    await p.waitForFunction(()=>['OPT99 (PSU1)','OPT99 (PSU2)'].every(n=>document.querySelector(`.server-cell[data-server="${n}"]`)?.dataset.state==='off'));
    posts.length=0;
    await sw('OPT99 (PSU1)').click();await dialog.waitFor();
    await dialog.getByRole('radio',{name:/Only this feed/}).check();
    assert.match(await dialog.innerText(),/stays powered by PDU 02 outlet 3/);
    await dialog.getByRole('button',{name:'Power on',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.deepEqual(posts.map(x=>x.url),['/api/pdus/pdu1/outlets/3/power'],'only this feed');
    await p.locator('.server-cell[data-server="OPT99 (PSU1)"] .power-toggle[data-power-state="partial"]').waitFor();
   }finally{
    await setLabels('pdu1',l1);await setLabels('pdu2',l2);await power('pdu1',3,'on');await power('pdu2',3,'on');
   }
   await p.reload();await settled(p);
   // Edit mode: no row switch; the edit panel asks in-app; an offline PDU blocks every button
   posts.length=0;
   await setEdit(p,true);
   assert.equal(await p.locator('.server-cell .power-toggle').count(),0,'no row switch in Edit mode');
   await p.locator('button.server-open[aria-label="View OPT12"]').click();
   const panel=p.locator('div.fixed.inset-0.z-50.flex.justify-end');
   await panel.getByRole('button',{name:'Power off'}).click();
   await dialog.waitFor();assert.equal(await dialog.locator('h2').innerText(),'Power off OPT12?');
   await dialog.getByRole('button',{name:'Cancel'}).click();await dialog.waitFor({state:'detached'});
   assert.ok(await panel.isVisible(),'Escape/Cancel of the confirmation leaves the panel open');
   await p.keyboard.press('Escape');await panel.waitFor({state:'detached'});
   await p.locator('button.server-open[aria-label="View OPT71"]').click();
   await panel.locator('.power-btn').first().waitFor();
   for(const a of await panel.locator('.power-btn').evaluateAll(els=>els.map(e=>e.getAttribute('aria-disabled'))))assert.equal(a,'true');
   await p.keyboard.press('Escape');await panel.waitFor({state:'detached'});
   await setEdit(p,false);
   assert.equal(posts.length,0);
   await p.close();
   passed.push('4 power: Viewer none; OPT12 Off asks (Cancel focused, sends 0), Off = 1 POST {"action":"off"} -> OFF, On asks, dblclick = 1 POST; protected OPT14 shows the 409; PSU1/PSU2 whole = 2 POSTs, only this feed = 1; Edit panel uses the same dialog; OPT71 blocked');
  }

  // ── 5. cooling units (admin) ──
  if(run(5)){
   const p=await open(admin);
   const puts=[];p.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/api/chillers'))puts.push(r.postData());});
   const r4=card(p,'Rack-04');
   assert.equal(await r4.locator('[data-u-slot="3"] .cooling-chip').count(),2,'two units on U03 are both drawn');
   assert.match(await r4.locator('.cooling-strip .cooling-chip[data-unit-id="ch4c"]').innerText(),/Chiller-3\s*no shelf/);
   const panel=p.locator('#cooling-panel');
   await panel.waitFor();   // opens by itself: a unit needs a rack
   assert.match(await panel.locator('[data-group="needs-rack"]').innerText(),/צ׳ילר נייד[\s\S]*No rack/);
   assert.match(await panel.locator('li[data-unit-id="ch-lost"]').innerText(),/Rack-99 \(not found\)/);
   assert.equal(await panel.locator('li[data-unit-id]').count(),UNITS,'every unit is listed');
   await shot(p,'cooling-panel');
   // view mode: read-only dialog, no save
   await r4.locator('[data-u-slot="3"] .cooling-chip[data-unit-id="ch4"]').click();
   const dlg=p.locator('[role="dialog"][data-dialog="cooling"]');
   await dlg.waitFor();assert.match(await dlg.innerText(),/Turn on Edit to move this unit\./);
   await shot(p,'cooling-dialog-view');
   await p.keyboard.press('Escape');await dlg.waitFor({state:'detached'});
   assert.equal(puts.length,0);
   // keyboard only, Edit mode: Chiller-3 to Rack-05 U02
   await setEdit(p,true);
   const chip=r4.locator('.cooling-strip .cooling-chip[data-unit-id="ch4c"]');
   await chip.focus();await p.keyboard.press('Enter');
   await dlg.waitFor();
   assert.equal(await p.evaluate(()=>document.activeElement?.id),'cooling-rack','the Rack select has focus');
   for(let i=0;i<12&&await p.evaluate(()=>document.activeElement.value)!=='Rack-05';i++)await p.keyboard.press('ArrowDown');
   assert.equal(await p.evaluate(()=>document.activeElement.value),'Rack-05');
   await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement?.id),'cooling-shelf');
   for(let i=0;i<4&&await p.evaluate(()=>document.activeElement.value)!=='2';i++)await p.keyboard.press('ArrowDown');
   assert.match(await p.evaluate(()=>document.activeElement.selectedOptions[0].textContent),/^U02 · /);
   await shot(p,'cooling-dialog-edit');
   await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement?.textContent),'Save');
   await p.keyboard.press('Enter');await dlg.waitFor({state:'detached'});
   assert.equal(puts.length,1,'exactly one save');
   await expectUnit('ch4c',{rack:'Rack-05',u:2});
   const moved=p.locator('[data-rack-id="Rack-05"] [data-u-slot="2"] [data-unit-id="ch4c"]');
   await moved.waitFor();
   await p.waitForFunction(()=>document.activeElement?.matches('[data-rack-id="Rack-05"] [data-u-slot="2"] [data-unit-id="ch4c"]'));
   assert.match(await p.locator('.toast').innerText(),/Chiller-3 moved to Rack-05 · U02/);
   await shot(p,'toast-undo');
   await p.locator('.toast').getByRole('button',{name:'Undo'}).click();
   await p.waitForFunction(()=>/is back at Rack-04 · not on a shelf/.test(document.querySelector('.toast')?.textContent||''));
   await expectUnit('ch4c',{rack:'Rack-04',u:null});
   assert.equal(await unitCount(),UNITS);
   // Take off shelf keeps the rack; "Undo last change" in the panel puts it back
   await r4.locator('[data-u-slot="3"] .cooling-chip[data-unit-id="ch4"]').click();await dlg.waitFor();
   await dlg.getByRole('button',{name:'Take off shelf'}).click();await dlg.waitFor({state:'detached'});
   await expectUnit('ch4',{rack:'Rack-04',u:null});
   await r4.locator('.cooling-strip [data-unit-id="ch4"]').waitFor();
   await panel.getByRole('button',{name:'Undo last change'}).click();
   await r4.locator('[data-u-slot="3"] [data-unit-id="ch4"]').waitFor();
   await expectUnit('ch4',{rack:'Rack-04',u:3});
   assert.equal(await unitCount(),UNITS);
   // the Hebrew unit to Rack-02 U06: its shelf is shown (not folded) and its name reads right to left
   await panel.locator('li[data-unit-id="ch-free"] button').click();await dlg.waitFor();
   await dlg.locator('#cooling-rack').selectOption('Rack-02');await dlg.locator('#cooling-shelf').selectOption('6');
   await dlg.getByRole('button',{name:'Save'}).click();await dlg.waitFor({state:'detached'});
   await setEdit(p,false);
   const heb=card(p,'Rack-02').locator('[data-u-slot="6"] .cooling-chip[data-unit-id="ch-free"] .cooling-name');
   await heb.waitFor();
   assert.equal(await heb.getAttribute('dir'),'auto');
   assert.equal(await heb.evaluate(e=>getComputedStyle(e).direction),'rtl');
   assert.equal(await card(p,'Rack-02').locator('.shelf-row[data-u-slot="6"][data-cooling-only]').count(),1,'U06 is shown, not folded');
   assert.equal(await card(p,'Rack-02').locator('.shelf-gap[data-from="7"][data-to="8"]').count(),1);
   // a stale undo changes nothing
   await setEdit(p,true);
   await card(p,'Rack-02').locator('[data-unit-id="ch-free"]').click();await dlg.waitFor();
   await dlg.locator('#cooling-shelf').selectOption('');await dlg.getByRole('button',{name:'Save'}).click();await dlg.waitFor({state:'detached'});
   await putChillers(d=>{d.units.find(u=>u.id==='ch-free').u=7;return d;});
   await p.locator('.toast').getByRole('button',{name:'Undo'}).click();
   await p.waitForFunction(()=>/changed in another session/.test(document.querySelector('.toast')?.textContent||''));
   await expectUnit('ch-free',{rack:'Rack-02',u:7},'the other session\'s change is kept');
   assert.equal(await unitCount(),UNITS);
   // add: a new unit (never deleted afterwards; it stays in the fixture with no rack)
   // change history (RU-BE): shown when the server keeps one
   const hist=await admin.c.request.get(origin+'/api/chillers/history');
   if(hist.status()===200){
    await panel.locator('summary',{hasText:'Change history'}).click();
    const newest=panel.locator('.cooling-history-list li').first();await newest.waitFor();
    const rev=await newest.getAttribute('data-revision');
    // the newest version is the document before the other session's change (Hebrew unit not on a shelf)
    await newest.getByRole('button',{name:'Restore…'}).click();
    await newest.getByRole('button',{name:`Restore #${rev}`}).click();
    await p.waitForFunction(r=>document.querySelector('.toast')?.textContent.includes(`restored to version #${r}`),rev);
    await expectUnit('ch-free',{rack:'Rack-02',u:null},'restored version');
    assert.equal(await unitCount(),UNITS);
    passed.push(`5b cooling history: version #${rev} restored through the panel (If-Match), no unit lost`);
   }
   await setEdit(p,false);await p.close();
   passed.push('5 cooling: 2 units on U03, Chiller-3 "no shelf", panel (needs a rack, Rack-99 not found, all units), view dialog saves nothing, keyboard move to Rack-05 U02 (1 PUT, focus on the chip), Undo, Take off shelf + Undo last change, Hebrew unit on U06 rtl, stale undo refused, unit count unchanged');
  }

  // ── 6. keyboard and focus ──
  if(run(6)){
   const p=await open(operator);
   const search=p.getByRole('searchbox',{name:/Find server/});
   await search.focus();
   const order=[];
   for(let i=0;i<40;i++){await p.keyboard.press('Tab');const k=await p.evaluate(()=>{const a=document.activeElement;return a.closest('.racks-filter')?'filter':a.closest('.racks-jump')?'jump':a.matches('.rack-card-name')?'card':'other';});if(order[order.length-1]!==k)order.push(k);if(k==='card')break;}
   assert.ok(order.indexOf('filter')>=0&&order.indexOf('filter')<order.indexOf('jump')&&order.indexOf('jump')<order.indexOf('card'),order.join(' > '));
   await card(p,'Rack-04').locator('.rack-card-name').click();
   await p.waitForFunction(()=>document.activeElement?.id==='rack-detail-title');
   const tb=await p.evaluate(()=>scrollY);assert.ok(tb<=120,`the detail starts at the top (${tb})`);
   await shot(p,'detail-rack04-1440');
   await noOverflow(p,'detail 1440');
   await p.getByRole('button',{name:'All racks'}).click();
   await p.waitForFunction(()=>document.activeElement?.matches('[data-rack-id="Rack-04"] .rack-card-name'));
   const inView=await card(p,'Rack-04').evaluate(e=>{const b=e.getBoundingClientRect();return b.top<innerHeight&&b.bottom>0;});assert.ok(inView,'the card is in view');
   // dialogs keep focus inside and give it back
   await p.locator('button.server-open[aria-label="View OPT41"]').click();
   const details=p.locator('[role="dialog"][data-dialog="server"]');await details.waitFor();
   await shot(p,'server-details-dialog');
   for(let i=0;i<20;i++){await p.keyboard.press('Tab');assert.ok(await details.evaluate(d=>d.contains(document.activeElement)),'Tab stays in the details');}
   await details.getByRole('button',{name:'Power off'}).click();
   const confirm=p.locator('[role="alertdialog"]');await confirm.waitFor();
   for(let i=0;i<20;i++){await p.keyboard.press('Tab');assert.ok(await confirm.evaluate(d=>d.contains(document.activeElement)),'Tab stays in the confirmation');}
   await p.keyboard.press('Escape');await confirm.waitFor({state:'detached'});
   assert.ok(await details.isVisible(),'Escape closed only the confirmation');
   assert.equal(await p.evaluate(()=>document.activeElement?.textContent),'Power off','focus back on its opener');
   await p.keyboard.press('Escape');await details.waitFor({state:'detached'});
   assert.equal(await p.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'View OPT41');
   // Space opens an equipment cell
   await p.locator('.equipment-cell[aria-label="View Switch 04"]').focus();await p.keyboard.press(' ');
   await p.locator('[role="dialog"]',{hasText:'Turn on Edit to change this equipment.'}).waitFor();
   await p.keyboard.press('Escape');
   await p.close();
   passed.push('6 keyboard: search > filters > rack chips > card; rack opens at its heading and Back returns to its card; Tab trapped in details and confirmation, Escape closes one at a time with focus returned; Space opens equipment');
  }

  // ── 7. text size and contrast ──
  if(run(7)){
   const p=await open(operator);
   await openPanel(p);
   const check=async label=>{
    const bad=await p.evaluate(()=>{
     const lum=c=>{const [r,g,b]=c.map(v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};
     const rgb=s=>{const m=s.match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return p.length>3&&p[3]===0?null:p.slice(0,3);};
     const bg=el=>{for(let e=el;e;e=e.parentElement){const c=rgb(getComputedStyle(e).backgroundColor);if(c)return c;}return [12,12,12];};
     const out=[];
     const roots=[...document.querySelectorAll('[data-rack-id], .racks-toolbar, .rack-kpis, #cooling-panel, [role="dialog"], [role="alertdialog"]')];
     for(const root of roots){const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){
      const t=n.textContent.trim();if(!t)continue;const el=n.parentElement;
      if(el.closest('[aria-disabled="true"], :disabled, [hidden], .sr-only, [data-auto] .shelf-index, option, select'))continue;
      const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
      const cs=getComputedStyle(el);const size=parseFloat(cs.fontSize);const fg=rgb(cs.color);if(!fg)continue;
      const L1=lum(fg),L2=lum(bg(el));const ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
      const large=size>=24||(size>=18.66&&Number(cs.fontWeight)>=700);
      if(size<11)out.push(`${t.slice(0,30)}: ${size}px`);
      if(ratio<(large?3:4.5))out.push(`${t.slice(0,30)}: ${ratio.toFixed(2)}:1 (${cs.color} on ${bg(el)})`);
     }}
     return [...new Set(out)].slice(0,20);
    });
    assert.deepEqual(bad,[],`${label}: text size/contrast`);
   };
   await check('overview');
   await p.locator('button.server-open[aria-label="View OPT41"]').click();await p.locator('[role="dialog"]').waitFor();
   await check('server details');
   await p.keyboard.press('Escape');await p.close();
   passed.push('7 contrast: every visible text in cards, toolbar, summary, cooling panel and dialogs is 11 px or more and 4.5:1 (3:1 large)');
  }

  // ── 8. right-to-left names ──
  if(run(8)){
   const l4=await labels('pdu4');
   try{
    await setLabels('pdu4',{...l4,'4':'שרת בדיקה 44'});
    const p=await open(operator);
    const name=p.locator('.server-cell[data-server="שרת בדיקה 44"] .server-name');
    await name.waitFor();
    assert.equal(await name.getAttribute('dir'),'auto');assert.equal(await name.evaluate(e=>getComputedStyle(e).direction),'rtl');
    await card(p,'Rack-04').locator('.rack-card-name').click();await p.locator('#rack-detail-title').waitFor();
    const cell=p.locator('tr[data-server="שרת בדיקה 44"] td:nth-child(2) .server-name');
    assert.equal(await cell.getAttribute('dir'),'auto');assert.equal(await cell.evaluate(e=>getComputedStyle(e).direction),'rtl');
    await p.close();
   }finally{await setLabels('pdu4',l4);}
   passed.push('8 rtl: a Hebrew server name reads right to left in the card and the detail table');
  }

  // ── 9. the assistant launcher never covers a server at the bottom ──
  if(run(9)){
   for(const [w,h] of [[1440,900],[375,812]]){
    const p=await open(operator,{width:w,height:h});
    if(w===375)await p.getByRole('button',{name:'Expand all'}).click();
    await p.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await sleep(300);
    const hits=await p.evaluate(()=>{
     const launcher=[...document.querySelectorAll('button')].find(b=>getComputedStyle(b).position==='fixed'&&/z-\[45\]/.test(b.className));
     if(!launcher)return 'no launcher';
     const a=launcher.getBoundingClientRect();
     return [...document.querySelectorAll('button.server-open, .power-toggle')].filter(e=>{const b=e.getBoundingClientRect();return b.width&&!(b.right<=a.left||b.left>=a.right||b.bottom<=a.top||b.top>=a.bottom);}).map(e=>e.getAttribute('aria-label'));
    });
    assert.ok(hits==='no launcher'||hits.length===0,`${w}: launcher covers ${JSON.stringify(hits)}`);
    await p.close();
   }
   passed.push('9 the assistant launcher covers no server name or switch at the bottom (1440, 375)');
  }

  // ── 11. dragging in Edit mode: a cooling unit (pointer only) and, unchanged, an OPT within its rack ──
  if(run(11)){
   const p=await open(admin,{width:1440,height:1300});await setEdit(p,true);
   async function drag(from,to){
    await to.evaluate(e=>e.closest('[data-rack-id]').scrollIntoView({block:'center'}));await sleep(200);
    const a=await from.boundingBox();
    await p.mouse.move(a.x+a.width/2,a.y+a.height/2);await p.mouse.down();
    await p.mouse.move(a.x+a.width/2+12,a.y+a.height/2+12,{steps:4});
    const b=await to.boundingBox();await p.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:15});
    await sleep(200);await p.mouse.up();
   }
   await drag(card(p,'Rack-04').locator('.cooling-strip [data-unit-id="ch4c"]'),card(p,'Rack-05').locator('[data-u-slot="2"]'));
   await expectUnit('ch4c',{rack:'Rack-05',u:2},'cooling drag');
   await p.locator('.toast').getByRole('button',{name:'Undo'}).click();
   await expectUnit('ch4c',{rack:'Rack-04',u:null},'drag undone');
   const positions=async()=>(await(await admin.c.request.get(origin+'/api/rack-positions')).json());
   const kept=await positions();
   try{
    await drag(card(p,'Rack-01').locator('[data-u-slot="4"] .shelf-grip'),card(p,'Rack-01').locator('.server-cell[data-server="OPT11"]'));
    let order;for(let i=0;i<30;i++){order=(await positions())['Rack-01'];if(order?.[0]==='opt14')break;await sleep(150);}
    assert.equal(order?.[0],'opt14',`OPT14 dragged to the top of Rack-01 (${JSON.stringify(order)})`);
   }finally{
    const g=await admin.c.request.get(origin+'/api/rack-positions');const d=await g.json();
    if(kept['Rack-01']===undefined)delete d['Rack-01'];else d['Rack-01']=kept['Rack-01'];
    await admin.c.request.put(origin+'/api/rack-positions',{data:d,headers:H(admin,g.headers()['etag'])});
   }
   await setEdit(p,false);await p.close();
   passed.push('11 Edit-mode drag: a cooling unit onto Rack-05 U02 (saved, Undo), an OPT to the top of its rack (order saved; restored)');
  }

  // ── Edit-mode screenshot ──
  if(run(10)){
   const p=await open(admin);await setEdit(p,true);await shot(p,'admin-grid-edit-1440');
   const m=await open(admin,{width:375,height:812});await m.getByRole('button',{name:'Expand all'}).click();await setEdit(m,true);await shot(m,'admin-grid-edit-375');
   await setEdit(p,false);await p.close();await setEdit(m,false);await m.close();
   passed.push('10 Edit-mode screenshots');
  }

  assert.equal(nativeDialogs,0,'no native confirm or alert');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed,screenshots:SHOTS},null,1));
 }finally{
  for(const c of cleanups.reverse())await c().catch(e=>console.error('cleanup',e.message));
  await browser.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
