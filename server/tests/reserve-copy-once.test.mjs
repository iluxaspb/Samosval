import test from 'node:test';
import assert from 'node:assert/strict';
import {RESERVE_TABLES,encodeReserveCheckpoint} from '../src/reserve-checkpoint.mjs';
import {copyReserveOnce} from '../scripts/reserve-copy-once.mjs';

function snapshot(){
  const tables=Object.fromEntries(RESERVE_TABLES.map(name=>[name,[]]));
  const schema=Object.fromEntries(RESERVE_TABLES.map(name=>[name,[{column_name:'id',data_type:'text'}]]));
  tables.workspaces=[{id:'main_workspace'}];
  tables.line_logs=[{id:'trip-1'}];
  tables.line_operation_receipts=[{id:'receipt-1'}];
  return {format:'samosval-native-reserve',version:1,projectId:'samosval-offline',workspaceId:'main_workspace',schema,tables};
}
const checkpointFor=state=>({hash:encodeReserveCheckpoint(state).manifest.hash,sequence:0});
function harness({versions=[snapshot(),snapshot()],verified=true,returnedHash=null}={}){
  let captures=0,uploaded=0,checks=0;
  const store={
    async put(data){
      uploaded++;
      assert.deepEqual(data,versions[0]);
      return {...checkpointFor(data),...(returnedHash?{hash:returnedHash}:{})};
    },
    async verify(){checks++;return verified;},
  };
  const capture=async()=>{
    const version=versions[Math.min(captures,versions.length-1)];
    captures++;
    return structuredClone(version);
  };
  return {store,capture,stats:()=>({captures,uploaded,checks})};
}
test('one-shot reserve confirms immutable archive AND recaptures current NAS before reporting success',async()=>{
  const h=harness(),result=await copyReserveOnce({pool:{},store:h.store,capture:h.capture});
  assert.equal(result.status,'checkpoint-verified');
  assert.equal(result.sourceUnchangedAtVerification,true);
  assert.equal(result.failoverEnabled,false);
  assert.deepEqual(h.stats(),{captures:2,uploaded:1,checks:1});
});
test('changed trip with same row count during Firestore upload blocks fresh reserve acknowledgement',async()=>{
  const original=snapshot(),changed=structuredClone(original);
  changed.tables.line_logs[0].id='trip-2';
  const h=harness({versions:[original,changed]});
  await assert.rejects(copyReserveOnce({pool:{},store:h.store,capture:h.capture}),/reserve-source-changed-during-copy/);
  assert.deepEqual(h.stats(),{captures:2,uploaded:1,checks:1});
});
test('changed receipt with same row count also blocks reserve acknowledgement',async()=>{
  const original=snapshot(),changed=structuredClone(original);
  changed.tables.line_operation_receipts[0].id='receipt-2';
  const h=harness({versions:[original,changed]});
  await assert.rejects(copyReserveOnce({pool:{},store:h.store,capture:h.capture}),/reserve-source-changed-during-copy/);
});
test('wrong checkpoint hash or failed Firestore read-back blocks before NAS freshness test',async()=>{
  for(const options of [{returnedHash:'f'.repeat(64)},{verified:false}]){
    const h=harness(options);
    await assert.rejects(copyReserveOnce({pool:{},store:h.store,capture:h.capture}),/reserve-readback-not-verified/);
    assert.deepEqual(h.stats(),{captures:1,uploaded:1,checks:options.returnedHash?0:1});
  }
});
test('failure recapturing NAS after upload cannot be reported as verified',async()=>{
  const h=harness();let n=0;
  const capture=async()=>{if(++n===2)throw Error('NAS-unreachable');return h.capture();};
  await assert.rejects(copyReserveOnce({pool:{},store:h.store,capture}),/NAS-unreachable/);
});
