import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {seedIdentity} from '../src/seed-identity.mjs';
test('identity seed requires explicit inspected checksum before database access',async()=>{
  await assert.rejects(seedIdentity(null,{}),{code:'inspected-test-import-required'});
});
test('PostgreSQL identity promotion verifies import and owner without replacing profiles',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),sha=randomBytes(32).toString('hex'),prefix='seedid_'+sha.slice(0,20),owner=prefix+'_owner',pending=prefix+'_pending',second=prefix+'_second',ids=[owner,pending,second];let ready=false,state;
  const profile=(uid,role,status)=>({email:uid+'@example.test',nickname:uid,role,status,gameBalance:321});
  const add=async(uid,role,status)=>{const data=profile(uid,role,status);await pool.query('INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$1,$3,$4)',[uid,data.email,role,status]);await pool.query('INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES ($1,$2,$3)',[sha,'users/'+uid,data]);};
  try{
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n,0,'isolated empty CI database required');
    state=(await pool.query('SELECT initialized,owner_uid,import_sha256 FROM identity_state WHERE id=1')).rows[0];ready=true;
    await pool.query('CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY,workspace_id text NOT NULL,source_project text NOT NULL,exported_at bigint NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),counts jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256),document_path text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(import_sha256,document_path))');
    await pool.query("INSERT INTO migration_imports(sha256,workspace_id,source_project,exported_at,counts) VALUES ($1,'main_workspace','samosval-offline',1,'{\"users\":2,\"registrationRequests\":1}')",[sha]);
    await add(owner,'admin','active');await add(pending,'viewer','pending');
    await pool.query('INSERT INTO migration_documents(import_sha256,document_path,payload) VALUES ($1,$2,$3)',[sha,'registration_requests/legacy',{email:pending+'@example.test',nickname:'Legacy'}]);
    await t.test('wrong import/count/profile never partially changes target users',async()=>{
      await assert.rejects(seedIdentity(pool,{sha256:'0'.repeat(64)}),{code:'wrong-import-source'});
      await pool.query("UPDATE migration_imports SET counts=counts||'{\"users\":3}' WHERE sha256=$1",[sha]);
      await assert.rejects(seedIdentity(pool,{sha256:sha}),{code:'identity-count-mismatch'});
      await pool.query("UPDATE migration_imports SET counts=counts||'{\"users\":2}' WHERE sha256=$1",[sha]);
      await pool.query("UPDATE app_users SET display_name='Changed' WHERE uid=$1",[pending]);
      await assert.rejects(seedIdentity(pool,{sha256:sha}),{code:'identity-source-mismatch'});
      await pool.query('UPDATE app_users SET display_name=uid WHERE uid=$1',[pending]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_users WHERE protected=true OR profile<>\'{}\'::jsonb')).rows[0].n,0);
    });
    await t.test('explicit mismatched request UID cannot be reassigned by matching its email',async()=>{
      await pool.query("UPDATE migration_documents SET payload=payload||'{\"uid\":\"missing\"}' WHERE import_sha256=$1 AND document_path='registration_requests/legacy'",[sha]);
      await assert.rejects(seedIdentity(pool,{sha256:sha}),{code:'unresolved-registration-request'});
      await pool.query("UPDATE migration_documents SET payload=payload-'uid' WHERE import_sha256=$1 AND document_path='registration_requests/legacy'",[sha]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_users WHERE protected=true')).rows[0].n,0);
    });
    await t.test('multiple admins require a selected existing admin UID',async()=>{
      await add(second,'admin','active');await pool.query("UPDATE migration_imports SET counts=counts||'{\"users\":3}' WHERE sha256=$1",[sha]);
      await assert.rejects(seedIdentity(pool,{sha256:sha}),{code:'explicit-owner-required'});
      await assert.rejects(seedIdentity(pool,{sha256:sha,ownerUid:pending}),{code:'explicit-owner-required'});
    });
    await t.test('promotion retains unknown profile fields and resolves legacy pending request once',async()=>{
      const result=await seedIdentity(pool,{sha256:sha,ownerUid:owner});assert.equal(result.users,3);assert.equal(result.requests,1);assert.equal(result.ownerProtected,true);
      const users=(await pool.query('SELECT uid,profile,protected FROM app_users ORDER BY uid')).rows;
      assert.equal(users.filter(u=>u.protected).length,1);assert.equal(users.find(u=>u.uid===owner).protected,true);assert.equal(users.find(u=>u.uid===pending).profile.gameBalance,321);
      const request=(await pool.query('SELECT uid,payload FROM registration_requests')).rows[0];assert.equal(request.uid,pending);assert.equal(request.payload.legacyRequestId,'legacy');
      await assert.rejects(seedIdentity(pool,{sha256:sha,ownerUid:second}),{code:'identity-already-initialized'});
    });
  }finally{
    if(ready){
      await pool.query('UPDATE identity_state SET initialized=$1,owner_uid=$2,import_sha256=$3 WHERE id=1',[state.initialized,state.owner_uid,state.import_sha256]);
      await pool.query('DELETE FROM registration_requests WHERE uid=ANY($1::text[])',[ids]);await pool.query('DELETE FROM app_users WHERE uid=ANY($1::text[])',[ids]);
      await pool.query('DELETE FROM migration_documents WHERE import_sha256=$1',[sha]);await pool.query('DELETE FROM migration_imports WHERE sha256=$1',[sha]);
    }
    await pool.end();
  }
});
