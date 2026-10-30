import test from 'node:test';
import assert from 'node:assert/strict';
import {createPresenceService,presenceIntent} from '../src/tabel-presence.mjs';
import {authorizeTabelPresence,commitTabel} from '../src/tabel-store.mjs';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
const intent=(sequence=1,extra={})=>({type:'write',sessionId:'browser',sequence,objectId:'site',sheetId:'one',selection:{a:'A1',b:'B2'},...extra});
function fixture(options={}){
  let time=1000;const denied=new Set();const authorize=async uid=>{if(denied.has(uid))throw Object.assign(Error('forbidden'),{status:403});return {uid,name:'Server '+uid,workspaceId:'main_workspace'};};
  const service=createPresenceService({authorize,now:()=>time,...options});return {service,denied,advance:n=>{time+=n;}};
}
test('presence derives UID, name and timestamp on server; caller fields cannot impersonate a peer',async()=>{
  const {service}=fixture();const source=intent(1,{uid:'admin',name:'Forged',seen:99999999});
  const write=await service.write('operator',source);source.selection.a='Z99';
  assert.equal(write.record.uid,'operator');assert.equal(write.record.name,'Server operator');assert.equal(write.record.seen,1000);assert.equal(write.record.selection.a,'A1');
  assert.equal((await service.list('other',{objectId:'site',sheetId:'one'})).peers[0].uid,'operator');
});
test('presence isolates objects/sheets and hides all sessions belonging to the reader',async()=>{
  const {service}=fixture();await service.write('one',intent());await service.write('one',intent(1,{sessionId:'second'}));await service.write('two',intent());await service.write('three',intent(1,{sheetId:'other'}));
  assert.deepEqual((await service.list('one',{objectId:'site',sheetId:'one'})).peers.map(p=>p.uid),['two']);
  assert.deepEqual((await service.list('one',{objectId:'other',sheetId:'one'})).peers,[]);
});
test('presence expiry cannot be extended by client clocks or replay of the same sequence',async()=>{
  const h=fixture({ttlMs:1000});await h.service.write('one',intent());h.advance(900);await h.service.write('one',intent(1,{seen:9999999}));h.advance(101);
  assert.deepEqual((await h.service.list('two',{objectId:'site',sheetId:'one'})).peers,[]);
});
test('presence revocation removes cached peers and denies a revoked reader; own cleanup still works',async()=>{
  const h=fixture();await h.service.write('one',intent());h.denied.add('one');
  assert.deepEqual((await h.service.list('two',{objectId:'site',sheetId:'one'})).peers,[]);
  await assert.rejects(h.service.list('one',{objectId:'site',sheetId:'one'}),{status:403});
  assert.equal((await h.service.write('one',{type:'remove',sessionId:'browser',sequence:2})).removed,true);
});
test('presence delayed write cannot resurrect a removed selection',async()=>{
  let release;const authorize=uid=>new Promise(resolve=>{release=()=>resolve({uid,name:'Name',workspaceId:'main_workspace'});});
  const service=createPresenceService({authorize});const pending=service.write('one',intent());
  await service.write('one',{type:'remove',sessionId:'browser',sequence:2});release();assert.equal((await pending).ignored,true);
});
test('presence old sequence cannot move a newer selection back to a previous sheet',async()=>{
  const h=fixture();await h.service.write('one',intent(2,{sheetId:'new'}));assert.equal((await h.service.write('one',intent(1))).ignored,true);
  assert.deepEqual((await h.service.list('two',{objectId:'site',sheetId:'one'})).peers,[]);
});
test('presence validates bounded ranges and never accepts client-authored profile fields',()=>{
  assert.deepEqual(presenceIntent(intent(1,{selection:{a:'A1',b:'B2',rowKeys:['a','a'],colKeys:['b'],uid:'admin'}})).selection,{a:'A1',b:'B2',rowKeys:['a'],colKeys:['b']});
  for(const op of [intent(0),intent(1,{sheetId:'../other'}),intent(1,{objectId:'_catalog'}),intent(1,{selection:{a:'<script>',b:'B2'}}),intent(1,{selection:{a:'A1',b:'B2',rowKeys:['row']}})])assert.throws(()=>presenceIntent(op));
});
test('presence caps active sessions without evicting other users and expires stalled authorization',async()=>{
  const h=fixture({maxPerUser:1,maxEntries:2});await h.service.write('one',intent());await assert.rejects(h.service.write('one',intent(1,{sessionId:'other'})),{status:429});
  await h.service.write('two',intent());await assert.rejects(h.service.write('three',intent()),{status:429});
  let time=1000;const service=createPresenceService({now:()=>time,ttlMs:1000,authorize:async uid=>{time+=1001;return {uid,name:'Name',workspaceId:'main_workspace'};}});
  await assert.rejects(service.write('one',intent()),{code:'presence-expired'});
});
test('presence rechecks the reader after peer authorization before returning any selections',async()=>{
  let checks=0;const h=fixture({authorize:async uid=>{if(uid==='reader'&&++checks===2)throw Object.assign(Error('forbidden'),{status:403});return {uid,name:uid,workspaceId:'main_workspace'};}});
  await h.service.write('peer',intent());await assert.rejects(h.service.list('reader',{objectId:'site',sheetId:'one'}),{status:403});
});
test('PostgreSQL presence obeys sheet grants and immediately removes revoked peer selection',{skip:!process.env.TEST_DATABASE_URL},async()=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),prefix='presence_'+randomUUID().replaceAll('-',''),admin=prefix+'_admin',worker=prefix+'_worker',role=prefix+'_role',objectId=prefix;
  let created=false;
  const service=createPresenceService({authorize:(uid,target)=>authorizeTabelPresence(pool,uid,target)});
  const write=(key,data,before={revision:0,data:null})=>commitTabel(pool,admin,{id:randomUUID(),key,data,before});
  try{
    created=!!(await pool.query("INSERT INTO tabel_policy(workspace_id,enabled,import_sha256) VALUES ('main_workspace',true,'ci') ON CONFLICT DO NOTHING RETURNING workspace_id")).rowCount;
    for(const [uid,r] of [[admin,'admin'],[worker,role]])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'fixture@example.test','Server name',$2,'active')",[uid,r]);
    await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ($1,'tab_timesheet',true)",[role]);
    const base=await write(objectId+'/config',{sheetAccess:{one:{users:{[worker]:true}}}});
    await service.write(worker,intent(1,{objectId}));assert.equal((await service.list(admin,{objectId,sheetId:'one'})).peers.length,1);
    await assert.rejects(service.list(worker,{objectId,sheetId:'private'}),{status:403});
    await write(objectId+'/config',{sheetAccess:{}},base);
    assert.deepEqual((await service.list(admin,{objectId,sheetId:'one'})).peers,[]);
    await assert.rejects(service.write(worker,intent(2,{objectId})),{status:403});
    await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1",[worker]);await assert.rejects(authorizeTabelPresence(pool,worker,{objectId,sheetId:'one'}),{status:403});
  }finally{
    await pool.query('DELETE FROM tabel_receipts WHERE object_id=$1',[objectId]);await pool.query('DELETE FROM tabel_records WHERE object_id=$1',[objectId]);
    await pool.query('DELETE FROM role_permissions WHERE role=$1',[role]);await pool.query('DELETE FROM app_users WHERE uid IN ($1,$2)',[admin,worker]);if(created)await pool.query("DELETE FROM tabel_policy WHERE workspace_id='main_workspace'");await pool.end();
  }
});
