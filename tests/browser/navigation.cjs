const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const origin='http://127.0.0.1:8770';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const failures=[];const checks=[];
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
  await ctx.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const login=await ctx.request.post(origin+'/api/auth/login',{data:{username:'admin',password:'test-password-123'}});
  assert.equal(login.status(),200);
  assert.equal((await(await ctx.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
  const page=await ctx.newPage();page.on('pageerror',e=>failures.push(e.message));
  let writes=[];page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))writes.push(r.url());});
  await page.goto(origin+'/twin/?embed=1');
  await page.waitForFunction(()=>window.__twin?.S.live.connected&&window.__twin.S.recs.size>10);
  await page.waitForTimeout(700);
  const snapshot=()=>page.evaluate(()=>{const t=__twin;return{p:t.camera.position.toArray(),target:t.controls.target.toArray(),q:t.camera.quaternion.toArray(),distance:t.camera.position.distanceTo(t.controls.target),polar:t.controls.getPolarAngle(),min:t.controls.minDistance,max:t.controls.maxDistance,up:t.camera.up.toArray(),data:JSON.stringify(t.S.data),dirty:t.S.dirty,selected:t.S.selected,move:t.S.moveItem,edit:t.S.editMode};});
  const dist=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
  async function stable(label){await page.waitForTimeout(100);const a=await snapshot();await page.waitForTimeout(450);const b=await snapshot();assert.ok(dist(a.p,b.p)<1e-6,label+' drift');assert.ok(dist(a.target,b.target)<1e-6,label+' target drift');checks.push(label+' stops');return b;}
  let initial=await snapshot();assert.equal(initial.edit,false);assert.equal(initial.dirty,false);assert.ok(initial.distance>3);
  assert.deepEqual(initial.up,[0,1,0]);checks.push('clear initial view');
  async function box(){return page.locator('#c').boundingBox();}
  async function drag(button,dx,dy,steps=8){const b=await box();const x=b.x+b.width*.56,y=b.y+b.height*.55;await page.mouse.move(x,y);await page.mouse.down({button});await page.mouse.move(x+dx,y+dy,{steps});await page.mouse.up({button});}
  await page.mouse.move(900,450);await page.mouse.move(1000,510,{steps:20});let hover=await stable('hover');assert.ok(dist(initial.p,hover.p)<1e-6);
  await drag('left',35,15);let a=await stable('short orbit');assert.ok(dist(a.p,initial.p)>.01);assert.ok(dist(a.target,initial.target)<.001);assert.equal(a.selected,null);
  await drag('left',-250,200,35);a=await stable('long orbit');assert.ok(a.polar<=Math.PI/2-.025+1e-4);assert.ok(a.polar>=.035-1e-4);
  await page.locator('#vReset').click();await page.waitForTimeout(600);const beforePan=await snapshot();await drag('right',60,-40,15);const afterPan=await stable('screen pan');assert.ok(dist(beforePan.target,afterPan.target)>.005);assert.ok(Math.abs(beforePan.distance-afterPan.distance)<.01);
  for(let i=0;i<45;i++)await page.mouse.wheel(0,-400);a=await stable('rapid zoom in');assert.ok(a.distance>=a.min-1e-5);assert.ok(a.p.every(Number.isFinite));
  for(let i=0;i<85;i++)await page.mouse.wheel(0,400);a=await stable('rapid zoom out');assert.ok(a.distance<=a.max+1e-4);assert.ok(a.p.every(Number.isFinite));
  await page.locator('#vReset').click();await page.waitForTimeout(600);
  const b=await box();await page.mouse.move(b.x+b.width*.5,b.y+b.height*.5);await page.mouse.down();await page.mouse.move(b.x+b.width+30,b.y+b.height*.6,{steps:20});await page.mouse.up();a=await stable('release outside viewport');const outside=a.p;await page.mouse.move(b.x+b.width*.4,b.y+b.height*.4,{steps:15});assert.ok(dist(outside,(await snapshot()).p)<1e-6);
  await drag('left',30,10);await page.mouse.down();await page.mouse.move(850,560,{steps:8});await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.move(750,580,{steps:10});await page.mouse.up();await stable('window blur');
  await page.setViewportSize({width:1000,height:720});await page.waitForTimeout(200);a=await stable('resize');assert.ok(a.p.every(Number.isFinite));
  await page.locator('#vFit').click();await page.waitForTimeout(650);a=await snapshot();assert.ok(a.distance>3);checks.push('fit lab');
  const selection=await page.evaluate(()=>{const t=__twin;const r=[...t.S.recs.values()].find(r=>r.cat==='item'&&r.item?.type==='opt');t.select(r.id,{keepCamera:true});return r.id;});
  await page.waitForTimeout(200);assert.equal((await snapshot()).selected,selection);
  let same=await snapshot();await page.locator('#search').fill('OPT');await page.waitForTimeout(100);assert.ok(dist(same.p,(await snapshot()).p)<1e-6);checks.push('UI does not move camera');
  await page.locator('#search').fill('');await page.locator('#vFocus').click();await page.waitForTimeout(650);a=await snapshot();assert.ok(dist(a.p,same.p)>.01);checks.push('focus selection');
  await page.evaluate(()=>__twin.startMove(__twin.S.selected));assert.equal((await snapshot()).move,null);checks.push('read mode blocks moving');
  await page.evaluate(()=>__twin.toggleEdit());assert.equal((await snapshot()).edit,true);let data=(await snapshot()).data;await drag('left',55,30);a=await stable('edit navigation');assert.equal(a.data,data);assert.equal(a.move,null);checks.push('edit mode does not auto drag equipment');
  await page.evaluate(()=>__twin.startMove(__twin.S.selected));assert.equal((await snapshot()).move,selection);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal((await snapshot()).move,null);checks.push('explicit Move cancelled by blur');
  assert.equal((await snapshot()).data,initial.data);assert.equal(writes.length,0,'Navigation must not write inventory');assert.deepEqual(failures,[]);
  await page.locator('#vReset').click();await page.waitForTimeout(650);
  await page.screenshot({path:require('path').resolve(process.env.DCIM_QA_SCREENSHOT || require('os').tmpdir()+'/dcim-twin-navigation-qa.png')});
  console.log(JSON.stringify({passed:checks,writes,errors:failures}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
