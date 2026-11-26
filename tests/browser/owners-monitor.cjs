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
  // Admin's engineers page: its menu item is "Engineers" (R1 Admin menu; "מהנדסים" before it); the page stays Hebrew.
  const engineersPage=page=>page.getByRole('navigation',{name:'Administration'}).getByRole('button',{name:/^(Engineers|מהנדסים)$/}).click();
  // Manage (one-place WP-M): the owner selects are in its Servers view (Type: Servers, ?tab=inventory&type=server), in Edit mode.
  async function manageServers(page){await nav(page,'Manage');await page.getByLabel('Type',{exact:true}).selectOption('server');
   await page.waitForFunction(()=>new URL(location.href).searchParams.get('type')==='server');await page.locator('table[data-list="servers"]').waitFor();}
  await manageServers(p);await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  const owner=p.getByLabel('Owner for OPT11',{exact:true});await owner.waitFor();await owner.locator('option[value="__current__"]').waitFor({state:'attached'});
  assert.equal(await owner.locator('option').count(),12);assert.equal(await owner.inputValue(),'__current__');checks.push('10 names and preserved legacy owner');
  await owner.selectOption({label:'Roy Mendelson'});await p.getByRole('status').filter({hasText:'Saved'}).waitFor();
  assert.equal((await(await c.request.get(origin+'/api/opt-owners')).json()).opt11,'Roy Mendelson');checks.push('owner saved');
  // Owners load after the select renders; wait for the saved owner instead of reading the first paint.
  await p.reload();await p.locator('table[data-list="servers"]').waitFor();await p.getByRole('button',{name:'✎ Edit',exact:true}).click();await p.getByLabel('Owner for OPT11').locator('option:checked').filter({hasText:'Roy Mendelson'}).waitFor({state:'attached'});checks.push('owner survives reload');
  await nav(p,'Admin');await engineersPage(p);await p.getByRole('heading',{name:'מהנדסים',exact:true}).waitFor();
  const row=p.getByRole('row').filter({has:p.getByText('Roy Mendelson',{exact:true})});
  await row.getByRole('button',{name:'ערוך',exact:true}).click();await p.getByLabel('שם המהנדס').fill('Roy QA Updated');await p.getByRole('button',{name:'שמור שם',exact:true}).click();
  await p.getByRole('cell',{name:'Roy QA Updated',exact:true}).waitFor();
  await manageServers(p);await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  await p.getByLabel('Owner for OPT11').locator('option:checked').filter({hasText:'Roy QA Updated'}).waitFor({state:'attached'});checks.push('rename follows assigned equipment');
  await nav(p,'Admin');await engineersPage(p);
  const updated=p.getByRole('row').filter({has:p.getByText('Roy QA Updated',{exact:true})});await updated.getByRole('button',{name:'הפוך ללא פעיל',exact:true}).click();await updated.getByRole('cell',{name:'לא פעיל',exact:true}).waitFor();
  await manageServers(p);await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  const select=p.getByLabel('Owner for OPT11');await select.locator('option:checked').filter({hasText:'Roy QA Updated · inactive'}).waitFor({state:'attached'});
  assert.equal(await select.locator('option:checked').isDisabled(),true);
  assert.equal(await p.getByLabel('Owner for OPT12').getByText('Roy QA Updated',{exact:false}).count(),0);checks.push('inactive preserves ownership and cannot be newly assigned');
  // Ping Monitor: a server's monitor opens the server window on Activity (one-place WP-3); its settings are there.
  const win=page=>page.locator('[data-window="server"]');
  async function openRow(page,name,server){const w=win(page);if(await w.count()){await w.getByRole('button',{name:'Close',exact:true}).click();await w.waitFor({state:'detached'});}
   await page.getByRole('button',{name:`View history for ${name}`,exact:true}).click();await w.locator('h2',{hasText:server||name}).waitFor();await w.locator('[data-monitor-details]').waitFor();return w;}
  const closeWindow=async page=>{await win(page).getByRole('button',{name:'Close',exact:true}).click();await win(page).waitFor({state:'detached'});};
  const t11=async()=>(await(await c.request.get(origin+'/api/monitoring')).json()).targets.find(t=>t.id==='t11');
  await nav(p,'Ping Monitor');let sw=await openRow(p,'OPT11');
  assert.equal(new URL(p.url()).searchParams.get('sec'),'activity');assert.equal(await sw.locator('details[data-section="activity"]').evaluate(el=>el.open),true);checks.push('a server row opens its window with Activity expanded');
  const name=sw.getByLabel('Display name',{exact:true});assert.equal(await name.getAttribute('readonly'),'');
  const automatic=sw.getByRole('checkbox',{name:'Use the inventory name',exact:true});await automatic.uncheck();await name.fill('Bench display QA');await sw.getByRole('button',{name:'Save settings',exact:true}).click();
  for(let i=0;i<50&&(await t11()).name_synced!==false;i++)await p.waitForTimeout(200);
  await sw.getByLabel('Address for Bench display QA',{exact:true}).waitFor();
  let t=await t11();assert.equal(t.host,'opt11');assert.equal(t.pdu[0].port,'1');assert.equal(t.name_synced,false);assert.equal(t.name,'Bench display QA');
  await closeWindow(p);await p.getByRole('button',{name:'View history for Bench display QA',exact:true}).waitFor();checks.push('monitor manual display name preserves address and port');
  sw=await openRow(p,'Bench display QA','OPT11');await sw.getByRole('checkbox',{name:'Use the inventory name',exact:true}).check();await sw.getByRole('button',{name:'Save settings',exact:true}).click();
  for(let i=0;i<50&&(await t11()).name_synced!==true;i++)await p.waitForTimeout(200);
  await sw.getByLabel('Address for OPT11',{exact:true}).waitFor();await closeWindow(p);await p.getByRole('button',{name:'View history for OPT11',exact:true}).waitFor();checks.push('monitor automatic name reset');
  await p.getByText('Device check failed. Network, credentials or device API may be unavailable.',{exact:true}).first().waitFor();checks.push('PDU failure detail visible in table');
  await nav(p,'3D Twin');const frame=p.frameLocator('iframe[title="3D Digital Twin"]');await frame.locator('#liveText').filter({hasText:'Live'}).waitFor();
  assert.equal(await frame.locator('#vFit').count(),1);assert.equal(await frame.locator('#vReset').count(),1);checks.push('embedded real Twin loads with recovery buttons');
  const vc=await browser.newContext({viewport:{width:1440,height:1000}});await vc.addInitScript(seen);const viewer=await vc.newPage();await login(viewer,'viewer');await manageServers(viewer);await viewer.locator('tr[data-server="opt11"]').waitFor();assert.equal(await viewer.getByRole('button',{name:'✎ Edit',exact:true}).count(),0);assert.equal(await viewer.locator('select[aria-label^="Owner for"]').count(),0);await nav(viewer,'Ping Monitor');await openRow(viewer,'OPT11');assert.equal(await win(viewer).getByLabel('Display name').count(),0);assert.equal(await win(viewer).locator('[data-monitor-settings]').count(),0);checks.push('Viewer read only');

  // Monitors that are no server keep the side panel. The fixture's monitors are all servers, so two "device:" monitors
  // (no server_key) are added to the page's own GET /api/monitoring: one first, one last in the table.
  const DEVICES=[{id:'qa-dev-first',name:'Bench printer',host:'bench-printer',rack:'',server_key:null,source:'manual',status:'up',last_result:'up',enabled:true,revision:1,name_synced:true,inventory_name:'Bench printer',pdu:[],kvm:[],checked_at:null,rtt_ms:null,detail:''},
   {id:'qa-dev-last',name:'Zz lab router',host:'zz-router',rack:'',server_key:null,source:'manual',status:'up',last_result:'up',enabled:true,revision:1,name_synced:true,inventory_name:'Zz lab router',pdu:[],kvm:[],checked_at:null,rtt_ms:null,detail:''}];
  const withDeviceRows=body=>{body.targets=[DEVICES[0],...body.targets,DEVICES[1]];return body;};
  async function withDevices(page){await page.route(origin+'/api/monitoring',async r=>{if(r.request().method()!=='GET')return r.continue();const res=await r.fetch();await r.fulfill({response:res,json:withDeviceRows(await res.json())});});
   await page.route(u=>u.pathname.startsWith('/api/monitoring/targets/qa-dev-'),r=>r.fulfill({json:[]}));}

  // MON-1/MON-3: the details panel is brought into view and receives focus from every opener and width.
  async function monitorPage(options,setup){const ctx=await browser.newContext(options);await ctx.addInitScript(seen);await ctx.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));if(setup)await setup(page);else await withDevices(page);await login(page,'admin');await nav(page,'Ping Monitor');await page.getByRole('button',{name:'View history for Zz lab router',exact:true}).waitFor();return {ctx,page};}
  const panel=(page,name)=>page.getByRole('complementary',{name,exact:true});
  async function revealed(page,name,label){const aside=panel(page,name);await aside.waitFor();
   const deadline=Date.now()+5000;let state;
   // Judge the resting position: a smooth scroll may still be running when the panel first enters the viewport.
   let last;do{state=await aside.evaluate(el=>{const r=el.getBoundingClientRect();return {y:r.top,h:innerHeight,sy:scrollY,focus:el.contains(document.activeElement),active:document.activeElement?.tagName};});if(state.y>=0&&state.y<state.h&&state.focus&&state.sy===last)break;last=state.sy;await page.waitForTimeout(150);}while(Date.now()<deadline);
   assert.ok(state.y>=0&&state.y<state.h,`${label}: panel top ${state.y} outside viewport ${state.h}`);assert.ok(state.focus,`${label}: focus is on ${state.active}, not in the panel`);}
  const incident=[{id:'qa-incident',target_id:'qa-dev-last',name:'Zz lab router',rack:'',host:'zz-router',previous_up_at:null,first_failed_at:new Date(Date.now()-600000).toISOString(),last_failed_at:new Date(Date.now()-300000).toISOString(),ended_at:null,end_reason:'',failed_checks:2,observed_seconds:300}];
  for(const [width,height] of [[1440,1000],[1100,900],[390,844]]){
   // The fixture never pings, so it has no incidents; one stubbed same-origin incident row stands in for the log.
   // 390 px also covers reduced motion (instant scroll instead of smooth).
   const {ctx,page}=await monitorPage({viewport:{width,height},reducedMotion:width===390?'reduce':'no-preference'},async pg=>{await withDevices(pg);await pg.route(origin+'/api/monitoring/incidents',r=>r.fulfill({json:incident}));});
   await page.getByRole('button',{name:'View history for Bench printer',exact:true}).click();await revealed(page,'Bench printer',`${width} first row`);
   await page.getByRole('button',{name:'Configure Zz lab router',exact:true}).click();await revealed(page,'Zz lab router',`${width} last row Details`);
   await page.getByRole('button',{name:'View history for Bench printer',exact:true}).click();await revealed(page,'Bench printer',`${width} first row again`);
   await page.getByRole('button',{name:'Zz lab router',exact:true}).click();await revealed(page,'Zz lab router',`${width} incident row`);
   assert.equal(await win(page).count(),0,'no server window for a monitor that is no server');
   await page.unrouteAll({behavior:'ignoreErrors'});await ctx.close();checks.push(`details panel revealed and focused at ${width}px`);
  }
  {
   const {ctx,page}=await monitorPage({viewport:{width:1440,height:1000}});
   const opener=page.getByRole('button',{name:'View history for Bench printer',exact:true});await opener.focus();await page.keyboard.press('Enter');
   await revealed(page,'Bench printer','keyboard open');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H2');
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Close server details');checks.push('keyboard: Enter opens, one Tab reaches Close');
   await page.keyboard.press('Escape');await panel(page,'Bench printer').waitFor({state:'detached'});
   assert.equal(await opener.evaluate(el=>el===document.activeElement),true);checks.push('Escape closes and returns focus to the opener');
   await page.getByRole('button',{name:'Configure Bench printer',exact:true}).click();await revealed(page,'Bench printer','Details open');
   await page.getByRole('button',{name:'Close server details'}).click();await panel(page,'Bench printer').waitFor({state:'detached'});
   assert.equal(await page.getByRole('button',{name:'Configure Bench printer',exact:true}).evaluate(el=>el===document.activeElement),true);
   await opener.click();await revealed(page,'Bench printer','reopen');await page.getByLabel('Search monitored servers').fill('OPT13');await opener.waitFor({state:'detached'});
   await page.getByRole('button',{name:'Close server details'}).click();
   assert.equal(await page.getByLabel('Search monitored servers').evaluate(el=>el===document.activeElement),true);checks.push('Close returns focus to the opener, or to search when the opener is gone');
   // A server row by keyboard: Enter opens its window, Escape closes it and focus returns to the row.
   await page.getByLabel('Search monitored servers').fill('');const row12=page.getByRole('button',{name:'View history for OPT12',exact:true});await row12.focus();await page.keyboard.press('Enter');
   await win(page).locator('h2',{hasText:'OPT12'}).waitFor();await page.keyboard.press('Escape');await win(page).waitFor({state:'detached'});
   await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='View history for OPT12');checks.push('a server row by keyboard: Enter opens its window, Escape returns focus to the row');
   await page.unrouteAll({behavior:'ignoreErrors'});await ctx.close();
  }
  // DISPUTED 2: an overdue check keeps the last failed reply visible (UI only; stale is forced on a same-origin response).
  {
   const {ctx,page}=await monitorPage({viewport:{width:1440,height:1000}},pg=>pg.route(origin+'/api/monitoring',async r=>{if(r.request().method()!=='GET')return r.continue();const res=await r.fetch();const body=await res.json();for(const t of body.targets)if(['t71','t11'].includes(t.id))t.status='stale';await r.fulfill({response:res,json:withDeviceRows(body)});}));
   const row=name=>page.getByRole('row').filter({has:page.getByRole('button',{name:`View history for ${name}`,exact:true})});
   await row('OPT71').getByText('Last known: No reply',{exact:true}).waitFor();assert.ok(await row('OPT71').getByText('Overdue',{exact:true}).count()>=1);
   assert.equal(await row('OPT11').getByText('Last known:',{exact:false}).count(),0);
   await row('OPT71').getByRole('button',{name:'View history for OPT71',exact:true}).click();await win(page).locator('[data-monitor-details]').getByText('Last known: No reply',{exact:true}).waitFor();
   await page.unrouteAll({behavior:'ignoreErrors'});await ctx.close();checks.push('overdue server keeps "Last known: No reply" (table and window)');
  }
  // MON-4: two operators edit one server in its window; new data never replaces a typed address and a conflict offers
  // both choices. The window follows the change feed (seconds); holding a page's feed (/api/changes) holds its data, as
  // a slow poll did, so its save meets the server's 409. The page behind the window still polls every 15 s.
  const POLL=35000;
  {
   const A=await monitorPage({viewport:{width:1440,height:1000}});const Bc=await browser.newContext({viewport:{width:1440,height:1000}});await Bc.addInitScript(seen);await Bc.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
   const b=await Bc.newPage();b.on('pageerror',e=>errors.push(e.message));await login(b,'operator');await nav(b,'Ping Monitor');
   const a=A.page;const wa=win(a),wb=win(b);await openRow(a,'OPT13');await openRow(b,'OPT13');
   const holdFeed=async(page,on)=>{if(on)await page.route(origin+'/api/changes',r=>r.abort());else await page.unroute(origin+'/api/changes');};
   const addrA=wa.getByLabel('Address for OPT13',{exact:true}),addrB=wb.getByLabel('Address for OPT13',{exact:true});
   const putOf=id=>r=>r.request().method()==='PUT'&&r.url()===`${origin}/api/monitoring/targets/${id}`;const isPut=putOf('t13');
   async function saveB(host,field=addrB,id='t13'){await field.fill(host);const [res]=await Promise.all([b.waitForResponse(putOf(id)),wb.getByRole('button',{name:'Save settings',exact:true}).click()]);assert.equal(res.status(),200);await wb.getByRole('button',{name:'Save settings',exact:true}).waitFor();}
   const alertA=wa.getByRole('alert').filter({hasText:'Someone else changed this server'});
   await saveB('opt13-b1');await a.waitForFunction(()=>document.querySelector('input[aria-label="Address for OPT13"]')?.value==='opt13-b1',null,{timeout:POLL});
   assert.equal(await alertA.count(),0);checks.push('a clean form follows the server');
   await addrA.fill('opt13-a1');await saveB('opt13-b2');await alertA.waitFor({timeout:POLL});
   assert.equal(await addrA.inputValue(),'opt13-a1');await alertA.getByText('opt13-b2',{exact:true}).waitFor();
   assert.equal(await alertA.getByRole('button',{name:'Load current values',exact:true}).count(),1);assert.equal(await alertA.getByRole('button',{name:'Keep my changes',exact:true}).count(),1);
   assert.equal(await wa.getByRole('button',{name:'Save settings',exact:true}).isDisabled(),true);checks.push('new data keeps the typed address and shows the conflict with both choices');
   await alertA.getByRole('button',{name:'Load current values',exact:true}).click();await alertA.waitFor({state:'detached'});
   assert.equal(await addrA.inputValue(),'opt13-b2');assert.equal(await addrA.evaluate(el=>el===document.activeElement),true);checks.push('Load current values reverts the draft');
   // A's data is held, so its save meets the server's 409.
   await holdFeed(a,true);
   await addrA.fill('opt13-a3');await saveB('opt13-b3');
   const [rejected]=await Promise.all([a.waitForResponse(isPut),addrA.press('Enter')]);assert.equal(rejected.status(),409);
   await alertA.waitFor();assert.equal(await addrA.inputValue(),'opt13-a3');await alertA.getByText('opt13-b3',{exact:true}).waitFor();
   assert.notEqual(await a.evaluate(()=>document.activeElement?.tagName),'BODY');checks.push('a 409 keeps the draft and shows the current server values');
   await holdFeed(a,false);
   await alertA.getByRole('button',{name:'Keep my changes',exact:true}).click();await alertA.waitFor({state:'detached'});
   assert.equal(await addrA.inputValue(),'opt13-a3');assert.equal(await wa.getByRole('button',{name:'Save settings',exact:true}).evaluate(el=>el===document.activeElement),true);
   const [kept]=await Promise.all([a.waitForResponse(isPut),wa.getByRole('button',{name:'Save settings',exact:true}).click()]);assert.equal(kept.status(),200);
   await wa.getByRole('button',{name:'Save settings',exact:true}).waitFor();await a.waitForFunction(()=>document.activeElement&&document.activeElement!==document.body);
   assert.equal((await(await c.request.get(origin+'/api/monitoring')).json()).targets.find(t=>t.id==='t13').host,'opt13-a3');assert.equal(await addrA.inputValue(),'opt13-a3');
   checks.push('Keep my changes then Save returns 200 and focus stays in the form');
   // New data that already carries the revision written by A's own running save is not someone else's change: the
   // save's response is held until the page behind the window has polled the new address.
   await openRow(a,'OPT23');const addr23=wa.getByLabel('Address for OPT23',{exact:true});await addr23.fill('opt23-self');
   const otherNotice=wa.getByRole('alert').filter({hasText:'Someone else changed this server'});assert.equal(await otherNotice.count(),0);
   await a.evaluate(()=>{window.__otherNotice=false;new MutationObserver(()=>{if([...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent.includes('Someone else changed this server')))window.__otherNotice=true;}).observe(document.body,{subtree:true,childList:true,characterData:true});});
   const row23=a.locator('tr',{has:a.locator('button[aria-label="View history for OPT23"]')});let savingWhenPolled=-1;
   await a.route(origin+'/api/monitoring/targets/t23',async r=>{if(r.request().method()!=='PUT')return r.continue();const res=await r.fetch();
    // Hold the committed response until a poll has put the new address in the table while the form still says Saving.
    await row23.getByText('opt23-self',{exact:true}).waitFor({timeout:POLL});savingWhenPolled=await wa.getByRole('button',{name:'Saving…',exact:true}).count();await r.fulfill({response:res});});
   const [own]=await Promise.all([a.waitForResponse(putOf('t23'),{timeout:POLL+5000}),wa.getByRole('button',{name:'Save settings',exact:true}).click()]);assert.equal(own.status(),200);
   await wa.getByRole('button',{name:'Save settings',exact:true}).waitFor();await a.unroute(origin+'/api/monitoring/targets/t23');
   await a.waitForTimeout(2500);   // the change feed's reload after the save
   assert.equal(savingWhenPolled,1);assert.equal(await a.evaluate(()=>window.__otherNotice),false);assert.equal(await otherNotice.count(),0);assert.equal(await addr23.inputValue(),'opt23-self');
   checks.push('new data during the own save shows no "someone else" notice');
   // A clean form's save that meets a 409 explains the reload; typing a new value removes that notice.
   await openRow(a,'OPT31');await openRow(b,'OPT31');
   const addr31=wa.getByLabel('Address for OPT31',{exact:true});await addr31.waitFor();
   await holdFeed(a,true);
   await saveB('opt31-b',wb.getByLabel('Address for OPT31',{exact:true}),'t31');
   const [stale]=await Promise.all([a.waitForResponse(putOf('t31')),wa.getByRole('button',{name:'Save settings',exact:true}).click()]);assert.equal(stale.status(),409);
   const reloaded=wa.getByRole('alert').filter({hasText:'The form now shows the current values.'});await reloaded.waitFor();
   await a.waitForFunction(()=>document.querySelector('input[aria-label="Address for OPT31"]')?.value==='opt31-b');
   await addr31.fill('opt31-a-typing');await reloaded.waitFor({state:'detached',timeout:3000});assert.equal(await otherNotice.count(),0);assert.equal(await addr31.inputValue(),'opt31-a-typing');
   await holdFeed(a,false);
   checks.push('typing after a clean-form 409 removes the reload notice');
   await a.unrouteAll({behavior:'ignoreErrors'});await A.ctx.close();await Bc.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks,errors}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
