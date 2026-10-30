import test from 'node:test';
import assert from 'node:assert/strict';
import {RESERVE_TABLES,encodeReserveCheckpoint} from '../src/reserve-checkpoint.mjs';
import {COLD_BACKUP_ZONE,COLD_BACKUP_HOUR,planColdBackup,runColdBackupCycle} from '../src/reserve-cold-policy.mjs';

function snapshot(trip='trip-1'){
  const tables=Object.fromEntries(RESERVE_TABLES.map(name=>[name,[]]));
  const schema=Object.fromEntries(RESERVE_TABLES.map(name=>[name,[{column_name:'id',data_type:'text'}]]));
  tables.workspaces=[{id:'main_workspace'}];
  tables.line_logs=[{id:trip}];
  tables.line_operation_receipts=[{id:'receipt-1'}];
  return {format:'samosval-native-reserve',version:1,projectId:'samosval-offline',workspaceId:'main_workspace',schema,tables};
}
const hash=s=>encodeReserveCheckpoint(s).manifest.hash;
const at=s=>Date.parse(s);
function harness(versions=[snapshot(),snapshot()]){
  let captures=0,uploads=0,reads=0,stored=new Set(),allowRead=true;
  const capture=async()=>structuredClone(versions[Math.min(captures++,versions.length-1)]);
  const store={
    put:async s=>{uploads++;stored.add(hash(s));return {hash:hash(s)};},
    verify:async cp=>{reads++;return allowRead&&stored.has(cp.hash);}
  };
  return {capture,store,counters:()=>({captures,uploads,reads}),corrupt:()=>{allowRead=false;}};
}
test('daily archive is scheduled at 23:00 Pacific and does not repeat within a slot',async()=>{
  const before=at('2026-10-31T05:59:00Z'),due=at('2026-10-31T06:00:00Z');
  assert.equal(COLD_BACKUP_ZONE,'America/Los_Angeles');
  assert.equal(COLD_BACKUP_HOUR,23);
  assert.deepEqual({...planColdBackup({now:due}),due:true},
    {due:true,slotKey:'2026-10-30',scheduledAt:due,nextDueAt:at('2026-11-01T06:00:00Z'),
      timeZone:COLD_BACKUP_ZONE,hour:23});
  assert.equal(planColdBackup({now:before}).slotKey,'2026-10-29');
  const previous={hash:'a'.repeat(64),verifiedAt:due,slotKey:'2026-10-30'};
  assert.equal(planColdBackup({now:at('2026-11-01T05:59:00Z'),previous}).due,false);
  assert.equal(planColdBackup({now:at('2026-11-01T06:00:00Z'),previous}).due,true);
  const h=harness();
  assert.equal((await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    now:at('2026-11-01T05:59:00Z'),previous})).status,'not-due');
  assert.deepEqual(h.counters(),{captures:0,uploads:0,reads:0});
});
test('23:00 Pacific changes from 06:00 UTC to 07:00 UTC after daylight-saving ends',()=>{
  const onSummer=planColdBackup({now:at('2026-11-01T06:00:00Z')});
  const onWinter=planColdBackup({now:at('2026-11-02T07:00:00Z'),
    previous:{hash:'a'.repeat(64),verifiedAt:at('2026-11-01T06:00:00Z'),slotKey:'2026-10-31'}});
  assert.equal(onSummer.scheduledAt,at('2026-11-01T06:00:00Z'));
  assert.equal(onWinter.slotKey,'2026-11-01');
  assert.equal(onWinter.scheduledAt,at('2026-11-02T07:00:00Z'));
  assert.equal(onWinter.due,true);
});
test('first cold snapshot uploads and confirms two NAS captures but grants no failover',async()=>{
  const h=harness(),now=at('2026-10-31T06:00:00Z');
  const result=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now});
  assert.equal(result.status,'archived');
  assert.deepEqual(result.receipt,{hash:hash(snapshot()),verifiedAt:now,slotKey:'2026-10-30'});
  assert.equal(result.failoverEnabled,false);
  assert.equal(result.liveReplicaVerified,false);
  assert.deepEqual(h.counters(),{captures:2,uploads:1,reads:1});
});
test('unchanged next-day snapshot avoids new Firebase writes and verifies stored archive',async()=>{
  const h=harness(),now=at('2026-10-31T06:00:00Z');
  const first=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now});
  const second=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    previous:first.receipt,now:at('2026-11-01T06:00:00Z')});
  assert.equal(second.status,'unchanged');
  assert.equal(second.receipt.hash,first.receipt.hash);
  assert.deepEqual(h.counters(),{captures:4,uploads:1,reads:2});
});
test('changed trip at the next daily slot uploads a new immutable checkpoint (delta not yet wired)',async()=>{
  const one=snapshot(),two=snapshot('trip-2');
  const h=harness([one,one,two,two]);
  const first=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    now:at('2026-10-31T06:00:00Z')});
  const second=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    previous:first.receipt,now:at('2026-11-01T06:00:00Z')});
  assert.equal(second.status,'archived');
  assert.notEqual(first.receipt.hash,second.receipt.hash);
  assert.deepEqual(h.counters(),{captures:4,uploads:2,reads:2});
});
test('NAS changes while copying mean no successful receipt, even with equal row counts',async()=>{
  const h=harness([snapshot(),snapshot('trip-2')]);
  await assert.rejects(runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    now:at('2026-10-31T06:00:00Z')}),/cold-backup-source-changed/);
});
test('lost or corrupt Firestore checkpoint prevents fresh verification',async()=>{
  const h=harness(),now=at('2026-10-31T06:00:00Z');
  const first=await runColdBackupCycle({pool:{},store:h.store,capture:h.capture,now});
  h.corrupt();
  await assert.rejects(runColdBackupCycle({pool:{},store:h.store,capture:h.capture,
    previous:first.receipt,now:at('2026-11-01T06:00:00Z')}),/cold-backup-readback-not-verified/);
});
test('bad timestamp and invalid receipt cannot bypass the schedule',()=>{
  for(const args of [
    {now:-1},{now:NaN},
    {now:at('2026-10-31T06:00:00Z'),previous:{hash:'bad',verifiedAt:1,slotKey:'2026-10-29'}},
    {now:at('2026-10-31T06:00:00Z'),previous:{hash:'a'.repeat(64),verifiedAt:at('2026-11-02T06:00:00Z'),slotKey:'2026-10-29'}},
    {now:at('2026-10-31T06:00:00Z'),previous:{hash:'a'.repeat(64),verifiedAt:10,slotKey:'2026-11-02'}}
  ])assert.throws(()=>planColdBackup(args),/invalid-cold-backup/);
});
