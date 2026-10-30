import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {normalizeServerCommand,controlFresh,submitServerCommand,readServerControl} from '../src/server-control.mjs';
import {createNasClient} from '../../test-app/synology/session-client.mjs';
const image='sha256:'+'a'.repeat(64);
test('server commands are TEST-only, allowlisted and image fenced',()=>{
 for(const input of [{id:'x',type:'shell',channel:'test'},{id:'../x',type:'backup',channel:'test'},{id:'x',type:'backup',channel:'production'},{id:'x',type:'update',channel:'test',releaseId:'4.1.1',expectedImage:'latest'},{id:'x',type:'update',channel:'test',releaseId:'https://evil.test',expectedImage:image}])assert.throws(()=>normalizeServerCommand(input));
 assert.deepEqual(normalizeServerCommand({id:'x',type:'backup',channel:'test',command:'rm -rf'}),{id:'x',type:'backup',channel:'test'});
 const now=Date.now();assert.equal(controlFresh({heartbeat:new Date(now),payload:{protocol:1}},now),true);assert.equal(controlFresh({heartbeat:new Date(now-60001),payload:{protocol:1}},now),false);assert.equal(controlFresh({heartbeat:new Date(now),payload:{protocol:2}},now),false);
});
test('PostgreSQL control: admin gate, concurrent jobs, replay, stale worker and source image',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4}),prefix='sc_'+randomUUID().replaceAll('-',''),admin=prefix+'a',worker=prefix+'w';let oldState;
 try{
 oldState=(await pool.query("SELECT * FROM server_control_state WHERE channel='test'")).rows[0];
 for(const [uid,role]of[[admin,'admin'],[worker,'lopater']])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$1,$1,$2,'active')",[uid,role]);
 await pool.query("INSERT INTO server_control_state(channel,payload) VALUES ('test',$1) ON CONFLICT(channel) DO UPDATE SET heartbeat=now(),payload=EXCLUDED.payload",[{protocol:1,imageId:image,release:{version:'4.1.1',verified:true}}]);
 const snapshot=await readServerControl(pool,admin);const user={uid:admin,getIdToken:async()=> 'fixture-token'};const client=createNasClient({getUser:()=>user,fetchImpl:async()=>new Response(JSON.stringify(snapshot),{headers:{'Content-Type':'application/json'}})});assert.equal((await client.readServerControl()).source,'synology');
 const command={id:prefix,type:'check',channel:'test'};
 await assert.rejects(submitServerCommand(pool,worker,command),{status:403});await assert.rejects(readServerControl(pool,worker),{status:403});
 assert.equal((await submitServerCommand(pool,admin,command)).status,'queued');assert.equal((await submitServerCommand(pool,admin,command)).replayed,true);
 await assert.rejects(submitServerCommand(pool,admin,{...command,type:'backup'}),{status:409});
 await assert.rejects(submitServerCommand(pool,admin,{...command,id:prefix+'2'}),{code:'server-busy'});
 await pool.query("UPDATE server_control_jobs SET status='succeeded' WHERE job_id=$1",[prefix]);
 const concurrent=await Promise.allSettled(['3','4'].map(s=>submitServerCommand(pool,admin,{...command,id:prefix+s})));assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);assert.equal(concurrent.find(x=>x.status==='rejected').reason.code,'server-busy');
 await pool.query("UPDATE server_control_jobs SET status='succeeded' WHERE uid=$1",[admin]);
 await assert.rejects(submitServerCommand(pool,admin,{id:prefix+'5',type:'update',channel:'test',releaseId:'4.1.1',expectedImage:'sha256:'+'b'.repeat(64)}),{code:'server-image-changed'});
 await pool.query("UPDATE server_control_state SET heartbeat=now()-interval '2 minutes' WHERE channel='test'");
 await assert.rejects(submitServerCommand(pool,admin,{...command,id:prefix+'6'}),{code:'server-agent-unavailable'});
 await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1",[admin]);await assert.rejects(submitServerCommand(pool,admin,command),{status:403});
 }finally{
 await pool.query('DELETE FROM server_control_events WHERE job_id IN(SELECT job_id FROM server_control_jobs WHERE uid=$1)',[admin]);await pool.query('DELETE FROM server_control_jobs WHERE uid=$1',[admin]);await pool.query('DELETE FROM app_users WHERE uid=ANY($1)',[[admin,worker]]);
 if(oldState)await pool.query("UPDATE server_control_state SET heartbeat=$1,payload=$2 WHERE channel='test'",[oldState.heartbeat,oldState.payload]);else await pool.query("DELETE FROM server_control_state WHERE channel='test'");await pool.end();
 }
});
