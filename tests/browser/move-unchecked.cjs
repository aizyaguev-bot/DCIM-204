// Server moves where Lab Manager cannot see every port, and moves made outside the Racks page (QA 2026-11-10).
// The PDU outlet and KVM port belong to the floor; a move must never claim more than it checked.
// Checks: (1) KVM 01 does not answer and only its port 1 is saved: dragging OPT12 onto OPT14 (Racks, Edit mode) reads
// the KVM's status once, then says plainly that KVM 01 ports 2, 3 and 4 were not checked and that each server takes over
// the PDU outlet of its new floor (never "and KVM port"); Confirm swaps PDU 01 outlets 2 / 4 and leaves KVM 01 alone.
// (2) An empty floor whose number has no free-labelled outlet: the dialog asks which outlet feeds it ("Spare" on outlet 1
// is not offered as floor 4's outlet) and keeps the server's own outlet by default. (3) Locations -> Move OPT22 to
// OPT24's location: the preview lists the unit that moves with each server and Apply moves it in the same step
// (units_follow), the PDU outlets swap and no PDU or KVM moves.
//
// Fixture: tests/browser/preview-server.py with DCIM_TEST_ACCOUNTS=1 and DCIM_FIXTURE_KVM_DOWN=1 (KVM 01 unreachable;
// run_suite.sh ... DCIM_FIXTURE_KVM_DOWN=1). A fresh fixture per run: only fixture data is changed; no hardware.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin=process.env.DCIM_PREVIEW_URL||'http://127.0.0.1:8930';
const PASSWORD='test-password-123';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const errors=[],passed=[];
 try{
  const c=await browser.newContext({viewport:{width:1440,height:1300}});
  await c.addInitScript(()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  assert.equal((await(await c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA','fixture marker');
  const login=await c.request.post(origin+'/api/auth/login',{data:{username:'admin',password:PASSWORD}});
  assert.equal(login.status(),200,'admin login (DCIM_TEST_ACCOUNTS=1)');
  const csrf=(await login.json()).csrf_token;
  const get=async path=>{const r=await c.request.get(origin+path);assert.equal(r.status(),200,path);return r.json();};
  const kvmStatus=await get('/api/kvms/kvm1/status');
  assert.equal(kvmStatus.reachable,false,'KVM 01 does not answer (start the fixture with DCIM_FIXTURE_KVM_DOWN=1)');
  const devicesNow=()=>get('/api/devices/');
  const labelsOf=async id=>((await devicesNow()).find(d=>d.id===id)||{}).labels||{};
  const places=async()=>(await devicesNow()).filter(d=>d.kind==='pdu'||d.kind==='kvm').map(d=>`${d.id}:${d.rack}:${d.notes||''}`).sort();
  const devicePlaces=await places();
  const kvmBefore=await labelsOf('kvm1');
  const findItem=(doc,id)=>{for(const [rack,list] of Object.entries(doc))for(const item of list||[])if(item.id===id)return{rack,item};return null;};

  const p=await c.newPage();
  p.on('pageerror',e=>errors.push(e.message));
  p.on('dialog',d=>{errors.push(`native dialog: ${d.message()}`);d.dismiss().catch(()=>{});});
  await p.goto(origin+'/?tab=racks');
  await p.locator('[data-rack-id]').first().waitFor({timeout:30000});
  const card=rack=>p.locator(`.racks-grid [data-rack-id="${rack}"]`);
  const toggle=p.locator('button.edit-toggle');
  if(await toggle.getAttribute('aria-pressed')!=='true')await toggle.click();
  await p.waitForFunction(()=>document.querySelector('button.edit-toggle')?.getAttribute('aria-pressed')==='true');
  const dialog=p.locator('[data-dialog="server-move"]');

  // ── 1. a swap while KVM 01 does not answer ──
  {
   const statusReads=[];
   p.on('request',r=>{if(r.url().endsWith('/api/kvms/kvm1/status'))statusReads.push(Date.now());});
   const from=card('Rack-01').locator('.server-cell[data-server="OPT12"] .shelf-grip'),to=card('Rack-01').locator('.server-cell[data-server="OPT14"]');
   await from.scrollIntoViewIfNeeded();await sleep(150);
   const a=await from.boundingBox();
   await p.mouse.move(a.x+a.width/2,a.y+a.height/2);await p.mouse.down();
   await p.mouse.move(a.x+a.width/2+12,a.y+a.height/2+12,{steps:4});
   const b=await to.boundingBox();await p.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:15});
   await sleep(250);await p.mouse.up();
   await dialog.waitFor();
   const warning=dialog.locator('p[data-unchecked=""]');
   await warning.waitFor({timeout:20000});
   assert.match(await warning.innerText(),/^Not checked: KVM 01 ports 2, 3 and 4\. This device does not answer now, so its own port names are unknown/);
   assert.equal(await warning.getAttribute('role'),'alert');
   assert.ok(statusReads.length>=1,'the dialog read KVM 01\'s status before warning');
   await dialog.locator('[data-action="confirm-move"]:not([disabled])').waitFor({timeout:15000});
   const note=await dialog.locator('[data-move-plan]').innerText();
   assert.match(note,/Each takes over the PDU outlet of its new floor\.$/,note);
   assert.doesNotMatch(note,/KVM port/,'never claims the KVM port it could not check');
   const plan=await dialog.locator('[data-move-preview]').innerText();
   assert.ok(plan.includes('PDU 01 outlet 2: OPT12 → OPT14')&&plan.includes('PDU 01 outlet 4: OPT14 → OPT12'),plan);
   assert.ok(!(await dialog.locator('[data-list="labels"]').innerText()).includes('KVM 01'),'no KVM 01 label change is claimed');
   const done=p.waitForResponse(r=>r.url().endsWith('/api/devices/move-server')&&!JSON.parse(r.request().postData()||'{}').dry_run);
   await dialog.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);
   await dialog.waitFor({state:'detached'});
   const pdu1=await labelsOf('pdu1');
   assert.deepEqual([pdu1['2'],pdu1['4']],['OPT14','OPT12'],'PDU 01 outlets 2 and 4 swapped');
   assert.deepEqual(await labelsOf('kvm1'),kvmBefore,'KVM 01 labels untouched (its ports were not checked)');
   assert.deepEqual(await places(),devicePlaces,'no PDU or KVM moved');
   passed.push('1 KVM 01 down: the swap dialog reads its status, warns "Not checked: KVM 01 ports 2, 3 and 4" (role=alert), says each takes over the PDU outlet only; Confirm swaps PDU 01 outlets 2/4, KVM 01 labels and every PDU/KVM place unchanged');
  }

  // ── 2. an empty floor whose number has no free-labelled outlet: the dialog asks ──
  {
   const r=await c.request.patch(origin+'/api/devices/pdu5/labels',{data:{1:'Spare',2:'OPT52',3:'OPT53',4:'OPT54'},headers:{'X-DCIM-CSRF':csrf}});
   assert.equal(r.status(),200,await r.text());   // OPT51 leaves Rack-05: its servers fill floors 1-3, floor 4 is free
   await card('Rack-05').locator('.server-cell[data-server="OPT51"]').waitFor({state:'detached',timeout:15000});
   await card('Rack-03').locator('.server-cell[data-server="OPT33"] button.server-open').click();
   const side=p.locator('div.fixed.inset-0.z-50.flex.justify-end');await side.getByText('Remove from DCIM').waitFor();
   await side.getByLabel('Move OPT33 to rack').selectOption('Rack-05');
   await side.getByRole('button',{name:'Move…'}).click();
   await dialog.waitFor();
   assert.equal(await dialog.getByLabel('Floor',{exact:true}).inputValue(),'4','the first free floor');
   const ask=dialog.locator('[data-floor-outlet]');
   await ask.locator('select:not([disabled])').waitFor();
   assert.equal(await ask.locator('select').inputValue(),'keep','"Spare" on outlet 1 is not taken as floor 4\'s outlet: it keeps its own');
   assert.match(await ask.innerText(),/Which PDU outlet feeds floor 4\?/);
   assert.match(await ask.locator('[data-outlet-hint]').innerText(),/^Not known for this floor: choose its outlet, or keep the current one\./);
   assert.ok((await ask.locator('option').allInnerTexts()).some(t=>/PDU 05 · outlet 1 \(Spare\)/.test(t)),'the spare outlet can still be chosen');
   await dialog.getByRole('button',{name:'Cancel'}).click();await dialog.waitFor({state:'detached'});
   await p.keyboard.press('Escape');await side.waitFor({state:'detached'});
   passed.push('2 an empty floor 4 with "Spare" only on outlet 1: "Which PDU outlet feeds floor 4?" asks, keeps the server\'s own outlet by default and still offers PDU 05 outlet 1');
  }

  // ── 3. Locations -> Move: the units move with their servers (units_follow) ──
  {
   const page=await c.newPage();
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin+'/?tab=locations');
   await page.getByRole('heading',{name:'Server locations'}).waitFor();
   await page.getByRole('button',{name:'Move OPT22',exact:true}).click();
   const dlg=page.getByRole('dialog');await dlg.waitFor();
   await dlg.getByRole('radio',{name:"Another server's location"}).check();
   await dlg.locator('#move-target').selectOption('opt24');
   const sent=page.waitForRequest(r=>r.url().endsWith('/api/devices/move-server')&&r.method()==='POST');
   await dlg.getByRole('button',{name:/^Preview (changes|again)$/}).click();
   assert.equal((await sent).postDataJSON().units_follow,true,'the Locations page sends units_follow');
   const section=dlg.getByRole('region',{name:'Preview of changes'});await section.waitFor();
   const units=section.locator('[data-list="units"]');await units.waitFor();
   assert.match(await units.innerText(),/OPT22[\s\S]*Switch 02[\s\S]*Rack-02 · U2[\s\S]*Rack-02 · U4/);
   const done=page.waitForResponse(r=>r.url().endsWith('/api/devices/move-server')&&!JSON.parse(r.request().postData()||'{}').dry_run);
   await dlg.getByRole('button',{name:'Apply',exact:true}).click();
   assert.equal((await done).status(),200);
   const where=findItem(await get('/api/rack-items'),'ci-2');
   assert.deepEqual([where.rack,where.item.u],['Rack-02',4],'Switch 02 went to floor 4 with OPT22');
   assert.equal(where.item.tracking_history?.at(-1)?.note,'Moved with its server in DCIM or 3D Twin');
   const pdu2=await labelsOf('pdu2');
   assert.deepEqual([pdu2['2'],pdu2['4']],['OPT24','OPT22'],'PDU 02 outlets 2 and 4 swapped');
   assert.deepEqual(await places(),devicePlaces,'no PDU or KVM moved');
   await page.close();
   passed.push('3 Locations: Move OPT22 to OPT24\'s location sends units_follow, previews "Switch 02 Rack-02 · U2 → Rack-02 · U4", Apply moves it with a "moved" history entry, PDU 02 outlets 2/4 swap, no PDU/KVM moved');
  }
  assert.equal(errors.length,0,errors.join('\n'));
 }finally{
  console.log(JSON.stringify({passed},null,1));
  await Promise.race([browser.close(),sleep(15000)]);
 }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>process.exit());
