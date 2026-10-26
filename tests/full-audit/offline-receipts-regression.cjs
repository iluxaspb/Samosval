// Current modular sources, in-memory transactions only; no live services.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {client,server,plain}=require('./offline-harness.cjs');
const tests=[];const test=(name,fn)=>tests.push({name,fn});
const queue=(x,type)=>{assert(x.c.offlineQueueAction(type,'t',x.c.captureLineIntent('t')));return plain(x.c.offlineJournalRead().at(-1));};
const replay=async x=>{x.c.navigator.onLine=true;await x.c.offlineReplayJournal();if(x.c.offlineReplayEffects)await x.c.offlineReplayEffects();};
const setStatus=(s,extra)=>s.put('truckStatus/t',{...s.rows.get('truckStatus/t'),...extra});
const documents=(s,name)=>[...s.rows].filter(([key])=>key.startsWith(name+'/'));
const quickSource=fs.readFileSync('test-app/src/core/25-undo-audit.js','utf8');
function quick(x,notification){
  x.c.state.notifications=[plain(notification)];x.shared.put('notifications/'+notification.id,notification);
  Object.assign(x.c,{lastValidNotification:()=>x.c.state.notifications[0],appConfirm:async()=>true,renderAll(){},reportSyncError(){}});
  Object.assign(x.c.window,{__gamePenaltyScope:()=>({}),__gameStagePenalty:async tx=>{await tx.get(x.ref('penalty'));return ()=>tx.set(x.ref('penalty'),{charged:true});}});
  if(!x.quickInstalled){vm.runInContext(quickSource.slice(0,quickSource.indexOf('  async function addAudit')),x.c);x.quickInstalled=true;}
}
async function loaded(){const x=client();const op=queue(x,'load');await replay(x);const n={id:'offline_'+op.id,...plain(x.shared.rows.get('notifications/offline_'+op.id))};quick(x,n);return {x,op,n};}

test('Competing TTN cancellation never acknowledges the losing operator',async()=>{
 const s=server();setStatus(s,{ttnStatus:true,ttnBy:'first',ttnRevision:7,ttnLogId:'l1'});
 const a=client(s,{uid:'a'}),b=client(s,{uid:'b'});queue(a,'ttn');queue(b,'ttn');await replay(b);await replay(a);
 assert.equal(a.c.offlineJournalRead()[0].status,'rejected');assert.equal(documents(s,'notifications').length,1);assert.equal(documents(s,'audit').length,1);
});
test('Competing arrival cancellation never acknowledges the losing operator',async()=>{
 const s=server(),a=client(s,{uid:'a'}),b=client(s,{uid:'b'});queue(a,'arrive');queue(b,'arrive');await replay(b);await replay(a);
 assert.equal(a.c.offlineJournalRead()[0].status,'rejected');assert.equal(documents(s,'notifications').length,1);
});
test('Same actor and millisecond are not an arrival operation identity',async()=>{
 const s=server();setStatus(s,{arriveStatus:null,arriveTimestamp:null});
 const a=client(s,{uid:'a'}),b=client(s,{uid:'a'});queue(a,'arrive');queue(b,'arrive');await replay(b);await replay(a);
 assert.equal(a.c.offlineJournalRead()[0].status,'rejected');assert.equal(documents(s,'notifications').length,1);
});
test('Durable TTN receipt recognizes a lost reply after another TTN action without restoring old state',async()=>{
 const s=server();setStatus(s,{ttnStatus:true,ttnBy:'first',ttnRevision:7,ttnLogId:'l1'});
 const a=client(s);const op=queue(a,'ttn');s.afterCommit=async writes=>{if(writes.length){s.afterCommit=null;throw {code:'unavailable'};}};
 await replay(a);assert.equal(a.c.offlinePendingCount(),1);
 const b=client(s,{uid:'b'});queue(b,'ttn');await replay(b);
 const restarted=client(s,{storage:a.storage});await replay(restarted);
 assert.equal(restarted.c.offlineJournalRead()[0].status,'confirmed');assert.equal(s.rows.get('truckStatus/t').ttnBy,'b');assert.equal(restarted.c.state.truckStatus.t.ttnBy,'b');
 assert.equal(documents(s,'audit').length,2);assert(s.rows.get('audit/offline_'+op.id).offlineReceipt);
});
test('Audit receipt and action commit together: receipt write failure leaves action pending and server unchanged',async()=>{
 const x=client();queue(x,'arrive');const before=plain(x.shared.rows.get('truckStatus/t'));
 x.shared.beforeCommit=async()=>{throw {code:'unavailable',message:'No connection'};};await replay(x);
 assert.deepEqual(x.shared.rows.get('truckStatus/t'),before);assert.equal(x.c.offlinePendingCount(),1);assert.equal(documents(x.shared,'audit').length,0);
});
test('Queued load keeps the captured volume, truck label and GAI classification across catalog changes',async()=>{
 const x=client();const op=queue(x,'load');x.c.findTruck=()=>({id:'t',brand:'Changed',number:'999',defaultVol:99,isGAI:true});await replay(x);
 const log=x.shared.rows.get('logs/'+op.logId);assert.equal(log.volume,20);assert.equal(log.truckName,'Truck 123');assert.equal(log.isGAI,false);
});
test('Queued GAI load remains GAI and zero-volume after catalog conversion',async()=>{
 const x=client();x.c.findTruck=()=>({id:'t',brand:'GAI',number:'1',defaultVol:99,isGAI:true});const op=queue(x,'load');x.c.findTruck=()=>({id:'t',brand:'Dump',number:'1',defaultVol:25,isGAI:false});await replay(x);
 const log=x.shared.rows.get('logs/'+op.logId);assert.equal(log.volume,0);assert.equal(log.isGAI,true);
});
test('Quick load undo cannot erase a synchronized later arrival with a delayed notification',async()=>{
 const {x,op}=await loaded();const later={...x.c.state.truckStatus.t,cycleRevision:3,arriveStatus:'11:00',arriveTimestamp:2000000,arriveBy:'colleague',loadedAfterArrive:false};
 x.shared.put('truckStatus/t',later);x.c.state.truckStatus.t=plain(later);const before=plain([...x.shared.rows]);await x.c.undoLastAction();
 assert.deepEqual([...x.shared.rows],before);assert(x.errors.some(e=>/измен|зависим/.test(e)));assert(x.shared.rows.has('logs/'+op.logId));
});
test('Quick load undo cannot erase a synchronized later TTN action',async()=>{
 const {x}=await loaded();const later={...x.c.state.truckStatus.t,ttnStatus:true,ttnBy:'colleague',ttnLogId:'fresh',ttnRevision:1};
 x.shared.put('truckStatus/t',later);x.c.state.truckStatus.t=plain(later);const before=plain([...x.shared.rows]);await x.c.undoLastAction();assert.deepEqual([...x.shared.rows],before);
});
test('Successful quick undo updates projection base so deleted load cannot reappear locally',async()=>{
 const {x,op}=await loaded();await x.c.undoLastAction();assert.deepEqual(x.errors,[]);x.c.offlineProjectState();
 assert.equal(x.c.state.logs.length,0);assert.equal(x.c.state.truckStatus.t.lastLoadTimestamp,null);assert.equal(x.shared.rows.has('logs/'+op.logId),false);
});
test('TTN quick undo permits an independent later arrival while preserving it',async()=>{
 const x=client();const op=queue(x,'ttn');await replay(x);const n={id:'offline_'+op.id,...plain(x.shared.rows.get('notifications/offline_'+op.id))};quick(x,n);
 const later={...x.c.state.truckStatus.t,cycleRevision:2,arriveStatus:'11:00',arriveTimestamp:2000000,arriveBy:'colleague'};x.shared.put('truckStatus/t',later);x.c.state.truckStatus.t=plain(later);
 await x.c.undoLastAction();assert.deepEqual(x.errors,[]);assert.equal(x.shared.rows.get('truckStatus/t').ttnStatus,null);assert.equal(x.shared.rows.get('truckStatus/t').arriveTimestamp,2000000);
});
test('TTN quick undo rejects ABA state even when later fields look identical',async()=>{
 const x=client();const op=queue(x,'ttn');await replay(x);const n={id:'offline_'+op.id,...plain(x.shared.rows.get('notifications/offline_'+op.id))};quick(x,n);
 const later={...x.c.state.truckStatus.t,ttnRevision:3};x.shared.put('truckStatus/t',later);x.c.state.truckStatus.t=plain(later);const before=plain([...x.shared.rows]);await x.c.undoLastAction();assert.deepEqual([...x.shared.rows],before);
});
test('Local notification metadata cannot replace authoritative undo fields',async()=>{
 const {x,n}=await loaded();x.c.state.notifications[0]={...n,prevArriveTs:123,prevArriveStatus:'bad',prevArriveBy:'wrong'};await x.c.undoLastAction();
 assert.equal(x.shared.rows.get('truckStatus/t').arriveTimestamp,999000);
});
test('Legacy notification without causal snapshot is retained for history review, not guessed',async()=>{
 const {x,n}=await loaded();delete n.afterStatus;delete n.offlineOperationId;quick(x,n);const before=plain([...x.shared.rows]);await x.c.undoLastAction();assert.deepEqual([...x.shared.rows],before);assert(x.errors.some(e=>/истори/.test(e)));
});
test('Corrupt durable journal is never overwritten or treated as an empty queue',async()=>{
 const x=client(),key=x.run('offlineJournalKey()'),raw='[{"id":"unsent",';x.storage.set(key,raw);
 assert.equal(x.c.offlineQueueAction('load','t',x.c.captureLineIntent('t')),false);
 assert.equal(x.storage.get(key),raw);assert(x.c.offlinePendingCount()>0);assert.equal(x.c.offlinePendingForTruck('t'),true);
 assert.match(x.c.offlineJournalOwnershipStatus(),/Не очищайте данные приложения/);assert.match(x.c.syncState.errors.offlineJournal.message,/восстановления/);
});
test('Unsupported journal shape is retained rather than silently discarding unsent records',async()=>{
 for(const raw of ['{"pending":[1]}','[{"id":"bad-row"}]']){
  const x=client(),key=x.run('offlineJournalKey()');x.storage.set(key,raw);
  assert.equal(x.c.offlineQueueAction('load','t',x.c.captureLineIntent('t')),false);assert.equal(x.storage.get(key),raw);
 }
});
test('Failure to save a successful server result never labels it rejected and retry stays idempotent',async()=>{
 const x=client();const op=queue(x,'load');let failed=false;
 x.c.localStorage.setItem=(key,value)=>{if(!failed){failed=true;throw Error('Quota once');}x.storage.set(key,value);};
 await replay(x);assert.equal(x.c.offlineJournalRead()[0].status,'pending');assert(x.shared.rows.has('logs/'+op.logId));
 await replay(x);assert.equal(x.c.offlineJournalRead()[0].status,'confirmed');assert.equal(documents(x.shared,'logs').length,1);
});
test('Session switch during undo confirmation cannot mutate the previous account action',async()=>{
 const {x}=await loaded(),before=plain([...x.shared.rows]);x.c.appConfirm=async()=>{x.c.currentUid='b';x.c.currentEmail='b@example.com';return true;};
 await x.c.undoLastAction();assert.deepEqual([...x.shared.rows],before);
});
(async()=>{let failed=0;for(const {name,fn}of tests){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}console.log(`${tests.length-failed}/${tests.length} receipt/undo regressions passed`);if(failed)process.exitCode=1;})();
