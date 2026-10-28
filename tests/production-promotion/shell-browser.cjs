const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const server=spawn('python3',['-m','http.server','8824','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{let b;try{
 b=await chromium.launch({executablePath:'/tmp/tabel-chromium',args:['--no-sandbox']});const p=await b.newPage();
 await p.goto('http://127.0.0.1:8824/index.html');
 await p.waitForFunction(()=>window.PROD_APP_RELEASE?.version==='3.4.48');
 assert.equal(await p.evaluate(()=>firebase.app().options.projectId),'samosval-test');
 await p.evaluate(async()=>{localStorage.setItem('qa-production-preserved','pending');const db=await new Promise((ok,no)=>{const r=indexedDB.open('qa-production-upgrade',1);r.onupgradeneeded=()=>r.result.createObjectStore('pending');r.onsuccess=()=>ok(r.result);r.onerror=no});await new Promise((ok,no)=>{const tx=db.transaction('pending','readwrite');tx.objectStore('pending').put({id:'unsent-trip',status:'pending'},'op');tx.oncomplete=ok;tx.onerror=no});db.close();});
 await p.evaluate(async()=>{const reg=await navigator.serviceWorker.register('./sw.js',{scope:'./'});await navigator.serviceWorker.ready;});
 await p.waitForFunction(()=>!!navigator.serviceWorker.controller);
 await p.context().setOffline(true);await p.reload();
 await p.waitForFunction(()=>window.PROD_APP_RELEASE?.version==='3.4.48');
 assert.equal(await p.evaluate(()=>localStorage.getItem('qa-production-preserved')),'pending');
 const saved=await p.evaluate(async()=>{const db=await new Promise(ok=>{const r=indexedDB.open('qa-production-upgrade',1);r.onsuccess=()=>ok(r.result)});return new Promise(ok=>{const r=db.transaction('pending').objectStore('pending').get('op');r.onsuccess=()=>{db.close();ok(r.result)}})});assert.equal(saved.status,'pending');
 assert.equal(await p.evaluate(async()=>typeof(await import('/app/tabel-v2/entry.mjs')).open),'function');
 assert.equal(await p.locator('#nav-tabel-v2').count(),1);
 console.log('PASS actual production shell: correct Firebase project, worker installed, offline reload and lazy timesheet imports, localStorage/IndexedDB pending operation retained');
}finally{await b?.close();server.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
