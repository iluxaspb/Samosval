const assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const server=spawn('python3',['-m','http.server','8812','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{let browser;try{
 browser=await chromium.launch({executablePath:'/tmp/tabel-chromium',args:['--no-sandbox']});
 const p=await browser.newPage({viewport:{width:393,height:852}}),errors=[];p.setDefaultTimeout(7000);p.on('pageerror',e=>errors.push(e.message));
 await p.clock.setFixedTime(new Date('2026-10-28T12:00:00+03:00'));
 await p.goto('http://127.0.0.1:8812/tests/tabel-v2/harness.html');await p.waitForFunction(()=>ready);
 await p.evaluate(async()=>{
  const {Store}=await import('/test-app/tabel-v2/store.mjs');const original=Store.prototype.open;
  Store.prototype.open=async function(){window.qaStore=this;return original.call(this);};
 });
 await p.locator('#open').click();await p.waitForFunction(()=>window.qaStore);
 await p.evaluate(async()=>{
  const D=await import('/test-app/tabel-v2/table-domain.mjs');const key='site-a/config';
  const c=D.config({id:'site-a',name:'Объект А',startDate:'2026-10-10'});
  c.equipment=[{id:'mill',name:'W205',kind:'mill',ownership:'own'},{id:'water',name:'Поливомойка',kind:'water',ownership:'own'}];c.request.equipment=['mill','water'];
  await qaStore.save(key,c,qaStore.get(key),'Config');
  for(const date of ['2026-10-27','2026-10-28']){const key='site-a/'+D.dayKey(date,'day');await qaStore.save(key,D.createDay(c,date,'day'),qaStore.get(key),'Shift');}
 });
 await p.locator('[data-view=table]').click();await p.locator('[data-view=shift]').click();
 const card=p.locator('[data-card=mill]');await card.waitFor();assert.equal(await card.count(),1);
 const layout=await card.evaluate(el=>({height:el.getBoundingClientRect().height,color:getComputedStyle(el).backgroundColor,title:getComputedStyle(el.querySelector('.tn-card-title')).fontSize}));
 assert.equal(layout.title,'17px');assert(layout.height<=130,JSON.stringify(layout));assert.notEqual(layout.color,'rgb(255, 255, 255)');
 await card.locator('[data-open]').click();
 await p.locator('[data-double-crew]').check();
 const crew=p.locator('dialog[open] input[name="site-a/day:2026-10-28:day|crewHours"]');
 await crew.click();await p.locator('[data-hour="13"]').click();assert.equal(await crew.inputValue(),'26');
 await p.locator('[data-hour="14"]').click();assert.equal(await crew.inputValue(),'28');
 const machine=p.locator('dialog[open] input[name="site-a/day:2026-10-28:day|hours"]');
 await machine.click();await p.locator('[data-hour="13"]').click();assert.equal(await machine.inputValue(),'13');
 await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
 assert.equal(await p.evaluate(()=>qaStore.get('site-a/day:2026-10-28:day').data.equipment.find(e=>e.id==='mill').crewHours),28);
 await p.locator('[data-card=water] [data-open]').click();assert.equal(await p.locator('[data-double-crew]').count(),0);await p.locator('dialog[open] footer [data-action=close]').click();
 // Force a stale editor snapshot: both choices must work directly in the first modal.
 await p.evaluate(async()=>{
  const key='site-a/day:2026-10-28:day',before=qaStore.get(key),current=structuredClone(before.data),mine=structuredClone(before.data);
  current.equipment[0].hours=10;await qaStore.save(key,current,before,'Другая правка');
  mine.equipment[0].hours=14;await qaStore.save(key,mine,before,'Мой ввод');
 });
 await p.locator('.tn-conflict-dialog[open]').waitFor();assert.match(await p.locator('.tn-conflict-dialog').innerText(),/14/);
 await p.locator('.tn-conflict-dialog [data-action=server]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
 assert.equal(await p.evaluate(()=>qaStore.get('site-a/day:2026-10-28:day').data.equipment[0].hours),10);
 // An asynchronous server response automatically opens comparison, with no navigation.
 await p.evaluate(async()=>{
  const key='site-a/day:2026-10-28:day',base=qaStore.get(key),mine=structuredClone(base.data);mine.equipment[0].hours=12;
  qaStore.remote={commit:async job=>job.key===key?({conflict:true,current:{revision:7,data:base.data,authorName:'Другой пользователь'}}):({revision:1,data:job.data})};
  await qaStore.save(key,mine,base,'Онлайн-ввод');await qaStore.flush();
 });
 await p.locator('.tn-conflict-dialog[open]').waitFor();assert.match(await p.locator('.tn-conflict-dialog').innerText(),/Другой пользователь/);
 await p.evaluate(()=>{qaStore.remote={commit:async job=>({revision:8,data:job.data})};});
 await p.locator('.tn-conflict-dialog [data-action=local]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
 assert.equal(await p.evaluate(()=>qaStore.get('site-a/day:2026-10-28:day').data.equipment[0].hours),12);
 assert.equal(await p.evaluate(()=>qaStore.state.jobs.filter(j=>j.status==='conflict').length),0);
 await p.screenshot({path:'/tmp/tabel3442-mobile.png'});
 assert.deepEqual(errors,[]);console.log('PASS 3.4.42 mobile: mill-kind x2 crew only, 13/26 and 14/28, save, non-mill exclusion, soft compact cards, automatic stale and remote conflicts, direct server/local resolution');
 }finally{await browser?.close();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1});
