const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {client,server,createLockManager,plain}=require('./offline-harness.cjs');
const watchdog=setTimeout(()=>{console.error('FAIL ownership checks did not complete');process.exit(1);},5000);
const root=path.resolve(__dirname,'../..');
const queue=x=>x.c.offlineQueueAction('load','t',x.c.captureLineIntent('t'));
const get=(x)=>JSON.stringify(x.c.offlineJournalRead());
(async()=>{
  const locks=createLockManager(),storage=new Map(),shared=server();
  const a=client(shared,{locks,storage}),b=client(shared,{locks,storage});
  assert(a.c.offlineJournalCanWrite());assert(!b.c.offlineJournalCanWrite());
  assert.equal(b.c.offlineJournalOwnershipStatus(),'Учёт открыт в другой вкладке. Продолжите там или закройте её.');
  const stale=b.c.offlineJournalRead();assert(queue(a));const original=get(a);
  assert.equal(queue(b),false);assert.throws(()=>b.c.offlineJournalWrite(stale),/другой вкладке/);
  b.c.undoLastOfflineAction();assert.equal(get(a),original);
  b.c.navigator.onLine=true;await b.c.offlineReplayJournal();b.c.navigator.onLine=false;
  assert.equal(shared.rows.size,3,'Waiting tab must not replay');
  console.log('PASS two same-account tabs cannot overwrite or cancel each other\'s pending actions');

  const rejected={id:'unseen',shiftId:'s',truckId:'t',status:'rejected',result:'duplicate',createdAt:1000000};
  a.c.offlineJournalWrite([...a.c.offlineJournalRead(),rejected]);
  const sync=fs.readFileSync(path.join(root,'test-app/src/core/06-sync.js'),'utf8');
  Object.assign(b.c,{ROLES:{lopater:{label:'Operator'}},pendingOps:0,location:{pathname:'/index-test.html'},appNotice(){}});
  b.c.state.patches=[];b.c.syncState.docCount={};
  vm.runInContext(sync.slice(sync.indexOf('  function showSyncDiagnostics'),sync.indexOf('  function stopSync')),b.c);
  b.c.showSyncDiagnostics();assert.equal(a.c.offlineJournalRead().find(x=>x.id==='unseen').reviewed,undefined);
  console.log('PASS diagnostics in a waiting tab do not mark conflicts reviewed or rewrite the journal');

  const priorOwner=a.c.offlineJournalSessionToken();
  a.events.get('pagehide')();await b.tick();
  assert(!a.c.offlineJournalOwns(priorOwner));assert(b.c.offlineJournalCanWrite());
  assert.equal(b.c.offlinePendingCount(),1);assert.equal(b.c.state.logs.length,1);
  assert.equal(a.c.offlineJournalCanWrite(),false,'A hidden old page must not reacquire on a late callback');
  assert(b.c.offlineQueueAction('ttn','t',b.c.captureLineIntent('t')));assert.equal(b.c.offlinePendingCount(),2);
  console.log('PASS owner exit hands off automatically and reprojects the old durable pending queue');

  b.c.offlineReleaseJournalOwnership();b.c.currentUid='new-user';b.c.currentEmail='new-user@example.com';
  await b.c.offlineEnsureJournalOwnership();assert(b.c.offlineJournalCanWrite());assert.equal(b.c.offlinePendingCount(),0);
  a.events.get('pageshow')();await a.tick();assert(a.c.offlineJournalCanWrite());assert.equal(a.c.offlinePendingCount(),2);
  assert(b.c.offlineJournalCanWrite(),'Different accounts must have independent ownership locks');
  console.log('PASS logout/login releases the old account, isolates new account data and preserves old pending actions');

  const cancelLocks=createLockManager(),held=client(server(),{locks:cancelLocks}),cancelledWait=client(held.shared,{locks:cancelLocks});
  assert(!cancelledWait.c.offlineJournalCanWrite());
  cancelledWait.c.offlineReleaseJournalOwnership();cancelledWait.c.currentUid='different';
  await cancelledWait.c.offlineEnsureJournalOwnership();
  held.events.get('pagehide')();await cancelledWait.tick();
  const successor=client(held.shared,{locks:cancelLocks});assert(successor.c.offlineJournalCanWrite());
  assert(cancelledWait.c.offlineJournalCanWrite());
  console.log('PASS changing accounts while waiting aborts the old lock request without orphaning it');

  const unsupported=client(server(),{locks:null});
  assert.equal(queue(unsupported),false);assert.equal(unsupported.c.offlinePendingCount(),0);
  assert.match(unsupported.c.offlineJournalOwnershipStatus(),/браузер не поддерживает безопасную запись/);
  console.log('PASS browsers without Web Locks fail closed with a visible explanation');

  const lock2=createLockManager(),disk2=new Map(),late=client(server(),{locks:lock2,storage:disk2}),next=client(late.shared,{locks:lock2,storage:disk2});
  assert(queue(late));const raw=late.c.db.runTransaction;let release;
  late.c.db.runTransaction=async fn=>{const result=await raw(fn);await new Promise(resolve=>release=resolve);return result;};
  late.c.navigator.onLine=true;const sending=late.c.offlineReplayJournal();await late.tick();assert(release);
  late.events.get('pagehide')();await next.tick();release();await sending;
  assert.equal(next.c.offlinePendingCount(),1,'Late old-owner response must not modify the new owner\'s journal');
  next.c.navigator.onLine=true;await next.c.offlineReplayJournal();await next.c.offlineReplayEffects();
  assert.equal(next.c.offlinePendingCount(),0);assert.equal([...next.shared.rows.keys()].filter(k=>k.startsWith('logs/')).length,1);
  console.log('PASS late response after handoff cannot overwrite journal; new owner resolves the committed action idempotently');

  const penalties=fs.readFileSync(path.join(root,'test-app/src/features/game-coins-v2.js'),'utf8');
  const fn=penalties.slice(penalties.indexOf('  window.__gameFlushPenalties=async()=>{'),penalties.indexOf('  setInterval(()=>window.__gameFlushPenalties'));
  const waiting=client(shared,{locks,storage});waiting.c.navigator.onLine=true;waiting.c.flushBusy=false;let writes=0;
  waiting.c.window.__historyRawTransaction=async()=>writes++;
  vm.runInContext(fn,waiting.c);await waiting.c.window.__gameFlushPenalties();assert.equal(writes,0);
  console.log('PASS secondary tabs do not start penalty transactions or mark penalty delivery');

  const penaltyOwner=client();penaltyOwner.c.navigator.onLine=true;penaltyOwner.c.flushBusy=false;
  penaltyOwner.c.offlineJournalWrite([{id:'cancelled',shiftId:'s',truckId:'t',status:'cancelled',type:'load',actor:'a',email:'a@example.com'}]);
  let releasePenalty,penaltyWrites=0;
  penaltyOwner.c.window.__historyRawTransaction=fn=>fn({});
  penaltyOwner.c.window.__gameStagePenalty=async()=>{await new Promise(resolve=>releasePenalty=resolve);return()=>penaltyWrites++;};
  vm.runInContext(fn,penaltyOwner.c);const flushing=penaltyOwner.c.window.__gameFlushPenalties();await penaltyOwner.tick();
  penaltyOwner.events.get('pagehide')();releasePenalty();await flushing;
  assert.equal(penaltyWrites,0);assert(!penaltyOwner.c.offlineJournalRead()[0].penaltyDelivered);
  console.log('PASS losing ownership during penalty staging prevents both server write and journal acknowledgement');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
