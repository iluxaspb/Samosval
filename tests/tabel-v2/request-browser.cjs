const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const server=spawn('python3',['-m','http.server','8793','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,executablePath:'/tmp/tabel-chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const p=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
 const errors=[];p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(7000);
 await p.goto('http://127.0.0.1:8793/tests/tabel-v2/harness.html');await p.waitForFunction(()=>ready);await p.evaluate(()=>{seedLegacy();objects[0].address='Невский проспект, 1';});
 await p.locator('#open').click();await p.locator('[data-view=request]').click();await p.locator('[name=metro]').waitFor();
 assert.equal(await p.locator('.tn-request [name=equipment]').count(),1);
 assert.equal(await p.locator('[name=people][value=w1]').count(),0);
 await p.locator('[data-action=choose-equipment]').click();await p.locator('dialog[open] [value=water]').check();await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
 assert.equal(await p.locator('.tn-request [name=equipment]').count(),2);
 await p.locator('[name=metro]').fill('путил');await p.locator('[data-stations] button').click();await p.locator('[name=pickupTime]').fill('07:15');
 await p.locator('[name=people][value=itr]').check();await p.locator('[name=shift]').selectOption('night');await p.locator('.tn-request [type=submit]').click();
 await p.locator('[data-view=catalog]').click();await p.locator('[data-tab=itr]').click();await p.locator('[data-action=edit-catalog][data-id=itr]').click();await p.locator('dialog[open] [name=phone]').fill('+79991234567');await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
 await p.locator('[data-view=request]').click();assert.equal(await p.locator('[name=responsibleId]').inputValue(),'itr');
 await p.locator('[data-action=lunch]').click();assert.equal(await p.locator('[data-total]').innerText(),'4');
 await p.locator('[name=mechanic]').check();await p.locator('[name=spare]').check();await p.locator('[name=workers]').click();await p.locator('[data-digit="3"]').click();await p.locator('.tn-hours-dialog [type=submit]').click();await p.locator('.tn-hours-dialog').waitFor({state:'hidden'});assert.equal(await p.locator('[data-total]').innerText(),'9');
 assert((await p.locator('dialog[open]').innerText()).includes('+79991234567'));
 await p.locator('dialog[open] [type=submit]').click();await p.locator('textarea').waitFor();const text=await p.locator('textarea').inputValue();
 for(const x of ['Невский проспект, 1','ночная','Количество обедов: 9','Отв. Иванов И.','+79991234567'])assert(text.includes(x),x);
 assert(!text.includes('12:00') && !text.includes('23:00'));assert(!text.includes('Дата:') && !text.includes('Объект:') && !text.includes('Адрес:'));assert.equal(text.split('Невский проспект, 1').length,2);
 await p.locator('dialog[open] [data-action=close]').first().click();await p.locator('[data-action=send-request]').click();await p.locator('textarea').waitFor();const request=await p.locator('textarea').inputValue();assert(request.includes('Путиловская') && request.includes('07:15'));assert(!request.includes('Иван Петров'));
 await p.locator('dialog[open] [data-action=close]').first().click();await p.locator('[data-action=exit]').click();await p.locator('#open').click();await p.locator('[data-view=request]').click();await p.locator('[name=metro]').waitFor();assert.equal(await p.locator('[name=metro]').inputValue(),'Путиловская');
 assert.deepEqual(errors,[]);console.log('PASS mobile requests: selected equipment only, no workers, metro/time persistence, ITR phone edit, lunch calculation/extras, night shift and share text');
}finally{await browser?.close();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1;});

