import test from 'node:test';
import assert from 'node:assert/strict';
import {createSparkOwnerReader,SparkOwnerError} from '../../test-app/synology/spark-owner.mjs';

const NOW=1900000000000,generation='0123456789abcdef01234567',hash='a'.repeat(64);
function setup({owner='synology',head=15,observed=15,ready=false,projectId='samosval-offline',
  holder,connected=true}={}){
 const docs=new Map([
  ['samosval_test_replica/v1',{protocol:1,channel:'test',projectId:'samosval-offline',
   generation,hash,lastSequence:head,readyForFailover:ready}],
  ['samosval_test_replica/write_owner',{protocol:1,projectId:'samosval-offline',
   owner,epoch:2,holder:holder||(owner==='firebase'?'firebase_reserve':'nas_writer_A'),
   generation,observedSequence:observed,leaseUntil:NOW+60000,pending:{}}]
 ]);
 let currentUser={uid:'test-user'},remoteReads=0,remoteWrites=0,live=connected;
 const firestore={app:{options:{projectId}},
  doc:path=>({path}),
  runTransaction:async fn=>{
   if(!live)throw Error('firestore-offline');
   const tx={get:async ref=>{remoteReads++;const data=docs.get(ref.path);
    return {exists:!!data,data:()=>structuredClone(data)};},
    set:()=>remoteWrites++,update:()=>remoteWrites++};
   return fn(tx);
  }
 };
 const create=()=>createSparkOwnerReader({firestore,getUser:()=>currentUser,clock:()=>NOW});
 return {docs,create,get counts(){return {remoteReads,remoteWrites};},
  offline:()=>{live=false;},switchUser:()=>{currentUser={uid:'other'};}};
}
test('Spark owner read uses only Firestore, no Cloud Run or extra API server',async()=>{
 const s=setup();const reader=s.create();
 const owner=await reader.readOwner();
 assert.equal(owner.source,'spark-firestore');
 assert.equal(owner.owner,'synology');
 assert.equal(owner.readyForFailover,false);
 assert.deepEqual(s.counts,{remoteReads:2,remoteWrites:0});
 reader.stop();
});
test('unreplicated NAS head does not make stale standby writable',async()=>{
 const s=setup({head:15,observed:17});
 const v=await s.create().readOwner();
 assert.equal(v.owner,'synology');
 assert.equal(v.lag,2);
 assert.equal(v.readyForFailover,false);
});
test('only certified standby epoch and generation permits Firebase to be selected',async()=>{
 const valid=setup({owner:'firebase',ready:true});
 const ready=await valid.create().readOwner();
 assert.equal(ready.owner,'firebase');
 assert.equal(ready.readyForFailover,true);
 for(const scenario of [
  {owner:'firebase',ready:false},
  {owner:'firebase',ready:true,observed:14},
  {owner:'firebase',ready:true,holder:'other_holder'}
 ]){
  const s=setup(scenario);
  await assert.rejects(s.create().readOwner(),{code:'spark-reserve-not-certified'});
  assert.equal(s.counts.remoteWrites,0);
 }
});
test('reconciling or handoff never count as a writable reserve',async()=>{
 for(const owner of ['handoff','reconciling']){
  const s=setup({owner});
  const v=await s.create().readOwner();
  assert.equal(v.owner,owner);
  assert.equal(v.readyForFailover,false);
 }
});
test('wrong Firebase project and changed auth are always refused',async()=>{
 assert.throws(()=>setup({projectId:'production-project'}).create(),/spark-test-project-required/);
 const s=setup(),reader=s.create();
 s.switchUser();
 await assert.rejects(reader.readOwner(),{code:'spark-session-changed'});
 reader.stop();
});
test('offline read and tampered owner metadata both fail closed',async()=>{
 const s=setup(),reader=s.create();
 s.offline();
 await assert.rejects(reader.readOwner(),{code:'spark-authority-unavailable'});
 const t=setup();
 t.docs.get('samosval_test_replica/v1').hash='tampered';
 await assert.rejects(t.create().readOwner(),{code:'spark-replica-invalid'});
 const u=setup();
 u.docs.get('samosval_test_replica/write_owner').epoch=-1;
 await assert.rejects(u.create().readOwner(),{code:'spark-writer-invalid'});
 assert.equal(t.counts.remoteWrites+u.counts.remoteWrites,0);
});

test('a sealed SQL016 promotion proof is exposed only for the matching NAS epoch',async()=>{
 const s=setup({owner:'synology',ready:true});
 const m=s.docs.get('samosval_test_replica/v1');
 Object.assign(m,{
  writer:'synology',typedProtocol:1,typedSequence:15,accessProtocol:1,
  promotionProof:{protocol:2,writerGate:'sql016',generation,epoch:2,
   sequence:15,hash,snapshotHash:hash,documents:33}
 });
 const good=await s.create().readOwner();
 assert.equal(good.owner,'synology');
 assert.equal(good.promotionCertified,true);
 assert.equal(good.readyForFailover,false,'NAS ownership is not a live reserve');
 assert.equal(good.leaseUntil,NOW+60000);
 m.promotionProof.epoch=1;
 assert.equal((await s.create().readOwner()).promotionCertified,false);
});
