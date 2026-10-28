const {spawn}=require('node:child_process'), assert=require('node:assert/strict');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const server=spawn('python3',['-m','http.server','8820','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{let browser;try{
 browser=await chromium.launch({executablePath:'/tmp/tabel-chromium',args:['--no-sandbox']});
 const p=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
 const errors=[];p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(8000);
 await p.clock.setFixedTime(new Date('2026-10-28T12:00:00+03:00'));
 await p.goto('http://127.0.0.1:8820/tests/tabel-v2/harness.html');await p.waitForFunction(()=>ready);
 await p.evaluate(async()=>{const {Store}=await import('/test-app/tabel-v2/store.mjs'),open=Store.prototype.open;Store.prototype.open=async function(){window.qaStore=this;return open.call(this)};});
 await p.locator('#open').click();await p.locator('[data-view=table]').click();
 const action=a=>p.locator(`[data-action="${a}"]`),cell=k=>p.locator(`[data-cell="${k}"]`),editor=p.locator('[data-editor]');
 await action('new-sheet').click();await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
 await cell('A1').tap();assert.equal(await editor.evaluate(e=>document.activeElement===e),true);
 await editor.fill('5');await editor.press('Enter');await p.waitForFunction(()=>document.querySelector('[data-cell=A1]').textContent==='5');
 await cell('A2').tap();await editor.fill('7');await editor.press('Enter');await p.waitForFunction(()=>document.querySelector('[data-cell=A2]').textContent==='7');
 await cell('B1').tap();await p.waitForFunction(()=>document.querySelector('[data-range]').value==='B1');
 await p.locator('[data-symbol="="]').tap();await editor.pressSequentially('су');
 await p.locator('[data-action=suggest-formula]').waitFor();await p.locator('[data-action=suggest-formula]').tap();assert.equal(await editor.inputValue(),'=SUM(');
 const before=await p.evaluate(()=>JSON.stringify(qaStore.list('site-a/sheet:').map(r=>r.data)));
 await cell('A1').tap();assert.equal(await editor.inputValue(),'=SUM(A1)');
 assert.equal(await p.locator('[data-range]').inputValue(),'B1');
 const cdp=await p.context().newCDPSession(p);
 const gesture=async(a,z)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+(z.x-a.x)*i/8,y:a.y+(z.y-a.y)*i/8}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
 const handle=await p.locator('.tn-reference-handle').boundingBox(),target=await cell('A2').boundingBox();
 await gesture({x:handle.x+handle.width/2,y:handle.y+handle.height/2},{x:target.x+target.width/2,y:target.y+target.height/2});
 assert.equal(await editor.inputValue(),'=SUM(A1:A2)');assert.equal(await p.locator('[data-range]').inputValue(),'B1');
 assert.equal(await p.evaluate(()=>JSON.stringify(qaStore.list('site-a/sheet:').map(r=>r.data))),before);
 await editor.press('Enter');await p.waitForFunction(()=>document.querySelector('[data-cell=B1]').textContent==='12');
 // Generic operand insertion preserves trailing syntax, destination and existing arguments.
 await cell('B2').tap();await editor.fill('=(+10)');await editor.evaluate(e=>e.setSelectionRange(2,2));await cell('A1').tap();assert.equal(await editor.inputValue(),'=(A1+10)');await editor.press('Enter');await p.waitForFunction(()=>document.querySelector('[data-cell=B2]').textContent==='15');
 await cell('C1').tap();await editor.fill('=OTHER(');await cell('A1').tap();assert.equal(await editor.inputValue(),'=OTHER(A1)');assert.equal(await p.locator('[data-range]').inputValue(),'C1');await editor.press('Escape');
 // Native panning still works while a formula is awaiting a reference.
 await cell('D1').tap();await editor.fill('=SUM(');const scroll=p.locator('.tn-grid-scroll'),box=await scroll.boundingBox();
 await gesture({x:box.x+box.width-30,y:box.y+box.height-40},{x:box.x+35,y:box.y+50});
 await p.waitForFunction(()=>{const e=document.querySelector('.tn-grid-scroll');return e.scrollLeft>0&&e.scrollTop>0});assert.equal(await editor.inputValue(),'=SUM(');
 // Visual viewport emulates keyboard overlay, then resize behavior used on Android.
 await editor.focus();await p.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:500});Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:0});visualViewport.dispatchEvent(new Event('resize'));});
 let rect=await p.locator('.tn-input-dock').boundingBox();assert.ok(Math.abs(rect.y+rect.height-500)<2);
 const formula=await p.locator('.tn-formula').boundingBox(),symbols=await p.locator('.tn-symbols').boundingBox();assert.ok(formula.y+formula.height<=symbols.y+1);
 await p.setViewportSize({width:393,height:500});await p.waitForFunction(()=>document.querySelector('.tn-input-dock').style.bottom==='0px');rect=await p.locator('.tn-input-dock').boundingBox();assert.ok(Math.abs(rect.y+rect.height-500)<2);
 await editor.press('Escape');await p.setViewportSize({width:393,height:852});
 // Catalog ownership toggle in add and edit, including save/reopen and stale contractor clearing.
 await p.locator('[data-view=catalog]').click();await action('add-catalog').click();let dlg=p.locator('dialog[open]');
 assert.equal(await dlg.locator('[name=contractor]').isVisible(),false);await dlg.locator('[name=ownership]').selectOption('hired');assert.equal(await dlg.locator('[name=contractor]').isVisible(),true);
 await dlg.locator('[name=contractor]').fill('Тестовая фирма');await dlg.locator('[name=name]').fill('Тестовая техника');await dlg.locator('[name=ownership]').selectOption('own');await dlg.locator('[type=submit]').click();await dlg.waitFor({state:'hidden'});
 let row=p.locator('.tn-catalog-row').filter({hasText:'Тестовая техника'});await row.locator('[data-action=edit-catalog]').click();dlg=p.locator('dialog[open]');assert.equal(await dlg.locator('[name=contractor]').isVisible(),false);assert.equal(await dlg.locator('[name=contractor]').inputValue(),'');
 await dlg.locator('[name=ownership]').selectOption('hired');await dlg.locator('[name=contractor]').fill('Фирма 2');await dlg.locator('[type=submit]').click();await dlg.waitFor({state:'hidden'});await row.locator('[data-action=edit-catalog]').click();dlg=p.locator('dialog[open]');assert.equal(await dlg.locator('[name=contractor]').isVisible(),true);assert.equal(await dlg.locator('[name=contractor]').inputValue(),'Фирма 2');
 await dlg.locator('[data-action=close]').first().click();await p.locator('[data-view=table]').click();
 await editor.press('Escape');await p.evaluate(()=>{session.role='foreman';session.edit=false});await cell('E1').tap();assert.equal(await p.locator('[data-range]').inputValue(),'E1');assert.equal(await p.locator('dialog[open]').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS 3.4.47: cell tap focus, SUM autocomplete, corner reference ranges, stable formula destination, generic references, native pan, keyboard dock overlay/resize, add/edit ownership and persistence');
 }finally{await browser?.close();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1});
