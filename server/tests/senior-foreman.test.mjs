import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { submitLineOperation } from '../src/line-store.mjs';

// Миграция 020: роль senior_foreman получает копию фактических прав foreman
// (включая исторические строки allowed=false) плюс line_timer_reset.
// Пользователи foreman не перекрашиваются; foreman сброс не получает.
test('senior_foreman copies foreman permissions plus line_timer_reset', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  const id=randomUUID().replaceAll('-','');
  const uid='sf_user_'+id, shiftId='sf_shift_'+id, truckId='sf_truck_'+id;
  const arrival=Date.now()-60000;
  try{
    await pool.query("INSERT INTO workspaces(id) VALUES ('main_workspace') ON CONFLICT DO NOTHING");
    // Контрольные права foreman, которых может не быть в БД: копия должна их перенести.
    await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ('foreman','action_load',true),('foreman','edit_line',true),('foreman','archive_delete',false) ON CONFLICT (role,action) DO UPDATE SET allowed=EXCLUDED.allowed");
    const before=(await pool.query("SELECT action,allowed FROM role_permissions WHERE role='foreman' ORDER BY action")).rows;
    await pool.query(readFileSync(new URL('../sql/020_senior_foreman.sql',import.meta.url),'utf8'));
    // Идемпотентность: повторная миграция ничего не меняет.
    await pool.query(readFileSync(new URL('../sql/020_senior_foreman.sql',import.meta.url),'utf8'));
    const senior=(await pool.query("SELECT action,allowed FROM role_permissions WHERE role='senior_foreman' ORDER BY action")).rows;
    const expected=[...before.filter(r=>r.action!=='line_timer_reset').map(r=>({action:r.action,allowed:r.allowed})),{action:'line_timer_reset',allowed:true}].sort((a,b)=>a.action<b.action?-1:1);
    assert.deepEqual(senior,expected);
    const foremanReset=(await pool.query("SELECT allowed FROM role_permissions WHERE role='foreman' AND action='line_timer_reset'")).rows[0];
    assert.equal(foremanReset?.allowed,false);
    const version=(await pool.query("SELECT revision FROM role_permission_versions WHERE role='senior_foreman'")).rows[0];
    assert.ok(Number(version?.revision)>=1);

    // Сброс таймера ходки доступен senior_foreman на сервере.
    await pool.query('INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$3,$4,$5)',
      [uid,'sf@example.test','Старший прораб','senior_foreman','active']);
    await pool.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3::jsonb)',
      ['main_workspace',shiftId,JSON.stringify({id:shiftId})]);
    await pool.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3::jsonb)',
      ['main_workspace',truckId,JSON.stringify({brand:'КамАЗ',number:'002',defaultVol:12,isGAI:false})]);
    await pool.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4::jsonb)',
      ['main_workspace',truckId,shiftId,JSON.stringify({
        id:truckId,shiftId,onLine:true,cycleRevision:1,ttnRevision:0,loadedAfterArrive:false,
        arriveStatus:'10:00',arriveTimestamp:arrival,lastLoadTimestamp:null
      })]);
    const reset={id:'sf_reset_'+id,type:'reset',truckId,shiftId,createdAt:Date.now()-1000,
      expectedRevision:1,expectedTtnRevision:0,arrivalTimestamp:0,
      lastLoadTimestamp:0,wantArrived:false,collect:false,cycleMinutes:15};
    const resetOk=await submitLineOperation(pool,uid,reset);
    assert.equal(resetOk.outcome,'confirmed');
    assert.equal(resetOk.status.lastLoadTimestamp,null);
  }finally{
    const p=['main_workspace'];
    await pool.query('DELETE FROM line_audit WHERE workspace_id=$1 AND uid=$2',[...p,uid]).catch(()=>{});
    await pool.query('DELETE FROM line_operation_receipts WHERE workspace_id=$1 AND uid=$2',[...p,uid]).catch(()=>{});
    await pool.query('DELETE FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',[...p,shiftId]).catch(()=>{});
    await pool.query('DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',[...p,truckId]).catch(()=>{});
    await pool.query('DELETE FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',[...p,truckId]).catch(()=>{});
    await pool.query('DELETE FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[...p,shiftId]).catch(()=>{});
    await pool.query('DELETE FROM app_users WHERE uid=$1',[uid]).catch(()=>{});
    await pool.end();
  }
});
