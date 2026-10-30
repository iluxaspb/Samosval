import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {submitControl,readCatalog} from '../src/control-store.mjs';
test('PostgreSQL catalogs and line controls validate rights, revisions, replays and retained history',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),ws='ctrl_'+randomUUID().replaceAll('-',''),uid=ws+'_admin',other=ws+'_other',worker=ws+'_worker',role=ws+'_role',shift='shift';
  let sequence=0;
  const send=(type,data={},user=uid)=>submitControl(pool,user,{id:'op_'+(++sequence),type,...data},ws);
  const create=(kind,id,data)=>send(kind+'.create',{recordId:id,expectedRevision:0,data});
  const truck={brand:'KAMAZ',number:'TEST',defaultVol:24,isGAI:false};
  const member=(type,rev,ttn)=>send('line.'+type,{shiftId:shift,truckId:'truck',expectedRevision:rev,expectedTtnRevision:ttn});
  try{
    await pool.query('INSERT INTO workspaces(id) VALUES ($1),($2)',[ws,ws+'_empty']);
    for(const [id,userRole] of [[uid,'admin'],[other,'admin'],[worker,role]])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'fixture@example.test',$1,$2,'active')",[id,userRole]);
    await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ($1,'tab_line',true),($1,'edit_line',true)",[role]);
    await t.test('catalog is workspace scoped; roles without dictionary-write cannot forge permissions',async()=>{
      await assert.rejects(readCatalog(pool,'unknown',ws),{code:'forbidden'});
      await assert.rejects(send('truck.create',{recordId:'truck',expectedRevision:0,data:{...truck,role:'admin'}},worker),{code:'forbidden'});
      await create('truck','truck',truck);await create('object','site',{name:'Original site'});await create('object','other_site',{name:'Other site'});
      assert.equal((await readCatalog(pool,worker,ws)).trucks.length,1);
      assert.equal((await readCatalog(pool,uid,ws+'_empty')).trucks.length,0);
      assert.equal((await readCatalog(pool,uid,ws)).objects.length,2);
    });
    await t.test('timesheet-only catalog exposes objects with start dates but no line trucks',async()=>{
      await pool.query("UPDATE role_permissions SET allowed=false WHERE role=$1 AND action='tab_line'",[role]);
      await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ($1,'tab_timesheet',true)",[role]);
      const catalog=await readCatalog(pool,worker,ws);assert.equal(catalog.trucks.length,0);assert.equal(catalog.objects.length,2);
      await pool.query("UPDATE role_permissions SET allowed=true WHERE role=$1 AND action='tab_line'",[role]);
    });
    await t.test('simultaneous same-ID creation replays one revision and one audit event',async()=>{
      const op={id:'same',type:'truck.create',recordId:'same_truck',expectedRevision:0,data:{...truck,isGAI:true}};
      const results=await Promise.all([submitControl(pool,uid,op,ws),submitControl(pool,uid,op,ws)]);
      assert.equal(results.filter(x=>x.replayed).length,1);
      assert.equal(results[0].result.data.defaultVol,0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM control_audit WHERE workspace_id=$1 AND operation_id=$2',[ws,'same'])).rows[0].n,1);
      await assert.rejects(submitControl(pool,other,op,ws),{code:'operation-id-reused'});
      await assert.rejects(submitControl(pool,uid,{...op,data:{...op.data,number:'CHANGED'}},ws),{code:'operation-id-reused'});
    });
    await t.test('two concurrent dictionary updates cannot overwrite the same base revision',async()=>{
      const update=name=>send('object.update',{recordId:'site',expectedRevision:1,data:{name}});
      const results=await Promise.allSettled([update('First'),update('Second')]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(results.find(x=>x.status==='rejected').reason.code,'record-changed');
      const record=(await readCatalog(pool,uid,ws)).objects.find(x=>x.id==='site');assert.equal(record.revision,2);
    });
    await pool.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',[ws,shift,{id:shift,objectId:'site',objectName:'Original site',isActive:true}]);
    await t.test('parallel additions with stale initial state create one membership',async()=>{
      const results=await Promise.allSettled([member('add',0,0),member('add',0,0)]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(results.find(x=>x.status==='rejected').reason.code,'line-intent-changed');
      const row=(await pool.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1',[ws])).rows[0].payload;
      assert.equal(row.addedBy,uid);assert.equal(row.cycleRevision,1);
    });
    await t.test('truck deletion while on line is rejected without changing dictionary revision',async()=>{
      await assert.rejects(send('truck.delete',{recordId:'truck',expectedRevision:1}),{code:'truck-still-on-line'});
      assert.equal((await readCatalog(pool,uid,ws)).trucks.find(x=>x.id==='truck').revision,1);
    });
    await t.test('stale removal loses to a newer load; removing and rejoining retain its cooldown and receipt link',async()=>{
      const ts=Date.now();
      await pool.query("UPDATE line_truck_statuses SET payload=payload||$2::jsonb WHERE workspace_id=$1",[ws,JSON.stringify({cycleRevision:8,ttnRevision:4,lastLoadTimestamp:ts,lastLoadLogId:'saved_load',ttnStatus:true})]);
      await pool.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5)',[ws,'saved_load',shift,'truck',{volume:24}]);
      await assert.rejects(member('remove',1,1),{code:'line-intent-changed'});
      const removed=(await member('remove',8,4)).result;assert.equal(removed.onLine,false);assert.equal(removed.lastLoadTimestamp,ts);
      const joined=(await member('add',9,5)).result;assert.equal(joined.cycleRevision,10);assert.equal(joined.ttnRevision,6);assert.equal(joined.lastLoadLogId,'saved_load');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM line_logs WHERE workspace_id=$1',[ws])).rows[0].n,1);
    });
    await t.test('changing object checks the observed old object and does not rewrite previous logs',async()=>{
      const result=await send('shift.object',{shiftId:shift,objectId:'other_site',expectedObjectId:'site'});
      assert.equal(result.result.objectName,'Other site');
      await assert.rejects(send('shift.object',{shiftId:shift,objectId:'site',expectedObjectId:'site'}),{code:'object-changed'});
      assert.deepEqual((await pool.query('SELECT payload FROM line_logs WHERE workspace_id=$1',[ws])).rows[0].payload,{volume:24});
      await assert.rejects(send('object.delete',{recordId:'other_site',expectedRevision:1}),{code:'object-in-open-shift'});
    });
    await t.test('soft deletion after leaving hides truck but preserves old logs and the tombstone',async()=>{
      await member('remove',10,6);
      const deleted=(await send('truck.delete',{recordId:'truck',expectedRevision:1})).result;
      assert.equal(deleted.data.deleted,true);assert.equal(deleted.revision,2);
      assert.equal((await readCatalog(pool,uid,ws)).trucks.some(x=>x.id==='truck'),false);
      await assert.rejects(member('add',11,7),{code:'truck-not-available'});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM line_logs WHERE workspace_id=$1',[ws])).rows[0].n,1);
    });
    await t.test('closing blocks membership and object change; current object remains protected',async()=>{
      await pool.query("UPDATE shifts SET is_active=false,payload=payload||'{\"closing\":true}' WHERE workspace_id=$1",[ws]);
      await assert.rejects(send('line.add',{shiftId:shift,truckId:'same_truck',expectedRevision:0,expectedTtnRevision:0}),{code:'shift-changed'});
      await assert.rejects(send('shift.object',{shiftId:shift,objectId:'site',expectedObjectId:'other_site'}),{code:'shift-changed'});
      await assert.rejects(send('object.delete',{recordId:'other_site',expectedRevision:1}),{code:'object-in-open-shift'});
    });
    await t.test('revoked profile cannot read, write or replay an earlier successful operation',async()=>{
      await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1",[uid]);
      await assert.rejects(readCatalog(pool,uid,ws),{code:'forbidden'});
      await assert.rejects(submitControl(pool,uid,{id:'same',type:'truck.create',recordId:'same_truck',expectedRevision:0,data:{...truck,isGAI:true}},ws),{code:'forbidden'});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM control_audit WHERE workspace_id=$1',[ws])).rows[0].n,(await pool.query('SELECT count(*)::int AS n FROM control_operation_receipts WHERE workspace_id=$1',[ws])).rows[0].n);
    });
  }finally{
    for(const table of ['control_audit','control_operation_receipts','line_logs','line_truck_statuses','line_trucks','shifts','workspace_objects'])await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[ws]);
    await pool.query('DELETE FROM role_permissions WHERE role=$1',[role]);await pool.query('DELETE FROM app_users WHERE uid=ANY($1::text[])',[[uid,other,worker]]);
    await pool.query('DELETE FROM workspaces WHERE id=ANY($1::text[])',[[ws,ws+'_empty']]);await pool.end();
  }
});
