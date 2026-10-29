import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMigrationSnapshot, stableSnapshot } from '../../test-app/synology/migration-snapshot.mjs';
function fixture(){
  const data=Object.fromEntries(['trucks','objects','archive','trash','logs','truckStatus','notifications','audit','plugins','patches','coinTransactions','tabelNextRecords','tabelNextMeta','users','registrationRequests','permissions','appConfig','appConfig_test','shift'].map(name=>[name,[]]));
  data.shift=[{id:'current',data:{id:'shift_test',isActive:true}}];
  data.permissions=[{id:'permissions',data:{}}];
  data.users=[{id:'admin',data:{role:'admin',status:'active'}}];
  data.trucks=[{id:'truck',data:{volume:24}}];
  data.truckStatus=[{id:'truck',data:{shiftId:'shift_test'}}];
  return {format:'samosval-test-migration',version:1,firebaseProjectId:'samosval-offline',workspaceId:'main_workspace',exportedBy:'admin',data};
}
test('migration refuses an old backup missing the current shift and permissions',()=>{
  const value=fixture();value.data.shift=[];value.data.permissions=[];
  assert.throws(()=>validateMigrationSnapshot(value),/смена/);
});
test('migration validates required sections and account before returning record counts',()=>{
  const value=fixture();const counts=validateMigrationSnapshot(value);
  assert.equal(counts.shift,1);assert.equal(counts.users,1);assert.equal(counts.trucks,1);
  delete value.data.tabelNextRecords;assert.throws(()=>validateMigrationSnapshot(value),/tabelNextRecords/);
});
test('migration refuses the wrong project, duplicate IDs, disabled exporter, and orphaned statuses',()=>{
  const wrong=fixture();wrong.firebaseProjectId='other';assert.throws(()=>validateMigrationSnapshot(wrong),/источник/);
  const duplicate=fixture();duplicate.data.trucks.push(duplicate.data.trucks[0]);assert.throws(()=>validateMigrationSnapshot(duplicate),/повтор ID/);
  const disabled=fixture();disabled.data.users[0].data.status='disabled';assert.throws(()=>validateMigrationSnapshot(disabled),/администратора/);
  const orphan=fixture();orphan.data.truckStatus[0].id='missing';assert.throws(()=>validateMigrationSnapshot(orphan),/отсутствующую машину/);
});
test('snapshot comparison ignores field order but detects changed revisions',()=>{
  assert.equal(stableSnapshot({id:'x',data:{a:1,b:2}}),stableSnapshot({data:{b:2,a:1},id:'x'}));
  assert.notEqual(stableSnapshot({revision:1}),stableSnapshot({revision:2}));
});
