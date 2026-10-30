import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {registerPending,readSession,readAdministration,identityOperation,readMembers} from '../src/identity-store.mjs';
import {submitLineOperation} from '../src/line-store.mjs';
test('PostgreSQL identity lifecycle validates verified UID, decisions, admin protection and revocations',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),prefix='ident_'+randomUUID().replaceAll('-','');
  const owner=prefix+'_owner',second=prefix+'_second',worker=prefix+'_worker',applicant=prefix+'_applicant',rejected=prefix+'_rejected',legacy=prefix+'_legacy';
  const ids=[owner,second,worker,applicant,rejected,legacy];let sequence=0,ready=false,state,oldPerms,oldVersion;
  const send=(type,data,actor=owner)=>identityOperation(pool,actor,{id:prefix+'_'+(++sequence),type,...data});
  const current=async uid=>(await readSession(pool,uid)).profile;
  try{
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n,0,'isolated empty CI identity database required; never run against NAS data');
    state=(await pool.query('SELECT initialized,owner_uid,import_sha256 FROM identity_state WHERE id=1')).rows[0];
    oldPerms=(await pool.query("SELECT action,allowed FROM role_permissions WHERE role='viewer'")).rows;
    oldVersion=(await pool.query("SELECT revision FROM role_permission_versions WHERE role='viewer'")).rows[0];ready=true;
    for(const [uid,role,protectedFlag] of [[owner,'admin',true],[second,'admin',false],[worker,'viewer',false]])await pool.query("INSERT INTO app_users(uid,email,display_name,role,status,protected,profile) VALUES ($1,$2,$1,$3,'active',$4,$5)",[uid,uid+'@example.test',role,protectedFlag,{privateImportField:'not-for-session'}]);
    await pool.query('UPDATE identity_state SET initialized=true,owner_uid=$1 WHERE id=1',[owner]);
    await t.test('unknown and pending accounts receive no permissions; registration ignores body UID and role',async()=>{
      assert.equal((await readSession(pool,'unknown')).profile,null);
      const identity={uid:applicant,email:'applicant@example.test'};
      const results=await Promise.all([registerPending(pool,identity,{uid:owner,role:'admin',status:'active',nickname:'First'}),registerPending(pool,identity,{nickname:'Second'})]);
      assert.equal(results.filter(r=>r.created).length,1);assert.equal(results[0].profile.uid,applicant);assert.equal(results[0].profile.role,'viewer');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM registration_requests WHERE uid=$1',[applicant])).rows[0].n,1);
      const session=await readSession(pool,applicant);assert.equal(session.profile.status,'pending');assert.deepEqual(session.permissions,{tabs:[],actions:[]});
      await assert.rejects(readAdministration(pool,applicant),{code:'forbidden'});await assert.rejects(readMembers(pool,applicant),{code:'forbidden'});
    });
    await t.test('two admins deciding the same request produce one decision and stable replay',async()=>{
      const ops=['viewer','master'].map((role,i)=>({id:prefix+'_decide_'+i,type:'registration.approve',uid:applicant,expectedRevision:1,expectedProfileRevision:1,role}));
      const actors=[owner,second],results=await Promise.allSettled(ops.map((op,i)=>identityOperation(pool,actors[i],op)));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
      const index=results.findIndex(r=>r.status==='fulfilled'),saved=results[index].value;
      assert.equal(saved.result.status,'active');assert.equal(saved.result.revision,2);
      const replay=await identityOperation(pool,actors[index],ops[index]);assert.equal(replay.replayed,true);assert.deepEqual(replay.result,saved.result);
      await assert.rejects(identityOperation(pool,actors[index],{...ops[index],role:'admin'}),{code:'operation-id-reused'});
      await assert.rejects(identityOperation(pool,actors[1-index],ops[index]),{code:'operation-id-reused'});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM registration_requests WHERE uid=$1',[applicant])).rows[0].n,0);
    });
    await t.test('admin views omit arbitrary private fields; non-admin cannot grant itself rights',async()=>{
      const snapshot=await readAdministration(pool,owner);assert.equal(JSON.stringify(snapshot).includes('not-for-session'),false);
      assert.equal(JSON.stringify(await readSession(pool,owner)).includes('not-for-session'),false);
      await assert.rejects(send('user.role',{uid:worker,expectedRevision:1,role:'admin'},worker),{code:'forbidden'});
      const version=Number((await pool.query("SELECT revision FROM role_permission_versions WHERE role='viewer'")).rows[0].revision);
      await assert.rejects(send('permissions.replace',{role:'viewer',expectedRevision:version,permissions:{tabs:['line'],actions:['action_load']}},worker),{code:'forbidden'});
    });
    await t.test('permissions edits are revision guarded; denied/unknown old grants are revoked',async()=>{
      await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ('viewer','tab_admin',true),('viewer','unknown_old_grant',true) ON CONFLICT(role,action) DO UPDATE SET allowed=true");
      const revision=Number((await pool.query("SELECT revision FROM role_permission_versions WHERE role='viewer'")).rows[0].revision);
      const variants=[{tabs:['line'],actions:['action_load']},{tabs:['report'],actions:[]}];
      const results=await Promise.allSettled(variants.map(permissions=>send('permissions.replace',{role:'viewer',expectedRevision:revision,permissions})));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'permissions-changed');
      const session=await readSession(pool,worker);assert.equal(session.permissions.tabs.includes('admin'),false);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM role_permissions WHERE role='viewer' AND action IN ('tab_admin','unknown_old_grant') AND allowed=true")).rows[0].n,0);
    });
    await t.test('parallel nickname changes cannot overwrite one observed profile revision',async()=>{
      const results=await Promise.allSettled(['One','Two'].map(nickname=>send('user.nickname',{uid:worker,expectedRevision:1,nickname})));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'profile-changed');
      assert.equal((await current(worker)).revision,2);
    });
    await t.test('owner and self access cannot be removed; owner nickname remains editable',async()=>{
      for(const [type,data] of [['user.delete',{}],['user.access',{enabled:false}],['user.role',{role:'viewer'}]])await assert.rejects(send(type,{uid:owner,expectedRevision:1,...data},second),{code:'protected-owner'});
      await assert.rejects(send('user.access',{uid:second,expectedRevision:1,enabled:false},second),{code:'self-access-change'});
      await assert.rejects(send('user.role',{uid:second,expectedRevision:1,role:'viewer'},second),{code:'self-access-change'});
      await send('user.nickname',{uid:owner,expectedRevision:1,nickname:'Owner'});assert.equal((await current(owner)).protected,true);
    });
    await t.test('disable blocks future writes while old identity token remains otherwise valid',async()=>{
      await send('user.access',{uid:applicant,expectedRevision:2,enabled:false});
      const session=await readSession(pool,applicant);assert.equal(session.profile.status,'disabled');assert.deepEqual(session.permissions,{tabs:[],actions:[]});
      await assert.rejects(registerPending(pool,{uid:applicant,email:'applicant@example.test'},{}),{code:'account-disabled'});
      await assert.rejects(submitLineOperation(pool,applicant,{id:prefix+'_blocked_load',type:'arrive',shiftId:'s',truckId:'t',createdAt:Date.now(),expectedRevision:0,expectedTtnRevision:0,arrivalTimestamp:0,lastLoadTimestamp:0,wantArrived:true,collect:false,cycleMinutes:15}),{code:'forbidden'});
    });
    await t.test('soft-deleted access cannot re-register; explicit restore stays disabled until enabled',async()=>{
      await send('user.delete',{uid:worker,expectedRevision:2});assert.equal((await current(worker)).deleted,true);
      await assert.rejects(registerPending(pool,{uid:worker,email:'worker@example.test'},{role:'admin'}),{code:'account-disabled'});
      const snapshot=await readAdministration(pool,owner);assert.equal(snapshot.users.some(u=>u.uid===worker),false);assert.equal(snapshot.deletedUsers.some(u=>u.uid===worker),true);
      await send('user.restore',{uid:worker,expectedRevision:3});assert.equal((await current(worker)).status,'disabled');
      await send('user.access',{uid:worker,expectedRevision:4,enabled:true});assert.equal((await current(worker)).status,'active');
    });
    await t.test('rejection is atomic and cannot be bypassed through the access toggle while pending',async()=>{
      await registerPending(pool,{uid:rejected,email:'rejected@example.test'},{});
      await assert.rejects(send('user.access',{uid:rejected,expectedRevision:1,enabled:true}),{code:'pending-requires-decision'});
      await send('registration.reject',{uid:rejected,expectedRevision:1,expectedProfileRevision:1,reason:'Fixture decision'});
      assert.equal((await current(rejected)).rejectionReason,'Fixture decision');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM registration_requests WHERE uid=$1',[rejected])).rows[0].n,0);
    });
    await t.test('legacy pending profile without request is visible and can be decided with revision zero',async()=>{
      await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'legacy@example.test','Legacy','viewer','pending')",[legacy]);
      const snapshot=await readAdministration(pool,owner);assert.equal(snapshot.requests.find(r=>r.uid===legacy).revision,0);
      await send('registration.approve',{uid:legacy,expectedRevision:0,expectedProfileRevision:1,role:'viewer'});
      assert.equal((await current(legacy)).status,'active');
      const members=await readMembers(pool,worker);assert.equal(members.members.some(r=>r.uid===legacy),true);assert.equal(JSON.stringify(members).includes('privateImportField'),false);
    });
    await t.test('revoked admin cannot replay its earlier successful operation',async()=>{
      const op={id:prefix+'_before_revoke',type:'user.nickname',uid:worker,expectedRevision:5,nickname:'Final'};
      await identityOperation(pool,second,op);
      await send('user.access',{uid:second,expectedRevision:1,enabled:false});
      await assert.rejects(identityOperation(pool,second,op),{code:'forbidden'});
      await assert.rejects(readAdministration(pool,second),{code:'forbidden'});
      assert.equal((await current(owner)).status,'active');
    });
  }finally{
    if(ready){
      await pool.query('UPDATE identity_state SET initialized=$1,owner_uid=$2,import_sha256=$3 WHERE id=1',[state.initialized,state.owner_uid,state.import_sha256]);
      for(const table of ['registration_requests','identity_receipts','identity_audit'])await pool.query(`DELETE FROM ${table} WHERE uid=ANY($1::text[])`,[ids]);
      await pool.query('DELETE FROM app_users WHERE uid=ANY($1::text[])',[ids]);
      await pool.query("DELETE FROM role_permissions WHERE role='viewer'");
      for(const row of oldPerms)await pool.query("INSERT INTO role_permissions(role,action,allowed) VALUES ('viewer',$1,$2)",[row.action,row.allowed]);
      await pool.query("UPDATE role_permission_versions SET revision=$1 WHERE role='viewer'",[oldVersion.revision]);
    }
    await pool.end();
  }
});
