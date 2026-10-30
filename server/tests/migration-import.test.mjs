import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImport } from '../scripts/prepare-test-import.mjs';
function fixture(){
  const data=Object.fromEntries(['trucks','objects','archive','trash','logs','truckStatus','notifications','audit','plugins','patches','coinTransactions','tabelNextRecords','tabelNextMeta','users','registrationRequests','permissions','appConfig','shift'].map(name=>[name,[]]));
  data.shift=[{id:'current',data:{id:'shift_test',isActive:true}}];
  data.permissions=[{id:'permissions',data:{viewer:{tabs:['line'],actions:[]}}}];
  data.users=[{id:'admin',data:{email:'admin@example.test',role:'admin',status:'active',nickname:"x'); DROP TABLE app_users;--"}}];
  data.trucks=[{id:'truck',data:{volume:24}}];
  data.truckStatus=[{id:'truck',data:{shiftId:'shift_test'}}];
  data.logs=[{id:'log',data:{truckId:'truck',shiftId:'shift_test',timestamp:1}}];
  return {format:'samosval-test-migration',version:1,firebaseProjectId:'samosval-offline',workspaceId:'main_workspace',exportedBy:'admin',exportedAt:1793310000000,data};
}
test('initial import requires an explicit cycle and rejects cross-shift data',()=>{
  const payload=fixture();assert.throws(()=>prepareImport(payload),/cycle minutes/);
  payload.data.logs[0].data.shiftId='different';assert.throws(()=>prepareImport(payload,{cycleMinutes:60}),/unknown shift/);
});
test('initial import encodes document text and includes atomic empty-target guards',()=>{
  const result=prepareImport(fixture(),{cycleMinutes:60});
  assert.equal(result.counts.logs,1);assert.equal(result.cycleMinutes,60);
  assert.ok(!result.sql.includes('DROP TABLE'));
  assert.match(result.sql,/current_database\(\) <> 'samosval_test'/);
  assert.match(result.sql,/Target is not empty; refusing to overwrite/);
  assert.match(result.sql,/BEGIN;/);assert.match(result.sql,/COMMIT;/);
  assert.match(result.sql,/migration_documents/);
  assert.equal(result.sha256.length,64);
});
