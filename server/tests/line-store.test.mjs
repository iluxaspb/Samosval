import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { submitLineOperation } from '../src/line-store.mjs';

test('PostgreSQL serializes concurrent loads and stores durable idempotency receipts', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});
  const id=randomUUID().replaceAll('-','');
  const uid='ci_user_'+id, shiftId='ci_shift_'+id, truckId='ci_truck_'+id;
  const arrival=Date.now()-60000;
  try{
    await pool.query("INSERT INTO workspaces(id) VALUES ('main_workspace') ON CONFLICT DO NOTHING");
    await pool.query('INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$3,$4,$5)',
      [uid,'ci@example.test','CI Operator','lopater','active']);
    await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ('lopater','action_load',true) ON CONFLICT (role,action) DO UPDATE SET allowed=true");
    await pool.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3::jsonb)',
      ['main_workspace',shiftId,JSON.stringify({id:shiftId})]);
    await pool.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3::jsonb)',
      ['main_workspace',truckId,JSON.stringify({brand:'Test',number:'001',defaultVol:12,isGAI:false})]);
    await pool.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4::jsonb)',
      ['main_workspace',truckId,shiftId,JSON.stringify({
        id:truckId,shiftId,onLine:true,cycleRevision:1,ttnRevision:0,loadedAfterArrive:false,
        arriveStatus:'10:00',arriveTimestamp:arrival,lastLoadTimestamp:null
      })]);
    const event=opId=>({
      id:opId,type:'load',truckId,shiftId,createdAt:Date.now()-1000,
      expectedRevision:1,expectedTtnRevision:0,arrivalTimestamp:arrival,
      lastLoadTimestamp:0,wantArrived:false,collect:false,cycleMinutes:15
    });
    const first=event('ci_op1_'+id), second=event('ci_op2_'+id);
    const results=await Promise.all([
      submitLineOperation(pool,uid,first),submitLineOperation(pool,uid,second)
    ]);
    assert.deepEqual(results.map(x=>x.outcome).sort(),['confirmed','rejected']);
    const winner=results[0].outcome==='confirmed'?first:second;
    const replay=await submitLineOperation(pool,uid,winner);
    assert.equal(replay.outcome,'confirmed');
    assert.equal(replay.replayed,true);
    const logs=await pool.query('SELECT count(*)::int AS count FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',
      ['main_workspace',shiftId]);
    assert.equal(logs.rows[0].count,1);
    const receipt=await pool.query('SELECT count(*)::int AS count FROM line_operation_receipts WHERE workspace_id=$1 AND operation_id IN ($2,$3)',
      ['main_workspace',first.id,second.id]);
    assert.equal(receipt.rows[0].count,2);
    await assert.rejects(()=>submitLineOperation(pool,uid,{...winner,createdAt:winner.createdAt+1}),e=>e.status===409);
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
