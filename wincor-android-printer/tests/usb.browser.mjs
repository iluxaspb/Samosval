// Run with: node tests/usb.browser.mjs (requires Playwright + Chromium).
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.webmanifest':'application/manifest+json'};
let swSuffix='';
const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local').pathname;const file=path.join(root,name==='/'?'index.html':name);let body=await readFile(file);if(name==='/app.js')body=body.toString()+'\nglobalThis.__wincorTest={rasterPage,get job(){return previewJob},get packet(){return usbPacket}};';if(name==='/sw.js')body=body.toString()+swSuffix;res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(body)}catch{res.writeHead(404);res.end()}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']}).catch(async error=>{await new Promise(r=>server.close(r));throw error});
try{
 const context=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
 await context.addInitScript(()=>{
  globalThis.usbMock={calls:0,bytes:0,fail:false,permitted:!!localStorage.getItem('wincor-android-printer.usb.v1'),cancel:false};
  const device={vendorId:1234,productId:4915,serialNumber:'QA-ONLY',productName:'Wincor test printer',opened:false,configuration:{interfaces:[{interfaceNumber:0,alternates:[{alternateSetting:0,interfaceClass:7,interfaceSubclass:1,endpoints:[{endpointNumber:1,direction:'out',type:'bulk'}]}]}]},async open(){this.opened=true},async close(){this.opened=false},async claimInterface(){},async releaseInterface(){},async selectAlternateInterface(){},async transferOut(ep,chunk){if(usbMock.fail)throw Error('Mock USB failure');usbMock.bytes+=chunk.length;return {status:'ok',bytesWritten:chunk.length}}};
  const events=new EventTarget();globalThis.usbMock.unplug=()=>{const e=new Event('disconnect');e.device=device;events.dispatchEvent(e)};Object.defineProperty(navigator,'usb',{configurable:true,value:{addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),async getDevices(){return usbMock.permitted?[device]:[]},async requestDevice(options){if(!navigator.userActivation.isActive)throw Error('Lost user activation');if(options.filters[0].classCode!==7)throw Error('Missing printer filter');usbMock.calls++;if(usbMock.cancel)throw new DOMException('cancel','NotFoundError');usbMock.permitted=true;return device}}});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.locator('[data-action="truck-add"]').first().waitFor();
 await page.locator('[data-action="truck-add"]').first().click();await page.locator('[name="plate"]').fill('А123АА178');await page.locator('[name="driver"]').fill('Иванов Иван');await page.locator('#truck-form [type="submit"]').click();
 // New named field is entered per trip, rendered in preview and frozen in history.
 await page.locator('[data-action="editor"]').click();
 await page.locator('[data-action="field-add"]').click();
 await page.locator('[data-prop="label"]').fill('Имя прораба');
 await page.locator('[data-prop="label"]').dispatchEvent('change');
 await page.locator('.bottomnav [data-id="print"]').click();
 await page.locator('summary').click();
 await page.getByLabel('Имя прораба',{exact:true}).fill('Петров Пётр');
 await page.reload();await page.locator('[data-truck]').waitFor();
 await page.locator('summary').click();
 assert.equal(await page.getByLabel('Имя прораба',{exact:true}).inputValue(),'Петров Пётр');
 await page.locator('[data-truck]').check();await page.locator('#job-copies').fill('2');await page.locator('#job-copies').dispatchEvent('change');await page.locator('[data-action="prepare"]').click();await page.locator('[data-action="usb-job"]').click();await page.waitForFunction(()=>document.querySelector('#usb-size')?.textContent.startsWith('Размер пакета:'));
 const tripSnapshot=await page.evaluate(()=>{const j=__wincorTest.job,f=j.template.fields.find(f=>f.source==='trip');return {label:f.label,value:j.pages[0].data.tripFields[f.id]}});
 assert.deepEqual(tripSnapshot,{label:'Имя прораба',value:'Петров Пётр'});
 const sizes=await page.evaluate(()=>{
  const j=__wincorTest.job;let legacy=0;for(let i=0;i<j.pages.length;i++){const c=__wincorTest.rasterPage(j,i);legacy+=28+Math.ceil(c.height/24)*(6+c.width*3)+(Math.ceil(c.height/24)-1)*2+3;}return {old:legacy,new:__wincorTest.packet.length,pages:j.pages.length};
 });
 assert.equal(sizes.pages,2);assert.ok(sizes.new<sizes.old/3,JSON.stringify(sizes));
 await page.locator('#modal [data-action="usb-connect"]').click();await page.locator('#modal [data-action="usb-grant"]').waitFor();assert.equal(await page.evaluate(()=>usbMock.calls),0);await page.locator('#modal [data-action="usb-grant"]').click();await page.locator('#modal [data-action="usb-save"]').click();assert.equal(await page.evaluate(()=>usbMock.calls),1);await page.locator('#modal [data-action="usb-change"]').click();assert.equal(await page.evaluate(()=>usbMock.calls),2);await page.evaluate(()=>usbMock.cancel=true);await page.locator('#modal [data-action="usb-change"]').click();assert.equal(await page.locator('#modal [data-action="usb-save"]').isEnabled(),true);await page.evaluate(()=>{usbMock.cancel=false;usbMock.unplug()});assert.equal(await page.locator('#modal [data-action="usb-save"]').isDisabled(),true);await page.locator('#modal [data-action="usb-connect"]').click();assert.equal(await page.locator('#modal [data-action="usb-save"]').isEnabled(),true);
 await mkdir(path.join(root,'test-artifacts'),{recursive:true});await page.screenshot({path:path.join(root,'test-artifacts','usb-mobile.png'),fullPage:true});
 await page.locator('#usb-send').click();await page.waitForFunction(()=>document.querySelector('#usb-progress').textContent.startsWith('Все байты'));assert.equal(await page.evaluate(()=>usbMock.bytes),sizes.new);assert.equal(await page.locator('#usb-send').isDisabled(),true);
 await page.locator('#modal [data-action="close"]').click();
 await page.reload();await page.locator('[data-truck]').waitFor();assert.equal(await page.locator('[data-truck]').count(),1);
 await page.locator('.bottomnav [data-id="settings"]').click();await page.locator('[data-action="usb-connect"]').click();assert.equal(await page.evaluate(()=>usbMock.calls),0);assert.match(await page.locator('#usb-status').innerText(),/Сохранённый принтер/);
 // Active service worker update must preserve existing IndexedDB data.
 await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();await page.locator('[data-truck]').waitFor();
 swSuffix='\n// browser regression update\n';await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update()});await page.locator('#app-update').waitFor();
 await Promise.all([page.waitForEvent('load'),page.locator('#app-update').click()]);await page.locator('[data-truck]').waitFor();assert.equal(await page.locator('[data-truck]').count(),1);
 await page.locator('summary').click();
 await page.getByLabel('Имя прораба',{exact:true}).fill('Новый прораб');
 await page.locator('.bottomnav [data-id="history"]').click();
 await page.locator('[data-action="job-open"]').first().click();
 const historyValue=await page.evaluate(()=>{const j=__wincorTest.job,f=j.template.fields.find(f=>f.source==='trip');return j.pages[0].data.tripFields[f.id]});
 assert.equal(historyValue,'Петров Пётр');
 assert.match(await page.locator('#modal').innerText(),/Петров Пётр/);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport:'393x852',sizes,reduction:+(sizes.old/sizes.new).toFixed(2),namedTripFieldsAndHistory:true,savedPrinterReconnect:true,packetBytesMatch:true,indexedDBPreservedAfterSWUpdate:true,pageErrors:errors}));
 await context.close();
}finally{await browser.close();await new Promise(r=>server.close(r))}

