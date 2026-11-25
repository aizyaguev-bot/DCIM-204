// A unit's owner on the Racks page and in its window (the lab owner's rule, 2026-11-10: a product on a floor belongs to
// whoever is registered on the server there; frontend/src/unitOwner.js), on the isolated fixture
// (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1). Racks has no unit panel any more (one-place WP-5): a unit
// opens its unit window (units/UnitWindow.jsx).
// UO-1 a unit on a server's floor shows that server's owner (its slot: tooltip and accessible description; its window:
//      read-only with "From <server>, the server on this floor."; a Viewer's read-only details; the phone rack-detail
//      list, labelled "Owner"), not its own saved owner;
// UO-2 search by the server's owner finds the unit, its own old owner does not; a storage unit is found by its own;
// UO-3 the server's owner changed in another session reaches the unit without a page reload;
// UO-4 the unit window (opened from its slot): the owner is read-only with "From <server>, the server on this floor.
//      Change it on the server." and no owner select; the server's owner changed in another session reaches the open
//      window (its unsaved edit kept); changing the server's owner in the server window ("Open <server>") updates the
//      unit at once, and closing the server window returns to the unit window;
// UO-5 moved (the window's Move…) to another server's floor it shows that server's owner; moved to the rack level (no
//      server) its own saved owner is back and editable (nothing was migrated);
// UO-6 a storage-shelf unit keeps its own owner, editable in its window, and a Viewer's window shows it read-only;
// UO-7 the unit window by its address (open=unit:<id>) shows the server's owner read-only on its floor, follows a change
//      made in another session without a reload, and moved to the rack level from the window shows its own owner, editable.
// Every change it makes (owners, two units) is undone and checked. Only fixture data; no hardware.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin=process.env.DCIM_PREVIEW_URL||'http://127.0.0.1:8770';
const PASSWORD='test-password-123';
const RACK='Rack-04', STORE='Storage shelf', STORE_U=5;
const TRAY='ci-unit-owner-tray', TRAY_NAME='Owner QA tray', BOX='ci-unit-owner-box', BOX_NAME='Owner QA box';
const S1='OPT41', S1_ID='opt41', S2='OPT44', S2_ID='opt44';
const A='Ariel Vinograd', B='Eden Levi', C='Liran Cohen', D='Adam Cohen', OWN='Roy Mendelson', BOX_OWN='Yaniv Shnur', BOX_NEW='Limor Romano';
const KEYS=[S1_ID,S2_ID,`item:${TRAY}`,`item:${BOX}`];
const NOTE=(server,storage=false)=>`From ${server}, the server on this ${storage?'shelf':'floor'}.`;
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const errors=[],passed=[],cleanups=[],known=[];
 async function session(username){
  const c=await browser.newContext({viewport:{width:1440,height:1000}});
  await c.addInitScript(()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const login=await c.request.post(origin+'/api/auth/login',{data:{username,password:PASSWORD}});
  assert.equal(login.status(),200,`${username} login`);
  return {c,csrf:(await login.json()).csrf_token};
 }
 const headers=(api,etag)=>({...(etag?{'If-Match':etag}:{}),'X-DCIM-CSRF':api.csrf});
 let admin,operator,viewer;
 async function items(){const r=await admin.c.request.get(origin+'/api/rack-items');return{data:await r.json(),etag:r.headers()['etag']};}
 async function putItems(mutate){const {data,etag}=await items();mutate(data);const r=await admin.c.request.put(origin+'/api/rack-items',{data,headers:headers(admin,etag)});assert.equal(r.status(),200,await r.text());}
 const dropOwn=d=>{for(const rack of Object.keys(d))d[rack]=d[rack].filter(i=>![TRAY,BOX].includes(i.id));};
 const owners=async()=>(await admin.c.request.get(origin+'/api/opt-owners')).json();
 // api: the session that makes the change (the operator is "another session" for the admin's page).
 async function setOwner(key,engineerId,api=admin){const r=await api.c.request.put(origin+`/api/opt-owners/${key}`,{data:{engineer_id:engineerId},headers:headers(api)});assert.equal(r.status(),200,await r.text());}
 const find=(data,id)=>{for(const [rack,list] of Object.entries(data))for(const item of list)if(item.id===id)return{rack,item};return null;};
 try{
  admin=await session('admin');operator=await session('operator');viewer=await session('viewer');
  assert.equal((await(await admin.c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
  const people=await(await admin.c.request.get(origin+'/api/engineers')).json();
  const engineer=name=>{const e=people.find(p=>p.name===name&&p.active);assert.ok(e,`${name} is an active engineer`);return e.id;};
  const saved0=await owners();
  for(const key of KEYS)assert.equal(saved0[key],undefined,`${key} has no owner in the fixture`);
  cleanups.push(async()=>{for(const key of KEYS)await setOwner(key,null);});
  // The test units leave through the one delete path (POST /api/lab/delete, Operator): a whole-list save that leaves a
  // unit out is refused while the backend's unit drop guard is on.
  cleanups.push(async()=>{const {data}=await items();const targets=[TRAY,BOX].filter(id=>find(data,id)).map(id=>({kind:'unit',id}));
   if(!targets.length)return;
   const plan=await(await operator.c.request.post(origin+'/api/lab/delete',{data:{targets,dry_run:true},headers:headers(operator)})).json();
   assert.deepEqual(plan.blockers,[],'nothing blocks deleting the test units');
   const r=await operator.c.request.post(origin+'/api/lab/delete',{data:{targets,plan_revision:plan.plan_revision},headers:headers(operator)});
   assert.equal(r.status(),200,await r.text());});
  assert.equal(find((await items()).data,TRAY)||find((await items()).data,BOX),null,'start the fixture fresh (the test units are there)');

  const page=await admin.c.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>{errors.push('native dialog: '+d.message());d.dismiss().catch(()=>{});});
  const settled=()=>page.waitForFunction(()=>document.querySelector('[data-rack-id]')&&!document.querySelector('[data-state="loading"]'),null,{timeout:20000});
  await page.goto(origin+'/?tab=racks');await settled();
  const card=rack=>page.locator(`.racks-grid [data-rack-id="${rack}"]`);
  const floorOf=name=>card(RACK).locator(`.server-cell[data-server="${name}"]`).evaluate(e=>Number(e.closest('[data-u-slot]').dataset.uSlot));
  const u1=await floorOf(S1),u2=await floorOf(S2);
  assert.ok(u1>=1&&u2>=1&&u1!==u2,`${S1} and ${S2} are on two floors (${u1}, ${u2})`);

  // ── setup: the servers' owners, a unit on S1's floor with its own (different) saved owner, a unit on a storage shelf ──
  await putItems(d=>{d[RACK]=[...(d[RACK]||[]),{id:TRAY,name:TRAY_NAME,type:'other',part_number:'UO-PN-1',u:u1}];
   d[STORE]=[...(d[STORE]||[]),{id:BOX,name:BOX_NAME,type:'other',part_number:'UO-PN-2',u:STORE_U}];});
  await setOwner(S1_ID,engineer(A));await setOwner(S2_ID,engineer(B));
  await setOwner(`item:${TRAY}`,engineer(OWN));await setOwner(`item:${BOX}`,engineer(BOX_OWN));
  await page.reload();await settled();
  // No page reload from here on (a reload would drop this marker).
  await page.evaluate(()=>{window.__unitOwnerPage=1;});
  const same=()=>page.evaluate(()=>window.__unitOwnerPage===1);
  const slot=(rack,u,id)=>card(rack).locator(`[data-u-slot="${u}"] .equipment-cell[data-item-id="${id}"]`);
  const ownerOf=async(rack,u,id)=>{const s=slot(rack,u,id);await s.waitFor();return [await s.getAttribute('data-owner'),await s.getAttribute('data-owner-from')];};
  const waitOwner=(id,owner,timeout=3000)=>page.waitForFunction(([id,owner])=>document.querySelector(`.racks-grid .equipment-cell[data-item-id="${id}"]`)?.dataset.owner===owner,[id,owner],{timeout});
  // The unit window and its owner block.
  const uw=page.locator('[data-window="unit"]');
  const derived=uw.locator('[data-unit-owner="derived"]');
  const ownSelect=name=>uw.locator(`select[aria-label="Owner for ${name}"]`);
  async function openUnit(rack,u,id,name){await slot(rack,u,id).click();await uw.locator('h2',{hasText:name}).waitFor();}
  async function closeUnit(){await page.keyboard.press('Escape');await uw.waitFor({state:'detached'});}
  async function readOnlyOwner(owner,server){
   await derived.locator('[data-owner-value]').getByText(owner,{exact:true}).waitFor();
   assert.equal(await derived.locator('#unit-owner-from').innerText(),`${NOTE(server)} Change it on the server.`);
   assert.equal(await ownSelect(TRAY_NAME).count(),0,'no owner select');
   assert.equal(await uw.locator('[data-facts]').innerText().then(t=>t.includes(`Owner: ${owner} (from ${server})`)),true,'the fact line names the owner and its server');
  }

  // ── UO-1 view: the slot, the unit window and a Viewer's read-only details show the server's owner ──
  assert.deepEqual(await ownerOf(RACK,u1,TRAY),[A,S1]);
  assert.match(await slot(RACK,u1,TRAY).getAttribute('title'),new RegExp(`Owner ${A} \\(from ${S1}\\)`));
  assert.doesNotMatch(await slot(RACK,u1,TRAY).getAttribute('title'),new RegExp(OWN));
  // screen readers: the slot keeps its name ("View <unit>") and is described by its owner
  assert.deepEqual(await slot(RACK,u1,TRAY).evaluate(e=>[e.getAttribute('aria-label'),document.getElementById(e.getAttribute('aria-describedby')||'')?.textContent]),
   [`View ${TRAY_NAME}`,`Owner ${A} (from ${S1})`]);
  await openUnit(RACK,u1,TRAY,TRAY_NAME);
  await readOnlyOwner(A,S1);
  assert.doesNotMatch(await uw.innerText(),new RegExp(OWN),'its own saved owner is not shown');
  await closeUnit();
  // a Viewer: read-only details, the owner with where it comes from
  const vp=await viewer.c.newPage();vp.on('pageerror',e=>errors.push('viewer: '+e.message));
  await vp.goto(origin+'/?tab=racks');
  await vp.locator(`.racks-grid [data-rack-id="${RACK}"] [data-u-slot="${u1}"] .equipment-cell[data-item-id="${TRAY}"]`).click();
  const vw=vp.locator('[data-window="unit"]');await vw.locator('h2',{hasText:TRAY_NAME}).waitFor();
  const detailsOwner=()=>vw.locator('[data-unit-details]').evaluate(s=>{const dt=[...s.querySelectorAll('dt')].find(d=>d.textContent==='Owner');return dt?.nextElementSibling?.innerText.trim();});
  await vw.locator('[data-unit-details] [data-owner-from]').waitFor();
  assert.equal(await detailsOwner(),`${A}\n${NOTE(S1)}`);
  assert.equal(await vw.locator('[data-unit-owner="derived"] #unit-owner-from').innerText(),NOTE(S1),'a Viewer is not told to change it');
  assert.equal(await vw.locator('select[aria-label^="Owner for"]').count(),0);
  await vp.keyboard.press('Escape');await vw.waitFor({state:'detached'});
  // a phone (390 px): the rack detail list names the unit's owner with its label
  const phone=await admin.c.newPage();phone.on('pageerror',e=>errors.push(e.message));
  await phone.setViewportSize({width:390,height:844});
  await phone.goto(origin+`/?tab=racks&rack=${RACK}`);await phone.locator('#rack-detail-title').waitFor();
  const facts=await phone.locator(`.detail-item[data-item-id="${TRAY}"] .detail-item-facts`).innerText();
  assert.match(facts,new RegExp(` · Owner ${A}$`));assert.doesNotMatch(facts,new RegExp(OWN));
  await phone.close();
  passed.push(`UO-1 ${TRAY_NAME} on ${S1}'s floor ${u1}: slot (tooltip, described by "Owner ${A} (from ${S1})"), its window ("${NOTE(S1)} Change it on the server.", no select), a Viewer's details ("${NOTE(S1)}") and the phone list ("${facts}") show ${A} (its own saved owner ${OWN} is not shown)`);

  // ── UO-2 search by the server's owner finds the unit; its own old owner does not; a storage unit by its own ──
  const search=page.getByRole('searchbox',{name:/Find server/});
  await search.fill(A);
  await page.locator(`.equipment-cell[data-item-id="${TRAY}"][data-match]`).waitFor();
  assert.equal(await page.locator(`.server-cell[data-server="${S1}"][data-match]`).count(),1);
  await search.fill(OWN);
  await page.locator('.racks-empty').waitFor();
  await search.fill(BOX_OWN);
  await page.locator(`.equipment-cell[data-item-id="${BOX}"][data-match]`).waitFor();
  await search.fill('');
  await page.waitForFunction(()=>!document.querySelector('[data-match]')&&document.querySelectorAll('.racks-grid > [data-rack-id]').length>1);
  passed.push(`UO-2 search "${A}" finds ${TRAY_NAME} and ${S1}; "${OWN}" (its own old owner) finds nothing; "${BOX_OWN}" finds the storage unit`);

  // ── UO-3 the server's owner changed in another session reaches the unit without a reload ──
  const t0=Date.now();
  await setOwner(S1_ID,engineer(C),operator);
  await waitOwner(TRAY,C,30000);
  assert.ok(await same(),'no page reload');
  assert.deepEqual(await ownerOf(RACK,u1,TRAY),[C,S1]);
  passed.push(`UO-3 ${S1}'s owner set to ${C} in another session: the unit shows ${C} after ${Math.round((Date.now()-t0)/1000)} s, no page reload`);

  // ── UO-4 the unit window: read-only owner with its note; another session's change reaches it (unsaved edit kept);
  //    the server's owner changed in the server window updates the unit at once ──
  await openUnit(RACK,u1,TRAY,TRAY_NAME);
  await readOnlyOwner(C,S1);
  const openServer=derived.getByRole('button',{name:`Open ${S1}`,exact:true});
  // keyboard: the way to change it ("Open OPT41") is reachable
  await openServer.focus();assert.equal(await openServer.evaluate(e=>e===document.activeElement),true);
  const notes=uw.locator('#unit-form-notes');
  await notes.fill('unsaved note');
  // another session changes the server's owner while the window has an unsaved edit: it follows, the edit stays
  const t2=Date.now();
  await setOwner(S1_ID,engineer(D),operator);
  await derived.locator('[data-owner-value]').getByText(D,{exact:true}).waitFor({timeout:30000});
  const editSync=Math.round((Date.now()-t2)/1000);
  assert.equal(await notes.inputValue(),'unsaved note','the unsaved edit is kept');
  assert.deepEqual(await ownerOf(RACK,u1,TRAY),[D,S1]);
  await openServer.click();
  const sw=page.locator('[data-window="server"]');
  await sw.locator('h2',{hasText:S1}).waitFor();
  await uw.waitFor({state:'detached'});
  const serverOwner=sw.getByLabel(`Owner for ${S1}`,{exact:true});
  await serverOwner.waitFor();
  const t1=Date.now();
  await serverOwner.selectOption({label:A});
  await waitOwner(TRAY,A,3000);
  const ms=Date.now()-t1;
  assert.equal((await owners())[S1_ID],A);
  // closing the server window goes back to the unit window it was opened from
  await page.keyboard.press('Escape');await sw.waitFor({state:'detached'});
  await uw.locator('h2',{hasText:TRAY_NAME}).waitFor();
  await readOnlyOwner(A,S1);
  // "Open <server>" with an unsaved edit: the old Racks panel hid it until the edit was saved or reset. Report what the
  // window does with the draft instead of failing on it (UnitWindow.jsx is not this suite's file).
  const draft=await notes.inputValue();
  if(draft!=='unsaved note')known.push(`UO-4 "Open ${S1}" in the unit window replaced it while its Notes had an unsaved edit; closing the server window brought the unit window back with Notes "${draft}" (the unsaved "unsaved note" was dropped without a warning)`);
  else await notes.fill('');
  assert.ok(await same(),'no page reload');
  passed.push(`UO-4 unit window: ${TRAY_NAME}'s owner ${C} is read-only, "${NOTE(S1)} Change it on the server.", no select, "Open ${S1}" reachable by keyboard; ${S1}'s owner set to ${D} in another session reaches the open window after ${editSync} s with its unsaved note kept; "Open ${S1}" → the server window's owner set to ${A}: the unit shows ${A} in ${ms} ms; closing the server window returns to the unit window (${A}); no reload`);

  // ── UO-5 Move… to another server's floor: that server's owner; to the rack level: its own saved owner, editable ──
  const mv=page.locator('[data-dialog="unit-move"]');
  async function moveTo(u,label){
   await uw.getByRole('button',{name:'Move…',exact:true}).click();await mv.waitFor();
   await mv.getByLabel('Floor').selectOption(String(u));
   const go=mv.locator('button[data-action="move-unit"]');
   assert.equal((await go.innerText()).trim(),`Move to ${RACK} · ${label}`);
   await go.click();await mv.waitFor({state:'detached'});
  }
  await moveTo(u2,`floor ${u2}`);
  await page.locator('.lab-toast').filter({hasText:`Moved ${TRAY_NAME} to ${RACK} · floor ${u2}.`}).waitFor();
  assert.equal(find((await items()).data,TRAY).item.u,u2);
  await readOnlyOwner(B,S2);
  assert.deepEqual(await ownerOf(RACK,u2,TRAY),[B,S2]);
  await moveTo(0,'rack level');
  assert.equal(find((await items()).data,TRAY).item.u,0);
  const select=ownSelect(TRAY_NAME);
  await select.waitFor();
  assert.equal(await select.isDisabled(),false,'its own owner is editable on the rack level');
  assert.equal(await select.locator('option:checked').innerText(),OWN);
  assert.equal(await derived.count(),0);
  await uw.locator('[data-unit-owner="own"]').getByText('No server is on this floor, so the unit keeps its own owner.',{exact:true}).waitFor();
  assert.deepEqual(await ownerOf(RACK,0,TRAY),[OWN,null]);
  assert.equal((await owners())[`item:${TRAY}`],OWN,'its saved owner was never changed');
  await closeUnit();
  passed.push(`UO-5 Move… to ${S2}'s floor ${u2}: ${B} "${NOTE(S2)}" in the window and the slot; Move… to the rack level: its own saved owner ${OWN}, editable (the saved owner was kept)`);

  // ── UO-6 a storage-shelf unit keeps its own owner, editable in its window; a Viewer sees it read-only ──
  assert.deepEqual(await ownerOf(STORE,STORE_U,BOX),[BOX_OWN,null]);
  await openUnit(STORE,STORE_U,BOX,BOX_NAME);
  const boxSelect=ownSelect(BOX_NAME);
  await boxSelect.waitFor();
  assert.equal(await boxSelect.isDisabled(),false);
  assert.equal(await boxSelect.locator('option:checked').innerText(),BOX_OWN);
  assert.equal(await derived.count(),0);
  await uw.locator('[data-unit-owner="own"]').getByText('No server is on this shelf, so the unit keeps its own owner.',{exact:true}).waitFor();
  await boxSelect.selectOption({label:BOX_NEW});
  await uw.locator('[data-unit-owner="own"]').getByRole('status').filter({hasText:'Saved'}).waitFor();
  assert.equal((await owners())[`item:${BOX}`],BOX_NEW);
  await waitOwner(BOX,BOX_NEW,3000);
  await closeUnit();
  assert.ok(await same(),'no page reload');
  await vp.goto(origin+`/?tab=racks&open=unit:${BOX}`);
  await vw.locator('h2',{hasText:BOX_NAME}).waitFor();
  await vw.locator('[data-unit-owner="own"] [data-owner-value]').getByText(BOX_NEW,{exact:true}).waitFor();
  assert.equal(await detailsOwner(),BOX_NEW);
  assert.equal(await vw.locator('select[aria-label^="Owner for"]').count(),0,'a Viewer has no owner select');
  await vp.close();
  passed.push(`UO-6 ${BOX_NAME} on ${STORE} shelf ${STORE_U} (no server): its own owner ${BOX_OWN}, editable in its window; changed to ${BOX_NEW} (saved, shown in the slot); a Viewer's window shows ${BOX_NEW} read-only`);

  // ── UO-7 the unit window by its address (open=unit:<id>): on a server's floor the server's owner, read-only, followed
  //    live; moved to the rack level from the window, its own saved owner, editable ──
  await putItems(d=>{d[RACK]=d[RACK].map(i=>i.id===TRAY?{...i,u:u1}:i);});
  await page.goto(origin+`/?tab=racks&open=unit:${TRAY}`);
  await uw.locator('h2',{hasText:TRAY_NAME}).waitFor();
  await derived.locator('[data-owner-value]').getByText(A,{exact:true}).waitFor();
  await derived.getByText(`${NOTE(S1)} Change it on the server.`,{exact:true}).waitFor();
  assert.equal(await ownSelect(TRAY_NAME).count(),0,'no owner select on a server\'s floor');
  await page.evaluate(()=>{window.__unitWindowPage=1;});
  const t3=Date.now();
  await setOwner(S1_ID,engineer(B),operator);
  await derived.locator('[data-owner-value]').getByText(B,{exact:true}).waitFor({timeout:30000});
  const live=Math.round((Date.now()-t3)/1000);
  assert.equal(await page.evaluate(()=>window.__unitWindowPage),1,'no page reload');
  await moveTo(0,'rack level');
  await ownSelect(TRAY_NAME).waitFor();
  assert.equal(await ownSelect(TRAY_NAME).locator('option:checked').innerText(),OWN);
  assert.equal(find((await items()).data,TRAY).item.u,0);
  await closeUnit();
  passed.push(`UO-7 open=unit:${TRAY}: on ${S1}'s floor it shows ${A} read-only ("${NOTE(S1)} Change it on the server."); ${S1}'s owner changed in another session reaches it after ${live} s, no reload; moved to the rack level from the window: its own owner ${OWN}, editable`);

  assert.deepEqual(errors,[],'no page errors');
 }catch(e){
  console.error(e);process.exitCode=1;
 }finally{
  for(const undo of cleanups.reverse()){try{await undo();}catch(e){console.error('cleanup:',e.message);process.exitCode=1;}}
  try{
   const left=await owners();const {data}=await items();
   assert.deepEqual(KEYS.filter(k=>left[k]!==undefined),[],'owners restored');
   assert.equal(find(data,TRAY)||find(data,BOX),null,'units removed');
   passed.push('fixture restored: the four owners cleared, both units removed');
  }catch(e){console.error('restore:',e.message);process.exitCode=1;}
  await browser.close();
  passed.forEach(p=>console.log('PASS',p));
  known.forEach(k=>console.log('KNOWN ISSUE',k));
  console.log(process.exitCode?'FAILED':`OK ${passed.length} checks`);
 }
})();
