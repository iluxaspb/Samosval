import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {REPLICA_DOC,canonical,sha256} from '../src/test-replica.mjs';
import {OWNER_DOC,acquireNasWritePermit} from '../src/test-writer-coordinator.mjs';
import {beginReserveReplay,replayReserveNext} from '../src/test-reconcile-line.mjs';

class MemoryFirestore{
 constructor(){this.docs=new Map();this.lostAck=false;this.serial=Promise.resolve();}
 doc(path){return {path,get:async()=>({exists:this.docs.has(path),
  data:()=>structuredClone(this.docs.get(path))})};}
 async runTransaction(callback){
  const prior=this.serial;let free;this.serial=new Promise(resolve=>free=resolve);
  await prior;
  try{
   const queued=[],tx={
    get:async ref=>this.doc(ref.path).get(),
    update:(ref,data)=>queued.push([ref.path,data])
   };
   const result=await callback(tx);
   for(const [path,data] of queued)this.docs.set(path,{
    ...this.docs.get(path),...structuredClone(data)});
   if(this.lostAck){this.lostAck=false;throw Error('firestore-ack-lost');}
   return result;
  }finally{free();}
 }
}
const gen='0123456789abcdef01234567',hash='a'.repeat(64),
 now=1900000000000,fromEpoch=5,uid='operator_1';
function entry(sequence,prev){
 const op={id:'reserve_operation_'+sequence,type:'load',truckId:'truck1',
  shiftId:'shift1',createdAt:now,expectedRevision:1,expectedTtnRevision:0,
  arrivalTimestamp:now-1000,lastLoadTimestamp:0,wantArrived:false,
  collect:false,cycleMinutes:15};
 const result={outcome:'rejected',reason:'duplicate-or-arrival-changed',
  status:{cycleRevision:2},log:null};
 const requestHash=createHash('sha256').update(JSON.stringify(op)).digest('hex');
 const ledger={sequence,epoch:fromEpoch,uid,workspaceId:'main_workspace',
  op,requestHash,result,at:now,previousHash:prev};
 return {...ledger,hash:sha256(prev+'\n'+canonical(ledger))};
}
function fixture(){
 const db=new MemoryFirestore(),initial=sha256('reserve:'+hash+':'+fromEpoch),
  first=entry(1,initial),second=entry(2,first.hash);
 db.docs.set(REPLICA_DOC,{protocol:1,projectId:'samosval-offline',channel:'test',
  readyForFailover:true,lastSequence:20,hash,generation:gen});
 db.docs.set(OWNER_DOC,{protocol:1,projectId:'samosval-offline',owner:'firebase',
  holder:'firebase_reserve',generation:gen,epoch:fromEpoch,observedSequence:20,
  reserveSequence:2,reserveHash:second.hash,pending:{},leaseUntil:now+60000});
 const path=n=>REPLICA_DOC+'/reserve_ops_'+gen+'/'+String(n).padStart(20,'0');
 db.docs.set(path(1),first);db.docs.set(path(2),second);
 return {db,first,second,path,base:{sequence:20,hash}};
}
const begin=({db,base})=>beginReserveReplay({firestore:db,projectId:'samosval-offline',
 pool:{},baselineReader:async()=>base,now,fenceEnabled:true});
const next=(db,apply)=>replayReserveNext({
 firestore:db,projectId:'samosval-offline',pool:{},apply,fenceEnabled:true});
test('legacy reserve_ops recovery must not skip typed Spark history',async()=>{
 const f=fixture();
 f.db.docs.get(REPLICA_DOC).typedProtocol=1;
 f.db.docs.get(REPLICA_DOC).typedSequence=20;
 f.db.docs.get(OWNER_DOC).reserveSequence=0;
 await assert.rejects(begin(f),/reconcile-typed-history-replay-not-supported/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'firebase',
  'failed old recovery must not freeze or promote the real writer');
});
test('reverse replay rejects a NAS head beyond last confirmed snapshot',async()=>{
 const fix=fixture();
 await assert.rejects(begin({...fix,base:{sequence:21,hash}}),/reconcile-nas-base-diverged/);
 assert.equal(fix.db.docs.get(OWNER_DOC).owner,'firebase');
});
test('recovery fences both writers and verifies every operation/hash',async()=>{
 const f=fixture();
 const started=await begin(f);
 assert.equal(started.started,true);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling');
 assert.equal(f.db.docs.get(OWNER_DOC).epoch,fromEpoch+1);
 await assert.rejects(acquireNasWritePermit({firestore:f.db,projectId:'samosval-offline',
  nodeId:'nas_instance_1',now}),/writer-synology-not-authorized/);
 let applied=0;
 const receipts=new Map();
 const apply=async(_pool,user,operation)=>{
  applied++;
  const existing=receipts.get(operation.id);
  if(existing)return {...existing,replayed:true};
  const event=operation.id===f.first.op.id?f.first:f.second;
  assert.equal(user,uid);
  receipts.set(operation.id,event.result);
  return event.result;
 };
 f.db.lostAck=true;
 await assert.rejects(next(f.db,apply),/firestore-ack-lost/);
 assert.equal(f.db.docs.get(OWNER_DOC).recovery.appliedSequence,1);
 // A lost remote acknowledgment must not create a second PostgreSQL load.
 assert.equal((await next(f.db,apply)).applied,2);
 const complete=await next(f.db,apply);
 assert.equal(complete.complete,true);
 assert.equal(complete.applied,2);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling');
 assert.equal(f.db.docs.get(OWNER_DOC).recovery.status,'applied');
 assert.equal(receipts.size,2);
 // First POST was delivered, second POST delivered once.
 assert.equal(applied,2);
});
test('corrupted reserve ledger is refused before touching PostgreSQL',async()=>{
 const f=fixture();await begin(f);
 f.db.docs.get(f.path(1)).hash='0'.repeat(64);
 let invoked=0;
 await assert.rejects(next(f.db,async()=>{invoked++;return f.first.result;}),
  /reconcile-event-hash-mismatch/);
 assert.equal(invoked,0);
 assert.equal(f.db.docs.get(OWNER_DOC).recovery.appliedSequence,0);
});
test('resume after process restart uses persisted recovery cursor',async()=>{
 const f=fixture();await begin(f);
 const resumed=await begin(f);
 assert.equal(resumed.resumed,true);
 assert.equal(resumed.appliedSequence,0);
 const apply=async(_pool,_uid,op)=>
  op.id===f.first.op.id?f.first.result:f.second.result;
 await next(f.db,apply);
 const again=await begin(f);
 assert.equal(again.appliedSequence,1);
 const finish=await next(f.db,apply);
 assert.equal(finish.applied,2);
});
