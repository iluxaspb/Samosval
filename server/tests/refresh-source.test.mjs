import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {prepareRefresh,snapshotHash} from '../scripts/prepare-test-refresh.mjs';
function fixture(){
 const data=Object.fromEntries(['trucks','objects','archive','trash','logs','truckStatus','notifications','audit','plugins','patches','coinTransactions','tabelNextRecords','tabelNextMeta','users','registrationRequests','permissions','appConfig','shift'].map(k=>[k,[]]));
 data.shift=[{id:'current',data:{id:'fixture',isActive:true}}];data.permissions=[{id:'permissions',data:{}}];const uid=randomUUID();data.users=[{id:uid,data:{role:'admin',status:'active',email:'fixture@example.test'}}];
 data.tabelNextRecords=[{id:'_catalog~config',data:{key:'_catalog/config',objectId:'_catalog',recordId:'_catalog~config',revision:1,data:{name:'Original',cells:{A1:'=SUM(1,2)'}}}}];
 const before={format:'samosval-test-migration',version:1,firebaseProjectId:'samosval-offline',workspaceId:'main_workspace',exportedAt:1,exportedBy:uid,data};const after=structuredClone(before);after.exportedAt=2;after.data.tabelNextRecords[0].data.revision=2;after.data.tabelNextRecords[0].data.data.name='Updated';after.data.tabelNextRecords.push({id:'site~sheet~new',data:{key:'site/sheet:new',objectId:'site',recordId:'site~sheet~new',revision:1,data:{cells:{B2:0},colors:{B2:'#ff0000'}}}});return {before,after};
}
test('refresh accepts only inspected table/notification changes and keeps the original import hash convention',()=>{
 const {before,after}=fixture(),result=prepareRefresh(before,after);assert.equal(result.oldSha,snapshotHash(before));assert.deepEqual(result.changes.tabelNextRecords,{added:1,changed:1});
 const bad=structuredClone(after);bad.data.users[0].data.nickname='Changed';assert.throws(()=>prepareRefresh(before,bad),/reviewed-domain:users/);
 const removed=structuredClone(after);removed.data.tabelNextRecords=[];assert.throws(()=>prepareRefresh(before,removed),/reviewed-domain/);
 const broken=structuredClone(after);broken.data.tabelNextRecords[0].data.recordId='other';assert.throws(()=>prepareRefresh(before,broken),/invalid-tabel-refresh/);
});
test('PostgreSQL source refresh checks the complete NAS baseline and commits fresh rows atomically',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:2}),{before,after}=fixture(),r=prepareRefresh(before,after);let state;
 const execute=async()=>{const c=await pool.connect();try{await c.query(r.sql.replace(/^\\set[^\n]*\n/,''));}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 try{
  assert.equal((await pool.query("SELECT count(*)::int n FROM tabel_records WHERE workspace_id='main_workspace'")).rows[0].n,0,'isolated TEST database required');
  state=(await pool.query('SELECT initialized,owner_uid,import_sha256 FROM identity_state WHERE id=1')).rows[0];
  await pool.query('UPDATE identity_state SET initialized=true,import_sha256=$1 WHERE id=1',[r.oldSha]);
  await pool.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES ($1,'main_workspace','samosval-offline',1,'{}')",[r.oldSha]);
  await pool.query("INSERT INTO tabel_policy(workspace_id,enabled,import_sha256) VALUES ('main_workspace',true,$1)",[r.oldSha]);
  const p=before.data.tabelNextRecords[0].data;await pool.query("INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload,baseline_payload) VALUES ('main_workspace',$1,$2,$3,$4,$4)",[p.recordId,p.objectId,p.key,p]);
  await t.test('an independently changed NAS value refuses the refresh without installing source metadata',async()=>{
   await pool.query("UPDATE tabel_records SET payload=payload||'{\"concurrent\":true}' WHERE workspace_id='main_workspace'");await assert.rejects(execute(),/differs from inspected baseline/);assert.equal((await pool.query('SELECT count(*)::int n FROM migration_imports WHERE sha256=$1',[r.sha256])).rows[0].n,0);
   await pool.query("UPDATE tabel_records SET payload=baseline_payload WHERE workspace_id='main_workspace'");
  });
  await t.test('fresh formula, zero, formatting and revision commit together; the original source survives',async()=>{
   await execute();const rows=(await pool.query("SELECT record_id,payload,baseline_payload FROM tabel_records WHERE workspace_id='main_workspace' ORDER BY record_id")).rows;
   assert.equal(rows.length,2);for(const row of rows){const expected=after.data.tabelNextRecords.find(x=>x.id===row.record_id).data;assert.deepEqual(row.payload,expected);assert.deepEqual(row.baseline_payload,expected);}
   assert.equal((await pool.query('SELECT import_sha256 FROM identity_state WHERE id=1')).rows[0].import_sha256,r.sha256);assert.equal((await pool.query('SELECT count(*)::int n FROM migration_imports WHERE sha256=ANY($1)',[[r.oldSha,r.sha256]])).rows[0].n,2);
  });
  await t.test('a repeated refresh refuses to overwrite the now-current version',async()=>{await assert.rejects(execute(),/refresh target changed/);assert.equal((await pool.query("SELECT count(*)::int n FROM tabel_records WHERE workspace_id='main_workspace'")).rows[0].n,2);});
 }finally{
  if(state)await pool.query('UPDATE identity_state SET initialized=$1,owner_uid=$2,import_sha256=$3 WHERE id=1',[state.initialized,state.owner_uid,state.import_sha256]);
  await pool.query("DELETE FROM tabel_records WHERE workspace_id='main_workspace'");await pool.query("DELETE FROM tabel_policy WHERE workspace_id='main_workspace'");await pool.query('DELETE FROM migration_documents WHERE import_sha256=ANY($1)',[[r.oldSha,r.sha256]]);await pool.query('DELETE FROM migration_imports WHERE sha256=ANY($1)',[[r.oldSha,r.sha256]]);await pool.end();
 }
});
