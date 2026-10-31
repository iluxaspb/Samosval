import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateSparkFrozenHistory,inspectFrozenSparkHistory} from '../src/test-spark-replay-inspect.mjs';
import {canonical,REPLICA_DOC} from '../src/test-replica.mjs';
import {OWNER_DOC} from '../src/test-writer-coordinator.mjs';

const G='0123456789abcdef01234567',H='a'.repeat(64),TIME=1800000000000;
const sha=x=>createHash('sha256').update(canonical(x)).digest('hex');
const ts=v=>({toMillis:()=>v});
const base=()=>({
 metadata:{protocol:1,channel:'test',projectId:'samosval-offline',
  generation:G,hash:H,lastSequence:42,typedSequence:42,typedProtocol:1,
  readyForFailover:true},
 owner:{protocol:1,projectId:'samosval-offline',generation:G,
  owner:'reconciling',holder:'reconcile_worker',epoch:10,observedSequence:42,
  pending:{},recovery:{generation:G,fromEpoch:9,baseSequence:42,baseHash:H}},
 truckDocuments:[{id:'truckA',data:{id:'truckA',workspaceId:'main_workspace',
  generation:G,sourceSequence:42,isGAI:false,volume:24}},
  {id:'truckB',data:{id:'truckB',workspaceId:'main_workspace',
   generation:G,sourceSequence:42,isGAI:true,volume:0}}],
 statusDocuments:[]
});
function event({id,type,ordinal,revision,expectedRevision,serverAt,collect=false,
 expectedTtnRevision=0,truckId='truckA',volume=0,isGAI=false}){
 const intent={id,type,truckId,shiftId:'shiftA',expectedRevision,
  arrivalTimestamp:type==='load'?TIME:0,lastLoadTimestamp:0,
  createdAt:serverAt-100,cycleMinutes:60,
  wantArrived:type==='arrive',collect,
  ...(type==='ttn'?{expectedTtnRevision}:{})};
 return {operationId:id,type,uid:'operatorA',epoch:9,generation:G,
  truckId,shiftId:'shiftA',ordinal,
  expectedRevision,revision,cycleMinutes:60,
  intent,requestHash:sha(intent),at:ts(serverAt),
  logId:type==='load'?'load_'+id:'',
  volume,isGAI,...(type==='ttn'?{
   collect,expectedTtnRevision,ttnRevision:expectedTtnRevision+1
  }:{})};
}
function fixture(){
 const x=base();
 const one=event({id:'arrive01',type:'arrive',ordinal:1,
  expectedRevision:3,revision:4,serverAt:TIME});
 const two=event({id:'ttn01',type:'ttn',ordinal:2,
  expectedRevision:4,revision:4,serverAt:TIME+5000});
 const three=event({id:'load01',type:'load',ordinal:3,
  expectedRevision:4,revision:5,serverAt:TIME+15000,volume:24});
 x.statusDocuments=[{id:'truckA',data:{
  id:'truckA',generation:G,workspaceId:'main_workspace',
  sourceSequence:42,shiftId:'shiftA',cycleRevision:5,ttnRevision:1,
  lastOperationId:'load01',reserveHistory:{arrive01:one,ttn01:two,load01:three}
 }},{id:'truckB',data:{
  id:'truckB',generation:G,workspaceId:'main_workspace',
  sourceSequence:42,shiftId:'shiftA',cycleRevision:0,ttnRevision:0,
  lastOperationId:'',reserveHistory:{}
 }}];
 return x;
}
test('frozen typed history builds a hash-verified ordered NAS handback manifest',()=>{
 const f=fixture(),result=validateSparkFrozenHistory(f);
 assert.equal(result.eventCount,3);
 assert.equal(result.fromEpoch,9);
 assert.equal(result.ownerEpoch,10);
 assert.deepEqual(result.events.map(x=>x.operationId),['arrive01','ttn01','load01']);
 assert.deepEqual(result.events.map(x=>x.ordinal),[1,2,3]);
 assert.equal(result.events[2].volume,24);
 assert.equal(result.events[2].intent.id,'load01');
 assert.match(result.sha256,/^[0-9a-f]{64}$/);
 assert.equal(validateSparkFrozenHistory(f).sha256,result.sha256);
});
test('no writer promotion, stale head or changed epoch can pass preflight',()=>{
 for(const change of [
  f=>{f.owner.owner='firebase';},
  f=>{f.owner.epoch=9;},
  f=>{f.metadata.typedSequence=40;},
  f=>{f.metadata.readyForFailover=false;},
  f=>{f.owner.recovery.baseHash='b'.repeat(64);},
  f=>{f.owner.pending={inflight:true};}
 ]){
  const f=fixture();change(f);
  assert.throws(()=>validateSparkFrozenHistory(f),/spark-replay-owner-not-frozen/);
 }
});
test('missing, forged, reordered or duplicate ledger events are rejected',()=>{
 const changes=[
  f=>f.statusDocuments[0].data.reserveHistory.load01.requestHash='0'.repeat(64),
  f=>f.statusDocuments[0].data.reserveHistory.load01.volume=99,
  f=>f.statusDocuments[0].data.reserveHistory.ttn01.ordinal=3,
  f=>f.statusDocuments[0].data.reserveHistory.load01.at=ts(TIME-10000),
  f=>f.statusDocuments[0].data.reserveHistory.arrive01.revision=99,
  f=>f.statusDocuments[0].data.reserveHistory.load01.operationId='otherId',
  f=>f.statusDocuments[0].data.cycleRevision=99
 ];
 for(const change of changes){
  const f=fixture();change(f);
  assert.throws(()=>validateSparkFrozenHistory(f),/spark-replay-/);
 }
});
test('out-of-order TTN sequence or mismatched source role stops recovery',()=>{
 const f=fixture();
 f.statusDocuments[0].data.reserveHistory.ttn01.expectedTtnRevision=3;
 assert.throws(()=>validateSparkFrozenHistory(f),/spark-replay-/);
 const g=fixture();
 g.statusDocuments[0].data.reserveHistory.load01.epoch=10;
 assert.throws(()=>validateSparkFrozenHistory(g),/spark-replay-/);
});
test('a frozen status inventory and owner must remain stable during Firestore reads',async()=>{
 const f=fixture(),docs=new Map([
  [REPLICA_DOC,f.metadata],[OWNER_DOC,f.owner]
 ]),generation=G;
 let reads=0;
 const firestore={
  doc:path=>({get:async()=>{reads++;
   const data=docs.get(path);return {exists:!!data,data:()=>data};}
  }),
  collection:path=>({get:async()=>({
   docs:(path.includes('typed_trucks_'+generation)?f.truckDocuments:
     f.statusDocuments).map(row=>({id:row.id,data:()=>row.data}))
  })})
 };
 const first=await inspectFrozenSparkHistory({
  firestore,projectId:'samosval-offline'
 });
 assert.equal(first.eventCount,3);
 assert.equal(reads,4);
 let getOwner=0;
 const changed={...firestore,doc:path=>({
  get:async()=>{
   if(path===OWNER_DOC&&++getOwner===2)docs.set(OWNER_DOC,{
    ...f.owner,epoch:11
   });
   const data=docs.get(path);
   return {exists:!!data,data:()=>data};
  }
 })};
 await assert.rejects(inspectFrozenSparkHistory({
  firestore:changed,projectId:'samosval-offline'
 }),/spark-replay-owner-not-frozen|spark-replay-ownership-changed/);
});
