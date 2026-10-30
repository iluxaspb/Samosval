import test from 'node:test';
import assert from 'node:assert/strict';
import {createImmediateNasRecovery} from '../src/nas-recovery-trigger.mjs';
const head={sequence:17,hash:'b'.repeat(64)};
function authority(){return {format:'samosval-test-failover',projectId:'samosval-offline',
  workspaceId:'main_workspace',enabled:true,provider:'firebase',epoch:2,head:{...head}};}
function fixture(){
  let state=authority(),verified=true,replayed=0;
  const restore=createImmediateNasRecovery({
    readAuthority:async()=>structuredClone(state),
    replayFirebaseChanges:async payload=>{replayed++;assert.equal(payload.allowBusinessWrites,false);},
    verifyNasReplica:async()=>verified
  });
  return {restore,reads:()=>replayed,state:x=>{state=x;},verify:x=>{verified=x;}};
}
test('NAS healthy immediately initiates reconciliation but does not permit concurrent writers',async()=>{
  const h=fixture();const result=await h.restore.onReady({nasHealthy:true});
  assert.equal(h.reads(),1);
  assert.equal(result.status,'nas-restored-candidate');
  assert.equal(result.switchBack,false);
  assert.deepEqual(result.target,head);
});
test('unhealthy NAS and NAS-authoritative state perform no recovery writes',async()=>{
  const h=fixture();
  assert.equal((await h.restore.onReady({nasHealthy:false})).status,'nas-unavailable');
  assert.equal(h.reads(),0);
  h.state({...authority(),provider:'synology'});
  assert.equal((await h.restore.onReady({nasHealthy:true})).status,'firebase-not-authoritative');
  assert.equal(h.reads(),0);
});
test('stale or diverged NAS never claimed ready',async()=>{
  const h=fixture();h.verify(false);
  const result=await h.restore.onReady({nasHealthy:true});
  assert.equal(result.status,'nas-restore-not-verified');
  assert.equal(result.switchBack,false);
});
test('Firebase head advances during copying, so NAS must rejoin from newest head',async()=>{
  let state=authority();
  const restore=createImmediateNasRecovery({
    readAuthority:async()=>structuredClone(state),
    replayFirebaseChanges:async()=>{state.head={sequence:18,hash:'c'.repeat(64)};},
    verifyNasReplica:async()=>true
  });
  const result=await restore.onReady({nasHealthy:true});
  assert.equal(result.status,'firebase-head-advanced');
  assert.equal(result.switchBack,false);
});
test('concurrent NAS readiness notifications do not trigger duplicate replay',async()=>{
  let release;const barrier=new Promise(resolve=>{release=resolve;});let count=0;
  const restore=createImmediateNasRecovery({
    readAuthority:async()=>authority(),
    replayFirebaseChanges:async()=>{count++;await barrier;},
    verifyNasReplica:async()=>true
  });
  const first=restore.onReady({nasHealthy:true});
  const second=await restore.onReady({nasHealthy:true});
  assert.equal(second.status,'recovery-already-running');
  release();
  assert.equal((await first).status,'nas-restored-candidate');
  assert.equal(count,1);
});
