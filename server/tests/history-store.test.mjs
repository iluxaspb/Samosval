import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {normalizeHistoryOperation,sameLineState,historyOperation,readLineHistory} from '../src/history-store.mjs';
import {submitLineOperation} from '../src/line-store.mjs';

test('history intents require a revision and accept no client-authored data changes',()=>{
  const valid={id:'op',actionId:'action',direction:'undo',expectedRevision:1};
  assert.deepEqual(normalizeHistoryOperation({...valid,status:{role:'admin'},uid:'other'}),valid);
  for(const data of [null,{}, {...valid,expectedRevision:0},{...valid,expectedRevision:1.5},{...valid,direction:'delete'},{...valid,actionId:'../x'}])assert.throws(()=>normalizeHistoryOperation(data));
  assert.equal(sameLineState({id:'x',cycleRevision:9,ttnRevision:2,onLine:true},{cycleRevision:1,onLine:true}),true);
  assert.equal(sameLineState({cycleRevision:9,onLine:true},{cycleRevision:1,onLine:false}),false);
  assert.equal(sameLineState(null,{}),false);
});

test('PostgreSQL history: atomic load, undo/redo, races, dependencies and revoked permission',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8});
  const suffix=randomUUID().replaceAll('-',''),uid='history_'+suffix,other=uid+'_other',disabled=uid+'_disabled',role=uid+'_role',shiftId=uid+'_shift',truckId=uid+'_truck',ws='main_workspace';
  const q=(sql,args)=>pool.query(sql,args);
  const load={id:uid+'_load',type:'load',truckId,shiftId,createdAt:Date.now()-1000,expectedRevision:1,expectedTtnRevision:0,arrivalTimestamp:Date.now()-60000,lastLoadTimestamp:0,wantArrived:false,collect:false,cycleMinutes:15};
  const undo={id:uid+'_undo',actionId:load.id,direction:'undo',expectedRevision:1};
  try{
    for(const [id,status] of [[uid,'active'],[other,'active'],[disabled,'disabled']])await q('INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$3,$4,$5)',[id,'fixture@example.test','Fixture',role,status]);
    for(const action of ['action_load','history_view','history_undo_own','history_redo_own'])await q('INSERT INTO role_permissions(role,action,allowed) VALUES ($1,$2,true)',[role,action]);
    await q('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',[ws,shiftId,{id:shiftId}]);
    await q('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3)',[ws,truckId,{brand:'Test',number:'TEST',defaultVol:24}]);
    const before={onLine:true,shiftId,cycleRevision:1,ttnRevision:0,arriveStatus:'09:00',arriveTimestamp:load.arrivalTimestamp,lastLoadTimestamp:null};
    await q('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4)',[ws,truckId,shiftId,before]);
    const loaded=await submitLineOperation(pool,uid,load);
    assert.equal(loaded.outcome,'confirmed');
    assert.equal((await q('SELECT count(*)::int AS n FROM line_history WHERE action_id=$1',[load.id])).rows[0].n,1);
    await submitLineOperation(pool,uid,load);
    assert.equal((await q('SELECT count(*)::int AS n FROM line_history WHERE action_id=$1',[load.id])).rows[0].n,1);
    await t.test('unknown, disabled and foreign actors cannot undo or get private snapshots',async()=>{
      for(const actor of [other,disabled,'missing_'+uid])await assert.rejects(historyOperation(pool,actor,undo),{status:403});
      await assert.rejects(readLineHistory(pool,disabled),{status:403});
      const items=(await readLineHistory(pool,uid)).items;
      const action=items.find(row=>row.id===load.id);assert.equal(action.canUndo,true);
      assert.equal('before_status' in action,false);
      assert.equal((await readLineHistory(pool,other)).items.find(row=>row.id===load.id).canUndo,false);
    });
    await t.test('two operators/retries can reverse a load only once',async()=>{
      const results=await Promise.allSettled([historyOperation(pool,uid,undo),historyOperation(pool,uid,{...undo,id:uid+'_racing'})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'history-changed');
      const winner=results[0].status==='fulfilled'?undo:{...undo,id:uid+'_racing'};
      const replay=await historyOperation(pool,uid,winner);assert.equal(replay.replayed,true);
      assert.equal((await q('SELECT count(*)::int AS n FROM line_logs WHERE log_id=$1',[loaded.log.id])).rows[0].n,0);
      assert.equal((await q('SELECT count(*)::int AS n FROM history_audit WHERE action_id=$1',[load.id])).rows[0].n,1);
      await assert.rejects(historyOperation(pool,uid,{...winner,expectedRevision:2}),{code:'operation-id-reused'});
    });
    await t.test('redo uses server-canonical data and monotonic revisions',async()=>{
      const restored=await historyOperation(pool,uid,{id:uid+'_redo',actionId:load.id,direction:'redo',expectedRevision:2});
      assert.equal(restored.status.cycleRevision,4);assert.equal(restored.revision,3);
      assert.deepEqual(restored.log,loaded.log);
      assert.equal((await q('SELECT count(*)::int AS n FROM line_logs WHERE log_id=$1',[loaded.log.id])).rows[0].n,1);
    });
    await t.test('a later change and closing shift prevent an old reversal',async()=>{
      await q("UPDATE line_truck_statuses SET payload=jsonb_set(payload,'{ttnStatus}','true') WHERE workspace_id=$1 AND truck_id=$2",[ws,truckId]);
      await assert.rejects(historyOperation(pool,uid,{...undo,id:uid+'_dependent',expectedRevision:3}),{code:'dependent-changes'});
      await q('UPDATE shifts SET is_active=false WHERE workspace_id=$1 AND shift_id=$2',[ws,shiftId]);
      await assert.rejects(historyOperation(pool,uid,{...undo,id:uid+'_closed',expectedRevision:3}),{code:'shift-changed'});
    });
    await t.test('revoked permissions are checked even for committed receipt replay',async()=>{
      await q('UPDATE role_permissions SET allowed=false WHERE role=$1',[role]);
      await assert.rejects(historyOperation(pool,uid,undo),{status:403});
      await assert.rejects(readLineHistory(pool,uid),{status:403});
    });
  }finally{
    for(const table of ['history_audit','history_receipts','line_history','line_audit','line_operation_receipts'])await q(`DELETE FROM ${table} WHERE workspace_id=$1 AND uid IN ($2,$3)`,[ws,uid,other]);
    await q('DELETE FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',[ws,shiftId]);
    await q('DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',[ws,truckId]);
    await q('DELETE FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',[ws,truckId]);
    await q('DELETE FROM shifts WHERE workspace_id=$1 AND shift_id=$2',[ws,shiftId]);
    await q('DELETE FROM role_permissions WHERE role=$1',[role]);
    await q('DELETE FROM app_users WHERE uid IN ($1,$2,$3)',[uid,other,disabled]);
    await pool.end();
  }
});
