// Server moves where Lab Manager cannot see every port, driven from the server window (QA 2026-11-10; one-place WP-1).
// The PDU outlet and KVM port belong to the floor; a move must never claim more than it checked.
// Checks: (1) KVM 01 does not answer and only its port 1 is saved: OPT12's window › Swap with › "OPT14" reads the KVM's
// status once, then says plainly that KVM 01 ports 2, 3 and 4 were not checked and that each server takes over the PDU
// outlet of its new floor (never "and KVM port"); Swap swaps PDU 01 outlets 2 / 4 and leaves KVM 01 alone. (2) An
// empty floor whose number has no free-labelled outlet: Move to… asks which outlet feeds it ("Spare" on outlet 1 is not
// offered as floor 4's outlet) and keeps the server's own outlet by default. (3) OPT22's window › Swap with › "OPT24":
// the preview lists the unit that moves with each server and Swap moves it in the same step (units_follow), the PDU
// outlets swap and no PDU or KVM moves.
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
  const win=p.locator('[data-window="server"]');
  const dialog=p.locator('[data-dialog="server-move"]');
  async function openServer(key,name){
   await p.goto(origin+`/?tab=racks&srv=${key}`);
   await win.locator('h2',{hasText:name}).waitFor({timeout:30000});
   await win.locator('[data-section="place"]').waitFor();
  }
  async function swapWith(name){
   await win.getByRole('button',{name:'Swap with…'}).click();
   await dialog.waitFor();
   const box=dialog.getByRole('combobox');
   await box.fill(name);
   await dialog.getByRole('option').first().waitFor();
   await box.press('Enter');
  }
  const applied=()=>p.waitForResponse(r=>r.url().endsWith('/api/devices/move-server')&&!JSON.parse(r.request().postData()||'{}').dry_run);

  // ── 1. a swap while KVM 01 does not answer ──
  {
   const statusReads=[];
   p.on('request',r=>{if(r.url().endsWith('/api/kvms/kvm1/status'))statusReads.push(Date.now());});
   await openServer('opt12','OPT12');
   const before=statusReads.length;
   await swapWith('OPT14');
   const warning=dialog.locator('p[data-unchecked=""]');
   await warning.waitFor({timeout:20000});
   assert.match(await warning.innerText(),/^Not checked: KVM 01 ports 2, 3 and 4\. This device does not answer now, so its own port names are unknown/);
   assert.match(await warning.innerText(),/check it under Consoles or Power and fix the label there\.$/,'the text points to where the label is fixed');
   assert.equal(await warning.getAttribute('role'),'alert');
   assert.ok(statusReads.length>before,'the dialog read KVM 01\'s status before warning');
   await dialog.locator('[data-action="confirm-move"]:not([disabled])').waitFor({timeout:15000});
   const note=await dialog.locator('[data-move-plan]').innerText();
   assert.match(note,/Each takes over the PDU outlet of its new floor\.$/,note);
   assert.doesNotMatch(note,/KVM port/,'never claims the KVM port it could not check');
   const plan=await dialog.locator('[data-move-preview]').innerText();
   assert.ok(plan.includes('PDU 01 outlet 2: OPT12 → OPT14')&&plan.includes('PDU 01 outlet 4: OPT14 → OPT12'),plan);
   assert.ok(!(await dialog.locator('[data-list="labels"]').innerText()).includes('KVM 01'),'no KVM 01 label change is claimed');
   const done=applied();
   await dialog.locator('[data-action="confirm-move"]').click();
   assert.equal((await done).status(),200);
   await dialog.waitFor({state:'detached'});
   const pdu1=await labelsOf('pdu1');
   assert.deepEqual([pdu1['2'],pdu1['4']],['OPT14','OPT12'],'PDU 01 outlets 2 and 4 swapped');
   assert.deepEqual(await labelsOf('kvm1'),kvmBefore,'KVM 01 labels untouched (its ports were not checked)');
   assert.deepEqual(await places(),devicePlaces,'no PDU or KVM moved');
   passed.push('1 KVM 01 down: OPT12 › Swap with › "OPT14" reads KVM 01\'s status, warns "Not checked: KVM 01 ports 2, 3 and 4" (role=alert, "fix the label there"), says each takes over the PDU outlet only; Swap swaps PDU 01 outlets 2/4, KVM 01 labels and every PDU/KVM place unchanged');
  }

  // ── 2. an empty floor whose number has no free-labelled outlet: the dialog asks ──
  {
   const r=await c.request.patch(origin+'/api/devices/pdu5/labels',{data:{1:'Spare',2:'OPT52',3:'OPT53',4:'OPT54'},headers:{'X-DCIM-CSRF':csrf}});
   assert.equal(r.status(),200,await r.text());   // OPT51 leaves Rack-05: its servers fill floors 1-3, floor 4 is free
   await openServer('opt33','OPT33');
   await win.getByRole('button',{name:'Move to…'}).click();
   await dialog.waitFor();
   await dialog.getByLabel('Rack',{exact:true}).selectOption('Rack-05');
   assert.equal(await dialog.getByLabel('Floor',{exact:true}).inputValue(),'4','the first free floor');
   const ask=dialog.locator('[data-floor-outlet]');
   const select=ask.locator('[data-feed] select');
   await select.waitFor();
   assert.equal(await select.inputValue(),'keep','"Spare" on outlet 1 is not taken as floor 4\'s outlet: it keeps its own');
   assert.match(await ask.innerText(),/Which PDU outlet feeds floor 4\?/);
   assert.match(await ask.locator('[data-outlet-hint]').innerText(),/^Not known for this floor: choose its outlet, or keep the current one\./);
   assert.ok((await select.locator('option').allInnerTexts()).some(t=>/PDU 05 · outlet 1 \(Spare\)/.test(t)),'the spare outlet can still be chosen');
   await dialog.getByRole('button',{name:'Cancel'}).click();await dialog.waitFor({state:'detached'});
   passed.push('2 an empty floor 4 with "Spare" only on outlet 1: OPT33 › Move to… Rack-05 asks "Which PDU outlet feeds floor 4?", keeps the server\'s own outlet by default and still offers PDU 05 outlet 1');
  }

  // ── 3. the server window's swap: the units move with their servers (units_follow) ──
  {
   await openServer('opt22','OPT22');
   const sent=p.waitForRequest(r=>r.url().endsWith('/api/devices/move-server')&&r.method()==='POST');
   await swapWith('OPT24');
   assert.equal((await sent).postDataJSON().units_follow,true,'the window sends units_follow');
   await dialog.locator('[data-action="confirm-move"]:not([disabled])').waitFor({timeout:15000});
   const units=dialog.locator('[data-units-follow]');
   assert.match(await units.innerText(),/Moves with it:\s*Switch 02 \(Rack-02 · floor 2 → Rack-02 · floor 4\)/);
   const done=applied();
   await dialog.locator('[data-action="confirm-move"]').click();
   const answer=await done;
   assert.equal(answer.status(),200);
   assert.equal(answer.request().postDataJSON().units_follow,true);
   const where=findItem(await get('/api/rack-items'),'ci-2');
   assert.deepEqual([where.rack,where.item.u],['Rack-02',4],'Switch 02 went to floor 4 with OPT22');
   assert.equal(where.item.tracking_history?.at(-1)?.note,'Moved with its server in DCIM or 3D Twin');
   const pdu2=await labelsOf('pdu2');
   assert.deepEqual([pdu2['2'],pdu2['4']],['OPT24','OPT22'],'PDU 02 outlets 2 and 4 swapped');
   assert.deepEqual(await places(),devicePlaces,'no PDU or KVM moved');
   passed.push('3 OPT22 › Swap with › "OPT24" sends units_follow, previews "Moves with it: Switch 02 (Rack-02 · floor 2 → Rack-02 · floor 4)", Swap moves it with a "moved" history entry, PDU 02 outlets 2/4 swap, no PDU/KVM moved');
  }
  assert.equal(errors.length,0,errors.join('\n'));
 }finally{
  console.log(JSON.stringify({passed},null,1));
  await Promise.race([browser.close(),sleep(15000)]);
 }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>process.exit());
