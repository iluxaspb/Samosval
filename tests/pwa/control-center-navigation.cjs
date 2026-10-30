// Chromium layout regression: inner center nav must not inherit global nav{position:fixed}.
const {chromium}=require('playwright-core');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PWA_BROWSER,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  const css=fs.readFileSync('test-app/source/styles/style-04.css','utf8');
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+css+'</style>'+
   '<main style="padding:12px"><div id="tab-admin" class="active"><div id="admin-sub-server" class="active"><div id="server-control-root"></div></div></div></main>'+
   '<nav id="global-nav" style="height:64px"><button>Линия</button></nav>');
  await page.addScriptTag({content:"function isNasRuntime(){return true} function canAdmin(){return true}"+
   "const nasRuntimeClient={scope:'test'};function offlinePendingCount(){return 0} function showError(){} function escapeHtml(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;')}"+
   "let currentUid='uid',nasRuntimeEpoch=1;\n"+
   fs.readFileSync('test-app/source/core/22-server-control.js','utf8')});
  await page.evaluate(()=>{
   serverControlSnapshot={readAt:Date.now(),api:{version:'4.1.2',uptimeSeconds:120,requests:10,p95Ms:5,errors:0,recentErrors:[],memoryBytes:1024},
    agent:{available:true,host:{disk:{availableBytes:5000,totalBytes:10000}},backups:[]},
    database:{status:'connected',bytes:1200},users:{registered:2,active:2,pending:0},objects:[],jobs:[],events:[],backups:[],
    replication:{enabled:true,mode:'passive-mirror',activeOwner:'synology',lastSequence:17,deliveredSequence:15,lag:2,readyForFailover:false,lastError:null}};
   renderServerControl();
  });
  const inner=page.locator('#server-control-root .sc-nav'),outer=page.locator('nav#global-nav');
  const innerStyle=await inner.evaluate(el=>({position:getComputedStyle(el).position,top:el.getBoundingClientRect().top,role:el.getAttribute('role')}));
  const outerStyle=await outer.evaluate(el=>({position:getComputedStyle(el).position,top:el.getBoundingClientRect().top}));
  assert.notEqual(innerStyle.position,'fixed');assert.equal(innerStyle.role,'group');
  assert(innerStyle.top<330,'inner navigation should be at the start of control center');
  assert.equal(outerStyle.position,'fixed');assert(outerStyle.top>740);
  await page.locator('[data-sc-section=replication]').click();
  assert.equal(await page.locator('[data-sc-section=replication]').getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('#server-control-root').textContent(),/НЕ готов к переключению/);
  assert.match(await page.locator('#server-control-root').textContent(),/Отставание, событий/);
  assert.match(await page.locator('#server-control-root').textContent(),/Synology/);
  assert.equal(await page.locator('#server-control-root nav').count(),0);
  console.log('PASS center tabs remain in document flow, clickable above fixed mobile nav; replica status is gated');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
