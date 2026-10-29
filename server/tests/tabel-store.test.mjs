import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {commitTabel,readTabel} from '../src/tabel-store.mjs';
test('PostgreSQL Tabel: atomic receipts, contention, ACLs and revocation',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});
  const prefix='table_'+randomUUID().replaceAll('-',''),object=prefix,admin=prefix+'_admin',worker=prefix+'_worker',role=prefix+'_role';
  const sheet=object+'/sheet:one',config=object+'/config';
  const makeJob=(key,data,before={revision:0,data:null},id=prefix+'_'+randomUUID())=>({key,data,before,id,label:'TEST'});
  let policyCreated=false;
  try {
    await pool.query("INSERT INTO workspaces(id) VALUES ('main_workspace') ON CONFLICT DO NOTHING");
    policyCreated=!!(await pool.query("INSERT INTO tabel_policy(workspace_id,enabled,import_sha256) VALUES ('main_workspace',true,'ci') ON CONFLICT DO NOTHING RETURNING workspace_id")).rowCount;
    for(const [uid,r] of [[admin,'admin'],[worker,role]])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'fixture@example.test','Fixture',$2,'active')",[uid,r]);
    await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ($1,'tab_timesheet',true),($1,'timesheet_edit',true)",[role]);
    await commitTabel(pool,admin,makeJob(config,{sheetAccess:{one:{users:{[worker]:true}}}}));
    const original=await commitTabel(pool,admin,makeJob(sheet,{name:'Лист',deleted:false,cells:{}}));
    await t.test('parallel first entries to the same cell preserve one value and report one conflict',async()=>{
      const jobs=['12','13'].map(raw=>makeJob(sheet,{...original.data,cells:{A1:{raw}}},original));
      const results=await Promise.all(jobs.map(j=>commitTabel(pool,worker,j)));
      assert.equal(results.filter(r=>r.conflict).length,1);
      const confirmed=results.find(r=>!r.conflict),winner=jobs[results.findIndex(r=>!r.conflict)];
      const replay=await commitTabel(pool,worker,winner);
      assert.deepEqual(replay,confirmed);
      assert.equal((await readTabel(pool,worker,{key:sheet})).record.revision,2);
      const count=await pool.query('SELECT count(*)::int AS n FROM tabel_receipts WHERE object_id=$1',[object]);
      assert.equal(count.rows[0].n,3); // config, original sheet, exactly one accepted entry
      await assert.rejects(commitTabel(pool,worker,{...winner,data:{cells:{A1:{raw:'999'}}}}),{code:'operation-id-reused'});
      await assert.rejects(commitTabel(pool,admin,winner),{code:'operation-id-reused'});
    });
    await t.test('independent offline edits merge, preserving server-only quantities',async()=>{
      const base=(await readTabel(pool,worker,{key:sheet})).record;
      await commitTabel(pool,worker,makeJob(sheet,{...base.data,cells:{...base.data.cells,A2:{raw:'20'}}},base));
      const merged=await commitTabel(pool,worker,makeJob(sheet,{...base.data,cells:{...base.data.cells,A3:{raw:'30'}}},base));
      assert.equal(merged.revision,4);
      assert.equal(merged.data.cells.A2.raw,'20');assert.equal(merged.data.cells.A3.raw,'30');
    });
    await t.test('ungranted sheets stay hidden; only managers can read complete history',async()=>{
      await commitTabel(pool,admin,makeJob(object+'/sheet:hidden',{name:'Hidden',cells:{}}));
      await assert.rejects(readTabel(pool,worker,{key:object+'/sheet:hidden'}),{status:403});
      const list=await readTabel(pool,worker,{objectId:object});
      assert.deepEqual(list.rows.map(([key])=>key).sort(),[config,sheet].sort());
      await assert.rejects(readTabel(pool,worker,{objectId:object,kind:'history'}),{status:403});
      assert.ok((await readTabel(pool,admin,{objectId:object,kind:'history'})).rows.length>=5);
    });
    await t.test('revoked access prevents both a cached replay and new reads',async()=>{
      const base=(await readTabel(pool,worker,{key:sheet})).record;
      const job=makeJob(sheet,{...base.data,cells:{...base.data.cells,A4:{raw:'40'}}},base);
      await commitTabel(pool,worker,job);
      const before=(await readTabel(pool,admin,{key:config})).record;
      await commitTabel(pool,admin,makeJob(config,{sheetAccess:{}},before));
      await assert.rejects(commitTabel(pool,worker,job),{status:403});
      await assert.rejects(readTabel(pool,worker,{key:sheet}),{status:403});
      await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1",[admin]);
      await assert.rejects(readTabel(pool,admin,{key:config}),{status:403});
    });
  } finally {
    await pool.query('DELETE FROM tabel_receipts WHERE object_id=$1',[object]);
    await pool.query('DELETE FROM tabel_records WHERE object_id=$1',[object]);
    await pool.query('DELETE FROM role_permissions WHERE role=$1',[role]);
    await pool.query('DELETE FROM app_users WHERE uid IN ($1,$2)',[admin,worker]);
    if(policyCreated)await pool.query("DELETE FROM tabel_policy WHERE workspace_id='main_workspace' AND import_sha256='ci'");
    await pool.end();
  }
});
