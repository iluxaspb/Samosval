const assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE||process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const server=spawn('python3',['-m','http.server','8795','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{let browser;try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/tmp/tabel-chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const p=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.clock.setFixedTime(new Date('2026-10-29T10:00:00+03:00'));
 await p.goto('http://127.0.0.1:8795/tests/tabel-v2/harness.html');await p.waitForFunction(()=>ready);
 await p.evaluate(async()=>{
  const {Store}=await import('/test-app/tabel-v2/store.mjs');const D=await import('/test-app/tabel-v2/table-domain.mjs');
  const store=await new Store(session.projectId+'_'+session.workspaceId+'_'+session.uid,null,()=>session).open();
  const config=D.config(objects[0]);config.equipment=[{id:'mill',name:'Фреза',ownership:'own'},{id:'water',name:'Поливомойка',ownership:'own'},{id:'hired',name:'Каток',ownership:'hired'},{id:'extra',name:'Экскаватор',ownership:'hired'}];config.request.equipment=config.equipment.map(e=>e.id);
  const day=D.createDay(config,'2026-10-29');
  for(const [key,data] of [['site-a/config',config],['site-a/day:2026-10-29:day',day]]) await store.save(key,data,store.get(key),'seed');
  await store.close();session.objectId='site-a';snapshot.shift={id:'s',objectId:'site-a',startDate:'29.10.2026'};
  snapshot.trucks=[...Array.from({length:7},(_,i)=>({id:'t'+i,number:'А'+i+'ВС78'})),{id:'gai',isGAI:true}];
  snapshot.statuses=Object.fromEntries(snapshot.trucks.map(t=>[t.id,{shiftId:'s',onLine:true}]));snapshot.audit=[];
  window.updateHeader=async()=>{const {updateHeader}=await import('/test-app/tabel-v2/summary.mjs');await updateHeader(host,document.querySelector('#header-counts'));};
  await updateHeader();await openTabel();
 });
 const counts=p.locator('[data-equipment-counts]');await counts.waitFor();
 assert.match(await counts.innerText(),/Техника: 11/);assert.match(await p.locator('#header-counts').innerText(),/Техника: 11/);
 await p.evaluate(async()=>{
  const {Store}=await import('/test-app/tabel-v2/store.mjs');const store=await new Store(session.projectId+'_'+session.workspaceId+'_'+session.uid,null,()=>session).open();
  const key='site-a/day:2026-10-29:day',base=store.get(key);base.data.equipment.pop();
  await store.save(key,base.data,store.get(key),'remove equipment');await store.close();await updateHeader();
 });
 await p.waitForFunction(()=>document.querySelector('[data-equipment-counts]').textContent.includes('Техника: 10'));
 assert.match(await p.locator('#header-counts').innerText(),/Техника: 10/);
 await p.evaluate(async()=>{delete snapshot.statuses.t6;snapshot.lineAudit=[{objectId:'site-a',timestamp:Date.parse('2026-10-29T09:00:00+03:00'),history:{operations:[{collection:'truckStatus',id:'t6',before:{onLine:true,shiftId:'s'},after:null}]}}];window.dispatchEvent(new Event('line-equipment-change'));await updateHeader();});
 assert.match(await counts.innerText(),/Техника: 10/);assert.match(await p.locator('#header-counts').innerText(),/Техника: 10/);
 await p.context().setOffline(true);await p.evaluate(()=>updateHeader());assert.match(await p.locator('#header-counts').innerText(),/Техника: 10/);
 await p.evaluate(async()=>{const pending=updateHeader();session.view=false;await updateHeader();await pending;});assert.equal(await p.locator('#header-counts').isHidden(),true);
 assert.deepEqual(errors,[]);console.log('PASS mobile: common total, store update, removed truck, offline, permission revocation');
 }finally{await browser?.close();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1;});
