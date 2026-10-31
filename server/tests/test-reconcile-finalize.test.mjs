import test from 'node:test';
import assert from 'node:assert/strict';
import {REPLICA_DOC,rowId,canonical,sha256} from '../src/test-replica.mjs';
import {OWNER_DOC,claimNasOwnership,acquireNasWritePermit} from '../src/test-writer-coordinator.mjs';
import {stageRecoveredGeneration,completeNasHandback} from '../src/test-reconcile-finalize.mjs';

class Firebase{
 constructor(){this.docs=new Map();this.loseAck=false;}
 doc(path){return{path,get:async()=>this.snapshot(path)};}
 snapshot(path){return{exists:this.docs.has(path),data:()=>structuredClone(this.docs.get(path))};}
 collection(path){return{get:async()=>({docs:[...this.docs.entries()].filter(([key])=>
  key.startsWith(path+'/')).map(([key,value])=>({id:key.slice(path.length+1),
  data:()=>structuredClone(value)}))})};}
 batch(){const writes=[];return{
  set:(ref,value)=>writes.push([ref.path,value]),
  commit:async()=>{for(const [path,value] of writes)this.docs.set(path,structuredClone(value));}
 };}
 async runTransaction(fn){
  const writes=[],tx={
   get:async ref=>this.snapshot(ref.path),
   set:(ref,data)=>writes.push(['set',ref.path,data]),
   update:(ref,data)=>writes.push(['update',ref.path,data])
  };
  const value=await fn(tx);
  for(const [mode,path,data] of writes){
   if(mode==='set')this.docs.set(path,structuredClone(data));
   else this.docs.set(path,{...this.docs.get(path),...structuredClone(data)});
  }
  if(this.loseAck){this.loseAck=false;throw Error('lost-remote-reply');}
  return value;
 }
}
const oldGen='0123456789abcdef01234567',oldHash='a'.repeat(64),
 now=1900000005000;
function fixture(){
 const db=new Firebase(),sequence=77,key={id:'main_workspace'};
 const table='workspaces',row={id:'main_workspace',cycle_minutes:15};
 const envelope={table,keyJson:canonical(key),rowJson:canonical(row),
  appliedSequence:sequence};
 const snapshotHash=sha256(table+'\n'+envelope.keyJson+'\n'+envelope.rowJson+'\n');
 const snapshot={sequence,snapshotHash,rows:[{table,key,id:rowId(table,key),envelope}]};
 const initial=sha256('reserve:'+oldHash+':5');
 db.docs.set(REPLICA_DOC,{protocol:1,projectId:'samosval-offline',channel:'test',
  writer:'synology',generation:oldGen,lastSequence:20,hash:oldHash,
  readyForFailover:true});
 db.docs.set(OWNER_DOC,{protocol:1,projectId:'samosval-offline',owner:'reconciling',
  holder:'reconcile_worker',epoch:6,generation:oldGen,
  observedSequence:20,leaseUntil:now+60000,pending:{},
  recovery:{generation:oldGen,baseSequence:20,baseHash:oldHash,fromEpoch:5,
   targetSequence:1,appliedSequence:1,targetHash:initial,appliedHash:initial,
   status:'applied'}});
 const stage=(head=sequence)=>stageRecoveredGeneration({
  firestore:db,projectId:'samosval-offline',pool:{},
  snapshotReader:async()=>snapshot,headReader:async()=>head,fenceEnabled:true});
 const receipts=[];
 const finish=(reader=async()=>snapshot)=>completeNasHandback({
  firestore:db,projectId:'samosval-offline',pool:{},
  snapshotReader:reader,receiptWriter:async(_pool,n,h)=>receipts.push({n,h}),now,
 fenceEnabled:true});
 return {db,snapshot,stage,finish,receipts};
}
test('old handback cannot publish a NAS generation when Spark typed history exists',async()=>{
 const f=fixture();
 f.db.docs.get(REPLICA_DOC).typedProtocol=1;
 f.db.docs.get(REPLICA_DOC).typedSequence=20;
 await assert.rejects(f.stage(),/handoff-not-reconciled/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling');
 assert.equal(f.receipts.length,0);
});
test('complete reserve-to-NAS handback publishes new verified generation',async()=>{
 const f=fixture();
 const stage=await f.stage();
 assert.equal(stage.staged,true);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'handoff');
 assert.equal(f.db.docs.get(REPLICA_DOC).readyForFailover,false);
 await assert.rejects(acquireNasWritePermit({
  firestore:f.db,projectId:'samosval-offline',nodeId:'old_nas_process',now
 }),/writer-synology-not-authorized/);
 const done=await f.finish();
 assert.equal(done.completed,true);
 assert.equal(f.receipts.length,1);
 assert.equal(f.receipts[0].n,77);
 const owner=f.db.docs.get(OWNER_DOC);
 assert.equal(owner.owner,'synology');
 assert.equal(owner.holder,'nas_handoff_pending');
 assert.equal(owner.pending&&Object.keys(owner.pending).length,0);
 assert.equal(owner.recovery.status,'completed');
 const checkpoint={sequence:77,hash:f.db.docs.get(REPLICA_DOC).hash};
 const claim=await claimNasOwnership({firestore:f.db,projectId:'samosval-offline',
  nodeId:'fresh_nas_process',checkpoint,now});
 assert.equal(claim.epoch,owner.epoch+1);
 assert.equal((await f.finish()).replayed,true);
});
test('remote publish ACK lost is resumable without a second generation',async()=>{
 const f=fixture();
 f.db.loseAck=true;
 await assert.rejects(f.stage(),/lost-remote-reply/);
 const published=f.db.docs.get(REPLICA_DOC).generation;
 const recovered=await f.stage();
 assert.equal(recovered.resumed,true);
 assert.equal(recovered.generation,published);
 const done=await f.finish();
 assert.equal(done.completed,true);
});
test('PG receipt cannot be acknowledged when new generation differs',async()=>{
 const f=fixture();await f.stage();
 const remote=f.db.docs.get(REPLICA_DOC);
 const key=[...f.db.docs.keys()].find(x=>x.startsWith(REPLICA_DOC+'/rows_'+remote.generation+'/'));
 f.db.docs.get(key).rowJson='{"tampered":true}';
 await assert.rejects(f.finish(),/handoff-record-hash-diverged/);
 assert.equal(f.receipts.length,0);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'handoff');
});
test('stale or changed NAS outbox prevents publishing handback',async()=>{
 const f=fixture();
 await assert.rejects(f.stage(78),/handoff-nas-changed-after-snapshot/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling');
});
test('lost local receipt keeps handoff fenced for retry',async()=>{
 const f=fixture();await f.stage();
 await assert.rejects(completeNasHandback({firestore:f.db,projectId:'samosval-offline',
  pool:{},snapshotReader:async()=>f.snapshot,
  receiptWriter:async()=>{throw Error('postgres-offline');},now,fenceEnabled:true}),/postgres-offline/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'handoff');
 assert.equal((await f.finish()).completed,true);
});
