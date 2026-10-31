// Disposable Firestore Emulator ONLY. This fixture intentionally promotes
// a synthetic generation; it never accesses the live Spark project.
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {initializeTestEnvironment,assertFails,assertSucceeds}=
 require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,updateDoc,runTransaction,serverTimestamp,Timestamp}=
 require('firebase/firestore');
const {webcrypto}=require('node:crypto');
const G='0123456789abcdef01234567',ROOT='samosval_test_replica/v1';
const STATE=ROOT+'/typed_status_'+G+'/truck1',TRUCK=ROOT+'/typed_trucks_'+G+'/truck1';
const CONFIG=ROOT+'/typed_config_'+G+'/active',ACCESS=ROOT+'/access_'+G;
let env,alice,bob,createSparkLineWriter;
before(async()=>{
 ({createSparkLineWriter}=await import('../../test-app/synology/spark-line-writer.mjs'));
 env=await initializeTestEnvironment({
  projectId:'demo-samosval-spark-ci',
  firestore:{host:'127.0.0.1',port:8089}
 });
 alice=env.authenticatedContext('operatorA').firestore();
 bob=env.authenticatedContext('operatorB').firestore();
});
after(async()=>{await env?.cleanup();});
beforeEach(async()=>{
 await env.clearFirestore();
 await env.withSecurityRulesDisabled(async ctx=>{
  const db=ctx.firestore();
  await setDoc(doc(db,ROOT),{protocol:1,channel:'test',writer:'synology',
   projectId:'samosval-offline',generation:G,hash:'a'.repeat(64),
   lastSequence:23,readyForFailover:true});
  await setDoc(doc(db,'samosval_test_replica/write_owner'),{
   protocol:1,projectId:'samosval-offline',owner:'firebase',
   holder:'firebase_reserve',epoch:9,generation:G,observedSequence:23,
   reserveSequence:0,leaseUntil:Date.now()+60000,pending:{}});
  await setDoc(doc(db,CONFIG),{
   protocol:1,projectId:'samosval-offline',generation:G,
   workspaceId:'main_workspace',sourceSequence:23,active:true,
   shiftId:'shift1',cycleMinutes:60
  });
  await setDoc(doc(db,TRUCK),{
   protocol:1,projectId:'samosval-offline',generation:G,
   workspaceId:'main_workspace',id:'truck1',sourceSequence:23,
   brand:'КАМАЗ',number:'А100АА',volume:24,isGAI:false
  });
  await setDoc(doc(db,STATE),{
   protocol:1,projectId:'samosval-offline',generation:G,workspaceId:'main_workspace',
   sourceSequence:23,id:'truck1',shiftId:'shift1',onLine:true,
   cycleRevision:0,ttnRevision:0,ttnStatus:null,ttnLogId:'',ttnByUid:'',
   arrivedAt:null,lastLoadAt:null,
   lastLogId:'',lastOperationId:'',lastActionType:'',lastActorUid:'',
   loadedAfterArrive:false,reserveHistory:{}
  });
  for(const uid of ['operatorA','operatorB']){
   await setDoc(doc(db,ACCESS+'/'+uid),{
    protocol:1,source:'nas-spark-mirror',projectId:'samosval-offline',
    workspaceId:'main_workspace',generation:G,uid,
    sourceSequence:23,active:true,lineRead:true,
    profile:{uid,status:'active',role:'lopater',deleted:false},
    permissions:{tabs:['line'],actions:['action_arrive','action_load','action_ttn']}
   });
  }
 });
});
const scope=uid=>'["synology","https://nas.invalid","main_workspace","'+uid+'"]';
// Emulator tests use the modular SDK; the actual PWA uses Firebase compat.
const compat=(db)=>({
 app:{options:{projectId:'samosval-offline'}},
 doc:path=>doc(db,path),
 runTransaction:fn=>runTransaction(db,tx=>fn({
  get:async ref=>{const x=await tx.get(ref);return {
   exists:x.exists(),data:()=>x.data()
  };},
  set:(ref,data)=>tx.set(ref,data),
  update:(ref,data)=>tx.update(ref,data)
 }))
});
const make=(db,uid)=>{
 const user={uid};
 return createSparkLineWriter({
  firestore:compat(db),getUser:()=>user,
  serverTimestamp,cryptoImpl:webcrypto,clock:Date.now,
  onDiagnostic:e=>console.error('SPARK_EMULATOR_RAW',e?.code||'',e?.message||'')
 });
};
const arrive=id=>({
 id,type:'arrive',truckId:'truck1',shiftId:'shift1',
 expectedRevision:0,arrivalTimestamp:0,lastLoadTimestamp:0,
 wantArrived:true,collect:false,cycleMinutes:60,createdAt:Date.now()
});
const load=(id,revision,arrivedAt,lastLoadAt=0)=>({
 id,type:'load',truckId:'truck1',shiftId:'shift1',expectedRevision:revision,
 arrivalTimestamp:arrivedAt,lastLoadTimestamp:lastLoadAt,
 wantArrived:false,collect:false,cycleMinutes:60,createdAt:Date.now()
});
const ttn=(id,{revision=0,ttnRevision=0,collect=true,lastLoadAt=0}={})=>({
 id,type:'ttn',truckId:'truck1',shiftId:'shift1',
 expectedRevision:revision,expectedTtnRevision:ttnRevision,
 arrivalTimestamp:0,lastLoadTimestamp:lastLoadAt,
 wantArrived:false,collect,cycleMinutes:60,createdAt:Date.now()
});
test('transaction preflight can read existing typed documents and probe missing receipts',async()=>{
 for(const path of [
  ROOT, 'samosval_test_replica/write_owner',
  CONFIG,TRUCK,STATE,
  ACCESS+'/operatorA'
 ]){
  await assertSucceeds(getDoc(doc(alice,path)));
 }
});
test('legitimate arrive creates exactly one immutable operation and status',async()=>{
 const writer=make(alice,'operatorA');
 let result;
 try{result=await writer.submitLine(arrive('arrival01'),
  {operationScope:scope('operatorA')});}
 catch(error){
  // The Emulator exposes execution coverage only locally. Capture a bounded
  // diagnostic for tests; it never queries or changes real Firebase.
  try{
   const resp=await fetch('http://127.0.0.1:8089/emulator/v1/projects/demo-samosval-spark-ci:ruleCoverage');
   const json=await resp.json();
   const entries=[];
   const walk=x=>{
    if(Array.isArray(x)){for(const item of x)walk(item);return;}
    if(!x||typeof x!=='object')return;
    if(x.sourcePosition?.line>=365&&x.sourcePosition?.line<=579&&Array.isArray(x.values)){
     const falseCount=x.values.filter(v=>v.value?.boolValue===false).reduce((a,b)=>a+(b.count||0),0);
     const trueCount=x.values.filter(v=>v.value?.boolValue===true).reduce((a,b)=>a+(b.count||0),0);
     if(falseCount||trueCount)entries.push([x.sourcePosition.line,x.sourcePosition.column,falseCount,trueCount]);
    }
    for(const [name,value] of Object.entries(x))
     if(name!=='values'&&name!=='sourcePosition')walk(value);
   };
   walk(json);
   console.error('SPARK_RULE_COVERAGE_FALSE',
    JSON.stringify(entries.filter(x=>x[2]>0).sort((a,b)=>a[0]-b[0]).slice(-120)));
   console.error('SPARK_RULE_COVERAGE_TRUE',
    JSON.stringify(entries.filter(x=>x[3]>0).sort((a,b)=>a[0]-b[0]).slice(-55)));
   const details=[];
   const detailWalk=x=>{
    if(Array.isArray(x)){for(const item of x)detailWalk(item);return;}
    if(!x||typeof x!=='object')return;
    if(x.sourcePosition?.line>=535&&x.sourcePosition?.line<=565&&Array.isArray(x.values))
     details.push({line:x.sourcePosition.line,col:x.sourcePosition.column,
      values:x.values.slice(0,4)});
    for(const [name,value] of Object.entries(x))
     if(name!=='values'&&name!=='sourcePosition')detailWalk(value);
   };
   detailWalk(json);
   console.error('SPARK_LOG_RULE_DETAILS',JSON.stringify(details).slice(-12500));
  }catch(e){console.error('SPARK_RULE_COVERAGE_UNAVAILABLE',e.message);}
  throw error;
 }
 assert.equal(result.outcome,'confirmed');
 const status=(await getDoc(doc(alice,STATE))).data();
 assert.equal(status.cycleRevision,1);
 assert.equal(status.lastOperationId,'arrival01');
 assert.ok(status.arrivedAt.toMillis()>0);
 const receipt=status.reserveHistory.arrival01;
 assert.equal(receipt.uid,'operatorA');
 assert.equal(receipt.type,'arrive');
 writer.stop();
});
test('load is tied to arrival and written with an immutable log and receipt',async()=>{
 const writer=make(alice,'operatorA');
 await writer.submitLine(arrive('arrival02'),{operationScope:scope('operatorA')});
 const arrived=(await getDoc(doc(alice,STATE))).data().arrivedAt.toMillis();
 let result;
 try{result=await writer.submitLine(load('loading02',1,arrived),
  {operationScope:scope('operatorA')});}
 catch(error){
  // The Emulator exposes execution coverage only locally. Capture a bounded
  // diagnostic for tests; it never queries or changes real Firebase.
  try{
   const resp=await fetch('http://127.0.0.1:8089/emulator/v1/projects/demo-samosval-spark-ci:ruleCoverage');
   const json=await resp.json();
   const entries=[];
   const walk=x=>{
    if(Array.isArray(x)){for(const item of x)walk(item);return;}
    if(!x||typeof x!=='object')return;
    if(x.sourcePosition?.line>=365&&x.sourcePosition?.line<=579&&Array.isArray(x.values)){
     const falseCount=x.values.filter(v=>v.value?.boolValue===false).reduce((a,b)=>a+(b.count||0),0);
     const trueCount=x.values.filter(v=>v.value?.boolValue===true).reduce((a,b)=>a+(b.count||0),0);
     if(falseCount||trueCount)entries.push([x.sourcePosition.line,x.sourcePosition.column,falseCount,trueCount]);
    }
    for(const [name,value] of Object.entries(x))
     if(name!=='values'&&name!=='sourcePosition')walk(value);
   };
   walk(json);
   console.error('SPARK_RULE_COVERAGE_FALSE',
    JSON.stringify(entries.filter(x=>x[2]>0).sort((a,b)=>a[0]-b[0]).slice(-120)));
   console.error('SPARK_RULE_COVERAGE_TRUE',
    JSON.stringify(entries.filter(x=>x[3]>0).sort((a,b)=>a[0]-b[0]).slice(-55)));
   const details=[];
   const detailWalk=x=>{
    if(Array.isArray(x)){for(const item of x)detailWalk(item);return;}
    if(!x||typeof x!=='object')return;
    if(x.sourcePosition?.line>=535&&x.sourcePosition?.line<=565&&Array.isArray(x.values))
     details.push({line:x.sourcePosition.line,col:x.sourcePosition.column,
      values:x.values.slice(0,4)});
    for(const [name,value] of Object.entries(x))
     if(name!=='values'&&name!=='sourcePosition')detailWalk(value);
   };
   detailWalk(json);
   console.error('SPARK_LOG_RULE_DETAILS',JSON.stringify(details).slice(-12500));
  }catch(e){console.error('SPARK_RULE_COVERAGE_UNAVAILABLE',e.message);}
  throw error;
 }
 assert.equal(result.outcome,'confirmed');
 const status=(await getDoc(doc(alice,STATE))).data();
 assert.equal(status.cycleRevision,2);
 assert.equal(status.arrivedAt,null);
 assert.equal(status.lastLogId,'load_loading02');
 const log=status.reserveHistory.loading02;
 assert.equal(log.uid,'operatorA');
 assert.equal(log.volume,24);
 assert.equal(log.shiftId,'shift1');
 assert.equal(log.at.toMillis(),status.lastLoadAt.toMillis());
});
test('two operators racing to load the same arrival yield exactly one log',async()=>{
 const first=make(alice,'operatorA'),second=make(bob,'operatorB');
 await first.submitLine(arrive('arrival03'),{operationScope:scope('operatorA')});
 const arrived=(await getDoc(doc(alice,STATE))).data().arrivedAt.toMillis();
 const attempts=await Promise.allSettled([
  first.submitLine(load('load_by_A',1,arrived),{operationScope:scope('operatorA')}),
  second.submitLine(load('load_by_B',1,arrived),{operationScope:scope('operatorB')})
 ]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
 const status=(await getDoc(doc(alice,STATE))).data();
 assert.equal(status.cycleRevision,2);
 assert.ok(['load_by_A','load_by_B'].includes(status.lastOperationId));
 // The same status transaction is also the append-only receipt/log.
 const matching=Object.values(status.reserveHistory).filter(
  x=>x.type==='load'&&['load_by_A','load_by_B'].includes(x.operationId));
 assert.equal(matching.length,1);
 assert.equal(matching[0].volume,24);
 assert.equal(Object.keys(status.reserveHistory).length,2);
});
test('same operator ID is idempotent, but it cannot be reused with changed intent',async()=>{
 const writer=make(alice,'operatorA'),op=arrive('arrival04');
 await writer.submitLine(op,{operationScope:scope('operatorA')});
 const repeat=await writer.submitLine(op,{operationScope:scope('operatorA')});
 assert.equal(repeat.replayed,true);
 await assert.rejects(writer.submitLine({...op,cycleMinutes:61},
  {operationScope:scope('operatorA')}),e=>e.code==='spark-operation-id-reused');
 const state=(await getDoc(doc(alice,STATE))).data();
 assert.equal(state.cycleRevision,1);
});
test('TTN can be collected before load, then links automatically to confirmed trip',async()=>{
 const writer=make(alice,'operatorA');
 await writer.submitLine(arrive('arrival_ttn_pending'),{operationScope:scope('operatorA')});
 const pending=await writer.submitLine(ttn('ttn_collect_pending',{revision:1}),
  {operationScope:scope('operatorA')});
 assert.equal(pending.outcome,'confirmed');
 const afterPending=(await getDoc(doc(alice,STATE))).data();
 assert.equal(afterPending.cycleRevision,1,'TTN must not advance the load cycle');
 assert.equal(afterPending.ttnRevision,1);
 assert.equal(afterPending.ttnStatus,'pending');
 assert.equal(afterPending.ttnByUid,'operatorA');
 assert.equal(afterPending.ttnLogId,'');
 const arrived=afterPending.arrivedAt.toMillis();
 const loaded=await writer.submitLine(load('load_after_ttn',1,arrived),
  {operationScope:scope('operatorA')});
 assert.equal(loaded.outcome,'confirmed');
 const afterLoad=(await getDoc(doc(alice,STATE))).data();
 assert.equal(afterLoad.cycleRevision,2);
 assert.equal(afterLoad.ttnRevision,1,'load must not mutate TTN revision');
 assert.equal(afterLoad.ttnStatus,true);
 assert.equal(afterLoad.ttnLogId,'load_load_after_ttn');
 assert.equal(Object.keys(afterLoad.reserveHistory).length,3);
 const clear=await writer.submitLine(ttn('ttn_uncollect',{revision:2,
  ttnRevision:1,collect:false,lastLoadAt:afterLoad.lastLoadAt.toMillis()}),
  {operationScope:scope('operatorA')});
 assert.equal(clear.outcome,'confirmed');
 const afterClear=(await getDoc(doc(alice,STATE))).data();
 assert.equal(afterClear.cycleRevision,2);
 assert.equal(afterClear.ttnRevision,2);
 assert.equal(afterClear.ttnStatus,null);
 assert.equal(afterClear.ttnLogId,'');
 assert.equal(afterClear.ttnByUid,'');
 assert.equal(Object.keys(afterClear.reserveHistory).length,4);
});
test('two operators racing to mark TTN at same revision cannot both confirm',async()=>{
 const a=make(alice,'operatorA'),b=make(bob,'operatorB');
 const [first,second]=await Promise.allSettled([
  a.submitLine(ttn('ttn_by_A'),{operationScope:scope('operatorA')}),
  b.submitLine(ttn('ttn_by_B'),{operationScope:scope('operatorB')})
 ]);
 assert.equal([first,second].filter(x=>x.status==='fulfilled').length,1);
 const status=(await getDoc(doc(alice,STATE))).data();
 assert.equal(status.ttnRevision,1);
 assert.equal(status.cycleRevision,0);
 assert.equal(Object.values(status.reserveHistory).filter(x=>x.type==='ttn').length,1);
});
test('stale TTN revision or missing action permission never changes a truck',async()=>{
 const writer=make(alice,'operatorA');
 await assert.rejects(writer.submitLine(ttn('ttn_stale',{ttnRevision:5}),
  {operationScope:scope('operatorA')}),e=>e.code==='spark-ttn-changed');
 await env.withSecurityRulesDisabled(async ctx=>{
  await updateDoc(doc(ctx.firestore(),ACCESS+'/operatorA'),{
   permissions:{tabs:['line'],actions:['action_arrive','action_load']}
  });
 });
 await assert.rejects(writer.submitLine(ttn('ttn_denied'),
  {operationScope:scope('operatorA')}),e=>e.code==='spark-permission-denied');
 const status=(await getDoc(doc(alice,STATE))).data();
 assert.equal(status.ttnRevision,0);
 assert.deepEqual(status.reserveHistory,{});
});
test('rules deny a forged status update without a corresponding receipt',async()=>{
 await assertFails(updateDoc(doc(alice,STATE),{
  cycleRevision:1,arrivedAt:serverTimestamp(),lastOperationId:'forged01',
  lastActionType:'arrive',lastActorUid:'operatorA',loadedAfterArrive:false
 }));
 const status=(await getDoc(doc(alice,STATE))).data();
 assert.equal(status.cycleRevision,0);
});
test('rules deny receipt without corresponding status update',async()=>{
 await assertFails(setDoc(doc(alice,ROOT+'/typed_ops_'+G+'/forged02'),{
  protocol:1,projectId:'samosval-offline',generation:G,epoch:9,
  uid:'operatorA',operationId:'forged02',truckId:'truck1',shiftId:'shift1',
  type:'arrive',expectedRevision:0,cycleMinutes:60,
  requestHash:'a'.repeat(64),at:serverTimestamp(),logId:''
 }));
});
test('rules deny direct modification of the immutable log, owner and grant',async()=>{
 await assertFails(setDoc(doc(alice,ROOT+'/typed_logs_'+G+'/load_fake'),{
  protocol:1,projectId:'samosval-offline',generation:G,epoch:9,
  id:'load_fake',operationId:'fake',uid:'operatorA',truckId:'truck1',
  shiftId:'shift1',isGAI:false,volume:24,at:serverTimestamp()
 }));
 await assertFails(updateDoc(doc(alice,'samosval_test_replica/write_owner'),{owner:'synology'}));
 await assertFails(updateDoc(doc(alice,ACCESS+'/operatorA'),{active:true}));
});
test('revoked permission and changed writer epoch block subsequent operations',async()=>{
 await env.withSecurityRulesDisabled(async ctx=>{
  await updateDoc(doc(ctx.firestore(),ACCESS+'/operatorA'),
   {permissions:{tabs:['line'],actions:[]}});
 });
 const writer=make(alice,'operatorA');
 await assert.rejects(writer.submitLine(arrive('disabled01'),
  {operationScope:scope('operatorA')}));
 await env.withSecurityRulesDisabled(async ctx=>{
  await updateDoc(doc(ctx.firestore(),ACCESS+'/operatorA'),
   {permissions:{tabs:['line'],actions:['action_arrive','action_load']}});
  await updateDoc(doc(ctx.firestore(),'samosval_test_replica/write_owner'),
   {owner:'handoff',epoch:10});
 });
 await assert.rejects(writer.submitLine(arrive('handoff01'),
  {operationScope:scope('operatorA')}));
 assert.equal((await getDoc(doc(alice,STATE))).data().cycleRevision,0);
});
test('lost acknowledgment after commit replays the same immutable operation ID',async()=>{
 const backend=compat(alice);
 const user={uid:'operatorA'};
 let loseReply=true;
 const writer=createSparkLineWriter({
  firestore:{...backend,runTransaction:async callback=>{
   const result=await backend.runTransaction(callback);
   if(loseReply){loseReply=false;throw Error('simulated-reply-lost-after-commit');}
   return result;
  }},
  getUser:()=>user,serverTimestamp,cryptoImpl:webcrypto,clock:Date.now
 });
 const op=arrive('arrival_lost_ack');
 await assert.rejects(writer.submitLine(op,{operationScope:scope('operatorA')}),
  e=>e.uncertain===true&&e.retryable===true);
 const committed=(await getDoc(doc(alice,STATE))).data();
 assert.equal(committed.cycleRevision,1);
 assert.equal(Object.keys(committed.reserveHistory).length,1);
 const replay=await writer.submitLine(op,{operationScope:scope('operatorA')});
 assert.equal(replay.replayed,true);
 assert.equal(replay.operationId,op.id);
 const after=(await getDoc(doc(alice,STATE))).data();
 assert.equal(after.cycleRevision,1,'replay cannot count a second trip');
 assert.equal(Object.keys(after.reserveHistory).length,1);
});
test('a user cannot rewrite earlier immutable reserve history or forge a new event',async()=>{
 const writer=make(alice,'operatorA');
 await writer.submitLine(arrive('arrival_immutable'),{operationScope:scope('operatorA')});
 const committed=(await getDoc(doc(alice,STATE))).data();
 await assertFails(updateDoc(doc(alice,STATE),{
  reserveHistory:{
   ...committed.reserveHistory,
   arrival_immutable:{...committed.reserveHistory.arrival_immutable,volume:999999}
  }
 }));
 await assertFails(updateDoc(doc(alice,STATE),{
  reserveHistory:{
   ...committed.reserveHistory,
   forged:{operationId:'forged',uid:'operatorA',type:'load',volume:999999}
  }
 }));
 const after=(await getDoc(doc(alice,STATE))).data();
 assert.equal(after.cycleRevision,1);
 assert.equal(after.reserveHistory.arrival_immutable.volume,0);
 assert.equal(Object.keys(after.reserveHistory).length,1);
});
test('recent load blocks a new arrival until the 60-minute cycle',async()=>{
 await env.withSecurityRulesDisabled(async ctx=>{
  await updateDoc(doc(ctx.firestore(),STATE),{
   cycleRevision:2,arrivedAt:null,
   lastLoadAt:Timestamp.fromMillis(Date.now()-1000),
   lastLogId:'prior',lastOperationId:'prior',
   lastActionType:'load',lastActorUid:'operatorB',loadedAfterArrive:true
  });
 });
 const writer=make(alice,'operatorA');
 await assert.rejects(writer.submitLine({...arrive('too_soon'),expectedRevision:2,
  lastLoadTimestamp:Date.now()-1000},{operationScope:scope('operatorA')}));
 assert.equal((await getDoc(doc(alice,STATE))).data().cycleRevision,2);
});
