import test from 'node:test';
import assert from 'node:assert/strict';
import {createFailoverCoordinator,firestoreAuthorityStore} from '../src/failover-coordinator.mjs';
import {LEASE_MS} from '../src/failover-policy.mjs';
const hash='a'.repeat(64),nextHash='b'.repeat(64),checkpoint={sequence:0,hash};
function fixture(){
  let state=null,clock=1000,tail=Promise.resolve(),allowed=true,valid=true,adapters=true;
  const replicas={synology:true,firebase:true};
  const clone=x=>structuredClone(x),store={read:async()=>clone(state),transaction:fn=>{
    const pending=tail.then(async()=>{let next=state;const result=await fn({read:async()=>clone(state),write:async x=>{next=clone(x);}});state=next;return result;});
    tail=pending.catch(()=>{});return pending;
  }};
  const make=()=>createFailoverCoordinator({store,now:()=>clock,authorizeAdmin:async uid=>({uid,role:allowed?'admin':'viewer',status:'active'}),
    verifyCheckpoint:async()=>valid,verifyAdapters:async()=>({synology:adapters,firebase:adapters}),
    verifyReplica:async provider=>replicas[provider]===true});
  return {a:make(),b:make(),read:store.read,clock:x=>{clock=x;},allow:x=>{allowed=x;},valid:x=>{valid=x;},adapters:x=>{adapters=x;},replica:(provider,value)=>{replicas[provider]=value;}};
}
test('two isolated coordinators share one epoch; racing automatic takeovers do not create two writers',async()=>{
  const h=fixture();await h.a.prepare(checkpoint);let s=await h.a.read();s=await h.a.setMode('owner','auto',s.revision);
  h.clock(1000+LEASE_MS);
  const [a,b]=await Promise.all([h.a.takeover({consecutiveFailures:3,online:true}),h.b.takeover({consecutiveFailures:4,online:true})]);
  assert.equal(a.epoch,2);assert.equal(b.epoch,2);assert.equal((await h.read()).provider,'firebase');
  await assert.rejects(h.a.renew({epoch:1,sequence:0,hash}),/writer-fenced/);
});
test('lease renewal wins a race before takeover; takeover wins a race before renewal',async()=>{
  for(const takeoverFirst of [false,true]){
    const h=fixture();await h.a.prepare(checkpoint);let s=await h.a.read();await h.a.setMode('owner','auto',s.revision);h.clock(1000+LEASE_MS);
    const renew=()=>h.a.renew({epoch:1,sequence:0,hash}),take=()=>h.b.takeover({consecutiveFailures:3,online:true});
    const outcomes=await Promise.allSettled(takeoverFirst?[take(),renew()]:[renew(),take()]);
    assert.equal((await h.read()).provider,takeoverFirst?'firebase':'synology');
    assert.equal(outcomes.filter(x=>x.status==='rejected').length,takeoverFirst?1:0);
  }
});
test('a stale admin form cannot undo a concurrent takeover or newer administrator choice',async()=>{
  const h=fixture();await h.a.prepare(checkpoint);const old=await h.a.read();await h.a.setMode('owner','firebase',old.revision);
  await assert.rejects(h.b.setMode('owner','synology',old.revision),/state-changed/);
  assert.equal((await h.read()).provider,'firebase');
});
test('lost control response is read back from shared storage, never guessed locally',async()=>{
  const h=fixture();await h.a.prepare(checkpoint);const s=await h.a.read();await h.a.setMode('owner','firebase',s.revision);
  assert.equal((await h.b.read()).provider,'firebase');assert.equal((await h.b.read()).epoch,2);
});
test('unverified snapshot, missing adapter or revoked admin never enables or moves authority',async()=>{
  const h=fixture();h.valid(false);await assert.rejects(h.a.prepare(checkpoint),/checkpoint-not-verified/);assert.equal((await h.a.read()).enabled,false);
  h.valid(true);h.adapters(false);await assert.rejects(h.a.prepare(checkpoint),/verified-adapters/);h.adapters(true);await h.a.prepare(checkpoint);
  h.allow(false);const s=await h.a.read();await assert.rejects(h.a.setMode('owner','firebase',s.revision),e=>e.status===403);assert.equal((await h.a.read()).provider,'synology');
});
test('concurrent publication and forced takeover preserve one canonical head',async()=>{
  const h=fixture();await h.a.prepare(checkpoint);const s=await h.a.read(),proof={provider:'synology',epoch:s.epoch,sequence:0,hash};
  const outcomes=await Promise.allSettled([h.a.publish(proof,{sequence:1,hash:nextHash}),h.b.setMode('owner','firebase',s.revision)]);
  const current=await h.a.read();
  if(outcomes[0].status==='fulfilled'){
    assert.equal(current.sequence,1);assert.equal(outcomes[1].status,'rejected');
    await assert.rejects(h.b.setMode('owner','firebase',current.revision),/replica-not-caught-up/);
    const synced=await h.a.caughtUp('firebase',{sequence:1,hash:nextHash});
    const f=await h.b.setMode('owner','firebase',synced.revision);assert.equal(f.head.hash,nextHash);
  }else{
    assert.equal(outcomes[1].status,'fulfilled');assert.equal(current.sequence,0);assert.equal(current.provider,'firebase');
    assert.equal(current.head.hash,hash);assert.match(outcomes[0].reason.message,/writer-fenced/);
  }
  await assert.rejects(h.a.publish(proof,{sequence:1,hash:nextHash}),/writer-fenced/);
});
test('Firestore binding refuses any other project and uses an isolated TEST path',async()=>{
  assert.throws(()=>firestoreAuthorityStore({projectId:'production',runTransaction(){}}),/test-firestore-required/);
  const calls=[],ref={get:async()=>({exists:false})},db={projectId:'samosval-offline',doc:path=>{calls.push(path);return ref;},
    runTransaction:async fn=>fn({get:async()=>({exists:false}),set:(r,s)=>calls.push(s)})};
  const store=firestoreAuthorityStore(db);assert.equal(await store.read(),null);
  await store.transaction(async tx=>{assert.equal(await tx.read(),null);await tx.write({test:true});});
  assert.equal(calls[0],'test_failover/main_workspace');assert.deepEqual(calls[1],{test:true});
});

test('immutable checkpoint is insufficient if either actual backend replica is stale',async()=>{
  const h=fixture();h.replica('firebase',false);
  await assert.rejects(h.a.prepare(checkpoint),/replica-not-verified/);
  assert.equal((await h.a.read()).enabled,false);
  h.replica('firebase',true);await h.a.prepare(checkpoint);
  const s=await h.a.read();
  h.replica('firebase',false);
  await assert.rejects(h.a.setMode('owner','firebase',s.revision),/replica-not-verified/);
  assert.equal((await h.a.read()).provider,'synology');
  h.replica('firebase',true);
  await h.a.setMode('owner','firebase',s.revision);
  assert.equal((await h.a.read()).provider,'firebase');
});
test('a stale NAS cannot be certified merely because Firebase retains immutable bytes',async()=>{
  const h=fixture();await h.a.prepare(checkpoint);
  let s=await h.a.read();s=await h.a.setMode('owner','firebase',s.revision);
  h.replica('synology',false);
  await assert.rejects(h.a.caughtUp('synology',checkpoint),/replica-not-verified/);
  assert.equal((await h.a.read()).revision,s.revision);
  s=await h.a.setMode('owner','auto',s.revision);
  await h.a.observeRecovery(true);
  h.clock(1000+60000);
  await assert.rejects(h.a.failback(),/replica-not-verified/);
  assert.equal((await h.a.read()).provider,'firebase');
  h.replica('synology',true);
  assert.equal((await h.a.failback()).provider,'synology');
});
test('auto takeover checks live Firebase replica again at moment of switching',async()=>{
  const h=fixture();await h.a.prepare(checkpoint);
  const s=await h.a.read();await h.a.setMode('owner','auto',s.revision);
  h.replica('firebase',false);h.clock(1000+LEASE_MS);
  await assert.rejects(h.a.takeover({consecutiveFailures:3,online:true}),/replica-not-verified/);
  assert.equal((await h.a.read()).provider,'synology');
  h.replica('firebase',true);
  assert.equal((await h.a.takeover({consecutiveFailures:3,online:true})).provider,'firebase');
});
