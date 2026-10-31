import test from 'node:test';
import assert from 'node:assert/strict';
import {REPLICA_DOC} from '../src/test-replica.mjs';
import {OWNER_DOC,OWNER_LEASE_MS,FENCE_GRACE_MS,OPERATION_HOLD_MS,
 claimNasOwnership,acquireNasWritePermit,releaseNasWritePermit,
 promoteTestReserve,readWriteOwnership} from '../src/test-writer-coordinator.mjs';

class Firestore {
 constructor(){this.docs=new Map();this.offline=false;}
 doc(path){return {path,get:async()=>this.snapshot(path)};}
 snapshot(path){return {exists:this.docs.has(path),data:()=>structuredClone(this.docs.get(path))};}
 async runTransaction(fn){
  if(this.offline)throw Error('firebase-offline');
  const writes=[];
  const tx={
   get:async ref=>this.snapshot(ref.path),
   create:(ref,data)=>writes.push(['create',ref.path,data]),
   update:(ref,data)=>writes.push(['update',ref.path,data])
  };
  const result=await fn(tx);
  if(this.offline)throw Error('firebase-offline');
  for(const [mode,path,data] of writes){
   if(mode==='create'){if(this.docs.has(path))throw Error('already-exists');this.docs.set(path,structuredClone(data));}
   else {if(!this.docs.has(path))throw Error('not-found');this.docs.set(path,{...this.docs.get(path),...structuredClone(data)});}
  }
  return result;
 }
}
const t0=1900000000000, hash='a'.repeat(64),nodeA='nas_instance_A',nodeB='nas_instance_B';
function setup(){
 const firestore=new Firestore(),checkpoint={sequence:27,hash};
 firestore.docs.set(REPLICA_DOC,{protocol:1,channel:'test',writer:'synology',
  projectId:'samosval-offline',generation:'verified_generation',lastSequence:27,
  hash,readyForFailover:false,typedProtocol:1,typedSequence:27,accessProtocol:1,
  promotionProof:{protocol:2,writerGate:'sql016',generation:'verified_generation',
   epoch:1,sequence:27,hash,snapshotHash:hash,documents:12}});
 return {firestore,checkpoint};
}
const claim=(f,node,checkpoint,now=t0)=>claimNasOwnership({
 firestore:f,projectId:'samosval-offline',nodeId:node,checkpoint,now});
const permit=(f,node,now=t0,id)=>acquireNasWritePermit({
 firestore:f,projectId:'samosval-offline',nodeId:node,now,...(id?{permitId:id}:{})});
const release=(f,node,p)=>releaseNasWritePermit({
 firestore:f,projectId:'samosval-offline',nodeId:node,permit:p});
const promote=(f,epoch,now)=>promoteTestReserve({
 firestore:f,projectId:'samosval-offline',expectedEpoch:epoch,now});

test('no NAS writer is created before the verified snapshot receipt',async()=>{
 const {firestore,checkpoint}=setup();
 await assert.rejects(claim(firestore,nodeA,{sequence:26,hash}),/writer-mirror-not-confirmed-locally/);
 assert.equal(firestore.docs.has(OWNER_DOC),false);
 const established=await claim(firestore,nodeA,checkpoint);
 assert.equal(established.created,true);
 assert.equal((await readWriteOwnership({firestore,projectId:'samosval-offline'})).epoch,1);
});
test('initial NAS ownership remembers unreplicated SQL014 head',async()=>{
 const {firestore,checkpoint}=setup();
 await claimNasOwnership({firestore,projectId:'samosval-offline',
  nodeId:nodeA,checkpoint,headSequence:29,now:t0});
 assert.equal(firestore.docs.get(OWNER_DOC).observedSequence,29);
 firestore.docs.get(REPLICA_DOC).readyForFailover=true;
 await assert.rejects(promote(firestore,1,t0+OWNER_LEASE_MS+FENCE_GRACE_MS+1),
  /writer-reserve-not-ready/);
});
test('two NAS nodes cannot both own write permission',async()=>{
 const {firestore,checkpoint}=setup();
 await claim(firestore,nodeA,checkpoint);
 await assert.rejects(claim(firestore,nodeB,checkpoint,t0+2000),/writer-lease-held-by-another-process/);
 await assert.rejects(permit(firestore,nodeB,t0+2000),/writer-synology-not-authorized/);
 const valid=await permit(firestore,nodeA,t0+2000);
 assert.equal(valid.epoch,1);
 assert.equal(await release(firestore,nodeB,valid),false);
 assert.equal(await release(firestore,nodeA,valid),true);
 assert.equal(await release(firestore,nodeA,valid),false);
});
test('an unreachable authority fails closed, including permit delivery',async()=>{
 const {firestore,checkpoint}=setup();
 await claim(firestore,nodeA,checkpoint);
 firestore.offline=true;
 await assert.rejects(permit(firestore,nodeA,t0+1),/firebase-offline/);
 await assert.rejects(claim(firestore,nodeA,checkpoint,t0+2),/firebase-offline/);
 firestore.offline=false;
 assert.equal((await permit(firestore,nodeA,t0+3)).epoch,1);
});
test('stale NAS process is fenced after lease and grace',async()=>{
 const {firestore,checkpoint}=setup();
 await claim(firestore,nodeA,checkpoint);
 const after=t0+OWNER_LEASE_MS+FENCE_GRACE_MS+1;
 const next=await claim(firestore,nodeB,checkpoint,after);
 assert.equal(next.epoch,2);
 await assert.rejects(permit(firestore,nodeA,after+1),/writer-synology-not-authorized/);
 assert.equal((await permit(firestore,nodeB,after+1)).epoch,2);
});
test('pending operations cannot be ignored during takeover',async()=>{
 const {firestore,checkpoint}=setup();
 await claim(firestore,nodeA,checkpoint);
 const p=await permit(firestore,nodeA,t0+1000);
 // Simulate loss of heartbeat while a server command remains in flight.
 // The coordinator may observe an expired lease while the recorded permit
 // still has time left; it must not transfer ownership in that interval.
 firestore.docs.get(OWNER_DOC).leaseUntil=t0+1000;
 await assert.rejects(claim(firestore,nodeB,checkpoint,t0+FENCE_GRACE_MS+1001),/writer-pending-operations/);
 const after=p.until+FENCE_GRACE_MS+1;
 assert.ok(after>t0+1000+FENCE_GRACE_MS);
 await assert.rejects(claim(firestore,nodeB,checkpoint,after),/writer-pending-operations/,
  'expired permits must not be silently discarded while NAS may still commit');
 assert.equal(await release(firestore,nodeA,p),true);
 assert.equal((await claim(firestore,nodeB,checkpoint,after)).epoch,2);
});
test('reserve promotion refuses unready mirror, live lease, or outstanding permits',async()=>{
 const {firestore,checkpoint}=setup();
 await claim(firestore,nodeA,checkpoint);
 const after=t0+OWNER_LEASE_MS+FENCE_GRACE_MS+1;
 await assert.rejects(promote(firestore,1,after),/writer-reserve-not-ready/);
 firestore.docs.get(REPLICA_DOC).readyForFailover=true;
 await assert.rejects(promote(firestore,1,t0+1),/writer-promotion-wait-for-nas/);
 const p=await permit(firestore,nodeA,t0+1000);
 // Force an early expired lease to exercise the outstanding-permit gate.
 firestore.docs.get(OWNER_DOC).leaseUntil=t0+1000;
 await assert.rejects(promote(firestore,1,t0+FENCE_GRACE_MS+1001),/writer-promotion-wait-for-nas/);
 await assert.rejects(promote(firestore,1,p.until+FENCE_GRACE_MS+1),/writer-promotion-wait-for-nas/,
  'must not promote while a possibly late NAS commit is unresolved');
 assert.equal(await release(firestore,nodeA,p),true);
 const changed=await promote(firestore,1,p.until+FENCE_GRACE_MS+1);
 assert.equal(changed.owner,'firebase');
 assert.equal(changed.epoch,2);
 assert.equal(changed.recoveryPoint,27);
 await assert.rejects(permit(firestore,nodeA,p.until+FENCE_GRACE_MS+2),/writer-synology-not-authorized/);
 await assert.rejects(claim(firestore,nodeA,checkpoint,p.until+FENCE_GRACE_MS+2),/writer-owner-not-synology/);
 await assert.rejects(promote(firestore,1,p.until+FENCE_GRACE_MS+3),/writer-promotion-epoch-changed/);
});

test('unreplicated NAS commit forbids promotion even with no pending permits',async()=>{
 const {firestore,checkpoint}=setup();
 await claim(firestore,nodeA,checkpoint);
 const p=await permit(firestore,nodeA,t0+1);
 assert.equal(await releaseNasWritePermit({firestore,projectId:'samosval-offline',
  nodeId:nodeA,permit:p,committedSequence:29}),true);
 assert.equal(firestore.docs.get(OWNER_DOC).observedSequence,29);
 assert.equal(Object.keys(firestore.docs.get(OWNER_DOC).pending).length,0);
 firestore.docs.get(REPLICA_DOC).readyForFailover=true;
 await assert.rejects(promote(firestore,1,t0+OWNER_LEASE_MS+FENCE_GRACE_MS+1),
  /writer-reserve-not-ready/);
 // A heartbeat must NEVER lower the confirmed high-water to the mirrored one.
 await claim(firestore,nodeA,checkpoint,t0+1000);
 assert.equal(firestore.docs.get(OWNER_DOC).observedSequence,29);
 // Even a valid expiring lease does not override the stale backup.
 await assert.rejects(promote(firestore,1,t0+OWNER_LEASE_MS+FENCE_GRACE_MS+2),
  /writer-reserve-not-ready/);
});
test('invalid or tampered ownership blocks operations',async()=>{
 const {firestore,checkpoint}=setup();
 await claim(firestore,nodeA,checkpoint);
 firestore.docs.get(OWNER_DOC).epoch=-1;
 await assert.rejects(permit(firestore,nodeA),/writer-ownership-invalid/);
 firestore.docs.delete(OWNER_DOC);
 firestore.docs.get(REPLICA_DOC).hash='bad';
 await assert.rejects(claim(firestore,nodeB,checkpoint),/writer-mirror-checkpoint-invalid/);
});
test('only the dedicated TEST Firebase project is accepted',async()=>{
 const {firestore,checkpoint}=setup();
 await assert.rejects(claimNasOwnership({
  firestore,projectId:'samosval-test',nodeId:nodeA,checkpoint,now:t0}),/replica-test-project-required/);
});

test('opt-in NAS HTTP guard refuses absent ownership, then leases and releases a write',async()=>{
 const {firestore,checkpoint}=setup();
 const {startNasWriterFence,nasWriterFenceRuntime}=await import('../src/test-writer-guard.mjs');
 let now=t0;
 const guard=startNasWriterFence({
  pool:{query:async sql=>sql.includes('last_sequence')?{rows:[{n:'27'}]}:{rows:[checkpoint]}},projectId:'samosval-offline',
  env:{TEST_WRITER_FENCE_ENABLED:'1'},firestoreFactory:()=>firestore,
  clock:()=>now,intervalMs:1000000
 });
 try{
  await assert.rejects(guard.acquire(),/writer-no-current-lease/);
  await guard.runOnce();
  const ticket=await guard.acquire();
  assert.equal(ticket.epoch,1);
  assert.equal(Object.keys(firestore.docs.get(OWNER_DOC).pending).length,1);
  assert.equal(await ticket.release(),true);
  assert.equal(Object.keys(firestore.docs.get(OWNER_DOC).pending).length,0);
  assert.equal(nasWriterFenceRuntime.allowedWrites,1);
  firestore.offline=true;
  await assert.rejects(guard.acquire(),/firebase-offline/);
  assert.equal(nasWriterFenceRuntime.refusedWrites,2);
 }finally{await guard.stop();}
});
test('the writer gate remains disabled unless explicitly opted into TEST',async()=>{
 const {startNasWriterFence}=await import('../src/test-writer-guard.mjs');
 const guard=startNasWriterFence({pool:{},projectId:'production-project',
  env:{TEST_WRITER_FENCE_ENABLED:'0'}});
 assert.equal(guard.enabled,false);
 await guard.stop();
});

test('a ready flag alone cannot promote without a full SQL016 exact-epoch certificate',async()=>{
 const {firestore,checkpoint}=setup();
 await claim(firestore,nodeA,checkpoint);
 const meta=firestore.docs.get(REPLICA_DOC),at=t0+OWNER_LEASE_MS+FENCE_GRACE_MS+1;
 meta.readyForFailover=true;
 for(const invalid of [
  {promotionProof:null},
  {promotionProof:{...meta.promotionProof,epoch:2}},
  {promotionProof:{...meta.promotionProof,sequence:26}},
  {promotionProof:{...meta.promotionProof,writerGate:'legacy'}},
  {typedSequence:26},
  {accessProtocol:0}
 ]){
  const previous={...meta};Object.assign(meta,invalid);
  await assert.rejects(promote(firestore,1,at),/writer-reserve-not-ready/);
  Object.assign(meta,previous);
 }
 assert.equal((await promote(firestore,1,at)).owner,'firebase');
});
