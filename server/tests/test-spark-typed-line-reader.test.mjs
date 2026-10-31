import test from 'node:test';
import assert from 'node:assert/strict';
import {createSparkTypedLineReader} from '../../test-app/synology/spark-typed-line-reader.mjs';

const GEN='0123456789abcdef01234567',WS='main_workspace',UID='operator_a';
const baseOwner=()=>({owner:'firebase',readyForFailover:true,generation:GEN,
 epoch:5,confirmedSequence:88,reserveSequence:0});
const snap=(data,exists=true)=>({exists,data:()=>data});
const timestamp=ms=>({toMillis:()=>ms});
function mock(){
 let auth={uid:UID},latest=baseOwner(),ownerCalls=0,readCalls=0,sessionCalls=0;
 const raw={
  readSession:async()=>{sessionCalls++;return {format:'samosval-session',version:1,source:'firebase',
   workspaceId:WS,identityReady:true,
   profile:{uid:UID,status:'active',deleted:false},
   permissions:{tabs:['line'],actions:['action_load']}};},
  readLine:async()=>{readCalls++;return structuredClone({
   format:'samosval-line-snapshot',version:1,source:'firebase',
   workspaceId:WS,shift:{id:'shift_a',isActive:true},
   trucks:[{id:'truck_a',brand:'КамАЗ',number:'А123АА',defaultVol:24,isGAI:false}],
   statuses:[{id:'truck_a',shiftId:'shift_a',onLine:true,cycleRevision:1,
    ttnRevision:0,arriveStatus:'09:30',arriveTimestamp:1700000000000,
    lastLoadTimestamp:null,loadedAfterArrive:false}],
   logs:[],cycleMinutes:60
  });},
  stop(){}
 };
 const config={protocol:1,projectId:'samosval-offline',generation:GEN,
  workspaceId:WS,active:true,shiftId:'shift_a',cycleMinutes:60,sourceSequence:88};
 const createdAt=1700000000000,loadedAt=1700000060000;
 const event={operationId:'op_load',uid:UID,type:'load',epoch:5,generation:GEN,
  truckId:'truck_a',shiftId:'shift_a',ordinal:1,expectedRevision:1,
  revision:2,requestHash:'a'.repeat(64),
  cycleMinutes:60,at:timestamp(loadedAt),logId:'load_op_load',
  volume:24,isGAI:false,intent:{arrivalTimestamp:createdAt}};
 const status={protocol:1,projectId:'samosval-offline',generation:GEN,
  workspaceId:WS,id:'truck_a',sourceSequence:88,shiftId:'shift_a',
  onLine:true,cycleRevision:2,ttnRevision:0,arrivedAt:null,
  lastLoadAt:timestamp(loadedAt),lastLogId:'load_op_load',
  loadedAfterArrive:true,ttnStatus:null,ttnLogId:'',ttnByUid:'',
  lastActorUid:UID,lastActionType:'load',lastOperationId:'op_load',
  reserveHistory:{op_load:event}
 };
 const triggers=new Map();let listens=0,gets=0;
 const docs={
  ['samosval_test_replica/v1/typed_config_'+GEN+'/active']:config,
  ['samosval_test_replica/v1/typed_status_'+GEN+'/truck_a']:status
 };
 const firestore={
  app:{options:{projectId:'samosval-offline'}},
  doc(path){return {
   path,get:async()=>{gets++;return path in docs?snap(docs[path]):snap(null,false);},
   onSnapshot(cb){listens++;triggers.set(path,cb);return ()=>triggers.delete(path);}
  }}
 };
 const authority={readOwner:async()=>{ownerCalls++;return {...latest};},stop(){}};
 const create=()=>createSparkTypedLineReader({
  firestore,getUser:()=>auth,ownerReader:authority,rawReader:raw
 });
 return {create,docs,config,status,raw,authority,triggers,
  changeOwner:o=>{latest={...latest,...o};},changeAuth:()=>{auth={uid:UID};},
  get ownerCalls(){return ownerCalls;},get reads(){return readCalls;},
  get sessions(){return sessionCalls;},
  get gets(){return gets;},get listens(){return listens;}
 };
}
test('typed reserve LOAD is visible to the phone, not lost in stale SQL mirror',async()=>{
 const f=mock();const reader=f.create();
 const view=await reader.readLine();
 assert.equal(view.source,'firebase');
 assert.equal(view.typedGeneration,GEN);
 assert.equal(view.statuses[0].cycleRevision,2);
 assert.equal(view.statuses[0].lastLoadLogId,'load_op_load');
 assert.equal(view.statuses[0].lastLoadTimestamp,1700000060000);
 assert.equal(view.statuses[0].arriveStatus,null);
 assert.equal(view.logs.length,1);
 assert.equal(view.logs[0].id,'load_op_load');
 assert.equal(view.logs[0].volume,24);
 assert.equal(view.logs[0].clientOperationId,'op_load');
 assert.deepEqual(view.reserveOperations,['op_load']);
 assert.ok(f.ownerCalls>=2);
 reader.stop();
});
test('typed reader fails closed on missing status, mismatched generation or tampering',async()=>{
 for(const change of [
  f=>delete f.docs['samosval_test_replica/v1/typed_status_'+GEN+'/truck_a'],
  f=>f.status.generation='f'.repeat(24),
  f=>f.status.reserveHistory.op_load.ordinal=2,
  f=>f.status.reserveHistory.op_load.logId='forged',
  f=>f.config.cycleMinutes=33
 ]){
  const f=mock();change(f);
  await assert.rejects(f.create().readLine(),e=>e.code?.startsWith('spark-typed-'));
 }
});
test('typed reader rejects owner changes during multi-doc reads',async()=>{
 const f=mock(),reader=f.create();
 let n=0;
 f.authority.readOwner=async()=>{n++;return {...baseOwner(),epoch:n>2?6:5};};
 await assert.rejects(reader.readLine(),{code:'spark-typed-owner-changed-during-read'});
});
test('stale auth never exposes any typed status document',async()=>{
 const f=mock(),reader=f.create();
 f.changeAuth();
 await assert.rejects(reader.readLine(),{code:'spark-session-changed'});
 assert.equal(f.gets,0);
});
test('status listeners only wake from fresh server notifications and are cleaned up',async()=>{
 const f=mock(),reader=f.create(),view=await reader.readLine();
 let woken=0;
 const close=reader.watchStatuses(view,()=>woken++);
 const key='samosval_test_replica/v1/typed_status_'+GEN+'/truck_a';
 assert.equal(f.listens,1);
 f.triggers.get(key)({metadata:{fromCache:false}}); // first snapshot ignored
 f.triggers.get(key)({metadata:{fromCache:true}});
 f.triggers.get(key)({metadata:{fromCache:false}});
 assert.equal(woken,1);
 close();assert.equal(f.triggers.size,0);reader.stop();
});

test('same certified epoch reuses immutable baseline but rechecks ACL per refresh',async()=>{
 const f=mock(),reader=f.create();
 await reader.readLine();
 await reader.readLine();
 assert.equal(f.reads,1,'5 baseline table queries are not repeated per reserve LOAD');
 assert.equal(f.sessions,1,'cached baseline still requires current ACL');
 f.changeOwner({epoch:6});
 await reader.readLine();
 assert.equal(f.reads,2,'new ownership epoch invalidates baseline cache');
 reader.stop();
});
