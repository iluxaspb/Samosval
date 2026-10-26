// Real Firebase SDK + deployed-source test rules, with isolated demo data only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), vm = require('node:vm');
const {webcrypto}=require('node:crypto');
const {spawn} = require('node:child_process');
const firebase = require('firebase/compat/app'); require('firebase/compat/firestore');
const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const {doc, setDoc} = require('firebase/firestore');
const {client, server, plain} = require('./offline-harness.cjs');
const root = path.resolve(__dirname, '../..'), project = 'demo-offline-audit';
const port = Number(process.env.OFFLINE_FIRESTORE_PORT || 8098), apps = [];
const jar = process.env.FIRESTORE_EMULATOR_JAR;
assert(jar && fs.existsSync(jar), 'Set FIRESTORE_EMULATOR_JAR to the local emulator JAR');
const emulator = spawn('java', ['-Xmx512m', '-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--project_id', project]);
let log = '', env;
emulator.stdout.on('data', chunk => log += chunk); emulator.stderr.on('data', chunk => log += chunk);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {console.error('FAIL emulator suite timed out\n' + log.slice(-3000)); emulator.kill(); process.exit(1);}, 90000);

function connect(uid, options = {}) {
  const x = client(server(), {uid, ...options});
  const app = firebase.initializeApp({projectId: project, apiKey: 'local-demo'}, 'offline-' + uid + '-' + apps.length);
  apps.push(app); const db = app.firestore();
  db.useEmulator('127.0.0.1', port, {mockUserToken: {sub: uid, email: uid + '@example.com'}});
  const ws = db.collection('workspaces').doc('main_workspace');
  x.c.refs.shift = ws.collection('shift').doc('current');
  for (const name of ['truckStatus', 'logs','trucks','objects','archive','trash']) x.c.refs[name] = ws.collection(name);
  // Keep actual DocumentReferences for receipt transactions, while normalizing
  // VM-realm payloads on the independent notification/audit effect writes.
  for (const name of ['audit', 'notifications']) {
    const col=ws.collection(name);
    x.c.refs[name]={get:(...args)=>col.get(...args),doc:id=>{
      const ref=col.doc(id),set=ref.set.bind(ref);ref.set=data=>set(plain(data));return ref;
    }};
  }
  x.c.appConfigRef = db.doc('settings/appConfig');
  x.c.setTimeout = setTimeout; x.c.clearTimeout = clearTimeout;
  // Run the actual canonical history wrapper around the real SDK transaction.
  // Normalize VM values only at the SDK boundary; DocumentReferences remain real.
  const transaction=db.runTransaction.bind(db);
  db.runTransaction = async (fn,options) => {
    const result = await transaction(tx => fn({get: ref => tx.get(ref),
      set: (ref, data,options) => options?tx.set(ref,plain(data),options):tx.set(ref, plain(data)),
      update: (ref, data) => tx.update(ref, plain(data)),delete:ref=>tx.delete(ref)}),options);
    if (x.loseReply && result?.didCommit) {x.loseReply = false; throw {code: 'unavailable', message: 'Injected lost commit reply'};}
    return result;
  };
  x.c.db=db;Object.assign(x.c,{crypto:webcrypto,Blob,TextEncoder,Uint8Array});
  const coins=fs.readFileSync(path.join(root,'test-app/src/features/game-coins-v2.js'),'utf8');
  vm.runInContext(coins.slice(0,coins.indexOf('  let records='))+'})();',x.c);
  vm.runInContext(fs.readFileSync(path.join(root,'test-app/src/features/history-recorder.js'),'utf8'),x.c);
  x.db = db; return x;
}
async function seed() {
  await env.clearFirestore(); const initial = server();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, 'settings/appConfig'), {cycleMinutes: 15,gameRewardSchedule:[{effectiveAt:1,load:5,arrive:7,ttn:3}]}),
      setDoc(doc(db, 'settings/permissions'), {lopater: {actions: ['action_load', 'action_arrive', 'action_ttn', 'undo_action']}}),
      ...['a', 'b'].map(uid => setDoc(doc(db, 'users/' + uid), {email: uid + '@example.com', role: 'lopater', status: 'active'})),
      setDoc(doc(db, 'workspaces/main_workspace/shift/current'), initial.rows.get('shift')),
      setDoc(doc(db, 'workspaces/main_workspace/truckStatus/t'), initial.rows.get('truckStatus/t'))
    ]);
  });
}
async function replay(x) {x.c.navigator.onLine = true; await x.c.offlineReplayJournal(); await x.c.offlineReplayEffects();}
const queue = (x,type='load') => assert(x.c.offlineQueueAction(type, 't', x.c.captureLineIntent('t')));
async function syncStatus(x){const status=(await x.c.refs.truckStatus.doc('t').get({source:'server'})).data();x.c.state.truckStatus.t=plain(status);x.run('offlineRemoteStatuses.t={...state.truckStatus.t}');}

(async () => {
  for (let attempt = 0; attempt < 300 && !log.includes('Dev App Server is now running'); attempt++) await delay(100);
  assert(log.includes('Dev App Server is now running'), log.slice(-3000));
  env = await initializeTestEnvironment({projectId: project, firestore: {host: '127.0.0.1', port,
    rules: fs.readFileSync(path.join(root, 'firestore-timesheet-test.rules'), 'utf8')}});
  await seed(); const a = connect('a'), b = connect('b'); queue(a); queue(b);
  await Promise.all([replay(a), replay(b)]);
  assert.equal((await a.c.refs.logs.get()).size, 1);
  assert.deepEqual([a, b].map(x => x.c.offlineJournalRead()[0].status).sort(), ['confirmed', 'rejected']);
  assert.equal((await a.db.collection('workspaces/main_workspace/audit').get()).size, 2);
  assert.equal((await a.db.collection('workspaces/main_workspace/notifications').get()).size, 1);
  const firstAudit=(await a.c.refs.audit.get()).docs.map(doc=>({id:doc.id,...doc.data()}));
  const firstHistory=firstAudit.find(row=>row.eventType==='history');
  assert(firstHistory);assert.equal(firstHistory.history.operations.length,2);
  assert.equal(firstHistory.history.gameRewards.load,5);assert.equal(firstHistory.history.gameRewards.actionAt,1000000);
  assert.equal(a.c.window.__gameCoinsCore.calculate(firstAudit)[0].coins,5);
  console.log('PASS REAL FIRESTORE two competing offline clients produce one trip, atomic receipt + canonical history, and notification under current test rules');

  await seed(); const first = connect('a'); queue(first); first.loseReply = true;
  await replay(first); assert.equal(first.c.offlinePendingCount(), 1);
  const restarted = connect('a', {storage: first.storage}); await replay(restarted);
  assert.equal(restarted.c.offlinePendingCount(), 0); assert.equal((await restarted.c.refs.logs.get()).size, 1);
  assert.equal((await restarted.db.collection('workspaces/main_workspace/audit').get()).size, 2);
  console.log('PASS REAL FIRESTORE successful commit with lost acknowledgement survives restart without duplicate');

  for(const type of ['ttn','arrive']){
    await seed();
    if(type==='ttn')await env.withSecurityRulesDisabled(context=>setDoc(doc(context.firestore(),'workspaces/main_workspace/truckStatus/t'),
      {...server().rows.get('truckStatus/t'),ttnStatus:true,ttnBy:'earlier',ttnRevision:7,ttnLogId:'old'}));
    const winner=connect('b'),loser=connect('a');await syncStatus(winner);await syncStatus(loser);queue(winner,type);queue(loser,type);
    await replay(winner);await replay(loser);
    assert.equal(winner.c.offlineJournalRead()[0].status,'confirmed');assert.equal(loser.c.offlineJournalRead()[0].status,'rejected');
    assert.equal((await winner.c.refs.audit.get()).size,2);assert.equal((await winner.c.refs.notifications.get()).size,1);
    const receipt=(await winner.c.refs.audit.get()).docs.find(doc=>doc.data().offlineReceipt);assert.equal(receipt.data().offlineReceipt.version,1);
    await assert.rejects(receipt.ref.set({...receipt.data(),text:'changed receipt'}));
    console.log('PASS REAL FIRESTORE '+type+' cancellation is attributed once with an immutable atomic audit receipt');
  }

  await seed();const lostTtn=connect('a');queue(lostTtn,'ttn');lostTtn.loseReply=true;await replay(lostTtn);
  assert.equal(lostTtn.c.offlinePendingCount(),1);
  const laterTtn=connect('b');await syncStatus(laterTtn);queue(laterTtn,'ttn');await replay(laterTtn);
  const ttnRetry=connect('a',{storage:lostTtn.storage});await syncStatus(ttnRetry);await replay(ttnRetry);
  assert.equal(ttnRetry.c.offlineJournalRead()[0].status,'confirmed');assert.equal((await ttnRetry.c.refs.truckStatus.doc('t').get()).data().ttnStatus,null);
  assert.equal((await ttnRetry.c.refs.audit.get()).size,4);assert.equal((await ttnRetry.c.refs.notifications.get()).size,2);
  console.log('PASS REAL FIRESTORE lost TTN reply after a later cancellation confirms its receipt without overwriting the later state');

  await seed(); const denied = connect('a'); queue(denied);
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'settings/permissions'), {lopater: {actions: []}}));
  await replay(denied); assert.equal((await denied.c.refs.logs.get()).size, 0);
  assert.equal(denied.c.offlineJournalRead()[0].status, 'rejected');
  console.log('PASS REAL FIRESTORE changed permissions reject the queued action without creating a trip');

  await seed(); const closed = connect('a'); queue(closed);
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'workspaces/main_workspace/shift/current'), {id: 'next', isActive: true}));
  await replay(closed); assert.equal((await closed.c.refs.logs.get()).size, 0);
  assert.equal(closed.c.offlineJournalRead()[0].result, 'shift-changed');
  console.log('PASS REAL FIRESTORE stale queued action cannot enter a newer shift');
})().catch(error => {console.error(error); console.error(log.slice(-2000)); process.exitCode = 1;})
  .finally(async () => {for (const app of apps) await app.delete(); if (env) await env.cleanup(); emulator.kill(); clearTimeout(watchdog);});
