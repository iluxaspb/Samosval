import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { spawnSync } from 'node:child_process';

import {
  GENERATED_DATABASE_PREFIX,
  validateAdminUrl,
  validateGeneratedIdentifier,
  quoteIdentifier,
} from '../scripts/isolated-db/safety.mjs';
import { adminPreflight, createProvisioningBroker, generateRunCapability, runAdminStatement } from '../scripts/isolated-db/admin.mjs';

const { Client } = pg;
const runid = '0123456789ab';
const target = `${GENERATED_DATABASE_PREFIX}${runid}_0123456789ab`;

function adminUrl(path = 'postgres') {
  return `postgresql://orchestrator:secret@127.0.0.1:55432/${path}`;
}

test('admin URL accepts only an explicit approved PostgreSQL maintenance endpoint', () => {
  assert.equal(validateAdminUrl(adminUrl()).pathname, '/postgres');
  assert.equal(validateAdminUrl('postgres://orchestrator:secret@[::1]:55432/postgres').hostname, '[::1]');
  assert.equal(validateAdminUrl('postgresql://orchestrator:secret@postgres:5432/postgres').port, '5432');
  for (const value of [
    'https://orchestrator:secret@127.0.0.1:55432/postgres',
    adminUrl('template1'),
    'postgresql://orchestrator:secret@db.example:55432/postgres',
    'postgresql://orchestrator:secret@127.0.0.1/postgres',
    'postgresql://orchestrator:secret@127.0.0.1:5432/postgres',
    'postgresql://orchestrator:secret@127.0.0.1:55433/postgres',
    'postgresql://orchestrator:secret@127.0.0.1:%35%35%34%33%32/postgres',
    `${adminUrl()}?sslmode=require`,
    `${adminUrl()}#fragment`,
    'postgresql://orchestrator:secret@127.0.0.1:55432/postgres/extra',
  ]) assert.throws(() => validateAdminUrl(value), /admin URL is not approved/i);
});

test('generated identifiers are exact bounded ASCII names and reserved names fail closed', () => {
  assert.equal(validateGeneratedIdentifier(target, { runid, kind: 'target' }), target);
  assert.equal(validateGeneratedIdentifier('a'.repeat(63)), 'a'.repeat(63));
  assert.throws(() => validateGeneratedIdentifier('a'.repeat(64)), /generated identifier is not approved/i);
  for (const value of [
    'samosval_test', 'samosval_working_test_reserve', 'samosval_parallel_shifts_test',
    'postgres', 'template0', 'template1', `${target}x`, target.toUpperCase(),
    `${GENERATED_DATABASE_PREFIX}ffffffffffff_0123456789ab`,
    `${GENERATED_DATABASE_PREFIX}${runid}_0123456789aé`,
  ]) assert.throws(() => validateGeneratedIdentifier(value, { runid, kind: 'target' }), /generated identifier is not approved/i);
  assert.throws(() => validateGeneratedIdentifier(target, { runid: 'short', kind: 'target' }), /generated identifier is not approved/i);
  const maxRunid = 'a'.repeat(20);
  const maxTarget = `${GENERATED_DATABASE_PREFIX}${maxRunid}_0123456789ab`;
  assert.equal(Buffer.byteLength(maxTarget), 63);
  assert.equal(validateGeneratedIdentifier(maxTarget, { runid: maxRunid, kind: 'target' }), maxTarget);
  const oversizedRunid = 'a'.repeat(21);
  assert.throws(() => validateGeneratedIdentifier(`${GENERATED_DATABASE_PREFIX}${oversizedRunid}_0123456789ab`, { runid: oversizedRunid, kind: 'target' }), /generated identifier is not approved/i);
});

test('identifier quoting is explicit and never accepts arbitrary SQL identifiers', () => {
  assert.equal(quoteIdentifier(target), `"${target}"`);
  assert.throws(() => quoteIdentifier('target"; DROP DATABASE postgres; --'), /identifier is not approved/i);
});

test('run capabilities are independent cryptographic-format values and never use process transport', () => {
  const first = generateRunCapability();
  const second = generateRunCapability();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(process.argv.includes(first), false);
  assert.equal(Object.values(process.env).includes(first), false);
});

test('admin statements require capability while marker excludes capability material', async () => {
  const calls = [];
  const capability = generateRunCapability();
  const marker = 'samosval-isolated-db:v1;kind=target;runid=0123456789ab;hash=0123456789ab;owner=samosval_test_prepared_owner';
  const client = { query: async (text, values) => { calls.push([text, values]); return { rows: [{ comment: marker }] }; } };
  await runAdminStatement(client, { operation: 'commentDatabase', database: target, runid, capability, kind: 'target' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [target, capability]);
  assert.doesNotMatch(marker, new RegExp(capability));
  await assert.rejects(runAdminStatement(client, { operation: 'commentDatabase', database: target, runid, kind: 'target' }), /admin operation is not approved/i);
  await assert.rejects(runAdminStatement(client, { operation: 'commentDatabase', database: target, runid, capability, kind: 'target', comment: 'caller supplied' }), /admin operation is not approved/i);
  await assert.rejects(runAdminStatement(client, { operation: 'sql', sql: 'DROP DATABASE postgres' }), /admin operation is not approved/i);
  const leakingClient = { query: async () => { throw new Error(`driver leaked ${capability}`); } };
  await assert.rejects(runAdminStatement(leakingClient, { operation: 'commentDatabase', database: target, runid, capability, kind: 'target' }), error => {
    assert.equal(error.message, 'admin operation failed closed');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(capability));
    return true;
  });
});

test('closed provisioning broker exposes enum operations and redacts credentials', async () => {
  const capability = generateRunCapability();
  const calls = [];
  const adminClient = { query: async (config, values) => { calls.push([config, values]); if (String(config.text ?? config).includes('mark_reserved_target')) return { rows: [{ comment: `samosval-isolated-db:v1;kind=target;runid=${runid};hash=0123456789ab;owner=samosval_test_prepared_owner` }] }; return { rows: [] }; } };
  const bootstrapClient = { query: async config => { calls.push([config]); return { rows: [] }; } };
  const broker = createProvisioningBroker({ adminClient, bootstrapClient });
  await broker.run({ operation: 'createReservedTarget', database: target, runid, capability });
  await broker.run({ operation: 'dropReservedTarget', database: target, runid, capability });
  assert.equal(calls.some(([config]) => String(config.text ?? config).startsWith('CREATE DATABASE')), true);
  assert.equal(calls.some(([config]) => String(config.text ?? config).startsWith('ALTER DATABASE')), true);
  assert.equal(calls.some(([config]) => String(config.text ?? config).startsWith('DROP DATABASE')), true);
  assert.doesNotMatch(JSON.stringify(calls.map(([config]) => String(config.text ?? config))), new RegExp(capability));
  await assert.rejects(broker.run({ operation: 'sql', sql: 'CREATE DATABASE postgres' }), /provisioning operation is not approved/i);
});

test('admin preflight rejects a catalog endpoint fingerprint mismatch', async () => {
  const client = { query: async () => ({ rows: [{ database: 'postgres', role: 'samosval_test_orchestrator', version_num: 160000, marker: 'samosval-isolated-db-bootstrap:v1', address: '127.0.0.1', port: 55433 }] }) };
  await assert.rejects(adminPreflight(client, adminUrl(), { expectedRole: 'samosval_test_orchestrator' }), /preflight failed closed/i);
});

const realAdminUrl = process.env.SAMOSVAL_TEST_ADMIN_URL;
const bootstrapAdminUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;

async function role(url, sql, values = []) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await client.query(sql, values); } finally { await client.end(); }
}

function connectionDenied(url) {
  const internal = new URL(url); internal.hostname = '127.0.0.1'; internal.port = '5432';
  const result = spawnSync('docker-compose', ['-f', 'compose.test.yaml', 'exec', '-T', 'postgres', 'psql', '--no-psqlrc', internal.href, '-c', 'SELECT 1'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: process.env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /permission denied for database "postgres"/i);
}

const capabilities = { a: generateRunCapability(), b: generateRunCapability(), c: generateRunCapability() };

function rerunBootstrap() {
  const result = spawnSync('docker-compose', ['-f', 'compose.test.yaml', 'exec', '-T', 'postgres', '/docker-entrypoint-initdb.d/10-isolated-db-bootstrap.sh'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
}

async function prepareTarget(broker, name, run, capability) {
  await broker.run({ operation: 'createReservedTarget', database: name, runid: run, capability });
}

function targetUrl(name, roleName, password) {
  const url = new URL(bootstrapAdminUrl); url.pathname = `/${name}`; url.username = roleName; url.password = password; return url.href;
}

test('compose bootstrap has closed roles, registry and function ACL surface', { skip: !realAdminUrl || !bootstrapAdminUrl }, async () => {
  const preflightClient = new Client({ connectionString: realAdminUrl }); await preflightClient.connect();
  try {
    const endpoint = await preflightClient.query('SELECT inet_server_addr()::text AS address');
    assert.equal((await adminPreflight(preflightClient, realAdminUrl, { expectedServerAddress: endpoint.rows[0].address })).serverMajor, 16);
  } finally { await preflightClient.end(); }
  for (const [name, password] of [['samosval_test_app', process.env.SAMOSVAL_TEST_APP_PASSWORD], ['samosval_test_runtime', process.env.SAMOSVAL_TEST_RUNTIME_PASSWORD]]) {
    const url = new URL(bootstrapAdminUrl); url.username = name; url.password = password; connectionDenied(url.href);
  }
  const roles = await role(bootstrapAdminUrl, `SELECT rolname, rolcanlogin, rolinherit, rolcreatedb, rolcreaterole, rolsuper, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`, [['samosval_test_app','samosval_test_orchestrator','samosval_test_prepared_owner','samosval_test_runtime']]);
  assert.deepEqual(roles.rows, [
    { rolname:'samosval_test_app',rolcanlogin:true,rolinherit:false,rolcreatedb:false,rolcreaterole:false,rolsuper:false,rolreplication:false,rolbypassrls:false },
    { rolname:'samosval_test_orchestrator',rolcanlogin:true,rolinherit:false,rolcreatedb:true,rolcreaterole:false,rolsuper:false,rolreplication:false,rolbypassrls:false },
    { rolname:'samosval_test_prepared_owner',rolcanlogin:false,rolinherit:false,rolcreatedb:false,rolcreaterole:false,rolsuper:false,rolreplication:false,rolbypassrls:false },
    { rolname:'samosval_test_runtime',rolcanlogin:true,rolinherit:false,rolcreatedb:false,rolcreaterole:false,rolsuper:false,rolreplication:false,rolbypassrls:false },
  ]);
  assert.equal((await role(bootstrapAdminUrl, `SELECT count(*)::int AS count FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname LIKE 'samosval_test_%')`)).rows[0].count, 0);
  const logging = await role(realAdminUrl, `SHOW log_parameter_max_length; SHOW log_parameter_max_length_on_error`);
  assert.deepEqual(logging.map(result => Object.values(result.rows[0])[0]), ['0', '0']);
  const acl = await role(bootstrapAdminUrl, `SELECT has_schema_privilege('samosval_test_orchestrator','samosval_isolated_admin','USAGE') AS orch_schema, has_table_privilege('samosval_test_orchestrator','samosval_isolated_admin.target_receipts','SELECT') AS orch_registry, has_table_privilege('samosval_test_app','samosval_isolated_admin.target_receipts','SELECT') AS app_registry, has_table_privilege('public','samosval_isolated_admin.target_receipts','SELECT') AS public_registry`);
  assert.deepEqual(acl.rows[0], { orch_schema:true, orch_registry:false, app_registry:false, public_registry:false });
  const functions = await role(bootstrapAdminUrl, `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.proowner::regrole::text AS owner, has_function_privilege('samosval_test_orchestrator',p.oid,'EXECUTE') AS orch, has_function_privilege('samosval_test_app',p.oid,'EXECUTE') AS app, has_function_privilege('public',p.oid,'EXECUTE') AS public FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='samosval_isolated_admin' ORDER BY 1,2`);
  assert.deepEqual(functions.rows.map(r => [r.proname,r.args,r.owner,r.orch,r.app,r.public]), [
    ['authorize_drop_target','target_name text, capability text','samosval_test_bootstrap_admin',true,false,false],
    ['mark_reserved_target','target_name text, capability text','samosval_test_bootstrap_admin',true,false,false],
    ['reserve_target','target_name text, runid text, capability text','samosval_test_bootstrap_admin',true,false,false],
    ['terminate_exact_target','target_name text, capability text','samosval_test_bootstrap_admin',true,false,false],
  ]);
});

test('bootstrap rerun restores mutated roles, membership, ownership, ACL and function allowlist', { skip: !bootstrapAdminUrl }, async () => {
  await role(bootstrapAdminUrl, `CREATE ROLE samosval_i2_external_a; CREATE ROLE samosval_i2_external_b; CREATE ROLE samosval_i2_external_c; GRANT samosval_test_prepared_owner TO samosval_i2_external_a; GRANT samosval_i2_external_b TO samosval_i2_external_c; ALTER ROLE samosval_test_app INHERIT CREATEDB; GRANT samosval_test_prepared_owner TO samosval_test_app; GRANT SELECT ON samosval_isolated_admin.target_receipts TO samosval_test_orchestrator; GRANT USAGE ON SCHEMA samosval_isolated_admin TO PUBLIC; ALTER FUNCTION samosval_isolated_admin.terminate_exact_target(text,text) OWNER TO samosval_test_app; CREATE FUNCTION samosval_isolated_admin.terminate_exact_target(text) RETURNS integer LANGUAGE sql AS 'SELECT 0'; GRANT EXECUTE ON FUNCTION samosval_isolated_admin.terminate_exact_target(text) TO PUBLIC`);
  rerunBootstrap(); rerunBootstrap();
  const restored = await role(bootstrapAdminUrl, `SELECT rolinherit, rolcreatedb FROM pg_roles WHERE rolname='samosval_test_app'; SELECT 1`);
  assert.deepEqual(restored[0].rows[0], { rolinherit:false, rolcreatedb:false });
  assert.equal((await role(bootstrapAdminUrl, `SELECT count(*)::int AS count FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE granted.rolname LIKE 'samosval_test_%' OR member.rolname LIKE 'samosval_test_%'`)).rows[0].count, 0);
  assert.equal((await role(bootstrapAdminUrl, `SELECT pg_has_role('samosval_i2_external_c','samosval_i2_external_b','MEMBER') AS preserved`)).rows[0].preserved, true);
  assert.equal((await role(bootstrapAdminUrl, `SELECT to_regprocedure('samosval_isolated_admin.terminate_exact_target(text)') IS NULL AS removed`)).rows[0].removed, true);
  const restoredAcl = await role(bootstrapAdminUrl, `SELECT p.proowner::regrole::text AS owner, has_function_privilege('samosval_test_app',p.oid,'EXECUTE') AS app, has_table_privilege('samosval_test_orchestrator','samosval_isolated_admin.target_receipts','SELECT') AS registry, has_schema_privilege('public','samosval_isolated_admin','USAGE') AS public_schema FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='samosval_isolated_admin' AND p.proname='terminate_exact_target'`);
  assert.deepEqual(restoredAcl.rows, [{ owner:'samosval_test_bootstrap_admin', app:false, registry:false, public_schema:false }]);
  await role(bootstrapAdminUrl, 'DROP ROLE samosval_i2_external_a, samosval_i2_external_c; DROP OWNED BY samosval_i2_external_b; DROP ROLE samosval_i2_external_b');
});

test('per-run capability isolates two registered targets and direct identity mutation is denied', { skip: !realAdminUrl || !bootstrapAdminUrl }, async () => {
  const runA='111111111111', runB='222222222222';
  const targetA=`${GENERATED_DATABASE_PREFIX}${runA}_aaaaaaaaaaaa`, targetB=`${GENERATED_DATABASE_PREFIX}${runB}_bbbbbbbbbbbb`;
  const admin = new Client({ connectionString: realAdminUrl });
  const bootstrap = new Client({ connectionString: bootstrapAdminUrl });
  await admin.connect(); await bootstrap.connect();
  const broker = createProvisioningBroker({ adminClient: admin, bootstrapClient: bootstrap });
  try {
    await prepareTarget(broker,targetA,runA,capabilities.a); await prepareTarget(broker,targetB,runB,capabilities.b);
    const appA = new Client({ connectionString: targetUrl(targetA,'samosval_test_app',process.env.SAMOSVAL_TEST_APP_PASSWORD) });
    const appB = new Client({ connectionString: targetUrl(targetB,'samosval_test_app',process.env.SAMOSVAL_TEST_APP_PASSWORD) });
    const runtimeB = new Client({ connectionString: targetUrl(targetB,'samosval_test_runtime',process.env.SAMOSVAL_TEST_RUNTIME_PASSWORD) });
    appA.on('error', () => {});
    await appA.connect(); await appB.connect(); await runtimeB.connect();
    try {
      await assert.rejects(admin.query('SELECT samosval_isolated_admin.terminate_exact_target($1,$2)', [targetA,capabilities.b]), /authority rejected/i);
      await assert.rejects(admin.query('SELECT samosval_isolated_admin.terminate_exact_target($1,$2)', [targetA,'']), /authority rejected/i);
      assert.equal((await appA.query('SELECT 1 AS alive')).rows[0].alive,1);
      assert.equal((await appB.query('SELECT 1 AS alive')).rows[0].alive,1);
      for (const client of [appA,runtimeB]) {
        await assert.rejects(client.query('CREATE DATABASE forbidden_probe'), /permission denied to create database/i);
        await assert.rejects(client.query(`DROP DATABASE "${targetB}"`), /must be owner/i);
      }
      await assert.rejects(appA.query(`COMMENT ON DATABASE "${targetA}" IS 'tampered'`), /must be owner/i);
      await assert.rejects(appA.query(`ALTER DATABASE "${targetA}" OWNER TO samosval_test_app`), /must be owner/i);
      await admin.query('SELECT samosval_isolated_admin.terminate_exact_target($1,$2)', [targetA,capabilities.a]);
      await assert.rejects(appA.query('SELECT 1'), /terminated|connection|closed/i);
      assert.equal((await appB.query('SELECT 1 AS alive')).rows[0].alive,1);
      assert.equal((await runtimeB.query('SELECT 1 AS alive')).rows[0].alive,1);
    } finally { await appA.end().catch(() => {}); await appB.end(); await runtimeB.end(); }
  } finally {
    for (const [database, runid, capability] of [[targetA,runA,capabilities.a],[targetB,runB,capabilities.b]]) {
      await broker.run({ operation:'dropReservedTarget', database, runid, capability }).catch(() => {});
    }
    await admin.end(); await bootstrap.end();
  }
});

test('owner mismatch and reserved/template cleanup negatives preserve sessions', { skip: !realAdminUrl || !bootstrapAdminUrl }, async () => {
  const run='333333333333', name=`${GENERATED_DATABASE_PREFIX}${run}_cccccccccccc`;
  const admin = new Client({ connectionString: realAdminUrl }); await admin.connect();
  try {
    await admin.query('SELECT samosval_isolated_admin.reserve_target($1,$2,$3)',[name,run,capabilities.c]);
    await admin.query(`CREATE DATABASE "${name}"`); await role(bootstrapAdminUrl,`ALTER DATABASE "${name}" OWNER TO samosval_test_prepared_owner`);
    await role(bootstrapAdminUrl,`GRANT CONNECT ON DATABASE "${name}" TO samosval_test_app`);
    const session = new Client({ connectionString:targetUrl(name,'samosval_test_app',process.env.SAMOSVAL_TEST_APP_PASSWORD) }); await session.connect();
    try {
      await assert.rejects(admin.query('SELECT samosval_isolated_admin.terminate_exact_target($1,$2)',[name,capabilities.c]), /state mismatch|authority rejected/i);
      for (const forbidden of ['postgres','template0','template1','samosval_test']) await assert.rejects(admin.query('SELECT samosval_isolated_admin.terminate_exact_target($1,$2)',[forbidden,capabilities.c]), /no rows|strict|query returned no rows/i);
      await role(bootstrapAdminUrl,`ALTER DATABASE "${name}" OWNER TO samosval_test_orchestrator`);
      await assert.rejects(admin.query('SELECT samosval_isolated_admin.mark_reserved_target($1,$2)',[name,capabilities.c]), /identity mismatch/i);
      assert.equal((await session.query('SELECT 1 AS alive')).rows[0].alive,1);
    } finally { await session.end(); }
  } finally { await role(bootstrapAdminUrl,`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end(); }
});
