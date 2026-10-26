'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),out=path.join(__dirname,'results/summary-browser');fs.mkdirSync(out,{recursive:true});
const report={scope:'Real Chromium; exact Summary rendering and hold/viewer modules; local fixture data, no Firebase',checks:[],errors:[],network:[]};
const html=fs.readFileSync(path.join(__dirname,'summary-visual.html'));
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);});
let browser;
function record(name){report.checks.push(name);console.log('PASS',name);}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,chromiumSandbox:true});
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,locale:'ru-RU'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(origin);await page.locator('#matrixTableBody').getByText('КАМАЗ (обычный)').waitFor();
  const regular=page.locator('#paperReportWrapper'),gai=page.locator('#gaiReportWrapper'),button=page.locator('#toggleReportBtn');
  assert(await regular.isVisible());assert(!await gai.isVisible());
  const sheet=await page.locator('#paperReportContainer').boundingBox();assert(sheet.width>0&&sheet.height>0);
  await page.screenshot({path:path.join(out,(mobile?'mobile':'desktop')+'-regular.png'),fullPage:true});record((mobile?'mobile':'desktop')+' regular paper visible');
  await button.scrollIntoViewIfNeeded();const box=await button.boundingBox(),area=await page.locator('#gaiReportToggleContainer').boundingBox();assert(box.width<=48&&box.height<=48);assert(Math.abs(box.x+box.width-area.x-area.width)<12);
  await button.click();assert(await regular.isVisible());assert(!await gai.isVisible());record('short click does not switch');
  async function hold(ms){await button.scrollIntoViewIfNeeded();const b=await button.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.waitForTimeout(ms);await page.mouse.up();}
  await hold(400);await page.waitForTimeout(450);assert(await regular.isVisible());record('400ms release cancels');
  await hold(850);assert(await gai.isVisible());assert(!await regular.isVisible());assert((await page.locator('#gaiTableBody').innerText()).includes('САМОСВАЛ ГАИ'));record('850ms real hold switches to GAI');
  await page.screenshot({path:path.join(out,(mobile?'mobile':'desktop')+'-gai.png'),fullPage:true});
  await hold(1700);assert(await regular.isVisible());assert(!await gai.isVisible());record('long continuous hold switches exactly once');
  await page.locator('#paperReportContainer').click();await page.locator('#summary-sheet-dialog').waitFor({state:'visible'});
  assert((await page.locator('#summary-sheet-dialog').innerText()).includes('КАМАЗ'));await page.locator('#summary-sheet-dialog [data-action="close"]').click();await page.locator('#summary-sheet-dialog').waitFor({state:'detached'});record('paper viewer opens and closes');
  assert.equal(report.errors.length,0,report.errors.join('\n'));await context.close();
 }
 report.status='passed';
})().catch(e=>{report.status='failed';report.error=e.stack;console.error(e);process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();server.close();});
