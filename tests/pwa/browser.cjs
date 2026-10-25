// Real Chromium + real Firestore SDK/IndexedDB/transactions against a LOCAL emulator.
// Auth uses a fixed test identity; this never signs into or writes to the live project.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const {initializeTestEnvironment}=require('@firebase/rules-unit-testing');
const {doc,setDoc,collection,getDocs}=require('firebase/firestore');
const root=path.resolve(__dirname,'../..'),project='samosval-offline',port=Number(process.env.PWA_FIRESTORE_PORT||8097),uid='qa-pwa';
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png','.ttf':'font/ttf'};
const requests=[];let workerRevision=0;
const server=http.createServer((req,res)=>{
 requests.push([req.url,workerRevision]);const route=new URL(req.url,'http://localhost').pathname;
 if(route==='/Samosval/pwa-observer'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>PWA test observer</title>');return;}
 const file=path.resolve(root,'.'+route.replace(/^\/Samosval/,''));
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-cache');let content=fs.readFileSync(file);if(workerRevision&&file.endsWith('/sw-test.js'))content=Buffer.from(content.toString().replace(/const VERSION = '([^']+)'/,(_,v)=>"const VERSION = '"+v+"-qa-update'"));res.end(content);
});
async function fixture({port,uid}){
 document.addEventListener('load',function ready(event){
  if(event.target.tagName!=='SCRIPT'||!event.target.src.includes('html2pdf-'))return;
  const real=window.firebase,initialize=real.initializeApp.bind(real),authListeners=[];
  const user={uid,email:'qa-pwa@example.test',displayName:'Проверка PWA'};
  const fakeAuth={currentUser:user,onAuthStateChanged(cb){authListeners.push(cb);setTimeout(()=>cb(user),0);return()=>{}},signOut:async()=>{fakeAuth.currentUser=null;authListeners.forEach(cb=>cb(null));}};
  real.auth=Object.assign(()=>fakeAuth,real.auth);
  real.initializeApp=function(config,name){const app=initialize(config,name);const db=app.firestore();db.useEmulator('127.0.0.1',port,{mockUserToken:{sub:uid,email:user.email}});const settings=db.settings.bind(db);db.settings=options=>settings({...options,host:'127.0.0.1:'+port,ssl:false});return app;};
  window.__pwaFixtureReady=true;
 },true);
}
(async()=>{
 let env,context,emulator;const profile=fs.mkdtempSync(path.join(os.tmpdir(),'samosval-pwa-'));
 const errors=[];
 try{
  if(process.env.FIRESTORE_EMULATOR_JAR){
   emulator=spawn('java',['-jar',process.env.FIRESTORE_EMULATOR_JAR,'--host','127.0.0.1','--port',String(port),'--project_id',project]);
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Emulator startup timed out')),30000);emulator.stdout.on('data',d=>{if(String(d).includes('Dev App Server is now running')){clearTimeout(timer);resolve();}});emulator.stderr.on('data',()=>{});emulator.on('exit',code=>{clearTimeout(timer);reject(Error('Emulator exited '+code))});});
  }
  env=await initializeTestEnvironment({projectId:project,firestore:{host:'127.0.0.1',port,rules:fs.readFileSync(path.join(root,'firestore-v3.rules'),'utf8')}});
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c=>{
   const db=c.firestore();for(const [p,data]of Object.entries({
    ['users/'+uid]:{email:'qa-pwa@example.test',role:'admin',status:'active',nickname:'Проверка PWA'},
    'settings/permissions':{admin:{tabs:['line','report','archive','trucks','analytics','backup','admin','timesheet'],actions:[]}},
    'settings/appConfig':{cycleMinutes:15,maxEnabled:false,testReviewFlags:{game_mode:true,arcade_enabled:true}},
    'workspaces/main_workspace/shift/current':{id:'qa-shift',objectId:'qa-object',objectName:'Проверка офлайна',isActive:true,startedAt:Date.now(),startDate:'25.10.2026'},
    'workspaces/main_workspace/objects/qa-object':{name:'Проверка офлайна'},
    'workspaces/main_workspace/trucks/qa-truck':{brand:'Самосвал',number:'А123АА78',defaultVol:20,isGAI:false},
    'workspaces/main_workspace/truckStatus/qa-truck':{shiftId:'qa-shift',onLine:true,cycleRevision:1,ttnRevision:0,arriveStatus:null,lastLoadTimestamp:null}
   }))await setDoc(doc(db,p),data);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/Samosval/index-test.html';
  async function launch(offline=false){
   const c=await chromium.launchPersistentContext(profile,{executablePath:process.env.PWA_BROWSER,headless:true,viewport:{width:390,height:844},args:['--no-sandbox']});
   await c.addInitScript(fixture,{port,uid});
   await c.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await c.setOffline(offline);
   c.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
   return c;
  }
  context=await launch();let page=await context.newPage();await page.goto(url);
  await page.waitForFunction(()=>window.__pwaFixtureReady&&window.TestPWA?.snapshot().shellReady&&window.TestPWA.snapshot().persistent&&permissionsLoaded&&state.shift?.id==='qa-shift',{timeout:30000});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.equal(await page.evaluate(()=>Object.keys(state.truckStatus).length),1);
  const manifest=await page.context().newCDPSession(page);const result=await manifest.send('Page.getAppManifest');assert.equal(result.errors.length,0,JSON.stringify(result.errors));
  const installErrors=await manifest.send('Page.getInstallabilityErrors');assert.equal(installErrors.installabilityErrors.length,0,JSON.stringify(installErrors));
  await page.evaluate(()=>openSettingsModal());assert(await page.locator('#test-pwa-settings').isVisible());await page.screenshot({path:path.join(profile,'settings.png')});await page.evaluate(()=>closeSettingsModal());
  assert.deepEqual(errors,[]);console.log('PASS real browser: full app boots, all modules, manifest installability, service worker and Firebase persistent cache ready');
  await context.close();context=await launch(true);page=await context.newPage();await page.goto(url+'?offline=1');
  await page.waitForFunction(()=>permissionsLoaded&&currentUserStatus==='active'&&state.shift?.id==='qa-shift'&&state.trucks.length===1,{timeout:30000});
  assert.equal(await page.evaluate(()=>navigator.onLine),false);
  await page.evaluate(async()=>{await toggleArrive('qa-truck');await performLoad('qa-truck');await toggleTtn('qa-truck');});
  await page.waitForFunction(()=>offlinePendingCount()===3);
  assert.equal(await page.evaluate(()=>getLogs().length),1);assert.equal(await page.evaluate(()=>!!state.truckStatus['qa-truck'].ttnStatus),true);
  await page.screenshot({path:path.join(profile,'offline.png')});
  await context.close();context=await launch(true);page=await context.newPage();await page.goto(url);
  await page.waitForFunction(()=>permissionsLoaded&&offlinePendingCount()===3&&getLogs().length===1,{timeout:30000});
  assert.equal(await page.evaluate(()=>!!state.truckStatus['qa-truck'].ttnStatus),true);
  console.log('PASS real offline cold start: cached rights/shift restored; arrival, loading and TTN survive full browser restart');
  await context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>offlinePendingCount()===0,{timeout:45000});
  assert.equal(await page.evaluate(()=>offlineUnreviewedFailures().length),0);
  await env.withSecurityRulesDisabled(async c=>assert.equal((await getDocs(collection(c.firestore(),'workspaces/main_workspace/logs'))).size,1));
  await page.evaluate(()=>offlineReplayJournal());
  await env.withSecurityRulesDisabled(async c=>assert.equal((await getDocs(collection(c.firestore(),'workspaces/main_workspace/logs'))).size,1));
  console.log('PASS real reconnect under Firestore rules: 3 actions accepted, exactly 1 trip, retry creates no duplicate');
  // The page and all export dependencies remain available without network.
  await context.setOffline(true);const output=await page.evaluate(async()=>TestPWA.inlineHtml(await (await fetch(location.href)).text()));
  fs.writeFileSync(path.join(profile,'export.html'),output);
  const exported=await page.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html');return{scripts:[...d.querySelectorAll('script[src]')].map(x=>x.getAttribute('src')),styles:d.querySelectorAll('link[rel=stylesheet]').length,code:[...d.scripts].map(x=>x.textContent)}},output);
  assert.deepEqual(exported.scripts,[]);assert.equal(exported.styles,0);assert(output.includes('data:font/ttf;base64,'));
  for(const script of exported.code)new (require('node:vm').Script)(script);
  console.log('PASS offline single-file export includes every script, stylesheet and font');
  // Stage an update while a real pending offline operation exists. It must wait, not reload.
  await page.evaluate(async()=>{await toggleTtn('qa-truck');localStorage.setItem('pwa-update-probe','preserved');});
  assert.equal(await page.evaluate(()=>offlinePendingCount()),1);
  workerRevision=1;
  // Leave page network online=false to hold the domain queue; the worker can fetch the staged release.
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true}));
  await context.setOffline(false);
  await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
  await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting,{timeout:30000});
  assert.equal(await page.evaluate(()=>offlinePendingCount()),1);
  assert.equal(await page.evaluate(()=>localStorage.getItem('pwa-update-probe')),'preserved');
  const observer=await context.newPage();await observer.goto(url.replace('index-test.html','pwa-observer'));
  await page.close();
  await observer.waitForFunction(async url=>{const r=await navigator.serviceWorker.getRegistration(url);if(!r||r.waiting||r.active?.state!=='activated')return false;return new Promise(resolve=>{const ch=new MessageChannel();ch.port1.onmessage=e=>{ch.port1.close();resolve(e.data.version.endsWith('-qa-update'));};r.active.postMessage({type:'TEST_PWA_STATUS'},[ch.port2]);});},url,{timeout:30000});
  await context.setOffline(true);page=await context.newPage();await page.goto(url);await page.waitForFunction(()=>permissionsLoaded&&offlinePendingCount()===1);
  await context.close();context=await launch(true);page=await context.newPage();await page.goto(url);
  await page.waitForFunction(()=>permissionsLoaded&&offlinePendingCount()===1,{timeout:30000});
  assert.equal(await page.evaluate(()=>localStorage.getItem('pwa-update-probe')),'preserved');
  const workerVersion=await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();return new Promise(resolve=>{const ch=new MessageChannel();ch.port1.onmessage=e=>resolve(e.data.version);r.active.postMessage({type:'TEST_PWA_STATUS'},[ch.port2]);})});
  assert(workerVersion.endsWith('-qa-update'));
  console.log('PASS real PWA update: waits while app is open; activates after closing; pending action and local data survive offline restart');
  assert.deepEqual(errors,[]);console.log('Screenshots:',profile);
 }finally{if(context)await context.close();if(env)await env.cleanup();await new Promise(r=>server.close(r));if(emulator)emulator.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
