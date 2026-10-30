import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readGames,submitGame} from '../src/game-store.mjs';
import {themePrices} from '../src/theme-prices.mjs';
import {dayKey} from '../src/arcade-rules.mjs';
test('PostgreSQL game wallet: server policy, replay, concurrency, grants, purchases, Moscow day and access revocation',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),ws='game_'+randomUUID().replaceAll('-',''),admin=ws+'_a',user=ws+'_u',viewer=ws+'_v';let sequence=0;
  const play=(action,uid=user,id='play_'+(++sequence))=>submitGame(pool,uid,{id,type:'game.play',action},ws);
  try{
    await pool.query('INSERT INTO workspaces(id) VALUES ($1)',[ws]);
    for(const [uid,role] of [[admin,'admin'],[user,'lopater'],[viewer,'viewer']])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$1,$3,'active')",[uid,uid+'@example.test',role]);
    await pool.query('INSERT INTO workspace_settings(workspace_id,payload) VALUES ($1,$2)',[ws,{cycleMinutes:15,testReviewFlags:{}}]);
    await pool.query('INSERT INTO workspace_services_state(workspace_id,import_sha256) VALUES ($1,$2)',[ws,'a'.repeat(64)]);
    await t.test('arcade requires an open shift and a real account',async()=>{
      await assert.rejects(play({kind:'mario',level:1,coin:0,day:dayKey()}),{code:'open-shift-required'});
      await assert.rejects(readGames(pool,'unknown',ws),{code:'forbidden'});
      await pool.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',[ws,'fixture',{id:'fixture',isActive:true,objectId:'site'}]);
    });
    await t.test('same grant ID gives one credit; readers see only their own grants',async()=>{
      const op={id:'grant',type:'game.grant',targetUid:user,amount:500,reason:'Test award'};
      const results=await Promise.all([submitGame(pool,admin,op,ws),submitGame(pool,admin,op,ws)]);assert.equal(results.filter(r=>r.replayed).length,1);
      assert.equal((await readGames(pool,user,ws)).adjustments.length,1);assert.equal((await readGames(pool,viewer,ws)).adjustments.length,0);
      await assert.rejects(submitGame(pool,user,{...op,id:'forged'},ws),{code:'forbidden'});
      await assert.rejects(submitGame(pool,admin,{...op,amount:600},ws),{code:'operation-id-reused'});
    });
    await t.test('simultaneous purchase consumes the server price once and retains bank/player values',async()=>{
      const itemId=Object.keys(themePrices)[0],results=await Promise.all([play({kind:'purchase',itemId,price:0}),play({kind:'purchase',itemId,price:0})]);
      assert.equal(results.filter(r=>r.result.noop).length,1);
      const snapshot=await readGames(pool,user,ws),purchases=snapshot.records.filter(r=>r.eventType==='game_purchase');assert.equal(purchases.length,1);assert.equal(purchases[0].price,themePrices[itemId]);assert.equal(snapshot.head.bank,1000);assert.equal(snapshot.players[user].net,0);
      await assert.rejects(play({kind:'purchase',itemId},viewer),{code:'shop-not-available'});
    });
    await t.test('same-ID coin replay and different-ID duplicate never double a Mario reward',async()=>{
      const action={kind:'mario',level:1,coin:0,day:dayKey()};
      const first=await play(action,user,'coin');const repeated=await play(action,user,'coin');assert.equal(repeated.replayed,true);assert.equal(repeated.result.round,first.result.round);
      assert.equal((await play(action)).result.noop,true);assert.equal((await readGames(pool,user,ws)).players[user].marioCoins,1);
      await assert.rejects(play({...action,day:'2000-01-01'}),{status:409});
      assert.equal((await play(action,viewer)).result.delta,1);
    });
    await t.test('slot receipt preserves server outcome while successive rounds retain a nonnegative bank',async()=>{
      const a=await play({kind:'slot',roll:0},admin,'spin'),b=await play({kind:'slot',roll:0},admin,'spin');assert.deepEqual(a.result,b.result);assert.equal(b.replayed,true);
      const snapshot=await readGames(pool,admin,ws);assert.ok(snapshot.head.bank>=0);assert.equal(snapshot.players[admin].spins,1);
      assert.equal(snapshot.records.filter(r=>r.eventType==='game_arcade'&&r.requestId==='spin').length,1);
    });
    await t.test('disable policy blocks new plays; profile revocation also blocks receipt replay',async()=>{
      await pool.query('UPDATE workspace_settings SET payload=$2 WHERE workspace_id=$1',[ws,{testReviewFlags:{game_mode:false}}]);
      await assert.rejects(play({kind:'slot'},admin),{code:'game-disabled'});
      await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1",[user]);await assert.rejects(play({kind:'mario',level:1,coin:0,day:dayKey()},user,'coin'),{code:'forbidden'});
    });
  }finally{
    for(const table of ['workspace_service_audit','workspace_service_receipts','game_records','workspace_services_state','workspace_settings','shifts'])await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[ws]);
    await pool.query('DELETE FROM workspaces WHERE id=$1',[ws]);await pool.query('DELETE FROM app_users WHERE uid=ANY($1)',[[admin,user,viewer]]);await pool.end();
  }
});
