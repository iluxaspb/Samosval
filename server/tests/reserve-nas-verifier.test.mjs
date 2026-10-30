import test from 'node:test';
import assert from 'node:assert/strict';
import {RESERVE_TABLES,encodeReserveCheckpoint} from '../src/reserve-checkpoint.mjs';
import {createNasReplicaVerifier} from '../src/reserve-nas-verifier.mjs';

function snapshot(){
  const tables=Object.fromEntries(RESERVE_TABLES.map(name=>[name,[]]));
  const schema=Object.fromEntries(RESERVE_TABLES.map(name=>[name,[{column_name:'id',data_type:'text'}]]));
  tables.workspaces=[{id:'main_workspace'}];
  tables.line_logs=[{id:'confirmed-trip'}];
  tables.line_operation_receipts=[{id:'receipt-for-trip'}];
  return {format:'samosval-native-reserve',version:1,projectId:'samosval-offline',workspaceId:'main_workspace',tables,schema};
}
const pool={connect(){}};
const head=state=>({sequence:1,hash:encodeReserveCheckpoint(state).manifest.hash});

test('NAS verification reads actual dataset, not just archive existence or server health',async()=>{
  let current=snapshot(),captures=0;
  const verify=createNasReplicaVerifier({pool,capture:async()=>{captures++;return structuredClone(current);}});
  const checkpoint=head(current);
  assert.equal(await verify('synology',checkpoint),true);
  assert.equal(await verify('firebase',checkpoint),false,'Firebase requires its own physical backend verifier');
  assert.equal(captures,1,'unsupported providers do not query PostgreSQL');
  current.tables.line_operation_receipts.push({id:'another-receipt'});
  assert.equal(await verify('synology',checkpoint),false);
  current=snapshot();current.tables.line_logs.length=0;
  assert.equal(await verify('synology',checkpoint),false);
});
test('wrong hash, source errors, invalid schema and oversize snapshots all deny authority',async()=>{
  const original=snapshot(),checkpoint=head(original);
  const bad=createNasReplicaVerifier({pool,capture:async()=>{throw Error('database-offline');}});
  assert.equal(await bad('synology',checkpoint),false);
  assert.equal(await bad('synology',{sequence:0,hash:'invalid'}),false);
  const unknown=createNasReplicaVerifier({pool,capture:async()=>({...original,tables:{...original.tables,unknown:[]}})});
  assert.equal(await unknown('synology',checkpoint),false);
  const limited=createNasReplicaVerifier({pool,maxBytes:10,capture:async()=>original});
  assert.equal(await limited('synology',checkpoint),false);
  assert.throws(()=>createNasReplicaVerifier({}),/invalid-nas-replica-verifier/);
});
