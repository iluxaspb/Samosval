const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright');
const server = spawn('python3',['-m','http.server','8831','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{
 let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/tmp/tabel-chromium',args:['--no-sandbox']});
  for (const production of [false,true]) {
   const page=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
   // Exercise the actual production modules through the same isolated host fixture.
   if(production) await page.route('**/tests/tabel-v2/harness.html',async route=>{
    const fs=require('node:fs');
    await route.fulfill({contentType:'text/html',body:fs.readFileSync('tests/tabel-v2/harness.html','utf8').replaceAll('../../test-app/tabel-v2/','../../app/tabel-v2/').replaceAll('samosval-offline','samosval-test')});
   });
   await page.goto('http://127.0.0.1:8831/tests/tabel-v2/harness.html');
   await page.waitForFunction(()=>window.ready);
   await page.evaluate(async production=>{
    const prefix=production?'/app/':'/test-app/';
    const {Store}=await import(prefix+'tabel-v2/store.mjs');
    const D=await import(prefix+'tabel-v2/table-domain.mjs');
    const open=Store.prototype.open;
    Store.prototype.open=async function(){
     await open.call(this);window.qaStore=this;
     const key='site-a/config';const c=D.config({id:'site-a',name:'Объект А',startDate:'2026-10-10'});
     c.start='2026-10-10';
     c.equipment=Array.from({length:30},(_,i)=>({id:'machine-'+i,name:i===29?'Бродвей':'Техника '+i,kind:'other',ownership:'own'}));
     await this.save(key,c,this.get(key),'QA config');
     const d=D.createDay(c,D.today(),'day');
     d.equipment=c.equipment.map(e=>({...e,hours:null,crewHours:null}));
     const dayKey='site-a/'+D.dayKey(d.date,d.shift);
     await this.save(dayKey,d,this.get(dayKey),'QA roster');
     return this;
    };
   },production);
   await page.locator('#open').click();
   await page.locator('button[data-view=shift]').click();
   const target=page.locator('[data-entity="machine-29"][data-field=hours]');
   await target.scrollIntoViewIfNeeded();
   const position=()=>page.locator('[data-shift-content]').evaluate(e=>e.scrollTop);
   const before=await position();assert(before>500);
   await target.click();
   await page.locator('dialog[open] [data-digit="5"]').click();
   await page.locator('dialog[open] [type=submit]').click();
   await page.locator('dialog[open]').waitFor({state:'hidden'});
   assert.equal(await target.textContent(),'5');
   assert(Math.abs(await position()-before)<2,'save must retain scroll');
   await target.click();
   await page.locator('dialog[open] [data-value="12"]').click();
   await page.locator('dialog[open]').waitFor({state:'hidden'});
   assert.equal(await target.textContent(),'12');
   assert(Math.abs(await position()-before)<2,'preset must retain scroll');
   await page.locator('[data-open="machine-29"]').click();
   await page.locator('.tn-five-days input:not(:disabled)').last().click();
   await page.locator('[data-hour="7"]').click();
   await page.locator('dialog[open] [type=submit]').click();
   await page.locator('dialog[open]').waitFor({state:'hidden'});
   assert(Math.abs(await position()-before)<2,'five days must retain scroll');
   await page.locator('[data-action=sync]').click();
   assert(Math.abs(await position()-before)<2,'refresh must retain scroll');
   await target.click();
   await page.locator('dialog[open] [data-action=close]').first().click();
   await page.locator('dialog[open]').waitFor({state:'hidden'});
   assert(Math.abs(await position()-before)<2,'cancel must retain scroll');
   await page.locator('[data-action=prev-date]').click();
   assert.equal(await position(),0,'new date starts at top');
   await page.locator('[data-action=next-date]').click();
   assert.equal(await position(),0);
   assert.deepEqual(errors,[]);
   console.log('PASS '+(production?'production':'test')+': 30 cards; manual/preset/five-day save, refresh, cancel preserve position; date navigation resets');
   await page.close();
  }
 } finally {await browser?.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
