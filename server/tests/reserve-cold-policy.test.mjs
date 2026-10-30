import test from 'node:test';
import assert from 'node:assert/strict';
import {RESERVE_TABLES,encodeReserveCheckpoint} from '../src/reserve-checkpoint.mjs';
import {COLD_BACKUP_PERIODS,planColdBackup,runColdBackupCycle} from '../src/reserve-cold-policy.mjs';

function snapshot(trip='trip-1'){
  const tables=Object.fromEntries(RESERVE_TABLES.map(name=>[name,[]]));
  const schema=Object.fromEntries(RESERVE_TABLES.map(name=>[name,[{column_name:'id',data_type:'text'}]]));
  tables.workspaces=[{id:'main_workspace'}];
  tables.line_logs=[{id:trip}];
  tables.line_operation_receipts=[{id:'receipt-1'}];
  return {format:'samosval-native-reserve',version:1,projectId:'samosval-offline',workspaceId:'main_workspace',schema,tables};
}
const hash=s=>encodeReserveCheckpoint(s).manifest.hash;
function harness(versions=[snapshot(),snapshot()]){
  let captures=0,uploads=0,reads=0,stored=new Set(),allowRead=true;
  const capture=async()=>structuredClone(versions[Math.min(captures++,versions.length-1)]);
  const store={
    put:async s=>{uploads++;stored.add(hash(s));return {hash:hash(s)};},
    verify:async cp=>{reads++;return allowRead&&stored.has(cp.hash);}
  };
  return {capture,store,counters:()=>({captures,uploads,reads}),corrupt:()=>{allowRead=false;}};
}
test('cold backup cadence is 12h by default or explicitly 24h, no NAS reads before due',async()=>{
  const first=planColdBackup({now:10_000});
  assert.equal(first.due,true);
  assert.equal(COLD_BACKUP_PERIODS.twiceDaily,12*60*60*1000);
  assert.equal(COLD_BACKUP_PERIODS.daily,24*60*60*1000);
  for(const cadence of ['twiceDaily','daily']){
    const period=COLD_BACKUP_PERIODS[cadence],previous={hash:'a'.repeat(64),verifiedAt:10_000};
    assert.equal(planColdBackup({now:10_000+period-1,previous,cadence}).due,false);
    assert.equal(planColdBackup({now:10_000+period,previous,cadence}).due,true);
    const h=harness();
    assert.equal((await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now:10_001,previous,cadence})).status,'not-due');
    assert.deepEqual(h.counters(),{captures:0,uploads:0,reads:0});
  }
});
test('first cold snapshot uploads and confirms two NAS captures but grants no failover',async()=>{
  const h=harness();
  const result=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now:10_000});
  assert.equal(result.status,'archived');
  assert.deepEqual(result.receipt,{hash:hash(snapshot()),verifiedAt:10_000});
  assert.equal(result.failoverEnabled,false);
  assert.equal(result.liveReplicaVerified,false);
  assert.deepEqual(h.counters(),{captures:2,uploads:1,reads:1});
});
test('unchanged 12h snapshot avoids new Firebase writes and confirms the stored archive',async()=>{
  const h=harness(),now=10_000;
  const first=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now});
  const second=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    previous:first.receipt,now:now+COLD_BACKUP_PERIODS.twiceDaily});
  assert.equal(second.status,'unchanged');
  assert.equal(second.receipt.hash,first.receipt.hash);
  assert.deepEqual(h.counters(),{captures:4,uploads:1,reads:2});
});
test('a changed trip at the 12h boundary creates a new immutable archive',async()=>{
  const one=snapshot(),two=snapshot('trip-2');
  const h=harness([one,one,two,two]),now=10_000;
  const first=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now});
  const second=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    previous:first.receipt,now:now+COLD_BACKUP_PERIODS.twiceDaily});
  assert.equal(second.status,'archived');
  assert.notEqual(first.receipt.hash,second.receipt.hash);
  assert.deepEqual(h.counters(),{captures:4,uploads:2,reads:2});
});
test('NAS changes while copying mean no successful receipt, even with equal row counts',async()=>{
  const h=harness([snapshot(),snapshot('trip-2')]);
  await assert.rejects(runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now:10_000}),
    /cold-backup-source-changed/);
});
test('lost or corrupt Firestore checkpoint prevents fresh verification',async()=>{
  const h=harness(),now=10_000;
  const first=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now});
  h.corrupt();
  await assert.rejects(runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    previous:first.receipt,now:now+COLD_BACKUP_PERIODS.twiceDaily}),/cold-backup-readback-not-verified/);
});
test('untrusted clock, cadence, or receipt cannot be used to bypass the schedule',()=>{
  for(const args of [
    {now:-1},{now:NaN},{now:10_000,cadence:'everySecond'},
    {now:10_000,previous:{hash:'bad',verifiedAt:1}},
    {now:10_000,previous:{hash:'a'.repeat(64),verifiedAt:20_000}},
  ])assert.throws(()=>planColdBackup(args),/invalid-cold-backup/);
});
