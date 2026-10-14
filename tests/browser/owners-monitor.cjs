const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin='http://127.0.0.1:8770';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});const errors=[];const checks=[];
 try{
  const c=await browser.newContext({viewport:{width:1440,height:1000}});
  await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
  async function login(page,name){await page.goto(origin);await page.getByLabel('Username',{exact:true}).fill(name);await page.getByLabel('Password',{exact:true}).fill('test-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();}
  await login(p,'admin');assert.equal((await(await c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
  const nav=(page,name)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true}).click();
  await nav(p,'Inventory');await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  const owner=p.getByLabel('Owner for OPT11',{exact:true});await owner.waitFor();
  assert.equal(await owner.locator('option').count(),12);assert.equal(await owner.inputValue(),'__current__');checks.push('10 names and preserved legacy owner');
  await owner.selectOption({label:'Roy Mendelson'});await p.getByRole('status').filter({hasText:'נשמר'}).waitFor();
  assert.equal((await(await c.request.get(origin+'/api/opt-owners')).json()).opt11,'Roy Mendelson');checks.push('owner saved');
  await p.reload();await p.getByRole('button',{name:'✎ Edit',exact:true}).click();assert.equal(await p.getByLabel('Owner for OPT11').locator('option:checked').innerText(),'Roy Mendelson');checks.push('owner survives reload');
  await nav(p,'Admin');await p.getByRole('button',{name:'מהנדסים',exact:true}).click();await p.getByRole('heading',{name:'מהנדסים',exact:true}).waitFor();
  const row=p.getByRole('row').filter({has:p.getByText('Roy Mendelson',{exact:true})});
  await row.getByRole('button',{name:'ערוך',exact:true}).click();await p.getByLabel('שם המהנדס').fill('Roy QA Updated');await p.getByRole('button',{name:'שמור שם',exact:true}).click();
  await p.getByRole('cell',{name:'Roy QA Updated',exact:true}).waitFor();
  await nav(p,'Inventory');await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  await p.getByLabel('Owner for OPT11').locator('option:checked').filter({hasText:'Roy QA Updated'}).waitFor({state:'attached'});checks.push('rename follows assigned equipment');
  await nav(p,'Admin');await p.getByRole('button',{name:'מהנדסים',exact:true}).click();
  const updated=p.getByRole('row').filter({has:p.getByText('Roy QA Updated',{exact:true})});await updated.getByRole('button',{name:'הפוך ללא פעיל',exact:true}).click();await updated.getByRole('cell',{name:'לא פעיל',exact:true}).waitFor();
  await nav(p,'Inventory');await p.getByRole('button',{name:'✎ Edit',exact:true}).click();
  const select=p.getByLabel('Owner for OPT11');assert.equal(await select.locator('option:checked').innerText(),'Roy QA Updated · לא פעיל');
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
  const vc=await browser.newContext({viewport:{width:1440,height:1000}});const viewer=await vc.newPage();await login(viewer,'viewer');await nav(viewer,'Inventory');assert.equal(await viewer.locator('select[aria-label^="Owner for"]').count(),0);await nav(viewer,'Ping Monitor');await viewer.getByRole('button',{name:'View history for OPT11',exact:true}).click();assert.equal(await viewer.getByLabel('שם השרת לתצוגה').count(),0);checks.push('Viewer read only');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks,errors}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
