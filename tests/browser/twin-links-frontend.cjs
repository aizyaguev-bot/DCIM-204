// "Show in 3D" from Lab Manager into the embedded 3D twin, Lab Manager side (WP4), on the isolated fixture
// (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1). The shared interface: ref = srv:<optKey> |
// item:<rack item id> | rack:<rack name>; the twin iframe opens on /twin/index.html?embed=1&select=<encoded ref>, and
// a twin that has already loaded gets postMessage({type:'twin:select', ref}, location.origin) instead of a new src.
// The twin's own reaction is built in another package, so the messages are captured inside its window here.
// LINK-1 the rack detail's "Show Rack-03 in 3D" (its visible text is its whole name), pressed with Enter, opens the
// Twin tab on ?select=rack:Rack-03 (src and address) and moves keyboard focus to the twin's frame;
// LINK-2 with the twin loaded, a server dialog's (srv:opt31) and a unit dialog's (item:ci-3) Show in 3D post the
// message, same origin, and never change the src or reload the twin; quick tab switches keep it loaded (hidden);
// LINK-3 a fresh page: the rack card's, the server's and the unit's Show in 3D put the ref into the src;
// LINK-4 ?tab=twin&select=srv:opt12 opens the iframe on it (no or a malformed select: the plain embed URL);
// LINK-5 every role (Viewer, Operator, Admin) sees Show in 3D; the rack card header does not grow or wrap;
// LINK-6 Back / Forward onto a Show in 3D address the twin was not last given shows that ref again (a message);
// LINK-7 the twin hidden for 10 min is removed (hidden it pauses itself; removing it frees its memory); the next Show in
// 3D loads it again;
// LINK-8 Edit mode: the server and unit edit panels have Show in 3D, blocked while the panel has unsaved changes.
// Only fixture data; nothing is changed (edits in LINK-8 are typed and undone, never saved); no hardware.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin=process.env.DCIM_PREVIEW_URL||'http://127.0.0.1:8770';
const PASSWORD='test-password-123';
const RACK='Rack-03', OPT='OPT31', OPT_REF='srv:opt31', UNIT='Switch 03', UNIT_ID='ci-3';
const FRAME='iframe[title="3D Digital Twin"]';
const KEEP_MS=10*60*1000;   // TWIN_HIDDEN_KEEP_MS in frontend/src/twinLinks.js
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const errors=[],passed=[];
 async function session(username,viewport={width:1440,height:900}){
  const c=await browser.newContext({viewport});
  await c.addInitScript(()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const login=await c.request.post(origin+'/api/auth/login',{data:{username,password:PASSWORD}});
  assert.equal(login.status(),200,`${username} login`);
  return c;
 }
 async function open(c,path,{clock=false}={}){const p=await c.newPage();p.on('pageerror',e=>errors.push(`${path}: ${e.message}`));if(clock)await p.clock.install();await p.goto(origin+path);return p;}
 const tabButton=(p,name)=>p.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true});
 const src=p=>p.locator(FRAME).getAttribute('src');
 const twinUrl=ref=>'/twin/index.html?embed=1'+(ref?'&select='+encodeURIComponent(ref):'');
 async function onTwinTab(p,label){
  await p.locator(FRAME).waitFor({state:'visible'});
  assert.equal(await tabButton(p,'3D Twin').getAttribute('aria-current'),'page',`${label}: the Twin tab is active`);
  assert.equal(await p.locator('#rack-detail-title').count(),0,`${label}: Racks is gone`);
 }
 // after Show in 3D, keyboard focus is on the twin's frame (its button left with the Racks page)
 const focusOnTwin=(p,label)=>p.waitForFunction(sel=>document.activeElement===document.querySelector(sel),FRAME,{timeout:5000}).catch(async()=>{
  assert.fail(`${label}: focus is on ${await p.evaluate(()=>{const a=document.activeElement;return a?a.tagName+(a.getAttribute('aria-label')?' '+a.getAttribute('aria-label'):''):'nothing';})}, not the twin`);});
 const query=p=>new URL(p.url()).searchParams;
 const twinLoaded=p=>p.waitForFunction(sel=>{const f=document.querySelector(sel);return f?.contentDocument?.readyState==='complete'&&f.contentWindow.location.pathname==='/twin/index.html';},FRAME,{timeout:60000});
 // records, in Lab Manager's window, what the twin window is sent; marks the twin document to tell a reload apart
 async function capture(p,mark){
  await p.evaluate(([sel,mark])=>{const w=document.querySelector(sel).contentWindow;window.__twinMsgs=[];w.__wp4Marker=mark;
   window.__twinOrder=[];w.addEventListener('resize',()=>window.__twinOrder.push('resize:'+w.innerWidth));
   w.addEventListener('message',e=>{window.__twinOrder.push('message');window.__twinMsgs.push({data:e.data,origin:e.origin,fromApp:e.source===window});});},[FRAME,mark]);
 }
 const marker=p=>p.evaluate(sel=>document.querySelector(sel)?.contentWindow?.__wp4Marker||null,FRAME);
 const messages=p=>p.evaluate(()=>window.__twinMsgs);
 const waitMessages=(p,n)=>p.waitForFunction(n=>window.__twinMsgs.length===n,n,{timeout:10000});
 try{
  const viewer=await session('viewer');
  assert.equal((await(await viewer.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
  const items=await(await viewer.request.get(origin+'/api/rack-items')).json();
  assert.ok((items[RACK]||[]).some(i=>i.id===UNIT_ID&&i.name===UNIT),`the fixture has ${UNIT} (${UNIT_ID}) in ${RACK}`);

  // ── LINK-1: the rack detail's Show in 3D, the twin not loaded yet: the src carries the ref; focus goes to the twin ──
  const p=await open(viewer,`/?tab=racks&rack=${RACK}`);
  await p.locator('#rack-detail-title').waitFor();
  assert.equal(await p.locator(FRAME).count(),0,'no twin before the Twin tab first opens');
  const rackButton=p.getByRole('button',{name:`Show ${RACK} in 3D`,exact:true});
  assert.equal(await rackButton.count(),1,'one Show in 3D for the rack in its detail (the diagram header has none)');
  assert.equal(await rackButton.evaluate(b=>b.innerText.replace(/\s+/g,' ').trim()),`Show ${RACK} in 3D`,'its visible text is its whole accessible name (label in name)');
  await rackButton.focus();await p.keyboard.press('Enter');
  await onTwinTab(p,'LINK-1');
  assert.equal(await src(p),twinUrl(`rack:${RACK}`));
  assert.deepEqual([query(p).get('tab'),query(p).get('select'),query(p).has('rack')],['twin',`rack:${RACK}`,false],'the address names the ref');
  await focusOnTwin(p,'LINK-1');
  await twinLoaded(p);
  await p.waitForTimeout(300);
  await capture(p,'first load');
  passed.push(`LINK-1 Enter on the ${RACK} detail's "Show ${RACK} in 3D" (visible text = name) opens the Twin tab with src ${twinUrl(`rack:${RACK}`)} and ?tab=twin&select=rack:${RACK}; focus moves to the twin's frame`);

  // ── LINK-2: the twin loaded: a server and a unit are posted to it; quick tab switches never reload it ──
  await p.goBack();await p.locator('#rack-detail-title').waitFor();
  assert.equal(await p.locator(FRAME).count(),1,'the twin stays mounted off its tab (for a while)');
  assert.equal(await p.locator(FRAME).isHidden(),true,'and hidden');
  assert.equal(await p.locator(FRAME).evaluate(f=>getComputedStyle(f).display),'none');
  assert.equal(await marker(p),'first load','Back to Racks did not reload the twin');
  await p.locator('.racks-table').getByRole('button',{name:`View ${OPT}`,exact:true}).click();
  const serverDialog=p.locator('[data-dialog="server"]');await serverDialog.waitFor();
  await serverDialog.getByRole('button',{name:`Show ${OPT} in 3D`,exact:true}).click();
  await onTwinTab(p,'LINK-2 server');
  await waitMessages(p,1);
  assert.deepEqual(await messages(p),[{data:{type:'twin:select',ref:OPT_REF},origin,fromApp:true}]);
  assert.equal(await src(p),twinUrl(`rack:${RACK}`),'the src is unchanged');
  assert.equal(await marker(p),'first load','not reloaded');
  assert.equal(query(p).get('select'),OPT_REF);
  await focusOnTwin(p,'LINK-2 server');
  // hidden with display:none, the twin keeps its viewport size: no resize (its resize handler cancels a camera move)
  const order=await p.evaluate(()=>window.__twinOrder);
  assert.ok(order.includes('message')&&!order.includes('resize:0'),`the twin is not resized to nothing: ${order.join(', ')}`);
  await p.goBack();await p.locator('#rack-detail-title').waitFor();
  await p.locator('.racks-table').getByRole('button',{name:`View ${UNIT}`,exact:true}).click();
  const unitDialog=p.getByRole('dialog',{name:UNIT});await unitDialog.waitFor();
  await unitDialog.getByRole('button',{name:`Show ${UNIT} in 3D`,exact:true}).click();
  await onTwinTab(p,'LINK-2 unit');
  await waitMessages(p,2);
  assert.deepEqual((await messages(p))[1],{data:{type:'twin:select',ref:`item:${UNIT_ID}`},origin,fromApp:true});
  assert.equal(await src(p),twinUrl(`rack:${RACK}`));
  assert.equal(await marker(p),'first load');
  await focusOnTwin(p,'LINK-2 unit');
  // ordinary tab switches: hidden and shown again, never reloaded, nothing posted, the Twin tab button drops ?select=
  await tabButton(p,'Racks').click();await p.locator('[data-rack-id]').first().waitFor();
  assert.equal(await p.locator(FRAME).isHidden(),true);
  await tabButton(p,'Inventory').click();await tabButton(p,'3D Twin').click();
  await onTwinTab(p,'LINK-2 tab switch');
  await p.waitForTimeout(400);
  assert.equal(await marker(p),'first load','tab switches did not reload the twin');
  assert.equal((await messages(p)).length,2,'a tab switch posts nothing');
  assert.equal(await src(p),twinUrl(`rack:${RACK}`));
  assert.equal(query(p).has('select'),false);
  assert.equal(await p.evaluate(sel=>document.activeElement===document.querySelector(sel),FRAME),false,'the Twin tab button keeps focus where it is');
  // the rack card on all racks, with the twin loaded: a message as well
  await tabButton(p,'Racks').click();
  const cardButton=p.locator(`[data-rack-id="Rack-02"]`).getByRole('button',{name:'Show Rack-02 in 3D',exact:true});
  await cardButton.click();await onTwinTab(p,'LINK-2 card');
  await waitMessages(p,3);
  assert.deepEqual((await messages(p))[2].data,{type:'twin:select',ref:'rack:Rack-02'});
  assert.equal(await marker(p),'first load');
  passed.push(`LINK-2 with the twin loaded: ${OPT}'s and ${UNIT}'s dialogs and the Rack-02 card post {type:'twin:select'} (${OPT_REF}, item:${UNIT_ID}, rack:Rack-02) to the twin window from this origin and focus it; the src stays ${twinUrl(`rack:${RACK}`)}; Back, Racks / Inventory / 3D Twin tab switches keep the same twin document (hidden with display:none off its tab) and post nothing`);

  // ── LINK-6: Back / Forward onto a Show in 3D address the twin was not last given: that ref is shown again ──
  // history here: …, racks, twin, racks, twin?select=rack:Rack-02 (the twin was last given rack:Rack-02)
  const walk=async(dir,want)=>{const seen=[];for(let i=0;i<8;i++){await(dir<0?p.goBack():p.goForward());await p.waitForTimeout(250);
   const q=query(p);seen.push(`${q.get('tab')}${q.get('select')?'?'+q.get('select'):''}`);if(q.get('tab')==='twin'&&q.get('select')===want)return seen;}
   assert.fail(`${dir<0?'Back':'Forward'} never reached twin?select=${want}: ${seen.join(' > ')}`);};
  const back=await walk(-1,`item:${UNIT_ID}`);
  assert.ok(back.includes('twin'),`Back passed the plain Twin tab address: ${back.join(' > ')}`);
  await onTwinTab(p,'LINK-6 back to item');
  await waitMessages(p,4);
  assert.deepEqual((await messages(p))[3],{data:{type:'twin:select',ref:`item:${UNIT_ID}`},origin,fromApp:true},'Back re-selects the address\'s ref');
  await walk(1,'rack:Rack-02');
  await onTwinTab(p,'LINK-6 forward to Rack-02');
  await waitMessages(p,5);
  assert.deepEqual((await messages(p))[4].data,{type:'twin:select',ref:'rack:Rack-02'},'Forward too');
  await p.goBack();await p.locator('[data-rack-id]').first().waitFor();await p.goForward();await onTwinTab(p,'LINK-6 same ref');
  await p.waitForTimeout(400);
  assert.equal((await messages(p)).length,5,'back to the ref the twin already has: nothing posted');
  assert.equal(await marker(p),'first load','history never reloads the twin');
  assert.equal(await src(p),twinUrl(`rack:${RACK}`));
  passed.push(`LINK-6 Back to twin?select=item:${UNIT_ID} and Forward to twin?select=rack:Rack-02 post those refs again (the twin follows the address); the plain Twin tab address and a ref the twin already has post nothing; no reload`);
  await p.close();

  // ── LINK-3: fresh pages (the twin not loaded): the rack card, a server and a unit put the ref into the src ──
  for(const [label,path,openTarget,ref] of [
   ['rack card','/?tab=racks',async q=>q.locator('[data-rack-id="Rack-05"]').getByRole('button',{name:'Show Rack-05 in 3D',exact:true}).click(),'rack:Rack-05'],
   ['server',`/?tab=racks&rack=${RACK}`,async q=>{await q.locator('.racks-table').getByRole('button',{name:`View ${OPT}`,exact:true}).click();await q.locator('[data-dialog="server"]').getByRole('button',{name:`Show ${OPT} in 3D`,exact:true}).click();},OPT_REF],
   ['unit',`/?tab=racks&rack=${RACK}`,async q=>{await q.locator('.racks-table').getByRole('button',{name:`View ${UNIT}`,exact:true}).click();await q.getByRole('dialog',{name:UNIT}).getByRole('button',{name:`Show ${UNIT} in 3D`,exact:true}).click();},`item:${UNIT_ID}`],
  ]){
   const q=await open(viewer,path);await q.locator('[data-rack-id]').first().waitFor();
   await openTarget(q);await onTwinTab(q,`LINK-3 ${label}`);
   assert.equal(await src(q),twinUrl(ref),label);
   assert.equal(query(q).get('select'),ref);
   await focusOnTwin(q,`LINK-3 ${label}`);
   await q.close();
  }
  passed.push('LINK-3 fresh pages: the Rack-05 card, OPT31\'s dialog and Switch 03\'s dialog open the Twin tab with src ?embed=1&select=<encoded ref> (rack:Rack-05, srv:opt31, item:ci-3), focus on the twin');

  // ── LINK-4: opened on ?tab=twin&select= ──
  for(const [path,want] of [['/?tab=twin&select=srv:opt12',twinUrl('srv:opt12')],['/?tab=twin&select=srv%3Aopt12',twinUrl('srv:opt12')],['/?tab=twin',twinUrl(null)],['/?tab=twin&select=nonsense',twinUrl(null)]]){
   const q=await open(viewer,path);await onTwinTab(q,path);
   assert.equal(await src(q),want,path);
   await q.close();
  }
  passed.push(`LINK-4 /?tab=twin&select=srv:opt12 opens the iframe on ${twinUrl('srv:opt12')}; ?tab=twin and a malformed select keep ${twinUrl(null)}`);

  // ── LINK-7: hidden for KEEP_MS the twin is removed; showing it again before that restarts the wait ──
  {
   const q=await open(viewer,'/?tab=twin',{clock:true});await onTwinTab(q,'LINK-7');
   await twinLoaded(q);await capture(q,'kept');
   await tabButton(q,'Racks').click();await q.locator('[data-rack-id]').first().waitFor();
   await q.clock.fastForward(KEEP_MS-5000);
   assert.equal(await q.locator(FRAME).count(),1,`hidden ${KEEP_MS-5000} ms: still loaded`);
   await tabButton(q,'3D Twin').click();await onTwinTab(q,'LINK-7 shown again');
   await tabButton(q,'Racks').click();await q.locator('[data-rack-id]').first().waitFor();
   await q.clock.fastForward(KEEP_MS-5000);
   assert.equal(await q.locator(FRAME).count(),1,'showing it again restarted the wait');
   assert.equal(await marker(q),'kept','and it was never reloaded');
   await q.clock.fastForward(6000);
   await q.locator(FRAME).waitFor({state:'detached',timeout:5000});
   // removed: the next Show in 3D loads it again on the ref (src), as on a fresh page
   await q.locator('[data-rack-id="Rack-05"]').getByRole('button',{name:'Show Rack-05 in 3D',exact:true}).click();
   await onTwinTab(q,'LINK-7 after removal');
   assert.equal(await src(q),twinUrl('rack:Rack-05'));
   await twinLoaded(q);
   assert.equal(await marker(q),null,'a new twin document');
   await q.close();
  }
  passed.push(`LINK-7 off the Twin tab the twin stays loaded ${KEEP_MS/60000} min (showing it again restarts that), then is removed; the next Show in 3D loads it on src ${twinUrl('rack:Rack-05')}`);

  // ── LINK-8: Edit mode: the server and unit edit panels, blocked while they have unsaved changes ──
  for(const viewport of [{width:1366,height:768},{width:390,height:844}]){
   const c=await session('admin',viewport);const q=await open(c,`/?tab=racks&rack=${RACK}`);await q.locator('#rack-detail-title').waitFor();
   const editOn=async()=>{await q.locator('button.edit-toggle').click();await q.waitForFunction(()=>document.querySelector('button.edit-toggle')?.getAttribute('aria-pressed')==='true');};
   // the table's row on a desktop, the diagram's server on a phone (Edit mode shows no list there)
   const viewButton=name=>viewport.width>=768?q.locator('.racks-table').getByRole('button',{name:`View ${name}`,exact:true}):q.getByRole('button',{name:`View ${name}`,exact:true}).first();
   // aria-disabled: Playwright's click() would wait for it to be enabled; a keyboard user presses Enter on it
   const press=async b=>{await b.focus();await q.keyboard.press('Enter');};
   await editOn();
   await viewButton(OPT).click();
   const panel=q.getByRole('dialog',{name:OPT});await panel.waitFor();
   const show=panel.getByRole('button',{name:`Show ${OPT} in 3D`,exact:true});
   assert.equal(await show.count(),1,`${viewport.width}: the server edit panel has Show in 3D`);
   const head=await show.evaluate(b=>{const h=b.closest('.border-b');const r=h.getBoundingClientRect(),br=b.getBoundingClientRect();return{overflow:h.scrollWidth>h.clientWidth+1,inside:br.left>=r.left&&br.right<=r.right+0.5&&br.right<=innerWidth};});
   assert.deepEqual(head,{overflow:false,inside:true},`${viewport.width}: the panel header keeps the button inside`);
   assert.equal(await show.getAttribute('aria-disabled'),null,'nothing unsaved: enabled');
   const outlet=panel.getByPlaceholder('Outlet number');const was=await outlet.inputValue();
   await outlet.fill(String(Number(was||0)+7));   // saved only on Enter: typed, never sent
   assert.equal(await show.getAttribute('aria-disabled'),'true','an unsaved outlet blocks Show in 3D');
   assert.match(await show.getAttribute('title'),/Save or undo your changes first/);
   await press(show);
   const note=panel.locator('[data-note="show-in-3d"]');
   assert.equal(await note.getAttribute('role'),'status');
   assert.match(await note.innerText(),/Save or undo your changes first: Show in 3D leaves Racks\./);
   assert.equal(query(q).get('tab'),'racks','still on Racks, the draft kept');
   assert.equal(await outlet.inputValue(),String(Number(was||0)+7));
   await outlet.fill(was);
   assert.equal(await show.getAttribute('aria-disabled'),null,'undone: enabled again');
   assert.equal(await note.count(),0,'and the note is gone');
   await show.click();
   await onTwinTab(q,`LINK-8 ${viewport.width} server`);
   assert.equal(await src(q),twinUrl(OPT_REF));
   await focusOnTwin(q,`LINK-8 ${viewport.width} server`);
   await twinLoaded(q);await capture(q,'edit');
   // the unit's edit panel (Edit mode is left with Racks; turn it on again)
   await q.goBack();await q.locator('#rack-detail-title').waitFor();await editOn();
   await viewButton(UNIT).click();
   const unitShow=q.locator(`[data-action="show-in-3d"][data-ref="item:${UNIT_ID}"]`);await unitShow.waitFor();
   assert.equal(await unitShow.getAttribute('aria-label'),`Show ${UNIT} in 3D`);
   const unitPanel=q.locator('div.fixed.inset-0').filter({has:unitShow});
   const notes=unitPanel.locator('textarea');const before=await notes.inputValue();
   await notes.fill(before+' draft');
   assert.equal(await unitShow.getAttribute('aria-disabled'),'true','an unsaved unit draft blocks Show in 3D');
   await press(unitShow);
   assert.match(await unitPanel.locator('[data-note="show-in-3d"]').innerText(),/Save or undo your changes first/);
   assert.equal(query(q).get('tab'),'racks');
   await notes.fill(before);
   assert.equal(await unitShow.getAttribute('aria-disabled'),null);
   await unitShow.click();
   await onTwinTab(q,`LINK-8 ${viewport.width} unit`);
   await waitMessages(q,1);
   assert.deepEqual((await messages(q))[0].data,{type:'twin:select',ref:`item:${UNIT_ID}`});
   assert.equal(await marker(q),'edit','posted to the loaded twin');
   await focusOnTwin(q,`LINK-8 ${viewport.width} unit`);
   await q.close();await c.close();
  }
  passed.push(`LINK-8 Edit mode at 1366 and 390 px: ${OPT}'s server edit panel and ${UNIT}'s unit edit panel have Show in 3D in their header; a typed, unsaved outlet or note sets aria-disabled, and a click stays on Racks with the draft and says "Save or undo your changes first" (role=status); undone, it opens the twin (src ${twinUrl(OPT_REF)}, then a message for item:${UNIT_ID}); nothing saved`);

  // ── LINK-5: every role; the rack card header keeps one line at desktop and phone widths ──
  for(const role of ['operator','admin']){
   const c=await session(role);const q=await open(c,`/?tab=racks&rack=${RACK}`);await q.locator('#rack-detail-title').waitFor();
   assert.equal(await q.getByRole('button',{name:`Show ${RACK} in 3D`,exact:true}).count(),1,`${role}: rack detail`);
   await q.locator('.racks-table').getByRole('button',{name:`View ${OPT}`,exact:true}).click();
   assert.equal(await q.locator('[data-dialog="server"]').getByRole('button',{name:`Show ${OPT} in 3D`,exact:true}).count(),1,`${role}: server dialog`);
   await q.close();await c.close();
  }
  for(const viewport of [{width:1366,height:768},{width:390,height:844}]){
   const c=await session('viewer',viewport);const q=await open(c,'/?tab=racks');await q.locator('[data-rack-id]').first().waitFor();
   if(viewport.width<500&&await q.getByRole('button',{name:'Expand all'}).count())await q.getByRole('button',{name:'Expand all'}).click();
   const cards=await q.locator('.rack-card-header').evaluateAll(hs=>hs.map(h=>{const name=h.querySelector('.rack-card-name span');const b=h.querySelector('[data-action="show-in-3d"]');
    return{rack:h.closest('[data-rack-id]').dataset.rackId,storage:h.closest('[data-rack-id]').dataset.rackType==='storage',btnH:Math.max(0,...[...h.querySelectorAll('button')].map(x=>x.getBoundingClientRect().height)),height:h.getBoundingClientRect().height,cut:name?name.scrollWidth>name.clientWidth+1:false,button:b?{label:b.getAttribute('aria-label'),ref:b.dataset.ref,h:b.getBoundingClientRect().height}:null,overflow:h.scrollWidth>h.clientWidth+1};}));
   assert.ok(cards.length>=7,`${viewport.width}: all rack cards`);
   assert.ok(cards.some(c=>c.storage)&&cards.some(c=>!c.storage),`${viewport.width}: storage and compute racks both checked`);
   for(const card of cards){
    // a storage rack has no place in the 3D twin, so it has no Show in 3D (it could only end in "Not found")
    if(card.storage)assert.equal(card.button,null,`${viewport.width} ${card.rack}: storage rack, no Show in 3D`);
    else assert.deepEqual(card.button&&[card.button.label,card.button.ref],[`Show ${card.rack} in 3D`,`rack:${card.rack}`],`${viewport.width} ${card.rack}`);
    assert.ok(card.height<=card.btnH+1,`${viewport.width} ${card.rack}: the header keeps one line (${card.height}px, its buttons ${card.btnH}px)`);
    assert.equal(card.cut,false,`${viewport.width} ${card.rack}: the rack name is whole`);
    assert.equal(card.overflow,false,`${viewport.width} ${card.rack}: nothing leaves the header`);
   }
   assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${viewport.width}: no page scroll sideways`);
   // the rack detail's head wraps its buttons; "Show <rack> in 3D" stays whole and on screen
   await q.locator(`[data-rack-id="${RACK}"] .rack-card-name`).click();await q.locator('#rack-detail-title').waitFor();
   const detail=await q.locator('.rack-detail-head').evaluate(h=>{const b=h.querySelector('[data-action="show-in-3d"]');const br=b.getBoundingClientRect();return{overflow:h.scrollWidth>h.clientWidth+1,onScreen:br.left>=0&&br.right<=innerWidth,oneLine:br.height<60};});
   assert.deepEqual(detail,{overflow:false,onScreen:true,oneLine:true},`${viewport.width}: rack detail head`);
   assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${viewport.width}: rack detail, no page scroll sideways`);
   await q.close();await c.close();
  }
  passed.push('LINK-5 Viewer, Operator and Admin see Show in 3D in the rack detail and the server dialog; every rack card has "Show <rack> in 3D" with its rack ref (a storage rack, which the 3D does not draw, has none), its header one line with the whole rack name at 1366 and 390 px; the detail\'s "Show Rack-03 in 3D" stays on screen; no sideways page scroll');

  assert.deepEqual(errors,[],'no page errors');
  console.log(passed.map(x=>'PASS '+x).join('\n'));
  console.log(`twin-links-frontend: ${passed.length} checks passed`);
 }catch(e){
  console.error(passed.map(x=>'PASS '+x).join('\n'));
  console.error('FAIL',e&&e.stack||e);
  if(errors.length)console.error('page errors:',errors);
  process.exitCode=1;
 }finally{await browser.close();}
})();
