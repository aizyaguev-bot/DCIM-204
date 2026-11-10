const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin=process.env.DCIM_PREVIEW_URL||'http://127.0.0.1:8770';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});const errors=[];const checks=[];
 try{
  // What's new opens over the page in a fresh profile; whats-new behavior is not under test here.
  const seen=()=>{try{localStorage.setItem('dcim.seenVersion','LOCAL PREVIEW - TEST DATA');}catch{}};
  const c=await browser.newContext({viewport:{width:1440,height:1000}});await c.addInitScript(seen);
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
  async function login(page,name){await page.goto(origin);await page.getByLabel('Username',{exact:true}).fill(name);await page.getByLabel('Password',{exact:true}).fill('test-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();}
  await login(p,'admin');assert.equal((await(await c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
  const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();
  await nav(p,'Inventory');await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  const owner=p.getByLabel('Owner for OPT11',{exact:true});await owner.waitFor();await owner.locator('option[value="__current__"]').waitFor({state:'attached'});
  assert.equal(await owner.locator('option').count(),12);assert.equal(await owner.inputValue(),'__current__');checks.push('10 names and preserved legacy owner');
  await owner.selectOption({label:'Roy Mendelson'});await p.getByRole('status').filter({hasText:'Saved'}).waitFor();
  assert.equal((await(await c.request.get(origin+'/api/opt-owners')).json()).opt11,'Roy Mendelson');checks.push('owner saved');
  // Owners load after the select renders; wait for the saved owner instead of reading the first paint.
  await p.reload();await p.getByRole('button',{name:'✎ Edit',exact:true}).click();await p.getByLabel('Owner for OPT11').locator('option:checked').filter({hasText:'Roy Mendelson'}).waitFor({state:'attached'});checks.push('owner survives reload');
  await nav(p,'Admin');await p.getByRole('button',{name:'מהנדסים',exact:true}).click();await p.getByRole('heading',{name:'מהנדסים',exact:true}).waitFor();
  const row=p.getByRole('row').filter({has:p.getByText('Roy Mendelson',{exact:true})});
  await row.getByRole('button',{name:'ערוך',exact:true}).click();await p.getByLabel('שם המהנדס').fill('Roy QA Updated');await p.getByRole('button',{name:'שמור שם',exact:true}).click();
  await p.getByRole('cell',{name:'Roy QA Updated',exact:true}).waitFor();
  await nav(p,'Inventory');await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  await p.getByLabel('Owner for OPT11').locator('option:checked').filter({hasText:'Roy QA Updated'}).waitFor({state:'attached'});checks.push('rename follows assigned equipment');
  await nav(p,'Admin');await p.getByRole('button',{name:'מהנדסים',exact:true}).click();
  const updated=p.getByRole('row').filter({has:p.getByText('Roy QA Updated',{exact:true})});await updated.getByRole('button',{name:'הפוך ללא פעיל',exact:true}).click();await updated.getByRole('cell',{name:'לא פעיל',exact:true}).waitFor();
  await nav(p,'Inventory');await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  const select=p.getByLabel('Owner for OPT11');await select.locator('option:checked').filter({hasText:'Roy QA Updated · inactive'}).waitFor({state:'attached'});
  assert.equal(await select.locator('option:checked').isDisabled(),true);
  assert.equal(await p.getByLabel('Owner for OPT12').getByText('Roy QA Updated',{exact:false}).count(),0);checks.push('inactive preserves ownership and cannot be newly assigned');
  await nav(p,'Ping Monitor');await p.getByRole('button',{name:'View history for OPT11',exact:true}).click();
  const name=p.getByLabel('שם השרת לתצוגה');assert.equal(await name.getAttribute('readonly'),'');
  const automatic=p.getByRole('checkbox',{name:'סנכרון שם אוטומטי מהמלאי'});await automatic.uncheck();await name.fill('Bench display QA');await p.getByRole('button',{name:'Save settings',exact:true}).click();
  await p.getByRole('button',{name:'View history for Bench display QA',exact:true}).waitFor();
  let t=(await(await c.request.get(origin+'/api/monitoring')).json()).targets.find(t=>t.id==='t11');assert.equal(t.host,'opt11');assert.equal(t.pdu[0].port,'1');assert.equal(t.name_synced,false);checks.push('monitor manual display name preserves address and port');
  await p.getByRole('checkbox',{name:'סנכרון שם אוטומטי מהמלאי'}).check();await p.getByRole('button',{name:'Save settings',exact:true}).click();await p.getByRole('button',{name:'View history for OPT11',exact:true}).waitFor();checks.push('monitor automatic name reset');
  await p.getByRole('button',{name:'Close server details'}).click();await p.getByText('Device check failed. Network, credentials or device API may be unavailable.',{exact:true}).first().waitFor();checks.push('PDU failure detail visible in table');
  await nav(p,'3D Twin');const frame=p.frameLocator('iframe[title="3D Digital Twin"]');await frame.locator('#liveText').filter({hasText:'Live'}).waitFor();
  assert.equal(await frame.locator('#vFit').count(),1);assert.equal(await frame.locator('#vReset').count(),1);checks.push('embedded real Twin loads with recovery buttons');
  const vc=await browser.newContext({viewport:{width:1440,height:1000}});await vc.addInitScript(seen);const viewer=await vc.newPage();await login(viewer,'viewer');await nav(viewer,'Inventory');assert.equal(await viewer.locator('select[aria-label^="Owner for"]').count(),0);await nav(viewer,'Ping Monitor');await viewer.getByRole('button',{name:'View history for OPT11',exact:true}).click();assert.equal(await viewer.getByLabel('שם השרת לתצוגה').count(),0);checks.push('Viewer read only');

  // MON-1/MON-3: the details panel is brought into view and receives focus from every opener and width.
  async function monitorPage(options,setup){const ctx=await browser.newContext(options);await ctx.addInitScript(seen);await ctx.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));if(setup)await setup(page);await login(page,'admin');await nav(page,'Ping Monitor');await page.getByRole('button',{name:'View history for OPT74',exact:true}).waitFor();return {ctx,page};}
  const panel=(page,name)=>page.getByRole('complementary',{name,exact:true});
  async function revealed(page,name,label){const aside=panel(page,name);await aside.waitFor();
   const deadline=Date.now()+5000;let state;
   // Judge the resting position: a smooth scroll may still be running when the panel first enters the viewport.
   let last;do{state=await aside.evaluate(el=>{const r=el.getBoundingClientRect();return {y:r.top,h:innerHeight,sy:scrollY,focus:el.contains(document.activeElement),active:document.activeElement?.tagName};});if(state.y>=0&&state.y<state.h&&state.focus&&state.sy===last)break;last=state.sy;await page.waitForTimeout(150);}while(Date.now()<deadline);
   assert.ok(state.y>=0&&state.y<state.h,`${label}: panel top ${state.y} outside viewport ${state.h}`);assert.ok(state.focus,`${label}: focus is on ${state.active}, not in the panel`);}
  const incident=[{id:'qa-incident',target_id:'t74',name:'OPT74',rack:'Rack-07',host:'opt74',previous_up_at:null,first_failed_at:new Date(Date.now()-600000).toISOString(),last_failed_at:new Date(Date.now()-300000).toISOString(),ended_at:null,end_reason:'',failed_checks:2,observed_seconds:300}];
  for(const [width,height] of [[1440,1000],[1100,900],[390,844]]){
   // The fixture never pings, so it has no incidents; one stubbed same-origin incident row stands in for the log.
   // 390 px also covers reduced motion (instant scroll instead of smooth).
   const {ctx,page}=await monitorPage({viewport:{width,height},reducedMotion:width===390?'reduce':'no-preference'},pg=>pg.route(origin+'/api/monitoring/incidents',r=>r.fulfill({json:incident})));
   await page.getByRole('button',{name:'View history for OPT11',exact:true}).click();await revealed(page,'OPT11',`${width} first row`);
   await page.getByRole('button',{name:'Configure OPT74',exact:true}).click();await revealed(page,'OPT74',`${width} last row Details`);
   await page.getByRole('button',{name:'View history for OPT11',exact:true}).click();await revealed(page,'OPT11',`${width} first row again`);
   await page.getByRole('button',{name:'OPT74',exact:true}).click();await revealed(page,'OPT74',`${width} incident row`);
   await ctx.close();checks.push(`details panel revealed and focused at ${width}px`);
  }
  {
   const {ctx,page}=await monitorPage({viewport:{width:1440,height:1000}});
   const opener=page.getByRole('button',{name:'View history for OPT12',exact:true});await opener.focus();await page.keyboard.press('Enter');
   await revealed(page,'OPT12','keyboard open');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H2');
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Close server details');checks.push('keyboard: Enter opens, one Tab reaches Close');
   await page.keyboard.press('Escape');await panel(page,'OPT12').waitFor({state:'detached'});
   assert.equal(await opener.evaluate(el=>el===document.activeElement),true);checks.push('Escape closes and returns focus to the opener');
   await page.getByRole('button',{name:'Configure OPT12',exact:true}).click();await revealed(page,'OPT12','Details open');
   await page.getByRole('button',{name:'Close server details'}).click();await panel(page,'OPT12').waitFor({state:'detached'});
   assert.equal(await page.getByRole('button',{name:'Configure OPT12',exact:true}).evaluate(el=>el===document.activeElement),true);
   await opener.click();await revealed(page,'OPT12','reopen');await page.getByLabel('Search monitored servers').fill('OPT13');await opener.waitFor({state:'detached'});
   await page.getByRole('button',{name:'Close server details'}).click();
   assert.equal(await page.getByLabel('Search monitored servers').evaluate(el=>el===document.activeElement),true);checks.push('Close returns focus to the opener, or to search when the opener is gone');
   await ctx.close();
  }
  // DISPUTED 2: an overdue check keeps the last failed reply visible (UI only; stale is forced on a same-origin response).
  {
   const {ctx,page}=await monitorPage({viewport:{width:1440,height:1000}},pg=>pg.route(origin+'/api/monitoring',async r=>{const res=await r.fetch();const body=await res.json();for(const t of body.targets)if(['t71','t11'].includes(t.id))t.status='stale';await r.fulfill({response:res,json:body});}));
   const row=name=>page.getByRole('row').filter({has:page.getByRole('button',{name:`View history for ${name}`,exact:true})});
   await row('OPT71').getByText('Last known: No reply',{exact:true}).waitFor();assert.ok(await row('OPT71').getByText('Overdue',{exact:true}).count()>=1);
   assert.equal(await row('OPT11').getByText('Last known:',{exact:false}).count(),0);
   await row('OPT71').getByRole('button',{name:'View history for OPT71',exact:true}).click();await panel(page,'OPT71').getByText('Last known: No reply',{exact:true}).waitFor();
   await ctx.close();checks.push('overdue server keeps "Last known: No reply"');
  }
  // MON-4: two operators edit one server; polls never replace a typed address and a conflict offers both choices.
  // Polls run every 15 s; a tick is skipped while a slow response is still pending, so allow two intervals.
  const POLL=35000;
  {
   const A=await monitorPage({viewport:{width:1440,height:1000}});const Bc=await browser.newContext({viewport:{width:1440,height:1000}});await Bc.addInitScript(seen);await Bc.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
   const b=await Bc.newPage();b.on('pageerror',e=>errors.push(e.message));await login(b,'operator');await nav(b,'Ping Monitor');
   const a=A.page;await a.getByRole('button',{name:'View history for OPT13',exact:true}).click();await b.getByRole('button',{name:'View history for OPT13',exact:true}).click();
   const addrA=a.getByLabel('Address for OPT13',{exact:true}),addrB=b.getByLabel('Address for OPT13',{exact:true});
   const putOf=id=>r=>r.request().method()==='PUT'&&r.url()===`${origin}/api/monitoring/targets/${id}`;const isPut=putOf('t13');
   async function saveB(host,field=addrB,id='t13'){await field.fill(host);const [res]=await Promise.all([b.waitForResponse(putOf(id)),b.getByRole('button',{name:'Save settings',exact:true}).click()]);assert.equal(res.status(),200);await b.getByRole('button',{name:'Save settings',exact:true}).waitFor();}
   const alertA=a.getByRole('alert').filter({hasText:'Someone else changed this server'});
   await saveB('opt13-b1');await a.waitForFunction(()=>document.querySelector('input[aria-label="Address for OPT13"]')?.value==='opt13-b1',null,{timeout:POLL});
   assert.equal(await alertA.count(),0);checks.push('a clean form follows the server');
   await addrA.fill('opt13-a1');await saveB('opt13-b2');await alertA.waitFor({timeout:POLL});
   assert.equal(await addrA.inputValue(),'opt13-a1');await alertA.getByText('opt13-b2',{exact:true}).waitFor();
   assert.equal(await alertA.getByRole('button',{name:'Load current values',exact:true}).count(),1);assert.equal(await alertA.getByRole('button',{name:'Keep my changes',exact:true}).count(),1);
   assert.equal(await a.getByRole('button',{name:'Save settings',exact:true}).isDisabled(),true);checks.push('a poll keeps the typed address and shows the conflict with both choices');
   await alertA.getByRole('button',{name:'Load current values',exact:true}).click();await alertA.waitFor({state:'detached'});
   assert.equal(await addrA.inputValue(),'opt13-b2');assert.equal(await addrA.evaluate(el=>el===document.activeElement),true);checks.push('Load current values reverts the draft');
   // Right after A's poll, so the next one is ~15 s away and the save meets the server's 409.
   await a.waitForResponse(r=>r.request().method()==='GET'&&r.url()===origin+'/api/monitoring',{timeout:POLL});
   await addrA.fill('opt13-a3');await saveB('opt13-b3');
   const [rejected]=await Promise.all([a.waitForResponse(isPut),addrA.press('Enter')]);assert.equal(rejected.status(),409);
   await alertA.waitFor();assert.equal(await addrA.inputValue(),'opt13-a3');await alertA.getByText('opt13-b3',{exact:true}).waitFor();
   assert.notEqual(await a.evaluate(()=>document.activeElement?.tagName),'BODY');checks.push('a 409 keeps the draft and shows the current server values');
   await alertA.getByRole('button',{name:'Keep my changes',exact:true}).click();await alertA.waitFor({state:'detached'});
   assert.equal(await addrA.inputValue(),'opt13-a3');assert.equal(await a.getByRole('button',{name:'Save settings',exact:true}).evaluate(el=>el===document.activeElement),true);
   const [kept]=await Promise.all([a.waitForResponse(isPut),a.getByRole('button',{name:'Save settings',exact:true}).click()]);assert.equal(kept.status(),200);
   await a.getByRole('button',{name:'Save settings',exact:true}).waitFor();await a.waitForFunction(()=>document.activeElement&&document.activeElement!==document.body);
   assert.equal((await(await c.request.get(origin+'/api/monitoring')).json()).targets.find(t=>t.id==='t13').host,'opt13-a3');assert.equal(await addrA.inputValue(),'opt13-a3');
   checks.push('Keep my changes then Save returns 200 and focus stays in the form');
   // A poll that already carries the revision written by A's own running save is not someone else's change.
   await a.getByRole('button',{name:'View history for OPT23',exact:true}).click();const addr23=a.getByLabel('Address for OPT23',{exact:true});await addr23.fill('opt23-self');
   const otherNotice=a.getByRole('alert').filter({hasText:'Someone else changed this server'});assert.equal(await otherNotice.count(),0);
   await a.evaluate(()=>{window.__otherNotice=false;new MutationObserver(()=>{if([...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent.includes('Someone else changed this server')))window.__otherNotice=true;}).observe(document.body,{subtree:true,childList:true,characterData:true});});
   const row23=a.getByRole('row').filter({has:a.getByRole('button',{name:'View history for OPT23',exact:true})});let savingWhenPolled=-1;
   await a.route(origin+'/api/monitoring/targets/t23',async r=>{if(r.request().method()!=='PUT')return r.continue();const res=await r.fetch();
    // Hold the committed response until a poll has put the new address in the table while the form still says Saving.
    await row23.getByText('opt23-self',{exact:true}).waitFor({timeout:POLL});savingWhenPolled=await a.getByRole('button',{name:'Saving…',exact:true}).count();await r.fulfill({response:res});});
   const [own]=await Promise.all([a.waitForResponse(putOf('t23'),{timeout:POLL+5000}),a.getByRole('button',{name:'Save settings',exact:true}).click()]);assert.equal(own.status(),200);
   await a.getByRole('button',{name:'Save settings',exact:true}).waitFor();await a.unroute(origin+'/api/monitoring/targets/t23');
   assert.equal(savingWhenPolled,1);assert.equal(await a.evaluate(()=>window.__otherNotice),false);assert.equal(await otherNotice.count(),0);assert.equal(await addr23.inputValue(),'opt23-self');
   checks.push('a poll during the own save shows no "someone else" notice');
   // A clean form's save that meets a 409 explains the reload; typing a new value removes that notice.
   await a.getByRole('button',{name:'View history for OPT31',exact:true}).click();await b.getByRole('button',{name:'View history for OPT31',exact:true}).click();
   const addr31=a.getByLabel('Address for OPT31',{exact:true});await addr31.waitFor();
   // Right after A's poll, so A still holds the old revision when it saves.
   await a.waitForResponse(r=>r.request().method()==='GET'&&r.url()===origin+'/api/monitoring',{timeout:POLL});
   await saveB('opt31-b',b.getByLabel('Address for OPT31',{exact:true}),'t31');
   const [stale]=await Promise.all([a.waitForResponse(putOf('t31')),a.getByRole('button',{name:'Save settings',exact:true}).click()]);assert.equal(stale.status(),409);
   const reloaded=a.getByRole('alert').filter({hasText:'The form now shows the current values.'});await reloaded.waitFor();
   await a.waitForFunction(()=>document.querySelector('input[aria-label="Address for OPT31"]')?.value==='opt31-b');
   await addr31.fill('opt31-a-typing');await reloaded.waitFor({state:'detached',timeout:3000});assert.equal(await otherNotice.count(),0);assert.equal(await addr31.inputValue(),'opt31-a-typing');
   checks.push('typing after a clean-form 409 removes the reload notice');
   await A.ctx.close();await Bc.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks,errors}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
