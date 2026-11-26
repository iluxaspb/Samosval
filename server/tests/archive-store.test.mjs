import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {submitArchive} from '../src/archive-store.mjs';
import {readArchiveSnapshot} from '../src/archive-read.mjs';
import {submitRestoredCorrection} from '../src/restored-context-store.mjs';
import {finalizeRestoredContext} from '../src/archive-revisions.mjs';
test('PostgreSQL archive mutations keep original snapshots, serialize concurrent editors, and restore the complete line atomically',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),sha=randomBytes(32).toString('hex'),ws='arc_'+sha.slice(0,20),uid=ws+'_a',worker=ws+'_w';let originalState;
  const archive={objectId:'site',objectName:'Site',date:'30.10.2026',activeLineIds:['truck','empty'],ttnStatus:{truck:'pending'},paper:{width:900},logs:[{id:'late',truckId:'truck',timestamp:20,volume:24,comment:'late'},{id:'early',truckId:'truck',timestamp:10,volume:24,comment:'early'}]};
  const send=(id,type,recordId,expectedRevision,user=uid)=>submitArchive(pool,user,{id,type,recordId,expectedRevision},ws);
  try{
    originalState=(await pool.query('SELECT initialized,owner_uid,import_sha256 FROM identity_state WHERE id=1')).rows[0];
    await pool.query('CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY,workspace_id text NOT NULL,source_project text NOT NULL,exported_at bigint NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),counts jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256),document_path text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(import_sha256,document_path))');
    await pool.query('INSERT INTO workspaces(id) VALUES ($1)',[ws]);
    for(const [id,role] of [[uid,'admin'],[worker,'viewer']])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'fixture@example.test',$1,$2,'active')",[id,role]);
    await pool.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES ($1,$2,'samosval-offline',1000,'{}')",[sha,ws]);
    await pool.query('UPDATE identity_state SET initialized=true,import_sha256=$1 WHERE id=1',[sha]);
    for(const id of ['legacy','restore'])await pool.query('INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES ($1,$2,$3)',[sha,`workspaces/${ws}/archive/${id}`,archive]);
    await pool.query('INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES ($1,$2,$3)',[ws,'site',{name:'Site'}]);
    for(const id of ['truck','empty'])await pool.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3)',[ws,id,{brand:'Fixture',number:id,defaultVol:24}]);
    await t.test('unauthorized archive actions are denied before touching import',async()=>{
      await assert.rejects(send('forged','archive.trash','legacy',1,worker),{code:'forbidden'});
    });
    await t.test('parallel trash actions create one trash record; identical receipt replays',async()=>{
      const results=await Promise.allSettled([send('trash_a','archive.trash','legacy',1),send('trash_b','archive.trash','legacy',1)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'archive-changed');
      const result=results.find(r=>r.status==='fulfilled').value;assert.equal((await send(result.operationId,'archive.trash','legacy',1)).replayed,true);
      const snapshot=await readArchiveSnapshot(pool,uid,ws);assert.equal(snapshot.trash.length,1);assert.deepEqual(snapshot.trash[0].shift.paper,archive.paper);assert.equal(snapshot.archives.length,1);
    });
    await t.test('purge removes only the trash view while retaining the original source and audit',async()=>{
      await send('purge','trash.purge','legacy',2);assert.equal((await readArchiveSnapshot(pool,uid,ws)).trash.length,0);
      assert.deepEqual((await pool.query('SELECT payload FROM migration_documents WHERE import_sha256=$1 ORDER BY document_path',[sha])).rows[0].payload,archive);
    });
    await t.test('an active line no longer blocks restoration: the archive returns as a parallel restored shift',async()=>{
      await pool.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',[ws,'live',{id:'live',isActive:true}]);
      const receipt=await send('restore_live','archive.restore','restore',1);
      assert.equal(receipt.outcome,'confirmed');
      assert.equal(receipt.result.shift.restored,true);
      // Активная линия не тронута, restored-смена существует параллельно без статусов.
      assert.equal((await pool.query('SELECT is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[ws,'live'])).rows[0].is_active,true);
      assert.equal((await pool.query('SELECT count(*)::int n FROM line_truck_statuses WHERE workspace_id=$1',[ws])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',[ws,receipt.result.shift.id])).rows[0].n,2);
      await pool.query('DELETE FROM line_logs WHERE workspace_id=$1',[ws]);
      await pool.query('DELETE FROM shifts WHERE workspace_id=$1',[ws]);
      // Возвращаем архив в исходное состояние: запись в migration_documents
      // остаётся, «восстановление» отменяется удалением override-записи.
      await pool.query("DELETE FROM archive_overrides WHERE workspace_id=$1 AND record_id='restore'",[ws]);
    });
    await t.test('restore commits a complete line once; retry keeps IDs, times, TTN and comments',async()=>{
      const a=await send('restore_once','archive.restore','restore',1),b=await send('restore_once','archive.restore','restore',1);assert.equal(b.replayed,true);assert.deepEqual(a.result,b.result);
      const logs=(await pool.query('SELECT payload FROM line_logs WHERE workspace_id=$1 ORDER BY log_id',[ws])).rows.map(r=>r.payload);assert.deepEqual(logs.map(l=>l.timestamp),[20,10]);assert.deepEqual(logs.map(l=>l.comment),['late','early']);
      assert.equal((await pool.query('SELECT count(*)::int n FROM line_truck_statuses WHERE workspace_id=$1',[ws])).rows[0].n,2);
      const st=(await pool.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',[ws,'truck'])).rows[0].payload;assert.equal(st.lastLoadTimestamp,20);assert.equal(st.ttnStatus,'pending');assert.equal(st.lastLoadLogId,logs[0].id);
      assert.equal((await readArchiveSnapshot(pool,uid,ws)).archives.length,0);
    });
  }finally{
    if(originalState)await pool.query('UPDATE identity_state SET initialized=$1,owner_uid=$2,import_sha256=$3 WHERE id=1',[originalState.initialized,originalState.owner_uid,originalState.import_sha256]);
    for(const table of ['workspace_service_audit','workspace_service_receipts','archive_overrides','line_logs','line_truck_statuses','line_trucks','workspace_objects','shifts'])await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[ws]);
    await pool.query('DELETE FROM migration_documents WHERE import_sha256=$1',[sha]);await pool.query('DELETE FROM migration_imports WHERE sha256=$1',[sha]);
    await pool.query('DELETE FROM workspaces WHERE id=$1',[ws]);await pool.query('DELETE FROM app_users WHERE uid=ANY($1)',[[uid,worker]]);await pool.end();
  }
});
// Гейт архивных коррекций: разрешены ровно trip/TTN update/delete. Любой другой
// type отбивается до обращения к БД, поэтому пул здесь намеренно недоступен.
test('restored correction domain refuses every non trip/TTN operation before touching the database',async()=>{
  let connects=0;
  const pool={connect(){connects+=1;throw new Error('the database must not be touched');}};
  for(const type of ['shift.close','trip.create','report.update','archive.restore','',null,undefined,42]){
    await assert.rejects(submitRestoredCorrection(pool,{uid:'gate_user'},'ctx_gate',{operationId:'op_gate',protocolVersion:2,type,recordId:'rec_1',expectedContextRevision:1,expectedBaseArchiveRevision:1,expectedBaseSha256:'a'.repeat(64)}),error=>{
      assert.equal(error.code,'archive-operation-not-allowed');assert.equal(error.status,400);return true;
    });
  }
  assert.equal(connects,0);
});
// Гейт finalize: сессия и команда проверяются до соединения с БД, поэтому
// некорректный запрос не может оставить ни ревизии, ни receipt.
test('restored finalize refuses an invalid session or command before touching the database',async()=>{
  let connects=0;
  const pool={connect(){connects+=1;throw new Error('the database must not be touched');}};
  const valid={operationId:'op_fin',protocolVersion:2,expectedContextRevision:1,expectedBaseArchiveRevision:1,expectedBaseSha256:'a'.repeat(64)};
  await assert.rejects(finalizeRestoredContext(pool,{uid:''},'ctx_fin',valid),{code:'forbidden',status:403});
  await assert.rejects(finalizeRestoredContext(pool,{},'ctx_fin',valid),{code:'forbidden',status:403});
  await assert.rejects(finalizeRestoredContext(pool,{uid:'gate_user'},'bad ctx',valid),{code:'invalid-restored-context'});
  for(const bad of [
    {...valid,operationId:'bad id'},
    {...valid,protocolVersion:1},
    {...valid,expectedContextRevision:0},
    {...valid,expectedContextRevision:1.5},
    {...valid,expectedBaseArchiveRevision:null},
    {...valid,expectedBaseSha256:'A'.repeat(64)},
    {...valid,expectedBaseSha256:undefined},
    null,
  ])await assert.rejects(finalizeRestoredContext(pool,{uid:'gate_user'},'ctx_fin',bad),{code:'invalid-archive-operation'});
  assert.equal(connects,0);
});
