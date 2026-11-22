import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
// Параллельное восстановление архива (решение владельца 23.11.2026): архивную
// смену можно восстановить для редактирования, не закрывая активную смену
// линии. Восстановленная смена существует параллельно: свои line_logs, свой
// shiftId, без line_truck_statuses (они принадлежат активной линии). Правки
// рейсов восстановленной смены идут через report.*, закрытие — через
// closeShift по её shiftId; активная линия не меняется ни на одном шаге.
const ws='arcpar_'+randomBytes(8).toString('hex');
process.env.WORKSPACE_ID=ws;
const {submitArchive}=await import('../src/archive-store.mjs');
const {readArchiveSnapshot}=await import('../src/archive-read.mjs');
const {readLineSnapshot}=await import('../src/line-read.mjs');
const {submitReport}=await import('../src/report-store.mjs');
const {closeShiftOperation}=await import('../src/shift-close.mjs');
const {submitControl}=await import('../src/control-store.mjs');

test('PostgreSQL archive restore runs in parallel with the live line',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),sha=randomBytes(32).toString('hex'),uid=ws+'_a';
  const archive={objectId:'site',objectName:'Site',date:'20.11.2026',activeLineIds:['truck'],ttnStatus:{truck:true},sourceShiftId:'shift_source_old',logs:[{id:'trip1',truckId:'truck',truckName:'Truck A',timestamp:20,volume:24,timeStr:'10:00'},{id:'trip2',truckId:'truck',truckName:'Truck A',timestamp:30,volume:12,timeStr:'11:00'}]};
  const send=(id,type,recordId,expectedRevision)=>submitArchive(pool,uid,{id,type,recordId,expectedRevision},ws);
  const liveShift={id:'shift_live',objectId:'site',objectName:'Site',startDate:'23.11.2026',startedAt:Date.now(),startedBy:'tester',isActive:true};
  let originalState;
  try{
    originalState=(await pool.query('SELECT initialized,owner_uid,import_sha256 FROM identity_state WHERE id=1')).rows[0];
    await pool.query('CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY,workspace_id text NOT NULL,source_project text NOT NULL,exported_at bigint NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),counts jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256),document_path text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(import_sha256,document_path))');
    await pool.query('INSERT INTO workspaces(id) VALUES ($1)',[ws]);
    await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'fixture@example.test',$1,'admin','active')",[uid]);
    await pool.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES ($1,$2,'samosval-offline',1000,'{}')",[sha,ws]);
    await pool.query('UPDATE identity_state SET initialized=true,import_sha256=$1 WHERE id=1',[sha]);
    await pool.query('INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES ($1,$2,$3)',[sha,`workspaces/${ws}/archive/restored1`,archive]);
    await pool.query('INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES ($1,$2,$3)',[ws,'site',{name:'Site'}]);
    await pool.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3)',[ws,'truck',{brand:'Fixture',number:'A111AA77',defaultVol:24}]);
    // Живая линия: активная смена, статус самосвала и один рейс.
    await pool.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',[ws,'shift_live',liveShift]);
    await pool.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4)',[ws,'truck','shift_live',{id:'truck',shiftId:'shift_live',onLine:true,arriveStatus:'На линии',cycleRevision:5,ttnRevision:2}]);
    await pool.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5)',[ws,'live_log_1','shift_live','truck',{id:'live_log_1',shiftId:'shift_live',truckId:'truck',volume:24,timestamp:Date.now(),timeStr:'09:00',comment:''}]);

    await t.test('restore succeeds while the live line stays active',async()=>{
      const receipt=await send('restore_par','archive.restore','restored1',1);
      assert.equal(receipt.outcome,'confirmed');
      assert.equal(receipt.result.location,'restored');
      assert.equal(receipt.result.shift.restored,true,'восстановленная смена помечена restored');
      // Активная линия не тронута: смена, статус и рейс на месте.
      const live=(await pool.query('SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[ws,'shift_live'])).rows[0];
      assert.equal(live.is_active,true);
      const liveStatus=(await pool.query('SELECT shift_id,payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',[ws,'truck'])).rows[0];
      assert.equal(liveStatus.shift_id,'shift_live');
      assert.equal(liveStatus.payload.cycleRevision,5);
      const liveLog=(await pool.query('SELECT payload FROM line_logs WHERE workspace_id=$1 AND log_id=$2',[ws,'live_log_1'])).rows[0];
      assert.equal(liveLog.payload.volume,24);
      // Восстановленная смена существует параллельно со своими рейсами и без статусов.
      const restored=(await pool.query('SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[ws,receipt.result.shift.id])).rows[0];
      assert.equal(restored.is_active,true);
      assert.equal(restored.payload.restored,true);
      assert.equal(restored.payload.originalSourceShiftId,'shift_source_old');
      const restoredLogs=(await pool.query('SELECT log_id,payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id',[ws,receipt.result.shift.id])).rows;
      assert.equal(restoredLogs.length,2);
      // Архив ушёл из списка (смена «в работе»).
      assert.equal((await readArchiveSnapshot(pool,uid,ws)).archives.length,0);
    });

    await t.test('a second parallel restore is rejected until the first is closed',async()=>{
      await pool.query('INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES ($1,$2,$3)',[sha,`workspaces/${ws}/archive/restored2`,{...archive,date:'21.11.2026'}]);
      await assert.rejects(send('restore_par2','archive.restore','restored2',1),{code:'restored-shift-in-progress'});
      await pool.query('DELETE FROM migration_documents WHERE import_sha256=$1 AND document_path=$2',[sha,`workspaces/${ws}/archive/restored2`]);
    });

    await t.test('line snapshot keeps the live shift and exposes the restored one separately',async()=>{
      const snapshot=await readLineSnapshot(pool,uid,ws);
      assert.equal(snapshot.shift.id,'shift_live','основной остаётся смена линии');
      assert.ok(Array.isArray(snapshot.restoredShifts)&&snapshot.restoredShifts.length===1);
      const restored=snapshot.restoredShifts[0];
      assert.equal(restored.shift.restored,true);
      assert.equal(restored.logs.length,2);
      assert.ok(restored.logs.every(l=>l.shiftId===restored.shift.id));
    });

    await t.test('line operations and membership stay locked to the live line',async()=>{
      const restoredShiftId=(await pool.query("SELECT shift_id FROM shifts WHERE workspace_id=$1 AND payload->>'restored'='true'",[ws])).rows[0].shift_id;
      await assert.rejects(submitControl(pool,uid,{id:'line_add_restored',type:'line.add',truckId:'truck',shiftId:restoredShiftId,expectedRevision:0,expectedTtnRevision:0},ws),{code:'restored-shift-readonly'});
      const liveStatus=(await pool.query('SELECT shift_id,payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',[ws,'truck'])).rows[0];
      assert.equal(liveStatus.shift_id,'shift_live','статус самосвала не перезаписан');
    });

    await t.test('editing a restored trip does not touch the live line',async()=>{
      const restoredShiftId=(await pool.query("SELECT shift_id FROM shifts WHERE workspace_id=$1 AND payload->>'restored'='true'",[ws])).rows[0].shift_id;
      const restoredLog=(await pool.query('SELECT payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id LIMIT 1',[ws,restoredShiftId])).rows[0].payload;
      const updated=await submitReport(pool,uid,{id:'report_edit_restored',type:'report.update',logId:restoredLog.id,expected:{volume:restoredLog.volume,timestamp:restoredLog.timestamp,timeStr:restoredLog.timeStr,comment:restoredLog.comment||'',truckId:restoredLog.truckId,shiftId:restoredLog.shiftId},data:{volume:20,timeStr:restoredLog.timeStr,comment:'правка архива'}},ws);
      assert.equal(updated.outcome,'confirmed');
      const after=(await pool.query('SELECT payload FROM line_logs WHERE workspace_id=$1 AND log_id=$2',[ws,restoredLog.id])).rows[0].payload;
      assert.equal(after.volume,20);
      // Активная линия неизменна: рейс и статус.
      assert.equal((await pool.query('SELECT payload FROM line_logs WHERE workspace_id=$1 AND log_id=$2',[ws,'live_log_1'])).rows[0].payload.volume,24);
      const liveStatus=(await pool.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',[ws,'truck'])).rows[0];
      assert.equal(liveStatus.payload.cycleRevision,5,'правка архива не меняет ревизии активной линии');
    });

    await t.test('closing the restored shift archives it and keeps the live line intact',async()=>{
      const restoredShiftId=(await pool.query("SELECT shift_id FROM shifts WHERE workspace_id=$1 AND payload->>'restored'='true'",[ws])).rows[0].shift_id;
      // Материал уже переносился при исходном закрытии: для восстановленной
      // смены подтверждение переноса не требуется.
      const prepared=await closeShiftOperation(pool,uid,{id:'close_par_prepare',type:'prepare',shiftId:restoredShiftId});
      assert.equal(prepared.phase,'awaiting-material');
      const finished=await closeShiftOperation(pool,uid,{id:'close_par_finish',type:'finish',shiftId:restoredShiftId});
      assert.equal(finished.phase,'closed');
      assert.equal(finished.shift.closedAt>0,true);
      // Рейсы восстановленной смены ушли в архив, сама смена закрыта.
      assert.equal((await pool.query('SELECT count(*)::int n FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',[ws,restoredShiftId])).rows[0].n,0);
      assert.equal((await pool.query('SELECT is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[ws,restoredShiftId])).rows[0].is_active,false);
      // Активная линия продолжает работать без изменений.
      const live=(await pool.query('SELECT is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[ws,'shift_live'])).rows[0];
      assert.equal(live.is_active,true);
      assert.equal((await pool.query('SELECT payload FROM line_logs WHERE workspace_id=$1 AND log_id=$2',[ws,'live_log_1'])).rows[0].payload.volume,24);
      const liveStatus=(await pool.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',[ws,'truck'])).rows[0];
      assert.equal(liveStatus.payload.cycleRevision,5);
      // В архиве появился новый экземпляр смены (уже отредактированный).
      const snapshotArchive=await readArchiveSnapshot(pool,uid,ws);
      assert.equal(snapshotArchive.archives.length,1);
      assert.equal(snapshotArchive.archives[0].logs.some(l=>l.volume===20),true);
    });
  }finally{
    if(originalState)await pool.query('UPDATE identity_state SET initialized=$1,owner_uid=$2,import_sha256=$3 WHERE id=1',[originalState.initialized,originalState.owner_uid,originalState.import_sha256]);
    for(const table of ['workspace_service_audit','workspace_service_receipts','archive_overrides','shift_archives','game_records','line_logs','line_truck_statuses','line_trucks','workspace_objects','shift_operation_receipts','control_operation_receipts','control_audit','line_operation_receipts','line_audit','shifts'])await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[ws]);
    await pool.query('DELETE FROM migration_documents WHERE import_sha256=$1',[sha]);await pool.query('DELETE FROM migration_imports WHERE sha256=$1',[sha]);
    await pool.query('DELETE FROM workspaces WHERE id=$1',[ws]);await pool.query('DELETE FROM app_users WHERE uid=$1',[uid]);await pool.end();
  }
});
