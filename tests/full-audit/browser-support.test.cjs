'use strict';
// Infrastructure/mock checks only. Does not launch Chromium, an emulator, or any
// application payload. The browser acceptance result must come from browser-run.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), {createHash} = require('node:crypto');
const {PROJECT,DEMO_CONFIG,FIRESTORE_PROBE_FIXTURE,allowedUrl,rewriteDemoSource,rewriteConnectivityProbe,createLocalServer,installBrowserFixture,pngDetails,readWithRulesDisabled} = require('./browser-support.cjs');
const root = path.resolve(__dirname,'../..');

async function testFixture() {
  const loaded = [], stores = new Map(), initialized = [], emulatorCalls = [], settingsCalls = [], events={}, streamed=[];
  const makeDb = () => ({useEmulator:(...args) => emulatorCalls.push(args),settings:value => settingsCalls.push(value)});
  const original = {auth:Object.assign(() => {throw Error('Real Auth must never be used');},{marker:'static-preserved'}),
    storage:() => {throw Error('Real Storage must never be used');},
    initializeApp:(config,name) => { initialized.push({config,name}); const db=makeDb(); return {options:config,firestore:() => db}; }};
  const ctx = {window:{firebase:original,addEventListener:(type,callback)=>events[type]=callback,__auditReport:(type,detail)=>streamed.push({type,detail})},document:{addEventListener:(type,callback) => {if(type === 'load') loaded.push(callback);else events[type]=callback;}},
    localStorage:{getItem:key => stores.get(key) || null,setItem:(key,value) => stores.set(key,value),removeItem:key => stores.delete(key)},
    setTimeout:callback => callback()};
  vm.createContext(ctx); vm.runInContext('(' + installBrowserFixture.toString() + ')(' + JSON.stringify({port:8099,uid:'qa',project:PROJECT,config:DEMO_CONFIG}) + ')',ctx);
  assert.equal(loaded.length,1); loaded[0]({target:{tagName:'SCRIPT',src:'http://127.0.0.1/html2pdf-local.js'}});
  assert.equal(ctx.window.__auditFixture.ready,true);
  const sdk=ctx.window.firebase, app=sdk.initializeApp({projectId:'not-the-demo'},'fixture-app');
  assert.equal(initialized[0].config.projectId,PROJECT); assert.equal(initialized[0].config.apiKey,'local-demo-not-a-credential');
  assert.equal(emulatorCalls[0][0],'127.0.0.1'); assert.equal(emulatorCalls[0][1],8099); assert.equal(emulatorCalls[0][2].mockUserToken.sub,'qa');
  app.firestore().settings({experimentalForceLongPolling:true}); assert.equal(settingsCalls[0].host,'127.0.0.1:8099'); assert.equal(settingsCalls[0].ssl,false);
  assert.equal(sdk.auth.marker,'static-preserved'); assert.equal(app.auth(),sdk.auth());
  const seen=[], unsubscribe=sdk.auth().onAuthStateChanged(user => seen.push(user?.uid || null));
  await assert.rejects(sdk.auth().signInWithEmailAndPassword('qa@example.test','wrong'),error => error.code==='auth/invalid-credential');
  await sdk.auth().signInWithEmailAndPassword('qa@example.test','local-demo-password');
  assert.deepEqual(seen,[null,'qa']); assert.equal([...stores.values()].includes('local-demo-password'),false);
  await sdk.auth().signOut(); assert.deepEqual(seen,[null,'qa',null]); unsubscribe();
  await sdk.auth().createUserWithEmailAndPassword('qa@example.test','local-demo-password'); assert.deepEqual(seen,[null,'qa',null]);
  assert.throws(() => sdk.storage().ref('anything'),/Storage is prohibited/);
  assert.equal(ctx.window.__auditFixture.blockedStorageCalls,1);
  events.unhandledrejection({reason:new Error('fixture rejection')});
  events.securitypolicyviolation({blockedURI:'https://invalid.example',violatedDirective:'connect-src'});
  assert.equal(streamed.length,2,'Errors/CSP must be streamed before reload discards the document');
  assert.match(streamed[0].detail.message,/fixture rejection/); assert.equal(streamed[1].type,'csp');
  console.log('PASS browser infrastructure mock: Auth stub lifecycle, inert demo config, emulator-only Firestore, disabled Storage');
}

async function testServer() {
  const log=[], errors=[], server=createLocalServer(root,8099,log); server.on('audit-error',error => errors.push(error));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:' + server.address().port;
  try {
    assert(allowedUrl(origin + '/Samosval/index-test.html',origin,8099));
    assert(allowedUrl('http://127.0.0.1:8099/google.firestore.v1.Firestore/Listen/channel',origin,8099));
    for (const url of ['https://example.com/','https://firestore.googleapis.com/','http://127.0.0.1:8181/','http://localhost:8099/','file:///tmp/app','not-a-url']) assert.equal(allowedUrl(url,origin,8099),false,url);
    const html=await fetch(origin + '/Samosval/index-test.html'); assert.equal(html.status,200);
    assert(html.headers.get('content-security-policy').includes("connect-src 'self' http://127.0.0.1:8099"));
    assert(html.headers.get('content-security-policy').includes("img-src 'self' data: blob:;"));
    assert(!html.headers.get('content-security-policy').includes('google.com'));
    assert.equal(html.headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=()');
    assert.equal((await fetch(origin + '/Samosval/unserved-file.txt')).status,404);
    assert.equal((await fetch(origin + '/Samosval/index-test.html',{method:'POST'})).status,405);
    const worker=await (await fetch(origin + '/Samosval/sw-test.js')).text();
    new vm.Script(worker);
    const records=JSON.parse(worker.match(/^const RECORDS = (\[.*\]);$/m)[1]);
    assert(records.length > 20,'Must cover the real modular app release');
    assert(!records.some(record=>new URL(record.url,origin+'/Samosval/').pathname===FIRESTORE_PROBE_FIXTURE.path),
      'Connectivity image must never be precached');
    for (const suffix of ['', '?zx=first', '?zx=second']) {
      const response=await fetch(origin+FIRESTORE_PROBE_FIXTURE.path+suffix);
      assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),'image/gif');
      assert.equal(response.headers.get('cache-control'),'no-store');
      const bytes=Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.toString('ascii',0,6),'GIF89a');
      assert.equal(bytes.readUInt16LE(6),1); assert.equal(bytes.readUInt16LE(8),1); assert.equal(bytes.at(-1),0x3b);
    }
    const probeHead=await fetch(origin+FIRESTORE_PROBE_FIXTURE.path,{method:'HEAD'});
    assert.equal(probeHead.status,200); assert.equal((await probeHead.arrayBuffer()).byteLength,0);
    assert.equal((await fetch(origin+FIRESTORE_PROBE_FIXTURE.path,{method:'POST'})).status,405);
    for (const record of records) {
      const response=await fetch(new URL(record.url,origin + '/Samosval/sw-test.js')); assert.equal(response.status,200,record.url);
      const bytes=Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256,record.url);
      if (record.url===FIRESTORE_PROBE_FIXTURE.asset) {
        const original=fs.readFileSync(path.join(root,record.url));
        assert.notEqual(record.sha256,FIRESTORE_PROBE_FIXTURE.originalSha256,'Worker must verify rewritten response bytes');
        assert.deepEqual(bytes,rewriteConnectivityProbe(original));
        assert.equal(createHash('sha256').update(original).digest('hex'),FIRESTORE_PROBE_FIXTURE.originalSha256,
          'The checked-in vendor must remain untouched');
      }
      if (record.url.includes('/build/') && record.url.endsWith('.js')) {
        new vm.Script(bytes.toString(),{filename:record.url}); assert(!bytes.toString().includes('samosval-offline'),record.url);
        if (record.url.endsWith('/core.js')) {
          assert(bytes.toString().includes('local-demo-not-a-credential')); assert(!bytes.toString().includes('AIza'));
        }
      }
    }
    assert.deepEqual(errors,[]);
    const original='const firebaseConfig = {projectId:"samosval-offline"};\nconst TEST_FIREBASE_PROJECT_ID = \'samosval-offline\';';
    assert.equal(rewriteDemoSource(original,true).includes(PROJECT),true);
    assert.throws(() => rewriteDemoSource('missing core configuration',true),/exactly one/);
    console.log('PASS browser infrastructure HTTP: local-only routing/CSP, demo response rewrite, syntax and matching integrity hashes for ' + records.length + ' cached release assets');
  } finally { await new Promise(resolve => {server.close(resolve);server.closeAllConnections();}); }
}

function testConnectivityProbe() {
  const original=fs.readFileSync(path.join(root,FIRESTORE_PROBE_FIXTURE.asset));
  const rewritten=rewriteConnectivityProbe(original), source=rewritten.toString();
  new vm.Script(source,{filename:FIRESTORE_PROBE_FIXTURE.asset});
  assert(!source.includes('www.google.com/images/cleardot.gif'));
  assert.equal(source.split(FIRESTORE_PROBE_FIXTURE.path).length,2);
  // The byte diff must be only the reviewed diagnostic construction expression.
  const before='n=new Ct("//www.google.com/images/cleardot.gif"),x.location&&"http"==x.location.protocol||Nt(n,"https"),Mt(n)';
  const after='n=new Ct("'+FIRESTORE_PROBE_FIXTURE.path+'"),Mt(n)';
  assert.equal(source,original.toString().replace(before,after));
  assert.throws(()=>rewriteConnectivityProbe(Buffer.concat([original,Buffer.from('\n')])),/Unexpected Firestore vendor bytes/);
  assert.throws(()=>rewriteConnectivityProbe(rewritten),/Unexpected Firestore vendor bytes/);
  // Execute the actual pinned WebChannel error-handler and image callbacks in
  // an isolated mock. This checks both success/failure remain real callbacks,
  // not fabricated onload/suppressed errors; CI still owns native browser proof.
  function exercise(bytes,event) {
    const code=bytes.toString(), handler=code.slice(code.indexOf('function zn('),code.indexOf('function Kn('));
    const callback=code.slice(code.indexOf('function on('),code.indexOf('function un('));
    assert(handler && callback);
    const images=[], result=[], cleanup=[], timers=[];
    const base='http://127.0.0.1:12345/Samosval/index-test.html';
    const ctx={x:{Image:true,location:{protocol:'http:'},setTimeout:fn=>timers.push(fn)},
      Image:class {constructor(){images.push(this);}}, Ke:class {},
      Ct:class {constructor(url){this.url=new URL(url,base);} toString(){return this.url.href;}},
      Nt:(uri,scheme)=>{uri.url.protocol=scheme;}, Mt:uri=>uri.url.searchParams.set('zx','mock-nonce'),
      L:(fn,self)=>fn.bind(self),M:(fn,...args)=>(...rest)=>fn(...args,...rest),
      Kn:()=>cleanup.push('Kn'),Rn:()=>cleanup.push('Rn'),Ze:()=>{throw Error('Unexpected non-network error');},
      channel:{l:{info(){}},h:null,pb:value=>result.push(value),H:7}};
    vm.createContext(ctx);vm.runInContext(callback+';'+handler+';zn(channel,2);',ctx);
    assert.equal(images.length,1); assert.deepEqual(result,[],'Probe must wait for a genuine image outcome');
    assert.equal(ctx.channel.H,0); assert.deepEqual(cleanup,['Kn','Rn']); assert.equal(timers.length,1);
    const img=images[0]; assert.equal(typeof img.onload,'function'); assert.equal(typeof img.onerror,'function');
    if(event==='timeout') timers[0](); else img[event]();
    assert.deepEqual(result,[event==='onload']);
    assert.equal(img.onload,null); assert.equal(img.onerror,null); assert.equal(img.ontimeout,null);
    timers[0](); assert.equal(result.length,1,'Late timeout must not double-report');
    return new URL(img.src);
  }
  for (const event of ['onload','onerror','onabort','timeout']) {
    assert.equal(exercise(original,event).origin,'https://www.google.com');
    const local=exercise(rewritten,event);
    assert.equal(local.origin,'http://127.0.0.1:12345');
    assert.equal(local.pathname,FIRESTORE_PROBE_FIXTURE.path); assert.equal(local.search,'?zx=mock-nonce');
  }
  console.log('PASS browser infrastructure probe: pinned one-fragment rewrite, same-origin uncached GIF, original success/error/abort/timeout callbacks retained');
}

async function testUpgradeNetworkFixture() {
  // Exercise the Python harness's exact serialized JS without a browser. This
  // does not substitute for the CI upgrade, but prevents isolation regressions.
  const python=fs.readFileSync(path.join(root,'tests/pwa/update-browser.py'),'utf8');
  const fixture=python.match(/^FIXTURE = r'''([\s\S]*?)'''/m)?.[1]; assert(fixture);
  const events={}, calls=[], reports=[];
  let persistenceError;
  const sdk={auth:()=>{},storage:()=>{},initializeApp:config=>{
    const db={settings(){calls.push('settings');},enablePersistence(){calls.push('persistence');return persistenceError?Promise.reject(persistenceError):Promise.resolve('real-persistence-result');},
      disableNetwork(){calls.push('disable-network');return Promise.resolve();}};
    return {options:config,firestore:()=>db};
  }};
  const ctx={window:{firebase:sdk,__upgradeReport:value=>reports.push(value),addEventListener(){}},
    document:{addEventListener:(type,fn)=>events[type]=fn},Promise,setTimeout};
  vm.createContext(ctx);vm.runInContext('('+fixture+')()',ctx);
  events.load({target:{tagName:'SCRIPT',src:'/html2pdf-local.js'}});
  const config={projectId:'demo-samosval-upgrade-audit',apiKey:'local-demo-not-a-credential'};
  const app=sdk.initializeApp(config);
  assert.deepEqual(calls,['settings'],'Network must not start before app config/persistence');
  const persisted=app.firestore().enablePersistence({synchronizeTabs:true});
  assert.deepEqual(calls,['settings','persistence','disable-network'],'Disable queues immediately after real persistence, before listeners');
  assert.equal(await persisted,'real-persistence-result');
  assert.equal(ctx.window.__upgradeFixture.networkDisabled,true);
  sdk.initializeApp(config,'Secondary');
  assert.deepEqual(calls.slice(-2),['settings','disable-network'],'Secondary app is also offline');
  assert.throws(()=>sdk.initializeApp({projectId:'live-project'}),/Non-demo/);
  assert.deepEqual(reports,[]);
  // A genuine persistence error must remain visible, never converted to success.
  const rejected=Object.assign(Error('persistence denied'),{code:'failed-precondition'});
  persistenceError=rejected; ctx.window.__upgradeFixture.networkDisabled=false;
  await assert.rejects(()=>sdk.initializeApp(config).firestore().enablePersistence(),error=>error===rejected);
  assert.equal(ctx.window.__upgradeFixture.networkDisabled,false,'Failed persistence must not claim fixture ready');
  assert.deepEqual(calls.slice(-3),['settings','persistence','disable-network']);
  console.log('PASS upgrade infrastructure mock: real persistence result retained; primary/secondary SDK networking disabled before roles/listeners');
}

(async () => {
  const context={fixture:'emulator context'}, environment={async withSecurityRulesDisabled(callback){await callback(context);}};
  assert.deepEqual(await readWithRulesDisabled(environment,async actual=>{assert.equal(actual,context);return [{id:'actual-sdk-row'}];}),[{id:'actual-sdk-row'}]);
  assert.deepEqual(await readWithRulesDisabled(environment,async()=>({load:2})),{load:2});
  await assert.rejects(()=>readWithRulesDisabled(environment,async()=>{throw Error('Read failed');}),/Read failed/);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGv8AAAAASUVORK5CYII=','base64');
  assert.deepEqual(pngDetails(png),{width:1,height:1});
  assert.throws(()=>pngDetails(Buffer.from('PNG fixture')),/signature/);
  assert.throws(()=>pngDetails(png.subarray(0,png.length-3)),/Incomplete/);
  testConnectivityProbe(); await testFixture(); await testUpgradeNetworkFixture(); await testServer();
})().catch(error => {console.error(error);process.exitCode=1;});
