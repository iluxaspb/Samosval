// Real Firestore SDK + local emulator, two isolated browser devices. No live account.
const assert=require('node:assert/strict'),fs=require('node:fs'),{spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const qa=createRequire(process.env.TABEL_SYNC_QA+'/package.json');
const {initializeTestEnvironment,assertSucceeds,assertFails}=qa('@firebase/rules-unit-testing');
const {doc,setDoc,getDoc,deleteDoc}=qa('firebase/firestore');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const server=spawn('python3',['-m','http.server','8804','--bind','127.0.0.1'],{stdio:'ignore'});
(async()=>{let browser,env;try{
 env=await initializeTestEnvironment({projectId:'demo-tabel-next',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore-tabel-next-test.rules','utf8')}});
 await env.clearFirestore();
 await env.withSecurityRulesDisabled(async c=>{
  const db=c.firestore();
  for(const [id,role,status] of [['admin','admin','active'],['editor','foreman','active'],['viewer','viewer','active'],['reader','reader','active'],['disabled','operator','disabled']]) await setDoc(doc(db,'users',id),{role,status});
  await setDoc(doc(db,'settings/permissions'),{foreman:{tabs:['timesheet'],actions:['timesheet_edit']},operator:{tabs:['timesheet'],actions:['timesheet_edit']},viewer:{tabs:[],actions:[]},reader:{tabs:['timesheet'],actions:[]}});
 });
 const db=uid=>env.authenticatedContext(uid).firestore(),path='workspaces/main_workspace/tabelNextRecords/site~config';
 await assertFails(getDoc(doc(db('viewer'),path)));
 await assertFails(getDoc(doc(db('disabled'),path)));
 await assertFails(setDoc(doc(db('editor'),path),{revision:1,data:{}}));
 await assertFails(deleteDoc(doc(db('admin'),path)));
 browser=await chromium.launch({headless:true,executablePath:'/tmp/tabel-chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const create=async uid=>{
  const context=await browser.newContext();const p=await context.newPage();
  await p.goto('http://127.0.0.1:8804/tests/tabel-v2/harness.html');
  for(const name of ['app','firestore']) await p.addScriptTag({content:fs.readFileSync(process.env.TABEL_SYNC_QA+'/node_modules/firebase/firebase-'+name+'-compat.js','utf8')});
  await p.evaluate(async uid=>{
   firebase.initializeApp({projectId:'demo-tabel-next',apiKey:'emulator',appId:'emulator'});
   const db=firebase.firestore();db.useEmulator('127.0.0.1',8080,{mockUserToken:{sub:uid,email:uid+'@example.test'}});
   const {Store,firestoreRemote}=await import('../../test-app/tabel-v2/store.mjs');
   window.remote=firestoreRemote({workspace:db.collection('workspaces').doc('main_workspace'),transaction:fn=>db.runTransaction(fn),session:()=>({uid,name:uid,role:uid==='admin'?'admin':'foreman',status:'active',tabAccess:true})},()=>{});
   window.store=await new Store('emulator-device',remote,()=>({uid,name:uid})).open();
   clearInterval(store.timer);
  },uid);return p;
 };
 const a=await create('admin'),b=await create('editor');
 // Upload snapshots created by the local-only releases; ignore local migration marker.
 await a.evaluate(async()=>{await store.serialize(async()=>{store.state.records['site/config']={revision:0,data:{name:'Старый объект'}};store.state.records['site/migration']={revision:0,data:{source:'legacy'}};await store.persist();});await store.prepareSync();await store.flush();});
 assert.equal(await a.evaluate(()=>store.state.jobs.length),0);
 await b.evaluate(()=>store.pullObject('site'));
 assert.equal(await b.evaluate(()=>store.get('site/config').data.name),'Старый объект');
 await assertSucceeds(getDoc(doc(db('reader'),path)));
 await assertFails(setDoc(doc(db('reader'),path),{revision:9,data:{}}));
 await assertFails(setDoc(doc(db('editor'),'workspaces/main_workspace/tabelNextMeta/config'),{enabled:true,schema:1}));
 await assertSucceeds(setDoc(doc(db('admin'),'workspaces/main_workspace/tabelNextMeta/config'),{enabled:true,schema:1}));
 // Config, future shifts, materials and sheets are loaded, without a date-window limit.
 for(const key of ['site/day:2027-12-01:night','site/sheet:one','_catalog/config','_defaults/config']) await a.evaluate(async key=>{await store.save(key,{value:12},store.get(key),'Тест');await store.flush();},key);
 await b.evaluate(()=>store.pullObject('site'));
 assert.equal(await b.evaluate(()=>store.get('site/day:2027-12-01:night').data.value),12);
 assert.equal(await b.evaluate(()=>store.get('site/sheet:one').data.value),12);
 await b.evaluate(()=>store.pull('_catalog/config'));assert.equal(await b.evaluate(()=>store.get('_catalog/config').data.value),12);
 // Live config/day/sheet/global notifications across browser devices.
 await b.evaluate(()=>{window.seen=[];window.stop=remote.watch('site','','',rows=>{seen.push(...rows.map(([k])=>k));return store.accept(rows)},e=>window.watchError=e.message)});
 await a.evaluate(async()=>{await store.save('site/sheet:one',{value:13},store.get('site/sheet:one'),'Live sheet');await store.flush()});
 await b.waitForFunction(()=>store.get('site/sheet:one').data?.value===13,{timeout:10000});
 assert.equal(await b.evaluate(()=>window.watchError),undefined);await b.evaluate(()=>stop());
 // Stale offline edit becomes a conflict retaining both versions.
 await b.evaluate(async()=>{await store.save('site/config',{name:'Правка офлайн'},store.get('site/config'),'Offline')});
 await a.evaluate(async()=>{await store.save('site/config',{name:'Правка A'},store.get('site/config'),'A');await store.flush()});
 await b.evaluate(()=>store.flush());
 assert.equal(await b.evaluate(()=>store.state.jobs[0].status),'conflict');
 assert.equal(await b.evaluate(()=>store.state.jobs[0].remote.data.name),'Правка A');
 await b.evaluate(()=>store.resolve(store.state.jobs[0].id,'mine'));
 assert.equal(await b.evaluate(()=>store.state.jobs.length),0);
 await a.evaluate(()=>store.pull('site/config'));assert.equal(await a.evaluate(()=>store.get('site/config').data.name),'Правка офлайн');
 // A lost acknowledgement retries the same operation, exactly once.
 await a.evaluate(async()=>{const commit=remote.commit;let once=true;remote.commit=async job=>{const r=await commit(job);if(once){once=false;throw Error('Lost acknowledgement')}return r};await store.save('site/config',{name:'Повтор'},store.get('site/config'),'Retry');await store.flush();});
 assert.equal(await a.evaluate(()=>store.state.jobs.length),1);
 await a.evaluate(()=>store.flush());assert.equal(await a.evaluate(()=>store.state.jobs.length),0);
 assert.equal(await a.evaluate(()=>store.get('site/config').revision),4);
 // Server history is available on the second device.
 await b.evaluate(()=>store.pullHistory('site'));
 assert(await b.evaluate(()=>store.state.history.some(h=>h.label==='Retry'&&h.data.name==='Повтор')));
 await assertFails(setDoc(doc(db('viewer'),path),{revision:9,data:{}}));
 await Promise.all([a.evaluate(()=>store.close()),b.evaluate(()=>store.close())]);
 console.log('PASS Firebase emulator: two devices; legacy upload; future/night shifts, sheets, globals; live updates; offline conflicts; lost ACK retry; shared history; unauthorized/read-only/disabled denial.');
 }finally{await browser?.close();await env?.cleanup();server.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
