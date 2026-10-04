const {chromium}=require('playwright');
const assert=require('node:assert/strict');const origin='http://127.0.0.1:8770';
(async()=>{const b=await chromium.launch({headless:true,channel:'msedge'});const errors=[];try{
 const c=await b.newContext({viewport:{width:1440,height:1000}});await c.request.post(origin+'/api/auth/login',{data:{username:'admin',password:'test-password-123'}});
 assert.equal((await(await c.request.get(origin+'/api/version')).json()).version,'LOCAL PREVIEW - TEST DATA');
 const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/twin/?embed=1');await p.waitForFunction(()=>__twin?.S.live.connected&&__twin.S.recs.size>10);await p.waitForTimeout(700);
 const point=await p.evaluate(()=>{const t=__twin,canvas=document.querySelector('#c'),rect=canvas.getBoundingClientRect();for(const rec of t.S.recs.values()){if(rec.cat!=='item')continue;for(const m of rec.meshes){const q=m.getWorldPosition(new THREE.Vector3()).project(t.camera);const x=rect.left+(q.x+1)*rect.width/2,y=rect.top+(1-q.y)*rect.height/2;if(q.z>1||document.elementFromPoint(x,y)!==canvas)continue;const hit=t.pickAt({clientX:x,clientY:y});if(hit?.object.userData.id===rec.id)return{x,y,id:rec.id};}}return null;});
 assert.ok(point,'A rendered object must be clickable');const before=await p.evaluate(()=>__twin.camera.position.toArray());await p.mouse.click(point.x,point.y);await p.waitForTimeout(150);assert.equal(await p.evaluate(()=>__twin.S.selected),point.id);assert.deepEqual(await p.evaluate(()=>__twin.camera.position.toArray()),before);
 // Zoom toward a selected rack while checking the camera cannot cross a solid mesh.
 await p.locator('#vFocus').click();await p.waitForTimeout(750);for(let i=0;i<30;i++)await p.mouse.wheel(0,-400);await p.waitForTimeout(150);
 assert.equal(await p.evaluate(()=>{const t=__twin;return [...t.S.recs.values()].some(r=>r.cat==='item'&&r.meshes.some(m=>{m.geometry.computeBoundingBox();const local=m.worldToLocal(t.camera.position.clone());const box=m.geometry.boundingBox.clone();box.min.addScalar(.001);box.max.addScalar(-.001);return box.containsPoint(local);}));}),false,'Camera zoomed inside equipment');
 await p.locator('#vReset').click();await p.waitForTimeout(750);await p.locator('#btnEdit').click();
 // Exercise the real Move button then the persisted move API on temporary inventory.
 const ids=await p.evaluate(()=>{const t=__twin;const r=[...t.S.recs.values()].find(r=>r.cat==='item'&&r.item?.type==='opt'&&r.item.live?.inDcim);const target=[...t.S.recs.values()].find(s=>s.cat==='shelf'&&s.setup!==r.setup);t.select(r.id,{keepCamera:true});return{id:r.id,key:r.item.dcim.optKey,target:target.id,rack:t.S.data.setups.find(s=>s.id===target.setup).dcimRack};});
 await p.locator('#eMove').click();assert.equal(await p.evaluate(()=>__twin.S.moveItem),ids.id);
 await p.evaluate(async target=>{await __twin.finishMove(__twin.S.recs.get(target));},ids.target);
 const overrides=await(await c.request.get(origin+'/api/rack-overrides')).json();assert.equal(overrides[ids.key],ids.rack);assert.equal(await p.evaluate(()=>__twin.S.moveItem),null);assert.equal(await p.evaluate(()=>__twin.controls.enableRotate),true);
 await p.evaluate(()=>__twin.refreshStatuses());assert.equal(await p.evaluate(id=>__twin.S.recs.get(id).shelf,ids.id),ids.target);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:['mouse selects without camera jump','focused zoom does not enter equipment','explicit Move saves placement and survives refresh'],errors}));
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
