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
import { adminPreflight, runAdminStatement } from '../scripts/isolated-db/admin.mjs';

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
});

test('identifier quoting is explicit and never accepts arbitrary SQL identifiers', () => {
  assert.equal(quoteIdentifier(target), `"${target}"`);
  assert.throws(() => quoteIdentifier('target"; DROP DATABASE postgres; --'), /identifier is not approved/i);
});

test('admin statements build exact marker internally and reject caller-authored identity', async () => {
  const calls = [];
  const client = { query: async (text, values) => { calls.push([text, values]); return { rows: [{ comment: 'samosval-isolated-db:v1;kind=target;runid=0123456789ab;hash=0123456789ab;owner=samosval_test_app' }] }; } };
  await runAdminStatement(client, { operation: 'commentDatabase', database: target, runid, owner: 'samosval_test_app', kind: 'target' });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][0], /BEGIN|COMMIT/i);
  assert.deepEqual(calls[0][1], [target]);
  await assert.rejects(runAdminStatement(client, { operation: 'commentDatabase', database: target, runid, owner: 'samosval_test_app', kind: 'target', comment: 'caller supplied' }), /admin operation is not approved/i);
  await assert.rejects(runAdminStatement(client, { operation: 'sql', sql: 'DROP DATABASE postgres' }), /admin operation is not approved/i);
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

test('compose bootstrap marker and fixed roles enforce least privilege', { skip: !realAdminUrl || !bootstrapAdminUrl }, async () => {
  const preflightClient = new Client({ connectionString: realAdminUrl });
  await preflightClient.connect();
  try {
    const endpoint = await preflightClient.query(`SELECT inet_server_addr()::text AS address`);
    const result = await adminPreflight(preflightClient, realAdminUrl, { expectedRole: 'samosval_test_orchestrator', expectedServerAddress: endpoint.rows[0].address });
    assert.equal(result.serverMajor, 16);
    assert.equal(result.marker, 'samosval-isolated-db-bootstrap:v1');
  } finally { await preflightClient.end(); }

  const attributes = await role(realAdminUrl, `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`, [[
    'samosval_test_app', 'samosval_test_orchestrator', 'samosval_test_runtime'
  ]]);
  assert.deepEqual(attributes.rows, [
    { rolname: 'samosval_test_app', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
    { rolname: 'samosval_test_orchestrator', rolsuper: false, rolcreatedb: true, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
    { rolname: 'samosval_test_runtime', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
  ]);

  const bootstrap = new URL(bootstrapAdminUrl);
  for (const [name, password] of [['samosval_test_app', process.env.SAMOSVAL_TEST_APP_PASSWORD], ['samosval_test_runtime', process.env.SAMOSVAL_TEST_RUNTIME_PASSWORD]]) {
    const url = new URL(bootstrapAdminUrl); url.username = name; url.password = password;
    connectionDenied(url.href);
    const memberships = await role(realAdminUrl, `SELECT count(*)::int AS count FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)`, [name]);
    assert.equal(memberships.rows[0].count, 0);
  }
  assert.equal(bootstrap.pathname, '/postgres');
});

test('bootstrap is idempotent and restores role and function authority', { skip: !bootstrapAdminUrl }, async () => {
  const result = spawnSync('docker-compose', ['-f', 'compose.test.yaml', 'exec', '-T', 'postgres', '/docker-entrypoint-initdb.d/10-isolated-db-bootstrap.sh'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = await role(bootstrapAdminUrl, `SELECT r.rolname, r.rolinherit, r.rolcreatedb, r.rolsuper FROM pg_roles r WHERE r.rolname LIKE 'samosval_test_%' ORDER BY r.rolname`);
  assert.deepEqual(rows.rows, [
    { rolname: 'samosval_test_app', rolinherit: false, rolcreatedb: false, rolsuper: false },
    { rolname: 'samosval_test_bootstrap_admin', rolinherit: true, rolcreatedb: true, rolsuper: true },
    { rolname: 'samosval_test_orchestrator', rolinherit: false, rolcreatedb: true, rolsuper: false },
    { rolname: 'samosval_test_runtime', rolinherit: false, rolcreatedb: false, rolsuper: false },
  ]);
  const acl = await role(bootstrapAdminUrl, `SELECT n.nspowner::regrole::text AS schema_owner, p.proowner::regrole::text AS function_owner, has_function_privilege('samosval_test_orchestrator', p.oid, 'EXECUTE') AS orchestrator_execute, has_function_privilege('samosval_test_app', p.oid, 'EXECUTE') AS app_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='samosval_isolated_admin' AND p.proname='terminate_exact_target'`);
  assert.deepEqual(acl.rows, [{ schema_owner: 'samosval_test_bootstrap_admin', function_owner: 'samosval_test_bootstrap_admin', orchestrator_execute: true, app_execute: false }]);
});

test('cleanup waits for identity lock and aborts after a concurrent marker mutation', { skip: !realAdminUrl || !bootstrapAdminUrl }, async () => {
  const lockRun = '333333333333';
  const locked = `${GENERATED_DATABASE_PREFIX}${lockRun}_cccccccccccc`;
  const admin = new Client({ connectionString: realAdminUrl });
  const mutator = new Client({ connectionString: bootstrapAdminUrl });
  await admin.connect(); await mutator.connect();
  try {
    await admin.query('SELECT samosval_isolated_admin.reserve_target($1,$2,$3)', [locked, lockRun, 'samosval_test_app']);
    await admin.query(`CREATE DATABASE "${locked}" OWNER samosval_test_orchestrator`);
    await mutator.query(`ALTER DATABASE "${locked}" OWNER TO samosval_test_app`);
    await admin.query('SELECT samosval_isolated_admin.mark_reserved_target($1)', [locked]);
    await mutator.query('BEGIN');
    await mutator.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [locked]);
    const cleanup = admin.query('SELECT samosval_isolated_admin.terminate_exact_target($1)', [locked]);
    await mutator.query(`COMMENT ON DATABASE "${locked}" IS 'tampered-under-identity-lock'`);
    await mutator.query('COMMIT');
    await assert.rejects(cleanup, /identity mismatch/i);
  } finally {
    await mutator.query('ROLLBACK').catch(() => {});
    await role(bootstrapAdminUrl, `DROP DATABASE IF EXISTS "${locked}" WITH (FORCE)`);
    await admin.end(); await mutator.end();
  }
});

test('trusted receipts reject foreign adoption and preserve foreign active sessions', { skip: !realAdminUrl || !bootstrapAdminUrl }, async () => {
  const ownRun = '111111111111';
  const foreignRun = '222222222222';
  const own = `${GENERATED_DATABASE_PREFIX}${ownRun}_aaaaaaaaaaaa`;
  const foreign = `${GENERATED_DATABASE_PREFIX}${foreignRun}_bbbbbbbbbbbb`;
  const admin = new Client({ connectionString: realAdminUrl });
  await admin.connect();
  try {
    await admin.query('SELECT samosval_isolated_admin.reserve_target($1,$2,$3)', [own, ownRun, 'samosval_test_app']);
    await admin.query(`CREATE DATABASE "${own}" OWNER samosval_test_orchestrator`);
    await role(bootstrapAdminUrl, `ALTER DATABASE "${own}" OWNER TO samosval_test_app`);
    await admin.query('SELECT samosval_isolated_admin.mark_reserved_target($1)', [own]);
    await admin.query(`CREATE DATABASE "${foreign}" OWNER samosval_test_orchestrator`);
    await role(bootstrapAdminUrl, `ALTER DATABASE "${foreign}" OWNER TO samosval_test_app`);
    await role(bootstrapAdminUrl, `COMMENT ON DATABASE "${foreign}" IS 'samosval-isolated-db:v1;kind=target;runid=${foreignRun};hash=bbbbbbbbbbbb;owner=samosval_test_app'`);
    const foreignUrl = new URL(bootstrapAdminUrl); foreignUrl.pathname = `/${foreign}`; foreignUrl.username = 'samosval_test_app'; foreignUrl.password = process.env.SAMOSVAL_TEST_APP_PASSWORD;
    const foreignSession = new Client({ connectionString: foreignUrl.href });
    await foreignSession.connect();
    try {
      await assert.rejects(admin.query('SELECT samosval_isolated_admin.reserve_target($1,$2,$3)', [foreign, foreignRun, 'samosval_test_app']), /reservation rejected/i);
      await assert.rejects(admin.query('SELECT samosval_isolated_admin.terminate_exact_target($1)', [foreign]), /no rows|strict|query returned no rows/i);
      assert.equal((await foreignSession.query('SELECT 1 AS alive')).rows[0].alive, 1);
    } finally { await foreignSession.end(); }
  } finally {
    await role(bootstrapAdminUrl, `DROP DATABASE IF EXISTS "${own}" WITH (FORCE)`);
    await role(bootstrapAdminUrl, `DROP DATABASE IF EXISTS "${foreign}" WITH (FORCE)`);
    await admin.end();
  }
});
