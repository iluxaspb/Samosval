// Real browser acceptance for numeric selection, available actions, merges and borders.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const server = spawn('python3', ['-m','http.server','8837','--bind','127.0.0.1'], {stdio:'ignore'});
(async()=>{
 let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.PWA_BROWSER,args:['--no-sandbox','--disable-dev-shm-usage']});
  const p=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
  p.setDefaultTimeout(10000);const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.clock.setFixedTime(new Date('2026-10-30T12:00:00+03:00'));
  await p.goto('http://127.0.0.1:8837/tests/tabel-v2/harness.html');await p.waitForFunction(()=>ready);
  await p.evaluate(async()=>{const {Store}=await import('/test-app/tabel-v2/store.mjs'),open=Store.prototype.open;Store.prototype.open=async function(){window.qaStore=this;return open.call(this)};seedLegacy()});
  await p.locator('#open').click();await p.locator('[data-view=table]').click();await p.locator('.tn-grid').waitFor();
  const action=a=>p.locator('[data-action="'+a+'"]'),cell=k=>p.locator('[data-cell="'+k+'"]');
  const range=async value=>{await p.locator('[data-range]').fill(value);await p.locator('[data-range]').dispatchEvent('change')};
  const text=k=>p.locator('[data-cell="'+k+'"]');
  await cell('S4').tap();assert.equal(await p.locator('dialog[open]').count(),0);
  await cell('S4').tap();await p.locator('dialog[open] [data-value="12"]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
  await cell('S4').scrollIntoViewIfNeeded();
  const handle=await p.locator('.tn-fill').boundingBox(),target=await cell('R4').boundingBox();
  await p.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await p.mouse.down();await p.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:6});await p.mouse.up();
  assert.equal(await p.locator('[data-range]').inputValue(),'S4:R4');assert(await action('numeric-autofill').isVisible());assert(await action('numeric-autofill').isEnabled());
  await action('numeric-autofill').click();await p.waitForFunction(()=>document.querySelector('[data-cell=R4]')?.textContent==='12');
  console.log('PASS numeric two taps, corner drag selects a range and explicit autofill saves hours');
  await p.evaluate(async()=>{const old=qaStore.get('site-a/config');await qaStore.save('site-a/config',{...old.data,tableMode:'full'},old,'QA full mode')});
  await p.locator('[data-view=catalog]').click();await p.locator('[data-view=table]').click();
  await action('new-sheet').click();await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
  await cell('A1').tap();await p.locator('[data-editor]').fill('Итог');await action('apply').click();await p.waitForFunction(()=>document.querySelector('[data-cell=A1]')?.textContent==='Итог');
  await p.locator('[data-row="2"]').click();assert.match(await p.locator('[data-range]').inputValue(),/^A3:[A-Z]+3$/);
  await p.locator('[data-column="2"]').click();assert.match(await p.locator('[data-range]').inputValue(),/^C1:C\d+$/);
  await range('A1:B2');await action('menu').click();assert(await p.locator('dialog[open] [data-action=copy]').isVisible());assert(await p.locator('dialog[open] [data-action=merge]').isVisible());
  assert.equal(await p.locator('dialog[open] [data-action=edit]').count(),0,'Range has no single-cell editor action');
  await p.screenshot({path:'/tmp/samosval-410-context.png'});await p.locator('dialog[open] [data-action=merge]').click();
  await p.waitForFunction(()=>document.querySelector('[data-cell=A1]')?.colSpan===2);assert.equal(await cell('A1').getAttribute('rowspan'),'2');assert.equal(await cell('B2').count(),0);assert.equal(await text('A1').textContent(),'Итог');
  await action('undo').click();await cell('B2').waitFor();assert.equal(await text('A1').textContent(),'Итог');await action('redo').click();await p.waitForFunction(()=>document.querySelector('[data-cell=A1]')?.colSpan===2);
  await range('A1');await action('menu').click();await p.locator('dialog[open] [data-action=unmerge]').click();await cell('B2').waitFor();
  console.log('PASS row/column headings select entire axes; merge, undo, redo and unmerge preserve the value');
  await range('B3:C4');await action('menu').click();await p.locator('dialog[open] [data-action=borders]').click();
  assert.equal(await p.locator('.tn-border-presets button').count(),10);await p.locator('dialog[open] select[name=width]').selectOption('3');await p.locator('dialog[open] select[name=pattern]').selectOption('dashed');await p.locator('dialog[open] input[name=color]').fill('#123456');
  await p.screenshot({path:'/tmp/samosval-410-borders.png'});await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});
  assert.equal(await cell('B3').evaluate(e=>e.style.borderTop),'3px dashed rgb(18, 52, 86)');assert.equal(await cell('C4').evaluate(e=>e.style.borderLeft),'3px dashed rgb(18, 52, 86)');
  await action('menu').click();await p.locator('dialog[open] [data-action=borders]').click();await p.locator('[data-action=border-none]').click();await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});assert.equal(await cell('B3').evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
  await action('undo').click();await p.waitForFunction(()=>document.querySelector('[data-cell=B3]')?.style.borderTopWidth==='3px');
  assert.deepEqual(errors,[]);console.log('PASS compact contextual actions, ten border presets, thickness/style/color, remove and undo; no browser errors');
 } finally {await browser?.close();server.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
