import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { applyFixtures, FIXTURE_IDS } from '../scripts/isolated-db/fixtures.mjs';
import { transformLegacyMigrationGuard } from '../scripts/isolated-db/legacy-guards.mjs';
import { verifyS24Target } from '../scripts/isolated-db/templates.mjs';

const allowed = ['import-schema','identity-empty','auth-schema-018','authority-main-ubuntu','authority-main-firebase','replica-admin','replica-empty-stream-cursors','parallel-shift-legacy-unresolved','parallel-shift-v2-night','parallel-shift-cutover-report','parallel-shift-restored-contexts','archive-immutable-revisions','restore-bootstrap-boundary','replica-pending-empty','replica-pending-out-of-order','full-exact-provenance-restore','parallel-shift-runtime-role'];
const TARGET_NAME = 'samosval_parallel_shifts_test_abcdef012345_0123456789ab';
const REGISTRY_TABLE = 'samosval_fixture_registry';
const REGISTRY_DDL = /^CREATE TABLE IF NOT EXISTS samosval_fixture_registry\b/i;
const REGISTRY_INSERT = /^INSERT INTO samosval_fixture_registry\b/i;

function missingTable(name) {
  return Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' });
}

// In-memory stand-in for one isolated target. It knows only the statements the
// fixtures issue and fails like PostgreSQL while the registry table is absent.
function targetDouble() {
  const journal = [];
  let registryExists = false;
  let inTransaction = false;
  let registryHash;
  let foreignKeyDeleteRule = 'a';
  let inventedIndexes = 0;
  const users = [];
  let authority = { workspace_id: 'main_workspace', provider: 'ubuntu', generation: '1', reason: 'initial', updated_by: 'system' };
  const query = async (text, values = []) => {
    const sql = String(text).trim();
    journal.push({ sql, values, inTransaction });
    if (/^SELECT current_database/i.test(sql)) return { rows: [{ database: TARGET_NAME }] };
    if (/^BEGIN/i.test(sql)) { inTransaction = true; return { rows: [] }; }
    if (/^(COMMIT|ROLLBACK)/i.test(sql)) { inTransaction = false; return { rows: [] }; }
    if (REGISTRY_DDL.test(sql)) { registryExists = true; return { rows: [] }; }
    if (sql.includes(REGISTRY_TABLE)) {
      if (!registryExists) throw missingTable(REGISTRY_TABLE);
      if (REGISTRY_INSERT.test(sql)) registryHash = values[1];
      return { rows: [{ imports: 0, documents: 0, hash: registryHash }] };
    }
    if (sql.includes('pg_constraint')) return { rows: [{ conname: 'migration_documents_import_sha256_fkey', delete_rule: foreignKeyDeleteRule, referenced: 'migration_imports' }] };
    if (sql.includes('pg_indexes')) return { rows: [{ n: inventedIndexes }] };
    if (sql.includes('FROM pg_class')) {
      return { rows: values[0].map(name => ({ relname: name, relkind: 'r', owner: 'samosval_test_prepared_owner', acl: '' })).sort((a, b) => a.relname.localeCompare(b.relname)) };
    }
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql)) return { rows: [] };
    if (/^UPDATE server_authority SET provider='(ubuntu|firebase)'/i.test(sql)) {
      authority = { ...authority, provider: RegExp.$1, generation: '1', reason: RegExp.$1 === 'firebase' ? 'fixture' : 'initial' };
      return { rows: [] };
    }
    if (/^INSERT INTO app_users/i.test(sql)) {
      users.push({ uid: values[0], email: values[1], display_name: values[2], role: 'admin', status: 'active' });
      return { rows: [] };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM server_authority')) return { rows: [authority] };
    if (sql.startsWith('SELECT') && sql.includes('FROM app_users')) return { rows: users.map(user => ({ ...user })) };
    throw new Error(`unexpected statement in target double: ${sql}`);
  };
  return { query, journal, setForeignKeyDeleteRule(rule) { foreignKeyDeleteRule = rule; }, setInventedIndexes(count) { inventedIndexes = count; } };
}

test('fixture registry owns concrete semantics and accepts only a low-level target query', async () => {
  assert.deepEqual(FIXTURE_IDS, allowed);
  const calls=[];
  const query=async(text,values=[])=>{
    calls.push([String(text),values]);
    if(String(text).includes('current_database'))return {rows:[{database:TARGET_NAME}]};
    return {rows:[]};
  };
  await assert.rejects(applyFixtures({query},['identity-empty']),/postcondition failed/i);
  assert.ok(calls.some(([sql])=>sql.includes('identity_state')),'registry verifier must issue its own domain query');
  await assert.rejects(applyFixtures({query,apply(){},verify(){}},['identity-empty']),/context is not approved/i);
  await assert.rejects(applyFixtures({query,adminUrl:'forbidden'},['identity-empty']),/context is not approved/i);
});

test('fixture registry rejects future IDs, duplicates and template/wrong targets', async()=>{
  const queryFor=database=>async sql=>String(sql).includes('current_database')?{rows:[{database}]}:{rows:[]};
  for(const id of ['parallel-shift-s26-future','unknown'])
    await assert.rejects(applyFixtures({query:queryFor(TARGET_NAME)},[id]),/unavailable/i);
  await assert.rejects(applyFixtures({query:queryFor(TARGET_NAME)},['import-schema','import-schema']),/duplicate/i);
  await assert.rejects(applyFixtures({query:queryFor('samosval_parallel_shifts_test_abcdef012345_tpl_s24')},['import-schema']),/target is not approved/i);
  await assert.rejects(applyFixtures({query:queryFor('other_database')},['import-schema']),/target is not approved/i);
});

test('fixture registry table is infrastructure-owned: any single fixture applies without import-schema', async () => {
  for (const id of ['authority-main-ubuntu', 'replica-admin']) {
    const target = targetDouble();
    const reports = await applyFixtures({ query: target.query }, [id]);
    assert.deepEqual(reports.map(report => report.id), [id]);
  }
});

test('fixture registry table is created lazily once, inside the first fixture transaction', async () => {
  const target = targetDouble();
  await applyFixtures({ query: target.query }, ['replica-admin', 'authority-main-ubuntu']);
  const creates = target.journal.filter(entry => REGISTRY_DDL.test(entry.sql));
  assert.equal(creates.length, 1, 'registry DDL must not be repeated per fixture');
  assert.equal(creates[0].inTransaction, true, 'registry DDL must share the first fixture transaction');
  const order = target.journal.map(entry => entry.sql);
  const firstInsert = order.findIndex(sql => REGISTRY_INSERT.test(sql));
  assert.ok(order.findIndex(sql => /^BEGIN/i.test(sql)) >= 0 && order.findIndex(sql => REGISTRY_DDL.test(sql)) < firstInsert, 'registry DDL precedes the first per-fixture registry insert');
  assert.equal(order.filter(sql => REGISTRY_INSERT.test(sql)).length, 2, 'each fixture keeps its own registry insert');
});

test('import-schema verifier rejects a foreign key whose delete rule is not NO ACTION', async () => {
  const accepted = targetDouble();
  await applyFixtures({ query: accepted.query }, ['import-schema']);
  const cascading = targetDouble();
  cascading.setForeignKeyDeleteRule('c');
  await assert.rejects(applyFixtures({ query: cascading.query }, ['import-schema']), /postcondition failed: import-schema/i);
  const indexed = targetDouble();
  indexed.setInventedIndexes(1);
  await assert.rejects(applyFixtures({ query: indexed.query }, ['import-schema']), /postcondition failed: import-schema/i);
});

const bootstrapUrl=process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
const OWNER='samosval_test_prepared_owner';

async function withFreshTargets(names, run) {
  const admin=new pg.Client({connectionString:bootstrapUrl});await admin.connect();
  const urls={};
  try{
    for(const name of names){
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 OWNER ${OWNER}`);
      const url=new URL(bootstrapUrl);url.pathname=`/${name}`;
      const pool=new pg.Pool({connectionString:url.href,max:1});
      await applyMigrations(pool,{through:24,transformSource:(source,filename)=>transformLegacyMigrationGuard(source,filename,name)});
      await pool.end();
      urls[name]=url;
    }
    return await run(urls, admin);
  }finally{
    for(const name of names)await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(()=>{});
    await admin.end();
  }
}
function connect(url){const client=new pg.Client({connectionString:url.href});return client.connect().then(()=>client);}
const fixturesOf=client=>({query:(text,values)=>client.query(text,values)});

test('all seven S24 concrete fixtures apply and independently verify on fresh disposable targets', {skip:!bootstrapUrl}, async()=>{
  const s24 = allowed.slice(0, 7);
  const names=['samosval_parallel_shifts_test_feedfacecafe_111111111111','samosval_parallel_shifts_test_feedfacecafe_222222222222'];
  await withFreshTargets(names, async urls=>{
    for(const name of names){
      const client=await connect(urls[name]);
      try{
        const reports=await applyFixtures(fixturesOf(client),['replica-empty-stream-cursors','authority-main-firebase','authority-main-ubuntu','replica-admin','auth-schema-018','identity-empty','import-schema']);
        assert.deepEqual(reports.map(x=>x.id),s24);
        assert.ok(reports.every(x=>Object.isFrozen(x)&&x.type==='samosval-fixture-report:v1'));
        await assert.rejects(applyFixtures(fixturesOf(client),['replica-admin']),/already applied|duplicate/i);
        await verifyS24Target((text,values)=>client.query(text,values));
        assert.equal((await client.query('SELECT count(*)::int n FROM migration_imports')).rows[0].n,0);
        assert.equal((await client.query("SELECT count(*)::int n FROM app_users WHERE uid<>'test-admin-replica'")).rows[0].n,0);
        assert.deepEqual((await client.query('SELECT provider,generation FROM server_authority WHERE workspace_id=$1',['main_workspace'])).rows,[{provider:'firebase',generation:'1'}]);
      }finally{await client.end();}
    }
  });
});

test('authority and replica fixtures apply standalone on a fresh S24 target without import-schema', {skip:!bootstrapUrl}, async()=>{
  const authorityName='samosval_parallel_shifts_test_feedfacecafe_aaaaaaaaaaaa';
  const replicaName='samosval_parallel_shifts_test_feedfacecafe_bbbbbbbbbbbb';
  await withFreshTargets([authorityName,replicaName], async urls=>{
    const authority=await connect(urls[authorityName]);
    try{
      const reports=await applyFixtures(fixturesOf(authority),['authority-main-ubuntu']);
      assert.deepEqual(reports.map(report=>report.id),['authority-main-ubuntu']);
      assert.deepEqual((await authority.query('SELECT provider,generation,reason,updated_by FROM server_authority WHERE workspace_id=$1',['main_workspace'])).rows,[{provider:'ubuntu',generation:'1',reason:'initial',updated_by:'system'}]);
      assert.equal((await authority.query("SELECT to_regclass('public.migration_imports')")).rows[0].to_regclass,null,'import-schema was not requested');
    }finally{await authority.end();}
    const replica=await connect(urls[replicaName]);
    try{
      const reports=await applyFixtures(fixturesOf(replica),['replica-empty-stream-cursors','replica-admin']);
      assert.deepEqual(reports.map(report=>report.id),['replica-admin','replica-empty-stream-cursors']);
      assert.deepEqual((await replica.query('SELECT uid,email FROM app_users')).rows,[{uid:'test-admin-replica',email:'replica@example.invalid'}]);
    }finally{await replica.end();}
    for(const [name, ids] of [[authorityName,['authority-main-ubuntu']],[replicaName,['replica-admin','replica-empty-stream-cursors']]]){
      const client=await connect(urls[name]);
      try{assert.deepEqual((await client.query('SELECT id FROM samosval_fixture_registry ORDER BY id')).rows.map(row=>row.id),[...ids].sort());}
      finally{await client.end();}
    }
  });
});

// Canonical consumer DDL (archive-store, seed-objects-db, archive-read, archive-parallel-restore, prepare-test-import).
const CONSUMER_IMPORT_DDL=[
  'CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY,workspace_id text NOT NULL,source_project text NOT NULL,exported_at bigint NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),counts jsonb NOT NULL)',
  'CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256),document_path text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(import_sha256,document_path))'
];

test('import-schema verifier rejects consumer-shaped tables whose foreign key cascades on delete', {skip:!bootstrapUrl}, async()=>{
  const name='samosval_parallel_shifts_test_feedfacecafe_cccccccccccc';
  await withFreshTargets([name], async urls=>{
    const client=await connect(urls[name]);
    try{
      // Canonical consumer shape except the FK delete rule: the only drift the
      // verifier can reject below is ON DELETE CASCADE (confdeltype).
      await client.query(CONSUMER_IMPORT_DDL[0]);
      await client.query(CONSUMER_IMPORT_DDL[1].replace('REFERENCES migration_imports(sha256)','REFERENCES migration_imports(sha256) ON DELETE CASCADE'));
      await assert.rejects(applyFixtures(fixturesOf(client),['import-schema']),/postcondition failed: import-schema/i);
      const registry=(await client.query("SELECT to_regclass('public.samosval_fixture_registry') IS NOT NULL present")).rows[0].present;
      if(registry)assert.equal((await client.query("SELECT count(*)::int n FROM samosval_fixture_registry WHERE id='import-schema'")).rows[0].n,0,'rejected fixture must not be recorded');
    }finally{await client.end();}
  });
});

test('import-schema creates exactly the consumer schema: NO ACTION foreign key, primary keys, no invented index', {skip:!bootstrapUrl}, async()=>{
  const name='samosval_parallel_shifts_test_feedfacecafe_dddddddddddd';
  await withFreshTargets([name], async urls=>{
    const client=await connect(urls[name]);
    try{
      await applyFixtures(fixturesOf(client),['import-schema']);
      assert.deepEqual((await client.query(`SELECT con.conname,con.confdeltype::text delete_rule,con.confrelid::regclass::text referenced FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace WHERE n.nspname='public' AND con.contype='f' AND con.conrelid='public.migration_documents'::regclass`)).rows,[{conname:'migration_documents_import_sha256_fkey',delete_rule:'a',referenced:'migration_imports'}]);
      assert.deepEqual((await client.query(`SELECT c.relname,c.relkind,(SELECT count(*)::int FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary) primary_keys FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('migration_imports','migration_documents') ORDER BY c.relname`)).rows,[{relname:'migration_documents',relkind:'r',primary_keys:1},{relname:'migration_imports',relkind:'r',primary_keys:1}]);
      assert.equal((await client.query(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public' AND tablename IN ('migration_imports','migration_documents') AND indexname NOT IN ('migration_imports_pkey','migration_documents_pkey')`)).rows[0].n,0,'no index beyond the canonical primary keys');
    }finally{await client.end();}
  });
});
