// A unit's owner on the Racks page (the lab owner's rule, 2026-11-10: a product on a floor belongs to whoever is
// registered on the server there; frontend/src/unitOwner.js), on the isolated fixture (tests/browser/preview-server.py
// with DCIM_TEST_ACCOUNTS=1):
// UO-1 a unit on a server's floor shows that server's owner (its slot: tooltip and accessible description; its read-only
//      details; the phone rack-detail list, labelled "Owner"), not its own saved owner;
// UO-2 search by the server's owner finds the unit, its own old owner does not; a storage unit is found by its own;
// UO-3 the server's owner changed in another session reaches the unit without a page reload;
// UO-4 Edit mode: the unit's Owner field is read-only with "From <server>, the server on this floor. Change it on the
//      server."; the server's owner changed in another session reaches the open panel (its unsaved edit kept);
//      changing the server's owner here (via "Open <server>") updates the unit at once;
// UO-5 the unit moved to another server's floor shows that server's owner; moved to the rack level (no server) its own
//      saved owner is back and editable (nothing was migrated);
// UO-6 a storage-shelf unit keeps its own owner, editable, and shows it in view mode.
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
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const errors=[],passed=[],cleanups=[];
 async function session(username){
  const c=await browser.newContext({viewport:{width:1440,height:1000}});
  await c.addInitScript(()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const login=await c.request.post(origin+'/api/auth/login',{data:{username,password:PASSWORD}});
  assert.equal(login.status(),200,`${username} login`);
  return {c,csrf:(await login.json()).csrf_token};
 }
 const headers=(api,etag)=>({...(etag?{'If-Match':etag}:{}),'X-DCIM-CSRF':api.csrf});
 let admin,operator;
 async function items(){const r=await admin.c.request.get(origin+'/api/rack-items');return{data:await r.json(),etag:r.headers()['etag']};}
 async function putItems(mutate){const {data,etag}=await items();mutate(data);const r=await admin.c.request.put(origin+'/api/rack-items',{data,headers:headers(admin,etag)});assert.equal(r.status(),200,await r.text());}
 const dropOwn=d=>{for(const rack of Object.keys(d))d[rack]=d[rack].filter(i=>![TRAY,BOX].includes(i.id));};
 const owners=async()=>(await admin.c.request.get(origin+'/api/opt-owners')).json();
 // api: the session that makes the change (the operator is "another session" for the admin's page).
 async function setOwner(key,engineerId,api=admin){const r=await api.c.request.put(origin+`/api/opt-owners/${key}`,{data:{engineer_id:engineerId},headers:headers(api)});assert.equal(r.status(),200,await r.text());}
 const find=(data,id)=>{for(const [rack,list] of Object.entries(data))for(const item of list)if(item.id===id)return{rack,item};return null;};
 try{
  admin=await session('admin');operator=await session('operator');
  assert.equal((await(await admin.c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
  const people=await(await admin.c.request.get(origin+'/api/engineers')).json();
  const engineer=name=>{const e=people.find(p=>p.name===name&&p.active);assert.ok(e,`${name} is an active engineer`);return e.id;};
  const saved0=await owners();
  for(const key of KEYS)assert.equal(saved0[key],undefined,`${key} has no owner in the fixture`);
  cleanups.push(async()=>{for(const key of KEYS)await setOwner(key,null);});
  cleanups.push(()=>putItems(dropOwn));
  await putItems(dropOwn);

  const page=await admin.c.newPage();page.on('pageerror',e=>errors.push(e.message));
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

  // ── UO-1 view mode: the slot and the read-only details show the server's owner ──
  assert.deepEqual(await ownerOf(RACK,u1,TRAY),[A,S1]);
  assert.match(await slot(RACK,u1,TRAY).getAttribute('title'),new RegExp(`Owner ${A} \\(from ${S1}\\)`));
  assert.doesNotMatch(await slot(RACK,u1,TRAY).getAttribute('title'),new RegExp(OWN));
  // screen readers: the slot keeps its name ("View <unit>") and is described by its owner
  assert.deepEqual(await slot(RACK,u1,TRAY).evaluate(e=>[e.getAttribute('aria-label'),document.getElementById(e.getAttribute('aria-describedby')||'')?.textContent]),
   [`View ${TRAY_NAME}`,`Owner ${A} (from ${S1})`]);
  const details=page.locator('section[aria-labelledby="asset-details-title"]');
  const detailsOwner=()=>details.evaluate(s=>{const dt=[...s.querySelectorAll('dt')].find(d=>d.textContent==='Owner');return dt?.nextElementSibling?.innerText.trim();});
  await slot(RACK,u1,TRAY).click();await details.waitFor();
  assert.equal(await detailsOwner(),`${A}\nFrom ${S1}, the server on this floor.`);
  await page.keyboard.press('Escape');await details.waitFor({state:'detached'});
  // a phone (390 px): the rack detail list names the unit's owner with its label
  const phone=await admin.c.newPage();phone.on('pageerror',e=>errors.push(e.message));
  await phone.setViewportSize({width:390,height:844});
  await phone.goto(origin+`/?tab=racks&rack=${RACK}`);await phone.locator('#rack-detail-title').waitFor();
  const facts=await phone.locator(`.detail-item[data-item-id="${TRAY}"] .detail-item-facts`).innerText();
  assert.match(facts,new RegExp(` · Owner ${A}$`));assert.doesNotMatch(facts,new RegExp(OWN));
  await phone.close();
  passed.push(`UO-1 ${TRAY_NAME} on ${S1}'s floor ${u1}: slot (tooltip, described by "Owner ${A} (from ${S1})"), details ("From ${S1}, the server on this floor.") and the phone list ("${facts}") show ${A} (its own saved owner ${OWN} is not shown)`);

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

  // ── UO-4 Edit mode: read-only Owner with its note; the server's owner changed here updates the unit at once ──
  await page.locator('button.edit-toggle').click();
  assert.equal(await page.locator('button.edit-toggle').getAttribute('aria-pressed'),'true');
  const panel=page.locator('div.fixed.inset-0.z-50.flex.justify-end').filter({hasText:TRAY_NAME});
  const openTray=async u=>{await slot(RACK,u,TRAY).locator('.slot-field[data-field="part_number"]').click();await panel.getByText('Save changes').waitFor();};
  const ownerField=panel.getByLabel(`Owner for ${TRAY_NAME}`,{exact:true});
  const note=panel.locator('#edit-equipment-owner-from');
  async function readOnlyOwner(owner,server){
   assert.deepEqual(await ownerField.evaluate(e=>[e.tagName,e.readOnly,e.value]),['INPUT',true,owner]);
   assert.equal(await ownerField.getAttribute('aria-describedby'),'edit-equipment-owner-from');
   assert.equal(await note.innerText(),`From ${server}, the server on this floor. Change it on the server.`);
   assert.equal(await panel.locator(`select[aria-label="Owner for ${TRAY_NAME}"]`).count(),0,'no owner select');
  }
  await openTray(u1);
  await readOnlyOwner(C,S1);
  // keyboard: the field is reachable (read-only, not disabled) and its note is its description
  await ownerField.focus();assert.equal(await ownerField.evaluate(e=>e===document.activeElement),true);
  // "Open OPT41" is offered only while the panel has nothing unsaved (it closes the panel)
  const openServer=panel.getByRole('button',{name:`Open ${S1}`,exact:true});
  assert.equal(await openServer.count(),1);
  await panel.locator('textarea').fill('unsaved note');
  assert.equal(await openServer.count(),0,'no "Open server" while an edit is unsaved');
  // another session changes the server's owner while this panel is open in Edit mode: it follows, the edit stays
  const t2=Date.now();
  await setOwner(S1_ID,engineer(D),operator);
  await page.waitForFunction(([label,owner])=>document.querySelector(`input[aria-label="${label}"]`)?.value===owner,[`Owner for ${TRAY_NAME}`,D],{timeout:30000});
  const editSync=Math.round((Date.now()-t2)/1000);
  assert.equal(await panel.locator('textarea').inputValue(),'unsaved note','the unsaved edit is kept');
  assert.deepEqual(await ownerOf(RACK,u1,TRAY),[D,S1]);
  await panel.locator('textarea').fill('');
  await openServer.click();
  const serverOwner=page.getByLabel(`Owner for ${S1}`,{exact:true});
  await serverOwner.waitFor();
  await panel.waitFor({state:'detached'});
  const t1=Date.now();
  await serverOwner.selectOption({label:A});
  await waitOwner(TRAY,A,3000);
  const ms=Date.now()-t1;
  assert.equal((await owners())[S1_ID],A);
  await page.keyboard.press('Escape');await serverOwner.waitFor({state:'detached'});
  await openTray(u1);
  await readOnlyOwner(A,S1);
  assert.ok(await same(),'no page reload');
  passed.push(`UO-4 Edit mode: Owner for ${TRAY_NAME} is a read-only field (${C}) described by "From ${S1}, the server on this floor. Change it on the server."; ${S1}'s owner set to ${D} in another session reaches the open panel after ${editSync} s with its unsaved note kept; "Open ${S1}" (hidden while an edit is unsaved) -> ${S1}'s owner set to ${A}: the unit shows ${A} in ${ms} ms, no reload`);

  // ── UO-5 moved to another server's floor: that server's owner; to the rack level: its own saved owner, editable ──
  const save=panel.getByRole('button',{name:/Save changes|Saved/});
  const uInput=panel.locator('input[aria-label="U slot"]');
  await uInput.fill(String(u2));await save.click();await panel.getByRole('button',{name:'Saved'}).waitFor();
  assert.equal(find((await items()).data,TRAY).item.u,u2);
  await readOnlyOwner(B,S2);
  assert.deepEqual(await ownerOf(RACK,u2,TRAY),[B,S2]);
  await uInput.fill('0');await save.click();await panel.getByRole('button',{name:'Saved'}).waitFor();
  assert.equal(find((await items()).data,TRAY).item.u,0);
  const select=panel.locator(`select[aria-label="Owner for ${TRAY_NAME}"]`);
  await select.waitFor();
  assert.equal(await select.isDisabled(),false,'its own owner is editable on the rack level');
  assert.equal(await select.locator('option:checked').innerText(),OWN);
  assert.equal(await note.count(),0);
  assert.deepEqual(await ownerOf(RACK,0,TRAY),[OWN,null]);
  assert.equal((await owners())[`item:${TRAY}`],OWN,'its saved owner was never changed');
  await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
  passed.push(`UO-5 moved to ${S2}'s floor ${u2}: ${B} "From ${S2}…" in the panel and the slot; moved to the rack level: its own saved owner ${OWN}, editable (the saved owner was kept)`);

  // ── UO-6 a storage-shelf unit keeps its own owner, editable ──
  assert.deepEqual(await ownerOf(STORE,STORE_U,BOX),[BOX_OWN,null]);
  const boxPanel=page.locator('div.fixed.inset-0.z-50.flex.justify-end').filter({hasText:BOX_NAME});
  await slot(STORE,STORE_U,BOX).locator('.slot-field[data-field="part_number"]').click();await boxPanel.getByText('Save changes').waitFor();
  const boxSelect=boxPanel.locator(`select[aria-label="Owner for ${BOX_NAME}"]`);
  assert.equal(await boxSelect.isDisabled(),false);
  assert.equal(await boxSelect.locator('option:checked').innerText(),BOX_OWN);
  assert.equal(await boxPanel.locator('#edit-equipment-owner-from').count(),0);
  await boxSelect.selectOption({label:BOX_NEW});
  await boxPanel.getByRole('status').filter({hasText:'Saved'}).waitFor();
  assert.equal((await owners())[`item:${BOX}`],BOX_NEW);
  await waitOwner(BOX,BOX_NEW,3000);
  await page.keyboard.press('Escape');await boxPanel.waitFor({state:'detached'});
  await page.locator('button.edit-toggle').click();
  assert.equal(await page.locator('button.edit-toggle').getAttribute('aria-pressed'),'false');
  await slot(STORE,STORE_U,BOX).click();await details.waitFor();
  assert.equal(await detailsOwner(),BOX_NEW);
  await page.keyboard.press('Escape');await details.waitFor({state:'detached'});
  assert.ok(await same(),'no page reload');
  passed.push(`UO-6 ${BOX_NAME} on ${STORE} shelf ${STORE_U} (no server): its own owner ${BOX_OWN}, editable; changed to ${BOX_NEW} (saved, shown in the slot and the view details)`);

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
  console.log(process.exitCode?'FAILED':`OK ${passed.length} checks`);
 }
})();
