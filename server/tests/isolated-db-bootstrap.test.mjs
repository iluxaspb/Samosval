import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

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

test('admin URL accepts only PostgreSQL loopback maintenance database without overrides', () => {
  assert.equal(validateAdminUrl(adminUrl()).pathname, '/postgres');
  assert.equal(validateAdminUrl('postgres://orchestrator:secret@[::1]:55432/postgres').hostname, '[::1]');
  for (const value of [
    'https://orchestrator:secret@127.0.0.1:55432/postgres',
    adminUrl('template1'),
    'postgresql://orchestrator:secret@db.example:55432/postgres',
    `${adminUrl()}?sslmode=require`,
    `${adminUrl()}#fragment`,
    'postgresql://orchestrator:secret@127.0.0.1/postgres/extra',
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

test('admin statements use a closed autocommit operation set', async () => {
  const calls = [];
  const client = { query: async (text, values) => { calls.push([text, values]); return { rows: [] }; } };
  await runAdminStatement(client, { operation: 'commentDatabase', database: target, runid, comment: 'samosval-isolated-db:v1;kind=target;runid=0123456789ab;hash=0123456789ab;owner=samosval_test_app' });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][0], /BEGIN|COMMIT/i);
  assert.deepEqual(calls[0][1], ['samosval-isolated-db:v1;kind=target;runid=0123456789ab;hash=0123456789ab;owner=samosval_test_app']);
  await assert.rejects(runAdminStatement(client, { operation: 'sql', sql: 'DROP DATABASE postgres' }), /admin operation is not approved/i);
});

const realAdminUrl = process.env.SAMOSVAL_TEST_ADMIN_URL;
const bootstrapAdminUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;

async function role(url, sql, values = []) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await client.query(sql, values); } finally { await client.end(); }
}

test('compose bootstrap marker and fixed roles enforce least privilege', { skip: !realAdminUrl || !bootstrapAdminUrl }, async () => {
  const preflightClient = new Client({ connectionString: realAdminUrl });
  await preflightClient.connect();
  try {
    const result = await adminPreflight(preflightClient, realAdminUrl, { expectedRole: 'samosval_test_orchestrator' });
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
  for (const name of ['samosval_test_app', 'samosval_test_runtime']) {
    const probe = new Client({ connectionString: bootstrapAdminUrl });
    await probe.connect();
    try {
      await probe.query(`SET ROLE ${name}`);
      await assert.rejects(probe.query('CREATE DATABASE forbidden_probe'), /permission denied to create database/i);
      await assert.rejects(probe.query(`SELECT current_setting('samosval.test_admin_url')`), /unrecognized configuration parameter/i);
    } finally { await probe.end(); }
    const memberships = await role(realAdminUrl, `SELECT count(*)::int AS count FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)`, [name]);
    assert.equal(memberships.rows[0].count, 0);
  }
  assert.equal(bootstrap.pathname, '/postgres');
});
