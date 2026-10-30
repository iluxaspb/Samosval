import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {closeShiftOperation} from '../src/shift-close.mjs';
import {submitLineOperation} from '../src/line-store.mjs';
import {commitTabel} from '../src/tabel-store.mjs';
test('PostgreSQL shift close freezes loads, preserves source until material confirmation and retries safely',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});
  const prefix='close_'+randomUUID().replaceAll('-',''),uid=prefix+'_admin',shiftId=prefix+'_shift',truck=prefix+'_truck',objectId=prefix+'_site';
  const startedAt=Date.parse('2026-10-30T08:00:00+03:00'),arrival=Date.now()-60000;
  const operation=type=>({id:prefix+'_'+type,type,shiftId});
  let policyCreated=false;
  try {
    await pool.query("INSERT INTO workspaces(id) VALUES ('main_workspace') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'fixture@example.test','Fixture','admin','active')",[uid]);
    await pool.query("INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ('main_workspace',$1,true,$2)",[shiftId,{id:shiftId,objectId,objectName:'Fixture',startDate:'30.10.2026',startedAt}]);
    await pool.query("INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ('main_workspace',$1,$2)",[truck,{number:'TEST',defaultVol:24}]);
    await pool.query("INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ('main_workspace',$1,$2,$3)",[truck,shiftId,{id:truck,shiftId,onLine:true,cycleRevision:1,arriveStatus:'10:00',arriveTimestamp:arrival,lastLoadTimestamp:null}]);
    await pool.query("INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ('main_workspace',$1,$2,$3,$4)",[prefix+'_log',shiftId,truck,{shiftId,truckId:truck,timestamp:arrival-1000,volume:24}]);
    await t.test('freeze and archive commit together; prepare retry is idempotent',async()=>{
      const prepared=await closeShiftOperation(pool,uid,operation('prepare'));
      assert.equal(prepared.phase,'awaiting-material');assert.equal(prepared.archive.totalVolume,24);
      assert.equal(prepared.shift.isActive,false);assert.equal(prepared.shift.closing,true);
      assert.equal((await closeShiftOperation(pool,uid,operation('prepare'))).replayed,true);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM line_logs WHERE shift_id=$1',[shiftId])).rows[0].n,1);
      const load=await submitLineOperation(pool,uid,{id:prefix+'_load',type:'load',truckId:truck,shiftId,createdAt:Date.now(),expectedRevision:1,expectedTtnRevision:0,arrivalTimestamp:arrival,lastLoadTimestamp:0,wantArrived:false,collect:false,cycleMinutes:15});
      assert.equal(load.outcome,'rejected');assert.equal(load.reason,'shift-changed');
    });
    await t.test('unconfirmed material never clears trips or statuses',async()=>{
      await assert.rejects(closeShiftOperation(pool,uid,operation('finish')),{code:'tabel-not-ready'});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM line_logs WHERE shift_id=$1',[shiftId])).rows[0].n,1);
      policyCreated=!!(await pool.query("INSERT INTO tabel_policy(workspace_id,enabled,import_sha256) VALUES ('main_workspace',true,'close_ci') ON CONFLICT DO NOTHING RETURNING workspace_id")).rowCount;
      await assert.rejects(closeShiftOperation(pool,uid,operation('finish')),{code:'material-not-confirmed'});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id=$1',[shiftId])).rows[0].n,1);
    });
    await t.test('confirmed material permits cleanup; archive and replay receipts remain',async()=>{
      await commitTabel(pool,uid,{id:prefix+'_material',key:objectId+'/day:2026-10-30:day',before:{revision:0,data:null},data:{lineImports:{[shiftId]:{volume:24,materialId:'material'}}}});
      const finished=await closeShiftOperation(pool,uid,operation('finish'));
      assert.equal(finished.phase,'closed');assert.equal(finished.shift.closing,false);
      assert.equal((await closeShiftOperation(pool,uid,operation('finish'))).replayed,true);
      for(const table of ['line_logs','line_truck_statuses'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE shift_id=$1`,[shiftId])).rows[0].n,0);
      assert.equal((await pool.query('SELECT payload FROM shift_archives WHERE shift_id=$1',[shiftId])).rows[0].payload.totalTrips,1);
      await assert.rejects(closeShiftOperation(pool,uid,{...operation('finish'),type:'prepare'}),{code:'operation-id-reused'});
    });
  }finally{
    for(const table of ['shift_archives','line_logs','line_truck_statuses','shifts'])await pool.query(`DELETE FROM ${table} WHERE shift_id=$1`,[shiftId]);
    await pool.query('DELETE FROM line_trucks WHERE truck_id=$1',[truck]);
    await pool.query('DELETE FROM line_operation_receipts WHERE uid=$1',[uid]);
    await pool.query('DELETE FROM shift_operation_receipts WHERE uid=$1',[uid]);
    await pool.query('DELETE FROM tabel_receipts WHERE object_id=$1',[objectId]);
    await pool.query('DELETE FROM tabel_records WHERE object_id=$1',[objectId]);
    await pool.query('DELETE FROM app_users WHERE uid=$1',[uid]);
    if(policyCreated)await pool.query("DELETE FROM tabel_policy WHERE workspace_id='main_workspace' AND import_sha256='close_ci'");
    await pool.end();
  }
});
