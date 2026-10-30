// Real Chromium, real service workers, local deterministic releases; no live account or data.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const pwa=fs.readFileSync('test-app/src/pwa.js'),sw=fs.readFileSync('test-app/source/service-worker.js','utf8'),permissions=fs.readFileSync('test-app/source/core/02-permissions.js'),history=fs.readFileSync('test-app/source/features/release-history.js','utf8'),styles=fs.readFileSync('test-app/source/styles/style-04.css','utf8');
function release(version,build){
 const assets=new Map();
 const page=`<!doctype html><meta charset="utf-8"><meta name="test-app-build" content="${build}"><meta name="test-app-version" content="${version}"><style>${styles}</style><header id="mainHeader"><div class="header-inner"><span class="version-text">${version}</span></div></header><div id="settingsModal"><div class="modal-body"></div></div><script>let currentUid='qa',currentUserRole='lopater',currentUserStatus='active',permissionsLoaded=true,pendingOps=0,syncState={pendingWrites:{}};window.TEST_APP_RELEASE={version:'${version}'};window.TestStorageState={persistent:true};function offlinePendingCount(){return Number(localStorage.getItem('qa_pending')||0)}function offlineTransportRecovered(){}function offlineReplayJournal(){}function appConfirm(){return Promise.resolve(true)}function appNotice(){}</script><script src="./permissions.js"></script><script src="./release.js"></script><script src="./test-app/src/pwa.js"></script>`;
 assets.set('index-test.html',Buffer.from(page));assets.set('permissions.js',permissions);assets.set('release.js',Buffer.from(history.replace("version:'4.1.0'",`version:'${version}'`)));assets.set('test-app/src/pwa.js',pwa);
 for(let i=0;i<12;i++)assets.set('test-app/file-'+i+'.txt',Buffer.from('fixture '+build+' '+i));
 const records=[...assets].map(([url,bytes])=>({url:'./'+url,sha256:hash(bytes)}));
 assets.set('sw-test.js',Buffer.from(sw.replace(/const VERSION = '[^']+'/,`const VERSION = '${build}'`).replace(/^const RECORDS = .*;$/m,'const RECORDS = '+JSON.stringify(records)+';')));
 assets.set('test-app/build-manifest.json',Buffer.from(JSON.stringify({version:build,channel:'test-'+version,assets:records})));
 return assets;
}
(async()=>{
 let current=release('4.0.9','aaaaaaaaaaaaaaaa');const errors=[];
 const server=http.createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1),b=current.get(path);res.writeHead(b?200:404,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.json')?'application/json':path.endsWith('.txt')?'text/plain':'text/html','Cache-Control':'no-store','Service-Worker-Allowed':'/'});setTimeout(()=>res.end(b||'missing'),path.includes('file-')?80:0);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.PWA_BROWSER,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
 const context=await browser.newContext({viewport:{width:390,height:844}}),a=await context.newPage();a.on('pageerror',e=>errors.push(e.message));await a.goto(base+'/index-test.html');await a.waitForFunction(()=>window.TestPWA?.snapshot().shellReady);await a.reload();await a.waitForFunction(()=>window.TestPWA?.snapshot().shellReady);
 const b=await context.newPage();b.on('pageerror',e=>errors.push(e.message));await b.goto(base+'/index-test.html');await b.waitForFunction(()=>window.TestPWA?.snapshot().shellReady);
 for(const role of ['lopater','foreman','admin','viewer']){
  await a.evaluate(role=>{currentUserRole=role;document.querySelector('#mainHeader .version-text').disabled=!canViewReleaseHistory();},role);assert(await a.locator('#mainHeader .version-text').isVisible(),role+' sees version');assert.equal(await a.locator('#mainHeader .version-text').textContent(),'4.0.9');
  await a.locator('#mainHeader .version-text').evaluate(e=>e.click());assert.equal(await a.locator('#releaseHistoryDialog[open]').count(),['admin','foreman'].includes(role)?1:0,role+' history rights');if(['admin','foreman'].includes(role))await a.locator('#releaseHistoryDialog .release-heading button').click();
 }
 console.log('PASS all roles see bare version; history only admin and foreman');
 current=release('4.1.0','bbbbbbbbbbbbbbbb');await a.evaluate(()=>localStorage.setItem('qa_pending','3'));await a.evaluate(()=>window.TestPWA.checkForUpdates());await a.locator('#app-update-apply').click();await a.locator('#app-update-dialog[data-paused]').waitFor();assert.match(await a.locator('#app-update-detail').textContent(),/3 несинхронизированных/);assert.equal(await a.evaluate(()=>localStorage.getItem('qa_pending')),'3');assert.equal(await a.locator('meta[name="test-app-build"]').getAttribute('content'),'aaaaaaaaaaaaaaaa');
 console.log('PASS pending trips produce a visible counted explanation and prevent reload');
 await a.screenshot({path:process.env.PWA_WARNING_SCREENSHOT||'/tmp/samosval-update-paused.png'});
 await a.evaluate(()=>{document.getElementById('app-update-dialog').close();localStorage.setItem('qa_pending','0');window.__progressSamples=[];new MutationObserver(()=>{const p=document.getElementById('app-update-progress');if(p?.hasAttribute('value'))window.__progressSamples.push({value:p.value,max:p.max});}).observe(document.body,{subtree:true,attributes:true,characterData:true,childList:true});});
 await a.locator('#app-update-apply').click();
 await a.waitForFunction(()=>document.querySelector('meta[name="test-app-build"]')?.content==='bbbbbbbbbbbbbbbb',{},{timeout:120000});await a.waitForFunction(()=>window.TestPWA?.snapshot().shellReady);
 assert.equal(await b.locator('meta[name="test-app-build"]').getAttribute('content'),'aaaaaaaaaaaaaaaa','Other open page is preserved');assert.equal(await a.evaluate(()=>localStorage.getItem('qa_pending')),'0');assert(await b.locator('body').isVisible());
 console.log('PASS verified update activates and reloads initiating page with second window left open');
 current=release('4.1.1','cccccccccccccccc');await a.evaluate(()=>window.TestPWA.checkForUpdates());await a.locator('#app-update-apply').click();await a.waitForFunction(()=>document.querySelector('#app-update-progress')?.hasAttribute('value'),{},{timeout:15000});const shown=await a.locator('#app-update-count').textContent();assert.match(shown,/из \d+ файлов/);await a.screenshot({path:process.env.PWA_PROGRESS_SCREENSHOT||'/tmp/samosval-update-progress.png'});try{await a.waitForFunction(()=>document.querySelector('meta[name="test-app-build"]')?.content==='cccccccccccccccc',{},{timeout:35000});}catch(e){console.log('UPGRADE_STATE',await a.evaluate(()=>({pwa:window.TestPWA.snapshot(),text:document.getElementById('app-update-detail')?.textContent,phase:document.getElementById('app-update-phase')?.textContent,banner:document.getElementById('app-update-status')?.textContent,workers:undefined})));throw e;}
 console.log('PASS live progress reports verified file count; successive update works with open old window');assert.deepEqual(errors,[],'No browser runtime errors');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
