const assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const server=spawn('python3',['-m','http.server','8811','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{let browser;try{
 browser=await chromium.launch({executablePath:'/tmp/tabel-chromium',args:['--no-sandbox']});
 const p=await browser.newPage({viewport:{width:393,height:852}}),errors=[];p.setDefaultTimeout(5000);p.on('pageerror',e=>errors.push(e.message));
 await p.clock.setFixedTime(new Date('2026-10-28T12:00:00+03:00'));
 await p.goto('http://127.0.0.1:8811/tests/tabel-v2/harness.html');await p.waitForFunction(()=>ready);
 await p.evaluate(()=>seedLegacy());await p.locator('#open').click();
 assert.equal(await p.locator('button[data-view=shift]').getAttribute('aria-pressed'),'true');
 const action=a=>p.locator('[data-action="'+a+'"]');
 const save=async()=>{await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});};
 await p.locator('button[data-view=table]').click();
 await action('new-sheet').click();await save();
 assert.equal(await action('sheet').count(),2);
 await p.locator('[data-cell=A1]').click();await p.locator('[data-editor]').fill('12');await action('apply').click();
 await p.waitForFunction(()=>document.querySelector('[data-cell=A1]').textContent==='12');
 await action('undo').click();await p.waitForFunction(()=>document.querySelector('[data-cell=A1]').textContent==='');
 await action('redo').click();await p.waitForFunction(()=>document.querySelector('[data-cell=A1]').textContent==='12');
 
 // History survives a full view render (the same path used by incoming data).
 await p.locator('button[data-view=shift]').click();await p.locator('button[data-view=table]').click();
 await action('undo').click();await p.waitForFunction(()=>document.querySelector('[data-cell=A1]').textContent==='');
 await action('redo').click();await p.waitForFunction(()=>document.querySelector('[data-cell=A1]').textContent==='12');
 
 await p.locator('[data-cell=A1]').click();
 const handle=await p.locator('.tn-fill').boundingBox(),target=await p.locator('[data-cell=A4]').boundingBox();
 await p.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await p.mouse.down();await p.mouse.move(target.x+target.width/2,target.y+target.height/2);
 assert.equal(await p.locator('.tn-fill-target').count(),4);assert.match(await p.locator('.tn-fill-preview').innerText(),/4/);
 await p.screenshot({path:'/tmp/tabel3441-fill.png'});await p.mouse.up();
 await p.waitForFunction(()=>document.querySelector('[data-cell=A4]').textContent==='12');
 await action('undo').click();await p.waitForFunction(()=>document.querySelector('[data-cell=A4]').textContent==='');
 await action('sheet-access').click();assert.equal(await p.locator('dialog[open] input:checked').count(),0);
 await p.locator('dialog[open] [value=master]').check();await save();
 await action('sheet-options').click();await p.locator('dialog[open] [data-action=rename-sheet]').click();await p.locator('dialog[open] [name=name]').fill('Бригада');await save();
 assert.match(await p.locator('.tn-sheets').innerText(),/Бригада/);
 const border=await p.locator('[data-cell=A1]').evaluate(e=>getComputedStyle(e).borderRightColor);assert.equal(border,'rgb(0, 0, 0)');
 // Closing leaves one runtime; a different object and today's shift are restored.
 await p.locator('[data-object]').selectOption('site-b');await action('exit').click();await p.locator('#open').click();
 assert.equal(await p.locator('[data-object]').inputValue(),'site-b');assert.equal(await p.locator('button[data-view=shift]').getAttribute('aria-pressed'),'true');assert.equal(await p.locator('.tn-app').count(),1);
 assert.deepEqual(errors,[]);console.log('PASS 3.4.41 mobile: today, sheets, rename, role access, undo/redo after render, fill preview and grouped undo, black borders, retained runtime and object');
 }finally{await browser?.close();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1});
