'use strict';
// Infrastructure/mock checks only. Does not launch Chromium, an emulator, or any
// application payload. The browser acceptance result must come from browser-run.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), {createHash} = require('node:crypto');
const {PROJECT,DEMO_CONFIG,allowedUrl,rewriteDemoSource,createLocalServer,installBrowserFixture,pngDetails,readWithRulesDisabled} = require('./browser-support.cjs');
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
    assert.equal(html.headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=()');
    assert.equal((await fetch(origin + '/Samosval/unserved-file.txt')).status,404);
    assert.equal((await fetch(origin + '/Samosval/index-test.html',{method:'POST'})).status,405);
    const worker=await (await fetch(origin + '/Samosval/sw-test.js')).text();
    new vm.Script(worker);
    const records=JSON.parse(worker.match(/^const RECORDS = (\[.*\]);$/m)[1]);
    assert(records.length > 20,'Must cover the real modular app release');
    for (const record of records) {
      const response=await fetch(new URL(record.url,origin + '/Samosval/sw-test.js')); assert.equal(response.status,200,record.url);
      const bytes=Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256,record.url);
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

(async () => {
  const context={fixture:'emulator context'}, environment={async withSecurityRulesDisabled(callback){await callback(context);}};
  assert.deepEqual(await readWithRulesDisabled(environment,async actual=>{assert.equal(actual,context);return [{id:'actual-sdk-row'}];}),[{id:'actual-sdk-row'}]);
  assert.deepEqual(await readWithRulesDisabled(environment,async()=>({load:2})),{load:2});
  await assert.rejects(()=>readWithRulesDisabled(environment,async()=>{throw Error('Read failed');}),/Read failed/);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGv8AAAAASUVORK5CYII=','base64');
  assert.deepEqual(pngDetails(png),{width:1,height:1});
  assert.throws(()=>pngDetails(Buffer.from('PNG fixture')),/signature/);
  assert.throws(()=>pngDetails(png.subarray(0,png.length-3)),/Incomplete/);
  await testFixture(); await testServer();
})().catch(error => {console.error(error);process.exitCode=1;});
