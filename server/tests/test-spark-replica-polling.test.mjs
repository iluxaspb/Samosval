import test from 'node:test';
import assert from 'node:assert/strict';
import {startTestReplica,shouldAuditSparkRemote,SPARK_REMOTE_AUDIT_INTERVAL_MS,replicaRuntime} from '../src/test-replica-runner.mjs';

test('a healthy PostgreSQL head is checked locally instead of polling Spark',()=>{
 const now=1900000000000;
 assert.equal(shouldAuditSparkRemote({now,lastAuditAt:now-1000,head:13,receipt:13}),false);
 assert.equal(shouldAuditSparkRemote({now,lastAuditAt:now-1000,head:14,receipt:13}),true);
 assert.equal(shouldAuditSparkRemote({now,lastAuditAt:now-1000,head:13,receipt:null}),true);
 assert.equal(shouldAuditSparkRemote({now,lastAuditAt:null,head:13,receipt:13}),true);
 assert.equal(shouldAuditSparkRemote({now,lastAuditAt:now-SPARK_REMOTE_AUDIT_INTERVAL_MS,head:13,receipt:13}),true);
});

test('Spark runner reads Firestore once at startup, on new outbox entries, and every 10 minutes',async()=>{
 let now=1900000000000,head=17,receipt=17,remoteCalls=0,locks=0;
 const pool={
  connect:async()=>({
   query:async sql=>{
    if(sql.includes('pg_try_advisory_lock')){locks++;return {rows:[{held:true}]};}
    if(sql.includes('pg_advisory_unlock')){locks--;return {rows:[{}]};}
    if(sql.includes('FROM reserve_outbox_cursor WHERE singleton=true) AS head'))
     return {rows:[{head:String(head),receipt:String(receipt)}]};
    throw Error('unexpected SQL '+sql);
   },release(){}
  })
 };
 const worker=startTestReplica({pool,projectId:'samosval-offline',
  env:{TEST_REPLICA_ENABLED:'1'},clock:()=>now,initialDelayMs:3600000,
  firestoreFactory:()=>{remoteCalls++;return {};},
  replicateImpl:async()=>{receipt=head;return {idle:true,sequence:head};}
 });
 try{
  assert.equal((await worker.runOnce()).idle,true);
  assert.equal(remoteCalls,1);
  for(let i=0;i<15;i++)await worker.runOnce();
  assert.equal(remoteCalls,1,'idle checks must not cost Firestore reads');
  assert.equal(replicaRuntime.skippedRemoteChecks,15);
  head++;
  await worker.runOnce();
  assert.equal(remoteCalls,2,'a new PostgreSQL outbox event causes prompt remote work');
  for(let i=0;i<15;i++)await worker.runOnce();
  assert.equal(remoteCalls,2);
  now+=SPARK_REMOTE_AUDIT_INTERVAL_MS;
  await worker.runOnce();
  assert.equal(remoteCalls,3,'periodic remote audit is still required');
  assert.equal(replicaRuntime.lastRemoteAuditAt,now);
  assert.equal(locks,0);
 }finally{await worker.stop();}
});

test('an unconfirmed remote delivery cannot be marked idle',async()=>{
 let now=1900000000000,remoteCalls=0;
 const pool={connect:async()=>({
  query:async sql=>sql.includes('pg_try_advisory_lock')?{rows:[{held:true}]}:
   sql.includes('pg_advisory_unlock')?{rows:[{}]}:{rows:[{head:'19',receipt:'18'}]},
  release(){}
 })};
 const worker=startTestReplica({pool,projectId:'samosval-offline',
  env:{TEST_REPLICA_ENABLED:'1'},clock:()=>now,initialDelayMs:3600000,
  firestoreFactory:()=>{remoteCalls++;return {};},
  replicateImpl:async()=>{throw Error('replica-remote-offline');}
 });
 try{
  await assert.rejects(worker.runOnce(),/replica-remote-offline/);
  await assert.rejects(worker.runOnce(),/replica-remote-offline/);
  assert.equal(remoteCalls,2,'a failed remote write must be retried');
  assert.equal(replicaRuntime.lastRemoteAuditAt,null);
 }finally{await worker.stop();}
});
