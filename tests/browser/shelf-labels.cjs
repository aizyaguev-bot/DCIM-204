// Shelf labels on the Racks page, on the isolated fixture (tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1):
// LBL-1 a floor's label (project = the unit on the floor, owner = the server's owner, the server), Copy puts exactly its
// three lines on the clipboard, edits change only the printout, Print prints only the label sheet; LBL-2 a rack's labels
// (one per server floor) from its card and its detail; LBL-3 the toolbar dialog with "All racks" covers every rack;
// LBL-4 a storage shelf's number is its label button; LBL-5 a Viewer can open and copy; LBL-6 a 390 px phone: the dialog
// fits without page scroll. Every change it makes (an owner, two units) is undone. Only fixture data; no hardware.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin=process.env.DCIM_PREVIEW_URL||'http://127.0.0.1:9970';
const PASSWORD='test-password-123';
const TRAY='ci-shelf-label-tray', BOX='ci-shelf-label-box';
const RACK='Rack-03', OPT='OPT33', OPT_ID='opt33', OWNER='Ariel Vinograd', PRODUCT='Portia tray';
const STORE='Storage shelf', BOX_NAME='Label QA box';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const errors=[],passed=[],cleanups=[];
 async function session(username,options={}){
  const c=await browser.newContext({viewport:{width:1440,height:900},...options});
  await c.addInitScript(()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}
   // window.print opens the system print dialog; here it only counts.
   window.__printed=0;window.print=()=>{window.__printed++;};});
  await c.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const login=await c.request.post(origin+'/api/auth/login',{data:{username,password:PASSWORD}});
  assert.equal(login.status(),200,`${username} login`);
  return {c,csrf:(await login.json()).csrf_token,username};
 }
 const headers=(api,etag)=>({...(etag?{'If-Match':etag}:{}),'X-DCIM-CSRF':api.csrf});
 try{
  const admin=await session('admin'),viewer=await session('viewer');
  assert.equal((await(await admin.c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
  async function items(){const r=await admin.c.request.get(origin+'/api/rack-items');return{data:await r.json(),etag:r.headers()['etag']};}
  async function putItems(mutate){const {data,etag}=await items();mutate(data);const r=await admin.c.request.put(origin+'/api/rack-items',{data,headers:headers(admin,etag)});assert.equal(r.status(),200,await r.text());}
  const dropOwn=d=>{for(const rack of Object.keys(d))d[rack]=d[rack].filter(i=>![TRAY,BOX].includes(i.id));};
  async function setOwner(key,engineerId){const r=await admin.c.request.put(origin+`/api/opt-owners/${key}`,{data:{engineer_id:engineerId},headers:headers(admin)});assert.equal(r.status(),200,await r.text());}

  // ── setup: OPT33's owner, a named unit on its floor, a unit on a storage shelf ──
  const owners=await(await admin.c.request.get(origin+'/api/opt-owners')).json();
  assert.equal(owners[OPT_ID],undefined,`${OPT} has no owner in the fixture`);
  const engineer=(await(await admin.c.request.get(origin+'/api/engineers')).json()).find(e=>e.name===OWNER&&e.active);
  assert.ok(engineer,`${OWNER} is an active engineer`);
  cleanups.push(()=>setOwner(OPT_ID,null));
  cleanups.push(()=>putItems(dropOwn));
  await putItems(dropOwn);

  const page=await admin.c.newPage();page.on('pageerror',e=>errors.push(e.message));
  const settled=p=>p.waitForFunction(()=>document.querySelector('[data-rack-id], #rack-detail-title')&&!document.querySelector('[data-state="loading"]'),null,{timeout:20000});
  await page.goto(origin+'/?tab=racks');await settled(page);
  const card=(p,rack)=>p.locator(`[data-rack-id="${rack}"]`);
  const u=Number(await card(page,RACK).locator(`.server-cell[data-server="${OPT}"]`).evaluate(e=>e.closest('[data-u-slot]').dataset.uSlot));
  assert.ok(u>=1&&u<=4,`${OPT} is on a floor (${u})`);
  await putItems(d=>{d[RACK]=[...(d[RACK]||[]),{id:TRAY,name:PRODUCT,type:'other',u}];d[STORE]=[...(d[STORE]||[]),{id:BOX,name:'',model:BOX_NAME,type:'other',u:4}];});
  await setOwner(OPT_ID,engineer.id);
  const expected=`project: ${PRODUCT}\nowner: ${OWNER}\n${OPT}`;

  const dialogOf=p=>p.locator('[data-dialog="shelf-labels"]');
  // The Windows clipboard hands text back with CRLF line ends; the page writes LF.
  const clipboard=p=>p.evaluate(()=>navigator.clipboard.readText()).then(t=>t.split(String.fromCharCode(13,10)).join(String.fromCharCode(10)));
  async function openFloor(p,rack,n,word='floor'){
   const floor=card(p,rack).locator(`[data-u-slot="${n}"]`);
   await floor.scrollIntoViewIfNeeded();await floor.hover();
   const button=p.getByRole('button',{name:`Label for ${rack} ${word} ${n}`,exact:true});
   await button.click();await dialogOf(p).waitFor();
   return button;
  }
  const fields=async (dialog,i=0)=>{const g=dialog.locator('.shelf-label-edit').nth(i);
   return (await Promise.all(['Project','Owner','Server'].map(n=>g.getByLabel(n,{exact:true}).inputValue()))).map(v=>v||'—');};

  // ── LBL-1 a floor's label ──
  await page.reload();await settled(page);
  await card(page,RACK).locator(`[data-u-slot="${u}"] .equipment-cell[data-item-id="${TRAY}"]`).waitFor();
  // the tag keeps its place: hidden until the floor is hovered or focused (a mouse), so floors never change height
  const tag=card(page,RACK).locator(`[data-u-slot="${u}"] [data-floor-label]`);
  await page.mouse.move(0,0);
  assert.equal(await tag.evaluate(e=>getComputedStyle(e).opacity),'0','the floor tag is hidden until hover/focus');
  const heightsBefore=await card(page,RACK).locator('.rack-shelves > [data-u-slot]').evaluateAll(els=>els.map(e=>Math.round(e.getBoundingClientRect().height)));
  assert.equal(new Set(heightsBefore).size,1,`floors of ${RACK} are one height (${heightsBefore})`);
  const opener=await openFloor(page,RACK,u);
  const dialog=dialogOf(page);
  assert.equal(await dialog.getByRole('heading').innerText(),`Shelf label · ${RACK} · Floor ${u}`);
  assert.deepEqual(await fields(dialog),[PRODUCT,OWNER,OPT]);
  assert.match(await dialog.innerText(),/change only this printout; nothing is saved/);
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.action),'copy','focus starts on Copy');
  await dialog.getByRole('button',{name:'Copy',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'Copied the label (3 lines).'}).waitFor();
  assert.equal(await clipboard(page),expected,'Copy puts exactly the three lines on the clipboard');
  // an edit changes only this printout
  await dialog.getByLabel('Project',{exact:true}).fill('Portia tray B');
  await dialog.getByRole('button',{name:'Copy',exact:true}).click();
  await page.waitForFunction(()=>navigator.clipboard.readText().then(t=>t.startsWith('project: Portia tray B')));
  assert.equal(await clipboard(page),`project: Portia tray B\nowner: ${OWNER}\n${OPT}`);
  assert.equal((await items()).data[RACK].find(i=>i.id===TRAY).name,PRODUCT,'nothing is saved');
  await dialog.getByRole('button',{name:'Undo edits'}).click();
  assert.deepEqual(await fields(dialog),[PRODUCT,OWNER,OPT]);
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.action),'copy','after Undo edits focus is on Copy');
  // Print: window.print, and on paper only the label sheet
  await dialog.getByRole('button',{name:'Print',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__printed),1);
  await page.emulateMedia({media:'print'});
  const paper=await page.evaluate(()=>{
   const sheet=document.querySelector('.shelf-print-sheet');
   const visible=[...document.body.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';});
   const label=sheet.querySelector('.shelf-print-label');const server=label.querySelector('.shelf-print-server');const line=label.querySelector('.shelf-print-line');
   return {outside:visible.filter(e=>!sheet.contains(e)).map(e=>`${e.tagName}.${String(e.className).slice(0,30)}`).slice(0,5),
    labels:[...sheet.querySelectorAll('.shelf-print-label')].map(l=>l.innerText),border:getComputedStyle(label).borderTopStyle,
    serverWeight:Number(getComputedStyle(server).fontWeight),serverSize:parseFloat(getComputedStyle(server).fontSize),lineSize:parseFloat(getComputedStyle(line).fontSize),
    grid:getComputedStyle(sheet).display};
  });
  await page.emulateMedia({media:null});
  assert.deepEqual(paper.outside,[],'on paper nothing but the label sheet is visible');
  assert.deepEqual(paper.labels,[expected]);
  assert.equal(paper.border,'solid');assert.equal(paper.grid,'grid');
  assert.ok(paper.serverWeight>=700&&paper.serverSize>paper.lineSize,`the server line is bold and larger (${paper.serverWeight} ${paper.serverSize} > ${paper.lineSize})`);
  assert.equal(await page.locator('.shelf-print-sheet').evaluate(e=>getComputedStyle(e).display),'none','on screen the sheet is hidden');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  assert.equal(await opener.evaluate(e=>e===document.activeElement),true,'Escape closes and focus returns to the floor tag');
  assert.equal(await page.evaluate(()=>document.body.classList.contains('shelf-labels-open')),false);
  const heightsAfter=await card(page,RACK).locator('.rack-shelves > [data-u-slot]').evaluateAll(els=>els.map(e=>Math.round(e.getBoundingClientRect().height)));
  assert.deepEqual(heightsAfter,heightsBefore,'the tag does not change floor heights');
  passed.push(`LBL-1 ${RACK} floor ${u}: "${expected.replace(/\n/g,' / ')}", Copy = the exact three lines, edits only in the printout (Undo edits), Print = window.print with only one bordered label on paper (server bold and larger), Escape returns focus, floor heights unchanged`);

  // ── LBL-2 the rack's labels: one per server floor, from its card and its detail ──
  const rackFloors=await card(page,RACK).evaluate(c=>[...c.querySelectorAll('.rack-shelves > [data-u-slot]')].filter(f=>+f.dataset.uSlot>=1&&+f.dataset.uSlot<=4)
   .flatMap(f=>{const servers=[...f.querySelectorAll('.server-cell[data-server]')].map(s=>s.dataset.server);return servers.length?servers.map(s=>`${f.dataset.uSlot}:${s}`):f.querySelector('.equipment-cell')?[`${f.dataset.uSlot}:—`]:[];}));
  await card(page,RACK).getByRole('button',{name:`Shelf labels for ${RACK}`}).click();await dialog.waitFor();
  assert.equal(await dialog.getByRole('heading').innerText(),`Shelf labels · ${RACK}`);
  const listed=async()=>dialog.locator('.shelf-label-edit').evaluateAll(els=>els.map(e=>`${e.dataset.labelU}:${e.querySelector('input.shelf-label-server').value||'—'}`));
  assert.deepEqual(await listed(),rackFloors,'one label per server floor of the rack');
  assert.deepEqual(await fields(dialog,rackFloors.indexOf(`${u}:${OPT}`)),[PRODUCT,OWNER,OPT]);
  await dialog.getByRole('button',{name:'Copy all'}).click();
  await dialog.getByRole('status').filter({hasText:`Copied ${rackFloors.length} labels.`}).waitFor();
  const all=await clipboard(page);
  assert.equal(all.split('\n\n').length,rackFloors.length);assert.ok(all.split('\n\n').includes(expected));
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'detached'});
  await card(page,RACK).locator('.rack-card-name').click();await page.locator('#rack-detail-title').waitFor();
  await page.locator('.rack-detail-head').getByRole('button',{name:'Shelf labels'}).click();await dialog.waitFor();
  assert.deepEqual(await listed(),rackFloors,'the rack detail lists the same labels');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await page.getByRole('button',{name:'All racks'}).click();await settled(page);
  passed.push(`LBL-2 ${RACK} card and detail "Shelf labels": ${rackFloors.length} labels (${rackFloors.join(', ')}), Copy all = labels separated by a blank line`);

  // ── LBL-3 the toolbar dialog: All racks covers every rack, and each rack alone ──
  const racks=await page.locator('.racks-grid > [data-rack-id]').evaluateAll(cs=>cs.map(c=>c.dataset.rackId));
  await page.locator('button[data-action="shelf-labels"]').click();await dialog.waitFor();
  assert.equal(await dialog.getByRole('heading').innerText(),'Shelf labels');
  const select=dialog.getByLabel('Racks');
  assert.equal(await select.inputValue(),'','All racks first');
  const options=await select.locator('option').evaluateAll(os=>os.map(o=>({value:o.value,text:o.textContent})));
  assert.equal(options[0].text,'All racks');
  assert.deepEqual(options.slice(1).map(o=>o.value),racks,'every rack is a choice');
  const totalAll=await dialog.locator('.shelf-label-edit').count();
  const perRack=options.slice(1).map(o=>Number(/\((\d+)\)$/.exec(o.text)[1]));
  assert.equal(totalAll,perRack.reduce((a,b)=>a+b,0),'All racks = the sum of every rack');
  const allRacks=new Set(await dialog.locator('.shelf-label-edit').evaluateAll(els=>els.map(e=>e.dataset.labelRack)));
  for(const [i,rack] of racks.entries())if(perRack[i])assert.ok(allRacks.has(rack),`${rack} is in All racks`);
  assert.ok(allRacks.has(RACK)&&allRacks.has(STORE));
  await select.selectOption(RACK);
  assert.deepEqual(await listed(),rackFloors);
  await select.selectOption('');
  await dialog.getByRole('button',{name:'Print all'}).click();
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('.shelf-print-label').count(),totalAll);
  assert.equal(await page.locator('#root').evaluate(e=>getComputedStyle(e).display),'none');
  await page.emulateMedia({media:null});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  passed.push(`LBL-3 toolbar "Shelf labels": All racks = ${totalAll} labels over ${allRacks.size} racks (every rack with a server or unit on a floor), each rack alone, Print all = ${totalAll} labels on paper`);

  // ── LBL-4 a storage shelf: its number is the label button; the product falls back to the model ──
  const storeButton=await openFloor(page,STORE,4,'shelf');
  assert.equal(await dialog.getByRole('heading').innerText(),`Shelf label · ${STORE} · Shelf 4`);
  assert.deepEqual(await fields(dialog),[BOX_NAME,'—','—']);
  assert.equal(await storeButton.innerText(),'4');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  assert.equal(await card(page,STORE).locator('[data-u-slot="5"] [data-floor-label]').count(),0,'an empty shelf has no label button');
  passed.push('LBL-4 storage shelf 4: its number opens "Shelf label · Storage shelf · Shelf 4" (project = the unit\'s model, owner and server —); an empty shelf has none');

  // ── LBL-5 a Viewer can open and copy ──
  const vp=await viewer.c.newPage();vp.on('pageerror',e=>errors.push(`viewer: ${e.message}`));
  await vp.goto(origin+'/?tab=racks');await settled(vp);
  assert.equal(await vp.locator('[data-floor-add]').count(),0,'a Viewer has no "+"');
  await openFloor(vp,RACK,u);
  assert.deepEqual(await fields(dialogOf(vp)),[PRODUCT,OWNER,OPT]);
  await dialogOf(vp).getByRole('button',{name:'Copy',exact:true}).click();
  await dialogOf(vp).getByRole('status').filter({hasText:'Copied'}).waitFor();
  assert.equal(await clipboard(vp),expected);
  // the lab site is plain http (no Clipboard API there): the copy command does it
  await vp.evaluate(()=>navigator.clipboard.writeText('-'));
  await vp.evaluate(()=>Object.defineProperty(window,'isSecureContext',{value:false,configurable:true}));
  await dialogOf(vp).getByRole('button',{name:'Copy',exact:true}).click();
  await vp.waitForFunction(()=>navigator.clipboard.readText().then(t=>t!=='-'));
  assert.equal(await clipboard(vp),expected,'Copy without the Clipboard API (plain http)');
  assert.equal(await vp.evaluate(()=>document.activeElement?.dataset.action),'copy','focus stays on Copy');
  await vp.keyboard.press('Escape');await vp.close();
  passed.push('LBL-5 Viewer opens the floor label and copies the same three lines (Clipboard API, and the copy command as on the plain-http lab site)');

  // ── LBL-6 a 390 px phone: always-visible tags, the dialog fits without page scroll ──
  const phone=await session('viewer',{viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const pp=await phone.c.newPage();pp.on('pageerror',e=>errors.push(`phone: ${e.message}`));
  await pp.goto(origin+'/?tab=racks');await settled(pp);
  const fits=async label=>{const m=await pp.evaluate(()=>{const d=document.querySelector('[data-dialog="shelf-labels"]').getBoundingClientRect();
   return {d:{l:d.left,r:d.right,t:d.top,b:d.bottom},w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,y:scrollY};});
   assert.ok(m.d.l>=0&&m.d.r<=m.w&&m.d.t>=0&&m.d.b<=m.h,`${label}: the dialog is inside the 390 px screen (${JSON.stringify(m.d)})`);
   assert.ok(m.sw<=m.w,`${label}: no sideways page scroll (${m.sw})`);
   return m;};
  await pp.locator('button[data-action="shelf-labels"]').click();await dialogOf(pp).waitFor();
  await fits('All racks');
  for(const name of ['Copy all','Print all','Close'])assert.ok(await dialogOf(pp).getByRole('button',{name,exact:true}).isVisible(),`${name} in view`);
  await pp.keyboard.press('Escape');await dialogOf(pp).waitFor({state:'detached'});
  const rc=card(pp,RACK);
  if(await rc.getAttribute('data-collapsed')!==null)await rc.getByRole('button',{name:`Show shelves of ${RACK}`}).click();
  const ptag=rc.locator(`[data-u-slot="${u}"] [data-floor-label]`);await ptag.scrollIntoViewIfNeeded();
  assert.equal(await ptag.evaluate(e=>getComputedStyle(e).opacity),'1','on touch the floor tag is always visible');
  await ptag.click();await dialogOf(pp).waitFor();
  await fits('floor label');
  assert.deepEqual(await fields(dialogOf(pp)),[PRODUCT,OWNER,OPT]);
  await pp.keyboard.press('Escape');await phone.c.close();
  passed.push('LBL-6 390 px phone: All racks and the floor label fit the screen (no page scroll, buttons in view), the floor tag always visible on touch');

  assert.deepEqual(errors,[],'no page errors');
 }catch(e){
  console.error(e);process.exitCode=1;
 }finally{
  for(const undo of cleanups.reverse()){try{await undo();}catch(e){console.error('cleanup:',e.message);process.exitCode=1;}}
  await browser.close();
  passed.forEach(p=>console.log('PASS',p));
  console.log(process.exitCode?'FAILED':`OK ${passed.length} checks`);
 }
})();
