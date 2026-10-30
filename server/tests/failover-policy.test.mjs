import test from 'node:test';
import assert from 'node:assert/strict';
import {initialFailoverState,prepareFailover,setFailoverMode,renewNasLease,automaticFailover,
  publishCommit,recordReplica,writable,observeNasRecovery,automaticFailback,LEASE_MS,RECOVERY_MS,
  validateFailoverState} from '../src/failover-policy.mjs';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
const owner={uid:'admin',role:'admin',status:'active'};
const ready=(now=1000)=>prepareFailover(initialFailoverState(now),{adapters:{synology:true,firebase:true},checkpoint:{sequence:0,hash:a}},now);
const mode=(s,m,now=1000,actor=owner)=>setFailoverMode(s,m,{actor,expectedRevision:s.revision},now);
const proof=s=>({provider:s.provider,epoch:s.epoch,sequence:s.sequence,hash:s.head.hash});

test('unconfigured reserve cannot be selected, even by administrator',()=>{
  const s=initialFailoverState(1000);
  for(const m of ['auto','firebase','synology']) assert.throws(()=>mode(s,m),/failover-not-ready/);
  for(const adapters of [{},{synology:true},{firebase:true}]) assert.throws(()=>prepareFailover(s,{adapters,checkpoint:{sequence:0,hash:a}},1000),/verified-adapters/);
  assert.equal(writable(s,{provider:'synology',epoch:1,sequence:0,hash:a},1000),false);
});
test('only an active administrator can force either direction or change mode',()=>{
  for(const actor of [null,{...owner,role:'viewer'},{...owner,status:'disabled'},{...owner,deleted:true}])
    for(const m of ['auto','firebase','synology']) assert.throws(()=>mode(ready(),m,1000,actor),e=>e.status===403);
  const s=ready();assert.throws(()=>setFailoverMode(s,'firebase',{actor:owner,expectedRevision:s.revision-1},1000),/state-changed/);
});
test('HTTP outage, offline device, bad credentials or two failed probes never grant write authority',()=>{
  const s=mode(ready(),'auto');
  for(const input of [{consecutiveFailures:2,online:true},{consecutiveFailures:20,online:false},{consecutiveFailures:'3',online:true}])
    assert.equal(automaticFailover(s,input,100000),s);
  assert.equal(automaticFailover(s,{consecutiveFailures:3,online:true},s.leaseUntil-1),s);
  const f=automaticFailover(s,{consecutiveFailures:3,online:true},s.leaseUntil);
  assert.equal(f.provider,'firebase');assert.equal(f.epoch,s.epoch+1);
  assert.equal(writable(f,proof(s),s.leaseUntil),false);
  assert.equal(writable(f,proof(f),s.leaseUntil),true);
});
test('manual Firebase switch fences old NAS token immediately, including delayed retries',()=>{
  const s=ready(),old=proof(s),f=mode(s,'firebase');
  assert.equal(f.mode,'firebase');assert.equal(f.provider,'firebase');assert.equal(f.epoch,2);
  assert.equal(writable(f,old,1001),false);
  assert.throws(()=>renewNasLease(f,old,1001),/writer-fenced/);
  assert.throws(()=>publishCommit(f,old,{sequence:1,hash:b},1001),/writer-fenced/);
  const healthy={...f,healthySince:0};assert.equal(automaticFailback(healthy,100000),healthy);
});
test('lost NAS acknowledgement does not create an independent Firebase history',()=>{
  const s=ready(),old=proof(s);
  const published=publishCommit(s,old,{sequence:1,hash:b},1001);
  assert.equal(writable(published,old,1002),false,'a server with unapplied local state must recover first');
  const f=mode(published,'firebase',1002);
  assert.deepEqual(f.head,{sequence:1,hash:b},'takeover includes the already durable mutation and its receipt');
  assert.throws(()=>publishCommit(f,old,{sequence:1,hash:b},1003),/writer-fenced/);
});
test('Firebase changes prevent forced NAS return until the exact current checkpoint is verified',()=>{
  let f=mode(ready(),'firebase');
  f=publishCommit(f,proof(f),{sequence:1,hash:b},1100);
  assert.throws(()=>mode(f,'synology',1101),/replica-not-caught-up/);
  assert.throws(()=>recordReplica(f,'synology',{sequence:0,hash:a},1101),/checkpoint-mismatch/);
  assert.throws(()=>recordReplica(f,'synology',{sequence:1,hash:c},1101),/checkpoint-mismatch/);
  f=recordReplica(f,'synology',{sequence:1,hash:b},1102);
  const n=mode(f,'synology',1103);assert.equal(n.provider,'synology');assert.equal(n.epoch,3);
  assert.equal(n.leaseUntil,1103+LEASE_MS);assert.equal(writable(n,proof(f),1104),false);
});
test('auto return waits for a caught-up NAS and sustained health; another mutation resets recovery',()=>{
  let f=mode(mode(ready(),'auto'),'firebase');f=mode(f,'auto');
  f=observeNasRecovery(f,true,2000);
  assert.equal(automaticFailback(f,2000+RECOVERY_MS-1),f);
  assert.equal(automaticFailback(f,2000+RECOVERY_MS).provider,'synology');
  const changed=publishCommit(f,proof(f),{sequence:1,hash:b},3000);
  assert.equal(changed.healthySince,null);assert.equal(observeNasRecovery(changed,true,4000).healthySince,null);
  f=recordReplica(changed,'synology',{sequence:1,hash:b},4100);
  f=observeNasRecovery(f,true,4200);f=observeNasRecovery(f,false,4300);
  assert.equal(f.healthySince,null);assert.equal(automaticFailback(f,100000),f);
});
test('forced NAS stays in NAS mode on a failure; expired lease never permits writes',()=>{
  const s=ready();
  assert.equal(automaticFailover(s,{consecutiveFailures:50,online:true},100000),s);
  assert.equal(writable(s,proof(s),s.leaseUntil),false);
  const renewed=renewNasLease(s,proof(s),s.leaseUntil+1);
  assert.equal(writable(renewed,proof(s),s.leaseUntil+2),true);
});
test('wrong workspace, malformed checkpoints and replay of stale epochs fail closed',()=>{
  for(const patch of [{projectId:'production'},{workspaceId:'other'},{sequence:1},{epoch:0},{leaseUntil:NaN}])
    assert.throws(()=>validateFailoverState({...ready(),...patch}),/invalid-failover-state/);
  const s=ready();
  assert.throws(()=>publishCommit(s,proof(s),{sequence:2,hash:b},1001),/invalid-next-checkpoint/);
  assert.throws(()=>publishCommit(s,proof(s),{sequence:1,hash:'unverified'},1001),/invalid-next-checkpoint/);
  assert.throws(()=>prepareFailover(s,{adapters:{synology:true,firebase:true},checkpoint:{sequence:0,hash:a}},1001),/already-prepared/);
});
