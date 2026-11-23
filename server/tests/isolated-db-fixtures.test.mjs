import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { applyFixtures, FIXTURE_IDS } from '../scripts/isolated-db/fixtures.mjs';
import { transformLegacyMigrationGuard } from '../scripts/isolated-db/legacy-guards.mjs';
import { verifyS24Target, verifyTargetAuthority } from '../scripts/isolated-db/templates.mjs';

const allowed = ['import-schema','identity-empty','auth-schema-018','authority-main-ubuntu','authority-main-firebase','replica-admin','replica-empty-stream-cursors'];

test('fixture registry owns concrete semantics and accepts only a low-level target query', async () => {
  assert.deepEqual(FIXTURE_IDS, allowed);
  const calls=[];
  const query=async(text,values=[])=>{
    calls.push([String(text),values]);
    if(String(text).includes('current_database'))return {rows:[{database:'samosval_parallel_shifts_test_abcdef012345_0123456789ab'}]};
    return {rows:[]};
  };
  await assert.rejects(applyFixtures({query},['identity-empty']),/postcondition failed/i);
  assert.ok(calls.some(([sql])=>sql.includes('identity_state')),'registry verifier must issue its own domain query');
  await assert.rejects(applyFixtures({query,apply(){},verify(){}},['identity-empty']),/context is not approved/i);
  await assert.rejects(applyFixtures({query,adminUrl:'forbidden'},['identity-empty']),/context is not approved/i);
});

test('fixture registry rejects future IDs, duplicates and template/wrong targets', async()=>{
  const queryFor=database=>async sql=>String(sql).includes('current_database')?{rows:[{database}]}:{rows:[]};
  for(const id of ['parallel-shift-legacy-unresolved','replica-pending-empty','unknown'])
    await assert.rejects(applyFixtures({query:queryFor('samosval_parallel_shifts_test_abcdef012345_0123456789ab')},[id]),/unavailable/i);
  await assert.rejects(applyFixtures({query:queryFor('samosval_parallel_shifts_test_abcdef012345_0123456789ab')},['import-schema','import-schema']),/duplicate/i);
  await assert.rejects(applyFixtures({query:queryFor('samosval_parallel_shifts_test_abcdef012345_tpl_s24')},['import-schema']),/target is not approved/i);
  await assert.rejects(applyFixtures({query:queryFor('other_database')},['import-schema']),/target is not approved/i);
});

const bootstrapUrl=process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;

test('all seven concrete fixtures apply and independently verify on fresh disposable targets', {skip:!bootstrapUrl}, async()=>{
  const admin=new pg.Client({connectionString:bootstrapUrl});await admin.connect();
  const names=['samosval_parallel_shifts_test_feedfacecafe_111111111111','samosval_parallel_shifts_test_feedfacecafe_222222222222'];
  try{
    for(const name of names){
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 OWNER samosval_test_prepared_owner`);
      const url=new URL(bootstrapUrl);url.pathname=`/${name}`;
      const pool=new pg.Pool({connectionString:url.href,max:1});
      await applyMigrations(pool,{through:24,transformSource:(source,filename)=>transformLegacyMigrationGuard(source,filename,name)});
      await pool.end();
      const client=new pg.Client({connectionString:url.href});await client.connect();
      try{
        const reports=await applyFixtures({query:(text,values)=>client.query(text,values)},['replica-empty-stream-cursors','authority-main-firebase','authority-main-ubuntu','replica-admin','auth-schema-018','identity-empty','import-schema']);
        assert.deepEqual(reports.map(x=>x.id),allowed);
        assert.ok(reports.every(x=>Object.isFrozen(x)&&x.type==='samosval-fixture-report:v1'));
        await assert.rejects(applyFixtures({query:(text,values)=>client.query(text,values)},['replica-admin']),/already applied|duplicate/i);
        await verifyS24Target((text,values)=>client.query(text,values));
        assert.equal((await client.query('SELECT count(*)::int n FROM migration_imports')).rows[0].n,0);
        assert.equal((await client.query("SELECT count(*)::int n FROM app_users WHERE uid<>'test-admin-replica'")).rows[0].n,0);
        assert.deepEqual((await client.query('SELECT provider,generation FROM server_authority WHERE workspace_id=$1',['main_workspace'])).rows,[{provider:'firebase',generation:'1'}]);
      }finally{await client.end();}
    }
  }finally{for(const name of names)await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(()=>{});await admin.end();}
});
