import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {startShiftOperation} from '../src/shift-start.mjs';
test('PostgreSQL shift start serializes operators and preserves previous data',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});
  const ws='start_'+randomUUID().replaceAll('-',''),uid=ws+'_admin',other=ws+'_other',role=ws+'_role',site='site';
  const op=(id='first')=>({id,objectId:site,createdAt:Date.now()});
  const start=(data,actor=uid)=>startShiftOperation(pool,actor,data,ws);
  const clear=async()=>{await pool.query('DELETE FROM line_audit WHERE workspace_id=$1',[ws]);await pool.query('DELETE FROM shift_operation_receipts WHERE workspace_id=$1',[ws]);await pool.query('DELETE FROM shifts WHERE workspace_id=$1',[ws]);};
  try {
    await pool.query('INSERT INTO workspaces(id) VALUES ($1)',[ws]);
    for(const [id,userRole] of [[uid,'admin'],[other,role]])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'fixture@example.test',$2,$3,'active')",[id,'Actor '+id,userRole]);
    await pool.query('INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES ($1,$2,$3)',[ws,site,{name:'Server site'}]);
    await t.test('two operators opening simultaneously produce exactly one shift and one receipt',async()=>{
      const results=await Promise.allSettled([start(op('concurrent_a')),start(op('concurrent_b'))]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(results.find(x=>x.status==='rejected').reason.code,'shift-already-active');
      for(const table of ['shifts','shift_operation_receipts','line_audit'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[ws])).rows[0].n,1);
      await clear();
    });
    await t.test('same-ID response loss replay returns same server shift; changed body conflicts',async()=>{
      const operation=op(),saved=await start({...operation,objectName:'Fake',startedBy:'Fake'});
      assert.equal(saved.shift.objectName,'Server site');assert.equal(saved.shift.startedBy,'Actor '+uid);
      const replay=await start(operation);assert.equal(replay.replayed,true);assert.deepEqual(replay.shift,saved.shift);
      await assert.rejects(start({...operation,createdAt:operation.createdAt+1}),{code:'operation-id-reused'});
      await clear();
    });
    await t.test('disabled profiles and denied roles cannot open or replay; explicit role permission works',async()=>{
      const operation=op();await start(operation);
      await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1",[uid]);
      await assert.rejects(start(operation),{code:'forbidden'});
      await pool.query("UPDATE app_users SET status='active' WHERE uid=$1",[uid]);await clear();
      await assert.rejects(start(op(),other),{code:'forbidden'});
      await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ($1,'start_shift',true)",[role]);
      await start(op(),other);await clear();
    });
    await t.test('unfinished close blocks start without touching archive or source state',async()=>{
      await pool.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,false,$3)',[ws,'previous',{id:'previous',closing:true}]);
      await assert.rejects(start(op()),{code:'previous-shift-closing'});
      assert.deepEqual((await pool.query('SELECT payload FROM shifts WHERE workspace_id=$1',[ws])).rows[0].payload,{id:'previous',closing:true});
      await clear();
    });
    await t.test('leftover trips are preserved, and start never performs old global cleanup',async()=>{
      await pool.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5)',[ws,'old_log','old_shift','truck',{volume:24}]);
      await assert.rejects(start(op()),{code:'previous-line-data-remains'});
      assert.deepEqual((await pool.query('SELECT payload FROM line_logs WHERE workspace_id=$1',[ws])).rows[0].payload,{volume:24});
      await pool.query('DELETE FROM line_logs WHERE workspace_id=$1',[ws]);
    });
    await t.test('object and future-time errors roll back the placeholder receipt',async()=>{
      await assert.rejects(start({...op(),objectId:'missing'}),{code:'object-not-available'});
      await assert.rejects(start({...op(),createdAt:Date.now()+600000}),{code:'future-operation'});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM shift_operation_receipts WHERE workspace_id=$1',[ws])).rows[0].n,0);
    });
  } finally {
    await pool.query('DELETE FROM line_logs WHERE workspace_id=$1',[ws]);await clear();
    await pool.query('DELETE FROM workspace_objects WHERE workspace_id=$1',[ws]);
    await pool.query('DELETE FROM role_permissions WHERE role=$1',[role]);
    await pool.query('DELETE FROM app_users WHERE uid=ANY($1::text[])',[[uid,other]]);
    await pool.query('DELETE FROM workspaces WHERE id=$1',[ws]);await pool.end();
  }
});
