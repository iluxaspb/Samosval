// Run with: node tests/usb.browser.mjs (requires Playwright + Chromium).
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.webmanifest':'application/manifest+json'};
let swSuffix='';
const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local').pathname;const file=path.join(root,name==='/'?'index.html':name);let body=await readFile(file);if(name==='/app.js')body=body.toString()+'\nglobalThis.__wincorTest={rasterPage,get job(){return previewJob},get packet(){return usbPacket}};';if(name==='/sw.js')body=body.toString()+swSuffix;res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(body)}catch{res.writeHead(404);res.end()}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
 await context.addInitScript(()=>{
  globalThis.usbMock={calls:0,bytes:0,fail:false};
  const device={vendorId:1234,productId:4915,serialNumber:'QA-ONLY',productName:'Wincor test printer',opened:false,configuration:{interfaces:[{interfaceNumber:0,alternates:[{alternateSetting:0,interfaceClass:7,interfaceSubclass:1,endpoints:[{endpointNumber:1,direction:'out',type:'bulk'}]}]}]},async open(){this.opened=true},async close(){this.opened=false},async claimInterface(){},async releaseInterface(){},async selectAlternateInterface(){},async transferOut(ep,chunk){if(usbMock.fail)throw Error('Mock USB failure');usbMock.bytes+=chunk.length;return {status:'ok',bytesWritten:chunk.length}}};
  Object.defineProperty(navigator,'usb',{configurable:true,value:{async getDevices(){return [device]},async requestDevice(){usbMock.calls++;return device}}});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.locator('[data-action="truck-add"]').first().waitFor();
 await page.locator('[data-action="truck-add"]').first().click();await page.locator('[name="plate"]').fill('А123АА178');await page.locator('[name="driver"]').fill('Иванов Иван');await page.locator('#truck-form [type="submit"]').click();
 await page.locator('[data-truck]').check();await page.locator('#job-copies').fill('2');await page.locator('#job-copies').dispatchEvent('change');await page.locator('[data-action="prepare"]').click();await page.locator('[data-action="usb-job"]').click();await page.waitForFunction(()=>document.querySelector('#usb-size')?.textContent.startsWith('Размер пакета:'));
 const sizes=await page.evaluate(()=>{
  const j=__wincorTest.job;let legacy=0;for(let i=0;i<j.pages.length;i++){const c=__wincorTest.rasterPage(j,i);legacy+=28+Math.ceil(c.height/24)*(6+c.width*3)+(Math.ceil(c.height/24)-1)*2+3;}return {old:legacy,new:__wincorTest.packet.length,pages:j.pages.length};
 });
 assert.equal(sizes.pages,2);assert.ok(sizes.new<sizes.old/3,JSON.stringify(sizes));
 await page.locator('#modal [data-action="usb-connect"]').click();await page.locator('#modal [data-action="usb-save"]').click();assert.equal(await page.evaluate(()=>usbMock.calls),1);
 await page.locator('#usb-send').click();await page.waitForFunction(()=>document.querySelector('#usb-progress').textContent.startsWith('Все байты'));assert.equal(await page.evaluate(()=>usbMock.bytes),sizes.new);assert.equal(await page.locator('#usb-send').isDisabled(),true);
 await page.locator('#modal [data-action="close"]').click();
 await page.reload();await page.locator('[data-truck]').waitFor();assert.equal(await page.locator('[data-truck]').count(),1);
 await page.locator('.bottomnav [data-id="settings"]').click();await page.locator('[data-action="usb-connect"]').click();assert.equal(await page.evaluate(()=>usbMock.calls),0);assert.match(await page.locator('#usb-status').innerText(),/Сохранённый принтер/);
 // Active service worker update must preserve existing IndexedDB data.
 await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();await page.locator('[data-truck]').waitFor();
 swSuffix='\n// browser regression update\n';await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update()});await page.locator('#app-update').waitFor();
 await Promise.all([page.waitForEvent('load'),page.locator('#app-update').click()]);await page.locator('[data-truck]').waitFor();assert.equal(await page.locator('[data-truck]').count(),1);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({viewport:'393x852',sizes,reduction:+(sizes.old/sizes.new).toFixed(2),savedPrinterReconnect:true,packetBytesMatch:true,indexedDBPreservedAfterSWUpdate:true,pageErrors:errors}));
 await context.close();
}finally{await browser.close();await new Promise(r=>server.close(r))}
