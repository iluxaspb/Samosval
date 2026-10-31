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
   cycleRevision:0,ttnRevision:0,arrivedAt:null,lastLoadAt:null,
   lastLogId:'',lastOperationId:'',lastActionType:'',lastActorUid:'',
   loadedAfterArrive:false
  });
  for(const uid of ['operatorA','operatorB']){
   await setDoc(doc(db,ACCESS+'/'+uid),{
    protocol:1,source:'nas-spark-mirror',projectId:'samosval-offline',
    workspaceId:'main_workspace',generation:G,uid,
    sourceSequence:23,active:true,lineRead:true,
    profile:{uid,status:'active',role:'lopater',deleted:false},
    permissions:{tabs:['line'],actions:['action_arrive','action_load']}
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
  get:ref=>tx.get(ref),
  set:(ref,data)=>tx.set(ref,data),
  update:(ref,data)=>tx.update(ref,data)
 }))
});
const make=(db,uid)=>{
 const user={uid};
 return createSparkLineWriter({
  firestore:compat(db),getUser:()=>user,
  serverTimestamp,cryptoImpl:webcrypto,clock:Date.now
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
test('legitimate arrive creates exactly one immutable operation and status',async()=>{
 const writer=make(alice,'operatorA');
 const result=await writer.submitLine(arrive('arrival01'),
  {operationScope:scope('operatorA')});
 assert.equal(result.outcome,'confirmed');
 const status=(await getDoc(doc(alice,STATE))).data();
 assert.equal(status.cycleRevision,1);
 assert.equal(status.lastOperationId,'arrival01');
 assert.ok(status.arrivedAt.toMillis()>0);
 const receipt=(await getDoc(doc(alice,ROOT+'/typed_ops_'+G+'/arrival01'))).data();
 assert.equal(receipt.uid,'operatorA');
 assert.equal(receipt.type,'arrive');
 writer.stop();
});
test('load is tied to arrival and written with an immutable log and receipt',async()=>{
 const writer=make(alice,'operatorA');
 await writer.submitLine(arrive('arrival02'),{operationScope:scope('operatorA')});
 const arrived=(await getDoc(doc(alice,STATE))).data().arrivedAt.toMillis();
 const result=await writer.submitLine(load('loading02',1,arrived),
  {operationScope:scope('operatorA')});
 assert.equal(result.outcome,'confirmed');
 const status=(await getDoc(doc(alice,STATE))).data();
 assert.equal(status.cycleRevision,2);
 assert.equal(status.arrivedAt,null);
 assert.equal(status.lastLogId,'load_loading02');
 const log=(await getDoc(doc(alice,ROOT+'/typed_logs_'+G+'/load_loading02'))).data();
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
 const firstLog=await getDoc(doc(alice,ROOT+'/typed_logs_'+G+'/load_load_by_A'));
 const secondLog=await getDoc(doc(alice,ROOT+'/typed_logs_'+G+'/load_load_by_B'));
 assert.equal(Number(firstLog.exists())+Number(secondLog.exists()),1);
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
