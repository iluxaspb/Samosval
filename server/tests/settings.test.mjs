import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {normalizeSettings,settingsView,submitSettings,readSettings} from '../src/settings-store.mjs';
test('settings allow only typed supported fields and never accept replacement reward history',()=>{
  const base={id:'setting_1',type:'settings.patch',expectedRevision:1};
  for(const patch of [{role:'admin'},{cycleMinutes:14},{cycleMinutes:15.1},{cycleMinutes:10081},{maxEnabled:'yes'},{testReviewFlags:{unknown:true}},{testReviewFlags:{game_mode:1}},{gameRewardSchedule:[]},{maxUrl:'http://example.test'},{maxUrl:'https://u:p@example.test'}])assert.throws(()=>normalizeSettings({...base,patch}));
  assert.deepEqual(normalizeSettings({...base,patch:{cycleMinutes:60,testReviewFlags:{game_mode:false}}}).patch,{cycleMinutes:60,testReviewFlags:{game_mode:false}});
  assert.throws(()=>normalizeSettings({...base,type:'settings.rewards',values:{load:1,arrive:2,ttn:-1}}));
  assert.deepEqual(normalizeSettings({...base,type:'settings.rewards',values:{load:0,arrive:10000,ttn:1}}).values,{load:0,arrive:10000,ttn:1});
});
test('non-administrators never receive MAX URL, token or chat destination',()=>{
  const data={maxUrl:'https://example.test',maxToken:'fixture',maxChatId:'target',cycleMinutes:60,testReviewFlags:{game_mode:false},gameRewardSchedule:[]};
  const publicView=settingsView(data,false);for(const k of ['maxUrl','maxToken','maxChatId'])assert.equal(Object.hasOwn(publicView,k),false);
  assert.deepEqual(settingsView(data,true),data);
});
test('PostgreSQL settings: parallel revisions, receipts, permission revocation, append-only rates and cycle coherence',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),ws='cfg_'+randomUUID().replaceAll('-',''),admin=ws+'_a',worker=ws+'_w';
  try{
    await pool.query('INSERT INTO workspaces(id) VALUES ($1)',[ws]);
    for(const [uid,role] of [[admin,'admin'],[worker,'viewer']])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'fixture@example.test',$1,$2,'active')",[uid,role]);
    await pool.query('INSERT INTO workspace_settings(workspace_id,payload) VALUES ($1,$2)',[ws,{cycleMinutes:15,maxToken:'fixture',testReviewFlags:{game_sound:false},gameRewardSchedule:[{effectiveAt:1,load:1,arrive:2,ttn:0}]}]);
    const op={id:'patch',type:'settings.patch',expectedRevision:1,patch:{cycleMinutes:60,testReviewFlags:{game_mode:false}}};
    await t.test('worker read is redacted and write denied',async()=>{
      assert.equal((await readSettings(pool,worker,ws)).data.maxToken,undefined);
      await assert.rejects(submitSettings(pool,worker,op,ws),{code:'forbidden'});
    });
    await t.test('same command commits once and replays unchanged after another write',async()=>{
      const results=await Promise.all([submitSettings(pool,admin,op,ws),submitSettings(pool,admin,op,ws)]);
      assert.equal(results.filter(r=>r.replayed).length,1);assert.equal(results[0].result.revision,2);
      assert.equal((await pool.query('SELECT cycle_minutes FROM workspaces WHERE id=$1',[ws])).rows[0].cycle_minutes,60);
      assert.equal((await readSettings(pool,admin,ws)).data.testReviewFlags.game_sound,false);
      await assert.rejects(submitSettings(pool,admin,{...op,patch:{cycleMinutes:90}},ws),{code:'operation-id-reused'});
    });
    await t.test('two editors cannot silently overwrite; rewards retain previous versions',async()=>{
      const results=await Promise.allSettled([submitSettings(pool,admin,{...op,id:'edit_a',expectedRevision:2,patch:{cycleMinutes:90}},ws),submitSettings(pool,admin,{...op,id:'edit_b',expectedRevision:2,patch:{cycleMinutes:120}},ws)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'settings-changed');
      const next=await submitSettings(pool,admin,{id:'rates',type:'settings.rewards',expectedRevision:3,values:{load:5,arrive:0,ttn:10}},ws);
      assert.deepEqual(next.result.data.gameRewardSchedule[0],{effectiveAt:1,load:1,arrive:2,ttn:0});assert.equal(next.result.data.gameRewardSchedule.length,2);
      assert.equal((await submitSettings(pool,admin,op,ws)).result.revision,2);
    });
    await t.test('revocation denies replay and no extra audit appears',async()=>{
      await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1",[admin]);
      await assert.rejects(submitSettings(pool,admin,op,ws),{code:'forbidden'});
      assert.equal((await pool.query('SELECT count(*)::int n FROM workspace_service_audit WHERE workspace_id=$1',[ws])).rows[0].n,3);
    });
  }finally{
    for(const table of ['workspace_service_audit','workspace_service_receipts','workspace_settings'])await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[ws]);
    await pool.query('DELETE FROM workspaces WHERE id=$1',[ws]);await pool.query('DELETE FROM app_users WHERE uid=ANY($1)',[[admin,worker]]);await pool.end();
  }
});
